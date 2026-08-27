// Article-page enrichment: resolve Google News links, scan article text for
// brand mentions, and attach matched terms, snippets, and categories.
import { GoogleDecoder } from "google-news-url-decoder";
import {
  cleanStorySnippet,
  cleanText,
  mapWithConcurrency,
  normalizePreviewText,
  parseDate,
  parsePositiveInteger,
} from "./utils.js";
import {
  buildSnippet,
  canonicalizeMatchedTerms,
  categorizeTerms,
  findMentionTerms,
  MENTION_TERMS,
  TOPIC_TERMS,
} from "./matching.js";
import {
  articlePageMatchesTitle,
  extractArticleComments,
  extractArticlePreview,
  htmlToArticleText,
} from "./parsers.js";
import { fetchText, throttleRequest } from "./fetching.js";
import { isLikelyPaywalled } from "./relevance.js";

const googleDecoder = new GoogleDecoder();

const CONCURRENCY = parsePositiveInteger(process.env.RSS_CONCURRENCY, 6);
const NEGATIVE_CACHE_TTL_MS =
  parsePositiveInteger(process.env.RSS_NEGATIVE_CACHE_TTL_DAYS, 14) *
  24 *
  60 *
  60 *
  1000;
// A no-match verdict reached because the article fetch itself failed (429,
// timeout, block) is unreliable evidence — expire it after a day so the
// article gets re-checked, instead of suppressing matches for two weeks.
const ERROR_ENTRY_TTL_MS = 24 * 60 * 60 * 1000;

function scanArticlePages() {
  return process.env.RSS_ARTICLE_SCAN !== "false";
}

function bumpMetric(metrics, key, amount = 1) {
  if (!metrics?.enrichment) {
    return;
  }
  metrics.enrichment[key] = (metrics.enrichment[key] || 0) + amount;
}

function trackScanMode(metrics, mode) {
  if (!metrics?.enrichment) {
    return;
  }
  if (!metrics.enrichment.scanModes) {
    metrics.enrichment.scanModes = {};
  }
  metrics.enrichment.scanModes[mode] =
    (metrics.enrichment.scanModes[mode] || 0) + 1;
}

function articleCacheExpiresAt(now, ttlMs) {
  return new Date(now.valueOf() + ttlMs).toISOString();
}

function articleCacheKeys(originalLink, resolvedLink) {
  return [...new Set([originalLink, resolvedLink].filter(Boolean))];
}

function isFreshArticleCacheEntry(entry, now) {
  if (!entry) {
    return false;
  }
  const expiresAt = parseDate(entry.expiresAt);
  return Boolean(expiresAt) && expiresAt.valueOf() > now.valueOf();
}

function findArticleCacheEntry(articleCache, keys) {
  for (const key of keys) {
    const entry = articleCache[key];
    if (entry) {
      return entry;
    }
  }
  return null;
}

function findFreshArticleCacheEntry(articleCache, keys, now) {
  const entry = findArticleCacheEntry(articleCache, keys);
  return isFreshArticleCacheEntry(entry, now) ? entry : null;
}

// Expired entries that carry ETag/Last-Modified validators are kept for one
// extra TTL window so the revalidation fetch can still send If-None-Match.
// Validator-less entries have no residual value once expired — dropping them
// at expiry keeps the audit JSON (the persistence layer, re-downloaded every
// run) from accumulating weeks of dead negative verdicts.
function pruneExpiredArticleCache(articleCache, now) {
  const staleCutoff = now.valueOf() - NEGATIVE_CACHE_TTL_MS;
  for (const [url, entry] of Object.entries(articleCache)) {
    const expiresAt = parseDate(entry.expiresAt);
    if (!expiresAt) {
      delete articleCache[url];
      continue;
    }
    const hasValidators = Boolean(
      entry.articleHeaders?.etag || entry.articleHeaders?.lastModified,
    );
    const cutoff = hasValidators ? staleCutoff : now.valueOf();
    if (expiresAt.valueOf() <= cutoff) {
      delete articleCache[url];
    }
  }
}

function shouldFetchArticle(item, feedBrandMatches, topicMatches) {
  if (!scanArticlePages() || item.scanArticle === false) {
    return false;
  }

  const mode = item.articleScanMode || "smart";
  if (mode === "feedOnly") {
    return false;
  }
  if (mode === "always") {
    return true;
  }
  if (mode === "brandBody") {
    return feedBrandMatches.length === 0;
  }

  return (
    feedBrandMatches.length > 0 ||
    topicMatches.length > 0 ||
    (item.searchFallbackTerms || []).length > 0 ||
    item.requireBrandMatch
  );
}

