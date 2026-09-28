import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildDigest, buildDigestPage, SECTION_MORE } from "../src/digest.js";
import { writeDigestOutputs } from "../src/digest-output.js";
import { generateFeed } from "../src/index.js";
import { SECTION_BRAND, SECTION_NATIONAL, SECTION_VERMONT } from "../src/relevance.js";

const hour = 60 * 60 * 1000;
// Monday, Sept. 28, 2026, 10:00 in Vermont.
const now = new Date("2026-09-28T14:00:00Z");
const ago = (hours) => new Date(now.valueOf() - hours * hour);

let counter = 0;
function item(title, section, hoursAgo, extra = {}) {
  counter += 1;
  return {
    title,
    link: `https://news.example.test/story-${counter}`,
    sourceName: `Outlet ${counter}`,
    pubDate: ago(hoursAgo),
    firstSeenAt: ago(hoursAgo),
    section,
    matchedTerms: ["Vermont health"],
    summary: `Summary of ${title}.`,
    relevant: true,
    ...extra,
  };
}

// Titles that share no terms, so the story grouper leaves them alone.
const word = (index) => `w${index.toString(26).replace(/[0-9]/g, (digit) => "qxzjkvwyfg"[digit])}`;
const distinctTitle = (index) => `${word(index)} ${word(index + 1000)} ${word(index + 2000)} hospital`;

const titles = (digest) => digest.sections.flatMap((section) => section.entries.map((entry) => entry.title));

test("sections follow the team's order and empty ones are left out", () => {
  const digest = buildDigest(
    [
      item("Association news", SECTION_NATIONAL, 1, { link: "https://www.bcbs.com/about-us/association-news/story" }),
      item("National story", SECTION_NATIONAL, 2),
      item("Vermont story", SECTION_VERMONT, 3),
      item("Brand story", SECTION_BRAND, 4),
    ],
    { now },
  );
  assert.deepEqual(
    digest.sections.map((section) => section.name),
    [SECTION_BRAND, SECTION_VERMONT, SECTION_NATIONAL, SECTION_MORE],
  );
  assert.equal(digest.itemCount, 4);

  const partial = buildDigest([item("Only national", SECTION_NATIONAL, 1)], { now });
  assert.deepEqual(partial.sections.map((section) => section.name), [SECTION_NATIONAL]);
  // The HTML and text list the headings in the same order.
  const both = buildDigest([item("N", SECTION_NATIONAL, 1), item("B", SECTION_BRAND, 1)], { now });
  for (const output of [both.html, both.text]) {
    assert.ok(output.toLowerCase().indexOf("blue cross vt news") < output.toLowerCase().indexOf("national healthcare news"));
  }
});

test("association items go under More News and newest entries lead each section", () => {
  const digest = buildDigest(
    [
      item("Older Vermont", SECTION_VERMONT, 6),
      item("Newer Vermont", SECTION_VERMONT, 2),
      item("Blues news", SECTION_NATIONAL, 1, { link: "https://www.bcbs.com/about-us/association-news/blues" }),
    ],
    { now },
  );
  const more = digest.sections.find((section) => section.name === SECTION_MORE);
  assert.deepEqual(more.entries.map((entry) => entry.title), ["Blues news"]);
  assert.equal(digest.sections.some((section) => section.name === SECTION_NATIONAL), false);
  const vermont = digest.sections.find((section) => section.name === SECTION_VERMONT);
  assert.deepEqual(vermont.entries.map((entry) => entry.title), ["Newer Vermont", "Older Vermont"]);
});

test("pipeline items without a section are placed by the reader's own rules", () => {
  const digest = buildDigest(
    [
      item("Tracked brand clip", undefined, 2, { fromMediaTracker: true, matchedTerms: [] }),
      item("Tracked Vermont clip", undefined, 2, { fromMediaTracker: true, trackerSection: "vermont", matchedTerms: [] }),
    ],
    { now },
  );
  assert.deepEqual(
    digest.sections.map((section) => [section.name, section.entries[0].title]),
    [
      [SECTION_BRAND, "Tracked brand clip"],
      [SECTION_VERMONT, "Tracked Vermont clip"],
    ],
  );
});

