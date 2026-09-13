import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runProcess } from "./process-runner.mjs";
import {
  configureRuntimeStateRoot,
  memoryScopeKeys,
  projectIdentityKey,
  repositoryId,
  resolveProjectIdentity,
  sameProjectIdentity
} from "./project-identity.mjs";
import { memoryKeysOf, projectIdOf, repositoryIdOf } from "../../hooks/lib.mjs";

async function runGit(cwd, args) {
  const result = await runProcess({ executable: "git", args: ["-C", cwd, ...args], cwd, timeoutMs: 20_000 });
  assert.equal(result.ok, true, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A clone with one committed package and a linked worktree of the same clone. */
async function cloneWithWorktree(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-repository-id-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = path.join(root, "checkout");
  await fs.mkdir(path.join(main, "packages", "web"), { recursive: true });
  await fs.writeFile(path.join(main, "packages", "web", "package.json"), "{\"name\":\"web\"}\n");
  await runGit(main, ["init", "-q", "-b", "main"]);
  await runGit(main, ["add", "."]);
  await runGit(main, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"]);
  const worktree = path.join(root, "worktrees", "task-one");
  await runGit(main, ["worktree", "add", "-q", "-b", "task/one", worktree]);
  return { main: await fs.realpath(main), worktree: await fs.realpath(worktree) };
}

test("nested directories without a project marker resolve to their Git project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-project-id-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, "packages", "web");
  await fs.mkdir(nested, { recursive: true });
  const initialized = await runProcess({
    executable: "git",
    args: ["init", root],
    cwd: root,
    timeoutMs: 15_000
  });
  assert.equal(initialized.ok, true);

  const fromRoot = await resolveProjectIdentity(root);
  const fromNested = await resolveProjectIdentity(nested);
  assert.equal(fromNested.project_id, fromRoot.project_id);
  assert.equal(fromNested.project_root, fromRoot.project_root);
  assert.equal(sameProjectIdentity(fromRoot, fromNested), true);
});

test("the nearest package boundary wins over a parent Git worktree", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-project-package-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, "apps", "web");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(nested, "package.json"), "{\"name\":\"web\"}\n");
  const initialized = await runProcess({
    executable: "git", args: ["init", root], cwd: root, timeoutMs: 15_000
  });
  assert.equal(initialized.ok, true);

  const identity = await resolveProjectIdentity(nested);
  assert.equal(identity.project_root, await fs.realpath(nested));
  assert.equal(identity.git.detected, true);
  assert.equal(identity.git.root, await fs.realpath(root));
});

test("the nearest nested Git boundary wins over a parent package", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-project-git-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const nested = path.join(root, "apps", "worker");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), "{\"name\":\"parent\"}\n");
  const initialized = await runProcess({
    executable: "git", args: ["init", nested], cwd: nested, timeoutMs: 15_000
  });
  assert.equal(initialized.ok, true);

  const identity = await resolveProjectIdentity(nested);
  const canonicalNested = await fs.realpath(nested);
  assert.equal(identity.project_root, canonicalNested);
  assert.equal(identity.git.root, canonicalNested);
});

test("the configured runtime-state .ai-dev is not treated as a project boundary", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-home-"));
  t.after(() => {
    configureRuntimeStateRoot("");
    return fs.rm(home, { recursive: true, force: true });
  });
  // The runtime lives at <home>/.ai-dev; a non-git project sits directly under it.
  const runtimeStateRoot = path.join(home, ".ai-dev");
  await fs.mkdir(path.join(runtimeStateRoot, "projects", "my-app"), { recursive: true });
  configureRuntimeStateRoot(runtimeStateRoot);
  const project = path.join(runtimeStateRoot, "projects", "my-app");

  const identity = await resolveProjectIdentity(project);
  // Without the fix, the walk stops at <home> because <home>/.ai-dev exists.
  assert.notEqual(identity.project_root, path.resolve(home));
});

test("filesystem projects use a stable canonical key", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-filesystem-id-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const identity = await resolveProjectIdentity(root);
  assert.match(identity.project_id, /^project-[a-f0-9]{20}$/);
  assert.equal(projectIdentityKey(identity), identity.project_id);
  assert.equal(identity.kind, "filesystem");
});

