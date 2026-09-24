// Feed outputs: RSS XML, public JSON Feed, audit JSON, and file writing.
import { normalizeJevBaseline } from "./jev-relevance.js";
import { writeText } from "./fsx.js";
import {
  cleanStorySnippet,
  cleanText,
  escapeXml,
  normalizePreviewText,
  parseDate,
  sortItemsByDate,
  wrapCdata,
} from "./utils.js";
import {
  canonicalizeMatchedTerms,
  categorizeTerms,
  CATEGORY_BRAND,
  findMentionTerms,
  MENTION_TERMS,
  TOPIC_TERMS,
} from "./matching.js";
import {
  itemAccessLabel,
  itemCategory,
  itemOutletName,
  itemSection,
  itemSourceType,
} from "./relevance.js";
import { groupRelatedStories } from "./story-groups.js";
import { shouldScoreSentiment } from "./summaries.js";

const SITE_URL = process.env.SITE_URL?.trim() || "";
const FEED_URL = resolveFeedUrl();
const JSON_FEED_URL = resolveJsonFeedUrl();

function resolveJsonFeedUrl() {
  const explicitJsonFeedUrl = process.env.JSON_FEED_URL?.trim();
  if (explicitJsonFeedUrl) {
    return explicitJsonFeedUrl;
  }

  if (!SITE_URL) {
    return "";
  }

  return new URL("feed.json", `${SITE_URL.replace(/\/+$/, "")}/`).toString();
}

function resolveFeedUrl() {
  const explicitFeedUrl = process.env.FEED_URL?.trim();
  if (explicitFeedUrl) {
    return explicitFeedUrl;
  }

  if (!SITE_URL) {
    return "";
  }

  return new URL("feed.rss", `${SITE_URL.replace(/\/+$/, "")}/`).toString();
}

// The homepage's canonical form, with the trailing slash the page's own
// <link rel="canonical"> uses, so the feeds point at the exact URL search
// engines index rather than a redirecting or duplicate variant.
export function siteHomeUrl(siteUrl = SITE_URL) {
  const trimmed = String(siteUrl || "").trim();
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(`${trimmed.replace(/\/+$/, "")}/`).toString();
  } catch {
    return trimmed;
  }
}

function formatPubDate(date) {
  return (date || new Date()).toUTCString();
}

const ROUNDUP_TITLE_PATTERN =
  /\b(?:business briefs?|health briefs?|community news|sports\s*\/\s*outdoors)\b/i;

function previewTextForOutput(item) {
  const previewText = normalizePreviewText(item.previewText || "");
  if (
    !previewText ||
    itemOutletName(item) !== "Times Argus" ||
    !ROUNDUP_TITLE_PATTERN.test(item.title || "")
  ) {
    return previewText;
  }

  const itemTerms = canonicalizeMatchedTerms(item.matchedTerms || []);
  const previewTerms = findMentionTerms(previewText, [
    ...MENTION_TERMS,
    ...TOPIC_TERMS,
  ]);
  if (itemCategory({ ...item, matchedTerms: itemTerms }) === CATEGORY_BRAND) {
    return categorizeTerms(previewTerms) === CATEGORY_BRAND ? previewText : "";
  }

  const itemTermSet = new Set(itemTerms);
  return previewTerms.some((term) => itemTermSet.has(term)) ? previewText : "";
}

// Groups the stories people read; rejected items never lead or join a group.
export function groupVisibleStories(items) {
  return groupRelatedStories(
    items.filter((item) => item.relevant !== false),
    {
      category: (item) =>
        itemCategory({
          ...item,
          matchedTerms: canonicalizeMatchedTerms(item.matchedTerms || []),
        }),
      outlet: itemOutletName,
    },
  );
}

// One line of other reports, each linked by its outlet name.
function relatedCoverageHtml(group, lead) {
  const others = group.members.filter((member) => member !== lead);
  const links = others.map(
    (member) =>
      `<a href="${escapeXml(member.link)}" title="${escapeXml(member.title)}">${escapeXml(itemOutletName(member) || member.sourceName || "")}</a>`,
  );
  return `<p><strong>Also covered by:</strong> ${links.join(" · ")}</p>`;
}

