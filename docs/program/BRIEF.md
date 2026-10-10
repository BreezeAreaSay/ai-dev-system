# Бриф: программа «одна команда + exe» для ai-dev-system — выполнить целиком в одной сессии

Ты — исполнитель всей программы работ (15 фаз) над репозиторием `BreezeAreaSay/ai-dev-system`.
Владелец может быть недоступен. Решения уже приняты (раздел 4), поэтому не жди ответов: действуй
по брифу и записывай отступления. Всё, что ниже, — результат разбора от 2026-10-06. Повторять
разбор не нужно, но каждое число перед опорой на него перемерь у себя: окружение могло измениться.

## 0. Как работать с этим брифом

- **Первое действие.** Сохрани этот текст дословно в `docs/program/BRIEF.md`, заведи
  `docs/program/PROGRESS.md` (раздел 7), закоммить и запушь.
- **После сжатия контекста.** Каждый раз, когда контекст был сжат, перечитай `BRIEF.md`,
  `PROGRESS.md` и описание последнего PR, прежде чем продолжать.
- **Если сессия кончится раньше программы.** Следующая сессия продолжит по этому же брифу с фазы,
  указанной в `PROGRESS.md`. Держи `PROGRESS.md` в актуальном состоянии после каждого шага.

## 1. Цель (слова владельца)

«Проект хороший, но в нём очень много костылей. Он до сих пор не разворачивается без костылей, ни
у кого не запускается локальная модель без влезания в проект. Всё должно заводиться просто по
вводу команды. Хочу оформить его в виде exe-файла с полной возможностью управления через фронт.»

Что это значит на практике:

1. **Разработчик на любой ОС** с Node ставит систему одной командой — `npx <пакет> setup` — и
   получает настроенные MCP-клиенты.
2. **Пользователь Windows** скачивает установщик, ставит его без прав администратора и всё делает
   в интерфейсе: мастер, модель, клиенты, статус, проекты, настройки. Терминал не нужен.
3. **Локальная модель (BGE-M3)** ставится одной кнопкой или командой: с докачкой, зеркалами,
   прокси, прогрессом и без Python.
4. **Прод не ломается.** Установки 2.x после обновления продолжают работать или мигрируют сами.

## 2. Репозитории, ветки, прод

- **Прод — `stonebridgeway/ai-dev-system`.** Его `main` и образ
  `ghcr.io/stonebridgeway/ai-dev-system` — то, чем пользуются люди. Владелец прода — тот же
  человек. Каждый пуш в `main` прода сразу публикует `:latest` (Д-108).
- **Рабочий форк — `BreezeAreaSay/ai-dev-system`.**
  - `main` форка синхронизируется с продом через «Sync fork».
  - `Dev` — интеграционная ветка программы. Она создана 2026-10-06 от `main` @ `8f647df`.
- **Вся работа идёт в форке.** В прод — ничего: ни пушей, ни веток, ни PR, ни публикаций.
  Выкатку в прод выполняет владелец по плану из фазы 15.
- **CI форка не стартует.** Все джобы падают за 2–10 секунд без логов (замер на прогонах
  2026-10-01).
- **CI прода на PR работает** (по реестру: Д-70, Д-71). Владелец может открыть черновой PR
  `форк:Dev → прод:main` как CI-зонд. Это безопасно: джоб `publish` в
  `.github/workflows/docker-publish.yml` пропускается на pull_request
  (`if: github.event_name != 'pull_request'`), а PR из форка не получает секретов. Сам ты такой PR
  не открываешь. Если он открыт и тебе доступен — используй его результаты.

## 3. Контекст: что установлено разбором

### 3.1 Что это за проект

**Сервер.** Локальный MCP-сервер для AI coding agents: `ai-dev-mcp-server/`, Node.js ESM.
- 134 инструмента в 8 профилях: core 25, coding 18, memory 16, git 9, frontend 13, qa 8,
  security 8, advanced 36.
- Жизненный цикл задачи: `begin_task → checkpoint_task → verify_task → complete_task`, с линтером
  отчёта о завершении.
- Маршрутизация по 3 228 skills. Источник — seed `docker/public-seed`: 4 189 файлов, около 40 МБ,
  из них 3 075 — skills Membrane.

**Поиск.** Гибридный: SQLite FTS плюс опциональная локальная модель BGE-M3 int8 ONNX
(`Xenova/bge-m3` @ `4de13258303883538bd53b696b452bf8099f0858`). Модель — 5 файлов, около 542 МБ,
скачиваются с huggingface.co. Манифест — `ai-dev-mcp-server/models/bge-m3.manifest.json`.

**Хуки.** Копируются в репозитории пользователей (`ai-dev-mcp-server/hooks/`) и намеренно дублируют
логику сервера — правило 3 AGENTS.md.

**Docker и упаковка.**
- Образ: node:24-bookworm-slim + python3 + Playwright Chromium + xvfb + gitleaks.
- Скрипты установки и запуска: `bootstrap.sh`, `bootstrap.ps1`, `docker/run-mcp.sh`,
  `docker/run-mcp.ps1`, `docker/ClaudeMcpProxy.cs`, `docker/entrypoint.sh`.
- Заготовки brew и AUR (`packaging/`) не опубликованы.

**Наследие.** Проект вырос внутри Obsidian-хранилища с раскладкой `09-mcp/…` и Codex desktop
runtime.

**Объём кода.**
- src без тестов — 46,5 тыс. строк; тесты — 26,5 тыс.; scripts — 5,6 тыс.; hooks — 3 тыс.
- Python — 2,6 тыс. (`search-index/search_cli.py` — 1 820 строк, `embeddings/*.py`).
- Лаунчеры sh/ps1/C# — 1,4 тыс.; документация — 14 тыс.
- `src/mcp-stdio.mjs` — 4 914 строк при `SYSTEM_LINE_CEILING` 5 076.
- `MODULE_LINE_CEILING` = 800; закреплены исключения `frontend-product-quality.mjs` (1 222) и
  `reference-factory.mjs` (812).
- Реестр `docs/DEFECTS.md`: Д-1…Д-84, открыты Д-2 и Д-62.

### 3.2 Замеры

Песочница: Linux, Node 22.22.0, чистый клон `Dev`, пустой HOME.

| Что | Результат |
|---|---|
| `npm ci --ignore-scripts` | 11 с, 136 пакетов, node_modules 511 МБ. onnxruntime-node — 288 МБ с бинарниками всех ОС (win32: 134 МБ, из них x64 — 64 МБ; darwin — 86 МБ; linux — 69 МБ). onnxruntime-web — 141 МБ, в Node не нужен. @img (sharp) — 28 МБ |
| `npm run setup`, Python есть | 20 с, 4 шага, Health ok по всем 22 проверкам |
| `npm run setup` без Python в PATH | `✗ Search index: spawn python3 ENOENT`; Health fail, 4 критичные проверки (search_index_file, search_index_freshness, search_smoke, hybrid_smoke_no_dense) |
| `npm install` без `--ignore-scripts` | exit 1: postinstall onnxruntime-node идёт на api.nuget.org за CUDA |
| то же, плюс `ai-dev-mcp-server/.npmrc` со строкой `onnxruntime-node-install=skip` | exit 0 за 13 с, onnxruntime-node грузится; перегенерированный lockfile короче на 328 строк, дублей 0 |
| `npm run setup -- --dense` | huggingface.co закрыт (403); шаг «Dense vectors» уходит на legacy-путь: `spawn …/embeddings/.venv/bin/python ENOENT` |
| `npm run setup -- --frontend-qa` | пишет ✓, но `doctor` → degraded: «Chromium binary is missing» |
| `npm run check` | 45 с: 1 248 тестов, 1 232 прошли, 0 упали, 16 пропущены; покрытие строк 97,22 % |
| MCP `initialize` | 346 мс; `instructions` — 1 048 символов |
| Схема `tools/list` (JSON.stringify) | все — 137 536 байт; core — 22 843; core,git — 32 716. Документация: ~99, ~15 и ~22 КБ, а README называет 15 КБ для core,git |
| `recommend_skills` | 150–330 мс. «добавить авторизацию в API» → feature-builder, application-security-reviewer, secrets-dependencies-auditor; на английском результат тот же |
| `search_all` | 70 мс на тёплом индексе; первый запрос после изменений — 7,8 с (перестройка индекса) |
| `hybrid_search` | ~0,42 с (два spawn Python на запрос: status и search) |
| `search_knowledge` | ~2,5 с: читает все .md хранилища на каждый вызов |
| `npm run demo` | 2 с, отрабатывает полностью |
| Путь с кириллицей и пробелами (Linux) | setup и сервер работают |
| RSS простаивающего stdio-сервера | ~86 МБ |
| `atomicAppendFile`: 3 процесса × 200 записей | 210, 203 и 210 строк из 600; один процесс — 600 из 600 |
| Демон | по Unix-сокету отвечает на MCP. При пути сокета 115 байт создаёт обрезанный сокет `ai-d` и падает (ENOENT на chmod). Мост для клиентов отсутствует |
| `AI_DEV_HOME=/x/.ai-dev` | данные уходят в `/x/.ai-dev/.ai-dev/…` |
| `search_cli.py dense-plan` | eligible 3 445 из 3 445 — Membrane не исключается |
| Ubuntu 24.04 (контейнер): `apt-get install -s docker.io docker-compose-plugin` | «Unable to locate package docker-compose-plugin»; в репозитории есть `docker-compose-v2` |
| Синтетическая ONNX-модель через настоящий воркер (transformers 4.3.0 + onnxruntime-node 1.30) | загрузка 0,256 с, векторы нормированы — API совместим |
| `node:sqlite` в Node 22.22 (SQLite 3.50.4) | FTS5 работает, кириллица ищется; при импорте печатается ExperimentalWarning |
| `package-lock.json` | 6 дублирующихся ключей (строки 70/150, 85/167, 100/179, 106/185, 123/202, 138/217) — след склейки Dependabot #70 и #71. `npm ci` это терпит, `npm ls` показывает корректное дерево |

