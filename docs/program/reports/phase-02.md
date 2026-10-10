# Отчёт фазы 2: Быстрые исправления и тест обновления

Статус: в работе — ждёт `npm run acceptance` (черновик отчёта)
PR: — работа идёт прямо в `main` форка по указанию владельца 2026-10-10 (PROGRESS, «Отступления»)
· head — после ворот · старт от `main` @ `d545d48`
Объём: на `263b5ef` — 70 files changed, 3265 insertions(+), 560 deletions(-) (без отчёта и правок по ревью)

### 1. Пункты

| # | Пункт | Статус | Где | Комментарий |
|---|---|---|---|---|
| 1 | Д-86: `npm install`/`npm ci` без `--ignore-scripts` | ✅ | `ai-dev-mcp-server/.npmrc`, `39356ec`; документация и CI — `2a8b122` | `ignore-scripts=true` вместо `onnxruntime-node-install=skip` (отступление 1); флаг убран из README, INSTALL EN/RU, README сервера, `docker/README.md`, CONTRIBUTING, трёх TEST-PLAN; CI — простой `npm ci`; Dockerfile флаг сохраняет (в контексте сборки нет `.npmrc`); `packaging:check` стережёт и `.npmrc`, и страницы |
| 2 | Д-87: lockfile через `npx npm@11.17.0`, override sharp | ✅ | `ai-dev-mcp-server/package-lock.json`, `package.json`, `39356ec` | 0 дублей, один onnxruntime-node 1.30.0, `npm ls sharp` → 0.35.4 без override, `npm run security` зелёный |
| 3 | Д-88: прокси монтирует `/models` и отвергает старое значение; контрактный тест | ✅ | `docker/ClaudeMcpProxy.cs`, `scripts/model-mount-contract.test.mjs`, `3eacea4` | пять копий сверяются с Dockerfile; сборка и запуск прокси в Mono — 3 из 3, на старом — 0 из 3 |
| 4 | Д-90: одна семантика `AI_DEV_HOME`, миграция, `doctor` | ✅ | `src/core/runtime-home.mjs`, `runtime-home-migration.mjs`, `hooks/lib.mjs`, проверка `runtime_home`, `628ac6a` | `AI_DEV_HOME`, равный домашнему каталогу, сохраняет смысл 2.x (отступление 4); идентичность проекта не менялась |
| 5 | Д-91: Membrane по источнику | ✅ | `search-index/search_cli.py`, `src/core/skill-catalog.mjs`, `src/mcp-stdio.mjs`, `e15c598` | eligible 370 = 3 444 − 3 074 |
| 6 | Д-92: bootstrap ставит только движок | ✅ | `bootstrap.sh`, `scripts/bootstrap-contract.test.mjs`, `fe4321a` | Ubuntu 24.04 — в контейнере; Debian, Fedora, Arch — не проверено (раздел 5) |
| 7 | Д-93: frontend-qa по pnpm-lock, Chromium, без ✓ без браузера | ✅ | `src/core/frontend-qa-install.mjs`, `scripts/first-run.mjs`, `frontend-qa/frontend_qa_runner.mjs`, `29d2d12` | успешный путь проверен через локальное зеркало Chrome for Testing; Windows — по коду |
| 8 | Д-94: один выбор Python | ✅ | `src/core/python-command.mjs`, `4942a8f` | сервер, установщик и legacy-venv зовут одну функцию |
| 9 | Д-96: межпроцессная дозапись и RMW в обеих копиях | ✅ | `src/core/file-lock.mjs`, `atomic-files.mjs`, `hooks/lib.mjs`, хранилища, `a1d118d` | обрыв процесса: протухание по мёртвому pid, возрасту, пустой записи; оборванный хвост JSONL отрезается |
| 10 | `npm run upgrade:test` | ✅ | `scripts/upgrade-check.mjs`, `454b451`, `2a8b122`, `263b5ef`; `docs/UPGRADE-TEST.md` (EN/RU) | три пользователя: по умолчанию, `AI_DEV_HOME`, раскладка тома Docker; контейнерная половина — сценарием для CI |
| — | Д-112: `npm test` запускал тест обновления как модульный | ✅ | `263b5ef` | дефект самой фазы, найден на воротах, заведён и закрыт |
| — | Публикация образа — только из репозитория прода | ✅ | `.github/workflows/docker-publish.yml`, `2a8b122` | отступление 2 |
| — | Правки по независимому ревью | ✅ | `37d24cb` | шесть «should-fix» и пять замечаний исправлены, раздел 4 |

