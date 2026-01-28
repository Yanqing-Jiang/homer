# H.O.M.E.R Architecture

**H.O.M.E.R** - Hybrid Orchestration for Multi-model Execution and Routing

## Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Telegram Bot                                 │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │
│  │  Text    │ │  Voice   │ │ Commands │ │ Context  │ │ Sessions │  │
│  │ Handler  │ │ Handler  │ │ Handler  │ │ Detector │ │ Manager  │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘  │
└───────┼────────────┼────────────┼────────────┼────────────┼────────┘
        │            │            │            │            │
        ▼            ▼            ▼            ▼            ▼
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
│  │ Claude   │ │ OpenAI   │ │Eleven    │ │ Supabase │ │ Play-    │  │
│  │ CLI      │ │ Whisper  │ │Labs TTS  │ │ pgvector │ │ wright   │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Directory Structure

```
homer/
├── src/
│   ├── index.ts              # Entry point, bot initialization, cron jobs
│   ├── bot/
│   │   ├── index.ts          # Bot setup, command handlers
│   │   ├── streaming.ts      # Telegram message streaming
│   │   └── middleware/
│   │       └── auth.ts       # Chat authorization
│   ├── config/
│   │   └── index.ts          # Configuration management
│   ├── context/
│   │   └── detector.ts       # Auto context detection (work/life/general)
│   ├── router/
│   │   ├── prefix-router.ts  # Message routing with auto-detection
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
│   ├── scheduler/
│   │   ├── index.ts          # Scheduler orchestration
│   │   ├── loader.ts         # Schedule file loading
│   │   ├── manager.ts        # Cron job management
│   │   ├── executor.ts       # Job execution
│   │   ├── notifier.ts       # Job notifications
│   │   ├── types.ts          # Scheduler interfaces
│   │   └── jobs/
│   │       └── organize-memory.ts  # 3 AM memory organization
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
│   │   └── index.ts          # Hybrid vector + keyword search
│   ├── web/
│   │   └── server.ts         # Dashboard web server
│   └── utils/
│       ├── logger.ts         # Pino logger
│       └── chunker.ts        # Message chunking
├── data/
│   └── homer.db              # SQLite state database
├── profiles/                 # Browser profile storage
└── logs/                     # Application logs
```

## Core Components

### 1. Context Detection (`src/context/detector.ts`)

Automatically detects work/life/general context from query content.

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
| Work | code, bug, deploy, api, git, meeting, jira | 1.5-2 |
| Work | project-x (existing directory) | +3 |
| Work | ~/work/ path reference | +5 |
| Life | health, family, finance, vacation, doctor | 1.5-2 |
| Life | ~/life/ path reference | +5 |

### 2. Bot Layer (`src/bot/`)

Handles Telegram interactions via grammY framework.

**Commands:**
| Command | Description |
|---------|-------------|
| `/status` | Show active sessions |
| `/jobs` | List scheduled jobs |
| `/trigger <id>` | Manually run a job |
| `/remind <time> <msg>` | Set reminder |
| `/reminders` | List pending reminders |
| `/cancel <id>` | Cancel reminder |
| `/search <query>` | Hybrid search across memory |
| `/index` | Re-index memory files |
| `/browse <url>` | Navigate and screenshot |
| `/snap` | Screenshot current page |
| `/act <action>` | Execute browser action |
| `/auth [profile]` | Start auth flow |
| `/profiles` | List browser profiles |

**Routing (Auto-Detected):**
| Prefix | Behavior |
|--------|----------|
| (none) | Auto-detect context from query |
| `/new` | Fresh session, auto-detect context |
| `/g` | Delegate to Gemini subagent |
| `/x` | Delegate to Codex subagent |

### 3. Memory System (`src/memory/`)

```
Memory Architecture:
┌─────────────────────────────────────────────────────────────────────┐
│                        During Conversation                           │
│                                                                      │
│  Claude Response                                                     │
│       │                                                              │
│       ▼                                                              │
│  <memory-update> tags  ───────▶  ~/memory/2025-01-28.md             │
│                                  (daily log, tagged by context)      │
└─────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼ (3 AM)
┌─────────────────────────────────────────────────────────────────────┐
│                      Memory Organization Job                         │
│                                                                      │
│  Read yesterday's log  ─┬─▶  Work entries   → ~/work/memory.md      │
│                         ├─▶  Life entries   → ~/life/memory.md      │
│                         └─▶  General        → ~/memory/facts.md     │
│                                                                      │
│  • Summarize related entries                                         │
│  • Deduplicate against existing memory                              │
│  • Add summary section to daily log                                  │
│  • Re-index all files (FTS5)                                        │
└─────────────────────────────────────────────────────────────────────┘
```

**Memory File Hierarchy:**
```
~/
├── memory/                    # Global memory
│   ├── 2025-01-28.md         # Today's daily log
│   ├── 2025-01-27.md         # Yesterday (organized)
│   ├── user.md               # User identity
│   ├── facts.md              # Organized facts
│   └── preferences.md        # User preferences
├── work/
│   └── memory.md             # Work context (organized)
└── life/
    └── memory.md             # Life context (organized)
```

**Daily Log Format:**
```markdown
# 2025-01-28

### 09:15 [work]
- Discussed API design for memory persistence
- Decision: Use append-only daily logs

### 14:35 [life]
- Set reminder for dentist appointment
- Note: prefer morning appointments

### 23:30 [flush]
- Session ending: work context, 12 messages, 45 min

## Summary
work: Implemented memory persistence system
life: Scheduled dentist appointment
```

