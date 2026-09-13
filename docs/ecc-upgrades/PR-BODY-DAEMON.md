## What and why

Two things: every remaining branch is now in `main`, and the daemon is out of
the branch that was holding it hostage.

**The daemon, ported rather than merged.** `codex/commit-all-20260908` carries
the "daemon instead of Docker" direction — a local socket server, so one warm
process serves many clients and the search index and embedding model load once
instead of on every call. That branch cannot be merged: its merge base is 179
commits behind, it overlaps `main` on 31 files, and moving `main` to it would
be **744,638 deletions** — the vendored skill catalogue and everything since
the server was split into modules. Its `mcp-stdio.mjs` is 6,482 lines larger,
because it predates that split.

So the subsystem came across file by file, rewritten in this repository's style
with JSDoc rather than copied:

- `src/core/runtime-paths.mjs` — one definition of where runtime artefacts live
- `src/transport/socket.mjs` — MCP's line-delimited framing over a local socket
- `src/daemon.mjs` — the daemon itself, plus `npm run daemon`

`npm start` is untouched; the stdio path is still the default and nothing about
it changed. The daemon takes a pid lock, so a second one refuses instead of
stealing the socket, and a lock left behind by a dead process is cleared. It
publishes `~/.ai-dev/run/daemon.json`, creates the socket `0600` inside a `0700`
directory, and exits after `AI_DEV_IDLE_TIMEOUT_MS` with no sessions (default 30
minutes).

`socketAddress` takes platform and username as parameters instead of reading
`process.platform` directly, so the branch a Linux CI never executes — the
Windows named pipe — is still covered by tests. Including a domain account:
`CORP\Ivan Petrov` carries a separator and a space that would cut a pipe name
short, and two such accounts could collide on one machine.

**Branches.** Sixteen of the nineteen fork branches were already contained in
`main`. The remaining three converged on one (`claude/lucid-ramanujan-syom2o`
had already absorbed the other two), so a single merge brought them all:
cache-write pricing in the usage ledger, a health check that stopped racing its
own freshness fixture, and the per-stage session prompts. No fork branch is now
outside `main`.

**The prompt that verifies a machine** learned to find the right repository
first. An agent following it ran `git pull` inside an Obsidian vault that is
itself a git repository, got `refusing to merge unrelated histories`, and was
one `--allow-unrelated-histories` away from splicing this public project into
personal notes. It now tells the two roots apart by what they contain, names
the symptoms of being in the wrong one, and forbids that merge outright.

### What this deliberately does not do

`tool-profile.mjs` (core/full tool profiles), `project-trust.mjs` and
`scripts/models.mjs` stay in the snapshot branch. Each needs its own pass:
profiles rewrite `tool-definitions.mjs`, trust needs something to gate, and
model downloading is already partly covered here by `embedding-workers.mjs` and
the `--dense` setup step, so it wants reconciling rather than porting. Recorded
in `docs/ecc-upgrades/DEBTS.md` as Д-42, along with why the branch must be
neither merged nor deleted.

## Type

- [ ] Bug fix
- [x] Feature
- [x] Docs
- [ ] Refactor / internal
- [ ] Build / CI / packaging

## Checklist

- [x] `npm run check` passes from `ai-dev-mcp-server/` — 957 tests, 950 pass,
  0 fail, 7 skipped; coverage 97.02 lines / 83.78 branches / 94.82 functions
  against thresholds 85 / 60 / 85.
- [x] New behaviour has tests; `src/core/` additions have JSDoc types —
  `runtime-paths.test.mjs` covers the path tree, the Windows pipe, the domain
  account, an empty username, and a caller-supplied directory. Beyond the unit
  tests, the daemon was **run**: descriptor written with pid, version and
  address; socket mode `600`; `initialize` carried 1,048 characters of server
  instructions; `tools/list` returned 133 tools; `search_index_status` returned
  3,443 documents; two clients served concurrently on one daemon; a second
  `runDaemon()` returned `false`.
- [x] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] Conventional commit messages (`type(scope): subject`) — mixed, and
  flagged rather than ticked. The three commits arriving from the fork branches
  use that form (`feat(usage):`, `test(system):`, `docs:`); the ones written
  here follow `main`'s own prose style. The checklist item and the history of
  this repository still disagree, and which one gives is the maintainer's call.
- [x] No secrets, tokens, personal paths, or a personal vault in the diff —
  `npm run security` passes inside `check`.
- [x] Docs updated if behaviour, flags, or setup changed — `ARCHITECTURE.md`
  gains the daemon as a runtime layer, with the list renumbered.

## Size

18 files, +609 / −40. Nothing under `docker/public-seed` changed. The four new
files are the whole of the daemon:

| File | Lines |
| --- | --- |
| `src/daemon.mjs` | 150 |
| `src/transport/socket.mjs` | 79 |
| `src/core/runtime-paths.test.mjs` | 75 |
| `src/core/runtime-paths.mjs` | 69 |