test("the window counts publication or first sight, and ignores the future", () => {
  const digest = buildDigest(
    [
      item("Published 23h ago", SECTION_VERMONT, 23),
      item("Published 25h ago", SECTION_VERMONT, 25),
      item("Old but first seen 1h ago", SECTION_VERMONT, 200, { firstSeenAt: ago(1) }),
      item("Published in the future", SECTION_VERMONT, -3, { firstSeenAt: ago(90) }),
      item("No dates worth counting", SECTION_VERMONT, 500, { firstSeenAt: undefined }),
    ],
    { now },
  );
  assert.deepEqual(titles(digest).sort(), ["Old but first seen 1h ago", "Published 23h ago"]);

  const wide = buildDigest(
    [item("Published 25h ago", SECTION_VERMONT, 25), item("Published 60h ago", SECTION_VERMONT, 60)],
    { now, windowHours: 48 },
  );
  assert.deepEqual(titles(wide), ["Published 25h ago"]);
});

test("rejected items, BlueCrossVT.org posts, and social items are excluded", () => {
  const digest = buildDigest(
    [
      item("Kept", SECTION_BRAND, 1),
      item("Rejected", SECTION_BRAND, 1, { relevant: false }),
      item("Own post", SECTION_BRAND, 1, { link: "https://www.bluecrossvt.org/about-us/news/story" }),
      item("Facebook link", SECTION_BRAND, 1, { link: "https://www.facebook.com/wcax/posts/1" }),
      item("Social source", SECTION_BRAND, 1, { sourceName: "Facebook WCAX" }),
      item("Not yet judged", SECTION_BRAND, 1, { relevant: undefined }),
    ],
    { now },
  );
  assert.deepEqual(titles(digest).sort(), ["Kept", "Not yet judged"]);
});

test("each entry shows the linked headline, outlet, and summary; brand entries add sentiment", () => {
  const digest = buildDigest(
    [
      item("Brand coverage", SECTION_BRAND, 1, {
        link: "https://vtdigger.org/2026/09/28/brand/",
        sentiment: "neutral to positive",
        sentimentScore: 62.4,
      }),
      item("Vermont coverage", SECTION_VERMONT, 1, { sentiment: "positive", sentimentScore: 90 }),
      item("Sentiment not scored", SECTION_BRAND, 2, { summary: "" }),
    ],
    { now },
  );
  const brand = digest.sections[0].entries.find((entry) => entry.title === "Brand coverage");
  assert.equal(brand.outlet, "VTDigger");
  assert.equal(brand.sentiment, "neutral to positive");
  assert.equal(brand.sentimentScore, 62.4);
  assert.match(digest.html, /<a href="https:\/\/vtdigger\.org\/2026\/09\/28\/brand\/"[^>]*>Brand coverage<\/a>/);
  assert.match(digest.html, /VTDigger &middot; Sentiment: 62 · neutral to positive/);
  assert.match(digest.html, /Summary of Brand coverage\./);
  // Only brand entries carry sentiment.
  const vermont = digest.sections[1].entries[0];
  assert.equal(vermont.sentiment, undefined);
  assert.equal(digest.html.includes("Sentiment: 90"), false);
  const unscored = digest.sections[0].entries.find((entry) => entry.title === "Sentiment not scored");
  assert.equal("sentiment" in unscored, false);
  assert.equal(unscored.summary, "");
});

