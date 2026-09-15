# Open-source research: следующий этап AI Dev System

Дата: 15 сентября 2026. Ветка исследования: `claude/zealous-hawking-v8n21d`.
Исходное задание — обзор восемнадцати проектов и классификация их идей для пяти
инициатив (Context Engine, Memory, Lifecycle + Verification, Tracing + Durable
Execution, ExecutionBackend). Этот документ — результат этапа «изучить, не
менять код». Кода в нём нет и изменений в `src/` он не вносит.

Что здесь есть:

1. Как исследовали и какие поправки к заданию выяснились по дороге.
2. Что AI Dev System умеет сегодня — по подсистемам, с файлами и строками,
   включая замеры реальных ответов инструментов.
3. Классификация каждой идеи: `already_have`, `improve_existing`,
   `new_capability`, `not_relevant`, `too_complex`.
4. Proposals по инициативам A–G в формате из задания (Problem → Acceptance
   criterion).
5. Матрица влияния на tool count, контекст, старт, RAM, диск, установку, три ОС,
   Docker, local-first и модель безопасности.
6. Лицензии и что потребует attribution.
7. Дефекты, найденные попутно, — кандидаты в `docs/DEFECTS.md`.
8. Рекомендуемый порядок работ и бенчмарки «до/после».

Все ссылки на код AI Dev даны относительно `ai-dev-mcp-server/`, если не сказано
иначе. Ссылки на чужие проекты — относительно корня их репозитория на дату
клона (15.09.2026, `--depth 1`).

---

## 1. Метод и поправки к заданию

Каждый проект клонирован и прочитан по коду, не по README. По AI Dev System
прочитаны `context-compiler`, `search-index`, `search-runtime`, `session-memory`,
`instincts`, `decision-ledger`, `lifecycle`, `task-verification`,
`completion-claims`, `task-snapshots`, `process-runner`, `command-policy`,
`usage-ledger`, `tool-profiles`, hooks и Docker-файлы. Сервер запускали на
fixture-проекте и замеряли размеры ответов в байтах.

Четыре факта, которые меняют расстановку сил относительно задания:

| Проект | Что оказалось на самом деле | Следствие |
| --- | --- | --- |
| **OpenHands** | `OpenHands/OpenHands` сегодня — фронтенд Agent Canvas (TypeScript/Electron, 10 `.py` файлов). Stuck detector, critic, runtime и condenser переехали в `OpenHands/software-agent-sdk`. Исследован именно он. | Ссылки в задании устарели; идеи живы. |
| **Serena** | Двойная лицензия: `src/solidlsp/**` — MIT, `src/serena/**` (агент, инструменты, промпты, YAML контекстов) — **GPL-3.0-or-later**. | Переносить можно только идеи и LSP-слой; код инструментов — нет. |
| **Mem0** | В клоне v2.0.20 контракт ADD/UPDATE/DELETE/NONE — мёртвый код; живой путь — ADD-only извлечение + MD5-дедуп. `graph_memory.py` и `openmemory/` отсутствуют, `evaluation/` — незагруженный сабмодуль. | Как reference обновления памяти Mem0 больше не подходит; полезна только методика eval и `infer=False`. |
| **Aider** | Repo Map не использует ни embeddings, ни реальный граф импортов — только co-occurrence идентификаторов через tree-sitter теги; `benchmark/` не содержит оценки Repo Map. | Нужно ранжирование, а не «взять как есть». |

Мелкие: Roo Code архивирован (май 2026), Continue read-only — оба остаются
reference. `hurttlocker/cortex` (Go) оказался ближе к нашей задаче, чем
`cdeust/Cortex` (Python, нейронаучные метафоры, 50+ инструментов).

---

## 2. Что есть сегодня

### 2.1 Контекст и поиск

**Context pack** (`src/core/context-compiler.mjs`, 479 строк). Вызывается из
`begin_task` (`extensions/lifecycle.mjs:72,106-184`: 12 файлов / 20 000 символов)
и `compile_project_context` (`mcp-stdio.mjs:4221-4275`: 12 / 24 000, границы
1..30 файлов и 8 000..60 000 символов).

- Отбор файлов — чистая эвристика по путям (`scoreFile`, `:97-140`): грязный файл
  +80, токен задачи в имени +18 / в пути +8, доменное расширение +7, тестовый путь
  +10, lockfile или minified −50. Обход до 6 000 файлов, глубина 12.
- Выдержка — `content.slice(0, excerptBudget)` **с начала файла** (`:240-243`),
  никакой привязки к символам или строкам. Бюджет: 55 % документам, остальное
  делится поровну между файлами, минимум 500 символов на файл.
- Токены считаются только для пакета целиком: `ceil(len/4)` (`:357`). Поле
  `token_cost` у элемента отсутствует; есть `score` и `reasons` по путям.
- Лестница переполнения (`:317-350`): убрать файлы, урезать выдержки до 240,
  extras до 400, документы до 600, extras до 400 ещё раз (дубль), убрать всё.
- `import-graph.mjs` (361 строка: regex-скан импортов JS/TS/Python, циклы Тарьяна,
  кэш `.ai-dev/cache/import-graph.json`) **существует, но в отбор файлов не
  участвует** — рендерится только в `project-map.md` (`mcp-stdio.mjs:2424`).
  Пакет советует агенту «прочитать соседние зависимости», но сам их не считает.
- Персистентность: `begin_task` кладёт markdown и `selected_files` в запись
  задачи; `compile_project_context` пишет `.ai-dev/context/packs/<id>.{md,json}`.
  ARCHITECTURE.md:444 обещает `.ai-dev/context/<task-id>.json` — этого никто не
  пишет.
- Ошибки провайдеров extras собираются в `errors[]` (`context-extras.mjs:99-106`),
  но `compileContextPack` читает только `extras.sections` (`:289`) — обещанная
  запись `unknown` в пакете не реализована.

**Поиск** (`search-index/search_cli.py`, 1 820 строк; `core/search-index.mjs`).
Корпус — vault, реестр skills и по четыре файла на проект
(`project-brief.md`, `project-map.md`, `quality-gate.md`, `AGENTS.md`;
`search_cli.py:855-890`). **Исходный код проектов не индексируется.** SQLite
FTS5 + хэшированные sparse-векторы (1024 dims) + dense BGE-M3 (ONNX в
worker_thread или legacy Python). Python по-прежнему нужен для каждой операции с
индексом (`search-index.mjs:109-125`). Ranking v2 объясним: `explain_search`
отдаёт вклад каждого сигнала (`search-runtime.mjs:279-324`). Golden cases: 45
поисковых и 37 маршрутизирующих; метрики MRR, top-1, nDCG, violations
(`search-eval.mjs`).

**Code intelligence.** Ни tree-sitter, ни LSP, ни AST, ни callers/references —
нигде. `search_knowledge` — линейный substring-скан, не индекс.

### 2.2 Память

Три хранилища и пять типов записей. Что есть и чего нет — одной таблицей
(`session-memory.mjs:56-78,198-217`; `instincts.mjs:234-255`;
`decision-ledger.mjs:182-194`):

| Поле | Handoff | Hook draft | Instinct | Decision |
| --- | --- | --- | --- | --- |
| `source` / `source_id` | `source: "agent" \| "hook"`, id нет | `source: "hook"` | `source` строка, id нет | **нет** |
| `created_at` / `updated_at` | `saved_at` / нет | `saved_at` / перезапись | есть / есть | `date` (день) / нет |
| `confirmed` / trust | есть | `confirmed:false` | нет | нет |
| `confidence` | нет | нет | есть, 0.3..0.85 по observations | нет |
| `importance` | нет | нет | нет | нет |
| `use_count` / `last_used` | нет | нет | `last_observed_at`, но не «использована» | нет |
| `evidence` | `worked[].evidence` | нет | `evidence[≤20]` | нет |
| `valid_from` / `valid_to` | нет | нет | нет | нет |
| `supersedes` | нет | нет | нет | **есть** (переписывает статус старой) |
| `contradictions` | нет | нет | `contradict −0.1`, без структуры | нет |

