import assert from "node:assert/strict";
import test from "node:test";
import { bypassesProxy, describeNetworkError, openUrl, proxyFor, readSnippet } from "./http-download.mjs";
import { startModelHost, startProxy, TEST_HOST, TEST_TLS } from "../../test/fixtures/model-host.mjs";

const FILES = { "config.json": "{\"model_type\":\"xlm-roberta\"}" };
const read = async (body) => {
  let text = "";
  for await (const chunk of body) text += chunk;
  return text;
};

test("the proxy variables are read as npm reads them: lower case first, HTTPS falls back to HTTP", () => {
  const https = new URL("https://huggingface.co/x");
  const http = new URL("http://mirror.local/x");
  assert.equal(proxyFor(https, {}), null);
  assert.equal(proxyFor(https, { HTTPS_PROXY: "http://upper:1", https_proxy: "http://lower:2" }).host, "lower:2");
  assert.equal(proxyFor(https, { HTTP_PROXY: "http://only-http:3" }).host, "only-http:3", "HTTPS uses HTTP_PROXY when that is all there is");
  assert.equal(proxyFor(http, { HTTPS_PROXY: "http://secure-only:4" }), null, "plain HTTP never borrows HTTPS_PROXY");
  assert.equal(proxyFor(https, { HTTPS_PROXY: "proxy.corp:3128" }).href, "http://proxy.corp:3128/", "a value without a scheme is http://");
  assert.equal(proxyFor(https, { HTTPS_PROXY: "   " }), null, "blank is unset");
  assert.throws(() => proxyFor(https, { HTTPS_PROXY: "socks5://proxy:1080" }), /not an HTTP proxy/);
  assert.throws(() => proxyFor(https, { HTTPS_PROXY: "http://[bad" }), /not a URL/);
});

test("NO_PROXY: names, suffixes, ports, CIDR blocks and *; loopback is always direct", () => {
  const url = (value) => new URL(value);
  const list = "example.com, .corp.local *.internal.test mirror.local:8080 10.0.0.0/8 192.168.1.7";
  assert.equal(bypassesProxy(url("https://example.com/"), list), true);
  assert.equal(bypassesProxy(url("https://cdn.example.com/"), list), true, "a name covers the names under it");
  assert.equal(bypassesProxy(url("https://notexample.com/"), list), false, "but not a name that merely ends the same");
  assert.equal(bypassesProxy(url("https://a.corp.local/"), list), true);
  assert.equal(bypassesProxy(url("https://deep.b.internal.test/"), list), true);
  assert.equal(bypassesProxy(url("http://mirror.local:8080/"), list), true);
  assert.equal(bypassesProxy(url("http://mirror.local:9090/"), list), false, "a port-specific entry covers that port only");
  assert.equal(bypassesProxy(url("http://10.20.30.40/"), list), true, "CIDR");
  assert.equal(bypassesProxy(url("http://11.0.0.1/"), list), false);
  assert.equal(bypassesProxy(url("http://192.168.1.7/"), list), true);
  assert.equal(bypassesProxy(url("https://huggingface.co/"), list), false);
  assert.equal(bypassesProxy(url("https://huggingface.co/"), "*"), true);
  for (const loopback of ["http://localhost:1/", "http://127.0.0.1:1/", "http://127.9.9.9/", "http://[::1]:1/", "http://app.localhost/"]) {
    assert.equal(bypassesProxy(url(loopback), ""), true, loopback);
  }
  assert.equal(proxyFor(url("https://cdn.example.com/x"), { HTTPS_PROXY: "http://p:1", no_proxy: "example.com" }), null);
});

test("a GET follows a relative redirect and carries its Range to the CDN", async (t) => {
  const host = await startModelHost({ files: FILES, redirect: true });
  t.after(() => host.close());
  const response = await openUrl(`${host.base}/config.json`, { headers: { range: "bytes=5-" }, env: {} });
  assert.equal(response.status, 206);
  assert.equal(await read(response.body), FILES["config.json"].slice(5));
  assert.deepEqual(host.requests.map((entry) => [entry.path, entry.status, entry.range]), [
    ["/m/config.json", 302, "bytes=5-"],
    ["/cdn/config.json", 206, "bytes=5-"]
  ]);
  assert.match(response.url, /\/cdn\/config\.json$/);
});

test("plain HTTP goes to the proxy in absolute form, with credentials from the proxy URL", async (t) => {
  const host = await startModelHost({ files: FILES });
  const proxy = await startProxy({ hosts: { [TEST_HOST]: host.port }, credentials: "alice:s3cr3t pass" });
  t.after(() => Promise.all([host.close(), proxy.close()]));
  const env = { HTTP_PROXY: `http://alice:${encodeURIComponent("s3cr3t pass")}@127.0.0.1:${proxy.port}` };
  const response = await openUrl(`http://${TEST_HOST}:${host.port}/m/config.json`, { env });
  assert.equal(response.status, 200);
  assert.equal(await read(response.body), FILES["config.json"]);
  assert.deepEqual(proxy.seen, [`GET http://${TEST_HOST}:${host.port}/m/config.json`]);
  assert.equal(proxy.authorizations[0], `Basic ${Buffer.from("alice:s3cr3t pass").toString("base64")}`);
});