test("a story covered by several outlets is one entry led by the newest report", () => {
  const hoursBase = (n) => new Date(now.valueOf() - n * hour);
  const story = (title, sourceName, hoursAgo, summary) => ({
    title,
    sourceName,
    link: `https://${sourceName.toLowerCase().replace(/[^a-z]+/g, "")}.example.test/aca`,
    pubDate: hoursBase(hoursAgo),
    firstSeenAt: hoursBase(hoursAgo),
    matchedTerms: ["ACA & marketplace"],
    summary,
    relevant: true,
  });
  const aca = [
    story("Trump administration to remove 760,000 Affordable Care Act enrollees over fraud claims", "Fierce Healthcare", 24,
      "The administration will remove 760,000 Affordable Care Act enrollees over alleged fraud."),
    story("Trump administration to remove 760,000 Affordable Care Act enrollees over fraud claims - Caledonian Record", "Caledonian-Record", 21,
      "The administration will remove 760,000 Affordable Care Act enrollees over alleged fraud."),
    story("Trump administration to remove 760,000 Affordable Care Act enrollees over fraud claims", "Rutland Herald", 20,
      "The administration will remove 760,000 Affordable Care Act enrollees over alleged fraud."),
  ];
  // The newest report is a rewording of the same event.
  aca.push(story("Trump administration removes 760,000 Affordable Care Act enrollees over fraud claims", "NPR Health", 4,
    "The Trump administration is removing 760,000 Affordable Care Act enrollees over alleged fraud."));
  // Term weights come from the whole feed, so the fixture needs a realistic
  // background of distinct stories, as story-groups.test.js does.
  const subjects = ["hospital", "clinic", "nurses", "vaccine", "budget", "Medicaid", "pharmacy", "rural", "school", "dental"];
  const actions = ["expands", "cuts", "reviews", "delays", "funds", "studies", "opens", "closes", "hires", "audits"];
  const background = Array.from({length: 100}, (_, index) => ({
    title: `${subjects[index % 10]} ${actions[Math.floor(index / 10)]} program ${index}`,
    sourceName: `Outlet ${index}`,
    link: `https://background.example.test/${index}`,
    pubDate: hoursBase(24 - ((index % 60) - 30)),
    firstSeenAt: hoursBase(24 - ((index % 60) - 30)),
    matchedTerms: ["ACA & marketplace"],
    summary: `A ${subjects[index % 10]} in county ${index} ${actions[Math.floor(index / 10)]} a local program.`,
    relevant: true,
  }));

  const digest = buildDigest([...aca, ...background], { now, windowHours: 48 });
  const entries = digest.sections.flatMap((section) => section.entries);
  const lead = entries.filter((entry) => /760/.test(entry.title));
  assert.equal(lead.length, 1);
  assert.equal(lead[0].title, "Trump administration removes 760,000 Affordable Care Act enrollees over fraud claims");
  assert.equal(lead[0].outlet, "NPR Health");
  assert.deepEqual(lead[0].alsoCoveredBy.map((other) => other.outlet).sort(), ["Caledonian-Record", "Fierce Healthcare", "Rutland Herald"]);
  assert.match(digest.html, /Also covered by:<\/strong> <a href="https:\/\/[^"]+"[^>]*>[^<]+<\/a>, /);
  assert.match(digest.text, /Also covered by: [^\n]*Rutland Herald/);
});

test("a published feed keeps its own storyGroupId grouping", () => {
  const digest = buildDigest(
    [
      item("Older report", SECTION_VERMONT, 5, { storyGroupId: "g1", sourceName: "Alpha" }),
      item("Newest report", SECTION_VERMONT, 1, { storyGroupId: "g1", sourceName: "Beta" }),
      item("Separate", SECTION_VERMONT, 2),
    ],
    { now },
  );
  assert.equal(digest.itemCount, 2);
  const grouped = digest.sections[0].entries.find((entry) => entry.title === "Newest report");
  assert.deepEqual(grouped.alsoCoveredBy.map((other) => other.outlet), ["Alpha"]);
});

test("a story group never joins an association page to a national entry", () => {
  const digest = buildDigest(
    [
      item("Same event", SECTION_NATIONAL, 5, { storyGroupId: "g1", sourceName: "Alpha" }),
      item("Same event again", SECTION_NATIONAL, 1, {
        storyGroupId: "g1",
        link: "https://www.bcbs.com/about-us/association-news/event",
      }),
    ],
    { now },
  );
  assert.equal(digest.itemCount, 2);
  assert.deepEqual(digest.sections.map((section) => section.name), [SECTION_NATIONAL, SECTION_MORE]);
});

