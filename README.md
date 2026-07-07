# Homer

**Hybrid Orchestration for Multi-model Execution and Routing.**

Homer is a personal AI assistant daemon — a 24/7 process that turns Claude Code, Codex, Gemini, and Kimi into a single addressable agent with persistent memory, scheduled jobs, multi-channel input (Telegram, telephony, MCP), and an opinionated retrieval system. It is the personal automation harness of a single user, published as reference for anyone building similar systems.

> ⚠️ **This is a personal repository, not a product.** It runs on one Mac mini against one human's memory, calendar, inbox, and tools. The public snapshot deliberately excludes the personal subsystems (memory extraction, ideas pipeline, scraping/YouTube, meetings, several scheduler jobs — see the "Personal subsystems" block in `.gitignore`), so **a clone of this public repo will not compile as-is**; treat it as reference for building your own. On a complete copy of the tree, the Quick Start below is verified end-to-end and is written so an LLM agent (Claude Code, Codex) can execute it step by step: fresh SQLite DB, fresh `~/memory` scaffold, and a clean no-credential first boot. Integrations such as Telegram, model providers, Azure, Twilio, and ElevenLabs are optional and only activate once you supply credentials. Some one-off maintenance scripts under `scripts/macos/` and `scripts/backfill-*.ts` contain personal absolute paths and are not part of the install path.

The web UI lives in a separate private repository; this repo ships only the headless daemon plus the telephony webhook server.

## What it does

- Runs as a launchd daemon on macOS (`gui/$(id -u)/com.homer.daemon`) with a single-instance flock and crash-safe restart.
- Exposes the agent through three entry points — Telegram bot (Grammy), telephony webhooks (Twilio SMS + ElevenLabs Conversational AI), and an MCP stdio server for Claude Code.
- Schedules cron jobs (idea exploration, morning brief, memory rollup, planning checkups) with hot-reloadable `schedule.json` files.
- Stores all operational claims (facts, decisions, lessons, commitments) in a SQLite + FTS5 + vector knowledge store with a 2-tier memory model (canonical DB + live `~/memory/*.md`).
- Routes deep reasoning to Codex CLI, web-search research to Gemini (`agy-rotate`), long-context to Kimi, and everything else to Claude.
- Captures links from chat, processes them nightly through model-appropriate extractors (yt-dlp, Mozilla Readability, paywall bypass), and feeds them into an idea → plan → execution pipeline.

## Stack

- **Runtime:** Node.js 24+, TypeScript (ESM), Fastify (telephony only), Grammy, `better-sqlite3`, Zod
- **State:** Local SQLite (`homer.db`) with FTS5 and a vector chunk store; optional Azure Cosmos for cross-device sync
- **Storage:** Azure Blob for media; macOS Keychain for OAuth
- **LLMs:** Anthropic SDK, OpenAI SDK, Google Generative AI; CLI wrappers around `claude`, `codex`, `agy`, `kimi`
- **Browser:** Playwright for SPA scraping and job-application flows
- **MCP:** `@modelcontextprotocol/sdk` stdio server registering memory, blob, idea, plan, and todo tools
- **Telephony:** ElevenLabs Conversational AI + Twilio phone number, fronted by Cloudflare Tunnel (see [`docs/telephony.md`](docs/telephony.md))

## Repository layout

```
src/
├── bot/             # Telegram handlers
├── cli-sessions/    # Bridge Claude Code sessions into the daemon
├── executors/       # Wrappers around Claude / Codex / Gemini / Kimi CLIs
├── ideas/           # Capture → review → promote → plan pipeline
├── mcp/             # MCP stdio server (memory, blobs, ideas, plans, todos)
├── memory/          # 2-tier memory: claims DB + markdown surface
├── scheduler/       # Cron jobs with hot reload
├── scraping/        # yt-dlp, Readability, agent-browser (CDP) helpers
├── state/           # SQLite migrations + StateManager singleton
└── telephony/       # Twilio SMS + ElevenLabs webhook server (the only HTTP surface)
config/              # com.homer.daemon.plist.template (rendered at install time)
docs/                # telephony.md (architecture diagram + setup)
scripts/             # Build, install, deploy, backup, migration scripts
```

## Quick Start

### Prerequisites

