# AI Dev MCP vNext Architecture

## Goals

- Give Codex and Claude compact, current project context instead of dumping the vault.
- Route each task to at most three relevant skills.
- Bind completion claims to acceptance criteria and machine-readable evidence.
- Keep local operation offline-first while using the standard MCP protocol.
- Make every write recoverable and every executable command explicit.

## Runtime Layers

1. `server.mjs`: official MCP SDK transport, protocol capabilities, resources, prompts, and tool registration.
2. `mcp-stdio.mjs`: composed domain-service facade and legacy-compatible rollback handler.
3. `tool-definitions.mjs`: typed MCP contracts separated from dispatch and implementation.
4. `core/`: path policy, atomic storage, command policy, process execution, canonical project
   identity, context compilation, task state, routing, outcome analytics, overlays, dashboard,
   frontend quality, and runtime distribution.
5. `extensions/`: capabilities registered from outside `mcp-stdio.mjs` (see below).
6. `hooks/`: standalone scripts run by the *agent*, not by the server (see below).
7. `09-mcp/search-index`: FTS and BGE-M3 hybrid retrieval.
8. Obsidian: human-readable knowledge, generated project cards, workflows, and reports.
9. `${AI_DEV_HOME}/state` (default `~/.ai-dev/state`): runtime task state and evidence that should not clutter the vault.

Archify is a local, vendored diagram capability. Its nine typed MCP tools and
artifact/evidence contract are documented in [ARCHIFY.md](ARCHIFY.md).

Frontend product projects add a repository-local state machine:

```text
.ai-dev/frontend/product-quality.json
-> approved document hashes and pre-code baseline
-> immutable visual references
-> strict Playwright state evidence
-> independent hash-bound visual review
-> handoff gate
```

`core/frontend-product-quality.mjs` owns the pure routing, policy, document, scorecard, and gate rules. The existing Frontend QA runner owns browser execution and pixel comparison; Frontend Product Quality v2 composes it instead of creating a competing runner.

When approved references do not exist, `core/reference-factory.mjs` adds a bounded two-stage artifact
contract:

```text
concept manifest
-> client ImageGen/Figma execution
-> PNG/path/hash/prompt/inspection validation
-> candidate direction registration
-> independent Concept Jury
-> direction approval
-> coverage manifest for the approved direction only
-> immutable baseline registration
```

The MCP server never claims external image-tool execution. It creates and validates manifests; the
client performs generation and visual inspection.

### Extensions

`src/mcp-stdio.mjs` is capped by the static quality gate, so a new capability is not written into
it. `src/tool-extensions.mjs` holds a registry of factories; each module under `src/extensions/`
exports one:

```js
createXxxTools(host) -> { definitions, handlers, readOnly }
```

`host` is assembled once by `mcp-stdio.mjs` and carries the shared runtime services an extension is
allowed to touch — `taskStore`, `usageLedger`, `sessionStore`, `instinctStore`, project identity and
project-file helpers, the vault layout (`vaultPaths`) and its readers and writers, the live status
sources (search index, embedding backend, registries), and `callTool` for composing existing tools.
The dependency runs one way: extensions never import `mcp-stdio.mjs`, which would both cycle and
couple pure logic to the vault. Duplicate tool names and definitions without a handler throw at
startup, so a broken extension can never reach a client.

Registered today: `decisions`, `hooks`, `hygiene`, `instincts`, `plans`, `rules`, `sessions`,
`system`, `usage`, `worktrees`. Pure logic stays in `core/` (`decision-ledger.mjs`,
`agent-hooks.mjs`, `change-hygiene.mjs`, `instincts.mjs`, `task-plans.mjs`, `rules-library.mjs`,
`rules-catalog.mjs`, `session-memory.mjs`, `system-health.mjs`, `system-dashboard.mjs`,
`usage-ledger.mjs`, `task-worktrees.mjs`); the extension is the MCP surface over it.

`system` is the first of the extractions from `mcp-stdio.mjs` rather than a new capability:
`system_health_check`, `rebuild_system_dashboard` and `system_dashboard_status` moved out with their
definitions. Its checks fetch through `host` and hand the raw status objects to pure evaluators in
`core/system-health.mjs`, which also assembles the dashboard snapshot.

### Context extras

`core/context-extras.mjs` lets an optional subsystem contribute a section to the compiled context
pack without the context compiler knowing it exists. A provider takes the same input and returns
`null` or `{ id, title, markdown, items }`:

