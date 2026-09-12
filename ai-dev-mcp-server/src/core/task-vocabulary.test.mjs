import assert from "node:assert/strict";
import test from "node:test";
import {
  TASK_CONCEPTS,
  declaredStackTerms,
  expandTaskVocabulary,
  specialistMatchScore,
  stackAlignment,
  taskConcepts
} from "./task-vocabulary.mjs";

// The two skills Д-1 names, verbatim from the imported registry.
const TDD_WORKFLOW = {
  name: "tdd-workflow",
  use_when: "Use this skill when writing new features, fixing bugs, or refactoring code. Enforces test-driven development with 80%+ coverage including unit, integration, and E2E tests.",
  description: "Use this skill when writing new features, fixing bugs, or refactoring code. Enforces test-driven development with 80%+ coverage including unit, integration, and E2E tests.",
  categories: ["external", "testing-quality", "debugging"],
  languages: ["typescript", "javascript", "shell"],
  frameworks: ["react", "playwright", "github-actions", "redis"]
};
const HEXAGONAL = {
  name: "hexagonal-architecture",
  use_when: "introducing or refactoring toward Ports and Adapters, or when domain logic has become entangled with I/O",
  description: "Design, implement, and refactor Ports & Adapters systems with clear domain boundaries, dependency inversion, and testable use-case orchestration across TypeScript, Java, Kotlin, and Go services.",
  categories: ["external", "testing-quality"],
  languages: ["typescript", "java", "kotlin"],
  frameworks: ["spring"]
};

test("a Russian task names the concepts its English skills are written about", () => {
  assert.deepEqual(taskConcepts("настроить разработку через тесты"), ["tdd", "testing"]);
  assert.deepEqual(taskConcepts("отрефакторить по гексагональной архитектуре"), ["hexagonal", "refactor", "architecture"]);
  assert.ok(taskConcepts("проверить зависимости на уязвимости").includes("dependencies"));
  assert.ok(taskConcepts("развернуть в кубере").includes("container"));
  assert.deepEqual(taskConcepts(""), []);
  assert.deepEqual(taskConcepts(undefined), []);
  // "ё" is folded, so a task written either way matches.
  assert.deepEqual(taskConcepts("почини ретрай"), taskConcepts("почини ретрай"));
});

test("every concept carries a Russian trigger and English terms", () => {
  const ids = TASK_CONCEPTS.map((concept) => concept.id);
  assert.equal(new Set(ids).size, ids.length, "concept ids must be unique");
  for (const concept of TASK_CONCEPTS) {
    assert.ok(concept.ru instanceof RegExp, `${concept.id}: ru must be a regular expression`);
    assert.ok(concept.ru.flags.includes("i"), `${concept.id}: ru must be case-insensitive`);
    assert.ok(concept.en.split(/\s+/).length >= 4, `${concept.id}: en must list the synonyms a catalogue uses`);
    assert.equal(/[а-я]/i.test(concept.en), false, `${concept.id}: en is the English side`);
  }
});

test("the expansion keeps the task's own words apart from the translated ones", () => {
  const { concepts, terms, own_terms: own } = expandTaskVocabulary("настроить разработку через тесты", ["TypeScript", "Vite"]);
  assert.deepEqual(concepts, ["tdd", "testing"]);
  assert.ok(own.includes("typescript"), "the project stack is part of the task's own words");
  assert.ok(own.includes("тесты"));
  assert.equal(own.includes("coverage"), false, "a translated term is not one of the task's own words");
  assert.ok(terms.includes("coverage"));
  assert.ok(terms.includes("typescript"));
  assert.equal(terms.filter((term) => term.length <= 2).length, 0, "two-letter noise is dropped");
  assert.deepEqual(expandTaskVocabulary("").concepts, []);
});

test("an English task scores on its own words", () => {
  const { terms } = expandTaskVocabulary("set up test-driven development for the api layer");
  assert.ok(terms.includes("test-driven"));
  assert.ok(terms.includes("development"));
  assert.ok(specialistMatchScore(TDD_WORKFLOW, terms).use_when_hits >= 3);
});

test("the score is carried by the text that says when to use a skill", () => {
  const { terms } = expandTaskVocabulary("отрефакторить по гексагональной архитектуре");
  const hexagonal = specialistMatchScore(HEXAGONAL, terms);
  const tdd = specialistMatchScore(TDD_WORKFLOW, terms);
  assert.ok(hexagonal.score > tdd.score, `${hexagonal.score} should beat ${tdd.score}`);
  assert.ok(hexagonal.matched_terms.includes("adapters"));
  assert.ok(hexagonal.use_when_hits >= 3);

  // A name the task states outright counts, but only alongside the situation.
  const nameOnly = specialistMatchScore({ name: "hexagonal-architecture", use_when: "", description: "" }, terms);
  assert.ok(nameOnly.score > 0);
  assert.equal(nameOnly.use_when_hits, 0);
  assert.deepEqual(specialistMatchScore({}, terms), { score: 0, use_when_hits: 0, matched_terms: [] });
});

test("a skill's declared ecosystem is read from the task and the project, never from the translation", () => {
  assert.deepEqual(declaredStackTerms(TDD_WORKFLOW), ["typescript", "javascript", "shell", "react", "playwright", "github-actions", "redis"]);
  assert.deepEqual(declaredStackTerms({}), []);

  const agnostic = { name: "intent-driven-development", use_when: "clarify a feature" };
  assert.equal(stackAlignment(agnostic, expandTaskVocabulary("почини баг").own_terms), "agnostic");

  const typescriptProject = expandTaskVocabulary("настроить тесты", ["TypeScript", "Vite"]).own_terms;
  assert.equal(stackAlignment(TDD_WORKFLOW, typescriptProject), "aligned");
  assert.equal(stackAlignment({ languages: ["php"], frameworks: ["laravel"] }, typescriptProject), "foreign");

  // The `tdd` concept translates to "test-driven development", not to "react":
  // the English side of the table must not be able to claim an ecosystem.
  const noStack = expandTaskVocabulary("настроить разработку через тесты").own_terms;
  assert.equal(stackAlignment(TDD_WORKFLOW, noStack), "foreign");
});
