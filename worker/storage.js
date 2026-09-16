// R2- and KV-backed storage for the Worker build.
//
// The generator addresses its state by path ("site/feed.json",
// "data/media-tracker-seed.json"). Those become R2 object keys unchanged,
// minus any leading slash that path.resolve() adds when it runs against a
// Worker's notional root directory.

export function normalizeKey(filePath) {
  return String(filePath).replace(/^\/+/, "").replace(/^\.\//, "");
}

// Maps the generator's two filesystem primitives onto an R2 bucket.
export function createR2FileSystem(bucket) {
  return {
    async readText(filePath) {
      const object = await bucket.get(normalizeKey(filePath));
      if (!object) {
        // Callers distinguish "missing" from "malformed" by catching, so a
        // miss has to reject rather than resolve to an empty string: an empty
        // string parses as malformed and would suppress the archive fallback.
        const error = new Error(`R2 object not found: ${normalizeKey(filePath)}`);
        error.code = "ENOENT";
        throw error;
      }
      return object.text();
    },
    async writeText(filePath, contents) {
      const key = normalizeKey(filePath);
      await bucket.put(key, contents, {
        httpMetadata: { contentType: contentTypeFor(key) },
      });
    },
  };
}

export function contentTypeFor(key) {
  if (key.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (key.endsWith(".rss") || key.endsWith(".xml")) {
    return "application/rss+xml; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

// KV keys are capped at 512 bytes and article URLs routinely exceed that
// (a Google News link is ~700 characters), so the URL is hashed. The entry
// itself still carries the original URL, and prefetch maps results back by
// the URL it was asked for, so nothing downstream sees the hash.
async function cacheKey(url) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(url),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Runs tasks with a bounded number in flight. A Worker allows only six
// connections to sit waiting for response headers at once, so firing 1,400
// KV reads at the runtime simultaneously buys nothing and risks tripping
// over that ceiling.
async function pooled(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

// KV will not accept a TTL under 60 seconds. Entries are kept well past their
// logical expiry because the generator's own prune keeps validator-bearing
// entries for an extra window to revalidate against; KV expiry is only the
// backstop that stops dead keys accumulating forever.
const KV_TTL_FLOOR_SECONDS = 60;
const KV_TTL_GRACE_SECONDS = 30 * 24 * 60 * 60;

function expirationTtlFor(entry, nowMs) {
  const expiresAt = Date.parse(entry?.expiresAt ?? "");
  const remainingSeconds = Number.isFinite(expiresAt)
    ? Math.floor((expiresAt - nowMs) / 1000)
    : 0;
  return Math.max(
    KV_TTL_FLOOR_SECONDS,
    remainingSeconds + KV_TTL_GRACE_SECONDS,
  );
}

// The article cache lives here rather than inside the audit JSON. Loading it
// whole cost ~80 MB of a 128 MB isolate; this loads only the entries a run
// can touch (about 1,400 of roughly 9,600) and writes back only what changed.
export function createArticleCacheStore(kv, { concurrency = 12 } = {}) {
  const stats = { reads: 0, hits: 0, writes: 0, deletes: 0 };

  return {
    stats,

    async prefetch(urls) {
      const wanted = [...new Set(urls.filter(Boolean))];
      const loaded = {};
      await pooled(wanted, concurrency, async (url) => {
        stats.reads += 1;
        const entry = await kv.get(await cacheKey(url), { type: "json" });
        if (entry) {
          stats.hits += 1;
          loaded[url] = entry;
        }
      });
      return loaded;
    },

    // Changed entries are identified by reference: the generator replaces an
    // entry object wholesale when it rewrites it, so anything still identical
    // to what prefetch handed over does not need rewriting.
    async persist(cache, loadedRefs) {
      const nowMs = Date.now();
      const previous = loadedRefs ?? new Map();
      const changed = [];
      for (const [url, entry] of Object.entries(cache)) {
        if (previous.get(url) !== entry) {
          changed.push([url, entry]);
        }
      }
      const removed = [...previous.keys()].filter((url) => !(url in cache));

      await pooled(changed, concurrency, async ([url, entry]) => {
        stats.writes += 1;
        await kv.put(await cacheKey(url), JSON.stringify(entry), {
          expirationTtl: expirationTtlFor(entry, nowMs),
        });
      });
      await pooled(removed, concurrency, async (url) => {
        stats.deletes += 1;
        await kv.delete(await cacheKey(url));
      });
    },
  };
}
