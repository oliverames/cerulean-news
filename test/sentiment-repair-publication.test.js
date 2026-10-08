import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildDigest, buildDigestPage, MAIL_FOOTER_TEXT } from "../src/digest.js";
import { buildRss } from "../src/outputs.js";
import { buildStorylinesSummary } from "../src/storylines.js";
import { LIVE_ARTIFACTS, PRESERVED_ARTIFACTS, patchPublicFeed, publishSentimentRepair, validatePublicationAudit } from "../scripts/publish-sentiment-repair.js";

const time = "2026-10-08T13:36:49.427Z";
const digestTime = "2026-10-08T13:20:00.000Z";
const storylineTime = "2026-10-08T13:30:00.000Z";
const key = "a".repeat(64);
const addedKey = "b".repeat(64);
const sha = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const clone = value => structuredClone(value);
const labels = ["positive", "neutral to positive", "neutral", "neutral to negative", "negative"];
const odds = Object.fromEntries(labels.map(label => [label, label === "negative" ? 1 : 0]));
const result = { sentiment: "negative", sentimentConfidence: 0.96, sentimentProbabilities: odds };
const newBaseline = { storyKey: "b".repeat(12), alignmentVersion: "editorial-examples-v2", model: "jev-1.13.0", rubricVersion: "relevance-v2", include: null, localAngle: null, relevanceScore: null, sentimentOnly: true };

function item(link, title, extra = {}) {
  return {
    id: `identifier-${link}`, url: `https://alias.example/${link.split("/").at(-1)}`,
    link, guid: `guid-${link}`, sourceName: "VTDigger", sourceFeedUrl: "https://vtdigger.org/feed/",
    title, pubDate: "2026-10-08T12:00:00.000Z", date_published: "2026-10-08T12:00:00.000Z",
    firstSeenAt: "2026-10-08T12:01:00.000Z", matchedTerms: ["Blue Cross and Blue Shield of Vermont"],
    category: "Blue Cross VT", section: "Blue Cross VT News", sourceType: "News", sentimentEligible: true,
    summary: "Blue Cross VT faces a premium rate review.", snippet: "Blue Cross VT premium rate review.",
    relevant: true, reason: "Existing inclusion authority", sentiment: "neutral", sentimentReason: "Saved original reason", sentimentScore: 50,
    sentimentRubric: "2026-09-24", articleFetchFailed: false, comments: [], ...extra,
  };
}

function protectedAudit(audit, targets) {
  const next = clone(audit);
  const ids = new Set(targets.flatMap(target => target.aliases.map(alias => alias.articleId)));
  for (const entry of next.items) if (ids.has(sha(entry.link))) for (const field of ["sentiment", "sentimentReason", "sentimentScore"]) delete entry[field];
  for (const target of targets) delete next.crawlState.jevCache[target.key];
  return next;
}

