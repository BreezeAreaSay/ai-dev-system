/**
 * Embedding the vault with a backend that does not live in the indexer.
 *
 * The sqlite index is written by `search-index/search_cli.py`, and the ONNX
 * model runs in Node (docs/DEFECTS.md, Д-62). Neither half can move: the helper
 * owns the schema, the document collection and the locking, and the model is
 * the whole point of not needing Python. So the two meet over two files and one
 * extra pass:
 *
 *   1. `dense-plan` collects the documents and prints only the passages whose
 *      vectors are missing or stale for this backend, revision and dtype;
 *   2. this module embeds them in batches through the injected backend;
 *   3. `rebuild --dense-vectors-json` writes them, loading no model at all.
 *
 * A document edited between (1) and (3) has a different content hash by then,
 * so the helper declines the stale vector and counts the document as pending
 * rather than storing a vector against text it no longer has. The next rebuild
 * picks it up. That is why the pending count is no longer forced to zero.
 *
 * The legacy Python backend does not come through here: it loads its model
 * inside the helper, as it always has.
 */

/** Most passages to hand the backend in one call. */
export const DENSE_PLAN_BATCH = 16;

/**
 * Turn a plan into vectors.
 *
 * @param {object} deps
 * @param {object[]} deps.records - `{ id, text, content_hash }` from `dense-plan`.
 * @param {(texts: string[]) => Promise<object>} deps.embed - The backend's `embedTexts`.
 * @param {number} deps.dimensions - What the manifest promises.
 * @param {number} [deps.batchSize]
 * @param {(done: number, total: number) => void} [deps.onProgress]
 * @returns {Promise<object[]>} `{ id, content_hash, vector }`.
 */
export async function embedDensePlan({ records, embed, dimensions, batchSize = DENSE_PLAN_BATCH, onProgress }) {
  const limit = Math.max(1, Number(batchSize) || DENSE_PLAN_BATCH);
  const vectors = [];
  for (let index = 0; index < records.length; index += limit) {
    const slice = records.slice(index, index + limit);
    const answer = await embed(slice.map((record) => record.text));
    const rows = answer?.embeddings ?? [];
    if (rows.length !== slice.length) {
      throw new Error(`Dense backend returned ${rows.length} vectors for ${slice.length} passages.`);
    }
    for (let offset = 0; offset < slice.length; offset += 1) {
      const vector = rows[offset];
      // A vector of the wrong width would be written into the index and then
      // silently score zero against every query, because the helper's dot
      // product returns 0.0 for a length mismatch. Refuse it here instead.
      if (!Array.isArray(vector) || vector.length !== dimensions) {
        throw new Error(
          `Dense backend returned a ${Array.isArray(vector) ? vector.length : "non-array"} vector; `
          + `the manifest says ${dimensions}.`
        );
      }
      vectors.push({ id: slice[offset].id, content_hash: slice[offset].content_hash, vector });
    }
    if (onProgress) onProgress(vectors.length, records.length);
  }
  return vectors;
}

/**
 * The `rebuild` arguments that carry a run's provenance.
 *
 * Every run passes these, legacy included, so a vector's origin is recorded by
 * the same code path whichever backend produced it.
 *
 * @param {{ backend: string, revision: string, dtype: string }} provenance
 * @returns {string[]}
 */
export function denseProvenanceArgs(provenance) {
  return [
    "--dense-backend", String(provenance.backend),
    "--dense-revision", String(provenance.revision),
    "--dense-dtype", String(provenance.dtype)
  ];
}

/**
 * Run the plan/embed half and hand back the file the rebuild should read.
 *
 * @param {object} deps
 * @param {(args: string[], options?: object) => Promise<object>} deps.runPlan
 * @param {string[]} deps.planArgs - Everything but the provenance flags.
 * @param {(texts: string[]) => Promise<object>} deps.embed
 * @param {{ backend: string, revision: string, dtype: string, dimensions: number }} deps.provenance
 * @param {(target: string, value: object) => Promise<void>} deps.writeJson
 * @param {string} deps.vectorsPath
 * @param {number} [deps.batchSize]
 * @param {(done: number, total: number) => void} [deps.onProgress]
 * @returns {Promise<{ planned: number, embedded: number, reusable: number, vectorsPath: string }>}
 */
export async function planAndEmbedDenseVectors({
  runPlan,
  planArgs,
  embed,
  provenance,
  writeJson,
  vectorsPath,
  batchSize = DENSE_PLAN_BATCH,
  onProgress
}) {
  const plan = await runPlan(["dense-plan", ...planArgs, ...denseProvenanceArgs(provenance)]);
  const records = plan.records ?? [];
  const vectors = records.length
    ? await embedDensePlan({ records, embed, dimensions: provenance.dimensions, batchSize, onProgress })
    : [];
  await writeJson(vectorsPath, { provenance, vectors });
  return {
    planned: records.length,
    embedded: vectors.length,
    reusable: Number(plan.reusable || 0),
    vectorsPath
  };
}
