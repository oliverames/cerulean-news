import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { applyJevRelevance, buildJevRequest, callJevApi, decideJevRelevance, loadRelevanceRubric, loadSentimentRubric, normalizeJevCache } from "../src/jev-relevance.js";
import { generateFeed } from "../src/index.js";
import { buildJsonSummary, buildRss } from "../src/outputs.js";
import { SENTIMENT_VALUES, setCoverageContext } from "../src/summaries.js";

const now = new Date("2026-09-21T12:00:00Z");
function article(index = 0, extra = {}) {
  return {
    title: `Vermont hospital budget review ${index}`, snippet: "Green Mountain Care Board reviews Vermont hospital budgets.",
    link: `https://vtdigger.org/2026/09/21/budget-${index}`, sourceName: "VTDigger",
    matchedTerms: ["hospital"], category: "topic", pubDate: now,
    summary: "Vermont hospital budgets are under review.", relevant: true, ...extra,
  };
}
function brand(extra = {}) {
  return article(10, { title: "Blue Cross VT wins best health insurer", snippet: "BCBSVT won a community award.",
    matchedTerms: ["BCBSVT"], category: "brand", sentiment: "neutral", sentimentReason: "Old assessment", ...extra });
}
function answer(include = 0.99, sentiment = "positive", confidence = 0.95) {
  return { model: "jev-1.13.0", answers: {
    include: { type: "noul", noul: include }, local_angle: { type: "noul", noul: 0.9 },
    relevance: { type: "score", score: 4 },
    sentiment: { type: "choice", choice: sentiment, confidence,
      probabilities: Object.fromEntries(SENTIMENT_VALUES.map((label) => [label, label === sentiment ? 1 : 0])) },
  } };
}

// No real model requests are made by this suite.
test("probabilities outside the contract preserve the current verdict", () => {
  for (const noul of [-1, 2, NaN, Infinity, "0.99", null]) {
    for (const keywordRelevant of [true, false]) {
      const result = decideJevRelevance({ answers: { include: { type: "noul", noul } }, keywordRelevant });
      assert.equal(result.decision, "keyword");
      assert.equal(result.relevant, keywordRelevant);
    }
  }
});

test("a direct invalid mode cannot enforce or make requests", async () => {
  const items = [article()];
  let calls = 0;
  assert.equal(await applyJevRelevance(items, { mode: "typo", callJev: async () => { calls++; return answer(0); } }), items);
  assert.equal(calls, 0);
});

test("sentiment shares tracker calibration, uses bounded context, and excludes ineligible coverage", async () => {
  const rubric = await loadRelevanceRubric();
  const sentimentRubric = await loadSentimentRubric();
  setCoverageContext({ storylines: [{ name: "Test note", match: ["community award"], note: "Award is favorable." }] });
  try {
    const request = buildJevRequest(brand({ relevant: false, articleText: "SECRET FULL TEXT", feedContent: "SECRET FEED CONTENT" }), rubric, { sentimentRubric });
    assert.equal(request.questions.sentiment.type, "choice");
    assert.equal(request.questions.sentiment.instructions.examples.length, 10);
    assert.equal(request.questions.sentiment.instructions.rules.length, 6);
    assert.deepEqual(request.questions.sentiment.instructions.storylines, [{ name: "Test note", note: "Award is favorable." }]);
    assert.doesNotMatch(JSON.stringify(request), /SECRET/);
    for (const item of [article(), brand({ link: "https://bluecrossvt.org/news/award", sourceName: "Blue Cross VT" }), brand({ link: "https://www.bcbs.com/news/award" }), brand({ link: "https://www.indeed.com/viewjob?jk=1" })]) {
      assert.equal(buildJevRequest(item, rubric, { sentimentRubric }).questions.sentiment, undefined, item.link);
    }
  } finally { setCoverageContext({ storylines: [] }); }
});

test("shadow evaluates inclusion and sentiment but leaves reader data untouched", async () => {
  const items = [brand()];
  const before = structuredClone(items);
  const metrics = {}, cache = {};
  const result = await applyJevRelevance(items, { mode: "shadow", cache, metrics, callJev: async () => answer(0.01, "negative") });
  assert.equal(result, items);
  assert.deepEqual(result, before);
  assert.equal(metrics.inclusionDisagreements, 1);
  assert.equal(metrics.sentimentDisagreements, 1);
  assert.equal(Object.keys(cache).length, 1);
});

