#!/usr/bin/env node
// Render an already evaluated, frozen sentiment repair. No crawler, model,
// alerts, mailer, or mutable state refresh is invoked by this publication path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { buildDigest, buildDigestPage, MAIL_FOOTER_TEXT } from "../src/digest.js";
import { normalizeJevCache, SENTIMENT_CONFIDENCE_THRESHOLD, sentimentScoreFromProbabilities } from "../src/jev-relevance.js";
import { buildMonthlyReportPages } from "../src/monthly-report.js";
import { buildRss } from "../src/outputs.js";
import { injectPrerender } from "../src/prerender.js";
import { shouldScoreSentiment } from "../src/summaries.js";

export const LIVE_ARTIFACTS = ["feed-audit.json", "feed.json", "feed.rss", "digest.json", "digest.html", "storylines.json", "calendar.json", "calendar.ics", "alerts.json"];
export const PRESERVED_ARTIFACTS = ["calendar.json", "calendar.ics", "alerts.json"];
const ITEM_FIELDS = ["sentiment", "sentimentReason", "sentimentScore"];
const CACHE_FIELDS = ["sentiment", "sentimentConfidence", "sentimentProbabilities"];
const LABELS = ["positive", "neutral to positive", "neutral", "neutral to negative", "negative"];
const sha = value => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
const jsonValue = value => JSON.parse(JSON.stringify(value));
const articleId = item => sha(item?.link || item?.url || "");
const without = (value, fields) => Object.fromEntries(Object.entries(value).filter(([key]) => !fields.includes(key)));
const same = (left, right, message) => assert.ok(isDeepStrictEqual(jsonValue(left), jsonValue(right)), message);

function date(value, label) {
  const parsed = typeof value === "string" && value ? new Date(value) : null;
  assert.ok(parsed && Number.isFinite(parsed.valueOf()), `${label} must contain its original generation time`);
  return parsed;
}

function auditIndex(audit) {
  assert.ok(Array.isArray(audit?.items), "audit items must be an array");
  const byId = new Map();
  for (const item of audit.items) {
    assert.ok(item && typeof item.link === "string" && item.link, "every audit item requires a stable link");
    const id = articleId(item);
    assert.ok(!byId.has(id), "audit article identities must be unique");
    byId.set(id, item);
  }
  return byId;
}

function protectedAudit(audit, manifest) {
  const next = structuredClone(audit);
  const ids = new Set(manifest.targets.flatMap(target => target.aliases.map(alias => alias.articleId)));
  for (const item of next.items) if (ids.has(articleId(item))) for (const field of ITEM_FIELDS) delete item[field];
  for (const target of manifest.targets) delete next.crawlState?.jevCache?.[target.key];
  return next;
}

