# Выпуск 3.0

Как 3.0 переходит из форка `BreezeAreaSay/ai-dev-system` в основной репозиторий
`stonebridgeway/ai-dev-system`, а оттуда — к тем, кто им пользуется, и как её откатить. Каждый шаг,
который что-то публикует, делает владелец. Всё до него прогнано там, где это возможно; где и что
вышло — в последнем разделе.

Команды — для POSIX-оболочки, с GitHub CLI (`gh`), вошедшим под учётной записью, которая может
пушить в основной репозиторий и запускать его workflow, с Docker (для `imagetools`) и Node 24 с npm.

Один раз, до первого релиза: в npm должна быть организация `stonebridgeway` — scope `@stonebridgeway`
в npm пока нет (реестр отвечает «Scope not found»), а все руководства уже пишут `npx
@stonebridgeway/ai-dev-system`, — и `npm login` под участником этой организации с правом публиковать
(с `--otp=<код>` у `npm publish`, если включена двухфакторная проверка).

## Что выходит

| Что | Куда | Чем | Что делает владелец |
|---|---|---|---|
| Исходники | `main` репозитория `stonebridgeway/ai-dev-system` и тег `v3.0.0` | слитый pull request и тег | проверяет, сливает, ставит тег |
| Образ | `ghcr.io/stonebridgeway/ai-dev-system`: `:edge` — из `main`; `:3.0.0`, `:3.0`, `:3` и `:latest`, у каждого двойник `-browser`, — из тега | `.github/workflows/docker-publish.yml`, задание `publish` | ничего: публикует токен самого workflow |
| Линия 2.x, чтобы вернуться | `:2`, копия нынешнего `:latest` | тот же workflow, задание `freeze-2x` | запускает его один раз — после слияния и до тега |
| Пакет npm | `@stonebridgeway/ai-dev-system@3.0.0` | `npm run dist:pack` | `npm publish` тарбола |
| Установщик Windows | релиз GitHub `v3.0.0`, черновиком | `.github/workflows/desktop-windows.yml`, задания `build` (собирает и подписывает) и `release` | подпись (по желанию); публикация черновика |

Сейчас (проверено 2026-10-20, только чтением): `main` основного репозитория — `7bef129`, предок форка;
его теги — `v1.0.0` и `v2.0.0`; теги образа — `:latest` и `:main` (оба — сборка `7bef129`,
`sha256:87df7cde…`), `:v1.0.0`, `:v2.0.0` (`sha256:41cc9635…`) и 21 `:sha-*` — ни `:2`, ни `:3`, ни
`:edge`, ни тегов `-browser`; `@stonebridgeway/ai-dev-system` в npm нет (`npm view` отвечает 404). Каждый
пуш в `main` основного репозитория по-прежнему публикует `:latest` (Д-108) — пока слияние не принесёт
workflow, который этого не делает. Поэтому `:2` будет сборкой `7bef129`, а не образом релиза `v2.0.0`, а
`:main`, который workflow 3.0 больше не пишет, после слияния останется тегом 2.x.

## 1. Pull request

Работа программы лежит в ветке форка `claude/exciting-hawking-fb4g4p`; `main` форка принимает её
fast-forward'ом, и pull request идёт оттуда:

```sh
git clone https://github.com/BreezeAreaSay/ai-dev-system.git && cd ai-dev-system
git fetch origin claude/exciting-hawking-fb4g4p
git merge --ff-only origin/claude/exciting-hawking-fb4g4p
git push origin main
gh pr create --repo stonebridgeway/ai-dev-system --base main --head BreezeAreaSay:main \
  --draft --title "AI Dev System 3.0" --body-file docs/release-notes-3.0.0.md
```

Pull request из форка не получает секретов, и его задания `publish`, `freeze-2x` и `release`
пропускаются: он ничего не публикует. Если GitHub просит одобрить workflow pull request'а из форка —
одобрите.

### Что должно быть зелёным

На последнем коммите pull request'а — каждое задание трёх workflow:

| Workflow | Задание | Что доказывает |
|---|---|---|
| CI | MCP server (lint, security, unit) | ворота, статические проверки, основные тесты на Node 24 |
| CI | No Python (ubuntu-latest), (macos-latest), (windows-latest) | поиск и установка без Python на трёх системах |
| CI | MCP server (Node 22.16 floor) | самую старую Node, которую принимает пакет |
| CI | Desktop app (Electron, xvfb) | тесты приложения и его сквозные экраны |
| CI | MCP server (vault-coupled suite + smokes) | весь набор, смоуки протокола и жизненного цикла |
| CI | macOS (core + hook tests, first run) | macOS |
| CI | Windows (PowerShell syntax, bootstrap plan, installer, core + hook tests) | Windows, `bootstrap.ps1`, скрипты установщика |
| Docker | validate, validate-browser | образ и его вариант с браузером собираются, отвечают по MCP, пишут клиента, обновляют том 2.x |
| Docker | unix-launcher (ubuntu-latest), (macos-latest) | лаунчеры 2.x по-прежнему запускают сервер |
| Windows installer | Build the installer (windows-latest) | установщик собирается на Windows, здесь — без подписи |

### Плотный поиск на настоящих весах

`dense-eval.yml` скачивает закреплённый экспорт BGE-M3 (около 600 МБ) и меряет с ним плотный поиск —
единственная проверка, которую не смогла прогнать ни одна песочница программы (Д-101). Он запускается
только вручную и только на ветке основного репозитория, поэтому последний коммит pull request'а сначала
идёт туда.
Пуш в такую ветку не запускает ни одного workflow.

```sh
git push https://github.com/stonebridgeway/ai-dev-system.git main:refs/heads/release/3.0.0
gh workflow run dense-eval.yml --repo stonebridgeway/ai-dev-system --ref release/3.0.0
sleep 15                                            # запуск появляется в списке не сразу
gh run watch --exit-status --repo stonebridgeway/ai-dev-system "$(gh run list --repo stonebridgeway/ai-dev-system \
  --workflow dense-eval.yml --branch release/3.0.0 --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Он пройден, когда зелёный каждый шаг — скачанное сошлось по sha256 с каждым файлом, `dense:doctor`
сказал READY, тест вывода прошёл (он пропускается, только если весов нет), — а в сводке все документы
с векторами (0 ждут) и золотые случаи не хуже, чем у поиска без модели: 37 из 45, средний обратный
ранг 0,510 — один лексический поиск на тех же случаях и сегодняшнем каталоге (`run_search_eval` с
`include_dense: false` на `a9a02e9`). Меньше — значит, плотная оценка портит ранжирование: запишите это и не сливайте. Ветку
потом удалите: `git push https://github.com/stonebridgeway/ai-dev-system.git --delete release/3.0.0`.

### Слияние

**Merge-коммитом** — не squash и не rebase: `docs/DEFECTS.md` и CHANGELOG называют коммиты программы
по хешу, и они должны оставаться достижимыми.

```sh
gh pr ready <number> --repo stonebridgeway/ai-dev-system
gh pr merge <number> --repo stonebridgeway/ai-dev-system --merge
```

Пуш слияния запускает CI на `main` и публикует `:edge` и `:sha-<commit>` — не `:latest` (решение
владельца D9). `:latest` остаётся образом 2.x до тега.

```sh
docker buildx imagetools inspect ghcr.io/stonebridgeway/ai-dev-system:edge      # 3.0, новый
docker buildx imagetools inspect ghcr.io/stonebridgeway/ai-dev-system:latest    # 2.x, как был
```

## 2. 2.x — в `:2`

Один раз, после слияния и до тега: задание копирует `:latest`, образ 2.x, в `:2`. Это линия, на которую
возвращаются (`docs/MIGRATION.md`, «The way back»). Если `:2` уже есть, оно ничего не делает, а после
тега релиза 3.0 или новее отказывается: `:latest` тогда уже 3.x. Варианта с браузером у 2.x в реестре
нет, поэтому нет и `:2-browser`.

```sh
gh workflow run docker-publish.yml --repo stonebridgeway/ai-dev-system --ref main -f freeze_2x=true
sleep 15
gh run watch --exit-status --repo stonebridgeway/ai-dev-system "$(gh run list --repo stonebridgeway/ai-dev-system \
  --workflow docker-publish.yml --event workflow_dispatch --limit 1 --json databaseId --jq '.[0].databaseId')"
docker buildx imagetools inspect ghcr.io/stonebridgeway/ai-dev-system:2 --format '{{json .Manifest.Digest}}'
docker buildx imagetools inspect ghcr.io/stonebridgeway/ai-dev-system:latest --format '{{json .Manifest.Digest}}'
```

Оба дайджеста совпадают.