test("enforcement reconsiders a model rejection and scores eligible brand sentiment", async () => {
  const [included] = await applyJevRelevance([brand({ relevant: false, reason: "Outside scope" })], { mode: "enforce", callJev: async () => answer() });
  assert.equal(included.relevant, true);
  assert.equal(included.sentiment, "positive");
  assert.equal(included.sentimentReason, "");
  assert.doesNotMatch(included.reason, /Outside scope/);
  const [uncertain] = await applyJevRelevance([brand()], { mode: "enforce", callJev: async () => answer(0.5, "negative", 0.6) });
  assert.equal(uncertain.sentiment, "neutral");
  const [excluded] = await applyJevRelevance([brand()], { mode: "enforce", callJev: async () => answer(0.01) });
  assert.equal(buildJsonSummary([excluded], [], now).items.length, 0);
  assert.doesNotMatch(buildRss([excluded], { now }), /<item>/);
  assert.equal(buildJsonSummary([excluded], [], now, { includeRejected: true }).items[0].sentiment, undefined);
});

test("real deterministic exclusions and affirmative exceptions never reach Jev", async () => {
  const items = [
    brand({ title: "Registered Nurse job opening", link: "https://www.indeed.com/viewjob?jk=1", relevant: false }),
    brand({ fromMediaTracker: true, link: "https://www.indeed.com/viewjob?jk=2" }),
    brand({ link: "https://bluecrossvt.org/news/award", relevant: true }),
  ];
  let calls = 0;
  const result = await applyJevRelevance(items, { mode: "enforce", callJev: async () => { calls++; return answer(0); } });
  assert.deepEqual(result, items);
  assert.equal(calls, 0);
});

test("cached decisions advance through the cap and reapply after Gemini changes a verdict", async () => {
  const items = [article(1), article(2), article(3)], cache = {};
  let calls = 0;
  const options = { mode: "enforce", cache, maxItems: 2, callJev: async () => { calls++; return answer(0.01); } };
  const first = await applyJevRelevance(items, options);
  assert.equal(calls, 2);
  assert.equal(first[0].relevant, false);
  const second = await applyJevRelevance(items, options);
  assert.equal(calls, 3);
  assert.ok(second.every((item) => item.relevant === false));
  await applyJevRelevance(items, options);
  assert.equal(calls, 3);
  assert.equal(Object.keys(cache).length, 3);
});

test("cached uncertainty follows the current fallback and malformed results retry", async () => {
  let calls = 0;
  const cache = {};
  const options = { mode: "enforce", cache, callJev: async () => { calls++; return answer(0.5); } };
  await applyJevRelevance([article()], options);
  const [result] = await applyJevRelevance([article(0, { relevant: false, reason: "Outside scope" })], options);
  assert.equal(calls, 1);
  assert.equal(result.relevant, false);
  for (const invalid of [answer(2), { answers: {} }, answer(0.99, "unknown"), answer(0.99, "positive", 2)]) {
    const invalidCache = {}, items = [brand()];
    const unchanged = await applyJevRelevance(items, { mode: "enforce", cache: invalidCache, callJev: async () => invalid });
    assert.equal(unchanged[0], items[0]);
    assert.equal(Object.keys(invalidCache).length, 0);
    await applyJevRelevance(items, { mode: "enforce", cache: invalidCache, callJev: async () => answer() });
    assert.equal(Object.keys(invalidCache).length, 1);
  }
});

test("cache invalidates on input, rubric, model, and storyline changes and prunes expired items", async () => {
  const cache = {}, rubric = await loadRelevanceRubric();
  let calls = 0;
  const options = { mode: "shadow", cache, rubric, callJev: async () => { calls++; return answer(); } };
  await applyJevRelevance([brand()], options);
  await applyJevRelevance([brand({ snippet: "BCBSVT won a new award." })], options);
  await applyJevRelevance([brand()], { ...options, rubric: { ...rubric, model: "jev-test" } });
  const changed = structuredClone(rubric);
  changed.questions.include.instructions += " Updated wording.";
  await applyJevRelevance([brand()], { ...options, rubric: changed });
  setCoverageContext({ storylines: [{ name: "Award", match: ["community award"], note: "New context." }] });
  try { await applyJevRelevance([brand()], options); }
  finally { setCoverageContext({ storylines: [] }); }
  assert.equal(calls, 5);
  assert.equal(Object.keys(cache).length, 1);
});

test("missing credentials are explicit in audit metrics, without blocking publishing", async () => {
  const metrics = {}, items = [article()];
  assert.deepEqual(await applyJevRelevance(items, { env: { JEV_RELEVANCE: "shadow" }, metrics }), items);
  assert.equal(metrics.status, "credentials_missing");
  assert.equal(metrics.requested, 0);
  assert.equal(metrics.pending, 1);
});