function fixtureDocuments({ lostDescription = false } = {}) {
  const audit = {
    generatedAt: time, audit: true, itemCount: 4, totalItemCount: 4, visibleItemCount: 3, rejectedItemCount: 1,
    sources: [{ name: "VTDigger", failureAlertDeliveries: ["existing-delivery"] }],
    crawlMetrics: { jev: { sentimentBackfillPending: 2, requested: 0 } },
    crawlState: {
      jevCache: { [key]: { storyKey: "a".repeat(12), alignmentVersion: "editorial-examples-v2", model: "jev-1.13.0", rubricVersion: "relevance-v2", include: 0.86, localAngle: 0.71, relevanceScore: 8, scopeSignals: { vermont: 0.9 }, sentiment: "neutral", sentimentConfidence: 0.8, retainedMetadata: "keep raw original data" } },
      articleCache: { unchanged: { excerpt: "saved cache" } }, brandAlerts: { delivered: ["alert-id"] },
      monthlyReports: { version: 1, vermontTotals: {}, findings: {} }, jevExamples: { unchanged: true },
      jevStories: ["saved-story-key"], feedback: { version: 1, votes: {} },
    },
    items: [
      item("https://vtdigger.org/2026/10/08/rate-review/", "Blue Cross VT premium rate review"),
      item("https://vtdigger.org/2026/10/07/benefit-update/", "Blue Cross VT benefit update", { pubDate: "2026-10-07T23:00:00.000Z", date_published: "2026-10-07T23:00:00.000Z", summary: "Blue Cross VT announces a benefit update.", ...(lostDescription ? { snippet: "Blue Cross VT benefit update." } : {}) }),
      item("https://vtdigger.org/2026/10/08/rejected/", "Rejected article", { relevant: false, sentimentEligible: undefined }),
      item("https://vtdigger.org/2026/10/08/hospital/", "Hospital update", { matchedTerms: ["UVM Health Network"], category: "Vermont", section: "Vermont Healthcare News", sentimentEligible: undefined, sentiment: undefined, sentimentReason: undefined, sentimentScore: undefined, summary: "UVM Health Network reports a hospital update." }),
    ],
  };
  // Match the JSON serialization boundary: omitted fields stay omitted.
  const original = JSON.parse(JSON.stringify(audit));
  const targets = original.items.slice(0, 2).map((entry, index) => ({
    key: index ? addedKey : key, storyKey: (index ? "b" : "a").repeat(12), alignmentVersion: "editorial-examples-v2", rubricVersion: "relevance-v2",
    originalCacheHash: sha(original.crawlState.jevCache[index ? addedKey : key] ?? null), cacheBaseline: index ? null : clone(original.crawlState.jevCache[key]),
    aliases: [{ articleId: sha(entry.link), articleHash: sha(entry), relevant: true, sentiment: entry.sentiment, feedbackSentiment: false }],
  }));
  const body = { schema: "sentiment-repair-v1", status: "frozen", model: "jev-1.13.0", generatedAt: time, totalArticles: original.items.length,
    targets, targetCount: targets.length, aliasCount: targets.length, protectedSnapshotHash: sha(protectedAudit(original, targets)) };
  const manifest = { ...body, manifestHash: sha(body) };
  const updated = clone(original);
  for (const entry of updated.items.slice(0, 2)) Object.assign(entry, { sentiment: "negative", sentimentReason: "", sentimentScore: 0 });
  Object.assign(updated.crawlState.jevCache[key], clone(result));
  updated.crawlState.jevCache[addedKey] = { ...newBaseline, ...clone(result) };
  const feed = { generatedAt: time, version: "https://jsonfeed.org/version/1.1", home_page_url: "https://cerulean.news/", feed_url: "https://cerulean.news/feed.json", itemCount: 3,
    totalItemCount: 4, visibleItemCount: 3, rejectedItemCount: 1, sources: original.sources, retainedMetadata: { opaque: "unchanged" },
    items: original.items.filter(entry => entry.relevant !== false).map(entry => {
      const next = clone(entry);
      delete next.firstSeenAt;
      return next;
    }) };
  // Nested full item copies test recursive patching, while url/id/guid aliases
  // deliberately differ from the stable article link.
  feed.items[0].relatedItems = [clone(feed.items[0])];
  return { original, updated, manifest, feed };
}

