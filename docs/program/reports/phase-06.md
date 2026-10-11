# Отчёт фазы 6: Единый CLI `ai-dev` и подключение клиентов

Статус: @@STATUS@@
PR: — работа идёт прямо в `main` форка по указанию владельца 2026-10-10 (PROGRESS, «Отступления»)
· код фазы — head `@@HEAD@@` · старт от `main` @ `3174584` (конец фазы 5)
Объём: `3174584..@@HEAD@@` — @@STAT@@

### 1. Пункты

| # | Пункт | Статус | Где | Комментарий |
|---|---|---|---|---|
| 1 | `"bin": { "ai-dev": "bin/ai-dev.mjs" }`; `setup` (`--yes`, `--model`, `--frontend-qa`, `--clients=…`, вопросы в TTY), `mcp`, `clients list\|install\|remove\|doctor`, `model install\|import\|verify\|remove\|status`, `doctor`, `version`, `help`; один парсер, понятные ошибки, коды выхода | ✅ | `bin/ai-dev.mjs`, `src/cli/` (`main`, `setup`, `clients`, `model`, `runtime`, `context`), `src/core/cli-args.mjs`; `7099327`, `55de74b` | сверх списка: `model doctor` (бывший `dense:doctor`), команды 2.x (`dashboard`, `galaxy`, `reindex`, `refresh`, `distribution`, `acceptance`, `backup`); коды 0/1/2/130; команды грузятся по требованию — справка и опечатка не трогают ни рантайм, ни данные (Д-161) |
| 2 | Один модуль записи конфигов для локального режима и Docker: Claude Code, Claude Desktop (со Store), Cursor, VS Code, Codex (чужое и комментарии сохраняются), Gemini; имя `ai-dev`; `command` — `process.execPath`, `args` — путь к CLI и `mcp`; `ai-dev-system` уходит с резервной копией; повтор ничего не меняет | ✅ | `src/core/mcp-clients.mjs`, `jsonc-edit.mjs`, `toml-edit.mjs`, `mcp-client-check.mjs`; `scripts/install-docker-mcp-clients.mjs`; `7099327`, `11d26fb` | правка файлов текстом (JSONC и TOML), атомарная запись с перечитыванием перед `rename`, симлинк — через ссылку, права файла сохраняются; `remove` возвращает нетронутый файл байт в байт (запись в `~/.ai-dev/state/mcp-clients.json`); Д-95, Д-162, Д-163 |
| 3 | Д-103: хуки с абсолютным путём к node или через лаунчер, работают без node в PATH; обе копии | ✅ (часть фазы 6) | `hooks/with-node.sh`, `src/core/agent-hooks.mjs`; `7e2a940`, `457f230` | на macOS и Linux — `/bin/sh .ai-dev/hooks/with-node.sh <скрипт>`, git-заглушки тоже; Windows — `node`; Docker-часть Д-103 — фаза 13 |
| 4 | `setup`, `doctor`, `clients:install`, `dense:doctor` — алиасы CLI; `scripts/ai-dev.mjs` поглощён; `scripts/start-local.ps1` удалён; Docker-лаунчеры не тронуты | ⚠️ | `package.json`, `scripts/*.mjs`, `scripts/start-local.ps1`; `7099327` | алиасы — да (и `model`, `dashboard`, `galaxy`, `refresh`, `backup`, `distribution`, `ai-dev`); `scripts/ai-dev.mjs` — делегат; `start-local.ps1` не удалён, а стал обёрткой с предупреждением до 4.0 — правило 5.2 брифа (раздел 6) |
| 5 | Совместимость: записи 2.x работают без переустановки; хуки 2.x работают, повторный `install_agent_hooks` их обновляет; `clients install` мигрирует обе формы имени | ✅ | `scripts/upgrade-check.mjs`; `4681d50` | `upgrade:test` — 122 проверки (было 88), у всех четырёх пользователей 2.x |
| 6 | Документация EN/RU: из клона `npm ci && npm run setup` | ✅ | README, README.ru, INSTALL, GUARDRAILS, UPGRADE-TEST (EN/RU), README сервера, ARCHITECTURE, AGENTS.md; `9882886` | |
| — | Д-145: хук supply-chain и подсказки исправлений через прокси | ✅ | `src/core/http-download.mjs` (тело запроса, `proxyFetch`), `security-fix-registry.mjs`, `hooks/http-proxy.mjs`, `hooks/supply-chain.mjs`; `7e2a940` | записан в фазе 5 на эту фазу; копия клиента в `hooks/` по правилу 3 AGENTS.md, тест сверяет выбор прокси двух копий |
| — | Флаг модели — `--model`, `--dense` остался синонимом | ✅ | `src/core/first-run.mjs`, подсказки в 13 модулях, тесты, документация; `55de74b` | |
| — | Д-165 (найден пробой): повторный `install_agent_hooks` терял хуки пользователя в нашей группе | ✅ | `src/core/agent-hooks.mjs`; `575fb5c` (запись), `457f230` | поведение 2.x, но на пути миграции, который фаза 6 советует |
@@REVIEW_ROW@@

