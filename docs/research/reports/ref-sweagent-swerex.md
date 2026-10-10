# SWE-agent / mini-swe-agent / SWE-ReX — ACI and Runtime Abstraction Reference

All three repos: **MIT License** (SWE-agent: `LICENSE`, © 2024 John Yang et al.; mini-swe-agent: `LICENSE.md`, © 2025 Kilian A. Lieret and Carlos E. Jimenez; SWE-ReX: `LICENSE.txt`, © 2024 Kilian Lieret, Carlos E. Jimenez). No copyleft; notice retention is the only real obligation if code is copied verbatim.

## 1. SWE-agent — Agent-Computer Interface

### 1.1 Stated ACI lessons (`docs/background/aci.md:9-14`)
Four explicit lessons SWE-agent calls "immensely helpful":
1. A **linter** runs on every edit; rejected if it introduces a syntax error.
2. A **windowed file viewer** (not raw `cat`) — showing **100 lines** per turn works best, with scroll up/down and in-window search.
3. A **directory-search tool** that lists only file names + match counts — more context per match "proved too confusing for the model."
4. Empty command output gets a synthetic message: "Your command ran successfully and did not produce any output." (throughout config templates, e.g. `config/default_backticks.yaml:32`).

### 1.2 Windowed file viewer (`tools/windowed/lib/windowed_file.py`)
`WindowedFile` (`:53-316`) wraps a path with 0-indexed `first_line`/`window`/`overlap` state persisted via the registry (1.6):
- `window = registry.get_if_none(window, "WINDOW")`, `overlap = registry.get("OVERLAP", 0)` (`:101-102`). Defaults come from `tools/windowed/install.sh:9-10`: `WINDOW=100`, `OVERLAP=2` — matches the doc's "100 lines" claim; legacy configs (`config/human/human.yaml:7-8`, `config/sweagent_0_7/07.yaml:89-90`) hardcode the same values.
- `line_range` clamps to `[first_line, min(first_line+window-1, n_lines-1)]` (`:141-148`).
- `get_window_text(..., pre_post_line=True)` prepends `"({start_line} more lines above)"` and appends `"({n_lines-end_line-1} more lines below)"` when the window doesn't cover the whole file (`:165-174`) — the exact "(N more lines above/below)" rendering asked about.
- `status_line=True` prepends `"[File: {path} ({n_lines} lines total)]"` (`:164`).
- `scroll(n_lines)` moves `first_line` by `n_lines - overlap` (down) or `n_lines + overlap` (up) (`:270-274`) — a 2-line overlap between windows so a boundary-spanning match isn't missed.
- `goto(line, mode="top")` sets `first_line = line - window*offset_multiplier`, `offset_multiplier=1/6` (`:112,264-266`) — target line sits ~1/6 from window top, not centered.
- `replace_in_window`/`replace` do search-and-replace scoped to window vs. whole file, raising `TextNotFound`/printing `"Error: Text not found: {search}"` and exiting 1 in CLI mode (`:190-259`).

`bin/open` (`tools/windowed/bin/open:1-49`): `open "<file>"` with optional line number; clamps out-of-range numbers with warnings ("Warning: <line_number> (…) is greater than the number of lines in the file (…)" / "Setting <line_number> to …"). `bin/goto` validates a single integer arg ("goto allows only one line number at a time." / "Error: <line> must be less than or equal to {n_lines}"). `bin/scroll_down` calls `wf.scroll(wf.window)` then reprints.

### 1.3 Search bundle bounding (`tools/search/bin/*`)
Both are plain bash and both enforce a **hard match-count ceiling of 100** before dumping results, with near-identical wording:
- `search_dir` (`:1-39`): `find … -exec grep -nIH …`, counts distinct files matched; if `num_files -gt 100`: `"More than $num_files files matched for \"$search_term\" in $dir. Please narrow your search."` and returns (no listing). Otherwise: `"Found $num_matches matches for \"$search_term\" in $dir:"`, one line per file as `path (N matches)`, then `"End of matches for ... in $dir"` — the ACI-doc-cited "list only the files that matched" behavior.
- `search_file` (`:1-55`): same shape scoped to one file; threshold is **100 matched lines**, message `"More than $num_lines lines matched for \"$search_term\" in $file. Please narrow your search."`; otherwise `Line <n>:<content>` per match.
- `find_file` (`:1-31`): no count ceiling; lists results or `"No matches found for \"$file_name\" in $dir"`.