async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cerulean-sentiment-publication-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const siteDir = path.join(directory, "site");
  const repairDir = path.join(directory, "repair");
  await mkdir(siteDir); await mkdir(repairDir);
  const docs = fixtureDocuments(options);
  const runtime = docs.original.items.map((entry, index) => ({ ...entry, pubDate: entry.pubDate ? new Date(entry.pubDate) : null,
    ...(options.lostDescription && index === 1 ? { description: "Source description mentions the Green Mountain Care Board." } : {}) }));
  const mailed = buildDigest(runtime, { now: new Date(digestTime), footer: MAIL_FOOTER_TEXT });
  const plain = buildDigest(runtime, { now: new Date(digestTime) });
  const artifacts = {
    "feed-audit.json": `${JSON.stringify(docs.original)}\n`, "feed.json": `${JSON.stringify(docs.feed, null, 2)}\n`,
    "feed.rss": buildRss(runtime, { now: new Date(time), siteUrl: "https://cerulean.news/", feedUrl: "https://cerulean.news/feed.rss" }),
    "digest.json": `${JSON.stringify({ generatedAt: digestTime, subject: mailed.subject, text: mailed.text, html: mailed.html, sections: mailed.sections, retainedMetadata: "keep" }, null, 2)}\n`,
    "digest.html": buildDigestPage(plain, { generatedAt: digestTime }),
    "storylines.json": `${JSON.stringify(buildStorylinesSummary(runtime, new Date(storylineTime)), null, 2)}\n`,
    "calendar.json": '{"events":[{"title":"Preserve calendar bytes"}]}\n',
    "calendar.ics": "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n",
    "alerts.json": '{"count":1,"html":"Preserve alert bytes","text":"Preserve alert state"}\n',
    "index.html": '<!doctype html><html><head><!-- prerender-jsonld:start --><!-- prerender-jsonld:end --></head><body><div id="reader-sentinel">Existing reader UI</div><!-- prerender:start --><!-- prerender:end --></body></html>\n',
  };
  await Promise.all(Object.entries(artifacts).map(([name, body]) => writeFile(path.join(siteDir, name), body)));
  const updatedAuditPath = path.join(repairDir, "feed-audit.json");
  const receiptPath = path.join(repairDir, "publication.json");
  await writeFile(updatedAuditPath, `${JSON.stringify(docs.updated)}\n`);
  await writeFile(path.join(repairDir, "manifest.json"), `${JSON.stringify(docs.manifest)}\n`);
  return { ...docs, directory, artifacts, siteDir, repairDir, updatedAuditPath, receiptPath };
}

async function assertNoWrites(fixture) {
  for (const [name, body] of Object.entries(fixture.artifacts)) assert.equal(await readFile(path.join(fixture.siteDir, name), "utf8"), body, name);
  assert.deepEqual((await readdir(fixture.siteDir)).sort(), Object.keys(fixture.artifacts).sort(), "no stage or report files remain after a refused publication");
  await assert.rejects(readFile(fixture.receiptPath), { code: "ENOENT" });
}

test("publishes exact audit sentiment into root and recursive feed aliases while freezing all state and clocks", async t => {
  const fixture = await setup(t);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("publication must not access the network"); };
  t.after(() => { globalThis.fetch = oldFetch; });
  const receipt = await publishSentimentRepair(fixture);
  assert.equal(receipt.status, "complete");
  assert.equal(receipt.changedAuditItemCount, 2);
  assert.equal(receipt.changedCacheEntryCount, 2);
  assert.equal(receipt.publicTargetsVerified, 2);
  assert.equal(receipt.publicAliasesPatched, 3);
  assert.equal(receipt.publicAliasesChanged, 3);
  assert.equal(receipt.generatedAt, time);
  assert.equal(receipt.digestGeneratedAt, digestTime);
  assert.equal(receipt.storylinesGeneratedAt, storylineTime);
  const published = JSON.parse(await readFile(path.join(fixture.siteDir, "feed.json"), "utf8"));
  for (const entry of [published.items[0], published.items[0].relatedItems[0], published.items[1]]) {
    assert.equal(entry.sentiment, "negative"); assert.equal(entry.sentimentReason, ""); assert.equal(entry.sentimentScore, 0);
  }
  assert.deepEqual(published.retainedMetadata, fixture.feed.retainedMetadata);
  assert.deepEqual(published.items.map(entry => entry.link), fixture.feed.items.map(entry => entry.link));
  assert.equal(published.items[0].id, fixture.feed.items[0].id);
  assert.equal(published.items[0].url, fixture.feed.items[0].url);
  assert.equal(published.items[0].guid, fixture.feed.items[0].guid);
  assert.equal(await readFile(path.join(fixture.siteDir, "feed-audit.json"), "utf8"), await readFile(fixture.updatedAuditPath, "utf8"));
  for (const name of PRESERVED_ARTIFACTS) assert.equal(await readFile(path.join(fixture.siteDir, name), "utf8"), fixture.artifacts[name], name);
  const rss = await readFile(path.join(fixture.siteDir, "feed.rss"), "utf8");
  assert.ok(rss.includes(`<lastBuildDate>${new Date(time).toUTCString()}</lastBuildDate>`));
  assert.match(rss, /<strong>Sentiment:<\/strong> negative/);
  const digest = JSON.parse(await readFile(path.join(fixture.siteDir, "digest.json"), "utf8"));
  assert.equal(digest.generatedAt, digestTime); assert.equal(digest.retainedMetadata, "keep");
  assert.ok(digest.text.includes("Sentiment: 0 · negative"));
  assert.ok((await readFile(path.join(fixture.siteDir, "index.html"), "utf8")).includes('id="reader-sentinel"'));
  assert.ok((await readdir(path.join(fixture.siteDir, "reports"))).includes("2026-10.html"));
  assert.equal(await readFile(fixture.receiptPath, "utf8"), `${JSON.stringify(receipt, null, 2)}\n`);
  assert.ok(!(await readdir(fixture.siteDir)).some(name => name.startsWith(".sentiment-publication-")));
});

