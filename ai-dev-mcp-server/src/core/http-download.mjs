/**
 * One HTTP(S) request at a time, through the proxy the environment names.
 *
 * The model download used `fetch`, and Node's `fetch` reads no proxy variable
 * unless the process was started with `NODE_USE_ENV_PROXY=1` — which nobody
 * running `npm run setup` sets. Behind a corporate proxy the download failed
 * with a bare "fetch failed" while curl, npm and git in the same shell went
 * through (docs/DEFECTS.md, Д-98). This module reads `HTTPS_PROXY`,
 * `HTTP_PROXY` and `NO_PROXY` the way npm and curl do, tunnels HTTPS through
 * the proxy with `CONNECT`, and turns the network's failures into sentences
 * that name the host and say what to try.
 *
 * It is deliberately small: GET and HEAD, redirects, no keep-alive, no
 * decompression. The response body is handed back as a stream, so the caller
 * decides how bytes reach the disk — and where a `Range` resumes them.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import process from "node:process";
import tls from "node:tls";

/** Redirects followed before a source is given up on. */
export const MAX_REDIRECTS = 10;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** What the requests say they are. Mirrors log it; nothing depends on it. */
const USER_AGENT = "ai-dev-system-model-download";

/**
 * A URL, or a setting meant to be one, with its credentials replaced by `***`.
 *
 * Proxy and mirror addresses carry a user name and password when the network
 * wants them — the documentation says to put them there — and every message,
 * `--json` answer and `.part.json` that names a source is the kind of text
 * that ends up pasted into an issue (docs/DEFECTS.md, Д-151).
 *
 * @param {string|URL} text
 * @returns {string}
 */
export function redactCredentials(text) {
  return String(text ?? "")
    .replace(/(\/\/)[^/@\s]+@/g, "$1***@")
    .replace(/^[^/:@\s]+:[^/@\s]*@/, "***@");
}

/**
 * A proxy variable as npm and undici read it: the lower-case spelling first.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} name - Upper-case name.
 * @returns {string}
 */
function envValue(env, name) {
  for (const key of [name.toLowerCase(), name]) {
    const value = env[key];
    if (value !== undefined && String(value).trim() !== "") return String(value).trim();
  }
  return "";
}

/** IPv4 dotted quad → 32-bit number, or null. */
function ipv4Number(host) {
  if (net.isIPv4(host) === false) return null;
  return host.split(".").reduce((total, part) => (total * 256) + Number(part), 0);
}

/** The bare host: no brackets around an IPv6 literal, lower case, no trailing dot. */
function bareHost(hostname) {
  return String(hostname).replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/** The port a URL names or implies. */
function urlPort(url) {
  return Number(url.port) || (url.protocol === "https:" ? 443 : 80);
}

/**
 * Whether this host goes to the network directly rather than through a proxy.
 *
 * `NO_PROXY` entries are separated by commas or spaces; `*` covers everything;
 * `example.com`, `.example.com` and `*.example.com` all cover the domain and
 * every name under it; `host:port` covers only that port; an IPv4 entry may be
 * a CIDR block (`10.0.0.0/8`), which is how most corporate lists are written.
 * Loopback is always direct, as in browsers: a mirror on this machine never
 * goes out to a proxy and back.
 *
 * @param {URL} url
 * @param {string} noProxy
 * @returns {boolean}
 */
export function bypassesProxy(url, noProxy) {
  const host = bareHost(url.hostname);
  const port = urlPort(url);
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const address = ipv4Number(host);
  if (address !== null && address >>> 24 === 127) return true;
  for (const raw of String(noProxy ?? "").split(/[\s,]+/)) {
    let entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    let entryPort = 0;
    const portMatch = entry.match(/^(.*[^:\]]|\[[^\]]+\]):(\d+)$/);
    if (portMatch && !net.isIPv6(entry)) {
      entry = portMatch[1];
      entryPort = Number(portMatch[2]);
    }
    if (entryPort && entryPort !== port) continue;
    entry = bareHost(entry.replace(/^\*?\./, ""));
    const cidr = entry.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
    if (cidr) {
      const base = ipv4Number(cidr[1]);
      const bits = Number(cidr[2]);
      if (address === null || base === null || bits > 32) continue;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if (((address & mask) >>> 0) === ((base & mask) >>> 0)) return true;
      continue;
    }
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * The proxy a request to `url` goes through, or null for a direct connection.
 *
 * HTTPS uses `HTTPS_PROXY`, falling back to `HTTP_PROXY`; plain HTTP uses
 * `HTTP_PROXY`. A value without a scheme is read as `http://` — `proxy:3128`
 * is how many people write it. SOCKS is refused by name rather than
 * misunderstood as HTTP.
 *
 * @param {URL|string} target
 * @param {Record<string, string|undefined>} [env]
 * @returns {URL|null}
 */
export function proxyFor(target, env = process.env) {
  const url = target instanceof URL ? target : new URL(String(target));
  const value = url.protocol === "https:"
    ? envValue(env, "HTTPS_PROXY") || envValue(env, "HTTP_PROXY")
    : envValue(env, "HTTP_PROXY");
  if (!value || bypassesProxy(url, envValue(env, "NO_PROXY"))) return null;
  let proxy;
  try {
    proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`);
  } catch {
    throw new Error(`The proxy setting "${redactCredentials(value)}" is not a URL. Write it as http://host:port.`);
  }
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error(`The proxy ${proxy.protocol}//${proxy.host} is not an HTTP proxy, and only HTTP proxies are supported. `
      + "Point HTTPS_PROXY at an http:// or https:// proxy.");
  }
  return proxy;
}

