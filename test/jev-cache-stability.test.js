// Jev cache answers stay valid between ordinary runs (#21). The private seed
// exists only on the runner, so every library here is built from a synthetic
// seed, and Jev is a stub that counts calls.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCrawlState } from "../src/archive.js";
import { loadAlignmentProfile } from "../src/jev-alignment.js";
import { legacyJevCacheKey } from "../src/jev-cache-keys.js";
import { buildReferenceExamples, chooseReferenceExamples, exampleId, selectReferenceExamples } from "../src/jev-examples.js";
import { freezeReferenceText, normalizeJevExampleState } from "../src/jev-freeze.js";
import { applyJevRelevance, buildJevRequest, loadRelevanceRubric, loadSentimentRubric } from "../src/jev-relevance.js";

const AWARD = "https://news.test/award", RATES = "https://news.test/rates", GRANT = "https://news.test/grant", GONE = "https://news.test/gone";
const seed = (overrides = {}) => ({ articles: [
  { url: AWARD, title: "Insurer wins community award", trackerSentiment: overrides.award || "positive", topic: "An award for the insurer", outlet: "Award Daily" },
  { url: RATES, title: "Insurer criticised for higher rates", trackerSentiment: "negative", topic: "Costs blamed on the insurer" },
  { url: GRANT, title: "Health grant supports Vermont clinics", trackerSentiment: "neutral", topic: "A grant" },
  { url: GONE, title: "Hospital merger reviewed", trackerSentiment: "neutral", topic: "A merger" },
] });
// The archive copies the seed URLs are looked up from on every run.
const archive = (extra = {}) => [
  { link: AWARD, snippet: "The award recognised community programs.", sourceName: "Award Daily" },
  { link: RATES, snippet: "Rates rose again this year.", sourceName: "Rate Watch" },
  { link: GRANT, snippet: "A federal grant funds rural clinics.", sourceName: "Clinic Times" },
  { link: GONE, snippet: "Regulators reviewed the merger.", sourceName: "Merger Post" },
];
const story = (index, extra = {}) => ({ title: `Blue Cross VT member support program ${index}`, snippet: "BCBSVT offers member support.",
  link: `https://vtdigger.org/support-${index}`, matchedTerms: ["BCBSVT"], category: "brand", sourceName: "VTDigger",
  pubDate: new Date("2026-09-20T12:00:00Z"), relevant: true, sentiment: "neutral", ...extra });
const answer = { answers: { include: { type: "noul", noul: 0.98 }, scope_brand: { type: "noul", noul: 0.98 },
  scope_regional: { type: "noul", noul: 0.9 }, scope_policy: { type: "noul", noul: 0.8 },
  sentiment: { type: "choice", choice: "positive", confidence: 0.9,
    probabilities: { positive: 0.9, "neutral to positive": 0.04, neutral: 0.04, "neutral to negative": 0.01, negative: 0.01 } } } };

async function harness(profileChanges = {}, { freeze = true } = {}) {
  const alignment = { ...(await loadAlignmentProfile("src/rubrics/editorial-alignment-v2.json")), ...profileChanges };
  const state = { cache: {}, exampleState: {}, storyKeys: [] };
  const requests = [];
  // One ordinary run: the library is rebuilt from the seed and the archive as
  // it stands, exactly as loadReferenceExamples does, and the crawl state is
  // carried from the run before.
  async function run(items, { seedRows = seed(), copies = archive(), maxItems = 50, library } = {}) {
    const metrics = {};
    const before = requests.length;
    await applyJevRelevance(items, { env: {}, mode: "shadow", alignment, maxItems, metrics,
      referenceExamples: library || buildReferenceExamples(seedRows, copies), cache: state.cache,
      exampleState: freeze ? state.exampleState : undefined, storyKeys: state.storyKeys,
      callJev: async (request) => { requests.push(request); return answer; } });
    return { metrics, calls: requests.length - before, sent: requests.slice(before) };
  }
  return { alignment, state, requests, run };
}