### 4. Session Flush (`src/memory/flush.ts`)

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

### 5. FTS5 Memory Indexer (`src/memory/indexer.ts`)

SQLite-based full-text search for memory files.

```sql
CREATE VIRTUAL TABLE memory_fts USING fts5(
  file_path,
  content,
  context,
  entry_date,
  tokenize='porter unicode61'
);
```

**Indexing Triggers:**
- On startup
- After memory organization (3 AM)
- Manual via `/index` command

### 6. Scheduler (`src/scheduler/`)

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

**Schedule Locations:**
- `~/work/schedule.json` (work lane)
- `~/life/schedule.json` (life lane)
- `~/memory/schedule.json` (default lane)

### 7. Periodic Jobs

| Schedule | Job | Source |
|----------|-----|--------|
| `* * * * *` | Reminder checker | `src/index.ts` |
| `0 * * * *` | Session cleanup | `src/index.ts` |
| `0 * * * *` | Session flush | `src/memory/flush.ts` |
| `0 3 * * *` | Memory organization | `src/scheduler/jobs/organize-memory.ts` |

### 8. Voice Service (`src/voice/`)

```
Voice Message Flow:
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│ Telegram│───▶│ Download│───▶│ Whisper │───▶│ Claude  │───▶│Eleven   │
│  Voice  │    │   OGG   │    │   STT   │    │ Process │    │Labs TTS │
└─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘
                                                                  │
                                                                  ▼
                                                           ┌─────────┐
                                                           │ Voice   │
                                                           │ Reply   │
                                                           └─────────┘
```

### 9. Browser Service (`src/browser/`)

```
Browser Architecture:
┌────────────────────────────────────────────────────────────┐
│                    BrowserManager                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Profiles   │  │   Contexts   │  │   Actions    │     │
│  │   (SQLite)   │  │ (Playwright) │  │   Parser     │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
└────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────┐
│                    Profile Storage                          │
│  ~/homer/profiles/{profile-name}/                          │
│  ├── Default/                   # Chromium user data       │
│  ├── Cookies                    # Persistent cookies       │
│  └── Local Storage/             # Site data                │
└────────────────────────────────────────────────────────────┘
```

### 10. Search Service (`src/search/`)

```
Hybrid Search Flow:
┌─────────┐
│  Query  │
└────┬────┘
     │
     ▼
┌─────────────────────────────────────────┐
│           Parallel Execution             │
│  ┌─────────────┐    ┌─────────────┐     │
│  │   Vector    │    │   Keyword   │     │
│  │   Search    │    │   Search    │     │
│  │  (pgvector) │    │  (pg_trgm)  │     │
│  └──────┬──────┘    └──────┬──────┘     │
│         │                  │            │
│         ▼                  ▼            │
│  ┌─────────────────────────────────┐    │
│  │     Reciprocal Rank Fusion      │    │
│  │     weight: 0.7 vec + 0.3 kw    │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
     │
     ▼
┌─────────┐
│ Results │
└─────────┘
```

**Fallback:** FTS5 local search when Supabase unavailable.

## State Management (`src/state/`)

**Database Schema:**
```sql
-- Sessions
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  lane TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  message_count INTEGER DEFAULT 0
);

-- Claude session resume tokens
CREATE TABLE executor_sessions (
  lane TEXT PRIMARY KEY,
  claude_session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);

-- Scheduled job history
CREATE TABLE scheduled_job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  success INTEGER,
  output TEXT,
  error TEXT
);

-- Reminders
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  message TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT DEFAULT 'pending'
);

-- FTS5 memory index
CREATE VIRTUAL TABLE memory_fts USING fts5(...);
```

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

# Voice (optional)
OPENAI_API_KEY=
ELEVEN_LABS_API_KEY=
ELEVEN_LABS_VOICE_ID=

# Search (optional)
SUPABASE_URL=
SUPABASE_ANON_KEY=

# Web dashboard
WEB_ENABLED=true
WEB_PORT=3000
```

## Data Flow Examples

### Text Message with Auto-Detection
```
User sends "fix the auth bug"
    │
    ▼
Context detector: work signals (bug, fix)
    │
    ▼
CWD: ~/work/, Context: work
    │
    ▼
Load memory (global + ~/work/memory.md)
    │
    ▼
Execute Claude with message + memory
    │
    ▼
Process <memory-update> → daily log
    │
    ▼
Send response to Telegram
```

### Memory Organization (3 AM)
```
Read ~/memory/2025-01-27.md
    │
    ▼
Group entries: work(5), life(2), general(1)
    │
    ▼
For each group:
  → Claude: summarize & deduplicate
  → Append to ~/work/memory.md etc.
    │
    ▼
Add summary section to daily log
    │
    ▼
Re-index all memory files (FTS5)
```

## Deployment

**Local Development:**
```bash
npm run dev     # Watch mode with tsx
npm run build   # Compile TypeScript
npm start       # Run compiled JS
```

**Production:**
```bash
npm run build
NODE_ENV=production npm start
```

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 6.0.0 | 2025-01 | Phase 6: Memory Persistence, Auto Context Detection |
| 5.0.0 | 2025-01 | Phase 5: Voice, Browser, Hybrid Search, Scheduler |
| 4.0.0 | 2024-12 | Multi-model routing |
| 3.0.0 | 2024-11 | Memory system |
| 2.0.0 | 2024-10 | Session management |
| 1.0.0 | 2024-09 | Initial release |
