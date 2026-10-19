/**
 * The calls AGENTS.md forbids, found by what the code does rather than how it
 * happens to be spelled.
 *
 * The static gate used to look for the usual spellings — `eval(`, `shell: true`,
 * `import { exec } from "node:child_process"` — and every equivalent spelling
 * passed it: `import * as cp` then `cp.exec(…)`, `execSync(…)`, `{ "shell": true }`,
 * `{ shell: "/bin/sh" }`, `globalThis["ev" + "al"](…)` (docs/DEFECTS.md, Д-267).
 * So the source is read as tokens (code-tokens.mjs) — comments, strings,
 * template text and regular-expression literals set aside, every escape in
 * strings and names decoded, a template with no substitution read as the
 * string it is — and the rules are asked of those:
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
 *   namespace import, `require`, `import()` or `process.getBuiltinModule`, its
 *   `default`, a `.then` callback, a rest element, and any name the module
 *   object is bound or plainly re-bound to (`const c2 = cp`,
 *   `const c3 = (0, c2)`, `cp ??= await import(…)`), above or below; and the
 *   module object handed to another file — `export *`, `export { default }`,
 *   `module.exports =`, `exports["cp"] =`, `export default` — whose `exec`
 *   would come from here;
 * - a `shell` option with any value but `false`, `null`, `undefined`, `0` or
 *   an empty string — as a key of an object literal, computed or not, or set
 *   on a member with `=`, `??=`, `||=` or `&&=` — and a `shell` shorthand,
 *   whose value nobody can see. A `shell` that is not an option is left alone:
 *   an import, a parameter, a destructuring pattern, an argument (Д-382, Д-398).
 *
 * It is a reader, not a parser. It follows the module object and the global
 * objects through plain re-binding, and nothing else through anything: a
 * module name built from parts, `createRequire`, `Reflect.get`, `require`
 * itself re-bound, a key held in a variable, the module object put in an
 * object or an array by name (`module.exports = { cp }`,
 * `export default { cp }`, `Object.assign(exports, { cp })`) or handed to a
 * function are past it (Д-410). Code written that way
 * is not written by accident, and keeping honest code honest is what this gate
 * is for. A computed member of a global it cannot read is refused rather than
 * trusted, and so is a file it could not read to its end — a template literal
 * or a comment that never closes, where whatever follows would go unchecked.
 */

import { HEAD_KEYWORDS, KEYWORDS_BEFORE_EXPRESSION, closing, codeTokens, enclosing, isName, isPunct, opening } from "./code-tokens.mjs";

const MODULE_NAMES = new Set(["child_process", "node:child_process"]);
const FORBIDDEN_MEMBERS = new Set(["exec", "execSync"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "window", "global", "self"]);
const FALSY_LITERALS = new Set(["false", "null", "undefined", "0"]);
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
// What isPattern answered for each bracket of a token array: a key deep in nested brackets climbs them once (Д-412).
const PATTERNS = new WeakMap();
function isPattern(tokens, open) {
  if (!PATTERNS.has(tokens)) PATTERNS.set(tokens, new Map());
  const known = PATTERNS.get(tokens);
  // Each bracket the climb passes has the answer of the one it ends at.
  const climbed = [];
  let answer = false;
  for (let at = open; ;) {
    if (known.has(at)) {
      answer = known.get(at);
      break;
    }
    climbed.push(at);
    const end = closing(tokens, at);
    if (end < 0) break;
    if (assigns(tokens, end + 1) || isName(tokens[end + 1], "of") || isName(tokens[end + 1], "in")) {
      answer = true;
      break;
    }
    if (assigns(tokens, at - 1) || isName(tokens[at - 1], "of") || isName(tokens[at - 1], "in")) break;
    const outer = enclosing(tokens, at);
    if (outer < 0) break;
    if (isPunct(tokens[outer], "(")) {
      // `class A extends make({ … }) {}` calls `make`; a parameter list is followed by its body.
      const shut = closing(tokens, outer);
      answer = !isName(tokens[outer - 2], "extends")
        && (isPunct(tokens[shut + 1], "{") || (isPunct(tokens[shut + 1], "=") && isPunct(tokens[shut + 2], ">")));
      break;
    }
    at = outer;
  }
  for (const at of climbed) known.set(at, answer);
  return answer;
}

