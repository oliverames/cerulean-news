// Durable archive: load the previous run's audit JSON, merge current items
// with archived ones, and dedupe resolved links and titles.
import { readFile } from "node:fs/promises";
import {
  cleanStorySnippet,
  cleanText,
  normalizePreviewText,
  parseDate,
  parsePositiveInteger,
} from "./utils.js";
import { isObituaryItem } from "./filters.js";
import {
  canonicalizeMatchedTerms,
  categorizeTerms,
  CATEGORY_BRAND,
  findMentionTerms,
  MENTION_TERMS,
  TOPIC_TERMS,
} from "./matching.js";
import { parseFacebookRelativeDate } from "./parsers.js";
import { isSocialSourceItem, socialSourcesEnabled } from "./sources.js";

const CRAWL_STATE_VERSION = 1;

function normalizeString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeHeaderState(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  const normalized = {};
  for (const [url, headers] of Object.entries(value)) {
    if (!url || !headers || typeof headers !== "object") {
      continue;
    }
    const etag = normalizeString(headers.etag);
    const lastModified = normalizeString(headers.lastModified);
    const checkedAt = normalizeString(headers.checkedAt);
    if (!etag && !lastModified && !checkedAt) {
      continue;
    }
    // freshUntil defers the next fetch and preferLastModified remembers that
    // this origin ignores its own ETag; both only pay off across runs, so
    // they have to survive the audit-JSON round trip.
    const freshUntil = normalizeString(headers.freshUntil);
    normalized[url] = {
      etag,
      lastModified,
      checkedAt,
      freshUntil: parseDate(freshUntil) ? freshUntil : "",
      preferLastModified: headers.preferLastModified === true,
    };
  }
  return normalized;
}

function normalizeSourceState(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  const normalized = {};
  for (const [sourceName, state] of Object.entries(value)) {
    if (!sourceName || !state || typeof state !== "object") {
      continue;
    }
    normalized[sourceName] = {
      primaryCooldownUntil: normalizeString(state.primaryCooldownUntil),
      lastPrimaryError: normalizeString(state.lastPrimaryError),
      lastPrimaryAttemptAt: normalizeString(state.lastPrimaryAttemptAt),
      lastPrimarySuccessAt: normalizeString(state.lastPrimarySuccessAt),
      feedHeaders: normalizeHeaderState(state.feedHeaders),
    };
  }
  return normalized;
}

function normalizeArticleCache(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  const normalized = {};
  for (const [url, entry] of Object.entries(value)) {
    if (!url || !entry || typeof entry !== "object") {
      continue;
    }

    const expiresAt = normalizeString(entry.expiresAt);
    if (expiresAt && !parseDate(expiresAt)) {
      continue;
    }

    normalized[url] = {
      url: normalizeString(entry.url) || url,
      resolvedUrl: normalizeString(entry.resolvedUrl) || url,
      title: normalizeString(entry.title),
      sourceName: normalizeString(entry.sourceName),
      checkedAt: normalizeString(entry.checkedAt),
      expiresAt,
      matchedTerms: canonicalizeMatchedTerms(entry.matchedTerms || []),
      snippet: cleanStorySnippet(entry.snippet || "", entry.title || ""),
      previewText: normalizePreviewText(entry.previewText || ""),
      previewChecked: entry.previewChecked === true,
      articleError: normalizeString(entry.articleError),
      comments: Array.isArray(entry.comments) ? entry.comments : [],
      matchSource: normalizeString(entry.matchSource),
      articleHeaders: normalizeHeaderState({ article: entry.articleHeaders })
        .article || {},
    };
  }
  return normalized;
}

export function normalizeCrawlState(value = {}) {
  return {
    version: CRAWL_STATE_VERSION,
    sourceState: normalizeSourceState(value.sourceState),
    articleCache: normalizeArticleCache(value.articleCache),
  };
}

