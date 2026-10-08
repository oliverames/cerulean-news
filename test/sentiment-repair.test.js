import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exampleId } from "../src/jev-examples.js";
import { applyRepairCheckpoint, buildRepairContext, executeRepairBatch, freezeRepairManifest, hash,
  normalizeUsageReceipt, parseRepairResponse, postRepairRequest, REPAIR_MODEL, validateRepairManifest, writeJsonAtomic } from "../scripts/sentiment-repair.js";

const probabilities = { positive: 0.8, "neutral to positive": 0.1, neutral: 0.05, "neutral to negative": 0.03, negative: 0.02 };
const response = (changes = {}) => ({ model: REPAIR_MODEL, answers: { sentiment: { type: "choice", choice: "positive", confidence: 0.8, probabilities } },
  usage: { input_tokens: 100, output_tokens: 20 }, ...changes });
const brand = (suffix, changes = {}) => ({ title: `Blue Cross Vermont coverage ${suffix}`, sourceName: "VTDigger", sourceFeedUrl: "https://vtdigger.org/feed/",
  link: `https://vtdigger.org/${suffix}`, guid: `https://vtdigger.org/${suffix}`, pubDate: "2026-10-01T00:00:00.000Z",
  firstSeenAt: "2026-09-01T00:00:00.000Z", matchedTerms: ["Blue Cross"], category: "Brand", snippet: "Blue Cross Vermont sponsored a community event.",
  summary: "Saved article summary.", relevant: true, reason: "Saved inclusion reason.", sentiment: "neutral", sentimentReason: "Saved tone note.",
  sentimentScore: 50, ...changes });
const references = [{ id: "e".repeat(64), url: "https://example.test/human-reference", title: "A Blue Cross community award", outlet: "Reference outlet",
  excerpt: "Reference excerpt.", context: "PRIVATE_EDITORIAL_REFERENCE_SENTINEL", include: true, sentiment: "positive", provenance: "human media tracker" }];

async function fixture(t, items = [brand("one")], extra = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sentiment-repair-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auditPath = path.join(directory, "audit.json");
  const audit = { generatedAt: "2026-10-08T13:36:49.427Z", items, totalItemCount: items.length, sources: [{ name: "VTDigger", status: "ok" }],
    crawlMetrics: { jev: { sentimentBackfillPending: 67 } },
    crawlState: { jevCache: { ["f".repeat(64)]: { unrelated: "must remain byte-for-byte in JSON" } }, jevExamples: {}, jevStories: ["a".repeat(12)],
      feedback: { applied: {} }, articleCache: { sentinel: { unrelated: true } }, monthlyReports: { sentinel: true } }, ...extra };
  await writeFile(auditPath, JSON.stringify(audit));
  const makeContext = () => buildRepairContext({ auditPath, env: {}, referenceExamples: references });
  const context = await makeContext();
  return { auditPath, audit, context, makeContext, directory, manifest: freezeRepairManifest(context, { now: new Date("2026-10-08T17:00:00Z") }) };
}

test("manifest freezes the actual unique odds queue without inference or leaking private context", async t => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Network must not be used during manifest creation"); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const f = await fixture(t, [brand("one"), brand("alias", { title: brand("one").title }),
    brand("topic", { category: "Topic", matchedTerms: ["health care"] })]);
  assert.equal(f.manifest.targetCount, 1);
  assert.equal(f.manifest.aliasCount, 2);
  assert.equal(f.manifest.priorReportedPending, 67);
  assert.equal(f.manifest.status, "frozen");
  assert.deepEqual(f.manifest.questionKeys, ["sentiment"]);
  const serialized = JSON.stringify(f.manifest);
  assert.ok(!serialized.includes("PRIVATE_EDITORIAL_REFERENCE_SENTINEL"));
  assert.ok(!serialized.includes("https://vtdigger.org/one"));
  assert.ok(!serialized.includes("Saved article summary"));
  const [entry] = validateRepairManifest(f.context, f.manifest);
  const sent = JSON.parse(entry.body);
  assert.deepEqual(Object.keys(sent.questions), ["sentiment"]);
  assert.ok(sent.questions.sentiment.instructions.reference_examples.some(row => row.article.editorialContext.includes("PRIVATE_EDITORIAL_REFERENCE_SENTINEL")));
  assert.equal(hash(entry.body), f.manifest.targets[0].requestHash);
  assert.equal(hash(JSON.stringify(entry.request)), f.manifest.targets[0].canonicalRequestHash);
});

test("count mismatch is an explicit manifest state and cannot execute", async t => {
  const f = await fixture(t);
  const manifest = freezeRepairManifest(f.context, { expectedPending: 67 });
  assert.equal(manifest.status, "count_mismatch");
  assert.throws(() => validateRepairManifest(f.context, manifest), /invalid_manifest/);
});

