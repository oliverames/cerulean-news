// Tests for team feedback in the pipeline (src/feedback.js): fetching the
// export, resolving several votes, applying drop, keep, and sentiment, undoing
// them, and the Jev integration. Nothing here touches the network: fetch is a
// stub and Jev is a fake callJev.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FEEDBACK_DROP_REASON,
  FEEDBACK_KEEP_REASON,
  FEEDBACK_SENTIMENT_REASON,
  applyTeamFeedback,
  fetchTeamFeedback,
  mergeFeedbackExamples,
  normalizeFeedbackState,
  parseFeedbackExport,
  resolveVotes,
} from "../src/feedback.js";
import { generateFeed } from "../src/index.js";
import { buildReferenceExamples, exampleId } from "../src/jev-examples.js";
import { loadAlignmentProfile } from "../src/jev-alignment.js";
import { applyJevRelevance } from "../src/jev-relevance.js";

const brand = (n, extra = {}) => ({
  title: `Blue Cross VT member support program ${n}`,
  snippet: "BCBSVT offers member support.",
  link: `https://vtdigger.org/story-${n}`,
  matchedTerms: ["BCBSVT"],
  sourceName: "VTDigger",
  pubDate: new Date("2026-09-20T12:00:00Z"),
  relevant: true,
  reason: "Names the insurer.",
  sentiment: "neutral",
  sentimentReason: "Existing assessment",
  sentimentScore: 52,
  sentimentRubric: "2026-09-24",
  ...extra,
});
const topic = (n, extra = {}) => ({
  title: `Vermont hospital budget review ${n}`,
  snippet: "Vermont hospitals present budgets.",
  link: `https://vtdigger.org/hospital-${n}`,
  matchedTerms: ["hospital"],
  sourceName: "VTDigger",
  pubDate: new Date("2026-09-20T12:00:00Z"),
  relevant: true,
  reason: "Vermont hospitals.",
  ...extra,
});
const idOf = (item) => exampleId(item.link);
const vote = (item, kind, label = null, at = "2026-09-29T10:00:00.000Z") => ({ item: idOf(item), vote: kind, label, at: Date.parse(at) });
const ok = (votes) => ({ status: "ok", votes, invalid: 0 });
const emptyState = () => ({ applied: {} });

// ------------------------------------------------------------------- fetch

function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  impl.calls = calls;
  return impl;
}
const exportBody = (votes) => ({ ok: true, generatedAt: "2026-09-29T10:00:00Z", votes });
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
const env = { FEEDBACK_EXPORT_URL: "https://cerulean.news/api/mail/feedback/export", FEEDBACK_EXPORT_TOKEN: "t".repeat(40) };

test("missing configuration is a no-op and never calls the network", async () => {
  for (const partial of [{}, { FEEDBACK_EXPORT_URL: env.FEEDBACK_EXPORT_URL }, { FEEDBACK_EXPORT_TOKEN: env.FEEDBACK_EXPORT_TOKEN }, { ...env, FEEDBACK_EXPORT_TOKEN: "  " }]) {
    const fetchImpl = fakeFetch(() => assert.fail("no request without both variables"));
    const result = await fetchTeamFeedback({ env: partial, fetchImpl });
    assert.equal(result.status, "unconfigured");
    assert.deepEqual(result.votes, []);
    assert.equal(fetchImpl.calls.length, 0);
  }
  const items = [brand(1)];
  const applied = applyTeamFeedback(items, { status: "unconfigured", votes: [] }, emptyState());
  assert.equal(applied.items, items, "the very same array comes back");
  assert.deepEqual(applied.examples, []);
});

