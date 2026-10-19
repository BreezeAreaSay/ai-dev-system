import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { forbiddenCalls } from "./forbidden-calls.mjs";

// What the static gate reads as declaring a name, binding one or holding a pattern: a parameter list, a declaration, a
// class's field. Its own file since forbidden-calls.test.mjs reached the 800 lines a module keeps (docs/DEFECTS.md,
// Д-466, Д-472 … Д-476).

const rules = (source, options) => forbiddenCalls(source, options).map((finding) => finding.rule);
const BT = "`";
const CP = 'import * as cp from "node:child_process";\n';

test("a call's arguments bind no name and hold no pattern, a block after them or not; a function's, a catch's, an arrow's and a method's parameters do (Д-466, Д-472)", () => {
  // Read as parameters, these hid an exported let named in them, or a spread of the module into the call.
  const refused = {
    "f(run)⏎{⏎}": `${CP}export let run;\nf(run)\n{\n}\nrun = cp;\nfunction f() {}`,
    "f(run) /*⏎*/ {": `${CP}export let run;\nf(run) /*\n*/ {\n}\nrun = cp;\nfunction f() {}`,
    "f(run)⏎{⏎} in a method's body": `${CP}export let run;\nexport class A {\n  m() {\n    f(run)\n    {\n    }\n  }\n}\nrun = cp;\nfunction f() {}`,
    "g(...cp)⏎{⏎}": `${CP}g(...cp)\n{\n}\nfunction g() {}`,
    "extends ns.g(run) {}": `${CP}export let run;\nconst ns = { g: () => Object };\nclass A extends ns.g(run) {}\nrun = cp;`,
    "extends ns.g(...cp) {}": `${CP}const ns = { g: () => Object };\nexport class A extends ns.g(...cp) {}`,
    "extends g(g(run)) {}": `${CP}export let run;\nconst g = () => Object;\nclass A extends g(g(run)) {}\nrun = cp;`,
    "extends g(run).h() {}": `${CP}export let run;\nconst g = () => ({ h: () => Object });\nclass A extends g(run).h() {}\nrun = cp;`,
    "a class expression's heritage in an object": `${CP}export let run;\nconst ns = { g: () => Object };\nexport const o = {\n  A: class extends ns.g(run) {},\n};\nrun = cp;`,
    "for await (run of …) {}": `${CP}export let run;\nfor await (run of []) {}\nrun = cp;`,
    "for (run of …) {}": `${CP}export let run;\nfor (run of []) {}\nrun = cp;`,
    "while (run) {}": `${CP}export let run;\nwhile (run) {}\nrun = cp;`,
    "do {} while (run) {}": `${CP}export let run;\ndo {} while (run) {}\nrun = cp;`,
    "`${f(run)}${{}}`": `${CP}export let run;\nconst t = ${BT}\${f(run)}\${{}}${BT};\nrun = cp;\nfunction f() {}`,
    "p.catch(run)⏎{⏎}": `${CP}export let run;\nPromise.resolve().catch(run)\n{\n}\nrun = cp;`,
    "catch { run = cp }": `${CP}export let run;\ntry {\n  f();\n} catch {\n  run = cp;\n}\nfunction f() {}`,
    "x.function⏎g(run)⏎{⏎}": `${CP}export let run;\nconst x = {};\nx.function\ng(run)\n{\n}\nrun = cp;\nfunction g() {}`
  };
  for (const [name, source] of Object.entries(refused)) assert.deepEqual(rules(source), ["child_process.exec"], `${name}: ${source}`);
  // Each binds the name: the exported let is not what is assigned.
  const honest = {
    "function f(run)⏎{": `${CP}export let run;\nexport function f(run)\n{\n  run = cp;\n}`,
    "function (run)⏎{": `${CP}export let run;\nexport const f = function (run)\n{\n  run = cp;\n};`,
    "function* g(run)⏎{": `${CP}export let run;\nexport function* g(run)\n{\n  run = cp;\n}`,
    "function* (run)⏎{": `${CP}export let run;\nexport const g = function* (run)\n{\n  run = cp;\n};`,
    "catch (run)⏎{": `${CP}export let run;\ntry {\n  f();\n} catch (run)\n{\n  run = cp;\n}\nfunction f() {}`,
    "async function f(run) {": `${CP}export let run;\nexport async function f(run) {\n  run = cp;\n}`,
    "async (run) => {": `${CP}export let run;\nexport const f = async (run) => {\n  run = cp;\n};`,
    "a class's method": `${CP}export let run;\nexport class A {\n  m(run) {\n    run = cp;\n  }\n}`,
    "a constructor": `${CP}export let run;\nexport class A {\n  constructor(run) {\n    run = cp;\n  }\n}`,
    "static async *m(run) {": `${CP}export let run;\nexport class A {\n  static async *m(run) {\n    run = cp;\n  }\n}`,
    "#m(run) {": `${CP}export let run;\nexport class A {\n  #m(run) {\n    run = cp;\n  }\n}`,
    "[k](run) {": `${CP}export let run;\nconst k = "m";\nexport class A {\n  [k](run) {\n    run = cp;\n  }\n}`,
    '"if"(run) {': `${CP}export let run;\nexport class A {\n  "if"(run) {\n    run = cp;\n  }\n}`,
    "set v(run) {": `${CP}export let run;\nexport class A {\n  set v(run) {\n    run = cp;\n  }\n}`,
    "an object's method after a property": `${CP}export let run;\nexport const o = {\n  a: 1,\n  m(run) {\n    run = cp;\n  },\n};`,
    "an object's method named catch": `${CP}export let run;\nexport const o = {\n  catch(run) {\n    run = cp;\n  },\n};`,
    "an object's async method named function": `${CP}export let run;\nexport const o = {\n  async function(run) {\n    run = cp;\n  },\n};`,
    "a class expression's method": `${CP}export let run;\nexport const C = class {\n  m(run) {\n    run = cp;\n  }\n};`
  };
  for (const [name, source] of Object.entries(honest)) assert.deepEqual(rules(source), [], `${name}: ${source}`);
  // An object in a call's arguments is an object, not a parameter's pattern: its shell option is refused (Д-472).
  assert.deepEqual(rules("const o = f({ shell: true })\n{\n}\nfunction f(x) { return x; }"), ["shell"]);
  assert.deepEqual(rules("const ns = { make: (o) => Object };\nexport class A extends ns.make({ shell: true }) {}"), ["shell"]);
  for (const source of ["export function f({ shell = false } = {}) {\n  return shell;\n}", "export function f({ shell })\n{\n  return shell;\n}",
    "export const f = ({ shell }) => shell;", "export class A {\n  m({ shell }) {\n    return shell;\n  }\n}"]) {
    assert.deepEqual(rules(source), [], source);
  }
});

