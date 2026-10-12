/**
 * The desktop app's main process: one window with the app's own page, the
 * tray, and one connection to the daemon every AI client shares
 * (docs/DESKTOP.md).
 */
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import electron from "electron";
import { pickLanguage, translate } from "../renderer/i18n.js";
import { DaemonLink } from "./daemon-link.mjs";
import { EVENT_CHANNELS, INVOKE_CHANNELS, refuseCall, refuseClients, validCallId } from "./ipc-policy.mjs";
import { createLanguageKeeper } from "./language.mjs";
import { findNode } from "./node-runtime.mjs";
import { APP_ORIGIN, APP_SCHEME, PAGE_PARTITION, appFileHandler, isAppUrl, lockContents, lockSession, windowPreferences } from "./security.mjs";
import { startupFailure } from "./startup.mjs";
import { createTray } from "./tray.mjs";

const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, session } = electron;

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..", "..");
const rendererRoot = path.join(desktopRoot, "src", "renderer");
const preload = path.join(desktopRoot, "src", "preload", "preload.cjs");

/** The server this app drives: beside it in a checkout, inside it when packaged, or AI_DEV_SERVER_ROOT. */
function serverRoot() {
  if (process.env.AI_DEV_SERVER_ROOT) return path.resolve(process.env.AI_DEV_SERVER_ROOT);
  if (app.isPackaged) return path.join(process.resourcesPath, "ai-dev-mcp-server");
  return path.resolve(desktopRoot, "..", "ai-dev-mcp-server");
}

/**
 * The menu: none on Windows and Linux; on macOS the app and Edit menus, which
 * the system's copy and paste go through. Neither has Reload or the developer
 * tools (docs/DEFECTS.md, Д-252).
 */
function applicationMenu() {
  return process.platform === "darwin" ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]) : null;
}

