# Reference notes: Aider repo-map & Repomix, for a "Context Engine vNext" MCP server

Repos read (shallow clones): `Aider-AI_aider` (Python, Apache-2.0) and `yamadashy_repomix` (TypeScript/Node, MIT).

## PART 1 — AIDER (`aider/repomap.py`)

### License
Apache License 2.0 (`Aider-AI_aider/LICENSE.txt:1-4`). Permissive; a from-scratch reimplementation needs no attribution, but literal copying of `.scm` query files or code needs the notice preserved.

### Tag extraction
- `RepoMap.get_tags` (`repomap.py:233-264`) is the cache-aware entry point; `get_tags_raw` (`repomap.py:279-363`) does the work.
- Primary path: tree-sitter. `filename_to_lang`/`get_language`/`get_parser` (grep_ast) load a grammar; `get_scm_fname(lang)` (`repomap.py:805-829`) resolves `<lang>-tags.scm`, preferring `aider/queries/tree-sitter-language-pack/` and falling back to `tree-sitter-languages/`. `python-tags.scm` (full file) captures `@name.definition.class`, `@name.definition.function`, `@name.definition.constant`, and `@name.reference.call` — **definitions and call-reference sites only**, not every identifier.
- Captures run via `Query` + `QueryCursor` (new API) or `.captures()` (old API), version-shimmed (`repomap.py:266-277`). Each capture becomes `Tag(rel_fname, fname, name, kind, line)` (`repomap.py:29`); `kind` = `"def"`/`"ref"` from the `name.definition.*`/`name.reference.*` capture-name prefix (`repomap.py:318-336`).
- **Pygments fallback**: if a language produced defs but zero refs (e.g. C/C++ tag files lack `@reference`), Aider re-lexes with `pygments.lexers.guess_lexer_for_filename` and yields every `Token.Name` as a synthetic `ref` tag with `line=-1` (`repomap.py:317-363`) — a blunt token-level backstop, not a real reference index.

### Tags cache
- `diskcache.Cache` at `<root>/.aider.tags.cache.v{N}` (`repomap.py:43`), `CACHE_VERSION=3`, bumped to 4 for the tree-sitter-language-pack (`repomap.py:35-37`) — a format change invalidates the whole cache.
- Keyed by absolute filename → `{"mtime": ..., "data": [Tag,...]}` (`repomap.py:246-264`); a stale `os.path.getmtime` triggers re-parse of only that file.
- Corrupt sqlite backend self-heals: delete+recreate cache dir, else fall back to an in-memory `dict()` (`repomap.py:177-215`).

### Graph build (`get_ranked_tags`, `repomap.py:365-574`)
Uses `networkx.MultiDiGraph` (lazy import, `repomap.py:368`). `defines[ident]`=files defining it, `references[ident]`=per-occurrence list of referencing files. If a language yields defs with zero refs project-wide, `references = defines` (self-reference) so files aren't orphaned (`repomap.py:465-466`); unreferenced defs also get a 0.1-weight self-edge (tree-sitter-version workaround, `repomap.py:472-479`).

**Edge weight formula** (`repomap.py:481-514`), multiplier `mul` starts at 1.0 per ident:
- in `mentioned_idents` → ×10
- snake/kebab/camelCase **and** length ≥8 → ×10 (long structured names read as more load-bearing)
- leading `_` (private) → ×0.1
- defined in >5 files (ambiguous name) → ×0.1
- referencer is a chat-open file → additional ×50 on that edge
- reference count square-rooted before multiplying (blunts high-frequency low-value mentions)

### PageRank with personalization
`personalization[rel_fname]` (`repomap.py:420-445`): base unit `100/len(fnames)`; `+unit` if chat file, `max(cur, unit)` if in `mentioned_fnames`, **plus another** `+unit` (once) if any path component/basename/stem intersects `mentioned_idents` — a chat file that's also textually mentioned can reach 2×unit.
`nx.pagerank(G, weight="weight", personalization=..., dangling=...)` (`repomap.py:519-531`), with fallbacks on `ZeroDivisionError`.
**Rank→definitions**: each source's PageRank mass is distributed across its out-edges proportional to `weight/total_out_weight`, accumulating `ranked_definitions[(dst_file, ident)]` (`repomap.py:533-545`) — converts per-file PageRank into per-symbol importance. Tags sorted by this score; chat-file-internal defs are skipped (already fully shown); then never-appeared files by raw node rank; then remaining files (`repomap.py:547-572`).

