import assert from "node:assert/strict";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { codeTokens, forbiddenCalls } from "./forbidden-calls.mjs";

const rules = (source, options) => forbiddenCalls(source, options).map((finding) => finding.rule);

test("the six spellings the gate let through are each refused (Д-267)", () => {
  const cases = [
    ['import * as childProcess from "node:child_process";\nchildProcess.exec(command);', ["child_process.exec"]],
    ['import cp from "node:child_process";\ncp.exec(command);', ["child_process.exec"]],
    ['import { execSync } from "node:child_process";\nexecSync(command);', ["child_process.exec"]],
    ['import { spawn } from "node:child_process";\nspawn(command, [], { "shell": true });', ["shell"]],
    ['import { spawn } from "node:child_process";\nspawn(command, [], { shell: "/bin/sh" });', ["shell"]],
    ['globalThis["ev" + "al"](command);', ["global-member"]]
  ];
  for (const [source, expected] of cases) assert.deepEqual(rules(source), expected, source);
});

test("the spellings the gate always knew are still refused", () => {
  assert.deepEqual(rules("eval(source);"), ["eval"]);
  assert.deepEqual(rules('const make = new Function("return 1");'), ["Function"]);
  assert.deepEqual(rules('spawn("x", [], { shell: true });'), ["shell"]);
  assert.deepEqual(rules('import { exec } from "node:child_process";'), ["child_process.exec"]);
  assert.deepEqual(rules('const { exec } = require("child_process");'), ["child_process.exec"]);
  assert.deepEqual(rules('require("child_process").exec("ls");'), ["child_process.exec"]);
});

test("every way of reaching exec through the module is refused", () => {
  const refused = [
    'import { exec as run } from "child_process";',
    'import cp, { spawn } from "node:child_process";\ncp.execSync("x");',
    'import * as cp from "node:child_process";\ncp?.exec("x");',
    'import * as cp from "node:child_process";\ncp["exec"]("x");',
    'import * as cp from "node:child_process";\nconst name = "exec";\ncp[name]("x");',
    'import * as cp from "node:child_process";\nconst { execSync: run } = cp;',
    'const cp = require("node:child_process");\ncp.exec("x");',
    'const { "execSync": run } = require("child_process");',
    'const cp = await import("node:child_process");\ncp.exec("x");',
    'const { exec } = await import("node:child_process");',
    '(await import("node:child_process")).execSync("x");',
    'import("node:child_process").then(({ exec }) => exec("x"));',
    'import("node:child_process").then((cp) => cp.exec("x"));',
    'export { exec } from "node:child_process";'
  ];
  for (const source of refused) assert.ok(rules(source).includes("child_process.exec"), source);
});

test("eval and the Function constructor are refused however they are reached, and allowed where a test needs them", () => {
  for (const source of [
    "(0, eval)(source);",
    "const run = eval;",
    "globalThis.eval(source);",
    'window["eval"](source);',
    "Function(\"return this\")();",
    "const Make = Function;",
    '({}).constructor.constructor("return 1")();'
  ]) {
    assert.ok(rules(source).length > 0, source);
  }
  assert.deepEqual(rules("window[key]();"), ["global-member"], "a computed member of a global cannot be read");
  assert.deepEqual(rules('window["Function"]("x");'), ["global-member"]);
  // The desktop tests show the page's policy refuses these, so they may write them.
  assert.deepEqual(rules('eval("1"); new Function("return 1");', { allowEval: true }), []);
  assert.deepEqual(rules('window["eval"]("1");', { allowEval: true }), []);
  assert.deepEqual(rules('spawn("x", [], { shell: true });', { allowEval: true }), ["shell"], "the shell rule holds in tests too");
});

