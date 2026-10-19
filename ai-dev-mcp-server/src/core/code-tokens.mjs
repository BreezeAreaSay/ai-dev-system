/**
 * JavaScript read as tokens, for the rules of the static gate
 * (forbidden-calls.mjs): comments, strings, template text and
 * regular-expression literals set aside, every escape in strings and names
 * decoded, and the brackets paired once. It is a reader, not a parser: a
 * file it could not read to its end says so, and any file costs it one pass.
 */

// After these a `/` starts a regular expression, not a division — unless the word is a property: `stats.in / 2`.
export const KEYWORDS_BEFORE_EXPRESSION = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await", "default"
]);
// A `(` after these opens a statement's head, and a `/` after its `)` starts a regular expression: `if (x) /re/.test(s)`.
export const HEAD_KEYWORDS = new Set(["if", "while", "for", "with"]);
// Before these a `{` opens an object literal rather than a block, a class body or a clause.
const OBJECT_AFTER_PUNCT = new Set(["=", "(", ",", ":", "[", "?", "|", "&", "!", "...", "+", "-", "*", "%", "~", "^"]);
const OBJECT_AFTER_NAME = new Set(["return", "yield", "await", "case", "default", "typeof", "void", "new", "throw"]);
const SIMPLE_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };
// A name is what JavaScript reads as one: a no-break or an ideographic space ends it, as any space does (Д-407).
const NAME_START = /[\p{ID_Start}$_]/u;
const NAME_PART = /[\p{ID_Continue}$\u200c\u200d]/u;
// JavaScript ends a line, and a `//` comment, at any of these.
const LINE_END = /[\n\r\u2028\u2029]/g;
const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029]/g;
const BRACED_CODE_POINT = /\{([0-9a-fA-F]+)\}/y;
const OCTAL_ESCAPE = /[0-3][0-7]{0,2}|[4-7][0-7]?/y;

