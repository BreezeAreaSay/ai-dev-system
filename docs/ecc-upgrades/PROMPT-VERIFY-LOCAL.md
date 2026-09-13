# Задача: обновить ai-dev-system и проверить его так, чтобы нашлось плохое

Ты работаешь на моей машине (Windows). Проект: https://github.com/stonebridgeway/ai-dev-system

## Правила отчёта (важнее самой проверки)

1. **Показывай сырой вывод команд**, а не пересказ. «Прошло успешно» без вывода — не ответ.
2. Если что-то упало — **не чини молча и не обходи**. Запиши команду, вывод, и только потом предлагай.
3. Если не смог проверить — так и напиши: «не проверено, потому что…». Выдумывать результат нельзя.
4. В конце обязательна строка вида **«N падений из 10»**. Один зелёный прогон — не доказательство.
5. **Ничего не чини.** Этот прогон собирает данные. Правки делаю я — иначе мы разойдёмся деревьями.
6. Длинные выводы сохраняй в файлы и присылай их целиком, а не хвост:
   `npm run check *> check.txt`, `node --test ... *> identity.txt` (PowerShell: `*>` ловит и stderr).

## Шаг 0а. Найти нужный репозиторий — не пропускай этот шаг

Проект может лежать **внутри** Obsidian-vault, и vault сам по себе тоже бывает git-репозиторием.
Это разные репозитории с несвязанными историями, и обновлять надо проект, а не vault.

Как отличить по корню:

