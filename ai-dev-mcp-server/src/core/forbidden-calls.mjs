/**
 * The calls AGENTS.md forbids, found by what the code does rather than how it
 * happens to be spelled.
 *
 * The static gate used to look for the usual spellings — `eval(`, `shell: true`,
 * `import { exec } from "node:child_process"` — and every equivalent spelling
 * passed it: `import * as cp` then `cp.exec(…)`, `execSync(…)`, `{ "shell": true }`,
 * `{ shell: "/bin/sh" }`, `globalThis["ev" + "al"](…)` (docs/DEFECTS.md, Д-267).
 * So the source is read as tokens — comments, strings, template text and
 * regular-expression literals set aside, every escape in strings and names
 * decoded, a template with no substitution read as the string it is — and the
 * rules are asked of those:
 *
 * - `eval` in any role but a key or a method of an object literal
 *   (`{ eval: true }` is a Worker option);
 * - the `Function` constructor, called — through `.call`, `.apply` or `.bind`
 *   too — or handed on, a global's `.Function`, and a call of a `.constructor`
 *   member (`({}).constructor.constructor("…")` is `Function`);
 * - a computed member of `globalThis`, `window`, `global` or `self` — or of a
 *   name one of them is bound to — unless the key is one plain string that
 *   names neither of the two, whether it is read (`globalThis[k]`) or taken
 *   out by a pattern (`const { [k]: f } = globalThis`);
 * - `exec` or `execSync` of `child_process`, through a named, default or
 *   namespace import, `require` or `import()`, its `default`, a `.then`
 *   callback, a rest element, and any name the module object is bound or
 *   plainly re-bound to (`const c2 = cp`, `cp ??= await import(…)`); and the
 *   module object handed to another file — `export *`, `export { default }`,
 *   `module.exports =`, `export default` — whose `exec` would come from here;
 * - a `shell` option with any value but `false`, `null`, `undefined`, `0` or
 *   an empty string — as a key of an object literal, computed or not, or set
 *   on a member with `=`, `??=`, `||=` or `&&=` — and a `shell` shorthand,
 *   whose value nobody can see. A `shell` that is not an option is left alone:
 *   an import, a parameter, a destructuring pattern, an argument (Д-382, Д-398).
 *
 * It is a reader, not a parser. It follows the module object and the global
 * objects through plain re-binding, and nothing else through anything: a
 * module name built from parts, `createRequire`, `Reflect.get`, `require`
 * itself re-bound, a key held in a variable are past it. Code written that way
 * is not written by accident, and keeping honest code honest is what this gate
 * is for. A computed member of a global it cannot read is refused rather than
 * trusted, and so is a file it could not read to its end — a template literal
 * or a comment that never closes, where whatever follows would go unchecked.
 */

const MODULE_NAMES = new Set(["child_process", "node:child_process"]);
const FORBIDDEN_MEMBERS = new Set(["exec", "execSync"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "global", "self"]);
const FALSY_LITERALS = new Set(["false", "null", "undefined", "0"]);
// After these a `/` starts a regular expression, not a division — unless the word is a property: `stats.in / 2`.
const KEYWORDS_BEFORE_EXPRESSION = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "default"
]);
// A `(` after these opens a statement's head, and a `/` after its `)` starts a regular expression: `if (x) /re/.test(s)`.
const HEAD_KEYWORDS = new Set(["if", "while", "for", "with"]);
// Before these a `{` opens an object literal rather than a block, a class body or a clause.
const OBJECT_AFTER_PUNCT = new Set(["=", "(", ",", ":", "[", "?", "|", "&", "!", "...", "+", "-", "*", "%", "~", "^"]);
const OBJECT_AFTER_NAME = new Set(["return", "yield", "await", "case", "default", "typeof", "void", "new", "throw"]);
const SIMPLE_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };
const NAME_START = /[A-Za-z_$\u0080-\uffff]/;
const NAME_PART = /[A-Za-z0-9_$\u0080-\uffff]/;
// JavaScript ends a line, and a `//` comment, at any of these.
const LINE_END = /[\n\r\u2028\u2029]/g;
const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029]/g;
const BRACED_CODE_POINT = /\{([0-9a-fA-F]+)\}/y;
const OCTAL_ESCAPE = /[0-3][0-7]{0,2}|[4-7][0-7]?/y;

const isLineEnd = (character) => character === "\n" || character === "\r" || character === "\u2028" || character === "\u2029";
const lineBreaks = (text) => text.match(LINE_BREAKS)?.length ?? 0;

/**
 * The escape after a backslash at `at` (the character after it): what it
 * stands for, where the source goes on, and the newlines it spans.
 */
