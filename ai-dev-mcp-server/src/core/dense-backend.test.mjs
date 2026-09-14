import assert from "node:assert/strict";
import test from "node:test";
import {
  DENSE_BACKEND_CHOICES,
  DENSE_ONNX_BACKEND,
  DENSE_PYTHON_BACKEND,
  requestedDenseBackend,
  selectDenseBackend
} from "./dense-backend.mjs";

test("the environment variable is read, and a typo degrades to auto with a note", () => {
  assert.deepEqual(requestedDenseBackend({}), { requested: "auto", note: "" });
  assert.deepEqual(requestedDenseBackend({ AI_DEV_DENSE_BACKEND: "" }), { requested: "auto", note: "" });
  assert.equal(requestedDenseBackend({ AI_DEV_DENSE_BACKEND: "ONNX" }).requested, DENSE_ONNX_BACKEND);
  assert.equal(requestedDenseBackend({ AI_DEV_DENSE_BACKEND: " python " }).requested, DENSE_PYTHON_BACKEND);
  const typo = requestedDenseBackend({ AI_DEV_DENSE_BACKEND: "onxx" });
  assert.equal(typo.requested, "auto");
  assert.match(typo.note, /onxx is not one of auto, onnx, python/);
  assert.deepEqual([...DENSE_BACKEND_CHOICES], ["auto", "onnx", "python"]);
});

test("auto prefers onnx whenever its export is verified", () => {
  for (const pythonReady of [true, false]) {
    const choice = selectDenseBackend({ requested: "auto", onnxReady: true, pythonReady });
    assert.equal(choice.backend, DENSE_ONNX_BACKEND);
    assert.equal(choice.available, true);
    assert.match(choice.reason, /no Python is involved/);
  }
});

test("auto falls back to the legacy stack only when there is no onnx export", () => {
  const choice = selectDenseBackend({ requested: "auto", onnxReady: false, pythonReady: true });
  assert.equal(choice.backend, DENSE_PYTHON_BACKEND);
  assert.equal(choice.available, true);
  assert.match(choice.reason, /legacy Python stack is installed/);
});

test("auto with neither installed is a state, not a failure, and says what to run", () => {
  const choice = selectDenseBackend({ requested: "auto", onnxReady: false, pythonReady: false });
  assert.equal(choice.backend, DENSE_ONNX_BACKEND, "the advice points at the default backend");
  assert.equal(choice.available, false);
  assert.match(choice.reason, /npm run setup -- --dense/);
  assert.match(choice.reason, /no Python needed/);
});

test("an explicit choice is never silently overridden by the other backend", () => {
  // The migration this change exists to make visible would be hidden by a
  // fallback here: asking for onnx and getting python is the thing not to do.
  const onnx = selectDenseBackend({ requested: "onnx", onnxReady: false, pythonReady: true });
  assert.equal(onnx.backend, DENSE_ONNX_BACKEND);
  assert.equal(onnx.available, false);
  assert.match(onnx.reason, /not on disk/);

  const python = selectDenseBackend({ requested: "python", onnxReady: true, pythonReady: false });
  assert.equal(python.backend, DENSE_PYTHON_BACKEND);
  assert.equal(python.available, false);
  assert.match(python.reason, /--dense-python/);
});

test("an explicit choice that can run reports why it is running", () => {
  assert.match(
    selectDenseBackend({ requested: "onnx", onnxReady: true }).reason,
    /AI_DEV_DENSE_BACKEND=onnx, and the verified export is on disk/
  );
  assert.match(
    selectDenseBackend({ requested: "python", pythonReady: true }).reason,
    /legacy Python stack is installed/
  );
});

test("an unknown requested value is treated as auto rather than trusted", () => {
  const choice = selectDenseBackend({ requested: "torch", onnxReady: true });
  assert.equal(choice.backend, DENSE_ONNX_BACKEND);
  assert.equal(choice.requested, "auto");
  assert.equal(selectDenseBackend().available, false, "defaults alone are a valid call");
});
