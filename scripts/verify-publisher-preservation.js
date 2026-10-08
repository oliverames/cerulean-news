// Exercise the actual generation pipeline on temporary copies, without source
// collection, provider credentials or any outbound fetch. Never deploy its data.
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { hash, buildRepairContext, repairArticleId } from "./sentiment-repair.js";
import { generateFeed } from "../src/index.js";
import { normalizeJevCache } from "../src/jev-relevance.js";
import { loadAlignmentProfile } from "../src/jev-alignment.js";
import { APPROVED_FREEZE_HASH, APPROVED_CHECKPOINT_HASH } from "./reconcile-saved-sentiment.js";

export async function verifyPublisherPreservation({ siteDir = "site", savedManifest, checkpoint, receiptPath, expectedCount = 115, contextOptions = {} } = {}) {
  if (process.env.TYPESAFE_API_KEY || process.env.GEMINI_API_KEY || process.env.JEV_CLI_PATH) throw new Error("provider_credentials_forbidden_in_verification");
  const policyEnv = Object.fromEntries(["JEV_EXAMPLES_PATH", "JEV_ALIGNMENT_PROFILE", "JEV_ENFORCE_AFTER"].flatMap(key => {
    const value = contextOptions.env?.[key] ?? process.env[key];
    return value ? [[key, value]] : [];
  }));
  const auditPath = path.join(siteDir, "feed-audit.json");
  const before = JSON.parse(await readFile(auditPath));
  const context = await buildRepairContext({ ...contextOptions, env: policyEnv, auditPath });
  const aliases = new Map(context.entries.map(entry => [repairArticleId(entry.original), entry]));
  const successful = savedManifest.targets.filter(target => checkpoint.entries[target.key]?.status === "succeeded");
  const normalizedBefore = normalizeJevCache(before.crawlState.jevCache);
  const present = successful.filter(target => {
    const stored = normalizedBefore[target.key], saved = checkpoint.entries[target.key];
    return stored && stored.sentimentRequestHash === saved.requestHash && saved.requestHash === target.requestHash &&
      isDeepStrictEqual({ sentiment: stored.sentiment, sentimentConfidence: stored.sentimentConfidence, sentimentProbabilities: stored.sentimentProbabilities }, saved.result);
  });
  if (successful.length !== expectedCount || present.length !== expectedCount) throw new Error("publisher_saved_evidence_missing_or_mismatched");
  const exact = present.filter(target => target.aliases.every(alias => {
    const entry = aliases.get(alias.articleId);
    return entry && hash(entry.body) === checkpoint.entries[target.key].requestHash && !entry.item.feedbackSentiment;
  }));
  const tmp = await mkdtemp(path.join(os.tmpdir(), "cerulean-publisher-proof-"));
  const oldFetch = globalThis.fetch;
  let blockedFetches = 0;
  globalThis.fetch = async () => { blockedFetches++; throw new Error("outbound_fetch_disabled_in_publisher_verification"); };
  try {
    await Promise.all([copyFile(auditPath, path.join(tmp, "feed-audit.json")), copyFile(path.join(siteDir, "feed.json"), path.join(tmp, "feed.json")),
      writeFile(path.join(tmp, "index.html"), "<!doctype html><html><body></body></html>")]);
    const result = await generateFeed({ sources: [], now: new Date(before.generatedAt), rssOutputPath: path.join(tmp, "feed.rss"),
      jsonOutputPath: path.join(tmp, "feed.json"), auditJsonOutputPath: path.join(tmp, "feed-audit.json"),
      jevOptions: { env: policyEnv, mode: "enforce", enforceAfter: context.enforceAfter,
        alignment: contextOptions.alignment || await loadAlignmentProfile(policyEnv.JEV_ALIGNMENT_PROFILE || "src/rubrics/editorial-alignment-v2.json"),
        referenceExamples: contextOptions.referenceExamples,
        ...(contextOptions.rubric ? { rubric: contextOptions.rubric } : {}),
        ...(contextOptions.sentimentRubric ? { sentimentRubric: contextOptions.sentimentRubric } : {}) } });
    const after = JSON.parse(await readFile(path.join(tmp, "feed-audit.json")));
    const normalizedAfter = normalizeJevCache(after.crawlState.jevCache);
    for (const [key, row] of Object.entries(normalizedBefore)) if (!isDeepStrictEqual(row, normalizedAfter[key])) throw new Error("publisher_dropped_saved_evidence");
    const beforeItems = new Map(before.items.map(item => [repairArticleId(item), item]));
    const afterItems = new Map(after.items.map(item => [repairArticleId(item), item]));
    const beforePublic = JSON.parse(await readFile(path.join(siteDir, "feed.json")));
    const afterPublic = JSON.parse(await readFile(path.join(tmp, "feed.json")));
    const beforePublicItems = new Map(beforePublic.items.map(item => [repairArticleId(item), item]));
    const afterPublicItems = new Map(afterPublic.items.map(item => [repairArticleId(item), item]));
    for (const target of exact) for (const alias of target.aliases) {
      const old = beforeItems.get(alias.articleId), next = afterItems.get(alias.articleId);
      if (!next || hash([old.sentiment, old.sentimentReason, old.sentimentScore]) !== hash([next.sentiment, next.sentimentReason, next.sentimentScore])) throw new Error("publisher_changed_exact_saved_sentiment");
      const publicOld = beforePublicItems.get(alias.articleId), publicNext = afterPublicItems.get(alias.articleId);
      if (publicOld && (!publicNext || hash([publicOld.sentiment, publicOld.sentimentReason, publicOld.sentimentScore]) !== hash([publicNext.sentiment, publicNext.sentimentReason, publicNext.sentimentScore]))) throw new Error("publisher_changed_exact_public_sentiment");
    }
    if (blockedFetches !== 0 || result.crawlMetrics.jev.requested !== 0 || result.crawlMetrics.jev.sentimentBackfillRequested !== 0) throw new Error("provider_attempt_in_preservation_verification");
    if (blockedFetches !== 0) throw new Error("outbound_attempt_in_preservation_verification");
    const receipt = { providerRequests: 0, sourceRequests: 0, blockedFetches, savedValidResults: successful.length,
      preservedCacheEntries: present.length, exactSentimentContextsPreserved: exact.length, generatorExecuted: true };
    if (receiptPath) await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    return receipt;
  } finally { globalThis.fetch = oldFetch; await rm(tmp, { recursive: true, force: true }); }
}
async function main() {
  const [rawManifest, rawCheckpoint] = await Promise.all([readFile("repair/freeze/manifest.json", "utf8"), readFile("repair/checkpoint.json", "utf8")]);
  const savedManifest = JSON.parse(rawManifest), checkpoint = JSON.parse(rawCheckpoint);
  const { manifestHash, ...contents } = savedManifest;
  if (manifestHash !== APPROVED_FREEZE_HASH || hash(contents) !== manifestHash || hash(rawCheckpoint) !== APPROVED_CHECKPOINT_HASH) throw new Error("unapproved_saved_evidence");
  console.log(JSON.stringify(await verifyPublisherPreservation({ savedManifest, checkpoint, receiptPath: "repair/publisher-proof.json" })));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
