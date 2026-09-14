import assert from "node:assert/strict";
import test from "node:test";
import { createDenseRuntime, legacyDenseRevision } from "./dense-runtime.mjs";

const MANIFEST = Object.freeze({
  model: "BAAI/bge-m3",
  export: "Xenova/bge-m3",
  revision: "c".repeat(40),
  dtype: "int8",
  dimensions: 1024
});

function runtimeWith({ onnxReady = true, pythonReady = true, env = {}, now } = {}) {
  const calls = { verify: 0, onnx: [], python: [], shutdown: [] };
  const runtime = createDenseRuntime({
    manifest: MANIFEST,
    onnxModelDir: "/models/bge-m3-onnx",
    onnxRuntime: {
      embedTexts: async (payload) => {
        calls.onnx.push(payload);
        return { embeddings: [[1]], backend: "onnx" };
      },
      shutdown: async () => calls.shutdown.push("onnx")
    },
    pythonRuntime: {
      request: async (payload) => {
        calls.python.push(payload);
        return { embeddings: [[2]], backend: "bge-m3-worker" };
      },
      shutdown: () => calls.shutdown.push("python")
    },
    pythonReady: async () => pythonReady,
    env,
    verify: async () => {
      calls.verify += 1;
      return {
        ready: onnxReady,
        dir: "/models/bge-m3-onnx",
        missing: onnxReady ? [] : ["onnx/model_int8.onnx"],
        mismatched: []
      };
    },
    ...(now ? { now } : {})
  });
  return { runtime, calls };
}

test("a verified export makes onnx the backend, with the manifest's provenance", async () => {
  const { runtime } = runtimeWith();
  const chosen = await runtime.describe();

  assert.equal(chosen.backend, "onnx");
  assert.equal(chosen.available, true);
  assert.deepEqual(chosen.provenance, {
    backend: "onnx",
    model: "BAAI/bge-m3",
    revision: MANIFEST.revision,
    dtype: "int8",
    dimensions: 1024
  });
  assert.equal(chosen.onnx.ready, true);
  assert.equal(chosen.python.ready, true);
});

test("without an export the legacy stack runs, and its vectors say so", async () => {
  const { runtime } = runtimeWith({ onnxReady: false });
  const chosen = await runtime.describe();

  assert.equal(chosen.backend, "python");
  assert.equal(chosen.available, true);
  assert.equal(chosen.provenance.backend, "python");
  assert.equal(chosen.provenance.dtype, "fp32");
  assert.equal(chosen.provenance.revision, "unpinned", "an unpinned download is recorded as unpinned, not faked");
  assert.deepEqual(chosen.onnx.missing, ["onnx/model_int8.onnx"]);
});

test("the legacy revision is taken from the environment when one is pinned", async () => {
  assert.equal(legacyDenseRevision({}), "unpinned");
  assert.equal(legacyDenseRevision({ BGE_M3_PYTHON_REVISION: " abc123 " }), "abc123");
  const { runtime } = runtimeWith({ onnxReady: false, env: { BGE_M3_PYTHON_REVISION: "deadbeef" } });
  assert.equal((await runtime.describe()).provenance.revision, "deadbeef");
});

test("with neither backend installed the runtime refuses and says what to run", async () => {
  const { runtime, calls } = runtimeWith({ onnxReady: false, pythonReady: false });
  const chosen = await runtime.describe();

  assert.equal(chosen.available, false);
  await assert.rejects(() => runtime.embed({ texts: ["hello"] }), /npm run setup -- --dense/);
  assert.equal(calls.onnx.length + calls.python.length, 0, "nothing is asked of a backend that cannot run");
});

test("embedding goes to the backend that was chosen, and only to that one", async () => {
  const onnx = runtimeWith();
  await onnx.runtime.embed({ texts: ["hello"] });
  assert.equal(onnx.calls.onnx.length, 1);
  assert.equal(onnx.calls.python.length, 0);

  const legacy = runtimeWith({ onnxReady: false });
  await legacy.runtime.embed({ texts: ["hello"] }, { timeoutMs: 5 });
  assert.equal(legacy.calls.python.length, 1);
  assert.equal(legacy.calls.onnx.length, 0);
});

test("AI_DEV_DENSE_BACKEND=python uses the legacy stack even with an export present", async () => {
  const { runtime, calls } = runtimeWith({ env: { AI_DEV_DENSE_BACKEND: "python" } });
  const chosen = await runtime.describe();
  assert.equal(chosen.backend, "python");
  await runtime.embed({ texts: ["hello"] });
  assert.equal(calls.python.length, 1);
});

test("a typo in the backend variable is reported rather than obeyed", async () => {
  const { runtime } = runtimeWith({ env: { AI_DEV_DENSE_BACKEND: "onx" } });
  const chosen = await runtime.describe();
  assert.equal(chosen.backend, "onnx", "auto still picks the verified export");
  assert.match(chosen.note, /not one of/);
});

test("the weights are not re-hashed for every query, and refresh forces a fresh look", async () => {
  let clock = 0;
  const { runtime, calls } = runtimeWith({ now: () => clock });

  await runtime.describe();
  await runtime.describe();
  assert.equal(calls.verify, 1, "hashing hundreds of megabytes twice in a row is the thing to avoid");

  await runtime.describe({ refresh: true });
  assert.equal(calls.verify, 2);

  clock += 61_000;
  await runtime.describe();
  assert.equal(calls.verify, 3, "the cached verdict expires");
});

test("a python probe that throws is a 'no', not a crash", async () => {
  const runtime = createDenseRuntime({
    manifest: MANIFEST,
    onnxModelDir: "/models/bge-m3-onnx",
    onnxRuntime: { embedTexts: async () => ({}), shutdown: async () => {} },
    pythonRuntime: { request: async () => ({}), shutdown: () => {} },
    pythonReady: async () => {
      throw new Error("no interpreter");
    },
    verify: async () => ({ ready: false, dir: "/d", missing: ["config.json"], mismatched: [] })
  });
  const chosen = await runtime.describe();
  assert.equal(chosen.available, false);
  assert.equal(chosen.python.ready, false);
});

test("shutdown stops both backends", async () => {
  const { runtime, calls } = runtimeWith();
  await runtime.shutdown();
  assert.deepEqual(calls.shutdown.sort(), ["onnx", "python"]);
});

test("onnxStatus is reachable on its own, for the doctor", async () => {
  const { runtime } = runtimeWith({ onnxReady: false });
  const status = await runtime.onnxStatus();
  assert.equal(status.ready, false);
  assert.deepEqual(status.missing, ["onnx/model_int8.onnx"]);
});