### `get_ranked_tags_map`: binary search to fit budget
`get_ranked_tags_map_uncached` (`repomap.py:629-706`) starts `middle = min(max_map_tokens//25, num_tags)` (≈25 tokens/tag heuristic), binary-searches the **count of ranked tags included**, rendering+token-counting at each `middle`. Accepts if `num_tokens <= budget` and better than best-so-far, or breaks early if `pct_err = |num_tokens-budget|/budget < 0.15` (15% tolerance) — an approximate, not exact, fit. `special_fnames` (README etc., via `aider/special.py`) are prepended unconditionally before the search (`repomap.py:657-662`).

### Rendering & tokens
`render_tree`/`to_tree` (`repomap.py:708-784`) use `grep_ast.TreeContext` per file to render collapsed source with `...` elision around the surviving def lines (not raw dumps), cached by `(rel_fname, sorted(lois), mtime)`. Output lines hard-truncated to 100 chars for minified/pathological files (`repomap.py:782`).
`token_count` (`repomap.py:89-101`): <200 chars uses the real model tokenizer; longer text **samples every Nth line** and extrapolates `sample_tokens/len(sample) * len(text)` — a statistical estimate, not exact, to keep the binary search fast.

### Defaults & refresh
`--map-tokens` default `None` → `1024` (`aider/args.py:248-252`, `base_coder.py:487-489`). `--map-multiplier-no-files` CLI default `2` (`args.py:263-266`) — note the `RepoMap` class's own internal default is `map_mul_no_files=8` (`repomap.py:56`), but the CLI always passes its own value through, so users effectively get 2. `--map-refresh` default `auto` (`args.py:254-260`): `manual` returns the cached map unconditionally; `always` never caches; `files` caches keyed only by `(chat_files, other_files, max_tokens)` — mentions excluded, so a mention-only change won't invalidate; `auto` caches only if the *previous* build took >1.0s (`repomap.py:592-627`), a self-tuning latency/staleness tradeoff. With no chat files open, the budget is boosted: `target = min(max_map_tokens*map_mul_no_files, max_context_window-4096)` (`repomap.py:122-132`) — a bigger "orient the whole repo" map.

### Large-repo handling
No explicit `max_map_time`. The only large-repo guard: a `RecursionError` around map-building **disables the map entirely** (`max_map_tokens=0`) with a "repo too large?" message (`repomap.py:143-146`). A `tqdm` progress bar shows only if `len(fnames) - cache_size > 100` (`repomap.py:391-398`).

### `mentioned_fnames`/`mentioned_idents` — how they steer
`get_ident_mentions` (`base_coder.py:678-681`) is a crude `re.split(r"\W+", text)` word-set of the current message; `get_file_mentions` matches literal filenames in the text; `get_ident_filename_matches` (`base_coder.py:684-707`) cross-links — any mentioned ident ≥5 chars whose lowercased stem matches a known file's basename-stem is folded into `mentioned_fnames` too. These feed `RepoMap.get_repo_map(...)` (`base_coder.py:724-729`), driving **both** PageRank personalization and the ×10 edge-weight boost. `get_repo_map` (`base_coder.py:709-748`) has a 3-step fallback: scoped map with mentions → all-files map with mentions → fully generic map with no mentions.

### What signals are NOT used
No embeddings/semantic similarity, no LLM-driven file selection, no import/dependency-graph parsing (edges are pure identifier co-occurrence, not `import` resolution), no recency/git-blame/change-frequency weighting, no cross-language symbol resolution (matching is by identical `Tag.name` string only).