test("a word that is no declaration declares nothing, a member's `class` or `function` names nothing, and a template's commas are its own (Д-473, Д-476)", () => {
  // Each assigns the module to the exported let where nothing declares its name again: caught.
  const refused = {
    "a key named const before it": `${CP}export let run;\nconst schema = { const: "x", run: 1 };\nrun = cp;`,
    "a key named var": `${CP}export let run;\nconst o = { var: 1, run: 2 };\nrun = cp;`,
    "a key named let, export var": `${CP}export var run;\nconst o = { let: 1, run: 2 };\nrun = cp;`,
    "a JSON Schema's const": `${CP}export let description = null;\nexport const schema = { type: "string", const: "fixed", description: "a field" };\ndescription = cp;`,
    "o.class⏎run = cp": `${CP}export let run;\nconst o = {};\no.class\nrun = cp;`,
    "o.function⏎run = cp": `${CP}export let run;\nconst o = {};\no.function\nrun = cp;`,
    "a comma in a parameter default's substitution": `${CP}export let run;\nconst x = 1;\nexport const f = (a = ${BT}\${x, run}${BT}) => a;\nrun = cp;`,
    "a comma in a declarator's substitution": `${CP}export let run;\nconst b = 1;\nlet a = ${BT}\${b, run}${BT};\nrun = cp;`,
    "a field's initializer over a line": `${CP}export let run;\nexport class A {\n  x =\n    run = cp;\n}`,
    "a method named class": `${CP}export let run;\nexport const o = {\n  class() {\n    run = cp;\n  },\n};`,
    "a field named class, then a method": `${CP}export let run;\nexport class A {\n  class;\n  m() {\n    run = cp;\n  }\n}`,
    "a field named class over a line, then a method": `${CP}export let run;\nexport class A {\n  class\n  m() {\n    run = cp;\n  }\n}`,
    "a field named class, then a static block": `${CP}export let run;\nexport class A {\n  class;\n  static {\n    run = cp;\n  }\n}`,
    // A value that ends in a name the line rule takes for a keyword: `export` stops the walk, and the next declaration is read.
    "export let a = of⏎export let run": `${CP}let of = 1;\nexport let a = of\nexport let run;\nrun = cp;`
  };
  for (const [name, source] of Object.entries(refused)) assert.deepEqual(rules(source), ["child_process.exec"], `${name}: ${source}`);
  // Each declares the name, or is a member: the exported let, or the alias, is not what is assigned.
  const honest = {
    "function* run": `${CP}export let run = null;\nexport function f() {\n  function* run() {}\n  run = cp;\n  return run;\n}`,
    "a field named like an exported let": `${CP}export let childProcess = null;\nexport class A {\n  childProcess = cp;\n}`,
    "a field named like a local": `${CP}export class A {\n  proc = cp;\n}\nconst proc = { exec() {} };\nproc.exec("x");`,
    "a static field": `${CP}export class A {\n  static proc = cp;\n}\nconst proc = { exec() {} };\nproc.exec("x");`,
    "a field after a method": `${CP}export let run;\nexport class A {\n  m() {}\n  run = cp;\n}`,
    "a field after a field on its own line": `${CP}export let run;\nexport class A {\n  x = 1\n  run = cp\n}`,
    "a field after ; on its line": `${CP}export let run;\nexport class A { x = 1; run = cp; }`,
    "static on a line of its own": `${CP}export let run;\nexport class A {\n  static\n  run = cp;\n}`,
    "a field of a class with a heritage call": `${CP}export let run;\nconst f = () => Object;\nexport class A extends f(1) {\n  run = cp;\n}`,
    "a field named let, then one named like the exported let": `${CP}export let run;\nexport class A {\n  let\n  run = cp\n}`,
    "let over a line declares": `${CP}export let run;\nexport function f() {\n  let\n  run = cp;\n  return run;\n}`,
    "const in a block": `${CP}export let run;\n{\n  const run = cp;\n  run.spawn("x");\n}`
  };
  for (const [name, source] of Object.entries(honest)) assert.deepEqual(rules(source), [], `${name}: ${source}`);
  // A word `class` that is a field's name or an export's waits for no body: the `{` after it is a literal, or a block.
  assert.deepEqual(rules("export class A {\n  class = { shell: true };\n}"), ["shell"]);
  assert.deepEqual(rules(`${CP}export let run;\nexport * as class from "node:fs"\n{\n  run = cp;\n}`), ["child_process.exec"]);
});