const isLineEnd = (character) => character === "\n" || character === "\r" || character === "\u2028" || character === "\u2029";
const lineBreaks = (text) => text.match(LINE_BREAKS)?.length ?? 0;
// The whole character at `at`, both halves of a pair: `𝑥` is one letter.
const codePoint = (text, at) => String.fromCodePoint(text.codePointAt(at));

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
 * postfix `++`, a call's `)`, or the `}` of an object literal or of a class or
 * function expression it divides; after a statement head's `)`
 * (`if (x) /re/`), a block's `}` — a label's or a `case`'s too — or a
 * declaration's it does not. One that does not close on its line divides.
 * Each `{` carries `literal`: whether it opens an object literal.
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
  // The brackets open now, innermost last: whether a `/` after its closing bracket starts a regular expression, whether
  // statements stand in it (a block, a class body — and the file itself), and how many conditionals' `?` wait for a `:`.
  const opened = [];
  const file = { regexAfter: true, statements: true, conditionals: 0 };
  const innermost = () => opened.at(-1) ?? file;
  // Just inside a `${`: an expression begins there, so a `/` begins a regular expression.
  let substitutionOpened = false;
  // Just after `?.`: it stands for `.` unless a `[` or a `(` comes next.
  let optional = false;
  // From `class` or `function` to its body's `{`: whether it stands where a value does, `const C = class {}`, so that a
  // `/` after the body divides — and where it is declared it begins a regular expression (Д-410).
  let body = null;
  // Whether a value begins after the token at `index`: a `{` there opens an object literal, a `class` is an expression.
  // A label's, a `case`'s or a `default`'s `:` is followed by a statement (Д-408).
  const valueAfter = (index) => {
    const last = tokens[index];
    if (last?.type === "punct") return OBJECT_AFTER_PUNCT.has(last.value) && !last.statement;
    return isName(last) && OBJECT_AFTER_NAME.has(last.value);
  };
  const headOpens = () => {
    const last = tokens.at(-1);
    return isName(last) && !isPunct(tokens.at(-2), ".") && (HEAD_KEYWORDS.has(last.value) || (last.value === "await" && isName(tokens.at(-2), "for")));
  };
  const push = (type, value, where = line) => {
    const fresh = substitutionOpened;
    substitutionOpened = false;
    if (optional) {
      optional = false;
      if (!(type === "punct" && (value === "[" || value === "("))) tokens.push({ type: "punct", value: ".", line: where });
    }
    const token = { type, value, line: where };
    if (type === "name" && (value === "class" || value === "function") && !isPunct(tokens.at(-1), ".")) {
      const before = value === "function" && isName(tokens.at(-1), "async") ? tokens.length - 2 : tokens.length - 1;
      const declared = isName(tokens[before], "default") && isName(tokens[before - 1], "export");
      body = { depth: opened.length, expression: !declared && (fresh || valueAfter(before)) };
    } else if (body && body.depth === opened.length && type === "punct" && [":", ",", ";", "=", "}"].includes(value)) {
      // `{ class: 1 }`: a key, not a class.
      body = null;
    }
    if (type === "punct" && value === "{") {
      const owner = body && body.depth === opened.length ? body : null;
      if (owner) body = null;
      token.literal = !owner && (fresh || valueAfter(tokens.length - 1));
      opened.push({ regexAfter: owner ? !owner.expression : !token.literal, statements: !token.literal, conditionals: 0 });
    } else if (type === "punct" && (value === "(" || value === "[")) {
      opened.push({ regexAfter: value === "(" && headOpens(), statements: false, conditionals: 0 });
    } else if (type === "punct" && (value === ")" || value === "]" || value === "}")) token.regexAfter = opened.pop()?.regexAfter === true;
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
    if (NAME_START.test(codePoint(text, at)) || (character === "\\" && text[at + 1] === "u")) {
      // A name, its escapes decoded: `eval` is `eval` (Д-382).
      let value = "";
      while (at < text.length) {
        const part = codePoint(text, at);
        if (part === "\\" && text[at + 1] === "u") {
          const [decoded, next] = readEscape(text, at + 1);
          value += decoded;
          at = next;
        } else if (NAME_PART.test(part)) {
          value += part;
          at += part.length;
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
    if (character === "?" && text[at + 1] === "?") {
      // `??` and `??=` are not a conditional's `?`.
      push("punct", "?");
      push("punct", "?");
      at += 2;
      continue;
    }
    if (templates.length) {
      if (character === "{") templates.at(-1).depth += 1;
      if (character === "}") templates.at(-1).depth -= 1;
    }
    push("punct", character);
    if (character === "?") innermost().conditionals += 1;
    else if (character === ":") {
      // A conditional's `:` is a value's; any other where statements stand begins one: a label's, a `case`'s.
      const here = innermost();
      if (here.conditionals > 0) here.conditionals -= 1;
      else if (here.statements) tokens.at(-1).statement = true;
    }
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
      // A closing bracket with no opening one of its kind (code that does not parse) pairs with nothing; one that would
      // close others left open looks only a few levels down, so a file of them costs no search through all (Д-412).
      let at = open.length - 1;
      for (let skipped = 0; at >= 0 && skipped < 8 && tokens[open[at]].value !== kinds[token.value]; skipped += 1) at -= 1;
      if (at < 0 || tokens[open[at]].value !== kinds[token.value]) return;
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
export const closing = (tokens, open) => (isOpening(tokens[open]) ? brackets(tokens).pair[open] : -1);
/** The index of the token that opened the bracket closed at `close`, or -1. */
export const opening = (tokens, close) => (tokens[close]?.type === "punct" && !isOpening(tokens[close]) && close >= 0 ? brackets(tokens).pair[close] : -1);
/** The index of the innermost `(`, `[` or `{` that holds the token at `index`, or -1. */
export const enclosing = (tokens, index) => (index >= 0 && index < tokens.length ? brackets(tokens).holder[index] : -1);

export const isPunct = (token, value) => token?.type === "punct" && token.value === value;
export const isName = (token, value) => token?.type === "name" && (value === undefined || token.value === value);
