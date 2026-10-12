// What every end-to-end test needs: an install of its own — a home, a vault,
// a runtime home, the synthetic model on a local host — and the app launched
// in it through Playwright's Electron driver, with the real daemon behind it.
// Nothing touches the person's home: every path an AI client or AI Dev reads
// is inside the test's folder.
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { _electron as electron } from "playwright-core";

const require = createRequire(import.meta.url);
export const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const serverRoot = path.resolve(process.env.AI_DEV_SERVER_ROOT || path.join(desktopRoot, "..", "ai-dev-mcp-server"));
export const resultsDir = path.join(desktopRoot, "test-results");

const fromServer = (relative) => import(pathToFileURL(path.join(serverRoot, relative)).href);
const { startModelHost } = await fromServer("test/fixtures/model-host.mjs");
const { writeSyntheticModel } = await fromServer("src/core/synthetic-model.mjs");
const { stopDaemons } = await fromServer("src/core/daemon-client.mjs");

/** The model file a download stalls in, when a test wants one to cancel. */
export const STALLED_FILE = "onnx/model_int8.onnx";

/**
 * A fresh install: home, vault, the model's files on a "USB stick" and on a
 * local host, settings when given.
 *
 * @param {import("node:test").TestContext} t
 * @param {{ stall?: boolean, seed?: boolean, settings?: object, env?: object }} [options]
 *   `seed`: the vault is a copy of the public seed — the skill catalog a real install has.
 */
export async function stage(t, { stall = false, seed = false, settings = null, env: extra = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-desktop-"));
  const home = path.join(root, "home");
  const vault = path.join(root, "vault");
  const projects = path.join(root, "projects");
  await fs.mkdir(path.join(vault, "02-knowledge"), { recursive: true });
  await fs.mkdir(path.join(vault, "03-skills-catalog", "registries"), { recursive: true });
  await fs.mkdir(projects, { recursive: true });
  if (seed) await fs.cp(path.join(serverRoot, "..", "docker", "public-seed"), vault, { recursive: true });
  await fs.writeFile(path.join(vault, "02-knowledge", "storage.md"), "# Storage\n\nThe postgres schema keeps every table.\n");
  if (!seed) await fs.writeFile(path.join(vault, "03-skills-catalog", "registries", "skills.index.json"), "[]");
  const usb = path.join(root, "usb", "bge-m3-onnx");
  const { manifest, files } = await writeSyntheticModel(usb);
  const host = await startModelHost({ files, stallAfter: new Map(stall ? [[STALLED_FILE, 1000]] : []) });
  const manifestFile = path.join(root, "synthetic.manifest.json");
  await fs.writeFile(manifestFile, JSON.stringify({ ...manifest, sources: [host.base] }));
  const aiDevHome = path.join(home, ".ai-dev");
  await fs.mkdir(aiDevHome, { recursive: true });
  if (settings) await fs.writeFile(path.join(aiDevHome, "config.json"), JSON.stringify({ schema_version: 1, ...settings }));
  const env = {
    PATH: process.env.PATH,
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude-config"),
    CODEX_HOME: path.join(home, ".codex"),
    AI_DEV_HOME: aiDevHome,
    AI_DEV_VAULT_ROOT: vault,
    AI_DEV_MODEL_MANIFEST: manifestFile,
    AI_DEV_IDLE_TIMEOUT_MS: "60000",
    // The Node the daemon runs on: the one running this test.
    AI_DEV_NODE: process.execPath,
    AI_DEV_SERVER_ROOT: serverRoot,
    AI_DEV_DESKTOP_TEST: "1",
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    ...extra
  };
  t.after(async () => {
    await stopDaemons({ timeoutMs: 5000, env }).catch(() => undefined);
    await host.close();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { root, home, vault, projects, usb, host, env, manifestFile };
}

/**
 * Launch the app in `env`; closed when the test ends.
 *
 * @returns {Promise<{ app: import("playwright-core").ElectronApplication, page: import("playwright-core").Page }>}
 */
export async function launch(t, env) {
  const app = await electron.launch({
    executablePath: require("electron"),
    // As root, Chromium wants no sandbox of its own; the page keeps its sandbox flag.
    args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), desktopRoot],
    env,
    timeout: 60_000
  });
  t.after(() => app.close().catch(() => undefined));
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

/** The system's folder dialog answers `folder` (null: cancelled). */
export function answerFolderDialog(app, folder) {
  return app.evaluate(({ dialog }, chosen) => {
    dialog.showOpenDialog = async () => (chosen ? { canceled: false, filePaths: [chosen] } : { canceled: true, filePaths: [] });
  }, folder);
}

/** A screenshot for the phase report, in desktop/test-results. */
export async function shot(page, name) {
  await fs.mkdir(resultsDir, { recursive: true });
  const file = path.join(resultsDir, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

/** A tool's answer through the app's own connection to the daemon (the main process). */
export function mainCall(app, tool, args = {}) {
  return app.evaluate((_electron, request) => globalThis.aiDevTest.link.call(request.tool, request.args, { id: `test-${Date.now()}` }), { tool, args });
}

/** The tray as the main process has it: its state and its menu. */
export function trayNow(app) {
  return app.evaluate(() => ({ state: globalThis.aiDevTest.tray.state(), menu: globalThis.aiDevTest.tray.menu() }));
}
