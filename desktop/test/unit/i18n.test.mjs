import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LANGUAGES, MESSAGES, pickLanguage, translate } from "../../src/renderer/i18n.js";

const renderer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test("Russian and English have the same keys and the same placeholders", () => {
  assert.deepEqual(LANGUAGES, ["en", "ru"]);
  const english = Object.keys(MESSAGES.en).sort();
  assert.deepEqual(Object.keys(MESSAGES.ru).sort(), english);
  for (const key of english) assert.deepEqual(placeholders(MESSAGES.ru[key]), placeholders(MESSAGES.en[key]), key);
  for (const key of english) assert.notEqual(MESSAGES.ru[key].trim(), "", key);
});

test("every key the code names is in the table", () => {
  const sources = [];
  const walk = (folder) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(m?js|html)$/.test(entry.name) && entry.name !== "i18n.js") sources.push(fs.readFileSync(file, "utf8"));
    }
  };
  walk(renderer);
  const keys = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/\bt\("([a-z][\w.]+)"/g)) keys.add(match[1]);
    for (const match of source.matchAll(/data-i18n="([\w.]+)"/g)) keys.add(match[1]);
  }
  assert.ok(keys.size > 40, `${keys.size} keys found`);
  const missing = [...keys].filter((key) => !Object.hasOwn(MESSAGES.en, key));
  assert.deepEqual(missing, []);
});

test("the language: a stored choice of ours, else the system's, else English; placeholders filled", () => {
  assert.equal(pickLanguage("ru", "en-US"), "ru");
  assert.equal(pickLanguage("", "ru-RU"), "ru");
  assert.equal(pickLanguage("de", "de-DE"), "en");
  assert.equal(pickLanguage(undefined, undefined), "en");
  assert.equal(translate("ru", "tray.rebuilding", { percent: 7 }), "Перестройка индекса… 7%");
  assert.equal(translate("en", "no.such.key"), "no.such.key");
  assert.equal(translate("xx", "app.title"), "AI Dev");
  assert.equal(translate("en", "common.error", {}), "Something went wrong: {message}", "an unknown placeholder stays visible");
});
