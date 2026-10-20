# AGENTS.md

Instructions for an AI agent working on **this** repository.

This project's whole purpose is to put engineering protocols into the file every
assistant already reads. For a long time it had no such file of its own, and the
rules below were held in the head of whoever was working — the exact failure the
project exists to prevent.

Written by hand, not generated. `install_project_rules` writes this file into
*other* repositories; here it is the source, not the output.

Human-facing contribution rules are in [CONTRIBUTING.md](CONTRIBUTING.md) and
still apply. This file is the part an agent gets wrong.

## What this repository is

A local-first MCP server (148 tools — 135 for agents, 13 in the opt-in control
API — over stdio, or one warm daemon) and every form it ships in: the `ai-dev`
command line, the npm package `@stonebridgeway/ai-dev-system`, the Docker image,
and the desktop app with its Windows installer — plus a public skill seed. It
opens no network port. What it fetches is what a person asks for — the local
model, Frontend QA's browser — and the installed desktop app looks for an update
in the project's GitHub releases. The full Obsidian vault it normally reads is
**not** here: a standalone checkout resolves its content root to
`docker/public-seed`.

## Where code goes

| You are adding | It goes in |
| --- | --- |
| pure logic, no vault, no MCP | `ai-dev-mcp-server/src/core/<name>.mjs` + `<name>.test.mjs` beside it |
| a new MCP tool | an extension: `ai-dev-mcp-server/src/extensions/<area>.mjs` |
| a hook that runs inside a user's repository | `ai-dev-mcp-server/hooks/` |
| a command of the `ai-dev` CLI | `ai-dev-mcp-server/src/cli/<command>.mjs`, listed in `src/cli/main.mjs` (`bin/ai-dev.mjs` is the entry) |
| a file the installed system needs at run time, outside `src/` and `hooks/` | listed in `ai-dev-mcp-server/distribution.allowlist.json`, or the npm package, the image and the installer ship without it |
| the desktop app | `desktop/src/main` (main process), `desktop/src/renderer` (the page), tests in `desktop/test` — `docs/DESKTOP.md` |
| the Windows installer | its build in `desktop/scripts` (`build-windows.mjs`, `windows-bundle.mjs`), the NSIS step and the pinned Node in `desktop/build`; the runtime copy and its stable link in `ai-dev-mcp-server/src/core/app-bundle.mjs` — `docs/DESKTOP.md`, "The Windows install" |

**New tools are added as extensions, never by growing `mcp-stdio.mjs`.** Each
extension exports one factory:

```js
export function createXxxTools(host) {
  return {
    definitions: [{ name, description, inputSchema }],
    handlers: { [name]: async (args) => result },
    readOnly: ["tool_name"]          // optional
  };
}
```

Register it in `src/tool-extensions.mjs`, give each tool a group in
`scripts/render-tool-reference.mjs` and a profile in `src/core/tool-profiles.mjs`,
and run `npm run docs:tools` — CI's `docs:tools:check` fails on a tool without
either, and `npm run check` does not run it. The `host` object is built once by
`mcp-stdio.mjs` and carries the shared runtime services.

**An extension must never import `mcp-stdio.mjs`.** That is an import cycle and
it couples pure logic to a vault. Take what you need from `host`.

## Three rules that look arbitrary and are not

**1. Modules are capped at 800 lines** (`MODULE_LINE_CEILING`), enforced by
`npm run check` over `bin/`, `src/cli/`, `src/core/`, `src/extensions/`,
`src/galaxy/` and the desktop app's code (`desktop/src`, `desktop/scripts`;
not its tests). The top-level `src/*.mjs`, `src/transport/`, `src/workers/`,
`scripts/` and `hooks/` are not measured — a hook is one file by design — so
the ceiling there is yours to keep. Two modules were already
over it when the rule landed and are pinned at that day's size in
`MODULE_LINE_EXCEPTIONS` — they may shrink, never grow, and once one is back
under 800 the gate tells you to drop its pin. `src/mcp-stdio.mjs` has
its own budget, `SYSTEM_LINE_CEILING`, re-pinned downward after each extraction:
the file can be edited but not re-grown. If your change does not fit, extract
something; do not raise a ceiling.

**2. Fake secrets in tests are assembled by concatenation, never written as a
literal.** `scripts/security-check.mjs` walks `bin/`, `src/`, `scripts/`,
`hooks/` and the desktop app's `src/`, `scripts/` and `test/` for leaked
credentials and cannot tell your fixture from a real key. Follow what the tests
already do:

```js
const key = ["AKIA", "B".repeat(16)].join("");      // yes
const token = ["ghp_", "a".repeat(36)].join("");    // yes
```

The same values written as single string literals fail the gate. Its patterns
are an AWS `AKIA…` key, an `sk-…` secret of 20 characters or more, a private-key
header, and any `password` / `api_key` / `secret_key` / `access_token` assigned
a literal of 12 characters or more (`passwd` too) — so `api_key: "…"` in a
fixture needs the same treatment.

**3. The hooks under `ai-dev-mcp-server/hooks/` duplicate server code on
purpose.** They are copied into other people's repositories and run there, with
no access to this package. Shared logic there is deliberately a second copy —
project identity is the main one. When you change identity derivation, change
**both** sides and keep them behaving identically. Д-45, Д-51 and Д-52 are all
the same defect found three times: the two copies disagreeing.

## Execution safety

