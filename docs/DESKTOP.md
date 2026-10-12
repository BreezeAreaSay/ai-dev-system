# The desktop app

A tray icon, a first-run wizard, a Status screen, the screens of your work — projects, costs,
skills, settings, the daemon's log — and a console for every tool, over the daemon every AI client
shares. The app is in `desktop/`, built on Electron (owner decision D5; the version is pinned in
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
- **Projects** — the projects AI Dev knows (registered with `register_project`, or by a task begun
  in them), and a project's card: its tasks with their criteria, its epics — how far each has come
  and the part to work on next —, its decisions, the handoffs sessions left for the next one, and
  the project card itself. Returning to Projects opens the card you left.
- **Costs** — what the work has cost today, yesterday, in the last seven days and in all, by model,
  by tool and by task, for all projects or one (`usage_report`). A cost the client did not report
  is an estimate from the published prices; a retired model's price is not checked again.
- **Skills** — the catalog by group, a search, and a skill to read.
- **Settings** — the projects folder, the tool profiles AI clients get, the model's download mirror,
  the model folder, the daemon's idle time and whether the app starts it: each with what it does,
  the value in force and where it comes from, and when a change applies — at once, to AI client
  sessions started afterwards, or when the daemon starts next. A change for new sessions reaches
  the app when it reconnects: **Reconnect now** opens a new session, and the daemon goes on. A value
  the daemon refuses is not written, and the daemon's reason is shown. The language is chosen in the
  header.
- **Log** — the daemon's log and its part set aside at 1 MB; **Follow** reads it again every two
  seconds while the screen is open.
- **Console** — every tool the daemon lists to the app, each marked *reads only*, *changes
  something* or *deletes*; a form built from the tool's input schema (text, choices, numbers within
  their bounds, flags, lists one per line, JSON for the rest), checked before it is sent; the answer
  readable — names and values, lists, Markdown — and as JSON. A tool that changes something runs
  only after you confirm it (see Security).

Every screen shows that it is loading, says why it is empty when it is, and shows an error with
**Try again**. Everything works from the keyboard — a skip link before the header, a visible focus
ring, each screen's heading taking the focus — and the colours meet WCAG AA in the light and the
dark scheme (a unit test checks the stylesheet).

## The app's session

The app reaches the daemon as a client of its own, named `ai-dev-desktop`, whose session lists
every tool an agent gets and the control API (`all,control`) — the screens read through the agent's
tools, and the console needs them all. The `profiles` setting is what AI clients get; it does not
narrow the app.

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
  only way out is a frozen `window.aiDev` with eleven functions, each one channel of the main process;
- the main process answers those channels only from the app's page. The screens call only the
  tools named in `desktop/src/main/ipc-policy.mjs` — the control API's buttons and the read-only
  tools the data screens show — not `model_remove`, `clients_remove` or an agent tool that changes
  something;
- the tool console may call any tool the daemon lists to the app, but one the daemon does not mark
  read-only (`readOnlyHint`) runs only after you confirm it in the system's message box, which the
  main process shows: the tool, its arguments, and Cancel as the default. The page can ask for a
  call; it cannot answer the box, skip it, or call a tool read-only on its own word;
- arguments are checked (plain JSON, at most 64 KB) and every call has an id for its progress and
  cancel;
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
page cannot reach; the data screens with work an AI client made (a project with an epic, a
decision, a handoff, usage), in English and Russian, and empty on a fresh install; Settings — a
refused value, a change for new sessions and the reconnect; the console — a read-only tool at once,
one that changes something cancelled and then confirmed, the page calling the console directly;
the keyboard; a daemon stopped while a screen polls it. On a Linux machine without a display they run under `xvfb-run`; screenshots go
to `desktop/test-results/`.
