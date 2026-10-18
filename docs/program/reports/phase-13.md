# Отчёт фазы 13: Docker как серверный режим

Статус: черновик (2026-10-18) — третье ревью, закрытия в реестре и ворота впереди; поля в ВЕРХНЕМ_РЕГИСТРЕ заполнятся при закрытии фазы. Windows + Docker Desktop + Claude Desktop — чек-лист владельца (раздел 8)
PR: — сессия 2026-10-18 работает в ветке `claude/exciting-hawking-fb4g4p` (её назначила среда сессии), без слияний,
поверх конца фазы 12 `cd76596` · разведка — `9508067`; код фазы — `d481c6b`, `60a8100`, `391ab93`; записи дефектов —
`fdd2990`, `ece3951`, `99adc79`; документация — `8c5d80f`, `8b674cf`; REVIEW_COMMITS; закрытие — коммит отчёта
Объём: `cd76596..HEAD` — DIFF_STAT

### 1. Пункты

| # | Пункт | Статус | Где | Комментарий |
|---|---|---|---|---|
| 1 | Dockerfile из dist, без python3 и legacy; реестр и индекс — при сборке; замер `docker run` → `initialize` | ✅ | `docker/Dockerfile`, `scripts/prepare-docker-context.mjs`, `audit-docker-context.mjs`, `docker-prepare-data.mjs`, `src/core/image-data.mjs` | контекст — `ai-dev/` (`stageDistribution` фазы 7 без зависимостей) + Dockerfile + entrypoint; при сборке — `verify-distribution`, `npm ci --omit=dev` с `HOME` вне `/data`, onnxruntime-node своей платформы, без onnxruntime-web; из apt — `ca-certificates git tini`. Реестр, качество, индекс, бенчмарк строятся при сборке в `/data` образа (третий проход — «0 built»); времена файлов слоя (секунды) и папок тома (время копирования) восстанавливает метка `/data/.ai-dev-image-data.json`. Новый том: `initialize` за 1 814 мс, «0 built» |
| 2 | Конфиги клиентов вызывают `docker run -i --rm …`; пишет `ai-dev clients install --docker`; bootstrap: проверить Docker → pull → установщик; монтируются только папки конфигов | ✅ | `src/core/docker-launch.mjs`, `client-connections.mjs`, `src/cli/clients.mjs` (`--docker`, `entry`); `bootstrap.sh`, `bootstrap.ps1` | Docker CLI полным путём; том, папка состояния хоста (где можно, п. 7), проекты — по своему пути (Linux, macOS; Д-312) или `/workspace` (Windows), модель хоста — read-only. `bootstrap.sh` запускает установщик в образе с папками конфигов клиентов и папкой состояния (2.x монтировала весь `$HOME`); Claude Code — через `claude mcp add-json` (его `~/.claude.json` лежит прямо в домашней папке). Docker и Node скрипты больше не ставят; удаляют долгоживущий контейнер 2.x. Повтор — «No changes» |
| 3 | Старые лаунчеры — тонкие обёртки с предупреждением; подмену `initialize` убрать, если холодный старт укладывается | ✅ | `docker/run-mcp.sh`, `run-mcp.ps1`, `ClaudeMcpProxy.cs`; `bootstrap.ps1` обновляет копию в `C:\ProgramData` | холодный старт 1,1–2,5 с при таймауте MCP SDK 60 с — подмена убрана везде; обёртки пишут в stderr, что они лаунчеры 2.x, и запускают тот же `docker run`; C#-прокси — труба байтов без своего ответа; компиляции у пользователя больше нет (Д-89, Д-105) |
| 4 | Опора 2.x: `/opt/ai-dev/app/src/server.mjs`, CMD, раскладка `/data`, имена переменных | ✅ | `docker/Dockerfile`; `scripts/dockerfile-contract.test.mjs` | `/opt/ai-dev/app` → `ai-dev-mcp-server` (ссылка), `/opt/ai-dev/public-seed` → `seed`; CMD, `VOLUME`, `USER node` (uid 1000), переменные — те же; тест читает Dockerfile на каждом прогоне `check` |
| 5 | Модель: один `docker run … --network bridge <образ> ai-dev model install` в том, с прогрессом и векторами; дальше `--network none` | ✅ | `src/core/dense-backend.mjs` (`containerModelAdvice`), `dense-onnx.mjs`; `docker-smoke.mjs` | синтетическая модель через локальное зеркало: установка, 367 векторов, сессия без сети — `dense_score` 0,98 (Д-99) |
| 6 | Seed в томе — по манифесту вместо `cp -n` | ✅ | `src/core/seed-sync.mjs`, `install-layout.mjs`, `data/seed-history.json`, `scripts/seed-history.mjs` | том 2.x без записи узнаётся по истории seed линии 2.x (Д-315); том, где после синхронизации побывала 2.x, — по её манифесту (Д-317). Том образа 2.x: 3 229 skills → 615, правка пользователя с `.seed-new`, свой skill на месте |
| 7 | Хуки и сервер в Docker — одно состояние; решение и риски описать | ✅ с остатком | `docker-launch.mjs` (`sharesHostState`), `runtime-home-migration.mjs` (`migrateVolumeState`); INSTALL, «One command on macOS and Linux» | папка состояния хоста монтируется серверу, где uid 1000 — это человек (macOS, Windows, Linux с uid 1000); состояние тома переезжает туда; Stop-хук на хосте видит задачу сервера (Д-103). Linux с другим uid — состояние в томе и запись в проекты невозможна, как в 2.x (Д-318, решение владельца) |
| 8 | Chromium — вариант или в основном; обосновать размером | ✅ | `docker/Dockerfile` (`browser-deps`, `browser`), `docker-publish.yml` | отдельный вариант `-browser`: основной 0,72 ГБ, `browser-deps` (pnpm, Playwright, системные библиотеки Chromium) — 1,27 ГБ, и сверху бинарник Chromium (в песочнице не скачать; по документации Playwright — около 0,2–0,3 ГБ, отсюда «около 0,8 ГБ больше» в INSTALL — оценка). Браузер нужен одному Frontend QA |
| 9 | Д-108, теги D9 | ✅ по коду | `.github/workflows/docker-publish.yml` | main → `:edge`; `vX.Y.Z` → `:X.Y.Z`, `:X.Y`, `:X`, `:latest`; пре-релиз — только своё имя; `-browser` — те же с суффиксом; `freeze_2x` копирует `:latest` в `:2` один раз; публикация — только в проде |

