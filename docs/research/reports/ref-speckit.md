# GitHub Spec Kit — Implementation Mechanics of Spec-Driven Development

Repo: `github/spec-kit` (shallow clone). License: **MIT** (`LICENSE:1-3`, "Copyright GitHub, Inc."). All findings below cite `file:line` in the cloned tree.

## 1. Full workflow and on-disk layout

Spec Kit is a prompt-engineering framework, not a program that enforces rules in code. Each lifecycle step is a Markdown "command" template (`templates/commands/*.md`) with YAML frontmatter naming a helper script (`scripts:` block, one line per shell dialect) and a body of natural-language instructions an LLM agent follows. A thin Python CLI (`src/specify_cli/__init__.py`) only *installs* these templates into an agent's command directory (e.g. `.claude/commands/`, `.gemini/commands/…toml`) — it does not execute the workflow itself.

Canonical step order: `speckit.constitution` → `speckit.specify` → `speckit.clarify` (optional) → `speckit.checklist` (optional, repeatable) → `speckit.plan` → `speckit.tasks` → `speckit.analyze` (optional, read-only) → `speckit.implement`. Frontmatter `handoffs:` blocks encode this graph, e.g. `templates/commands/specify.md:3-10` hands off to `speckit.plan` and `speckit.clarify`; `templates/commands/tasks.md:3-11` hands off to `speckit.analyze` and `speckit.implement`.

On-disk layout, produced by `scripts/bash/create-new-feature.sh` and `scripts/bash/common.sh::get_feature_paths` (`scripts/bash/common.sh:163-231`):

```
specs/<NNN-or-timestamp>-<short-slug>/
  spec.md          # speckit.specify
  checklists/requirements.md   # built-in spec-quality checklist (speckit.specify + speckit.clarify)
  checklists/<domain>.md       # custom, speckit.checklist (e.g. ux.md, api.md)
  plan.md          # speckit.plan
  research.md      # Phase 0 output
  data-model.md    # Phase 1 output
  contracts/       # Phase 1 output
  quickstart.md    # Phase 1 output
  tasks.md         # speckit.tasks
.specify/
  memory/constitution.md       # project constitution (single file, versioned)
  feature.json                 # {"feature_directory": "specs/003-..."}  — cross-command state
  templates/ (+ overrides/), presets/, extensions/   # template resolution stack
```

Directory naming: `create-new-feature.sh` derives a numeric prefix (`NNN`, next unused 3-digit number scanning `specs/`, expanding beyond 3 digits) or a `YYYYMMDD-HHMMSS` timestamp prefix depending on `.specify/init-options.json:feature_numbering` (`scripts/bash/create-new-feature.sh:100-135, 275-330`), plus a stop-word-filtered slug (`generate_branch_name`, `scripts/bash/create-new-feature.sh:205-257`). **The spec directory name is decoupled from the git branch name** — branch creation moved out of core into the optional `git` extension's `before_specify` hook (`templates/commands/specify.md:74-78, 108-111`); actual git branch naming convention lives in `AGENTS.md:475-499`: `<type>/<number>-<slug>` or `<type>/<slug>`, `<type> ∈ {feat, fix, docs, community, chore}`.

Templates are resolved through a 4-layer priority stack — project overrides → installed presets (priority-ordered) → extensions → core — implemented deterministically in `resolve_template`/`resolve_template_content` (`scripts/bash/common.sh:496-926`), supporting `replace|prepend|append|wrap` composition strategies declared in preset manifests.

## 2. `[NEEDS CLARIFICATION]` and `/clarify`

The marker itself is just a text convention: `[NEEDS CLARIFICATION: specific question]`, seeded by `speckit.specify` (`templates/spec-template.md:96-99`) with a hard cap of **3** markers at spec-creation time, prioritized "scope > security/privacy > user experience > technical details" (`templates/commands/specify.md:122-129, 299-303`). If markers remain after spec generation, `speckit.specify` itself resolves them inline via a Q1..Q3 multiple-choice table (`templates/commands/specify.md:199-232`) — this is a *separate*, lighter clarification pass from `/clarify`.

`speckit.clarify` (`templates/commands/clarify.md`) is the dedicated ambiguity-reduction command and is expected to run **before** `speckit.plan` (line 60). Mechanics:

