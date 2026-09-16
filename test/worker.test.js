// Tests for the pieces added when the build moved from GitHub Actions to a
// Cloudflare Worker: the storage indirection, the KV-backed article cache,
// and the enrichment time budget that keeps a run inside the Worker's
// 15-minute ceiling.
import assert from "node:assert/strict";
import test from "node:test";
import { readText, resetFileSystem, setFileSystem, writeText } from "../src/fsx.js";
import { previewBackfillCandidates, selectPreviewBackfillItems } from "../src/enrich.js";
import {
  contentTypeFor,
  createArticleCacheStore,
  createR2FileSystem,
  normalizeKey,
} from "../worker/storage.js";

// A stand-in for the KV binding: get/put/delete over a Map, recording calls.
function fakeKv() {
  const store = new Map();
  const calls = { get: 0, put: 0, delete: 0 };
  return {
    store,
    calls,
    async get(key, options) {
      calls.get += 1;
      const raw = store.get(key);
      if (raw === undefined) {
        return null;
      }
      return options?.type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key, value, options) {
      calls.put += 1;
      store.set(key, value);
      store.set(`${key}::ttl`, options?.expirationTtl ?? null);
    },
    async delete(key) {
      calls.delete += 1;
      store.delete(key);
    },
  };
}

function fakeBucket(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) {
      if (!store.has(key)) {
        return null;
      }
      return { async text() { return store.get(key); } };
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

test.afterEach(() => {
  resetFileSystem();
});

test("the filesystem indirection routes reads and writes to the injected impl", async () => {
  const reads = [];
  const writes = [];
  setFileSystem({
    async readText(path) {
      reads.push(path);
      return `contents of ${path}`;
    },
    async writeText(path, contents) {
      writes.push([path, contents]);
    },
  });

  assert.equal(await readText("site/feed.json"), "contents of site/feed.json");
  await writeText("site/feed.rss", "<rss/>");
  assert.deepEqual(reads, ["site/feed.json"]);
  assert.deepEqual(writes, [["site/feed.rss", "<rss/>"]]);

  // Resetting must restore the real filesystem, or one test would leak its
  // stub into every later test in the run.
  resetFileSystem();
  await assert.rejects(() => readText("definitely/not/a/real/path.json"));
});

test("R2 reads reject on a miss rather than returning empty", async () => {
  // loadPreviousState distinguishes "missing" from "malformed" by catching.
  // Resolving to "" would parse as malformed and suppress the fallback to the
  // public feed, silently rebuilding the archive from nothing.
  const fs = createR2FileSystem(fakeBucket());
  await assert.rejects(() => fs.readText("site/feed-audit.json"), /not found/);
});

test("R2 keys drop the leading slash a Worker's path.resolve adds", () => {
  assert.equal(normalizeKey("/site/feed.json"), "site/feed.json");
  assert.equal(normalizeKey("./data/seed.json"), "data/seed.json");
  assert.equal(normalizeKey("site/feed.json"), "site/feed.json");
});

test("R2 writes carry a content type the reader can use", async () => {
  const bucket = fakeBucket();
  const fs = createR2FileSystem(bucket);
  await fs.writeText("site/feed.json", "{}");
  assert.equal(bucket.store.get("site/feed.json"), "{}");
  assert.equal(contentTypeFor("site/feed.json"), "application/json; charset=utf-8");
  assert.equal(contentTypeFor("site/feed.rss"), "application/rss+xml; charset=utf-8");
});

test("the article cache store loads only the keys a run asks for", async () => {
  const kv = fakeKv();
  const store = createArticleCacheStore(kv);
  const entry = { url: "https://example.com/a", expiresAt: "2099-01-01T00:00:00.000Z" };
  await store.persist({ "https://example.com/a": entry }, new Map());

  const loaded = await store.prefetch([
    "https://example.com/a",
    "https://example.com/absent",
  ]);
  assert.deepEqual(Object.keys(loaded), ["https://example.com/a"]);
  assert.equal(loaded["https://example.com/a"].url, "https://example.com/a");
});

test("a URL longer than KV's 512-byte key limit still round-trips", async () => {
  // Google News links routinely run to several hundred characters, so keys
  // are hashed rather than used directly.
  const kv = fakeKv();
  const store = createArticleCacheStore(kv);
  const longUrl = `https://news.google.com/rss/articles/${"A".repeat(900)}`;
  const entry = { url: longUrl, expiresAt: "2099-01-01T00:00:00.000Z" };

  await store.persist({ [longUrl]: entry }, new Map());
  for (const key of kv.store.keys()) {
    assert.ok(key.length <= 512, `key too long: ${key.length}`);
  }
  const loaded = await store.prefetch([longUrl]);
  assert.equal(loaded[longUrl].url, longUrl);
});

test("persist writes only changed entries and deletes pruned ones", async () => {
  const kv = fakeKv();
  const store = createArticleCacheStore(kv);
  const untouched = { url: "a", expiresAt: "2099-01-01T00:00:00.000Z" };
  const replaced = { url: "b", expiresAt: "2099-01-01T00:00:00.000Z" };
  const loaded = new Map([
    ["https://example.com/a", untouched],
    ["https://example.com/b", replaced],
    ["https://example.com/gone", { url: "gone", expiresAt: "2099-01-01T00:00:00.000Z" }],
  ]);

  const cache = {
    // same object identity: untouched, must not be rewritten
    "https://example.com/a": untouched,
    // replaced wholesale by the generator: must be written
    "https://example.com/b": { url: "b", expiresAt: "2099-06-01T00:00:00.000Z" },
    // "gone" was pruned out of the cache: must be deleted
  };

  kv.calls.put = 0;
  kv.calls.delete = 0;
  await store.persist(cache, loaded);
  assert.equal(kv.calls.put, 1, "only the replaced entry is written");
  assert.equal(kv.calls.delete, 1, "the pruned entry is deleted");
});

test("cache entries get a KV expiry no shorter than the floor", async () => {
  const kv = fakeKv();
  const store = createArticleCacheStore(kv);
  // Already expired: the generator keeps it briefly for revalidation, so the
  // TTL must still be a legal KV value rather than a negative number.
  const stale = { url: "s", expiresAt: "2000-01-01T00:00:00.000Z" };
  await store.persist({ "https://example.com/s": stale }, new Map());
  const ttls = [...kv.store.entries()]
    .filter(([key]) => key.endsWith("::ttl"))
    .map(([, value]) => value);
  assert.equal(ttls.length, 1);
  assert.ok(ttls[0] >= 60, `ttl below KV's floor: ${ttls[0]}`);
});

test("backfill candidates match the selection's cache-independent filter", () => {
  const archived = [
    {
      link: "https://www.vtdigger.org/paywalled",
      title: "Paywalled story",
      sourceName: "VTDigger",
      pubDate: "2026-09-01T00:00:00.000Z",
      relevant: true,
      previewChecked: false,
    },
    {
      link: "https://example.com/already-checked",
      title: "Already checked",
      sourceName: "Example",
      pubDate: "2026-09-01T00:00:00.000Z",
      relevant: true,
      previewChecked: true,
    },
    {
      link: "https://example.com/rejected",
      title: "Rejected",
      sourceName: "Example",
      pubDate: "2026-09-01T00:00:00.000Z",
      relevant: false,
      previewChecked: false,
    },
  ];

  const candidates = previewBackfillCandidates(archived, []);
  // Whatever the paywall heuristic decides, the candidate set must never
  // include an item the selection would reject on its own filters, or the
  // Worker would prefetch keys it cannot use and miss keys it needs.
  for (const item of candidates) {
    assert.notEqual(item.relevant, false);
    assert.notEqual(item.previewChecked, true);
  }
  const selected = selectPreviewBackfillItems(archived, [], 25, {}, new Date());
  const candidateLinks = new Set(candidates.map((item) => item.link));
  for (const item of selected) {
    assert.ok(
      candidateLinks.has(item.link),
      `selection returned ${item.link}, which prefetch would not have loaded`,
    );
  }
});

test("a fresh cached error keeps an item out of the backfill", () => {
  const now = new Date("2026-09-10T00:00:00.000Z");
  const archived = [
    {
      link: "https://www.vtdigger.org/paywalled",
      title: "Paywalled story",
      sourceName: "VTDigger",
      pubDate: "2026-09-01T00:00:00.000Z",
      relevant: true,
      previewChecked: false,
    },
  ];
  const candidates = previewBackfillCandidates(archived, []);
  if (candidates.length === 0) {
    return; // the paywall heuristic excluded it; nothing to assert here
  }
  const articleCache = {
    "https://www.vtdigger.org/paywalled": {
      articleError: "HTTP 403",
      expiresAt: "2026-09-11T00:00:00.000Z",
    },
  };
  assert.deepEqual(
    selectPreviewBackfillItems(archived, [], 25, articleCache, now),
    [],
  );
});

test("an exhausted time budget defers article fetches without caching a verdict", async () => {
  const { enrichAndFilterItems } = await import("../src/enrich.js");
  const previous = process.env.RSS_ENRICH_BUDGET_MS;
  // Any positive budget is already spent by the time the first item is
  // considered, so every fetch this run must be deferred.
  process.env.RSS_ENRICH_BUDGET_MS = "1";
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const articleCache = {};
    const metrics = { enrichment: {} };
    let fetched = 0;
    await enrichAndFilterItems(
      [
        {
          link: "https://example.com/story",
          title: "Blue Cross rate filing hearing",
          feedContent: "Blue Cross and Blue Shield of Vermont rate filing",
          sourceName: "Example",
          pubDate: "2026-09-16T00:00:00.000Z",
          articleScanMode: "always",
        },
      ],
      new Map(),
      {
        articleCache,
        metrics,
        now: new Date("2026-09-16T01:00:00.000Z"),
        fetchText: async () => {
          fetched += 1;
          return { text: "<html></html>", url: "https://example.com/story" };
        },
        throttleRequest: async () => {},
      },
    );

    assert.equal(fetched, 0, "no article should be fetched past the budget");
    assert.equal(metrics.enrichment.articleFetchDeferred, 1);
    // Nothing may be written to the cache, or the deferred item would look
    // settled and never be scanned on a later run.
    assert.deepEqual(Object.keys(articleCache), []);
  } finally {
    if (previous === undefined) {
      delete process.env.RSS_ENRICH_BUDGET_MS;
    } else {
      process.env.RSS_ENRICH_BUDGET_MS = previous;
    }
  }
});

