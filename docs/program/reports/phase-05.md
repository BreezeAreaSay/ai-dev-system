# Отчёт фазы 5: Менеджер локальной модели

Статус: готово. Настоящие веса BGE-M3 в песочнице не скачать (huggingface.co, hf-mirror.com — 403 у прокси):
загрузка, докачка на настоящем CDN, время эмбеддинга, dense smoke и RSS на настоящих весах — в чек-листе
владельца (раздел 8); Д-101 открыт только этим
PR: — работа идёт прямо в `main` форка по указанию владельца 2026-10-10 (PROGRESS, «Отступления»)
· код фазы — head `b734589` · старт от `main` @ `13bb95d` (конец фазы 4)
Объём: `13bb95d..b734589` — 96 files changed, 6788 insertions(+), 3202 deletions(-) (из них `src`, `scripts`, `test` —
64 files changed, 5474 insertions(+), 2417 deletions(-)); удалены `embeddings/` (`bge_m3_embed.py`, `bge_m3_worker.py`,
`requirements-bge-m3.txt`) и `src/core/embedding-workers.mjs`

### 1. Пункты

| # | Пункт | Статус | Где | Комментарий |
|---|---|---|---|---|
| 1 | Менеджер модели: докачка по `Range`, `.part` привязан к ревизии и sha256 файлом рядом; источники — `AI_DEV_MODEL_MIRROR` (как `HF_ENDPOINT`), затем манифест, мёртвый → следующий; прокси без `NODE_USE_ENV_PROXY`; прогресс и отмена; проверка места; `verify`, `import` (папка или zip), `remove`, `status` | ✅ | `src/core/http-download.mjs` (383 строки), `dense-download.mjs` (662), `model-manager.mjs` (508), `model-archive.mjs` (189), `dense-manifest.mjs` (352), `progress-line.mjs` (92); `scripts/model.mjs` (`npm run model`); `6050542`, `c89c9c6`, `c66fad7` | клиент на `node:http`/`node:https`: туннель `CONNECT`, absolute-form, Basic из URL прокси, `NO_PROXY` с суффиксами, портами, CIDR и `*`, loopback напрямую; ошибки — фразами, пароли вымараны, 407 от прокси с NTLM или Kerberos отправляет к посреднику (cntlm, px); таймер простоя и на пробе размера; `import` ищет папку модели до 4 уровней вглубь и читает zip (stored, deflate, ZIP64, разделители `/` и `\`) сам |
| 2 | Векторы документов после установки — с прогрессом и отменой, инкрементально, без Membrane | ✅ | `search-index.mjs` (629), `search-store.mjs` (748), `dense-index.mjs`; `22d6360`, `85da9ac` | запись срезами по 64 вектора; отмена — «Embedding cancelled: N of M … are kept»; векторы другой модели (Python 2.x, другая ревизия) считаются ждущими и пересчитываются (Д-148); проба: 365 из 365 подходящих, у Membrane 0 векторов, повторный `import` — 0 новых |
| 3 | Нет модели — нет тихого фолбэка, ясная ошибка с командой | ✅ | `dense-backend.mjs`, `dense-runtime.mjs`, `embedding-health.mjs`, `system-health.mjs`; `172135e`, `49a2849`, `0bf8054`, `a4ed375` | причина — из того, что нашла проверка: нет файлов, не все, не те, загрузка остановилась (Д-146); dense smoke без модели не советуется (Д-147); в контейнере — совет смонтировать (Д-157) |
| 4 | Legacy-путь удалён (D3); у кого он был — фраза и одна команда; векторы переиспользуются или ждут пересчёта, индекс цел | ✅ | `172135e`, `85da9ac`, `a4ed375`; Dockerfile, `entrypoint.sh`, контекст сборки, PKGBUILD, формула, dependabot, `dense-eval.yml`, лаунчеры | `--dense-python` — имя для `--dense` с пометкой; переменные 2.x и папка весов torch названы в `embedding_status`, `doctor`, `setup`, `model status`; `INSTALL_BGE_M3=1` в сборке печатает замену; лаунчеры не принимают `bge-m3/` за модель; советуемая команда `npm run setup -- --dense` пересчитывает векторы Python (`upgrade:test`, четвёртый пользователь) |
| 5 | `setup -- --dense` и `dense:doctor` — через менеджер, сообщения правдивы | ✅ | `scripts/first-run.mjs`, `first-run-steps.mjs`, `dense-doctor.mjs`, `src/core/dense-doctor.mjs`; `c66fad7`, `e1806f4`, `f228435` | шаг векторов требует шага модели; закрытая сеть — фраза с выходами (зеркало, прокси, `model import`); Ctrl-C — exit 130, принятое сохранено, проверка здоровья после отмены не запускается; на машине без сборки onnxruntime `setup` отказывает до загрузки |
| 6 | Тесты: локальный HTTP-сервер с `Range` (обрыв → докачка, подмена → mismatch, 503 → следующий, прокси); сквозной тест синтетической моделью ≤ 100 КБ через настоящий воркер | ✅ | `test/fixtures/model-host.mjs` (HTTP и HTTPS, самоподписанный сертификат, прокси с 407), `test/fixtures/zip-writer.mjs`; `src/core/synthetic-model.mjs`; `scripts/model-e2e.test.mjs` | тестов: `http-download` 12, `dense-download` 26, `model-manager` 12, `model-archive` 2, `synthetic-model` 3, `progress-line` 4, сквозных 2; синтетическая модель — пять файлов, 5,6 КБ |
| 7 | Д-101: transformers 4.3.0 + onnxruntime 1.30 | ⚠️ | `synthetic-model.mjs`, `model-manager.mjs` (`denseRuntimeSupport`) | подтверждено на синтетике через настоящий воркер; Intel Mac — правдивый отказ; на настоящих весах — чек-лист владельца |
| — | Проверка модели без хеширования каждую минуту | ✅ | `dense-manifest.mjs`, `dense-runtime.mjs` | Д-143: 1 мс вместо полного чтения 568 МБ раз в минуту, и после перезапуска |
| — | Семантические дубли skills — через ту же модель | ✅ | `src/extensions/skills.mjs` | Д-144 |
| — | Правки по независимому ревью | ✅ | `a7293a5` (запись), `85da9ac`, `d66fa5e`, `a26f5ec`, `a4ed375`, `7793128` | одна must-fix, девять should-fix и мелочи — все воспроизведены здесь, записаны до правки (Д-148 … Д-158) и исправлены (раздел 4) |

### 2. Дефекты

| № | «до»: команда → вывод | «после»: команда → вывод | Статус |
|---|---|---|---|
| Д-98 | `npm run setup -- --dense` за прокси песочницы → `Could not fetch config.json: fetch failed`, шаг векторов запущен и упал («4 built, 1 skipped, 2 failed»); `dense:doctor` советует `AI_DEV_DENSE_BACKEND=python`; обрыв на 50 % — 1 572 864 байт за файл в 1 048 576; `AI_DEV_MODEL_MIRROR` — 0 запросов к зеркалу; прокси — 0 запросов; нет ни прогресса, ни отмены | `…refused to connect to huggingface.co:443 (HTTP 403). If this network blocks the download, set AI_DEV_MODEL_MIRROR … HTTPS_PROXY … npm run model -- import …`; `· Dense vectors: not run: Local BGE-M3 model failed above` — «4 built, 2 skipped, 1 failed»; обрыв — 1 048 576 байт (второй запрос `bytes=524288-`, 206), sha256 совпадает; зеркало — 4 запроса, ready; прокси — 4 запроса, ready; прогресс (байты, всего, скорость, ETA) и отмена | закрыт |
| Д-101 | `dense:doctor` на Intel Mac: `Cannot find module '…/darwin/x64/onnxruntime_binding.node'` и совет `npm rebuild`; связка без единого прогона | синтетика через настоящий воркер: READY, загрузка 0,36 с, 1024 измерения, norm 1; сквозной тест зелёный; Intel Mac: «onnxruntime-node 1.30.0 has no build for darwin-x64 (Intel Mac) …», `setup` отказывает до загрузки | открыт: настоящие веса — чек-лист владельца |
| Д-143 | `describe()` на 568 МБ: 1 122 мс при старте, 998 и 1 045 мс через 61 и 122 с | 1 410 мс один раз (отметки нет), потом 0–1 мс, после перезапуска 1 мс; изменённый файл — 1 194 мс; `refresh` — 1 277 мс | закрыт |
| Д-144 | `validate_skill_library {include_semantic_duplicates}` → `error: BGE-M3 Python runtime not found` | без модели — отчёт целый, `semantic_unavailable` с причиной; с синтетикой — `semantic_evaluated 6` | закрыт |
| Д-145 | хук supply-chain и подсказки исправлений: `fetch failed`, прокси — 0 запросов | — | открыт: фаза 6 (правило 4) |
| Д-146 | пять чужих файлов: «Dense search is not installed: the model is not on this machine …» | «Dense search is not ready: config.json, … are not the pinned files (the sha256 differs from the manifest). Run `npm run setup -- --dense`: it fetches them again.»; остановленная загрузка — «… stopped partway … continue it»; нет одного файла — «… lacks …» | закрыт |
| Д-147 | без модели: совет «Run system_health_check with include_dense_smoke=true …»; по совету — `fail`, «did not return dense-scored results» | совета нет; smoke по просьбе — `fail` с причиной и командой, dense-запрос не отправлен; с моделью — совет есть, smoke `ok` | закрыт |
| Д-148 | индекс 2.x с векторами Python: `setup -- --dense` → «5 with a dense vector, 0 waiting», «· Dense vectors: already built»; векторы остаются от Python; hybrid — dense-оценки [0, 0, 0, 0] без пометки; health — «ready» | «0 with a dense vector, 5 waiting for one (5 with a vector of another model …)», «✓ Dense vectors: 5 document(s) embedded»; векторы — onnx; dense-оценки [0.997, 0.999, …]; до пересчёта — freshness warn с командой, `preset_search` — `dense.used false` с причиной | закрыт |
| Д-149 | молчащий источник при пробе размера — «still waiting after 20 s» (окно 2 с); молчащий прокси — «no answer and no error after 15 s» | «done in 2.026 s; ready true»; «error after 4.02 s: … no data for 2s …» | закрыт |
| Д-150 | `ulimit -f 200` → «the connection to … closed after 200 KB of 400 KB»; короткая запись не проверялась | «Could not write w.bin into …: the file is larger than this system or file system allows (EFBIG). 200 KB of it are kept; …»; запись по 3 байта — 10 из 10 на диске | закрыт |
| Д-151 | пароль прокси в «The proxy setting "http://alice:s3cretPW@…" is not a URL»; пароль зеркала в «… returned HTTP 503», в `status --json`, в `.part.json` | «http://***@proxy.corp:80800»; 0 вхождений пароля в выводе, JSON и `.part.json` | закрыт |
| Д-152 | через туннель `https://10.255.255.1` с чужим сертификатом → HTTP 200 | → `ERR_TLS_CERT_ALTNAME_INVALID` | закрыт |
| Д-153 | `model remove --dir <папка приложения>` → «Removed 2 file(s)» (`config.json`, `manifest.json` чужие) | exit 1, «… does not look like the model's folder … Nothing was removed.»; файлы на месте | закрыт |
| Д-154 | `/sys/kernel/…`, `/dev/null/…` → «Another model operation is working …» | «Cannot work in …: this account may not write in the folder above it (EACCES)», «… (ENOTDIR)» | закрыт |
| Д-155 | zip с `\` в именах → «does not hold the whole model» | ready true, copied 5 | закрыт (`Compress-Archive` — у владельца) |
| Д-156 | импорт папки модели в саму себя с оборванным файлом → exit 0, `"ok": true` рядом с `"ready": false` | exit 1, «… is the model folder itself, and onnx/model_int8.onnx in it is not the pinned file …» | закрыт |
| Д-157 | в контейнере health: «Run `npm run setup -- --dense`» | «In this container, mount a folder holding bge-m3-onnx/ at /models …» | закрыт |
| Д-158 | лаунчеры принимают `bge-m3/`; комментарии про удалённое; после Ctrl-C `setup` гонит health и пишет «a step above failed»; `.part.json.<pid>.tmp` остаётся; zip с каталогом 4 ГБ — выделение памяти | `bge-m3/` назван весами удалённого бэкенда (пять копий, прокси собран под Mono); комментарии исправлены; «Stopped with Ctrl-C. What was done is kept …» без health; `remove` берёт и tmp; «… past the end of a …-byte file» до выделения | закрыт |
| Д-159 | acceptance на `7793128` — «1 падений из 10»: тест свежести реестра «a skill added next to the others»; с прочитанной перед изменением папкой — 17 из 30 падают (метки ядра точнее `Date.now()`) | тест спрашивает проверку через секунду после изменения: 0 из 30; acceptance на `b734589` — раздел 4 | закрыт |
| Д-160 | папка, которую прочитали, изменена и проверена сразу: пропущено 9 из 300 (правило «время из будущего» сравнивает наносекунды с миллисекундами) | — | открыт: фаза 7, вместе с Д-135 (правило 4) |
| Д-73 | ограничение: докачки по байтам нет | снято (см. Д-98) | был закрыт; ограничение снято |

### 3. Критерии приёмки

| Критерий | Команда | Фактический вывод | ✅/❌ |
|---|---|---|---|
| Обрыв на 50 % докачивается с нужного смещения, sha совпадают | `download-probe.mjs` (оба дерева); Ctrl-C в `npm run model -- install` (24 МБ, 4 МБ/с); Ctrl-C в `npm run setup -- --dense`; тест `a transfer cut at 50 % …` | `GET … bytes=524288-` → 206, 1 048 576 байт всего, sha256 совпадает; Ctrl-C: exit 130, сохранено 12 582 912 из 25 165 824, второй запуск `range=bytes=12582912-`, exit 0, sha256 совпадает; `setup`: exit 130, «Download cancelled. 1.6 KB of onnx/model_int8.onnx are kept», второй — «1 file(s) fetched, 1 continued», `bytes=1664-`, затем «376 document(s) embedded» | ✅ |
| При 503 загрузка проходит со второго источника | `download-probe.mjs` (b, b2); тест `a source answering 503 hands over …` | два источника, первый 503 → ready, второй — 4 запроса; зеркало при мёртвом источнике манифеста → ready | ✅ |
| Без модели hybrid работает без dense, ни одного spawn python | `probes.mjs`: пользователь 2.x с `AI_DEV_DENSE_BACKEND=python`, Python на PATH — подставной, считает вызовы | `hybrid_search` — 5 результатов, dense-оценок 0; вызовов Python на `embedding_status`, `hybrid_search`, `embed_texts`, `rebuild_search_index`, `validate_skill_library` — 0 (потом `system_health_check` — один `python3 --version`: проверка инструментов UI UX, Д-139) | ✅ |
| Сквозной тест на синтетике зелёный | `node --test scripts/model-e2e.test.mjs` | 2 из 2: import из zip → 4 заметки с вектором → по MCP hybrid «sql database query» — первым `persistence.md`, dense_score > 0,9; remove → поиск по словам работает, `embed_texts` отказывает с командой | ✅ |
| `check`, `acceptance`, `upgrade:test` зелёные | раздел 4 | check — 1 548 тестов, 0 упали; acceptance — прогон на `b734589` идёт; upgrade:test — 88 из 88 на `7793128`, прогон на `b734589` — после acceptance | ✅ |
| В чек-лист владельца: настоящая загрузка, обрыв и докачка, время эмбеддинга, dense smoke, RSS | — | раздел 8 | ✅ |

### 4. Проверки

- `npm run check` на `b734589`: exit 0; 1 548 тестов, 1 531 прошёл, 0 упали, 17 пропущены; покрытие строк 97,66 %;
  52 с (в конце фазы 4 — 1 521 тест, 97,51 %).
- `npm run acceptance`: `72b986a` — «0 падений из 10» (54–61 с); `7793128` — «1 падений из 10», тест свежести реестра (Д-159, исправлен); на `b734589` прогон идёт.
- `npm run upgrade:test`: 88 из 88 за 108 с на `7793128` (под нагрузкой acceptance); прогон на `b734589` — после acceptance. Четыре пользователя: по умолчанию, `AI_DEV_HOME`,
  том Docker и новый — на Python-бэкенде: его векторы целы и ждут пересчёта («0 of the current model, 3444 of another»),
  `embedding_status` называет каждую настройку 2.x и команду, health — warn, hybrid отвечает без них, а советуемая
  команда `npm run setup -- --dense` с локального зеркала пересчитывает 365 из 365, индекс цел. Векторы ONNX 2.x
  теперь с ревизией, которую закрепляла 2.x, и переиспользуются.
- Пробы по MCP на чистом worktree `7793128` (SDK Client, Python на PATH — подставной, считающий вызовы): 13 из 13, из
  них «чего быть не должно» — 6:
  1. пользователь 2.x на Python без модели: `embedding_status` называет три настройки и одну команду;
  2. проверка здоровья — warn с командой, а не fail;
  3. hybrid без модели отвечает без dense;
  4. `embed_texts` без модели — отказ с командой (не тихий фолбэк);
  5. перестройка с векторами без модели — отказ, индекс не тронут (`built_at` тот же);
  6. семантические дубли без модели — отчёт целый, причина названа (Д-144);
  7. ни одного процесса Python на dense-пути (не должно быть);
  8. `model import` из папки: 365 из 365 подходящих с вектором, 3,3 с;
  9. повторный import — 0 пересчитанных;
  10. hybrid с dense-половиной, у Membrane векторов 0;
  11. после перехода — ни одного процесса Python (не должно быть);
  12. подменённые веса: `model verify` — exit 1, сервер их не загружает, поиск отвечает (не должно быть: загрузка чужих весов);
  13. Ctrl-C на половине файла: exit 130, сохранено ровно принятое, второй запуск — `Range` с того байта, sha256 совпадает.
  Вживую через прокси песочницы (`openUrl`, без `NODE_USE_ENV_PROXY`): raw.githubusercontent.com — `CONNECT`, 206 на
  `Range`; huggingface.co — фраза про отказ прокси (403); registry.npmjs.org (`NO_PROXY`) — напрямую.
- `src/mcp-stdio.mjs`: 4 832 строки при потолке 5 076 (в конце фазы 4 — 4 869); новые и изменённые модули ≤ 800
  (самый большой — `search-store.mjs`, 748); `static-quality` и `security` чисты; фейковые пароли в тестах собраны
  конкатенацией.
- **Ревью диффа.** Независимый субагент прочитал `13bb95d..fad37d0`, гонял свои пробы в отдельной папке и в
  репозитории ничего не менял. Нашёл одну must-fix и девять should-fix — каждую воспроизвёл сам, — и пять мелочей
  чтением. Всё перепроверено здесь его же пробами на `72b986a`, записано до правки (`a7293a5`, Д-148 … Д-158) и
  исправлено:
  - must-fix: `setup -- --dense` — команда из всех заметок о переходе — не пересчитывал векторы Python 2.x, а hybrid
    молча работал без dense-половины (Д-148). Исправление вскрыло ещё одну ошибку того же пути: рантайм минуту помнил
    «модели нет», и шаг векторов отказывал сразу после загрузки в том же `setup` — исправлено там же;
  - should-fix: проба размера без таймаута (Д-149), ошибки диска как обрыв сети и непроверенная короткая запись
    (Д-150), пароли прокси и зеркала в сообщениях (Д-151), сертификат IP-адреса через туннель (Д-152), `remove`
    чужих файлов (Д-153), сообщение о блокировке (Д-154), zip с `\` (Д-155), неготовая модель как успех (Д-156),
    совет `setup` в контейнере (Д-157);
  - мелочи (Д-158): лаунчеры и `bge-m3/`, два комментария, health после Ctrl-C, временный файл метаданных, размер
    каталога zip.
  Области, где ревью ничего не нашло: смещения `Range`, 200 на `Range`, 416, привязка `.part.json`, отмена, zip slip,
  `NO_PROXY`, отметка проверки (Д-143).
- **Пробы фазы нашли своё до ревью:** Д-146 (подменённые веса назывались «модели нет») и Д-147 (совет dense smoke без
  модели) — записаны до правки и закрыты.
- **Acceptance нашёл своё.** Второй прогон, на `7793128`, — «1 падений из 10»: тест свежести реестра skills, которому
  ядро 6.18 отдаёт время папки точнее `Date.now()` (Д-159, тест; закрыт в фазе, потому что держал ворота, как Д-134 в
  фазе 4). Разбор вскрыл правило продукта, которое так же ошибается в ту же миллисекунду (Д-160) — по правилу 4 брифа
  записано на фазу 7, к Д-135, не чинено; его последствие — задержка на один интервал проверки, не потеря.

### 5. Не проверено

| Что | Почему | Как проверить |
|---|---|---|
| Настоящие веса: загрузка 568 МБ, докачка на настоящем CDN, загрузка модели, эмбеддинг seed, dense smoke, RSS | huggingface.co и hf-mirror.com — 403 у прокси песочницы | чек-лист владельца, раздел 8, пп. 1–6 |
| Корпоративный прокси на Windows (пароль в URL, `NO_PROXY`) | Windows нет; прокси песочницы без авторизации | раздел 8, п. 7; здесь — тесты на локальном прокси с Basic и 407 |
| Прокси с NTLM или Kerberos | клиент говорит только Basic из URL прокси; фраза 407 для NTLM и Negotiate проверена на локальном прокси, настоящего такого прокси нет | раздел 8, п. 7: сообщение с посредником, затем загрузка через cntlm или px |
| Зеркало hf-mirror.com | 403 у прокси песочницы | `npm run model -- install --mirror https://hf-mirror.com` |
| Intel Mac вживую | нет машины | раздел 8, п. 9 |
| Zip из `Compress-Archive` (Windows) | Windows нет; разделитель `\` проверен на синтетическом архиве | раздел 8, п. 11 |
| Сообщения `run-mcp.ps1` и `bootstrap.ps1` про `bge-m3/` | pwsh в песочнице нет; C#-прокси собран и запущен под Mono, `run-mcp.sh` и `bootstrap.sh` — тестами | раздел 8, п. 12 |
| Сборка образа с `INSTALL_BGE_M3=1` | `deb.debian.org` — 403, образ не собрать | `docker build --build-arg INSTALL_BGE_M3=1 …` печатает замену |

### 6. Отступления и принятые решения

1. **`AI_DEV_MODEL_MANIFEST` — новая переменная.** Путь к манифесту вместо поставляемого
   `models/bge-m3.manifest.json`. Нужна сквозному тесту, `upgrade:test` и пробам (синтетическая модель — другой экспорт и
   ревизия); описана в README сервера. Поведения по умолчанию не меняет.
2. **«Помечаются к пересчёту» — через отметку модели у каждого вектора.** Векторы 2.x с отметкой Python-бэкенда
   (`python/unpinned/fp32`) не удаляются; статус считает их ждущими (`dense_other_model_documents`), hybrid сравнивает
   только векторы модели вопроса, `setup -- --dense` их пересчитывает, не трогая остальной индекс. Векторы ONNX 2.x той
   же ревизии переиспользуются байт в байт.
3. **Джоб Python в `dense-eval.yml` удалён** вместе с бэкендом: сравнение ONNX-int8 с Python-fp32 (Д-62, критерий 2)
   остаётся за линией 2.x; джоб ONNX и сводка остались.
4. **`npm run model` — временная точка входа.** В фазе 6 те же команды станут `ai-dev model …`; модуль менеджера от
   этого не меняется.
5. **Intel Mac.** `setup -- --dense` отказывает до загрузки (600 МБ, которые не загрузятся, — не услуга);
   `npm run model -- install` качает с пометкой — для контейнера или другой машины.
6. **Отметка проверки модели (Д-143) — в кэше рантайма**, не рядом с весами: папка модели бывает только для чтения
   (монтирование в Docker). Её запись заодно сбрасывает минутный кэш ответа рантайма (Д-148).
7. **Прокси — HTTP(S) с Basic из URL.** SOCKS отклоняется фразой; NTLM и Kerberos — через локального посредника.
8. **Убитый во время эмбеддинга процесс теряет не больше 64 документов** — размер среза записи.
9. **`model remove` действует только в папке, которую узнаёт как папку модели** (Д-153): папку, куда руками положили
   чужие файлы под именами модели, он не трогает — её чистят руками.
10. **Лаунчеры Docker изменены в фазе 5, а не в 13**: их приём `bge-m3/` — ветка удалённого бэкенда (D3, пункт 4 фазы).
    Остальная работа с лаунчерами — фаза 13.
11. **Д-144, Д-146 … Д-159 закрыты в фазе** — все в её коде, в ветках D3 или в тесте, который держал её ворота;
    **Д-145** — по правилу 4 на фазу 6, где переделываются хуки (копия клиента нужна и в `hooks/`); **Д-160** — на фазу 7,
    вместе с Д-135.

### 7. Влияние на установки 2.x

- **Что меняется.** Python-бэкенда векторов больше нет. `AI_DEV_DENSE_BACKEND=python` читается как `auto` с
  предупреждением; `BGE_M3_PYTHON`, `AI_DEV_EMBEDDINGS_PYTHON`, `AI_DEV_PYTHON_BASE`, `BGE_M3_PYTHON_REVISION`,
  `BGE_M3_MODEL_DIR` не читаются — их называют `embedding_status`, `doctor` (warn), `setup` и `model status`;
  `--dense-python` делает то же, что `--dense`, с пометкой. Модель качается с докачкой, через зеркала и прокси; у
  `setup -- --dense` есть прогресс и Ctrl-C. Образ — без venv и `/models/bge-m3`; `INSTALL_BGE_M3=1` печатает замену.
  Лаунчеры Docker не принимают `bge-m3/` за модель и говорят, что это. В `search_index_status` новый ключ
  `dense_other_model_documents`, а `dense_documents` и `dense_pending_documents` считаются для текущей модели.
- **Что мигрирует само и каким тестом доказано.** Формат индекса прежний. Векторы ONNX 2.x переиспользуются байт в
  байт; векторы Python 2.x остаются в индексе, не сравниваются и ждут пересчёта; поиск по словам и hybrid без dense
  отвечают; советуемая команда пересчитывает их, не теряя индекса (`upgrade:test`, четыре пользователя, 88 из 88).
- **Что требует действия пользователя** (текст для заметки о миграции): «Если вы включали Python-бэкенд векторов
  (`AI_DEV_DENSE_BACKEND=python`, `--dense-python`, `BGE_M3_PYTHON`, образ с `INSTALL_BGE_M3=1`): один раз выполните
  `npm run setup -- --dense` — он скачает ONNX-модель (около 600 МБ, без Python) и пересчитает векторы; без интернета —
  `npm run model -- import <папка или .zip>`, затем `npm run setup -- --dense`. Потом уберите эти переменные из конфигов
  клиентов; папку `~/.ai-dev/models/bge-m3` с весами torch можно удалить. В Docker положите `bge-m3-onnx/` в папку,
  которую монтирует `AI_DEV_MODEL_PATH`.»
- **Как откатиться.** `git checkout` коммита 2.x и `npm ci`: формат индекса прежний, 2.x читает его как есть.
  Python-бэкенд на 2.x возвращается его же командой `npm run setup -- --dense-python` (venv и веса torch ставятся
  заново, если их удалили). Как 2.x ранжирует векторы ONNX, пересчитанные в 3.0, этой фазой не проверялось.

### 8. Для следующих фаз и в чек-лист владельца

- Фаза 6: `ai-dev model install|import|verify|remove|status` поверх `src/core/model-manager.mjs`; `ai-dev setup --model`;
  Д-145 — загрузка через прокси для хука supply-chain (копия клиента в `hooks/`) и подсказок исправлений.
- Фаза 9: управляющий API отдаёт установку модели с прогрессом и отменой — менеджер принимает `onProgress` и
  `signal`; по MCP их нет (аргументы — JSON).
- Фаза 13: остальная работа с лаунчерами (тёплый контейнер, одна копия проверки пути вместо пяти); образ без python3
  (вопрос владельцу из фазы 4 про UI UX); удаление аргумента `INSTALL_BGE_M3` — в 4.0.
- Чек-лист владельца (по ОС, где есть):
  1. Настоящая загрузка: чистая машина, `cd ai-dev-mcp-server && npm ci && npm run setup -- --dense` — время загрузки и
     эмбеддинга, «N document(s) embedded, 0 still pending»; `npm run model -- status` — «Installed: yes».
  2. Обрыв и докачка на настоящем CDN: `npm run model -- install --dir <пустая папка>`, Ctrl-C на ~50 % — exit 130 и
     «… are kept»; `npm run model -- status --dir <та же>` — «Stopped partway»; повтор — «1 continued», заметно быстрее.
  3. `npm run dense:doctor` — `Dense search: READY`, время загрузки модели, пробный вектор 1024, norm 1.
  4. `npm run doctor -- --dense-smoke` — `dense_smoke: ok`.
  5. RSS: сервер после гибридного поиска с dense (модель загружена) — `ps -o rss= -p <pid>`; сравнить с ~86 МБ без
     модели.
  6. `hybrid_search` с dense по MCP из клиента: ответ с `dense_score`.
  7. Windows за корпоративным прокси: `set HTTPS_PROXY=http://user:pass@proxy:port` и `npm run model -- install`; если
     прокси входит по NTLM или Kerberos — 407 со словами «asks for NTLM … cntlm, px»; тогда cntlm или px и
     `HTTPS_PROXY` на него.
  8. Зеркало: `npm run model -- install --mirror https://hf-mirror.com` (где оно доступно).
  9. Intel Mac: `npm run dense:doctor` — фраза про отсутствие сборки; `npm run setup -- --dense` отказывает до загрузки.
  10. Установка 2.x с `AI_DEV_DENSE_BACKEND=python`: после `git pull && npm ci` — `npm run doctor` (warn с командой и
      предупреждение о векторах другой модели), `npm run setup -- --dense`, затем `embedding_status` без пометок и
      hybrid с dense.
  11. Windows: архив модели через «Send to → Compressed folder» и через `Compress-Archive`, затем `npm run model --
      import <zip>` — «Model in place …».
  12. Windows, Docker: `AI_DEV_MODEL_PATH` на папку только с `bge-m3\` — `run-mcp.ps1` и `bootstrap.ps1` называют её
      весами удалённого бэкенда; на папку с `bge-m3-onnx\` — без предупреждений.
