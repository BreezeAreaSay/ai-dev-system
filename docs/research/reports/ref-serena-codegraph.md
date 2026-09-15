# Reference report: Serena and CodeGraph, for a Node.js Code Intelligence layer

Scope: implementation-level facts pulled from two shallow clones under
`/tmp/claude-0/-home-user-ai-dev-system/85ecbe33-9345-5ef2-a1c0-159d0c714780/scratchpad/ref/` —
`oraios_serena` (Python, LSP-orchestrating MCP agent) and `sina-parsania_CodeGraph`
(Rust, tree-sitter + SQLite code-graph MCP server). All facts below cite `file:line`
in those clones.

---

## Part 1 — Serena (`oraios_serena`)

### License
Split licensing (`LICENSE:1-4`): **SolidLSP is MIT** (`src/solidlsp/**`),
**the Serena application is GPL-3.0-or-later** (`src/serena/**`), each file
carrying its own SPDX header (e.g. `symbol_tools.py:4` vs `settings.py:4`).
Package: `serena-agent` 1.7.1.dev0 (`pyproject.toml:6-7`).

### Tool inventory (I/O contracts)

All tools subclass `Tool` in `src/serena/tools/tools_base.py`; `apply()` is the
tool body, `_limit_length()` (below) trims output. Symbolic tools live in
`src/serena/tools/symbol_tools.py`:

- **`get_symbols_overview`** (`symbol_tools.py:37-132`): top-level symbols of a
  file (`relative_path` must be a file, raises on directory). `depth` default
  `-1` → resolved to `1` for `.java`/`.kt`, else `0` (`:60-64`). Grouped by kind.

- **`find_symbol`** (`:135-250`), param `name_path_pattern`. **Name-path
  rules** (`:163-173`): path within a file's symbol tree, e.g. class
  `MyClass` method `my_method` → `MyClass/my_method`. Plain name matches any
  symbol with that name; `class/method` matches by name-path **suffix**;
  `/class/method` (leading `/`) requires **exact** full-path match. Overload
  index `[i]` disambiguates, e.g. `MyClass/my_method[1]`.
  `substring_matching=True` applies only to the **last** path element (`Foo/get`
  matches `Foo/getValue`). `depth` (default 0) is **ignored when
  `include_body=True`** (`:197-198`, forced to 0). `include_info` adds
  hover-like docstring/signature (skipped for children). `include_kinds`/
  `exclude_kinds` are raw LSP `SymbolKind` ints. `max_matches` (`-1`=unlimited)
  returns a shortened relative-path→name-path list instead of raising
  (`:212-219`).

- **`find_referencing_symbols`** (`:253-340`): requires `name_path` **and**
  `relative_path` of the defining file. Each hit includes 1-line-before/after
  code context (`retrieve_content_around_line`, `:304-307`), grouped by
  `["relative_path","kind"]`. Referencing-symbol bodies are never included
  (`:284`).

- **`find_implementations`**, **`find_declaration`** (regex-anchored lookup of
  a symbol at a matched code location, `:400-466`), diagnostics tools
  (`GetDiagnosticsForFileTool`/`GetDiagnosticsForSymbolTool`, LSP severities
  1=Error…4=Hint, grouped `path→severity→name_path`).

- **Edit tools** (require a prior `include_body=True` read):
  `replace_symbol_body(name_path, relative_path, body)` (`:586-616`),
  `insert_after_symbol`/`insert_before_symbol` (`:619-668`, positional, not
  text search), `rename_symbol` (LSP rename-refactor, `:671-696`),
  `safe_delete_symbol` (`:699-739`: refuses and returns reference locations if
  the symbol is referenced anywhere).

- **`search_for_pattern`** (`src/serena/tools/file_tools.py:544-664`): regex
  over project files (`MULTILINE|DOTALL` when `multiline=True`, default true).
  Params: `context_lines_before/after`, `paths_include_glob`/
  `paths_exclude_glob` (exclude wins), `relative_path` scope,
  `restrict_search_to_code_files`, `skip_ignored_files=True` default. Returns
  `{file: [matched-line-blocks]}`.

- **Memory tools** (`src/serena/tools/memory_tools.py`): `write_memory`,
  `read_memory`, `list_memories`, `delete_memory`, `rename_memory` (updates
  `mem:`-prefixed cross-refs), `edit_memory` (literal/regex replace). Storage:
  `MemoryManager` (`src/serena/memories/memory_manager.py:44-46`) writes to
  **`.serena/memories/*.md`** per project; a `global/` prefix routes to a
  shared cross-project dir (`:29,73-74`). `write_memory` enforces `max_chars`
  (default = `default_max_tool_answer_chars`) and **raises** (does not
  truncate) if too long (`:29-35`). `OnboardingTool` (`workflow_tools.py:10-28`)
  runs at most once per conversation; it seeds a `memory_maintenance` memory
  and returns a prompt telling the agent to write onboarding memories itself
  — Serena does not auto-generate them.

