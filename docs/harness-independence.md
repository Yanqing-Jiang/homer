# Harness Independence

**Added:** 2026-06-28
**Status:** Active (cutover deployed 2026-06-28)

## Overview

Homer is **harness-independent**: no feature, scheduled job, or skill is hardcoded to a
specific AI CLI. A single *spine* resolves "which harness runs this" from the database at call
time, and every surface — features, scheduled jobs, skills, slash commands, MCP — composes on top
of it. Switching a job (or everything) from Claude to OpenCode/GLM, Codex, Gemini, or Kimi is a
data change in one table, not a code change.

The five harnesses behind the spine:

| Harness | Backing CLI | Typical model |
|---|---|---|
| `claude` | Claude Code | opus / opus[1m] |
| `codex` | OpenAI Codex | gpt-5.5 |
| `opencode` | OpenCode | GLM 5.2 (`opencode-go/glm-5.2`), or provider-passthrough models |
| `gemini` | Gemini CLI (often via OpenCode) | gemini-3.5-flash |
| `kimi` | Kimi (via OpenCode) | kimi-k2.x |

---

## The Spine

```
harness_selection (DB)         ← control plane (written by the Jobs tab / MCP / bulk ops)
        │
   resolution/resolver.ts      ← scope precedence: turn → conversation → lane → job → global → system-default
        │
   negotiation.ts              ← if the selected harness can't satisfy required capabilities, promote one that can
        │
   registry.ts → adapters/*    ← one HarnessAdapter contract per harness (prepare → execute, validateModel, descriptor)
        │
   dispatch.ts                 ← executeResolvedHarness(): the single call every feature uses
```

**The invariant:** harness + model selection lives *only* in `harness_selection` rows. The code
"baseline" a job carries is a **profile** (cwd, timeout, executor options, fallback ranking) — never
a selector. No rule may name a specific harness as a special target.

### Components (`src/harness/`)

- **`types.ts`** — the `HarnessAdapter` contract, `HarnessRequest`/`HarnessResult`, capability and
  invocation types.
- **`registry.ts`** — maps each `HarnessId` to its adapter. `getHarnessAdapter(id)`.
- **`adapters/{claude,codex,opencode,gemini,kimi}.ts`** — wrap the concrete CLI. Each one threads
  cwd/model/timeout/signal/session/stream and normalizes output to `HarnessResult`. `adapters/shared.ts`
  composes the final prompt identically for all of them (Node assembles context — the "effect-purity"
  property), so a prompt looks the same regardless of who runs it.
- **`capabilities.ts`** — a (harness × invocation) capability matrix: `text.generate`, `code.edit`,
  `tools.shell`, `tools.mcp.native`, `browser.agent`, `vision.image`, `long_context.1m`, etc., each at
  `native` / `prompted` / `sidecar` / `none`.
- **`resolution/`** — `resolver.ts` (scope-ordered DB lookup), `store.ts` (read side of
  `harness_selection`), `types.ts`. Emits a `ResolvedHarnessPlan` (selection + profile + required
  capabilities + audit).
- **`negotiation.ts`** — turns a resolved plan into an ordered attempt list, degrading by *capability*
  (nearest harness that HAS the missing capability) rather than by a hardcoded hop to any one harness.
- **`dispatch.ts`** — `executeResolvedHarness(input)`: resolve → negotiate → run the chosen adapter.
  This is the single-attempt path every migrated feature call uses. `toExecutorLike()` bridges the
  result to the legacy `ExecutorResult` shape. `resolvedPrimaryHarness(input)` returns the harness a
  call *would* run on without executing (used for fallback bookkeeping).

---

## Selection & Scope

`harness_selection` is the source of truth. Each row is `(scope_type, scope_id) → (harness, model)`.
The resolver walks scopes highest-precedence first and takes the first match:

| Scope | Precedence | Set by | Status |
|---|---|---|---|
| `turn` | highest | explicit per-invocation pin (e.g. `/harness`, code `explicit:`) | wired (interactive) |
| `conversation` | | per-chat pin | wired |
| `lane` | | per-lane pin | wired |
| `job` | | **Jobs tab** per-job pin | **wired — primary lever** |
| `global` | lowest | Jobs tab "switch all", kill-switch | wired |
| `system-default` | floor | first registry harness | implicit |

- **Per scheduled job:** pin any job to any harness+model independently via the Jobs tab. Job row
  beats global; un-pinned jobs follow global.
- **Per single run:** the `turn`/`explicit` tier wins over the job row and is used by interactive
  triggers and code-level `explicit:` pins. There is no "run this one scheduled fire on harness X"
  button yet — a one-off means temporarily pinning the job or triggering it manually with an override.
- **Per stage (within a multi-stage job):** **not yet wired.** A `job_stage` tier is deferred (see
  *Deferred*). Today all stages of a job follow the job-level pin.

