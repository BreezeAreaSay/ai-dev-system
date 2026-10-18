# Отчёт фазы 12: Установщик Windows

Статус: готова (2026-10-18); живая Windows — чек-лист владельца (раздел 8)
PR: — сессия 2026-10-18 работает в ветке `claude/exciting-hawking-fb4g4p` (её назначила среда сессии; PROGRESS,
«Сессия 2026-10-18»), без слияний, поверх `main` @ `096c982` · код фазы — `5518991`, `095c558`; записи ревью —
`99d9a0c`, `71060af`; правки ревью — `8730b57` (словари в своих файлах), `0a96b4b`, `be8a6e7`; закрытие — коммит отчёта ·
старт от `main` @ `096c982`
Объём: `096c982..be8a6e7` — 50 файлов, +8 698 / −904 (из них `desktop/package-lock.json` +3 529 / −77: electron-builder и
electron-updater)

### 1. Пункты

| # | Пункт | Статус | Где | Комментарий |
|---|---|---|---|---|
| 1 | electron-builder NSIS, для текущего пользователя без прав администратора | ✅ | `desktop/scripts/windows-bundle.mjs` (`builderConfig`), `desktop/scripts/build-windows.mjs` | electron-builder 26.17.0; `oneClick`, `perMachine: false`, `allowElevation: false` → `%LOCALAPPDATA%\Programs\ai-dev-desktop`, ярлыки «AI Dev», запуск после установки; языки установщика — en_US и ru_RU |
| 1а | Состав: приложение из `desktop/` | ✅ | `files: ["package.json", "src/**/*"]`, `asar` | тесты, скрипты и файлы сборки в приложение не попадают; electron-updater — production-зависимость |
| 1б | portable `node.exe` Node 24 LTS, версия и sha256 закреплены и сверяются при сборке | ✅ | `desktop/build/node-win-x64.json`; `addNode` в `build-windows.mjs` | v24.22.0 (Node 26 станет LTS в конце октября 2026 — сегодня `lts: false` в `index.json`); sha256 zip `f9683a19…` и `node.exe` `ba93f9a7…` — из SHASUMS256.txt релиза; сверяются оба, `LICENSE` Node — рядом |
| 1в | dist фазы 7, урезанный под win32-x64: onnxruntime-node только win32/x64; onnxruntime-web и sharp-wasm32 — убрать, если импорт позволяет (проверить) | ✅ | `trimRuntime`, `TRIMMED`, `danglingDependencies` | dist фазы 7 (`build-dist.mjs --no-deps`) + `npm ci --os=win32 --cpu=x64` (одно дерево на любой машине сборки). Проверено: `transformers.node.mjs` 4.3.0 несёт веб-рантайм внутри своего файла (`ort.webgpu.bundle.min.mjs` вшит), `onnxruntime-web` не импортирует; `@img/sharp-wasm32` по `npm ls` — `extraneous` (зависимость пакетов FreeBSD и WebContainers, которых нет). Без них на Linux: `transformers` грузится, сквозной тест синтетической модели через настоящий воркер — 3 из 3. Срезано: onnxruntime-web 138,7 МБ, sharp-wasm32 8,7 МБ, onnxruntime-node darwin 85,3 / linux 68,4 / win32-arm64 69,4 МБ, `@emnapi/runtime`, `tslib`, `.bin` |
| 2 | Стабильная точка входа для MCP-клиентов; обновление не упирается в занятые файлы; схему описать | ✅ | `ai-dev-mcp-server/src/core/app-bundle.mjs` (`provisionBundle`, `pointCurrent`, `stableLaunch`), `client-connections.mjs` (`localLaunch`), `app-home.mjs` (`pruneAppCopies`, `copiesNamedByClients`); схема — `docs/DESKTOP.md`, «How AI clients reach it» | рантайм копируется из `resources\runtime` в `%USERPROFILE%\.ai-dev\app\<версия>-<отпечаток>` со сверкой sha256 каждого файла; junction `…\app\current` переводится на копию; конфиги клиентов называют `current\node\node.exe` и `current\ai-dev-mcp-server\bin\ai-dev.mjs`. Обновление пишет новую копию рядом и переводит ссылку: ни один занятый файл не перезаписывается, конфиги не меняются. При каждом запуске копия сверяется по размерам файлов, пропавшее возвращается (Д-300). Чистка — своим счётом для копий установщика и копий npx; не удаляет ни копию за `current`, ни копию, которую называет конфиг клиента (Д-299, Д-301, Д-310). Диск без ссылок (любая ошибка создания ссылки) — работа из самой копии, «Состояние» говорит об этом (Д-295, Д-299). Рантайм папки программы в конфиги не попадает (Д-305) |
| 3 | Первый запуск: seed разворачивается в пользовательское хранилище, открывается мастер | ✅ | `desktop/src/main/bundle.mjs`, `main.mjs` (`prepare`); `src/renderer/app.js` (экран подготовки) | приложение готовит рантайм (экран «Preparing AI Dev…» с прогрессом), запускает демон на Node рантайма; сервер раскладки `package` заполняет `~/.ai-dev/vault` из `seed/`; индекса нет — открывается мастер (e2e `bundle.test.mjs`) |
| 4 | Автообновление — electron-updater, канал — GitHub Releases прода; подпись — через переменные окружения | ✅ | `desktop/src/main/updates.mjs`, `main.mjs`; `publish` в `builderConfig` | `app-update.yml`: `provider: github`, `owner: stonebridgeway`, `repo: ai-dev-system`; проверка через минуту и раз в 6 часов, «Перезапустить и обновить» в трее, установка при «Выходе»; `host-resolver-rules` — исключение только для `github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` (Д-260), сессия `electron-updater` пропускает только HTTPS к ним; подпись — `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` или `AI_DEV_SIGN_AZURE_*`; без них — неподписанная сборка |
| 5 | Сборка: `npm run dist:win` — одна команда на Windows; workflow для windows-latest | ✅ | `desktop/package.json`, `.github/workflows/desktop-windows.yml`; джоб `desktop` в `ci.yml` — `--check` | шесть шагов: dist → зависимости win32-x64 и срез → Node → `bundle.json` → electron-builder → сверка рантайма в собранном приложении (она нашла Д-294). Релиз — только из `stonebridgeway/ai-dev-system` по тегу `v*`, черновиком |
| 6 | Удаление: программа и, после вопроса, записи в клиентах; пользовательские данные — по выбору | ✅ | `desktop/build/installer.nsh` (`customUnInstall`); `ai-dev uninstall` (`src/cli/uninstall.mjs`, `src/core/bundle-uninstall.mjs`) | после «Вы уверены?» — два вопроса (окна без `/SD`: удаление одним щелчком идёт молча, и NSIS отвечал бы за человека, Д-296): убрать из клиентов (по умолчанию «Да») и удалить данные (по умолчанию «Нет»); затем `ai-dev uninstall --yes [--clients] [--data]` из рантайма установщика: стоп демона, копии, ссылка и оставленные прерванным переносом ссылки, записи, которые запускают эту установку (только абсолютные пути, Д-298; чужие остаются), данные — только папку, где всё AI Dev (верхний уровень и `models`, `cache`, `backups`, Д-297, Д-307), и не пока копия занята (Д-309). Код 3 — «занято»: окно «Повторить/Отмена» (Д-302); 4 — данные оставлены: окно. `/S` — ответы по умолчанию без окон; обновление (`--updated` или `/KEEP_APP_DATA`) — ничего из этого. Проверено под Wine, раздел 4 |