### 1.4 Edit tool + lint rejection (`tools/windowed_edit_linting/bin/edit`)
`edit <start_line>:<end_line>` followed by replacement text terminated by a literal `end_of_edit` line (heredoc-style stdin read) or as a second CLI arg (`:46-92`). Flow (`:94-124`): capture pre-edit flake8 output; apply `wf.set_window_text(...)` unconditionally; re-lint via `format_flake8_output(post, previous_errors_string=pre, replacement_window=(start,end), replacement_n_lines=...)`, which diffs old vs new errors so only *newly introduced* errors trigger rejection. On new errors, `wf.undo_edit()` reverts to `_original_text`/`_original_first_line` and prints a structured template (`_LINT_ERROR_TEMPLATE`, `:27-43`):
   ```
   Your proposed edit has introduced new syntax error(s). Please read this error message carefully and then retry editing the file.

   ERRORS:
   {errors}

   This is how your edit would have looked if applied
   ------------------------------------------------
   {window_applied}
   ------------------------------------------------

   This is the original code before your edit
   ------------------------------------------------
   {window_original}
   ------------------------------------------------

   Your changes have NOT been applied. Please fix your edit command and try again.
   DO NOT re-run the same failed edit command. Running it again will lead to the same error.
   ```
   then `exit(1)` — note the explicit anti-loop instruction ("DO NOT re-run the same failed edit command"), a deliberate nudge against repeating a rejected action. On success: `wf.goto(start_line, "top")`, prints `_EDIT_SUCCESS_MSG` ("File updated. Please review the changes and make sure they are correct (correct indentation, no duplicate lines, etc). Edit the file again if necessary.") then reprints the window.

Sibling variant `tools/windowed_edit_replace/bin/edit` uses search/replace-in-window semantics instead of line ranges, with its own `_NOT_FOUND_IN_WINDOW_MSG` ("Your edit was not applied (file not modified): Text {search!r} not found in displayed lines.") — same "reject, explain, don't silently half-apply" pattern. The actually-shipped **default** config (`config/default.yaml:41-44`) uses a third bundle, `tools/edit_anthropic` (`str_replace_editor`, Anthropic-computer-use-style), not the windowed editors — the windowed/linting bundles are legacy/alternative configs (`config/sweagent_0_7/*`, `config/exotic/*`, `config/human/*`).

### 1.5 Other bundles
- **submit**: reverse-applies any pre-existing `/root/test.patch`, `git add -A; git diff --cached > /root/model.patch`, prints sentinel `<<SWE_AGENT_SUBMISSION>>`.
- **diff_state**: a *state command* (not a user-invokable tool — `tools: {}`, `state_command: "_state_diff_state"`), runs after every step to compute `git diff` into `/root/state.json["diff"]`; try/except blanks the diff on failure so a dirty git state never crashes the loop.
- **registry**: pure plumbing bundle (see 1.6), `tools: {}`.
- **filemap**: tree-sitter Python pretty-printer that elides function/method bodies ≥6 lines with `"... eliding lines {start}-{end} ..."`, keeping signatures visible — a context-budget tool for skimming large files without window-by-window opening.

### 1.6 Registry — env-var persistence across subprocesses (`tools/registry/lib/registry.py`)
`EnvRegistry` (`:7-56`) is a small JSON-file-backed KV store at `/root/.swe-agent-env` (overridable via `SWE_AGENT_ENV_FILE`). Docstring rationale: "used to persist state between tool calls without using environment variables (**which are problematic because you cannot set them in a subprocess**)." `get(key, default, fallback_to_env=True)` checks `os.environ` first, then the JSON file — how `CURRENT_FILE`, `FIRST_LINE`, `WINDOW`, `OVERLAP` survive across separate `bin/open`/`bin/goto`/`bin/edit` invocations, each its own OS process with no shared memory.