export async function loadPreviousState(...jsonOutputPaths) {
  const cache = new Map();
  const archivedItems = [];
  const previousFailureStreaks = new Map();
  let crawlState = normalizeCrawlState();
  const attemptedPaths = jsonOutputPaths.filter(Boolean);
  let loadedPath = "";

  for (const jsonOutputPath of attemptedPaths) {
    try {
      const raw = await readFile(jsonOutputPath, "utf8");
      const parsed = JSON.parse(raw);
      const archiveGeneratedAt = parseDate(parsed?.generatedAt);
      for (const source of parsed?.sources || []) {
        if (source?.name && Number.isInteger(source.consecutiveFailures)) {
          previousFailureStreaks.set(source.name, source.consecutiveFailures);
        }
      }
      crawlState = normalizeCrawlState(parsed?.crawlState || {});
      if (parsed && Array.isArray(parsed.items)) {
        for (const item of parsed.items) {
          if (!item.link) {
            continue;
          }
          if (isObituaryItem(item)) {
            continue;
          }
          if (!socialSourcesEnabled() && isSocialSourceItem(item)) {
            continue;
          }
          const matchedTerms = canonicalizeMatchedTerms(item.matchedTerms || []);
          const recoveredPubDate =
            parseDate(item.pubDate) ||
            (archiveGeneratedAt
              ? parseFacebookRelativeDate(
                  [item.snippet, item.content_text, item.description]
                    .filter(Boolean)
                    .join(" "),
                  archiveGeneratedAt,
                )
              : null);
          // `relevant` stays undefined (not false) when absent so items
          // summarized before the relevance gate existed get re-judged once.
          const relevant =
            typeof item.relevant === "boolean" ? item.relevant : undefined;
          cache.set(item.link, {
            matchedTerms,
            category: item.category || categorizeTerms(matchedTerms),
            pubDate: recoveredPubDate,
            snippet: cleanStorySnippet(item.snippet, item.title),
            previewText: normalizePreviewText(item.previewText || ""),
            previewChecked: item.previewChecked === true,
            summary: item.summary || "",
            reason: item.reason || "",
            relevant,
            comments: Array.isArray(item.comments) ? item.comments : [],
            articleError: item.articleError || "",
            matchSource: item.matchSource || "",
          });
          archivedItems.push({
            sourceName: item.sourceName,
            sourceFeedUrl: item.sourceFeedUrl || "",
            title: item.title,
            link: item.link,
            guid: item.guid || item.link,
            pubDate: recoveredPubDate,
            matchedTerms,
            category: item.category || categorizeTerms(matchedTerms),
            snippet: cleanStorySnippet(item.snippet || "", item.title),
            previewText: normalizePreviewText(item.previewText || ""),
            previewChecked: item.previewChecked === true,
            summary: item.summary || "",
            reason: item.reason || "",
            relevant,
            comments: Array.isArray(item.comments) ? item.comments : [],
            articleError: item.articleError || "",
            matchSource: item.matchSource || "",
          });
        }
      }
      loadedPath = jsonOutputPath;
      break;
    } catch {
      // Try the next path, if any. The public feed path is kept as a
      // migration fallback for older deployments that predate feed-audit.json.
    }
  }

  if (loadedPath) {
    console.log(`Loaded ${cache.size} previously matched items from ${loadedPath}`);
  } else {
    console.log("No existing feed found to populate cache, starting fresh.");
  }

  return { cache, archivedItems, previousFailureStreaks, crawlState };
}

// Stories stay in the archive even after they fall out of their source
// feeds, so the page can look back in time. Bounded to keep the JSON sane.
const ARCHIVE_MAX_AGE_DAYS = parsePositiveInteger(
  process.env.ARCHIVE_MAX_AGE_DAYS,
  92,
);
const MAX_FUTURE_SKEW_HOURS = parsePositiveInteger(
  process.env.RSS_MAX_FUTURE_HOURS,
  6,
);

function isRejectedBySummary(item) {
  const reason = cleanText(item.reason || "").toLowerCase();
  return reason.includes("false positive") || reason === "irrelevant";
}

