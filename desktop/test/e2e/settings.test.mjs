import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { answerFolderDialog, launch, mainCall, shot, stage } from "./harness.mjs";

const open = async (page, route) => {
  await page.click(`[data-nav="${route}"]`);
  await page.waitForSelector(`[data-screen="${route}"]`);
};

const stored = async (s) => JSON.parse(await fs.readFile(path.join(s.home, ".ai-dev", "config.json"), "utf8"));

test("Settings: a change is saved and says when it applies; one for new sessions reaches the app when it reconnects", { timeout: 300_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  await open(page, "settings");
  await page.waitForSelector('[data-form="settings"]');

  // A wrong value: nothing is written, the daemon's reason is shown.
  await page.fill("#setting-daemon_idle_minutes", "99999");
  await page.click('[data-action="save"]');
  await page.waitForSelector('[data-field="save-error"]');
  assert.match(await page.textContent('[data-field="save-error"]'), /10080/);
  await assert.rejects(stored(s), "no file was written");

  // The mirror applies at once; the model folder to new sessions.
  const models = path.join(s.root, "models-elsewhere");
  await page.fill("#setting-daemon_idle_minutes", "");
  await page.fill("#setting-model_mirror", "https://hf-mirror.example");
  await answerFolderDialog(app, models);
  await page.click('[data-action="choose-model_dir"]');
  await page.waitForFunction((folder) => document.querySelector("#setting-model_dir").value === folder, models);
  await page.click('[data-action="save"]');
  await page.waitForSelector('[data-field="saved"]');
  const saved = await page.textContent('[data-field="saved"]');
  assert.match(saved, /Model download mirror: applies at once/);
  assert.match(saved, /Model folder: applies to AI client sessions started afterwards/);
  assert.deepEqual(await stored(s), { schema_version: 1, model_mirror: "https://hf-mirror.example", model_dir: models });
  await page.waitForSelector('[data-pending="model_dir"]');
  await page.waitForSelector('[data-field="reconnect"]');
  await shot(page, "p11-settings-pending");
  // This session still has the old folder: installing a model is refused until it reconnects.
  const refused = await mainCall(app, "model_install", {});
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Reconnect — a session started now uses the new folder/);

  // Reconnect: a new session, the same screen, nothing pending.
  await page.click('[data-action="reconnect"]');
  await page.waitForSelector('[data-screen="settings"] [data-form="settings"]', { timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector("[data-pending]") && !document.querySelector('[data-field="reconnect"]'), null, { timeout: 30_000 });
  const status = await mainCall(app, "system_status", { checks: false });
  assert.equal(status.result.model.dir, models, "the new session uses the new folder");
  assert.match(await page.textContent('[data-setting="model_dir"]'), /from the settings file/);
});

test("a screen whose daemon stops says so and offers Start; Follow on the Log stops with it", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  await open(page, "log");
  await page.waitForSelector(".log-lines");
  await page.check("#log-follow");
  await app.evaluate(() => globalThis.aiDevTest.link.stopDaemon());
  await page.waitForSelector('[data-screen="offline"]', { timeout: 30_000 });
  // Two Follow periods later the page is still the Start screen, with no error from a poll.
  await new Promise((resolve) => setTimeout(resolve, 4500));
  assert.equal(await page.isVisible('[data-screen="offline"] #start-daemon'), true);
  assert.equal(await page.$('[data-state="error"]'), null);
  await page.click("#start-daemon");
  await page.waitForSelector('[data-screen="wizard"], [data-screen="status"]', { timeout: 60_000 });
});