### 1.7 Observation truncation (`sweagent/agent/agents.py`)
`TemplateConfig.max_observation_length: int = 100_000` chars (`:80-83`). `next_step_truncated_observation_template` (`:69-77`):
```
Observation: {{observation[:max_observation_length]}}<response clipped>
<NOTE>Observations should not exceeded {{max_observation_length}} characters. {{elided_chars}} characters were elided. Please try a different command that produces less output or use head/tail/grep/redirect the output to a file. Do not use interactive pagers.</NOTE>
```
Selection in `add_step_to_history` (`:718-742`): empty observation → `next_step_no_output_template`; over-length → truncated template with `elided_chars = len - max_observation_length`; else → normal `next_step_template`.

### 1.8 History processors (`sweagent/agent/history_processors.py`)
- **`LastNObservations`** (`:85-176`): keeps last `n` observations (plus polling window), never elides the first (instance) observation; tag overrides `always_remove_output_for_tags={"remove_output"}`/`always_keep_output_for_tags={"keep_output"}`. Elided entries become **`"Old environment output: ({num_text_lines} lines omitted)"`**, plus `" ({num_images} images omitted)"` if present (`:172-174`).
- **`ClosedWindowHistoryProcessor`** (`:215-258`): walks history in reverse, tracks which files' windows are already "closed" (superseded by a later window), replaces stale window bodies with `"Outdated window with {N} lines omitted..."`, keeping only the most recent window per file open.
- **`CacheControlHistoryProcessor`** (`:261-302`): tags the last `last_n_messages` (default 2) user/tool messages with Anthropic `cache_control: {"type":"ephemeral"}`, clearing it elsewhere — the default in `config/default.yaml:67-69`.
- **`RemoveRegex`** (`:305-337`): regex-strips content (default `"<diff>.*</diff>"`) from all but the last `keep_last` items — drops repeated diff blocks from context.
- **`TagToolCallObservations`**, **`ImageParsingHistoryProcessor`** round out the set (tag by tool name; convert markdown-embedded base64 images to multimodal segments).

### 1.9 Model error handling (`sweagent/agent/agents.py:1075-1219`)
A retry loop (`while n_format_fails < self.max_requeries`, default `max_requeries=3`, `:158,177,451,472`) around `self.forward(history)`, routed per exception into three tiers:
- **Requery** (increments `n_format_fails`, re-injects history with an error template, loops): `FormatError` → `format_error_template`; `_BlockedActionError` (blocklist hit) → `filter.blocklist_error_template`; `BashIncorrectSyntaxError` → `shell_check_error_template`; `ContentPolicyViolationError` → silent resample.
- **Exit with autosubmission** (extract whatever patch exists, then stop): `_ExitForfeit` → `exit_forfeit`; `_TotalExecutionTimeExceeded` → `exit_total_execution_time`; `CommandTimeoutError` (repeated timeouts) → `exit_command_timeout`; `ContextWindowExceededError` → `exit_context`; `CostLimitExceededError` → `exit_cost`; `RetryError` (tenacity) → `exit_api`; `SwerexException` → `exit_environment_error`; other exceptions → `exit_error`.
- **Hard raise**: `TotalCostLimitExceededError`, `KeyboardInterrupt`, `EOFError` propagate uncaught.
- Exhausting `max_requeries` → `exit_format`, "Exit due to repeated format/blocklist/bash syntax errors."
Taxonomy: *(a) agent-caused/recoverable via requery, (b) environment/limit-caused/salvage-and-exit, (c) fatal/propagate.*

### 1.10 Blocklist (`sweagent/tools/tools.py:29-70`)
`ToolFilterConfig`: `blocklist` (prefix-blocked: `vim, vi, emacs, nano, nohup, gdb, less, tail -f, python -m venv, make`), `blocklist_standalone` (exact-match-blocked: `python, python3, ipython, bash, sh, /bin/bash, /bin/sh, nohup, vi, vim, emacs, nano, su`), `block_unless_regex` (allow only if also matching a regex, e.g. `radare2`/`r2` require `-c <script>`). Rejection message: `"Operation '{{action}}' is not supported by this environment."`

