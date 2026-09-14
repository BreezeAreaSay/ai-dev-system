import assert from "node:assert/strict";
import test from "node:test";
import {
  DENSE_PLAN_BATCH,
  denseProvenanceArgs,
  embedDensePlan,
  planAndEmbedDenseVectors
} from "./dense-index.mjs";

const PROVENANCE = Object.freeze({ backend: "onnx", revision: "d".repeat(40), dtype: "int8", dimensions: 4 });

const records = (count) => new Array(count).fill(0).map((_value, index) => ({
  id: `doc-${index}`,
  text: `passage ${index}`,
  content_hash: `hash-${index}`
}));

const vectorsFor = (texts) => ({ embeddings: texts.map(() => [0.1, 0.2, 0.3, 0.4]) });

test("provenance travels as three flags, whichever backend produced the vectors", () => {
  assert.deepEqual(denseProvenanceArgs(PROVENANCE), [
    "--dense-backend", "onnx",
    "--dense-revision", "d".repeat(40),
    "--dense-dtype", "int8"
  ]);
  assert.deepEqual(
    denseProvenanceArgs({ backend: "python", revision: "unpinned", dtype: "fp32" }),
    ["--dense-backend", "python", "--dense-revision", "unpinned", "--dense-dtype", "fp32"]
  );
});

test("a plan is embedded in batches and paired back with its document ids", async () => {
  const seen = [];
  const vectors = await embedDensePlan({
    records: records(5),
    embed: async (texts) => {
      seen.push(texts.length);
      return vectorsFor(texts);
    },
    dimensions: 4,
    batchSize: 2
  });

  assert.deepEqual(seen, [2, 2, 1]);
  assert.equal(vectors.length, 5);
  assert.deepEqual(vectors[3], { id: "doc-3", content_hash: "hash-3", vector: [0.1, 0.2, 0.3, 0.4] });
});

test("progress is reported as the work lands", async () => {
  const progress = [];
  await embedDensePlan({
    records: records(5),
    embed: async (texts) => vectorsFor(texts),
    dimensions: 4,
    batchSize: 2,
    onProgress: (done, total) => progress.push(`${done}/${total}`)
  });
  assert.deepEqual(progress, ["2/5", "4/5", "5/5"]);
});

test("a backend that returns the wrong number of vectors is caught, not zipped short", async () => {
  await assert.rejects(
    () => embedDensePlan({
      records: records(3),
      embed: async () => ({ embeddings: [[1, 2, 3, 4]] }),
      dimensions: 4
    }),
    /returned 1 vectors for 3 passages/
  );
});

test("a vector of the wrong width is refused rather than silently scoring zero forever", async () => {
  // The helper's dot product answers 0.0 on a length mismatch, so a 768-wide
  // vector in a 1024-wide index is invisible rather than wrong-looking.
  await assert.rejects(
    () => embedDensePlan({
      records: records(1),
      embed: async () => ({ embeddings: [[1, 2, 3]] }),
      dimensions: 4
    }),
    /returned a 3 vector; the manifest says 4/
  );
  await assert.rejects(
    () => embedDensePlan({ records: records(1), embed: async () => ({ embeddings: [null] }), dimensions: 4 }),
    /non-array vector/
  );
});

test("a missing embeddings key is a mismatch, not an empty success", async () => {
  await assert.rejects(
    () => embedDensePlan({ records: records(1), embed: async () => ({}), dimensions: 4 }),
    /returned 0 vectors for 1 passages/
  );
});

test("the whole pass plans, embeds and writes the file the rebuild reads", async () => {
  const written = [];
  const planArgs = ["--vault-root", "/vault", "--index-path", "/index.sqlite"];

  const result = await planAndEmbedDenseVectors({
    runPlan: async (args) => {
      assert.equal(args[0], "dense-plan");
      assert.ok(args.includes("--dense-backend"), "the plan is asked for this backend's gaps, not any backend's");
      assert.ok(args.includes("d".repeat(40)));
      return { records: records(3), reusable: 17 };
    },
    planArgs,
    embed: async (texts) => vectorsFor(texts),
    provenance: PROVENANCE,
    writeJson: async (target, value) => written.push({ target, value }),
    vectorsPath: "/scratch/vectors.json"
  });

  assert.deepEqual(result, { planned: 3, embedded: 3, reusable: 17, vectorsPath: "/scratch/vectors.json" });
  assert.equal(written.length, 1);
  assert.equal(written[0].target, "/scratch/vectors.json");
  assert.deepEqual(written[0].value.provenance, PROVENANCE);
  assert.equal(written[0].value.vectors.length, 3);
});

test("a plan with nothing to do writes an empty file rather than skipping the rebuild's input", async () => {
  const written = [];
  const result = await planAndEmbedDenseVectors({
    runPlan: async () => ({ records: [], reusable: 42 }),
    planArgs: [],
    embed: async () => {
      throw new Error("the model must not be loaded for an empty plan");
    },
    provenance: PROVENANCE,
    writeJson: async (target, value) => written.push({ target, value }),
    vectorsPath: "/scratch/vectors.json"
  });

  assert.deepEqual(result, { planned: 0, embedded: 0, reusable: 42, vectorsPath: "/scratch/vectors.json" });
  assert.deepEqual(written[0].value.vectors, []);
});

test("the default batch size is the documented one", async () => {
  const seen = [];
  await embedDensePlan({
    records: records(DENSE_PLAN_BATCH + 1),
    embed: async (texts) => {
      seen.push(texts.length);
      return vectorsFor(texts);
    },
    dimensions: 4
  });
  assert.deepEqual(seen, [DENSE_PLAN_BATCH, 1]);
});
