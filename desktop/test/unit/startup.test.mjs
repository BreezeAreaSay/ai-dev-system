import assert from "node:assert/strict";
import test from "node:test";
import { startupFailure } from "../../src/main/startup.mjs";
import { translate } from "../../src/renderer/i18n.js";

const t = (key, params) => translate("en", key, params);
const serverRoot = "/home/me/ai-dev-system/ai-dev-mcp-server";

test("what stops the start is said with what to do, and whether Try again can work (Д-242)", () => {
  const noPackages = startupFailure(Object.assign(new Error("Cannot find package '@modelcontextprotocol/sdk' imported from /x/src/core/control-client.mjs"), { code: "ERR_MODULE_NOT_FOUND" }), { serverRoot, loaded: false, t });
  assert.equal(noPackages.error, `The AI Dev server in ${serverRoot} has no packages installed.`);
  assert.match(noPackages.hint, /Run npm ci in .*ai-dev-mcp-server, then restart AI Dev/);
  assert.equal(noPackages.restart, true, "a module that failed to load stays failed in this process");
  const noServer = startupFailure(Object.assign(new Error(`Cannot find module '${serverRoot}/src/core/control-client.mjs'`), { code: "ERR_MODULE_NOT_FOUND" }), { serverRoot, loaded: false, t });
  assert.match(noServer.error, /is not in/);
  assert.match(noServer.hint, /AI_DEV_SERVER_ROOT/);
  const settings = startupFailure(new Error("/home/me/.ai-dev/config.json is not JSON (Unexpected token t). Fix or remove it."), { serverRoot, loaded: true, t });
  assert.deepEqual([settings.restart, /config\.json is not JSON/.test(settings.error)], [false, true]);
  assert.match(settings.hint, /press Try again/);
  assert.equal(startupFailure(new Error("odd"), { serverRoot, loaded: true, t }).restart, false);
  assert.equal(startupFailure(new SyntaxError("Unexpected token"), { serverRoot, loaded: false, t }).restart, true);
});
