/**
 * The bridge between the words a task is written in and the words the imported
 * skill catalogue is written in.
 *
 * `recommend_skills` scores a registry entry by how much of the task text turns
 * up in the entry's `use_when`, description and taxonomy. That works for our own
 * skills, which are routed by name anyway, and fails completely for the 101
 * skills imported from ECC: their `use_when` is English, and the tasks this
 * server is asked to route are usually Russian. "настроить разработку через
 * тесты" and `tdd-workflow`'s "test-driven development" share no substring, so
 * the skill scored zero and never reached the answer (docs/ecc-upgrades/DEBTS.md,
 * Д-1).
 *
 * So the task is expanded before it is scored: a concept the task names in
 * Russian contributes the English terms the catalogue uses for the same thing.
 * This is a translation table, not a skill mapping — nothing here names a skill,
 * and a new imported skill benefits from it without an entry being added. An
 * English task needs no expansion and gets its own words back.
 */

/**
 * Concepts a task can name, in the words either language uses for them.
 *
 * `ru` matches the task; `en` is what gets added to the scoring query. The
 * English side deliberately lists the synonyms an imported catalogue is likely
 * to use ("test-driven", "coverage", "unit") rather than one canonical word,
 * because the score counts terms found, so breadth is what makes a specialist
 * skill outrank a merely adjacent one.
 */
