import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as cheerio from "cheerio";
import { generateFeed } from "../src/index.js";
import {
  BRAND_THEME_LABELS,
  buildMonthlyReport,
  buildMonthlyReportPages,
  easternMonthKey,
  monthsBetween,
  renderMonthlyReportEmail,
  renderMonthlyReportPage,
  renderReportsIndex,
  safeHref,
  writeMonthlyReports,
} from "../src/monthly-report.js";

const NOW = new Date("2026-09-28T16:00:00Z");
let counter = 0;

// A feed item as buildJsonSummary publishes it: ISO date strings, and brand
// coverage flagged sentimentEligible.
function item(pubDate, extra = {}) {
  counter += 1;
  return {
    id: `https://news.test/story-${counter}`,
    url: `https://news.test/story-${counter}`,
    title: `Story ${counter}`,
    outlet: "VTDigger",
    pubDate,
    sentimentEligible: true,
    sentiment: "neutral",
    matchedTerms: ["BCBSVT"],
    section: "Blue Cross VT News",
    ...extra,
  };
}

function vermont(pubDate, extra = {}) {
  return item(pubDate, {
    sentimentEligible: undefined,
    sentiment: undefined,
    section: "Vermont Healthcare News",
    ...extra,
  });
}

// ---- the coverage set and net sentiment, as site/trends.html defines them ----

test("volume counts the coverage set, including unscored items, and skips the rest", () => {
  const items = [
    item("2026-09-05T15:00:00Z", { sentiment: "positive" }),
    item("2026-09-06T15:00:00Z", { sentiment: undefined }), // eligible, not yet scored
    item("2026-09-07T15:00:00Z", { sentimentEligible: undefined, sentiment: undefined }), // not brand press
    item(undefined, { sentiment: "positive" }), // no date
    item("not a date", { sentiment: "positive" }),
    item("2026-08-05T15:00:00Z", { sentiment: "positive" }), // other month
  ];
  const { brand } = buildMonthlyReport(items, { month: "2026-09", now: NOW });
  assert.equal(brand.volume, 2);
  assert.equal(brand.scored, 1);
  assert.equal(brand.awaitingScore, 1);
});

test("an older feed without sentimentEligible falls back to has-a-score, as trends does", () => {
  const items = [item("2026-09-05T15:00:00Z", { sentimentEligible: undefined, sentiment: "negative" })];
  assert.equal(buildMonthlyReport(items, { month: "2026-09", now: NOW }).brand.volume, 1);
});

test("net sentiment is the mean of the five labels mapped to +2 through -2", () => {
  const labels = [
    "positive",
    "positive",
    "neutral to positive",
    "neutral",
    "neutral to negative",
    "negative",
  ];
  const items = labels.map((sentiment) => item("2026-09-10T15:00:00Z", { sentiment }));
  const { brand } = buildMonthlyReport(items, { month: "2026-09", now: NOW });
  // (2 + 2 + 1 + 0 - 1 - 2) / 6
  assert.ok(Math.abs(brand.net - 2 / 6) < 1e-9);
  assert.equal(brand.scored, 6);
  assert.equal(brand.favorable, 3);
  assert.equal(brand.adverse, 2);
  assert.deepEqual(
    brand.mix.map((step) => [step.key, step.count]),
    [
      ["positive", 2],
      ["neutral to positive", 1],
      ["neutral", 1],
      ["neutral to negative", 1],
      ["negative", 1],
    ],
  );
  assert.ok(Math.abs(brand.mix[0].share - 2 / 6) < 1e-9);
});

test("net sentiment ignores unscored items and is null with none scored", () => {
  const scoredOnly = [
    item("2026-09-10T15:00:00Z", { sentiment: "positive" }),
    item("2026-09-11T15:00:00Z", { sentiment: undefined }),
  ];
  assert.equal(buildMonthlyReport(scoredOnly, { month: "2026-09", now: NOW }).brand.net, 2);
  const none = [item("2026-09-10T15:00:00Z", { sentiment: undefined })];
  const report = buildMonthlyReport(none, { month: "2026-09", now: NOW });
  assert.equal(report.brand.net, null);
  assert.match(report.summary, /None of these has been scored/);
});

