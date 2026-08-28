// Parsers for RSS/Atom XML, newsroom listing pages, article HTML, and
// Facebook's no-login post and page HTML.
import * as cheerio from "cheerio";
import {
  cleanText,
  normalizePreviewText,
  parseDate,
  resolveUrl,
} from "./utils.js";

function getFirstText($item, selectors) {
  for (const selector of selectors) {
    const value = cleanText($item.find(selector).first().text());
    if (value) {
      return value;
    }
  }

  return "";
}

function getFirstHtml($item, selectors) {
  for (const selector of selectors) {
    const element = $item.find(selector).first();
    const value = element.html()?.trim() || element.text()?.trim();
    if (value) {
      return value;
    }
  }

  return "";
}

function decodeFeedText(value = "") {
  const withoutCdata = String(value).replace(
    /<!\[CDATA\[([\s\S]*?)\]\]>/g,
    "$1",
  );
  const firstPass = cleanText(cheerio.load(withoutCdata).text() || withoutCdata);

  if (/<[a-z][\s\S]*>/i.test(firstPass)) {
    return cleanText(cheerio.load(firstPass).text() || firstPass);
  }

  return firstPass;
}

function normalizeGuid(link, fallback) {
  const value = link || fallback || "";
  return value.trim();
}

function sourceArticleScanMode(source) {
  if (source.articleScanMode) {
    return source.articleScanMode;
  }
  return source.scanArticle === false ? "feedOnly" : "smart";
}

export function isFeedDocument(feedXml) {
  if (typeof feedXml !== "string" || !feedXml.trim()) {
    return false;
  }

  try {
    const $ = cheerio.load(feedXml, { xmlMode: true });
    const rootName = String($.root().children().first().get(0)?.name || "")
      .toLowerCase();
    return ["rss", "feed", "rdf:rdf"].includes(rootName);
  } catch {
    return false;
  }
}

export function parseFeedItems(feedXml, source) {
  const $ = cheerio.load(feedXml, { xmlMode: true });
  const rssItems = $("item")
    .map((_, element) => {
      const $item = $(element);
      const title = getFirstText($item, ["title"]);
      const rawLink = getFirstText($item, ["link"]);
      const link = resolveUrl(rawLink, source.homepage || source.feedUrl);
      const descriptionHtml = getFirstHtml($item, [
        "description",
        "summary",
        "content\\:encoded",
      ]);
      const description = decodeFeedText(descriptionHtml);
      const sourceCategories = cleanText(
        $item
          .find("category")
          .map((__, category) => $(category).text())
          .get()
          .join(" "),
      );
      const pubDateRaw = getFirstText($item, [
        "pubDate",
        "published",
        "updated",
        "dc\\:date",
      ]);
      const pubDate = parseDate(pubDateRaw);
      const guid = normalizeGuid(
        link,
        getFirstText($item, ["guid", "id"]) || `${source.name}:${title}`,
      );

      if (!title || !link) {
        return null;
      }

      return {
        sourceName: source.name,
        sourceFeedUrl: source.feedUrl,
        isSearchFeed: !!source.isSearchFeed,
        searchFallbackTerms: source.searchFallbackTerms || [],
        scanArticle: source.scanArticle !== false,
        articleScanMode: sourceArticleScanMode(source),
        title,
        link,
        guid,
        pubDate,
        description,
        sourceCategories,
        feedContent: cleanText(
          [title, description].filter(Boolean).join(" "),
        ),
      };
    })
    .get()
    .filter(Boolean);

  const atomItems = $("entry")
    .map((_, element) => {
      const $item = $(element);
      const title = getFirstText($item, ["title"]);
      const href =
        $item.find("link[rel='alternate']").first().attr("href") ||
        $item.find("link").first().attr("href") ||
        getFirstText($item, ["link"]);
      const link = resolveUrl(href, source.homepage || source.feedUrl);
      const contentHtml = getFirstHtml($item, [
        "content",
        "summary",
        "media\\:description",
      ]);
      const description = decodeFeedText(contentHtml);
      const sourceCategories = cleanText(
        $item
          .find("category")
          .map((__, category) => {
            const $category = $(category);
            return $category.attr("term") || $category.text();
          })
          .get()
          .join(" "),
      );
      const pubDate = parseDate(
        getFirstText($item, ["published", "updated", "dc\\:date"]),
      );
      const guid = normalizeGuid(
        link,
        getFirstText($item, ["id"]) || `${source.name}:${title}`,
      );

      if (!title || !link) {
        return null;
      }

      return {
        sourceName: source.name,
        sourceFeedUrl: source.feedUrl,
        isSearchFeed: !!source.isSearchFeed,
        searchFallbackTerms: source.searchFallbackTerms || [],
        scanArticle: source.scanArticle !== false,
        articleScanMode: sourceArticleScanMode(source),
        title,
        link,
        guid,
        pubDate,
        description,
        sourceCategories,
        feedContent: cleanText([title, description].filter(Boolean).join(" ")),
      };
    })
    .get()
    .filter(Boolean);

  return [...rssItems, ...atomItems];
}