### 2. Дефекты

| № | «до»: команда → вывод | «после»: команда → вывод | Статус |
|---|---|---|---|
| Д-294 | `npm run dist:win` (одна запись `extraResources`) → «Error: 6021 runtime file(s) did not land in the app as built, such as node_modules/.package-lock.json…»: в `resources/runtime` 1 827 файлов из 7 847 | → `"shipped_files": 7848` (7 847 и `bundle.json`), установщик 192 352 099 байт | закрыт |
| Д-295 | Wine 9.0, `provisionBundle` из установленной программы → `ENOTSUP: operation not supported on socket, symlink …current.260.20f938b4.next`; копия цела, приложение не стартовало бы | → юнит-тест: `status installed`, `current ""`, пути — в копии, `linkError "ENOTSUP: …"`. Под Wine (раздел 4): `status installed`, `current ""`, `linkError "ENOTSUP: …"`, CLI копии отвечает `ai-dev 2.0.0 (Node 24.22.0, win32-x64)` | закрыт |
| Д-296 | Wine 9.0, удаление без `/S`, `WINEDEBUG=+msgbox` → одно окно: `L"Are you sure you want to uninstall AI Dev?"` | → (раздел 4, «Wine: удаление») | закрыт |
| Д-297 | `review12/probe-data.mjs` (`AI_DEV_HOME=<home>/Documents` с `thesis.docx`, `Taxes 2025/` и `logs/`) → `refuseDataRemoval: ""`, `thesis.docx still there: false`, `Taxes 2025/return.pdf still there: false` | → `… also holds what AI Dev did not make (Taxes 2025, thesis.docx); delete AI Dev's own folders in it yourself.`, `thesis.docx still there: true`, `return.pdf … true` | закрыт |
| Д-298 | `review12/probe-runsbundle-cwd.mjs` → `cwd inside current: clone true \| docker true` | → `cwd inside current: clone false \| docker false` | закрыт |
| Д-299 | `p12/probes2/probe-eisdir.mjs` → `the start stops: EISDIR …`; `probe-nolink-prune.mjs` → `removed by the second update: ["3.0.0-b7f8e32a"]`, `still there: false`; `grep linkError desktop/src` — пусто | → `EISDIR: installed \| current: "" \| linkError: EISDIR: …`; `removed …: []`, `still there: true`; e2e «a drive that cannot hold the link» (папка `app` с `chattr +i`, `EPERM`) — Status показывает причину и что делать, конфиг клиента называет копию | закрыт |
| Д-300 | `review12/probe-damaged-copy.mjs` → `after 'reinstall': present \| dll back: false \| cli restored: false`; совет — «run the AI Dev installer again» | → `repaired \| dll back: true \| cli restored: true`; совет — «quit AI Dev and start it again — it puts back …»; e2e «a copy that lost files…» — Status называет файлы | закрыт |
| Д-301 | `review12/probe-prune-mixed.mjs` → `removed by the update's prune: [ '3.0.0-7c2a2895' ]`, `npx copy still there: false` | → `removed …: []`, `npx copy still there: true` | закрыт |
| Д-302 | `p12/probes2/probe-in-use.mjs` (копия под `mount --bind`, `EBUSY`) → `exit 1`, «Left the runtime …: in use.»; NSIS только `DetailPrint` | → `exit 3`; NSIS — окно «Повторить/Отмена» (раздел 4, «Wine: занятая копия») | закрыт |
| Д-303 | `p12/probes2/probe-publisher.mjs` → `publisherName: "stonebridgeway"` | → `refused: Azure signing is set up (AI_DEV_SIGN_AZURE_ENDPOINT) but not AI_DEV_SIGN_PUBLISHER: …` | закрыт |
| Д-304 | `review12/probe-dangling.mjs` → `danglingDependencies: []` | → `[{"package":"outer/node_modules/inner","missing":"left-pad"},{"package":"some-lib","missing":"tslib"}]` | закрыт |
| Д-305 | `p12/probes2/probe-installer-config.mjs` → конфиг назвал бы `Programs/AI Dev/resources/runtime/node/node.exe` | → `refused: This is the runtime in AI Dev's program folder (…), which an update replaces, so a client config must not name it. …` | закрыт |
| Д-306 | п. 1 `review12/probe-case-dup.mjs` → проверки сборки `[]`, приложение отказывает; п. 3 `probe-data-link.mjs` → `removed: true`, `decisions.json still there: true`; п. 7 `probe-stale-links.mjs` → `stale link still there: true`; остальное — по коду | → п. 1 `probe-case-dup-build.mjs` → `the build's bundle.json step stops: … listed twice.`; п. 3 → `removed: true, target: …/ai-dev-data`, `decisions.json still there: false`, `link still there: false`; п. 7 → `false`; п. 2, 4–6 — код и тесты | закрыт |
| Д-307 | `review12b/probes/probe-data.mjs` → C (`D:\AI` со своими моделями и архивом): `exit 0 … removed: true`, D (файл `vault`): `exit 0 … removed: true` | `p12/probes2/probe-data-fixed.mjs` (та же, с именем архива, которое AI Dev пишет) → A, B — `exit 0`, удалены; C — `exit 4 … (backups/my-photos-2025.zip, models/llama-3-70b.Q4_K_M.gguf)`; D — `exit 4 … (vault)` | закрыт |
| Д-308 | `review12b/probes/probe-bad-marker.mjs` → `start 1: throws: Unexpected end of JSON input`, `start 2: …`, `ai-dev uninstall --data: throws …` | → `start 1: installed`, `start 2: present`, удаление прошло, домашней папки рантайма нет | закрыт |
| Д-309 | `review12b/probes/probe-data-held-copy.mjs` → `exit 3`, «Kept ~/.ai-dev: moved to …removing.partial, which could not be deleted completely.» (`state/`, `vault/` удалены) | → `exit 3`, «Kept ~/.ai-dev: AI Dev's runtime in it is still in use.» — данные целы; Wine G — после «Повторить» удалены целиком | закрыт |
| Д-310 | `probe-linkerror` → «(EPERM: EPERM: …)»; `probe-hint` → `/Users/O'Brien/…` без кавычек; `probe-data` B → `exit 4 … (config.json…bak)`; `probe-link-home` → «…which <base>/via/aidev links to…»; `probe-provision` C2 → копию, которую называет Claude, удаляет чистка npx | → «(EPERM: operation not permitted, …)»; `& '/Users/O''Brien/…' doctor`; B — `exit 0`; «Deleted <base>/via/aidev and everything in it.»; `probe-npx-named` → `still there: true` | закрыт |