### 2. Дефекты

| № | «до»: команда → вывод | «после»: команда → вывод | Статус |
|---|---|---|---|
| Д-89 | тёплый `run-mcp.sh` → `initialize` 34 мс, instructions 0; холодный, новый том → 6 508 мс | запись 3.0, новый том → 1 814 мс, instructions 1 048; обёртка 3.0 → 1 064 мс, 1 048; лаунчер 2.x (холодный) с новым образом → 1 048 | закрыт |
| Д-99 | `cp -a -n`: обновлённый skill не обновляется; `grep -c dense docker-bootstrap.mjs` → 0 | том 2.x → 615 skills (614 seed + свой), правка с `.seed-new`; модель в томе: 367 векторов, dense 0,98 без сети | закрыт |
| Д-103 (Docker) | задача сервера — в томе с путём контейнера; Stop-хук на хосте молчит | задача в `~/.ai-dev/state` хоста; Stop-хук: «Task … is active with 1 uncommitted file(s)…» | закрыт; Linux uid ≠ 1000 — Д-318 |
| Д-105 | Windows: конфиг без контейнера, `csc.exe` у пользователя | запись `docker run -i --rm …` (`/workspace`), bootstrap.ps1 ничего не компилирует (pwsh-тесты) | закрыт; живая Windows — раздел 8 |
| Д-108 | `:latest` на каждый push в `main` | `:edge` с `main`, `:latest` только с `v*` без «-», `:2` — `freeze_2x` | закрыт по коду |
| Д-111 | `pnpm` 11.9.0; в папке раннера — EACCES | `browser-deps`, uid 1000: 11.25.0 и в папке раннера 11.25.0 = `packageManager` | закрыт |
| Д-311 | `git status` → dubious ownership; `project_identity` → `filesystem` | `git status` → «On branch master»; `project_identity` (uid 4242) → `git` | закрыт; запись от uid человека — Д-318 |
| Д-312 | путь хоста → «Project directory does not exist» | путь хоста → `kind "git"`, задача с путём хоста | закрыт (Linux, macOS) |
| Д-313 | 1 841 515 801 байт; node_modules 502 МБ; кэши в `/data` 23 МБ | 715 917 010 байт; node_modules 118 МБ, onnxruntime только linux; `/data` 42 МБ построенных данных, кэшей нет | закрыт |
| Д-314 | `packaging:check` на `64e33d1` … `d481c6b` → exit 1 | → passed (0,23 с), входит в `check` | закрыт |
| Д-315 | 1 572 из 4 189 файлов seed 2.x узнаются только по манифесту; сценарий → `.seed-new`, обновления нет | 4 189 из 4 189 узнаются историей; сценарий → `updated 1`; генерация 18,1 → 0,7 с | закрыт |
| Д-316 | совет `setup --frontend-qa` → exit 1 через 70,7 с | совет — вариант `-browser`; подсказка `docker run … ai-dev doctor` выполняется (exit 0) | закрыт |
| Д-317 | откат и возврат → 3 228 skills | → 614 (разово 17,2 с), следующая сессия 1,2 с | закрыт |
| Д-318 | uid 4242: `install_agent_hooks` → EACCES | — | открыт: решение владельца |
REVIEW_DEFECTS

