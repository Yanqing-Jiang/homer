# Homer Daemon Auth

This document describes authentication for HOMER's daemon, including Claude Code auth and the Web UI.

## Table of Contents

1. [Claude Code Auth](#claude-code-auth) - OAuth for scheduled jobs/queries
2. [Web UI Auth](#web-ui-auth) - Supabase JWT for web dashboard

---

## Claude Code Auth

### Overview

HOMER spawns Claude CLI processes for scheduled jobs and Telegram queries. These processes need valid OAuth tokens to authenticate with Claude's API.

## Authentication Methods

### 1. Token File (Recommended)

Store your OAuth token in `~/.homer-claude-token`:

```bash
# Get your token from Claude Code (run interactively and check settings)
echo 'sk-ant-oat01-YOUR-TOKEN-HERE' > ~/.homer-claude-token
chmod 600 ~/.homer-claude-token
```

The executors automatically load this token and pass it as `CLAUDE_CODE_OAUTH_TOKEN` to spawned Claude CLI processes.

**Files:**
- `src/executors/claude.ts`
- `src/scheduler/executor.ts`

### 2. Keychain (Fallback)

Claude CLI can also read credentials from macOS Keychain (`Claude Code-credentials`). However, daemon processes often lack Keychain access due to security restrictions, even when running as a LaunchAgent in the Aqua session.

The `/health/auth` endpoint checks Keychain status but the token file method is more reliable.

## Setup

1. **Store your OAuth token:**
   ```bash
   echo 'sk-ant-oat01-YOUR-TOKEN' > ~/.homer-claude-token
   chmod 600 ~/.homer-claude-token
   ```

2. **Install LaunchAgent:**
   ```bash
   mkdir -p ~/Library/LaunchAgents
   cp /Users/yj/homer/com.homer.daemon.plist ~/Library/LaunchAgents/
   launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.homer.daemon.plist
   launchctl kickstart -k gui/$UID/com.homer.daemon
   ```

3. **Verify:**
   ```bash
   curl http://127.0.0.1:3000/health
   curl -X POST http://127.0.0.1:3000/api/scheduled-jobs/ideas-explore/trigger
   ```

## Token Refresh

OAuth tokens expire periodically. When jobs start failing with "Invalid API key", refresh your token:

1. Run `claude` interactively
2. Complete the OAuth flow
3. Copy the new token to `~/.homer-claude-token`
4. Restart the daemon: `pkill -f "homer/dist/index.js"`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PATH` | `~/.local/bin/claude` | Path to Claude CLI binary |
| Token file | `~/.homer-claude-token` | OAuth token storage |

## Health Check

```
GET http://127.0.0.1:3000/health/auth
```

Response:
- `claudeBinaryExists`: Claude CLI found at configured path
- `keychainItemFound`: Keychain credential present (informational only)

## Troubleshooting

**Jobs fail with "Invalid API key":**
1. Check token file exists: `cat ~/.homer-claude-token`
2. Verify token is valid: `CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.homer-claude-token) claude -p "hello"`
3. If expired, refresh the token (see above)

**Daemon won't start:**
1. Check port 3000: `lsof -i :3000`
2. Check logs: `tail -f ~/homer/logs/stdout.log`

**Keychain access issues:**
- The token file method bypasses Keychain entirely
- Keychain checks are informational only

---

## Web UI Auth

### Overview

The Homer Web UI (SvelteKit app) uses Supabase for authentication. When accessing the daemon's API from the web UI:

1. User authenticates via Supabase OAuth (Google)
2. Supabase issues a JWT token
3. Web UI sends JWT in `Authorization: Bearer <token>` header
4. Daemon validates JWT using Supabase JWT secret
5. Daemon checks email against allowlist

### Configuration

Add these to your `.env`:

```bash
# Supabase auth for Web UI
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_JWT_SECRET=your-jwt-secret

# Web server exposure
WEB_EXPOSE_EXTERNALLY=true        # Set to true to enable auth
WEB_ALLOWED_EMAIL=your@email.com  # Only this email can access
```

### Security Modes

| Mode | `WEB_EXPOSE_EXTERNALLY` | Binding | Auth |
|------|------------------------|---------|------|
| Local | `false` (default) | `127.0.0.1:3000` | None (localhost only) |
| External | `true` | `0.0.0.0:3000` | Supabase JWT + email allowlist |

### Cloudflare Access (Recommended)

For production, use Cloudflare Access as an additional security layer:

1. **Create Access Application**
   - Go to Cloudflare Zero Trust > Access > Applications
   - Create application for `homer.yourdomain.com`
   - Set session duration: 24 hours

2. **Configure Policy**
   ```
   Rule: Allow
   Include: Email is your@email.com
   ```

3. **Identity Provider**
   - Add Google as identity provider
   - Configure OAuth credentials

4. **Tunnel Setup**
   ```bash
   # Install cloudflared
   brew install cloudflare/cloudflare/cloudflared

   # Login and create tunnel
   cloudflared tunnel login
   cloudflared tunnel create homer

   # Configure tunnel (config.yml)
   tunnel: <tunnel-id>
   credentials-file: ~/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: homer.yourdomain.com
       service: http://localhost:3000
     - service: http_status:404

   # Run tunnel
   cloudflared tunnel run homer
   ```

### Flow Diagram

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Web Browser   │────▶│ Cloudflare Access│────▶│  Homer Daemon   │
│  (SvelteKit UI) │     │  (Email check)  │     │   (JWT verify)  │
└─────────────────┘     └─────────────────┘     └─────────────────┘
        │                                                │
        │  1. Google OAuth                               │
        ▼                                                ▼
┌─────────────────┐                              ┌─────────────────┐
│    Supabase     │                              │ Email Allowlist │
│   (JWT issue)   │                              │  (final check)  │
└─────────────────┘                              └─────────────────┘
```

### Troubleshooting

**401 Unauthorized:**
- Check `Authorization` header is present with `Bearer ` prefix
- Verify JWT hasn't expired
- Confirm `SUPABASE_JWT_SECRET` is set correctly

**403 Forbidden:**
- User authenticated but email not in allowlist
- Check `WEB_ALLOWED_EMAIL` matches user's email

**CORS errors:**
- Ensure `WEB_EXPOSE_EXTERNALLY=true` (enables CORS)
- Check browser console for specific origin issues
