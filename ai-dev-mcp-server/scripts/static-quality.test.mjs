import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { forbiddenCalls } from "../src/core/forbidden-calls.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "static-quality.mjs");

/** The body of the `for (const file of <list>)` loop in the script, by the list it walks. */
function loopBody(source, list) {
  const head = `for (const file of ${list}) {`;
  const start = source.indexOf(head);
  assert.ok(start >= 0, `static-quality.mjs walks ${list}`);
  let depth = 0;
  for (let index = start + head.length - 1; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`the ${list} loop never closes`);
}

test("the gate asks every file it reads for forbidden calls: the server's and the desktop app's (Д-388)", async () => {
  // Every test of forbidden-calls.mjs stays green if the gate stops calling it, and the tree holds nothing
  // for it to find, so the call itself is what is held here.
  const source = await fs.readFile(script, "utf8");
  assert.match(source, /^import \{ forbiddenCalls \} from "\.\.\/src\/core\/forbidden-calls\.mjs";$/m);
  const desktop = loopBody(source, "desktopFiles");
  assert.match(desktop, /for \(const finding of forbiddenCalls\(source, \{ allowEval: inTests \}\)\) findings\.push\(/, "the desktop app's files, its tests allowed eval");
  assert.match(desktop, /const inTests = relative\.startsWith\("desktop\/test\/"\);/, "and only its tests");
  const server = loopBody(source, "files");
  assert.match(server, /for \(const finding of forbiddenCalls\(source\)\) findings\.push\(/, "the server's files, with no allowance");
  // And what it would find there is found: the rule set is not empty.
  assert.deepEqual(forbiddenCalls('require("child_process").exec("x");').map((finding) => finding.rule), ["child_process.exec"]);
});