export const TASK_CONCEPTS = Object.freeze([
  { id: "tdd", ru: /(через\s+тест|тест[- ]?драйв|\bтдд\b|сначала\s+тест|red[- ]?green|тест[а-я]*\s+первым)/i, en: "tdd test-driven development testing unit integration coverage red green refactor" },
  { id: "testing", ru: /(тест|покрыт|моки|фикстур|прогон[а-я]*\s+тест)/i, en: "test testing tests coverage unit integration e2e fixtures mocks" },
  { id: "hexagonal", ru: /(гексагональн|порт[а-я]*\s+и\s+адаптер|чист[а-я]*\s+архитектур|лукович|onion)/i, en: "hexagonal ports adapters clean architecture domain boundaries dependency inversion use-case orchestration" },
  { id: "refactor", ru: /(рефактор|переписа|упрост|разнест|вынест|привест[иь]\s+в\s+порядок|почист)/i, en: "refactor refactoring restructure extract cleanup dead code" },
  { id: "architecture", ru: /(архитектур|слоист|модульн|границ[а-я]*\s+модул|декомпозиц)/i, en: "architecture modules layers boundaries structure decomposition design patterns" },
  { id: "bug", ru: /(баг|ошибк|слом|падает|падают|почин|исправ|регресс|не\s+работает)/i, en: "bug error failure debug debugging regression fix root cause" },
  { id: "api", ru: /(эндпоинт|\bапи\b|контракт[а-я]*\s+апи|\brest\b|graphql|вебхук)/i, en: "api endpoint rest graphql contract openapi webhook request response schema" },
  { id: "database", ru: /(баз[а-я]*\s+данн|миграц|схем[а-я]*\s+(баз|данн)|индекс[а-я]*\s+таблиц|\bsql\b|запрос[а-я]*\s+к\s+баз)/i, en: "database migration schema sql index query transaction postgres" },
  { id: "security", ru: /(безопасн|уязвим|авториз|аутентификац|прав[а-я]*\s+доступ|угроз)/i, en: "security vulnerability authentication authorization permissions threat model owasp" },
  { id: "secrets", ru: /(секрет|токен|ключ[а-я]*\s+api|утечк|парол|credential)/i, en: "secret credentials token api key leak rotation vault" },
  { id: "dependencies", ru: /(зависимост|пакет[а-я]*\s+(npm|pip)|библиотек|обновл[а-я]*\s+верси|локфайл|lockfile)/i, en: "dependency dependencies packages supply chain audit lockfile sbom upgrade" },
  { id: "frontend", ru: /(фронт|интерфейс|верстк|компонент|экран|адаптив|стил[иь])/i, en: "frontend ui component layout screen responsive css" },
  { id: "design", ru: /(дизайн|оформлен|визуальн|макет|мокап|референс)/i, en: "design visual mockup reference style typography spacing" },
  { id: "landing", ru: /(лендинг|посадочн[а-я]*\s+страниц|конверси|оффер|призыв[а-я]*\s+к\s+действ)/i, en: "landing page conversion marketing cta hero pricing copy" },
  { id: "accessibility", ru: /(доступност|скринридер|скрин[- ]?ридер|контраст|клавиатурн)/i, en: "accessibility a11y wcag keyboard screen reader contrast aria" },
  { id: "performance", ru: /(производительн|скорост|медленн|оптимизац|нагрузк|тормоз|профил)/i, en: "performance latency throughput optimization profiling load benchmark web vitals" },
  { id: "deploy", ru: /(деплой|релиз|выкат|откат|сборочн[а-я]*\s+пайплайн|ci\/cd)/i, en: "deploy deployment release rollback ci cd pipeline github actions" },
  { id: "container", ru: /(контейнер|докер|kubernetes|кубер|образ[а-я]*\s+докер)/i, en: "container docker kubernetes image compose registry" },
  { id: "docs", ru: /(документац|описан[а-я]*\s+api|инструкц|\breadme\b|changelog)/i, en: "documentation docs readme changelog guide reference" },
  { id: "repository", ru: /(репозитор|онбординг|изучи[а-я]*\s+проект|подготов[а-я]*\s+проект|структур[а-я]*\s+проект)/i, en: "repository onboarding project structure codebase conventions bootstrap" },
  { id: "review", ru: /(ревью|пулл[- ]?реквест|\bпр\b|проверь\s+измен|аудит|код[- ]?ревью)/i, en: "review pull request diff audit code review feedback" },
  { id: "llm", ru: /(нейросет|промпт|эмбеддинг|векторн[а-я]*\s+поиск|языков[а-я]*\s+модел|\brag\b)/i, en: "llm prompt embedding vector search rag model provider tool calling evaluation" },
  { id: "data", ru: /(пайплайн[а-я]*\s+данн|поток[а-я]*\s+данн|\betl\b|импорт[а-я]*\s+данн|качеств[а-я]*\s+данн)/i, en: "data pipeline etl elt ingestion streaming lineage warehouse" },
  { id: "mobile", ru: /(мобильн|андроид|\bios\b|телефон|смартфон)/i, en: "mobile android ios swift kotlin app store" },
  { id: "observability", ru: /(логи|логгир|метрик|мониторинг|трейс|наблюдаем|алерт)/i, en: "logging metrics monitoring tracing observability alerting dashboards" },
  { id: "git", ru: /(ветк[аи]|коммит|мерж|конфликт[а-я]*\s+слиян|\bребейз\b)/i, en: "git branch commit merge conflict rebase worktree history" },
  { id: "errors", ru: /(обработк[а-я]*\s+ошиб|исключен|ретрай|повторн[а-я]*\s+попытк|таймаут)/i, en: "error handling exceptions retry timeout resilience failure modes" },
  { id: "concurrency", ru: /(асинхрон|параллельн|конкурент|очеред|воркер|корутин)/i, en: "async concurrency parallel queue worker goroutine coroutine locking" }
]);

/**
 * Concept ids a task names.
 *
 * @param {string} task
 * @returns {string[]}
 */
export function taskConcepts(task) {
  const text = String(task ?? "").normalize("NFKC").toLowerCase().replaceAll("ё", "е");
  if (!text.trim()) return [];
  return TASK_CONCEPTS.filter((concept) => concept.ru.test(text)).map((concept) => concept.id);
}

/**
 * The task's own words plus the English terms for every concept it names, ready
 * to score a registry entry against.
 *
 * @param {string} task
 * @param {string[]} [extra] - More text to fold in, such as the project stack.
 * @returns {{ concepts: string[], own_terms: string[], terms: string[] }}
 */