// The manifest is a typed local sidecar; it contains hashes and cache baselines,
// never the private article/reference payloads. The apply stage independently
// proves the model results; this stage proves the output's publication scope.
export function validatePublicationAudit(original, updated, manifest) {
  assert.equal(manifest?.schema, "sentiment-repair-v1", "a frozen repair manifest is required");
  assert.equal(manifest.status, "frozen", "the repair manifest must be frozen");
  assert.equal(manifest.model, "jev-1.13.0", "unexpected repair model");
  assert.ok(Array.isArray(manifest.targets), "manifest targets must be an array");
  const { manifestHash, ...contents } = manifest;
  assert.equal(sha(contents), manifestHash, "repair manifest hash mismatch");
  assert.equal(original.generatedAt, manifest.generatedAt, "audit generation time changed after the freeze");
  assert.equal(updated.generatedAt, original.generatedAt, "a repair must preserve audit generation time");
  assert.equal(original.items?.length, manifest.totalArticles, "frozen archive membership changed");
  const originals = auditIndex(original);
  const updates = auditIndex(updated);
  assert.equal(updates.size, originals.size, "a repair must preserve archive membership");
  assert.ok(original.crawlState?.jevCache && updated.crawlState?.jevCache, "both audits require a Jev cache");
  const targetIds = new Set();
  const keys = new Set();
  for (const target of manifest.targets) {
    assert.match(target.key || "", /^[a-f0-9]{64}$/, "invalid target cache key");
    assert.match(target.storyKey || "", /^[a-f0-9]{12}$/, "invalid target story key");
    assert.ok(!keys.has(target.key), "duplicate target cache key");
    keys.add(target.key);
    assert.ok(Array.isArray(target.aliases) && target.aliases.length, "target aliases are required");
    for (const alias of target.aliases) {
      assert.match(alias.articleId || "", /^[a-f0-9]{64}$/, "invalid target article identity");
      assert.ok(!targetIds.has(alias.articleId), "duplicate target article identity");
      targetIds.add(alias.articleId);
      const oldItem = originals.get(alias.articleId);
      const newItem = updates.get(alias.articleId);
      assert.ok(oldItem && newItem, "a target article is missing");
      same(without(oldItem, ITEM_FIELDS), without(newItem, ITEM_FIELDS), "target article protected fields changed");
      if (newItem.sentiment != null) assert.ok(LABELS.includes(newItem.sentiment), "invalid target sentiment label");
      if (Object.hasOwn(newItem, "sentimentScore")) assert.ok(Number.isFinite(newItem.sentimentScore) && newItem.sentimentScore >= 0 && newItem.sentimentScore <= 100, "invalid target sentiment score");
      if (Object.hasOwn(newItem, "sentimentReason")) assert.equal(typeof newItem.sentimentReason, "string", "invalid target sentiment reason");
      if (alias.feedbackSentiment) same(oldItem, newItem, "human sentiment must remain unchanged");
    }
    const before = original.crawlState.jevCache[target.key];
    const after = updated.crawlState.jevCache[target.key];
    const cacheChanged = JSON.stringify(before) !== JSON.stringify(after);
    const articlesChanged = target.aliases.some(alias => JSON.stringify(originals.get(alias.articleId)) !== JSON.stringify(updates.get(alias.articleId)));
    if (cacheChanged || articlesChanged) {
      assert.ok(after, "a repair must not remove a target cache entry");
      const normalized = normalizeJevCache({ [target.key]: after })[target.key];
      assert.ok(normalized?.sentimentProbabilities, "target cache requires validated sentiment odds");
      assert.equal(Object.keys(after.sentimentProbabilities).length, LABELS.length, "target cache odds must contain exactly the five sentiment labels");
      assert.ok(LABELS.every(label => after.sentimentProbabilities[label] <= after.sentimentProbabilities[after.sentiment]), "target cache label must have maximum probability");
      if (before) {
        same(without(before, CACHE_FIELDS), without(after, CACHE_FIELDS), "target cache inclusion or metadata changed");
      } else if (target.cacheBaseline) {
        // Legacy entries may be migrated under a new key. Their saved inclusion
        // authority is copied exactly from the frozen, normalized baseline.
        same(without(target.cacheBaseline, CACHE_FIELDS), without(after, CACHE_FIELDS), "migrated target cache baseline changed");
      } else {
        same(without(after, CACHE_FIELDS), {
          storyKey: target.storyKey,
          ...(target.alignmentVersion ? { alignmentVersion: target.alignmentVersion } : {}),
          model: "jev-1.13.0", rubricVersion: target.rubricVersion || "relevance-v2",
          include: null, localAngle: null, relevanceScore: null, sentimentOnly: true,
        }, "a new cache entry must carry sentiment only");
      }
      if (after.storyKey != null) assert.equal(after.storyKey, target.storyKey, "target cache story identity changed");
      for (const alias of target.aliases) {
        const oldItem = originals.get(alias.articleId);
        const newItem = updates.get(alias.articleId);
        if (alias.feedbackSentiment || !shouldScoreSentiment(oldItem)) {
          same(oldItem, newItem, "an ineligible or human-scored target must remain unchanged");
        } else {
          if (after.sentimentConfidence >= SENTIMENT_CONFIDENCE_THRESHOLD) {
            assert.equal(newItem.sentiment, after.sentiment, "target label differs from its confident cached result");
            assert.equal(newItem.sentimentReason, "", "a confident repair must clear the superseded sentiment reason");
          } else {
            assert.equal(newItem.sentiment, oldItem.sentiment, "low-confidence sentiment must preserve the current label");
            assert.equal(newItem.sentimentReason, oldItem.sentimentReason, "low-confidence sentiment must preserve the current reason");
          }
          if (newItem.sentiment) assert.equal(newItem.sentimentScore, sentimentScoreFromProbabilities(after.sentimentProbabilities), "target score differs from its cached sentiment odds");
        }
      }
    }
  }
  const oldProtected = protectedAudit(original, manifest);
  const newProtected = protectedAudit(updated, manifest);
  assert.equal(sha(oldProtected), manifest.protectedSnapshotHash, "original protected audit differs from the frozen snapshot");
  assert.equal(sha(newProtected), manifest.protectedSnapshotHash, "updated protected audit differs from the frozen snapshot");
  same(oldProtected, newProtected, "audit protected fields changed");
  return { originals, updates, targetIds, keys };
}