### 3. Критерии приёмки

| Критерий | Команда | Фактический вывод | ✅/❌ |
|---|---|---|---|
| Образ собирается; если зеркала закрыты — доступная база, остальное — «не проверено» | `docker build --build-arg BASE_IMAGE=sandbox/ubuntu-ca:24.04 .docker/build-context` | собирается: 715 917 010 байт, 16 с с кэшем зависимостей; база Debian — «не проверено» (раздел 5) | ✅ |
| `initialize` содержит `instructions`; холодный старт — цифрой | `npm run docker:smoke -- --image ai-dev-system:p13final` | новый том 1 814 мс, instructions 1 048; следующая сессия 1 229 мс | ✅ |
| Модель подключается через том (синтетическая) | тот же smoke, шаг 3 | установка через зеркало, 367 векторов, сессия `--network none`: `dense_score` 0,98 | ✅ |
| После обновления образа skills в томе обновлены | `npm run docker:upgrade-check -- --old-image ai-dev-system:2x-8f647df --new-image ai-dev-system:p13final` | 3 229 → 615; правка пользователя сохранена, рядом `.seed-new`; свой skill на месте | ✅ |
| Старые лаунчеры 2.x работают с новым образом | тот же upgrade-check | холодный путь 2.x: instructions 1 048; тёплый путь 2.x: 135 tools; обёртка 3.0: 1 048 | ✅ |
| `check`, `docker:smoke`, `acceptance`, `upgrade:test` зелёные | раздел 4 | GATES_SHORT | ✅ |
| В чек-лист владельца: Windows + Docker Desktop + Claude Desktop | — | раздел 8 | — |

### 4. Проверки

**Ворота** — на REVIEW_HEAD:

| Ворота | Команда | Вывод |
|---|---|---|
| check | `cd ai-dev-mcp-server && npm run check` | CHECK_LINE |
| acceptance | `npm run acceptance` | ACCEPTANCE_LINE |
| upgrade:test | `npm run upgrade:test` | UPGRADE_LINE |
| docker:smoke | `npm run docker:smoke -- --image ai-dev-system:p13final` | pass: новый том 1 814 мс («0 built»), instructions 1 048, 135 tools, health ok (25 проверок), следующая сессия 1 229 мс; модель: 367 векторов, dense 0,98 |
| docker:upgrade-check | `npm run docker:upgrade-check -- --old-image ai-dev-system:2x-8f647df --new-image ai-dev-system:p13final` | pass: 2.x — первая сессия 21 174 мс, 3 229 skills; новый образ под лаунчером 2.x — 16 388 мс разово, instructions 1 048, 615 skills, задача на месте; тёплый 2.x — 135 tools; обёртка 3.0 — 1 064 мс; запись 3.0 — 1 092 мс, задача в папке состояния хоста |
| packaging:check | `npm run packaging:check` | passed (теперь и внутри `check`) |

**Пробы против работающего образа** (`scratchpad/p13/probes/`):

- **P2, Д-103.** Запись 3.0 (`dockerRunArgs`) с папкой состояния под HOME хоста: `begin_task` с путём хоста → файл задачи
  в `<HOME>/.ai-dev/state/tasks`; `stop-check.mjs` на хосте, проект с изменённым файлом → «Task … is active with 1
  uncommitted file(s)…».
- **P3, «чего не должно случиться»: откат на 2.x и возврат.** До исправления — 3 228 skills после возврата (Д-317);
  после — 614, разово 17,2 с, следующая сессия 1,2 с.
- **P4, «чего не должно случиться»: Linux с uid не 1000 не должен получить смонтированную папку состояния.**
  `bootstrap.sh` от root во временном HOME, Cursor и Codex: записи без `/ai-dev-state`, проекты по своему пути,
  пояснение установщика напечатано; 5,2 с; повтор — 4,1 с, «No changes».
