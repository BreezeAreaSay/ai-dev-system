import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { launch, shot, stage, trayNow } from "./harness.mjs";

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
  const stopped = await app.evaluate(() => globalThis.aiDevTest.link.stopDaemon());
  assert.equal(stopped.daemons.length, 1);
  await page.waitForSelector('[data-screen="offline"]', { timeout: 30_000 });
  assert.equal((await trayNow(app)).state, "offline");
});

test("without Node.js the app says what it needs instead of failing", { timeout: 120_000 }, async (t) => {
  const s = await stage(t, { env: { AI_DEV_NODE: path.join("/", "nowhere", "node") } });
  const { page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="no-node"]', { timeout: 60_000 });
  assert.equal(await page.textContent("h1"), "Node.js is not found");
  assert.match(await page.textContent('[data-screen="no-node"]'), /AI_DEV_NODE names .*nowhere.*node, which is not an executable file/);
  await shot(page, "no-node");
});
