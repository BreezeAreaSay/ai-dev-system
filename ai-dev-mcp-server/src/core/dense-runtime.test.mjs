import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDenseRuntime, DENSE_PROBE_TTL_MS } from "./dense-runtime.mjs";

const MANIFEST = Object.freeze({
  model: "BAAI/bge-m3",
  export: "Xenova/bge-m3",
  revision: "c".repeat(40),
  dtype: "int8",
  dimensions: 1024,
  files: Object.freeze({ "config.json": "a".repeat(64), "onnx/model_int8.onnx": "b".repeat(64) })
});

function runtimeWith({ ready = true, supported = true, env = {}, now, legacyModelDir = "", exists, onnxModelDir = "/models/bge-m3-onnx", stampDir = "" } = {}) {
  const calls = { verify: [], embed: [], shutdown: 0 };
  const runtime = createDenseRuntime({
    manifest: MANIFEST,
    onnxModelDir,
    stampDir,
    legacyModelDir,
    env,
    onnxRuntime: {
      embedTexts: async (payload) => {
        calls.embed.push(payload);
        return { embeddings: [[1]], backend: "onnx" };
      },
      status: () => ({ worker: { started: true, pending_requests: 0, load_seconds: 0.2 } }),
      shutdown: async () => {
        calls.shutdown += 1;
        throw new Error("already gone");
      }
    },
    verify: async (options) => {
      calls.verify.push(options);
      return { ready, dir: onnxModelDir, missing: ready ? [] : ["onnx/model_int8.onnx"], mismatched: [] };
    },
    support: () => ({ supported, reason: supported ? "" : "no build for darwin-x64 (Intel Mac)" }),
    ...(exists ? { exists } : {}),
    ...(now ? { now } : {})
  });
  return { runtime, calls };
}

test("a verified export is the backend, with the manifest's provenance, and embeds", async () => {
  const { runtime, calls } = runtimeWith();
  const chosen = await runtime.describe();
  assert.deepEqual([chosen.backend, chosen.available], ["onnx", true]);
  assert.deepEqual(chosen.provenance, { backend: "onnx", model: "BAAI/bge-m3", revision: MANIFEST.revision, dtype: "int8", dimensions: 1024 });
  assert.deepEqual(chosen.legacy, { notes: [], command: "" });
  assert.deepEqual(await runtime.embed({ texts: ["x"] }), { embeddings: [[1]], backend: "onnx" });
  assert.deepEqual(calls.embed, [{ texts: ["x"] }]);
  await runtime.shutdown();
  assert.equal(calls.shutdown, 1, "a worker that is already gone does not make shutdown throw");
});

test("without the model, embedding is refused with the reason and the commands", async () => {
  const { runtime, calls } = runtimeWith({ ready: false });
  await assert.rejects(runtime.embed({ texts: ["x"] }), /Dense search is not installed: the model is not on this machine\. Run `npm run setup -- --dense`/);
  assert.deepEqual(calls.embed, []);
  const inContainer = runtimeWith({ ready: false, env: { AI_DEV_RUNTIME: "docker" } });
  assert.match((await inContainer.runtime.describe()).reason, /mount a folder holding bge-m3-onnx/);
  const intel = runtimeWith({ supported: false });
  assert.match((await intel.runtime.describe()).reason, /darwin-x64/);
});

test("the check trusts the record for a minute, and a refresh reads every file", async () => {
  let clock = 0;
  const { runtime, calls } = runtimeWith({ now: () => clock, stampDir: "/cache/dense-model" });
  await runtime.describe();
  await runtime.describe();
  clock = DENSE_PROBE_TTL_MS - 1;
  await runtime.describe();
  assert.equal(calls.verify.length, 1, "inside the minute the answer is kept");
  assert.equal(calls.verify[0].trustStamp, true);
  assert.match(calls.verify[0].stampFile, /verified-[0-9a-f]{16}\.json$/);
  clock = DENSE_PROBE_TTL_MS + 1;
  await runtime.describe();
  assert.equal(calls.verify.length, 2);
  await runtime.describe({ refresh: true });
  assert.deepEqual([calls.verify.length, calls.verify[2].trustStamp], [3, false]);
  const noStamp = runtimeWith();
  await noStamp.runtime.describe();
  assert.equal(noStamp.calls.verify[0].stampFile, "", "no record kept without a place for it");
});

test("2.x settings and weights left behind are named, with the one command", async () => {
  const { runtime } = runtimeWith({
    env: { AI_DEV_DENSE_BACKEND: "python", BGE_M3_PYTHON: "/venv/bin/python" },
    legacyModelDir: "/home/u/.ai-dev/models/bge-m3",
    exists: (target) => target === path.join("/home/u/.ai-dev/models/bge-m3", "pytorch_model.bin")
  });
  const chosen = await runtime.describe();
  assert.equal(chosen.available, true, "python asked for, onnx installed: the model there is used");
  assert.match(chosen.note, /AI_DEV_DENSE_BACKEND=python asks for the Python backend, which 3\.0 removed/);
  assert.equal(chosen.legacy.notes.length, 3);
  assert.equal(chosen.legacy.command, "npm run setup -- --dense");
  assert.ok(chosen.legacy.notes.some((note) => note.includes("torch weights")));
});

test("status is the embedding_status payload: backend, folder, partial downloads, worker", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dense-runtime-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, "onnx"), { recursive: true });
  await fs.writeFile(path.join(dir, "onnx", "model_int8.onnx.part"), Buffer.alloc(300));
  await fs.writeFile(path.join(dir, "onnx", "model_int8.onnx.part.json"), JSON.stringify({ format: 1, revision: MANIFEST.revision, sha256: "b".repeat(64), size: 1000 }));
  const { runtime } = runtimeWith({ ready: false, onnxModelDir: dir });
  const status = await runtime.status({});
  assert.deepEqual([status.backend, status.installed, status.available, status.model_dir], ["onnx", false, false, dir]);
  assert.deepEqual(status.partial, [{ file: "onnx/model_int8.onnx", bytes: 300, size: 1000 }]);
  assert.deepEqual(status.worker, { started: true, pending_requests: 0, load_seconds: 0.2 });
  assert.equal(status.dense_backend.backend, "onnx");
  assert.equal(status.dense_revision, MANIFEST.revision);
});
