// Prerenders the reader's first page into site/index.html, so crawlers and
// visitors without JavaScript see stories instead of "Loading stories...".
//
// The reader (site/index.html) builds its list client-side from feed.json and
// replaces the whole list on load. This module mirrors that script's default
// view: the "All news" section, no search, page one, newest first, with
// reports of one event collapsed under the newest. Keep the selection and the
// markup in step with renderStories, groupStories, and renderRelated there.
//
// The generated block lives between marker comments and is never committed:
// the committed page keeps the markers empty. Running twice replaces the block.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readText, writeText } from "./fsx.js";

export const PAGE_SIZE = 25;
export const LIST_START = "<!-- prerender:start -->";
export const LIST_END = "<!-- prerender:end -->";
export const JSONLD_START = "<!-- prerender-jsonld:start -->";
export const JSONLD_END = "<!-- prerender-jsonld:end -->";

const PAGE_URL = "https://cerulean.news/";
// Vermont's time zone, so a server in UTC does not shift late-evening stories
// to the next day. The client uses the reader's own zone.
const DATE_ZONE = "America/New_York";

// Same list as the reader's SENTIMENT_COLORS.
const SENTIMENT_COLORS = new Map([
  ["positive", "var(--s-pos)"],
  ["neutral to positive", "var(--s-npos)"],
  ["neutral", "var(--s-neu)"],
  ["neutral to negative", "var(--s-nneg)"],
  ["negative", "var(--s-neg)"],
]);

// Same pattern as the reader's previewPromotionPattern.
const PREVIEW_PROMOTION_PATTERN =
  /^(?:get (?:our|your) (?:daily|weekly) dose\b|good morning, everyone\b)/i;

// Feed text is untrusted, so every value goes through this on the way into
// markup, attribute values included.
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Same rule as the reader: only http(s) links become hrefs.
function safeHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? String(value)
      : "";
  } catch {
    return "";
  }
}

function displayablePreviewText(value = "") {
  const previewText = String(value).trim();
  return PREVIEW_PROMOTION_PATTERN.test(previewText) ? "" : previewText;
}

function formatDate(iso) {
  if (!iso) {
    return "";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) {
    return "";
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: DATE_ZONE,
  });
}

function isOwnedItem(item) {
  return (
    item.sourceType === "BlueCrossVT.org" ||
    /bluecrossvt\.org/i.test(item.link || item.url || "")
  );
}

function isSocialItem(item) {
  return (
    item.sourceType === "Social" ||
    /\bfacebook\b/i.test(`${item.sourceName || ""} ${item.link || ""}`)
  );
}

function orderedItems(items) {
  return [...items].sort((a, b) => {
    const aTime = a.pubDate ? new Date(a.pubDate).valueOf() : 0;
    const bTime = b.pubDate ? new Date(b.pubDate).valueOf() : 0;
    return bTime - aTime;
  });
}

// Reports of one event share a storyGroupId. The newest leads and the rest
// are listed beneath it.
function groupStories(items) {
  const entries = [];
  const byGroup = new Map();
  for (const item of items) {
    const group = item.storyGroupId && byGroup.get(item.storyGroupId);
    if (group) {
      group.related.push(item);
      continue;
    }
    const entry = { item, related: [] };
    if (item.storyGroupId) {
      byGroup.set(item.storyGroupId, entry);
    }
    entries.push(entry);
  }
  return entries;
}

// The reader's default first page: every news section, newest first, story
// groups collapsed, then the first PAGE_SIZE entries.
export function selectFirstPage(items, pageSize = PAGE_SIZE) {
  const news = (Array.isArray(items) ? items : []).filter(
    (item) => item && !isOwnedItem(item) && !isSocialItem(item),
  );
  return groupStories(orderedItems(news)).slice(0, pageSize);
}

function renderRelated(related) {
  const links = related
    .map((item) => {
      const href = safeHttpUrl(item.link);
      const attrs = `${href ? ` href="${escapeHtml(href)}"` : ""} title="${escapeHtml(item.title)}"`;
      return `<a${attrs}>${escapeHtml(item.outlet || item.sourceName)}</a>`;
    })
    .join(" · ");
  return `<p class="related"><span class="reason-label">Also covered by: </span>${links}</p>`;
}

