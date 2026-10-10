# Reference survey: explainable, source-keyed, temporal memory for Memory vNext

Three repos, shallow-cloned under `scratchpad/ref/`. All file:line citations are repo-relative paths under that root.

## 1. MNEMIC (`dongtang3_mnemic`)

**Language/storage**: TypeScript/Node.js (`mnemic-server`, `mnemic-cli`, `mnemic-sdk`, `mcp-server` — an npm workspace). Storage is pluggable behind a `MemoryStore` interface: default is a single JSON file (`FileMemoryStore`, `mnemic-server/src/store.ts:66-84`, full-object rewrite via `writeFile(..., JSON.stringify(normalizeState(state), null, 2))`), or SQLite (`SqliteMemoryStore`, `store.ts:87-991`) with normalized tables `memory_records`, `memory_tags`, `memory_relations`, `memory_events`, `memory_state` (`docs/agent-memory-architecture.md:184-190`). **No vector store, no embeddings, no LLM anywhere in the core** — recall is pure lexical substring matching (`mnemic-server/src/memoryService.ts:2051-2075`), and the eval harness is explicitly "model-free" (`docs/agent-memory-architecture.md:165`). **License**: MIT, "Mnemic contributors" 2026 (`LICENSE:1-3`).

**Record schema** (`mnemic-sdk/src/types.ts:29-49`, `AgentMemoryRecord`): `entityUid, title, content, memoryType, project, tags[], source, sourceKey, actor, importance, confidence, observedAt, validFrom, validTo, createdAt, updatedAt, metadata, relatedMemoryUids, policyFindings?`. `importance`/`confidence` are `clamp01`'d floats, defaulting to 0.5 and 0.7 respectively when unset (`memoryService.ts:949-950`); they are **set at write time and never auto-decayed** — grep for `decay` in the codebase returns zero hits outside docs; consolidation-over-event-log is explicitly a *roadmap* item, not implemented (`docs/agent-memory-architecture.md:195`).

**Source-keyed, precisely**: there is no `source_type/source_id/source_version` triple. Identity is one flat string field, `sourceKey` — "the idempotency key… commit SHAs, issue IDs, ticket IDs, session IDs" (`docs/agent-memory-architecture.md:44`). Lookup is exact string equality only: `state.memories.findIndex((memory) => memory.sourceKey === sourceKey)` (`memoryService.ts:925-927`). A blank `sourceKey` always creates a new record (`existingIndex = -1`). There is **no fuzzy/embedding near-duplicate detection** — matching is 100% exact-key or nothing.

**Write path**: `remember()` (`memoryService.ts:73-100`) calls `buildRememberPlan()` (`923-960`) which computes the full before/after record, then either updates in place or pushes a new record, appends an immutable `AgentMemoryEvent` with a `diff{subject, before, after, changedFields}` (`memoryEventDiff`, `1656-1666`), and saves. **Vocabulary is binary**, not the ADD/UPDATE/SUPERSEDE/CONFLICT taxonomy: `action: 'create' | 'update'`, `eventType: 'memory-created' | 'memory-updated'` (`mnemic-sdk/src/types.ts:222,311-312`). Same-sourceKey writes are silent last-write-wins updates — there is no conflict/contradiction detection between *different* sourceKeys with similar content.

**Preview / dry-run** (`AgentMemoryWritePreview`, `types.ts:308-324`; `previewRemember()`, `memoryService.ts:102-146`): runs the identical plan against a cloned state without persisting, returning `action`, `wouldAppendEventUid`, `sourceKeyMatched: Boolean(plan.existing)`, `beforeMemory`/`afterMemory`, a full `diff`, `relationPreviews[]` (each with `alreadyExists` + its own diff), `policyFindings[]`, `warnings[]`, and **whole-state summaries** `before`/`after` (`AgentMemoryStateSummary`: memoryCount, relationCount, eventCount, memories[]). This is a genuinely complete dry-run — every side effect (relations included) is previewed before commit.

**Governance/policy** (`memoryService.ts:1031-1153`, config type `AgentMemoryPolicyConfig`, `types.ts:61-80`): deterministic, regex/rule-based, no LLM. Four rule families: `requireSourceKey` (blocks writes of listed `memoryTypes`/`tags` lacking a `sourceKey`), `secrets` (regex scan, built-in + custom patterns, scoped to specific fields), `confidence` (warn below a threshold, stricter threshold for high-importance writes), `stale` (severity when `validTo` is already in the past *at write time*). Findings carry `policyId, severity ('info'|'warning'|'block'), field, message, recommendation`; `block` severity throws (`assertPolicyAllowsWrite`, `1145-1152`).

