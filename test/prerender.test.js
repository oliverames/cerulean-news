import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as cheerio from "cheerio";
import { generateFeed } from "../src/index.js";
import {
  JSONLD_END,
  JSONLD_START,
  LIST_END,
  LIST_START,
  PAGE_SIZE,
  buildItemListJsonLd,
  escapeHtml,
  injectPrerender,
  prerenderIndex,
  renderStoryItem,
  selectFirstPage,
} from "../src/prerender.js";

const PAGE = `<!doctype html><html><head>
<title>t</title>
${JSONLD_START}${JSONLD_END}
</head><body><ul id="stories">
${LIST_START}${LIST_END}
</ul></body></html>`;

// Item n is n minutes before a fixed noon, so a higher n is older.
function makeItem(n, overrides = {}) {
  return {
    title: `Story ${n}`,
    link: `https://example.com/story-${n}`,
    sourceName: "Example Outlet",
    outlet: "Example Outlet",
    sourceType: "News",
    access: "Free to read",
    pubDate: new Date(Date.UTC(2026, 8, 28, 16, 0) - n * 60_000).toISOString(),
    summary: `Summary ${n}`,
    ...overrides,
  };
}

function blockBetween(html, start, end) {
  const from = html.indexOf(start) + start.length;
  return html.slice(from, html.indexOf(end, from));
}

test("feed text is escaped in text, attributes, and JSON-LD", () => {
  const nasty = `<img src=x onerror="alert(1)"> & "quoted" 'single'`;
  const item = makeItem(1, {
    title: `</a><script>alert(1)</script>${nasty}`,
    summary: nasty,
    reason: nasty,
    sourceName: nasty,
    access: "Paywall likely",
    previewText: nasty,
    sentiment: "negative",
    sentimentScore: 12,
    sentimentReason: nasty,
  });
  const related = makeItem(2, { title: nasty, outlet: nasty, link: "https://example.com/r" });
  const html = injectPrerender(PAGE, [item, { ...related, storyGroupId: "g" }, { ...item, storyGroupId: "g" }]);

  const list = blockBetween(html, LIST_START, LIST_END);
  const $ = cheerio.load(list);
  assert.equal($("script").length, 0);
  assert.equal($("img").length, 0);
  assert.equal($("[onerror]").length, 0);
  // Unescaped angle brackets from feed text never reach the markup.
  assert.ok(!list.includes("<img"));
  assert.ok(!list.includes("alert(1)</script>"));
  // Round trip: what a browser would read back is the original text.
  assert.equal($("h2.headline a").first().text(), item.title);
  assert.equal($(".summary").first().text(), nasty);
  assert.equal($(".related a").first().attr("title"), nasty);

  const jsonBlock = blockBetween(html, JSONLD_START, JSONLD_END);
  assert.ok(!jsonBlock.slice(jsonBlock.indexOf("</script>") + 9).includes("<"));
  assert.equal((jsonBlock.match(/<\/script>/g) || []).length, 1);
  const ld = JSON.parse(jsonBlock.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]);
  assert.equal(ld.itemListElement[0].name, item.title);
});

test("only http and https links become hrefs", () => {
  const html = renderStoryItem({
    item: makeItem(1, { link: "javascript:alert(1)" }),
    related: [makeItem(2, { link: "data:text/html,x" })],
  });
  const $ = cheerio.load(html);
  assert.equal($("h2 a").attr("href"), undefined);
  assert.equal($(".related a").attr("href"), undefined);
  assert.equal(
    cheerio.load(renderStoryItem({ item: makeItem(3), related: [] }))("h2 a").attr("href"),
    "https://example.com/story-3",
  );
  // A link that is not http(s) is left out of the ItemList too.
  assert.equal(
    buildItemListJsonLd([{ item: makeItem(1, { link: "javascript:alert(1)" }), related: [] }])
      .itemListElement.length,
    0,
  );
});

test("the first page holds the newest 25 stories, newest first", () => {
  // Shuffled input, 40 stories.
  const items = Array.from({ length: 40 }, (_, i) => makeItem(i)).reverse();
  const entries = selectFirstPage(items);
  assert.equal(PAGE_SIZE, 25);
  assert.equal(entries.length, 25);
  assert.deepEqual(
    entries.map((entry) => entry.item.title),
    Array.from({ length: 25 }, (_, i) => `Story ${i}`),
  );

  const html = injectPrerender(PAGE, items);
  const $ = cheerio.load(blockBetween(html, LIST_START, LIST_END));
  assert.equal($("li").length, 25);
  assert.equal($("li").first().find("h2.headline a").text(), "Story 0");
  assert.equal($("li").last().find("h2.headline a").text(), "Story 24");

  const ld = JSON.parse(
    blockBetween(html, JSONLD_START, JSONLD_END).match(/<script[^>]*>([\s\S]*?)<\/script>/)[1],
  );
  assert.equal(ld["@type"], "ItemList");
  assert.equal(ld.numberOfItems, 25);
  assert.equal(ld.itemListElement.length, 25);
  assert.deepEqual(ld.itemListElement[0], {
    "@type": "ListItem",
    position: 1,
    url: "https://example.com/story-0",
    name: "Story 0",
  });
  assert.equal(ld.itemListElement[24].position, 25);
});

