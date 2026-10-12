import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SEED_NEW_SUFFIX, SEED_STATE_FILE, compareVersions, describeSeedSync, syncSeed } from "./seed-sync.mjs";

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-seed-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** A seed folder as `npm run dist` ships one: the files and a manifest of their sha256. */
async function writeSeed(root, files) {
  await fs.rm(root, { recursive: true, force: true });
  const entries = [];
  for (const [relative, content] of Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
    entries.push({ path: relative, bytes: Buffer.byteLength(content), sha256: sha(content) });
  }
  const fingerprint = sha(entries.map((entry) => `${entry.path}\0${entry.sha256}`).join("\n"));
  await fs.writeFile(path.join(root, "public-seed.manifest.json"), JSON.stringify({ schema_version: 1, content_fingerprint: fingerprint, files: entries }));
  return root;
}

const read = (root, relative) => fs.readFile(path.join(root, relative), "utf8");
const exists = (target) => fs.access(target).then(() => true, () => false);

test("a new seed replaces what the user left alone and keeps what they changed, with the update's version beside it", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  const v1 = await writeSeed(path.join(root, "seed-1"), {
    "01-system/Agent Rules.md": "rules v1\n",
    "01-system/Operating Model.md": "model v1\n",
    "04-agent-workflows/Code Reviewer.md": "reviewer v1\n",
    "06-prompts/Prompt Patterns.md": "patterns v1\n",
    "03-skills-catalog/sources/x/old/SKILL.md": "old skill\n"
  });
  const first = await syncSeed({ seedRoot: v1, contentRoot: vault, version: "3.0.0" });
  assert.equal(first.status, "synced");
  assert.equal(first.added, 5);
  assert.equal(await read(vault, "01-system/Agent Rules.md"), "rules v1\n");

  // The user edits two notes and deletes one.
  await fs.writeFile(path.join(vault, "01-system", "Agent Rules.md"), "my rules\n");
  await fs.writeFile(path.join(vault, "06-prompts", "Prompt Patterns.md"), "my patterns\n");
  await fs.rm(path.join(vault, "04-agent-workflows", "Code Reviewer.md"));

  const v2 = await writeSeed(path.join(root, "seed-2"), {
    "01-system/Agent Rules.md": "rules v2\n",        // changed by both: a conflict
    "01-system/Operating Model.md": "model v2\n",    // changed by the seed only: replaced
    "04-agent-workflows/Code Reviewer.md": "reviewer v2\n", // deleted by the user: stays deleted
    "06-prompts/Prompt Patterns.md": "patterns v1\n", // changed by the user only: kept, no conflict
    "07-quality-gates/Quality Gate.md": "gate v2\n"   // new: added
    // sources/x/old/SKILL.md is dropped: removed, with its folders
  });
  const second = await syncSeed({ seedRoot: v2, contentRoot: vault, version: "3.1.0" });
  assert.equal(second.status, "synced");
  assert.deepEqual({ added: second.added, updated: second.updated, unchanged: second.unchanged, removed: second.removed },
    { added: 1, updated: 1, unchanged: 0, removed: 1 });
  assert.deepEqual(second.kept.sort(), ["01-system/Agent Rules.md", "06-prompts/Prompt Patterns.md"]);
  assert.deepEqual(second.conflicts, ["01-system/Agent Rules.md"]);

  assert.equal(await read(vault, "01-system/Agent Rules.md"), "my rules\n", "the user's file is never overwritten");
  assert.equal(await read(vault, `01-system/Agent Rules.md${SEED_NEW_SUFFIX}`), "rules v2\n", "the update's version sits beside it");
  assert.equal(await read(vault, "01-system/Operating Model.md"), "model v2\n");
  assert.equal(await read(vault, "06-prompts/Prompt Patterns.md"), "my patterns\n");
  assert.equal(await exists(path.join(vault, "06-prompts", `Prompt Patterns.md${SEED_NEW_SUFFIX}`)), false, "the seed did not change it: nothing to merge");
  assert.equal(await exists(path.join(vault, "04-agent-workflows", "Code Reviewer.md")), false, "what the user deleted stays deleted");
  assert.equal(await read(vault, "07-quality-gates/Quality Gate.md"), "gate v2\n");
  assert.equal(await exists(path.join(vault, "03-skills-catalog")), false, "a dropped file goes, and the folders it leaves empty");

  const described = await describeSeedSync(vault);
  assert.deepEqual(described.conflicts, ["01-system/Agent Rules.md"]);
  assert.equal(described.version, "3.1.0");
});