test("a second publication validates the already repaired target cache without losing inclusion metadata", async t => {
  const fixture = await setup(t);
  await publishSentimentRepair(fixture);
  const firstFeed = await readFile(path.join(fixture.siteDir, "feed.json"));
  const receipt = await publishSentimentRepair(fixture);
  assert.equal(receipt.changedAuditItemCount, 0);
  assert.equal(receipt.changedCacheEntryCount, 0);
  assert.equal(receipt.publicAliasesChanged, 0);
  assert.deepEqual(await readFile(path.join(fixture.siteDir, "feed.json")), firstFeed);
  const audit = JSON.parse(await readFile(path.join(fixture.siteDir, "feed-audit.json"), "utf8"));
  assert.equal(audit.crawlState.jevCache[key].include, 0.86);
  assert.deepEqual(audit.crawlState.jevCache[key].scopeSignals, { vermont: 0.9 });
  assert.equal(audit.crawlState.jevCache[key].retainedMetadata, "keep raw original data");
});

test("frozen storyline members survive when their original source description is absent from the audit", async t => {
  const fixture = await setup(t, { lostDescription: true });
  const before = JSON.parse(fixture.artifacts["storylines.json"]);
  const reconstructed = buildStorylinesSummary(fixture.original.items.map(entry => ({ ...entry, pubDate: new Date(entry.pubDate) })), new Date(storylineTime));
  assert.equal(before.storylines[0].total, 2);
  assert.equal(reconstructed.storylines[0].total, 1, "ordinary matcher regeneration reproduces the missing-description problem");
  await publishSentimentRepair(fixture);
  const after = JSON.parse(await readFile(path.join(fixture.siteDir, "storylines.json"), "utf8"));
  assert.equal(after.storylines[0].total, 2);
  assert.deepEqual(after.storylines[0].stories.map(story => [story.url, story.title, story.date, story.outlet]), before.storylines[0].stories.map(story => [story.url, story.title, story.date, story.outlet]));
  assert.deepEqual(after.storylines[0].weeks.map(week => [week.week, week.count]), before.storylines[0].weeks.map(week => [week.week, week.count]));
  assert.equal(after.storylines[0].weeks.at(-1).sentiment.negative, 2);
  assert.equal(after.storylines[0].weeks.at(-1).scored, 2);
});