**Recall / explainability** (`explainRecall()`, `memoryService.ts:200-224`; `explainMemoryRecall()`, `1876-1902`): per-hit output is `AgentMemoryRecallExplanationEntry` with **exact fields** — `memory, score, lexicalScore, importanceBoost, relationBoost, matchedTerms[], matchedFields[], fieldScores: Record<string,number>, relationPaths[], stale: boolean, reasons: string[]`. `lexicalExplanation()` (`1904-1954`) scores per-field substring/whole-query matches with fixed weights (title=3, content=2, memoryType/project/tags/source/sourceKey=1) and returns which terms hit which field. `relationBoost` sums up to two graph hops of explicit relations, capped at 2.0 (`scoredRelationPaths`, `1956-1987`, capped `slice(0,8)`). `reasons[]` is a small templated sentence list ("Matched title, content.", "High importance 0.9.", "Marked stale after 2025-01-01."). **Temporal recall**: `validFrom`/`validTo` window plus an `asOf` query parameter honored by `isMemoryValidAt()` (`1995-2004`) across `search`, `explainRecall`, `contextPack`, `timeline`, `export`. `isStaleMemory()` (`1989-1993`) is simply `validTo < now`; stale hits are still returned but penalized (`score -0.5`) and flagged, never silently dropped.

**Replay/rollback**: full event-sourcing. `replayEvents()`/`stateFromEvents()` (`1383-1427`) rebuild the entire memory+relation state from the event array; `snapshot()` and `mnemic snapshot --as-of <ts>` reconstruct historical state. `rollbackPreview`/`rollback` (`555-...`, `AgentMemoryRollbackOperation`: `remove-memory|restore-memory|remove-relation|no-op`) compute and then apply the inverse of one event, warning about any *later* events that also touched the target. JSONL export/import (`AgentMemoryJsonlExportLine`, one event per line) supports interchange and idempotent replay (`skippedDuplicateEventUids`).

**Context pack** (`contextPack()`, `memoryService.ts:285-319`): default `limit=8` memories via the same lexical `search()`, each rendered as a fixed-format text block (type, title, uid, importance, project, tags, `Content:` truncated to `maxContextContentChars = 900` chars (`memoryService.ts:40`), source, sourceKey, related uids, confidence, observedAt, valid window). No token-budget math — just a per-item char cap and an item-count cap.

**MCP tools** (17, `docs/agent-memory-architecture.md:111-127`): `mnemic_remember, mnemic_preview_memory, mnemic_recall, mnemic_explain_recall, mnemic_get_memory, mnemic_context_pack, mnemic_session_briefing, mnemic_memory_stats, mnemic_policy, mnemic_audit, mnemic_memory_timeline, mnemic_export_jsonl, mnemic_snapshot, mnemic_import_jsonl, mnemic_rollback_preview, mnemic_rollback, mnemic_link_memories`. CLI mirrors this 1:1 (`docs/agent-memory-architecture.md:140-163`), including `mnemic doctor` (readiness checks) and `mnemic eval` (deterministic recall@k/hit-rank/stale-false-positive benchmark, no model calls). **Deps**: essentially zero runtime deps beyond its own SDK (`mnemic-server/package.json`: `{"@mnemic/sdk": "file:../mnemic-sdk"}`).

## 2. HURTTLOCKER/CORTEX (`hurttlocker_cortex`)

**Language/storage**: Go (module `github.com/hurttlocker/cortex`), SQLite via the pure-Go `modernc.org/sqlite` driver (`internal/store/store.go:20,421`), local ONNX runtime for embeddings (`go.mod:5-9`: `mark3labs/mcp-go`, `sugarme/tokenizer`, `yalue/onnxruntime_go`) — no cloud LLM dependency required for the memory kernel. **License**: MIT, "LavonTMCQ" 2026 (`LICENSE:1-3`).

