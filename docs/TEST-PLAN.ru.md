# План ручной приёмки 3.0

Одна проверка на трёх системах, около 40 минут на каждую. Она проходит тем путём, которым пойдёт
человек: три способа установки, подключение клиента, первая задача, локальная модель, переход с 2.x,
откат и удаление. Всё, что проверяется без живой машины, уже проверено автоматически (`npm run
check`, `npm run acceptance`, `npm run upgrade:test`, `docker:smoke`, `docker:upgrade-check`, CI на
трёх системах), — здесь только то, что видит человек на своей машине.

Этот план заменил четыре прежних (`TEST-PLAN.*.ru.md` для 2.1.0 и `RETEST.ru.md`): они проверяли
установку из клона под именем `ai-dev-system`, которой в 3.0 нет как основного пути.

## Что подготовить

- **Установщик** `AI-Dev-Setup-<версия>.exe` — артефакт задачи `build` в `desktop-windows.yml` или
  `cd desktop && npm ci && npm run dist:win` (вне Windows нужен Wine).
- **Пакет npm.** Пока он не опубликован — tarball: `cd ai-dev-mcp-server && npm ci && npm run
  dist:pack`, файл `../dist/stonebridgeway-ai-dev-system-<версия>.tgz` (папка `dist/` в корне
  клона); везде ниже вместо `npx @stonebridgeway/ai-dev-system` запускайте `npx --yes <путь к tgz>`.
- **Образ.** Пока 3.0 не опубликован — свой: `cd ai-dev-mcp-server && npm run docker:build` даёт
  `ai-dev-system:local`. Во всех шагах ниже запускайте bootstrap с `--image ai-dev-system:local
  --allow-stale-image` (`-Image ai-dev-system:local -AllowStaleImage` на Windows): bootstrap сначала
  тянет образ из реестра, а своего образа там нет, и без этого флага он остановится с кодом 69.
  Предупреждение «Registry pull failed … Installed from a stale image» здесь ожидаемо. Образ 2.x —
  `ghcr.io/stonebridgeway/ai-dev-system:2`, когда `:2` есть (его делают перед первым тегом 3.0,
  копией `:latest`; до того образ 2.x — сам `:latest`).
- **Один ИИ-клиент на каждой системе** (Claude Desktop, Claude Code или Cursor) и **небольшой
  репозиторий** с тестами, которые проходят (`npm test`).
- **Модель в `.zip`** — сделаете на шаге L2; она нужна в W4 и M4.
- **Установка 2.x**, где она есть, для шагов перехода (W6, M6, L4). Где её нет, отметьте шаг «нет
  установки 2.x» — переход проверяет CI (`docker:upgrade-check`, шаг «Upgrade a 2.x volume»).

Записывайте время каждого шага и дословный текст каждой ошибки.

## Windows 11 — около 40 минут

