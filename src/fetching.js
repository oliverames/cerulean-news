// HTTP fetching with retries, size caps, per-domain politeness, and the
// per-source collection pipeline.
import {
  mapWithConcurrency,
  parseDate,
  parseNonNegativeInteger,
  parsePositiveInteger,
  sleep,
} from "./utils.js";
import { isObituaryItem } from "./filters.js";
import { freshUntilFromHeaders, politenessPolicyFor } from "./politeness.js";
import {
  mergeFacebookPagePostItem,
  parseBcbsAssociationNewsItems,
  parseBlueCrossVtListingItems,
  parseCnnHealthSitemapItems,
  parseFacebookPageHtml,
  parseFacebookPostHtml,
  parseFeedItems,
  parseUvmHealthNewsroomItems,
} from "./parsers.js";

const REQUEST_TIMEOUT_MS = parsePositiveInteger(
  process.env.RSS_TIMEOUT_MS,
  12000,
);
// Sources fetched in parallel. Kept modest: most sources are distinct
// domains, and throttleRequest keeps same-domain or shared-platform requests
// apart regardless.
const SOURCE_CONCURRENCY = parsePositiveInteger(
  process.env.RSS_SOURCE_CONCURRENCY,
  4,
);
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const MAX_FETCH_ATTEMPTS = parsePositiveInteger(
  process.env.RSS_FETCH_ATTEMPTS,
  3,
);
// Cap on decompressed response bytes. Feeds and article pages from these
// outlets run well under 10 MB; the cap keeps one misbehaving or compromised
// source from exhausting the Actions runner's memory mid-run.
const MAX_RESPONSE_BYTES = parsePositiveInteger(
  process.env.RSS_MAX_RESPONSE_BYTES,
  10 * 1024 * 1024,
);
const PRIMARY_COOLDOWN_FORBIDDEN_MS = 24 * 60 * 60 * 1000;
const PRIMARY_COOLDOWN_RATE_LIMITED_MS = 2 * 60 * 60 * 1000;
const PRIMARY_COOLDOWN_ERROR_MS = 60 * 60 * 1000;

const DOMAIN_QUEUES = new Map();
// Politeness delay between request starts on the same domain. Note: before
// the promise-chain rewrite this delay was unenforced under concurrency (a
// race let workers slip through), which is why older runs looked faster.
// Now that it works, it dominates run time when many uncached articles share
// a domain; lower it here if run length ever matters more than politeness.
const PER_DOMAIN_DELAY_MS = parseNonNegativeInteger(
  process.env.RSS_DOMAIN_DELAY_MS,
  1000,
);
// Retry-After can ask for hours; honoring that inside a run would hang a
// fetch worker. Cap the in-run retry sleep — source cooldowns still honor
// the full duration across runs (see cooldownDurationForError).
const MAX_RETRY_SLEEP_MS = 15000;

// Serialize request starts per domain: each caller awaits the previous
// caller's slot, and the next slot opens one delay later. The get/set pair
// below runs synchronously (no await between them), so concurrent callers
// cannot grab the same slot — the previous timestamp-based check raced when
// multiple workers hit the same domain at once.
export async function throttleRequest(url, throttleGroup = "", throttleDelayMs) {
  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch {
    return; // Unparseable URL: skip throttling, the fetch will fail anyway
  }
  if (!hostname) {
    return;
  }

  // An explicit per-source override wins; otherwise a host policy sets the
  // pace, falling back to the global per-domain delay.
  const policy = politenessPolicyFor(url);
  const delayMs = parseNonNegativeInteger(
    throttleDelayMs ?? policy?.throttleDelayMs,
    PER_DOMAIN_DELAY_MS,
  );
  const queueKey = throttleGroup || policy?.throttleGroup || hostname;
  const previousSlot = DOMAIN_QUEUES.get(queueKey) || Promise.resolve();
  DOMAIN_QUEUES.set(
    queueKey,
    previousSlot.then(() => sleep(delayMs)),
  );
  await previousSlot;
}

function charsetFromContentType(contentType = "") {
  const match = /charset\s*=\s*"?([\w.-]+)"?/i.exec(contentType || "");
  return match ? match[1].toLowerCase() : "";
}

