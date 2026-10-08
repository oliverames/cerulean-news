import assert from "node:assert/strict";
import test from "node:test";
import { applyJevRelevance, normalizeJevCache } from "../src/jev-relevance.js";
import { loadAlignmentProfile } from "../src/jev-alignment.js";
import { buildReferenceExamples } from "../src/jev-examples.js";

// Every provider response is injected. No credentials, network or paid calls.
const cutoff = "2026-09-21T00:00:00Z";
const now = new Date("2026-10-08T12:00:00Z");
const probabilities = { positive: 1, "neutral to positive": 0, neutral: 0, "neutral to negative": 0, negative: 0 };
function article(id, extra = {}) {
  return { title: `Vermont hospital budget ${id}`, snippet: "Green Mountain Care Board reviews Vermont hospital budgets.",
    link: `https://vtdigger.org/budget-${id}`, sourceName: "VTDigger", matchedTerms: ["hospital"], category: "topic",
    relevant: true, reason: "Existing inclusion", firstSeenAt: now, pubDate: now, ...extra };
}
function brand(id, extra = {}) {
  return article(id, { title: `Blue Cross VT member program ${id}`, snippet: "BCBSVT offers member support.",
    matchedTerms: ["BCBSVT"], category: "brand", sentiment: "neutral", sentimentReason: "Existing sentiment", ...extra });
}
function answer(include = 0.99) {
  return { model: "jev-1.13.0", answers: {
    include: { type: "noul", noul: include }, local_angle: { type: "noul", noul: 0.9 }, relevance: { type: "score", score: 4 },
    scope_brand: { type: "noul", noul: include }, scope_regional: { type: "noul", noul: include }, scope_policy: { type: "noul", noul: include },
    sentiment: { type: "choice", choice: "positive", confidence: 0.95, probabilities },
  } };
}
function options(extra = {}) {
  return { env: {}, mode: "enforce", enforceAfter: cutoff, now, concurrency: 1, maxItems: 2,
    cache: {}, metrics: {}, callJev: async () => answer(), ...extra };
}
const historical = (id) => brand(id, { firstSeenAt: "2026-06-01T00:00:00Z" });

test("reserved sentiment advances under a saturated primary queue within the total cap", async () => {
  const old = historical("old"), primary = [article(1), article(2), article(3)];
  const calls = [], opts = options({ maxItems: 3, sentimentReservedItems: 1,
    callJev: async (request) => { calls.push(request.state.article.title); return answer(0.01); } });
  const result = await applyJevRelevance([...primary, old], opts);
  assert.deepEqual(calls, [old.title, primary[0].title, primary[1].title]);
  assert.equal(new Set(calls).size, calls.length);
  assert.equal(opts.metrics.requested, 2);
  assert.equal(opts.metrics.succeeded, 2);
  assert.equal(opts.metrics.pending, 1);
  assert.equal(opts.metrics.sentimentBackfillRequested, 1);
  assert.equal(opts.metrics.sentimentBackfilled, 1);
  assert.equal(opts.metrics.sentimentBackfillPending, 0);
  assert.equal(result[3].relevant, true, "historical inclusion does not follow the returned exclusion");
  assert.equal(result[3].reason, old.reason);
  assert.equal(result[3].sentimentScore, 100);
});

test("zero, missing and invalid reservation preserve the primary-first allocation", async (t) => {
  for (const value of [undefined, null, "", " ", 0, "0", -1, "-1", "bad", "1tail", 1.5, "1.5", Infinity, true, {}, Number.MAX_SAFE_INTEGER + 1]) {
    await t.test(String(value), async () => {
      const fresh = article("fresh"), old = historical("old"), calls = [];
      const opts = options({ maxItems: 1, sentimentReservedItems: value,
        callJev: async (request) => { calls.push(request.state.article.title); return answer(); } });
      await applyJevRelevance([fresh, old], opts);
      assert.deepEqual(calls, [fresh.title]);
      assert.equal(opts.metrics.requested, 1);
      assert.equal(opts.metrics.sentimentBackfillRequested, 0);
      assert.equal(opts.metrics.sentimentBackfillPending, 1);
    });
  }
});

