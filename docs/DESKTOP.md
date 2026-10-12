# The desktop app

A tray icon, a first-run wizard and a Status screen over the daemon every AI client shares. The
app is in `desktop/`, built on Electron (owner decision D5; the version is pinned in
`desktop/package.json`). It does not run AI Dev itself: it drives the same daemon the clients'
`ai-dev mcp` reaches, through the control API
([CONTROL-API.md](../ai-dev-mcp-server/docs/CONTROL-API.md)).

Until the installer of phase 12, the app runs from a checkout:

```bash
cd ai-dev-mcp-server && npm ci && cd ../desktop
npm ci
npm start
```

The Electron binary is fetched the first time it is needed (`npm run electron:install` fetches it
ahead of time).

## What it needs

- **Node.js 22.16 or newer (not 23).** The daemon runs on Node, and the daemon's build includes the
  Node it runs on: the app starts and reaches the daemon with the Node your AI clients use, or the
  clients and the app would each get a daemon of their own. It looks for Node in this order:
  `AI_DEV_NODE`; the Node an AI client's ai-dev entry runs (what `ai-dev clients install` wrote);
  `PATH`; where installers put it (`/opt/homebrew/bin`, `/usr/local/bin`, nvm, Volta,
  `Program Files\nodejs`). None found: the window says so, and **Try again** looks again — a Node
  installed since is found; one named in `AI_DEV_NODE` needs the app started again.
- **The server beside it**: `ai-dev-mcp-server/` next to `desktop/` in a checkout, or the folder
  `AI_DEV_SERVER_ROOT` names, with its packages installed (`npm ci` there). The app's own variables
  (`AI_DEV_SERVER_ROOT`, `AI_DEV_DESKTOP_*`) do not split it from the clients: it reaches their daemon.

When something of this is missing — the server, its packages — or the settings file is broken, the
window says what, and what to do — in the system's language: fix the settings file or remove it,
then **Try again**; **Restart AI Dev** for the server, whose code is loaded once per run. A language
chosen on that screen holds, and is written to the settings once the file can be read.

## What it shows

- **Connecting / not running.** When the daemon is not running and the setting `daemon_autostart`
  is on (the default), the app starts it, as a client's bridge does. With it off, or when the start
  fails, the window says the daemon is not running and has a **Start the daemon** button; a start
  that failed shows why, with the last lines of the daemon's log, and so does a daemon that stopped
  unexpectedly. Without a daemon the app looks for one every ten seconds without starting it: when
  an AI client starts the daemon, the app comes back online by itself.
- **The first-run wizard** opens by itself while the search index is not built, and from **Setup**
  at any time:
  1. **Projects folder** — chosen in the system's dialog and kept in the settings (`projects_root`).
  2. **AI clients** — the clients found on this computer, each with what its ai-dev entry runs now
     (nothing, AI Dev 2.x, another install, Docker, another program) and a box; a client already
     using another install, Docker or another program is not chosen for you — connecting replaces
     that entry — and one whose config cannot be read cannot be chosen. **Connect the chosen
     clients** writes their configs (`clients_install`), each backed up first, and says what
     happened to each, with the reason when one failed.
  3. **Local model** — **Download** with progress and **Cancel** (what was fetched is kept, and the
     next download continues from there), **Import from a folder…** — a copy from another computer
     or a USB stick — or **Skip for now**: search then works by words.
  4. **Search index** — builds the skill registry and the index (`setup_run`), with the model's
     vectors when the model is there, with progress; each step says what it did, and a failed one
     its error. The outcome stays with the step, with **Build again**.

  While a download or a build runs, **Back** and **Next** wait for it; a person who goes to Status
  and comes back finds it still running, with its **Cancel**, or what it came to.
  5. **AI Dev is ready** — what to do next, and the way to Status.
- **Status** — whether the install works, works with something to look at, or does not work yet,
  and why — the daemon's own summary and the settings file's problems; the model, the index and the
  clients at a glance; every health check with its verdict, its details and what to do about it,
  the failing ones first and the critical among them marked; **Refresh**, **Rebuild the index** —
  with its progress and **Cancel**, still there after a look elsewhere — and **Run setup again**. The three slow checks `system_status` does not run (search smoke, dense
  smoke, search eval) are left to `ai-dev doctor`.

## The tray

