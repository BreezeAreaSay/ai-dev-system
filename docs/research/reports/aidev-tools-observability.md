# AI Dev System — tool surface, observability and footprint (as of `c67b00c`, 2026-09-14, server 2.0.0)

Scope: `/home/user/ai-dev-system`, Node.js MCP server in `ai-dev-mcp-server/`. Read-only survey of tracked files plus one measured run of the real server against the lifecycle-smoke fixture project (see §2.3). All paths below are relative to the repository root unless absolute; `src/` means `ai-dev-mcp-server/src/`.

---

## 1. Tool surface

**Total: 133 tools in 16 documentation groups, 62 of them read-only** (`ai-dev-mcp-server/docs/TOOLS.md:7`). TOOLS.md is generated from the live definitions by `scripts/render-tool-reference.mjs` and checked in CI with `--check` (`TOOLS.md:3-5`). Definitions live in two places: the static list in `src/tool-definitions.mjs` (`buildToolDefinitions`, line 3) and 23 extension factories composed by `src/tool-extensions.mjs:47-71`; the composer rejects duplicate names, missing handlers and non-object input schemas at startup (`tool-extensions.mjs:89-97`).

### 1.1 Capability profiles (`AI_DEV_PROFILES`)

Eight profiles, defined in `src/core/tool-profiles.mjs:39-237`, documented in `docs/CAPABILITIES.md:13-22`. Every tool belongs to exactly one profile; `auditProfileCoverage` (`tool-profiles.mjs:342-357`) fails CI for a tool with no home or two homes.

| Profile | Tools | Read-only | Content |
| --- | --- | --- | --- |
| `core` (always on, `tool-profiles.mjs:33,44`) | 25 | 16 | context, routing, lifecycle, health |
| `coding` | 18 | 8 | epics, plan gate, project cards, auto-commands, rules |
| `memory` | 16 | 6 | decisions, sessions, instincts, knowledge notes, prune_state |
| `git` | 9 | 2 | worktrees, snapshots/rollback, hygiene, PR text |
| `frontend` | 13 | 4 | brief, directions, jury, design system, reference factory |
| `qa` | 8 | 2 | Playwright/visual QA, search & routing evals |
| `security` | 8 | 3 | scans, policy rules, agent hooks, MCP inventory |
| `advanced` | 36 | 21 | archify (9), search/skill indexes, dashboard, usage ledger, distribution |

**The `core` list, in definition order (`tool-profiles.mjs:45-71`; `ro` = readOnlyHint):**

1. `search_knowledge` — ro — vault Markdown search (`query`)
2. `read_knowledge` — ro — read one knowledge file by path
3. `search_all` — ro — keyword + sparse-semantic search across scopes
4. `hybrid_search` — ro — keyword + semantic + dense (BGE-M3) with intent routing
5. `preset_search` — ro — named search presets
6. `search_skills` — ro — skill registry filter/rank (`query`, group/subgroup/maturity/quality)
7. `read_skill` — ro — read a skill by name
8. `recommend_skills` — ro — rank skills for a task with project context
9. `bootstrap_project` — write — first-run scaffolding of `.ai-dev/`
10. `prepare_project` — write — regenerate brief/map/quality-gate
11. `project_identity` — ro — canonical project/repository id
12. `list_projects` — ro
13. `read_project` — ro — project card
14. `register_project` — write
15. `analyze_project` — ro — stack/components detection
16. `compile_project_context` — write (persists `.ai-dev/context/*`) — bounded context pack
17. `project_context_status` — ro — freshness of the latest pack
18. `begin_task` — write — open task: context + ≤3 routed skills + criteria + baseline
19. `get_task` — ro
20. `list_tasks` — ro
21. `checkpoint_task` — write — progress + criteria + snapshot; completion-claim linter
22. `run_quality_gate` — write — runs the repo's own checks
23. `verify_task` — write — quality/frontend/coverage checks bound to project state
24. `complete_task` — write — closes task, PR text, prunes snapshots
25. `system_health_check` — ro — 22 health checks