- `decisions` — recent records from `<projectRoot>/.ai-dev/decisions`.
- `handoff` — the newest substantive session: next step, blockers, and approaches that already
  failed, tagged with their age so a stale handoff is not trusted blindly.
- `instincts` — learned preferences that pass the relevance filter for this project and task.

Providers must be cheap, read-only, and must not throw. A provider that fails is reported as an
`unknown` entry in the pack instead of failing `begin_task`.

### Hooks

`hooks/*.mjs` are not part of the server process. `install_agent_hooks` copies them into
`<project>/.ai-dev/hooks/` and registers them with the agent — `.claude/settings.json` for Claude
Code, `.cursor/hooks.json` (version 1) for Cursor — merging into whatever is already there and
replacing only previous AI Dev entries. The agent then spawns each script per event, with the event
JSON on stdin.

| Script | Event | What it does |
| --- | --- | --- |
| `guard.mjs bash` | PreToolUse (Bash) | Blocks git-hook bypasses, destructive and publishing commands, and policy `block` rules. |
| `guard.mjs file` | PreToolUse (Write/Edit) | Blocks secret-bearing paths, secrets in new content, and weakened linter or protected configuration. |
| `compact-advisor.mjs` | PreToolUse (Edit/Write) | Suggests `/compact` from real context size in the transcript plus a per-session tool-call count. Never blocks. |
| `post-edit.mjs` | PostToolUse | Formats the edited file with the project's own formatter when one is installed locally — never installs anything, never uses `npx`. |
| `session-start.mjs` | SessionStart | Injects the last handoff, open tasks, high-confidence instincts, and the installed rules index into the first turn. |
| `session-end.mjs` | Stop, PreCompact | Distils the transcript into a session record for `resume_session`. |
| `stop-check.mjs` | Stop | Cheap checks on git-modified files: leftover `console.log`/`debugger`, secrets, and a `verify_task` reminder while a task is active with uncommitted changes. |

`.ai-dev/policy.json` is the knob: a `profile` (`minimal` — guard and session capture only,
`standard`, `strict`), `allow_config_edits`, `format_on_edit`, the compaction thresholds, and a list
of hookify-style `rules` (`{ id, event, pattern, action, message }`) that add project-specific
`block` or `warn` patterns without touching the scripts. Hooks fail open: any error exits 0 so a
broken hook never wedges the agent.

### State roots

`${AI_DEV_HOME}/state` (`AI_DEV_STATE_ROOT`, default `~/.ai-dev/state`) holds everything that is
runtime state rather than knowledge:

```text
${AI_DEV_HOME}/state/
  tasks/<task-id>.json      task records (authoritative lifecycle state)
  sessions/<project-id>/    session handoffs, one file per save; hook-<id>.json is a hook capture
  instincts.json            learned preferences with confidence and decay
  usage/events.jsonl        tool-call and token/cost ledger, pruned by size
  skill-outcomes.json       verification-bound routing outcomes
  pilots.json               pilot reviews
  archify-receipts/         server-owned receipts keyed by artifact SHA-256
```

Three levels, deliberately kept apart: the vault is shared knowledge, this tree is per-user runtime
state, and `<project>/.ai-dev/` (decisions, plans, context packs, rules, hooks, policy) is per-repository
and belongs in the repository's own history.

## Request Path

```text
MCP client
-> official SDK transport
-> typed tool contract
-> domain service
-> path/command policy
-> atomic state or bounded process
-> structured result + evidence
```

Search uses a two-stage path:

```text
task query
-> deterministic bilingual intent router (0-3 custom candidates)
-> SQLite FTS + sparse aliases + BGE-M3
-> intent/scope/source/conflict/hard-negative reranker
-> canonical entity collapse
-> bounded ranked context
```

The router controls workflow selection. Dense similarity remains a retrieval signal and cannot
silently replace the exact task workflow with broad catalog notes. Search explanations expose every
boost and penalty used by Ranking v2.

Substantive repository work compiles context before implementation:

```text
canonical project identity
-> Project Brief / Map / Gate
-> task intent and routed skills
-> relevant source files and bounded excerpts
-> commands, risks, unknowns, freshness fingerprint
-> .ai-dev/context/<task-id>.json + Markdown projection
```

