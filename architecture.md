# H.O.M.E.R Architecture

**H.O.M.E.R** - Hybrid Orchestration for Multi-model Execution and Routing

## Overview

HOMER is a 24/7 daemon that serves as a central hub for AI-assisted automation. All interfaces (Telegram, web UI, scheduled jobs, local Claude Code) communicate through the daemon layer to execute tasks via Claude Code.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          MAC MINI (24/7)                                │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    HOMER DAEMON (Node.js)                        │   │
│  │                      port 3000 (local)                           │   │
│  │                                                                  │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │   │
│  │  │  Scheduler   │  │ Queue Mgr    │  │ State Mgr    │           │   │
│  │  │  (cron jobs) │  │ (job queue)  │  │ (sessions)   │           │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘           │   │
│  │                                                                  │   │
│  │  ┌──────────────────────────────────────────────────┐           │   │
│  │  │           CLAUDE EXECUTOR (core)                  │           │   │
│  │  │  - Spawns Claude CLI with --print --stream-json  │           │   │
│  │  │  - Session persistence via --resume <id>         │           │   │
│  │  │  - Subagent routing (gemini, codex)              │           │   │
│  │  │  - 20min timeout, SIGTERM/SIGKILL escalation     │           │   │
│  │  └──────────────────────────────────────────────────┘           │   │
│  │                            │                                     │   │
│  │            ┌───────────────┼───────────────┐                    │   │
│  │            ▼               ▼               ▼                    │   │
│  │     ┌──────────┐    ┌──────────┐    ┌──────────┐               │   │
│  │     │ Telegram │    │ Web API  │    │ Voice WS │               │   │
│  │     │   Bot    │    │ (REST)   │    │ (Speech) │               │   │
│  │     └──────────┘    └──────────┘    └──────────┘               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─────────────┐  ┌─────────────────┐  ┌───────────────────┐          │
│  │ SQLite DB   │  │ ~/memory/*.md   │  │ Cloudflare Tunnel │          │
│  │ (sessions,  │  │ (persistent     │  │ (public access)   │          │
│  │  jobs, FTS) │  │  context)       │  │                   │          │
│  └─────────────┘  └─────────────────┘  └───────────────────┘          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Entry Points

| Interface | How it connects | Auth |
|-----------|----------------|------|
| **Local Claude Code** | Direct CLI or HOMER MCP tools | None (local) |
| **Telegram** | Grammy bot, long polling | `allowedChatId` whitelist |
| **Local Web UI** | `http://127.0.0.1:3000` | None (localhost only) |
| **Public Web UI** | Cloudflare Tunnel → `:3000` | Cloudflare Access (JWT) |

## Service Layer

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Core Services                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │  Claude  │ │  Voice   │ │ Browser  │ │  Search  │ │  Memory  │  │
│  │ Executor │ │ Service  │ │ Manager  │ │  Hybrid  │ │ Manager  │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘  │
└───────┼────────────┼────────────┼────────────┼────────────┼────────┘
        │            │            │            │            │
        ▼            ▼            ▼            ▼            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      External Services                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │ Claude   │ │ OpenAI   │ │Eleven    │ │ SQLite   │ │ Play-    │  │
│  │ CLI      │ │ Whisper  │ │Labs TTS  │ │ FTS5     │ │ wright   │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Interface Flows

### Telegram Bot
```
Telegram → Bot (Grammy) → parseRoute() → executeClaudeCommand()
                                              │
                                              ▼
                                     Claude CLI spawn
                                     + session resume
                                     + memory context injection
```
- Text messages → routed to Claude
- `/g` prefix → Gemini subagent
- `/x` prefix → Codex subagent
- Voice messages → Whisper transcribe → Claude → ElevenLabs TTS (if enabled)

### Web UI (Local & Public)

**Production Architecture (Azure-based, corp-friendly):**
```
┌─────────────────────────────────────────────────────────────────────┐
│  Corporate Network View (what they see)                              │
│                                                                      │
│  Browser → Azure Static Web Apps      → Azure Container Apps        │
│            (green-stone-*.4.           (owendevstorage.*             │
│             azurestaticapps.net)        azurecontainerapps.io)      │
│                                                                      │
│  ✓ All traffic appears as Azure-to-Azure                            │
│  ✓ No personal domains visible                                       │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼ (hidden from corp)
┌─────────────────────────────────────────────────────────────────────┐
│  Actual Traffic Flow                                                 │
│                                                                      │
│  Azure Container Apps → Cloudflare Tunnel → Mac Mini (localhost:3000)│
│  (owendevstorage)       (homer.jiangyanqing.com)                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Local Development:**
```
Browser → Vite Dev (5173) → Fastify REST API (3000) → StateManager/QueueManager
              │
              └─→ /api/chat/send → executeClaudeCommand()
              └─→ /api/sessions → get active sessions
              └─→ /api/jobs → job queue status
              └─→ WebSocket → voice chat (STT/TTS)
```

**Code Locations:**
| Component | Path |
|-----------|------|
| Frontend (SvelteKit) | `~/homer/web/` |
| API client | `~/homer/web/src/lib/api/client.ts` |
| Azure proxy | `~/homer/azure-proxy/` |
| Daemon API routes | `~/homer/src/web/api/` |
| Main daemon routes | `~/homer/src/web/routes.ts` |

**URLs:**
| Environment | URL |
|-------------|-----|
| Production frontend | https://green-stone-0d921fb1e.4.azurestaticapps.net |
| Production API proxy | https://owendevstorage.icycoast-7ad83edf.westus2.azurecontainerapps.io |
| Cloudflare Tunnel (hidden) | https://homer.jiangyanqing.com |
| Daemon local | http://localhost:3000 |
| Vite dev server | http://localhost:5173 |

**Deployment:**

Frontend deploys automatically via GitHub Actions on push to main:
- Workflow: `.github/workflows/azure-static-web-apps-green-stone-0d921fb1e.yml`
- Sets `VITE_API_BASE` to Azure Container Apps proxy URL

Azure Container Apps proxy (`~/homer/azure-proxy/`):
```bash
# Build and push to ACR
cd ~/homer/azure-proxy
az acr build --registry ca81ec398ed2acr --image owendevstorage:latest .

# Update container app
az containerapp update --name owendevstorage --resource-group homer-web-ui_group \
  --image ca81ec398ed2acr.azurecr.io/owendevstorage:latest
```

**Environment Variables (`~/homer/web/.env`):**
- `VITE_SUPABASE_URL` - Supabase project URL
- `VITE_SUPABASE_ANON_KEY` - Supabase anon key
- `VITE_API_BASE` - Homer daemon URL

**Web UI API Routes:**
| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/chat-sessions` | GET, POST | List/create chat sessions |
| `/api/chat-sessions/:id` | GET, PATCH, DELETE | Get/update/delete session |
| `/api/chat-sessions/:id/threads` | GET, POST | List/create threads |
| `/api/threads/:id` | GET, PATCH | Get/update thread |
| `/api/threads/:id/messages` | GET, POST | List/create messages |
| `/api/threads/:id/stream` | POST | SSE streaming chat |
| `/api/ideas` | GET, POST | List/create ideas |
| `/api/ideas/:id` | GET, PATCH | Get/update idea |
| `/api/plans` | GET | List plans |
| `/api/plans/:id` | GET | Get plan details |
| `/api/jobs/scheduled` | GET | List scheduled jobs |
| `/api/jobs/scheduled/:id` | GET, PATCH | Get/update job |
| `/api/jobs/scheduled/:id/run` | POST | Trigger job |
| `/api/jobs/calendar` | GET | Calendar view |

### Local Claude Code
```
Terminal → claude CLI → (works independently)
                OR
Terminal → HOMER MCP tools → daemon APIs → Claude executor
```
When running `claude` locally, it's standalone. HOMER MCP tools provide access to daemon state (memory, jobs, ideas, plans).

### Remote Desktop (Guacamole)

The Web UI includes a Remote Desktop tab that provides VNC access to the Mac desktop via Apache Guacamole, enabling browser-based control of AI tools (ChatGPT, Claude, Gemini).

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Remote Desktop Architecture                       │
│                                                                       │
│  Browser (Web UI)                                                     │
│       │                                                               │
│       │ WebSocket (/guac/guacamole/websocket-tunnel)                 │
│       ▼                                                               │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  Vite Dev Server (localhost:5173+)                               │ │
│  │  OR Azure Container Apps Proxy (production)                      │ │
│  │       │                                                          │ │
│  │       │ Proxy /guac/* → localhost:8080                          │ │
│  │       ▼                                                          │ │
│  │  ┌─────────────────────────────────────────────────────────────┐│ │
│  │  │  Guacamole Web App (homer-guacamole:8080)                   ││ │
│  │  │  • REST API for auth tokens                                 ││ │
│  │  │  • WebSocket tunnel endpoint                                ││ │
│  │  │  • User/connection management                               ││ │
│  │  └───────────────────────┬─────────────────────────────────────┘│ │
│  │                          │                                       │ │
│  │                          ▼                                       │ │
│  │  ┌─────────────────────────────────────────────────────────────┐│ │
│  │  │  guacd Daemon (homer-guacd:4822)                            ││ │
│  │  │  • VNC/RDP/SSH protocol handler                             ││ │
│  │  │  • Translates Guacamole protocol ↔ native protocols         ││ │
│  │  └───────────────────────┬─────────────────────────────────────┘│ │
│  │                          │                                       │ │
│  │                          │ VNC (port 5900)                       │ │
│  │                          ▼                                       │ │
│  │  ┌─────────────────────────────────────────────────────────────┐│ │
│  │  │  macOS Screen Sharing (host.docker.internal:5900)           ││ │
│  │  │  • VNC password authentication                              ││ │
│  │  │  • Full desktop access                                      ││ │
│  │  └─────────────────────────────────────────────────────────────┘│ │
│  └─────────────────────────────────────────────────────────────────┘ │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  PostgreSQL (homer-guac-db:5432)                                 │ │
│  │  • User accounts, connections, permissions                       │ │
│  │  • Session history                                               │ │
│  └─────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**Docker Compose Stack (`~/homer/guacamole/`):**

| Container | Image | Port | Purpose |
|-----------|-------|------|---------|
| `homer-guacamole` | `guacamole/guacamole` | 8080 | Web UI + REST API |
| `homer-guacd` | `guacamole/guacd` | 4822 (internal) | Protocol daemon |
| `homer-guac-db` | `postgres:15-alpine` | 5432 (internal) | Connection/user storage |

**Setup:**

```bash
# Prerequisites
# 1. Enable macOS Screen Sharing (System Settings → Sharing)
# 2. Set VNC password (click (i) next to Screen Sharing)

# Start Guacamole stack
cd ~/homer/guacamole
docker-compose up -d

# Access Guacamole UI
open http://localhost:8080/guacamole
# Login: guacadmin / guacadmin

# Reset guacadmin password (if locked out)
docker exec homer-guac-db psql -U guacamole_user -d guacamole_db -c "
UPDATE guacamole_user SET
  password_hash = decode('CA458A7D494E3BE824F5E1E175A1556C0F8EEF2C2D7DF3633BEC4A29C4411960', 'hex'),
  password_salt = decode('FE24ADC5E11E2B25288D1704ABE67A79E342ECC26064CE69C5B3177795A82264', 'hex')
WHERE entity_id = 1;"
```

**VNC Connection Config (stored in PostgreSQL):**

| Parameter | Value | Description |
|-----------|-------|-------------|
| `hostname` | `host.docker.internal` | Docker's host machine alias |
| `port` | `5900` | macOS Screen Sharing port |
| `password` | `<vnc-password>` | Must match macOS VNC password |

**Update VNC password in Guacamole:**
```bash
docker exec homer-guac-db psql -U guacamole_user -d guacamole_db -c "
UPDATE guacamole_connection_parameter
SET parameter_value = 'YOUR_VNC_PASSWORD'
WHERE connection_id = 1 AND parameter_name = 'password';"
```

**Web UI Components:**

| Component | Path | Purpose |
|-----------|------|---------|
| `GuacamoleViewer.svelte` | `web/src/lib/components/` | Guacamole client (keyboard, mouse, display) |
| `RemoteDesktopTabs.svelte` | `web/src/lib/components/` | Tab interface for ChatGPT/Claude/Gemini |

**Vite Proxy Config (`web/vite.config.ts`):**
```typescript
server: {
  proxy: {
    '/guac': {
      target: 'http://localhost:8080',
      changeOrigin: true,
      ws: true,  // WebSocket support
      rewrite: (path) => path.replace(/^\/guac/, '')
    }
  }
}
```

**Production Proxy (Azure Container Apps):**
- URL: `owendevstorage.icycoast-7ad83edf.westus2.azurecontainerapps.io`
- Routes `/api/*` to Homer daemon (via Cloudflare Tunnel)
- Routes `/guac/*` to Guacamole backend

**Authentication Flow:**
```
1. Get auth token:
   POST /guacamole/api/tokens
   Body: username=guacadmin&password=guacadmin
   Response: { "authToken": "...", "username": "guacadmin" }

2. Connect to VNC:
   WebSocket /guacamole/websocket-tunnel?token=<authToken>
   Guacamole protocol messages for input/display
```

**Troubleshooting:**

| Issue | Solution |
|-------|----------|
| "Too many failed attempts" | Clear login history: `DELETE FROM guacamole_user_history;` then restart container |
| VNC connection fails | Verify macOS Screen Sharing enabled, VNC password matches |
| Port 4822 in use | Stop duplicate guacd: `docker stop <container>` |
| WebSocket 403 | Check Vite proxy config, ensure `/guac` routes correctly |

**Test Commands:**
```bash
# Test Guacamole API
curl -s -X POST 'http://localhost:8080/guacamole/api/tokens' \
  -d 'username=guacadmin&password=guacadmin' \
  -H 'Content-Type: application/x-www-form-urlencoded'

# Check VNC connectivity from Docker
docker exec homer-guacd nc -zv host.docker.internal 5900

# View guacd logs
docker logs homer-guacd --tail 20

# List connections
docker exec homer-guac-db psql -U guacamole_user -d guacamole_db \
  -c "SELECT connection_id, connection_name, protocol FROM guacamole_connection;"
```

### Scheduled Jobs (Autonomous)
```
Scheduler → CronManager → executeScheduledJob()
                               │
                               ▼
                      Claude CLI with job prompt
                               │
                               ▼
                      Telegram notification
```

## Directory Structure

```
homer/
├── src/
│   ├── index.ts              # Entry point, bot initialization
│   ├── bot/
│   │   ├── index.ts          # Bot setup, command handlers
│   │   ├── streaming.ts      # Telegram message streaming
│   │   └── middleware/
│   │       └── auth.ts       # Chat authorization
│   ├── config/
│   │   └── index.ts          # Configuration management
│   ├── context/
│   │   └── detector.ts       # Auto context detection
│   ├── router/
│   │   ├── prefix-router.ts  # Message routing
│   │   └── types.ts          # Lane types
│   ├── executors/
│   │   └── claude.ts         # Claude CLI executor
│   ├── state/
│   │   └── manager.ts        # Session state (SQLite)
│   ├── memory/
│   │   ├── loader.ts         # Memory file loading
│   │   ├── writer.ts         # Memory update processing
│   │   ├── daily.ts          # Daily log management
│   │   ├── flush.ts          # Pre-timeout session flush
│   │   ├── indexer.ts        # FTS5 full-text search
│   │   └── search.ts         # Grep-based search fallback
│   ├── mcp/
│   │   └── index.ts          # MCP server for Claude Code
│   ├── scheduler/
│   │   ├── index.ts          # Scheduler orchestration
│   │   ├── loader.ts         # Schedule file loading
│   │   ├── manager.ts        # Cron job management
│   │   ├── executor.ts       # Job execution
│   │   ├── notifier.ts       # Job notifications
│   │   ├── types.ts          # Scheduler interfaces
│   │   └── jobs/
│   │       ├── classify-memory.ts  # Entry classification
│   │       ├── organize-memory.ts  # Memory organization
│   │       └── nightly-memory.ts   # Combined 1 AM job
│   ├── reminders/
│   │   └── index.ts          # Reminder parsing & management
│   ├── queue/
│   │   ├── manager.ts        # Job queue management
│   │   └── worker.ts         # Queue worker
│   ├── voice/
│   │   ├── index.ts          # Voice service exports
│   │   └── types.ts          # Voice interfaces
│   ├── browser/
│   │   └── index.ts          # Browser automation
│   ├── search/
│   │   └── index.ts          # Hybrid search
│   ├── web/
│   │   └── server.ts         # Dashboard web server
│   └── utils/
│       ├── logger.ts         # Pino logger
│       └── chunker.ts        # Message chunking
├── data/
│   └── homer.db              # SQLite state + FTS5 index
├── dist/                     # Compiled JavaScript
├── profiles/                 # Browser profile storage
└── logs/                     # Application logs
```

## Memory System

### Centralized Structure

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

### Memory Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Session Level (Real-time)                        │
│                                                                      │
│  User Message → Claude Response → Auto-append significant events     │
│                                          │                           │
│                                          ▼                           │
│                              ~/memory/daily/YYYY-MM-DD.md            │
└─────────────────────────────────────────────────────────────────────┘
                                           │
                                           ▼ (1 AM nightly)
┌─────────────────────────────────────────────────────────────────────┐
│                  Nightly Memory Processing (1 AM)                    │
│                                                                      │
│  STEP 1: Classification                                              │
│  ├─ Read yesterday's daily log                                       │
│  ├─ Use Claude to classify each entry to target file(s)            │
│  ├─ Add <!-- classify: X.md --> tags to entries                     │
│  └─ Mark file with <!-- classified: YYYY-MM-DD HH:MM -->            │
│                                                                      │
│  STEP 2: Organization                                                │
│  ├─ Parse classification tags from daily log                        │
│  ├─ Route entries to 5 target files:                                │
│  │   • me.md (identity, goals, values)                              │
│  │   • work.md (projects, clients, meetings)                        │
│  │   • life.md (events, travel, relationships)                      │
│  │   • preferences.md (communication/technical prefs)               │
│  │   • tools.md (configs, APIs, setup notes)                        │
│  ├─ Deduplicate against existing content                            │
│  ├─ Add summary section to daily log                                │
│  ├─ Mark file with <!-- organized: YYYY-MM-DD HH:MM -->             │
│  └─ Re-index all files (FTS5)                                       │
└─────────────────────────────────────────────────────────────────────┘
                                           │
                                           ▼ (6 AM morning brief)
┌─────────────────────────────────────────────────────────────────────┐
│                     Morning Brief (6 AM)                             │
│                                                                      │
│  REQUIRED SECTIONS (always present):                                 │
│  1. Weather → Bellevue, WA forecast                                 │
│  2. Yesterday's Highlights → 3-5 bullets from daily log             │
│  3. Pending Follow-ups → Open items from memory                     │
│                                                                      │
│  ADDITIVE SECTIONS (supplement, never replace):                      │
│  4. News Headlines → Top USA + International                        │
│  5. Bookmark Insights → Twitter deep scrape via Bird CLI            │
│  6. Research Topics → Suggested areas to explore                    │
│  7. Build Ideas → Project suggestions                               │
│  8. Weekend Bonus → Hiking recommendations (Sat/Sun only)           │
│                                                                      │
│  End: "Should I promote any of yesterday's notes?"                   │
└─────────────────────────────────────────────────────────────────────┘
```

### Claude Code Skills

Skills are model-invoked capabilities stored in `~/.claude/skills/`:

```
~/.claude/skills/
├── nightly-memory/
│   └── SKILL.md      # 1 AM classification + organization
├── memory-classification/
│   └── SKILL.md      # Entry classification rules
├── morning-brief/
│   └── SKILL.md      # Morning briefing workflow
├── bird/
│   └── SKILL.md      # Twitter/X bookmark scraping
└── browser/
    └── SKILL.md      # Browser automation via CDP
```

Skills are referenced by scheduled jobs via `contextFiles` and executed by Claude CLI.

### Daily Log Format with Classification

```markdown
# 2026-01-29

### 09:15 [work]
<!-- classify: work.md -->
Discussed API design for memory persistence
- Decision: Use centralized ~/memory/ structure

### 14:35 [general]
<!-- classify: tools.md -->
Configured bird CLI for Chrome
- Config: ~/.config/bird/config.json5

### 18:00 [life]
<!-- classify: life.md, preferences.md -->
Booked Vancouver trip, prefer direct flights

### 23:30 [flush]
Session ending: work context, 12 messages, 45 min

<!-- classified: 2026-01-30 01:05 -->

## Summary
work: Implemented centralized memory system with MCP
life: Trip planning

<!-- organized: 2026-01-30 01:15 -->
```

### Auto-Append Triggers

During sessions, auto-append to daily log when:
- Significant decisions made
- Context that might matter tomorrow
- Blockers/issues encountered
- Task completions with outcomes
- Tool configs learned
- New preferences discovered

## MCP Server (`src/mcp/index.ts`)

Exposes memory, ideas, plans, and blob storage tools to Claude Code via Model Context Protocol.

### Memory Tools

| Tool | Description |
|------|-------------|
| `memory_search` | FTS5 full-text search across all memory |
| `memory_append` | Append entry to today's daily log |
| `memory_promote` | Promote fact to permanent file (me/work/life/preferences/tools) |
| `memory_read` | Read any memory file or daily log |
| `memory_reindex` | Rebuild FTS5 search index |
| `memory_suggestions` | Get promotion candidates from daily log |

### Ideas & Plans Tools

| Tool | Description |
|------|-------------|
| `idea_add` | Add new idea with source, title, content, context |
| `idea_update` | Update idea status (draft→review→planning→execution→archived) or add notes |
| `idea_list` | List ideas filtered by status |
| `plan_create` | Create plan from approved idea with phases |
| `plan_update` | Update plan status/phase, add feedback notes |
| `plan_list` | List all plans with current status |
| `feedback_log` | Log decisions (approve/reject/explore/comment) |

### Blob Storage Tools (Azure)

| Tool | Description |
|------|-------------|
| `blob_upload` | Upload local file to Azure Blob Storage |
| `blob_upload_content` | Upload text/buffer content directly |
| `blob_download` | Download blob to local filesystem |
| `blob_get_content` | Download blob content as text |
| `blob_list` | List blobs with optional prefix filter |
| `blob_delete` | Delete blob (requires confirm=true) |
| `blob_exists` | Check if blob exists |
| `blob_properties` | Get blob metadata and properties |

### Registration

In `~/.claude.json`:
```json
{
  "projects": {
    "/Users/yj": {
      "mcpServers": {
        "homer-memory": {
          "type": "stdio",
          "command": "node",
          "args": ["/Users/yj/homer/dist/mcp/index.js"]
        }
      }
    }
  }
}
```

## FTS5 Memory Indexer (`src/memory/indexer.ts`)

SQLite-based full-text search for memory files.

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  file_path,
  content,
  context,
  entry_date,
  tokenize='porter unicode61'
);

CREATE TABLE memory_index_meta (
  file_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  context TEXT NOT NULL
);
```

### Indexed Files

| File | Context | Nightly Route Target |
|------|---------|---------------------|
| `~/memory/me.md` | general | Identity, goals, values, ambitions |
| `~/memory/work.md` | work | Projects, clients, meetings, deadlines |
| `~/memory/life.md` | life | Events, travel, health, relationships |
| `~/memory/preferences.md` | general | Communication style, technical prefs |
| `~/memory/tools.md` | general | Tool configs, APIs, setup notes |
| `~/memory/daily/*.md` | general | Source logs (with entry_date) |

### Indexing Triggers

- On startup
- After nightly memory processing (1 AM)
- Manual via `memory_reindex` MCP tool
- Manual via `/index` Telegram command

## Context Detection (`src/context/detector.ts`)

```
Query: "fix the auth bug"
           │
           ▼
    ┌─────────────────┐
    │ Signal Matching │
    │ work: bug, fix  │  → score: 2
    │ life: (none)    │  → score: 0
    └────────┬────────┘
             │
             ▼
    ┌─────────────────┐
    │   Confidence    │
    │   2/8 = 0.25    │  → >= 0.2 threshold
    └────────┬────────┘
             │
             ▼
    Result: work context
    CWD: ~/work/
```

**Signal Categories:**

| Context | Signals (examples) | Weight |
|---------|-------------------|--------|
| Work | code, bug, deploy, api, git, meeting | 1.5-2 |
| Work | project-x (existing directory) | +3 |
| Life | health, family, finance, vacation | 1.5-2 |

## Scheduler (`src/scheduler/`)

```
Scheduled Job Flow:
┌──────────────────────────────────────────────────────────────┐
│                     schedule.json                              │
│  { "id": "daily-standup", "cron": "0 9 * * 1-5", ... }       │
└───────────────────────────┬──────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                     CronManager                                │
│  • Registers jobs with node-cron                              │
│  • Watches for schedule.json changes (hot reload)            │
│  • Emits job:trigger events                                   │
└───────────────────────────┬──────────────────────────────────┘
                            │
                            ▼
┌──────────────────────────────────────────────────────────────┐
│                     JobExecutor                                │
│  • Spawns Claude CLI                                          │
│  • Streams progress to Telegram                              │
│  • Records results in SQLite                                  │
└──────────────────────────────────────────────────────────────┘
```

### Built-in Jobs

| Schedule | Job ID | Timeout | Description |
|----------|--------|---------|-------------|
| `0 0 * * *` | learning-engine | 15 min | Analyze viral content patterns |
| `0 1 * * *` | nightly-memory | 15 min | Classify + organize daily log → 5 permanent files |
| `0 3 * * *` | moltbot-scan | 5 min | Check Moltbot for feature ideas |
| `0 4 * * *` | homer-improvements | 10 min | Self-analyze HOMER codebase |
| `0 6 * * *` | morning-brief | 10 min | Weather, highlights, follow-ups, news, bookmarks |
| `0 7 * * *` | daily-ideas-review | 5 min | Send draft ideas for Telegram review |
| `0 9 * * *` | planning-reminder | 5 min | Planning status and pending decisions |
| `0 */2 * * *` | ideas-explore | 10 min | Gather ideas from bookmarks & GitHub |

**Internal Jobs (non-scheduled):**
| Trigger | Job | Description |
|---------|-----|-------------|
| `* * * * *` | reminder-check | Check and fire due reminders |
| `0 * * * *` | session-cleanup | Clean expired sessions |
| `0 * * * *` | session-flush | Flush active sessions before timeout |

### Schedule File Locations

Jobs are loaded from multiple `schedule.json` files:

| Path | Default Lane |
|------|--------------|
| `~/work/schedule.json` | work |
| `~/life/schedule.json` | life |
| `~/memory/schedule.json` | default |

### Job Configuration Schema

```json
{
  "id": "morning-brief",
  "name": "Morning Brief",
  "cron": "0 6 * * *",
  "query": "Execute the morning-brief skill...",
  "lane": "default",
  "enabled": true,
  "timeout": 600000,
  "model": "sonnet",
  "contextFiles": [
    "~/.claude/skills/morning-brief/SKILL.md",
    "~/memory/me.md"
  ],
  "streamProgress": true,
  "notifyOnSuccess": true,
  "notifyOnFailure": true
}
```

## External Tools

The morning brief and other jobs use external CLI tools:

### Gemini CLI

```bash
# Weather
gemini "Weather forecast for Bellevue, WA today. Brief."

