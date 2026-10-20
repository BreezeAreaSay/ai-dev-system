# Releasing 3.0

How 3.0 goes from the fork `BreezeAreaSay/ai-dev-system` to the production repository,
`stonebridgeway/ai-dev-system`, and from there to the people who use it — and how it is taken back.
Every step that publishes something is the owner's. Everything before it has been run where it can be;
the last section says where, and what it printed.

The commands are for a POSIX shell, with the GitHub CLI (`gh`) signed in as an account that can push
to the production repository and run its workflows, Docker for `imagetools`, and Node 24 with npm.

The npm package is `ai-dev-system`, with no scope (owner's decision, 2026-10-20): it needs no npm
organisation, only `npm login` as the account that will own it (with `--otp=<code>` on `npm publish` when
two-factor authentication is on). The name was free on 2026-10-20, and so were its look-alikes npm would
refuse (`aidevsystem`, `ai_dev_system`, `ai.dev.system`): publish soon, since the guides already say
`npx ai-dev-system`.

## What goes out

| What | Where | Made by | What the owner does |
|---|---|---|---|
| The source | `main` of `stonebridgeway/ai-dev-system` and the tag `v3.0.0` | the merged pull request and the tag | reviews, merges, tags |
| The image | `ghcr.io/stonebridgeway/ai-dev-system`: `:edge` from `main`; `:3.0.0`, `:3.0`, `:3` and `:latest`, each with a `-browser` twin, from the tag | `.github/workflows/docker-publish.yml`, job `publish` | nothing: the workflow's own token publishes |
| The 2.x line, to go back to | `:2`, a copy of today's `:latest` | the same workflow, job `freeze-2x` | runs it once, after the merge and before the tag |
| The npm package | `ai-dev-system@3.0.0` | `npm run dist:pack` | `npm publish` of the tarball |
| The Windows installer | the GitHub release `v3.0.0`, as a draft | `.github/workflows/desktop-windows.yml`, jobs `build` (builds and signs) and `release` | signing (optional); publishing the draft |

Today (checked 2026-10-20, read only): production `main` is `7bef129`, an ancestor of the fork; its tags
are `v1.0.0` and `v2.0.0`; the image's tags are `:latest` and `:main` (both `7bef129`'s build,
`sha256:87df7cde…`), `:v1.0.0`, `:v2.0.0` (`sha256:41cc9635…`) and 21 `:sha-*` — no `:2`, `:3`, `:edge` or
`-browser` tag; `ai-dev-system` is not on npm (`npm view` answers 404). Each push to
production `main` still publishes `:latest` (Д-108) — until the merge brings the workflow that does not.
So `:2` will be `7bef129`'s build, not the image of the `v2.0.0` release, and `:main`, which 3.0's
workflow no longer writes, stays a 2.x tag after the merge.

## 1. The pull request

The program's work is on the fork's branch `claude/exciting-hawking-fb4g4p`; the fork's `main` takes it
by fast-forward, and the pull request goes from there:

```sh
git clone https://github.com/BreezeAreaSay/ai-dev-system.git && cd ai-dev-system
git fetch origin claude/exciting-hawking-fb4g4p
git merge --ff-only origin/claude/exciting-hawking-fb4g4p
git push origin main
gh pr create --repo stonebridgeway/ai-dev-system --base main --head BreezeAreaSay:main \
  --draft --title "AI Dev System 3.0" --body-file docs/release-notes-3.0.0.md
```


A pull request from a fork gets no secrets and its `publish`, `freeze-2x` and `release` jobs are
skipped: it publishes nothing. If GitHub asks to approve the workflows of a fork's pull request, approve
them.

### What must be green

On the pull request's last commit, every job of three workflows:

