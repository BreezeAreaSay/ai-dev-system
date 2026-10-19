/**
 * The calls AGENTS.md forbids, found by what the code does rather than how it
 * happens to be spelled.
 *
 * The static gate used to look for the usual spellings — `eval(`, `shell: true`,
 * `import { exec } from "node:child_process"` — and every equivalent spelling
 * passed it: `import * as cp` then `cp.exec(…)`, `execSync(…)`, `{ "shell": true }`,
 * `{ shell: "/bin/sh" }`, `globalThis["ev" + "al"](…)` (docs/DEFECTS.md, Д-267).
 * So the source is read as tokens — comments, strings, template text and
 * regular-expression literals set aside, escapes in strings and names decoded,
 * a template with no substitution read as the string it is — and the rules are
 * asked of those:
 *
 * - `eval` in any role but a key of an object literal (`{ eval: true }` is a
 *   Worker option);
 * - the `Function` constructor, called or handed on, a global's `.Function`,
 *   and a call of a `.constructor` member (`({}).constructor.constructor("…")`
 *   is `Function`);
 * - a computed member of `globalThis`, `window`, `global` or `self` — or of a
 *   name one of them was assigned to — unless the key is one plain string that
 *   names neither of the two;
 * - `exec` or `execSync` of `child_process`, through a named, default or
 *   namespace import, `require` or `import()`, its `default`, a `.then`
 *   callback, a rest element, and any name the module object is bound or
 *   plainly re-bound to (`const c2 = cp`);
 * - a `shell` option with any value but `false`, `null`, `undefined`, `0` or
 *   an empty string — as a key of an object literal, computed or not, or as an
 *   assignment to a member — and a `shell` shorthand, whose value nobody can
 *   see. A `shell` that is not an option is left alone: an import, a parameter,
 *   a destructuring pattern, an argument (Д-382).
 *
 * It is a reader, not a parser, and it does not follow a value through
 * anything but a plain assignment: a module name built from parts,
 * `createRequire`, `Reflect.get`, a key held in a variable read as a name. Code
 * written that way is not written by accident, and keeping honest code honest
 * is what this gate is for. A computed member it cannot read is refused rather
 * than trusted, and so is a file it could not read to its end — a template
 * literal or a comment that never closes, where whatever follows would go
 * unchecked.
 */

const MODULE_NAMES = new Set(["child_process", "node:child_process"]);
const FORBIDDEN_MEMBERS = new Set(["exec", "execSync"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "global", "self"]);
const FALSY_LITERALS = new Set(["false", "null", "undefined", "0"]);
// After these a `/` starts a regular expression, not a division.
const KEYWORDS_BEFORE_EXPRESSION = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"
]);
// Before these a `{` opens an object literal rather than a block, a class body or a clause.
const OBJECT_AFTER_PUNCT = new Set(["=", "(", ",", ":", "[", "?", "|", "&", "!", "...", "+", "-", "*", "%", "~", "^"]);
const OBJECT_AFTER_NAME = new Set(["return", "yield", "await", "case", "default", "typeof", "void", "new", "throw"]);
const SIMPLE_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };
const NAME_START = /[A-Za-z_$\u0080-￿]/;
const NAME_PART = /[A-Za-z0-9_$\u0080-￿]/;

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
    const braced = text[at + 1] === "{" ? /^\{([0-9a-fA-F]{1,6})\}/.exec(text.slice(at + 1, at + 10)) : null;
    if (braced) {
      const point = Number.parseInt(braced[1], 16);
      return [point <= 0x10ffff ? String.fromCodePoint(point) : "", at + 1 + braced[0].length, 0];
    }
    const code = Number.parseInt(text.slice(at + 1, at + 5), 16);
    return /^[0-9a-fA-F]{4}$/.test(text.slice(at + 1, at + 5)) ? [String.fromCharCode(code), at + 5, 0] : ["u", at + 1, 0];
  }
  // A line continuation stands for nothing.
  if (character === "\r") return ["", text[at + 1] === "\n" ? at + 2 : at + 1, 1];
  if (character === "\n" || character === " " || character === " ") return ["", at + 1, 1];
  return [SIMPLE_ESCAPES[character] ?? character ?? "", at + 1, 0];
}

