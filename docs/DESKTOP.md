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
  `Program Files\nodejs`). None found: the window says so, and which variable to set.
- **The server beside it**: `ai-dev-mcp-server/` next to `desktop/` in a checkout, or the folder
  `AI_DEV_SERVER_ROOT` names.

## What it shows

- **Connecting / not running.** When the daemon is not running and the setting `daemon_autostart`
  is on (the default), the app starts it, as a client's bridge does. With it off, or when the start
  fails, the window says the daemon is not running and has a **Start the daemon** button; a start
  that failed shows why, with the last lines of the daemon's log.
- **The first-run wizard** opens by itself while the search index is not built, and from **Setup**
  at any time:
  1. **Projects folder** — chosen in the system's dialog and kept in the settings (`projects_root`).
  2. **AI clients** — the clients found on this computer, with a box each; **Connect the chosen
     clients** writes their configs (`clients_install`), each backed up first.
  3. **Local model** — **Download** with progress and **Cancel** (what was fetched is kept, and the
     next download continues from there), **Import from a folder…** — a copy from another computer
     or a USB stick — or **Skip for now**: search then works by words.
  4. **Search index** — builds the skill registry and the index (`setup_run`), with the model's
     vectors when the model is there, with progress.
  5. **AI Dev is ready** — what to do next, and the way to Status.
- **Status** — whether the install works, works with something to look at, or does not work yet;
  the model, the index and the clients at a glance; every health check with its verdict, its
  details and what to do about it; **Refresh**, **Rebuild the index** and **Run setup again**.

## The tray

The icon's colour is the daemon's state: green — everything works, amber — something needs
attention, red — it does not work yet, grey — the daemon is not running. Its menu: **Open AI Dev**,
**Rebuild search index** (with its progress), **Stop the daemon**, **Quit**. Closing the window
keeps the app in the tray; **Quit** ends it. The daemon is not the app's: it goes on serving the
clients after the app quits, and leaves on its own when nobody uses it.

## Languages

English and Russian (owner decision D6). The language follows the system until you choose one in
the header; the choice is kept in the settings (`language`) and the tray follows it.

## Security

The window shows only the app's own page and gives it nothing of Node or the file system:

- the page is served under `app://ai-dev` from `desktop/src/renderer` only — nothing outside it, no
  link out of it — with a Content Security Policy that allows the page's own scripts, styles and
  images and nothing else: no inline script, no `eval`, no network;
- the page runs isolated and sandboxed (`contextIsolation`, `sandbox`, no `nodeIntegration`); its
  only way out is a frozen `window.aiDev` with eight functions, each one channel of the main process;
- the main process answers those channels only from the app's page, and calls only the tools the
  interface has a button for — not `model_remove`, `clients_remove` or any agent tool; arguments are
  checked (plain JSON, at most 64 KB) and every call has an id for its progress and cancel;
- the page cannot navigate away, open windows or `<webview>`s, ask for permissions or start
  downloads, and every request to anything but `app://` is cancelled.

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
to the end, a download cancelled midway and the state it leaves, the screen without a daemon and
its Start button, the screen without Node, Status with its checks, Russian, the tray, and what the
page cannot reach. On a Linux machine without a display they run under `xvfb-run`; screenshots go
to `desktop/test-results/`.
