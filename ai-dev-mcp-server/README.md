# AI Dev MCP Server

Local, offline-first MCP server for the Obsidian-based AI Dev System. It gives any MCP-capable
coding agent (Claude Code / Desktop, Cursor, VS Code, Gemini, Codex, …) bounded project context,
deterministic skill routing, controlled repository setup, hybrid search, verification, and
evidence-bound task completion.

## Runtime

- `src/server.mjs`: authoritative stdio runtime built on `@modelcontextprotocol/sdk@1.30.0`.
- `src/mcp-stdio.mjs`: tool dispatch (`callTool`), the `tools` contract list, and the
  hand-rolled JSON-RPC fallback server (`startLegacyServer`, `npm run start:legacy`);
  `server.mjs`, the scripts and the tests import it.
- `src/tool-definitions.mjs`: typed MCP tool contracts, separated from runtime dispatch.
- `src/extensions/`: tools added as extensions, registered in `src/tool-extensions.mjs`.
- `src/core/`: path, command, process, project identity, context, task, routing, outcome, dashboard,
  overlay, frontend-quality, and distribution modules.
- Node.js: 22.16+ or 24+ on `PATH` (any distribution) — all of search lives in `node:sqlite`,
  which has FTS5 from 22.16; on an older Node, every search tool answers with the version it
  needs. No Python and no agent-specific runtime is required.
- Regenerable runtime data lives under the **AI Dev home** — `AI_DEV_HOME`, default `~/.ai-dev`:
  - `~/.ai-dev/state` — task lifecycle, skill outcomes, pilots (override: `AI_DEV_STATE_ROOT`)
  - `~/.ai-dev/cache/search-index` — SQLite + dense index (override: `AI_DEV_SEARCH_INDEX_DIR`)
  - `~/.ai-dev/artifacts/frontend-qa` — QA screenshots (override: `AI_DEV_FRONTEND_QA_ARTIFACT_ROOT`)
  - `~/.ai-dev/models/bge-m3-onnx` — the ONNX embedding model `--dense` installs
    (override: `BGE_M3_ONNX_DIR`)
  - `~/.ai-dev/cache/dense-model` — the record of which model files hashed right, so a
    check does not read 570 MB again
  - A pre-existing `~/.codex/<...>` layout is used automatically if the `~/.ai-dev` path is absent,
    so installs migrated from the Codex-only runtime keep their history.

Start:

```bash
AI_DEV_VAULT_ROOT="/path/to/vault" node src/server.mjs
```

From a plain clone no vault is needed, and `npm run clients:install` writes an equivalent
entry into Claude Code, Cursor, VS Code and Gemini for you: the absolute path of the Node that
ran it, this clone's `src/server.mjs`, no vault variable, `"type": "stdio"` for VS Code and
Claude Code, and `servers` instead of `mcpServers` for VS Code.

The server negotiates MCP over stdio and exposes structured tool results, Resources, resource
templates, Prompts, progress notifications, and tool annotations. Any stdio MCP client works —
Claude Code / Desktop, Cursor, VS Code, Gemini, Codex. Minimal client entry:

```jsonc
{
  "mcpServers": {
    "ai-dev-system": {
      "command": "node",
      "args": ["/path/to/vault/09-mcp/ai-dev-mcp-server/src/server.mjs"],
      "env": { "AI_DEV_VAULT_ROOT": "/path/to/vault" }
    }
  }
}
```

## Main Workflow

For substantive repository work:

1. `prepare_project` once if agent files are missing.
2. `begin_task` with the real repo root and concrete request. It resolves canonical project identity
   and compiles a bounded task-specific context pack.
3. Read the compiled pack and no more than three routed skills.
4. Implement a scoped change and call `checkpoint_task`.
5. For product UI, pass `frontend_product_gate`, run strict visual reference QA, and record independent review.
6. Call `verify_task`; it automatically checks prepared frontend product handoff state.
7. Call `complete_task` only after all criteria are resolved and evidence matches current Git state.

The canonical agent skill is `03-skills-catalog/sources/custom/ai-dev-orchestrator/SKILL.md`.

## Capabilities

Every tool, grouped and with its read-only flag and required arguments, is listed in
[`docs/TOOLS.md`](docs/TOOLS.md) — generated from the server's own definitions by
`npm run docs:tools` and checked in CI. The summary below is the map, that file is the index.

