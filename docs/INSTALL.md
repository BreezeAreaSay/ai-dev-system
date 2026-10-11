# Install

[← README](../README.md) · [Workflow](WORKFLOW.md) · [Capabilities](CAPABILITIES.md) · [Guard rails](GUARDRAILS.md)

Every supported path: running it locally from a clone, the packaged Docker path,
wiring up each client, and the local dense model. If you only want to get
started, the commands in the [README](../README.md#install) are enough.

## Contents

- [Requirements](#requirements)
- [Quick start: run it locally](#quick-start-run-it-locally)
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

- Docker Desktop (Windows / macOS) or Docker Engine (Linux); bootstrap can install it;
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
| `ai-dev mcp` | The stdio MCP server a client starts (`npm start` runs the same server). |
| `ai-dev doctor` | The health check, as JSON (`npm run doctor`). |
| `ai-dev help [command]` | Every command and its options. |

Exit codes are the same for every command: 0 done, 1 failed, 2 wrong usage, 130 stopped
with Ctrl-C. A mistyped command or option is answered before anything is read or moved.
`node ai-dev-mcp-server/scripts/ai-dev.mjs`, the 2.x CLI, still runs every command, with
a note on stderr, until 4.0.

Two ways to run it, and they speak the same protocol:

| | |
| --- | --- |
| `ai-dev mcp` (`npm start`) | One stdio process per client. The default, and what `clients install` configures. |
| `npm run daemon` | **Experimental.** One warm process on a local socket (a named pipe on Windows). No client can connect to it yet — nothing bridges a client's stdio to the socket — and it fails to start when the socket path is longer than 108 bytes (docs/DEFECTS.md, Д-97). Use `ai-dev mcp`. |

**Why local first.** The dense model is the reason. Locally it is one flag —
`npm run setup -- --model` — and it lands in `~/.ai-dev`; neither the model nor the
vectors it computes need Python. A container runs with no network, so the weights
cannot be downloaded inside it at all: they are downloaded on the host and mounted
at `/models` (see [The local model in a container](#the-local-model-in-a-container)).
The image says so about itself (`AI_DEV_RUNTIME=docker`), and the health check reads
it: inside a container `embedding_backend` reports dense search as not set up and
points at the mount, rather than at a `npm run setup` no container can run.

## One command on Windows

This is the packaged path: the script installs Docker and pulls the image. For
the local path see [Quick start: run it locally](#quick-start-run-it-locally).

After `git clone`, open PowerShell in the clone root and run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

The script creates an isolated `AI-Dev-Projects` folder in your home directory,
installs Docker Desktop and Node.js LTS via `winget` if they are missing,
pulls the published image, verifies MCP, and registers the local `ai-dev` server
with Codex, Cursor, Gemini, VS Code, and Claude. On Windows it also installs a
launcher-only copy at `C:\ProgramData\AI-Dev-System\run-mcp.ps1`, which avoids
encoding problems when the clone path contains non-ASCII characters. That folder
never receives projects, the vault, tokens, or passwords. For Claude Desktop it
additionally creates a small `ClaudeMcpProxy.exe` in the same folder: it answers
the MCP initialization handshake before Docker has started, so Claude's short
startup timeout is satisfied, and then transparently forwards the session to the
local Docker container.

Run the first invocation **as administrator** only if Docker Desktop or Node.js
are not yet installed: `winget` and Docker may request elevation. If Docker
Desktop is already installed, a normal PowerShell session is enough.

For a different project folder and a subset of clients:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 `
  -ProjectPath "D:\Projects" `
  -Clients "codex,cursor,vscode"
```

The path is stored only in the local settings of the selected clients. No tokens,
passwords, folder contents, or your profile are written to Git. Restart the AI
client afterwards.

## One command on macOS and Linux

Also the packaged path. For the local one see
[Quick start: run it locally](#quick-start-run-it-locally).

If Docker is already installed and running:

```bash
sh ./bootstrap.sh
```

If Docker is not installed yet, one command covers every supported system:

| System | Command after `git clone` |
| --- | --- |
| macOS | `sh ./bootstrap.sh --install-prerequisites` |
| Debian / Ubuntu | `sh ./bootstrap.sh --install-prerequisites` |
| Fedora | `sh ./bootstrap.sh --install-prerequisites` |
| Arch Linux / Manjaro | `sh ./bootstrap.sh --install-prerequisites` |

On macOS the script uses Homebrew: it installs Homebrew with the official
installer if needed, then runs `brew install --cask docker`, starts Docker
Desktop, and waits for the engine. The first launch of Docker Desktop may require
accepting the licence and confirming privileged settings in the app window.

On Linux it installs the distribution's own Docker engine and nothing else —
`docker.io` with `apt` (Debian, Ubuntu), `moby-engine` with `dnf` (Fedora), `docker`
with `pacman` (Arch); bootstrap never uses compose. It runs the package manager
through `sudo`, or directly when you are root, enables the Docker service, and adds
the current user to the `docker` group. You then need to log out and back in and
re-run the command; as root there is no group to join and it carries straight on.

Bootstrap needs no Node.js on the host: it configures MCP clients from a
throwaway `node:24` container. By default it pulls
`ghcr.io/stonebridgeway/ai-dev-system:latest`, and the working folder is created
as `~/AI-Dev-Projects` and mounted into the container as `/workspace`.

So that Claude Desktop and other clients do not abort Docker's slow cold start,
bootstrap creates a helper container `ai-dev-system-runtime-$(id -u)`. It runs
with no network, a read-only filesystem, no Linux capabilities, and
`no-new-privileges`; it is granted access only to the system's named volume and
the chosen project folder. The MCP process itself starts through a fast
`docker exec`, and the launcher completes the protocol handshake immediately. The
container comes back automatically after a Docker restart thanks to
`restart=unless-stopped`.

For a different project folder and a subset of clients:

```bash
sh ./bootstrap.sh --project-path "$HOME/Dev" --clients "codex,cursor,vscode"
```

Re-running the same command safely updates only the managed runtime container.
The named volume, indexes, knowledge base, and project files are left intact.
Check the runtime with:

```bash
docker ps --filter "label=ai-dev.system.runtime=true"
```

To develop the image itself, use explicit local mode:

```bash
sh ./bootstrap.sh --build-local
```

If the registry cannot be reached and an older copy of the image is already in
the local Docker cache, bootstrap stops rather than installing it. It prints
when that copy was created and its digest, so you can tell how far behind it is.
Installing it anyway is a deliberate choice:

```bash
sh ./bootstrap.sh --allow-stale-image
```

On Windows the same switch is `-AllowStaleImage`. Prefer restoring the registry
connection: a cached image can be missing fixes that are already released.

## The packaged path: Docker

Choose this when you want the system on a machine that should not hold a
personal vault, or when a team needs one image everybody runs the same way. The
image carries no vault, passwords, tokens, projects or task history. It is not
the faster path to a working install on your own machine — that is the local one
above — and the local dense model is off by default in it.


### 1. Get the image

```bash
docker pull ghcr.io/stonebridgeway/ai-dev-system:latest
```

Or build the image from a clone of the repository:

```bash
cd ai-dev-mcp-server
npm ci
npm run docker:prepare
npm run docker:audit
npm run docker:build
npm run docker:smoke -- --image ai-dev-system:local
```

The build always uses the temporary allowlisted context `.docker/build-context`,
never the repository root or an Obsidian vault. Do not point the Docker context
at a vault root.

### 2. Choose a working folder

Create or choose a folder that contains only the repositories the agent is
allowed to work on — for example `C:\Dev` on Windows or `$HOME/Dev` on
macOS / Linux. This folder is mounted into the container as `/workspace`.

Do not use a personal vault, your entire home directory, or a folder with secrets
or backups.

### 3. Verify the local launch

Windows:

```powershell
$env:AI_DEV_IMAGE = "ghcr.io/stonebridgeway/ai-dev-system:latest"
$env:AI_DEV_PROJECT_PATH = "C:\Dev"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\docker\run-mcp.ps1
```

macOS / Linux:

```bash
export AI_DEV_IMAGE="ghcr.io/stonebridgeway/ai-dev-system:latest"
export AI_DEV_PROJECT_PATH="$HOME/Dev"
sh ./docker/run-mcp.sh
```

The process waits for MCP messages on standard input. That is expected: end the
check with `Ctrl+C`, then wire the launcher command into an MCP client.

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
scan in which not one scanner ran comes back `unchecked`, never `pass`.

## Connecting AI agents

Do not edit these files by hand when an installer covers the client. From a clone,
`npm run setup` — or on its own, `npm run clients:install` (`ai-dev clients install`) —
configures all six clients; for the Docker path, bootstrap does.

### From a clone

| Client | Config file | Entry |
| --- | --- | --- |
| Claude Code | `~/.claude.json` | `mcpServers.ai-dev`, with `type: "stdio"` |
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

**The Docker path.** The blocks below show the shape of what the Docker installer writes — on Windows
it also sets `AI_DEV_MCP_LAUNCHER`, and Claude gets `ClaudeMcpProxy.exe` instead of
PowerShell — for reference and for a client neither installer covers.

In every case, replace `C:\ABSOLUTE\PATH` with the absolute path to your clone of
this repository, and `C:\Dev` with the folder that holds your projects. Do not
commit these values to Git.

### Codex

Add to your user `config.toml`:

```toml
[mcp_servers.ai-dev]
command = "powershell.exe"
args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"]
env = { AI_DEV_IMAGE = "ghcr.io/stonebridgeway/ai-dev-system:latest", AI_DEV_PROJECT_PATH = "C:\\Dev" }
startup_timeout_sec = 120
tool_timeout_sec = 3600
```

On macOS / Linux use `command = "/bin/sh"` and pass the absolute path to
`docker/run-mcp.sh` in `args`. Also set the name bootstrap created in `env`:
`AI_DEV_RUNTIME_CONTAINER = "ai-dev-system-runtime-UID"`, where `UID` is the
output of `id -u`. The automatic installer does this for you. Restart Codex and
confirm that the `ai-dev` server appears in the MCP tool list.

### Cursor, Claude Desktop, Claude Code, and Gemini

These clients use JSON with an `mcpServers` property. Add or merge the block below
into their existing configuration:

When you run `bootstrap.ps1 -Clients claude`, the installer updates both local
Claude files: `%USERPROFILE%\.claude.json` for Claude Code and
`%APPDATA%\Claude\claude_desktop_config.json` for Claude Desktop. Existing servers
are preserved, and the file being changed is backed up first. For the Microsoft
Store build of Claude, the installer also updates the sandboxed app profile under
`%LOCALAPPDATA%\Packages\Claude_*`. On Windows, do not replace the
automatically installed Claude configuration with the example below: it uses
`C:\ProgramData\AI-Dev-System\ClaudeMcpProxy.exe` for a fast Docker-MCP start.
On macOS / Linux, bootstrap similarly stores `AI_DEV_RUNTIME_CONTAINER` in the
configuration and wires the fast launcher; there is no need to edit the Claude
files by hand after bootstrap.

```json
{
  "mcpServers": {
    "ai-dev": {
      "command": "powershell.exe",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"
      ],
      "env": {
        "AI_DEV_IMAGE": "ghcr.io/stonebridgeway/ai-dev-system:latest",
        "AI_DEV_PROJECT_PATH": "C:\\Dev"
      }
    }
  }
}
```

A minimal template with no project access is in
[docker/mcp-config.example.json](../docker/mcp-config.example.json). After changing
the configuration, restart the client completely. In Claude Code and the Gemini
CLI the configuration can be added through their own MCP management command, but
the launch command and environment variables stay the same.

### VS Code

Create `.vscode/mcp.json` in a specific working repository, or add the same server
to your VS Code user MCP settings:

```json
{
  "servers": {
    "ai-dev": {
      "type": "stdio",
      "command": "powershell.exe",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"
      ],
      "env": {
        "AI_DEV_IMAGE": "ghcr.io/stonebridgeway/ai-dev-system:latest",
        "AI_DEV_PROJECT_PATH": "C:\\Dev"
      }
    }
  }
}
```

Reload the VS Code window. Inside the container, mounted repository paths start
with `/workspace`; for example, call `begin_task` with `/workspace/my-project`.

## Docker Compose

Copy `docker/compose.local.example.yaml` to `docker/compose.local.yaml`, set a
local `AI_DEV_PROJECT_PATH`, and run:

```bash
docker compose -f docker/compose.yaml -f docker/compose.local.yaml run --rm -T ai-dev-mcp
```

`compose.local.yaml` and `docker/.env` are Git-ignored because they can contain
local paths.

## The local model in a container

Hybrid search has two halves: keyword matching, which works everywhere with no
setup, and dense retrieval on the local BGE-M3 model, which is what makes a
search understand a question rather than match its words. The container can run
both, and since the ONNX runtime is an ordinary npm dependency it is already in
the default image — there is nothing to turn on. One thing is still missing, for
one reason.

**The weights are never in the published image.** They are yours, not the
distribution's — an image carrying them would be a several-hundred-megabyte pull
for every user and a licence question for the publisher. Download them once on
the host:

```bash
cd ai-dev-mcp-server
npm run model -- install --no-index
```

(`npm run setup -- --model` does the same and also embeds the host's own index; a
container embeds its own.) A download that breaks — a dropped connection, a laptop
lid, Ctrl-C — keeps what arrived, and the next run continues from that byte. If the
host cannot reach huggingface.co, see
[When the download is blocked](#when-the-download-is-blocked).

**Room to put them.** About 600 MB of weights, and the download refuses to start
on a disk that cannot hold them plus 512 MB left over — it says what it needs and
what is there rather than filling the disk to the last byte. A disk that fits
them and not much more still works, and says once that it may be slow: writing
near a full disk is where a download that crawls usually comes from, and it looks
exactly like a dead connection from the outside.

They land in `~/.ai-dev/models/bge-m3-onnx` (override with `BGE_M3_ONNX_DIR`, or
`--dir` for one run). Mount the folder *above* them — `~/.ai-dev/models` —
read-only; the container reads the weights and never writes them, from
`bge-m3-onnx/` under the mount.

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

`AI_DEV_MODEL_PATH` names the folder *above* the models — `~/.ai-dev/models`, the one
`npm run setup -- --model` fills — not a model directory. A folder that holds model
files itself (`pytorch_model.bin`, `config.json`, `onnx/`) is the value the variable
had before 2.1, and the launchers refuse it with directions rather than mounting it one
level too deep. That includes `ClaudeMcpProxy.exe`, Claude's launcher on Windows, which
until this release mounted the folder at `/models/bge-m3`, where the image never looks, so
Claude on Windows had no dense search (docs/DEFECTS.md, Д-88).

With the installer, which is the default Docker path:

```bash
sh ./bootstrap.sh --model-path "$HOME/.ai-dev/models"
```

The fast-start runtime mounts the folder read-only as `/models`, and the client
configurations bootstrap writes carry `AI_DEV_MODEL_PATH`, so the cold fallback
launch mounts it too. `AI_DEV_MODEL_PATH` in the environment is the default for
`--model-path`; on Windows the switch is `-ModelPath`.

With the launcher scripts directly:

```bash
export AI_DEV_MODEL_PATH="$HOME/.ai-dev/models"
export AI_DEV_PROJECT_PATH="/absolute/path/to/your/project"
sh docker/run-mcp.sh
```

With Compose, uncomment the model mount in your `compose.local.yaml` — the
example file carries it with the same variable — and run:

```bash
export AI_DEV_MODEL_PATH="$HOME/.ai-dev/models"
docker compose -f docker/compose.yaml -f docker/compose.local.yaml run --rm -T ai-dev-mcp
```

Both attach the folder at `/models`; inside the image `BGE_M3_ONNX_DIR` points at
`/models/bge-m3-onnx`. `compose.yaml` runs with `network_mode: none`, and that does
not get in the way: the worker loads the model with remote models turned off, so
it is read from the mount and nothing reaches for the network. It is also why the
weights have to arrive by mount rather than by a download inside the container.

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
there, which is what `BGE_M3_ONNX_DIR` points at. Everything else — `network_mode:
none`, the read-only root filesystem, the unprivileged user — stays as it was.

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
until `npm run setup -- --model` has embedded them.

Running from source instead? Then none of this applies: `npm run setup --
--dense` is the whole of it. See
[the server README](../ai-dev-mcp-server/README.md#semantic-search-bge-m3).

## Publishing for a team

The [docker-publish.yml](../.github/workflows/docker-publish.yml) workflow checks the
privacy policy, rebuilds the allowlisted context, runs the MCP smoke test, and
publishes `linux/amd64` and `linux/arm64` images to the GitHub Container Registry
with an SBOM and provenance.

After the first push:

1. Open the package in GitHub and set its visibility to `private` / `internal`
   for a team, or `public`.
2. Make sure teammates can read GitHub Packages.
3. Give teammates the address `ghcr.io/stonebridgeway/ai-dev-system:latest` and
   this README.
4. Each teammate sets their own local project folder via `AI_DEV_PROJECT_PATH`;
   other people's files never enter the image or Git.

## Arch / AUR and Homebrew

After publication in AUR, install on Arch Linux / Manjaro with:

```bash
yay -S ai-dev-system-git
ai-dev-system --install-prerequisites
```

The package follows `main`. It can also be built from this clone:

```bash
cd packaging/arch
makepkg -si
ai-dev-system --install-prerequisites
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
- **Docker on Windows.** Run `bootstrap.ps1` once more, so Claude's `ClaudeMcpProxy.exe` is
  rebuilt and mounts the model folder where the image looks (Д-88).
- **Docker.** `docker pull` the new image; the runtime tree in the `/data` volume moves the
  same way on the first start.

`npm run upgrade:test` checks all of this against a 2.x install; see
[Upgrade test](UPGRADE-TEST.md).

## Verification and diagnostics

Before a release, from `ai-dev-mcp-server` run:

```powershell
npm run check
npm run docker:prepare
npm run docker:audit
npm run docker:smoke -- --image ai-dev-system:local
```

For a full sweep of the whole suite:

```powershell
..\scripts\run-acceptance.ps1
```

If Docker Desktop cannot pull the base image behind a VPN or corporate DNS,
configure a proxy / DNS in Docker Desktop. Do not put proxy passwords in the
Dockerfile, Git, build args, or project files. An image that is already built
runs with no internet access.

Compose, macOS / Linux, BGE-M3, and GHCR details: [docker/README.md](../docker/README.md).
Architecture and the full tool list: [ai-dev-mcp-server/README.md](../ai-dev-mcp-server/README.md).