test("HTTPS goes through a CONNECT tunnel, and TLS is with the host, not the proxy", async (t) => {
  const host = await startModelHost({ files: FILES, tls: true });
  const proxy = await startProxy({ hosts: { [TEST_HOST]: host.port } });
  t.after(() => Promise.all([host.close(), proxy.close()]));
  const response = await openUrl(`https://${TEST_HOST}:${host.port}/m/config.json`, {
    env: { HTTPS_PROXY: proxy.url },
    ca: TEST_TLS.cert
  });
  assert.equal(response.status, 200);
  assert.equal(await read(response.body), FILES["config.json"]);
  assert.deepEqual(proxy.seen, [`CONNECT ${TEST_HOST}:${host.port}`], "the proxy saw an address and no request");
  assert.equal(host.requests[0].host, `${TEST_HOST}:${host.port}`);
});

test("a proxy that refuses says which proxy, which host and what status; 407 asks for credentials", async (t) => {
  const refusing = await startProxy({ refuseStatus: 403 });
  const guarded = await startProxy({ credentials: "u:p" });
  t.after(() => Promise.all([refusing.close(), guarded.close()]));
  await assert.rejects(
    openUrl("https://huggingface.co/Xenova/bge-m3/resolve/r/config.json", { env: { HTTPS_PROXY: refusing.url } }),
    (error) => {
      assert.match(error.message, new RegExp(`the proxy http://127\\.0\\.0\\.1:${refusing.port} refused to connect to huggingface\\.co:443 \\(HTTP 403\\)`));
      return true;
    }
  );
  await assert.rejects(
    openUrl("https://huggingface.co/x", { env: { HTTPS_PROXY: guarded.url } }),
    /HTTP 407\)\. The proxy wants credentials: put them in the proxy URL, as http:\/\/user:password@host:port\./
  );
});

test("network failures read as sentences that name the host and the next step", async (t) => {
  const closed = await startProxy();
  const port = closed.port;
  await closed.close();
  await assert.rejects(
    openUrl("https://huggingface.co/x", { env: { HTTPS_PROXY: `http://127.0.0.1:${port}` } }),
    new RegExp(`the proxy http://127\\.0\\.0\\.1:${port} refused the connection`)
  );
  await assert.rejects(openUrl(`http://127.0.0.1:${port}/x`, { env: {} }), new RegExp(`127\\.0\\.0\\.1:${port} refused the connection`));
  await assert.rejects(
    openUrl("https://no-such-host.invalid/x", { env: {} }),
    /no-such-host\.invalid could not be resolved \((?:ENOTFOUND|EAI_AGAIN)\)\. If this network reaches the internet through a proxy, set HTTPS_PROXY\./
  );
  const host = await startModelHost({ files: FILES, tls: true });
  t.after(() => host.close());
  await assert.rejects(
    openUrl(`https://127.0.0.1:${host.port}/m/config.json`, { env: {} }),
    /is not trusted \(.+\)\. If your network inspects TLS, point NODE_EXTRA_CA_CERTS at its CA certificate\./
  );
});

test("an aborted request is an AbortError, not a network sentence; redirects are bounded", async (t) => {
  const host = await startModelHost({ files: FILES, stallAfter: new Map([["config.json", 3]]) });
  t.after(() => host.close());
  const controller = new AbortController();
  const response = await openUrl(`${host.base}/config.json`, { env: {}, signal: controller.signal });
  controller.abort();
  // Mid-body, Node ends the stream with its own "aborted"; callers tell a
  // cancel from a failure by the signal, which is what the downloader does.
  await assert.rejects(read(response.body));
  const before = new AbortController();
  before.abort();
  await assert.rejects(openUrl(`${host.base}/config.json`, { env: {}, signal: before.signal }), (error) => error.name === "AbortError");

  const loop = await startModelHost({ files: FILES, redirect: true });
  t.after(() => loop.close());
  await assert.rejects(openUrl(`${loop.base}/config.json`, { env: {}, maxRedirects: 0 }), /redirected more than 0 times/);
  await assert.rejects(openUrl("ftp://example.com/x", { env: {} }), /not an http\(s\) address/);
});

test("an error page is read for its first words only, and a describer leaves aborts and refusals alone", async () => {
  const { Readable } = await import("node:stream");
  assert.equal(await readSnippet(Readable.from([Buffer.from("  Access\n denied  "), Buffer.from("x".repeat(400))]), 20), "Access denied xxxxxx");
  const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
  assert.equal(describeNetworkError(abort, new URL("https://a.b/"), null), abort);
  const odd = describeNetworkError(Object.assign(new Error("weird"), { code: "EWEIRD" }), new URL("https://a.b/"), new URL("http://p:1"));
  assert.match(odd.message, /^a\.b through the proxy http:\/\/p:1: weird$/);
  assert.match(describeNetworkError(Object.assign(new Error("x"), { code: "ECONNRESET" }), new URL("https://a.b/"), null).message, /connection to a\.b was reset/);
  assert.match(describeNetworkError(Object.assign(new Error("x"), { code: "ETIMEDOUT" }), new URL("https://a.b/"), null).message, /a\.b could not be reached \(ETIMEDOUT\)/);
  assert.match(describeNetworkError(Object.assign(new Error("x"), { code: "ENOTFOUND" }), new URL("https://a.b/"), new URL("http://p:1")).message, /the proxy http:\/\/p:1 could not be found/);
});
