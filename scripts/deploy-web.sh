#!/bin/bash
# Deploy Homer Web UI to Azure Blob Storage
# Usage: ./scripts/deploy-web.sh

set -e

STORAGE_ACCOUNT="amazonowendevstorage2"
CONTAINER="\$web"
BUILD_DIR="web/build"

cd "$(dirname "$0")/.."

echo "Building web UI..."
cd web
npm run build
cd ..

echo "Deploying to Azure blob storage..."
az storage blob upload-batch \
  --account-name "$STORAGE_ACCOUNT" \
  --destination "$CONTAINER" \
  --source "$BUILD_DIR" \
  --overwrite \
  --auth-mode key

echo "Deployment complete!"
echo "URL: https://${STORAGE_ACCOUNT}.z5.web.core.windows.net"