test("the mean sentimentScore covers only items that carry one, and says how many", () => {
  const items = [
    item("2026-09-10T15:00:00Z", { sentiment: "positive", sentimentScore: 90 }),
    item("2026-09-11T15:00:00Z", { sentiment: "neutral", sentimentScore: 0 }), // zero is a score
    item("2026-09-12T15:00:00Z", { sentiment: "neutral" }),
    item("2026-09-13T15:00:00Z", { sentiment: "negative" }),
  ];
  const { brand } = buildMonthlyReport(items, { month: "2026-09", now: NOW });
  assert.deepEqual(brand.meanScore, { mean: 45, count: 2, of: 4 });
  const html = renderMonthlyReportPage(buildMonthlyReport(items, { month: "2026-09", now: NOW }));
  assert.match(html, /from 2 of 4 scored stories/);

  const bare = buildMonthlyReport([item("2026-09-10T15:00:00Z")], { month: "2026-09", now: NOW });
  assert.equal(bare.brand.meanScore.mean, null);
  assert.equal(bare.brand.meanScore.count, 0);
});

// ---- outlets, stories, themes, Vermont ----

test("top outlets are the five with the most brand coverage, ties broken by name", () => {
  const counts = { Alpha: 3, Bravo: 3, Charlie: 2, Delta: 2, Echo: 1, Foxtrot: 1, Golf: 1 };
  const items = Object.entries(counts).flatMap(([outlet, n]) =>
    Array.from({ length: n }, () => item("2026-09-10T15:00:00Z", { outlet })),
  );
  // An outlet-less item falls back to sourceName, like the trends page.
  items.push(item("2026-09-10T15:00:00Z", { outlet: undefined, sourceName: "Alpha" }));
  const { outlets } = buildMonthlyReport(items, { month: "2026-09", now: NOW });
  assert.deepEqual(
    outlets.map((row) => [row.outlet, row.count]),
    [["Alpha", 4], ["Bravo", 3], ["Charlie", 2], ["Delta", 2], ["Echo", 1]],
  );
  assert.ok(Math.abs(outlets[0].share - 4 / 14) < 1e-9);
});

test("favorable and least favorable stories rank by label, then score, one per story group", () => {
  const items = [
    item("2026-09-02T15:00:00Z", { title: "Praise A - VTDigger", sentiment: "positive", sentimentScore: 91 }),
    item("2026-09-03T15:00:00Z", { title: "Praise B", sentiment: "positive", sentimentScore: 97 }),
    // Same event as Praise B, reported by another outlet: listed once.
    item("2026-09-03T18:00:00Z", { title: "Praise B again", outlet: "WCAX", sentiment: "positive", sentimentScore: 95, storyGroupId: "g1" }),
    item("2026-09-03T15:30:00Z", { title: "Praise B", sentiment: "positive", sentimentScore: 97, storyGroupId: "g1" }),
    item("2026-09-04T15:00:00Z", { title: "Lean positive", sentiment: "neutral to positive", sentimentScore: 99 }),
    item("2026-09-05T15:00:00Z", { title: "Praise C", sentiment: "positive" }), // no score: label anchor 100
    item("2026-09-06T15:00:00Z", { title: "Praise D", sentiment: "positive", sentimentScore: 60 }),
    item("2026-09-07T15:00:00Z", { title: "Just neutral", sentiment: "neutral" }),
    item("2026-09-08T15:00:00Z", { title: "Bad A", sentiment: "negative", sentimentScore: 5 }),
    item("2026-09-09T15:00:00Z", { title: "Bad B", sentiment: "negative", sentimentScore: 12 }),
    item("2026-09-10T15:00:00Z", { title: "Bad B", sentiment: "negative", sentimentScore: 12, outlet: "WCAX" }), // same notice, other outlet
    item("2026-09-11T15:00:00Z", { title: "Lean negative", sentiment: "neutral to negative", sentimentScore: 1 }),
    item("2026-09-12T15:00:00Z", { title: "Bad C", sentiment: "negative" }),
  ];
  const report = buildMonthlyReport(items, { month: "2026-09", now: NOW });
  assert.deepEqual(
    report.favorable.map((story) => story.title),
    ["Praise C", "Praise B", "Praise A"],
  );
  assert.equal(report.favorable[0].sentimentScore, null);
  assert.equal(report.favorable[1].sentimentScore, 97);
  assert.equal(report.favorable[2].outlet, "VTDigger");
  assert.deepEqual(
    report.unfavorable.map((story) => story.title),
    ["Bad C", "Bad A", "Bad B"],
  );
  assert.equal(report.favorable.length, 3);
});