### 3.3 Факты из кода (прочитано, не исполнялось)

**Поиск и Python**
- Поиск ходит через `search_cli.py`, интерпретатор выбирает `pythonCommand()`
  (`src/mcp-stdio.mjs:1833`); точка вызова — `runSearchCli` в `src/core/search-index.mjs:109`.
- Без Python отказывают 10 из 13 поисковых инструментов, `prepare_project` и
  `refresh_project_memory`.
- `query_ui_ux_knowledge` запускает вендорный `search.py`.

**Установщики клиентов**
- Локальный (`scripts/install-local-mcp-clients.mjs`): 4 клиента (Cursor, Gemini, VS Code,
  Claude Code), имя сервера `ai-dev-system`. На строке 58 прописывает `AI_DEV_PYTHON=python3` даже
  на Windows.
- Docker-установщик (`scripts/install-docker-mcp-clients.mjs`): Codex, Cursor, Gemini, VS Code,
  Claude (Claude Code + Claude Desktop, включая Store-версию), имя `ai-dev`.
- README велит править JSON руками, а про `clients:install` нигде в документации нет ни слова.

**Docker-лаунчеры**
- `docker/ClaudeMcpProxy.cs:76` монтирует `AI_DEV_MODEL_PATH` в `/models/bge-m3`, хотя
  sh/ps1-лаунчеры монтируют его в `/models`, а образ ищет модель в `/models/bge-m3-onnx`.
  Прокси компилируется у пользователя через csc.exe из .NET Framework 4 (`bootstrap.ps1:115-136`),
  без подписи, и в CI не собирается.
- Тёплый `docker/run-mcp.sh` (строки 41–53) и ClaudeMcpProxy сами отвечают на `initialize`: JSON
  разбирается через grep/sed/regex, настоящий ответ сервера выбрасывается, версия «2.0.0»
  прописана литералом (строка 50). В итоге `instructions` до клиента не доходят.
- На Windows тёплого контейнера нет: `AI_DEV_RUNTIME_CONTAINER` пишется только при `!windows`,
  поэтому каждая сессия — холодный `docker run`.
- `bootstrap.sh` монтирует весь `$HOME` на запись в контейнер `node:24`, чтобы записать конфиги
  клиентов. `bootstrap.ps1` вместо этого ставит Node на хост через winget.
- `--install-prerequisites` требует перезапусков: перелогин на Linux, новый терминал на macOS,
  запуск от администратора и новое окно на Windows.
- `entrypoint.sh:24` копирует seed командой `cp -a -n`, поэтому обновлённые файлы seed в
  существующий том не попадают.
- `scripts/docker-bootstrap.mjs` никогда не строит векторы документов, а в контейнере
  (`--network none`) веса не скачать. Значит, для модели в Docker нужен локальный путь на хосте.

**Состояние и запись**
- `src/core/runtime-home.mjs:30-32` дописывает `.ai-dev` к `AI_DEV_HOME`, а документация и
  Dockerfile (`AI_DEV_HOME=/data/runtime-home/.ai-dev`) считают его самой папкой. Домашнюю папку
  по-разному вычисляют `dense-onnx.mjs:275`, `scripts/first-run.mjs:112`, `project-identity.mjs`
  и `hooks/lib.mjs`.
- `src/core/atomic-files.mjs:107` (`atomicAppendFile`) перечитывает весь файл и делает rename;
  порядок записей держит очередь только внутри одного процесса. Так пишутся журнал использования
  и заметки знаний. JSON-хранилища (instincts, skill-outcomes, pilots, sessions) работают по схеме
  read-modify-write.
- Хуки регистрируются как голый `node .ai-dev/hooks/<script>` (`src/core/agent-hooks.mjs:149`).
  `hooks/lib.mjs` копирует около 22 функций сервера (идентичность проекта и др.). В Docker-режиме
  хуки пишут в `~/.ai-dev/state` хоста, а сервер — в `/data`.

**Демон и протокол**
- Демон (`src/daemon.mjs`, `src/transport/socket.mjs`):
  - нет моста для клиентов, нет stop/status;
  - `daemon.json` записывается один раз, поэтому в нём всегда `sessions: 0`;
  - на Windows pipe называется предсказуемо (`\\.\pipe\ai-dev-<user>`) и создаётся с правами
    libuv по умолчанию;
  - тестов нет.
- `start:legacy` — вторая, рукописная реализация JSON-RPC в `mcp-stdio.mjs` (протокол 2024-11-05),
  её ничто не тестирует.

**Прочее**
- Фильтр Membrane ищет путь `membrane/application-skills` (`search_cli.py:350`,
  `mcp-stdio.mjs:4553`, `collectMembraneSkills` на строке 602), а в seed лежит
  `external/membrane/skills`.
- Около 45 переменных `AI_DEV_*`/`BGE_*`.
  - Папку модели задают пятью способами.
  - `BGE_M3_PYTHON` и `AI_DEV_EMBEDDINGS_PYTHON` — синонимы.
  - `AI_DEV_RUNTIME_CONFIG` описан в документации, но не читается.
  - Есть запасной путь в `~/.codex` (`mcp-stdio.mjs:221-226`), которого нет у хуков.
- Наследие Codex runtime: `~/.cache/codex-runtimes` в `scripts/*.ps1`.
- `backup`, `restore` и `run-acceptance` написаны только на PowerShell и работают только внутри
  полного хранилища.
- Способов запустить сервер — 13: `npm start`, `dev`, `start:legacy`, `ai-dev.mjs start`,
  `start-local.ps1`, `daemon`, `run-mcp.sh` (холодный и тёплый), `run-mcp.ps1`,
  `ClaudeMcpProxy.exe`, compose, пример конфига, лаунчер brew/AUR.
- Дублирование: флаги `docker run` — в 8 местах, проверка пути модели — в 4 (плюс расходящаяся
  пятая), установщиков клиентов 2, раннеров acceptance 3.
- `--frontend-qa` (`scripts/first-run.mjs:83`): `spawn("npm"/"pnpm")` без обёртки (на Windows
  ENOENT); без pnpm — `npm install` мимо lock; Chromium не ставится.
- Дашборд: 8 из 10 строк «Ready» зашиты в код (`src/core/system-dashboard.mjs:84-91`). На клоне без
  setup он, по словам субагента, падает со stack trace — не перепроверено.
- Зависимости модели.
  - transformers 4.3.0 закрепляет onnxruntime-node 1.30.0 точной версией и тянет
    onnxruntime-web 1.31.0-dev.
  - Он сам требует `sharp ^0.35.4`, поэтому override sharp в `package.json` лишний.
  - transformers статически импортирует sharp.
  - transformers 3.7.5→4.3.0 и onnxruntime-node 1.21→1.30 подняты 2026-09-28, уже после
    единственного живого прогона с весами (macOS, 2026-09-15).
  - Тест инференса без весов пропускается.
- CI.
  - Windows-джоб не запускает setup.
  - На раннерах GitHub Python предустановлен, поэтому зависимость от Python CI не видит.
  - `docker-publish.yml` публикует `:latest` с каждого пуша в ветку по умолчанию
    (`type=raw,value=latest,enable={{is_default_branch}}`).

### 3.4 Корневые причины

1. **Наследие Obsidian-хранилища.** Пути считаются относительно исходников, а раскладку `09-mcp`
   приходится имитировать в клоне и в Docker (симлинки в entrypoint).
