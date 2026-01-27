# H.O.M.E.R Phase 5 Implementation Plan

**Version:** 5.1.0
**Last Updated:** 2026-01-27
**Based on:** Moltbot architecture patterns + Direct Executor model

---

## Architecture Decision (Finalized)

### Core Principle: Direct to Claude Executor

```
┌─────────────────────────────────────────────────────────────────┐
│                    H.O.M.E.R v5 Architecture                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Message → Claude Executor (Opus) → Response                    │
│                  ↓                                              │
│            CLAUDE.md instructs:                                 │
│            • Spin up Haiku sub-agent for memory search          │
│            • Avoid loading full context (prevent blowup)        │
│            • Use grep/read selectively                          │
│                                                                 │
│  Continuing Session:                                            │
│  Message → Claude Executor (--resume SESSION_ID)                │
│            • No extra context loading                           │
│            • Session continuity preserved                       │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Why This Approach

| Alternative | Decision | Reason |
|-------------|----------|--------|
| Haiku triage layer | ❌ Rejected | Extra latency, Claude can self-manage |
| Separate search layer | ❌ Rejected | Claude can grep itself |
| Direct to Opus | ✅ Chosen | Simpler, Claude is smart enough |
| Haiku as sub-agent | ✅ Chosen | For memory search to avoid context blowup |

### Key Files

**Main instruction file:** `~/homer/CLAUDE.md` (or project-level `.claude/CLAUDE.md`)

```markdown
# H.O.M.E.R Assistant Instructions

## Memory Search Protocol
When you need context from memory files, spawn a Haiku sub-agent to search:
- Use Task tool with model: "haiku" to search memory files
- Only retrieve relevant snippets, not full files
- Available memory locations:
  - ~/memory/ (global facts, preferences)
  - ~/work/ (work projects)
  - ~/life/ (personal notes)

## Context Management
- Do NOT load all memory files upfront
- Search selectively based on query intent
- Keep context focused to avoid blowup
```

---

## Current Daemon Status: ✅ WORKING (Phase 4 Complete)

Verified components in `src/index.ts`:
- ✅ Telegram bot (Grammy)
- ✅ SQLite state manager
- ✅ Queue manager + worker
- ✅ Scheduler with cron jobs (reminders, cleanup)
- ✅ Web dashboard (Fastify)
- ✅ Graceful shutdown (SIGINT/SIGTERM)
- ✅ Session management with TTL

---

## Overview

Adapt Moltbot's patterns to H.O.M.E.R's existing architecture:
- **Browser**: Playwright + CDP with persistent sessions
- **Voice**: Whisper STT + ElevenLabs TTS via Telegram
- **Prompts**: Main CLAUDE.md with sub-agent instructions
- **Local Search**: Claude spawns Haiku for selective grep, evolve to pgvector
- **Calendar/Gmail**: Google APIs (not browser automation)

---

## Phase 5.1: CLAUDE.md Instruction System

**Goal:** Main instruction file that tells Claude how to manage context and spawn sub-agents

### File Structure
```
~/homer/CLAUDE.md              # Global instructions for H.O.M.E.R
~/work/{project}/.claude/CLAUDE.md  # Project-specific instructions
```

### Main CLAUDE.md Content
```markdown
# H.O.M.E.R Assistant

You are H.O.M.E.R (Hybrid Orchestration for Multi-model Execution and Routing).

## Memory Search Protocol
When you need historical context or facts:
1. Use the Task tool with subagent_type="Explore" and model="haiku"
2. Have Haiku search memory files with grep
3. Only load relevant snippets into your context

Available memory locations:
- ~/memory/facts.md - Global facts
- ~/memory/preferences.md - User preferences
- ~/work/memory.md - Work notes
- ~/life/memory.md - Personal notes

## Sub-Agent Routing
- Research/web search → Gemini (/g prefix)
- Architecture/debugging → Codex (/x prefix)
- Memory search → Haiku (spawn as needed)

## Session Continuity
- Sessions persist for 4 hours
- Use --resume to continue conversations
- Don't reload context on follow-ups
```

### Files to Modify
| File | Action |
|------|--------|
| `src/memory/loader.ts` | Modify - Load CLAUDE.md on new sessions |
| `src/executors/claude.ts` | Verify - Passes CLAUDE.md to executor |

### Integration Point
Modify `loadBootstrapFiles()` in `src/memory/loader.ts:63-103`

---

## Phase 5.2: Voice Interface

**Goal:** Telegram voice messages → STT → Claude → TTS response

### Architecture (Moltbot-style)
```
[Voice Message] → [Download OGG] → [Whisper STT] → [Transcript]
                                                        ↓
[Voice Reply] ← [ElevenLabs TTS] ← [Response] ← [Claude Executor]
```

### Files to Create/Modify
| File | Action |
|------|--------|
| `src/voice/stt.ts` | Create - OpenAI Whisper integration |
| `src/voice/tts.ts` | Create - ElevenLabs integration (eleven_multilingual_v2) |
| `src/voice/types.ts` | Create - Interfaces |
| `src/bot/index.ts` | Modify - Add `bot.on("message:voice")` handler |
| `src/config/index.ts` | Modify - Add voice config |
| `.env.example` | Modify - Add `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |

