# Reference study: AgentOps, LangGraph.js, E2B, Cline, Roo Code, Continue

Scope: implementation-level facts useful for a local-first Node.js MCP server ("AI Dev System"). All paths are relative to `scratchpad/ref/<repo>/`. Line numbers refer to the shallow clones read on 2026-09-15.

---

## 1. AgentOps (`AgentOps-AI_agentops`)

**License:** MIT (`LICENSE`).

### Architecture in one paragraph
AgentOps v4 is a thin layer over the OpenTelemetry Python SDK. A "session" is simply a root span of kind `session`; every LLM call, tool call, agent, task and workflow is a child span carrying AgentOps-specific attributes plus OpenTelemetry GenAI attributes. Export is a `BatchSpanProcessor` feeding an OTLP/HTTP exporter that is hard-wired to the AgentOps cloud.

### Sessions / traces
- `TracingCore.start_trace(trace_name="session", tags, is_init_trace)` (`agentops/sdk/core.py:381-428`) creates a root span via `make_span(trace_name, span_kind=SpanKind.SESSION, attributes)`; for the default `"session"` name it also merges host/CPU/memory resource attributes (`get_system_resource_attributes`, `agentops/sdk/attributes.py:19-55`). Active traces are tracked in `self._active_traces[trace_id]`.
- `end_trace(trace_context=None, end_state=TraceState.SUCCESS)` (`core.py:430-463`) ends one or all active traces; `_end_single_trace` (`core.py:464-524`) sets `agentops.session.end_state` (`get_session_end_attributes`, `attributes.py:139-151`), ends the span, force-flushes processors and prints the replay URL.
- `TraceState` enum (`agentops/enums.py:12-28`): `SUCCESS`=`StatusCode.OK`, `ERROR`, `UNSET`.
- Decorators (`agentops/sdk/decorators/__init__.py:11-19`): `@agent`, `@task`/`@operation`, `@workflow`, `@trace` (root/session), `@tool(cost=...)`, `@guardrail(spec="input"|"output")`, `@track_endpoint`. All come from `create_entity_decorator(entity_kind)` (`factory.py:25`). Each wrapped call opens a span named `f"{operation_name}.{span_kind}"` (`decorators/utility.py:101`), sets `agentops.span.kind`, `operation.name`, optional `operation.version` (`utility.py:112-117`), and records JSON-serialised inputs/outputs as `agentops.{entity_kind}.input` / `.output` (`utility.py:138-160`, with a size guard `_check_content_size`).

### Exact span attributes (`agentops/semconv/`)
- Span kinds (`span_kinds.py:7-19`): `workflow, session, task, operation, agent, tool, llm, chain, text, guardrail, http, unknown`. Stored in attribute `agentops.span.kind` (`span_attributes.py:89`).
- LLM spans (`span_attributes.py:27-77`) follow OTel GenAI naming: `gen_ai.system`, `gen_ai.request.model`, `gen_ai.request.max_tokens`, `gen_ai.request.temperature`, `gen_ai.request.top_p`, `gen_ai.request.streaming`, `gen_ai.request.functions`, `gen_ai.prompt`, `gen_ai.completion`, `gen_ai.response.model`, `gen_ai.response.finish_reason`, `gen_ai.response.id`, `gen_ai.usage.prompt_tokens`, `gen_ai.usage.completion_tokens`, `gen_ai.usage.total_tokens`, `gen_ai.usage.cache_creation_input_tokens`, `gen_ai.usage.cache_read_input_tokens`, `gen_ai.usage.reasoning_tokens`, `gen_ai.usage.total_cost`, streaming metrics `gen_ai.streaming.time_to_first_token`, `gen_ai.streaming.time_to_generate`, `gen_ai.streaming.chunk_count`.
- Indexed message attributes (`message.py:7-59`): `gen_ai.prompt.{i}.role|content|type|speaker`; `gen_ai.request.tools.{i}.id|type|name|description|arguments`; `gen_ai.completion.{i}.id|type|role|content|finish_reason|speaker`; nested `gen_ai.completion.{i}.tool_calls.{j}.id|type|status|name|description|arguments`.
- Tool spans (`tool.py`): `tool.id`, `tool.name`, `tool.description`, `tool.parameters`, `tool.result`, `tool.status`, plus optional `gen_ai.usage.total_cost` set from `@tool(cost=...)` (`factory.py:391-392`).
- Agent spans (`agent.py`): `agent.id`, `agent.name`, `agent.role`, `agent.tools`, `agent.models`, `agent.reasoning`, handoff `from_agent`/`to_agent`.
- Action/workflow spans (`workflow.py`): `workflow.name`, `workflow.type`, `workflow.workflow_id`, `workflow.run_id`, `workflow.input`, `workflow.output`, `workflow.final_output`, `workflow.step.type`, `workflow.step.status`, `workflow.max_turns`, `workflow.session_id`, `workflow.user_id`, etc.
- Core on every span (`core.py`): `error.type`, `error.message`, `agentops.tags`, `trace.id`, `span.id`, `parent.id`, `group.id`.
- Resource attributes (`resource.py`): `agentops.project.id`, `service.name`, `service.version`, `agentops.sdk.name/version`, `host.*`, `cpu.*`, `memory.*`, `imported_libraries`.

