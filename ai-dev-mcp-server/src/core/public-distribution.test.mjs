import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCleanDistribution,
  auditDistributionTree,
  distributionPathFindings,
  distributionTextFindings,
  findDanglingImports,
  ownerUsername
} from "./public-distribution.mjs";

test("distribution path policy rejects private vault and runtime state", () => {
  assert.ok(distributionPathFindings("02-knowledge/Projects/client.md").length > 0);
  assert.ok(distributionPathFindings(".ai-dev/context/task.md").length > 0);
  assert.ok(distributionPathFindings("runtime/search.sqlite").length > 0);
  assert.equal(distributionPathFindings("03-skills-catalog/sources/custom/reviewer/SKILL.md").length, 0);
  assert.equal(distributionPathFindings("03-skills-catalog/sources/external/archify/node_modules/ajv/package.json").length, 0);
  assert.equal(distributionPathFindings("public-seed/03-skills-catalog/sources/external/archify/node_modules/ajv/package.json").length, 0);
  assert.ok(distributionPathFindings("03-skills-catalog/sources/custom/reviewer/node_modules/example/package.json").length > 0);
});

test("distribution text policy reports secret classes without echoing values", () => {
  const token = ["gh", "p_", "a".repeat(30)].join("");
  const findings = distributionTextFindings(`token=${token}`, "unsafe.txt");
  assert.deepEqual(findings, [{ rule: "github-token", path: "unsafe.txt" }]);
  assert.equal(JSON.stringify(findings).includes(token), false);
});

test("a staged tree that imports what it does not carry is reported before an image is built", async (t) => {
  // Measured: the published image died on startup with
  // ERR_MODULE_NOT_FOUND for core/public-distribution.mjs, because a shipped
  // module imported one the allowlist excluded. Nothing caught it until the
  // container ran.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "dangling-imports-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const src = path.join(root, "src", "core");
  await fs.mkdir(src, { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "left-out"), { recursive: true });

  await fs.writeFile(path.join(src, "kept.mjs"), 'export const kept = 1;\n', "utf8");
  await fs.writeFile(path.join(src, "server.mjs"), [
    'import { kept } from "./kept.mjs";',
    'import { gone } from "./left-out.mjs";',
    'import express from "express";',
    'const lazy = await import("./also-gone.mjs");',
    'export { kept, gone, lazy };'
  ].join("\n"), "utf8");
  // A module in node_modules is not the tree's own to account for.
  await fs.writeFile(path.join(root, "node_modules", "left-out", "index.mjs"), 'import "./nowhere.mjs";\n', "utf8");

  const findings = await findDanglingImports(root);
  assert.deepEqual(findings.map((item) => item.specifier), ["./also-gone.mjs", "./left-out.mjs"]);
  assert.equal(findings[0].file, "src/core/server.mjs");
  assert.equal(findings[0].resolved, "src/core/also-gone.mjs");

  // An extensionless specifier resolving to a real file is not a finding.
  await fs.writeFile(path.join(src, "left-out.mjs"), "export const gone = 2;\n", "utf8");
  await fs.writeFile(path.join(src, "also-gone.mjs"), "export default 3;\n", "utf8");
  assert.deepEqual(await findDanglingImports(root), []);
});

test("distribution audit accepts a clean allowlisted tree", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-public-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "01-system"), { recursive: true });
  await fs.writeFile(path.join(root, "01-system", "Rules.md"), "# Public rules\n");
  const audit = await auditDistributionTree(root, { forbiddenTerms: ["private-owner"] });
  assert.equal(assertCleanDistribution(audit).total_files, 1);
});

test("distribution audit blocks owner context without exposing source text", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-private-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "note.md"), "private-owner local context");
  const audit = await auditDistributionTree(root, { forbiddenTerms: ["private-owner"] });
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.findings, [{ rule: "private-owner-context", path: "note.md" }]);
});

test("ownerUsername returns a string without throwing", () => {
  assert.equal(typeof ownerUsername(), "string");
});

test("ownerUsername falls back to the environment when os.userInfo throws", (t) => {
  const originalUserInfo = os.userInfo;
  const originalUser = process.env.USER;
  const originalUsername = process.env.USERNAME;
  const originalLogname = process.env.LOGNAME;
  t.after(() => {
    os.userInfo = originalUserInfo;
    if (originalUser === undefined) delete process.env.USER; else process.env.USER = originalUser;
    if (originalUsername === undefined) delete process.env.USERNAME; else process.env.USERNAME = originalUsername;
    if (originalLogname === undefined) delete process.env.LOGNAME; else process.env.LOGNAME = originalLogname;
  });
  // Reproduces `docker run --user "$uid:$gid"` with no matching passwd entry.
  os.userInfo = () => {
    const error = new Error("uv_os_get_passwd returned ENOENT");
    error.code = "ERR_SYSTEM_ERROR";
    throw error;
  };
  delete process.env.USERNAME;
  delete process.env.LOGNAME;
  process.env.USER = "build-local-1000";
  assert.equal(ownerUsername(), "build-local-1000");
});

const ownerContext = (text, terms) =>
  distributionTextFindings(text, "f.md", { forbiddenTerms: terms }).some(
    (finding) => finding.rule === "private-owner-context"
  );

test("owner-context matching ignores ordinary words but catches distinctive identities", () => {
  assert.equal(ownerContext("The project root is /workspace.", ["root"]), false);
  assert.equal(ownerContext("Run the CI pipeline before merge.", ["ci"]), false);
  assert.equal(ownerContext("Author: sacha", ["sacha"]), true);
  assert.equal(ownerContext("see also sachathing/config", ["sacha"]), false);
});

test("owner-context home directories require a specific path", () => {
  assert.equal(ownerContext("HOME is /root here", ["/root"]), false);
  assert.equal(ownerContext("cloned into /home/sacha/vault", ["/home/sacha"]), true);
  assert.equal(ownerContext("C:/Users/sacha/vault", ["C:\\Users\\sacha"]), true);
});