# News
gemini "Top 3 USA + 3 international headlines today."
```

Install: `brew install gemini-cli`

### Bird CLI

Twitter/X bookmark scraping with deep content extraction:

```bash
# Fetch bookmarks
bird bookmarks -n 6 --json

# Read single tweet/thread
bird read <tweet-id> --json
```

**Requirements:** Signed into x.com in Chrome (uses Chrome cookies)

Install: `brew install bird`

### Agent-Browser CLI

Browser automation via Chrome DevTools Protocol:

```bash
# Connect to running Chrome
agent-browser connect 9222

# Take snapshot with element refs
agent-browser snapshot -i

# Execute actions
agent-browser click @e25
agent-browser eval 'document.title'
```

**Setup:** Start Chrome with `--remote-debugging-port=9222`

## Session Flush (`src/memory/flush.ts`)

Pre-timeout flush saves important session context before expiration.

**Scoring Heuristics:**
| Signal | Score |
|--------|-------|
| 6+ messages | +1 |
| 12+ messages | +2 |
| 30+ min session | +1 |
| Created reminders/jobs | +1 |
| Recent flush (< 15 min) | -1 |

**Flush triggers if score ≥ 2** → writes to daily log with `[flush]` tag.

## State Management (`src/state/`)

**Database Schema (`homer.db`):**
```sql
-- Sessions (Telegram chat sessions - metadata only)
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  lane TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0
);