// Look for an XML prolog or HTML meta charset declaration in the first KB.
// Latin-1 is byte-transparent, so the declaration survives the probe decode
// whatever the real encoding is.
function sniffCharsetFromBody(buffer) {
  const head = buffer.subarray(0, 1024).toString("latin1");
  const match =
    /<\?xml[^>]*encoding=["']([\w.-]+)["']/i.exec(head) ||
    /<meta[^>]+charset=["']?([\w.-]+)/i.exec(head);
  return match ? match[1].toLowerCase() : "";
}

function tryDecode(buffer, label, fatal = false) {
  try {
    return new TextDecoder(label, { fatal }).decode(buffer);
  } catch {
    return null;
  }
}

// Small local outlets still serve ISO-8859-1/Windows-1252 feeds; decoding
// those as UTF-8 mangles curly quotes and accented names into mojibake.
// Precedence: BOM, then bytes that validate as UTF-8 (a header or prolog
// mislabeling real UTF-8 as a legacy charset is far more common than legacy
// text that happens to form valid UTF-8 sequences), then the declared or
// document-sniffed charset.
function decodeBodyBytes(buffer, declaredCharset = "") {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return tryDecode(buffer, "utf-16le") ?? new TextDecoder().decode(buffer);
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return tryDecode(buffer, "utf-16be") ?? new TextDecoder().decode(buffer);
  }

  const utf8 = tryDecode(buffer, "utf-8", true);
  if (utf8 !== null) {
    return utf8;
  }

  const charset = declaredCharset || sniffCharsetFromBody(buffer);
  if (charset && charset !== "utf-8" && charset !== "utf8") {
    const decoded = tryDecode(buffer, charset);
    if (decoded !== null) {
      return decoded;
    }
  }
  return new TextDecoder().decode(buffer);
}

// Equivalent to response.text() (BOM handled by TextDecoder, charset taken
// from the Content-Type header or the document's own declaration) but aborts
// once the body exceeds maxBytes. Size errors are marked nonRetryable: a
// too-large body will be too large on the next attempt too.
export async function readResponseTextWithLimit(
  response,
  maxBytes = MAX_RESPONSE_BYTES,
) {
  function oversizedError(detail) {
    const error = new Error(`Response body exceeds ${maxBytes} bytes${detail}`);
    error.nonRetryable = true;
    return error;
  }

  const declaredLength = Number.parseInt(
    response.headers?.get?.("content-length") ?? "",
    10,
  );
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw oversizedError(` (content-length ${declaredLength})`);
  }

  if (!response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    receivedBytes += value.byteLength;
    if (receivedBytes > maxBytes) {
      await reader.cancel();
      throw oversizedError("");
    }
    chunks.push(value);
  }

  return decodeBodyBytes(
    Buffer.concat(chunks, receivedBytes),
    charsetFromContentType(response.headers?.get?.("content-type")),
  );
}

// Retry-After arrives as delta-seconds or as an HTTP date. Only an all-digit
// value is delta-seconds — parseInt would otherwise read the leading number
// out of a date form ("2026-07-05..." → 2026 seconds).
function retryAfterMsFromHeader(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return 0;
  }

  if (/^\d+$/.test(trimmed)) {
    return parsePositiveInteger(trimmed, 0) * 1000;
  }

  const date = parseDate(trimmed);
  if (date) {
    const deltaMs = date.valueOf() - Date.now();
    return deltaMs > 0 ? deltaMs : 0;
  }

  return 0;
}

function responseHeaderState(response) {
  return {
    etag: response.headers?.get?.("etag") || "",
    lastModified: response.headers?.get?.("last-modified") || "",
  };
}

// RFC 9110 tells a server to ignore If-Modified-Since whenever If-None-Match
// is present. Some origins (bluecrossvt.org among them) serve a weak ETag
// they never actually validate against, so sending both turns a would-be 304
// into a full body. preferLastModified records that verdict per URL once
// we have observed it, and drops If-None-Match from then on.
function conditionalRequestHeaders(conditional = {}) {
  const headers = {};
  const useEtag = conditional.etag && !conditional.preferLastModified;
  if (useEtag) {
    headers["if-none-match"] = conditional.etag;
  }
  if (conditional.lastModified) {
    headers["if-modified-since"] = conditional.lastModified;
  }
  return headers;
}

// A 200 whose validators exactly match the ones we sent means the origin
// declined to revalidate rather than that the page changed.
function revalidationWasIneffective(response, conditional = {}) {
  if (!conditional.etag || !conditional.lastModified) {
    return false;
  }
  if (conditional.preferLastModified) {
    return false; // Already down to one validator; nothing left to drop.
  }
  const { etag, lastModified } = responseHeaderState(response);
  return etag === conditional.etag && lastModified === conditional.lastModified;
}