test("environment reservation works, explicit zero overrides it, and the cap bounds oversized values", async () => {
  const fresh = article("fresh"), old = historical("old");
  for (const [extra, expected] of [
    [{ env: { JEV_SENTIMENT_RESERVED_ITEMS: "1" } }, old.title],
    [{ env: { JEV_SENTIMENT_RESERVED_ITEMS: "1" }, sentimentReservedItems: 0 }, fresh.title],
    [{ sentimentReservedItems: 100 }, old.title],
  ]) {
    const calls = [], opts = options({ ...extra, maxItems: 1,
      callJev: async (request) => { calls.push(request.state.article.title); return answer(); } });
    await applyJevRelevance([fresh, old], opts);
    assert.deepEqual(calls, [expected]);
    assert.equal(opts.metrics.requested + opts.metrics.sentimentBackfillRequested, 1);
  }
});

test("unused reservation returns capacity to primary work, including empty odds queues", async () => {
  for (const withOld of [false, true]) {
    const primary = [article(1), article(2), article(3)], calls = [];
    const opts = options({ maxItems: 3, sentimentReservedItems: 3,
      callJev: async (request) => { calls.push(request.state.article.title); return answer(); } });
    await applyJevRelevance(withOld ? [...primary, historical("old")] : primary, opts);
    assert.equal(calls.length, 3);
    assert.equal(opts.metrics.requested, withOld ? 2 : 3);
    assert.equal(opts.metrics.sentimentBackfilled, withOld ? 1 : 0);
  }
  let calls = 0;
  assert.deepEqual(await applyJevRelevance([], options({ sentimentReservedItems: 5, callJev: async () => { calls++; return answer(); } })), []);
  assert.equal(calls, 0);
});

test("post-boundary odds-only cache survives reload and remains pending until a primary upgrade", async () => {
  const item = brand("new"), cache = {}, first = options({ cache, maxItems: 1, sentimentReservedItems: 1, callJev: async () => answer(0.01) });
  const [scored] = await applyJevRelevance([item], first);
  assert.equal(scored.relevant, true);
  assert.equal(scored.reason, item.reason);
  assert.equal(scored.jevRelevance, undefined);
  assert.equal(scored.sentimentScore, 100);
  assert.equal(first.metrics.requested, 0);
  assert.equal(first.metrics.pending, 1);
  const [key] = Object.keys(cache);
  assert.equal(cache[key].include, null);
  assert.equal(cache[key].sentimentOnly, true);
  assert.equal(cache[key].scopeSignals, undefined);
  const reloaded = normalizeJevCache(JSON.parse(JSON.stringify(cache)));
  assert.deepEqual(reloaded, cache);

  const waiting = options({ cache: reloaded, maxItems: 1 });
  const [, stillScored] = await applyJevRelevance([article("ahead"), item], waiting);
  assert.equal(stillScored.sentimentScore, 100, "a partial cache reapplies sentiment while inclusion waits");
  assert.equal(stillScored.relevant, true);
  assert.equal(waiting.metrics.cached, 0, "a partial is not a full evaluation cache hit");
  assert.equal(waiting.metrics.pending, 1);
  assert.equal(waiting.metrics.sentimentBackfillRequested, 0);
  assert.equal(waiting.metrics.missReferenceChanged, 0);

  const upgraded = options({ cache: reloaded, maxItems: 1, callJev: async () => answer(0.01) });
  const [excluded] = await applyJevRelevance([item], upgraded);
  assert.equal(upgraded.metrics.requested, 1);
  assert.equal(upgraded.metrics.pending, 0);
  assert.equal(excluded.relevant, false, "the later primary request may decide post-boundary inclusion");
  assert.equal(reloaded[key].include, 0.01);
  assert.equal(reloaded[key].sentimentOnly, undefined);
  assert.equal(Object.keys(reloaded).length, 1, "departed keys are pruned normally");
});