Project intelligence:

- `analyze_project`
- `prepare_project`, `bootstrap_project`
- `project_identity`
- `register_project`, `sync_project_card`, `read_project`, `list_projects`
- `refresh_project_map`, `refresh_project_memory`
- recursive monorepo/component, stack, command, entry-point, API, data, CI, and risk detection

Task lifecycle:

- `begin_task`, `get_task`, `list_tasks`
- `checkpoint_task`, `verify_task`, `complete_task`
- `compile_project_context`, `project_context_status`
- `start_project_pilot`, `record_project_pilot_review`, `project_pilot_status`
- `skill_outcome_status`, `rebuild_skill_outcomes`

Skills:

- `recommend_skills` returns one to three deterministic custom skills
- `list_skill_groups`, `browse_skill_group`
- `read_skill_card`, `read_skill`
- `rebuild_index`, `rebuild_skill_taxonomy`, `sync_skill_cards`
- `validate_skill_library`, `run_skill_routing_eval`
- `sync_skill_overlays`, `list_skill_overlays`, `upsert_skill_overlay`

UI/UX design intelligence:

- `generate_ui_ux_design_system`: one product-specific direction with pattern, palette, typography,
  effects, anti-patterns, and optional bounded persistence to
  `.ai-dev/frontend/design-system.md`
- `query_ui_ux_knowledge`: focused local lookup by domain or implementation stack
- curated `ui-ux-pro-max` core pinned to an audited upstream commit; no network and no Python
  packages, but both tools above run the dataset's own Python script — the only tools that need
  Python 3 (`AI_DEV_PYTHON`); without it they say so and `doctor` marks `ui_ux_knowledge` skipped
- deterministic Russian-to-English query hints for common frontend concepts
- generated recommendations remain drafts; rendered UI and inspected browser evidence are required

Frontend Product Quality v2:

- `frontend_product_builder` selects one orchestrator, one mode specialist, and one quality skill
- `prepare_frontend_product`, `update_frontend_product_brief`, and `record_frontend_directions`
- `plan_frontend_references`, `register_frontend_references`, and `reference_factory_status`
  provide a two-stage Reference Factory when no approved external reference exists
- `record_frontend_concept_jury` requires independent dimension-level comparison before a generated
  direction can be approved
- `approve_frontend_direction` and `approve_frontend_design_system` enforce design-first state
- `frontend_product_gate` blocks stale approved documents and incomplete handoff evidence
- `run_visual_reference_qa` captures desktop/mobile plus named states and compares immutable baselines
- `record_visual_review` binds independent inspection and ten scorecard dimensions to artifact hashes

Reference Factory keeps the tool boundary honest. The MCP server writes a versioned manifest with
surface-specific prompts, dimensions, output paths, and prompt hashes. The client agent must call
ImageGen or Figma, save real PNG files, inspect every artifact, and then register the outputs.
Registration rejects missing or malformed PNGs, unsafe paths, low resolution, duplicate file hashes,
near-duplicate perceptual hashes across directions, stale prompt hashes, and uninspected images.

The first stage generates two or three compact concept sets. After one direction is approved, the
second stage generates complete route, viewport, and state baseline coverage only for that direction.
Design-system approval is blocked while this coverage is missing.

Search:

- `search_all`, `hybrid_search`, `preset_search`, `explain_search`
- `search_projects`, `search_notes`, `search_skills`
- `search_index_status`, `rebuild_search_index`, `run_search_eval`
- SQLite FTS + sparse aliases + local BGE-M3 + deterministic intent candidates
- canonical collapse prevents a skill card and its source from appearing as duplicate results
- Ranking v2 adds intent/scope boosts, source overlays, conflict penalties, hard negatives, mojibake
  repair, and per-result explanations

Verification:

- `run_quality_gate`: allowlisted argv commands, `shell:false`, bounded output and process trees
- `run_frontend_qa`: Playwright desktop/mobile, interaction journeys, console/network checks,
  overflow, axe accessibility, named-state screenshots, anti-slop diagnostics, and visual baselines
