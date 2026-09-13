# ai-dev-system 2.0.0


A major version because what a clone *is* changed, not only what it can do: the
bundled catalogue went from 142 skills to 3,227, the protocols now reach seven
assistant instruction files instead of three, and one health check changed the
status it reports. Anything reading those outputs should be re-checked against
this release.

**Highlights**

- **A fresh clone no longer fails its own health check.** `git clone` →
  `npm install` → `npm run setup` used to end in `Health: fail — 4 not passing`
  on Linux and Windows alike: the Frontend QA runner threw where its optional
  dependency was missing, the embedding check counted the Python environment
  `--dense` builds as required, and one skill — `grill-me`, shipped here —
  failed its own quality rules. Now `degraded — 2 not passing`, both warnings
  naming a next step.
- **macOS is tested, not assumed.** CI had three Linux jobs and one Windows job
  and nothing for macOS. A `macos-latest` job now runs the unit tests, the
  identity and hook tests, a first run and the seed check — and found a defect
  on its first run.

- **3,085 skills in the box.** The intent gate `grill-me`, the whole Membrane
  integration catalogue, and the Understand Anything codebase-graph skills — all
  MIT, each recorded in `THIRD_PARTY_NOTICES.md` with its revision. Routing is
  held steady by `membrane_policy` and a named-skill floor; the 37-case golden
  benchmark is unchanged.
- **Every assistant reads the protocols.** `install_project_rules` writes
  `AGENTS.md`, `.claude/rules`, `.cursor/rules`, `GEMINI.md`,
  `.github/copilot-instructions.md`, `.windsurf/rules` and `.clinerules` — and
  by default only the ones whose tool this machine or repository already shows a
  trace of.
- **`npm run daemon`.** One warm local process on a Unix socket, or a named pipe
  on Windows, instead of a fresh server per client.
- **`npm run setup` and `npm run acceptance`.** The first run, and the project's
  own acceptance rule, as commands rather than instructions.
- **Windows is a supported platform.** Byte-exact snapshots, platform-native
  worktree paths, the interpreter that actually exists, a shell-free `npm`, and
  one memory key per project rather than one per machine.
- **The local model runs in a container.** The Python side is a build argument
  (`INSTALL_BGE_M3=1`), the weights mount read-only at `/models/bge-m3` from
  either the launcher scripts or Compose, and both READMEs carry the whole path
  end to end — including a four-line Dockerfile for baking the weights in.
- **978 tests, 0 failures**, coverage 97.05 / 83.83 / 94.79 against thresholds
  85 / 60 / 85.

**Breaking**

- The bundled seed now carries 3,227 skills. A deployment that pinned the old
  142 will see different routing candidates; `membrane_policy: "exclude"`
  restores the narrow behaviour.
- **`system_health` reports two checks differently.** `embedding_backend` is
  `skipped`, not `fail`, when the optional dense model was never downloaded, and
  `frontend_qa_environment` is `skipped` when Playwright was never installed —
  both are opt-in steps, and their absence is not a fault. A half-configured
  Frontend QA (Playwright present, its browser missing) is still a warning, and
  a missing shipped helper is still a failure. Anything treating a non-`ok`
  status as an error should read the status rather than its absence.
- `install_project_rules` with no explicit `targets` writes more files than
  before, chosen by what the machine already uses. Pass `targets` to pin it.
- **Project memory keys change on machines where the home directory is reached
  through a symlink or a short name** — every macOS install, and any Windows or
  Linux one whose path is not canonical. They were wrong before: every project
  under such a home shared one key. Memory written under the old key is not
  migrated; sessions, instincts and handoffs recorded there start fresh.

---

**Full changelog:** [CHANGELOG.md](https://github.com/stonebridgeway/ai-dev-system/blob/main/CHANGELOG.md#200---2026-09-13)

**Verified before release**

| | |
| --- | --- |
| Tests | 978, 0 failures |
| Coverage | 97.05 lines / 83.83 branches / 94.79 functions (thresholds 85 / 60 / 85) |
| Ten consecutive gate runs | 0 failures out of 10 |
| Platforms in CI | Linux, Windows, macOS |
| Skills shipped | 3,227 |
| MCP tools | 133 |
| Defects recorded and closed | 52 recorded, 48 closed |

**Install**

```bash
git clone https://github.com/stonebridgeway/ai-dev-system
cd ai-dev-system/ai-dev-mcp-server
npm install
npm run setup
```

Optional: `npm run setup -- --dense` for local BGE-M3 dense search,
`--frontend-qa` for Playwright. Both are reported as skipped, not failed, when
you do not install them.

MIT. Runs locally; opens no network port; costs nothing to run.