### 3. Критерии приёмки

| Критерий | Команда | Фактический вывод | ✅/❌ |
|---|---|---|---|
| В песочнице тест проверяет конфигурацию сборки и состав пакета (список файлов, размер) | `cd desktop && node --test test/unit/windows-build.test.mjs`; `node scripts/build-windows.mjs --check`; `npm run dist:win` | юнит: 10 из 10 (срез на синтетическом дереве; висячие зависимости — по точным парам и во вложенных `node_modules`, нечитаемый `package.json` — отказ с именем; файлы со sha256 и отказ на ссылке; `bundle.json` ↔ разбор приложения, имена, различающиеся регистром, — отказ сборки; состав; ICO; конфиг NSIS и подпись Azure — все четыре переменные или отказ; версия приложения = версия рантайма; пин Node); `--check` и полная сборка `be8a6e7`: 7 847 файлов, 242 667 263 байта (231,4 МБ), проблем состава 0, висячих зависимостей 0, в собранном приложении 7 848 файлов совпали по sha256 | ✅ |
| Если NSIS на Linux не собирается — «не проверено» | `npm run dist:win` на Linux с Wine 9.0 (`wine`, `wine64`, `wine32:i386` из archive.ubuntu.com) | собирается (с `-WX`): `AI-Dev-Setup-2.0.0.exe` 192 360 355 байт, `.blockmap`, `latest.yml`, 116 с; без Wine — `spawn wine ENOENT`, без `wine32` — заглушка NSIS 32-битная не запускается | ✅ |
| В чек-лист владельца — главное (чистая Windows 11 без Node, Python, Docker) | — | раздел 8 | — |