**Record schema** — the `facts` table (`internal/store/migrations.go:234-256`): `id, memory_id (FK), entity_id (FK), subject, predicate, object, fact_type CHECK IN ('kv','relationship','preference','temporal','identity','location','decision','state','config'), confidence REAL DEFAULT 1.0, decay_rate REAL DEFAULT 0.01, last_reinforced DATETIME, source_quote, temporal_norm, created_at, state CHECK IN ('active','core','retired','superseded'), superseded_by (FK to facts.id), agent_id, observer_agent, observed_entity, session_id, project_id, token_estimate`. This is the most explicit provenance/source-keying of the three: every fact carries `agent_id`/`observer_agent`/`observed_entity`/`session_id`/`project_id` as first-class scope columns (indexed as a composite, `idx_facts_scope_lookup`), not a bolted-on metadata blob.

**"Suggestion, not automatic trust" model** — exactly the `directive_proposals` table (`migrations.go:1182-1216`): `candidate_rule, pattern_key, occurrences, window_start, window_end, evidence (JSON array), status CHECK IN ('pending','accepted','dismissed'), created_directive_id (FK), created_at, resolved_at`. Comment states the design directly: *"the proposer loop's holding area… A proposal is inert governance material: it only ever becomes a real directive on an explicit human `accept`, which is the sole code path from this table to a directives INSERT. Scanning never writes a directive."* (`migrations.go:1182-1188`). CLI surface (`cmd/cortex/propose.go:39-48`): `cortex propose scan [--min-occurrences 3] [--window 14d] [--dry-run]`, `list [--all]`, `accept <id>`, `dismiss <id>`. Default recurrence threshold is 3 occurrences in a 14-day window (`store.DefaultProposalMinOccurrences = 3`, `internal/store/proposals.go:18-20`, dedup by `pattern_key` against overlapping windows). MCP tools mirror this: `cortex_propose_scan/list/accept/create/dismiss` plus `cortex_directive_add/list` (grep over `internal/mcp/`).

**Lifecycle runner** (`internal/lifecycle/runner.go`) — three independently-toggleable, fully deterministic (no LLM) policies over the `facts` table, each dry-runnable and each reporting per-candidate skip reasons:
- **reinforce-promote** (`runner.go:123-200`): a fact's `state` moves `active → core` when its reinforcement-access count (from `fact_accesses_v1`, types `reinforce|reference|import`) is `>= MinReinforcements` **and** the count of distinct `memory_id`s asserting the same normalized (subject,predicate,object) is `>= MinSources`. Defaults: `MinReinforcements=5, MinSources=3` (`internal/config/resolver.go:178-181`).
- **decay-retire** (`runner.go:202-277`): `active|core → retired` when `days_since_last_access >= InactiveDays` **and** `confidence < ConfidenceBelow`. Defaults: `InactiveDays=45, ConfidenceBelow=0.35` (`resolver.go:184-187`). This is a discrete inactivity+confidence gate, not a continuous numeric decay curve — `decay_rate` exists as a per-fact column but is not read by this runner (reserved for a finer-grained mechanism elsewhere/future).
- **conflict-supersede** (`runner.go:279-367`, `pickConflictWinner`): given two facts in attribute conflict, winner is chosen by (a) more-specific object as a substring of the other's object, else (b) in `--aggressive` mode, age gap `>30 days` → newer wins outright, else (c) `|confidence1 - confidence2| >= MinConfidenceDelta` (default `0.02`) → higher-confidence wins, optionally gated by `RequireStrictlyNewer=true` (default) so a higher-confidence-but-older fact does *not* win. The loser is marked `superseded_by = winner.id`, `state='superseded'` via `SupersedeFact()`.

**Near-duplicate detection** (`internal/store/facts_dedup.go:22-251`): **lexical, not embedding-based** — default `Threshold=0.90` (`facts_dedup.go:24`) computed from `normalizeFactKey(subject,predicate)` exact-match plus `factObjectSimilarity()` = a blend of token Jaccard and normalized Levenshtein distance on the object string.

**Retrieval**: `cortex search`/`recall`/`context` (`cmd/cortex/recall_context.go`) support `--mode keyword|semantic|hybrid|rrf` (reciprocal-rank fusion), `--min-score`, `--source-boost <prefix:weight>`, scope filters (`--agent/--session-key/--scope agent:<id>|entity:<id>|session:<id>|project:<id>`), and token-budgeted context assembly (`--max-items`, `--max-tokens`, `buildContextSelection`, `recall_context.go:738-826`) with an explicit evidence-fallback flag. Per-candidate ranking blends a `recallRankScore` (query-profile-dependent bonuses/penalties, `recall_context.go:666-736`) with confidence-tiered classification (`classifyRecallResult`, thresholds e.g. `maxDurableConfidence >= 0.60`, `620-650`).