### 1.11 `ToolConfig` keys (`sweagent/tools/tools.py:75-217`)
`filter`, `bundles: list[Bundle]`, `propagate_env_variables`, `env_variables` (default `PAGER=cat, MANPAGER=cat, LESS=-R, PIP_PROGRESS_BAR=off, TQDM_DISABLE=1, GIT_PAGER=cat` — silences pagers/progress bars that would hang a non-interactive shell), `registry_variables`, `submit_command: str = "submit"`, `parse_function` (default `FunctionCallingParser`), `enable_bash_tool: bool = True`, `format_error_template`, `command_docs` (auto-generated), `multi_line_command_endings`, `reset_commands`, `execution_timeout: int = 30`, `install_timeout: int = 300`, `total_execution_timeout: int = 1800`, `max_consecutive_execution_timeouts: int = 3`. `model_post_init` enforces bash can only be disabled with `FunctionCallingParser`/`JsonParser`, and raises on duplicate tool names across bundles. Each **bundle** (`sweagent/tools/bundle.py`) is a directory with `config.yaml` (`tools: dict`, `state_command: str|None`) + `bin/` executables; `state_command`s from all loaded bundles run after each step to refresh environment-derived template variables.

## 2. mini-swe-agent

### 2.1 Single-bash-tool design
`AgentConfig`/`DefaultAgent` (`src/minisweagent/agents/default.py:19-190`) has **no tool registry at all** — the model's entire action space is "exactly ONE bash code block" per the system prompt (`config/default.yaml:5`). `execute_actions` (`default.py:154-157`) just does `[self.env.execute(action) for action in message["extra"]["actions"]]`. Completion is a convention, not a tool: the model runs `echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT`, and every environment's `_check_finished` special-cases that literal first stdout line to raise `Submitted` (`local.py:45-56`, `docker.py:140-151`).

### 2.2 Limits (`agents/default.py:19-36`, enforced in `query()` at `:130-148`)
`step_limit: int = 0` (unlimited), `cost_limit: float = 3.0` (overridden to `0.` in `default.yaml`), `wall_time_limit_seconds: int = 0`, `max_consecutive_format_errors: int = 3` (0 = unlimited). Exceeding step/cost → `LimitsExceeded`; wall time → `TimeExceeded`; format errors past cap → `"RepeatedFormatError"`. All three are plain exit statuses on the last message's `extra`, not thrown further.

### 2.3 Output truncation (`config/default.yaml:114-141`, in the **model's** Jinja `observation_template`, not the environment)
Threshold **10,000 characters**: `output.output | length < 10000` shows it whole in `<output>…</output>`; else a `<warning>` block ("too long… try head/tail/sed… more selective grep/find… redirect to a file and search") plus `<output_head>` = first 5000 chars, `<elided_chars>` count, `<output_tail>` = last 5000 chars. This lives in the *model glue layer*, not the environment — the environment returns full output unmodified.

### 2.4 Environment classes and common interface (`environments/local.py`, `docker.py`, `singularity.py`, `extra/*.py`)
Common surface across all environment classes (duck-typed, no ABC): `__init__(*, config_class, **kwargs)`, `execute(action: dict, cwd: str="", *, timeout: int|None=None) -> dict[str, Any]` returning `{"output","returncode","exception_info","extra"?}`, `get_template_vars(**kwargs) -> dict`, `serialize() -> dict`.
- **`LocalEnvironment`** (`local.py:19-93`): `subprocess.Popen(command, shell=True, ..., start_new_session=True)`; on `TimeoutExpired`, kills the whole process group with `os.killpg(pid, SIGKILL)` — notable pattern for a Node backend (`detached:true` + `process.kill(-pid)`).
- **`DockerEnvironment`** (`docker.py:15-161`): each `execute()` is an independent `docker exec -w <cwd> [-e K=V ...] <container> <interpreter...> <command>` (default `interpreter: ["bash","-lc"]`) — **no persistent shell session**; state doesn't carry between calls except via `config.cwd`/`config.env`/`forward_env`, and the instance template warns the model directly: "Directory or environment variable changes are not persistent. Every action is executed in a new subshell" (`config/default.yaml:39-40`), suggesting `VAR=val cd /path && ...`. Container starts once via `docker run -d ... sleep <container_timeout>`, torn down via backgrounded `docker stop || docker rm -f`.
- `extra/swerex_docker.py` / `extra/swerex_modal.py` wrap **SWE-ReX** deployments directly — mini-swe-agent treats SWE-ReX as just another environment behind the same `execute()` shape.

