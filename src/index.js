// Feed generator entry point: wires collection, enrichment, archive merge,
// relevance, summaries, alerts, and outputs together, and re-exports the
// public surface tests and tooling import from this module.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parsePositiveInteger, sortItemsByDate } from "./utils.js";
import { buildSourcesFromEnv } from "./sources.js";
import { collectFeedItems } from "./fetching.js";
import {
  enrichAndFilterItems,
  selectPreviewBackfillItems,
} from "./enrich.js";
import { applyDeterministicRelevance } from "./relevance.js";
import {
  dedupeResolvedItems,
  loadPreviousState,
  mergeWithArchive,
} from "./archive.js";
import { summarizeItems } from "./summaries.js";
import {
  applyFailureStreaks,
  selectFailureAlerts,
  triggerWebhooks,
} from "./alerts.js";
import { buildJsonSummary, buildRss, writeOutput } from "./outputs.js";

function resolveRssOutputPath() {
  if (process.env.RSS_OUTPUT_PATH) {
    return path.resolve(process.cwd(), process.env.RSS_OUTPUT_PATH);
  }

  return path.resolve(process.cwd(), "site", "feed.rss");
}

function resolveJsonOutputPath(rssOutputPath) {
  if (process.env.JSON_OUTPUT_PATH) {
    return path.resolve(process.cwd(), process.env.JSON_OUTPUT_PATH);
  }

  return path.join(path.dirname(rssOutputPath), "feed.json");
}

function resolveAuditJsonOutputPath(rssOutputPath) {
  if (process.env.AUDIT_JSON_OUTPUT_PATH) {
    return path.resolve(process.cwd(), process.env.AUDIT_JSON_OUTPUT_PATH);
  }

  return path.join(path.dirname(rssOutputPath), "feed-audit.json");
}

function createCrawlMetrics(sources, startedAt) {
  return {
    startedAt: startedAt.toISOString(),
    finishedAt: "",
    durationMs: 0,
    phases: {},
    collection: {
      sourceCount: sources.length,
      sourceFetches: 0,
      sourceFailures: 0,
      sourceFallbacks: 0,
      sourceCooldowns: 0,
      notModifiedFeeds: 0,
      cacheFreshSkips: 0,
      skippedSources: 0,
      feedItemsCollected: 0,
      dedupedFeedItems: 0,
    },
    enrichment: {
      itemsSeen: 0,
      matchedCacheHits: 0,
      articleCacheHits: 0,
      negativeCacheHits: 0,
      articleFetches: 0,
      articleFetchSkipped: 0,
      articleNotModified: 0,
      articleErrors: 0,
      previewFetches: 0,
      previewCacheHits: 0,
      previewsFound: 0,
      previewUnavailable: 0,
      previewBackfillItems: 0,
      commentsFound: 0,
      scanModes: {},
    },
  };
}

async function measurePhase(metrics, name, callback) {
  const startedMs = Date.now();
  try {
    return await callback();
  } finally {
    metrics.phases[`${name}Ms`] = Date.now() - startedMs;
  }
}

function finishCrawlMetrics(metrics, startedMs) {
  metrics.finishedAt = new Date().toISOString();
  metrics.durationMs = Date.now() - startedMs;
}