function copySentiment(destination, item, fields = ITEM_FIELDS) {
  for (const field of fields) {
    if (Object.hasOwn(item, field)) destination[field] = item[field];
    else delete destination[field];
  }
}

// A public feed can contain copies below related/group entries. Match their
// stable link and verify any supplied source/title before changing each copy.
export function patchPublicFeed(feed, updatedAudit, targetIds) {
  assert.ok(Array.isArray(feed?.items), "public feed items must be an array");
  const targets = new Map(updatedAudit.items.filter(item => targetIds.has(articleId(item))).map(item => [item.link, item]));
  const next = structuredClone(feed);
  const occurrences = new Map();
  let patched = 0;
  let changed = 0;
  function visit(value) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const entry of value) visit(entry); return; }
    const link = value.link || value.url;
    const target = typeof link === "string" ? targets.get(link) : undefined;
    if (target) {
      if (Object.hasOwn(value, "sourceName")) assert.equal(value.sourceName, target.sourceName, "public target source changed");
      if (Object.hasOwn(value, "title")) assert.equal(value.title, target.title, "public target title changed");
      assert.notEqual(target.relevant, false, "a rejected target must not occur in the public feed");
      const before = JSON.stringify(ITEM_FIELDS.map(field => [field, Object.hasOwn(value, field), value[field]]));
      copySentiment(value, target);
      if (JSON.stringify(ITEM_FIELDS.map(field => [field, Object.hasOwn(value, field), value[field]])) !== before) changed += 1;
      occurrences.set(articleId(target), (occurrences.get(articleId(target)) || 0) + 1);
      patched += 1;
    }
    for (const entry of Object.values(value)) visit(entry);
  }
  visit(next.items);
  for (const [id, target] of [...targets.values()].map(item => [articleId(item), item])) {
    if (target.relevant !== false) assert.ok(occurrences.has(id), "a visible target is missing from the public feed");
  }
  // Retain every other field, including timestamps, grouping, related entries,
  // and root metadata. This independent mask catches accidental wide rewrites.
  function protectedFeed(value) {
    if (Array.isArray(value)) return value.map(protectedFeed);
    if (!value || typeof value !== "object") return value;
    const target = targets.get(value.link || value.url);
    return Object.fromEntries(Object.entries(value).filter(([key]) => !(target && ITEM_FIELDS.includes(key))).map(([key, entry]) => [key, protectedFeed(entry)]));
  }
  same(protectedFeed(feed), protectedFeed(next), "public feed protected fields changed");
  function verify(value) {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      const target = targets.get(value.link || value.url);
      if (target) for (const field of ITEM_FIELDS) {
        assert.equal(Object.hasOwn(value, field), Object.hasOwn(target, field), `public ${field} presence differs from the audit`);
        assert.equal(value[field], target[field], `public ${field} differs from the audit`);
      }
    }
    for (const entry of Object.values(value)) verify(entry);
  }
  verify(next.items);
  return { feed: next, patched, changed, verifiedTargets: occurrences.size, occurrences };
}

function runtimeItems(audit) {
  // Do not run archive normalization: it can change labels, snippets and
  // membership. The RSS serializer specifically requires Date instances.
  return audit.items.map(item => ({
    ...item,
    pubDate: item.pubDate == null ? null : date(item.pubDate, "article publication date"),
    articleError: item.articleFetchFailed ? "unavailable" : item.articleError || "",
  }));
}

function xmlValue(value) {
  return value.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
}

function rssOptions(rss, feed, now) {
  const channel = rss.split(/<item\b/)[0];
  const siteUrl = xmlValue(channel.match(/<link>([^]*?)<\/link>/)?.[1] || feed.home_page_url || "");
  const feedUrl = xmlValue(channel.match(/<atom:link\b[^>]*\bhref="([^"]*)"/)?.[1] || "");
  assert.ok(siteUrl && feedUrl, "the original RSS must preserve its channel and self URLs");
  return { now, siteUrl, feedUrl };
}

function digestProtected(digest) {
  return { generatedAt: digest.generatedAt, subject: digest.subject, sections: digest.sections.map(section => ({ ...section, entries: section.entries.map(entry => without(entry, ITEM_FIELDS)) })) };
}