- **Deprecated/removed tools**: `ToolRegistry._deleted_tools`
  (`tools_base.py:586-593`) lists `think_about_collected_information`,
  `prepare_for_new_conversation`, `summarize_changes`,
  `think_about_whether_you_are_done`, `switch_modes`,
  `check_onboarding_performed` — the `think_about_*` reflection tools from
  earlier Serena versions are retired in favor of mode prompts (below);
  calling a deleted name logs a warning rather than erroring (`:685-691`).

### `max_answer_chars` mechanism

Implemented once, in `Tool._limit_length()` (`tools_base.py:283-313`). Every
read-heavy tool calls it with the full JSON string and an optional ordered list
of `shortened_result_factories` (closures producing progressively terser
summaries — e.g. `find_symbol` falls back to `{relative_path: [name_paths]}`;
`search_for_pattern` has a 5-step ladder: full first-lines → truncated
first-lines (60 chars) → line-numbers-only → per-file counts → a one-line
summary). Behavior when exceeded (`:301-312`): if `n_chars > max_answer_chars`,
prefix a fixed "answer is too long" message, then try each shortening closure
**in order**, returning the first one whose `too_long_msg + shortened` fits;
if none fit, return only the too-long message (data dropped entirely). Default:
`SerenaConfig.default_max_tool_answer_chars = 150_000` (chars, not tokens;
`src/serena/config/serena_config.py:899`); `-1` in any tool param means "use
this config default"; `<=0` raises `ValueError`.

### SolidLSP: language-server orchestration layer (`src/solidlsp/`)

**Base API** (`ls.py`, 3288 lines) — the `SolidLanguageServer` class exposes
`request_document_symbols` (`:1937`), `request_definition` (`:1589`),
`request_implementation` (`:1648`), `request_references` (`:1711`),
`request_hover` (`:2306`), `request_completions` (`:1758`),
`request_signature_help` (`:2347`), `request_full_symbol_tree` (`:2081`),
`request_referencing_symbols` (`:2390`, backs `find_referencing_symbols`),
`request_implementing_symbols` (`:2892`), `request_workspace_symbol`
(`:3124`), `request_rename_symbol_edit` (`:3151`), pull/push diagnostics
(`:961`/`:856`), and lifecycle `start()`/`stop()` (`:3196-3225`). Default
per-request timeout `DEFAULT_LS_REQUEST_TIMEOUT = 300.0` seconds
(`ls_process.py:41`, `:453`); `None` disables it.

**Binary acquisition** (`dependency_provider.py`, 371 lines) — three patterns,
selected per language server subclass via `_create_dependency_provider()`:
1. **`LanguageServerDependencyProviderUvx`** (`:182-248`): for PyPI-distributed
   servers (e.g. Pyright — `pyright_server.py:47-54`, pinned
   `PYRIGHT_VERSION="1.1.403"`), runs the pinned package on demand via `uvx`
   (or `uv tool run` fallback); raises if neither `uvx` nor `uv` is on `PATH`
   (`:242`) — **not auto-installed**, requires `uv`.
2. **npm-based** (TypeScript — `typescript_language_server.py:25,250-306`):
   builds an `npm install <pkg>@<version>` command
   (`build_npm_install_command`, `common.py`) for pinned `typescript` (5.9.3)
   and `typescript-language-server` (5.1.3) versions into the LS's resource
   dir; asserts `npm` is on `PATH` (`:299-300`).
3. **`DownloadedDependency`/`DownloadedDependencyHashDatabase`**
   (`dependency_provider.py:252-369`): downloads a URL (typically a GitHub
   release archive), extracts it, and **verifies SHA256** against a checked-in
   hash database (`downloaded_dependency_hashes.json`,
   `scripts/update_downloaded_dependency_hashes.py` regenerates it); warns (but
   proceeds) if no known hash exists for the URL (`:360-366`).
4. **User-must-provide** (Go — `gopls.py:65-101`): shells out to `go version`
   and `gopls version`; if `gopls` is missing it raises a clear install
   instruction — Serena does **not** download Go tooling.
   **Rust** (`rust_analyzer.py:55-130`) prefers `rustup which rust-analyzer`,
   then auto-installs via `rustup component add rust-analyzer`, then falls
   back to system `PATH`, with platform-specific binary-name fallback paths
   after that (`:120-`, download logic continues beyond the excerpt).