- **Ambiguity taxonomy** (lines 73–124): 9 fixed categories scanned against the spec — Functional Scope & Behavior; Domain & Data Model; Interaction & UX Flow; Non-Functional Quality Attributes (perf/scale/reliability/observability/security/compliance); Integration & External Dependencies; Edge Cases & Failure Handling; Constraints & Tradeoffs; Terminology & Consistency; Completion Signals; Misc/Placeholders. Each category is marked Clear/Partial/Missing internally.
- **Max-5-questions rule** (lines 129–138): a prioritized queue capped at 5 for the *whole session*, built by an "Impact × Uncertainty" heuristic, excluding low-impact/plan-level items.
- **Question format** (lines 140–179): exactly one question at a time; must start `**Question:** <interrogative>?` (never a bare label); MC questions get a **`**Recommended:** Option [X] - <reasoning>`** line plus a `| Option | Description |` table (≤5 options, optional "Short" free-text row); short-answer questions get **`**Suggested:** <answer> - <reasoning>`**. User can accept via "yes"/"recommended"/"suggested".
- **Write-back** (lines 182–198): after each accepted answer, ensure a `## Clarifications` → `### Session YYYY-MM-DD` section exists in spec.md, append `- Q: <question> → A: <answer>`, then *immediately* patch the relevant section (Functional Requirements / User Stories / Data Model / Success Criteria / Edge Cases / terminology), replacing rather than duplicating contradicted text; file is saved after **every** answer (atomic overwrite), not batched.
- **Exit criteria** (lines 175–180, 231–237): stop when all critical ambiguities are resolved, user says "done", or 5 questions are reached; if no meaningful ambiguity exists at all, respond "No critical ambiguities detected worth formal clarification." Step 9 (lines 210–227) also re-validates `checklists/requirements.md` after the spec changes, toggling only checkboxes whose pass/fail state actually flipped, and reports newly-passing / regressed / still-unchecked items.

## 3. `/analyze` cross-artifact checks

`templates/commands/analyze.md`, runnable only after `tasks.md` exists (line 54). **STRICTLY READ-ONLY** (line 58) — it may only propose remediation, never edit files; the user must explicitly approve follow-up edits (step 8, line 202).

Six detection passes (lines 119–151): **A. Duplication** (near-duplicate requirements), **B. Ambiguity** (vague adjectives — fast/scalable/secure/intuitive/robust — and unresolved `TODO`/`TKTK`/`???`/`<placeholder>`), **C. Underspecification** (verbs missing an object/outcome; stories without acceptance criteria; tasks referencing undefined files), **D. Constitution Alignment** (any MUST-principle conflict or missing mandated section), **E. Coverage Gaps** (requirements with zero tasks; tasks with no requirement; buildable Success Criteria not reflected in tasks), **F. Inconsistency** (terminology drift, entities in plan but not spec, task-ordering contradictions, conflicting requirements).

Severity heuristic (lines 155–161): **CRITICAL** = constitution MUST violation, missing core artifact, or zero-coverage requirement blocking baseline function; **HIGH** = duplicate/conflicting requirement, ambiguous security/perf attribute, untestable acceptance criterion; **MEDIUM** = terminology drift, missing non-functional task coverage; **LOW** = style/wording. Output is a single Markdown table, one row per finding, capped at 50 with an overflow summary: `| ID | Category | Severity | Location(s) | Summary | Recommendation |` (lines 162–190), plus a Coverage Summary table and metrics block. Constitution conflicts are explicitly non-negotiable within `/analyze`'s scope — "not dilution, reinterpretation, or silent ignoring" (line 60); a principle change must happen via a separate `speckit.constitution` run.

## 4. Constitution gates & Complexity Tracking

`plan-template.md:39-43` has a `## Constitution Check` section: *"GATE: Must pass before Phase 0 research. Re-check after Phase 1 design."* Gates are not code — they're derived at plan time by reading `.specify/memory/constitution.md` and manually evaluating each MUST principle against the feature. `plan-template.md:106-113` has a **Complexity Tracking** table, filled "ONLY if Constitution Check has violations that must be justified": `| Violation | Why Needed | Simpler Alternative Rejected Because |`. This is the closest analogue to a `plan_policy` gate, but it's binary (pass the constitution or justify each violation) rather than a numeric complexity score.

