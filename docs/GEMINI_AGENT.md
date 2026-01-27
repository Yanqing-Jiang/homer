# Gemini Subagent Optimization Guide

**Timeout:** 10 minutes (600,000ms)

## When to Use Gemini

- Research tasks requiring web search
- Front-end design and UI/UX work
- General exploration and information gathering
- Tasks benefiting from multimodal capabilities
- Weather queries and real-time information

## Best Practices

### 1. Prompt Structure

```
[Use the gemini subagent for this task] <your query>
```

The H.O.M.E.R bot automatically prepends this when you use `/g` prefix.

### 2. Effective Query Patterns

**Good:**
- "Search the web for recent React 19 features and summarize"
- "Research best practices for Tailwind CSS dark mode"
- "What's the current weather in Seattle?"
- "Find and compare pricing for cloud storage providers"

**Avoid:**
- Complex multi-file code refactoring (use Codex)
- System architecture design (use Codex)
- Tasks requiring deep reasoning about code logic

### 3. Timeout Considerations

With a 10-minute timeout, Gemini can handle:
- Multiple web searches in sequence
- Comprehensive research with source synthesis
- Detailed UI/UX analysis and recommendations
- Image/screenshot analysis

### 4. Rate Limiting

Gemini has its own rate limits. If you're doing many queries:
- Space out requests when possible
- Batch related questions into single queries
- Use caching for repeated queries

### 5. Output Handling

Gemini responses may include:
- Markdown formatting
- Code snippets
- Links to sources
- Structured data

The bot will preserve formatting when sending to Telegram.

## Common Use Cases in H.O.M.E.R

1. **Morning Briefings**: Weather, news, calendar summaries
2. **Research**: Technology comparisons, best practices
3. **Design**: UI feedback, accessibility reviews
4. **Real-time Info**: Stock prices, event schedules, weather

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Timeout on large research | Break into smaller queries |
| Incomplete responses | Ask for continuation |
| Rate limited | Wait 60s and retry |
| Web search failed | Retry or use specific URLs |

## Integration Notes

Gemini is invoked via the `/g` prefix in Telegram:
```
/g What are the latest updates to TypeScript 5.4?
```

Or programmatically:
```typescript
const result = await executeClaudeCommand(query, {
  cwd: "/Users/yj/work",
  subagent: "gemini",
});
```
