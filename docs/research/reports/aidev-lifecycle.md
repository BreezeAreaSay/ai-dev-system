# ai-dev-system: Task Lifecycle, Verification, Execution and Recovery (current state)

Scope: `/home/user/ai-dev-system/ai-dev-mcp-server` (Node.js MCP server, package version 2.0.0). All paths below are relative to that directory unless they start with `docs/` (repo-level `/home/user/ai-dev-system/docs`) or `docker/` (repo-level). Every claim cites `file:line` from the code as it is today; nothing here is inferred from docs alone.

## 1. `begin_task`

**Inputs** (`src/extensions/lifecycle.mjs:617-633`): `project_path` (required), `task` (required), `project_name` (optional), `acceptance_criteria: string[]` (default `[]`). Nothing else: no priority, no deadline, no owner, no "context refs" argument.

**Flow** (`lifecycle.mjs:102-174`): resolve project identity → `detectProject` → in parallel: `recommendSkills` with `limit: 3, membrane_policy: "exclude"` (114-119), `captureProjectState` (baseline fingerprint), and read `AGENTS.md`, `.ai-dev/project-brief.md`, `.ai-dev/project-map.md`, `.ai-dev/quality-gate.md` → `compileContextPack` with `maxSourceFiles: 12, maxChars: 20_000` (135-151; constant `CONTEXT_PACK_LIMITS` at line 76) → `taskStore.begin` (152-174).

**Record** written by `TaskStore.begin` (`src/core/task-lifecycle.mjs:85-145`): id `task-<YYYYMMDDTHHMMSS>-<8 hex>` (16-20), `schema_version: 1`, `status: "active"`, `project {id, repository_id, name, path, aliases, types, stack, components}`, `risk`, `plan_policy`, `plan: null`, `acceptance_criteria`, `skills`, `parent_id: ""`, `depends_on: []`, `epic: null`, `context`, `baseline`, `checkpoints: []`, `verifications: []`, `completion: null`. `context` (from `lifecycle.mjs:158-170`) holds `context_pack_id`, the full `compiled_context` markdown, `selected_files[{path, score, reasons, sha256}]`, `context_unknowns`, the three `.ai-dev` doc paths, `components`, `architecture`, `project_identity`.

**Risk** (`task-lifecycle.mjs:57-62`): `high` when `INTENT.highRisk` matches (`src/core/intent-patterns.mjs:39-42`: words payment, production, deploy, migration, database, security, auth, permission; RU stems удален, продакшен, депло, миграц, безопасн, платеж); `medium` when project types include `api|backend|mobile` or the text matches `/(shared|config|routing|dependency|api|сборк|маршрут|зависим)/i`; else `low`.

**`plan_policy` scoring** — `classifyTaskComplexity` (`src/core/task-plans.mjs:29-82`), every signal:

| Signal | Weight | Source line |
| --- | --- | --- |
| `risk === "high"` | +3 | 36-38 |
| `risk === "medium"` | +1 | 39-41 |
| `LARGE_SIGNALS` regex on task text (refactor, migrat, architect, redesign, rewrite, rework, re-platform, integrat, end-to-end, multiple, several, across, all modules, whole, entire + RU forms) | +2 | 9, 43-46 |
| `SMALL_SIGNALS` regex (typo, rename, small, minor, quick, one-line, single + RU forms) | −1 | 10, 47-50 |
| word count ≥120 / ≥60 | +2 / +1 | 51-57 |
| context-compiler selected files ≥8 / ≥4 (max is 12) | +2 / +1 | 58-64 |
| explicit acceptance criteria ≥4 | +1 | 65-68 |
| project type `mobile` or `api` | reason only, no score | 69-71 |

Thresholds (72-73): `score >= 4 → large`, `>= 2 → medium`, else `small`; `plan_required = complexity === "large" || risk === "high"`. Also `suggested_effort` (high/medium/low) and `suggested_model_tier` (deep/balanced/fast) (79-80). The store passes `context.selected_files` as `selectedFiles` (`task-lifecycle.mjs:98-104`).

