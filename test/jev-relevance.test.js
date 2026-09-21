import assert from "node:assert/strict";
import test from "node:test";
import {
  applyJevRelevance,
  buildJevRequest,
  classifyItemRelevance,
  decideJevRelevance,
  DECISION_EXCLUDE,
  DECISION_INCLUDE,
  DECISION_KEYWORD,
  EXCLUDE_THRESHOLD,
  INCLUDE_THRESHOLD,
  jevRelevanceMode,
  JEV_MODE_ENFORCE,
  JEV_MODE_OFF,
  JEV_MODE_SHADOW,
  keywordVerdict,
  loadRelevanceRubric,
  selectJevCandidates,
  validateRelevanceRubric,
} from "../src/jev-relevance.js";

// The live API is never called from tests: every case below stubs the caller.
function stubAnswers({ include, localAngle = 0.5, score = 3 } = {}) {
  return {
    model: "jev-1.13.0",
    answers: {
      include: { type: "noul", noul: include },
      local_angle: { type: "noul", noul: localAngle },
      relevance: {
        type: "score",
        score,
        legend: { 0: "a", 1: "b" },
        probabilities: { 0: 0.5, 1: 0.5 },
        confidence: 0.5,
      },
    },
  };
}

function stubCaller(response) {
  const calls = [];
  return {
    calls,
    async callJev(request) {
      calls.push(request);
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
  };
}

test("relevance rubric loads from disk and carries the three questions", async () => {
  const rubric = await loadRelevanceRubric();

  assert.equal(rubric.version, "relevance-v2");
  assert.equal(rubric.model, "jev-1.13.0");
  assert.equal(rubric.questions.include.type, "noul");
  assert.equal(rubric.questions.local_angle.type, "noul");
  assert.equal(rubric.questions.relevance.type, "score");
  assert.ok(rubric.questions.relevance.criteria.length >= 2);
  // The wording lives in the rubric file, not in the module.
  assert.match(rubric.questions.include.instructions.question, /Cerulean News/);
  assert.match(rubric.questions.local_angle.instructions, /Vermont or New England/i);
});

test("a rubric missing a question is rejected rather than half-loaded", () => {
  assert.throws(
    () =>
      validateRelevanceRubric({
        version: "x",
        model: "jev-1.13.0",
        questions: {
          include: { type: "noul", instructions: "?" },
          relevance: { type: "score", instructions: "?", criteria: ["a", "b"] },
        },
      }),
    /local_angle/,
  );
  assert.throws(
    () =>
      validateRelevanceRubric({
        version: "x",
        model: "jev-1.13.0",
        questions: {
          include: { type: "noul", instructions: "?" },
          local_angle: { type: "noul", instructions: "?" },
          relevance: { type: "score", instructions: "?" },
        },
      }),
    /array of levels/,
  );
});

test("a request asks all three questions over title and excerpt only", async () => {
  const rubric = await loadRelevanceRubric();
  const request = buildJevRequest(
    {
      title: "  Blue Cross VT files 2027 rates  ",
      description: "The insurer asked regulators for a smaller increase.",
      articleText: "SECRET FULL ARTICLE TEXT",
      feedContent: "SECRET FEED CONTENT",
    },
    rubric,
  );

  assert.deepEqual(Object.keys(request.questions).sort(), [
    "include",
    "local_angle",
    "relevance",
  ]);
  assert.equal(request.model, "jev-1.13.0");
  assert.equal(request.state.article.title, "Blue Cross VT files 2027 rates");
  assert.equal(
    request.state.article.excerpt,
    "The insurer asked regulators for a smaller increase.",
  );
  const serialized = JSON.stringify(request);
  assert.ok(!serialized.includes("SECRET FULL ARTICLE TEXT"));
  assert.ok(!serialized.includes("SECRET FEED CONTENT"));
});

test("excerpt prefers the snippet and is length-capped", async () => {
  const rubric = await loadRelevanceRubric();
  const request = buildJevRequest(
    { title: "t", snippet: "s".repeat(1500), description: "ignored" },
    rubric,
  );

  assert.equal(request.state.article.excerpt.length, 1200);
  assert.ok(!request.state.article.excerpt.includes("ignored"));
});

test("the include thresholds decide, and the band keeps the keyword verdict", () => {
  const cases = [
    { include: 0.95, keywordRelevant: false, decision: DECISION_INCLUDE, relevant: true },
    { include: INCLUDE_THRESHOLD, keywordRelevant: false, decision: DECISION_INCLUDE, relevant: true },
    { include: 0.05, keywordRelevant: true, decision: DECISION_EXCLUDE, relevant: false },
    { include: EXCLUDE_THRESHOLD, keywordRelevant: true, decision: DECISION_EXCLUDE, relevant: false },
    { include: 0.5, keywordRelevant: true, decision: DECISION_KEYWORD, relevant: true },
    { include: 0.5, keywordRelevant: false, decision: DECISION_KEYWORD, relevant: false },
    { include: 0.69, keywordRelevant: true, decision: DECISION_KEYWORD, relevant: true },
    { include: 0.31, keywordRelevant: false, decision: DECISION_KEYWORD, relevant: false },
  ];

  for (const testCase of cases) {
    const decision = decideJevRelevance({
      answers: stubAnswers({ include: testCase.include }).answers,
      keywordRelevant: testCase.keywordRelevant,
    });
    assert.equal(
      decision.decision,
      testCase.decision,
      `include=${testCase.include}`,
    );
    assert.equal(decision.relevant, testCase.relevant, `include=${testCase.include}`);
  }
});

test("local angle and relevance score are recorded but do not gate the verdict", () => {
  const decision = decideJevRelevance({
    answers: stubAnswers({ include: 0.9, localAngle: 0.02, score: 0.4 }).answers,
    keywordRelevant: true,
  });

  assert.equal(decision.decision, DECISION_INCLUDE);
  assert.equal(decision.relevant, true);
  assert.equal(decision.localAngle, 0.02);
  assert.equal(decision.relevanceScore, 0.4);
});

test("a malformed or missing answer falls back to the keyword verdict", () => {
  for (const answers of [
    undefined,
    {},
    { include: { type: "noul" } },
    { include: { type: "score", score: 2 } },
    { include: { type: "noul", noul: "0.9" } },
  ]) {
    assert.equal(
      decideJevRelevance({ answers, keywordRelevant: false }).decision,
      DECISION_KEYWORD,
    );
    assert.equal(
      decideJevRelevance({ answers, keywordRelevant: true }).relevant,
      true,
    );
  }
});

test("keywordVerdict treats an unjudged item as kept", () => {
  assert.equal(keywordVerdict({}), true);
  assert.equal(keywordVerdict({ relevant: true }), true);
  assert.equal(keywordVerdict({ relevant: false }), false);
});

test("a failing Jev call falls back to the keyword verdict instead of throwing", async () => {
  const failing = stubCaller(new Error("jev: command not found"));
  const classification = await classifyItemRelevance(
    { title: "Rate filing", snippet: "Vermont regulators", relevant: true },
    { callJev: failing.callJev },
  );

  assert.equal(classification.ok, false);
  assert.equal(classification.decision, DECISION_KEYWORD);
  assert.equal(classification.relevant, true);
  assert.match(classification.error, /command not found/);
});

test("a missing rubric file degrades to the keyword verdict", async () => {
  const classification = await classifyItemRelevance(
    { title: "Rate filing", relevant: false },
    {
      rubricPath: "src/rubrics/does-not-exist.json",
      callJev: stubCaller(stubAnswers({ include: 0.99 })).callJev,
    },
  );

  assert.equal(classification.ok, false);
  assert.equal(classification.relevant, false);
  assert.equal(classification.decision, DECISION_KEYWORD);
});

test("mode parsing defaults to off and rejects unknown values", () => {
  assert.equal(jevRelevanceMode({}), JEV_MODE_OFF);
  assert.equal(jevRelevanceMode({ JEV_RELEVANCE: "" }), JEV_MODE_OFF);
  assert.equal(jevRelevanceMode({ JEV_RELEVANCE: " Shadow " }), JEV_MODE_SHADOW);
  assert.equal(jevRelevanceMode({ JEV_RELEVANCE: "enforce" }), JEV_MODE_ENFORCE);
  assert.equal(jevRelevanceMode({ JEV_RELEVANCE: "yes-please" }), JEV_MODE_OFF);
});

test("deterministic rejections are skipped while tracker press can receive sentiment", () => {
  const items = [
    { title: "Kept", snippet: "Vermont health care" },
    { title: "Registered Nurse job opening", link: "https://www.indeed.com/viewjob?jk=1", relevant: false },
    { title: "Tracker clip", fromMediaTracker: true },
    { title: "", description: "" },
  ];

  const candidates = selectJevCandidates(items, 25);

  assert.deepEqual(
    candidates.map((item) => item.title),
    ["Kept", "Tracker clip"],
  );
});

test("the per-run candidate cap bounds how many articles are classified", () => {
  const items = Array.from({ length: 10 }, (unused, index) => ({
    title: `Story ${index}`,
    snippet: "Vermont health care",
  }));

  assert.equal(selectJevCandidates(items, 3).length, 3);
});

test("the classifier is off by default and makes no requests", async () => {
  const stub = stubCaller(stubAnswers({ include: 0.01 }));
  const items = [{ title: "Vermont hospital budget", snippet: "Green Mountain Care Board" }];

  const result = await applyJevRelevance(items, {
    env: {},
    callJev: stub.callJev,
  });

  assert.equal(result, items);
  assert.equal(stub.calls.length, 0);
});

test("shadow mode classifies but leaves every item untouched", async () => {
  const stub = stubCaller(stubAnswers({ include: 0.01 }));
  const items = [
    { title: "Vermont hospital budget", snippet: "Green Mountain Care Board" },
  ];

  const result = await applyJevRelevance(items, {
    env: { JEV_RELEVANCE: "shadow" },
    callJev: stub.callJev,
  });

  assert.equal(stub.calls.length, 1);
  assert.deepEqual(result, items);
  assert.equal(result[0].relevant, undefined);
  assert.equal(result[0].jevRelevance, undefined);
});

test("enforce mode applies confident verdicts and leaves the band alone", async () => {
  const items = [
    { title: "Excluded story", snippet: "national lifestyle piece" },
    { title: "Uncertain story", snippet: "maybe health care" },
    { title: "Rescued story", snippet: "Blue Cross VT rate filing", relevant: false },
    { title: "Tracker clip", fromMediaTracker: true },
  ];
  const byTitle = new Map([
    ["Excluded story", 0.02],
    ["Uncertain story", 0.5],
    ["Rescued story", 0.98],
  ]);

  const result = await applyJevRelevance(items, {
    env: { JEV_RELEVANCE: "enforce" },
    async callJev(request) {
      return stubAnswers({ include: byTitle.get(request.state.article.title) });
    },
  });

  assert.equal(result[0].relevant, false);
  assert.match(result[0].reason, /Jev relevance classifier/);
  assert.equal(result[0].jevRelevance.rubricVersion, "relevance-v2");
  // Uncertainty band: untouched, including the object identity.
  assert.equal(result[1], items[1]);
  // A model rejection may be reconsidered; deterministic exclusions are tested separately.
  assert.equal(result[2].relevant, true);
  assert.equal(result[3], items[3]);
});

test("enforce mode keeps the keyword verdict when the API fails", async () => {
  const items = [
    { title: "Vermont hospital budget", snippet: "Green Mountain Care Board" },
  ];

  const result = await applyJevRelevance(items, {
    env: { JEV_RELEVANCE: "enforce" },
    callJev: stubCaller(new Error("HTTP 529 from api.typesafe.ai")).callJev,
  });

  assert.equal(result[0], items[0]);
  assert.equal(result[0].relevant, undefined);
});

test("an unreadable rubric disables the pass without touching items", async () => {
  const stub = stubCaller(stubAnswers({ include: 0.01 }));
  const items = [{ title: "Vermont hospital budget", snippet: "GMCB" }];

  const result = await applyJevRelevance(items, {
    env: { JEV_RELEVANCE: "enforce" },
    rubricPath: "src/rubrics/does-not-exist.json",
    callJev: stub.callJev,
  });

  assert.equal(result, items);
  assert.equal(stub.calls.length, 0);
});