test("failed primary retries retain a partial cache and its usable sentiment", async () => {
  const item = brand("retry"), cache = {};
  await applyJevRelevance([item], options({ cache, maxItems: 1, sentimentReservedItems: 1 }));
  const saved = structuredClone(cache);
  const missingSentiment = answer(), missingOdds = answer();
  delete missingSentiment.answers.sentiment;
  missingOdds.answers.sentiment = { ...missingOdds.answers.sentiment, probabilities: undefined };
  for (const response of [new Error("fixture failure"), { answers: {} }, missingSentiment, missingOdds]) {
    const opts = options({ cache, maxItems: 1, callJev: async () => { if (response instanceof Error) throw response; return response; } });
    const [result] = await applyJevRelevance([item], opts);
    assert.equal(result.relevant, true);
    assert.equal(result.sentimentScore, 100);
    assert.deepEqual(cache, saved);
    assert.equal(opts.metrics.cached, 0);
    assert.equal(opts.metrics.requested, 1);
    assert.equal(opts.metrics.failed, 1);
    assert.equal(opts.metrics.pending, 1);
    assert.equal(opts.metrics.status, "partial_failure");
  }
});

test("identical request keys use one slot and apply sentiment and later primary results to every alias", async () => {
  const first = brand("same"), second = { ...first, link: "https://vtdigger.org/another-url-for-same-request" };
  const calls = [], cache = {}, opts = options({ cache, maxItems: 2, sentimentReservedItems: 2,
    callJev: async request => { calls.push(request.state.article.title); return answer(0.01); } });
  const result = await applyJevRelevance([first, second], opts);
  assert.equal(calls.length, 1);
  assert.equal(opts.metrics.sentimentBackfillRequested, 1);
  assert.equal(opts.metrics.sentimentBackfilled, 1);
  assert.equal(opts.metrics.pending, 1, "primary pending counts one remaining request");
  assert.deepEqual(result.map(item => item.sentimentScore), [100, 100]);
  assert.deepEqual(result.map(item => item.relevant), [true, true]);
  const upgraded = options({ cache, maxItems: 2, callJev: async () => { calls.push("primary"); return answer(0.01); } });
  const final = await applyJevRelevance(result, upgraded);
  assert.equal(calls.length, 2);
  assert.equal(upgraded.metrics.requested, 1);
  assert.equal(upgraded.metrics.pending, 0);
  assert.deepEqual(final.map(item => item.relevant), [false, false]);
});

test("odds refresh preserves an existing inclusion answer and its scope signals", async () => {
  const item = brand("cached"), cache = {};
  await applyJevRelevance([item], options({ cache }));
  const [key] = Object.keys(cache);
  cache[key].scopeSignals = { scope_brand: 0.99, scope_regional: 0.8, scope_policy: 0.4 };
  delete cache[key].sentimentProbabilities;
  const opts = options({ cache, maxItems: 1, sentimentReservedItems: 1, callJev: async () => answer(0.01) });
  const [result] = await applyJevRelevance([item], opts);
  assert.equal(result.relevant, true);
  assert.equal(cache[key].include, 0.99);
  assert.equal(cache[key].scopeSignals.scope_brand, 0.99);
  assert.equal(cache[key].sentimentOnly, undefined);
  assert.equal(opts.metrics.cached, 1);
  assert.equal(opts.metrics.requested, 0);
  assert.equal(opts.metrics.sentimentBackfilled, 1);
});

test("partial cache normalization rejects incomplete or contradictory authority", () => {
  const key = "a".repeat(64);
  const valid = { model: "jev-1.13.0", rubricVersion: "relevance-v2", include: null, sentimentOnly: true,
    sentiment: "positive", sentimentConfidence: 0.95, sentimentProbabilities: probabilities };
  assert.equal(normalizeJevCache({ [key]: valid })[key].sentimentOnly, true);
  for (const change of [
    { sentimentOnly: undefined }, { sentimentOnly: false }, { include: 0 }, { include: 0.9 },
    { sentiment: null }, { sentiment: "invalid" }, { sentimentConfidence: 2 },
    { sentimentProbabilities: null }, { sentimentProbabilities: { ...probabilities, negative: 1 } },
  ]) assert.deepEqual(normalizeJevCache({ [key]: { ...valid, ...change } }), {});
});