// One list item. No whitespace between elements, as in the DOM the reader
// builds, so inline spacing matches. Comments are left to the client: their
// toggle needs JavaScript, and the list is replaced as soon as that runs.
export function renderStoryItem({ item, related = [] }) {
  const parts = [];
  const meta = [formatDate(item.pubDate), item.sourceName, item.access]
    .filter(Boolean)
    .join(" · ");
  parts.push(`<div class="meta">${escapeHtml(meta)}</div>`);

  const href = safeHttpUrl(item.link);
  parts.push(
    `<h2 class="headline"><a${href ? ` href="${escapeHtml(href)}"` : ""}>${escapeHtml(item.title)}</a></h2>`,
  );

  const summary = item.summary || item.snippet;
  if (summary) {
    parts.push(`<p class="summary">${escapeHtml(summary)}</p>`);
  }

  const previewText = displayablePreviewText(item.previewText);
  if (item.access === "Paywall likely" && previewText) {
    parts.push(
      `<blockquote class="publisher-preview"><span class="publisher-preview-label">Publisher preview: </span>${escapeHtml(previewText)}</blockquote>`,
    );
  }

  if (item.reason) {
    parts.push(
      `<p class="reason"><span class="reason-label">Included because: </span>${escapeHtml(item.reason)}</p>`,
    );
  }

  if (related.length > 0) {
    parts.push(renderRelated(related));
  }

  if (item.sentiment && SENTIMENT_COLORS.has(item.sentiment)) {
    const hasScore = Number.isFinite(item.sentimentScore);
    const label = hasScore
      ? `Sentiment: ${item.sentimentScore} · ${item.sentiment}`
      : `Sentiment: ${item.sentiment}`;
    const title = hasScore
      ? ` title="0 is negative, 50 neutral, 100 positive toward Blue Cross VT"`
      : "";
    const reason = item.sentimentReason
      ? escapeHtml(` — ${item.sentimentReason}`)
      : "";
    parts.push(
      `<p class="sentiment"><span class="sentiment-swatch" style="background: ${SENTIMENT_COLORS.get(item.sentiment)};"></span><span class="sentiment-label"${title}>${escapeHtml(label)}</span>${reason}</p>`,
    );
  }

  return `<li>${parts.join("")}</li>`;
}

export function renderStoryList(entries) {
  return entries.map(renderStoryItem).join("\n");
}

// JSON inside a script element: "<" is escaped so no feed text can close the
// tag or open a comment, and the two line separators that break older parsers.
function jsonForScript(value) {
  return JSON.stringify(value, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function buildItemListJsonLd(entries) {
  const itemListElement = [];
  for (const { item } of entries) {
    const url = safeHttpUrl(item.link);
    if (!url) {
      continue;
    }
    itemListElement.push({
      "@type": "ListItem",
      position: itemListElement.length + 1,
      url,
      name: String(item.title ?? ""),
    });
  }
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${PAGE_URL}#latest-stories`,
    name: "Latest stories",
    url: PAGE_URL,
    itemListOrder: "https://schema.org/ItemListOrderDescending",
    numberOfItems: itemListElement.length,
    itemListElement,
  };
}

// Replaces whatever sits between two markers, or returns null when the pair
// is missing or out of order. Index slicing rather than String.replace, so
// "$&" and friends in feed text stay literal.
function replaceBetween(html, startMarker, endMarker, content) {
  const start = html.indexOf(startMarker);
  if (start === -1) {
    return null;
  }
  const bodyStart = start + startMarker.length;
  const end = html.indexOf(endMarker, bodyStart);
  if (end === -1) {
    return null;
  }
  return html.slice(0, bodyStart) + content + html.slice(end);
}

// Returns the page with the first page of stories and the ItemList in place,
// or null when the list markers are missing. Pass no items to empty both.
export function injectPrerender(html, items) {
  const entries = selectFirstPage(items);
  const list = entries.length > 0 ? `\n${renderStoryList(entries)}\n` : "";
  const withList = replaceBetween(html, LIST_START, LIST_END, list);
  if (withList === null) {
    return null;
  }
  const jsonLd =
    entries.length > 0
      ? `\n<script type="application/ld+json">\n${jsonForScript(buildItemListJsonLd(entries))}\n</script>\n`
      : "";
  // The head markers are optional so the list still prerenders on a page
  // that has not gained them yet.
  return (
    replaceBetween(withList, JSONLD_START, JSONLD_END, jsonLd) ?? withList
  );
}

// Reads the page, injects, writes back. Skips quietly when the page or its
// markers are absent, as in tests that write feeds into a temp directory and
// in the Worker, which has no site/index.html to rewrite.
export async function prerenderIndex(indexPath, items) {
  let html;
  try {
    html = await readText(indexPath);
  } catch {
    return { written: false, reason: "no page" };
  }
  const next = injectPrerender(html, items);
  if (next === null) {
    console.warn(`Prerender skipped: ${indexPath} has no prerender markers.`);
    return { written: false, reason: "no markers" };
  }
  if (next !== html) {
    await writeText(indexPath, next);
  }
  return { written: true, count: selectFirstPage(items).length };
}

// `node src/prerender.js [site/index.html] [site/feed.json]` prerenders an
// existing feed into the page, for static-only deploys that reuse the live one.
async function main() {
  const [indexArg = "site/index.html", feedArg = "site/feed.json"] =
    process.argv.slice(2);
  const indexPath = path.resolve(process.cwd(), indexArg);
  const feed = JSON.parse(await readText(path.resolve(process.cwd(), feedArg)));
  const result = await prerenderIndex(indexPath, feed.items);
  if (!result.written) {
    throw new Error(`Prerender failed: ${result.reason}`);
  }
  console.log(`Prerendered ${result.count} stories into ${indexPath}`);
}

// Guarded like src/index.js: bundled into a Worker there is no entry script.
function invokedDirectly() {
  try {
    const entryScript = process.argv?.[1];
    if (!entryScript || !import.meta.url) {
      return false;
    }
    return (
      pathToFileURL(fileURLToPath(import.meta.url)).href ===
      pathToFileURL(path.resolve(entryScript)).href
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
