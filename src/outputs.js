// Feed outputs: RSS XML, public JSON Feed, audit JSON, and file writing.
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import {
  cleanStorySnippet,
  cleanText,
  escapeXml,
  normalizePreviewText,
  sortItemsByDate,
  wrapCdata,
} from "./utils.js";
import { canonicalizeMatchedTerms, categorizeTerms } from "./matching.js";
import { itemAccessLabel, itemSourceType } from "./relevance.js";

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

function formatPubDate(date) {
  return (date || new Date()).toUTCString();
}

function itemDescription(item) {
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

  const previewText = normalizePreviewText(item.previewText || "");
  if (access === "Paywall likely" && previewText) {
    lines.push(
      `<p><strong>Publisher preview:</strong> ${escapeXml(previewText)}</p>`,
    );
  }

  if (item.reason) {
    lines.push(`<p><em>Why included: ${escapeXml(item.reason)}</em></p>`);
  }

  if (!item.summary && snippet) {
    lines.push(`<p>${escapeXml(snippet)}</p>`);
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
  const siteUrl = options.siteUrl || SITE_URL || feedUrl || "";
  const atomLink = feedUrl
    ? `\n    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />`
    : "";

  // Items the relevance gate rejected stay in feed-audit.json but are
  // excluded from the feeds people read.
  const itemXml = sortItemsByDate(items)
    .filter((item) => item.relevant !== false)
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
      <description>${wrapCdata(itemDescription(item))}</description>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
  xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Blue News</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>Mentions of BCBSVT, Blue Cross VT, and Blue Cross and Blue Shield of Vermont from Vermont news outlets.</description>
    <language>en-us</language>
    <lastBuildDate>${escapeXml(formatPubDate(now))}</lastBuildDate>
    <ttl>60</ttl>
    <generator>vt-news-rss-bcbs</generator>${atomLink}
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

  return {
    version: "https://jsonfeed.org/version/1.1",
    title: "Blue News",
    home_page_url: SITE_URL || "",
    feed_url: options.feedUrl ?? JSON_FEED_URL ?? "",
    generatedAt: now.toISOString(),
    itemCount: outputItems.length,
    totalItemCount: items.length,
    visibleItemCount: items.length - rejectedItemCount,
    rejectedItemCount,
    audit: includeRejected || undefined,
    sources: sourceResults,
    crawlMetrics: includeRejected ? options.crawlMetrics : undefined,
    crawlState: includeRejected ? options.crawlState : undefined,
    items: outputItems.map((item) => {
      const matchedTerms = canonicalizeMatchedTerms(item.matchedTerms || []);
      const comments = Array.isArray(item.comments) ? item.comments : [];
      const snippet = cleanStorySnippet(item.snippet, item.title);
      const previewText = normalizePreviewText(item.previewText || "");
      const access = itemAccessLabel(item);
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
        sourceFeedUrl: item.sourceFeedUrl || "",
        sourceType: itemSourceType(item),
        access,
        link: item.link,
        guid: item.guid || item.link,
        pubDate: item.pubDate?.toISOString() || null,
        matchedTerms,
        category: item.category || categorizeTerms(matchedTerms),
        snippet,
        summary: item.summary || "",
        previewText: access === "Paywall likely" ? previewText : "",
        previewChecked: includeRejected
          ? item.previewChecked === true
          : undefined,
        reason: item.reason || "",
        // undefined (not yet judged) is omitted by JSON.stringify, which
        // marks the item for a relevance pass on the next run.
        relevant: typeof item.relevant === "boolean" ? item.relevant : undefined,
        comments,
        // Public output gets a boolean, not the raw fetch error message.
        articleFetchFailed: Boolean(item.articleError),
        matchSource: item.matchSource || "",
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
  await mkdir(path.dirname(rssOutputPath), { recursive: true });
  await writeFile(rssOutputPath, rss, "utf8");
  await writeFile(jsonOutputPath, `${JSON.stringify(jsonSummary, null, 2)}\n`);
  // The audit JSON is the persistence layer, re-downloaded and re-uploaded
  // every hourly run; compact serialization cuts megabytes off each cycle.
  // Use jq to pretty-print when inspecting it by hand.
  await writeFile(
    auditJsonOutputPath,
    `${JSON.stringify(auditJsonSummary)}\n`,
  );
}