### 4. Проверки

**Ворота** — на `be8a6e7` (код фазы с правками обоих ревью):

| Ворота | Команда | Вывод |
|---|---|---|
| check | `cd ai-dev-mcp-server && npm run check` | exit 0 за 1 м 52 с: 1 846 тестов, 1 829 pass, 0 fail, 17 skipped; покрытие строк 97,47 % (на старте сессии — 97,48 %) |
| acceptance | `npm run acceptance` | **0 падений из 10** (прогоны 113–116 с, всего 19 м 10 с) |
| upgrade:test | `npm run upgrade:test` | 174 of 174 checks passed in 180 s |
| тесты приложения | `cd desktop && npm test` (Electron 44.5.1, Playwright под xvfb, настоящий демон) | юнит 108 из 108; e2e 40 из 40 за 8 м 19 с, из них четыре — установки Windows: копия за ссылкой и обновление при работающем клиенте; испорченный рантайм; копия, потерявшая файлы, — возвращены, «Состояние» называет их (Д-300); диск без ссылки — от root, папка `app` с `chattr +i` (Д-299) |
| сборка | `cd desktop && npm run dist:win` | рантайм 7 847 файлов, 242 667 263 байта; в собранном приложении 7 848 файлов совпали по sha256; `AI-Dev-Setup-2.0.0.exe` 192 360 355 байт; 116 с |