### Python deps & Node-port equivalents
`diskcache`, `grep_ast`, `networkx<3.5` (deliberately pinned to avoid `networkx[default]`'s matplotlib pull, `requirements/requirements.in:22-27`), plus `pygments`, `tqdm`, `tree_sitter`. **For Node**: `web-tree-sitter` (WASM grammars, avoids native-binding build fragility — see Repomix below) + a `.scm`-per-language table; `graphology` + `graphology` PageRank utilities as the `networkx` analog (verify personalization/dangling-node support); a simple mtime-keyed JSON/LMDB cache instead of `diskcache`; `gpt-tokenizer` (exact, pure-JS) rather than reimplementing the sampling estimate.

### Benchmark repo-map eval
`grep -rl "repo_map|RepoMap|repomap" benchmark/` — **no matches**. `benchmark/` (SWE-bench harness) scores end-to-end coding-task success; repo-map isn't separately evaluated.

---

## PART 2 — REPOMIX (`src/`)

### License
MIT (`yamadashy_repomix/LICENSE:1`). Copying source requires keeping the copyright+permission notice.

### Pipeline stages (`src/core/packager.ts:76-361`, `pack()`)
1. Background-start token-cache load + git-sort-data prefetch, overlapping with search (`:91-101`).
2. `searchFiles` per root → `sortPaths` → display paths (`:103-159`); pre-warm metrics worker pool concurrently (`:161-168`).
3. Parallel: `collectFiles`+`applyFileProcessors` vs. `getGitDiffs`/`getGitLogs` subprocesses (`:170-194`).
4. Parallel: `validateFileSafety` (secretlint, worker threads) vs. `processFiles` (compression/comment-stripping, main thread) — deliberately non-competing for CPU (`:233-245`).
5. Filter suspicious files out of processed output (`:250-253`); pre-sort into final order (`:255-262`).
6. Optional early-return skill-generation branch (`:266-286`).
7. `produceOutput` (render+write) concurrently with `calculateMetrics`, sharing an `outputForMetrics` promise so metrics doesn't block on disk I/O (`:303-335`); persist token-count cache (`:352`).
Far more parallelism-conscious than Aider's single-threaded synchronous build.

### Include/ignore rules (`src/core/file/fileSearch.ts`)
`globby` with `dot:true`, `followSymbolicLinks:false` (`:421-434`). Ignore sources merged: `defaultIgnoreList`, self-ignore of the output path, `config.ignore.customPatterns`, and (if `useGitignore`) `.git/info/exclude` plus globby's native `.gitignore` handling (`:458-508`). `.gitignore`/`.ignore`/`.repomixignore` control files are kept visible to globby (so their rules load) then explicitly filtered back out of the result list (`:94-125, 386-394`). `confineToBaseDir` (MCP sandbox) does a **realpath** post-filter dropping matches resolving outside root even via a symlinked intermediate dir (`:291-329`).

### Tree-sitter `--compress` (`src/core/treeSitter/`)
`web-tree-sitter` (WASM) chosen over native bindings for cross-platform install reliability, grammars bundled via `@repomix/tree-sitter-wasms` instead of 15+ native packages (`parseFile.ts:1-19`). 16 languages, each with a `.scm` query + a `ParseStrategy` (`languageConfig.ts:65-176`).
- `DefaultParseStrategy` (`:1-37`) keeps a capture's span only if its name contains `"name"`, `"comment"`, or `"import"/"require"`.
- `TypeScriptParseStrategy` (`:17-165`) is signature-aware: for function/method captures it finds the line where `)` is followed by `{`/`=>`/`;` and **strips the body** (`findSignatureEnd`/`cleanFunctionSignature`); classes keep the declaration + `extends`/`implements` line, body-brace stripped; interfaces/types/enums/imports kept in full; comments kept verbatim.
Captured chunks are deduped per start-row (keep longest), merged when adjacent, joined with a literal `⋮----` separator marking elisions (`parseFile.ts:36, 103-109, 157-213`). Compression is **best-effort, never throws**: any WASM/parse failure (including a hard runtime abort) falls back to uncompressed content for that file only; unsupported languages pass through uncompressed silently (`:38-127`).

### Tokenizer (`src/core/metrics/TokenCounter.ts`)
`gpt-tokenizer` (pure JS/TS BPE, no native/WASM step), lazily loading per-encoding BPE tables and caching the loader per encoding (`:19-45`). `disallowedSpecial: new Set()` deliberately disables special-token scanning so literal text like `<|endoftext|>` in source is tokenized as ordinary text (`:16-17, 71-75`). Failures degrade to `0` with a logged warning (`:76-89`) — an **exact** count, unlike Aider's sampled estimate.

### Security check (`src/core/security/`)
`runSecurityCheck` (`securityCheck.ts:24-130`) batches file contents **plus** working-tree diff, staged diff, and git-log content into `BATCH_SIZE=50` chunks on a capped worker pool (`min(2, cpuConcurrency)`, deliberately small to avoid contending with the metrics pool, `:81-92`). Scanner is `@secretlint/core`'s `lintSource` + `@secretlint/secretlint-rule-preset-recommend` (`workers/securityCheckWorker.ts:4-5`) — delegated to the established secretlint project rather than hand-rolled regexes; the worker monkey-patches `perf_hooks.performance.mark` to a no-op (worker-thread only) to defeat an O(n²) profiler cost (`:1-58`). Results filter matched files out of final output and are surfaced to CLI/MCP callers as `suspiciousFilesResults`/`suspiciousGitDiffResults`/`suspiciousGitLogResults`.

### Output structure (`src/core/output/outputStyles/xmlStyle.ts`, full file)
Handlebars template, conditional sections: `<file_summary>` (purpose/format/usage-guidelines/notes), optional `<user_provided_header>`, `<directory_structure>` (tree string), `<files>` (`<file path="...">content</file>` per file), optional `<git_diffs>` (work-tree + staged), optional `<git_logs>` (per-commit date/message/files), optional trailing `<instruction>`. `analyzeContent`/`generateHeader` (`outputStyleDecorate.ts:24-56+`) embed a human-readable summary of which lossy transforms were active (comments removed, compressed, security-filtered, etc.) — the output is self-describing about what it elided. markdown/json/plain are parallel renderers of the same data.

### MCP tools & output bounding
Tools: `pack_codebase`, `pack_remote_repository`, `read_repomix_output`, `grep_repomix_output`, `file_system_read_file`/`_read_directory`, `attach_packed_output`, `generate_skill_tool`.
**Bounding pattern** (`mcpToolRuntime.ts:166-238`, `packCodebaseTool.ts`): the full packed output is written to a temp file (`createToolWorkspace` → OS tmp dir), never returned inline. The tool call returns only `outputId`, `outputFilePath` (omitted in sandbox mode), a `metrics` object (`totalFiles`, `totalCharacters`, `totalTokens`, `totalLines`, `topFiles` — N largest by char count, default 10), and a directory tree; response text tells the model to use `read_repomix_output`/`grep_repomix_output` with `outputId` instead of expecting inline content. `read_repomix_output` supports **line-range** partial reads (`readRepomixOutputTool.ts:49, 137`, `lines.slice(start,end)`) — explicit pagination so a huge pack is never dumped whole into context.
Sandbox mode (`packCodebaseTool.ts:129-221`) confines include/ignore + traversal to a workspace root, skips local/global `repomix.config.*` (could otherwise redirect `output.instructionFilePath` or run command-executing `input.processors`), disables `gitSortByChanges` (avoids `git log` against an untrusted `.git/config`, a `gpg.program` command-injection vector), and never echoes host paths to the model.

### Key npm deps
`@repomix/tree-sitter-wasms`, `web-tree-sitter`, `gpt-tokenizer`, `@secretlint/core` + `@secretlint/secretlint-rule-preset-recommend`, `globby`, `handlebars`.

### Reusable for `export_context_pack`
The temp-file + metrics-summary + `outputId` retrieval pattern; the line-range `read_...` pagination tool; `gpt-tokenizer` for exact counts; the layered ignore rules (default + gitignore + custom + self-ignore); the sandbox hardening checklist (realpath-confine, skip untrusted config, avoid subprocess reads of untrusted `.git/config`); `web-tree-sitter`+bundled WASM as the cross-platform parsing story; signature-only compression per language as a cheap complement/fallback to a PageRank-selected symbol map.

---

## (a) Portable ideas
- Rank definitions, not just files, by distributing each file's PageRank mass across outgoing reference edges to the specific idents it references, spending budget on symbols not whole files (`repomap.py:533-545`).
- Weight edges by identifier "load-bearingness" heuristics — mention ×10, long structured name ×10, `_private` ×0.1, >5-definer common name ×0.1 — as cheap importance proxies without semantic analysis (`repomap.py:487-499`).
- Boost edges from already-open/selected working-set files (×50) so the map biases toward what's reachable from current focus (`repomap.py:507-509`).
- Seed PageRank personalization from task text by matching path components/basenames/stems against mentioned words, not just exact filenames (`base_coder.py:684-707`; `repomap.py:432-442`).
- Binary-search the number of ranked items included against a rendered-token budget with a tolerance band, instead of computing an exact-fit set analytically (`repomap.py:676-706`).
- Cache per-file parse results keyed by mtime, with graceful in-memory fallback if the on-disk cache backend breaks (`repomap.py:217-264, 177-215`).
- Self-tune whether to cache the assembled context (only if last build took >1s) to balance latency against staleness (`repomap.py:608-609`).
- Never return a large generated artifact inline from an MCP tool call — write to disk, return an id + summary metrics, expose separate line-range read/grep tools (`mcpToolRuntime.ts:166-238`; `readRepomixOutputTool.ts:137`).
- Compress code to signatures by finding where a function's `)` is followed by `{`/`=>`/`;` and truncating there — cheap body-stripping without full body-node identification (`TypeScriptParseStrategy.ts:84-107`).
- Layer ignore sources but defer "control file" patterns so their rules still load while the files themselves aren't wrongly excluded from listings (`fileSearch.ts:94-125, 386-394, 458-508`).
- Cap security-scan worker threads to avoid contending with a concurrent metrics/tokenizer pool (`securityCheck.ts:81-92`).
- Overlap independent pipeline stages explicitly (`Promise.all`/prefetch) instead of a strictly linear pipeline (`packager.ts:89-101, 170-194, 233-245, 296-335`).
- Make output self-describing about which lossy transforms were applied, so a downstream LLM knows what's missing (`outputStyleDecorate.ts:24-56`).
- Harden a sandboxed mode: skip untrusted config files, confine glob results via realpath (defeats symlink escapes), suppress subprocess reads of untrusted `.git/config` (`packCodebaseTool.ts:169-182`; `fileSearch.ts:291-329`).
- Use `web-tree-sitter` (WASM) with bundled grammars instead of native bindings for zero-build-step cross-platform npm installs (`parseFile.ts:1-19`).
- Fall back gracefully at every layer (pygments token scan; best-effort-never-throws compression) so one bad file never breaks the whole pack (`repomap.py:347-363`; `parseFile.ts:38-127`).

## (b) Not applicable / too heavy
- Aider's sampled-line token estimator (`repomap.py:89-101`) is a speed hack around a slow tokenizer inside a tight loop; `gpt-tokenizer` in Node is fast/exact enough to skip the estimate.
- Aider's `>1.0s` self-tuning cache heuristic (`repomap.py:608-609`) is coarse and tied to a synchronous single-process architecture; simpler to cache by content-hash/mtime unconditionally in Node.
- Repomix's full secretlint scan (multi-preset, worker pool, git-diff/log scanning) is heavier than a context-pack compiler needs on an already-trusted local repo; a lighter check (or opt-in secretlint only when exporting externally) is more proportionate.
- Repomix's remote-repo fetch/clone (`git/gitHubArchive*.ts`, `remoteAction.ts`) and skill-generation pipeline (`core/skill/`, Handlebars templates) are product features orthogonal to compiling a bounded pack from a task description.
- Aider's pygments whole-file fallback (`repomap.py:347-363`) is low-precision/high-noise (every identifier becomes a "reference"); better to skip reference-graph building for unsupported languages than inject noisy edges.
- Repomix's multi-style templating (xml/markdown/json/plain via Handlebars) is more presentation flexibility than one well-specified pack schema needs.
- Neither project derives real import/module-resolution graphs (both use identifier co-occurrence only); accurate JS/TS `import` graphs need separate module-resolution logic.

## (c) Attribution needs if ported
- **Aider**: Apache-2.0. Reimplementing the algorithm from scratch needs no attribution; copying actual `.scm` query files or code verbatim requires keeping the copyright notice and (per §4) a NOTICE/changes statement if applicable.
- **Repomix**: MIT. Copying source (query strings, `TypeScriptParseStrategy` logic, the profiler patch, Handlebars templates) verbatim requires keeping the MIT copyright/permission notice (e.g. in a NOTICES/THIRD_PARTY file); not required per-file.
- Any transitively adopted libraries (`gpt-tokenizer`, `web-tree-sitter`, `@repomix/tree-sitter-wasms`, `@secretlint/core`, `graphology`) are MIT-family and need only standard npm dependency attribution via package.json/lockfile.
