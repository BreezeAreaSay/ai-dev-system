# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - Unreleased

A major version because what changed is how AI Dev is installed and how a client reaches it, not
what an agent can do with it. The server is the same — 2.0.0's 133 tools and two new ones,
`plan_security_fixes` and `render_knowledge_galaxy`, 135 in all, plus 13 an app can opt into; the
vault and the task state in the same format; and the index 2.x built is read without a rebuild — but
the clone is no longer the way in, nothing needs Python, and one process serves every AI client. A
2.x install keeps working after the update, except where **Breaking** below says otherwise:
[Moving from 2.x to 3.0](docs/MIGRATION.md) ([Russian](docs/ru/MIGRATION.md)) says what changes for
it, what moves by itself, what needs one command, and how to go back.

**Highlights**

- **Three ways in, none of them a clone.** The Windows installer — one `.exe` for the current user,
  no administrator, no Node, Python or Docker; `npx @stonebridgeway/ai-dev-system setup`, one command
  on any system, which installs a copy that outlives npx's cache; and Docker, where `bootstrap.sh`
  and `bootstrap.ps1` write `docker run` entries and nothing runs between sessions. A clone with
  `npm run setup` stays the way to work on AI Dev itself.
- **No Python.** Search, its SQLite index and hybrid ranking run on `node:sqlite`; the local BGE-M3
  model is an ONNX export on `onnxruntime-node`, installed with progress, resume, a proxy or a
  mirror, and checked file by file against a pinned manifest (`ai-dev model install | import |
  doctor`). Python is left to the two UI UX Pro Max tools, which say what to install without it.
- **One daemon for every client.** Each client's entry hands its session to one warm server, so the
  index and the model are loaded once and the state has one writer: three clients took 528 MB in
  three processes, and take 391 MB.
- **One command line, `ai-dev`** — `setup`, `clients`, `model`, `daemon`, `doctor`, `backup`,
  `restore`, `uninstall` and the 2.x maintenance commands — with one parser, a one-sentence answer
  to every mistake and the same exit codes everywhere, to which `uninstall` adds 3 (something is in
  use) and 4 (the data was kept).
- **A desktop app** in English and Russian: the install's health in the tray, a first-run wizard for
  the projects folder, the AI clients and the model, screens of the work — projects, costs, skills,
  the log — a console for every tool, and settings, all through the daemon's control API.
- **Docker as a server mode.** Each client session is its own container answering its own handshake,
  with the server's instructions — 1.6–2.5 s on a new volume, about a second after it; the model
  goes into the data volume once; the volume's skills follow the seed's manifest; the state is kept
  on the host beside the agent hooks' wherever the container's user can write it there. The image is
  built from the npm distribution, and a `-browser` variant carries Playwright and Chromium.
- **614 skills instead of 3,228.** The Membrane connectors were cut to the 460 a developer reaches
  for; routing (40 of 40) and the search evaluation are unchanged.
- **Upgrades are tested, not assumed.** `npm run upgrade:test` upgrades a 2.x clone in place,
  `npm run docker:upgrade-check` a 2.x volume and its launchers, and CI runs the server with no
  Python on Linux, macOS and Windows.

**Breaking**

- **The server's name in a client is `ai-dev`**, not `ai-dev-system`. Setup and `ai-dev clients
  install` replace the 2.x entry and say so; a 2.x entry keeps working until 4.0.
- **Node 22.16 or newer (or 24+)** for a local install; 2.x took 22.12.
- **The Python dense backend and the Python search helper are removed** (decision D3).
  `npm run setup -- --model` — `npx @stonebridgeway/ai-dev-system setup --model` — moves an install
  to the ONNX model and embeds the documents again; `--dense-python` does the same with a note.
  `AI_DEV_DENSE_BACKEND=python` is read as `auto`, with a note naming that command, and installs
  nothing; the other Python variables are named by the health check and no longer read. An Intel Mac
  has no build of the ONNX runtime: dense search is off there.
- **`AI_DEV_HOME` is the runtime folder itself** (decision D2); a 2.x tree one level down moves up on
  the first start. A `.codex` folder is no longer read: AI Dev's Codex-era folders move into the
  runtime home once — from `~/.codex`, or, with `AI_DEV_HOME` set, from `$AI_DEV_HOME/.codex`, where
  2.x read them for that install.
- **`AI_DEV_MODEL_PATH` names the folder above the models** (Д-62): `~/.ai-dev/models`, holding
  `bge-m3-onnx/`, mounted at `/models`. In 2.0.0 it named the model's own folder, mounted at
  `/models/bge-m3`. The 2.x launchers refuse that value now — `docker/run-mcp.sh` with exit 64,
  `run-mcp.ps1` with an error — and so do both bootstraps and `ai-dev clients install --docker
  --model`, each saying to name the folder above it (Д-68).
- **614 skills.** The 2,614 Membrane connectors the catalogue no longer carries are dropped from the
  registry on the first start, and are found no more.
- **Search.** `AND`, `OR`, `NOT` and `NEAR` are words, not query syntax. `search_knowledge` searches
  what the index holds, so a skill's reference files and notes in folders such as `build` or `.next`
  are no longer found by it.
- **The Docker image** has no Python, no Playwright or Chromium (the `-browser` variant has them), no
  `/opt/ai-dev/search-index`, and no `BGE_M3_ONNX_DIR` or `AI_DEV_DENSE_INSTALLED`; the
  `INSTALL_BGE_M3` build argument installs nothing and says what replaced it (BuildKit's terminal
  view folds a finished step's output, which `--progress=plain` keeps on screen; a step taken from the
  cache prints nothing, so a later build of the same tree shows the notice only with `--no-cache`). On macOS and Linux the projects are mounted
  at their own path rather than at `/workspace`, so what a 2.x server remembered of a project —
  sessions, instincts, decisions — stays under `/workspace/<name>` and the project's memory starts
  afresh. The volume's state — tasks, handoffs — moves to the host's `~/.ai-dev/state` wherever the
  container's user can share that folder; a rollback run by the 2.x launchers keeps its state in the
  volume and does not see what moved. A 3.0 entry has `--network none` written into it and ignores
  `AI_DEV_DOCKER_NETWORK`, which only the 2.x launchers read: change the entry itself. `bootstrap.sh`
  and `bootstrap.ps1` mount the folders they are given — the projects folder, `--project-path`
  (`-ProjectPath`), `~/AI-Dev-Projects` by default, and a model folder, `--model-path` (`-ModelPath`),
  none unless `AI_DEV_MODEL_PATH` is set — not the `AI_DEV_PROJECT_PATH` and `AI_DEV_MODEL_PATH` a
  2.x entry holds: where 2.x mounted a folder of yours, name it again, and run bootstrap again later
  with the same options. They no longer install Docker or Node, start a long-lived container or
  compile a proxy.
- **Image tags** (decision D9): `:latest` moves only with a release tag of the newest line, and no
  longer with 2.x; `:edge` follows `main`; `:2` follows the 2.x line — a manual run copies 2.x's
  `:latest` to it before 3.0 is tagged, and after that only a `v2.*` tag moves it.
- **Agent hooks** 2.x installed keep running where `node` is on the client's `PATH`; run
  `install_agent_hooks` in each repository again for the 3.0 registrations, which find Node without
  it. The hooks it installs turn on two defaults 2.0.0 did not have, under the standard and strict
  profiles: before an install runs, the guard looks the package up in the npm registry and on OSV —
  refusing malware and a release younger than 24 hours — so package names go to api.osv.dev (in
  `.ai-dev/policy.json`, `"supply_chain": { "osv": false }` keeps them from OSV, and
  `"enabled": false` — or `AI_DEV_SUPPLY_CHAIN=off` — turns the check off); and when code or a
  dependency manifest changed after the last `run_security_scan`, the Stop hook sends the agent back
  once to run the security review before the session ends (`"security_review_on_stop"`: `"remind"`
  only tells you, `"off"` says nothing).

What 3.0 keeps working until 4.0 is under **Deprecated**; the [migration note](docs/MIGRATION.md)
has it with what each one says.

### Added

- **Docker: the AI clients run the image themselves** (`docs/DEFECTS.md`, Д-89, Д-105).
  `ai-dev clients install --docker` writes a `docker run -i --rm …` entry into every client found —
  the Docker CLI by its full path, the data volume, the projects folder, the host's state folder
  where it can be shared, a host model folder if named — and `ai-dev clients entry <client>
  --docker` prints one for a client configured by hand. Each session is its own container, and the
  server answers its own handshake: 1,048 characters of instructions, where the 2.x launchers
  answered `initialize` themselves with none. Measured: a new volume answers in 1.6–2.5 s (2.x:
  6.5 s on the image of the program's start, 18.6–21.2 s on production's 2.x image), the next
  session in about a second. `ai-dev clients doctor` starts these entries like any other.
- **The local model through the data volume** (Д-99). `docker run --rm -it --network bridge
  --mount type=volume,source=ai-dev-system-data,target=/data <image> ai-dev model install` puts the
  model in the volume with its progress, resume and sha256 checks, and embeds the documents the
  index holds; every session after it keeps `--network none`. A host folder mounted at `/models`
  still works and is looked at first. Measured with the synthetic model through a local mirror:
  install 4.6 s, 367 documents embedded, then a session without the network searches with it
  (top dense score 0.98). 2.x pinned the model to a host mount and never embedded the documents.
- **A `-browser` variant of the image** (`--target browser`, published as `…-browser`) with
  Playwright and Chromium for Frontend QA; its pnpm is the one `frontend-qa/package.json` names in
  `packageManager`, read at build time, and CI checks they are equal (Д-111).
- **`npm run docker:upgrade-check -- --old-image <2.x> --new-image <image>`**: a 2.x volume and
  the 2.x launchers against the new image — 2.x fills a volume and starts a task, the user edits a
  seed skill and adds one; the new image under the 2.x launcher keeps the task and the edit and
  brings the skills to its seed; the 2.x warm path and the 3.0 wrapper serve sessions; a 3.0
  entry moves the volume's state to the host. `docker-publish.yml` runs it on every pull request
  against production's image (`docs/UPGRADE-TEST.md`).

- **The Windows installer** (`desktop/`, `npm run dist:win`; `docs/DESKTOP.md`, "The Windows
  install"). `AI-Dev-Setup-<version>.exe` installs the desktop app for the current user — no
  administrator, no Node, Python or Docker — with the runtime AI clients run: the npm package's
  distribution with its dependencies for win32-x64 and Node 24.22.0, pinned by version and sha256.
  The runtime leaves out what never loads on Windows x64 — onnxruntime-web (transformers 4.3.0
  carries the web runtime inside its own file), the WebAssembly sharp and what only it needs,
  onnxruntime-node for other systems and processors: 7,847 files, 231 MB unpacked instead of
  512 MB of dependencies alone; the installer is 183 MB. The NSIS installer builds on Linux too,
  under Wine, and on `windows-latest` (`.github/workflows/desktop-windows.yml`); signing comes from
  `WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` or the `AI_DEV_SIGN_AZURE_*` variables with
  `AI_DEV_SIGN_PUBLISHER`, all four or the build stops (Д-303), and an unsigned build works. The
  build reads its `bundle.json` back with the app's own parser and stops when the app's version is
  not the runtime's (Д-306).
- **One path for every AI client, whatever the update.** The app copies the shipped runtime into
  `%USERPROFILE%\.ai-dev\app\<version>-<fingerprint>`, checking each file's sha256, and points the
  junction `%USERPROFILE%\.ai-dev\app\current` at it; client configs name
  `current\node\node.exe` and `current\ai-dev-mcp-server\bin\ai-dev.mjs`. An update copies the
  new runtime beside the old one and moves the junction: no file a running client holds is written
  over, no config changes, and a client started before the update keeps being answered from the
  old copy (`desktop/test/e2e/bundle.test.mjs`). At every start the copy is checked file by file
  and what went missing is put back from the program folder (Д-300). A drive that cannot hold a
  junction — whatever it answers — runs the copy itself, Status says so, and the copy the clients
  name is kept (Д-295, Д-299). An update of the app prunes its own copies only, never one `npx …
  setup` made (Д-301). `current\ai-dev.cmd` is the CLI for a terminal.
- **Updates of the installed app** from the GitHub Releases of `stonebridgeway/ai-dev-system`
  (electron-updater): checked a minute after the start and every six hours, offered in the tray,
  installed at Quit. Chromium's resolver, closed for the app's page since Д-260, resolves only the
  three update hosts by their exact names, and the updater's session lets nothing else through;
  `AI_DEV_DESKTOP_UPDATES=0` turns it off.
- **`ai-dev uninstall [--clients] [--data] --yes`**, which the uninstaller runs after asking its
  two questions — asked unless `/S` is given (Д-296): it stops the daemon, removes the runtime copies
  and their link, the `ai-dev` entries that run this install (another install's stay), and — asked
  separately, No by default — the runtime home, only when what is at its top, and inside its
  `models`, `cache` and `backups` folders, is AI Dev's own (Д-297, Д-307), and not while a runtime
  copy is in use (Д-309). Files an AI client still runs: the uninstaller offers Retry (exit status
  3, Д-302); the data kept: it says so (4).

- **One daemon serves every client** (`docs/DEFECTS.md`, Д-97). `ai-dev mcp` — what each
  client's config runs — hands the client's stdio to the daemon, starting it detached and
  without a window when none runs; the index and the model are in memory once, and the state
  has one writer. The handshake passes through, so the client gets the daemon's own
  `initialize` answer with its instructions. Measured with three clients and the stand-in
  model: 528 MB in three processes, each holding the model, before; 391 MB now (three 70 MB
  bridges and one 183 MB daemon), the model loaded once; 3 × 200 `record_usage` → 600
  records. A `kill -9` of the daemon answers the request it was running with an error that
  says so, and the client's next request starts a new daemon, introduced with the client's own
  `initialize` (840 ms). When no daemon can start, the client is served in its own process and
  stderr says why; `AI_DEV_DAEMON=0` asks for that outright.
- **`ai-dev daemon start | stop | status | run`.** `status` gives the pid, version, sessions
  (live — 2.x always said 0), the clients, memory, address and log
  (`~/.ai-dev/logs/daemon.log`); `stop` is a control request on every system — Windows has no
  signal to send. `npm run daemon` is `ai-dev daemon run`.
- **Progress and cancellation reach the tools** (Д-187). A request's progress token and its
  cancellation go with the call: `rebuild_search_index` reports the text index being written
  and the documents being embedded as one rising count, and a cancelled rebuild rolls its
  write back whole — measured on 6,000 notes, cancelled at 64 of them, the index unchanged.
  Before, a call said 0 of 1 and 1 of 1, and a cancelled rebuild ran to the end.

- **One command line, `ai-dev`** (`ai-dev-mcp-server/bin/ai-dev.mjs`, `src/cli/`): `setup`,
  `clients list | install | remove | doctor`, `model status | install | import | verify | remove
  | doctor`, `mcp`, `doctor`, `version`, `help`, and the 2.x maintenance commands (`dashboard`,
  `galaxy`, `reindex`, `refresh`, `distribution`, `acceptance`, `backup`). One parser
  (`src/core/cli-args.mjs`) gives every command `--flag`, `--no-flag`, `--name=value`, `-y`
  and `--`, and every mistake one sentence that names the command and the nearest real option
  or subcommand; exit codes are 0 done, 1 failed, 2 wrong usage, 130 stopped with Ctrl-C.
  Commands load on demand, so `help`, `version` and a typo neither start the runtime nor
  touch data. From a clone it is `npm run ai-dev -- <command>`, or `ai-dev` after `npm link`;
  `npm run setup`, `doctor`, `clients:install`, `model`, `dense:doctor`, `dashboard`,
  `galaxy`, `refresh`, `backup` and `distribution` are its aliases.
- **`npm run setup` connects the AI clients** (`docs/DEFECTS.md`, Д-95). At a terminal it
  asks: connect the clients found here, download the local model, install Frontend QA;
  `--yes` takes the defaults (clients yes, downloads no), `--clients=<names>`,
  `--no-clients`, `--model` and `--frontend-qa` answer ahead of time, and without a terminal
  or `--yes` no client config is written unless `--clients` names some. Measured in an empty
  home holding six clients' configs with servers of their own: `node bin/ai-dev.mjs setup
  --yes --clients all` builds the four steps, adds `ai-dev` to all six and ends `Health: ok`,
  in 3.8 s.
- **`ai-dev clients install | remove | list | doctor`** (`src/core/mcp-clients.mjs`): the
  `ai-dev` entry in Claude Code (`$CLAUDE_CONFIG_DIR` honoured, as Claude Code does), Claude
  Desktop (with the Microsoft Store build's own config), Cursor, VS Code, Codex (`$CODEX_HOME`
  honoured) and Gemini CLI — this Node by its full
  path, then `bin/ai-dev.mjs mcp`, so a client started from the Dock or the Start menu finds
  it. Files are edited as text (`jsonc-edit.mjs`, `toml-edit.mjs`): other servers, comments
  and formatting stay byte for byte, and a Codex server is found with its subtables and in any
  spelling of its name. Writes go through a temp file and a rename after a re-read, keep the
  previous bytes as `<file>.backup-<time>`, follow a symlinked config or client folder, and
  keep the file's mode — and its owner when run with `sudo`; a comment after a server stays
  with that server; an edited `config.toml` is read again before it is written, and a file
  that is not UTF-8 is refused rather than rewritten. `ai-dev-system`, the 2.x local name, is
  removed and a Docker `ai-dev` replaced, with
  the output saying which; a second run says `No changes`. `remove` gives a file nothing else
  touched back byte for byte (measured on all six) — less any `ai-dev` or `ai-dev-system` entry the
  install replaced, 2.x's, Docker's or another install's, which stays in the install's backup — and
  otherwise cuts out only the entry;
  `doctor` starts each entry's command and checks that it answers `initialize` with
  instructions (six of six, 313–361 ms), naming a command that died by its error line;
  `--timeout=<seconds>` gives each more than 30 s; `--dry-run` shows what would change.

- **The local model is one command, and gets through a broken connection, a proxy and a
  mirror** (`docs/DEFECTS.md`, Д-98; Д-73's missing resume). `npm run model -- install`
  (and `npm run setup -- --model`, which uses it) keeps a broken download as `<file>.part`
  with a `.part.json` naming the revision and sha256 it is the start of; the next run hashes
  those bytes again and asks for the rest with `Range` — measured: a transfer cut at 50 % of
  a file is continued from the byte on disk, every byte crosses the network once and the
  file hashes right (was: the whole file again, 1,572,864 bytes for 1,048,576). Sources are
  `AI_DEV_MODEL_MIRROR`, then `HF_ENDPOINT`, then huggingface.co; one that fails (an HTTP
  error, a reset, a stall, wrong bytes) hands its partial file to the next. Requests read
  `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (names, suffixes, ports, CIDR blocks) without
  `NODE_USE_ENV_PROXY`, tunnel HTTPS with `CONNECT` and take credentials from the proxy
  URL; a refused `CONNECT`, an unresolvable name or an untrusted certificate is a sentence
  with the next step instead of `fetch failed`. Progress — bytes, total, speed, time left —
  is one line in a terminal and a line every few seconds in a log; Ctrl-C stops and keeps
  what arrived.
- **`npm run model -- status | install | import <folder or .zip> | verify | remove`**
  (`src/core/model-manager.mjs`, `scripts/model.mjs`). `import` copies the model from a
  machine that has it — the model folder, any folder above it, a Hugging Face cache (the
  snapshot named for the pinned revision first) or a `.zip` of any of them, plain or ZIP64 —
  checking every file against the manifest on the way in, with no unpacking to a temporary
  folder. `remove` deletes the files the manifest names, their partials and their record, and
  leaves anything else in the folder, saying what it left. Writers share a lock beside the
  model folder. `--dir`, `--mirror`, `--no-index`, `--json`; exit codes 0, 1, 2 and 130.
- **The documents are embedded with progress, and a cancel keeps what was embedded.** A
  rebuild with `dense_embeddings` stores every 64 vectors as it goes
  (`storeDenseVectors`) instead of writing all of them at the end, so Ctrl-C, a crash or a
  closed laptop costs at most 64 documents and the next run starts where this one stopped;
  in-process callers (setup, `npm run model`) get a progress callback and an `AbortSignal`.
  Membrane connectors are left out, as before.
- **A five-kilobyte stand-in for BGE-M3** (`src/core/synthetic-model.mjs`): the pinned
  export's five file names, an XLM-RoBERTa Unigram tokenizer and a 1024-wide ONNX graph,
  written from code. Through it the real worker — transformers.js 4.3.0, onnxruntime-node
  1.30 — loads and embeds in the test suite, and an end-to-end test imports it from a zip,
  embeds a vault and runs a hybrid search through the real MCP server whose winner only the
  dense half can find (Д-101). `AI_DEV_MODEL_MANIFEST` names a manifest other than the
  shipped one, which is how the tests point everything at it.

- **All of search runs in Node, and Python is optional** (`docs/DEFECTS.md`, Д-85, Д-102;
  the Python part of Д-98). The index, its status and keyword search
  (`src/core/search-store.mjs`, `search-query.mjs`, `search-documents.mjs`,
  `search-semantic.mjs`), hybrid search (`search-hybrid.mjs`), `search_knowledge`
  (`search-knowledge.mjs`), the knowledge galaxy's export (`galaxy-export.mjs`) and the
  dense vectors' plan and write run on `node:sqlite` (Node 22.16+, 24+); the Python helper
  `search-index/search_cli.py` is gone. On a machine without Python `npm ci`, `npm run setup`
  (4 built, 0 failed), `npm run doctor` (`ok`, 24 checks) and the protocol smoke pass, and
  all thirteen search tools, `search_knowledge`, `render_knowledge_galaxy`,
  `prepare_project` and `refresh_project_memory` answer; a CI job runs exactly that on
  Linux, macOS and Windows with every interpreter taken off `PATH`
  (`scripts/no-python-check.mjs`). Python is left to `query_ui_ux_knowledge` and
  `generate_ui_ux_design_system`, which run the UI UX Pro Max dataset's own script — without
  it they say what to install, and the health check reports `ui_ux_knowledge` as skipped
  unless the interpreter answers `--version` as Python 3 (a moved path or the Windows Store
  alias is not one). The file stays what the 2.x helper wrote, so a 2.x index,
  dense vectors and all, is read as current without a rebuild, and a 2.x server rolled back
  reads what Node wrote. Measured over MCP: warm `search_all` median 2 ms (was 69), with its
  freshness check 26 ms (was 540); a full rebuild of 3,444 documents 2.6–3.5 s (was
  5.0–5.3); a search right after a note changed 0.23 s (was 6.0: refreshed in place);
  `hybrid_search` without dense 11 ms on the seed and 21 ms on the full 2.x catalogue (was
  141 and 316, one Python process per call); `search_knowledge` 3 and 10 ms (was 233 and
  439, every `.md` read per call); `run_search_eval` on the seed in 0.7 s, scoring what the
  helper scored (was 45 Python processes). `search_knowledge` now searches what the index
  holds — notes, skills as their registry entry and card, project cards — so a skill's other files (its
  references: `read_skill` reads them), the generated all-skills and registry pages, and notes
  in folders such as `build`, `env`, `venv` or `.next` are no longer found by it: 149 of the 515
  files the old scan read on the seed (Д-142). WAL and a cross-process rebuild lock that honours
  `AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT`, refreshed while held so a holder killed mid-rebuild
  frees it within a minute, let several clients share the index; the `node:sqlite`
  ExperimentalWarning is suppressed and no other warning is.
- **`npm run search:parity -- --vault <dir>`** — takes the 2.x helper from git history and
  builds the index with it and with Node, compares the files row by row, runs the golden
  cases of `search-eval/*.json` and 300 document titles through both keyword searches and
  both hybrid searches (answer for answer, then again with synthetic dense vectors), and
  compares the galaxy export byte for byte, explaining every discrepancy. On the public
  seed: the files and the galaxy export are equal; keyword top-k identical in 85 of 85 and
  300 of 300; hybrid answers identical field for field in 385 of 385, and in 85 of 85 with
  dense vectors.

- **`npm run upgrade:test` — a 2.x install upgraded in place** (`docs/UPGRADE-TEST.md`).
  It checks the production 2.x commit out into a git worktree, has the 2.x server
  create what five users have — the defaults, `AI_DEV_HOME` set, the Docker image's
  `/data` layout, the Python dense backend and the Codex runtime — a task with a
  checkpoint, a decision, an instinct, a session handoff, the search index, Claude
  hooks in a repository and client configurations from both 2.x installers, then
  upgrades the checkout to the working tree with plain `npm ci` and starts the server
  through the 2.x client entry. The 2.x index also carries dense vectors (written by
  the 2.x helper from synthetic numbers), which the upgraded server must find current,
  keep byte for byte through a rebuild, and search. For each user `clients install`
  moves both installers' configs to one `ai-dev` entry with a backup, every written
  command answers `initialize`, a second run changes nothing, and the re-installed
  hook runs with no Node on `PATH`. 174 checks; the container half is
  `npm run docker:upgrade-check` (above).

- **The `ar-security-review` skill** (`docker/public-seed/03-skills-catalog/sources/custom/ar-security-review`).
  The workflow the tools above add up to: scan with `run_security_scan`, treat
  malware as an incident first, plan dependency fixes with
  `plan_security_fixes`, apply them only after the user confirms, verify with a
  frozen install, the project's tests and a re-scan, and review the changed
  TypeScript and JavaScript — back end and front end — against an injection,
  authorization, SSRF, XSS and secrets checklist. It is what the Stop hook
  sends the agent back to run. The router gives it a `security-remediation`
  rule for scan-and-patch tasks ("просканируй и залатай", "malware",
  "npm audit") while a code review of authorization stays with
  `code-reviewer`; its description carries Russian triggers, so
  `search_skills("уязвимости зависимостей")` — which found nothing before —
  now finds it first. Quality 100/100; the routing eval is 40 of 40.

- **The guard checks a package before an install runs it** (`hooks/supply-chain.mjs`).
  Malware runs during the install, so a scan afterwards finds a machine that is
  already compromised. Under the standard and strict profiles, an `npm
  install|i|add`, `pnpm add`, `yarn add`, `bun add`, `npx`, `pnpm dlx`, `yarn dlx`
  or `bunx` that names a registry package is looked up first: malware — by
  GitHub's advisories as the registry serves them, or OSV's `MAL-` reports — is
  refused, also for an exact version npm has already unpublished (a mirror may
  still serve it); a release younger than 24 hours is refused with an older
  version to pin; one younger than a week, or with known high or critical
  vulnerabilities, is warned about. Anything that cannot be checked warns and
  never blocks. `supply_chain` in `.ai-dev/policy.json` tunes it; the minimal
  profile keeps the guard offline.
