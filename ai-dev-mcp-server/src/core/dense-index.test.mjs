import assert from "node:assert/strict";
import test from "node:test";
import { DENSE_PLAN_BATCH, embedDensePlan } from "./dense-index.mjs";

const records = (count) => new Array(count).fill(0).map((_value, index) => ({
  id: `doc-${index}`,
  text: `passage ${index}`,
  content_hash: `hash-${index}`
}));

const vectorsFor = (texts) => ({ embeddings: texts.map(() => [0.1, 0.2, 0.3, 0.4]) });

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
