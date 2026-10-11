# Upgrade test

An install of the 2.x line has to keep working after an upgrade — `git pull`, `docker pull`
or a reinstall — or migrate itself without losing data. `npm run upgrade:test` checks that for
a clone; the container half is described below for CI.

## `npm run upgrade:test`

```bash
cd ai-dev-mcp-server
npm run upgrade:test                 # base: 8f647df, production main when 3.0 started
npm run upgrade:test -- --base <commit> --keep
```

It needs Node 22.16+ (on an older Node the checks of the Node search engine are left out), git,
Python 3 (the 2.x side runs on it, and hybrid search still does) and about two minutes. In a
scratch directory it:

1. checks the base commit out as a git worktree and installs it the way 2.x documented,
   `npm ci --ignore-scripts`;
2. creates the state three users have, each with its own home directory:
   - **default** — no `AI_DEV_HOME`;
   - **AI_DEV_HOME** — set to a folder of its own, where 2.x wrote everything one level too
     deep, into `$AI_DEV_HOME/.ai-dev` (docs/DEFECTS.md, Д-90);
   - **Docker volume layout** — the environment `docker/Dockerfile` sets: `AI_DEV_HOME` under
     the home plus explicit state, index and artifact roots, run without a container;

   and for each: a task with a checkpoint, a decision, an instinct, a session handoff, the
   search index with dense vectors — written by the 2.x helper as its ONNX path writes them,
   from synthetic numbers — Claude hooks in a git repository, and client configurations written
   by both 2.x installers (local and Docker);
3. upgrades the same checkout to the working tree in front of it, as `git pull` would, and runs
   plain `npm ci`;
4. starts the server through the command the 2.x client configuration holds and checks that
   the task, its checkpoint, the decision, the instinct and the handoff are found; that the
   Node search engine reads the 2.x index as it is — a status call rewrites nothing and leaves
   every vector untouched — and sees what the pull changed: skills the pull removed (the
   catalogue curation of 2026-10-11 removed 2,614 connectors) leave the skill registry and are
   no longer found (docs/DEFECTS.md, Д-119); that a rebuild keeps byte for byte every vector whose
   document is still there unchanged and drops those of documents gone or rewritten — among them
   Membrane's connectors, which a 2.x older than the Д-91 fix embedded — leaving the rewritten
   ones to the next embedding run; that keyword and hybrid search answer, that nothing is left in
   `$AI_DEV_HOME/.ai-dev`, and that the 2.x hook still runs — and, where its copy of the old
   path cannot see the migrated task, sees it after `install_agent_hooks`.

Each check prints `✓` or `✗`; the last line is `N of M checks passed`, and any `✗` makes the
exit code 1.

## The container half, for CI

The published 2.x image cannot be pulled from every sandbox, so this half is a scenario. It
needs Docker, access to `ghcr.io` (manifests and layers) and a clone of this repository.

1. **The 2.x image.** `docker pull ghcr.io/stonebridgeway/ai-dev-system:2` once the frozen `:2`
   line exists (owner decision D9). Until then, build it from the base commit:
   ```bash
   git worktree add ../ai-dev-2x 8f647df
   cd ../ai-dev-2x/ai-dev-mcp-server
   npm ci --ignore-scripts
   npm run docker:prepare
   docker build --tag ai-dev-system:2x ../.docker/build-context
   ```
2. **A volume with 2.x data.** `docker volume create ai-dev-upgrade-data`, then run the 2.x image
   the way `docker/run-mcp.sh` does, with the volume at `/data` and a git repository at
   `/workspace`, and send it `initialize`, `begin_task`, `checkpoint_task`, `record_decision`,
   `save_session` and `search_index_status`. Write down the task id, the
   `indexed_document_count`, and the files under `/data/runtime-home/.ai-dev/.ai-dev` — the
   ones 2.x put one level too deep.
3. **2.x client configurations.** Run the 2.x `scripts/install-docker-mcp-clients.mjs --apply`
   into a scratch `HOME`, pointing at the clone's launcher.
4. **The upgrade.** Build the current image the same way from the branch under test (or pull
   `:edge`), and point `AI_DEV_IMAGE` at it.
5. **The checks**, with the new image on the same volume, started through the launcher the 2.x
   client configuration names:
   - the server starts and answers `tools/list`;
   - `get_task` finds the task with its checkpoint; `list_decisions` and `list_sessions` list
     what step 2 recorded;
   - `search_index_status` reports the same `indexed_document_count`, without a rebuild;
   - `system_health_check` reports `runtime_home` as `ok`, and
     `/data/runtime-home/.ai-dev/.ai-dev` holds nothing;
   - on Windows, `bootstrap.ps1` run again rebuilds `ClaudeMcpProxy.exe`, and the proxy mounts
     `AI_DEV_MODEL_PATH` at `/models` (docs/DEFECTS.md, Д-88).
6. **Rolling back.** The 2.x image on the migrated volume still finds the state and the index:
   the image names their roots explicitly, so the migration does not move them. What 2.x put
   one level too deep — Archify artifacts, for example — it no longer sees there.

A clone rolled back to 2.x with `AI_DEV_HOME` set looks one level too deep again and finds
neither the tasks nor the index; nothing is lost, and setting
`AI_DEV_STATE_ROOT=$AI_DEV_HOME/state` and `AI_DEV_SEARCH_INDEX_DIR=$AI_DEV_HOME/cache/search-index`
for 2.x points it back at them. Measured on the trees `npm run upgrade:test -- --keep` leaves:
the 2.x server finds the task and 3,444 indexed documents in the Docker layout as it is, none
in the `AI_DEV_HOME` clone as it is, and both there with the two variables set.

The **Docker volume layout** scenario of `npm run upgrade:test` runs the data half of this —
the server with the image's environment on data 2.x wrote — without Docker.