- **Every code change gets a security look without the agent remembering to.**
  An edit to a manifest or lockfile puts a note in the agent's context; and when
  back- or front-end code changed after the last `run_security_scan` — which now
  leaves `.ai-dev/security/last-scan.json` — the Stop hook sends the agent back
  once to run the `ar-security-review` skill (`security_review_on_stop`: `block`,
  `remind` or `off`).

- **`plan_security_fixes`** — a dependency fix plan that changes nothing. It
  runs the package-naming scanners and, for each vulnerable package in each
  lockfile, says what to do — `replace-malware` or `remove-malware`,
  `upgrade-direct`, `update-in-range`, `override`, `no-fix` — to which
  version, with the exact command for the package manager that owns the
  lockfile, and whether the upgrade is breaking (below 1.0.0 a minor counts).
  The target is the first published version outside every advisory's range
  that has been public at least `min_release_age_days` (default 7), read from
  the registry; npm commands carry `--before` so what an upgrade pulls in is
  held to the same quarantine. Whether dependents already accept the fix is
  read from the lockfile — npm, Yarn and Bun record the ranges, pnpm does not,
  and the plan says so. Installs and updates stay behind confirmation: the plan
  is what the user confirms. Run against this server's lockfile from before
  Д-82, it proposes exactly what closed Д-82 by hand — `npm update … --before`
  for `fast-uri`, `hono` and `qs`, an override flagged breaking for `sharp`.

- **Dependency scanning for pnpm, Yarn, Bun and OSV, wherever the lockfile is**
  (`docs/DEFECTS.md`, Д-83). `run_security_scan` had one JavaScript adapter,
  `npm audit`, and ran it only at the repository root: a pnpm, Yarn or Bun
  project, or a repository whose `frontend/` and `backend/` each keep their own
  lockfile, came back `unchecked`. Four adapters join the catalogue —
  `pnpm_audit`, `yarn_audit` (Yarn 1 and Yarn 2+, told apart by
  `packageManager` or `.yarnrc.yml`), `bun_audit` and `osv_scanner` — and the
  package managers' audits run in every directory up to two levels down that
  holds their lockfile. Findings about a package now carry `package`,
  `version`, `vulnerable`, `fixed_in` and `aliases`, and one advisory reported by
  two scanners is one finding, `confirmed_by` the second.

  A new finding kind, `malware`: GitHub's "Malware in …" advisories, which the
  npm registry serves to every package manager's audit, and OSV's `MAL-`
  reports from the OpenSSF malicious-packages feed — 221,947 of them for npm,
  only 28,668 with a GitHub twin. Malware is always critical and always blocks,
  and the next step says remove and rotate, not upgrade.

  A non-zero exit with no findings is believed only when the output is the
  tool's report: Yarn 1 handed Yarn 2+'s command exits 1 — "found something" in
  its bitmask — after printing `Command "npm" not found`, which used to read as
  a clean scan.

- **Knowledge Galaxy** (`render_knowledge_galaxy`, `npm run galaxy`;
  [docs/GALAXY.md](docs/GALAXY.md)). The vault as a 3D galaxy you fly through, in
  place of Obsidian's graph view. Every note and skill is a star beside its
  nearest neighbours in meaning: BGE-M3 vectors where the index has them,
  keyword vectors otherwise. Wikilinks are drawn as warmer lines, and
  communities become coloured, named constellations. A note nobody links to
  lands next to the notes it resembles, not in the outer ring the graph view
  builds out of exactly those notes.

  The result is one self-contained HTML file, `01-system/Knowledge Galaxy.html`.
  It opens from disk, needs only WebGL, and makes no request of any kind: its
  Content-Security-Policy is made of the hashes of its own two inline blocks.
  Navigation follows anvaka's Software Galaxies:
  - WASD, R/F, Q/E and the arrows fly and turn; Shift goes faster; Space is
    steering mode.
  - Search, a card with each star's nearest neighbours, and "Open in Obsidian".
  - The camera is kept in the address, so a view can be bookmarked.
  - Keys are read by physical position, so a Russian layout flies too.
  - The page follows the browser's language, English or Russian.

  `src/core/galaxy-export.mjs` reads what the galaxy is drawn from out of the
  search index, in the shape `src/core/galaxy.mjs` parses. It folds a skill card
  into its skill by the same rule search results use.

  **Re-check after upgrading:**
  - The server now lists 135 tools. The new one is in the `memory` profile.
  - The module line ceiling now covers `src/galaxy/`, the viewer's browser
    modules.

- **Dense search runs without Python** (`docs/DEFECTS.md`, Д-62). The local
  BGE-M3 model runs behind the contract it always had — text in, a normalized
  1024-dimension vector out — on `@huggingface/transformers` over
  `onnxruntime-node`, two pinned npm packages (optional ones, Д-174).
  `npm run setup -- --model` downloads a pinned, checksum-verified ONNX export
  (about 600 MB) and dense search works; there is no virtualenv, no
  `torch==2.14.0+cpu` from the PyTorch index and no 2.3 GB snapshot, and Node
  writes the vectors into the index (Д-85). It is the only backend: the Python
  one is gone (see Removed).

  Inference runs on a `worker_thread`. `onnxruntime-node`'s binding declares
  itself "a simple synchronized inference session object wrap" and its `run()`
  returns outputs rather than a promise, so on the main thread an indexing pass
  would hold the MCP stdio loop for minutes.

- **`npm run dense:doctor`** (Д-62). Six stages in the order they depend on each
  other — Node, the native binding, the manifest, the model files and their
  checksums, the model loading, a trial embedding whose width and norm are
  measured — stopping at the first that fails and naming it in words, with the
  command to run. Never a traceback. Exit code 0 when dense search is ready.

- **`models/bge-m3.manifest.json`** (Д-42, Д-62). The pinned export — model,
  revision, dtype, dimensions, pooling, licence and a sha256 for every file —
  carried over from the `codex/commit-all-20260908` snapshot branch along with
  its downloader. Changing the quantisation is now a field in this file rather
  than a code change. After this, nothing in that branch is missing from `main`.

- **`.github/workflows/dense-eval.yml`** (Д-62). Dispatch-only: downloads the
  pinned ONNX model, builds the index with it, runs the golden cases and publishes
  a table of the results. The weights come from hosts a development sandbox cannot
  reach, so this is where dense search is measured on the real model.

- **Capability profiles.** The 135 tools an agent sees are grouped into eight named
  slices — `core`, `coding`, `memory`, `git`, `frontend`, `qa`, `security`, `advanced` —
  and `AI_DEV_PROFILES` narrows what `tools/list` advertises to the ones a
  session will use. `core` is always on and is added to whatever else is named;
  an unrecognised name is reported on stderr and ignored rather than taken as an
  empty list. `AI_DEV_PROFILES=core` lists 25 tools instead of 135: 22,858 bytes
  of schema in the model's context instead of 139,148.

  Narrowing affects the listing only: `tools/call` still accepts every tool by
  name, so a client that already knows a name keeps working and nothing becomes
  unreachable. **Unset, all eight are on**, unless profiles were chosen in the
  settings (below) — an existing installation behaves exactly as it did before.
  A narrowed server says so on stderr at startup.

  Every tool belongs to exactly one profile, and `render-tool-reference.mjs`
  fails — in CI as well — when a new tool belongs to none, the same way it
  already refuses a tool that belongs to no documentation group. `docs/TOOLS.md`
  now carries a `Profile` column and a profile table.

- **`npm run demo`.** One real task — "add authentication to the API" — run
  against the real server in a throwaway project: compiled context, three routed
  skills, a planted bug, a refused report, a failing quality gate, the fix, a
  passing run, and the pull request text. 2.5–3.1 seconds on a 2.1 GHz Xeon —
  about 4 when it first builds the clone's skill registry — and no MCP client.
  The server's runtime home, state and index are in its temporary folder, and it
  deletes everything it made there; what it may leave is that registry, built
  when it was missing or out of date, with its groups and cards: three folders
  git ignores, `cards/`, `groups/` and `registries/` in
  `docker/public-seed/03-skills-catalog`. `docs/DEMO.md` quotes its output.

- **The model download refuses a disk it does not fit on** (`docs/DEFECTS.md`,
  Д-81). Before the first byte, it asks the sources how big the missing files
  are and compares the total against `statfs`: too little room and it stops
  there, naming what it needs, what there is and how much to free, rather than
  starting an hour of writing that cannot finish. A disk that fits the download
  and little else — the acceptance machine had about 3 GB free and watched its
  write rate fall from roughly 45 MB/min to roughly 1 MB/min — still downloads,
  and says once that the disk is why it may crawl. Until now both looked exactly
  like the stalled CDN of Д-73, which is fixed by the opposite action.

  Also: `ENOSPC` in the middle of a transfer is now a sentence naming the file
  and the directory instead of a stream frame, and a full disk stops the
  download rather than being retried against every mirror in turn. A machine
  whose filesystem will not answer `statfs` is not refused anything — an
  unmeasurable disk has no verdict.

