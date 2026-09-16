import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { downloadDenseModel, sweepOrphanParts } from "./dense-download.mjs";
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

test("a source that opens a connection and then goes silent is given up on", async (t) => {
  // Д-73: the Windows acceptance run sat past ten minutes on a CDN that sent
  // 510 MB of 542 and then nothing. `fetch` has no timeout, so the wait was
  // unbounded and the tester had to kill it.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dense-stall-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manifest = {
    model: "m", export: "e", revision: "r", dtype: "int8", dimensions: 1024,
    files: { "onnx/model_int8.onnx": "a".repeat(64) },
    sources: ["https://example.invalid/base"]
  };
  // Сирота от убитого прогона лежит ровно там, куда сейчас пойдёт загрузка.
  await fs.mkdir(path.join(dir, "onnx"), { recursive: true });
  const orphan = path.join(dir, "onnx", "model_int8.onnx.9999.part");
  await fs.writeFile(orphan, "abandoned");
  const longAgo = new Date(Date.now() - 2 * 60 * 60_000);
  await fs.utimes(orphan, longAgo, longAgo);

  const started = Date.now();
  const failure = await downloadDenseModel({
    manifest,
    targetDir: dir,
    stallMs: 150,
    log: () => {},
    // One chunk, then silence for as long as anyone is willing to wait.
    fetchImpl: (_url, options) => Promise.resolve({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("first chunk"));
          options?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
        }
      })
    })
  }).then(() => null, (error) => error);

  assert.ok(failure, "the download should have failed rather than waited");
  assert.match(failure.message, /no data for 0s|no data for \d+s/);
  assert.ok(Date.now() - started < 5000, "it should give up in about the stall window, not hang");
  // Ни своего недописанного файла, ни чужого — каталог чист.
  assert.deepEqual(await fs.readdir(path.join(dir, "onnx")).catch(() => []), []);
});

test("a source that is slow but alive is not cut off", async (t) => {
  // Обратная сторона Д-73: таймаут перевзводится каждым куском, поэтому узкий
  // канал не обрывается — обрывается только молчащий. Если бы таймер был общим
  // дедлайном, эта загрузка не дожила бы до конца.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dense-slow-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manifest = {
    model: "m", export: "e", revision: "r", dtype: "int8", dimensions: 1024,
    files: { "onnx/model_int8.onnx": "b".repeat(64) },
    sources: ["https://example.invalid/base"]
  };
  const failure = await downloadDenseModel({
    manifest,
    targetDir: dir,
    stallMs: 200,
    log: () => {},
    fetchImpl: () => Promise.resolve({
      ok: true,
      body: new ReadableStream({
        async start(controller) {
          for (let index = 0; index < 6; index += 1) {
            await new Promise((resolve) => setTimeout(resolve, 60));
            controller.enqueue(new TextEncoder().encode(`chunk ${index}`));
          }
          controller.close();
        }
      })
    })
  }).then(() => null, (error) => error);

  // 360 мс живой передачи при окне простоя 200 мс: до конца дошли, и упало уже
  // на контрольной сумме — то есть на содержимом, а не на времени.
  assert.ok(failure, "the fake bytes cannot match the manifest");
  assert.match(failure.message, /checksum mismatch/);
  assert.doesNotMatch(failure.message, /no data for/);
});

test("a .part file from a killed run is swept, one from a live run is not", async (t) => {
  // Д-73: the temporary name carries the writer's pid, so an orphan left by a
  // killed process is invisible to every later run — three piled up in one
  // macOS session. Age is the guard: a fresh .part may be a download running
  // right now in another terminal.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dense-parts-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, "model_int8.onnx");
  const orphan = `${target}.10584.part`;
  const live = `${target}.17124.part`;
  const unrelated = path.join(dir, "notes.txt");
  await fs.writeFile(orphan, "abandoned");
  await fs.writeFile(live, "in progress");
  await fs.writeFile(unrelated, "keep me");
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
  await fs.utimes(orphan, twoHoursAgo, twoHoursAgo);

  const removed = await sweepOrphanParts(target);
  assert.deepEqual(removed, ["model_int8.onnx.10584.part"]);
  assert.equal(await fs.readFile(live, "utf8"), "in progress");
  assert.equal(await fs.readFile(unrelated, "utf8"), "keep me");
});