### Export / offline
- `setup_telemetry()` (`core.py:78-148`) always constructs `AuthenticatedOTLPExporter(endpoint=exporter_endpoint, jwt_provider)` (`sdk/exporters.py:16`) in a `BatchSpanProcessor` plus `OTLPMetricExporter`; default endpoints `https://otlp.agentops.ai/v1/traces` and `/v1/metrics`. There is no file/console exporter, and no `OTEL_EXPORTER_*` env handling (grep confirms none).
- `Config` reads env vars (`agentops/config.py:39-131`): `AGENTOPS_API_KEY`, `AGENTOPS_API_ENDPOINT`, `AGENTOPS_APP_URL`, `AGENTOPS_EXPORTER_ENDPOINT`, `AGENTOPS_EXPORT_FLUSH_INTERVAL` (1000 ms), `AGENTOPS_MAX_QUEUE_SIZE` (512), `AGENTOPS_MAX_WAIT_TIME` (5000), `AGENTOPS_INSTRUMENT_LLM_CALLS`, `AGENTOPS_AUTO_START_SESSION`, `AGENTOPS_SKIP_AUTO_END_SESSION`, `AGENTOPS_ENV_DATA_OPT_OUT`, `AGENTOPS_FAIL_SAFE`, `AGENTOPS_TRACE_NAME`, `AGENTOPS_DEFAULT_TAGS`.
- **Bug-level detail:** the documented `exporter` kwarg ("Custom span exporter", `core.py:181`) is never forwarded: `initialize()` builds `TracingConfig` without it (`core.py:203-212`) and `setup_telemetry` has no exporter parameter (`core.py:78-87`). Local-only export therefore requires pointing `AGENTOPS_EXPORTER_ENDPOINT` at your own OTLP/HTTP collector; the exporter still expects a JWT (`exporters.py:71-119`).
- `InternalSpanProcessor` (`sdk/processors.py:15-71`) only tracks the root span and uploads a logfile when it ends.

### Cost calculation
Not in the SDK. Spans carry token counts only; cost is computed server-side and fetched back via `GET https://api.agentops.ai/public/v1/traces/{trace_id}/metrics` (`agentops/validation.py:131-154`, returns `total_cost`). The only client-side cost is the manual `@tool(cost=)` attribute.

### Portable ideas
- Adopt the attribute vocabulary verbatim for a local flight recorder: span kinds `session/agent/task/tool/llm`, `agentops.span.kind`, `operation.name`, `agentops.{kind}.input/output`, and the OTel GenAI `gen_ai.*` keys including indexed `gen_ai.prompt.{i}.*` / `gen_ai.completion.{i}.tool_calls.{j}.*`. This keeps traces readable by any OTel tool.
- Session = root span with `agentops.session.end_state` in `{SUCCESS, ERROR, UNSET}`; children nest via context propagation. In Node, use `@opentelemetry/sdk-trace-node` with a custom `SpanExporter` writing NDJSON to disk (what AgentOps lacks).
- Record cache/reasoning token fields separately (`gen_ai.usage.cache_read_input_tokens`, `reasoning_tokens`) and compute cost locally from a model price table, since the reference leaves cost to the cloud.
- Input/output capture with a size cap (`_check_content_size`) before serialising.

### Not applicable
Python-only; cloud-bound exporter/JWT auth; `app/` dashboard; provider instrumentors (`agentops/instrumentation/providers/*`) that monkey-patch Python SDKs.

---

## 2. LangGraph.js (`langchain-ai_langgraphjs`)

**License:** MIT (`LICENSE`). Packages: `libs/checkpoint` (`@langchain/langgraph-checkpoint`), `libs/checkpoint-sqlite`, `libs/langgraph-core` (the real pregel; `libs/langgraph` is only a re-export shim, `libs/langgraph/src/pregel/index.ts:1-5`).