test("no budget means no deadline", async () => {
  const { enrichAndFilterItems } = await import("../src/enrich.js");
  const previous = process.env.RSS_ENRICH_BUDGET_MS;
  delete process.env.RSS_ENRICH_BUDGET_MS;
  try {
    const metrics = { enrichment: {} };
    let fetched = 0;
    await enrichAndFilterItems(
      [
        {
          link: "https://example.com/story",
          title: "Blue Cross rate filing hearing",
          feedContent: "Blue Cross and Blue Shield of Vermont rate filing",
          sourceName: "Example",
          pubDate: "2026-09-16T00:00:00.000Z",
          articleScanMode: "always",
        },
      ],
      new Map(),
      {
        articleCache: {},
        metrics,
        now: new Date("2026-09-16T01:00:00.000Z"),
        fetchText: async () => {
          fetched += 1;
          return { text: "<html></html>", url: "https://example.com/story" };
        },
        throttleRequest: async () => {},
      },
    );
    assert.equal(fetched, 1, "the default must not defer anything");
    assert.ok(!metrics.enrichment.articleFetchDeferred);
  } finally {
    if (previous !== undefined) {
      process.env.RSS_ENRICH_BUDGET_MS = previous;
    }
  }
});

// --- egress relay -----------------------------------------------------------
// Google News refuses Cloudflare's IP range, so those fetches are relayed
// through a host it will talk to. Everything else must stay direct.