test("a shell option is refused unless it is plainly off", () => {
  for (const value of ["true", '"/bin/sh"', "'cmd.exe'", "1", "process.env.SHELL", 'process.platform === "win32"', "!1"]) {
    assert.deepEqual(rules(`spawn("x", [], { shell: ${value} });`), ["shell"], value);
  }
  assert.deepEqual(rules('spawn("x", [], { cwd, shell });'), ["shell"], "a shorthand nobody can read");
  for (const value of ["false", "null", "undefined", "0", '""', "''"]) {
    assert.deepEqual(rules(`spawn("x", [], { shell: ${value} });`), [], value);
  }
  assert.deepEqual(rules('spawn("x", [], { windowsHide: true, shell: false, });'), []);
  assert.deepEqual(rules("const { shell } = options;"), [], "reading the option is not setting it");
  // Set on an options object afterwards it is the same option (Д-382).
  assert.deepEqual(rules("options.shell = true;"), ["shell"]);
  assert.deepEqual(rules('options["shell"] = "/bin/sh";'), ["shell"]);
  assert.deepEqual(rules("options.shell = false;\nif (options.shell === true) {}"), [], "off, and compared");
  assert.deepEqual(rules('spawn("x", [], { ["shell"]: true });'), ["shell"], "a computed key that is one plain string");
  assert.deepEqual(rules('spawn("x", [], { "sh\\u0065ll": true });'), ["shell"], "escaped");
});

test("what only looks like a forbidden call passes: strings, comments, templates, regular expressions, other objects' exec", () => {
  const honest = [
    'const text = "eval(x) and shell: true and import { exec } from \\"child_process\\"";',
    "// eval(x); shell: true; new Function()",
    "/* import * as cp from 'node:child_process'; cp.exec() */",
    "const help = `Use eval( with care; { shell: true } is refused; ${name} is fine`;",
    "const pattern = /\\beval\\s*\\(/; const other = /shell\\s*:\\s*true/g;",
    "const match = /x/.exec(line); const again = PATTERN.exec(text);",
    'new Worker(source, { eval: true, workerData: {} });',
    'import { spawn, spawnSync, execFile, execFileSync } from "node:child_process";\nexecFile("git", ["status"]);',
    'const { spawnSync } = await import("node:child_process");',
    "class Box { constructor(value) { this.value = value; } }",
    "if (value instanceof Function) {}",
    "const source = Function.prototype.toString.call(handler);",
    'const page = await browser.$eval("body", (node) => node.textContent);'
  ];
  for (const source of honest) assert.deepEqual(rules(source), [], source);
});

test("the reader keeps lines, reads template substitutions as code, and survives what it does not understand", () => {
  const findings = forbiddenCalls("const a = 1;\n\n/* two\nlines */\nconst b = `x ${eval(y)} z`;\n");
  assert.deepEqual(findings.map((finding) => [finding.rule, finding.line]), [["eval", 5]]);
  assert.deepEqual(rules("const nested = `a ${`b ${eval(c)}`}`;"), ["eval"]);
  assert.deepEqual(rules("#!/usr/bin/env node\neval(x);"), ["eval"]);
  assert.deepEqual(codeTokens('a?.b "s" 1.5').map((token) => [token.type, token.value]), [["name", "a"], ["punct", "."], ["name", "b"], ["string", "s"], ["number", "1.5"]]);
  // Unterminated strings, comments and templates end the file rather than the reader.
  for (const broken of ['const a = "open', "/* never closed", "const t = `open ${", "const r = /never closed"]) {
    assert.doesNotThrow(() => forbiddenCalls(broken), broken);
  }
});

// The probes of phase 14's first review, each a spelling the gate let through or an honest line it refused (Д-382).
test("the spellings the first review of the gate found it let through are each refused (Д-382)", () => {
  const BT = "`";
  const refused = {
    "optional computed member": 'import * as cp from "node:child_process";\ncp?.["exec"]("ls");',
    "namespace .default.exec": 'import * as ns from "node:child_process";\nns.default.exec("ls");',
    "default destructured": 'const { default: cp } = await import("node:child_process");\ncp.exec("ls");',
    "(await import()).default": 'const cp = (await import("node:child_process")).default;\ncp.exec("ls");',
    "import { default as cp }": 'import { default as cp } from "node:child_process";\ncp.execSync("ls");',
    "template module name": `const cp = require(${BT}child_process${BT});\ncp.exec("ls");`,
    "plain re-binding": 'const cp = require("child_process");\nconst c2 = cp;\nc2.exec("ls");',
    "rest element": 'const { ...all } = require("child_process");\nall.exec("ls");',
    "then(async (cp) =>)": 'import("child_process").then(async (cp) => cp.exec("ls"));',
    "then(function (cp))": 'import("child_process").then(function (cp) { cp.exec("ls"); });',
    "then(function named(cp))": 'import("child_process").then(function named(cp) { cp.exec("ls"); });',
    "hex escape in a key": 'const cp = require("child_process");\ncp["\\x65xec"]("ls");',
    "unicode escape in a key": 'const cp = require("child_process");\ncp["\\u0065xec"]("ls");',
    "unicode escape in the module name": 'const cp = require("child\\u005fprocess");\ncp.exec("ls");',
    "escaped eval": '\\u0065val("1+1");',
    "escaped member name": 'const cp = require("child_process");\ncp.\\u0065xec("ls");',
    "paren-wrapped require": 'const cp = (require("child_process"));\ncp.exec("ls");',
    "globalThis.Function": 'globalThis.Function("return 1")();',
    "globalThis?.[]": 'globalThis?.["ev" + "al"]("1");',
    "(globalThis)[]": '(globalThis)["ev" + "al"]("1");',
    "global.globalThis[]": 'global.globalThis["ev" + "al"]("1");',
    "a global re-bound": 'const g = globalThis;\ng["ev" + "al"]("1");',
    "eval in a ternary": 'const f = x ? eval : null;\nf("1");',
    "eval destructured from a global": 'const { eval: run } = globalThis;\nrun("1");'
  };
  for (const [name, source] of Object.entries(refused)) assert.ok(rules(source).length > 0, `${name}: ${source}`);
});

