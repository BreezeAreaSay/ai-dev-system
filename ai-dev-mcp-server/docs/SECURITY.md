# Security Model

## Trust Boundaries

- The vault is trusted local data.
- A project repository may contain untrusted scripts and configuration.
- A quality command executes project code and therefore requires an MCP client approval.
- Search content is data, never executable instruction.

## Invariants

- Paths are checked lexically and through `realpath`; sibling-prefix and junction escapes fail.
- Writes use same-directory temporary files, flush, and atomic replacement.
- Quality and development commands run as executable plus argument arrays with `shell: false`.
- Windows npm/pnpm command shims resolve to package-manager JavaScript entry points and run through
  the current Node executable; no `cmd.exe` interpolation is used.
- Shell interpreters, control operators, inline code, dynamic package execution, and network tools fail closed.
- Output, duration, and process trees are bounded.
- Password notes are left unchanged by explicit owner decision. They are not exposed as MCP resources.
- Backup archives may contain those owner-kept local notes and therefore stay under the local
  `%AI_DEV_HOME%\backups` boundary (default `%USERPROFILE%\.ai-dev\backups`).

## The Daemon

`ai-dev mcp`, which every client config runs, hands the client to one daemon per user and
runtime home (`src/daemon.mjs`). The daemon serves the vault, the projects' context and the
state, so a process that could talk to it, or pass for it, would read what the agents read and
tell them what to do. What stands in the way:

- **Who can reach it.** A Unix socket lives in a directory of mode 0700 that belongs to the user
  — the runtime's `run/`, or `$XDG_RUNTIME_DIR/ai-dev` or `/tmp/ai-dev-<uid>` when the home's
  path leaves no room for a socket. A directory that is a link, belongs to another uid or cannot
  hold a socket is passed over, never used; the socket itself is created under umask 077 and is
  mode 0600. On Windows the daemon listens on a named pipe; the pipe's default security
  descriptor gives other users read access at most, and a client needs read and write.
- **Who knows where it is.** The name is drawn at random (96 bits) on every start and published
  only in `run/daemon.json`, mode 0600, inside the user's runtime home — on Windows, inside the
  user's profile, whose ACL keeps other users out. A fixed name — `\\.\pipe\ai-dev-<user>` until
  3.0 — could be created by any local process before the daemon, which would then receive every
  client (docs/DEFECTS.md, Д-107).
- **Who it talks to.** The first line each side sends proves it holds the 256-bit secret in
  `daemon.json`, without sending it: the client answers the daemon's nonce with an HMAC-SHA256
  bound to both nonces, and the daemon answers the client's with another, bound to both nonces
  and its pid, which must be the pid `daemon.json` names. A process that reached the socket
  anyway is refused before any MCP message, and learns nothing it can replay; a client that
  reached something other than the daemon — an address another process took over after the
  daemon exited — refuses it before it sends anything.
- **What it serves.** A daemon serves only clients of its own build: the same code, version and
  the variables that change what the server does (`AI_DEV_*`, `BGE_*`, the proxy, the home
  folders). A client of another build makes it retire — it gives up its address at once and
  keeps only the sessions it has — and gets a daemon of its own.

What it does not stand against: anything running as the same user (it can read `daemon.json`, as
it can read the vault), an administrator or root, and a runtime home placed with `AI_DEV_HOME`
in a folder other users can read — on Windows outside the profile, where the folder's ACL decides.
`AI_DEV_DAEMON=0` in a client's environment keeps that client out of the daemon altogether: it is
served in its own process, as in 2.x.

## Command Policy

Approved quality adapters include named package verification scripts, selected Python test/lint
modules, `node --test`, `node --check`, Git diff checking, and established language test tools.
Development startup accepts only named `dev`, `start`, `serve`, or `preview` package scripts.

The policy blocks shell operators, interpreters, inline code, `npx`, network fetchers, dependency
mutation, deploy/publish commands, migrations, and infrastructure mutation. Approval by an MCP
client does not bypass this allowlist.

## Evidence Limits

- A structurally valid skill is not called empirically validated.
- A routing benchmark proves selection, not implementation quality.
- Task outcomes count only after `verify_task` records evidence for the current source fingerprint.
- A generated Frontend QA screenshot must still be visually inspected by the agent.

## Non-Goals

This local server is not an operating-system sandbox. Approved project tests can execute arbitrary code
already present in that repository. Use a container or disposable VM for repositories that are not trusted.
