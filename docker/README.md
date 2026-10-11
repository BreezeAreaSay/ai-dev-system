# Локальный AI Dev MCP в Docker

Этот образ запускает AI Dev MCP через локальный `stdio`. Он не открывает TCP-порт и не требует
удаленного сервера. Любая модель может использовать его через MCP-совместимый локальный хост:
Codex, Cursor, Claude Desktop/Code, Gemini CLI/Code Assist, VS Code или другой клиент с поддержкой
MCP tools.

Сама модель не подключается к MCP напрямую. Инструменты ей передает MCP-хост, в котором выбрана
модель.

## Граница приватности

В образ входят только явно разрешенные файлы:

- MCP-сервер и зафиксированные npm-зависимости;
- чистые правила, промпты, quality gates и шаблоны;
- публичный набор custom skills;
- MIT-лицензированные `taste-skill` и `ui-ux-pro-max`;
- Python 3 для скрипта набора UI UX Pro Max (`query_ui_ux_knowledge`, `generate_ui_ux_design_system`);
- Playwright и Chromium для frontend QA.

В образ не входят:

- пароли, токены, `.env` и приватные ключи;
- `02-knowledge/Projects` и `02-knowledge/Task Runs`;
- локальные `.ai-dev`, `.codex`, `.obsidian` и Git history;
- индексы SQLite, логи, артефакты, кэши и бэкапы;
- личный Obsidian Vault;
- исходники пользовательских проектов;
- BGE-M3 модель и ее веса.

Сборка получает не корень Vault и не корень репозитория, а отдельный сгенерированный каталог
`.docker/build-context`. Перед сборкой он проверяется на запрещенные пути, секреты, имя локального
пользователя и абсолютный путь исходного Vault.

## Быстрый запуск готового образа

### Windows: автоматическая подготовка после clone