## 3. SWE-ReX

### 3.1 `AbstractRuntime` (`src/swerex/runtime/abstract.py:234-289`)
Abstract methods, all `async`:
```
is_alive(*, timeout=None) -> IsAliveResponse
create_session(request: CreateSessionRequest) -> CreateSessionResponse
run_in_session(action: Action) -> Observation
close_session(request: CloseSessionRequest) -> CloseSessionResponse
execute(command: Command) -> CommandResponse
read_file(request: ReadFileRequest) -> ReadFileResponse
write_file(request: WriteFileRequest) -> WriteFileResponse
upload(request: UploadRequest) -> UploadResponse
close() -> CloseResponse
```
Two modes are cleanly separated: **`execute(Command)`** is one-off/stateless (`Command{command: str|list[str], timeout, shell=False, check=False, error_msg, env, cwd, merge_output_streams}` → `CommandResponse{stdout, stderr, exit_code}`), analogous to `subprocess.run()`, `shell` defaulting **False** with list-of-args support (`abstract.py:143-182`). **`create_session`/`run_in_session`/`close_session`** are the persistent-shell (REPL) path: `BashAction{command, session="default", timeout, is_interactive_command, is_interactive_quit, check:"silent"|"raise"|"ignore", error_msg, expect: list[str]}` → `BashObservation{output, exit_code, failure_reason, expect_string}`; `expect` lets a caller supply extra sentinel strings beyond the shell's PS1 for interactive programs. `BashInterruptAction{session, timeout=0.2, n_retry=3, expect}` sends Ctrl-C, falling back to Ctrl-Z + `kill -9 %1`.

### 3.2 `AbstractDeployment` (`deployment/abstract.py:11-61`)
```
add_hook(hook: DeploymentHook)
is_alive(*, timeout=None) -> IsAliveResponse
start(*args, **kwargs)
stop(*args, **kwargs)
runtime -> AbstractRuntime   # property, raises DeploymentNotStartedError if not started
```
Deployment = lifecycle/provisioning (spin up a Docker container / Modal sandbox / Fargate task / local no-op) that *produces* a `Runtime`; Runtime = the command-execution API against that already-provisioned target. `LocalDeployment` is the trivial case: `start()` instantiates `LocalRuntime()` in-process, `stop()` calls `runtime.close()`.

### 3.3 Session semantics (`runtime/local.py`)
`BashSession` (`:129-362`) spawns `pexpect.spawn("/usr/bin/env bash", echo=False, env={PS1:"SHELLPS1PREFIX", PS2:"", PS0:""})`. `start()` optionally sources `startup_source` files, resets `PS1/PS2/PS0` (files often clobber `PS1`), then `expect(ps1, timeout=startup_timeout)` (default 1.0s). Each `_run_normal`: prechecks syntax via a throwaway `bash -n <<'SOUNIQUEEOF'` subprocess (→ `BashIncorrectSyntaxError` with captured output); splits multi-line/heredoc input with `bashlex`, rejoins with `;` (falls back to a unique-string terminator if `bashlex` throws); `sendline`; `expect(action.expect + [ps1], timeout)` → `CommandTimeoutError` on `pexpect.TIMEOUT`; then a **second** round-trip (`echo EXITCODESTART$?EXITCODEEND`) extracts the exit code, capped at a hardcoded 1s → `NoExitCodeError`. `check="raise"` (default) → `NonZeroExitCodeError`; `"silent"` swallows extraction failures; `"ignore"` skips exit-code retrieval. Output is stripped of ANSI escapes and CRLF→LF. One `LocalRuntime` holds multiple named `BashSession`s (`self._sessions: dict[str, Session]`), so several independent shells can coexist.

