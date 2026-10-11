# Отчёт фазы 4: Поиск на Node, часть 2: hybrid, векторы, без Python

Статус: готово. CI-джоб «без Python» на macOS и Windows написан по документации и проверен только на Linux (CI форка не стартует) — в чек-лист владельца
PR: — работа идёт прямо в `main` форка по указанию владельца 2026-10-10 (PROGRESS, «Отступления»)
· код фазы — head `cc6e69c` · старт от `main` @ `b709e89` (конец фазы 3)
Объём: `b709e89..cc6e69c` — 68 files changed, 3529 insertions(+), 3806 deletions(-) (из них `src` и `scripts` — 43 files, 2767 insertions(+), 1065 deletions(-)); удалён `search-index/search_cli.py`, 1 820 строк

### 1. Пункты

| # | Пункт | Статус | Где | Комментарий |
|---|---|---|---|---|
| 1 | Hybrid, dense-plan и запись векторов — в Node; векторы из воркера пишутся прямо в индекс | ✅ | `src/core/search-hybrid.mjs` (485 строк), `dense-index.mjs`, `search-index.mjs`; `f0d7a93`, `6cdeba2` | dense-plan и запись векторов перенесены ещё в фазе 3; hybrid — порт `hybrid_search` с кэшем разобранных векторов по хешу содержимого; legacy-бэкенд эмбеддит через воркер (со своими папкой модели и устройством — Д-138), пишет Node |
| 2 | `search_knowledge` — через индекс, формат ответа прежний | ✅ | `src/core/search-knowledge.mjs`; `f0d7a93`, `f1949a0` | `{ path, score, preview }`, та же оценка; что ищется теперь и чего не находит — раздел 6, п. 3 (Д-142) |
| 3 | Python уходит: `search_cli.py` и его тесты удалены; `pythonCommand` — только для опционального; `query_ui_ux_knowledge` без Python — честная ошибка, отметка в `doctor` и в документации профиля frontend | ✅ | `f0d7a93`, `dd6a3d3`; `src/core/python-failure.mjs`, `python-command.mjs`, `system-health.mjs`, `extensions/system.mjs`; `docs/CAPABILITIES.md` (EN/RU) | 6 оставшихся случаев `test_search_freshness.py` — в `search-freshness.test.mjs`; Python запускают только два инструмента UI UX Pro Max (не один — раздел 6, п. 1) и legacy-бэкенд векторов; проверка здоровья — `ok` только если интерпретатор ответил `--version` как Python 3 (Д-139); grep — раздел 4 |
| 4 | Health и `doctor` работают без Python | ✅ | `npm run doctor` без Python | 24 проверки, `ok`; `ui_ux_knowledge` — `skipped` (необязательная) |
| 5 | CI: джоб «чистая машина без Python» на ubuntu, macos и windows — `npm ci`, `setup`, `doctor`, protocol smoke | ⚠️ | `.github/workflows/ci.yml` (`no-python`), `scripts/no-python-check.mjs`, `src/core/python-free-path.mjs`; `f0d7a93`, `b1d7b46` | на Linux проверен в песочнице, на macOS и Windows — по документации и тестам на подменённом `platform`: CI форка не стартует (раздел 5) |
| 6 | Документация EN/RU: «Node.js 22.13+ и больше ничего»; CONTRIBUTING без Python | ✅ | `7d0a395`, `f1949a0`: README, INSTALL, CAPABILITIES (EN/RU), README сервера, ARCHITECTURE, CONTRIBUTING, UPGRADE-TEST (EN/RU), `docker/README.md` | «22.16+» вместо «22.13+» — отступление фазы 3 |
| — | Галактика знаний без Python | ✅ | `src/core/galaxy-export.mjs` (241 строка); `extensions/galaxy.mjs` | экспорт в памяти, байт в байт как у помощника |
| — | `npm run search:parity` после удаления помощника | ✅ | `scripts/search-parity.mjs` | берёт помощник из истории git; сверяет файлы, поиск по словам, hybrid (с dense и без) и галактику |
| — | Дефекты, найденные в фазе: Д-133 (`embed_texts`), Д-134 (тест Д-128 под нагрузкой), Д-135 (датировка реестра) | ✅/⚠️ | `46c7619`, `9a01449`; `ef99574`, `d4cd375` | Д-133 и Д-134 закрыты; Д-135 — дефект фазы 3, записан на фазу 7 (правило 4 брифа) |
| — | Правки по независимому ревью | ✅ | `4c25f1b` (запись), `00c1cc6` … `cc6e69c` | одна «must-fix», четыре «should-fix», три замечания — все подтверждены замером и исправлены, Д-136 … Д-142 (раздел 4) |

