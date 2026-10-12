import assert from "node:assert/strict";
import test from "node:test";
import { confirmationDialog, consoleDecision, consoleTools } from "../../src/main/console-policy.mjs";
import { translate } from "../../src/renderer/i18n.js";

// What the daemon lists, as tools/list answers it (annotations from server.mjs).
const LISTED = [
  { name: "record_decision", description: "Record an ADR.", inputSchema: { type: "object", properties: { title: { type: "string" } } }, annotations: { title: "Record Decision", readOnlyHint: false, destructiveHint: false } },
  { name: "list_projects", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "model_remove", inputSchema: { type: "object", properties: { confirm: { type: "boolean" } } }, annotations: { readOnlyHint: false, destructiveHint: true } },
  { name: "odd_tool" },
  null,
  { title: "no name" }
];

test("the console's tools: the daemon's list, sorted, each read-only only on the daemon's word", () => {
  const tools = consoleTools(LISTED);
  assert.deepEqual(tools.map((tool) => [tool.name, tool.readOnly, tool.destructive]), [
    ["list_projects", true, false],
    ["model_remove", false, true],
    ["odd_tool", false, false],
    ["record_decision", false, false]
  ]);
  assert.equal(tools[3].title, "Record Decision");
  assert.deepEqual(tools[2].inputSchema, { type: "object", properties: {} }, "a tool without a schema gets an empty form");
  assert.deepEqual(consoleTools(undefined), []);
});

test("a read-only tool runs at once, one that changes something asks first, one not listed is refused", () => {
  const tools = consoleTools(LISTED);
  const read = consoleDecision({ tool: "list_projects", args: {}, id: "console-1" }, tools);
  assert.equal(read.confirm, false);
  assert.equal(read.tool.name, "list_projects");
  const write = consoleDecision({ tool: "record_decision", args: { title: "x" }, id: "console-2" }, tools);
  assert.equal(write.confirm, true);
  assert.deepEqual(write.args, { title: "x" });
  // The page says nothing that makes a writing tool read-only.
  assert.equal(consoleDecision({ tool: "record_decision", args: {}, id: "c", readOnly: true, confirm: false }, tools).confirm, true);
  assert.equal(consoleDecision({ tool: "model_remove", args: { confirm: true }, id: "c" }, tools).confirm, true);
  assert.match(consoleDecision({ tool: "run_shell", args: {}, id: "c" }, tools).refused, /lists no tool "run_shell"/);
  assert.match(consoleDecision({ tool: "list_projects", args: {}, id: "../x" }, tools).refused, /id is 1 to 64/);
  assert.match(consoleDecision({ tool: "list_projects", args: "x", id: "c" }, tools).refused, /arguments are an object/);
  assert.match(consoleDecision({ tool: "list_projects", args: { big: "x".repeat(70 * 1024) }, id: "c" }, tools).refused, /at most 65536 bytes/);
  assert.match(consoleDecision(null, tools).refused, /A call is an object/);
  const many = Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`a${index}`, 1]));
  assert.match(consoleDecision({ tool: "record_decision", args: many, id: "c" }, tools).refused, /at most 40 arguments/, "more than a confirmation can show is refused");
  assert.match(consoleDecision({ args: {}, id: "c" }, tools).refused, /names a tool/);
});

test("the confirmation says what runs and with what, Cancel is the default, in the person's language", () => {
  const [, remove, , record] = consoleTools(LISTED);
  const en = (key, params) => translate("en", key, params);
  const dialog = confirmationDialog(record, { title: "Use Stripe" }, en);
  assert.equal(dialog.type, "question");
  assert.equal(dialog.defaultId, 1);
  assert.equal(dialog.cancelId, 1);
  assert.equal(dialog.buttons[dialog.cancelId], "Cancel");
  assert.match(dialog.message, /record_decision/);
  assert.match(dialog.detail, /^title: "Use Stripe"$/m);
  const ru = confirmationDialog(remove, { confirm: true }, (key, params) => translate("ru", key, params));
  assert.equal(ru.type, "warning", "a destructive tool warns");
  assert.equal(ru.buttons[1], "Отмена");
  assert.match(ru.message, /model_remove/);
  // A long argument cannot push another out of sight: each has its own line, cut on its own.
  const long = confirmationDialog(record, { text: "x".repeat(5000), project_path: "/home/me/secret-repo" }, en);
  assert.ok(long.detail.length < 800, `${long.detail.length} characters`);
  assert.match(long.detail, /^text: "x{239}… \(5002 characters in all\)$/m);
  assert.match(long.detail, /^project_path: "\/home\/me\/secret-repo"$/m);
  assert.match(confirmationDialog(record, {}, en).detail, /\(no arguments\)/);
});