### 2. Дефекты

| № | «до»: команда → вывод | «после»: команда → вывод | Статус |
|---|---|---|---|
| Д-95 | два установщика 2.x в пустой HOME → `.cursor/mcp.json`, `.gemini/settings.json`, `.config/Code/User/mcp.json`, `.claude.json`: `['ai-dev-system', 'ai-dev']` | затем `node bin/ai-dev.mjs clients install` → во всех шести файлах `['ai-dev']`, в Codex один `[mcp_servers.ai-dev]`, 6 резервных копий; `clients doctor` — 6 из 6 отвечают на `initialize`, instructions 1 048 символов | закрыт |
| Д-103 | `install_agent_hooks` → 9 команд `node .ai-dev/hooks/<s>`; PATH только с git → 0 из 9 выходят с 0 («node: not found», 127) | 9 команд `/bin/sh .ai-dev/hooks/with-node.sh <s>`; тот же PATH → 9 из 9 с 0; `git commit` с этим PATH: «dirname: not found» → exit 0; `.node-path` — в `.gitignore` | часть фазы 6 закрыта; Docker — фаза 13 |
| Д-145 | проба `hook-proxy.mjs`: `security-fix-registry` — «fetch failed»; хук — «not fully checked: … fetch failed»; прокси увидел 0 запросов | `{"ok":true,"versions":["1.3.0"]…}`; прокси увидел 3 запроса (GET реестра дважды, POST advisory); тест — реестр, advisory и OSV через `HTTP_PROXY`, вердикт без «not fully checked» | закрыт |
| Д-161 | `node scripts/ai-dev.mjs start < init.json` → exit 0 за 292 мс, stdout 0 байт; `… statsu` с `AI_DEV_HOME` 2.x → exit 1 за 227 мс, файлы перенесены | `start` → 1 333 байт, instructions 1 048 символов, пометка в stderr; `statsu` → exit 2 за 52 мс, «There is no command "statsu"…», файлы на месте | закрыт |
| Д-162 | Docker-установщик: пустой `mcp.json` → exit 1, stack trace, записан только codex; комментарий в Gemini → exit 1, записаны два из шести; подтаблица и `"ai-dev"` в Codex → `tomllib`: «Cannot declare … twice» | пустой и JSONC — exit 0, записаны все шесть, комментарий на месте; оборванный JSON — exit 1, `partial`, пять из шести записаны, строка названа; оба `config.toml` читаются | закрыт |
| Д-163 | `~/.claude.json` на 21 388 952 байт, `SIGKILL` при изменении размера → 0 байт, 10 из 10 битые | `SIGKILL` через 150–625 мс, 20 прогонов → битых 0 (исходный 13, записанный 7); брошенные `.tmp` удаляются следующим запуском | закрыт |
| Д-164 | репозиторий Git с `package.json` в `apps/web`: хук `project-3dab8b…` (корень), сервер `project-208b89…` (`apps/web`) | — | открыт: фаза 8 (правило 4) |
| Д-165 | хук пользователя в группе Stop и в группе Bash рядом с нашими → после повторного `install_agent_hooks`: оба пропали (`3174584` и `9882886`) | оба на месте, в своих группах под своим matcher; третья установка ничего не меняет | закрыт |
@@REVIEW_DEFECTS@@