test("honest code the first review found the gate refused passes now (Д-382)", () => {
  const honest = {
    "electron's shell": 'import { app, shell } from "electron";\nshell.openExternal("https://example.invalid");',
    "a default import beside it": 'import electron, { shell } from "electron";\nshell.beep();',
    "a parameter pattern": "function run({ cmd, shell }) { return shell ? 1 : 0; }",
    "an arrow's parameter pattern": "const pick = ({ shell }) => shell;",
    "an async arrow's": "const pick = async ({ shell, cwd }) => [shell, cwd];",
    "a method's": "const o = { run({ shell }) { return shell; } };",
    "a for-of pattern": "for (const { shell } of list) console.log(shell);",
    "a nested pattern": "const { options: { shell } } = config;",
    "an argument": "describe(name, shell, rest);",
    "an array": "const names = [bash, shell, zsh];",
    "a re-export": 'export { shell } from "electron";',
    "an object key on a worker": "new Worker(source, { eval: true });",
    "a regular expression after a block": "function f() {}\n/`/.test(s);\nconst y = 1;"
  };
  for (const [name, source] of Object.entries(honest)) assert.deepEqual(rules(source), [], `${name}: ${source}`);
});

test("a regular expression that begins a line after a block does not hide what follows it, and an unclosed template refuses the file (Д-382)", () => {
  const BT = "`";
  // The backtick in the expression used to open a template that ran to the end of the file.
  const source = `function f() {}\n/${BT}/.test(s);\nconst cp = require("child_process");\ncp.exec("ls");\nconst t = ${BT}x${BT};`;
  assert.deepEqual(forbiddenCalls(source).map((finding) => [finding.rule, finding.line]), [["child_process.exec", 4]]);
  // A file read past its end is refused, not passed: whatever followed went unchecked.
  for (const broken of [`const t = ${BT}open`, `const t = ${BT}a \${b`, "/* never closed\neval(x);"]) {
    assert.deepEqual(rules(broken), ["unread"], broken);
  }
  assert.equal(codeTokens(`const t = ${BT}open`).unterminated, 1);
  // A substitution that begins with a regular expression: its slash is not a division.
  const regexInside = `lines.push(${BT}### \${/^phase\\s+\\d+/i.test(title) ? title : ${BT}Phase \${n}${BT}}${BT});\nconst note = ${BT}a ${BT};\neval(x);`;
  assert.deepEqual(forbiddenCalls(regexInside).map((finding) => [finding.rule, finding.line]), [["eval", 3]]);
  assert.equal(codeTokens(`const t = ${BT}a${BT};`).unterminated, undefined);
  assert.deepEqual(codeTokens(`a?.[b] ${BT}plain${BT}`).map((token) => [token.type, token.value]), [["name", "a"], ["punct", "["], ["name", "b"], ["punct", "]"], ["string", "plain"]]);
});