/** Whether the token at `index` is a key or a shorthand of an object literal — not a block, a pattern or an import. */
function inObjectLiteral(tokens, index) {
  const open = enclosing(tokens, index);
  // After `)`, `=>`, `else`, a `;` or a label's `:` it is a block; after `import` or `const` a clause or a pattern.
  if (open < 0 || !isPunct(tokens[open], "{") || !tokens[open].literal) return false;
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
    // `require("child_process")`, `import("node:child_process", { … })`, a trailing comma and all, and
    // `process.getBuiltinModule("child_process")`, which is `require` by another name (Д-410).
    if (["require", "import", "getBuiltinModule"].some((name) => isName(token, name)) && isPunct(tokens[index + 1], "(") && isModuleString(tokens[index + 2])
      && (isPunct(tokens[index + 3], ")") || isPunct(tokens[index + 3], ","))) {
      const shut = closing(tokens, index + 1);
      if (shut < 0) continue;
      // `module.require(…)` and `process.getBuiltinModule(…)` are the module too: the value begins at the head of its chain.
      let start = index;
      while (token.value !== "import" && isPunct(tokens[start - 1], ".") && isName(tokens[start - 2])) start -= 2;
      reaches.push({ kind: token.value, start, end: shut + 1, line: token.line });
      index = shut;
      continue;
    }
    if (isName(token, "from") && isModuleString(tokens[index + 1])) {
      // Back to the `import` or `export` its clause begins with, over names, `*`, `,` and one `{ … }`: anything else
      // there means this `from` begins no clause, and no search runs on to the start of the file (Д-412).
      let start = index - 1;
      for (;;) {
        const before = tokens[start];
        if (isPunct(before, "}") && opening(tokens, start) >= 0) start = opening(tokens, start) - 1;
        else if ((isName(before) && before.value !== "import" && before.value !== "export") || isPunct(before, ",") || isPunct(before, "*")) start -= 1;
        else break;
      }
      if (isName(tokens[start], "import") || isName(tokens[start], "export")) {
        reaches.push({ kind: "static", start, end: index + 2, clause: [start + 1, index], line: token.line });
      }
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
  // `{ exec, default: cp, ...rest, [key]: x } = <module>`: what each entry takes out of it, nested `default`s and all —
  // the names it binds to the module, and the exec members it takes out.
  const modulePattern = (open, bound = (name) => aliases.add(name), found = childProcessFinding) => {
    for (const pending = [open]; pending.length; ) {
      for (const index of entries(pending.pop())) {
        const first = tokens[index];
        if (isPunct(first, "...") && isName(tokens[index + 1])) bound(tokens[index + 1].value);
        else if (isPunct(first, "[")) {
          const inside = tokens.slice(index + 1, closing(tokens, index));
          const key = inside.length === 1 && inside[0].type === "string" ? inside[0].value : null;
          if (key === null || FORBIDDEN_MEMBERS.has(key)) found(first.line, key ?? "a computed member");
        } else if (first && (first.type === "name" || first.type === "string")) {
          if (FORBIDDEN_MEMBERS.has(first.value)) found(first.line, first.value);
          if (first.value === "default" && isPunct(tokens[index + 1], ":")) {
            const binding = tokens[index + 2];
            if (isName(binding)) bound(binding.value);
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
      // A spread hands exec on with the rest; a pattern's rest element, `{ spawn, ...others } = cp`, binds a name.
      const holder = enclosing(tokens, start);
      if (!(isPunct(tokens[holder], "{") || isPunct(tokens[holder], "[")) || !isPattern(tokens, holder)) {
        childProcessFinding(tokens[start].line, `${what} (spread: its exec goes with it)`);
      }
      return;
    }
    if (isName(tokens[start - 1], "default") && isName(tokens[start - 2], "export")) {
      childProcessFinding(tokens[start].line, `${what} (exported as default)`);
      return;
    }
    if (!assigns(tokens, start - 1)) return;
    const target = assignedAt(tokens, start - 1);
    // The head of the chain assigned to: `module.exports.cp`, `exports["cp"]`, `module["exports"]` (Д-410).
    let head = target;
    for (;;) {
      if (isPunct(tokens[head], "]") && opening(tokens, head) > 0) head = opening(tokens, head) - 1;
      else if (isName(tokens[head]) && isPunct(tokens[head - 1], ".")) head -= 2;
      else break;
    }
    const exportsNext = isPunct(tokens[head + 1], ".") ? isName(tokens[head + 2], "exports")
      : isPunct(tokens[head + 1], "[") && tokens[head + 2]?.type === "string" && tokens[head + 2].value === "exports" && isPunct(tokens[head + 3], "]");
    if (isName(tokens[head], "exports") || (isName(tokens[head], "module") && exportsNext)) {
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

  // The name a plain value comes down to, from `at` on: past `await`, the parentheses around it and the lists it ends
  // (`(0, cp)` is `cp`), on through `.default`, `["default"]` and a global's own names. `[name, end]`, where `end` is
  // just past the value, or null.
  const plainValue = (at) => {
    const shuts = [];
    for (;;) {
      if (isName(tokens[at], "await")) at += 1;
      else if (isPunct(tokens[at], "(")) {
        const shut = closing(tokens, at);
        if (shut < 0) return null;
        shuts.push(shut);
        // The list's last item: back from the `)` to its last `,`, over whole brackets.
        let item = shut;
        while (item - 1 > at && !isPunct(tokens[item - 1], ",")) {
          const open = opening(tokens, item - 1);
          item = open > at ? open : item - 1;
        }
        at = item;
      } else break;
    }
    if (!isName(tokens[at])) return null;
    let end = at + 1;
    for (;;) {
      const member = tokens[end + 1];
      if (isPunct(tokens[end], ".") && isName(member) && (member.value === "default" || GLOBAL_OBJECTS.has(member.value))) end += 2;
      else if (isPunct(tokens[end], "[") && member?.type === "string" && member.value === "default" && isPunct(tokens[end + 2], "]")) end += 3;
      else break;
    }
    // Each parenthesis closes right after what it holds: `(cp)`, `(0, cp)` — not `(cp.x)` or `(cp + 1)`.
    while (shuts.length) {
      if (end !== shuts.pop()) return null;
      end += 1;
    }
    return [at, end];
  };
  // A plain re-binding hands the name on — `const c2 = cp`, `c2 ??= (cp)`, `const cp = ns.default`,
  // `const m = await loading`, `const g = (0, globalThis)` — and a pattern takes the module out of one:
  // `const { default: c3, ...rest } = c2`. However long the chain, in any order (Д-401, Д-409).
  const boundTo = new Map();
  const takenFrom = new Map();
  const bind = (map, from, name) => {
    if (!map.has(from)) map.set(from, []);
    map.get(from).push(name);
  };
  for (let index = 2; index < tokens.length; index += 1) {
    if (!assigns(tokens, index)) continue;
    const value = plainValue(index + 1);
    if (!value) continue;
    const [at, end] = value;
    const after = tokens[end];
    if (after && !isPunct(after, ";") && !isPunct(after, ",") && !isPunct(after, ")") && !isPunct(after, "}") && after.line === tokens[end - 1].line) continue;
    const target = assignedAt(tokens, index);
    if (isName(tokens[target]) && !isPunct(tokens[target - 1], ".")) bind(boundTo, tokens[at].value, tokens[target].value);
    else if (isPunct(tokens[target], "}")) modulePattern(opening(tokens, target), (name) => bind(takenFrom, tokens[at].value, name), () => {});
  }
  for (const [known, maps] of [[aliases, [boundTo, takenFrom]], [globals, [boundTo]]]) {
    for (const queue = [...known]; queue.length; ) {
      const from = queue.pop();
      for (const map of maps) {
        for (const name of map.get(from) ?? []) {
          if (!known.has(name)) {
            known.add(name);
            queue.push(name);
          }
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