**Acceptance-criteria generation** (`task-lifecycle.mjs:22-55`): user-provided criteria first, then defaults: three always — "Requested behavior is implemented within the stated scope: <task>", "Relevant automated checks pass or every unavailable check has a recorded reason.", "No known regression, unresolved error, placeholder, or unrelated refactor remains." (23-27); `frontend` project adds "Changed UI is checked on desktop and mobile…" (28-29) and, if `taskRequiresFrontendProductWorkflow(task)`, two more (design-first gate; strict visual QA + ten-dimension scorecard) (30-33); `api` adds a contract-preservation criterion (35-37); `taskRequestsDiagram(task)` adds the Archify criterion (38-40). When `plan_required`, `PLAN_CRITERION_TEXT` is appended (`task-lifecycle.mjs:125-128`, text at `task-plans.mjs:6`). Dedup by `Set`, ids `AC-1..n`, all `pending` with empty `evidence` and `note` (44-55).

**Response** (`lifecycle.mjs:175-183`): the whole record spread at top level (`id`, `status`, `task`, `project`, `risk`, `plan_policy`, `plan`, `acceptance_criteria`, `skills`, `parent_id`, `depends_on`, `epic`, `context`, `baseline`, `checkpoints`, `verifications`, `completion`, `created_at`, `updated_at`, `schema_version`) plus `next_actions[4]`. Minor: `BEGIN_TASK_NEXT_ACTIONS` (line 68) is defined but the literal is repeated inline at 177-182.

## 2. Ambiguity / clarification detection; `plan_task`

There is **no** "is the task defined enough" check. `TaskStore.begin` only requires a non-empty string (`task-lifecycle.mjs:93`). No clarification questions, no vagueness score, no refusal for a one-word task. The nearest proxies: `context_unknowns` from the context compiler is stored (`lifecycle.mjs:161`) but gates nothing; the plan has a free-text `open_questions` list (`task-plans.mjs:153`) that is rendered but never blocks.

**`plan_task`** (`src/extensions/plans.mjs:30-61`, handler 74-110): required `task_id`, `overview`, `phases`; optional `requirements`, `testing_strategy`, `risks[{risk, mitigation}]`, `rollback`, `open_questions`, `success_criteria`. Step schema: `action` (required), `file`, `why`, `risk ∈ low|medium|high`, `depends_on`. `normalizePlan` (`task-plans.mjs:119-156`) throws when `overview` is empty, when any step lacks `action`, when `risk` is not one of the three, or when no phase has at least one step (139-141). `writeTaskPlan` writes `.ai-dev/plans/<task-id>.md` and `.json` atomically (235-253); the store gets a summary (`path, json_path, sha256, phases, steps, recorded_at`) in `record.plan` (`plans.mjs:96-99`) and the plan criterion is marked `met` through a checkpoint (100-105). A completed task cannot be planned (76).

**Gate**: `withPlanGateWarning` (`task-plans.mjs:263-271`) only attaches a `plan_warning` string to the `checkpoint_task` response when `plan_required && !plan && changed_files.length` — it does not block. Real enforcement is the pending plan criterion, which `complete_task` refuses (`task-lifecycle.mjs:231-236`). `plan_status` returns policy, plan, and a fill-in template (`plans.mjs:112-126`).

## 3. `checkpoint_task`

Inputs (`lifecycle.mjs:636-664`): `task_id`, `summary` (required), `changed_files[]`, `criteria[{id, status ∈ pending|met|blocked|waived, note, evidence[]}]`, `notes`, `snapshot` (default `true`).

Order (`lifecycle.mjs:219-246`): (1) `auditCompletionClaims` — refusal happens **before** any write (198-207); (2) `taskStore.checkpoint` (`task-lifecycle.mjs:194-215`): refuses on `status === "complete"`, unknown criterion id, invalid status; sets `status/note/evidence` per criterion; pushes `{at, summary, changed_files (deduped strings), notes}`; (3) snapshot, `trigger: "checkpoint"`, `required: false` so a non-git tree yields `{status: "skipped", reason}` (224-232).

