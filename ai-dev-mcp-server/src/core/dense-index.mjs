/**
 * Embedding the vault's passages for the dense half of hybrid search.
 *
 * Planning, embedding and writing are three steps, each where it belongs:
 *
 *   1. `densePlan` (`search-store.mjs`) collects the documents and returns only
 *      the passages whose vectors are missing or stale for this backend,
 *      revision and dtype;
 *   2. this module embeds them in batches through the installed backend — the
 *      ONNX model in a worker thread (docs/DEFECTS.md, Д-62), or the legacy
 *      Python worker while it lasts;
 *   3. `rebuildIndex` writes them with the rebuild, loading no model at all.
 *
 * A document edited between (1) and (3) has a different content hash by then,
 * so the writer declines the stale vector and counts the document as pending
 * rather than storing a vector against text it no longer has. The next rebuild
 * picks it up. That is why the pending count is not forced to zero.
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
      // silently score zero against every query, because the dense dot
      // product is 0.0 for a length mismatch. Refuse it here instead.
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
