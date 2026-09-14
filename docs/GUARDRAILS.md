# Guard rails

[← README](../README.md) · [Install](INSTALL.md) · [Workflow](WORKFLOW.md) · [Capabilities](CAPABILITIES.md)

The parts of the system that say no: hooks that apply to every action rather
than only to the tools an agent chooses to call, the policy file that tunes
them, an inventory of what your agents are wired to, and what stays on your
machine.

## Contents

- [Hooks](#hooks)
- [Rules without hand-editing JSON](#rules-without-hand-editing-json)
- [What your agents are wired to](#what-your-agents-are-wired-to)
- [Local data and security](#local-data-and-security)

## Hooks

`install_agent_hooks` wires the server's guard rails into the agent itself, so
they apply to every action rather than only to the tools the agent chooses to
call:

```text
Use the ai-dev MCP server. Call install_agent_hooks for /workspace/my-project
with targets ["claude"] and profile "standard".
```

It writes self-contained scripts into `.ai-dev/hooks/`, a policy file at
`.ai-dev/policy.json`, and registrations into `.claude/settings.json` (Claude
Code) and/or `.cursor/hooks.json` (Cursor). Existing settings are merged, not
replaced: only previous AI Dev entries are rewritten. Re-running refreshes the
scripts and keeps your policy rules. `agent_hooks_status` reports what is
installed.

The hooks block a command before it runs (git-hook bypasses, destructive and
publishing commands), block a write before it lands (secret-bearing paths,
secrets in content, weakened linter configuration), format edited files, inject
the last handoff and open tasks at session start, distil the transcript into a
session record at session end, record what each turn spent, and advise on
compaction. Any hook error exits zero, so a broken hook never wedges the agent.

What the session-end hook captures is a draft, not a handoff: its fields are
heuristics over the transcript, so `resume_session` shows such a record flagged
unconfirmed, and `save_session` with `confirm_hook_draft: true` is what turns it
into a real one — your fields win, the draft fills the rest, and the draft is
dropped.

The cost-capture hook reads the same transcript for a different reason: after
every response it sums the tokens of the assistant messages that arrived since
the last one and appends them to the usage ledger, per model. It records tokens,
not money — `usage_report` prices them at read time from published Anthropic
rates and shows today, yesterday, the last seven days, and the per-model and
per-task totals. Prices move, so `model_rates` in `.ai-dev/policy.json`
overrides any of them (USD per million tokens), and a model with no rate is
listed as unpriced rather than counted as free.

Three profiles:

- `minimal` — the command and file guard, session capture and cost capture.
  Nothing else runs.
- `standard` — the default: everything above, including formatting, session
  start injection, the compaction advisor, and the end-of-response check.
- `strict` — the same set plus extra review warnings before `git push` and
  `git commit --amend`, and fact forcing.

Fact forcing is the strict profile's one refusal that is not about danger. The
first edit of a file in a session is refused until the agent has written the
facts behind it, and the first destructive command until it has written the way
back:

```text
FACTS src/router.mjs
importers: src/app.mjs and src/server.mjs
api: adds a `resolve` export, nothing removed
data: reads the route table in config/routes.json
instruction: "make the router resolve nested paths"
```

The refusal quotes that block, the agent writes it in the turn that repeats the
edit, and the retry goes through; the file then stays grounded for the rest of
the session. The gate reads the transcript, so where there is none it judges
nothing, and it stops refusing after three refusals in one session rather than
arguing. `fact_force` in the policy turns it on anywhere, or off under strict,
and `exempt_globs` keeps it away from paths where it has nothing to ask.

`targets: ["git"]` installs two more, for everyone rather than for one client:
`install_agent_hooks` writes `.ai-dev/git-hooks/{pre-commit,pre-push}` and points
`core.hooksPath` at them, so a commit made from an editor, a script or a terminal
meets the same rules. `pre-commit` refuses a staged secret, merge-conflict
marker, focused test or left-behind `debugger`; `pre-push` says when the active
task has no verification or its latest one failed. A `core.hooksPath` someone
else set is reported, never taken over, and every hook in `.git/hooks` that
would stop running is named — git consults one hooks directory, not two.

`.ai-dev/policy.json` is where you tune it without touching the scripts:
`allow_config_edits`, `format_on_edit`, compaction thresholds, `model_rates`,
`completion_claims` (the completion-statement linter: `enabled`, and `waivers` of
`{ rule, reason, expires }`), `fact_force` (`enabled`, `files`, `bash`,
`expiry_minutes`, `max_denials`, `max_entries`, `exempt_globs`), `git_hooks`
(`pre_commit` and `pre_push`, each `block`, `warn` or `off`), and a list of your
own rules:

```json
{
  "profile": "standard",
  "rules": [
    {
      "id": "block-prod-migrations",
      "event": "bash",
      "pattern": "(migrate|migration).*(--prod|production)",
      "action": "block",
      "message": "Production migrations need explicit human approval."
    }
  ]
}
```

`event` is `bash`, `file`, or `all`; `action` is `block` or `warn`.

## Rules without hand-editing JSON

A rule nobody proved fires is a rule that silently does nothing, and the guard
says nothing about one: a pattern that does not compile, an event it never
evaluates, or an `action` it does not know are skipped or quietly downgraded to a
warning. So the rules block has tools of its own:

```text
Use the ai-dev MCP server. Call upsert_policy_rule for /workspace/my-project with a
rule that blocks `terraform destroy`, and an example it must match.
```

`upsert_policy_rule` compiles the pattern exactly as the guard does
(case-insensitively), refuses one that cannot work — including a quantified group
holding an unbounded quantifier, which would stall the guard on a long line —
refuses a second rule that fires on the same text, and refuses a new or changed
pattern that does not match the `example` you pass. It stores the example on the
rule, so `list_policy_rules` can re-run it later and tell you a rule a hand edit
disarmed; `counter_example` is checked the same way, against a pattern that grew
too broad. Updates are patches, so `{ "id": "warn-eval", "enabled": false }`
disables a rule and `remove_policy_rule` deletes one. `agent_hooks_status` lists
every rule with what the guard would actually do with it. The guard re-reads the
file on every call, so a change is live without restarting the client.

## What your agents are wired to

Every client keeps its own list of MCP servers, and each entry is a program that
starts with the editor and answers tool calls with your credentials.
`list_mcp_servers` reads all of them — `.mcp.json`, `.claude/settings.json` and
`settings.local.json`, `.cursor/mcp.json`, `.vscode/mcp.json`,
`.gemini/settings.json`, `.codex/config.toml` — and reports one entry per server:
which files declare it, over which transport, which environment variables it
substitutes and whether they are set, and whether Claude Code starts it without
asking.

A credential written out in a config file is a `block` finding, masked out of the
report so it is not repeated into the next ticket: the file is in the repository,
so the value is in every clone and needs rotating, not deleting. Plain HTTP to a
remote endpoint, `npx -y` with no pinned version, a server that starts through a
shell, an entry no client can start, a config that cannot be parsed, and the same
server name defined differently in two files are warnings. Pass
`include_user_scope: true` to include your own `~/.claude.json` (with its
per-project block), `~/.cursor/mcp.json`, `~/.gemini/settings.json` and
`~/.codex/config.toml`; it is off by default, because those files are yours
rather than the repository's.

## Local data and security

The image contains only the audited public seed: rules, prompts, quality gates,
allowlisted skills, and the runtime. It does not include:

- passwords, tokens, `.env` files, keys, or user configurations;
- a personal Obsidian vault, `.codex`, `.ai-dev`, Git history, or local caches;
- `02-knowledge/Projects`, `02-knowledge/Task Runs`, indexes, logs, or backups;
- the source or context of your projects;
- the BGE-M3 weights.

Data the container creates is stored in the local Docker volume
`ai-dev-system-data`. Updating the image does not overwrite that volume. By
default the container runs with no network, as a non-root user, with a read-only
root filesystem, no Linux capabilities, and `no-new-privileges`.

If a project genuinely needs internet access during verification, set
`AI_DEV_DOCKER_NETWORK=bridge` deliberately for that run only.

The server's own threat model and the rules its code follows are in
[ai-dev-mcp-server/docs/SECURITY.md](../ai-dev-mcp-server/docs/SECURITY.md).
To report a vulnerability, see [SECURITY.md](../SECURITY.md).