**Пробы против работающего сервера** (`p12/probes/probes.mjs`: рантайм в форме установщика, подготовленный, через
ссылку, по MCP) — 10 из 10: `initialize` через `current` с `instructions` (1 048 знаков); `clients_install` пишет ссылку,
а не копию; обновление не пишет ни одного конфига (байт в байт), старый клиент обслуживает старая сборка, новый — новая;
запись клона — не «эта установка»; `uninstall --clients` убирает только запись этой установки; демоны остановлены,
копии и ссылка ушли, данные остались; **«не должно случиться»** — `--data` на папке со своим `cat.jpg`: код 4, «also holds
what AI Dev did not make (cat.jpg)», файл на месте. (Ожидание P3c в пробе поправлено под новую формулировку Д-297: первый
прогон на `be8a6e7` упал на старом тексте «does not look like an AI Dev runtime home», не на поведении.)

**Wine 9.0** — установщик-вариант, в котором заглушена только проверка «AI Dev запущен» electron-builder (под Wine нет
PowerShell, а `tasklist /FI` не фильтрует); шаг удаления тот же (`diff` пуст). Каждый сценарий — на свежем префиксе
(`wineprobe/scenario.sh`): тихая установка, рантайм готовится `node.exe` установщика, как это делает приложение, в
профиль кладутся два конфига (Claude Code — эта установка, Cursor — клон), удаление без `/S` с `+msgbox`, окна
отвечаются клавишами (`xdotool windowfocus`).

- Рантайм (Д-295): `provisionBundle` → `status installed`, `current ""`, `linkError "ENOTSUP: operation not supported on
  socket, symlink …"`, 38,8 с на 231 МБ; второй запуск — `present`, 2,8 с; CLI копии — `ai-dev 2.0.0 (Node 24.22.0,
  win32-x64)`.
- Удаление (`p12/wine/*/result.txt`):

| Сценарий | Окна | Итог |
|---|---|---|
| A — ответы по умолчанию | «Are you sure…», «Remove AI Dev from your AI clients' settings…», «Also delete AI Dev's data: the vault it keeps…» | программа и копия удалены; запись `ai-dev` у Claude убрана, `other` и запись клона у Cursor на месте; данные на месте |
| B — копия занята (`mount --bind`) | те же и «Some of AI Dev's files are in use…» → mount снят, «Повторить» | копия удалена вторым прогоном |
| C — «Нет» клиентам, «Да» данным, в папке чужой `notes.txt` | те же и «AI Dev's data was not deleted…» | запись у Claude на месте, данные и `notes.txt` целы |
| D — `/S` | ни одного | ответы по умолчанию |
| E — `ru_RU.UTF-8` | «Вы уверены, что хотите удалить AI Dev?», «Убрать AI Dev из настроек ваших AI-клиентов…», «Удалить и данные AI Dev: его хранилище…» | как A |
| G — копия занята, «Да» данным | те же и «Some of AI Dev's files are in use…» → «Повторить» | после «Повторить» `.ai-dev` удалена целиком (Д-309) |
| F — до: шаг `095c558` на том же рантайме | только «Are you sure…» | ответы по умолчанию, вопросов не было (Д-296) |