### Capability negotiation

`requiredCapabilities` on a call are **live**, not annotations: `executeResolvedHarness` runs the
resolved plan through `negotiateHarnessAttempts`, which promotes a capability-satisfying harness when
the selected one can't do the job (e.g. a code-editing call won't silently run on a harness that can't
edit). With no required capabilities (the common case) the negotiated primary is just the resolved
selection — behavior-neutral.

---

## Skills, Slash Commands & MCP Across Harnesses

One canonical source, fanned out per harness. See `scripts/render-harness-assets.ts`.

### Skills / slash commands

A skill is authored once under `skills/skills/<id>/skill.md`. `render-harness-assets.ts --install`
rewrites logical tool names to each harness's native tool names (via an alias table) and installs a
harness-native copy:

| Harness | Skill path | Command path |
|---|---|---|
| Claude | `~/.claude/skills/<id>/SKILL.md` | `~/.claude/commands/<id>.md` |
| OpenCode | `~/.config/opencode/SKILLS.md` | `~/.config/opencode/command/<id>.md` |
| Codex | `~/.codex/skills/homer/<id>/SKILL.md` | (folded into skill body w/ slash note) |
| plain | `skills/dist/plain/<id>.md` (scheduler `contextFiles`) | — |

`npm run skills:check` fails the build if any rendered copy drifts from canonical, so they can't
silently diverge. The `plain` variant is the harness-agnostic lowest common denominator that the
scheduler injects as `contextFiles` for any harness.

### MCP & memory

Each harness has its own config, but they register the **same** `homer-memory` MCP server binary
(`dist/mcp/index.js`) — so Claude, OpenCode, and Codex all call `memory_context`, `todo_save`,
`idea_add`, etc. **natively**. For harnesses without native MCP (gemini, kimi → `memory.read: sidecar`),
Homer's Node layer retrieves memory and **injects it as text** (`# Retrieved memory`) into the prompt.
Same logical memory reaches every harness — live MCP where supported, sidecar text where not.

---

## The Cutover (2026-06-28)

Before: ~25 call sites hardcoded `executeClaudeCommand(...)`, and the scheduler consulted a code
"baseline bridge" as a selector. After:

1. **Migration 108** adds `harness_selection_meta` (a seed-once marker table).
2. **Seed-once:** internal job baselines seed as job-scope `harness_selection` rows exactly once
   (`scheduler/harness-baseline-seed.ts`, `ON CONFLICT DO NOTHING`), so deliberate tuning becomes
   visible/switchable in the Jobs tab. A marker row makes re-seed a no-op; a switch-all writes a
   suppress marker so a restart never restores cleared rows.
3. **Feature callers migrated** onto `executeResolvedHarness`, so they follow the resolver.
4. **Scheduler + queue** resolve + negotiate instead of hardcoding Claude. The queue honors a job's
   requested executor directly (no more hiding gemini/codex inside a Claude subagent).

**Behavior-neutral by design:** the cutover deploy preserved existing pins and left `global`
unchanged, so nothing moved. The actual model shift happens only when you run **switch all → X** in
the Jobs tab. The remaining concrete-executor code is the two dispatch tables (`scheduler/executor.ts`,
`queue/worker.ts`) — the execution-primitive layer, intentionally concrete and guarded by
`npm run harness:lint`.

### Deliberate exception

`architecture-updater` is pinned to Codex/gpt-5.5 in code. It is event-triggered (not in
`schedule.json`), so it never appears in the Jobs tab — a seeded DB row would be an unmanageable
hidden pin. The explicit code pin is visible, behavior-neutral, and intentionally immune to switch-all.

---

## Guardrails

- `npm run harness:lint` — fails on any *new* concrete-executor caller outside the two allowed
  dispatch tables.
- `npm run harness:conformance` — every harness satisfies the adapter contract; a 4-step scope
  round-trip strands no scope.
- `npm run skills:check` — rendered skill variants match canonical.
- `npm run check` runs all of the above plus typecheck + build.

---

## Deferred

- **`job_stage` scope tier** — per-stage harness divergence within a multi-stage job (e.g.
  `overnight-youtube` classify vs. analyze). Dormant today because every multi-stage job is pinned at
  the job level. Wire this when a stage needs a different harness than its job pin.
- **Derive fallback ranking from capability descriptors** so the transitional `*_FALLBACK_ORDER`
  lists can be deleted.
- **Route `queue/worker.ts` + scheduler dispatch through the adapters** so even the two remaining
  concrete tables drop to zero.
- **Validate non-null DB model strings** in dispatch (currently passed through, since the OpenCode
  pins use provider-passthrough models not in the catalog).

---

## See Also

- `docs/runtime-data-model.md` — the SQLite schema.
- `homer-web/docs/harness-control.md` — the Jobs-tab control plane and switch-all semantics.