### 2. Дефекты

| № | «до»: команда → вывод | «после»: команда → вывод | Статус |
|---|---|---|---|
| Д-86 | чистый клон, `npm install --no-audit --no-fund` → `npm error command sh -c node ./script/install … ECONNRESET`, exit 1 за 24,3 с | тот же клон: npm 10.9.4 → exit 0, 136 пакетов, 11 с; `npx npm@11.17.0 install` → exit 0, 133 пакета, 13 с | закрыт |
| Д-87 | разбор с `object_pairs_hook` → 6 повторов ключей, 2 438 строк | 0 повторов, 2 158 строк; `npm ls onnxruntime-node --all` → одна 1.30.0 (deduped); `npm ls sharp --all` → 0.35.4 без override; `npm run security` → exit 0 | закрыт |
| Д-88 | `mcs` + записывающий `docker.exe` → `target=/models/bge-m3,readonly`, папка с `config.json` монтируется молча | `target=/models,readonly`; папка с `config.json` или `onnx/` → exit 1, Docker не запускался; пустая — exit 0 и предупреждение | закрыт |
| Д-90 | `AI_DEV_HOME=/x/.ai-dev` → `resolveRuntimeStateRoot()` `/x/.ai-dev/.ai-dev`, ONNX `/x/.ai-dev/.ai-dev/models/bge-m3-onnx` | `/x/.ai-dev`, `/x/.ai-dev/models/bge-m3-onnx`, хуки — `/x/.ai-dev`; `AI_DEV_HOME=HOME` → `~/.ai-dev`; upgrade:test: 6 файлов глубже → 0 | закрыт |
| Д-91 | `dense-plan` → eligible 3 444 из 3 444; `hybrid_search` по MCP: 7/1/2/0/0 коннекторов в top-10 | eligible 370 из 3 444; 0/0/0/0/0; интеграционный запрос — 8 из 10, slack #2, как и до | закрыт |
| Д-92 | `ubuntu:24.04`: `apt-get install -s docker.io docker-compose-plugin` → `Unable to locate package`, exit 100 | `bootstrap.sh --install-prerequisites`: root — docker.io 29.1.3, compose 0, дальше проверка движка; sudo-пользователь — exit 0, группа docker; без root и sudo — exit 69 | закрыт |
| Д-93 | пустой `PLAYWRIGHT_BROWSERS_PATH`: ✓ и exit 0, `doctor` warn; без pnpm — `?? frontend-qa/package-lock.json` | без pnpm на PATH: CDN закрыт → ✗, exit 1, `doctor` warn, lockfile npm не появился; зеркало → ✓ «Playwright Chromium is ready», `doctor` ok; повтор — `already built`; браузер удалён — шаг снова идёт | закрыт |
| Д-94 | `portablePaths({ platform: "win32" })` → `{"AI_DEV_PYTHON":"python3"}` | `{"AI_DEV_PYTHON":"python"}`; darwin и linux — `python3` | закрыт |
| Д-96 | 3 × 200: `atomicAppendFile` 208–223 из 600; RMW 202–222 из 600 | 10 прогонов подряд: append 600 ×10, JSONL 600 ×10, RMW 600 ×10, сервер+хук 600 ×10; `kill -9` одного писателя — 0 битых строк в 10 прогонах | закрыт |
| Д-111 | `cd frontend-qa && npx pnpm@11.9.0 --version` → 11.25.0 | — | открыт, фаза 13 |
| Д-112 | `npm run check` → `ok 9 - scripts/upgrade-test.mjs` 82,5 с, всего 1 м 44 с | 1 м 10 с, файла в выводе нет; страж `scripts/script-names.test.mjs` | закрыт |

### 3. Критерии приёмки

