#!/usr/bin/env node
/**
 * `npm run verify:cursor` — what a person with a real Cursor has to check.
 *
 * This adapter was written against secondary sources, because the sandbox it
 * was built in cannot reach cursor.com (Д-2). Three of its statements therefore
 * stand unverified, and no amount of code here settles them: each is five
 * minutes in front of the editor. The steps and what to look for come from the
 * contract in `src/core/agent-hooks.mjs`, so they cannot drift from it.
 */
import process from "node:process";
import { CURSOR_HOOKS_CONTRACT, cursorVerificationPlan } from "../src/core/agent-hooks.mjs";

const plan = cursorVerificationPlan();
const lines = [
  "Cursor hooks: what this install could not verify",
  "",
  `Contract targeted: .cursor/hooks.json version ${CURSOR_HOOKS_CONTRACT.version}, reconstructed on ${CURSOR_HOOKS_CONTRACT.verified_on} from:`,
  ...CURSOR_HOOKS_CONTRACT.sources.map((source) => `  - ${source}`),
  "",
  plan.unverified.length
    ? `Unverified claims: ${plan.unverified.join(", ")}. Everything below takes about five minutes each.`
    : "Every claim in the contract is verified.",
  ""
];
plan.steps.forEach((step, index) => {
  lines.push(`${index + 1}. [${step.claim}] ${step.question}`);
  step.how.forEach((instruction) => lines.push(`   - ${instruction}`));
  lines.push(`   → ${step.expected}`);
  lines.push("");
});
lines.push("Record what you saw in docs/ecc-upgrades/DEBTS.md under Д-2 — a claim checked and");
lines.push("not written down is a claim nobody else can rely on.");
console.log(lines.join("\n"));
process.exitCode = 0;
