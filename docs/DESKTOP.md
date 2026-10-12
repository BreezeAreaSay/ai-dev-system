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
  `Program Files\nodejs`). None found: the window says so, and **Try again** looks again — a Node
  installed since is found; one named in `AI_DEV_NODE` needs the app started again.
- **The server beside it**: `ai-dev-mcp-server/` next to `desktop/` in a checkout, or the folder
  `AI_DEV_SERVER_ROOT` names, with its packages installed (`npm ci` there). The app's own variables
  (`AI_DEV_SERVER_ROOT`, `AI_DEV_DESKTOP_*`) do not split it from the clients: it reaches their daemon.

When something of this is missing — the server, its packages — or the settings file is broken, the
window says what, and what to do — in the system's language: fix the settings file or remove it,
then **Try again**; **Restart AI Dev** for the server, whose code is loaded once per run. A language
chosen on the broken-settings screen holds, and is written to the settings once the file can be
read — unless the fixed file names a language of its own, which then holds.

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
- **Status** — whether the install works, works with something to look at, or does not work yet, and
  why — the daemon's own summary and the settings file's problems; the model, the index and the
  clients at a glance; every health check with its verdict, its details and what to do about it, the
  failing ones first and the critical among them marked; **Refresh**, **Rebuild the index** — with
  its progress and **Cancel**, still there after a look elsewhere — and **Run setup again**. The
  three slow checks `system_status` does not run (search smoke, dense smoke, search eval) are left
  to `ai-dev doctor`.
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
included; when none serves yet, it starts one only if it may start the daemon at all (autostart
on, or **Start** pressed). The old daemon leaves once its last session ends, an AI client's too.

## Languages

English and Russian (owner decision D6). The language follows the system until you choose one in
the header; the choice is kept in the settings (`language`) — while they cannot be written, it holds
for the run and is written as soon as they can be — and the tray follows it. The app's own
words — screens, check and step names, states, advice — are in both; what the daemon writes — a
check's summary, a step's outcome, an error — is in English, as in the CLI.

## Security

The window shows only the app's own page and gives it nothing of Node or the file system:

- the page is served under `app://ai-dev` from `desktop/src/renderer` only — nothing outside it, no
  link out of it — with a Content Security Policy that allows the page's own scripts, styles and
  images and nothing else: no inline script, no `eval`, no network;
- the page runs isolated and sandboxed (`contextIsolation`, `sandbox`, no `nodeIntegration`) in a
  session of its own, kept in memory; its only way out is a frozen `window.aiDev` with twelve
  functions, each one channel of the main process;
- the main process answers those channels only from the app's page. The screens call only the tools
  named in `desktop/src/main/ipc-policy.mjs` — the control API's buttons and the read-only tools the
  data screens show — with only the arguments those screens send, checked by kind: not
  `model_remove`, `clients_remove`, an agent tool that changes something, a forced rebuild, a client
  the wizard does not offer;
- the tool console may call any tool the daemon lists to the app, but one the daemon does not mark
  read-only (`readOnlyHint`) runs only after you confirm it in the system's message box, which the
  main process shows: the tool, its arguments, and Cancel as the default. The page can ask for a
  call; it cannot answer the box, skip it, or call a tool read-only on its own word;
- arguments are plain JSON of at most 64 KB, and every call has an id of the page's own for its
  progress and cancel;
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
failed start again, a daemon that dies and one a client starts again, a daemon that will not stop, a
second launch, Status with its checks, Russian, the tray's verdict with a failing critical check, an
AI client joining the app's daemon, a daemon replaced by a newer one, and what the page cannot reach
— WebRTC and the names it would look up, another page with the app's functions, the developer tools;
the data screens with work an AI client made (a project with an epic, a decision, a handoff, usage),
in English and Russian, and empty on a fresh install; Settings — a refused value, a change for new
sessions and the reconnect; the console — a read-only tool at once, one that changes something
cancelled and then confirmed, the page calling the console directly; the keyboard; a daemon stopped
while a screen polls it. On a Linux machine without a display they run under `xvfb-run`; screenshots
go to `desktop/test-results/`. Where Chromium cannot have its own sandbox (as root, or
`AI_DEV_DESKTOP_NO_SANDBOX=1` on a CI runner that forbids user namespaces) it runs without it; the
page keeps its sandbox flag.
