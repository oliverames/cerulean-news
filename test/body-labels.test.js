import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeWithArchive, loadPreviousState } from "../src/archive.js";
import { enrichAndFilterItems, rebuildBrandExcerpts } from "../src/enrich.js";
import { buildJsonSummary } from "../src/outputs.js";
import { buildJevRequest, loadRelevanceRubric } from "../src/jev-relevance.js";
import { buildSummaryPrompt } from "../src/summaries.js";
import {
  applyDeterministicRelevance,
  itemCategory,
  itemSection,
} from "../src/relevance.js";
import { CATEGORY_BRAND, CATEGORY_TOPIC } from "../src/matching.js";
import {
  bodyOnlyField,
  findBodyLabels,
  mergeBodyOnly,
  reconcileBodyOnly,
  withoutBodyOnly,
} from "../src/body-labels.js";

const NOW = new Date("2026-09-29T12:00:00Z");
const MVP = "MVP Health Care";
const UVM = "UVM Health";

const page = (title, ...paragraphs) =>
  `<html><head><title>${title}</title></head><body><article><h1>${title}</h1>${paragraphs
    .map((text) => `<p>${text}</p>`)
    .join("")}</article></body></html>`;

// Enrich one story whose page is served by the stub, with article scanning on.
async function enrich(feedContent, html, extra = {}, cacheOptions = {}) {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";
  const link = "https://example.com/story";
  const articleCache = cacheOptions.articleCache || {};
  try {
    const items = await enrichAndFilterItems(
      [
        {
          sourceName: "Always Scan Outlet",
          title: "Rate review begins",
          link,
          pubDate: new Date("2026-09-20T12:00:00Z"),
          feedContent,
          articleScanMode: "always",
          ...extra,
        },
      ],
      cacheOptions.cache || new Map(),
      {
        articleCache,
        now: NOW,
        fetchText: async (url) => ({
          text: html,
          url,
          notModified: false,
          etag: "",
          lastModified: "",
        }),
        throttleRequest: async () => {},
      },
    );
    return { items, articleCache, link };
  } finally {
    if (originalScan === undefined) delete process.env.RSS_ARTICLE_SCAN;
    else process.env.RSS_ARTICLE_SCAN = originalScan;
  }
}

const RATE_REVIEW_HTML = page(
  "Rate review begins",
  "Blue Cross and Blue Shield of Vermont asked regulators for a 7 percent increase.",
  "MVP Health Care asked for a smaller change, and UVM Health testified on hospital budgets.",
);

test("findBodyLabels reads only the two retention labels", () => {
  assert.deepEqual(
    findBodyLabels("MVP Health Care and UVM Health met about Medicaid and hospitals."),
    [MVP, UVM],
  );
  assert.deepEqual(findBodyLabels("Medicaid and hospitals only."), []);
  assert.deepEqual(findBodyLabels(""), []);
});

test("a body-only MVP mention on a brand story adds MVP Health Care to matchedTerms", async () => {
  const { items, articleCache, link } = await enrich(
    "Blue Cross VT rate request under review.",
    RATE_REVIEW_HTML,
  );
  assert.equal(items.length, 1);
  assert.ok(items[0].matchedTerms.includes(MVP));
  assert.ok(items[0].matchedTerms.includes(UVM));
  assert.ok(items[0].matchedTerms.includes("Blue Cross VT"));
  assert.deepEqual(items[0].bodyOnlyTerms, [MVP, UVM]);
  assert.equal(items[0].category, CATEGORY_BRAND);
  // The body is not kept, so the match is recorded in the cache now.
  assert.ok(articleCache[link].matchedTerms.includes(MVP));
  assert.deepEqual(articleCache[link].bodyOnlyTerms, [MVP, UVM]);
});

test("a label named in the feed text is not marked body-only", async () => {
  const { items } = await enrich(
    "Blue Cross VT and MVP Health Care rate requests under review.",
    RATE_REVIEW_HTML,
  );
  assert.ok(items[0].matchedTerms.includes(MVP));
  assert.deepEqual(items[0].bodyOnlyTerms, [UVM]);
});

test("a body-only mention cannot keep a story the feed text did not match", async () => {
  const { items, articleCache, link } = await enrich(
    "A local budget meeting was held.",
    page("Rate review begins", "MVP Health Care and UVM Health were discussed."),
  );
  assert.deepEqual(items, []);
  // The negative verdict is cached with no labels, as before.
  assert.deepEqual(articleCache[link].matchedTerms, []);
  assert.equal(articleCache[link].bodyOnlyTerms, undefined);
});

