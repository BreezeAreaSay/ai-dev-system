/**
 * Where the runtime's helper trees are, in a vault and in a plain checkout.
 *
 * Four things the server runs rather than reads: the SQLite search helper, the
 * search-eval cases, the BGE-M3 embedding scripts, and the Frontend QA runner.
 * In an Obsidian vault they live under `09-mcp/`, next to the server itself,
 * and every path in the runtime was written for that layout.
 *
 * A standalone checkout of this repository has all four — at `search-index/`,
 * `search-eval/`, `embeddings/` and `frontend-qa/` in the root — and no
 * `09-mcp/` at all. `resolveVaultRoot` falls back to the bundled
 * `docker/public-seed` tree, which carries the notes and the skill catalogue
 * but not the helpers, so a cloned repository reported "Search helper not
 * found: …/docker/public-seed/09-mcp/search-index/search_cli.py" — a path that
 * can never exist there — and semantic search, the search smokes and Frontend
 * QA were unreachable without an Obsidian vault.
 *
 * So each tree is resolved in its own right: the vault layout first, because a
 * real vault is what a deployment has, then the repository layout. When neither
 * exists the vault path is returned, so the message a caller prints keeps
 * naming the layout the deployment was meant to have.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * The helper trees, by the name the runtime knows them under: where each sits
 * in a vault, and where it sits in a checkout of this repository.
 */
export const RUNTIME_ASSET_TREES = Object.freeze({
  searchIndex: Object.freeze({ vault: ["09-mcp", "search-index"], repository: ["search-index"] }),
  searchEval: Object.freeze({ vault: ["09-mcp", "search-eval"], repository: ["search-eval"] }),
  embeddings: Object.freeze({ vault: ["09-mcp", "embeddings"], repository: ["embeddings"] }),
  frontendQa: Object.freeze({ vault: ["09-mcp", "frontend-qa"], repository: ["frontend-qa"] })
});

/**
 * One tree's directory, and where it was found.
 *
 * @param {object} input
 * @param {{ vault: string[], repository: string[] }} input.tree - From {@link RUNTIME_ASSET_TREES}.
 * @param {string} input.vaultRoot
 * @param {string} input.repositoryRoot
 * @param {(target: string) => boolean} [input.exists] - Injected by tests.
 * @returns {{ dir: string, source: "vault" | "repository" | "missing" }}
 */
export function resolveAssetTree({ tree, vaultRoot, repositoryRoot, exists = existsSync }) {
  const inVault = path.join(path.resolve(vaultRoot), ...tree.vault);
  if (exists(inVault)) return { dir: inVault, source: "vault" };
  const inRepository = path.join(path.resolve(repositoryRoot), ...tree.repository);
  if (exists(inRepository)) return { dir: inRepository, source: "repository" };
  return { dir: inVault, source: "missing" };
}

/**
 * Every helper tree at once, plus where each one came from.
 *
 * `sources` is the part worth reporting: a runtime answering from the
 * repository is a checkout without a vault, which is a supported way to run and
 * a useful thing to see in a diagnostic.
 *
 * @param {object} input
 * @param {string} input.vaultRoot
 * @param {string} input.repositoryRoot
 * @param {(target: string) => boolean} [input.exists]
 * @returns {{ searchIndexDir: string, searchEvalDir: string, embeddingsDir: string, frontendQaDir: string, sources: Record<string, string> }}
 */
export function resolveRuntimeAssets({ vaultRoot, repositoryRoot, exists = existsSync }) {
  const resolved = Object.fromEntries(Object.entries(RUNTIME_ASSET_TREES).map(([name, tree]) => [
    name,
    resolveAssetTree({ tree, vaultRoot, repositoryRoot, exists })
  ]));
  return {
    searchIndexDir: resolved.searchIndex.dir,
    searchEvalDir: resolved.searchEval.dir,
    embeddingsDir: resolved.embeddings.dir,
    frontendQaDir: resolved.frontendQa.dir,
    sources: Object.fromEntries(Object.entries(resolved).map(([name, item]) => [name, item.source]))
  };
}