export function parseCnnHealthSitemapItems(xml, source) {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $("url")
    .map((_, element) => {
      const $url = $(element);
      const link = cleanText($url.find("loc").first().text());
      if (!/\/\d{4}\/\d{2}\/\d{2}\/health\//i.test(link)) {
        return null;
      }

      const title = cleanText($url.find("news\\:title").first().text());
      if (!title || !link) {
        return null;
      }

      const pubDate = parseDate(
        cleanText($url.find("news\\:publication_date").first().text()),
      );
      return {
        sourceName: source.name,
        sourceFeedUrl: source.listingUrl,
        isSearchFeed: false,
        searchFallbackTerms: source.searchFallbackTerms || [],
        scanArticle: source.scanArticle !== false,
        articleScanMode: sourceArticleScanMode(source),
        title,
        link,
        guid: link,
        pubDate,
        description: "",
        sourceCategories: "",
        feedContent: title,
      };
    })
    .get()
    .filter(Boolean);
}

export function parseBlueCrossVtListingItems(html, source) {
  const $ = cheerio.load(html);
  const items = [];

  $(".views-row article").each((_, element) => {
    const article = $(element);
    const linkElement = article.find("a.link-arrow").first();
    const title = cleanText(linkElement.text());
    const href = linkElement.attr("href");
    const link = resolveUrl(href, source.homepage || source.listingUrl);
    const dateText =
      article.find("time[datetime]").first().attr("datetime") ||
      article.find("time").first().text();
    const pubDate = parseDate(dateText);
    const description = cleanText(
      article
        .find("p")
        .map((__, paragraph) => $(paragraph).text())
        .get()
        .join(" "),
    );
    const category = cleanText(
      article
        .find(".news--category, .blog-post--category")
        .first()
        .text(),
    );

    if (!title || !link) {
      return;
    }

    items.push({
      sourceName: source.name,
      sourceFeedUrl: source.listingUrl,
      searchFallbackTerms: source.searchFallbackTerms || [],
      scanArticle: source.scanArticle !== false,
      articleScanMode: sourceArticleScanMode(source),
      title,
      link,
      guid: link,
      pubDate,
      description,
      feedContent: cleanText(
        [title, description, category, "bluecrossvt.org"]
          .filter(Boolean)
          .join(" "),
      ),
    });
  });

  return items;
}

export function parseBcbsAssociationNewsItems(html, source) {
  const $ = cheerio.load(html);
  const items = [];

  $(".bcbs-news-item-listing-content").each((_, element) => {
    const card = $(element);
    const linkElement = card
      .find("a.bcbs-news-item-listing-content__link")
      .first();
    const title = cleanText(linkElement.text());
    const href = linkElement.attr("href");
    const link = resolveUrl(href, source.homepage || source.listingUrl);
    const dateText =
      card.find("time[datetime]").first().attr("datetime") ||
      card.find("time").first().text();
    const pubDate = parseDate(dateText);
    const description = cleanText(
      card.find(".bcbs-news-item-listing-content__text").first().text(),
    );
    const categories = cleanText(
      card
        .find(".bcbs-categories-chips__item")
        .map((__, category) => $(category).text())
        .get()
        .join(" "),
    );

    if (!title || !link || !/bcbs\.com\/about-us\/association-news\//i.test(link)) {
      return;
    }

    items.push({
      sourceName: source.name,
      sourceFeedUrl: source.listingUrl,
      searchFallbackTerms: source.searchFallbackTerms || [],
      scanArticle: source.scanArticle !== false,
      articleScanMode: sourceArticleScanMode(source),
      title,
      link,
      guid: link,
      pubDate,
      description,
      feedContent: cleanText(
        [
          title,
          description,
          categories,
          "bcbs.com",
          "Blue Cross Blue Shield Association",
        ]
          .filter(Boolean)
          .join(" "),
      ),
    });
  });

  return items;
}

export function parseUvmHealthNewsroomItems(html, source) {
  const $ = cheerio.load(html);
  const items = [];

  $("outline-card-clickable, outline-search-result").each((_, element) => {
    const card = $(element);
    const linkElement = card.find('a[href^="/newsroom/"]').first();
    const title = cleanText(linkElement.text());
    const href = linkElement.attr("href");
    const link = resolveUrl(href, source.homepage || source.listingUrl);

    if (
      !title ||
      !link ||
      /\/newsroom\/(?:search|media-center)$/.test(new URL(link).pathname)
    ) {
      return;
    }

    const dateText = cleanText(card.find("[slot='date']").first().text());
    const pubDate = parseDate(dateText);
    const imageAlt = cleanText(card.find("img[alt]").first().attr("alt") || "");
    const description = cleanText(
      card.find("[slot='body']").first().text() || imageAlt,
    );
    const partner = cleanText(card.find("[slot='eyebrow']").first().text());

    items.push({
      sourceName: source.name,
      sourceFeedUrl: source.listingUrl,
      searchFallbackTerms: source.searchFallbackTerms || [],
      scanArticle: source.scanArticle !== false,
      articleScanMode: sourceArticleScanMode(source),
      title,
      link,
      guid: link,
      pubDate,
      description,
      feedContent: cleanText(
        [title, description, partner, "UVM Health"]
          .filter(Boolean)
          .join(" "),
      ),
    });
  });

  return items;
}

function getMetaContent($, names) {
  for (const name of names) {
    const propertyValue = $(`meta[property="${name}"]`).attr("content");
    if (propertyValue) {
      return decodeFeedText(propertyValue);
    }

    const nameValue = $(`meta[name="${name}"]`).attr("content");
    if (nameValue) {
      return decodeFeedText(nameValue);
    }
  }

  return "";
}