test("a body-only mention does not change category or section", async () => {
  // Topic story: matched on the Green Mountain Care Board in the feed text.
  const withBody = await enrich(
    "Green Mountain Care Board hears rate review.",
    RATE_REVIEW_HTML.replace("Blue Cross and Blue Shield of Vermont", "The insurer"),
  );
  const withoutBody = await enrich(
    "Green Mountain Care Board hears rate review.",
    page("Rate review begins", "The insurer asked regulators for a 7 percent increase."),
  );
  assert.ok(withBody.items[0].matchedTerms.includes(MVP));
  assert.equal(withoutBody.items[0].matchedTerms.includes(MVP), false);
  assert.equal(withBody.items[0].category, CATEGORY_TOPIC);
  assert.equal(withBody.items[0].category, withoutBody.items[0].category);
  assert.equal(itemSection(withBody.items[0]), itemSection(withoutBody.items[0]));
  for (const label of [MVP, UVM]) {
    const base = { title: "Rate review", link: "https://example.com/x", matchedTerms: ["Hospitals"] };
    assert.equal(itemCategory({ ...base, matchedTerms: ["Hospitals", label] }), itemCategory(base));
    assert.equal(itemSection({ ...base, matchedTerms: ["Hospitals", label] }), itemSection(base));
  }
});

test("a body-only label cannot rescue a story from the low-priority rejection", () => {
  const base = {
    sourceName: "Example Wire",
    title: "Hospital opens a new wing",
    description: "A ribbon cutting was held.",
    category: CATEGORY_TOPIC,
  };
  const plain = applyDeterministicRelevance({ ...base, matchedTerms: ["Hospitals"] });
  assert.equal(plain.relevant, false);
  const annotated = applyDeterministicRelevance({
    ...base,
    matchedTerms: ["Hospitals", UVM],
    bodyOnlyTerms: [UVM],
  });
  assert.equal(annotated.relevant, plain.relevant);
  assert.equal(annotated.reason, plain.reason);
  // A label from feed text still counts, as it did before this change.
  assert.notEqual(
    applyDeterministicRelevance({ ...base, matchedTerms: ["Hospitals", UVM] }).relevant,
    false,
  );
});

test("Jev and Gemini see the same keywords with or without a body-only label", async () => {
  const item = {
    title: "Rate review begins",
    snippet: "Blue Cross VT asked for a 7 percent increase.",
    sourceName: "Always Scan Outlet",
    category: CATEGORY_BRAND,
    matchedTerms: ["Blue Cross VT"],
  };
  const annotated = {
    ...item,
    matchedTerms: ["Blue Cross VT", MVP],
    bodyOnlyTerms: [MVP],
  };
  const rubric = await loadRelevanceRubric();
  const request = (value) => JSON.stringify(buildJevRequest(value, rubric, {}));
  // Identical requests keep the Jev cache key, so no answer is re-asked.
  assert.equal(request(annotated), request(item));
  assert.match(request(item), /"matchedKeywords":\["Blue Cross VT"\]/);
  assert.equal(buildSummaryPrompt([annotated]), buildSummaryPrompt([item]));
});

test("the label survives the audit archive round trip and the merge", async () => {
  const item = {
    sourceName: "Always Scan Outlet",
    title: "Rate review begins",
    link: "https://example.com/story",
    guid: "https://example.com/story",
    pubDate: new Date("2026-09-20T12:00:00Z"),
    matchedTerms: ["Blue Cross VT", MVP],
    bodyOnlyTerms: [MVP],
    category: CATEGORY_BRAND,
    snippet: "Blue Cross VT asked for a 7 percent increase.",
    relevant: true,
  };
  const publicFeed = buildJsonSummary([item], [], NOW);
  const audit = buildJsonSummary([item], [], NOW, { includeRejected: true });
  assert.ok(publicFeed.items[0].matchedTerms.includes(MVP));
  assert.equal(publicFeed.items[0].bodyOnlyTerms, undefined);
  assert.ok(audit.items[0].matchedTerms.includes(MVP));
  assert.deepEqual(audit.items[0].bodyOnlyTerms, [MVP]);

  const workdir = await mkdtemp(path.join(tmpdir(), "vt-news-body-labels-"));
  const auditPath = path.join(workdir, "feed-audit.json");
  await writeFile(auditPath, JSON.stringify(audit));
  const state = await loadPreviousState(auditPath);
  assert.ok(state.archivedItems[0].matchedTerms.includes(MVP));
  assert.deepEqual(state.archivedItems[0].bodyOnlyTerms, [MVP]);
  assert.ok(state.cache.get(item.link).matchedTerms.includes(MVP));

  // The archived copy meets a fresh run's copy that never saw the body.
  const fresh = { ...item, matchedTerms: ["Blue Cross VT"] };
  delete fresh.bodyOnlyTerms;
  const merged = mergeWithArchive([fresh], state.archivedItems, NOW);
  assert.equal(merged.length, 1);
  assert.ok(merged[0].matchedTerms.includes(MVP));
  assert.deepEqual(merged[0].bodyOnlyTerms, [MVP]);
  assert.equal(merged[0].category, CATEGORY_BRAND);
});