test("failed or malformed odds requests consume their reserved slot and remain pending", async (t) => {
  const invalidLabel = answer(), invalidOdds = answer(), invalidInclude = answer();
  invalidLabel.answers.sentiment = { ...invalidLabel.answers.sentiment, choice: "wrong" };
  invalidOdds.answers.sentiment = { ...invalidOdds.answers.sentiment, probabilities: { ...probabilities, negative: 1 } };
  invalidInclude.answers.include = { type: "noul", noul: -1 };
  for (const response of [new Error("fixture failure"), invalidLabel, invalidOdds, invalidInclude]) {
    await t.test(response instanceof Error ? "throw" : JSON.stringify(response.answers.sentiment), async () => {
      let calls = 0;
      const old = historical("failed"), opts = options({ maxItems: 1, sentimentReservedItems: 1,
        callJev: async () => { calls++; if (response instanceof Error) throw response; return response; } });
      const [fresh, result] = await applyJevRelevance([article("waiting"), old], opts);
      assert.equal(calls, 1, "failed reservations do not add replacement requests beyond the cap");
      assert.equal(result, old);
      assert.equal(fresh.relevant, true);
      assert.deepEqual(opts.cache, {});
      assert.equal(opts.metrics.requested, 0);
      assert.equal(opts.metrics.failed, 0, "primary failure counters keep their existing meaning");
      assert.equal(opts.metrics.pending, 1);
      assert.equal(opts.metrics.sentimentBackfillRequested, 1);
      assert.equal(opts.metrics.sentimentBackfillFailed, 1);
      assert.equal(opts.metrics.sentimentBackfilled, 0);
      assert.equal(opts.metrics.sentimentBackfillPending, 1);
      assert.equal(opts.metrics.status, "partial_failure");
    });
  }
});

test("primary, scope and sentiment share one allowance without requesting an overlapping entry twice", async () => {
  const alignment = await loadAlignmentProfile("src/rubrics/editorial-alignment-v2.json");
  const referenceExamples = buildReferenceExamples({ articles: [{ url: "https://example.test/reference", title: "Blue Cross community award", trackerSentiment: "positive" }] });
  const cache = {}, scoped = brand("scope"), oddsOnly = historical("odds"), fresh = article("primary");
  const base = options({ cache, alignment, referenceExamples });
  const [cached] = await applyJevRelevance([scoped], base);
  const [key] = Object.keys(cache);
  delete cache[key].scopeSignals;
  delete cache[key].sentimentProbabilities;
  cached.jevBaseline = { capturedAt: now.toISOString(), relevant: false, reason: "Original rejection", sentiment: "neutral", sentimentReason: "" };
  for (const reserve of [0, 1]) {
    const calls = [], opts = options({ cache: structuredClone(cache), alignment, referenceExamples, maxItems: 4,
      sentimentReservedItems: reserve, callJev: async request => { calls.push(request.state.article.title); return answer(); } });
    await applyJevRelevance([fresh, cached, oddsOnly], opts);
    assert.equal(new Set(calls).size, calls.length);
    assert.ok(calls.length <= 4);
    assert.equal(opts.metrics.requested, 1);
    assert.equal(opts.metrics.scopeBackfilled, reserve ? 0 : 1);
    assert.equal(opts.metrics.sentimentBackfilled, reserve ? 2 : 1);
  }
});

test("reservation leaves shadow/off modes and deterministic or human exclusions intact", async () => {
  const fresh = article("fresh"), old = historical("old");
  for (const mode of ["shadow", "off"]) {
    const calls = [], opts = options({ mode, maxItems: 1, sentimentReservedItems: 1,
      callJev: async request => { calls.push(request.state.article.title); return answer(0.01); } });
    const input = [fresh, old];
    assert.equal(await applyJevRelevance(input, opts), input);
    assert.deepEqual(calls, mode === "shadow" ? [fresh.title] : []);
  }
  const blocked = [brand("drop", { humanRejected: true, relevant: false }),
    brand("obit", { title: "Obituary: Blue Cross VT employee", link: "https://vtdigger.org/obituaries/person" })];
  const calls = [];
  await applyJevRelevance([...blocked, fresh], options({ maxItems: 1, sentimentReservedItems: 1,
    callJev: async request => { calls.push(request.state.article.title); return answer(); } }));
  assert.deepEqual(calls, [fresh.title]);
});