### 2. Дефекты

| № | «до»: команда → вывод | «после»: команда → вывод | Статус |
|---|---|---|---|
| Д-85 | PATH без Python: после фазы 3 Health fail только `hybrid_smoke_no_dense`; по MCP отказывают `hybrid_search`, `preset_search`, `explain_search`, `render_knowledge_galaxy`, `query_ui_ux_knowledge` (`spawn python3 ENOENT`), `run_search_eval` — 0 из 45 | `node scripts/no-python-check.mjs` в чистом worktree `cc6e69c`, пустой HOME: `npm ci`; `setup` — 4 built, 0 failed, Health ok 24/24; `doctor` ok; protocol smoke pass; 17 с. По MCP отвечают все 13 поисковых инструментов, `search_knowledge`, галактика, `prepare_project`, `refresh_project_memory`; `run_search_eval` 38 из 45 | закрыт |
| Д-98 (питоновская часть) | `rebuild_search_index {dense_embeddings}` без модели → `spawn …/embeddings/.venv/bin/python ENOENT` (по коду, `babb7e2`) | → «Dense vectors were asked for, but no embedding model can run here. Dense search is not installed. Run `npm run setup -- --dense` …»; `built_at` и число документов индекса не изменились | открыт: остальное — фаза 5 (менеджер модели) |
| Д-102 | `search_knowledge`, 15 вопросов × 2: seed — медиана 233 мс; полный каталог 2.x — 439 мс | seed — 3 мс (p90 4); полный каталог — 10 мс (p90 18) | закрыт |
| Д-117 (hybrid) | `hybrid_search("frontend AND backend testing")` → `keyword_score` 0 у всех 10 | у 7 из 10 `keyword_score` > 0 | закрыт |
| Д-133 | ONNX выбран: `embed_texts` → «BGE-M3 Python runtime not found», ONNX вызван 0 раз; без модели — та же ошибка | ONNX выбран: вектор от ONNX; без модели — «Dense search is not installed. Run `npm run setup -- --dense` …» | закрыт |
| Д-134 | `npm run acceptance` → «3 падения из 10», тест Д-128; копия теста с паузой 25 мс перед правкой — 10 из 10 падают | пауза 0, 25 и 500 мс — по 10 из 10 проходят; acceptance на `cc6e69c` — «0 падений из 10» | закрыт |
| Д-135 | правка skill сразу после того, как перестройка запомнила время, — не видна в 299 из 300; ни один тест датировку реестра не проверяет | — | открыт: фаза 7 |
| Д-136 | `cp -a … search-index …` из `package()` PKGBUILD → exit 1; `packaging:check` passed | copy exit 0; `packaging:check` падает на пути, которого нет в репозитории | закрыт |
| Д-137 | без Python `server.test.mjs` → fail 1 | без Python весь набор: 1 521 тест, 0 упали | закрыт |
| Д-138 | legacy-перестройка: в запросе к эмбеддеру нет `model_dir` и `device` | `"model_dir":"/custom/bge-m3","device":"cuda"` | закрыт |
| Д-139 | `AI_DEV_PYTHON=/nonexistent/bin/python3`: `doctor` → `ui_ux_knowledge: ok` | → `skipped … "/nonexistent/bin/python3" is not there`; настоящий `python3` → `ok … (Python 3.13.16)` | закрыт (заглушка Store — по документации) |
| Д-140 | мутация «перечитать всё при любом изменении» — 11 из 11 тестов проходят | четыре мутации — каждая роняет свой тест; без мутаций 14 из 14 | закрыт |
| Д-141 | Node 22.15: `prepare_project`, `refresh_project_memory` → ошибка, файлы проекта уже записаны | `prepared` / `memory_refreshed`, `search_index: {skipped: "Search needs Node.js 22.16 …"}` | закрыт |
| Д-142 | 149 из 515 файлов, которые читал 2.x, не ищутся, и сказано об этом не всё | описание инструмента, заголовок модуля, Д-102, CHANGELOG, CAPABILITIES (размер схемы +11 байт) | закрыт документацией |