function isRejectedBySourceShape(item) {
  const isPressReleaseWire = /\/press_releases?\//i.test(item.link || "");
  return (
    isPressReleaseWire &&
    categorizeTerms(item.matchedTerms || []) !== CATEGORY_BRAND
  );
}

function isBrandCategoryItem(item) {
  return (item.category || categorizeTerms(item.matchedTerms || [])) === CATEGORY_BRAND;
}

function hasCurrentMatchingEvidence(item) {
  if (item.matchSource === "searchFallback") {
    return true;
  }

  const evidence = cleanText(
    [item.title, item.snippet, item.summary, item.reason]
      .filter(Boolean)
      .join(" "),
  );
  return findMentionTerms(evidence, [...MENTION_TERMS, ...TOPIC_TERMS]).length > 0;
}

// Post-enrichment dedupe. Link-level dupes happen when the same article is
// archived under its resolved URL but rediscovered under a raw Google News
// URL; title+domain dupes happen when two Google News search feeds surface
// the same syndicated copy. The same headline from *different* outlets is
// kept on purpose — the comms team tracks coverage spread.
export function dedupeResolvedItems(items) {
  const seenLinks = new Set();
  const seenTitleDomain = new Set();
  const seenTitleOnly = new Map();
  const result = [];

  for (const item of items) {
    const link = item.link || item.guid || "";
    if (seenLinks.has(link)) {
      continue;
    }

    let domain = "";
    try {
      domain = new URL(link).hostname.replace(/^www\./, "");
    } catch {
      domain = "";
    }
    const normalizedTitle = cleanText(item.title || "")
      .toLowerCase()
      .replace(/\s+-\s+[^-]+$/, "") // strip trailing "- Outlet" suffix
      .trim();
    const titleKey = domain && normalizedTitle ? `${domain}|${normalizedTitle}` : "";
    const isAggregatorItem =
      domain === "news.google.com" || /^Google News\b/i.test(item.sourceName || "");

    if (titleKey && seenTitleDomain.has(titleKey)) {
      continue;
    }

    if (normalizedTitle && seenTitleOnly.has(normalizedTitle)) {
      const existingIndex = seenTitleOnly.get(normalizedTitle);
      const existingItem = result[existingIndex];
      let existingDomain = "";
      try {
        existingDomain = new URL(existingItem.link || existingItem.guid || "")
          .hostname.replace(/^www\./, "");
      } catch {
        existingDomain = "";
      }
      const existingIsAggregator =
        existingDomain === "news.google.com" ||
        /^Google News\b/i.test(existingItem.sourceName || "");

      if (existingIsAggregator || isAggregatorItem) {
        if (existingIsAggregator && !isAggregatorItem) {
          result[existingIndex] = item;
          seenLinks.add(link);
          if (titleKey) {
            seenTitleDomain.add(titleKey);
          }
        }
        continue;
      }
    }

    seenLinks.add(link);
    if (titleKey) {
      seenTitleDomain.add(titleKey);
    }
    if (normalizedTitle) {
      seenTitleOnly.set(normalizedTitle, result.length);
    }
    result.push(item);
  }

  return result;
}

export function mergeWithArchive(currentItems, archivedItems, now = new Date()) {
  const byLink = new Map();
  for (const item of archivedItems) {
    byLink.set(item.link, item);
  }
  // Current items win: they carry fresh enrichment.
  for (const item of currentItems) {
    byLink.set(item.link, item);
  }

  const cutoff = now.valueOf() - ARCHIVE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const maxFutureTime = now.valueOf() + MAX_FUTURE_SKEW_HOURS * 60 * 60 * 1000;
  return [...byLink.values()].filter((item) => {
    if (isRejectedBySummary(item) || isRejectedBySourceShape(item)) {
      return false;
    }
    if (!hasCurrentMatchingEvidence(item)) {
      return false;
    }

    const time = item.pubDate?.valueOf();
    // Keep undated items; they are rare and usually recent.
    if (time === undefined || time === null || Number.isNaN(time)) {
      return true;
    }
    if (time > maxFutureTime) {
      return false;
    }
    return isBrandCategoryItem(item) || time >= cutoff;
  });
}