- **P5, Д-316.** Подсказка образа `hint("npm run doctor")`, выполненная дословно (образ и том подставлены, TTY через
  `script`) → exit 0; совет Frontend QA называет вариант `-browser`.
- **P8, Д-311/Д-318.** Проект uid 1000 → `kind git`, хуки ставятся; uid 4242 → `kind git`, `install_agent_hooks` →
  EACCES.
- Д-311: `git status` в образе на репозитории root → работает (образ 2.x — «dubious ownership»).
- Д-111: вариант `browser-deps` от uid 1000 — pnpm 11.25.0, в папке раннера тоже.

REVIEW_SECTION

### 5. Не проверено

| Что | Почему | Как проверить |
|---|---|---|
| База `debian:bookworm-slim` (значение по умолчанию) | `deb.debian.org` и зеркала Debian из песочницы закрыты; собрано на `sandbox/ubuntu-ca:24.04` (Ubuntu 24.04 + CA прокси) — размеры и времена этой базы | CI прода (`docker-publish.yml`, validate) или сборка на машине с доступом |
| Бинарник Chromium в варианте `-browser` | `cdn.playwright.dev` закрыт; собрана цель `browser-deps` (pnpm, Playwright, системные библиотеки) | `docker build --target browser`, `docker:smoke -- --browser --no-model` в CI |
| Windows + Docker Desktop + Claude Desktop | Windows в песочнице нет; записи Windows проверены на подменённой платформе, `bootstrap.ps1` — pwsh 7.6 на Linux с заглушками | раздел 8 |
| macOS + Docker Desktop (сопоставление владельца папки состояния) | macOS нет | раздел 8, п. 6 |
| Публикация и теги D9, `freeze_2x` | Actions форка не стартуют, публикация — только в проде | первый запуск в проде; раздел 8, п. 7 |
| Образ прода `:latest` (2.x) как «старый» в upgrade-check | реестр ghcr из песочницы отдаёт 403 на слои; использован `ai-dev-system:2x-8f647df`, собранный из `8f647df` | шаг validate в CI прода |

### 6. Отступления и принятые решения

1. **Контейнер — всегда uid 1000**, а не uid человека, как планировала запись Д-311: том 2.x принадлежит uid 1000, и
   контейнер с другим uid не создаёт в нём ничего (замер `docker-upgrade-check`: «mkdir … Permission denied»); открыть
   том всем на запись — хуже. Папка состояния хоста делится, только где uid 1000 — это человек (`sharesHostState`);
   остаток для Linux с другим uid — Д-318, решение владельца; документация называет для такой машины локальный путь.
2. **Состояние сервера переезжает из тома на хост** при каждом старте записи 3.0 с папкой состояния
   (`migrateVolumeState`, без перезаписи): так задачи, начатые 2.x во время отката, возвращаются на хост. Образ 2.x
   после отката задач хоста не видит — `docs/UPGRADE-TEST.md` даёт команду, копирующую их в том.
3. **Данные первого запуска строятся при сборке образа**, а не при первом старте тома: новый том копирует 42 МБ
   готовых реестра, индекса и бенчмарка; времена файлов восстанавливает метка (`image-data.mjs`), без неё проверка
   свежести реестра пересобирала бы всё (8,7 с).
4. **История seed — только линия 2.x** (`SEED_HISTORY_BASE` = `8f647df`): тома без записи бывают только от образов 2.x,
   а образы публикуются только из прода. Если прод выпустит ещё одну 2.x до 3.0, базу сдвигают и историю пишут
   заново (фаза 15).
5. **Python в образе нет**: `query_ui_ux_knowledge` и `generate_ui_ux_design_system` отвечают в контейнере, что нужен
   Python (проверка здоровья — `skipped`); остальное от Python не зависит.
6. **Claude Code на macOS и Linux прописывается через `claude mcp add-json`**: его конфиг — файл прямо в домашней
   папке, а установщику в образе монтируются только папки. Без CLI на PATH скрипт печатает команду.
7. **Подсказки образа — команды для хоста** (`docker run --rm -it … <image> ai-dev …`), а не `node /opt/…/ai-dev.mjs`:
   оболочки в контейнере клиента ни у кого нет (Д-316). `<image>` — заглушка: контейнер не знает, каким тегом его
   запустили.
8. **`packaging:check` — в `npm run check`** (Д-314): красный с фазы 7 и ни разу не видимый воротами программы.
9. Версия сервера в ответе — ещё `2.0.0`: повышение до 3.0.0 — фаза 15 (D8).

### 7. Влияние на установки 2.x