function readEscape(text, at) {
  const character = text[at];
  if (character === "x") {
    const code = Number.parseInt(text.slice(at + 1, at + 3), 16);
    return Number.isNaN(code) ? ["x", at + 1, 0] : [String.fromCharCode(code), at + 3, 0];
  }
  if (character === "u") {
    BRACED_CODE_POINT.lastIndex = at + 1;
    const braced = BRACED_CODE_POINT.exec(text);
    if (braced) {
      const point = Number.parseInt(braced[1], 16);
      return [point <= 0x10ffff ? String.fromCodePoint(point) : "", at + 1 + braced[0].length, 0];
    }
    const code = Number.parseInt(text.slice(at + 1, at + 5), 16);
    return /^[0-9a-fA-F]{4}$/.test(text.slice(at + 1, at + 5)) ? [String.fromCharCode(code), at + 5, 0] : ["u", at + 1, 0];
  }
  // A legacy octal escape, which a file that is not strict may still write: `\137` is `_`, `\0` is NUL.
  if (character >= "0" && character <= "7") {
    OCTAL_ESCAPE.lastIndex = at;
    const digits = OCTAL_ESCAPE.exec(text)[0];
    return [String.fromCharCode(Number.parseInt(digits, 8)), at + digits.length, 0];
  }
  // A line continuation stands for nothing.
  if (character === "\r") return ["", text[at + 1] === "\n" ? at + 2 : at + 1, 1];
  if (isLineEnd(character)) return ["", at + 1, 1];
  return [SIMPLE_ESCAPES[character] ?? character ?? "", at + 1, 0];
}

/**
 * The tokens of a JavaScript source: `{ type, value, line }` with type
 * `name` (escapes decoded), `string` (the decoded text; a template literal with
 * no substitution is one), `number`, `punct`, `regex` (one per literal, its
 * text left out), or `template` (one per template literal that has
 * substitutions; the code in its `${…}` is tokenised in place). Comments leave
 * nothing, and `?.` before `[` or `(` leaves nothing either: `a?.[b]` is read
 * as `a[b]`, whatever space or comment lies between.
 *
 * A `/` is a regular expression where an expression begins, and a division
 * after an operand: after a word that is a property (`stats.in / 2`), a
 * postfix `++`, a call's `)` or an object literal's `}` it divides; after a
 * statement head's `)` (`if (x) /re/`) or a block's `}` it does not. One that
 * does not close on its line divides.
 *
 * When a template literal, a substitution or a comment never closes, the
 * array's `unterminated` property is the line it opened on: whatever follows
 * it was read as part of it.
 *
 * @param {string} source
 * @returns {Array<{ type: string, value: string, line: number }> & { unterminated?: number }}
 */
