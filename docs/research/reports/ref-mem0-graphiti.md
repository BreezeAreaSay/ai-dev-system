# mem0 and Graphiti: memory-update contracts, temporal semantics, and evaluation — for a JSON-file MCP memory

Sources cloned (shallow) under `scratchpad/ref/`: `mem0ai_mem0` (HEAD `c7ee362`, 2026‑09‑11, `pyproject.toml:7` → `version = "2.0.20"`) and `getzep_graphiti`. Both repos: **Apache License 2.0** (`mem0ai_mem0/LICENSE:1-5`, `getzep_graphiti/LICENSE:1-5`).

---

## Part 1 — mem0

### 1.0 Important version note

This checkout is a **much newer mem0 (2.0.20)** than the classic "ADD/UPDATE/DELETE/NONE" design most blog posts describe. Two things the task brief expects are **not present** in this tree:

- **No `graph_memory.py` / graph store anywhere** (`grep -rln "Neo4j|kuzu|FalkorDB|MemoryGraph"` over `mem0/` returns nothing but the neptune *vector* store and leftover Cypher-sanitization helpers in `mem0/memory/utils.py:253-329`). Local/OSS graph-backed memory appears dropped in favor of a lightweight **vector-backed entity store** (see 1.4).
- **No `openmemory/` directory** anywhere in the tree (`grep -ril openmemory` only hits `docs/`) — not part of this snapshot; flagging as **missing**, cannot report its tool list/footprint from code.
- `evaluation/` is a **git submodule** (`.gitmodules:1-3`, url `mem0ai/memory-benchmarks`), not fetched (empty directory). Its content is described in detail by `docs/core-concepts/memory-evaluation.mdx` instead (real repo file, used below).

### 1.1 The actual write pipeline: `Memory._add_to_vector_store` (`mem0/memory/main.py:879-1206`)

`Memory.add()` (`main.py:760-877`) normalizes `messages`/`metadata`/`filters`, then calls `_add_to_vector_store`. If `infer=False` (`main.py:880-914`): **no LLM call at all** — each message is embedded and written straight to the vector store as its own memory (`role`, optional `actor_id` from `message["name"]`), fully deterministic.

If `infer=True`, this version runs a **"V3 PHASED BATCH PIPELINE"** (comment at `main.py:916`), not the classic per-fact ADD/UPDATE/DELETE/NONE loop:

1. Phase 0/1 — pull last 10 session messages (`db.get_last_messages`) and top‑10 semantically similar existing memories (`vector_store.search`, scoped by `user_id/agent_id/run_id`).
2. Phase 2 — **one** LLM call with `ADDITIVE_EXTRACTION_PROMPT` (`mem0/configs/prompts.py:468` area) — its own docstring states: *"Your sole operation is ADD: identify every piece of memorable information..."* (`prompts.py:472`). The model may attach `linked_memory_ids` to relate a new fact to an existing one (`prompts.py:513`), but it never emits UPDATE/DELETE.
3. Phase 3-6 — batch-embed extracted facts, **hash-based dedup** (`hashlib.md5(text.encode()).hexdigest()`, `main.py:1020-1024`) against both existing-memory hashes and the current batch, then batch-insert vectors + batch-write history rows with `event="ADD"` (`main.py:1064-1084`).
4. Phase 7 — spaCy-based entity extraction (`extract_entities_batch`, deterministic, see 1.5) and linking into a separate `entity_store` vector collection (`main.py:1086-1190`).

`docs/core-concepts/memory-evaluation.mdx:42` names this explicitly: *"The key architectural decision is **ADD-only extraction**. New facts are stored alongside old ones. Nothing is overwritten or deleted. When information changes, both the old and new facts survive."*

### 1.2 The legacy ADD/UPDATE/DELETE/NONE contract (still in the codebase, but dead code on the main path)

`mem0/configs/prompts.py:176-324` defines `DEFAULT_UPDATE_MEMORY_PROMPT` and `get_update_memory_messages()` (`prompts.py:406-460`). It is **not imported by `mem0/memory/main.py`** (`grep -rn "get_update_memory_messages|DEFAULT_UPDATE_MEMORY_PROMPT" mem0/ --include=*.py` returns only `prompts.py` itself) — kept for backward compatibility / other integrations, not the live pipeline. Quoted rules (`prompts.py:181-185`):