function itemDescription(item, group) {
  const snippet = cleanStorySnippet(item.snippet, item.title);
  const date = item.pubDate?.toISOString()?.slice(0, 10) || "";
  const access = itemAccessLabel(item);
  const lines = [
    `<p><strong>Source:</strong> ${escapeXml(item.sourceName)}</p>`,
  ];

  if (date) {
    lines.push(`<p><strong>Date:</strong> ${escapeXml(date)}</p>`);
  }

  if (access) {
    lines.push(`<p><strong>Access:</strong> ${escapeXml(access)}</p>`);
  }

  if (item.summary) {
    lines.push(`<p>${escapeXml(item.summary)}</p>`);
  }

  const previewText = previewTextForOutput(item);
  if (access === "Paywall likely" && previewText) {
    lines.push(
      `<p><strong>Publisher preview:</strong> ${escapeXml(previewText)}</p>`,
    );
  }

  if (shouldScoreSentiment(item) && item.sentiment) {
    const sentimentNote = item.sentimentReason
      ? `${item.sentiment} — ${item.sentimentReason}`
      : item.sentiment;
    lines.push(
      `<p><strong>Sentiment:</strong> ${escapeXml(sentimentNote)}</p>`,
    );
  }

  if (item.reason) {
    lines.push(`<p><em>Why included: ${escapeXml(item.reason)}</em></p>`);
  }

  if (!item.summary && snippet) {
    lines.push(`<p>${escapeXml(snippet)}</p>`);
  }

  if (group) {
    lines.push(relatedCoverageHtml(group, item));
  }

  if (Array.isArray(item.comments) && item.comments.length > 0) {
    lines.push("<p><strong>Comments:</strong></p>");
    lines.push("<ul>");
    for (const comment of item.comments) {
      const author = comment.author ? `${comment.author}: ` : "";
      lines.push(
        `<li>${escapeXml(`${author}${comment.text || ""}`)}</li>`,
      );
      if (Array.isArray(comment.replies) && comment.replies.length > 0) {
        lines.push("<ul>");
        for (const reply of comment.replies) {
          const replyAuthor = reply.author ? `${reply.author}: ` : "";
          lines.push(
            `<li>${escapeXml(`${replyAuthor}${reply.text || ""}`)}</li>`,
          );
        }
        lines.push("</ul>");
      }
    }
    lines.push("</ul>");
  }

  lines.push(
    `<p><a href="${escapeXml(item.link)}">Read the original story</a></p>`,
  );

  if (item.articleError) {
    // The raw error message can leak fetch URLs/details; a generic note
    // is enough for feed readers.
    lines.push(
      "<p><em>Note: the full article text could not be fetched; matching used the feed text only.</em></p>",
    );
  }

  return lines.join("\n");
}

function flattenCommentText(comments = []) {
  const parts = [];

  for (const comment of comments) {
    parts.push(
      cleanText(
        `${comment.author ? `${comment.author}: ` : ""}${comment.text || ""}`,
      ),
    );
    for (const reply of comment.replies || []) {
      parts.push(
        cleanText(
          `${reply.author ? `${reply.author}: ` : ""}${reply.text || ""}`,
        ),
      );
    }
  }

  return parts.filter(Boolean);
}

