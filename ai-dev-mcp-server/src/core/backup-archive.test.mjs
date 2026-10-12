import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { BACKUP_MANIFEST, ZipWriter, backupFileName, createBackup, landingPath, restoreBackup } from "./backup-archive.mjs";
import { readZipEntries } from "./model-archive.mjs";

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-backup-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
}

const read = (root, relative) => fs.readFile(path.join(root, relative), "utf8");
const exists = (target) => fs.lstat(target).then(() => true, () => false);

/** An install: a vault (with what a backup leaves out) and the runtime's state. */
async function install(root) {
  const vault = path.join(root, "vault");
  const runtime = path.join(root, ".ai-dev");
  await put(vault, {
    "01-system/Agent Rules.md": "rules\n",
    "02-knowledge/заметка проекта.md": "кириллица и пробелы\n",
    "02-knowledge/empty.md": "",
    "03-skills-catalog/sources/external/archify/node_modules/ajv/index.js": "vendored\n",
    "09-mcp/ai-dev-mcp-server/node_modules/zod/index.js": "a dependency\n",
    ".git/HEAD": "ref\n",
    ".obsidian/cache/x": "cache\n",
    "cache.sqlite": "index\n"
  });
  await fs.symlink(path.join(vault, "01-system"), path.join(vault, "linked"));
  await put(runtime, {
    "state/instincts.json": "{\"a\":1}\n",
    "state/usage/events.jsonl": "{\"e\":1}\n",
    "cache/search-index/ai-dev-search.sqlite": "rebuilt, not backed up\n"
  });
  return { vault, runtime };
}

test("a backup keeps the vault and the state, leaves out what is rebuilt, and comes back byte for byte", async (t) => {
  const root = await scratch(t);
  const { vault, runtime } = await install(root);
  const at = new Date("2026-10-12T08:30:00Z");
  const made = await createBackup({ contentRoot: vault, runtimeRoot: runtime, destination: path.join(root, "backups"), label: "before upgrade!", layout: "package", now: at });
  assert.equal(path.basename(made.archive), "ai-dev-system_2026-10-12T08-30-00Z_before-upgrade.zip");
  assert.equal(made.files, 6);
  assert.deepEqual(made.skipped, [{ path: "vault/linked", reason: "a link" }]);
  assert.equal((await read(path.dirname(made.archive), `${path.basename(made.archive)}.sha256`)).trim(), `${made.sha256}  ${path.basename(made.archive)}`);
  const names = [...(await readZipEntries(made.archive)).keys()].sort();
  assert.deepEqual(names, [
    BACKUP_MANIFEST,
    "runtime/state/instincts.json",
    "runtime/state/usage/events.jsonl",
    "vault/01-system/Agent Rules.md",
    "vault/02-knowledge/empty.md",
    "vault/02-knowledge/заметка проекта.md",
    "vault/03-skills-catalog/sources/external/archify/node_modules/ajv/index.js"
  ], "dependencies, VCS, caches and indexes stay out; the vendored tree a skill runs from does not");

  const elsewhere = path.join(root, "elsewhere");
  const result = await restoreBackup({ archive: made.archive, contentRoot: vault, runtimeRoot: runtime, target: elsewhere });
  assert.equal(result.restored, 6);
  assert.equal(await read(elsewhere, "vault/02-knowledge/заметка проекта.md"), "кириллица и пробелы\n");
  assert.equal(await read(elsewhere, "vault/02-knowledge/empty.md"), "");
  assert.equal(await read(elsewhere, "runtime/state/usage/events.jsonl"), "{\"e\":1}\n");

  // Lost: the vault and the state. Restored in place, each part where it belongs.
  await fs.rm(vault, { recursive: true, force: true });
  await fs.rm(path.join(runtime, "state"), { recursive: true, force: true });
  const back = await restoreBackup({ archive: made.archive, contentRoot: vault, runtimeRoot: runtime });
  assert.deepEqual(back.places, [vault, path.join(runtime, "state")]);
  assert.equal(await read(vault, "01-system/Agent Rules.md"), "rules\n");
  assert.equal(await read(runtime, "state/instincts.json"), "{\"a\":1}\n");
});

