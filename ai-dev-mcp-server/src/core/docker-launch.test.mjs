import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONTAINER_MODELS,
  CONTAINER_STATE_ROOT,
  CONTAINER_WORKSPACE,
  DEFAULT_DOCKER_IMAGE,
  DEFAULT_DOCKER_VOLUME,
  checkModelFolder,
  dockerLaunch,
  dockerRunArgs,
  isDirectDockerEntry,
  resolveDockerCommand,
  sharesHostState
} from "./docker-launch.mjs";

const mountsOf = (args) => args.flatMap((argument, index) => (args[index - 1] === "--mount" ? [argument] : []));

test("the entry runs the image with the volume, the host's state and the projects at their own path (Д-103, Д-312)", () => {
  const args = dockerRunArgs({ image: "img:1", projects: "/home/me/AI-Dev-Projects", state: "/home/me/.ai-dev/state", platform: "linux" });
  assert.deepEqual(args.slice(0, 3), ["run", "-i", "--rm"]);
  assert.equal(args.at(-1), "img:1");
  for (const [flag, value] of [["--network", "none"], ["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges:true"]]) {
    assert.equal(args[args.indexOf(flag) + 1], value, flag);
  }
  assert.ok(!args.includes("--user"), "the image's user, whatever started the session: the volume has one owner");
  assert.ok(args.includes("--read-only"));
  assert.deepEqual(mountsOf(args), [
    `type=volume,source=${DEFAULT_DOCKER_VOLUME},target=/data`,
    `type=bind,source=/home/me/.ai-dev/state,target=${CONTAINER_STATE_ROOT}`,
    "type=bind,source=/home/me/AI-Dev-Projects,target=/home/me/AI-Dev-Projects"
  ]);
  assert.equal(args[args.indexOf("--env") + 1], `AI_DEV_STATE_ROOT=${CONTAINER_STATE_ROOT}`);
});

test("on Windows the projects are at /workspace, a model folder is read-only at /models, and nothing else is added unasked", () => {
  const windows = dockerRunArgs({ image: "img", projects: "C:\\Users\\me\\AI-Dev-Projects", model: "C:\\models", platform: "win32" });
  assert.deepEqual(mountsOf(windows), [
    `type=volume,source=${DEFAULT_DOCKER_VOLUME},target=/data`,
    `type=bind,source=C:\\Users\\me\\AI-Dev-Projects,target=${CONTAINER_WORKSPACE}`,
    `type=bind,source=C:\\models,target=${CONTAINER_MODELS},readonly`
  ]);
  const bare = dockerRunArgs({ image: "img", platform: "darwin" });
  assert.deepEqual(mountsOf(bare), [`type=volume,source=${DEFAULT_DOCKER_VOLUME},target=/data`]);
  assert.ok(!bare.includes("--user") && !bare.includes("--env"));
  assert.throws(() => dockerRunArgs({ image: "" }), /No image to run/);
  assert.throws(() => dockerRunArgs({ image: "img", projects: "/a,b" }), /comma in its path, which a docker --mount cannot hold/);
  assert.deepEqual(dockerLaunch({}).args.at(-1), DEFAULT_DOCKER_IMAGE);
  assert.deepEqual(dockerLaunch({ docker: "/usr/local/bin/docker", image: "x" }).command, "/usr/local/bin/docker");
});

test("the host's state is shared where the image's user is the host's: Docker Desktop maps it, Linux needs uid 1000", () => {
  assert.equal(sharesHostState({ platform: "darwin", uid: 501 }), true);
  assert.equal(sharesHostState({ platform: "win32" }), true);
  assert.equal(sharesHostState({ platform: "linux", uid: 1000 }), true);
  assert.equal(sharesHostState({ platform: "linux", uid: 1001 }), false);
  assert.equal(sharesHostState({ platform: "linux", uid: 0 }), false);
});

test("the Docker CLI is named by its full path: a client started from the Dock has no shell PATH", () => {
  const present = (...files) => (file) => files.includes(file);
  assert.equal(resolveDockerCommand({ env: { PATH: "/usr/bin:/bin" }, platform: "linux", exists: present("/usr/bin/docker") }), "/usr/bin/docker");
  // Docker Desktop's own places on macOS, when the shell's PATH does not have it.
  assert.equal(resolveDockerCommand({ env: { PATH: "/usr/bin:/bin" }, platform: "darwin", home: "/Users/me", exists: present("/Users/me/.docker/bin/docker") }), "/Users/me/.docker/bin/docker");
  assert.equal(resolveDockerCommand({ env: { Path: "C:\\Windows" }, platform: "win32", exists: present("C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe") }), "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe");
  assert.equal(resolveDockerCommand({ env: { PATH: "relative:/nowhere" }, platform: "linux", exists: () => false }), "docker");
});

test("a model folder is the one above bge-m3-onnx/: the model folder itself is refused (Д-62)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-docker-launch-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "models", "bge-m3-onnx"), { recursive: true });
  assert.equal(checkModelFolder(path.join(root, "models")), path.join(root, "models"));
  assert.throws(() => checkModelFolder(path.join(root, "models", "bge-m3-onnx-missing")), /does not exist/);
  await fs.writeFile(path.join(root, "models", "bge-m3-onnx", "config.json"), "{}");
  assert.throws(() => checkModelFolder(path.join(root, "models", "bge-m3-onnx")), /holds model files itself \(config\.json\)\. Name the folder above it/);
});

test("a 3.0 entry is told from a 2.x launcher by what it runs", () => {
  assert.equal(isDirectDockerEntry({ command: "/usr/bin/docker", args: ["run", "-i"] }), true);
  assert.equal(isDirectDockerEntry({ command: "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe", args: ["run"] }), true);
  assert.equal(isDirectDockerEntry({ command: "/bin/sh", args: ["/repo/docker/run-mcp.sh"] }), false);
  assert.equal(isDirectDockerEntry({ command: "docker", args: ["exec", "-i", "c"] }), false);
  assert.equal(isDirectDockerEntry({}), false);
});