test("the default view leaves out the insurer's own posts and social items", () => {
  const items = [
    makeItem(1),
    makeItem(2, { sourceType: "BlueCrossVT.org" }),
    makeItem(3, { link: "https://www.bluecrossvt.org/news/x" }),
    makeItem(4, { sourceType: "Social" }),
    makeItem(5, { sourceName: "Facebook page" }),
    makeItem(6),
  ];
  assert.deepEqual(
    selectFirstPage(items).map((entry) => entry.item.title),
    ["Story 1", "Story 6"],
  );
});

test("reports of one story collapse under the newest, and the group counts once", () => {
  const items = [
    makeItem(0, { storyGroupId: "a", outlet: "Lead Outlet" }),
    makeItem(1, { storyGroupId: "a", outlet: "Second Outlet" }),
    makeItem(2),
    makeItem(3, { storyGroupId: "a", outlet: "Third Outlet" }),
    ...Array.from({ length: 30 }, (_, i) => makeItem(10 + i)),
  ];
  const entries = selectFirstPage(items);
  assert.equal(entries.length, 25);
  assert.equal(entries[0].item.title, "Story 0");
  assert.deepEqual(entries[0].related.map((item) => item.title), ["Story 1", "Story 3"]);

  const html = injectPrerender(PAGE, items);
  const $ = cheerio.load(blockBetween(html, LIST_START, LIST_END));
  assert.equal($("li").length, 25);
  assert.equal($(".headline a:contains('Story 1')").filter((_, el) => $(el).text() === "Story 1").length, 0);
  const related = $("li").first().find("p.related");
  assert.equal(related.find(".reason-label").text(), "Also covered by: ");
  assert.deepEqual(related.find("a").map((_, el) => $(el).text()).get(), ["Second Outlet", "Third Outlet"]);
  assert.equal(related.find("a").first().attr("title"), "Story 1");
  assert.equal($("li:nth-child(2) p.related").length, 0);
});

test("stories use the reader's markup and classes", () => {
  const html = renderStoryItem({
    item: makeItem(1, {
      access: "Paywall likely",
      previewText: "The first lines of the article.",
      reason: "Vermont coverage",
      sentiment: "neutral to positive",
      sentimentScore: 61,
      sentimentReason: "Measured tone",
    }),
    related: [],
  });
  const $ = cheerio.load(html);
  assert.equal($("li > div.meta").text(), "Sep 28, 2026 · Example Outlet · Paywall likely");
  assert.equal($("li > h2.headline > a").text(), "Story 1");
  assert.equal($("li > p.summary").text(), "Summary 1");
  assert.equal($("li > blockquote.publisher-preview > span.publisher-preview-label").text(), "Publisher preview: ");
  assert.equal($("li > p.reason > span.reason-label").text(), "Included because: ");
  assert.equal($("li > p.sentiment > span.sentiment-swatch").attr("style"), "background: var(--s-npos);");
  assert.equal($(".sentiment-label").text(), "Sentiment: 61 · neutral to positive");
  assert.equal($(".sentiment-label").attr("title"), "0 is negative, 50 neutral, 100 positive toward Blue Cross VT");
  assert.equal($("p.sentiment").text(), "Sentiment: 61 · neutral to positive — Measured tone");

  // Promotional preview text and a missing score are handled as in the reader.
  const plain = cheerio.load(
    renderStoryItem({
      item: makeItem(2, {
        access: "Paywall likely",
        previewText: "Good morning, everyone. Subscribe.",
        sentiment: "negative",
        summary: "",
        snippet: "Fallback snippet",
      }),
      related: [],
    }),
  );
  assert.equal(plain("blockquote").length, 0);
  assert.equal(plain(".summary").text(), "Fallback snippet");
  assert.equal(plain(".sentiment-label").text(), "Sentiment: negative");
  assert.equal(plain(".sentiment-label").attr("title"), undefined);
});

