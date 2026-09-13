## What and why

The 2.0.0 work merged as [#43](https://github.com/stonebridgeway/ai-dev-system/pull/43). This is what came after it, and none of it is
code: the model that makes the search understand a question could not be
mounted into a container, the release a version number cannot perform was never
written down, and the repository that writes `AGENTS.md` for everyone else had
none of its own.

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

### The release a version number cannot perform

The Releases page still said `v1.0.0`, and it was right to: `package.json` at
2.0.0 creates no tag, and everything downstream hangs off the tag rather than
the file. `RELEASE-STEPS-2.0.0.md` is the order that unwinds — merge, tag (a
`v*` tag is what runs the Docker workflow and publishes
`ghcr.io/stonebridgeway/ai-dev-system:v2.0.0` for both architectures), the
Release from notes that already exist, then the Homebrew formula and the Arch
`PKGBUILD`, then the README line saying the formula installs `v1.0.0` — which
stays true until the formula is updated and not a moment before. The formula
could not have been bumped earlier: it pins an immutable tag archive and its
SHA-256, and until the tag exists there is nothing to hash.

### What could not be checked here

This environment has no Docker daemon, so the image was never built. Everything
claimed about the container was verified another way — the asset resolution
against a mock of the image layout, the interpreter path against the Dockerfile
step that creates it, the offline flags in the embedding helpers, the merged
Compose config through `docker compose config`, and the status keys through a
live `embedding_status` call. What remains is the live run, and the verification
prompt's new step 9 asks for exactly that: two paths and seven availability
flags from inside a container, the volume list from the merged config, and one
adversarial run with the model *not* mounted, where the claim is that
`embedding_backend` says `skipped` rather than `fail`.

## Type

- [ ] Bug fix
- [ ] Feature
- [x] Docs
- [ ] Refactor / internal
- [x] Build / CI / packaging

## Checklist

- [x] `npm run check` passes from `ai-dev-mcp-server/` — 978 tests, 971 pass,
  0 fail, 7 skipped; coverage 97.05 lines / 83.83 branches / 94.79 functions
  against thresholds 85 / 60 / 85. Ten consecutive runs: 0 падений из 10.
- [x] New behaviour has tests — no behaviour changed. The one executable file
  here is a Compose example, checked by merging it as Docker merges it.
- [x] `CHANGELOG.md` updated — the container-model fix and the root
  `AGENTS.md`, both under `[2.0.0]`, and the test counts brought to 978.
- [ ] Conventional commit messages (`type(scope): subject`) — not met, and not
  met by this repository's own history either. Flagged rather than ticked.
- [x] No secrets, tokens, personal paths, or a personal vault in the diff —
  `npm run security` passes. The `AGENTS.md` example was rewritten after
  checking what the scanner actually matches: `AKIA…`, `sk-…`, a private-key
  header and a credential assignment, over `src/` and `scripts/` only.
- [x] Docs updated — three READMEs, the Compose example, the verification
  prompt, the release notes, and `DEBTS.md`, which now closes Д-43 and adds
  Д-52 with measurements on both sides.

## Size

12 files, +1,021 / −37, no source files. The largest entries are the two
READMEs and the debt registry; `AGENTS.md`, `RELEASE-STEPS-2.0.0.md` and this
body are new.