function storylinesProtected(summary) {
  return { ...summary, storylines: summary.storylines.map(entry => ({
    ...entry,
    weeks: entry.weeks.map(week => without(week, ["sentiment", "scored"])),
    stories: entry.stories.map(story => without(story, ITEM_FIELDS)),
  })) };
}

function weekKey(value) {
  if (value == null) return null;
  const published = date(value, "storyline story publication date");
  published.setUTCHours(0, 0, 0, 0);
  published.setUTCDate(published.getUTCDate() - ((published.getUTCDay() + 6) % 7));
  return published.toISOString().slice(0, 10);
}

function frozenWeekSentiments(stories) {
  const weeks = new Map();
  for (const story of stories) {
    const week = weekKey(story.date);
    if (!week || !LABELS.includes(story.sentiment)) continue;
    const bucket = weeks.get(week) || { scored: 0, sentiment: {} };
    bucket.scored += 1;
    bucket.sentiment[story.sentiment] = (bucket.sentiment[story.sentiment] || 0) + 1;
    weeks.set(week, bucket);
  }
  return weeks;
}

// Re-run the sentiment rollup over the frozen timeline membership. Source
// description text is absent from the audit archive, so discovering storylines
// again can silently drop a member even when no article field has changed.
export function patchFrozenStorylines(original, updatedAudit, targetIds) {
  assert.ok(Array.isArray(original?.storylines), "invalid original storylines artifact");
  date(original.generatedAt, "storylines");
  const targets = new Map(updatedAudit.items.filter(item => targetIds.has(articleId(item))).map(item => [item.link, item]));
  const next = structuredClone(original);
  for (const [index, entry] of next.storylines.entries()) {
    assert.ok(Array.isArray(entry.stories) && Array.isArray(entry.weeks), "invalid frozen storyline membership");
    assert.equal(entry.total, entry.stories.length, "frozen storyline total disagrees with its member records");
    assert.equal(entry.undated, entry.stories.filter(story => story.date == null).length, "frozen storyline undated count disagrees with its member records");
    const counts = new Map();
    for (const story of entry.stories) {
      const key = weekKey(story.date);
      if (key) counts.set(key, (counts.get(key) || 0) + 1);
    }
    const beforeWeeks = frozenWeekSentiments(original.storylines[index].stories);
    for (const week of entry.weeks) {
      assert.equal(week.count, counts.get(week.week) || 0, "frozen storyline weekly count disagrees with its member records");
      same({ scored: week.scored, sentiment: week.sentiment }, beforeWeeks.get(week.week) || { scored: 0, sentiment: {} }, "frozen storyline sentiment totals disagree with its member records");
    }
    assert.ok([...counts.keys()].every(key => entry.weeks.some(week => week.week === key)), "a frozen storyline week is missing");
    for (const story of entry.stories) {
      const target = targets.get(story.url);
      if (!target) continue;
      if (shouldScoreSentiment(target) && LABELS.includes(target.sentiment)) story.sentiment = target.sentiment;
      else delete story.sentiment;
    }
    const afterWeeks = frozenWeekSentiments(entry.stories);
    for (const week of entry.weeks) {
      const bucket = afterWeeks.get(week.week) || { scored: 0, sentiment: {} };
      week.scored = bucket.scored;
      week.sentiment = bucket.sentiment;
    }
    assert.ok([...afterWeeks.keys()].every(key => entry.weeks.some(week => week.week === key)), "a frozen storyline week is missing");
  }
  same(storylinesProtected(original), storylinesProtected(next), "storyline membership or protected fields changed");
  return next;
}

function requireArtifacts(blobs) {
  assert.match(blobs["feed.rss"].toString(), /<\/rss>\s*$/, "the original RSS is incomplete");
  assert.match(blobs["digest.html"].toString(), /<\/html>\s*$/, "the original digest page is incomplete");
  assert.match(blobs["calendar.ics"].toString(), /END:VCALENDAR\s*$/, "the original calendar export is incomplete");
  const calendar = JSON.parse(blobs["calendar.json"]);
  const alerts = JSON.parse(blobs["alerts.json"]);
  assert.ok(Array.isArray(calendar.events), "calendar events must be an array");
  assert.ok(Number.isFinite(alerts.count) && typeof alerts.html === "string" && typeof alerts.text === "string", "invalid original alerts artifact");
}