test("every non-sentiment audit mutation fails before any publication writes", async t => {
  const mutations = {
    inclusion: docs => { docs.updated.items[0].relevant = false; },
    reason: docs => { docs.updated.items[0].reason = "unapproved inclusion"; },
    membership: docs => { docs.updated.items.pop(); },
    order: docs => { docs.updated.items.reverse(); },
    generatedAt: docs => { docs.updated.generatedAt = "2026-10-09T12:00:00.000Z"; },
    sentimentRubric: docs => { docs.updated.items[0].sentimentRubric = "new-rubric"; },
    cacheInclusion: docs => { docs.updated.crawlState.jevCache[key].include = 0.1; },
    cacheScope: docs => { docs.updated.crawlState.jevCache[key].scopeSignals.vermont = 0.1; },
    cacheMetadata: docs => { docs.updated.crawlState.jevCache[key].model = "different-model"; },
    unrelatedCache: docs => { docs.updated.crawlState.jevCache["c".repeat(64)] = clone(newBaseline); },
    alertState: docs => { docs.updated.crawlState.brandAlerts.delivered.push("new-alert"); },
    articleCache: docs => { docs.updated.crawlState.articleCache.unchanged.excerpt = "new excerpt"; },
    feedback: docs => { docs.updated.crawlState.feedback.votes.extra = "keep"; },
    monthlyState: docs => { docs.updated.crawlState.monthlyReports.findings.extra = "new finding"; },
    metric: docs => { docs.updated.crawlMetrics.jev.requested = 2; },
    otherItemSentiment: docs => { docs.updated.items[2].sentiment = "positive"; },
    targetScoreMismatch: docs => { docs.updated.items[0].sentimentScore = 1; },
    targetLabelMismatch: docs => { docs.updated.items[0].sentiment = "positive"; },
    extraProbability: docs => { docs.updated.crawlState.jevCache[key].sentimentProbabilities.extra = 0; },
  };
  for (const [name, mutate] of Object.entries(mutations)) await t.test(name, async t => {
    const fixture = await setup(t); mutate(fixture);
    await writeFile(fixture.updatedAuditPath, `${JSON.stringify(fixture.updated)}\n`);
    await assert.rejects(publishSentimentRepair(fixture));
    await assertNoWrites(fixture);
  });
});

test("new cache entries cannot gain inclusion authority or arbitrary metadata", () => {
  for (const field of ["include", "localAngle", "relevanceScore", "scopeSignals", "sentimentOnly", "unknown"]) {
    const docs = fixtureDocuments();
    docs.updated.crawlState.jevCache[addedKey][field] = field === "scopeSignals" ? { vermont: 1 } : field === "sentimentOnly" ? false : 0.9;
    assert.throws(() => validatePublicationAudit(docs.original, docs.updated, docs.manifest), undefined, field);
  }
});

test("legacy cache migration preserves the manifest's frozen inclusion baseline", () => {
  const docs = fixtureDocuments();
  const baseline = { ...clone(docs.original.crawlState.jevCache[key]), storyKey: "b".repeat(12) };
  docs.manifest.targets[1].cacheBaseline = baseline;
  const { manifestHash, ...contents } = docs.manifest;
  docs.manifest.manifestHash = sha(contents);
  docs.updated.crawlState.jevCache[addedKey] = { ...baseline, ...clone(result) };
  assert.doesNotThrow(() => validatePublicationAudit(docs.original, docs.updated, docs.manifest));
  docs.updated.crawlState.jevCache[addedKey].include = 0.1;
  assert.throws(() => validatePublicationAudit(docs.original, docs.updated, docs.manifest), /migrated target cache baseline changed/);
});

test("public target identity checks fail closed when a title/source changes or a visible target is missing", () => {
  for (const mutation of [feed => { feed.items[0].title = "unrelated article"; }, feed => { feed.items[0].sourceName = "Wrong source"; }, feed => { feed.items.splice(1, 1); }]) {
    const docs = fixtureDocuments(); mutation(docs.feed);
    assert.throws(() => patchPublicFeed(docs.feed, docs.updated, new Set(docs.manifest.targets.flatMap(target => target.aliases.map(alias => alias.articleId)))));
  }
});