- macOS (the daemon is launchd-based)
- Node.js 24+ (`brew install node`)
- Xcode Command Line Tools — `xcode-select --install` (needed for native deps `better-sqlite3` and `fs-ext`)
- Optional for chat: a Telegram bot token from [@BotFather](https://t.me/BotFather) and your numeric chat ID from [@userinfobot](https://t.me/userinfobot)
- Optional for telephony: [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) (`cloudflared`), a Twilio phone number, and an ElevenLabs Conversational AI agent — see [`docs/telephony.md`](docs/telephony.md)

### 1. Clone and configure

```bash
git clone https://github.com/Yanqing-Jiang/homer.git ~/homer
cd ~/homer

cp .env.example .env
npm install
npm run build
npm run typecheck
```

You can leave credentials empty for the first boot. With empty `TELEGRAM_BOT_TOKEN` or `ALLOWED_CHAT_ID`, Homer skips Telegram polling and keeps local services running. The first daemon boot creates:

```text
~/homer/data/homer.db
~/homer/logs/
~/memory/{me.md,work.md,preferences.md,tools.md,patterns.md,session-bootstrap.md,schedule.json}
```

Edit `.env` when you want integrations:

```bash
# Telegram chat surface
TELEGRAM_BOT_TOKEN=...
ALLOWED_CHAT_ID=...

# Optional model providers / storage / telephony
OPENAI_API_KEY=...
GEMINI_API_KEY=...
AZURE_STORAGE_CONNECTION_STRING=...
TWILIO_ACCOUNT_SID=...
ELEVEN_LABS_API_KEY=...
```

### 2. Run once interactively

```bash
npm start
```

In another terminal:

```bash
curl -fsS http://127.0.0.1:3000/health
```

Stop the foreground process with `Ctrl-C` after verifying health.

### 3. Install with launchd

```bash
bash scripts/install-daemon.sh
```

`install-daemon.sh` generates `~/Library/LaunchAgents/com.homer.daemon.plist` from `config/com.homer.daemon.plist.template`, substituting `$HOME`, `$(id -un)`, `$(id -gn)`, and `$(command -v node)` — so it works on any user account. Secrets are loaded by the daemon from `.env` via dotenv; never put them in the plist.

Verify launchd state:

```bash
launchctl print gui/$(id -u)/com.homer.daemon
tail -f ~/homer/logs/stdout.log
curl -fsS http://127.0.0.1:3000/health
```

### Other Entry Points

```bash
npm run mcp                   # MCP stdio server (for Claude Code)
npm run tui                   # blessed-based TUI dashboard
npm run restart               # request daemon restart through the heartbeat path
```

## Environment

The full list is in [`.env.example`](.env.example). The credentials you actually need depend on which surfaces you enable.

| Variable | Purpose | Required |
|---|---|---|
| `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_ID` | Telegram bot + single-user allowlist | only for Telegram |
| `OPENAI_API_KEY` / `MOONSHOT_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | Model providers and embeddings | only for jobs using those providers |
| `HOMER_HOME`, `HOMER_ROOT`, `DATABASE_PATH`, `MEMORY_PATH`, `LOGS_PATH` | Override local state locations | no |
| `AZURE_STORAGE_CONNECTION_STRING` | Blob storage for media | only for blob tools |
| `TELEPHONY_PUBLIC_URL` | Public origin Twilio uses for signature validation | only for public telephony |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | Twilio SMS + outbound calls | only for Twilio |
| `ELEVEN_LABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, `ELEVENLABS_WEBHOOK_SECRET` | ElevenLabs ConvAI + post-call webhooks | only for ElevenLabs |

`HOMER_API_URL` is accepted as a backward-compatible alias for `TELEPHONY_PUBLIC_URL`.

## Memory model

Two tiers, deliberately kept separate:

| Tier | Source | Used for |
|---|---|---|
| **Canonical** | `homer.db` (`knowledge_claims` + FTS5) and `~/memory/*.md` | Ground truth for every claim Homer makes |
| **Live** | `memory_context` MCP call | Real-time freshness check before answering status/goals/plans |

Operational claims (fact / decision / question / insight / commitment / lesson / hypothesis) live in the DB and are searchable through `knowledge_claims_fts`. Only `preference` claims are mirrored to markdown — the markdown is the durable human-readable surface, not a compatibility shim.

## MCP tools (highlights)

Registered against Claude Code over stdio:

- `memory_context`, `memory_read`, `memory_search`, `memory_promote`, `memory_remove`, `memory_suggest`
- `idea_add`, `idea_list`, `idea_update`
- `todo_save`, `todo_list`, `todo_start_chat`
- `blob_upload`, `blob_download`, `blob_list`, `blob_get_content`, `blob_properties`
- `meeting_list`, `meeting_search`, `meeting_get`
- `call_person`, `outcome_check`, `preference_query`, `thread_load`, `session_archive`

## Scheduled jobs

`schedule.json` files at `~/memory/schedule.json` and `~/work/schedule.json` are watched and hot-reloaded. The daemon ships a default set:

| When | Job | What it does |
|---|---|---|
| `0 1 * * *` | `nightly-memory` | Classify the day's daily log, suggest promotions |
| `0 6 * * *` | `morning-brief` | Weather, news, calendar, pending todos, idea suggestions |
| `0 7 * * *` | `daily-ideas-review` | Send draft ideas to Telegram for HITL review |
| `0 23 * * *` | `link-processor` | Process the day's queued URLs into ideas |
| `0 */2 * * *` | `ideas-explore` | Pull from bookmarks, GitHub, RSS |
| `0 9 * * *` | `planning-reminder` | Surface stalled plans and pending decisions |

## Telephony

Homer's only public HTTP surface. Two webhook routes plus `/health`, all behind a Cloudflare Tunnel:

- `POST /webhooks/elevenlabs/call-complete` — HMAC-SHA256 signed, persists transcript to disk before 200, processes summary in background
- `POST /webhooks/twilio/sms` — HMAC-SHA1 signed, replies with empty TwiML, forwards SMS to Telegram

Architecture diagram, env-var table, Cloudflare/Twilio/ElevenLabs setup, signature-validation curl recipes, and troubleshooting are in [`docs/telephony.md`](docs/telephony.md).

## A note on tests

Personal fixture tests are not shipped in this public repo. `npm test` runs the public typecheck and production build checks.

## Status

This is a personal, single-tenant system under active churn. Interfaces, schema, and tools change without notice. There is no release process, no versioning beyond `package.json`. Use as a reference, not a dependency.

## License

MIT — see [`LICENSE`](LICENSE).
