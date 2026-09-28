import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { buildJsonSummary } from "../src/outputs.js";
import {
  buildStorylinesSummary,
  getStorylines,
  normalizeStorylines,
  setStorylines,
  storylinesForItem,
  weekStart,
  writeStorylinesSummary,
} from "../src/storylines.js";

const FIXTURE = {
  storylines: [
    {
      id: "rates",
      name: "Rate review",
      description: "Premium requests and rulings.",
      match: ["Rate Review", "premium hike"],
      exclude: ["hospital"],
    },
    {
      id: "basic",
      name: "Basic plan",
      match: ["vt basic"],
      start: "2026-06-01",
    },
  ],
};

const restore = getStorylines();
afterEach(() => setStorylines({ storylines: restore }));

function story(title, pubDate, extra = {}) {
  return {
    sourceName: "VTDigger",
    title,
    link: `https://example.com/${encodeURIComponent(title)}`,
    pubDate: pubDate ? new Date(pubDate) : null,
    matchedTerms: ["Vermont health care"],
    relevant: true,
    ...extra,
  };
}

function brand(title, pubDate, sentiment) {
  return story(title, pubDate, {
    matchedTerms: ["BCBSVT"],
    snippet: "BCBSVT mention.",
    sentiment,
  });
}

function childLoad(env) {
  const script =
    'import("./src/storylines.js").then((m) => console.log(m.getStorylines().length))';
  return execFileSync(process.execPath, ["-e", script], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
  }).trim();
}

test("the committed definitions load, are unique, and carry no scoring notes", async () => {
  const raw = JSON.parse(await readFile(new URL("../data/storylines.json", import.meta.url), "utf8"));
  const loaded = normalizeStorylines(raw);
  assert.equal(loaded.length, raw.storylines.length);
  assert.ok(loaded.length >= 5);
  assert.equal(new Set(loaded.map((entry) => entry.id)).size, loaded.length);
  for (const entry of raw.storylines) {
    assert.equal("note" in entry, false, `${entry.id} must not carry a scoring note`);
    assert.equal("evidence" in entry, false);
  }
  assert.equal(childLoad({}), String(loaded.length));
});

test("a missing or malformed file degrades to no storylines", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "storylines-"));
  const broken = path.join(dir, "broken.json");
  await writeFile(broken, "{ not json");
  assert.equal(childLoad({ STORYLINES_PATH: broken }), "0");
  assert.equal(childLoad({ STORYLINES_PATH: path.join(dir, "absent.json") }), "0");
  for (const doc of [null, "text", 7, {}, { storylines: "x" }, { storylines: [null, 3, {}] }]) {
    assert.deepEqual(normalizeStorylines(doc), []);
  }
});

test("one bad entry is dropped without losing the good ones", () => {
  const loaded = normalizeStorylines({
    storylines: [
      { id: "ok", name: "Fine", match: ["  Alpha "], exclude: ["BETA"], start: "not a date" },
      { id: "Bad Id!", name: "Bad", match: ["x"] },
      { id: "nomatch", name: "No terms", match: [] },
      { id: "ok", name: "Duplicate", match: ["y"] },
    ],
  });
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].match, ["alpha"]);
  assert.deepEqual(loaded[0].exclude, ["beta"]);
  assert.equal(loaded[0].start, "");
});

test("matching is case-insensitive over title and summary, and exclusion wins", () => {
  setStorylines(FIXTURE);
  assert.deepEqual(storylinesForItem(story("Rate Review opens", "2026-08-01")), ["rates"]);
  assert.deepEqual(storylinesForItem(story("Budget day", "2026-08-01", { summary: "A premium hike was approved." })), ["rates"]);
  assert.deepEqual(storylinesForItem(story("Rate review hits hospital budgets", "2026-08-01")), []);
  assert.deepEqual(storylinesForItem(story("Unrelated", "2026-08-01")), []);
  assert.deepEqual(storylinesForItem({}), []);
});