**Snapshot mechanism** (`src/core/task-snapshots.mjs`): throwaway index seeded from the repo's own index with preserved mtime (183-192), `GIT_INDEX_FILE` → `git add --all` → `write-tree` → `commit-tree -p HEAD` → `update-ref refs/ai-dev/snapshots/<task_id>/<n>` (208-244; namespace line 41). Fixed identity `ai-dev@snapshots.invalid` (58), `core.autocrlf=false` (71), git timeout 60 s, 8 MiB output (73-82). Entry fields (227-240): `snapshot_id: snapshot-<n>`, `sequence`, `turn` (= `checkpoints.length` at capture, 445), `trigger`, `label` (≤200 chars), `commit`, `head`, `ref`, `worktree_path`, `files` (≤100, `MAX_RECORDED_FILES` 52), `file_count`, `created_at`. Retention: `RETAINED_AUTOMATIC_SNAPSHOTS = 50` (49); oldest checkpoint-triggered refs are deleted and marked `deleted_reason: "retention"` (417-427). Rollback snapshots the current state first (505-540) and appends to `record.rollbacks`.

**Not captured**: anything `.gitignore`d (dependencies, build output) — by design (comment 20-21); the git index/staging state (27-29); untracked-but-ignored files; the task record itself lives outside the tree (`${AI_DEV_STATE_ROOT}/tasks/<id>.json`) and is not versioned per checkpoint — a rollback restores files but not `acceptance_criteria` statuses or `checkpoints`; no transcript, tool-call list, or "which skills were read" is recorded; `changed_files` is trusted from the caller and never reconciled with `git status`. Context refs are not re-snapshotted per checkpoint (they live once in `context`).

Response (233-245): record (+`plan_warning`), `completion_claims` (lint result), `snapshot {status, snapshot_id, turn, commit, file_count}` or `{status: "skipped", reason}`.

## 4. `verify_task`

Inputs (`lifecycle.mjs:321-333`): `run_quality=true`, `quality_labels=[]`, `run_frontend=false`, `frontend_options={}`, `run_hygiene=true`, `hygiene_base_ref="HEAD"`, `run_security_scan=true`, `security_scanners="auto"`, `coverage_min=0`, `evidence=[]`. Refuses when `status === "complete"` (335).

**Check types and selection** (`lifecycle.mjs:335-441`):
- `archify_deliver` / `archify_visual_check` — one per `evidence` entry (255-274).
- `quality_gate` — when `run_quality`; calls `host.runQualityGate` with `dry_run:false`; a thrown error becomes `{status: "unavailable"}` (341-360).
- `frontend_qa` — only when `run_frontend`; `{gate:"block", status:"not_frontend"}` when the project is not frontend (362-393).
- `frontend_product` — automatic when project is frontend **and** `taskLooksFrontendProduct(record.task)`; `ok:false, gate:"handoff"` when state is not prepared (395-421).
- `change_hygiene` — when `run_hygiene` (423).
- `security_scan` — when `run_security_scan`; statuses `block|warn|unchecked|pass` (`src/core/security-scan.mjs:396-401`) (428-436).
- `coverage` — only when `coverage_min > 0`; missing report → `no_report` (296-320, 437).

**Verdict** (`src/core/task-verification.mjs:21-48`): empty check list never passes; every check must succeed: `quality_gate.status === "passed"` (so `passed_with_blocked`, `warn`, `no_commands`, `blocked`, `no_commands_run`, `unavailable` all fail), `frontend_qa.gate === "pass"`, `frontend_product.ok === true`, archify `ok === true`, `change_hygiene.status !== "block"`, `security_scan.status !== "block"`, `coverage.status === "pass"`, unknown type → `false`.

**Stale evidence via fingerprints**: `captureProjectState` (`src/core/evidence.mjs:145-190`) — git: `sha256(HEAD \n porcelain status \n content-hash of dirty/untracked files)`, `DIRTY_CONTENT_MAX_FILES 500`, per-file `5 MiB` (11-12), strength `strong|medium`; non-git: bounded walk of 2000 files by `path/size/mtime` (13, 91-132). `bindEvidence` stamps `source_state_fingerprint` and `source_head` (199-208). Stored as `verification.evidence` (`lifecycle.mjs:445-456`).