The icon's colour is the install's state as the health checks give it — the same verdict as
Status: green — everything works, amber — something needs attention, red — it does not work yet,
grey — the daemon is not running. The checks run when the app connects, after anything it changes,
when what is on disk moves (looked at every thirty seconds) and every five minutes. Its menu: **Open
AI Dev**, **Rebuild search index** (with its progress, and when it fails, saying so), **Stop the
daemon** (saying so too when the daemon would not stop), **Quit**. Closing the window keeps the app
in the tray; **Quit** ends it.

The daemon is not the app's: it goes on serving the clients after the app quits. While the app
runs, its session keeps the daemon from leaving on idle; after **Quit** the daemon leaves on its
own when nobody uses it. When the code is updated in place and a daemon of the new code takes over,
the app moves to it once the calls it has running end — the old daemon finishes them, a download
included. The old daemon leaves once its last session ends, an AI client's too.

## Languages

English and Russian (owner decision D6). The language follows the system until you choose one in
the header; the choice is kept in the settings (`language`) and the tray follows it. The app's own
words — screens, check and step names, states, advice — are in both; what the daemon writes — a
check's summary, a step's outcome, an error — is in English, as in the CLI.

## Security

The window shows only the app's own page and gives it nothing of Node or the file system:

- the page is served under `app://ai-dev` from `desktop/src/renderer` only — nothing outside it, no
  link out of it — with a Content Security Policy that allows the page's own scripts, styles and
  images and nothing else: no inline script, no `eval`, no network;
- the page runs isolated and sandboxed (`contextIsolation`, `sandbox`, no `nodeIntegration`) in a
  session of its own, kept in memory; its only way out is a frozen `window.aiDev` with nine
  functions, each one channel of the main process;
- the main process answers those channels only from the app's page, and calls only the tools the
  interface has a button for — the control API's and `rebuild_search_index` — with only the
  arguments those buttons send, checked by kind (`desktop/src/main/ipc-policy.mjs`): not
  `model_remove`, `clients_remove`, another setting, a forced rebuild, a client the wizard does not
  offer. Arguments are plain JSON of at most 64 KB, and every call has an id of the page's own for
  its progress and cancel;
- the page cannot navigate away, open windows or `<webview>`s, ask for permissions or start
  downloads; every request to anything but `app://ai-dev` is cancelled, and WebRTC — which neither
  the policy nor the session's request handler sees — sends no UDP and goes over TCP only to a
  proxy that is not there;
- no host name is looked up for the page: Chromium's resolver in the app resolves nothing
  (`host-resolver-rules`), so neither a TURN server's name nor a `dns-prefetch` reaches DNS. The
  daemon is reached from Node, over its socket. What remains: a `.local` candidate handed to WebRTC
  makes Chromium send a multicast DNS query to the local network — always for the fixed name
  `~NOTFOUND`, never for a name the page chose;
- there is no developer menu and no developer tools (`AI_DEV_DESKTOP_DEVTOOLS=1` opens them with the
  window, for working on the app).

The daemon's own protection — its socket, the secret in its descriptor, one user — is in
[SECURITY.md](../ai-dev-mcp-server/docs/SECURITY.md).

## Tests

```bash
cd desktop
npm test          # unit tests, then the app end to end
npm run test:unit # unit tests only
```

The end-to-end tests launch the app through Playwright's Electron driver on a real daemon, each in
an install of its own (home, vault, runtime home, the synthetic model on a local host): the wizard
to the end and a build run again, a download cancelled midway and the state it leaves, the screen
without a daemon and its Start button, the screen without Node and its Try again, a broken settings
file — in Russian too — and a server without its packages, Restart, a second launch that tries a
failed start again, a daemon that dies and one a client starts again, a second launch, Status with
its checks, Russian, the tray's verdict with a failing critical check, an AI client joining the
app's daemon, a daemon replaced by a newer one, and what the page cannot reach — WebRTC and the
names it would look up, another page with the app's functions, the developer tools. On a Linux machine without a display they run
under `xvfb-run`; screenshots go to `desktop/test-results/`. Where Chromium cannot have its own
sandbox (as root, or `AI_DEV_DESKTOP_NO_SANDBOX=1` on a CI runner that forbids user namespaces) it
runs without it; the page keeps its sandbox flag.
