import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadDenseModel } from "./dense-download.mjs";
import { parseDenseManifest } from "./dense-manifest.mjs";

const digestOf = (text) => crypto.createHash("sha256").update(text).digest("hex");

const BODIES = { "config.json": "config-bytes", "onnx/model_int8.onnx": "weight-bytes" };

/**
 * A local stand-in for the model host: serves the two fixture files, and can be
 * told to corrupt, truncate or fail any of them.
 */
async function startHost({ corrupt = new Set(), truncate = new Set(), fail = new Map() } = {}) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const relative = decodeURIComponent(request.url.replace(/^\/model\//, ""));
    requests.push(relative);
    if (fail.has(relative)) {
      response.writeHead(fail.get(relative));
      response.end("not found here");
      return;
    }
    const body = BODIES[relative];
    if (body === undefined) {
      response.writeHead(404);
      response.end("unknown file");
      return;
    }
    if (truncate.has(relative)) {
      // A transfer that dies mid-body: a length is promised and not delivered.
      response.writeHead(200, { "content-length": String(body.length + 50) });
      response.write(body);
      response.destroy();
      return;
    }
    response.writeHead(200);
    response.end(corrupt.has(relative) ? "tampered-bytes" : body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    requests,
    base: `http://127.0.0.1:${port}/model`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

function manifestFor(sources) {
  return parseDenseManifest({
    model: "BAAI/bge-m3",
    export: "Xenova/bge-m3",
    revision: "a".repeat(40),
    dtype: "int8",
    dimensions: 1024,
    sources,
    files: Object.fromEntries(Object.entries(BODIES).map(([name, body]) => [name, digestOf(body)]))
  });
}

const stageDir = () => fs.mkdtemp(path.join(os.tmpdir(), "dense-download-"));
const quiet = () => {};

test("a good host lands every file, writes the manifest beside them, and verifies ready", async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const dir = await stageDir();

  const result = await downloadDenseModel({ manifest: manifestFor([host.base]), targetDir: dir, log: quiet });

  assert.equal(result.ready, true);
  assert.equal(result.downloaded, 2);
  assert.equal(result.bytes, BODIES["config.json"].length + BODIES["onnx/model_int8.onnx"].length);
  assert.equal(await fs.readFile(path.join(dir, "onnx", "model_int8.onnx"), "utf8"), BODIES["onnx/model_int8.onnx"]);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8")).revision, "a".repeat(40));
  assert.deepEqual(await fs.readdir(path.join(dir, "onnx")), ["model_int8.onnx"], "no .part file is left behind");
});

test("a second run re-fetches nothing", async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const dir = await stageDir();
  const manifest = manifestFor([host.base]);

  await downloadDenseModel({ manifest, targetDir: dir, log: quiet });
  const before = host.requests.length;
  const again = await downloadDenseModel({ manifest, targetDir: dir, log: quiet });

  assert.equal(again.ready, true);
  assert.equal(again.downloaded, 0);
  assert.equal(host.requests.length, before, "files whose digest already matches are not requested again");
});

test("bytes that do not match the manifest are refused and never take the target name", async (t) => {
  const host = await startHost({ corrupt: new Set(["onnx/model_int8.onnx"]) });
  t.after(() => host.close());
  const dir = await stageDir();

  await assert.rejects(
    () => downloadDenseModel({ manifest: manifestFor([host.base]), targetDir: dir, log: quiet }),
    /checksum mismatch for model_int8\.onnx.*manifest says/s
  );
  await assert.rejects(() => fs.access(path.join(dir, "onnx", "model_int8.onnx")), /ENOENT/);
  assert.deepEqual(await fs.readdir(path.join(dir, "onnx")), [], "the .part file is cleaned up too");
});

test("a transfer that dies mid-body leaves no file behind", async (t) => {
  const host = await startHost({ truncate: new Set(["onnx/model_int8.onnx"]) });
  t.after(() => host.close());
  const dir = await stageDir();

  await assert.rejects(() => downloadDenseModel({ manifest: manifestFor([host.base]), targetDir: dir, log: quiet }));
  await assert.rejects(() => fs.access(path.join(dir, "onnx", "model_int8.onnx")), /ENOENT/);
});

test("an HTTP error names the file and the status, and falls through to the next source", async (t) => {
  const dead = await startHost({ fail: new Map([["config.json", 403], ["onnx/model_int8.onnx", 403]]) });
  const alive = await startHost();
  t.after(() => Promise.all([dead.close(), alive.close()]));
  const dir = await stageDir();
  const lines = [];

  const result = await downloadDenseModel({
    manifest: manifestFor([dead.base, alive.base]),
    targetDir: dir,
    log: (line) => lines.push(line)
  });

  assert.equal(result.ready, true);
  assert.ok(lines.some((line) => /source failed for config\.json.*403/.test(line)), lines.join("\n"));
});

test("every source failing reports the last reason rather than a bare false", async (t) => {
  const dead = await startHost({ fail: new Map([["config.json", 500]]) });
  t.after(() => dead.close());
  const dir = await stageDir();

  await assert.rejects(
    () => downloadDenseModel({ manifest: manifestFor([dead.base]), targetDir: dir, log: quiet }),
    /Could not fetch config\.json.*HTTP 500/s
  );
});

test("a manifest with no sources, and an offline machine, both say so before reaching the network", async () => {
  const noSources = await stageDir();
  const offline = await stageDir();
  await assert.rejects(
    () => downloadDenseModel({ manifest: manifestFor([]), targetDir: noSources, log: quiet }),
    /lists no sources/
  );
  await assert.rejects(
    () => downloadDenseModel({
      manifest: manifestFor(["http://127.0.0.1:1/model"]),
      targetDir: offline,
      log: quiet,
      env: { AI_DEV_OFFLINE: "1" }
    }),
    /AI_DEV_OFFLINE=1/
  );
});

test("a stale .part file from a killed run does not block the next one", async (t) => {
  const host = await startHost();
  t.after(() => host.close());
  const dir = await stageDir();
  await fs.mkdir(path.join(dir, "onnx"), { recursive: true });
  await fs.writeFile(path.join(dir, "onnx", `model_int8.onnx.${process.pid}.part`), "leftover");

  const result = await downloadDenseModel({ manifest: manifestFor([host.base]), targetDir: dir, log: quiet });
  assert.equal(result.ready, true);
});