**Evidence → criteria text matching** (`task-verification.mjs:64-86`), applied only on a passing run: `/automated checks pass/i` → met; `/changed ui is checked/i` → met only when `frontendChecked` (`run_frontend`); `/design-first implementation gate|strict visual reference qa/i` → met on **any** passing run (not tied to the `frontend_product` check specifically); `/diagram is delivered via archify_deliver/i` → met when an `archify_deliver` check is ok and any visual check is ok. The scope criterion (AC-1) and the "no regression/placeholder" criterion are never auto-met; the agent must checkpoint them by hand. Matched criteria are written via a checkpoint `"Automated verification passed."` with notes `Evidence: <verification id>` (466-476). `addVerification` sets `status` to `verified` or back to `active` (`task-lifecycle.mjs:217-224`).

**Response** (492-497): `{task, verification{id, at, passed, checks[{type,result}], evidence{type,status,source_state_fingerprint,source_head,captured_at,details.checks[]}, registry?}, skill_outcomes, current_project_state}`. Each failed check summary carries `detail.output` (first meaningful line, `firstMeaningfulLine` 106-113), `detail.hint`, and `engines_mismatch` (132-171).

## 5. `complete_task`

Inputs (`lifecycle.mjs:520-527`): `task_id`, `summary` (required), `allow_waived=false`, `write_report=true`, `prepare_pull_request=true`, `evidence=[]`. If `evidence` is given, a `verifyTask` runs first with `run_quality:false, run_frontend:false` — but hygiene and security still run by default (528).

**Refusals, in order**: (1) completion-claims block (533, see table below); (2) epic with unfinished/missing children (534; 494-514); (3) `TaskStore.complete` (`task-lifecycle.mjs:226-258`): already complete (228-230); unresolved criteria — anything not `met`, unless `allow_waived && status === "waived" && note` non-empty (231-236); no verification recorded (239-242); latest verification failed (243-245); `latest.evidence.source_state_fingerprint !== projectState.fingerprint` — stale (246-248). Only the **latest** verification counts (237-239).

**Completion-claims rule table** (`src/core/completion-claims.mjs:63-162`), `id → gate`: `pre_existing_failure → verification` (with an exemption for "on main … cherry-picked/ported"), `tests_deferred → quality_gate`, `tests_failing_deferred → quality_gate`, `works_on_my_machine → verification` (exempt "…and in CI"), `unverified_claim → verification` ("should work", "probably fine", RU "должно работать"), `inspection_only → verification`, `untested_change → quality_gate`, `unrelated_or_flaky → verification`, `suppressed_check → change_hygiene` (`--no-verify`, eslint-disable, ts-ignore…), `leftover_marker → change_hygiene` (TODO/FIXME/HACK/XXX without issue ref), `good_enough → verification`, `ui_unchecked → frontend_qa`, `manual_only → quality_gate`. All patterns are bilingual EN/RU (Д-26). **Gate signals** (`completionClaimSignals`, 197-213): read from the **latest** verification's `checks`: `quality_gate` = `status === "passed"`, `change_hygiene` = `status !== "block"`, `frontend_qa` = `gate === "pass"`, `verification` = `latest.passed && !stale` (stale = fingerprint mismatch when `projectState` is passed — only `complete_task` passes it, 533; `checkpoint_task` does not, 220). `null` = never ran. Severity (371-395): gate `true` → `warn`; otherwise `block` unless an active waiver exists in `.ai-dev/policy.json.completion_claims.waivers[{rule|"*", reason ≥ 20 chars, expires?}]` **and** the report states its own reason ≥ 20 chars after a marker (`reason:`, `because`, `причина`…; 33, 170-183). `enabled: false` turns it off (354-361). Exemptions are tested per sentence (301-309).