test("the export is fetched with the bearer token and no redirects", async () => {
  const row = { item: "a".repeat(64), vote: "drop", label: null, updatedAt: "2026-09-29T10:00:00.000Z" };
  const fetchImpl = fakeFetch(() => jsonResponse(exportBody([row])));
  const result = await fetchTeamFeedback({ env, fetchImpl });
  assert.equal(result.status, "ok");
  assert.equal(result.votes.length, 1);
  assert.equal(fetchImpl.calls[0].url, env.FEEDBACK_EXPORT_URL);
  assert.equal(fetchImpl.calls[0].init.headers.authorization, `Bearer ${env.FEEDBACK_EXPORT_TOKEN}`);
  assert.equal(fetchImpl.calls[0].init.redirect, "error");
});

test("every failure is logged and returns no votes, without throwing or leaking the token", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const cases = {
      "HTTP 500": () => new Response("no", { status: 500 }),
      "HTTP 401": () => new Response("no", { status: 401 }),
      "not json": () => new Response("<html>", { status: 200 }),
      "wrong shape": () => jsonResponse({ ok: false }),
      "votes not a list": () => jsonResponse({ ok: true, votes: {} }),
      network: () => { throw new TypeError("connect failed"); },
    };
    for (const [name, handler] of Object.entries(cases)) {
      const result = await fetchTeamFeedback({ env, fetchImpl: fakeFetch(handler) });
      assert.equal(result.status, "failed", name);
      assert.deepEqual(result.votes, []);
    }
    for (const badUrl of ["http://cerulean.news/export", "ftp://x.test", "not a url", "file:///etc/passwd"]) {
      const result = await fetchTeamFeedback({ env: { ...env, FEEDBACK_EXPORT_URL: badUrl }, fetchImpl: fakeFetch(() => assert.fail("no request")) });
      assert.equal(result.status, "failed", badUrl);
    }
    const local = await fetchTeamFeedback({ env: { ...env, FEEDBACK_EXPORT_URL: "http://localhost:8787/x" }, fetchImpl: fakeFetch(() => jsonResponse(exportBody([]))) });
    assert.equal(local.status, "ok");
  } finally {
    console.warn = original;
  }
  assert.ok(warnings.length >= 10);
  assert.ok(!warnings.some((line) => line.includes(env.FEEDBACK_EXPORT_TOKEN)), "the token is never logged");
});

test("malformed vote rows are dropped and counted, never guessed at", () => {
  const good = { item: "a".repeat(64), vote: "keep", label: null, updatedAt: "2026-09-29T10:00:00Z" };
  const parsed = parseFeedbackExport(exportBody([
    good,
    { ...good, item: "short" },
    { ...good, item: "A".repeat(64) },
    { ...good, vote: "up" },
    { ...good, vote: "sentiment", label: null },
    { ...good, vote: "sentiment", label: "mixed" },
    { ...good, label: "positive" },
    { ...good, updatedAt: "yesterday" },
    null,
    { ...good, item: "b".repeat(64), vote: "sentiment", label: "negative" },
  ]));
  assert.equal(parsed.votes.length, 2);
  assert.equal(parsed.invalid, 8);
  assert.throws(() => parseFeedbackExport(null));
});

// ----------------------------------------------------------------- resolve

test("the latest vote wins, inclusion and sentiment are separate, and a tie keeps", () => {
  const story = brand(1);
  const resolved = resolveVotes([
    vote(story, "drop", null, "2026-09-29T09:00:00Z"),
    vote(story, "keep", null, "2026-09-29T10:00:00Z"),
    vote(story, "sentiment", "negative", "2026-09-29T09:00:00Z"),
    vote(story, "sentiment", "positive", "2026-09-29T11:00:00Z"),
  ]).get(idOf(story));
  assert.equal(resolved.inclusion.vote, "keep");
  assert.equal(resolved.sentiment.label, "positive");
  const tie = resolveVotes([vote(story, "drop"), vote(story, "keep")]).get(idOf(story));
  assert.equal(tie.inclusion.vote, "keep");
  const tieOther = resolveVotes([vote(story, "keep"), vote(story, "drop")]).get(idOf(story));
  assert.equal(tieOther.inclusion.vote, "keep");
});

