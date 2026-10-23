// Fetch relay for hosts that refuse Cloudflare's IP range.
//
// Runs on home-server, reached by the Worker over the amesvt Cloudflare
// tunnel. It exists for one reason: Google News returns HTTP 503 to a Worker
// and 200 to a residential connection, and 39 Vermont outlets have no other
// route into the feed.
//
// It is deliberately not a general proxy. Only hosts on ALLOW_HOSTS are
// fetched, only GET, only http(s), and every request needs the bearer token.
import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";

// Google News article links are opaque base64 that only Google can resolve,
// and resolving them needs two more calls to news.google.com. Those are
// blocked from a Worker exactly like the feeds are, and the decoder library
// offers no way to redirect its own fetches, so the decode runs here.
const require = createRequire(import.meta.url);
const { GoogleDecoder } = require("google-news-url-decoder");
const decoder = new GoogleDecoder();

const PORT = Number(process.env.PORT || 8790);
const TOKEN = (process.env.PROXY_TOKEN || "").trim();
const ALLOW_HOSTS = (process.env.ALLOW_HOSTS || "news.google.com")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const MAX_BYTES = Number(process.env.MAX_BYTES || 8 * 1024 * 1024);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 30000);

if (!TOKEN) {
  console.error("PROXY_TOKEN is required; refusing to start an unauthenticated relay.");
  process.exit(1);
}
const TOKEN_BYTES = Buffer.from(TOKEN);
const MAX_REDIRECTS = 5;

function hostAllowed(hostname) {
  const host = hostname.toLowerCase();
  return ALLOW_HOSTS.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

// Only the headers the generator's caching actually depends on are forwarded.
// Passing the whole inbound set through would leak the bearer token upstream.
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "accept-language",
  "user-agent",
  "if-none-match",
  "if-modified-since",
];
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "etag",
  "last-modified",
  "cache-control",
  "retry-after",
];

function unauthorized(res, reason) {
  res.writeHead(403, { "content-type": "text/plain" });
  res.end(`${reason}\n`);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://localhost:${PORT}`);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("Bad request\n");
    return;
  }

  if (requestUrl.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, allow: ALLOW_HOSTS }));
    return;
  }

  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "text/plain" });
    res.end("Method not allowed\n");
    return;
  }

  const auth = req.headers.authorization || "";
  const presented = Buffer.from(auth.startsWith("Bearer ") ? auth.slice(7) : "");
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (
    presented.length !== TOKEN_BYTES.length ||
    !timingSafeEqual(presented, TOKEN_BYTES)
  ) {
    unauthorized(res, "Forbidden");
    return;
  }

  if (requestUrl.pathname === "/decode") {
    const source = requestUrl.searchParams.get("url") || "";
    let parsedSource;
    try {
      parsedSource = new URL(source);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Bad url\n");
      return;
    }
    if (!hostAllowed(parsedSource.hostname)) {
      unauthorized(res, "Host not allowed");
      return;
    }
    try {
      const decoded = await decoder.decode(source);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(decoded));
      console.log(
        `decode ${decoded?.status ? "ok" : "miss"} ${Date.now() - started}ms`,
      );
    } catch (error) {
      // A failed decode is not fatal: the caller keeps the original link.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: false, message: error.message }));
      console.warn(`decode error ${error.message}`);
    }
    return;
  }

  const target = requestUrl.searchParams.get("url");
  if (!target) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("Missing url\n");
    return;
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("Bad url\n");
    return;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    unauthorized(res, "Scheme not allowed");
    return;
  }
  if (!hostAllowed(parsed.hostname)) {
    // The whole point of the allowlist: this must never become a way to reach
    // the home network or anything else on the internet.
    unauthorized(res, "Host not allowed");
    return;
  }

  const headers = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (value) {
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
  }

  try {
    // A redirect off the allowlist would otherwise carry the request to any
    // host, including the home network, so each hop gets the same checks as
    // the first URL.
    const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    let current = parsed;
    let upstream;
    for (let hop = 0; ; hop += 1) {
      upstream = await fetch(current.toString(), {
        headers,
        redirect: "manual",
        signal,
      });
      const location = upstream.headers.get("location");
      if (
        upstream.status < 300 ||
        upstream.status > 399 ||
        upstream.status === 304 ||
        !location
      ) {
        break;
      }
      await upstream.body?.cancel();
      if (hop === MAX_REDIRECTS) {
        throw new Error("too many redirects");
      }
      const next = new URL(location, current);
      if (
        (next.protocol !== "https:" && next.protocol !== "http:") ||
        !hostAllowed(next.hostname)
      ) {
        throw new Error(`redirect to ${next.hostname || next.protocol} not allowed`);
      }
      current = next;
    }

    const outHeaders = { "x-final-url": current.toString() };
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) {
        outHeaders[name] = value;
      }
    }

    if (upstream.status === 304) {
      res.writeHead(304, outHeaders);
      res.end();
      console.log(`304 ${parsed.hostname} ${Date.now() - started}ms`);
      return;
    }

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (buffer.length > MAX_BYTES) {
      res.writeHead(502, { "content-type": "text/plain" });
      res.end("Upstream response too large\n");
      return;
    }
    res.writeHead(upstream.status, outHeaders);
    res.end(buffer);
    console.log(
      `${upstream.status} ${parsed.hostname} ${buffer.length}B ${Date.now() - started}ms`,
    );
  } catch (error) {
    // Relay the failure as a gateway error so the generator's existing retry
    // and cooldown handling treats it like any other upstream problem.
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`Upstream fetch failed: ${error.message}\n`);
    console.warn(`502 ${parsed.hostname} ${error.message}`);
  }
});

// Loopback by default, which is right when running straight on a host beside
// cloudflared. In a container loopback would be the container's own, so the
// compose file sets 0.0.0.0 and publishes the port to the host's loopback
// only; the container is never reachable from the LAN either way.
const BIND_ADDR = process.env.BIND_ADDR || "127.0.0.1";

server.listen(PORT, BIND_ADDR, () => {
  console.log(
    `cerulean fetch relay on ${BIND_ADDR}:${PORT}, allowing ${ALLOW_HOSTS.join(", ")}`,
  );
});
