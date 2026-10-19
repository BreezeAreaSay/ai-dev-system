/**
 * The calls AGENTS.md forbids, found by what the code does rather than how it
 * happens to be spelled.
 *
 * The static gate used to look for the usual spellings — `eval(`, `shell: true`,
 * `import { exec } from "node:child_process"` — and every equivalent spelling
 * passed it: `import * as cp` then `cp.exec(…)`, `execSync(…)`, `{ "shell": true }`,
 * `{ shell: "/bin/sh" }`, `globalThis["ev" + "al"](…)` (docs/DEFECTS.md, Д-267).
 * So the source is read as tokens — comments, strings, template text and
 * regular-expression literals set aside — and the rules are asked of those:
 *
 * - `eval` in any role but an object key (`{ eval: true }` is a Worker option);
 * - the `Function` constructor, called or handed on, and a call of a
 *   `.constructor` member (`({}).constructor.constructor("…")` is `Function`);
 * - a computed member of `globalThis`, `window`, `global` or `self`, unless the
 *   key is one plain string that names neither of the two;
 * - `exec` or `execSync` of `child_process`, however the module is reached:
 *   a named import, a default or namespace import, `require`, `import()`,
 *   and any name the module object was bound to;
 * - a `shell` option with any value but `false`, `null`, `undefined`, `0` or
 *   an empty string — and a `shell` shorthand, whose value nobody can see.
 *
 * It is a reader, not a parser: it does not follow a value through a variable
 * (`const name = "exec"; cp[name]()` is a computed member of the module, and is
 * refused as one), and that is on purpose — the gate refuses what it cannot
 * read rather than trusting it.
 */

const MODULE_NAMES = new Set(["child_process", "node:child_process"]);
const FORBIDDEN_MEMBERS = new Set(["exec", "execSync"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "global", "self"]);
const FALSY_LITERALS = new Set(["false", "null", "undefined", "0"]);
// After these a `/` starts a regular expression, not a division.
const KEYWORDS_BEFORE_EXPRESSION = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"
]);

/**
 * The tokens of a JavaScript source: `{ type, value, line }` with type
 * `name`, `string` (value is the decoded text), `number`, `punct`, or
 * `template` (one per template literal; the code in its `${…}` is tokenised in
 * place). Comments and regular-expression literals leave nothing.
 *
 * @param {string} source
 * @returns {Array<{ type: string, value: string, line: number }>}
 */