- **The npm package `@stonebridgeway/ai-dev-system`, built by `npm run dist`** (owner
  decision D4; not published — that is the owner's). `scripts/build-dist.mjs` lays out
  `dist/ai-dev/` from `distribution.allowlist.json` — the one list the Docker build context is
  made from too, so the two can no longer drift (measured: 1,797 files, byte for byte the same
  in both) — with the package's `package.json`, the server's lockfile as `npm-shrinkwrap.json`,
  `distribution.json` listing every file's sha256, and the production dependencies;
  `npm run dist:pack` makes the tarball (9.9 MB, 1,800 entries, 25.7 MB unpacked) and checks
  it, unpacked, byte for byte against that list, and `prepack` refuses a folder changed since it
  was built. In a clean `node:24` container with nothing but the tarball,
  `npx --yes ./stonebridgeway-ai-dev-system-<version>.tgz setup --yes` ends `Health: ok` with
  25 checks in 41–57 s, and the server it configured answers MCP with 135 tools.
- **`npx … setup` installs a copy that outlives npx's cache.** Run from npm's `_npx` cache,
  `setup` installs the package into `~/.ai-dev/app/<version>-<fingerprint>` (its files checked
  against `distribution.json`, its dependencies by `npm ci --ignore-scripts` from the npm cache
  npx filled) and goes on from there; client configs name that copy, never the cache, and the
  newest two copies stay.
- **A vault of the user's own for installed packages, kept current by the seed's manifest**
  (`src/core/seed-sync.mjs`). Outside a clone the server writes into `~/.ai-dev/vault`, filled
  from the seed the package ships and brought up to each newer one by sha256: an untouched file
  is replaced, a changed one stays — with the update's version beside it as `<file>.seed-new`
  when both changed, named by `ai-dev doctor` (`vault_seed`) until merged — a deleted one stays
  deleted, one the seed dropped goes unless changed, and an older version never rolls the vault
  back. Two servers starting at once sync it once.
- **`ai-dev backup` and `ai-dev restore`, on every system and in every layout** (Д-104). A
  backup is the vault this install reads plus AI Dev's `state/`, every file with its sha256,
  and a `.sha256` beside the archive; a restore checks both, asks for `--confirm`, writes over
  nothing without `--overwrite` (checked before the first file), and takes a 2.x archive into a
  folder named with `--to`. In 2.x both were PowerShell scripts that worked only inside a full
  vault, and `ai-dev backup` refused every system but Windows.

- **The control API** (`ai-dev-mcp-server/docs/CONTROL-API.md`, version 1.2.0): thirteen tools a
  desktop app — or a script — drives the install with. `system_status` says in one answer whether
  the install is ok, degraded or failed and why: the version, where the data is, the process serving
  it — and whether it is a daemon retired by an update, which a client leaves for the new one — the
  local model, the search index, the clients connected, the settings' problems and the health checks
  it ran, each with what it found and whether it is critical. `setup_run` builds what a fresh
  install lacks and, when asked, the model, its vectors, Frontend QA and the client configs;
  `model_install`, `model_import`, `model_verify` and `model_remove` manage the local model;
  `clients_list`, `clients_install` and `clients_remove` the AI clients; `logs_tail` reads the logs;
  `settings_get` and `settings_set` the settings; `workspace_overview` gives the projects, tasks,
  epics, decisions and cost at a glance. The long ones report progress and stop when the request is
  cancelled, keeping what is done — a download continues from where it stopped. Each answer's schema
  is the tool's `outputSchema`, so an MCP SDK client checks every answer; the document is generated
  from the same module. The tools make up the `control` profile, which only a session that names it
  lists (`AI_DEV_PROFILES=control`, or `all,control`): an agent's surface is the same 135 tools,
  byte for byte. Refused calls change nothing; the two that cannot be taken back want `confirm:
  true`; `SECURITY.md` says what guards the rest.
- **`DaemonClientTransport`** (`src/core/daemon-transport.mjs`): the MCP SDK transport a program uses
  to reach the daemon of an install — it finds or starts the daemon, proves itself with the
  descriptor's secret, and runs the session in the environment it is given, with the settings
  applied as a client's bridge applies them. The control API's integration test is a client built
  on it.
- **Settings in `~/.ai-dev/config.json`**: the capability profiles, the model mirror, the model's
  folder, the daemon's idle time, the projects folder, autostart and the interface's language, each
  checked before it is stored and written whole, flushed and 0600, through a link to wherever the
  file lives; a file that cannot be read is named in the error, a folder in its place too. Every
  `ai-dev` command started afterwards reads them, and so does the desktop app's
  connection; a variable set in the environment still wins, and `settings_get` shows its value.
  `settings_set` says when each change takes effect: the mirror at once, the model folder and the
  profiles for sessions started afterwards, the idle time when the daemon starts next. The default
  profiles cannot hold the opt-in `control`.

- **The desktop app** (`desktop/`, `docs/DESKTOP.md`), on Electron 44.5.1 (pinned), in English and
  Russian. A tray icon in the colour of the install's health — the verdict of every health check,
  the one the Status screen shows, asked again when the daemon's state moves, after anything the app
  changes and every five minutes — with Open, Rebuild the search index, Stop the daemon and Quit; a
  rebuild or a Stop that fails says so in the menu, a Stop for as long as the daemon that would not
  stop runs, with Stop offered again. A first-run wizard: the projects folder; the AI
  clients found on the computer, each with what connecting it would do; the local model downloaded
  with progress and Cancel, imported from a folder or skipped; the search index, with each step's
  outcome in words; what to do next. A download keeps running, with its Cancel, while the person
  looks at another screen, and a step keeps its outcome, with Build again. A Status screen: whether
  the install is ok, degraded or failed and why, every check with its details, the critical ones
  marked, and what to do about each. The app drives the daemon every AI client shares through the
  control API, on the Node the clients run; it starts the daemon when it is not running, or offers a
  Start button when autostart is off; comes back by itself when a client starts it again; moves to
  the new daemon when an update retires the old one, once the calls it has running end there; and
  says in the window what keeps it from starting — the server not found, its packages not installed,
  a broken settings file and what to do with it — in the system's language or the one chosen there,
  with Try again or Restart. The page is a local page and nothing more: served from the app's own
  folder under `app://` in a session of its own, with a policy that allows its own files and nothing
  else, no WebRTC past a proxy and no host name looked up, isolated and sandboxed, with twelve
  functions to the main process: the screens reach only the tools they have a button for, with only
  the arguments they send, and the tool console (next entry) reaches the rest behind a confirmation.
  No menu with Reload or the developer tools; DevTools only with `AI_DEV_DESKTOP_DEVTOOLS=1`, which
  opens them. Tests: unit tests, and Playwright's Electron driver on a real daemon under xvfb; a
  `desktop` CI job runs them.
- **The desktop app's screens of the work, and a console for every tool** (`docs/DESKTOP.md`).
  Projects: the projects AI Dev knows, and a project's card — its tasks with their criteria, its
  epics with how far each has come and the part to work on next, its decisions, the handoffs
  sessions left for the next one, and the project card itself — saying when a list has more than
  it shows. Costs: today, yesterday, the last seven days and everything recorded, by model, by
  tool and by task, for all projects or one. Skills: the catalog by group, a search, and a skill
  to read. Settings: the projects folder, the tool profiles AI clients get, the model's download
  mirror, the model folder, the daemon's idle time and whether the app starts it — each with what
  it does, the value in force and where it comes from, and when a change applies; a value the
  daemon refuses is not written, a change for new sessions reaches the app when it reconnects
  (Reconnect now), and the model's mirror and folder and the profiles are saved only after the
  person confirms the new values in a dialog of the main process (Д-288). Log: the daemon's log
  and the part set aside, with Follow. The tool console lists every tool the daemon gives the
  app's session — what an agent gets, and the control API — builds a form from each tool's input
  schema and shows the answer readable and as JSON; a tool the daemon marks read-only runs at
  once, any other only after the person confirms a dialog the main process shows, every argument
  on a line of its own, as it is, and Cancel the default — the page can open it, not answer it,
  and sends only the arguments the tool's schema names (Д-287). Each screen says when it loads,
  when there is nothing yet and what failed; the screens work from the keyboard (a skip link, a
  visible focus ring, each screen's heading focused), and the colours meet WCAG AA in the light
  and the dark scheme. A screen that only reads asks the daemon for no health checks (Д-286).
  Tests: a Playwright scenario per screen, in English and Russian, the console's Cancel and Run, a
  fresh install's empty screens, a daemon stopped under a screen.
- **`openControlClient`** (`src/core/control-client.mjs`): an MCP SDK client on the daemon of an
  install, for a program that drives it — the desktop app, a script, a test — with the settings,
  the daemon's log, the Node the configured clients run (`clientNodePaths`) and `stopDaemons`
  beside it. `connectDaemon` and `DaemonClientTransport` take the Node the daemon runs on
  (`execPath`), for a caller that is not that Node, and `start: false` to reach only a daemon that
  runs (`ENOTRUNNING` otherwise).
- **`npm run docs:links`** (`ai-dev-mcp-server/scripts/doc-links.mjs`): every relative link and
  `#anchor` in the documentation git tracks must name a tracked file and a heading GitHub would slug
  that way; `-- --external` asks the web links too. CI runs it.
- **A note for moving from 2.x** (`docs/MIGRATION.md`, `docs/ru/MIGRATION.md`): what changes for each
  kind of 2.x install, what moves by itself, the one command each needs, what keeps working until
  4.0, and the way back.

### Changed

- **The Docker image is the distribution** (Д-313). It is built from what `npm run dist` makes,
  checked file by file against its `distribution.json` during the build, with `onnxruntime-node`
  for its own platform only and no build caches in `/data`: 716 MB, where the 2.x image was
  1.84 GB without its browser (node_modules 126 MB instead of 528). The registry, the search index
  and the routing benchmark are built into the image, so a new volume has nothing to build ("0
  built"). Python is no longer in the image: `query_ui_ux_knowledge` and
  `generate_ui_ux_design_system` answer there that they need it, and the health check marks
  `ui_ux_knowledge` skipped. The server lives in `/opt/ai-dev/ai-dev-mcp-server`;
  `/opt/ai-dev/app`, which 2.x configs and volumes name, links to it.
- **The volume's seed is kept current by the seed's manifest**, not 2.x's `cp -n` (Д-99): what
  2.x shipped and 3.0 dropped goes, a seed file the user edited keeps the edit with the update
  beside it as `.seed-new`, the user's own files are not touched. A 2.x volume has no record of
  what its image put there; `data/seed-history.json` — every version of every seed file a commit
  of the 2.x line held — tells those files from the user's (Д-315). Measured on production's 2.x
  image: 3,229 skills in its volume become the new seed's 614 and the user's own one. A rollback to
  `:2` puts them all back with `cp -n`, and its manifest with them; the next 3.0 start finds that
  manifest and removes them again (Д-317). A vault named by `AI_DEV_VAULT_ROOT` other than the
  image's is the user's, read where it is, unless a seed is there already — a sync's record or
  2.x's manifest (Д-321). Three sessions starting at once on one volume build it one at a time,
  the seed sync too, each holder beating every 3 s so a slow machine's start is not taken for
  a dead one and a killed one is let go of within 20 s; a start still waiting 40 s after it
  began serves what is built — a client gives `initialize` 60 s — and one that could not wait
  out the seed sync builds nothing (Д-326, Д-330, Д-336, Д-340). A start that lands in the copy
  Docker makes of the image's data into a new volume for another client's start waits for the
  copy — at most 20 s — before it reads the volume: one of two clients started together built the
  skill registry from 51–437 of 614 skills in 7 rounds of 8, and now none builds anything (Д-355).
  Sessions rebuild the skill
  registry and its taxonomy one at a time, across containers too, and a rebuild's own reads
  never wait for it; the taxonomy reads the registry through its freshness check again (Д-345,
  Д-347, Д-348, Д-356). A session ends when its client closes stdin, once
  what it asked for is answered: the model's worker no longer keeps its container running
  (Д-354). A user's own file named
  `public-seed.manifest.json` stays, and does not make a vault named by `AI_DEV_VAULT_ROOT` a
  seeded one (Д-336, Д-343).
- **The projects are mounted at their own path** on macOS and Linux, so a path the agent names is
  one the server opens (Д-312); on Windows they stay at `/workspace`. **The server and the agent
  hooks keep one state**: the host's `~/.ai-dev/state` is mounted where the container's user,
  uid 1000, is the host's — macOS and Windows through Docker Desktop, Linux once a container of
  the image has written a file there that came out the user's (tried whatever the uid; on a
  rootful Docker that is uid 1000) — and the volume's state moves into it (Д-103, Д-322, Д-334). Elsewhere — another uid, rootless Docker, userns-remap,
  Podman — the server keeps its state in the volume and cannot write into the projects, as in
  2.x, and `ai-dev clients install --docker` says so (Д-318). On Windows the folder is shared
  but only its usage ledger is common: tasks and the hooks' handoffs are kept by project, and
  the server sees `/workspace/<name>`, the hooks `C:\…\<name>` (Д-324, Д-333);
  and what a 2.x server remembered of a project under `/workspace/<name>` stays there. git in the image trusts the mounted projects
  whoever owns them, which 2.x refused as "dubious ownership" and so gave a project the wrong
  identity (Д-311).
- **`bootstrap.sh` and `bootstrap.ps1` check Docker, pull the image, check the server's own
  handshake and write the configs** — and nothing else. They no longer install Docker or Node,
  start a long-lived container, or compile a proxy; `bootstrap.sh` runs the config installer in
  the image with only the clients' config folders and the state folder mounted (2.x mounted the
  whole home), writes Claude Code's entry through `claude mcp add-json`, and then removes the 2.x
  runtime container. With `--image` of a 2.x image — the way back — an image of 3.0 writes the
  configs that run it: `AI_DEV_INSTALLER_IMAGE`, pulled and seen to have the installer (Д-323,
  Д-329). A config that is a link into dotfiles is written through it, each folder it leads to
  mounted where the link spells it; a link into the home itself, above it or the root is not
  followed, and a folder Docker will not mount costs that client alone — every client's folders
  are looked at in one run first, and a look that fails while Docker runs nothing at all blames
  no folder (Д-352, Д-358, Д-360); one client that cannot be
  written does not stop the others — the exit is 1 and the 2.x container stays — and `--clients`
  that names none is refused (Д-335, Д-336, Д-338, Д-339). Each script's last line says what it did
  with the configs: "Restart the AI clients to load ai-dev." after writing them; with no client
  installed it writes none and says so — `bootstrap.sh` with "No AI client found here (…). Name one
  to write its config anyway, --clients cursor,vscode,…, or install one and run bootstrap.sh
  again.", `bootstrap.ps1` with the same line in its own terms, `-Clients cursor,vscode,…` and
  `run bootstrap.ps1 again` — and ends "no AI client is connected to it yet"; with
  `--skip-client-install` (`-SkipClientInstall`) it ends "the AI clients' configs were left as they
  were" (Д-406, Д-415). `bootstrap.ps1` runs under Windows PowerShell 5.1 with the image's stderr
  thrown away safely (Д-320).
- **The image's tags** (owner decision D9, Д-108): a push to `main` is `:edge`; a release tag
  `vX.Y.Z` is `:X.Y.Z`, `:X.Y`, `:X` and `:latest`, a prerelease only its own name; the browser
  variant has the same tags with `-browser`. A manual run with `freeze_2x` copies the current
  `:latest` to `:2` once, and refuses once a 3.x release is tagged (a prerelease does not count);
  a 2.x tag after 3.0, on a commit that carries this workflow, updates `:2`, never `:latest`
  (Д-325, Д-336).
- **Hints the image gives are commands for the host**: `docker run --rm -it … <image> ai-dev …`
  into the volume, with the network only for a download; Frontend QA in the default image points
  at the `-browser` variant instead of an install that cannot run in a client's container, and
  the start report says the same instead of setup's `--model` and `--frontend-qa` (Д-316, Д-328).
  The report checks the model, the vectors and the browser as `setup` does, so a volume with
  the model says it has it (Д-332); a check that cannot be made is said and never stops the
  start, and a model mounted from the host is embedded with `ai-dev setup --model`, not
  downloaded again (Д-337, Д-341); the server reads that model too, which it had stopped
  doing with the image's `BGE_M3_ONNX_DIR` (Д-346); one it cannot read — its files or its
  folders — or that is not whole, is said as that, not as an error or a model to install, by
  the sessions, `setup`, `model status` and the control API alike (its `model.unreadable`,
  contract 1.2.0), with the advice its error calls for, and the vectors it made before are said
  as kept (Д-349, Д-350, Д-357 … Д-359, Д-361, Д-363 … Д-366, Д-369 … Д-371). The desktop app's
  first-run wizard and Status screen read that field too: they say why the model cannot be read
  and what to do, and offer no download over it (Д-367).
- **Trying the shared state folder** tells a container that could not write it from a Docker that
  did not run the image — an engine that does not answer, an image not here, which the probe no
  longer pulls: then nothing was tried, and the install says to run it again once Docker runs
  the image (Д-331); `bootstrap.sh`, which decides it, says why once, with a step its user has
  (Д-342, Д-344). `ai-dev clients entry --docker` tries it as `install` does, and
  `install --dry-run` says it did not (Д-334). `ai-dev clients remove` finds the record a Docker
  install wrote with `AI_DEV_STATE_ROOT` set (Д-336).
- **`npm run check` runs `npm run packaging:check`**, red since phase 7 without a gate to see it
  (Д-314).

- **The daemon's channel is this user's** (`docs/DEFECTS.md`, Д-107). Each start draws a
  random socket or pipe name (96 bits) and publishes it, with a 256-bit secret, only in
  `run/daemon-<build>.json` (mode 0600); each side's first line proves it holds the secret with an
  HMAC bound to both nonces, without sending it. A Unix socket is created under umask 077 in a
  0700 directory of the user — a link, another uid's directory or one that cannot hold a socket
  is passed over. The Windows pipe was `\\.\pipe\ai-dev-<user>`, a name anyone could create
  first. Measured with a second local user: the socket answers EACCES, and with the
  directories and socket opened to everyone the handshake is still refused.
- **Each daemon session lists the tools of its client's own `AI_DEV_PROFILES`**; the bridge
  prints the same note on stderr as the stdio server.
- **Each daemon session runs in its own client's environment** (`docs/DEFECTS.md`, Д-190). The
  bridge sends the client's environment once the daemon has proven itself, and the daemon runs
  that session's tools, processes and downloads in it — a terminal's PATH with gitleaks, a
  proxy, its own `NODE_EXTRA_CA_CERTS` — as the client's own process did in 2.x. Measured: a
  client whose PATH has gitleaks and semgrep, served by a daemon a GUI app with a short PATH
  started, saw 3 of 10 scanners; now 5 of 10, as in its own process.
- **A daemon serves one build, and builds no longer replace each other** (Д-191, Д-199). The
  build is the code, its version, the Node it runs on and where the data is — the home, runtime
  home, vault, state, index and model folder, resolved as the server resolves them, so
  `C:\Vault` and `c:\vault`, a trailing slash, or Git Bash's `HOME` beside a GUI client's
  `USERPROFILE` are one build; PATH, proxies, certificates, profiles and the hooks' switches
  are the session's.
  Each build has its own descriptor and lock, `run/daemon-<build>.json`: clients of another
  vault or another copy of AI Dev get a daemon of their own instead of retiring the running
  one. The daemon of code replaced where it lies — a `git pull` — retires, finishes its
  sessions and is listed in `run/retired-<pid>.json` until it exits. `ai-dev daemon status`
  lists every daemon of the runtime home and, by variable name, why it is another; `stop`
  stops them all. Measured with sessions alternating between a client that passes its whole
  environment and one that passes a short list: 1, 2, 3, 4 daemons before; 1, 1, 1, 1 now with
  the same vault, and one daemon per vault when they differ.

- **Hooks run through a Node launcher on macOS and Linux** (`docs/DEFECTS.md`, Д-103, the
  phase-6 half). `install_agent_hooks` registers `/bin/sh .ai-dev/hooks/with-node.sh
  <script>`, and the git hook stubs go through it too: it takes `AI_DEV_NODE`, then the Node
  the hooks were installed with on this machine (`.ai-dev/hooks/.node-path`, git-ignored),
  then `node` on `PATH`, then the usual install locations, and needs no other command; an
  `AI_DEV_NODE` that is not a Node executable is named and passed over, and `.gitattributes`
  keeps the launcher and the stubs LF in a clone with `core.autocrlf`.
  Measured with a `PATH` that holds git and nothing else: 0 of 9 registered commands ran
  before (`node: not found`), 9 of 9 now. Windows keeps `node`. Hooks 2.x installed keep
  working where `node` is on the client's `PATH`; `agent_hooks_status` counts them
  (`bare_node_commands`), and running `install_agent_hooks` again rewrites them.
- **The setup flag for the local model is `--model`**; `--dense`, and 2.x's `--dense-python`,
  still work as its names, and every hint that said `npm run setup -- --dense` says `--model`.

- **The bundled skill catalogue keeps the skills for coding and for working with
  models, and nothing else.** Membrane's 3,074 application connectors are cut to the
  460 for developer tools and AI models: code hosting, CI/CD, cloud and hosting,
  databases, monitoring and incidents, testing, security, application auth, APIs,
  feature flags, issue trackers for software teams, model APIs, vector databases and
  ML platforms. Payments, CRM, marketing, e-commerce, HR, scheduling, forms, chat,
  consumer apps and the rest are gone; the rule and the list are in
  `docker/public-seed/03-skills-catalog/sources/external/membrane/CURATION.md`. The
  other 154 skills all stay. Measured over MCP on the seed: 614 skills instead of
  3,228; 825 index documents instead of 3,444, rebuilt in 0.84 s instead of 2.8 s,
  the index file 7.6 MB instead of 25.3 MB; the skill registry built in 1.4 s instead
  of 3.8 s; the seed 1,575 files and 21.9 MB instead of 4,188 and 40.4 MB. The
  routing benchmark (40/40) and the search eval (37 of 45, MRR 0.510) are unchanged;
  a task that names Stripe or HubSpot no longer pulls their connectors in.

- **Node.js 22.16 or newer (or 24+) is required** — `engines` is
  `^22.16.0 || >=24.0.0`, the CI floor job runs 22.16, `dense:doctor` names 22.16.
  `node:sqlite` is unflagged from 22.13, but measured on the release builds its SQLite
  has no FTS5 in 22.13–22.15 and 23.x, and the index is an FTS5 table. On such a
  Node the server starts, every search tool answers with the Node version it needs, and
  `prepare_project` and `refresh_project_memory` do their work and report the index as
  skipped. `.nvmrc` stays `22`, which nvm resolves to the newest 22.x. Upgrading from a 2.x older than the Д-91 fix: the first rebuild drops
  the vectors 2.x had embedded for Membrane's connectors, as Д-91 intends, and keeps
  every other one.

- **`AI_DEV_HOME` is the runtime folder itself, and a 2.x tree moves there**
  (`docs/DEFECTS.md`, Д-90; owner decision D2). The documentation and the
  Dockerfile always meant it that way; the code appended `.ai-dev`, so
  `AI_DEV_HOME=/x/.ai-dev` put everything in `/x/.ai-dev/.ai-dev`. The server,
  `npm run setup` and the `ai-dev` CLI now move such a tree up when they start —
  missing files are moved, identical ones dropped, JSONL ledgers appended, and a
  file that differs on the two sides stays where it was — and `npm run doctor`
  reports it in a new `runtime_home` check. `AI_DEV_HOME` set to the home
  directory itself keeps its 2.x meaning, `~/.ai-dev`. The hooks carry the same
  rule.

  **Re-check after upgrading:** if you set `AI_DEV_HOME`, run `npm run doctor`
  once and look at `runtime_home`; run `install_agent_hooks` again in the
  repositories where you installed hooks.

- **`npm ci` and `npm install` need no flag** (Д-86). The server's `.npmrc`
  turns dependency install scripts off — onnxruntime-node's downloaded a CUDA
  provider the server never loads and failed offline or behind a proxy — so the
  guides say plain `npm ci`, CI runs it, and `npm run packaging:check` fails if
  the setting goes. The Dockerfile keeps `--ignore-scripts`: its build context
  has no `.npmrc`.

- **The lockfile is regenerated with npm 11.17.0** (Д-87): no duplicate keys,
  one onnxruntime-node (1.30.0), and no `sharp` override — `npm ls sharp` shows
  the 0.35.4 it pinned without it.

- **`npm run setup -- --frontend-qa` installs the lockfile and Chromium, and
  passes only when the browser launches** (Д-93). The pnpm the runner pins
  installs exactly `pnpm-lock.yaml` (fetched through `npm exec`; no pnpm on the
  PATH needed), Playwright installs its own Chromium build, and the step is
  checked the way `doctor` checks it. It used to run whichever package manager
  was there — `npm install` ignored the lockfile — and report ✓ with no browser.

- **CI runs plain `npm ci`, and only the production repository publishes
  images.** A fork that works in its own `main` no longer builds and pushes an
  image of its own from every push.

- **Dense vectors record where they came from** (Д-62). Every vector in the
  index now carries its backend, revision and dtype alongside the model name,
  and a cached vector is reused only when all of them still match. An int8 ONNX
  vector and an fp32 torch vector for one sentence differ far more than two
  sentences do, and keying the cache on the model name alone meant switching
  backends silently mixed two vector spaces in one ranking. An index written
  before this cannot say what produced it, so it is re-embedded once.

- **One model mount point for the container** (Д-62). `AI_DEV_MODEL_PATH` is now
  the folder *above* the models — `~/.ai-dev/models` — bound at `/models`, with
  `bge-m3-onnx/` under it, instead of one model's directory bound at
  `/models/bge-m3`. The client entries `ai-dev clients install --docker --model`
  writes, both bootstraps' `--model-path`, the 2.x launchers, the Compose example
  and both INSTALL guides say the same thing. **Existing setups must update the
  variable**: a value that names the model's own folder is refused with
  directions (Д-68).

- **The README leads with what the system is for.** It had grown to 871 lines and
  opened with a release summary and an inventory; a reader could not tell in the
  first minute which problem the project solves. It is now about 200 lines: the problem,
  one task end to end, install, a first task, the eight profiles, how it works,
  and links. The reference material it carried moved, unchanged, into `docs/` —
  `INSTALL.md`, `WORKFLOW.md`, `GUARDRAILS.md`, `CAPABILITIES.md`, `DEMO.md` —
  with `README.ru.md` and `docs/ru/` mirroring it. Nothing was deleted; the two
  READMEs and the ten documents behind them cover what the two READMEs did,
  the local-first install path and the local model in a container included.

- **The server finds its content through one layout module** (`src/core/install-layout.mjs`):
  a full vault, a clone, an installed package or the Docker image, with no `09-mcp`
  assumption; `AI_DEV_VAULT_ROOT` still names a full vault.
- **Hints name commands the way this install runs them**: `npm run setup -- --model` from a
  clone, `ai-dev setup --model` from a global install, `npx @stonebridgeway/ai-dev-system setup
  --model` from npx; when the model runtime is missing, the way back for the install at hand
  instead of "run npm ci".
- **The local model's packages are optional dependencies** (Д-174). `@huggingface/transformers`
  and `onnxruntime-node` are `optionalDependencies`, still pinned exactly (the security gate now
  checks optional dependencies too): an install whose onnxruntime-node postinstall cannot fetch
  its CUDA provider goes on, without dense search, and says how to get it.

- **The dashboard's runtime rows are the health checks as they ran** (`docs/DEFECTS.md`, Д-106):
  eight rows that said Ready whatever was true — the static, coverage and security gates, Archify,
  the context compiler, outcome analytics, the reference factory, search ranking — are gone; each
  check is a row with its verdict and evidence, and the page says when they ran. Before setup,
  `ai-dev dashboard` says to run `ai-dev setup` instead of naming the file it could not open.
- **A search index belongs to the vault it was built from** (Д-195, Д-219, Д-229). The first vault
  keeps the index file a runtime home has always had, named by a claim beside it; any other vault
  gets its own file, so two vaults on one runtime home no longer answer with each other's notes. An
  index written before the claim goes only to the vault it was built from: at least half of the
  notes it is checked by are the very files it indexed, untouched since, or every one of them is
  there with the same content, as after a clone into the same folder. A command run first from a
  shell with a vault that holds only some of them — a copy of the seed, a note copied over — does
  not take it, or its vectors, from the clients; a copy of the whole vault cannot be told from it,
  and takes it only by starting first.
- **The tool reference counts 148 tools**: the 135 an agent sees and the 13 of the control API.
  A narrowed session's stderr note counts the opt-in tools apart.
- **A stopped `ai-dev setup` reports no failures** (Д-223): the step Ctrl-C cut short and the ones
  after it are skipped, and none of them is announced.

- **`npm run check` covers the desktop app**: the static gate checks the syntax of `desktop/`'s
  code, refuses `eval`, `new Function`, `shell: true` and `child_process.exec` in it (its tests may
  call `eval` and `new Function`) and holds its code to the 800-line ceiling; the security gate
  looks for keys in it and holds its
  dependencies to exact versions with an integrity hash in its lockfile.
- **The install guides follow the three paths.** `README.md`, `README.ru.md` and `docs/INSTALL.md`
  (with `docs/ru/INSTALL.md`) start from the Windows installer, `npx @stonebridgeway/ai-dev-system`
  and Docker, then a clone for working on AI Dev; what 3.0 removed is gone from them, and the 2.x
  ways are in the migration note (Д-376). The guides to guardrails, capabilities, the demo, the
  galaxy, recovery and security, the server's README and the architecture describe 3.0 (Д-377), and
  `AGENTS.md` and `CONTRIBUTING.md` name where the code lives now — `bin/`, `src/cli/`, `desktop/`,
  the distribution — and how branches flow (Д-378).
- **One manual acceptance plan** (`docs/TEST-PLAN.ru.md`): three systems, about 40 minutes each,
  along the paths a person takes; it replaces the four plans written for 2.1.0 and `RETEST.ru.md`.

### Deprecated

- **`docker/run-mcp.sh`, `docker/run-mcp.ps1` and `ClaudeMcpProxy.exe`**, the 2.x Docker
  launchers (owner decision D10). Configs that name them keep working until 4.0. The 3.0 scripts
  run the image and pass the server's own handshake through — they no longer answer `initialize`
  themselves — and say on stderr what replaced them. An installed `ClaudeMcpProxy.exe` is the one
  2.x compiled: it keeps answering `initialize` itself, without the server's instructions or a
  warning, until `bootstrap.ps1` rewrites Claude's config to `docker run`; `docker/ClaudeMcpProxy.cs`
  is a byte pipe now, for whoever builds it (Д-327).

- **`node scripts/ai-dev.mjs`, `scripts/start-local.ps1` and
  `scripts/install-local-mcp-clients.mjs`** are `ai-dev`, `ai-dev mcp` and
  `ai-dev clients install` now. Each still works, with a note on stderr, and goes in 4.0;
  `install-local-mcp-clients.mjs` keeps its flags: a dry run without `--apply`, the
  four clients 2.x wrote (Cursor, Gemini, VS Code, Claude Code) unless `--clients` names
  others, and `claude` for Claude Code alone; its JSON is `clients install --json`'s.
  `scripts/first-run.mjs`, `scripts/model.mjs` and `scripts/dense-doctor.mjs` run the same
  commands as before.
- **The server name `ai-dev-system`** in client configs. 2.x entries that use it keep
  working; `npm run clients:install` (or `npm run setup`) replaces them with `ai-dev`.

- **`scripts/backup-ai-dev-system.ps1`, `restore-ai-dev-system.ps1`, `restore-runtime.ps1` and
  `run-acceptance.ps1`** are wrappers until 4.0, each with a note on stderr, over `ai-dev
  backup`, `ai-dev restore`, `npm ci` plus `ai-dev setup --frontend-qa`, and `npm run check`.
  None of them, nor `start-local.ps1`, looks for the Codex desktop runtime's Node or npm any
  more: `node` from PATH, or `AI_DEV_NODE`.

### Removed

- **`scripts/install-docker-mcp-clients.mjs`**: `ai-dev clients install --docker` writes the
  clients' Docker entries. **The long-lived runtime container** `ai-dev-system-runtime-<uid>`
  and the launchers' `docker exec` path into it, and **the compilation of the Windows proxy** by
  bootstrap, with the handshake of its source (see Deprecated). **Installing Docker from
  bootstrap**: `bootstrap.sh --install-prerequisites` is accepted and only says that bootstrap no
  longer installs Docker, and where to get it (Д-92). **Python 3, Playwright and Chromium in
  the default image** (Chromium is in `-browser`), and `BGE_M3_ONNX_DIR` in its environment,
  which hid a model installed into the volume.

- **The Python dense backend** (decision D3; `docs/DEFECTS.md`, Д-62, Д-98): `embeddings/`
  (`bge_m3_embed.py`, `bge_m3_worker.py`, `requirements-bge-m3.txt`), the worker pool in
  `src/core/embedding-workers.mjs`, the image's `INSTALL_BGE_M3` stack, its
  `AI_DEV_DENSE_INSTALLED` and `BGE_M3_MODEL_DIR`, `python3-venv`, the Python job of
  `dense-eval.yml` (the int8-against-fp32 comparison stays on the 2.x line) and the pip entry
  in Dependabot. Nothing is silently ignored: `AI_DEV_DENSE_BACKEND=python`, `BGE_M3_PYTHON`,
  `AI_DEV_EMBEDDINGS_PYTHON`, `AI_DEV_PYTHON_BASE`, `BGE_M3_PYTHON_REVISION`,
  `BGE_M3_MODEL_DIR` and a `models/bge-m3` folder of torch weights are each named by the
  health check, `npm run setup` and `dense:doctor`, with the one command that moves an
  install over: `npm run setup -- --model`. It installs the ONNX model and embeds the
  documents again; the Python vectors are another model's, so hybrid search no longer
  compares them with ONNX questions, and this run replaces them while the rest of the index
  stays. `--dense-python` still works as a name for `--model`, with a note. A Docker build
  with `--build-arg INSTALL_BGE_M3=1` still builds, and prints that the argument is no longer
  used and what replaced it: the model put into the data volume once with
  `docker run … <image> ai-dev model install`, or a host folder holding `bge-m3-onnx/`
  mounted at `/models` (`bootstrap.sh --model-path`). The argument stays declared for that until
  4.0 (Д-375). BuildKit's terminal view folds a finished step's output, which `--progress=plain`
  keeps on screen; a step taken from the cache prints nothing, so a later build of the same tree
  shows the notice only with `--no-cache`.
- **The Python search helper** — `search-index/search_cli.py`, its `unittest` suite
  (`test_search_freshness.py`, now `src/core/search-freshness.test.mjs`) and
  `npm run test:search-helper` — and with them the Docker image's
  `/opt/ai-dev/search-index` and its link in the `/data` volume, which nothing reads any
  more. A 2.x volume keeps a dangling `09-mcp/search-index` link, which the index skips.
  `scripts/run-acceptance.ps1` no longer runs Python tests.

- **`~/.codex` is no longer read** (`docs/DEFECTS.md`, Д-104, Д-389). 2.x used
  `.codex/state/ai-dev-system`, its index, models and artifacts in its home — `AI_DEV_HOME` when
  that was set, otherwise the user's — whenever they existed and the `.ai-dev` ones did not, while
  the hooks always wrote to `.ai-dev/state`: the server and the hooks kept two histories. What AI
  Dev kept there moves into the runtime home once, on the first start, from the `.codex` 2.x read
  for that install: `~/.codex`, or `$AI_DEV_HOME/.codex` with `AI_DEV_HOME` set, so one install
  never takes another's; an `AI_DEV_HOME` naming `~/.ai-dev` itself, as a 3.0 setting may, takes
  `~/.codex` when its own `.codex` holds none of AI Dev's folders (Д-394). Nothing is overwritten,
  identical files are dropped, ledgers merged, conflicts named by `ai-dev doctor`, and the start's
  log names the folder it moved from; a record goes into `state/runtime-home-migration.json`. The
  rest of `.codex` is Codex's own and stays.
- **The Homebrew formula and the AUR package** (`packaging/`; decision D8). Neither was ever
  published, and the formula still pointed at `v1.0.0`. `npm run packaging:check` now checks what
  the install guides and the bootstrap scripts promise each other.

### Fixed

- **The daemon died on a long home** (Д-97). A socket path over 107 bytes was cut short by
  libuv, the next `chmod` failed and the lock stayed behind; a home of 181 bytes — or any home
  below this session's 87-byte scratch folder — never started a daemon. The socket now moves
  to `$XDG_RUNTIME_DIR/ai-dev` or `/tmp/ai-dev-<uid>` when the path, counted in bytes, would
  pass 100; a 196-byte home serves three clients.
- **A hook in a package of a monorepo keyed its memory to the repository** (Д-164). It went up
  to the Git root before looking for a project boundary, so in `<repo>/apps/web` the hook and
  the server named different projects; the hook now takes the nearest boundary from its own
  directory, as the server does.

- **`node scripts/ai-dev.mjs start` served nothing, and a typo moved data**
  (`docs/DEFECTS.md`, Д-161). `start` imported a server that runs only when started directly
  and exited 0 after 292 ms with nothing on stdout; it now serves MCP (the `initialize` answer
  carries 1,048 characters of instructions). An unknown command migrated `AI_DEV_HOME` and
  loaded the whole runtime before printing the help; it now answers in about 50 ms with exit
  2 and touches nothing.
- **The Docker client installer stopped halfway and could break Codex's config** (Д-162). An
  empty `mcp.json` or a comment in Gemini's `settings.json` ended the run with a stack trace,
  some clients written and some not; a `[mcp_servers.ai-dev.env]` subtable or a quoted
  `[mcp_servers."ai-dev"]` header left a second definition, and a TOML reader then refused
  the whole file. `ai-dev clients install --docker`, which replaces it, writes the empty and the
  JSONC file (the comment kept), fails a broken file only for its own client, and leaves a Codex
  file that parses.
- **An interrupted client install could leave `~/.claude.json` empty** (Д-163). Both
  installers rewrote the file in place; killed during the write, a 21 MB `~/.claude.json`
  was left at 0 bytes in 10 of 10 runs. Writes go through a temp file and a rename now — 0 of
  20 torn — with a re-read before the rename, so a client saving the file at the same moment
  keeps its change; a temp file a killed run left behind is removed on the next run.
- **Re-running `install_agent_hooks` dropped hooks a person had added next to ours** (Д-165).
  A registration group holding one AI Dev command was replaced whole, and with it any hook the
  person had put in the same group — Claude Code's `/hooks` adds a hook for an event without a
  matcher to the group already there. Only the AI Dev commands are taken out now; the group
  stays with the rest. The re-install is the step that moves 2.x hooks to the Node launcher.
- **A skill rewritten while the skill registry was being rebuilt could stay unseen**
  (`docs/DEFECTS.md`, Д-135, Д-160). The registry is dated by when its sources were read,
  and the clock that stamps files lags the process's own by up to a tick (a second on
  HFS+, two on FAT): a skill a `git pull` rewrote just after that moment was stamped
  earlier and missed in 284 of 300 runs. The registry is now dated two seconds earlier
  still, at the cost of one extra rebuild at most, and a change stamped in the current
  millisecond no longer reads as one from the future — 0 of 300 for both.
- **The supply-chain hook and the fix-version lookup ignored `HTTPS_PROXY`** (Д-145).
  Behind a proxy every lookup failed with `fetch failed`: the hook warned "not fully
  checked" on every install and `run_security_scan` offered no fix versions. Both now go
  through the proxy — the hook through its own copy of the server's client
  (`hooks/http-proxy.mjs`) — including the POSTs to the advisory endpoint and OSV, and ask
  for compressed answers as `fetch` did (Д-167): typescript's registry document is 2.0 MB
  gzipped and 15.8 MB plain, and the hook has three seconds for it.

- **`setup -- --dense` no longer embeds after the download failed, and its advice is
  true** (Д-98). The vector step needs the model step and is skipped, with that said, when
  the download failed — it used to fail again and advise the command that had just failed.
  `dense:doctor` no longer offers `AI_DEV_DENSE_BACKEND=python`; for a missing model it
  names the download, the mirror and proxy variables and `npm run model -- import`; for a
  download that stopped partway, that it continues; for files that do not match, that the
  download replaces them.
- **An Intel Mac is told the model cannot run there** (Д-101). onnxruntime-node 1.30 ships
  no `darwin-x64` build; `dense:doctor` said `Cannot find module '…/darwin/x64/
  onnxruntime_binding.node'` with a require stack and advised `npm rebuild`, which cannot
  build it. Now the runtime stage, the health check and `embedding_status` say so in a
  sentence, `setup -- --dense` refuses before downloading 600 MB that cannot load, and
  `npm run model -- install` still fetches the files, for a container to mount.
- **The server no longer hashes the model every minute** (Д-143). Whether the model is
  installed was answered by hashing all five files — about 570 MB, 1.0–1.1 s on a fast disk —
  on the first hybrid search and again every minute of use. A check that hashes a file right
  now leaves a record (size, times, inode) in the runtime cache, and an unchanged file is not
  read again; `npm run model -- verify` and `dense:doctor` still hash everything.
- **`validate_skill_library` with semantic duplicates uses the installed model** (Д-144).
  It went to the Python worker pool whatever backend was selected, and its failure took the
  whole quality report down; now it embeds through the same model as search, and without one
  the pairs keep their lexical verdict and the report says why.
- **Why dense search cannot run is said for what was found** (Д-146). `embedding_status`,
  `embed_texts` and a dense rebuild said "the model is not on this machine" also when all
  its files were there and one was not the pinned file, or when a download had stopped
  partway. They now name the files that differ and the command that fetches them again, the
  download that continues, or the files a folder lacks; "not on this machine" is kept for a
  folder with none of them.
- **The health check advises a dense smoke only where the model runs** (Д-147). Taking that
  advice on a machine without the optional model turned a healthy install into "fail" with
  "did not return dense-scored results"; a dense smoke asked for there still fails, with the
  reason and the command.
- **A download no source could serve names the ways round it.** Behind a proxy that refuses
  huggingface.co, `setup -- --dense` said exactly that and stopped; the error now adds
  `AI_DEV_MODEL_MIRROR`, `HTTPS_PROXY` and `npm run model -- import`.
