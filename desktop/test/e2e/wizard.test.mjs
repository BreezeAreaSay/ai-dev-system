import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { STALLED_FILE, answerFolderDialog, launch, mainCall, shot, stage, trayNow } from "./harness.mjs";

// The first-run wizard on a real daemon, as a person goes through it: the
// projects folder, a client, the model — a download cancelled midway, then
// the model imported from a folder — the index, and Status.

test("the wizard runs to the end on a real daemon; a cancelled download leaves a consistent state", { timeout: 300_000 }, async (t) => {
  const s = await stage(t, { stall: true, seed: true });
  // A client to find: Cursor's folder in the home.
  await fs.mkdir(path.join(s.home, ".cursor"), { recursive: true });
  const { app, page } = await launch(t, s.env);

  // A fresh install has no index: the wizard opens by itself.
  await page.waitForSelector('[data-screen="wizard"][data-step="projects"]', { timeout: 60_000 });
  assert.equal((await trayNow(app)).state, "failed", "the tray says it does not work yet");
  await shot(page, "wizard-1-projects");

  // 1. The projects folder, through the system's dialog.
  await answerFolderDialog(app, s.projects);
  await page.click('[data-action="choose-projects"]');
  await page.waitForSelector(`[data-field="projects-root"]:has-text("${path.basename(s.projects)}")`);
  const stored = JSON.parse(await fs.readFile(path.join(s.home, ".ai-dev", "config.json"), "utf8"));
  assert.equal(stored.projects_root, s.projects);
  await page.click('[data-action="next"]');

  // 2. The clients found, chosen, connected.
  await page.waitForSelector('[data-step="clients"] li[data-client="cursor"]');
  assert.equal(await page.isChecked('li[data-client="cursor"] input'), true, "a client found and not connected is chosen");
  assert.equal(await page.isDisabled('li[data-client="claude-desktop"] input'), true, "a client not found cannot be chosen");
  await shot(page, "wizard-2-clients");
  // With nothing chosen, Connect cannot be pressed rather than do nothing (Д-248).
  await page.uncheck('li[data-client="cursor"] input');
  assert.equal(await page.isDisabled('[data-action="connect-clients"]'), true, "nothing chosen: Connect is disabled");
  await page.check('li[data-client="cursor"] input');
  await page.click('[data-action="connect-clients"]');
  await page.waitForSelector('[data-field="clients-result"]:has-text("0 failed")');
  const cursor = JSON.parse(await fs.readFile(path.join(s.home, ".cursor", "mcp.json"), "utf8"));
  assert.ok(cursor.mcpServers?.["ai-dev"], "Cursor's config has the ai-dev entry");
  await page.click('[data-action="next"]');

  // 3. The model: a download that stalls is cancelled midway.
  await page.waitForSelector('[data-action="download-model"]');
  assert.equal(await page.textContent('[data-action="next"]'), "Skip for now");
  await page.click('[data-action="download-model"]');
  await page.waitForSelector('[data-action="cancel"]');
  await page.waitForFunction(() => document.querySelector(".progress-text")?.textContent?.length > 0);
  await shot(page, "wizard-3-model-downloading");
  // While it runs the wizard stays on it; a person who goes to Status and
  // back finds it still running, with its Cancel (Д-249).
  assert.deepEqual([await page.isDisabled('[data-action="next"]'), await page.isDisabled('[data-action="back"]')], [true, true]);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), "cancel", "the focus is on Cancel, not lost (Д-257, п. 4)");
  await page.click('[data-nav="status"]');
  await page.waitForSelector('[data-screen="status"]');
  await page.click('[data-nav="wizard"]');
  await page.waitForSelector('[data-step="model"] [data-action="cancel"]');
  // Let the download reach the stalled file, then cancel.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await page.click('[data-action="cancel"]');
  await page.waitForSelector('.notice:has-text("Cancelled")', { timeout: 30_000 });
  await shot(page, "wizard-4-model-cancelled");
  // Consistent: no model, what was fetched kept for the next download, the daemon still answers.
  const after = await mainCall(app, "system_status", { checks: false });
  assert.equal(after.ok, true, after.error);
  assert.equal(after.result.model.installed, false);
  assert.ok(after.result.model.present.length > 0 || after.result.model.partial.length > 0, "the bytes fetched are kept");
  assert.equal(existsSync(path.join(after.result.model.dir, STALLED_FILE)), false, "no half file under the model's own name");
  const verified = await mainCall(app, "model_verify", {});
  assert.equal(verified.ok, true, verified.error);
  assert.equal(verified.result.ready, false);

  // Then imported from a folder (a USB stick).
  await answerFolderDialog(app, s.usb);
  await page.click('[data-action="import-model"]');
  await page.waitForSelector('[data-field="model-state"]', { timeout: 120_000 });
  assert.equal(await page.textContent('[data-action="next"]'), "Next");
  await shot(page, "wizard-5-model-installed");
  await page.click('[data-action="next"]');

  // 4. The index, with the model's vectors; the wizard waits for it.
  await page.click('[data-action="build-index"]');
  await page.waitForSelector('[data-step="index"] [data-action="cancel"]');
  assert.deepEqual([await page.isDisabled('[data-action="next"]'), await page.isDisabled('[data-action="back"]')], [true, true], "no leaving a build behind (Д-249)");
  await page.waitForSelector('[data-field="index-result"]', { timeout: 240_000 });
  const result = await page.textContent('[data-field="index-result"]');
  assert.match(result, /, 0 failed$/, result);
  assert.equal(await page.getAttribute('[data-step="dense_index"]', "data-status"), "done");
  await shot(page, "wizard-6-index");
  // Left and come back to, the step still shows the build's outcome (Д-249).
  await page.click('[data-nav="status"]');
  await page.waitForSelector('[data-screen="status"]');
  await page.click('[data-nav="wizard"]');
  assert.equal(await page.textContent('[data-step="index"] [data-field="index-result"]'), result);
  // And it builds again from there — the way back from Status's "Run setup again" (Д-261).
  await page.evaluate(() => { document.querySelector('[data-field="index-result"]').dataset.before = "1"; });
  await page.click('[data-action="build-index"]');
  await page.waitForSelector('[data-field="index-result"]:not([data-before])', { timeout: 240_000 });
  assert.match(await page.textContent('[data-field="index-result"]'), /, 0 failed$/);
  await page.click('[data-action="next"]');

  // 5. Done, and on to Status.
  await page.waitForSelector('[data-step="done"]');
  await shot(page, "wizard-7-done");
  await page.click('[data-action="open-status"]');
  await page.waitForSelector('[data-field="overall"]', { timeout: 120_000 });
  const overall = await page.getAttribute('[data-field="overall"]', "data-status");
  const failing = await page.$$eval('li.check[data-status="fail"]', (items) => items.map((item) => `${item.dataset.check}: ${item.querySelector("p")?.textContent}`));
  assert.ok(["ok", "degraded"].includes(overall), `status ${overall}; failing: ${failing.join(" | ")}`);
  assert.match(await page.textContent('[data-field="index"]'), /with vectors/);
  await shot(page, "status-after-setup");
  const tray = await trayNow(app);
  assert.equal(tray.state, overall, "the tray's colour is the status");
  assert.deepEqual(tray.menu.map((item) => [item.id, item.enabled]), [["open", true], ["rebuild", true], ["stop", true], ["quit", true]]);
});