## 3. Версия и тег

В пакетах уже стоит 3.0.0. Релиз добавляет только дату — коммитом в `main` основного репозитория, где
теперь есть слияние. В клоне из раздела 1 `origin` — форк, поэтому основной репозиторий назван по адресу:

```sh
PROD=https://github.com/stonebridgeway/ai-dev-system.git
git fetch "$PROD" main && git checkout -B release-3.0.0 FETCH_HEAD
# CHANGELOG.md: "## [3.0.0] - Unreleased" → "## [3.0.0] - <YYYY-MM-DD>", над ним новый пустой "## [Unreleased]",
# а внизу:
#   [Unreleased]: https://github.com/stonebridgeway/ai-dev-system/compare/v3.0.0...HEAD
#   [3.0.0]: https://github.com/stonebridgeway/ai-dev-system/compare/v2.0.0...v3.0.0
git commit -am "docs(changelog): 3.0.0" && git push "$PROD" HEAD:main
git tag -a v3.0.0 -m "AI Dev System 3.0.0" && git push "$PROD" v3.0.0
```

Тег публикует `:3.0.0`, `:3.0`, `:3`, `:latest` и `:sha-<commit>`, у каждого двойник `-browser`, и
собирает установщик Windows в **черновик** релиза `v3.0.0`. Тег предрелиза (`v3.0.0-rc.1`) публикует
только своё имя и `:sha-<commit>` и `:latest` не двигает.

```sh
docker buildx imagetools inspect ghcr.io/stonebridgeway/ai-dev-system:latest    # теперь 3.0.0
docker run --rm --entrypoint ai-dev ghcr.io/stonebridgeway/ai-dev-system:3.0.0 version   # ai-dev 3.0.0 (Node 24…)
gh release view v3.0.0 --repo stonebridgeway/ai-dev-system                      # черновик, с .exe
```

## 4. npm

Из кода на теге, на Node 24:

```sh
git checkout v3.0.0
cd ai-dev-mcp-server && npm ci && npm run dist:pack
npm publish ../dist/stonebridgeway-ai-dev-system-3.0.0.tgz --access public
npm view @stonebridgeway/ai-dev-system version                                  # 3.0.0
npx --yes @stonebridgeway/ai-dev-system@3.0.0 version
```

`--access public` — потому что пакет со scope по умолчанию закрытый. Тарбол — около 10 МБ, 1 830 файлов
(у `a9a02e9` — 10 177 652 байта).

## 5. Установщик Windows

Подпись берётся из секретов и переменных основного репозитория (решение владельца D7); их читает
задание, которое собирает по тегу, — `build` («Build the installer (windows-latest)»):

- сертификат: секреты `WIN_CSC_LINK` (`.pfx` в base64) и `WIN_CSC_KEY_PASSWORD`;
- или Azure Trusted Signing: переменные `AI_DEV_SIGN_AZURE_ENDPOINT`, `AI_DEV_SIGN_AZURE_ACCOUNT`,
  `AI_DEV_SIGN_AZURE_PROFILE`, `AI_DEV_SIGN_PUBLISHER` (имя в сертификате, с которым автообновление сверяет
  каждое обновление) и секреты `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`. Если задан
  `AI_DEV_SIGN_AZURE_ENDPOINT`, а какой-то из трёх других `AI_DEV_SIGN_*` нет, сборка останавливается.

Без того и другого установщик собирается неподписанным: он работает, а Windows SmartScreen
предупреждает. Релиз остаётся черновиком: установленные приложения обновляются только из
опубликованных релизов. Только после публикации его можно скачать, а приложения получают обновление:

```sh
gh release edit v3.0.0 --repo stonebridgeway/ai-dev-system --notes-file docs/release-notes-3.0.0.md --draft=false
```

## 6. После релиза

- Убрать из руководств пометки «до релиза» — тарбол для `npx`, образ из клона с `--allow-stale-image`,
  `:latest` как образ 2.x: `README.md`, `README.ru.md`, `docs/INSTALL.md`, `docs/ru/INSTALL.md`,
  `docker/README.md`, `docs/UPGRADE-TEST.md` (и RU), `docs/TEST-PLAN.ru.md`, `docs/MIGRATION.md` (и RU) —
  одним pull request'ом после тега.
- Ручная приёмка на трёх системах (`docs/TEST-PLAN.ru.md`) на выпущенных артефактах.

## Откат

