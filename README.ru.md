# AI Dev MCP System

> 🇬🇧 English: [README.md](README.md) · 🇷🇺 Эта страница — русская версия.
> При расхождениях англоязычный README считается основным.

Локальная система для разработки с ИИ-агентами. Она предоставляет MCP-инструменты для
контекста репозитория, базы знаний и skills, поиска, запуска quality gates и проверяемого
ведения задач. Сервер работает по `stdio`: не открывает сетевой порт и не требует удалённого
MCP-сервера.

Подключать к нему нужно не «модель напрямую», а MCP-совместимый клиент, в котором выбрана
модель: Codex, Cursor, Claude Desktop или Claude Code, VS Code с MCP, Gemini CLI/Code Assist
или другой MCP-host. Одна и та же локальная конфигурация доступна всем этим клиентам.

## Что входит

- локальный MCP-сервер на Node.js;
- база знаний, проектный контекст и управляемая библиотека skills;
- гибридный поиск: SQLite FTS, sparse-поиск и опциональный локальный BGE-M3;
- task lifecycle: `begin_task`, `checkpoint_task`, `verify_task`, `complete_task`;
- quality gate, security-проверки и Frontend QA с Playwright/Chromium;
- [память между сессиями](#память-и-обучение): handoff, решения и выученные инстинкты;
- [хуки агента](#хуки) для Claude Code и Cursor: защита команд и записи файлов;
- Docker-образ для команды: без личного Vault, паролей, токенов, проектов и task history.

## Требования

Для Docker-варианта:

- Docker Desktop (Windows/macOS) или Docker Engine (Linux); bootstrap может установить его;
- Docker должен иметь доступ к выбранной папке с проектами.

Для запуска из исходников дополнительно нужны Node.js 22.12+ и npm. На Windows можно использовать
bundled runtime Codex, описанный в [README сервера](ai-dev-mcp-server/README.md).

## Один запуск на Windows

После `git clone` откройте PowerShell в корне клона и выполните:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

Скрипт сам создаёт изолированную папку `AI-Dev-Projects` в домашнем каталоге, устанавливает
Docker Desktop и Node.js LTS через `winget`, если их нет, скачивает опубликованный образ,
проверяет MCP и добавляет локальный сервер `ai-dev` в Codex, Cursor, Gemini, VS Code и Claude.
Для Windows он также устанавливает копию только лаунчера в
`C:\ProgramData\AI-Dev-System\run-mcp.ps1`: это исключает проблемы кодировки, когда путь к
клону содержит кириллицу. В эту папку не копируются проекты, Vault, токены или пароли.
Для Claude Desktop дополнительно создаётся компактный `ClaudeMcpProxy.exe` в той же папке.
Он отвечает на MCP-инициализацию до запуска Docker, поэтому обходится короткий стартовый тайм-аут
Claude; затем весь обмен прозрачно передаётся в локальный Docker-контейнер.
Первый запуск нужно выполнять **от имени администратора**, только если Docker Desktop или Node.js
ещё не установлены: `winget` и Docker могут запросить повышение прав. При уже установленном
Docker Desktop обычного PowerShell достаточно.

Для другой папки с репозиториями и выбора клиентов:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 `
  -ProjectPath "D:\Projects" `
  -Clients "codex,cursor,vscode"
```

Путь хранится только в локальных настройках выбранных клиентов. В Git не записываются токены,
пароли, содержимое этой папки или ваш профиль. После выполнения перезапустите нужный ИИ-клиент.

## Один запуск на macOS и Linux

Если Docker уже установлен и запущен:

```bash
sh ./bootstrap.sh
```

Если Docker ещё не установлен, одна команда выбирается по системе:

| Система | Команда после `git clone` |
| --- | --- |
| macOS | `sh ./bootstrap.sh --install-prerequisites` |
| Debian / Ubuntu | `sh ./bootstrap.sh --install-prerequisites` |
| Fedora | `sh ./bootstrap.sh --install-prerequisites` |
| Arch Linux / Manjaro | `sh ./bootstrap.sh --install-prerequisites` |

На macOS скрипт использует Homebrew: при необходимости устанавливает Homebrew официальным
инсталлятором, затем выполняет `brew install --cask docker`, запускает Docker Desktop и ждёт
готовности engine. Первый запуск Docker Desktop может потребовать принятия лицензии и подтверждения
привилегированных настроек в окне приложения.

На Linux используются `apt`, `dnf` или `pacman`, включается сервис Docker и текущий пользователь
добавляется в группу `docker`. После этого нужно выйти и войти в систему, затем повторить команду.

Bootstrap не требует Node.js на хосте: для настройки MCP-клиентов он использует временный
`node:24` контейнер. По умолчанию скачивается
`ghcr.io/stonebridgeway/ai-dev-system:latest`, а рабочая папка создаётся как
`~/AI-Dev-Projects` и монтируется в контейнер как `/workspace`.

Чтобы Claude Desktop и другие клиенты не обрывали медленный холодный запуск Docker, bootstrap
создаёт служебный контейнер `ai-dev-system-runtime-$(id -u)`. Он работает без сети, с
read-only filesystem, без Linux capabilities и с `no-new-privileges`; доступ получает только
к named volume системы и выбранной папке проектов. Сам MCP-процесс запускается через быстрый
`docker exec`, а launcher немедленно завершает протокольную инициализацию. Контейнер автоматически
поднимается после перезапуска Docker благодаря `restart=unless-stopped`.

Для другой папки проектов и части клиентов:

```bash
sh ./bootstrap.sh --project-path "$HOME/Dev" --clients "codex,cursor,vscode"
```

Повторный запуск той же команды безопасно обновляет только управляемый runtime-контейнер.
Named volume, индексы, база знаний и файлы проектов не удаляются. Проверить runtime можно командой:

```bash
docker ps --filter "label=ai-dev.system.runtime=true"
```

Для разработки самого образа используйте явный локальный режим:

```bash
sh ./bootstrap.sh --build-local
```

## Быстрый старт: Docker

### 1. Получите образ

```powershell
docker pull ghcr.io/stonebridgeway/ai-dev-system:latest
```

Либо соберите образ из клона репозитория:

```powershell
cd ai-dev-mcp-server
npm ci --ignore-scripts --no-audit --no-fund
npm run docker:prepare
npm run docker:audit
npm run docker:build
npm run docker:smoke -- --image ai-dev-system:local
```

Сборка всегда использует временный allowlist-контекст `.docker/build-context`, а не корень
репозитория или Obsidian Vault. Не меняйте Docker context на корень Vault.

### 2. Выберите рабочую папку

Создайте или выберите папку, в которой лежат только репозитории, с которыми агенту разрешено
работать. Например `C:\\Dev` на Windows или `$HOME/Dev` на macOS/Linux. Эта папка будет
подключена в контейнер как `/workspace`.

Не указывайте личный Vault, домашнюю папку целиком, папку с секретами или резервными копиями.

### 3. Проверьте локальный запуск

Windows:

```powershell
$env:AI_DEV_IMAGE = "ghcr.io/stonebridgeway/ai-dev-system:latest"
$env:AI_DEV_PROJECT_PATH = "C:\\Dev"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\docker\\run-mcp.ps1
```

macOS/Linux:

```bash
export AI_DEV_IMAGE="ghcr.io/stonebridgeway/ai-dev-system:latest"
export AI_DEV_PROJECT_PATH="$HOME/Dev"
sh ./docker/run-mcp.sh
```

Процесс будет ожидать MCP-сообщения в стандартном вводе. Это ожидаемое поведение: завершите
проверку `Ctrl+C`, затем подключите команду launcher к MCP-клиенту.

## Подключение к ИИ-агентам

Во всех случаях замените `C:\\ABSOLUTE\\PATH` на абсолютный путь к клону этого репозитория,
а `C:\\Dev` на разрешённую папку с вашими проектами. Не добавляйте эти значения в Git.

### Codex

Добавьте в пользовательский `config.toml`:

```toml
[mcp_servers.ai-dev]
command = "powershell.exe"
args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"]
env = { AI_DEV_IMAGE = "ghcr.io/stonebridgeway/ai-dev-system:latest", AI_DEV_PROJECT_PATH = "C:\\Dev" }
startup_timeout_sec = 120
tool_timeout_sec = 3600
```

На macOS/Linux используйте `command = "/bin/sh"`, а в `args` передайте абсолютный путь к
`docker/run-mcp.sh`. В `env` также укажите имя, созданное bootstrap:
`AI_DEV_RUNTIME_CONTAINER = "ai-dev-system-runtime-UID"`, где `UID` возвращает `id -u`.
Автоматический установщик делает это сам. Перезапустите Codex и проверьте, что в списке
MCP-инструментов появился сервер `ai-dev`.

### Cursor, Claude Desktop, Claude Code и Gemini

Эти клиенты используют JSON со свойством `mcpServers`. Добавьте или объедините следующий блок
с их существующей конфигурацией:

При запуске `bootstrap.ps1 -Clients claude` установщик обновляет оба локальных файла Claude:
`%USERPROFILE%\\.claude.json` для Claude Code и
`%APPDATA%\\Claude\\claude_desktop_config.json` для Claude Desktop. Существующие серверы
сохраняются, а изменяемый файл получает резервную копию. Для Microsoft Store-версии Claude
установщик также обновляет изолированный профиль приложения в `%LOCALAPPDATA%\\Packages\\Claude_*`.
На Windows не заменяйте автоматически установленную Claude-конфигурацию примером ниже: она
использует `C:\ProgramData\AI-Dev-System\ClaudeMcpProxy.exe` для быстрого старта Docker-MCP.
На macOS/Linux bootstrap аналогично сохраняет в конфигурации `AI_DEV_RUNTIME_CONTAINER` и
подключает быстрый launcher; вручную редактировать файлы Claude после bootstrap не требуется.

```json
{
  "mcpServers": {
    "ai-dev": {
      "command": "powershell.exe",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"
      ],
      "env": {
        "AI_DEV_IMAGE": "ghcr.io/stonebridgeway/ai-dev-system:latest",
        "AI_DEV_PROJECT_PATH": "C:\\Dev"
      }
    }
  }
}
```

Готовый минимальный шаблон без доступа к проектам находится в
[docker/mcp-config.example.json](docker/mcp-config.example.json). После изменения конфигурации
полностью перезапустите клиент. В Claude Code и Gemini CLI конфигурация может быть добавлена
через их собственную команду управления MCP, но команда запуска и переменные окружения остаются
теми же.

### VS Code

Создайте `.vscode/mcp.json` в конкретном рабочем репозитории или внесите такой же сервер в
пользовательские настройки MCP VS Code:

```json
{
  "servers": {
    "ai-dev": {
      "type": "stdio",
      "command": "powershell.exe",
      "args": [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"
      ],
      "env": {
        "AI_DEV_IMAGE": "ghcr.io/stonebridgeway/ai-dev-system:latest",
        "AI_DEV_PROJECT_PATH": "C:\\Dev"
      }
    }
  }
}
```

Перезагрузите окно VS Code. Внутри контейнера пути к смонтированным репозиториям начинаются с
`/workspace`; например, для `begin_task` используйте `/workspace/my-project`.

## Как работать с агентом

1. Откройте нужный репозиторий в выбранном MCP-клиенте.
2. Дайте агенту конкретную задачу и путь внутри `/workspace`.
3. Для содержательной работы агент запускает `begin_task`, изучает сформированный контекст и
   использует не более трёх подобранных skills.
4. После изменения кода агент фиксирует прогресс через `checkpoint_task`, запускает
   `verify_task` и завершает работу через `complete_task` только с актуальными доказательствами.

Пример запроса агенту:

```text
Используй MCP-сервер ai-dev. Начни задачу для /workspace/my-project:
добавь экспорт отчёта в CSV, покрой изменение тестами и проведи verify_task.
```

## Память и обучение

Сервер держит память трёх видов, чтобы новая сессия не начиналась с нуля. Всё
это — читаемый текст, и ничего не пишется без явного вызова.

| Инструмент | Что хранит | Где |
| --- | --- | --- |
| `save_session` | Структурированный handoff: что строим, что сработало и с какими доказательствами, что не сработало и почему, состояние файлов, блокеры и точный следующий шаг. | `~/.ai-dev/state/sessions/`, проекция в `.ai-dev/context/handoff.md` |
| `resume_session` | Ничего — читает последний handoff обратно в виде брифинга: что не повторять, блокеры, следующий шаг, открытые задачи, состояние git и подходящие инстинкты. | — |
| `record_decision` | Нумерованный ADR: заголовок, контекст, решение, альтернативы, последствия. | `.ai-dev/decisions/`, версионируется вместе с кодом |
| `record_instinct` | Одно выученное поведение «когда *триггер*, *действие*» с уверенностью, которая растёт при повторных наблюдениях и распадается со временем. | `~/.ai-dev/state/instincts.json` |
| `context_budget_status` | Ничего — оценивает статический контекст задачи против окна модели и говорит, когда сжатие безопасно. | — |

Решения, свежий handoff и инстинкты с уверенностью выше 70% попадают в context
pack, который собирает `begin_task`, — следующая сессия видит их без запроса.
Сессии и инстинкты лежат в домашнем каталоге (на пользователя), решения — в
репозитории (на проект, их видно в pull request). Сессии и инстинкты ключуются по
репозиторию, а не по каталогу: worktree задачи, созданный `begin_task_in_worktree`,
и основной checkout читают и пишут одну память, а задача остаётся привязанной к
тому рабочему дереву, в котором её начали.

Промпт `learn_from_task` замыкает цикл: запустите его после задачи, и агент
разберёт ход работы, запишет устойчивые паттерны инстинктами, архитектурные
выборы — решениями, а если работа продолжится в другой сессии, сохранит handoff.
Он намеренно осторожен: единичные случаи, код и секреты в долговременную память
не попадают.

`list_instincts` показывает выученное, `update_instinct` подтверждает или
отправляет инстинкт в отставку, а `evolve_instincts` собирает зрелые инстинкты в
черновики скиллов и продвигает в глобальные те, что встретились в нескольких
проектах.

## Хуки

`install_agent_hooks` встраивает защиту сервера в самого агента: она работает на
каждом действии, а не только на тех инструментах, которые агент решил позвать.

```text
Используй MCP-сервер ai-dev. Вызови install_agent_hooks для /workspace/my-project
с targets ["claude"] и profile "standard".
```

Инструмент кладёт самодостаточные скрипты в `.ai-dev/hooks/`, политику в
`.ai-dev/policy.json` и регистрации в `.claude/settings.json` (Claude Code)
и/или `.cursor/hooks.json` (Cursor). Существующие настройки не затираются, а
объединяются: переписываются только прежние записи AI Dev. Повторный запуск
обновляет скрипты и сохраняет ваши правила. `agent_hooks_status` показывает, что
установлено.

Хуки останавливают команду до запуска (обход git-хуков, разрушительные и
публикующие команды), останавливают запись до применения (файлы-носители
секретов, секреты в содержимом, ослабленная конфигурация линтера), форматируют
изменённые файлы, подкладывают последний handoff и открытые задачи в начале
сессии, выжимают из транскрипта запись сессии в конце, учитывают расход каждого
ответа и советуют, когда сжимать контекст. Любая ошибка хука завершается кодом 0,
поэтому сломанный хук не блокирует агента.

То, что хук пишет в конце сессии, — черновик, а не handoff: его поля получены
эвристиками по транскрипту. Поэтому `resume_session` показывает такую запись с
пометкой «не подтверждено», а `save_session` с `confirm_hook_draft: true`
превращает её в полноценную: ваши поля побеждают, остальное берётся из
черновика, сам черновик удаляется.

Хук захвата стоимости читает тот же транскрипт с другой целью: после каждого
ответа он суммирует токены сообщений ассистента, появившихся с прошлого раза, и
дописывает их в usage ledger по моделям. Он пишет токены, а не деньги:
`usage_report` считает стоимость при чтении по опубликованным тарифам Anthropic
и показывает «сегодня», «вчера», «за 7 дней», а также итоги по моделям и
задачам. Цены меняются, поэтому `model_rates` в `.ai-dev/policy.json`
переопределяет любую строку (доллары за миллион токенов), а модель без тарифа
попадает в список «без цены», а не считается бесплатной.

Три профиля:

- `minimal` — только guard на команды и файлы, запись сессии и захват стоимости.
- `standard` — по умолчанию: всё перечисленное, включая форматирование,
  подкладывание контекста при старте, советник по сжатию и проверку в конце ответа.
- `strict` — тот же набор плюс дополнительные предупреждения перед `git push`
  и `git commit --amend`.

`.ai-dev/policy.json` — место для настройки без правки скриптов:
`allow_config_edits`, `format_on_edit`, пороги сжатия, `model_rates` и ваши
собственные правила:

```json
{
  "profile": "standard",
  "rules": [
    {
      "id": "block-prod-migrations",
      "event": "bash",
      "pattern": "(migrate|migration).*(--prod|production)",
      "action": "block",
      "message": "Production migrations need explicit human approval."
    }
  ]
}
```

`event` — `bash`, `file` или `all`; `action` — `block` или `warn`.

## Локальные данные и безопасность

Образ содержит только проверенный публичный seed: правила, prompts, quality gates, разрешённые
skills и runtime. В него не включаются:

- пароли, токены, `.env`, ключи и пользовательские конфигурации;
- личный Obsidian Vault, `.codex`, `.ai-dev`, Git history и локальные кэши;
- `02-knowledge/Projects`, `02-knowledge/Task Runs`, индексы, логи, backup-архивы;
- исходники и контекст ваших проектов;
- веса BGE-M3.

Данные, созданные контейнером, хранятся в локальном Docker volume `ai-dev-system-data`.
Обновление образа не перезаписывает этот volume. По умолчанию контейнер запускается без сети,
не от root, с read-only root filesystem, без Linux capabilities и с `no-new-privileges`.

Если проекту действительно нужен интернет во время проверки, задайте
`AI_DEV_DOCKER_NETWORK=bridge` осознанно только для такого запуска.

## Docker Compose и BGE-M3

Для Compose скопируйте `docker/compose.local.example.yaml` в `docker/compose.local.yaml`, укажите
локальный `AI_DEV_PROJECT_PATH` и запустите:

```bash
docker compose -f docker/compose.yaml -f docker/compose.local.yaml run --rm -T ai-dev-mcp
```

`compose.local.yaml` и `docker/.env` игнорируются Git, поскольку могут содержать локальные пути.

Для более точного семантического поиска можно собрать вариант с BGE-M3:

```bash
docker build --build-arg INSTALL_BGE_M3=1 --tag ai-dev-system:bge .docker/build-context
```

Веса модели не встраиваются в образ. Смонтируйте собственную локальную папку через
`AI_DEV_MODEL_PATH`; launcher подключит её read-only как `/models/bge-m3`.

## Публикация для команды

Workflow [docker-publish.yml](.github/workflows/docker-publish.yml) проверяет privacy policy,
пересобирает allowlist-контекст, запускает MCP smoke test и публикует образы `linux/amd64` и
`linux/arm64` в GitHub Container Registry с SBOM и provenance.

После первого push:

1. Откройте package в GitHub и выберите видимость `private/internal` для команды или `public`.
2. Убедитесь, что у коллег есть право читать GitHub Packages.
3. Дайте коллегам адрес `ghcr.io/stonebridgeway/ai-dev-system:latest` и этот README.
4. Каждый коллега указывает свою локальную папку проектов через `AI_DEV_PROJECT_PATH`; чужие
   файлы в образ и Git не попадают.

## Arch/AUR и Homebrew

После публикации в AUR на Arch Linux / Manjaro выполните:

```bash
yay -S ai-dev-system-git
ai-dev-system --install-prerequisites
```

Пакет также можно собрать из этого клона:

```bash
cd packaging/arch
makepkg -si
ai-dev-system --install-prerequisites
```

Имя AUR-пакета: `ai-dev-system-git`; он следует ветке `main`. Для публикации нужны отдельный
AUR-аккаунт и SSH-репозиторий сопровождающего.

На macOS после публикации Homebrew tap выполните:

```bash
brew tap stonebridgeway/tap
brew install ai-dev-system
ai-dev-system --install-prerequisites
```

Формула устанавливает стабильный релиз `v1.0.0`. Инструкции для сопровождающего по публикации
tap и обновлению релизов находятся в [packaging/README.md](packaging/README.md).

## Проверка и диагностика

Перед выпуском из `ai-dev-mcp-server` выполните:

```powershell
npm run check
npm run docker:prepare
npm run docker:audit
npm run docker:smoke -- --image ai-dev-system:local
```

Для полной проверки всего набора:

```powershell
..\\scripts\\run-acceptance.ps1
```

Если Docker Desktop не может скачать базовый образ при активном VPN или корпоративном DNS,
настройте proxy/DNS в Docker Desktop. Не передавайте proxy-пароли в Dockerfile, Git, build args
или файлы проекта. Уже собранный локальный образ запускается без доступа к интернету.

Подробности по Compose, macOS/Linux, BGE-M3 и GHCR: [docker/README.md](docker/README.md).
Архитектура и полный список инструментов: [ai-dev-mcp-server/README.md](ai-dev-mcp-server/README.md).

## План развития

План развития и заметки по апгрейдам на основе ECC (обоснование, подключение, примеры вызова инструментов) лежат в
[docs/ecc-upgrades/](docs/ecc-upgrades/README.md); начинать с [PLAN.md](docs/ecc-upgrades/PLAN.md).

## Лицензии

Смотрите [LICENSE](LICENSE) и [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