### 3. Критерии приёмки

| Критерий | Команда | Фактический вывод | ✅/❌ |
|---|---|---|---|
| Пустой HOME с конфигами шести клиентов (внутри чужие серверы): `node bin/ai-dev.mjs setup --yes --clients all` | чистый worktree, `npm ci`, HOME с шестью файлами (github, filesystem, linear, playwright, sentry, context7), затем команда | 3,8 с; «4 built, 3 skipped, 0 failed»; «6 changed, 0 unchanged» — добавлено во все шесть, у каждого резервная копия; «Health: ok — 24 check(s), 0 not passing»; exit 0 | ✅ |
| Diff каждого конфига — в отчёт | `diff -u` исходного и записанного | раздел 3.1 ниже | ✅ |
| Повтор — «без изменений» | та же команда ещё раз | все шесть `unchanged`, «No changes: every client already runs this install.», Health ok | ✅ |
| `remove` возвращает исходное | `node bin/ai-dev.mjs clients remove`, `cmp` с исходными | шесть `restored`; `cmp` — шесть из шести идентичны исходным | ✅ |
| Команда из конфига запускается и отвечает на `initialize` с `instructions` | `node bin/ai-dev.mjs clients doctor` | шесть из шести «ok — ai-dev-system 2.0.0 answered in 313–507 ms, instructions 1048 chars» | ✅ |
| Хук работает при PATH без node | проба `d103/probe.mjs` (MCP `install_agent_hooks`, PATH только с git); тест `a hook runs with no Node on PATH …`; `upgrade:test` | 9 из 9 команд — exit 0 (2.x — 0 из 9, 127); тест 2.x-команда — 127, новая — 0; upgrade:test — 4 из 4 | ✅ |
| `upgrade:test` покрывает конфиги и хуки 2.x | `npm run upgrade:test` | @@UPGRADE@@ | ✅ |
| `check` и `acceptance` зелёные | раздел 4 | @@GATES@@ | ✅ |
| В чек-лист владельца: на Windows Claude Desktop, Cursor и VS Code видят `ai-dev`, `begin_task` отвечает | — | раздел 8 | ✅ |

#### 3.1. Diff конфигов после `setup --yes --clients all`

`<clone>` — путь чистого worktree; Node — `/opt/node22/bin/node`.

```diff
--- a/.claude.json
+++ b/.claude.json
@@ -4,6 +4,14 @@
     "github": {
       "type": "stdio",
       "command": "gh-mcp"
+    },
+    "ai-dev": {
+      "type": "stdio",
+      "command": "/opt/node22/bin/node",
+      "args": [
+        "<clone>/ai-dev-mcp-server/bin/ai-dev.mjs",
+        "mcp"
+      ]
     }
   }
 }
--- a/.config/Claude/claude_desktop_config.json
+++ b/.config/Claude/claude_desktop_config.json
@@ -3,6 +3,13 @@
     "filesystem": {
       "command": "npx",
       "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/u"]
+    },
+    "ai-dev": {
+      "command": "/opt/node22/bin/node",
+      "args": [
+        "<clone>/ai-dev-mcp-server/bin/ai-dev.mjs",
+        "mcp"
+      ]
     }
   }
 }
--- a/.cursor/mcp.json
+++ b/.cursor/mcp.json
@@ -1,5 +1,12 @@
 {
   "mcpServers": {
-    "linear": { "url": "https://mcp.linear.app/sse" }
+    "linear": { "url": "https://mcp.linear.app/sse" },
+    "ai-dev": {
+      "command": "/opt/node22/bin/node",
+      "args": [
+        "<clone>/ai-dev-mcp-server/bin/ai-dev.mjs",
+        "mcp"
+      ]
+    }
   }
 }
--- a/.config/Code/User/mcp.json
+++ b/.config/Code/User/mcp.json
@@ -2,5 +2,13 @@
 	// my servers
 	"servers": {
 		"playwright": { "type": "stdio", "command": "npx", "args": ["@playwright/mcp"] },
+		"ai-dev": {
+			"type": "stdio",
+			"command": "/opt/node22/bin/node",
+			"args": [
+				"<clone>/ai-dev-mcp-server/bin/ai-dev.mjs",
+				"mcp"
+			]
+		},
 	},
 }
--- a/.codex/config.toml
+++ b/.codex/config.toml
@@ -4,3 +4,9 @@
 [mcp_servers.sentry]
 command = "npx"
 args = ["-y", "@sentry/mcp"]
+
+[mcp_servers.ai-dev]
+command = "/opt/node22/bin/node"
+args = ["<clone>/ai-dev-mcp-server/bin/ai-dev.mjs", "mcp"]
+startup_timeout_sec = 120
+tool_timeout_sec = 3600
--- a/.gemini/settings.json
+++ b/.gemini/settings.json
@@ -1,6 +1,13 @@
 {
   "theme": "Default",
   "mcpServers": {
-    "context7": { "httpUrl": "https://mcp.context7.com/mcp" }
+    "context7": { "httpUrl": "https://mcp.context7.com/mcp" },
+    "ai-dev": {
+      "command": "/opt/node22/bin/node",
+      "args": [
+        "<clone>/ai-dev-mcp-server/bin/ai-dev.mjs",
+        "mcp"
+      ]
+    }
   }
 }
```