| корень проекта `ai-dev-system` | корень vault |
| --- | --- |
| `ai-dev-mcp-server/`, `docker/`, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md` | `03-skills-catalog/`, `01-system/`, `09-mcp/`, `02-knowledge/` |

Найди настоящий корень проекта:

```
Get-ChildItem -Recurse -Depth 4 -Directory -Filter ai-dev-mcp-server | Select-Object -ExpandProperty FullName
```

Родитель найденного каталога и есть корень проекта. Перейди туда и убедись:

```
Get-ChildItem -Name | Select-Object -First 12
git rev-parse --show-toplevel
git remote -v
```

**Признаки, что ты не там:**

- `git pull` отвечает `refusing to merge unrelated histories`;
- в корне лежит `03-skills-catalog` или `09-mcp`;
- `docs/ecc-upgrades/PROMPT-VERIFY-LOCAL.md` не существует.

Если видишь хоть один — **остановись и напиши мне**. Никогда не выполняй
`--allow-unrelated-histories`: этим ты вобьёшь публичный проект в мой личный vault или наоборот.

Отдельно проверь и скажи мне, если у **vault**-репозитория `origin` указывает на
`stonebridgeway/ai-dev-system`. Это опасная настройка: один `git push` оттуда опубликует мои
личные заметки. Сам ничего не меняй — просто сообщи.

## Шаг 0б. Обновиться

Только в корне проекта:

```
git remote -v
git status --short --branch
git fetch origin
git log --oneline -1
```

Обнови до последнего `main`. Если рабочее дерево грязное — сначала покажи, что именно изменено,
и спроси меня. Не делай `git reset --hard`, `git checkout -- .` и `git clean` без моего слова.

Учти: сервер при работе создаёт файлы, и они **должны** быть грязными — это не мусор и не
поломка. Ожидаемо изменённые или новые: `.ai-dev/plans/*`, `.ai-dev/project-map.md`,
`.ai-dev/quality-gate.md`, `03-skills-catalog/registries/*`. Их не трогай.

Ожидаю: последний коммит — `Merge pull request #42` или новее. Напиши, какой хеш получился.

## Шаг 0в. Проверь, что правки доехали — без этого дальше идти нельзя

Прошлый прогон целиком ушёл впустую: `git pull` ответил `Already up to date`, всё выглядело
правильно, а на деле проверялся код **до** исправлений. Хеш этого не показывает. Покажут три
грепа. Выполни из `ai-dev-mcp-server`:

```
Select-String -Path src/core/task-vocabulary.mjs -Pattern 'export function taskNamesSkill' | Measure-Object | % Count
Select-String -Path scripts/acceptance.mjs -Pattern 'resolveSpawnInvocation' | Measure-Object | % Count
Select-String -Path src/core/public-distribution.mjs -Pattern 'export function buildContextStaleness' | Measure-Object | % Count
Select-String -Path ..\docker\compose.local.example.yaml -Pattern 'models/bge-m3' | Measure-Object | % Count
```

Ожидаю **1, 4, 1 и 2** (второй встречается четыре раза, четвёртый — два: это нормально).
Четвёртый грепает файл уровнем выше, в корне репозитория.

**Если хоть один ноль — остановись и напиши мне.** Значит обновление не дошло, и все дальнейшие
результаты будут про старый код. Проверь тогда, куда смотрит `git remote -v` и на какой ветке ты
стоишь, и пришли вывод.

## Шаг 1. Первый запуск

```
cd ai-dev-mcp-server
node --version
npm run setup
```

Node должен быть >= 22.12.0. Покажи **весь** вывод setup: он печатает, что построил, а что
пропустил как уже готовое. Если какой-то шаг упал — покажи ошибку целиком.

```
npm run doctor
```

Покажи вывод полностью, включая всё, что помечено как проблема.

## Шаг 2. Какой каталог знаний видит сервер — это ключевой вопрос

Сервер выбирает корень так: переменная `AI_DEV_VAULT_ROOT`, иначе каталог на три уровня выше
(если там есть `03-skills-catalog` или `01-system`), иначе встроенный `docker/public-seed`.

```
node -e "import('./src/mcp-stdio.mjs').then(m=>m.callTool('search_index_status',{include_external_project_files:true})).then(r=>console.log(r.content[0].text))"
```

Затем посчитай скиллы в обоих местах и напиши **оба** числа.

Во встроенном сиде (PowerShell):

```
(Get-ChildItem -Recurse -Filter SKILL.md ..\docker\public-seed\03-skills-catalog).Count
```

И в том каталоге, который сервер реально выбрал (подставь путь из `doctor`):

```
(Get-ChildItem -Recurse -Filter SKILL.md '<выбранный корень>\03-skills-catalog').Count
```

**Что я хочу понять:** видит ли сервер 3227 скиллов, или он читает мой личный vault и видит
~142. Оба варианта — рабочие, но мне нужно знать, какой у меня. Если он читает мой vault,
напиши, каких скиллов там нет: membrane, understand-anything, mattpocock-skills, grill-me.

## Шаг 3. Гейт качества и критерий приёмки

```
npm run check
```

Ожидаю: `# fail 0`, около 967 тестов, покрытие не ниже 85/60/85. Покажи строки `# tests`,
`# pass`, `# fail`, `# skipped` и строку покрытия.

```
npm run acceptance
```

Это гоняет `npm run check` десять раз и сам печатает строку «N падений из 10». Скопируй её.

**В прошлый прогон эта команда умирала на run 1/10 с `spawn npm ENOENT`** — она запускала `npm`
без оболочки, а на Windows это `npm.cmd`. Починено. Если ENOENT повторится — это откат правки,
скажи сразу и приложи вывод целиком.
Если падения есть — для каждого напиши, какого оно рода: `tests failed` (упал тест — это
про код) или `coverage reporter` (не про код). Команда их различает сама.

**Во время этих прогонов ничего не редактируй в проекте** — правка файлов на ходу даёт ложное
падение.

## Шаг 4. Сборка раздачи — то, что уезжает к пользователям

```
npm run docker:prepare
npm run docker:seed:verify
npm run docker:audit
npm run packaging:check
npm run docs:tools:check
```

**`docker:prepare` идёт первым и это не лишнее.** `docker:audit` читает `.docker/build-context` —
локальный артефакт прошлой сборки. В прошлый прогон он у тебя пожаловался на импорт
`scripts/models.mjs`: такого модуля в репозитории нет и никто его не импортирует — аудит судил о
дереве, которого больше нет. Теперь он это ловит сам и говорит `context is stale`; если скажет —
значит `docker:prepare` не отработал, покажи его вывод.

Остальные три должны дать `"status": "current"` или `"passed"`. Покажи вывод всех.

**Если `docker:seed:verify` снова скажет «N problems» — сохрани его вывод целиком в файл и
пришли.** В прошлый раз было 74 проблемы, а список файлов не дошёл; без него причину не найти:

```
npm run docker:seed:verify *> seed-verify.txt
```

Теперь отдельно проверь, что пересборка сида **не теряет** скиллы (это чинилось только что):

```
node scripts/refresh-public-seed.mjs --source ../docker/public-seed --output ../docker/probe-seed --replace
(Get-ChildItem -Recurse -Filter SKILL.md ..\docker\probe-seed).Count
Get-ChildItem ..\docker\probe-seed\03-skills-catalog\sources\external -Name
```

Ожидаю: **3227** скиллов и шесть источников (archify, ecc, mattpocock-skills, membrane,
ui-ux-pro-max, understand-anything). Отпечаток в выводе должен быть
`d032c147a26f6bd99859eda9f28c44ff88a4a94fb8f3ab34251b1cb72e200ce3`.

Если скиллов 143 — обновление не доехало, скажи мне сразу.

Потом убери пробу: `Remove-Item -Recurse -Force ..\docker\probe-seed`

**Не запускай `npm run docker:seed` без `--output`** — он заменяет настоящий сид.

## Шаг 5. Протоколы должны попадать в файл, который читает КАЖДЫЙ ассистент

Возьми любой тестовый репозиторий (можно пустой новый каталог с `git init`) и попроси сервер
установить правила:

```
node -e "import('./src/mcp-stdio.mjs').then(m=>m.callTool('install_project_rules',{project_path:'<путь к тестовому репо>'})).then(r=>console.log(r.content[0].text))"
```

Проверь, какие файлы появились. Ожидаю, что среди возможных целей есть:
`AGENTS.md`, `.claude/rules`, `.cursor/rules`, `GEMINI.md`,
`.github/copilot-instructions.md`, `.windsurf/rules`, `.clinerules`.

Важно: без явных целей он пишет **не всё подряд**, а только то, чей инструмент виден в репо
или на машине. Это задумано. Напиши, что он выбрал и почему (в ответе есть причина).

Открой `AGENTS.md` и покажи раздел про протоколы — там должен быть описан гейт намерения
(grill-me) и передача оркестратору.

## Шаг 6. Маршрутизация скиллов — проверь враждебно

Эти четыре задачи проверяют две правки: раньше имя скилла искалось **вхождением подстроки**
(слово «deploy» содержало `eploy` — британскую ATS — и та лезла в выдачу), и составное имя
считалось названным по одной своей части («message» называл `message-bird`).

Создай в `ai-dev-mcp-server` файл `routing-probe.mjs`:

```js
import { callTool } from "./src/mcp-stdio.mjs";
const tasks = [
  "set up a Slack notification integration for our deploy pipeline",
  "send a message to a Slack channel from our app",
  "send a notification through gmail when the build fails",
  "исправь падающий тест в модуле авторизации"
];
for (const task of tasks) {
  const r = await callTool("recommend_skills", { task });
  const arr = JSON.parse(r.content.find((c) => c.type === "text").text);
  console.log("\n### " + task);
  for (const s of arr) console.log("   ", String(s.name).padEnd(32), "|", String(s.source).padEnd(18), "| score", s.score);
}
process.exit(0);
```

и запусти `node routing-probe.mjs`. Потом удали файл.

Сверь с ожидаемым — **важны и присутствия, и отсутствия**:

| задача | обязан быть | обязан ОТСУТСТВОВАТЬ |
| --- | --- | --- |
| Slack + deploy pipeline | `slack` | `eploy`, `octopus-deploy` |
| message в Slack | `slack` | `message-bird` |
| gmail | `gmail` | — |
| русская про тест | — | любой `external/membrane` |

Если в выдаче появился `eploy`, `octopus-deploy` или `message-bird` — правка не доехала или
откатилась, скажи сразу и приложи весь вывод.

Проверь, что гейт намерения на месте:

```
node -e "import('./src/mcp-stdio.mjs').then(m=>m.callTool('search_skills',{query:'grill-me'})).then(r=>console.log(r.content[0].text))"
```

## Шаг 7. Что может только человек (это единственный открытый долг, Д-2)

```
npm run verify:cursor
```

Команда напечатает по шагам, что нужно нажать в живом Cursor и что должно получиться.
**Сделай это руками в настоящем Cursor**, дважды, и напиши, совпало ли поведение с описанным.
Это нельзя проверить кодом — поэтому долг и висит открытым.

## Шаг 7б. Демон — новое, проверь отдельно

Сервер теперь умеет жить одним тёплым процессом на локальном сокете вместо отдельного
stdio-процесса на каждого клиента. На Windows это именованный канал. `npm start` не изменился,
демон — отдельный путь.

Запусти его в **отдельном окне** и не закрывай:

```
npm run daemon
```

В другом окне проверь, что он поднялся и опубликовал себя:

```
Get-Content $env:USERPROFILE\.ai-dev\run\daemon.json
```

Ожидаю JSON с `pid`, `version`, `address` и `started_at`. `address` на Windows должен быть
именованным каналом вида `\\.\pipe\ai-dev-<твоё имя пользователя>`.

Теперь поговори с ним настоящим MCP. Создай файл `daemon-probe.mjs` **внутри каталога
`ai-dev-mcp-server`** — он импортирует модуль по относительному пути, из другого места не
заработает:

```js
import net from "node:net";
import { socketAddress } from "./src/core/runtime-paths.mjs";

const socket = net.connect(socketAddress());
await new Promise((r) => socket.once("connect", r));
const call = (payload) => new Promise((resolve) => {
  let buf = "";
  const onData = (c) => {
    buf += c.toString();
    const nl = buf.indexOf("\n");
    if (nl >= 0) { socket.off("data", onData); resolve(JSON.parse(buf.slice(0, nl))); }
  };
  socket.on("data", onData);
  socket.write(JSON.stringify(payload) + "\n");
});
const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } } });
console.log("сервер:", init.result?.serverInfo, "инструкций символов:", (init.result?.instructions || "").length);
socket.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const tools = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
console.log("инструментов:", tools.result?.tools?.length);
socket.end();
process.exit(0);
```

и запусти: `node daemon-probe.mjs`

Ожидаю: сервер `ai-dev-system`, около 1000 символов инструкций, **133** инструмента.
Если инструментов меньше или инструкции пустые — скажи мне.

Проверь, что второй демон не крадёт сокет: в третьем окне запусти `npm run daemon` ещё раз.
Он обязан сразу завершиться, не заняв канал. Первый при этом должен продолжать отвечать —
прогони пробу снова.

Потом первый демон останови (Ctrl+C) и убедись, что он за собой прибрал:

```
Test-Path $env:USERPROFILE\.ai-dev\run\daemon.json
Test-Path $env:USERPROFILE\.ai-dev\run\daemon.lock
```

Оба должны дать `False`. Удали `daemon-probe.mjs`.

**Если демон не запускается или проба не отвечает — это важнее всего остального в отчёте.**
На Windows он проверялся только счётом, живого запуска на этой платформе ещё не было.

## Шаг 7в. Два незакрытых дефекта — собери сырые данные

Эти два теста падают у тебя и **не воспроизводятся** на Linux, поэтому починить их вслепую
нельзя. Нужен полный текст ошибки, а не имена тестов.

```
node --test src/core/project-identity.test.mjs *> identity.txt
```

Пришли `identity.txt` **целиком**. Мне нужны блоки `AssertionError` с полями `actual` и
`expected` — именно они скажут, в чём дело. Падать должны два:

- `the hook and the server agree on a project reached through another spelling of its path`
- `projects outside Git fall back to the project id as their memory key`

Дополнительно ответь на три вопроса — они отсекают мои гипотезы:

1. Создаётся ли на этой машине junction без прав администратора? Проверь так:

```
$t = Join-Path $env:TEMP ("jtest-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path "$t\real" -Force | Out-Null
New-Item -ItemType Junction -Path "$t\alias" -Target "$t\real" -ErrorAction Continue
Test-Path "$t\alias"
Remove-Item -Recurse -Force $t
```

Напиши, что вернул `Test-Path`: `True` или `False`.

2. Что показывает `git` во временном каталоге (не должно найти репозиторий):

```
$t = Join-Path $env:TEMP ("gtest-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $t -Force | Out-Null
Push-Location $t; git rev-parse --show-toplevel; git rev-parse --git-dir; Pop-Location
Remove-Item -Recurse -Force $t
```

Приведи вывод целиком, включая текст ошибки, если git ругается.

3. Куда указывает `$env:TEMP` и совпадает ли он с тем, что видит Node:

```
echo $env:TEMP
node -e "const os=require('os'),fs=require('fs');console.log(os.tmpdir());console.log(fs.realpathSync.native(os.tmpdir()))"
```

Меня интересует, отличается ли короткое имя (8.3) от полного.

Удали `identity.txt` только после того, как пришлёшь.

## Шаг 8. Сценарий чистого пользователя

Это самое важное: у человека, который просто склонировал репозиторий, всё должно
развернуться без моего vault.

```
cd <во временный каталог, НЕ внутри Obsidian-vault>
git clone https://github.com/stonebridgeway/ai-dev-system
cd ai-dev-system\ai-dev-mcp-server
npm install
npm run setup
npm run check
```

Здесь сервер обязан взять встроенный `docker/public-seed` и увидеть **3227** скиллов.
Покажи вывод `search_index_status` из этого клона. Если у чистого клона скиллов меньше —
это провал, скажи немедленно.

## Шаг 9. Модель в контейнере — этого я проверить не могу

У меня в среде нет демона Docker, поэтому образ не собирался ни разу. Всё, что я утверждаю про
модель в контейнере, проверено чтением кода и слиянием compose-файлов, но не живым запуском.
Если у тебя есть Docker Desktop — это самая ценная часть прогона. Если нет, так и напиши, это
не провал.

Сборка образа с питоновской частью (долго, несколько гигабайт зависимостей):

```
cd ai-dev-mcp-server
npm run docker:prepare
cd ..
docker build --build-arg INSTALL_BGE_M3=1 --tag ai-dev-system:bge .docker\build-context
```

Веса должны быть уже скачаны (`npm run setup -- --dense` кладёт их в `~\.ai-dev\models\bge-m3`).
Если их нет — пропусти шаг и скажи об этом, качать 2.3 ГБ ради проверки не нужно.

Запуск с моделью:

```
$env:AI_DEV_IMAGE = "ai-dev-system:bge"
$env:AI_DEV_MODEL_PATH = "$env:USERPROFILE\.ai-dev\models\bge-m3"
$env:AI_DEV_PROJECT_PATH = "<путь к любому проекту>"
powershell -File docker\run-mcp.ps1
```

**Что мне нужно из этого прогона** — вызови в контейнере `embedding_status` и пришли из ответа:

- `paths.embeddings_python` — жду `/opt/ai-dev/embeddings/.venv/bin/python`;
- `paths.model_dir` — жду `/models/bge-m3`;
- все семь записей `availability` со значениями `exists`.

И то же самое через Compose — раскомментируй монтирование модели в своём `compose.local.yaml`
(в `compose.local.example.yaml` оно уже есть) и покажи вывод:

```
docker compose -f docker\compose.yaml -f docker\compose.local.yaml config
```

Меня интересует список `volumes` целиком: должно быть три — `/data`, `/workspace` и
`/models/bge-m3` с `read_only: true`.

**Отдельно проверь враждебно:** запусти контейнер **без** монтирования модели и покажи, что
говорит `embedding_backend` в `system_health_check`. Я утверждаю, что он скажет `skipped` с
названием команды, а не `fail`. Если скажет что-то третье — это дефект, и он мой.

## Итог

Напиши коротко:

1. Хеш коммита, на котором проверял.
2. Какой корень знаний выбрал сервер у меня и сколько скиллов увидел.
3. Сколько скиллов увидел чистый клон.
4. Строку «N падений из 10» — и дошёл ли `acceptance` до десяти прогонов вообще.
5. Поднялся ли демон на Windows, сколько инструментов отдал по каналу, прибрался ли за собой.
6. Таблицу маршрутизации из шага 6: что появилось и, главное, что **не** появилось.
7. Список всего, что упало или повело себя не так, как написано выше — с сырым выводом.
8. Из шага 9 — два пути из `embedding_status`, семь значений `exists`, список `volumes` из
   `docker compose config` и ответ `embedding_backend` без модели. Или строку «Docker нет».
9. Отдельно: что проверить не удалось и почему.

**Текст ошибок вставляй прямо в ответ, а не ссылкой на файл.** Пути вида
`C:\Users\...\Temp\...` до меня не доходят — я вижу только то, что написано в сообщении.
В прошлый раз из-за этого два дефекта остались неразобранными.

Нужно вставленным в текст:

- из `identity.txt` — **все блоки `AssertionError` целиком**, с полями `actual` и `expected`;
- из `seed-verify.txt` — список проблем (хотя бы первые 20 строк), если проверка пожаловалась;
- из `check.txt` — блок каждого упавшего теста, а не только его имя.

**И ответы на три вопроса из шага 7в** — в прошлом отчёте их не было, а без них я не отличу
одну причину от другой: создаётся ли junction, что говорит git во временном каталоге, отличается
ли короткое имя TEMP от полного.

Если всё зелёное — так и напиши, но с выводом команд. Если нашёл плохое — это полезнее
зелёного отчёта, не сглаживай. Ничего не чини: этот прогон собирает данные.