// ---------------------------------------------------------- apply and undo

test("drop excludes the item like a human rejection, with its own reason", () => {
  const story = topic(1);
  const other = topic(2);
  const state = emptyState();
  const { items, examples, summary } = applyTeamFeedback([story, other], ok([vote(story, "drop")]), state);
  assert.equal(items[0].relevant, false);
  assert.equal(items[0].reason, FEEDBACK_DROP_REASON);
  assert.equal(items[0].humanRejected, true, "Jev skips it");
  assert.equal(items[1], other, "an unvoted item is untouched");
  assert.equal(summary.drop, 1);
  assert.equal(summary.applied, 1);
  assert.deepEqual(examples.map((example) => [example.id, example.include, example.provenance]), [[idOf(story), false, "team feedback"]]);
  assert.deepEqual(state.applied[idOf(story)].inclusion.baseline, { relevant: true, reason: "Vermont hospitals." });
});

test("keep restores an item a model dropped, and a rule rejection still wins", () => {
  const modelDropped = topic(1, { relevant: false, reason: "Not about Vermont." });
  const obituary = topic(2, { title: "Obituary: Jane Doe, 88, of Burlington", relevant: false, reason: "Obituary." });
  const jobBoard = topic(3, { title: "Registered Nurse - Burlington, VT", link: "https://www.indeed.com/viewjob?jk=1", sourceName: "Indeed", relevant: false, reason: "Job listing." });
  const state = emptyState();
  const { items, examples, summary } = applyTeamFeedback(
    [modelDropped, obituary, jobBoard],
    ok([vote(modelDropped, "keep"), vote(obituary, "keep"), vote(jobBoard, "keep")]),
    state,
  );
  assert.equal(items[0].relevant, true);
  assert.equal(items[0].reason, FEEDBACK_KEEP_REASON);
  assert.equal(items[0].feedbackKept, true);
  assert.equal(items[1].relevant, false, "an obituary stays out");
  assert.equal(items[2].relevant, false, "a job board stays out");
  assert.equal(summary.keep, 1);
  assert.equal(summary.blockedByRule, 2);
  assert.deepEqual(examples.map((example) => [example.id, example.include]), [[idOf(modelDropped), true]]);
  assert.deepEqual(Object.keys(state.applied), [idOf(modelDropped)]);
});

test("keep on an item that is already in leaves its reason alone", () => {
  const story = topic(1);
  const { items } = applyTeamFeedback([story], ok([vote(story, "keep")]), emptyState());
  assert.equal(items[0].relevant, true);
  assert.equal(items[0].reason, "Vermont hospitals.");
  assert.equal(items[0].feedbackKept, true);
});

test("sentiment replaces the published label and clears Jev's score", () => {
  const story = brand(1);
  const state = emptyState();
  const { items, examples, summary } = applyTeamFeedback([story], ok([vote(story, "sentiment", "negative")]), state);
  assert.equal(items[0].sentiment, "negative");
  assert.equal(items[0].sentimentReason, FEEDBACK_SENTIMENT_REASON);
  assert.equal(items[0].sentimentScore, undefined);
  assert.equal(items[0].feedbackSentiment, true);
  assert.equal(summary.sentiment, 1);
  assert.equal(examples[0].sentiment, "negative");
  assert.equal(examples[0].include, true);
  assert.deepEqual(state.applied[idOf(story)].sentiment.baseline, {
    sentiment: "neutral", sentimentReason: "Existing assessment", sentimentScore: 52, sentimentRubric: "2026-09-24" });
});

test("a sentiment vote on a story that cannot carry sentiment does nothing", () => {
  const story = topic(1);
  const state = emptyState();
  const { items, summary } = applyTeamFeedback([story], ok([vote(story, "sentiment", "negative")]), state);
  assert.equal(items[0].sentiment, undefined);
  assert.equal(summary.ineligibleSentiment, 1);
  assert.deepEqual(state.applied, {});
});

