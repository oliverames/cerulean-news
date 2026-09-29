import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildReferenceExamples, exampleId, sameExampleStory, selectReferenceExamples } from "../src/jev-examples.js";
import { addEditorialAlignment, alignedInclusionAnswer, applyHumanRejections, HUMAN_REJECTION_REASON, loadAlignmentProfile } from "../src/jev-alignment.js";
import { generateFeed } from "../src/index.js";
import { readFile } from "node:fs/promises";
import { applyJevRelevance, buildJevRequest, classifyItemRelevance, normalizeJevCache, loadRelevanceRubric, loadSentimentRubric } from "../src/jev-relevance.js";
import { INCLUSION_PRIORITIES, INCLUSION_RULES } from "../src/summaries.js";

const target = { title: "Vermont hospitals review their annual operating budgets", link: "https://vtdigger.org/budgets?utm_source=test",
  snippet: "A hospital budget hearing in Vermont.", category: "brand", matchedTerms: ["BCBSVT"], sourceName: "VTDigger", relevant: false };
const seed = { articles: [
  { url: "https://vtdigger.org/budgets", title: target.title, trackerSentiment: "positive", topic: "Our published budget response" },
  { url: "https://news.test/award", title: "Insurer wins community award", trackerSentiment: "positive", topic: "An award for the insurer" },
  { url: "https://news.test/rates", title: "Insurer criticised for higher rates", trackerSentiment: "negative", topic: "Costs blamed on the insurer" },
] };

test("reference labels come from human seed only, with conflict suppression", () => {
  const examples = buildReferenceExamples(seed, [{ link: seed.articles[1].url, sentiment: "negative", relevant: false, sentimentReason: "SECRET MODEL RATIONALE" }]);
  assert.equal(examples[1].include, true);
  assert.equal(examples[1].sentiment, "positive");
  assert.doesNotMatch(JSON.stringify(examples), /SECRET MODEL/);
  assert.equal(buildReferenceExamples(seed, [], { conflictIds: [exampleId(seed.articles[1].url)] })[1].sentiment, null);
  const conflict = buildReferenceExamples({ articles: [...seed.articles, { ...seed.articles[1], trackerSentiment: "negative" }] });
  assert.equal(conflict[1].sentiment, null);
  assert.equal(conflict[1].sentimentConflict, true);
  assert.equal(conflict.length, 3);
});

test("target identity, tracking links, and near-duplicate titles are excluded from references", () => {
  const examples = buildReferenceExamples(seed);
  const refs = selectReferenceExamples(target, examples, { task: "sentiment", limit: 16 });
  assert.equal(refs.length, 2);
  assert.ok(refs.every((entry) => entry.article.title !== target.title));
  assert.equal(sameExampleStory(target, { url: "https://syndicated.test/new", title: "Vermont hospitals review their annual operating budgets today" }), true);
  assert.equal(sameExampleStory(target, { url: "https://elsewhere.test/story", title: "Maryland hospital doctors welcome new patients" }), false);
  assert.notEqual(exampleId("https://youtube.com/watch?v=First"), exampleId("https://youtube.com/watch?v=Second"));
  assert.notEqual(exampleId("https://youtube.com/watch?v=CASE"), exampleId("https://youtube.com/watch?v=case"));
  const excluded = buildReferenceExamples(seed, [], { excludedIds: [exampleId(seed.articles[1].url)] });
  assert.ok(excluded.every((row) => row.url !== seed.articles[1].url));
});

test("paired references remain question-specific and never change the candidate article", async () => {
  const rubric = await loadRelevanceRubric(), sentimentRubric = await loadSentimentRubric();
  const base = buildJevRequest(target, rubric, { sentimentRubric });
  const request = addEditorialAlignment(base, target, { examples: buildReferenceExamples(seed), strategy: "atomic-references" });
  assert.deepEqual(request.state, base.state);
  const inclusion = request.questions.include.instructions.reference_examples;
  const sentiment = request.questions.sentiment.instructions.reference_examples;
  assert.ok(inclusion.every((entry) => entry.expected.include === true && entry.expected.sentiment === undefined));
  assert.ok(sentiment.every((entry) => entry.expected.sentiment && entry.expected.include === undefined));
  assert.equal(request.questions.sentiment.instructions.examples.length, 0);
  assert.equal(base.questions.scope_brand, undefined);
  assert.ok(request.questions.scope_policy);
  assert.deepEqual(request.questions.scope_policy.instructions.reference_examples, inclusion);
});

