# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Twelve agent-workflow upgrades, ported from ECC (Everything Claude Code) and
  reshaped for this server. New capabilities, all reachable as MCP tools:
  - **Extension registry** (`src/tool-extensions.mjs`): tools now live in
    `src/extensions/*` as `createXxxTools(host)` factories instead of growing
    `mcp-stdio.mjs`, which is capped at 10,500 lines by the static gate.
    Duplicate names and missing handlers fail at startup.
  - **Decision ledger** (`record_decision`, `list_decisions`): ADR-lite records
    under `.ai-dev/decisions`, folded into the compiled context pack.
  - **Usage ledger** (`record_usage`, `usage_report`): per-tool call telemetry
    plus token and cost accounting reported by the client or the runner.
  - **Change hygiene** (`verify_change_hygiene`): diff scanner for secrets,
    focused/skipped tests, `debugger`, conflict markers and weakened linter
    configuration; runs as part of `verify_task`.
  - **Task worktrees** (`begin_task_in_worktree`, `list_task_worktrees`,
    `remove_task_worktree`): one isolated git worktree per task.
  - **Rules library** (`list_rule_packs`, `install_project_rules`): a catalogue
    of engineering rules (common plus stack packs with `paths:` scoping),
    projected into `.claude/rules`, `.cursor/rules/*.mdc` and `AGENTS.md`.
  - **Plan gate** (`plan_task`, `plan_status`): task-complexity classification
    with a plan required before large or risky work starts.
  - **Session memory** (`save_session`, `resume_session`,
    `context_budget_status`): structured handoffs and a context budget.
  - **Instincts** (`record_instinct`, `list_instincts`, `update_instinct`,
    `evolve_instincts`, `export_instincts`, `import_instincts`): learned
    preferences with confidence, decay, promotion to global and evolution into
    skills.
  - **Agent hooks** (`install_agent_hooks`, `agent_hooks_status`): an
    installable hook pack for Claude Code and Cursor — command/file guard,
    session start and end, pre-compact, post-edit formatting and a stop check —
    configured by `.ai-dev/policy.json` profiles.
  - **Five seed skills** plus an updated `ai-dev-orchestrator`:
    `verification-loop`, `silent-failure-hunter`, `planner`,
    `security-reviewer` and `memory-curator`.

- Archify diagram capability: nine typed MCP tools for local validation,
  rendering, delivery receipts, browser checks, comparisons, migrations, and
  brand references; the clean Docker seed now carries its pinned runtime for
  offline operation. Diagram-request detection (routing, recommendations, and
  acceptance criteria) is a single shared pattern that excludes database and
  API schema work. Delivery-receipt verification enforces the full showcase bar
  (profile, zero errors/warnings, all checks, artifact hash) before an
  acceptance criterion is marked met.
- `docs/ARCHIFY.md`, integration notes, and third-party notices for the
  vendored Archify package and its runtime dependencies.
- `.github/` issue and pull-request templates and a `dependabot.yml` for npm,
  pip, and GitHub Actions updates.
- Stable Homebrew tap formula source for `v1.0.0`, validation of AUR `.SRCINFO`,
  and documented maintainer-only publication paths for `stonebridgeway/tap` and
  `ai-dev-system-git`.
- Windows CI job (`windows-latest`): parses every PowerShell script, runs
  `bootstrap.ps1 -Plan`, exercises the client installer's win32 path handling,
  and runs the core unit suite. The Windows install path had no CI coverage
  before.
- **Selective skill import** (`import_skill_repo` with `select_skills: true`,
  `src/core/skill-import-policy.mjs`): imports only the `skills/<name>`
  directories of an upstream catalogue that pass four gates — taxonomy
  exclusions with a cited reason, a name already owned by a local skill (ours
  wins), the public-seed privacy audit, and a minimum quality score
  (`min_quality_score`, default 75). `dry_run: true` reports the plan without
  writing. The result and the generated `upstream.json` record how many skills
  were imported and why each of the rest was left out.
- **ECC skill catalogue** as `external/ecc` (`docs/ecc-upgrades/PLAN.md`, item
  3.1): 101 of ECC's 291 skills (MIT, pinned to a commit), among them
  `tdd-workflow`, `api-design`, `contract-first`, `hexagonal-architecture`,
  `intent-driven-development`, `database-migrations`, `error-handling`,
  `production-audit` and the language `*-patterns` / `*-testing` families. They
  carry `trust_level: known-upstream` and `instruction_policy:
  data-until-review`, declared in `upstream.json` and reported by
  `recommend_skills`: their text is reference material until someone reviews it,
  not instructions to follow on sight. 190 skills were left out — 168 by
  taxonomy rule, 17 below the quality floor, 4 for a privacy-audit finding, and
  ECC's `verification-loop`, whose name our custom skill already owns.