test("a conflict stays open until the user takes the update's version or deletes the .seed-new", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  await syncSeed({ seedRoot: await writeSeed(path.join(root, "s1"), { "a.md": "a1\n", "b.md": "b1\n" }), contentRoot: vault, version: "3.0.0" });
  await fs.writeFile(path.join(vault, "a.md"), "mine a\n");
  await fs.writeFile(path.join(vault, "b.md"), "mine b\n");
  const v2 = await writeSeed(path.join(root, "s2"), { "a.md": "a2\n", "b.md": "b2\n" });
  assert.deepEqual((await syncSeed({ seedRoot: v2, contentRoot: vault, version: "3.1.0" })).conflicts, ["a.md", "b.md"]);

  // A start of the same version reads the record and changes nothing.
  const again = await syncSeed({ seedRoot: v2, contentRoot: vault, version: "3.1.0" });
  assert.equal(again.status, "current");
  assert.deepEqual(again.conflicts, ["a.md", "b.md"]);

  // a: the user keeps theirs and deletes the update's copy. b: the user takes it.
  await fs.rm(path.join(vault, `a.md${SEED_NEW_SUFFIX}`));
  await fs.copyFile(path.join(vault, `b.md${SEED_NEW_SUFFIX}`), path.join(vault, "b.md"));
  assert.deepEqual((await describeSeedSync(vault)).conflicts, [], "doctor stops naming them at once");

  // A later seed that leaves both alone: no conflict comes back, and the
  // copy the user already took is cleared away.
  const v3 = await writeSeed(path.join(root, "s3"), { "a.md": "a2\n", "b.md": "b2\n", "c.md": "c3\n" });
  const third = await syncSeed({ seedRoot: v3, contentRoot: vault, version: "3.2.0" });
  assert.deepEqual(third.conflicts, []);
  assert.equal(await exists(path.join(vault, `b.md${SEED_NEW_SUFFIX}`)), false);
  assert.equal(await read(vault, "a.md"), "mine a\n");

  // An open conflict the next seed does not touch is carried, not forgotten.
  await fs.writeFile(path.join(vault, "c.md"), "mine c\n");
  await syncSeed({ seedRoot: await writeSeed(path.join(root, "s4"), { "a.md": "a2\n", "b.md": "b2\n", "c.md": "c4\n" }), contentRoot: vault, version: "3.3.0" });
  const fifth = await syncSeed({ seedRoot: await writeSeed(path.join(root, "s5"), { "a.md": "a2\n", "b.md": "b2\n", "c.md": "c4\n", "d.md": "d5\n" }), contentRoot: vault, version: "3.4.0" });
  assert.deepEqual(fifth.conflicts, ["c.md"]);
  assert.equal(await read(vault, `c.md${SEED_NEW_SUFFIX}`), "c4\n");
});

test("an older version leaves a newer vault alone; the same version with a new seed syncs", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  const old = await writeSeed(path.join(root, "old"), { "a.md": "a1\n" });
  const fresh = await writeSeed(path.join(root, "new"), { "a.md": "a2\n" });
  await syncSeed({ seedRoot: old, contentRoot: vault, version: "3.0.0" });
  await syncSeed({ seedRoot: fresh, contentRoot: vault, version: "3.1.0" });
  const back = await syncSeed({ seedRoot: old, contentRoot: vault, version: "3.0.0" });
  assert.equal(back.status, "newer");
  assert.equal(back.version, "3.1.0");
  assert.equal(await read(vault, "a.md"), "a2\n", "a client still configured with the previous version does not roll the vault back");

  // A development build keeps its version while its seed changes.
  const dev = await writeSeed(path.join(root, "dev"), { "a.md": "a3\n" });
  assert.equal((await syncSeed({ seedRoot: dev, contentRoot: vault, version: "3.1.0" })).status, "synced");
  assert.equal(await read(vault, "a.md"), "a3\n");
});