### BaseCheckpointSaver contract (`libs/checkpoint/src/base.ts`)
```ts
abstract class BaseCheckpointSaver<V extends string|number = number> {
  serde: SerializerProtocol = new JsonPlusSerializer();          // base.ts:79
  async get(config): Promise<Checkpoint|undefined>               // :86  (getTuple().checkpoint)
  abstract getTuple(config): Promise<CheckpointTuple|undefined>  // :90
  abstract list(config, options?: {limit?, before?: RunnableConfig, filter?}): AsyncGenerator<CheckpointTuple> // :93
  abstract put(config, checkpoint, metadata, newVersions: ChannelVersions): Promise<RunnableConfig> // :97
  abstract putWrites(config, writes: PendingWrite[], taskId: string): Promise<void> // :103
  abstract deleteThread(threadId: string): Promise<void>         // :108
  async getDeltaChannelHistory({config, channels})                // :109 walks parentConfig chain
  getNextVersion(current?: V): V                                  // :164 numeric +1 by default
}
```
Types:
- `Checkpoint { v: number; id: string; ts: string; channel_values: Record<C,unknown>; channel_versions: Record<C,ChannelVersion>; versions_seen: Record<N, Record<C,ChannelVersion>> }` (`base.ts:14-24`); `emptyCheckpoint()` uses `v: 4` and `uuid6(0)` ids (`base.ts:46-55`, `id.ts`), so checkpoint ids are time-sortable UUIDv6.
- `CheckpointMetadata = { source: "input"|"loop"|"update"|"fork"; step: number; parents: Record<string,string>; counters_since_delta_snapshot? } & Extra` (`types.ts`).
- `CheckpointTuple { config; checkpoint; metadata?; parentConfig?; pendingWrites?: CheckpointPendingWrite[] }` (`base.ts:66-72`).
- `PendingWrite = [channel, value]`; `CheckpointPendingWrite = [taskId, channel, value]` (`types.ts`).
- Special channels get fixed negative write indexes: `WRITES_IDX_MAP = { __error__: -1, __scheduled__: -2, __interrupt__: -3, __resume__: -4 }` (`base.ts:190-195`; constants in `serde/types.ts:9-13`).
- `EXCLUDED_METADATA_KEYS` strips `thread_id, checkpoint_id, checkpoint_ns, checkpoint_map, langgraph_*` from stored metadata (`base.ts:196-206`).
- `SerializerProtocol { dumpsTyped(data): Promise<[type: string, Uint8Array]>; loadsTyped(type, data) }` (`serde/base.ts:1-5`); `JsonPlusSerializer` emits `"json"` or `"bytes"` and revives `{lc:2,type:"constructor",id:[...]}` records (`serde/jsonplus.ts:227-255`).

### Config keys
`config.configurable.thread_id`, `checkpoint_ns` (default `""`), `checkpoint_id` (legacy alias `thread_ts`, `base.ts:207-211`). Subgraph namespaces are joined with `CHECKPOINT_NAMESPACE_SEPARATOR = "|"` and node/task suffix `CHECKPOINT_NAMESPACE_END = ":"` (`langgraph-core/src/constants.ts:134-135`; `loop.ts:552-558`). `MemorySaver` keys `storage[thread_id][checkpoint_ns][checkpoint_id]` and refuses empty-string keys except `checkpoint_ns` (`memory.ts:35-58, 156-172`).

### SQLite saver schema (`libs/checkpoint-sqlite/src/index.ts:116-137`, better-sqlite3)
```sql
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT, type TEXT, checkpoint BLOB, metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id));
CREATE TABLE IF NOT EXISTS writes (
  thread_id TEXT NOT NULL, checkpoint_ns TEXT NOT NULL DEFAULT '', checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL, idx INTEGER NOT NULL, channel TEXT NOT NULL, type TEXT, value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx));
```
Latest checkpoint = `ORDER BY checkpoint_id DESC LIMIT 1` (`index.ts:84`, relies on UUIDv6 ordering); `list` orders `checkpoint_id DESC` (`:304`); `put` is `INSERT OR REPLACE` (`:429`); `putWrites` uses `INSERT OR REPLACE` only when every write targets a special channel (so INTERRUPT can be overwritten by RESUME) and `INSERT OR IGNORE` otherwise (`:461-475`); `deleteThread` deletes from both tables (`:508-510`).