test("a tracker clip keeps its inclusion against a drop", () => {
  const clip = topic(1, { fromMediaTracker: true });
  const { items, summary, examples } = applyTeamFeedback([clip], ok([vote(clip, "drop")]), emptyState());
  assert.equal(items[0], clip);
  assert.equal(summary.ignoredTracker, 1);
  assert.deepEqual(examples, [], "no rejection example against a hand-vetted clip");
});

test("undoing a drop restores the item on the next run", () => {
  const story = topic(1);
  const state = emptyState();
  const first = applyTeamFeedback([story], ok([vote(story, "drop")]), state);
  // The archive keeps the excluded copy, without the transient flag.
  const archived = { ...first.items[0] };
  delete archived.humanRejected;
  const again = applyTeamFeedback([archived], ok([vote(story, "drop")]), state);
  assert.equal(again.items[0].relevant, false, "an unchanged vote keeps holding");
  assert.equal(again.summary.applied, 0, "and is not counted as new");
  const undone = applyTeamFeedback([again.items[0]], ok([]), state);
  assert.equal(undone.items[0].relevant, true);
  assert.equal(undone.items[0].reason, "Vermont hospitals.");
  assert.equal(undone.items[0].humanRejected, undefined);
  assert.equal(undone.summary.reverted, 1);
  assert.deepEqual(state.applied, {});
});

test("undoing a keep puts the model's drop back", () => {
  const story = topic(1, { relevant: false, reason: "Not about Vermont." });
  const state = emptyState();
  const kept = applyTeamFeedback([story], ok([vote(story, "keep")]), state);
  const undone = applyTeamFeedback(kept.items, ok([]), state);
  assert.equal(undone.items[0].relevant, false);
  assert.equal(undone.items[0].reason, "Not about Vermont.");
  assert.equal(undone.items[0].feedbackKept, undefined);
});

test("undoing a sentiment correction restores the label, reason, score, and rubric", () => {
  const story = brand(1);
  const state = emptyState();
  const changed = applyTeamFeedback([story], ok([vote(story, "sentiment", "negative")]), state);
  const undone = applyTeamFeedback(changed.items, ok([]), state);
  assert.equal(undone.items[0].sentiment, "neutral");
  assert.equal(undone.items[0].sentimentReason, "Existing assessment");
  assert.equal(undone.items[0].sentimentScore, 52);
  assert.equal(undone.items[0].sentimentRubric, "2026-09-24");
  assert.equal(undone.items[0].feedbackSentiment, undefined);
});

test("changing a vote from drop to keep restores first, then applies the new one", () => {
  const story = topic(1);
  const state = emptyState();
  const dropped = applyTeamFeedback([story], ok([vote(story, "drop")]), state);
  const kept = applyTeamFeedback(dropped.items, ok([vote(story, "keep", null, "2026-09-30T10:00:00Z")]), state);
  assert.equal(kept.items[0].relevant, true);
  assert.equal(kept.items[0].humanRejected, undefined);
  assert.equal(kept.items[0].feedbackKept, true);
  assert.equal(state.applied[idOf(story)].inclusion.vote, "keep");
  assert.equal(state.applied[idOf(story)].inclusion.baseline.relevant, true, "the baseline is the original, not the drop");
});

test("a failed fetch re-asserts what is applied and never reverts it", () => {
  const story = topic(1);
  const state = emptyState();
  const first = applyTeamFeedback([story], ok([vote(story, "drop")]), state);
  const archived = { ...first.items[0] };
  delete archived.humanRejected;
  const during = applyTeamFeedback([archived], { status: "failed", votes: [] }, state);
  assert.equal(during.items[0].relevant, false);
  assert.equal(during.items[0].humanRejected, true, "Jev still skips it");
  assert.equal(during.summary.reverted, 0);
  assert.equal(state.applied[idOf(story)].inclusion.vote, "drop");
});

