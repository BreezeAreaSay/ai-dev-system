import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The cold launch path of the Docker launcher, driven against a `docker` that
// only writes down what it was asked to run. What is under test is the model
// mount after Д-62 moved AI_DEV_MODEL_PATH one level up (docs/DEFECTS.md Д-68).

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.resolve(scriptDir, "..", "..", "docker", "run-mcp.sh");
const powerShellLauncher = path.resolve(scriptDir, "..", "..", "docker", "run-mcp.ps1");

const recordingDocker = [
  "#!/bin/sh",
  'printf \'%s\\n\' "$@" > "$STUB_LOG"',
  "exit 0",
  ""
].join("\n");

async function launchWithModelPath(modelDir, context) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-launcher-"));
  const binDir = path.join(home, "bin");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "docker"), recordingDocker, { mode: 0o755 });
  const log = path.join(home, "docker.log");
  try {
    const result = spawnSync("sh", [launcher], {
      encoding: "utf8",
      input: "",
      env: {
        ...process.env,
        HOME: home,
        STUB_LOG: log,
        AI_DEV_IMAGE: "ai-dev-system:stub",
        AI_DEV_MODEL_PATH: modelDir,
        AI_DEV_RUNTIME_CONTAINER: "",
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`
      }
    });
    if (result.error?.code === "ENOENT") {
      context.skip("sh is unavailable on this host");
      return null;
    }
    return { ...result, recorded: await fs.readFile(log, "utf8").catch(() => "") };
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("the folder above the models is mounted read-only as /models", async (context) => {
  const models = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-weights-"));
  await fs.mkdir(path.join(models, "bge-m3-onnx"));
  try {
    const result = await launchWithModelPath(models, context);
    if (result === null) return;
    assert.equal(result.status, 0, result.stderr);
    const realModels = await fs.realpath(models);
    assert.ok(result.recorded.includes(`type=bind,source=${realModels},target=/models,readonly`), `mount missing from: ${result.recorded}`);
    assert.doesNotMatch(result.stderr, /holds neither/);
  } finally {
    await fs.rm(models, { recursive: true, force: true });
  }
});

test("a model folder with no model in it launches, and says why dense will be missing", async (context) => {
  const models = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-weights-"));
  try {
    const result = await launchWithModelPath(models, context);
    if (result === null) return;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /holds neither bge-m3-onnx\/ nor bge-m3\//);
    assert.match(result.recorded, /target=\/models,readonly/);
  } finally {
    await fs.rm(models, { recursive: true, force: true });
  }
});

for (const marker of ["pytorch_model.bin", "modules.json", "config.json", "onnx"]) {
  test(`the old value — a directory holding ${marker} — is refused before docker runs`, async (context) => {
    const oldStyle = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bge-m3-"));
    if (marker === "onnx") await fs.mkdir(path.join(oldStyle, marker));
    else await fs.writeFile(path.join(oldStyle, marker), "");
    try {
      const result = await launchWithModelPath(oldStyle, context);
      if (result === null) return;
      assert.equal(result.status, 64, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /AI_DEV_MODEL_PATH now names the folder above the models/);
      assert.match(result.stderr, /bge-m3-onnx\//);
      assert.equal(result.recorded, "", "docker was run despite the refusal");
    } finally {
      await fs.rm(oldStyle, { recursive: true, force: true });
    }
  });
}

// The PowerShell launcher makes the same promises, and was written on a machine
// that could not run it (docs/DEFECTS.md Д-70). pwsh is on the ubuntu and macOS
// runners as well as on Windows; the recording docker is a shell script, so
// this half runs where sh is the shell.
async function launchPowerShellWithModelPath(modelDir, context) {
  if (process.platform === "win32") {
    context.skip("the recording docker is a shell script");
    return null;
  }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-launcher-ps-"));
  const binDir = path.join(home, "bin");
  await fs.mkdir(binDir);
  await fs.writeFile(path.join(binDir, "docker"), recordingDocker, { mode: 0o755 });
  const log = path.join(home, "docker.log");
  try {
    const result = spawnSync("pwsh", ["-NoLogo", "-NonInteractive", "-File", powerShellLauncher], {
      encoding: "utf8",
      input: "",
      env: {
        ...process.env,
        HOME: home,
        STUB_LOG: log,
        AI_DEV_IMAGE: "ai-dev-system:stub",
        AI_DEV_MODEL_PATH: modelDir,
        AI_DEV_DEBUG_LOG: "",
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`
      }
    });
    if (result.error?.code === "ENOENT") {
      context.skip("pwsh is unavailable on this host");
      return null;
    }
    return { ...result, recorded: await fs.readFile(log, "utf8").catch(() => "") };
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("the PowerShell launcher mounts the folder above the models read-only as /models", async (context) => {
  const models = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-weights-"));
  await fs.mkdir(path.join(models, "bge-m3-onnx"));
  try {
    const result = await launchPowerShellWithModelPath(models, context);
    if (result === null) return;
    assert.equal(result.status, 0, result.stderr);
    const mount = result.recorded.match(/^type=bind,source=(.+),target=\/models,readonly$/m);
    assert.ok(mount, `mount missing from: ${result.recorded}`);
    // Resolve-Path keeps a symlinked temp directory as written; sh's realpath does not.
    assert.ok([models, await fs.realpath(models)].includes(mount[1]), `unexpected mount source ${mount[1]}`);
    assert.doesNotMatch(result.stderr, /holds neither/);
  } finally {
    await fs.rm(models, { recursive: true, force: true });
  }
});

test("the PowerShell launcher warns about a model folder with no model in it, and still launches", async (context) => {
  const models = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-weights-"));
  try {
    const result = await launchPowerShellWithModelPath(models, context);
    if (result === null) return;
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /holds neither bge-m3-onnx\\ nor bge-m3/);
    assert.match(result.recorded, /target=\/models,readonly/);
  } finally {
    await fs.rm(models, { recursive: true, force: true });
  }
});

for (const marker of ["pytorch_model.bin", "modules.json", "config.json", "onnx"]) {
  test(`the PowerShell launcher refuses the old value — a directory holding ${marker} — before docker runs`, async (context) => {
    const oldStyle = await fs.mkdtemp(path.join(os.tmpdir(), "ai-dev-bge-m3-"));
    if (marker === "onnx") await fs.mkdir(path.join(oldStyle, marker));
    else await fs.writeFile(path.join(oldStyle, marker), "");
    try {
      const result = await launchPowerShellWithModelPath(oldStyle, context);
      if (result === null) return;
      assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
      assert.match(result.stderr, /AI_DEV_MODEL_PATH now names the folder above the models/);
      assert.match(result.stderr, new RegExp(`holds model files itself \\(${marker.replace(".", "\\.")}\\)`));
      assert.match(result.stderr, /bge-m3-onnx/);
      assert.equal(result.recorded, "", "docker was run despite the refusal");
    } finally {
      await fs.rm(oldStyle, { recursive: true, force: true });
    }
  });
}