Secret-bearing files and unrelated repository content are excluded. The pack is a cache, not a new
source of truth.

## Task And Quality State

A task record (`${AI_DEV_HOME}/state/tasks/<task-id>.json`) is the authoritative lifecycle state:

```jsonc
{
  "schema_version": 1,
  "id": "task-<timestamp>-<hash>",
  "status": "active | complete",   // "complete" only through complete_task
  "task": "...",
  "project": { "id", "repository_id", "name", "path", "aliases", "types", "stack", "components" },
  "risk": "low | medium | high",
  "plan_policy": {
    "complexity": "small | medium | large",
    "score": 0,
    "plan_required": false,
    "reasons": ["..."],
    "suggested_effort": "low | medium | high",
    "suggested_model_tier": "fast | balanced | deep"
  },
  "plan": null,
  "acceptance_criteria": [{ "id": "AC-1", "text": "...", "status": "pending", "evidence": [], "note": "" }],
  "skills": ["..."],
  "context": {
    "worktree": { "path", "branch", "base_ref", "main_root", "created", "removed_at?" }
  },
  "baseline": { /* project fingerprint at begin_task */ },
  "checkpoints": [],
  "verifications": [],
  "completion": null
}
```

- `plan_policy` is computed at `begin_task` from complexity signals and risk. When it says
  `plan_required`, the task gets an extra acceptance criterion that only `plan_task` can meet, so
  the plan gate is enforced through the normal completion rules rather than a special case.
- `context.worktree` is present only for a task opened with `begin_task_in_worktree`. It records
  where the isolated checkout lives and which branch it is on; `complete_task` uses it to point at
  the merge or PR, and `remove_task_worktree` stamps `removed_at` instead of deleting the field.
- Task records contain acceptance criteria, checkpoints, verification evidence, and source-state fingerprints.
- Completion rejects stale evidence and unresolved criteria.
- Skill structure scores measure document readiness only.
- Routing benchmarks measure selection behavior only.
- `${AI_DEV_HOME}/state/skill-outcomes.json` records verification-bound task outcomes.
- Empirical skill validation requires three terminal tasks, two canonical projects, at least 80%
  pass rate, and at least one human-confirmed review.
- Pilot reviews measure independent dimension-level product outcomes and revision count without
  replacing task verification.

## Source Of Truth

- Repository code and its `.ai-dev` directory are authoritative for project facts.
- The Obsidian project card is a generated projection plus a preserved manual-notes section.
- Skill `SKILL.md` files are authoritative; cards and graph pages are generated projections.
- SQLite and dense vectors are disposable indexes.
- Task JSON records are authoritative for lifecycle state; Markdown reports are projections.
- Skill overlay JSON is local policy; generated skill cards and dashboard are disposable projections.

## Line Budgets

`scripts/static-quality.mjs` enforces two ceilings:

- `src/mcp-stdio.mjs` may not exceed `SYSTEM_LINE_CEILING` (10,150 today), which lives in
  `core/system-health.mjs` so the System Dashboard reports the ceiling the gate enforces. The file
  shrinks one extraction at a time (docs/ecc-upgrades/PLAN.md, stage 1) and the ceiling is re-pinned
  to its actual size plus roughly 300 lines of working room after each step, so it can be edited but
  not re-grown.
- Every module under `src/core/` and `src/extensions/` stays within `MODULE_LINE_CEILING` (800) —
  the same soft ceiling `COMMON_RULES` puts on user projects.

`MODULE_LINE_EXCEPTIONS` carries the modules that were already over the ceiling when the rule
landed. An entry pins a module at its current size: it may shrink, never grow, and the gate demands
the entry be dropped once the module is back under the ceiling or gone.

## Operations And Distribution

- `System Dashboard.md` is generated from live tool, skill, project, search, outcome, and runtime state.
- `config/runtime.example.json` documents the supported local stdio profile.
- `scripts/ai-dev.mjs` exposes doctor, dashboard, reindex, acceptance, backup, and distribution commands.
- Remote HTTP is intentionally absent. The future VPS profile is rejected until TLS, authentication,
  allowlists, rate limiting, and threat review exist.

## Compatibility

`src/mcp-stdio.mjs` remains runnable as `npm run start:legacy` for rollback. `src/server.mjs` is the
authoritative runtime and has protocol, lifecycle, search, project, Frontend QA, coverage, static
quality, security, and regression acceptance.