// The probes of phase 14's second review: spellings inside the contract that still passed, three of them since the
// first review's fix (Д-398), and what the reader got wrong (Д-399).
test("the spellings the second review found the gate let through are each refused (Д-398, Д-399)", () => {
  const LS = String.fromCharCode(0x2028);
  const refused = {
    "shell in a parameter's default": "function run(cmd, options = { shell: true }) {\n  return spawnSync(cmd, [], options);\n}",
    "shell in an arrow's default": "const run = (cmd, opts = { shell: true }) => spawnSync(cmd, [], opts);",
    "shell in what for-of iterates": "for (const options of [{ shell: true }]) {\n  spawnSync(cmd, [], options);\n}",
    "shell in a default inside a pattern": "const { options = { shell: true } } = config;",
    "shell in a heritage call": "class Runner extends make({ shell: true }) {}",
    "eval by a quoted key": 'const { "eval": run } = globalThis;\nrun("1");',
    "eval by a computed key": 'const { ["eval"]: run } = globalThis;',
    "Function by a quoted key": 'const { "Function": F } = globalThis;',
    "a computed key out of a global": "const { [key]: f } = globalThis;",
    "Function.call": 'Function.call(null, "return 1")();',
    "Function.apply": 'Function.apply(null, ["return 1"])();',
    "globalThis.Function.call": 'globalThis.Function.call(null, "return 1")();',
    ".constructor.constructor.call": '({}).constructor.constructor.call(null, "return 1")();',
    "computed constructor": '({})["constructor"]["constructor"]("return 1")();',
    "tagged constructor": "({}).constructor.constructor`return 1`();",
    "Function.prototype.constructor": 'const F = Function.prototype.constructor;\nF("return 1")();',
    "shell ??=": "options.shell ??= true;",
    "shell ||=": 'options.shell ||= "/bin/sh";',
    "shell getter": 'spawn("x", [], { get shell() { return true; } });',
    "shell method": 'spawn("x", [], { shell() {} });',
    "lazy module ??=": 'let cp;\nasync function load() {\n  cp ??= await import("node:child_process");\n  return cp.exec("ls");\n}',
    "lazy module ||=": 'let cp;\ncp ||= require("node:child_process");\ncp.execSync("ls");',
    "module in parentheses": 'import * as cp from "node:child_process";\n(cp).exec("ls");',
    "module last in a list": 'import * as cp from "node:child_process";\n(0, cp)["execSync"]("ls");',
    "global last in a list": '(0, globalThis)["ev" + "al"]("1");',
    "?. then a comment": 'import * as cp from "node:child_process";\ncp?./* x */["exec"]("ls");',
    "?. then a line break": 'globalThis?.\n  ["ev" + "al"]("1");',
    "export *": 'export * from "node:child_process";',
    "export * as": 'export * as cp from "node:child_process";',
    "export { default }": 'export { default } from "node:child_process";',
    "module.exports =": 'module.exports = require("node:child_process");',
    "exports.x =": 'exports.cp = require("node:child_process");',
    "module.exports spread": 'module.exports = { ...require("child_process") };',
    "export default an alias": 'import * as cp from "node:child_process";\nexport default cp;',
    "export { alias }": 'import * as cp from "node:child_process";\nexport { cp };',
    "module.require": 'const cp = module.require("child_process");\ncp.exec("ls");',
    "a trailing comma": 'const cp = require("child_process",);\ncp.exec("ls");',
    "import() with options": 'const cp = await import("node:child_process", {});\ncp.exec("ls");',
    "await (import())": 'const { exec } = await (import("child_process"));',
    "ns.default re-bound": 'import * as ns from "child_process";\nconst cp = ns.default;\ncp.exec("ls");',
    "(cp) re-bound": 'const cp = require("child_process");\nconst c2 = (cp);\nc2.exec("ls");',
    ".then on a bound import()": 'const loading = import("child_process");\nloading.then((cp) => cp.exec("ls"));',
    "an awaited bound import() taken apart": 'const loading = import("child_process");\nconst { exec } = await loading;',
    "((globalThis))[]": '((globalThis))["ev" + "al"]("1");',
    "global.globalThis re-bound": 'const g = global.globalThis;\ng["ev" + "al"]("1");',
    "false, then || on the next line": 'spawn("x", [], { shell: false\n  || "/bin/sh" });',
    "a long \\u{} escape in a name": "\\u{0000065}val(\"1\");",
    "a long \\u{} escape in the module name": 'const cp = require("child\\u{000005f}process");\ncp.exec("ls");',
    "an octal escape in the module name": 'const cp = require("child\\137process");\ncp.exec("ls");',
    "an octal escape in a key": 'spawn("x", [], { "sh\\145ll": true });',
    "a line continuation in the module name": 'const cp = require("child_\\\nprocess");\ncp.exec("ls");'
  };
  for (const [name, source] of Object.entries(refused)) assert.ok(rules(source).length > 0, `${name}: ${source}`);
  // A division the reader took for a regular expression used to swallow the next line; a // comment, a file of CRs.
  const lines = (source) => forbiddenCalls(source).map((finding) => [finding.rule, finding.line]);
  assert.deepEqual(lines('import * as cp from "node:child_process";\nconst kb = stats.in / 1024\ncp.exec("ls")'), [["child_process.exec", 3]]);
  assert.deepEqual(lines('const half = count++ / 2\neval("1")'), [["eval", 2]]);
  // `of` is a name as well as a keyword: a slash after it that does not close on its line divides.
  assert.deepEqual(lines('const of = 10;\nconst half = of / 2\neval("1");'), [["eval", 3]]);
  // After a postfix `++` the slash divides even where a closing one follows on the line.
  assert.deepEqual(lines('const x = n++ / 2, y = `/`;\neval("1");'), [["eval", 2]]);
  assert.deepEqual(lines('const total = {\n  a: 1\n}\n/ 2; eval("1");'), [["eval", 4]]);
  assert.deepEqual(lines('// note\reval("1");'), [["eval", 2]]);
  assert.deepEqual(lines(`// note${LS}eval("1");`), [["eval", 2]]);
  assert.deepEqual(lines('const a = 1;\r\nconst b = 2;\r\neval("1");'), [["eval", 3]], "CRLF counts once");
});