| Workflow | Job | What it proves |
|---|---|---|
| CI | MCP server (lint, security, unit) | the gate, the static checks, the core tests on Node 24 |
| CI | No Python (ubuntu-latest), (macos-latest), (windows-latest) | search and setup with no Python on the three systems |
| CI | MCP server (Node 22.16 floor) | the oldest Node the package accepts |
| CI | Desktop app (Electron, xvfb) | the app's tests and its end-to-end screens |
| CI | MCP server (vault-coupled suite + smokes) | the whole suite, the protocol and lifecycle smokes |
| CI | macOS (core + hook tests, first run) | macOS |
| CI | Windows (PowerShell syntax, bootstrap plan, installer, core + hook tests) | Windows, `bootstrap.ps1`, the installer's scripts |
| Docker | validate, validate-browser | the image and its browser variant build, answer MCP, write a client, upgrade a 2.x volume |
| Docker | unix-launcher (ubuntu-latest), (macos-latest) | the 2.x launchers still start the server |
| Windows installer | Build the installer (windows-latest) | the installer builds on Windows, unsigned here |


### Dense search on the real weights

`dense-eval.yml` downloads the pinned BGE-M3 export (about 600 MB) and measures dense search with it —
the one check no sandbox of the program could run (Д-101). It runs only by hand, and only on a branch of
the production repository, so the pull request's head goes there first. No workflow runs on a push to
such a branch.

```sh
git push https://github.com/stonebridgeway/ai-dev-system.git main:refs/heads/release/3.0.0
gh workflow run dense-eval.yml --repo stonebridgeway/ai-dev-system --ref release/3.0.0
sleep 15                                            # the run takes a moment to be listed
gh run watch --exit-status --repo stonebridgeway/ai-dev-system "$(gh run list --repo stonebridgeway/ai-dev-system \
  --workflow dense-eval.yml --branch release/3.0.0 --limit 1 --json databaseId --jq '.[0].databaseId')"
```

It has passed when every step is green — the download matched every file's sha256, `dense:doctor` said
READY, the inference test ran (it skips only without the weights) — and the summary shows every document
embedded (0 pending) and the golden cases at least where search stands without the model: 37 of 45, mean
reciprocal rank 0.510 — lexical search alone on the same cases and today's catalogue (`run_search_eval`
with `include_dense: false` on `a9a02e9`). Fewer means dense scoring makes ranking worse: record it, and do not merge. Delete the
branch afterwards:
`git push https://github.com/stonebridgeway/ai-dev-system.git --delete release/3.0.0`.

### Merging

With a **merge commit** — not squash, not rebase: `docs/DEFECTS.md` and the CHANGELOG name the
program's commits by hash, and those must stay reachable.

```sh
gh pr ready <number> --repo stonebridgeway/ai-dev-system
gh pr merge <number> --repo stonebridgeway/ai-dev-system --merge
```

The push of the merge runs CI on `main` and publishes `:edge` and `:sha-<commit>` — not `:latest`
(owner decision D9). `:latest` stays the 2.x image until the tag.

```sh
docker buildx imagetools inspect ghcr.io/stonebridgeway/ai-dev-system:edge      # 3.0, new
docker buildx imagetools inspect ghcr.io/stonebridgeway/ai-dev-system:latest    # 2.x, unchanged
```

## 2. Freezing 2.x as `:2`

Once, after the merge and before the tag: the job copies `:latest`, the 2.x image, to `:2`. It is the
line people go back to (`docs/MIGRATION.md`, "The way back"). It does nothing when `:2` exists, and
refuses once a release of 3.0 or later is tagged, since `:latest` is then 3.x. 2.x has no browser
variant on the registry, so there is no `:2-browser`.

```sh
gh workflow run docker-publish.yml --repo stonebridgeway/ai-dev-system --ref main -f freeze_2x=true
sleep 15
gh run watch --exit-status --repo stonebridgeway/ai-dev-system "$(gh run list --repo stonebridgeway/ai-dev-system \
  --workflow docker-publish.yml --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"
docker buildx imagetools inspect ghcr.io/stonebridgeway/ai-dev-system:2 --format '{{json .Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/stonebridgeway/ai-dev-system:latest --format '{{json .Manifest.Digest}}'
```

The two digests are the same.

