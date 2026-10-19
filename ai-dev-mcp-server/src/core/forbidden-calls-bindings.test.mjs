import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { forbiddenCalls } from "./forbidden-calls.mjs";

// What the static gate reads as declaring a name, binding one or holding a pattern: a parameter list, a declaration, a
// class's field. Its own file since forbidden-calls.test.mjs would have passed the 800 lines a module keeps
// (docs/DEFECTS.md, Д-466, Д-472 … Д-476, Д-480 … Д-482, Д-486 … Д-489, Д-499 … Д-511).

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

test("a word that is no declaration declares nothing, a member's `class` or `function` names nothing, and a template's commas are not a declaration's or a list's (Д-473, Д-476)", () => {
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
  // A declaration word right in a substitution walked past the template's end and on through every later one (Д-488).
  assert.ok(timed(`var a = ${`${BT}\${let[0]}${BT} + `.repeat(n)}1;\n`, { script: true }) < 4000, "a script's let in a substitution");
  assert.ok(timed(`var a = ${`${BT}\${0}\${let[0]}${BT} + `.repeat(n)}1;\n`, { script: true }) < 4000, "a script's let in a later substitution");
});

test("a line that begins with an operator carries the value on: a name bound to it is not the module's (Д-475, Д-482)", () => {
  for (const line of ["/ 2", "(0)", '["spawn"]', ".spawn", "* 2", "< 2", "=== undefined", "== null"]) {
    const source = `${CP}const c2 = cp\n${line}\nc2.exec("ls");`;
    assert.deepEqual(rules(source), [], source);
  }
  assert.deepEqual(rules("const g = globalThis\n/ 2\ng[0];"), []);
  assert.deepEqual(rules(`${CP}export const ok = cp\n  === undefined;`), []);
  assert.deepEqual(rules('const k = "x";\nconst g = globalThis\n  === undefined;\ng[k];'), []);
  // A shell option whose value goes on past its line is not `false`.
  assert.deepEqual(rules('spawn("x", [], { shell: false\n  === mode });\nfunction spawn() {}\nconst mode = 1;'), ["shell"]);
});

test("a declaration a line ends declares as any other, and so does the one after it with no `;` between (Д-480)", () => {
  const local = (...lines) => `${CP}export let run = null;\nexport function f(o) {\n${lines.map((line) => `  ${line}\n`).join("")}  return run;\n}`;
  for (const lines of [["const a = 1", "let run = cp"], ["const a = String(1)", "const run = cp"], ["let a = 0", "let run", "run = cp"], ["const a = 1", "const { default: run } = cp"]]) {
    assert.deepEqual(rules(local(...lines)), [], lines.join("⏎"));
  }
  assert.deepEqual(rules(`${CP}export var run = null;\nexport function f(o) {\n  var a = 1\n  var { run } = o\n  run = cp\n  return run\n}`), []);
  // Four in a row: each of them declares the name in turn.
  for (let at = 0; at < 4; at += 1) {
    const lines = ["const a = 1", "const b = 2", "const c = 3", "const d = 4"].map((line, index) => (index === at ? "let run = cp" : line));
    assert.deepEqual(rules(local(...lines)), [], lines.join("⏎"));
  }
});

test("a method's parameters are a list whatever names the method and wherever its body begins; a call stays a call (Д-481)", () => {
  const methods = {
    "#catch({ shell }) {": "export class A {\n  #catch({ shell }) {\n    return shell;\n  }\n}",
    "#function({ shell }) {": "export class A {\n  #function({ shell }) {\n    return shell;\n  }\n}",
    "with({ shell }) {": "export class Builder {\n  with({ shell }) {\n    return shell;\n  }\n}",
    "if, for, while, switch": "export class A {\n  if({ shell }) {}\n  for({ shell }) {}\n  while({ shell }) {}\n  switch({ shell }) {}\n}",
    "an object's with({ shell }) {": "export const b = {\n  with({ shell }) {\n    return shell;\n  }\n};",
    "get with() {, set with(value) {": "export const z = {\n  get with() { return 1; },\n  set with({ shell }) {}\n};",
    "m({ shell })⏎{": "export class A {\n  m({ shell })\n  {\n    return shell;\n  }\n}",
    "m({ shell: useShell = false })⏎{": "export class A {\n  m({ shell: useShell = false })\n  {\n    return useShell;\n  }\n}"
  };
  for (const [name, source] of Object.entries(methods)) assert.deepEqual(rules(source), [], `${name}: ${source}`);
  // Each names the exported let it binds: not the module's.
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  #catch(run) {\n    run = cp;\n  }\n}`), []);
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  m(run)\n  {\n    run = cp;\n  }\n}`), []);
  // A member's `#catch` is a call, and a call in a property's value or a field's initializer holds an option, not a list.
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  #catch(x) { return x; }\n  m() {\n    this.#catch(run)\n    {\n    }\n  }\n}\nrun = cp;`), ["child_process.exec"]);
  assert.deepEqual(rules('import { spawn } from "node:child_process";\nexport const o = { child: spawn("x", [], { shell: true }) };'), ["shell"]);
  assert.deepEqual(rules('import { spawn } from "node:child_process";\nexport class A {\n  child = spawn("x", [], { shell: true });\n}'), ["shell"]);
});