### 3. Критерии приёмки

| Критерий | Команда | Фактический вывод | ✅/❌ |
|---|---|---|---|
| Без Python: setup — 0 failed | `node scripts/no-python-check.mjs` (чистый worktree `cc6e69c`, пустой HOME) | `4 built, 3 skipped, 0 failed.` `Health: ok — 24 check(s), 0 not passing.` | ✅ |
| Без Python: `doctor` ok по всем проверкам | там же, `npm run -s doctor` | `status: ok`; 19 `ok`, 5 `skipped` (frontend_qa_environment, ui_ux_knowledge, embedding_backend, dense_smoke, search_eval — необязательные или выключенные флагами), 0 fail/warn | ✅ |
| Без Python: все 13 поисковых инструментов и `search_knowledge` отвечают | `measure2.mjs` по MCP, PATH без Python | 12 отвечают результатом; `embed_texts` без модели — «Dense search is not installed. Run `npm run setup -- --dense` …» (модели в песочнице нет); `search_knowledge` — 50 результатов | ✅ |
| `search_knowledge` ≤ 100 мс (было ~2,5 с) | там же, 15 вопросов × 2, тёплый сервер | seed — медиана 3 мс; полный каталог 2.x — 10 мс | ✅ |
| `hybrid_search` без dense ≤ 100 мс (было ~0,42 с) | там же | seed — медиана 11 мс; полный каталог 2.x — 21 мс (было 141 и 316, процесс Python на каждый вызов) | ✅ |
| grep по базовому пути не находит вызовов python | grep — раздел 4 | в коде поиска, setup и doctor запуска Python нет; остались UI UX Pro Max, legacy-бэкенд векторов (`--dense-python`), проба `--version` для проверки здоровья и dev-сверка | ✅ |
| Golden cases не хуже, чем в фазе 3 | `run_search_eval` по MCP | 38 из 45, MRR 0,514 (фаза 3: 37 из 45, MRR 0,510; перед фазой 4 с Python — 38 из 45) | ✅ |
| `check`, `acceptance`, `upgrade:test` зелёные | раздел 4 | check — 1 521 тест, 0 упали; acceptance — «0 падений из 10» на `cc6e69c`; upgrade:test — 62 из 62 | ✅ |
| В чек-лист владельца: чистая Windows без Python — клон, `npm ci`, `setup`, `doctor` | — | раздел 8 | ✅ |

### 4. Проверки

- `npm run check` на `cc6e69c`: exit 0; 1 521 тест, 1 504 прошли, 0 упали, 17 пропущены; покрытие строк 97,51 %
  (в конце фазы 3 — 1 480 тестов, 97,40 %). Тот же набор (`node --test`) при спрятанном Python — 1 521, 0 упали.
- `npm run acceptance`: «0 падений из 10» на итоговом коде `cc6e69c` (прогоны 46–51 с, под нагрузкой: параллельно
  шли `upgrade:test`, проверка «без Python» в чистом worktree и пробы). Первый прогон, на `25d1cab`, — «3 падения из 10»:
  тест Д-128 (Д-134, ниже).
- `npm run upgrade:test`: 62 из 62 за 90 с на `cc6e69c` (три пользователя: по умолчанию, `AI_DEV_HOME`, том Docker);
  hybrid читает индекс, который держит обновлённый сервер; векторы 2.x — байт в байт.
- Минимальная Node: релизная сборка 22.16.0, `test:core` — 1 234 теста, 0 упали, 3 пропущены.
- `npm run search:parity` (помощник из истории git, `353feff`): seed (831 документ) и полный каталог 2.x
  (3 443) — все таблицы индекса без различий; поиск по словам — golden 85 из 85, заголовки 300 из 300;
  hybrid — 385 из 385 ответов поле в поле, с синтетическими dense-векторами — 85 из 85; галактика —
  `nodes.json`, `semantic.f32`, `dense.f32` байт в байт.
