/**
 * What the window says when the app cannot get going (docs/DEFECTS.md,
 * Д-242): the server is not where the app looks, its packages are not
 * installed, the settings file is broken. Each with what to do, and whether
 * Try again can work in this process or the app has to start again — a
 * module that failed to load stays failed until it does.
 */

/**
 * @param {unknown} error - What stopped the start.
 * @param {{ serverRoot: string, loaded: boolean, t: (key: string, params?: object) => string }} context
 *   `loaded` — whether the server's module had loaded before it.
 * @returns {{ error: string, hint: string, detail?: string, restart: boolean }}
 */
export function startupFailure(error, { serverRoot, loaded, t }) {
  const message = String(error?.message ?? error);
  if (!loaded) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && /Cannot find package/.test(message)) {
      return { error: t("broken.noPackages", { path: serverRoot }), hint: t("broken.noPackagesHint", { path: serverRoot }), detail: message, restart: true };
    }
    if (error?.code === "ERR_MODULE_NOT_FOUND" && message.includes("control-client.mjs")) {
      return { error: t("broken.noServer", { path: serverRoot }), hint: t("broken.noServerHint"), detail: message, restart: true };
    }
    return { error: t("broken.serverFailed", { path: serverRoot }), hint: t("broken.restartHint"), detail: message, restart: true };
  }
  if (/config\.json/.test(message)) return { error: message, hint: t("broken.settingsHint"), restart: false };
  return { error: message, hint: t("broken.tryAgainHint"), restart: false };
}