### 1.2 How the filter applies

`parseProfileSetting` (`tool-profiles.mjs:277-295`) splits on commas/whitespace, lower-cases, always adds `core`, treats `all` or empty as every profile, and reports unknown names rather than dropping to an empty list. `filterToolsByProfiles` (`:331-334`) narrows a list **but keeps any tool the mapping has never heard of**. The server applies it only to `tools/list` (`src/server.mjs:391-396`); `tools/call` validates against the full list (`server.mjs:399-401`), so hidden tools remain callable — documented as "not a security boundary" (`docs/CAPABILITIES.md:75-81`). A narrowed server prints one stderr line at startup naming the profiles and count (`server.mjs:514-521`; wording at `CAPABILITIES.md:86-87`).

### 1.3 Schema size per profile

Documented (`CAPABILITIES.md:68-73`): core ~15 KB, core+git ~22 KB, core+coding+git+memory ~48 KB, all ~96 KB. **Measured** from a live `tools/list` (this session):

| `AI_DEV_PROFILES` | tools | name+description+inputSchema | full listing (with `title`, `outputSchema`, `annotations`) |
| --- | --- | --- | --- |
| `core` | 25 | 16,190 B | 22,843 B |
| `core,git` | 34 | 23,581 B | 32,716 B |
| `core,coding,git,memory` | 68 | 49,620 B | 67,972 B |
| unset | 133 | 98,857 B | 135,175 B |

The doc figures match the bare column; the wire listing is ~37% larger because `toolDefinition()` (`server.mjs:271-289`) adds a generic `outputSchema` (`{result: {}}`) and a five-field annotations block to every tool.

### 1.4 readOnly annotations

Static tools' read-only set lives in `READ_ONLY_TOOLS` in `server.mjs` (list ends ~line 70), extended by each extension's `readOnly: [...]` (`tool-extensions.mjs:101-104`); `READ_ONLY_TOOL_NAMES` is exported so TOOLS.md and the server share one set (`server.mjs:74-80`). Annotations per tool (`server.mjs:282-288`): `readOnlyHint`, `destructiveHint: false` (always), `idempotentHint` = read-only or name starts with `rebuild|sync|refresh|prepare|bootstrap|validate`, `openWorldHint` only for `import_skill_repo` (`:82`). TOOLS.md states clients may auto-approve read-only tools (`TOOLS.md:9-10`).

---

## 2. Response shapes

Every result is text JSON in `content[0].text` **and** the parsed value duplicated into `structuredContent.result` (`server.mjs:292-306`, `structuredResult`). Consequence: the on-wire MCP payload is ~2× the JSON text (see the two size columns in §2.3). Arrays are returned bare (structuredContent keys `"0","1",...`), which the generic `outputSchema` tolerates.

### 2.1 Top-level keys (from code and the measured run)