- Cost capture and a model rate table, so a session's spend is visible without
  the client reporting anything:
  - **`cost-capture.mjs`**, an eighth hook, registered on `Stop` at every
    profile. It sums the `usage` of the assistant messages a transcript gained
    since the last run — subagent turns included, since they are billed the
    same — and appends one `kind: "usage"` event per model to the usage ledger,
    writing the file directly so it works while the server runs in Docker. A
    byte cursor per session (`state/usage/sessions/<session>.json`) keeps the
    same message from being billed twice however often `Stop` fires, and a
    transcript that shrank is read from the top again.
  - **`RATE_TABLE`** in `core/usage-ledger.mjs`: published USD per million
    tokens per model, read from Anthropic's pricing page on the date recorded
    in `RATE_TABLE_SOURCE`, with the cache multipliers (5-minute write 1.25x,
    1-hour write 2x, read 0.1x) filling the rows that do not state their own.
    Prices change, so `model_rates` in `.ai-dev/policy.json` overrides or adds
    any row per project.
  - **`usage_report`** now returns the `today` / `yesterday` / `last_7_days`
    slices alongside the per-model and per-task totals, and estimates cost from
    the rate table wherever the client reported none — a reported cost still
    wins, and a model the table does not know is listed under
    `rates.unpriced_models` instead of counted as free. Pricing happens at read
    time, so a price change re-prices history rather than freezing a stale
    number into the ledger.
- **`prepare_pull_request`**, a new tool in `src/extensions/pull-requests.mjs`,
  writes the pull request description a task has already earned. It reads the
  task record — goal, acceptance criteria with their status and evidence,
  checkpoints, the latest `verify_task` run and the checks it executed,
  recorded decisions, the plan — and the repository diff against the base
  branch, then writes `.ai-dev/pr/<task_id>.md` and returns the text.
  - The repository's own template is filled, not ignored:
    `.github/pull_request_template.md` and the usual variants (including a
    `PULL_REQUEST_TEMPLATE/` directory) are discovered, each heading it
    recognises receives the matching evidence, headings that belong to the
    author — a checklist, a "type of change" list, screenshots — keep their
    text, and generated sections that matched no heading are appended so no
    evidence is dropped.
  - Changed files are listed by group (tests, CI, docs, configuration, assets,
    source) with their status, alongside the commits on top of the base and the
    checks that ran — including the ones that did not.
  - Acceptance criteria that are not met, a failed or missing verification and
    blocking hygiene findings go into an "Outstanding" section, so an unfinished
    change cannot look finished.
  - It pushes nothing and opens nothing: `git push -u` and
    `gh pr create --body-file` come back as text for a human to run.
  - `complete_task` prepares the same file at completion and links it from
    `next_step` (`prepare_pull_request: false` opts out).
- **Completion-statement linter** (`src/core/completion-claims.mjs`): the
  `summary` and `notes` of `checkpoint_task` and `complete_task` are now held to
  the evidence behind them. Twelve rationalizations — "pre-existing issue",
  "skipping tests for now", "tests are failing but I'll fix them later", "works
  on my machine", "should work", "untested", "flaky", "disabled the lint rule",
  an untracked TODO, "good enough for now", "didn't check the UI", "verified
  manually" — each name the gate that would settle them (`quality_gate`,
  `change_hygiene`, `frontend_qa`, or the latest `verify_task` run).
  - A rationalization over a gate that did not pass, or never ran, is refused
    before anything is recorded; the error names the rule, the gate, the quoted
    phrase and the ways out. Over a passing gate the same wording is only a
    warning, returned in the new `completion_claims` field of both tools.
  - The rule table is data, and `.ai-dev/policy.json` is the knob:
    `completion_claims.enabled: false` turns the linter off, and a waiver
    (`{ rule, reason, expires? }`, `"*"` for all rules) turns off one rule where
    the reason is real — it applies only when the report states that reason too.
    An unknown rule, a reason under 20 characters, an unreadable date or invalid
    JSON leaves the linter on and says so in `completion_claims.warnings`.
  - New seed skill **`self-evaluation`** (quality score 100): five axes scored
    with quoted evidence, a "claim → what backs it" table for eleven sentences
    reports actually contain, and a post-action for each average band.
    `ai-dev-orchestrator` and `verification-loop` route to it before
    `complete_task`.