- **Запись.** `save_session` всегда ADD (новый файл); `record_decision` всегда
  ADD (следующий номер); instinct — UPDATE, если совпал id или ≥0.75 перекрытия
  токенов (`instincts.mjs:120-127`), иначе ADD; SUPERSEDE нигде; dry-run только у
  `propose_instincts`.
- **Recall.** Handoff — «самый новый с substance_score ≥3», без фильтра
  релевантности и без объяснения; в пакет уходят дата, next step, ≤3 failed, ≤3
  blockers (`context-extras.mjs:44-66`). Instincts — `rankForContext`:
  effective confidence + 0.25 проект + 0.2 стек + 0.15 токены задачи, top 6, порог
  0.7 (`instincts.mjs:329-344`); в пакете видны только `{id, confidence, scope}`.
  Decisions — 5 последних по дате, только recency (`context-extras.mjs:25-35`).
- **Decay.** Только у instincts, на чтении: `max(min(conf,0.3), conf −
  floor(weeks)·0.02)` (`instincts.mjs:100-105`); prune при conf<0.3 и 90 дней
  простоя. Handoff старше 7 дней помечается WARNING.
- **Индекс.** Sessions, instincts, decisions, outcomes в поисковый индекс не
  попадают (`search_cli.py:855-899`).
- **Eval для памяти** отсутствует (0 упоминаний в `search-eval/`).
- **Безопасность.** Instincts инжектятся императивным текстом («apply when the
  trigger matches», `instincts.mjs:451`, `context-compiler.mjs:398`,
  `hooks/lib.mjs:75-82`) без ограждения; handoff несёт «HISTORICAL REFERENCE
  ONLY». Порог импорта 0.7 равен порогу инъекции (`>=`), поэтому импортированный
  instinct попадает в контекст сразу.

### 2.3 Lifecycle, verification, execution, recovery

- **`begin_task`** (`lifecycle.mjs:102-183`). `plan_policy` (`task-plans.mjs:29-82`):
  risk high +3 / medium +1, LARGE_SIGNALS +2, SMALL_SIGNALS −1, ≥120 слов +2,
  ≥8 выбранных файлов +2, ≥4 критериев +1; `score ≥4 → large`, `≥2 → medium`;
  `plan_required = large || risk high`. Критерии приёмки — из текста + 3 по
  умолчанию (scope / automated checks pass / no regression) + доменные.
  **Проверки определённости задачи нет**: обязателен только непустой `task`
  (`task-lifecycle.mjs:93`); `context_unknowns` сохраняется, но ничего не gate-ит.
- **`verify_task`** (`lifecycle.mjs:321-497`): quality_gate, change_hygiene,
  security_scan по умолчанию; frontend_qa/product, coverage, archify — по условию.
  Вердикт (`task-verification.mjs:21-48`): пустой прогон — fail, gate должен быть
  ровно `passed`. Fingerprint = sha256(HEAD + porcelain + dirty content) — устаревшие
  доказательства отклоняются при завершении.
- **`complete_task`**: семь отказов по порядку (`task-lifecycle.mjs:226-258`);
  13 правил линтера формулировок, EN/RU (`completion-claims.mjs:63-162`).
- **Поведение агента во времени** (циклы, повтор падающей команды, перезапись
  одного файла, расползание scope, churn) — **не проверяется нигде**. Косвенные
  сигналы есть: `fact-force` (первая правка файла), `compact-advisor` (счётчик
  вызовов), `stop-check`, post-hoc `instinct-proposals` (повторяющиеся команды).
- **Execution**: `process-runner.mjs` — argv, `shell:false`, 120 с, 2 MiB общий
  кап вывода с `truncated`, kill группы процессов. Командная политика —
  allowlist аргументов, без абсолютных путей и `..`. **Интерфейса
  ExecutionBackend нет**: `runProcess` импортируется напрямую. Docker:
  `read_only`, `network: none`, `cap_drop ALL`, `/workspace` rw, `/models` ro.
- **Recovery**: запись задачи хранит скомпилированный контекст, выбранные файлы
  с sha256, routed skills, путь плана, checkpoints, verifications, snapshot refs.
  Ссылки на память — в тексте, не как id. Статуса `interrupted`, heartbeat и
  `resume_task` нет; путь возобновления — `get_task` + `resume_session` +
  session-start hook. Блокировка записи — только внутрипроцессная.
  `RECOVERY.md` — про backup/restore всей системы (PowerShell).

### 2.4 Tool surface и observability

133 инструмента, 62 read-only, 8 профилей (`core/tool-profiles.mjs:39-237`).
Замер схемы (`tools/list`, bare / полный wire с outputSchema и annotations):
core 16 190 / 22 843 байт; all 98 857 / 135 175. Документация называет bare-числа.

**Замер ответов на fixture-проекте** (text bytes / wire bytes / мс). Каждый
результат дублируется в `structuredContent.result` (`server.mjs:292-306`), поэтому
wire ≈ 2× text:

| Инструмент | text | wire | мс |
| --- | ---: | ---: | ---: |
| `begin_task` | 15 001 | 28 108 | 539 |
| `compile_project_context` | 13 075 | 24 360 | 448 |
| `recommend_skills` | 5 403 | 10 373 | 90 |
| `search_skills` (10 hits) | 29 167 | 55 638 | 92 |
| `search_all` | 5 200 | 10 340 | 6 841 (холодный индекс) |
| `hybrid_search` | 10 994 | 21 393 | 358 |
| `checkpoint_task` | 16 043 | 30 002 | 68 |
| `verify_task` | 32 833 | 57 856 | 299 |
| `complete_task` | 29 080 | 51 707 | 148 |
| `resume_session` | 1 574 | 3 159 | 74 |
| `system_health_check` | 22 642 | 39 978 | 1 758 |

Три наблюдения: каждая запись задачи возвращает **всю** запись (≥15 KB) на
каждом шаге; `search_skills` тяжелее `search_all` в шесть раз на hit (сырые
строки реестра); общего паттерна summary/`include_details`/`details_ref` нет —
только `include_*` у health и `limit_tools` у usage. Ошибки — `isError:true` с
plain-text сообщением, без кода и `next_step` (`server.mjs:411-423`).

**Ledger** (`usage-ledger.mjs:437-449`): `at, tool, ok, duration_ms, task_id,
project_path, error, client` — **без размеров входа/выхода, без session id;
`client` никогда не заполняется**. Trace/timeline/span — нет.

**Footprint**: старт 300–540 мс, ≈86 MB RSS без dense-модели; ONNX int8 BGE-M3
~600 MB; `node_modules` 422 MB; daemon idle 30 мин. Хуки есть только для Claude
Code и Cursor (контракт Cursor не верифицирован, Д-2); Codex/Gemini/VS Code — без
хуков.

---

## 3. Классификация идей