test("atomic scope combines qualifying branches and rejects malformed answers", async () => {
  const rubric = await loadRelevanceRubric();
  const request = buildJevRequest({ ...target, category: "topic", matchedTerms: ["hospital"] }, rubric, { alignment: { strategy: "atomic" } });
  const answers = { include: { type: "noul", noul: 0.1 }, scope_brand: { type: "noul", noul: 0.02 },
    scope_regional: { type: "noul", noul: 0.93 }, scope_policy: { type: "noul", noul: 0.4 } };
  assert.equal(alignedInclusionAnswer(answers, request).noul, 0.93);
  const result = await classifyItemRelevance(target, { rubric, request, callJev: async () => ({ answers }) });
  assert.equal(result.ok, true); assert.equal(result.relevant, true);
  delete answers.scope_policy;
  const invalid = await classifyItemRelevance(target, { rubric, request, callJev: async () => ({ answers }) });
  assert.equal(invalid.ok, false); assert.equal(invalid.relevant, false);
});


test("known story groups prevent leakage across different titles and outlets", () => {
  const storyGroup = "b".repeat(64);
  const storyGroupById = { [exampleId(target.link)]: storyGroup, [exampleId(seed.articles[1].url)]: storyGroup };
  const examples = buildReferenceExamples(seed, [], { storyGroupById });
  const refs = selectReferenceExamples(target, examples, { task: "sentiment", storyGroupById });
  assert.deepEqual(refs.map(row => row.expected.sentiment), ["negative"]);
});

test("production profile sends private human guidance on future requests and versions safe caches", async () => {
  const alignment = await loadAlignmentProfile("src/rubrics/editorial-alignment-v2.json");
  const referenceExamples = buildReferenceExamples(seed);
  const item = { title: "Blue Cross VT launches new member support program", link: "https://new.test/support",
    snippet: "Blue Cross and Blue Shield of Vermont expands support for members.", matchedTerms: ["BCBSVT"], relevant: true, sentiment: "neutral" };
  const calls = [], cache = {}, metrics = {};
  const callJev = async request => {
    calls.push(request);
    return { answers: { include: { type: "noul", noul: 0.2 }, scope_brand: { type: "noul", noul: 0.98 },
      scope_regional: { type: "noul", noul: 0.9 }, scope_policy: { type: "noul", noul: 0.8 },
      sentiment: { type: "choice", choice: "positive", probabilities: { positive: 0.9, "neutral to positive": 0.04, neutral: 0.04, "neutral to negative": 0.01, negative: 0.01 }, confidence: 0.9 } } };
  };
  const options = { env: {}, mode: "shadow", alignment, referenceExamples, callJev, cache, metrics };
  assert.deepEqual(await applyJevRelevance([item], options), [item]);
  assert.equal(metrics.status, "complete");
  assert.equal(metrics.alignmentVersion, "editorial-examples-v2");
  assert.equal(metrics.sentimentReferences, 3);
  assert.ok(calls[0].questions.scope_policy.instructions.reference_examples.length);
  assert.ok(calls[0].questions.sentiment.instructions.reference_examples.length);
  assert.equal(calls[0].state.article.curatedInclusion, false);
  assert.equal(Object.values(cache)[0].include, 0.98);
  assert.equal(Object.values(cache)[0].alignmentVersion, alignment.version);
  assert.doesNotMatch(JSON.stringify(cache), /An award|support program|expected|reference_examples/);
  await applyJevRelevance([item], options);
  assert.equal(calls.length, 1);
  // The cache keys on example ids and labels (#21), so reworded example text is
  // still a hit and a changed label is a miss.
  await applyJevRelevance([item], { ...options, referenceExamples: referenceExamples.map(row => ({ ...row, context: "Updated human explanation" })) });
  assert.equal(calls.length, 1);
  await applyJevRelevance([item], { ...options, referenceExamples: referenceExamples.map(row => ({ ...row, sentiment: row.sentiment === "positive" ? "negative" : row.sentiment })) });
  assert.equal(calls.length, 2);
  assert.deepEqual(normalizeJevCache(cache), cache);
});

test("missing human references stop the aligned pass and preserve existing output", async () => {
  const metrics = {};
  const alignment = await loadAlignmentProfile("src/rubrics/editorial-alignment-v2.json");
  const output = await applyJevRelevance([target], { mode: "enforce", alignment, metrics,
    env: { JEV_EXAMPLES_PATH: "/private/tmp/nonexistent-jev-seed-fixture.json" }, callJev: async () => assert.fail("must not call Jev without references") });
  assert.deepEqual(output, [target]);
  assert.equal(metrics.status, "examples_unavailable");
  assert.equal(metrics.referenceStatus, "missing");
});