- **Documentation freshness** (`docs_stale` in `verify_change_hygiene`): a
  change set that moves the public interface — a new export, an `inputSchema`,
  a command-line flag, in JavaScript, TypeScript, Python, Go, Rust, Java,
  Kotlin, C#, Swift, PHP or a shell script — without touching a single document
  is now a `warn` finding listing the files that did move.
  - Only declarations count. A line inside an exported function does not widen
    the interface, and a flag passed to someone else's program (`--no-color` to
    `git`) is not a flag the project offers, so neither fires the rule.
  - Tests, vendored trees (`node_modules/`, `vendor/`, `dist/`) and the
    documentation itself are not read for interface signals; data files are
    left out too, since a schema key in JSON is as often a fixture as a
    contract. Any `.md`, `.mdx`, `.rst`, `.adoc`, `.txt` or file under `docs/`
    answers the finding, `README.md` and `CHANGELOG.md` included.
  - `summary` gained `interface_files` and `documentation_files`.
- **Task snapshots and rollback** (`src/core/task-snapshots.mjs`,
  `src/extensions/snapshots.mjs`): `snapshot_task`, `list_task_snapshots` and
  `rollback_task` make an agent's turn undoable. A snapshot records the whole
  working tree of a task — tracked changes, staged or not, plus the files the
  agent created — as one commit object no branch points at, held by a ref under
  `refs/ai-dev/snapshots/<task_id>/<n>`.
  - Nothing is written to the user's branch, stash or index. `.gitignore` and
    `.git/info/exclude` decide what a snapshot carries, so dependencies and
    build output are neither stored nor touched.
  - `rollback_task` restores the snapshot's files and removes the ones that
    appeared since, emptied directories included. It snapshots the state it
    replaces first, so a rollback is itself reversible; the snapshot is named by
    id (`snapshot-3`), number, or commit.
  - `checkpoint_task` snapshots the turn it records (`snapshot: false` opts out;
    a project without git reports a reason instead of failing), and
    `complete_task` deletes the closed task's snapshots, reporting how many in a
    new `snapshots` field. The entries stay on the record, marked, so the turns
    remain readable. Automatic snapshots are capped at 50 per task; ones taken
    by name are kept until the task closes.

### Fixed

- The agent hook pack is now a working implementation rather than a condensed
  port. Three hooks did nothing at all before:
  - **File guard.** In `guard.mjs` the `else` branch holding every file-mode
    check was chained to the `if` *inside* the loop over shell patterns, so in
    `file` mode — where that loop never runs — the secret-bearing-file,
    secret-in-content and protected-configuration checks were unreachable.
    File mode now has its own branch and its own tests.
  - **Compaction advisor.** `compact-advisor.mjs` counted tool calls in a
    module-level variable, but the hook is a fresh process per call, so the
    counter was always 1 and the advisor never fired. The count is now
    persisted per session, and the primary signal is the real context size read
    from the transcript's most recent `usage` record, compared against the
    model's window.
  - **Session-end extraction.** `session-end.mjs` wrote a fixed stub record
    ("Hook-captured session") whatever the session contained. It now distils
    the transcript into user requests, tools used and files modified, and
    writes nothing when there is nothing to record.

### Changed

- The main module's line ceiling dropped to match what the extractions left
  (stage 1.7, which closes stage 1). `SYSTEM_LINE_CEILING` in
  `core/system-health.mjs` — the one place the gate and the System Dashboard
  both read — went from 10,150 to 5,076: the file's actual 4,776 lines plus 300
  of working room. The ratchet holds in one direction, so `mcp-stdio.mjs` can be
  edited but not re-grown; new capabilities belong in `src/extensions/`.
  - All five line-budget rules were verified by breaking each one deliberately
    against a throwaway module and reverting: an unpinned module over 800 lines,
    a pinned module grown past its allowance, a pinned module back under the
    ceiling, a `MODULE_LINE_EXCEPTIONS` entry whose module is gone, and the main
    module over its own ceiling. Both real pinned entries stayed:
    `core/frontend-product-quality.mjs` (1,222) and `core/reference-factory.mjs`
    (812) are still over the ceiling, and the comment claiming stage 1.3 would
    split them was corrected — that step built on top of them rather than out of
    them.
  - A system-health fixture pinned at a literal 9,800 lines became
    `SYSTEM_LINE_CEILING - 350`, so it keeps meaning "inside its budget" whatever
    the ceiling is.