- **`begin_task`** (`src/extensions/lifecycle.mjs:106-175`): returns the full task record — `schema_version, id, status, created_at, updated_at, task, project, risk, plan_policy, plan, acceptance_criteria, skills, parent_id, depends_on, epic, context, baseline, checkpoints, verifications, completion, next_actions`. `context` carries `compiled_context` (Markdown pack), `selected_files[{path,score,reasons,sha256}]`, `context_unknowns`, paths, components, architecture, identity (`lifecycle.mjs:155-171`). Bounds: `maxSourceFiles: 12`, `maxChars: 20_000` (`:146-147`); routed skills ≤3 conventional + reserved slots (`scripts/lifecycle-smoke.mjs:97-107`).
- **`compile_project_context`** (`src/mcp-stdio.mjs:4225-4268`): `action, project_path, project_id, persisted, paths{markdown,json,latest_markdown,latest_json}, context_pack, next_step`. Inputs clamped: `max_source_files` ∈ [1,30] (default 12), `max_chars` ∈ [8 000, 60 000] (default 24 000) (`:4232-4235`). The pack is also written to `.ai-dev/context/packs/<id>.{md,json}` and `latest.{md,json}` — the closest thing to a "details on disk" pattern; the response still embeds the whole pack.
- **`recommend_skills`** (`src/extensions/skills.mjs:241-270` → `src/core/skill-recommendation.mjs:323-335`): bare array, default `limit = 8`, items with `name, reason, rank, role/routing_role, ...` (`skill-recommendation.mjs:557-561`). `compiled_context`-style text for matching is capped at 4 000 chars (`:513`), candidate pool at `max(limit*6, 40)` (`:555`).
- **Search** (`src/extensions/search.mjs:494-527`, `src/core/search-index.mjs`): `search_all`/`hybrid_search`/`search_projects`/`search_notes`/`search_skill_registry` return a bare array of hits `{scope,title,path,source,categories,score,keyword_score,semantic_score,dense_score,mode,preview,routing_role?,routing_reason?,routing_rule?,retrieval_stage?}` (`search-index.mjs:463-477`); `preview` is the item description, not a body excerpt. Default `limit 10`, hard ceiling `MAX_RESULTS = 50` (`search-index.mjs:30`). `preset_search` wraps: `{query,result_count,applied,results}` (`search.mjs:48-66`). `search_skills` (`mcp-stdio.mjs:4632-4670`) returns full registry rows (≈2.5 KB each), no field trimming. `explain_search` has its own `EXPLAIN_DEFAULT_LIMIT/EXPLAIN_MAX_LIMIT` (`search.mjs:70-72`). `dense_text_limit` default 1 200 chars (`search-index.mjs:152`).
- **`verify_task`** (`lifecycle.mjs:319-498`): `{task, verification, skill_outcomes, current_project_state}`; `verification.checks[]` each `{type, result{status,...}}`. Coverage check returns `{status, report{format,path,generated_at}}` (`:309-313`).
- **`checkpoint_task`** (`lifecycle.mjs:220-253`): full task record spread in, plus `completion_claims`, `snapshot{status,snapshot_id,turn,commit,file_count}` or `{status:"skipped",reason}` (`:245-251`), plus `plan_warning` when the plan gate applies (`src/core/task-plans.mjs:267`).
- **`complete_task`** (`lifecycle.mjs:552-620`): `{task, report, skill_outcomes, completion_claims, snapshots{status,deleted,reason?}, pull_request?, worktree?, next_step?}` (`:607-617`).
- **`resume_session`** (`src/extensions/sessions.mjs:257-300`): `{project_id, repository_id, project_path, session, unconfirmed, hook_drafts, history, open_tasks, git{branch,dirty,dirty_files}, context_pack{compiled,fresh,...}, handoff_path, briefing}`; `history` limited by `limit_history` (default 5), drafts 5, open tasks from a 20-task list (`:263-267`).
- **`system_health_check`** (`src/extensions/system.mjs:148-162`, `src/core/system-health.mjs:140-175`): `{status, started_at, finished_at, duration_ms, summary, checks[], recommendations}`; each check `{name, status, critical, summary, duration_ms, details}` (`system-health.mjs:141`). 22 checks (`vault_root, required_notes, skill_registry, skill_taxonomy, skill_cards, skill_quality, skill_outcomes, skill_routing_benchmark, skill_visual_graph, project_registry, auto_commands, search_presets, search_index_file, search_index_freshness, search_smoke, hybrid_smoke_no_dense, dense_smoke, embedding_backend, search_eval, security_scanners, frontend_qa_environment, frontend_qa_runner`). Projects list in details is cut at 10 (`system-health.mjs:487`).

### 2.2 Bounding patterns found (`grep truncat|slice(0|MAX_|limit` in `src/core`, `src/extensions`)

