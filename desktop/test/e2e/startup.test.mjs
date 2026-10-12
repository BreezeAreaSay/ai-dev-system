import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { launch, serverRoot, shot, stage } from "./harness.mjs";

// What the window says when the app cannot get going (Д-242).

test("a broken settings file is said with what to do, and Try again goes on once it is fixed", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const settings = path.join(s.home, ".ai-dev", "config.json");
  await fs.writeFile(settings, "{ this is not json");
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  assert.equal(await page.textContent("h1"), "AI Dev could not start");
  assert.match(await page.textContent('[data-field="broken-error"]'), /config\.json/);
  assert.match(await page.textContent('[data-field="broken-hint"]'), /Fix the file or remove it/);
  assert.equal(await page.textContent("#retry"), "Try again");
  assert.equal(await app.evaluate(() => globalThis.aiDevTest.tray.state()), "offline", "the tray is there");
  await shot(page, "broken-settings");
  await fs.writeFile(settings, JSON.stringify({ schema_version: 1 }));
  await page.click("#retry");
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
});

test("a server without its packages is said, with the command that installs them and Restart", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  // A copy of the server as a checkout without `npm ci`: no node_modules.
  const bare = path.join(s.root, "server-without-packages");
  await fs.cp(serverRoot, bare, { recursive: true, filter: (source) => !source.split(path.sep).includes("node_modules") });
  const { page } = await launch(t, { ...s.env, AI_DEV_SERVER_ROOT: bare });
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  assert.match(await page.textContent('[data-field="broken-error"]'), /has no packages installed/);
  assert.match(await page.textContent('[data-field="broken-hint"]'), /Run npm ci in .*server-without-packages, then restart AI Dev/);
  assert.equal(await page.textContent("#retry"), "Restart AI Dev");
  await shot(page, "broken-no-packages");
});
