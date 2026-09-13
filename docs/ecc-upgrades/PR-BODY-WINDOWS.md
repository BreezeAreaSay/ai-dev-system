## What and why

Everything here came out of one verification run on a Windows machine. Four
defects, each measured before and after, plus the prompt that found them.

**`npm run acceptance` never finished a single run on Windows.** It spawned a
bare `npm`, which is `npm.cmd` there, and Node will not execute a `.cmd`
without a shell — so the command that exists to measure flakiness died with
`spawn npm ENOENT` on run 1 of 10. The project already had the answer:
`resolveSpawnInvocation` rewrites the call to `node <npm-cli.js>`, shell-free.
It is now resolved once up front, so a failure is reported before ten runs are
announced rather than in the middle of the first.

**`run_quality_gate` named a path it had never looked at.** It probes the path
the host builds and then rebuilt a different one with `path.join` for the error
message. On POSIX the two coincide; on Windows they do not, and the user is
told a file is missing at a path nothing ever checked. The test's own name —
"a missing gate file names the path it looked for" — states the contract that
broke.

**Routing let two skills claim a task named for a third.** Both defects are in
how a skill counts as "named by the task":

- `exactName` was substring containment. "our deploy pipeline" contains
  "eploy" — a UK recruitment system in the imported catalogue — which then
  scored +24 and passed the membrane floor. With 3,074 short product names
  that collision is routine, not exotic. `taskNamesSkill` now matches whole
  words, reading hyphens as spaces so "google drive" still names
  `google-drive`.
- A compound name counted as named when the task carried one part of it:
  "deploy" named `octopus-deploy`, "message" named `message-bird`. Measured on
  "set up a Slack notification integration for our deploy pipeline",
  `octopus-deploy` scored 14 against `slack`'s 13 — outranking the skill the
  task had actually named. Every part must now be present.

  After: the same task returns `slack` at 122 with no `octopus-deploy`, no
  `message-bird` and no `eploy`; "send a notification through gmail" still
  returns `gmail`; the 37-case golden benchmark is unchanged.

**`docker:audit` judged a tree that no longer existed.** It reads
`.docker/build-context`, which is local build output, and believed whatever it
found. On the run it reported `scripts/models.mjs` as a dangling import — a
module this repository does not carry and nothing in it references. The
manifest now records `generated_at`, kept outside `content_fingerprint` so the
same tree still fingerprints identically, and the audit refuses a context
older than the sources or one that cannot say when it was made.

**Housekeeping.** Running the server against this repository writes plans,
decisions, context, the quality gate, prepared pull requests, git hooks and
caches under `.ai-dev/`; `.gitignore` listed two of those files, so every
verification run started against a dirty tree. The rule is anchored to the
root deliberately: an unanchored `.ai-dev/` also matches
`frontend-qa/fixtures/**/.ai-dev/`, where fixture files are tracked, and any
new one would have dropped out of the index silently. `AGENTS.md` is left
unignored on purpose — this repository has none of its own, which is a gap to
fill rather than hide (Д-43).

### What this does not close

Two tests fail on Windows and reproduce nowhere else:
`the hook and the server agree on a project reached through another spelling
of its path` and `projects outside Git fall back to the project id as their
memory key`. Both concern `project_id`. They are reported by name; the
assertion text has not reached anyone who can act on it, so nothing is guessed
at here. Recorded in `docs/ecc-upgrades/DEBTS.md` as Д-44 with the hypotheses
and the exact output needed to settle them.

The same run also produced 3, 4 and 8 failures from the same commit on the
same machine, depending on the tree and the moment. The tests that come and go
are the ones with hard deadlines (`budgetMs: 150`) or child processes; they are
hermetic — each builds its own directory under `os.tmpdir()` — so this is load,
not state. That is precisely what `npm run acceptance` measures, and it is
what the first fix in this pull request makes possible on Windows at all.

## Type

- [x] Bug fix
- [ ] Feature
- [ ] Refactor / internal
- [x] Docs
- [ ] Build / CI / packaging

## Checklist

- [x] `npm run check` passes from `ai-dev-mcp-server/` — 967 tests, 960 pass,
  0 fail, 7 skipped; coverage 97.05 lines / 83.81 branches / 94.83 functions
  against thresholds 85 / 60 / 85.
- [x] New behaviour has tests; `src/core/` additions have JSDoc types —
  `taskNamesSkill` and the compound-name rule get five cases in
  `task-vocabulary.test.mjs` (including the measured `eploy` collision);
  `buildContextStaleness` gets four in `public-distribution.test.mjs`; the gate
  path test now asks the same host the code asks instead of spelling
  separators by hand.
- [x] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] Conventional commit messages (`type(scope): subject`) — not met, and not
  met by this repository's own history either. Flagged rather than ticked.
- [x] No secrets, tokens, personal paths, or a personal vault in the diff —
  `npm run security` passes inside `check`.
- [x] Docs updated if behaviour, flags, or setup changed — `DEBTS.md` records
  Д-43 and Д-44 with measurements; `PROMPT-VERIFY-LOCAL.md` now finds the right
  repository first, re-checks each fix, and asks for raw output rather than a
  verdict.