test("an example's archive excerpt and outlet change between runs, and the story's cache entry is still a hit", async () => {
  const { run } = await harness();
  const first = await run([story(1)]);
  assert.equal(first.calls, 1);
  const moved = archive();
  moved[0] = { link: AWARD, snippet: "A completely rewritten excerpt about the award ceremony.", sourceName: "Renamed Outlet" };
  const second = await run([story(1)], { copies: moved });
  assert.equal(second.calls, 0);
  assert.equal(second.metrics.cached, 1);
  assert.equal(second.metrics.missReferenceChanged, 0);
  // The metrics show the archive moved and the frozen text absorbed it.
  assert.equal(second.metrics.referenceTextChanged, 1);
  assert.equal(second.metrics.referenceIdHash, first.metrics.referenceIdHash);
  assert.notEqual(second.metrics.referenceLiveTextHash, first.metrics.referenceLiveTextHash);
  assert.equal(second.metrics.referenceFrozenTextHash, first.metrics.referenceFrozenTextHash);
});

test("the id-and-label key alone keeps the entry when reference text changes, with the freeze off", async () => {
  const { run } = await harness({}, { freeze: false });
  await run([story(1)]);
  const moved = archive();
  moved[0] = { link: AWARD, snippet: "A completely rewritten excerpt about the award ceremony.", sourceName: "Renamed Outlet" };
  moved[1] = { link: RATES, snippet: "", sourceName: "" };
  const second = await run([story(1)], { seedRows: { articles: seed().articles.map((row) => ({ ...row, topic: `${row.topic}, reworded` })) }, copies: moved });
  assert.equal(second.calls, 0);
  assert.equal(second.metrics.cached, 1);
});

test("the request Jev receives carries frozen text, and is identical to the live one on the first run", async () => {
  const { run, alignment } = await harness();
  const rubric = await loadRelevanceRubric(), sentimentRubric = await loadSentimentRubric();
  const live = buildReferenceExamples(seed(), archive());
  const first = await run([story(1)]);
  // Freezing changes nothing on the first run: same request as before the fix.
  assert.deepEqual(first.sent[0], buildJevRequest(story(1), rubric, { sentimentRubric, alignment, referenceExamples: live }));
  const moved = archive();
  moved[0] = { link: AWARD, snippet: "A completely rewritten excerpt.", sourceName: "Renamed Outlet" };
  const second = await run([story(1), story(2)], { copies: moved });
  const award = second.sent[0].questions.include.instructions.reference_examples.find((row) => row.article.title === "Insurer wins community award");
  assert.equal(award.article.excerpt, "The award recognised community programs.");
  assert.equal(award.article.outlet, "Award Daily");
});

test("an example leaving the archive keeps its frozen text instead of going blank", async () => {
  const { run } = await harness();
  await run([story(1)]);
  const missing = archive().filter((copy) => copy.link !== RATES);
  const second = await run([story(1), story(2)], { copies: missing });
  const rates = second.sent[0].questions.include.instructions.reference_examples.find((row) => row.article.title === "Insurer criticised for higher rates");
  assert.equal(rates.article.excerpt, "Rates rose again this year.");
  assert.equal(rates.article.outlet, "Rate Watch");
  assert.equal(second.metrics.referenceTextLost, 1);
  // And the first story's answer is untouched.
  assert.equal(second.metrics.cached, 1);
});

test("frozen text keeps retrieval stable when a changed excerpt would have reordered it", async () => {
  // Only one inclusion example is sent, so which one ranks first decides the request.
  const { run } = await harness({ inclusionExamples: 1, sentimentExamples: 1 });
  const target = story(1, { title: "Community award for member support", snippet: "An insurer wins a community award." });
  const first = await run([target]);
  assert.equal(first.sent[0].questions.include.instructions.reference_examples[0].article.title, "Insurer wins community award");
  const moved = archive();
  // Live text that would pull a different example to the top of the ranking.
  moved[2] = { link: GRANT, snippet: "Community award member support insurer wins community award member support", sourceName: "Clinic Times" };
  const second = await run([target], { copies: moved });
  assert.equal(second.calls, 0);
  assert.equal(second.metrics.cached, 1);
});

