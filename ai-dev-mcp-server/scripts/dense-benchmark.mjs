#!/usr/bin/env node
/**
 * The numbers Д-62's acceptance criterion (2) is decided on, measured on a
 * machine that has the weights.
 *
 * This session could not run it: `huggingface.co` and `download.pytorch.org`
 * are closed to it, so neither backend's model can be fetched here. It runs in
 * `.github/workflows/dense-eval.yml`, once per backend, and the two JSON
 * documents it writes are compared there.
 *
 * What it measures, in the order a user meets them: how long the backend takes
 * to answer its first query (cold start, which for ONNX is the session load),
 * how long a warm query takes, how much resident memory the process holds
 * afterwards, and how the golden cases rank with dense scoring on.
 *
 * Note on the metric names. Д-62 asks for "Recall@3/5"; the eval harness in
 * this repository does not compute recall — its golden cases have one expected
 * note each, so it reports mean reciprocal rank, top-1 accuracy and mean nDCG
 * instead. Those are what is printed, under their own names. Inventing a
 * recall column the harness cannot fill would be worse than a rename.
 *
 * Usage: node scripts/dense-benchmark.mjs --out report.json [--label onnx]
 *        [--max-cases 50]
 */
import fs from "node:fs/promises";
import process from "node:process";
import { parseBenchmarkArgs } from "./dense-benchmark-args.mjs";

const options = parseBenchmarkArgs(process.argv.slice(2), process.env);
const { callTool, shutdownBgeWorkers } = await import("../src/mcp-stdio.mjs");
const parse = (result) => JSON.parse(result.content[0].text);

const QUERIES = [
  "how do I set up test driven development",
  "как настроить гибридный поиск",
  "refactor a service into hexagonal architecture"
];

/** Time one hybrid search, in milliseconds. */
async function timeQuery(query) {
  const started = process.hrtime.bigint();
  const result = parse(await callTool("hybrid_search", { query, limit: 5 }));
  return { ms: Number(process.hrtime.bigint() - started) / 1e6, results: result.results?.length ?? 0 };
}

const status = parse(await callTool("embedding_status", { refresh: true }));
const backend = status.dense_backend ?? {};
if (!backend.available) {
  process.stderr.write(`Dense backend is not available: ${backend.reason}\n`);
  process.exit(1);
}

// Cold start is the first query of the process: the model is loaded inside it.
const cold = await timeQuery(QUERIES[0]);
const warm = [];
for (const query of QUERIES) warm.push((await timeQuery(query)).ms);
warm.sort((left, right) => left - right);

const indexStatus = parse(await callTool("search_index_status", {}));
const evaluation = parse(await callTool("run_search_eval", { include_dense: true, max_cases: options.maxCases }));

const report = {
  label: options.label,
  backend: backend.backend,
  model: status.dense_model,
  revision: backend.provenance?.revision,
  dtype: backend.provenance?.dtype,
  node: process.version,
  index: {
    documents: indexStatus.document_count,
    dense_documents: indexStatus.dense_documents,
    dense_pending_documents: indexStatus.dense_pending_documents,
    dense_backend: indexStatus.dense_backend,
    dense_revision: indexStatus.dense_revision,
    dense_dtype: indexStatus.dense_dtype
  },
  latency_ms: {
    cold_start: Number(cold.ms.toFixed(1)),
    warm_median: Number(warm[Math.floor(warm.length / 2)].toFixed(1)),
    warm_max: Number(warm[warm.length - 1].toFixed(1))
  },
  memory_mb: {
    rss: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
    heap_used: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1))
  },
  eval: {
    status: evaluation.status,
    max_cases: options.maxCases,
    total: evaluation.summary?.total,
    passed: evaluation.summary?.passed,
    failed: evaluation.summary?.failed,
    mean_reciprocal_rank: Number((evaluation.summary?.metrics?.mean_reciprocal_rank ?? 0).toFixed(4)),
    top_1_accuracy: Number((evaluation.summary?.metrics?.top_1_accuracy ?? 0).toFixed(4)),
    mean_ndcg: Number((evaluation.summary?.metrics?.mean_ndcg ?? 0).toFixed(4))
  }
};

if (options.out) await fs.writeFile(options.out, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
await shutdownBgeWorkers();
