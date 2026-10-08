// Provider-free reconciliation. Preserve historical evidence; apply only exact
// current sentiment contexts. Never copy the old archive over a newer one.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRepairContext, validateCheckpoint, applySentimentResult, hash, repairArticleId, writeJsonAtomic } from "./sentiment-repair.js";
import { normalizeJevCache } from "../src/jev-relevance.js";

export const APPROVED_FREEZE_HASH = "1d3bebd2ead988aea59b8e55dc59943503a55645b214863fd3521e9fbfc24971";
export const APPROVED_CHECKPOINT_HASH = "8a49de0df04dfb76156391d20ccbdb4855085fcc8dc60becb2735ab259ec70b6";
const sameResult = (left, right) => hash([left.sentiment, left.sentimentConfidence, left.sentimentProbabilities]) === hash([right.sentiment, right.sentimentConfidence, right.sentimentProbabilities]);
export function reconcileSavedSentiment({ manifest, checkpoint, currentContext }) {
  const { manifestHash, ...contents } = manifest;
  if (manifestHash !== hash(contents) || manifest.model !== "jev-1.13.0") throw new Error("invalid_saved_manifest");
  validateCheckpoint(checkpoint, manifest);
  const current = currentContext.audit, updated = structuredClone(current);
  const byId = new Map(updated.items.map(item => [repairArticleId(item), item]));
  const entries = new Map(currentContext.entries.map(entry => [repairArticleId(entry.original), entry]));
  const targets = [], decisions = [];
  for (const saved of manifest.targets) {
    const row = checkpoint.entries[saved.key];
    if (row?.status !== "succeeded") continue;
    const allAliases = saved.aliases.map(alias => {
      const item = byId.get(alias.articleId), entry = entries.get(alias.articleId);
      return { item, entry, articleId: alias.articleId };
    });
    const missingAliases = allAliases.filter(alias => !alias.item).length;
    const aliases = allAliases.filter(alias => alias.item);
    const before = current.crawlState.jevCache[saved.key];
    const normalized = normalizeJevCache({ [saved.key]: before })[saved.key];
    if (before && (!normalized || (normalized.sentimentProbabilities && !sameResult(normalized, row.result)) ||
        (normalized.sentimentRequestHash && normalized.sentimentRequestHash !== row.requestHash))) {
      decisions.push({ key: saved.key, status: "newer_cache_conflict" }); continue;
    }
    const exact = missingAliases === 0 && aliases.every(alias => alias.entry && hash(alias.entry.body) === row.requestHash && !alias.entry.item.feedbackSentiment);
    const baseline = before || { storyKey: saved.storyKey, alignmentVersion: saved.alignmentVersion,
      model: "jev-1.13.0", rubricVersion: saved.rubricVersion, include: null, localAngle: null, relevanceScore: null, sentimentOnly: true };
    updated.crawlState.jevCache[saved.key] = { ...baseline, ...row.result, sentimentRequestHash: row.requestHash };
    for (const alias of aliases) if (exact) {
      const next = applySentimentResult(alias.item, row.result, { feedbackSentiment: Boolean(alias.entry.item.feedbackSentiment) });
      byId.set(alias.articleId, next);
    }
    targets.push({ ...saved, cacheBaseline: before || null, historicalOnly: !exact,
      originalCacheHash: hash(before ?? null), aliases: aliases.map(alias => ({ articleId: alias.articleId,
        articleHash: hash(alias.item), feedbackSentiment: Boolean(alias.entry?.item.feedbackSentiment) })) });
    decisions.push({ key: saved.key, status: exact ? "exact_current_context" : missingAliases ? "historical_only_missing_aliases" : "historical_only_context_changed",
      ...(missingAliases ? { missingAliases } : {}) });
  }
  updated.items = updated.items.map(item => byId.get(repairArticleId(item)));
  const protectedAudit = structuredClone(current);
  const ids = new Set(targets.flatMap(target => target.aliases.map(alias => alias.articleId)));
  for (const item of protectedAudit.items) if (ids.has(repairArticleId(item))) for (const field of ["sentiment", "sentimentReason", "sentimentScore"]) delete item[field];
  for (const target of targets) delete protectedAudit.crawlState.jevCache[target.key];
  const derived = { schema: "sentiment-repair-v1", status: "frozen", purpose: "saved-context-reconciliation", model: "jev-1.13.0",
    originalManifestHash: manifest.manifestHash, generatedAt: current.generatedAt, totalArticles: current.items.length,
    snapshotHash: hash(currentContext.raw), protectedSnapshotHash: hash(protectedAudit), targets, targetCount: targets.length,
    aliasCount: targets.reduce((count, target) => count + target.aliases.length, 0) };
  return { updated, manifest: { ...derived, manifestHash: hash(derived) }, receipt: {
    providerRequests: 0, savedValidResults: Object.values(checkpoint.entries).filter(row => row.status === "succeeded").length,
    restoredEvidence: targets.length, exactContexts: decisions.filter(row => row.status === "exact_current_context").length,
    historicalOnly: decisions.filter(row => row.status.startsWith("historical_only_")).length,
    missingAliasContexts: decisions.filter(row => row.status === "historical_only_missing_aliases").length, decisions } };
}
async function main() {
  if (process.env.TYPESAFE_API_KEY || process.env.GEMINI_API_KEY || process.env.JEV_CLI_PATH) throw new Error("provider_credentials_forbidden_in_reconciliation");
  const manifest = JSON.parse(await readFile("repair/freeze/manifest.json"));
  const rawCheckpoint = await readFile("repair/checkpoint.json", "utf8");
  if (manifest.manifestHash !== APPROVED_FREEZE_HASH || hash(rawCheckpoint) !== APPROVED_CHECKPOINT_HASH) throw new Error("unapproved_saved_evidence");
  const checkpoint = JSON.parse(rawCheckpoint);
  if (checkpoint.succeeded !== 115 || checkpoint.attempted !== 116 || checkpoint.recovery?.retryUsed) throw new Error("unexpected_saved_checkpoint");
  const currentContext = await buildRepairContext({ auditPath: "site/feed-audit.json" });
  const result = reconcileSavedSentiment({ manifest, checkpoint, currentContext });
  await writeJsonAtomic("repair/reconciled-audit.json", result.updated);
  await writeJsonAtomic("repair/manifest.json", result.manifest);
  await writeJsonAtomic("repair/reconciliation.json", result.receipt);
  console.log(JSON.stringify({ ...result.receipt, decisions: undefined }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