test("every worktree of one clone shares a repository id while project ids stay per tree", async (t) => {
  const { main, worktree } = await cloneWithWorktree(t);

  const fromMain = await resolveProjectIdentity(main);
  const fromWorktree = await resolveProjectIdentity(worktree);
  assert.match(fromMain.repository_id, /^repository-[a-f0-9]{20}$/);
  assert.equal(fromWorktree.repository_id, fromMain.repository_id, "memory follows the clone");
  assert.notEqual(fromWorktree.project_id, fromMain.project_id, "tasks stay bound to one working tree");
  assert.equal(await repositoryId(worktree), fromMain.repository_id);
  assert.deepEqual(memoryScopeKeys(fromWorktree), [fromWorktree.repository_id, fromWorktree.project_id]);

  // A package inside the clone keeps its own memory, and that memory is still
  // shared between the main checkout and the worktree.
  const nestedMain = await resolveProjectIdentity(path.join(main, "packages", "web"));
  const nestedWorktree = await resolveProjectIdentity(path.join(worktree, "packages", "web"));
  assert.equal(nestedMain.project_root, path.join(main, "packages", "web"));
  assert.equal(nestedWorktree.repository_id, nestedMain.repository_id);
  assert.notEqual(nestedMain.repository_id, fromMain.repository_id);
});

test("the runtime directory is not a project boundary, even when projects sit below it", async (t) => {
  // Windows puts the temp directory inside the user profile, and the server
  // creates `<home>/.ai-dev` there. The hook compared a candidate `.ai-dev`
  // against `<home>/.ai-dev/state` — one segment too deep, so the comparison
  // never matched and the walk stopped at `<home>`. Measured: two sibling
  // projects both hashed to project-e24ca70e5358e2931b79 in the hook while the
  // server told them apart, which means every project on such a machine shared
  // one memory key.
  // `outer` carries a marker of its own so the walk stops there and never
  // reaches whatever sits above the temp directory. That matters: an earlier
  // version of this test asserted two sibling projects differ, which held on
  // POSIX — where the fake home lands in /tmp with nothing above it — and
  // failed on Windows, where os.tmpdir() is inside the real user profile and
  // the walk found a marker there. What the fix guarantees is narrower and
  // decidable: a home whose only marker is `.ai-dev` is walked past.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-home-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outer = path.join(root, "outer");
  const home = path.join(outer, "home");
  await fs.mkdir(path.join(home, ".ai-dev", "state"), { recursive: true });
  await fs.writeFile(path.join(outer, "package.json"), JSON.stringify({ name: "outer" }), "utf8");
  const project = path.join(home, "AppData", "Local", "Temp", "project");
  await fs.mkdir(project, { recursive: true });

  const previousHome = process.env.AI_DEV_HOME;
  process.env.AI_DEV_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.AI_DEV_HOME;
    else process.env.AI_DEV_HOME = previousHome;
  });

  // Stopping at `home` would key the project to the runtime directory; reaching
  // `outer` is the boundary the markers actually describe.
  assert.equal(projectIdOf(project, false), projectIdOf(outer, false));
  assert.equal(projectIdOf(project, false), (await resolveProjectIdentity(project)).project_id);
});

test("a home reached through a symlink still has its runtime directory skipped", async (t) => {
  // macOS CI found this on the job's first run. Its temp directory is reached
  // through /var/folders, a symlink to /private/var, so the configured runtime
  // root and the canonical path the walk reads spelled the same directory two
  // ways and never compared equal — `.ai-dev` went back to counting as a
  // project marker and every project below the home shared one memory key
  // again. Reproduced on Linux with an explicit symlink, which is what this
  // test builds, so it fails everywhere if the canonicalisation is dropped.
  const real = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-real-"));
  const link = path.join(os.tmpdir(), `ai-dev-link-${process.pid}-${Date.now()}`);
  await fs.symlink(real, link, "junction").catch(() => fs.symlink(real, link));
  t.after(async () => {
    await fs.unlink(link).catch(() => fs.rm(link, { recursive: true, force: true })).catch(() => {});
    await fs.rm(real, { recursive: true, force: true });
  });

  const outer = path.join(link, "outer");
  const home = path.join(outer, "home");
  await fs.mkdir(path.join(home, ".ai-dev", "state"), { recursive: true });
  await fs.writeFile(path.join(outer, "package.json"), JSON.stringify({ name: "outer" }), "utf8");
  const project = path.join(home, "projects", "one");
  await fs.mkdir(project, { recursive: true });

  const previousHome = process.env.AI_DEV_HOME;
  process.env.AI_DEV_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.AI_DEV_HOME;
    else process.env.AI_DEV_HOME = previousHome;
  });

  assert.equal(projectIdOf(project, false), projectIdOf(outer, false));
  assert.equal(projectIdOf(project, false), (await resolveProjectIdentity(project)).project_id);
});

