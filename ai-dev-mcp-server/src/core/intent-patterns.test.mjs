import assert from "node:assert/strict";
import test from "node:test";
import { INTENT } from "./intent-patterns.mjs";

test("intent patterns require complete Unicode tokens and explicit diagram phrases", () => {
  assert.equal(INTENT.diagram.test("Document the product architecture"), false);
  assert.equal(INTENT.diagram.test("Нарисуй схему взаимодействия сервисов"), true);
  assert.equal(INTENT.repository.test("A repository onboarding checklist"), true);
  assert.equal(INTENT.repository.test("Ship the product"), false);
  assert.equal(INTENT.container.test("Update the Helm chart"), true);
  assert.equal(INTENT.container.test("Fix the helmet size"), false);
  assert.equal(INTENT.highRisk.test("Улучши продвижение продукта"), false);
  assert.equal(INTENT.highRisk.test("Подготовь production deploy"), true);
});
