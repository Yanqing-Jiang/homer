# Homer

**Hybrid Orchestration for Multi-model Execution and Routing.**

Homer is a personal AI assistant daemon — a 24/7 process that turns Claude Code, Codex, Gemini, and Kimi into a single addressable agent with persistent memory, scheduled jobs, multi-channel input (Telegram, web, voice, MCP), and an opinionated retrieval system. It is the personal automation harness of a single user, published as reference for anyone building similar systems.

> ⚠️ **This is a personal repository, not a product.** It runs on one Mac mini against one human's memory, calendar, inbox, and tools. Many scripts and launchd plists reference absolute paths like `/Users/yj/...` — substitute your own `$HOME` if you intend to actually install it. The patterns are reusable; the configuration is not.

## What it does

- Runs as a launchd daemon on macOS with a single-instance flock and crash-safe restart.
- Exposes the same agent through four entry points — Telegram bot (Grammy), local web UI (Fastify + SvelteKit), public web UI (Cloudflare Tunnel + Access JWT), and MCP server for Claude Code.
- Schedules cron jobs (idea exploration, morning brief, memory rollup, learning engine, planning checkups) with hot-reloadable `schedule.json` files.
- Stores all operational claims (facts, decisions, lessons, commitments) in a SQLite + FTS5 + vector knowledge store with a 2-tier memory model (canonical DB + live `~/memory/*.md`).
- Routes deep reasoning to Codex CLI, web-search research to Gemini (`agy-rotate`), long-context to Kimi, and everything else to Claude.
- Captures links from chat, processes them nightly through model-appropriate extractors (yt-dlp, Mozilla Readability, paywall bypass), and feeds them into an idea → plan → execution pipeline.

## Stack

- **Runtime:** Node.js 22, TypeScript (ESM), Fastify, Grammy, `better-sqlite3`, Zod
- **State:** Local SQLite (`homer.db`) with FTS5 and a vector chunk store; optional Azure Cosmos for cross-device sync
- **Storage:** Azure Blob for media; macOS Keychain for OAuth
- **LLMs:** Anthropic SDK, OpenAI SDK, Google Generative AI; CLI wrappers around `claude`, `codex`, `agy`, `kimi`
- **Browser:** Playwright for SPA scraping and job-application flows
- **MCP:** `@modelcontextprotocol/sdk` stdio server registering memory, blob, idea, plan, and todo tools
- **Web UI:** SvelteKit 2, Svelte 5, Tailwind v4 (in [`web/`](web/) — its own `package.json`)
- **Public access:** Cloudflare Tunnel + Cloudflare Access JWT, fronted by an Express proxy on Azure Container Apps (in [`azure-proxy/`](azure-proxy/))

## Repository layout

```
src/
├── bot/             # Telegram handlers
├── cli-sessions/    # Bridge Claude Code sessions into the daemon
├── executors/       # Wrappers around Claude / Codex / Gemini / Kimi CLIs
├── ideas/           # Capture → review → promote → plan pipeline
├── job-hunt/        # Career-site automation (Playwright + Gmail)
├── mcp/             # MCP stdio server (memory, blobs, ideas, plans, todos)
├── memory/          # 2-tier memory: claims DB + markdown surface
├── scheduler/       # Cron jobs with hot reload
├── scraping/        # yt-dlp, Readability, opencli browser bridge
└── state/           # SQLite migrations + StateManager singleton
azure-proxy/         # Cloudflare-fronted relay for the public web UI
web/                 # SvelteKit static UI (deployed to Azure Static Web Apps)
scripts/             # Build, install, deploy, backup, migration scripts
```

## Quick start

> Realistically, this is not a "clone and run" project — it expects a specific personal directory layout (`~/memory/`, `~/homer/data/`, `~/.claude/`) and external services (Telegram bot, Cloudflare Tunnel, Azure, Claude Code CLI). Treat the steps below as the minimum to compile and explore the code.

```bash
git clone https://github.com/Yanqing-Jiang/homer.git
cd homer

cp .env.example .env          # fill in credentials you actually want to use
npm install
npm run build
npm run typecheck             # must pass clean

npm run dev                   # runs the daemon under tsx
npm run mcp                   # runs only the MCP stdio server
npm run tui                   # runs the blessed-based TUI dashboard
```

The launchd plist at `config/com.homer.daemon.plist` shows how it runs in production. Install it with `npm run app:service:register`; tear it down with `npm run app:service:unregister`. Both assume `${HOME}/Applications/Homer.app` exists — build it with `npm run app:build` first.

### Web UI

```bash
cd web
npm install
npm run dev            # SvelteKit dev server, talks to the daemon on localhost:3000
npm run build          # static build → web/build/
```

## Environment

The full list is in [`.env.example`](.env.example). The credentials you actually need depend on which surfaces you enable — at minimum, Homer wants a Telegram bot token and chat-ID whitelist, an Anthropic key (or a Claude Code CLI already authed), and a writable `~/memory/` directory.

| Variable | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_ID` | Telegram bot + single-user allowlist |
| `OPENAI_API_KEY` / `MOONSHOT_API_KEY` / `GEMINI_API_KEY` | Optional model providers (CLIs preferred for most routing) |
| `AZURE_STORAGE_CONNECTION_STRING` | Blob storage for media |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET` | Optional auth + sync layer |
| `HOMER_API_URL` | Required for `azure-proxy/` — origin URL of your tunnel |
| `WEB_EXPOSE_EXTERNALLY` | Whether Fastify binds to `0.0.0.0` for Cloudflare Tunnel |

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

## A note on tests

Test files (`*.test.ts`, `__tests__/`) are intentionally not shipped in this public repo. They depended on the author's personal memory fixtures and aren't useful to outside readers. The vitest config has been removed; `npm test` is a no-op.

## Status

This is a personal, single-tenant system under active churn. Interfaces, schema, and tools change without notice. There is no release process, no versioning beyond `package.json`. Use as a reference, not a dependency.

## License

MIT — see [`LICENSE`](LICENSE).
