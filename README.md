# H.O.M.E.R

**Hybrid Orchestration for Multi-model Execution and Routing**

A personal AI assistant daemon that routes queries through Claude Code with context-aware sessions, scheduled jobs, and multi-model subagent support.

## Features

- **Context-Aware Sessions**: Separate sessions for work/life contexts with project isolation
- **Multi-Model Routing**: Route to Gemini (research/UI) or Codex (architecture/debugging)
- **Memory System**: Persistent memory with auto-write-back from responses
- **Scheduled Jobs**: Cron-based jobs with hot reload and dashboard
- **Reminders**: Natural language reminders with chrono-node parsing
- **Web Dashboard**: Real-time monitoring with HTMX

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

## Architecture

```
Telegram Bot
     │
     ▼
┌─────────────────┐
│  Prefix Router  │ ── Parses /work, /life, /g, /x, etc.
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Memory Loader   │ ── Loads context + project CLAUDE.md
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Claude Executor │ ── Spawns Claude CLI with session resume
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Memory Writer   │ ── Parses <memory-update> tags
└────────┬────────┘
         │
         ▼
   Response to User
```

## Subagents

### Gemini (`/g`)
- **Timeout**: 10 minutes
- **Use for**: Research, UI/UX, real-time info, web search
- **Docs**: [docs/GEMINI_AGENT.md](docs/GEMINI_AGENT.md)

### Codex (`/x`)
- **Timeout**: 15 minutes
- **Model**: gpt-5.2-codex @ xHigh reasoning
- **Use for**: Architecture, debugging, complex algorithms
- **Docs**: [docs/CODEX_AGENT.md](docs/CODEX_AGENT.md)

## Memory System

### Write-Back
Claude can update memory files using tags:
```
<memory-update>
- User prefers TypeScript over JavaScript
</memory-update>
```

### Memory Locations
- `~/memory/facts.md` - Global facts
- `~/memory/preferences.md` - Global preferences
- `~/work/memory.md` - Work-specific notes
- `~/life/memory.md` - Life-specific notes
- `{project}/.claude/CLAUDE.md` - Project instructions

## Scheduled Jobs

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
| `WEATHER_LOCATION` | No | Bellevue,WA | Default weather location |
| `WEB_ENABLED` | No | true | Enable web dashboard |
| `WEB_PORT` | No | 3000 | Dashboard port |

## Web Dashboard

Access at `http://localhost:3000` when running. Features:
- Active sessions overview
- Job queue status
- Scheduled jobs with manual trigger
- Live log streaming

## Development

```bash
# Type checking
npm run typecheck

# Run TUI dashboard
npm run tui

# Development with hot reload
npm run dev
```

## Status

See [docs/FEATURE_STATUS.md](docs/FEATURE_STATUS.md) for current implementation status.

## License

MIT
