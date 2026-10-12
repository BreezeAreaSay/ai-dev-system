/**
 * The tray: a dot in the colour of the daemon's state, and a menu — open the
 * window, rebuild the search index, stop the daemon, quit.
 */
import { circlePng, TRAY_COLOURS, trayState } from "./tray-icon.mjs";

/**
 * The tray's menu as a template, so a test can read it without a tray.
 *
 * @param {{ t: (key: string, params?: object) => string, online: boolean, rebuilding: number | null, failed?: string | null, stopFailed?: string | null }} view
 *   `failed` — why the last rebuild from the tray failed, until the next one;
 *   `stopFailed` — why the last Stop failed, until the next one.
 * @param {{ open: () => void, rebuild: () => void, stop: () => void, quit: () => void }} actions
 */
export function trayMenuTemplate({ t, online, rebuilding, failed = null, stopFailed = null }, actions) {
  const rebuildLabel = rebuilding !== null ? t("tray.rebuilding", { percent: rebuilding }) : failed ? t("tray.rebuildFailed") : t("tray.rebuild");
  return [
    { id: "open", label: t("tray.open"), click: actions.open },
    {
      id: "rebuild",
      label: rebuildLabel,
      enabled: online && rebuilding === null,
      click: actions.rebuild
    },
    { id: "stop", label: stopFailed ? t("tray.stopFailed") : t("tray.stop"), enabled: online, click: actions.stop },
    { type: "separator" },
    { id: "quit", label: t("tray.quit"), click: actions.quit }
  ];
}

/**
 * Create the tray and keep it in step with the daemon.
 *
 * @param {{ electron: typeof import("electron"), link: import("./daemon-link.mjs").DaemonLink, t: (key: string, params?: object) => string, actions: object }} options
 *   `t` translates into the language in force when it is called.
 * @returns {{ tray: import("electron").Tray, refresh: () => void, setRebuilding: (percent: number | null) => void, setStopFailed: (failure: string | null) => void, state: () => string, menu: () => Array<object>, tooltip: () => string }}
 */
export function createTray({ electron, link, t, actions }) {
  const { Menu, Tray, nativeImage } = electron;
  const images = Object.fromEntries(Object.entries(TRAY_COLOURS).map(([state, rgb]) => {
    const image = nativeImage.createFromBuffer(circlePng(rgb, 32), { scaleFactor: 2 });
    return [state, image];
  }));
  let current = "offline";
  let rebuilding = null;
  let failed = null;
  let stopFailed = null;
  // What Electron was last given, which is what the person sees.
  let template = [];
  let tip = "";
  const tray = new Tray(images.offline);
  const refresh = () => {
    const online = link.state.phase === "online";
    // A Stop that failed was about the daemon the app was on: once the app is
    // off it, the note no longer holds (docs/DEFECTS.md, Д-276, п. 1).
    if (!online) stopFailed = null;
    current = online ? trayState(link.status) : "offline";
    tray.setImage(images[current]);
    const tips = [
      t(`tray.tooltip.${current}`),
      failed ? t("tray.rebuildFailedTip", { message: failed.slice(0, 120) }) : null,
      stopFailed ? t("tray.stopFailedTip", { message: stopFailed.slice(0, 120) }) : null
    ];
    tip = tips.filter(Boolean).join("\n");
    tray.setToolTip(tip);
    template = trayMenuTemplate({ t, online, rebuilding, failed, stopFailed }, actions);
    tray.setContextMenu(Menu.buildFromTemplate(template));
  };
  tray.on("click", actions.open);
  link.on("state", refresh);
  link.on("status", refresh);
  refresh();
  return {
    tray,
    refresh,
    /** The rebuild's progress (null: not running); when it ends, why it failed, if it did. */
    setRebuilding(percent, failure = null) {
      rebuilding = percent;
      if (percent !== null) failed = null;
      else failed = failure ? String(failure) : null;
      refresh();
    },
    /** Why the last Stop failed (null: it did not). */
    setStopFailed(failure) {
      stopFailed = failure ? String(failure) : null;
      refresh();
    },
    state: () => current,
    /** The menu as Electron was last given it: each item's id, label and whether it is enabled. */
    menu: () => template.filter((item) => item.id).map(({ id, label, enabled = true }) => ({ id, label, enabled })),
    /** The tooltip as Electron was last given it. */
    tooltip: () => tip
  };
}