test("a restore writes over nothing unless told, and checks that before the first file", async (t) => {
  const root = await scratch(t);
  const { vault, runtime } = await install(root);
  const made = await createBackup({ contentRoot: vault, runtimeRoot: runtime, destination: path.join(root, "b") });
  await fs.writeFile(path.join(vault, "01-system", "Agent Rules.md"), "changed since\n");
  await fs.rm(path.join(vault, "02-knowledge", "empty.md"));
  await assert.rejects(restoreBackup({ archive: made.archive, contentRoot: vault, runtimeRoot: runtime }),
    /5 file\(s\) would be written over, the first .*; nothing was restored/);
  assert.equal(await read(vault, "01-system/Agent Rules.md"), "changed since\n");
  assert.equal(await exists(path.join(vault, "02-knowledge", "empty.md")), false, "not even the one that was missing");

  await restoreBackup({ archive: made.archive, contentRoot: vault, runtimeRoot: runtime, overwrite: true });
  assert.equal(await read(vault, "01-system/Agent Rules.md"), "rules\n");
});

test("a damaged archive, a changed file inside it, or a name that leaves its folder restores nothing", async (t) => {
  const root = await scratch(t);
  const { vault, runtime } = await install(root);
  const made = await createBackup({ contentRoot: vault, runtimeRoot: runtime, destination: path.join(root, "b") });
  const bytes = await fs.readFile(made.archive);
  bytes[40] ^= 0xff;
  await fs.writeFile(made.archive, bytes);
  const target = path.join(root, "t");
  await assert.rejects(restoreBackup({ archive: made.archive, target }), /does not match .*\.sha256: the archive is damaged or was changed; nothing was restored/);
  assert.equal(await exists(target), false);

  // An archive whose manifest says one thing and whose entry holds another.
  const forged = path.join(root, "forged.zip");
  await writeZip(forged, {
    "vault/a.md": "what the entry holds\n",
    [BACKUP_MANIFEST]: JSON.stringify({ format: "ai-dev-backup", schema_version: 2, files: [{ path: "vault/a.md", bytes: 4, sha256: "0".repeat(64) }] })
  });
  await assert.rejects(restoreBackup({ archive: forged, target: path.join(root, "f") }), /does not match its sha256 in the manifest/);
  assert.equal(await exists(path.join(root, "f", "vault", "a.md")), false, "a file that fails its check is not left behind");

  const escaping = path.join(root, "escaping.zip");
  await writeZip(escaping, {
    "vault/../../evil.md": "x",
    [BACKUP_MANIFEST]: JSON.stringify({ format: "ai-dev-backup", schema_version: 2, files: [{ path: "vault/../../evil.md", sha256: "" }] })
  });
  await assert.rejects(restoreBackup({ archive: escaping, contentRoot: vault, runtimeRoot: runtime }), /cannot be restored \(outside its folder/);
  assert.equal(await exists(path.join(root, "evil.md")), false);
  assert.equal(landingPath(root, "C:/x"), null);
  assert.equal(landingPath(root, "/etc/passwd"), null);
  assert.equal(landingPath(root, "a/b.md"), path.join(root, "a", "b.md"));
});

test("an archive of the 2.x script holds a whole vault: it goes into a folder named for it", async (t) => {
  const root = await scratch(t);
  const old = path.join(root, "ai-dev-system_2026-01-01_10-00-00_manual.zip");
  await writeZip(old, {
    "01-system/AI Dev Control Center.md": "center\n",
    "09-mcp/ai-dev-mcp-server/package.json": "{}\n",
    [BACKUP_MANIFEST]: JSON.stringify({ schema_version: 1, files: 2, contains_local_vault_content: true })
  });
  await assert.rejects(restoreBackup({ archive: old, contentRoot: path.join(root, "v"), runtimeRoot: path.join(root, "r") }),
    /made by the 2\.x backup script and holds a whole vault: name an empty folder to restore it into \(--to\)/);
  const result = await restoreBackup({ archive: old, target: path.join(root, "restored") });
  assert.equal(result.schema, 1);
  assert.equal(await read(path.join(root, "restored"), "01-system/AI Dev Control Center.md"), "center\n");
  await assert.rejects(restoreBackup({ archive: path.join(root, "nope.zip"), target: root }), /ENOENT/);
});

test("labels are made safe for a file name", () => {
  const at = new Date("2026-10-12T00:00:00.123Z");
  assert.equal(backupFileName("", at), "ai-dev-system_2026-10-12T00-00-00Z_manual.zip");
  assert.equal(backupFileName("../../etc", at), "ai-dev-system_2026-10-12T00-00-00Z_..-..-etc.zip", "no separator survives");
});

/** A zip as another tool would write it, through the same writer: names and contents only. */
async function writeZip(file, entries) {
  const handle = await fs.open(file, "w");
  try {
    const zip = new ZipWriter(handle);
    for (const [name, content] of Object.entries(entries)) await zip.add(name, Readable.from([Buffer.from(content)]), new Date());
    await zip.finish();
  } finally {
    await handle.close();
  }
}