| Шаг | Что сделать | Что должно получиться |
| --- | --- | --- |
| W1 · 8 мин | Запустить установщик. | Никакого запроса UAC. SmartScreen для неподписанной сборки — «Подробнее → Выполнить в любом случае». Ставится в `%LOCALAPPDATA%\Programs\ai-dev-desktop`, ярлыки в «Пуске» и на рабочем столе; окно «Подготовка AI Dev…» (в английской системе — «Preparing AI Dev…»), затем мастер. В PowerShell `(Get-Item "$env:USERPROFILE\.ai-dev\app\current").LinkType` — `Junction`; в cmd `dir /AL %USERPROFILE%\.ai-dev\app` показывает JUNCTION `current`. |
| W2 · 5 мин | Мастер: папка проектов; отметить Claude Desktop и Cursor → «Подключить выбранные» (в английской системе — «Connect the chosen clients»); перезапустить клиентов. | Записи клиентов называют `…\.ai-dev\app\current\node\node.exe` и `…\current\ai-dev-mcp-server\bin\ai-dev.mjs mcp`; в клиенте виден сервер `ai-dev`. |
| W3 · 8 мин | Первая задача из README в своём репозитории. | `begin_task` → правка → `checkpoint_task` → `verify_task` → `complete_task`. Попытка закрыть раньше проверки отклоняется. Есть `.ai-dev\pr\<id>.md`. В PowerShell `& "$env:USERPROFILE\.ai-dev\app\current\ai-dev.cmd" daemon status` (в cmd — `"%USERPROFILE%\.ai-dev\app\current\ai-dev.cmd" daemon status`) — один pid и две сессии, если открыты два клиента; консольных окон нет. |
| W4 · 4 мин | Мастер, шаг модели → «Импортировать из папки…» → папка из `.zip` шага L2. | Файлы сверены; `embedding_status` в клиенте — `available: true`; «Статус» — модель «установлена». |
| W5 · 5 мин | «Параметры → Приложения → AI Dev → Удалить»: убрать из клиентов — Да, данные — Нет. | Два вопроса на языке системы. Записи `ai-dev` из клиентов и `.ai-dev\app\*` удалены; `.ai-dev\vault` и `.ai-dev\state` на месте. |
| W6 · 10 мин | На машине с 2.x через Docker: сначала запустить Claude Desktop (прокси 2.x ещё работает), затем `git pull` и `bootstrap.ps1` (с `-Image ai-dev-system:local -AllowStaleImage`, пока образ не опубликован; с `-ProjectPath <папка>`, если записи 2.x монтировали не `%USERPROFILE%\AI-Dev-Projects`, и с `-ModelPath <папка>`, если в них был `AI_DEV_MODEL_PATH`: ни `AI_DEV_PROJECT_PATH`, ни `AI_DEV_MODEL_PATH` записей bootstrap не читает). | «Checking the MCP handshake...»; записи `docker run` с полным путём к `docker.exe` и `/workspace`; Claude получает instructions сервера (Д-89); навыков — 614 из seed и ваши собственные; правленный вами файл seed сохранён, рядом `.seed-new`. |

## macOS — около 40 минут

| Шаг | Что сделать | Что должно получиться |
| --- | --- | --- |
| M1 · 5 мин | `npx @stonebridgeway/ai-dev-system setup`, ответить «да» на подключение клиентов. | «Installed: ~/.ai-dev/app/<версия>-<отпечаток>.», затем «Health: ok — N check(s), 0 not passing.» Повторный запуск — «Already there: …». |
| M2 · 4 мин | `npx @stonebridgeway/ai-dev-system clients doctor`; запустить Claude Desktop из Dock. | Каждый клиент — ok; в клиенте, открытом из Dock, сервер `ai-dev` есть, хотя Node поставлен через nvm или Homebrew. |
| M3 · 8 мин | Первая задача, как в W3. | Как в W3. |
| M4 · 4 мин | `npx @stonebridgeway/ai-dev-system model import <путь к .zip>`, затем `model status` и `model doctor`. | «Model in place: …»; «Installed: yes, every file matches the manifest.»; `model doctor` — READY, вектор на 1024 измерения. На Intel Mac — отказ, который называет отсутствующую сборку среды ONNX (Д-101). |
| M5 · 8 мин | `sh ./bootstrap.sh` (с `--image ai-dev-system:local --allow-stale-image`, пока образ не опубликован). Затем в Claude Code с записью Docker (в Claude Desktop хуков нет), в репозитории внутри `~/AI-Dev-Projects` (папка, которую монтирует bootstrap): попросить агента вызвать `install_agent_hooks` для этого проекта и начать задачу (`begin_task`), поправить файл с кодом и закончить ход. В Cursor — то же, но `install_agent_hooks` с целью `cursor` (`targets: ["cursor"]`). | Claude Code добавлен через `claude mcp add-json`; остальные записи — `docker run`, резервные копии рядом; хуки стоят в проекте; Stop-хук видит задачу, начатую сервером в контейнере: «[ai-dev stop-check] Task … is … with N uncommitted file(s)» (Д-103). Эту строку хук пишет в stderr с кодом 0 — ищите её в выводе хуков клиента, а не в ответе агента. После правки кода та же остановка в Claude Code один раз возвращает агента провести ревью безопасности (умолчание `security_review_on_stop: "block"`): «[ai-dev security] N changed file(s) no security scan has seen: …»; следующая остановка проходит молча. В Cursor хук агента не возвращает и пишет эту просьбу тоже в stderr. |
| M6 · 5 мин | На клоне 2.x: `git pull && cd ai-dev-mcp-server && npm ci && npm run setup`. | Запись `ai-dev-system` заменена на `ai-dev`; старая задача находится (`get_task`). |
| M7 · 5 мин | `npx @stonebridgeway/ai-dev-system clients remove`; `npx @stonebridgeway/ai-dev-system daemon stop`; `docker volume rm ai-dev-system-data`. | Записей `ai-dev` нет; нетронутые файлы конфигов совпадают с исходными байт в байт — кроме файлов, где установка заменила запись `ai-dev` или `ai-dev-system` (2.x, Docker, другой установки): они вернулись без неё, её байты — в `<файл>.backup-<время>` установки; «Stopped: pid …». |

