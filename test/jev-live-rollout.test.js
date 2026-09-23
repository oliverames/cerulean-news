import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyJevRelevance, jevInclusionReason, normalizeJevBaseline } from "../src/jev-relevance.js";
import { loadAlignmentProfile } from "../src/jev-alignment.js";
import { buildReferenceExamples } from "../src/jev-examples.js";
import { loadPreviousState, mergeWithArchive } from "../src/archive.js";
import { buildJsonSummary } from "../src/outputs.js";

const cutoff = "2026-09-21T18:00:00.000Z";
const now = new Date("2026-09-21T19:00:00Z");
const brand = { title: "Blue Cross VT member support program", snippet: "BCBSVT offers member support.",
  link: "https://vtdigger.org/member-support", matchedTerms: ["BCBSVT"], sourceName: "VTDigger",
  pubDate: new Date("2026-09-20T12:00:00Z"), relevant: true, sentiment: "neutral", sentimentReason: "Existing assessment" };
const references = buildReferenceExamples({ articles: [{ url: "https://example.test/award", title: "Blue Cross community award", trackerSentiment: "positive" }] });
function answer(include = 0.98, confidence = 0.9) {
  return { answers: { include: { type: "noul", noul: include }, scope_brand: { type: "noul", noul: include },
    scope_regional: { type: "noul", noul: include }, scope_policy: { type: "noul", noul: include },
    sentiment: { type: "choice", choice: "positive", confidence,
      probabilities: { positive: 0.9, "neutral to positive": 0.04, neutral: 0.04, "neutral to negative": 0.01, negative: 0.01 } } } };
}

test("live scope protects history, prioritizes new articles, and saves original decisions once", async () => {
  const alignment = await loadAlignmentProfile("src/rubrics/editorial-alignment-v1.json");
  const old = { ...brand, firstSeenAt: new Date("2026-09-20T12:00:00Z") };
  const fresh = { ...brand, link: "https://vtdigger.org/new-program", firstSeenAt: now };
  const missingDate = { ...brand, link: "https://vtdigger.org/missing-discovery" };
  const calls = [], metrics = {}, cache = {};
  const options = { env: {}, mode: "enforce", enforceAfter: cutoff, alignment, referenceExamples: references,
    maxItems: 1, metrics, cache, now, callJev: async request => { calls.push(request); return answer(); } };
  const result = await applyJevRelevance([old, missingDate, fresh], options);
  assert.equal(calls.length, 1);
  assert.equal(result[0], old);
  assert.equal(result[1], missingDate);
  assert.equal(result[2].sentiment, "positive");
  assert.equal(result[2].jevBaseline.sentiment, "neutral");
  assert.equal(result[2].jevBaseline.sentimentReason, "Existing assessment");
  assert.equal(metrics.historicalProtected, 2);
  assert.equal(metrics.enforcementEligible, 1);
  assert.equal(metrics.sentimentApplied, 1);
  assert.equal(metrics.pending, 0);
  const again = await applyJevRelevance(result, options);
  assert.equal(calls.length, 1);
  assert.deepEqual(again[2].jevBaseline, result[2].jevBaseline);
  assert.equal(normalizeJevBaseline({ ...result[2].jevBaseline, secret: "PRIVATE" }).secret, undefined);
});

test("invalid activation dates fail closed and low confidence preserves sentiment", async () => {
  const alignment = await loadAlignmentProfile("src/rubrics/editorial-alignment-v1.json");
  const fresh = { ...brand, firstSeenAt: now };
  for (const enforceAfter of [undefined, "pending", "not-a-date"]) {
    const metrics = {};
    const result = await applyJevRelevance([fresh], { env: {}, mode: "enforce", enforceAfter, alignment,
      referenceExamples: references, metrics, callJev: async () => assert.fail("must not call without valid boundary") });
    assert.equal(result[0], fresh);
    assert.equal(metrics.status, "activation_boundary_unavailable");
  }
  const result = await applyJevRelevance([fresh], { env: {}, mode: "enforce", enforceAfter: cutoff, alignment,
    referenceExamples: references, callJev: async () => answer(0.5, 0.6) });
  assert.equal(result[0], fresh);
});

