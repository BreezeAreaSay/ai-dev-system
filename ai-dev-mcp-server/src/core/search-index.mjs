/**
 * The sqlite search index: keeping it fresh, querying it, and merging the
 * hybrid ranking on top of what the Python helper returns.
 *
 * Two engines write and read the same file. Node's own (`search-store.mjs`,
 * `search-query.mjs`) serves status, rebuilds and keyword search wherever
 * `node:sqlite` has FTS5 — Node 22.16+ and 24+. Elsewhere, or with
 * `AI_DEV_SEARCH_ENGINE=python`, the Python helper (`search_cli.py`) does, as it
 * did in 2.x. Hybrid search, the galaxy export and the legacy Python dense
 * backend stay with the helper for now, reading whichever engine wrote the
 * file: the format is the same to the byte.
 *
 * Three things make a hybrid answer more than a passthrough: the dense query
 * vector, which is embedded here and handed to the helper as a file; the
 * rerankers, which re-order results against the golden cases; and
 * deterministic intent routing, which can put a routed workflow skill above
 * everything the index found.
 *
 * Freshness is tracked, not recomputed: writers call `markDirty()` and the next
 * search refreshes once — in place, with the Node engine, rewriting only what
 * changed. Concurrent searches share one refresh.
 *
 * Nothing here is pure. The preset resolution and the score explanations that
 * sit around it are in `src/core/search-runtime.mjs`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { atomicWriteJson } from "./atomic-files.mjs";
import { denseProvenanceArgs, embedDensePlan, planAndEmbedDenseVectors } from "./dense-index.mjs";
import { createDocumentCache } from "./search-documents.mjs";
import { keywordSearch, MAX_RESULTS } from "./search-query.mjs";
import { createIndexReader, sqliteSupport } from "./search-sqlite.mjs";
import { densePlan, indexStatus, rebuildIndex } from "./search-store.mjs";
import { withRebuildLock } from "./search-writer.mjs";
import { csvValue, stripBom } from "./text-format.mjs";
import { pythonFailureMessage } from "./python-failure.mjs";

/** How long a fresh-index verdict is trusted before it is checked again. */
const FRESHNESS_CACHE_MS = 1000;

/**
 * Which engine serves status, rebuilds and keyword search: Node's own where
 * `node:sqlite` has FTS5, the Python helper otherwise. `AI_DEV_SEARCH_ENGINE=python`
 * forces the helper — the way back if the Node engine misbehaves somewhere.
 *
 * @param {{ env?: NodeJS.ProcessEnv, support?: () => { available: boolean, reason: string } }} [options]
 * @returns {{ engine: "node"|"python", reason: string }}
 */
export function chooseSearchEngine({ env = process.env, support = sqliteSupport } = {}) {
  if (String(env.AI_DEV_SEARCH_ENGINE ?? "").trim().toLowerCase() === "python") {
    return { engine: "python", reason: "AI_DEV_SEARCH_ENGINE=python" };
  }
  const { available, reason } = support();
  return available ? { engine: "node", reason: "" } : { engine: "python", reason };
}

/**
 * Create the search index runtime.
 *
 * @param {object} deps
 * @param {string} deps.vaultRoot
 * @param {string} deps.searchCliPath - `search_cli.py`.
 * @param {string} deps.searchIndexDir - Where the sqlite file and scratch live.
 * @param {string} deps.searchIndexPath
 * @param {string} deps.defaultModelDir - Default dense model directory.
 * @param {() => string} deps.pythonCommand - Interpreter for the search helper.
 * @param {() => string} deps.embeddingPythonCommand - Interpreter for dense rebuilds.
 * @param {(target: string) => Promise<boolean>} deps.pathExists
 * @param {(command: string, args: string[], options: object) => Promise<{ stdout: string }>} deps.execFile
 * @param {(payload: object, options?: object) => Promise<object>} deps.embedQuery - Dense query embedding.
 * @param {() => Promise<object[]>} deps.hardNegativeRules - Reranker guardrails.
 * @param {() => Promise<object[]>} deps.readSkillIndex - Registry, for intent routing.
 * @param {() => Promise<unknown>} [deps.refreshSkillRegistry] - Rebuilds the skill registry when
 *   its skills changed on disk; the index's skill documents are read from it (docs/DEFECTS.md, Д-119).
 * @param {object} deps.ranking - Pure ranking collaborators.
 * @returns {object} The runtime.
 */