**Независимые ревью — два.** Первое (по `096c982..095c558`) — 2 must-fix, 7 should-fix, 7 nit → Д-296 … Д-306 (и
подозрение, подтверждённое пробой, — Д-305). Второе (по правкам, `99d9a0c..0a96b4b`) — must-fix нет, 2 should-fix, 6 nit
и подозрение, подтверждённое его пробой → Д-307 … Д-310; оно же собрало шаг NSIS отдельным харнессом в обоих проходах с
`-WX` — 0 предупреждений — и прогнало 11 своих проб. Всё записано до правки и закрыто в фазе (раздел 2), пробы «после» —
в `p12/review-after/`, `p12/review2-after/`.

### 5. Не проверено

| Что | Почему | Как проверить |
|---|---|---|
| Установка, мастер, клиенты, модель, обновление при запущенном клиенте, удаление на настоящей Windows 11 | песочница — Linux; Wine исполняет установщик, но не Windows (раздел 4) | раздел 8, п. 1–7 |
| Junction на NTFS: создание без администратора, перевод при работающих клиентах, `realpath` через него, удаление | Wine 9.0 junction не умеет (`ENOTSUP`, Д-295); логика проверена на подменённом `platform` и символических ссылках Linux | раздел 8, п. 5 |
| Проверка «AI Dev запущен» в установщике electron-builder | под Wine нет PowerShell, а `tasklist /FI` Wine фильтр не применяет — проверка ложно находит «AI Dev» и тихая установка выходит с кодом 2; на Windows проверка идёт через PowerShell по путям процессов внутри папки программы, а рантайм клиентов вне её | раздел 8, п. 1 и 6 |
| Обновление через настоящий GitHub Release | релизов с установщиком у прода нет; публикация — владельца | раздел 8, п. 6; `docs/RELEASE.md` (фаза 15) |
| Подпись и SmartScreen | сертификата нет (D7: у владельца) | раздел 8, п. 8 |
| Workflow `desktop-windows.yml` на `windows-latest` | Actions форка не стартуют (PROGRESS, «Блокеры») | черновой PR в прод (D0) или ручной запуск |
| Окна удаления на настоящей Windows | под Wine 9.0 сняты все пять, на английском и русском (раздел 4); Windows рисует свои кнопки и шрифты | раздел 8, п. 7 |
| Обновление за прокси, заданным именем хоста (PAC, WPAD, именованный прокси) | `MAP * ~NOTFOUND` (Д-260) исключает только три хоста обновлений; имя самого прокси, вероятно, тоже не разрешится — подозрение первого ревью, в песочнице не проверить | раздел 8, п. 6 — в сети с прокси |
| Время первого копирования рантайма на Windows | под Wine — 35 с на 231 МБ; на NTFS с антивирусом может быть иначе | раздел 8, п. 2 |
| Запись клиента с путём 8.3 (`JOHNSM~1`) или `\\?\` | `appEntryOf` таких путей не узнаёт: запись не считается «этой установкой» и при удалении остаётся (в безопасную сторону); AI Dev сам таких путей не пишет | — |

### 6. Отступления и принятые решения

1. **Рантайм копируется вне папки программы.** Бриф предлагал «версионированный рантайм за стабильным лаунчером»;
   стабильный путь — junction `…\.ai-dev\app\current`, а не отдельный exe: junction не нужен ни администратор, ни
   режим разработчика, а лишнего процесса между клиентом и мостом нет. Копии живут в app home фазы 7 (там же копии
   npx) и подчиняются его чистке; связанная копия защищена.
2. **Диск без ссылок** (exFAT, FAT32, сетевые папки, Wine) — работа из самой копии; конфиги клиентов тогда называют
   копию, и после обновления клиентов нужно подключить снова (Д-295, документация).
3. **Сверка sha256 при копировании; при каждом запуске — размеры** всех файлов копии (Д-300): пропавшее или изменившееся
   возвращается из установщика со сверкой sha256; правка, сохранившая размер, не видна — хешировать 231 МБ при каждом
   запуске — секунды.
4. **oneClick-установщик для текущего пользователя**: без страниц выбора; папка — `%LOCALAPPDATA%\Programs\ai-dev-desktop`
   (electron-builder берёт имя пакета), ярлыки — «AI Dev».
5. **`deleteAppDataOnUninstall: true`** — это кэш Electron в `%APPDATA%`; данные AI Dev (`~/.ai-dev`) — отдельным вопросом.
6. **Удаление записей клиентов по умолчанию «Да»** (записи запускают удаляемую программу); **данных — «Нет»**. Вопросы
   — окнами без `/SD` и только без явного `/S` (Д-296); `/S` — ответы по умолчанию. Обновление (`--updated` или
   `/KEEP_APP_DATA`) ничего не трогает.
11. **Данные удаляются, только когда всё в папке — AI Dev** — на верхнем уровне и внутри `models`, `cache`, `backups`,
   с проверкой вида (папка/файл), — и не пока копия рантайма занята (Д-297, Д-307, Д-309). Внутри `state`, `vault`,
   `logs`, `run`, `app`, `artifacts` содержимое не перебирается: эти имена AI Dev даёт своим папкам; документация говорит
   ровно это. Резервные копии `ai-dev backup` удаляются вместе с данными — окно вопроса их называет.
12. **Коды выхода `ai-dev uninstall`** — язык между CLI и NSIS: 3 «занято» (окно «Повторить»), 4 «данные оставлены»,
   прочее не 0 — «не всё убрано»; тексты окон — строки NSIS на двух языках, а не вывод CLI (nsExec читает вывод в
   кодировке ANSI, и кириллица путей превратилась бы в кракозябры).
7. **`ai-dev.cmd` рядом со ссылкой** — CLI для терминала; в `PATH` ничего не добавляется, подсказки демона называют
   команду полностью (`hint()` для раскладки `bundle`).
8. **Релиз — черновиком**: electron-updater читает только опубликованные релизы, обновление уходит людям, когда владелец
   публикует черновик.
9. **Node 24.22.0**: Node 26 к дате сборки ещё не LTS.
10. **Переменные приложения** `AI_DEV_DESKTOP_BUNDLE` и `AI_DEV_DESKTOP_UPDATES` — не часть сборки демона (Д-244), подписи
    `AI_DEV_SIGN_*` — инструменты сборки (`session-env.mjs`).

### 7. Влияние на установки 2.x

- Ничего не меняется: установщика Windows в 2.x не было. Сервер меняется только для раскладки с `bundle.json`
  (`localLaunch`, `hint`, `runtimeRepairHint`); новая команда `ai-dev uninstall`; чистка app home не трогает копию, на
  которую указывает `current` (у установок без установщика её нет).
- Для установок через `npx … setup` чистка копий теперь оставляет и копию, которую ещё называет конфиг клиента (Д-310,
  п. 6): в `~/.ai-dev/app` может остаться больше двух копий, пока такой клиент не подключён снова.
- Мигрировать нечему; откат — удалить программу (записи клиентов возвращаются, данные — по выбору).

### 8. Для следующих фаз и в чек-лист владельца

**Чек-лист владельца — чистая Windows 11 x64** (Windows Sandbox или VM; без Node, Python, Docker; обычный пользователь).
Установщик — артефакт `windows-installer` прогона `desktop-windows.yml` или `cd desktop && npm ci && npm run dist:win`
на Windows с Node 24. Время каждого шага — в форму 9.3 брифа.

1. **Установка без администратора.** Запустить `AI-Dev-Setup-<версия>.exe` (SmartScreen: «Подробнее → Выполнить в любом
   случае», пока сборка не подписана). Ожидается: ни одного запроса UAC; программа в
   `%LOCALAPPDATA%\Programs\ai-dev-desktop`; ярлыки «AI Dev» в «Пуске» и на рабочем столе; приложение запустилось само.
2. **Первый запуск.** Окно «Preparing AI Dev…» с прогрессом (время копирования); появились
   `%USERPROFILE%\.ai-dev\app\<версия>-<отпечаток>` и `%USERPROFILE%\.ai-dev\app\current` — `dir /AL
   %USERPROFILE%\.ai-dev\app` показывает `<JUNCTION> current [...]`; `%USERPROFILE%\.ai-dev\vault` заполнен; открылся
   мастер.
3. **Мастер и клиенты.** Папка проектов; отметить Claude Desktop и Cursor → «Подключить». В
   `%APPDATA%\Claude\claude_desktop_config.json` и `%USERPROFILE%\.cursor\mcp.json` запись `ai-dev` с
   `…\.ai-dev\app\current\node\node.exe` и `…\current\ai-dev-mcp-server\bin\ai-dev.mjs`. Перезапустить клиентов:
   `ai-dev` в списке серверов, `begin_task` отвечает.
4. **Модель.** Шаг модели — «Скачать» (~600 МБ) с прогрессом; «Отмена» посередине; «Скачать» снова — докачка;
   индекс с векторами.
5. **Обновление при запущенном клиенте.** Не закрывая Claude Desktop (сессия с AI Dev открыта), поставить установщик
   следующей версии (или релиз через «Перезапустить и обновить» в трее). Ожидается: установка без «File is busy» и без
   просьбы закрыть Claude; `current` указывает на новую копию, старая на месте; Claude продолжает отвечать в открытой
   сессии; новая сессия Claude работает на новой копии (`ai-dev.cmd daemon status` из `current`); конфиги клиентов не
   изменились (дата файла).
6. **Обновление из релиза.** Когда в проде есть два опубликованных релиза с установщиком: старая версия находит новую
   через минуту, в трее — «Restart to update to …», после перезапуска — новая версия.
7. **Удаление.** «Параметры → Приложения → Установленные приложения → AI Dev → Удалить»: после «Вы уверены?» — два
   вопроса на языке системы; «Да» / «Нет» → записи `ai-dev` ушли из Claude Desktop и Cursor (запись другой установки,
   если была, осталась), `…\.ai-dev\app\*` и `current` удалены, `…\.ai-dev\vault` и `state` на месте. Повторить при
   **открытом Claude Desktop** и «Да» на данные: окно «Часть файлов AI Dev занята…» → закрыть Claude → «Повторить» →
   `%USERPROFILE%\.ai-dev` удалён целиком, проекты не тронуты. Положить в `.ai-dev` свой файл и удалить с «Да» на данные —
   окно «Данные AI Dev не удалены…», папка цела.
8. **Подпись** (когда будет сертификат): `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD` в секретах прода → подписанный
   установщик, SmartScreen без предупреждения после набора репутации; обновление проверяет подпись.
9. **Упакованное приложение — те же экраны**, что фазы 10–11 (`docs/program/reports/phase-11.md`, раздел 8): подтверждения
   — системные окна Windows; NVDA проходит экраны.

**Для следующих фаз.**
- Фаза 14: README и INSTALL строятся вокруг трёх путей; установщик Windows — первый из них (сейчас — короткие
  разделы и ссылка на `docs/DESKTOP.md`). Версия 3.0.0 в `desktop/package.json` и пакете (D8) — к выпуску.
- Фаза 15: в `docs/RELEASE.md` — порядок выпуска установщика: тег `v*` в проде → черновик релиза с `.exe`,
  `.blockmap`, `latest.yml` → проверка по чек-листу → публикация (это и есть выкатка обновления установленным
  приложениям); секреты подписи.
- npm ставит `@img/sharp-wasm32` (с `@emnapi/runtime` и `tslib`, ~9 МБ) на всех системах как `extraneous` — у
  установщика срезано; для пакета и клона это особенность npm, не дефект кода (записи нет).