| # | Идея | Источник | Класс | Куда |
| --- | --- | --- | --- | --- |
| 1 | Response budgets, summary-first, refuse-and-narrow для поиска | SWE-agent, Serena `_limit_length`, CodeGraph lean rows, Repomix `outputId` | **improve_existing** | A1 |
| 2 | Symbol-level excerpts (сигнатуры вместо `slice(0,N)`) | Repomix compress, SWE-agent filemap | **improve_existing** | A2 |
| 3 | Граф файлов/символов + personalized PageRank + token budget | Aider repomap, CodeGraph `context` | **improve_existing** (граф импортов уже есть, но не используется) | A2 |
| 4 | Точный подсчёт токенов | Repomix `gpt-tokenizer` | improve_existing | A2 |
| 5 | Объяснение каждого элемента контекста (`reason[]`, scores, `token_cost`) | Aider (неявно), задание | improve_existing | A2 |
| 6 | LSP-адаптер: definitions/references/callers | Serena SolidLSP (MIT) | **new_capability**, поэтапно, опционально | A3 |
| 7 | Coverage / evidence / freshness как три поля любого структурного ответа | CodeGraph `AnswerMetadata` | new_capability (контракт) | A3, A2 |
| 8 | Unique-or-drop resolution, «лучше partial, чем выдуманное ребро» | CodeGraph | принцип для A2/A3 | A2 |
| 9 | Собственный tree-sitter граф + SQLite + Louvain/betweenness | CodeGraph | **too_complex** (дублирует LSP) | — |
| 10 | `export_context_pack` | Repomix | new_capability (CLI, не MCP tool) | A6 |
| 11 | Индексировать исходники проекта в dense/FTS | — | not_relevant сейчас: символьный индекс дешевле и точнее | A7 |
| 12 | Source-keyed память, write preview, диф до записи | Mnemic | **improve_existing** | B1, B2 |
| 13 | ADD/UPDATE/SUPERSEDE/CONFLICT/NOOP | Mem0 (legacy), Mnemic, hurttlocker | improve_existing | B2 |
| 14 | Лексический near-dup (Jaccard + Levenshtein 0.90) | hurttlocker/cortex | improve_existing (у instincts уже 0.75 по токенам) | B2 |
| 15 | Explainable recall (per-hit `matchedFields`, `reasons[]`) | Mnemic | improve_existing | B3 |
| 16 | Receipts инъекций и `why` | cdeust/Cortex | improve_existing (в ledger) | B3, E1 |
| 17 | Lifecycle-runner: promote / retire / supersede, dry-run, skip-reasons | hurttlocker/cortex | improve_existing (`prune_state`, decay уже есть) | B4 |
| 18 | `confidence = useful/access` по явной обратной связи | cdeust/Cortex | improve_existing | B4 |
| 19 | Proposal-before-trust | hurttlocker/cortex | **already_have** (`propose_instincts`, status `proposed`, cap 0.5) | — |
| 20 | Bi-temporal поля и детерминированное supersession | Graphiti | improve_existing (decisions уже имеют `supersedes`) | B5 |
| 21 | Graph DB, LLM-инвалидация, cross-encoder | Graphiti, Mem0 | too_complex / cloud | — |
| 22 | Memory eval без LLM (Recall@k, MRR, stale rate) | Mnemic `eval`, Mem0 docs | new_capability (по образцу `search-eval/`) | B7 |
| 23 | Индексировать память в FTS | — | improve_existing | B8 |
| 24 | Детерминированная проверка определённости задачи + вопросы | Spec Kit `/clarify` | **improve_existing** (`plan_policy`) | C1 |
| 25 | Cross-artifact analyze: критерии ↔ дифф | Spec Kit `/analyze` | improve_existing (`verify_task`) | C2 |
| 26 | Constitution | Spec Kit | **already_have** (`install_project_rules`, AGENTS.md) | — |
| 27 | Полный spec/plan/tasks pipeline с шаблонами | Spec Kit | not_relevant (бюрократия для малых задач) | — |
| 28 | Stuck detector: 4 повтора, 3 ошибки → nudge, 4 → stop, окно 20 | OpenHands SDK | **new_capability** (детерминированно) | D1 |
| 29 | `EmptyPatchCritic` / `AgentFinishedCritic` | OpenHands SDK | already_have (fingerprint + verification при complete) | — |
| 30 | LLM critic / GoalController | OpenHands SDK | too_complex сейчас; optional provider позже | D3 |
| 31 | Condenser (LLM summary) | OpenHands SDK | not_relevant (сжатие контекста — забота клиента; `compact-advisor` уже подсказывает) | — |
| 32 | Head/tail усечение с советом (10 000 / 5 000+5 000) | mini-swe-agent | improve_existing (`process-runner` режет хвост) | A1 |
| 33 | Reject-and-explain, «DO NOT re-run the same failed edit» | SWE-agent | improve_existing (формулировки ошибок) | A1 |
| 34 | Span-схема, OTel GenAI атрибуты | AgentOps | improve_existing (словарь для ledger) | E1 |
| 35 | Облачный экспортёр AgentOps | AgentOps | not_relevant (offline-экспортёра нет) | — |
| 36 | Checkpoint = repo snapshot + task state + writes, `parent`, `source` | LangGraph.js | improve_existing (связать checkpoint ↔ snapshot ref ↔ verification) | F1 |
| 37 | Interrupt/resume (human-in-the-loop) | LangGraph.js | improve_existing через `clarifications` в записи задачи | C1, F1 |
| 38 | Time travel / fork | LangGraph.js | already_have (`rollback_task` снимает снимок перед откатом) | — |
| 39 | Split Deployment / Runtime, `execute(argv, shell:false)` | SWE-ReX | new_capability (интерфейс, не рефакторинг) | G1 |
| 40 | pexpect/PS1 сессии, FastAPI-рантайм | SWE-ReX | not_relevant (нет shell) | — |
| 41 | Sandbox lifecycle API | E2B | reference только; cloud-only клиент | G1 |
| 42 | Checkpoints через приватные refs | Cline | already_have (`refs/ai-dev/snapshots/`) | — |
| 43 | Modes → tool groups → `fileRegex` | Roo Code | already_have (профили) + идея: правила записи по профилю → `policy.json` | — |
| 44 | Context Provider Contract (`type`, `dependsOnIndexing`) | Continue | improve_existing (`context-extras.mjs`) | A5 |

---

## 4. Proposals

Формат каждого блока — из задания. Complexity: S (до недели), M (2–4 недели),
L (больше). Migration risk оценён по совместимости записей и ответов инструментов.

### Инициатива A — Context Engine vNext

#### A1. ACI audit и response budgets

| | |
| --- | --- |
| **Problem** | Инструменты возвращают на порядок больше, чем агент использует: `verify_task` 33 KB, `search_skills` 29 KB на 10 hits, любая запись задачи ≥15 KB, и всё дублируется в `structuredContent`. |
| **Current behaviour** | Полная запись задачи в каждом ответе (`lifecycle.mjs:155-171,245-251`); hits поиска — сырые строки реестра; ограничений — `MAX_RESULTS 50`, 2 MiB на процесс; паттерна summary/details нет; ошибки — plain text без `next_step`. |
| **Reference** | SWE-agent (`search_dir`: >100 совпадений → отказ «Please narrow your search»; окно 100 строк с «(N more lines above/below)»; edit reject-and-explain); mini-swe-agent (10 000 симв., head/tail 5 000/5 000 с советом); Serena `Tool._limit_length` (лестница `shortened_result_factories`, 150 000 симв.); CodeGraph (lean row `{name,kind,file,line}` после инцидента 232 KB; детали только через `get_node`); Repomix MCP (`pack_codebase` возвращает `outputId` + метрики, чтение — `read_repomix_output` постранично). |
| **Proposed behaviour** | (1) Замерить каждый core-инструмент по ledger: avg/p95 байт, повторные вызовы. (2) Ввести `response budgets`: core ≤ 2–4 KB text по умолчанию; поиск — bounded count + lean row + `preview` ≤ 200 символов; `begin/checkpoint/verify/complete` возвращают `summary` (id, статус, критерии, next_step) и `details_ref` на запись задачи; полная запись — по `include_details:true` или через `get_task`. (3) Отключить дублирование в `structuredContent` либо оставить только там (один канал). (4) Ошибки — `{error, rule?, next_step}` с советом, как сузить запрос. (5) Лестница усечения по образцу Serena для любого over-budget ответа. |
| **Architectural location** | `src/server.mjs` (обёртка результата), `src/core/response-budget.mjs` (новый pure-модуль), `extensions/lifecycle.mjs`, `extensions/search.mjs`, `extensions/skills.mjs`. |
| **Dependencies** | Нет новых. |
| **Complexity** | M. |
| **Migration risk** | Средний: клиенты, читающие `structuredContent` или полную запись из `begin_task`, увидят другой shape. Смягчение — флаг `AI_DEV_RESPONSE_MODE=full` на один релиз и запись в CHANGELOG «что перепроверить». |
| **Security** | Нейтрально; меньше payload — меньше случайного вывода секретов в контекст. |
| **Cross-platform** | Нет различий. |
| **Context/token impact** | Ожидаемо −50…−70 % байт на задачу (одна запись задачи 15 KB × 4 шага уже 60 KB). |
| **Benchmark** | `usage_report`: avg/p95 output bytes per tool, tool calls per task, повторные вызовы, — до и после на demo-задаче из `docs/DEMO.md`. |
| **Acceptance criterion** | p95 text-ответа core-инструмента ≤ 4 KB при `include_details` выключенном; полный набор demo-задачи проходит без роста числа вызовов; ни один тест не читает удалённые поля. |

