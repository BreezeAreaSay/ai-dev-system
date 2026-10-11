#!/usr/bin/env node
/**
 * Does the Node search engine answer as the Python helper did?
 *
 *   npm run search:parity -- [--vault <dir>] [--json <report.json>]
 *
 * A development check, not a test: it needs Python and the helper, and the
 * vault it reads should have its skill registry built (`npm run setup`). It
 *
 * 1. builds the index with each engine into a scratch directory and compares
 *    the two files table by table, row by row (the build time aside);
 * 2. runs every golden case in `search-eval/*.json` — the search cases with
 *    their preset's filters, the routing cases' tasks as plain questions —
 *    through Node's keyword search and the helper's `search`, and compares the
 *    top 3 and the top k;
 * 3. runs the helper's `hybrid` search (no dense) over both files, which is how
 *    hybrid search reads a Node-built index until it moves to Node too;
 * 4. because keyword search requires every word and most golden questions are
 *    sentences, also asks both engines for a few hundred document titles —
 *    questions that find at least their own document, and usually its
 *    neighbours (`--titles N`, 300 by default).
 *
 * Every discrepancy is printed with a reason: a question with AND/OR/NOT/NEAR,
 * where the helper had a bug (docs/DEFECTS.md, Д-117); a tie in score, where
 * order is the database's to choose; or "unexplained", which fails the run.
 */
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolvePythonCommand } from "../src/core/python-command.mjs";
import { resolveSearchPresetArgs } from "../src/core/search-runtime.mjs";
import { keywordSearch } from "../src/core/search-query.mjs";
import { openDatabase, sqliteSupport } from "../src/core/search-sqlite.mjs";
import { rebuildIndex } from "../src/core/search-store.mjs";

const run = promisify(execFile);
const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(serverRoot, "..");
const helper = path.join(repoRoot, "search-index", "search_cli.py");
const evalDir = path.join(repoRoot, "search-eval");

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const vaultRoot = path.resolve(option("--vault", path.join(repoRoot, "docker", "public-seed")));
const jsonOut = option("--json", "");
const titleCount = Math.max(0, Number(option("--titles", "300")) || 0);
const python = resolvePythonCommand();
const MODEL_DIR = "/parity/models/bge-m3";
const OPERATOR = /(^|[^\p{L}\p{N}_])(AND|OR|NOT|NEAR)([^\p{L}\p{N}_]|$)/u;

async function helperJson(args) {
  const { stdout } = await run(python, [helper, ...args], { maxBuffer: 1 << 28, windowsHide: true });
  return JSON.parse(stdout);
}

// One Python process for every search, instead of one per question.
const DRIVER = `
import contextlib, io, json, sys
from types import SimpleNamespace
sys.path.insert(0, sys.argv[1])
import search_cli
answers = []
for job in json.load(sys.stdin):
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        getattr(search_cli, job["fn"])(SimpleNamespace(**job["args"]))
    answers.append(json.loads(buffer.getvalue()))
json.dump(answers, sys.stdout)
`;

