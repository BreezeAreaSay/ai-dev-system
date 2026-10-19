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
// Before these a `{` opens an object literal rather than a block, a class body or a clause — `/` and `<` too, which
// only ever divide or compare (a regular expression is a token of its own), and a `>` that ends no arrow's `=>` (Д-507).
const OBJECT_AFTER_PUNCT = new Set(["=", "(", ",", ":", "[", "?", "|", "&", "!", "...", "+", "-", "*", "%", "~", "^", "/", "<"]);
// After these words a value begins: a `{` there is an object literal, a `class` an expression — `delete`, `in` and
// `instanceof` too, which only ever stand before an operand (Д-448), `extends`, and a `for` head's `of` (Д-507).
const OBJECT_AFTER_NAME = new Set(["return", "yield", "await", "case", "default", "typeof", "void", "new", "throw", "delete", "in", "instanceof", "extends"]);
// After these, and after the label one names, a statement is over: a `/` that follows begins a regular expression.
const STATEMENT_ENDS = new Set(["break", "continue", "debugger"]);
const SIMPLE_ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };
// A name is what JavaScript reads as one: a no-break or an ideographic space ends it, as any space does (Д-407).
const NAME_START = /[\p{ID_Start}$_]/u;
const NAME_PART = /[\p{ID_Continue}$\u200c\u200d]/u;
// JavaScript ends a line, and a `//` comment, at any of these.
const LINE_END = /[\n\r\u2028\u2029]/g;
const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029]/g;
const BRACED_CODE_POINT = /\{([0-9a-fA-F]+)\}/y;
const OCTAL_ESCAPE = /[0-3][0-7]{0,2}|[4-7][0-7]?/y;

// `x++ / 2`: a postfix increment or decrement ends its operand — and its value, where a declaration is read (Д-441).
export const endsOperand = (token) => token?.type === "number" || token?.type === "string" || token?.type === "regex"
  || (isName(token) && !KEYWORDS_BEFORE_EXPRESSION.has(token.value)) || isPunct(token, ")") || isPunct(token, "]");
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
 * no substitution is one, marked `template`), `number`, `punct`, `regex` (one
 * per literal, its text left out), or `template` (one per template literal
 * that has substitutions; the code in its `${…}` is tokenised in place, and
 * `last` is the index of the last token of its last substitution).
 * Comments leave nothing, and `?.` before `[` or `(` leaves nothing either:
 * `a?.[b]` is read as `a[b]`, whatever space or comment lies between.
 *
 * A `/` is a regular expression where an expression begins, and a division
 * after an operand: after a word that is a property (`stats.in / 2`), a postfix
 * `++`, on a property too (`stats.new++ / 2`) — not a `++` after a line break,
 * a prefix: `a⏎++/re/.lastIndex` —, a call's `)`, or the `}` of an object
 * literal or of a class or function expression it divides; after a statement
 * head's `)` (`if (x) /re/`), a block's `}` — a label's or a `case`'s too — or
 * a declaration's it does not. One that does not close on its line divides,
 * and no later one on that line reads again, in the same state — inside a
 * class of characters or out of one — what it read.
 * Each `{` carries `literal`: whether it opens an object literal; a class's
 * body carries `classBody`; a token right in a template's substitution, no
 * bracket opened since its `${`, carries `substitution`, and every token in a
 * substitution `within`: the index of its template's first token.
 *
 * When a template literal, a substitution or a comment never closes, the
 * array's `unterminated` property is the line it opened on: whatever follows
 * it was read as part of it.
 *
 * A script — a `.cjs` file — has HTML-like comments too: `<!--` comments out
 * the rest of its line, and so does `-->` where no token stands before it on
 * its line — a comment that spans lines ends one; a module has none, there
 * `<!--` is `< ! --` (Д-424, Д-447).
 *
 * @param {string} source
 * @param {{ script?: boolean }} [options]
 * @returns {Array<{ type: string, value: string, line: number }> & { unterminated?: number }}
 */