- **Context pack** (`src/core/context-compiler.mjs`): per-file excerpt `content.slice(0, maxExcerptChars)` with `excerpt_truncated` flag (`:176-184`), files >512 KB or containing NUL skipped (`:172-174`); reasons ≤4 (`:139`); commands ≤10 (`:195`); routed skills ≤3 (`:288`); documents split 20/30/20/30 % of a document budget (`:302-305`); then a shrink loop — drop files one by one, cut excerpts to 240 chars, extra sections to 400, context sources to 600 (`:319-345`); Markdown marker `... excerpt truncated ...` (`:430`).
- **Process output**: `DEFAULT_OUTPUT_LIMIT = 2 MiB` with `truncated: true` in the result (`src/core/process-runner.mjs:6,144,232`). Security scan tails at 400/200 chars (`security-scan.mjs:259-278`), findings ≤50 (`:494`).
- **Change hygiene / PR**: file list `truncated` flag (`change-hygiene.mjs:339-340`), finding groups ≤20 files (`:442-453`); PR body `MAX_FILES_PER_GROUP 40, MAX_COMMITS 20, MAX_CHECKPOINTS 12, MAX_HYGIENE_FINDINGS 15` (`pull-request.mjs:48-51`).
- **Lists**: tasks ≤5000 (`task-lifecycle.mjs:181`), sessions ≤200 (`session-memory.mjs:246`), instincts ≤20 (`instincts.mjs:342`), coverage gaps ≤200 (`coverage-reports.mjs:356`), usage tools ≤200 / slowest 5 / tasks 50 (`usage-ledger.mjs:528,570,585`), epics `MAX_SUBTASKS 20` (`task-epics.mjs:17`), embed `MAX_EMBED_TEXTS 32`, `MAX_EMBED_TEXT_LENGTH 12000` (`embedding-workers.mjs:28-31`), `MAX_ONNX_BATCH 32` (`dense-onnx.mjs:34`), import graph `IMPORT_GRAPH_MAX_FILES 4000` with `truncated` (`import-graph.mjs:42,287`), JSON subset scanner `MAX_SUBSET_VALUE_BYTES 4 MiB` (`json-subset.mjs:31`), regex input `MAX_MATCH_INPUT 4096` (`regex-budget.mjs:50`), evidence walk 500 files / 5 MiB / 2000 files (`evidence.mjs:11-13`).
- **include_/verbose pattern**: only `system_health_check` has `include_*` switches (`system.mjs:149-158`) and `usage_report` has `limit_tools`/`include_historical_models` (`src/extensions/usage.mjs:78-79`). There is **no** generic `summary`/`verbose`/`details_ref` convention: the task tools return the full task record every time (checkpoint/verify/complete each carried a 16 KB `task` object in the measured run), and there is no "summary + path to details file" mode except `compile_project_context`'s persisted pack and `complete_task`'s PR file (`.ai-dev/pr/<task>.md`).

### 2.3 Measured response sizes (server run in this session)

Environment: Node 22.22.2, `npm ci` already applied (131 packages, 422 MB `node_modules`), `scripts/ensure-skill-index.mjs` found the public-seed registry, fresh `AI_DEV_STATE_ROOT`, fixture = the `lifecycle-smoke` project (one module, one test, `.ai-dev/quality-gate.md`). Client connect (spawn → initialize) 300–540 ms; server RSS after `tools/list` ≈ 86 MB (`/proc/<pid>/status`).

