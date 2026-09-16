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
  const presented = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (presented.length !== TOKEN.length || presented !== TOKEN) {
    unauthorized(res, "Forbidden");
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
    const upstream = await fetch(parsed.toString(), {
      headers,
      redirect: "follow",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    const outHeaders = { "x-final-url": upstream.url || parsed.toString() };
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