- **A 2.x index the Python backend embedded is re-embedded by `setup -- --dense`** (Д-148).
  It counted as fully embedded, so the step the migration notes point to was skipped, and
  hybrid search — which compares only its own model's vectors — silently ran without its
  dense half. The index status now counts vectors per model (`dense_other_model_documents`
  for another model's, which wait); the step runs; a hybrid search with no vector of its
  model says so; the freshness check warns.
- **The model download cannot hang in its size probe** (Д-149): a source or proxy that takes
  the connection and never answers costs one stall window, and is asked last afterwards.
- **A disk that will not take the model is said as that** (Д-150): quota, read-only, rights
  or I/O errors no longer read "the connection closed", and a short write is finished
  before the next chunk.
- **Proxy and mirror passwords stay out of messages, `--json` and `.part.json`** (Д-151). A
  proxy that answers 407 is told apart: one that wants NTLM or Kerberos is pointed at a local
  forwarding proxy (cntlm, px), and one that refused the password in the proxy URL says so.
- **Through a proxy, an IP-literal source's certificate is checked against that address**
  (Д-152), not against the proxy's name.
- **`npm run model -- remove` acts only on a folder it recognises as the model's** (Д-153);
  a lock it cannot create says why (Д-154); zips written with `\` between folders import
  (Д-155); `install` and `import` exit 1 when the model is not whole (Д-156).
- **The Docker launchers no longer take `bge-m3/` for a model** (Д-158): `run-mcp.sh`,
  `run-mcp.ps1` and `ClaudeMcpProxy` recognise `bge-m3-onnx/` only and name a lone `bge-m3/`
  as the removed Python backend's weights, and both bootstraps look for `bge-m3-onnx/` only.
  After Ctrl-C, `setup` says it stopped instead of running the health check and calling it a
  failure.

- **Writers of the search index no longer wait each other out or stop the server**
  (`docs/DEFECTS.md`, Д-120 … Д-122, found by the review of the Node index). A rebuild lock
  left by a process that died — a container killed mid-refresh on a shared volume — held
  every other refresh for half an hour; now the holder refreshes the lock every 10 s, one not
  refreshed for a minute is abandoned whatever host it names, and a process exiting on a
  signal removes its locks (a dead container's lock: 13 ms, was a timeout). A foreign writer
  froze the event loop inside `busy_timeout` and then failed the refresh (now 0.56 s with the loop turning, was 10.0 s and "database is locked"); the
  checkpoint after a full rewrite waited out any reader on an old snapshot (39 ms, was
  10.1 s).
- **Windows: a damaged index is replaced even while another client has it open, and
  junction folders are indexed** (Д-123, Д-124 — written to the documentation of Node and
  Windows, not yet run on Windows). Setting a damaged file aside is retried for a few
  seconds, every reader closes the file after 5 s idle and on finding it damaged, and the
  walk enters a linked folder once per real path, as `os.walk` enters a junction.
- **The status cache trusts a file only when its ctime is old too** (Д-125), and five
  smaller divergences from the Python helper are gone (Д-126): a document rewritten in
  place keeps its rowid, so tied results keep their order; a leading BOM survives; exact
  ties of large numbers round as Python rounds them (0 of 200,000 random ties differ, were
  3,100); `dense:doctor` no longer passes Node 23; the Д-117 test for `NOT` tests something.
- **A pull that removes skills takes them out of routing and search** (`docs/DEFECTS.md`,
  Д-119). The generated skill registry never counted as out of date: after `git pull`,
  `npm ci` and `npm run setup` — the documented update — setup answered "already built",
  and the skills the pull deleted went on being recommended (`recommend_skills` named
  `stripe` for a payments task), found, and indexed from the registry (3,444 documents
  where the pulled catalogue has 825). The server now compares the registry with the
  `SKILL.md` files and the folders above them and rebuilds it before reading it, and the
  search index asks for that before its status and rebuild; setup rebuilds an out-of-date
  registry and everything built from it; a subgroup that lost its skills loses its
  generated note. `npm run upgrade:test` checks it.

- **A damaged search index no longer stops search for good** (docs/DEFECTS.md, Д-116).
  A file that is not a database was the answer to every `status` and `rebuild`
  until someone deleted it; it is now reported (`index_unreadable`), set aside as
  `<index>.corrupt` and rebuilt.
- **Two project cards for one repository no longer break the index** (Д-114): the
  rebuild died on the documents' primary key, and with it every search. One document
  per id is kept.
- **One unreadable `.md` no longer aborts the index** (Д-115): a broken symlink, or a
  folder named `*.md` among the project cards, ended `rebuild` and `status` alike.
- **AND, OR, NOT and NEAR in capitals are words in keyword and hybrid search** (Д-117):
  "frontend AND backend testing" was an FTS5 syntax error, found nothing by keyword, and
  left hybrid search ranking by its semantic half alone (keyword score 0 for all ten
  results; now 7 of 10 score on keywords).
- **`embed_texts` embeds through the ONNX model search uses** (Д-133). It always
  called the legacy Python worker pool, so with the ONNX model installed and no legacy
  virtualenv it refused with "BGE-M3 Python runtime not found"; with no model at all it
  now answers with the command that installs one, as hybrid search and the rebuild do.
- **Dense vectors asked for with no model that can run are refused, not attempted with
  an interpreter that is not there** (the Python part of Д-98). `rebuild_search_index`
  with `dense_embeddings` handed the write to `embeddings/.venv/bin/python` whenever the
  ONNX export was missing — "spawn …/.venv/bin/python ENOENT"; it now answers "Dense
  search is not installed: the model is not on this machine. Run
  `npm run setup -- --model` …" and leaves the index as it was.
- **What the second review of the Node index found is fixed** (`docs/DEFECTS.md`, Д-127 … Д-132).
  A refresh that both changed a note and added one fell back to rewriting the whole index (7 of
  8 trials; 731 ms instead of 60 ms on the seed) — changed documents now go back to their rowids
  before new ones are appended. The skill registry is dated by when its sources were read, so a
  skill changed or removed while it is rebuilt is seen by the next look, and a rebuild that could
  not put it right is retried after 30 s, 1, 2, 5 and 10 min instead of never. A failed `close()`
  in the rebuild lock's heartbeat no longer ends the process (EIO, exit 1); a lock is forgotten
  only once its file is gone, so an exit during its release no longer leaves it behind. On
  Windows a junction to a folder of the vault no longer takes that folder's notes away (both
  paths are indexed, as `os.walk` indexes them). After a pull that changed skills, `npm run setup`
  reports the dense vectors the index holds instead of "not installed". Smaller: the index reader
  lets go of the file after a failed read too, `ensure-skill-index` rebuilds an out-of-date
  registry before the tests start, the NUL rule leaves extensionless programs alone, and
  `pythonRound(x, 0)` rounds 1e15 ≤ |x| < 2^52 as Python does.
- **No NUL bytes in the bundled skill texts** (Д-113). Upstream's Membrane `confluent`
  skill carries 150 NUL bytes where its one-line description should be, and
  `read_skill` passed all 150 to the agent; they are dropped, and nothing else in the
  file differs from upstream. The distribution audit — `docker:seed:verify`, the seed
  refresh, the Docker context and skill import — now rejects a NUL byte in any text
  file. `docker:seed:verify` runs that audit over the committed seed (it used to check
  only the manifest), and `--write` no longer refuses in a checkout that has rendered
  the galaxy or written project cards: generated output is neither in the manifest nor
  in the image.

- **Claude on Windows with Docker gets dense search** (Д-88). `ClaudeMcpProxy.cs`
  mounted the model folder at `/models/bge-m3`, one level below where the image
  looks. `bootstrap.ps1` now writes Claude's entry as a `docker run` that mounts a
  named model folder at `/models`, as every client's entry does; the proxy's source,
  kept for whoever builds it, mounts `/models` too and refuses 2.0.0's value of
  `AI_DEV_MODEL_PATH`, and a contract test holds every copy to the folder the server
  looks in. **Re-check after upgrading:** run `bootstrap.ps1` again so Claude's config
  runs `docker run`; the `ClaudeMcpProxy.exe` 2.x compiled keeps the old mount.

- **Membrane connectors stay out of unrelated results in the bundled seed too**
  (Д-91). The filters tested the vault's path, and the seed keeps the catalogue
  elsewhere: all 3,074 connectors were embedded and ranked like any skill. Now
  decided by source: dense eligibility 370 of 3,444 instead of 3,444, and no
  connectors in the top ten for "add authentication to the API" (seven before);
  integration queries still get them.

- **One Python interpreter choice for the server and the client installer**
  (Д-94). The installer wrote `AI_DEV_PYTHON=python3` into every client on
  Windows, where Python answers to `python`. **Re-check after upgrading:** on
  Windows, run `npm run clients:install` once more.

- **Concurrent writers no longer lose records** (Д-96). Three processes
  appending 200 records each kept 208–223 of 600; JSON stores updated by
  read-modify-write kept 202–222. A cross-process lock file — with stale-lock
  recovery for a killed writer, in the server and in the hooks' copy — makes it
  600 of 600 in ten runs out of ten, and `kill -9` mid-run leaves no broken line.

- **The documentation says what a measurement says** (`docs/DEFECTS.md`, Д-100).
  - Clients are connected with `npm run clients:install`, which README and
    INSTALL never mentioned, instead of editing JSON by hand (on Windows it
    needed `AI_DEV_PYTHON=python` until Д-94 was fixed).
  - Schema sizes are the bytes of the `tools/list` result, with the command that
    measures them: 22,858 for `core`, 32,737 for `core,git`, 139,148 for all 135
    tools. The pages said 15, 23 and 98 KB, and the README promised about 15 KB
    for `core,git`, the figure for `core` alone (Д-82).
  - The README counts 9 tools in `security` and 614 skills.
  - The server README no longer documents `AI_DEV_RUNTIME_CONFIG`, which nothing
    reads, and describes `--dense` as the ONNX export it is, not a 2.3 GB Python
    install.

  **Re-check after upgrading:** nothing to do. The defect registry now carries
  Д-85 … Д-108 and Д-110, each with a measurement or, where this sandbox cannot
  run it, a file and line.

- **The Stop hook saw every changed file but the first** (Д-84). The hooks'
  `git()` trims its output, so ` M src/api.ts` on the first line of `git status
  --porcelain` arrived as `M src/api.ts`, and cutting three characters off it
  read `rc/api.ts` — a file that does not exist, skipped by every end-of-response
  check. The status column is now read by pattern.

Nine of these came from the acceptance runs of 2026-09-15/16 on three real
machines — macOS 15.2 on Apple Silicon, Windows 11 Pro x64, Arch Linux — and
four of those arrived as upstream issues #63–#66.

- **A fresh macOS builds its search index.** `pythonCommand()` fell back to bare
  `python`, which modern macOS does not have; a clean install ended at
  `spawn python ENOENT`, `npm run setup` reported a failed step and
  `npm run doctor` said `fail` on a machine where nothing was wrong. It is
  `python3` off Windows now, the same choice `install-local-mcp-clients.mjs`
  already made (Д-72), and the index itself needs no Python any more (Д-85).

- **A stalled download is given up on, and an abandoned one is swept.** `fetch`
  has no timeout of its own: on Windows a CDN sent 510 MB of 542 and then went
  silent, and the install sat there past ten minutes. A 60-second stall window,
  re-armed by every chunk, now ends it with a sentence saying what happened — a
  slow link is not cut off, only a silent one. Separately, a `.part` file left
  by a killed process was invisible to later runs, because its name carries the
  dead process's pid; those older than an hour are now swept before a download
  starts (Д-73).
- **One empty `mcp.json` no longer blocks every client.** A zero-byte file — the
  one VS Code ships — threw `Unexpected end of JSON input`, and because the
  install loop had no guard, all four clients were left untouched. Empty now
  reads as empty, a failure is reported against the client it belongs to, and
  the rest are installed. The editor's configuration tree is also resolved per
  platform: `--apply` on macOS used to create `~/AppData/Roaming/Code/User/`
  and write where VS Code would never look (Д-74).
- **The first run says how many documents it indexed**, instead of
  `? document(s) indexed` — it read three key names, none of which was the
  `document_count` the rebuild actually returns (Д-75, upstream #63).
- **A pull request is named after the code, not the bookkeeping.** `.ai-dev/` is
  rewritten on nearly every task and outvoted the change itself, producing
  `feat(ai-dev): …`. Housekeeping is dropped before the vote — adding it to the
  generic-directory list, as upstream proposed, was measured and does not work
  (Д-76, upstream #64).
- **`npm run doctor -- --dense-smoke`** exists, so the health check's own
  recommendation can be taken from the command that prints it (Д-77, #66).
- **A failed setup no longer ends with `Health: ok`.** That check describes the
  vault, not the run that just failed, and it was the last line the reader saw
  (Д-78).
- **A Docker client is told the real version**, not `1.0.0`: the 2.x launchers
  answered `initialize` themselves with a version of their own, and the server
  answers its own handshake now; a contract test holds every launcher to
  answering none itself (Д-79, #65).
- **The `--dense` step describes what it downloads** — about 600 MB of
  checksum-verified ONNX weights, no Python — rather than the legacy stack's
  Python environment and 2.3 GB (Д-80).

- **`dense-eval`'s `max_cases` input reaches the measurement.** The workflow offered a
  case count per backend and nothing passed it on: `dense-benchmark.mjs` read only
  `--out` and `--label` and called `run_search_eval` with a literal 50, so a dispatch
  asking for 20 scored all 45 golden cases and said nothing about it. The workflow now hands
  the input to the benchmark, the report records the count it was given, and a dispatch
  that names no count still scores the default (Д-62). The same report's index size was
  always absent — it read `document_count`, which `search_index_status` does not have —
  and now carries the real number.
- **The launchers recognise the 2.0.0 value of `AI_DEV_MODEL_PATH`.** The variable
  now names the folder above the models; a folder that holds model files itself was
  mounted one level too deep and dense search reported "not set up" to a user who had
  followed the previous instructions. `docker/run-mcp.sh` and `run-mcp.ps1` stop with
  directions instead, and a folder with no model in it yet is a warning, not a refusal
  (Д-68).
- **The default Docker install can reach the model weights at all.** The fast-start
  runtime never mounted `/models`, and the client configurations never carried
  `AI_DEV_MODEL_PATH`, so on the path `bootstrap.sh` sets up the weights had nowhere to
  go. `bootstrap.sh --model-path` / `bootstrap.ps1 -ModelPath` (default:
  `AI_DEV_MODEL_PATH`) put the folder, read-only at `/models`, into every client's
  `docker run` entry; `--plan` gains `model_path` only when one was given (Д-69).
- **A correct fresh install passes its own health check.** A new volume came up
  `degraded` for two reasons that had nothing to do with the install. The skill
  quality report is written only by `validate_skill_library` with
  `write_report`, and neither `npm run setup` nor the container entrypoint ever
  called it, so every install answered its own diagnostic with `skill_quality:
  report missing`; and an empty project registry warned, on a machine where
  there cannot be a project yet. The report is now a required first-run step,
  shared by both entry points and idempotent — a report at least as new as the
  registry is left alone — and it runs before the search index, because it
  writes a dashboard note into the vault and building it afterwards left the
  index stale. An empty registry is `ok` and names `bootstrap_project`. A fresh
  emulated image now reports `ok`, 18 checks ok and none warning, where it
  reported `degraded` with two warnings before (Д-63).

- **`cargo` on the PATH is no longer mistaken for `cargo audit`.** The health
  check read scanner availability off the executable each scanner names, and
  `cargo_audit` names `cargo` — which is Rust's package manager, while `cargo
  audit` is a plugin installed separately. Every machine with Rust was told it
  had the scanner: "2 of 6 security scanners installed: npm_audit, cargo_audit"
  on a machine where `cargo audit --version` answers `error: no such command`.
  A scanner that is a subcommand of another tool now declares a probe, and
  availability comes from running it — argv array, `shell: false`, ten seconds.
  The report names the gap it found, so having cargo without cargo-audit reads
  as the different fix it is (Д-64).

- **The installer leaves no smoke-check directory in `/tmp`.** The fast-start
  smoke waited on a launcher that could hang for as long as the user let it, and
  its directory was removed by an explicit `rm -rf` in each branch that left.
  Terminated anywhere between the `mktemp -d` and one of those — a closed
  terminal, a `kill` — `bootstrap.sh` left an `ai-dev-smoke.*` directory in
  `/tmp`. The smoke check now sends the handshake to the image through
  `docker run` and creates no directory, in either bootstrap. `--plan` and the
  69/70 exit codes are unchanged (Д-65).

- **The README links the taste-skill repository that exists.** Both READMEs
  pointed at `tt-a1i/taste-skill`, which `git ls-remote` does not find;
  `THIRD_PARTY_NOTICES.md` has recorded `Leonxlnx/taste-skill` as the source
  since the import. A test now requires every GitHub repository a README links
  to be one the notices file records as a source, and both READMEs to credit the
  same set (Д-66).

- **The quality gate says when it ran on a Node the project did not ask for.**
  In the container the gate's commands run on the image's Node. The report named
  that Node and nothing compared it with the project's `engines.node`, so a
  project pinned to 20 running under 22 got the "passes on my machine, fails in
  the gate" pair with nothing on the record to explain it. `run_quality_gate`
  now answers in `runtime.engines`, adding `runtime.engines_mismatch` when the
  declared range refuses the running version, and `verify_task` carries it in
  the check's detail — including on a check that passed, since a warning visible
  only after something else failed is not a warning. The range parser is its own
  and deliberately partial: it reads `20`, `^20`, `~20.1`, `>=20`, `20.x`,
  `18 || 20` and `>=18 <21`, and answers "not read" for everything else rather
  than inventing a warning out of a misparse. It never blocks (Д-67).

- **One `package.json` in the home directory no longer merges every project
  below it.** The project-boundary walk ran to the root of the filesystem and
  stopped at the first marker it found, so a leftover `package.json` in `~` —
  or a dotfiles clone's `.git` — made every project under the home directory
  share one memory key, and the session handoffs, instincts and context of one
  project were served to an agent working in another without any sign of it.
  A marker sitting in the home directory itself, or anywhere above it, is no
  longer a boundary; a session that starts there keys to where it started.
  Below the home directory and outside it (`/srv/app`, `C:\work\app`) nothing
  changes, including nested packages, worktrees and the runtime directory rule.
  The home comes from `USERPROFILE` on Windows and `HOME` elsewhere, is compared
  case-insensitively on Windows and through its real path everywhere, and where
  neither variable is set the rule does not apply at all. The rule is one pure
  function taking the platform and the home as parameters, present in the server
  and in the hooks copy that ships into other repositories, with both copies
  answering the same fourteen layouts in the tests (Д-48).

- **A fresh clone finishes its install instead of failing the smoke check.**
  `bootstrap.sh`, `docker/run-mcp.sh` and `docker/entrypoint.sh` were committed
  as `100644`, and the fast-start smoke check executed the launcher directly:
  `Permission denied`, reported as "Fast-start MCP stdio smoke check failed",
  exit 70, with the smoke check blameless. The three files now carry the execute
  bit, and the smoke check runs no file of the clone — it sends the handshake to
  the image through `docker run` — so a zip download of the repository, which
  always drops the bit, installs too (Д-58, upstream #51).

- **A failed `docker pull` no longer installs whatever was in the cache.**
  Bootstrap printed one line to stderr and carried on with the stale local
  image; since the fast-start container ran with `--restart unless-stopped`,
  that copy then survived reboots, and users who asked for `latest` reported
  defects already fixed. It now stops with exit 69 and prints when the cached
  copy was created and its digest. `--allow-stale-image` (`-AllowStaleImage` on
  Windows) installs it anyway, repeating the warning at the end of the run so
  the choice stays visible. A locally built image, which has no `RepoDigests`,
  reports the digest as absent instead of aborting (Д-60, upstream #53).

- **A fresh container no longer fails its own health check** (upstream #50). The
  entrypoint built the skill registry and stopped; `npm run setup` also built
  the search index and the routing benchmark. So a container started with
  neither, four critical checks failed, every search tool answered with a
  refusal until somebody called `rebuild_search_index` by hand, and the first
  thing a new user saw on a correct install was `Health: fail`. Both paths now
  run the same required steps from the same module
  (`scripts/first-run-steps.mjs`), idempotently and without the network, and the
  image is built with them done, so a new volume builds nothing (see Changed). The
  container writes its dashboard note before the index rather than after it,
  which had left the index stale the moment the entrypoint finished. Measured
  on an emulated volume: `fail` with 5 failing checks before, none failing after,
  and `ok` once Д-63 (above) was fixed too.

  Two of the notes the check expects were genuinely absent from the image and
  one could never be there. A volume seeded from `docker/public-seed` is now
  told apart from a hand-made Obsidian vault by the `PUBLIC_SEED.md` the seed
  carries, so the vault's entry page is `not-applicable` rather than missing;
  the repository README, `ai-dev-mcp-server/README.md` and
  `docs/ARCHITECTURE.md` are shipped in the image, which is where the check
  looks for the other three.

- **Missing BGE-M3 weights are no longer a critical failure, and the advice
  now fits where it is read** (upstream #52, Д-157). The search index was one of
  the embedding backend's requirements, so on a fresh container one missing
  artefact was counted as two critical failures and the soft "dense is not set
  up" tipped into `fail`. The index has its own critical check and the backend
  no longer claims it; a model that is not there is `skipped`. Inside a
  container the health check gives the command that installs the model into
  the data volume, or the mount (`AI_DEV_MODEL_PATH`), instead of sending it to
  a `npm run setup -- --dense` it cannot run.

- **Frontend QA works inside the `-browser` image, and a runner that cannot
  start says so** (upstream #49). The QA runner imports two server modules by
  the relative path they have in a checkout; in the 2.x image the server was at
  `/opt/ai-dev/app` and that path resolved nowhere, so the runner died on its
  first import — with Playwright and Chromium installed and unreachable. The
  server now lives at `/opt/ai-dev/ai-dev-mcp-server`, beside the runner as in
  a checkout, and the browser is in the `-browser` variant (see Changed).
  The probe behind the health check took the first line of the failure, which
  for a module-resolution error is the frame Node threw from
  (`node:internal/modules/esm/resolve:275`) and never the reason; it now reads
  the reason out of the whole output and tells a dependency nobody installed
  (still optional, still `skipped`) from a file this install does not carry
  (`fail`, naming the file). The context audit checks that every module the
  distribution imports is in it, so an import the allowlist drops is caught
  before an image is built rather than after it is published.
  `docker-smoke.mjs` runs `system_health_check` inside the built image and fails
  on a failing check, or on a `-browser` runner that did not start.

- **The runtime distribution manifest describes the platform it is on, not
  Windows.** `prepare_runtime_distribution` expected a PowerShell launcher and
  three PowerShell scripts wherever it ran, so on macOS, Linux and in the
  published Docker image it was rejected outright and
  `runtime_distribution_status` answered `prepared: false, ready_local: false`
  with those files listed as "missing" — a report about its own layout rather
  than about the installation. The container bootstrap called it on every start
  and was refused every time, so `09-mcp/runtime-distribution.json` never
  appeared. The manifest is now built for one of three runtime flavors —
  `windows` (unchanged), `posix` (`npm start`, `node scripts/acceptance.mjs`)
  and `docker` (`sh docker/run-mcp.sh`, and the `/data` volume as the backup
  unit) — and a file the flavor cannot have is reported as not applicable with a
  reason instead of missing, so readiness counts only what applies. The rendered
  `Runtime Distribution.md` no longer names PowerShell where there is none.
  `scripts/ai-dev.mjs acceptance` runs the cross-platform runner that
  `npm run acceptance` already used instead of `powershell.exe`. Measured on
  Linux and against an emulated image: `prepared=false ready_local=false` with
  three missing files in a checkout and four in the image, now
  `prepared=true ready_local=true missing_files=[]` in both. Upstream #54,
  `docs/DEFECTS.md` Д-61.

- **A failed quality gate now says why, not only that it failed.** A project
  whose `npm test` is `node --test test/` fails on Node 21 and later for a
  reason that has nothing to do with the project: positional arguments became
  glob patterns, the directory matches itself, and the runner executes it as a
  test file. The gate passed that failure through correctly and `verify_task`
  reduced it to `quality_gate: failed`, leaving the cause in a command's stdout
  that no reader of the verdict ever saw. `run_quality_gate` now reports the
  Node that ran the commands (`runtime.node`, `runtime.exec_path`) — on the
  Docker path that is the image's Node, currently 24, not the caller's — and a
  failed command carries a `hint` when the cause is one the gate recognizes.
  Every check in a verification that did not come back good now carries a
  `detail` with the first meaningful line of its output and that hint. The gate
  still runs the project's commands exactly as written and rewrites nothing.
  (upstream #47, docs/DEFECTS.md Д-54)

- **A security scan that ran nothing is `unchecked`, not `pass`.** With none of
  the six scanners installed — which is every run of the published image, since
  it shipped with none and the container has `--network none` — the scan
  returned `pass` with `checked: 0`, and `verify_task` reduced that to
  `security_scan: pass`. "Nothing was found" and "nobody looked" are different
  claims, and the second was being reported as the first. The verdict for a run
  in which no scanner ran is now `unchecked`; it still cannot block a
  verification, and `verify_task` no longer drops the `next_step` that says no
  scanner could run. The image now carries `gitleaks` — the only one of the six
  that works with no network — pinned by digest for amd64 and arm64, and
  `system_health_check` gained a non-critical `security_scanners` check that
  warns when the machine has none of them. `docker/README.md` carries the matrix
  of what can actually run under `--network none`, and both INSTALL guides point
  to it.
  (upstream #48, docs/DEFECTS.md Д-55)

- **`npx` from the package's tarball failed on Linux x64, silently** (Д-174). onnxruntime-node's
  postinstall fetches a 236 MB CUDA provider the server never loads; where api.nuget.org is out
  of reach the install exited 1 after 17 s with nothing printed. Now: exit 0, `Health: ok`, the
  model runtime installed in the app home without the download, and the server answers MCP.
- **`npm pack` dropped a file of the seed, and an installed package's vault was never filled**
  (Д-175). npm leaves `.gitignore`, `.npmrc` and a few other names out of every tarball; the
  seed had one, and the vault sync stopped on it with 128 of 1,575 files missing and no record,
  again at every start. The seed no longer carries it, a seed refresh skips such names, the
  build refuses them and checks the tarball against its list, and a sync goes on past a file a
  package lacks.
- **`AI_DEV_HOME` did not reach the client configs** (Д-176): a client started from the Dock
  looked for the index, the state and a package's vault in `~/.ai-dev` while setup had built
  them in `$AI_DEV_HOME`. The entry carries it now.

- **The phase 7 review's findings** (`docs/DEFECTS.md`, Д-177 … Д-185), each reproduced
  before the fix:
  - with `AI_DEV_VAULT_ROOT` set, a package npx ran wrote client configs pointing into npx's
    cache and named clone-only commands (Д-177): the install kind no longer follows that
    variable;
  - `ai-dev restore --overwrite` stopped halfway on a bad entry and left old and new files
    mixed (Д-178): every file is unpacked and checked first, replaced files are set aside and
    put back if anything fails;
  - a backup missed the state `AI_DEV_STATE_ROOT` moves (Д-179); a file dated after 2107
    ended every backup, and an archive of exactly 65,535 entries could not be read back
    (Д-180); file modes were lost on restore (Д-185);
  - the app-home prune could remove the copy setup had just chosen again (Д-181);
  - a seed rename by case only deleted the file on Windows and macOS (Д-182), and an update
    wrote through a folder the user had linked into the vault (Д-185);
  - a Codex-era search index or half a download was a conflict for `doctor` to report
    forever (Д-183): such caches are dropped when `~/.ai-dev` has its own;
  - after Д-176 a client started from the Dock ran its server with `AI_DEV_HOME` and its
    hooks without it (Д-184): `install_agent_hooks` records the folder beside the hooks
    (`.ai-dev/hooks/.ai-dev-home`, kept out of git);
  - smaller ones (Д-185): the server's runtime root with `HOME` unset, a hex-only app folder
    name, npm's full list of names it leaves out of a tarball, a build that stops on a seed
    file differing from its manifest, hints inside the image, `ai-dev distribution` in a
    package, the Frontend QA tests back in `run-acceptance.ps1`.

- **The phase 8 review's findings** (`docs/DEFECTS.md`, Д-188 … Д-194), each reproduced before
  the fix:
  - the bridge decoded each 64 KB read on its own, so a character cut by a read's edge became
    two U+FFFD — a Russian note of 390 KB came back with 18 of them, on disk too (Д-188): lines
    are decoded whole, and an 8 MB line takes 23 ms instead of 338 ms;
  - the Д-164 change left hooks in a monorepo package without the workspace's policy, secret
    check, config guard, formatter and stop checks (Д-189): only the memory keys and the active
    task follow the package;
  - the daemon ran every client's tools with the PATH of the client that started it (Д-190), and
    clients that differed in PATH or proxy replaced each other's daemon, one per session, none of
    the old ones visible (Д-191) — see "Changed";
  - requests piped in with the input closed got no answer (Д-192): the bridge waits for what it
    owes and exits 1 when a request went unanswered;
  - an empty daemon lock in the making was taken at once (Д-193): the lock follows the protocol
    of every other lock, with a heartbeat;
  - smaller ones (Д-194): a 30-day idle timeout made the daemon leave at once (cut to 24.8 days); a
    relative `AI_DEV_HOME` meant one folder to the client and another to the daemon; a cancelled
    request was answered with an error when the daemon later died; a message over 10 MB read as
    "the daemon went away" and is answered with its size; `stop` with a stale descriptor failed;
    the watch retired a healthy daemon on one unreadable look; a rebuild's collection held other
    clients' searches for 1.7 s (now under 1.1 s on 13 000 notes); a long-lived daemon's log
    never rotated.
- **The second phase 8 review's findings** (`docs/DEFECTS.md`, Д-196 … Д-201), each reproduced
  before the fix:
  - a client with a 20 000-character name made `status` say "Not running" and `stop` fail
    (Д-196): control answers have their own bound, client names are cut to 200 characters, and
    `stop` reaches a daemon that did not answer `status`;
  - a lock taken over from a daemon that hung removed its socket, so the retired daemon could be
    neither seen nor stopped (Д-197), and a retired daemon's record whose pid another program had
    since been given made `stop` fail for good (Д-198): the socket of a live daemon is left, every
    retired daemon is listed, and a retired record has a lock as a descriptor does;
  - the same data spelled two ways made two daemons (Д-199) — see "Changed";
  - a session's own certificate was not used for an `https://` proxy, and the error blamed the
    host's certificate (Д-200);
  - smaller ones (Д-201): the CLI's `daemon` commands did not resolve a relative `AI_DEV_HOME`;
    the bridge waited out its 10 minutes after refusing the last request; `Object.freeze` on
    the daemon's `process.env` broke every later listing of it; sizes and texts; the daemon
    tests now run on macOS and Windows CI too.
- **The third phase 8 review's findings** (`docs/DEFECTS.md`, Д-202 … Д-206), each reproduced
  before the fix:
  - a runtime home reached through a link — every `$TMPDIR` on macOS, a moved home — changed the
    build as its folders were created: the first start waited out its limit beside a daemon that
    was listening, and one data set got two daemons (Д-202). A folder is now resolved through its
    deepest existing part, so it is one folder before it exists and after;
  - on Windows a variable written `Ai_Dev_Vault_Root` was read by the daemon and not by the bridge
    (Д-203); a difference in `USERPROFILE` alone, which the server reads for the runtime home and
    the protected project root, now splits daemons too (Д-205);
  - `ai-dev daemon stop` said "Not running." of a retired daemon that was alive but hung past its
    lock's life, and the daemon came back without a lock (Д-204): a record whose address still
    takes connections stays, `stop` asks it and says it did not stop, and a daemon takes its lock
    again before it lists itself;
  - an `https://` proxy's certificate was checked against the name of the host behind it, so no
    real `https://` proxy could be used for the download (Д-206) — it is checked against the
    proxy's own name now;
  - smaller ones (Д-205): the socket of a crashed daemon whose pid another program had was never
    cleared; a daemon of code from before a change of the build's parts was never asked to
    retire; a runtime home deleted under a retiring daemon came back with mode 755; two tests that
    did not test what they named.
- **The fourth phase 8 review's findings** (`docs/DEFECTS.md`, Д-207 … Д-209), each reproduced
  before the fix:
  - the hooks' own copy of the proxy client still checked an `https://` proxy's certificate
    against the target's name (Д-207, Д-206 in its second copy): behind a real `https://` proxy
    the supply-chain hook could look nothing up and only warned. It now connects as the server's
    copy does, and a test holds it to that;
  - a daemon hung with its connection queue full — some 500 connections on Linux — was taken for
    a gone one: `stop` said "Not running." and removed its record (Д-208). Only a refused
    connection or a missing socket now means nothing listens there, and a retired daemon puts
    back a record taken away while it lives;
  - a test that left its daemon running after its folder was gone (Д-209);
  - and, found re-reading that fix, a retired daemon leaving at the moment its watch looked could
    put its record back after it was gone (Д-210).
- **The fifth phase 8 review's findings** (Д-213): the daemon's `run/` folder could come back
  with mode 0755 when its lock had to make it, and a retired daemon whose runtime home was deleted
  left the folders it made again behind; both fixed, and the texts on a full connection queue now
  say what macOS does.
- **The sixth phase 8 review's findings** (Д-214 … Д-216): a retired daemon remembered the first
  folder it made again, not the highest, so a runtime home deleted after its `run/` stayed behind,
  empty; `run/` could still come out 0755 when `ai-dev daemon stop` cleared a gone daemon's
  descriptor as the folder went, or when it was already 0755 — left so by the lock race fixed in
  Д-213, or moved up by the 2.x layout's migration — and the socket lived elsewhere. The daemon now
  removes up to the highest folder it made, and a starting daemon makes a looser `run/` of this
  user's 0700.
- **The seventh phase 8 review's findings** (Д-224 … Д-226): on Windows `fs.mkdir` names the folder
  it made in the `\\?\` namespace, so a retired daemon never matched it and removed nothing; the
  folders are compared in that form now. A starting daemon said `run/` was 0700 without looking and
  said nothing when it could not make it so; it now opens `run/` without following a link, changes
  and checks the mode through that handle, and logs what came of it — made private, or open and
  staying so, and why. `ai-dev daemon stop` makes no folder at all any more, so a runtime home
  deleted under it stays deleted, and a folder the retired record's own lock made again is removed
  with the others. A second daemon in the same deleted runtime home still leaves the folders it did
  not make; SECURITY.md says so.
- **A socket folder a file system leaves open is passed over** (Д-227): the daemon changed the mode
  of its socket's folder without looking at what came of it, and on a mount that keeps its modes
  listened in a `run/` that stayed 0755. It now checks again and listens in the next folder.
- **The eighth phase 8 review's findings** (Д-235): the folder a retired record's lock made was
  forgotten when another process wrote that lock first, and stayed behind; the lock now names it
  whether it is taken or not. A look at `run/` that failed was logged as `run/` being open to
  other users; it now says the folder cannot be checked. A private folder of another user's that
  refuses to be opened is refused by its owner's uid again, not by a bare EACCES. New tests catch
  a `chmod` that changes nothing or is refused, and a highest folder spelled outside the `\\?\`
  namespace.

- **`search_index_status` no longer says vectors came from Python when there are none** (Д-186):
  an index without vectors has no backend, revision or type for them.
- **A program reaching the daemon of another runtime home than its own** (Д-217): the client
  looked for the daemon's descriptor, and opened its log, in its own runtime home, so it waited out
  its limit beside a daemon that was listening. The daemon's paths now come from the environment
  the client is given; `ai-dev daemon status` and `stop` read them the same way.
- **HTTPS through a proxy sent `Host: <name>:80`** (Д-211): a request tunnelled through any proxy —
  the model download and the supply-chain hook alike — named port 80 in its Host header for an
  https:// address, which a virtual host, a CDN or a TLS-inspecting proxy may refuse. It names no
  port now, and a port the address names.
- **The supply-chain hook's message when a proxy refuses the credentials in its URL** (Д-212): it
  advised putting them in the URL, where they already were; it now says the proxy did not accept
  them, as the download says.
- **The phase 9 review's findings** (Д-218 … Д-223): a stored model folder kept the app's
  transport from reaching its daemon, and a stored mirror was used by no app session; a 2.x index
  went to a vault that shares the skill catalog with its owner, who lost its vectors; `setup_run`
  refused a misspelt client only after building everything; the idle time took text, booleans and
  fractions of a minute; the settings file was not flushed and replaced a link with a file; and
  eleven smaller ones — among them `logs_tail` following a link, a NUL in a path setting, the opt-in
  `control` as everyone's default profile, and a fractional idle time breaking `system_status`'s
  contract.
- **The second phase 9 review's findings** (Д-228 … Д-233): a model folder saved in the middle of a
  session moved the control tools to it while the daemon's search stayed in the old one, so setup
  failed beside a model it had just installed; one note copied with its time made a vault the owner
  of a 2.x index, and a clone into the same folder lost it; `upgrade:test`'s check of that never ran;
  a NUL in the mirror kept every daemon from starting; on Windows a variable set by hand in another
  case and the file's gave the daemon another build; and eleven smaller ones — among them
  `logs_tail` reading a hard link, a real failure during a stop reported as skipped, and the idle
  time shown otherwise than the daemon reads it.
- **The third phase 9 review's findings** (Д-236 … Д-238): a set-up vault cloned again into its
  folder lost its 2.x index and vectors, because the notes the server writes itself — skill and
  project cards, group notes, dashboards — told against it; they no longer count. `settings_get`
  called a model folder saved in the same session the one in force while the session's tools kept
  the old one, and the model went to the folder just left; it now gives what the session uses and
  lists the change as `pending`, and the model tools refuse to fill the folder the session is
  leaving. And smaller ones: the settings file written through links as the system follows them,
  `logs_tail` checking that it read the file it looked at (on Windows too) and never waiting on a
  FIFO, `schema_version` read and written alike, Ctrl-C during the Frontend QA check reported as a
  stop, the spelling of a variable Node passes on read on Windows, and the daemon transport's
  default profiles taken from the settings.
- **A repository AI Dev has not seen yet is told where its checks come from** (Д-380). README's
  first task on a new repository stopped at `verify_task`: the project had no
  `.ai-dev/quality-gate.md`, the check came back `unavailable` with "Quality gate file not found"
  and nothing more, and `complete_task` refused. Only the routed `ai-dev-orchestrator` skill said
  that `prepare_project` writes one. Now `begin_task` lists the missing gate among the context's
  unknowns, and the refusal — from `run_quality_gate` or inside `verify_task`, kept in the
  verification's record — names `prepare_project` as the next step; with it the first task runs
  to `complete_task` in a clean container.
- **`ai-dev daemon stop` no longer calls a daemon that has exited "still running"** (Д-234). A
  daemon that exited while the program that started it kept its own event loop busy is a zombie
  until that program collects it, and `kill(pid, 0)` answers for a zombie as for a live process: a
  program that ran `stop` synchronously got "did not stop: it is still running" and exit 1 for a
  daemon gone 6 ms after the request. A process in state `Z` — `/proc` on Linux, `ps` on macOS — is
  exited now: the same `stop` says "Stopped" in 129 ms, exit 0. Where neither can tell, the message
  says the process is still there, running or not yet collected. A process `kill` finds that `/proc`
  does not show — `hidepid`, someone else's — is there, not gone, so a lock it holds is not broken
  (Д-386).
- **A `block` rule of `.ai-dev/policy.json` blocks on a busy machine too** (Д-239). Its pattern is
  matched in a worker thread under a 250 ms budget, and the budget's timer started before the thread
  did, so a thread that was slow to start was charged to the first rule: on four cores with sixteen
  busy loops, 17 of 30 `./deploy-prod.sh` went through, with "matching its pattern took longer than
  250 ms. Fix the pattern…". Starting the thread now has an allowance of its own (3 s) and the
  budget counts the matching alone: 30 of 30 blocked under sixteen busy loops and under 32. A rule
  the thread never reached is reported as not run (`not_run`) — the guard says the machine was too
  busy to check it ("this command", or "this write", went unchecked), and `upsert_policy_rule` refuses
  to store a pattern or an example it could not try (Д-383) — never as a pattern that took too long. A
  thread that fails rather than starts slowly is answered as run, with its error, and the guard says
  it failed (Д-384) — once for all the rules it failed on, where it made and lost a thread per rule
  (Д-397). Such an answer is no check either: `upsert_policy_rule` refuses the pattern, the example
  or the counter-example the worker failed on, naming which, writes a rule with an example only once
  it was seen to fire on it, and `list_policy_rules` shows `match_error` (Д-393). Both copies,
  `src/core/regex-budget.mjs` and `hooks/lib.mjs`.
- **The static gate reads what the code does, not how it is spelled** (Д-267). It looked for the
  usual spellings of `exec`, `shell: true` and `eval`, and every equivalent passed:
  `import * as cp` with `cp.exec(…)`, a default import, `execSync`, `{ "shell": true }`,
  `{ shell: "/bin/sh" }`, `globalThis["ev" + "al"](…)`. `src/core/forbidden-calls.mjs` reads the
  source as tokens — every escape decoded, a template without substitutions read as the string it
  is, `?.[` as `[`, a slash told from a division by what stands before it (a statement head's `)`, a
  block's `}`, a property named `in`) — and asks the rules of them, in the server and in `desktop/`:
  the six spellings appended to a server file and a desktop file give twelve findings, where the gate
  passed them. It knows the module's `default`, `.then(async …)` callbacks, rest elements, plain
  re-binding and `??=`, parentheses and comma lists around a value, the module handed to another
  file (`export *`, `module.exports =`), `Function` through `.call`, `.apply` and `.bind`, a global's
  `.Function`, `.shell =`, `["shell"]:` and shell accessors; a `shell` key counts only in an object
  literal — a default value or an iterated array is one — so an import, a parameter or an argument
  named `shell` passes; and a file it cannot read to its end — a template or a comment that never
  closes — is refused rather than passed (Д-382, Д-398, Д-399). It follows the module object and the
  global objects through plain re-binding and nothing else: a module name built from parts,
  `createRequire` and `Reflect.get` are past it, and said to be. Bracket pairs are worked out once, so
  a file costs what its length does: 5,922 dependency files are read to the end in about 15 s, and a
  448 kB minified line in 0.2 s, where it took 10 s (Д-401).
- **The app tells a model it cannot read from one that is not there** (Д-367). A model folder the
  account could not read — rights, a link to a disk not connected, a share — was "not installed",
  and the wizard offered to download the model over it. Status and the wizard now say it cannot be
  read, with the reason (`EACCES`, a folder that is a file, a loop of links, a share), what to fix,
  and **Check again**; nothing is downloaded over it. An `EPERM` names macOS's Privacy & Security too
  (Д-387).
- **A host model folder whose `bge-m3-onnx` is a link works in Docker** (Д-368). Docker resolves a
  bind mount's source on the host, so a link that pointed at another disk was mounted as the folder
  that held it, and the link inside led nowhere: the model was "not installed". A 3.0 entry mounts
  the link itself at `/models/bge-m3-onnx`, which Docker follows on the host — measured: "Installed:
  yes, every file matches the manifest." `bootstrap.sh` refuses a link that leads nowhere (exit 64),
  and the 2.x `run-mcp.sh` names it. A session mounts what the link leads to every time, so while that
  disk is away Docker starts none: writing the entries says so for a link to another disk, and
  `ai-dev clients doctor` names an entry whose mounted folder is gone, without starting it — where a
  link leads, and a command that writes the entries again with the image and folders they had
  (Д-385, Д-397).
- **`npm run demo` counts the skills it ran with and leaves your home alone** (Д-110, Д-374,
  Д-389). It printed a skill count written into the script, and the search index it built claimed
  the index of the person's own `~/.ai-dev`; the count now comes from `list_skill_groups` (614), and
  the demo's runtime home, state and index stay in the temporary folder it deletes. With that
  temporary home its server moved AI Dev's Codex-era folders out of `~/.codex` into the folder, and
  they were deleted with it; now, with `AI_DEV_HOME` set, the move reads `$AI_DEV_HOME/.codex`, as
  2.x did, and the demo names every place the move would fill, so nothing leaves `~/.codex`.
- **The tests pass with a temporary folder that is a link or a long path** (Д-258, Д-259, Д-373).
  Four tests compared a resolved path with one built from `os.tmpdir()`, and the bridge test bound a
  socket that a 112-byte `TMPDIR` cut short, so parallel runs collided (`EADDRINUSE` in 6 of 12):
  the whole suite now passes with `TMPDIR` a link, and 12 parallel runs under a long one.

### Security

- **The server passes its own security gate again** (Д-82). `run_security_scan`
  on `ai-dev-mcp-server` itself came back `block`: 16 findings, 7 of them high —
  five host-confusion and SSRF advisories in `fast-uri` 3.1.4 and two inherited
  libvips/libheif advisories in `sharp` 0.34.5 — plus moderate ones in `hono` and
  `qs`. All four are transitive. `fast-uri` (3.1.8), `hono` (4.13.8) and `qs`
  (6.16.0) moved inside their parents' ranges, resolved with `--before` a week
  back so a fix never lands on a release younger than that. `sharp` sat outside
  `@huggingface/transformers` 3.7.5's `^0.34.1`; it is 0.35.4 now through
  transformers 4.3.0, which asks for `sharp ^0.35.4` itself, with no override
  (Д-87). After: `pass`, 0 findings.

## [2.0.0] - 2026-09-13

A major version because what a clone *is* changed, not only what it can do: the
bundled catalogue went from 142 skills to 3,227, the protocols now reach seven
assistant instruction files instead of three, and one health check changed the
status it reports. Anything reading those outputs should be re-checked against
this release.

**Highlights**

- **A fresh clone no longer fails its own health check.** `git clone` →
  `npm install` → `npm run setup` used to end in `Health: fail — 4 not passing`
  on Linux and Windows alike: the Frontend QA runner threw where its optional
  dependency was missing, the embedding check counted the Python environment
  `--dense` builds as required, and one skill — `grill-me`, shipped here —
  failed its own quality rules. Now `degraded — 2 not passing`, both warnings
  naming a next step.
- **macOS is tested, not assumed.** CI had three Linux jobs and one Windows job
  and nothing for macOS. A `macos-latest` job now runs the unit tests, the
  identity and hook tests, a first run and the seed check — and found a defect
  on its first run.

- **3,085 skills in the box.** The intent gate `grill-me`, the whole Membrane
  integration catalogue, and the Understand Anything codebase-graph skills — all
  MIT, each recorded in `THIRD_PARTY_NOTICES.md` with its revision. Routing is
  held steady by `membrane_policy` and a named-skill floor; the 37-case golden
  benchmark is unchanged.
- **Every assistant reads the protocols.** `install_project_rules` writes
  `AGENTS.md`, `.claude/rules`, `.cursor/rules`, `GEMINI.md`,
  `.github/copilot-instructions.md`, `.windsurf/rules` and `.clinerules` — and
  by default only the ones whose tool this machine or repository already shows a
  trace of.
- **`npm run daemon`.** One warm local process on a Unix socket, or a named pipe
  on Windows, instead of a fresh server per client.
- **`npm run setup` and `npm run acceptance`.** The first run, and the project's
  own acceptance rule, as commands rather than instructions.
- **Windows is a supported platform.** Byte-exact snapshots, platform-native
  worktree paths, the interpreter that actually exists, a shell-free `npm`, and
  one memory key per project rather than one per machine.
- **The local model runs in a container.** The Python side is a build argument
  (`INSTALL_BGE_M3=1`), the weights mount read-only at `/models/bge-m3` from
  either the launcher scripts or Compose, and both READMEs carry the whole path
  end to end — including a four-line Dockerfile for baking the weights in.
- **978 tests, 0 failures**, coverage 97.05 / 83.83 / 94.79 against thresholds
  85 / 60 / 85.

**Breaking**

- The bundled seed now carries 3,227 skills. A deployment that pinned the old
  142 will see different routing candidates; `membrane_policy: "exclude"`
  restores the narrow behaviour.
- **`system_health` reports two checks differently.** `embedding_backend` is
  `skipped`, not `fail`, when the optional dense model was never downloaded, and
  `frontend_qa_environment` is `skipped` when Playwright was never installed —
  both are opt-in steps, and their absence is not a fault. A half-configured
  Frontend QA (Playwright present, its browser missing) is still a warning, and
  a missing shipped helper is still a failure. Anything treating a non-`ok`
  status as an error should read the status rather than its absence.
- `install_project_rules` with no explicit `targets` writes more files than
  before, chosen by what the machine already uses. Pass `targets` to pin it.
- **Project memory keys change on machines where the home directory is reached
  through a symlink or a short name** — every macOS install, and any Windows or
  Linux one whose path is not canonical. They were wrong before: every project
  under such a home shared one key. Memory written under the old key is not
  migrated; sessions, instincts and handoffs recorded there start fresh.



### Fixed — the sweep that removed the notes also found this

- **Eight tests that shipped and never ran.**
  `search-index/test_search_freshness.py` covers the SQLite search helper —
  freshness detection, the rebuild lock, dense-vector preservation on a fast
  rebuild, the candidate pool, and the collapse rules that keep a skill card and
  its source out of the results twice. `node --test` cannot see them: they are
  Python. No npm script and no CI job ran them, so they gated nothing while
  looking like coverage. `npm run check` runs them now (and
  `npm run test:search-helper` on its own), and CI runs the same suite directly
  on a runner that always has Python. A checkout without Python gets a skip that
  names the reason, never a failure, and tells "no interpreter" apart from "the
  one you named does not answer" (Д-53).

### Removed

- **The working notes are no longer in the repository.** `docs/ecc-upgrades/`
  held the development record — a staged plan, per-stage implementation
  journals, the prompts written for verification agents, pull-request bodies,
  handoffs, a code map made obsolete by the architecture document. 41 files and
  14,492 lines that answered questions nobody installing this has. They remain
  in the git history; they are simply not part of what you clone.

  One file earned its place and stays, moved and renamed: the defect registry,
  now `docs/DEFECTS.md`. Every defect found in this project is there with the
  measurement that reproduced it and the measurement after the fix, open entries
  beside closed ones, and 28 comments in the source cite it by entry number.

### Fixed

- **Every project under one home no longer shares a memory key.** The hook
  compared a candidate `.ai-dev` against a runtime root that was one path
  segment too deep, and then against one spelled differently — uncanonicalised,
  so a home reached through a symlink (`/var/folders` on every macOS) or a
  Windows 8.3 short name never matched. Either way the runtime directory went
  back into the project-marker list and the walk stopped there. Session memory,
  instincts and handoffs are keyed by that id, so notes from one project reached
  an agent working on another, silently. Measured: two sibling projects both
  hashing to `project-e24ca70e5358e2931b79` while the server told them apart.
  The walk still runs to the filesystem root, so a `package.json` in a home
  directory collapses everything below it the same way — recorded as Д-48 with
  three possible answers rather than left implied.

- **A correct install no longer reports itself broken.** The Frontend QA runner
  ships but imports Playwright at module load, so on a clone that never ran
  `--frontend-qa` the module-not-found escaped and became a failed check; the
  embedding check listed only the weights as optional, though `--dense` also
  builds the Python environment; and `grill-me` failed the quality rules this
  project applies to every other skill — no trigger wording, no procedure of its
  own, no statement of what the gate must produce. The card now carries all
  three, and its findings went from four to zero.

- **`npm run acceptance` reads both runner spellings.** Node 22 writes
  `# fail 2`, Node 24 writes `ℹ fail 2`; reading only the first filed every
  Node 24 run as "failed before the tests" — the one distinction the command
  exists to make.

- **`docker:seed:verify` tells line endings from corruption.** A checkout older
  than `.gitattributes` keeps CRLF, and git does not rewrite files already on
  disk when that rule arrives. 74 files were reported as differing content; each
  was larger than its manifest entry by exactly its line count. The check now
  names that case and prints the command that fixes it.

- **`docker:audit` refuses a build context it cannot date.** It reads
  `.docker/build-context`, which is local build output, and believed whatever it
  found there — reporting a dangling import of a module this repository does not
  carry. The manifest records `generated_at`, kept outside the content
  fingerprint so the same tree still fingerprints identically.

- **`npm run docker:seed` no longer deletes the vendored skill catalogues.** The
  seed is generated from the owner's vault through an explicit allowlist and
  then replaces its output directory wholesale, so the three imported
  catalogues — which live in the checkout and in no vault — were dropped:
  3,227 skills became 143 and 4,186 files became 1,008, with the regenerated
  manifest making the loss look deliberate. The refresh now carries them
  forward from the checkout and refuses to write a seed that is missing any of
  them. A rebuild reproduces the committed seed byte for byte.

- **The local model works in a container, and the instructions say how.** Dense
  retrieval hung on `AI_DEV_MODEL_PATH`, which only the launcher scripts read:
  Compose had no `/models` mount and no mention of the variable, while the
  README explained it in the section about Compose. A reader following that got
  a container where `BGE_M3_MODEL_DIR=/models/bge-m3` pointed at nothing, and
  the failure was quiet — `embedding_backend` says `skipped`, which reads as
  "you did not download the model" rather than "the mount is missing".
  `compose.local.example.yaml` now carries the mount against the same variable
  the launchers use, and both READMEs and `docker/README.md` carry the whole
  path end to end: the `INSTALL_BGE_M3=1` build argument, the one host command
  that downloads the weights, both ways to run it, a four-line Dockerfile for
  baking the weights into an image of your own, and the two keys that say
  whether it worked. `network_mode: none` is no obstacle — the embedding helpers
  set `TRANSFORMERS_OFFLINE=1` and `HF_HUB_OFFLINE=1` before loading.

- **A seed rebuild no longer breaks archify.** Nested vendored dependencies
  (`archify/node_modules/ajv/node_modules/fast-uri`, 34 tracked files) were
  dropped by the copy: the approval pattern matches a distribution-root path
  while the copy tested one relative to its own root. `ajv` needs `fast-uri` at
  runtime, so the locally executed CLI those dependencies exist for stopped
  working after any refresh — silently, since the privacy audit reads the
  distribution-root path and passed.

### Added

- **`npm run daemon`: the server as one warm local process.** The same MCP
  server over a Unix socket (a named pipe on Windows) instead of a fresh stdio
  process per client, so the search index and the embedding model load once and
  stay loaded. It takes a pid lock — a second daemon refuses rather than
  stealing the socket, and a lock left by a dead process is cleared — publishes
  `~/.ai-dev/run/daemon.json`, creates the socket 0600 inside a 0700 directory,
  and exits after `AI_DEV_IDLE_TIMEOUT_MS` without sessions (default 30
  minutes). Optional: `npm start` remains the stdio path and nothing about it
  changed.

  Ported file by file from `codex/commit-all-20260908`, a snapshot branch that
  cannot be merged — moving main to it would be 744,638 deletions, taking the
  vendored skill catalogue and everything since the server was split into
  modules. `tool-profile.mjs`, `project-trust.mjs` and `scripts/models.mjs`
  are still there, unported (Д-42).


- **A root `AGENTS.md`.** The project whose whole purpose is putting protocols
  into the file every assistant reads had none of its own: no `AGENTS.md`, no
  `CLAUDE.md`, no `GEMINI.md`, no `.clinerules`. The rules this work was held to
  lived in whoever was working — new tools only as extensions and never
  importing `mcp-stdio.mjs`, the 800-line module ceiling and its two pinned
  exceptions, fake secrets in tests assembled by concatenation because a literal
  trips the security scan, the deliberate duplication in `hooks/` because those
  files run inside other people's repositories, a defect written down with a
  measurement before and after, and a session that ends with ten gate runs
  rather than one. Written by hand: here the file is the source, not
  `install_project_rules`'s output (Д-43).

- **`npm run acceptance`**: the rule this project ends a session on, as a
  command. Ten consecutive `npm run check` runs and the line "N падений из 10",
  with the two kinds of failure kept apart — a run with a failing test is the
  suite telling you something, a run that exits non-zero with `# fail 0` is the
  coverage reporter and says nothing about the code. `--runs N` for a longer
  sample.

- **`npm run verify:cursor`**: the five-minute check a person with a real Cursor
  has to run, printed from the adapter's own contract. The claims that could not
  be verified from here now also come back in `install_agent_hooks`'s answer
  rather than living only in a source comment.


- **3,085 skills, in the file each assistant already reads.** The intent gate
  (`grill-me`, this project's own, following the `grilling` interview imported
  from [mattpocock/skills](https://github.com/mattpocock/skills)), the whole
  [Membrane](https://github.com/membranedev/application-skills) integration
  catalogue — 3,074 application skills, from Gmail and Slack to Salesforce —
  and the nine [Understand
  Anything](https://github.com/Egonex-AI/Understand-Anything) codebase-graph
  skills. 3,084 of them are imported, all MIT, each recorded in
  `THIRD_PARTY_NOTICES.md` with its revision and licence text beside the source;
  the remaining one is `grill-me`. The registry goes from 142 skills to 3,227
  and the search index to 3,443 documents, 3,227 of them skill cards; routing
  holds at three skills plus a reserved slot, and an integration skill stays out
  of the answer until a task names its application.


- **`npm run setup`**: the first run, as one command. A clone ships the server,
  the skills and the seed, but four things are built rather than shipped — the
  skill registry, the SQLite search index, the skill-routing benchmark report
  and the Frontend QA runner's dependencies — and until they exist the health
  check fails and the search tools answer with refusals. `npm run setup` builds
  the three that need nothing but the repository; `--frontend-qa` installs the
  QA dependencies; `--dense` builds the Python environment and downloads the
  2.3 GB BGE-M3 weights, because a download that size is a decision a person
  makes rather than something a setup command does behind their back. Every step
  is idempotent, says whether it ran and why, and the run ends with the
  diagnostic, so what is still missing is on the screen rather than in a
  document (`src/core/first-run.mjs`, `scripts/first-run.mjs`). Measured on this
  repository: routing benchmark 37/37, search index 332 documents, and the
  health check's failures drop from three to one — the model weights.

- **Distilled project rules** (`distill_project_rules`): reads what a repository
  already does — module system, Node built-in import style, Python import style,
  source and test file naming, where tests live, which test runner, how failures
  are raised, whether caught errors are acted on — and writes it to
  `.ai-dev/rules/project.md` with `status: draft`. Every statement carries the
  counts it came from, and a convention the repository splits on is reported as
  split instead of being turned into a rule. It complements
  `install_project_rules` rather than replacing it, and never writes over an
  existing file: the answer distinguishes a draft (safe to regenerate) from one
  whose `status: draft` line a person has removed (`src/core/rules-distill.mjs`).

- **Import graph in the project map**: `.ai-dev/project-map.md` gained an
  "Import graph" section — the modules most of the codebase depends on, every
  import cycle, and the files nothing in the project imports. Read from
  JavaScript/TypeScript and Python sources, resolving only to files inside the
  repository, so a bare specifier is counted as an external dependency and never
  becomes a node. The scan is lazy: the source files are fingerprinted by path,
  size and mtime (a directory walk) and re-parsed only when that moves, so
  `prepare_project`, `refresh_project_map` and `refresh_project_context`
  re-render the map every time and re-read the tree only when it changed
  (`src/core/import-graph.mjs`).

- **Agent harness grading** (`scan_agent_config`): grades a repository's agent
  configuration from A to F over five places nothing else reads together —
  `CLAUDE.md` / `AGENTS.md` that run a command on load or tell the agent in
  prose to stop asking, `.claude/settings.json` that pre-approves `Bash(*)` or
  sets `defaultMode: bypassPermissions`, hook commands that splice a variable
  into a shell, subagents with no `tools:` limit, and everything
  `list_mcp_servers` already finds (folded in, not re-implemented). Findings use
  the change-hygiene shape `{ rule, severity, file, line, message }`; a
  `block` — a setting that removes a check rather than narrowing one — caps the
  grade at D. The grade is written into the project card's new
  "Agent Configuration" section, and credentials are masked with the same
  function the MCP inventory uses (`src/core/agent-config-scan.mjs`).

- **Worktree lifecycle states** (`list_task_worktrees`, `plan_worktree_cleanup`):
  each task worktree is reported as `orphan` (git still registers a directory
  that is gone), `dirty` (uncommitted work lives only there), `merged` (every
  commit is already in the main checkout), `stale` (unmerged commits, nothing
  recent) or `active`, decided worst case first so the state says whether
  removing it costs anything. `plan_worktree_cleanup` offers the merged and
  orphaned ones, offers stale ones only with `include_stale`, never offers dirty
  ones, and removes nothing until `dry_run: false`.

- **State housekeeping** (`prune_state`): retires instincts whose confidence
  fell under 0.3 and that have not been observed for 90 days, archives session
  handoffs and hook observation logs older than 90 days into an `archive/`
  directory beside them (moved, never deleted, and a scope's newest handoff is
  always kept), rotates the usage ledger down to its newest 20 000 events, and
  deletes the snapshot refs of completed *and abandoned* tasks — a task that is
  not complete and has not been updated for 30 days previously kept
  `refs/ai-dev/snapshots/<task>/*` for good, and each live ref pins a whole tree.
  Runs as a dry run unless `dry_run: false`, and reports each of the four areas
  separately so one that fails does not stop the others
  (`src/core/state-pruning.mjs`).

- **Security scanners** (`run_security_scan`): adapters for `npm audit`,
  `pip-audit`, `cargo audit`, `gitleaks`, `semgrep` and `trivy fs`. Each one
  knows how to find its binary, whether this project is one it has anything to
  say about, and how to read its output; every finding comes back as
  `{ tool, kind, severity, file, line, message, rule }`. `verify_task` runs the
  same scan as its `security_scan` check, next to `change_hygiene`: critical and
  high dependency or secret findings fail verification, everything else is
  reported. A scanner that is absent, inapplicable or needs a network this run
  does not have is `skipped` with the reason, so it can neither fail nor delay a
  verification (`src/core/security-scan.mjs`,
  `src/core/security-scan-parsers.mjs`).

- Twelve agent-workflow upgrades, ported from ECC (Everything Claude Code) and
  reshaped for this server. New capabilities, all reachable as MCP tools:
  - **Extension registry** (`src/tool-extensions.mjs`): tools now live in
    `src/extensions/*` as `createXxxTools(host)` factories instead of growing
    `mcp-stdio.mjs`, which is capped at 10,500 lines by the static gate.
    Duplicate names and missing handlers fail at startup.
  - **Decision ledger** (`record_decision`, `list_decisions`): ADR-lite records
    under `.ai-dev/decisions`, folded into the compiled context pack.
  - **Usage ledger** (`record_usage`, `usage_report`): per-tool call telemetry
    plus token and cost accounting reported by the client or the runner.
  - **Change hygiene** (`verify_change_hygiene`): diff scanner for secrets,
    focused/skipped tests, `debugger`, conflict markers and weakened linter
    configuration; runs as part of `verify_task`.
  - **Task worktrees** (`begin_task_in_worktree`, `list_task_worktrees`,
    `remove_task_worktree`): one isolated git worktree per task.
  - **Rules library** (`list_rule_packs`, `install_project_rules`): a catalogue
    of engineering rules (common plus stack packs with `paths:` scoping),
    projected into `.claude/rules`, `.cursor/rules/*.mdc` and `AGENTS.md`.
  - **Plan gate** (`plan_task`, `plan_status`): task-complexity classification
    with a plan required before large or risky work starts.
  - **Session memory** (`save_session`, `resume_session`,
    `context_budget_status`): structured handoffs and a context budget.
  - **Instincts** (`record_instinct`, `list_instincts`, `update_instinct`,
    `evolve_instincts`, `export_instincts`, `import_instincts`): learned
    preferences with confidence, decay, promotion to global and evolution into
    skills.
  - **Agent hooks** (`install_agent_hooks`, `agent_hooks_status`): an
    installable hook pack for Claude Code and Cursor — command/file guard,
    session start and end, pre-compact, post-edit formatting and a stop check —
    configured by `.ai-dev/policy.json` profiles.
  - **Five seed skills** plus an updated `ai-dev-orchestrator`:
    `verification-loop`, `silent-failure-hunter`, `planner`,
    `security-reviewer` and `memory-curator`.

- Archify diagram capability: nine typed MCP tools for local validation,
  rendering, delivery receipts, browser checks, comparisons, migrations, and
  brand references; the clean Docker seed now carries its pinned runtime for
  offline operation. Diagram-request detection (routing, recommendations, and
  acceptance criteria) is a single shared pattern that excludes database and
  API schema work. Delivery-receipt verification enforces the full showcase bar
  (profile, zero errors/warnings, all checks, artifact hash) before an
  acceptance criterion is marked met.
- `docs/ARCHIFY.md`, integration notes, and third-party notices for the
  vendored Archify package and its runtime dependencies.
- `.github/` issue and pull-request templates and a `dependabot.yml` for npm,
  pip, and GitHub Actions updates.
- Stable Homebrew tap formula source for `v1.0.0`, validation of AUR `.SRCINFO`,
  and documented maintainer-only publication paths for `stonebridgeway/tap` and
  `ai-dev-system-git`.
- Windows CI job (`windows-latest`): parses every PowerShell script, runs
  `bootstrap.ps1 -Plan`, exercises the client installer's win32 path handling,
  and runs the core unit suite. The Windows install path had no CI coverage
  before.
- **Selective skill import** (`import_skill_repo` with `select_skills: true`,
  `src/core/skill-import-policy.mjs`): imports only the `skills/<name>`
  directories of an upstream catalogue that pass four gates — taxonomy
  exclusions with a cited reason, a name already owned by a local skill (ours
  wins), the public-seed privacy audit, and a minimum quality score
  (`min_quality_score`, default 75). `dry_run: true` reports the plan without
  writing. The result and the generated `upstream.json` record how many skills
  were imported and why each of the rest was left out.
- **ECC skill catalogue** as `external/ecc` (the imported-catalogue work, item
  3.1): 101 of ECC's 291 skills (MIT, pinned to a commit), among them
  `tdd-workflow`, `api-design`, `contract-first`, `hexagonal-architecture`,
  `intent-driven-development`, `database-migrations`, `error-handling`,
  `production-audit` and the language `*-patterns` / `*-testing` families. They
  carry `trust_level: known-upstream` and `instruction_policy:
  data-until-review`, declared in `upstream.json` and reported by
  `recommend_skills`: their text is reference material until someone reviews it,
  not instructions to follow on sight. 190 skills were left out — 168 by
  taxonomy rule, 17 below the quality floor, 4 for a privacy-audit finding, and
  ECC's `verification-loop`, whose name our custom skill already owns.
- Cost capture and a model rate table, so a session's spend is visible without
  the client reporting anything:
  - **`cost-capture.mjs`**, an eighth hook, registered on `Stop` at every
    profile. It sums the `usage` of the assistant messages a transcript gained
    since the last run — subagent turns included, since they are billed the
    same — splits the cache writes by TTL, and appends one `kind: "usage"`
    event per model to the usage ledger,
    writing the file directly so it works while the server runs in Docker. A
    byte cursor per session (`state/usage/sessions/<session>.json`) keeps the
    same message from being billed twice however often `Stop` fires, and a
    transcript that shrank is read from the top again.
  - **`RATE_TABLE`** in `core/usage-ledger.mjs`: published USD per million
    tokens per model, read from Anthropic's pricing page on the date recorded
    in `RATE_TABLE_SOURCE`, with the cache multipliers (5-minute write 1.25x,
    1-hour write 2x, read 0.1x) filling the rows that do not state their own.
    A turn's `cache_creation_1h_tokens` — the share of its cache writes made
    with an hour's TTL, which the transcript reports under `cache_creation` and
    `record_usage` now accepts — is priced at the 1-hour rate and the rest at
    the 5-minute one. Prices change, so `model_rates` in `.ai-dev/policy.json`
    overrides or adds any row per project.
  - **`usage_report`** now returns the `today` / `yesterday` / `last_7_days`
    slices alongside the per-model and per-task totals, and estimates cost from
    the rate table wherever the client reported none — a reported cost still
    wins, and a model the table does not know is listed under
    `rates.unpriced_models` instead of counted as free. Pricing happens at read
    time, so a price change re-prices history rather than freezing a stale
    number into the ledger.
- **`prepare_pull_request`**, a new tool in `src/extensions/pull-requests.mjs`,
  writes the pull request description a task has already earned. It reads the
  task record — goal, acceptance criteria with their status and evidence,
  checkpoints, the latest `verify_task` run and the checks it executed,
  recorded decisions, the plan — and the repository diff against the base
  branch, then writes `.ai-dev/pr/<task_id>.md` and returns the text.
  - The repository's own template is filled, not ignored:
    `.github/pull_request_template.md` and the usual variants (including a
    `PULL_REQUEST_TEMPLATE/` directory) are discovered, each heading it
    recognises receives the matching evidence, headings that belong to the
    author — a checklist, a "type of change" list, screenshots — keep their
    text, and generated sections that matched no heading are appended so no
    evidence is dropped.
  - Changed files are listed by group (tests, CI, docs, configuration, assets,
    source) with their status, alongside the commits on top of the base and the
    checks that ran — including the ones that did not.
  - Acceptance criteria that are not met, a failed or missing verification and
    blocking hygiene findings go into an "Outstanding" section, so an unfinished
    change cannot look finished.
  - It pushes nothing and opens nothing: `git push -u` and
    `gh pr create --body-file` come back as text for a human to run.
  - `complete_task` prepares the same file at completion and links it from
    `next_step` (`prepare_pull_request: false` opts out).
- **Completion-statement linter** (`src/core/completion-claims.mjs`): the
  `summary` and `notes` of `checkpoint_task` and `complete_task` are now held to
  the evidence behind them. Twelve rationalizations — "pre-existing issue",
  "skipping tests for now", "tests are failing but I'll fix them later", "works
  on my machine", "should work", "untested", "flaky", "disabled the lint rule",
  an untracked TODO, "good enough for now", "didn't check the UI", "verified
  manually" — each name the gate that would settle them (`quality_gate`,
  `change_hygiene`, `frontend_qa`, or the latest `verify_task` run).
  - A rationalization over a gate that did not pass, or never ran, is refused
    before anything is recorded; the error names the rule, the gate, the quoted
    phrase and the ways out. Over a passing gate the same wording is only a
    warning, returned in the new `completion_claims` field of both tools.
  - The rule table is data, and `.ai-dev/policy.json` is the knob:
    `completion_claims.enabled: false` turns the linter off, and a waiver
    (`{ rule, reason, expires? }`, `"*"` for all rules) turns off one rule where
    the reason is real — it applies only when the report states that reason too.
    An unknown rule, a reason under 20 characters, an unreadable date or invalid
    JSON leaves the linter on and says so in `completion_claims.warnings`.
  - New seed skill **`self-evaluation`** (quality score 100): five axes scored
    with quoted evidence, a "claim → what backs it" table for eleven sentences
    reports actually contain, and a post-action for each average band.
    `ai-dev-orchestrator` and `verification-loop` route to it before
    `complete_task`.
- **Epics** (`decompose_task`, `epic_status`, `src/core/task-epics.mjs`): a
  task can be broken into children with an order between them.
  - Each child is opened through `begin_task`, so it routes its own skills,
    compiles its own context pack and carries its own acceptance criteria;
    every other tool works on it unchanged.
  - `depends_on` names siblings by key or by 1-based position. A reference to
    nothing, a child waiting for itself, and a ring of children each waiting
    for the next are refused before anything is created — an order that cannot
    be worked is better rejected than opened. At most 20 children, one level
    deep.
  - `epic_status` reports each child's state (done, in progress, ready,
    blocked, and what it is blocked by), how far the epic has come, and the one
    child to work next; asked about a child, it answers with the parent's epic.
    An epic whose every open child waits for another open one is reported as
    deadlocked rather than as "nothing ready".
  - `complete_task` on a parent is refused while any child is open, or while a
    child's record is missing: an epic closes last, on evidence that still
    exists. The task record gained `parent_id`, `depends_on` and `epic`.
  - GitHub Issues are not part of this. ECC coordinates epics through issues
    and labels; this server tracks tasks itself and works offline.
- **`coverage_gaps`** (`src/core/coverage-reports.mjs`,
  `src/extensions/coverage.mjs`): reads whichever coverage report the project's
  own test run left behind — an lcov tracefile, an Istanbul
  `coverage-final.json`, a Cobertura or `coverage.py` XML, or a
  `go test -coverprofile` — and ranks what is not covered.
  - A file the change set touched outranks one it did not, and an uncovered
    function counts double: an untested line in a file just edited was probably
    just written. Uncovered lines come back folded into ranges (`18-24`) with
    the functions that run in no test.
  - Report paths are normalised against the project root and matched to changed
    files on whole trailing segments, so a Go import path and a repository path
    are recognised as one file. Nothing is executed: a report that no run
    produced comes back as `no_report` with the command that would produce one.
  - `verify_task` gained `coverage_min`: a percentage of lines the report must
    show, checked as a new `coverage` check with the five largest gaps
    attached. It fails when the report is missing — a floor nobody could
    measure is not a floor that was met — and `0`, the default, leaves coverage
    out entirely.
- **`propose_instincts`** (`src/core/instinct-proposals.mjs`): the session-end
  hook now leaves an observation log beside its draft — what the user said,
  what tools ran with what, which calls came back as errors — and this tool
  reads one session's log into candidate instincts.
  - Five patterns, ported from ECC's continuous-learning-v2 observer: a
    correction the user made (only after the agent had done something to
    correct), a rule they stated ("always", "never", "use X instead of Y"), an
    error signature that recurred together with the call that finally cleared
    it, a command run three times, and a pair of commands run back to back
    twice. An error signature generalises paths, numbers and quoted values, so
    one failure on two files is one signature.
  - Candidates are not conclusions. Each quotes what was observed, is stored
    with the new status `proposed`, is capped at 0.5 confidence, never reaches
    a context pack, and becomes an instinct through
    `update_instinct(action: "confirm")`. `list_instincts` gained a `status`
    filter to review them; `dry_run` returns them without storing anything.
  - A second run over the same log proposes nothing new: a candidate that
    matches an instinct the store already holds is reported as skipped rather
    than quietly raising that instinct's confidence.
  - The wording is deliberately the user's own, not a paraphrase. The half of
    the observer that needs a model stays with the agent, which confirms the
    candidates and rewrites them with `record_instinct` where they read badly.
- **`list_sessions`**: the handoffs a repository has, newest first, with the
  unconfirmed hook drafts marked and the sessions whose observation log is
  still on disk flagged for `propose_instincts`. `drafts_only` and
  `substantive_only` narrow it.
- **Eleven more rule packs** (`src/core/rules-catalog.mjs`): `vue`, `angular`,
  `react-native`, `fastapi`, `kotlin`, `swift`, `dart`, `csharp`, `cpp`, `php`
  and `ruby` join the eight the catalogue had, each with its own `paths` globs
  and stack labels.
  - The labels they are chosen by are now detected: `nuxt.config.*` or the
    `nuxt` dependency, `angular.json` or `@angular/core`, `build.gradle.kts`
    (Kotlin, alongside Java/JVM), `Package.swift`, `Gemfile`/`Rakefile`/
    `.ruby-version` and `rails` inside them, `artisan` or `laravel/framework`
    and `symfony/framework-bundle` in `composer.json`, `CMakeLists.txt` and its
    neighbours, and the five conventional root files of a .NET repository.
  - `packsForStack` gained its one subtraction: a React Native project no
    longer gets the `web` pack. It shares a library with the browser, not a
    platform — there is no DOM, no CSS and no Core Web Vitals to budget. A
    universal app that also builds for the browser keeps it.
  - `web` already carried ECC's `performance` and `design-quality` rules, so
    those are not separate packs. `perl`, `arkts` and `fsharp` are not written:
    nothing detects them and nothing here could check them (DEBTS Д-16).
- **Git hooks** (`install_agent_hooks` target `git`, `hooks/git-hooks.mjs`):
  a `pre-commit` and a `pre-push` installed through `core.hooksPath`, so the
  same rules apply to a client with no hook API and to a human at a terminal.
  - `pre-commit` scans the staged diff for what change hygiene calls blocking —
    a secret-bearing path, a secret in an added line, a merge-conflict marker, a
    focused test, a left-behind `debugger` or `breakpoint()` — and refuses the
    commit. `pre-push` reports when the active task has no verification or its
    latest one failed. `git_hooks` in `.ai-dev/policy.json` sets each to
    `block`, `warn` (the pre-push default) or `off`.
  - The hooks read the server's own rules from `.ai-dev/hooks/patterns.json`,
    which now also carries the leftover patterns and the placeholder pattern, so
    `password = "correct-horse-battery"` is a finding and
    `password = "REPLACE_ME"` is not.
  - A `core.hooksPath` someone else set is reported, never taken over, and every
    hook in `.git/hooks` that would stop running is named. `agent_hooks_status`
    answers with `git_hooks`, `core_hooks_path` and `git_hooks_active`, the last
    true only when the stubs exist *and* git points at them.
- **Fact forcing** (`hooks/fact-force.mjs`, `fact_force` in
  `.ai-dev/policy.json`, on by default under the `strict` profile): the first
  edit of a file in a session is refused until the agent has put its grounding
  on the record — a `FACTS <path>` block naming the importers, the API the edit
  changes, the data it touches and the instruction it serves — and the first
  destructive command is refused until a `ROLLBACK:` line says how to get back.
  - The refusal quotes the block to write. PreToolUse runs after the turn
    carrying the tool call is written to the transcript, so the facts and the
    edit travel together: the agent writes them, repeats the edit, and the file
    stays grounded for the rest of the session.
  - Eleven groups of command count as destructive — file removal and moves,
    `sed -i`, git history rewrites, `git push`, dependency changes, migrations,
    database writes, infrastructure, permissions, service control. The
    irreversible ones never reach the gate: the guard's hard rules refuse them
    first, for their own reason.
  - Session state lives in `~/.ai-dev/state/guard/<session>.json`: entries
    expire after `expiry_minutes` (30), at most `max_entries` (500) are kept,
    and after `max_denials` (3) refusals in one session the gate stops refusing
    and only notes what was missing.
  - It judges nothing it cannot see: no transcript (Cursor sends a conversation
    id, not a path), unreadable or unwritable state, or a path matching
    `exempt_globs` all leave the call alone. `AI_DEV_FACT_FORCE` and
    `AI_DEV_FACT_FORCE_EXEMPT` override the policy for one run.
- **Documentation freshness** (`docs_stale` in `verify_change_hygiene`): a
  change set that moves the public interface — a new export, an `inputSchema`,
  a command-line flag, in JavaScript, TypeScript, Python, Go, Rust, Java,
  Kotlin, C#, Swift, PHP or a shell script — without touching a single document
  is now a `warn` finding listing the files that did move.
  - Only declarations count. A line inside an exported function does not widen
    the interface, and a flag passed to someone else's program (`--no-color` to
    `git`) is not a flag the project offers, so neither fires the rule.
  - Tests, vendored trees (`node_modules/`, `vendor/`, `dist/`) and the
    documentation itself are not read for interface signals; data files are
    left out too, since a schema key in JSON is as often a fixture as a
    contract. Any `.md`, `.mdx`, `.rst`, `.adoc`, `.txt` or file under `docs/`
    answers the finding, `README.md` and `CHANGELOG.md` included.
  - `summary` gained `interface_files` and `documentation_files`.
- **Task snapshots and rollback** (`src/core/task-snapshots.mjs`,
  `src/extensions/snapshots.mjs`): `snapshot_task`, `list_task_snapshots` and
  `rollback_task` make an agent's turn undoable. A snapshot records the whole
  working tree of a task — tracked changes, staged or not, plus the files the
  agent created — as one commit object no branch points at, held by a ref under
  `refs/ai-dev/snapshots/<task_id>/<n>`.
  - Nothing is written to the user's branch, stash or index. `.gitignore` and
    `.git/info/exclude` decide what a snapshot carries, so dependencies and
    build output are neither stored nor touched.
  - `rollback_task` restores the snapshot's files and removes the ones that
    appeared since, emptied directories included. It snapshots the state it
    replaces first, so a rollback is itself reversible; the snapshot is named by
    id (`snapshot-3`), number, or commit.
  - `checkpoint_task` snapshots the turn it records (`snapshot: false` opts out;
    a project without git reports a reason instead of failing), and
    `complete_task` deletes the closed task's snapshots, reporting how many in a
    new `snapshots` field. The entries stay on the record, marked, so the turns
    remain readable. Automatic snapshots are capped at 50 per task; ones taken
    by name are kept until the task closes.
- **Guard rules without hand-edited JSON** (`src/core/policy-rules.mjs`):
  `list_policy_rules`, `upsert_policy_rule` and `remove_policy_rule` edit the
  `rules` block of `.ai-dev/policy.json` — the rules the installed guard enforces
  on every command and file write.
  - A rule is checked against what the guard actually does with it: the pattern
    is compiled with the guard's own flags, and one that does not compile, an
    event the guard never evaluates, an unknown `action`, or a quantified group
    holding an unbounded quantifier (which would stall the guard on a long line)
    is refused with the reason.
  - A new rule, or a changed pattern, must fire on an `example` the caller
    provides, and must not fire on an optional `counter_example`. The samples are
    stored on the rule, so `list_policy_rules` re-runs them and reports a rule a
    hand edit disarmed. A second rule matching the same text on the same event is
    refused as a duplicate.
  - Updates are patches (`{ id, enabled: false }` disables a rule), `dry_run`
    checks without writing, and `agent_hooks_status` now lists every rule with
    the guard's reading of it plus the problems in the file.
- **MCP server inventory** (`src/core/mcp-inventory.mjs`,
  `src/extensions/mcp-inventory.mjs`): `list_mcp_servers` reads every config a
  client would load — `.mcp.json`, `.claude/settings.json` and
  `settings.local.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
  `.gemini/settings.json` and `.codex/config.toml` (through the new
  `src/core/toml-lite.mjs`, a reader for the TOML subset those files use).
  - One entry per server: the files that declare it, the transport, the
    environment and editor substitutions with whether each variable is set, and
    whether Claude Code starts it without asking.
  - A credential written out in a config file is a `block` finding, masked out of
    the command line and url the report echoes back. Plain HTTP to a remote
    endpoint, an unpinned `npx -y` package, a shell-wrapped command, an entry no
    client can start, `enableAllProjectMcpServers`, a config that cannot be
    parsed, and one server name defined differently in two files are warnings.
  - `include_user_scope` adds the user's own `~/.claude.json` (including its
    per-project block), `~/.cursor/mcp.json`, `~/.gemini/settings.json` and
    `~/.codex/config.toml`; it is off by default.

### Fixed

- **Packaging refused to run for anyone who had used the system.** A server
  without an Obsidian vault runs against the bundled seed and writes project
  cards into it; the seed's own Python helpers leave bytecode behind. Git
  ignores both, but `docker:prepare` copied the seed wholesale and the privacy
  audit — rightly — refused to ship a project card, while `docker:seed:verify`
  read the same files as seed drift. The context is now staged from the seed
  manifest, which is what `docker:seed:verify` already blesses, and the verifier
  skips the two generated zones. Measured on a polluted checkout: prepare goes
  from a refusal to 1188 files, the same as a clean clone, and the verifier
  reports `current` with 1040 files checked.

- **`npm run check` failed about twice in ten runs, and never because of a
  test.** `--experimental-test-coverage` sets `NODE_V8_COVERAGE`, and every
  process the suite spawns — git, python, the installed hooks, the MCP smokes —
  inherited it and wrote its own coverage file into the same directory. A child
  that died before V8 flushed left that file at zero bytes; the reporter parses
  every file in the directory and fell over on it, which is the `# fail 0`
  beside a non-zero exit that Д-11 has recorded since the first stage. Caught by
  running the gate with a coverage directory of its own: the failing run held
  377 files against 376 on every passing one, and the extra file was empty. The
  test setup drops the variable now — this process captured its own path at
  startup, so its coverage is intact and nothing it spawns inherits the
  directory. Measured after: 121 files instead of 376, none empty, line coverage
  unchanged at 97%.

- **A HarmonyOS project got no language rules.** The detector has labelled
  `ArkTS/HarmonyOS` from `oh-package.json5` since the root listing was added,
  and `packsForStack` answered with an empty list — the last of the three packs
  Д-18 recorded as missing. The pack is written from the language's own
  constraints: obligatory types, an object shape fixed at declaration, no
  runtime code generation, a declarative `build()` with no side effects, state
  through `@State`/`@Prop`/`@Link`, heavy work in a `TaskPool` or `Worker`, and
  the Ability lifecycle kept apart from the component's. The test that pinned
  its absence is flipped, and the other direction is now checked too: a label
  the detector gives a language must select a pack.

- **No English task ever reached an imported skill.** The concept table is the
  bridge from Russian to the English the imported catalogue is written in, and
  `pickTaskSpecialist` gave up before scoring anything when the table recognised
  nothing — which is the normal case for a task written in English. Three things
  fix it: the early exit asks whether there is anything to score with rather
  than which half of the vocabulary produced it; a concept now also fires on its
  own English words, but only on the ones that identify it alone (a word two
  concepts share, like `refactor` in both "refactoring" and "red green
  refactor", identifies neither); and a task that names a skill outright is held
  to a lower score than one that has to earn its place by overlapping the
  skill's situation. Measured: `set up test-driven development for this module`
  now reaches `tdd-workflow`, `refactor towards hexagonal architecture` reaches
  `hexagonal-architecture`, `send a notification through gmail…` reaches
  `gmail`, and "поговори с заказчиком" still gets nobody. The routing benchmark
  stays at 37/37.

- **The lifecycle smoke encoded the bug.** It asserted `skills.length <= 3`,
  while the reserved slot is by design offered *beside* the routed three — the
  assertion held only because an English task could never reach a specialist. It
  counts conventional skills and reserved roles apart now.

- **The published image did not start.** `skill-import-policy.mjs` imports
  `public-distribution.mjs`, and the Docker context's allowlist excluded that
  module, so the container died on startup with `ERR_MODULE_NOT_FOUND` and the
  stdio smoke failed on a closed connection. Measured: 84 of the repository's 85
  `src/core` modules reached the image. The exclusion is gone — the privacy
  audit passes over the context with the module in it — and the audit now walks
  the staged tree for imports it cannot resolve, naming the file and the
  specifier, so nothing can be left out of an image again without the check that
  runs before the build saying so.

- **`list_mcp_servers` could not see a Windows project's own servers.** The
  streaming reader for `~/.claude.json` dropped every escape while reading a
  key, and Claude Code keys its per-project block by absolute path — so
  `"C:\\Users\\me\\app"` in the file became `C:Usersmeapp` and matched
  nothing. Keys are kept raw and decoded whole now, which also fixes keys
  carrying quotes, tabs or `\uXXXX`.

- **The hooks keyed their memory under an id the server never reads.** Two
  things differed, and the same CI job measured both. The server hashes a
  project root after resolving it with `fs.realpath`, while the hook copy hashed
  the path it was handed — so a symlink, or the spelling Windows hands out for a
  temporary directory, was enough to disagree. And the server walks up to the
  nearest project boundary (`.git`, `package.json`, and eight more markers)
  before hashing, while the hook hashed exactly the directory it was given: a
  hook fired from a subdirectory of a project wrote its memory where the server
  never looked. Both halves are in the hook now — the boundary walk duplicated
  there deliberately, since that file is copied into other repositories and
  cannot import the server — and `realpathSync.native` is used to match what the
  asynchronous `fs.realpath` does.

- **A pull-request template was reported under a name the repository does not
  have.** On a case-insensitive filesystem the lookup of
  `.github/pull_request_template.md` opens `PULL_REQUEST_TEMPLATE.md`, and the
  answer echoed the spelling that was asked for. It reads the directory and
  answers with the name on disk.

- **A rollback rewrote every line ending on Windows.** Snapshots are captured
  with `git add` and restored with `git restore`, and Git for Windows ships
  with `core.autocrlf=true` — CR stripped going into the object store, CRLF
  written back coming out. So a file the agent wrote with LF came back from
  `rollback_task` with every line changed. Measured by CI on `windows-latest`
  (`'export const app = 2;\r\n'` against the `\n` the test wrote) and
  reproduced on Linux by setting the same option. The snapshot commands now run
  with the conversion off, so the bytes that went in come back out — including
  a file that really is CRLF. The index is still seeded from the repository's
  own, so files nobody touched keep their existing entries.

- **A worktree record carried two spellings of the same path.**
  `git worktree list --porcelain` prints forward slashes on Windows too, and
  the cleanup record put that beside a path built with `path.join`:
  `C:/Users/…/.worktrees/merged` against `C:\Users\…\.worktrees\merged`.
  Comparisons that resolved first were fine; printing and matching the raw
  value was not. Paths now come out of the parser in the platform's own
  spelling, and the same is done for `--absolute-git-dir` in snapshots and for
  `--show-toplevel` in `captureProjectState`, where a git project's
  `project_root` otherwise differed from a non-git one by separator alone.

- **`npm run setup` called stale artefacts "already built".** The plan asked
  whether a file existed, never whether it was current, so one run printed
  `· Search index: already built` and, four lines later from the diagnostic in
  the same run, `fail: skill_routing_benchmark — … is stale; rerun
  run_skill_routing_eval`. Setup now reads the freshness signals the health
  check grades — `search_index_status.stale`, and the benchmark report's mtime
  against its golden cases and `skill-router.mjs` — and rebuilds what is out of
  date, saying so. An optional step that is installed but stale says
  `out of date; --dense rebuilds it` instead of reporting itself installed.

- **`--dense` downloaded 2.3 GB and left search nearly blind.** Documents are
  embedded during a rebuild, and the model download was the last thing the flag
  did, so an install with the weights in place, a live worker and `dense_score`
  in its answers had vectors for 300 documents and 382 waiting — none of which
  the dense half of a hybrid query could see. `--dense` now embeds the index
  after fetching the weights, re-embeds when documents have been added since,
  and the setup header prints the coverage: an index built without the model
  reads `none embedded yet`, not `0 with a vector, 0 without`.

- **The setup header printed an interpreter Windows never creates.**
  `.venv/bin/python` was hard-coded while the step that builds the environment
  looked in both places and worked, so the only thing that was wrong was the
  line a person reads. It is resolved per platform now, from what is on disk
  when something is on disk.

- **A checkout could edit its golden cases and never be told to rerun the
  benchmark.** The freshness check compared the report against
  `09-mcp/search-eval/skill_routing_eval_cases.json`, a path that does not exist
  outside an Obsidian vault, so the missing file's mtime read as zero and the
  report was always "fresh". Measured on this repository: touching the cases
  left `fresh: true` before, and gives `fail … is stale` now. The benchmark and
  the health check read one resolved path.

- **A Python helper's failure was reported as `Traceback (most recent call
  last):`.** The helper explains itself in the last line of the traceback and
  every caller that prints one line prints the first, so `npm run setup --
  --dense` without the embeddings environment reported the word "Traceback" and
  nothing else. The final exception now leads, with the traceback kept behind it
  (`src/core/python-failure.mjs`).

- **`change-hygiene.mjs` was invisible to code search.** Its binary-file check
  was written as a raw NUL byte in the source rather than an escape, so `grep`
  and `rg` answered `Binary file … matches` and 537 lines of the module never
  appeared in a repository-wide search — which is how the byte was found, by a
  search that skipped it. Git was unaffected: its heuristic reads the first 8000
  bytes and the byte sat at 15851.

- **Hybrid search died without the optional model.** The README says it plainly
  — "Hybrid search works without a model: SQLite FTS, sparse aliases, and
  deterministic intent routing are always on" — and the dense embedding call was
  not guarded, so a missing BGE-M3 threw out of the query and took the whole
  search with it. `hybrid_search`, `preset_search` and `explain_search` were
  dead on a fresh install until someone downloaded 2.3 GB. Dense is now the
  optional half it was documented to be: when it cannot run, the keyword and
  sparse ranking answers, and `preset_search` and `explain_search` say why the
  dense half is missing rather than passing off a lexical ranking as a semantic
  one. The dense smoke still fails when dense does not run, which is its job.

- **A freshly built search index reported itself stale.** Every render of a
  skill card stamps `generated_at`, so `rebuild_index` rewrote all 142 of them
  whatever they said, their mtimes moved, and the index built seconds earlier
  came back "stale: 142 changed". Cards are now compared without their stamp and
  left alone when they say the same thing — which also gives `generated_at` the
  meaning a reader expects: when this card last changed. Everything the vault
  writes generated now goes through `atomicWriteIfChanged`, which the repository
  had and nothing used. Measured: `rebuild_index` after a build leaves the index
  fresh, 0 changed.

- **"Playwright Chromium is not fully ready" never said what was missing.** The
  runner knows which of the three pieces is absent, and when the browser binary
  is simply not where Playwright looks it reported an empty `launch_error`. It
  now names the path, says whether `PLAYWRIGHT_BROWSERS_PATH` points somewhere
  else, and gives the install command; the health check repeats the reason
  instead of "not fully ready".

- **Nine tools refused a call that filled every required field.** A JSON Schema
  cannot say "project_path or task_id", so `record_decision`, `list_decisions`,
  `coverage_gaps`, `record_instinct` (project scope), `save_session` (topic or
  building), `record_usage` (tokens or cost) and the three Archify tools that
  take a spec accepted a schema-complete call and then refused it. The
  alternative is now in each tool's description, where a model reads it, and a
  test holds them to it.

- **The required-notes check demanded a layout a checkout cannot have.** Three
  of the six notes it wants live under `09-mcp/` in a vault and in the
  repository's own root in a clone; one exists only in a vault; and one named a
  file — `03-skills-catalog/Skill Cards.md` — that nothing in the runtime has
  ever written. So a healthy source install was told five notes were missing.
  The check now reads each note through the layout it has, requires what that
  layout can carry, and names the catalogue the runtime really renders.

- **`clients:install` could not find the server it installs.** The one command
  the README gives for wiring the server into Cursor, Gemini, VS Code and Claude
  computed its entrypoint as `<vault>/09-mcp/ai-dev-mcp-server/src/server.mjs`.
  From a plain checkout that resolved to `<home>/09-mcp/…` and the command
  refused to touch anything: "Required local paths are missing". It now
  registers the server it is part of, and writes no `AI_DEV_VAULT_ROOT` when
  there is no vault — the server finds the bundled seed on its own. A vault
  install still gets the vault's own copy.

- **Three tools crashed instead of stating their contract.** Called without
  their argument, `search_knowledge`, `search_skills` and `read_skill` answered
  "Cannot read properties of undefined (reading 'toLowerCase')" where every
  other tool answers "query is required." Measured over the protocol: of 62
  read-only tools, 23 answer with no arguments and 39 refuse with a sentence —
  those three were the only ones that broke, and now there are none.

- **The embedding worker's own reason was thrown away.** A worker that cannot
  start says why once, on stdout, before anything is asked of it — "Model
  directory does not exist: ~/.ai-dev/models/bge-m3" — and then exits. The pool
  kept the message and reported only the exit code, so `embed_texts` and
  `hybrid_search` failed with "BGE-M3 worker exited with code 1." and nothing
  else, which is the least useful thing to tell someone who has just installed
  the model. The reason is now carried into the rejection and into
  `embedding_status.workers[].ready_error`.

- **A source install wrote project cards into the repository.** With no vault of
  its own, the runtime falls back to the bundled `docker/public-seed`, and
  `prepare_project` writes a project card there — with the project's name and
  its absolute path. The other generated seed paths are ignored by Git already;
  `02-knowledge/Projects/` was missed, so a clone went dirty the first time
  anyone prepared a project, and `git add -A` would have committed their
  repository names into this one.

- **A checkout without an Obsidian vault could not find its own helpers.** Four
  trees the server runs rather than reads — the SQLite search helper, the
  search-eval cases, the BGE-M3 embedding scripts and the Frontend QA runner —
  were addressed only as `<vault>/09-mcp/<tree>`. A clone of this repository has
  all four in its root and no `09-mcp` at all, and the vault falls back to the
  bundled `docker/public-seed`, which carries notes and skills but no helpers.
  So a fresh clone reported "Search helper not found:
  …/docker/public-seed/09-mcp/search-index/search_cli.py" — a path that can
  never exist there — and semantic search, both search smokes, the skill-routing
  eval and Frontend QA were unreachable without a vault. Each tree is now
  resolved in its own right: the vault layout first, then the repository's, and
  the vault path is what an error names when neither is there
  (`src/core/runtime-assets.mjs`). Measured on a bare checkout: the search
  helper, the embedding worker, the eval cases and the QA runner are all found,
  `frontend_qa_runner` passes, and `search_index_freshness` moves from "helper
  not found" to "the index is stale by 330 notes", which is the next honest step
  rather than a dead end.

- **A security scan read its own findings as a dead network.** `run_security_scan`
  matched the word `proxy` — along with `offline`, `unable to connect` and
  `failed to fetch` — against a scanner's whole output, so an advisory titled
  "…cache-key and proxy interpretation differentials" turned a finished
  `npm audit` into "could not reach the network". This repository's fourteen
  findings, five of them high, came back as `skipped`, and `verify_task` passed
  its `security_scan` check because a skipped scanner cannot block. Offline is
  now decided by the failure channel: machine tokens only (`ENOTFOUND`,
  `ECONNREFUSED`, `getaddrinfo`, npm's own network banner, and the rest), read
  only when the scanner produced no findings at all — one that reported findings
  reached whatever it needed to reach. The report is read alongside `stderr`
  because `npm audit --json` prints its own network failure as a JSON document
  on stdout and still exits 1. The reason now carries the exit code and the
  first line of `stderr` instead of a slice of somebody's dependency tree
  (`src/core/security-scan.mjs`).

- **One slow policy rule cost one budget; thirty cost thirty.** The guard gave
  every rule its own 250 ms and raised a fresh worker after each overrun, so a
  `.ai-dev/policy.json` with thirty catastrophic patterns held a Bash command
  for 8.7 seconds — past the ten at which the client abandons the hook, which is
  the failure the budget existed to prevent. All of an event's rules now share
  one deadline (`POLICY_MATCH_DEADLINE_MS`, 1 s), the remaining budget also caps
  the next rule, and every answer says whether it ran (`checked`). The guard
  prints one line per rule that blew its own budget and one line for everything
  the deadline cut off; `list_policy_rules` marks such a rule `match_not_checked`
  rather than reporting it as matching nothing. Thirty rules: 8.7 s → 1.1 s; an
  honest policy is unchanged (`src/core/regex-budget.mjs`, `hooks/lib.mjs`,
  `hooks/guard.mjs`).

- **A secret in `env` was the one place `scan_agent_config` did not look.** The
  settings scan read only top-level strings, and `env` — how Claude Code puts
  variables into a session — is where a credential actually goes. The document
  is now walked to the leaves, arrays included, and the finding names the path
  (`env.AWS_ACCESS_KEY_ID`, `hooks.PreToolUse[0].hooks[0].command`) with the
  value masked.

- **The most direct way to turn the permission prompt off was not recognised.**
  "Always use `--dangerously-skip-permissions`" named no pattern at all, and
  "Run `npm run dev` automatically … no need to ask" matched neither half of the
  prose rule. Flag literals are now their own blocking rule
  (`instructions_disable_permission_prompt`), a line that forbids the flag is
  not a finding, and the prose covers "no need to ask", "without prompting",
  "skip the confirmation", an imperative "Run … automatically", and their
  Russian halves. `always run …` is gone from the list: "Always run the tests
  before you claim the task is done" waives nothing, and a rule that calls an
  honest instruction a bypass is a rule people stop reading. Fifteen phrasings
  in two languages: seven caught before, fifteen now, with the one false
  positive gone (`src/core/agent-config-scan.mjs`).

- **A half-written `~/.claude.json` read as "this machine declares no servers".**
  The streaming reader checks the first character and nothing else, so a file
  cut off mid-document yielded zero values and zero errors. It now counts
  nesting as it goes: a stream that ends with an object or a string still open
  is an error naming that, and `list_mcp_servers` reports the source as
  unreadable instead of empty (`src/core/json-subset.mjs`).

- **The completion linter's newest rules existed only in English.** Agents here
  report in Russian, so the three rationalizations added for Д-10 — "these
  failures were pre-existing", "marked the criterion met from reading the code",
  "probably fine, I did not run the build" — walked through in the language they
  are actually written in. Their Russian halves are in. `pre_existing_failure`
  also gained an exemption, the second of its kind after "works on my machine
  **and in CI**": naming where it failed and carrying the fix over ("this test
  was already failing on main, and I ported the fix from PR 12") is a report
  with two facts in it, not an excuse. An exemption is read in the sentence its
  match sits in, so an honest sentence cannot cover for an excuse in the next
  one. Twenty-five phrasings: zero missed, zero false positives
  (`src/core/completion-claims.mjs`).

- **Worktree cleanup could not say what it had removed.** `cleanup_task_worktrees`
  stored only the removal outcome, which carries no `name` and no `state`, so a
  report of the cleanup could list paths and nothing else. Each record now
  carries the plan entry as well (`src/core/task-worktrees.mjs`).

- **A rollback called the agent's own files somebody else's.** "Never appeared
  in a snapshot of this task" means "written since the last snapshot", not
  "written by someone else" — and the warning claimed the second. It now says
  the same thing about every deleted file: all of them were written after the
  snapshot, by this task or by anyone else sharing the working tree, and here is
  the command that brings them back. The list that remains is named for what it
  is: `removed_unsnapshotted_files` (with `removed_snapshot_history_complete`),
  the paths for which the undo snapshot is the only record they existed
  (`src/core/task-snapshots.mjs`, `src/extensions/snapshots.mjs`).

- **A skill that says "do not trigger for code review" was picked for a code
  review.** The specialist slot scored the whole of `use_when`, so the sentence
  an author writes about when *not* to use a skill argued in its favour: a
  generalist took the reserved slot on a debugging task and a review task, both
  of which its own text excludes. The exclusion clause is now read separately
  and subtracts what it names — but only terms the rest of the text does not
  also name, since these sentences share their nouns, and never a function word
  (`src/core/task-vocabulary.mjs`). On the eight tasks of the original
  measurement no skill is now offered for a situation it excludes, and the
  database skill wins the migration review.

- **Imported skills could never be recommended.** All 101 skills imported from
  ECC were in the index and none of them ever reached an answer:
  `recommend_skills` returns three skills, deterministic routing fills all three
  with our own, and an imported skill's English `use_when` shares no substring
  with a Russian task. Routing now has reserved roles that do not consume the
  three (`RESERVED_ROUTING_ROLES`): `capability` as before, and a new
  `specialist` — one imported skill whose `use_when` answers the task's
  situation, offered beside the routed core rather than instead of part of it.
  The match runs through a new concept table (`src/core/task-vocabulary.mjs`)
  that translates what a Russian task names into the terms an imported catalogue
  is written in; it names concepts, never skills. A skill that declares an
  ecosystem is penalised when neither task nor project mentions it, and refused
  when the project has a stack and this is not it. Measured on eight typical
  tasks: five ECC skills recommended where there were none, and every task keeps
  the three skills it had.

- **Retired models' prices are marked as unverified.** Six rows in the rate
  table price models the published page no longer lists, so nothing re-checks
  them. They stay — a ledger keeps old events and a report over last quarter has
  to price what ran — but `usage_report` now keeps them out of the per-model
  breakdown (`historical_models` instead of `models`, each with
  `price_basis: "historical"`), reports `usage.historical_cost_usd` as the share
  of the total that rests on them, and says so in `rates.notice`. The totals
  still include them: dropping the cost would make them wrong the other way,
  silently. `include_historical_models` folds them back in. Current models'
  prices are untouched.

- **`list_mcp_servers` parsed the whole of `~/.claude.json` to reach two keys.**
  The same file holds Claude Code's conversation history for every project it
  has opened — tens of megabytes on an active machine. It is now streamed and
  only `mcpServers` and the current project's `projects[<path>].mcpServers` are
  buffered (`src/core/json-subset.mjs`), so another project's history and
  servers are never even recognised. Over two megabytes the report says what the
  read cost instead of hiding it, and a file that does not start a JSON object
  is reported unreadable rather than read as empty.

- **A .NET, F# or Xcode project was invisible to the detector.** Those project
  files are named after the product (`Atlas.csproj`), and the detector checked
  paths rather than listing the root, so `C#/.NET` was inferred from five
  conventional side files and `.csproj`, `.sln`, `.fsproj` and `.xcodeproj` were
  never seen. `createProjectDetector` now takes an injected `readDirectory` and
  reads the root's extensions. New stack labels with it: `F#`, `Perl` and
  `ArkTS/HarmonyOS`, plus rule packs for `perl` and `fsharp` — `arkts` is
  deliberately still unwritten, for the reason recorded in
  docs/DEFECTS.md, Д-18.

- **The static gate's size rules had no test.** Its five branches — a module
  over the ceiling, a pinned module that grew, a pinned module back under the
  ceiling, a pin for a module that no longer exists, and the main module over
  its own ceiling — lived inside the walk over the tree and could only be
  checked by breaking a real file and putting it back. They now live in
  `src/core/line-budget.mjs` as `evaluateLineBudget`, the gate is the input and
  output around them, and a test breaks each branch on its own input and reads
  the real `src/core` and `src/extensions` for zero findings.

- **The completion-statement linter blocked an honest report and missed three
  excuses.** "It works on my machine and in CI: both run the same command" was
  refused, because the "and in CI" exemption was only on the `locally` half of
  the pattern; it is now on both. "unrelated to this task" walked through
  because the rule required the word "change"; "should be fine" because the rule
  knew only "should work"; "I did not run the build" because the rule knew only
  "run the tests". A new `inspection_only` rule catches a criterion marked met
  from reading the diff rather than running it. Measured on fifteen phrasings —
  eight honest ones against a repository where nothing passed, seven excuses —
  kept as a regression test.

- **A rollback deleted files without saying which.** `rollback_task` brings the
  working tree to a snapshot's state, so a file written after it goes — possibly
  one a person wrote from another terminal. The answer now names every deleted
  file in `removed_files`, names again in `removed_unfamiliar_files` those the
  task has never snapshotted (the ones most likely not to be its work), and
  carries a `warnings` line saying how many went and which undo snapshot brings
  them back. Whose a file is cannot be told, and the answer does not claim to:
  it states what is checkable, and refuses the split rather than guessing when a
  snapshot's recorded file list was truncated.

- **A single policy rule could take the guard out of service.** A pattern that
  backtracks catastrophically — `(a|a)+$` needs 38.8 seconds against
  twenty-eight characters — passed `upsert_policy_rule`, and after that the
  guard stalled on every Bash command and every file write, because Node cannot
  interrupt a match in progress. Policy-rule matching now runs in a worker
  thread under a 250 ms budget with the input clamped to 4 KiB
  (`src/core/regex-budget.mjs`, mirrored in `hooks/lib.mjs` for the hook pack):
  a pattern that overstays is reported as unevaluated instead of never
  answering. `upsert_policy_rule` additionally refuses such a pattern up front
  by running it against input built from its own alphabet, so the refusal does
  not depend on recognising a pattern shape.

- The agent hook pack is now a working implementation rather than a condensed
  port. Three hooks did nothing at all before:
  - **File guard.** In `guard.mjs` the `else` branch holding every file-mode
    check was chained to the `if` *inside* the loop over shell patterns, so in
    `file` mode — where that loop never runs — the secret-bearing-file,
    secret-in-content and protected-configuration checks were unreachable.
    File mode now has its own branch and its own tests.
  - **Compaction advisor.** `compact-advisor.mjs` counted tool calls in a
    module-level variable, but the hook is a fresh process per call, so the
    counter was always 1 and the advisor never fired. The count is now
    persisted per session, and the primary signal is the real context size read
    from the transcript's most recent `usage` record, compared against the
    model's window.
  - **Session-end extraction.** `session-end.mjs` wrote a fixed stub record
    ("Hook-captured session") whatever the session contained. It now distils
    the transcript into user requests, tools used and files modified, and
    writes nothing when there is nothing to record.

### Changed

- The main module's line ceiling dropped to match what the extractions left
  (stage 1.7, which closes stage 1). `SYSTEM_LINE_CEILING` in
  `core/system-health.mjs` — the one place the gate and the System Dashboard
  both read — went from 10,150 to 5,076: the file's actual 4,776 lines plus 300
  of working room. The ratchet holds in one direction, so `mcp-stdio.mjs` can be
  edited but not re-grown; new capabilities belong in `src/extensions/`.
  - All five line-budget rules were verified by breaking each one deliberately
    against a throwaway module and reverting: an unpinned module over 800 lines,
    a pinned module grown past its allowance, a pinned module back under the
    ceiling, a `MODULE_LINE_EXCEPTIONS` entry whose module is gone, and the main
    module over its own ceiling. Both real pinned entries stayed:
    `core/frontend-product-quality.mjs` (1,222) and `core/reference-factory.mjs`
    (812) are still over the ceiling, and the comment claiming stage 1.3 would
    split them was corrected — that step built on top of them rather than out of
    them.
  - A system-health fixture pinned at a literal 9,800 lines became
    `SYSTEM_LINE_CEILING - 350`, so it keeps meaning "inside its budget" whatever
    the ceiling is.
- The task lifecycle moved out of `mcp-stdio.mjs` (stage 1.6 of the modularity
  plan, the last extraction step). `begin_task`, `checkpoint_task`, `verify_task`
  and `complete_task` became `src/extensions/lifecycle.mjs`, and the judgements
  under them became two tested modules in `src/core`: `task-verification.mjs`
  (whether a run passed, and which acceptance criteria it is evidence for) and
  `task-completion.mjs` (the completion note and what is left to do with the
  branch). Everything the four tools drive — the completion-claims linter, the
  plan gate, change hygiene, the context pack and its extras, evidence binding,
  skill outcomes, the Archify receipt store and the project-card writers —
  arrives through the extension host, and the four sibling tools they call
  (`recommend_skills`, `run_quality_gate`, `run_frontend_qa`,
  `prepare_pull_request`) arrive as host wrappers over the registry rather than
  through `callTool`, so a composed run still records one usage-ledger entry for
  the tool the client asked for and none for the work it delegated. Tool
  behaviour, response bytes, generated project and vault files, the task and
  usage state on disk, and the 116-tool list are unchanged; `mcp-stdio.mjs` lost
  a further 458 lines (5,233 → 4,775), which leaves it 5,243 lines below the
  10,018 it started at and past the plan's target of under 6,000.
  - `ARCHIFY_EVIDENCE_SCHEMA` left `tool-definitions.mjs` with the two tools
    that used it, so no tool definition is now shared across the two files.
- Project work moved out of `mcp-stdio.mjs` (stage 1.5 of the modularity plan).
  `run_quality_gate` became `src/extensions/projects.mjs`, and the pure half of
  project handling became four tested modules under `src/core`:
  `project-detection.mjs` (`detectProject` over an injected filesystem),
  `project-cards.mjs` (the registry card renderer and its section reader),
  `project-markdown.mjs` (the tables, bullet lists and section readers every
  generated project document shares) and `quality-gate-runner.mjs` (parsing a
  gate file, choosing what to run, and the verdict over a run). `detectProject`
  is a service rather than a tool — `begin_task`, `compile_project_context`, the
  card writers and four extensions call it — so it stays on the extension host;
  `mcp-stdio.mjs` binds it to the real filesystem and nothing else. Tool
  behaviour, response bytes, generated project and vault files, and the 116-tool
  list are unchanged; `mcp-stdio.mjs` lost a further 1,191 lines (6,424 → 5,233).
  - `detectProject` reads its filesystem through injected functions, so stack
    detection, the command fallbacks and the risk rules are now tested against a
    fixture tree instead of a repository on disk.
  - Two symbols no longer referenced by anything went with the move: a second
    `markdownList` and `buildProjectCardMd`, the flat card renderer that
    `buildRichProjectCardMd` replaced.
- Search moved out of `mcp-stdio.mjs` (stage 1.4 of the modularity plan). All
  thirteen search tools became `src/extensions/search.mjs`, over four modules in
  `src/core`: two services — `search-index.mjs` (the sqlite index, its freshness
  and the hybrid merge) and `embedding-workers.mjs` (the BGE-M3 worker pool and
  the one-shot fallback) — and two pure ones, `search-runtime.mjs` (presets,
  weight normalization, score explanations) and `search-eval.mjs` (the
  golden-case verdicts and ranking metrics). `csvValue` joined
  `core/text-format.mjs`. Both services are built once by `mcp-stdio.mjs` and
  shared: the system extension's health checks and every writer that calls
  `markSearchIndexDirty` reach them through the host. Tool behaviour, response
  bytes, generated vault files and the 116-tool list are unchanged;
  `mcp-stdio.mjs` lost a further 1,354 lines (7,778 → 6,424).
  - Both services take their process launchers as dependencies, so the worker
    protocol, the index freshness logic and the hybrid merge are now tested
    against stubs instead of a Python runtime and a 1024-dimension model.
- Frontend tools moved out of `mcp-stdio.mjs` (stage 1.3 of the modularity plan).
  Six tools left with their definitions, split by what they are for:
  `src/extensions/frontend-design.mjs` carries the Reference Factory
  (`plan_frontend_references`, `register_frontend_references`) and
  `generate_ui_ux_design_system`; `src/extensions/frontend-qa.mjs` carries
  `run_frontend_qa`, `run_visual_reference_qa` and `record_visual_review`. Their
  pure half became two tested modules under `src/core`:
  `reference-factory-artifacts.mjs` (manifest file paths, the registry entry, PNG
  structure and the artifact verdicts) and `frontend-qa-report.mjs` (the runner's
  input contract, the Markdown report, the review artifact list and the strict
  visual verdict). `mdCell` joined `core/text-format.mjs`. The frontend product
  state readers stay in `mcp-stdio.mjs` and reach the extensions through the
  host, because `compile_project_context`, `verify_task` and the product tools
  that have not been extracted yet all read them. Tool behaviour, response bytes,
  generated project and vault files, and the 116-tool list are unchanged;
  `mcp-stdio.mjs` lost a further 1,048 lines (8,826 → 7,778).
  - `run_frontend_qa`, `run_visual_reference_qa` and `record_visual_review` now
    have tests in a standalone checkout: the extension is driven against a
    deterministic stand-in for the browser runner, so the orchestration around
    Playwright is covered where the live-browser test is skipped.
- Skill registry tools moved out of `mcp-stdio.mjs` (stage 1.2 of the modularity
  plan). `rebuild_index`, `validate_skill_library` and `recommend_skills` are now
  one extension, `src/extensions/skills.mjs`, reaching the vault, the collectors
  and the embedding backend through the extension `host`; their definitions moved
  with them out of `tool-definitions.mjs`. The pure half became five tested
  modules under `src/core`: `skill-catalog.mjs` (generated-note paths and the
  item predicates), `skill-cards.mjs` (card rendering), `skill-registry-docs.mjs`
  (registry files and their Markdown), `skill-quality-report.mjs` (the validation
  verdict and its dashboard), `skill-recommendation.mjs` (task intent and
  ranking), plus `text-format.mjs` for the text primitives they share.
  `applySkillOverlays` joined `src/core/skill-overlays.mjs`. Tool behaviour,
  response bytes, generated vault files and the 116-tool list are unchanged;
  `mcp-stdio.mjs` lost 1,192 lines (10,018 → 8,826).
- Session and instinct memory is shared across the worktrees of one clone.
  `repository_id` is now derived from `git rev-parse --git-common-dir` (plus the
  project's path inside its worktree), which is identical in the main checkout
  and in every linked worktree, and `SessionStore`, `InstinctStore`, the
  context-extra providers and the `session-start` / `session-end` hooks key
  memory by it — so a handoff saved inside a `begin_task_in_worktree` worktree
  resumes from the main checkout and back. Tasks stay keyed by `project_id`, so
  they remain bound to the working tree they were started in. Records written
  under the old `project_id` are still read and move to the repository key on
  the first write. `repository_id` was previously a hash of the `origin` remote,
  which is still reported as `git.remote` by `project_identity`.
- Package-manager split is now explicit: `packageManager` fields plus a
  `CONTRIBUTING.md` policy section pin `ai-dev-mcp-server/` to npm and
  `frontend-qa/` to pnpm. `resolveSpawnInvocation` no longer silently runs an
  npm command through a bundled pnpm entrypoint — it fails closed instead.
- `npm run docker:audit` now prints a clear "run `npm run docker:prepare` first"
  message when the build context is missing, instead of an `ENOENT` stack trace.
- Minimum Node.js is now 22.12 (was 24). No Node 24-only API is used; `.nvmrc`
  pins `22`, `bootstrap.ps1` accepts 22.12+, and CI adds a Node 22.12 floor job
  (lint + core tests) alongside the Node 24 gate.

### Fixed

- The test suite is isolated from the developer's real `~/.ai-dev` tree: every
  `node --test` run loads `test/setup.mjs`, which pins the `AI_DEV_*` runtime
  roots (task/skill/pilot state, search index, Frontend QA and Archify
  artifacts, model dir) to a throwaway temp directory and exports
  `PYTHONDONTWRITEBYTECODE=1`.
- Python helpers (`search_cli.py`, `bge_m3_worker.py`, `bge_m3_embed.py`, the
  UI/UX Pro Max search script) run with `-B`, so `query_ui_ux_knowledge` and
  friends no longer drop `__pycache__/*.pyc` into the checked-in public seed and
  break the next `npm run docker:prepare`.
- `copyDistributionTree` skips forbidden runtime directories (`__pycache__`,
  `.venv`, `node_modules`, …) while copying, so a stray directory left behind by
  a local tool run can no longer fail the Docker context privacy audit.

### Fixed

- Privacy-audit term gathering no longer aborts when `os.userInfo()` throws.
  `ownerUsername()` falls back to `USER` / `USERNAME` / `LOGNAME`, so
  `bootstrap.sh --build-local` (which runs the context scripts inside
  `docker run --user "$uid:$gid"`) works on macOS and on any Linux host whose
  uid is not the image's baked-in `1000`.

### Fixed

- Command policy (`run_quality_gate` / `verify_task` / Frontend QA dev servers)
  now positively allowlists every argument: it rejects code-loading and
  output-redirecting flags (`--require`, `--import`, `--loader`,
  `--test-reporter`, `-c`/`-e`/`-p`, `--config`, `--prefix`/`--dir`/`--cwd`,
  `--output`, `go test -exec`, `cargo test --config`, …), inline Python fused
  with `-c` (`python "-cimport os;…"`), Python scripts referenced by absolute
  path or `..`, package-script "names" that are file paths, and `git diff
  --check` with any flag other than `--cached`/`HEAD`. Executables and path
  operands must resolve inside the project; `validateProjectExecutable` now also
  rejects relative executables (`../../tmp/evil/pytest`), not just absolute ones.

### Fixed

- `path-policy` no longer lets a write pass through a symlink whose target lives
  outside the trusted root: a final-component symlink is `lstat`-checked, and a
  dangling one is rejected with a `PathPolicyError` instead of being treated as
  a new file. The async `resolveWithin` now raises a `PathPolicyError` (not a
  raw `ENOENT`) when a dangling link or a missing path is read.

### Fixed

- Completion evidence is now bound to file *contents*, not just `git status`
  output: `captureProjectState` hashes every dirty/untracked file into the
  fingerprint, so editing an already-dirty file after `verify_task` invalidates
  the evidence. A non-git project directory now gets a real bounded
  `path/size/mtime` fingerprint (strength `medium`) instead of a constant hash
  of its path.
- `complete_task` now honours **only the most recent** verification: it must
  exist, must have passed, and must match the current project fingerprint. A
  later failed run, an edit after the last passing run, or a second completion
  of an already-complete task is refused with a specific message.

### Fixed

- `execFileWithInput` (Frontend QA runner, UI/UX helper) now bounds captured
  output at 16 MiB, kills the whole process group on timeout or overflow so a
  Playwright Chromium or dev server is not orphaned, guards against a
  double-settle, ignores `stdin` `EPIPE`, and decodes stdout/stderr from a
  buffer so multi-byte characters are no longer corrupted at chunk boundaries.

### Fixed

- `ensureSearchIndex` claims the in-flight refresh slot before its first
  `await`, so concurrent search calls join one rebuild instead of each
  starting their own `search_cli.py rebuild` on the same SQLite file. A
  "dirty" reason raised while a rebuild is running is no longer cleared, so
  the next search still rebuilds.

### Fixed

- `verify_task` no longer trusts client-supplied Archify quality numbers. Every
  real `archify_deliver` / `archify_visual_check` run now writes a server-owned
  receipt (keyed by the artifact's SHA-256) under
  `~/.ai-dev/state/archify-receipts`; delivery-criterion validation hashes the
  file on disk, looks up that receipt, and evaluates the showcase bar against
  the recorded numbers. A forged evidence entry with no matching receipt fails
  the check.

### Fixed

- The skill-outcome and pilot stores no longer strand every future write after a
  single failed `update` (for example a transiently corrupt state file): the
  internal serialisation chain is always recovered, while the failing caller
  still sees the real error.

### Fixed

- Hybrid search no longer fails when the local BGE-M3 dense backend is missing.
  `hybrid_search`, `preset_search`, `explain_search`, and `run_search_eval` now
  pre-check the worker script, Python runtime, and model weights, fall back to
  keyword/sparse ranking, and report a `dense_available: false` warning instead
  of throwing "BGE-M3 Python runtime not found". Keyword-only ranking can be
  forced with `AI_DEV_DENSE=off`.

### Fixed

- A crashed BGE-M3 embedding worker no longer takes the whole MCP process
  down: `getBgeWorker` handles `stdin` `error` (EPIPE), a worker that reported
  a failed model load is rejected immediately instead of after the request
  timeout, and idle workers are reaped after ten minutes.

### Fixed

- `verify_change_hygiene` findings now use one shape everywhere:
  `{ rule, severity, file, line, message, excerpt }`. The tool returned `code`
  and `path` while the docs and the `verification-loop` skill spoke of `rule`
  and `file`, so an agent following the skill read `undefined`. `excerpt` is
  always present, a schema test pins the field list, and the docs, the tool
  description and the skill were corrected.

### Fixed

- `save_session` accepts both spellings of the failure reason. ECC's
  save-session prompt (and its worked example)
  writes `failed: [{ approach, why }]` while the schema said `reason`, so the
  explanation was silently dropped and `resume_session` printed "reason not
  recorded". `why` is now normalized into `reason`; the examples and the file
  states in them (`status`, not `state`) match the schema.

### Fixed

- `usage_report` counts every tool call, not only the ones that arrived over
  MCP. Recording moved from the `server.mjs` transport into `callTool` itself,
  so calls from `scripts/ai-dev.mjs`, the smoke scripts and tools composed from
  other tools are in the ledger too; the transport only passes its own overhead
  as `transportMs`. One call is still exactly one event — pinned by a test that
  compares a direct call, a call through the transport, and a failure.

### Added

- `install_project_rules` target `claude-md`: instead of copying the rules into
  `.claude/rules`, it writes an `## Engineering Rules` section into `CLAUDE.md`
  that imports the canonical files with `@.ai-dev/rules/common/<rule>.md`, which
  Claude Code expands at session start. One line per file, because an import is
  a path and not a glob; path-scoped packs stay listed as plain paths. The
  target is opt-in — it replaces the `claude` target rather than adding to it,
  and asking for both returns a warning.

### Fixed

- The agent hook tests run in the Windows CI job, and the hooks work there. The
  pack runs on the developer's machine, so Windows is a first-class target:
  `.github/workflows/ci.yml` gained an "Agent hook tests" step
  (`src/core/agent-hooks.test.mjs` and `src/extensions/hooks.test.mjs`), and
  three Windows-only path bugs are fixed rather than skipped.
  - `projectRootOf` resolves the root with `fs.realpathSync` instead of
    `fs.realpathSync.native`. The server resolves it with `fs.realpath`, and the
    native variant additionally expands 8.3 short names on Windows
    (`RUNNER~1` → `runneradmin`), so hook and server keyed two different
    `project_id`s for the same repository — the hook's handoffs and instincts
    landed where the server never looked.
  - Project paths are compared with a new `samePath` helper (case- and
    separator-insensitive on Windows), so `session-start` and `stop-check` find
    the project's open tasks.
  - `session-end` writes repository-relative paths with `/` separators, so a
    captured handoff lists `src/login.js`, not `src\login.js`.
  Temp-directory cleanup in those tests retries, because Windows holds handles
  on freshly written git objects for a moment.

### Fixed

- Intermittent failure in `src/extensions/system.test.mjs` (roughly two runs in
  ten under load): the fixture wrote the skill-routing report before the eval
  cases it is compared against, so whenever the two writes landed in different
  milliseconds the `skill_routing_benchmark` check called the report stale, that
  critical check failed, and the health status came out `fail` instead of
  `degraded`. The cases are written first now, and the report's mtime is
  pinned a minute ahead of them — ordering alone still left the two writes in
  the same millisecond on an idle machine.

## [1.0.0] - 2026-09-01

First tagged release.

### Added

- Local `stdio` MCP server (`@modelcontextprotocol/sdk`) exposing repository
  context, a knowledge base, a managed skill library, hybrid search, quality
  gates, Frontend QA, and a verifiable task lifecycle
  (`begin_task` → `checkpoint_task` → `verify_task` → `complete_task`).
- Hybrid search: SQLite FTS, sparse aliases, deterministic intent candidates, and
  an optional local BGE-M3 reranker.
- Public skill seed under `docker/public-seed` (system rules, prompts, quality
  gates, custom workflow skills, MIT-licensed design knowledge).
- Multi-arch Docker image published to GHCR with SBOM and provenance, a hardened
  default runtime (no network, non-root, read-only rootfs, no capabilities), and
  an allowlisted build context that never includes a personal vault.
- Cross-platform bootstrap (`bootstrap.ps1`, `bootstrap.sh`), a fast-start
  launcher / `ClaudeMcpProxy`, Arch `PKGBUILD`, and a Homebrew formula.
- `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/RECOVERY.md`; JSDoc types for
  every exported `src/core` function; ~86% line coverage on `src/core`.
- CI: static-quality, security, packaging, and vault-free unit gates (`ci.yml`);
  a `vault-suite` job runs the full vault-coupled test suite plus the protocol and
  lifecycle smokes against the bundled seed; privacy-policy, context-audit,
  image-build, and GHCR publish (`docker-publish.yml`).
- `npm run skills:ensure-index` / `scripts/ensure-skill-index.mjs`: builds the
  bundled seed's skill registry on demand so a standalone checkout can route
  skills.
- English `README.md` (Russian preserved at `README.ru.md`), and root
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, and this changelog.
- BGE-M3 weight-download instructions for the source and Docker paths.
- `.nvmrc` pinning Node 24.

### Changed

- Agent-neutral runtime: regenerable data resolves under `~/.ai-dev`
  (`AI_DEV_HOME`) with per-directory `AI_DEV_*` overrides and a `~/.codex`
  fallback for migrated installs. Launchers, helper scripts, the Docker image,
  and the client installer use `node` / `python3` from `PATH`. Documentation and
  the shipped `mcpServers` snippet are client-neutral.
- Vault root resolution: a checkout with no full vault falls back to the bundled
  `docker/public-seed`, so the server and tests work from source without
  `AI_DEV_VAULT_ROOT`. `npm run check` provisions the seed skill registry first,
  so it passes on a fresh clone.

### Fixed

- Vault-coupled tests that require the full production skill catalog or the
  Playwright frontend-qa runner now `skip` when those fixtures are absent instead
  of failing a standalone checkout.
- `buildDockerClientServerConfig` resolves `AI_DEV_PROJECT_PATH` with the path
  API for the requested `platform`, so a Windows client config generated on a
  non-Windows host is no longer mangled; the installer tests pin `platform`
  explicitly instead of relying on `process.platform`.

### Changed

- The `.cursor/hooks.json` adapter is versioned and its contract is pinned.
  `CURSOR_HOOKS_CONTRACT` records the format version the adapter writes, the
  date it was checked, the sources it was checked against, and the limits that
  follow from it; `cursorHooksDocument(profile, { version })` dispatches to a
  builder per format version and refuses an unknown one, so the next Cursor
  format gets its own builder instead of a silent rewrite of this one.

  What the 2026-09-10 check actually established, since `cursor.com` is
  unreachable from the sandbox this ran in and no live Cursor was available:
  the format version and the deny shape are **corroborated** — two independent
  secondary sources agree that Cursor declares `"version": 1` and that a
  blocking hook answers `{"permission":"deny"}` with optional `userMessage` /
  `agentMessage`. The **event names are not**. The JSON schema published by the
  source package (`johnlindquist/cursor-hooks`) allows exactly six events —
  `afterFileEdit`, `beforeMCPExecution`, `beforeReadFile`,
  `beforeShellExecution`, `beforeSubmitPrompt`, `stop` — with
  `additionalProperties: false`, and mentions `sessionStart`, `sessionEnd` and
  `preCompact` nowhere. Those three are exactly what this adapter registers for
  session memory. Either that package (v0.1.0, last touched 2025-10) lags
  Cursor 3.x, or the three registrations are inert and Cursor-side session
  memory never runs — which would also make the unconfirmed-draft handling
  below dead on Cursor, since no draft would ever be captured. `stop` is a
  documented event and is the obvious home for the capture if it comes to that.
  This is a reconstruction from secondary sources, not a verification: settle it
  against a real Cursor before trusting the Cursor memory story.
  `CURSOR_HOOKS_CONTRACT.verification` records the same, claim by claim, so the
  distinction survives in the code and not just here. The tests pin what the
  adapter writes, so a change still fails CI rather than the user's install.
- `install_agent_hooks` reports what the merge could not decide instead of
  writing over it: a `.cursor/hooks.json` that declares another format version,
  and events where a foreign hook is registered ahead of ours (on the
  unverified premise that Cursor runs the first entry of an event, so that one
  would shadow the guard; the warning costs nothing either way). `agent_hooks_status`
  reports the installed file's `cursor_format_version` and whether this adapter
  builds it.
- Hook-captured sessions are drafts, not handoffs. `session-end.mjs` writes
  `confirmed: false`, and every reader says so: `resume_session` returns
  `unconfirmed: true` plus the drafts still waiting, its briefing opens with
  "UNCONFIRMED HOOK DRAFT — the Stop/PreCompact hook distilled this from the
  transcript" and does not invent a next step the hook cannot know, and the
  `session-start` context injection carries the same caveat — as does the
  compiled context pack, whose handoff section is titled "unconfirmed hook
  draft" when the newest record is one. `save_session` with
  `confirm_hook_draft: true` promotes one: the agent's fields win, the draft
  fills the rest, the stored record is marked `confirmed` with `confirmed_from`,
  and the draft file is deleted so nothing is offered as unconfirmed twice.
  Records written before the flag existed are treated as drafts — they came from
  the same hook.

### Fixed

- `compact-advisor.mjs` reads the context size from the newest **assistant**
  message in the transcript. It scanned for any entry carrying a `usage` field
  and took the first one it found from the end, so a subagent's turn
  (`isSidechain: true`, billed against its own window) or a non-assistant record
  could set the number the advice was based on — and the tail slice's first,
  half-read line was parsed as if it were whole. Parsing moved into
  `hooks/lib.mjs` (`latestAssistantUsage`, `contextWindowFor`,
  `compactSettings`, `contextThresholdFor`) and is unit-tested against a
  transcript fixture. Every threshold is now settable in `.ai-dev/policy.json`:
  `compact_tool_threshold`, `compact_tool_interval`,
  `compact_context_threshold` (absolute; 0 derives it from the window),
  `compact_context_thresholds.standard` / `.large`, `compact_context_window`
  and `compact_context_interval`, each falling back to its default when the
  value is missing or not a positive number.

[3.0.0]: https://github.com/stonebridgeway/ai-dev-system/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/stonebridgeway/ai-dev-system/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/stonebridgeway/ai-dev-system/releases/tag/v1.0.0
