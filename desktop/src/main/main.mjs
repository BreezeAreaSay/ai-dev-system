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
import { confirmationDialog, consoleDecision, consoleTools } from "./console-policy.mjs";
import { DaemonLink } from "./daemon-link.mjs";
import { EVENT_CHANNELS, INVOKE_CHANNELS, refuseCall, validCallId } from "./ipc-policy.mjs";
import { findNode } from "./node-runtime.mjs";
import { APP_ORIGIN, APP_SCHEME, appFileHandler, isAppUrl, lockContents, lockSession, windowPreferences } from "./security.mjs";
import { createTray } from "./tray.mjs";

const { app, BrowserWindow, dialog, ipcMain, protocol, session } = electron;

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

protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true } }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let window = null;
  let tray = null;
  let link = null;
  let language = "en";
  let quitting = false;
  const env = { ...process.env };
  const t = (key, params) => translate(language, key, params);

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
      webPreferences: windowPreferences(preload)
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
  };

  const quit = async () => {
    quitting = true;
    await link?.close();
    app.quit();
  };

  const rebuildFromTray = async () => {
    tray.setRebuilding(0);
    await link.call("rebuild_search_index", {}, {
      id: "tray-rebuild",
      onProgress: ({ progress, total }) => tray.setRebuilding(total ? Math.min(99, Math.floor((progress / total) * 100)) : 0)
    });
    tray.setRebuilding(null);
  };

  const handle = (channel, listener) => ipcMain.handle(channel, (event, request) => (fromApp(event) ? listener(event, request) : null));

  app.on("second-instance", openWindow);
  app.on("window-all-closed", () => {
    if (!tray) quit();
  });
  app.on("before-quit", () => {
    quitting = true;
  });
  app.on("web-contents-created", (_event, contents) => lockContents(contents));

  app.whenReady().then(async () => {
    protocol.handle(APP_SCHEME, appFileHandler(rendererRoot));
    lockSession(session.defaultSession);
    const root = serverRoot();
    const server = await import(pathToFileURL(path.join(root, "src", "core", "control-client.mjs")).href);
    const settings = server.readSettings({ env }).settings;
    language = pickLanguage(settings.language, app.getLocale());
    const node = findNode({ env, clientNodes: await server.clientNodePaths({ env, cliPath: path.join(root, "bin", "ai-dev.mjs") }).catch(() => []) });
    link = new DaemonLink({ server: { ...server, openControlClient: (options) => server.openControlClient({ serverRoot: root, ...options }) }, env, execPath: node.path, noNode: node.problem });
    link.on("state", () => window?.webContents.send(EVENT_CHANNELS.state, publicState()));

    handle(INVOKE_CHANNELS.state, () => publicState());
    handle(INVOKE_CHANNELS.connect, async (_event, request) => {
      await link.connect({ start: request?.start === true });
      return publicState();
    });
    const progressTo = (sender, id) => ({ progress, total, message }) => {
      if (!sender.isDestroyed()) sender.send(EVENT_CHANNELS.progress, { id, progress, total, message });
    };
    handle(INVOKE_CHANNELS.call, (event, request) => {
      const refused = refuseCall(request);
      if (refused) return { ok: false, error: refused, cancelled: false };
      return link.call(request.tool, request.args ?? {}, { id: request.id, onProgress: progressTo(event.sender, request.id) });
    });
    handle(INVOKE_CHANNELS.tools, async () => consoleTools(await link.tools()));
    // The tool console: what the daemon lists, a tool that changes something
    // only after the person says so in a dialog of this process (console-policy.mjs).
    handle(INVOKE_CHANNELS.consoleCall, async (event, request) => {
      const decision = consoleDecision(request, consoleTools(await link.tools()));
      if (decision.refused) return { ok: false, error: decision.refused, cancelled: false };
      if (decision.confirm) {
        const parent = BrowserWindow.fromWebContents(event.sender) ?? window;
        const { response } = await dialog.showMessageBox(parent, confirmationDialog(decision.tool, decision.args, t));
        if (response !== 0) return { ok: false, error: t("console.notConfirmed"), cancelled: true, confirmed: false };
      }
      return link.call(decision.tool.name, decision.args, { id: decision.id, onProgress: progressTo(event.sender, decision.id) });
    });
    handle(INVOKE_CHANNELS.reconnect, async () => {
      await link.reconnect();
      return publicState();
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
      if (link.state.phase === "online") await link.call("settings_set", { settings: { language } }, { id: "language" });
      else await server.writeSettings({ language }, { env }).catch(() => undefined);
      return publicState();
    });

    openWindow();
    tray = createTray({ electron, link, t, actions: { open: openWindow, rebuild: rebuildFromTray, stop: () => link.stopDaemon(), quit } });
    // What the end-to-end tests read from the main process: the tray and the
    // daemon link (desktop/test/e2e). Nothing of it reaches the page.
    if (process.env.AI_DEV_DESKTOP_TEST === "1") globalThis.aiDevTest = { tray, link, node };
    if (node.path) link.connect({ start: settings.daemon_autostart !== false });
  });
}