2. **Два языка для одной функции.** Поиск на Python, всё остальное на Node.
3. **Два пути установки и логика, размноженная по sh/ps1/C#/mjs.** Отсюда повторяющиеся семейства
   дефектов в реестре:
   - «решение применено в одном месте из двух»: Д-31, Д-44, Д-61, Д-72, Д-74;
   - две копии идентичности проекта: Д-35, Д-45, Д-48, Д-51;
   - разошедшийся allowlist: Д-37, Д-38, Д-56, Д-57;
   - параллельные пути запуска: Д-52, Д-57, Д-60, Д-68, Д-69, Д-70, Д-79.
4. **Один процесс на клиента и нет единого писателя.** Отсюда потеря данных и по копии модели в
   памяти на каждого клиента.
5. **Пробел в проверке.**
   - Песочница без Windows, macOS, huggingface и Docker-реестров, CI форка мёртв.
   - На Windows раздел «модель» не проходил никогда.
   - Критерий C3 («клиент видит сервер») не подтверждён ни на одной машине.

### 3.5 Факты для exe и интерфейса

**Что есть сейчас**
- GUI нет. Человек видит только Markdown/JSON для Obsidian, CLI JSON, MCP-ресурсы и промпты.
- Операции, которые существуют только как скрипты: setup, скачивание модели, установка клиентов,
  запуск демона.
- У MCP-инструментов нет настоящего прогресса (только 0/1 и 1/1) и нет отмены: `extra.signal`
  игнорируется (`server.mjs`).

**Связь интерфейса с сервером**
- SDK 1.30 умеет Streamable HTTP, но проект обещает «без сетевого порта» (README, SECURITY.md).
  Поэтому интерфейс говорит с демоном по named pipe или Unix-сокету, без TCP.

**Что мешает упаковке**
- Seed должен быть доступен на запись: setup пишет в него registries, cards, groups и дашборд.
- Нативные модули собраны на Node-API v6, поэтому для Electron их пересобирать не нужно.
- onnxruntime-node для win32-x64 весит 64 МБ: onnxruntime.dll 28,8; DirectML.dll 18,5;
  dxcompiler.dll 18,0; dxil.dll 1,5.
- Дочерние процессы:
  - Archify CLI и Frontend QA runner запускаются через `process.execPath`;
  - process-runner на Windows переписывает npm/pnpm в `execPath + entrypoint` и добавляет папку
    Node в PATH;
  - хукам нужен `node` в PATH.
- Dense-воркер загружается из отдельного файла (`new Worker(new URL(...))`).
- Итог: Node SEA и pkg не подходят — мешают нативные DLL, воркер из файла и записываемый seed.

**Рекомендованная схема**
- Per-user установщик: portable `node.exe` + папка приложения + стабильный лаунчер для
  MCP-клиентов + GUI на Electron через named pipe.
- `.mcpb` — опциональный канал установки для Claude Desktop.
- Локальный старт и так занимает 0,35 с, поэтому подменять рукопожатие не нужно.

**Подпись кода** (сведения из веба, не проверялись)
- EV-сертификат больше не обходит SmartScreen.
- Azure Artifact Signing доступен не во всех странах.

### 3.6 Что есть у пользователей прода сегодня (поверхность совместимости)

**Локальная установка из клона**
- В конфигах клиентов: `node <клон>/ai-dev-mcp-server/src/server.mjs` под именем
  `ai-dev-system`, в env — `AI_DEV_PYTHON`.

**Docker-установка (через bootstrap)**
- Сервер в конфигах называется `ai-dev`.
- Windows:
  - запуск через `powershell.exe -File <клон>\docker\run-mcp.ps1` или через его копию
    `C:\ProgramData\AI-Dev-System\run-mcp.ps1`;
  - Claude — через `C:\ProgramData\AI-Dev-System\ClaudeMcpProxy.exe`.
- macOS и Linux:
  - запуск через `/bin/sh <клон>/docker/run-mcp.sh` с
    `AI_DEV_RUNTIME_CONTAINER=ai-dev-system-runtime-<uid>`;
  - тёплый контейнер из `:latest` работает как `tail -f /dev/null` с `restart unless-stopped`;
  - лаунчер выполняет `docker exec -i <c> node /opt/ai-dev/app/src/server.mjs`.
- Переменные в конфигах: `AI_DEV_IMAGE` (по умолчанию `ghcr.io/stonebridgeway/ai-dev-system:latest`),
  `AI_DEV_PROJECT_PATH`, `AI_DEV_MODEL_PATH` (папка над `bge-m3-onnx/` и `bge-m3/`),
  `AI_DEV_DATA_VOLUME` (`ai-dev-system-data`).
- Codex: секция `[mcp_servers.ai-dev]` с `startup_timeout_sec = 120` и
  `tool_timeout_sec = 3600`.

**Том `/data` в Docker**
- Хранилище — `/data/ai-dev-system`.
- Рантайм — `/data/runtime-home/.ai-dev`. Часть каталогов из-за Д-90 лежит уровнем глубже, в
  `/data/runtime-home/.ai-dev/.ai-dev`.

**Хуки в репозиториях пользователей**
- Лежат в `.ai-dev/hooks/*.mjs`, команда — `node .ai-dev/hooks/<script>`.
- Регистрация — в `.claude/settings.json`, `.cursor/hooks.json` и т. п.
- Пишут в `~/.ai-dev/state` хоста.

**Данные в `~/.ai-dev`**
- `state/`: tasks, sessions, `usage/events.jsonl`, `instincts.json`, `skill-outcomes.json`,
  `pilots.json`.
- `cache/search-index/ai-dev-search.sqlite`, вместе с dense-векторами.
- `models/bge-m3-onnx` и `models/bge-m3`; `artifacts/`; `run/`.
- В каждом репозитории — `.ai-dev/`: decisions, plans, policy, hooks, git-hooks, frontend, pr.

**Особые группы пользователей**
- Те, кто задал `AI_DEV_HOME` по документации: их данные в `<AI_DEV_HOME>/.ai-dev`.
- Те, кто на legacy dense: `AI_DEV_DENSE_BACKEND=python` или образ с `INSTALL_BGE_M3=1`.
- Перешедшие с Codex: их состояние в `~/.codex/state/ai-dev-system` и рядом.

### 3.7 Окружение прошлой песочницы (у тебя может отличаться — проверь на старте)

**Инструменты**
- Node 22.22.0, npm 10.9.4, при этом `packageManager` — npm@11.17.0, поэтому lockfile
  перегенерируй через `npx npm@11.17.0`.
- Python 3.13 есть.
- Chromium лежит в `/opt/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH`).
- Docker CLI есть; демон не запущен, но поднимается командой `dockerd &`.

**Сеть**
- Работают: реестр npm, nodejs.org, pypi.
- huggingface.co — 403.
- ghcr.io: манифесты отдаются, а хранилище слоёв `pkg-containers.githubusercontent.com` — 403,
  поэтому образы ghcr не скачать.
- Docker Hub — 429; вместо него `mirror.gcr.io/library/<image>`.
- deb.debian.org закрыт; archive.ubuntu.com по HTTP работает (`docker run --network host`).
- Зеркала Fedora не проходят TLS.
- cdn.playwright.dev и api.nuget.org закрыты.

### 3.8 Что не проверено разбором

- Настоящие веса BGE-M3: загрузка, инференс на transformers 4.3.0 и onnxruntime 1.30, время
  эмбеддинга 3 445 документов, память.
- Опубликованный Docker-образ и его локальная сборка.
- Всё на живых Windows и macOS.
- bootstrap на Debian и Fedora.
- Сведения о Electron, Tauri и подписи кода, взятые из веба.
- Падение дашборда без setup.

## 4. Решения владельца (действуют по умолчанию)

