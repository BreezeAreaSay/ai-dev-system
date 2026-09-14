# Demo — one task, start to finish

[← README](../README.md) · [Install](INSTALL.md) · [Workflow](WORKFLOW.md) · [Capabilities](CAPABILITIES.md)

**"Add authentication to the API."** One task, from the first command to a closed
one, including the part where it goes wrong.

Everything below is real output. You can produce it yourself in about twenty
seconds, without installing an MCP client and without touching any of your
repositories:

```bash
cd ai-dev-mcp-server
npm run demo
```

The script builds a throwaway API project in a temporary folder, runs the task
through the real server, and deletes everything it made.

---

## 1. You give the agent a task

```text
begin_task — "Add authentication to the API"
```

```text
task task-20260914T105142-942dc4f2 is open

It loaded the project, without being told about it:
  stack Node.js, 4 relevant files read
    package.json - project configuration
    src/routes.mjs - application source
    src/server.mjs - application source

It routed 3 skills out of 3,227 - nobody named them:
  feature-builder (workflow)
  application-security-reviewer (domain)
  secrets-dependencies-auditor (verification)

And it wrote down what finished has to mean:
  AC-1 Requested behavior is implemented within the stated scope: Add authentication to the API
  AC-2 Relevant automated checks pass or every unavailable check has a recorded reason.
  AC-3 No known regression, unresolved error, placeholder, or unrelated refactor remains.
```

Nobody said "this is a Node project", "read these files", or "use a security
reviewer". Five words of task description produced a compiled context pack, three
routed skills out of 3,227, and a written definition of done.

## 2. The agent writes the code — and gets it wrong

The authentication middleware has a real bug: a request with no token is waved
through as anonymous instead of being rejected.

```text
checkpoint_task

checkpoint recorded, snapshot-1 holds 3 files at commit 6a110c13
nothing was written to your branch, stash or index - rollback_task can undo this turn
```

The snapshot is a commit object no branch points at, under
`refs/ai-dev/snapshots/<task_id>/`. Your branch, stash and index are untouched,
and `rollback_task` can put this turn back exactly as it was.

## 3. It tries to talk its way past the problem

This is the moment the product exists for. The agent files a report saying the
work is done and the failure is somebody else's:

> *"Authentication is done. One test is failing but it's a pre-existing issue,
> will fix later."*

```text
REFUSED - the report claimed more than the evidence showed

The report claims more than the evidence shows: 2 rationalizations are not backed by a passing check.
- pre_existing_failure in notes: The report calls a failure pre-existing; the latest verify_task run
  never ran. Show it on the base ref and record a passing verify_task for this change.
  Quoted: "…ne test is failing but it's a pre-existing issue, will fix later."
- tests_failing_deferred in notes: The report leaves a red test for later; the project quality gate
  (verify_task with run_quality) never ran. Make the suite green before the report claims the change
  is done. Quoted: "One test is failing but it's a pre-existing issue, will fix later."
Fix the check and run verify_task again, or rewrite the report to say what actually happened.
```

Two named rules, the check behind each one, the sentence that triggered it, and
what would satisfy it. The checkpoint is not recorded. If the reason is genuinely
real, you write it into the report and waive the rule in `.ai-dev/policy.json` —
but you do it deliberately, in a file someone can review, rather than by phrasing
it persuasively.

## 4. Verification runs the project's own checks

```text
verify_task

FAILED - quality_gate: failed, change_hygiene: warn, security_scan: pass

not ok 1 - a request with no token is rejected
  ---
  duration_ms: 1.676832
  type: 'test'
  location: '/tmp/.../test/auth.test.mjs:5:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:

    200 !== 401

# tests 3
# pass 2
# fail 1
```

The quality gate ran the project's own test command — `node --test`, read out of
`.ai-dev/quality-gate.md`, not guessed. The planted bug is caught by the test the
agent itself wrote.

## 5. The agent fixes the real bug

```js
if (token === "Bearer demo-token") return { ok: true };
return { ok: false, reason: "missing or invalid token" };
```

## 6. Verification again

```text
verify_task

PASSED - quality_gate: passed, change_hygiene: warn, security_scan: pass
recorded as verification-1789383102869-d7001968
```

`change_hygiene` stays at `warn` — it noticed that a public interface changed
without any documentation changing. A warning is reported, not fatal; a `block`
finding would have stopped this.

## 7. Now, and only now, the task can close

```text
complete_task

task complete
pull request description written to .ai-dev/pr/task-20260914T105142-942dc4f2.md
  title: feat(src): add authentication to the API
```

The pull request description is built from the evidence the task collected, not
written from memory:

```markdown
## Verification

Latest run `verification-1789383102869-d7001968` at 2026-09-14T10:51:42.869Z: **passed**.

| Check | Result |
| --- | --- |
| `quality_gate` | passed |
| `change_hygiene` | warn |
| `security_scan` | pass |

Not run: `frontend_qa`.

2 verification run(s) recorded; the latest one is the one that counts.
```

It also carries the summary, the changed files grouped by kind, every acceptance
criterion with the verification that satisfied it, the checkpoints in order, and
the change-hygiene findings. Nothing is pushed and no pull request is opened —
the `git push` and `gh pr create` commands are returned as text for you to run.

Had `complete_task` been called before step 6, it would have come back with:

```text
The latest verification (verification-…) failed. Fix the problem and run verify_task again.
```

---

## What this run demonstrates

| Step | What an agent normally does | What happened here |
| --- | --- | --- |
| 1 | Asks you about the project, or guesses | Compiled the context and routed 3 skills from 5 words |
| 2 | Edits in place; a bad turn is yours to untangle | Snapshotted the turn, outside your branch and stash |
| 3 | *"Pre-existing issue, will fix later"* | Refused, with the rule and the missing check |
| 4–6 | Says the tests pass | Ran the project's own gate and showed the output |
| 7 | *"Done!"* | Closed on recorded evidence, and wrote the PR from it |

## Recording this

`npm run demo` is the recording. The whole run is about twenty seconds, needs no
MCP client, and creates nothing outside a temporary folder.

- `npm run demo -- --no-color` for a plain transcript, or to paste into an issue.
- An 80×40 terminal fits every scene without wrapping.
- Steps 3 and 4 are the ones worth pausing on — the refusal and the failing test
  are the parts people have not seen an agent do before.