### Time travel, updateState, interrupts
- `getStateHistory(config, options)` (`langgraph-core/src/pregel/index.ts:1120-1170`) iterates `checkpointer.list()` and maps each tuple to a `StateSnapshot { values, next: string[], config, metadata, createdAt, parentConfig, tasks: PregelTaskDescription[] }` (`pregel/types.ts:616-636`); each task carries `interrupts: Interrupt[]`, `error?`, `result?` (`types.ts:575-583`).
- Running with `configurable.checkpoint_id` set makes the loop load that checkpoint and *fork* from it: `skipDoneTasks` is false when `checkpoint_id` is present (`loop.ts:544-546`), and the new checkpoint's `parentConfig` points to the requested one, so history becomes a tree, not a line. Nested subgraph runs derive `checkpoint_ns` from the scratchpad counter (`loop.ts:550-559`); `CONFIG_KEY_CHECKPOINT_MAP` resolves per-namespace ids (`loop.ts:582-592`).
- `updateState`/`bulkUpdateState(startConfig, updates:[{values, asNode?, taskId?}])` (`index.ts:1192-1660`) writes a checkpoint with `metadata.source: "update"` (`:1289, :1375`), `"fork"` when `asNode === COPY` (`:1390-1415`), and resolves `asNode` from `versions_seen` when ambiguous (`:1606-1646`, throws `InvalidUpdateError("Ambiguous update, specify \"asNode\"")`).
- Interrupts: `interrupt(value)` (`langgraph-core/src/interrupt.ts:63-112`) increments `scratchpad.interruptCounter`, returns the matching `scratchpad.resume[idx]` if present (and writes `[RESUME, resume[]]` as a pending write), else throws `GraphInterrupt([{id, value}])`. The loop persists it as a pending write on channel `__interrupt__` (idx −3) against the current checkpoint (`loop.ts:845-885`), and resuming with `new Command({ resume })` (`constants.ts:449-472`) stores `__resume__` (idx −4). Because interrupts are ordinary writes, they survive process restarts and appear in `StateSnapshot.tasks[].interrupts`.

### Store (long-term memory) API (`libs/checkpoint/src/store/base.ts`)
- `Item { value: Record<string,any>; key: string; namespace: string[]; createdAt: Date; updatedAt: Date }`; `SearchItem extends Item { score? }` (`:37-46`).
- Operations: `GetOperation {namespace, key}`, `PutOperation {namespace, key, value|null, index?: false|string[]}`, `SearchOperation {namespacePrefix, filter?, limit?, offset?, query?}`, `ListNamespacesOperation {matchConditions?: [{matchType:"prefix"|"suffix", path:(string|"*")[]}], maxDepth?, limit, offset}` (`:47-75`).
- `abstract class BaseStore { abstract batch(ops); get(); search(namespacePrefix, {filter,limit,offset,query}); put(namespace,key,value,index?); delete(); listNamespaces({prefix,suffix,maxDepth,limit,offset}); start(); stop() }` (`:125-195`). `IndexConfig { dims, embeddings, fields? }` enables vector search (`:92-96`).
- Namespace rules (`validateNamespace`, `:19-45`): non-empty array of non-empty strings, no `.` in labels, first segment must not be `"langgraph"`.

### Portable ideas
- Copy the two-table SQLite layout (checkpoints + writes keyed by `(thread_id, checkpoint_ns, checkpoint_id)` with `parent_checkpoint_id`) for an MCP-side "task thread" store; UUIDv6 ids give ordering for free.
- Represent human-in-the-loop as *pending writes on a reserved channel* with negative idx, so an interrupt is durable and replaceable by a resume value.
- Metadata `source ∈ {input, loop, update, fork}` + `step` + `parents` is a minimal, sufficient provenance model; branching from any checkpoint by passing its id is what enables "time travel".
- Store API: `namespace: string[]` + `key` + JSON `value` with prefix search and optional embedding index over selected fields.

### Not applicable
Graph/channel execution engine itself (Pregel), LangChain `RunnableConfig` coupling, Postgres/Redis/Mongo savers, `langgraph-api` server.

---

## 3. E2B (`e2b-dev_E2B`)

**License:** Apache-2.0 (`LICENSE`). Studied: `packages/js-sdk/src/`.

