import assert from "node:assert/strict";
import test from "node:test";
import {
  bodyQuoteField,
  detectQuotedSpokespeople,
  loadSpokespeople,
  normalizeSpokespeople,
  quotedSpokespeopleForItem,
} from "../src/quotes.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildJsonSummary } from "../src/outputs.js";
import { enrichAndFilterItems } from "../src/enrich.js";
import { loadPreviousState } from "../src/archive.js";

const people = normalizeSpokespeople([
  { name: "Beth Roberts", aliases: ["Beth Ann Roberts"], title: "President and CEO", since: "2026-01-10" },
  { name: "Don George", aliases: [], title: "President and CEO", until: "2026-01-10" },
  { name: "Kristina Massari", aliases: ["Kristina Masseri"], title: "Spokesperson" },
  { name: "Ruth Greene", aliases: [], title: "Chief Financial Officer" },
]);
const detect = (text, at = "2026-03-01") =>
  detectQuotedSpokespeople(text, { spokespeople: people, at });

test("the seed file loads and every entry has a name and title", () => {
  const list = loadSpokespeople();
  assert.ok(list.length >= 3);
  for (const person of list) {
    assert.ok(person.name && person.title);
    assert.ok(Array.isArray(person.aliases));
  }
});

test("attribution language beside a known name counts as a quote", () => {
  assert.deepEqual(
    detect("Kristina Massari, a spokesperson for BlueCross BlueShield of Vermont, wrote in an email Thursday that the insurer opted to cover it."),
    ["Kristina Massari"],
  );
  assert.deepEqual(detect("Beth Roberts said the plan would lower costs."), ["Beth Roberts"]);
  assert.deepEqual(
    detect("“We went hunting,” Ruth Greene, the insurer’s chief financial officer, told the board."),
    ["Ruth Greene"],
  );
  assert.deepEqual(detect("Costs are rising, according to Beth Roberts."), ["Beth Roberts"]);
  assert.deepEqual(detect("“We are recovering,” said Ruth Greene, the chief financial officer."), ["Ruth Greene"]);
  assert.deepEqual(detect("The plan is delayed. Blue Cross spokesperson Kristina Massari declined further comment."), ["Kristina Massari"]);
  assert.deepEqual(detect("It is a big win for Vermonters.” Beth Roberts, President and CEO of Blue Cross and Blue Shield of Vermont, described the law."), ["Beth Roberts"]);
});

test("aliases and misspellings match the same person", () => {
  assert.deepEqual(detect("Spokesperson Kristina Masseri told VTDigger the insurer covers it."), ["Kristina Massari"]);
  assert.deepEqual(detect("Beth Ann Roberts said the insurer would recover."), ["Beth Roberts"]);
});

test("a last name alone counts only after the full name appeared", () => {
  assert.deepEqual(
    detect("Beth Roberts leads the insurer. Roberts said costs must fall."),
    ["Beth Roberts"],
  );
  assert.deepEqual(detect("Roberts said costs must fall."), []);
  assert.deepEqual(
    detect("Beth Roberts leads the insurer. Jane Roberts said costs must fall."),
    [],
  );
});

test("a name without attribution is not counted", () => {
  assert.deepEqual(detect("Beth Roberts, President and CEO of Blue Cross and Blue Shield of Vermont, took over on Saturday."), []);
  assert.deepEqual(detect("Blue Cross names Beth Roberts as the next CEO."), []);
  assert.deepEqual(detect("The board said Ruth Greene was hired in 2019."), []);
  assert.deepEqual(detect("Lawmakers told Beth Roberts they were concerned."), []);
  assert.deepEqual(detect("Blue Cross said it would cut costs."), []);
  assert.deepEqual(detect(""), []);
});