/**
 * The results, with why the dense half was skipped attached where a caller can
 * find it and `JSON.stringify` cannot trip over it.
 *
 * @param {object[]} results
 * @param {string} issue - "" when dense ran.
 * @returns {object[]}
 */
function withDenseNote(results, issue) {
  if (issue) Object.defineProperty(results, "dense_unavailable", { value: issue, enumerable: false });
  return results;
}

export function createSearchIndexRuntime({
  vaultRoot,
  searchCliPath,
  searchIndexDir,
  searchIndexPath,
  defaultModelDir,
  pythonCommand,
  embeddingPythonCommand,
  pathExists,
  execFile,
  embedQuery,
  denseIndexBackend,
  hardNegativeRules,
  readSkillIndex,
  refreshSkillRegistry = async () => {},
  ranking,
  env = process.env
}) {
  const {
    repairSearchMojibake,
    prioritizeKnowledgeResults,
    rerankSearchResults,
    isSkillCatalogQuery,
    routeSkills
  } = ranking;

  let refreshPromise = null;
  let dirtyReason = "";
  let lastStatus = null;
  let lastStatusAt = 0;
  let selected = null;
  let indexReader = null;
  const documentCache = createDocumentCache();

  /** The engine, chosen on first use and kept: one process does not switch mid-flight. */
  function engine() {
    selected ??= chooseSearchEngine({ env });
    return selected;
  }

  /** The long-lived read connection the Node engine searches through. */
  function reader() {
    indexReader ??= createIndexReader(searchIndexPath);
    return indexReader;
  }

  /** Let go of the file, so a damaged one can be renamed away even on Windows. */
  function closeReader() {
    indexReader?.close();
    indexReader = null;
  }

  /** Which engine answered, on what the caller gets back. */
  function stamped(result, { engine: name, reason }) {
    if (result && typeof result === "object" && !Array.isArray(result)) {
      result.engine = name;
      if (reason) result.engine_reason = reason;
    }
    return result;
  }

  /**
   * Record that something a search would read has changed. The cached freshness
   * verdict is dropped with it, so the next query re-checks rather than trusting
   * a verdict taken before the write.
   */
  function markDirty(reason = "source changed") {
    dirtyReason = String(reason || "source changed");
    lastStatus = null;
    lastStatusAt = 0;
  }

  /** Why the index is considered stale right now, or "". */
  function dirtyReasonNow() {
    return dirtyReason;
  }

  async function runSearchCli(args, { timeoutMs = 600000, command = pythonCommand() } = {}) {
    if (!(await pathExists(searchCliPath))) {
      throw new Error(`Search helper not found: ${searchCliPath}`);
    }

    // The helper explains itself in the last line of its traceback, and callers
    // report the first line of what they are handed.
    const output = await execFile(command, [searchCliPath, ...args], { timeoutMs })
      .catch((error) => {
        throw new Error(pythonFailureMessage(error?.message, `Search helper failed: ${args[0]}`), { cause: error });
      });
    try {
      return JSON.parse(stripBom(output.stdout));
    } catch (err) {
      throw new Error(`Search helper returned invalid JSON: ${err instanceof Error ? err.message : String(err)}\n${output.stdout}`);
    }
  }

  /** The skill registry brought up to date first; a failure there leaves the registry as it is. */
  async function freshRegistry() {
    await Promise.resolve().then(refreshSkillRegistry).catch(() => {});
  }

  /** What the index holds against what the vault says: counts, schema, staleness. */
  async function status({ include_external_project_files = true } = {}) {
    await freshRegistry();
    const chosen = engine();
    let result;
    if (chosen.engine === "node") {
      result = await indexStatus({
        vaultRoot,
        indexPath: searchIndexPath,
        includeExternalProjectFiles: Boolean(include_external_project_files),
        cache: documentCache,
        reader: reader()
      });
    } else {
      const args = [
        "status",
        "--vault-root",
        vaultRoot,
        "--index-path",
        searchIndexPath
      ];
      if (include_external_project_files) args.push("--include-external-project-files");
      result = await runSearchCli(args, { timeoutMs: 120000, command: pythonCommand() });
    }
    result.dirty_reason = dirtyReason;
    return stamped(result, chosen);
  }

  /**
   * A rebuild by the Node engine. With dense embeddings the passages that need
   * a vector are planned here, embedded by the ONNX backend and written in the
   * same rebuild — no files handed between processes.
   */
  async function rebuildWithNode({ include_external_project_files, dense_embeddings, plan, dense_batch_size, dense_text_limit,
    dense_include_membrane, dense_incremental, preserve_dense, dense_model_dir, in_place }) {
    const textLimit = Math.max(300, Math.min(Number(dense_text_limit) || 1200, 12000));
    const batchSize = Math.max(1, Math.min(Number(dense_batch_size) || 8, 32));
    let suppliedVectors = [];
    let planned = null;
    if (dense_embeddings) {
      planned = await densePlan({
        vaultRoot,
        indexPath: searchIndexPath,
        includeExternalProjectFiles: Boolean(include_external_project_files),
        textLimit,
        includeMembrane: Boolean(dense_include_membrane),
        incremental: dense_incremental !== false,
        provenance: plan.provenance
      });
      suppliedVectors = planned.records.length
        ? await embedDensePlan({
          records: planned.records,
          embed: (texts) => embedQuery({ texts, normalize: true, include_embeddings: true, batch_size: batchSize }, { timeoutMs: 3600000 }),
          dimensions: plan.provenance.dimensions,
          batchSize
        })
        : [];
    }
    closeReader();
    const rebuilt = await rebuildIndex({
      vaultRoot,
      indexPath: searchIndexPath,
      includeExternalProjectFiles: Boolean(include_external_project_files),
      inPlace: Boolean(in_place) && !dense_embeddings,
      preserveDense: !dense_embeddings && Boolean(preserve_dense),
      denseEmbeddings: Boolean(dense_embeddings),
      suppliedVectors,
      denseModelDir: path.resolve(String(dense_model_dir || defaultModelDir)),
      denseTextLimit: dense_embeddings ? textLimit : 1200,
      denseIncludeMembrane: Boolean(dense_embeddings && dense_include_membrane),
      denseIncremental: dense_incremental !== false,
      ...(plan ? { denseBackend: plan.provenance.backend, denseRevision: plan.provenance.revision, denseDtype: plan.provenance.dtype } : {}),
      env
    });
    if (planned) {
      rebuilt.dense_planned_documents = planned.records.length;
      rebuilt.dense_embedded_documents = suppliedVectors.length;
    }
    return rebuilt;
  }

  /**
   * Rebuild the index. Dense embeddings are opt-in and expensive; without them
   * the existing dense vectors are preserved by default rather than dropped.
   */
  async function rebuild({
    include_external_project_files = true,
    dense_embeddings = false,
    dense_model_dir = process.env.BGE_M3_MODEL_DIR || defaultModelDir,
    dense_device = process.env.BGE_M3_DEVICE || "cpu",
    dense_batch_size = 8,
    dense_text_limit = 1200,
    dense_include_membrane = false,
    dense_incremental = true,
    preserve_dense = true,
    in_place = false
  } = {}) {
    await freshRegistry();
    await fs.mkdir(searchIndexDir, { recursive: true });
    const chosen = engine();
    // Which backend embeds decides who writes. The ONNX one embeds in this
    // process, so either engine can store its vectors; the legacy one loads its
    // model inside the Python helper, which then writes the index itself
    // (docs/DEFECTS.md, Д-62).
    const plan = dense_embeddings && denseIndexBackend ? await denseIndexBackend.describe() : null;
    const useOnnx = Boolean(plan && plan.backend === "onnx" && plan.available);
    if (chosen.engine === "node" && (!dense_embeddings || useOnnx)) {
      const rebuilt = await rebuildWithNode({
        include_external_project_files, dense_embeddings, plan, dense_batch_size, dense_text_limit,
        dense_include_membrane, dense_incremental, preserve_dense, dense_model_dir, in_place
      });
      dirtyReason = "";
      lastStatus = null;
      lastStatusAt = 0;
      return stamped(rebuilt, chosen);
    }
    const args = [
      "rebuild",
      "--vault-root",
      vaultRoot,
      "--index-path",
      searchIndexPath
    ];
    if (include_external_project_files) args.push("--include-external-project-files");
    if (!dense_embeddings && preserve_dense) args.push("--preserve-dense");

    // The helper's interpreter: the ONNX backend hands it numbers, so a stdlib
    // Python does; the legacy backend loads its model inside the helper, which
    // is why that path still needs the virtualenv.
    let vectorsPath = "";
    let denseNote = null;

    if (dense_embeddings) {
      const denseArgs = [
        "--dense-embeddings",
        "--dense-text-limit",
        String(Math.max(300, Math.min(Number(dense_text_limit) || 1200, 12000)))
      ];
      if (dense_include_membrane) denseArgs.push("--dense-include-membrane");
      if (dense_incremental === false) denseArgs.push("--no-dense-incremental");

      if (useOnnx) {
        vectorsPath = path.join(searchIndexDir, `.dense-vectors-${process.pid}-${Date.now()}.json`);
        denseNote = await planAndEmbedDenseVectors({
          runPlan: (planArgs) => runSearchCli(planArgs, { timeoutMs: 600000, command: pythonCommand() }),
          planArgs: [
            "--vault-root", vaultRoot,
            "--index-path", searchIndexPath,
            ...(include_external_project_files ? ["--include-external-project-files"] : []),
            ...denseArgs.filter((value) => value !== "--dense-embeddings")
          ],
          embed: (texts) => embedQuery({
            texts,
            normalize: true,
            include_embeddings: true,
            batch_size: Math.max(1, Math.min(Number(dense_batch_size) || 8, 32))
          }, { timeoutMs: 3600000 }),
          provenance: plan.provenance,
          writeJson: (target, value) => atomicWriteJson(target, value, { spaces: 0 }),
          vectorsPath,
          batchSize: Math.max(1, Math.min(Number(dense_batch_size) || 8, 32))
        });
        args.push(...denseArgs, ...denseProvenanceArgs(plan.provenance), "--dense-vectors-json", vectorsPath);
      } else {
        args.push(
          ...denseArgs,
          "--dense-model-dir",
          path.resolve(String(dense_model_dir || defaultModelDir)),
          "--dense-device",
          String(dense_device || "cpu"),
          "--dense-batch-size",
          String(Math.max(1, Math.min(Number(dense_batch_size) || 8, 32)))
        );
        if (plan) args.push(...denseProvenanceArgs(plan.provenance));
      }
    }

    try {
      // The helper locks with flock on a file of its own, which no Node engine
      // takes; holding the Node engine's lock around it as well keeps the two
      // engines' writers apart, whichever engine each client runs.
      const rebuilt = await withRebuildLock(searchIndexPath, () => runSearchCli(args, {
        timeoutMs: dense_embeddings ? 3600000 : 600000,
        command: dense_embeddings && !useOnnx ? embeddingPythonCommand() : pythonCommand()
      }), { env });
      dirtyReason = "";
      lastStatus = null;
      lastStatusAt = 0;
      if (denseNote) {
        rebuilt.dense_planned_documents = denseNote.planned;
        rebuilt.dense_embedded_documents = denseNote.embedded;
      }
      return stamped(rebuilt, chosen);
    } finally {
      if (vectorsPath) await fs.rm(vectorsPath, { force: true }).catch(() => {});
    }
  }

  /**
   * Make sure the index reflects the vault before a query reads it.
   *
   * Concurrent callers share one rebuild, and a recent clean verdict is trusted
   * for a second so a burst of searches does not re-stat the whole vault.
   */
  async function ensureFresh({ force_check = false } = {}) {
    if (refreshPromise) return refreshPromise;

    const now = Date.now();
    if (
      !force_check &&
      !dirtyReason &&
      lastStatus &&
      now - lastStatusAt < FRESHNESS_CACHE_MS
    ) {
      return { action: "current", status: lastStatus };
    }

    const current = await status({ include_external_project_files: true });
    lastStatus = current;
    lastStatusAt = Date.now();
    if (!current.stale && !dirtyReason) {
      return { action: "current", status: current };
    }

    refreshPromise = (async () => {
      const rebuilt = await rebuild({
        include_external_project_files: true,
        dense_embeddings: false,
        preserve_dense: true,
        in_place: true
      });
      const refreshed = await status({ include_external_project_files: true });
      lastStatus = refreshed;
      lastStatusAt = Date.now();
      dirtyReason = "";
      return { action: "rebuilt", previous_status: current, rebuild: rebuilt, status: refreshed };
    })();

    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  /**
   * Write what the Knowledge Galaxy is drawn from — documents, their sparse and
   * dense vectors, and their wikilinks — into `outDir` (`galaxy-export`).
   */
  async function exportGalaxy({ outDir }) {
    return runSearchCli(
      ["galaxy-export", "--index-path", searchIndexPath, "--out-dir", outDir],
      { timeoutMs: 300000, command: pythonCommand() }
    );
  }

  /** Keyword and sparse-semantic search over the index. */
  async function search({
    query,
    scope = "all",
    limit = 10,
    project = "",
    source = "",
    categories = "",
    folders = "",
    ensure_fresh = true
  }) {
    if (!query || typeof query !== "string") {
      throw new Error("query is required.");
    }
    if (ensure_fresh) await ensureFresh();
    const capped = Math.max(1, Math.min(Number(limit) || 10, MAX_RESULTS));
    if (engine().engine === "node") {
      const results = await reader().read((db) => keywordSearch(db, {
        query,
        scope: scope || "all",
        limit: capped,
        project: project || "",
        source: csvValue(source),
        categories: csvValue(categories),
        folders: csvValue(folders)
      }));
      if (results === null) throw new Error(`Search index does not exist: ${searchIndexPath}`);
      return results;
    }
    return runSearchCli([
      "search",
      "--index-path",
      searchIndexPath,
      "--query",
      query,
      "--scope",
      scope || "all",
      "--limit",
      String(capped),
      "--project",
      project || "",
      "--source",
      csvValue(source),
      "--categories",
      csvValue(categories),
      "--folders",
      csvValue(folders)
    ], { timeoutMs: 120000 });
  }

  /**
   * Hybrid search: keyword, sparse semantic and dense signals combined by the
   * helper, then reranked and optionally routed here.
   *
   * The dense query vector is embedded in this process and passed to the helper
   * as a file, so the helper never loads the model itself. The helper is always
   * asked for 50 results and the caller's limit is applied after reranking —
   * trimming first would hide the candidates reranking exists to promote.
   */
  async function hybridSearch({
    query,
    scope = "all",
    limit = 10,
    project = "",
    source = "",
    categories = "",
    folders = "",
    semantic_weight = 0.20,
    keyword_weight = 0.45,
    dense_weight = 0.35,
    dense_model_dir = process.env.BGE_M3_MODEL_DIR || defaultModelDir,
    dense_device = process.env.BGE_M3_DEVICE || "cpu",
    intent_routing = false,
    rerank = true,
    preset_name = "",
    ensure_fresh = true
  }) {
    if (!query || typeof query !== "string") {
      throw new Error("query is required.");
    }
    const normalizedQuery = repairSearchMojibake(query);
    const requestedLimit = Math.max(1, Math.min(Number(limit) || 10, MAX_RESULTS));
    const selectedDenseWeight = Number.isFinite(Number(dense_weight)) ? Number(dense_weight) : 0.35;
    if (ensure_fresh) await ensureFresh();

    let denseQueryVectorPath = "";
    // Why the dense half did not run, when it did not. Hybrid search is
    // keyword + sparse + dense, and the first two need no model: a missing
    // BGE-M3 used to throw out of here and take the whole search with it,
    // though the documented contract is that dense is the optional part.
    let denseIssue = "";
    if (selectedDenseWeight > 0) {
      try {
        const denseQuery = await embedQuery({
          texts: [normalizedQuery],
          prefix: "query: ",
          normalize: true,
          batch_size: 1,
          precision: 8,
          include_embeddings: true,
          model_dir: dense_model_dir,
          device: dense_device
        }, { timeoutMs: 300000 });
        const vector = denseQuery.embeddings?.[0];
        if (Array.isArray(vector) && vector.length) {
          await fs.mkdir(searchIndexDir, { recursive: true });
          denseQueryVectorPath = path.join(searchIndexDir, `.dense-query-${process.pid}-${Date.now()}.json`);
          await atomicWriteJson(denseQueryVectorPath, vector, { spaces: 0 });
        } else {
          denseIssue = "the embedding backend returned no vector for this query";
        }
      } catch (error) {
        denseIssue = String(error?.message ?? error).replace(/\s+/g, " ").trim();
      }
    }

    const args = [
      "hybrid",
      "--index-path",
      searchIndexPath,
      "--query",
      normalizedQuery,
      "--scope",
      scope || "all",
      "--limit",
      "50",
      "--project",
      project || "",
      "--source",
      csvValue(source),
      "--categories",
      csvValue(categories),
      "--folders",
      csvValue(folders),
      "--semantic-weight",
      String(Number.isFinite(Number(semantic_weight)) ? Number(semantic_weight) : 0.20),
      "--keyword-weight",
      String(Number.isFinite(Number(keyword_weight)) ? Number(keyword_weight) : 0.45),
      "--dense-weight",
      String(selectedDenseWeight),
      "--dense-model-dir",
      path.resolve(String(dense_model_dir || defaultModelDir)),
      "--dense-device",
      String(dense_device || "cpu")
    ];
    if (denseQueryVectorPath) {
      args.push("--dense-query-vector-path", denseQueryVectorPath);
    }

    try {
      const results = await runSearchCli(args, {
        timeoutMs: selectedDenseWeight > 0 ? 300000 : 120000,
        command: pythonCommand()
      });
      let ranked = results;
      if (
        intent_routing
        && ["all", "knowledge"].includes(String(scope || "all"))
        && !project
        && !csvValue(folders)
        && !csvValue(source)
      ) {
        ranked = prioritizeKnowledgeResults(normalizedQuery, ranked);
      }
      if (rerank) {
        ranked = rerankSearchResults(normalizedQuery, ranked, {
          scope,
          preset: preset_name,
          hardNegativeRules: await hardNegativeRules()
        });
      }
      if (!intent_routing || !["all", "skills"].includes(String(scope || "all"))) {
        return withDenseNote(ranked.slice(0, requestedLimit), denseIssue);
      }
      if (project || csvValue(folders)) return withDenseNote(ranked.slice(0, requestedLimit), denseIssue);
      if (isSkillCatalogQuery(normalizedQuery)) return withDenseNote(ranked.slice(0, requestedLimit), denseIssue);
      const selectedSources = new Set(csvValue(source).split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
      if (selectedSources.size && !selectedSources.has("custom")) return withDenseNote(ranked.slice(0, requestedLimit), denseIssue);

      const route = routeSkills({ task: normalizedQuery, maxSkills: 3 });
      const registry = await readSkillIndex();
      const customByName = new Map(
        registry
          .filter((item) => item.source === "custom")
          .map((item) => [String(item.name || "").toLowerCase(), item])
      );
      const routed = route.skills
        .map((selection, index) => {
          const item = customByName.get(String(selection.name || "").toLowerCase());
          if (!item) return null;
          return {
            scope: "skills",
            title: item.name,
            path: item.path,
            source: item.source,
            categories: Array.isArray(item.categories) ? item.categories.join(", ") : String(item.categories || ""),
            score: Number((2 - index * 0.01).toFixed(6)),
            keyword_score: 0,
            semantic_score: 0,
            dense_score: 0,
            mode: "routed-hybrid",
            preview: item.description || item.use_when || "",
            routing_role: selection.role,
            routing_reason: selection.reason,
            routing_rule: selection.rule,
            retrieval_stage: "deterministic-intent-router"
          };
        })
        .filter(Boolean);
      const routedNames = new Set(routed.map((item) => item.title.toLowerCase()));
      return [...routed, ...ranked.filter((item) => !routedNames.has(String(item.title || "").toLowerCase()))]
        .slice(0, requestedLimit);
    } finally {
      if (denseQueryVectorPath) {
        await fs.rm(denseQueryVectorPath, { force: true }).catch(() => {});
      }
    }
  }

  return {
    markDirty,
    dirtyReason: dirtyReasonNow,
    status,
    rebuild,
    ensureFresh,
    search,
    hybridSearch,
    exportGalaxy,
    engine: () => ({ ...engine() })
  };
}