test("Status shows each health check with its details and what to do, in Russian too", { timeout: 300_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  await page.click('[data-nav="status"]');
  await page.waitForSelector('[data-field="overall"]', { timeout: 120_000 });
  assert.equal(await page.getAttribute('[data-field="overall"]', "data-status"), "failed", "nothing is built yet");
  const checks = await page.$$eval("li.check", (items) => items.map((item) => ({
    name: item.dataset.check,
    status: item.dataset.status,
    advice: item.querySelector(".advice")?.textContent ?? "",
    details: Boolean(item.querySelector("details"))
  })));
  assert.ok(checks.length >= 10, `${checks.length} checks`);
  const unhappy = checks.filter((check) => check.status !== "ok");
  assert.ok(unhappy.length > 0 && unhappy.every((check) => check.advice.startsWith("What to do: ")), JSON.stringify(unhappy));
  assert.ok(checks.some((check) => check.details), "a check carries its details");
  await shot(page, "status-before-setup");

  // The tray's rebuild runs the tool and comes back to the menu.
  assert.equal((await trayNow(app)).state, "failed");

  // Russian: the page, the checks' names, the tray, the stored choice (Д-250).
  await page.selectOption("#language", "ru");
  await page.waitForSelector('[data-nav="status"]:has-text("Статус")');
  await page.waitForSelector('h1:has-text("Статус")');
  await page.waitForSelector('[data-field="overall"]', { timeout: 120_000 });
  assert.equal(await page.textContent('li.check[data-check="search_index_file"] strong'), "Поисковый индекс");
  assert.match(await page.textContent('[data-field="why"]'), /^Почему: /);
  assert.equal((await trayNow(app)).menu[0].label, "Открыть AI Dev");
  const stored = JSON.parse(await fs.readFile(path.join(s.home, ".ai-dev", "config.json"), "utf8"));
  assert.equal(stored.language, "ru");
  await shot(page, "status-ru");
});
