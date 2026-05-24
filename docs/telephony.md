# Homer Telephony

Homer's telephony subsystem handles:
- Outbound calls (Homer → human) via ElevenLabs Conversational AI agents over Twilio
- Inbound SMS (human → Homer) via Twilio webhooks
- Post-call summaries forwarded to Telegram

After the web UI was split into a separate private repo, telephony is the only
HTTP surface exposed by the public daemon. `src/telephony/server.ts` runs a
minimal Fastify server with three routes (`/health`, two webhooks). Everything
else (Telegram bot, scheduler, MCP server, memory, ideas) stays event-driven
or stdio-driven.

## Architecture

```text
                         public internet
                              |
                              v
                    +--------------------+
                    | Cloudflare Tunnel  |
                    |  public hostname   |
                    +---------+----------+
                              |
                              v
                     http://127.0.0.1:3000
                              |
+----------+     +----------------------------+     +------------------+
| Caller   | --> | Twilio phone number        | --> | ElevenLabs       |
| / Texter |     | SMS + telephony provider   |     | ConvAI agent     |
+----------+     +-------------+--------------+     +---------+--------+
                              |                          |
                              | POST /webhooks/twilio/sms|
                              |                          | POST /webhooks/elevenlabs/call-complete
                              v                          v
                    +------------------------------------------+
                    | Homer telephony Fastify server           |
                    | src/telephony/server.ts                  |
                    | - validates Twilio HMAC-SHA1 signature   |
                    | - validates ElevenLabs HMAC-SHA256       |
                    | - persists call event to disk before 200 |
                    +-------------------+----------------------+
                                        |
                                        v
                    +------------------------------------------+
                    | Homer daemon                             |
                    | SQLite state, scheduler, memory, MCP     |
                    +-----------+------------------------------+
                                |
                 +--------------+--------------+
                 v                             v
        +------------------+          +------------------+
        | Telegram bot     |          | MCP tools / jobs |
        | summaries + SMS  |          | outbound calls   |
        +------------------+          +------------------+
```

**Why a tunnel + loopback bind?** The telephony server binds to `127.0.0.1:3000`
by default. Cloudflare Tunnel (`cloudflared`) creates an outbound-only TLS
connection from your machine to Cloudflare's edge; Cloudflare then routes
inbound requests to your tunnel. You never open a port on your router or
expose your IP. If you don't use Cloudflare, swap in ngrok, Tailscale Funnel,
or any other tunnel that accepts inbound HTTP and forwards to a local port.

## Routes

| Method | Path | Purpose | Auth |
|---|---|---|---|
| GET  | `/health` | launchd / heartbeat liveness | none (loopback only) |
| POST | `/webhooks/elevenlabs/call-complete` | post-call transcript + analysis | HMAC-SHA256 in `elevenlabs-signature` |
| POST | `/webhooks/twilio/sms` | inbound SMS | HMAC-SHA1 in `x-twilio-signature` |

The Twilio signature is computed over `${TELEPHONY_PUBLIC_URL}/webhooks/twilio/sms`
plus the sorted form-body keys/values. This URL must match the URL configured
in the Twilio console exactly — scheme, host, path, and (importantly) **no
trailing slash**. The server strips a trailing slash from `WEBHOOK_BASE` to
defend against the common config drift.

## Required environment variables

Set in `.env` at the repo root (loaded by dotenv at daemon startup):

| Variable | Required | Purpose |
|---|---|---|
| `TELEPHONY_ENABLED` | no (default `true`) | Set `false` to disable the HTTP webhook server entirely. |
| `TELEPHONY_HOST` | no (default `127.0.0.1`) | Bind address. Use `0.0.0.0` only for direct LAN ingress without a tunnel. |
| `TELEPHONY_PORT` | no (default `3000`) | Port. Must match the tunnel target and the launchd `/health` check. |
| `TELEPHONY_PUBLIC_URL` | yes (for Twilio) | Public origin Twilio uses for signature validation. No trailing slash. |
| `HOMER_API_URL` | no (legacy alias) | Backward-compat alias for `TELEPHONY_PUBLIC_URL`. Set either one, not both. |
| `ELEVEN_LABS_API_KEY` | yes | Used for outbound calls and fetching transcripts in the call-summary path. |
| `ELEVENLABS_AGENT_ID` | yes | Identifies Homer's agent; webhook handler ignores calls from other agents. |
| `ELEVENLABS_PHONE_NUMBER_ID` | yes (for outbound) | ElevenLabs phone-number ID used when placing outbound calls. |
| `ELEVENLABS_WEBHOOK_SECRET` | yes (in production) | HMAC secret for `elevenlabs-signature`. Without it, the route accepts unsigned payloads — local dev only. |
| `TWILIO_ACCOUNT_SID` | yes | Twilio account identifier. |
| `TWILIO_AUTH_TOKEN` | yes (in production) | Twilio signature validation. Without it, signature check is skipped — local dev only. |
| `TWILIO_PHONE_NUMBER` / `HOMER_PHONE` | yes (as applicable) | The Twilio number assigned to Homer (in E.164 format, e.g. `+15555550101`). |
| `OWNER_PHONE` | recommended | Your phone, in E.164. Used to route SMS from the owner specifically and for crash alerts. |
| `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_ID` | yes | Where call summaries and SMS notifications get forwarded. |