test("a cached article keeps its body labels without fetching the page again", async () => {
  const first = await enrich("Blue Cross VT rate request under review.", RATE_REVIEW_HTML);
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";
  try {
    const again = await enrichAndFilterItems(
      [
        {
          sourceName: "Always Scan Outlet",
          title: "Rate review begins",
          link: first.link,
          pubDate: new Date("2026-09-20T12:00:00Z"),
          feedContent: "Blue Cross VT rate request under review.",
          articleScanMode: "always",
        },
      ],
      new Map(),
      {
        articleCache: first.articleCache,
        now: NOW,
        fetchText: async () => assert.fail("cached article refetched"),
        throttleRequest: async () => {},
      },
    );
    assert.ok(again[0].matchedTerms.includes(MVP));
    assert.deepEqual(again[0].bodyOnlyTerms, [MVP, UVM]);
  } finally {
    if (originalScan === undefined) delete process.env.RSS_ARTICLE_SCAN;
    else process.env.RSS_ARTICLE_SCAN = originalScan;
  }
});

test("a body-only label does not extend how long a non-brand story is kept", () => {
  const old = new Date("2026-02-10T12:00:00Z");
  const topic = (extra) => ({
    link: "https://example.com/old-topic",
    title: "Green Mountain Care Board hears rate review",
    category: CATEGORY_TOPIC,
    matchedTerms: ["Green Mountain Care Board", MVP],
    pubDate: old,
    summary: "",
    ...extra,
  });
  assert.equal(mergeWithArchive([], [topic({ bodyOnlyTerms: [MVP] })], NOW).length, 0);
  // A feed-text match keeps it, as before.
  assert.equal(mergeWithArchive([], [topic()], NOW).length, 1);
});

test("rebuildBrandExcerpts backfills body mentions on an archived brand item", async () => {
  const link = "https://example.com/rates";
  const item = {
    relevant: true,
    category: CATEGORY_BRAND,
    title: "Rate review begins",
    link,
    snippet: "Regulators began the annual hearings.",
    matchedTerms: ["Blue Cross VT"],
  };
  const articleCache = {
    [link]: { snippet: item.snippet, matchedTerms: ["Blue Cross VT"] },
  };
  const result = await rebuildBrandExcerpts([item], {
    articleCache,
    fetchText: async () => ({ text: RATE_REVIEW_HTML, url: link }),
    throttleRequest: async () => {},
  });
  assert.equal(result.labelled, 1);
  assert.ok(item.matchedTerms.includes(MVP));
  assert.deepEqual(item.bodyOnlyTerms, [MVP, UVM]);
  assert.deepEqual(articleCache[link].bodyOnlyTerms, [MVP, UVM]);
  assert.ok(articleCache[link].matchedTerms.includes(MVP));
  assert.equal(item.category, CATEGORY_BRAND);
});

test("helpers keep feed-supported labels out of the body-only list", () => {
  assert.deepEqual(reconcileBodyOnly([MVP, UVM], ["Blue Cross VT", MVP]), [UVM]);
  assert.deepEqual(bodyOnlyField([]), {});
  assert.deepEqual(bodyOnlyField([MVP]), { bodyOnlyTerms: [MVP] });
  const terms = ["Blue Cross VT"];
  assert.equal(withoutBodyOnly({ matchedTerms: terms }), terms);
  assert.deepEqual(
    withoutBodyOnly({ matchedTerms: ["Blue Cross VT", MVP], bodyOnlyTerms: [MVP] }),
    ["Blue Cross VT"],
  );
  assert.deepEqual(
    mergeBodyOnly(
      { matchedTerms: ["Hospitals", MVP] },
      { matchedTerms: ["Hospitals", MVP], bodyOnlyTerms: [MVP] },
    ),
    [],
  );
});