| Tool | JSON text bytes | MCP result bytes | ms | biggest keys |
| --- | ---: | ---: | ---: | --- |
| `begin_task` | 15,001 | 28,108 | 539 | context 4,514; skills 4,241 |
| `compile_project_context` | 13,075 | 24,360 | 448 | context_pack 9,363 |
| `recommend_skills` | 5,403 | 10,373 | 90 | 4 items ≈1.1 KB each |
| `search_skills` (10 hits) | 29,167 | 55,638 | 92 | ≈2.5 KB per hit |
| `search_knowledge` (10) | 3,620 | 7,297 | 3,833 | ≈350 B per hit |
| `search_all` (10) | 5,200 | 10,340 | 6,841 | ≈475 B per hit |
| `hybrid_search` (10) | 10,994 | 21,393 | 358 | ≈1 KB per hit |
| `preset_search` | 10,886 | 20,561 | 371 | results 7,943 |
| `checkpoint_task` | 16,043 | 30,002 | 68 | context 4,514; skills 4,241 |
| `checkpoint_task` (refused) | 640 | 712 | 5 | isError text |
| `verify_task` | 32,833 | 57,856 | 299 | task 16,054; verification 4,091 |
| `complete_task` | 29,080 | 51,707 | 148 | task 16,898 |
| `resume_session` | 1,574 | 3,159 | 74 | briefing 330 |
| `system_health_check` | 22,642 | 39,978 | 1,758 | checks 14,694 |
| `usage_report` | 5,180 | 9,445 | 3 | tools 1,434 |

The 3.8 s / 6.8 s search timings are first calls against a cold index in a new state root (freshness check `ensure_fresh` default true, `search-index.mjs:27,296`). `npm run demo` is documented as "about twenty seconds" end to end (`docs/DEMO.md:196`).

---

## 3. Error shapes

- **SDK transport** (`server.mjs:399-423`): unknown tool → `McpError(InvalidParams, "Unknown tool: …")`; any handler exception → `{content:[{type:"text", text: error.message}], isError: true}` — plain message string, no JSON, no code, no `next_step`. `PathPolicyError`/`CommandPolicyError` carry `code` and `details` (`src/core/command-policy.mjs:3-9`, `path-policy.mjs:5`) but the transport only forwards `.message`.
- **Legacy stdio** (`src/mcp-stdio.mjs:4830-4832`, `startLegacyServer`): JSON-RPC error `-32000` with the message; `-32700` for bad JSON, `-32601` unknown method.
- **Examples measured**: `get_task{task_id:"nope"}` → `Invalid task id: nope` (21 bytes); `begin_task` on a missing dir → `Project directory does not exist: /definitely/not/here`; completion-claim refusal (`src/core/completion-claims.mjs:417-427`) → multi-line text: "The report claims more than the evidence shows: 1 rationalization is not backed by a passing check.\n- tests_failing_deferred in notes: … Quoted: "…"\nFix the check and run verify_task again, or rewrite the report … waive the rule in .ai-dev/policy.json: {…}" — the "three ways forward" are embedded in prose, not fields.
- **`next_step` consistency**: it is a *success-path* convention, not an error one — 15 uses in `mcp-stdio.mjs`, 9 in `sessions.mjs`, 4 in `lifecycle.mjs`, 1–4 in most other extensions (grep count), plus `next_actions` on the task record and `next_steps` in one frontend tool (`mcp-stdio.mjs:3419`). Not every tool returns it (search, recommend_skills, verify_task, system_health_check do not; health uses `recommendations`).

---

## 4. Observability

### 4.1 Usage ledger (`src/core/usage-ledger.mjs`)

Append-only JSONL at `<state>/usage/events.jsonl` (`:361`; default `~/.ai-dev/state`). Two kinds (`USAGE_EVENT_KINDS`, `:5`):

- `tool_call` (`recordToolCall`, `:437-449`): `at, kind, tool, ok, duration_ms, task_id, project_path, error (≤300 chars), client`. Recorded once per dispatch by `callTool` in `mcp-stdio.mjs:4776-4795` (fire-and-forget, `Date.now()` delta + transport overhead from `server.mjs:406-410`); composed tools go through the registry so a composed run logs one entry (`mcp-stdio.mjs:4474`). `task_id`/`project_path` come only from the call's own args (`usageHintsFromArgs`, `:597-602`) — so `begin_task` lines have an empty `task_id`. **Not recorded:** input/output byte sizes, session id, client name (`client` is never populated by the dispatcher — always `""` in the sample), arguments.
- `usage` (`recordUsage`, `:456-480`): `model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cache_creation_1h_tokens, cost_usd, duration_ms, turns, task_id, project_path, session_id, source, note`.