test("a change to the story's own text still misses", async () => {
  const { run } = await harness();
  await run([story(1)]);
  const title = await run([story(1, { title: "Blue Cross VT changes member support program" })]);
  assert.equal(title.calls, 1);
  assert.equal(title.metrics.missStoryChanged, 1);
  const excerpt = await run([story(1, { title: "Blue Cross VT changes member support program", snippet: "BCBSVT ended the program." })]);
  assert.equal(excerpt.calls, 1);
  assert.equal(excerpt.metrics.missStoryChanged, 1);
});

test("a changed example label, sentiment or include, still misses", async () => {
  const { run } = await harness();
  await run([story(1)]);
  const sentiment = await run([story(1)], { seedRows: seed({ award: "negative" }) });
  assert.equal(sentiment.calls, 1);
  assert.equal(sentiment.metrics.missReferenceChanged, 1);
  const include = await run([story(1)], { library: buildReferenceExamples(seed({ award: "negative" }), archive()).map((row) => row.url === RATES ? { ...row, include: false } : row) });
  assert.equal(include.calls, 1);
  assert.equal(include.metrics.missReferenceChanged, 1);
});

test("metrics classify misses as reference-only, story changed, or never answered", async () => {
  const { run } = await harness();
  // Run one answers two stories and leaves the third waiting on the cap.
  const first = await run([story(1), story(2), story(3)], { maxItems: 2 });
  assert.equal(first.calls, 2);
  assert.equal(first.metrics.missStoryChanged, 3, "every story is new on the first run");
  // Run two: story 1's own text changes, story 2 keeps its text but a reference
  // label changes under it, and story 3 was never answered.
  const second = await run([story(1, { title: "Blue Cross VT reworks member support program 1" }), story(2), story(3)],
    { seedRows: seed({ award: "negative" }), maxItems: 0 });
  assert.equal(second.metrics.missStoryChanged, 1);
  assert.equal(second.metrics.missReferenceChanged, 1);
  assert.equal(second.metrics.missUnanswered, 1);
  assert.equal(second.metrics.missUnclassified, 0);
  assert.equal(second.metrics.cached, 0);
});

test("the library hashes cover the count, and a new example changes them", async () => {
  const { run } = await harness();
  const first = await run([story(1)]);
  assert.equal(first.metrics.referenceCount, 4);
  const more = { articles: [...seed().articles, { url: "https://news.test/new", title: "A new reference", trackerSentiment: "positive" }] };
  const second = await run([story(1)], { seedRows: more });
  assert.equal(second.metrics.referenceCount, 5);
  assert.notEqual(second.metrics.referenceIdHash, first.metrics.referenceIdHash);
});

test("migration: an entry whose old key still matches moves to the new key, and stale ones are not kept", async () => {
  const { run, alignment, state } = await harness();
  const rubric = await loadRelevanceRubric(), sentimentRubric = await loadSentimentRubric();
  const versions = { alignmentVersion: alignment.version, version: rubric.version, sentimentVersion: sentimentRubric.version };
  const legacyEntry = { model: "jev-1.13.0", rubricVersion: rubric.version, alignmentVersion: alignment.version, include: 0.98,
    localAngle: null, relevanceScore: null, sentiment: "positive", sentimentConfidence: 0.9 };
  const live = buildReferenceExamples(seed(), archive());
  const current = story(1), stale = story(2);
  // An entry written by the old code for the current library, and one written
  // when an example's text was different.
  const stalePast = archive();
  stalePast[0] = { link: AWARD, snippet: "Older excerpt.", sourceName: "Award Daily" };
  const oldRequest = (item, library) => buildJevRequest(item, rubric, { sentimentRubric, alignment, referenceExamples: library });
  const matchingKey = legacyJevCacheKey({ ...versions, request: oldRequest(current, live) });
  const staleKey = legacyJevCacheKey({ ...versions, request: oldRequest(stale, buildReferenceExamples(seed(), stalePast)) });
  state.cache[matchingKey] = legacyEntry;
  state.cache[staleKey] = legacyEntry;
  const result = await run([current, stale]);
  assert.equal(result.metrics.keyMigrated, 1);
  assert.equal(result.metrics.cached, 1);
  assert.equal(result.calls, 1, "only the story whose old key no longer matched is asked again");
  assert.equal(result.metrics.missUnclassified, 1);
  assert.equal(state.cache[matchingKey], undefined);
  assert.equal(state.cache[staleKey], undefined);
  assert.equal(Object.keys(state.cache).length, 2);
  assert.ok(Object.values(state.cache).every((entry) => /^[a-f0-9]{12}$/.test(entry.storyKey)));
  // The next run is all hits, with nothing left to migrate.
  const again = await run([current, stale]);
  assert.equal(again.calls, 0);
  assert.equal(again.metrics.keyMigrated, 0);
  assert.equal(again.metrics.cached, 2);
});