test("API uses fixed HTTPS bearer auth, refuses redirects, and retries a short overload once", async () => {
  let calls = 0;
  const delays = [];
  const response = await callJevApi({ state: "fixture", model: "jev-1.13.0", questions: {} }, {
    env: { TYPESAFE_API_KEY: "fixture-key" }, sleepImpl: async (delay) => delays.push(delay),
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(init.headers.Authorization, "Bearer fixture-key");
      assert.equal(init.redirect, "error");
      assert.ok(init.signal instanceof AbortSignal);
      return calls === 1 ? new Response("overloaded", { status: 529, headers: { "retry-after": "2" } }) : Response.json(answer());
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(delays, [2000]);
  assert.equal(response.model, "jev-1.13.0");
  for (const status of [401, 422, 429]) {
    let attempts = 0;
    await assert.rejects(callJevApi({}, { env: { TYPESAFE_API_KEY: "fixture-key" }, fetchImpl: async () => {
      attempts++; return new Response("SECRET RESPONSE", { status, headers: { "retry-after": "3600" } });
    } }), new RegExp(`^Error: TypeSafe API HTTP ${status}$`));
    assert.equal(attempts, 1);
  }
});

test("audit cache normalizes safe fields and survives a complete generator round trip", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jev-audit-test-"));
  try {
    const paths = { rssOutputPath: path.join(directory, "feed.rss"), jsonOutputPath: path.join(directory, "feed.json"), auditJsonOutputPath: path.join(directory, "feed-audit.json") };
    await writeFile(paths.auditJsonOutputPath, JSON.stringify({ generatedAt: now.toISOString(), items: [brand()] }));
    let calls = 0;
    const options = { sources: [], now, ...paths, jevOptions: { mode: "enforce", callJev: async () => { calls++; return answer(); } } };
    await generateFeed(options);
    const first = JSON.parse(await readFile(paths.auditJsonOutputPath, "utf8"));
    const key = Object.keys(first.crawlState.jevCache)[0];
    assert.ok(key);
    first.crawlState.jevCache[key].secret = "SECRET CACHE VALUE";
    first.items[0].sentiment = "negative";
    first.items[0].relevant = false;
    first.items[0].reason = "Outside scope";
    await writeFile(paths.auditJsonOutputPath, JSON.stringify(first));
    await generateFeed(options);
    assert.equal(calls, 1);
    const audit = JSON.parse(await readFile(paths.auditJsonOutputPath, "utf8"));
    const published = JSON.parse(await readFile(paths.jsonOutputPath, "utf8"));
    assert.equal(published.items[0].sentiment, "positive");
    assert.equal(published.items[0].relevant, true);
    assert.equal(published.crawlState, undefined);
    assert.doesNotMatch(JSON.stringify(audit), /SECRET CACHE VALUE/);
    assert.equal(audit.crawlMetrics.jev.cached, 1);
    assert.deepEqual(normalizeJevCache({ bad: {}, [key]: { include: 2, model: "x", rubricVersion: "x" } }), {});
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("generator runs Jev after Gemini and publishes the final verdict", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jev-order-test-"));
  try {
    const paths = { rssOutputPath: path.join(directory, "feed.rss"), jsonOutputPath: path.join(directory, "feed.json"), auditJsonOutputPath: path.join(directory, "feed-audit.json") };
    const moduleUrl = new URL("../src/index.js", import.meta.url).href;
    for (const jevIncludes of [true, false]) {
      await writeFile(paths.auditJsonOutputPath, JSON.stringify({ generatedAt: now.toISOString(), items: [article(0, { summary: "", relevant: undefined })] }));
      const code = `
        import assert from 'node:assert/strict';
        import { generateFeed } from ${JSON.stringify(moduleUrl)};
        const events = [];
        globalThis.fetch = async (url) => {
          assert.match(String(url), /^https:\\/\\/generativelanguage.googleapis.com\\//);
          events.push('gemini');
          return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify([{ id: 1, summary: 'Hospital budgets are reviewed.', relevant: ${!jevIncludes}, reason: 'Model judgment' }]) }] } }] });
        };
        await generateFeed({ sources: [], now: new Date(${JSON.stringify(now.toISOString())}), ...${JSON.stringify(paths)},
          jevOptions: { mode: 'enforce', callJev: async () => { events.push('jev'); return ${JSON.stringify(answer(jevIncludes ? 0.99 : 0.01))}; } } });
        assert.deepEqual(events, ['gemini', 'jev']);
      `;
      await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], {
        env: { ...process.env, GEMINI_API_KEY: "fixture-only", SLACK_WEBHOOK_URL: "", DISCORD_WEBHOOK_URL: "" },
      });
      const published = JSON.parse(await readFile(paths.jsonOutputPath, "utf8"));
      assert.equal(published.items.length, jevIncludes ? 1 : 0);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("curated press keeps its inclusion decision while Jev evaluates sentiment", async () => {
  const item = brand({ fromMediaTracker: true });
  let calls = 0;
  const metrics = {};
  const [result] = await applyJevRelevance([item], { mode: "enforce", metrics, callJev: async (request) => {
    calls++;
    assert.ok(request.questions.sentiment);
    return answer(0.01, "positive");
  } });
  assert.equal(calls, 1);
  assert.equal(result.relevant, true);
  assert.equal(result.sentiment, "positive");
  assert.equal(metrics.inclusionDisagreements, 0);
});