> "Compare newly retrieved facts with the existing memory. For each new fact, decide whether to:
> - ADD: Add it to the memory as a new element
> - UPDATE: Update an existing memory element
> - DELETE: Delete an existing memory element
> - NONE: Make no change (if the fact is already present or irrelevant)"

Required JSON shape (`prompts.py:439-449`):
```
{"memory":[{"id":"<ID>","text":"<content>","event":"ADD|UPDATE|DELETE|NONE","old_memory":"<only if UPDATE>"}]}
```
Rules for UPDATE ("keep the fact which has the most information", same id preserved) and DELETE ("If the retrieved facts contain information that contradicts the information present in the memory") are in `prompts.py:216-293`. This is a clean, portable state machine even though mem0 itself no longer drives it from `add()`.

### 1.3 History and memory-item schema

SQLite `history` table (`mem0/memory/storage.py:68-79`, migrated in place if an older schema is found, `storage.py:20-100`):
```sql
CREATE TABLE history (
  id TEXT PRIMARY KEY, memory_id TEXT, old_memory TEXT, new_memory TEXT,
  event TEXT, created_at DATETIME, updated_at DATETIME,
  is_deleted INTEGER, actor_id TEXT, role TEXT
)
```
`add_history()`/`batch_add_history()` (`storage.py:150-225`) insert one row per state transition; `get_history(memory_id)` orders `ASC created_at, DATETIME(updated_at)` (`storage.py:227-255`). Separate `messages` table caps to the last 10 rows per `session_scope` (`storage.py:279-291`) — a deterministic rolling window, no LLM summarization.

`MemoryItem` Pydantic schema (`mem0/configs/base.py:17-27`): `id, memory, hash, metadata, score, created_at, updated_at`. Per-memory vector payload (built in `_create_memory`/`_add_to_vector_store`) additionally carries `data`, `hash` (md5), `text_lemmatized` (BM25), `created_at`/`updated_at` (ISO-8601 UTC), optional `expiration_date`, `attributed_to`, `role`, `actor_id`, plus the scoping keys `user_id`/`agent_id`/`run_id`.

`_update_memory` (`main.py:2038-2098`) recomputes hash/lemma, sets `updated_at=now()` while **preserving** `created_at`, writes an `UPDATE` history row with `old_memory`/`new_memory`, and re-links entities only `if text_changed`. `_delete_memory` (`main.py:2100-2128`) writes a `DELETE` history row (`is_deleted=1`, `new_memory=None`) and strips the memory id from the entity store — a soft-delete audit trail over a hard vector delete.

### 1.4 Dedup and the "graph" replacement

- **Hash dedup** is exact-string MD5, O(1) set lookup (`main.py:1007-1024`) — fully deterministic, no embedding threshold involved for exact repeats.
- **Entity linking** (`main.py:583-731`, `_upsert_entity`/`_link_entities_for_memory`) is a *lightweight graph substitute*: entities get their own vector-store collection (`entity_store`), matched by exact normalized text first, else embedding cosine `score >= 0.95` (`main.py:1152`), and `linked_memory_ids` is just a list on the entity payload — not a labeled-property graph, no Cypher, no separate graph DB dependency.

### 1.5 What needs an LLM vs what's deterministic in mem0

| Step | Needs LLM? | Notes |
|---|---|---|
| Fact/entity extraction (`ADDITIVE_EXTRACTION_PROMPT`) | **Yes** | one call per `add()`, JSON-mode |
| Hash dedup | No | `hashlib.md5` exact match |
| Entity/NER extraction | No | spaCy (`mem0/utils/entity_extraction.py:1-16`): proper nouns, quoted text, noun compounds — regex/POS heuristics, not an LLM |
| Entity matching for linking | Mostly no | exact-text first, embedding cosine ≥0.95 fallback (needs an embedding model, not an LLM) |
| BM25 + semantic + entity score fusion | **No** | `mem0/utils/scoring.py:60-129`, pure arithmetic: `combined = (semantic + bm25 + entity_boost) / max_possible`, sigmoid-normalized BM25 (`scoring.py:43-58`) |
| Expiration (`expiration_date`) | No | plain date compare, `main.py:442-451` |
| Legacy UPDATE/DELETE decision (§1.2) | Yes (when used) | semantic judgment of "contradicts" / "same information" |
| Procedural-memory summarization | Yes | `_create_procedural_memory`, `main.py:1993-2036` |

