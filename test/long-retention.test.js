import assert from "node:assert/strict";
import test from "node:test";
import { mergeWithArchive } from "../src/archive.js";
import {
  CATEGORY_TOPIC,
  INDEFINITE_RETENTION_LABELS,
  MENTION_TERMS,
  TOPIC_TERMS,
  findMentionTerms,
} from "../src/matching.js";
import {
  DEFAULT_SOURCES,
  applyBackfillWindow,
} from "../src/sources.js";
import { ENTITIES } from "../site/share-of-voice.js";

const NOW = new Date("2026-09-28T12:00:00Z");
const ALL_TERMS = [...MENTION_TERMS, ...TOPIC_TERMS];

// A headline that makes the matcher return each label, so the fixtures carry
// the terms a real crawl would.
const HEADLINES = {
  "MVP Health Care": "MVP Health Care files 2027 Vermont rates",
  "UVM Health": "UVM Health Network names a new chief",
};

function topicItem(label, overrides = {}) {
  const title = HEADLINES[label];
  const matchedTerms = findMentionTerms(title, ALL_TERMS);
  assert.ok(matchedTerms.includes(label), `${label} fixture must match`);
  return {
    link: `https://example.com/${label.replace(/\W+/g, "-").toLowerCase()}`,
    title,
    category: CATEGORY_TOPIC,
    matchedTerms,
    pubDate: new Date("2026-02-10T12:00:00Z"),
    summary: "",
    ...overrides,
  };
}

const oldUnrelated = () => ({
  link: "https://example.com/old-hospital",
  title: "Hospital board approves a budget",
  category: CATEGORY_TOPIC,
  matchedTerms: ["Hospitals"],
  pubDate: new Date("2026-02-10T12:00:00Z"),
  summary: "",
});

test("the long-retention labels are matcher topic labels and the ones share of voice charts", () => {
  const topicLabels = new Set(TOPIC_TERMS.map((term) => term.label));
  assert.deepEqual(INDEFINITE_RETENTION_LABELS, ["MVP Health Care", "UVM Health"]);
  for (const label of INDEFINITE_RETENTION_LABELS) {
    assert.ok(topicLabels.has(label), label);
  }
  const charted = ENTITIES.filter((entity) => entity.key !== "bcvt").map(
    (entity) => entity.label,
  );
  assert.deepEqual(charted, INDEFINITE_RETENTION_LABELS);
});

test("old MVP Health Care and UVM Health stories outlive the 92-day window", () => {
  // Both are 230 days old, well past ARCHIVE_MAX_AGE_DAYS.
  const archived = INDEFINITE_RETENTION_LABELS.map((label) => topicItem(label));
  const merged = mergeWithArchive([], [...archived, oldUnrelated()], NOW);
  assert.deepEqual(
    merged.map((item) => item.link).sort(),
    archived.map((item) => item.link).sort(),
  );
});

test("a story that names a long-retention label among other terms is kept", () => {
  const item = topicItem("UVM Health", {
    matchedTerms: ["Hospitals", "UVM Health", "Medicaid"],
  });
  assert.equal(mergeWithArchive([], [item], NOW).length, 1);
});

test("the other merge rules still apply to long-retention stories", () => {
  for (const label of INDEFINITE_RETENTION_LABELS) {
    const kept = mergeWithArchive([], [topicItem(label)], NOW);
    assert.equal(kept.length, 1, label);

    // Rejected by the summarizer.
    assert.equal(
      mergeWithArchive([], [topicItem(label, { reason: "False positive" })], NOW)
        .length,
      0,
      `${label} false positive`,
    );
    // Wire press releases that are not brand stories.
    assert.equal(
      mergeWithArchive(
        [],
        [topicItem(label, { link: "https://example.com/press_releases/x.html" })],
        NOW,
      ).length,
      0,
      `${label} press release`,
    );
    // No current matching evidence in the text.
    assert.equal(
      mergeWithArchive(
        [],
        [topicItem(label, { title: "A local hardware store reopens" })],
        NOW,
      ).length,
      0,
      `${label} no evidence`,
    );
    // Dated in the future beyond clock skew.
    assert.equal(
      mergeWithArchive(
        [],
        [topicItem(label, { pubDate: new Date("2026-10-15T12:00:00Z") })],
        NOW,
      ).length,
      0,
      `${label} future skew`,
    );
  }
});

test("the MVP and UVM Health searches are Google News search sources that a backfill rebounds", () => {
  const mvp = DEFAULT_SOURCES.find(
    (source) => source.name === "Google News MVP Health Care Search",
  );
  const uvm = DEFAULT_SOURCES.find(
    (source) => source.name === "Google News UVM Health Search",
  );
  assert.ok(mvp && uvm, "both sources are registered");

  const queryOf = (source) => new URL(source.feedUrl).searchParams.get("q");
  for (const source of [mvp, uvm]) {
    assert.equal(new URL(source.feedUrl).hostname, "news.google.com");
    assert.equal(source.isSearchFeed, true);
    assert.equal(source.maxItems, 100);
    assert.equal(source.maxItemAgeDays, 30);
    assert.match(queryOf(source), / when:30d$/);
  }
  // MVP also operates in New York, so the search is scoped to Vermont.
  assert.match(queryOf(mvp), /"MVP Health Care" \(Vermont OR VT\)/);
  // Every name the UVM search asks for is one the matcher labels UVM Health.
  const names = [...queryOf(uvm).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, [
    "UVM Health",
    "UVM Health Network",
    "UVM Medical Center",
    "University of Vermont Health",
  ]);
  for (const name of names) {
    assert.ok(findMentionTerms(name, ALL_TERMS).includes("UVM Health"), name);
  }

  const window = { after: "2026-03-01", before: "2026-04-01" };
  const rebounded = applyBackfillWindow(DEFAULT_SOURCES, window).filter((source) =>
    [mvp.name, uvm.name].includes(source.name),
  );
  assert.equal(rebounded.length, 2);
  for (const source of rebounded) {
    const q = queryOf(source);
    assert.match(q, / after:2026-03-01 before:2026-04-01$/);
    assert.doesNotMatch(q, /when:\d+d/);
    assert.equal(source.maxItemAgeDays, undefined);
    assert.equal(source.minPubDate, "2026-02-28T00:00:00Z");
    assert.equal(source.refetchIgnoringCache, true);
    assert.equal(source.maxItems, 100);
  }
  assert.match(queryOf(rebounded[0]), /"MVP Health Care" \(Vermont OR VT\)/);
});