**What is written** (`lifecycle.mjs:535-570`): `record.status = "complete"`, `completion {at, summary, project_state, verification_ids: [latest.id]}`; snapshot refs deleted and entries marked `deleted_reason: "completed"` (`task-snapshots.mjs:550-566`); `skillOutcomeStore.recordCompletion`; knowledge note `02-knowledge/Task Runs/<id>.md` (`taskCompletionMarkdown`, `src/core/task-completion.mjs:187-219`); PR description `.ai-dev/pr/<task_id>.md` when git (`preparePullRequestForTask`, 481-495). Response: `{task, report, skill_outcomes, completion_claims, snapshots{status, deleted, reason?}, pull_request?, worktree?, next_step?}` (561-570).

## 6. Trajectory / behaviour checks over time

**Absent in the server**: loop detection; repeated-failing-command counting (`verifications[]` accumulates failed runs but nothing counts consecutive failures); same-file-rewritten-N-times; scope explosion (nothing compares `checkpoints[].changed_files` with `plan` steps or `context.selected_files`); verification avoidance (no timer, no "N checkpoints without a verify" rule); churn/oscillation between snapshots; token or wall-clock budgets per task. `checkpoints[]` and `snapshots[]` hold the raw material, but no reader analyses them.

**What exists, and its shape**:
- `hooks/fact-force.mjs` — refuses the *first* edit of a file per session until a `FACTS <path>` block is in the transcript, and the first destructive command until a `ROLLBACK:` line; `expiry_minutes 30`, `max_denials 3` (then damped), `max_entries 500`, exempt globs (59-67, 357-397). Off unless `fact_force.enabled` or `strict` profile. Per-file first-touch, not repetition.
- `hooks/compact-advisor.mjs` — tool-call counter and context-size advice at policy thresholds; never blocks (389-415).
- `hooks/stop-check.mjs` — on Stop, warns about `console.log`/`debugger`/secrets in modified files and reminds to run `checkpoint_task`/`verify_task` when an active task has uncommitted files (319-327).
- `hooks/git-hooks.mjs pre-push` — one-line reminder when the active task has no or a failed verification (177-187).
- `hooks/guard.mjs` — per-call destructive command/file blocks; `.ai-dev/policy.json` regex rules with a match budget (126-176).
- `src/core/instinct-proposals.mjs:225-264` — post-hoc `repeated_command` / `repeated_chain` candidates read from the session-end observation log; proposals for memory, not enforcement.
- `withPlanGateWarning` — one warning when implementation starts without a required plan.
- `epicProgress.deadlocked` (`task-epics.mjs:170`) — structural, not temporal.
- Fingerprint staleness is the only "time-aware" gate, and it is state-based, not trajectory-based.

## 7. Execution boundary

**`src/core/process-runner.mjs`** — `runProcess` (184-237): `spawn(executable, args, {shell:false, stdio:["ignore","pipe","pipe"], detached: !win32, windowsHide:true})`; `timeoutMs` default `120_000`; `DEFAULT_OUTPUT_LIMIT = 2 MiB` shared between stdout and stderr (6, 139-145, 207-208), overflow truncates (never kills); hard timeout kills the process group `SIGTERM` (118-137); resolves on `close`; never rejects on non-zero exit. `buildSpawnEnvironment` inherits `process.env`, forces `PATH` to start with the running Node's directory, sets `pnpm_config_verify_deps_before_run=false` for pnpm (156-174). Windows package-manager shims rewrite to `node <entrypoint>` (83-116). `runPolicyCommand` = `parseSafeCommand` + `validateProjectExecutable` + `runProcess` (246-267). **`src/core/input-process-runner.mjs`** — stdin-driven, default 120 s, `maxOutputBytes 8 MiB` — overflow kills `SIGKILL` and rejects (294-353).

