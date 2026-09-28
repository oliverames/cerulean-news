import assert from "node:assert/strict";
import test from "node:test";
import {
  ENTITIES,
  SHARE_OF_VOICE_START,
  entityKeysFor,
  isPressItem,
  monthlyShareOfVoice,
  totalsOf,
} from "../site/share-of-voice.js";
import {
  CATEGORY_BRAND,
  MENTION_TERMS,
  TOPIC_TERMS,
} from "../src/matching.js";
import { buildJsonSummary } from "../src/outputs.js";

// A published feed item, reduced to the fields the page reads.
function story(overrides = {}) {
  return {
    link: "https://example.com/story",
    pubDate: "2026-08-10T12:00:00.000Z",
    sourceType: "News",
    category: "VT Health Care",
    matchedTerms: [],
    ...overrides,
  };
}

const bcvt = (o = {}) =>
  story({ category: CATEGORY_BRAND, matchedTerms: ["BCBSVT"], ...o });
const mvp = (o = {}) => story({ matchedTerms: ["MVP Health Care"], ...o });
const uvm = (o = {}) => story({ matchedTerms: ["UVM Health"], ...o });

test("entity labels are the matcher's own canonical labels", () => {
  const labels = new Set(
    [...MENTION_TERMS, ...TOPIC_TERMS].map((term) => term.label),
  );
  assert.equal(
    ENTITIES.find((e) => e.key === "bcvt").label,
    CATEGORY_BRAND,
  );
  assert.ok(labels.has(ENTITIES.find((e) => e.key === "mvp").label));
  assert.ok(labels.has(ENTITIES.find((e) => e.key === "uvm").label));
});

test("each entity is defined by category or matched term, and a story can count for several", () => {
  assert.deepEqual(entityKeysFor(bcvt()), ["bcvt"]);
  assert.deepEqual(entityKeysFor(mvp()), ["mvp"]);
  assert.deepEqual(entityKeysFor(uvm()), ["uvm"]);
  assert.deepEqual(
    entityKeysFor(
      bcvt({ matchedTerms: ["BCBSVT", "MVP Health Care", "UVM Health"] }),
    ),
    ["bcvt", "mvp", "uvm"],
  );
  // A topic story that names no tracked organization counts for none.
  assert.deepEqual(entityKeysFor(story({ matchedTerms: ["Medicaid"] })), []);
  // Blue Cross VT follows the category, so a bare "Blue Cross" the matcher
  // demoted to a topic story is not counted as ours.
  assert.deepEqual(
    entityKeysFor(story({ matchedTerms: ["Blue Cross"] })),
    [],
  );
});

test("only relevant press coverage counts", () => {
  assert.equal(isPressItem(bcvt()), true);
  assert.equal(isPressItem(bcvt({ relevant: false })), false);
  assert.equal(isPressItem(bcvt({ pubDate: null })), false);
  // The insurer's own posts, by the published type and by the link.
  assert.equal(isPressItem(bcvt({ sourceType: "BlueCrossVT.org" })), false);
  assert.equal(
    isPressItem(
      bcvt({ sourceType: undefined, link: "https://www.bluecrossvt.org/news/x" }),
    ),
    false,
  );
  // Social and short-video items, and the Blues association's pages.
  assert.equal(isPressItem(bcvt({ sourceType: "Social" })), false);
  assert.equal(
    isPressItem(uvm({ link: "https://www.facebook.com/wcax/posts/1" })),
    false,
  );
  assert.equal(
    isPressItem(uvm({ link: "https://www.tiktok.com/@user/video/1" })),
    false,
  );
  assert.equal(isPressItem(bcvt({ link: "https://www.bcbs.com/news/x" })), false);
  assert.deepEqual(entityKeysFor(uvm({ sourceType: "Social" })), []);
  // An outlet that merely has "x" in its name is still press.
  assert.equal(isPressItem(uvm({ link: "https://www.vtdigger.org/a" })), true);
});

test("monthly counts and shares use the combined mention total", () => {
  const months = monthlyShareOfVoice([
    bcvt(),
    bcvt(),
    bcvt({ matchedTerms: ["BCBSVT", "UVM Health"] }),
    uvm(),
    mvp({ pubDate: "2026-09-02T12:00:00.000Z" }),
    // Excluded items must not move any count.
    bcvt({ sourceType: "BlueCrossVT.org" }),
    uvm({ relevant: false }),
  ]);

  assert.deepEqual(
    months.map((m) => m.key),
    ["2026-08", "2026-09"],
  );
  const [aug, sep] = months;
  assert.deepEqual(aug.counts, { bcvt: 3, mvp: 0, uvm: 2 });
  assert.equal(aug.total, 5);
  assert.equal(aug.shares.bcvt, 3 / 5);
  assert.equal(aug.shares.mvp, 0);
  assert.equal(aug.shares.uvm, 2 / 5);
  assert.deepEqual(sep.counts, { bcvt: 0, mvp: 1, uvm: 0 });
  assert.equal(sep.shares.mvp, 1);
});

