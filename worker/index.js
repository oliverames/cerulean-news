// Cloudflare Worker entry point: runs the feed generator on a cron trigger and
// serves the site.
//
// This is the parked fallback, not the live build. It was written when the
// GitHub Actions publish workflow was cut off on 2026-09-05 for exhausted
// private-repo minutes, which froze the site for eleven days. The site went
// back to Actions once the macOS builds that had drained the allowance were
// moved off it; this stays deployable for the next time billing bites. The
// generator itself is unchanged, only its storage and its trigger.
import { setFileSystem } from "../src/fsx.js";
import { generateFeed, setCoverageContext } from "../src/index.js";
import {
  contentTypeFor,
  createArticleCacheStore,
  createR2FileSystem,
  normalizeKey,
} from "./storage.js";

const RSS_KEY = "site/feed.rss";
const JSON_KEY = "site/feed.json";
const AUDIT_KEY = "site/feed-audit.json";
const COVERAGE_CONTEXT_KEY = "data/coverage-context.json";

// Generated files are excluded from the static asset bundle (see
// site/.assetsignore) so these requests fall through to the Worker and are
// answered from R2, which is the only copy that is ever current.
const GENERATED_ROUTES = new Map([
  ["/feed.rss", RSS_KEY],
  ["/feed.json", JSON_KEY],
  ["/feed-audit.json", AUDIT_KEY],
]);

async function loadCoverageContextFrom(bucket) {
  try {
    const object = await bucket.get(COVERAGE_CONTEXT_KEY);
    if (!object) {
      return 0;
    }
    return setCoverageContext(JSON.parse(await object.text())).length;
  } catch (error) {
    // The context file belongs to the communications team. A typo in it must
    // degrade to "no storylines" rather than stop the run, exactly as the
    // Node path does.
    console.warn("Coverage context unavailable:", String(error));
    return 0;
  }
}

export async function runGeneration(env) {
  const bucket = env.STATE;
  setFileSystem(createR2FileSystem(bucket));
  const storylines = await loadCoverageContextFrom(bucket);
  const articleCacheStore = createArticleCacheStore(env.ARTICLE_CACHE);

  const startedMs = Date.now();
  const result = await generateFeed({
    rssOutputPath: RSS_KEY,
    jsonOutputPath: JSON_KEY,
    auditJsonOutputPath: AUDIT_KEY,
    articleCacheStore,
  });

  // The Actions workflow failed a run in which every real fetch failed, so a
  // total collection failure could never be mistaken for a quiet news day.
  // Keep that guard: throwing marks the cron invocation as failed and puts it
  // in the Workers error rate rather than logging silently.
  const healthySources = result.sourceResults.filter(
    (source) => source.ok && !source.skipped,
  );
  if (healthySources.length === 0) {
    throw new Error("No source feeds were fetched successfully.");
  }

  const summary = {
    items: result.itemCount,
    sourcesOk: healthySources.length,
    sourcesTotal: result.sourceResults.length,
    storylines,
    articleCache: articleCacheStore.stats,
    durationMs: Date.now() - startedMs,
    phases: result.crawlMetrics.phases,
  };
  console.log("Generation complete:", JSON.stringify(summary));
  return summary;
}

async function serveFromR2(env, key, request) {
  const object = await env.STATE.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", contentTypeFor(normalizeKey(key)));
  headers.set("etag", object.httpEtag);
  // The generator runs every four hours; a short cache keeps the reader fast
  // without letting a stale feed linger past the next run.
  headers.set("cache-control", "public, max-age=300, stale-while-revalidate=3600");

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

export default {
  async scheduled(event, env, _ctx) {
    // Awaited rather than handed to waitUntil: a scheduled invocation lives
    // until its promise settles (up to the 15-minute wall limit), and letting
    // the error propagate is what marks the run failed in the dashboard
    // instead of logging into the void.
    try {
      await runGeneration(env);
    } catch (error) {
      console.error("Generation failed:", error?.stack || String(error));
      throw error;
    }
  },

  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    const generatedKey = GENERATED_ROUTES.get(url.pathname);
    if (generatedKey) {
      return serveFromR2(env, generatedKey, request);
    }

    // A manual trigger for the same work the cron does, so a run can be forced
    // without waiting three hours. Guarded by a secret rather than left open,
    // because a run costs Gemini calls and hits 97 third-party sources.
    if (url.pathname === "/__run") {
      const token = request.headers.get("x-trigger-token");
      if (!env.TRIGGER_TOKEN || token !== env.TRIGGER_TOKEN) {
        return new Response("Forbidden", { status: 403 });
      }
      // Awaited, not backgrounded. waitUntil work is cancelled once the
      // response has been sent, which killed a run mid-crawl in testing;
      // the caller holds the connection for the few minutes instead.
      try {
        const summary = await runGeneration(env);
        return Response.json(summary);
      } catch (error) {
        return Response.json(
          { error: String(error?.message || error) },
          { status: 500 },
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
};