test("a real marker beside the runtime directory still stops the walk", async (t) => {
  // The other half of the same rule, and what makes the case above meaningful:
  // `.ai-dev` is skipped because it is the runtime tree, not because anything
  // at that level is ignored.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-marker-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outer = path.join(root, "outer");
  const home = path.join(outer, "home");
  await fs.mkdir(path.join(home, ".ai-dev", "state"), { recursive: true });
  await fs.writeFile(path.join(outer, "package.json"), JSON.stringify({ name: "outer" }), "utf8");
  await fs.writeFile(path.join(home, "go.mod"), "module home\n", "utf8");
  const project = path.join(home, "AppData", "Local", "Temp", "project");
  await fs.mkdir(project, { recursive: true });

  const previousHome = process.env.AI_DEV_HOME;
  process.env.AI_DEV_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.AI_DEV_HOME;
    else process.env.AI_DEV_HOME = previousHome;
  });

  assert.notEqual(projectIdOf(project, false), projectIdOf(outer, false));
  assert.equal(projectIdOf(project, false), (await resolveProjectIdentity(project)).project_id);
});

test("the hooks copy of the derivation answers exactly like the server", async (t) => {
  const { main, worktree } = await cloneWithWorktree(t);
  for (const projectRoot of [main, worktree, path.join(main, "packages", "web")]) {
    const identity = await resolveProjectIdentity(projectRoot);
    assert.equal(repositoryIdOf(projectRoot), identity.repository_id, projectRoot);
    assert.equal(projectIdOf(projectRoot), identity.project_id, projectRoot);
    assert.deepEqual(memoryKeysOf(projectRoot), memoryScopeKeys(identity), projectRoot);
  }
});

test("the hook and the server agree on a project reached through another spelling of its path", async (t) => {
  // The server resolves a root with fs.realpath before hashing it; the hook
  // copy hashed what it was handed. A symlink here, and on Windows the 8.3
  // short name a temporary directory is handed out under, then keyed the hook's
  // memory under an id the server never reads. Measured on windows-latest.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-alias-id-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const real = path.join(root, "project");
  const alias = path.join(root, "alias");
  await fs.mkdir(real, { recursive: true });
  await fs.symlink(real, alias, "junction").catch(() => fs.symlink(real, alias));

  const identity = await resolveProjectIdentity(alias);
  assert.deepEqual(memoryKeysOf(alias, false), [identity.project_id]);
  assert.deepEqual(memoryKeysOf(alias, false), memoryKeysOf(real, false));
});

test("a hook fired inside a project keys its memory to the project, not to the subdirectory", async (t) => {
  // The server walks up to the nearest project boundary before hashing; the
  // hook copy hashed whatever directory it was handed. Anywhere a marker sits
  // above the directory in question the two disagreed — which is what
  // windows-latest was measuring, one temporary directory at a time.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-boundary-id-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const nested = path.join(project, "src", "deep");
  await fs.mkdir(nested, { recursive: true });
  await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ name: "boundary" }), "utf8");

  const identity = await resolveProjectIdentity(nested);
  assert.equal(identity.project_root, await fs.realpath(project));
  assert.deepEqual(memoryKeysOf(nested, false), [identity.project_id]);
  assert.deepEqual(memoryKeysOf(nested, false), memoryKeysOf(project, false));
});

test("projects outside Git fall back to the project id as their memory key", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-no-git-id-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const identity = await resolveProjectIdentity(root);
  assert.equal(identity.repository_id, null);
  assert.equal(await repositoryId(root), null);
  assert.deepEqual(memoryScopeKeys(identity), [identity.project_id]);
  assert.deepEqual(memoryKeysOf(root, false), [identity.project_id]);
  assert.deepEqual(memoryScopeKeys("project-bare"), ["project-bare"]);
  assert.deepEqual(memoryScopeKeys({ repositoryId: "repository-1", projectId: "repository-1" }), ["repository-1"]);
});