export async function publishSentimentRepair({ siteDir, updatedAuditPath, receiptPath } = {}) {
  siteDir = path.resolve(siteDir || "site");
  assert.ok(updatedAuditPath, "--updated-audit is required");
  updatedAuditPath = path.resolve(updatedAuditPath);
  assert.notEqual(updatedAuditPath, path.join(siteDir, "feed-audit.json"), "keep the original audit separate until publication");
  if (receiptPath) {
    receiptPath = path.resolve(receiptPath);
    assert.ok(!receiptPath.startsWith(`${siteDir}${path.sep}`), "the publication receipt must be outside the site");
    assert.notEqual(receiptPath, updatedAuditPath, "the receipt must not overwrite the updated audit");
    assert.notEqual(receiptPath, path.join(path.dirname(updatedAuditPath), "manifest.json"), "the receipt must not overwrite the manifest");
  }
  const filenames = [...LIVE_ARTIFACTS, "index.html"];
  const entries = await Promise.all(filenames.map(async name => [name, await readFile(path.join(siteDir, name))]));
  const blobs = Object.fromEntries(entries);
  requireArtifacts(blobs);
  const [updatedRaw, manifestRaw] = await Promise.all([
    readFile(updatedAuditPath), readFile(path.join(path.dirname(updatedAuditPath), "manifest.json")),
  ]);
  const original = JSON.parse(blobs["feed-audit.json"]);
  const updated = JSON.parse(updatedRaw);
  const manifest = JSON.parse(manifestRaw);
  const { targetIds, keys } = validatePublicationAudit(original, updated, manifest);
  const originalFeed = JSON.parse(blobs["feed.json"]);
  assert.equal(originalFeed.generatedAt, original.generatedAt, "the public feed and audit must come from the same frozen generation");
  const patched = patchPublicFeed(originalFeed, updated, targetIds);
  const beforeItems = runtimeItems(original);
  const afterItems = runtimeItems(updated);
  const generatedAt = date(original.generatedAt, "audit");
  const options = rssOptions(blobs["feed.rss"].toString(), originalFeed, generatedAt);
  // Prove the current serializer reproduces the original RSS before changing
  // it. A changed source UI or serializer must fail before any site writes.
  assert.equal(buildRss(beforeItems, options), blobs["feed.rss"].toString(), "original RSS does not round-trip through the frozen serializer");
  const rss = buildRss(afterItems, options);

  const oldDigest = JSON.parse(blobs["digest.json"]);
  assert.ok(Array.isArray(oldDigest.sections) && typeof oldDigest.html === "string" && typeof oldDigest.text === "string", "invalid original digest artifact");
  const digestDate = date(oldDigest.generatedAt, "digest");
  const mailed = buildDigest(afterItems, { now: digestDate, footer: MAIL_FOOTER_TEXT });
  const digest = { ...oldDigest, subject: mailed.subject, text: mailed.text, html: mailed.html, sections: mailed.sections };
  same(digestProtected(oldDigest), digestProtected(digest), "digest section membership or editorial fields changed");
  const pageDigest = buildDigest(afterItems, { now: digestDate });
  same(pageDigest.sections, mailed.sections, "digest page membership differs from its JSON export");

  const oldStorylines = JSON.parse(blobs["storylines.json"]);
  const storylines = patchFrozenStorylines(oldStorylines, updated, targetIds);
  const index = injectPrerender(blobs["index.html"].toString(), patched.feed.items);
  assert.ok(index !== null, "the existing reader requires prerender markers");
  const reports = buildMonthlyReportPages(patched.feed.items, { now: generatedAt, state: updated.crawlState.monthlyReports });
  const output = new Map([
    ["feed-audit.json", updatedRaw],
    ["feed.json", `${JSON.stringify(patched.feed, null, 2)}\n`],
    ["feed.rss", rss],
    ["digest.json", `${JSON.stringify(digest, null, 2)}\n`],
    ["digest.html", buildDigestPage(pageDigest, { generatedAt: oldDigest.generatedAt })],
    ["storylines.json", `${JSON.stringify(storylines, null, 2)}\n`],
    ["index.html", index],
    ...Object.entries(reports).map(([name, body]) => [`reports/${name}`, body]),
  ]);
  const originals = new Map(entries);
  for (const filename of output.keys()) if (!originals.has(filename)) {
    try { originals.set(filename, await readFile(path.join(siteDir, filename))); }
    catch (error) { if (error.code !== "ENOENT") throw error; originals.set(filename, null); }
  }
  const receipt = {
    schema: "sentiment-repair-publication-v1", status: "complete", manifestHash: manifest.manifestHash,
    generatedAt: original.generatedAt, digestGeneratedAt: oldDigest.generatedAt, storylinesGeneratedAt: oldStorylines.generatedAt,
    originalAuditHash: sha(blobs["feed-audit.json"]), updatedAuditHash: sha(updatedRaw),
    protectedSnapshotHash: manifest.protectedSnapshotHash,
    auditItemCount: updated.items.length, publicItemCount: patched.feed.items.length,
    targetCount: manifest.targets.length, targetAliasCount: targetIds.size,
    changedAuditItemCount: original.items.filter((item, index) => JSON.stringify(item) !== JSON.stringify(updated.items[index])).length,
    changedCacheEntryCount: [...keys].filter(key => JSON.stringify(original.crawlState.jevCache[key]) !== JSON.stringify(updated.crawlState.jevCache[key])).length,
    publicTargetsVerified: patched.verifiedTargets, publicAliasesPatched: patched.patched, publicAliasesChanged: patched.changed,
    protectedAuditVerified: true, protectedFeedVerified: true, digestMembershipVerified: true, storylineMembershipVerified: true,
    reportPages: Object.keys(reports).length,
    preservedArtifacts: Object.fromEntries(PRESERVED_ARTIFACTS.map(name => [name, sha(blobs[name])])),
    outputHashes: Object.fromEntries([...output].map(([name, body]) => [name, sha(body)])),
  };
  // Every assertion and render above completes before replacing any output.
  // Stage the whole publication, then atomically replace individual files. An
  // I/O failure restores prior files and leaves the workflow unable to deploy.
  const staging = await mkdtemp(path.join(siteDir, ".sentiment-publication-"));
  const replaced = [];
  try {
    for (const [filename, body] of output) {
      await mkdir(path.dirname(path.join(staging, filename)), { recursive: true });
      await writeFile(path.join(staging, filename), body);
    }
    for (const [filename] of output) {
      await mkdir(path.dirname(path.join(siteDir, filename)), { recursive: true });
      await rename(path.join(staging, filename), path.join(siteDir, filename));
      replaced.push(filename);
    }
    for (const filename of PRESERVED_ARTIFACTS) assert.deepEqual(await readFile(path.join(siteDir, filename)), blobs[filename], `${filename} bytes changed`);
    for (const [filename, body] of output) assert.equal(sha(await readFile(path.join(siteDir, filename))), sha(body), `${filename} did not persist exactly`);
    if (receiptPath) {
      await mkdir(path.dirname(receiptPath), { recursive: true });
      const temporary = `${receiptPath}.${process.pid}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
        await rename(temporary, receiptPath);
      } finally { await rm(temporary, { force: true }); }
    }
  } catch (error) {
    for (const filename of replaced.reverse()) {
      const previous = originals.get(filename);
      if (previous === null) await rm(path.join(siteDir, filename), { force: true });
      else await writeFile(path.join(siteDir, filename), previous);
    }
    throw error;
  } finally { await rm(staging, { recursive: true, force: true }); }
  return receipt;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    assert.ok(["--site", "--updated-audit", "--receipt"].includes(argv[index]) && argv[index + 1] && !argv[index + 1].startsWith("--") && !Object.hasOwn(options, argv[index]), "usage: --site site --updated-audit repair/feed-audit.json [--receipt repair/publication.json]");
    options[argv[index]] = argv[index + 1];
  }
  return { siteDir: options["--site"], updatedAuditPath: options["--updated-audit"], receiptPath: options["--receipt"] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  publishSentimentRepair(parseArguments(process.argv.slice(2))).then(receipt => {
    console.log(JSON.stringify({ status: receipt.status, changedAuditItemCount: receipt.changedAuditItemCount, changedCacheEntryCount: receipt.changedCacheEntryCount, publicTargetsVerified: receipt.publicTargetsVerified, publicAliasesPatched: receipt.publicAliasesPatched, reportPages: receipt.reportPages }));
  }).catch(error => {
    // Assertion diffs and JSON parser errors can contain article text. Logs
    // identify a refused publication without echoing any supplied document.
    const code = error.code === "ERR_ASSERTION" ? "publication_invariant_failed" : error.code === "ENOENT" ? "required_local_artifact_missing" : "local_publication_failed";
    console.error(`Sentiment publication failed: ${code}`);
    process.exitCode = 1;
  });
}
