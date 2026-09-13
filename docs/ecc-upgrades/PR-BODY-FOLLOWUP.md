## What and why

Everything on top of `e8bc590`, the point where PR #38 merged. Two things
arrived that the project did not have before — a catalogue of skills large
enough to be useful, and a way for any assistant to reach it — and four debts
closed behind them.

**Every assistant reads the protocols, not just one.** `install_project_rules`
used to write `AGENTS.md`, `.claude/rules` and `.cursor/rules`. It now also
writes `GEMINI.md`, `.github/copilot-instructions.md`, `.windsurf/rules` and
`.clinerules`, and with no explicit targets it installs the defaults plus the
files whose tool this repository or this machine already shows a trace of — so
nothing writes a file nobody reads. The workflow protocols (the intent gate, the
orchestrator handoff) go into that same file, which is why they now work outside
a single vendor's client.

**3,085 skills.** `grill-me` — this project's own intent gate, which interviews
a vague request before work starts — following the `grilling` interview imported
from [mattpocock/skills](https://github.com/mattpocock/skills); the whole
[Membrane](https://github.com/membranedev/application-skills) integration
catalogue, 3,074 application skills from Gmail and Slack to Salesforce; and the
nine [Understand Anything](https://github.com/Egonex-AI/Understand-Anything)
codebase-graph skills. 3,084 of them are imported, all MIT, each recorded in
`THIRD_PARTY_NOTICES.md` with its revision and its licence text beside the
source; the remaining one is `grill-me`.

Importing 3,074 integration skills would wreck routing if they competed for
every task, so two changes hold it: `membrane_policy` keeps an integration skill
out of the answer until a task names its application, and a named skill needs
three matching terms and a name match before it can take the reserved
specialist slot. The 37-case golden routing benchmark is unchanged and still
passes.

**An English task can now reach an imported skill at all.** The concept
triggers were written for one language, so a task phrased in English scored
zero against a catalogue that is entirely in English. Whole-word matching and a
name-match score fix it.

**HarmonyOS projects get the rules they are detected by.** `packsForStack`
recognised the ArkTS/HarmonyOS stack but the catalogue had no pack for it, so
detection resolved to nothing.

### Debts closed

The registry in `docs/ecc-upgrades/DEBTS.md` goes to 38 of 39 closed. Three of
them are here:

- **The flake that was never a test failure.** `npm run check` exited non-zero
  with `# fail 0` roughly once in five to ten runs. Cause:
  `--experimental-test-coverage` sets `NODE_V8_COVERAGE` and every child process
  inherits it — git, python, installed hooks, MCP smokes — and a child killed
  before V8 flushed left a zero-length file that the reporter choked on.
  `test/setup.mjs` drops the variable after the process has claimed its own
  path. Files in the coverage directory: 376 → 121. Twenty consecutive runs on
  this tree: **0 failures out of 20**, on a machine that reproduced the defect
  (run 5 of a trap loop, run 8 of a plain ten) before the fix.
- **The acceptance rule is now a command.** `npm run acceptance` runs the gate
  ten times and prints the line itself, keeping apart the two failures that used
  to collapse into one number: a failing test is the suite saying something, a
  non-zero exit with `# fail 0` is the coverage reporter saying nothing.
  `--runs N` for a longer sample.
- **The Cursor hook format is honest about what was not checked.**
  `install_agent_hooks` now returns the claims that could not be verified from
  here, and `npm run verify:cursor` prints the five-minute check a person with a
  real Cursor has to run. The underlying debt (Д-2) stays open on purpose: it
  closes with a human in a real editor, not with code.

### What this does not close

Д-2, above. It is the only open entry in the registry.

## Type

- [ ] Bug fix
- [x] Feature
- [ ] Refactor / internal
- [x] Docs
- [ ] Build / CI / packaging

Two boxes, because the bulk of the diff is vendored content and its notices,
and the rest is behaviour. Bug fixes are in here too (the coverage flake, the
English-task scoring, the missing ArkTS pack), but they are not the point of
the change.

## Checklist

- [x] `npm run check` passes from `ai-dev-mcp-server/` — 946 tests, 939 pass,
  0 fail, 7 skipped; coverage 96.99 lines / 83.68 branches / 94.79 functions
  against thresholds 85 / 60 / 85. Twenty consecutive runs: 0 failures out of 20.
- [x] New behaviour has tests; `src/core/` additions have JSDoc types —
  `acceptance.mjs` ships with `acceptance.test.mjs` and JSDoc on all five
  exports; `agent-hooks`, `rules-library`, `task-vocabulary` and
  `skill-recommendation` each gained assertions. `rules-catalog.mjs` is data for
  `rules-library` and is covered by `rules-library.test.mjs`, where the new
  `arkts` pack is asserted directly.
- [x] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] Conventional commit messages (`type(scope): subject`) — **not met, and
  not met by this repository either.** None of the twenty commits before
  `e8bc590` use that form; the history is imperative prose sentences, and these
  six match it. Flagging rather than ticking: either the checklist item or the
  history is out of date, and that is the maintainer's call.
- [x] No secrets, tokens, personal paths, or a personal vault in the diff —
  `npm run security` passes inside `check`; `docker:seed:verify` verifies 4,186
  files against the manifest and `docker:audit` passes over 4,334 context files;
  an independent scan of the tracked tree for Windows and macOS home paths,
  personal identifiers and vault directories returns only a synthetic test
  fixture (`/Users/dev/…`) and references to Obsidian as a supported product.
- [x] Docs updated if behaviour, flags, or setup changed — including
  `docs/TOOLS.md`, which this pass found stale: `install_project_rules` changed
  its description and the generated reference had not been re-rendered.

## Size, and how to read the diff

3,170 files changed. 3,147 of them are the vendored skill catalogues under
`docker/public-seed/03-skills-catalog/sources/external/`, which are imported
content, not authored code. The reviewable change is 23 files:

| Area | Files |
| --- | --- |
| `ai-dev-mcp-server/src/` | 12 |
| `ai-dev-mcp-server/scripts/` | 3 |
| `docs/ecc-upgrades/` | 3 |
| `ai-dev-mcp-server/test/`, `package.json`, `docs/TOOLS.md` | 3 |
| `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md` | 2 |

`git diff e8bc590..HEAD -- ':!docker/public-seed'` is the whole of it.

### Measurements after the import

| | before | after |
| --- | --- | --- |
| skills in the registry | 142 | 3,227 |
| seed files | 1,043 (18 MB) | 4,186 (40 MB) |
| docker context files | — | 4,334 (44 MB) |
| tools | 133 | 133 |
| golden routing cases | 37 | 37 |

The search index holds 3,443 documents after the import, 3,227 of them skill
cards — read live from `search_index_status`, not from a note. No before-value
is quoted for it because none was recorded at the time and it cannot be
reconstructed from the tree.
