import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LOCKFILE_SEARCH_DEPTH, markerDirectories, yarnAuditArgs } from "./security-scan-lockfiles.mjs";

async function tree(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lockfiles-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), content, "utf8");
  }
  return root;
}

const relative = (root, directories) => directories.map((item) => path.relative(root, item).split(path.sep).join("/") || ".");

test("a frontend and a backend with no lockfile at the root are both found", async (t) => {
  const root = await tree(t, {
    "frontend/package-lock.json": "{}",
    "backend/package-lock.json": "{}",
    "README.md": "# app"
  });
  assert.deepEqual(relative(root, await markerDirectories(root, ["package-lock.json"])), ["backend", "frontend"]);
});

test("the search stops two levels down and skips what is not a project's own tree", async (t) => {
  assert.equal(LOCKFILE_SEARCH_DEPTH, 2);
  const root = await tree(t, {
    "package-lock.json": "{}",
    "apps/web/package-lock.json": "{}",
    "apps/web/deep/er/package-lock.json": "{}",
    "node_modules/left-pad/package-lock.json": "{}",
    "test/fixtures/package-lock.json": "{}",
    "dist/package-lock.json": "{}",
    ".cache/package-lock.json": "{}",
    "packages/lib/pnpm-lock.yaml": "lockfileVersion: 9"
  });
  assert.deepEqual(relative(root, await markerDirectories(root, ["package-lock.json"])), [".", "apps/web"]);
  assert.deepEqual(relative(root, await markerDirectories(root, ["pnpm-lock.yaml"])), ["packages/lib"]);
  assert.deepEqual(await markerDirectories(root, ["Cargo.lock"]), []);
  assert.deepEqual(await markerDirectories(path.join(root, "missing"), ["package-lock.json"]), [], "an unreadable root is no directories, not a throw");
});

test("a symbolic link to a directory is not followed", async (t) => {
  const root = await tree(t, { "real/package-lock.json": "{}" });
  try {
    await fs.symlink(path.join(root, "real"), path.join(root, "linked"), "dir");
  } catch {
    t.skip("this host cannot create directory symlinks");
    return;
  }
  assert.deepEqual(relative(root, await markerDirectories(root, ["package-lock.json"])), ["real"]);
});

test("Yarn 2+ is told apart from Yarn 1 by packageManager, then by .yarnrc.yml", async (t) => {
  const berry = ["npm", "audit", "--all", "--recursive", "--json"];
  const classic = ["audit", "--json"];
  assert.deepEqual(await yarnAuditArgs(await tree(t, { "package.json": JSON.stringify({ packageManager: "yarn@4.10.3" }) })), berry);
  assert.deepEqual(await yarnAuditArgs(await tree(t, { "package.json": JSON.stringify({ packageManager: "yarn@1.22.22" }), ".yarnrc.yml": "" })), classic, "the declaration wins over the file");
  assert.deepEqual(await yarnAuditArgs(await tree(t, { "package.json": "{}", ".yarnrc.yml": "nodeLinker: node-modules\n" })), berry);
  assert.deepEqual(await yarnAuditArgs(await tree(t, { "package.json": "{}" })), classic);
  assert.deepEqual(await yarnAuditArgs(await tree(t, { "package.json": "{ not json" })), classic);
});
