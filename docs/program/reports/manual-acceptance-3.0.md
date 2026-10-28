# Ручная приёмка 3.0: Linux и Windows под эмулятором

2026-10-28, по `docs/TEST-PLAN.ru.md`. Две системы из трёх: Linux — на машине песочницы, Windows — под Wine 9.0 на той же
машине. macOS здесь нет. Найденное записано в `docs/DEFECTS.md` до правки (Д-594 … Д-599) и исправлено в `34bb829`,
кроме двух мелочей Д-599.

## Ручная проверка: 3.0 на Linux

Машина: Ubuntu 24.04.5 LTS, контейнер облачной песочницы, root · чистая: свой пустой дом на каждый путь (npx, Docker,
приложение); стояли Node 22.22.0, Docker 29.8.2, Claude Code CLI 2.1.312; приложений-клиентов с окном (Claude Desktop,
Cursor) нет — их записи читал и запускал клиент MCP по stdio, ровно ту команду, что записана в конфиге; Claude Code
проверял сервер сам (`claude mcp list`).
Что проверял: `d00c84e` — пакет `ai-dev-system-3.0.0.tgz` (`dist:pack`), образ `ai-dev-system:acc-d00c84e`, AppImage и
`.deb` 3.0.0; замеры «после» — `34bb829`.

| Шаг | Что сделал | Что увидел | Время | ✅/❌ |
| --- | --- | --- | --- | --- |
| L1 | `npx --yes ./ai-dev-system-3.0.0.tgz setup --yes` в чистом доме (есть `~/.cursor`), затем ещё раз с `~/.claude` | «Installed: ~/.ai-dev/app/3.0.0-09d252ae.», «Health: ok — 25 check(s), 0 not passing.»; повтор — «Already there: …», Claude Code «added», Cursor «unchanged»; `claude mcp list` — «ai-dev: … ✔ Connected» | 53 с, 13 с | ✅ (форма из плана с полным путём — ❌, Д-594) |
| L2 | `setup --model`; Ctrl-C на 7 % загрузки; `model status`; снова | Код 130 (npx снят SIGINT); «23.8 MB of config.json are kept; running the install again continues from there.»; «Stopped partway: config.json, 23.8 MB of 64.0 MB — `npx ai-dev-system model install` continues it.»; повтор — `Range: bytes=24942978-` → 206, затем сверка по sha256 | 17 с + 21 с | ⚠ механика ✅; настоящие веса не проверены: huggingface.co и зеркала закрыты песочницей (403), зеркало — локальное с другими байтами; итог ошибки — Д-595 |
| L3 | Первая задача из README через запись Claude Code, Cursor подключён рядом | `daemon status` — «Running: pid 6469 … 2 session(s): claude-code 1.0.0, cursor 1.0.0»; `prepare_project` → AGENTS.md и `.ai-dev/quality-gate.md`; ранний `complete_task` — «The report claims more than the evidence shows … "Should work."»; `verify_task` → `verified`; критерии AC-1…AC-5 отмечены; `complete_task` → `complete`, `.ai-dev/pr/task-…md` | ~3 с вызовов | ✅; кэши в описании PR — Д-597, заголовок — Д-599 п. 1 |
| Терминал | `npx … ai-dev-system` в псевдотерминале: настройка, новый навык, правило с шаблоном `--no-verify`, MCP-серверы, статус | Каждый пункт показывает команду (`$ ai-dev settings set -- daemon_idle_minutes 45`, `$ ai-dev rules add --pattern=--no-verify …`); «Added: block bash no-skip-hooks»; Enter и `b` в главном меню спрашивают снова | 20 с | ✅; статус «failed» после нового навыка — Д-598; совет `servers` — Д-599 п. 3 |
| Приложение | AppImage в чистом доме, по-русски, под xvfb: мастер, «Статус», «Навыки», «Правила», «Настройки», новый навык через окно подтверждения | Мастер через 28,6 с; «Выполнить custom_skills_add?» с аргументами; «deploy-check начат по шаблону»; `current` → `~/.ai-dev/app/3.0.0-63f2f1cb`; снимки экранов переданы владельцу с отчётом (бинарные файлы репозиторий не держит) | ~1 мин | ✅; «навыки/скиллы» — Д-599 п. 2 |
| L4 | 2.x через свой bootstrap (`ai-dev-system:2x-8f647df`, проекты `~/work2x`, свой том `acc-l4-data`), затем `sh ./bootstrap.sh --model-path ~/.ai-dev/models --image ai-dev-system:acc-d00c84e --allow-stale-image` | «Checking the MCP handshake...»; «Projects folder: …/work2x, the one Claude Code, Claude Desktop, Cursor mounted»; записи `docker run` с резервными копиями; «Removing the 2.x runtime container ai-dev-system-runtime-0»; том на месте; в образе `ai-dev status --quick` — «ok», `skills mine` — своих нет, 28 из поставки | 60 с + 34 с | ✅; модель — не установлена (весов нет) |
| L5 | `AI_DEV_INSTALLER_IMAGE=ai-dev-system:acc-d00c84e sh ./bootstrap.sh --image ai-dev-system:2x-8f647df --allow-stale-image`, затем обратно на 3.0 | «pull access denied for ai-dev-system …» и дальше; «ai-dev-system:2x-8f647df has no installer of its own (a 2.x image): ai-dev-system:acc-d00c84e writes the configs that run it.»; папки проектов и модели — из прежних записей; сервер 2.0.0 читает задачу, начатую под 3.0; обратно — 3.0 читает её же | 14 с + 28 с | ✅; Д-317 не воспроизвёлся: этот образ 2.x навыков не возвращает (28 и до, и после) |
| L6 | `clients remove`, `daemon stop`, `docker volume rm acc-l4-data`; `clients list` | Записи убраны, Cursor — восстановлен без записи (файла до установки не было), копии `*.backup-<время>` рядом; «Not running.» (демон ушёл по простою); `clients list` — «no ai-dev entry»; чужие тома на месте | 1 мин | ✅ |