async function withEnv(vars, run) {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("no relay configured means every fetch stays direct", async () => {
  const { shouldProxy, proxiedRequest } = await import("../src/egress.js");
  await withEnv({ FETCH_PROXY_URL: undefined }, () => {
    assert.equal(shouldProxy("https://news.google.com/rss/search?q=x"), false);
    const request = proxiedRequest("https://news.google.com/rss", { accept: "*/*" });
    assert.equal(request.url, "https://news.google.com/rss");
    assert.equal(request.proxied, false);
  });
});

test("only allowlisted hosts are relayed", async () => {
  const { shouldProxy } = await import("../src/egress.js");
  await withEnv(
    { FETCH_PROXY_URL: "https://relay.example/fetch", FETCH_PROXY_HOSTS: undefined },
    () => {
      assert.equal(shouldProxy("https://news.google.com/rss/search?q=x"), true);
      // Suffix match on a dot boundary, so a lookalike domain must not match.
      assert.equal(shouldProxy("https://news.google.com.evil.test/"), false);
      assert.equal(shouldProxy("https://vtdigger.org/feed/"), false);
      assert.equal(shouldProxy("not a url"), false);
    },
  );
});

test("a relayed request carries the target url and the bearer token", async () => {
  const { proxiedRequest } = await import("../src/egress.js");
  await withEnv(
    {
      FETCH_PROXY_URL: "https://relay.example/fetch",
      FETCH_PROXY_TOKEN: "s3cret",
    },
    () => {
      const target = "https://news.google.com/rss/search?q=a+b&hl=en-US";
      const request = proxiedRequest(target, { accept: "application/rss+xml" });
      assert.equal(request.proxied, true);
      assert.equal(
        request.url,
        `https://relay.example/fetch?url=${encodeURIComponent(target)}`,
      );
      assert.equal(request.headers.authorization, "Bearer s3cret");
      // Caching headers must survive the rewrite or every relayed fetch
      // would come back unconditional.
      assert.equal(request.headers.accept, "application/rss+xml");
    },
  );
});

test("a relayed response reports the upstream url, not the relay's", async () => {
  const { finalUrlFrom } = await import("../src/egress.js");
  const upstream = "https://news.google.com/rss/search?q=x";
  const relayResponse = {
    url: "https://relay.example/fetch?url=...",
    headers: { get: (name) => (name === "x-final-url" ? upstream : null) },
  };
  // Without this the article URL would read as the relay, and
  // articleUrlsMatch would treat every relayed item as having moved.
  assert.equal(finalUrlFrom(relayResponse, upstream, true), upstream);

  const directResponse = { url: "https://vtdigger.org/feed/", headers: { get: () => null } };
  assert.equal(
    finalUrlFrom(directResponse, "https://vtdigger.org/feed/", false),
    "https://vtdigger.org/feed/",
  );
  // A relay that forgets the header falls back to what was requested.
  assert.equal(
    finalUrlFrom({ headers: { get: () => null } }, upstream, true),
    upstream,
  );
});
