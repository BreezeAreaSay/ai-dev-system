# Backup And Recovery

## Backups

```bash
ai-dev backup before-change            # from a clone: npm run ai-dev -- backup before-change
```

`ai-dev backup [label] [--to <folder>]` writes `ai-dev-system_<UTC time>_<label>.zip` and a
`.sha256` beside it into `--to`, by default `~/.ai-dev/backups` (`$AI_DEV_HOME/backups` when
`AI_DEV_HOME` is set). It runs on every system and in every layout — a clone, a full vault, an
installed package — and holds two things:

- `vault/` — the content this install reads and writes: the Obsidian vault, a package's
  `~/.ai-dev/vault`, or a clone's `docker/public-seed`;
- `runtime/state/` — AI Dev's state: tasks, sessions, the usage ledger, instincts, skill
  outcomes, the record of client configs.

`BACKUP-MANIFEST.json` inside lists every file with its size and sha256. Indexes, caches, the
model, dependencies and VCS folders are left out — `ai-dev setup` rebuilds them — except the
vendored tree a skill runs from (Archify's), which nothing reinstalls. Links are not followed and
are listed as left out. The archive holds your notes: keep it private.

2.x had a PowerShell script for this that worked only inside a full vault
(docs/DEFECTS.md, Д-104); `scripts/backup-ai-dev-system.ps1` is now a wrapper over this command
until 4.0.

## Restoring

```bash
ai-dev restore <archive.zip> --confirm                 # back where it came from
ai-dev restore <archive.zip> --confirm --to <folder>   # laid out under a folder of your choice
```

Without `--to`, `vault/` goes back into the vault this install reads and `runtime/state/` into
AI Dev's state folder. Before anything is written:

- the archive is checked against its `.sha256`, when it is there;
- every file that would be written over is counted, and the restore stops unless `--overwrite`
  says to replace them — nothing is half-restored;
- every name is checked to stay inside the folder it lands in.

Each file is checked against its sha256 in the manifest as it comes out, and written under a
temporary name first. An archive the 2.x script made holds a whole vault and has no per-file
sums; it needs `--to`. `scripts/restore-ai-dev-system.ps1` is a wrapper over this command until
4.0.

## Recovery Order

1. Stop the AI clients, so no server is writing.
2. `ai-dev restore <archive.zip> --confirm` (with `--overwrite` over an existing install).
3. From a clone, restore the dependencies: `npm ci` in `ai-dev-mcp-server/`, and
   `ai-dev setup --frontend-qa` for Frontend QA's. A package has them already.
4. `ai-dev setup` rebuilds the skill registry and the search index from the restored notes,
   and runs the health check.
5. `ai-dev clients install` if the install moved; then restart the clients.

Do not restore cache databases over newer knowledge: rebuild them from the notes instead.

## Safe Restore Test

Restore into a new, empty folder first:

```bash
ai-dev restore <archive.zip> --confirm --to <empty-test-folder>
```

and compare what came out before restoring over the live vault.
