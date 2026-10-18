import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { shippedRuntime } from "../../src/main/bundle.mjs";
import { findNode } from "../../src/main/node-runtime.mjs";
import { trayMenuTemplate } from "../../src/main/tray.mjs";
import { UPDATE_HOSTS, resolverRules, startUpdates, updaterRequestAllowed, updatesEnabled } from "../../src/main/updates.mjs";
import { translate } from "../../src/renderer/i18n.js";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the shipped runtime is the installed app's resources/runtime on Windows, or the one a test names; a checkout has none", () => {
  const resourcesPath = "C:\\Users\\me\\AppData\\Local\\Programs\\ai-dev-desktop\\resources";
  assert.equal(shippedRuntime({ env: {}, packaged: true, platform: "win32", resourcesPath }), path.join(resourcesPath, "runtime"));
  assert.equal(shippedRuntime({ env: {}, packaged: false, platform: "win32", resourcesPath }), null, "a checkout runs the server beside it");
  assert.equal(shippedRuntime({ env: {}, packaged: true, platform: "darwin", resourcesPath: "/Applications/AI Dev.app/Contents/Resources" }), null,
    "only the Windows installer ships a runtime yet");
  assert.equal(shippedRuntime({ env: { AI_DEV_DESKTOP_BUNDLE: "/tmp/bundle" }, packaged: false, platform: "linux" }), path.resolve("/tmp/bundle"));
});

test("the installed app's own Node comes first after AI_DEV_NODE: the clients it connects run the same", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-bundled-node-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const make = (name) => {
    const file = path.join(root, name, "node");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "", { mode: 0o755 });
    return file;
  };
  const bundled = make("current");
  const client = make("client");
  const old = make("old");
  const versions = new Map([[bundled, "v24.22.0"], [client, "v22.20.0"], [old, "v20.1.0"]]);
  const base = { env: { PATH: "" }, platform: "linux", home: root, versionOf: (file) => versions.get(file) ?? null };
  assert.deepEqual(findNode({ ...base, bundled: [bundled], clientNodes: [client] }), { path: bundled, version: "v24.22.0", source: "bundled" });
  assert.equal(findNode({ ...base, env: { PATH: "", AI_DEV_NODE: client }, bundled: [bundled] }).source, "AI_DEV_NODE", "the person's word still wins");
  versions.set(bundled, "v20.0.0");
  assert.equal(findNode({ ...base, bundled: [bundled], clientNodes: [client] }).path, client, "a bundled Node too old is passed over as any is");
});

test("updates: the installed app on Windows, unless turned off; the resolver lets through the update hosts by their exact names only", () => {
  assert.equal(updatesEnabled({ packaged: true, platform: "win32", env: {} }), true);
  assert.equal(updatesEnabled({ packaged: true, platform: "win32", env: { AI_DEV_DESKTOP_UPDATES: "0" } }), false);
  assert.equal(updatesEnabled({ packaged: false, platform: "win32", env: {} }), false, "a checkout updates with git");
  assert.equal(updatesEnabled({ packaged: true, platform: "linux", env: {} }), false);
  assert.equal(resolverRules({ updates: false }), "MAP * ~NOTFOUND", "as before phase 12 (Д-260)");
  const rules = resolverRules({ updates: true });
  assert.equal(rules, "MAP * ~NOTFOUND, EXCLUDE github.com, EXCLUDE objects.githubusercontent.com, EXCLUDE release-assets.githubusercontent.com");
  assert.doesNotMatch(rules, /\*\./, "no wildcard: a page could put a word of its own into a name it matched");
  assert.deepEqual(UPDATE_HOSTS, ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"]);
});

test("the updater's session lets through HTTPS to the update hosts, and nothing else", () => {
  for (const url of [
    "https://github.com/stonebridgeway/ai-dev-system/releases.atom",
    "https://github.com/stonebridgeway/ai-dev-system/releases/download/v3.0.0/latest.yml",
    "https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sp=r",
    "https://objects.githubusercontent.com/github-production-release-asset-2e65be/1/2"
  ]) assert.equal(updaterRequestAllowed(url), true, url);
  for (const url of [
    "http://github.com/stonebridgeway/ai-dev-system/releases.atom",
    "https://api.github.com/repos/stonebridgeway/ai-dev-system/releases",
    "https://secret.githubusercontent.com/x",
    "https://github.com.evil.example/x",
    "https://github.com:8443/x",
    "https://user:pass@github.com/x",
    "app://ai-dev/index.html",
    "not a url"
  ]) assert.equal(updaterRequestAllowed(url), false, url);
});

test("a downloaded update is offered in the tray, and installed at Quit if not sooner; a failed check is logged, not thrown", async () => {
  const updater = Object.assign(new EventEmitter(), { checks: 0, async checkForUpdates() { this.checks += 1; if (this.checks === 2) throw new Error("offline"); } });
  const offered = [];
  const lines = [];
  const handle = startUpdates({ updater, tray: { setUpdate: (update) => offered.push(update) }, log: (line) => lines.push(line), timing: { firstCheckMs: 5, everyMs: 20 } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  handle.stop();
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.allowPrerelease, false);
  assert.ok(updater.checks >= 2, `checked ${updater.checks} time(s)`);
  assert.ok(lines.some((line) => line === "update: offline"), lines.join("; "));
  updater.emit("update-downloaded", { version: "3.0.1" });
  assert.deepEqual(offered, [{ version: "3.0.1" }]);

  const t = (key, params) => translate("ru", key, params);
  const noop = () => undefined;
  const ids = (update, actions = { open: noop, rebuild: noop, stop: noop, quit: noop, update: noop }) => trayMenuTemplate({ t, online: true, rebuilding: null, update }, actions).filter((item) => item.id).map((item) => [item.id, item.label]);
  assert.deepEqual(ids({ version: "3.0.1" }).slice(-2), [["update", "Перезапустить и обновить до 3.0.1"], ["quit", "Выход"]]);
  assert.equal(ids(null).some(([id]) => id === "update"), false, "nothing to offer before a download");
});

test("the NSIS uninstaller asks two questions, runs ai-dev uninstall with the answers, and does nothing of it on an update", () => {
  const script = fs.readFileSync(path.join(desktopRoot, "build", "installer.nsh"), "utf8");
  assert.match(script, /!macro customUnInstall\n {2}\$\{ifNot\} \$\{isUpdated\}/, "an update runs the old uninstaller: it must not take the runtime or the clients");
  assert.match(script, /MessageBox MB_YESNO\|MB_ICONQUESTION "\$\(aiDevRemoveClients\)" \/SD IDYES/, "clients: Yes by default, and silently");
  assert.match(script, /MessageBox MB_YESNO\|MB_ICONQUESTION\|MB_DEFBUTTON2 "\$\(aiDevRemoveData\)" \/SD IDNO/, "data: No by default, and silently");
  assert.match(script, /"\$INSTDIR\\resources\\runtime\\node\\node\.exe" "\$INSTDIR\\resources\\runtime\\ai-dev-mcp-server\\bin\\ai-dev\.mjs" uninstall --yes \$R5 \$R6/);
  for (const name of ["aiDevRemoveClients", "aiDevRemoveData"]) {
    for (const language of ["1033", "1049"]) assert.match(script, new RegExp(`LangString ${name} ${language} "`), `${name} in ${language}`);
  }
});