**Footprint**: single static Go binary, SQLite file, optional local ONNX embedding model or Ollama — no mandatory network calls, no mandatory LLM. MCP tool surface: `cortex_search, cortex_facts, cortex_answer, cortex_reason, cortex_reinforce, cortex_stale, cortex_stats, cortex_graph(+export), cortex_edge_add, cortex_directive_add/list, cortex_propose_*, cortex_ledger_record, cortex_import, cortex_connect_*`.

## 3. CDEUST/CORTEX (`cdeust_Cortex`, package `hypermnesia-mcp` v4.22.0)

**Language/storage**: Python (`mcp_server/`), self-described as "Scientifically-grounded memory system based on computational neuroscience research" (`pyproject.toml:6-7`). Default backend is **SQLite** (`DB_PATH = METHODOLOGY_DIR / "memory.db"`, `mcp_server/infrastructure/memory_config.py:51`), with an optional PostgreSQL backend (`psycopg[binary]>=3.1`, `pyproject.toml:82-84`) that unlocks server-side stored-procedure signals (HNSW-style ANN, spreading activation). **License**: MIT, "Clément Deust" 2025 (`LICENSE:1-3`).

**Decay formula, with constants** (`mcp_server/core/thermodynamics.py:225-268`, `compute_decay`): base is classic Ebbinghaus exponential, `heat(t) = heat(0) * λ^hours`, default `λ = 0.95`/hour (env-overridable `CORTEX_DECAY_LAMBDA`, `thermodynamics.py:28-33`). The "adaptive" (default) path modulates the effective λ per fact: high-importance content (`importance > 0.7`) uses a slower `importance_decay_factor = 0.998` instead of the base λ; then three multiplicative retention bonuses compress the decay further — `emotional_mod = 1 + |valence| * 0.5 * (1 - e^-hours)`, `confidence_mod = 1 + confidence*0.1`, and `value_mod = retention_bonus(value)` — each applied as `effective = 1 - (1-effective)/mod`. A second, separate decay exists for entity "heat" (not fact confidence): `new_heat = current_heat * (0.98 ** hours_since_access)`, floored at `cold_threshold=0.05`, applied only when `|Δheat| > 0.001` (`mcp_server/core/decay_cycle.py:54-79`).

**Consolidation**: `plan_cls_consolidation()` (`mcp_server/core/consolidation_engine.py:72-113`) — clusters episodic memories by embedding similarity (`cluster_threshold=0.6`), keeps clusters recurring `>= min_occurrences=3` across `>= min_sessions=2`, checks internal consistency, abstracts each surviving cluster to a semantic "schema" (`abstract_to_schema`), skips if it duplicates an existing semantic memory (`dedup_threshold=0.85` cosine), and flags "confabulation risk" via a separate heuristic gate. **No LLM call anywhere in this path** — it's template/heuristic abstraction over clustered embeddings, orchestrated from `consolidate.py` alongside independent cycles (decay, FTS→gist→tag compression, episodic→semantic transfer, LTP/LTD plasticity, microglial pruning, homeostatic scaling — `mcp_server/handlers/consolidate.py:12-30`), all algorithmic, none requiring generation.

**Confidence/usefulness — explicit feedback loop**: the `rate_memory` MCP tool (`mcp_server/handlers/rate_memory.py:1-11,121-196`) is the canonical usefulness signal: `confidence = useful_count / access_count` once `access_count > 3` (`_MIN_ACCESSES_FOR_CONFIDENCE=3`, `thermodynamics.py:297-304`), citing Nelson & Narens 1990 metamemory. It also runs a TD(0) value update (`V ← V + α(reward − V)`) and optionally records a `(cross-encoder-score, useful)` sample to recalibrate the reranker's Platt scaling. Implicit-use signals are separate: `heat` bumps on retrieval (`+0.05` update, `+0.02` passive, `-0.10` archive; `reconsolidation.py:258-261`) via the reconsolidation mechanism below.