| Критерий | Команда | Фактический вывод | ✅/❌ |
|---|---|---|---|
| Замеры «до» Д-86 … Д-96 повторены и показывают исправленное | см. раздел 2 (Д-89 и Д-95 — не этой фазы) | девять записей закрыты с замером «после» | ✅ |
| `npm install` без флагов → exit 0 | чистый клон, пустой HOME, `npm install --no-audit --no-fund` | npm 10.9.4: exit 0; npm 11.17.0: exit 0 | ✅ |
| 3 × 200 → 600 строк в 10 прогонах подряд | `node d96-measure.mjs append 10` (и jsonl, rmw, mixed) | 600 в каждом из 10 прогонов, во всех четырёх режимах | ✅ |
| `kill -9` посреди записи не оставляет битых строк | `node d96-measure.mjs kill 10` | битых строк 0 в 10 прогонах, выжившие — 200 из 200 | ✅ |
| `upgrade:test` зелёный | `npm run upgrade:test` | `41 of 41 checks passed in 72 s.` (на `263b5ef`) | ✅ |
| `npm run check` зелёный | `npm run check` | exit 0: 1 354 теста, 1 337 pass, 0 fail, 17 skipped; покрытие строк 97,30 %; 1 м 7 с (на `37d24cb`) | ✅ |
| `npm run acceptance` зелёный | `npm run acceptance` | ждёт прогона после правок по ревью | — |

### 4. Проверки

- `npm run check` (на `37d24cb`): 1 354 / 1 337 / 0 / 17; покрытие строк 97,30 %, ветвей 85,32 %.
- `npm run acceptance`: идёт на `37d24cb` (прогоны 1 и 2 — ok, 70 и 67 с); итог — после десятого.
- `npm run upgrade:test`: 41 из 41 за 72 с на `263b5ef`; повтор на `37d24cb` — после acceptance.
- Пробы сервера по MCP (SDK Client, `scratchpad/p2/probes.mjs`), 7 из 7 как ожидалось:
  1. **Чего быть не должно:** два сервера пишут разом и теряют события расходов — 200 из 200
     `record_usage` в журнале, отказов 0. На коде до Д-96 (`39356ec`) та же проба: 94 из 200.
  2. **Чего быть не должно:** два сервера укрепляют один инстинкт и теряют обновление —
     `observations` 50 из 50. До Д-96: 35 из 50.
  3. Задача, которую 2.x положила на уровень глубже, после обновления находится через `get_task`.
  4. `doctor` (`system_health_check` → `runtime_home`) сообщает миграцию и называет конфликт: warn,
     «1 file(s) are still in …».
  5. **Чего быть не должно:** конфликт затирает текущий файл — текущий `{"pilots":["new"]}` цел,
     старая копия `{"pilots":["old"]}` на месте.
  6. **Чего быть не должно:** `AI_DEV_HOME=HOME` раскладывает дерево по домашнему каталогу — задача
     в `~/.ai-dev`, новых каталогов в домашнем нет.
  7. **Чего быть не должно:** `search_knowledge` отдаёт файлы коннекторов Membrane — 7 результатов,
     из каталога Membrane 0.

  Первая версия пробы 1–2 ошиблась дважды, и это была проба, а не продукт (AGENTS.md):
  `record_usage` отвергает выдуманный `task_id`, а почти одинаковые триггеры инстинктов сливаются
  в один. Исправленная проба: без `task_id` и 50 укреплений одного инстинкта.
- `src/mcp-stdio.mjs`: 4 898 строк при потолке 5 076 (на старте фазы — 4 914); модули `src/core`
  в пределах 800, `lint` чист.
