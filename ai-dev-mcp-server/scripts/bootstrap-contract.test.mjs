import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDir, "..", "..");
const bootstrap = path.join(repositoryRoot, "bootstrap.sh");
const shell = process.platform === "win32"
  ? [
      process.env.AI_DEV_TEST_SH,
      "C:\\Program Files\\Git\\bin\\sh.exe",
      "C:\\Program Files\\Git\\usr\\bin\\sh.exe"
    ].find((candidate) => candidate && existsSync(candidate)) || "sh"
  : "sh";

function plan(args, home) {
  return spawnSync(shell, [bootstrap, "--plan", "--project-path", path.join(home, "projects"), ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home }
  });
}

test("Unix bootstrap defaults to the published image without a local build", async (context) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-"));
  try {
    const result = plan([], home);
    if (result.error?.code === "ENOENT") {
      context.skip("sh is unavailable on this host");
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.image, "ghcr.io/stonebridgeway/ai-dev-system:latest");
    assert.equal(output.build_local, 0);
    assert.equal(output.node_on_host_required, false);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("Unix bootstrap keeps local source builds explicit", async (context) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bootstrap-"));
  try {
    const result = plan(["--build-local"], home);
    if (result.error?.code === "ENOENT") {
      context.skip("sh is unavailable on this host");
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.image, "ai-dev-system:local");
    assert.equal(output.build_local, 1);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

// bootstrap.sh runs the launcher for its fast-start smoke check, the Dockerfile
// runs the entrypoint, and the packaged launcher is run by the installed
// command. All four were committed as 100644 once (docs/DEFECTS.md Д-58); the
// repository does store the bit, so the mode is asserted rather than trusted.
test("the shell scripts that get executed are committed as executable", async (context) => {
  const executables = [
    "bootstrap.sh",
    "docker/run-mcp.sh",
    "docker/entrypoint.sh",
    "packaging/launcher.sh"
  ];
  const result = spawnSync("git", ["ls-files", "-s", "--", ...executables], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  if (result.error?.code === "ENOENT") {
    context.skip("git is unavailable on this host");
    return;
  }
  if (result.status !== 0) {
    context.skip(`git ls-files failed: ${result.stderr.trim()}`);
    return;
  }
  const modes = new Map(
    result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [meta, file] = line.split("\t");
        return [file, meta.split(" ")[0]];
      })
  );
  for (const file of executables) {
    assert.equal(modes.get(file), "100755", `${file} is not committed as executable`);
  }
});

// A `docker` that answers `version`, fails `pull`, and still has the image
// cached. The Д-60 path is the one where the registry is unreachable and
// something older is sitting in the local cache.
const stubDocker = [
  "#!/bin/sh",
  'sub="$1"',
  "shift",
  'case "$sub" in',
  "  version) echo 27.0.0; exit 0 ;;",
  '  pull) echo "Error response from daemon: unauthorized" >&2; exit 1 ;;',
  "  image)",
  '    [ "$1" = "inspect" ] || exit 1',
  '    for a in "$@"; do',
  '      case "$a" in',
  "        *Created*) echo 2019-01-02T03:04:05.000000000Z; exit 0 ;;",
  "        *RepoDigests*) echo ghcr.io/example/ai-dev-system@sha256:cafebabe; exit 0 ;;",
  "      esac",
  "    done",
  "    exit 0 ;;",
  '  ps) echo "STUB: reached docker ps" >&2; exit 1 ;;',
  "esac",
  "exit 0",
  ""
].join("\n");

async function runWithStubDocker(args, context) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-stale-"));
  const binDir = path.join(home, "bin");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "docker"), stubDocker, { mode: 0o755 });
  try {
    const result = spawnSync(
      shell,
      [bootstrap, "--skip-smoke", "--skip-client-install", "--project-path", path.join(home, "projects"), ...args],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: home, PATH: `${binDir}${path.delimiter}${process.env.PATH}` }
      }
    );
    if (result.error?.code === "ENOENT") {
      context.skip("sh is unavailable on this host");
      return null;
    }
    return result;
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("a failed pull with a cached image stops instead of installing it", async (context) => {
  const result = await runWithStubDocker([], context);
  if (result === null) return;
  assert.equal(result.status, 69, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /2019-01-02T03:04:05/, "the age of the cached image is not reported");
  assert.match(result.stderr, /sha256:cafebabe/, "the digest of the cached image is not reported");
  assert.match(result.stderr, /--allow-stale-image/, "the override is not offered");
  // Stopping means stopping: the runtime container is never touched.
  assert.doesNotMatch(result.stderr, /reached docker ps/, "bootstrap continued past the stale image");
});

test("--allow-stale-image installs the cached image and keeps saying so", async (context) => {
  const result = await runWithStubDocker(["--allow-stale-image"], context);
  if (result === null) return;
  assert.match(result.stderr, /2019-01-02T03:04:05/, "the age of the cached image is not reported");
  // The stub fails `docker ps`, which only runs after the pull branch has let
  // the install through -- so reaching it is the proof that the flag works.
  assert.match(result.stderr, /reached docker ps/, "bootstrap stopped despite --allow-stale-image");
  assert.notEqual(result.status, 69, "the override still exited with the stale-image code");
});