- `run_visual_reference_qa`: strict product QA that cannot pass without approved references and later independent review
- `system_health_check`: runtime, indexes, registries, routing benchmark, skills, projects,
  BGE-M3, Frontend QA, and optional smoke/eval checks

Knowledge:

- `search_knowledge`, `read_knowledge`
- `write_knowledge_note`, `append_knowledge_note`
- password notes are intentionally left unchanged and are not published as MCP Resources

Operations:

- `rebuild_system_dashboard`, `system_dashboard_status`
- `prepare_runtime_distribution`, `runtime_distribution_status`
- generated live dashboard, source-specific skill overlays, local CLI, local backup, and guarded
  future-VPS profile

## Resources

Fixed:

- `ai-dev://system/control-center`
- `ai-dev://system/dashboard`
- `ai-dev://system/architecture`
- `ai-dev://projects/index`

Templates:

- `ai-dev://projects/{name}`
- `ai-dev://skills/{name}`
- `ai-dev://tasks/{id}`

Resources are bounded views, not a dump of the vault.

## Prompts

- `format_project_for_ai`
- `start_engineering_task`
- `review_frontend_beta`
- `build_frontend_product`
- `generate_frontend_references`
- `refresh_project_context`

## Skill Quality

Skill Schema v2 separates three claims:

- `structure_status`: deterministic document readiness.
- `validation_status`: `provisional` until real evidence exists.
- `empirical_status`: verification-bound outcomes from actual tasks.

A custom skill is promoted to empirical `pass` only after at least three terminal task outcomes
across two canonical projects, pass rate at least 80%, and at least one human-confirmed review.
Repeated verification attempts for one task do not inflate the sample. `run_skill_routing_eval`
separately validates routing selection; it does not claim implementation success.

## Search Quality

Presets:

- `balanced`, `code`, `docs`, `skills`
- `projects`, `debug`, `frontend`, `quality`

Development presets use deterministic routing candidates before hybrid ranking. BGE-M3 remains
useful for concept/document retrieval, while intent routing prevents broad catalog pages from
displacing the exact workflow skill. Golden cases live in:

- `09-mcp/search-eval/search_eval_cases.json`
- `09-mcp/search-eval/skill_routing_eval_cases.json`

## Semantic search (BGE-M3)

Hybrid search works without a model: SQLite FTS, sparse aliases, and deterministic
intent routing are always on. The optional local BGE-M3 model improves concept and
document retrieval. The Docker image never bundles the weights; the launchers mount
the folder above them read-only at `/models`, and the image reads the ONNX export
from `/models/bge-m3-onnx`.

### From a source checkout

```bash
npm run setup -- --dense
```

That downloads the pinned ONNX export `Xenova/bge-m3` — five files, int8, each
checked against the sha256 in `models/bge-m3.manifest.json` — into
`~/.ai-dev/models/bge-m3-onnx` (`$BGE_M3_ONNX_DIR` overrides it), and then embeds
the documents already in the search index, Membrane connectors left out. The model
runs in Node through `onnxruntime-node`: no Python packages, no torch. Both halves
show progress and stop cleanly on Ctrl-C: the download keeps its `.part` and the
next run continues from that byte, the embedding stores every 64 documents and the
next run starts where it stopped. Adding notes later leaves them without a vector
until the next `npm run setup -- --dense`, which embeds only what changed.
`npm run dense:doctor` walks the model check stage by stage and names the one that
stopped.

### The model command

```bash
npm run model -- status            # installed, missing, stopped partway, where it downloads from
npm run model -- install           # download (resumable), then embed the documents
npm run model -- import <path>     # copy from a folder or a .zip made on another machine, then embed
npm run model -- verify            # hash every file against the manifest
npm run model -- remove            # delete the model's files and nothing else
```

`--dir <path>` works on another folder, `--mirror <url>` uses a Hugging Face mirror
for one run, `--no-index` skips the embedding, `--json` prints the result. Sources
are `AI_DEV_MODEL_MIRROR`, then `HF_ENDPOINT`, then huggingface.co, a failing one
handing its partial file to the next; `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`
are honoured without `NODE_USE_ENV_PROXY`. `AI_DEV_OFFLINE=1` forbids downloads,
leaving `import`. Exit codes: 0 done, 1 failed, 2 a usage mistake, 130 stopped with
Ctrl-C.

