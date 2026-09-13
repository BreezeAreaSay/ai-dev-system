---
name: grill-me
description: The intent gate. Use when a request could mean two different things, and before any substantive repository work: stress-test the request with the grilling interview until the design tree has no open branches, then open the task. Skip only for a request whose scope is one obvious edit.
---

# Grill Me

Most bad changes are not bad code. They are a correct implementation of a request nobody
checked. This gate runs before the work, and it is the first thing the
`ai-dev-orchestrator` protocol asks for.

The interview technique is the `grilling` skill (imported from
[mattpocock/skills](https://github.com/mattpocock/skills), MIT): a design tree worked in
rounds, where each round asks the whole frontier — every question whose prerequisites are
already settled — with a recommended answer beside each one, and waits. Read it with
`read_skill` and follow it. This card is the procedure around it and what the gate has to
produce.

## Procedure

1. **Read the request for branches.** Name every reading it supports. One reading and one
   obvious place to change means the gate is already done — see the last section.
2. **Answer from the repository first.** Anything a lookup can settle is not a question:
   `search_all` for where the behaviour lives, `analyze_project` for the shape of the
   project, the project brief for what it is for. Take those answers before asking anyone.
3. **Ask the whole frontier at once.** Every question whose prerequisites are settled, in
   one round, each with the answer you would pick and why. A frontier asked one question
   per turn is an interrogation.
4. **Fold the answers back in and repeat.** New answers open new branches. Keep going until
   the frontier is empty.
5. **Write the assumptions down.** Whatever you decided without asking goes into the
   answer; whatever shapes the design goes into `record_decision`.
6. **End in acceptance criteria.** The last frontier is what done means.
7. **Open the task.** `begin_task` with those criteria. The gate is over.

## Acceptance: what the gate produces

Before `begin_task` is called, the conversation has to hold all three, written out rather
than implied:

- **A one-paragraph statement of the request** as you now read it, in your words.
- **The assumptions you made** without asking, each on its own line.
- **Acceptance criteria**, each one settleable by a command, a file, or a number — never by
  an opinion. "The endpoint returns 404 for an unknown id, covered by a test" is a
  criterion; "error handling is improved" is not.

If any of the three is missing, the gate has not finished, whatever the interview covered.
`checkpoint_task` and `verify_task` carry those criteria from there on, so a vague one
stays vague for the whole task.

## Constraints

- **The gate is supplemental.** It does not take one of the three skill slots `begin_task`
  routes. Run it, then open the task.
- **Never ask what the repository can answer.** A question whose answer is in the code
  spends the asker's attention on your lookup.
- **Never start the work inside the gate.** No edits, no commits, no branches until the
  criteria exist. The one exception is reading.

## When to proceed instead

A request can be complete. When the design tree opens with no branches — the request names
the file or the behaviour, the repository shows one obvious place for it, and being wrong
costs one edit — say what you are assuming in a line and start. The gate exists for the
request that means two things, not to add a round trip to the one that means one.