Журналы: `~/.ai-dev/logs/daemon.log` трёх домов (npx, установка после правок, приложение) — 19, 3 и 6 строк, ни одной
со словами error, fail, exception; под Wine `%USERPROFILE%\.ai-dev\logs\daemon.log` — 19 строк, так же.

## Ручная проверка: 3.0 на Windows (эмулятор Wine 9.0)

Машина: Wine 9.0 (`wine64`, `wine32`) на той же Ubuntu, свежий префикс, Windows 10 по умолчанию, xvfb · чистая: да; Node
для Windows с npm положен в `C:\Program Files\nodejs-acc` для шага W3; git нет.
Что проверял: установщик `AI-Dev-Setup-3.0.0.exe` (192 516 930 байт, собран на Linux с Wine за 192 с) и вариант, в котором
отключена только проверка «AI Dev запущен» electron-builder (192 510 770 байт), — как в фазе 12.

| Шаг | Что сделал | Что увидел | Время | ✅/❌ |
| --- | --- | --- | --- | --- |
| W1 | `AI-Dev-Setup-3.0.0.exe /S`; вариант без проверки запущенной программы; первый старт | Настоящий установщик под Wine — код 2: проверка «AI Dev запущен» ложно находит программу (под Wine нет PowerShell, `tasklist /FI` не фильтрует) — то же, что в фазе 12. Вариант — код 0, `%LOCALAPPDATA%\Programs\ai-dev-desktop`, ярлыки в «Пуске» и на рабочем столе. Окно приложения под Wine не рисуется (ниже); первый старт — тем же `provisionBundle`, что вызывает приложение, его `node.exe`: «installed» за 32,9 с, повтор «present» за 2,7 с; junction Wine не умеет — `ENOTSUP … symlink`, работа из самой копии (Д-295) | 94 с + 33 с | ⚠ установка и копия ✅; окно, «Подготовка AI Dev…», мастер и `LinkType Junction` — не проверены |
| W2 | `ai-dev.cmd clients install --clients=claude-desktop,cursor` из копии | «Claude Desktop added ~\AppData\Roaming\Claude\claude_desktop_config.json», «Cursor added ~\.cursor\mcp.json»; записи называют `…\.ai-dev\app\3.0.0-2aebab4a\node\node.exe` и `…\ai-dev.mjs mcp` — копию, раз ссылки нет | 10 с | ✅ (вместо мастера — его команда) |
| W3 | Первая задача: клиент MCP — тоже процесс Windows, через запись Claude Desktop, Cursor рядом | «Running: pid 384 … 2 session(s): claude-desktop 1.0.0, cursor 1.0.0», канал `\\.\pipe\ai-dev-…`; ранний `complete_task` отклонён; без npm — «quality_gate: unavailable … Could not resolve a shell-free npm entrypoint», закрытие отклонено; с npm в PATH — `npm run test` без оболочки (`npm-node-entrypoint`), `verified`, `complete` | 12 с + 5 с | ✅; описания PR нет — в «машине» нет git |
| Терминал | `ai-dev.cmd settings set/get`, `skills new`, `model status`, `status --quick`, `rules add/list` | Все отвечают как на Linux; «Added: block bash no-force-push», `~\projects\report\.ai-dev\policy.json` создан | — | ✅; «degraded … Everything this install needs is in place.» — Д-599 п. 4 |
| W4 | — | Весов модели нет (L2) | — | не проверено |
| W5 | «Uninstall AI Dev.exe» без `/S`, `ru_RU.UTF-8`, ответы Enter | Три окна по-русски: «Вы уверены, что хотите удалить AI Dev?», «Убрать AI Dev из настроек ваших AI-клиентов (Claude, Cursor, VS Code, Codex, Gemini)? …», «Удалить и данные AI Dev: …»; программа, ярлыки и `.ai-dev\app\*` удалены, записи клиентов убраны, `vault` и `state` на месте | 3 мин | ✅ |
| W6 | — | Docker Desktop и PowerShell под Wine не работают | — | не проверено |

