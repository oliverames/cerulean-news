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
import { itemOutletName } from "./relevance.js";
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
      // A syntactically valid file is not necessarily a usable archive. If
      // the preferred audit path was truncated to an object with no items
      // array, accepting it here would suppress the valid public-feed
      // fallback and silently rebuild history from scratch.
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.items)) {
        continue;
      }
      const archiveGeneratedAt = parseDate(parsed?.generatedAt);
      for (const source of parsed?.sources || []) {
        if (source?.name && Number.isInteger(source.consecutiveFailures)) {
          previousFailureStreaks.set(source.name, source.consecutiveFailures);
        }
      }
      crawlState = normalizeCrawlState(parsed?.crawlState || {});
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
        // Absent stays undefined so brand coverage scored before sentiment
        // existed gets one scoring pass, rather than being re-scored hourly.
        const sentiment = item.sentiment || undefined;
        const sentimentReason = sentiment
          ? item.sentimentReason || ""
          : undefined;
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
          sentiment,
          sentimentReason,
          fromMediaTracker: item.fromMediaTracker || undefined,
          trackerOutlet: item.trackerOutlet || undefined,
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
          sentiment,
          sentimentReason,
          fromMediaTracker: item.fromMediaTracker || undefined,
          trackerOutlet: item.trackerOutlet || undefined,
          comments: Array.isArray(item.comments) ? item.comments : [],
          articleError: item.articleError || "",
          matchSource: item.matchSource || "",
        });
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

// Curated backfill entries are retained on the same footing as brand items,
// whatever terms they happen to match. The three-month window exists to stop
// generic Vermont health news accumulating; a hand-logged clip is the opposite
// of that, and most of the tracker predates the window anyway.
function isCuratedItem(item) {
  return item.fromMediaTracker === true;
}

function hasCurrentMatchingEvidence(item) {
  if (item.matchSource === "searchFallback" || item.matchSource === "mediaTracker") {
    return true;
  }

  if (isCuratedItem(item)) {
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
// Google News titles arrive as "Headline - Outlet", so their final suffix is
// stripped before comparison. Direct-publisher titles use the same punctuation
// for real subtitles, so those suffixes are stripped only when they name the
// item's outlet. Numeric suffixes remain intact because they usually identify
// a dated briefs or calendar edition.
function normalizeOutletLabel(value) {
  return cleanText(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeTitleForDedupe(item, isAggregatorItem) {
  const cleaned = cleanText(item.title || "").toLowerCase().trim();
  const match = cleaned.match(/^(.*\S)\s+-\s+([^-]+)$/);
  if (!match) {
    return cleaned;
  }
  const suffix = match[2].trim();
  if (isAggregatorItem) {
    return match[1].trim();
  }
  if (/\d/.test(suffix)) {
    return cleaned;
  }
  if (
    normalizeOutletLabel(suffix) !== normalizeOutletLabel(itemOutletName(item))
  ) {
    return cleaned;
  }
  return match[1].trim();
}

function aggregatorOutletForTitle(item) {
  const match = cleanText(item.title || "").match(/\s+-\s+([^-]+)$/);
  return match ? normalizeOutletLabel(match[1]) : "";
}

export function dedupeResolvedItems(items) {
  const seenLinks = new Set();
  const seenTitleDomain = new Set();
  const seenTitleOutlet = new Map();
  const seenTitleAny = new Map();
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
    const isAggregatorItem = domain === "news.google.com";
    const normalizedTitle = normalizeTitleForDedupe(item, isAggregatorItem);
    const aggregatorOutlet = isAggregatorItem
      ? aggregatorOutletForTitle(item)
      : "";
    const titleOutlet =
      aggregatorOutlet || normalizeOutletLabel(itemOutletName(item));
    const storyKey = normalizedTitle && titleOutlet
      ? `${normalizedTitle}|${titleOutlet}`
      : "";
    const titleKey = domain && normalizedTitle
      ? `${domain}|${aggregatorOutlet}|${normalizedTitle}`
      : "";

    if (titleKey && seenTitleDomain.has(titleKey) && !item.fromMediaTracker) {
      continue;
    }

    if (normalizedTitle && seenTitleAny.has(normalizedTitle)) {
      const existingIndex = seenTitleAny.get(normalizedTitle);
      const existingItem = result[existingIndex];
      if (item.fromMediaTracker && !existingItem.fromMediaTracker) {
        result[existingIndex] = item;
        seenLinks.add(link);
        if (titleKey) {
          seenTitleDomain.add(titleKey);
        }
        if (storyKey) {
          seenTitleOutlet.set(storyKey, existingIndex);
        }
        continue;
      }
      if (
        existingItem.fromMediaTracker &&
        !item.fromMediaTracker &&
        isAggregatorItem
      ) {
        continue;
      }
    }

    if (storyKey && seenTitleOutlet.has(storyKey)) {
      const existingIndex = seenTitleOutlet.get(storyKey);
      const existingItem = result[existingIndex];
      let existingDomain = "";
      try {
        existingDomain = new URL(existingItem.link || existingItem.guid || "")
          .hostname.replace(/^www\./, "");
      } catch {
        existingDomain = "";
      }
      const existingIsAggregator = existingDomain === "news.google.com";

      // A hand-logged clip carries the outlet and URL the team recorded, so
      // it wins a title collision against a copy the crawler happened to find.
      if (item.fromMediaTracker && !existingItem.fromMediaTracker) {
        result[existingIndex] = item;
        seenLinks.add(link);
        if (titleKey) {
          seenTitleDomain.add(titleKey);
        }
        continue;
      }

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
    if (storyKey) {
      seenTitleOutlet.set(storyKey, result.length);
    }
    if (normalizedTitle) {
      seenTitleAny.set(normalizedTitle, result.length);
    }
    result.push(item);
  }

  return result;
}

export function mergeWithArchive(currentItems, archivedItems, now = new Date()) {
  const byLink = new Map();

  function mergeSameLink(existing, incoming) {
    if (!existing) {
      return incoming;
    }

    const curated = incoming.fromMediaTracker
      ? incoming
      : existing.fromMediaTracker
        ? existing
        : null;
    if (!curated) {
      return incoming;
    }

    return {
      ...existing,
      ...incoming,
      matchedTerms: canonicalizeMatchedTerms([
        ...(existing.matchedTerms || []),
        ...(incoming.matchedTerms || []),
      ]),
      fromMediaTracker: true,
      trackerOutlet:
        curated.trackerOutlet ||
        existing.trackerOutlet ||
        incoming.trackerOutlet,
      matchSource: curated.matchSource || "mediaTracker",
    };
  }

  for (const item of archivedItems) {
    byLink.set(item.link, mergeSameLink(byLink.get(item.link), item));
  }
  // Current items win: they carry fresh enrichment.
  for (const item of currentItems) {
    byLink.set(item.link, mergeSameLink(byLink.get(item.link), item));
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
    return isBrandCategoryItem(item) || isCuratedItem(item) || time >= cutoff;
  });
}