function shouldFetchPreview(
  item,
  resolvedLink,
  feedBrandMatches,
  topicMatches,
  cachedMatches = [],
) {
  if (
    !scanArticlePages() ||
    item.previewArticle === false ||
    !isLikelyPaywalled({ ...item, link: resolvedLink })
  ) {
    return false;
  }

  return (
    feedBrandMatches.length > 0 ||
    topicMatches.length > 0 ||
    cachedMatches.length > 0 ||
    (item.searchFallbackTerms || []).length > 0 ||
    item.requireBrandMatch
  );
}

function writeArticleCache(articleCache, keys, item, resolvedLink, details, now) {
  const matchedTerms = canonicalizeMatchedTerms(details.matchedTerms || []);
  const isErrorOnlyEntry = Boolean(details.articleError) &&
    (matchedTerms.length === 0 || details.previewChecked !== true);
  const cacheEntry = {
    url: item.link,
    resolvedUrl: resolvedLink,
    title: item.title || "",
    sourceName: item.sourceName || "",
    checkedAt: now.toISOString(),
    expiresAt: articleCacheExpiresAt(
      now,
      isErrorOnlyEntry ? ERROR_ENTRY_TTL_MS : NEGATIVE_CACHE_TTL_MS,
    ),
    matchedTerms,
    snippet: cleanStorySnippet(details.snippet || "", item.title),
    previewText: normalizePreviewText(details.previewText || ""),
    previewChecked: details.previewChecked === true,
    articleError: details.articleError || "",
    comments: Array.isArray(details.comments) ? details.comments : [],
    matchSource: details.matchSource || "",
    articleHeaders: {
      etag: details.articleHeaders?.etag || "",
      lastModified: details.articleHeaders?.lastModified || "",
    },
  };

  for (const key of keys) {
    articleCache[key] = cacheEntry;
  }
}

function itemFromArticleCache(
  item,
  resolvedLink,
  cached,
  feedBrandMatches,
  topicMatches,
) {
  let matchedTerms = canonicalizeMatchedTerms([
    ...(cached.matchedTerms || []),
    ...feedBrandMatches,
    ...topicMatches,
  ]);
  let matchSource = cached.matchSource || "articleCache";
  if (matchedTerms.length === 0) {
    const fallbackTerms = canonicalizeMatchedTerms(item.searchFallbackTerms || []);
    if (fallbackTerms.length === 0) {
      return null;
    }
    matchedTerms = fallbackTerms;
    matchSource = "searchFallback";
  }

  return {
    ...item,
    link: cached.resolvedUrl || resolvedLink || item.link,
    matchedTerms,
    category: categorizeTerms(matchedTerms),
    snippet: cleanStorySnippet(cached.snippet || item.description || "", item.title),
    previewText: normalizePreviewText(cached.previewText || ""),
    previewChecked: cached.previewChecked === true,
    comments: mergeComments(item.comments, cached.comments),
    articleError: cached.articleError || "",
    matchSource,
  };
}

