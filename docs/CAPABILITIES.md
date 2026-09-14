# Capability profiles

[← README](../README.md) · [Install](INSTALL.md) · [Workflow](WORKFLOW.md) · [Guard rails](GUARDRAILS.md)

The server exposes 133 tools. That is a strength when the agent needs one of them
and a cost the rest of the time: every tool in `tools/list` is schema text the
model carries before it has read a word of your request.

Capability profiles cut that surface along the lines you already think in.

## The eight profiles

| Profile | Tools | What it adds | Turn it on when |
| --- | --- | --- | --- |
| **`core`** | 25 | Project context, skill routing, and a task from first command to verified completion. | Always on. It cannot be switched off. |
| `coding` | 18 | Epics, the plan gate, project cards and auto-commands, the repository's own engineering rules. | Work that spans several tasks, or a repository whose rules the agent should install and follow. |
| `memory` | 16 | Decisions, session handoffs, instincts, the knowledge notes behind them. | You want the next session to start where this one stopped. |
| `git` | 9 | Isolated worktrees, snapshots and rollback, change-hygiene review, pull request text. | The agent touches a real working tree you care about. |
| `frontend` | 13 | Brief, visual directions, concept jury, design system, reference factory. | Building or reviewing a user-facing surface. |
| `qa` | 8 | Playwright and visual QA runners, and the benchmarks that hold search and routing honest. | Verification has to produce evidence a person can look at. |
| `security` | 8 | Secret and dependency scans, command and write policy, agent hooks, MCP inventory. | Setting up guard rails, or auditing what your agents are wired to. |
| `advanced` | 36 | Archify diagrams, the search and skill indexes, the dashboard, usage ledger, runtime packaging. | Maintaining the system itself rather than using it. |

The authoritative per-tool mapping is the `Profile` column in the
[tool reference](../ai-dev-mcp-server/docs/TOOLS.md), which is generated from the
server's own definitions. Every tool belongs to exactly one profile, and CI
refuses a new tool that belongs to none.

## Turning them on

Set `AI_DEV_PROFILES` in the server's environment — in your MCP client's `env`
block, or in the shell that launches it:

```bash
AI_DEV_PROFILES=core,git        # 34 tools
AI_DEV_PROFILES="coding memory" # commas or spaces, both work
AI_DEV_PROFILES=all             # every profile, the same as leaving it unset
```

`core` is added to whatever you name, so `AI_DEV_PROFILES=git` and
`AI_DEV_PROFILES=core,git` mean the same thing.

**Unset, every profile is on.** Nothing is hidden until you ask for it, so an
installation that never heard of profiles behaves exactly as it did before they
existed.

In a client configuration it goes beside the other variables:

```json
{
  "mcpServers": {
    "ai-dev": {
      "command": "...",
      "args": ["..."],
      "env": {
        "AI_DEV_PROJECT_PATH": "C:\\Dev",
        "AI_DEV_PROFILES": "core,git,memory"
      }
    }
  }
}
```

## What narrowing actually costs and saves

Measured against the server's own tool definitions:

| Setting | Tools listed | Schema in context |
| --- | --- | --- |
| `core` | 25 | ~15 KB |
| `core,git` | 34 | ~22 KB |
| `core,coding,git,memory` | 68 | ~48 KB |
| unset / `all` | 133 | ~96 KB |

Two things it does **not** do:

- **It does not disable anything.** Narrowing affects `tools/list` only.
  `tools/call` still accepts every tool by name, so a client that already knows
  a name keeps working, and nothing in the system becomes unreachable.
- **It is not a security boundary.** It is a context-budget control. The things
  that actually refuse an action are the [guard rails](GUARDRAILS.md).

A narrowed server says so on stderr at startup, naming the profiles and the tool
count, so "the tool is missing" is never an unexplainable symptom:

```text
ai-dev: capability profiles core, git — 34 of 133 tools listed. Unset AI_DEV_PROFILES for all of them.
```

A profile name it does not recognise is reported and ignored rather than taken as
an empty list — a typo should not quietly cost a session half its tools.

## Choosing a set

- **Backend or API work:** `core,git` — and add `coding` once the work spans more
  than one task.
- **A long-running project you return to:** `core,git,memory`.
- **Frontend work:** `core,git,frontend,qa`.
- **Setting the repository up for a team:** `core,coding,security`.
- **Working on AI Dev System itself:** leave it unset.

If you are not sure, leave it unset. The profiles are there for when the tool
surface starts costing you something, not as a step you have to complete first.
