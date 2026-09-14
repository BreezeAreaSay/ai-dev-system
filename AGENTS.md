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

A local-first MCP server (133 tools over stdio, or one warm daemon) plus its
Docker image, packaging and a public skill seed. It opens no network port and
sends nothing anywhere. The full Obsidian vault it normally reads is **not**
here: a standalone checkout resolves its content root to `docker/public-seed`.

## Where code goes

| You are adding | It goes in |
| --- | --- |
| pure logic, no vault, no MCP | `ai-dev-mcp-server/src/core/<name>.mjs` + `<name>.test.mjs` beside it |
| a new MCP tool | an extension: `ai-dev-mcp-server/src/extensions/<area>.mjs` |
| a hook that runs inside a user's repository | `ai-dev-mcp-server/hooks/` |

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

Register it in `src/tool-extensions.mjs`. The `host` object is built once by
`mcp-stdio.mjs` and carries the shared runtime services.

**An extension must never import `mcp-stdio.mjs`.** That is an import cycle and
it couples pure logic to a vault. Take what you need from `host`.

## Three rules that look arbitrary and are not

**1. Modules are capped at 800 lines** (`MODULE_LINE_CEILING`), enforced by
`npm run check` over `src/core/` and `src/extensions/`. Two modules were already
over it when the rule landed and are pinned at that day's size in
`MODULE_LINE_EXCEPTIONS` — they may shrink, never grow, and once one is back
under 800 the gate tells you to drop its pin. `src/mcp-stdio.mjs` has
its own budget, `SYSTEM_LINE_CEILING`, re-pinned downward after each extraction:
the file can be edited but not re-grown. If your change does not fit, extract
something; do not raise a ceiling.

**2. Fake secrets in tests are assembled by concatenation, never written as a
literal.** `scripts/security-check.mjs` walks `src/` and `scripts/` for leaked
credentials and cannot tell your fixture from a real key. Follow what the tests
already do:

```js
const key = ["AKIA", "B".repeat(16)].join("");      // yes
const token = ["ghp_", "a".repeat(36)].join("");    // yes
```

The same values written as single string literals fail the gate. Its patterns
are an AWS `AKIA…` key, an `sk-…` secret of 20 characters or more, a private-key
header, and any `password` / `api_key` / `secret_key` / `access_token` assigned
a literal of 12 characters or more — so `api_key: "…"` in a fixture needs the
same treatment.

**3. The hooks under `ai-dev-mcp-server/hooks/` duplicate server code on
purpose.** They are copied into other people's repositories and run there, with
no access to this package. Shared logic there is deliberately a second copy —
project identity is the main one. When you change identity derivation, change
**both** sides and keep them behaving identically. Д-45, Д-51 and Д-52 are all
the same defect found three times: the two copies disagreeing.

## Execution safety

Commands run as argument arrays with `shell: false`. The static gate rejects
`eval`, `new Function`, `shell: true`, and `child_process.exec`. Never
interpolate a variable into a command string. See
`ai-dev-mcp-server/docs/SECURITY.md`.

## How a change is finished

**Everything merges to `main`.** No long-lived branches.

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
npm run setup           # build what a fresh clone does not ship
npm run check           # the gate: static quality + tests + coverage + security + smokes
npm run acceptance      # the gate, ten times
npm run -s doctor       # the health check as one command
npm run docker:seed:verify   # after touching docker/public-seed
```

## Language

Code, comments and public documentation are English. `README.ru.md` and
`docs/DEFECTS.md` are Russian — keep each file in the language it is already
in.