test("tracking URL aliases retain separate publication identities and share one inference", async t => {
  const first = brand("one"), second = { ...first, link: `${first.link}?utm_source=email`, guid: `${first.link}?utm_source=email` };
  const f = await fixture(t, [first, second]);
  assert.equal(f.manifest.targetCount, 1);
  assert.equal(f.manifest.aliasCount, 2);
  assert.notEqual(f.manifest.targets[0].aliases[0].articleId, f.manifest.targets[0].aliases[1].articleId);
  const checkpoint = await executeRepairBatch(f.context, f.manifest, { persist: async () => {}, post: async () => response() });
  const updated = applyRepairCheckpoint(f.context, f.manifest, checkpoint);
  assert.deepEqual(updated.items.map(item => item.link), [first.link, second.link]);
  assert.deepEqual(updated.items.map(item => item.sentiment), ["positive", "positive"]);
});

test("rejects an incomplete local reference library instead of silently widening queue", async t => {
  const f = await fixture(t);
  f.audit.crawlMetrics.jev.inclusionReferences = 1567;
  await writeFile(f.auditPath, JSON.stringify(f.audit));
  await assert.rejects(f.makeContext(), /incomplete_reference_library/);
});

test("request context and manifest changes fail before a POST", async t => {
  const f = await fixture(t);
  const changed = structuredClone(f.manifest);
  changed.targets[0].requestHash = "a".repeat(64);
  assert.throws(() => validateRepairManifest(f.context, changed), /manifest_hash_mismatch/);
  f.context.entries[0].body += " ";
  await assert.rejects(executeRepairBatch(f.context, f.manifest, { persist: async () => {}, post: async () => assert.fail("No request") }), /frozen_context_changed|request_body_changed/);
});

test("the exact hash-checked body stays immutable across checkpoint persistence", async t => {
  const f = await fixture(t);
  const entry = f.context.entries.find(row => row.key === f.manifest.targets[0].key);
  const requestHash = f.manifest.targets[0].requestHash;
  const checkpoint = await executeRepairBatch(f.context, f.manifest, {
    persist: async value => { if (value.status === "running") entry.body = "changed after send intent"; },
    post: async body => { assert.equal(hash(body), requestHash); return response(); },
  });
  assert.equal(checkpoint.succeeded, 1);
});

test("executes sequentially, saves send intent and each receipt, and caps batch at 25", async t => {
  const f = await fixture(t, Array.from({ length: 27 }, (_, index) => brand(`item-${index}`)));
  const persisted = [];
  let calls = 0;
  const checkpoint = await executeRepairBatch(f.context, f.manifest, { batchSize: 25,
    persist: async state => { persisted.push(structuredClone(state)); }, post: async body => {
      calls++;
      const latest = persisted.at(-1);
      assert.equal(Object.values(latest.entries).filter(row => row.status === "sending").length, 1);
      assert.equal(Object.values(latest.entries).filter(row => row.status === "succeeded").length, calls - 1);
      assert.deepEqual(Object.keys(JSON.parse(body).questions), ["sentiment"]);
      return response();
    } });
  assert.equal(calls, 25);
  assert.equal(checkpoint.succeeded, 25);
  assert.equal(checkpoint.remaining, 2);
  assert.equal(checkpoint.status, "batch_complete");
  assert.ok(Object.values(checkpoint.entries).every(row => row.usage.input_tokens === 100));
  const next = await executeRepairBatch(f.context, f.manifest, { checkpoint, batchSize: 25, persist: async () => {}, post: async () => { calls++; return response(); } });
  assert.equal(calls, 27);
  assert.equal(next.status, "complete");
  assert.equal(next.remaining, 0);
});

test("HTTP transport makes one attempt and never retries quota/auth/service failures", async () => {
  for (const status of [401, 402, 403, 429, 500, 529]) {
    let attempts = 0;
    await assert.rejects(postRepairRequest("{}", { env: { TYPESAFE_API_KEY: "TEST_KEY" }, fetchImpl: async (_url, options) => {
      attempts++;
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      return { ok: false, status, body: { cancel: async () => {} } };
    } }), new RegExp(`http_${status}`));
    assert.equal(attempts, 1);
  }
});