export function codeTokens(source) {
  const text = String(source ?? "");
  const tokens = [];
  let at = 0;
  if (text.startsWith("#!")) {
    LINE_END.lastIndex = 0;
    at = LINE_END.exec(text)?.index ?? text.length;
  }
  let line = 1;
  // Inside a template's `${…}`: how many braces of code are open in each, and the line each template opened on.
  const templates = [];
  // The brackets open now: for each, whether a `/` after its closing bracket starts a regular expression.
  const opened = [];
  // Just inside a `${`: an expression begins there, so a `/` begins a regular expression.
  let substitutionOpened = false;
  // Just after `?.`: it stands for `.` unless a `[` or a `(` comes next.
  let optional = false;
  const regexAfterClosing = (value) => {
    const last = tokens.at(-1);
    if (value === "(") {
      const property = isPunct(tokens.at(-2), ".");
      return isName(last) && !property && (HEAD_KEYWORDS.has(last.value) || (last.value === "await" && isName(tokens.at(-2), "for")));
    }
    if (value === "{") return !(last?.type === "punct" ? OBJECT_AFTER_PUNCT.has(last.value) : isName(last) && OBJECT_AFTER_NAME.has(last.value));
    return false;
  };
  const push = (type, value, where = line) => {
    substitutionOpened = false;
    if (optional) {
      optional = false;
      if (!(type === "punct" && (value === "[" || value === "("))) tokens.push({ type: "punct", value: ".", line: where });
    }
    const token = { type, value, line: where };
    if (type === "punct" && (value === "(" || value === "[" || value === "{")) opened.push(regexAfterClosing(value));
    else if (type === "punct" && (value === ")" || value === "]" || value === "}")) token.regexAfter = opened.pop() === true;
    tokens.push(token);
  };
  const unterminated = (where) => {
    tokens.unterminated ??= where;
  };
  // `x++ / 2`: a postfix increment or decrement ends its operand.
  const endsOperand = (token) => token?.type === "number" || token?.type === "string" || token?.type === "regex"
    || (isName(token) && !KEYWORDS_BEFORE_EXPRESSION.has(token.value)) || isPunct(token, ")") || isPunct(token, "]");
  const regexAllowed = () => {
    if (substitutionOpened) return true;
    const last = tokens.at(-1);
    if (!last) return true;
    if (last.type === "name") return KEYWORDS_BEFORE_EXPRESSION.has(last.value) && !isPunct(tokens.at(-2), ".");
    if (last.type !== "punct") return false;
    if (last.value === ")" || last.value === "]" || last.value === "}") return last.regexAfter === true;
    if ((last.value === "+" || last.value === "-") && isPunct(tokens.at(-2), last.value) && endsOperand(tokens.at(-3))) return false;
    return true;
  };
  const readTemplateText = () => {
    // From just after a backtick or a `}` closing a substitution, to the next `${` or the closing backtick.
    let cooked = "";
    while (at < text.length) {
      const character = text[at];
      if (character === "\\") {
        const [value, next, newlines] = readEscape(text, at + 1);
        cooked += value;
        line += newlines;
        at = next;
        continue;
      }
      if (isLineEnd(character) && !(character === "\r" && text[at + 1] === "\n")) line += 1;
      if (character === "`") {
        at += 1;
        return { cooked, ended: "end" };
      }
      if (character === "$" && text[at + 1] === "{") {
        at += 2;
        return { cooked, ended: "code" };
      }
      cooked += character;
      at += 1;
    }
    return { cooked, ended: "eof" };
  };
  while (at < text.length) {
    const character = text[at];
    if (isLineEnd(character)) {
      if (!(character === "\r" && text[at + 1] === "\n")) line += 1;
      at += 1;
      continue;
    }
    if (/\s/.test(character)) { at += 1; continue; }
    if (character === "/" && text[at + 1] === "/") {
      LINE_END.lastIndex = at;
      at = LINE_END.exec(text)?.index ?? text.length;
      continue;
    }
    if (character === "/" && text[at + 1] === "*") {
      const end = text.indexOf("*/", at + 2);
      if (end < 0) unterminated(line);
      const stop = end < 0 ? text.length : end + 2;
      line += lineBreaks(text.slice(at, stop));
      at = stop;
      continue;
    }
    if (character === "'" || character === "\"") {
      const started = line;
      let value = "";
      for (at += 1; at < text.length && text[at] !== character; ) {
        if (text[at] === "\\") {
          const [decoded, next, newlines] = readEscape(text, at + 1);
          value += decoded;
          line += newlines;
          at = next;
          continue;
        }
        // An unterminated string ends at its line; the line break is the main loop's to count.
        if (text[at] === "\n" || text[at] === "\r") break;
        value += text[at];
        at += 1;
      }
      if (text[at] === character) at += 1;
      push("string", value, started);
      continue;
    }
    if (character === "`") {
      const started = line;
      at += 1;
      const { cooked, ended } = readTemplateText();
      if (ended === "end") push("string", cooked, started);
      else {
        push("template", "`", started);
        if (ended === "code") {
          templates.push({ depth: 0, line: started });
          substitutionOpened = true;
        } else unterminated(started);
      }
      continue;
    }
    if (character === "}" && templates.length && templates.at(-1).depth === 0) {
      const { line: started } = templates.pop();
      at += 1;
      const { ended } = readTemplateText();
      if (ended === "code") {
        templates.push({ depth: 0, line: started });
        substitutionOpened = true;
      } else if (ended === "eof") unterminated(started);
      continue;
    }
    if (character === "/" && regexAllowed()) {
      const slash = at;
      let inClass = false;
      for (at += 1; at < text.length; at += 1) {
        const inside = text[at];
        if (inside === "\\" && !isLineEnd(text[at + 1] ?? "\n")) { at += 1; continue; }
        if (isLineEnd(inside)) break;
        if (inside === "[") inClass = true;
        else if (inside === "]") inClass = false;
        else if (inside === "/" && !inClass) break;
      }
      if (text[at] !== "/") {
        // A regular expression never spans a line: this slash divides, and what follows it is read as code.
        at = slash + 1;
        push("punct", "/");
        continue;
      }
      at += 1;
      while (at < text.length && /[A-Za-z]/.test(text[at])) at += 1;
      push("regex", "/");
      continue;
    }
    if (NAME_START.test(character) || (character === "\\" && text[at + 1] === "u")) {
      // A name, its escapes decoded: `eval` is `eval` (Д-382).
      let value = "";
      while (at < text.length) {
        if (text[at] === "\\" && text[at + 1] === "u") {
          const [decoded, next] = readEscape(text, at + 1);
          value += decoded;
          at = next;
        } else if (NAME_PART.test(text[at])) {
          value += text[at];
          at += 1;
        } else break;
      }
      push("name", value);
      continue;
    }
    if (/[0-9]/.test(character) || (character === "." && /[0-9]/.test(text[at + 1] ?? ""))) {
      const match = /^(?:0[xXoObB][0-9a-fA-F_]+n?|[0-9_]*\.?[0-9_]*(?:[eE][+-]?[0-9_]+)?n?)/.exec(text.slice(at, at + 128));
      push("number", match[0] || character);
      at += Math.max(1, match[0].length);
      continue;
    }
    if (character === "?" && text[at + 1] === "." && !/[0-9]/.test(text[at + 2] ?? "")) {
      at += 2;
      optional = true;
      continue;
    }
    if (character === "." && text.startsWith("...", at)) {
      push("punct", "...");
      at += 3;
      continue;
    }
    if (templates.length) {
      if (character === "{") templates.at(-1).depth += 1;
      if (character === "}") templates.at(-1).depth -= 1;
    }
    push("punct", character);
    at += 1;
  }
  if (templates.length) unterminated(templates[0].line);
  return tokens;
}