- **Конфиги 2.x** (`run-mcp.sh`, `run-mcp.ps1`, `ClaudeMcpProxy.exe`) работают до 4.0. В обновлённом клоне скрипты 3.0
  пропускают ответ сервера с инструкциями и пишут предупреждение; в необновлённом — лаунчер 2.x отвечает по-старому.
  Повторный bootstrap переписывает конфиги на `docker run` и удаляет контейнер `ai-dev-system-runtime-<uid>`.
- **Том 2.x**: первый старт нового образа — разово 15–17 с: seed приводится к seed образа, реестр и индекс
  пересобираются; задачи и решения на месте; состояние переезжает на хост, где папка смонтирована. Дальше — около
  секунды.
- **Откат** — `ghcr.io/stonebridgeway/ai-dev-system:2` (после `freeze_2x`): vault, индекс и модель на месте; задачи,
  переехавшие на хост, — по команде из `docs/UPGRADE-TEST.md`; возврат на 3.0 убирает то, что вернул `cp -n` 2.x.
- **Linux с uid не 1000**: как в 2.x — состояние в томе, запись в проекты невозможна (Д-318).
- `bootstrap.sh --install-prerequisites` принимается и говорит, что Docker больше не ставится; пакет AUR зависит от
  Docker, запуск движка и группа — на пользователе.

### 8. Для следующих фаз и в чек-лист владельца

**Чек-лист владельца — Windows 11 + Docker Desktop + Claude Desktop** (время каждого шага — в форму 9.3 брифа).

1. **Чистая установка.** Docker Desktop запущен, Node 22.12+; в клоне `bootstrap.ps1`. Ожидается: скачивание образа,
   «Checking the MCP handshake», запись в Claude Desktop, Cursor, VS Code, Codex; в
   `%APPDATA%\Claude\claude_desktop_config.json` запись `ai-dev` с `docker.exe` полным путём и
   `type=bind,source=%USERPROFILE%\AI-Dev-Projects,target=/workspace`.
2. **Claude Desktop.** Перезапустить: `ai-dev` в списке, без таймаута; спросить «какие инструкции дал сервер ai-dev» —
   агент их знает (до 3.0 у Claude на Windows их не было, Д-89). `begin_task` для `/workspace/<проект>` отвечает.
   Время первого ответа на новом томе.
3. **Папка состояния.** После `begin_task` задача лежит в `%USERPROFILE%\.ai-dev\state\tasks` (сопоставление владельца
   Docker Desktop). Хуки Claude Code, поставленные `install_agent_hooks`, видят её (Stop-хук при изменённом файле).
4. **Модель.** `docker run --rm -it --network bridge --mount type=volume,source=ai-dev-system-data,target=/data
   ghcr.io/stonebridgeway/ai-dev-system:latest ai-dev model install` — прогресс, ~600 МБ, векторы; потом в Claude
   `embedding_status` → `available: true`.
5. **Обновление с 2.x.** На машине с установкой 2.x (конфиг Claude называет `C:\ProgramData\AI-Dev-System\ClaudeMcpProxy.exe`):
   `git pull`, затем запустить Claude **до** bootstrap — работает (прокси 2.x); затем `bootstrap.ps1` — конфиг Claude
   переписан на `docker run`, skills в томе обновлены (число в `recommend_skills`/реестре ~615), свои правки целы.
6. **macOS + Docker Desktop** (если есть): `sh ./bootstrap.sh` — Claude Code через `claude mcp add-json`; задача сервера
   видна Stop-хуку (папка состояния с владельцем пользователя).
7. **Прод, перед первым тегом 3.0:** ручной запуск `docker-publish.yml` с `freeze_2x` → `:2` = текущий `:latest`;
   после тега `v3.0.0` — `:3.0.0`, `:3.0`, `:3`, `:latest` и те же с `-browser`; push в `main` — только `:edge`.

**Для следующих фаз.**
- Фаза 14: README и INSTALL строятся вокруг трёх путей (локальный, установщик Windows, Docker); Д-318 — вопрос
  владельцу в итоговый список; примеры путей задач (`~/Dev/my-project`) уже не про `/workspace`.
- Фаза 15: если прод выпустил 2.x после `8f647df` — сдвинуть `SEED_HISTORY_BASE`, `node scripts/seed-history.mjs
  --write` из полного клона прода, и `DEFAULT` базы upgrade-check; `freeze_2x` до тега; версия 3.0.0 (сервер отвечает
  `2.0.0`); формула Homebrew всё ещё на `v1.0.0` (её `--install-prerequisites` — 1.0).