function mergeComments(...commentLists) {
  const merged = [];
  const seen = new Set();

  for (const comments of commentLists) {
    if (!Array.isArray(comments)) {
      continue;
    }

    for (const comment of comments) {
      const text = cleanText(comment?.text || "");
      if (!text) {
        continue;
      }
      const author = cleanText(comment.author || "");
      const key = `${author.toLowerCase()}|${text.toLowerCase()}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push({
        ...comment,
        author,
        text,
        date: comment.date || null,
        replies: Array.isArray(comment.replies) ? comment.replies : [],
      });
    }
  }

  return merged;
}

export function selectPreviewBackfillItems(
  archivedItems,
  currentItems,
  limit = 25,
  articleCache = {},
  now = new Date(),
) {
  const currentLinks = new Set(
    currentItems.map((item) => item.link).filter(Boolean),
  );
  const normalizeTitle = (value) =>
    cleanText(value)
      .toLowerCase()
      .replace(/\s+-\s+[^-]{2,80}$/, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const normalizePublisher = (value) =>
    cleanText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(
        (token) =>
          token && !["feed", "google", "health", "news", "search", "the"].includes(token),
      )
      .join("");
  const publisherForItem = (item) => {
    const suffix = cleanText(item.title).match(/\s+-\s+([^-]{2,80})$/)?.[1];
    if (suffix) {
      return normalizePublisher(suffix);
    }
    if (item.sourceName && !/^Google News\b/i.test(item.sourceName)) {
      return normalizePublisher(item.sourceName);
    }
    try {
      return normalizePublisher(
        new URL(item.link).hostname.replace(/^www\./i, "").split(".")[0],
      );
    } catch {
      return "";
    }
  };
  const storyKey = (item) => {
    const title = normalizeTitle(item.title);
    const publisher = publisherForItem(item);
    return title && publisher ? `${title}|${publisher}` : "";
  };
  const currentStoryKeys = new Set(
    currentItems.map(storyKey).filter(Boolean),
  );
  const boundedLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : 25;

  return archivedItems
    .filter((item) => {
      const cached = articleCache[item.link];
      const cacheExpiresAt = parseDate(cached?.expiresAt);
      const hasFreshCachedError = Boolean(cached?.articleError) &&
        Boolean(cacheExpiresAt) &&
        cacheExpiresAt.valueOf() > now.valueOf();
      return (
        item.relevant !== false &&
        item.previewChecked !== true &&
        !currentLinks.has(item.link) &&
        !currentStoryKeys.has(storyKey(item)) &&
        !hasFreshCachedError &&
        isLikelyPaywalled(item)
      );
    })
    .sort(
      (left, right) =>
        (parseDate(right.pubDate)?.valueOf() || 0) -
        (parseDate(left.pubDate)?.valueOf() || 0),
    )
    .slice(0, boundedLimit)
    .map((item) => ({
      ...item,
      feedContent: cleanText(
        [item.title, item.snippet, item.summary, item.reason]
          .filter(Boolean)
          .join(" "),
      ),
    }));
}

function articleUrlMateriallyChanged(originalUrl, finalUrl) {
  try {
    const original = new URL(originalUrl);
    const final = new URL(finalUrl);
    const originalHost = original.hostname.replace(/^www\./i, "").toLowerCase();
    const finalHost = final.hostname.replace(/^www\./i, "").toLowerCase();
    const normalizePath = (pathname) => pathname.replace(/\/+$/, "") || "/";
    return (
      originalHost !== finalHost ||
      normalizePath(original.pathname) !== normalizePath(final.pathname)
    );
  } catch {
    return originalUrl !== finalUrl;
  }
}

export async function enrichAndFilterItems(items, cache = new Map(), options = {}) {
  const articleCache = options.articleCache || {};
  const metrics = options.metrics || {};
  const now = options.now || new Date();
  const fetchArticleText = options.fetchText || fetchText;
  const throttleArticleRequest = options.throttleRequest || throttleRequest;
  if (metrics.enrichment) {
    metrics.enrichment.itemsSeen = items.length;
  }
  pruneExpiredArticleCache(articleCache, now);

  const results = await mapWithConcurrency(items, CONCURRENCY, async (item) => {
    let articleText = "";
    let articleComments = [];
    let articleError = "";
    let previewText = "";
    let previewChecked = false;
    let inheritedCache = null;
    let matchedCachedItem = null;
    let resolvedLink = item.link;
    const originalLink = item.link;

    if (resolvedLink.includes("news.google.com/rss/articles")) {
      try {
        const decoded = await googleDecoder.decode(resolvedLink);
        if (decoded && decoded.status && decoded.decoded_url) {
          resolvedLink = decoded.decoded_url;
        }
      } catch (error) {
        console.warn(`Failed to decode Google News link ${resolvedLink}: ${error.message}`);
      }
    }

    const feedBrandMatches = findMentionTerms(item.feedContent, MENTION_TERMS);
    const topicMatches = findMentionTerms(item.feedContent, TOPIC_TERMS);
    const cacheKeys = articleCacheKeys(originalLink, resolvedLink);
    const freshArticleCache = findFreshArticleCacheEntry(
      articleCache,
      cacheKeys,
      now,
    );
    const matchedCacheEntry = cache.get(resolvedLink);
    const previewRequested = shouldFetchPreview(
      item,
      resolvedLink,
      feedBrandMatches,
      topicMatches,
      [
        ...(matchedCacheEntry?.matchedTerms || []),
        ...(freshArticleCache?.matchedTerms || []),
      ],
    );

    if (matchedCacheEntry) {
      bumpMetric(metrics, "matchedCacheHits");
      const cached = matchedCacheEntry;
      let matchedTerms = canonicalizeMatchedTerms([
        ...(cached.matchedTerms || []),
        ...feedBrandMatches,
        ...topicMatches,
      ]);
      if (matchedTerms.length === 0) {
        matchedTerms = canonicalizeMatchedTerms(item.searchFallbackTerms || []);
      }
      const cachedItem = {
        ...item,
        link: resolvedLink,
        matchedTerms,
        category: categorizeTerms(matchedTerms),
        pubDate: item.pubDate || cached.pubDate || null,
        snippet: cleanStorySnippet(cached.snippet, item.title),
        previewText: normalizePreviewText(cached.previewText || ""),
        previewChecked: cached.previewChecked === true,
        summary: cached.summary || "",
        reason: cached.reason || "",
        relevant: cached.relevant,
        sentiment: cached.sentiment,
        sentimentReason: cached.sentimentReason,
        comments: mergeComments(item.comments, cached.comments),
        articleError: cached.articleError,
        matchSource: cached.matchSource || "",
      };
      matchedCachedItem = cachedItem;
      if (!previewRequested || cached.previewChecked === true) {
        console.log(`Cache Hit: Skipping fetch/scrape for ${resolvedLink}`);
        if (cached.previewChecked === true) {
          bumpMetric(metrics, "previewCacheHits");
        }
        return cachedItem;
      }
      inheritedCache = cached;
    }

    if (freshArticleCache) {
      const cachedItem = itemFromArticleCache(
        item,
        resolvedLink,
        freshArticleCache,
        feedBrandMatches,
        topicMatches,
      );
      if (!cachedItem) {
        bumpMetric(metrics, "negativeCacheHits");
        return null;
      }
      if (
        !previewRequested ||
        freshArticleCache.previewChecked === true ||
        Boolean(freshArticleCache.articleError)
      ) {
        bumpMetric(metrics, "articleCacheHits");
        if (freshArticleCache.previewChecked === true) {
          bumpMetric(metrics, "previewCacheHits");
        }
        if (!matchedCachedItem) {
          return cachedItem;
        }
        return {
          ...matchedCachedItem,
          previewText: cachedItem.previewText,
          previewChecked: cachedItem.previewChecked,
          comments: mergeComments(
            matchedCachedItem.comments,
            cachedItem.comments,
          ),
          articleError: cachedItem.articleError || matchedCachedItem.articleError,
        };
      }
      inheritedCache = inheritedCache || freshArticleCache;
    }

    const scanMode = item.articleScanMode || (item.scanArticle === false ? "feedOnly" : "smart");
    trackScanMode(metrics, scanMode);
    const fetchArticle =
      shouldFetchArticle(item, feedBrandMatches, topicMatches) || previewRequested;
    const collectPreview =
      fetchArticle && isLikelyPaywalled({ ...item, link: resolvedLink });
    if (fetchArticle) {
      await throttleArticleRequest(resolvedLink);
      try {
        bumpMetric(metrics, "articleFetches");
        if (collectPreview) {
          bumpMetric(metrics, "previewFetches");
        }
        const requestedArticleUrl = resolvedLink;
        const staleArticleCache = findArticleCacheEntry(articleCache, cacheKeys);
        const conditionalHeaders =
          collectPreview && staleArticleCache?.previewChecked !== true
            ? {}
            : staleArticleCache?.articleHeaders || {};
        const {
          text: html,
          url: finalUrl,
          notModified,
          etag,
          lastModified,
        } = await fetchArticleText(
          resolvedLink,
          "text/html, application/xhtml+xml, */*",
          { conditionalHeaders },
        );
        if (notModified && staleArticleCache) {
          bumpMetric(metrics, "articleNotModified");
          const cachedItem = itemFromArticleCache(
            item,
            resolvedLink,
            staleArticleCache,
            feedBrandMatches,
            topicMatches,
          );
          const refreshedCache = {
            ...staleArticleCache,
            previewChecked: staleArticleCache.previewChecked === true,
          };
          writeArticleCache(
            articleCache,
            cacheKeys,
            item,
            resolvedLink,
            refreshedCache,
            now,
          );
          return cachedItem
            ? {
                ...cachedItem,
                previewText: normalizePreviewText(
                  staleArticleCache.previewText || "",
                ),
                previewChecked: refreshedCache.previewChecked,
              }
            : cachedItem;
        }

        const articleUrl = finalUrl || requestedArticleUrl;
        const urlChanged = articleUrlMateriallyChanged(
          requestedArticleUrl,
          articleUrl,
        );
        const redirectIdentityMatches = !urlChanged || articlePageMatchesTitle(
          html,
          item.title,
          { requireEvidence: true },
        );
        if (redirectIdentityMatches) {
          resolvedLink = articleUrl;
          articleText = htmlToArticleText(html, articleUrl);
        }
        if (collectPreview) {
          previewChecked = true;
          const previewIdentityMatches = redirectIdentityMatches &&
            articlePageMatchesTitle(html, item.title);
          previewText = previewIdentityMatches
            ? extractArticlePreview(html, articleUrl)
            : "";
          bumpMetric(
            metrics,
            previewText ? "previewsFound" : "previewUnavailable",
          );
        }
        articleComments = redirectIdentityMatches
          ? extractArticleComments(html)
          : [];
        if (articleComments.length > 0) {
          bumpMetric(metrics, "commentsFound", articleComments.length);
        }
        item.articleHeaders = { etag, lastModified };
      } catch (error) {
        articleError = error.message;
        bumpMetric(metrics, "articleErrors");
        if (collectPreview) {
          bumpMetric(metrics, "previewUnavailable");
        }
      }
    } else {
      bumpMetric(metrics, "articleFetchSkipped");
    }

    // Brand terms scan everything (feed text + full article body) so we
    // catch stories that never name the insurer in the headline. Topic
    // terms scan feed title/description only — article bodies mention
    // "health care" too incidentally for body-matching to stay precise.
    const articleBrandMatches = findMentionTerms(articleText, MENTION_TERMS);

    // Facebook posts (and any source flagged requireBrandMatch) are only
    // kept when they mention Blue Cross itself — outlets post dozens of
    // general health stories that would otherwise flood the feed.
    if (
      item.requireBrandMatch &&
      feedBrandMatches.length === 0 &&
      articleBrandMatches.length === 0
    ) {
      writeArticleCache(
        articleCache,
        articleCacheKeys(originalLink, resolvedLink),
        item,
        resolvedLink,
        {
          matchedTerms: [],
          snippet: "",
          comments: mergeComments(item.comments, articleComments),
          articleError,
          matchSource: "",
          articleHeaders: item.articleHeaders,
        },
        now,
      );
      return null;
    }

    const matchedTerms = [
      ...new Set([
        ...(inheritedCache?.matchedTerms || []),
        ...feedBrandMatches,
        ...articleBrandMatches,
        ...topicMatches,
      ]),
    ];

    let finalMatchedTerms = canonicalizeMatchedTerms(matchedTerms);
    const hasFreshTextMatches =
      feedBrandMatches.length > 0 ||
      articleBrandMatches.length > 0 ||
      topicMatches.length > 0;
    let matchSource =
      inheritedCache?.matchSource === "searchFallback"
        ? "searchFallback"
        : hasFreshTextMatches
          ? "text"
          : inheritedCache?.matchSource || "text";
    if (finalMatchedTerms.length === 0) {
      const fallbackTerms = canonicalizeMatchedTerms(item.searchFallbackTerms || []);
      if (fallbackTerms.length === 0) {
        writeArticleCache(
          articleCache,
          articleCacheKeys(originalLink, resolvedLink),
          item,
          resolvedLink,
          {
            matchedTerms: [],
            snippet: "",
            comments: mergeComments(item.comments, articleComments),
            articleError,
            matchSource: "",
            articleHeaders: item.articleHeaders,
          },
          now,
        );
        return null;
      }
      finalMatchedTerms = fallbackTerms;
      matchSource = "searchFallback";
    }

    const snippetSource =
      articleBrandMatches.length > 0 ? articleText : item.feedContent;
    const snippet = cleanStorySnippet(
      inheritedCache?.snippet ||
        buildSnippet(snippetSource, [...MENTION_TERMS, ...TOPIC_TERMS]),
      item.title,
    );
    const comments = mergeComments(
      item.comments,
      inheritedCache?.comments,
      articleComments,
    );
    writeArticleCache(
      articleCache,
      articleCacheKeys(originalLink, resolvedLink),
      item,
      resolvedLink,
      {
        matchedTerms: finalMatchedTerms,
        snippet,
        previewText,
        previewChecked,
        comments,
        articleError,
        matchSource,
        articleHeaders: item.articleHeaders,
      },
      now,
    );

    return {
      ...item,
      link: resolvedLink,
      matchedTerms: finalMatchedTerms,
      category: categorizeTerms(finalMatchedTerms),
      snippet,
      previewText,
      previewChecked,
      summary: inheritedCache?.summary || item.summary || "",
      reason: inheritedCache?.reason || item.reason || "",
      sentiment: inheritedCache?.sentiment || item.sentiment,
      sentimentReason:
        inheritedCache?.sentimentReason || item.sentimentReason,
      relevant:
        typeof inheritedCache?.relevant === "boolean"
          ? inheritedCache.relevant
          : item.relevant,
      comments,
      articleError,
      matchSource,
    };
  });

  return results.filter(Boolean);
}