-- Claude session resume tokens (enables --resume flag)
CREATE TABLE executor_sessions (
  lane TEXT PRIMARY KEY,
  claude_session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

-- Job queue (pending/running Telegram requests)
CREATE TABLE job_queue (
  id TEXT PRIMARY KEY,
  lane TEXT NOT NULL,
  executor TEXT NOT NULL,
  query TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  chat_id INTEGER NOT NULL,
  message_id INTEGER,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  attempts INTEGER DEFAULT 0,
  error TEXT,
  result TEXT,
  locked_by TEXT DEFAULT NULL,      -- Worker ID for atomic job claiming
  locked_at INTEGER DEFAULT NULL,   -- Timestamp when job was claimed
  heartbeat_at INTEGER DEFAULT NULL -- Last heartbeat timestamp for liveness check
);

-- Scheduled job history
CREATE TABLE scheduled_job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  source_file TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  success INTEGER,
  output TEXT,
  error TEXT,
  exit_code INTEGER
);

-- Scheduled job state (enable/disable, failure tracking)
CREATE TABLE scheduled_job_state (
  job_id TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_run_at TEXT,
  last_success_at TEXT,
  consecutive_failures INTEGER DEFAULT 0
);

-- Reminders
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  due_at TEXT NOT NULL,
  context TEXT DEFAULT 'default',
  status TEXT DEFAULT 'pending'
);

