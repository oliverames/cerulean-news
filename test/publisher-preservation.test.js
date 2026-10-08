import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyPublisherPreservation } from "../scripts/verify-publisher-preservation.js";
import { buildRepairContext, freezeRepairManifest } from "../scripts/sentiment-repair.js";
import { buildJsonSummary } from "../src/outputs.js";
import { loadAlignmentProfile } from "../src/jev-alignment.js";
import { sentimentScoreFromProbabilities } from "../src/jev-relevance.js";

async function fixture() {
  const siteDir = await mkdtemp(path.join(tmpdir(), "publisher-preservation-fixture-"));
  const now = new Date("2026-10-08T20:00:00Z");
  const probabilities = { positive: 0.8, "neutral to positive": 0.1, neutral: 0.1, "neutral to negative": 0, negative: 0 };
  const item = { title: "Blue Cross Vermont coverage update", link: "https://example.com/story", sourceName: "Media Tracker Backfill", fromMediaTracker: true,
    trackerOutlet: "Recorded Local Outlet", matchedTerms: ["Blue Cross and Blue Shield of Vermont"], pubDate: now, firstSeenAt: now,
    snippet: "Blue Cross and Blue Shield of Vermont provides coverage.", summary: "Coverage update.", relevant: true,
    sentiment: "positive", sentimentReason: "", sentimentScore: sentimentScoreFromProbabilities(probabilities) };
  const audit = buildJsonSummary([item], [], now, { includeRejected: true, crawlState: { jevCache: {} } });
  const contextOptions = { env: {}, alignment: await loadAlignmentProfile("src/rubrics/editorial-alignment-v2.json"), referenceExamples: [{ id: "c".repeat(64), url: "https://example.com/reference", title: "Other Blue Cross Vermont coverage", outlet: "Reference Outlet", excerpt: "Blue Cross and Blue Shield of Vermont coverage.", context: "Human editorial fixture", include: true, sentiment: "positive", provenance: "human media tracker" }] };
  const auditPath = path.join(siteDir, "feed-audit.json");
  await writeFile(auditPath, JSON.stringify(audit));
  const context = await buildRepairContext({ auditPath, ...contextOptions });
  const savedManifest = freezeRepairManifest(context, { expectedPending: 1, now });
  const target = savedManifest.targets[0];
  const result = { sentiment: "positive", sentimentConfidence: 0.9, sentimentProbabilities: probabilities };
  const checkpoint = { entries: { [target.key]: { status: "succeeded", requestHash: target.requestHash, result } } };
  // Deliberately reverse property order to reproduce the old hash-order bug.
  audit.crawlState.jevCache[target.key] = { sentimentRequestHash: target.requestHash, ...result, sentimentOnly: true, relevanceScore: null, localAngle: null, include: null,
    rubricVersion: target.rubricVersion, model: "jev-1.13.0", storyKey: target.storyKey };
  await writeFile(auditPath, JSON.stringify(audit));
  await writeFile(path.join(siteDir, "feed.json"), JSON.stringify(buildJsonSummary([item], [], now)));
  return { siteDir, savedManifest, checkpoint, contextOptions, expectedCount: 1, audit, auditPath };
}

test("actual generator preserves exact saved sentiment and typed cache despite property reordering", async () => {
  const data = await fixture();
  try {
    const receipt = await verifyPublisherPreservation(data);
    assert.equal(receipt.generatorExecuted, true);
    assert.equal(receipt.providerRequests, 0);
    assert.equal(receipt.blockedFetches, 0);
    assert.equal(receipt.preservedCacheEntries, 1);
    assert.equal(receipt.exactSentimentContextsPreserved, 1);
  } finally { await rm(data.siteDir, { recursive: true, force: true }); }
});

test("proof rejects a cache key with wrong saved response provenance", async () => {
  const data = await fixture();
  try {
    data.audit.crawlState.jevCache[data.savedManifest.targets[0].key].sentimentRequestHash = "d".repeat(64);
    await writeFile(data.auditPath, JSON.stringify(data.audit));
    await assert.rejects(verifyPublisherPreservation(data), /publisher_saved_evidence_missing_or_mismatched/);
  } finally { await rm(data.siteDir, { recursive: true, force: true }); }
});

test("proof rejects incomplete preservation rather than reporting a smaller count as success", async () => {
  const data = await fixture();
  try {
    await assert.rejects(verifyPublisherPreservation({ ...data, expectedCount: 2 }), /publisher_saved_evidence_missing_or_mismatched/);
  } finally { await rm(data.siteDir, { recursive: true, force: true }); }
});