export async function generateFeed({
  sources = buildSourcesFromEnv(),
  now = new Date(),
  rssOutputPath = resolveRssOutputPath(),
  jsonOutputPath = resolveJsonOutputPath(rssOutputPath),
  auditJsonOutputPath = resolveAuditJsonOutputPath(rssOutputPath),
} = {}) {
  const runStartedAt = new Date();
  const runStartedMs = Date.now();
  const crawlMetrics = createCrawlMetrics(sources, runStartedAt);
  const {
    cache,
    archivedItems,
    previousFailureStreaks,
    crawlState,
  } = await measurePhase(crawlMetrics, "load", () =>
    loadPreviousState(auditJsonOutputPath, jsonOutputPath),
  );
  const collected = await measurePhase(crawlMetrics, "collect", () =>
    collectFeedItems(sources, now, crawlState, crawlMetrics),
  );
  const items = collected.items;
  const previewBackfillItems = selectPreviewBackfillItems(
    archivedItems,
    items,
    parsePositiveInteger(process.env.RSS_PREVIEW_BACKFILL_MAX_PER_RUN, 25),
    crawlState.articleCache,
    now,
  );
  crawlMetrics.enrichment.previewBackfillItems = previewBackfillItems.length;
  if (previewBackfillItems.length > 0) {
    console.log(
      `Backfilling previews for ${previewBackfillItems.length} archived paywall items`,
    );
  }
  const enrichmentItems = [...items, ...previewBackfillItems];
  // Streaks ride along in the published sources array, so the audit JSON
  // doubles as the source-rot dashboard and the persistence layer.
  const sourceResults = applyFailureStreaks(
    collected.sourceResults,
    previousFailureStreaks,
  );

  // Alert (asynchronously) only for sources that just crossed the
  // consecutive-failure threshold.
  triggerWebhooks(selectFailureAlerts(sourceResults)).catch(err => console.error("Webhook trigger error:", err));

  const currentMatched = await measurePhase(crawlMetrics, "enrich", () =>
    enrichAndFilterItems(enrichmentItems, cache, {
      articleCache: crawlState.articleCache,
      metrics: crawlMetrics,
      now,
    }),
  );
  const matchedItems = await measurePhase(crawlMetrics, "merge", async () =>
    dedupeResolvedItems(
      sortItemsByDate(mergeWithArchive(currentMatched, archivedItems, now)),
    ).map(applyDeterministicRelevance),
  );
  await measurePhase(crawlMetrics, "summarize", () =>
    summarizeItems(matchedItems),
  );
  finishCrawlMetrics(crawlMetrics, runStartedMs);
  const rss = buildRss(matchedItems, { now });
  const jsonSummary = buildJsonSummary(matchedItems, sourceResults, now);
  const auditJsonSummary = buildJsonSummary(matchedItems, sourceResults, now, {
    includeRejected: true,
    feedUrl: "",
    crawlMetrics,
    crawlState,
  });

  await writeOutput(
    rss,
    jsonSummary,
    auditJsonSummary,
    rssOutputPath,
    jsonOutputPath,
    auditJsonOutputPath,
  );

  return {
    rssOutputPath,
    jsonOutputPath,
    auditJsonOutputPath,
    sourceResults,
    itemCount: matchedItems.length,
    items: matchedItems,
    crawlMetrics,
    crawlState,
  };
}

async function main() {
  const result = await generateFeed();
  // Skipped sources are ok-by-definition; don't let them mask a run where
  // every real fetch failed.
  const healthySources = result.sourceResults.filter(
    (source) => source.ok && !source.skipped,
  );

  if (healthySources.length === 0) {
    throw new Error("No source feeds were fetched successfully.");
  }

  console.log(`Wrote ${result.itemCount} matching items to ${result.rssOutputPath}`);
  console.log(`Wrote public JSON feed to ${result.jsonOutputPath}`);
  console.log(`Wrote audit JSON to ${result.auditJsonOutputPath}`);
}

const currentFile = pathToFileURL(fileURLToPath(import.meta.url)).href;
const invokedFile = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";

if (currentFile === invokedFile) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

// Re-exports: the public surface for tests and tooling.
export {
  cleanStorySnippet,
  cleanText,
  escapeXml,
  normalizePreviewText,
  wrapCdata,
} from "./utils.js";
export {
  DEFAULT_SOURCES,
  buildSourcesFromEnv,
  isSocialSourceItem,
  socialSourcesEnabled,
} from "./sources.js";
export {
  buildSnippet,
  canonicalizeMatchedTerms,
  categorizeTerms,
  CATEGORY_BRAND,
  CATEGORY_TOPIC,
  findMentionTerms,
  MENTION_TERMS,
  TOPIC_TERMS,
} from "./matching.js";
export {
  extractArticleComments,
  extractArticlePreview,
  htmlToArticleText,
  mergeFacebookPagePostItem,
  parseBcbsAssociationNewsItems,
  parseCnnHealthSitemapItems,
  parseBlueCrossVtListingItems,
  parseFacebookEmbeddedComments,
  parseFacebookEmbeddedPosts,
  parseFacebookPageHtml,
  parseFacebookPostHtml,
  parseFeedItems,
  parseUvmHealthNewsroomItems,
} from "./parsers.js";
export {
  collectFeedItems,
  fetchText,
  filterSourceItemsByDateWindow,
  isSourceWindowClosed,
  readResponseTextWithLimit,
  throttleRequest,
} from "./fetching.js";
export { freshUntilFromHeaders, politenessPolicyFor } from "./politeness.js";
export { isObituaryItem } from "./filters.js";
export { enrichAndFilterItems, selectPreviewBackfillItems } from "./enrich.js";
export { applyDeterministicRelevance, isLikelyPaywalled } from "./relevance.js";
export { dedupeResolvedItems, mergeWithArchive, normalizeCrawlState } from "./archive.js";
export {
  buildSummaryPrompt,
  parseSummaryResponse,
  summarizeItems,
} from "./summaries.js";
export {
  applyFailureStreaks,
  selectFailureAlerts,
  triggerWebhooks,
} from "./alerts.js";
export { buildJsonSummary, buildRss } from "./outputs.js";