| Код | Решение |
|---|---|
| D0 | CI-зонд — черновой PR `форк:Dev → прод:main` открывает владелец, если захочет. Ты его не открываешь |
| D1 | Работа в форке, в одной рабочей ветке сессии. По каждой фазе — PR в `Dev`; после прохождения ворот ты сам мержишь его в `Dev` merge-коммитом. `main` форка и прод не трогаешь |
| D2 | `AI_DEV_HOME` — это сама папка рантайма (как в документации и Dockerfile). Данные из `<AI_DEV_HOME>/.ai-dev` мигрируют автоматически |
| D3 | Legacy Python dense-бэкенд удаляется. У кого он включён, получает ясное сообщение и одну команду перехода на ONNX |
| D4 | npm-пакет `@stonebridgeway/ai-dev-system`, если имя свободно (проверь `npm view`); иначе предложи имя. Публикует владелец, ты готовишь tarball |
| D5 | Оболочка интерфейса — Electron |
| D6 | Языки интерфейса — русский и английский |
| D7 | Обновления — через GitHub Releases прода. Подпись — через переменные окружения (сертификат у владельца). Сборка без подписи тоже работает |
| D8 | Версия релиза — 3.0.0. brew и AUR (не опубликованы) удалить с записью в CHANGELOG |
| D9 | Теги образа: `:latest` — только с тегов `v*`; пуш в main → `:edge`; `:2` — замороженная линия 2.x для отката; `:latest` переходит на 3.x при выкатке |
| D10 | Старые лаунчеры (`run-mcp.sh/.ps1`, ClaudeMcpProxy) живут как совместимые обёртки до 4.0 |
| D11 | `docs/program/` — внутренние документы программы на русском. Оставлять ли их в ветке, которая пойдёт в прод, — вопрос владельцу в итоговом отчёте |

## 5. Правила

1. **AGENTS.md и CONTRIBUTING.md действуют полностью.**
   - Новые инструменты — расширениями в `src/extensions/`.
   - Модули не длиннее 800 строк; `mcp-stdio.mjs` не растёт; потолки не поднимать.
   - Фейковые секреты в тестах — только конкатенацией.
   - Хуки дублируют логику сервера намеренно: меняешь — меняй обе стороны.
   - `shell: false`, никаких `exec` и `eval`.
   - Дефект записывается до исправления, с замером «до» и «после».
   - `npm run acceptance` — 10 прогонов.
   - Код и публичная документация — на английском; `README.ru.md` и `DEFECTS.md` — на русском.
   - Проверять адверсариально, против запущенного сервера.
   - Правило «всё мержится в main» на время программы читается как «всё мержится в Dev».
2. **Прод.**
   - В `stonebridgeway` — ничего; никаких публикаций (npm, GHCR, релизы, теги).
   - Установки 2.x (раздел 3.6) после обновления — git pull, docker pull или переустановки —
     работают или мигрируют автоматически, без потери данных, и это покрыто тестом.
   - Убирать публичное (команду, путь, переменную, имя сервера в конфиге, путь внутри образа)
     можно только через совместимую обёртку с предупреждением и запись в заметку о миграции.
     Само удаление — в 4.0.
3. **Доказательства.**
   - Каждый критерий приёмки подтверждается командой и её фактическим выводом.
   - Пробы — по MCP, против запущенного сервера, включая то, чего быть не должно.
   - Если проба расходится с продуктом — сначала подозревай пробу.
   - Чего не смог исполнить — пишешь «не проверено» с причиной и способом проверки.
   - Код под Windows — по документации Node и ОС, с тестами на подменённый platform. Живая
     проверка уходит в чек-лист владельца.
4. **Границы фазы.** Проблему вне текущей фазы заведи в реестр следующим свободным номером и не
   чини в этой фазе.
5. **Не коммитить** веса модели и бинарники; исключение — тестовые фикстуры до 100 КБ.
6. **Оформление.** Коммиты — Conventional Commits; запись в `CHANGELOG.md` [Unreleased];
   документация EN и RU обновляется зеркально.
7. **Субагенты.** Если они доступны, используй их для параллельной разведки и для независимого
   ревью диффа каждой фазы перед мержем. Их выводы перепроверяй сам.

## 6. Дефекты Д-85 … Д-108

Номера фиксированы. Каждую запись заводи до исправления, с замером «до». Без цифр «до» и «после»
дефект закрытым не считается.

| № | Суть | Как воспроизвести | Фаза |
|---|---|---|---|
| Д-85 | Поиск требует Python, хотя README обещает «Node и больше ничего». CI этого не ловит: на раннерах Python есть, Windows-джоб не запускает setup | Чистый клон, PATH без `python*`: `npm ci --ignore-scripts && npm run setup` → `✗ Search index: spawn python3 ENOENT`, Health fail | 4 |
| Д-86 | `npm install` без `--ignore-scripts` падает: postinstall onnxruntime-node идёт на api.nuget.org | `npm install` в чистом клоне | 2 |
| Д-87 | `package-lock.json`: 6 дублирующихся ключей | Поиск повторов ключей в `"packages"` | 2 |
| Д-88 | ClaudeMcpProxy монтирует модель в `/models/bge-m3`, а образ ищет `/models/bge-m3-onnx`: у Claude на Windows dense-поиска нет | `docker/ClaudeMcpProxy.cs:76` против run-mcp.sh/ps1 и `BGE_M3_ONNX_DIR` | 2 |
| Д-89 | Тёплый run-mcp.sh и ClaudeMcpProxy подменяют `initialize`: `instructions` теряются, версия зашита в коде | Ответ `node src/server.mjs` против литерала в `run-mcp.sh:50` | 13 |
| Д-90 | `AI_DEV_HOME` удваивает `.ai-dev` | `AI_DEV_HOME=/x/.ai-dev`, `resolveRuntimeStateRoot()` → `/x/.ai-dev/.ai-dev` | 2 |
| Д-91 | Фильтр Membrane не срабатывает в seed | `python3 search-index/search_cli.py dense-plan …` → eligible 3445/3445 | 2 |
| Д-92 | `bootstrap.sh --install-prerequisites`: в Ubuntu 24.04 нет пакета `docker-compose-plugin` | `apt-get install -s docker.io docker-compose-plugin` в `ubuntu:24.04` | 2 |
| Д-93 | `setup --frontend-qa` пишет ✓ без Chromium; на Windows npm запускается без обёртки; без pnpm ставится в обход lock | `PLAYWRIGHT_BROWSERS_PATH=<пусто> npm run setup -- --frontend-qa`, затем `doctor` | 2 |
| Д-94 | Локальный установщик клиентов прописывает `AI_DEV_PYTHON=python3` и на Windows | `scripts/install-local-mcp-clients.mjs:58` | 2 |
| Д-95 | Два установщика клиентов: разные имена (`ai-dev-system` и `ai-dev`) и разный набор клиентов, отсюда дубли серверов | dry-run обоих установщиков в пустом HOME | 6 |
| Д-96 | Конкурентная запись теряет данные (~205/600); у JSON-хранилищ с read-modify-write тот же риск | 3 процесса × 200 записей через `atomicAppendFile` | 2 |
| Д-97 | Демон: падает при пути сокета длиннее 107 байт; `sessions: 0`; нет stop/status и клиента, хотя INSTALL их обещает | HOME с длинным путём → `node src/daemon.mjs` | 8 |
| Д-98 | Без ONNX-модели векторы молча уходят на legacy `.venv` (ENOENT); `dense:doctor` пишет «no Python needed» | `npm run setup -- --dense` без доступа к huggingface | 4, 5 |
| Д-99 | Docker: векторы документов не строятся, веса не скачать внутри, `cp -n` не обновляет seed | По коду: `docker-bootstrap.mjs`, `entrypoint.sh:24` | 13 |
| Д-100 | Документация расходится с замером (подробности — в фазе 1) | Замеры фазы 1 | 1 |
| Д-101 | transformers 4.3.0 и onnxruntime 1.30 не проверены на настоящих весах; override sharp лишний | Даты в git log; skip в `src/core/dense-onnx-inference.test.mjs` | 5 |
| Д-102 | `search_knowledge` читает все .md на каждый вызов (~2,5 с) | Время вызова по MCP | 4 |
| Д-103 | Хуки вызываются как голый `node`; в Docker хуки и сервер пишут в разные места | `agent-hooks.mjs:149`; `stateRoot` в `hooks/lib.mjs` против `/data` | 6, 13 |
| Д-104 | Наследие Codex: запасной путь в `~/.codex` разводит состояние сервера и хуков; PowerShell-скрипты работают только в полном хранилище | `mcp-stdio.mjs:221-226` против `hooks/lib.mjs`; `scripts/*.ps1` | 7 |
| Д-105 | Windows + Docker: нет тёплого контейнера; C#-прокси компилируется у пользователя, без подписи, вне CI | `install-docker-mcp-clients.mjs` (`!windows`); `bootstrap.ps1:115-136` | 13 |
| Д-106 | `dashboard` без setup — stack trace; 8 из 10 строк «Ready» зашиты в код | Чистый клон → `npm run dashboard`; `system-dashboard.mjs:84-91` | 9 |
| Д-107 | Windows pipe демона: предсказуемое имя, права по умолчанию — канал можно подменить | `socketAddress` в `src/core/runtime-paths.mjs` | 8 |
| Д-108 | Каждый пуш в main прода публикует `:latest`: мерж сразу становится выкаткой | `docker-publish.yml`: `type=raw,value=latest,enable={{is_default_branch}}` | 13 |