Каждая часть откатывается отдельно:

| Что | Как | Что видят люди |
|---|---|---|
| Образ | `docker buildx imagetools create --tag ghcr.io/stonebridgeway/ai-dev-system:latest ghcr.io/stonebridgeway/ai-dev-system:2` (после `docker login ghcr.io` с токеном, который может писать пакеты) | новый `bootstrap` или pull снова получает 2.x — записи для него bootstrap 3.0 пишет образом `:3`, линией 3.x, которой `:latest` больше не является (другой называет `AI_DEV_INSTALLER_IMAGE`); уже написанные записи называют `:latest` и получат 2.x при следующем pull |
| Docker-установка одного человека | `sh ./bootstrap.sh --image ghcr.io/stonebridgeway/ai-dev-system:2` — папки он оставит те, что монтируют записи (`docs/MIGRATION.md`) | 2.x с монтированиями 3.0 |
| npm | `npm deprecate @stonebridgeway/ai-dev-system@3.0.0 "<почему>"`, затем исправленная 3.0.1; снять публикацию можно только первые 72 часа, и это ломает тех, кто поставил | `npx` предупреждает |
| Установщик | `gh release edit v3.0.0 --repo stonebridgeway/ai-dev-system --draft=true` | автообновление перестаёт его предлагать; установленные приложения остаются как есть |
| Исходники | `git revert -m 1 <merge-коммит>` в `main` и пуш | revert возвращает workflow 2.x: пуш собирает 2.x и публикует её как `:latest`, `:main` и `:sha-<commit>`, как и каждый следующий пуш в `main`; `:edge` остаётся на 3.0 |

`:latest-browser` пришёл с 3.0 — у 2.x нет варианта с браузером, — так что возвращать его некуда:
оставьте его или удалите тег на странице пакета.

## Что прогнано и где

Всё здесь прогнано в песочнице программы — Linux, Docker 29.8.2, Node 22.22 и 24 — на коммите ветки
`a9a02e9`, если не назван другой. Ничего не запушено и не опубликовано.

| Шаг | Что прогнано | Что вышло |
|---|---|---|
| 1 | клон, `git fetch` ветки, `git merge --ff-only` | exit 0; `main` форка (`096c982`) — предок ветки |
| 2 | защита заморозки из `docker-publish.yml` — с тегами основного репозитория и с `v3.0.0-rc.1` | «goes on: no release of 3.0 or later»; с тегом `v3.0.0` — «refuses: v3.0.0 is tagged» |
| 3 | `git fetch "$PROD" main && git checkout -B release-3.0.0 FETCH_HEAD`; правка CHANGELOG, её коммит и тег — на голове, которую приносит слияние | exit 0 у каждого (`main` основного репозитория до слияния — `7bef129`); два пуша — не запускались |
| 4 | `npm run dist:pack`; `npx --yes @stonebridgeway/ai-dev-system@3.0.0 version` в чистом `node:24-bookworm-slim` через реестр, где только этот тарбол | `stonebridgeway-ai-dev-system-3.0.0.tgz`, 10 177 652 байта, 1 830 файлов; `ai-dev 3.0.0 (Node 24.22.0, linux-x64)` |
| — | путь `npx` из README в чистом контейнере: установка, клиенты, первая задача, удаление | exit 0; конфиг Cursor восстановлен байт в байт |
| — | образ, собранный из ветки: `ai-dev version`, `docker:smoke`, `docker:upgrade-check` с образа 2.x `2x-8f647df` | `3.0.0`; pass (первая сессия 1 917 мс, следующая 906 мс); pass |
| — | путь Docker из README: без клиента, `bootstrap.sh`, первая задача, снова bootstrap без названных папок и поверх записи 2.x (Д-403), путь назад на образ 2.x и возврат | exit 0 у каждого; папка проектов из записей оставлена и названа |
| — | `npm run upgrade:test` с `8f647df` основного репозитория, с тега `v2.0.0` (`346095d`) и с его `main` (`7bef129`) | 199 из 199 проверок у каждого, путь назад тоже |
| — | `npm run check`; `npm run acceptance` | отчёт фазы 15 (`docs/program/reports/phase-15.md`) |

Здесь не прогнано: всё, что пушит или публикует, CI основного репозитория, `dense-eval` на настоящих весах,
Windows и macOS — ручная приёмка на выпущенных артефактах — `docs/TEST-PLAN.ru.md`.