Pruning: when the file exceeds `MAX_LEDGER_BYTES = 8 MiB` keep the newest `KEEP_LINES_AFTER_PRUNE = 20 000` lines (`:6-7, 423-430`); `prune_state` can rotate on demand (`rotate`, `:415-421`; CHANGELOG `:618`). Writes are atomic-append and serialized through a promise queue (`:367-377`).

### 4.2 `usage_report` (`src/extensions/usage.mjs:70-82, 105-117`; `usage-ledger.mjs:512-587`)

Keys: `ledger_path, events, filter, tool_calls, tools[{tool,calls,failures,total_ms,max_ms,average_ms,failure_rate}] (≤limit_tools, default 15, max 200), slowest_tools (5), usage{tokens…, cost_usd, reported/estimated/historical_cost_usd, duration_ms, turns}, periods{today,yesterday,last_7_days}, models, historical_models, rates{source, priced_models, unpriced_models, historical_models, notice?, overrides, rejected, policy_path}, tasks (≤50)`. Prices from `RATE_TABLE` (`:92-110`, checked 2026-09-11, `:27-30`) with `.ai-dev/policy.json` `model_rates` overrides (`mergeRateTable`, `:209-224`); retired models flagged `historical` (`:56-63`, DEFECTS Д-8).

### 4.3 cost-capture hook (`ai-dev-mcp-server/hooks/cost-capture.mjs`)

Registered on Claude Code `Stop` at every hook profile (CHANGELOG `:712-716`); reads the transcript from a per-session byte cursor (`<state>/usage/sessions/<session>.json`, `:18-41`), sums assistant `usage` per model and appends `usage` events with `cost_usd: 0`, `source: "hook:cost-capture"`, `task_id` = active task of the project (`:58-79`). Prices are applied at read time, so a rate change re-prices history (`:6-10`). Cursor is excluded: its payload has `conversation_id`, not `transcript_path` (`:47`; `src/core/agent-hooks.mjs:229`).

### 4.4 Dashboard (`src/core/system-dashboard.mjs`)

`renderSystemDashboard` writes `01-system/System Dashboard.md` (frontmatter `generated_at`, `source_fingerprint`; tables for runtime, skills, search, delivery evidence, projects; `:61-157`). Freshness = SHA-256 over a stable JSON of tools/skills/quality/projects/search metrics/outcomes/pilots/overlays/runtime (`:21-40`, `dashboardFreshness` `:168-179`). Tools: `rebuild_system_dashboard`, `system_dashboard_status` (advanced profile); also exposed as MCP resource `ai-dev://system/dashboard` (`server.mjs:92-99`). It shows counts, not latency or cost.

### 4.5 Per-task trace / timeline

There is **no span/trace/timeline** (grep `trace|span|timeline|latency` in `src/` hits only descriptions and regexes). What exists: the task record accumulates `checkpoints[]`, `verifications[]`, `snapshots`, `completion` (`lifecycle.mjs`), giving an ordered history without timings; `duration_ms` appears only in the ledger, in `system_health_check` per check (`system-health.mjs:141,152,171`) and in `run_search_eval` (`search.mjs:124-160`). Cross-tool correlation per task is via the ledger's `task_id`, only when the call carried one.

---

## 5. Footprint