### 1.6 Evaluation approach (from `docs/core-concepts/memory-evaluation.mdx`, real repo file, since the `evaluation/` submodule content itself wasn't fetched)

Benchmarks used: **LoCoMo** (single/multi-hop, open-domain, temporal recall — line 69), **LongMemEval** (single/multi-session, knowledge-update, temporal — line 85), and mem0's own **BEAM** (1M/10M-token scale, 10 categories including `knowledge_update`, `temporal_reasoning`, `event_ordering`, `contradiction_resolution`, `abstention` — lines 101-123). All are graded with an answerer LLM + a **judge LLM**, at a configurable `--top-k` retrieval budget (default 200), reporting accuracy *and* mean tokens/query as a joint metric (lines 10-16). CLI flags include `--backend oss|cloud`, `--top-k-cutoffs 10,20,50,200`, `--predict-only`, `--evaluate-only`, `--resume` (lines 182-197).

Per-question result JSON (lines 280-309) — directly reusable as a template for an offline eval suite:
```json
{
  "id": "locomo_q_001", "group": "temporal",
  "question": "...", "ground_truth": "...",
  "retrieval": {"search_query": "...", "search_results": ["..."], "search_latency_ms": 123.4, "total_results": 42},
  "generation": {"generated_answer": "...", "model": "...", "prompt_tokens": 500, "completion_tokens": 100},
  "judgment": {"judgment": "CORRECT", "score": 0.85, "reason": "...", "model": "..."},
  "cutoff_results": {"top_10": {"score": 0.75, "judgment": "CORRECT"}, "top_50": {...}, "top_200": {...}}
}
```
What's reusable **offline, without an LLM judge**: the `retrieval` block shape (query, ranked result ids, latency, total candidates) and the `cutoff_results` multi-k structure map directly onto deterministic Recall@k/MRR computation once you have gold relevant-memory ids — you don't need the LLM-judge `judgment`/`generation` blocks for a retrieval-only eval harness.

---

## Part 2 — Graphiti

### 2.1 Bi-temporal model

Two independent time axes, both real fields, not derived:

- **Ingestion time** — `EpisodicNode.created_at = utc_now()`, set at the moment `add_episode()` runs (`graphiti_core/graphiti.py:1131,1167`).
- **Event/document time** — `reference_time` (caller-supplied `datetime`, required param of `add_episode`, `graphiti.py:1048`) becomes `EpisodicNode.valid_at` (`graphiti.py:1168`) and is what "last week"/"yesterday" are resolved against inside prompts (`extract_edges.py:127-129`, `extract_timestamps` DATETIME RULES).