**Command policy** (`src/core/command-policy.mjs`): tokenizer refuses `; | & > < \``, `$(`, `${`, control chars, newlines, unclosed quotes (64-110); `SHELL_EXECUTABLES` refused (12-25); `npx`, `npm-exec`, `curl`, `wget` refused (270-272); package scripts must be named and match `VERIFY_SCRIPT` for `quality` or `DEV_SCRIPT` (`dev|start|serve|preview`) for `development` (27-28, 162-181); Python only `-m pytest|unittest|compileall|ruff|mypy` or a `check|test|lint|validate*.py` script, no `-c`/pip (183-203); direct tools `pytest ruff mypy pyright eslint tsc vitest jest`, `node --test|--check`, `cargo test|check|clippy|fmt`, `go test|vet`, `dotnet test|build|format`, `git diff --check [--cached] [HEAD]` (205-241); every argument allowlisted by `SAFE_FLAG`/`SAFE_OPERAND`, `DANGEROUS_FLAG_PREFIXES` (`-c -e -p -r -o -x --eval --require --import --loader --config --prefix --cwd --output …`), no absolute paths, no `..`, path operands must resolve inside `projectRoot` (35-50, 126-160). `commandRiskReason` classifies for confirmation prompts, never throws (326-354).

**Path policy** (`src/core/path-policy.mjs`): `isPathInside` lexical (382-390); `resolveWithin`/`resolveWithinSync` add `realpath` containment, refuse dangling symlinks, refuse absolute unless `allowAbsolute`, and for `mode:"write"` walk to the nearest existing ancestor (457-538).

**Quality gate constants** (`src/core/quality-gate-runner.mjs`): `QUALITY_GATE_DEFAULT_MAX_COMMANDS 6`, `MAX 20` (13-14); `DEFAULT_TIMEOUT_MS 120000`, `MAX 30 min` (17-18); labels skipped unless named: `install dev serve start watch preview deploy publish release migrate migration seed smoke manual integration` (100-102); statuses `dry_run|failed|no_commands|blocked|warn|passed_with_blocked|no_commands_run|passed` (205-216). Runner loop in `src/extensions/projects.mjs:131-160`: `cwd` resolved by `host.safeProjectSubdir`, per-command `status passed|failed|timed_out`, `hint`, `output_truncated`, `duration_ms`; `runtime {node, exec_path, engines_mismatch?}` (215-219).

**Docker** (`docker/Dockerfile`, `docker/compose.yaml`, `docker/run-mcp.sh`): base `node:24-bookworm-slim`, `USER node`, `tini`, `gitleaks` copied in as the only offline scanner (3-9, 131). Compose/run: `read_only` root, `network_mode: none`, `cap_drop: ALL`, `no-new-privileges`, `tmpfs /tmp 512m exec`, `/data` volume (compose 162-173; run-mcp.sh 240-250). `AI_DEV_PROJECT_PATH` bind-mounted **read-write** at `/workspace` (252-258); `AI_DEV_MODEL_PATH` mounted `readonly` at `/models` (282). Vault/state must live under `/data` (`entrypoint.sh` 291-298). `run-mcp.sh` also has a "warm runtime" mode that pipes a stdio client into `docker exec` through FIFOs and fakes the `initialize` reply (186-233).

**ExecutionBackend / Runtime interface**: none. A grep for `ExecutionBackend|Runtime interface|class *Backend|createRunner` over `src/` returns nothing. `runProcess` is imported directly by `evidence.mjs:4`, `task-snapshots.mjs:37`, `task-worktrees.mjs:3`, `projects.mjs:17`, etc. The `host` object in `src/tool-extensions.mjs` is a DI seam for *tools* (task store, project state, sibling tools), not for process execution; there is no way to swap a local spawn for a remote/sandboxed executor without editing each caller.

**Daemon/socket** (`src/daemon.mjs`, `src/transport/socket.mjs`): Unix socket / named pipe in a `0700` runtime dir, socket `chmod 0600` (60-63, 128); lock file created `wx`, stale-pid recovery (43-55); idle shutdown `AI_DEV_IDLE_TIMEOUT_MS` default 30 min (14); one `createAiDevServer()` per connection (104-122); `SocketServerTransport` reuses the SDK `ReadBuffer`/`serializeMessage` (151-229). `src/server.mjs:524` is the plain stdio entry.

## 8. Recovery after crash/restart mid-task