- Пробы по MCP на итоговом коде (SDK Client, PATH без Python, чистая копия seed): 8 из 8; «чего быть не
  должно» — все, кроме первой:
  1. `hybrid_search("frontend AND backend testing")` — у 7 из 10 `keyword_score` > 0 (Д-117);
  2. `search_knowledge` не отдаёт Membrane и файлы проектов вне хранилища; ответ в форме 2.x;
  3. `render_knowledge_galaxy` без Python — HTML записан;
  4. инструменты UI UX без Python — честная ошибка, без «spawn python3 ENOENT» и стека;
  5. перестройка с dense без модели — отказ с командой, индекс не тронут (`built_at` тот же);
  6. `embed_texts` без модели — не про Python-рантайм (Д-133);
  7. новая заметка находится, а после правки её старые слова — нет (свежесть и кэш; правка снаружи сервера
     видна через ≤ 1 с — раздел 6, п. 3);
  8. на Node 22.15 поиск отвечает нужной версией Node, а не уходит в Python.
  Отдельно: на Node 22.15 `prepare_project` и `refresh_project_memory` — `prepared`/`memory_refreshed` с
  `search_index.skipped` (Д-141); `doctor` с `AI_DEV_PYTHON` на несуществующий путь — `ui_ux_knowledge: skipped` (Д-139).
- grep по базовому пути (все места, где сервер может запустить Python):

  ```
  src/extensions/system.mjs        resolvePythonCommand() → probePython: `--version` для проверки здоровья UI UX
  src/mcp-stdio.mjs                runUiUxProMax — query_ui_ux_knowledge, generate_ui_ux_design_system
  src/mcp-stdio.mjs, src/core/embedding-workers.mjs   embeddingPythonCommand — legacy-бэкенд векторов
  scripts/first-run.mjs            `--dense-python` — venv legacy-бэкенда
  scripts/search-parity.mjs        dev-сверка с помощником из истории git
  src/core/search-*.mjs, src/core/galaxy*.mjs, src/extensions/search.mjs, src/extensions/galaxy.mjs — ни одного запуска процесса
  ```
- `src/mcp-stdio.mjs`: 4 869 строк при потолке 5 076 (на старте фазы 4 891, на старте программы 4 914);
  новые модули ≤ 800 строк; `lint` и `security` чисты; `docker:prepare` и `docker:audit` прошли — в
  контексте сборки нет `search-index`.
- **Ревью диффа.** Независимый субагент прочитал `353feff..7d0a395`, гонял свою сверку с помощником
  (734 случая × 4 индекса: фильтры, веса, лимиты, без dense-таблицы, с выключенным dense; ещё 270 —
  CJK, эмодзи, длинные вопросы, BOM, кавычки — единственные расхождения — Д-117) и в репозитории ничего не
  менял. Нашёл одну «must-fix», четыре «should-fix» и три замечания; три других, которые он нашёл бы,
  уже были исправлены после `7d0a395` (Д-133, скрипты Python в зеркале PATH, CHANGELOG фазы 3). Каждая
  находка воспроизведена здесь своим замером, записана до правки (`4c25f1b`, Д-136 … Д-142) и исправлена:
  - рецепты AUR и Homebrew копировали удалённый `search-index` — сборка пакета падала (Д-136);
  - `server.test.mjs` требовал Python (Д-137);
  - legacy-перестройка теряла `dense_model_dir` и `dense_device` (Д-138);
  - проверка здоровья UI UX — `ok` для интерпретатора, которого нет (Д-139);
  - тест кэша hybrid считал не то; чтение пачкой, нулевые веса и откат без тестов (Д-140);
  - на Node без FTS5 `prepare_project` и `refresh_project_memory` падали, успев записать файлы (Д-141);
  - сужение `search_knowledge` описано не всё; CONTRIBUTING про помощник (Д-142).
  Его предупреждение о риске CI: Windows-половина джоба впервые прогонит `setup` и `doctor` на Windows и
  требует `status: ok` — любая посторонняя Windows-проблема здоровья его уронит. Оставлено строгим
  намеренно: это и есть критерий фазы; в чек-листе владельца.
