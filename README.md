# Homer

**Hybrid Orchestration for Multi-model Execution and Routing.**

Homer is a personal AI assistant daemon — a 24/7 process that turns Claude Code, Codex, Gemini, and Kimi into a single addressable agent with persistent memory, scheduled jobs, multi-channel input (Telegram, telephony, MCP), and an opinionated retrieval system.

This repository is the **shell**: the daemon framework, scheduler, executors, browser broker, telephony server and the tooling around them. Everything specific to one operator — their skills, scheduled jobs for their own portals and data, personal bins and configs — lives in a separate, unpublished checkout that plugs in through the [private overlay](#private-overlay). You generate your own skills and jobs; nothing here assumes who you are.

> ⚠️ **This is a personal system published as reference, not a product.** It runs on one Mac mini against one human's memory, inbox and tools. Several subsystems the daemon imports (memory extraction, meetings, telephony internals, scraping pipelines, YouTube processing) are still kept out of the public snapshot — see the "Personal subsystems" block at the end of `.gitignore` — so **a clone of this repository does not compile on its own yet**; treat it as a reference for building your own. Interfaces, schema and tools change without notice.

## What it does

- Runs as a launchd daemon on macOS (`gui/$(id -u)/com.homer.daemon`) under a resident supervisor with a single-instance flock and crash-safe restart.
- Exposes the agent through three entry points — Telegram bot (Grammy), telephony webhooks (Twilio SMS + ElevenLabs Conversational AI), and an MCP stdio server for Claude Code.
- Schedules cron jobs from hot-reloadable `schedule.json` files; internal handlers, CLI-driven skills, and overlay-supplied jobs share one registry and one harness-selection table.
- Stores operational claims (facts, decisions, lessons, commitments) in a SQLite + FTS5 + vector knowledge store with a 2-tier memory model (canonical DB + live `~/memory/*.md`).
- Routes deep reasoning to Codex CLI, web-search research to Gemini (`agy`), long-context to Kimi, and everything else to Claude, with per-job fallback chains.
- Brokers one resident Chrome (CDP) between agents through `bin/browserctl` leases, with session stewardship for whatever authenticated surfaces the overlay declares.

## Stack

- **Runtime:** Node.js 24+, TypeScript (ESM), Fastify (telephony only), Grammy, `better-sqlite3`, Zod
- **State:** Local SQLite (`homer.db`) with FTS5 and a vector chunk store
- **Storage:** Azure Blob for media; macOS Keychain for OAuth
- **LLMs:** Anthropic SDK, OpenAI SDK, Google Generative AI; CLI wrappers around `claude`, `codex`, `agy`, `kimi`
- **Browser:** Playwright and a CDP lease broker over one resident Chrome
- **MCP:** `@modelcontextprotocol/sdk` stdio server registering memory, blob, session, call, and todo tools
- **Telephony:** ElevenLabs Conversational AI + Twilio phone number, fronted by Cloudflare Tunnel (see [`docs/telephony.md`](docs/telephony.md))

## Repository layout

```
src/
├── bot/             # Telegram handlers
├── cli-sessions/    # Bridge Claude Code sessions into the daemon
├── executors/       # Wrappers around Claude / Codex / Gemini / Kimi CLIs
├── harness/         # Harness-independent capability resolution
├── mcp/             # MCP stdio server
├── scheduler/       # Cron jobs, registry, harness baselines, failure takeover
├── scraping/        # Browser broker, session stewardship, agent-browser helpers
├── state/           # SQLite migrations + StateManager singleton
├── private-overlay.ts   # Loader for the operator's private overlay (optional)
└── private/         # (symlink, untracked) the overlay's sources when installed
bin/browserctl       # CLI for the browser lease broker
config/              # *.template launchd plists rendered at install time
scripts/             # Build, install, restart, overlay, skill rendering
skills/aliases/      # Logical -> harness-native MCP tool alias table
docs/                # telephony.md, harness-independence.md
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

Fill in the **operator identity** block of `.env` (`OWNER_DISPLAY_NAME`, `OWNER_PHONE`, `OWNER_SITE`, `OWNER_GOOGLE_ACCOUNT`, ...): prompts, alerts and integrations read the operator's name and accounts from the environment only. Credentials can stay empty for the first boot; with empty `TELEGRAM_BOT_TOKEN` or `ALLOWED_CHAT_ID`, Homer skips Telegram polling and keeps local services running. The first daemon boot creates:

```text
~/homer/data/homer.db
~/homer/logs/
~/memory/{me.md,work.md,preferences.md,tools.md,patterns.md,session-bootstrap.md,schedule.json}
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

`install-daemon.sh` renders `~/Library/LaunchAgents/com.homer.daemon.plist` from `config/com.homer.daemon.plist.template`, substituting the home directory, user, group and managed Node binary — so it works on any account. Secrets are loaded by the daemon from `.env` via dotenv; never put them in the plist.

Verify:

```bash
launchctl print gui/$(id -u)/com.homer.daemon
tail -f ~/homer/logs/stdout.log
curl -fsS http://127.0.0.1:3000/health
```

### Other entry points

```bash
npm run mcp                   # MCP stdio server (for Claude Code)
npm run tui                   # blessed-based TUI dashboard
npm run restart               # request a daemon restart through the supervisor
npm run deploy                # build, smoke-test, restart, wait for the new build
npm run private:status        # show private-overlay links (if an overlay is installed)
```

## Skills

Skills are not shipped. Homer only ships the **skill layout** and the renderer that fans one canonical skill out to every harness (Claude Code, OpenCode, Codex, plus a plain view the scheduler injects as `contextFiles`). You write your own.

### Layout

A skill root is any directory with this shape (this repository's `skills/` is the reference for the alias table only):

```
<root>/skills/
├── aliases/mcp-tools.yaml     # logical tool -> harness-native MCP tool name (copy skills/aliases/mcp-tools.yaml)
├── skills/<id>/skill.md       # one directory per skill; optional config.json / scripts/ beside it
├── commands/<id>.md           # slash commands (kind: command)
└── agents/<id>.md             # sub-agent definitions (kind: agent)
<root>/generated/harness/      # renderer output (claude/, opencode/, codex/, plain/) — never hand-edit
```

Each `skill.md` starts with YAML frontmatter, then the body. The minimum:

```markdown
---
kind: skill
id: morning-brief
title: Morning Brief
description: Weather, calendar and open todos for the day. Trigger on '/morning-brief'.
version: 1
status: active
triggers:
  slash:
    - /morning-brief
execution:
  disableModelInvocation: false   # true = never auto-invoked by a model, only by slash trigger
  schedulerSafe: true             # may be run unattended by the scheduler
tools:
  logical:
    - memory.context
    - memory.search
harness:
  claude: { emitSkill: true }
  opencode: { emitSkill: true }
  codex: { emitSkill: true }
---

Instructions for the agent go here. Refer to MCP tools by their logical
name with a macro, e.g. {{tool:memory.search}}; the renderer rewrites it to
mcp__homer-memory__memory_search for Claude and memory_search for the others.
```

`id` must match the directory name. Reference MCP tools by the **logical** names defined in `aliases/mcp-tools.yaml`; the renderer substitutes each harness's native tool name.

### Rendering and installing

Point the renderer at your skill root(s) with `~/.config/homer/skill-roots.json`:

```json
{ "roots": ["/path/to/my-skills"] }
```

Roots are scanned in order; the first root supplies `aliases/mcp-tools.yaml`; an entry may be `{ "path": "...", "exclude": ["skill-id"] }` to skip ids. Without this file the renderer treats this repository as the single root. Then:

```bash
npm run skills:render            # write <root>/generated/harness/{claude,opencode,codex,plain}/...
npm run skills:check             # fail if generated views drift from canonical (CI gate)
npm run skills:install           # render + copy into ~/.claude, ~/.config/opencode, ~/.codex
tsx scripts/render-harness-assets.ts list
```

Scheduled jobs that run a skill reference its plain view, e.g. `contextFiles: ["<root>/generated/harness/plain/morning-brief.md"]` in `schedule.json`.

## Private overlay

Operator-specific code — jobs for your own portals and data, browser surfaces to keep signed in, personal bins, launchd/tmux configs, one-off scripts — lives in a separate checkout that is never published. The daemon discovers it through `HOMER_PRIVATE_ROOT` (or the sibling directory `../homer-private`) and its `homer-overlay.json` manifest:

| Manifest key | What it does |
|---|---|
| `links` | `{ target, link }` pairs symlinked into this tree by `scripts/private-overlay.mjs link` (run automatically by `npm run build`). Conventional links: `src -> src/private`, `tests -> tests/private`, `scripts -> scripts/private`, individual `bin/<tool>` files, `skills/{skills,commands,dist}`, `generated`. All of these paths are git-ignored here and rejected by the nightly push job. |
| `jobs` | Registry entries (same shape as `src/scheduler/registry.ts`) for the overlay's scheduled jobs; their handler files live in `<overlay>/src/scheduler/jobs/`. |
| `handlersModule` | Module under `<overlay>/src` exporting `handlers: Record<handlerName, PrivateJobHandler>` (contract in `src/scheduler/private-job-contract.ts`). Any `handler` in `schedule.json` the daemon does not implement itself is dispatched here. |
| `harnessBaselines` | Per-job executor/model baselines merged into `INTERNAL_JOB_HARNESS_BASELINES`. |
| `stewardshipSurfacesModule` | Module exporting `SURFACES` (see `StewardshipSurface` in `src/scraping/session-stewardship.ts`): the authenticated tabs the resident Chrome keeps alive. Without it, stewardship is idle. |
| `smokeModules` | Extra compiled modules `scripts/smoke-test.mjs` must import before a restart. |

Overlay sources under `src/` are compiled by this repository's build (their relative imports are written as if they lived at `src/private/...`); the private checkout has no build of its own. Overlay tests and scripts run as entry files through the symlink, so they import via `../../homer/...` relative to their real location and run with `NODE_OPTIONS=--preserve-symlinks`.

## Environment

The full list is in [`.env.example`](.env.example). The credentials you actually need depend on which surfaces you enable.

| Variable | Purpose | Required |
|---|---|---|
| `OWNER_DISPLAY_NAME`, `OWNER_FULL_NAME`, `OWNER_PHONE`, `OWNER_SITE`, `OWNER_GOOGLE_ACCOUNT` | Operator identity used in prompts, alerts and OAuth integrations | recommended |
| `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_ID` | Telegram bot + single-user allowlist | only for Telegram |
| `OPENAI_API_KEY` / `MOONSHOT_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` | Model providers and embeddings | only for jobs using those providers |
| `HOMER_HOME`, `HOMER_ROOT`, `DATABASE_PATH`, `MEMORY_PATH`, `LOGS_PATH` | Override local state locations | no |
| `HOMER_PRIVATE_ROOT` | Private overlay checkout (empty disables) | no |
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

Operational claims (fact / decision / question / insight / commitment / lesson / hypothesis) live in the DB and are searchable through `knowledge_claims_fts`. Only `preference` claims are mirrored to markdown.

## MCP tools (highlights)

Registered against Claude Code over stdio:

- `memory_context`, `memory_search` (ranked recall, plus `mode='fetch'` for a whole-document read of a canonical doc), `memory_promote`, `memory_remove`, `memory_suggest`
- `todo_save`, `todo_list`, `todo_start_chat`
- `blob_upload`, `blob_download`, `blob_list`, `blob_get_content`, `blob_properties`
- `call_person`, `outcome_check`, `preference_query`, `thread_load`, `session_archive`

## Scheduled jobs

`schedule.json` files at `~/memory/schedule.json` and `~/work/schedule.json` are watched and hot-reloaded. A job either names an internal `handler` (implemented in `src/scheduler/internal-handlers.ts` or supplied by the overlay) or runs a CLI harness with a skill's plain view as context. `src/scheduler/registry.ts` is the single source of truth and is validated against the loaded schedules at boot.

## Telephony

Homer's only public HTTP surface. Two webhook routes plus `/health`, all behind a Cloudflare Tunnel:

- `POST /webhooks/elevenlabs/call-complete` — HMAC-SHA256 signed, persists transcript to disk before 200, processes summary in background
- `POST /webhooks/twilio/sms` — HMAC-SHA1 signed, replies with empty TwiML, forwards SMS to Telegram

Architecture diagram, env-var table, Cloudflare/Twilio/ElevenLabs setup, signature-validation curl recipes, and troubleshooting are in [`docs/telephony.md`](docs/telephony.md).

## Tests

`npm test` runs the typecheck, build, skill-drift, harness-lint and conformance checks plus the browser-broker test. Operator fixture tests live in the private overlay.

## License

MIT — see [`LICENSE`](LICENSE).