export function expandTaskVocabulary(task, extra = []) {
  const concepts = taskConcepts(task);
  const byId = new Map(TASK_CONCEPTS.map((concept) => [concept.id, concept]));
  const own = tokenize([String(task ?? ""), ...extra.map((item) => String(item ?? ""))].join(" "));
  const expanded = tokenize(concepts.map((id) => byId.get(id).en).join(" "));
  return { concepts, own_terms: own, terms: [...new Set([...own, ...expanded])] };
}

function tokenize(text) {
  const words = String(text ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("ё", "е")
    .split(/[^\p{L}\p{N}+.#-]+/u)
    .map((word) => word.replace(/^[-.]+|[-.]+$/g, ""))
    .filter((word) => word.length > 2);
  return [...new Set(words)];
}

/**
 * Languages and frameworks a skill declares it is for.
 *
 * @param {object} item
 * @returns {string[]}
 */
export function declaredStackTerms(item) {
  return [...(item?.languages ?? []), ...(item?.frameworks ?? [])]
    .map((token) => String(token ?? "").toLowerCase().trim())
    .filter(Boolean);
}

/**
 * Whether a skill's declared ecosystem is the one being worked in.
 *
 * `agnostic` — it names no language or framework, so it fits anywhere.
 * `aligned` — the task or the project names one of the ones it does.
 * `foreign` — it names ecosystems, and none of them came up.
 *
 * Only the task's and the project's own words count here, never the concept
 * expansion: otherwise the English synonyms chosen in {@link TASK_CONCEPTS}
 * would be deciding which ecosystem a repository is written in.
 *
 * @param {object} item
 * @param {string[]} ownTerms - `own_terms` from {@link expandTaskVocabulary}.
 * @returns {"agnostic" | "aligned" | "foreign"}
 */
export function stackAlignment(item, ownTerms) {
  const declared = declaredStackTerms(item);
  if (!declared.length) return "agnostic";
  const wanted = new Set(ownTerms);
  return declared.some((token) => wanted.has(token)) ? "aligned" : "foreign";
}

/**
 * How well a registry entry answers the expanded task, judged on the text that
 * says when to use it.
 *
 * `use_when` and the description carry the weight, because that is the sentence
 * a skill author writes about the situation the skill is for. Taxonomy fields
 * count for less: they are generated, and half the catalogue shares them. A
 * name the task states outright is worth a lot, but on its own it cannot make a
 * match — `reasons` stays empty unless the situation text matched, and callers
 * use that to refuse a name-only coincidence.
 *
 * @param {object} item - Registry entry.
 * @param {string[]} terms - From {@link expandTaskVocabulary}.
 * @returns {{ score: number, use_when_hits: number, matched_terms: string[] }}
 */
export function specialistMatchScore(item, terms) {
  const situation = `${item?.use_when ?? ""} ${item?.description ?? ""}`.toLowerCase();
  const taxonomy = [
    (item?.categories ?? []).join(" "),
    (item?.subgroups ?? []).join(" "),
    (item?.task_types ?? []).join(" "),
    (item?.frameworks ?? []).join(" "),
    (item?.languages ?? []).join(" ")
  ].join(" ").toLowerCase();
  const name = String(item?.name ?? "").toLowerCase().replaceAll("-", " ");
  const matched = [];
  let score = 0;
  let situationHits = 0;
  for (const term of terms) {
    let hit = false;
    if (situation.includes(term)) {
      score += 3;
      situationHits += 1;
      hit = true;
    }
    if (name.includes(term)) {
      score += 2;
      hit = true;
    }
    if (taxonomy.includes(term)) {
      score += 1;
      hit = true;
    }
    if (hit) matched.push(term);
  }
  return { score, use_when_hits: situationHits, matched_terms: matched };
}
