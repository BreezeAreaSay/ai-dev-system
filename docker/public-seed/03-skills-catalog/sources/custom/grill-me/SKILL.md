---
name: grill-me
description: The intent gate. Use before any substantive repository work, and whenever a request could mean two different things: stress-test the request with the grilling interview until the design tree has no open branches, then open the task. Skip only for a request whose scope is one obvious edit.
---

# Grill Me

Most bad changes are not bad code. They are a correct implementation of a request nobody
checked. This gate runs before the work, and it is the first thing the
`ai-dev-orchestrator` protocol asks for.

The interview itself is the `grilling` skill (imported from
[mattpocock/skills](https://github.com/mattpocock/skills), MIT): a design tree worked in
rounds, where each round asks the whole frontier — every question whose prerequisites are
already settled — with a recommended answer beside each one, and waits. Read it with
`read_skill` and follow it; the rest of this card is only how it fits this system.

## How it fits here

- **It is supplemental.** The gate does not take one of the three skill slots `begin_task`
  routes. Run it, then open the task.
- **Facts are yours, decisions are theirs.** Anything the repository can answer —
  which file owns the behaviour, whether a command exists, what the tests cover — is a
  lookup (`search_all`, `analyze_project`, the project brief), never a question.
- **Ask once, in one round.** A frontier asked one question per turn is an interrogation.
- **Assumptions are written down, not held.** What you decided without asking goes into
  the answer, and anything that shapes the design goes into `record_decision`.
- **The gate ends in criteria.** The last frontier is what done means. Each criterion must
  be something a command, a file, or a number can settle, and those are what `begin_task`
  and `checkpoint_task` carry from there on.

## When to proceed instead

A request can be complete. When the design tree opens with no branches — the request names
the file or the behaviour, the repository shows one obvious place for it, and being wrong
costs one edit — say what you are assuming in a line and start. The gate exists for the
request that means two things, not to add a round trip to the one that means one.