## Setup

### 1. Twilio

1. Buy a phone number (E.164 format).
2. Configure the SMS webhook:
   - URL: `${TELEPHONY_PUBLIC_URL}/webhooks/twilio/sms`
   - Method: `HTTP POST`
   - Primary handler: leave blank (Homer responds with empty TwiML)
3. Note the `Account SID` and `Auth Token` from the console root.
4. (Optional, for outbound) Create a TwiML App or API key SID if Homer's
   outbound flow uses one — see `src/telephony/outbound-call.ts`.

### 2. ElevenLabs

1. Create a Conversational AI agent. Note the **Agent ID**.
2. Buy or import a phone number; bind it to the agent. Note the
   **Phone Number ID**.
3. In Agent → Webhooks → Post-call:
   - URL: `${TELEPHONY_PUBLIC_URL}/webhooks/elevenlabs/call-complete`
   - Generate a signing secret. Copy it into `.env` as
     `ELEVENLABS_WEBHOOK_SECRET`.
4. The agent's `agent_id` MUST match `ELEVENLABS_AGENT_ID` in your env —
   the webhook handler filters by agent so other ElevenLabs traffic on the
   same account doesn't trigger Homer's call-summary path.

### 3. Cloudflare Tunnel

The tunnel just has to forward `https://<your-hostname>/*` to
`http://127.0.0.1:3000` on your laptop.

```bash
# One-time
brew install cloudflared
cloudflared login                                 # opens browser to authorize
cloudflared tunnel create homer-telephony
cloudflared tunnel route dns homer-telephony telephony.your-domain.com

# Config (substitute <tunnel-id> from the create command output)
cat > ~/.cloudflared/homer-telephony.yml <<YAML
tunnel: <tunnel-id>
credentials-file: $HOME/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: telephony.your-domain.com
    service: http://127.0.0.1:3000
  - service: http_status:404
YAML

# Run (foreground for testing)
cloudflared tunnel run --config ~/.cloudflared/homer-telephony.yml homer-telephony

# Or install as a system service so it auto-starts:
sudo cloudflared service install
```

Then set `TELEPHONY_PUBLIC_URL=https://telephony.your-domain.com` in `.env`
and make sure that EXACT URL is what Twilio's SMS webhook points at.

### 4. Homer daemon

```bash
cd ~/homer
cp .env.example .env       # then fill in the values
npm install
npm run build
bash scripts/install-daemon.sh    # installs as user LaunchAgent at gui/$(id -u)/com.homer.daemon
```

The installer generates `~/Library/LaunchAgents/com.homer.daemon.plist` from
`config/com.homer.daemon.plist.template`, substituting `$HOME`, `$(id -un)`,
and `$(command -v node)` — so it works on any user account.

## Verification

### Local health

```bash
curl -fsS http://127.0.0.1:3000/health
# {"status":"healthy","service":"homer-telephony","time":"..."}
```

### Synthetic signed Twilio SMS

This sends a webhook locally without going through Twilio — verifies the
signature implementation and parser match Twilio's spec:

```bash
node --input-type=module <<'NODE'
import { createHmac } from 'crypto';
const authToken = process.env.TWILIO_AUTH_TOKEN || 'test_token';
const url = process.env.TELEPHONY_PUBLIC_URL || 'http://127.0.0.1:3000';
const target = `${url}/webhooks/twilio/sms`;
const params = { Body: 'hello', From: '+15555550123', MessageSid: 'SMtest', NumMedia: '0' };
let data = target;
for (const k of Object.keys(params).sort()) data += k + params[k];
const sig = createHmac('sha1', authToken).update(data).digest('base64');
const body = new URLSearchParams(params).toString();
console.log(`curl -i -X POST '${target}' -H 'Content-Type: application/x-www-form-urlencoded' -H 'x-twilio-signature: ${sig}' --data '${body}'`);
NODE
```