Из корня клона запустите:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1
```

Скрипт проверяет Docker Desktop и Node.js 24, при отсутствии устанавливает их через `winget`,
создаёт безопасную локальную папку проектов, скачивает опубликованный образ, проводит MCP smoke-проверку и
добавляет Docker launcher в локальные конфигурации Codex, Cursor, Gemini, VS Code и Claude.
Права администратора требуются только для первой установки Docker Desktop или Node.js.

### macOS и Linux: автоматическая подготовка без Node.js на хосте

```bash
sh ./bootstrap.sh --install-prerequisites
```

На macOS скрипт устанавливает Homebrew при необходимости, затем Docker Desktop через Homebrew,
запускает приложение и ждёт готовности engine. На Linux ставится только движок Docker из
репозиториев дистрибутива: `docker.io` через `apt`, `moby-engine` через `dnf`, `docker` через
`pacman` — compose скрипту не нужен. После добавления пользователя в группу `docker` потребуется
заново войти в систему и повторить команду; под root это не нужно. Если Docker уже готов,
достаточно `sh ./bootstrap.sh`.
Временный `node:24` контейнер используется только для настройки клиентов.

Опубликованный образ:

```powershell
docker pull ghcr.io/stonebridgeway/ai-dev-system:latest
$env:AI_DEV_IMAGE = "ghcr.io/stonebridgeway/ai-dev-system:latest"
$env:AI_DEV_PROJECT_PATH = "C:\Dev"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\docker\run-mcp.ps1
```

macOS/Linux:

```bash
docker pull ghcr.io/stonebridgeway/ai-dev-system:latest
export AI_DEV_IMAGE="ghcr.io/stonebridgeway/ai-dev-system:latest"
export AI_DEV_PROJECT_PATH="$HOME/Dev"
sh ./docker/run-mcp.sh
```

`AI_DEV_PROJECT_PATH` задается явно. Только этот каталог монтируется в `/workspace`; личный Vault
по умолчанию не монтируется вообще. Для одного проекта укажите его корень. Для нескольких
репозиториев можно указать общий каталог, например `C:\Dev` или `$HOME/Dev`.

Новые локальные знания, task state, поисковый индекс и QA-артефакты сохраняются в Docker volume
`ai-dev-system-data`. Обновление или пересоздание контейнера не перезаписывает существующие файлы в
этом volume.

### Первый старт контейнера

На пустом volume entrypoint собирает то же, что `npm run setup` на клоне: реестр скиллов,
поисковый индекс и бенчмарк маршрутизации. План шагов у обоих путей общий
(`ai-dev-mcp-server/scripts/first-run-steps.mjs`), сеть не нужна, занимает это около десяти
секунд и происходит один раз на volume — второй старт ничего не пересобирает. До этого
исправления контейнер строил только реестр, и первое, что видел пользователь, было
`Health: fail` на исправной установке при неработающем поиске (`docs/DEFECTS.md`, Д-57).

Сразу после первого старта `system_health_check` даёт `degraded` и ноль критичных провалов.
Остаются предупреждения, которые собираются работой, а не установкой: отчёт о качестве скиллов и
пустой реестр проектов. `embedding_backend` в опубликованном образе — `skipped`: весов в нём нет
намеренно, и совет ведёт к монтированию весов, а не к `npm run setup -- --model`, который в
контейнере выполнить нельзя (Д-59).

Frontend QA в образе работает: Playwright и Chromium в нём есть, а раннер находит сервер по
`/opt/ai-dev/ai-dev-mcp-server` — символьной ссылке на `/opt/ai-dev/app`, которую создаёт
Dockerfile. Без неё раннер умирал на первом импорте, а диагностика называла это «Playwright не
установлен» (Д-56). Более честный вариант — положить приложение сразу в
`/opt/ai-dev/ai-dev-mcp-server`; он трогает entrypoint, `run-mcp.sh` и этот документ, и записан в
Д-56 как альтернатива.

## Локальная сборка

Требования:

- Docker Desktop или Docker Engine с Compose v2;
- Node.js 24 для подготовки проверяемого build context.

Из корня `ai-dev-mcp-server`:

```bash
npm ci
npm run docker:prepare
npm run docker:audit
npm run docker:build
npm run docker:smoke -- --image ai-dev-system:local
```

`docker:prepare` копирует только allowlist-файлы в `.docker/build-context`. Обычная сборка никогда
не должна использовать корень Vault как Docker context.

Поддерживающий проект разработчик обновляет committed public seed только после ревью:

```bash
npm run docker:seed
npm run docker:prepare
npm run docker:audit
```

`docker:seed` читает разрешенные исходные документы и skills, пересоздает только
`docker/public-seed` и не изменяет исходный Vault.

## Подключение к MCP-клиентам

### Универсальный JSON

Для Cursor, Claude Desktop/Code и Gemini используйте формат `mcpServers`. Готовый вариант без
project mount находится в `docker/mcp-config.example.json`.

Windows-вариант с явным проектным каталогом:

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

macOS/Linux:

```json
{
  "mcpServers": {
    "ai-dev": {
      "command": "/bin/sh",
      "args": [
        "/absolute/path/docker/run-mcp.sh"
      ],
      "env": {
        "AI_DEV_IMAGE": "ghcr.io/stonebridgeway/ai-dev-system:latest",
        "AI_DEV_PROJECT_PATH": "/home/user/Dev"
      }
    }
  }
}
```

### Codex

Добавьте в `config.toml`:

```toml
[mcp_servers.ai-dev]
command = "powershell.exe"
args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\ABSOLUTE\\PATH\\docker\\run-mcp.ps1"]
env = { AI_DEV_IMAGE = "ghcr.io/stonebridgeway/ai-dev-system:latest", AI_DEV_PROJECT_PATH = "C:\\Dev" }
startup_timeout_sec = 120
tool_timeout_sec = 3600
```

На macOS/Linux замените команду на `/bin/sh`, а `args` на абсолютный путь к `run-mcp.sh`.

### VS Code

Файл `.vscode/mcp.json` или пользовательский MCP config:

```json
{
  "servers": {
    "ai-dev": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "--read-only",
        "--network",
        "none",
        "--security-opt",
        "no-new-privileges:true",
        "--cap-drop",
        "ALL",
        "--mount",
        "type=volume,source=ai-dev-system-data,target=/data",
        "--mount",
        "type=bind,source=C:\\Dev,target=/workspace",
        "ai-dev-system:local"
      ]
    }
  }
}
```

После изменения MCP-конфига полностью перезапустите или reload-ните клиент. Корни репозиториев
внутри контейнера начинаются с `/workspace`, поэтому `begin_task` нужно вызывать с контейнерным
путем, например `/workspace/my-project`.

## Docker Compose

Сначала подготовьте контекст и образ:

```bash
cd ai-dev-mcp-server
npm run docker:prepare
npm run docker:build
```

Затем создайте локальный override из `docker/compose.local.example.yaml`, задайте
`AI_DEV_PROJECT_PATH` и запускайте MCP как одноразовый stdio-процесс:

```bash
docker compose \
  -f docker/compose.yaml \
  -f docker/compose.local.yaml \
  run --rm -T ai-dev-mcp