Stateless `execute()` (`local.py:419-453`) is a direct `subprocess.run(command.command, shell=command.shell, timeout=..., env=..., cwd=..., stdout=PIPE, stderr=PIPE|STDOUT)` — no pexpect, no PS1 dance, `command.command` as `list[str]` when `shell=False`.

### 3.4 Remote auth and transport (`runtime/remote.py:1-90`)
`RemoteRuntime` is an `aiohttp` HTTP client hitting a FastAPI server (`src/swerex/server.py`) started inside the target container. Auth is a static bearer-style header: `X-API-Key: {config.auth_token}` (`remote.py:71-75`), a random token generated and injected into the container's environment at deploy time. Exceptions raised server-side are serialized into `_ExceptionTransfer{message, class_path, traceback, extra_info}` and **re-raised client-side** with the original exception class where possible (`:82-90`), preserving typed error handling (`CommandTimeoutError`, `NonZeroExitCodeError`, etc.) across the network boundary.

### 3.5 Dependency footprint (`pyproject.toml:33-42`)
Core deps: `fastapi, uvicorn, requests, pydantic>=2, pexpect, bashlex, python-multipart, rich`. Notably heavy for a "sandboxed exec" library — a full ASGI server + client stack, because every deployment mode (Docker/Modal/Fargate/remote) talks the same HTTP protocol to a `swerex.server` instance inside the target, not just the "remote" case.

## 4. Portable ideas

### ACI (tool design / bounding / error wording)
- **Bound "show me stuff" tools at a fixed threshold with an explicit refusal telling the model how to narrow the query**, not silent truncation: `search_dir`/`search_file` (`tools/search/bin/search_dir:29-31`, `search_file:42-44`) — ">100 matches → refuse, 'Please narrow your search'" — cheap pattern for an MCP grep tool.
- **Windowed viewers with "(N more lines above/below)" framing** (`windowed_file.py:165-174`) so the model always knows it's seeing a slice, not the whole file.
- **Reject-and-explain instead of partial-apply** for a mutating tool: `edit` re-lints, reverts on new errors, and shows both the would-be-applied and original window plus "DO NOT re-run the same failed edit command" (`windowed_edit_linting/bin/edit:27-43`) — applicable to any MCP "apply patch"/"write file" tool with a validation step.
- **Explicit empty-output message** prevents the model from being confused by a blank turn (`docs/background/aci.md:14`).
- **Head+tail truncation with elided-char count and actionable advice** (mini-swe-agent `config/default.yaml:119-141`, 10,000-char threshold, 5,000/5,000 head/tail) — good template for an MCP `run_command` response budget.
- **Per-observation vs. whole-history truncation as separate knobs**: SWE-agent truncates one observation at 100k chars (`agents.py:80-83`) *and* separately compacts *old* observations via history processors — worth keeping as two independent budgets.
- **Blocklist with prefix/exact/conditional-regex tiers** (`sweagent/tools/tools.py:29-70`) — reusable shape for gating dangerous/interactive commands.
- **Taxonomized error → action mapping** (`agents.py:1075-1219`): format/blocklist/syntax errors → requery with a retry budget (`max_requeries=3`); limit/timeout/environment errors → exit but salvage state first; fatal errors → propagate. A clean three-tier taxonomy for any agent loop.
- **State surviving separate tool-process invocations goes in a small file-backed registry, not env vars** (`tools/registry/lib/registry.py:8-14`) — relevant if a Node server's tool "processes" are separate `execFile` calls.

### Runtime abstraction
- **Split "provisioning/lifecycle" from "command execution"** (`AbstractDeployment` vs `AbstractRuntime`) — maps onto "get a sandbox" vs "run commands in it" for a Node `ExecutionBackend`.
- **Two execution modes, not one**: stateless `execute(Command)` (argv-capable, `shell=False` default) vs. a persistent-session path for shell state — a backend needing only `argv + shell:false` can implement just `execute` and skip session/pexpect complexity.
- **`Command.shell: bool` with array-or-string `command`** (`abstract.py:146-156`) is essentially the exact shape requested for the Node backend.
- **Kill the whole process group on timeout**, not just the direct child (`environments/local.py:88-91`, `os.killpg(pid, SIGKILL)`) — matches Node's `detached:true` + `process.kill(-pid,'SIGKILL')`.
- **Typed exception transfer across an HTTP boundary** (`_ExceptionTransfer`, `remote.py:82-90`) — useful if the server ever proxies to a remote executor.
- **Simple bearer-style header auth** (`X-API-Key`) — minimal viable auth if a remote backend is added later.