- **Runtime deps** (`ai-dev-mcp-server/package.json:50-55`): `@huggingface/transformers 3.7.5`, `@modelcontextprotocol/sdk 1.30.0`, `onnxruntime-node 1.21.0`, `zod 4.5.4`; Node ≥ 22.12 (`:8`). Installed: 131 packages, **422 MB** on disk (measured).
- **Startup / RAM**: not documented anywhere as numbers; measured here 300–540 ms to initialize and ≈86 MB RSS with no dense model loaded. The demo run "is about twenty seconds" (`docs/DEMO.md:196`).
- **Dense model**: ONNX int8 export `Xenova/bge-m3` pinned by revision and per-file sha256, 1024 dims (`ai-dev-mcp-server/models/bge-m3.manifest.json`); docs say "about 600 MB" for model + embeddings (`docs/INSTALL.md:52`; `dense-manifest.mjs:15`, `dense-download.mjs:8`). The legacy Python path is ~2.3 GB (`ai-dev-mcp-server/README.md:219,227`; DEFECTS Д-32, Д-62). No model is shipped in the repo (`models/` holds only the 787-byte manifest).
- **Index size**: not documented; the tracked `search-index/` is Python helper code (96 KB). The live index lives under `~/.ai-dev/cache/search-index` (`docker/entrypoint.sh:19`).
- **Daemon**: `npm run daemon` keeps one warm process on a Unix socket / Windows named pipe; exits after `AI_DEV_IDLE_TIMEOUT_MS` idle, default 30 min (`src/daemon.mjs:14,79-84`; `docs/ARCHITECTURE.md:14-18`).
- **Docker** (`docker/compose.yaml`): `read_only`, `network_mode: none`, `cap_drop: ALL`, `no-new-privileges`, `init`, `shm_size: 1gb`, `/tmp` tmpfs 512 MB exec, single `/data` volume. Dockerfile: `USER node`, `NODE_ENV=production`, `USERPROFILE=/data/runtime-home`, gitleaks copied from a digest-pinned image (`docker/Dockerfile:16,54,131,147-149`). Weights cannot be downloaded in the image; mount `/models` (`INSTALL.md:56-62`). Codex needs `startup_timeout_sec = 120`, `tool_timeout_sec = 3600` (`INSTALL.md:283-284`); bootstrap keeps a helper container alive so clients survive Docker's cold start (`INSTALL.md:148-155`).
- **Windows**: `bootstrap.ps1`, launcher copy at `C:\ProgramData\AI-Dev-System\run-mcp.ps1` and `ClaudeMcpProxy.exe` for fast Docker-MCP start (`INSTALL.md:89-90,305`; `docker/ClaudeMcpProxy.cs`); daemon uses a named pipe (`INSTALL.md:64`); `%USERPROFILE%\.claude.json` vs `%APPDATA%\Claude\...` (`INSTALL.md:299-300`). History: 23–41 tests failed per Windows run until PR #38 (DEFECTS Д-35), plus Д-31, Д-44, Д-61, Д-70, Д-71.

---

## 6. Client neutrality

- **MCP config installers**: local — `cursor, gemini, vscode, claude` (`scripts/install-local-mcp-clients.mjs:10,120-123`; Claude Code `~/.claude.json`, VS Code `mcp.json` with `servers` key `:110`); Docker — adds `codex` (`~/.codex/config.toml`) (`scripts/install-docker-mcp-clients.mjs:9,61`). Docs cover Codex, Cursor, Claude Desktop, Claude Code, Gemini, VS Code (`INSTALL.md:274-364`).
- **Hooks** (`install_agent_hooks`): `HOOK_TARGETS = ["claude", "cursor", "git"]` (`src/core/agent-hooks.mjs:8`). Claude Code gets the full set; Cursor gets `.cursor/hooks.json` with an explicitly *unverified* contract (`:174-230`) — no before-write guard, no cost-capture, session events uncertain (open defect Д-2; `npm run verify:cursor`). Git hooks (`pre-commit`, `pre-push`) are client-neutral (`docs/GUARDRAILS.md:79-80`). **No hook support for Codex, Gemini or VS Code.**
- **Rules**: `install_project_rules` writes `.ai-dev/rules`, `.claude/rules`, `.cursor/rules/*.mdc`, `AGENTS.md` (Codex, Zed, OpenCode), `GEMINI.md`, `.github/copilot-instructions.md`, `.windsurf/rules`, `.clinerules` (`src/extensions/rules.mjs:35-41`).