export function codeTokens(source, { script = false } = {}) {
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
  // From `class` or `function` to its body's `{`, each still waiting, innermost last: whether it stands where a value
  // does, `const C = class {}`, so that a `/` after the body divides — and where it is declared it begins a regular
  // expression (Д-410). One waits inside another: `class extends f(function () {}) {}` (Д-424).
  const bodies = [];
  // Where a body is waited for: the brackets open, and the template substitutions — a `${…}` in a class's heritage is
  // not at its body's level, and an `=` or a `:` there ends no wait (Д-461).
  const level = () => opened.length + templates.length;
  // A member's name is a name, whatever word it is: `it.return`, `o.default`, `this.#class` (Д-442, Д-443).
  const isMember = (index) => isPunct(tokens[index - 1], ".") || isPunct(tokens[index - 1], "#");
  // A `++` or `--` is a postfix where an operand ends right before it on its line: `n++`, and a member of any name,
  // `stats.new++` (Д-508). None follows a line break: `a⏎++b` is `a; ++b` (Д-515).
  const postfix = (index) => (isPunct(tokens[index], "+") || isPunct(tokens[index], "-")) && tokens[index].joined === true
    && tokens[index - 2]?.line === tokens[index - 1].line && (endsOperand(tokens[index - 2]) || isMember(index - 2));
  // `return`, `yield` and a postfix `++` or `--` end their statement at a line break: what the next line begins is a
  // statement, so a `{` there is a block and a `class` a declaration (Д-423). A member of that name, `it.return`, is an
  // operand, and after an operand a `{` or a `class` begins a statement as well.
  const endsAtBreak = (index) => isName(tokens[index], "return") || isName(tokens[index], "yield") || postfix(index);
  // Whether a value begins after the token at `index`, for a token on line `where`: a `{` there opens an object
  // literal, a `class` is an expression. A label's, a `case`'s or a `default`'s `:` is followed by a statement (Д-408).
  const valueAfter = (index, where) => {
    const last = tokens[index];
    if (last && last.line < where && endsAtBreak(index)) return false;
    if (last?.type === "punct") return (OBJECT_AFTER_PUNCT.has(last.value) || (last.value === ">" && !isPunct(tokens[index - 1], "="))) && !last.statement;
    return isName(last) && (OBJECT_AFTER_NAME.has(last.value) || last.keyword === true) && !isMember(index);
  };
  const headOpens = () => {
    const last = tokens.at(-1);
    return isName(last) && !isMember(tokens.length - 1) && (HEAD_KEYWORDS.has(last.value) || (last.value === "await" && isName(tokens.at(-2), "for")));
  };
  // Where `-->` may begin an HTML-like comment: no token yet on this line — a line break, or a comment that spans one,
  // since the last token, or the start of the file (Д-447).
  let lineBegins = true;
  // Where a regular expression's scan is known to fail, by place: 1 inside a class of characters, 2 outside one. A line
  // of slashes whose expressions never close was read again from each slash, its length squared (Д-463).
  let failed = null;
  // Where a token stands: right in a substitution — no bracket opened since its `${` — an expression's place, where no
  // statement stands (Д-488); and the template its code is in, `within`: a walk begun there ends with it, a bracket left
  // open or not (Д-501) — the `.` that `?.` leaves as well (Д-504).
  const mark = (token) => {
    if (templates.length && templates.at(-1).opened === opened.length) token.substitution = true;
    if (templates.length) token.within = templates.at(-1).token;
    return token;
  };
  const push = (type, value, where = line) => {
    const fresh = substitutionOpened;
    substitutionOpened = false;
    lineBegins = false;
    if (optional) {
      optional = false;
      if (!(type === "punct" && (value === "[" || value === "("))) tokens.push(mark({ type: "punct", value: ".", line: where }));
    }
    const token = mark({ type, value, line: where });
    // `export * as class from …`, `export { a as class }`, `{ class: 1 }`, `import { class as k }`, `this.#class`: a name,
    // not a class.
    // Right in a class's body a word that begins a member — after `{`, `;`, `}`, `static`, or a line a member ended —
    // is the member's name: `class⏎  x⏎  static {}` is two fields and a static block, and opens no wait (Д-486, Д-499).
    // A substitution of a field's template is an expression's place, whatever came before it (Д-503).
    const last = tokens.at(-1);
    const named = token.substitution !== true && innermost().classBody === true && (isPunct(last, "{") || isPunct(last, ";") || isPunct(last, "}") || isName(last, "static")
      || (last.line < where && (endsOperand(last) || isMember(tokens.length - 1) || endsAtBreak(tokens.length - 1))));
    if (type === "name" && (value === "class" || value === "function") && !isMember(tokens.length) && !isName(tokens.at(-1), "as") && !named) {
      // `async` belongs to the function only on its line: `x = async⏎function f() {}` declares f (Д-423).
      const async = value === "function" && isName(tokens.at(-1), "async") && tokens.at(-1).line === where;
      const before = async ? tokens.length - 2 : tokens.length - 1;
      const declared = isName(tokens[before], "default") && isName(tokens[before - 1], "export");
      bodies.push({ depth: level(), expression: !declared && (fresh || valueAfter(before, where)), kind: value });
    } else if (type === "punct" && (value === ":" || value === "}" || value === "=" || value === ";")) {
      // None of these stands between `class` or `function` and its body: one at that depth ends the wait — a key of
      // that name, `{ class: 1 }`, the end of a block, a field of that name, `class = 1`, `class;` (Д-425, Д-443, Д-476).
      while (bodies.at(-1)?.depth === level()) bodies.pop();
    } else if (type === "name" && value === "extends" && bodies.at(-1)?.depth === level()) bodies.at(-1).heritage = true;
    // Class code is strict, so no class is named `static`: right after a `class` that waits — a field named `class` after
    // one named `in` — `static {` is a static block (Д-486, Д-499).
    else if (type === "name" && value === "static" && isName(tokens.at(-1), "class") && bodies.at(-1)?.depth === level()) bodies.pop();
    // A `(` stands before a class's body only in its heritage: `class(run) {}` is a method of that name (Д-476).
    else if (type === "punct" && value === "(" && bodies.at(-1)?.depth === level() && bodies.at(-1).kind === "class" && bodies.at(-1).heritage !== true) bodies.pop();
    // In a `for` head `of` is the keyword right after the binding — a pattern's or a parenthesis's end, a member, a name
    // that is no keyword, or an `of` that is not the keyword — and nowhere else: `for (let i = of / 2; …)`,
    // `for (k in of / 2)` and `for (const k of of / 2 ? of : of)` divide, `for (let of of …)` binds it (Д-448, Д-464).
    if (type === "name" && value === "of" && innermost().forHead === true) {
      const binding = tokens.at(-1);
      const name = isName(binding) && (isMember(tokens.length - 1) || (binding.value === "of" ? binding.keyword !== true
        : !KEYWORDS_BEFORE_EXPRESSION.has(binding.value) && !["let", "const", "var"].includes(binding.value)));
      token.keyword = name || isPunct(binding, "]") || isPunct(binding, "}") || isPunct(binding, ")");
    }
    if (type === "punct" && value === "{") {
      // Right after `extends` it begins the heritage, an object literal, and the class still waits for its body (Д-507).
      const owner = bodies.at(-1)?.depth === level() && !isName(tokens.at(-1), "extends") ? bodies.pop() : null;
      token.literal = !owner && (fresh || valueAfter(tokens.length - 1, where));
      // A class's body: what stands right before it is the class's heritage, a call there too (Д-466).
      if (owner?.kind === "class") token.classBody = true;
      opened.push({ regexAfter: owner ? !owner.expression : !token.literal, statements: !token.literal, conditionals: 0, classBody: token.classBody === true });
    } else if (type === "punct" && (value === "(" || value === "[")) {
      // In a `for` head `of` may be the keyword; anywhere else it is a name: `of / 2` divides (Д-424). A member's
      // parentheses, `o.for(of / 2)`, hold no binding for an `of` to follow (Д-464).
      const forHead = value === "(" && (isName(tokens.at(-1), "for") || (isName(tokens.at(-1), "await") && isName(tokens.at(-2), "for")));
      opened.push({ regexAfter: value === "(" && headOpens(), statements: false, conditionals: 0, forHead });
    } else if (type === "punct" && (value === ")" || value === "]" || value === "}")) token.regexAfter = opened.pop()?.regexAfter === true;
    tokens.push(token);
  };
  const unterminated = (where) => {
    tokens.unterminated ??= where;
  };
  const regexAllowed = () => {
    if (substitutionOpened) return true;
    const last = tokens.at(-1);
    if (!last) return true;
    if (last.type === "name") {
      if (isMember(tokens.length - 1)) return false;
      // `debugger⏎/r/`, `break outer⏎/r/`: the statement is over, and a `/` begins the next (Д-448).
      const labelled = (isName(tokens.at(-2), "break") || isName(tokens.at(-2), "continue")) && tokens.at(-2).line === last.line;
      if (STATEMENT_ENDS.has(last.value) || labelled) return true;
      return last.value === "of" ? last.keyword === true : KEYWORDS_BEFORE_EXPRESSION.has(last.value);
    }
    if (last.type !== "punct") return false;
    if (last.value === ")" || last.value === "]" || last.value === "}") return last.regexAfter === true;
    // `x++ / 2` and `stats.new++ / 2` divide; `a + + /re/` is a plus, a unary plus and a regular expression (Д-424, Д-508),
    // `a⏎++/re/.lastIndex` a prefix and one (Д-515).
    if (postfix(tokens.length - 1)) return false;
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
      lineBegins = true;
      at += 1;
      continue;
    }
    if (/\s/.test(character)) { at += 1; continue; }
    const htmlOpen = script && text.startsWith("<!--", at);
    const htmlClose = script && lineBegins && text.startsWith("-->", at);
    if ((character === "/" && text[at + 1] === "/") || htmlOpen || htmlClose) {
      LINE_END.lastIndex = at;
      at = LINE_END.exec(text)?.index ?? text.length;
      continue;
    }
    if (character === "/" && text[at + 1] === "*") {
      const end = text.indexOf("*/", at + 2);
      if (end < 0) unterminated(line);
      const stop = end < 0 ? text.length : end + 2;
      const spanned = lineBreaks(text.slice(at, stop));
      line += spanned;
      if (spanned) lineBegins = true;
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
      if (ended === "end") {
        // Read as the string it is, and still a template: `cp⏎`x`` tags `cp` (Д-459).
        push("string", cooked, started);
        tokens.at(-1).template = true;
      } else {
        push("template", "`", started);
        if (ended === "code") {
          templates.push({ depth: 0, line: started, token: tokens.length - 1, opened: opened.length });
          substitutionOpened = true;
        } else unterminated(started);
      }
      continue;
    }
    if (character === "}" && templates.length && templates.at(-1).depth === 0) {
      const { line: started, token } = templates.pop();
      at += 1;
      const { ended } = readTemplateText();
      // Where the template ends: a walk over a list steps over it whole, the commas of its code not the list's (Д-473).
      if (ended === "end") tokens[token].last = tokens.length - 1;
      if (ended === "code") {
        templates.push({ depth: 0, line: started, token, opened: opened.length });
        substitutionOpened = true;
      } else if (ended === "eof") unterminated(started);
      continue;
    }
    if (character === "/" && regexAllowed()) {
      const slash = at;
      let inClass = false;
      // The places this scan passes, each with whether it is inside a class: one that fails marks them, and a later scan
      // that comes to a marked place in the same state would fail as it did — it stops there.
      const passed = [];
      let known = false;
      for (at += 1; at < text.length; at += 1) {
        const state = inClass ? 1 : 2;
        if (failed !== null && (failed[at] & state) !== 0) {
          known = true;
          break;
        }
        passed.push(at, state);
        const inside = text[at];
        if (inside === "\\" && !isLineEnd(text[at + 1] ?? "\n")) { at += 1; continue; }
        if (isLineEnd(inside)) break;
        if (inside === "[") inClass = true;
        else if (inside === "]") inClass = false;
        else if (inside === "/" && !inClass) break;
      }
      if (known || text[at] !== "/") {
        failed ??= new Uint8Array(text.length + 1);
        for (let index = 0; index < passed.length; index += 2) failed[passed[index]] |= passed[index + 1];
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
    // `++` and `--` are one sign: a `+` right after another, with nothing between, is its second half.
    if ((character === "+" || character === "-") && text[at - 1] === character && isPunct(tokens.at(-2), character)) tokens.at(-1).joined = true;
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