#### A2. Context Compiler v2: символы, граф, бюджет, объяснение

| | |
| --- | --- |
| **Problem** | Пакет — «первые N символов из файлов, чьё имя похоже на слова задачи». Связанные по коду файлы не попадают, релевантные функции обрезаются, бюджет считается делением пополам. |
| **Current behaviour** | `scoreFile` по путям; `slice(0, budget)` с начала файла; `import-graph.mjs` не участвует; `estimated_tokens = len/4`; `reasons` только про путь. |
| **Reference** | Aider `repomap.py`: теги defs/refs через tree-sitter `.scm`, кэш по mtime, граф файл→файл по идентификаторам с весами (×10 упомянутый в задаче, ×10 длинный snake/camel ≥8, ×0.1 приватный `_x`, ×0.1 при >5 определений, ×50 если referencer в чате), personalized PageRank от seed-файлов, ранг перераспределяется на **символы**, бинарный поиск числа тегов под `map_tokens` (1024) с допуском 15 %, рендер TreeContext с `...`. CodeGraph `context`: PPR от FTS-хитов с бюджетом 1000 токенов, стоимость строки `(name+file+snippet)/4+4`. Repomix `--compress`: web-tree-sitter WASM, сигнатуры без тел, разделитель `⋮----`, best-effort. |
| **Proposed behaviour** | Пайплайн `task → seeds (текущие эвристики + грязные файлы + FTS по vault) → расширение по import-graph (уже есть) на 1–2 хопа → tree-sitter теги (WASM) → граф символов с весами Aider → PPR с personalization от seeds → бюджет в токенах через `gpt-tokenizer` → рендер выдержек по символам (сигнатура + тело для top-K, сигнатуры для остальных)`. Каждый элемент: `{source, symbol?, reason: ["dirty_file","semantic_match","imported_by_seed","called_by_selected"], path_score, graph_score, token_cost, coverage}`. Fallback без tree-sitter — текущее поведение. |
| **Architectural location** | `src/core/context-graph-ranker.mjs` (новый pure), `src/core/symbol-tags.mjs` (tree-sitter обёртка как сервис с инжектируемым парсером), `context-compiler.mjs` (замена `selectFiles`/`excerpt`), кэш тегов `.ai-dev/cache/tags.json` по sha256+mtime (двухфазная проверка как в CodeGraph `index.rs:657-708`). |
| **Dependencies** | `web-tree-sitter` + WASM-грамматики (JS/TS, Python, Go, Rust, Java для старта; ≈2–4 MB на язык), `gpt-tokenizer` (pure JS). PageRank — своя реализация на Map (граф ≤ 10⁴ узлов; `graphology` не обязателен). |
| **Complexity** | L (три модуля, кэш, тесты на fixture-репозиториях). |
| **Migration risk** | Низкий для записей (поля добавляются), средний для тестов `context-compiler.test.mjs`, привязанных к порядку файлов. |
| **Security** | WASM исполняется в процессе Node без сети; `SECRET_FILE_PATTERN` сохраняется до парсинга. Кэш тегов не содержит содержимого файлов, только имена/диапазоны. |
| **Cross-platform** | WASM — одинаково на трёх ОС и в Docker; нативных сборок нет. |
| **Context/token impact** | Цель — тот же или меньший бюджет (20 000 симв.) при большей доле нужного; замер по Recall@k символов. |
| **Benchmark** | Новый `context-eval/`: 30–50 задач на 2–3 реальных репо с золотыми файлами и символами; Recall@k файлов/символов, precision, tokens per task, задержка компиляции. |
| **Acceptance criterion** | Recall@12 релевантных файлов ≥ +20 п.п. к текущему при том же `maxChars`; Recall@k символов измерим (сейчас 0, символов нет); компиляция ≤ 1.5 с на репо 5 000 файлов с тёплым кэшем; `npm run acceptance` — 0 падений из 10. |

#### A3. Code Intelligence через LSP-адаптер

| | |
| --- | --- |
| **Problem** | Граф из A2 — текстовый (co-occurrence). Для «кто вызывает `AuthService.refresh`» нужны реальные references/callHierarchy. |
| **Current behaviour** | Ничего; агент делает grep + read_file. |
| **Reference** | Serena SolidLSP (MIT): `request_document_symbols/definition/references/implementation/referencing_symbols`, таймаут 300 с, глобальный кэш бинарников `~/.solidlsp/language_servers/static/<LS>/`, проектный кэш символов по хэшу содержимого `.serena/cache/<lang>/`, получение бинарников: npm (typescript-language-server 5.1.3, typescript 5.9.3), `uvx pyright`, `rustup component add rust-analyzer`, gopls — «поставьте сами»; SHA256-верификация загрузок. Name-path `Class/method[1]` с suffix/exact/substring. CodeGraph: unique-or-drop, кандидаты «to pin» при неоднозначности, `coverage {resolved,total_call_sites,dropped,may_be_incomplete,note}`. |
| **Proposed behaviour** | Сервис `code-intel` с интерфейсом `symbols(file)`, `definition(pos)`, `references(symbol)`, `callers(symbol)`; первая реализация — thin LSP client (initialize, documentSymbol, definition, references, callHierarchy) поверх **уже установленных** серверов: `typescript-language-server`/`pyright` через npm в `~/.ai-dev/tools/` (без сети в Docker — только если смонтированы), `gopls`/`rust-analyzer` — по PATH, иначе `unavailable`. Ни один результат без `coverage`/`evidence`/`freshness`. Не новые MCP-инструменты: сначала как провайдер для A2 (уточняет граф), затем — не более двух инструментов (`find_symbol`, `find_references`) в профиле `coding`, и только когда A1 сделан. |
| **Architectural location** | `src/core/lsp-client.mjs` (сервис с инжектируемым launcher, как `process-runner`), `src/core/code-intel.mjs` (контракт + coverage), провайдер в `context-graph-ranker.mjs`. |
| **Dependencies** | `vscode-jsonrpc`/`vscode-languageserver-protocol` (MIT) или свой минимальный JSON-RPC (протокол простой); внешние бинарники серверов — **опционально**, никогда не в default path. |
| **Complexity** | L; исследование доказало осуществимость, но LS-процессы — новый класс runtime-рисков (память, зависания). |
| **Migration risk** | Низкий: чистое добавление за флагом `AI_DEV_CODE_INTEL=lsp`. |
| **Security** | LS запускается через `process-runner` (argv, без shell), под командной политикой; путь к бинарнику — allowlist; в Docker `network: none` — установка невозможна, значит только смонтированные. |
| **Cross-platform** | Windows: пути бинарников `.cmd`; macOS/Linux — как Serena. Docker: `/tools` ro-mount по аналогии с `/models`. |
| **Context/token impact** | Нейтрально к пакету; при использовании инструментов — экономия grep-циклов (CodeGraph заявляет 20–100×, проверить своим замером). |
| **Benchmark** | Тот же `context-eval/` + «сколько tool calls нужно, чтобы найти всех вызывающих» на 10 задачах WITH/WITHOUT. |
| **Acceptance criterion** | При отсутствии LS — поведение идентично A2 и `system_health_check` говорит `code_intel: unavailable (reason)`; при наличии — `find_references` на fixture TS-проекте даёт 100 % известных ссылок с `coverage.may_be_incomplete=false`. |

#### A4–A7. Малые пункты

- **A4. `AnswerMetadata` как контракт.** Любой структурный ответ (граф, символы,
  память) несёт `freshness {fresh|stale|unknown}`, `evidence {exact|lower_bound|
  approximate|unavailable}`, `coverage`. Место — `src/core/answer-metadata.mjs`.
  S. Это то, что делает «partial лучше выдуманного» проверяемым.
- **A5. Context Provider Contract.** Формализовать `context-extras.mjs` по
  Continue: `{id, title, type: normal|query|submenu, dependsOnIndexing, budget}`;
  довести до обещанного ARCHITECTURE поведение с `unknown` при ошибке провайдера
  (сейчас `errors[]` теряется). S.
