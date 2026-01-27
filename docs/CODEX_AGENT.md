# Codex Subagent Optimization Guide

**Timeout:** 15 minutes (900,000ms)
**Model:** gpt-5.2-codex @ xHigh reasoning effort

## When to Use Codex

- Deep reasoning and complex problem-solving
- Backend design and system architecture
- Debugging difficult issues
- Algorithm design and optimization
- Code review with detailed analysis
- Database schema design

## Best Practices

### 1. Prompt Structure

```
[Use the codex subagent for this task] <your query>
```

The H.O.M.E.R bot automatically prepends this when you use `/x` prefix.

### 2. Effective Query Patterns

**Good:**
- "Design a scalable architecture for a real-time chat system"
- "Debug why this async function causes a race condition: [code]"
- "Optimize this SQL query that's timing out on large datasets"
- "Review this code for security vulnerabilities"
- "Design a state machine for a payment processing flow"

**Avoid:**
- UI/UX design work (use Gemini)
- Web research tasks (use Gemini)
- Simple CRUD implementations
- Tasks that don't benefit from deep reasoning

### 3. Timeout Considerations

With a 15-minute timeout, Codex can handle:
- Complex architectural analysis
- Multi-step debugging with investigation
- Comprehensive code reviews
- Algorithmic optimization with multiple iterations
- Database migration planning

### 4. Reasoning Mode

Codex runs at "xHigh" reasoning effort, meaning:
- Extended thinking time before responding
- More thorough analysis
- Better handling of edge cases
- Higher token usage per query

### 5. Cost Considerations

xHigh reasoning = higher API costs. Use judiciously:
- Reserve for genuinely complex problems
- Don't use for simple lookups or quick questions
- Batch related questions when possible

## Common Use Cases in H.O.M.E.R

1. **Architecture Reviews**: System design validation
2. **Debugging**: Root cause analysis for complex bugs
3. **Optimization**: Performance tuning recommendations
4. **Security**: Code audit and vulnerability assessment
5. **Migration Planning**: Database/API version upgrades

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Timeout on huge codebase | Narrow scope, provide specific files |
| Incomplete analysis | Ask for continuation with context |
| High latency | Expected with xHigh reasoning |
| Cost concerns | Use for high-value tasks only |

## Integration Notes

Codex is invoked via the `/x` prefix in Telegram:
```
/x Design a caching strategy for our API with these requirements: [...]
```

Or programmatically:
```typescript
const result = await executeClaudeCommand(query, {
  cwd: "/Users/yj/work/myproject",
  subagent: "codex",
});
```

## Comparison: Gemini vs Codex

| Aspect | Gemini | Codex |
|--------|--------|-------|
| Timeout | 10 min | 15 min |
| Best for | Research, UI, real-time | Architecture, debugging |
| Reasoning | Standard | xHigh (deep) |
| Cost | Lower | Higher |
| Web access | Yes | Limited |

## Example: When to Switch

**Start with Gemini:**
> "Research authentication patterns for mobile apps"

**Then use Codex:**
> "Design an OAuth2 + JWT auth system for our React Native app with these constraints: [detailed requirements]"

This workflow uses Gemini for gathering options, then Codex for deep architectural design.
