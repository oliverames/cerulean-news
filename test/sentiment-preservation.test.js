import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPreviousState } from "../src/archive.js";
import { buildJsonSummary } from "../src/outputs.js";
import { applyJevRelevance, buildJevRequest, loadRelevanceRubric, loadSentimentRubric, sentimentScoreFromProbabilities } from "../src/jev-relevance.js";
import { jevCacheKey, jevStoryKey, sentimentRequestHash, shortKey } from "../src/jev-cache-keys.js";

const now = new Date("2026-10-08T20:00:00Z");
const rubric = await loadRelevanceRubric({ env: {} });
const sentimentRubric = await loadSentimentRubric();
const odds = { positive: 0.8, "neutral to positive": 0.1, neutral: 0.1, "neutral to negative": 0, negative: 0 };
function article(extra = {}) {
  return { title: "Blue Cross Vermont health coverage news", link: "https://example.com/coverage", sourceName: "Media Tracker Backfill", fromMediaTracker: true,
    trackerOutlet: "Recorded Local Outlet", pubDate: now, firstSeenAt: now, matchedTerms: ["Blue Cross and Blue Shield of Vermont"], category: "Blue Cross VT",
    snippet: "Blue Cross and Blue Shield of Vermont discusses health coverage.", summary: "Coverage update.", relevant: true, sentiment: "neutral", sentimentReason: "Earlier assessment", ...extra };
}
function request(item, activeRubric = rubric, activeSentimentRubric = sentimentRubric) {
  return buildJevRequest(item, activeRubric, { sentimentRubric: activeSentimentRubric });
}
function identity(body, activeRubric = rubric, activeSentimentRubric = sentimentRubric) {
  const story = jevStoryKey({ version: activeRubric.version, sentimentVersion: activeSentimentRubric.version, request: body });
  return { key: jevCacheKey(story, null), storyKey: shortKey(story) };
}
function evidence(body, extra = {}) {
  return { model: rubric.model, rubricVersion: rubric.version, storyKey: identity(body).storyKey,
    include: null, localAngle: null, relevanceScore: null, sentimentOnly: true,
    sentiment: "positive", sentimentConfidence: 0.9, sentimentProbabilities: { ...odds }, sentimentRequestHash: sentimentRequestHash(body), ...extra };
}
async function run(t, item, cache, options = {}) {
  // No credential, CLI or injected caller is configured. Catch any unexpected
  // fetch before it leaves the process, rather than relying on host secrets.
  const network = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected network in hermetic preservation test"); });
  try {
    const result = await applyJevRelevance([item], { env: { JEV_RELEVANCE: "enforce" }, rubric, sentimentRubric, cache, now, ...options });
    assert.equal(network.mock.callCount(), 0);
    return result[0];
  } finally { network.mock.restore(); }
}