## Что эмулятор не показывает

- **Окно приложения.** Electron 44 под Wine 9.0 стартует, но дочерние процессы Chromium не соединяются с главным
  («Terminating current process after 15 seconds with no connection»), экран чёрный, и до подготовки рантайма дело не
  доходит. Экраны приложения проверены на Linux (выше) и в CI на Windows (`desktop-windows.yml`, e2e).
- **Проверка «AI Dev запущен» установщика** — ложная под Wine; на Windows идёт через PowerShell.
- **Junction**, UAC, SmartScreen, `bootstrap.ps1` и Docker Desktop — только на настоящей Windows.
- **Каналы.** `node.exe` под Wine не пишет в канал Linux (EBADF на stderr) — поэтому клиент в W3 тоже запущен под Wine.

## Найдено и сделано

| Запись | Что | Итог |
| --- | --- | --- |
| Д-594 | План: `npx --yes <путь к tgz>` с полным путём не работает в npm 10.9 | закрыт `34bb829` |
| Д-595 | Загрузка через зеркало: итог называет последний источник и советует задать уже заданное зеркало | закрыт `34bb829` |
| Д-596 | README и MIGRATION: 13 инструментов control API вместо 16 | закрыт `34bb829` |
| Д-597 | Кэши AI Dev в проекте не игнорируются и попадают в описание PR | закрыт `34bb829` |
| Д-598 | Навык из шаблона роняет проверку здоровья: `status` — «failed» | закрыт `34bb829` |
| Д-599 | Мелочи: заголовок PR, «навыки/скиллы», совет `servers`, «degraded» рядом с «всё на месте» | п. 2, 3 закрыты; п. 1, 4 открыты |

## Что остаётся человеку

macOS целиком (M1 … M7); на Windows — окно приложения, мастер, junction, SmartScreen и W6; модель — с настоящими весами
(L2, W4, M4) на машине, которая достаёт huggingface.co; Claude Desktop и Cursor с окном, а не их записи.