### Sandbox class (`sandbox/index.ts`, extends `SandboxApi` in `sandbox/sandboxApi.ts`)
Instance surface: `files: Filesystem`, `commands: Commands`, `pty: Pty`, `git: Git` (deprecated, `:95`), `sandboxId`, `sandboxDomain`, `trafficAccessToken?` (`:83-112`).
Statics: `Sandbox.list(opts) → SandboxPaginator` (`:248`), `Sandbox.create(template?|snapshotId, opts)` (`:265-289`), `Sandbox.connect(sandboxId, opts)` (`:371`, auto-resumes a paused sandbox, `:352`), `Sandbox.fork(...)` (`:427`), plus `SandboxApi.kill/getInfo/getFullInfo/getMetrics/setTimeout/updateNetwork/pause/betaPause/createSnapshot/listSnapshots/deleteSnapshot` (`sandboxApi.ts:1243-1631`).
Instance methods: `connect()`, `fork()`, `getHost(port)`, `isRunning()`, `setTimeout(ms)`, `updateNetwork()`, `kill()`, `pause({keepMemory?})` (`:660`; `betaPause` is `@deprecated`, `:665-669`), `createSnapshot({name})` → `snapshotId` usable with `Sandbox.create(snapshotId)` (`:696`), `listSnapshots()`, `getMcpUrl()`, `getMcpToken()`, `uploadUrl(path)`, `downloadUrl(path)` (signed, `signature.ts`), `getInfo()`, `getMetrics()` (`:468-865`).
- `SandboxOpts` (`sandboxApi.ts:581-637`): `template`, `metadata`, `envs`, `timeoutMs`, `secure`, `allowInternetAccess`, `mcp`, `network`.
- **Timeouts:** `DEFAULT_SANDBOX_TIMEOUT_MS = 300_000` (`connectionConfig.ts:11`), default template `'base'` (`sandbox/index.ts:76`), per-request `requestTimeoutMs` default 60 s (`connectionConfig.ts:60`), 3 retries (`:69`).

### Sub-APIs
- `Filesystem` (`sandbox/filesystem/index.ts`): `read(path,{format:'text'|'bytes'|'blob'|'stream'})`, `write(path, data)`, `writeFiles([...])`, `list(path,{depth})`, `makeDir`, `rename`, `remove`, `exists`, `getInfo`, `watchDir(path, cb)` (`:399-1034`).
- `Commands` (`sandbox/commands/index.ts`): `run(cmd, {background, cwd, user, envs, onStdout, onStderr, timeoutMs})` → `CommandResult` or `CommandHandle` when `background: true` (`:383-418`, `:49-91`); `list()`, `sendStdin(pid)`, `closeStdin(pid)`, `kill(pid)`, `connect(pid)`.
- `Pty` (`sandbox/commands/pty.ts`): `create({cols, rows, onData, envs, cwd, user})`, `connect(pid)`, `sendInput(pid, bytes)`, `resize(pid, size)`, `kill(pid)` (`:108-315`).
- `Template` builder (`template/index.ts`): `fromImage/fromDebianImage/fromUbuntuImage/fromPythonImage/fromNodeImage/fromBaseImage/fromTemplate/fromDockerfile/fromAWSRegistry/fromGCPRegistry`, chained `copy/copyItems/remove/rename/makeDir/makeSymlink/runCmd/setWorkdir/setUser`, then `Template.build()` / `buildInBackground()` / `getBuildStatus()` / `exists()` / `assignTags()` (`:98-753`). Builds run in E2B's cloud, not locally.

### Auth & hosting model
- `ConnectionConfig` (`connectionConfig.ts:347-520`): `apiKey` ← `E2B_API_KEY`; `domain` ← `E2B_DOMAIN` or `e2b.app`; `apiUrl` ← `E2B_API_URL` or `https://api.${domain}`; `E2B_SANDBOX_URL`; `E2B_DEBUG=true` targets `http://localhost:3000`. Sandbox host pattern `${port}-${sandboxId}.${domain}` (`:568`). Inside the sandbox, envd requests carry `X-Access-Token: <envdAccessToken>` (`sandbox/index.ts:118-190`).
- **Cloud vs self-host:** the SDK is a pure API client; all lifecycle (create/kill/pause/snapshot/template build) is REST against `api.<domain>`. Self-hosting is possible only by deploying the separate Terraform-based `e2b-dev/infra` repo (`README.md:104-106`) and pointing `E2B_DOMAIN` at it. No local sandbox runtime exists in this repo.

### Portable ideas
- The *shape* of the sandbox API is a good local abstraction: `files`, `commands.run({background, onStdout, onStderr, timeoutMs, cwd, envs})` returning either a result or a handle, `pty`, `setTimeout`, `pause/resume`, `createSnapshot → create(snapshotId)`. Implement it locally over child processes / containers.
- Idle-timeout as a first-class sandbox property (default 5 min) and `connect()` that transparently resumes.
- Signed, expiring upload/download URLs for artefact exchange.

