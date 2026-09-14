# Установка

[← README](../../README.ru.md) · [Рабочий процесс](WORKFLOW.md) · [Возможности](CAPABILITIES.md) · [Ограничители](GUARDRAILS.md)

Все поддерживаемые способы: локальный запуск из клона, упакованный путь через
Docker, подключение каждого клиента и локальная dense-модель. Если нужно просто
начать, хватит команд из [README](../../README.ru.md#установка).

## Содержание

- [Требования](#требования)
- [Быстрый старт: локально](#быстрый-старт-локально)
- [Один запуск на Windows](#один-запуск-на-windows)
- [Один запуск на macOS и Linux](#один-запуск-на-macos-и-linux)
- [Запуск в контейнере](#запуск-в-контейнере)
- [Подключение к ИИ-агентам](#подключение-к-ии-агентам)
- [Docker Compose](#docker-compose)
- [Локальная модель в контейнере](#локальная-модель-в-контейнере)
- [Публикация для команды](#публикация-для-команды)
- [Arch/AUR и Homebrew](#archaur-и-homebrew)
- [Проверка и диагностика](#проверка-и-диагностика)

Чтобы запустить агента с суженным набором инструментов, добавьте
`AI_DEV_PROFILES` в блок `env` любой конфигурации ниже — см.
[Возможности](CAPABILITIES.md).

## Требования

Для локального запуска — того, который эта страница рекомендует, — нужны Node.js 22.12+ и npm,
и больше ничего. На Windows можно использовать bundled runtime Codex, описанный в
[README сервера](../../ai-dev-mcp-server/README.md).

Для запуска в контейнере вместо этого нужен Docker:

- Docker Desktop (Windows/macOS) или Docker Engine (Linux); bootstrap может установить его;
- Docker должен иметь доступ к выбранной папке с проектами.

## Быстрый старт: локально

Из корня клона:

```bash
cd ai-dev-mcp-server
npm ci --ignore-scripts --no-audit --no-fund
npm run setup
```

`npm run setup` собирает три вещи, которых нет в клоне — реестр скиллов, поисковый индекс и
бенчмарк маршрутизации — и печатает проверку здоровья. Контейнер собирает те же три при первом
старте и тем же кодом, так что два пути не могут разойтись в том, что получилось. `--frontend-qa` добавит зависимости QA,
`--dense` — локальную модель BGE-M3 и построенные по ней векторы (~2,3 ГБ); ни то ни другое не
запускается без просьбы. Obsidian-vault не нужен: без него сервер читает встроенный сид.

Дальше укажите MCP-клиенту на `ai-dev-mcp-server/src/server.mjs` — см.
[Подключение к ИИ-агентам](#подключение-к-ии-агентам). Это вся установка.

Запустить можно двумя способами, протокол один и тот же:

| | |
| --- | --- |
| `npm start` | Отдельный stdio-процесс на каждого клиента. Путь по умолчанию, его и поднимают конфигурации клиентов ниже. |
| `npm run daemon` | Один тёплый процесс на локальном сокете (на Windows — именованный канал) на всех клиентов: индекс и модель загружаются один раз, а не на каждое подключение. |

**Почему локально первым.** Из-за модели. Локально это один флаг —
`npm run setup -- --dense`, — и веса ложатся в `~/.ai-dev`. В опубликованном образе она
выключена (`INSTALL_BGE_M3=0`), и чтобы получить её там, нужно собрать свой вариант образа и
примонтировать `/models`. Как именно — описано ниже, это рабочий путь, просто не самый короткий.
Образ говорит о себе это сам, через `AI_DEV_DENSE_INSTALLED`, и проверка здоровья его читает:
внутри контейнера `embedding_backend` пишет, что dense не настроен, и указывает на монтирование,
а не на `npm run setup`, который в контейнере выполнить нельзя.

## Один запуск на Windows

Это путь через контейнер: скрипт ставит Docker и скачивает образ. Локальный путь — см.
[Быстрый старт: локально](#быстрый-старт-локально).

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

Тоже путь через контейнер. Локальный — см. [Быстрый старт: локально](#быстрый-старт-локально).

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

Если реестр недоступен, а в локальном кэше Docker уже лежит старая копия образа,
bootstrap останавливается, а не ставит её. Он печатает дату создания этой копии и её
digest — по ним видно, насколько она отстала. Поставить её всё равно — осознанный выбор:

```bash
sh ./bootstrap.sh --allow-stale-image
```

В Windows тот же переключатель называется `-AllowStaleImage`. Лучше восстановить связь
с реестром: в кэшированном образе может не быть уже выпущенных исправлений.

## Запуск в контейнере

Выбирайте его, когда система нужна на машине, где не должно быть личного vault, или когда
команде нужен один образ, который у всех работает одинаково. В образе нет ни vault, ни паролей,
ни токенов, ни проектов, ни истории задач. Это не самый быстрый путь к рабочей установке на
своей машине — им остаётся локальный, выше.


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

### 4. Чем контейнер исполняет ваши проверки

В контейнере `run_quality_gate` и `verify_task` запускают команды из `.ai-dev/quality-gate.md`
**Node образа** — сейчас 24, — а не тем Node, что стоит у вас. Команда, которая ведёт себя
по-разному на разных мажорах Node, разойдётся с вашим терминалом, и разошлась она не из-за
гейта. Обычный случай — `node --test test/`: с Node 21 позиционные аргументы стали
glob-паттернами, каталог исполняется как файл теста, и скрипт падает сам по себе, тогда как
на Node 20 он проходил.

`run_quality_gate` сообщает, каким Node исполнялись команды, полями `runtime.node` и
`runtime.exec_path`, а провалившаяся команда несёт `hint`, если причина опознана. Команды за
вас гейт не переписывает.

Контейнер запускается ещё и с `--network none`, а из шести сканеров безопасности совсем без
сети работает только `gitleaks` — он в образе есть. То есть скан там — это один сканер, а не
шесть; полная матрица в `docker/README.md`. Скан, в котором не отработал ни один сканер,
возвращает `unchecked`, а не `pass`.

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
[docker/mcp-config.example.json](../../docker/mcp-config.example.json). После изменения конфигурации
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

## Docker Compose

Скопируйте `docker/compose.local.example.yaml` в `docker/compose.local.yaml`, укажите локальный
`AI_DEV_PROJECT_PATH` и запустите:

```bash
docker compose -f docker/compose.yaml -f docker/compose.local.yaml run --rm -T ai-dev-mcp
```

`compose.local.yaml` и `docker/.env` игнорируются Git, поскольку могут содержать локальные пути.

## Локальная модель в контейнере

У гибридного поиска две половины: поиск по словам, который работает везде и без настройки, и
плотный поиск на локальной модели BGE-M3 — та самая, из-за которой поиск понимает вопрос, а не
совпадает с его словами. В контейнере работают обе. Для этого нужны две вещи, которых в образе
нет, и по двум разным причинам.

**Питоновская часть выключена по умолчанию** — встроить её в каждый образ значило бы заставить
всех платить установкой, нужна она им или нет. Включается аргументом сборки:

```bash
npm --prefix ai-dev-mcp-server run docker:prepare
docker build --build-arg INSTALL_BGE_M3=1 --tag ai-dev-system:bge .docker/build-context
```

**Весов в публикуемом образе нет.** Это ~2,3 ГБ, и они ваши, а не дистрибутива: образ с ними стал бы
скачиванием на 2,3 ГБ для каждого и вопросом о лицензии для того, кто его публикует. Скачайте их
один раз на хосте:

```bash
cd ai-dev-mcp-server
npm run setup -- --dense
```

Они лягут в `~/.ai-dev/models/bge-m3` (путь меняется переменной `BGE_M3_MODEL_DIR`). Эта же
папка монтируется в контейнер только для чтения — контейнер веса читает и никогда не пишет.

### Запуск, обоими способами

Через скрипты-лаунчеры:

```bash
export AI_DEV_IMAGE=ai-dev-system:bge
export AI_DEV_MODEL_PATH="$HOME/.ai-dev/models/bge-m3"
export AI_DEV_PROJECT_PATH="/абсолютный/путь/к/проекту"
sh docker/run-mcp.sh
```

Через Compose — раскомментируйте монтирование модели в своём `compose.local.yaml` (в файле-примере
оно есть, с той же переменной) и запустите:

```bash
export AI_DEV_IMAGE=ai-dev-system:bge
export AI_DEV_MODEL_PATH="$HOME/.ai-dev/models/bge-m3"
docker compose -f docker/compose.yaml -f docker/compose.local.yaml run --rm -T ai-dev-mcp
```

Оба подключают папку как `/models/bge-m3` — именно туда смотрит `BGE_M3_MODEL_DIR` внутри образа.
`network_mode: none` этому не мешает: помощники выставляют `TRANSFORMERS_OFFLINE=1` и
`HF_HUB_OFFLINE=1` до загрузки, модель читается с тома и в сеть никто не идёт. По этой же причине
веса приходят монтированием, а не скачиванием внутри контейнера.

### Если нужен образ с весами внутри

Монтирование держит публикуемый образ маленьким — и для значения по умолчанию это правильно.
Правильно не везде: машине без сети или образу, который раздают команде, чтобы каждый не качал
2,3 ГБ, модель нужна внутри. Это ваша сборка, не дистрибутива, и это четыре строки:

```dockerfile
# Dockerfile.bge — собирается из папки, где лежат веса
FROM ai-dev-system:bge
COPY --chown=node:node bge-m3/ /models/bge-m3/
```

```bash
docker build -f Dockerfile.bge -t ai-dev-system:bge-bundled "$HOME/.ai-dev/models"
```

Такому образу не нужны ни том, ни переменная: `/models/bge-m3` уже на месте, а именно туда
смотрит `BGE_M3_MODEL_DIR`. Всё остальное — `network_mode: none`, read-only корень,
непривилегированный пользователь — остаётся как было.

### Как убедиться, что заработало

Спросите у запущенного сервера диагностику. Смотреть нужно проверку `embedding_backend`: без
модели она отвечает `skipped` и называет команду, с моделью — `ok`.

```bash
npm --prefix ai-dev-mcp-server run -s doctor
```

Что стоит за этой строкой, показывает инструмент `embedding_status`: он перечисляет всё, что нужно
плотному поиску, и есть ли оно. Четыре записи в `availability` должны быть `exists: true` —
`embeddings_python`, `model_dir`, `model_file`, `modules_file`, — а в контейнере `paths.model_dir`
должен читаться как `/models/bge-m3`, `paths.embeddings_python` — как
`/opt/ai-dev/embeddings/.venv/bin/python`. Любое `false` называет недостающую половину: нет
интерпретатора — образ собран без `INSTALL_BGE_M3=1`; нет файлов модели — не подключили том.

Дальше `search_index_status` показывает `dense_documents` против `dense_pending_documents`: у
свежего индекса векторов нет ни у одного документа, пока `npm run setup -- --dense` их не
построит.

Запускаете из исходников? Тогда всё это не нужно: `npm run setup -- --dense` — и всё. См.
[README сервера](../../ai-dev-mcp-server/README.md#semantic-search-bge-m3).

## Публикация для команды

Workflow [docker-publish.yml](../../.github/workflows/docker-publish.yml) проверяет privacy policy,
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
tap и обновлению релизов находятся в [packaging/README.md](../../packaging/README.md).

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

Подробности по Compose, macOS/Linux, BGE-M3 и GHCR: [docker/README.md](../../docker/README.md).
Архитектура и полный список инструментов: [ai-dev-mcp-server/README.md](../../ai-dev-mcp-server/README.md).