- **Ревью диффа.** Независимый субагент прочитал весь дифф фазы (`d545d48..263b5ef`), прогнал
  пробы в scratchpad, в репозитории ничего не менял. Блокирующих находок нет; шесть «should-fix»
  и восемь замечаний. Каждое перепроверено здесь до правки; исправлено в `37d24cb`:
  - ротация журнала и дозапись в одном процессе — взаимная блокировка: 15 067 мс и потерянная
    строка → 14 мс; тест падает на старом порядке;
  - две миграции разом: ENOENT во втором процессе (3 из 3 здесь), повторное слияние журнала (у
    ревьюера 8 из 8) → миграция под блокировкой, 20 001 строка в 8 из 8;
  - защита «`AI_DEV_HOME` = домашний каталог» обходилась симлинком и регистром → сравнение через
    realpath и без регистра на Windows/macOS, в обеих копиях;
  - один сбойный файл обрывал миграцию (файл > 2 ГиБ), симлинки пропускались молча, журнал 2.x
    сливался в хвост → ошибки по записям, сравнение кусками, ссылки как ссылки, слияние по времени;
  - тест обновления на Windows писал бы настоящие конфиги клиентов (APPDATA, LOCALAPPDATA) →
    перенаправлены в домашний каталог сценария;
  - замечания: разлом протухшей блокировки (теперь под `<lock>.break` по идентичности файла),
    ожидание 15 с короче протухания 30 с (теперь 45 с), Windows EPERM при чтении и снятии,
    повторный `--frontend-qa` при незапускающемся браузере, чтение статуса по `exit`, правило
    Membrane в Python, порядок миграции и импорта `mcp-stdio.mjs`, временные каталоги тестов и
    тест «убитого писателя», который не мог дать оборванную строку (переименован по сути).
  - Не исправлено, с причиной: оборванный хвост против неблокирующих хуков 2.x — запись в одну
    write(2) читатель не видит наполовину; это записано в комментарии к `truncateTornTail`.

### 5. Не проверено

| Что | Почему | Как проверить |
|---|---|---|
| Прокси Claude, собранный csc.exe .NET Framework 4 на Windows (Д-88) | Windows в песочнице нет; собран Mono 6.8 | Windows: `node --test scripts/model-mount-contract.test.mjs` — тест сам собирает прокси csc.exe и запускает его с записывающим `docker.exe`; затем Windows + Docker: `bootstrap.ps1 -ModelPath <папка над моделями>` и dense-поиск из Claude |
| `npm exec` через адаптер process-runner и `playwright install chromium` на Windows (Д-93) | Windows нет | Windows: `npm run setup -- --frontend-qa`, ожидается ✓ и `doctor` → `frontend_qa_environment` ok |
| Клиенты на Windows получают `python` (Д-94) | Windows нет | Windows: `npm run clients:install`, в `%USERPROFILE%\.cursor\mcp.json` — `"AI_DEV_PYTHON": "python"`, поиск в Cursor отвечает |
| bootstrap на Debian, Fedora, Arch (Д-92) | `deb.debian.org`, зеркала Fedora и Arch закрыты прокси (403) | на каждой системе без Docker: `sh ./bootstrap.sh --install-prerequisites`; ожидается установка `docker.io` / `moby-engine` / `docker` без compose |
| Скачивание Chromium с настоящего CDN Playwright (Д-93) | `cdn.playwright.dev` — 403; проверено через локальное зеркало тех же файлов Chrome for Testing | машина с сетью: `npm run setup -- --frontend-qa` без `PLAYWRIGHT_DOWNLOAD_HOST` |
| Контейнерная половина теста обновления | слои ghcr.io — 403, а собрать образ 2.x нельзя: `deb.debian.org` — 403 | сценарий `docs/UPGRADE-TEST.md`, шаги 1–6, на машине с Docker и ghcr.io |
| CI на форке | на форке Actions не стартуют: у джобов нет раннера (`runner_id` 0), падение за 1–2 с, так было и до программы | разблокировать Actions на аккаунте или проверить в черновом PR в прод (D0, открывает владелец) |

### 6. Отступления и принятые решения

1. **`.npmrc`: `ignore-scripts=true`, а не `onnxruntime-node-install=skip`.** npm 11 и 12
   предупреждают, что неизвестные ключи станут ошибкой; установочных скриптов в дереве два, оба не
   нужны. `npm run <скрипт>` работает как прежде, пропускаются только pre/post-хуки, которых нет.
2. **CI ставит простым `npm ci`, а публикация образа — только из `stonebridgeway/ai-dev-system`.**
   Программа работает в `main` форка; без условия каждый пуш форка собирал бы и публиковал образ
   в GHCR форка, а бриф запрещает публикации. На форке Actions не стартуют, так что ничего
   опубликовано не было (проверено по всем прогонам).