---

## 7. `THIRD_PARTY_NOTICES.md` format

Intro paragraph, then one `## <package>` section per import with bullets: `Source:` URL (with import scope in parentheses), `Included revision:` full SHA, `License:` (+ copyright), optional `License text:` path, optional `Selection record:` and free-text caveats (`THIRD_PARTY_NOTICES.md:7-58`). Archify adds a pinned-dependency table `| Package | Version | License |` (`:70-76`). A separate `## Binaries bundled in the Docker image` / `### gitleaks` entry records `Included image:` with digest and the copy destination (`:78-94`).

---

## 8. DEFECTS and CHANGELOG

`docs/DEFECTS.md` (Russian, 71 entries, 69 closed, open: Д-2, Д-62; `:16-27`). Entries touching size, cost, ledger, dashboard or performance (no entry is about MCP response size or schema size — those are addressed only by the capability-profiles changelog item, `CHANGELOG.md:48-64`):

- **Д-2** — Cursor hook format verified from docs only, not a live editor (open).
- **Д-3 / Д-9 / Д-12** — main module at 10 019 of a 10 150-line ceiling; static gate's size rules had no test.
- **Д-8** — historical model prices in `RATE_TABLE` cannot be re-verified (ledger cost accuracy).
- **Д-11** — `npm run check` failed ~2 of 10 runs in coverage collection, not tests.
- **Д-14** — snapshots of abandoned tasks were never deleted; git object store grows.
- **Д-16 / Д-22** — regex safety check heuristic without timeout; 250 ms match budget per rule, not per event (guard latency).
- **Д-17 / Д-25** — `list_mcp_servers(include_user_scope)` parsed the whole `~/.claude.json` (tens of MB → seconds and hundreds of MB RAM); the streaming scanner then read a truncated file as "no servers".
- **Д-32** — model downloaded but 382 documents had no vectors: dense search nearly blind.
- **Д-35** — 23–41 test failures per Windows run (closed with PR #38).
- **Д-62** — BGE-M3 through system Python (2.3 GB) was the most fragile install step; replaced by ONNX in Node (partially closed, awaiting `dense-eval`).

`CHANGELOG.md` headings, newest first (`## [Unreleased]` `:8` → `### Added` `:10` dense search without Python, profiles `:48`; `### Changed` `:72` dense vectors record provenance; `### Fixed` `:114` launchers accept pre-2.1 `AI_DEV_MODEL_PATH`; `## [2.0.0] - 2026-09-13` `:327` → `### Fixed — the sweep…` `:395` eight tests that never ran; `### Removed` `:409` working notes; `### Fixed` `:423` memory key per project; `### Added` `:496` `npm run daemon`, ledger/decision tools `:644-646`, cost-capture `:712`; `### Fixed` `:972` packaging; `### Changed` `:1431` main-module ceiling; `### Fixed` `:1559` test isolation from `~/.ai-dev`; `## [1.0.0] - 2026-09-01` `:1734`).

---

## 9. Observations worth acting on

1. Task tools return the full task record on every write (`checkpoint_task`, `verify_task`, `complete_task` each ≥16 KB of `task`), and the SDK path doubles it into `structuredContent` — a summary-first / `include_task` switch would halve typical turn cost.
2. `search_skills` returns unfiltered registry rows (~2.5 KB/hit, 29 KB for the default 10) while `search_all` hits are ~475 B; a projection would bring it in line.
3. The ledger records duration and outcome but not response size, so token cost per tool can only be inferred from the client side.
4. `client` in `tool_call` events is never set; session correlation exists only for `usage` events.