## 5. Not applicable / too heavy
- **pexpect/PS1-REPL session machinery** (`BashSession`, `bashlex` splitting, exit-code round-trip) — supports persistent interactive shells with heredocs; a server running fixed argv arrays with `shell:false` has no PS1 and needs none of it.
- **`bashlex` dependency and syntax-precheck subprocess** — only relevant to untrusted freeform shell text; moot once you never invoke a shell.
- **FastAPI/uvicorn/aiohttp server+client stack** — heavy for a local-first server; only worth it if remote sandboxing is added.
- **Deployment backends for Docker/Modal/Fargate/Daytona** — out of scope; only the `AbstractDeployment`/`AbstractRuntime` shapes are worth porting.
- **flake8-gated edit tool** — Python-specific; the pattern (validate, revert + explain) is portable, the implementation is not.
- **tree-sitter `filemap` eliding tool** — Python-only; a "nice to have," not core ACI.
- **Provider-specific history processors** (Anthropic `cache_control`, multimodal image segments) — tied to specific wire formats.
- **mini-swe-agent's single-bash-tool minimalism** — instructive but assumes a full shell (`bash -lc`) as the only action, conflicting with argv-array/`shell:false`.

## 6. Proposed minimal `ExecutionBackend` interface (Node, derived from SWE-ReX's `AbstractRuntime.execute` + `Command`/`CommandResponse`)

```ts
interface ExecutionBackend {
  // Lifecycle — from AbstractDeployment
  start(): Promise<void>;
  stop(): Promise<void>;
  isAlive(opts?: { timeoutMs?: number }): Promise<{ alive: boolean; message?: string }>;

  // Stateless one-off execution — from AbstractRuntime.execute + Command/CommandResponse
  execute(cmd: {
    argv: string[];               // Command.command as list[str]; shell always false
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    mergeOutputStreams?: boolean;
  }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }>;

  // File I/O — from AbstractRuntime.read_file/write_file/upload
  readFile(path: string, opts?: { encoding?: BufferEncoding }): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  upload(sourcePath: string, targetPath: string): Promise<void>;

  close(): Promise<void>;         // AbstractRuntime.close
}
```
Deliberately **omitted** relative to SWE-ReX: `create_session`/`run_in_session`/`close_session`/`BashInterruptAction`/`expect` strings — no persistent shell/PS1 REPL is needed for argv-array, `shell:false` execution; `check: "silent"|"raise"|"ignore"` collapses to always returning `exitCode` and letting the caller decide. If a persistent-session need emerges later, add it as an opt-in extension (`createSession`/`runInSession`/`closeSession`), mirroring SWE-ReX's own separation rather than folding it into `execute`.

## 7. Attribution needs
All three projects are MIT-licensed (notice retention only, no share-alike). If code or verbatim text is copied (e.g. `_LINT_ERROR_TEMPLATE`, the "too many matches" wording, the `WindowedFile`/`AbstractRuntime` shapes), include an MIT notice crediting: SWE-agent (© 2024 John Yang, Carlos E. Jimenez, Alexander Wettig, Shunyu Yao, Karthik Narasimhan, Ofir Press), mini-swe-agent (© 2025 Kilian A. Lieret, Carlos E. Jimenez), SWE-ReX (© 2024 Kilian Lieret, Carlos E. Jimenez). For the ACI audit, since only *patterns and wording conventions* likely carry over (not literal source), a footnote ("bounding thresholds and error-message conventions adapted from SWE-agent's ACI, MIT-licensed") suffices. For the `ExecutionBackend` interface, since the method list structurally ports `AbstractRuntime`/`Command`/`CommandResponse`, cite SWE-ReX in the interface's doc comment even though the TypeScript is original.
