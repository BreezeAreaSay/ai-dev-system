import assert from "node:assert/strict";
import test from "node:test";
import {
  EMBEDDING_BACKEND_REQUIREMENTS,
  denseSetupAdvice,
  evaluateEmbeddingBackend
} from "./embedding-health.mjs";

function embeddingAvailability(overrides = {}) {
  const availability = {};
  for (const key of EMBEDDING_BACKEND_REQUIREMENTS) availability[key] = { exists: true };
  return { ...availability, ...overrides };
}

const NO_WEIGHTS = {
  model_dir: { exists: false },
  model_file: { exists: false },
  modules_file: { exists: false }
};

test("embedding backend fails on a missing shipped helper and reports worker state otherwise", () => {
  const missing = evaluateEmbeddingBackend({
    availability: embeddingAvailability({ embed_helper: { exists: false } }),
    workers: { count: 0 }
  });
  assert.equal(missing.status, "fail");
  assert.deepEqual(missing.details.missing, ["embed_helper"]);
  assert.match(evaluateEmbeddingBackend({ availability: embeddingAvailability(), workers: { count: 0 } }).summary, /not started yet/);
  const running = evaluateEmbeddingBackend({
    availability: embeddingAvailability(),
    workers: { count: 2 },
    backend: "bge-m3-local",
    paths: { model_dir: "/models" }
  });
  assert.equal(running.status, "ok");
  assert.match(running.summary, /2 worker\(s\)/);
  assert.equal(running.details.paths.model_dir, "/models");
  assert.equal(evaluateEmbeddingBackend({ workers: { count: 0 } }).details.missing.length, EMBEDDING_BACKEND_REQUIREMENTS.length);
});

test("a clone that never downloaded the weights is skipped, not failed", () => {
  // The weights come from `npm run setup -- --dense` and weigh hundreds of
  // megabytes. Reporting their absence as a failure met every new user with
  // "Health: fail — 4 not passing" on a correct install.
  const fresh = evaluateEmbeddingBackend({
    availability: embeddingAvailability({ embeddings_python: { exists: false }, ...NO_WEIGHTS }),
    dense: { installed: false, reason: "not-set-up" },
    workers: { count: 0 }
  });
  assert.equal(fresh.status, "skipped");
  assert.equal(fresh.details.optional, true);
  assert.match(fresh.summary, /--dense/);
});

test("weights present but a shipped helper gone is still a failure", () => {
  const broken = evaluateEmbeddingBackend({
    availability: embeddingAvailability({
      worker_helper: { exists: false },
      model_file: { exists: false }
    }),
    workers: { count: 0 }
  });
  assert.equal(broken.status, "fail", "a missing helper is never optional");
});

test("a missing search index is not the embedding backend's failure", () => {
  // Д-59: `search_index` was one of the backend's requirements, so a fresh
  // container — which has no index until its first start builds one — turned
  // one missing artefact into a second critical failure naming five files.
  assert.ok(!EMBEDDING_BACKEND_REQUIREMENTS.includes("search_index"));
  const fresh = evaluateEmbeddingBackend({
    availability: {
      ...embeddingAvailability({ embeddings_python: { exists: false }, ...NO_WEIGHTS }),
      search_index: { exists: false }
    },
    dense: { installed: false, reason: "not-set-up" },
    workers: { count: 0 }
  });
  assert.equal(fresh.status, "skipped");
  assert.ok(!fresh.details.missing.includes("search_index"));
});

test("advice for missing weights follows the environment, not the code path", () => {
  // Д-59: inside the published image `npm run setup -- --dense` cannot be run
  // at all, and the weights arrive by mount.
  const inImage = evaluateEmbeddingBackend({
    availability: embeddingAvailability({ embeddings_python: { exists: false }, ...NO_WEIGHTS }),
    dense: { installed: false, reason: "image-opt-out" },
    workers: { count: 0 }
  });
  assert.equal(inImage.status, "skipped");
  assert.match(inImage.summary, /AI_DEV_MODEL_PATH/);
  assert.match(inImage.summary, /INSTALL_BGE_M3=1/);
  assert.doesNotMatch(inImage.summary, /npm run setup/);

  const inClone = evaluateEmbeddingBackend({
    availability: embeddingAvailability({ embeddings_python: { exists: false }, ...NO_WEIGHTS }),
    dense: { installed: false, reason: "not-set-up" },
    workers: { count: 0 }
  });
  assert.match(inClone.summary, /npm run setup -- --dense/);
  assert.doesNotMatch(inClone.summary, /AI_DEV_MODEL_PATH/);
});

test("a dense stack that is installed and unweighted warns rather than skipping", () => {
  // Д-59: "never asked for" and "set up and did not finish" are different
  // states and a diagnostic that calls both `skipped` hides the second.
  const halfBuilt = evaluateEmbeddingBackend({
    availability: embeddingAvailability(NO_WEIGHTS),
    dense: { installed: true, reason: "interpreter-present" },
    workers: { count: 0 }
  });
  assert.equal(halfBuilt.status, "warn");
  assert.match(halfBuilt.summary, /installed but cannot run/);
  assert.match(halfBuilt.summary, /npm run setup -- --dense/);

  const imageWithStack = evaluateEmbeddingBackend({
    availability: embeddingAvailability(NO_WEIGHTS),
    dense: { installed: true, reason: "image-opt-in" },
    workers: { count: 0 }
  });
  assert.equal(imageWithStack.status, "warn");
  assert.match(imageWithStack.summary, /AI_DEV_MODEL_PATH/);
});

test("mounted weights make the backend ok and carry the dense signal through", () => {
  const mounted = evaluateEmbeddingBackend({
    availability: embeddingAvailability(),
    dense: { installed: false, reason: "image-opt-out" },
    workers: { count: 0 }
  });
  assert.equal(mounted.status, "ok");
  assert.deepEqual(mounted.details.dense, { installed: false, reason: "image-opt-out" });
});

test("advice has a default for a deployment that says nothing about dense", () => {
  assert.match(denseSetupAdvice(), /npm run setup -- --dense/);
  assert.match(denseSetupAdvice({ installed: null, reason: "unset" }), /npm run setup -- --dense/);
});