`EntityEdge` (`graphiti_core/edges.py:263-285`) then carries **four** temporal fields on every fact:
- `created_at: datetime` — when the edge row was written (system time; inherited from `Edge` base, `edges.py:54`).
- `valid_at: datetime | None` — "datetime of when the fact became true" (`edges.py:274-276`).
- `invalid_at: datetime | None` — "datetime of when the fact stopped being true" (`edges.py:277-279`).
- `expired_at: datetime | None` — "datetime of when the [edge] was invalidated" (`edges.py:271-273`) — i.e. *when the system learned* the fact was no longer valid, as distinct from `invalid_at` (*when the fact itself* stopped being true). This is the classic bitemporal split: valid-time (`valid_at`/`invalid_at`) vs transaction-time (`created_at`/`expired_at`).
- Plus `episodes: list[str]` (provenance — which episode ids produced/confirmed this fact) and `reference_time` (the episode's `valid_at` at extraction time).

### 2.2 Edge invalidation: hybrid LLM contradiction detection + deterministic date arithmetic

Two separate mechanisms, both in `graphiti_core/utils/maintenance/edge_operations.py`:

**(a) LLM decides *which* facts contradict** — `dedupe_edges.resolve_edge()` prompt (`graphiti_core/prompts/dedupe_edges.py:43-100`) sends the model a `NEW FACT` plus two continuously-indexed candidate lists (`EXISTING FACTS` for dedup, `FACT INVALIDATION CANDIDATES` for contradiction) and asks for `duplicate_facts`/`contradicted_facts` index lists (`EdgeDuplicate` model, `dedupe_edges.py:24-32`). Quoted system rule: *"NEVER mark facts with key differences as duplicates."* (`dedupe_edges.py:47-48`), and: *"A fact from EXISTING FACTS can be both a duplicate AND contradicted (e.g., semantically the same but the new fact updates/supersedes it)."* (`dedupe_edges.py:81`).

**(b) Deterministic timestamp arithmetic decides the actual expiry** — `resolve_edge_contradictions()` (`edge_operations.py:538-573`) takes the LLM-flagged `invalidation_candidates` and, purely with `datetime` comparisons, decides which to expire:
```python
# edge_operations.py:564-571
elif (edge_valid_at_utc is not None and resolved_edge_valid_at_utc is not None
      and edge_valid_at_utc < resolved_edge_valid_at_utc):
    edge.invalid_at = resolved_edge.valid_at
    edge.expired_at = edge.expired_at if edge.expired_at is not None else utc_now()
    invalidated_edges.append(edge)
```
i.e. **"the older-valid_at edge is superseded by the newer one, its `invalid_at` becomes the new edge's `valid_at`, and `expired_at` is stamped now"** — a pure function of two edges' timestamps, no LLM call. The same file also does the symmetric case for the *new* edge arriving "late" with older information (`edge_operations.py:826-838`, sorted by `valid_at` and expired if a candidate is chronologically after it). **This half is fully portable** to a JSON store.

**(c) Timestamps themselves come from a small, separate LLM call** — `_extract_edge_timestamps()` (`edge_operations.py:576-620`) only runs if the edge doesn't already have `valid_at`/`invalid_at` set from the batch extraction prompt, using `EdgeTimestamps{valid_at, invalid_at}` (`prompts/extract_edges.py:59-69`). Quoted DATETIME RULES (`prompts/extract_edges.py:168-175`):
> "Use ISO 8601 with 'Z' suffix (UTC)... If the fact is ongoing (present tense), set `valid_at` to the timestamp of the episode the fact originates from... If a change/termination is expressed, set `invalid_at`... Leave both fields `null` if no explicit or resolvable time is stated... Do **not** hallucinate or infer temporal bounds from unrelated events."

So: **extracting** *when* a fact is true needs an LLM (NL date resolution); **applying** the supersession rule once two facts' intervals are known is deterministic.

### 2.3 Dedup logic — three tiers, only the last needs an LLM

`graphiti_core/utils/maintenance/dedup_helpers.py`:
1. **Exact match** — lowercase + whitespace-collapse (`_normalize_string_exact`, `dedup_helpers.py:39-42`), always run first regardless of name length.
2. **Deterministic fuzzy match** — for "high-entropy" names only (an entropy gate, `_has_high_entropy`, `dedup_helpers.py:79-85`, to avoid false-matching short generic names), 3-gram shingles → MinHash signature → LSH banding → Jaccard similarity, threshold `_FUZZY_JACCARD_THRESHOLD = 0.9` (`dedup_helpers.py:34,88-140`). No embeddings or LLM calls.
3. **Embedding + LLM adjudication** — only reached for nodes the first two tiers don't resolve: `node_similarity_search(...)` with `NODE_DEDUP_COSINE_MIN_SCORE = 0.6` (`node_operations.py:65,418-451`) retrieves candidates, then `_resolve_with_llm()` (`node_operations.py:467-`) makes the final call.

Edge dedup uses the same LLM `resolve_edge` prompt (2.2a) rather than a separate deterministic pre-pass — there's a fast exact-text-match shortcut first though (`edge_operations.py:684-695`, `_normalize_string_exact` on the fact string with matching endpoints, reuses the edge and just appends the episode id — no LLM call for verbatim repeats).

### 2.4 Search recipes, rerankers, temporal filters

`graphiti_core/search/search_config_recipes.py` defines named `SearchConfig` presets combining edge/node/community search with a reranker suffix: `_RRF`, `_MMR`, `_CROSS_ENCODER`, plus edge-only `_NODE_DISTANCE` and `_EPISODE_MENTIONS` (`search_config_recipes.py:34-217`). Reranker implementations in `search_utils.py`:
- `rrf()` (`search_utils.py:1775-1790`) — classic reciprocal-rank fusion, `score += 1/(rank+k)` across result lists, deterministic, trivially portable.
- `maximal_marginal_relevance()` (`search_utils.py:1901+`) — deterministic given embeddings (relevance/diversity tradeoff).
- `node_distance_reranker()` (`search_utils.py:1793+`) — graph-hop distance from a center node; deterministic but graph-shaped (would need an adjacency structure, not just a flat JSON list).
- Cross-encoder rerankers (`graphiti_core/cross_encoder/{openai,gemini,bge}_reranker_client.py`) — **need an LLM or a local cross-encoder model** (BGE variant can run fully local/offline).

`SearchFilters` (`graphiti_core/search/search_filters.py:55-67`): `node_labels`, `edge_types`, `valid_at`, `invalid_at`, `created_at`, `expired_at` (each `list[list[DateFilter]]` — outer list = OR, inner list = AND, with `ComparisonOperator` `=/<>/>/</>=/<=/IS [NOT] NULL`, `DateFilter.py:27-42`), `edge_uuids`, `property_filters`. This is a full **as-of / point-in-time query** capability at the filter level (e.g. `valid_at <= T AND (invalid_at IS NULL OR invalid_at > T)` expresses "facts true as of T").

### 2.5 MCP server

`mcp_server/src/graphiti_mcp_server.py` exposes 13 `@mcp.tool()` functions (grep of decorated defs): `add_memory` (`:366`), `search_nodes` (`:502`), `search_memory_facts` (`:579`), `delete_entity_edge` (`:659`), `delete_episode` (`:685`), `get_entity_edge` (`:714`), `get_episodes` (`:741`), `summarize_saga` (`:811`), `build_communities` (`:864`), `add_triplet` (`:918`), `get_episode_entities` (`:992`), `clear_graph` (`:1028`), `get_status` (`:1071`). `search_memory_facts` (`:579-655`) directly exposes the bi-temporal filters as tool params: `valid_at_after/before`, `invalid_at_after/before` (an as-of query surface at the MCP layer). Result shape: `format_fact_result()` (`mcp_server/src/utils/formatting.py:64-82`) = `EntityEdge.model_dump(mode="json", exclude={"fact_embedding"})`, i.e. the full edge record (`uuid, fact, name, source_node_uuid, target_node_uuid, episodes, created_at, valid_at, invalid_at, expired_at, attributes, group_id`) minus the embedding vector.

### 2.6 Footprint (driver abstraction)

`GraphProvider` enum (`graphiti_core/driver/driver.py:59-63`): `NEO4J`, `FALKORDB`, `KUZU`, `NEPTUNE`. Neo4j/FalkorDB/Neptune are client-server; **Kuzu is lightest** — embedded, file-backed, no server process, closest to "just files" — but still a full Cypher-subset query engine, not a plain JSON store. No pure-JSON/flat-file backend exists in `graphiti_core/driver/`; this is the heaviest part of Graphiti relative to the target.

---

## (a) Portable ideas (tagged by source)

- **Deterministic supersession-on-valid_at**: when a new fact/record's `valid_at` is later than an existing one's, set the old record's `invalid_at = new.valid_at` and `expired_at = now()` — pure date comparison, no LLM. — *`getzep_graphiti/graphiti_core/utils/maintenance/edge_operations.py:538-573`*
- **Four-field temporal record** (`created_at`/`valid_at`/`invalid_at`/`expired_at` = transaction-time vs valid-time split) as the schema shape for any "fact" row. — *`getzep_graphiti/graphiti_core/edges.py:263-282`*
- **`SearchFilters` OR-of-AND date ranges** (`list[list[DateFilter]]`) as an as-of query mini-DSL: filter records where `valid_at <= T AND (invalid_at IS NULL OR invalid_at > T)`. — *`getzep_graphiti/graphiti_core/search/search_filters.py:36-67`*
- **Exact→fuzzy(MinHash/Jaccard ≥0.9)→embedding(cosine ≥0.6)→LLM** dedup cascade, only invoking the LLM on the residual ambiguous set. — *`getzep_graphiti/graphiti_core/utils/maintenance/dedup_helpers.py:34-266`, `node_operations.py:65,418-451`*
- **Reciprocal Rank Fusion** for combining keyword + vector result lists — 6 lines, no dependency. — *`getzep_graphiti/graphiti_core/search/search_utils.py:1775-1790`*
- **Hash-exact dedup before anything else** (MD5 of normalized text) as a zero-cost first filter before any embedding/LLM work. — *`mem0ai_mem0/mem0/memory/main.py:1007-1024`*
- **Additive scoring fusion** `(semantic + bm25 + entity_boost) / max_possible`, sigmoid-normalized BM25 — deterministic multi-signal ranking. — *`mem0ai_mem0/mem0/utils/scoring.py:43-129`*
- **Soft-delete audit history table** (`old_memory`, `new_memory`, `event`, timestamps, `is_deleted`) as an append-only log independent of the live record. — *`mem0ai_mem0/mem0/memory/storage.py:68-79,150-225`*
- **ADD-only, keep-both-versions philosophy** instead of destructive UPDATE — sidesteps a whole class of "did the LLM update the right memory" bugs; recency/temporal metadata resolves conflicts at *read* time instead of *write* time. — *`mem0ai_mem0/docs/core-concepts/memory-evaluation.mdx:20-43`*
- **`infer=False` raw-write escape hatch** — lets a caller bypass the LLM entirely for deterministic writes (e.g. a structured decision record). — *`mem0ai_mem0/mem0/memory/main.py:880-914`*
- **Legacy ADD/UPDATE/DELETE/NONE JSON contract** as a simple, auditable state machine if you *do* want write-time consolidation instead of ADD-only. — *`mem0ai_mem0/mem0/configs/prompts.py:176-324,406-460`*
- **Rolling last-N-messages window per session scope**, deterministically pruned by `DELETE ... NOT IN (SELECT ... ORDER BY created_at DESC LIMIT 10)`. — *`mem0ai_mem0/mem0/memory/storage.py:257-296`*

## (b) Not applicable / too heavy

- Neo4j/FalkorDB/Neptune Cypher machinery, the multi-driver abstraction (`graphiti_core/driver/*`), community-detection, saga/episode graph edges — all assume a real graph engine; even embedded Kuzu is a full query engine, not a JSON file.
- Graphiti's node-distance reranker (graph-hop distance) — needs an adjacency structure a flat JSON store doesn't have without building one.
- mem0's pluggable vector-store zoo (`mem0/vector_stores/*`, 20+ providers) and reranker zoo (Cohere/HF/ZeroEntropy) — infra breadth irrelevant at JSON-file scale; only the *algorithms* (scoring, dedup) are worth porting, not the provider adapters.
- mem0's BEAM/LongMemEval/LoCoMo benchmark **harness** (LLM answerer + LLM judge, multi-provider CLI, web UI) — too heavy for a local eval loop; only the **result JSON shape** is worth reusing (see (d)).
- mem0's OSS graph store and OpenMemory MCP server — neither exists in this repo snapshot (see §1.0); nothing to port from what isn't there.
- Graphiti's cross-encoder rerankers backed by OpenAI/Gemini — not warranted at JSON-file scale; RRF/MMR alone suffice.

## (c) Temporal-field JSON schema for a decision/memory record (deterministic supersession)

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "TemporalMemoryRecord",
  "type": "object",
  "required": ["id", "source_key", "created_at", "valid_at"],
  "properties": {
    "id": { "type": "string", "description": "Stable unique id (uuid)." },
    "source_key": {
      "type": "string",
      "description": "Identity key for 'what this record is about' (e.g. 'project:foo/deploy-target'). Records sharing a source_key form a supersession chain."
    },
    "supersedes": {
      "type": ["string", "null"],
      "description": "Explicit id of the record this one replaces, if not inferred purely from source_key."
    },
    "created_at": { "type": "string", "format": "date-time", "description": "Transaction time: when this record was written to the store." },
    "valid_at": { "type": "string", "format": "date-time", "description": "Event/document time: when the fact became true." },
    "invalid_at": { "type": ["string", "null"], "format": "date-time", "default": null, "description": "When the fact stopped being true. Set on the OLD record when a new one supersedes it." },
    "expired_at": { "type": ["string", "null"], "format": "date-time", "default": null, "description": "When the system recorded the invalidation (transaction time of the supersession, not the event)." },
    "current": { "type": "boolean", "description": "Derived/cached: true iff invalid_at is null. Recompute on write; do not hand-edit." },
    "content": { "type": "object", "description": "Payload: the actual decision/memory fields." },
    "provenance": {
      "type": "array", "items": { "type": "string" },
      "description": "Ids of episodes/messages/tool-calls that produced or confirmed this record."
    }
  },
  "deterministicRules": [
    "On insert of a new record R with a given source_key: find the current record C (same source_key, current=true, if any).",
    "If C exists and R.valid_at >= C.valid_at: set C.invalid_at = R.valid_at, C.expired_at = now(), C.current = false; set R.current = true.",
    "If R.supersedes is explicitly set to some id X: apply the same rule to X regardless of source_key match (explicit override wins).",
    "If C exists and R.valid_at < C.valid_at (a late-arriving older fact): do NOT invalidate C; insert R with current=false, invalid_at = C.valid_at (R was already superseded when it arrived).",
    "current = (invalid_at == null) is the only definition of 'active' — never a separate mutable flag set independently of invalid_at."
  ]
}
```

## (d) Memory-eval test-case JSON format (deterministic metrics only)

```json
{
  "case_id": "eval_0007",
  "query": "What deploy target did we agree on for the auth service?",
  "asked_at": "2026-09-15T10:00:00Z",
  "gold_relevant_ids": ["mem_0042", "mem_0051"],
  "gold_stale_ids": ["mem_0011"],
  "retrieved": [
    { "id": "mem_0042", "rank": 1, "score": 0.91 },
    { "id": "mem_0011", "rank": 2, "score": 0.77 },
    { "id": "mem_0051", "rank": 3, "score": 0.65 }
  ],
  "k_values": [5, 10, 20],
  "contradiction_pairs_in_result": [["mem_0042", "mem_0011"]],
  "tokens_used": { "prompt": 480, "completion": 0, "context_memories_chars": 610 },
  "metrics": {
    "recall_at_k": { "5": 1.0, "10": 1.0, "20": 1.0 },
    "mrr": 1.0,
    "precision_at_k": { "5": 0.667, "10": 0.667, "20": 0.667 },
    "stale_retrieval_rate": 0.333,
    "contradiction_rate": 0.333,
    "tokens_per_useful_memory": 240.0
  }
}
```
Deterministic formulas (no LLM judge required):
- **Recall@k** = `|retrieved[:k] ∩ gold_relevant_ids| / |gold_relevant_ids|`.
- **MRR** = `1 / rank_of_first_gold_relevant_hit` (0 if none in `retrieved`).
- **Precision@k** = `|retrieved[:k] ∩ gold_relevant_ids| / k`.
- **Stale-retrieval rate** = `|retrieved ∩ gold_stale_ids| / |retrieved|` — fraction of results that are records a supersession rule (schema in (c)) had already marked `current=false` as of `asked_at`.
- **Contradiction rate** = `|pairs in retrieved where both ids' source_key match but one's valid_at invalidates the other| / |retrieved choose 2|` — computed purely from the temporal schema in (c), no LLM needed.
- **Tokens per useful memory** = `tokens_used.context_memories_chars / max(1, |retrieved ∩ gold_relevant_ids|)` (or a real tokenizer count in place of chars) — mem0's own eval reports this alongside accuracy (`docs/core-concepts/memory-evaluation.mdx:10-16`).

This format directly mirrors mem0's `retrieval`/`cutoff_results` JSON (§1.6) minus the `generation`/`judgment` blocks that require an LLM judge — those can be added later as an optional extension without breaking the deterministic core.

## (e) Attribution needs

- **mem0** (`mem0ai/mem0`) — Apache License 2.0; copyright notice required, state changes if modified, include LICENSE. Any prompt/code text copied verbatim (e.g. the ADD/UPDATE/DELETE/NONE prompt, the scoring formula) should carry a source comment naming `mem0ai/mem0`, the path, and the Apache-2.0 license.
- **Graphiti** (`getzep/graphiti`) — Apache License 2.0, same obligations; `getzep_graphiti/LICENSE:1-5` confirmed identical header. `Zep-CLA.md` at repo root is a contributor CLA for submitting *upstream* — irrelevant to consuming the code.
- Neither license has an "advertising clause," so no UI attribution is required; a NOTICE/LICENSE-THIRD-PARTY file listing both projects, their license, and which mechanisms were ported (per (a)) is sufficient and good practice, given how specific some ported logic is (e.g. `edge_operations.py:564-571`).