test("common-name collisions with another organization are rejected", () => {
  assert.deepEqual(detect("Springfield Mayor Beth Roberts said the budget passed."), []);
  assert.deepEqual(detect("Beth Roberts, a nurse at UVM Medical Center, said staffing is thin."), []);
  assert.deepEqual(detect("“We are short,” said Ruth Greene of the Vermont Nurses Association."), []);
  assert.deepEqual(detect("The USS George Washington said nothing about it."), []);
  assert.deepEqual(detect("“We are short,” said Beth Roberts, mayor of Springfield."), []);
});

test("since and until bound who can be quoted by the story date", () => {
  const george = "Don George said premiums must rise.";
  assert.deepEqual(detect(george, "2025-06-01"), ["Don George"]);
  assert.deepEqual(detect(george, "2026-01-10T12:00:00Z"), ["Don George"]);
  assert.deepEqual(detect(george, "2026-02-01"), []);
  const roberts = "Beth Roberts said premiums must fall.";
  assert.deepEqual(detect(roberts, "2025-12-01"), []);
  assert.deepEqual(detect(roberts, "2026-01-10"), ["Beth Roberts"]);
  // A dated role cannot be checked against an undated story.
  assert.deepEqual(detect(roberts, null), []);
  // An undated role needs no date.
  assert.deepEqual(detect("Ruth Greene said it.", null), ["Ruth Greene"]);
});

test("item detection reads snippet, description, preview, and body names", () => {
  const base = { pubDate: new Date("2026-03-01T12:00:00Z") };
  const opts = { spokespeople: people };
  assert.deepEqual(
    quotedSpokespeopleForItem({ ...base, snippet: "Ruth Greene said it." }, opts),
    ["Ruth Greene"],
  );
  assert.deepEqual(
    quotedSpokespeopleForItem({ ...base, description: "Beth Roberts said it." }, opts),
    ["Beth Roberts"],
  );
  assert.deepEqual(
    quotedSpokespeopleForItem({ ...base, previewText: "Beth Roberts said it." }, opts),
    ["Beth Roberts"],
  );
  assert.deepEqual(
    quotedSpokespeopleForItem({ ...base, snippet: "", bodyQuotedSpokespeople: ["Ruth Greene", "Nobody Known"] }, opts),
    ["Ruth Greene"],
  );
  // A summary is model-written, so it is not evidence of a quote.
  assert.deepEqual(
    quotedSpokespeopleForItem({ ...base, summary: "Beth Roberts said it." }, opts),
    [],
  );
});

test("bodyQuoteField adds a key only for a non-empty list", () => {
  assert.deepEqual(bodyQuoteField(["Ruth Greene"]), { bodyQuotedSpokespeople: ["Ruth Greene"] });
  assert.deepEqual(bodyQuoteField([]), {});
  assert.deepEqual(bodyQuoteField(undefined), {});
});

const feedItem = (extra) => ({
  title: "Story",
  link: "https://example.test/story",
  sourceName: "VTDigger",
  pubDate: new Date("2026-03-19T12:00:00Z"),
  relevant: true,
  ...extra,
});

test("feed.json publishes quotedSpokespeople on brand items only", () => {
  const brand = feedItem({
    link: "https://example.test/brand",
    matchedTerms: ["Blue Cross VT"],
    snippet: "Kristina Massari, a spokesperson for BlueCross BlueShield of Vermont, said the insurer covers it.",
  });
  const brandNoQuote = feedItem({
    link: "https://example.test/brand-plain",
    matchedTerms: ["Blue Cross VT"],
    snippet: "Kristina Massari works at Blue Cross VT.",
  });
  const topic = feedItem({
    link: "https://example.test/topic",
    matchedTerms: ["Green Mountain Care Board"],
    snippet: "Kristina Massari said something about health care.",
  });
  const summary = buildJsonSummary([brand, brandNoQuote, topic], [], new Date("2026-03-20T00:00:00Z"));
  const byUrl = Object.fromEntries(summary.items.map((item) => [item.url, item]));
  assert.deepEqual(byUrl["https://example.test/brand"].quotedSpokespeople, ["Kristina Massari"]);
  assert.deepEqual(byUrl["https://example.test/brand-plain"].quotedSpokespeople, []);
  assert.equal(byUrl["https://example.test/topic"].quotedSpokespeople, undefined);
  assert.equal(summary.spokespeopleTitles["Kristina Massari"], "Spokesperson");
  assert.equal(byUrl["https://example.test/brand"].bodyQuotedSpokespeople, undefined);
});