export function codeTokens(source) {
  const text = String(source ?? "");
  const tokens = [];
  let at = text.startsWith("#!") ? text.indexOf("\n") : 0;
  if (at < 0) return tokens;
  let line = 1 + (text.slice(0, at).match(/\n/g)?.length ?? 0);
  // Inside a template's `${…}`: how many braces of code are open in each.
  const templates = [];
  const push = (type, value, where = line) => tokens.push({ type, value, line: where });
  const significant = () => tokens.at(-1) ?? null;
  const regexAllowed = () => {
    const last = significant();
    if (!last) return true;
    if (last.type === "name") return KEYWORDS_BEFORE_EXPRESSION.has(last.value);
    if (last.type === "punct") return ![")", "]", "}"].includes(last.value);
    return false;
  };
  const readTemplateText = () => {
    // From just after a backtick or a `}` closing a substitution, to the next `${` or the closing backtick.
    for (; at < text.length; at += 1) {
      const character = text[at];
      if (character === "\\") { at += 1; if (text[at] === "\n") line += 1; continue; }
      if (character === "\n") line += 1;
      if (character === "`") { at += 1; return "end"; }
      if (character === "$" && text[at + 1] === "{") { at += 2; return "code"; }
    }
    return "end";
  };
  while (at < text.length) {
    const character = text[at];
    if (character === "\n") { line += 1; at += 1; continue; }
    if (/\s/.test(character)) { at += 1; continue; }
    if (character === "/" && text[at + 1] === "/") {
      const end = text.indexOf("\n", at);
      at = end < 0 ? text.length : end;
      continue;
    }
    if (character === "/" && text[at + 1] === "*") {
      const end = text.indexOf("*/", at + 2);
      const stop = end < 0 ? text.length : end + 2;
      line += text.slice(at, stop).match(/\n/g)?.length ?? 0;
      at = stop;
      continue;
    }
    if (character === "'" || character === "\"") {
      const started = line;
      let value = "";
      for (at += 1; at < text.length && text[at] !== character; at += 1) {
        if (text[at] === "\\") {
          at += 1;
          const escaped = text[at];
          if (escaped === "\n") { line += 1; continue; }
          value += { n: "\n", t: "\t", r: "\r", 0: "\0" }[escaped] ?? escaped;
          continue;
        }
        if (text[at] === "\n") { line += 1; break; }
        value += text[at];
      }
      at += 1;
      push("string", value, started);
      continue;
    }
    if (character === "`") {
      push("template", "`");
      at += 1;
      if (readTemplateText() === "code") templates.push(0);
      continue;
    }
    if (character === "}" && templates.length && templates.at(-1) === 0) {
      templates.pop();
      at += 1;
      if (readTemplateText() === "code") templates.push(0);
      continue;
    }
    if (character === "/" && regexAllowed()) {
      let inClass = false;
      for (at += 1; at < text.length; at += 1) {
        const inside = text[at];
        if (inside === "\\") { at += 1; continue; }
        if (inside === "\n") break;
        if (inside === "[") inClass = true;
        else if (inside === "]") inClass = false;
        else if (inside === "/" && !inClass) break;
      }
      at += 1;
      while (at < text.length && /[A-Za-z]/.test(text[at])) at += 1;
      push("regex", "/");
      continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(character)) {
      const match = /^[A-Za-z0-9_$\u0080-￿]+/.exec(text.slice(at, at + 256));
      push("name", match[0]);
      at += match[0].length;
      continue;
    }
    if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(text[at + 1] ?? ""))) {
      const match = /^(?:0[xXoObB][0-9a-fA-F_]+n?|[0-9_]*\.?[0-9_]*(?:[eE][+-]?[0-9_]+)?n?)/.exec(text.slice(at, at + 128));
      push("number", match[0] || character);
      at += Math.max(1, match[0].length);
      continue;
    }
    if (character === "?" && text[at + 1] === "." && !/[0-9]/.test(text[at + 2] ?? "")) {
      push("punct", ".");
      at += 2;
      continue;
    }
    if (character === "." && text.startsWith("...", at)) {
      push("punct", "...");
      at += 3;
      continue;
    }
    if (templates.length) {
      if (character === "{") templates[templates.length - 1] += 1;
      if (character === "}") templates[templates.length - 1] -= 1;
    }
    push("punct", character);
    at += 1;
  }
  return tokens;
}

/** The index of the token that closes the bracket opened at `open`, or -1. */
function closing(tokens, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const want = pairs[tokens[open]?.value];
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "punct") continue;
    if (token.value === tokens[open].value) depth += 1;
    else if (token.value === want) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

const isPunct = (token, value) => token?.type === "punct" && token.value === value;