### Grammy Integration
```typescript
bot.on("message:voice", async (ctx) => {
  const file = await ctx.getFile();
  const audioBuffer = await downloadFile(file);
  const transcript = await stt.transcribe(audioBuffer, "audio/ogg");

  // Process as normal text message
  const response = await handleExecution(ctx, transcript, ...);

  // Optionally respond with voice
  if (config.voice.ttsEnabled) {
    const audio = await tts.synthesize(response);
    await ctx.replyWithVoice(new InputFile(audio));
  }
});
```

### Dependencies
```json
"openai": "^4.x",
"elevenlabs": "^0.x"
```

---

## Phase 5.3: Local Search (Simple)

**Goal:** Memory file search with grep/glob for `/search` command

### Files to Create/Modify
| File | Action |
|------|--------|
| `src/search/simple.ts` | Create - File-based regex search |
| `src/search/types.ts` | Create - SearchResult interface |
| `src/bot/index.ts` | Modify - Add `/search <query>` command |

### Command
```
/search <query>  →  Search ~/memory, ~/work, ~/life for matches
                    Returns: file path + line number + context
```

### Optional: Auto-include in Context
```typescript
// In handleExecution(), optionally auto-include relevant memories:
const relevant = await searchMemoryFiles(query, { maxResults: 3 });
memoryContext += formatRelevantMemories(relevant);
```

---

## Phase 5.4: Google Calendar API

**Goal:** OAuth2 + event CRUD + push notifications

### Files to Create/Modify
| File | Action |
|------|--------|
| `src/integrations/google/auth.ts` | Create - OAuth2Client wrapper |
| `src/integrations/google/calendar.ts` | Create - Calendar API methods |
| `src/integrations/google/types.ts` | Create - Interfaces |
| `src/bot/index.ts` | Modify - Add `/cal` commands |
| `src/web/routes.ts` | Modify - Add `/webhooks/calendar` |
| `src/state/manager.ts` | Modify - Add `google_tokens` table |

### Commands
```
/cal today       →  List today's events
/cal next        →  List next 5 upcoming events
/cal add <spec>  →  Create event (parse with chrono-node)
```

### Database Schema
```sql
CREATE TABLE google_tokens (
  user_id TEXT PRIMARY KEY,
  access_token TEXT,
  refresh_token TEXT,
  expires_at INTEGER,
  scope TEXT
);
```

### Push Notifications
- Setup `calendar.events.watch()` pointing to `/webhooks/calendar`
- Renew watch every 7 days via cron

### Dependencies
```json
"googleapis": "^140.x"
```

---

## Phase 5.5: Gmail API

**Goal:** OAuth2 (shared) + Pub/Sub for real-time notifications

### Files to Create/Modify
| File | Action |
|------|--------|
| `src/integrations/google/gmail.ts` | Create - Gmail API methods |
| `src/integrations/google/pubsub.ts` | Create - Pub/Sub handler |
| `src/bot/index.ts` | Modify - Add `/mail` commands |
| `src/web/routes.ts` | Modify - Add `/webhooks/gmail` |
| `src/state/manager.ts` | Modify - Add `gmail_state` table (historyId tracking) |

### Commands
```
/mail inbox           →  List recent unread (10)
/mail search <query>  →  Search emails
/mail read <id>       →  Read specific email
```

### Pub/Sub Flow
```
Gmail Change → Pub/Sub Topic → Push to /webhooks/gmail → Fetch history → Notify user
```

### Database Schema
```sql
CREATE TABLE gmail_state (
  user_id TEXT PRIMARY KEY,
  history_id TEXT,
  watch_expiration INTEGER
);
```

---

## Phase 5.6: Browser Automation

**Goal:** Playwright + CDP with persistent sessions (Moltbot-style)

### Architecture
```
[/browse URL] → [Playwright Page] → [Screenshot + A11y Tree] → [Telegram]
[/act click 12] → [Find element by ref] → [Execute action] → [New snapshot]
```

### Files to Create/Modify
| File | Action |
|------|--------|
| `src/browser/manager.ts` | Create - Browser lifecycle, session persistence |
| `src/browser/actions.ts` | Create - Click, type, scroll, navigate |
| `src/browser/snapshot.ts` | Create - Screenshot + accessibility tree with refs |
| `src/browser/types.ts` | Create - Interfaces |
| `src/bot/index.ts` | Modify - Add `/browse`, `/snap`, `/act` commands |
| `src/state/manager.ts` | Modify - Add `browser_sessions` table |

### Commands
```
/browse <url>     →  Navigate, take snapshot, return screenshot + element refs
/snap             →  Take snapshot of current page
/act <action>     →  Execute action: click 12, type 5 "hello", scroll down
```

### Session Persistence (Moltbot-style)
- User data directory per profile: `~/.homer/browser-profiles/<name>/`
- Cookies and localStorage persist across restarts
- Store metadata in SQLite

### Database Schema
```sql
CREATE TABLE browser_sessions (
  id TEXT PRIMARY KEY,
  name TEXT,
  user_data_dir TEXT,
  last_used_at TEXT
);
```