test("a story never lands on the wrong side of neutral, so the two lists cannot overlap", () => {
  const items = [
    item("2026-09-02T15:00:00Z", { title: "Only positive", sentiment: "positive" }),
    item("2026-09-03T15:00:00Z", { title: "Only neutral", sentiment: "neutral" }),
  ];
  const report = buildMonthlyReport(items, { month: "2026-09", now: NOW });
  assert.deepEqual(report.favorable.map((s) => s.title), ["Only positive"]);
  assert.deepEqual(report.unfavorable, []);
  assert.match(renderMonthlyReportPage(report), /No adverse stories this month/);
});

test("themes rank matched terms, skip brand labels, and count a story once per term", () => {
  const items = [
    item("2026-09-02T15:00:00Z", { matchedTerms: ["BCBSVT", "Medicaid", "Hospitals", "Medicaid"] }),
    item("2026-09-03T15:00:00Z", { matchedTerms: ["Blue Cross VT", "Medicaid", "Premiums & rate review"] }),
    item("2026-09-04T15:00:00Z", { matchedTerms: ["Vermont's largest health insurer", "Hospitals"] }),
    item("2026-09-05T15:00:00Z", { matchedTerms: ["Telehealth"] }),
    item("2026-09-06T15:00:00Z", { matchedTerms: ["Primary care"] }),
    item("2026-09-07T15:00:00Z", { matchedTerms: ["Dental care"] }),
    item("2026-09-08T15:00:00Z", { matchedTerms: ["Vaccines"] }),
  ];
  const { themes } = buildMonthlyReport(items, { month: "2026-09", now: NOW });
  assert.equal(themes.length, 5);
  assert.deepEqual(themes.slice(0, 2), [
    { term: "Hospitals", count: 2 },
    { term: "Medicaid", count: 2 },
  ]);
  assert.ok(!themes.some((theme) => BRAND_THEME_LABELS.has(theme.term)));
  // The rest tie at one, so the alphabet decides.
  assert.deepEqual(themes.slice(2).map((t) => t.term), ["Dental care", "Premiums & rate review", "Primary care"]);
});

test("the brand-label list matches the one on the trends page", async () => {
  const html = await readFile(new URL("../site/trends.html", import.meta.url), "utf8");
  const block = html.match(/const BRAND_LABELS = new Set\(\[([^\]]*)\]\)/)?.[1];
  assert.ok(block, "BRAND_LABELS not found in trends.html");
  const onPage = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
  assert.deepEqual([...BRAND_THEME_LABELS].sort(), onPage.sort());
});

test("Vermont health care volume counts the Vermont section only, with the prior month", () => {
  const items = [
    vermont("2026-09-02T15:00:00Z"),
    vermont("2026-09-03T15:00:00Z", { storyGroupId: "g9" }),
    vermont("2026-09-03T16:00:00Z", { storyGroupId: "g9" }),
    vermont("2026-09-04T15:00:00Z", { relevant: false }), // rejected in the audit
    vermont("2026-09-05T15:00:00Z", { section: "National Healthcare News" }),
    item("2026-09-06T15:00:00Z"), // brand section, not Vermont
    vermont("2026-08-20T15:00:00Z"),
    vermont("2026-08-21T15:00:00Z"),
    vermont("2026-08-22T15:00:00Z"),
    vermont(undefined),
  ];
  const { vermont: v } = buildMonthlyReport(items, { month: "2026-09", now: NOW });
  assert.equal(v.volume, 3);
  assert.equal(v.distinctStories, 2);
  assert.equal(v.priorVolume, 3);
  assert.equal(v.change, 0);
  assert.equal(v.changePct, 0);
});

// ---- month boundaries in America/New_York -----------------------------------