The live example constitution (`.specify/memory/constitution.md`) has 5 principles (Code Quality, Test-Backed Change [NON-NEGOTIABLE], CLI/UX Consistency, Offline-First Performance, Minimal Dependencies), a `Security & Cross-Platform Constraints` section, `Development Workflow & Quality Gates`, and `Governance` with SemVer versioning (MAJOR/MINOR/PATCH) and a mandatory Sync Impact Report HTML comment prepended on every amendment (`templates/commands/constitution.md:112-119`).

## 5. Plan phases

`templates/commands/plan.md:112-159`: **Phase 0 (Outline & Research)** — every `NEEDS CLARIFICATION` in Technical Context becomes a research task; dispatched research agents write Decision/Rationale/Alternatives-considered entries to `research.md`; output must have zero unresolved `NEEDS CLARIFICATION`. **Phase 1 (Design & Contracts)** — extract entities → `data-model.md`; define interface contracts → `contracts/` (skipped for purely internal tools); write a runnable `quickstart.md` validation guide (explicitly *not* allowed to contain full implementation code). The command "ERROR[s] on gate failures or unresolved clarifications" (line 165) — again enforced by instruction, not code.

## 6. Tasks template

`templates/tasks-template.md` + `templates/commands/tasks.md:143-214`. Required checklist line format: `- [ ] [TaskID] [P?] [Story?] Description with file path`, e.g. `- [ ] T012 [P] [US1] Create User model in src/models/user.py`. **Numbering**: sequential `T001, T002, …` in execution order across the whole file. **`[P]` marker**: only when the task touches different files with no dependency on an incomplete task. **Story grouping**: tasks are organized into phases — Phase 1 Setup, Phase 2 Foundational (blocking, no story label), Phase 3+ one phase per user story in priority order (P1/P2/P3, story-labeled `[US1]`/`[US2]`/…), final Polish phase (no story label). **Dependencies**: Setup has none; Foundational blocks all stories; each user-story phase should have no dependency on sibling stories (independently testable/shippable); within a story, tests → models → services → endpoints → integration. A "Parallel Example" section and an "Implementation Strategy" (MVP-first / incremental / parallel-team) close the template.

## 7. Checklists — "unit tests for English"

`templates/commands/checklist.md:9-28` states the core framing explicitly: checklists are **NOT** implementation/verification tests ("Verify the button clicks correctly" is wrong) but requirements-quality tests — "Is 'prominent display' quantified with specific sizing/positioning?" is right. `templates/checklist-template.md:7-9,37-45` codifies ownership: `[x]` means a *reviewer* judged the requirement well-written, never that implementation is done; `speckit.implement` reads checklist state as a gate but must never modify markers (`templates/commands/implement.md:56-59`); the built-in `checklists/requirements.md` has a separate lifecycle owned by `speckit.specify`/`speckit.clarify`, distinct from custom checklists. Items must carry a quality-dimension tag (`[Completeness]/[Clarity]/[Consistency]/[Coverage]/[Gap]/[Ambiguity]`) and ≥80% must carry a traceability reference (`Spec §X.Y`) (`templates/commands/checklist.md:224-227`).

## 8. Agent-agnostic delivery

