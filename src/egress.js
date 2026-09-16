// Optional egress proxy for hosts that refuse the runtime's own IP range.
//
// Google News answers a request from a Cloudflare Worker with HTTP 503 and its
// "Sorry..." interstitial, while the same URL returns 200 from a residential
// connection. It is IP reputation, not headers: a browser user-agent, a
// different Google News endpoint and the default agent all get the same 503.
// That is 39 of 97 sources and 39 Vermont outlets with no other route into the
// feed, so those fetches are relayed through a small service on a host Google
// will talk to (see worker/README.md).
//
// Unset by default. Node runs direct, exactly as before.

function proxyUrl() {
  return (process.env.FETCH_PROXY_URL || "").trim();
}

function proxyToken() {
  return (process.env.FETCH_PROXY_TOKEN || "").trim();
}

// Comma-separated hostnames. A leading dot is not needed; subdomains match on
// a suffix boundary so "google.com" would also cover "news.google.com".
function proxyHosts() {
  return (process.env.FETCH_PROXY_HOSTS || "news.google.com")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

export function shouldProxy(url) {
  if (!proxyUrl()) {
    return false;
  }
  let hostname = "";
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return proxyHosts().some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  );
}

// Rewrites a request to go through the relay, leaving it untouched when the
// relay is not configured or the host does not need it.
export function proxiedRequest(url, headers) {
  if (!shouldProxy(url)) {
    return { url, headers, proxied: false };
  }
  const target = `${proxyUrl()}?url=${encodeURIComponent(url)}`;
  const proxiedHeaders = { ...headers };
  const token = proxyToken();
  if (token) {
    proxiedHeaders.authorization = `Bearer ${token}`;
  }
  return { url: target, headers: proxiedHeaders, proxied: true };
}

// The relay reports where the upstream request actually landed. Without this
// the caller would read the relay's own URL back as the article URL, and
// articleUrlsMatch would treat every proxied item as having moved.
export function finalUrlFrom(response, requestedUrl, proxied) {
  if (proxied) {
    return response?.headers?.get?.("x-final-url") || requestedUrl;
  }
  return response?.url || requestedUrl;
}
