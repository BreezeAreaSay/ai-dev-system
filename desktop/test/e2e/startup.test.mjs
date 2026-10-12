import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { NO_SANDBOX, desktopRoot, launch, serverRoot, shot, stage, trayNow } from "./harness.mjs";

const require = createRequire(import.meta.url);

// What the window says when the app cannot get going (Д-242).

test("a broken settings file is said with what to do, and Try again goes on once it is fixed", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const settings = path.join(s.home, ".ai-dev", "config.json");
  await fs.writeFile(settings, "{ this is not json");
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  assert.equal(await page.textContent("h1"), "AI Dev could not start");
  assert.match(await page.textContent('[data-field="broken-error"]'), /config\.json is not JSON\.$/);
  // What to do is said once, in the app's words (Д-269).
  assert.doesNotMatch(await page.textContent('[data-field="broken-error"]'), /Fix or remove it/);
  assert.equal(await page.textContent('[data-field="broken-hint"]'), "Fix the file or remove it — without it the defaults are used — then press Try again.");
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

test("on a Russian system the start-up failure is said in Russian, and again in the language chosen after (Д-264)", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  await fs.writeFile(path.join(s.home, ".ai-dev", "config.json"), "{ this is not json");
  const { page } = await launch(t, { ...s.env, LANG: "ru_RU.UTF-8", LC_ALL: "ru_RU.UTF-8", LANGUAGE: "ru" });
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  assert.equal(await page.textContent("h1"), "AI Dev не смог запуститься");
  assert.match(await page.textContent('[data-field="broken-hint"]'), /^Исправьте файл или удалите его — /, "what to do, in Russian (Д-269)");
  await page.selectOption("#language", "en");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "AI Dev could not start");
  assert.match(await page.textContent('[data-field="broken-hint"]'), /^Fix the file or remove it — /, "the main process's words in the new language too");
});

test("a language chosen on the failure screen holds once Try again gets going, and is written then (Д-271, п. 4)", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const settings = path.join(s.home, ".ai-dev", "config.json");
  await fs.writeFile(settings, "{ this is not json");
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  assert.equal(await page.textContent("h1"), "AI Dev could not start");
  await page.selectOption("#language", "ru");
  await page.waitForFunction(() => document.querySelector("h1")?.textContent === "AI Dev не смог запуститься");
  assert.equal(await fs.readFile(settings, "utf8"), "{ this is not json", "a broken file is not written over");
  await fs.writeFile(settings, JSON.stringify({ schema_version: 1 }));
  await page.click("#retry");
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  assert.equal(await page.textContent('[data-nav="status"]'), "Статус");
  assert.equal((await trayNow(app)).menu[0].label, "Открыть AI Dev");
  assert.equal(JSON.parse(await fs.readFile(settings, "utf8")).language, "ru", "written once the file could be");
});

test("a second launch tries a failed start again: fixed meanwhile, the first window goes on (Д-242, Д-265)", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const settings = path.join(s.home, ".ai-dev", "config.json");
  await fs.writeFile(settings, "{ this is not json");
  const { page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  await fs.writeFile(settings, JSON.stringify({ schema_version: 1 }));
  const second = spawn(require("electron"), [...(NO_SANDBOX ? ["--no-sandbox"] : []), desktopRoot], { env: s.env, stdio: "ignore", shell: false });
  t.after(() => {
    if (second.exitCode === null && second.signalCode === null) second.kill("SIGKILL");
  });
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
});

test("Restart AI Dev asks Electron to start the app again, and to leave this run (Д-242, Д-265)", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const bare = path.join(s.root, "server-without-packages");
  await fs.cp(serverRoot, bare, { recursive: true, filter: (source) => !source.split(path.sep).includes("node_modules") });
  const { app, page } = await launch(t, { ...s.env, AI_DEV_SERVER_ROOT: bare });
  await page.waitForSelector('[data-screen="broken"]', { timeout: 60_000 });
  // What Restart asks of Electron, seen in this process instead of done.
  await app.evaluate(({ app: electronApp }) => {
    globalThis.restartAsked = [];
    electronApp.relaunch = () => globalThis.restartAsked.push("relaunch");
    electronApp.exit = (code) => globalThis.restartAsked.push(`exit ${code}`);
  });
  await page.click("#retry");
  const deadline = Date.now() + 10_000;
  while ((await app.evaluate(() => globalThis.restartAsked.length)) < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await app.evaluate(() => globalThis.restartAsked), ["relaunch", "exit 0"]);
});