export async function fetchText(url, accept, options = {}) {
  let lastError = null;
  const policy = politenessPolicyFor(url);
  const now = options.now || new Date();

  for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      const headers = {
        accept,
        "user-agent": USER_AGENT,
        "accept-language": "en-US,en;q=0.9",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        ...conditionalRequestHeaders(options.conditionalHeaders),
      };

      const response = await fetch(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (response.status === 304) {
        return {
          text: "",
          url: response.url || url,
          notModified: true,
          ...responseHeaderState(response),
          freshUntil: policy?.honorCacheControl
            ? freshUntilFromHeaders(response.headers, now, policy.cacheFreshnessCapMs)
            : "",
        };
      }

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} while fetching ${url}`);
        error.status = response.status;
        const retryAfterMs = retryAfterMsFromHeader(
          response.headers.get("retry-after"),
        );
        if (retryAfterMs > 0) {
          error.retryAfterMs = retryAfterMs;
        }
        throw error;
      }

      return {
        text: await readResponseTextWithLimit(response),
        url: response.url,
        ...responseHeaderState(response),
        preferLastModified:
          options.conditionalHeaders?.preferLastModified === true ||
          revalidationWasIneffective(response, options.conditionalHeaders),
        freshUntil: policy?.honorCacheControl
          ? freshUntilFromHeaders(response.headers, now, policy.cacheFreshnessCapMs)
          : "",
      };
    } catch (error) {
      lastError = error;

      // 429 and 408 are transient by definition; other 4xx responses will
      // repeat on the next attempt, so don't burn time retrying them.
      const isRetryableClientStatus =
        error.status === 429 || error.status === 408;
      const isClientError =
        error.status >= 400 && error.status < 500 && !isRetryableClientStatus;
      if (isClientError || error.nonRetryable || attempt === MAX_FETCH_ATTEMPTS) {
        break;
      }

      const retryDelayMs = error.retryAfterMs || 750 * attempt;
      if (retryDelayMs > MAX_RETRY_SLEEP_MS) {
        // The server asked for a longer backoff than an in-run retry can
        // honor; retrying sooner would just hammer it. Fail now — source
        // cooldowns and the next scheduled run pick it up.
        break;
      }
      await sleep(retryDelayMs);
    }
  }

  throw lastError;
}

async function enrichFacebookPageItemsFromPosts(pageItems, source) {
  return mapWithConcurrency(pageItems, 2, async (pageItem) => {
    try {
      await throttleRequest(pageItem.link);
      const { text: postHtml } = await fetchText(
        pageItem.link,
        "text/html, application/xhtml+xml, */*",
      );
      const postItem = parseFacebookPostHtml(postHtml, {
        ...source,
        title: pageItem.title,
        pubDate: pageItem.pubDate,
        facebookPostUrl: pageItem.link,
      });
      return mergeFacebookPagePostItem(pageItem, postItem, source);
    } catch (error) {
      console.warn(
        `Failed to enrich Facebook post ${pageItem.link}: ${error.message}`,
      );
      return pageItem;
    }
  });
}

async function throttleSourceRequest(source, url) {
  await throttleRequest(url, source.throttleGroup, source.throttleDelayMs);
}

function feedSource(source, feedConfig = {}) {
  const { fallbackFeed: _fallbackFeed, ...baseSource } = source;
  return {
    ...baseSource,
    ...feedConfig,
  };
}

function bumpMetric(metrics, section, key, amount = 1) {
  if (!metrics?.[section]) {
    return;
  }
  metrics[section][key] = (metrics[section][key] || 0) + amount;
}

function sourceStateFor(crawlState, sourceName) {
  if (!crawlState.sourceState || typeof crawlState.sourceState !== "object") {
    crawlState.sourceState = {};
  }
  if (!crawlState.sourceState[sourceName]) {
    crawlState.sourceState[sourceName] = {
      primaryCooldownUntil: "",
      lastPrimaryError: "",
      lastPrimaryAttemptAt: "",
      lastPrimarySuccessAt: "",
      feedHeaders: {},
    };
  }
  if (!crawlState.sourceState[sourceName].feedHeaders) {
    crawlState.sourceState[sourceName].feedHeaders = {};
  }
  return crawlState.sourceState[sourceName];
}

function feedHeaderStateFor(sourceState, url) {
  return sourceState.feedHeaders?.[url] || {};
}

function updateFeedHeaderState(sourceState, url, result, now) {
  const previous = feedHeaderStateFor(sourceState, url);
  // A 304 carries no body and often no validators; keep the ones we already
  // hold rather than forgetting how to revalidate next run.
  const etag = result.etag || (result.notModified ? previous.etag : "") || "";
  const lastModified =
    result.lastModified || (result.notModified ? previous.lastModified : "") || "";
  const freshUntil = result.freshUntil || "";
  if (!etag && !lastModified && !freshUntil) {
    return;
  }

  sourceState.feedHeaders[url] = {
    etag,
    lastModified,
    checkedAt: now.toISOString(),
    freshUntil,
    preferLastModified:
      result.preferLastModified === true || previous.preferLastModified === true,
  };
}

// True while the origin's own Cache-Control says the copy we last saw is
// still good. Re-fetching inside that window is traffic the server already
// told us it did not need.
function cachedResponseStillFresh(sourceState, url, now) {
  const freshUntil = parseDate(feedHeaderStateFor(sourceState, url).freshUntil);
  return Boolean(freshUntil) && freshUntil.valueOf() > now.valueOf();
}

function activeCooldownUntil(sourceState, now) {
  const cooldown = parseDate(sourceState.primaryCooldownUntil);
  if (!cooldown || cooldown.valueOf() <= now.valueOf()) {
    return null;
  }
  return cooldown;
}

function cooldownDurationForError(error) {
  if (Number.isFinite(error.retryAfterMs) && error.retryAfterMs > 0) {
    // The cooldown persists in the audit JSON across runs; cap it so one
    // clock-skewed server sending a far-future Retry-After date cannot
    // park a primary feed for months.
    return Math.min(error.retryAfterMs, PRIMARY_COOLDOWN_FORBIDDEN_MS);
  }
  if (error.status === 403) {
    return PRIMARY_COOLDOWN_FORBIDDEN_MS;
  }
  if (error.status === 429) {
    return PRIMARY_COOLDOWN_RATE_LIMITED_MS;
  }
  return PRIMARY_COOLDOWN_ERROR_MS;
}

function setPrimaryCooldown(sourceState, error, now) {
  const durationMs = cooldownDurationForError(error);
  sourceState.primaryCooldownUntil = new Date(
    now.valueOf() + durationMs,
  ).toISOString();
  sourceState.lastPrimaryError = error.message || String(error);
}

async function fetchSourceText(source, sourceState, url, accept, metrics, now) {
  if (cachedResponseStillFresh(sourceState, url, now)) {
    bumpMetric(metrics, "collection", "cacheFreshSkips");
    console.log(`Skipped ${url}: server-declared cache still fresh`);
    return { text: "", url, notModified: true, cacheFresh: true };
  }

  await throttleSourceRequest(source, url);
  bumpMetric(metrics, "collection", "sourceFetches");
  const result = await fetchText(url, accept, {
    conditionalHeaders: feedHeaderStateFor(sourceState, url),
    now,
  });
  updateFeedHeaderState(sourceState, url, result, now);
  if (result.notModified) {
    bumpMetric(metrics, "collection", "notModifiedFeeds");
  }
  return result;
}

const FEED_ACCEPT =
  "application/rss+xml, application/atom+xml, application/xml, text/xml, */*";

async function fetchSourceFeedXml(source, crawlState, now, metrics) {
  const primarySource = feedSource(source);
  const sourceState = sourceStateFor(crawlState, source.name);
  const cooldownUntil = source.fallbackFeed?.feedUrl
    ? activeCooldownUntil(sourceState, now)
    : null;

  if (cooldownUntil) {
    const fallbackSource = feedSource(source, source.fallbackFeed);
    bumpMetric(metrics, "collection", "sourceCooldowns");
    console.warn(
      `Primary feed cooldown active for ${source.name} until ${cooldownUntil.toISOString()}; trying fallback feed`,
    );
    const fallback = await fetchSourceText(
      fallbackSource,
      sourceState,
      fallbackSource.feedUrl,
      FEED_ACCEPT,
      metrics,
      now,
    );
    return {
      xml: fallback.text,
      source: fallbackSource,
      fallbackFrom: primarySource.feedUrl,
      primaryError: sourceState.lastPrimaryError || "Primary feed cooldown active",
      primaryCooldown: true,
      primaryCooldownUntil: cooldownUntil.toISOString(),
      notModified: fallback.notModified,
    };
  }

  try {
    sourceState.lastPrimaryAttemptAt = now.toISOString();
    const primary = await fetchSourceText(
      primarySource,
      sourceState,
      primarySource.feedUrl,
      FEED_ACCEPT,
      metrics,
      now,
    );
    sourceState.primaryCooldownUntil = "";
    sourceState.lastPrimaryError = "";
    sourceState.lastPrimarySuccessAt = now.toISOString();
    return {
      xml: primary.text,
      source: primarySource,
      notModified: primary.notModified,
    };
  } catch (primaryError) {
    if (!source.fallbackFeed?.feedUrl) {
      throw primaryError;
    }

    setPrimaryCooldown(sourceState, primaryError, now);
    const fallbackSource = feedSource(source, source.fallbackFeed);
    console.warn(
      `Primary feed failed for ${source.name}: ${primaryError.message}; trying fallback feed`,
    );
    const fallback = await fetchSourceText(
      fallbackSource,
      sourceState,
      fallbackSource.feedUrl,
      FEED_ACCEPT,
      metrics,
      now,
    );
    return {
      xml: fallback.text,
      source: fallbackSource,
      fallbackFrom: primarySource.feedUrl,
      primaryError: primaryError.message,
      primaryCooldownUntil: sourceState.primaryCooldownUntil,
      notModified: fallback.notModified,
    };
  }
}

function dedupeItems(items) {
  const byKey = new Map();

  for (const item of items) {
    const key = item.link || item.guid;
    if (!key || byKey.has(key)) {
      continue;
    }

    byKey.set(key, item);
  }

  return [...byKey.values()];
}

export function filterSourceItemsByDateWindow(items, source, now = new Date()) {
  const maxItemAgeDays = Number(source.maxItemAgeDays);
  const hasRollingMinimum = Number.isFinite(maxItemAgeDays) && maxItemAgeDays > 0;
  if (!source.minPubDate && !source.maxPubDate && !hasRollingMinimum) {
    return items;
  }

  const minDate = parseDate(source.minPubDate);
  const maxDate = parseDate(source.maxPubDate);
  const rollingMinTime = hasRollingMinimum
    ? now.valueOf() - maxItemAgeDays * 24 * 60 * 60 * 1000
    : null;
  return items.filter((item) => {
    const time = item.pubDate?.valueOf();
    if (time === undefined || time === null || Number.isNaN(time)) {
      return false;
    }
    if (minDate && time < minDate.valueOf()) {
      return false;
    }
    if (rollingMinTime !== null && time < rollingMinTime) {
      return false;
    }
    if (maxDate && time >= maxDate.valueOf()) {
      return false;
    }
    return true;
  });
}

function applySourceItemBounds(items, source, now) {
  const datedItems = filterSourceItemsByDateWindow(items, source, now);
  const filteredItems = datedItems.filter((item) => !isObituaryItem(item));
  return source.maxItems ? filteredItems.slice(0, source.maxItems) : filteredItems;
}

// A bounded source (e.g. the 2026 backfill search) whose maxPubDate has
// passed can never contribute a new item: filterSourceItemsByDateWindow
// would drop everything it returns, and everything inside the window is
// already in the durable archive. Skip the fetch instead of making a dead
// request every run.
export function isSourceWindowClosed(source, now = new Date()) {
  const maxDate = parseDate(source.maxPubDate);
  return Boolean(maxDate) && maxDate.valueOf() <= now.valueOf();
}

// Fetch one source and return its items plus a result row. Never throws:
// failures become an ok:false result so one broken source cannot stop a run.
async function fetchItemsForSource(source, now, crawlState, metrics) {
  if (isSourceWindowClosed(source, now)) {
    console.log(`Skipped ${source.name}: date window closed`);
    return {
      sourceResult: {
        name: source.name,
        feedUrl: source.feedUrl || source.facebookPostUrl || source.facebookPageUrl,
        ok: true,
        skipped: true,
        itemCount: 0,
        note: `Date window closed ${source.maxPubDate}; archived items are retained.`,
      },
      items: [],
    };
  }

  try {
    let feedUrl;
    let sourceItems;
    let feedFallbackFrom;
    let primaryFeedError;
    let primaryCooldown;
    let primaryCooldownUntil;
    let notModified;
    const sourceState = sourceStateFor(crawlState, source.name);

    if (source.facebookPostUrl) {
      feedUrl = source.facebookPostUrl;
      const { text: html, notModified: pageNotModified } = await fetchSourceText(
        source,
        sourceState,
        feedUrl,
        "text/html, application/xhtml+xml, */*",
        metrics,
        now,
      );
      notModified = pageNotModified;
      const facebookItem = parseFacebookPostHtml(html, source);
      sourceItems = (facebookItem ? [facebookItem] : []).map(
        (item) => ({ ...item, requireBrandMatch: !!source.requireBrandMatch }),
      );
    } else if (source.facebookPageUrl) {
      feedUrl = source.facebookPageUrl;
      const { text: html, notModified: pageNotModified } = await fetchSourceText(
        source,
        sourceState,
        feedUrl,
        "text/html, application/xhtml+xml, */*",
        metrics,
        now,
      );
      notModified = pageNotModified;
      sourceItems = parseFacebookPageHtml(html, source);
      sourceItems = applySourceItemBounds(sourceItems, source, now);
      sourceItems = await enrichFacebookPageItemsFromPosts(sourceItems, source);
      sourceItems = sourceItems.map((item) => ({
        ...item,
        requireBrandMatch: !!source.requireBrandMatch,
      }));
    } else if (source.listingUrl) {
      feedUrl = source.listingUrl;
      const { text: html, notModified: pageNotModified } = await fetchSourceText(
        source,
        sourceState,
        feedUrl,
        "text/html, application/xhtml+xml, */*",
        metrics,
        now,
      );
      notModified = pageNotModified;
      if (source.listingParser === "uvmHealthNewsroom") {
        sourceItems = parseUvmHealthNewsroomItems(html, source);
      } else if (source.listingParser === "bcbsAssociationNews") {
        sourceItems = parseBcbsAssociationNewsItems(html, source);
      } else if (source.listingParser === "cnnHealthSitemap") {
        sourceItems = parseCnnHealthSitemapItems(html, source);
      } else {
        sourceItems = parseBlueCrossVtListingItems(html, source);
      }
      sourceItems = applySourceItemBounds(sourceItems, source, now);
    } else {
      const feed = await fetchSourceFeedXml(source, crawlState, now, metrics);
      feedUrl = feed.source.feedUrl;
      sourceItems = parseFeedItems(feed.xml, feed.source);
      sourceItems = applySourceItemBounds(sourceItems, feed.source, now);
      feedFallbackFrom = feed.fallbackFrom;
      primaryFeedError = feed.primaryError;
      primaryCooldown = feed.primaryCooldown;
      primaryCooldownUntil = feed.primaryCooldownUntil;
      notModified = feed.notModified;
    }

    console.log(`Fetched ${sourceItems.length} items from ${source.name}`);
    return {
      sourceResult: {
        name: source.name,
        feedUrl,
        ok: true,
        itemCount: sourceItems.length,
        ...(notModified ? { notModified: true } : {}),
        ...(feedFallbackFrom
          ? {
              fallbackFrom: feedFallbackFrom,
              primaryError: primaryFeedError,
              primaryCooldown: primaryCooldown || undefined,
              primaryCooldownUntil,
            }
          : {}),
      },
      items: sourceItems,
    };
  } catch (error) {
    bumpMetric(metrics, "collection", "sourceFailures");
    console.warn(`Failed to fetch ${source.name}: ${error.message}`);
    return {
      sourceResult: {
        name: source.name,
        feedUrl: source.feedUrl || source.facebookPostUrl || source.facebookPageUrl,
        ok: false,
        itemCount: 0,
        error: error.message,
      },
      items: [],
    };
  }
}

// Sources fetch concurrently (most are independent domains; throttleRequest
// keeps same-domain requests a second apart), but results are assembled in
// source-list order so dedupeItems keeps the same first-seen winner
// regardless of completion timing.
export async function collectFeedItems(
  sources,
  now = new Date(),
  crawlState = { sourceState: {}, articleCache: {} },
  metrics = {},
) {
  const results = await mapWithConcurrency(
    sources,
    SOURCE_CONCURRENCY,
    (source) => fetchItemsForSource(source, now, crawlState, metrics),
  );
  const allItems = results.flatMap((result) => result.items);
  const dedupedItems = dedupeItems(allItems);
  if (metrics.collection) {
    metrics.collection.sourceCount = sources.length;
    metrics.collection.feedItemsCollected = allItems.length;
    metrics.collection.dedupedFeedItems = dedupedItems.length;
    metrics.collection.sourceFallbacks = results.filter(
      (result) => result.sourceResult.fallbackFrom,
    ).length;
    metrics.collection.skippedSources = results.filter(
      (result) => result.sourceResult.skipped,
    ).length;
  }

  return {
    items: dedupedItems,
    sourceResults: results.map((result) => result.sourceResult),
  };
}
