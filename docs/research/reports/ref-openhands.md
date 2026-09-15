# OpenHands reference research: trajectory checks, verification, runtime boundary, condensation

## Important scope note

The shallow clone at `.../ref/OpenHands_OpenHands` (origin `github.com/OpenHands/OpenHands`) is **not** the
classic Python monorepo. As of this checkout (`82203bb`, package `@openhands/agent-canvas`) that repo *is*
"Agent Canvas" — a TypeScript/React/Electron control-center UI (`src/`, `electron/`, `react-router.config.ts`)
that talks to a versioned REST/WebSocket API via npm package `@openhands/typescript-client`. It has no
`openhands/` Python package at all (10 `.py` files, all CI/tooling scripts). Its `README.md:145-148` and
`AGENTS.md:31,49-54` document the real split: `OpenHands/OpenHands` = Agent Canvas frontend only;
`OpenHands/software-agent-sdk` = the **actual Python SDK + Agent Server** (agents, tools, conversations,
events, condensers, critics, security, REST API — packages `openhands-sdk`, `openhands-tools`,
`openhands-agent-server`, `openhands-workspace`); `OpenHands/typescript-client` = generated client;
`OpenHands/automation` = scheduling/webhooks. There is no `openhands/controller/stuck.py`-style layout left in
either repo — that architecture was fully replaced. I attached `OpenHands/software-agent-sdk` (shallow clone at
`/home/user/openhands/software-agent-sdk`, commit `b054a2f`) and did the real research there; paths below are
relative to that checkout unless marked `[Agent Canvas]`.

**License**: MIT, both repos (`software-agent-sdk/LICENSE:1-3`: "Copyright (c) 2026 OpenHands contributors").

## Stuck detection

Current equivalent of `stuck.py`: `openhands-sdk/openhands/sdk/conversation/stuck_detector.py` (`StuckDetector`
class, `openhands-sdk/openhands/sdk/conversation/state.py:59` adds a `STUCK` execution status). Window and
config live in `openhands-sdk/openhands/sdk/conversation/types.py` (`StuckDetectionThresholds`).

**Scan window**: `MAX_EVENTS_TO_SCAN_FOR_STUCK_DETECTION = 20` (stuck_detector.py:21), scanning only events
**since the last user message** (`_events_since_last_user_message`, stuck_detector.py:66-84) — a `MessageEvent`
with `source == "user"` resets the window entirely, so stuck detection never fires across a user turn.

**Thresholds** (`types.py`, `StuckDetectionThresholds`, all Pydantic `Field` defaults):
- `action_observation = 4` — identical action+observation pair repeated 4x
- `action_error = 3` — same action erroring repeatedly; loop fires at **streak > 3** (i.e. 4th repeat), but the
  nudge fires exactly at streak == 3 (see below)
- `monologue = 3` — 3 consecutive agent `MessageEvent`s with no user interruption
- `alternating_pattern = 6` — A,B,A,B,A,B alternating action/observation cycle

**Five patterns checked in `is_stuck()`** (stuck_detector.py:104-154), each gated by `len(events) >= threshold`
first (min of the three main thresholds, line 109-115):

1. **Repeating action-observation** (`_is_stuck_repeating_action_observation`, :156-190): collects the last
   `max_needed` `ActionEvent`s and `ObservationBaseEvent`s (most-recent-first) via
   `_collect_actions_and_observations` (:86-102), checks `all()` of the top `threshold` actions equal via
   `_event_eq` AND all `threshold` observations equal. Both must hold → stuck.
2. **Repeating action-error** (`_is_stuck_repeating_action_error` / `_action_error_streak`, :192-216): walks
   `zip(last_actions, last_observations)` from the most recent pair, counting a streak while the action matches
   `last_actions[0]` (via `_event_eq`) **and** the observation is an `AgentErrorEvent`; breaks on first mismatch.
   Stuck fires when `streak > action_error_threshold` (streak of 4 at default threshold=3).
   `get_action_error_nudge()` (:218-248) fires a soft warning message **once**, exactly at streak ==
   threshold (3), before the hard stuck fires at streak 4 — de-dupes via `_last_nudged_error_event_id` so a
   frozen streak (empty/reasoning-only responses) doesn't re-nudge every iteration. Nudge: `"You've called
   '{tool_name}' with the same arguments {threshold} times in a row and gotten the same error each time:
   {error}. Repeating the exact same call again will not work..."` (:242-248).
