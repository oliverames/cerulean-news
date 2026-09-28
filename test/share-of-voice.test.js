import assert from "node:assert/strict";
import test from "node:test";
import {
  ENTITIES,
  NON_BRAND_RETENTION_DAYS,
  completeFromKey,
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

test("months before the retention window are marked partial", () => {
  const months = monthlyShareOfVoice(
    [
      bcvt({ pubDate: "2026-05-05T00:00:00.000Z" }),
      bcvt({ pubDate: "2026-06-20T00:00:00.000Z" }),
      bcvt({ pubDate: "2026-07-05T00:00:00.000Z" }),
    ],
    { completeFrom: "2026-07" },
  );
  assert.deepEqual(
    months.map((m) => [m.key, m.partial]),
    [
      ["2026-05", true],
      ["2026-06", true],
      ["2026-07", false],
    ],
  );
  // With no cutoff nothing is marked.
  assert.ok(
    monthlyShareOfVoice([bcvt()]).every((m) => m.partial === false),
  );
});

test("completeFromKey is the first month that starts inside the retention window", () => {
  assert.equal(NON_BRAND_RETENTION_DAYS, 92);
  // 92 days before 2026-09-28 is 2026-06-28, so June is only partly held.
  assert.equal(completeFromKey("2026-09-28T22:23:11.841Z"), "2026-07");
  // A cutoff exactly at a month start keeps that month whole.
  assert.equal(completeFromKey("2026-10-01T00:00:00.000Z", 30), "2026-09");
  assert.equal(completeFromKey("2026-01-10T00:00:00.000Z"), "2025-11");
  assert.equal(completeFromKey("not a date"), "");
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
  const [aug] = monthlyShareOfVoice(summary.items, {
    completeFrom: completeFromKey(summary.generatedAt),
  });
  assert.deepEqual(aug.counts, { bcvt: 1, mvp: 1, uvm: 2 });
  assert.equal(aug.partial, false);
});