test("the audit keeps body-scan names for the next run, the public feed does not", () => {
  const item = feedItem({
    matchedTerms: ["Blue Cross VT"],
    snippet: "Blue Cross VT cut rates.",
    bodyQuotedSpokespeople: ["Ruth Greene"],
  });
  const audit = buildJsonSummary([item], [], new Date("2026-03-20T00:00:00Z"), { includeRejected: true });
  const publicFeed = buildJsonSummary([item], [], new Date("2026-03-20T00:00:00Z"));
  assert.deepEqual(audit.items[0].bodyQuotedSpokespeople, ["Ruth Greene"]);
  assert.deepEqual(audit.items[0].quotedSpokespeople, ["Ruth Greene"]);
  assert.equal(publicFeed.items[0].bodyQuotedSpokespeople, undefined);
  assert.deepEqual(publicFeed.items[0].quotedSpokespeople, ["Ruth Greene"]);
});

test("enrichment scans the article body, which is otherwise discarded, and caches the names", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";
  const link = "https://example.com/body-quote";
  const articleCache = {};
  const story = () => [{
    sourceName: "Always Scan Outlet",
    title: "Insurer plan",
    link,
    pubDate: new Date("2026-06-16T12:00:00Z"),
    feedContent: "Blue Cross files a plan.",
    articleScanMode: "always",
  }];
  const options = {
    articleCache,
    now: new Date("2026-06-16T16:30:00Z"),
    fetchText: async (url) => ({
      text: "<article><h1>Insurer plan</h1><p>Blue Cross and Blue Shield of Vermont filed a plan.</p><p>“We expect savings,” said Ruth Greene, the insurer’s chief financial officer, on Monday.</p></article>",
      url,
      notModified: false,
      etag: "",
      lastModified: "",
    }),
    throttleRequest: async () => {},
  };
  try {
    const filtered = await enrichAndFilterItems(story(), new Map(), options);
    assert.deepEqual(filtered[0].bodyQuotedSpokespeople, ["Ruth Greene"]);
    assert.deepEqual(articleCache[link].bodyQuotedSpokespeople, ["Ruth Greene"]);
    assert.deepEqual(quotedSpokespeopleForItem(filtered[0]), ["Ruth Greene"]);

    // The next run reads the cache and does not fetch the page again.
    const again = await enrichAndFilterItems(story(), new Map(), {
      ...options,
      fetchText: async () => assert.fail("cached article refetched"),
    });
    assert.deepEqual(again[0].bodyQuotedSpokespeople, ["Ruth Greene"]);
  } finally {
    if (originalScan === undefined) delete process.env.RSS_ARTICLE_SCAN;
    else process.env.RSS_ARTICLE_SCAN = originalScan;
  }
});

test("body-scan names survive the audit round trip", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "vt-news-quotes-"));
  const auditPath = path.join(workdir, "feed-audit.json");
  const item = feedItem({
    matchedTerms: ["Blue Cross VT"],
    snippet: "Blue Cross VT cut rates.",
    bodyQuotedSpokespeople: ["Ruth Greene"],
  });
  const audit = buildJsonSummary([item], [], new Date("2026-03-20T00:00:00Z"), { includeRejected: true });
  await writeFile(auditPath, JSON.stringify(audit));
  const state = await loadPreviousState(auditPath);
  assert.deepEqual(state.archivedItems[0].bodyQuotedSpokespeople, ["Ruth Greene"]);
  assert.deepEqual(state.cache.get(item.link).bodyQuotedSpokespeople, ["Ruth Greene"]);
});