test("a field named class before a static block, a list that never closes, and the conditions no test held (Д-486 … Д-489)", () => {
  // No class is named `static`: the block's code is code, not the class's fields. A sloppy script's function may be,
  // and its body stays its own: a `/` after the function expression divides.
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  class\n  static {\n    run = cp;\n  }\n}`), ["child_process.exec"]);
  assert.deepEqual(rules('var x = function static() {} / 2 + "/"; eval("1");\n', { script: true }), ["eval"]);
  assert.doesNotThrow(() => forbiddenCalls("{\nf("));
  assert.doesNotThrow(() => forbiddenCalls("{\n  const x = f(1,\n"));
  // Only a word right in a substitution walks nothing: a declaration in a function there declares (Д-488).
  assert.deepEqual(rules(`${CP}export let run;\nexport const t = ${BT}\${(() => {\n  let run = cp;\n  return run;\n})()}${BT};`), []);
  // A statement `with`'s parentheses hold its object; a template's commas are not the arguments'; a template's end is
  // where it ends; `extends` in a computed key is no heritage; an arrow needs its `>`; `class` after a newline is a
  // field's name, and the method after it names nothing the file declares.
  assert.deepEqual(rules("with ({ shell: true }) {}\n", { script: true }), ["shell"]);
  assert.deepEqual(rules(`const a = 1, b = 2;\nrequire.call(${BT}\${a, b}${BT}, "child_process").exec("x");`), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}export let run;\nexport const f = (a = ${BT}\${a}${BT}, run) => {\n  run = cp;\n};`), []);
  assert.deepEqual(rules(`${CP}export let run;\nconst o = {};\nexport class A {\n  class\n  [o.extends](x) {\n    run = cp;\n  }\n}`), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}export let run;\nif ((run) === 1) {}\nrun = cp;`), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  class\n  run() {}\n}\nrun = cp;`), ["child_process.exec"]);
  // A field on the line after one that ends in a call or an index is a field too.
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  x = String(1)\n  run = cp\n  y = [1][0]\n  z = run\n}`), []);
});

test("a member named class or function opens no wait for a class's body, whatever member follows it (Д-499)", () => {
  const block = (members) => `${CP}export let run;\nexport class A {\n${members.map((m) => `  ${m}\n`).join("")}  static {\n    run = cp;\n  }\n}`;
  for (const members of [["class", "x"], ["class", "#x"], ["class", "[k]"], ["class", "class"], ["class", "extends"], ["class", "function", "static {}"]]) {
    assert.deepEqual(rules(`const k = "k";\n${block(members)}`), ["child_process.exec"], members.join("⏎"));
  }
  // Read as a class's body, the static block's statements were fields: the alias it binds, and the call through it, hid.
  assert.deepEqual(rules(`${CP}let run;\nexport class A {\n  class\n  x\n  static {\n    run = cp;\n  }\n}\nrun.exec("ls");`), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  class\n  extends() {\n    run = cp;\n  }\n}`), ["child_process.exec"]);
  assert.deepEqual(rules("export class A {\n  class\n  extends({ shell }) {\n    return shell;\n  }\n}"), []);
  assert.deepEqual(rules('import { spawn } from "node:child_process";\nexport class A {\n  class\n  x\n  static {\n    spawn("x", [], { shell: true })\n    {\n    }\n  }\n}'), ["shell"]);
  // After a field named in, or a member `this.in`, `static {` right after class is still a static block (Д-486).
  for (const members of [["in", "class"], ["x = this.in", "class"]]) assert.deepEqual(rules(block(members)), ["child_process.exec"], members.join("⏎"));
  // What ends a member before a field named class: `static`, a member's name, `x++` — and a member between it and the block.
  for (const members of [["static class", "x"], ["x = this.in", "class", "y"], ["y = a++", "class", "x"]]) {
    assert.deepEqual(rules(`let a = 0;\n${block(members)}`), ["child_process.exec"], members.join("⏎"));
  }
  // A class expression after => in a field is still a class: its method's body on its own line, its list a list.
  assert.deepEqual(rules("export class A {\n  x = () => class {\n    m({ shell })\n    {\n      return shell;\n    }\n  };\n}"), []);
});

