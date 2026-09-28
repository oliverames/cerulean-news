import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

// site/search-tools.js is a classic browser script. Run it in this realm, which
// has no document, so its pure helpers publish on globalThis.CeruleanSearchTools.
vm.runInThisContext(
  fs.readFileSync(new URL("../site/search-tools.js", import.meta.url), "utf8"),
  { filename: "site/search-tools.js" },
);
const tools = globalThis.CeruleanSearchTools;

// Local-time constructors keep the day checks independent of the machine's zone.
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();
const story = (title, pubDate, extra = {}) => ({ title, pubDate, ...extra });

test("csvField follows RFC 4180 quoting", () => {
  assert.equal(tools.csvField("plain"), "plain");
  assert.equal(tools.csvField("a,b"), '"a,b"');
  assert.equal(tools.csvField('say "hi"'), '"say ""hi"""');
  assert.equal(tools.csvField("two\nlines"), '"two\nlines"');
  assert.equal(tools.csvField("cr\rlf"), '"cr\rlf"');
  assert.equal(tools.csvField(null), "");
  assert.equal(tools.csvField(undefined), "");
  assert.equal(tools.csvField(72), "72");
  assert.equal(tools.csvField(0), "0");
  assert.equal(tools.csvField(Number.NaN), "");
});

test("csvField defuses spreadsheet formulas in text but not in numbers", () => {
  assert.equal(tools.csvField("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(tools.csvField("+1 (802) 555"), "'+1 (802) 555");
  assert.equal(tools.csvField("@cmd"), "'@cmd");
  assert.equal(tools.csvField("-5% premiums, again"), '"\'-5% premiums, again"');
  assert.equal(tools.csvField(-5), "-5");
});

test("itemsToCsv writes the header, CRLF line ends, and one row per item", () => {
  const items = [
    story("Blue Cross \"VT\" rates, again", at(2026, 9, 26), {
      section: "Blue Cross VT News",
      outlet: "VTDigger",
      link: "https://example.test/a?x=1,2",
      sentiment: "neutral to positive",
      sentimentScore: 61,
      summary: "Line one.\nLine two, with a comma.",
    }),
    story("No sentiment here", at(2026, 9, 25), { outlet: "WCAX", link: "https://example.test/b" }),
  ];
  const csv = tools.itemsToCsv(items, () => "Vermont Healthcare News");
  assert.equal(
    csv,
    [
      "date,section,outlet,title,url,sentiment,sentimentScore,summary",
      '2026-09-26,Vermont Healthcare News,VTDigger,"Blue Cross ""VT"" rates, again","https://example.test/a?x=1,2",neutral to positive,61,"Line one.\nLine two, with a comma."',
      "2026-09-25,Vermont Healthcare News,WCAX,No sentiment here,https://example.test/b,,,",
      "",
    ].join("\r\n"),
  );
});

test("itemsToCsv falls back to the item's own fields, and a zero score survives", () => {
  const csv = tools.itemsToCsv([
    story("T", at(2026, 9, 1), { section: "National Healthcare News", sourceName: "Google News", url: "https://e.test/u", sentimentScore: 0, sentiment: "negative", snippet: "snip" }),
  ]);
  assert.equal(csv.split("\r\n")[1], "2026-09-01,National Healthcare News,Google News,T,https://e.test/u,negative,0,snip");
});

test("csvFilename uses the local day", () => {
  assert.equal(tools.csvFilename(new Date(2026, 8, 28, 23, 59)), "cerulean-news-2026-09-28.csv");
  assert.equal(tools.csvFilename(new Date(2026, 0, 5, 0, 1)), "cerulean-news-2026-01-05.csv");
});

test("normalizeDay accepts only real YYYY-MM-DD days", () => {
  assert.equal(tools.normalizeDay("2026-09-28"), "2026-09-28");
  assert.equal(tools.normalizeDay(" 2026-02-29 "), "");
  assert.equal(tools.normalizeDay("2028-02-29"), "2028-02-29");
  assert.equal(tools.normalizeDay("2026-13-01"), "");
  assert.equal(tools.normalizeDay("9/28/2026"), "");
  assert.equal(tools.normalizeDay(""), "");
  assert.equal(tools.normalizeDay(undefined), "");
});

test("filterByDateRange is inclusive and drops undated items once a bound is set", () => {
  const items = [
    story("before", at(2026, 9, 9, 23)),
    story("first day, early", at(2026, 9, 10, 0)),
    story("middle", at(2026, 9, 15)),
    story("last day, late", new Date(2026, 8, 20, 23, 59).toISOString()),
    story("after", at(2026, 9, 21, 0)),
    story("undated", ""),
    story("garbage", "not a date"),
  ];
  const titles = (list) => list.map((item) => item.title);
  assert.deepEqual(titles(tools.filterByDateRange(items, "2026-09-10", "2026-09-20")),
    ["first day, early", "middle", "last day, late"]);
  assert.deepEqual(titles(tools.filterByDateRange(items, "2026-09-20", "")), ["last day, late", "after"]);
  assert.deepEqual(titles(tools.filterByDateRange(items, "", "2026-09-09")), ["before"]);
  assert.deepEqual(titles(tools.filterByDateRange(items, "2026-09-15", "2026-09-15")), ["middle"]);
  // No bounds, or unusable bounds, leave every item, undated ones included.
  assert.equal(tools.filterByDateRange(items, "", ""), items);
  assert.equal(tools.filterByDateRange(items, "bogus", "2026-13-40"), items);
});

test("a reversed range matches nothing and is reported", () => {
  const items = [story("x", at(2026, 9, 15))];
  assert.deepEqual(tools.filterByDateRange(items, "2026-09-20", "2026-09-10"), []);
  assert.match(tools.dateRangeProblem("2026-09-20", "2026-09-10"), /after the end date/);
  assert.equal(tools.dateRangeProblem("2026-09-10", "2026-09-10"), "");
  assert.equal(tools.dateRangeProblem("", "2026-09-10"), "");
});

test("hash state round-trips search, section, and dates", () => {
  const state = { q: "rate & review, 2027", section: "vermont", from: "2026-09-01", to: "2026-09-28" };
  const parts = tools.stateToHashParts(state);
  assert.deepEqual(parts, ["section=vermont", "q=rate%20%26%20review%2C%202027", "from=2026-09-01", "to=2026-09-28"]);
  assert.deepEqual(tools.parseHashState(`#${parts.join("&")}&page=3`), state);
  assert.deepEqual(tools.stateToHashParts({}), []);
  assert.deepEqual(tools.parseHashState("#"), { q: "", section: "all", from: "", to: "" });
  assert.deepEqual(tools.parseHashState("#q=%&from=nope&section=zzz"), { q: "", section: "all", from: "", to: "" });
});

test("saved searches serialize to storage text and back", () => {
  const list = [
    { name: "Rates", q: "rate review", section: "brand", from: "2026-09-01", to: "" },
    { name: "  Hospital   budgets ", q: "", section: "vermont", from: "", to: "2026-09-28" },
  ];
  const text = tools.serializeSaved(list);
  assert.equal(typeof text, "string");
  assert.deepEqual(tools.parseSaved(text), [
    list[0],
    { name: "Hospital budgets", q: "", section: "vermont", from: "", to: "2026-09-28" },
  ]);
});

test("serializeSaved cleans entries before writing them", () => {
  const text = tools.serializeSaved([null, { name: "" }, { name: "Keep", section: "bogus", from: "x" }, "junk"]);
  assert.deepEqual(JSON.parse(text), [{ name: "Keep", q: "", section: "all", from: "", to: "" }]);
  assert.equal(tools.serializeSaved("not a list"), "[]");
});

test("parseSaved survives corrupt storage and drops bad entries", () => {
  assert.deepEqual(tools.parseSaved("{not json"), []);
  assert.deepEqual(tools.parseSaved('{"a":1}'), []);
  assert.deepEqual(tools.parseSaved(""), []);
  assert.deepEqual(tools.parseSaved(null), []);
  const parsed = tools.parseSaved(JSON.stringify([
    { name: "ok", q: "x", section: "national", from: "2026-01-01", to: "2026-02-30" },
    { name: "", q: "no name" },
    { q: "missing name" },
    "string",
    null,
    { name: "OK", q: "duplicate by case" },
    { name: "odd", section: "nope", from: "junk" },
  ]));
  assert.deepEqual(parsed, [
    { name: "ok", q: "x", section: "national", from: "2026-01-01", to: "" },
    { name: "odd", q: "", section: "all", from: "", to: "" },
  ]);
});

test("addSavedSearch replaces by name, ignoring case, and caps the list", () => {
  let list = tools.addSavedSearch([], { name: "Rates", q: "rate" });
  list = tools.addSavedSearch(list, { name: "Budgets", q: "budget" });
  list = tools.addSavedSearch(list, { name: "rates", q: "rate hike", section: "brand" });
  assert.deepEqual(list.map((entry) => [entry.name, entry.q, entry.section]),
    [["rates", "rate hike", "brand"], ["Budgets", "budget", "all"]]);
  assert.equal(tools.addSavedSearch(list, { name: "  ", q: "x" }), list);
  for (let index = 0; index < 30; index += 1) {
    list = tools.addSavedSearch(list, { name: `s${index}`, q: "q" });
  }
  assert.equal(list.length, 20);
  assert.equal(list.at(-1).name, "s29");
  assert.equal(tools.parseSaved(tools.serializeSaved(list)).length, 20);
});

test("removeSavedSearch drops one entry by name", () => {
  const list = [{ name: "A" }, { name: "B" }].map((entry) => tools.sanitizeSaved(entry));
  assert.deepEqual(tools.removeSavedSearch(list, "a").map((entry) => entry.name), ["B"]);
  assert.equal(tools.removeSavedSearch(list, "missing").length, 2);
});

test("savedSearchHash builds a link that restores the search", () => {
  const entry = { name: "Rates", q: "rate review", section: "brand", from: "2026-09-01", to: "2026-09-28" };
  const hash = tools.savedSearchHash(entry);
  assert.equal(hash, "#section=brand&q=rate%20review&from=2026-09-01&to=2026-09-28");
  assert.equal(tools.sameState(tools.parseHashState(hash), entry), true);
  assert.equal(tools.savedSearchHash({ name: "empty" }), "#");
});