3. **Monologue** (`_is_stuck_monologue`, :250-275): walks events in reverse; counts consecutive agent
   `MessageEvent`s, treats `CondensationSummaryEvent` as transparent, any other event type breaks the scan.
   Fires when count `>= monologue threshold (3)`.
4. **Alternating action-observation** (`_is_stuck_alternating_action_observation`, :277-312): checked only
   when `len(events) >= alternating_pattern_threshold (6)`. Collects last 6 actions/observations, checks
   `actions[i] == actions[i+2]` for all even/odd-offset pairs (period-2 cycle detection) via `_event_eq`.
5. **Context-window-error loop** (`_is_stuck_context_window_error`, :314-323): **stubbed — always returns
   `False`**, gated by `len(events) >= 10`. Comment: "TODO: blocked by `OpenHands/agent-sdk#282`" — not
   implemented despite being in the docstring's pattern list, worth flagging since the brief asked specifically
   about context-window errors.

**Equality rule** (`_event_eq`, :325-370): type must match exactly, then structural equality ignoring
IDs/metrics: `ActionEvent` compares `source, thought, action, tool_name` (ignores `tool_call_id`,
`llm_response_id`, `action_id`); `ObservationEvent` compares `source, observation, tool_name`;
`AgentErrorEvent` compares `source, error`; `MessageEvent` compares `source, llm_message`. Falls back to `==`
otherwise.

**On stuck**: `LocalConversation._check_stuck_or_nudge()` (`impl/local_conversation.py:736-757`) sets
`execution_status = STUCK` and returns `True`. The run loop's `while True:` (`run()`, :1920-) checks
`execution_status in [PAUSED, STUCK]: break` at the top of each iteration (:1949-1955), exiting on the next
pass — notably **no `ConversationErrorEvent` is emitted for STUCK** (unlike budget/iteration exhaustion, which
call `_emit_run_limit_error` with a `ConversationErrorEvent`, :728-734, :2029-2034). `STUCK` is a terminal
status (`state.py:66-78`, `is_terminal()`).

**max_iterations**: default `500` (`state.py:108-113`, `Field(default=500, gt=0)`), enforced at
`impl/local_conversation.py:2038` (`if iteration >= self.max_iteration_per_run`), message `"Agent reached
maximum iterations limit ({N})."` unless the agent already finished on that iteration (preserves FINISHED over
ERROR).

**max_budget_per_task / max_budget_per_run**: no numeric default — `max_budget_per_run: float | None = None`
(:237, :487), opt-in and unbounded by default. `_budget_exceeded_detail()` (:712-726) compares
`conversation_stats.get_combined_metrics().accumulated_cost` (spans agent + condenser + critic LLM cost) against
the cap. Also surfaced at `llm/utils/metrics.py:86` (`MetricsSnapshot.max_budget_per_task: float | None =
None`).

## Condenser

Interface: `openhands-sdk/openhands/sdk/context/condenser/base.py`. `CondenserBase.condense(view: View,
agent_llm: LLM | None) -> View | Condensation` is the sole abstract method (base.py:32-51); an optional
`acondense` async variant defaults to the sync one. `handles_condensation_requests()` (default `False`) gates
whether a `CondensationRequest` event triggers this condenser.

`RollingCondenser(PipelinableCondenserBase, ABC)` (base.py:108-) is the template-method subclass most
implementations use: abstract `condensation_requirement(view, agent_llm) -> CondensationRequirement | None`
(`HARD`/`SOFT` enum, base.py:97-105) and abstract `get_condensation(view, agent_llm) -> Condensation`. Its
concrete `condense()` (base.py:158-185): if requirement is `None`, return view unchanged; else call
`get_condensation`, and on `NoCondensationAvailableException` either return the view uncondensed (SOFT) or
attempt `hard_context_reset()` (HARD, no-op by default unless overridden).