## 7. Протокол одной сессии

### Старт

1. **Бриф и журнал.** Сохрани бриф в `docs/program/BRIEF.md`. Заведи `docs/program/PROGRESS.md`:
   - таблица фаз 1–15 со статусами (не начата, в работе, готова, заблокирована) и ссылками на PR;
   - принятые решения и отступления;
   - блокеры;
   - журнал ключевых замеров;
   - раздел «Следующий шаг» — всегда актуальный.
   Закоммить и запушь.
2. **Синхронизация.** `git fetch origin`. Если `origin/main` впереди `origin/Dev`, влей main в Dev
   отдельным PR (merge) и смержи.
3. **Пробник окружения.** Проверь доступность huggingface.co, ghcr.io (включая слои),
   registry-1.docker.io, mirror.gcr.io, deb.debian.org, archive.ubuntu.com, cdn.playwright.dev,
   ассетов релизов GitHub (нужны для бинарника Electron), api.nuget.org, registry.npmjs.org.
   Проверь, есть ли python3, Docker и Chromium. Итог запиши в PROGRESS.
   Если huggingface.co доступен — настоящие веса проверяй сам, а не через чек-лист владельца.
4. **Базовый прогон.** Чистый клон `Dev` → `npm ci --ignore-scripts` → `npm run setup` →
   `npm run check`. Сравни с разделом 3.2 и запиши расхождения.

### Цикл фазы

1. Перечитай задачи фазы и составь план. Заведи или обнови дефекты с замером «до».
2. Реализуй небольшими коммитами, тесты держи рядом с кодом.
3. **Ворота фазы:**
   - `npm run check` зелёный;
   - `npm run acceptance` — «0 падений из 10». Если падения есть, разберись: падение с упавшим
     тестом говорит о коде, а выход с ошибкой при `# fail 0` — о coverage-репортере;
   - начиная с фазы 2 — `npm run upgrade:test` зелёный;
   - каждый критерий приёмки фазы подтверждён командой;
   - не меньше трёх проб против запущенного сервера, одна из них — «чего быть не должно»;
   - независимое ревью диффа (субагент или `/code-review`), найденное исправлено;
   - DEFECTS (замер «после»), CHANGELOG, документация EN/RU обновлены.
4. PR фазы в `Dev`, в описании — отчёт фазы (раздел 9.1). После ворот смержи merge-коммитом.
   Обнови PROGRESS: статус, PR, ключевые цифры, «Следующий шаг». Запушь.
   Следующую фазу продолжай в той же рабочей ветке; новый PR для неё откроется от той же ветки.

### Блокеры, сжатие контекста, порядок

- **Блокер** (внешний доступ или решение вне брифа). Сделай независимую часть, запиши блокер в
  PROGRESS и в итоговый отчёт и переходи к фазе, которая от него не зависит.
- **Сжатие контекста.** Перечитай `BRIEF.md`, `PROGRESS.md` и описание последнего PR.
- **Граф зависимостей:**
  - 1 → 2 → 3 → 4 → 5 → 6;
  - 6 → 7;
  - 6 → 8 → 9 → 10 → 11;
  - 12 требует 7 и 11;
  - 13 требует 4, 6 и 7;
  - 14 — после всех, 15 — после 14.
- **Порядок по умолчанию** — 1…15. Если 10–12 заблокированы (например, не скачивается Electron),
  сделай сначала 13, потом вернись к ним.

## 8. Фазы

### Фаза 1 — Реестр дефектов и правда в документации

Код в этой фазе не меняется.

1. Завести записи Д-85…Д-108 по разделу 6 в формате реестра:
   - что не так;
   - чем грозит;
   - замер «до» — воспроизведи сам;
   - какая фаза закроет.
   Что в песочнице не исполняется — помечай «по коду» с файл:строка.
2. Шапка реестра: обновить счётчики (было 84 записи, 2 открытых) и добавить абзац о программе.
   Привести в порядок Д-44: в строке статуса «закрыт частично», хотя пункты закрыты в Д-45 и Д-47.
3. Закрыть Д-100 правкой текста. Каждое число измерить.
   - README, README.ru, INSTALL (EN/RU): Python 3 (stdlib) пока нужен для поиска — до фазы 4.
     Клиентов подключать через `npm run clients:install`, без ручной правки JSON.
   - CAPABILITIES (EN/RU) и README: размеры схемы `tools/list` по замеру, вместе с командой замера.
   - INSTALL (EN/RU): `npm run daemon` — экспериментальный, клиенты к нему не подключаются (Д-97).
   - `ai-dev-mcp-server/README.md`: убрать `AI_DEV_RUNTIME_CONFIG`, исправить описание `--dense`.
   - `TEST-PLAN*.ru.md`: убрать закрытые Д-74 и Д-81 из текущих проблем; путь `napi-v3` заменить
     фактическим.

Критерии приёмки:
- в реестре 108 записей;
- у каждой новой записи есть замер или пометка «по коду» с файл:строка;
- числа в документации совпадают с замерами;
- `npm run check`, `npm run docs:tools:check` и `npm run acceptance` зелёные.

### Фаза 2 — Быстрые исправления и тест обновления

Закрывает Д-86, Д-87, Д-88, Д-90, Д-91, Д-92, Д-93, Д-94, Д-96.

1. **Д-86.** Добавить `ai-dev-mcp-server/.npmrc` со строкой `onnxruntime-node-install=skip`.
   `npm install` и `npm ci` должны проходить без `--ignore-scripts`. Из пользовательской
   документации флаг убрать. В CI и Dockerfile — по обоснованию.
2. **Д-87.** Перегенерировать lockfile через `npx npm@11.17.0`: дублей 0, одна версия
   onnxruntime-node, `npm run security` зелёный. Убрать лишний override sharp и доказать это
   выводом `npm ls sharp`.
3. **Д-88.** Прокси монтирует модель в `/models` и, как sh/ps1, отвергает старое значение.
   Контрактный тест проверяет, что цель монтирования модели одинакова во всех копиях: sh, ps1, cs,
   пример compose, bootstrap.
4. **Д-90 (D2).** Одна семантика `AI_DEV_HOME` везде: runtime-home, dense-onnx, first-run,
   project-identity и копия в `hooks/lib.mjs` (правило 3). Идентичность проекта менять только
   вместе с парным изменением в хуках и тестом, что две копии совпадают. Миграция из
   `<AI_DEV_HOME>/.ai-dev` проходит без потерь, `doctor` сообщает о ней.
5. **Д-91.** Membrane определяется по источнику, а не по пути, — в `search_cli.py`, в
   `search_knowledge` и при сборе skills. Ожидаемое eligible — около 3 445 − 3 074.
6. **Д-92.** Bootstrap-у compose не нужен: ставить только движок Docker, с верными пакетами для
   apt, dnf и pacman. Ubuntu проверить в контейнере; остальное — в «не проверено».
7. **Д-93.** Frontend-qa ставится по pnpm-lock (закреплённая версия pnpm, frozen lockfile), затем
   `playwright install chromium`. На Windows — через адаптер process-runner. Пока Chromium нет,
   ✓ не ставится.
8. **Д-94.** Один выбор интерпретатора Python для сервера и установщика: на Windows — `python`.
   Это временно, до фазы 4.
9. **Д-96.** Межпроцессно безопасная дозапись в обеих копиях: `atomic-files` и `hooks/lib.mjs`.
   - JSONL: `O_APPEND` одной записью или межпроцессная блокировка.
   - JSON-хранилища: блокировка с разбором протухших.
   - Учесть обрыв процесса посреди записи.
10. **`npm run upgrade:test` — тест обновления с прода.**
    - Ставит базу 2.x: git worktree на коммите прода `8f647df` во временной папке, `npm ci`,
      `setup`.
    - Создаёт состояние: задача с чекпоинтом, решение, индекс, конфиги клиентов обоих форматов из
      раздела 3.6 в подставном HOME, хуки в тестовом репозитории, данные по старой семантике
      `AI_DEV_HOME`.
    - Запускает текущую ветку на тех же данных и проверяет: сервер стартует, данные на месте,
      индекс читается, конфиги и хуки работают.
    - Docker-часть — описанным сценарием для CI.

Критерии приёмки:
- замеры «до» Д-86…Д-96 повторены и показывают исправленное поведение;
- `npm install` без флагов → exit 0;
- 3 × 200 записей дают 600 строк в 10 прогонах подряд; `kill -9` посреди записи не оставляет битых
  строк;
- `upgrade:test` зелёный;
- `npm run check` и `npm run acceptance` зелёные.

### Фаза 3 — Поиск на Node, часть 1: индекс

