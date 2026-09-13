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

### A correct install failed its own health check, everywhere

The Windows report said a fresh clone greets its first user with `Health: fail
— 4 not passing`, and that read as a Windows finding. A clean clone on Linux
reproduces it word for word, so it was what every new user saw on any platform.
Three unrelated causes:

- **The Frontend QA runner ships but imports Playwright at module load**, so on
  a clone that never ran `--frontend-qa` the `ERR_MODULE_NOT_FOUND` escaped and
  `runCheck` filed it as a failure. It is now an unavailable status carrying the
  command that installs it. Playwright present but its browser missing stays a
  warning — that one really is half configured and the person can fix it.
- **The embedding check listed only the weights as optional**, but `--dense`
  also builds the Python environment its own step description names ("a Python
  environment plus 2.3 GB of weights"). `embeddings_python` joins the optional
  set; a missing shipped helper is still a failure.
- **`skill_quality` failed on exactly one important skill: `grill-me`**, written
  in this same work. Its card said "read the `grilling` skill and follow it" and
  little else — no trigger wording, no procedure of its own, no statement of
  what the gate must produce. It now carries a seven-step procedure and an
  acceptance section naming the three things that must exist before
  `begin_task`: the request as you now read it, the assumptions you made, and
  criteria each settleable by a command, a file or a number. Its quality
  findings went from four to zero.

Measured on the same clean clone: `fail — 4 not passing` became `degraded — 2
not passing`, both warnings that name a next step. Ten consecutive gate runs on
Linux: **0 failures out of 10**.

The same pass corrected something I had said wrongly. "POSIX hides this because
/tmp is not under the home directory" was true of the *test*, not of real use:
Linux projects live in `~/…`, so the shared-memory-key defect hit Linux users
too. Measured with a home-shaped layout — before the fix `~/dev/projA` and
`~/dev/projB` both resolved their boundary to `$HOME`; after it they differ.

### macOS was supported by assumption

`ci.yml` had three `ubuntu-latest` jobs and one `windows-latest` job, and
nothing for macOS — while platform differences produced most of the defects in
this pull request. macOS is not almost-Linux: a case-insensitive filesystem by
default, and `os.tmpdir()` under `/var/folders`, which is a symlink to
`/private/var`. Both land in exactly the path canonicalisation and boundary walk
that have been biting. A `macos-latest` job now runs the unit tests, the
identity and hook tests on their own, a first run, and the seed check — so the
platform is measured rather than assumed.

### The model was documented into a mount that Compose did not have

Dense retrieval on the local BGE-M3 model is half of what the search does, and
in a container it hung on `AI_DEV_MODEL_PATH`. Only the launcher scripts
(`run-mcp.sh`, `run-mcp.ps1`) read that variable. Compose had no `/models` mount
and no mention of it — while the README explained the variable in the section
about Compose. A reader following those instructions got a container where
`BGE_M3_MODEL_DIR=/models/bge-m3` pointed at nothing, and the failure was quiet:
`embedding_backend` reports `skipped` with "download the model", which reads as
user error rather than a missing mount.

`compose.local.example.yaml` now carries the mount, commented, against the same
variable the launchers use, so both ways of starting the image agree. Proved by
merging the two files as Docker merges them:

```
volumes:
  - volume ai-dev-data              -> /data
  - bind   ${AI_DEV_PROJECT_PATH}   -> /workspace
  - bind   ${AI_DEV_MODEL_PATH}     -> /models/bge-m3   (read_only)
```

Both READMEs and `docker/README.md` gain end-to-end instructions: the build
argument that installs the Python side (`INSTALL_BGE_M3=1`, off by default so
nobody pays for an install they do not use), the one host command that downloads
the weights, both ways to run it, a four-line Dockerfile for anyone who wants
the weights baked into an image of their own, and what to read to confirm it
worked.

The claims in those instructions were checked rather than written from memory,
and one of the four was false: the draft told the reader to look for
`dense_enabled`, a key `embedding_status` does not return. It is now the keys
that exist. The other three hold — `embeddingsDir` resolves to
`/opt/ai-dev/embeddings` under the image layout, which is exactly where the
`INSTALL_BGE_M3=1` step builds the virtual environment the server looks for; and
`network_mode: none` does not block the model, because both embedding helpers
set `TRANSFORMERS_OFFLINE=1` and `HF_HUB_OFFLINE=1` before loading. Recorded as
Д-52 with the measurement on both sides.

Docker is not a detour here: it is the packaged way to run this, and the model
is part of the package.

### The repository finally has the file it writes for everyone else

`install_project_rules` exists to put engineering protocols into the file every
assistant reads. This repository had none: no `AGENTS.md`, no `CLAUDE.md`, no
`GEMINI.md`, no `.clinerules`. The rules this work was held to — new tools only
as extensions, never importing `mcp-stdio.mjs`; the 800-line module ceiling and
its two pinned exceptions; fake secrets in tests assembled by concatenation
because a literal trips the security scan; the deliberate duplication under
`hooks/`, since those files run inside other people's repositories with no
access to this package; a defect written down with a measurement before and
after; a session that ends with ten gate runs and the line `N падений из 10`
rather than one green run — were held in whoever was working. The next agent
would have broken them and been right to.

Written by hand, not generated: in this repository the file is the source, not
the tool's output. Closes Д-43, whose other half (`/.ai-dev/` in `.gitignore`,
anchored to the root so it cannot swallow the tracked fixture trees under
`frontend-qa/fixtures/`) was already fixed.

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

- [x] `npm run check` passes from `ai-dev-mcp-server/` — 978 tests, 971 pass,
  0 fail, 7 skipped; coverage 97.05 lines / 83.83 branches / 94.79 functions
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
  Д-45 through Д-52 with their measurements, including Д-48, which states what
  the boundary fix deliberately leaves open rather than letting a narrow test
  imply it is solved, and Д-52, where checking my own draft instructions found
  a key in them that does not exist. The verification prompt now proves an update arrived
  before trusting a single result, after a whole run was spent on pre-fix code.

## Size

22 files, +905 / −49. The only change under `docker/public-seed` is the rewritten
`grill-me` card and the manifest entry that follows it. The largest entries are
the debt registry and the two READMEs; the behaviour change is eight source
files.