`AI_DEV_MODEL_MANIFEST` names another manifest pinned the same way — the tests point
it at a five-kilobyte stand-in for BGE-M3 (`src/core/synthetic-model.mjs`) and run
import, embedding and hybrid search through the real server with it.

An Intel Mac has no onnxruntime-node 1.30 build, so the model cannot run there:
`dense:doctor` and the health check say so, `setup -- --dense` refuses before
downloading, and keyword and sparse search work as everywhere else.

### Coming from the Python backend

2.x could embed with a Python virtualenv and torch (`--dense-python`,
`AI_DEV_DENSE_BACKEND=python`). 3.0 removed that backend. `npm run setup -- --dense`
moves an install over: it installs the ONNX model and embeds the documents again —
vectors made by the Python backend belong to another model, are never compared
with ONNX questions, and are replaced by this run. `--dense-python` still works as a
name for `--dense`; the old variables are no longer read, and the health check names
any that are still set. See
[INSTALL](../docs/INSTALL.md#coming-from-the-python-backend).

### With the Docker image

The default image already carries the ONNX runtime. Download the weights on the
host with `npm run model -- install --no-index`, then set `AI_DEV_MODEL_PATH` to the
folder *above* them — `~/.ai-dev/models` — and the launcher mounts it read-only as
`/models`.

## Frontend QA Config

Projects may define `.ai-dev/frontend-qa.json`:

```json
{
  "dev_command": "pnpm run dev -- --port 5173",
  "routes": ["/", "/pricing"],
  "viewports": [
    { "name": "desktop", "width": 1440, "height": 900 },
    { "name": "mobile", "width": 390, "height": 844 }
  ],
  "scenarios": [
    {
      "name": "submit form",
      "state": "success",
      "route": "/",
      "actions": [
        { "action": "fill", "selector": "#email", "value": "qa@example.test" },
        { "action": "click", "selector": "button[type=submit]" },
        { "action": "expect_visible", "selector": "[role=status]" }
      ]
    }
  ],
  "required_states": ["success"],
  "check_anti_slop": true,
  "check_accessibility_axe": true,
  "check_visual_regression": true,
  "max_pixel_diff_ratio": 0.01
}
```

Baseline replacement in ordinary diagnostic QA requires explicit `update_visual_baselines:true`.
Strict `run_visual_reference_qa` never updates approved baselines. A screenshot is machine evidence
only after independent inspection is recorded against its current hash.

## Security

- Path checks combine lexical containment and realpath/junction checks.
- File writes use per-file queues and atomic replace/append.
- Shell interpreters, shell operators, inline code, dynamic `npx`, and network commands fail closed.
- Windows npm/pnpm shims resolve to their Node entry point; `cmd.exe` is not used.
- Project tests execute project code. Use a container or disposable VM for untrusted repositories.
- Deploy, publish, migrations, production flows, and account mutations are outside automatic gates.

See `docs/SECURITY.md`.

## Installation

Pinned dependencies, then the first run:

```bash
npm ci
npm run setup
```

`npm run setup` builds what a clone does not ship — the skill registry, the
SQLite search index and the skill-routing benchmark — and ends with the health
check, so what is still missing is on the screen. It reaches the network only
when asked: `--frontend-qa` installs the Frontend QA runner's lockfile with the
pnpm it pins and then Playwright's Chromium, and passes only when that browser
launches; `--dense` downloads the pinned ONNX export of BGE-M3 (no Python packages) and
embeds the index with it. Everything it builds is idempotent, and anything that has
gone out of date since is rebuilt rather than skipped.

Or restore both MCP and Frontend QA runtimes (`../scripts/restore-runtime.ps1`) — it prefers
`node` / `npm` / `pnpm` on `PATH` and falls back to a bundled Codex runtime only if one is present.

Environment overrides:

```text
AI_DEV_VAULT_ROOT   absolute path to the Obsidian vault (required outside the repo)
AI_DEV_HOME         runtime-data root (default ~/.ai-dev)
AI_DEV_STATE_ROOT   task/outcome/pilot state (default $AI_DEV_HOME/state)
AI_DEV_SEARCH_INDEX_DIR   search index dir (default $AI_DEV_HOME/cache/search-index)
AI_DEV_FRONTEND_QA_ARTIFACT_ROOT   QA artifacts (default $AI_DEV_HOME/artifacts/frontend-qa)
AI_DEV_PYTHON       python for the two UI UX Pro Max tools (default: python3; python on Windows)
BGE_M3_ONNX_DIR     ONNX embedding model dir (default $AI_DEV_HOME/models/bge-m3-onnx)
AI_DEV_MODEL_MIRROR Hugging Face mirror tried first for the model (HF_ENDPOINT format)
AI_DEV_MODEL_MANIFEST  another pinned manifest instead of models/bge-m3.manifest.json
AI_DEV_OFFLINE      1 forbids model downloads; `npm run model -- import` still works
HTTPS_PROXY / HTTP_PROXY / NO_PROXY   honoured by the model download
```

`AI_DEV_HOME` is the runtime folder itself: `state/`, `cache/` and `models/` sit directly in
it. Earlier versions put them one level deeper, in `$AI_DEV_HOME/.ai-dev` (docs/DEFECTS.md,
Д-90). The server, `npm run setup` and the `ai-dev` CLI move such a tree up when they start:
files missing at the new place are moved, identical ones dropped, JSONL ledgers appended, and a
file that differs on the two sides stays where it was. `npm run doctor` names what is left in its
`runtime_home` check, and `state/runtime-home-migration.json` records every run that found something. `AI_DEV_HOME`
set to your home directory itself keeps meaning `~/.ai-dev`, as it did. Hooks installed into a
repository by an earlier version still look for the old tree; run `install_agent_hooks` again
to update them.

## Docker

The repository ships a local-only, non-root Docker runtime with Chromium, the search index, a clean
public skill seed, persistent local state, and no network listener. It is built from a generated
allowlist context rather than from the Vault or repository root.

```bash
node scripts/prepare-docker-context.mjs
docker build --tag ai-dev-system:local ../.docker/build-context
node scripts/docker-smoke.mjs --image ai-dev-system:local
```

Passwords, project contexts, task history, indexes, models, caches, logs, backups, `.codex`,
`.ai-dev`, `.obsidian`, and Git history are excluded by policy and audited before every build.
Repositories are visible only when the user explicitly mounts a selected path under `/workspace`.

See [the complete Windows, macOS, Linux, client configuration, Compose, BGE-M3, and GHCR guide](../docker/README.md).

## Acceptance

Fast:

```powershell
..\scripts\run-acceptance.ps1
```

Including the full BGE-M3 golden suite:

```powershell
..\scripts\run-acceptance.ps1 -IncludeDense
```

The suite runs MCP unit tests, real stdio negotiation, lifecycle smoke, real Chromium Frontend QA,
coverage thresholds, static modularity checks, and local security checks.

## Local Operations

```bash
./scripts/start-local.ps1   # or: node src/server.mjs
node scripts/ai-dev.mjs doctor
node scripts/ai-dev.mjs dashboard
node scripts/ai-dev.mjs reindex
node scripts/ai-dev.mjs refresh --full
node scripts/ai-dev.mjs distribution
```

Install or refresh the same local stdio server for Cursor, Gemini Code Assist, native VS Code MCP,
and Claude Code. Existing JSON files are merged and backed up before they are changed:

```bash
node scripts/install-local-mcp-clients.mjs           # dry run
node scripts/install-local-mcp-clients.mjs --apply
```

Client configurations point to this repository's `src/server.mjs` (set `AI_DEV_VAULT_ROOT` to
override the vault root) and to `node`; the Python they name is used by the two UI UX Pro Max
tools alone. Restart or reload each client after
installation. Any model selected inside an MCP-capable client can use the same tools; a raw model
endpoint still needs an MCP-capable host.

The shipped runtime profile is local stdio. A future remote profile is configuration scaffolding,
not an enabled network server: remote mode remains blocked until TLS, authentication, allowlists,
rate limits, and threat review are implemented.

## Backup And Recovery

```powershell
..\scripts\backup-ai-dev-system.ps1 -Label before-upgrade
..\scripts\restore-ai-dev-system.ps1 -Archive <backup.zip> -TargetRoot <empty-folder> -ConfirmRestore
```

Backups contain local vault content, including owner-kept private notes. They remain local and must
not be pushed to a public repository.

See `docs/RECOVERY.md`.
