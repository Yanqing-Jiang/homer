# Antigravity Provider — Preserved Code

Patched OAuth helpers and a plugin manifest preserved from a third-party
package the author previously vendored. Kept here as a reference snapshot.

## Files

### `pi-ai-dist/`
Compiled OAuth helpers (PKCE flow, token refresh, project discovery) and
their TypeScript declarations.

### `openclaw-extension/`
A small extension that registered the OAuth provider with the host runtime.

## OAuth configuration

OAuth client identifiers and endpoints originate in the upstream package's
source. **Do not reuse any identifiers in this snapshot for production —
provision your own OAuth client and point the helpers at that.**

## Note

This directory exists as historical reference only and is not imported by the
main Homer daemon. Anyone redistributing this code should consult the upstream
package's license before doing so.