// The bracket pairs of a token array, worked out once (a search per question made the gate quadratic, Д-401).
const BRACKETS = new WeakMap();
function brackets(tokens) {
  let found = BRACKETS.get(tokens);
  if (found) return found;
  // `pair`: the other bracket of a pair; `holder`: the innermost bracket open at a token (for a closing one, its own).
  found = { pair: new Int32Array(tokens.length).fill(-1), holder: new Int32Array(tokens.length).fill(-1) };
  const open = [];
  const kinds = { ")": "(", "]": "[", "}": "{" };
  tokens.forEach((token, index) => {
    found.holder[index] = open.length ? open.at(-1) : -1;
    if (token.type !== "punct") return;
    if (token.value === "(" || token.value === "[" || token.value === "{") open.push(index);
    else if (kinds[token.value]) {
      // A closing bracket with no opening one of its kind (code that does not parse) pairs with nothing.
      const at = open.findLastIndex((start) => tokens[start].value === kinds[token.value]);
      if (at < 0) return;
      found.pair[open[at]] = index;
      found.pair[index] = open[at];
      open.length = at;
    }
  });
  BRACKETS.set(tokens, found);
  return found;
}

const isOpening = (token) => token?.type === "punct" && (token.value === "(" || token.value === "[" || token.value === "{");
/** The index of the token that closes the bracket opened at `open`, or -1. */
const closing = (tokens, open) => (isOpening(tokens[open]) ? brackets(tokens).pair[open] : -1);
/** The index of the token that opened the bracket closed at `close`, or -1. */
const opening = (tokens, close) => (tokens[close]?.type === "punct" && !isOpening(tokens[close]) && close >= 0 ? brackets(tokens).pair[close] : -1);
/** The index of the innermost `(`, `[` or `{` that holds the token at `index`, or -1. */
const enclosing = (tokens, index) => (index >= 0 && index < tokens.length ? brackets(tokens).holder[index] : -1);

const isPunct = (token, value) => token?.type === "punct" && token.value === value;
const isName = (token, value) => token?.type === "name" && (value === undefined || token.value === value);
const isModuleString = (token) => token?.type === "string" && MODULE_NAMES.has(token.value);
// `=` that assigns: not `==`, `===` or `=>`.
const assigns = (tokens, index) => isPunct(tokens[index], "=") && !isPunct(tokens[index + 1], "=") && !isPunct(tokens[index + 1], ">")
  && !["=", "!", "<", ">"].some((value) => isPunct(tokens[index - 1], value));
// `??=`, `||=` and `&&=` end in the `=` at `index`.
const logicalAssignment = (tokens, index) => ["?", "|", "&"].some((value) => isPunct(tokens[index - 1], value) && isPunct(tokens[index - 2], value));
/** The `=` of an assignment operator that begins at `index` — `=`, `??=`, `||=`, `&&=` — or -1. */
const assignmentAt = (tokens, index) => {
  if (assigns(tokens, index)) return index;
  return assigns(tokens, index + 2) && logicalAssignment(tokens, index + 2) ? index + 2 : -1;
};
/** What an assignment whose `=` is at `index` assigns to: the index of its last token. */
const assignedAt = (tokens, index) => (logicalAssignment(tokens, index) ? index - 3 : index - 1);

/**
 * Whether the `{` or `[` at `open` begins a destructuring pattern: assigned
 * to, iterated over, or a parameter — itself, or as part of one. A literal
 * that is a default value (`options = { … }`) or what is iterated
 * (`of [{ … }]`) is a value, not a pattern.
 */
function isPattern(tokens, open) {
  for (let at = open; ;) {
    const end = closing(tokens, at);
    if (end < 0) return false;
    if (assigns(tokens, end + 1) || isName(tokens[end + 1], "of") || isName(tokens[end + 1], "in")) return true;
    if (assigns(tokens, at - 1) || isName(tokens[at - 1], "of") || isName(tokens[at - 1], "in")) return false;
    const outer = enclosing(tokens, at);
    if (outer < 0) return false;
    if (isPunct(tokens[outer], "(")) {
      // `class A extends make({ … }) {}` calls `make`; a parameter list is followed by its body.
      if (isName(tokens[outer - 2], "extends")) return false;
      const shut = closing(tokens, outer);
      return isPunct(tokens[shut + 1], "{") || (isPunct(tokens[shut + 1], "=") && isPunct(tokens[shut + 2], ">"));
    }
    at = outer;
  }
}

/** Whether the token at `index` is a key or a shorthand of an object literal — not a block, a pattern or an import. */
function inObjectLiteral(tokens, index) {
  const open = enclosing(tokens, index);
  if (open < 0 || !isPunct(tokens[open], "{")) return false;
  const before = tokens[open - 1];
  // After `)`, `=>`, `else` or a `;` it is a block; after `import` or `const` a clause or a pattern.
  const literal = before?.type === "punct" ? OBJECT_AFTER_PUNCT.has(before.value) : isName(before) && OBJECT_AFTER_NAME.has(before.value);
  if (!literal) return false;
  // `import React, { shell } from "electron"`, `export { shell } from …`.
  if (isName(tokens[closing(tokens, open) + 1], "from")) return false;
  return !isPattern(tokens, open);
}

