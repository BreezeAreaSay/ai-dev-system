# Install

[← README](../README.md) · [Workflow](WORKFLOW.md) · [Capabilities](CAPABILITIES.md) · [Guard rails](GUARDRAILS.md)

Every supported path, from the one-command bootstrap to building the image
yourself. If you only want to get started, the three commands in the
[README](../README.md#install) are enough.

## Contents

- [Requirements](#requirements)
- [One command on Windows](#one-command-on-windows)
- [One command on macOS and Linux](#one-command-on-macos-and-linux)
- [Quick start: Docker](#quick-start-docker)
- [Connecting AI agents](#connecting-ai-agents)
- [Docker Compose and BGE-M3](#docker-compose-and-bge-m3)
- [Publishing for a team](#publishing-for-a-team)
- [Arch / AUR and Homebrew](#arch--aur-and-homebrew)
- [Verification and diagnostics](#verification-and-diagnostics)

## Requirements

For the Docker path:

- Docker Desktop (Windows / macOS) or Docker Engine (Linux); bootstrap can install it;
- Docker must have access to the project folder you choose.

To run from source you additionally need Node.js 22.12+ and npm. On Windows you can
use the bundled runtime described in the [server README](../ai-dev-mcp-server/README.md).
From the clone root:

```bash
cd ai-dev-mcp-server
npm ci --ignore-scripts --no-audit --no-fund
npm run setup
```

`npm run setup` builds the three things a clone does not ship — the skill
registry, the search index and the routing benchmark — and prints the health
check. Add `--frontend-qa` for the QA runner's dependencies, `--dense` for the
local BGE-M3 model and the embeddings built with it (~2.3 GB); neither runs
unless asked. No Obsidian vault is needed: without one the server reads the
bundled seed and its helper trees from the repository itself.

## One command on Windows

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

On Linux it uses `apt`, `dnf`, or `pacman`, enables the Docker service, and adds
the current user to the `docker` group. You then need to log out and back in and
re-run the command.

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

## Quick start: Docker

### 1. Get the image

```bash
docker pull ghcr.io/stonebridgeway/ai-dev-system:latest
```

Or build the image from a clone of the repository:

```bash
cd ai-dev-mcp-server
npm ci --ignore-scripts --no-audit --no-fund
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

## Connecting AI agents

In every case, replace `C:\ABSOLUTE\PATH` with the absolute path to your clone of
this repository, and `C:\Dev` with the folder that holds your projects. Do not
commit these values to Git.

To start an agent with a narrowed tool surface, add `AI_DEV_PROFILES` to the
`env` block of any of the configurations below — see
[Capabilities](CAPABILITIES.md).

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

## Docker Compose and BGE-M3

For Compose, copy `docker/compose.local.example.yaml` to
`docker/compose.local.yaml`, set a local `AI_DEV_PROJECT_PATH`, and run:

```bash
docker compose -f docker/compose.yaml -f docker/compose.local.yaml run --rm -T ai-dev-mcp
```

`compose.local.yaml` and `docker/.env` are Git-ignored because they can contain
local paths.

For more accurate semantic search you can build a variant with BGE-M3:

```bash
docker build --build-arg INSTALL_BGE_M3=1 --tag ai-dev-system:bge .docker/build-context
```

The model weights are not embedded in the image. Mount your own local folder via
`AI_DEV_MODEL_PATH`; the launcher attaches it read-only as `/models/bge-m3`. See
[the server README](../ai-dev-mcp-server/README.md#semantic-search-bge-m3) for how to
download the weights when running from source.

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
   this repository.
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