- **Acceptance нашёл и своё.** Первый прогон acceptance на `25d1cab` — «3 падения из 10», каждый раз тест
  Д-128 из фазы 3: его поддельные часы стояли раньше записи, которую он проверяет (Д-134, исправлено). Разбор
  вскрыл дефект продукта той же фазы — датировку реестра точными часами (Д-135, на фазу 7).

### 5. Не проверено

| Что | Почему | Как проверить |
|---|---|---|
| Джоб `no-python` на macOS и Windows | CI форка не стартует; macOS и Windows в песочнице нет | черновой PR в прод (D0, открывает владелец) — джобы `No Python (macos-latest)` и `No Python (windows-latest)` зелёные; или руками: `node scripts/no-python-check.mjs` на чистой машине |
| Заглушка Microsoft Store как `python` на Windows (Д-139) | Windows нет | чистая Windows без Python: `npm run doctor` → `ui_ux_knowledge: skipped … did not run as Python 3 (Python was not found; …)` |
| `embed_texts` и hybrid с настоящей ONNX-моделью без Python | huggingface.co — 403, весов нет | после `npm run setup -- --dense`: `embed_texts {text: "hello"}` → 1024 измерения, `backend: onnx`; `hybrid_search` с dense |
| Сборка Docker-образа без `search-index` | `deb.debian.org` — 403, образ не собрать | `npm run docker:build && npm run docker:smoke` (контекст собран и проверен аудитом: `docker:prepare`, `docker:audit`) |
| Том 2.x со ссылкой `09-mcp/search-index` на удалённый каталог образа | образ 2.x не скачать (слои ghcr — 403) | сценарий `docs/UPGRADE-TEST.md`; проба на модели тома здесь: висячая ссылка — индекс 1 документ, stale false |
| Сборка пакетов AUR и Homebrew | `makepkg` и `brew` в песочнице нет; оба не опубликованы и удаляются в фазе 14 (D8) | `makepkg -si` в Arch; список копирования здесь — exit 0 |

### 6. Отступления и принятые решения

1. **Python запускают два инструмента, а не один.** Бриф называл `query_ui_ux_knowledge`; той же
   питоновской функцией пользуется `generate_ui_ux_design_system`. Оба получают одну честную ошибку,
   одну проверку здоровья (`ui_ux_knowledge`) и одну строку в документации.
2. **Python в Docker-образе остаётся до фазы 13** — ради этих двух инструментов и legacy-бэкенда;
   удалён только каталог помощника. Бриф фазы 13 требует образа без python3 — тогда инструменты UI UX
   в Docker станут недоступны, или их поиск (BM25 по CSV набора) нужно перенести на Node: вопрос
   владельцу (раздел 8).
3. **`search_knowledge` — по индексу, и находит меньше** (Д-142): оценка та же, но текстом skill
   считаются его запись в реестре и карточка, а справочники skill (их читает `read_skill`), страницы
   `groups/all-skills`, `registries/*.md` и заметки в папках `build`, `env`, `venv`, `.next` и подобных — не
   ищутся: на seed 149 из 515 файлов, которые читал 2.x. Это следствие решения брифа «через индекс»;
   оно описано в описании инструмента и в документации. Свежесть — как у остальных инструментов поиска:
   правка через сервер видна сразу, правка снаружи — не позже чем через секунду.
4. **Hybrid отвечает как помощник, кроме Д-117**, — сознательно: `AND`/`OR`/`NOT`/`NEAR` в вопросе —
   слова, как уже в поиске по словам.
5. **Проверка «без Python» строже брифа.** Кроме интерпретаторов она прячет скрипты, которые запускает
   Python (`pip3`, `lsb_release`, `semgrep`), а на Windows — папки с `pip.exe`: на машине без Python их
   нет, а по абсолютному пути в первой строке они запустили бы интерпретатор.
6. **`AI_DEV_SEARCH_ENGINE` удалён.** Он появился в фазе 3 как путь назад к помощнику и в релиз не
   попадал.
