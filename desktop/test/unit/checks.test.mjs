import assert from "node:assert/strict";
import test from "node:test";
import { ADVICE, checkTitle, orderedChecks, recommendation } from "../../src/renderer/checks.js";
import { MESSAGES, translate } from "../../src/renderer/i18n.js";

// The health checks a fresh install reports (system_status with checks, measured
// on this phase's code; the three it does not run left out).
const CHECK_NAMES = [
  "vault_root", "runtime_home", "required_notes", "search_index_file", "search_index_freshness", "frontend_qa_runner",
  "frontend_qa_environment", "security_scanners", "ui_ux_knowledge", "embedding_backend", "skill_registry", "skill_taxonomy",
  "skill_visual_graph", "skill_quality", "skill_routing_benchmark", "skill_outcomes", "skill_cards", "project_registry",
  "auto_commands", "search_presets"
];

const view = (language) => ({ t: (key, params) => translate(language, key, params) });

test("every piece of advice belongs to a real check and says something specific (Д-247)", () => {
  for (const [name, key] of Object.entries(ADVICE)) {
    assert.ok(CHECK_NAMES.includes(name), `${name} is a check`);
    for (const language of ["en", "ru"]) assert.ok(Object.hasOwn(MESSAGES[language], key), `${key} in ${language}`);
  }
  const indexMissing = { name: "search_index_file", status: "fail", critical: true };
  assert.equal(recommendation(view("en"), indexMissing), "Build the index: Setup → Search index.");
  assert.equal(recommendation(view("en"), { name: "embedding_backend", status: "skipped" }), "Install the local model: Setup → Local search model.");
  assert.match(recommendation(view("en"), { name: "something_new", status: "skipped" }), /Not set up/);
  assert.equal(recommendation(view("en"), { name: "vault_root", status: "ok" }), null);
});

test("each check has a name in both languages, and the order is failing first, the critical ones first of all", () => {
  for (const name of CHECK_NAMES) {
    assert.notEqual(checkTitle(name, view("ru").t), checkTitle(name), `${name} has a Russian name`);
  }
  assert.equal(checkTitle("search_index_file", view("en").t), "Search index");
  assert.equal(checkTitle("frontend_qa_runner"), "Frontend QA runner", "without words of the page, the dashboard's form");
  const ordered = orderedChecks([
    { name: "a", status: "ok" }, { name: "b", status: "warn" }, { name: "c", status: "fail" }, { name: "d", status: "skipped" }, { name: "e", status: "fail", critical: true }
  ]).map((check) => check.name);
  assert.deepEqual(ordered, ["e", "c", "b", "d", "a"]);
});