test("the subject reads like the team's, with a singular form", () => {
  const many = buildDigest(Array.from({ length: 14 }, (_, index) => item(distinctTitle(index), SECTION_VERMONT, 1)), { now });
  assert.equal(many.subject, "Cerulean News clips - Mon, Sep 28, 2026 (14 stories)");
  const one = buildDigest([item("Story", SECTION_VERMONT, 1)], { now });
  assert.equal(one.subject, "Cerulean News clips - Mon, Sep 28, 2026 (1 story)");
  // Late evening in Vermont is already the next day in UTC.
  const late = buildDigest([], { now: new Date("2026-09-29T02:30:00Z") });
  assert.equal(late.subject, "Cerulean News clips - Mon, Sep 28, 2026 (0 stories)");
  assert.match(late.html, /No new stories in the last 24 hours\./);
  assert.match(late.text, /No new stories in the last 24 hours\./);
});

test("the HTML is email-safe", () => {
  const hostile = item("<script>alert(1)</script> & \"quotes\" it's", SECTION_BRAND, 1, {
    summary: "<img src=x onerror=alert(1)> summary",
    link: "javascript:alert(1)",
    sourceName: "<b>Outlet</b>",
  });
  const digest = buildDigest(
    [hostile, item("Vermont", SECTION_VERMONT, 1), item("National", SECTION_NATIONAL, 1), item("Blues", SECTION_NATIONAL, 1, { link: "https://www.bcbs.com/x" })],
    { now },
  );
  const { html } = digest;
  assert.ok(!/<script/i.test(html), "no script tag");
  assert.ok(!/<link/i.test(html), "no link tag");
  assert.ok(!/<style/i.test(html), "no style block");
  assert.ok(!/\bclass=/i.test(html), "no class attributes");
  assert.ok(!/@import|@font-face|url\(/i.test(html), "no external CSS or fonts");
  assert.ok(!/<img|<iframe|<[^>]*\son[a-z]+=/i.test(html), "no images, frames, or handlers");
  assert.ok(!/javascript:/i.test(html), "no script URLs");
  assert.ok(!html.includes("&apos;"), "Outlook prints &apos; literally");
  assert.match(html, /<table role="presentation" width="600"/);
  assert.match(html, /^<!doctype html>/i);
  assert.ok(new TextEncoder().encode(html).length < 100 * 1000);
  // Every tag that carries styling does so inline.
  assert.ok((html.match(/style="/g) || []).length > 10);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot; it&#39;s"));
  assert.match(html, /not affiliated with Blue Cross and Blue Shield of Vermont/);
});

test("a very busy day stays under 100 KB and says what was left out", () => {
  const long = "A long sentence about coverage and premiums. ".repeat(12);
  const items = Array.from({ length: 400 }, (_, index) =>
    item(`${distinctTitle(index)} with a fairly long headline to add weight`, index % 2 ? SECTION_NATIONAL : SECTION_VERMONT, 1 + (index % 20), { summary: long }),
  );
  const digest = buildDigest(items, { now });
  assert.ok(new TextEncoder().encode(digest.html).length <= 100 * 1000);
  assert.ok(digest.itemCount < 400);
  assert.ok(digest.itemCount > 40);
  assert.match(digest.html, /more stories are not shown/);
  assert.match(digest.html, /not affiliated with Blue Cross and Blue Shield of Vermont/);
  assert.match(digest.subject, new RegExp(`\\(${digest.itemCount} stories\\)`));
});

test("the plain-text version lists the same stories", () => {
  const digest = buildDigest(
    [
      item("Brand coverage", SECTION_BRAND, 1, {
        link: "https://vtdigger.org/2026/09/28/brand/",
        sentiment: "positive",
        sentimentScore: 81,
      }),
      item("Vermont coverage", SECTION_VERMONT, 1),
    ],
    { now },
  );
  const { text } = digest;
  assert.ok(text.startsWith("CERULEAN NEWS CLIPS\nMon, Sep 28, 2026 - 2 stories\n"));
  assert.ok(text.includes("BLUE CROSS VT NEWS\n------------------\n* Brand coverage\n  VTDigger | Sentiment: 81 · positive\n  Summary of Brand coverage.\n  https://vtdigger.org/2026/09/28/brand/\n"));
  assert.ok(text.indexOf("BLUE CROSS VT NEWS") < text.indexOf("VERMONT HEALTHCARE NEWS"));
  assert.ok(!/<[a-z]+[^>]*>/i.test(text), "no markup");
  assert.ok(text.trimEnd().endsWith("not affiliated with Blue Cross and Blue Shield of Vermont. Summaries are AI-generated."));
});

test("buildDigest does not modify its input", () => {
  const items = [item("A", SECTION_VERMONT, 1), item("B", SECTION_VERMONT, 2)];
  const before = JSON.stringify(items);
  buildDigest(items, { now });
  assert.equal(JSON.stringify(items), before);
});

test("the standalone page wraps the email and round-trips its HTML", () => {
  const digest = buildDigest([item("Vermont <story>", SECTION_VERMONT, 1)], { now });
  const page = buildDigestPage(digest, { generatedAt: now.toISOString() });
  assert.match(page, /<button type="button" id="copy-email">Copy email<\/button>/);
  assert.match(page, /<meta name="robots" content="noindex">/);
  assert.match(page, /Not affiliated\./);
  // The copy handler plus the shared password gate (early check and gate.js).
  assert.equal((page.match(/<script/g) || []).length, 3, "copy handler and gate only");
  assert.match(page, /<script src="gate\.js"><\/script>/);
  assert.match(page, /<link rel="stylesheet" href="gate\.css">/);
  const srcdoc = /srcdoc="([^"]*)"/.exec(page)[1]
    .replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&apos;", "'").replaceAll("&amp;", "&");
  assert.equal(srcdoc, digest.html);
});