/** Whether the token at `index` sits in an object pattern that is assigned to (`const { shell } = options`), not in an object literal. */
function inPattern(tokens, index) {
  let open = index - 1;
  for (let depth = 0; open >= 0; open -= 1) {
    if (isPunct(tokens[open], "}")) depth += 1;
    if (isPunct(tokens[open], "{")) {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  if (open < 0) return false;
  const end = closing(tokens, open);
  return end >= 0 && isPunct(tokens[end + 1], "=") && !isPunct(tokens[end + 2], "=");
}
const isName = (token, value) => token?.type === "name" && (value === undefined || token.value === value);
const isModuleString = (token) => token?.type === "string" && MODULE_NAMES.has(token.value);

/**
 * The keys an object pattern `{ … }` (from `open` to its closing brace) takes
 * out: `{ exec }`, `{ exec: run }`, `{ "execSync": run }`, nested patterns skipped.
 */
function patternKeys(tokens, open) {
  const end = closing(tokens, open);
  const keys = [];
  let depth = 0;
  let expectKey = true;
  for (let index = open + 1; index < end; index += 1) {
    const token = tokens[index];
    if (token.type === "punct" && ["{", "[", "("].includes(token.value)) depth += 1;
    else if (token.type === "punct" && ["}", "]", ")"].includes(token.value)) depth -= 1;
    else if (depth === 0 && isPunct(token, ",")) expectKey = true;
    else if (depth === 0 && expectKey && (token.type === "name" || token.type === "string")) {
      keys.push({ key: token.value, line: token.line });
      expectKey = false;
    } else if (depth === 0 && expectKey && isPunct(token, "[")) {
      keys.push({ key: null, line: token.line });
      expectKey = false;
    }
  }
  return keys;
}

/**
 * Where the child_process module is reached in these tokens, and the names it
 * is bound to. `reach` is the index just past the expression that yields the
 * module: `require("child_process")`, `import("child_process")` with its
 * `await`, or the module string of a static import.
 */
function moduleReaches(tokens) {
  const reaches = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    // require("child_process") / import("child_process")
    if ((isName(token, "require") || isName(token, "import")) && isPunct(tokens[index + 1], "(") && isModuleString(tokens[index + 2]) && isPunct(tokens[index + 3], ")")) {
      const awaited = isName(tokens[index - 1], "await");
      reaches.push({ kind: token.value, start: awaited ? index - 1 : index, end: index + 4, line: token.line });
      index += 3;
      continue;
    }
    // import … from "child_process" / export … from "child_process"
    if (isName(token, "from") && isModuleString(tokens[index + 1])) {
      let start = index - 1;
      while (start >= 0 && !isName(tokens[start], "import") && !isName(tokens[start], "export")) start -= 1;
      if (start >= 0) reaches.push({ kind: "static", start, end: index + 2, clause: [start + 1, index], line: token.line });
    }
  }
  return reaches;
}

/**
 * The findings for one source file: `{ rule, line, message }`, in the order
 * they appear. `allowEval` lets a file use `eval` and the `Function`
 * constructor — the desktop tests do, to show the page's policy refuses them.
 *
 * @param {string} source
 * @param {{ allowEval?: boolean }} [options]
 * @returns {Array<{ rule: string, line: number, message: string }>}
 */
export function forbiddenCalls(source, { allowEval = false } = {}) {
  const tokens = codeTokens(source);
  const findings = [];
  const say = (rule, line, message) => findings.push({ rule, line, message });
  const aliases = new Set();

  const execMember = (index) => {
    // `<object>.exec` / `<object>["exec"]` / a computed member that cannot be read.
    if (isPunct(tokens[index], ".") && isName(tokens[index + 1]) && FORBIDDEN_MEMBERS.has(tokens[index + 1].value)) return tokens[index + 1].value;
    if (isPunct(tokens[index], "[")) {
      const end = closing(tokens, index);
      const inside = tokens.slice(index + 1, end);
      if (inside.length === 1 && inside[0].type === "string") return FORBIDDEN_MEMBERS.has(inside[0].value) ? inside[0].value : null;
      return "a computed member";
    }
    return null;
  };
  const childProcessFinding = (line, what) => say("child_process.exec", line, `child_process ${what} is forbidden; use argv-based execution (spawn, spawnSync, execFile, execFileSync).`);

  for (const reach of moduleReaches(tokens)) {
    if (reach.kind === "static") {
      // import x, * as y, { a, b as c } from "child_process"
      const [from, to] = reach.clause;
      for (let index = from; index < to; index += 1) {
        const token = tokens[index];
        if (isPunct(token, "{")) {
          const end = closing(tokens, index);
          for (let inner = index + 1; inner < end; inner += 1) {
            const name = tokens[inner];
            const previous = tokens[inner - 1];
            if ((name.type === "name" || name.type === "string") && (isPunct(previous, "{") || isPunct(previous, ",")) && FORBIDDEN_MEMBERS.has(name.value)) {
              childProcessFinding(name.line, `${name.value} (imported by name)`);
            }
          }
          index = end;
        } else if (isPunct(token, "*") && isName(tokens[index + 1], "as") && isName(tokens[index + 2])) {
          aliases.add(tokens[index + 2].value);
          index += 2;
        } else if (isName(token) && token.value !== "type" && (isPunct(tokens[index + 1], ",") || index + 1 === to)) {
          aliases.add(token.value);
        }
      }
      continue;
    }
    // The module object as a value: what is done with it right where it is reached.
    const after = tokens[reach.end];
    const member = execMember(reach.end);
    if (member) childProcessFinding(after.line, member === "a computed member" ? member : `${member} (a member of the module)`);
    if (isPunct(after, ")") && isPunct(tokens[reach.start - 1], "(")) {
      // (await import("child_process")).exec
      const outer = execMember(reach.end + 1);
      if (outer) childProcessFinding(tokens[reach.end + 1].line, outer === "a computed member" ? outer : `${outer} (a member of the module)`);
    }
    // import("child_process").then(({ exec }) => …) / .then((cp) => …)
    if (isPunct(after, ".") && isName(tokens[reach.end + 1], "then") && isPunct(tokens[reach.end + 2], "(")) {
      let parameter = reach.end + 3;
      if (isPunct(tokens[parameter], "(")) parameter += 1;
      if (isPunct(tokens[parameter], "{")) {
        for (const { key, line } of patternKeys(tokens, parameter)) if (key === null || FORBIDDEN_MEMBERS.has(key)) childProcessFinding(line, key ?? "a computed member");
      } else if (isName(tokens[parameter])) aliases.add(tokens[parameter].value);
    }
    // const x = <module> / const { exec } = <module>
    if (isPunct(tokens[reach.start - 1], "=")) {
      const target = tokens[reach.start - 2];
      if (isName(target)) aliases.add(target.value);
      if (isPunct(target, "}")) {
        let open = reach.start - 2;
        for (let depth = 0; open >= 0; open -= 1) {
          if (isPunct(tokens[open], "}")) depth += 1;
          if (isPunct(tokens[open], "{")) depth -= 1;
          if (depth === 0) break;
        }
        for (const { key, line } of patternKeys(tokens, open)) if (key === null || FORBIDDEN_MEMBERS.has(key)) childProcessFinding(line, key ?? "a computed member");
      }
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    // A name bound to the module: its exec members, or a pattern taking them out of it.
    if (isName(token) && aliases.has(token.value) && !isPunct(previous, ".")) {
      const member = execMember(index + 1);
      if (member) childProcessFinding(token.line, member === "a computed member" ? `${member} (of ${token.value})` : `${member} (${token.value}.${member})`);
      if (isPunct(previous, "=") && isPunct(tokens[index - 2], "}")) {
        let open = index - 2;
        for (let depth = 0; open >= 0; open -= 1) {
          if (isPunct(tokens[open], "}")) depth += 1;
          if (isPunct(tokens[open], "{")) depth -= 1;
          if (depth === 0) break;
        }
        for (const { key, line } of patternKeys(tokens, open)) if (key === null || FORBIDDEN_MEMBERS.has(key)) childProcessFinding(line, key ?? "a computed member");
      }
    }
    if (!allowEval && isName(token, "eval") && !isPunct(next, ":")) {
      say("eval", token.line, "eval is forbidden, called or handed on.");
    }
    if (!allowEval && isName(token, "Function") && !isPunct(previous, ".") && !isPunct(next, ".") && !isName(previous, "instanceof")) {
      say("Function", token.line, "the Function constructor is forbidden, called or handed on.");
    }
    if (!allowEval && isName(token, "constructor") && isPunct(previous, ".") && isPunct(next, "(")) {
      say("Function", token.line, "calling a .constructor member is forbidden: ({}).constructor.constructor is the Function constructor.");
    }
    if (isName(token) && GLOBAL_OBJECTS.has(token.value) && !isPunct(previous, ".") && isPunct(next, "[")) {
      const end = closing(tokens, index + 1);
      const inside = tokens.slice(index + 2, end);
      const plain = inside.length === 1 && inside[0].type === "string";
      if (!plain || (!allowEval && ["eval", "Function"].includes(inside[0].value))) {
        say("global-member", token.line, `a computed member of ${token.value} is forbidden unless its key is one plain string: it can reach eval or Function under any spelling.`);
      }
    }
    // shell: <truthy> / "shell": <truthy> / { shell } — an object key, not a member access.
    const shellKey = (isName(token, "shell") || (token.type === "string" && token.value === "shell")) && !isPunct(previous, ".");
    if (shellKey && (isPunct(previous, "{") || isPunct(previous, ","))) {
      if (isPunct(next, ":")) {
        const value = tokens[index + 2];
        const after = tokens[index + 3];
        const ends = isPunct(after, ",") || isPunct(after, "}");
        const falsy = ends && ((value?.type === "name" || value?.type === "number") && FALSY_LITERALS.has(value.value) || (value?.type === "string" && value.value === ""));
        if (!falsy) say("shell", token.line, "a shell option other than false is forbidden: pass the program and its arguments, and no shell reads them.");
      } else if (isName(token) && (isPunct(next, ",") || isPunct(next, "}")) && !inPattern(tokens, index)) {
        say("shell", token.line, "a shell option whose value cannot be read here is forbidden: write shell: false, or leave it out.");
      }
    }
  }
  return findings;
}
