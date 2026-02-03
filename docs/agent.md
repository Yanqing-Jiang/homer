# Codex Agent Instructions

Deep reasoning specialist powered by OpenAI Codex via Claude Code's subagent system.

## When to Use Codex

Codex excels at:
- **Backend design** - API architecture, database schemas, system design
- **Deep reasoning** - Complex algorithmic problems, optimization
- **Debugging** - Root cause analysis, stack trace interpretation
- **Code review** - Security analysis, best practices, edge cases
- **Architecture** - System decomposition, component design

## When NOT to Use Codex

Use other agents instead for:
- **Front-end design** - Use Gemini (`/gemini`)
- **UI/UX work** - Use Gemini (`/gemini`)
- **Web research** - Use Gemini (`/gemini`)
- **Long-context analysis** - Use Kimi (`/kimi`)
- **Browser automation** - Use ChatGPT (`/chatgpt`)

## Spawning Sub-Agents

When you need capabilities outside your specialty, spawn the appropriate agent:

```
# Web research
gemini search for latest React 19 features

# Long document analysis
kimi analyze this 200-page PDF

# Browser automation (ChatGPT)
/chatgpt search for competitor pricing

# Quick research with Gemini
gemini what are the current best practices for JWT rotation
```

## Output Pattern

**CRITICAL**: To minimize token usage, write full analysis to files and return only summaries.

### Output Folder
```
~/Desktop/codex-output/
```

### File Naming
```
{task-slug}-{YYYY-MM-DD-HHMM}.md
```

### Template

When completing a task, your response should be:

```
Created: ~/Desktop/codex-output/schema-design-2026-02-02-1430.md

Summary:
- [Key finding/decision 1]
- [Key finding/decision 2]
- [Key finding/decision 3]

Follow-up: [Any blockers or next steps]
```

### Example Full Output (written to file)

```markdown
# Database Schema Design for User Authentication

## Overview
Analyzed requirements for user auth system supporting OAuth + email/password.

## Schema

### users table
| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PRIMARY KEY |
| email | varchar(255) | UNIQUE NOT NULL |
| ...

## Decisions Made
1. Used UUID instead of auto-increment for distributed safety
2. Separate sessions table for multi-device support
3. Added soft delete with deleted_at timestamp

## Trade-offs Considered
- JWT vs session tokens: chose sessions for revocability
- ...

## SQL Migrations
[Full migration SQL here]
```

## Model Configuration

Codex uses Claude with `opus` model for maximum reasoning capability.

## Session Behavior

- `/codex` switches the entire conversation to Codex
- All subsequent messages use Codex until you switch (`/claude`, `/gemini`) or reset (`/new`)
- Message count is tracked for cost awareness

## Integration with HOMER

Codex is one of several executors in HOMER's multi-model architecture:

| Executor | Model | Best For |
|----------|-------|----------|
| Claude (default) | sonnet | General tasks, tool use |
| Codex | opus | Deep reasoning, backend |
| Gemini | flash | Research, front-end |
| Kimi | K2.5 | Long context |
| ChatGPT | browser | Web automation |

## Tips

1. **Be specific** - "Design a schema" < "Design a normalized PostgreSQL schema for a multi-tenant SaaS with soft delete"
2. **Provide context** - Share relevant code, constraints, requirements
3. **Ask for trade-offs** - Codex excels at explaining the pros/cons of different approaches
4. **Iterate** - Use follow-up questions to refine the solution