test("state for stories that left the archive is dropped, and a vote for one is counted", () => {
  const gone = topic(1);
  const here = topic(2);
  const state = emptyState();
  applyTeamFeedback([gone, here], ok([vote(gone, "drop"), vote(here, "drop")]), state);
  assert.equal(Object.keys(state.applied).length, 2);
  const { summary } = applyTeamFeedback([here], ok([vote(gone, "drop"), vote(here, "drop")]), state);
  assert.deepEqual(Object.keys(state.applied), [idOf(here)]);
  assert.equal(summary.unmatched, 1);
});

test("the applied state survives the audit file and rejects junk", () => {
  const story = brand(1);
  const state = emptyState();
  applyTeamFeedback([story], ok([vote(story, "drop"), vote(story, "sentiment", "positive")]), state);
  const roundTripped = normalizeFeedbackState(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(roundTripped, state);
  assert.deepEqual(normalizeFeedbackState(undefined), { applied: {} });
  assert.deepEqual(normalizeFeedbackState({ applied: { nothash: { inclusion: { vote: "drop", baseline: {} } } } }), { applied: {} });
  assert.deepEqual(normalizeFeedbackState({ applied: { [idOf(story)]: { inclusion: { vote: "maybe", baseline: {} } } } }), { applied: {} });
  assert.deepEqual(normalizeFeedbackState({ applied: { [idOf(story)]: { sentiment: { label: "mixed", baseline: {} } } } }), { applied: {} });
  assert.equal(JSON.stringify(state).includes("@"), false);
});

test("team examples override the seed's label for a story and keep its context", () => {
  const story = brand(1);
  const seed = buildReferenceExamples({ articles: [{ url: story.link, title: story.title, trackerSentiment: "positive", topic: "Our program" }] });
  const { examples } = applyTeamFeedback([story], ok([vote(story, "sentiment", "negative")]), emptyState());
  const merged = mergeFeedbackExamples(seed, examples);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sentiment, "negative");
  assert.equal(merged[0].context, "Our program");
  assert.match(merged[0].provenance, /team feedback/);
  const drop = applyTeamFeedback([story], ok([vote(story, "drop")]), emptyState()).examples;
  const dropped = mergeFeedbackExamples(seed, drop);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].include, false);
  assert.equal(mergeFeedbackExamples(seed, []), seed);
});

// -------------------------------------------------------- Jev integration

const cutoff = "2026-09-21T18:00:00.000Z";
const now = new Date("2026-09-29T12:00:00Z");
const LABELS = ["positive", "neutral to positive", "neutral", "neutral to negative", "negative"];
const answer = (include = 0.98, choice = "positive") => ({ answers: {
  include: { type: "noul", noul: include }, scope_brand: { type: "noul", noul: include },
  scope_regional: { type: "noul", noul: include }, scope_policy: { type: "noul", noul: include },
  sentiment: { type: "choice", choice, confidence: 0.95, probabilities: Object.fromEntries(
    LABELS.map((label) => [label, label === choice ? 0.96 : 0.01])) } } });

async function jevOptions(extra = {}) {
  return { env: {}, mode: "enforce", enforceAfter: cutoff, now, alignment: await loadAlignmentProfile("src/rubrics/editorial-alignment-v2.json"),
    referenceExamples: buildReferenceExamples({ articles: [{ url: "https://example.test/award", title: "Blue Cross community award", trackerSentiment: "positive" }] }),
    ...extra };
}

