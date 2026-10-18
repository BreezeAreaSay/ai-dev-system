import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PREPARED_MARKER, dateTree, restorePreparedTimes, settleTimes, writePreparedMarker } from "./image-data.mjs";

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-image-data-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function write(root, relative, content = "x\n") {
  await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await fs.writeFile(path.join(root, relative), content);
}

const mtime = async (target) => (await fs.stat(target)).mtimeMs;

test("dating a tree gives every file and folder, and the root, one time; links are not followed", async (t) => {
  const root = await scratch(t);
  const vault = path.join(root, "vault");
  await write(vault, "03-skills-catalog/sources/custom/a/SKILL.md");
  await write(vault, "01-system/Rules.md");
  await write(root, "outside/kept.md");
  const outside = path.join(root, "outside", "kept.md");
  const before = await mtime(outside);
  await fs.symlink(path.join(root, "outside"), path.join(vault, "linked"), "dir");
  const count = await dateTree(vault, 1_700_000_000);
  assert.equal(count, 8, "two files, five folders and the root");
  for (const target of ["03-skills-catalog/sources/custom/a/SKILL.md", "03-skills-catalog/sources/custom", "01-system", "."]) {
    assert.equal(await mtime(path.join(vault, target)), 1_700_000_000_000, target);
  }
  assert.equal(await mtime(outside), before, "nothing through the link");
});

test("settling rounds every time down to the second, as an image layer keeps it", async (t) => {
  const root = await scratch(t);
  await write(root, "a/b.json");
  await fs.utimes(path.join(root, "a", "b.json"), 1_700_000_000.75, 1_700_000_000.75);
  await fs.utimes(path.join(root, "a"), 1_700_000_005, 1_700_000_005);
  const changed = await settleTimes(root);
  assert.ok(changed >= 1);
  assert.equal(await mtime(path.join(root, "a", "b.json")), 1_700_000_000_000);
  assert.equal(await mtime(path.join(root, "a")), 1_700_000_005_000, "a whole second stays");
  assert.equal(await settleTimes(root), 0, "a settled tree has nothing left to round");
});

test("a volume's first start from the image's data gives the skill folders back their time, once", async (t) => {
  const data = await scratch(t);
  const vault = path.join(data, "ai-dev-system");
  await write(vault, "03-skills-catalog/sources/custom/a/SKILL.md");
  await write(vault, "03-skills-catalog/sources/external/x/skills/b/SKILL.md");
  await write(vault, "03-skills-catalog/registries/skills.index.json", "[]");
  await writePreparedMarker(data, { seconds: 1_700_000_000, version: "3.0.0" });
  // The copy into the volume stamped every folder with its own time.
  const copied = 1_800_000_000;
  for (const folder of ["03-skills-catalog/sources", "03-skills-catalog/sources/custom", "03-skills-catalog/sources/custom/a", "03-skills-catalog/registries"]) {
    await fs.utimes(path.join(vault, folder), copied, copied);
  }
  const first = await restorePreparedTimes({ dataRoot: data, vaultRoot: vault });
  assert.deepEqual(first, { restored: true, dated: 7 }, "sources, custom, a, external, x, skills, b — and the files are left alone");
  for (const folder of ["03-skills-catalog/sources", "03-skills-catalog/sources/custom/a", "03-skills-catalog/sources/external/x/skills/b"]) {
    assert.equal(await mtime(path.join(vault, folder)), 1_700_000_000_000, folder);
  }
  assert.equal(await mtime(path.join(vault, "03-skills-catalog/registries")), copied * 1000, "only the skill folders");
  await assert.rejects(fs.access(path.join(data, PREPARED_MARKER)), /ENOENT/);
  // Later starts, a skill the user adds: nothing is redated again.
  await write(vault, "03-skills-catalog/sources/custom/mine/SKILL.md");
  const added = await mtime(path.join(vault, "03-skills-catalog/sources/custom"));
  assert.deepEqual(await restorePreparedTimes({ dataRoot: data, vaultRoot: vault }), { restored: false, dated: 0 });
  assert.equal(await mtime(path.join(vault, "03-skills-catalog/sources/custom")), added);
});

test("a record that does not parse, or names no time, dates nothing and goes", async (t) => {
  const data = await scratch(t);
  const vault = path.join(data, "ai-dev-system");
  await write(vault, "03-skills-catalog/sources/custom/a/SKILL.md");
  await fs.writeFile(path.join(data, PREPARED_MARKER), "{ not json");
  assert.deepEqual(await restorePreparedTimes({ dataRoot: data, vaultRoot: vault }), { restored: false, dated: 0 });
  await assert.rejects(fs.access(path.join(data, PREPARED_MARKER)), /ENOENT/);
  await fs.writeFile(path.join(data, PREPARED_MARKER), JSON.stringify({ schema_version: 1 }));
  assert.deepEqual(await restorePreparedTimes({ dataRoot: data, vaultRoot: vault }), { restored: true, dated: 0 });
  await assert.rejects(fs.access(path.join(data, PREPARED_MARKER)), /ENOENT/);
  // A vault with no catalogue at all: the record still goes.
  const empty = path.join(data, "empty");
  await fs.mkdir(empty);
  await writePreparedMarker(data, { seconds: 1_700_000_000 });
  assert.deepEqual(await restorePreparedTimes({ dataRoot: data, vaultRoot: empty }), { restored: true, dated: 0 });
});

test("a container that may not date the folders leaves them, and the record goes: the first start rebuilds as on any volume", async (t) => {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    t.skip("needs root to make a folder of another owner");
    return;
  }
  const data = await scratch(t);
  const vault = path.join(data, "ai-dev-system");
  await write(vault, "03-skills-catalog/sources/custom/a/SKILL.md");
  await writePreparedMarker(data, { seconds: 1_700_000_000 });
  // The image's data is the image user's, writable by anyone (docker/Dockerfile);
  // the container runs as the host's user, here a uid of its own.
  for (const folder of ["", "ai-dev-system", "ai-dev-system/03-skills-catalog", "ai-dev-system/03-skills-catalog/sources",
    "ai-dev-system/03-skills-catalog/sources/custom", "ai-dev-system/03-skills-catalog/sources/custom/a"]) {
    await fs.chown(path.join(data, folder), 1000, 1000);
    await fs.chmod(path.join(data, folder), 0o777);
  }
  await fs.chmod(path.join(data, PREPARED_MARKER), 0o666);
  const { spawnSync } = await import("node:child_process");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", `
    const { restorePreparedTimes } = await import(${JSON.stringify(new URL("./image-data.mjs", import.meta.url).href)});
    console.log(JSON.stringify(await restorePreparedTimes({ dataRoot: ${JSON.stringify(data)}, vaultRoot: ${JSON.stringify(vault)} })));
  `], { encoding: "utf8", uid: 4242, gid: 4242 });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual([result.restored, result.dated], [true, 0]);
  assert.match(result.refused, /^EPERM/);
  await assert.rejects(fs.access(path.join(data, PREPARED_MARKER)), /ENOENT/);
});
