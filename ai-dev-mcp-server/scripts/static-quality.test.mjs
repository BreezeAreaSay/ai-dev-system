import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MODULE_LINE_EXCEPTIONS } from "../src/core/line-budget.mjs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The gate is held by what it does, not by how its source reads: a test that matched its text stayed green with the
// call commented out, behind `if (false)`, or with the findings dropped before the verdict (docs/DEFECTS.md, Д-396).
test("the gate refuses a forbidden call planted in the server's code and in the desktop app's, and lets the app's tests call eval (Д-388, Д-396)", {
  skip: process.platform === "win32" && "the fixture links to the real modules, and a symbolic link needs a privilege on Windows"
}, async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "static-quality-"));
  try {
    const server = path.join(fixture, "ai-dev-mcp-server");
    // The gate itself, copied: what it does to the tree beside it, it does here.
    await fs.mkdir(path.join(server, "scripts"), { recursive: true });
    await fs.copyFile(path.join(serverRoot, "scripts", "static-quality.mjs"), path.join(server, "scripts", "static-quality.mjs"));
    // `src/` links to the real modules, which the gate imports and its walk passes by; the modules pinned over the
    // line ceiling are copies, so the budget finds them; and one module calls exec.
    const pinned = new Set([...MODULE_LINE_EXCEPTIONS].map(([relative]) => relative));
    const realSource = path.join(serverRoot, "src");
    await fs.mkdir(path.join(server, "src", "core"), { recursive: true });
    for (const entry of await fs.readdir(realSource)) {
      if (entry !== "core") await fs.symlink(path.join(realSource, entry), path.join(server, "src", entry));
    }
    for (const entry of await fs.readdir(path.join(realSource, "core"))) {
      const [from, to] = [path.join(realSource, "core", entry), path.join(server, "src", "core", entry)];
      if (pinned.has(`src/core/${entry}`)) await fs.copyFile(from, to);
      else await fs.symlink(from, to);
    }
    await fs.writeFile(path.join(server, "src", "core", "zz-planted.mjs"), 'import { exec } from "node:child_process";\nexec("ls");\n');
    for (const folder of ["bin", "hooks"]) await fs.mkdir(path.join(server, folder));
    // The desktop app beside it: eval is refused in its code and allowed in its tests.
    const desktop = path.join(fixture, "desktop");
    for (const folder of ["src", "scripts", "test"]) await fs.mkdir(path.join(desktop, folder), { recursive: true });
    await fs.writeFile(path.join(desktop, "package.json"), "{}\n");
    await fs.writeFile(path.join(desktop, "src", "zz-planted.js"), 'eval("1");\n');
    await fs.writeFile(path.join(desktop, "test", "zz-planted.test.js"), 'eval("1");\n');

    const run = spawnSync(process.execPath, [path.join(server, "scripts", "static-quality.mjs")], { cwd: server, encoding: "utf8", timeout: 120000 });
    assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
    const findings = run.stderr.split("\n").filter((line) => line.startsWith("- ")).sort();
    assert.deepEqual(findings, [
      "- desktop/src/zz-planted.js:1: eval is forbidden, called or handed on.",
      "- src/core/zz-planted.mjs:1: child_process exec (imported by name) is forbidden; use argv-based execution (spawn, spawnSync, execFile, execFileSync)."
    ], run.stderr);
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