### 4. Проверки

@@CHECKS@@

### 5. Не проверено

| Что | Почему | Как проверить |
|---|---|---|
| Живые клиенты читают записанные конфиги: Claude Desktop (обычный и из Microsoft Store), Cursor, VS Code, Codex, Gemini CLI | в песочнице нет ни одного клиента и нет Windows и macOS | чек-лист владельца, раздел 8, п. 1–4; здесь команда каждой записи запущена так, как её запускает клиент (`clients doctor`: без оболочки, `env` записи поверх окружения) |
| Клиент из Dock или «Пуска» без PATH оболочки находит `node` по абсолютному пути | нет macOS и Windows | раздел 8, п. 2 |
| Хуки на Windows (`node …`) и git-заглушки через `/bin/sh` из Git for Windows, `.node-path` с `C:/…` | нет Windows | раздел 8, п. 5 |
| Хуки Cursor из Dock через лаунчер | нет Cursor и macOS; формат `hooks.json` и так не проверен вживую (Д-2) | раздел 8, п. 6 |
| Репозиторий, где хуки ставили и на Windows, и на macOS: форма команды — того, кто ставил последним | нет двух ОС | раздел 8, п. 7 |
| Хук supply-chain за NTLM- или Kerberos-прокси | клиент говорит только Basic из URL прокси | раздел 8, п. 8 |
| Вопросы `setup` в настоящем терминале Windows (PowerShell, cmd) | нет Windows; в Linux проверено через `script` (pty) | раздел 8, п. 1 |

### 6. Отступления и принятые решения

1. **`scripts/start-local.ps1` не удалён**, а стал обёрткой: печатает в stderr, что это теперь `ai-dev mcp`, и
   запускает `node bin\ai-dev.mjs mcp`. Бриф говорит «удаляется», но он задокументирован в README сервера, а правило 5.2
   брифа велит убирать публичное только через обёртку с предупреждением; удаление — в 4.0. Поиск Node в Codex runtime
   внутри него оставлен до фазы 7 (Д-104).
2. **`scripts/ai-dev.mjs` — делегат `bin/ai-dev.mjs`** с той же пометкой в stderr; `first-run.mjs`, `model.mjs`,
   `dense-doctor.mjs` — делегаты без пометки (их зовут npm-скрипты), `install-local-mcp-clients.mjs` — обёртка над
   `clients install` с прежними флагами (без `--apply` — пробный прогон) и прежним JSON.
3. **`--clients all` — все клиенты, найденные на машине** (есть их папка), а не все шесть: создавать `~/.cursor/mcp.json`
   тому, у кого нет Cursor, — мусор. Клиент, названный явно, пишется и там, где не найден.