- The task lifecycle moved out of `mcp-stdio.mjs` (stage 1.6 of the modularity
  plan, the last extraction step). `begin_task`, `checkpoint_task`, `verify_task`
  and `complete_task` became `src/extensions/lifecycle.mjs`, and the judgements
  under them became two tested modules in `src/core`: `task-verification.mjs`
  (whether a run passed, and which acceptance criteria it is evidence for) and
  `task-completion.mjs` (the completion note and what is left to do with the
  branch). Everything the four tools drive — the completion-claims linter, the
  plan gate, change hygiene, the context pack and its extras, evidence binding,
  skill outcomes, the Archify receipt store and the project-card writers —
  arrives through the extension host, and the four sibling tools they call
  (`recommend_skills`, `run_quality_gate`, `run_frontend_qa`,
  `prepare_pull_request`) arrive as host wrappers over the registry rather than
  through `callTool`, so a composed run still records one usage-ledger entry for
  the tool the client asked for and none for the work it delegated. Tool
  behaviour, response bytes, generated project and vault files, the task and
  usage state on disk, and the 116-tool list are unchanged; `mcp-stdio.mjs` lost
  a further 458 lines (5,233 → 4,775), which leaves it 5,243 lines below the
  10,018 it started at and past the plan's target of under 6,000.
  - `ARCHIFY_EVIDENCE_SCHEMA` left `tool-definitions.mjs` with the two tools
    that used it, so no tool definition is now shared across the two files.
- Project work moved out of `mcp-stdio.mjs` (stage 1.5 of the modularity plan).
  `run_quality_gate` became `src/extensions/projects.mjs`, and the pure half of
  project handling became four tested modules under `src/core`:
  `project-detection.mjs` (`detectProject` over an injected filesystem),
  `project-cards.mjs` (the registry card renderer and its section reader),
  `project-markdown.mjs` (the tables, bullet lists and section readers every
  generated project document shares) and `quality-gate-runner.mjs` (parsing a
  gate file, choosing what to run, and the verdict over a run). `detectProject`
  is a service rather than a tool — `begin_task`, `compile_project_context`, the
  card writers and four extensions call it — so it stays on the extension host;
  `mcp-stdio.mjs` binds it to the real filesystem and nothing else. Tool
  behaviour, response bytes, generated project and vault files, and the 116-tool
  list are unchanged; `mcp-stdio.mjs` lost a further 1,191 lines (6,424 → 5,233).
  - `detectProject` reads its filesystem through injected functions, so stack
    detection, the command fallbacks and the risk rules are now tested against a
    fixture tree instead of a repository on disk.
  - Two symbols no longer referenced by anything went with the move: a second
    `markdownList` and `buildProjectCardMd`, the flat card renderer that
    `buildRichProjectCardMd` replaced.
- Search moved out of `mcp-stdio.mjs` (stage 1.4 of the modularity plan). All
  thirteen search tools became `src/extensions/search.mjs`, over four modules in
  `src/core`: two services — `search-index.mjs` (the sqlite index, its freshness
  and the hybrid merge) and `embedding-workers.mjs` (the BGE-M3 worker pool and
  the one-shot fallback) — and two pure ones, `search-runtime.mjs` (presets,
  weight normalization, score explanations) and `search-eval.mjs` (the
  golden-case verdicts and ranking metrics). `csvValue` joined
  `core/text-format.mjs`. Both services are built once by `mcp-stdio.mjs` and
  shared: the system extension's health checks and every writer that calls
  `markSearchIndexDirty` reach them through the host. Tool behaviour, response
  bytes, generated vault files and the 116-tool list are unchanged;
  `mcp-stdio.mjs` lost a further 1,354 lines (7,778 → 6,424).
  - Both services take their process launchers as dependencies, so the worker
    protocol, the index freshness logic and the hybrid merge are now tested
    against stubs instead of a Python runtime and a 1024-dimension model.
- Frontend tools moved out of `mcp-stdio.mjs` (stage 1.3 of the modularity plan).
  Six tools left with their definitions, split by what they are for:
  `src/extensions/frontend-design.mjs` carries the Reference Factory
  (`plan_frontend_references`, `register_frontend_references`) and
  `generate_ui_ux_design_system`; `src/extensions/frontend-qa.mjs` carries
  `run_frontend_qa`, `run_visual_reference_qa` and `record_visual_review`. Their
  pure half became two tested modules under `src/core`:
  `reference-factory-artifacts.mjs` (manifest file paths, the registry entry, PNG
  structure and the artifact verdicts) and `frontend-qa-report.mjs` (the runner's
  input contract, the Markdown report, the review artifact list and the strict
  visual verdict). `mdCell` joined `core/text-format.mjs`. The frontend product
  state readers stay in `mcp-stdio.mjs` and reach the extensions through the
  host, because `compile_project_context`, `verify_task` and the product tools
  that have not been extracted yet all read them. Tool behaviour, response bytes,
  generated project and vault files, and the 116-tool list are unchanged;
  `mcp-stdio.mjs` lost a further 1,048 lines (8,826 → 7,778).
  - `run_frontend_qa`, `run_visual_reference_qa` and `record_visual_review` now
    have tests in a standalone checkout: the extension is driven against a
    deterministic stand-in for the browser runner, so the orchestration around
    Playwright is covered where the live-browser test is skipped.
