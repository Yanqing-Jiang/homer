# H.O.M.E.R Feature Status

**Version:** 4.0.0
**Last Updated:** 2026-01-27

---

**Daemon Auth:** See `docs/DAEMON_AUTH.md` for LaunchAgent + Claude Code keychain guidance.

## Phase 4 Completed Features

| Feature | Status | Description |
|---------|--------|-------------|
| Composite Session Keys | ✅ Done | `/work homer` and `/work other` have separate Claude sessions |
| Memory Write-Back | ✅ Done | `<memory-update>` tags parsed and written to memory files |
| Weather Integration | ✅ Refactored | Changed from WeatherAPI.com to Gemini prompt generators |
| Project Context Loading | ✅ Done | Loads `{cwd}/.claude/CLAUDE.md` for project-specific instructions |
| Reminders System | ✅ Done | `/remind`, `/reminders`, `/cancel` commands with chrono-node |
| Scheduled Jobs Dashboard | ✅ Done | API endpoints + HTMX dashboard with trigger buttons |
| Subagent Timeouts | ✅ Done | Gemini: 10min, Codex: 15min |

---

## Features Needing Polish

| Feature | Issue | Priority | Recommendation |
|---------|-------|----------|----------------|
| Weather Not Connected | `getWeatherPrompt()` exists but never called | High | Integrate into morning briefing or create `/weather` command |
| Duplicate Time Formatters | 3 separate `formatRelativeTime` functions | Medium | Consolidate into `src/utils/time.ts` |
| Hardcoded Paths | `/Users/yj/` throughout codebase | Medium | Use `process.env.HOME` or config variable |
| Reminder Context Unused | Stores `context` but always uses "default" | Low | Use current routing context |
| No .env.example | Missing documentation for env vars | Medium | Create `.env.example` |
| punycode Warning | Node.js deprecation warning | Low | Update dependencies |
| Legacy Lane References | Unused lanes in types | Low | Clean up `LaneId` type |
| Auth Health Check | Add `/health/auth` endpoint | ✅ Done | See `docs/DAEMON_AUTH.md` |

---

## Features Not Yet Implemented

| Feature | Phase | Status | Notes |
|---------|-------|--------|-------|
| MCP Installation | 4.6 | ❌ Pending | NotebookLM + Supabase MCP config |
| Web Navigation | Research | ❌ Pending | Browser automation with saved sessions |
| Supabase Backup | 4.6 | ❌ Pending | Long-term memory backup |
| API Key Auth | Stability | ❌ Pending | `ANTHROPIC_API_KEY` for daemon mode |

---

## Stability Improvements Needed

Based on long-running daemon research:

| Item | Current State | Priority | Recommendation |
|------|---------------|----------|----------------|
| API Key Auth | OAuth only | High | Add `ANTHROPIC_API_KEY` support |
| Retry Logic | Basic error handling | High | Exponential backoff wrapper |
| Rate Limiting | None | Medium | Implement request queue |
| Health Checks | None | Medium | Add periodic health cron |
| Process Supervision | Manual | Medium | Create launchd plist |
| Max Turns | Not set | Low | Add `--max-turns` flag |
| Failure Alerting | None | Low | Telegram alerts on failures |

---

## Planned Features (Future)

| Feature | Priority | Description |
|---------|----------|-------------|
| Browser Automation | High | NotebookLM, Gmail with saved sessions |
| Vector Search | Medium | pgvector for semantic memory search |
| Multi-Model Routing | Medium | Smart routing between Claude/Gemini/Codex |
| Voice Interface | Low | Telegram voice → transcription |
| Calendar Integration | Medium | Google Calendar sync |

---

## Immediate Action Items

### Must Fix
1. [ ] Connect weather prompts to actual usage
2. [ ] Complete MCP setup (NotebookLM config)

### Should Fix
3. [ ] Consolidate time formatting utilities
4. [ ] Add `.env.example` file
5. [ ] Clean up hardcoded paths
6. [ ] Add launchd plist for auto-restart

### Nice to Have
7. [ ] Retry wrapper with exponential backoff
8. [ ] Request queue with rate limiting
9. [ ] Health check endpoint
10. [ ] Unit tests for parser.ts and writer.ts

---

## File Structure

```
~/homer/
├── src/
│   ├── bot/              # Telegram bot handlers
│   ├── config/           # Zod configuration
│   ├── executors/        # Claude CLI executor
│   ├── integrations/     # Weather (Gemini prompts)
│   ├── memory/           # Loader + writer
│   ├── queue/            # Job queue management
│   ├── reminders/        # Reminder system
│   ├── router/           # Prefix routing
│   ├── scheduler/        # Cron job scheduler
│   ├── state/            # SQLite state manager
│   ├── tui/              # Terminal UI
│   ├── utils/            # Logger, chunker
│   └── web/              # Fastify dashboard
├── docs/
│   ├── GEMINI_AGENT.md   # Gemini optimization guide
│   ├── CODEX_AGENT.md    # Codex optimization guide
│   └── FEATURE_STATUS.md # This file
├── data/
│   └── homer.db          # SQLite database
└── logs/
    └── stdout.log        # Application logs
```

---

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Show help |
| `/status` | Active sessions and job stats |
| `/work [project]` | Switch to work context |
| `/life [area]` | Switch to life context |
| `/new` | Start fresh session |
| `/g <query>` | Use Gemini subagent |
| `/x <query>` | Use Codex subagent |
| `/jobs` | List scheduled jobs |
| `/trigger <id>` | Manually run a job |
| `/remind <time> <msg>` | Set reminder |
| `/reminders` | List pending reminders |
| `/cancel <id>` | Cancel reminder |

---

## Configuration

Required environment variables:
```bash
TELEGRAM_BOT_TOKEN=xxx
ALLOWED_CHAT_ID=xxx
```

Optional:
```bash
SESSION_TTL_HOURS=4
LOG_LEVEL=info
WEATHER_LOCATION=Bellevue,WA
WEB_ENABLED=true
WEB_PORT=3000
```
