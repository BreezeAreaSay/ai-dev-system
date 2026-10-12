import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EVENT_CHANNELS, INVOKE_CHANNELS, PAGE_TOOLS, refuseCall, validCallId } from "../../src/main/ipc-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the page may call only the interface's tools, with a well-formed id and plain arguments", () => {
  assert.equal(refuseCall({ tool: "system_status", args: { checks: false }, id: "call-1" }), null);
  assert.equal(refuseCall({ tool: "rebuild_search_index", id: "tray-rebuild" }), null, "no arguments is an empty object");
  for (const tool of ["model_remove", "clients_remove", "record_decision", "run_command", "", undefined, 42]) {
    assert.match(refuseCall({ tool, args: {}, id: "a" }), /The interface does not call/, String(tool));
  }
  assert.match(refuseCall({ tool: "system_status", args: {}, id: "../x" }), /id is 1 to 64/);
  assert.match(refuseCall({ tool: "system_status", args: {}, id: "a".repeat(65) }), /id is 1 to 64/);
  assert.match(refuseCall({ tool: "system_status", args: [], id: "a" }), /arguments are an object/);
  assert.match(refuseCall({ tool: "system_status", args: { big: "x".repeat(70 * 1024) }, id: "a" }), /at most 65536 bytes/);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.match(refuseCall({ tool: "system_status", args: cyclic, id: "a" }), /plain JSON/);
  assert.match(refuseCall(null), /A call is an object/);
  assert.match(refuseCall(["system_status"]), /A call is an object/);
  assert.equal(validCallId("call-lx2-1"), true);
  assert.equal(validCallId("call 1"), false);
  assert.equal(validCallId({ toString: () => "a" }), false);
});

test("nothing the page may call takes back what it cannot undo", () => {
  assert.deepEqual(PAGE_TOOLS.filter((tool) => /remove|delete/.test(tool)), []);
});

test("the preload exposes exactly the policy's channels", () => {
  const preload = fs.readFileSync(path.join(root, "src", "preload", "preload.cjs"), "utf8");
  const named = (block) => Object.fromEntries([...block.matchAll(/(\w+): "([^"]+)"/g)].map((match) => [match[1], match[2]]));
  const invoke = named(/const invoke = \{([^}]*)\}/.exec(preload)[1]);
  const events = named(/const events = \{([^}]*)\}/.exec(preload)[1]);
  assert.deepEqual(invoke, { ...INVOKE_CHANNELS });
  assert.deepEqual(events, { ...EVENT_CHANNELS });
  // The page gets functions over these channels, never ipcRenderer itself.
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer\s*[,)]/);
  assert.match(preload, /Object\.freeze\(\{/);
});