**Durable state**: the task JSON (`${AI_DEV_STATE_ROOT}/tasks/<id>.json`, `task-lifecycle.mjs:67-73`), written with `atomicWriteJson` on every mutation (143, 189). Per-id serialisation is an in-process promise chain (`lock`, 76-83) — it does not protect two stdio server processes editing the same task; only the daemon (one process, many sessions) benefits.

**What the record does carry for resume**: full `compiled_context` markdown, `selected_files` with `sha256`, `context_unknowns` (`lifecycle.mjs:158-170`); routed `skills` (name, role, path — `task-lifecycle.mjs:129`, rendered at `task-completion.mjs:213`); `plan` summary path; `plan_policy`; every checkpoint with `changed_files`; every verification with fingerprint; `snapshots[]` and `rollbacks[]`; `context.worktree` when opened in a worktree. Memory refs (decisions, newest handoff, instincts >70 %) are folded into `compiled_context` text by `loadContextExtras` (`lifecycle.mjs:147`) but not stored as separate ids.

**What it does not carry**: no `paused|interrupted` status (only `active|verified|complete`), no heartbeat/lease, no "current step" pointer into the plan, no record of which tool calls happened, no resume cursor. A crash between `taskStore.checkpoint` and the snapshot leaves a checkpoint without a snapshot (by design, `lifecycle.mjs:214-218`); a crash between `update-ref` and the record update leaves an orphan ref, which `pruneTaskSnapshots` deletes by wiping all refs of the task (`task-snapshots.mjs:553-557`).

**Resume-like tools**: `get_task`, `list_tasks` (`src/tool-definitions.mjs:788-806`, handlers `src/mcp-stdio.mjs:4300-4306`) — raw records; `resume_session` (`src/extensions/sessions.mjs:257-306`) — latest handoff, `open_tasks` (`active|verified`) with `plan_required/plan_recorded`, git state, context-pack freshness, instincts; `list_task_snapshots` + `rollback_task` restore the tree; the `session-start.mjs` hook injects up to five open tasks and the last handoff (28-42, 79-102). There is **no `resume_task`**; the agent re-reads the record with `get_task` and continues. Completion after a restart is fingerprint-gated, so a restart that changed nothing can still `complete_task`; any tree change forces a fresh `verify_task`.

**Abandoned tasks**: `prune_state` treats a non-complete task idle ≥ `abandoned_task_days: 30` as abandoned and deletes its snapshot refs (`src/core/state-pruning.mjs:42, 102-116, 286-302`) — the fix for Д-14. The record itself is never deleted.

**`docs/RECOVERY.md`** promises only whole-system source backup/restore via PowerShell scripts (`backup-ai-dev-system.ps1`, `restore-ai-dev-system.ps1`, `restore-runtime.ps1`) and an eight-step recovery order (21-33); it says nothing about resuming a task mid-flight, and its script paths are Windows-only. `docs/SECURITY.md:84` states the evidence rule: outcomes count only after `verify_task` binds evidence to the current fingerprint.

## 9. Epics essentials

`decompose_task` (`src/extensions/epics.mjs:64-108`): parent must not be complete and must not itself be a child (one level deep, 66-67); `normalizeSubtasks` enforces ≥1 and `MAX_SUBTASKS = 20`, non-empty text, unique keys (`task-epics.mjs:17, 36-57`); `resolveSubtaskDependencies` refuses unknown refs, self-refs and cycles with the path printed (70-111); each child is opened through the real `begin_task` via `host.callTool` (74-82) so it gets its own skills/context/criteria/plan policy; `parent_id`/`depends_on` are written after all ids exist (85-92); `parent.epic.children` is appended (93-96). `epic_status` (109-123): child state `complete|blocked|in_progress|ready` (`epicChildState`, 121-127; in_progress = has any checkpoint or verification), `next` = first in_progress else first ready (159), `percent`, `missing` ids, `deadlocked` when nothing is ready or in progress and not all complete (170). `complete_task` on a parent is refused while any child is not `complete` or its record is missing (`lifecycle.mjs:494-514`, `epicCompletionBlockers` 181-187); the parent still needs its own `verify_task` (`epics.mjs:169`).