## 3. The version and the tag

The packages say 3.0.0 already. What the release adds is its date, committed on production's `main`,
which now holds the merge — in the clone of section 1 `origin` is the fork, so production is named by its
URL:

```sh
PROD=https://github.com/stonebridgeway/ai-dev-system.git
git fetch "$PROD" main && git checkout -B release-3.0.0 FETCH_HEAD
# CHANGELOG.md: "## [3.0.0] - Unreleased" → "## [3.0.0] - <YYYY-MM-DD>", a new empty "## [Unreleased]"
# above it, and at the bottom:
#   [Unreleased]: https://github.com/stonebridgeway/ai-dev-system/compare/v3.0.0...HEAD
#   [3.0.0]: https://github.com/stonebridgeway/ai-dev-system/compare/v2.0.0...v3.0.0
git commit -am "docs(changelog): 3.0.0" && git push "$PROD" HEAD:main
git tag -a v3.0.0 -m "AI Dev System 3.0.0" && git push "$PROD" v3.0.0
```

The tag publishes `:3.0.0`, `:3.0`, `:3`, `:latest` and `:sha-<commit>`, each with `-browser`, and
builds the Windows installer onto a **draft** release `v3.0.0`. A prerelease tag (`v3.0.0-rc.1`)
publishes only its own name and `:sha-<commit>`, and does not move `:latest`.

```sh
docker buildx imagetools inspect ghcr.io/stonebridgeway/ai-dev-system:latest    # now 3.0.0
docker run --rm --entrypoint ai-dev ghcr.io/stonebridgeway/ai-dev-system:3.0.0 version   # ai-dev 3.0.0 (Node 24…)
gh release view v3.0.0 --repo stonebridgeway/ai-dev-system                      # draft, with the .exe
```

## 4. npm

From the tagged checkout, on Node 24:

```sh
git checkout v3.0.0
cd ai-dev-mcp-server && npm ci && npm run dist:pack
npm publish ../dist/ai-dev-system-3.0.0.tgz
npm view ai-dev-system version                                                  # 3.0.0
npx --yes ai-dev-system@3.0.0 version
```

A package with no scope is public as published. The tarball is about 10 MB, 1,830 files.

## 5. The Windows installer

Signing comes from the production repository's secrets and variables (owner decision D7), read by the
job that builds on the tag, `build` ("Build the installer (windows-latest)"):

