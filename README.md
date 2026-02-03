# H.O.M.E.R

**Hybrid Orchestration for Multi-model Execution and Routing**

A personal AI assistant daemon that routes queries through Claude Code with context-aware sessions, scheduled jobs, persistent memory, and multi-model subagent support.

## Features

- **Context-Aware Sessions**: Separate sessions for work/life contexts with project isolation
- **Multi-Model Routing**: Route to Gemini (research/UI) or Codex (architecture/debugging)
- **Persistent Memory**: Centralized memory with auto-append, FTS5 search, and MCP integration
- **Scheduled Jobs**: Cron-based jobs with hot reload and dashboard
- **Reminders**: Natural language reminders with chrono-node parsing
- **MCP Server**: Memory tools for Claude Code integration

## Quick Start

```bash
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your TELEGRAM_BOT_TOKEN and ALLOWED_CHAT_ID

# Run in development
npm run dev

# Build and run
npm run build
npm start
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/work [project]` | Switch to work context |
| `/life [area]` | Switch to life context |
| `/new` | Start fresh session |
| `/g <query>` | Use Gemini subagent (10min timeout) |
| `/x <query>` | Use Codex subagent (15min timeout) |
| `/jobs` | List scheduled jobs |
| `/trigger <id>` | Run a job manually |
| `/remind <time> <msg>` | Set reminder |
| `/reminders` | List pending reminders |
| `/cancel <id>` | Cancel reminder |
| `/status` | Show active sessions |
| `/search <query>` | FTS5 memory search |

## Architecture

HOMER is a 24/7 daemon that serves as the central hub for all AI interactions.

```
┌─────────────────────────────────────────────────────────────────┐
│                    HOMER DAEMON (Node.js)                        │
│                      localhost:3000                              │
│                                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                 │
│  │ Scheduler  │  │ Queue Mgr  │  │ State Mgr  │                 │
│  │ (cron)     │  │ (jobs)     │  │ (sessions) │                 │
│  └────────────┘  └────────────┘  └────────────┘                 │
│                                                                  │
│  ┌──────────────────────────────────────────────┐               │
│  │         CLAUDE EXECUTOR (core)                │               │
│  │  --print --stream-json --resume <id>         │               │
│  └──────────────────────────────────────────────┘               │
│                        │                                         │
│        ┌───────────────┼───────────────┐                        │
│        ▼               ▼               ▼                        │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐                    │
│  │ Telegram │   │ Web API  │   │ Voice WS │                    │
│  │   Bot    │   │ (REST)   │   │ (Speech) │                    │
│  └──────────┘   └──────────┘   └──────────┘                    │
└─────────────────────────────────────────────────────────────────┘
```

### Entry Points

| Interface | Access | Auth |
|-----------|--------|------|
| Local Claude Code | Direct CLI / MCP tools | None |
| Telegram | Grammy long-poll | Chat ID whitelist |
| Local Web UI | `http://127.0.0.1:3000` | None |
| Public Web UI | Cloudflare Tunnel | Cloudflare Access JWT |

## How It Works

1) **Daemon runs 24/7** on Mac mini as a LaunchAgent.
2) **All interfaces use the same Claude Executor**:
   - Telegram bot messages
   - Web UI chat (local and public)
   - Scheduled cron jobs
   - Voice WebSocket (STT → Claude → TTS)
3) **Claude CLI is spawned on demand** with `--resume <session_id>` when available; Homer stores only the session ID in SQLite.
   - Daemon uses `--dangerously-skip-permissions` to avoid interactive prompts.
4) **Auth via token file**: OAuth token is read from `~/.homer-claude-token` and passed to Claude CLI.
5) **Session persistence**: Each interface can maintain conversation context via Claude's `--resume` flag.
6) **Memory updates** are appended to daily logs and indexed for search; nightly jobs classify and organize.
7) **Single instance enforcement**: Flock-based OS lock prevents duplicate daemons, crash-safe with automatic cleanup.
8) **Reliable job queue**: Atomic job claiming, 10s heartbeat, 30s stale recovery, graceful shutdown handling.
7) **Public access** goes through Cloudflare Tunnel with Cloudflare Access JWT validation.
8) **Health checks**: `GET /health` (uptime) and `GET /health/auth` (Claude CLI + auth status).

## Subagents

### Gemini (`/g`)
- **Timeout**: 15 minutes
- **Use for**: Research, UI/UX, front-end design, exploration
- **NOT for**: Backend design, system architecture
- **Docs**: [docs/GEMINI_AGENT.md](docs/GEMINI_AGENT.md)

### Codex (`/x`)
- **Timeout**: 20 minutes
- **Model**: gpt-5.2-codex @ xHigh reasoning
- **Use for**: Deep reasoning, backend design, debugging, architecture
- **NOT for**: Front-end design, UI/UX work
- **Docs**: [docs/CODEX_AGENT.md](docs/CODEX_AGENT.md)

## Memory System