/** `Proxy-Authorization` for a proxy URL that carries credentials. */
function proxyAuthorization(proxy) {
  if (!proxy.username && !proxy.password) return {};
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { "proxy-authorization": `Basic ${Buffer.from(credentials).toString("base64")}` };
}

/**
 * What a 407 asks of the person. A proxy that offers only NTLM, Negotiate or
 * Kerberos cannot be answered with a password in its URL, however many times
 * it is typed there; one that offers Basic and still refuses did not take the
 * one given.
 *
 * @param {URL} proxy
 * @param {string|string[]|undefined} challenge - `Proxy-Authenticate`.
 * @returns {string}
 */
function signInHint(proxy, challenge) {
  const schemes = [challenge ?? []].flat().join(",").toLowerCase();
  if (schemes && !/\bbasic\b/.test(schemes)) {
    const named = /negotiate|kerberos/.test(schemes) ? "Negotiate (Kerberos)" : /ntlm/.test(schemes) ? "NTLM" : "a sign-in";
    return ` The proxy asks for ${named}, which this download does not speak: point HTTPS_PROXY at a local proxy that `
      + "signs in for it (cntlm, px), or copy the model from a machine that has it: `npm run model -- import <folder or .zip>`.";
  }
  if (proxy.username || proxy.password) return " The proxy did not accept the user name and password in the proxy URL.";
  return " The proxy wants credentials: put them in the proxy URL, as http://user:password@host:port.";
}

/** A proxy named without its credentials, for messages. */
function describeProxy(proxy) {
  return `${proxy.protocol}//${proxy.host}`;
}

/** A host as `CONNECT` and `Host` spell it: IPv6 in brackets. */
function authority(host, port) {
  return `${net.isIPv6(host) ? `[${host}]` : host}:${port}`;
}

/**
 * An error that says what the network did, in words.
 *
 * Node's own messages — `getaddrinfo ENOTFOUND huggingface.co`,
 * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` — name a condition and stop there; the
 * person reading them has just asked for a model and needs the next step.
 *
 * @param {Error & { code?: string }} error
 * @param {URL} url
 * @param {URL|null} proxy
 * @returns {Error}
 */
export function describeNetworkError(error, url, proxy) {
  if (error?.name === "AbortError" || error?.proxyRefusal) return error;
  const host = bareHost(url.hostname);
  const via = proxy ? ` through the proxy ${describeProxy(proxy)}` : "";
  const code = String(error?.code ?? "");
  let message;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    message = proxy
      ? `the proxy ${describeProxy(proxy)} could not be found (${code}).`
      : `${host} could not be resolved (${code}). If this network reaches the internet through a proxy, set HTTPS_PROXY.`;
  } else if (code === "ECONNREFUSED") {
    message = proxy ? `the proxy ${describeProxy(proxy)} refused the connection.` : `${host}:${urlPort(url)} refused the connection.`;
  } else if (code === "ECONNRESET" || code === "EPIPE") {
    message = `the connection to ${host}${via} was reset.`;
  } else if (code === "ETIMEDOUT" || code === "ENETUNREACH" || code === "EHOSTUNREACH") {
    message = `${host}${via} could not be reached (${code}).`;
  } else if (/CERT|SELF_SIGNED|UNABLE_TO|ERR_TLS/.test(code)) {
    message = `the TLS certificate ${host} presented${via} is not trusted (${code}). If your network inspects TLS, `
      + "point NODE_EXTRA_CA_CERTS at its CA certificate.";
  } else {
    message = `${host}${via}: ${error?.message ?? error}`;
  }
  const described = new Error(message);
  described.code = code || undefined;
  described.cause = error;
  return described;
}

/**
 * A socket to `host:port` through the proxy, opened with `CONNECT`.
 *
 * @returns {Promise<import("node:net").Socket>}
 */