7. **Локальный установщик клиентов по-прежнему пишет `AI_DEV_PYTHON`** — теперь это интерпретатор
   только для инструментов UI UX. Модуль записи конфигов переписывается в фазе 6; там и решится,
   писать ли его вовсе.
8. **Д-133 найден и закрыт в фазе**: его нашёл замер инструментов без Python, а закрыть его входит в
   питоновскую часть Д-98. **Д-134** закрыт в фазе, потому что держал её ворота; **Д-135** — дефект фазы 3,
   найденный при разборе Д-134, — по правилу 4 брифа записан на фазу 7, где seed обновляется по манифесту
   и свежесть реестра проверяется на каждом обновлении.

### 7. Влияние на установки 2.x

- **Что меняется.** Python для поиска, setup и doctor больше не нужен; на Node без FTS5 поиск отвечает
  ошибкой с нужной версией, а `prepare_project` и `refresh_project_memory` работают и сообщают, что
  индекс пропущен. `search-index/search_cli.py` удалён из клона и из образа (`/opt/ai-dev/search-index`);
  ссылка `09-mcp/search-index` в существующем томе остаётся висячей, индекс её пропускает.
  `AI_DEV_PYTHON` в конфигах клиентов продолжает работать — для инструментов UI UX. Legacy-бэкенд векторов
  работает как прежде: эмбеддит воркер на Python со своими папкой модели и устройством, пишет Node.
  `search_knowledge` находит меньше файлов (раздел 6, п. 3).
- **Что мигрирует само и каким тестом доказано.** Формат индекса не менялся: индекс 2.x читается как
  текущий, с векторами (`upgrade:test`, три пользователя), а сервер 2.x после отката читает индекс,
  записанный Node (`search:parity`: все таблицы совпадают строка в строку).
- **Что требует действия пользователя** (для заметки о миграции): после `git pull` перезапустить
  клиентов — сервер 2.x, запущенный до обновления, зовёт удалённый помощник, и его поиск отказывает до
  перезапуска. Python можно удалить, если не нужны инструменты UI UX Pro Max и legacy-векторы.
- **Как откатиться.** `git checkout` прежнего коммита и `npm ci`: помощник 2.x вернётся вместе с
  кодом и прочитает индекс как есть; Python для него понадобится снова.

### 8. Для следующих фаз и в чек-лист владельца

- Фаза 5: остальное Д-98 (менеджер модели, `setup -- --dense` не идёт дальше после неудачной загрузки,
  `dense:doctor`); удаление legacy-бэкенда — с ним уходят `embeddingPythonCommand`, `embedding-workers`
  и ветка Python в `embed_texts`; сквозной тест синтетической ONNX-моделью закроет и «не проверено»
  про `embed_texts`.
- Фаза 6: писать ли `AI_DEV_PYTHON` в конфиги клиентов (раздел 6, п. 7).
- Фаза 7: Д-135 — датировать реестр с запасом на шаг часов файловой системы и тест, который ловит
  выключенную датировку.
- Фаза 13: образ без python3 — решить судьбу двух инструментов UI UX в Docker (раздел 6, п. 2).
- **Вопрос владельцу.** Перенести поиск UI UX Pro Max (`search.py`: BM25 по CSV набора) на Node, чтобы
  Python не был нужен вовсе и образ фазы 13 обошёлся без python3, — или оставить эти два инструмента
  необязательными, с честной ошибкой без Python?
- Чек-лист владельца:
  - чистая Windows без Python: клон, `cd ai-dev-mcp-server`, `npm ci`, `npm run setup` (0 failed, Health
    ok), `npm run doctor` (`ok`, `ui_ux_knowledge` — skipped, с причиной про заглушку Store, если она
    есть), `node scripts/no-python-check.mjs --skip-install` — «No Python: … all passed»;
  - на черновом PR в прод: джобы `No Python (ubuntu-latest | macos-latest | windows-latest)` зелёные;
    если Windows-половина красная на проверке здоровья, не связанной с Python, — это находка о Windows,
    а не о Python;
  - macOS без Homebrew-Python: `npm run setup` и `npm run doctor`, как выше.