4. **Без терминала и без `--yes` `setup` клиентов не трогает** (CI, конвейер); `--yes` — ответы по умолчанию (клиенты
   да, загрузки нет).
5. **Хуки на Windows остаются `node …`.** Приложения из «Пуска» получают PATH пользователя, куда Node кладут установщик
   и nvm-windows, а команда `/bin/sh …` без Git Bash не запустится вовсе. Лаунчер ставится и там (для git-заглушек,
   которые Git for Windows запускает своей оболочкой). В репозитории, где хуки ставили с разных ОС, форма команды —
   того, кто ставил последним (раздел 8, п. 7).
6. **Записанный путь к Node** (`.ai-dev/hooks/.node-path`) — рядом с хуками, под `.gitignore`: сами хуки README советует
   коммитить. Из контейнера (`AI_DEV_RUNTIME=docker`) путь не пишется — тот Node не хоста.
7. **`remove` точен благодаря записи** `~/.ai-dev/state/mcp-clients.json` (sha256 после записи и путь к копии
   исходного): файл, который никто не трогал, получает ровно то, что было; иначе из него вырезается только запись.
   Запись необязательна: если её не записать (HOME контейнера — `/`), установка от этого не падает.
8. **Docker-установщик сохранил флаги и форму записей** (их сменит фаза 13: `docker run -i --rm …`), но пишет через
   общий модуль; теперь он и удаляет `ai-dev-system`, а сбой одного клиента — `partial` с кодом 1 вместо остановки.
9. **`ai-dev doctor` выходит с 0, когда проверка прошла**, как `npm run doctor` в 2.x, даже при `fail` в ней: скрипты
   2.x могли на это опираться. `clients doctor` и `model doctor` — 1 при неудаче.
10. **Подсказки внутри продукта по-прежнему называют `npm run …`** (они работают из клона); форма `ai-dev …` — в справке
    CLI и документации. Какую форму называть в установке из пакета — решит раскладка фазы 7.
11. **Флаг модели — `--model`** (как в брифе); `--dense` и `--dense-python` остаются его синонимами.
12. **Д-164 (идентичность хука в пакете монорепозитория) — на фазу 8** по правилу 4: это не путь к Node, а запись
    состояния хуками, которую фаза 8 делит с демоном. **Д-165 закрыт в фазе:** повторная установка хуков — путь
    миграции, который фаза 6 советует пользователям 2.x.
13. **AGENTS.md поправлен раньше фазы 14** в двух фактах: где лежат команды CLI и что потолок 800 строк теперь и над
    `bin/` и `src/cli/`.

### 7. Влияние на установки 2.x

- **Что меняется.** Есть `ai-dev` (из клона `npm run ai-dev -- …`). `npm run setup` в терминале задаёт вопросы и
  подключает клиентов; без терминала ведёт себя как раньше. Записи клиентов 3.0 — `ai-dev` с абсолютным путём к Node и
  `bin/ai-dev.mjs mcp`, без `AI_DEV_PYTHON`. Хуки, установленные заново, запускаются через `with-node.sh` (macOS,
  Linux). Хук supply-chain и подсказки исправлений ходят через прокси. Docker-установщик при повторном bootstrap
  удаляет `ai-dev-system`.
- **Что мигрирует само и каким тестом доказано.** Ничего не ломается без действия: записи 2.x (`node
  <клон>/…/src/server.mjs`, `ai-dev-system` и Docker `ai-dev`) работают, хуки 2.x работают там, где `node` в PATH,
  `scripts/ai-dev.mjs`, `install-local-mcp-clients.mjs`, `start-local.ps1`, `first-run.mjs` работают
  (`upgrade:test`: «the server starts from the 2.x client entry», «the 2.x SessionStart hook runs»; тесты делегатов).
  `npm run setup` или `npm run clients:install` переводят конфиги на одну запись `ai-dev` с резервной копией каждого
  файла; повторный `install_agent_hooks` — хуки на лаунчер, не теряя хуков пользователя (`upgrade:test`, 122 проверки;
  тест Д-165).