**Download/global storage location**: `SolidLSPSettings.ls_resources_dir`
(`settings.py:54-56`) = `~/.solidlsp/language_servers/static/<LanguageServerClassName>/`
— global, not per-project — with `ls.py:428-443` migrating any pre-1.x
`solidlsp/language_servers/static/<Cls>` legacy paths into it on first use.

**Caching** (`ls.py:548-560`, `~2980-3110`): a **project-local** cache dir
`<project's .serena>/cache/<language_id>/` (`CACHE_FOLDER_NAME="cache"`,
`:351`), holding two pickled caches keyed by a version tuple that changes
whenever `(RAW_DOCUMENT_SYMBOLS_CACHE_VERSION, LS-specific version,
optional per-LS fingerprint)` changes — invalidating on LS reconfiguration.
Per-entry cache key is `relative_path → (file_content_hash, symbols)`
(`:551-552,3018`), so a file is only re-parsed by the LS if its content hash
differs; legacy-cache-format migration is handled explicitly (`:3045-3062`).

**Supported languages**: **74** `Language` enum members (grep count of
`ls_config.py`), matching the `.serena/project.yml` comment listing
(`:8-19`) and 74 files under `src/solidlsp/language_servers/` — ada through
zig, with several languages offering alternate LS backends (e.g.
`python`/`python_jedi`/`python_pyrefly`/`python_ty`,
`csharp`/`csharp_omnisharp`). First configured LS is the default/fallback
(`project.yml:37`). **Unsupported files** are an explicit error, not a silent
degrade: `symbol_tools.py:109-112` raises `ValueError` naming active
language-server ids when `can_analyze_file()` is false.

### Contexts and modes (`src/serena/resources/config/`)