Commands run as argument arrays with `shell: false`. The static gate reads the
server's code and the desktop app's as tokens (`src/core/code-tokens.mjs`; the
rules in `src/core/forbidden-calls.mjs`, docs/DEFECTS.md Д-267, Д-382, Д-398,
Д-407 … Д-410, Д-422 … Д-426, Д-431, Д-432, Д-440 … Д-448, Д-459 … Д-466, Д-472
… Д-476, Д-480 … Д-482, Д-486 … Д-490, Д-496, Д-499 … Д-511, Д-515 … Д-523,
Д-527), every escape decoded, and rejects the usual spellings and their plain
equivalents: `exec` and `execSync` of `child_process` — through a named, default
or namespace import,
`require`, `import()` or `process.getBuiltinModule` called by name, as a member
or by a plain-string key, in parentheses, or through `.call` or `.apply`, the
module's `default`, a `.then` callback, or a name it is bound or plainly
re-bound to, `(0, cp)` and `a = b = cp` included — and the module object itself
handed to another file (`export *`, `export const`, a pattern an export declares
from the module itself, an exported `let` or `var` the module is assigned to, by
name or by a pattern, `module.exports =`, `exports["cp"] =`): itself, on one
line or over several, not a value it takes part in (`cp !== undefined`); a
`shell` option — a key, an accessor, or a member set with `=`, `??=`, `||=` or
`&&=` — with any value but `false`, `null`, `undefined`, `0` or `""`, or one it
cannot read; `eval` and the `Function` constructor, called (`.call`, `.apply`
and `.bind` too) or handed on, which only the desktop app's tests may do; a
computed member of `globalThis`, `window`, `global` or `self` whose key is not
one plain string naming neither. A file it cannot read to its end is refused
too. It follows the module object and the global objects through plain
re-binding and nothing else — a module name built from parts, `createRequire`,
`Reflect.get`, a loader bound to another name or reached any other way (`.bind`,
`Reflect.apply`, a condition, `require["call"]`), the module object put in an
object or an array (`module.exports = { cp }`, `export const [run] = [cp]`), on
`this` or a class's field, or on a head in parentheses
(`(module.exports).cp = cp`), or only part of a value (`cp || fallback`) and a
name bound to that, an exported `let` or `var` a pattern declares or whose name
the file declares again, a global taken out of itself by a pattern
(`{ globalThis: g } = globalThis`), `await` or `yield` written as a name in a
script, which it reads as the keyword, and a class's member on the line after
`n++` or a word an operand follows (a field named `in` or `return`, `this.in`),
which it reads as an assignment or, named `class` or `function`, as declaring
the name after it — a `class` after a field named `in` and the like, not
`return` or `yield`, as waiting for a body too —, are past it — so it keeps
honest code honest and is no sandbox. Never interpolate a variable into a command string.
See `ai-dev-mcp-server/docs/SECURITY.md`.

## How a change is finished

**Short branches, pull requests to `main`.** No long-lived branches. A push to
`main` publishes the `:edge` image only; a release is a `vX.Y.Z` tag, and the
2.x line lives on as `v2.*` tags (CONTRIBUTING.md, "Branches, releases and pull
requests").

**A defect you find is written down before it is fixed**, in
`docs/DEFECTS.md`: what is wrong, what it threatens, a measurement
that reproduces it, and after the fix a second measurement. "Fixed" without a
number before and after is not a closed debt. Write it even when you cannot fix
it — an owner decision recorded beats a defect remembered.

**A session ends with the acceptance run, not with one green gate:**

```bash
cd ai-dev-mcp-server
npm run acceptance          # ten consecutive `npm run check` runs
```

It prints `N падений из 10`. Report that line. One green run is not evidence:
this project has had defects that appeared in one run out of ten, and the whole
point of the rule is that they show up before a user finds them.

Note which kind of failure you got. A run with a failing test is the suite
telling you something. A run that exits non-zero with `# fail 0` is the coverage
reporter and says nothing about the code.

## How results are verified

**Probe the running server adversarially. Do not verify by reading your own
diff, and do not report a result you have not seen printed.**

- Ask for the thing that should *not* happen as well as the thing that should.
- When a probe disagrees with the product, suspect the probe first — most of
  them here have been wrong about a key name or a path.
- A claim you could not check is reported as unchecked. Say which half you
  verified and which half you did not. A plausible sentence is not a verified
  one: `docs/DEFECTS.md` Д-52 exists because a documentation draft
  told readers to look for a status key that does not exist.

## Commands worth knowing

```bash
cd ai-dev-mcp-server
npm run setup -- --no-clients   # build what a fresh clone does not ship; leave the person's AI clients alone
npm run check           # the gate: static quality, packaging:check, the seed index, the tests with coverage, security-check, the protocol and lifecycle smokes
npm run acceptance      # the gate, ten times
npm run upgrade:test    # a 2.x clone updated to this one (Python 3 and git; ~3 minutes)
npm run docs:tools      # after adding or changing a tool; docs:tools:check is what CI runs
npm run docs:links      # after touching the documentation: no broken link or anchor
npm run -s doctor       # the health check as one command
npm run docker:seed:verify   # after touching docker/public-seed
cd ../desktop && npm test    # the desktop app: unit tests, then end to end (xvfb-run without a display)
```

## Language

Code, comments and public documentation are English. `README.ru.md`,
`docs/ru/*`, `docker/README.md`, `docs/DEFECTS.md` and the program's own notes in
`docs/program/` are Russian — keep each file in the language it is already in,
and mirror a change to an English guide in its Russian twin.