1. **Перенос в Node.** rebuild, status и FTS-поиск переезжают на `node:sqlite` в новые модули
   `src/core/` (каждый не длиннее 800 строк, с JSDoc и тестами): схема, сбор документов и отпечаток
   свежести, запись (полная, инкрементальная, с сохранением dense), запрос и ранжирование (всё, что
   сейчас в Python). `mcp-stdio.mjs` не растёт.
2. **Формат файла индекса сохраняется.** До фазы 4 Python-хелпер hybrid/dense должен читать индекс,
   который построил Node.
3. **Несколько процессов одновременно:** WAL, busy_timeout, блокировка перестройки с семантикой
   `AI_DEV_SEARCH_REBUILD_LOCK_TIMEOUT`.
4. **Версия Node.** `engines` >= 22.13.0 (в 22.12 `node:sqlite` спрятан за флагом); обновить
   `.nvmrc`, CI-джоб с минимальной Node и документацию. ExperimentalWarning SQLite подавлять
   точечно, остальные предупреждения не трогать.
5. **Тесты.** Перенести `search-index/test_search_freshness.py` в node:test.
6. **Паритет.** Dev-скрипт сравнивает top-k Node и Python на всех кейсах `search-eval/*.json`.
   Каждое расхождение исправить или объяснить.
7. **Совместимость с продом.** Индекс 2.x с dense-векторами читается или переносится без потери
   векторов.

Критерии приёмки:
- без Python шаги setup «Skill registry», «Search index» и «Skill-routing benchmark» проходят;
- по MCP работают `search_all`, `search_projects`, `search_notes`, `search_skill_registry`,
  `search_index_status`, `rebuild_search_index`;
- проверки, которым ещё нужен Python (hybrid), перечислены;
- `search_all` на тёплом индексе быстрее 70 мс (цель — 30 мс или меньше);
- время перестройки — до и после;
- совпадение top-3 — не меньше 95 %, каждое расхождение — с причиной;
- `run_search_eval` и routing benchmark не хуже исходных;
- `upgrade:test` проверяет индекс 2.x с синтетическими векторами;
- `check` и `acceptance` зелёные.

### Фаза 4 — Поиск на Node, часть 2: hybrid, векторы, без Python

Закрывает Д-85, Д-102 и ту часть Д-98, что связана с Python.

1. **Hybrid, dense-plan и запись векторов — в Node.** Векторы из воркера пишутся прямо в индекс.
2. **`search_knowledge` — через индекс**, с прежним форматом ответа.
3. **Python уходит.**
   - Удалить `search_cli.py` и его тесты.
   - `pythonCommand` оставить только для опционального.
   - `query_ui_ux_knowledge` без Python: честная ошибка с подсказкой, отметка в `doctor` и в
     документации профиля frontend.
4. **Health и doctor работают без Python.**
5. **CI.** Джоб «чистая машина без Python» на ubuntu, macos и windows: `npm ci`, `setup`,
   `doctor`, protocol smoke.
6. **Документация EN/RU:** «Node.js 22.13+ и больше ничего». В CONTRIBUTING Python больше не
   нужен.

Критерии приёмки:
- без Python: setup — 0 failed, `doctor` ok по всем проверкам, все 13 поисковых инструментов и
  `search_knowledge` отвечают;
- `search_knowledge` — не дольше 100 мс (было ~2,5 с); `hybrid_search` без dense — не дольше 100 мс
  (было ~0,42 с);
- grep по базовому пути не находит вызовов python (вывод — в отчёт);
- golden cases не хуже, чем в фазе 3;
- `check`, `acceptance` и `upgrade:test` зелёные;
- в чек-лист владельца: чистая Windows без Python — клон, `npm ci`, `setup`, `doctor`.

### Фаза 5 — Менеджер локальной модели

Закрывает Д-98 и Д-101; снимает ограничение Д-73 (нет докачки).

1. **Модуль менеджера** (в `src/core/`, не длиннее 800 строк на модуль):
   - `install` с докачкой по Range. `.part` привязан к ревизии и sha256 через файл метаданных
     рядом.
   - Источники: `manifest.sources` плюс зеркало `AI_DEV_MODEL_MIRROR` (совместимо с
     `HF_ENDPOINT`). Мёртвый источник → следующий.
   - Прокси `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` работает без ручного `NODE_USE_ENV_PROXY`.
   - Прогресс (байты, всего, скорость, ETA) через callback; отмена через AbortSignal; проверка
     свободного места сохраняется.
   - Команды `verify`, `import` (из папки или zip), `remove`, `status`.
2. **Векторы документов** строятся после установки: с прогрессом и отменой, инкрементально, без
   Membrane.
3. **Нет модели — нет тихого фолбэка.** Ясная ошибка «модель не установлена, выполните …».
4. **Legacy-путь удаляется (D3):**
   - `embeddings/*.py` и requirements;
   - флаг `--dense-python`;
   - переменные `BGE_M3_PYTHON`, `AI_DEV_EMBEDDINGS_PYTHON`, `AI_DEV_PYTHON_BASE`;
   - `INSTALL_BGE_M3` в Dockerfile;
   - ветки в коде и документации.
   У кого стоит `AI_DEV_DENSE_BACKEND=python` или образ `INSTALL_BGE_M3=1`, получает сообщение и
   одну команду перехода. Их векторы переиспользуются или помечаются к пересчёту; остальной индекс
   не теряется.
5. **`setup -- --dense` и `dense:doctor`** работают через менеджер, сообщения правдивы.
6. **Тесты:**
   - локальный HTTP-сервер с Range: обрыв → докачка; подмена файла → mismatch; 503 → следующий
     источник; прокси;
   - сквозной тест синтетической ONNX-моделью через настоящий воркер: `import` → `embed` → `hybrid`
     с dense. Модель — крошечная фикстура до 100 КБ.
7. **Д-101.** Совместимость transformers 4.3.0 + onnxruntime 1.30 подтвердить. Если доступен
   huggingface.co — на настоящих весах (время загрузки, эмбеддинга, память).

Критерии приёмки:
- обрыв на 50 % докачивается с нужного смещения, sha совпадают;
- при 503 загрузка проходит со второго источника;
- без модели hybrid работает без dense, ни одного spawn python;
- сквозной тест на синтетике зелёный;
- `check`, `acceptance`, `upgrade:test` зелёные;
- в чек-лист владельца, если веса недоступны в песочнице: настоящая загрузка, обрыв и докачка,
  время эмбеддинга, dense smoke, RSS.

### Фаза 6 — Единый CLI `ai-dev` и подключение клиентов

Закрывает Д-95 и часть Д-103.

1. **Команды.** В `package.json`: `"bin": { "ai-dev": "bin/ai-dev.mjs" }`.
   - `setup` с флагами `--yes`, `--model`, `--frontend-qa`, `--clients=…`; в TTY задаёт вопросы.
   - `mcp` — stdio-сервер; в фазе 8 станет мостом к демону.
   - `clients list|install|remove|doctor`.
   - `model install|import|verify|remove|status`.
   - `doctor`, `version`, `help`.
   Один парсер аргументов, понятные ошибки, коды выхода.
2. **Один модуль записи конфигов клиентов** для локального режима и Docker (фаза 13).
   - Клиенты: Claude Code (`~/.claude.json`), Claude Desktop (включая Store), Cursor, VS Code,
     Codex (`config.toml`, чужое содержимое и комментарии сохраняются), Gemini.
   - Имя сервера — `ai-dev`. `command` — абсолютный путь к node (`process.execPath`); `args` —
     абсолютный путь к CLI и `mcp`.
   - Миграция: записи `ai-dev-system` удаляются с резервной копией. Повторный запуск ничего не
     меняет.
3. **Д-103: хуки.** Команды прописываются с абсолютным путём к node (или как `ai-dev hook <имя>`)
   и работают без Node в PATH. Меняются обе копии.
4. **Старые точки входа.** npm-скрипты `setup`, `doctor`, `clients:install`, `dense:doctor`
   становятся алиасами CLI. `scripts/ai-dev.mjs` поглощается, `scripts/start-local.ps1`
   удаляется. Docker-лаунчеры не трогать — это фаза 13.
5. **Совместимость с продом.**
   - Записи клиентов 2.x работают без переустановки: `node <клон>/…/src/server.mjs` остаётся
     рабочей точкой входа.
   - Хуки 2.x работают; повторный `install_agent_hooks` их обновляет.
   - `clients install` мигрирует обе формы имени.
6. **Документация EN/RU.** Из клона: `npm ci && npm run setup`.

Критерии приёмки:
- пустой HOME с конфигами шести клиентов (внутри — чужие серверы): `node bin/ai-dev.mjs setup
  --yes --clients all`;
