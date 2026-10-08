import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildRepairContext, freezeRepairManifest, executeRepairBatch, hash, REPAIR_MODEL } from "../scripts/sentiment-repair.js";
import { reconcileSavedSentiment } from "../scripts/reconcile-saved-sentiment.js";
import { validatePublicationAudit } from "../scripts/publish-sentiment-repair.js";

const references = [{ id: "e".repeat(64), url: "https://example.test/reference", title: "Community award", outlet: "Reference outlet", excerpt: "Reference excerpt", context: "PRIVATE_EDITORIAL_SENTINEL", include: true, sentiment: "positive", provenance: "human media tracker" }];
const article = name => ({ title: `Blue Cross Vermont coverage ${name}`, sourceName: "VTDigger", sourceFeedUrl: "https://vtdigger.org/feed/", link: `https://vtdigger.org/${name}`, guid: `https://vtdigger.org/${name}`, pubDate: "2026-10-01T00:00:00.000Z", firstSeenAt: "2026-09-01T00:00:00.000Z", matchedTerms: ["Blue Cross"], category: "Brand", snippet: "Blue Cross Vermont sponsored a community event.", summary: "Saved summary", relevant: true, reason: "Saved inclusion", sentiment: "neutral", sentimentReason: "Saved reason", sentimentScore: 50 });
const response = () => ({ model: REPAIR_MODEL, answers: { sentiment: { type: "choice", choice: "positive", confidence: 0.8, probabilities: { positive: 0.8, "neutral to positive": 0.1, neutral: 0.05, "neutral to negative": 0.03, negative: 0.02 } } }, usage: { input_tokens: 100, output_tokens: 20 } });
async function fixture(t, count = 1, batchSize = count) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "saved-sentiment-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditPath = path.join(directory, "audit.json");
  const audit = { generatedAt: "2026-10-08T13:36:49.427Z", items: Array.from({ length: count }, (_, i) => article(`story-${i}`)), totalItemCount: count, sources: [], crawlMetrics: {}, crawlState: { jevCache: {}, jevExamples: {}, feedback: { applied: {} }, articleCache: { preserved: true }, monthlyReports: {} } };
  const contextFor = async (value, refs = references) => {
    await writeFile(auditPath, JSON.stringify(value));
    return buildRepairContext({ auditPath, env: {}, referenceExamples: refs });
  };
  const original = await contextFor(audit), manifest = freezeRepairManifest(original);
  const checkpoint = await executeRepairBatch(original, manifest, { batchSize, persist: async () => {}, post: async () => response() });
  return { audit, manifest, checkpoint, contextFor };
}

test("saved exact responses restore fields without replacing newer archive content or invoking providers", async t => {
  const f = await fixture(t);
  const current = structuredClone(f.audit);
  current.generatedAt = "2026-10-08T22:00:00.000Z";
  current.items.push(article("newer"));
  current.totalItemCount++;
  current.items[0].summary = "Newer legitimate summary";
  current.items[0].reason = "Newer inclusion decision";
  current.crawlMetrics = { latest: 123 };
  const context = await f.contextFor(current);
  const result = reconcileSavedSentiment({ ...f, currentContext: context });
  assert.equal(result.receipt.providerRequests, 0);
  assert.equal(result.receipt.exactContexts, 1);
  assert.equal(result.updated.items[0].sentiment, "positive");
  assert.equal(result.updated.items[0].sentimentReason, "");
  assert.deepEqual(result.updated.items[1], current.items[1]);
  assert.equal(result.updated.items[0].summary, "Newer legitimate summary");
  assert.equal(result.updated.items[0].reason, "Newer inclusion decision");
  assert.equal(result.updated.generatedAt, current.generatedAt);
  assert.deepEqual(result.updated.crawlMetrics, current.crawlMetrics);
  assert.deepEqual(context.audit, current, "input is immutable");
  validatePublicationAudit(current, result.updated, result.manifest);
  assert.ok(!JSON.stringify(result.manifest).includes("PRIVATE_EDITORIAL_SENTINEL"));
});

test("changed outlet or reference context preserves typed historical evidence without rewriting articles", async t => {
  const f = await fixture(t);
  for (const change of ["outlet", "reference"]) {
    const current = structuredClone(f.audit);
    if (change === "outlet") {
      current.items[0].sourceName = "New outlet";
      current.items[0].outlet = "New outlet";
      current.items[0].trackerOutlet = "New outlet";
      current.items[0].sourceFeedUrl = "https://new-outlet.test/feed/";
    }
    const refs = change === "reference" ? [{ ...references[0], context: "Changed private editorial judgment" }] : references;
    const result = reconcileSavedSentiment({ ...f, currentContext: await f.contextFor(current, refs) });
    assert.equal(result.receipt.historicalOnly, 1);
    assert.equal(result.manifest.targets[0].historicalOnly, true);
    assert.deepEqual(result.updated.items, current.items);
    const saved = result.updated.crawlState.jevCache[f.manifest.targets[0].key];
    assert.equal(saved.sentiment, "positive");
    assert.equal(saved.sentimentRequestHash, f.manifest.targets[0].requestHash);
    validatePublicationAudit(current, result.updated, result.manifest);
    const invalid = structuredClone(result.updated);
    invalid.items[0].sentiment = "positive";
    assert.throws(() => validatePublicationAudit(current, invalid, result.manifest), /historical-only/);
  }
});