test("freezing sets text once, fills a blank later, and never overwrites", () => {
  const id = exampleId(AWARD);
  const state = {};
  const base = { id, include: true, sentiment: "positive", provenance: "human media tracker", title: "Seed title" };
  const blank = freezeReferenceText([{ ...base, excerpt: "", outlet: "" }], state);
  assert.deepEqual(state, {});
  assert.equal(blank.added, 0);
  const first = freezeReferenceText([{ ...base, excerpt: "First excerpt", outlet: "First Outlet" }], state);
  assert.equal(first.added, 1);
  assert.deepEqual(state[id], { excerpt: "First excerpt", outlet: "First Outlet" });
  const later = freezeReferenceText([{ ...base, excerpt: "Second excerpt", outlet: "" }], state);
  assert.equal(later.examples[0].excerpt, "First excerpt");
  assert.equal(later.examples[0].outlet, "First Outlet");
  assert.deepEqual({ changed: later.changed, lost: later.lost }, { changed: 1, lost: 1 });
  assert.deepEqual(state[id], { excerpt: "First excerpt", outlet: "First Outlet" });
  // A seed row's own headline is never frozen, an archive-derived one is.
  assert.equal(state[id].title, undefined);
  const rejection = { ...base, id: exampleId(RATES), include: false, provenance: "human label review", title: "Archive title", excerpt: "", outlet: "" };
  freezeReferenceText([rejection], state);
  const renamed = freezeReferenceText([{ ...rejection, title: "Archive title - Outlet" }], state);
  assert.equal(renamed.examples[0].title, "Archive title");
});

test("the frozen map and story keys are normalized and bounded in crawlState", () => {
  const id = exampleId(AWARD);
  const state = normalizeCrawlState({
    jevExamples: { [id]: { excerpt: "Kept", outlet: "Outlet", extra: "dropped", title: 5 }, "not-an-id": { excerpt: "x" }, [exampleId(RATES)]: "bad" },
    jevStories: ["abcdef012345", "abcdef012345", "short", 7],
  });
  assert.deepEqual(state.jevExamples, { [id]: { excerpt: "Kept", outlet: "Outlet" } });
  assert.deepEqual(state.jevStories, ["abcdef012345"]);
  assert.deepEqual(normalizeCrawlState().jevExamples, {});
  const long = normalizeJevExampleState({ [id]: { excerpt: "x".repeat(2000), outlet: "y".repeat(500) } });
  assert.equal(long[id].excerpt.length, 700);
  assert.equal(long[id].outlet.length, 160);
});

test("chosen rows and request-shaped examples stay the same choice", () => {
  const examples = buildReferenceExamples(seed(), archive());
  const target = story(1);
  for (const task of ["inclusion", "sentiment"]) {
    const rows = chooseReferenceExamples(target, examples, { task, limit: 3 });
    assert.deepEqual(selectReferenceExamples(target, examples, { task, limit: 3 }).map((view) => view.article.title), rows.map((row) => row.title));
  }
});