**Implementations**: `no_op_condenser.py` (returns the view unchanged, `NoOpCondenser`); `llm_summarizing_condenser.py`
(`LLMSummarizingCondenser`, 517 lines, the primary/production strategy); `pipeline_condenser.py`
(`PipelineCondenser`, chains multiple `PipelinableCondenserBase`s).

**`LLMSummarizingCondenser` triggers** (`get_condensation_reasons`, llm_summarizing_condenser.py:120-153, three
`Reason` enum values):
1. `Reason.REQUEST` — an unhandled `CondensationRequest` event in the view (`view.unhandled_condensation_request`)
2. `Reason.TOKENS` — `total_tokens > effective_max_tokens` where `effective_max_tokens` is
   `min(condenser.max_tokens, agent_llm.effective_max_input_tokens)` (:106-118) — **HARD** requirement
   (comment: local fixed-context benchmark runs can fail mid-request before recovery runs, :167-171)
3. `Reason.EVENTS` — `len(view) > max_size` (default **`max_size = 240`**, `Field(default=240, gt=0)`,
   line 47) — **SOFT** requirement (just a bookkeeping heuristic, retried next step, :178-181)

`Reason.REQUEST` is always HARD (:181-186).

**What is kept**: `keep_first: int = Field(default=2, ge=0)` (line 50) — first N events are *never* condensed.
Validated against `max_size` (`validate_keep_first_vs_max_size`, :72-79). Target size on condensation is
**half** the trigger threshold (`_get_forgotten_events`, :247-303): for `Reason.EVENTS`, `target_size =
max_size // 2` (=120 by default); for `Reason.REQUEST`, `target_size = len(view) // 2`; for `Reason.TOKENS`,
computed via `get_suffix_length_for_token_reduction` to reach `max_tokens // 2`. When several reasons fire
together, the **strictest** wins (`min(suffix_events_to_keep)`, :298). Forgetting range respects "atomic unit"
boundaries via `view.manipulation_indices.find_next(...)` (never splits a tool-call/result pair, :304-310),
enforced by `context/view/properties/` (`tool_call_matching.py`, `batch_atomicity.py`,
`tool_loop_atomicity.py`, `observation_uniqueness.py`).