**Contradiction/reconsolidation** (`mcp_server/core/reconsolidation.py:56-169`): on each retrieval, a weighted `mismatch` score (embedding distance 0.5, directory distance 0.2, temporal distance 0.15, tag-Jaccard divergence 0.15) is compared against thresholds (`low=0.15, high=0.65`, both age/stability-adjusted) to decide `none | update | archive` for that memory — i.e. contradiction handling is graded, not binary supersede/keep.

**Provenance**: a distinct concept from source-keying — `grade_provenance()` (`mcp_server/core/provenance.py:108-192`) grades each memory `verified|verifiable|unverifiable` by extracting and checking file paths, git commit SHAs, URLs, content-addressed artifact digests, and DOI/arXiv citations against what's actually resolvable on disk/in the repo, worst-outcome-wins, with deterministic write-time hint text per grade (`write_time_hint`, `287-350`).

**Explainable recall**: the `why` MCP tool (`mcp_server/handlers/why.py:1-278`) is the standout idea — every context injection emits a `⟦rcpt:N⟧` receipt (channel, session_id, emitted_at, memory_id, rank, score, persisted at injection time), and `why(receipt_ids)` replays those into **"presence-in-context evidence"** — explicitly locked to Pearl's causal ladder rung 1 ("recorded associations only — never a causal claim about what produced an answer", `why.py:1-7,141-149`). Output fields per row: `receipt_id, channel, session_id, emitted_at, memory_id, rank, score, content, memory_missing, superseded_by_id, memory_created_at, memory_source, memory_domain, truncated, content_length`.

**Retrieval weights** (`mcp_server/core/pg_recall_weights.py:18-81`) — WRRF (weighted reciprocal-rank fusion) over 5 signals: `vector=1.0` (fixed primary), `fts=0.5, heat=0.3, ngram=0.3, recency=0.0` by default, with intent-specific overrides (e.g. `TEMPORAL → heat=0.6, recency=0.2`; `PREFERENCE → fts=0.8, heat=0.5`). Recall hit fields (`mcp_server/handlers/recall.py:60-110`): `id, content, score, heat, domain, tags, created_at, source, truncated, content_length`. Additional signals layered in (Hopfield attention, hyperdimensional-computing, successor-representation, spreading-activation — `mcp_server/core/retrieval_signals.py`) are numpy/PL-pgSQL heavy and PG-only.

**Footprint / MCP tools**: 50+ registered tools (`mcp_server/tool_registry_*.py`), core memory ones: `remember, recall, unified_search, rate_memory, validate_memory, forget, why, consolidate, checkpoint, narrative, get_causal_chain, lesson_promotion, memory_stats, get_grooming_health, get_telemetry`. Deps: `mcp, pydantic(-settings), numpy` mandatory; ONNX/FlashRank/reranker and Postgres are optional extras.

## Portable ideas

- **Exact-string `sourceKey` as the sole identity/dedupe key**, with a full pre-commit diff preview (`before`/`after` state + relation previews) — `dongtang3_mnemic/mnemic-sdk/src/types.ts:308-324`, `mnemic-server/src/memoryService.ts:102-146,923-960`. Directly implementable in a JSON store with zero new deps.
- **Per-hit recall-explanation object** (`score, lexicalScore, matchedTerms, matchedFields, fieldScores, reasons[]`) — `dongtang3_mnemic/mnemic-server/src/memoryService.ts:1876-1954`. A template for the target's "recall explanation" gap.
- **Deterministic write-time policy findings** (`policyId, severity, field, message, recommendation`), block/warn/info, regex secrets scan + `requireSourceKey` rule — `dongtang3_mnemic/mnemic-sdk/src/types.ts:53-80`.
- **Event-sourced replay/rollback** (`AgentMemoryEvent{diff}`, `replayEvents`, `rollbackPreview`) — `dongtang3_mnemic/mnemic-server/src/memoryService.ts:1383-1427,555-...`.
- **Proposal-before-trust governance table** (`pattern_key, occurrences, window, evidence[], status pending/accepted/dismissed`) with a `scan → list → accept/dismiss` CLI, min-occurrence + time-window gating — `hurttlocker_cortex/internal/store/migrations.go:1182-1216`, `cmd/cortex/propose.go:39-48`.
- **Three-policy deterministic lifecycle runner** (reinforce-promote / decay-retire / conflict-supersede) with per-run dry-run mode and per-candidate skip-reason accounting — `hurttlocker_cortex/internal/lifecycle/runner.go:75-367`, thresholds in `internal/config/resolver.go:178-192`.
- **Lexical near-dup detection** (token-Jaccard + normalized Levenshtein on normalized subject/predicate/object, threshold 0.90) — needs no embeddings — `hurttlocker_cortex/internal/store/facts_dedup.go:22-251`.
- **Injection-receipt "why" tool**: log every context injection (channel, rank, score, memory_id, timestamp) and let a `why` tool replay it as presence-evidence, explicitly not a causal claim — `cdeust_Cortex/mcp_server/handlers/why.py`.
- **`useful_count/access_count` metamemory confidence** from explicit `rate_memory(memory_id, useful)` feedback, gated by a minimum access count — `cdeust_Cortex/mcp_server/handlers/rate_memory.py`, `mcp_server/core/thermodynamics.py:297-304`.
- **Exponential heat/confidence decay with importance/confidence/value retention multipliers** — `cdeust_Cortex/mcp_server/core/thermodynamics.py:225-268`, `decay_cycle.py:54-79`.
- **Reference-based provenance grading** (verified/verifiable/unverifiable from extractable file/commit/URL/citation refs, checked against disk) — `cdeust_Cortex/mcp_server/core/provenance.py:108-192`.