### Structure
```
~/memory/
├── me.md           # Identity, goals, HOMER config
├── work.md         # Career, projects, contacts, positioning
├── life.md         # Life context (goals, routines)
├── preferences.md  # Communication style, writing preferences
├── tools.md        # Tool configs (bird CLI, antigravity, etc.)
└── daily/          # Daily logs (indexed nightly)
    └── YYYY-MM-DD.md
```

### Flow
```
Session → auto-append to daily → nightly index (3 AM) → morning brief suggests promotions
```

### MCP Server (homer-memory)

Available tools for Claude Code:

**Memory Tools:**
| Tool | Description |
|------|-------------|
| `memory_search` | FTS5 full-text search across all memory |
| `memory_append` | Append entry to today's daily log |
| `memory_promote` | Promote fact to permanent file |
| `memory_read` | Read any memory file |
| `memory_reindex` | Rebuild search index |
| `memory_suggestions` | Get promotion candidates from daily |

**Ideas & Plans:**
| Tool | Description |
|------|-------------|
| `idea_add` | Add new idea with source and context |
| `idea_update` | Update idea status or add notes |
| `idea_list` | List ideas filtered by status |
| `plan_create` | Create plan from approved idea |
| `plan_update` | Update plan status/phase |
| `plan_list` | List all plans with status |
| `feedback_log` | Log decisions/feedback |

**Blob Storage (Azure):**
| Tool | Description |
|------|-------------|
| `blob_upload` | Upload file to Azure Blob |
| `blob_download` | Download blob to local |
| `blob_list` | List blobs in container |

### Auto-Append Triggers

During sessions, auto-append to daily log when:
- Significant decisions made
- Context that might matter tomorrow
- Blockers/issues encountered
- Task completions with outcomes
- Tool configs learned
- New preferences discovered

## Scheduled Jobs

### Built-in Jobs

| Schedule | Job ID | Description |
|----------|--------|-------------|
| `0 0 * * *` | learning-engine | Analyze viral content patterns |
| `0 1 * * *` | nightly-memory | Classify + organize daily log |
| `0 3 * * *` | moltbot-scan | Check Moltbot for feature ideas |
| `0 4 * * *` | homer-improvements | Self-analyze and suggest improvements |
| `0 6 * * *` | morning-brief | Weather, news, bookmarks, suggestions |
| `0 7 * * *` | daily-ideas-review | Send draft ideas for Telegram review |
| `0 9 * * *` | planning-reminder | Planning status and pending decisions |
| `0 */2 * * *` | ideas-explore | Gather ideas from bookmarks & GitHub |

### Custom Jobs

Create `schedule.json` in `~/work/`, `~/life/`, or `~/memory/`:

```json
{
  "version": "1.0",
  "jobs": [
    {
      "id": "morning-briefing",
      "name": "Morning Briefing",
      "cron": "0 9 * * *",
      "query": "Give me a morning briefing",
      "lane": "work",
      "enabled": true
    }
  ]
}
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | - | Telegram bot token |
| `ALLOWED_CHAT_ID` | Yes | - | Your Telegram chat ID |
| `SESSION_TTL_HOURS` | No | 4 | Session timeout |
| `LOG_LEVEL` | No | info | Logging level |
| `WEB_ENABLED` | No | true | Enable web dashboard |
| `WEB_PORT` | No | 3000 | Dashboard port |
| `CLAUDE_PATH` | No | `~/.local/bin/claude` | Claude CLI binary path |

## Development

```bash
# Type checking
npm run typecheck

# Run TUI dashboard
npm run tui

# Run MCP server directly
npm run mcp

# Development with hot reload
npm run dev
```

## Storage

| Path | Purpose |
|------|---------|
| `~/homer/data/homer.db` | SQLite state + FTS5 index |
| `~/homer/logs/` | Application logs |
| `~/memory/` | All memory files |

## Health Endpoints

- `GET /health` → daemon uptime/status
- `GET /health/auth` → Claude CLI presence + Keychain item check

## Daemon Auth

See `docs/DAEMON_AUTH.md` for LaunchAgent setup and Claude Code keychain guidance.

## Claude CLI Flags

Homer runs Claude CLI with:
- `--print`
- `--verbose`
- `--output-format stream-json`
- `--dangerously-skip-permissions` (non-interactive daemon mode)

If you want to remove `--dangerously-skip-permissions`, update:
- `src/executors/claude.ts`
- `src/scheduler/executor.ts`

## Status

**Current:** Phase 6.3 (Daemon Layer + Ideas/Plans + Web UI)

Key capabilities:
- 24/7 daemon with multiple entry points (Telegram, Web, Claude Code MCP)
- 8 scheduled heartbeat jobs (ideas exploration, learning engine, planning, etc.)
- Ideas/plans pipeline with approval workflow
- Public web access via Cloudflare Tunnel + Access

See [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md) for current implementation status.
See [architecture.md](architecture.md) for detailed system design.

## License

MIT
