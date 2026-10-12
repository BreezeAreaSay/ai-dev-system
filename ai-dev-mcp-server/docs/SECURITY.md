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

`ai-dev mcp`, which every client config runs, hands the client to one daemon per user, runtime
home and build (`src/daemon.mjs`). The daemon serves the vault, the projects' context and the
state, so a process that could talk to it, or pass for it, would read what the agents read and
tell them what to do. What stands in the way:

- **Who can reach it.** A Unix socket lives in a directory of mode 0700 that belongs to the user
  — the runtime's `run/`, or `$XDG_RUNTIME_DIR/ai-dev` or `/tmp/ai-dev-<uid>` when the home's
  path leaves no room for a socket. A directory that is a link, belongs to another uid or cannot
  hold a socket is passed over, never used; the socket itself is created under umask 077 and is
  mode 0600. On Windows the daemon listens on a named pipe; the pipe's default security
  descriptor gives other users read access at most, and a client needs read and write.
- **Who can take its place.** The name is drawn at random (96 bits) on every start and published
  only in the daemon's descriptor, `run/daemon-<build>.json`, mode 0600, inside the user's
  runtime home — on Windows, inside the user's profile, whose ACL keeps other users out. The
  name is not a secret: Linux lists every socket path in `/proc/net/unix`, which anyone can read,
  and any Windows user can list the names of the pipes. What the random name prevents is a
  process creating the pipe first and waiting for clients on it: a fixed name —
  `\\.\pipe\ai-dev-<user>` until 3.0 — could be taken before the daemon started (docs/DEFECTS.md,
  Д-107). Access itself is decided by the directory, the pipe's permissions and the handshake.
- **Who it talks to.** The first line each side sends proves it holds the 256-bit secret in the
  descriptor, without sending it: the client answers the daemon's nonce with an HMAC-SHA256
  bound to both nonces, and the daemon answers the client's with another, bound to both nonces
  and its pid, which must be the pid the descriptor names. A process that reached the socket
  anyway is refused before any MCP message, and learns nothing it can replay; a client that
  reached something other than the daemon — an address another process took over after the
  daemon exited — refuses it before it sends anything else.
- **What each session sees.** Only then does the client send its environment, and the daemon
  runs that session — its tools, the processes they start, its downloads, the certificates its
  downloads and its `https://` proxy are checked against — in it, as the client's own process
  would have run in 2.x: one client's PATH, proxy or token never serves another (Д-190, Д-200).
  The environment stays in the daemon's memory for the session's life and is not written
  anywhere.
- **What it serves.** A daemon serves only clients of its own build: the same code and version,
  the same Node, and the same data — the home, the runtime home, the vault, the state, the index
  and the model folder, each resolved as the server resolves it, so two spellings of one folder
  are one, and a folder under a link is one before it exists and after (`daemonIdentity` in
  `src/core/session-env.mjs`; an AI Dev variable it does not know counts as part of the build;
  Д-199, Д-202). A
  client of another build gets a daemon of its own, with its own descriptor and lock; the
  daemon of code replaced where it lies — a `git pull`, an update in place — retires: it takes
  no new client, finishes the sessions it has and is listed in `run/retired-<pid>.json` until it
  exits (Д-191), holding a lock on that record as it held one on its descriptor (Д-198).
  `ai-dev daemon status` shows every daemon of the runtime home and, by variable name, why it is
  not this one; `ai-dev daemon stop` stops them all.
- **One daemon per build.** Its lock, `run/daemon-<build>.json.lock`, follows the protocol every
  lock of AI Dev does (`src/core/file-lock.mjs`): created exclusively, refreshed while the daemon
  lives, broken only when its holder is gone or silent and only if it is still the lock judged
  abandoned (Д-193). A daemon whose lock went silent but whose address still takes connections —
  hung in a debugger, stopped, swapped out, its connection queue full — keeps its socket and its
  record: `stop` asks it and says if it did not stop, and once it wakes it takes its lock again
  and puts back a record taken away meanwhile (Д-204, Д-205, Д-208). On macOS a full queue is
  refused like a dead socket, so there such a daemon can be taken for gone: its record comes back
  once it runs, its socket — if a new daemon removed it — does not. Its `run/` folder is 0700
  however it comes to be made, and folders it made again for its record go when it does (Д-213).

What it does not stand against: anything running as the same user (it can read the descriptor,
as it can read the vault), an administrator or root, and a runtime home placed with `AI_DEV_HOME`
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
