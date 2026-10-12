import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { NO_SANDBOX, clientEnvironment, desktopRoot, launch, mainCall, serverModule, shot, stage, trayNow } from "./harness.mjs";

const require = createRequire(import.meta.url);

test("without a daemon: a clear screen with a Start button, which brings it up", { timeout: 180_000 }, async (t) => {
  // Autostart off: the app reaches only a daemon that already runs.
  const s = await stage(t, { settings: { daemon_autostart: false } });
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="offline"]', { timeout: 60_000 });
  assert.equal(await page.textContent("h1"), "The AI Dev daemon is not running");
  assert.equal(await page.isVisible("#start-daemon"), true);
  assert.equal(await page.isVisible("nav"), false, "nothing to navigate to without the daemon");
  const tray = await trayNow(app);
  assert.equal(tray.state, "offline");
  assert.deepEqual(tray.menu.filter((item) => !item.enabled).map((item) => item.id), ["rebuild", "stop"]);
  await shot(page, "offline");
  await page.click("#start-daemon");
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  assert.equal((await trayNow(app)).state, "failed", "online, and nothing built yet");
});

test("the tray's Stop brings the window back to the Start screen", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  // A daemon that cannot answer will not stop: the tray says so, from the daemon's answer, and the
  // app stays on it with its one session (Д-271 п. 6, Д-273).
  const pid = await app.evaluate(() => globalThis.aiDevTest.link.status.served_by.pid);
  process.kill(pid, "SIGSTOP");
  t.after(() => {
    try { process.kill(pid, "SIGCONT"); } catch { /* gone */ }
  });
  try {
    await app.evaluate(() => globalThis.aiDevTest.stop());
  } finally {
    process.kill(pid, "SIGCONT");
  }
  assert.equal((await trayNow(app)).menu.find((item) => item.id === "stop").label, "Stop failed — try again");
  assert.match(await app.evaluate(() => globalThis.aiDevTest.tray.tooltip()), /The daemon did not stop: No handshake/);
  assert.equal(await app.evaluate(() => globalThis.aiDevTest.link.state.phase), "online");
  assert.equal(await page.getAttribute("[data-screen]", "data-screen"), "wizard");
  const kept = await mainCall(app, "system_status", { checks: false });
  assert.deepEqual([kept.result.served_by.pid, kept.result.served_by.sessions], [pid, 1], "the same session, not a second one");
  // An error on the way — none is expected, but one would not go unsaid either.
  await app.evaluate(async () => {
    const { link, stop } = globalThis.aiDevTest;
    link.stopDaemon = async () => { throw new Error("EACCES: permission denied, scandir"); };
    try {
      await stop();
    } finally {
      delete link.stopDaemon;
    }
  });
  assert.match(await app.evaluate(() => globalThis.aiDevTest.tray.tooltip()), /The daemon did not stop: EACCES/);
  // Then it stops.
  await app.evaluate(() => globalThis.aiDevTest.stop());
  await page.waitForSelector('[data-screen="offline"]', { timeout: 30_000 });
  const tray = await trayNow(app);
  assert.equal(tray.state, "offline");
  assert.equal(tray.menu.find((item) => item.id === "stop").label, "Stop the daemon");
});

test("without Node.js the app says what it needs, and Try again finds one installed since (Д-251)", { timeout: 120_000 }, async (t) => {
  const s = await stage(t);
  const later = path.join(s.root, "installed-later", "node");
  const { page } = await launch(t, { ...s.env, AI_DEV_NODE: later });
  await page.waitForSelector('[data-screen="no-node"]', { timeout: 60_000 });
  assert.equal(await page.textContent("h1"), "Node.js is not found");
  assert.match(await page.textContent('[data-screen="no-node"]'), /AI_DEV_NODE names .*installed-later.*node, which is not an executable file/);
  await shot(page, "no-node");
  // The language chosen here says the problem again, in it (Д-264, Д-270).
  await page.selectOption("#language", "ru");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Node.js не найден");
  assert.match(await page.textContent('[data-screen="no-node"]'), /AI_DEV_NODE указывает на .*installed-later.*node, а это не исполняемый файл/);
  await page.selectOption("#language", "en");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "Node.js is not found");
  await page.click("#retry");
  await page.waitForSelector('[data-screen="no-node"]');
  // Node arrives where AI_DEV_NODE says; Try again finds it.
  await fs.mkdir(path.dirname(later), { recursive: true });
  await fs.symlink(process.execPath, later);
  await page.click("#retry");
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
});

test("a daemon that dies is said with its log, and one a client starts later brings the app back (Д-243, Д-254)", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  const pid = await app.evaluate(() => globalThis.aiDevTest.link.status.served_by.pid);
  process.kill(pid, "SIGKILL");
  await page.waitForSelector('[data-screen="offline"] [data-field="offline-error"]', { timeout: 30_000 });
  assert.match(await page.textContent('[data-field="offline-error"]'), /stopped unexpectedly/);
  await page.waitForSelector('[data-screen="offline"] details.log');
  assert.equal((await trayNow(app)).state, "offline");
  await shot(page, "offline-lost");
  // An AI client starts the daemon again, as clients do: the app comes back by itself.
  const { openControlClient } = await serverModule("src/core/control-client.mjs");
  const { client } = await openControlClient({ serverRoot: path.resolve(desktopRoot, "..", "ai-dev-mcp-server"), env: clientEnvironment(s.env), execPath: process.execPath, name: "a-client" });
  t.after(() => client.close().catch(() => undefined));
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 30_000 });
  assert.notEqual(await app.evaluate(() => globalThis.aiDevTest.link.status.served_by.pid), pid);
});

test("a second launch hands over to the first, which shows its window (Д-254)", { timeout: 120_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  const second = spawn(require("electron"), [...(NO_SANDBOX ? ["--no-sandbox"] : []), desktopRoot], { env: s.env, stdio: "ignore", shell: false });
  // A second instance that does not hand over must not outlive the test, or the run waits on it.
  t.after(() => {
    if (second.exitCode === null && second.signalCode === null) second.kill("SIGKILL");
  });
  const code = await Promise.race([
    new Promise((resolve) => second.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 30_000, "still running after 30 s").unref())
  ]);
  assert.equal(code, 0, "the second launch hands over and exits");
  await page.waitForFunction(() => document.visibilityState === "visible", null, { timeout: 10_000 });
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.isVisible())), [true]);
});