- diff каждого конфига — в отчёт; повтор — «без изменений»; `remove` возвращает исходное;
- команда из конфига запускается и отвечает на `initialize` с `instructions`;
- хук работает при PATH без node;
- `upgrade:test` покрывает конфиги и хуки 2.x;
- `check` и `acceptance` зелёные;
- в чек-лист владельца: на Windows Claude Desktop, Cursor и VS Code видят `ai-dev`, `begin_task`
  отвечает (первая живая проверка C3).

### Фаза 7 — Дистрибутив и npm-пакет

Закрывает Д-104 и по существу — семейство «разошедшийся allowlist».

1. **`npm run dist` → `dist/ai-dev/`:** рантайм, prod-зависимости, seed, search-eval, манифест
   модели, хуки, ресурсные документы. Состав задаёт один манифест-allowlist; его же используют
   Docker-контекст и установщик.
2. **Модуль раскладки** находит корень приложения, seed и данные в трёх раскладках (клон,
   пакет/dist, Docker) без допущений о `09-mcp`. `AI_DEV_VAULT_ROOT` остаётся для полного
   хранилища.
3. **Пользовательское хранилище.** Вне клона seed копируется в `~/.ai-dev/vault`, а папка пакета
   считается только для чтения. Обновление идёт по sha256-манифесту:
   - файлы, которые пользователь не трогал, заменяются;
   - изменённые остаются;
   - конфликты видны в `doctor`.
4. **npm-пакет (D4):** `files` и prepack, `npm pack`. Размер и состав — в отчёт. Не публиковать.
5. **Д-104:**
   - запасной путь `~/.codex` — одноразовая миграция в `~/.ai-dev` с записью в лог;
   - поиск Codex runtime удалить;
   - `scripts/*.ps1` (backup, restore, run-acceptance) — кроссплатформенными командами CLI или
     удалением с записью в CHANGELOG.

Критерии приёмки:
- чистый контейнер без клона, только tarball: `npx --yes ./<tarball> setup --yes` → health ok,
  сервер отвечает по MCP;
- новый tarball обновляет seed и не трогает изменённый пользователем файл (тест);
- dist и Docker-контекст собраны по одному манифесту;
- `check`, `acceptance`, `upgrade:test` зелёные;
- в чек-лист владельца: `npx` из tarball на Windows.

### Фаза 8 — Демон: один процесс на всех клиентов

Закрывает Д-97 и Д-107.

1. **`ai-dev mcp` — мост stdio ↔ демон.**
   - Нет демона — поднимает его в фоне (detached, windowsHide) и ждёт готовности.
   - Демон не поднялся — работает in-process и пишет причину в stderr.
   - Рукопожатие проходит насквозь, `instructions` доходят до клиента.
2. **Защита канала.**
   - Случайное имя сокета или pipe в `daemon.json` с правами 0600.
   - Аутентификация первым сообщением, секретом из файла в профиле пользователя.
   - На Unix — каталог 0700 и короткий путь: при длине больше 100 байт — `$XDG_RUNTIME_DIR` или
     `/tmp/ai-dev-<uid>/`.
   - Модель угроз — в `ai-dev-mcp-server/docs/SECURITY.md`.
3. **Жизненный цикл.**
   - `ai-dev daemon start|stop|status`; на Windows `stop` — управляющим сообщением.
   - Живой счётчик сессий, idle-timeout, лог демона.
   - Перезапуск, если версия CLI и демона разошлась.
4. **Единственный писатель.** Состояние пишет демон; хуки — безопасной дозаписью из фазы 2.
5. **Прогресс и отмена.** `rebuild_search_index`, установка модели и шаги setup шлют
   `notifications/progress` и уважают отмену запроса.

Критерии приёмки:
- 3 клиента × 200 записей → 600;
- при трёх клиентах модель в памяти одна (RSS, синтетика);
- `kill -9` демона → следующий запрос поднимает его заново;
- HOME длиннее 120 байт работает;
- другой пользователь (`useradd`) подключиться не может;
- отмена `rebuild_search_index` не повреждает индекс;
- `check`, `acceptance`, `upgrade:test` зелёные;
- в чек-лист владельца: на Windows два клиента одновременно, `status` и `stop`.

### Фаза 9 — Управляющий API для интерфейса

Закрывает Д-106.

1. **Расширение `src/extensions/control.mjs`** по правилам AGENTS.md: фабрика, регистрация,
   профиль, группа в `render-tool-reference`. Инструменты:
   - `system_status`;
   - `setup_run` с прогрессом;
   - `model_install`, `model_import`, `model_verify`, `model_remove` — с прогрессом и отменой;
   - `clients_list`, `clients_install`, `clients_remove`;
   - `logs_tail`;
   - `settings_get`, `settings_set` — профили, пути, зеркало модели; хранятся в
     `~/.ai-dev/config.json` с валидацией;
   - `workspace_overview` — проекты, задачи, эпики, решения, расходы.
   Признак readOnly у каждого верный; вызовы идут через демон.
2. **Д-106.** Строки дашборда вычисляются из реальных проверок; `dashboard` без setup отвечает
   понятным сообщением.
3. **Контракт для интерфейса:** схемы ответов и версия — в docs (EN); пример клиента на MCP SDK
   через сокет демона — в виде теста.

Критерии приёмки:
- каждый новый инструмент проверен через демон: успех, ошибка ввода, отмена для долгих;
- `docs:tools:check` зелёный;
- схема профиля core не выросла (замер до и после);
- `check`, `acceptance`, `upgrade:test` зелёные.

### Фаза 10 — Интерфейс, часть 1: каркас, трей, мастер

1. **Пакет `desktop/`** на Electron (D5), версия закреплена.
   - Main-процесс подключается к демону общим транспортом на MCP SDK Client и при необходимости
     поднимает демон.
   - Renderer грузит только локальные файлы: contextIsolation, sandbox, без nodeIntegration,
     строгий CSP, IPC по белому списку, никаких удалённых URL.
2. **Трей:** цвет по `system_status`; меню — открыть, перестроить индекс, остановить демон, выход.
3. **Мастер первого запуска:**
   - папка проектов;
   - найденные клиенты с галочками;
   - модель: скачать с прогрессом и отменой, импортировать из папки или пропустить;
   - индексация с прогрессом;
   - экран «готово, что дальше».
4. **Экран «Статус»:** проверки health с деталями и рекомендациями.
5. **Языки:** русский и английский (D6).
6. **Тесты.** Playwright `_electron` под xvfb. Если бинарь Electron не скачивается — тестировать
   renderer в Chromium с мок-API, а живой запуск Electron вынести в чек-лист владельца. Скриншоты —
   в отчёт.

Критерии приёмки:
- мастер проходит до конца на реальном демоне (синтетическая модель или импорт);
- отмена загрузки оставляет консистентное состояние;
- без демона — понятный экран с кнопкой «запустить»;
- тест подтверждает, что у renderer нет доступа к Node и файловой системе;
- тесты `desktop/`, `check`, `acceptance`, `upgrade:test` зелёные.

### Фаза 11 — Интерфейс, часть 2: данные, настройки, консоль

1. **Экраны:**
   - «Проекты»: список и карточка — задачи, эпики, решения, передачи между сессиями;
   - «Расходы»;
   - «Навыки»: поиск по каталогу и просмотр;
   - «Настройки»: профили, пути, зеркало модели, автозапуск демона;
   - «Журнал».
2. **«Консоль инструментов».** Форма строится по `inputSchema`. Инструменты, которые что-то
   меняют, требуют подтверждения; результат виден и читаемо, и как JSON.
3. **На каждом экране:** пустые состояния, загрузка, ошибки; работа с клавиатуры и контраст.

Критерии приёмки:
- Playwright-сценарий на каждый экран зелёный, скриншоты — в отчёт;
- инструмент только для чтения вызывается без подтверждения, пишущий — только после (тест);
- `check`, `acceptance`, `upgrade:test` зелёные.

### Фаза 12 — Установщик Windows

Решение D7.

1. **electron-builder NSIS**, установка для текущего пользователя без прав администратора. Состав:
   - приложение из `desktop/`;
   - portable `node.exe` — Node 24 LTS (или 26, если к моменту сборки она уже LTS), версия и
     sha256 закреплены и сверяются при сборке;
   - dist из фазы 7, урезанный под win32-x64: у onnxruntime-node только win32/x64;
     onnxruntime-web и sharp-wasm32 убрать, если импорт это позволяет (проверить).
2. **Стабильная точка входа для MCP-клиентов.** Путь в конфигах не меняется при обновлении, а
   обновление не упирается в файлы, заблокированные работающими клиентами (например,
   версионированный рантайм за стабильным лаунчером). Схему описать.