- Skill registry tools moved out of `mcp-stdio.mjs` (stage 1.2 of the modularity
  plan). `rebuild_index`, `validate_skill_library` and `recommend_skills` are now
  one extension, `src/extensions/skills.mjs`, reaching the vault, the collectors
  and the embedding backend through the extension `host`; their definitions moved
  with them out of `tool-definitions.mjs`. The pure half became five tested
  modules under `src/core`: `skill-catalog.mjs` (generated-note paths and the
  item predicates), `skill-cards.mjs` (card rendering), `skill-registry-docs.mjs`
  (registry files and their Markdown), `skill-quality-report.mjs` (the validation
  verdict and its dashboard), `skill-recommendation.mjs` (task intent and
  ranking), plus `text-format.mjs` for the text primitives they share.
  `applySkillOverlays` joined `src/core/skill-overlays.mjs`. Tool behaviour,
  response bytes, generated vault files and the 116-tool list are unchanged;
  `mcp-stdio.mjs` lost 1,192 lines (10,018 → 8,826).
- Session and instinct memory is shared across the worktrees of one clone.
  `repository_id` is now derived from `git rev-parse --git-common-dir` (plus the
  project's path inside its worktree), which is identical in the main checkout
  and in every linked worktree, and `SessionStore`, `InstinctStore`, the
  context-extra providers and the `session-start` / `session-end` hooks key
  memory by it — so a handoff saved inside a `begin_task_in_worktree` worktree
  resumes from the main checkout and back. Tasks stay keyed by `project_id`, so
  they remain bound to the working tree they were started in. Records written
  under the old `project_id` are still read and move to the repository key on
  the first write. `repository_id` was previously a hash of the `origin` remote,
  which is still reported as `git.remote` by `project_identity`.
- Package-manager split is now explicit: `packageManager` fields plus a
  `CONTRIBUTING.md` policy section pin `ai-dev-mcp-server/` to npm and
  `frontend-qa/` to pnpm. `resolveSpawnInvocation` no longer silently runs an
  npm command through a bundled pnpm entrypoint — it fails closed instead.
- `npm run docker:audit` now prints a clear "run `npm run docker:prepare` first"
  message when the build context is missing, instead of an `ENOENT` stack trace.
- Minimum Node.js is now 22.12 (was 24). No Node 24-only API is used; `.nvmrc`
  pins `22`, `bootstrap.ps1` accepts 22.12+, and CI adds a Node 22.12 floor job
  (lint + core tests) alongside the Node 24 gate.

### Fixed

- The test suite is isolated from the developer's real `~/.ai-dev` tree: every
  `node --test` run loads `test/setup.mjs`, which pins the `AI_DEV_*` runtime
  roots (task/skill/pilot state, search index, Frontend QA and Archify
  artifacts, model dir) to a throwaway temp directory and exports
  `PYTHONDONTWRITEBYTECODE=1`.
- Python helpers (`search_cli.py`, `bge_m3_worker.py`, `bge_m3_embed.py`, the
  UI/UX Pro Max search script) run with `-B`, so `query_ui_ux_knowledge` and
  friends no longer drop `__pycache__/*.pyc` into the checked-in public seed and
  break the next `npm run docker:prepare`.
- `copyDistributionTree` skips forbidden runtime directories (`__pycache__`,
  `.venv`, `node_modules`, …) while copying, so a stray directory left behind by
  a local tool run can no longer fail the Docker context privacy audit.

### Fixed

- Privacy-audit term gathering no longer aborts when `os.userInfo()` throws.
  `ownerUsername()` falls back to `USER` / `USERNAME` / `LOGNAME`, so
  `bootstrap.sh --build-local` (which runs the context scripts inside
  `docker run --user "$uid:$gid"`) works on macOS and on any Linux host whose
  uid is not the image's baked-in `1000`.

### Fixed

- Command policy (`run_quality_gate` / `verify_task` / Frontend QA dev servers)
  now positively allowlists every argument: it rejects code-loading and
  output-redirecting flags (`--require`, `--import`, `--loader`,
  `--test-reporter`, `-c`/`-e`/`-p`, `--config`, `--prefix`/`--dir`/`--cwd`,
  `--output`, `go test -exec`, `cargo test --config`, …), inline Python fused
  with `-c` (`python "-cimport os;…"`), Python scripts referenced by absolute
  path or `..`, package-script "names" that are file paths, and `git diff
  --check` with any flag other than `--cached`/`HEAD`. Executables and path
  operands must resolve inside the project; `validateProjectExecutable` now also
  rejects relative executables (`../../tmp/evil/pytest`), not just absolute ones.

### Fixed

- `path-policy` no longer lets a write pass through a symlink whose target lives
  outside the trusted root: a final-component symlink is `lstat`-checked, and a
  dangling one is rejected with a `PathPolicyError` instead of being treated as
  a new file. The async `resolveWithin` now raises a `PathPolicyError` (not a
  raw `ENOENT`) when a dangling link or a missing path is read.

### Fixed

- Completion evidence is now bound to file *contents*, not just `git status`
  output: `captureProjectState` hashes every dirty/untracked file into the
  fingerprint, so editing an already-dirty file after `verify_task` invalidates
  the evidence. A non-git project directory now gets a real bounded
  `path/size/mtime` fingerprint (strength `medium`) instead of a constant hash
  of its path.
- `complete_task` now honours **only the most recent** verification: it must
  exist, must have passed, and must match the current project fingerprint. A
  later failed run, an edit after the last passing run, or a second completion
  of an already-complete task is refused with a specific message.

### Fixed

- `execFileWithInput` (Frontend QA runner, UI/UX helper) now bounds captured
  output at 16 MiB, kills the whole process group on timeout or overflow so a
  Playwright Chromium or dev server is not orphaned, guards against a
  double-settle, ignores `stdin` `EPIPE`, and decodes stdout/stderr from a
  buffer so multi-byte characters are no longer corrupted at chunk boundaries.

### Fixed

- `ensureSearchIndex` claims the in-flight refresh slot before its first
  `await`, so concurrent search calls join one rebuild instead of each
  starting their own `search_cli.py rebuild` on the same SQLite file. A
  "dirty" reason raised while a rebuild is running is no longer cleared, so
  the next search still rebuilds.

### Fixed

- `verify_task` no longer trusts client-supplied Archify quality numbers. Every
  real `archify_deliver` / `archify_visual_check` run now writes a server-owned
  receipt (keyed by the artifact's SHA-256) under
  `~/.ai-dev/state/archify-receipts`; delivery-criterion validation hashes the
  file on disk, looks up that receipt, and evaluates the showcase bar against
  the recorded numbers. A forged evidence entry with no matching receipt fails
  the check.

### Fixed

- The skill-outcome and pilot stores no longer strand every future write after a
  single failed `update` (for example a transiently corrupt state file): the
  internal serialisation chain is always recovered, while the failing caller
  still sees the real error.

### Fixed

- Hybrid search no longer fails when the local BGE-M3 dense backend is missing.
  `hybrid_search`, `preset_search`, `explain_search`, and `run_search_eval` now
  pre-check the worker script, Python runtime, and model weights, fall back to
  keyword/sparse ranking, and report a `dense_available: false` warning instead
  of throwing "BGE-M3 Python runtime not found". Keyword-only ranking can be
  forced with `AI_DEV_DENSE=off`.

### Fixed

- A crashed BGE-M3 embedding worker no longer takes the whole MCP process
  down: `getBgeWorker` handles `stdin` `error` (EPIPE), a worker that reported
  a failed model load is rejected immediately instead of after the request
  timeout, and idle workers are reaped after ten minutes.

### Fixed

- `verify_change_hygiene` findings now use one shape everywhere:
  `{ rule, severity, file, line, message, excerpt }`. The tool returned `code`
  and `path` while the docs and the `verification-loop` skill spoke of `rule`
  and `file`, so an agent following the skill read `undefined`. `excerpt` is
  always present, a schema test pins the field list, and the docs, the tool
  description and the skill were corrected.

### Fixed

- `save_session` accepts both spellings of the failure reason. ECC's
  save-session prompt (and the example in `docs/ecc-upgrades/09-session-memory.md`)
  writes `failed: [{ approach, why }]` while the schema said `reason`, so the
  explanation was silently dropped and `resume_session` printed "reason not
  recorded". `why` is now normalized into `reason`; the examples and the file
  states in them (`status`, not `state`) match the schema.

### Fixed

- `usage_report` counts every tool call, not only the ones that arrived over
  MCP. Recording moved from the `server.mjs` transport into `callTool` itself,
  so calls from `scripts/ai-dev.mjs`, the smoke scripts and tools composed from
  other tools are in the ledger too; the transport only passes its own overhead
  as `transportMs`. One call is still exactly one event — pinned by a test that
  compares a direct call, a call through the transport, and a failure.

### Added

- `install_project_rules` target `claude-md`: instead of copying the rules into
  `.claude/rules`, it writes an `## Engineering Rules` section into `CLAUDE.md`
  that imports the canonical files with `@.ai-dev/rules/common/<rule>.md`, which
  Claude Code expands at session start. One line per file, because an import is
  a path and not a glob; path-scoped packs stay listed as plain paths. The
  target is opt-in — it replaces the `claude` target rather than adding to it,
  and asking for both returns a warning.

### Fixed

- The agent hook tests run in the Windows CI job, and the hooks work there. The
  pack runs on the developer's machine, so Windows is a first-class target:
  `.github/workflows/ci.yml` gained an "Agent hook tests" step
  (`src/core/agent-hooks.test.mjs` and `src/extensions/hooks.test.mjs`), and
  three Windows-only path bugs are fixed rather than skipped.
  - `projectRootOf` resolves the root with `fs.realpathSync` instead of
    `fs.realpathSync.native`. The server resolves it with `fs.realpath`, and the
    native variant additionally expands 8.3 short names on Windows
    (`RUNNER~1` → `runneradmin`), so hook and server keyed two different
    `project_id`s for the same repository — the hook's handoffs and instincts
    landed where the server never looked.
  - Project paths are compared with a new `samePath` helper (case- and
    separator-insensitive on Windows), so `session-start` and `stop-check` find
    the project's open tasks.
  - `session-end` writes repository-relative paths with `/` separators, so a
    captured handoff lists `src/login.js`, not `src\login.js`.
  Temp-directory cleanup in those tests retries, because Windows holds handles
  on freshly written git objects for a moment.

### Fixed

- Intermittent failure in `src/extensions/system.test.mjs` (roughly two runs in
  ten under load): the fixture wrote the skill-routing report before the eval
  cases it is compared against, so whenever the two writes landed in different
  milliseconds the `skill_routing_benchmark` check called the report stale, that
  critical check failed, and the health status came out `fail` instead of
  `degraded`. The cases are written first now.

## [1.0.0] - 2026-09-01

First tagged release.

### Added

- Local `stdio` MCP server (`@modelcontextprotocol/sdk`) exposing repository
  context, a knowledge base, a managed skill library, hybrid search, quality
  gates, Frontend QA, and a verifiable task lifecycle
  (`begin_task` → `checkpoint_task` → `verify_task` → `complete_task`).
- Hybrid search: SQLite FTS, sparse aliases, deterministic intent candidates, and
  an optional local BGE-M3 reranker.
- Public skill seed under `docker/public-seed` (system rules, prompts, quality
  gates, custom workflow skills, MIT-licensed design knowledge).
- Multi-arch Docker image published to GHCR with SBOM and provenance, a hardened
  default runtime (no network, non-root, read-only rootfs, no capabilities), and
  an allowlisted build context that never includes a personal vault.
- Cross-platform bootstrap (`bootstrap.ps1`, `bootstrap.sh`), a fast-start
  launcher / `ClaudeMcpProxy`, Arch `PKGBUILD`, and a Homebrew formula.
- `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/RECOVERY.md`; JSDoc types for
  every exported `src/core` function; ~86% line coverage on `src/core`.
- CI: static-quality, security, packaging, and vault-free unit gates (`ci.yml`);
  a `vault-suite` job runs the full vault-coupled test suite plus the protocol and
  lifecycle smokes against the bundled seed; privacy-policy, context-audit,
  image-build, and GHCR publish (`docker-publish.yml`).
- `npm run skills:ensure-index` / `scripts/ensure-skill-index.mjs`: builds the
  bundled seed's skill registry on demand so a standalone checkout can route
  skills.
- English `README.md` (Russian preserved at `README.ru.md`), and root
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and this changelog.
- BGE-M3 weight-download instructions for the source and Docker paths.
- `.nvmrc` pinning Node 24.

### Changed

- Agent-neutral runtime: regenerable data resolves under `~/.ai-dev`
  (`AI_DEV_HOME`) with per-directory `AI_DEV_*` overrides and a `~/.codex`
  fallback for migrated installs. Launchers, helper scripts, the Docker image,
  and the client installer use `node` / `python3` from `PATH`. Documentation and
  the shipped `mcpServers` snippet are client-neutral.
- Vault root resolution: a checkout with no full vault falls back to the bundled
  `docker/public-seed`, so the server and tests work from source without
  `AI_DEV_VAULT_ROOT`. `npm run check` provisions the seed skill registry first,
  so it passes on a fresh clone.

### Fixed

- Vault-coupled tests that require the full production skill catalog or the
  Playwright frontend-qa runner now `skip` when those fixtures are absent instead
  of failing a standalone checkout.
- `buildDockerClientServerConfig` resolves `AI_DEV_PROJECT_PATH` with the path
  API for the requested `platform`, so a Windows client config generated on a
  non-Windows host is no longer mangled; the installer tests pin `platform`
  explicitly instead of relying on `process.platform`.

### Changed

- The `.cursor/hooks.json` adapter is versioned and its contract is pinned.
  `CURSOR_HOOKS_CONTRACT` records the format version the adapter writes, the
  date it was checked, the sources it was checked against, and the limits that
  follow from it; `cursorHooksDocument(profile, { version })` dispatches to a
  builder per format version and refuses an unknown one, so the next Cursor
  format gets its own builder instead of a silent rewrite of this one.

  What the 2026-09-10 check actually established, since `cursor.com` is
  unreachable from the sandbox this ran in and no live Cursor was available:
  the format version and the deny shape are **corroborated** — two independent
  secondary sources agree that Cursor declares `"version": 1` and that a
  blocking hook answers `{"permission":"deny"}` with optional `userMessage` /
  `agentMessage`. The **event names are not**. The JSON schema published by the
  source package (`johnlindquist/cursor-hooks`) allows exactly six events —
  `afterFileEdit`, `beforeMCPExecution`, `beforeReadFile`,
  `beforeShellExecution`, `beforeSubmitPrompt`, `stop` — with
  `additionalProperties: false`, and mentions `sessionStart`, `sessionEnd` and
  `preCompact` nowhere. Those three are exactly what this adapter registers for
  session memory. Either that package (v0.1.0, last touched 2025-10) lags
  Cursor 3.x, or the three registrations are inert and Cursor-side session
  memory never runs — which would also make the unconfirmed-draft handling
  below dead on Cursor, since no draft would ever be captured. `stop` is a
  documented event and is the obvious home for the capture if it comes to that.
  This is a reconstruction from secondary sources, not a verification: settle it
  against a real Cursor before trusting the Cursor memory story.
  `CURSOR_HOOKS_CONTRACT.verification` records the same, claim by claim, so the
  distinction survives in the code and not just here. The tests pin what the
  adapter writes, so a change still fails CI rather than the user's install.
- `install_agent_hooks` reports what the merge could not decide instead of
  writing over it: a `.cursor/hooks.json` that declares another format version,
  and events where a foreign hook is registered ahead of ours (on the
  unverified premise that Cursor runs the first entry of an event, so that one
  would shadow the guard; the warning costs nothing either way). `agent_hooks_status`
  reports the installed file's `cursor_format_version` and whether this adapter
  builds it.
- Hook-captured sessions are drafts, not handoffs. `session-end.mjs` writes
  `confirmed: false`, and every reader says so: `resume_session` returns
  `unconfirmed: true` plus the drafts still waiting, its briefing opens with
  "UNCONFIRMED HOOK DRAFT — the Stop/PreCompact hook distilled this from the
  transcript" and does not invent a next step the hook cannot know, and the
  `session-start` context injection carries the same caveat — as does the
  compiled context pack, whose handoff section is titled "unconfirmed hook
  draft" when the newest record is one. `save_session` with
  `confirm_hook_draft: true` promotes one: the agent's fields win, the draft
  fills the rest, the stored record is marked `confirmed` with `confirmed_from`,
  and the draft file is deleted so nothing is offered as unconfirmed twice.
  Records written before the flag existed are treated as drafts — they came from
  the same hook.

### Fixed

- `compact-advisor.mjs` reads the context size from the newest **assistant**
  message in the transcript. It scanned for any entry carrying a `usage` field
  and took the first one it found from the end, so a subagent's turn
  (`isSidechain: true`, billed against its own window) or a non-assistant record
  could set the number the advice was based on — and the tail slice's first,
  half-read line was parsed as if it were whole. Parsing moved into
  `hooks/lib.mjs` (`latestAssistantUsage`, `contextWindowFor`,
  `compactSettings`, `contextThresholdFor`) and is unit-tested against a
  transcript fixture. Every threshold is now settable in `.ai-dev/policy.json`:
  `compact_tool_threshold`, `compact_tool_interval`,
  `compact_context_threshold` (absolute; 0 derives it from the window),
  `compact_context_thresholds.standard` / `.large`, `compact_context_window`
  and `compact_context_interval`, each falling back to its default when the
  value is missing or not a positive number.

[Unreleased]: https://github.com/stonebridgeway/ai-dev-system/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/stonebridgeway/ai-dev-system/releases/tag/v1.0.0