### Not applicable
Cloud API, Firecracker infra, template build service, metadata/tags billing model, MCP-server-in-sandbox (`getMcpUrl`).

---

## 4. Cline (`cline_cline`)

**License:** Apache-2.0 (`LICENSE`). Note: this clone is the restructured monorepo; the old `src/integrations/checkpoints/CheckpointTracker.ts` / `GitOperations.ts` (shadow-git approach) no longer exist. Checkpointing now lives in `sdk/packages/core/src/hooks/checkpoint-hooks.ts` and `session/checkpoint-restore.ts`, and it works **inside the user's own repository** rather than a shadow repo.

### Checkpoints (current implementation)
- Created by `createCheckpointHooks({cwd, sessionId, readSessionMetadata, writeSessionMetadata})` (`checkpoint-hooks.ts:497`), which first checks `git rev-parse --is-inside-work-tree` (non-git workspaces get no checkpoints).
- Per run, `createWorktreeStashCommit(cwd, scratchDir, message)` (`:349-430`) runs `git stash create <msg>`; if untracked files exist it builds an extra "untracked parent" commit from `git ls-files --others --exclude-standard` through a private index file (`:249-335`, `write-tree` + `commit-tree`), then re-creates the stash commit with three parents `(HEAD, index, untracked)` so `git stash apply` semantics hold. If the tree is clean it falls back to a `kind: "commit"` checkpoint pointing at HEAD (`:575-600`).
- The result is stored as a private ref `refs/cline/checkpoints/<sessionId>/<runCount>` (`:630-632`), never in `refs/stash`, so it doesn't pollute `git stash list`. Exclusions = whatever `.gitignore` already excludes (`--exclude-standard`); there is no separate exclusion list. A scratch index lives in `<clineDataDir>/checkpoint-scratch/<sha256(cwd+sessionId)[:32]>` (`:25-47`).
- `CheckpointEntry { ref, createdAt, runCount, kind?: "stash"|"commit" }`; session metadata keeps `{ latest, history[] }` (`:80-90`). `deleteCheckpointRefs` / `retainCheckpointRefs` prune refs (`:437-480`).
- Restore: `ClineCheckpointRestore = "task" | "workspace" | "taskAndWorkspace"` (`apps/vscode/src/shared/WebviewMessage.ts:21`). `createCheckpointRestorePlan({session, messages, checkpointRunCount, restoreMessages})` (`checkpoint-restore.ts:266`) finds the checkpoint at-or-before the run and trims messages via `trimMessagesToCheckpoint` (task restore). `applyCheckpointToWorktree(cwd, checkpoint)` (`:376`) refuses if HEAD moved from the checkpoint's base (`:398-420`, message explains commits added after / rebase) and otherwise resets and applies the stash. Before destroying, `beginWorktreeRestoreTransaction` (`:50`) snapshots the current tree with `stash push --include-untracked` and offers `commit()/rollback()` (rollback = `reset --hard` + `clean -fd` + stash apply, `:90-150`). Diff view: `compareCheckpointToWorkspace` reads the stash's third parent for untracked files (`checkpoint-diff.ts:61-121`).

### Context-window management
- Compaction pipeline in `sdk/packages/core/src/extensions/context/compaction.ts`; trigger when usage reaches `COMPACTION_TRIGGER_RATIO = 0.9` of `model.info.contextWindow` (`compaction-shared.ts:17`, `compaction.ts:317-338`), with a long-conversation target ratio 0.5 clamped to [0.05, 0.95] (`compaction.ts:90, 183-188`). `agentic-compaction.ts` produces an LLM summary via a configurable summariser (`runAgenticCompaction`, `:116`). Persisted state `SessionCompactionState { version:1, updated_at, conversation_id?, source_message_count, source_prefix_hash?, source_last_message_key?, messages[], system_prompt? }` (`session/models/session-compaction.ts:22-32`) lets the summary be reused as long as the source prefix hash matches.

### Auto-approval (`apps/vscode/src/shared/AutoApprovalSettings.ts`)
`{ version, enabled, favorites[], maxRequests, actions: { readFiles, readFilesExternally?, editFiles, editFilesExternally?, executeSafeCommands?, executeAllCommands?, useBrowser, useMcp }, enableNotifications }`; defaults: `maxRequests: 20`, `readFiles/editFiles/useBrowser/useMcp: true`, `executeSafeCommands: false`, `executeAllCommands: true`, `enableNotifications: false`.