test("Jev cannot drop a team keep, cannot relabel a team correction, and skips a team drop", async () => {
  const keepMe = topic(1, { relevant: false, reason: "Not about Vermont.", firstSeenAt: now });
  const relabel = brand(2, { firstSeenAt: now });
  const dropMe = topic(3, { firstSeenAt: now });
  const control = brand(4, { firstSeenAt: now });
  const state = emptyState();
  const feedback = applyTeamFeedback(
    [keepMe, relabel, dropMe, control],
    ok([vote(keepMe, "keep"), vote(relabel, "sentiment", "negative"), vote(dropMe, "drop")]),
    state,
  );
  const asked = [];
  const result = await applyJevRelevance(feedback.items, await jevOptions({
    feedbackExamples: feedback.examples,
    // Jev is sure the kept story is out, and sure the corrected story is positive.
    callJev: async (request) => { asked.push(request.state.article.title); return request.state.article.title.includes("hospital") ? answer(0.02) : answer(0.98, "positive"); },
  }));
  assert.equal(result[0].relevant, true, "the keep stands against a confident exclusion");
  assert.equal(result[1].sentiment, "negative", "the correction stands against a confident label");
  assert.equal(result[1].sentimentScore, undefined, "Jev's score stays off the team's label");
  assert.equal(result[2].relevant, false);
  assert.ok(!asked.includes(dropMe.title), "a team drop is never sent to Jev");
  assert.equal(result[3].sentiment, "positive", "an unvoted story still takes Jev's confident label");
  assert.equal(result[3].sentimentScore, 98);
});

test("without the flags Jev does overrule the same items, so the tests above bite", async () => {
  const story = topic(1, { relevant: true, reason: "Vermont hospitals.", firstSeenAt: now });
  const result = await applyJevRelevance([story], await jevOptions({ callJev: async () => answer(0.02) }));
  assert.equal(result[0].relevant, false);
});

test("team votes reach Jev as references", async () => {
  const dropMe = topic(1, { title: "Vermont hospital budget review", firstSeenAt: now });
  const keepMe = brand(2, { title: "Blue Cross VT member support program keep", firstSeenAt: now });
  const target = brand(9, { title: "Vermont hospital budget review and member support", link: "https://vtdigger.org/target", firstSeenAt: now });
  const feedback = applyTeamFeedback([dropMe, keepMe, target], ok([vote(dropMe, "drop"), vote(keepMe, "sentiment", "negative")]), emptyState());
  const requests = [];
  const metrics = {};
  await applyJevRelevance(feedback.items, await jevOptions({ metrics, feedbackExamples: feedback.examples,
    callJev: async (request) => { requests.push(request); return answer(); } }));
  assert.equal(metrics.feedbackReferences, 2);
  const forTarget = requests.find((request) => request.state.article.title === target.title);
  const shown = JSON.stringify(forTarget);
  assert.match(shown, /Vermont hospital budget review/);
  assert.match(shown, /"include":false/);
  assert.match(shown, /"sentiment":"negative"/);
  assert.match(shown, /team feedback/);
});

// ------------------------------------------------------------- end to end

