import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLAIM_SUFFIX, DEFAULT_INDEX_FILE, vaultIndexPath } from "./search-index-owner.mjs";
import { loadSqlite, sqliteSupport } from "./search-sqlite.mjs";

const needsSqlite = { skip: !sqliteSupport().available && sqliteSupport().reason };

/** An index as an earlier version left it: documents at these paths, and the vault it names, if any. */
function earlierIndex(file, paths, vaultRoot = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new (loadSqlite().DatabaseSync)(file);
  try {
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE documents(id TEXT PRIMARY KEY, path TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO documents(id, path) VALUES (?, ?)");
    paths.forEach((relative, index) => insert.run(String(index), relative));
    if (vaultRoot) db.prepare("INSERT INTO meta(key, value) VALUES ('vault_root', ?)").run(vaultRoot);
  } finally {
    db.close();
  }
}

/** A note at `relative` in `vault`. */
function note(vault, relative) {
  fs.mkdirSync(path.dirname(path.join(vault, relative)), { recursive: true });
  fs.writeFileSync(path.join(vault, relative), "# note\n");
}

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

test("an index written before claims existed goes to the vault it was built from, whichever starts first", needsSqlite, (t) => {
  const root = tempRoot(t);
  const dir = path.join(root, "index");
  const a = path.join(root, "vault-a");
  const b = path.join(root, "vault-b");
  // vault-a: its own notes and the skills both vaults have; vault-b: the skills alone, as a seed beside a full vault.
  for (const relative of ["02-knowledge/one.md", "02-knowledge/two.md", "05-projects/p.md", "03-skills-catalog/s.md"]) note(a, relative);
  note(b, "03-skills-catalog/s.md");
  earlierIndex(path.join(dir, DEFAULT_INDEX_FILE), ["02-knowledge/one.md", "02-knowledge/two.md", "05-projects/p.md", "03-skills-catalog/s.md", "/elsewhere/project/README.md"]);
  const first = vaultIndexPath({ dir, vaultRoot: b });
  assert.deepEqual([first.reason, path.basename(first.path) === DEFAULT_INDEX_FILE], ["another-vault", false], "a shell with another vault does not take it");
  assert.equal(fs.existsSync(path.join(dir, `${DEFAULT_INDEX_FILE}${CLAIM_SUFFIX}`)), false, "and claims nothing");
  assert.deepEqual([vaultIndexPath({ dir, vaultRoot: a }).path, vaultIndexPath({ dir, vaultRoot: a }).reason], [path.join(dir, DEFAULT_INDEX_FILE), "own"]);

  // An index that names its vault goes to that vault.
  const named = path.join(root, "named");
  earlierIndex(path.join(named, DEFAULT_INDEX_FILE), ["03-skills-catalog/s.md"], b);
  assert.equal(vaultIndexPath({ dir: named, vaultRoot: a }).reason, "another-vault");
  assert.equal(vaultIndexPath({ dir: named, vaultRoot: path.join(b, "") }).reason, "claimed");

  // No document to tell by, or not an index at all: the first vault takes it, as before.
  const unknown = path.join(root, "unknown");
  fs.mkdirSync(unknown);
  fs.writeFileSync(path.join(unknown, DEFAULT_INDEX_FILE), "not a database");
  assert.equal(vaultIndexPath({ dir: unknown, vaultRoot: b }).reason, "claimed");
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