test("dated history stays before activation across audit migrations and rediscovery", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jev-live-history-"));
  const filename = path.join(directory, "feed-audit.json");
  const previousRun = "2026-09-21T17:00:00.000Z";
  try {
    await writeFile(filename, JSON.stringify({ generatedAt: previousRun, items: [brand] }));
    for (let pass = 0; pass < 2; pass++) {
      const { archivedItems } = await loadPreviousState(filename);
      assert.equal(archivedItems[0].firstSeenAt.toISOString(), previousRun);
      const merged = mergeWithArchive([{ ...brand, firstSeenAt: now }], archivedItems, now);
      const [kept] = await applyJevRelevance(merged, { env: {}, mode: "enforce", enforceAfter: cutoff,
        callJev: async () => assert.fail("history must never be enforced") });
      assert.equal(kept.sentiment, "neutral");
      const audit = buildJsonSummary([kept], [], now, { includeRejected: true });
      await writeFile(filename, JSON.stringify(audit));
      assert.equal(audit.items[0].firstSeenAt, previousRun);
      assert.equal(buildJsonSummary([kept], [], now).items[0].firstSeenAt, undefined);
    }
    const saved = { ...brand, firstSeenAt: now, jevBaseline: { capturedAt: now.toISOString(), relevant: true,
      reason: "Original inclusion", sentiment: "neutral", sentimentReason: "Original score" } };
    await writeFile(filename, JSON.stringify(buildJsonSummary([saved], [], now, { includeRejected: true })));
    const loaded = await loadPreviousState(filename);
    assert.deepEqual(loaded.archivedItems[0].jevBaseline, saved.jevBaseline);
    assert.deepEqual(mergeWithArchive([brand], loaded.archivedItems, now)[0].jevBaseline, saved.jevBaseline);
    const published = buildJsonSummary([saved], [], now);
    assert.equal(published.items[0].jevBaseline, undefined);
    assert.doesNotMatch(JSON.stringify(published), /Original inclusion|Original score/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an added article's note gives its subject and the scope it fits", async () => {
  const alignment = await loadAlignmentProfile("src/rubrics/editorial-alignment-v1.json");
  const national = { title: "Trump administration to remove 760,000 Affordable Care Act enrollees over fraud claims",
    snippet: "Officials allege 760,000 marketplace enrollees were fraudulently enrolled.", link: "https://www.npr.org/aca-fraud",
    matchedTerms: ["ACA & marketplace"], sourceName: "NPR Health", pubDate: now, firstSeenAt: now,
    relevant: false, reason: "National ACA enrollment changes" };
  const scoped = { answers: { include: { type: "noul", noul: 0.93 }, scope_brand: { type: "noul", noul: 0.02 },
    scope_regional: { type: "noul", noul: 0.1 }, scope_policy: { type: "noul", noul: 0.93 } } };
  const expected = "National ACA enrollment changes. Fits U.S. health coverage, insurance, or policy news (93% confidence).";
  const cache = {};
  let calls = 0;
  const options = { env: {}, mode: "enforce", enforceAfter: cutoff, alignment, referenceExamples: references,
    cache, now, callJev: async () => { calls += 1; return scoped; } };
  const [added] = await applyJevRelevance([national], options);
  assert.equal(added.relevant, true);
  assert.equal(added.reason, expected);
  assert.doesNotMatch(added.reason, /Jev/);
  assert.equal(added.jevBaseline.reason, "National ACA enrollment changes");
  const [again] = await applyJevRelevance([added], options);
  assert.equal(calls, 1);
  assert.equal(again.reason, expected);

  // A note written in an earlier format, from a cache entry saved before
  // scope scores were kept: one request backfills the scores, the note is
  // rebuilt, and a later run needs no request.
  const legacy = { ...added, reason: "Federal action. Jev added it after the first review left it out." };
  for (const entry of Object.values(cache)) delete entry.scopeSignals;
  const metrics = {};
  const drifted = { answers: { ...scoped.answers, include: { type: "noul", noul: 0.1 } } };
  const [rebuilt] = await applyJevRelevance([legacy], { ...options, metrics, callJev: async () => { calls += 1; return drifted; } });
  assert.equal(calls, 2);
  assert.equal(metrics.scopeBackfilled, 1);
  assert.equal(metrics.scopeBackfillPending, 0);
  assert.equal(rebuilt.relevant, true, "a backfill never changes the published decision");
  assert.equal(rebuilt.reason, expected);
  await applyJevRelevance([rebuilt], options);
  assert.equal(calls, 2);
});

test("a first-review line that states a rejection never leads an inclusion note", () => {
  const policy = { scope_brand: 0.1, scope_regional: 0.2, scope_policy: 0.88 };
  assert.equal(jevInclusionReason("New Hampshire mental health grant, not Vermont.", policy),
    "Fits U.S. health coverage, insurance, or policy news (88% confidence).");
  assert.equal(jevInclusionReason("Mentions Blue Cross, but content is generic.", policy).startsWith("Fits"), true);
  assert.equal(jevInclusionReason("Medicaid enrollment issues in Ohio", { scope_regional: 0.4 }),
    "Medicaid enrollment issues in Ohio.");
  assert.equal(jevInclusionReason("Jev judged this relevant to Vermont health care coverage.", undefined),
    "Fits the feed's editorial scope.");
});
