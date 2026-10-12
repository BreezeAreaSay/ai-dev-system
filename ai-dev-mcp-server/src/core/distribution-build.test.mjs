import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { globToRegExp, planDistribution, readAllowlist } from "./distribution-build.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("globs: ** spans folders and none, * and ? stay within one name", () => {
  const match = (pattern, value) => globToRegExp(pattern).test(value);
  assert.equal(match("src/**", "src/core/a.mjs"), true);
  assert.equal(match("src/**", "src/a.mjs"), true);
  assert.equal(match("**/*.test.mjs", "a.test.mjs"), true);
  assert.equal(match("**/*.test.mjs", "src/core/a.test.mjs"), true);
  assert.equal(match("**/*.test.mjs", "src/core/a.mjs"), false);
  assert.equal(match("models/*.manifest.json", "models/bge-m3.manifest.json"), true);
  assert.equal(match("models/*.manifest.json", "models/x/bge-m3.manifest.json"), false);
  assert.equal(match("a?.json", "ab.json"), true);
  assert.equal(match("a.json", "a-json"), false, "a dot is a dot");
});

test("one allowlist, two targets: the same files, each where its target keeps them", async () => {
  const [dist, docker] = await Promise.all([
    planDistribution({ repositoryRoot, target: "dist" }),
    planDistribution({ repositoryRoot, target: "docker" })
  ]);
  const distPaths = new Set(dist.map((item) => item.destination));
  const dockerPaths = new Set(docker.map((item) => item.destination));
  for (const [inDist, inDocker] of [
    ["ai-dev-mcp-server/bin/ai-dev.mjs", "app/bin/ai-dev.mjs"],
    ["ai-dev-mcp-server/src/mcp-stdio.mjs", "app/src/mcp-stdio.mjs"],
    ["ai-dev-mcp-server/models/bge-m3.manifest.json", "app/models/bge-m3.manifest.json"],
    ["ai-dev-mcp-server/hooks/with-node.sh", "app/hooks/with-node.sh"],
    ["frontend-qa/frontend_qa_runner.mjs", "runtime/frontend-qa/frontend_qa_runner.mjs"],
    ["search-eval/search_eval_cases.json", "runtime/search-eval/search_eval_cases.json"],
    ["seed/public-seed.manifest.json", "public-seed/public-seed.manifest.json"],
    ["LICENSE", "LICENSE"]
  ]) {
    assert.ok(distPaths.has(inDist), inDist);
    assert.ok(dockerPaths.has(inDocker), inDocker);
  }
  assert.ok(dockerPaths.has("Dockerfile") && dockerPaths.has("container/entrypoint.sh"));
  assert.ok(!distPaths.has("Dockerfile"), "the image's own files are the image's");
  assert.equal([...distPaths].filter((item) => item.endsWith(".test.mjs")).length, 0, "no tests ship");
  // Everything but the image's own files ships in both.
  assert.equal(dist.length, docker.length - 2);
  const seed = JSON.parse(await fs.readFile(path.join(repositoryRoot, "docker", "public-seed", "public-seed.manifest.json"), "utf8"));
  assert.equal(dist.filter((item) => item.group === "seed").length, seed.files.length + 1, "the seed is what its manifest lists, and the manifest");
});

async function fixture(t, groups, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-allowlist-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), content);
  }
  return { root, allowlist: { schema_version: 1, groups } };
}

test("a pattern that matches nothing, two files at one place, a link: the plan stops", async (t) => {
  const missing = await fixture(t, [{ name: "server", from: "s", to: { dist: "s" }, include: ["bin/ai-dev.mjs", "src/**"] }], { "s/src/a.mjs": "" });
  await assert.rejects(planDistribution({ repositoryRoot: missing.root, target: "dist", allowlist: missing.allowlist }),
    /The server pattern "bin\/ai-dev\.mjs" matches no file under/);

  const twice = await fixture(t, [
    { name: "one", from: "a", to: { dist: "." }, include: ["README.md"] },
    { name: "two", from: "b", to: { dist: "." }, include: ["README.md"] }
  ], { "a/README.md": "a", "b/README.md": "b" });
  await assert.rejects(planDistribution({ repositoryRoot: twice.root, target: "dist", allowlist: twice.allowlist }),
    /README\.md comes from both the one and the two groups/);

  const linked = await fixture(t, [{ name: "server", from: "s", to: { dist: "s" }, include: ["src/**"] }], { "s/src/a.mjs": "" });
  await fs.symlink(path.join(linked.root, "s", "src", "a.mjs"), path.join(linked.root, "s", "src", "b.mjs"));
  await assert.rejects(planDistribution({ repositoryRoot: linked.root, target: "dist", allowlist: linked.allowlist }), /is a link/);

  const outside = await fixture(t, [{ name: "evil", from: "s", to: { dist: "../up" }, include: ["a.txt"] }], { "s/a.txt": "" });
  await assert.rejects(planDistribution({ repositoryRoot: outside.root, target: "dist", allowlist: outside.allowlist }), /would land outside/);

  const excluded = await fixture(t, [{ name: "server", from: "s", to: { dist: "s" }, include: ["src/**"], exclude: ["**/*.test.mjs"] }], { "s/src/a.test.mjs": "" });
  await assert.rejects(planDistribution({ repositoryRoot: excluded.root, target: "dist", allowlist: excluded.allowlist }),
    /matches no file/, "a pattern whose every file is excluded matches nothing either");
});

test("the allowlist names a group for each target, and every group lands somewhere", async () => {
  const allowlist = await readAllowlist(repositoryRoot);
  assert.equal(allowlist.schema_version, 1);
  for (const group of allowlist.groups) {
    assert.ok(Object.keys(group.to ?? {}).length, `${group.name} lands nowhere`);
    assert.ok(group.manifest || group.include?.length, `${group.name} names no files`);
  }
});
