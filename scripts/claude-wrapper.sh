#!/bin/bash
# Claude CLI wrapper that extracts OAuth token from keychain
# This enables daemon access to Max subscription without hardcoded tokens

# Extract the full OAuth JSON from keychain
OAUTH_JSON=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null)

if [ -z "$OAUTH_JSON" ]; then
    echo "ERROR: Could not read Claude credentials from keychain" >&2
    exit 1
fi

# Extract just the access token from the JSON
ACCESS_TOKEN=$(echo "$OAUTH_JSON" | /opt/homebrew/bin/jq -r '.claudeAiOauth.accessToken' 2>/dev/null)

if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" = "null" ]; then
    echo "ERROR: Could not parse access token from keychain credentials" >&2
    exit 1
fi

# Export the token and run Claude
export CLAUDE_CODE_OAUTH_TOKEN="$ACCESS_TOKEN"
exec /Users/yj/.local/bin/claude "$@"
