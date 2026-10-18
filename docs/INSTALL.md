# Install

[← README](../README.md) · [Workflow](WORKFLOW.md) · [Capabilities](CAPABILITIES.md) · [Guard rails](GUARDRAILS.md)

Every supported path: running it locally from a clone, the packaged Docker path,
wiring up each client, and the local dense model. If you only want to get
started, the commands in the [README](../README.md#install) are enough.

## Contents

- [Requirements](#requirements)
- [Quick start: run it locally](#quick-start-run-it-locally)
- [From the npm package](#from-the-npm-package)
- [The Windows installer](#the-windows-installer)
- [One command on Windows](#one-command-on-windows)
- [One command on macOS and Linux](#one-command-on-macos-and-linux)
- [The packaged path: Docker](#the-packaged-path-docker)
- [Connecting AI agents](#connecting-ai-agents)
- [Docker Compose](#docker-compose)
- [The local model in a container](#the-local-model-in-a-container)
- [Publishing for a team](#publishing-for-a-team)
- [Arch / AUR and Homebrew](#arch--aur-and-homebrew)
- [Updating an earlier install](#updating-an-earlier-install)
- [Verification and diagnostics](#verification-and-diagnostics)

To start an agent with a narrowed tool surface, add `AI_DEV_PROFILES` to the
`env` block of any client configuration below — see
[Capabilities](CAPABILITIES.md).

## Requirements

To run it locally — the path this page recommends — you need Node.js 22.16+ (or
24+) and npm, and nothing else. All of search runs in Node, on `node:sqlite`: the
index, keyword and hybrid search, `search_knowledge` and the knowledge galaxy.
Node 22.13–22.15 and 23.x ship `node:sqlite` without the FTS5 the index needs;
there the server starts, and every search tool answers with the Node version it
needs.

Python is optional. `query_ui_ux_knowledge` and `generate_ui_ux_design_system`
run the UI UX Pro Max dataset's own Python script (`python3`; `python` on Windows;
or whatever `AI_DEV_PYTHON` names). Without Python those two tools answer with
what to install, the health check marks `ui_ux_knowledge` skipped, and nothing else
changes. The local model needs no Python either: 3.0 removed the Python dense
backend (see [Coming from the Python backend](#coming-from-the-python-backend)). On Windows you can use the bundled runtime
described in the [server README](../ai-dev-mcp-server/README.md).

For the packaged path you need Docker instead:

- Docker Desktop (Windows / macOS) or Docker Engine (Linux), running — bootstrap checks for it
  and says where it comes from, it does not install it;
- Docker must have access to the project folder you choose.

## Quick start: run it locally

From the clone root:

```bash
cd ai-dev-mcp-server
npm ci
npm run setup
```

`npm ci` runs no dependency install scripts: the package's `.npmrc` turns them off. The one that
matters, onnxruntime-node's, downloads a CUDA provider the server never loads and fails offline
or behind a proxy (docs/DEFECTS.md, Д-86); `npm install` behaves the same.

`npm run setup` builds the three things a clone does not ship — the skill
registry, the search index and the routing benchmark — and prints the health
check. The container builds the same three on its first start, from the same
code, so the two paths cannot end up with different installs. Add `--frontend-qa` for the QA runner's dependencies, `--model` for the
local BGE-M3 model and the embeddings built with it (about 600 MB); neither runs
unless asked. `--frontend-qa` installs exactly `frontend-qa/pnpm-lock.yaml` with the pnpm
version the runner pins (fetched through `npm exec`; no pnpm on your PATH is needed), then the
Chromium build that Playwright wants, and reports success only when that browser starts. It
needs `registry.npmjs.org` and Playwright's download host; behind a mirror, set
`PLAYWRIGHT_DOWNLOAD_HOST`. No Obsidian vault is needed: without one the server reads the
bundled seed and its helper trees from the repository itself.

At a terminal, `npm run setup` then asks three questions: connect the AI clients it
found here, download the local model, install Frontend QA. `--yes` answers them with the
defaults — clients yes, both downloads no — and `--clients=<names>`, `--no-clients`,
`--model` and `--frontend-qa` answer them ahead of time. With neither a terminal nor
`--yes` (CI, a pipe), no client config is touched unless `--clients` names some. Restart
the clients it connected; that is the whole install. What connecting a client writes,
and how to take it out again, is in [Connecting AI agents](#connecting-ai-agents).

Every step is a command of the `ai-dev` CLI as well — from a clone,
`npm run ai-dev -- <command>`; `npm link` once puts `ai-dev` itself on your PATH:

| Command | What it does |
| --- | --- |
| `ai-dev setup` | The above (`npm run setup`). |
| `ai-dev clients list \| install \| remove \| doctor` | The `ai-dev` entry in each client (`npm run clients:install`). |
| `ai-dev model status \| install \| import \| verify \| remove \| doctor` | The local model (`npm run model -- …`, `npm run dense:doctor`). |
| `ai-dev mcp` | What a client starts: its stdio MCP session, served by the daemon below. |
| `ai-dev daemon start \| stop \| status \| run` | The one warm server every client is handed to (`npm run daemon` is `run`). |
| `ai-dev doctor` | The health check, as JSON (`npm run doctor`). |
| `ai-dev help [command]` | Every command and its options. |

Exit codes are the same for every command: 0 done, 1 failed, 2 wrong usage, 130 stopped
with Ctrl-C. A mistyped command or option is answered before anything is read or moved.
`node ai-dev-mcp-server/scripts/ai-dev.mjs`, the 2.x CLI, still runs every command, with
a note on stderr, until 4.0.

How a client is served — the protocol is the same either way:

| | |
| --- | --- |
| `ai-dev mcp` | What `clients install` configures. It hands the client to the **daemon**: one warm server for every client of this user, started by the first client and gone after 30 minutes without one (`AI_DEV_IDLE_TIMEOUT_MS`). The index and the model are in memory once, not once per client, and the state has one writer. The handshake passes through, instructions included, and each session runs in its own client's environment — PATH, proxy, certificates. Clients whose code, Node or data differ (another copy of AI Dev, another Node, another `AI_DEV_VAULT_ROOT`) get a daemon each; two spellings of one folder are one. A daemon that dies is replaced at the client's next request; when none can start, the client is served in its own process and stderr says why. |
| `AI_DEV_DAEMON=0` in a client's `env`, `npm start`, a 2.x entry (`node …/src/server.mjs`) | One stdio process per client, as in 2.x. |
| `ai-dev daemon status \| stop \| start \| run` | Its pid, sessions, memory and log (`~/.ai-dev/logs/daemon.log`), and every other daemon of the runtime home with why it is another; `stop` ends them all — a client's next request starts a new one; `run` serves in a terminal. |

The daemon's address is drawn at random on every start and written, with a secret, to
`~/.ai-dev/run/daemon-<build>.json`, which only you can read; each connection proves it holds the
secret and the daemon proves it back (see
[SECURITY.md](../ai-dev-mcp-server/docs/SECURITY.md#the-daemon)). A home whose path is too long
for a socket puts it in `$XDG_RUNTIME_DIR/ai-dev` or `/tmp/ai-dev-<uid>` instead.

**Settings.** `~/.ai-dev/config.json` keeps what the desktop app — or the `settings_set` tool —
changes: the capability profiles (`AI_DEV_PROFILES`), the model mirror (`AI_DEV_MODEL_MIRROR`), the
model's folder (`BGE_M3_ONNX_DIR`), the daemon's idle time (`AI_DEV_IDLE_TIMEOUT_MS`, in minutes
there), the projects folder, autostart and the interface's language. Every `ai-dev` command started
afterwards — and so every client `clients install` connected, and the desktop app's connection to
the daemon — reads it, and a variable set in the environment still wins. `settings_set` says when
each change takes effect: a mirror from the next download on, in the same session too; a model folder
or the profiles in sessions started afterwards — the daemon's search loaded its folder when it
started, so a client reconnects to use the new one, and a daemon for it starts; the idle time when
the daemon starts next. Until then `settings_get` gives what the session uses and lists the change as
`pending`, and the model tools refuse to put a model in the folder the session is leaving. A value
is checked before it is stored; one that is no longer valid is reported by `settings_get` and not
used. The profiles are what every agent client without its own `AI_DEV_PROFILES` gets, so they
cannot include the opt-in `control`. The tools an app drives the install with — its status,
setup, the model, the clients, logs, settings — are the opt-in `control` profile:
[CONTROL-API.md](../ai-dev-mcp-server/docs/CONTROL-API.md).

**Why local first.** The dense model is the reason. Locally it is one flag —
`npm run setup -- --model` — and it lands in `~/.ai-dev`; neither the model nor the
vectors it computes need Python. A container runs with no network, so the weights
cannot be downloaded inside it at all: they are downloaded on the host and mounted
at `/models` (see [The local model in a container](#the-local-model-in-a-container)).
The image says so about itself (`AI_DEV_RUNTIME=docker`), and the health check reads
it: inside a container `embedding_backend` reports dense search as not set up and
points at the mount, rather than at a `npm run setup` no container can run.

## From the npm package

The same system without a clone: the package `@stonebridgeway/ai-dev-system`, built by
`npm run dist` from the same allowlist the Docker image is made from. Until the owner
publishes it, build the tarball from a clone with `npm run dist:pack` (it lands in `dist/`)
and use its path where the commands below say `@stonebridgeway/ai-dev-system`:

```bash
npx @stonebridgeway/ai-dev-system setup           # or: npx --yes ./stonebridgeway-ai-dev-system-<version>.tgz setup
```

`npx` runs the package from its cache, which npm may clear at any time, so `setup` installs
it first into `~/.ai-dev/app/<version>-<fingerprint>` — its own copy, with its dependencies
from the package's lockfile (`npm ci` with install scripts off, out of the cache npx just
filled) — and goes on from there. The client configs it writes name that copy; the newest two copies are
kept, so a client still running the previous one is not pulled out from under. Running the
same command with a newer version is the update.

A global install works too: `npm install -g @stonebridgeway/ai-dev-system`, then `ai-dev setup`;
the client configs name the global install. On Linux x64 install it as
`ONNXRUNTIME_NODE_INSTALL=skip npm install -g @stonebridgeway/ai-dev-system`: onnxruntime-node's
install script otherwise downloads a 236 MB CUDA provider the server never loads, and behind a
proxy that download fails. The local model's two packages are optional dependencies, so a
failed download costs dense search, not the install (docs/DEFECTS.md, Д-174); `ai-dev model
doctor` names the way back for the install you have.

**Your vault.** A package's own folder is read-only to the server: what it writes — registries,
project cards, notes — goes into `~/.ai-dev/vault`, which the seed the package ships is copied
into. Each newer version brings its changes to the seed by its sha256 manifest:

- a file you have not touched is replaced;
- a file you changed stays yours. When the update changed it too, the update's version is put
  beside it as `<file>.seed-new`, and `ai-dev doctor` names each one (check `vault_seed`) until
  you have merged what you want and deleted the `.seed-new` file;
- a file you deleted stays deleted, and one the seed no longer has goes, unless you changed it;
- an older version never rolls a newer vault back.

Deleting `~/.ai-dev/vault/.ai-dev-seed.json` makes the next start begin again: what you deleted
comes back, and every file you changed is kept and named as above.

Commands are `ai-dev <command>` after a global install, `npx @stonebridgeway/ai-dev-system
<command>` otherwise; the hints the server prints are spelled the same way. `AI_DEV_HOME`, when
set, is written into every client's entry, and beside the hooks `install_agent_hooks` puts into
a repository, so a client started from the Dock or the Start menu — its server and its hooks —
finds the same data as the terminal you ran setup from (Д-176, Д-184).

## The Windows installer

For a person on Windows who wants no terminal: `AI-Dev-Setup-<version>.exe` installs the desktop
app for your account — no administrator, no Node, no Python, no Docker — with its own Node and
the server it runs. The first start copies the runtime, fills your vault from the skill seed and
opens the wizard: the projects folder, the AI clients to connect, the local model, the index.
Updates come from the project's GitHub releases; uninstalling asks whether to take AI Dev out of
your AI clients and whether to delete its data, and keeps a data folder in which it finds files
that are not AI Dev's. What it installs where, why AI clients run it
through `%USERPROFILE%\.ai-dev\app\current`, and how to build the installer
(`cd desktop && npm run dist:win`): [The Windows install](DESKTOP.md#the-windows-install).

## One command on Windows

This is the Docker path: the AI clients run the server in a container. For the
local path see [Quick start: run it locally](#quick-start-run-it-locally); the
[Windows installer](#the-windows-installer) needs neither Docker nor Node.

It needs Docker Desktop — installed and not running, the script starts it and
waits for the engine — and Node.js 22.12 or newer: Node writes the clients'
configs, since a Linux container cannot write a file by its Windows path. If
either is missing the script says how to install it (`winget install
Docker.DockerDesktop`, `winget install OpenJS.NodeJS.LTS`) and stops; it installs
nothing itself. After `git clone`, open PowerShell in the clone root and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

It pulls the published image, checks that the server in it answers the MCP
handshake — its own answer, instructions and all — and writes the `ai-dev`
entry into every AI client it finds: a `docker run -i --rm …` the client runs
itself. The projects folder is `%USERPROFILE%\AI-Dev-Projects`, mounted as
`/workspace` (a Linux container cannot hold a Windows path, so on Windows the
server sees the projects there). Nothing is compiled any more: 2.x built a C#
proxy for Claude on your machine, and the launchers 2.x copied to
`C:\ProgramData\AI-Dev-System` are only brought up to date if they are there —
see [Updating an earlier install](#updating-an-earlier-install).

The state folder, `%USERPROFILE%\.ai-dev\state`, is the server's too, as on macOS,
but on Windows only the usage ledger in it is one. The server sees a project as
`/workspace/<name>` and the hooks as `C:\…\<name>` — two projects to either side —
and tasks and the hooks' session handoffs are kept by project: the Stop hook does not
remind you of a task the server began, and the server does not see a handoff the hooks
wrote (docs/DEFECTS.md, Д-324, Д-333).

For a different project folder and some of the clients:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 `
  -ProjectPath "D:\Projects" `
  -Clients "codex,cursor,vscode"
```

Restart the AI client afterwards.

## One command on macOS and Linux

Also the Docker path. It needs Docker (Docker Desktop on macOS, Docker Engine on
Linux), running — the script checks and says where Docker comes from if it is
not there; it no longer installs it — and nothing else for the server: no Node on
the host. (The agent hooks, if you install them into a project, run on the host's
Node.)

```bash
sh ./bootstrap.sh
```

Three steps:

1. **Docker** is there and its engine answers (on macOS it starts Docker Desktop
   and waits for it).
2. **The image** is pulled — `ghcr.io/stonebridgeway/ai-dev-system:latest` — and
   the server in it answers the MCP handshake with its own instructions.
3. **The configs.** The image writes them: `ai-dev clients install --docker`
   runs in a container that sees each client's own config folder and your state
   folder, nothing else of your home. Claude Code keeps its servers in
   `~/.claude.json`, a file in the home itself, so its entry goes through its own
   CLI (`claude mcp add-json`); without the CLI on PATH the script prints the
   command.

What a client then runs, every session:

```text
docker run -i --rm --read-only --tmpfs /tmp … --network none --security-opt no-new-privileges:true --cap-drop ALL
  --mount type=volume,source=ai-dev-system-data,target=/data
  --mount type=bind,source=~/.ai-dev/state,target=/ai-dev-state --env AI_DEV_STATE_ROOT=/ai-dev-state
  --mount type=bind,source=~/AI-Dev-Projects,target=~/AI-Dev-Projects
  ghcr.io/stonebridgeway/ai-dev-system:latest
```

- **The projects at their own path** (`~/AI-Dev-Projects` by default): the path an
  agent names is the path the server opens. 2.x mounted them at `/workspace`, and a
  host path was "not found" (docs/DEFECTS.md, Д-312).
- **The state the agent hooks keep** is the server's: your `~/.ai-dev/state`. The
  hooks run on your machine; with one state, the Stop hook sees the task the server
  started (Д-103). This takes the container's user — uid 1000, the image's — being
  yours: on macOS Docker Desktop maps it, on Linux it is the first user's uid — and on
  Linux the installer tries it first: a container of the image writes a file into the
  folder, and the file has to come out yours. With another uid, or where Docker maps
  the container's users to others (rootless Docker, userns-remap, Podman), the server
  keeps its state in the volume and cannot write into your projects — installing hooks
  or rules there is refused — as in 2.x; `ai-dev clients install --docker` says so, and
  on such a machine the local path is the one to take (docs/DEFECTS.md, Д-318, Д-322).
- **One container per session**, started in about a second; there is no
  long-lived container any more, and the one 2.x kept (`ai-dev-system-runtime-<uid>`)
  is removed.

For a different project folder and some of the clients:

```bash
sh ./bootstrap.sh --project-path "$HOME/Dev" --clients "codex,cursor,vscode"
```

Re-running it is safe: a config that already runs this image stays as it is, and
the volume — vault, index, model — is kept. To build the image from this
checkout instead of pulling it: `sh ./bootstrap.sh --build-local`. A client whose
config cannot be written is named and the others are written all the same; the exit
is then 1, and the 2.x runtime container stays until every config is rewritten
(docs/DEFECTS.md, Д-335). A config that is a link into a dotfiles repository is
written through it — each folder it leads to is mounted for the installer at the path
the link spells — but a link into your home itself, a folder above it or the root is
not followed, and a folder Docker will not mount (one outside Docker Desktop's file
sharing) costs that client alone (Д-338, Д-339).

The way back to 2.x is `sh ./bootstrap.sh --image ghcr.io/stonebridgeway/ai-dev-system:2`.
A 2.x image has no installer of its own, so the configs that run it are written by an
image of 3.0 or later: `AI_DEV_INSTALLER_IMAGE`, `ghcr.io/stonebridgeway/ai-dev-system:latest`
by default. It is pulled — a copy cached before 3.0 would be a 2.x one — and used only
once it is seen to have the installer; otherwise bootstrap stops and asks for one
(Д-323, Д-329).

If the registry cannot be reached and an older copy of the image is in the local
cache, bootstrap stops rather than installing it, and says when that copy was
built and its digest. Installing it anyway is a deliberate choice:
`sh ./bootstrap.sh --allow-stale-image` (`-AllowStaleImage` on Windows).

## The packaged path: Docker

Choose this when you want the system on a machine that should not hold a
personal vault, or when a team needs one image everybody runs the same way. The
image carries no vault, passwords, tokens, projects or task history. It is not
the faster path to a working install on your own machine — that is the local one
above.

### 1. Get the image

```bash
docker pull ghcr.io/stonebridgeway/ai-dev-system:latest
```

`:latest` is the latest release; `:edge` follows `main`; `:2` is the 2.x line, the
way back. Frontend QA needs a browser: the `-browser` variant (`:latest-browser`)
carries Chromium, about 0.8 GB more than the 0.7 GB of the default one.

Or build it from a clone of the repository:

```bash
cd ai-dev-mcp-server
npm ci
npm run docker:prepare
npm run docker:audit
npm run docker:build
npm run docker:smoke -- --image ai-dev-system:local
```

The build context, `.docker/build-context`, is the distribution `npm run dist`
makes (`ai-dev/`, checked file by file against its `distribution.json` in the
build) beside the Dockerfile and the entrypoint — never the repository root or a
vault. What a first start builds (the skill registry, the search index, the
routing benchmark) is built into the image, and a new volume starts with it.
Docker fills a new volume as the first container on it starts; a second client
started a moment later waits for that copy — at most 20 s — before it reads the
volume (docs/DEFECTS.md, Д-355).

### 2. Choose a working folder

Create or choose a folder that contains only the repositories the agent is
allowed to work on — for example `C:\Dev` on Windows or `$HOME/Dev` on
macOS / Linux. Do not use a personal vault, your entire home directory, or a
folder with secrets or backups.

### 3. Write the clients' entries

From a clone, with Node 22.12+ on the host — what the bootstrap scripts run:

```bash
node ai-dev-mcp-server/bin/ai-dev.mjs clients install --docker --projects "$HOME/Dev"
```

`--image`, `--model`, `--volume` and `--clients` say the rest; `--dry-run` writes
nothing; `ai-dev clients entry cursor --docker …` prints one entry as JSON for a
client you configure by hand. `ai-dev clients doctor` then starts each entry and
checks that the server answers. The 2.x launchers — `docker/run-mcp.sh`,
`run-mcp.ps1` — still run the image for configs that name them, until 4.0.

### 4. What the container runs your checks with

In the container, `run_quality_gate` and `verify_task` execute the commands from
your project's `.ai-dev/quality-gate.md` with the **image's** Node — currently
24 — not the Node you have installed. A command that behaves differently across
Node majors will therefore disagree with your own terminal, and the gate is not
what made it disagree. `node --test test/` is the usual one: since Node 21 the
positional arguments are glob patterns, so the directory is executed as a test
file and the script fails by itself, where under Node 20 it passed.

`run_quality_gate` reports which Node ran the commands as `runtime.node` and
`runtime.exec_path`, and a failed command carries a `hint` when the cause is one
the gate recognizes. It does not rewrite your commands for you.

The container also runs with `--network none`, and of the six security scanners
only `gitleaks` — which is in the image — works with no network at all. So a
scan there is one scanner, not six; `docker/README.md` has the full matrix. A
scan in which not one scanner ran comes back `unchecked`, never `pass`. git in
the image trusts the mounted projects whoever owns them on the host: 2.x saw a
project of another user as no repository at all (Д-311).

## Connecting AI agents

Do not edit these files by hand when an installer covers the client. From a clone,
`npm run setup` — or on its own, `npm run clients:install` (`ai-dev clients install`) —
configures all six clients; for the Docker path, bootstrap does.

### From a clone

| Client | Config file | Entry |
| --- | --- | --- |
| Claude Code | `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that is set (Claude Code reads only that one then) | `mcpServers.ai-dev`, with `type: "stdio"` |
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows `%APPDATA%\Claude\claude_desktop_config.json`, and the Microsoft Store build's own copy under `%LOCALAPPDATA%\Packages\Claude_*`; Linux builds `~/.config/Claude/claude_desktop_config.json` | `mcpServers.ai-dev` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers.ai-dev` |
| VS Code | `Code/User/mcp.json` in the user config folder (`%APPDATA%`, `~/Library/Application Support`, `~/.config`) | `servers.ai-dev`, with `type: "stdio"` |
| Codex | `~/.codex/config.toml`, or `$CODEX_HOME/config.toml` | `[mcp_servers.ai-dev]`, with `startup_timeout_sec = 120` and `tool_timeout_sec = 3600` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers.ai-dev` |

Every entry runs the same command: this Node by its full path, then
`<clone>/ai-dev-mcp-server/bin/ai-dev.mjs mcp`. A client started from the Dock or the
Start menu does not see your shell's `PATH`, and a bare `node` is not found there when
Node came from nvm, fnm, Volta or Homebrew. A vault install also passes
`AI_DEV_VAULT_ROOT`.

What the installer does with the files:

- **Which clients.** By default every client installed here — its folder exists.
  `--clients=cursor,vscode` names them instead (`claude` is both Claude apps), and a
  client named that way is written even where it is not found.
- **Nothing else changes.** The file is edited where the entry goes: every other server,
  comment (VS Code and Gemini accept JSONC) and line stays byte for byte. In Codex the
  server's table is found with its subtables and in any spelling of its name.
- **Safely.** The file is written through a temp file and a rename, after a check that
  the client did not save it in the meantime; its previous bytes stay next to it as
  `<file>.backup-<time>`. A config that is a symlink (a dotfiles repository) is written
  through the link.
- **One name.** An `ai-dev-system` entry — what the 2.x local installer wrote — is
  removed, and an `ai-dev` entry that ran the Docker launcher is replaced; the output
  says which.
- **A broken file is one failure.** It is left as it was and named with the line where
  it breaks; the other clients are still written, and the command exits 1.
- **Again is a no-op.** A second run says `No changes`.

`ai-dev clients list` shows every client and what its entry runs. `ai-dev clients doctor`
starts each entry's command the way the client would and checks that it answers
`initialize` with instructions — the check to make when a client shows the server as
failed; each command has 30 seconds, `--timeout=<seconds>` gives it more. `ai-dev clients remove` takes `ai-dev` (and `ai-dev-system`) out again: a file
nothing else has changed since gets back exactly what it held, and from any other only
the entry is cut. `--dry-run` shows what `install` or `remove` would change.

Entries 2.x wrote keep working without a reinstall: `node <clone>/ai-dev-mcp-server/src/server.mjs`
is still a working entry point.

**The Docker path.** `bootstrap.sh`, `bootstrap.ps1` and `ai-dev clients install --docker`
write the same files the same way, with an entry that runs `docker run` itself. The blocks
below show its shape, for reference and for a client none of them covers;
`ai-dev clients entry <client> --docker --projects <folder>` prints the exact entry for this
machine, the Docker CLI by its full path (a client started from the Dock or the Start menu
does not see your shell's `PATH`). Replace `/home/you/Dev` or `C:\Dev` with the folder that
holds your projects, and do not commit these values to Git.

### Codex

Add to your user `config.toml` — here as macOS and Linux write it:

```toml
[mcp_servers.ai-dev]
command = "/usr/local/bin/docker"
args = [
  "run", "-i", "--rm", "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,size=512m", "--shm-size", "1g",
  "--network", "none", "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL",
  "--mount", "type=volume,source=ai-dev-system-data,target=/data",
  "--mount", "type=bind,source=/home/you/.ai-dev/state,target=/ai-dev-state", "--env", "AI_DEV_STATE_ROOT=/ai-dev-state",
  "--mount", "type=bind,source=/home/you/Dev,target=/home/you/Dev",
  "ghcr.io/stonebridgeway/ai-dev-system:latest"
]
startup_timeout_sec = 120
tool_timeout_sec = 3600
```

The state folder's mount and its variable are there only where the container's user, uid
1000, is yours — see [One command on macOS and Linux](#one-command-on-macos-and-linux).
Restart Codex and confirm that the `ai-dev` server appears in the MCP tool list.

### Cursor, Claude Desktop, Claude Code, and Gemini

These clients use JSON with an `mcpServers` property. Add or merge the block below into
their existing configuration — here as Windows writes it, with the projects in `C:\Dev`,
which the server sees as `/workspace`:

```json
{
  "mcpServers": {
    "ai-dev": {
      "command": "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
      "args": [
        "run", "-i", "--rm", "--read-only", "--tmpfs", "/tmp:rw,exec,nosuid,size=512m", "--shm-size", "1g",
        "--network", "none", "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL",
        "--mount", "type=volume,source=ai-dev-system-data,target=/data",
        "--mount", "type=bind,source=C:\\Users\\you\\.ai-dev\\state,target=/ai-dev-state",
        "--env", "AI_DEV_STATE_ROOT=/ai-dev-state",
        "--mount", "type=bind,source=C:\\Dev,target=/workspace",
        "ghcr.io/stonebridgeway/ai-dev-system:latest"
      ]
    }
  }
}
```

`bootstrap.ps1 -Clients claude` writes both Claude files: `%USERPROFILE%\.claude.json` for
Claude Code, and `%APPDATA%\Claude\claude_desktop_config.json` for Claude Desktop together
with the Microsoft Store build's own copy under `%LOCALAPPDATA%\Packages\Claude_*`. On macOS
and Linux, bootstrap gives Claude Code its entry through Claude Code's own CLI
(`claude mcp add-json`). Every other server in a file is kept, and the file's previous bytes
stay beside it. A minimal template is in
[docker/mcp-config.example.json](../docker/mcp-config.example.json). After changing the
configuration, restart the client completely.

### VS Code

Create `.vscode/mcp.json` in a specific working repository, or add the same server to your
VS Code user MCP settings: the block above under `servers` instead of `mcpServers`, with
`"type": "stdio"` beside `command`.

Reload the VS Code window. On Windows the server sees the projects under `/workspace`: call
`begin_task` with `/workspace/my-project`. On macOS and Linux it sees them at their own path.

## Docker Compose

Copy `docker/compose.local.example.yaml` to `docker/compose.local.yaml`, set a
local `AI_DEV_PROJECT_PATH` (mounted at its own path), and run:

```bash
docker compose -f docker/compose.yaml -f docker/compose.local.yaml run --rm -T ai-dev-mcp
```

`compose.local.yaml` and `docker/.env` are Git-ignored because they can contain
local paths. A client config runs `docker run` itself; compose is for those who
keep their containers there.

## The local model in a container

Hybrid search has two halves: keyword matching, which works everywhere with no
setup, and dense retrieval on the local BGE-M3 model, which is what makes a
search understand a question rather than match its words. The container runs
both; the ONNX runtime is in the image. The weights are not: they are about 600
MB, yours to fetch once.

**Into the data volume, once, with the network that one run needs:**

```bash
docker run --rm -it --network bridge \
  --mount type=volume,source=ai-dev-system-data,target=/data \
  ghcr.io/stonebridgeway/ai-dev-system:latest ai-dev model install
```

It shows the download as it goes, keeps what arrived if it is cut off (the next
run continues from that byte), checks every file against the manifest's sha256,
and embeds the documents the index already holds. The sessions after it keep
`--network none` and read the model from the volume. 2.x could not do this: the
image pinned the model folder to a host mount, and its documents were never
embedded at all (docs/DEFECTS.md, Д-99). A proxy or a mirror is passed the way
[When the download is blocked](#when-the-download-is-blocked) says, with `--env`.

**Or on the host, mounted read-only** — the 2.x way, for a model you already
have: `npm run model -- install --no-index` puts it in
`~/.ai-dev/models/bge-m3-onnx`; mount the folder *above* it,
`~/.ai-dev/models`, at `/models` (`--model` of `ai-dev clients install --docker`,
`--model-path` of bootstrap, `AI_DEV_MODEL_PATH` of the 2.x launchers). The image
reads `/models/bge-m3-onnx` first when it holds anything — the sessions and its own
checks alike (docs/DEFECTS.md, Д-346) — so a model there that is not whole is put
right on the host, or the mount dropped. Its files have to be readable to the image's
user, uid 1000; when they are not, the start report and `embedding_status` say so
(Д-337, Д-349). The documents are embedded with it, with no download and no network,
by `docker run --rm -it --mount type=volume,source=ai-dev-system-data,target=/data
--mount type=bind,source=<the folder above bge-m3-onnx>,target=/models,readonly
ghcr.io/stonebridgeway/ai-dev-system:latest ai-dev setup --model` (Д-341).

**Room to put them.** About 600 MB of weights, and the download refuses to start
on a disk that cannot hold them plus 512 MB left over — it says what it needs and
what is there rather than filling the disk to the last byte. A disk that fits
them and not much more still works, and says once that it may be slow: writing
near a full disk is where a download that crawls usually comes from, and it looks
exactly like a dead connection from the outside.

### When the download is blocked

The download reads `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` the way npm and curl
do — credentials go in the proxy URL, `http://user:password@proxy:3128` — with no
`NODE_USE_ENV_PROXY`. A proxy that signs in with NTLM or Kerberos rather than a
password is reached through a local forwarding proxy that does the sign-in, such as
cntlm or px, named in `HTTPS_PROXY`; the error says so when that is the case. A
Hugging Face mirror is one variable:

```bash
AI_DEV_MODEL_MIRROR=https://hf-mirror.com npm run setup -- --model
```

`AI_DEV_MODEL_MIRROR` (or `HF_ENDPOINT`, which other Hugging Face tools read) is
tried first, then huggingface.co; a source that fails hands over to the next, which
continues the same partial file. Every file is checked against the manifest's
sha256 whichever source sent it.

No route at all? Copy the model from a machine that has one — the folder, a folder
above it, a Hugging Face cache, or a `.zip` of any of them:

```bash
npm run model -- import /media/usb/bge-m3-onnx.zip
```

`npm run model -- status` says what is installed and what stopped partway,
`verify` hashes every file, `remove` deletes the model's files and nothing else.

### Coming from the Python backend

2.x could run dense search on a Python virtualenv with torch and 2.3 GB of
weights (`--dense-python`, `AI_DEV_DENSE_BACKEND=python`, an image built with
`INSTALL_BGE_M3=1`). 3.0 removed it (decision D3). One command moves you over:

```bash
npm run setup -- --model
```

It installs the ONNX model and embeds the documents again: vectors made by the
Python backend are another model's and are not compared with ONNX questions, so
they wait for this run and are replaced by it; the rest of the index is kept.
Until you run it, search works without its dense half. Every leftover setting —
`AI_DEV_DENSE_BACKEND=python`, `BGE_M3_PYTHON`, `AI_DEV_EMBEDDINGS_PYTHON`,
`AI_DEV_PYTHON_BASE`, `BGE_M3_PYTHON_REVISION`, `BGE_M3_MODEL_DIR` — is no longer
read; the health check names each one it finds, and the `~/.ai-dev/models/bge-m3`
folder of torch weights can be deleted. `--dense-python` still works as a name
and does what `--dense` does; a Docker build passing `INSTALL_BGE_M3=1` says
what replaced it.

### Running it, either way

A model in the volume needs nothing more: every session of the image finds it.
A model on the host is mounted from the folder *above* it — `~/.ai-dev/models`,
the one `npm run setup -- --model` fills — not a model directory. A folder that
holds model files itself (`pytorch_model.bin`, `config.json`, `onnx/`) is the value
the variable had before 2.1, and every copy refuses it with directions rather than
mounting it one level too deep.

```bash
sh ./bootstrap.sh --model-path "$HOME/.ai-dev/models"
node ai-dev-mcp-server/bin/ai-dev.mjs clients install --docker --model "$HOME/.ai-dev/models"
```

On Windows the bootstrap switch is `-ModelPath`. With Compose, uncomment the
model mount in your `compose.local.yaml` — the example file carries it with the
same variable. `network_mode: none` does not get in the way: the worker loads the
model with remote models turned off.

### If you want the weights inside the image

Mounting keeps the published image small, which is right for the default. It is
not right for every deployment: an air-gapped machine, or an image handed to a
team that should not each download the weights, wants the model baked in. That
is your build, not the distribution's, and it is four lines:

```dockerfile
# Dockerfile.bge — build it from the folder holding the weights
FROM ghcr.io/stonebridgeway/ai-dev-system:latest
COPY --chown=node:node bge-m3-onnx/ /models/bge-m3-onnx/
```

```bash
docker build -f Dockerfile.bge -t ai-dev-system:bge-bundled "$HOME/.ai-dev/models"
```

The result needs no mount and no variable: `/models/bge-m3-onnx` is already
there, where the image looks first. Everything else — `network_mode: none`, the
read-only root filesystem, the unprivileged user — stays as it was.

### Checking that it worked

Ask the running server for a diagnostic. The check to read is
`embedding_backend`: without the model it reports `skipped` and says what to
run, and with it `ok`.

```bash
npm --prefix ai-dev-mcp-server run -s doctor
```

For the detail behind that one line, the `embedding_status` tool says whether the
model can run and why: `installed` and `available` are the answer, `reason` is a
sentence rather than a flag, and `partial` lists downloads that stopped partway.
Under `dense_backend.onnx`, `missing` lists files that are not there and
`mismatched` lists files that are there and are not the pinned export — the first
means the mount did not arrive, the second means the bytes are wrong. Anything
left of a 2.x Python install is under `dense_backend.legacy`, and makes the health
check a `warn` until it is cleaned up. From a checkout, `npm run dense:doctor`
walks the same ground in six stages and names the one that stopped.

Then `search_index_status` reports `dense_documents` against
`dense_pending_documents`: a fresh index has vectors for none of its documents
until `ai-dev model install` (or `npm run setup -- --model`) has embedded them — for
a model mounted from the host, `ai-dev setup --model` as above.

Running from source instead? Then none of this applies: `npm run setup --
--dense` is the whole of it. See
[the server README](../ai-dev-mcp-server/README.md#semantic-search-bge-m3).

## Publishing for a team

The [docker-publish.yml](../.github/workflows/docker-publish.yml) workflow checks the
privacy policy, rebuilds the context, runs the MCP smoke test (a new volume, the
next session, the model through the volume) and the upgrade of a 2.x volume, and
publishes `linux/amd64` and `linux/arm64` images to the GitHub Container Registry
with an SBOM and provenance — two variants, the default and `-browser`.

The tags (owner decision D9): a push to `main` is `:edge`; a release tag `vX.Y.Z`
is `:X.Y.Z`, `:X.Y` and `:X`, and `:latest` too when it is of the newest line — a
2.x tag after 3.0 moves `:2` alone, and a prerelease (`vX.Y.Z-rc.N`) is only its own
name. A merge is not a release. `:2` is the 2.x line, frozen when 3.0 is released:
`AI_DEV_IMAGE=ghcr.io/stonebridgeway/ai-dev-system:2` (or `--image` of bootstrap) is
the way back.

After the first push:

1. Open the package in GitHub and set its visibility to `private` / `internal`
   for a team, or `public`.
2. Make sure teammates can read GitHub Packages.
3. Give teammates the address `ghcr.io/stonebridgeway/ai-dev-system:latest` and
   this README.
4. Each teammate sets their own local project folder; other people's files never
   enter the image or Git.

## Arch / AUR and Homebrew

After publication in AUR, install on Arch Linux / Manjaro with:

```bash
yay -S ai-dev-system-git
sudo systemctl enable --now docker
ai-dev-system
```

The package brings Docker as a dependency; starting its engine, and letting your user reach it
(the `docker` group, then a new login), are yours to do — bootstrap no longer does either. The
package follows `main`. It can also be built from this clone:

```bash
cd packaging/arch
makepkg -si
ai-dev-system
```

The AUR package name is `ai-dev-system-git`. Publishing requires a separate AUR
account and the maintainer's SSH repository.

On macOS, after the Homebrew tap is published:

```bash
brew tap stonebridgeway/tap
brew install ai-dev-system
ai-dev-system --install-prerequisites
```

The formula installs the stable `v1.0.0` release. Maintainer publishing and
release-update details are in [packaging/README.md](../packaging/README.md).

## Updating an earlier install

From a clone:

```bash
git pull
cd ai-dev-mcp-server
npm ci
npm run setup
```

What earlier versions left behind is taken care of when the server starts, or needs one
command:

- **`AI_DEV_HOME`.** Earlier versions wrote the runtime tree into `$AI_DEV_HOME/.ai-dev`
  instead of `$AI_DEV_HOME` (docs/DEFECTS.md, Д-90). The server, `npm run setup` and the
  `ai-dev` CLI move it up when they start, without overwriting anything; `npm run doctor`
  reports what was moved and anything left behind (check `runtime_home`). Hooks you installed
  into a repository look for the old place until you run `install_agent_hooks` there again.
- **Client configs.** What 2.x wrote keeps working. `npm run clients:install` (or `npm run
  setup`) replaces it with the 3.0 entry: one server, `ai-dev`, instead of `ai-dev-system`
  next to a Docker `ai-dev`, and without the `AI_DEV_PYTHON=python3` the 2.x local
  installer wrote even on Windows, where a Windows Python does not answer to it (Д-94, Д-95).
- **Hooks.** Hooks 2.x installed into a repository keep running wherever `node` is on the
  client's PATH. Run `install_agent_hooks` there again for the 3.0 registrations, which
  find Node without it (Д-103).
- **Docker configs.** A config 2.x wrote names a launcher — `docker/run-mcp.sh`,
  `run-mcp.ps1`, or for Claude on Windows `ClaudeMcpProxy.exe` — and it keeps running the
  new image until 4.0; the 3.0 copies of the scripts say on stderr that they are the 2.x
  launcher. Run `bootstrap.sh` (`bootstrap.ps1` on Windows) once more: it writes the
  `docker run` entries in their place, then removes the long-lived container 2.x kept.
  Until then the client gets the server's instructions only through the 3.0 scripts —
  2.x's answered the handshake themselves, and so does the installed
  `ClaudeMcpProxy.exe`, which 3.0 no longer compiles (Д-89, Д-105, Д-327).
- **The Docker volume** is kept. On the new image's first start its skills are brought up
  to the image's seed by the seed's manifest rather than 2.x's copy-if-missing: what 2.x
  shipped and 3.0 dropped is removed, a skill of the seed you edited keeps your edit with
  the update beside it (`SKILL.md.seed-new`), a skill of your own is not touched (Д-99).
  Where the container shares your state folder (see
  [One command on macOS and Linux](#one-command-on-macos-and-linux)), the tasks and
  handoffs in the volume move into it. That first start takes some seconds more than the
  next ones. What the 2.x server remembered of a project — sessions, instincts, decisions —
  is kept under the project as it saw it, `/workspace/<name>`; with the projects at their
  own path the server sees other projects and starts their memory afresh, the old one
  staying in the state folder (Д-324). The way back is the 2.x image, `ghcr.io/stonebridgeway/ai-dev-system:2`.
  Through `bootstrap --image …:2` it runs from 3.0's entries, which hand it the state folder
  where it is shared, and it sees the tasks there; run by 2.x's own launchers (`AI_DEV_IMAGE`),
  it keeps its state in the volume and does not see the tasks that moved to your state folder
  ([Upgrade test](UPGRADE-TEST.md) says how to copy them back). Either way a return to 3.0
  removes again the skills its `cp -n` put back (Д-317, Д-333).

`npm run upgrade:test` checks all of this against a 2.x install, and `npm run
docker:upgrade-check -- --old-image <2.x image> --new-image <image>` the Docker part
against a 2.x volume and its launchers; see [Upgrade test](UPGRADE-TEST.md).

## Verification and diagnostics

Before a release, from `ai-dev-mcp-server` run:

```powershell
npm run check
npm run docker:prepare
npm run docker:audit
npm run docker:smoke -- --image ai-dev-system:local
```

For the acceptance run — the same gate ten times in a row:

```powershell
npm run acceptance
```

`scripts/run-acceptance.ps1` is a wrapper over `npm run check` until 4.0. `npm run dist`
builds the package folder (`dist/ai-dev/`), `npm run dist:pack` the tarball beside it, checked
file by file against the list it was built from.

If Docker Desktop cannot pull the base image behind a VPN or corporate DNS,
configure a proxy / DNS in Docker Desktop. Do not put proxy passwords in the
Dockerfile, Git, build args, or project files. An image that is already built
runs with no internet access.

Compose, macOS / Linux, BGE-M3, and GHCR details: [docker/README.md](../docker/README.md).
Architecture and the full tool list: [ai-dev-mcp-server/README.md](../ai-dev-mcp-server/README.md).