## Linux (Ubuntu 24.04) — около 35 минут

| Шаг | Что сделать | Что должно получиться |
| --- | --- | --- |
| L1 · 6 мин | `npx @stonebridgeway/ai-dev-system setup --yes`. | Как в M1. |
| L2 · 12 мин | `npx @stonebridgeway/ai-dev-system setup --model`; прервать Ctrl-C на половине; `model status`; запустить снова. | Выход 130, скачанное сохранено; «Stopped partway: …»; повтор — «✓ Local BGE-M3 model (…): … in …/bge-m3-onnx, N file(s) fetched, 1 continued»; `hybrid_search` в клиенте даёт `dense_score`. Упакуйте папку `~/.ai-dev/models/bge-m3-onnx` в `.zip` для W4 и M4. |
| L3 · 6 мин | Первая задача (Cursor или Claude Code). | Как в W3. |
| L4 · 6 мин | На установке 2.x через Docker: `git pull`; `sh ./bootstrap.sh --model-path ~/.ai-dev/models` (с `--image ai-dev-system:local --allow-stale-image`, пока образ не опубликован; с `--project-path <папка>`, если записи 2.x монтировали не `~/AI-Dev-Projects`: ни их `AI_DEV_PROJECT_PATH`, ни `AI_DEV_MODEL_PATH` bootstrap не читает). | Записи `docker run`; контейнер 2.x `ai-dev-system-runtime-<uid>` удалён; том сохранён; навыков — 614 из seed и ваши собственные; модель доступна (`embedding_status`). |
| L5 · 4 мин | `sh ./bootstrap.sh --image ghcr.io/stonebridgeway/ai-dev-system:2`, затем снова `sh ./bootstrap.sh`. Пока 3.0 не опубликован: `AI_DEV_INSTALLER_IMAGE=ai-dev-system:local sh ./bootstrap.sh --image ghcr.io/stonebridgeway/ai-dev-system:latest` — до выпуска `:latest` и есть образ 2.x (`:2` скопируют из него), и он же установщик по умолчанию, поэтому записи пишет образ 3.0, — и обратно с `--image ai-dev-system:local --allow-stale-image`. | С `AI_DEV_INSTALLER_IMAGE=ai-dev-system:local` — «pull access denied for ai-dev-system …» от Docker (bootstrap пробует скачать и образ установщика), и bootstrap идёт дальше с собранным здесь образом. 2.x видит задачу, начатую под 3.0 (Д-333); вернувшись на 3.0, навыки, которые вернула 2.x, снова убраны (Д-317). |
| L6 · 3 мин | Удаление, как в M7. | `clients list` не показывает `ai-dev`. |

## Чего этот план не проверяет

- Обновление установщика из релиза и подпись (решение D7) — после первого выпуска.
- Откат установщика: обновление не ставит более старую версию; ручная установка старой не проверялась.
- Откат пакета npm: 3.0.0 — первая версия в npm.
- `bootstrap.ps1 -Image …:2` на Windows — путь назад проверен только для `bootstrap.sh`.
- Настоящие веса BGE-M3 из huggingface.co в песочнице программы недоступны: шаг L2 — первая загрузка
  настоящих весов в 3.0 (Д-101).

## Как сообщить

По форме из брифа (раздел 9.3), по одной на систему:

```
## Ручная проверка: 3.0 на <ОС>
Машина: <ОС, версия> · чистая: да/нет (что стояло: Node, Python, Docker, клиенты)
Что проверял: <коммит или версия>
| Шаг | Что сделал | Что увидел (дословно или скриншот) | Время | ✅/❌ |
Ошибки дословно; журнал демона (~/.ai-dev/logs/daemon.log, на Windows %USERPROFILE%\.ai-dev\logs\daemon.log) и экран журнала приложения; что было непонятно без подсказки
```