test("months break at midnight Eastern, in summer and in winter", () => {
  // June 30, 23:59:59 EDT is still June. July 1, 00:00:00 EDT is July.
  assert.equal(easternMonthKey(new Date("2026-07-01T03:59:59Z")), "2026-06");
  assert.equal(easternMonthKey(new Date("2026-07-01T04:00:00Z")), "2026-07");
  // Dec 31, 23:59:59 EST is still December. Jan 1, 00:00:00 EST is January.
  assert.equal(easternMonthKey(new Date("2026-01-01T04:59:59Z")), "2025-12");
  assert.equal(easternMonthKey(new Date("2026-01-01T05:00:00Z")), "2026-01");

  const items = [
    item("2026-07-01T03:59:59Z", { sentiment: "positive" }), // June 30 evening in Vermont
    item("2026-07-01T04:00:00Z", { sentiment: "negative" }), // July 1 midnight in Vermont
    item("2026-06-01T03:59:59Z", { sentiment: "positive" }), // May 31 evening
    item("2026-06-01T04:00:00Z", { sentiment: "positive" }), // June 1 midnight
    vermont("2026-07-01T03:59:59Z"),
    vermont("2026-07-01T04:00:00Z"),
  ];
  const june = buildMonthlyReport(items, { month: "2026-06", now: NOW });
  const july = buildMonthlyReport(items, { month: "2026-07", now: NOW });
  const may = buildMonthlyReport(items, { month: "2026-05", now: NOW });
  assert.equal(june.brand.volume, 2);
  assert.equal(july.brand.volume, 1);
  assert.equal(july.brand.net, -2);
  assert.equal(may.brand.volume, 1);
  assert.equal(june.vermont.volume, 1);
  assert.equal(july.vermont.volume, 1);
});

test("story dates are shown on the Eastern calendar", () => {
  const items = [item("2026-07-01T03:30:00Z", { sentiment: "positive", title: "Late night" })];
  const june = buildMonthlyReport(items, { month: "2026-06", now: NOW });
  assert.equal(june.favorable[0].date, "2026-06-30");
});

// ---- the prior month ---------------------------------------------------------

test("the prior-month delta is a count and a percent, and handles an empty prior month", () => {
  const items = [
    ...Array.from({ length: 6 }, () => item("2026-08-10T15:00:00Z", { sentiment: "neutral" })),
    ...Array.from({ length: 9 }, () => item("2026-09-10T15:00:00Z", { sentiment: "positive" })),
  ];
  const sept = buildMonthlyReport(items, { month: "2026-09", now: new Date("2026-10-05T12:00:00Z") });
  assert.equal(sept.priorMonth, "2026-08");
  assert.equal(sept.brand.priorVolume, 6);
  assert.equal(sept.brand.change, 3);
  assert.equal(sept.brand.changePct, 50);
  assert.equal(sept.brand.priorNet, 0);
  assert.equal(sept.brand.netChange, 2);
  assert.match(sept.summary, /up 3 \(50%\) from 6 in August/);

  const aug = buildMonthlyReport(items, { month: "2026-08", now: new Date("2026-10-05T12:00:00Z") });
  assert.equal(aug.brand.priorVolume, 0);
  assert.equal(aug.brand.changePct, null);
  assert.equal(aug.brand.priorNet, null);
  assert.match(aug.summary, /up 6 from 0 in July/);
});

test("the prior month of January is the previous December", () => {
  const items = [
    item("2025-12-20T15:00:00Z"),
    item("2025-12-21T15:00:00Z"),
    item("2026-01-20T15:00:00Z"),
  ];
  const jan = buildMonthlyReport(items, { month: "2026-01", now: NOW });
  assert.equal(jan.priorMonth, "2025-12");
  assert.equal(jan.brand.priorVolume, 2);
  assert.equal(jan.brand.change, -1);
  assert.match(jan.summary, /down 1 \(50%\) from 2 in December/);
});

test("the current month is marked to date and compared with the whole prior month", () => {
  const items = [item("2026-08-10T15:00:00Z"), item("2026-09-10T15:00:00Z")];
  const current = buildMonthlyReport(items, { month: "2026-09", now: NOW });
  assert.equal(current.toDate, true);
  assert.equal(current.asOf, "2026-09-28");
  assert.match(current.summary, /September 2026 so far, through September 28/);
  assert.match(current.summary, /against 1 in all of August/);

  const done = buildMonthlyReport(items, { month: "2026-08", now: NOW });
  assert.equal(done.toDate, false);
  assert.equal(done.asOf, null);

  // 10 pm on Sept 30 in Vermont is already October 1 in UTC. It is still September.
  const lateSept = new Date("2026-10-01T02:00:00Z");
  assert.equal(buildMonthlyReport(items, { month: "2026-09", now: lateSept }).toDate, true);
  assert.equal(buildMonthlyReport(items, { month: "2026-10", now: lateSept }).toDate, false);
});