test("running the injection twice replaces the block instead of appending", () => {
  const items = Array.from({ length: 30 }, (_, i) => makeItem(i));
  const once = injectPrerender(PAGE, items);
  const twice = injectPrerender(once, items);
  assert.equal(twice, once);
  assert.equal(once.split(LIST_START).length, 2);
  assert.equal(once.split(JSONLD_START).length, 2);
  assert.equal(cheerio.load(once)("li").length, 25);
  assert.equal(cheerio.load(once)('script[type="application/ld+json"]').length, 1);

  // A different feed replaces the earlier stories entirely.
  const other = injectPrerender(once, [makeItem(99, { title: "Only story" })]);
  assert.equal(cheerio.load(other)("li").length, 1);
  assert.ok(!other.includes("Story 3<"));
  // An empty feed puts the page back to empty markers.
  assert.equal(injectPrerender(once, []), PAGE);
  // Text like "$&" in a headline is not treated as a replacement pattern.
  const dollars = injectPrerender(PAGE, [makeItem(1, { title: "Costs $& $1 $`" })]);
  assert.ok(dollars.includes("Costs $&amp; $1 $`"));
});

test("a page without markers is left alone", () => {
  assert.equal(injectPrerender("<html><body><ul></ul></body></html>", [makeItem(1)]), null);
  assert.equal(injectPrerender(`${LIST_END}${LIST_START}`, [makeItem(1)]), null);
});

test("prerenderIndex rewrites the page in place, skips a missing one, and is idempotent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prerender-"));
  try {
    const indexPath = path.join(dir, "index.html");
    assert.deepEqual(await prerenderIndex(indexPath, [makeItem(1)]), {
      written: false,
      reason: "no page",
    });

    await writeFile(indexPath, PAGE, "utf8");
    const items = Array.from({ length: 5 }, (_, i) => makeItem(i));
    assert.deepEqual(await prerenderIndex(indexPath, items), { written: true, count: 5 });
    const first = await readFile(indexPath, "utf8");
    await prerenderIndex(indexPath, items);
    assert.equal(await readFile(indexPath, "utf8"), first);
    assert.equal(cheerio.load(first)("li").length, 5);

    await writeFile(indexPath, "<html></html>", "utf8");
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      assert.deepEqual(await prerenderIndex(indexPath, items), {
        written: false,
        reason: "no markers",
      });
    } finally {
      console.warn = originalWarn;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generateFeed prerenders index.html next to the feed it writes, and again on the next run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prerender-generate-"));
  try {
    const now = new Date("2026-09-28T12:00:00Z");
    const story = {
      title: "Vermont hospital budget review",
      link: "https://vtdigger.org/2026/09/27/budget",
      sourceName: "VTDigger",
      snippet: "Green Mountain Care Board reviews Vermont hospital budgets.",
      matchedTerms: ["hospital"],
      category: "topic",
      summary: "Vermont hospital budgets are under review.",
      reason: "Hospital budgets.",
      relevant: true,
      pubDate: now.toISOString(),
    };
    const paths = {
      rssOutputPath: path.join(dir, "feed.rss"),
      jsonOutputPath: path.join(dir, "feed.json"),
      auditJsonOutputPath: path.join(dir, "feed-audit.json"),
    };
    await writeFile(paths.auditJsonOutputPath, JSON.stringify({ generatedAt: now.toISOString(), items: [story] }));
    await writeFile(path.join(dir, "index.html"), PAGE, "utf8");

    await generateFeed({ sources: [], now, ...paths, jevOptions: { mode: "off" } });
    const first = await readFile(path.join(dir, "index.html"), "utf8");
    assert.match(first, /Vermont hospital budget review/);
    assert.equal(cheerio.load(first)("li").length, 1);

    await generateFeed({ sources: [], now, ...paths, jevOptions: { mode: "off" } });
    assert.equal(await readFile(path.join(dir, "index.html"), "utf8"), first);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the committed reader keeps empty prerender markers", async () => {
  // Generated stories belong in the build output, never in git.
  const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  assert.equal(html.split(LIST_START).length, 2, "one list start marker");
  assert.equal(html.split(LIST_END).length, 2, "one list end marker");
  assert.equal(html.split(JSONLD_START).length, 2, "one JSON-LD start marker");
  assert.equal(html.split(JSONLD_END).length, 2, "one JSON-LD end marker");
  assert.equal(blockBetween(html, LIST_START, LIST_END).trim(), "");
  assert.equal(blockBetween(html, JSONLD_START, JSONLD_END).trim(), "");
  // The list markers sit inside the story list container.
  const $ = cheerio.load(html);
  const list = $("ul#stories");
  assert.equal(list.length, 1);
  assert.ok(list.html().includes(LIST_START));
  assert.ok(list.html().includes(LIST_END));
});

test("escapeHtml covers the five characters that matter", () => {
  assert.equal(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});