test("first failed request stops and a resumed failed or ambiguous request is never repeated", async t => {
  const f = await fixture(t, [brand("one"), brand("two"), brand("three")]);
  let calls = 0;
  const checkpoint = await executeRepairBatch(f.context, f.manifest, { persist: async () => {}, post: async () => {
    if (++calls === 2) throw new Error("http_429");
    return response();
  } });
  assert.equal(calls, 2);
  assert.equal(checkpoint.succeeded, 1);
  assert.equal(checkpoint.status, "blocked");
  assert.equal(Object.values(checkpoint.entries).find(row => row.status === "failed").error, "http_429");
  for (const status of ["failed", "sending"]) {
    const next = structuredClone(checkpoint);
    Object.values(next.entries).find(row => row.status === "failed").status = status;
    const resumed = await executeRepairBatch(f.context, f.manifest, { checkpoint: next, persist: async () => {}, post: async () => assert.fail("Never repeat ambiguous calls") });
    assert.equal(resumed.status, "blocked_prior_attempt");
  }
});

test("missing usage, malformed sentiment and wrong model stop with safe checkpoint errors", async t => {
  const f = await fixture(t, [brand("one"), brand("two")]);
  const cases = [response({ usage: undefined }), response({ model: "wrong" }),
    response({ answers: { sentiment: { type: "choice", choice: "positive", confidence: 0.8, probabilities: { ...probabilities, negative: 1 } } } })];
  for (const value of cases) {
    let calls = 0;
    const checkpoint = await executeRepairBatch(f.context, f.manifest, { persist: async () => {}, post: async () => { calls++; return value; } });
    assert.equal(calls, 1);
    assert.equal(checkpoint.status, "blocked");
    assert.equal(checkpoint.succeeded, 0);
  }
  const checkpoint = await executeRepairBatch(f.context, f.manifest, { persist: async () => {}, post: async () => { throw new Error("PRIVATE_REQUEST_SECRET_SENTINEL"); } });
  assert.ok(!JSON.stringify(checkpoint).includes("PRIVATE_REQUEST_SECRET_SENTINEL"));
});

test("interruption after send intent prevents inference duplication on resume", async t => {
  const f = await fixture(t);
  let durable, calls = 0;
  await assert.rejects(executeRepairBatch(f.context, f.manifest, { persist: async value => {
    if (durable) throw new Error("disk failure after response");
    durable = structuredClone(value);
  }, post: async () => { calls++; return response(); } }), /disk failure/);
  assert.equal(calls, 1);
  assert.equal(Object.values(durable.entries)[0].status, "sending");
  const resumed = await executeRepairBatch(f.context, f.manifest, { checkpoint: durable, persist: async () => {}, post: async () => assert.fail("Do not repeat") });
  assert.equal(resumed.status, "blocked_prior_attempt");
});

test("publication patches only sentiment and target cache, preserving inclusion, summaries and unrelated state", async t => {
  const f = await fixture(t, [brand("one"), brand("alias", { title: brand("one").title })]);
  const checkpoint = await executeRepairBatch(f.context, f.manifest, { persist: async () => {}, post: async () => response() });
  const updated = applyRepairCheckpoint(f.context, f.manifest, checkpoint);
  assert.deepEqual(updated.items.map(item => item.sentiment), ["positive", "positive"]);
  assert.deepEqual(updated.items.map(item => item.sentimentScore), [91, 91]);
  for (const item of updated.items) {
    assert.equal(item.relevant, true);
    assert.equal(item.reason, "Saved inclusion reason.");
    assert.equal(item.summary, "Saved article summary.");
    assert.equal(item.sentimentReason, "");
  }
  const target = f.manifest.targets[0];
  assert.equal(updated.crawlState.jevCache[target.key].include, null);
  assert.equal(updated.crawlState.jevCache[target.key].sentimentOnly, true);
  assert.equal(updated.crawlState.jevCache[target.key].alignmentVersion, f.manifest.versions.alignmentVersion);
  const sanitized = structuredClone(updated);
  sanitized.items = f.audit.items;
  delete sanitized.crawlState.jevCache[target.key];
  assert.deepEqual(sanitized, f.audit);
  assert.deepEqual(applyRepairCheckpoint(f.context, f.manifest, checkpoint, updated), updated, "Publication retry is idempotent");
});

test("low confidence keeps the saved label/reason while applying the odds score", async t => {
  const f = await fixture(t);
  const value = response();
  value.answers.sentiment.confidence = 0.4;
  const checkpoint = await executeRepairBatch(f.context, f.manifest, { persist: async () => {}, post: async () => value });
  const [item] = applyRepairCheckpoint(f.context, f.manifest, checkpoint).items;
  assert.equal(item.sentiment, "neutral");
  assert.equal(item.sentimentReason, "Saved tone note.");
  assert.equal(item.sentimentScore, 91);
});