test("an invalid month is rejected", () => {
  for (const month of [undefined, "2026-9", "2026-13", "September", "2026-00"]) {
    assert.throws(() => buildMonthlyReport([], { month, now: NOW }), TypeError);
  }
});

// ---- the summary paragraph ---------------------------------------------------

test("the summary paragraph states the numbers in plain language", () => {
  const items = [
    item("2026-08-10T15:00:00Z"),
    ...Array.from({ length: 3 }, (_, i) =>
      item("2026-09-10T15:00:00Z", { sentiment: "positive", outlet: "WCAX", matchedTerms: ["BCBSVT", "Medicaid"], sentimentScore: 90 + i }),
    ),
    item("2026-09-11T15:00:00Z", { sentiment: "negative", outlet: "VTDigger", matchedTerms: ["BCBSVT", "Hospitals"] }),
    item("2026-09-12T15:00:00Z", { sentiment: undefined }),
    vermont("2026-09-13T15:00:00Z"),
  ];
  const { summary } = buildMonthlyReport(items, { month: "2026-09", now: new Date("2026-10-08T12:00:00Z") });
  assert.match(summary, /^In September 2026, 5 stories named Blue Cross and Blue Shield of Vermont, up 4 \(400%\) from 1 in August\./);
  // (2 + 2 + 2 - 2) / 4 = +1.00, over 4 scored stories, 1 awaiting.
  assert.match(summary, /Net sentiment was \+1\.00 on a scale from -2 to \+2, leaning favorable/);
  assert.match(summary, /Of 4 scored stories, 3 were favorable and 1 adverse, with 1 still awaiting a score\./);
  assert.match(summary, /WCAX carried the most coverage, with 3 stories\./);
  assert.match(summary, /The most frequent themes were Medicaid and Hospitals\./);
  assert.match(summary, /Vermont health care coverage ran to 1 story, up 1 from 0 in August\.$/);
  // Templated prose keeps to the house style.
  assert.doesNotMatch(summary, /[;—]/);
});

test("an empty month still produces a sensible report", () => {
  const report = buildMonthlyReport([], { month: "2026-07", now: NOW });
  assert.equal(report.brand.volume, 0);
  assert.equal(report.brand.net, null);
  assert.deepEqual(report.outlets, []);
  assert.deepEqual(report.themes, []);
  assert.match(report.summary, /no press coverage naming Blue Cross and Blue Shield of Vermont was recorded/);
  assert.doesNotThrow(() => renderMonthlyReportPage(report));
  assert.doesNotThrow(() => renderMonthlyReportEmail(report));
});

test("building a report never mutates its input and is repeatable", () => {
  const items = [item("2026-09-10T15:00:00Z", { sentiment: "positive" })];
  const before = JSON.stringify(items);
  const a = buildMonthlyReport(items, { month: "2026-09", now: NOW });
  const b = buildMonthlyReport(items, { month: "2026-09", now: NOW });
  assert.equal(JSON.stringify(items), before);
  assert.deepEqual(a, b);
});

// ---- the email ---------------------------------------------------------------

const HOSTILE = [
  item("2026-09-10T15:00:00Z", {
    title: `<script>alert("x")</script><img src=x onerror=alert(1)> & "quotes"`,
    url: "javascript:alert(document.cookie)",
    outlet: `<b onclick="steal()">Evil & Co</b>`,
    sentiment: "positive",
    sentimentScore: 99,
    matchedTerms: ["<script>theme()</script>"],
  }),
  item("2026-09-11T15:00:00Z", {
    title: "Data link story",
    url: "data:text/html,<script>alert(1)</script>",
    sentiment: "negative",
  }),
  item("2026-09-12T15:00:00Z", {
    title: `Quote " break out`,
    url: `https://news.test/a?x="onmouseover="alert(1)`,
    sentiment: "negative",
    sentimentScore: 3,
  }),
];

