import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { analyzeChangeSet, collectChangeSet, findSecretsInLine, parseAddedLines, verifyChangeHygiene } from "./change-hygiene.mjs";

const aws = ["AKIA", "IOSFODNN7EXAMPL", "E"].join("");
const git = (cwd, args) => { const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true, shell: false }); if (result.status !== 0) throw new Error(result.stderr); };
test("scans added lines without exposing secret values", async (t) => {
  assert.equal(findSecretsInLine(`const key = "${aws}"`).at(0).id, "aws_access_key");
  assert.equal(findSecretsInLine("password = process.env.PASSWORD").length, 0);
  assert.deepEqual([...parseAddedLines("diff --git a/a b/a\n+++ b/a\n@@ -1 +2,1 @@\n+x\n")][0][1], [{ line: 2, text: "x" }]);
  const analysis = analyzeChangeSet({ files: [{ path: "src/a.ts", added: [{ line: 1, text: "console.log('x')" }, { line: 2, text: "debugger" }] }, { path: "src/a.test.ts", added: [] }] });
  assert.equal(analysis.status, "block"); assert.ok(analysis.findings.some((item) => item.code === "console_log"));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hygiene-")); t.after(() => fs.rm(root, { recursive: true, force: true })); await fs.mkdir(path.join(root, "src")); await fs.writeFile(path.join(root, "src", "a.js"), "export const a = 1;\n"); git(root, ["init", "-q"]); git(root, ["add", "."]); git(root, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-qm", "init"]); await fs.writeFile(path.join(root, "src", "a.js"), `export const token = "${aws}";\n`);
  assert.equal((await collectChangeSet(root)).git, true); assert.equal((await verifyChangeHygiene(root)).status, "block");
});