test("stored team sentiment corrections remain authoritative", async t => {
  const item = brand("one", { sentiment: "negative", sentimentReason: "Corrected by team feedback.", sentimentScore: undefined });
  const f = await fixture(t, [item]);
  const id = exampleId(item.link);
  f.audit.crawlState.feedback = { applied: { [id]: { sentiment: { label: "negative", baseline: { sentiment: "neutral", sentimentReason: "Prior", sentimentScore: 50, sentimentRubric: null } } } } };
  await writeFile(f.auditPath, JSON.stringify(f.audit));
  const context = await f.makeContext(), manifest = freezeRepairManifest(context);
  assert.equal(manifest.targets[0].aliases[0].feedbackSentiment, true);
  const checkpoint = await executeRepairBatch(context, manifest, { persist: async () => {}, post: async () => response() });
  const [updated] = applyRepairCheckpoint(context, manifest, checkpoint).items;
  assert.deepEqual(updated, JSON.parse(JSON.stringify(item)));
});

test("cache repair keeps existing inclusion authority and ignores returned inclusion/scope answers", async t => {
  const f = await fixture(t);
  const key = f.manifest.targets[0].key;
  const cached = { storyKey: f.manifest.targets[0].storyKey, alignmentVersion: "editorial-examples-v2", model: REPAIR_MODEL, rubricVersion: "relevance-v2",
    include: 0.98, localAngle: 0.9, relevanceScore: 8, scopeSignals: { scope_brand: 0.98 }, sentiment: "neutral", sentimentConfidence: 0.8, customField: "preserved" };
  f.audit.crawlState.jevCache[key] = cached;
  await writeFile(f.auditPath, JSON.stringify(f.audit));
  const context = await f.makeContext(), manifest = freezeRepairManifest(context);
  const checkpoint = await executeRepairBatch(context, manifest, { persist: async () => {}, post: async () => response({
    answers: { ...response().answers, include: { type: "noul", noul: 0 }, scope_brand: { type: "noul", noul: 0 } } }) });
  const updated = applyRepairCheckpoint(context, manifest, checkpoint);
  for (const field of ["include", "localAngle", "relevanceScore", "scopeSignals", "model", "rubricVersion", "customField"]) assert.deepEqual(updated.crawlState.jevCache[key][field], cached[field]);
});

test("known valid odds exclude requests even when a numeric reader score is missing", async t => {
  const f = await fixture(t, [brand("one", { sentimentScore: undefined })]);
  const key = f.manifest.targets[0].key;
  f.audit.crawlState.jevCache[key] = { storyKey: f.manifest.targets[0].storyKey, model: REPAIR_MODEL, rubricVersion: "relevance-v2", include: 0.98,
    sentiment: "positive", sentimentConfidence: 0.8, sentimentProbabilities: probabilities };
  await writeFile(f.auditPath, JSON.stringify(f.audit));
  assert.equal(freezeRepairManifest(await f.makeContext()).targetCount, 0);
});

test("a malformed cache entry for a repair target fails closed instead of persisting unusable odds", async t => {
  const f = await fixture(t);
  f.audit.crawlState.jevCache[f.manifest.targets[0].key] = { include: "invalid", model: REPAIR_MODEL, rubricVersion: "relevance-v2" };
  await writeFile(f.auditPath, JSON.stringify(f.audit));
  await assert.rejects(f.makeContext(), /invalid_target_cache/);
});

test("changed live state is rejected before inference and before publication", async t => {
  const f = await fixture(t);
  const changed = structuredClone(f.audit);
  changed.items[0].summary = "Another generated summary";
  await assert.rejects(executeRepairBatch(f.context, f.manifest, { currentAudit: changed, persist: async () => {}, post: async () => assert.fail("No spending on stale context") }), /publication_snapshot_changed/);
  const checkpoint = await executeRepairBatch(f.context, f.manifest, { persist: async () => {}, post: async () => response() });
  assert.throws(() => applyRepairCheckpoint(f.context, f.manifest, checkpoint, changed), /publication_snapshot_changed/);
  const forged = structuredClone(f.audit);
  forged.items[0].sentimentScore = 99;
  assert.throws(() => applyRepairCheckpoint(f.context, f.manifest, checkpoint, forged), /target_article_changed/);
});

test("receipt normalization stores numeric counters only and atomic checkpoint round trips", async t => {
  const f = await fixture(t);
  assert.deepEqual(normalizeUsageReceipt({ usage: { input_tokens: 100, output_tokens: 20, secret: "do not store", total_tokens: -1 } }), { status: "reported", input_tokens: 100, output_tokens: 20 });
  assert.throws(() => parseRepairResponse(response({ model: undefined })), /response_model_mismatch/);
  const filename = path.join(f.directory, "checkpoint.json"), value = { status: "sending", requestHash: "a".repeat(64) };
  await writeJsonAtomic(filename, value);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), value);
});
