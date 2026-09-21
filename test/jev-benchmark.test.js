import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateArchive, sentimentAgreement } from "../src/jev-benchmark.js";
import { buildJevRequest, loadRelevanceRubric, loadSentimentRubric } from "../src/jev-relevance.js";
import { INCLUSION_PRIORITIES, INCLUSION_RULES, SENTIMENT_VALUES } from "../src/summaries.js";
const item = { title: "Blue Cross VT community award", snippet: "The health plan won a community award.",
  link: "https://vtdigger.org/award", sourceName: "VTDigger", matchedTerms: ["BCBSVT"], category: "brand",
  relevant: true, sentiment: "neutral", reason: "PRIVATE BASELINE REASON", sentimentReason: "PRIVATE SCORING REASON" };
function response(include = 0.99) {
  return { model: "jev-1.13.0", answers: { include: { type: "noul", noul: include },
    local_angle: { type: "noul", noul: 0.9 }, relevance: { type: "score", score: 5 },
    sentiment: { type: "choice", choice: "positive", confidence: 0.9,
      probabilities: Object.fromEntries(SENTIMENT_VALUES.map((label) => [label, label === "positive" ? 1 : 0])) } } };
}

test("v2 shares existing policy and adds trusted evidence without baseline judgments", async () => {
  const rubric = await loadRelevanceRubric(), sentimentRubric = await loadSentimentRubric();
  assert.equal(rubric.questions.include.instructions.priorities, INCLUSION_PRIORITIES);
  assert.equal(rubric.questions.include.instructions.rules, INCLUSION_RULES);
  const request = buildJevRequest({ ...item, fromMediaTracker: true, expectedSentiment: "PRIVATE HUMAN LABEL" }, rubric, { sentimentRubric });
  assert.equal(request.state.article.outlet, "VTDigger");
  assert.equal(request.state.article.eligibleBcbsVtSentiment, true);
  assert.equal(request.state.article.curatedInclusion, true);
  assert.equal(request.state.article.excerptSource, "source snippet");
  assert.deepEqual(request.state.article.matchedKeywords, ["BCBSVT"]);
  assert.doesNotMatch(JSON.stringify(request), /PRIVATE/);
  assert.equal(request.state.article.sentiment, undefined);
  assert.equal(request.state.article.relevant, undefined);
});

test("offline run accounts for skips, deduplicates calls, resumes, and rejects changed inputs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jev-benchmark-"));
  const snapshot = { generatedAt: "2026-09-21", items: [item, { ...item, link: "https://vtdigger.org/award-copy", relevant: false },
    { ...item, title: "Nurse job opening", link: "https://indeed.com/viewjob?jk=2" }] };
  const holdout = { rows: [{ url: item.link, expectedSentiment: "positive", isCleanHoldout: true, humanLabelsConflict: false }] };
  let calls = 0;
  try {
    const options = { snapshot, holdout, outputDirectory: directory, callJev: async (request) => {
      calls++;
      assert.doesNotMatch(JSON.stringify(request), /PRIVATE|expectedSentiment|isCleanHoldout/);
      return response(0.5);
    } };
    const first = await evaluateArchive(options);
    assert.equal(calls, 1);
    assert.equal(first.summary.total, 3);
    assert.equal(first.summary.candidates, 2);
    assert.equal(first.rows[0].jevRelevant, true);
    assert.equal(first.rows[1].jevRelevant, false);
    assert.equal(first.summary.human.cleanHoldout.jev.exact, 1);
    assert.equal(first.summary.human.cleanHoldout.baseline.exact, 0);
    const second = await evaluateArchive(options);
    assert.equal(calls, 1);
    assert.deepEqual(second.summary, first.summary);
    await assert.rejects(evaluateArchive({ ...options, snapshot: { ...snapshot, generatedAt: "different" } }), /inputs changed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("failed answers retry and cannot simulate live selection changes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jev-benchmark-failure-"));
  try {
    const options = { snapshot: { items: [item] }, outputDirectory: directory };
    const failed = await evaluateArchive({ ...options, callJev: async () => {
      const result = response(0.01); delete result.answers.sentiment; return result;
    } });
    assert.equal(failed.summary.failed, 1);
    assert.equal(failed.rows[0].jevRelevant, true);
    const retry = await evaluateArchive({ ...options, callJev: async () => response() });
    assert.equal(retry.requested, 1);
    assert.equal(retry.summary.failed, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("sentiment metrics expose missing scores, distance, confidence, and bias", () => {
  const rows = [
    { sentimentEligible: true, expectedSentiment: "positive", jevSentiment: "neutral", sentimentConfidence: 0.9 },
    { sentimentEligible: true, expectedSentiment: "negative", jevSentiment: "neutral to negative", sentimentConfidence: 0.5 },
    { sentimentEligible: true, expectedSentiment: "positive", jevSentiment: null },
  ];
  const metrics = sentimentAgreement(rows, "jevSentiment");
  assert.equal(metrics.eligible, 3); assert.equal(metrics.scored, 2);
  assert.equal(metrics.exact, 0); assert.equal(metrics.withinOne, 1);
  assert.equal(metrics.meanAbsoluteDistance, 1.5); assert.equal(metrics.meanFavorableBias, -0.5);
  assert.equal(sentimentAgreement(rows, "jevSentiment", { confidentOnly: true }).scored, 1);
});