test("writeDigestOutputs puts digest.html and digest.json beside the RSS output", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "vt-news-digest-"));
  const rssOutputPath = path.join(workdir, "out", "feed.rss");
  const digest = await writeDigestOutputs([item("Vermont story", SECTION_VERMONT, 1)], { now, rssOutputPath });
  assert.equal(digest.itemCount, 1);
  const json = JSON.parse(await readFile(path.join(workdir, "out", "digest.json"), "utf8"));
  assert.deepEqual(Object.keys(json), ["generatedAt", "subject", "text", "html", "sections"]);
  assert.equal(json.generatedAt, now.toISOString());
  assert.equal(json.subject, digest.subject);
  assert.equal(json.sections[0].entries[0].title, "Vermont story");
  const page = await readFile(path.join(workdir, "out", "digest.html"), "utf8");
  assert.match(page, /Copy email/);
});

test("a digest failure is logged and never thrown into the pipeline", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "vt-news-digest-fail-"));
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    // A non-array of items makes the builder throw.
    const result = await writeDigestOutputs({ filter: null }, { now, rssOutputPath: path.join(workdir, "feed.rss") });
    assert.equal(result, null);
    assert.equal(logged.length, 1);
  } finally {
    console.error = original;
  }
});

test("generateFeed writes the digest next to the RSS output", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "vt-news-digest-pipeline-"));
  const rssOutputPath = path.join(workdir, "rss", "feed.rss");
  await generateFeed({
    sources: [],
    now: new Date("2026-09-28T14:00:00Z"),
    rssOutputPath,
    jsonOutputPath: path.join(workdir, "json", "feed.json"),
    auditJsonOutputPath: path.join(workdir, "audit", "feed-audit.json"),
  });
  const json = JSON.parse(await readFile(path.join(workdir, "rss", "digest.json"), "utf8"));
  assert.equal(json.subject, "Cerulean News clips - Mon, Sep 28, 2026 (0 stories)");
  await readFile(path.join(workdir, "rss", "digest.html"), "utf8");
});

test("the reader's footer notes link to the digest", async () => {
  const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  const notes = /<dl class="site-notes">([\s\S]*?)<\/dl>/.exec(html);
  assert.ok(notes, "footer notes present");
  assert.match(notes[1], /href="digest"/);
});
