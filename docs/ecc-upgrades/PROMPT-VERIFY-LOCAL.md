# Задача: обновить ai-dev-system и проверить его так, чтобы нашлось плохое

Ты работаешь на моей машине (Windows). Проект: https://github.com/stonebridgeway/ai-dev-system

## Правила отчёта (важнее самой проверки)

1. **Показывай сырой вывод команд**, а не пересказ. «Прошло успешно» без вывода — не ответ.
2. Если что-то упало — **не чини молча и не обходи**. Запиши команду, вывод, и только потом предлагай.
3. Если не смог проверить — так и напиши: «не проверено, потому что…». Выдумывать результат нельзя.
4. В конце обязательна строка вида **«N падений из 10»**. Один зелёный прогон — не доказательство.

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

Ожидаю: последний коммит — `Stop the seed refresh from deleting the skills it ships`
(или новее). Напиши, какой хеш получился.

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

Ожидаю: `# fail 0`, около 951 теста, покрытие не ниже 85/60/85. Покажи строки `# tests`,
`# pass`, `# fail`, `# skipped` и строку покрытия.

```
npm run acceptance
```

Это гоняет `npm run check` десять раз и сам печатает строку «N падений из 10». Скопируй её.
Если падения есть — для каждого напиши, какого оно рода: `tests failed` (упал тест — это
про код) или `coverage reporter` (не про код). Команда их различает сама.

**Во время этих прогонов ничего не редактируй в проекте** — правка файлов на ходу даёт ложное
падение.

## Шаг 4. Сборка раздачи — то, что уезжает к пользователям

```
npm run docker:seed:verify
npm run docker:audit
npm run packaging:check
npm run docs:tools:check
```

Все четыре должны дать `"status": "current"` или `"passed"`. Покажи вывод.

Теперь отдельно проверь, что пересборка сида **не теряет** скиллы (это чинилось только что):

```
node scripts/refresh-public-seed.mjs --source ../docker/public-seed --output ../docker/probe-seed --replace
(Get-ChildItem -Recurse -Filter SKILL.md ..\docker\probe-seed).Count
Get-ChildItem ..\docker\probe-seed\03-skills-catalog\sources\external -Name
```

Ожидаю: **3227** скиллов и шесть источников (archify, ecc, mattpocock-skills, membrane,
ui-ux-pro-max, understand-anything). Отпечаток в выводе должен быть
`047dc6a50aa9033efbdef79336ad6ca1730eb7af35a18fcd49ac344a6ac2027d`.

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

Задай задачу **по-английски** и убедись, что импортированные скиллы вообще достижимы:

```
node -e "import('./src/mcp-stdio.mjs').then(m=>m.callTool('recommend_skills',{task:'set up a Slack notification integration for our deploy pipeline'})).then(r=>console.log(r.content[0].text))"
```

Ожидаю: среди предложенного появляется интеграционный скилл Slack.

Теперь обратная проверка — задача, которая приложение **не называет**:

```
node -e "import('./src/mcp-stdio.mjs').then(m=>m.callTool('recommend_skills',{task:'исправь падающий тест в модуле авторизации'})).then(r=>console.log(r.content[0].text))"
```

Ожидаю: интеграционных скиллов в ответе **нет**. Если они лезут в каждую задачу — это поломка,
скажи мне.

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

## Итог

Напиши коротко:

1. Хеш коммита, на котором проверял.
2. Какой корень знаний выбрал сервер у меня и сколько скиллов увидел.
3. Сколько скиллов увидел чистый клон.
4. Строку «N падений из 10».
5. Список всего, что упало или повело себя не так, как написано выше — с сырым выводом.
6. Отдельно: что проверить не удалось и почему.

Если всё зелёное — так и напиши, но с выводом команд. Если нашёл плохое — это полезнее
зелёного отчёта, не сглаживай.