test("invalid manifest, missing required live artifact, or derived membership drift leaves the site untouched", async t => {
  for (const scenario of ["manifest", "missing artifact", "digest membership", "storyline membership", "rss serializer", "missing prerender markers"]) await t.test(scenario, async t => {
    const fixture = await setup(t);
    if (scenario === "manifest") { fixture.manifest.targets.pop(); await writeFile(path.join(fixture.repairDir, "manifest.json"), JSON.stringify(fixture.manifest)); }
    if (scenario === "missing artifact") {
      await rm(path.join(fixture.siteDir, "calendar.json"));
      await assert.rejects(publishSentimentRepair(fixture), { code: "ENOENT" });
      for (const name of LIVE_ARTIFACTS.filter(name => name !== "calendar.json")) assert.equal(await readFile(path.join(fixture.siteDir, name), "utf8"), fixture.artifacts[name]);
      return;
    }
    if (scenario === "digest membership") {
      const digest = JSON.parse(fixture.artifacts["digest.json"]); digest.sections[0].entries.pop();
      fixture.artifacts["digest.json"] = JSON.stringify(digest); await writeFile(path.join(fixture.siteDir, "digest.json"), fixture.artifacts["digest.json"]);
    }
    if (scenario === "storyline membership") {
      const storylines = JSON.parse(fixture.artifacts["storylines.json"]); storylines.storylines[0].total += 1;
      fixture.artifacts["storylines.json"] = JSON.stringify(storylines); await writeFile(path.join(fixture.siteDir, "storylines.json"), fixture.artifacts["storylines.json"]);
    }
    if (scenario === "rss serializer") { fixture.artifacts["feed.rss"] = fixture.artifacts["feed.rss"].replace("<ttl>60</ttl>", "<ttl>61</ttl>"); await writeFile(path.join(fixture.siteDir, "feed.rss"), fixture.artifacts["feed.rss"]); }
    if (scenario === "missing prerender markers") { fixture.artifacts["index.html"] = "<html><body>Existing reader</body></html>"; await writeFile(path.join(fixture.siteDir, "index.html"), fixture.artifacts["index.html"]); }
    await assert.rejects(publishSentimentRepair(fixture));
    await assertNoWrites(fixture);
  });
});

test("CLI renders locally using the required named arguments and no credentials", async t => {
  const fixture = await setup(t);
  const completed = spawnSync(process.execPath, ["scripts/publish-sentiment-repair.js", "--site", fixture.siteDir, "--updated-audit", fixture.updatedAuditPath, "--receipt", fixture.receiptPath], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname), encoding: "utf8", timeout: 60_000,
    env: { PATH: process.env.PATH, TZ: "Pacific/Honolulu", TYPESAFE_API_KEY: "SECRET_CANARY_MUST_NOT_APPEAR", SITE_URL: "https://wrong-env.invalid", FEED_URL: "https://wrong-env.invalid/rss" },
  });
  assert.ifError(completed.error);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(JSON.parse(completed.stdout).publicTargetsVerified, 2);
  assert.ok(!`${completed.stdout}${completed.stderr}`.includes("SECRET_CANARY"));
  const rss = await readFile(path.join(fixture.siteDir, "feed.rss"), "utf8");
  assert.ok(!rss.includes("wrong-env.invalid"));
});

test("CLI refusal logs omit document and assertion content", async t => {
  const fixture = await setup(t);
  fixture.artifacts["feed.rss"] = fixture.artifacts["feed.rss"].replace("<ttl>60</ttl>", "<ttl>60</ttl><private>ARTICLE_CANARY_MUST_NOT_APPEAR</private>");
  await writeFile(path.join(fixture.siteDir, "feed.rss"), fixture.artifacts["feed.rss"]);
  const completed = spawnSync(process.execPath, ["scripts/publish-sentiment-repair.js", "--site", fixture.siteDir, "--updated-audit", fixture.updatedAuditPath], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname), encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH },
  });
  assert.ifError(completed.error);
  assert.equal(completed.status, 1);
  assert.equal(completed.stderr.trim(), "Sentiment publication failed: publication_invariant_failed");
  assert.ok(!`${completed.stdout}${completed.stderr}`.includes("ARTICLE_CANARY"));
  await assertNoWrites(fixture);
});