- **A6. `export_context_pack`.** Команда `ai-dev export-context <task_id>`
  (`scripts/ai-dev.mjs`, не MCP tool): задача, архитектура, выбранные символы и
  код, решения, релевантная память, верификации, токены. Формат — один Markdown +
  JSON с самоописывающимся заголовком (какие lossy-преобразования применены),
  secret-скан перед записью существующим `security_scan`. S.
- **A7. Индексировать исходники в dense-индекс — не делать.** Символьный индекс
  из A2 дешевле по диску и RAM, и точнее для кода; dense остаётся для vault и
  skills. Пересмотреть после бенчмарка A2.

### Инициатива B — Memory vNext

#### B1. Единая метадата памяти

| | |
| --- | --- |
| **Problem** | Три типа памяти с тремя разными схемами; ни у одной нет `source_id`, `valid_from/to`, `use_count`; `supersedes` только у решений. Нельзя ни объяснить, ни дедуплицировать, ни устареть корректно. |
| **Current behaviour** | См. таблицу 2.2. |
| **Reference** | Mnemic (`AgentMemoryRecord`: `source, sourceKey, actor, importance, confidence, observedAt, validFrom, validTo`); hurttlocker/cortex `facts` (`agent_id, session_id, project_id, state active|core|retired|superseded, superseded_by`); Graphiti (`created_at/expired_at` = transaction time, `valid_at/invalid_at` = event time). |
| **Proposed behaviour** | Общий `MemoryMeta`, добавляемый ко всем трём записям (поля опциональны, старые записи читаются): `source_type` (`task|session|commit|file|user|hook|import`), `source_id`, `source_version`, `source_key = type:id`, `actor`, `created_at`, `updated_at`, `valid_from`, `valid_to`, `supersedes`, `superseded_by`, `state`, `confidence`, `importance`, `use_count`, `last_used_at`, `trust` (`user-confirmed|agent|hook-draft|imported`). Для handoff `source_key = session:<id>` (устраняет дубли hook-draft/handoff). |
| **Architectural location** | `src/core/memory-meta.mjs` (pure: нормализация, миграция при чтении), правки в `session-memory.mjs`, `instincts.mjs`, `decision-ledger.mjs`. |
| **Dependencies** | Нет. |
| **Complexity** | M. |
| **Migration risk** | Низкий: чтение старых записей без полей; версия схемы в файле. |
| **Security** | `trust` становится механизмом, а не меткой (Д-7 ставил именно этот вопрос для skills): `trust: agent` никогда не инжектится как инструкция без ограждающего текста. |
| **Cross-platform** | Нет различий. |
| **Context/token impact** | Нейтрально (метадата не рендерится целиком). |
| **Benchmark** | Доля записей с заполненным `source_key` после недели использования; число дублей handoff на репозиторий. |
| **Acceptance criterion** | Все три writer'а ставят `source_key` и `trust`; чтение старого `instincts.json` из fixtures проходит без изменений в поведении `rankForContext`. |

#### B2. Write preview и решение ADD / UPDATE / SUPERSEDE / CONFLICT / NOOP

| | |
| --- | --- |
| **Problem** | `save_session` и `record_decision` всегда добавляют; похожие решения множатся; противоречие старой записи не замечается. |
| **Current behaviour** | Instincts: id или ≥0.75 перекрытия токенов → UPDATE; остальное — ADD. Dry-run только у `propose_instincts`. |
| **Reference** | Mnemic `previewRemember()` — план записи против клона состояния: `action, sourceKeyMatched, beforeMemory, afterMemory, diff{changedFields}, policyFindings[], warnings[]`; политика `requireSourceKey / secrets / confidence / stale` с `block|warn|info`. hurttlocker/cortex: near-dup 0.90 по Jaccard + нормализованный Levenshtein, `pickConflictWinner` (специфичность → возраст → Δconfidence ≥ 0.02 при strictly-newer). Graphiti: детерминированное `invalid_at = new.valid_at; expired_at = now()`. Mem0 v2: MD5-дедуп точных совпадений первым шагом. |
| **Proposed behaviour** | Одна pure-функция `planMemoryWrite(existing, candidate) → {action: ADD|UPDATE|SUPERSEDE|CONFLICT|NOOP, matched_by: source_key|hash|similarity, similarity, diff, findings[]}`: точный `source_key` → UPDATE; хэш содержимого → NOOP; similarity ≥ 0.9 → UPDATE; та же тема, противоречащее содержание (для decisions — тот же `tags`+объект решения, другой выбор) → SUPERSEDE, если `valid_from` новее, иначе CONFLICT с `findings`. Параметр `dry_run: true` у `record_decision`, `record_instinct`, `save_session` возвращает план без записи. Новых инструментов нет. |
| **Architectural location** | `src/core/memory-write-plan.mjs` (pure), вызовы в трёх extension'ах. |
| **Dependencies** | Нет (Levenshtein — 30 строк). |
| **Complexity** | M. |
| **Migration risk** | Низкий; поведение по умолчанию для непохожих записей не меняется. |
| **Security** | Preview показывает `findings` секрет-скана до записи (существующий сканер), а не после. |
| **Context/token impact** | Меньше дублей → меньше строк в пакете. |
| **Benchmark** | memory-eval (B7): contradiction rate, число дублей на 100 записей. |
| **Acceptance criterion** | Повторный `record_decision` с тем же `source_key` не создаёт ADR; противоречащее решение помечает старое `superseded_by` и `valid_to`; `dry_run` не пишет ни байта (проверяется fingerprint каталога). |

#### B3. Explainable recall

| | |
| --- | --- |
| **Problem** | «Почему эта память в контексте?» — ответа нет: handoff берётся по новизне, решения — 5 последних, instincts показывают только `confidence`. |
| **Reference** | Mnemic `explainRecall`: `score, lexicalScore, importanceBoost, relationBoost, matchedTerms[], matchedFields[], fieldScores, stale, reasons[]`. cdeust/Cortex `why`: каждая инъекция оставляет receipt `{channel, session_id, memory_id, rank, score, emitted_at}`; `why(receipt)` отвечает «эта память была в контексте, потому что…», явно не претендуя на причинность. |
| **Proposed behaviour** | Каждый item extras в пакете получает `{id, kind, reason[], semantic_score?, recency, importance, trust, valid_from, source_key}` (структура уже есть — `items`); `resume_session` и `list_instincts` принимают `explain: true`. Инъекция пишет receipt в ledger (`kind: "memory_injected"`), `usage_report` показывает «какие памяти инжектились и использовались» (E1). Relevance для decisions — не только recency: токены задачи × `tags`, штраф `valid_to != null`. |
| **Architectural location** | `context-extras.mjs`, `instincts.mjs:329-344`, `decision-ledger.mjs`, `usage-ledger.mjs`. |
| **Complexity** | S–M. **Migration risk** низкий. **Security** — receipts не содержат текста памяти, только id. **Token impact** — +100–300 симв. на пакет; компенсируется A1. |
| **Benchmark / Acceptance** | На 20 задачах из memory-eval каждая инжектированная память имеет непустой `reason[]`; stale retrieval rate (записи с `valid_to` в прошлом) = 0 при `as_of = now`. |

#### B4. Memory lifecycle: promote / retire / supersede, обратная связь

| | |
| --- | --- |
| **Problem** | Есть только read-time decay instincts и `prune_state` по возрасту. Нет «core»-состояния для подтверждённого, нет сигнала «эта память помогла». |
| **Reference** | hurttlocker/cortex `lifecycle/runner.go`: три независимых детерминированных политики с dry-run и skip-reasons — reinforce-promote (≥5 подкреплений и ≥3 источника → `core`), decay-retire (≥45 дней без обращения и confidence < 0.35 → `retired`), conflict-supersede. cdeust/Cortex: `confidence = useful_count / access_count` при `access_count > 3` (`rate_memory`), экспоненциальный decay `0.98^hours` с полом 0.05. Cortex-Py consolidation — кластеризация без LLM (≥3 повторов, ≥2 сессий) — у нас это уже `evolve_instincts`. |
| **Proposed behaviour** | `state: proposed|active|core|retired|superseded` в `MemoryMeta`; батч `consolidate` внутри существующего `prune_state` (dry-run по умолчанию, отчёт skip-reasons): promote при `use_count ≥ 5` и ≥3 `source_key`; retire по 45 дней/0.35; supersede по B2. `use_count`/`last_used_at` растут при инъекции (receipt из B3). Обратная связь — параметр `feedback: {memory_id, useful}` у `checkpoint_task`/`complete_task` (не новый инструмент); `confidence = useful/uses` после трёх использований. Ни одна `agent`-запись не становится `core` без `user-confirmed`. |
| **Location / Complexity** | `src/core/memory-lifecycle.mjs` (pure), `extensions/instincts.mjs`, `state-pruning.mjs`. M. |
| **Risk / Security** | Низкий; retire не удаляет файл. Принцип задания «agent-generated память не становится trusted инструкцией автоматически» закрепляется правилом промоушена. |
| **Benchmark / Acceptance** | memory-eval: stale rate и tokens per useful memory до/после; после 10 demo-сессий ни один instinct со `trust: agent` не в `core`. |

