import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionTools } from "./tool-extensions.mjs";

function fakeExtension(host) {
  return {
    definitions: [
      { name: "ping_extension", description: "Ping.", inputSchema: { type: "object", properties: {} } }
    ],
    handlers: {
      ping_extension: async (args) => ({ pong: true, host: host.label, args })
    },
    readOnly: ["ping_extension"]
  };
}

test("extension registry composes definitions, handlers, and read-only hints", async () => {
  const registry = createExtensionTools({ label: "test-host" }, [fakeExtension]);
  assert.deepEqual(registry.definitions.map((item) => item.name), ["ping_extension"]);
  assert.deepEqual(registry.readOnly, ["ping_extension"]);
  const result = await registry.handlers.get("ping_extension")({ value: 1 });
  assert.deepEqual(result, { pong: true, host: "test-host", args: { value: 1 } });
});

test("extension registry fails fast on duplicates, missing handlers, and bad schemas", () => {
  assert.throws(
    () => createExtensionTools({}, [fakeExtension, fakeExtension]),
    /Duplicate extension tool: ping_extension/
  );
  assert.throws(
    () => createExtensionTools({}, [() => ({
      definitions: [{ name: "orphan", inputSchema: { type: "object" } }],
      handlers: {}
    })]),
    /has no handler: orphan/
  );
  assert.throws(
    () => createExtensionTools({}, [() => ({
      definitions: [{ name: "bad", inputSchema: { type: "string" } }],
      handlers: { bad: async () => ({}) }
    })]),
    /must be an object schema: bad/
  );
  assert.throws(
    () => createExtensionTools({}, [() => ({
      definitions: [],
      handlers: {},
      readOnly: ["ghost"]
    })]),
    /unknown extension tool: ghost/
  );
});