/** Run `search` or `hybrid_search` in the helper for each case, in one process. */
function helperSearches(fn, indexPath, cases) {
  const jobs = cases.map((testCase) => ({
    fn,
    args: {
      index_path: indexPath,
      query: testCase.query,
      scope: testCase.scope,
      limit: testCase.limit,
      project: testCase.project,
      source: testCase.source,
      categories: testCase.categories,
      folders: testCase.folders,
      ...(fn === "hybrid_search"
        ? { semantic_weight: 0.2, keyword_weight: 0.45, dense_weight: 0, dense_model_dir: "", dense_device: "cpu", dense_query_vector_path: "" }
        : {})
    }
  }));
  const result = spawnSync(python, ["-c", DRIVER, path.dirname(helper)], { input: JSON.stringify(jobs), maxBuffer: 1 << 30, windowsHide: true });
  if (result.status !== 0) throw new Error(`The helper's searches failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** Every row of every table as text, rowids and the build time aside. */
function dumpIndex(indexPath) {
  const db = openDatabase(indexPath);
  const rows = (sql) => db.prepare(sql).all().map((row) => JSON.stringify(Object.values(row).map((value) => (
    value instanceof Uint8Array ? Buffer.from(value).toString("hex") : value
  ))));
  try {
    return {
      documents: rows("SELECT id, scope, title, CAST(path AS BLOB), source, categories, CAST(preview AS BLOB), mtime, content_hash FROM documents ORDER BY id"),
      docs_fts: rows("SELECT id, CAST(title AS BLOB), CAST(body AS BLOB), CAST(path AS BLOB), source, categories FROM docs_fts ORDER BY id"),
      semantic_vectors: rows("SELECT id, vector, norm FROM semantic_vectors ORDER BY id"),
      dense_vectors: rows("SELECT id, vector, dimensions, model, backend, revision, dtype, content_hash, mtime FROM dense_vectors ORDER BY id"),
      meta: rows("SELECT key, value FROM meta WHERE key != 'built_at' ORDER BY key")
    };
  } finally {
    db.close();
  }
}

function compareIndexes(left, right) {
  const a = dumpIndex(left);
  const b = dumpIndex(right);
  return Object.fromEntries(Object.keys(a).map((table) => {
    const inB = new Set(b[table]);
    const inA = new Set(a[table]);
    return [table, { rows: [a[table].length, b[table].length], differing: a[table].filter((row) => !inB.has(row)).length + b[table].filter((row) => !inA.has(row)).length }];
  }));
}

/** The golden questions, with the filters a search case's preset applies. */
function loadCases() {
  const cases = [];
  for (const file of fs.readdirSync(evalDir).filter((name) => name.endsWith(".json")).sort()) {
    const { cases: list = [] } = JSON.parse(fs.readFileSync(path.join(evalDir, file), "utf8"));
    for (const testCase of list) {
      const question = testCase.query ?? testCase.task;
      if (typeof question !== "string" || !question.trim()) continue;
      const resolved = testCase.query ? resolveSearchPresetArgs({ ...testCase }, { defaultLimit: 10 }).search : { query: question, scope: "all", limit: 10 };
      cases.push({
        file,
        id: String(testCase.id ?? question),
        query: question,
        scope: resolved.scope || "all",
        limit: resolved.limit || 10,
        project: resolved.project || "",
        source: [resolved.source ?? ""].flat().join(","),
        categories: [resolved.categories ?? ""].flat().join(","),
        folders: [resolved.folders ?? ""].flat().join(",")
      });
    }
  }
  return cases;
}

/** Why two rankings differ, or "unexplained". */
function explain(testCase, left, right) {
  if (OPERATOR.test(testCase.query)) return "operator word in the question (Д-117)";
  const scores = new Map();
  for (const item of [...left, ...right]) {
    const known = scores.get(item.path);
    if (known !== undefined && Math.abs(known - item.score) > 1e-9) return "unexplained";
    scores.set(item.path, item.score);
  }
  const differing = left.map((item, index) => [item, right[index]]).filter(([a, b]) => a?.path !== b?.path);
  const tied = differing.every(([a, b]) => a && b && Math.abs(a.score - b.score) <= 1e-9);
  return tied ? "tie in score: the order is the database's" : "unexplained";
}

function compareRankings(cases, label, leftResults, rightResults) {
  const rows = [];
  for (let index = 0; index < cases.length; index += 1) {
    const left = leftResults[index];
    const right = rightResults[index];
    const top = (list, k) => list.slice(0, k).map((item) => item.path);
    const sameTop3 = JSON.stringify(top(left, 3)) === JSON.stringify(top(right, 3));
    const sameTopK = JSON.stringify(top(left, cases[index].limit)) === JSON.stringify(top(right, cases[index].limit));
    const widest = Math.max(top(left, 3).length, top(right, 3).length);
    const overlap3 = widest ? top(left, 3).filter((item) => top(right, 3).includes(item)).length / widest : 1;
    rows.push({ id: cases[index].id, answered: widest > 0, sameTop3, sameTopK, overlap3, reason: sameTop3 && sameTopK ? "" : explain(cases[index], left, right), left: top(left, 3), right: top(right, 3) });
  }
  const identical = rows.filter((row) => row.sameTop3).length;
  return {
    label,
    cases: rows.length,
    answered: rows.filter((row) => row.answered).length,
    answered_top3_identical: rows.filter((row) => row.answered && row.sameTop3).length,
    top3_identical: identical,
    top3_identical_share: Number((identical / Math.max(1, rows.length)).toFixed(4)),
    top3_mean_overlap: Number((rows.reduce((sum, row) => sum + row.overlap3, 0) / Math.max(1, rows.length)).toFixed(4)),
    topk_identical: rows.filter((row) => row.sameTopK).length,
    discrepancies: rows.filter((row) => !row.sameTop3 || !row.sameTopK)
  };
}

async function main() {
  if (!sqliteSupport().available) throw new Error(sqliteSupport().reason);
  if (!fs.existsSync(helper)) throw new Error(`The Python helper is not here: ${helper}`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "search-parity-"));
  const pythonIndex = path.join(scratch, "python.sqlite");
  const nodeIndex = path.join(scratch, "node.sqlite");
  try {
    let started = performance.now();
    await helperJson(["rebuild", "--vault-root", vaultRoot, "--index-path", pythonIndex, "--include-external-project-files", "--preserve-dense", "--dense-model-dir", MODEL_DIR]);
    const pythonMs = Math.round(performance.now() - started);
    started = performance.now();
    const built = await rebuildIndex({ vaultRoot, indexPath: nodeIndex, preserveDense: true, denseModelDir: MODEL_DIR });
    const nodeMs = Math.round(performance.now() - started);
    const tables = compareIndexes(pythonIndex, nodeIndex);

    const cases = loadCases();
    const db = openDatabase(nodeIndex);
    let nodeKeyword;
    let titleCases;
    let nodeTitles;
    try {
      nodeKeyword = cases.map((testCase) => keywordSearch(db, testCase));
      const titles = db.prepare("SELECT DISTINCT title FROM documents WHERE title != '' ORDER BY id").all().map((row) => row.title);
      const step = Math.max(1, Math.floor(titles.length / Math.max(1, titleCount)));
      titleCases = titleCount ? titles.filter((_, index) => index % step === 0).slice(0, titleCount)
        .map((title) => ({ file: "titles", id: `title: ${title}`, query: title, scope: "all", limit: 10, project: "", source: "", categories: "", folders: "" })) : [];
      nodeTitles = titleCases.map((testCase) => keywordSearch(db, testCase));
    } finally {
      db.close();
    }
    const pythonKeyword = helperSearches("search", pythonIndex, cases);
    const pythonTitles = helperSearches("search", pythonIndex, titleCases);
    const hybridOnPython = helperSearches("hybrid_search", pythonIndex, cases);
    const hybridOnNode = helperSearches("hybrid_search", nodeIndex, cases);
    const report = {
      vault: vaultRoot,
      documents: built.document_count,
      rebuild_ms: { python: pythonMs, node: nodeMs },
      index_tables: tables,
      keyword: compareRankings(cases, "keyword search, golden questions: Node engine vs Python helper", nodeKeyword, pythonKeyword),
      titles: compareRankings(titleCases, "keyword search, document titles: Node engine vs Python helper", nodeTitles, pythonTitles),
      hybrid: compareRankings(cases, "Python hybrid search: Node-built index vs Python-built index", hybridOnNode, hybridOnPython)
    };
    if (jsonOut) fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);

    console.log(`vault ${vaultRoot}: ${report.documents} documents; rebuild Python ${pythonMs} ms, Node ${nodeMs} ms`);
    for (const [table, { rows, differing }] of Object.entries(tables)) console.log(`  ${table}: ${rows[0]} / ${rows[1]} rows, ${differing} differing`);
    for (const section of [report.keyword, report.titles, report.hybrid]) {
      console.log(`${section.label}: top-3 identical in ${section.top3_identical} of ${section.cases} (${(section.top3_identical_share * 100).toFixed(1)} %), `
        + `${section.answered_top3_identical} of the ${section.answered} that found anything; mean top-3 overlap ${(section.top3_mean_overlap * 100).toFixed(1)} %, top-k identical in ${section.topk_identical}`);
      for (const row of section.discrepancies) console.log(`  ${row.id}: ${row.reason}\n    Node/left:   ${row.left.join(" | ")}\n    Python/right: ${row.right.join(" | ")}`);
    }
    const unexplained = [report.keyword, report.titles, report.hybrid].flatMap((section) => section.discrepancies).filter((row) => row.reason === "unexplained");
    const tablesDiffer = Object.values(tables).some((table) => table.differing > 0);
    if (unexplained.length || tablesDiffer) {
      console.log(`FAIL: ${unexplained.length} unexplained discrepanc${unexplained.length === 1 ? "y" : "ies"}${tablesDiffer ? "; the index files differ" : ""}.`);
      process.exitCode = 1;
    } else {
      console.log("OK: the index files are equal and every discrepancy is explained.");
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack ?? error);
  process.exitCode = 1;
});