#### B5. Temporal-семантика решений

Decisions уже имеют `supersedes`; добавить `valid_from` (по умолчанию `date`),
`valid_to` (ставится на старое при supersede), `current = valid_to == null`, и
запрос `list_decisions {as_of}`. Правило — детерминированное, из Graphiti
`resolve_edge_contradictions` (`edge_operations.py:538-573`): поздно пришедший
более старый факт не инвалидирует текущий. Контекст-пакет показывает только
`current`, а `superseded` — одной строкой «заменено ADR-NNNN». S; риск низкий;
ADR-файлы остаются Markdown с frontmatter.

#### B6. Индексировать память в FTS

Добавить decisions и подтверждённые handoffs в `collect_documents`
(`search_cli.py:855-899`) с `kind: memory`, чтобы `hybrid_search` находил
«решение про PostgreSQL» по задаче, а не только последние пять. Dense — не нужно
(тексты короткие, FTS + aliases достаточно). S. Dependency — существующий
Python helper (см. Д-62: любое расширение индекса усиливает аргумент за перенос
`search_cli.py` в Node, это отдельная работа).

#### B7. memory-eval

По образцу `search-eval/`: `memory-eval/cases.json` — 40–60 кейсов
(запомнить решение, найти через N сессий, исправить устаревшее, cross-language
запрос RU→EN, противоречие, «игнорировать нерелевантное», «предпочесть
user-confirmed»). Формат кейса и формулы — из отчёта по Mem0/Graphiti:
`gold_relevant_ids`, `gold_stale_ids`, `retrieved[]`, метрики Recall@k, MRR,
precision@k, stale retrieval rate, contradiction rate (по `source_key` и
`valid_at`), tokens per useful memory. Без LLM-judge (как `mnemic eval`).
Инструмент — `run_memory_eval` в профиле `qa` (единственный новый MCP tool во всей
инициативе B) или флаг у `run_search_eval`. S–M.

### Инициатива C — Adaptive Lifecycle

#### C1. Детерминированная проверка определённости и `clarifications`

| | |
| --- | --- |
| **Problem** | «Сделай авторизацию» проходит `begin_task` так же, как «исправь опечатку». `plan_policy` оценивает сложность, но не неоднозначность. |
| **Current behaviour** | Обязателен только непустой `task`; `context_unknowns` ничего не gate-ит; `plan_task` требует overview + фазы + шаги с risk. |
| **Reference** | Spec Kit `/clarify` (MIT): таксономия из 9 категорий (functional scope, domain/data, UX, non-functional, integrations, edge cases, constraints, terminology, completion signals), очередь по Impact × Uncertainty, **не более 5 вопросов**, формат «Question + Recommended option + таблица вариантов», ответы дописываются в `## Clarifications / Session <date>` сразу после каждого. У Spec Kit всё — prompt-driven; детерминированных проверок нет. |
| **Proposed behaviour** | Pure-скоринг в `begin_task`, **сначала escape hatch**: паттерн typo/rename/copy-edit → score 0, без вопросов. Затем сигналы: расплывчатый глагол без объекта +2; нет объекта действия +2; ≥2 подсистем проекта совпадают с ключевыми словами одинаково +2; нет проверяемого критерия («должен», «когда… тогда», «возвращает») +1; `plan_required` +2; касание auth/payments/billing/migrations/`*.sql` +3. Порог 4 → `clarification: {needed: true, questions: [{id, category, question, recommended, options[]}]}` в ответе и записи задачи. Малые задачи — ноль накладных. Ответы — через `checkpoint_task {clarifications: [{id, answer}]}` или `plan_task`; пока есть `pending`, `complete_task` отказывает (это же — human-in-the-loop из LangGraph, без нового состояния). Для `large` задач — `acceptance criteria` дополняются из ответов. |
| **Location** | `src/core/task-clarity.mjs` (pure), `task-lifecycle.mjs`, `task-plans.mjs`. |
| **Complexity / Risk** | M / низкий (новые поля, старые записи без них = «не требовалось»). |
| **Security / Platform** | Нейтрально. |
| **Token impact** | +0.3–1 KB только для задач выше порога. |
| **Benchmark** | Набор из 60 формулировок задач (RU/EN) с разметкой «нужно уточнение / нет»; false-block rate на typo-классе = 0; precision ≥ 0.8. |
| **Acceptance criterion** | «fix typo in README» → `needed:false`; «сделай авторизацию» → ≥2 вопроса с рекомендованным вариантом; `complete_task` с pending-вопросом отказывает с `next_step`. |

#### C2. Analyze-проверка на verify: критерии ↔ дифф

По образцу `/analyze` (read-only, таблица `ID | Category | Severity | Location |
Summary | Recommendation`, ≤50 строк): на `verify_task` сравнивать текст
критериев и `clarifications` с реальным диффом — тронут `auth/`, не упомянутый в
задаче (это же сигнал scope explosion из D1); критерий без затронутого файла;
`changed_files` в checkpoint, не совпадающие с git. Результат — check-тип
`consistency` со статусом `warn` (не блокирует), список findings. Место —
`task-verification.mjs` + `change-hygiene.mjs`. S–M.

### Инициатива D — Verification vNext

#### D1. Trajectory sanity (детерминированно)

| | |
| --- | --- |
| **Problem** | Проверяется только состояние репозитория. Агент, пять раз запускающий одну падающую команду или десять раз переписывающий один файл, не получает сигнала до `complete_task`. |
| **Current behaviour** | Ledger хранит `tool, ok, duration_ms`; ни аргументов, ни файлов, ни результата. Никаких проверок поведения. |
| **Reference** | OpenHands SDK `stuck_detector.py`: окно 20 событий с момента последнего сообщения пользователя; повтор action+observation ×4; action+error ×3 → nudge, ×4 → stop; монолог ×3; чередование A-B-A-B ×6; равенство — по семантическим полям без id/метрик; при stuck — статус, не исключение. `max_iterations` 500, бюджет — opt-in. Детерминированные критики `EmptyPatchCritic`/`AgentFinishedCritic` (у нас эквивалент — fingerprint + обязательная верификация). |
| **Proposed behaviour** | (1) Ledger записывает `args_hash`, `result_hash`, `files_touched[]`, `bytes_in/out`, `session_id` (E1). (2) Pure-модуль `trajectory-checks.mjs` над последними 20 записями задачи: `loop` (4 одинаковых `(tool,args_hash,result_hash)`), `repeated_failure` (3 → nudge в ответе инструмента, 4 → check `fail`), `file_thrash` (>5 разных правок одного файла), `scope_explosion` (файлов в диффе > max(5, 3× baseline) или каталоги вне seed-набора A2), `verification_gap` (правки после последнего `verify_task` — уже ловится fingerprint при complete; здесь — nudge на checkpoint), `churn` (net/gross < 0.3). (3) Выход — check-тип `trajectory` в `verify_task` (сначала `warn`, через релиз — `block` для `loop`/`repeated_failure`) и подсказка в `stop-check.mjs`. (4) LLM-критик — не сейчас; интерфейс `VerificationProvider` оставить открытым. |
| **Location** | `src/core/trajectory-checks.mjs`, `usage-ledger.mjs`, `task-verification.mjs`, `hooks/stop-check.mjs` (копия логики, как с identity — правило 3 из AGENTS.md). |
| **Dependencies** | Нет. **Complexity** M. |
| **Migration risk** | Низкий; новые поля ledger опциональны, старые строки читаются. |
| **Security** | `args_hash` — sha256 нормализованных аргументов, аргументы не хранятся; `files_touched` — пути, не содержимое. |
| **Platform** | Нет различий; в Docker ledger в `/data`. |
| **Token impact** | Nudge ≤ 200 символов; экономит повторные циклы. |
| **Benchmark** | На 10 записанных demo-траекториях: число ложных срабатываний = 0; на 5 синтетических «зациклившихся» — 5/5 обнаружений в пределах 4 повторов. |
| **Acceptance criterion** | Четыре одинаковых падающих `run_quality_gate` подряд → `verify_task.checks.trajectory.status = fail` с указанием команды и советом; обычная demo-задача — `pass`. |

