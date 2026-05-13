#!/bin/bash
# Deploy Homer Web UI to Azure Blob Storage.
#
# Steps:
#   1. Build the web bundle.
#   2. Upload web/build → $web container (overwrite).
#   3. Set Cache-Control: no-cache, must-revalidate on every *.html so the
#      browser always revalidates the entry point — content-hashed assets
#      under _app/immutable/ are safe to cache forever.
#   4. Prune any blob in $web that is no longer present in web/build
#      (preserves staticwebapp.config.json in case of a future SWA migration).
#
# Without (3) and (4), browsers cache stale index.html that references
# stale content-hashed chunks which still resolve 200 — surfacing old UI
# even after a clean deploy. We learned this on 2026-05-12.

set -euo pipefail

STORAGE_ACCOUNT="amazonowendevstorage2"
CONTAINER='$web'
BUILD_DIR="web/build"

cd "$(dirname "$0")/.."

echo "▶ Building web UI..."
( cd web && npm run build )

echo "▶ Resolving storage key..."
ACCOUNT_KEY=$(az storage account keys list --account-name "$STORAGE_ACCOUNT" --query '[0].value' -o tsv)

echo "▶ Uploading $BUILD_DIR → $CONTAINER..."
az storage blob upload-batch \
  --account-name "$STORAGE_ACCOUNT" \
  --account-key  "$ACCOUNT_KEY" \
  --destination  "$CONTAINER" \
  --source       "$BUILD_DIR" \
  --overwrite \
  --output none

echo "▶ Setting Cache-Control: no-cache, must-revalidate on *.html..."
while IFS= read -r html; do
  az storage blob update \
    --account-name "$STORAGE_ACCOUNT" \
    --account-key  "$ACCOUNT_KEY" \
    --container-name "$CONTAINER" \
    --name "$html" \
    --content-cache "no-cache, must-revalidate" \
    --output none
  echo "    · $html"
done < <( cd "$BUILD_DIR" && find . -maxdepth 1 -type f -name '*.html' | sed 's|^\./||' )

echo "▶ Pruning stale blobs (build set: $(find "$BUILD_DIR" -type f | wc -l | tr -d ' ') files)..."
KEEP_LIST=$(mktemp); LIVE_LIST=$(mktemp); STALE_LIST=$(mktemp)
trap 'rm -f "$KEEP_LIST" "$LIVE_LIST" "$STALE_LIST"' EXIT
( cd "$BUILD_DIR" && find . -type f | sed 's|^\./||' ) | sort > "$KEEP_LIST"
az storage blob list --account-name "$STORAGE_ACCOUNT" --container-name "$CONTAINER" \
  --account-key "$ACCOUNT_KEY" -o tsv --query '[].name' | sort > "$LIVE_LIST"
# stale = live − keep, minus staticwebapp.config.json (preserved for possible future SWA)
comm -23 "$LIVE_LIST" "$KEEP_LIST" | grep -v '^staticwebapp.config.json$' > "$STALE_LIST" || true

STALE_COUNT=$(wc -l < "$STALE_LIST" | tr -d ' ')
if [ "$STALE_COUNT" -eq 0 ]; then
  echo "    · nothing to prune"
else
  echo "    · deleting $STALE_COUNT stale blob(s) (parallel x16)..."
  xargs -I {} -P 16 az storage blob delete \
    --account-name "$STORAGE_ACCOUNT" \
    --account-key  "$ACCOUNT_KEY" \
    --container-name "$CONTAINER" \
    --name "{}" --output none < "$STALE_LIST"
fi

echo "✅ Deployment complete: https://${STORAGE_ACCOUNT}.z5.web.core.windows.net"
