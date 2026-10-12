import assert from "node:assert/strict";
import test from "node:test";
import { launch, stage } from "./harness.mjs";

test("the page has no Node, no file system, no network, and reaches only the interface's tools", { timeout: 180_000 }, async (t) => {
  const s = await stage(t);
  const { app, page } = await launch(t, s.env);
  await page.waitForSelector('[data-screen="wizard"]', { timeout: 60_000 });
  const seen = await page.evaluate(async () => {
    const tried = async (attempt) => {
      try {
        await attempt();
        return "allowed";
      } catch (error) {
        return `refused: ${error?.name ?? "Error"}`;
      }
    };
    // Playwright evaluates through the DevTools protocol, which lets the
    // evaluation itself use eval whatever the page's policy says; a task of
    // the page's own — a timer — runs as the page's scripts do.
    const inTask = (attempt) => new Promise((resolve) => setTimeout(() => {
      try {
        attempt();
        resolve("allowed");
      } catch (error) {
        resolve(`refused: ${error?.name ?? "Error"}`);
      }
    }, 0));
    const inline = await new Promise((resolve) => {
      window.inlineRan = false;
      const script = document.createElement("script");
      script.textContent = "window.inlineRan = true;";
      document.head.append(script);
      setTimeout(() => resolve(window.inlineRan ? "ran" : "blocked"), 200);
    });
    return {
      globals: { require: typeof require, process: typeof process, module: typeof module, Buffer: typeof Buffer, global: typeof global, ipcRenderer: typeof window.ipcRenderer, electron: typeof window.electron },
      api: Object.keys(window.aiDev).sort(),
      apiFrozen: Object.isFrozen(window.aiDev),
      file: await tried(() => fetch("file:///etc/passwd").then((response) => response.text())),
      network: await tried(() => fetch("https://example.com/").then((response) => response.text())),
      inline,
      evalCall: await inTask(() => eval("1 + 1")),
      newFunction: await inTask(() => new Function("return 1")()),
      // A worker the policy refuses is made, then fails; one that ran would say so.
      worker: await new Promise((resolve) => setTimeout(() => {
        let settled = false;
        const done = (value) => {
          if (!settled) resolve((settled = true) && value);
        };
        try {
          const worker = new Worker("data:text/javascript,postMessage('ran')");
          worker.onmessage = () => done("ran");
          worker.onerror = () => done("refused: error event");
          setTimeout(() => done("refused: never started"), 1500);
        } catch (error) {
          done(`refused: ${error?.name ?? "Error"}`);
        }
      }, 0)),
      opened: window.open("https://example.com/") === null ? "denied" : "opened",
      removeModel: await window.aiDev.call("model_remove", { confirm: true }, "probe-remove"),
      agentTool: await window.aiDev.call("record_decision", { title: "x", decision: "y" }, "probe-agent"),
      badId: await window.aiDev.call("system_status", {}, "../../etc")
    };
  });
  assert.deepEqual(seen.globals, { require: "undefined", process: "undefined", module: "undefined", Buffer: "undefined", global: "undefined", ipcRenderer: "undefined", electron: "undefined" });
  assert.deepEqual(seen.api, ["call", "cancel", "chooseFolder", "connect", "onProgress", "onState", "setLanguage", "state"]);
  assert.equal(seen.apiFrozen, true);
  for (const key of ["file", "network", "evalCall", "newFunction", "worker"]) assert.match(seen[key], /^refused/, `${key}: ${seen[key]}`);
  assert.equal(seen.inline, "blocked", "no inline script runs");
  assert.equal(seen.opened, "denied");
  assert.deepEqual(seen.removeModel, { ok: false, error: 'The interface does not call "model_remove".', cancelled: false });
  assert.match(seen.agentTool.error, /The interface does not call "record_decision"/);
  assert.match(seen.badId.error, /id is 1 to 64/);

  // Navigation away from the app's page does not happen.
  await page.evaluate(() => { window.location.href = "https://example.com/"; });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.match(page.url(), /^app:\/\/ai-dev\//);
  // The window's settings, read in the main process.
  const preferences = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const prefs = contents.getLastWebPreferences();
    return { contextIsolation: prefs.contextIsolation, sandbox: prefs.sandbox, nodeIntegration: prefs.nodeIntegration, webviewTag: prefs.webviewTag };
  });
  assert.deepEqual(preferences, { contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false });
});