### Инициатива E — Local Agent Flight Recorder

#### E1. Расширить ledger до трассы задачи

| | |
| --- | --- |
| **Problem** | Нельзя ответить «AI Dev сделал агента лучше или просто заставил сделать ещё 30 вызовов». |
| **Current behaviour** | `events.jsonl` с `at, tool, ok, duration_ms, task_id, project_path, error`; `client` пуст, session id нет, размеров нет; таймлайна задачи нет. |
| **Reference** | AgentOps (MIT): словарь атрибутов — `agentops.span.kind`, `tool.name|status|parameters|result`, `gen_ai.usage.*` (OTel GenAI), сессия как корневой span с `end_state`; **offline-экспортёра нет**, cost считается на сервере — интегрировать нечего, брать только схему. LangGraph: `CheckpointMetadata {source, step, parents}`. |
| **Proposed behaviour** | Тот же `events.jsonl`, поля по OTel-именам: `span.kind` (`tool|search|verify|checkpoint|memory_injected`), `session_id`, `client`, `bytes_in`, `bytes_out`, `args_hash`, `result_hash`, `files_touched`, для поиска — `backend, candidates, selected, latency_ms`, для верификации — `check, status`. `get_task {include_trace: true}` рендерит таймлайн (как в примере задания). Без сырых промптов и аргументов; санитизация — существующий секрет-скан на строковых полях. Хранение — `~/.ai-dev/state/usage/` с текущим prune 8 MiB / 20 000 строк. |
| **Location / Complexity** | `usage-ledger.mjs`, `mcp-stdio.mjs:4776-4795` (callTool), `search-index.mjs`, `extensions/usage.mjs`. S–M. |
| **Risk / Security / Platform** | Низкий; хэши вместо содержимого; в Docker — тот же volume. |
| **Token impact** | Нулевой для агента (в ответы не попадает, кроме `include_trace`). |
| **Benchmark / Acceptance** | Главный бенчмарк задания «WITH vs WITHOUT» становится вычислимым из ledger: tool calls, bytes, время, verification failures, unnecessary changes. Критерий: `usage_report` показывает per-task bytes_out и p95 по инструментам; `get_task include_trace` на demo-задаче даёт последовательность begin → context → skills → checkpoint → verify → complete с длительностями. |

### Инициатива F — Durable Execution

#### F1. Checkpoint как единица восстановления

Запись задачи **уже** хранит почти всё из «TaskCheckpoint» задания: контекст,
файлы с sha256, skills, план, критерии, verifications, snapshot refs. Чего нет:
связи checkpoint ↔ snapshot ref ↔ verification id (LangGraph: `parentConfig`,
`source: input|loop|update|fork`, `pendingWrites`), `last_activity_at`,
признака прерывания и межпроцессной блокировки записи. Предложение:
`checkpoints[]` получает `{snapshot_ref, verification_id?, context_fingerprint,
source: agent|rollback|clarify}`; `last_activity_at` обновляется каждым вызовом;
`resume_session` (существующий) показывает «Task T interrupted at C3, last
verification FAILED, changed files…, rollback available» — это уже 80 % данных,
не хватает только связей. Межпроцессная блокировка — `wx`-lock файл рядом с
записью (как в daemon). S–M; риск низкий. Time travel = `rollback_task` — есть.
Новых инструментов нет.

### Инициатива G — Execution Abstraction

#### G1. Интерфейс `ExecutionBackend` (без рефакторинга)

Из SWE-ReX (MIT) переносится только форма: разделение «provisioning»
(`start/stop/isAlive`) и «execution» (`execute({argv, cwd, env, timeoutMs}) →
{stdout, stderr, exitCode, timedOut}`, `readFile`, `writeFile`, `capabilities()`).
Сессии с PS1/pexpect, FastAPI-рантайм, Docker/Modal/Fargate-деплойменты — не
нужны, у нас нет shell. `LocalExecutionBackend` оборачивает `process-runner`
без изменения поведения; новые вызовы идут через интерфейс, старые — переводятся
по мере правок. Политика `trusted → local`, `unknown → Docker`, `untrusted →
hardened provider` — будущий plugin interface; E2B (Apache-2.0) — клиент
cloud-API, self-hosting только через отдельный `e2b-dev/infra`, в default path
не попадает. S для интерфейса; риск нулевой, пока это обёртка. Attribution:
упомянуть SWE-ReX в doc-комментарии интерфейса.

### Reference-проекты: что подтверждают

- **Cline** — checkpoints теперь тоже через приватные refs
  (`refs/cline/checkpoints/<session>/<run>`) с трёхродительским stash-коммитом и
  transactional restore; наша модель `refs/ai-dev/snapshots/` — та же идея.
  Полезно: `restore: task | workspace | both` как словарь для `rollback_task`.
- **Roo Code** — `groups` с `fileRegex` на режим (architect редактирует только
  `*.md`). У нас профили + `policy.json rules`; идея «ограничение записи по
  профилю» реализуема правилом guard без новой сущности.
- **Continue** — `IContextProvider {type, dependsOnIndexing, getContextItems}`,
  `ContextItem {content, name, description, uri}` — см. A5.

---

## 5. Матрица влияния

Обозначения: `0` — нет, `+` — растёт незначительно, `++` — заметно, `−` — снижается.

| Proposal | Tool count | Context tokens | Startup | RAM | Disk | Install | Win | Linux | macOS | Docker | Local-first | Security model |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 budgets | 0 | **−−** | 0 | 0 | 0 | 0 | ok | ok | ok | ok | ok | нейтрально |
| A2 compiler v2 | 0 | − (при том же бюджете больше пользы) | + (WASM lazy) | + (≈20–40 MB при парсинге) | + (WASM 10–20 MB, кэш тегов) | + (npm-зависимости) | ok | ok | ok | ok | ok | WASM без сети |
| A3 LSP | 0…+2 | 0 | 0 (по требованию) | ++ (LS-процессы 100–500 MB) | ++ (бинарники) | ++ (внешние бинарники, опционально) | `.cmd` пути | ok | ok | только mount | ok, опция | argv + allowlist |
| A4 metadata | 0 | + | 0 | 0 | 0 | 0 | ok | ok | ok | ok | ok | нейтрально |
| A5 providers | 0 | 0 | 0 | 0 | 0 | 0 | ok | ok | ok | ok | ok | нейтрально |
| A6 export | 0 (CLI) | 0 | 0 | 0 | + (файлы экспорта) | 0 | ok | ok | ok | ok | ok | secret-скан |
| B1–B5 memory | 0 | ± | 0 | 0 | 0 | 0 | ok | ok | ok | ok | ok | trust становится механизмом |
| B6 index | 0 | 0 | + (rebuild) | 0 | + | 0 | ok | ok | ok | ok | ok | нейтрально |
| B7 eval | +1 (`qa`) | 0 | 0 | 0 | + | 0 | ok | ok | ok | ok | ok | нейтрально |
| C1–C2 lifecycle | 0 | + для сложных | 0 | 0 | 0 | 0 | ok | ok | ok | ok | ok | нейтрально |
| D1 trajectory | 0 | + (nudge) | 0 | 0 | + (ledger) | 0 | ok | ok | ok | ok | ok | хэши, не аргументы |
| E1 ledger | 0 | 0 | 0 | 0 | + (ledger ≤ 8 MiB) | 0 | ok | ok | ok | ok | ok | без промптов |
| F1 checkpoints | 0 | 0 | 0 | 0 | 0 | 0 | lock-файл | ok | ok | ok | ok | нейтрально |
| G1 backend | 0 | 0 | 0 | 0 | 0 | 0 | ok | ok | ok | ok | ok | без изменений |