Run the printed curl. Expect:
```xml
<?xml version="1.0" encoding="UTF-8"?><Response></Response>
```
…and a `Inbound SMS received` line in `~/homer/logs/stdout.log`.

If you see `Twilio SMS webhook: invalid signature (check TELEPHONY_PUBLIC_URL
matches Twilio console exactly)`, `TELEPHONY_PUBLIC_URL` and the Twilio
console URL don't agree on scheme/host/path/trailing-slash.

### Synthetic signed ElevenLabs call-complete

```bash
node --input-type=module <<'NODE'
import { createHmac } from 'crypto';
const secret = process.env.ELEVENLABS_WEBHOOK_SECRET || 'test_secret';
const body = JSON.stringify({
  type: 'post_call_transcription',
  data: {
    conversation_id: 'conv_synthetic',
    agent_id: process.env.ELEVENLABS_AGENT_ID || 'agent_test',
    transcript: [],
    metadata: { call_duration_secs: 0, termination_reason: 'synthetic_test' }
  }
});
const t = Math.floor(Date.now() / 1000);
const v0 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
console.log(`curl -i -X POST 'http://127.0.0.1:3000/webhooks/elevenlabs/call-complete' -H 'Content-Type: application/json' -H 'elevenlabs-signature: t=${t},v0=${v0}' --data '${body.replaceAll("'", "'\\''")}'`);
NODE
```

Expect: `200 {"ok":true}` + a persisted file at `data/call-events/conv_synthetic.json`
(deleted once the background processing finishes; left on disk if it fails so
you can retry).

### End-to-end (real provider traffic)

1. `curl -fsS $TELEPHONY_PUBLIC_URL/health` — confirm the tunnel forwards.
2. Send a real SMS to your Twilio number from a phone you own. Confirm the
   Telegram bot forwards it within a few seconds; check `tail -f
   ~/homer/logs/stdout.log` for `Inbound SMS received`.
3. Have Homer place a test outbound call via your normal trigger (Telegram
   command, MCP tool, or scheduled job). Once the call ends, ElevenLabs
   POSTs the transcript; check the logs for `ElevenLabs call-complete
   webhook received and persisted` and confirm Telegram receives the summary.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Twilio shows `403 Forbidden` on its webhook delivery report | Signature URL mismatch | Confirm `TELEPHONY_PUBLIC_URL` in `.env` equals the URL in Twilio console, character-for-character (no trailing slash, correct scheme, correct path). |
| ElevenLabs delivers, log shows `invalid signature` | Wrong `ELEVENLABS_WEBHOOK_SECRET` | Copy the secret from ElevenLabs Agent → Webhooks → Post-call → "Reveal" exactly, no leading/trailing spaces. |
| Webhook reaches Homer but `processCallComplete` errors | Background processing failure (Telegram down, ElevenLabs transcript fetch timed out) | The raw payload is preserved at `data/call-events/<conversation_id>.json`. Re-process by sending the same JSON back through curl, or wait for the daemon's next retry job. |
| Daemon up, `/health` works locally, tunnel returns 502 | `cloudflared` not running or pointing at wrong port | `pgrep cloudflared` to confirm; `cloudflared tunnel info homer-telephony` to verify routing; restart with `cloudflared tunnel run ...`. |
| Daemon logs `Another Homer instance is already running on port 3000` | Stale process owns the port | `lsof -nP -iTCP:3000 -sTCP:LISTEN` to find it; `kill <pid>`; then `launchctl kickstart -k gui/$(id -u)/com.homer.daemon`. |
| Empty SMS body when message contains spaces | Old custom parser bug (fixed) | Rebuild from current `main` — the new server uses `URLSearchParams` which decodes `+` to space correctly. |

## Operational notes

- **One-process invariant.** Homer is a single-instance daemon. The telephony
  server exits cleanly on `EADDRINUSE` so launchd doesn't restart-loop when
  another Homer is already on port 3000.
- **Webhook outage window during restart.** The `launchctl bootout → bootstrap`
  pair takes ~5–15 seconds. Twilio retries SMS deliveries up to 5 times;
  ElevenLabs retries post-call webhooks up to 3 times. So a short maintenance
  window typically doesn't lose any callbacks. Run
  `bash scripts/pre-restart-check.sh` first to confirm no in-flight CLI runs.
- **Recovery from a dropped webhook.** `data/call-events/*.json` is the
  durable record. If background processing crashes, the file remains and can
  be re-fed through the webhook endpoint manually.
- **Switching tunnels.** If you migrate from Cloudflare to ngrok / Tailscale,
  update `TELEPHONY_PUBLIC_URL` in both `.env` AND the Twilio + ElevenLabs
  consoles. Restart the daemon to pick up the new env.