**Summary generation** (`_generate_condensation`, :188-241): forgotten events are stringified
(`maybe_truncate`), rendered into a Jinja2 prompt (`prompts/summarizing_prompt.j2`) and sent as a single user
message to `self.llm` (condenser's **own**, possibly different, LLM) via `llm.generate(..., store=False)`.
Produces a `Condensation(forgotten_event_ids=..., summary=..., summary_offset=..., llm_response_id=...)` — an
append-only "tombstone" event (condenser/README.md), never mutates history in place. `minimum_progress: float =
0.1` (line 55) guards against near-no-op condensations. `hard_context_reset_max_retries = 5`,
`hard_context_reset_context_scaling = 0.8` (shrinks per-event truncation length each retry, lines 63-69).

**Design rationale** (`condenser/README.md`): condense at regular intervals rather than only on overflow, to
bound per-completion cost, keep prompt-cache rebuild cost low, preserve early context via recursive
summarization, and leave recent context untouched for continuity.

## Verification / Critic

`grep -rn "critic\|verifier\|judge" openhands-sdk` surfaces a first-class **critic subsystem**
(`openhands-sdk/openhands/sdk/critic/`) plus a separate **LLM-judge goal loop**
(`conversation/goal/`). No `evaluation/` harness (`run_infer.py`/`eval_infer.py`) ships in this repo —
SWE-bench-style eval runs via `.agents/skills/manage-evals/scripts/manage_evals.py` (CI-only tooling calling a
separate eval pipeline; not part of the SDK proper).

**Critic interface** (`critic/base.py`): `CriticBase.evaluate(events: Sequence[LLMConvertibleEvent], git_patch:
str | None = None) -> CriticResult` (abstract, :83-85). So the critic receives **both the trajectory (events)
and the diff (git_patch)** — not diff-only, not LLM-only. `CriticResult` (`critic/result.py:9-27`): `score:
float` (0-1, "predicted probability of success"), `message: str | None`, `metadata: dict | None` (can carry
`categorized_features` for UI display), plus `success` property (`score >= THRESHOLD` where `THRESHOLD = 0.5`,
class var).

`mode: Literal["finish_and_message", "all_actions"]` (base.py:63-70, default `"finish_and_message"`) controls
*when* the critic runs: only on `FinishAction`/agent `MessageEvent` by default, or after every action (flagged
"significantly slower"). Wired via `CriticMixin` (`agent/critic_mixin.py`): `_should_evaluate_with_critic`
(:34-44) gates on mode+action type; `_evaluate_with_critic` (:47-71) builds `events = list(conversation
.state.events) + [event]`, filters to `LLMConvertibleEvent`, calls `critic.evaluate(events=..., git_patch=
None)` — **note**: git_patch is hardcoded `None` at this call site today, so the live wiring only feeds the
trajectory, not the diff, despite the interface supporting both.

**Four concrete implementations** (`critic/impl/`):
- `PassCritic` (`pass_critic.py`) — always `score=1.0` (no-op/disabled critic)
- `EmptyPatchCritic` (`empty_patch.py`) — **fully deterministic**: `score=1.0` iff `git_patch` non-empty/non-whitespace, else `0.0`; ignores events entirely
- `AgentFinishedCritic` (`agent_finished.py`) — **fully deterministic**: `score=1.0` iff (a) `git_patch` non-empty AND (b) the last `ActionEvent` in history `isinstance(action, FinishAction)` (scans `reversed(events)`, :74-84); else `0.0` with a message naming which check failed
- `APIBasedCritic` (`critic/impl/api/critic.py` + `client.py`, `chat_template.py`, `taxonomy.py`, 956 lines total) — calls a remote **learned** classifier (not the agent's own LLM) returning categorized failure-mode features — the "model-based" critic

**Iterative refinement** (`IterativeRefinementConfig`, base.py:20-51 + `critic_mixin.py:74-134`): optional
`success_threshold: float = 0.6`, `max_iterations: int = 3` attached to any critic. On a `FinishAction` whose
critic score is below threshold, `Conversation.run()` auto-injects a follow-up prompt (`get_followup_prompt`,
base.py:91-104) and continues, tracked via `state.agent_state["iterative_refinement_iteration"]`, capped at
`max_iterations`.

**Separately**, `conversation/goal/controller.py` (`GoalController`) implements a **pure LLM-judge loop**
("the `/goal` loop"): `on_run_finished(events) -> GoalContinue | GoalDone` calls `judge_goal(judge_llm,
objective, events)` each round, returns a `GoalVerdict(score, complete, missing)`; continues up to
`max_iterations: int = 10` (default, `controller.py:88`, also `goal/runner.py:35`), sending a follow-up naming
`verdict.missing` each round. Architecturally distinct from `CriticBase`: judges an *objective* against the
trajectory ("is this done"), not agent quality, and does no diff inspection — purely `events: Sequence[Event]`
in, verdict out. Deliberately **I/O-free** ("the controller only judges and decides") so sync and async drivers
share logic — worth copying regardless of LLM usage.

## Runtime / sandbox boundary

Abstract interface: `openhands-sdk/openhands/sdk/workspace/base.py`, `BaseWorkspace(DiscriminatedUnionMixin,
ABC)`. Abstract methods (base.py:170-260): `execute_command(command: str, cwd: str | Path | None = None,
timeout: float = 30.0) -> CommandResult`; `file_upload(source_path, destination_path) -> FileOperationResult`;
`file_download(source_path, destination_path) -> FileOperationResult`; `git_changes(path) -> list[GitChange]`;
`git_diff(path) -> GitDiff`. Non-abstract, overridable `pause()`/`resume()` (default `raise
NotImplementedError`, :261-280) for container-backed workspaces. Context-manager protocol; `__exit__` POSTs a
completion callback to `AUTOMATION_CALLBACK_URL` if set (:97-152) — status `COMPLETED`/`FAILED`,
`conversation_id`, accumulated LLM `cost`, structured `ConversationErrorEvent` on failure.

**Implementations**: `workspace/local.py` (`LocalWorkspace` — host filesystem, subprocess execution);
`workspace/remote/` (`RemoteWorkspace` base + async variant — HTTP client to a remote Agent Server);
`openhands-workspace/openhands/workspace/{docker,apptainer,cloud,remote_api,agent_sandbox}/workspace.py` —
five concrete backends. **Docker is the default** (`docker/workspace.py`, spawns
`ghcr.io/openhands/agent-server`, picks a free port 30000-39999 via `find_available_tcp_port`).

**Action-execution-server contract** (now a full FastAPI app, not a standalone script):
`openhands-agent-server/openhands/agent_server/*_router.py` — 24 routers (`bash_router.py`, `file_router.py`,
`git_router.py`, `conversation_router.py`, `event_router.py`, `workspace_router.py`, `skills_router.py`,
`tool_router.py`, `mcp_router.py`, `runtime_router.py`, etc.). Bash contract concretely (`bash_router.py:35-
126`): `GET /bash/bash_events/search`, `GET /bash/bash_events/{id}`, `GET /bash/bash_events/`, `POST
/bash/start_bash_command`, `POST /bash/execute_bash_command`, `DELETE /bash/bash_events`. Served on **port
8000** by default (Dockerfile `ARG PORT=8000`).

**Action/Observation classes** (renamed `CmdRunAction`→`TerminalAction`, `CmdOutputObservation`→
`TerminalObservation`, `openhands-tools/openhands/tools/terminal/definition.py`):
- `TerminalAction(Action)` (:89-131): `command: str`, `is_input: bool = False`, `timeout: float | None = None`
  (per-command override, `ge=0`), `reset: bool = False`. No separate `hard_timeout`/`blocking` fields — instead
  a **no-output-change soft timeout**: `NO_CHANGE_TIMEOUT_SECONDS = 30` (`constants.py:31`) triggers a
  "continue or stop?" prompt after 30s with no new output and no explicit `timeout` set.
- `TerminalObservation(Observation)` (:143-166): `command: str | None`, `exit_code: int | None` (`-1` = still
  running/hit soft timeout), `timeout: bool`, `metadata: CmdOutputMetadata`, `full_output_save_dir: str | None`.
- `CmdOutputMetadata` (`terminal/metadata.py:20-42`): `exit_code`, `pid`, `username`, `hostname`,
  `working_dir`, `py_interpreter_path`, `prefix`/`suffix` — captured from a PS1 JSON marker
  (`constants.py:5-13`) rather than parsed from raw stdout, avoiding interleaving bugs.

**Truncation** (`utils/truncate.py`, `maybe_truncate`, :50-): head/tail truncation — proportional head+tail
around a fixed `DEFAULT_TRUNCATE_NOTICE` ("`<response clipped>...`", 113 chars) in the middle, head rounded up
on the split. Optionally persists the *full* content to a content-hash-deduped file and switches to
`DEFAULT_TRUNCATE_NOTICE_WITH_PERSIST` naming the saved path + approximate truncated line number, so the agent
can retrieve the full output via another call. Terminal output caps at `MAX_CMD_OUTPUT_SIZE = 30_000` chars
(`terminal/constants.py:18`, comment: "matches the default max_message_chars in the LLM class"); the LLM class
itself defines `max_message_chars: int = Field(default=30_000, ...)` ("Approx max chars in each event/content
sent to the LLM", `llm/llm.py:361-365`).

## Event stream / trajectory

Trajectory is an append-only, file-backed event log: `conversation/event_store.py` (`EventLog(EventsListBase)`)
persists one file per event under `EVENTS_DIR`, with a `.eventlog.lock` (30s timeout) and a
`.eventlog-len-{N}.marker` sidecar so length is checkable without listing the directory. Event classes live
under `openhands-sdk/openhands/sdk/event/` (`base.py`, `condenser.py` for `Condensation`,
`conversation_error.py`, `user_action.py`, `acp_tool_call.py`, `hook_execution.py`, `token.py`,
`resume_transcript.py`, `streaming_delta.py`). "Replay" here means WebSocket session replay to a reconnecting
UI client (`agent_server/session_socket.py`, `REPLAY_PAGE_SIZE = 100`, paginated `_replay()` at :294) — **not**
a from-scratch trajectory re-execution feature; there is no separate trajectory-file export distinct from the
event log itself.

**Security analyzer**: `security/analyzer.py`, `SecurityAnalyzerBase(DiscriminatedUnionMixin, ABC)`. Abstract
`security_risk(action: ActionEvent) -> SecurityRisk` (:27-38); `SecurityRisk` enum (`risk.py:13-23`): `UNKNOWN,
LOW, MEDIUM, HIGH`, explicit `_RISK_ORDER` (UNKNOWN excluded from ordering). Implementations: `llm_analyzer.py`
/ `toolshield_llm_analyzer.py` (model-based), `grayswan/analyzer.py` (third-party model), and a **rule-based
"defense in depth" layer** (`security/defense_in_depth/{pattern.py,shell_semantics.py,policy_rails.py}` +
`shell_parser.py`/`_shell_ast.py`) — deterministic shell-AST pattern matching alongside the LLM analyzers,
feeding `ConfirmationPolicyBase` to decide whether an action needs human confirmation.

## Microagents

Renamed to **"skills"**; legacy directories still read for backward compatibility.
`openhands-sdk/openhands/sdk/skills/skill.py` + `trigger.py`. Three trigger types (`trigger.py:19-46`):
`KeywordTrigger(keywords: list[str])`, `TaskTrigger(triggers: list[str])`, `PathTrigger(paths: list[str])`
(glob-matched, gitignore `**` semantics, fires when the agent touches a matching file path — new vs. the old
microagent model). A `Skill` with **no** trigger is always-active (full content injected permanently into
`<REPO_CONTEXT>`); a skill **with** triggers is listed in `<available_skills>` (name/description/location
only) and injected only on match (skill.py:186-190, 228-229). Parsed via `python-frontmatter`
(skill.py:13,362-412); `triggers` frontmatter populates `KeywordTrigger`/`TaskTrigger` (:546-622), `paths`
populates `PathTrigger` and overrides any `triggers` present (with a warning, :560-564). Directory convention
(skill.py:917-1107, `agent_context.py:97`): `~/.openhands/skills/` (current) and `~/.openhands/microagents/`
(legacy, merged in, first-match-wins) at user level; `{repo}/.openhands/skills/` and
`{repo}/.openhands/microagents/` (deprecated) at repo level. Server-side loading:
`agent_server/skills_service.py:8,100,189-208` — merges both, `microagents/` explicitly logged "(legacy
support)".

## Footprint

- **Language**: Python 3.13 (`.python-version`, `pyproject.toml:126`) for the SDK/agent-server; Node.js 22 + TypeScript/React for Agent Canvas `[Agent Canvas]` (Docker base bundles Node 22).
- **Docker default**: `agent_server/docker/Dockerfile:6`, base image `nikolaik/python-nodejs:python3.13-nodejs22-slim`, non-root user (UID/GID 10001), port `8000`. Capability bundles baked in via build args: `INSTALL_ACP_PROVIDERS=claude-code,codex,gemini-cli` (line 19), `INSTALL_CAPABILITIES=vscode,browser,docker` (line 25) — the default image ships VS Code server, a browser tool, Docker-in-Docker, plus three third-party coding-agent CLIs.
- **LLM everywhere**: the same `LLM` class threads through the agent, condenser (own configurable instance), critic (`APIBasedCritic` calls an external model; others are LLM-free), security analyzer (`llm_analyzer.py`), and goal judge — no code path avoids an LLM client type even where the logic (`AgentFinishedCritic`, `EmptyPatchCritic`, `defense_in_depth` rules) is fully deterministic; those just don't call `.generate()`.

---

## (a) Portable ideas

**Trajectory / stuck detection**
- Bounded backward scan reset on user turn (`stuck_detector.py:66-84`) — portable to a ledger scan of "last N calls since last user message."
- Structural equality ignoring call IDs/timestamps but keeping semantic fields (`_event_eq`, :325-370) — the "args hash" idea; a per-event-type equality function is a clean pattern to copy.
- Streak-based nudge-before-hard-stop (`get_action_error_nudge`, :218-248, dedup via last-nudged-id) — soft warning at N-1 repeats, hard stop at N; worth adopting verbatim.
- Period-2 alternation detector via index-stride-2 equality (`_is_stuck_alternating_action_observation`, :277-312) — generalizes to period-K loop detection over an args-hash sequence.
- Explicit `STUCK` terminal status distinct from `ERROR`/budget/iteration exhaustion (`state.py:53-78`) — useful telemetry distinction.

**Verification / critic**
- `CriticBase.evaluate(events, git_patch)` (`critic/base.py:83-85`) — trajectory *and* diff, implementation's choice of which to use; matches "deterministic checks first, LLM critic optional" as an interface shape.
- Deterministic critics as first tier, LLM/remote critic as opt-in escalation (`EmptyPatchCritic`, `AgentFinishedCritic` vs `APIBasedCritic`) — this *is* the requested "Verification vNext" pattern, already running in production.
- `mode: "finish_and_message" | "all_actions"` (base.py:63-70) — cheap default, expensive opt-in; good cost/latency knob.
- `IterativeRefinementConfig` auto-retry loop (`critic_mixin.py:74-134`) — bounded self-correction driven by critic score, templated follow-up naming the gap.
- `GoalController` I/O-free design ("the controller only judges and decides") — separating judge-and-decide from the send/run driver is reusable for splitting "policy" from "transport."

**Runtime / sandbox boundary**
- Small abstract `BaseWorkspace` surface — `execute_command`, `file_upload`, `file_download`, `git_changes`, `git_diff`, optional `pause`/`resume` (`workspace/base.py:170-280`) — a good minimum-viable `ExecutionBackend` shape; git-diff/git-changes are first-class, matching "verifies repository state."
- PS1-JSON-marker metadata capture instead of parsing raw stdout (`constants.py:5-13`) — robust exit-code/cwd/pid extraction without interleaving bugs.
- No-output-change soft timeout distinct from a hard timeout (`NO_CHANGE_TIMEOUT_SECONDS=30`) — two-tier timeout worth copying for long-running builds.
- Head+tail truncation with full content persisted to a hash-deduped file plus a pointer back (`maybe_truncate`, `truncate.py:50-104`) — never fully discards output while bounding LLM-facing text.

**Condensation**
- Condense-at-interval, not only on overflow (README.md) — generalizes to "bound working-set size regularly."
- `keep_first` + untouched tail + recursively summarized middle — a three-zone memory model, not just a sliding window.
- SOFT vs HARD condensation requirement (`CondensationRequirement` enum, base.py:97-105) with a documented recovery path when HARD fails (`hard_context_reset`) — clean "nice to have" vs "must happen" separation.
- Atomic-unit-respecting boundaries via `manipulation_indices` (never splits a paired call/result) — applicable to a Node ledger of paired entries.

## (b) Not applicable / too heavy

- Full multi-router FastAPI Agent Server (24 routers, WebSocket replay, VSCode/browser/Docker bundles) — only the `ExecutionBackend`-shaped subset (bash/file/git) is relevant here.
- `APIBasedCritic` / `grayswan` / `toolshield_llm_analyzer` — external hosted classifiers with their own taxonomy/auth; out of scope unless a hosted service is deliberately added later.
- The full skills/microagent trigger system (keyword/task/path triggers, frontmatter, legacy-directory merging, marketplace) — a separately-scoped prompt-injection/context feature.
- `GoalController`'s LLM-judge loop and `conversation/goal/` — this *is* the "LLM critic" half already; useful as reference, but the task wants LLM-critic optional/secondary, not ported wholesale.
- Docker-default sandbox with `pause`/`resume`, Apptainer/cloud/remote_api backends — assumes container orchestration; a local-first `ExecutionBackend` should stay host-process shaped first, container/remote as later pluggable backends.
- Observability stack (Laminar/OTel) — nice-to-have, not core.

## (c) Deterministic trajectory-check spec (from a local usage ledger)

Ledger record assumed: `{seq, tool_name, args_hash, duration_ms, status, files_touched?, timestamp}` per call.
Thresholds reuse OpenHands' numbers where a direct equivalent exists, and are flagged as unanchored proposals
otherwise.

1. **Loop detection (identical call+result repeat)** — mirror `_is_stuck_repeating_action_observation`
   (stuck_detector.py:156-190): flag when the last **4** entries have identical `(tool_name, args_hash)` **and**
   identical `(status, result_hash)`. Reuse `action_observation = 4` unmodified — production-tuned, no reason to
   diverge without local evidence. Window: last 20 calls since the last user/approval turn (mirrors
   `MAX_EVENTS_TO_SCAN_FOR_STUCK_DETECTION = 20` and the reset in `_events_since_last_user_message`).

2. **Repeated failing command** — mirror `_action_error_streak` (:192-216): same `(tool_name, args_hash)` with
   `status == "error"` for **4** consecutive calls → hard stop; **3** consecutive → soft nudge (once, de-duped
   by error content hash). This asymmetric nudge-then-stop is the single most directly reusable piece of the
   whole detector.

3. **Same file rewritten >N** — no OpenHands equivalent (their analogous churn case is stubbed,
   stuck_detector.py:314-323, no numeric precedent). Proposal: flag when the same `files_touched` path appears
   in **>5** distinct *non-identical* write/edit calls within the 20-call window (distinct args_hash, so this
   catches thrashing, not the identical-repeat case already caught by check 1). 5 ≈
   `action_observation_threshold + 1` — stricter than plain repetition but tolerant of 2-3-round lint-fix
   cycles.

4. **Scope explosion vs baseline** — no OpenHands equivalent (no file-count baselining exists there).
   Proposal: capture `git diff --stat` file/line counts at task start and after every N calls; flag if
   changed-file count exceeds `max(5, 3x baseline-estimate)` or touches directories outside the task's initial
   repo-read. Placeholder pending local calibration.

5. **Verification avoidance** — no OpenHands mid-trajectory equivalent, but directly derivable from
   `AgentFinishedCritic`/`EmptyPatchCritic` (`critic/impl/agent_finished.py:33-71`), which gate completion on
   non-empty diff + proper finish action. Extend as a **deterministic finish-time gate**: refuse "done" if the
   diff is non-empty but no test/verification-tool call followed the last write — a stronger, cheaper analog of
   `AgentFinishedCritic`'s two-part check plus a third "evidence of verification" condition.

6. **Churn** — combine check 3 with OpenHands' `minimum_progress` guard (`llm_summarizing_condenser.py:55-58`,
   0.1, "≥10% must be condensed or treat as error"): flag when net-files-touched / gross-write-calls falls
   below **0.3** over 20 calls — touching files repeatedly without net new coverage, the same "real progress"
   intuition OpenHands applies to condensation.

Carried-over notes: (i) scope the window to "since last human turn," not full history; (ii) soft-warn-then-
hard-stop rather than a single cutoff; (iii) compare by structural hash ignoring call IDs/timestamps; (iv) keep
the stuck/finish decision itself LLM-free — OpenHands' hard-stop detector and its two cheapest critics
(`EmptyPatchCritic`, `AgentFinishedCritic`) are 100% deterministic, escalating to a model only as an optional,
separately-gated second tier.

## (d) Attribution needs

Both repos are MIT-licensed (`software-agent-sdk/LICENSE:1-3`, copyright "OpenHands contributors", 2026; same
text in the Agent Canvas repo's `LICENSE`). MIT requires only that copyright notice and license text be
preserved in copies/substantial portions. For a Node.js MCP server adapting *ideas/architecture* rather than
copying code verbatim, no attribution is strictly required — but several thresholds/structures above (the
4/3/3/6 stuck-detection numbers, the `keep_first`/`max_size` condenser split, the
`EmptyPatchCritic`/`AgentFinishedCritic` deterministic-gate pattern, `maybe_truncate`'s head/tail format) are
close to verbatim ports, so it is good practice to credit "OpenHands (`OpenHands/software-agent-sdk`, MIT
License)" in a NOTICE/README/code comment near the ported logic — particularly the stuck-detector's
equality/threshold scheme and the condenser's target-size-on-trigger formula, both specific enough to be
recognizably derived rather than independently arrived at.
