import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { noteIdentity } from "./search-documents.mjs";
import { CLAIM_SUFFIX, DEFAULT_INDEX_FILE, vaultIndexPath } from "./search-index-owner.mjs";
import { loadSqlite, sqliteSupport } from "./search-sqlite.mjs";

const needsSqlite = { skip: !sqliteSupport().available && sqliteSupport().reason };

/**
 * An index as an earlier version left it: the notes of `builtFrom` at these
 * paths, with the times it recorded for them, other documents beside them,
 * and the vault it names, if any.
 */
function earlierIndex(file, { builtFrom = "", notes = [], others = [], vaultRoot = "" } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new (loadSqlite().DatabaseSync)(file);
  try {
    db.exec("CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); CREATE TABLE documents(id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT NOT NULL, mtime REAL NOT NULL, content_hash TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO documents(id, path, source, mtime, content_hash) VALUES (?, ?, ?, ?, ?)");
    notes.forEach((relative, index) => {
      const note = noteIdentity(builtFrom, relative);
      insert.run(`note-${index}`, relative, "vault-note", note.mtime, note.contentHash);
    });
    others.forEach((relative, index) => insert.run(`other-${index}`, relative, "skill-registry", 0, ""));
    if (vaultRoot) db.prepare("INSERT INTO meta(key, value) VALUES ('vault_root', ?)").run(vaultRoot);
  } finally {
    db.close();
  }
}

/** A note at `relative` in `vault`, written `secondsAgo` before now. */
function note(vault, relative, secondsAgo = 3600, text = "# note\n") {
  const file = path.join(vault, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const when = new Date(Date.now() - secondsAgo * 1000);
  fs.utimesSync(file, when, when);
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
  const notes = ["02-knowledge/one.md", "02-knowledge/two.md", "05-projects/p.md", "03-skills-catalog/s.md"];
  for (const relative of notes) note(a, relative);
  note(b, "03-skills-catalog/s.md", 60);
  earlierIndex(path.join(dir, DEFAULT_INDEX_FILE), { builtFrom: a, notes, others: ["03-skills-catalog/registries/s", "/elsewhere/project/README.md"] });
  const first = vaultIndexPath({ dir, vaultRoot: b });
  assert.deepEqual([first.reason, path.basename(first.path) === DEFAULT_INDEX_FILE], ["another-vault", false], "a shell with another vault does not take it");
  assert.equal(fs.existsSync(path.join(dir, `${DEFAULT_INDEX_FILE}${CLAIM_SUFFIX}`)), false, "and claims nothing");
  assert.deepEqual([vaultIndexPath({ dir, vaultRoot: a }).path, vaultIndexPath({ dir, vaultRoot: a }).reason], [path.join(dir, DEFAULT_INDEX_FILE), "own"]);

  // An index that names its vault goes to that vault.
  const named = path.join(root, "named");
  earlierIndex(path.join(named, DEFAULT_INDEX_FILE), { builtFrom: a, notes: ["03-skills-catalog/s.md"], vaultRoot: b });
  assert.equal(vaultIndexPath({ dir: named, vaultRoot: a }).reason, "another-vault");
  assert.equal(vaultIndexPath({ dir: named, vaultRoot: path.join(b, "") }).reason, "claimed");

  // No document to tell by, or not an index at all: the first vault takes it, as before.
  const unknown = path.join(root, "unknown");
  fs.mkdirSync(unknown);
  fs.writeFileSync(path.join(unknown, DEFAULT_INDEX_FILE), "not a database");
  assert.equal(vaultIndexPath({ dir: unknown, vaultRoot: b }).reason, "claimed");
});