-- Browser profiles for automation
CREATE TABLE browser_profiles (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  profile_path TEXT NOT NULL,
  auth_state TEXT DEFAULT 'none',
  headless_capable INTEGER DEFAULT 0,
  last_used_at INTEGER NOT NULL
);

-- FTS5 memory index
CREATE VIRTUAL TABLE memory_fts USING fts5(
  file_path, content, context, entry_date,
  tokenize='porter unicode61'
);
CREATE TABLE memory_index_meta (
  file_path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  context TEXT NOT NULL
);
```

## Conversation History

**Important:** Homer does NOT store conversation content. Only metadata and session IDs.

```
┌─────────────────────────────────────────────────────────────────────┐
│                     What Homer Stores                                │
│                                                                      │
│  • Session metadata (id, lane, timestamps, message_count)           │
│  • Claude session ID for --resume (executor_sessions table)         │
│  • Job outputs (scheduled_job_runs.output)                          │
│  • Daily log entries (~/memory/daily/*.md via memory_append)        │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                     What Claude CLI Stores                           │
│                                                                      │
│  • Full conversation transcripts (~/.claude/ or internal storage)   │
│  • Message history for --resume functionality                       │
│  • Tool call logs and results                                       │
└─────────────────────────────────────────────────────────────────────┘
```

**Session Resume Flow:**
1. User sends message via Telegram
2. Homer looks up `executor_sessions` for lane's `claude_session_id`
3. If found and not expired (< TTL), passes `--resume <session_id>` to Claude CLI
4. Claude CLI loads full conversation history from its own storage
5. Response includes new/same session_id → Homer updates `executor_sessions`

**TTL:** Sessions expire after `SESSION_TTL_HOURS` (default: 4 hours). After expiration, a fresh session starts.

## Data Retention

**Daily Logs (`~/memory/daily/*.md`):**
- **Never deleted** - persist indefinitely
- 1 AM job classifies entries (adds `<!-- classify: -->` tags)
- 1 AM job organizes into permanent files (adds `<!-- organized: -->` marker)
- Summary section appended after organization
- Idempotency: `<!-- classified: -->` and `<!-- organized: -->` markers prevent re-processing

**Database Tables:**
| Table | Retention |
|-------|-----------|
| `sessions` | Cleaned hourly (expired sessions removed) |
| `executor_sessions` | Overwritten per lane (latest session only) |
| `job_queue` | Jobs removed after completion |
| `scheduled_job_runs` | Persists indefinitely (history) |
| `reminders` | Removed after sent or cancelled |

## Timeout Configuration (`src/executors/claude.ts`)

Claude CLI execution timeouts:

```typescript
const DEFAULT_TIMEOUT = 1200_000; // 20 minutes

const SUBAGENT_TIMEOUTS: Record<string, number> = {
  gemini: 15 * 60 * 1000, // 15 minutes (research, UI work)
  codex: 20 * 60 * 1000,  // 20 minutes (deep reasoning, architecture)
};
```

| Mode | Timeout | Use Case |
|------|---------|----------|
| Default | 20 min | Standard Claude Code tasks |
| Gemini | 15 min | Research, front-end, exploration |
| Codex | 20 min | Backend design, debugging, architecture |

**Timeout Behavior:**
- If Claude CLI exceeds timeout → process killed, error logged
- Partial output captured (up to 2MB)
- Job marked as failed in `scheduled_job_runs`

**Per-Job Override:** Set `timeout` in schedule.json:
```json
{
  "id": "long-running-job",
  "timeout": 1800000,  // 30 minutes
  ...
}
```

## Claude CLI Flags (Daemon Mode)

Homer uses stream-json output and non-interactive flags when spawning Claude CLI:
- `--print`
- `--verbose`
- `--output-format stream-json`
- `--dangerously-skip-permissions`

See `src/executors/claude.ts` and `src/scheduler/executor.ts`.

## Bot Commands

| Command | Description |
|---------|-------------|
| `/status` | Show active sessions |
| `/jobs` | List scheduled jobs |
| `/trigger <id>` | Manually run a job |
| `/remind <time> <msg>` | Set reminder |
| `/reminders` | List pending reminders |
| `/cancel <id>` | Cancel reminder |
| `/search <query>` | FTS5 search across memory |
| `/index` | Re-index memory files |
| `/browse <url>` | Navigate and screenshot |
| `/snap` | Screenshot current page |
| `/act <action>` | Execute browser action |
| `/auth [profile]` | Start auth flow |
| `/profiles` | List browser profiles |

**Routing Prefixes:**
| Prefix | Behavior |
|--------|----------|
| (none) | Auto-detect context from query |
| `/new` | Fresh session, auto-detect context |
| `/g` | Delegate to Gemini subagent |
| `/x` | Delegate to Codex subagent |

## Configuration

**Environment Variables:**
```env
# Telegram
TELEGRAM_BOT_TOKEN=
ALLOWED_CHAT_ID=

# Session
SESSION_TTL_HOURS=4

# Paths
DATABASE_PATH=~/homer/data/homer.db
LOGS_PATH=~/homer/logs
BROWSER_PROFILES_PATH=~/homer/profiles
CLAUDE_PATH=~/.local/bin/claude

# Voice (optional)
OPENAI_API_KEY=
ELEVEN_LABS_API_KEY=
ELEVEN_LABS_VOICE_ID=

# Web dashboard
WEB_ENABLED=true
WEB_PORT=3000
```

## Health Endpoints

- `GET /health` → daemon uptime/status
- `GET /health/auth` → Claude CLI presence + Keychain item check (informational)

## 24/7 Daemon + Claude Code Auth

Claude CLI requires an OAuth token for authentication. Homer uses a **token file** approach for reliable daemon operation.

**Authentication Flow:**
1. Store OAuth token in `~/.homer-claude-token`
2. Executors read token file and set `CLAUDE_CODE_OAUTH_TOKEN` for spawned Claude CLI processes
3. Claude CLI authenticates using the provided token

**Setup:**
```bash
# Store your OAuth token (get from interactive Claude session)
echo 'sk-ant-oat01-YOUR-TOKEN' > ~/.homer-claude-token
chmod 600 ~/.homer-claude-token
```

**Why token file instead of Keychain:**
- Daemon processes often lack Keychain access due to macOS security restrictions
- Token file is reliable across restarts and doesn't depend on GUI session state
- Easy to refresh: just update the file and restart daemon

**Token refresh:** When jobs fail with "Invalid API key", run Claude interactively to get a new token, update the file, and restart the daemon.

**Reference doc:** `docs/DAEMON_AUTH.md`

## Deployment

**Local Development:**
```bash
npm run dev     # Watch mode with tsx
npm run mcp     # Run MCP server directly
npm run build   # Compile TypeScript
npm start       # Run compiled JS
```

**Production:**
```bash
npm run build
NODE_ENV=production npm start
```

## Daemon Reliability & Job Queue

### Flock-based Single Instance Lock (`src/daemon/lock.ts`)

Homer uses OS-level file locking (flock) to prevent duplicate daemon instances:

```typescript
// Lock file: ~/Library/Application Support/Homer/homer.lock
acquireDaemonLock() → flockSync(lockFd, "exnb")
```

**Features:**
- **Crash-safe:** OS automatically releases lock on process exit/crash
- **Atomic:** Kernel guarantees exclusive access
- **Non-blocking:** Second instance detects lock immediately and exits gracefully
- **Early acquisition:** Lock acquired BEFORE any initialization (port binding, DB, etc.)

**Deployment order:**
1. Acquire flock lock → exit if already locked
2. Initialize services (DB, scheduler, queue worker)
3. Bind web server port → exit if EADDRINUSE (secondary check)

### Job Queue Reliability (`src/queue/`, `src/state/`)

**Atomic Job Claiming:**
```sql
UPDATE job_queue SET
  status = 'running',
  locked_by = ?,
  locked_at = ?,
  heartbeat_at = ?,
  attempts = attempts + 1
WHERE id = (
  SELECT id FROM job_queue
  WHERE status = 'pending' AND lane = ?
  ORDER BY created_at LIMIT 1
)
RETURNING *
```

**Heartbeat Mechanism:**
- **Interval:** 10 seconds
- **Stale threshold:** 30 seconds (3x interval)
- **Error handling:** Try-catch prevents daemon crashes from DB errors
- **Automatic retry:** Heartbeat errors logged, retry on next interval

**Graceful Shutdown:**
```typescript
// On SIGTERM/SIGINT
registerShutdownTask(() => {
  stateManager.failAllRunningJobs(); // Mark in-flight jobs as failed
});
```

**Stale Job Recovery:**
- **On startup:** Recover jobs stuck in "running" state (heartbeat > 30s old)
- **Fast recovery:** 30-second threshold enables quick restart without job loss
- **Initial pump:** Worker checks for pending jobs immediately on start

**Event Listener Cleanup:**
```typescript
// Worker stores handler reference
this.jobReadyHandler = (job) => this.processJob(job);
this.queueManager.on("job:ready", this.jobReadyHandler);

stop() {
  this.queueManager.off("job:ready", this.jobReadyHandler); // Cleanup
}
```

**Critical Fixes (2026-01-31):**
1. ✅ Heartbeat error handling prevents daemon crashes
2. ✅ Graceful shutdown marks running jobs as failed
3. ✅ Event listener cleanup prevents memory leaks
4. ✅ Reduced stale threshold from 60s → 30s
5. ✅ Initial job pump processes pending jobs on startup

## Self-Healing Architecture

Homer implements a 3-layer supervision model with automatic recovery and human escalation.

### Supervision Layers

```
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 1: launchd (macOS)                                            │
│  • KeepAlive: true → auto-restart on crash                          │
│  • ThrottleInterval: 60 → prevent rapid restart loops               │
│  • StandardErrorPath/StandardOutPath → log persistence              │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 2: Watchdog Script (scripts/watchdog.sh)                      │
│  • Health checks every 15 seconds                                    │
│  • Stale lock cleanup (orphan child processes)                      │
│  • Port conflict detection                                           │
│  • Disk/memory monitoring                                            │
│  • Claude Code investigation after consecutive failures             │
│  • Daily fix limit → quarantine → human escalation                  │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 3: In-Process Handlers                                        │
│  • Uncaught exception handler → log to fatal.log                    │
│  • Unhandled rejection handler → log to fatal.log                   │
│  • Graceful shutdown (SIGTERM/SIGINT) → fail running jobs           │
│  • Process group killing (detached: true for subprocesses)          │
└─────────────────────────────────────────────────────────────────────┘
```

### Health Check Endpoint (`GET /health`)

```typescript
{
  status: "healthy" | "degraded" | "unhealthy",
  uptime: 12345,
  checks: {
    database: true,      // SELECT 1 connectivity
    dbIntegrity: true,   // PRAGMA quick_check (every 10th request)
    telegram: true,      // bot.api.getMe()
    memory: true,        // heap < 80% of 1.5GB
    disk: true           // > 10% free space
  },
  memory: { heapUsed, heapTotal, rss, external }
}
```

**Status Logic:**
- `healthy`: All checks pass
- `degraded`: Non-critical checks fail (telegram, memory)
- `unhealthy`: Critical checks fail (database, dbIntegrity, disk)

### Watchdog Escalation Flow

```
Health Check Failed
        │
        ▼
  Failures < 2? ──Yes──► Restart via launchd
        │
        No
        ▼
  Daily fixes < 5? ──Yes──► Trigger Claude Code investigation
        │                          │
        No                         ▼
        │                    Fix succeeded?
        ▼                    ├─Yes─► Reset failure count
  QUARANTINE                 └─No──► Increment fix count, retry
        │
        ▼
  dump_diagnostics()
        │
        ▼
  Telegram: "QUARANTINED - manual intervention required"
        │
        ▼
  macOS notification (backup)
        │
        ▼
  Sleep 5 min (reduce log spam)
```

### Daily Fix Limit

Prevents Claude Code investigation loops:

```bash
DAILY_FIX_LIMIT=5
FIX_COUNT_FILE="$STATE_DIR/fix-count-$(date +%Y%m%d)"

# Before triggering investigation:
if can_attempt_fix; then
  increment_fix_count
  trigger_investigation "$CONSECUTIVE_FAILURES"
else
  # QUARANTINE mode
  dump_diagnostics
  send_telegram "Homer QUARANTINED: ${DAILY_FIX_LIMIT} fix attempts exhausted"
fi
```

Counter resets daily. Prevents runaway auto-fix cycles.

### Diagnostic Dump

On quarantine, saves comprehensive crash dump to `~/Desktop/homer-dumps/`:

```
=== Homer Crash Dump 2026-02-01 14:30:00 ===

=== System ===
uptime, df -h, vm_stat

=== Processes ===
ps aux | grep -E "homer|claude|node"

=== Lock Status ===
lsof -n -- "$LOCK_FILE"

=== Health Endpoint ===
curl http://127.0.0.1:3000/health | jq

=== Recent Logs (last 100 lines) ===
tail -100 ~/homer/logs/stdout.log

=== Fatal Log ===
tail -50 ~/Library/Logs/homer/fatal.log

=== Watchdog State ===
cat ~/Library/Logs/homer/watchdog.state

=== Fix Attempts Today ===
3 / 5
```

### Emergency Disk Cleanup

Triggered when disk < 5% free:

```bash
emergency_disk_cleanup() {
  # Remove rotated logs
  rm -f "$HOMER_DIR/logs/"*.log.[0-9]*
  rm -f "$HOMER_DIR/logs/"*.log.*.bz2
  # Remove old claude temp files
  find /tmp -name "claude-*" -mtime +1 -delete
  # Keep only 5 most recent crash dumps
  ls -t ~/Desktop/homer-dumps/*.txt | tail -n +6 | xargs rm -f
}
```

### Telegram Diagnostic Commands

| Command | Description |
|---------|-------------|
| `/debug` | System status, memory, health checks, sessions, jobs |
| `/restart` | Trigger graceful restart (launchd respawns) |

**Example `/debug` output:**
```
Homer Debug
Uptime: 45m
Status: healthy
Memory: 128MB / 256MB
Sessions: 1
Jobs: 0 pending, 0 running

Checks:
database: ✓
dbIntegrity: ✓
telegram: ✓
memory: ✓
disk: ✓
```

### Webhook Cleanup on Startup

Prevents 409 conflicts after restart:

```typescript
// src/bot/index.ts - startBot()
await bot.api.deleteWebhook({ drop_pending_updates: false });
```

Called before `bot.start()` to clear any stale webhooks from previous instances.

### Log Rotation

Configured via newsyslog (`/etc/newsyslog.d/homer.conf`):

```
/Users/yj/homer/logs/stdout.log  yj:staff  640  7  1024  *  JB  /Users/yj/homer/logs/stdout.log.pid
/Users/yj/homer/logs/stderr.log  yj:staff  640  7  1024  *  JB
```

- Rotate at 1MB or weekly
- Keep 7 rotations
- Compress old logs (bzip2)

### Configuration Summary

| Setting | Default | Description |
|---------|---------|-------------|
| `INTERVAL` | 15s | Health check interval |
| `INVESTIGATE_AFTER` | 2 | Failures before Claude investigation |
| `DAILY_FIX_LIMIT` | 5 | Max fix attempts per day |
| `DISK_SPACE_MIN` | 10% | Alert threshold |
| `DISK_EMERGENCY_THRESHOLD` | 5% | Emergency cleanup threshold |
| `MEMORY_LIMIT_MB` | 1024 | Memory alert threshold |
| `RESTART_BACKOFF` | 30s | Wait after restart |

### Files

| File | Purpose |
|------|---------|
| `scripts/watchdog.sh` | External watchdog (runs via launchd) |
| `~/Library/Logs/homer/watchdog.log` | Watchdog logs |
| `~/Library/Logs/homer/watchdog.state` | Persistent state |
| `~/Library/Logs/homer/fix-count-YYYYMMDD` | Daily fix counter |
| `~/Library/Logs/homer/fatal.log` | Fatal error logs |
| `~/Desktop/homer-dumps/` | Crash dumps for human review |

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 6.6.0 | 2026-02-02 | Azure proxy architecture: Azure Static Web Apps + Azure Container Apps proxy (owendevstorage) hides Cloudflare tunnel from corporate networks |
| 6.5.0 | 2026-02-01 | Remote Desktop: Guacamole integration for VNC access via Web UI, Docker Compose stack, browser automation support |
| 6.4.0 | 2026-02-01 | Self-healing Phase 2: DB integrity checks, webhook cleanup, daily fix limit, diagnostic dumps, emergency disk cleanup, /debug & /restart commands |
| 6.3.1 | 2026-01-31 | Flock-based daemon lock, atomic job claiming, heartbeat reliability, graceful shutdown, 30s stale recovery |
| 6.3.0 | 2026-01-30 | Ideas/plans MCP tools, 8-job heartbeat system, Web UI with Cloudflare Access |
| 6.2.0 | 2026-01-29 | Nightly memory pipeline: 1 AM classification + organization, 5-file routing, morning brief required sections |
| 6.1.1 | 2026-01-28 | Increased timeouts (default 20min, codex 20min, gemini 15min), docs update |
| 6.1.0 | 2026-01-28 | Morning brief (6 AM), Skills integration, Gemini/Bird CLI |
| 6.0.0 | 2026-01 | Centralized memory, MCP server, daily logs |
| 5.0.0 | 2025-01 | Voice, Browser, Hybrid Search, Scheduler |
| 4.0.0 | 2024-12 | Multi-model routing |
| 3.0.0 | 2024-11 | Memory system |
| 2.0.0 | 2024-10 | Session management |
| 1.0.0 | 2024-09 | Initial release |
