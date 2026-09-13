# Eight defects the first run of the merged tree found, fixed with their measurements

## What and why

#37 shipped `npm run setup`. The first run of it on a real install — Windows, a
real Obsidian vault — found three things wrong with it; fixing those turned up
three more; and the Windows CI job on this pull request read out two more. All
eight are here, each with the measurement that produced it: six commits on top
of `2a1b215`, 22 files, +984/−162.

### 1. The setup command contradicted itself

It asked only whether a file existed, never whether it was current, so one run
printed

```
· Search index: already built; --force rebuilds it
· Skill-routing benchmark: already built; --force rebuilds it
...
fail: skill_routing_benchmark — Skill routing benchmark is stale; rerun run_skill_routing_eval
```

— the diagnostic calling stale what the step four lines earlier had skipped as
done. `planFirstRun` now takes a `stale` map beside `present` and reads the same
signals the health check grades: `search_index_status.stale`, and the benchmark
report's mtime against its golden cases and `skill-router.mjs`. Reproduced by
touching the cases file: the step went from `· already built` to
`✓ 37/37 cases pass`, and the health check's failure went with it. A machine
whose Python helper cannot answer the status question is a reason to rebuild,
not to stop before the first step.

### 2. `--dense` downloaded 2.3 GB and left search nearly blind

Documents are embedded during a rebuild, and the weights were the last thing the
flag fetched. So an install with the model in place, a live worker and
`dense_score` in its answers had vectors for 300 documents and 382 waiting —
none of which the dense half of a hybrid query could see. A `dense_index` step
behind the same flag embeds the index once the weights land and re-embeds what
has been added since. The header prints the coverage, and an index built without
the model now reads `none embedded yet (--dense embeds them)` rather than
`0 with a vector, 0 without`.

### 3. The header printed an interpreter Windows never creates

`.venv/bin/python` was hard-coded while the step that builds the environment
looked in both places and worked, so the only thing that was wrong was the line
a person reads. `venvPythonPath` resolves it per platform, from disk when
something is on disk.

### 4. A checkout could edit its golden cases and never be told to rerun

The freshness check compared the report against
`09-mcp/search-eval/skill_routing_eval_cases.json` — a path that cannot exist
outside a vault, so the missing file's mtime read as zero and the report was
always fresh. Measured: touching the cases left `fresh: true` before, and gives
`fail … is stale` now. One resolved path is shared by the benchmark and the
health check; the report still prints the vault-relative name.

### 5. A Python failure was reported as the word "Traceback"

The helper explains itself in the last line of its traceback and every caller
that prints one line prints the first, so `npm run setup -- --dense` without the
embeddings environment reported `Traceback (most recent call last):` and nothing
else. It now leads with
`RuntimeError: sentence-transformers is required for dense BGE-M3 embeddings…`
and keeps the traceback behind it (`src/core/python-failure.mjs`).

### 6. `change-hygiene.mjs` was invisible to code search

Its binary-file check was a raw NUL byte in the source rather than an escape, so
`grep` answered `Binary file … matches` and 537 lines never appeared in a
repository-wide search — which is how it was found, by a search that skipped it.
Git was unaffected: its heuristic reads the first 8000 bytes and the byte sat at
15851.

### 7. A rollback rewrote every line ending on Windows

Git for Windows ships with `core.autocrlf=true`: CR stripped going into the
object store, CRLF written back coming out. Snapshots are captured with
`git add` and restored with `git restore`, so a file the agent wrote with LF
came back from `rollback_task` with every line changed — the Windows job on this
pull request failed on exactly that (`'export const app = 2;\r\n'` against the
`\n` the test wrote). A rollback has to give back the bytes it took, so the
snapshot commands run with the conversion off; the index is still seeded from
the repository's own, so files nobody touched keep their entries and only what
actually changed is stored raw. Reproduced on Linux by setting the same option,
and the regression test does that — it fails without the fix, and covers a file
that really is CRLF as well.

### 8. A worktree record carried two spellings of the same path

`git worktree list --porcelain` prints forward slashes on Windows too, and the
cleanup record put that beside a path built with `path.join`:
`C:/Users/…/.worktrees/merged` against `C:\Users\…\.worktrees\merged` for one
directory. Callers that resolved before comparing were immune; printing and
matching the raw value was not. The parser answers in the platform's own
spelling now, and so do `--absolute-git-dir` in snapshots and `--show-toplevel`
in `captureProjectState`, where a git project's `project_root` otherwise
differed from a non-git one by separator alone.

### Docs

Both READMEs tell a source install to run `npm run setup`, and the BGE-M3
instructions no longer point at `09-mcp/embeddings/`, a path a clone does not
have. `docs/ecc-upgrades/DEBTS.md` gains Д-30 … Д-36 with their measurements and
records what keeps the fork's own CI from running: a declined payment method on
that account, which is why its checks fail in two seconds with empty logs while
the same workflow files run in full here.

## Type

- [x] Bug fix
- [x] Feature
- [ ] Refactor / internal
- [x] Docs
- [ ] Build / CI / packaging

## Checklist

- [x] `npm run check` passes from `ai-dev-mcp-server/` — ten consecutive runs on
      this tree: 0 failures out of 10, 936 tests. Two hours earlier, on an
      earlier commit of it, 3 of 10 exited non-zero with `# fail 0` and
      `Warning: Could not report code coverage`. That is Д-11, measured on the
      base commit too and still open; a green ten does not close it.
- [x] New behaviour has tests; `src/core/` additions have JSDoc types
- [x] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] Conventional commit messages (`type(scope): subject`) — plain-sentence
      subjects with the reasoning in the body, as in #37. Say the word and they
      can be rewritten before merge.
- [x] No secrets, tokens, personal paths, or a personal vault in the diff
- [x] Docs updated if behaviour, flags, or setup changed

## What is not verified

The dense path end to end. The sandbox this was built in denies
`huggingface.co`, so the weights were never downloaded there and `dense_index`
was exercised only as far as the missing Python package — which is exactly the
failure that now reports itself properly. `npm run setup -- --dense` on a
machine with network access is the remaining check.

The rest of Windows. The job's log was readable only as a tail, so how many
tests failed in total is unknown; the two root causes it did show are fixed and
the next run of this job is what says what remains. Windows has never been green
on this suite, and until it is, "works out of the box" there is an assumption
rather than a claim.

`Docker / validate`. Every step of it that runs without a Docker daemon passes
on a clean checkout of this branch — the distribution privacy test, the
packaging manifest, `docker:prepare` (1187 files) and `docker:audit`. What the
image build and the stdio smoke do is not something this branch changes, and
their log has not been read.