## Not applicable / too heavy

- ONNX embeddings, Hopfield-network attention, hyperdimensional computing, successor-representation graphs, spreading activation, PL/pgSQL stored procedures, FlashRank cross-encoder + Platt calibration — all in `cdeust_Cortex/mcp_server/core/{retrieval_signals,pg_recall_*}.py`. Requires numpy/ONNX/Postgres; wildly disproportionate to a JSON-file store.
- The two independent "dopaminergic forgetting circuits" (leaky-integrator pressure accumulator, stage-vulnerability tables, cortical-availability gating) — `cdeust_Cortex/mcp_server/core/active_forgetting.py`. Neuroscience-metaphor complexity with ~6 tunable constants for what a single inactivity threshold achieves in `hurttlocker_cortex`.
- Full reconsolidation/plasticity/extinction machinery (labile-on-retrieval mismatch scoring, spontaneous recovery, emotional-valence modulation) — `cdeust_Cortex/mcp_server/core/reconsolidation.py`. Elegant but multi-file and stateful in ways a flat JSON store can't cheaply support.
- Go's local ONNX runtime + tokenizer + RRF/hybrid multi-mode search stack — `hurttlocker_cortex/internal/embed/`, `cmd/cortex/recall_context.go`. Real dependency and binary-size cost for a Node.js target; the *lifecycle policy shape* is portable, the embedding stack is not.
- SQLite-normalized multi-table schemas (both MNEMIC's SQLite backend and Cortex's `facts`/`fact_accesses_v1`/`fact_cooccurrence_v1`) assume a relational engine; a JSON-file store needs the equivalent invariants (indices, FKs) reimplemented as validation code, not schema constraints.

## Synthesized memory-record metadata schema (JSON-file store)

```
MemoryRecord {
  id: string                    // stable UID, e.g. "mem_<ulid>"
  title: string
  content: string
  memoryType: string            // e.g. "instinct" | "decision" | "handoff" | "note"
  project: string
  tags: string[]

  // provenance / source-keying
  sourceType: string             // e.g. "commit" | "session" | "ticket" | "manual"
  sourceId: string                // the natural id within sourceType (commit SHA, session id)
  sourceVersion: string           // optional: file hash / event seq, for change detection
  sourceKey: string                // derived: `${sourceType}:${sourceId}` — the dedupe/identity key
  actor: string                    // who/what asserted this

  // temporal
  observedAt: string (ISO)
  validFrom: string (ISO) | ""
  validTo: string (ISO) | ""
  createdAt: string (ISO)
  updatedAt: string (ISO)

  // lifecycle / confidence
  state: "active" | "core" | "retired" | "superseded"
  supersededBy: string | null
  importance: number    // 0-1
  confidence: number    // 0-1
  accessCount: number
  usefulCount: number
  lastAccessedAt: string (ISO)

  // relations & metadata
  relatedMemoryUids: string[]
  metadata: Record<string, JsonValue>
  policyFindings: PolicyFinding[]?  // only present when non-empty
}

MemoryEvent {                 // append-only log entry
  eventUid: string
  eventType: "memory-created" | "memory-updated" | "memory-superseded" | "memory-linked" | "memory-rolled-back" | "memory-state-changed"
  eventAt: string (ISO)
  memoryUid: string
  actor: string
  diff: { before: object|null, after: object|null, changedFields: string[] }
  reason: string?               // for lifecycle-policy-driven events
}
```