Ни один proposal не добавляет cloud-зависимость в default path и не ломает
нейтральность клиентов: все изменения — на стороне сервера и в записях, а хуки
(единственная клиент-специфичная часть) затрагиваются только копией логики
`stop-check` для D1. Суммарный прирост MCP-инструментов — от 1 до 3, при этом A1
уменьшает объём контекста больше, чем всё остальное добавляет.

---

## 6. Лицензии и attribution

| Проект | Лицензия | Что можно | Что потребует записи в `THIRD_PARTY_NOTICES.md` |
| --- | --- | --- | --- |
| Aider | Apache-2.0 | Переписать алгоритм | Копия `.scm`-запросов или кода — notice + NOTICE об изменениях |
| Repomix | MIT | Идеи, формат | Дословный код (parse strategies) — notice |
| Serena | `src/solidlsp` MIT; `src/serena` **GPL-3.0-or-later** | LSP-слой — с notice; инструменты/промпты/YAML — **только идеи, не код** | Любой перенос из `src/serena` недопустим без смены лицензии проекта |
| CodeGraph | MIT OR Apache-2.0 | Идеи и код | Дословный код — notice |
| SWE-agent, mini-swe-agent, SWE-ReX | MIT | Формулировки, интерфейс | Дословные шаблоны сообщений — notice; SWE-ReX — упомянуть в doc-комментарии `ExecutionBackend` |
| Mnemic, hurttlocker/cortex, cdeust/Cortex | MIT | Схемы, формулы | Near-verbatim `pickConflictWinner`, `compute_decay` — комментарий с источником |
| Spec Kit | MIT | Таксономия, формат вопросов | Дословные куски `clarify.md`/`checklist.md` — notice; не переносить бренд `speckit.*` |
| OpenHands SDK | MIT | Пороги, структура детектора | Комментарий у портированных порогов |
| AgentOps, LangGraph.js, Cline, Roo Code, Continue | MIT / MIT / Apache-2.0 / Apache-2.0 / Apache-2.0 | Схемы, словари атрибутов | Дословный код — notice |
| Graphiti, Mem0 | Apache-2.0 | Правила supersession, формат eval | Дословные промпты/код — notice |
| E2B | Apache-2.0 | Форма API | — |

Все proposals выше сформулированы как **реимплементация идей**; ни один не
требует переноса кода. Если при реализации кусок всё же копируется, формат записи
в `THIRD_PARTY_NOTICES.md` — `## <package>` + Source / Included revision / License /
License text.

---

## 7. Дефекты, найденные попутно (кандидаты в `docs/DEFECTS.md`)

По правилу AGENTS.md дефект записывается с измерением; здесь — наблюдения с
адресом, измерение сделать при заведении Д-72+:

1. **Черновик хука перекрывает подтверждённый handoff.** «Самый новый» выбирается
   без учёта `confirmed`; Stop-hook пишет `hook-<id>.json` после `save_session`,
   а `session-start.mjs:15-21` сортирует по имени, где `hook-` > `2026…`. Тесты
   не смешивают оба вида.
2. **Порог импорта instincts (0.7) равен порогу инъекции (`>=`)** —
   импортированная память попадает в контекст сразу (`instincts.mjs`).
3. **Instincts инжектятся как императив** без ограждения, в отличие от handoff
   (`context-compiler.mjs:398`, `hooks/lib.mjs:75-82`).
4. **Ошибки провайдеров extras теряются**: `errors[]` не читается
   (`context-compiler.mjs:289`), обещание ARCHITECTURE о записи `unknown` не
   выполнено.
5. **ARCHITECTURE.md:444** описывает `.ai-dev/context/<task-id>.json`, который
   никто не пишет; реальный путь — `.ai-dev/context/packs/<id>.json`.
6. **`project_map` в пакете** режется, но не рендерится (`context-compiler.mjs`).
7. **Дублирующийся шаг лестницы переполнения** (`extras → 400` дважды,
   `context-compiler.mjs:317-350`).
8. **`import-graph.mjs` не участвует в отборе файлов**, хотя пакет советует
   «прочитать соседние зависимости».
9. **Ledger: `client` никогда не заполняется**, `session_id` отсутствует
   (`usage-ledger.mjs:437-449`).
10. **Результат дублируется в `structuredContent`** (`server.mjs:292-306`) —
    wire-размер ×2 без задокументированной причины.
11. **Блокировка записи задачи только внутрипроцессная** — daemon с несколькими
    сессиями одного проекта может потерять запись.
12. **Документация профилей называет bare-размер схемы** (15 KB), wire — 22 KB
    (`CAPABILITIES.md:68-73`).

---

## 8. Порядок работ и бенчмарки

Сначала измерение, потом изменение — как требует задание.

**Шаг 0 (до любого кода): базовые замеры.** E1 в минимальной форме
(`bytes_in/out`, `session_id`, `args_hash`) + скрипт `ai-dev bench` для прогона
demo-задачи и трёх задач на реальном репо WITH/WITHOUT сервера. Фиксируются:
tool calls, bytes, время, verification failures, файлов изменено, размер
контекста. Без этого шага ни один из proposals нельзя принять или отклонить.

**Затем, в порядке ROI:**

1. **A1** — response budgets. Самый дешёвый выигрыш по токенам, и он делает все
   последующие добавления к ответам (reason, coverage, clarifications) бесплатными
   по бюджету.
2. **A5 + A4** — контракты провайдеров и metadata. Маленькие, закрывают дефекты 4–7.
3. **B1 + B2 + B5** — метадата, write-plan, temporal у decisions. Закрывают
   дефекты 1–3.
4. **A2** — Context Compiler v2 с `import-graph` и tree-sitter WASM. Самая
   большая техническая итерация; бенчмарк `context-eval/`.
5. **C1** — clarity gate; **D1** — trajectory checks. Оба — pure-модули над уже
   существующими данными, после E1.
6. **B3 + B4 + B7** — explainable recall, lifecycle, memory-eval.
7. **F1 + G1** — связи checkpoint'ов и интерфейс backend'а; малые.
8. **A3** — LSP-адаптер, только после того как A2 показал, что текстового графа
   недостаточно на бенчмарке.
9. **A6** — export.

**Бенчмарки, которые должны существовать до merge соответствующего шага**

| Область | Метрики | Набор |
| --- | --- | --- |
| Context | Recall@k файлов и символов, precision, tokens per task, latency | `context-eval/` (новый, 30–50 кейсов на 2–3 репо) |
| Memory | Recall@k, MRR, precision, stale rate, contradiction rate, tokens per useful memory | `memory-eval/` (новый, 40–60 кейсов) |
| Tools | avg/p95 output bytes, calls per task, failed/repeated calls | ledger + `usage_report` |
| Lifecycle | tasks completed, false completion blocked, false-block rate (C1, D1), verification loops, recovery success | demo + синтетические траектории |
| Главный | WITH vs WITHOUT: success, tokens, time, tool calls, verification failures, unnecessary changes, context size | `ai-dev bench` на одной задаче / одной модели / одном репо |

**Что не делать — подтверждено исследованием.** Свой Language Server (Serena
показывает цену: 74 адаптера и 3 300 строк клиента), свой graph database
(CodeGraph — 15 000 строк Rust ради того, что LSP отдаёт бесплатно), LLM-критик
и LLM-конденсер как обязательные (OpenHands держит их за флагами, а два
работающих критика — детерминированные), cloud-трейсинг (AgentOps не умеет
писать в файл), spec-pipeline для всех задач (Spec Kit сам ограничивает
уточнения тремя маркерами и пятью вопросами).

Позиционирование задания — «local development control plane for AI coding
agents» — исследование подтверждает: ни один из восемнадцати проектов не
объединяет контекст, память, lifecycle, верификацию и откат в одном локальном
слое; каждый силён в одной подсистеме, и именно поэтому перенос — идей, не кода —
даёт больше, чем интеграция любого из них целиком.