test("the email has a subject, html, and plain text, and marks the current month to date", () => {
  const report = buildMonthlyReport(
    [item("2026-08-10T15:00:00Z", { sentiment: "neutral" }), item("2026-09-10T15:00:00Z", { sentiment: "positive", sentimentScore: 80 })],
    { month: "2026-09", now: NOW },
  );
  const email = renderMonthlyReportEmail(report);
  assert.equal(email.subject, "Cerulean News monthly report: September 2026 (to date)");
  assert.match(email.text, /Stories naming the brand: 1 \(Against 1 in all of August\)/);
  assert.match(email.text, /Net sentiment \(-2 to \+2\): \+2\.00/);
  assert.match(email.text, /Mean sentiment score 80\.0 on a 0-100 scale \(50 is neutral\), from 1 of 1 scored story/);
  assert.match(email.text, /Full report: https:\/\/cerulean\.news\/reports\/2026-09$/m);
  assert.match(email.html, /^<!doctype html>/);
  assert.match(email.html, /<a href="https:\/\/cerulean\.news\/reports\/2026-09"/);

  const past = renderMonthlyReportEmail(buildMonthlyReport([], { month: "2026-07", now: NOW }));
  assert.equal(past.subject, "Cerulean News monthly report: July 2026");
});

test("the email is email-safe: tables and inline styles, no scripts or active content", () => {
  const report = buildMonthlyReport(HOSTILE, { month: "2026-09", now: NOW });
  const { html, text, subject } = renderMonthlyReportEmail(report);
  const $ = cheerio.load(html);

  assert.equal($("script, style, link, iframe, object, embed, form, input, img, video, svg").length, 0);
  assert.ok($("table").length > 5);
  // Layout is tables with inline styles only.
  assert.equal($("div.page, [class]").length, 0);
  assert.ok($("td[style]").length > 5);
  // No handler attributes, and no unsafe URL schemes anywhere.
  $("*").each((_, node) => {
    for (const name of Object.keys(node.attribs || {})) {
      assert.ok(!name.startsWith("on"), `attribute ${name} on <${node.name}>`);
    }
  });
  assert.doesNotMatch(html, /javascript:|data:text/i);
  $("a[href]").each((_, node) => {
    assert.match($(node).attr("href"), /^https?:\/\//);
  });
  // The hostile markup arrives as inert text.
  assert.ok($("body").text().includes('<script>alert("x")</script>'));
  assert.ok($("body").text().includes("Evil & Co"));
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  // The attribute-breaking URL stayed inside its href.
  const quoted = $("a").filter((_, node) => $(node).text().startsWith("Quote")).attr("href");
  assert.ok(quoted.includes("onmouseover"));
  assert.equal($("a[onmouseover]").length, 0);
  // Unsafe URLs are dropped rather than linked.
  assert.doesNotMatch(text, /javascript:|data:text/i);
  assert.equal(subject.includes("\n"), false);
});

test("safeHref passes only http and https URLs", () => {
  assert.equal(safeHref("https://news.test/a"), "https://news.test/a");
  assert.equal(safeHref("http://news.test/a"), "http://news.test/a");
  for (const value of ["javascript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.test", "", undefined, "not a url"]) {
    assert.equal(safeHref(value), "");
  }
});

// ---- the pages ---------------------------------------------------------------

test("months run from 2026-06 through the current month", () => {
  assert.deepEqual(monthsBetween("2026-11", "2027-02"), ["2026-11", "2026-12", "2027-01", "2027-02"]);
  assert.deepEqual(monthsBetween("2026-06", "2026-05"), []);
});

test("a page is built for each month from 2026-06, and the current one is marked to date", () => {
  const items = [item("2026-09-10T15:00:00Z", { sentiment: "positive" })];
  const pages = buildMonthlyReportPages(items, { now: NOW });
  assert.deepEqual(Object.keys(pages).sort(), [
    "2026-06.html",
    "2026-07.html",
    "2026-08.html",
    "2026-09.html",
    "index.html",
  ]);
  assert.match(pages["2026-09.html"], /<span class="tag">to date<\/span>/);
  assert.doesNotMatch(pages["2026-08.html"], /to date/);

  const index = cheerio.load(pages["index.html"]);
  assert.deepEqual(
    index("ul.index-list li a").map((_, a) => index(a).attr("href")).get(),
    ["2026-09", "2026-08", "2026-07", "2026-06"],
  );
  assert.equal(index("ul.index-list li:first-child .tag").text(), "to date");

  // A new month adds a page without dropping the old ones.
  const october = buildMonthlyReportPages(items, { now: new Date("2026-10-03T16:00:00Z") });
  assert.equal(Object.keys(october).length, 6);
  assert.doesNotMatch(october["2026-09.html"], /to date/);
  assert.match(october["2026-10.html"], /to date/);

  assert.deepEqual(buildMonthlyReportPages(items, { now: new Date("2026-05-15T12:00:00Z") }), {});
});

test("a report page matches the reader's look and prints cleanly", () => {
  const report = buildMonthlyReport(
    [item("2026-09-10T15:00:00Z", { sentiment: "positive", sentimentScore: 88 })],
    { month: "2026-09", now: NOW },
  );
  const html = renderMonthlyReportPage(report);
  const $ = cheerio.load(html);
  assert.equal($("h1").length, 1);
  assert.match($("h1").text(), /Monthly Report: September 2026/);
  assert.equal($(".tag").text(), "to date");
  assert.match(html, /max-width: 560px/);
  assert.match(html, /Helvetica, Arial, sans-serif/);
  // The site is light only, like the reader.
  assert.doesNotMatch(html, /prefers-color-scheme/);
  assert.match(html, /<strong>Not affiliated\.<\/strong>/);
  assert.match(html, /@page \{[^}]*margin/);
  assert.match(html, /@media print/);
  assert.match(html, /\.topbar \{ display: none; \}/);
  assert.match(html, /print-color-adjust: exact/);
  // The only external script is the shared password gate.
  assert.deepEqual($("script[src]").map((_, el) => $(el).attr("src")).get(), ["../gate.js"]);
  assert.match($('meta[name="robots"]').attr("content"), /noindex/);
  // The page carries every section a leader looks for.
  const headings = $("h2").map((_, h) => $(h).text()).get();
  assert.deepEqual(headings, [
    "Sentiment mix",
    "Top outlets",
    "Most favorable stories",
    "Least favorable stories",
    "Top themes",
    "Vermont health care coverage",
  ]);
});

test("page text from the feed is escaped and unsafe links are not linked", () => {
  const report = buildMonthlyReport(HOSTILE, { month: "2026-09", now: NOW });
  const html = renderMonthlyReportPage(report);
  const $ = cheerio.load(html);
  assert.equal($("main script, main img").length, 0);
  assert.ok($("main").text().includes('<script>alert("x")</script>'));
  $("main a[href]").each((_, node) => {
    const href = $(node).attr("href");
    assert.ok(!/^(?:javascript|data):/i.test(href), href);
  });
  assert.doesNotMatch(html, /href="javascript:/i);
  assert.equal($("[onclick], [onerror], [onmouseover]").length, 1); // only the print button
  assert.equal($("button[onclick]").length, 1);
  const index = renderReportsIndex([report]);
  assert.doesNotMatch(index, /<script>alert/);
});

test("writeMonthlyReports writes the pages and never throws", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cerulean-reports-"));
  const items = [item("2026-09-10T15:00:00Z", { sentiment: "positive" })];
  const result = await writeMonthlyReports(items, { outputDir: path.join(dir, "reports"), now: NOW });
  assert.equal(result.written, 5);
  assert.deepEqual((await readdir(path.join(dir, "reports"))).sort(), [
    "2026-06.html",
    "2026-07.html",
    "2026-08.html",
    "2026-09.html",
    "index.html",
  ]);

  const originalError = console.error;
  console.error = () => {};
  try {
    // A malformed clock is a reporting problem, not a feed failure.
    const failed = await writeMonthlyReports(items, { outputDir: path.join(dir, "x"), now: {} });
    assert.equal(failed.written, 0);
  } finally {
    console.error = originalError;
  }
});

test("the feed run writes the reports beside the feed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cerulean-reports-run-"));
  await generateFeed({
    sources: [],
    now: new Date("2026-08-25T12:00:00Z"),
    rssOutputPath: path.join(dir, "site", "feed.rss"),
    jsonOutputPath: path.join(dir, "site", "feed.json"),
    auditJsonOutputPath: path.join(dir, "site", "feed-audit.json"),
  });
  const files = (await readdir(path.join(dir, "site", "reports"))).sort();
  assert.deepEqual(files, ["2026-06.html", "2026-07.html", "2026-08.html", "index.html"]);
  const index = await readFile(path.join(dir, "site", "reports", "index.html"), "utf8");
  assert.match(index, /August 2026/);
});

test("the trends page links the reports index in a marked block", async () => {
  const html = await readFile(new URL("../site/trends.html", import.meta.url), "utf8");
  assert.match(
    html,
    /<!-- feature: monthly-report -->[^]*<a href="reports\/">[^]*<!-- \/feature: monthly-report -->/,
  );
});