test("quiet months between coverage stay as zero rows with no share", () => {
  const months = monthlyShareOfVoice([
    bcvt({ pubDate: "2026-06-05T00:00:00.000Z" }),
    bcvt({ pubDate: "2026-08-05T00:00:00.000Z" }),
  ]);
  assert.deepEqual(
    months.map((m) => [m.key, m.total]),
    [
      ["2026-06", 1],
      ["2026-07", 0],
      ["2026-08", 1],
    ],
  );
  assert.equal(months[1].shares.bcvt, null);
  assert.deepEqual(monthlyShareOfVoice([]), []);
  assert.deepEqual(monthlyShareOfVoice([bcvt({ relevant: false })]), []);
});

test("share of voice starts at January 2026 and marks no month incomplete", () => {
  assert.equal(SHARE_OF_VOICE_START, "2026-01");
  const months = monthlyShareOfVoice([
    // Before the start: left out, and does not stretch the axis back.
    bcvt({ pubDate: "2025-12-20T00:00:00.000Z" }),
    uvm({ pubDate: "2025-11-05T00:00:00.000Z" }),
    bcvt({ pubDate: "2026-01-02T00:00:00.000Z" }),
    mvp({ pubDate: "2026-01-31T23:00:00.000Z" }),
    uvm({ pubDate: "2026-04-05T00:00:00.000Z" }),
  ]);
  assert.deepEqual(
    months.map((m) => [m.key, m.total]),
    [
      ["2026-01", 2],
      ["2026-02", 0],
      ["2026-03", 0],
      ["2026-04", 1],
    ],
  );
  // Quiet months stay as zero rows with no share, and nothing is flagged.
  assert.equal(months[1].shares.bcvt, null);
  assert.ok(months.every((m) => !("partial" in m)));
  // Everything before the start is dropped entirely.
  assert.deepEqual(
    monthlyShareOfVoice([bcvt({ pubDate: "2025-12-31T23:00:00.000Z" })]),
    [],
  );
  // A caller can move the start, as the trends page does not.
  assert.deepEqual(
    monthlyShareOfVoice(
      [bcvt({ pubDate: "2026-01-02T00:00:00.000Z" }), bcvt()],
      { start: "2026-08" },
    ).map((m) => m.key),
    ["2026-08"],
  );
});

test("totalsOf sums across the given months", () => {
  const months = monthlyShareOfVoice([
    bcvt(),
    bcvt(),
    uvm(),
    uvm({ pubDate: "2026-09-01T00:00:00.000Z" }),
  ]);
  const totals = totalsOf(months);
  assert.deepEqual(totals.counts, { bcvt: 2, mvp: 0, uvm: 2 });
  assert.equal(totals.total, 4);
  assert.equal(totals.shares.bcvt, 0.5);
  assert.equal(totalsOf([]).shares.bcvt, null);
});

test("the published feed fields drive the counts and agree with the sentiment coverage set", () => {
  const generated = new Date("2026-09-28T12:00:00Z");
  const summary = buildJsonSummary(
    [
      {
        sourceName: "VTDigger",
        title: "BCBSVT and UVM Health reach a contract",
        link: "https://vtdigger.org/a",
        pubDate: new Date("2026-08-12T12:00:00Z"),
        matchedTerms: ["BCBSVT", "UVM Health"],
      },
      {
        sourceName: "WCAX",
        title: "UVM Health hires",
        link: "https://www.wcax.com/b",
        pubDate: new Date("2026-08-13T12:00:00Z"),
        matchedTerms: ["UVM Health"],
      },
      {
        sourceName: "Seven Days",
        title: "MVP Health Care files rates",
        link: "https://www.sevendaysvt.com/c",
        pubDate: new Date("2026-08-14T12:00:00Z"),
        matchedTerms: ["MVP Health Care"],
      },
      {
        sourceName: "Blue Cross VT",
        title: "Our own post",
        link: "https://www.bluecrossvt.org/news/d",
        pubDate: new Date("2026-08-15T12:00:00Z"),
        matchedTerms: ["BCBSVT", "UVM Health"],
      },
      {
        sourceName: "Gazette",
        title: "Blue Cross, Cooley Dickinson assure Medicare Advantage patients",
        link: "https://www.gazettenet.com/e",
        pubDate: new Date("2026-08-16T12:00:00Z"),
        matchedTerms: ["Blue Cross"],
      },
    ],
    [],
    generated,
  );

  for (const item of summary.items) {
    assert.equal(
      entityKeysFor(item).includes("bcvt"),
      Boolean(item.sentimentEligible),
      item.title,
    );
  }
  const [aug] = monthlyShareOfVoice(summary.items);
  assert.deepEqual(aug.counts, { bcvt: 1, mvp: 1, uvm: 2 });
});
