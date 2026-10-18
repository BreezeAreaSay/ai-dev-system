import assert from "node:assert/strict";
import fsSync from "node:fs";
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
  probeStateSharing,
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
  // A double quote outside a quoted CSV field fails every session (Д-328).
  assert.throws(() => dockerRunArgs({ image: "img", state: '/home/me/"x"/state' }), /double quote in its path, which a docker --mount cannot hold/);
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

test("the state folder is shared only when the image's user, tried, writes it as the host user (Д-322, Д-331)", async (t) => {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-share-probe-"));
  t.after(() => fs.rm(state, { recursive: true, force: true }));
  const uid = process.getuid?.() ?? 0;
  const calls = [];
  // A container that writes the file it is given, as this user: what Docker Desktop and a matching uid do.
  const writes = (command, args) => {
    calls.push([command, ...args]);
    const target = args.at(-1);
    assert.ok(target.startsWith(`${CONTAINER_STATE_ROOT}/.ai-dev-share-probe-`), target);
    fsSync.writeFileSync(path.join(state, path.basename(target)), "");
    return { status: 0, stdout: "", stderr: "" };
  };
  assert.deepEqual(probeStateSharing({ docker: "/usr/bin/docker", image: "img:3", state, uid, run: writes }), { shared: true, tried: true, reason: "" });
  const [call] = calls;
  assert.deepEqual(call.slice(0, 9), ["/usr/bin/docker", "run", "--rm", "--pull", "never", "--network", "none", "--entrypoint", "touch"], "the image is not pulled for a probe");
  assert.ok(call.includes(`type=bind,source=${state},target=${CONTAINER_STATE_ROOT}`) && call.includes("img:3"));
  assert.deepEqual(await fs.readdir(state), [], "the probe leaves nothing behind");

  // Rootless Docker, userns-remap, Podman: uid 1000 in the container is no one here, and the folder refuses it.
  const refused = probeStateSharing({ image: "img", state, uid, run: () => ({ status: 1, stdout: "", stderr: "touch: cannot touch '/ai-dev-state/x': Permission denied\n" }) });
  assert.deepEqual([refused.shared, refused.tried], [false, true]);
  assert.match(refused.reason, /could not write your state folder \(touch: cannot touch .*Permission denied\)/);
  // Docker that did not run the image tried nothing: not a remapping host (Д-331).
  const down = probeStateSharing({ image: "img", state, uid, run: () => ({ status: 1, stdout: "", stderr: "failed to connect to the docker API at unix:///nowhere.sock\n" }) });
  assert.deepEqual([down.shared, down.tried], [false, false]);
  assert.match(down.reason, /Docker did not run img to try it \(failed to connect to the docker API/);
  const missing = probeStateSharing({ image: "img", state, uid, run: () => ({ status: 125, stdout: "", stderr: "docker: Error response from daemon: No such image: img\nRun 'docker run --help' for more information\n" }) });
  assert.match(missing.reason, /\(docker: Error response from daemon: No such image: img\)/, "Docker's own line, not its help trailer");
  const unreachable = probeStateSharing({ image: "img", state, uid, run: () => ({ error: new Error("spawn docker ENOENT") }) });
  assert.deepEqual([unreachable.shared, unreachable.tried], [false, false]);
  assert.match(unreachable.reason, /spawn docker ENOENT/);
  const lost = probeStateSharing({ image: "img", state, uid, run: () => ({ status: 0, stdout: "", stderr: "" }) });
  assert.deepEqual(lost, { shared: false, tried: true, reason: "what the image's user wrote into your state folder did not reach it" });
  // Written, but as another uid: the server's files would be someone else's here.
  const other = probeStateSharing({ image: "img", state, uid: uid + 4242, run: writes });
  assert.deepEqual([other.shared, other.tried], [false, true]);
  assert.match(other.reason, new RegExp(`is uid ${uid}'s, not yours \\(uid ${uid + 4242}\\)`));
  assert.deepEqual(await fs.readdir(state), []);
});