test("the conditions the mutants left untested: a method named by a string, a computed one, a private one named function, what ends a wait (Д-500)", () => {
  // A method named by a string in a literal read after `>`: no statement keyword's parentheses (P17).
  assert.deepEqual(rules('const a = 1;\nexport const x = a > { "if"({ shell }) { return shell; } };'), []);
  // A computed method whose body begins on its own line: its place, not its head (R3).
  assert.deepEqual(rules(`${CP}export let run;\nconst k = "m";\nexport class A {\n  [k](run)\n  {\n    run = cp;\n  }\n}`), []);
  // A declarator after a template in the same declaration still declares: the walk ends with its own template only (M7).
  assert.deepEqual(rules(`${CP}export let run;\nexport function f(x) {\n  const a = ${BT}\${x}${BT}, run = cp;\n  return [a, run];\n}`), []);
  // A private method named function, called, a block after it: a call (R13).
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  #function(x) { return x; }\n  m() {\n    this.#function(run)\n    {\n    }\n  }\n}\nrun = cp;`), ["child_process.exec"]);
  // Where a field named class still waits for a body — after one named in —, a ; or an = ends the wait, an extends
  // deeper than it marks no heritage (Q17, N4, M15); a static ends a wait at its own depth only, so the class whose
  // heritage holds such a field keeps its body (R7).
  const after = (members) => `${CP}export let run;\nconst o = { extends: "k" };\nexport class A {\n  in\n${members}\n}`;
  assert.deepEqual(rules(after("  class;\n  static {\n    run = cp;\n  }")), ["child_process.exec"]);
  assert.deepEqual(rules(after("  class = { run = cp } = {};")), ["child_process.exec"]);
  assert.deepEqual(rules(after("  class\n  [o.extends]() {\n    run = cp;\n  }")), ["child_process.exec"]);
  assert.deepEqual(rules(`${CP}export let run;\nexport const B = class extends (class {\n  class\n  static {}\n}) {\n  run = cp;\n};`), []);
  // A script's `let` right in a substitution — the first, a later one, one in a template within another's parentheses —
  // is a name and declares nothing: the spread after it is the module's (Z7, Z9, Z10, R6).
  for (const code of ["${let}${{ ...cp }}", "${0}${let}${{ ...cp }}", "${f(`${let}${{ ...cp }}`)}"]) {
    const source = `const cp = require("node:child_process");\nconst f = (s) => s;\nvar let = 1;\nmodule.exports = ${BT}${code}${BT};\n`;
    assert.deepEqual(rules(source, { script: true }), ["child_process.exec"], code);
  }
});