test("a start date keeps older and undated stories out, and one story can join several", () => {
  setStorylines(FIXTURE);
  assert.deepEqual(storylinesForItem(story("VT Basic proposed", "2026-05-31")), []);
  assert.deepEqual(storylinesForItem(story("VT Basic proposed", null)), []);
  assert.deepEqual(storylinesForItem(story("VT Basic proposed", "2026-06-01")), ["basic"]);
  assert.deepEqual(
    storylinesForItem(story("VT Basic rate review", "2026-07-01")),
    ["rates", "basic"],
  );
  // The published feed carries ISO strings rather than Dates.
  assert.deepEqual(storylinesForItem({ title: "VT Basic", pubDate: "2026-07-01T00:00:00.000Z" }), ["basic"]);
});

test("published items carry storylines only when they belong to one", () => {
  setStorylines(FIXTURE);
  const feed = buildJsonSummary(
    [story("Rate review begins", "2026-08-01"), story("Nothing to see", "2026-08-02")],
    [],
    new Date("2026-08-03T00:00:00Z"),
  );
  const byTitle = Object.fromEntries(feed.items.map((item) => [item.title, item]));
  assert.deepEqual(byTitle["Rate review begins"].storylines, ["rates"]);
  assert.equal("storylines" in JSON.parse(JSON.stringify(byTitle["Nothing to see"])), false);
});

test("weeks start on Monday in UTC", () => {
  assert.equal(weekStart(new Date("2026-09-28T23:59:00Z")), "2026-09-28");
  assert.equal(weekStart(new Date("2026-09-27T23:59:00Z")), "2026-09-21");
  assert.equal(weekStart(new Date("2026-09-21T00:00:00Z")), "2026-09-21");
});

test("weekly aggregation zero-fills, counts brand sentiment only, and lists newest first", () => {
  setStorylines(FIXTURE);
  const items = [
    brand("Rate review one", "2026-08-03T10:00:00Z", "positive"),
    brand("Rate review two", "2026-08-05T10:00:00Z", "neutral"),
    story("Rate review three, no brand", "2026-08-06T10:00:00Z", { sentiment: "negative" }),
    story("Rate review four", "2026-08-24T10:00:00Z"),
    story("Rate review rejected", "2026-08-25T10:00:00Z", { relevant: false }),
    story("Rate review undated", null),
    story("Unrelated", "2026-08-10T10:00:00Z"),
  ];
  const summary = buildStorylinesSummary(items, new Date("2026-09-01T00:00:00Z"));
  const rates = summary.storylines.find((entry) => entry.id === "rates");
  assert.equal(rates.total, 5);
  assert.equal(rates.undated, 1);
  assert.deepEqual(
    rates.weeks.map((week) => [week.week, week.count, week.scored]),
    [
      ["2026-08-03", 3, 2],
      ["2026-08-10", 0, 0],
      ["2026-08-17", 0, 0],
      ["2026-08-24", 1, 0],
      ["2026-08-31", 0, 0],
    ],
  );
  assert.deepEqual(rates.weeks[0].sentiment, { positive: 1, neutral: 1 });
  assert.equal(rates.stories.length, 5);
  assert.equal(rates.stories[0].title, "Rate review four");
  assert.equal(rates.stories.at(-1).date, null);
  assert.equal(rates.stories.find((s) => s.title === "Rate review one").sentiment, "positive");
  assert.equal(rates.stories.find((s) => s.title === "Rate review three, no brand").sentiment, undefined);

  const basic = summary.storylines.find((entry) => entry.id === "basic");
  assert.equal(basic.total, 0);
  assert.deepEqual(basic.weeks, []);
});

test("writeStorylinesSummary writes the summary beside the feeds", async () => {
  setStorylines(FIXTURE);
  const dir = await mkdtemp(path.join(os.tmpdir(), "storylines-out-"));
  const target = path.join(dir, "storylines.json");
  await writeStorylinesSummary([story("Rate review", "2026-08-03T10:00:00Z")], target, new Date("2026-08-04T00:00:00Z"));
  const written = JSON.parse(await readFile(target, "utf8"));
  assert.equal(written.generatedAt, "2026-08-04T00:00:00.000Z");
  assert.equal(written.storylines[0].total, 1);
});
