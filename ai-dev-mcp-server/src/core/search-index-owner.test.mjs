import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLAIM_SUFFIX, DEFAULT_INDEX_FILE, vaultIndexPath } from "./search-index-owner.mjs";

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "index-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ["vault-a", "vault-b", "vault-c"]) fs.mkdirSync(path.join(root, name));
  return root;
}

test("the first vault keeps the index file a runtime home always had; every other vault gets one of its own (Д-195)", (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, "index");
  const a = vaultIndexPath({ dir, vaultRoot: path.join(root, "vault-a") });
  assert.deepEqual([a.path, a.reason], [path.join(dir, DEFAULT_INDEX_FILE), "claimed"]);
  assert.equal(JSON.parse(fs.readFileSync(`${a.path}${CLAIM_SUFFIX}`, "utf8")).vault_root, path.join(root, "vault-a"));
  assert.equal(vaultIndexPath({ dir, vaultRoot: path.join(root, "vault-a") }).reason, "own");

  const b = vaultIndexPath({ dir, vaultRoot: path.join(root, "vault-b") });
  const c = vaultIndexPath({ dir, vaultRoot: path.join(root, "vault-c") });
  assert.match(path.basename(b.path), /^ai-dev-search-[0-9a-f]{12}\.sqlite$/);
  assert.notEqual(b.path, c.path);
  assert.deepEqual([b.reason, b.owner], ["another-vault", path.join(root, "vault-a")]);
  assert.equal(vaultIndexPath({ dir, vaultRoot: path.join(root, "vault-b") }).path, b.path, "the same file every time");
  // The same vault, spelled another way, is the same vault.
  assert.equal(vaultIndexPath({ dir, vaultRoot: path.join(root, "vault-b", "..", "vault-a", "") }).path, a.path);
});

test("an index written before claims existed is claimed by the first vault that opens it", (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, "index");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, DEFAULT_INDEX_FILE), "an index 2.x built");
  assert.equal(vaultIndexPath({ dir, vaultRoot: path.join(root, "vault-b") }).path, path.join(dir, DEFAULT_INDEX_FILE));
  assert.notEqual(vaultIndexPath({ dir, vaultRoot: path.join(root, "vault-a") }).path, path.join(dir, DEFAULT_INDEX_FILE));
});

test("a claim that cannot be read is nobody's to share, and a folder that takes no claim keeps the old file", (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, "index");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, `${DEFAULT_INDEX_FILE}${CLAIM_SUFFIX}`), "{ half a claim");
  for (const vault of ["vault-a", "vault-b"]) {
    assert.equal(vaultIndexPath({ dir, vaultRoot: path.join(root, vault) }).reason, "another-vault", vault);
  }
  // A folder that cannot be made (a file is in the way): nothing to claim in.
  const blocked = path.join(root, "file");
  fs.writeFileSync(blocked, "");
  const unclaimed = vaultIndexPath({ dir: path.join(blocked, "index"), vaultRoot: path.join(root, "vault-a") });
  assert.deepEqual([unclaimed.path, unclaimed.reason], [path.join(blocked, "index", DEFAULT_INDEX_FILE), "unclaimed"]);
});

test("vaults starting at the same moment agree on one owner", async (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, "index");
  const vaults = Array.from({ length: 8 }, (_, index) => {
    const vault = path.join(root, `racer-${index}`);
    fs.mkdirSync(vault);
    return vault;
  });
  const owner = fileURLToPath(new URL("./search-index-owner.mjs", import.meta.url));
  const script = `const { vaultIndexPath } = await import(${JSON.stringify(owner)}); process.stdout.write(JSON.stringify(vaultIndexPath({ dir: process.argv[1], vaultRoot: process.argv[2] })));`;
  const answers = await Promise.all(vaults.map((vault) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, vault], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`exit ${code}`))));
  })));
  const winners = answers.filter((answer) => answer.path === path.join(dir, DEFAULT_INDEX_FILE));
  assert.equal(winners.length, 1, JSON.stringify(answers));
  assert.equal(new Set(answers.map((answer) => answer.path)).size, vaults.length, "one file per vault");
  assert.equal(new Set(answers.map((answer) => answer.owner)).size, 1, "every one names the same owner");
  assert.deepEqual(fs.readdirSync(dir), [`${DEFAULT_INDEX_FILE}${CLAIM_SUFFIX}`], "no draft is left behind");
});
