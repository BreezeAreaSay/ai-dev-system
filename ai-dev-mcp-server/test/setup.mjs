// Isolates every `node --test` process (and the workers node:test spawns per
// file) from the developer's real ~/.ai-dev tree and from the checked-in seed.
//
// Wired in through `node --import ./test/setup.mjs --test …` (see package.json
// and the `check` script). `--import` runs before any test module graph loads,
// so mcp-stdio.mjs resolves its runtime roots — which it does once, at import
// time — against this throwaway directory rather than the developer's own.
//
// Only the explicit `AI_DEV_*` roots are pinned: `aiDevRuntimePath()` honours
// them ahead of the `~/.ai-dev` default, and they cover every path the runtime
// actually writes (task/skill/pilot state, the search index, Frontend QA and
// Archify artifacts, downloaded models). `HOME`/`os.homedir()` is left alone so
// project-boundary detection behaves exactly as it does in production.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), "ai-dev-test-home-"));

process.env.AI_DEV_STATE_ROOT = path.join(stateHome, "state");
process.env.AI_DEV_SEARCH_INDEX_DIR = path.join(stateHome, "cache", "search-index");
process.env.AI_DEV_FRONTEND_QA_ARTIFACT_ROOT = path.join(stateHome, "artifacts", "frontend-qa");
process.env.AI_DEV_ARCHIFY_ARTIFACT_ROOT = path.join(stateHome, "artifacts", "archify");
process.env.BGE_M3_MODEL_DIR = path.join(stateHome, "models", "bge-m3");

// Python helpers must never drop __pycache__/*.pyc into the repo or the seed.
process.env.PYTHONDONTWRITEBYTECODE = "1";

process.on("exit", () => {
  try {
    fs.rmSync(stateHome, { recursive: true, force: true });
  } catch {
    /* best effort: the OS reclaims the temp directory anyway */
  }
});
