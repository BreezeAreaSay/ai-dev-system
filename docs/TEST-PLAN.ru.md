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
  `ai-dev-system:local`; передавайте `--image ai-dev-system:local` (`-Image` на Windows). Образ 2.x —
  `ghcr.io/stonebridgeway/ai-dev-system:2`, когда `:2` заморожен (до того — тег `v2.0.0`).
- **Один ИИ-клиент на каждой системе** (Claude Desktop, Claude Code или Cursor) и **небольшой
  репозиторий** с тестами, которые проходят (`npm test`).
- **Модель в `.zip`** — сделаете на шаге L2; она нужна в W4 и M4.
- **Установка 2.x**, где она есть, для шагов перехода (W6, M6, L4). Где её нет, отметьте шаг «нет
  установки 2.x» — переход проверяет CI (`docker:upgrade-check`, шаг «Upgrade a 2.x volume»).

Записывайте время каждого шага и дословный текст каждой ошибки.

## Windows 11 — около 40 минут

| Шаг | Что сделать | Что должно получиться |
| --- | --- | --- |
| W1 · 8 мин | Запустить установщик. | Никакого запроса UAC. SmartScreen для неподписанной сборки — «Подробнее → Выполнить в любом случае». Ставится в `%LOCALAPPDATA%\Programs\ai-dev-desktop`, ярлыки в «Пуске» и на рабочем столе; окно «Preparing AI Dev…», затем мастер. `dir /AL %USERPROFILE%\.ai-dev\app` показывает JUNCTION `current`. |
| W2 · 5 мин | Мастер: папка проектов; отметить Claude Desktop и Cursor → «Подключить»; перезапустить клиентов. | Записи клиентов называют `…\.ai-dev\app\current\node\node.exe` и `…\current\ai-dev-mcp-server\bin\ai-dev.mjs mcp`; в клиенте виден сервер `ai-dev`. |
| W3 · 8 мин | Первая задача из README в своём репозитории. | `begin_task` → правка → `checkpoint_task` → `verify_task` → `complete_task`. Попытка закрыть раньше проверки отклоняется. Есть `.ai-dev\pr\<id>.md`. `"%USERPROFILE%\.ai-dev\app\current\ai-dev.cmd" daemon status` — один pid и две сессии, если открыты два клиента; консольных окон нет. |
| W4 · 4 мин | Мастер, шаг модели → «Импортировать из папки…» → папка из `.zip` шага L2. | Файлы сверены; `embedding_status` в клиенте — `available: true`; «Статус» — модель «установлена». |
| W5 · 5 мин | «Параметры → Приложения → AI Dev → Удалить»: убрать из клиентов — Да, данные — Нет. | Два вопроса на языке системы. Записи `ai-dev` из клиентов и `.ai-dev\app\*` удалены; `.ai-dev\vault` и `.ai-dev\state` на месте. |
| W6 · 10 мин | На машине с 2.x через Docker: сначала запустить Claude Desktop (прокси 2.x ещё работает), затем `git pull` и `bootstrap.ps1` (с `-Image ai-dev-system:local`, пока образ не опубликован). | «Checking the MCP handshake...»; записи `docker run` с полным путём к `docker.exe` и `/workspace`; Claude получает instructions сервера (Д-89); навыков около 615; правленный вами файл seed сохранён, рядом `.seed-new`. |

## macOS — около 40 минут

| Шаг | Что сделать | Что должно получиться |
| --- | --- | --- |
| M1 · 5 мин | `npx @stonebridgeway/ai-dev-system setup`, ответить «да» на подключение клиентов. | «Installed: ~/.ai-dev/app/<версия>-<отпечаток>.», затем «Health: ok — N check(s), 0 not passing.» Повторный запуск — «Already there: …». |
| M2 · 4 мин | `npx @stonebridgeway/ai-dev-system clients doctor`; запустить Claude Desktop из Dock. | Каждый клиент — ok; в клиенте, открытом из Dock, сервер `ai-dev` есть, хотя Node поставлен через nvm или Homebrew. |
| M3 · 8 мин | Первая задача, как в W3. | Как в W3. |
| M4 · 4 мин | `npx @stonebridgeway/ai-dev-system model import <путь к .zip>`, затем `model status` и `model doctor`. | «Model in place: …»; «Installed: yes, every file matches the manifest.»; `model doctor` — READY, вектор на 1024 измерения. На Intel Mac — отказ, который называет отсутствующую сборку среды ONNX (Д-101). |
| M5 · 8 мин | `sh ./bootstrap.sh` (с `--image ai-dev-system:local`, пока образ не опубликован). | Claude Code добавлен через `claude mcp add-json`; остальные записи — `docker run`, резервные копии рядом; Stop-хук в проекте видит задачу, начатую сервером в контейнере (Д-103). |
| M6 · 5 мин | На клоне 2.x: `git pull && cd ai-dev-mcp-server && npm ci && npm run setup`. | Запись `ai-dev-system` заменена на `ai-dev`; старая задача находится (`get_task`). |
| M7 · 5 мин | `npx @stonebridgeway/ai-dev-system clients remove`; `npx @stonebridgeway/ai-dev-system daemon stop`; `docker volume rm ai-dev-system-data`. | Записей `ai-dev` нет; нетронутые файлы конфигов совпадают с исходными байт в байт; «Stopped: pid …». |

## Linux (Ubuntu 24.04) — около 35 минут

| Шаг | Что сделать | Что должно получиться |
| --- | --- | --- |
| L1 · 6 мин | `npx @stonebridgeway/ai-dev-system setup --yes`. | Как в M1. |
| L2 · 12 мин | `npx @stonebridgeway/ai-dev-system setup --model`; прервать Ctrl-C на половине; `model status`; запустить снова. | Выход 130, скачанное сохранено; «Stopped partway: …»; повтор — «Model in place: … 1 continued»; `hybrid_search` в клиенте даёт `dense_score`. Упакуйте папку `~/.ai-dev/models/bge-m3-onnx` в `.zip` для W4 и M4. |
| L3 · 6 мин | Первая задача (Cursor или Claude Code). | Как в W3. |
| L4 · 6 мин | На установке 2.x через Docker: `git pull`; `sh ./bootstrap.sh --model-path ~/.ai-dev/models`. | Записи `docker run`; контейнер 2.x `ai-dev-system-runtime-<uid>` удалён; том сохранён; навыков около 615; модель доступна (`embedding_status`). |
| L5 · 4 мин | `sh ./bootstrap.sh --image ghcr.io/stonebridgeway/ai-dev-system:2`, затем снова `sh ./bootstrap.sh`. | 2.x видит задачу, начатую под 3.0 (Д-333); вернувшись на 3.0, навыки, которые вернула 2.x, снова убраны (Д-317). |
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