function parseFacebookCommentAuthor(ariaLabel) {
  return cleanText(ariaLabel)
    .replace(/^Comment by\s+/i, "")
    .replace(
      /\s+(?:about\s+)?(?:an?\s+hour|\d+\s+(?:minutes?|hours?|days?))\s+ago$/i,
      "",
    );
}

function parseFacebookPostTimestamp(html) {
  const match = /"(?:creation_time|publish_time)":(\d{9,12})\b/.exec(html);
  if (!match) {
    return null;
  }

  return new Date(Number.parseInt(match[1], 10) * 1000);
}

export function parseFacebookRelativeDate(text, now = new Date()) {
  const cleaned = cleanText(text);
  const match =
    /\b(?:(\d+)\s*([mhd])|(\d+)\s+(minutes?|hours?|days?)|an?\s+hour)\s*·/i.exec(
      cleaned,
    );
  if (!match) {
    return null;
  }

  let amount = 1;
  let unit = "hour";
  if (match[1] && match[2]) {
    amount = Number.parseInt(match[1], 10);
    unit = match[2].toLowerCase();
  } else if (match[3] && match[4]) {
    amount = Number.parseInt(match[3], 10);
    unit = match[4].toLowerCase();
  }

  const multipliers = {
    m: 60 * 1000,
    minute: 60 * 1000,
    minutes: 60 * 1000,
    h: 60 * 60 * 1000,
    hour: 60 * 60 * 1000,
    hours: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
  };
  const multiplier = multipliers[unit];
  if (!multiplier || !Number.isFinite(amount)) {
    return null;
  }

  return new Date(now.valueOf() - amount * multiplier);
}

function cleanFacebookCommentText(text, author) {
  let cleaned = cleanText(text).replace(/^Top fan/i, "");
  if (author && cleaned.toLowerCase().startsWith(author.toLowerCase())) {
    cleaned = cleaned.slice(author.length);
  }
  return cleanText(cleaned)
    .replace(/^Top fan/i, "")
    .replace(/\b(?:\d+[mhd](?:\d+)?|(?:about\s+)?(?:an?\s+hour|\d+\s+(?:minutes?|hours?|days?))\s+ago)$/i, "")
    .replace(/\d+[mhd](?:\d+)?$/i, "")
    .trim();
}

function extractFacebookComments($) {
  const comments = [];
  const seen = new Set();
  const selectors = [
    '[aria-label^="Comment by"]',
    '[aria-label*=" comment by"]',
    '[data-testid="UFI2Comment/body"]',
    ".UFICommentBody",
  ];

  for (const selector of selectors) {
    $(selector).each((_, element) => {
      const container = $(element);
      const aria = container.attr("aria-label") || "";
      const author = parseFacebookCommentAuthor(aria);
      const text = cleanFacebookCommentText(container.text(), author);
      if (!text || seen.has(`${author}:${text}`)) {
        return;
      }
      seen.add(`${author}:${text}`);
      comments.push({ author, text });
    });
  }

  return comments;
}