**Contexts** (`contexts/*.yml`, 14 files: `agent`, `antigravity`, `chatgpt`,
`claude-code`, `codebuddy`, `codex`, `copilot-cli`, `desktop-app`, `grok`,
`ide`, `jb-ai-assistant`, `jb-copilot-plugin`, `junie`, `oaicompat-agent`,
`vscode`) select **which host** Serena runs inside and adjust the tool
surface accordingly. E.g. `claude-code.yml` (`:1-59`) sets `excluded_tools:
[create_text_file, read_file, execute_shell_command, find_file, list_dir,
search_for_pattern]` (Claude Code's own built-ins cover those),
`single_project: true` (locks the tool set to the one active project,
disabling `activate_project`), and `structured_tool_output: false`
(works around a Claude-Code-specific unpacking bug). Each context injects a
Jinja `prompt` concatenated into the system prompt.

**Modes** (`modes/*.yml`: `benchmark`, `editing`, `interactive`,
`no-memories`, `no-onboarding`, `onboarding`, `one-shot`, `planning`,
`query-projects`) are **composable, layered on top of contexts** — a
project's `.serena/project.yml` sets `base_modes`+`default_modes`+
`added_modes` (`project.yml:97-135`). `editing.yml` (`:1-33`) instructs
preferring `rename_symbol`/`safe_delete_symbol` for refactors,
`replace_symbol_body`/`insert_after_symbol`/`insert_before_symbol` for
structural edits, `replace_content`/`replace_in_files` for sub-symbol edits;
and explicitly tells the agent **not** to re-read files after a successful
symbolic edit ("these edits are reliable"). `interactive.yml` (`:1-9`) is
pure prompt guidance (no tool exclusions).

### Project activation (`.serena/project.yml`)

Schema documented inline in the file itself. Key fields: `project_name`,
`language_servers: [list]` (multiple LSs per project; first matching one per
file wins), `ignore_all_files_in_gitignore`, `ignored_paths`, `read_only`
(disables all editing tools), `excluded_tools`/`included_optional_tools`,
`initial_prompt` (Jinja, can `{{ embed_memory("name") }}`), `encoding`,
`base_modes`/`default_modes`/`added_modes`, `fixed_tools` (replaces the
default toolset entirely), `symbol_info_budget`, `language_backend` (`LSP` or
`JetBrains`, fixed at startup), `ls_specific_settings` (per-LS custom config,
only for **trusted** projects), `activation_command` (+ 180s timeout — runs
before the LS starts, e.g. `npx nx run-many -t build`; non-zero exit logged,
not fatal), `ls_workspace_folders` (default `["."]`; monorepo subfolder
scoping), `ls_additional_workspace_folders` (cross-package references
without indexing).

### Dependencies / footprint

`pyproject.toml:20-51`: `mcp==1.28.1` (MCP SDK), `flask==3.1.3` (dashboard web
UI, `dashboard.py`), `pygls`+`lsprotocol` (own LSP client bits), `jinja2`
(prompt templating), `tiktoken`, `anthropic==0.117.0`, `pywebview`/`pystray`
(native GUI dashboard/tray icon), `psutil`, `docstring_parser`, `joblib`,
`sensai-utils`. Requires Python `>=3.11,<3.15`. No vector DB, no embeddings,
no local ML — purely an LSP proxy plus filesystem/prompt tooling.

### What is NOT in Serena

No ranking (results are LSP-order, not scored/PageRank'd), no token-budget
allocator beyond the flat `max_answer_chars` truncation ladder (no
per-conversation budget tracking), no persistent dependency/call graph data
structure — every `find_referencing_symbols`/`find_symbol` call re-queries
the live language server (only the raw/document-symbol **per-file** results
are cached, not a repo-wide graph), no cross-repo semantic search, no
git-history/co-change analysis, no "impact"/"blast radius" tool (closest is
`find_referencing_symbols` used transitively by the agent, one hop at a time,
manually), no confidence/coverage scoring on results (an LSP answer is either
returned as-is or the LS errors) — trust is entirely delegated to whichever
underlying LSP implementation is running.

---

## Part 2 — CodeGraph (`sina-parsania_CodeGraph`)

### License
Dual **MIT OR Apache-2.0** (`LICENSE-APACHE`, `LICENSE-MIT`, `Cargo.toml:8`).
Rust workspace (`crates/*`), version `1.39.0` (`Cargo.toml:5`). Single
self-contained binary, `cargo install --path crates/codegraph-cli`.

### Language/runtime, parser
Rust + Tokio async runtime (`rmcp` MCP SDK v1.8 over stdio transport,
`codegraph-mcp/Cargo.toml`, `serve_stdio` at `codegraph-mcp/src/lib.rs:1409`).
Parsing is **tree-sitter** (`codegraph-parse/Cargo.toml:10-23`): 13 languages
— Rust, Python, JS/TS(X), Go, Java, C, C++, C#, Ruby, Swift, Kotlin
(`tree-sitter-kotlin-ng`), Bash. `codegraph-parse/src/lib.rs` is 3321 lines
(single file per crate for most crates — parse/store/graph/cli are the large
ones: 3321/2927/2325/2360/1789 lines respectively).

### How calls/imports are RESOLVED

Core algorithm: `crates/codegraph-graph/src/lib.rs`, header (`:1-3`): "M3
lands structural (DEFINES) + intra-file CALLS resolution (Tier-B,
**same-language only**)." A **strict, ordered, unique-or-drop chain** — every
tier finds exactly one candidate or drops the call, never guesses
(`resolve_member:13-15`, "DROP — never guess"):

1. **Receiver-typed** (`resolve_receiver`, invoked first in
   `resolve_call:668`) — CHA member lookup via `resolve_member` (`:16-45`):
   walks the class' ancestor chain (BFS), returns `Some` only if exactly one
   method named `name` exists at the nearest level; field-type and
   local-var-type receivers (DI patterns, `new Foo()`, generic/`| null`
   unwrap) are typed similarly.
2. For untyped/**bare** calls, `resolve_bare` (`:608-656`) tries in order:
   local-binding shadow check first (`:613-620`, a local var/param of that
   name refuses resolution entirely) → **`SameFileUnique`** (`:621-624`) →
   **`ImportNarrowed`** (`resolve_via_import:121-176`, `:625-635`: the
   caller's own import is resolved to a concrete file — TS/JS relative-module
   → sibling file trying `.ts/.tsx/.js/.jsx/.mjs/index.*`, tsconfig `paths`
   aliases pre-expanded; Python dotted module → `a/b/c.py` suffix match;
   conflicting imports of the same name → drop) → **`PackageScope`** (Go
   only, same-directory unique fn, `:636-651`) → **`GlobalUnique`** (exactly
   one fn of that name repo-wide, `:652-655`, weakest/last-resort tier).
3. **Cross-boundary gating** (`resolve_call:677-696`): a resolved candidate is
   still discarded if it targets the caller itself, or — unless the tier was
   `ImportNarrowed` — if it's in a different `language` or top-level path
   segment (`top_segment`, `:47-58`; monorepo package-boundary heuristic),
   preventing phantom cross-service/cross-language edges from same-name
   collisions. `narrow_class_by_import` (`:67-115`) applies the same
   ImportNarrowed logic to disambiguate a **type name** (the fix for "0/23
   NestJS DI call sites" the comment cites).
4. **Compiler-grade override (optional, Tier-A)**: `codegraph-resolve/src/lib.rs`
   (`import_scip`, `:19-91`) ingests a `.scip` index and emits edges tagged
   `ResolutionTier::Scip`/`Confidence::Extracted` by mapping SCIP symbol-role
   occurrences onto parsed nodes by `(file, line span)`; these supersede
   tree-sitter edges for the same call site (`extend_superseding`,
   `codegraph-cli/src/index.rs:1324`). `--features indexstore` reads Xcode's
   IndexStore for Swift (README: "+171% resolved calls on a real iOS app").

Every resolved `Edge` carries `metadata.justification` so `codegraph audit`
can measure per-tier precision (README: **98.7%** on zod TS oracle —
ImportNarrowed 62/62=100% — **93.8%** fastapi, **95.0%** on a 55k-node
private IndexStore-oracle monorepo; "lower bounds, seeded sampling"). Full
spec: `docs/RESOLUTION.md` (not read here).

### Node/edge schema (`codegraph-core/src/types.rs`)

`NodeLabel` enum (`:14-34`, 18 variants): `Project, Package, Folder, File,
Module, Class, Function, Method, Interface, Enum, Type, Route, Resource,
Document, Image, Figure, Topic, Concept` (`Concept` is LLM-only, never
emitted on `--no-llm`). `Node` struct (`:94-111`): `id, label, name,
file_path, line_start, line_end, language, metadata: BTreeMap<String,Value>,
community: Option<u32>` (Louvain id), `pagerank: f64`, `betweenness: f64`.
`EdgeRelation` enum (`:36-67`, 27 variants): `Calls, AsyncCalls, UsesType,
Implements, Inherits, Defines, MemberOf, Contains(File/Folder/Package),
Override, HttpCalls, Emits, ListensOn, PublishesTo, SubscribesTo, Configures,
Tests, FileChangesWith, Similar, SemanticallySimilar, DataFlows,
ConceptuallyRelated, RationaleFor`, +4 hyperedge-only relations. `Edge`
struct (`:113-124`): `src, dst, relation, tier: ResolutionTier
{Scip,TreeSitter,Llm,Ingest}, confidence: Confidence {Extracted, Inferred,
Ambiguous}, src_file, src_line, metadata`. `Hyperedge`/`HyperedgeMember`
(`:126-140`) model n-ary relations (e.g. a pub/sub flow spanning >2 nodes)
via `HyperedgeRelation {ParticipateIn, Implement, Form, MemberOfFlow}`.
`NodeId` newtype (`:391-411`) validates non-empty, whitespace-free ids for
type-safe semantic ops vs display-name lookups.

### Uncertainty / coverage / confidence — exact field names

This is the standout design element. Three **independent** dimensions
(`types.rs:460-513`, comment: "every dimension INDEPENDENT: `freshness =
Stale` + `evidence = LowerBound` is representable"):

- **`GraphFreshness`** (`:463-472`, tagged enum `{kind,...}`): `Fresh`,
  `Stale { reason: String }`, `Unknown { reason: String }` — does the graph
  agree with the working tree right now.
- **`EvidenceQuality`** (`:477-491`): `Exact`, `LowerBound { reason: String }`,
  `Approximate { method: String, sample_size: Option<usize> }`,
  `Unavailable { reason: String }` — how trustworthy the *computation* is,
  independent of freshness.
- **`AnswerMetadata`** (`:497-504`): `{ generation: Option<GraphGeneration>,
  freshness: GraphFreshness, evidence: EvidenceQuality, coverage:
  Option<Coverage> }` — the envelope wrapping every analytical answer
  (`GraphAnswer<T> { data: T, meta: AnswerMetadata }`, `:509-513`).
- **`Coverage`** (`:281-292`, doc comment: "Derived from REAL counters: raw
  call sites in the `calls` table vs resolved `Calls` edges"): `{ resolved:
  usize, total_call_sites: usize, dropped: usize, may_be_incomplete: bool,
  note: String }`. Constructors `Coverage::callers(name, resolved, total)`
  and `Coverage::callees(resolved, total)` (`:294-337`) compute `dropped =
  total - resolved`, set `may_be_incomplete = dropped > 0`, and generate a
  human-readable `note` that explicitly tells the agent to fall back to text
  search when incomplete (e.g. `"…this callers list may be INCOMPLETE —
  fall back to text search for '{name}(' to be sure."`).
- **`TestEvidence`** (`:518-523`): `Resolved | TextualOnly | None` — same
  evidence-separation pattern applied to test-coverage-of-symbol facts.

Every list-shaped MCP answer (`callers`, `callees`, `blast_radius`) embeds a
`coverage` object; `stats`/`architecture` embed measured-precision numbers
from `codegraph audit`; `dead_code_v2` returns per-symbol typed assessments
(`candidate / indirectly_referenced / unknown / excluded`) plus `generation +
freshness + evidence` (`codegraph-mcp/src/lib.rs:1022-1024`) rather than a
flat "dead" boolean.

### SQLite schema (`codegraph-store/src/lib.rs:257-321`)

Single SQLite DB via `rusqlite` (bundled) + `sqlite-vec` extension (`:43`).
Core tables: `schema_version`, `nodes` (id PK, name, parts, doc_text, label,
language, file_path, line_start/end, community, pagerank, betweenness,
`data`=full JSON blob), `edges` (PK `(src,dst,relation)`, tier, confidence,
src_file/line, `data` JSON), `hyperedges`/`hyperedge_members`, **`manifest`**
(`file_path` PK, `sha256`, `mtime` — incremental-index fingerprint),
`adrs`/`traces`/`results`/`contexts`, **`calls`** (`caller_id, callee_name,
line, file_path, receiver, enclosing_class, leaf_name` — the *raw*
pre-resolution call-site table `Coverage` diffs against), `symbol_refs`,
`inherits`, `fields`, `imports`, `locals`, `type_refs`, `meta` (k/v),
`cochanges` (`file_a, file_b, n` — git co-change counts). FTS5 virtual table
`nodes_fts` (`:56`); vector table `vec_nodes USING vec0(node_id TEXT PRIMARY
KEY, embedding FLOAT[{dim}])` (`:468`) — `sqlite-vec` has no upsert, so
writes are delete-then-insert by primary key (`:1515,1713`).

### Incremental update

`codegraph-cli/src/index.rs`, header (`:1-2`): "walk → sha256 → (re)parse
changed → persist". Two-phase staleness check (`:657-708`): **Phase 1
stat-first** — skip a file with unchanged `mtime` vs its `manifest` row
without reading it; **Phase 2** for mtime-changed files, compute `sha256`
and compare — if equal, "touched but identical," only `mtime` refreshed, no
reparse (`:706-708`). New/deleted files diffed by set membership against the
full manifest (`:481,504-531`; deletions via `store.delete_manifest`,
`:819-828`). README: **O(impact) not O(repo)** — an edit re-resolves only
files whose call sites name a changed definition (wave-propagation), proven
byte-identical to a from-scratch index by a dedicated test.
`tsconfig.json`/`.scip` changes also force staleness (`is_stale`,
`scip_file_changed`, `:1374-1409`). Determinism: same commit →
byte-identical graph (canonical `BTreeMap` JSON serialization,
`types.rs:5-8`).

### MCP tools (`crates/codegraph-mcp/src/lib.rs`, `#[tool_router]` at `:214`)

All return `CallToolResult` (JSON content). Full list with I/O and bounding:

| Tool | Args struct | Bounding / notes |
|---|---|---|
| `search` | `SearchArgs{query, limit?, regex?, rerank?}` | lexical/FTS5, `limit` default 20 |
| `get_node` | `IdArgs{id, snippet?}` | `snippet=true` reads disk, capped to `min(line_end, line_start+400)` lines (`:451`) — never a whole-file dump |
| `callers` | `NameArgs{name, id?}` | pin via `id` to disambiguate; ambiguous names (>1 definition) return **pinnable candidates**, not a merged list (`:481-516`); embeds `coverage`, `unresolved_call_site_files` (textual-only evidence), `type_usages` (DI/type-annotation evidence for classes/interfaces) |
| `callees` | `NameArgs` | resolved callees + `unresolved_calls` (dropped-but-plausible names, truncated to 30, `:736`) + `coverage` |
| `semantic_search` | `SearchArgs` | vector search over code **and** docs; degrades to lexical (`search_smart`) with an explicit `"degraded"` field if no embedder reachable (`:639-651`) — never a silent failure |
| `trace_path` | `TwoNamesArgs{from,to}` | shortest path in the in-memory call graph (`:663-671`) |
| `blast_radius` | `NameArgs` | transitive dependents, **hop-capped at 5** (`g.lg.blast_radius(&n.id, 5)`, `:681`), rows capped to **200** with `total_affected` real count + `_note` on truncation (`:693-712`); `coverage` included |
| `context` | `ContextArgs{query, budget?}` | **personalized PageRank** seeded from FTS hits (`:789-796`), **token-budgeted** (default 1000, cost estimated as `(name+file+snippet).len()/4 + 4` per row, `:819-823`) — closest analog to a "ranking + token budget" system in either codebase |
| `important` | `LimitArgs{limit?}` | global PageRank top-N, "utility-sink damped" |
| `architecture` | (none) | node/edge counts by label+language, community summaries, route count — orientation map |
| `stats` | (none) | node count + `embedder_available` + `measured_precision` (from `codegraph audit`, staleness-checked against current index `generation`, `:980-997`) |
| `dead_code` / `dead_code_v2` | `LimitArgs` | v1 = flat `{name,kind,file,line}[]`; v2 = typed `candidate/indirectly_referenced/unknown/excluded` + `AnswerMetadata` |
| `co_changes` | `FileArgs{file, limit?}` | git co-change table lookup |
| `changes` | `ChangesArgs{base?}` | diff-based impact (base defaults to HEAD = uncommitted) |
| `graph_query` | `CypherArgs{query}` | "Cypher-lite": 1-2 hop MATCH, WHERE `=`/`CONTAINS`/`STARTS WITH`/`AND`, RETURN, LIMIT (`codegraph-store/src/cypher.rs`) |
| `flows` | `LimitArgs` | hyperedge-based flows (pub/sub, emits/listens chains) |
| `implementers` | `NameArgs` | types implementing/extending an interface/class |
| `routes` | `RoutesArgs{limit?,offset?,path_prefix?,method?}` | HTTP route inventory (NestJS/Express/Flask/Spring/etc.), paginated, default `limit=100` explicitly to stay "under client tool-result ceilings" (`:191-192`) |

List responses use a deliberately **lean row** (`fn lean(n) ->
{name,kind,file,line}`, `:206-212`) after a full-node `routes` response
measured 232KB and was rejected by an MCP client — full detail only behind
`get_node(id)`. A **freshness gate** (`maybe_refresh`, `:242-292`) runs
before almost every tool: debounced to once/second, re-walks+re-resolves the
repo, and **fails the whole call** (`FRESHNESS FAILURE`) rather than
silently serving stale data, unless `CODEGRAPH_ALLOW_STALE=1`, in which case
it serves the last snapshot but stamps `GraphFreshness::Stale{reason}`. A
`GraphCache` memoizes the built petgraph per `(index generation, db mtime)`
so a burst of calls in one agent turn builds it once (`:580-619`).

### Performance notes (from source comments + README)

Query latency **~13ms** measured, cold index **1.5s**, binary **~39MB** lean/
**~55MB** with bundled embedder (README). Graph-algorithm tools (`important`,
`context`, `blast_radius`, `trace_path`) run on an **in-memory petgraph
snapshot** (`GraphSnapshot`, cached per index generation) rather than
re-querying SQLite per call. `rayon` is a core workspace dep
(`Cargo.toml:32`, alongside `walkdir`/`ignore`) for parallel file
walk/parsing. README claims 20-100x fewer agent tokens per code question vs
grep (86x Rust, 21x Python, 29x Go, 100x TypeScript,
`scripts/benchmark.py`), and an exported/shared graph snapshot is 88%
smaller than the live DB.

---

## (a) Portable ideas (tagged with source)

- **Unique-or-drop, tiered, justified resolution** — never guess an edge; tag
  each with which heuristic produced it (`codegraph-graph/src/lib.rs:608-656,
  662-701`). Portable to a Node LSP-adapter: when multiple `definition`/
  `workspace/symbol` hits tie, return **candidates to pin**, not a
  merged/guessed answer (mirrors CodeGraph's `callers` candidates,
  `codegraph-mcp/src/lib.rs:481-516`, and Serena's `[i]` overload index,
  `symbol_tools.py:165-166`).
- **Coverage/evidence-quality/freshness as three independent, typed fields on
  every answer**, not a single confidence float (`codegraph-core/src/types.rs:
  460-513`) — the single most reusable design primitive here for a "trust me
  or don't" layer around imperfect static analysis.
- **Lean list rows + `get_node`-style drill-down** to control payload size
  (`codegraph-mcp/src/lib.rs:206-212`, measured 232KB regression avoided):
  keep list results to `{name, file, line}`, require a second call for
  full detail/snippet.
- **Progressive-shortening ladder for over-budget tool results** (Serena
  `Tool._limit_length`, `tools_base.py:283-313`; ordered
  `shortened_result_factories`, cheapest-info-loss first) — simpler and more
  general than CodeGraph's per-tool ad hoc caps; worth adopting verbatim as
  the `max_answer_chars` truncation strategy.
- **Hash+mtime two-phase incremental staleness check** (`codegraph-cli/src/
  index.rs:657-708`: stat-first, sha256 fallback) and Serena's **per-file
  content-hash cache keyed by a versioned cache-format tuple**
  (`solidlsp/ls.py:548-560, ~2980-3060`) — both portable to a file-watch +
  incremental-reindex Node service.
- **Freshness gate that fails loudly rather than silently serving stale
  data**, with an explicit opt-out env var (`codegraph-mcp/src/lib.rs:236-292`).
- **Name-path syntax with suffix/exact/substring modes + `[i]` overload
  index** (Serena `find_symbol`, `symbol_tools.py:163-173`) — a clean,
  LSP-agnostic symbol-addressing scheme worth reusing verbatim.
- **Contexts (host adapter) vs Modes (behavior layer) as orthogonal, YAML
  composable configs** (`resources/config/contexts/*.yml`, `modes/*.yml`) —
  useful if the Node server runs under multiple hosts with different
  built-in tool overlaps.
- **`.serena/project.yml` as a single human-editable, heavily-commented
  per-project config** — good UX template for the target system.

## (b) Not applicable / too heavy

CodeGraph's JetBrains/IndexStore/Xcode-specific tiers, Louvain community
detection, betweenness centrality, and hyperedge/flow modeling (pub-sub, HTTP
routes) are large scope additions unneeded for a first layer focused on
symbols/definitions/references/callers. Serena's GUI dashboard (Flask +
pywebview + pystray, `dashboard.py`), JetBrains plugin bridge, and
74-language LSP zoo are far beyond bootstrap scope — a handful of LSPs (TS,
Python, Go, Rust) covers the realistic v1. CodeGraph's own bespoke
tree-sitter parser + SQLite graph store + petgraph is a from-scratch
reimplementation of what an LSP already gives for free
(`documentSymbol`/`references`/`definition`/`callHierarchy`) for languages
with good LSP support — redundant to build alongside an LSP adapter;
CodeGraph's approach makes sense specifically for languages/repos where
spinning up N language servers is undesirable, a different tradeoff than
"wrap existing LSPs." The Cypher-lite query language and SCIP-import merge
tier are power-user/compiler-grade escape hatches — skip for v1. Serena's
memory system (`.serena/memories/*.md`, onboarding workflow) and JetBrains
backend are agent-workflow features orthogonal to code intelligence per se.

## (c) Minimal Node.js LSP-adapter needs

Protocol subset (mirroring SolidLSP's `request_*` surface,
`solidlsp/ls.py:1589-3151`): `initialize`/`initialized` (workspace folders,
cf. `ls_workspace_folders`/`ls_additional_workspace_folders`,
`project.yml:151-171`); `textDocument/didOpen`/`didChange`/`didClose` (buffer
sync, cf. `LSPFileBuffer`, `ls.py:531`); `textDocument/documentSymbol` →
overview/find_symbol; `textDocument/definition` → go-to-def;
`textDocument/references` → find_referencing_symbols;
`textDocument/implementation`; `textDocument/prepareCallHierarchy` +
`callHierarchy/incomingCalls`/`outgoingCalls` → callers/callees (an LSP gives
this natively, with its own confidence — no need to reimplement CodeGraph's
tree-sitter resolution heuristics); `workspace/symbol` → global search.
Optional: `hover` (info), `rename`, `publishDiagnostics`/pull `diagnostic`.

**Binary acquisition without bundling** (mirrors SolidLSP's per-language
strategy, `dependency_provider.py`): `typescript-language-server` + `pyright`
both ship npm packages with a langserver bin — `npm install --no-save` into a
cache dir at first use (same pattern as
`typescript_language_server.py:250-306`; npm is more natural for a Node host
than Serena's PyPI/`uvx pyright` route). `gopls` cannot be npm-installed —
require Go and shell out to `go install golang.org/x/tools/gopls@latest`
(mirrors Serena requiring `go`/`gopls` pre-installed, `gopls.py:65-101`; no
official prebuilt gopls release exists). `rust-analyzer` has prebuilt
per-platform binaries at `github.com/rust-lang/rust-analyzer/releases` —
download directly, or prefer `rustup component add rust-analyzer` when
`rustup` exists (mirrors `rust_analyzer.py:88-130`). Reusable pattern:
Serena's generic `DownloadedDependency` + SHA256-hash-verification
(`dependency_provider.py:252-369`) — download once into a **global** cache
dir keyed by LS name (`~/.solidlsp/language_servers/static/<Name>/`,
`settings.py:54-56`, shared across projects), verify against a checked-in
hash, skip on cache hit; pair with a **project-local** symbol cache keyed by
file content hash (`.serena/cache/<language_id>/`) to avoid re-parsing
unchanged files across restarts.

## (d) Attribution needs

**Serena**: dual-licensed — `src/serena/**` (agent orchestration, tools,
prompts, contexts/modes YAML) is **GPL-3.0-or-later**; copying it into a
differently-licensed project requires GPL compliance. `src/solidlsp/**` (the
LSP client layer) is **MIT**, freely reusable with attribution. Copyright:
Oraios AI (`info@oraios-ai.de`, `pyproject.toml:9`). For "portable ideas,"
re-implementing the architecture (name-path syntax, cache strategy,
contexts/modes split) from scratch avoids GPL entanglement; SolidLSP's MIT
code could be ported more directly. **CodeGraph**: MIT OR Apache-2.0 —
permissive; a standard MIT/Apache notice suffices, no copyleft obligations.
