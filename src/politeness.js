// Per-host crawl politeness: request pacing and response-cache freshness.
//
// Hosts listed in HOST_POLICIES get stricter limits than the global defaults.
// bluecrossvt.org is the one that matters here: it is the subject of this
// feed rather than an incidental source, and it serves two listing pages the
// hourly workflow would otherwise re-download in full every run.
import { parseNonNegativeInteger } from "./utils.js";

// Blue Cross serves both listing pages with Cache-Control: max-age=86400, and
// we honor that in full: one fetch a day per page instead of 24. The cap is a
// backstop, not a policy dial — it keeps an origin advertising an absurd
// max-age from parking a source for months. Lower it if a newsroom ever needs
// to be picked up sooner than it says.
const CACHE_FRESHNESS_CAP_MS = parseNonNegativeInteger(
  process.env.RSS_CACHE_FRESHNESS_CAP_MS,
  24 * 60 * 60 * 1000,
);
const BLUE_CROSS_DELAY_MS = parseNonNegativeInteger(
  process.env.RSS_BLUECROSSVT_DELAY_MS,
  5000,
);

const HOST_POLICIES = [
  {
    hostPattern: /(^|\.)bluecrossvt\.org$/i,
    // One queue for the whole host, so the two listing pages and any article
    // page reached through a Google News result cannot overlap.
    throttleGroup: "bluecrossvt.org",
    throttleDelayMs: BLUE_CROSS_DELAY_MS,
    honorCacheControl: true,
    cacheFreshnessCapMs: CACHE_FRESHNESS_CAP_MS,
  },
];

export function politenessPolicyFor(url) {
  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }
  if (!hostname) {
    return null;
  }

  return (
    HOST_POLICIES.find((policy) => policy.hostPattern.test(hostname)) || null
  );
}

function cacheControlDirectives(value = "") {
  const directives = new Map();
  for (const part of String(value).split(",")) {
    const [name, directiveValue = ""] = part.split("=");
    const key = name.trim().toLowerCase();
    if (key) {
      directives.set(key, directiveValue.trim().replace(/^"|"$/g, ""));
    }
  }
  return directives;
}

// Translate the response's own caching instructions into an absolute instant
// before which re-fetching would be pure waste. Returns "" when the server
// gave no reusable freshness signal.
export function freshUntilFromHeaders(headers, now = new Date(), capMs = 0) {
  const getHeader = (name) => headers?.get?.(name) ?? "";
  const directives = cacheControlDirectives(getHeader("cache-control"));
  if (directives.has("no-store") || directives.has("no-cache")) {
    return "";
  }

  const maxAgeSeconds = Number.parseInt(
    directives.get("s-maxage") ?? directives.get("max-age") ?? "",
    10,
  );
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) {
    return "";
  }

  // Age counts the time the response already spent in a shared cache, so the
  // remaining lifetime is max-age minus Age, not max-age.
  const ageSeconds = Number.parseInt(getHeader("age"), 10);
  const remainingMs =
    (maxAgeSeconds - (Number.isFinite(ageSeconds) && ageSeconds > 0 ? ageSeconds : 0)) *
    1000;
  if (remainingMs <= 0) {
    return "";
  }

  const boundedMs = capMs > 0 ? Math.min(remainingMs, capMs) : remainingMs;
  return new Date(now.valueOf() + boundedMs).toISOString();
}