- a certificate: secrets `WIN_CSC_LINK` (the `.pfx`, base64) and `WIN_CSC_KEY_PASSWORD`;
- or Azure Trusted Signing: variables `AI_DEV_SIGN_AZURE_ENDPOINT`, `AI_DEV_SIGN_AZURE_ACCOUNT`,
  `AI_DEV_SIGN_AZURE_PROFILE`, `AI_DEV_SIGN_PUBLISHER` (the certificate's name, which the updater checks
  every update against) and secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`. With
  `AI_DEV_SIGN_AZURE_ENDPOINT` set, the build stops when any of the other three `AI_DEV_SIGN_*` is missing.

With neither, the installer is built unsigned: it works, and Windows SmartScreen warns. The release stays
a draft: installed apps update only from published releases. Publishing it is what makes it the
download and the update:

```sh
gh release edit v3.0.0 --repo stonebridgeway/ai-dev-system --notes-file docs/release-notes-3.0.0.md --draft=false
```

## 6. After the release

- Take the "before the release" notes out of the guides — the tarball for `npx`, the image built from
  the clone with `--allow-stale-image`, `:latest` as the 2.x image: `README.md`, `README.ru.md`,
  `docs/INSTALL.md`, `docs/ru/INSTALL.md`, `docker/README.md`, `docs/UPGRADE-TEST.md` (and RU),
  `docs/TEST-PLAN.ru.md`, `docs/MIGRATION.md` (and RU) — one pull request after the tag.
- The manual acceptance on three systems (`docs/TEST-PLAN.ru.md`) on the released artefacts.

## Rollback

Each piece goes back on its own:

| What | How | What people see |
|---|---|---|
| The image | `docker buildx imagetools create --tag ghcr.io/stonebridgeway/ai-dev-system:latest ghcr.io/stonebridgeway/ai-dev-system:2` (after `docker login ghcr.io` with a token that can write packages) | a new `bootstrap` or pull gets 2.x again — 3.0's bootstrap writes its entries with `:3`, the 3.x line, which `:latest` no longer is (`AI_DEV_INSTALLER_IMAGE` names another); entries already written name `:latest` and get 2.x on their next pull |
| One person's Docker install | `sh ./bootstrap.sh --image ghcr.io/stonebridgeway/ai-dev-system:2` — it keeps the folders the entries mount (`docs/MIGRATION.md`) | 2.x with 3.0's mounts |
| npm | `npm deprecate ai-dev-system@3.0.0 "<why>"`, then a fixed 3.0.1; unpublishing is for the first 72 hours only and breaks whoever installed it | `npx` warns |
| The installer | `gh release edit v3.0.0 --repo stonebridgeway/ai-dev-system --draft=true` | the updater stops offering it; installed apps stay as they are |
| The source | `git revert -m 1 <merge commit>` on `main`, pushed | the revert brings back 2.x's workflow: the push builds 2.x and publishes it as `:latest`, `:main` and `:sha-<commit>`, as every later push to `main` does; `:edge` stays on 3.0 |

`:latest-browser` came with 3.0 — 2.x has no browser variant — so it has nothing to go back to: leave it,
or delete the tag on the package's page.

## What was run, and where

Everything here ran in the program's sandbox — Linux, Docker 29.8.2, Node 22.22 and 24 — on the branch's
commit `a9a02e9` unless another is named. Nothing was pushed or published.

| Step | What ran | What it printed |
|---|---|---|
| 1 | the clone, `git fetch` of the branch, `git merge --ff-only` | exit 0; the fork's `main` (`096c982`) is an ancestor of the branch |
| 2 | the freeze guard of `docker-publish.yml`, with production's tags and with `v3.0.0-rc.1` | "goes on: no release of 3.0 or later"; with `v3.0.0` tagged — "refuses: v3.0.0 is tagged" |
| 3 | `git fetch "$PROD" main && git checkout -B release-3.0.0 FETCH_HEAD`; the CHANGELOG edit, its commit and the tag on the head the merge brings | exit 0 each (production's `main` is `7bef129` until the merge); the two pushes — not run |
| 4 | `npm run dist:pack`; `npx --yes ai-dev-system@3.0.0 version` in a clean `node:24-bookworm-slim` through a registry that serves that tarball and sends everything else to registry.npmjs.org | `ai-dev-system-3.0.0.tgz`, 10,177,660 bytes, 1,830 files, name `ai-dev-system`; `ai-dev 3.0.0 (Node 24.22.0, linux-x64)`, `npm view` → `3.0.0` |
| — | the README's `npx` path in a clean container: setup, the clients, the first task, the removal | exit 0; Cursor's config restored byte for byte |
| — | the image built from the branch: `ai-dev version`, `docker:smoke`, `docker:upgrade-check` from the 2.x image `2x-8f647df` | `3.0.0`; pass (first session 1,917 ms, next 906 ms); pass |
| — | the README's Docker path: no client, `bootstrap.sh`, the first task, bootstrap again with no folder named and over a 2.x entry (Д-403), the way back to the 2.x image and the return | exit 0 each; the projects folder of the entries kept and named |
| — | `npm run upgrade:test` from production's `8f647df`, the `v2.0.0` tag (`346095d`) and production's `main` (`7bef129`) | 199 of 199 checks each, the way back included |
| — | `npm run check`; `npm run acceptance` | the phase 15 report (`docs/program/reports/phase-15.md`) |

Not run here: anything that pushes or publishes, production's CI, `dense-eval` on the real weights, Windows
and macOS — `docs/TEST-PLAN.ru.md` is the manual acceptance on the released artefacts.