- **Что требует действия пользователя** (текст для заметки о миграции): «После обновления выполните
  `npm run setup` (или `npm run clients:install`): в каждом найденном клиенте останется одна запись `ai-dev` вместо
  `ai-dev-system` и Docker-записи рядом; прежние файлы сохранены как `<файл>.backup-<время>`. Перезапустите клиентов.
  В каждом репозитории, куда ставили хуки, ещё раз вызовите `install_agent_hooks` — хуки начнут находить Node и без
  него в PATH (клиент из Dock). Вместо `node scripts/ai-dev.mjs …` пишите `npm run ai-dev -- …` (или `ai-dev` после
  `npm link`); старые пути работают до 4.0.»
- **Как откатиться.** `git checkout` коммита 2.x и `npm ci`. Конфиги клиентов: `npm run ai-dev -- clients remove` до
  отката (нетронутые файлы вернутся байт в байт, записи 2.x — нет: их снова пишет `npm run clients:install` 2.x) или
  копии `<файл>.backup-<время>`. Хуки: `install_agent_hooks` 2.x перепишет регистрации обратно на `node …` (их группы
  он узнаёт по `.ai-dev/hooks/`); `.node-path`, `.gitignore` и `with-node.sh` в `.ai-dev/hooks/` 2.x не мешают.

### 8. Для следующих фаз и в чек-лист владельца

- Фаза 7: раскладка пакета решает, какую форму команды называть в подсказках (`npm run …` или `ai-dev …`); `npx`-кэш
  не годится как постоянный путь `args` в конфигах клиентов — нужен стабильный путь к CLI; `start-local.ps1` и поиск
  Codex runtime в нём — Д-104; Д-160 вместе с Д-135.
- Фаза 8: `ai-dev mcp` становится мостом к демону (точка уже одна: `runStdioServer`); Д-164.
- Фаза 9: управляющий API может звать `installServer`/`removeServer`/`readServerEntries` из `mcp-clients.mjs` напрямую.
- Фаза 13: `ai-dev clients install --docker` — тот же модуль, записи `docker run -i --rm …`; Docker-часть Д-103.
- Чек-лист владельца:
  1. **Windows, чистая машина с Node (первая живая проверка C3).** `cd ai-dev-mcp-server && npm ci && npm run setup` в
     PowerShell: вопросы `[Y/n]`, «Connect ai-dev to …» — ответить Enter; перезапустить Claude Desktop, Cursor, VS Code —
     в каждом виден сервер `ai-dev`, по просьбе «вызови begin_task для <папка>» он отвечает. `npm run ai-dev -- clients
     doctor` — «ok» у каждого. Время каждого шага.
  2. **macOS, Node из nvm или Homebrew, клиенты из Dock.** То же; Claude Desktop видит `ai-dev` (запись с абсолютным
     путём к Node).
  3. **Claude Desktop из Microsoft Store (Windows).** `npm run ai-dev -- clients list` показывает строку «Claude Desktop
     (Store)», после install клиент видит `ai-dev`.
  4. **Codex и Gemini CLI.** После `clients install` `codex mcp list` и `/mcp` в Gemini показывают `ai-dev`; у Gemini с
     комментариями в `settings.json` комментарии на месте.
  5. **Хуки на Windows.** `install_agent_hooks` в репозитории, сессия Claude Code — guard останавливает `git push
     --no-verify`; коммит из Git for Windows запускает pre-commit (`.ai-dev/git-hooks`).
  6. **Хуки из Dock (macOS).** Cursor, открытый из Dock, с Node только из nvm: хук `beforeShellExecution` срабатывает
     (guard отказывает в `rm -rf /`), в логе нет «node: not found».
  7. **Смешанная команда.** Репозиторий, где хуки ставили на macOS, открыт на Windows в Claude Code: SessionStart
     срабатывает (команда `/bin/sh …` идёт через Git Bash) — или зафиксировать, что нет.
  8. **Корпоративный прокси.** `HTTPS_PROXY=http://user:pass@proxy:port`, в Claude Code `npm i left-pad` — нет
     «not fully checked»; `run_security_scan` предлагает версии исправлений.
