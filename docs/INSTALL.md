# Install

[← README](../README.md) · [Workflow](WORKFLOW.md) · [Capabilities](CAPABILITIES.md) · [Guard rails](GUARDRAILS.md)

AI Dev installs three ways. All three run the same server — the same tools, the same skill
seed, the same local model — and differ in what they ask of your machine and where the server
runs. If you only want to get started, the [README](../README.md#install) is enough; this page
has the rest.

## Contents

- [Choose a path](#choose-a-path)
- [The Windows installer](#the-windows-installer)
- [One command with Node: npx](#one-command-with-node-npx)
- [Docker](#docker)
- [Connecting AI clients](#connecting-ai-clients)
- [The local model](#the-local-model)
- [The daemon and the settings](#the-daemon-and-the-settings)
- [The ai-dev command line](#the-ai-dev-command-line)
- [Updating, and coming from 2.x](#updating-and-coming-from-2x)
- [Uninstalling](#uninstalling)
- [When something does not work](#when-something-does-not-work)
- [From a clone](#from-a-clone)

To start an agent with a narrowed tool surface, add `AI_DEV_PROFILES` to the `env` block of a
client's entry — see [Capabilities](CAPABILITIES.md).

## Choose a path

| | The Windows installer | One command with Node | Docker |
| --- | --- | --- | --- |
| For | Windows, without a terminal | your own machine: macOS, Linux or Windows | the server in a container: a machine that should not hold your vault, a team on one image |
| You need | 64-bit Windows | Node.js 22.16+ (or 24+) and npm | Docker Desktop (macOS, Windows) or Docker Engine (Linux), running; on Windows also Node.js 22.12+ and a clone of the repository, since Node writes the clients' configs |
| You run | `AI-Dev-Setup-<version>.exe` | `npx @stonebridgeway/ai-dev-system setup` | `sh ./bootstrap.sh` (macOS, Linux) or `bootstrap.ps1` (Windows) |
| The server runs | on its own Node, from `%USERPROFILE%\.ai-dev\app` | on your Node, from `~/.ai-dev/app` | in a container per session; your data in the volume `ai-dev-system-data` |
| The local model | the wizard's model step | `setup --model` | `docker run … ai-dev model install`, once |
| Updates | offered by the app | the same command, `@latest` | `docker pull` |

None of them needs Python. Two tools, `query_ui_ux_knowledge` and
`generate_ui_ux_design_system`, run the UI UX Pro Max dataset's own Python script (`python3`;
`python` on Windows; or what `AI_DEV_PYTHON` names); without Python they say what to install,
the health check marks `ui_ux_knowledge` skipped, and nothing else changes. The image has no
Python. The local model needs none either: 3.0 removed the Python dense backend (see
[Coming from the Python backend](#coming-from-the-python-backend)).

## The Windows installer

For a person on Windows who wants no terminal. Download `AI-Dev-Setup-<version>.exe` from the
project's [releases](https://github.com/stonebridgeway/ai-dev-system/releases) and run it. It
installs the desktop app for your account — no administrator, no Node, Python or Docker — with a
Node of its own and the server it runs. The first start copies the runtime, fills your vault,
`%USERPROFILE%\.ai-dev\vault`, from the skill seed, and opens the wizard: the projects folder,
the AI clients to connect, the local model, the index. Restart the clients it connected.

An installer that is not signed makes Windows SmartScreen warn on its first run; **More info →
Run anyway** goes on. Updates come from the same releases: the app looks for one a minute after
it starts and every six hours, downloads it in the background and offers to restart.
Uninstalling asks whether to take AI Dev out of your AI clients (yes by default) and whether to
delete its data (no by default).

What goes where, why every client runs it through `%USERPROFILE%\.ai-dev\app\current`, the
command line for a terminal, and how to build the installer yourself (`cd desktop && npm run
dist:win`): [The Windows install](DESKTOP.md#the-windows-install). The window, the tray and the
wizard: [Desktop app](DESKTOP.md).

## One command with Node: npx

For your own machine — macOS, Linux or Windows — with Node.js 22.16 or newer (or 24+) and npm.
Node 22.13–22.15 and 23.x ship `node:sqlite` without the FTS5 the search index needs: there the
server starts, and every search tool answers with the version it needs.

```bash
npx @stonebridgeway/ai-dev-system setup
```

`npx` runs the package from its cache, which npm may clear at any time, so `setup` first
installs it into `~/.ai-dev/app/<version>-<fingerprint>` — a copy of its own, every file checked
against the package's list, its dependencies from the package's lockfile (`npm ci` with install
scripts off) — and goes on from that copy:

1. **It asks**, at a terminal: connect the AI clients it found here; download the local model
   (about 600 MB); install Frontend QA (Playwright and its Chromium, for UI checks). `--yes`
   takes the defaults — clients yes, both downloads no — and `--clients=<names>`,
   `--no-clients`, `--model` and `--frontend-qa` answer ahead of time. With neither a terminal
   nor `--yes` (CI, a pipe) no client config is touched unless `--clients` names some.
2. **It fills your vault**, `~/.ai-dev/vault`, from the skill seed the package ships, and builds
   what a first start needs: the skill registry, its quality report, the search index and the
   routing benchmark.
3. **It connects the clients**: each gets one entry, `ai-dev`, that starts your Node by its full
   path with the copy's `bin/ai-dev.mjs mcp`, so a client started from the Dock or the Start
   menu finds it too. What it writes, and how to take it out again:
   [Connecting AI clients](#connecting-ai-clients).
4. **It prints the health check.**

Restart the clients it connected; that is the whole install. Every other command is the same
command line, `npx @stonebridgeway/ai-dev-system <command>` ([below](#the-ai-dev-command-line));
a global install, `npm install -g @stonebridgeway/ai-dev-system`, gives it the name `ai-dev`, and
`ai-dev setup` then connects the clients to the global install. The hints the server prints are
spelled for the install you have.

Until the package is published, build its tarball from a clone — `cd ai-dev-mcp-server && npm
ci && npm run dist:pack`, which leaves `stonebridgeway-ai-dev-system-<version>.tgz` in the
clone's top-level `dist/` folder (`../dist` from `ai-dev-mcp-server`) — and run
`npx --yes ./stonebridgeway-ai-dev-system-<version>.tgz setup` in that folder.

**On Linux x64**, onnxruntime-node's install script downloads a 236 MB CUDA provider the server
never loads, and offline or behind a proxy that download fails; npm then leaves the package out,
and the local model has nothing to run on in that install. The copy `setup` makes is installed
with install scripts off and is not affected. For a global install, put
`ONNXRUNTIME_NODE_INSTALL=skip` before `npm install -g` (docs/DEFECTS.md, Д-174);
`ai-dev model doctor` names the way back for the install you have.

**Your vault.** The package's own folder is read-only to the server: what it writes — registries,
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

`AI_DEV_HOME`, when set, names the runtime home in place of `~/.ai-dev`; it is written into
every client's entry, and beside the hooks `install_agent_hooks` puts into a repository, so a
client started from the Dock or the Start menu — its server and its hooks — finds the same data
as the terminal you ran setup from (Д-176, Д-184).

## Docker

The server runs in a container: each client starts `docker run -i --rm …` for its session, as
written into its config. Choose this for a machine that should not hold your vault, or for a team
that runs one image the same way everywhere. The image carries no vault, passwords, tokens,
projects or task history: the server, Node, git, tini and gitleaks — no Python, and no browser
unless you take the `-browser` variant.

### On macOS and Linux

It needs Docker — Docker Desktop on macOS, Docker Engine on Linux — running: bootstrap checks for
it and says where it comes from, and installs nothing. The server needs no Node on the host (the
agent hooks, if you install them into a project, run on the host's Node). From a clone of the
repository — or with only its `bootstrap.sh`, which needs nothing else unless you build the
image yourself:

```bash
sh ./bootstrap.sh
```

Three steps:

1. **Docker** is there and its engine answers (on macOS it starts Docker Desktop and waits for it).
2. **The image** is pulled — `ghcr.io/stonebridgeway/ai-dev-system:latest` — and the server in it
   answers the MCP handshake with its own instructions.
3. **The configs.** The image writes them: `ai-dev clients install --docker` runs in a container
   that sees each client's own config folder and your state folder, nothing else of your home.
   Claude Code keeps its servers in `~/.claude.json`, a file in the home itself, so its entry goes
   through its own CLI (`claude mcp add-json`); without the CLI on `PATH` the script prints the
   command. Every client found here gets an entry, and the last line asks you to restart the
   clients. With none installed yet nothing is written, and the script says so — install one and
   run it again, or name one with `--clients` (`-Clients` for `bootstrap.ps1`, which does the same on
   Windows) — and ends "AI Dev is ready; no AI client is connected to it yet." (Where `bootstrap.ps1`
   cannot read the installer's answer — only on a host that will not switch its console to UTF-8 —
   the installer's own words stand instead: its `--clients=` hint and the restart; Д-452.) With
   `--skip-client-install` (`-SkipClientInstall`) no config is written, and the last line says the
   clients' configs were left as they were (Д-406, Д-415).

Until 3.0 is published, `:latest` is still a 2.x image, which has no installer of its own:
bootstrap stops there with exit 69 ("… has no installer either (a 2.x image too)"). Build the 3.0
image from the clone and install that one, in one step that needs no Node here — a
`node:24-bookworm-slim` container prepares the build context:

```bash
sh ./bootstrap.sh --build-local   # builds ai-dev-system:local from the clone, then installs it
```

It builds the image instead of pulling one from the registry. With Node and npm, the build can
also be a step of its own:

```bash
cd ai-dev-mcp-server && npm run docker:build && cd ..   # makes ai-dev-system:local
sh ./bootstrap.sh --image ai-dev-system:local --allow-stale-image
```

bootstrap still tries to pull a named image first, so "Registry pull failed … Installed from a
stale image" is expected there for an image built here. `--project-path` and `--clients` go with
either.

For a different project folder and some of the clients:

```bash
sh ./bootstrap.sh --project-path "$HOME/Dev" --clients "codex,cursor,vscode"
```

Restart the clients afterwards. Re-running it is safe with the same options (`--project-path`,
`--model-path`): a config that already runs this image stays as it is, and the volume — vault,
index, model — is kept. bootstrap does not read a folder back from an entry, so without the options
it mounts `~/AI-Dev-Projects` again, whatever the entry mounted before, and no model folder unless
`AI_DEV_MODEL_PATH` names one. To build the image from the clone
instead of pulling it: `sh ./bootstrap.sh --build-local`. A client whose config cannot be written
is named and the others are written all the same; the exit is then 1, and the 2.x runtime
container stays until every config is rewritten (docs/DEFECTS.md, Д-335). A config that is a link
into a dotfiles repository is written through it — each folder it leads to is mounted for the
installer at the path the link spells — but a link into your home itself, a folder above it or
the root is not followed, and a folder Docker will not mount (one outside Docker Desktop's file
sharing) costs that client alone (Д-338, Д-339).

If the registry cannot be reached and an older copy of the image is in the local cache, bootstrap
stops rather than installing it, and says when that copy was built and its digest. Installing it
anyway is a deliberate choice: `sh ./bootstrap.sh --allow-stale-image` (`-AllowStaleImage` on
Windows).

The way back to 2.x is `sh ./bootstrap.sh --image ghcr.io/stonebridgeway/ai-dev-system:2`, with the
same `--project-path` and `--model-path` as every other run: it too reads no folder back from the
entries it replaces. A 2.x image has no installer of its own, so the configs that run it are written by an
image of 3.0 or later: `AI_DEV_INSTALLER_IMAGE`, `ghcr.io/stonebridgeway/ai-dev-system:latest` by
default. It is pulled — a copy cached before 3.0 would be a 2.x one — and used only once it is seen
to have the installer; otherwise bootstrap stops and asks for one (Д-323, Д-329). `:2` exists once
3.0 is released — 2.x's `:latest`, copied to it before the 3.0 tag. Until then the 2.x image is
`ghcr.io/stonebridgeway/ai-dev-system:latest` itself, the default installer too, so the installer
has to be the 3.0 image you built: `AI_DEV_INSTALLER_IMAGE=ai-dev-system:local sh ./bootstrap.sh
--image ghcr.io/stonebridgeway/ai-dev-system:latest`. bootstrap tries to pull the installer too, so
Docker's "pull access denied for ai-dev-system …" is expected there: an image built here is in no
registry, and bootstrap goes on with the copy it finds here.

### On Windows

It needs Docker Desktop — installed; the script starts it and waits for the engine — and Node.js
22.12 or newer: Node writes the clients' configs, since a Linux container cannot write a file by
its Windows path. If either is missing the script says how to install it (`winget install
Docker.DockerDesktop`, `winget install OpenJS.NodeJS.LTS`) and stops; it installs nothing
itself. After `git clone`, open PowerShell in the clone root and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

It pulls the published image, checks that the server in it answers the MCP handshake, and writes
the `ai-dev` entry into every AI client it finds: a `docker run -i --rm …` the client runs itself.
The projects folder is `%USERPROFILE%\AI-Dev-Projects`, mounted as `/workspace` — a Linux
container cannot hold a Windows path, so on Windows the server sees the projects there. Nothing is
compiled any more: 2.x built a C# proxy for Claude on your machine, and the launchers 2.x copied to
`C:\ProgramData\AI-Dev-System` are only brought up to date if they are there (see
[Updating, and coming from 2.x](#updating-and-coming-from-2x)).

Until 3.0 is published, `:latest` is still a 2.x image, and the entries `bootstrap.ps1` writes
would run it. Build the 3.0 image from the clone and install that one, in one step — the Node the
script needs anyway prepares the build context:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 -BuildLocal
```

It builds `ai-dev-system:local` instead of pulling an image from the registry. Or build it as a
step of its own, and name it:

```powershell
cd ai-dev-mcp-server; npm run docker:build; cd ..
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 -Image ai-dev-system:local -AllowStaleImage
```

The warning "Registry pull failed … Installed from a stale image" is expected then, for an image
built here.

The state folder, `%USERPROFILE%\.ai-dev\state`, is the server's too, as on macOS, but on Windows
only the usage ledger in it is one. The server sees a project as `/workspace/<name>` and the hooks
as `C:\…\<name>` — two projects to either side — and tasks and the hooks' session handoffs are
kept by project: the Stop hook does not remind you of a task the server began, and the server does
not see a handoff the hooks wrote (docs/DEFECTS.md, Д-324, Д-333).

For a different project folder and some of the clients:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 `
  -ProjectPath "D:\Projects" `
  -Clients "codex,cursor,vscode"
```

Restart the AI client afterwards.

### What a client runs

Every session, as bootstrap writes it on macOS and Linux:

```text
docker run -i --rm --read-only --tmpfs /tmp … --network none --security-opt no-new-privileges:true --cap-drop ALL
  --mount type=volume,source=ai-dev-system-data,target=/data
  --mount type=bind,source=~/.ai-dev/state,target=/ai-dev-state --env AI_DEV_STATE_ROOT=/ai-dev-state
  --mount type=bind,source=~/AI-Dev-Projects,target=~/AI-Dev-Projects
  ghcr.io/stonebridgeway/ai-dev-system:latest
```

- **The projects at their own path** (`~/AI-Dev-Projects` by default): the path an agent names is
  the path the server opens. 2.x mounted them at `/workspace`, and a host path was "not found"
  (docs/DEFECTS.md, Д-312).
- **The state the agent hooks keep** is the server's: your `~/.ai-dev/state`. The hooks run on
  your machine; with one state, the Stop hook sees the task the server started (Д-103). This takes
  the container's user — uid 1000, the image's — being yours: on macOS Docker Desktop maps it, on
  Linux it is the first user's uid — and on Linux the installer tries it first: a container of the
  image writes a file into the folder, and the file has to come out yours. With another uid, or
  where Docker maps the container's users to others (rootless Docker, userns-remap, Podman), the
  server keeps its state in the volume and cannot write into your projects — installing hooks or
  rules there is refused — as in 2.x; `ai-dev clients install --docker` says so, and on such a
  machine [npx](#one-command-with-node-npx) is the path to take (Д-318, Д-322).
- **One container per session**, started in about a second; there is no long-lived container any
  more, and the one 2.x kept (`ai-dev-system-runtime-<uid>`) is removed by `bootstrap.sh`.
- **A new volume** starts with what a first start would build — the skill registry, its quality
  report, the search index, the routing benchmark — built into the image. Docker fills a new
  volume as the first container on it starts; a second client started a moment later waits for
  that copy, at most 20 s, before it reads the volume (Д-355).

### The image and its tags

```bash
docker pull ghcr.io/stonebridgeway/ai-dev-system:latest
```

The tags (owner decision D9): `:latest` is the newest release — a `vX.Y.Z` tag that is not a
prerelease, of the newest line; `:edge` follows `main`; a release is also `:X.Y.Z`, `:X.Y` and
`:X`. `:2` is the 2.x line and the way back: 2.x's `:latest` is copied to it before 3.0 is tagged,
and after that only a `v2.Y.Z` tag moves it — with `:2.Y` and `:2.Y.Z`, never `:latest`. Frontend
QA needs a browser: the `-browser` variant (`:latest-browser`, and `-browser` after every other tag) carries
Chromium, about 0.8 GB more than the 0.7 GB of the default one. The tag a client config names is
what its next session runs: `docker pull` is the update.

Or build it from a clone:

```bash
cd ai-dev-mcp-server
npm ci
npm run docker:prepare
npm run docker:audit
npm run docker:build
npm run docker:smoke -- --image ai-dev-system:local
```

The build context, `.docker/build-context`, is the distribution `npm run dist` makes (`ai-dev/`,
checked file by file against its `distribution.json` in the build) beside the Dockerfile and the
entrypoint — never the repository root or a vault.

### Writing the entries without bootstrap

With Node on the host — npx, or a clone — the command bootstrap runs is yours to run:

```bash
npx @stonebridgeway/ai-dev-system clients install --docker --projects "$HOME/Dev"
```

`--image`, `--model`, `--volume` and `--clients` say the rest; `--dry-run` writes nothing;
`clients entry cursor --docker …` prints one entry as JSON for a client you configure by hand;
`clients doctor` then starts each entry and checks that the server answers. The 2.x launchers —
`docker/run-mcp.sh`, `run-mcp.ps1` — still run the image for configs that name them, until 4.0.

### What the container runs your checks with

In the container, `run_quality_gate` and `verify_task` execute the commands from your project's
`.ai-dev/quality-gate.md` with the **image's** Node — currently 24 — not the Node you have
installed. A command that behaves differently across Node majors will therefore disagree with your
own terminal, and the gate is not what made it disagree. `node --test test/` is the usual one:
since Node 21 the positional arguments are glob patterns, so the directory is executed as a test
file and the script fails by itself, where under Node 20 it passed.

`run_quality_gate` reports which Node ran the commands as `runtime.node` and `runtime.exec_path`,
and a failed command carries a `hint` when the cause is one the gate recognizes. It does not
rewrite your commands for you.

The container also runs with `--network none`, and of the six security scanners only `gitleaks` —
which is in the image — works with no network at all. So a scan there is one scanner, not six;
[docker/README.md](../docker/README.md) (in Russian) has the full matrix. A scan in which not one
scanner ran comes back `unchecked`, never `pass`. git in the image trusts the mounted projects
whoever owns them on the host: 2.x saw a project of another user as no repository at all (Д-311).

### Docker Compose

A client config runs `docker run` itself; Compose is for those who keep their containers there.
Copy `docker/compose.local.example.yaml` to `docker/compose.local.yaml`, set `AI_DEV_PROJECT_PATH`
to your projects folder (mounted at its own path), and name the published image — without
`AI_DEV_IMAGE` the service builds `ai-dev-system:local` from `.docker/build-context`, which
`npm run docker:prepare` makes:

```bash
AI_DEV_IMAGE=ghcr.io/stonebridgeway/ai-dev-system:latest \
  docker compose -f docker/compose.yaml -f docker/compose.local.yaml run --rm -T ai-dev-mcp
```

`compose.local.yaml` and `docker/.env` are Git-ignored because they can contain local paths.

## Connecting AI clients

Do not edit these files by hand when an installer covers the client: `setup` (npx, a clone), the
Windows app's wizard, and bootstrap (Docker) all do it, and `clients install` on its own.

| Client | Config file | Entry |
| --- | --- | --- |
| Claude Code | `~/.claude.json`, or `$CLAUDE_CONFIG_DIR/.claude.json` when that is set (Claude Code reads only that one then) | `mcpServers.ai-dev`, with `type: "stdio"` |
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows `%APPDATA%\Claude\claude_desktop_config.json`, and the Microsoft Store build's own copy under `%LOCALAPPDATA%\Packages\Claude_*`; Linux builds `~/.config/Claude/claude_desktop_config.json` | `mcpServers.ai-dev` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers.ai-dev` |
| VS Code | `Code/User/mcp.json` in the user config folder (`%APPDATA%`, `~/Library/Application Support`, `~/.config`) | `servers.ai-dev`, with `type: "stdio"` |
| Codex | `~/.codex/config.toml`, or `$CODEX_HOME/config.toml` | `[mcp_servers.ai-dev]`, with `startup_timeout_sec = 120` and `tool_timeout_sec = 3600` |
| Gemini CLI | `~/.gemini/settings.json` | `mcpServers.ai-dev` |

A local entry — the installer's, npx's, a clone's — runs Node by its full path, then the install's
`bin/ai-dev.mjs mcp`: a client started from the Dock or the Start menu does not see your shell's
`PATH`, and a bare `node` is not found there when Node came from nvm, fnm, Volta or Homebrew. A
Docker entry runs `docker run` itself, the Docker CLI by its full path for the same reason.

What the installer does with the files:

- **Which clients.** By default every client installed here — its folder exists.
  `--clients=cursor,vscode` names them instead (`claude` is both Claude apps), and a client named
  that way is written even where it is not found.
- **Nothing else changes.** The file is edited where the entry goes: every other server, comment
  (VS Code and Gemini accept JSONC) and line stays byte for byte. In Codex the server's table is
  found with its subtables and in any spelling of its name.
- **Safely.** The file is written through a temp file and a rename, after a check that the client
  did not save it in the meantime; its previous bytes stay next to it as `<file>.backup-<time>`. A
  config that is a symlink (a dotfiles repository) is written through the link.
- **One name.** An `ai-dev-system` entry — what the 2.x local installer wrote — is removed, and an
  `ai-dev` entry of another install (Docker or local) is replaced; the output says which. Each
  client has one `ai-dev`: the last install to connect it wins.
- **A broken file is one failure.** It is left as it was and named with the line where it breaks;
  the other clients are still written, and the command exits 1.
- **Again is a no-op.** A second run says `No changes`.

`clients list` shows every client and what its entry runs. `clients doctor` starts each entry's
command the way the client would and checks that it answers `initialize` with instructions — the
check to make when a client shows the server as failed; each command has 30 seconds,
`--timeout=<seconds>` gives it more. `clients remove` takes `ai-dev` (and `ai-dev-system`) out
again: a file nothing else has changed since gets back what it held, less any `ai-dev` or
`ai-dev-system` entry the install replaced — 2.x's, Docker's or another install's — which does
not come back (its bytes stay in the `<file>.backup-<time>` the install left beside it); from any
other file only the entry is cut. `--dry-run` shows what `install` or `remove` would change.

### Hand-written Docker entries

For a client none of the installers covers, or to read what they write.
`clients entry <client> --docker --projects <folder>` prints the exact entry for this machine.
Replace `/home/you/Dev` or `C:\Dev` with the folder that holds your projects, and do not commit
these values to Git.

**Codex** — add to your user `config.toml`, here as Linux writes it. `command` is the full path of
the `docker` your `PATH` finds — usually `/usr/bin/docker` on Linux, `/usr/local/bin/docker` with
Docker Desktop on macOS (`command -v docker` says which):

```toml
[mcp_servers.ai-dev]
command = "/usr/bin/docker"
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

The state folder's mount and its variable are there only where the container's user, uid 1000, is
yours — see [What a client runs](#what-a-client-runs). Restart Codex and confirm that the `ai-dev`
server appears in the MCP tool list.

**Cursor, Claude Desktop, Claude Code and Gemini** use JSON with an `mcpServers` property. Add or
merge the block below into their configuration — here as Windows writes it, with the projects in
`C:\Dev`, which the server sees as `/workspace`:

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

`bootstrap.ps1 -Clients claude` writes both Claude files: `%USERPROFILE%\.claude.json` for Claude
Code, and `%APPDATA%\Claude\claude_desktop_config.json` for Claude Desktop together with the
Microsoft Store build's own copy under `%LOCALAPPDATA%\Packages\Claude_*`. On macOS and Linux,
bootstrap gives Claude Code its entry through Claude Code's own CLI (`claude mcp add-json`). A
macOS / Linux template is [docker/mcp-config.example.json](../docker/mcp-config.example.json):
replace `/home/YOU` with your home and the Docker path with what `command -v docker` answers. After
changing the configuration, restart the client completely.

**VS Code** — create `.vscode/mcp.json` in a working repository, or add the same server to your
VS Code user MCP settings: the block above under `servers` instead of `mcpServers`, with
`"type": "stdio"` beside `command`. Reload the window. On Windows the server sees the projects
under `/workspace`: call `begin_task` with `/workspace/my-project`; on macOS and Linux it sees them
at their own path.

## The local model

Hybrid search has two halves: keyword matching, which works everywhere with no setup, and dense
retrieval on the local BGE-M3 model, which is what makes a search understand a question rather
than match its words. The ONNX runtime comes with every install; the weights do not: about 600 MB,
yours to fetch once, checked against the manifest's sha256 — a download that is cut off continues
from that byte. It runs in Node, with no Python.

| | |
| --- | --- |
| The Windows installer | the wizard's model step: **Download**, or **Import from a folder…** |
| npx | `npx @stonebridgeway/ai-dev-system setup --model` |
| Docker | `docker run --rm -it --network bridge --mount type=volume,source=ai-dev-system-data,target=/data ghcr.io/stonebridgeway/ai-dev-system:latest ai-dev model install` |
| A clone | `npm run setup -- --model` |

Each one installs the model and embeds the documents the index already holds. `model status` says
what is installed and what stopped partway, `verify` hashes every file, `remove` deletes the
model's files and nothing else, and `model doctor` walks the whole path in six stages and names
the one that stopped. An Intel Mac has no build of the ONNX runtime (onnxruntime-node 1.30 ships
none), so there the model does not run and every tool says so; search works by words.

**Room to put it.** The download refuses to start on a disk that cannot hold the weights plus
512 MB left over — it says what it needs and what is there rather than filling the disk to the last
byte. A disk that fits them and not much more still works, and says once that it may be slow.

### When the download is blocked

The download reads `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` the way npm and curl do — credentials
go in the proxy URL, `http://user:password@proxy:3128` — with no `NODE_USE_ENV_PROXY`. A proxy that
signs in with NTLM or Kerberos rather than a password is reached through a local forwarding proxy
that does the sign-in, such as cntlm or px, named in `HTTPS_PROXY`; the error says so when that is
the case. A Hugging Face mirror is one variable:

```bash
AI_DEV_MODEL_MIRROR=https://hf-mirror.com npx @stonebridgeway/ai-dev-system setup --model
```

`AI_DEV_MODEL_MIRROR` (or `HF_ENDPOINT`, which other Hugging Face tools read) is tried first, then
huggingface.co; a source that fails hands over to the next, which continues the same partial file.
Every file is checked against the manifest whichever source sent it. In a container, pass them with
`--env`.

No route at all? Copy the model from a machine that has one — the folder, a folder above it, a
Hugging Face cache, or a `.zip` of any of them:

```bash
npx @stonebridgeway/ai-dev-system model import /media/usb/bge-m3-onnx.zip
```

Into the Docker volume, mount it for that one run: `docker run --rm -it --mount
type=volume,source=ai-dev-system-data,target=/data --mount
type=bind,source=/media/usb,target=/import,readonly ghcr.io/stonebridgeway/ai-dev-system:latest ai-dev
model import /import/bge-m3-onnx.zip`.

### A model on the host, for Docker

A model already on the host — `~/.ai-dev/models/bge-m3-onnx`, where npx and a clone put it — can be
mounted read-only instead of copied into the volume: name the folder *above* it, `~/.ai-dev/models`
(`--model-path` of bootstrap, `-ModelPath` on Windows, `--model` of `clients install --docker`):

```bash
sh ./bootstrap.sh --model-path "$HOME/.ai-dev/models"
```

The image reads `/models/bge-m3-onnx` first when it holds anything — the sessions and its own checks
alike (docs/DEFECTS.md, Д-346) — so a model there that is not whole is put right on the host, or the
mount dropped. A folder that holds model files itself (`pytorch_model.bin`, `config.json`, `onnx/`) is
the value the variable had before 2.1, and every installer refuses it with directions rather than
mounting it one level too deep. When `bge-m3-onnx` is a link to another disk, the entry mounts the
link itself, which Docker follows on the host — in the container the link alone would lead nowhere;
one that leads nowhere on the host either is refused (Д-368). Every session mounts what it leads
to, so while that disk is away Docker starts no session at all — the client's log shows Docker's
"bind source path does not exist". Writing the entries says so, and where the command line is
installed, `ai-dev clients doctor` names the entry whose mounted folder is gone (Д-385). The model's
files and folders have to be readable to the image's user, uid 1000; when they are not, the start
report, `embedding_status`, `ai-dev setup` and `ai-dev model status` say so (Д-337, Д-357). The
documents are embedded with it, with no download and no network, by `docker run --rm -it --mount
type=volume,source=ai-dev-system-data,target=/data --mount type=bind,source=<the folder above
bge-m3-onnx>,target=/models,readonly ghcr.io/stonebridgeway/ai-dev-system:latest ai-dev setup --model`
(Д-341).

### If you want the weights inside the image

The published image stays small without them, which is right for the default. An air-gapped
machine, or an image handed to a team that should not each download the weights, wants the model
baked in. That is your build, not the distribution's: a Dockerfile of two lines and one build
command:

```dockerfile
# Dockerfile.bge — build it from the folder holding the weights
FROM ghcr.io/stonebridgeway/ai-dev-system:latest
COPY --chown=node:node bge-m3-onnx/ /models/bge-m3-onnx/
```

```bash
docker build -f Dockerfile.bge -t ai-dev-system:bge-bundled "$HOME/.ai-dev/models"
```

The result needs no mount and no variable: `/models/bge-m3-onnx` is already there, where the image
looks first. Everything else — `--network none`, the read-only root filesystem, the unprivileged
user — stays as it was.

### Coming from the Python backend

2.x could run dense search on a Python virtualenv with torch and 2.3 GB of weights
(`--dense-python`, `AI_DEV_DENSE_BACKEND=python`, an image built with `INSTALL_BGE_M3=1`). 3.0
removed it (decision D3). One command moves you over — in a clone `npm run setup -- --model`, with
npx `npx @stonebridgeway/ai-dev-system setup --model`.

It installs the ONNX model and embeds the documents again: vectors made by the Python backend are
another model's and are not compared with ONNX questions, so they wait for this run and are replaced
by it; the rest of the index is kept. Until you run it, search works without its dense half. Every
leftover setting — `AI_DEV_DENSE_BACKEND=python`, `BGE_M3_PYTHON`, `AI_DEV_EMBEDDINGS_PYTHON`,
`AI_DEV_PYTHON_BASE`, `BGE_M3_PYTHON_REVISION`, `BGE_M3_MODEL_DIR` — is no longer read; the health
check names each one it finds, and the `~/.ai-dev/models/bge-m3` folder of torch weights can be
deleted. `--dense-python` still works as a name and does what `--model` does, and a Docker build
passing `INSTALL_BGE_M3=1` is told what replaced it (Д-375). BuildKit's terminal view folds a
finished step's output, which `--progress=plain` keeps on screen; a step taken from the cache prints
nothing, so a later build of the same tree shows the notice only with `--no-cache`.

### Checking that it worked

The health check's `embedding_backend` reports `skipped` with what to run while there is no model,
and `ok` with it ([When something does not work](#when-something-does-not-work) has the command for
each install). For the detail behind that one line, the `embedding_status` tool says whether the
model can run and why: `installed` and `available` are the answer, `reason` is a sentence rather
than a flag, and `partial` lists downloads that stopped partway. Under `dense_backend.onnx`,
`missing` lists files that are not there and `mismatched` lists files that are there and are not
the pinned export — the first means the mount did not arrive, the second means the bytes are wrong;
`unreadable`, when present, says why this user could not read the model at all (docs/DEFECTS.md,
Д-358). Anything left of a 2.x Python install is under `dense_backend.legacy`, and makes the health
check a `warn` until it is cleaned up. Then `search_index_status` reports `dense_documents` against
`dense_pending_documents`: a fresh index has vectors for none of its documents until the model is
installed (or, for a model mounted from the host, `ai-dev setup --model` as above).

## The daemon and the settings

How a client is served — the protocol is the same either way:

| | |
| --- | --- |
| `ai-dev mcp` | What a local entry runs. It hands the client to the **daemon**: one warm server for every client of this user, started by the first client and gone after 30 minutes without one (`AI_DEV_IDLE_TIMEOUT_MS`). The index and the model are in memory once, not once per client, and the state has one writer. The handshake passes through, instructions included, and each session runs in its own client's environment — PATH, proxy, certificates. Clients whose code, Node or data differ (another copy of AI Dev, another Node, another `AI_DEV_VAULT_ROOT`) get a daemon each; two spellings of one folder are one. A daemon that dies is replaced at the client's next request; when none can start, the client is served in its own process and stderr says why. |
| `AI_DEV_DAEMON=0` in a client's `env`, `npm start` in a clone, a 2.x entry (`node …/src/server.mjs`) | One stdio process per client, as in 2.x. |
| A Docker entry | One container per session, with no daemon. |
| `ai-dev daemon status \| stop \| start \| run` | Its pid, sessions, memory and log (`~/.ai-dev/logs/daemon.log`), and every other daemon of the runtime home with why it is another; `stop` ends them all — a client's next request starts a new one; `run` serves in a terminal. |

The daemon's address is drawn at random on every start and written, with a secret, to
`~/.ai-dev/run/daemon-<build>.json`, which only you can read; each connection proves it holds the
secret and the daemon proves it back (see
[SECURITY.md](../ai-dev-mcp-server/docs/SECURITY.md#the-daemon)). A home whose path is too long for a
socket puts it in `$XDG_RUNTIME_DIR/ai-dev` or `/tmp/ai-dev-<uid>` instead.

**Settings.** `~/.ai-dev/config.json` keeps what the desktop app — or the `settings_set` tool —
changes: the capability profiles (`AI_DEV_PROFILES`), the model mirror (`AI_DEV_MODEL_MIRROR`), the
model's folder (`BGE_M3_ONNX_DIR`), the daemon's idle time (`AI_DEV_IDLE_TIMEOUT_MS`, in minutes
there), the projects folder, whether the desktop app starts the daemon when it starts
(`daemon_autostart`) and the interface's language. Every `ai-dev` command started afterwards — and
so every client a local install connected, and the desktop app's connection to the daemon — reads
it, and a variable set in the environment still wins. `settings_set` says when each change takes
effect: a mirror from the next download on, in the same session too; a model folder or the profiles
in sessions started afterwards — the daemon's search loaded its folder when it started, so a client
reconnects to use the new one, and a daemon for it starts; the idle time when the daemon starts
next. Until then `settings_get` gives what the session uses and lists the change as `pending`, and
the model tools refuse to put a model in the folder the session is leaving. A value is checked
before it is stored; one that is no longer valid is reported by `settings_get` and not used. The
profiles are what every agent client without its own `AI_DEV_PROFILES` gets, so they cannot include
the opt-in `control`. The tools an app drives the install with — its status, setup, the model, the
clients, logs, settings — are the opt-in `control` profile:
[CONTROL-API.md](../ai-dev-mcp-server/docs/CONTROL-API.md).

## The ai-dev command line

Every install has the same command line: `npx @stonebridgeway/ai-dev-system <command>`, `ai-dev
<command>` after a global install, `npm run ai-dev -- <command>` in a clone,
`& "$env:USERPROFILE\.ai-dev\app\current\ai-dev.cmd" <command>` in PowerShell after the Windows
installer (in cmd, `"%USERPROFILE%\.ai-dev\app\current\ai-dev.cmd" <command>`), and `docker run
--rm -it --mount type=volume,source=ai-dev-system-data,target=/data <image> ai-dev <command>` in the
image.

| Command | What it does |
| --- | --- |
| `ai-dev setup` | Builds what a first start needs, connects the clients, `--model` the local model ([npx](#one-command-with-node-npx)). |
| `ai-dev clients list \| install \| remove \| doctor \| entry` | The `ai-dev` entry in each client ([Connecting AI clients](#connecting-ai-clients)). |
| `ai-dev model status \| install \| import \| verify \| remove \| doctor` | The local model ([The local model](#the-local-model)). |
| `ai-dev mcp` | What a client starts: its stdio MCP session, served by the daemon. |
| `ai-dev daemon start \| stop \| status \| run` | The one warm server every client is handed to. |
| `ai-dev doctor` | The health check, as JSON; `--dense-smoke` also runs the model once. |
| `ai-dev backup`, `ai-dev restore` | The vault and the state in one archive, and back ([RECOVERY.md](../ai-dev-mcp-server/docs/RECOVERY.md)). |
| `ai-dev uninstall` | What the Windows uninstaller runs. |
| `ai-dev help [command]` | Every command and its options. |

Every command exits 0 done, 1 failed, 2 wrong usage, 130 stopped with Ctrl-C; `uninstall` adds 3,
something is in use, and 4, the data was kept. A mistyped command or option is answered before
anything is read or moved.
`node ai-dev-mcp-server/scripts/ai-dev.mjs`, the 2.x CLI, still runs every command, with a note on
stderr, until 4.0.

## Updating, and coming from 2.x

| Install | The update |
| --- | --- |
| The Windows installer | The app offers it; **Restart to update to …** in the tray, or it is installed at **Quit**. |
| npx | `npx @stonebridgeway/ai-dev-system@latest setup`: the new copy goes beside the old one, the entries move to it, and the two copies chosen last stay, so a client still running the previous one keeps it. |
| Docker | `docker pull ghcr.io/stonebridgeway/ai-dev-system:latest`: the next session runs it. Running bootstrap again does the same and rewrites what changed in the entries; it mounts the folders it is given, not the ones an entry mounts now, so run it with the same options: the projects folder — `--project-path` (`-ProjectPath`), `~/AI-Dev-Projects` without one — and a model folder on the host — `--model-path` (`-ModelPath`), or none when neither it nor `AI_DEV_MODEL_PATH` names one. A 2.x entry's `AI_DEV_PROJECT_PATH` and `AI_DEV_MODEL_PATH` are not read either: name those folders again. |
| A clone | `git pull`, then `cd ai-dev-mcp-server && npm ci && npm run setup`. |

An install of 2.x — a clone, the Docker launchers, the C# proxy for Claude on Windows — goes on
working after the update, and what it left behind is moved or named when the server starts:
`AI_DEV_HOME` one level too deep, the `ai-dev-system` client entries, hooks that call a bare `node`,
the Docker volume's skills and state, the Python dense backend. What changes, what moves by itself,
what needs one command from you, and how to go back: **[Moving from 2.x to 3.0](MIGRATION.md)**.
`npm run upgrade:test` checks all of it against a 2.x clone, and `npm run docker:upgrade-check --
--old-image <2.x image> --new-image <image>` the Docker part against a 2.x volume and its launchers
([Upgrade test](UPGRADE-TEST.md)).

## Uninstalling

| Install | |
| --- | --- |
| The Windows installer | **Settings → Apps → Installed apps → AI Dev → Uninstall**. It asks whether to take AI Dev out of the AI clients (yes by default) and whether to delete its data, `%USERPROFILE%\.ai-dev` (no by default) — [Uninstalling](DESKTOP.md#uninstalling). |
| npx | `npx @stonebridgeway/ai-dev-system clients remove` takes `ai-dev` out of every client — a file nothing else has changed since gets back what it held, less any `ai-dev` or `ai-dev-system` entry the install replaced, which the `<file>.backup-<time>` beside it keeps; `npx @stonebridgeway/ai-dev-system daemon stop`; then delete `~/.ai-dev/app`, and `~/.ai-dev` itself to delete your data too: the vault, the tasks and session history, the model, the index, the backups, the settings. |
| Docker | Take the `ai-dev` entry out of each client — `clients remove` from any install with Node, or by hand ([Connecting AI clients](#connecting-ai-clients) lists the files); `docker volume rm ai-dev-system-data` deletes the data, `docker image rm ghcr.io/stonebridgeway/ai-dev-system:latest` the image. `~/.ai-dev/state` holds what the server and the hooks shared. |

Your projects are never touched.

## When something does not work

The health check says what is wrong and what to run:

| Install | |
| --- | --- |
| The Windows installer | the **Status** screen, or `& "$env:USERPROFILE\.ai-dev\app\current\ai-dev.cmd" doctor` in PowerShell (`"%USERPROFILE%\.ai-dev\app\current\ai-dev.cmd" doctor` in cmd) |
| npx | `npx @stonebridgeway/ai-dev-system doctor` |
| Docker | `docker run --rm --network none --mount type=volume,source=ai-dev-system-data,target=/data ghcr.io/stonebridgeway/ai-dev-system:latest ai-dev doctor` |
| A clone | `npm run -s doctor` |

A client that shows the server as failed: `clients doctor` starts every entry the way its client
would and checks the answer. If Docker Desktop cannot pull the image behind a VPN or corporate DNS,
configure a proxy or DNS in Docker Desktop; do not put proxy passwords in a Dockerfile, Git, build
arguments or project files. An image that is already pulled runs with no internet access. More on
the image — the scanners in the container, Compose, GHCR — is in
[docker/README.md](../docker/README.md) (in Russian).

## From a clone

For working on AI Dev itself. From the clone root:

```bash
cd ai-dev-mcp-server
npm ci
npm run setup
```

`npm ci` runs no dependency install scripts: the package's `.npmrc` turns them off. The one that
matters, onnxruntime-node's, downloads a CUDA provider the server never loads and fails offline or
behind a proxy (docs/DEFECTS.md, Д-86); `npm install` behaves the same. `npm run setup` is
[the same setup](#one-command-with-node-npx) as npx's, in place: the clients' entries name this
clone's `bin/ai-dev.mjs`, and without a vault the server reads the bundled seed,
`docker/public-seed`. Entries 2.x wrote keep working: `node <clone>/ai-dev-mcp-server/src/server.mjs`
is still an entry point. The development workflow and the gates: [CONTRIBUTING.md](../CONTRIBUTING.md).
