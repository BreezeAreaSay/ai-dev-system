## What and why

Release 2.0.0, and the four defects a Windows verification run found on the way
to it.

### The one that mattered most

**Every project under a user's home directory shared one memory key.** Two tests
failed only on Windows. Their names said nothing, but the raw assertions said
everything once they arrived: `actual` was the same string in all four failures
— different temp directories, different tests, a separate clean clone. The hook
was not disagreeing with the server; it was returning a constant.

`projectBoundaryOf` walks up to the filesystem root and stops at the first
project marker. `.ai-dev` is a marker, so the server's own runtime directory is
excluded from the list — but the hook compared a candidate `<dir>/.ai-dev`
against `stateRoot()`, which is `<home>/.ai-dev/state`, one segment deeper. The
comparison never matched, so `<home>/.ai-dev` read as a project boundary.

POSIX hides this because `/tmp` is not under the home directory. On Windows
`os.tmpdir()` is `C:\Users\<name>\AppData\Local\Temp`, so the walk from any
project there reached the profile, found `.ai-dev`, and stopped. Session memory,
instincts and handoffs are keyed by that id: notes from one project were handed
to an agent working on another, silently.

Reproduced on Linux with the same layout — two sibling projects both hashing to
`project-e24ca70e5358e2931b79` in the hook while the server told them apart.

The first test written for it was itself platform-dependent, and Windows CI
caught that: it asserted two sibling projects differ, which holds on POSIX
(the fake home lands in `/tmp` with no marker above it) and fails on Windows,
where `os.tmpdir()` sits inside the real user profile and the walk finds a
marker there. It now asserts what the fix actually guarantees — a home whose
only marker is `.ai-dev` is walked past — inside a tree with a marker of its
own, so nothing above the temp directory can change the answer. A second test
covers the other half: a real marker at that level still stops the walk, so
`.ai-dev` is skipped for being the runtime tree rather than by position.

That leaves the general case open, and `DEBTS.md` records it as Д-48 rather
than leaving it implied: the walk still runs to the filesystem root, so a
`package.json` in someone's home directory collapses every project below it the
same way. The hook and the server agree there, so it is a question about the
rule, not a divergence to fix — with three answers and the measurement behind
each.

### Three correct states that looked like faults

Someone installing this for the first time met all three at once and drew the
only sensible conclusion.

- **`docker:seed:verify` called 74 files corrupt.** They matched except for
  their line endings: a checkout older than `.gitattributes` keeps CRLF, and git
  does not rewrite files already on disk when that rule arrives. Measured: every
  listed file was larger than its entry by exactly its line count — 258 bytes
  against 262 for a four-line file, 1,065 against 1,086 for a 21-line LICENSE.
  The verifier now names that case and prints the command that fixes it.
- **`embedding_backend` failed a clone that never asked for the optional
  model.** The weights come from `npm run setup -- --dense` and weigh hundreds of
  megabytes; their absence is "not set up", not "broken". It is now `skipped`
  with the command that brings them. A missing shipped helper is still a
  failure — the two are told apart by which requirements are gone.
- **`npm run acceptance` reported ten real test failures as a mystery.** Its
  parser read only `/^# fail (\d+)$/m`; Node 22 writes that TAP comment, Node 24
  writes `ℹ fail 2`. On Node 24 nothing ever matched, so every run was filed as
  "failed before the tests" — the one distinction this command exists to make.
- **One test measured a deadline it never set.** `the jobs behind a timed-out
  one are still evaluated` set a 150 ms per-job budget but inherited the default
  1000 ms batch deadline, most of which two catastrophic patterns consumed.
  Measured: at 260 ms the tail comes back all-null, at 5000 ms it is stable. The
  deadline is now stated; the batch deadline keeps its own test.

### The release

A major version because what a clone *is* changed, not only what it can do. The
changelog states three breaking changes with what to pass to restore the old
behaviour:

- the bundled seed carries 3,227 skills instead of 142, so routing sees
  different candidates (`membrane_policy: "exclude"` restores the narrow set);
- `system_health` reports `embedding_backend` as `skipped` rather than `fail`
  when the optional model was never downloaded;
- `install_project_rules` with no explicit `targets` writes more files than
  before, chosen by what the machine already uses.

The unreleased section — 1,248 lines accumulated since 1.0.0, while 1.1 and 1.2
were tagged without entries — becomes the 2.0.0 release and gains a highlights
block. Both READMEs get a "new in 2.0" section and a licences table naming every
vendored catalogue, its size and its revision, including the one upstream that
ships no LICENSE file of its own and declares MIT per skill instead.

## Type

- [x] Bug fix
- [ ] Feature
- [x] Docs
- [ ] Refactor / internal
- [x] Build / CI / packaging

## Checklist

- [x] `npm run check` passes from `ai-dev-mcp-server/` — 977 tests, 970 pass,
  0 fail, 7 skipped; coverage 97.04 lines / 83.80 branches / 94.84 functions
  against thresholds 85 / 60 / 85. `packaging:check`, `docs:tools:check` and
  `docker:seed:verify` pass.
- [x] New behaviour has tests; `src/core/` additions have JSDoc types — the
  boundary fix is pinned by a test that builds the home-nested layout and fails
  on any platform; `lineEndingOnlyMismatch` and the acceptance parser get three
  cases each, including the near-misses (a lone CR, a count that only looks like
  the line); the embedding split is tested from both sides.
- [x] `CHANGELOG.md` updated under `[Unreleased]` — promoted to `[2.0.0]`.
- [ ] Conventional commit messages (`type(scope): subject`) — not met, and not
  met by this repository's own history either. Flagged rather than ticked.
- [x] No secrets, tokens, personal paths, or a personal vault in the diff —
  `npm run security` passes inside `check`.
- [x] Docs updated if behaviour, flags, or setup changed — `DEBTS.md` records
  Д-45, Д-46 and Д-47 with their measurements; the verification prompt now
  proves an update arrived before trusting a single result, after a whole run
  was spent on pre-fix code.

## Size

17 files, +500 / −26. Nothing under `docker/public-seed` changed. The largest
entries are the debt registry and the two READMEs; the behaviour change is six
source files totalling +106 lines.