3. **Тест обновления — `scripts/upgrade-check.mjs`.** Имя `upgrade-test.mjs` подпадало под шаблоны
   `node --test` (Д-112). Команда — `npm run upgrade:test`, как в брифе.
4. **`AI_DEV_HOME`, равный домашнему каталогу, сохраняет смысл 2.x — `~/.ai-dev`.** По букве D2
   такой `AI_DEV_HOME` разложил бы `state/`, `cache/`, `models/` прямо по домашнему каталогу.
   Это единственное значение, для которого D2 исполняется не дословно.
5. **Docker-часть теста обновления — сценарий плюс сценарий данных без контейнера.** Помимо
   описанного в `docs/UPGRADE-TEST.md`, `upgrade:test` гоняет сервер с окружением образа на данных
   2.x (третий пользователь).
6. **Шаг frontend-qa спрашивает статус раннера о хранилище, как `doctor`.** Так setup и `doctor` не
   могут разойтись; где окружение подсовывает свой Playwright (NODE_PATH), оба говорят о нём.

### 7. Влияние на установки 2.x

- **Что меняется.** `AI_DEV_HOME` — сама папка рантайма. `npm ci` без флага. Прокси Claude на
  Windows монтирует модели в `/models`. Клиенты на Windows получают `python`. bootstrap ставит
  только движок. `--frontend-qa` ставит браузер. Запись журналов и хранилищ идёт под блокировкой
  `<файл>.lock` рядом с файлом.
- **Что мигрирует само и каким тестом доказано.** Дерево `<AI_DEV_HOME>/.ai-dev` переезжает при
  старте сервера, setup или CLI — `npm run upgrade:test`, сценарии `AI_DEV_HOME` и раскладка тома
  Docker (41 из 41), и юнит-тесты миграции (перенос, дубли, слияние JSONL, конфликт). Индекс и
  состояние 2.x читаются без перестройки; конфиги клиентов 2.x запускают новый сервер.
- **Что требует действия пользователя** (текст для заметки о миграции — INSTALL, «Updating an
  earlier install»):
  - задан `AI_DEV_HOME` → один раз `npm run doctor`, посмотреть `runtime_home`; в репозиториях с
    хуками — `install_agent_hooks` ещё раз (хук 2.x ищет старое место);
  - Windows, клиенты из клона → `npm run clients:install` ещё раз;
  - Windows + Docker → `bootstrap.ps1` ещё раз, чтобы пересобрался `ClaudeMcpProxy.exe`.
- **Как откатиться.** Клон — `git checkout` прежнего коммита и `npm ci --ignore-scripts`. Если был
  задан `AI_DEV_HOME`, 2.x не увидит перенесённое дерево, пока для неё не заданы
  `AI_DEV_STATE_ROOT=$AI_DEV_HOME/state` и `AI_DEV_SEARCH_INDEX_DIR=$AI_DEV_HOME/cache/search-index`
  (замерено). Docker — образ 2.x на том же томе находит состояние и индекс как есть (замерено на
  раскладке тома без контейнера).

### 8. Для следующих фаз и в чек-лист владельца

- Д-111 (фаза 13): Dockerfile ставит pnpm 11.9.0, раннер закрепляет 11.25.0.
- `hooks/lib.mjs` вырос с 839 до 1 030 строк (копии блокировки и `AI_DEV_HOME`); потолок 800 его
  не касается, но в фазах 6–7, когда хуки начнут собираться иначе, его стоит разделить.
- npm 10 (его несёт Node 22) при `npm install` убирает из lockfile поля `libc`, которые пишет
  npm 11; так было и в 2.x. Документация везде говорит `npm ci`.
- `node --test` по-прежнему берёт `test/setup.mjs` как файл тестов: тестов в нём нет, вреда нет.
- Чек-лист владельца: пункты раздела 5 — Windows (прокси, frontend-qa, клиенты), bootstrap на
  Debian/Fedora/Arch, frontend-qa с настоящего CDN, контейнерная половина теста обновления.