```

`compose.local.yaml` и `docker/.env` игнорируются Git, потому что могут содержать локальные пути.

## Сеть и права

По умолчанию wrapper и Compose запускают контейнер:

- с `network=none`;
- от пользователя `node`, не от root;
- с read-only root filesystem;
- с удаленными Linux capabilities;
- с `no-new-privileges`;
- с доступом на запись только к `/data`, `/tmp` и явно подключенному `/workspace`.

Если проекту действительно нужен интернет во время проверки, явно задайте
`AI_DEV_DOCKER_NETWORK=bridge`. Это осознанное расширение доступа, а не настройка по умолчанию.

### Node образа исполняет команды проекта

`run_quality_gate` и `verify_task` запускают команды из `.ai-dev/quality-gate.md` тем Node,
который стоит в образе (сейчас 24), а не тем, что стоит у вас. Команда, которая ведёт себя
по-разному на разных мажорах, разойдётся с вашим терминалом, и виноват в этом не гейт.
Классический случай — `node --test test/`: с Node 21 позиционные аргументы стали
glob-паттернами, каталог исполняется как файл теста, и скрипт падает сам по себе. На Node 20
он проходил. Версию видно в ответе: `run_quality_gate` возвращает `runtime.node` и
`runtime.exec_path`, а провалившаяся команда несёт `hint`, если причина опознана.

Гейт не переписывает команды проекта за вас — он говорит, что увидел.

### Что из сканеров безопасности работает в `--network none`

Из шести сканеров `run_security_scan` в изолированном контейнере реально может работать
только gitleaks; semgrep — лишь если правила лежат в самом репозитории.

| Сканер | В образе | В `--network none` |
| --- | --- | --- |
| gitleaks | да | работает: читает рабочее дерево и историю git |
| semgrep | нет | работал бы только с локальными правилами (`.semgrep.yml`), не с `--config auto` |
| `npm audit` | да (вместе с npm) | нет: база advisory сетевая |
| trivy | нет | нет: база уязвимостей сетевая |
| pip-audit | нет | нет: сетевой |
| cargo audit | нет | нет: сетевой |

Поэтому прогон в контейнере — это прогон одного сканера, а не шести. Если не отработал ни
один, вердикт скана — `unchecked`, а не `pass`: «ничего не нашли» и «никто не смотрел» — разные
утверждения, и второе не выдаётся за первое. `verify_task` при этом не блокируется: правило
«отсутствующий сканер никогда не блокирует» осталось. `system_health_check` отдельно считает,
сколько из шести на месте, и предупреждает, если ноль.

## Локальная BGE-M3

Модель — не дополнение, а половина поиска: без неё остаётся совпадение по словам, с ней
появляется совпадение по смыслу. В контейнере она работает: ONNX-рантайм — обычная
npm-зависимость и уже в образе, Python ей не нужен. Не хватает только весов.

**Весов в образе нет никогда.** Они ваши, а не дистрибутива. Скачиваются один
раз на хосте — с докачкой, через `AI_DEV_MODEL_MIRROR` и `HTTPS_PROXY`, если они заданы:

```bash
cd ai-dev-mcp-server
npm run model -- install --no-index
```

Без сети — `npm run model -- import <папка или .zip>` с машины, где модель есть. Каталог по
умолчанию — `~/.ai-dev/models/bge-m3-onnx`, переопределяется через `BGE_M3_ONNX_DIR` или ключ
`--dir`. Монтируется папка над ним — `~/.ai-dev/models`.

**Python-бэкенда больше нет** (3.0, решение D3). Аргумент сборки `INSTALL_BGE_M3=1`, который его
ставил, ничего не делает и при сборке говорит, что пришло на смену. Векторы, построенные им,
относятся к другой модели и с вопросами ONNX не сравниваются; `npm run setup -- --model` строит их
заново.

### Запуск с моделью

Установщиком — путь по умолчанию: fast-start контейнер получает папку read-only в `/models`,
а клиентские конфиги — `AI_DEV_MODEL_PATH` для холодного запуска
(`docs/DEFECTS.md`, Д-69):

```bash
sh ./bootstrap.sh --model-path "$HOME/.ai-dev/models"
```

Переменная называет папку *над* моделями. Каталог, где лежат сами файлы модели
(`pytorch_model.bin`, `config.json`, `onnx/`), — значение до 2.1; лаунчеры его распознают и
останавливаются с подсказкой, а не монтируют на уровень глубже (Д-68).

Лаунчером напрямую:

```bash
export AI_DEV_MODEL_PATH="$HOME/.ai-dev/models"
export AI_DEV_PROJECT_PATH="/absolute/path/to/project"
sh ./docker/run-mcp.sh
```

Через Compose — раскомментируйте монтирование модели в своём `compose.local.yaml`
(в `compose.local.example.yaml` оно уже есть, с той же переменной):

```bash
export AI_DEV_MODEL_PATH="$HOME/.ai-dev/models"
docker compose -f docker/compose.yaml -f docker/compose.local.yaml run --rm -T ai-dev-mcp
```

Оба способа подключают каталог read-only в `/models`; внутри образа `BGE_M3_ONNX_DIR` смотрит в
`/models/bge-m3-onnx`. `network_mode: none` этому не мешает: воркер загружает модель с выключенной
загрузкой из сети и в сеть не ходит.

### Образ с весами внутри

Если модель должна быть в самом образе — машина без сети, раздача команде, — это ваша сборка
поверх нашей, четыре строки:

```dockerfile
# Dockerfile.bge
FROM ghcr.io/stonebridgeway/ai-dev-system:latest
COPY --chown=node:node bge-m3-onnx/ /models/bge-m3-onnx/
```

```bash
docker build -f Dockerfile.bge -t ai-dev-system:bge-bundled "$HOME/.ai-dev/models"
```

Ни тома, ни переменной такому образу не нужно: `/models/bge-m3-onnx` уже на месте. Публикуемый
образ при этом остаётся маленьким — веса не попадают ни в allowlist-контекст, ни в GHCR.

### Как убедиться

В диагностике (`npm --prefix ai-dev-mcp-server run -s doctor`) смотрите проверку
`embedding_backend`: без модели — `skipped` с названием нужной команды, с моделью — `ok`.
Подробности даёт инструмент `embedding_status`: `installed` и `available` — ответ, `reason` —
фраза, а `dense_backend.onnx.missing` перечисляет файлы, которых нет: обычно это значит, что том с
весами не подключён.

## GHCR

Workflow `.github/workflows/docker-publish.yml`:

- тестирует privacy policy;
- заново создает и проверяет allowlisted context;
- собирает validation image;
- выполняет MCP stdio smoke;
- публикует `linux/amd64` и `linux/arm64` в GHCR;
- добавляет SBOM и provenance attestations.

Публикация выполняется только после успешной validation job. Доступ к GHCR идет через штатный
`GITHUB_TOKEN`; токены не передаются в Docker build args.

После первой публикации откройте настройки package в GitHub и выберите подходящую видимость:
`public` для свободного скачивания либо `private/internal` с доступом нужным коллегам и командам.
Локальный Git remote в исходной копии проекта нужно добавить отдельно перед первым push.

Официальные справочники:

- [Docker build context и `.dockerignore`](https://docs.docker.com/build/concepts/context/)
- [Dockerfile best practices](https://docs.docker.com/build/building/best-practices/)
- [Multi-platform GitHub Actions](https://docs.docker.com/build/ci/github-actions/multi-platform/)
- [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