test("audit roundtrip retains the tracker outlet and exact request identity", async () => {
  const item = article();
  const audit = buildJsonSummary([item], [], now, { includeRejected: true, crawlState: {} });
  assert.equal(audit.items[0].trackerOutlet, item.trackerOutlet);
  const dir = await mkdtemp(path.join(tmpdir(), "sentiment-preservation-"));
  try {
    const filename = path.join(dir, "feed-audit.json");
    await writeFile(filename, JSON.stringify(audit));
    const restored = await loadPreviousState(filename);
    assert.equal(restored.archivedItems[0].trackerOutlet, item.trackerOutlet);
    assert.equal(restored.cache.get(item.link).trackerOutlet, item.trackerOutlet);
    assert.equal(sentimentRequestHash(request(restored.archivedItems[0])), sentimentRequestHash(request(item)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("legacy tracker audit restores its published outlet when trackerOutlet is absent", async () => {
  const audit = buildJsonSummary([article()], [], now, { includeRejected: true, crawlState: {} });
  delete audit.items[0].trackerOutlet;
  const dir = await mkdtemp(path.join(tmpdir(), "sentiment-preservation-"));
  try {
    const filename = path.join(dir, "feed-audit.json");
    await writeFile(filename, JSON.stringify(audit));
    const restored = await loadPreviousState(filename);
    assert.equal(restored.archivedItems[0].trackerOutlet, audit.items[0].outlet);
    assert.equal(restored.cache.get(article().link).trackerOutlet, audit.items[0].outlet);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("inactive valid sentiment cache entries remain durable", async (t) => {
  const older = article({ link: "https://example.com/older", title: "Earlier Blue Cross Vermont coverage" });
  const body = request(older), key = identity(body).key;
  const cache = { [key]: evidence(body) };
  const before = structuredClone(cache[key]);
  await run(t, article(), cache);
  assert.deepEqual(cache[key], before);
});

test("matching sentiment body survives changed inclusion key without migrating inclusion authority", async (t) => {
  const item = article({ fromMediaTracker: false, trackerOutlet: undefined });
  const oldRubric = structuredClone(rubric);
  oldRubric.questions.include.instructions = { previous: "Earlier inclusion instructions" };
  const oldBody = request(item, oldRubric), currentBody = request(item);
  assert.notEqual(identity(oldBody).key, identity(currentBody).key);
  assert.equal(sentimentRequestHash(oldBody), sentimentRequestHash(currentBody));
  const key = identity(oldBody).key;
  const cache = { [key]: evidence(oldBody, { include: 0, sentimentOnly: undefined, localAngle: 0, relevanceScore: 0 }) };
  const result = await run(t, item, cache);
  assert.equal(result.sentiment, "positive");
  assert.equal(result.sentimentScore, sentimentScoreFromProbabilities(odds));
  assert.equal(result.relevant, true);
  assert.equal(result.jevRelevance, undefined);
  assert.equal(cache[identity(currentBody).key], undefined);
  assert.equal(cache[key].include, 0);
});

test("changed outlet or selected sentiment reference text cannot reuse stale odds", async (t) => {
  for (const change of ["outlet", "reference"]) {
    const item = article();
    const currentBody = request(item);
    const oldBody = structuredClone(currentBody);
    if (change === "outlet") oldBody.state.article.outlet = "Different Recorded Outlet";
    else oldBody.questions.sentiment.instructions.reference_examples = [{ id: "private-fixture", excerpt: "Different selected reference text" }];
    assert.notEqual(sentimentRequestHash(oldBody), sentimentRequestHash(currentBody));
    const key = identity(oldBody).key;
    const cache = { [key]: evidence(oldBody) };
    const result = await run(t, item, cache);
    assert.equal(result.sentiment, "neutral", change);
    assert.equal(result.sentimentScore, undefined, change);
    assert.ok(cache[key], change);
  }
});

test("inclusion-only legacy cache does not erase an existing same-label score", async (t) => {
  const item = article({ sentimentScore: 83 });
  const body = request(item), key = identity(body).key;
  const cache = { [key]: { model: rubric.model, rubricVersion: rubric.version, storyKey: identity(body).storyKey, include: 1, localAngle: 0.8, relevanceScore: 8, sentiment: null, sentimentConfidence: null } };
  const result = await run(t, item, cache);
  assert.equal(result.sentiment, item.sentiment);
  assert.equal(result.sentimentScore, 83);
});

test("a human sentiment correction outranks matching saved model evidence", async (t) => {
  const item = article({ sentiment: "negative", feedbackSentiment: true, sentimentScore: 83 });
  const body = request(item), key = identity(body).key;
  const result = await run(t, item, { [key]: evidence(body) });
  assert.equal(result.sentiment, "negative");
  assert.equal(result.sentimentScore, undefined);
});

test("conflicting historical answers for one sentiment body do not choose an arbitrary result", async (t) => {
  const item = article(), body = request(item);
  const cache = { ["a".repeat(64)]: evidence(body), ["b".repeat(64)]: evidence(body, { sentiment: "negative", sentimentProbabilities: { positive: 0, "neutral to positive": 0, neutral: 0.1, "neutral to negative": 0.1, negative: 0.8 } }) };
  const result = await run(t, item, cache);
  assert.equal(result.sentiment, item.sentiment);
  assert.equal(result.sentimentScore, undefined);
  assert.equal(Object.keys(cache).length, 2);
});