// Chromium resolves no host name in this app: the page has no network, and a
// name it hands to WebRTC or a dns-prefetch would otherwise still go to the
// system's resolver — a way out for what a script put in it (docs/DEFECTS.md,
// Д-260). The daemon is reached from Node, over a socket; Node's own lookups
// do not go through this rule.
app.commandLine.appendSwitch("host-resolver-rules", "MAP * ~NOTFOUND");
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let window = null;
  let tray = null;
  let server = null;
  let node = null;
  let language = pickLanguage("", "");
  let quitting = false;
  let starting = null;
  // What the window says when the start failed or no Node was found, drawn
  // again in the language chosen afterwards (Д-264).
  let explain = null;
  // Windows open only once the page's session is locked and served.
  let ready = false;
  // The main process's own calls are named apart, so two at once do not share an id.
  let ownCalls = 0;
  const env = { ...process.env };
  const root = serverRoot();
  const t = (key, params) => translate(language, key, params);
  const devTools = process.env.AI_DEV_DESKTOP_DEVTOOLS === "1";
  const link = new DaemonLink({ env, t });
  // The language chosen, kept in the settings file — or held until the file
  // can take it (docs/DEFECTS.md, Д-271, п. 4; Д-276, п. 2, 3; Д-279).
  const languages = createLanguageKeeper({ server: () => server, env });

  const publicState = () => ({ ...link.state, language, platform: process.platform });
  const fromApp = (event) => isAppUrl(event.senderFrame?.url ?? "");

  const openWindow = () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return;
    }
    window = new BrowserWindow({
      width: 980,
      height: 720,
      minWidth: 720,
      minHeight: 520,
      title: t("app.title"),
      autoHideMenuBar: true,
      backgroundColor: "#f6f8fa",
      webPreferences: windowPreferences(preload, { devTools })
    });
    window.on("close", (event) => {
      if (!quitting && tray) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on("closed", () => {
      window = null;
    });
    window.loadURL(`${APP_ORIGIN}/index.html`);
    // AI_DEV_DESKTOP_DEVTOOLS=1 is for working on the app: the tools open with the window (Д-266, п. 5).
    if (devTools) window.webContents.openDevTools({ mode: "detach" });
  };

  const quit = async () => {
    quitting = true;
    // A language that waits is written once more; the file's lock is waited
    // for a second at most (Д-279).
    await languages.settle().catch(() => undefined);
    languages.stop();
    await link.close();
    app.quit();
  };

  const rebuildFromTray = async () => {
    tray.setRebuilding(0);
    const result = await link.call("rebuild_search_index", {}, {
      id: "tray-rebuild",
      onProgress: ({ progress, total }) => tray.setRebuilding(total ? Math.min(99, Math.floor((progress / total) * 100)) : 0)
    });
    // A failure is said where the rebuild was asked for (Д-257, п. 5); the
    // link's own words by their key, said again in another language (Д-280).
    tray.setRebuilding(null, result.ok || result.cancelled ? null : { key: result.key, text: result.error });
  };

  // The tray's Stop: a daemon that would not stop is said in the menu, as a
  // failed rebuild is — from the answer, which names it, or an error — and
  // Stop is offered again while it runs (Д-271, п. 6; Д-273; Д-277).
  const stopFromTray = async () => {
    tray.setStopping();
    let failure = null;
    try {
      const answer = await link.stopDaemon();
      const failed = (answer?.daemons ?? []).filter((daemon) => daemon.stopped === false);
      if (failed.length) {
        failure = { message: failed.map((daemon) => daemon.reason ?? "it is still running").join("; "), pids: failed.map((daemon) => daemon.pid) };
      }
    } catch (error) {
      failure = { message: String(error?.message ?? error), pids: [] };
    }
    tray.setStopFailed(failure);
  };

  /**
   * Get going: the server, the settings, the Node the daemon runs on, the
   * daemon. Whatever stops it is shown in the window with what to do — the
   * app never sits there silent (docs/DEFECTS.md, Д-242). Run again by Try
   * again, and when the app is launched a second time.
   */
  const startup = () => {
    starting ??= (async () => {
      try {
        server ??= await import(pathToFileURL(path.join(root, "src", "core", "control-client.mjs")).href);
        const read = server.readSettings({ env });
        const settings = read.settings;
        // The language chosen while the file was broken — unless the file, fixed, names its own (Д-276, п. 2).
        language = languages.atStart(read.stored) ?? pickLanguage(settings.language, app.getLocale());
        window?.setTitle(t("app.title"));
        tray?.refresh();
        const clientNodes = await server.clientNodePaths({ env, cliPath: path.join(root, "bin", "ai-dev.mjs") }).catch(() => []);
        node = findNode({ env, clientNodes });
        const linkServer = { ...server, openControlClient: (options) => server.openControlClient({ serverRoot: root, ...options }) };
        explain = node.path ? null : () => link.attach({ server: linkServer, execPath: null, noNode: node.reason ? t(node.reason.key, node.reason.params) : node.problem });
        link.attach({ server: linkServer, execPath: node.path, noNode: node.reason ? t(node.reason.key, node.reason.params) : node.problem });
        if (node.path) await link.connect({ start: settings.daemon_autostart !== false });
      } catch (error) {
        const loaded = Boolean(server);
        explain = () => link.fail(startupFailure(error, { serverRoot: root, loaded, t }));
        explain();
      }
    })().finally(() => {
      starting = null;
    });
    return starting;
  };

  const handle = (channel, listener) => ipcMain.handle(channel, (event, request) => (fromApp(event) ? listener(event, request) : null));

  // macOS: a click on the Dock icon brings the window back (Д-266, п. 12).
  app.on("activate", () => {
    if (ready) openWindow();
  });
  app.on("second-instance", () => {
    if (!ready) return;
    openWindow();
    if (["broken", "no-node"].includes(link.state.phase)) startup();
  });
  app.on("window-all-closed", () => {
    if (!tray) quit();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("web-contents-created", (_event, contents) => lockContents(contents));

  app.whenReady().then(async () => {
    // The system's language until the settings say otherwise — a start that
    // fails before it reads them speaks it too (Д-264).
    language = pickLanguage("", app.getLocale());
    // The page's session serves the app's files and nothing else; the default
    // one is locked the same way, for any window that is not the app's.
    const pageSession = session.fromPartition(PAGE_PARTITION);
    pageSession.protocol.handle(APP_SCHEME, appFileHandler(rendererRoot));
    await lockSession(pageSession);
    await lockSession(session.defaultSession);
    Menu.setApplicationMenu(applicationMenu());
    link.on("state", () => window?.webContents.send(EVENT_CHANNELS.state, publicState()));

    // The page's channels first: whatever happens next, the window can ask.
    handle(INVOKE_CHANNELS.state, () => publicState());
    handle(INVOKE_CHANNELS.connect, async (_event, request) => {
      await link.connect({ start: request?.start === true });
      return publicState();
    });
    handle(INVOKE_CHANNELS.retry, async () => {
      if (link.state.phase === "broken" && link.state.restart) {
        app.relaunch();
        app.exit(0);
        return publicState();
      }
      if (["broken", "no-node"].includes(link.state.phase)) await startup();
      return publicState();
    });
    handle(INVOKE_CHANNELS.call, async (event, request) => {
      let refused = refuseCall(request);
      if (!refused && request.tool === "clients_install") {
        ownCalls += 1;
        const listed = await link.call("clients_list", {}, { id: `clients-offered-${ownCalls}` });
        refused = listed.ok ? refuseClients(request.args.clients, listed.result.clients) : listed.error;
      }
      if (refused) return { ok: false, error: refused, cancelled: false };
      const sender = event.sender;
      return link.call(request.tool, request.args ?? {}, {
        id: request.id,
        onProgress: ({ progress, total, message }) => {
          if (!sender.isDestroyed()) sender.send(EVENT_CHANNELS.progress, { id: request.id, progress, total, message });
        }
      });
    });
    handle(INVOKE_CHANNELS.cancel, (_event, id) => validCallId(id) && link.cancel(id));
    handle(INVOKE_CHANNELS.chooseFolder, async () => {
      const result = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    handle(INVOKE_CHANNELS.setLanguage, async (_event, chosen) => {
      language = pickLanguage(chosen, app.getLocale());
      tray?.refresh();
      window?.setTitle(t("app.title"));
      // A failure screen is the main process's words: say them again in this language.
      if (["broken", "no-node"].includes(link.state.phase)) explain?.();
      // Written here, online or not: a file that cannot take it yet gets it later (Д-279).
      await languages.choose(language);
      return publicState();
    });

    ready = true;
    openWindow();
    tray = createTray({ electron, link, t, actions: { open: openWindow, rebuild: rebuildFromTray, stop: stopFromTray, quit } });
    // What the end-to-end tests read from the main process: the tray, its
    // actions, the daemon link (desktop/test/e2e). Nothing of it reaches the page.
    if (process.env.AI_DEV_DESKTOP_TEST === "1") globalThis.aiDevTest = { tray, link, rebuild: rebuildFromTray, stop: stopFromTray, quit, node: () => node };
    startup();
  });
}