test("the declaration pass stays linear on words that declare nothing (Д-474)", () => {
  const timed = (source, options) => {
    const started = performance.now();
    forbiddenCalls(source, options);
    return performance.now() - started;
  };
  // Before, at n = 8 000, each took 7 to 23 s: every key, method or name walked on to its bracket's end.
  const n = 16000;
  assert.ok(timed(`export const o = { ${"const: 1, ".repeat(n)}z: 1 };\n`) < 4000, "keys named const");
  assert.ok(timed(`export class A { ${"let() {} ".repeat(n)}}\n`) < 4000, "methods named let");
  assert.ok(timed(`var a = [${"let, ".repeat(n)}1];\n`, { script: true }) < 4000, "a script's let in an array");
  assert.ok(timed(`var a = ${"let[0] + ".repeat(n)}1;\n`, { script: true }) < 4000, "a script's let indexed");
});

test("a line that begins with an operator carries the value on: a name bound to it is not the module's (Д-475)", () => {
  for (const line of ["/ 2", "(0)", '["spawn"]', ".spawn", "* 2", "< 2"]) {
    const source = `${CP}const c2 = cp\n${line}\nc2.exec("ls");`;
    assert.deepEqual(rules(source), [], source);
  }
  assert.deepEqual(rules("const g = globalThis\n/ 2\ng[0];"), []);
});