### Dependencies
```json
"playwright": "^1.x"
```

### Initial Use Case: NotebookLM
```typescript
// Pre-configured workflow
await browser.loadSession("google-auth");
await page.goto("https://notebooklm.google.com/");
```

---

## Phase 5.7: Local Search (Advanced)

**Goal:** Upgrade to pgvector + OpenAI embeddings with hybrid search

### Architecture (Moltbot-style hybrid)
```
Query → [Embed with OpenAI] → [pgvector similarity search (0.7 weight)]
     → [Keyword/BM25 search (0.3 weight)]
     → [Reciprocal Rank Fusion] → Results
```

### Files to Create/Modify
| File | Action |
|------|--------|
| `src/search/embeddings.ts` | Create - OpenAI text-embedding-3-small |
| `src/search/vector.ts` | Create - pgvector operations |
| `src/search/hybrid.ts` | Create - RRF combination |
| `src/search/indexer.ts` | Create - Auto-index memory files on change |
| `src/config/index.ts` | Modify - Add `search.mode`, `search.pgConnectionString` |

### Database Schema (PostgreSQL)
```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_embeddings (
  id TEXT PRIMARY KEY,
  file_path TEXT,
  chunk_index INTEGER,
  content TEXT,
  embedding vector(1536),
  metadata JSONB,
  indexed_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(file_path, chunk_index)
);

CREATE INDEX ON memory_embeddings
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### Configuration
```typescript
search: {
  mode: "simple" | "vector" | "hybrid",  // Start simple, upgrade later
  pgConnectionString: "postgres://...",
  openaiApiKey: "...",
  vectorWeight: 0.7,
  keywordWeight: 0.3,
  autoIndex: true,
  watchPaths: ["~/memory", "~/work", "~/life"]
}
```

### Dependencies
```json
"pg": "^8.x",
"pgvector": "^0.x"
```

---

## Implementation Order

```
Week 1: 5.1 (Prompts) + 5.3 (Simple Search)
        └── No external dependencies, foundation work

Week 2: 5.2 (Voice)
        └── Requires OpenAI + ElevenLabs API keys

Week 3: 5.4 (Calendar) + 5.5 (Gmail)
        └── Requires Google Cloud Project setup

Week 4: 5.6 (Browser)
        └── Can reuse Google auth from 5.4/5.5

Week 5: 5.7 (Advanced Search)
        └── Requires PostgreSQL + pgvector setup
```

---

## Critical Files to Modify

| File | Phases | Changes |
|------|--------|---------|
| `src/bot/index.ts` | All | New commands, voice handler |
| `src/memory/loader.ts` | 5.1 | Bootstrap injection |
| `src/state/manager.ts` | 5.4-5.7 | New tables |
| `src/config/index.ts` | All | New config sections |
| `src/web/routes.ts` | 5.4, 5.5 | Webhook endpoints |

---

## Verification Plan

### Phase 5.1: Prompt Injection
- Create test bootstrap files in `~/homer/bootstrap/`
- Send message, verify bootstrap content appears in Claude context
- Test with subagent (/g), verify only AGENTS.md + TOOLS.md injected

### Phase 5.2: Voice
- Send voice message in Telegram
- Verify transcription appears in response
- Test TTS response (if enabled)

### Phase 5.3: Simple Search
- Add test content to memory files
- Run `/search <keyword>`, verify results
- Test with no matches

### Phase 5.4: Calendar
- Complete OAuth flow
- `/cal today` returns events
- Create event with `/cal add tomorrow 2pm meeting`
- Verify webhook receives notifications

### Phase 5.5: Gmail
- `/mail inbox` returns unread emails
- `/mail search from:someone` works
- Pub/Sub notification triggers on new email

### Phase 5.6: Browser
- `/browse https://example.com` returns screenshot + refs
- `/act click 1` executes action
- Session persists across bot restarts

### Phase 5.7: Advanced Search
- Index memory files
- `/search` returns semantically relevant results
- Hybrid search outperforms simple grep

---

## Environment Variables (New)

```bash
# Voice (5.2)
OPENAI_API_KEY=sk-...
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=pMsXgVXv3BLzUgSXRplE

# Google (5.4, 5.5)
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/google/callback
GMAIL_PUBSUB_TOPIC=projects/xxx/topics/gmail-notifications

# Advanced Search (5.7)
POSTGRES_URL=postgres://user:pass@localhost:5432/homer
```

---

## Sources

- [Moltbot Browser Docs](https://docs.molt.bot/tools/browser)
- [Moltbot Voice Wake](https://docs.molt.bot/platforms/mac/voicewake)
- [Moltbot Memory System](https://docs.molt.bot/concepts/memory)
- [Moltbot Skills](https://docs.molt.bot/tools/skills)
- [Google Calendar API](https://developers.google.com/calendar/api)
- [Gmail Push Notifications](https://developers.google.com/gmail/api/guides/push)
- [pgvector Guide](https://www.instaclustr.com/education/vector-database/pgvector-key-features-tutorial-and-pros-and-cons-2026-guide/)