/**
 * Whether the value at `index` is plainly off: a falsy literal that the
 * expression ends with. A line break ends it only where the next line cannot
 * carry the expression on — `false⏎ || "/bin/sh"` is one value (Д-399).
 */
function plainlyOff(tokens, index) {
  const value = tokens[index];
  const after = tokens[index + 1];
  const carriesOn = after?.type === "punct" ? !["{", "}", ")", "]", ";", ","].includes(after.value)
    : after?.type === "template" || isName(after, "in") || isName(after, "instanceof");
  const ends = !after || isPunct(after, ",") || isPunct(after, "}") || isPunct(after, ";") || isPunct(after, ")") || (after.line > value.line && !carriesOn);
  return ends && (((value?.type === "name" || value?.type === "number") && FALSY_LITERALS.has(value.value)) || (value?.type === "string" && value.value === ""));
}

/**
 * Where the child_process module is reached in these tokens: a `require(…)` or
 * `import(…)` call (`start`, `end`), or a static import's or export's clause.
 */
function moduleReaches(tokens) {
  const reaches = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    // `require("child_process")`, `import("node:child_process", { … })`, a trailing comma and all.
    if ((isName(token, "require") || isName(token, "import")) && isPunct(tokens[index + 1], "(") && isModuleString(tokens[index + 2])
      && (isPunct(tokens[index + 3], ")") || isPunct(tokens[index + 3], ","))) {
      const shut = closing(tokens, index + 1);
      if (shut < 0) continue;
      // `module.require(…)` is the module too: the value begins at the head of its chain.
      let start = index;
      while (token.value === "require" && isPunct(tokens[start - 1], ".") && isName(tokens[start - 2])) start -= 2;
      reaches.push({ kind: token.value, start, end: shut + 1, line: token.line });
      index = shut;
      continue;
    }
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
  const globals = new Set(GLOBAL_OBJECTS);
  const childProcessFinding = (line, what) => say("child_process.exec", line, `child_process ${what} is forbidden; use argv-based execution (spawn, spawnSync, execFile, execFileSync).`);

  if (tokens.unterminated) {
    say("unread", tokens.unterminated, `this file could not be read past line ${tokens.unterminated}: a template literal, a substitution or a comment there never ends, so whatever follows would go unchecked.`);
  }

  // A `(` that calls what stands before it — `f(x)` — rather than holding a value: `(cp)`, `return (cp)`.
  const calls = (open) => {
    const before = tokens[open - 1];
    return (isName(before) && !KEYWORDS_BEFORE_EXPRESSION.has(before.value) && !HEAD_KEYWORDS.has(before.value)) || isPunct(before, ")") || isPunct(before, "]");
  };
  // The value from `start` up to `end`, widened over what leaves it the same value — parentheses around it or around a
  // list it ends (`(cp)`, `(0, globalThis)`), and an `await` before it: `[start, end)` of the whole.
  const widen = (start, end) => {
    for (;;) {
      const open = opening(tokens, end);
      if (isPunct(tokens[end], ")") && open >= 0 && !calls(open) && (open === start - 1 || isPunct(tokens[start - 1], ",")) && enclosing(tokens, start) === open) {
        start = open;
        end += 1;
      } else if (isName(tokens[start - 1], "await")) start -= 1;
      else return [start, end];
    }
  };
  // Past the module's own `default`: `ns.default`, `ns["default"]`, as often as it is written.
  const pastDefault = (index) => {
    let at = index;
    for (;;) {
      if (isPunct(tokens[at], ".") && isName(tokens[at + 1], "default")) at += 2;
      else if (isPunct(tokens[at], "[") && tokens[at + 1]?.type === "string" && tokens[at + 1].value === "default" && isPunct(tokens[at + 2], "]")) at += 3;
      else return at;
    }
  };
  // `<module>.exec` / `<module>["exec"]` / a computed member that cannot be read.
  const execMember = (index) => {
    if (isPunct(tokens[index], ".") && isName(tokens[index + 1]) && FORBIDDEN_MEMBERS.has(tokens[index + 1].value)) return tokens[index + 1].value;
    if (isPunct(tokens[index], "[")) {
      const end = closing(tokens, index);
      const inside = tokens.slice(index + 1, end);
      if (inside.length === 1 && inside[0].type === "string") return FORBIDDEN_MEMBERS.has(inside[0].value) ? inside[0].value : null;
      return "a computed member";
    }
    return null;
  };
  const memberFinding = (index, name) => {
    const member = execMember(index);
    if (member) childProcessFinding(tokens[index].line, member === "a computed member" ? `${member}${name ? ` (of ${name})` : ""}` : `${member} (${name ? `${name}.${member}` : "a member of the module"})`);
  };
  // The first token of each entry of the pattern or literal opened at `open`.
  const entries = (open) => {
    const starts = [];
    const end = closing(tokens, open);
    for (let at = open + 1; at < end; at += 1) {
      starts.push(at);
      while (at < end && !isPunct(tokens[at], ",")) {
        const shut = closing(tokens, at);
        at = shut > at ? shut + 1 : at + 1;
      }
    }
    return starts;
  };
  // `{ exec, default: cp, ...rest, [key]: x } = <module>`: what each entry takes out of it, nested `default`s and all.
  const modulePattern = (open) => {
    for (const pending = [open]; pending.length; ) {
      for (const index of entries(pending.pop())) {
        const first = tokens[index];
        if (isPunct(first, "...") && isName(tokens[index + 1])) aliases.add(tokens[index + 1].value);
        else if (isPunct(first, "[")) {
          const inside = tokens.slice(index + 1, closing(tokens, index));
          const key = inside.length === 1 && inside[0].type === "string" ? inside[0].value : null;
          if (key === null || FORBIDDEN_MEMBERS.has(key)) childProcessFinding(first.line, key ?? "a computed member");
        } else if (first && (first.type === "name" || first.type === "string")) {
          if (FORBIDDEN_MEMBERS.has(first.value)) childProcessFinding(first.line, first.value);
          if (first.value === "default" && isPunct(tokens[index + 1], ":")) {
            const binding = tokens[index + 2];
            if (isName(binding)) aliases.add(binding.value);
            else if (isPunct(binding, "{")) pending.push(index + 2);
          }
        }
      }
    }
  };
  // The parameter of `.then(…)` at `index` (just inside its parenthesis): what the callback calls the module.
  const thenParameter = (index) => {
    let at = index;
    if (isName(tokens[at], "async")) at += 1;
    if (isName(tokens[at], "function")) {
      at += 1;
      if (isName(tokens[at])) at += 1;
    }
    if (isPunct(tokens[at], "(")) at += 1;
    if (isPunct(tokens[at], "{")) modulePattern(at);
    else if (isName(tokens[at])) aliases.add(tokens[at].value);
  };
  // Where the module object standing at `start` goes: bound to a name, taken apart by a pattern, or handed to
  // another file — `module.exports = …`, `exports.x = …`, `export default …`.
  const handedOn = (start, what) => {
    if (isPunct(tokens[start - 1], "...")) {
      childProcessFinding(tokens[start].line, `${what} (spread: its exec goes with it)`);
      return;
    }
    if (isName(tokens[start - 1], "default") && isName(tokens[start - 2], "export")) {
      childProcessFinding(tokens[start].line, `${what} (exported as default)`);
      return;
    }
    if (!assigns(tokens, start - 1)) return;
    const target = assignedAt(tokens, start - 1);
    let head = target;
    while (isPunct(tokens[head - 1], ".") && isName(tokens[head - 2])) head -= 2;
    if (isName(tokens[head], "exports") || (isName(tokens[head], "module") && isName(tokens[head + 2], "exports"))) {
      childProcessFinding(tokens[target].line, `${what} (exported from this file)`);
    } else if (isName(tokens[target])) aliases.add(tokens[target].value);
    else if (isPunct(tokens[target], "}")) modulePattern(opening(tokens, target));
  };

  for (const reach of moduleReaches(tokens)) {
    if (reach.kind === "static") {
      // import x, * as y, { a, b as c, default as d } from "child_process"; export { … }, export * from it.
      const exported = isName(tokens[reach.start], "export");
      const [from, to] = reach.clause;
      for (let index = from; index < to; index += 1) {
        const token = tokens[index];
        if (isPunct(token, "{")) {
          const end = closing(tokens, index);
          for (let inner = index + 1; inner < end; inner += 1) {
            const name = tokens[inner];
            const previous = tokens[inner - 1];
            if (!(name.type === "name" || name.type === "string") || !(isPunct(previous, "{") || isPunct(previous, ","))) continue;
            if (FORBIDDEN_MEMBERS.has(name.value)) childProcessFinding(name.line, `${name.value} (${exported ? "exported" : "imported"} by name)`);
            else if (name.value === "default" && exported) childProcessFinding(name.line, "default, the module itself (exported by name)");
            else if (name.value === "default" && isName(tokens[inner + 1], "as") && isName(tokens[inner + 2])) aliases.add(tokens[inner + 2].value);
          }
          index = end;
        } else if (isPunct(token, "*") && exported) {
          childProcessFinding(token.line, "as a whole (export * from it)");
          index = to;
        } else if (isPunct(token, "*") && isName(tokens[index + 1], "as") && isName(tokens[index + 2])) {
          aliases.add(tokens[index + 2].value);
          index += 2;
        } else if (!exported && isName(token) && token.value !== "type" && (isPunct(tokens[index + 1], ",") || index + 1 === to)) {
          aliases.add(token.value);
        }
      }
      continue;
    }
    // The module object as a value: in as many parentheses as it is written in, awaited or not, and past its `default`.
    let [start, end] = widen(reach.start, reach.end);
    end = pastDefault(end);
    memberFinding(end, "");
    if (isPunct(tokens[end], ".") && isName(tokens[end + 1], "then") && isPunct(tokens[end + 2], "(")) thenParameter(end + 3);
    else if (!isPunct(tokens[end], ".") && !isPunct(tokens[end], "[") && !isPunct(tokens[end], "(")) handedOn(start, "the module object");
  }

  // A plain re-binding hands the name on — `const c2 = cp`, `c2 ??= (cp)`, `const cp = ns.default`,
  // `const m = await loading`, `const g = global.globalThis` — however long the chain, in any order (Д-401).
  const boundTo = new Map();
  for (let index = 2; index < tokens.length; index += 1) {
    if (!assigns(tokens, index)) continue;
    const target = assignedAt(tokens, index);
    if (!isName(tokens[target]) || isPunct(tokens[target - 1], ".")) continue;
    let at = index + 1;
    if (isName(tokens[at], "await")) at += 1;
    let depth = 0;
    for (; isPunct(tokens[at], "("); at += 1) depth += 1;
    if (!isName(tokens[at])) continue;
    let end = at + 1;
    for (;;) {
      const member = tokens[end + 1];
      if (isPunct(tokens[end], ".") && isName(member) && (member.value === "default" || GLOBAL_OBJECTS.has(member.value))) end += 2;
      else if (isPunct(tokens[end], "[") && member?.type === "string" && member.value === "default" && isPunct(tokens[end + 2], "]")) end += 3;
      else break;
    }
    for (; depth > 0 && isPunct(tokens[end], ")"); depth -= 1) end += 1;
    const after = tokens[end];
    if (depth > 0 || (after && !isPunct(after, ";") && !isPunct(after, ",") && !isPunct(after, ")") && !isPunct(after, "}") && after.line === tokens[end - 1].line)) continue;
    if (!boundTo.has(tokens[at].value)) boundTo.set(tokens[at].value, []);
    boundTo.get(tokens[at].value).push(tokens[target].value);
  }
  for (const known of [aliases, globals]) {
    for (const queue = [...known]; queue.length; ) {
      for (const name of boundTo.get(queue.pop()) ?? []) {
        if (!known.has(name)) {
          known.add(name);
          queue.push(name);
        }
      }
    }
  }
  // A global, or a global's own name for itself: `globalThis`, `global.globalThis`, `g` after `const g = globalThis` —
  // worked out once, front to back, so a long chain costs one step a link.
  const globalAt = new Uint8Array(tokens.length);
  tokens.forEach((token, index) => {
    globalAt[index] = isName(token) && globals.has(token.value) && (!isPunct(tokens[index - 1], ".") || globalAt[index - 2] === 1) ? 1 : 0;
  });
  const isGlobal = (index) => globalAt[index] === 1;
  // An object literal's own key or method — `{ eval: true }` (a Worker option), `{ eval() {} }` — which names nothing global.
  const ownKey = (index) => {
    const next = tokens[index + 1];
    const method = isPunct(next, "(") && isPunct(tokens[closing(tokens, index + 1) + 1], "{");
    return (isPunct(next, ":") || method) && (isPunct(tokens[index - 1], "{") || isPunct(tokens[index - 1], ",")) && inObjectLiteral(tokens, index);
  };
  // `.call`, `.apply` or `.bind` called on it straight away: `Function.call(null, "…")` — not `Function.call.bind(…)`.
  const throughCall = (index) => isPunct(tokens[index], ".") && ["call", "apply", "bind"].includes(tokens[index + 1]?.value) && isPunct(tokens[index + 2], "(");
  // What stands at `index` is called: `(…)`, a tagged template, or `.call`/`.apply`/`.bind`.
  const called = (index) => isPunct(tokens[index], "(") || tokens[index]?.type === "string" || tokens[index]?.type === "template" || throughCall(index);
  // `Function.constructor` and `Function.prototype.constructor` are `Function`: the index of that `constructor`, or -1.
  const functionConstructor = (index) => {
    const at = isPunct(tokens[index + 1], ".") && isName(tokens[index + 2], "prototype") ? index + 2 : index;
    return isPunct(tokens[at + 1], ".") && isName(tokens[at + 2], "constructor") ? at + 2 : -1;
  };
  // The key in the brackets at `open` of a global's member: refused unless one plain string that names neither of the two.
  const globalMember = (open, token, { named = true } = {}) => {
    const inside = tokens.slice(open + 1, closing(tokens, open));
    const plain = inside.length === 1 && inside[0].type === "string";
    if (!plain || (named && !allowEval && ["eval", "Function"].includes(inside[0].value))) {
      say("global-member", token.line, `a computed member of ${token.value} is forbidden unless its key is one plain string: it can reach eval or Function under any spelling.`);
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    // A name bound to the module: its exec members, its `.then`, a pattern taking them out, or the module handed on.
    if (isName(token) && aliases.has(token.value) && !isPunct(previous, ".")) {
      const [start, end] = widen(index, index + 1);
      const member = pastDefault(end);
      memberFinding(member, token.value);
      if (isPunct(tokens[member], ".") && isName(tokens[member + 1], "then") && isPunct(tokens[member + 2], "(")) thenParameter(member + 3);
      else if (!isPunct(tokens[member], ".") && !isPunct(tokens[member], "[") && !isPunct(tokens[member], "(")) {
        handedOn(start, token.value);
        const holder = enclosing(tokens, index);
        if (isName(tokens[holder - 1], "export") && (isPunct(previous, "{") || isPunct(previous, ","))) childProcessFinding(token.line, `${token.value} (exported by name)`);
      }
    }
    if (!allowEval && isName(token, "eval") && !ownKey(index)) say("eval", token.line, "eval is forbidden, called or handed on.");
    const viaConstructor = isName(token, "Function") ? functionConstructor(index) : -1;
    const reached = viaConstructor < 0 ? !isPunct(next, ".") || throughCall(index + 1) : !isPunct(tokens[viaConstructor + 1], ".") || throughCall(viaConstructor + 1);
    if (!allowEval && isName(token, "Function") && reached && !isName(previous, "instanceof")
      && (!isPunct(previous, ".") || isGlobal(index - 2)) && !ownKey(index)) {
      say("Function", token.line, "the Function constructor is forbidden, called or handed on.");
    }
    // `x.constructor(…)`, `x["constructor"](…)`, a tagged template on it: ({}).constructor.constructor is Function.
    const constructorKey = isPunct(token, "[") && tokens[index + 1]?.type === "string" && tokens[index + 1].value === "constructor" && isPunct(tokens[index + 2], "]");
    if (!allowEval && ((isName(token, "constructor") && isPunct(previous, ".") && called(index + 1)) || (constructorKey && called(index + 3)))) {
      say("Function", token.line, "calling a .constructor member is forbidden: ({}).constructor.constructor is the Function constructor.");
    }
    // A quoted or computed key that takes eval or Function out of something: `const { "eval": run } = globalThis`.
    if (!allowEval && token.type === "string" && (token.value === "eval" || token.value === "Function")) {
      const key = isPunct(previous, "[") && isPunct(next, "]") ? index - 1 : index;
      if (isPunct(tokens[key === index ? index + 1 : index + 2], ":") && (isPunct(tokens[key - 1], "{") || isPunct(tokens[key - 1], ",")) && !inObjectLiteral(tokens, key)) {
        say(token.value, token.line, `${token.value} is forbidden, called or handed on: this pattern takes it out by name.`);
      }
    }
    if (isGlobal(index) && !isGlobal(index + 2)) {
      // `globalThis[…]`, `(globalThis)[…]`, `(global.globalThis)[…]`: the whole chain, in its parentheses.
      let head = index;
      while (isPunct(tokens[head - 1], ".") && isGlobal(head - 2)) head -= 2;
      const [start, end] = widen(head, index + 1);
      if (isPunct(tokens[end], "[")) globalMember(end, token);
      // `const { [key]: f } = globalThis`: a computed member taken out by a pattern.
      else if (assigns(tokens, start - 1) && isPunct(tokens[start - 2], "}") && !isPunct(tokens[end], ".") && !isPunct(tokens[end], "(")) {
        // A plain "eval" or "Function" key there is the quoted-key rule's above.
        for (const entry of entries(opening(tokens, start - 2))) if (isPunct(tokens[entry], "[")) globalMember(entry, token, { named: false });
      }
    }
    // shell: <value> / "shell": <value> / ["shell"]: <value> / { shell } in an object literal, and <member>.shell = <value>.
    const computedShell = isPunct(token, "[") && tokens[index + 1]?.type === "string" && tokens[index + 1].value === "shell" && isPunct(tokens[index + 2], "]");
    const shellName = (isName(token, "shell") || (token.type === "string" && token.value === "shell")) && !isPunct(previous, ".") && !isPunct(previous, "[");
    // `{ get shell() {…} }`, `{ async shell() {} }`: an accessor or a method gives the option a value nobody can read.
    const accessor = ["get", "set", "async"].some((word) => isName(previous, word)) && (isPunct(tokens[index - 2], "{") || isPunct(tokens[index - 2], ","));
    if ((shellName || computedShell) && (isPunct(previous, "{") || isPunct(previous, ",") || accessor) && inObjectLiteral(tokens, index)) {
      const colon = computedShell ? index + 3 : index + 1;
      if (isPunct(tokens[colon], ":") && !accessor) {
        if (!plainlyOff(tokens, colon + 1)) say("shell", token.line, "a shell option other than false is forbidden: pass the program and its arguments, and no shell reads them.");
      } else if (isPunct(tokens[colon], "(") || (isName(token) && (isPunct(next, ",") || isPunct(next, "}")))) {
        say("shell", token.line, "a shell option whose value cannot be read here is forbidden: write shell: false, or leave it out.");
      }
    }
    const member = isName(token, "shell") && isPunct(previous, ".") ? index + 1
      : computedShell && !isPunct(previous, "{") && !isPunct(previous, ",") ? index + 3 : -1;
    const set = member < 0 ? -1 : assignmentAt(tokens, member);
    if (set >= 0 && !plainlyOff(tokens, set + 1)) {
      say("shell", token.line, "setting a shell option other than false is forbidden: pass the program and its arguments, and no shell reads them.");
    }
  }
  return findings;
}