test("workflow environment loads references, admits new human examples, and preserves exclusions", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jev-human-reference-"));
  try {
    const profile = await loadAlignmentProfile("src/rubrics/editorial-alignment-v2.json");
    profile.references.excludedIds = [exampleId(seed.articles[0].url)];
    const profilePath = path.join(directory, "profile.json"), seedPath = path.join(directory, "seed.json");
    await writeFile(profilePath, JSON.stringify(profile));
    await writeFile(seedPath, JSON.stringify({ articles: [...seed.articles,
      { url: "https://new.test/human-review", title: "Community coverage review", trackerSentiment: "neutral" }] }));
    const metrics = {};
    await applyJevRelevance([{ title: "Vermont hospital adds new clinic", matchedTerms: ["hospital"], relevant: true }], {
      env: { JEV_RELEVANCE: "shadow", JEV_ALIGNMENT_PROFILE: profilePath, JEV_EXAMPLES_PATH: seedPath }, metrics,
      callJev: async request => {
        const refs = request.questions.scope_regional.instructions.reference_examples;
        assert.ok(refs.some(row => row.article.title === "Community coverage review"));
        assert.ok(refs.every(row => row.article.title !== seed.articles[0].title));
        return { answers: Object.fromEntries(["include", "scope_brand", "scope_regional", "scope_policy"].map(name => [name, { type: "noul", noul: 0.9 }])) };
      },
    });
    assert.equal(metrics.status, "complete");
    assert.equal(metrics.inclusionReferences, 3);
    assert.equal(metrics.sentimentReferences, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the scope questions that decide inclusion carry the shared exclusion rules (#15)", async () => {
  const rubric = await loadRelevanceRubric();
  const premiums = { title: "Missouri consumers could see health insurance premiums rise 26% in 2027",
    link: "https://missourinet.test/premiums", snippet: "Missouri marketplace premium filings.", matchedTerms: ["Health insurance"], category: "topic" };
  const request = addEditorialAlignment(buildJevRequest(premiums, rubric), premiums,
    { examples: buildReferenceExamples(seed), strategy: "atomic-references" });
  for (const name of ["scope_regional", "scope_policy"]) {
    const instructions = request.questions[name].instructions;
    assert.equal(instructions.rules, INCLUSION_RULES);
    assert.equal(instructions.priorities, INCLUSION_PRIORITIES);
    assert.ok(instructions.reference_examples.length);
  }
  const policy = request.questions.scope_policy.instructions.question;
  assert.match(policy, /Another state's own Medicaid administration, marketplace premiums/);
  assert.doesNotMatch(policy, /Any US geography qualifies/);
  assert.match(request.questions.scope_policy.criteria.false, /single state's own program/);
  // Brand scope keeps its own wording; the rules concern regional and national reach.
  assert.equal(typeof request.questions.scope_brand.instructions.question, "string");
  assert.equal(request.questions.scope_brand.instructions.rules, undefined);
});

test("Label Desk rejections become include:false references drawn from the archive", async () => {
  const rejected = { title: "Colorado insurer premiums climb for employer plans", link: "https://colorado.test/premiums?utm_source=x",
    snippet: "A single state's premium filing.", sourceName: "Colorado Test" };
  const alsoRejected = { title: "Celebrity overdose highlights addiction risk", link: "https://celebrity.test/overdose", snippet: "Entertainment news." };
  const unrelated = { title: "Unrelated story left alone", link: "https://other.test/story" };
  const rejectedIds = [exampleId(rejected.link), exampleId(alsoRejected.link), exampleId(seed.articles[1].url), exampleId("https://gone.test/aged-out")];
  const examples = buildReferenceExamples(seed, [rejected, alsoRejected, unrelated, { link: seed.articles[1].url, title: "Insurer wins community award" }], { rejectedIds });
  const rejections = examples.filter((row) => row.include === false);
  // A must-include seed row wins a conflict, and an article no longer archived is skipped.
  assert.deepEqual(rejections.map((row) => row.url).sort(), [alsoRejected.link, rejected.link].sort());
  assert.ok(rejections.every((row) => row.sentiment === null && row.provenance === "human label review"));
  // Retrieval reserves slots so a rejection is shown despite far more inclusions.
  const many = [...examples, ...Array.from({ length: 30 }, (_, index) => ({ id: `id-${index}`, url: `https://kept.test/${index}`,
    title: `Colorado premiums item alpha${index}zz`, outlet: "", excerpt: "", context: "", include: true, sentiment: null }))];
  const candidate = { title: "Colorado insurer premiums climb again next year", link: "https://new.test/colorado" };
  const inclusion = selectReferenceExamples(candidate, many, { task: "inclusion", limit: 8 });
  assert.equal(inclusion.length, 8);
  assert.equal(inclusion.filter((entry) => entry.expected.include === false).length, 2);
  assert.equal(selectReferenceExamples(candidate, many, { task: "sentiment", limit: 16 }).some((entry) => entry.expected.include === false), false);
  // An article is never shown its own rejection.
  const own = selectReferenceExamples(rejected, many, { task: "inclusion", limit: 8 });
  assert.ok(own.every((entry) => entry.article.title !== rejected.title));
  // The committed profile carries the 20 decisions as hashes and nothing else.
  const profile = await loadAlignmentProfile("src/rubrics/editorial-alignment-v2.json");
  assert.equal(profile.references.rejectedIds.length, 20);
  assert.ok(profile.references.rejectedIds.every((id) => /^[a-f0-9]{64}$/.test(id)));
  const directory = await mkdtemp(path.join(tmpdir(), "jev-rejections-"));
  try {
    const bad = path.join(directory, "profile.json");
    await writeFile(bad, JSON.stringify({ ...profile, references: { ...profile.references, rejectedIds: ["https://colorado.test"] } }));
    await assert.rejects(loadAlignmentProfile(bad));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("a human rejection excludes its own article, and Jev leaves it alone", async () => {
  const rejected = { title: "St. Lawrence County hosts Medicare info sessions", link: "https://ny.test/medicare-sessions",
    snippet: "Medicare sessions in New York.", matchedTerms: ["Medicare"], category: "topic", relevant: true,
    reason: "Medicare info sessions in another state.", firstSeenAt: new Date("2026-09-23T00:00:00Z") };
  const clip = { ...rejected, link: "https://ny.test/clip", title: "A tracker clip", fromMediaTracker: true };
  const kept = { ...rejected, link: "https://ny.test/other", title: "Vermont Medicare counseling expands" };
  const alignment = { references: { rejectedIds: [exampleId(rejected.link), exampleId(clip.link)] } };
  const [out, clipOut, keptOut] = await applyHumanRejections([rejected, clip, kept], { alignment });
  assert.equal(out.relevant, false);
  assert.equal(out.reason, HUMAN_REJECTION_REASON);
  // A tracker clip is a human inclusion decision too, and keeps it.
  assert.equal(clipOut, clip);
  assert.equal(keptOut, kept);
  // Without a profile, nothing changes.
  assert.deepEqual(await applyHumanRejections([rejected], { env: {} }), [rejected]);
  const titles = [];
  const [afterJev] = await applyJevRelevance([out], { env: {}, mode: "enforce", enforceAfter: "2026-09-21T00:00:00Z",
    alignment: await loadAlignmentProfile("src/rubrics/editorial-alignment-v2.json"), referenceExamples: buildReferenceExamples(seed),
    callJev: async (request) => { titles.push(request.state.article.title); return {}; } });
  assert.deepEqual(titles, []);
  assert.equal(afterJev.relevant, false);
});

test("the generator applies human rejections on every run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "jev-human-rejection-"));
  try {
    const now = new Date("2026-09-28T12:00:00Z");
    const story = { title: "Vermont hospital budget review", link: "https://vtdigger.org/2026/09/27/budget", sourceName: "VTDigger",
      snippet: "Green Mountain Care Board reviews Vermont hospital budgets.", matchedTerms: ["hospital"], category: "topic",
      summary: "Vermont hospital budgets are under review.", reason: "Hospital budgets.", relevant: true, pubDate: now.toISOString() };
    const paths = { rssOutputPath: path.join(directory, "feed.rss"), jsonOutputPath: path.join(directory, "feed.json"), auditJsonOutputPath: path.join(directory, "feed-audit.json") };
    await writeFile(paths.auditJsonOutputPath, JSON.stringify({ generatedAt: now.toISOString(), items: [story] }));
    const alignment = { references: { rejectedIds: [exampleId(story.link)] } };
    await generateFeed({ sources: [], now, ...paths, jevOptions: { mode: "off", alignment } });
    const audit = JSON.parse(await readFile(paths.auditJsonOutputPath, "utf8"));
    const published = JSON.parse(await readFile(paths.jsonOutputPath, "utf8"));
    assert.equal(audit.items[0].relevant, false);
    assert.equal(audit.items[0].reason, HUMAN_REJECTION_REASON);
    assert.equal(audit.items[0].humanRejected, undefined);
    assert.equal(published.items.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