3. **Первый запуск:** seed разворачивается в пользовательское хранилище, открывается мастер.
4. **Автообновление** — electron-updater, канал — GitHub Releases прода. Подпись — через
   переменные окружения.
5. **Сборка.** `npm run dist:win` — одна команда на Windows-машине. Workflow для windows-latest.
6. **Удаление:** программа и, после вопроса, записи в клиентах; пользовательские данные — по
   выбору.

Критерии приёмки:
- в песочнице тест проверяет конфигурацию сборки и состав пакета (список файлов, размер);
- если NSIS на Linux не собирается — пишешь «не проверено»;
- в чек-лист владельца — главное. Чистая Windows 11 (Windows Sandbox или VM) без Node, Python и
  Docker:
  - установка без администратора;
  - мастер;
  - Claude Desktop и Cursor видят `ai-dev`, `begin_task` отвечает;
  - модель скачивается с прогрессом;
  - обновление на следующую версию при запущенном клиенте;
  - удаление.
  Время каждого шага.

### Фаза 13 — Docker как серверный режим

Закрывает Д-89, Д-99, Д-105, Д-108 и Docker-часть Д-103.

1. **Dockerfile из dist**, без python3 и без legacy. Реестр и индекс строятся при сборке образа.
   Замерить время от `docker run` до ответа на `initialize`.
2. **Конфиги клиентов** вызывают `docker run -i --rm …` напрямую.
   - Пишет их модуль из фазы 6: `ai-dev clients install --docker`.
   - `bootstrap.sh/ps1` сводятся к: проверить Docker → `docker pull` → установщик конфигов.
     Монтируются только папки конфигов клиентов, а не весь `$HOME`.
3. **Старые лаунчеры не удалять (D10).** На `run-mcp.sh`, `run-mcp.ps1`, ClaudeMcpProxy и их копии
   в `C:\ProgramData\AI-Dev-System` ссылаются конфиги пользователей. Они остаются тонкими
   совместимыми обёртками с предупреждением в stderr.
   - Подмену `initialize` убрать, если холодный старт укладывается в таймаут Claude Desktop
     (замерить).
   - Если не укладывается — заглушка берёт настоящие `instructions` и версию из образа.
4. **Образ сохраняет опору 2.x:** `/opt/ai-dev/app/src/server.mjs`, CMD со stdio-сервером,
   раскладку тома `/data`, имена переменных.
5. **Модель в Docker.** Один раз `docker run … --network bridge <образ> ai-dev model install` в том
   `/data`: с прогрессом и вместе с векторами документов. Дальше — `--network none`.
6. **Seed в томе** обновляется по манифесту из фазы 7 вместо `cp -n`.
7. **Хуки в Docker-режиме:** состояние хуков и сервера сходится в одном месте. Решение и риски —
   описать.
8. **Chromium для frontend-qa** — отдельный вариант образа или в основном. Решение обосновать
   размером.
9. **Д-108, теги (D9):** `:latest` — только с тегов `v*`; main → `:edge`; `:2` — замороженная
   линия.

Критерии приёмки:
- образ собирается. Если зеркала закрыты — взять доступную базу, а остальное — в «не проверено»;
- ответ на `initialize` содержит `instructions`; холодный старт — цифрой;
- модель подключается через том (синтетическая);
- после обновления образа skills в томе обновлены;
- старые лаунчеры 2.x работают с новым образом (тест или сценарий);
- `check`, `docker:smoke`, `acceptance`, `upgrade:test` зелёные;
- в чек-лист владельца: Windows + Docker Desktop + Claude Desktop.

### Фаза 14 — Документация и финальная приёмка

1. **README и INSTALL (EN/RU)** строятся вокруг трёх путей: установщик Windows, `npx` одной
   командой, Docker. Всё устаревшее убрать. GUARDRAILS, WORKFLOW, CAPABILITIES и ARCHITECTURE
   привести в соответствие.
2. **AGENTS.md и CONTRIBUTING.md:** новые места кода (`bin/`, `desktop/`, dist), поток веток;
   устаревшее убрать.
3. **Тест-планы.** `TEST-PLAN*.ru.md` заменить одним коротким планом ручной приёмки: 3 ОС,
   30–45 минут.
4. **`packaging/`:** удалить brew и AUR (D8).
5. **CHANGELOG и миграция.** Раздел 3.0.0 и заметка о миграции 2.x → 3.0 (EN/RU) — на основе
   разделов «Влияние на прод» из отчётов фаз.
6. **Реестр.** Д-85…Д-108 закрыты или перенесены с обоснованием.

Критерии приёмки:
- проверка ссылок в документации — 0 битых;
- команды из README дословно выполнены в чистом контейнере;
- `check`, `acceptance`, `upgrade:test` зелёные.

### Фаза 15 — Подготовка выкатки в прод

В прод ничего не пушить и не публиковать.

1. **Синхронизация.** Влить свежий `origin/main` форка, разрешить конфликты; `check` и
   `upgrade:test` зелёные.
2. **Полный тест обновления с прода.**
   - Локальный путь: 2.x → состояние → обновление.
   - Docker-путь: образ 2.x с тёплым контейнером и старыми лаунчерами → новый образ. Если образы
     недоступны — сценарий для CI прода и для владельца.
   - Откат на 2.x: проверить или описать.
3. **`docs/RELEASE.md` (EN) и `docs/ru/RELEASE.md`:**
   - PR `форк:Dev → прод:main` и условия для него: CI прода зелёный на всех ОС, dense-eval с
     настоящими весами пройден;
   - теги образа (D9) и момент переключения `:latest`;
   - npm (D4), установщик и подпись (D7);
   - заметка о миграции;
   - чек-листы выкатки и отката с точными командами.
4. **Черновик релизных заметок.** Решение по `docs/program/` (D11) — вопросом в итоговом отчёте.

Критерии приёмки:
- `upgrade:test` (локальный) зелёный; Docker-путь — в CI прода или в чек-листе владельца;
- откат проверен или описан;
- каждая непубликующая команда чек-листа выполнена в песочнице;
- `check` и `acceptance` зелёные.

## 9. Отчёты

### 9.1 Отчёт фазы — в описание PR фазы

    ## Отчёт фазы <N>: <название>
    Статус: готово | частично | заблокировано
    PR: <ссылка> · head <sha> · старт от Dev @ <sha>
    Объём: <последняя строка git diff --stat origin/Dev...HEAD>
    ### 1. Пункты: | # | Пункт | ✅/⚠️/❌ | Где (файл:строка, коммит) | Комментарий |
    ### 2. Дефекты: | № | «до»: команда → вывод | «после»: команда → вывод | Статус |
    ### 3. Критерии приёмки: | Критерий | Команда | Фактический вывод | ✅/❌ |
    ### 4. Проверки: npm run check (tests/pass/fail/skipped); «N падений из 10»; upgrade:test;
        пробы сервера (минимум 3, одна — «чего не должно быть»); строки mcp-stdio.mjs / потолок;
        ревью диффа: что найдено и что исправлено
    ### 5. Не проверено: | Что | Почему | Как проверить |
    ### 6. Отступления и принятые решения
    ### 7. Влияние на установки 2.x: что меняется; что мигрирует само и каким тестом доказано;
        что требует действия пользователя (текст для заметки о миграции); как откатиться
    ### 8. Для следующих фаз и в чек-лист владельца

### 9.2 Итоговый отчёт — последнее сообщение сессии

    # Итоговый отчёт программы
    1. Фазы: | Фаза | Статус | PR | Ключевые замеры |
    2. Дефекты Д-85…Д-108: | № | Статус | Замер «после» или причина переноса |
    3. До и после:
       - установка с нуля: команды и время;
       - работа без Python;
       - латентность поиска;
       - модель: загрузка и докачка;
       - память при трёх клиентах;
       - размер установщика;
       - холодный старт Docker.
    4. Не проверено: | Что | Почему | Как проверить |
    5. Решения, принятые по умолчанию (D*), и отступления; где их поменять
    6. Вопросы владельцу, включая D11
    7. Чек-лист ручной проверки владельца, собранный из всех фаз, по ОС: шаги и ожидаемый результат
    8. Что владельцу сделать дальше: проверки → черновой PR в прод → выкатка по RELEASE.md

### 9.3 Форма ручной проверки (её заполняет владелец)

    ## Ручная проверка: <фаза или итог>
    Машина: <ОС, версия> · чистая: да/нет (что стояло: Node, Python, Docker, клиенты)
    Что проверял: Dev @ <sha>
    | Шаг | Что сделал | Что увидел (дословно или скриншот) | Время | ✅/❌ |
    Ошибки дословно; логи; что было непонятно без подсказки