test("the generator applies votes each run and undoes them when the vote goes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "team-feedback-"));
  const originalFetch = globalThis.fetch;
  const saved = { url: process.env.FEEDBACK_EXPORT_URL, token: process.env.FEEDBACK_EXPORT_TOKEN };
  try {
    const runNow = new Date("2026-09-29T12:00:00Z");
    const paths = { rssOutputPath: path.join(directory, "feed.rss"), jsonOutputPath: path.join(directory, "feed.json"), auditJsonOutputPath: path.join(directory, "feed-audit.json") };
    const hospital = { ...topic(1), summary: "Hospital budgets.", pubDate: runNow.toISOString() };
    const insurer = { ...brand(2), summary: "A program.", pubDate: runNow.toISOString() };
    await writeFile(paths.auditJsonOutputPath, JSON.stringify({ generatedAt: runNow.toISOString(), items: [hospital, insurer] }));
    process.env.FEEDBACK_EXPORT_URL = env.FEEDBACK_EXPORT_URL;
    process.env.FEEDBACK_EXPORT_TOKEN = env.FEEDBACK_EXPORT_TOKEN;
    const run = async (votes) => {
      globalThis.fetch = async () => jsonResponse(exportBody(votes.map((row) => ({ item: row.item, vote: row.vote, label: row.label, updatedAt: new Date(row.at).toISOString() }))));
      const result = await generateFeed({ sources: [], now: runNow, ...paths, jevOptions: { mode: "off" } });
      return { result, audit: JSON.parse(await readFile(paths.auditJsonOutputPath, "utf8")), published: JSON.parse(await readFile(paths.jsonOutputPath, "utf8")) };
    };
    const byLink = (audit, link) => audit.items.find((item) => item.link === link);

    const voted = await run([vote(hospital, "drop"), vote(insurer, "sentiment", "negative")]);
    assert.equal(byLink(voted.audit, hospital.link).relevant, false);
    assert.equal(byLink(voted.audit, hospital.link).reason, FEEDBACK_DROP_REASON);
    assert.equal(byLink(voted.audit, insurer.link).sentiment, "negative");
    assert.deepEqual(voted.published.items.map((item) => item.link), [insurer.link], "the dropped story leaves the public feed");
    assert.equal(voted.published.items[0].sentiment, "negative");
    assert.equal(voted.result.crawlMetrics.feedback.drop, 1);
    assert.equal(voted.result.crawlMetrics.feedback.sentiment, 1);
    assert.equal(voted.audit.crawlState.feedback.applied[idOf(hospital)].inclusion.vote, "drop");
    assert.equal(JSON.stringify(voted.audit).includes("@"), false);

    const held = await run([vote(hospital, "drop"), vote(insurer, "sentiment", "negative")]);
    assert.equal(held.result.crawlMetrics.feedback.applied, 0, "the same votes are not counted again");
    assert.equal(byLink(held.audit, hospital.link).relevant, false);

    globalThis.fetch = async () => { throw new TypeError("offline"); };
    const offline = await generateFeed({ sources: [], now: runNow, ...paths, jevOptions: { mode: "off" } });
    assert.equal(offline.crawlMetrics.feedback.status, "failed");
    assert.equal(offline.items.find((item) => item.link === hospital.link).relevant, false, "a failed fetch reverts nothing");

    const undone = await run([]);
    assert.equal(byLink(undone.audit, hospital.link).relevant, true);
    assert.equal(byLink(undone.audit, hospital.link).reason, "Vermont hospitals.");
    assert.equal(byLink(undone.audit, insurer.link).sentiment, "neutral");
    assert.equal(byLink(undone.audit, insurer.link).sentimentScore, 52);
    assert.equal(undone.published.items.length, 2);
    assert.deepEqual(undone.audit.crawlState.feedback.applied, {});
    assert.equal(undone.result.crawlMetrics.feedback.reverted, 2);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of [["FEEDBACK_EXPORT_URL", saved.url], ["FEEDBACK_EXPORT_TOKEN", saved.token]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("a run with no feedback configuration matches a run without the feature", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "team-feedback-off-"));
  const saved = { url: process.env.FEEDBACK_EXPORT_URL, token: process.env.FEEDBACK_EXPORT_TOKEN };
  try {
    const runNow = new Date("2026-09-29T12:00:00Z");
    const paths = { rssOutputPath: path.join(directory, "feed.rss"), jsonOutputPath: path.join(directory, "feed.json"), auditJsonOutputPath: path.join(directory, "feed-audit.json") };
    const story = { ...topic(1), summary: "Hospital budgets.", pubDate: runNow.toISOString() };
    await writeFile(paths.auditJsonOutputPath, JSON.stringify({ generatedAt: runNow.toISOString(), items: [story] }));
    delete process.env.FEEDBACK_EXPORT_URL;
    delete process.env.FEEDBACK_EXPORT_TOKEN;
    const result = await generateFeed({ sources: [], now: runNow, ...paths, jevOptions: { mode: "off" } });
    assert.equal(result.crawlMetrics.feedback.status, "unconfigured");
    assert.equal(result.items[0].relevant, true);
  } finally {
    for (const [key, value] of [["FEEDBACK_EXPORT_URL", saved.url], ["FEEDBACK_EXPORT_TOKEN", saved.token]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});