test("a vault holding copies of every note of the index is not the one it was built from; the one that is keeps it with its notes changed since (Д-219)", needsSqlite, (t) => {
  const root = tempRoot(t);
  const owner = path.join(root, "vault-a");
  const copy = path.join(root, "vault-b");
  // The owner: a catalog and notes; the other vault: the same files, copied
  // later — the case of two copies of the seed, where every path exists in both.
  const notes = Array.from({ length: 40 }, (_, index) => (index < 30 ? `03-skills-catalog/skill-${index}.md` : `02-knowledge/note-${index}.md`));
  for (const relative of notes) {
    note(owner, relative);
    note(copy, relative, 60);
  }
  const dir = path.join(root, "index");
  earlierIndex(path.join(dir, DEFAULT_INDEX_FILE), { builtFrom: owner, notes });
  assert.equal(vaultIndexPath({ dir, vaultRoot: copy }).reason, "another-vault", "the copy, starting first, does not take it");
  assert.equal(fs.existsSync(path.join(dir, `${DEFAULT_INDEX_FILE}${CLAIM_SUFFIX}`)), false);
  // The owner edited some notes after the index was built: still its index.
  for (const relative of notes.slice(0, 15)) note(owner, relative, 10);
  const kept = vaultIndexPath({ dir, vaultRoot: owner });
  assert.deepEqual([path.basename(kept.path), kept.reason], [DEFAULT_INDEX_FILE, "claimed"]);

  // A pull removed most of the notes since; those left are as they were: still its index.
  const pulled = path.join(root, "pulled");
  earlierIndex(path.join(pulled, DEFAULT_INDEX_FILE), { builtFrom: owner, notes });
  const removed = notes.slice(0, 28);
  for (const relative of removed) fs.rmSync(path.join(owner, relative));
  assert.equal(vaultIndexPath({ dir: pulled, vaultRoot: owner }).reason, "claimed");
  for (const relative of removed) note(owner, relative);

  // Most notes changed since: in doubt, a file of its own rather than another's index.
  const changed = path.join(root, "changed");
  earlierIndex(path.join(changed, DEFAULT_INDEX_FILE), { builtFrom: owner, notes });
  for (const relative of notes.slice(0, 30)) note(owner, relative, 5);
  assert.equal(vaultIndexPath({ dir: changed, vaultRoot: owner }).reason, "another-vault");

  // A note of the same name written in the same instant — files written
  // together share the clock's tick — is not the same note: its content differs.
  const twin = path.join(root, "twin");
  const twinOwner = path.join(twin, "vault-a");
  const twinOther = path.join(twin, "vault-b");
  for (const relative of ["02-knowledge/storage.md", "02-knowledge/deploy.md", "02-knowledge/auth.md"]) note(twinOwner, relative, 100, `# ${relative} A\n`);
  note(twinOther, "02-knowledge/storage.md", 100, "# Storage B\n");
  const { atime, mtime } = fs.statSync(path.join(twinOwner, "02-knowledge", "storage.md"));
  fs.utimesSync(path.join(twinOther, "02-knowledge", "storage.md"), atime, mtime);
  assert.equal(noteIdentity(twinOther, "02-knowledge/storage.md").mtime, noteIdentity(twinOwner, "02-knowledge/storage.md").mtime, "the same instant");
  earlierIndex(path.join(twin, "index", DEFAULT_INDEX_FILE), { builtFrom: twinOwner, notes: ["02-knowledge/storage.md", "02-knowledge/deploy.md", "02-knowledge/auth.md"] });
  assert.equal(vaultIndexPath({ dir: path.join(twin, "index"), vaultRoot: twinOther }).reason, "another-vault");
  assert.equal(vaultIndexPath({ dir: path.join(twin, "index"), vaultRoot: twinOwner }).reason, "claimed");

  // No note to tell by — only documents every vault has — goes to the first vault, as before.
  const noNotes = path.join(root, "no-notes");
  earlierIndex(path.join(noNotes, DEFAULT_INDEX_FILE), { others: ["03-skills-catalog/registries/s"] });
  assert.equal(vaultIndexPath({ dir: noNotes, vaultRoot: copy }).reason, "claimed");
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