Rationale: `sourceType`/`sourceId`/`sourceVersion` gives the precise provenance triple the task asks for while `sourceKey` (derived, exact-match) reuses MNEMIC's proven dedupe mechanism unchanged. `state`/`supersededBy` and `accessCount`/`usefulCount` come from `hurttlocker_cortex` and `cdeust_Cortex` respectively and are cheap to maintain in a JSON file (just counters and an enum).

## Decay/consolidation proposal (no LLM needed)

**Decay** — reuse `hurttlocker_cortex`'s discrete, auditable model over `cdeust_Cortex`'s continuous exponential one, because a JSON file re-read on every write makes a nightly/on-demand batch job trivial and a per-hour recompute unnecessary:

- **reinforce-promote**: `state: active → core` when `accessCount >= 5` AND at least `3` distinct `sourceKey`s corroborate the same `(subject-ish title/tags)` — mirrors `MinReinforcements=5, MinSources=3` from `hurttlocker_cortex/internal/config/resolver.go:178-181`.
- **decay-retire**: `state: active|core → retired` when `daysSinceLastAccess(lastAccessedAt) >= 45` AND `confidence < 0.35` — same constants as `resolver.go:184-187`. Retired records stay on disk (never physically deleted) and are excluded from default recall but included in `--include-retired`/audit views.
- **confidence update on explicit feedback**: `confidence = usefulCount / accessCount` once `accessCount > 3`, else leave the write-time value untouched — `cdeust_Cortex/mcp_server/core/thermodynamics.py:297-304`. Exposed via a `rate_memory(id, useful)` tool.
- **optional light continuous decay** (only if a smoother signal is wanted alongside the state machine): `confidence' = confidence * 0.98^(hoursSinceLastAccess)`, floored at `0.05`, applied lazily at read time (never rewrite-on-read) and materialized only during the batch job below — same formula/constants as `cdeust_Cortex/mcp_server/core/decay_cycle.py:58-77`, but computed in Node with `Date` math, no numpy/Postgres needed.

**Conflict/supersede**: when two active records share a normalized identity key (same `memoryType` + fuzzy-matched subject) and disagree, pick the winner by: (1) more-specific content wins if one's key text is a substring of the other's, else (2) higher `confidence` wins if `|Δconfidence| >= 0.02` and the winner is strictly newer, else (3) leave both and flag a `conflict` audit finding for a human — verbatim algorithm from `hurttlocker_cortex/internal/lifecycle/runner.go:326-367`.

**Near-duplicate detection**: token-Jaccard + normalized Levenshtein over a normalized `(memoryType, title)` key and content string, threshold `0.90`, no embeddings required — `hurttlocker_cortex/internal/store/facts_dedup.go`.

**Schedule**: run as a `consolidate` CLI/MCP command (idempotent, dry-run by default like `hurttlocker_cortex/cmd/cortex/propose.go`'s `--dry-run`), invoked (a) manually, (b) via a git pre-commit/session-end hook, or (c) a daily cron — never inline on the write hot path, matching `cdeust_Cortex`'s "run this on a daily/weekly cadence" guidance (`mcp_server/handlers/consolidate.py:47-49`) while keeping the whole thing dependency-free.

## Attribution needs

All three repos are MIT-licensed: `dongtang3_mnemic` ("Mnemic contributors", 2026), `hurttlocker_cortex` ("LavonTMCQ", 2026), `cdeust_Cortex`/hypermnesia-mcp ("Clément Deust", 2025). MIT requires only that the copyright notice and permission notice be retained in copies/substantial portions of *their* code. Since the proposal above **reimplements algorithms and formulas from their documentation/source rather than copying code**, no license inheritance is triggered for Memory vNext itself; however, if any file is adapted more directly (e.g. porting `pickConflictWinner`'s exact branch structure, or `compute_decay`'s formula near-verbatim), keep a short code comment crediting the source repo/file (as this report's citations do) as good practice, and do not bundle any of their MIT license text into files that contain no derived code.