test("what is not a file of the seed's is the user's: links, folders, files in the way are left alone", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  const elsewhere = path.join(root, "elsewhere.md");
  await fs.writeFile(elsewhere, "the user's own note\n");
  await fs.mkdir(path.join(vault, "notes"), { recursive: true });
  await fs.symlink(elsewhere, path.join(vault, "notes", "linked.md"));
  await fs.mkdir(path.join(vault, "notes", "folder.md"));
  await fs.writeFile(path.join(vault, "blocked"), "a file where the seed has a folder\n");
  const seed = await writeSeed(path.join(root, "seed"), {
    "notes/linked.md": "seed\n",
    "notes/folder.md": "seed\n",
    "blocked/inner.md": "seed\n",
    "notes/fresh.md": "seed\n"
  });
  const result = await syncSeed({ seedRoot: seed, contentRoot: vault });
  assert.equal(result.added, 1);
  assert.deepEqual(result.kept.sort(), ["blocked/inner.md", "notes/folder.md", "notes/linked.md"]);
  assert.equal(await fs.readFile(elsewhere, "utf8"), "the user's own note\n", "a link is never written through");
  assert.equal((await fs.lstat(path.join(vault, "notes", "linked.md"))).isSymbolicLink(), true);
  assert.equal(await read(vault, "blocked"), "a file where the seed has a folder\n");
});

test("a seed made before the vault had a record: identical files are taken as shipped, different ones are the user's", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  await fs.mkdir(vault, { recursive: true });
  await fs.writeFile(path.join(vault, "same.md"), "same\n");
  await fs.writeFile(path.join(vault, "differs.md"), "the user's\n");
  const seed = await writeSeed(path.join(root, "seed"), { "same.md": "same\n", "differs.md": "seed\n" });
  const result = await syncSeed({ seedRoot: seed, contentRoot: vault });
  assert.equal(result.unchanged, 1);
  assert.deepEqual(result.conflicts, ["differs.md"]);
  assert.equal(await read(vault, "differs.md"), "the user's\n");
  assert.equal(await read(vault, `differs.md${SEED_NEW_SUFFIX}`), "seed\n");
  const state = JSON.parse(await read(vault, SEED_STATE_FILE));
  assert.equal(state.files["same.md"], sha("same\n"));
});

test("two servers starting at once sync once; a manifest that leaves the seed is refused", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  const seed = await writeSeed(path.join(root, "seed"), Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`n/${index}.md`, `${index}\n`])));
  const results = await Promise.all([1, 2, 3].map(() => syncSeed({ seedRoot: seed, contentRoot: vault, version: "3.0.0" })));
  assert.deepEqual(results.map((result) => result.status).sort(), ["current", "current", "synced"]);
  assert.equal(results.reduce((sum, result) => sum + result.added, 0), 40);

  const evil = path.join(root, "evil");
  await fs.mkdir(evil, { recursive: true });
  await fs.writeFile(path.join(evil, "public-seed.manifest.json"), JSON.stringify({ content_fingerprint: "x", files: [{ path: "../outside.md", sha256: sha("") }] }));
  await assert.rejects(syncSeed({ seedRoot: evil, contentRoot: vault }), /not a path inside the seed/);
  await assert.rejects(syncSeed({ seedRoot: path.join(root, "nothing"), contentRoot: vault }), /has no readable public-seed\.manifest\.json/);
});

test("versions compare by number, a prerelease before its release", () => {
  assert.equal(compareVersions("3.10.0", "3.9.1"), 1);
  assert.equal(compareVersions("3.0.0", "3.0.0"), 0);
  assert.equal(compareVersions("v3.0.0", "3.0.0"), 0);
  assert.equal(compareVersions("3.0.0-beta.2", "3.0.0"), -1);
  assert.equal(compareVersions("3.0.0-beta.10", "3.0.0-beta.2"), 1);
  assert.equal(compareVersions("2.9.9", "3.0.0-rc.1"), -1);
});