function tunnel(proxy, host, port, signal) {
  return new Promise((resolve, reject) => {
    const client = proxy.protocol === "https:" ? https : http;
    const request = client.request({
      host: bareHost(proxy.hostname),
      port: urlPort(proxy),
      method: "CONNECT",
      path: authority(host, port),
      headers: { host: authority(host, port), "user-agent": USER_AGENT, ...proxyAuthorization(proxy) },
      agent: false,
      signal
    });
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        const status = response.statusCode;
        const hint = status === 407 ? signInHint(proxy, response.headers["proxy-authenticate"]) : "";
        const refused = new Error(`the proxy ${describeProxy(proxy)} refused to connect to ${authority(host, port)} (HTTP ${status}).${hint}`);
        refused.proxyRefusal = true;
        refused.status = status;
        reject(refused);
        return;
      }
      if (head?.length) socket.unshift(head);
      resolve(socket);
    });
    request.once("error", reject);
    request.end();
  });
}

/**
 * Send one request and resolve with the response once its headers arrive.
 *
 * @returns {Promise<import("node:http").IncomingMessage>}
 */
function requestOnce(url, { method, headers, env, signal, ca }) {
  const proxy = proxyFor(url, env);
  const host = bareHost(url.hostname);
  const port = urlPort(url);
  const sent = { "user-agent": USER_AGENT, accept: "*/*", "accept-encoding": "identity", ...headers };
  return new Promise((resolve, reject) => {
    let request;
    if (!proxy) {
      request = (url.protocol === "https:" ? https : http).request(url, { method, headers: sent, agent: false, signal, ...(ca ? { ca } : {}) });
    } else if (url.protocol === "http:") {
      // Plain HTTP goes to the proxy in absolute form; the proxy fetches it.
      request = (proxy.protocol === "https:" ? https : http).request({
        host: bareHost(proxy.hostname),
        port: urlPort(proxy),
        method,
        path: url.href,
        headers: { ...sent, host: url.host, ...proxyAuthorization(proxy) },
        agent: false,
        signal
      });
    } else {
      // HTTPS through the proxy: a CONNECT tunnel, then TLS to the host itself,
      // so the proxy sees an address and never the request.
      request = https.request(url, {
        method,
        headers: sent,
        signal,
        createConnection: (_options, done) => {
          tunnel(proxy, host, port, signal).then((socket) => {
            // `host` is what the certificate is checked against; without it
            // Node falls back to the name the socket was opened with — the
            // proxy's — and an IP-literal target was never checked against
            // its own address (docs/DEFECTS.md, Д-152). SNI takes names only.
            const secure = tls.connect({
              socket,
              host,
              ...(net.isIP(host) ? {} : { servername: host }),
              ...(ca ? { ca } : {}),
              ALPNProtocols: ["http/1.1"]
            });
            done(null, secure);
          }, (error) => done(error));
          return undefined;
        }
      });
    }
    request.once("response", resolve);
    request.once("error", (error) => reject(describeNetworkError(error, url, proxy)));
    request.end();
  });
}

/**
 * Open a URL with GET or HEAD and follow its redirects.
 *
 * Headers travel with every hop, `Range` included: a model host answers with a
 * redirect to a CDN, and the CDN is the one that has to resume. A 303 turns
 * the request into a GET, as the standard says.
 *
 * @param {string|URL} target
 * @param {object} [options]
 * @param {"GET"|"HEAD"} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {Record<string, string|undefined>} [options.env] - Where the proxy variables are read.
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.maxRedirects]
 * @param {string|Buffer} [options.ca] - Trust only this CA; tests serve TLS with their own. Users have NODE_EXTRA_CA_CERTS.
 * @returns {Promise<{ status: number, headers: object, body: import("node:http").IncomingMessage, url: string }>}
 */
export async function openUrl(target, { method = "GET", headers = {}, env = process.env, signal, maxRedirects = MAX_REDIRECTS, ca } = {}) {
  let url = new URL(String(target));
  let verb = method;
  for (let hop = 0; ; hop += 1) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${url.href} is not an http(s) address.`);
    }
    const response = await requestOnce(url, { method: verb, headers, env, signal, ca });
    const location = response.headers.location;
    if (!REDIRECTS.has(response.statusCode) || !location) {
      return { status: response.statusCode, headers: response.headers, body: response, url: url.href };
    }
    response.resume();
    if (hop >= maxRedirects) throw new Error(`${target} redirected more than ${maxRedirects} times.`);
    url = new URL(location, url);
    if (response.statusCode === 303 && verb !== "HEAD") verb = "GET";
  }
}

/**
 * The first bytes of a response body as text, for an error message.
 *
 * @param {import("node:stream").Readable} body
 * @param {number} [limit]
 * @returns {Promise<string>}
 */
export async function readSnippet(body, limit = 200) {
  let text = "";
  try {
    for await (const chunk of body) {
      text += chunk.toString("utf8");
      if (text.length >= limit) break;
    }
  } catch {
    // An error page that cannot be read is still an error page.
  } finally {
    body.destroy();
  }
  return text.replace(/\s+/g, " ").trim().slice(0, limit);
}