test("valid code the reader took for an unclosed template or comment passes, and honest look-alikes stay honest (Д-399)", () => {
  const BT = "`";
  const honest = {
    "a regular expression after if (…)": `if (ready) /${BT}/.test(line);\nconst a = 1;`,
    "after while (…)": "while (more()) /[/*]/.test(next());\nconst a = 1;",
    "after for (…)": `for (const line of lines) /${BT}/.test(line);\nconst t = ${BT}x${BT};`,
    "after export default": `export default /${BT}/;\nconst t = ${BT}x${BT};`,
    "after a block on the same line": `function f() {} /${BT}/.test(s);\nconst t = 1;`,
    "a division after a property named in": `const r = traffic.in / total, unit = ${BT}/s${BT};\nconst t = ${BT}x${BT};`,
    "a division after an object literal": `const r = {}.size / 2, unit = ${BT}/s${BT};`,
    "a division after a call": `const r = f(x) / 2, unit = ${BT}/s${BT};`,
    "a method named eval": "const o = { eval() { return 1; } };",
    "an object key named Function": "const types = { Function: describeFunction, String: describeString };",
    "uncurrying this": "const call = Function.call.bind(Function.call);",
    "a constructor's name": "const name = this.constructor.name;",
    "a constructor handed on": "const Kind = value.constructor;",
    "a call of what f returns": 'const page = f(globalThis)["innerWidth"];',
    "a shell option plainly off with a line break": 'spawn("x", [], {\n  shell: false\n});',
    "options.shell ??= false": "options.shell ??= false;",
    "reading the option": "const useShell = options.shell ?? false;",
    "spawn re-exported by name": 'export { spawn } from "node:child_process";'
  };
  for (const [name, source] of Object.entries(honest)) assert.deepEqual(rules(source), [], `${name}: ${source}`);
});

test("the reader stays linear where its questions used to search: one minified line, long chains (Д-401)", () => {
  const timed = (source) => {
    const started = performance.now();
    forbiddenCalls(source);
    return performance.now() - started;
  };
  // Before, 448 kB of `x={}/1;` on one line took 10 s and 166 kB of re-bindings in reverse order 8.6 s.
  assert.ok(timed("x={}/1;".repeat(64000)) < 4000, "one line");
  const reverse = [];
  for (let index = 8000; index >= 1; index -= 1) reverse.push(`const c${index + 1} = c${index};`);
  const chain = `${reverse.join("\n")}\nconst c1 = require("child_process");\nc8001.exec("ls");`;
  assert.ok(timed(chain) < 4000, "re-bindings in reverse order");
  assert.deepEqual(rules(chain), ["child_process.exec"], "and the chain is still followed to its end");
  assert.ok(timed(`x = globalThis${".globalThis".repeat(20000)}["a"];`) < 4000, "a chain of globals");
});