test("a file mid-edit costs what its length does: a bracket left open in each substitution, a .call( that never closes (Д-501)", () => {
  const timed = (source, options) => {
    const started = performance.now();
    forbiddenCalls(source, options);
    return performance.now() - started;
  };
  const n = 16000;
  assert.ok(timed(`var a = ${`${BT}\${(let[0]}${BT} + `.repeat(n)}1;\n`, { script: true }) < 4000, "a let in an open parenthesis in each substitution");
  assert.ok(timed(`x = ${"require.call(a + ".repeat(n)}1;\n`) < 4000, "a .call( that never closes");
  // A loader's .call( opened in each substitution and closed after all the templates: its argument's walk ends with its own (Д-510).
  assert.ok(timed(`x = ${`${BT}\${require.call(a + 1}${BT} + `.repeat(n)}1${")".repeat(n)};\n`) < 4000, "a .call( in each substitution");
});

test("a substitution of a field's template is an expression's place, a ?. is in its template, a member named like a keyword ends an operand, an object literal after an operator is one (Д-503 … Д-509, Д-511)", () => {
  // A class or function expression in a later substitution of a field's template is an expression: its body is a body (Д-503).
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  t = ${BT}\${{}}\${class { run = cp }}${BT};\n}`), []);
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  t = ${BT}\${1}\${\n    class { run = cp }}${BT};\n}`), []);
  assert.deepEqual(rules(`export class A {\n  t = ${BT}\${{}}\${class {\n    m({ shell })\n    {\n      return shell;\n    }\n  }}${BT};\n}`), []);
  assert.deepEqual(rules(`export class A {\n  t = ${BT}\${{}}\${function () {} / 2}${BT} + eval / 3;\n}`), ["eval"]);
  assert.deepEqual(rules(`export class A {\n  t = ${BT}\${{}}\${function () {} / eval("1") / 2}${BT};\n}`), ["eval"]);
  // The . a ?. leaves is in its template: the declarators after it in a substitution still declare (Д-504).
  assert.deepEqual(rules(`${CP}export let run;\nexport const label = (o) => ${BT}\${(() => { const a = o?.name, run = cp; return a + run; })()}${BT};`), []);
  // An assignment in a later substitution of a field's template assigns (Д-505).
  assert.deepEqual(rules(`${CP}let run;\nexport class A {\n  t = ${BT}\${{}}\${run = cp}${BT};\n}\nrun.exec("x");`), ["child_process.exec"]);
  // A member named like a keyword ends a value at its line's end, and with a postfix ++ or -- ends its operand (Д-506, Д-508).
  assert.deepEqual(rules(`${CP}export let run;\nexport function f(o) {\n  const p = o.default\n  const run = cp\n  return [p, run]\n}`), []);
  assert.deepEqual(rules("export function f(stats, total) {\n  const share = stats.new++ / total; // Function of the new count\n  return share;\n}"), []);
  assert.deepEqual(rules("export function f(counts, n) {\n  const r = counts.default-- / n; const g = eval; return g / 2;\n}"), ["eval"]);
  // An object literal after /, <, a > that ends no arrow, a for head's of, or right after extends is a literal (Д-507).
  const spawn = 'import { spawn } from "node:child_process";\nconst a = 1;\n';
  for (const before of ["a /", "a <", "a >", "a >>"]) assert.deepEqual(rules(`${spawn}export const x = ${before} { shell: true };`), ["shell"], before);
  assert.deepEqual(rules(`${spawn}for (const k of { shell: true }) spawn(k);`), ["shell"]);
  assert.deepEqual(rules(`${spawn}export class B extends { shell: true }.constructor {}`), ["shell"]);
  for (const before of ["a /", "a >"]) {
    assert.deepEqual(rules(`const a = 1;\nexport const x = ${before} {\n  m({ shell })\n  {\n    return shell;\n  }\n};`), [], before);
  }
  assert.deepEqual(rules("export function f() {\n  for (const k of {\n    m({ shell })\n    {\n      return shell;\n    }\n  }) return k;\n}"), []);
  assert.deepEqual(rules("export const g = (a) => {\n  m({ shell: true })\n};\nfunction m(o) { return o; }"), ["shell"]);
  // A member named let right in a class's body declares nothing, after a field named in too (Д-509).
  assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  in\n  let\n  run = 1\n}\nrun = cp;`), ["child_process.exec"]);
  // What ends a member before a field named class: a ;, a method's }, a field on the line before (Д-511).
  for (const lead of ["x = 1; class", "m() {}\n  class", "x\n  class"]) {
    assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  ${lead}\n  y\n  static {\n    run = cp;\n  }\n}`), ["child_process.exec"], lead);
  }
  // A declarator after a template and an operator still declares; new, typeof, void before a class expression in a field (Д-511).
  assert.deepEqual(rules(`${CP}export let run;\nexport function f(x) {\n  const a = ${BT}\${x}${BT} + "", run = cp;\n  return [a, run];\n}`), []);
  for (const value of ["new class", "new\n  class", "typeof\n  class", "void class"]) {
    assert.deepEqual(rules(`${CP}export let run;\nexport class A {\n  x = ${value} { run = cp }\n}`), [], value);
  }
});