## 10. DEFECTS entries touching this area (`docs/DEFECTS.md`)

- Д-4 (l.167) — acceptance runner passed only intermittently; ten-run rule adopted. Closed.
- Д-10 (l.371) — completion linter: one false positive, three uncaught rationalizations. Closed.
- Д-14 (l.589) — snapshots of an abandoned task were never deleted → `prune_state`. Closed.
- Д-15 (l.621) — rollback deleted files a human created after the snapshot → named + undo snapshot. Closed.
- Д-22 (l.1067) — hook policy-rule regex budget bounded a rule, not an event. Closed.
- Д-26 (l.1180) — new linter rules English-only, plus a false positive. Closed.
- Д-27 (l.1230) — worktree cleanup did not name what it removed. Closed.
- Д-28 (l.1257) — "unfamiliar" removals included the agent's own files. Closed.
- Д-46 (l.2068) — acceptance criterion could not read Node 24 test output. Closed.
- Д-54 (l.2450) — quality gate failed `node --test <dir>` without saying why → hint + first meaningful line. Closed.
- Д-55 (l.2539) — `security_scan` with no scanner reported `pass` → `unchecked`. Closed.
- Д-67 (l.3500) — Docker ran project commands on the image's Node ignoring `engines.node` → warning. Closed.
- Д-2 (l.111) — Cursor hook format unverified on a live editor. **Open** (not lifecycle-specific but affects the hook guard rails).

## 11. Line counts and key constants

| File | Lines |
| --- | --- |
| `src/mcp-stdio.mjs` | 4905 |
| `src/extensions/lifecycle.mjs` | 723 |
| `src/core/agent-hooks.mjs` | 653 |
| `src/core/task-snapshots.mjs` | 566 |
| `src/core/change-hygiene.mjs` | 537 |
| `src/core/policy-rules.mjs` | 486 |
| `src/core/quality-gate-runner.mjs` | 443 |
| `hooks/fact-force.mjs` | 430 |
| `src/core/completion-claims.mjs` | 426 |
| `src/core/task-worktrees.mjs` | 420 |
| `src/core/command-policy.mjs` | 354 |
| `hooks/guard.mjs` | 281 |
| `src/core/task-plans.mjs` | 271 |
| `src/core/process-runner.mjs` | 267 |
| `src/core/task-lifecycle.mjs` | 259 |
| `src/core/evidence.mjs` | 223 |
| `src/core/task-epics.mjs` | 217 |
| `src/core/path-policy.mjs` | 199 |
| `src/core/task-verification.mjs` | 171 |
| `src/extensions/epics.mjs` | 170 |
| `src/daemon.mjs` | 150 |
| `src/extensions/plans.mjs` | 136 |
| `hooks/compact-advisor.mjs` | 88 |
| `src/core/input-process-runner.mjs` | 86 |
| `src/core/task-completion.mjs` | 81 |
| `src/transport/socket.mjs` | 79 |
| `hooks/stop-check.mjs` | 53 |
| `ai-dev-mcp-server/docs/ARCHITECTURE.md` / `RECOVERY.md` / `SECURITY.md` | 564 / 47 / 43 |
| `docs/WORKFLOW.md` / `docs/DEFECTS.md` | 125 / 3850 |

Key constants: context pack 12 files / 20 000 chars; skills routed ≤3; complexity thresholds 2/4, plan required at `large` or `high` risk; `MINIMUM_REASON_LENGTH 20`; `RETAINED_AUTOMATIC_SNAPSHOTS 50`, `MAX_RECORDED_FILES 100`, label ≤200; `MAX_SUBTASKS 20`; `abandoned_task_days 30`; process default timeout 120 s, output cap 2 MiB (8 MiB for stdin runner); quality gate 6/20 commands, 120 s/30 min; fingerprint limits 500 dirty files × 5 MiB, 2000-file walk; `fact_force` 30 min / 3 denials / 500 entries; daemon idle 30 min; Docker: network none, read-only root, cap-drop ALL, `/workspace` rw bind, `/models` ro, `/tmp` 512 MiB tmpfs.