One workflow, many agent formats, via a registry-driven integration layer (`AGENTS.md:27-49, 310-412`). Each of ~40+ agents (`src/specify_cli/integrations/<key>/`) subclasses one of four base classes — `MarkdownIntegration`, `TomlIntegration`, `YamlIntegration`, `SkillsIntegration` — declaring `key`, `config` (name/folder/commands_subdir/requires_cli), and `registrar_config` (output `dir`, `format`, argument placeholder `args`, file `extension`). Command templates use format-agnostic placeholders resolved at install time: `{SCRIPT}` → the `scripts:` frontmatter entry matching the project's chosen script dialect (`sh`/`ps`/`py`, selected via `specify init --script`), and `$ARGUMENTS` / `{{args}}` / agent-specific variants (e.g. Forge's `{{parameters}}`) for user input (`AGENTS.md:314-329, 383-392`). Output shapes diverge structurally — Markdown frontmatter, TOML `prompt = """..."""`, YAML Goose recipes with `prompt: |` — but all read the same stdout contract from the underlying scripts (`FEATURE_DIR:…`, `AVAILABLE_DOCS:…`, JSON shapes). `CommandRegistrar.AGENT_CONFIGS` (`src/specify_cli/agents.py:23-44`) derives itself from `INTEGRATION_REGISTRY` — a single source of truth, not per-agent duplication. Special-cased agents (Copilot's skills-vs-commands modes, Forge's frontmatter stripping, Goose's YAML rendering) override `setup()`/`command_filename()` rather than forking the template.

## 9. Heuristic vs. deterministic

**Deterministic (code):** feature numbering/slugging (`create-new-feature.sh`), the 4-layer template-resolution stack and its composition strategies, `.specify/feature.json` / env-var precedence for locating the active feature (`common.sh:163-231`), checklist checkbox *counting* in `speckit.implement`'s prerequisite gate (regex-described but literal `- [ ]`/`- [x]` matching), and command-file generation per agent format.

**Heuristic (LLM judgment, encoded only as prompt instructions):** essentially everything about *content* — ambiguity detection and its taxonomy, question prioritization ("Impact × Uncertainty"), severity assignment in `/analyze`, duplication/underspecification/inconsistency detection, constitution-gate evaluation, complexity-tracking justification, and task/requirement quality itself. None of this is validated by a parser or linter; a capable agent could skip or hallucinate a step, and nothing in the toolchain would catch it except another LLM-driven `/analyze` pass. This is the single most important architectural fact for porting: Spec Kit's "process" is a very well-specified *prompt program*, not a state machine with real guards.

---

## (a) Portable ideas

- **Structured ambiguity taxonomy with Clear/Partial/Missing scan** — a fixed checklist of dimensions (scope, data model, UX, non-functional, integrations, edge cases, constraints, terminology, completion signals) is a good deterministic-signal source even without an LLM. *(`templates/commands/clarify.md:73-124`)*
- **Hard cap on clarification questions with impact-based prioritization** prevents runaway interrogation loops. *(`templates/commands/clarify.md:129-138`)*
- **Recommended-option-first question format** (state your best guess, let the user just say "yes") minimizes round-trips. *(`templates/commands/clarify.md:148-169`)*
- **Append-only Clarifications log with immediate write-back into the source doc**, saved after every answer (crash-safe, auditable). *(`templates/commands/clarify.md:182-198`)*
- **Read-only cross-artifact analysis with a severity table and an explicit no-auto-edit rule** — good template for a `verify`/audit step that reports but doesn't mutate. *(`templates/commands/analyze.md:58, 153-190`)*
- **Checklist-as-reviewer-gate with immutable-by-agent markers** — a clean separation between "the agent may read gate state" and "only a human may set it." *(`templates/commands/implement.md:56-59`, `templates/checklist-template.md:41`)*
- **Complexity Tracking table only filled on violation** — cheap, low-noise way to force justification instead of scoring every change. *(`templates/plan-template.md:106-113`)*
- **Registry-driven multi-format delivery** (one canonical template + per-target adapter classes) rather than N copies of a workflow. *(`AGENTS.md:27-49`)*
- **Deterministic feature numbering/slugging with a stop-word filter**, independent of any git branch name. *(`scripts/bash/create-new-feature.sh:205-257, 342`)*

## (b) Not applicable / too heavy

- The 4-layer template override/preset/extension composition stack (`replace|prepend|append|wrap`) is overkill for a single-purpose MCP server with one lifecycle — no multi-tenant template marketplace to support.
- Full `[NEEDS CLARIFICATION]`-driven specify→clarify two-pass system (3 markers at spec time + up to 5 more in `/clarify`) is explicitly **out of scope** per the target constraint (no clarify step) — but its *taxonomy* is still reusable as static signals (see §c).
- Extension hook system (`.specify/extensions.yml`, `before_*`/`after_*` mandatory/optional hooks emitted as `EXECUTE_COMMAND:` blocks) — a prompt-level plugin bus; too much ceremony for a local-first server that can just call functions directly.
- Constitution-as-living-document with SemVer amendment governance and Sync Impact Reports is heavy process for solo/small-team local tooling; a lighter static `plan_policy` config is a reasonable substitute.
- Branch-per-feature git workflow and PR-disclosure/attribution rules (`AGENTS.md:475-537`) are repo/OSS-governance concerns, not lifecycle mechanics.

## (c) Proposed deterministic ambiguity-detection heuristic for `begin_task`

No LLM call; pure signal-scoring over task text + project facts, returning `clarification_needed: bool` + `candidate_questions: []` when the score crosses a threshold:

1. **Vague-verb check**: task text's main verb ∈ {improve, optimize, handle, support, fix, update, refactor, enhance} with no qualifying object/metric → +2.
2. **Missing-object check**: verb has no direct noun phrase within N tokens (e.g. "fix the bug" without naming which bug/file) → +2.
3. **Multiple-candidate-subsystem check**: fuzzy-match task keywords against top-level project directories/modules; if ≥2 plausible subsystems match with similar score → +2.
4. **No-acceptance-verb check**: task text lacks any testable/acceptance cue (should, must, when X then Y, returns, displays) → +1.
5. **High `plan_policy` complexity score** (already computed elsewhere in the lifecycle) above its own "requires plan_task" threshold → +2 (ambiguity and complexity correlate but aren't identical, so this is additive, not a substitute).
6. **Sensitive-path check**: task text or resolved file globs touch `auth/`, `payments/`, `billing/`, `*migration*`, `*.sql` → +3 (high blast-radius, low tolerance for guessing).
7. **Typo-fix escape hatch** (guarantees the stated constraint): if task text matches a typo/copy-edit pattern (`fix typo`, `rename`, `correct spelling`, single-file diff under a line-count threshold, matches `s/…/…/`-style description) → force score to 0 regardless of other signals, before scoring 1–6 runs. This must be checked *first* so a typo fix can never be pushed into `clarification_needed`.

Score ≥ threshold (e.g. 4) → set `clarification_needed: true` and populate `candidate_questions` templated per triggered signal (e.g. subsystem-ambiguity → "Which of {A, B} should this change target?"; no-acceptance-verb → "What observable behavior confirms this is done?"). This mirrors Spec Kit's taxonomy-scan-then-question-queue shape (`clarify.md:73-138`) but is table-driven and regex/keyword based — fully deterministic and unit-testable, with no taxonomy category left as free-text LLM judgment.

**Where answers are stored**: extend the task record (not a markdown "## Clarifications" section, since this is a structured server, not a doc-generation tool) with:

```json
{
  "clarification_needed": false,
  "clarifications": [
    {
      "question": "Which of {A, B} should this change target?",
      "signal": "multiple_candidate_subsystem",
      "status": "answered",
      "answer": "A",
      "answered_by": "user",
      "answered_at": "2026-09-15T12:00:00Z"
    }
  ]
}
```
`begin_task` blocks (or downgrades to `plan_task`-required) while any entry has `status: "pending"`; `checkpoint`/`verify` can re-run the same scorer against the diff to catch drift the original task text didn't reveal (e.g. touched an auth file the description never mentioned) — analogous to `/analyze` re-checking after tasks.md exists, but automatic and deterministic rather than a manual read-only report.

## (d) Attribution needs if templates/text were ported

Spec Kit is MIT-licensed (`LICENSE:1-3`, Copyright GitHub, Inc.), which permits reuse, modification, and redistribution provided the license/copyright notice is preserved in copies of "substantial portions" of the software. Practical guidance for this port:
- Reusing the *taxonomy categories*, the *severity levels*, or the general *shape* of a question (recommended-option-first) as short factual/functional lists is low-risk and does not require attribution — these are ideas/structure, not the expression.
- If any template prose is copied **verbatim or near-verbatim** (e.g. large chunks of `clarify.md`'s taxonomy list, the "unit tests for English" framing and its example pairs in `checklist.md`, or the analyze report table format), keep a code comment or docs note: "Ambiguity taxonomy adapted from GitHub Spec Kit (`github/spec-kit`), MIT License" and retain the MIT notice if the file itself is a derivative of a Spec Kit template file rather than an original file merely inspired by it.
- Do not carry over Spec Kit's own branding/command names (`speckit.*`, "Spec Kit") into the target system's user-facing surface — rename to the target's own lifecycle verbs (`begin_task`, `checkpoint`, `verify`, `complete`) to avoid implying endorsement or affiliation.