/**
 * The tokens of a JavaScript source: `{ type, value, line }` with type
 * `name` (escapes decoded), `string` (the decoded text; a template literal with
 * no substitution is one), `number`, `punct`, or `template` (one per template
 * literal that has substitutions; the code in its `${…}` is tokenised in
 * place). Comments and regular-expression literals leave nothing, and `?.`
 * before `[` or `(` leaves nothing either: `a?.[b]` is read as `a[b]`.
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
  let at = text.startsWith("#!") ? text.indexOf("\n") : 0;
  if (at < 0) return tokens;
  let line = 1 + (text.slice(0, at).match(/\n/g)?.length ?? 0);
  // Inside a template's `${…}`: how many braces of code are open in each, and the line each template opened on.
  const templates = [];
  // Just inside a `${`: an expression begins there, so a `/` begins a regular expression.
  let substitutionOpened = false;
  const push = (type, value, where = line) => {
    substitutionOpened = false;
    tokens.push({ type, value, line: where });
  };
  const unterminated = (where) => {
    tokens.unterminated ??= where;
  };
  const lineStartsAt = (position) => /^[ \t]*$/.test(text.slice(text.lastIndexOf("\n", position - 1) + 1, position));
  const regexAllowed = (position) => {
    if (substitutionOpened) return true;
    const last = tokens.at(-1);
    if (!last) return true;
    if (last.type === "name") return KEYWORDS_BEFORE_EXPRESSION.has(last.value);
    if (last.type !== "punct") return false;
    // After a block's `}`, a line that begins with `/` begins a statement, so a regular expression (Д-382).
    if (last.value === "}") return lineStartsAt(position);
    return last.value !== ")" && last.value !== "]";
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
      if (character === "\n") line += 1;
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
    if (character === "\n") { line += 1; at += 1; continue; }
    if (/\s/.test(character)) { at += 1; continue; }
    if (character === "/" && text[at + 1] === "/") {
      const end = text.indexOf("\n", at);
      at = end < 0 ? text.length : end;
      continue;
    }
    if (character === "/" && text[at + 1] === "*") {
      const end = text.indexOf("*/", at + 2);
      if (end < 0) unterminated(line);
      const stop = end < 0 ? text.length : end + 2;
      line += text.slice(at, stop).match(/\n/g)?.length ?? 0;
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
        // An unterminated string ends at its line; the newline is the main loop's to count.
        if (text[at] === "\n") break;
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
    if (character === "/" && regexAllowed(at)) {
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
      // `a?.b` is `a.b`; `a?.[b]` and `a?.(b)` are `a[b]` and `a(b)`.
      at += 2;
      while (at < text.length && /[ \t]/.test(text[at])) at += 1;
      if (text[at] !== "[" && text[at] !== "(") push("punct", ".");
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

/** The index of the innermost `(`, `[` or `{` that holds the token at `index`, or -1. */
function enclosing(tokens, index) {
  for (let at = index - 1, depth = 0; at >= 0; at -= 1) {
    const token = tokens[at];
    if (token.type !== "punct") continue;
    if (token.value === ")" || token.value === "]" || token.value === "}") depth += 1;
    else if (token.value === "(" || token.value === "[" || token.value === "{") {
      if (depth === 0) return at;
      depth -= 1;
    }
  }
  return -1;
}

const isPunct = (token, value) => token?.type === "punct" && token.value === value;
const isName = (token, value) => token?.type === "name" && (value === undefined || token.value === value);
const isModuleString = (token) => token?.type === "string" && MODULE_NAMES.has(token.value);
// `=` that assigns: not `==`, `===` or `=>`.
const assigns = (tokens, index) => isPunct(tokens[index], "=") && !isPunct(tokens[index + 1], "=") && !isPunct(tokens[index + 1], ">")
  && !["=", "!", "<", ">"].some((value) => isPunct(tokens[index - 1], value));

/**
 * Whether the `{` or `[` at `open` begins a destructuring pattern: assigned
 * to, iterated over, or a parameter — itself, or as part of one.
 */
function isPattern(tokens, open) {
  for (let at = open; ;) {
    const end = closing(tokens, at);
    if (end < 0) return false;
    if (assigns(tokens, end + 1) || isName(tokens[end + 1], "of") || isName(tokens[end + 1], "in")) return true;
    const outer = enclosing(tokens, at);
    if (outer < 0) return false;
    if (isPunct(tokens[outer], "(")) {
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

/** Whether the value at `index` is plainly off: a falsy literal that the expression ends with. */
function plainlyOff(tokens, index) {
  const value = tokens[index];
  const after = tokens[index + 1];
  const ends = !after || isPunct(after, ",") || isPunct(after, "}") || isPunct(after, ";") || isPunct(after, ")") || after.line > value.line;
  return ends && (((value?.type === "name" || value?.type === "number") && FALSY_LITERALS.has(value.value)) || (value?.type === "string" && value.value === ""));
}

/**
 * Where the child_process module is reached in these tokens: `require(…)` or
 * `import(…)` with its `await` (`start`, `end`), or a static import's clause.
 */
function moduleReaches(tokens) {
  const reaches = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if ((isName(token, "require") || isName(token, "import")) && isPunct(tokens[index + 1], "(") && isModuleString(tokens[index + 2]) && isPunct(tokens[index + 3], ")")) {
      const awaited = isName(tokens[index - 1], "await");
      reaches.push({ kind: token.value, start: awaited ? index - 1 : index, end: index + 4, line: token.line });
      index += 3;
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
  // `{ exec, default: cp, ...rest, [key]: x } = <module>`: what each entry takes out of it.
  const modulePattern = (open) => {
    const end = closing(tokens, open);
    for (let index = open + 1; index < end; ) {
      let stop = index;
      for (let depth = 0; stop < end; stop += 1) {
        const token = tokens[stop];
        if (token.type === "punct" && "([{".includes(token.value)) depth += 1;
        else if (token.type === "punct" && ")]}".includes(token.value)) depth -= 1;
        else if (depth === 0 && isPunct(token, ",")) break;
      }
      const first = tokens[index];
      if (isPunct(first, "...") && isName(tokens[index + 1])) aliases.add(tokens[index + 1].value);
      else if (isPunct(first, "[")) {
        const shut = closing(tokens, index);
        const inside = tokens.slice(index + 1, shut);
        const key = inside.length === 1 && inside[0].type === "string" ? inside[0].value : null;
        if (key === null || FORBIDDEN_MEMBERS.has(key)) childProcessFinding(first.line, key ?? "a computed member");
      } else if (first && (first.type === "name" || first.type === "string")) {
        if (FORBIDDEN_MEMBERS.has(first.value)) childProcessFinding(first.line, first.value);
        if (first.value === "default" && isPunct(tokens[index + 1], ":")) {
          const binding = tokens[index + 2];
          if (isName(binding)) aliases.add(binding.value);
          else if (isPunct(binding, "{")) modulePattern(index + 2);
        }
      }
      index = stop + 1;
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

  for (const reach of moduleReaches(tokens)) {
    if (reach.kind === "static") {
      // import x, * as y, { a, b as c, default as d } from "child_process"
      const [from, to] = reach.clause;
      for (let index = from; index < to; index += 1) {
        const token = tokens[index];
        if (isPunct(token, "{")) {
          const end = closing(tokens, index);
          for (let inner = index + 1; inner < end; inner += 1) {
            const name = tokens[inner];
            const previous = tokens[inner - 1];
            if (!(name.type === "name" || name.type === "string") || !(isPunct(previous, "{") || isPunct(previous, ","))) continue;
            if (FORBIDDEN_MEMBERS.has(name.value)) childProcessFinding(name.line, `${name.value} (imported by name)`);
            if (name.value === "default" && isName(tokens[inner + 1], "as") && isName(tokens[inner + 2])) aliases.add(tokens[inner + 2].value);
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
    // The module object as a value, in as many parentheses as it is written in, and past its `default`.
    let start = reach.start;
    let end = reach.end;
    while (isPunct(tokens[start - 1], "(") && isPunct(tokens[end], ")") && closing(tokens, start - 1) === end) {
      start -= 1;
      end += 1;
    }
    end = pastDefault(end);
    memberFinding(end, "");
    if (isPunct(tokens[end], ".") && isName(tokens[end + 1], "then") && isPunct(tokens[end + 2], "(")) thenParameter(end + 3);
    // const x = <module> / const { exec } = <module>
    if (assigns(tokens, start - 1)) {
      const target = tokens[start - 2];
      if (isName(target)) aliases.add(target.value);
      else if (isPunct(target, "}")) {
        let open = start - 2;
        for (let depth = 0; open >= 0; open -= 1) {
          if (isPunct(tokens[open], "}")) depth += 1;
          if (isPunct(tokens[open], "{")) depth -= 1;
          if (depth === 0) break;
        }
        modulePattern(open);
      }
    }
  }

  // A plain re-binding hands the name on: `const c2 = cp;`, `const g = globalThis;` — until nothing new is learnt.
  for (let learnt = true; learnt; ) {
    learnt = false;
    for (let index = 2; index < tokens.length; index += 1) {
      const value = tokens[index];
      if (!isName(value) || !assigns(tokens, index - 1) || !isName(tokens[index - 2]) || isPunct(tokens[index - 3], ".")) continue;
      const after = tokens[index + 1];
      if (after && !isPunct(after, ";") && !isPunct(after, ",") && !isPunct(after, ")") && after.line === value.line) continue;
      for (const known of [aliases, globals]) {
        if (known.has(value.value) && !known.has(tokens[index - 2].value)) {
          known.add(tokens[index - 2].value);
          learnt = true;
        }
      }
    }
  }
  // A global, or a global's own name for itself: `globalThis`, `global.globalThis`, `g` after `const g = globalThis`.
  const isGlobal = (index) => isName(tokens[index]) && globals.has(tokens[index].value)
    && (!isPunct(tokens[index - 1], ".") || isGlobal(index - 2));

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    // A name bound to the module: its exec members, or a pattern taking them out of it.
    if (isName(token) && aliases.has(token.value) && !isPunct(previous, ".")) {
      memberFinding(pastDefault(index + 1), token.value);
      if (assigns(tokens, index - 1) && isPunct(tokens[index - 2], "}")) {
        let open = index - 2;
        for (let depth = 0; open >= 0; open -= 1) {
          if (isPunct(tokens[open], "}")) depth += 1;
          if (isPunct(tokens[open], "{")) depth -= 1;
          if (depth === 0) break;
        }
        modulePattern(open);
      }
    }
    if (!allowEval && isName(token, "eval")) {
      // Only the key of an object literal is not eval: `{ eval: true }`, not `{ eval: run } = globalThis`, not `x ? eval : y`.
      const key = isPunct(next, ":") && (isPunct(previous, "{") || isPunct(previous, ",")) && inObjectLiteral(tokens, index);
      if (!key) say("eval", token.line, "eval is forbidden, called or handed on.");
    }
    if (!allowEval && isName(token, "Function") && !isPunct(next, ".") && !isName(previous, "instanceof")
      && (!isPunct(previous, ".") || isGlobal(index - 2))) {
      say("Function", token.line, "the Function constructor is forbidden, called or handed on.");
    }
    if (!allowEval && isName(token, "constructor") && isPunct(previous, ".") && isPunct(next, "(")) {
      say("Function", token.line, "calling a .constructor member is forbidden: ({}).constructor.constructor is the Function constructor.");
    }
    if (isGlobal(index) && !isGlobal(index + 2)) {
      // `globalThis[…]`, and `(globalThis)[…]`.
      const open = isPunct(next, "[") ? index + 1
        : isPunct(next, ")") && isPunct(previous, "(") && isPunct(tokens[index + 2], "[") ? index + 2 : -1;
      if (open >= 0) {
        const inside = tokens.slice(open + 1, closing(tokens, open));
        const plain = inside.length === 1 && inside[0].type === "string";
        if (!plain || (!allowEval && ["eval", "Function"].includes(inside[0].value))) {
          say("global-member", token.line, `a computed member of ${token.value} is forbidden unless its key is one plain string: it can reach eval or Function under any spelling.`);
        }
      }
    }
    // shell: <value> / "shell": <value> / ["shell"]: <value> / { shell } in an object literal, and <member>.shell = <value>.
    const computedShell = isPunct(token, "[") && tokens[index + 1]?.type === "string" && tokens[index + 1].value === "shell" && isPunct(tokens[index + 2], "]");
    const shellName = (isName(token, "shell") || (token.type === "string" && token.value === "shell")) && !isPunct(previous, ".") && !isPunct(previous, "[");
    if ((shellName || computedShell) && (isPunct(previous, "{") || isPunct(previous, ",")) && inObjectLiteral(tokens, index)) {
      const colon = computedShell ? index + 3 : index + 1;
      if (isPunct(tokens[colon], ":")) {
        if (!plainlyOff(tokens, colon + 1)) say("shell", token.line, "a shell option other than false is forbidden: pass the program and its arguments, and no shell reads them.");
      } else if (isName(token) && (isPunct(next, ",") || isPunct(next, "}"))) {
        say("shell", token.line, "a shell option whose value cannot be read here is forbidden: write shell: false, or leave it out.");
      }
    }
    const memberShell = (isName(token, "shell") && isPunct(previous, ".") && assigns(tokens, index + 1))
      || (computedShell && !isPunct(previous, "{") && !isPunct(previous, ",") && assigns(tokens, index + 3));
    if (memberShell && !plainlyOff(tokens, computedShell ? index + 4 : index + 2)) {
      say("shell", token.line, "setting a shell option other than false is forbidden: pass the program and its arguments, and no shell reads them.");
    }
  }
  return findings;
}