export function buildRss(items, options = {}) {
  const now = options.now || new Date();
  const feedUrl = options.feedUrl || FEED_URL;
  const siteUrl = siteHomeUrl(options.siteUrl || SITE_URL) || feedUrl || "";
  const atomLink = feedUrl
    ? `\n    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />`
    : "";

  // Items the relevance gate rejected stay in feed-audit.json but are
  // excluded from the feeds people read. Other outlets' reports of a grouped
  // story are listed inside its lead item instead of repeating as items.
  const groups = groupVisibleStories(items);
  const itemXml = sortItemsByDate(items)
    .filter((item) => item.relevant !== false)
    .filter((item) => !groups.has(item) || groups.get(item).lead === item)
    .slice(0, 100)
    .map((item) => {
      const categories = item.matchedTerms
        .map((term) => `      <category>${escapeXml(term)}</category>`)
        .join("\n");

      const pubDate = item.pubDate
        ? `\n      <pubDate>${escapeXml(formatPubDate(item.pubDate))}</pubDate>`
        : "";
      // <source> requires a url attribute; archived items can lose theirs.
      const sourceTag = item.sourceFeedUrl
        ? `\n      <source url="${escapeXml(item.sourceFeedUrl)}">${escapeXml(
            item.sourceName,
          )}</source>`
        : "";

      return `    <item>
      <title>${escapeXml(`${item.sourceName}: ${item.title}`)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="true">${escapeXml(item.guid || item.link)}</guid>${pubDate}${sourceTag}
${categories}
      <description>${wrapCdata(itemDescription(item, groups.get(item)))}</description>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Cerulean News</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>Mentions of BCBSVT, Blue Cross VT, and Blue Cross and Blue Shield of Vermont from Vermont news outlets. Independent personal project, not affiliated with Blue Cross and Blue Shield of Vermont.</description>
    <language>en-us</language>
    <lastBuildDate>${escapeXml(formatPubDate(now))}</lastBuildDate>
    <ttl>60</ttl>
    <generator>cerulean-news</generator>${atomLink}
${itemXml}
  </channel>
</rss>
`;
}

export function buildJsonSummary(items, sourceResults, now = new Date(), options = {}) {
  const includeRejected = Boolean(options.includeRejected);
  const outputItems = sortItemsByDate(items).filter(
    (item) => includeRejected || item.relevant !== false,
  );
  const rejectedItemCount = items.filter((item) => item.relevant === false).length;
  // The audit archive keeps no grouping; it is recomputed on every run.
  const groups = includeRejected ? new Map() : groupVisibleStories(items);
  const homeUrl = siteHomeUrl(options.siteUrl ?? SITE_URL);

  return {
    version: "https://jsonfeed.org/version/1.1",
    title: "Cerulean News",
    description:
      "Mentions of Blue Cross and Blue Shield of Vermont from Vermont news outlets. Independent personal project, not affiliated with Blue Cross and Blue Shield of Vermont.",
    home_page_url: homeUrl,
    feed_url: options.feedUrl ?? JSON_FEED_URL ?? "",
    // JSON Feed 1.1 artwork and language, so feed readers show the site's
    // icon instead of a blank tile. Both URLs must be absolute, so they are
    // only emitted when the site URL is known.
    icon: homeUrl ? new URL("icon-512.png", homeUrl).toString() : undefined,
    favicon: homeUrl ? new URL("favicon-32x32.png", homeUrl).toString() : undefined,
    language: "en-US",
    generatedAt: now.toISOString(),
    itemCount: outputItems.length,
    totalItemCount: items.length,
    visibleItemCount: items.length - rejectedItemCount,
    rejectedItemCount,
    audit: includeRejected || undefined,
    // Persist successful deliveries without exposing webhook platform names
    // in the publicly deployed audit archive.
    sources: sourceResults.map((source) => {
      const {
        failureAlertDeliveries,
        ...safeSource
      } = source;
      if (includeRejected) {
        return {
          ...safeSource,
          ...(failureAlertDeliveries?.length > 0
            ? {
                failureAlertDeliveries: [
                  ...new Set(failureAlertDeliveries),
                ],
              }
            : {}),
        };
      }
      return safeSource;
    }),
    crawlMetrics: includeRejected ? options.crawlMetrics : undefined,
    crawlState: includeRejected ? options.crawlState : undefined,
    items: outputItems.map((item) => {
      const matchedTerms = canonicalizeMatchedTerms(item.matchedTerms || []);
      const comments = Array.isArray(item.comments) ? item.comments : [];
      const snippet = cleanStorySnippet(item.snippet, item.title);
      const previewText = previewTextForOutput(item);
      const access = itemAccessLabel(item);
      const eligibleForSentiment = shouldScoreSentiment(item);
      const contentText = cleanText(
        [
          item.summary || snippet || item.description || "",
          access === "Paywall likely" && previewText
            ? `Publisher preview: ${previewText}`
            : "",
          item.reason ? `Why included: ${item.reason}` : "",
          comments.length > 0
            ? `Comments: ${flattenCommentText(comments).join(" | ")}`
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      );

      return {
        id: item.guid || item.link,
        url: item.link,
        title: item.title,
        content_text: contentText,
        date_published: item.pubDate?.toISOString() || undefined,
        tags: matchedTerms,
        sourceName: item.sourceName,
        // The publishing outlet, recovered from the link when the feed that
        // found the story was a Google News search.
        outlet: itemOutletName(item),
        sourceFeedUrl: item.sourceFeedUrl || "",
        sourceType: itemSourceType(item),
        access,
        link: item.link,
        guid: item.guid || item.link,
        pubDate: item.pubDate?.toISOString() || null,
        // Persist discovery time for every audit item so a future-only rollout
        // cannot mistake dated history for newly discovered coverage.
        firstSeenAt: includeRejected
          ? parseDate(item.firstSeenAt)?.toISOString() || undefined
          : undefined,
        jevBaseline: includeRejected ? normalizeJevBaseline(item.jevBaseline) : undefined,
        matchedTerms,
        // Recomputed rather than echoed, so an item classified under an older
        // rule is corrected in place instead of staying misfiled forever.
        category: itemCategory({ ...item, matchedTerms }),
        // The reader's section filter: Blue Cross VT, Vermont, or national.
        section: itemSection({ ...item, matchedTerms }),
        snippet,
        summary: item.summary || "",
        previewText: access === "Paywall likely" ? previewText : "",
        previewChecked: includeRejected
          ? item.previewChecked === true
          : undefined,
        reason: item.reason || "",
        // Brand press coverage only; absent on topic stories and owned posts.
        // Marks the coverage set the trends page charts volume over, so a
        // freshly collected item counts even before it has been scored.
        sentimentEligible: eligibleForSentiment || undefined,
        // Gate the score at the publishing boundary, not just where scores are
        // written. An item that loses eligibility (a rule change, or its terms
        // recanonicalizing) already has a summary, so it never re-enters the
        // Gemini batch where the score would be cleared, and a stale score
        // would otherwise persist in the archive indefinitely.
        sentiment: eligibleForSentiment ? item.sentiment || undefined : undefined,
        sentimentReason:
          eligibleForSentiment && item.sentiment
            ? item.sentimentReason || ""
            : undefined,
        // undefined (not yet judged) is omitted by JSON.stringify, which
        // marks the item for a relevance pass on the next run.
        relevant: typeof item.relevant === "boolean" ? item.relevant : undefined,
        comments,
        // Public output gets a boolean, not the raw fetch error message.
        articleFetchFailed: Boolean(item.articleError),
        matchSource: item.matchSource || "",
        // Marks an entry seeded from the team's media tracker rather than
        // found by the crawler, so the two can be told apart in the archive.
        fromMediaTracker: item.fromMediaTracker || undefined,
        // Items sharing an id report the same event; the reader shows the
        // newest one and lists the rest beneath it as other coverage.
        storyGroupId: groups.get(item)?.id,
      };
    }),
  };
}

export async function writeOutput(
  rss,
  jsonSummary,
  auditJsonSummary,
  rssOutputPath,
  jsonOutputPath,
  auditJsonOutputPath,
) {
  await writeText(rssOutputPath, rss);
  await writeText(jsonOutputPath, `${JSON.stringify(jsonSummary, null, 2)}\n`);
  // The audit JSON is the persistence layer, re-downloaded and re-uploaded
  // every hourly run; compact serialization cuts megabytes off each cycle.
  // Use jq to pretty-print when inspecting it by hand.
  await writeText(
    auditJsonOutputPath,
    `${JSON.stringify(auditJsonSummary)}\n`,
  );
}