// Comments live in the same JSON-escaped preload blobs as posts: each node
// carries depth (0 = top-level, >0 = reply), body.text, then the author
// name and created_time shortly after. Replies nest under the preceding
// top-level comment, matching thread order in the HTML.
export function parseFacebookEmbeddedComments(html) {
  const comments = [];
  const seen = new Set();
  const bodyPattern = /"body":\{"text":"((?:[^"\\]|\\.)*)"/g;

  let match;
  while ((match = bodyPattern.exec(html)) !== null) {
    const text = cleanText(decodeFacebookJsonString(match[1]));
    if (!text) {
      continue;
    }

    const before = html.slice(Math.max(0, match.index - 600), match.index);
    const after = html.slice(match.index, match.index + 6000);
    const authorMatch = /"name":"((?:[^"\\]|\\.)*)"/.exec(after);
    const author = authorMatch
      ? cleanText(decodeFacebookJsonString(authorMatch[1]))
      : "";

    // The HTML repeats each comment in a second preload blob; keep the
    // first copy (the one preceded by its depth field).
    const key = `${author}:${text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const depthMatches = [...before.matchAll(/"depth":(\d+)/g)];
    const depthMatch = depthMatches.at(-1);
    const depth = depthMatch ? Number.parseInt(depthMatch[1], 10) : 0;
    const timeMatch = /"created_time":(\d{9,12})/.exec(after);
    const date = timeMatch
      ? new Date(Number.parseInt(timeMatch[1], 10) * 1000).toISOString()
      : null;

    if (depth > 0 && comments.length > 0) {
      comments[comments.length - 1].replies.push({ author, text, date });
    } else {
      comments.push({ author, text, date, replies: [] });
    }
  }

  return comments;
}

export function parseFacebookPostHtml(html, source) {
  const $ = cheerio.load(html);
  const description = getMetaContent($, [
    "og:description",
    "twitter:description",
    "description",
  ]);
  const pageTitle = getMetaContent($, ["og:title", "twitter:title"]) || source.name;
  const canonicalUrl =
    $('link[rel="canonical"]').attr("href") ||
    getMetaContent($, ["og:url"]) ||
    source.facebookPostUrl;
  const publishedAt = getMetaContent($, [
    "article:published_time",
    "article:modified_time",
  ]);
  const pubDate =
    parseDate(source.pubDate || publishedAt) || parseFacebookPostTimestamp(html);
  const embeddedComments = parseFacebookEmbeddedComments(html);
  const comments =
    embeddedComments.length > 0
      ? embeddedComments
      : extractFacebookComments($).map((comment) => ({
          ...comment,
          date: null,
          replies: [],
        }));

  if (!description && comments.length === 0) {
    return null;
  }

  const title = cleanText(
    source.title ||
      `${pageTitle} Facebook post${description ? `: ${description.slice(0, 80)}` : ""}`,
  );
  const commentText = comments
    .map((comment) =>
      [comment.text, ...(comment.replies || []).map((reply) => reply.text)].join(" "),
    )
    .join(" ");

  return {
    sourceName: source.name,
    sourceFeedUrl: source.facebookPostUrl,
    title,
    link: canonicalUrl,
    guid: canonicalUrl || source.facebookPostUrl,
    pubDate,
    description,
    comments,
    scanArticle: false,
    articleScanMode: "feedOnly",
    feedContent: cleanText([title, description, commentText].filter(Boolean).join(" ")),
  };
}

function normalizeFacebookUrl(value, baseUrl = "https://www.facebook.com/") {
  const url = resolveUrl(value?.replaceAll("&amp;", "&") || "", baseUrl);
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (
        key.startsWith("__") ||
        ["refid", "ref", "mibextid", "paipv", "eav"].includes(key)
      ) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function isFacebookPostLink(href = "") {
  return /\/posts\/|story\.php|permalink\.php/i.test(href);
}

// Facebook wraps post links in containers of unpredictable depth: the
// nearest wrappers carry the post text while outer ones accumulate
// page-wide boilerplate. Walk outward from the link and take the first
// text-bearing container that stays bounded; if every level is oversized,
// fall back to the shortest one, hard-truncated.
const MAX_FACEBOOK_POST_DESCRIPTION_CHARS = 1200;

function facebookPostDescription($link) {
  const linkText = cleanText($link.text());
  const minimumLength = Math.max(20, linkText.length + 1);
  let shortest = "";
  let node = $link.parent();

  for (let depth = 0; depth < 6 && node.length > 0; depth += 1) {
    const text = cleanText(node.text());
    if (text.length >= minimumLength && text.length <= MAX_FACEBOOK_POST_DESCRIPTION_CHARS) {
      return text;
    }
    if (text.length > 0 && (!shortest || text.length < shortest.length)) {
      shortest = text;
    }
    node = node.parent();
  }

  return shortest.slice(0, MAX_FACEBOOK_POST_DESCRIPTION_CHARS);
}

function decodeFacebookJsonString(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value.replace(/\\\//g, "/");
  }
}

// Facebook's no-login page HTML does not link posts in anchor tags — the
// timeline is rendered client-side. But the server preloads the most recent
// post as JSON-escaped script data containing the post permalink (wwwURL),
// message text, creation_time, and comment count. Each hourly run captures
// the page's current top post; the archive accumulates them over time.
export function parseFacebookEmbeddedPosts(html, source) {
  const items = [];
  const seen = new Set();
  const urlPattern =
    /"wwwURL":"(https:\\\/\\\/www\.facebook\.com\\\/[^"]*?\\\/posts\\\/[^"]+?)"/g;

  let match;
  while ((match = urlPattern.exec(html)) !== null) {
    const link = decodeFacebookJsonString(match[1]);
    if (!link || seen.has(link)) {
      continue;
    }
    seen.add(link);

    // The post's fields live near its wwwURL in the same preloaded blob.
    const windowStart = Math.max(0, match.index - 30000);
    const windowText = html.slice(windowStart, match.index + 30000);
    const messageMatch = /"message":\{"text":"((?:[^"\\]|\\.)*)"/.exec(
      windowText,
    );
    const message = messageMatch
      ? cleanText(decodeFacebookJsonString(messageMatch[1]))
      : "";
    if (!message) {
      continue;
    }

    const timeMatch = /"creation_time":(\d{9,12})\b/.exec(windowText);
    const pubDate = timeMatch
      ? new Date(Number.parseInt(timeMatch[1], 10) * 1000)
      : null;

    items.push({
      sourceName: source.name,
      sourceFeedUrl: source.facebookPageUrl,
      title: `${source.name} post: ${message.slice(0, 90)}`,
      link,
      guid: link,
      pubDate,
      description: message,
      comments: [],
      scanArticle: false,
      articleScanMode: "feedOnly",
      feedContent: cleanText([source.name, message].join(" ")),
    });
  }

  return items;
}

export function parseFacebookPageHtml(html, source) {
  const embedded = parseFacebookEmbeddedPosts(html, source);
  if (embedded.length > 0) {
    return embedded;
  }

  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();
  const pageTitle = cleanText($("title").first().text()) || source.name;

  $("a[href]").each((_, element) => {
    const href = $(element).attr("href") || "";
    if (!isFacebookPostLink(href)) {
      return;
    }

    const link = normalizeFacebookUrl(href, source.facebookPageUrl);
    if (!link || seen.has(link)) {
      return;
    }

    const description = cleanText(
      facebookPostDescription($(element)).replace(
        /\b(?:Like|Comment|Share|Full Story)\b/gi,
        " ",
      ),
    );
    if (!description) {
      return;
    }

    seen.add(link);
    const titleText = description.slice(0, 90);
    items.push({
      sourceName: source.name,
      sourceFeedUrl: source.facebookPageUrl,
      title: `${pageTitle} Facebook post: ${titleText}`,
      link,
      guid: link,
      pubDate: parseFacebookRelativeDate(description, source.now || new Date()),
      description,
      comments: [],
      scanArticle: false,
      articleScanMode: "feedOnly",
      feedContent: cleanText([pageTitle, description].join(" ")),
    });
  });

  return items;
}

export function mergeFacebookPagePostItem(pageItem, postItem, source) {
  if (!postItem) {
    return pageItem;
  }

  const comments =
    postItem.comments && postItem.comments.length > 0
      ? postItem.comments
      : pageItem.comments || [];
  const description = postItem.description || pageItem.description;
  const commentText = comments
    .map((comment) =>
      [comment.text, ...(comment.replies || []).map((reply) => reply.text)].join(" "),
    )
    .join(" ");

  return {
    ...pageItem,
    ...postItem,
    sourceName: source.name,
    sourceFeedUrl: source.facebookPageUrl,
    title: postItem.title || pageItem.title,
    link: postItem.link || pageItem.link,
    guid: postItem.guid || pageItem.guid,
    pubDate: postItem.pubDate || pageItem.pubDate,
    description,
    comments,
    scanArticle: false,
    articleScanMode: "feedOnly",
    feedContent: cleanText(
      [
        postItem.feedContent,
        pageItem.feedContent,
        commentText,
      ]
        .filter(Boolean)
        .join(" "),
    ),
  };
}

const ARTICLE_COMMENT_SELECTORS = [
  "#comments .comment",
  ".comments-area .comment",
  ".comment-list .comment",
  ".commentlist .comment",
  "ol.comment-list li",
  "ul.comment-list li",
  ".reader-comments .comment",
  ".article-comments .comment",
  ".story-comments .comment",
  "[itemprop='comment']",
  "[itemtype*='Comment']",
];

const ARTICLE_COMMENT_TEXT_SELECTORS = [
  ".comment-content",
  ".comment-body",
  ".comment-text",
  ".comment-copy",
  ".comment-message",
  "[itemprop='text']",
];

const ARTICLE_COMMENT_AUTHOR_SELECTORS = [
  "[itemprop='author'] [itemprop='name']",
  "[itemprop='author']",
  ".comment-author .fn",
  ".comment-author",
  ".byuser",
  ".byline",
  ".author",
  ".username",
  "cite",
];

const ARTICLE_COMMENT_DATE_SELECTORS = [
  "time[datetime]",
  "[datetime]",
  ".comment-date",
  ".comment-time",
  ".date",
];

const ARTICLE_COMMENT_BOILERPLATE_PATTERN =
  /\b(?:add a comment|cancel reply|comments are closed|join the conversation|leave a reply|log in to comment|post a comment|reply to|sign in to comment|submit comment)\b/i;

const DEFAULT_ARTICLE_TEXT_SELECTORS = [
  "article",
  "main",
  "[itemprop='articleBody']",
  ".article-body",
  ".story-body",
  ".entry-content",
  ".post-content",
  ".field--name-body",
  ".body-content",
];

const DOMAIN_ARTICLE_TEXT_SELECTORS = [
  {
    hostPattern: /(^|\.)vtdigger\.org$/i,
    selectors: [".entry-content", ".post-content", "article"],
  },
  {
    hostPattern: /(^|\.)wcax\.com$/i,
    selectors: [
      "[data-testid='article-body']",
      "[data-testid='story-body']",
      ".article-body",
      "article",
    ],
  },
  {
    hostPattern: /(^|\.)vermontpublic\.org$/i,
    selectors: [".storytext", ".entry-content", "[itemprop='articleBody']", "article"],
  },
  {
    hostPattern: /(^|\.)sevendaysvt\.com$/i,
    selectors: [".storyBody", ".article-content", ".entry-content", "article"],
  },
  {
    hostPattern: /(^|\.)vermontbiz\.com$/i,
    selectors: [".field--name-body", ".node__content", ".article-body", "article"],
  },
  {
    hostPattern: /(^|\.)bluecrossvt\.org$/i,
    selectors: [".field--name-body", ".body-content", ".paragraph--type--text", "article"],
  },
  {
    hostPattern: /(^|\.)uvmhealth\.org$/i,
    selectors: [".field--name-body", ".content-body", "main", "article"],
  },
  {
    hostPattern: /(^|\.)addisonindependent\.com$/i,
    selectors: [".entry-content", ".post-content", "article"],
  },
  {
    hostPattern: /(^|\.)statnews\.com$/i,
    selectors: [
      ".entry-content.the-content",
      ".wp-block-post-content",
      "[itemprop='articleBody']",
    ],
  },
  {
    hostPattern: /(^|\.)modernhealthcare\.com$/i,
    strictPreviewSelectors: true,
    selectors: [
      "[data-testid='article-body']",
      "[itemprop='articleBody']",
      ".article-body",
      ".story-body",
      ".entry-content",
    ],
  },
  {
    hostPattern: /(^|\.)valleynews\.com$/i,
    selectors: [".article-body", ".story-body", "[itemprop='articleBody']", "article"],
  },
];

function articleSelectorEntryForUrl(pageUrl = "") {
  let hostname = "";
  try {
    hostname = new URL(pageUrl).hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }

  return DOMAIN_ARTICLE_TEXT_SELECTORS.find((entry) =>
    entry.hostPattern.test(hostname),
  );
}

function articleSelectorsForUrl(pageUrl = "") {
  const matched = articleSelectorEntryForUrl(pageUrl);
  return [
    ...(matched?.selectors || []),
    ...DEFAULT_ARTICLE_TEXT_SELECTORS,
  ].filter((selector, index, selectors) => selectors.indexOf(selector) === index);
}

function firstCleanTextIncludingSelf($element, selectors) {
  for (const selector of selectors) {
    const target = $element.is(selector)
      ? $element
      : $element.find(selector).first();
    const value = cleanText(target.text());
    if (value) {
      return value;
    }
  }

  return "";
}

function extractArticleCommentAuthor($comment) {
  for (const selector of ARTICLE_COMMENT_AUTHOR_SELECTORS) {
    const target = $comment.find(selector).first();
    const value = cleanText(
      target.attr("content") ||
        target.attr("aria-label") ||
        target.text(),
    )
      .replace(/\s+says:?$/i, "")
      .trim();
    if (value && !ARTICLE_COMMENT_BOILERPLATE_PATTERN.test(value)) {
      return value;
    }
  }

  return "";
}

function extractArticleCommentDate($comment) {
  for (const selector of ARTICLE_COMMENT_DATE_SELECTORS) {
    const target = $comment.find(selector).first();
    const raw =
      target.attr("datetime") ||
      target.attr("content") ||
      target.attr("title") ||
      target.text();
    const parsed = parseDate(raw);
    if (parsed) {
      return parsed.toISOString();
    }
  }

  return null;
}

function extractArticleCommentText($, $comment) {
  const clone = $comment.clone();
  clone
    .find(
      [
        ARTICLE_COMMENT_SELECTORS.join(","),
        ".children",
        ".comment",
        ".comment-author",
        ".comment-meta",
        ".comment-reply-link",
        ".reply",
        ".avatar",
        "button",
        "form",
        "script",
        "style",
        "time",
      ].join(","),
    )
    .remove();

  let text = firstCleanTextIncludingSelf(clone, ARTICLE_COMMENT_TEXT_SELECTORS);
  if (!text) {
    const paragraphs = clone
      .find("p")
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean);
    text = cleanText(paragraphs.join(" "));
  }
  if (!text) {
    text = cleanText(clone.text());
  }

  if (ARTICLE_COMMENT_BOILERPLATE_PATTERN.test(text)) {
    return "";
  }

  return text.length > 1200 ? `${text.slice(0, 1197).trim()}...` : text;
}

function normalizeArticleComment(comment, seen) {
  const text = cleanText(comment.text || "");
  if (text.length < 12 || ARTICLE_COMMENT_BOILERPLATE_PATTERN.test(text)) {
    return null;
  }

  const author = cleanText(comment.author || "");
  const key = `${author.toLowerCase()}|${text.toLowerCase()}`;
  if (seen.has(key)) {
    return null;
  }
  seen.add(key);

  return {
    author,
    text,
    date: comment.date || null,
    replies: [],
  };
}

function walkJsonLdForComments(value, comments, seen) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (const child of value) {
      walkJsonLdForComments(child, comments, seen);
    }
    return;
  }

  const type = Array.isArray(value["@type"])
    ? value["@type"].join(" ")
    : value["@type"] || "";
  if (/\bComment\b/i.test(type)) {
    const authorValue = value.author;
    const author =
      typeof authorValue === "string"
        ? authorValue
        : authorValue?.name || authorValue?.alternateName || "";
    const date =
      parseDate(value.datePublished || value.dateCreated || value.dateModified)
        ?.toISOString() || null;
    const normalized = normalizeArticleComment(
      {
        author,
        text: value.text || value.commentText || value.description || "",
        date,
      },
      seen,
    );
    if (normalized) {
      comments.push(normalized);
    }
  }

  for (const child of Object.values(value)) {
    walkJsonLdForComments(child, comments, seen);
  }
}

export function extractArticleComments(html) {
  const $ = cheerio.load(html);
  const comments = [];
  const seen = new Set();
  const selector = ARTICLE_COMMENT_SELECTORS.join(",");
  // Comment elements arrive in document order, so a parent's entry exists
  // before its nested replies are visited. Replies attach to the nearest
  // enclosing captured comment instead of being dropped.
  const entriesByElement = new Map();

  $(selector).each((_, element) => {
    const $comment = $(element);
    const normalized = normalizeArticleComment(
      {
        author: extractArticleCommentAuthor($comment),
        text: extractArticleCommentText($, $comment),
        date: extractArticleCommentDate($comment),
      },
      seen,
    );
    if (!normalized) {
      return;
    }
    entriesByElement.set(element, normalized);

    let parentEntry = null;
    $comment.parents().each((__, candidate) => {
      if (!parentEntry && entriesByElement.has(candidate)) {
        parentEntry = entriesByElement.get(candidate);
      }
    });
    if (parentEntry) {
      parentEntry.replies.push(normalized);
    } else {
      comments.push(normalized);
    }
  });

  $("script[type='application/ld+json']").each((_, element) => {
    try {
      walkJsonLdForComments(JSON.parse($(element).text()), comments, seen);
    } catch {
      // Ignore malformed embedded data; comments are best-effort enrichment.
    }
  });

  return comments.slice(0, 25);
}

export function htmlToArticleText(html, pageUrl = "") {
  const $ = cheerio.load(html);
  // Remove navigation, sidebar, ads, and header/footer elements
  $("script, style, noscript, svg, iframe, form, nav, footer, header, aside, .sidebar, #sidebar, .nav, .menu, .ads, .ad, .advertisement, [role='banner'], [role='navigation'], [role='contentinfo']").remove();

  const candidates = articleSelectorsForUrl(pageUrl);

  for (const selector of candidates) {
    const element = $(selector);
    if (element.length > 0) {
      const paragraphs = element
        .find("p")
        .map((_, el) => $(el).text().trim())
        .get()
        .filter(Boolean);
      if (paragraphs.length > 0) {
        return cleanText(paragraphs.join(" "));
      }
      const text = cleanText(element.text());
      if (text) {
        return text;
      }
    }
  }

  const paragraphs = $("body p")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter(Boolean);
  if (paragraphs.length > 0) {
    return cleanText(paragraphs.join(" "));
  }

  return cleanText($("body").text());
}

const ARTICLE_PREVIEW_BOILERPLATE_PATTERN =
  /\b(?:already a subscriber|create an account|log in|login|register to continue|sign in|subscribe|subscription|unlock this article)\b/i;

export function extractArticlePreview(html, pageUrl = "", options = {}) {
  const maxCharacters = Math.max(40, Number(options.maxCharacters) || 600);
  const maxParagraphs = Math.max(1, Number(options.maxParagraphs) || 2);
  const $ = cheerio.load(html);
  $(
    "script, style, noscript, svg, iframe, form, nav, footer, header, aside, .sidebar, #sidebar, .nav, .menu, .ads, .ad, .advertisement, [role='banner'], [role='navigation'], [role='contentinfo']",
  ).remove();

  const selectorEntry = articleSelectorEntryForUrl(pageUrl);
  const selectors = selectorEntry?.strictPreviewSelectors
    ? selectorEntry.selectors
    : articleSelectorsForUrl(pageUrl);
  let paragraphs = [];
  for (const selector of selectors) {
    const element = $(selector).first();
    if (element.length === 0) {
      continue;
    }
    paragraphs = element
      .find("p")
      .map((_, paragraph) => cleanText($(paragraph).text()))
      .get()
      .filter(
        (paragraph) =>
          paragraph.length >= 20 &&
          !ARTICLE_PREVIEW_BOILERPLATE_PATTERN.test(paragraph),
      );
    if (paragraphs.length > 0) {
      break;
    }
  }

  if (paragraphs.length === 0 && articleSelectorEntryForUrl(pageUrl)) {
    return "";
  }

  if (paragraphs.length === 0) {
    paragraphs = $("body p")
      .map((_, paragraph) => cleanText($(paragraph).text()))
      .get()
      .filter(
        (paragraph) =>
          paragraph.length >= 20 &&
          !ARTICLE_PREVIEW_BOILERPLATE_PATTERN.test(paragraph),
      );
  }

  return normalizePreviewText(
    cleanText(paragraphs.slice(0, maxParagraphs).join(" ")),
    maxCharacters,
  );
}

const ARTICLE_TITLE_STOP_WORDS = new Set([
  "about",
  "after",
  "from",
  "health",
  "latest",
  "news",
  "that",
  "their",
  "this",
  "with",
]);

function articleTitleTokens(value = "") {
  return new Set(
    cleanText(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter(
        (token) => token.length >= 4 && !ARTICLE_TITLE_STOP_WORDS.has(token),
      ),
  );
}

export function articlePageMatchesTitle(
  html,
  expectedTitle,
  { requireEvidence = false } = {},
) {
  const expectedTokens = articleTitleTokens(expectedTitle);
  if (expectedTokens.size === 0) {
    return !requireEvidence;
  }

  const $ = cheerio.load(html);
  const candidates = [
    $("meta[property='og:title']").attr("content"),
    $("meta[name='twitter:title']").attr("content"),
    $("h1").first().text(),
    $("title").text(),
  ].filter(Boolean);
  if (candidates.length === 0) {
    return !requireEvidence;
  }

  const requiredMatches = Math.min(2, expectedTokens.size);
  return candidates.some((candidate) => {
    const candidateTokens = articleTitleTokens(candidate);
    const matches = [...expectedTokens].filter((token) =>
      candidateTokens.has(token),
    ).length;
    return matches >= requiredMatches && matches / expectedTokens.size >= 0.3;
  });
}

function normalizedArticleUrl(value) {
  const url = new URL(value);
  for (const key of [...url.searchParams.keys()]) {
    if (
      /^(?:utm_.+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid)$/i.test(key)
    ) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  return {
    host: `${url.hostname.replace(/^www\./i, "").toLowerCase()}${
      url.port ? `:${url.port}` : ""
    }`,
    pathname: url.pathname.replace(/\/+$/, "") || "/",
    query: url.searchParams.toString(),
  };
}

export function articleUrlsMatch(left, right) {
  try {
    const leftUrl = normalizedArticleUrl(left);
    const rightUrl = normalizedArticleUrl(right);
    return (
      leftUrl.host === rightUrl.host &&
      leftUrl.pathname === rightUrl.pathname &&
      leftUrl.query === rightUrl.query
    );
  } catch {
    return false;
  }
}

export function articleUrlQueriesMatch(left, right) {
  try {
    return normalizedArticleUrl(left).query === normalizedArticleUrl(right).query;
  } catch {
    return false;
  }
}

function jsonLdDeclaresArticle(value, expectedUrl) {
  if (Array.isArray(value)) {
    return value.some((entry) => jsonLdDeclaresArticle(entry, expectedUrl));
  }
  if (!value || typeof value !== "object") {
    return false;
  }

  const types = Array.isArray(value["@type"])
    ? value["@type"]
    : [value["@type"]];
  const isArticle = types.some((type) =>
    /^(?:article|newsarticle|reportagenewsarticle)$/i.test(String(type || "")),
  );
  if (isArticle) {
    const declaredUrl = value.url || value.mainEntityOfPage?.["@id"] || "";
    return !declaredUrl || articleUrlsMatch(declaredUrl, expectedUrl);
  }

  return Object.values(value).some((entry) =>
    jsonLdDeclaresArticle(entry, expectedUrl),
  );
}

// A publisher can return a soft 404 or its homepage at the requested URL.
// When the visible title changed, require evidence that the response is still
// an article before body text is trusted for brand matching.
function articlePageHasMissingMarker($) {
  const pageIdentity = cleanText([
    $("title").first().text(),
    $("h1").first().text(),
    $("meta[property='og:title']").attr("content") || "",
  ].join(" "));
  const bodyLead = cleanText(
    $("main, article, [role='main'], body").first().text(),
  ).slice(0, 400);
  const identityMissing =
    /(?:\b404\b|\bpage not found\b|\barticle not found\b|\bstory not found\b)/i
      .test(pageIdentity);
  const bodyMissing =
    /(?:^|\s)(?:error\s*)?404\s*[:|-]?\s*(?:page\s+)?not found\b/i
      .test(bodyLead) ||
    /^(?:page|article|story) not found\b/i.test(bodyLead);
  return identityMissing || bodyMissing;
}

function articlePageCanonical($, expectedUrl) {
  return resolveUrl(
    $('link[rel="canonical"]').first().attr("href"),
    expectedUrl,
  );
}

export function articlePageContradictsExpectedIdentity(html, expectedUrl) {
  const $ = cheerio.load(html);
  if (articlePageHasMissingMarker($)) {
    return true;
  }
  const canonical = articlePageCanonical($, expectedUrl);
  return Boolean(canonical) && !articleUrlsMatch(canonical, expectedUrl);
}

export function articlePageHasArticleEvidence(html, expectedUrl) {
  const $ = cheerio.load(html);
  if (articlePageHasMissingMarker($)) {
    return false;
  }
  const canonical = articlePageCanonical($, expectedUrl);
  if (canonical) {
    return articleUrlsMatch(canonical, expectedUrl);
  }
  if (/^article$/i.test($("meta[property='og:type']").attr("content") || "")) {
    return true;
  }
  if ($("[itemprop='articleBody']").length > 0) {
    return true;
  }
  if (
    $("article").filter((_, article) =>
      $(article).find("p, [itemprop='articleBody']").length > 0,
    ).length > 0
  ) {
    return true;
  }

  return $("script[type='application/ld+json']")
    .toArray()
    .some((script) => {
      try {
        return jsonLdDeclaresArticle(JSON.parse($(script).text()), expectedUrl);
      } catch {
        return false;
      }
    });
}

// ---------------------------------------------------------------------------
// Curated backfill. The communications team's media tracker is a hand-kept
// list of coverage, and much of it predates this crawler (first commit
// 2026-05-13) or sits behind outlets that block us, so no crawl can recover
// it. Seeding the list turns "what the crawler found" into "what the team
// knows about". Entries carry the tracker's own headline, outlet, date, and
// topic, which is all the matcher and the summarizer need.
// ---------------------------------------------------------------------------
export function parseMediaTrackerSeedItems(json, source) {
  let doc;
  try {
    doc = typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    return [];
  }

  const articles = Array.isArray(doc?.articles) ? doc.articles : [];
  return articles
    .map((article) => {
      const link = cleanText(article?.url || "");
      if (!/^https?:\/\//i.test(link)) {
        return null;
      }
      const title = cleanText(article?.title || "") || link;
      // The topic column is the team's own note on why the story mattered, so
      // it carries the brand evidence the headline often lacks.
      const description = cleanText(
        [article?.topic, article?.outlet].filter(Boolean).join(". "),
      );
      const pubDate = article?.pubDate ? new Date(article.pubDate) : null;

      return {
        sourceName: source.name,
        sourceFeedUrl: source.homepage || "",
        isSearchFeed: false,
        searchFallbackTerms: [],
        scanArticle: source.scanArticle !== false,
        articleScanMode: "off",
        title,
        link,
        guid: link,
        pubDate: pubDate && !Number.isNaN(pubDate.valueOf()) ? pubDate : null,
        description,
        sourceCategories: [],
        feedContent: cleanText([title, description].filter(Boolean).join(" ")),
        // Provenance. Read by enrichment to keep the item even when no term
        // matches, and by relevance to treat the entry as vetted coverage.
        fromMediaTracker: true,
        trackerOutlet: cleanText(article?.outlet || ""),
      };
    })
    .filter(Boolean);
}