### Portable ideas
- Checkpoint = `git stash create` + synthesised untracked parent, stored under a private ref namespace (`refs/<tool>/checkpoints/<session>/<n>`): zero extra repo, invisible to `git stash list`, honours `.gitignore`, and restorable with `git stash apply`. Run count as the checkpoint key ties workspace state to conversation turns.
- Guard restores by verifying HEAD equals the checkpoint base; wrap destructive restores in a stash-backed transaction with rollback.
- Compaction: trigger at 90 % of context window, persist summary keyed by a prefix hash so repeated runs don't re-summarise.
- Auto-approval as a small boolean matrix per action class with a `maxRequests` budget.

### Not applicable
VS Code webview/proto plumbing, hooks fixtures, Cline account/hub features.

---

## 5. Roo Code (`RooCodeInc_Roo-Code`)

**License:** Apache-2.0 (`LICENSE`).

### Mode → tool-group → permission model
- Tool groups (`packages/types/src/tool.ts`): `toolGroups = ["read","edit","command","mcp","modes"]`; `"browser"` is deprecated and filtered out of mode definitions (`mode.ts` `groupEntryArraySchema` preprocess).
- `TOOL_GROUPS` (`src/shared/tools.ts:296-314`): `read → read_file, search_files, list_files, codebase_search`; `edit → apply_diff, write_to_file, generate_image` + opt-in `customTools: edit, search_replace, edit_file, apply_patch` (only when the model's `includedTools` lists them); `command → execute_command, read_command_output`; `mcp → use_mcp_tool, access_mcp_resource`; `modes → switch_mode, new_task` (`alwaysAvailable: true`). `ALWAYS_AVAILABLE_TOOLS = ask_followup_question, attempt_completion, switch_mode, new_task, update_todo_list, run_slash_command, skill` (`:317-325`).
- A mode's `groups` is an array of `GroupEntry = ToolGroup | [ToolGroup, { fileRegex?: string, description?: string }]` (`mode.ts` `groupEntrySchema`); duplicates rejected. `ModeConfig { slug /^[a-zA-Z0-9-]+$/, name, roleDefinition, whenToUse?, description?, customInstructions?, groups, source?: "global"|"project" }`.
- Built-in `DEFAULT_MODES` (`mode.ts`): `architect` → `["read", ["edit", {fileRegex: "\\.md$"}], "mcp"]`; `code` → `["read","edit","command","mcp"]`; `ask` → `["read","mcp"]`; `debug` → `["read","edit","command","mcp"]`; `orchestrator` → `[]` (delegates via `new_task`, which is always available).
- Permission check `isToolAllowedForMode(tool, modeSlug, customModes, toolRequirements?, toolParams?, experiments?, includedTools?)` (`src/core/tools/validateToolUse.ts:120-215`): resolve aliases → deny if `toolRequirements[tool] === false` → allow if in `ALWAYS_AVAILABLE_TOOLS` → allow registered custom tools when the experiment is on → gate experiment-flagged tools → look up mode → for each group entry: dynamic `mcp_*` tools pass if the mode has `mcp`; otherwise the tool must be in `groupConfig.tools` (or in `customTools` *and* `includedTools`); if the entry has options and it's the `edit` group with `fileRegex`, the `path`/`file_path` param of an edit operation must match or `FileRestrictionError(mode.name, fileRegex, description, filePath, tool)` is thrown (`src/shared/modes.ts:135-143`). Tools not covered by any group return false.
- `getToolsForMode(groups)` unions group tools + always-available (`modes.ts:28-42`). Custom modes: `.roomodes` (YAML, JSON fallback) in the workspace root, merged over global `<settings>/custom_modes.yaml` with project modes taking precedence and tagged `source: "project"` (`src/core/config/CustomModesManager.ts:19, 101-103, 153-160, 234, 251, 297-301`; `src/shared/globalFileNames.ts:5`).

### Portable ideas
- Permission = mode × tool-group with an optional per-group predicate (`fileRegex` on edit). Encode as YAML: `groups: [read, [edit, {fileRegex: "\\.md$"}], command]`.
- Keep a small always-allowed set (ask/complete/switch/new_task) outside the groups, and treat MCP tools as one group.
- Project-level override file (`.roomodes`) merged over a global file; slugs unique; deprecated groups silently dropped for forward compatibility.

### Not applicable
VS Code prompt assembly, experiment flags, i18n, webview.

---

## 6. Continue (`continuedev_continue`)

**License:** Apache-2.0 (`LICENSE`).

### Context provider contract (`core/index.d.ts`)
```ts
type ContextProviderType = "normal" | "query" | "submenu";                         // :181
interface ContextProviderDescription { title: ContextProviderName; displayTitle; description; renderInlineAs?; type; dependsOnIndexing?: ("chunk"|"embeddings"|"fullTextSearch"|"codeSnippets")[] } // :188
interface ContextProviderExtras { config: ContinueConfig; fullInput: string; embeddingsProvider: ILLM|null; reranker: ILLM|null; llm: ILLM; ide: IDE; selectedCode: RangeInFile[]; fetch: FetchFunction; isInAgentMode: boolean } // :199
interface LoadSubmenuItemsArgs { config; ide; fetch }
interface ContextSubmenuItem { id; title; description; icon?; metadata? }           // :233
interface IContextProvider {                                                         // :261
  get description(): ContextProviderDescription;
  getContextItems(query: string, extras: ContextProviderExtras): Promise<ContextItem[]>;
  loadSubmenuItems(args: LoadSubmenuItemsArgs): Promise<ContextSubmenuItem[]>;
  get deprecationMessage(): string | null;
}
interface ContextItem { content: string; name: string; description: string; editing?; editable?; icon?; uri?: ContextItemUri; hidden?; status? } // :459
interface ContextItemWithId extends ContextItem { id: ContextItemId }
```
`BaseContextProvider` (`core/context/index.ts`) stores constructor `options`, exposes the static `description`, defaults `loadSubmenuItems` to `[]`. `CustomContextProvider` (`index.d.ts`) is the plain-object variant for config-defined providers.

### Built-in providers (`core/context/providers/index.ts:43-74`)
file, diff, tree (FileTree), issue (GitHubIssues), google, terminal, debugger (DebugLocals), open (OpenFiles), http, search, os, problems, folder, docs, gitlab-mr, jira, postgres, database, codebase, code, currentFile, url, repo-map, discord, greptile, web, mcp, commit (GitCommit), clipboard, rules. `contextProviderClassFromName(name)` resolves by `description.title`.

### YAML config & rules
- `config.yaml` `context:` entries are `{ name?, provider: string, params?: any }` (`packages/config-yaml/src/schemas/index.ts:11-15`, used at `:126,159,171`).
- Rules are `string | { name, rule, description?, globs?: string|string[], regex?, alwaysApply?, invokable?, sourceFile? }` (`:36-46`). Loaders: markdown files in `.continue/rules/` and `.continue/prompts/` (`core/config/markdown/loadMarkdownRules.ts:12, 57-60`) and colocated `rules.md` anywhere in the codebase (`loadCodebaseRules.ts:65-85`, `RULES_MARKDOWN_FILENAME` in `core/llm/rules/constants.ts`). Application: `getSystemMessageWithRules` includes rules with `alwaysApply: true` or root-level rules without globs, and glob-matched rules (minimatch, `!` negation supported) for files in context (`core/llm/rules/getSystemMessageWithRules.ts:16-45, 141`).

### Portable ideas
- MCP "resource providers" can mirror this contract: a description `{title, displayTitle, description, type: normal|query|submenu}`, `getContextItems(query, extras)` returning `{name, description, content, uri?}` items, and `loadSubmenuItems()` for enumerable sources. `dependsOnIndexing` declares what index a provider needs.
- Config as a flat list of `{provider, params}` blocks; rules as markdown with front-matter `globs`/`alwaysApply`, resolved per file in context, plus nested colocated `rules.md`.

### Not applicable
IDE (`IDE` interface) coupling, GUI, Continue Hub blocks, embeddings/reranker infrastructure.

---

## Cross-cutting takeaways for the AI Dev System
1. **Flight recorder:** OTel spans with AgentOps' `gen_ai.*`/`agentops.*` attribute names, exported locally to NDJSON/SQLite (AgentOps has no offline exporter; build one).
2. **Task state:** LangGraph's checkpoint/writes SQLite tables + UUIDv6 ids + `source/step/parents` metadata; interrupts as reserved-channel pending writes; `BaseStore` namespace/key/value for long-term memory.
3. **Workspace state:** Cline's stash-commit checkpoints under private refs, HEAD-guarded restore with rollback transaction; compaction at 90 % of context.
4. **Sandbox abstraction:** E2B's `files/commands/pty` + timeout/pause/snapshot surface, implemented locally.
5. **Permissions:** Roo's mode × tool-group (+ `fileRegex`) matrix and Cline's per-action auto-approve booleans with a request budget.
6. **Context providers:** Continue's `IContextProvider` / `ContextItem` contract and glob-scoped markdown rules.