test("human sentiment protection retains saved evidence while preserving the human article", async t => {
  const f = await fixture(t);
  const context = await f.contextFor(f.audit);
  context.entries[0].item.feedbackSentiment = true;
  const result = reconcileSavedSentiment({ ...f, currentContext: context });
  assert.equal(result.receipt.historicalOnly, 1);
  assert.deepEqual(result.updated.items, f.audit.items);
  assert.equal(result.manifest.targets[0].aliases[0].feedbackSentiment, true);
  validatePublicationAudit(f.audit, result.updated, result.manifest);
});

test("newer conflicting cache evidence and failed or untouched targets remain unchanged", async t => {
  const f = await fixture(t, 3, 1);
  const failed = f.manifest.targets[1];
  f.checkpoint.entries[failed.key] = { status: "failed", requestHash: failed.requestHash, error: "malformed_sentiment_response" };
  const current = structuredClone(f.audit);
  current.crawlState.jevCache[f.manifest.targets[0].key] = { ...f.checkpoint.entries[f.manifest.targets[0].key].result, sentimentRequestHash: "f".repeat(64), storyKey: f.manifest.targets[0].storyKey, model: REPAIR_MODEL, rubricVersion: "relevance-v2", include: 1, localAngle: 1, relevanceScore: 9 };
  const result = reconcileSavedSentiment({ ...f, currentContext: await f.contextFor(current) });
  assert.deepEqual(result.updated, current);
  assert.equal(result.receipt.decisions[0].status, "newer_cache_conflict");
  assert.equal(result.receipt.restoredEvidence, 0);
  validatePublicationAudit(current, result.updated, result.manifest);
});

test("invalid manifest hashes, checkpoint ownership and malformed saved distributions fail closed", async t => {
  const f = await fixture(t), currentContext = await f.contextFor(f.audit);
  const badManifest = structuredClone(f.manifest);
  badManifest.targets[0].requestHash = "a".repeat(64);
  assert.throws(() => reconcileSavedSentiment({ ...f, manifest: badManifest, currentContext }), /invalid_saved_manifest/);
  for (const mutate of [cp => { cp.manifestHash = "a".repeat(64); }, cp => { Object.values(cp.entries)[0].requestHash = "a".repeat(64); }, cp => { Object.values(cp.entries)[0].result.sentimentProbabilities.negative = 1; }]) {
    const checkpoint = structuredClone(f.checkpoint);
    mutate(checkpoint);
    assert.throws(() => reconcileSavedSentiment({ ...f, checkpoint, currentContext }), /invalid_checkpoint|malformed_sentiment_response/);
  }
});

test("missing all or some frozen aliases retains historical evidence without restoring removed archive members", async t => {
  const f = await fixture(t);
  const original = structuredClone(f.audit);
  original.items.push({ ...original.items[0], link: `${original.items[0].link}?utm_source=email`, guid: `${original.items[0].guid}?utm_source=email` });
  original.totalItemCount++;
  const originalContext = await f.contextFor(original);
  const manifest = freezeRepairManifest(originalContext);
  assert.equal(manifest.targets.length, 1);
  assert.equal(manifest.targets[0].aliases.length, 2);
  const checkpoint = await executeRepairBatch(originalContext, manifest, { persist: async () => {}, post: async () => response() });
  for (const keep of [0, 1]) {
    const current = structuredClone(original);
    current.items = [...current.items.slice(0, keep), article("newer-only")];
    current.totalItemCount = current.items.length;
    const result = reconcileSavedSentiment({ manifest, checkpoint, currentContext: await f.contextFor(current) });
    assert.equal(result.receipt.restoredEvidence, 1);
    assert.equal(result.receipt.historicalOnly, 1);
    assert.equal(result.receipt.missingAliasContexts, 1);
    assert.equal(result.receipt.decisions[0].status, "historical_only_missing_aliases");
    assert.equal(result.receipt.decisions[0].missingAliases, 2 - keep);
    assert.deepEqual(result.updated.items, current.items);
    assert.equal(result.manifest.targets[0].aliases.length, keep);
    assert.equal(result.updated.crawlState.jevCache[manifest.targets[0].key].sentimentRequestHash, manifest.targets[0].requestHash);
    validatePublicationAudit(current, result.updated, result.manifest);
    if (!keep) {
      const unsafe = structuredClone(result.manifest);
      unsafe.targets[0].historicalOnly = false;
      const { manifestHash, ...contents } = unsafe;
      unsafe.manifestHash = hash(contents);
      assert.throws(() => validatePublicationAudit(current, result.updated, unsafe), /target aliases/);
    }
  }
});
