/**
 * What keeps the window's page a local page: it is served from the app's own
 * folder under the `app://` scheme, may load nothing from anywhere else, may
 * not navigate or open windows, gets no permission it asks for, and reaches
 * the main process only through the preload's few functions
 * (`docs/DESKTOP.md`, "Security").
 */
import fs from "node:fs/promises";
import path from "node:path";

/** The scheme the page is served under, and its one host. */
export const APP_SCHEME = "app";
export const APP_HOST = "ai-dev";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * The page's Content Security Policy, sent with every file and repeated in
 * the page's `<meta>`: its own scripts, styles and images, and nothing else —
 * no inline script, no `eval`, no network.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join("; ");

const TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8"
});

/** The `webPreferences` of every window: no Node, an isolated and sandboxed page. */
export function windowPreferences(preload) {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    devTools: true
  };
}

/** Whether `url` is a page of this app. */
export function isAppUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

/**
 * The file under `root` that an `app://` request names, or null when it names
 * none: another host, a path outside `root` (`..`, an encoded separator, a
 * drive letter), or a type the page has no use for.
 *
 * @param {string} root - The renderer folder, absolute.
 * @param {string} url
 * @returns {{ file: string, type: string } | null}
 */
export function appFileFor(root, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${APP_SCHEME}:` || parsed.host !== APP_HOST) return null;
  let relative;
  try {
    relative = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (relative.includes("\0") || relative.includes("\\")) return null;
  if (relative === "/" || relative === "") relative = "/index.html";
  const file = path.resolve(root, `.${relative}`);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  const type = TYPES[path.extname(file).toLowerCase()];
  return type ? { file, type } : null;
}

/**
 * Answer an `app://` request from the renderer folder: the file with the
 * policy, 404 for anything else. A symbolic link that leads out of the folder
 * is refused as well.
 *
 * @param {string} root
 * @returns {(request: Request) => Promise<Response>}
 */
export function appFileHandler(root) {
  const canonicalRoot = fs.realpath(root);
  return async (request) => {
    const target = appFileFor(root, request.url);
    if (!target || request.method !== "GET") return new Response("Not found", { status: 404 });
    try {
      const real = await fs.realpath(target.file);
      const base = await canonicalRoot;
      if (!real.startsWith(base + path.sep)) return new Response("Not found", { status: 404 });
      const body = await fs.readFile(real);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": target.type,
          "content-security-policy": CONTENT_SECURITY_POLICY,
          "x-content-type-options": "nosniff",
          "cache-control": "no-store"
        }
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  };
}

/**
 * Close the session to everything but the app's own files: requests to any
 * other scheme are cancelled, permissions are refused, downloads are not
 * started.
 *
 * @param {import("electron").Session} session
 */
export function lockSession(session) {
  session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(`${APP_ORIGIN}/`) || details.url.startsWith("devtools://");
    callback({ cancel: !allowed });
  });
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on("will-download", (event) => event.preventDefault());
}

/**
 * Keep a page where it is: no navigation away from the app, no new windows,
 * no `<webview>`.
 *
 * @param {import("electron").WebContents} contents
 */
export function lockContents(contents) {
  contents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on("will-redirect", (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
}
