#!/usr/bin/env node
// A one-shot, frozen sentiment-odds repair. This never invokes the generator,
// collects sources, summarizes, sends alerts, or prunes any persisted cache.
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPreviousState } from "../src/archive.js";
import { applyHumanRejections, loadAlignmentProfile } from "../src/jev-alignment.js";
import { loadReferenceExamples } from "../src/jev-examples.js";
import { freezeReferenceText } from "../src/jev-freeze.js";
import { jevCacheKey, jevStoryKey, legacyJevCacheKey, referenceLibraryHashes, referenceSignature, shortKey } from "../src/jev-cache-keys.js";
import { buildJevRequest, loadRelevanceRubric, loadSentimentRubric, normalizeJevCache, selectJevCandidates, SENTIMENT_CONFIDENCE_THRESHOLD, sentimentScoreFromProbabilities } from "../src/jev-relevance.js";
import { applyTeamFeedback, mergeFeedbackExamples } from "../src/feedback.js";
import { applyDeterministicRelevance } from "../src/relevance.js";
import { SENTIMENT_VALUES, shouldScoreSentiment } from "../src/summaries.js";
import { parseDate, sortItemsByDate } from "../src/utils.js";

export const REPAIR_MODEL = "jev-1.13.0";
export const REPAIR_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const SCHEMA = "sentiment-repair-v1";
const HASH = /^[a-f0-9]{64}$/;
const SENTIMENT_FIELDS = ["sentiment", "sentimentReason", "sentimentScore"];
export const hash = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
class RepairError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new RepairError(code); };
const clone = value => structuredClone(value);
const probability = value => Number.isFinite(value) && value >= 0 && value <= 1;

// fsync the file before atomic replacement: a send intent or response is
// durable before the next HTTP request or the publication stage can begin.
export async function writeJsonAtomic(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "w", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, filename);
    const directory = await open(path.dirname(filename), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

// Reference/feedback matching normalizes URLs, but publication identities must
// distinguish the archived aliases that differ only by tracking parameters.
export const repairArticleId = item => hash(String(item?.link || item?.url || ""));
const articleIdentity = repairArticleId;

function protectedSnapshot(audit, targets) {
  const result = clone(audit);
  const ids = new Set(targets.flatMap(target => target.aliases.map(alias => alias.articleId)));
  for (const item of result.items) if (ids.has(articleIdentity(item))) {
    for (const field of SENTIMENT_FIELDS) delete item[field];
  }
  for (const target of targets) delete result.crawlState?.jevCache?.[target.key];
  return hash(result);
}

// Full archived context is retained, including rejected/reference rows. The
// restoration used by the generator cleans snippets, dates and matched terms.
// Reassert saved human votes (without fetching new votes) and editorial rejects
// because the public serialization does not carry those runtime protection flags.
export async function buildRepairContext({ auditPath, env = process.env, rubric, sentimentRubric, alignment, referenceExamples } = {}) {
  const raw = await readFile(auditPath, "utf8");
  let audit;
  try { audit = JSON.parse(raw); } catch { fail("invalid_audit"); }
  if (!Array.isArray(audit?.items) || !audit.items.length || !audit.crawlState?.jevCache || !parseDate(audit.generatedAt)) fail("invalid_audit");
  const ids = audit.items.map(articleIdentity);
  if (new Set(ids).size !== ids.length) fail("duplicate_article_identity");
  const restored = await loadPreviousState(auditPath);
  if (!restored.archivedItems.length) fail("archive_restore_failed");
  rubric ||= await loadRelevanceRubric({ env });
  sentimentRubric ||= await loadSentimentRubric();
  alignment ||= await loadAlignmentProfile(env.JEV_ALIGNMENT_PROFILE || "src/rubrics/editorial-alignment-v2.json");
  if (rubric.model !== REPAIR_MODEL) fail("unexpected_model");
  const feedback = applyTeamFeedback(sortItemsByDate(restored.archivedItems).map(applyDeterministicRelevance),
    { status: "unavailable", votes: [], invalid: 0 }, clone(restored.crawlState.feedback));
  const items = await applyHumanRejections(feedback.items, { alignment, env });
  const references = referenceExamples ? { status: "loaded", examples: referenceExamples }
    : await loadReferenceExamples(items, { env, config: alignment.references });
  if (references.status !== "loaded" || !references.examples.length) fail("reference_library_unavailable");
  const counts = {
    inclusionReferences: references.examples.filter(row => row.include !== false).length,
    rejectionReferences: references.examples.filter(row => row.include === false).length,
    sentimentReferences: references.examples.filter(row => row.sentiment).length,
  };
  // The small local tracker seed cannot silently stand in for the runner's
  // complete materialized library. Existing runtime counts are a minimum.
  for (const [name, count] of Object.entries(counts)) {
    if (Number.isInteger(audit.crawlMetrics?.jev?.[name]) && count < audit.crawlMetrics.jev[name]) fail("incomplete_reference_library");
  }
  const liveReferences = mergeFeedbackExamples(references.examples, feedback.examples);
  const frozen = freezeReferenceText(liveReferences, clone(restored.crawlState.jevExamples));
  const referenceInfo = { ...counts, ...referenceLibraryHashes(liveReferences, frozen.examples),
    feedbackReferences: liveReferences.length - references.examples.length,
    libraryHash: hash(frozen.examples), alignmentHash: hash(alignment) };
  const versions = { alignmentVersion: alignment.version, version: rubric.version, sentimentVersion: sentimentRubric.version };
  const normalized = normalizeJevCache(audit.crawlState.jevCache);
  const byId = new Map(audit.items.map(item => [articleIdentity(item), item]));
  // References still come from the complete restored archive above. Primary
  // candidates cannot enter this queue, so do not build their unused requests.
  const entries = selectJevCandidates(items, Infinity).filter(shouldScoreSentiment).map(item => {
    const trace = {};
    const request = buildJevRequest(item, rubric, { sentimentRubric, alignment, referenceExamples: frozen.examples, trace });
    const storyKey = jevStoryKey({ ...versions, request });
    const signature = referenceSignature(trace);
    const key = jevCacheKey(storyKey, signature);
    let cache = normalized[key];
    if (Object.hasOwn(audit.crawlState.jevCache, key) && !cache) fail("invalid_target_cache");
    if (!cache) {
      const legacyRequest = buildJevRequest(item, rubric, { sentimentRubric, alignment, referenceExamples: liveReferences });
      const legacy = normalized[legacyJevCacheKey({ ...versions, request: legacyRequest })];
      if (legacy && !legacy.storyKey) cache = { ...legacy, storyKey: shortKey(storyKey) };
    }
    const original = byId.get(articleIdentity(item));
    if (!original) fail("unknown_restored_article");
    // Canonical full request determines the compatible runtime cache key.
    // The repair transmits only the independent sentiment question, keeping
    // its exact existing rules/storylines/reference context unchanged.
    const repairRequest = { state: request.state, model: request.model, questions: { sentiment: request.questions.sentiment } };
    return { item, original, request, body: JSON.stringify(repairRequest), canonicalRequestHash: hash(JSON.stringify(request)),
      key, storyKey: shortKey(storyKey), signature, cache };
  });
  return { audit, raw, entries, referenceInfo, versions, rubricHash: hash({ rubric, sentimentRubric }),
    enforceAfter: env.JEV_ENFORCE_AFTER || audit.crawlMetrics?.jev?.enforceAfter || "2026-09-21T18:13:31.000Z" };
}

export function freezeRepairManifest(context, { expectedPending, now = new Date() } = {}) {
  const { audit, entries, referenceInfo, versions } = context;
  const grouped = new Map();
  for (const entry of entries.filter(entry => shouldScoreSentiment(entry.item) && !entry.cache?.sentimentProbabilities)) {
    if (!grouped.has(entry.key)) grouped.set(entry.key, []);
    grouped.get(entry.key).push(entry);
  }
  const cutoff = parseDate(context.enforceAfter);
  if (!cutoff) fail("invalid_enforcement_boundary");
  const targets = [...grouped.entries()].map(([key, aliases]) => {
    const entry = aliases[0];
    if (aliases.some(alias => alias.body !== entry.body)) fail("request_key_body_collision");
    return { key, storyKey: entry.storyKey, requestHash: hash(entry.body), canonicalRequestHash: entry.canonicalRequestHash,
      requestBytes: Buffer.byteLength(entry.body), alignmentVersion: versions.alignmentVersion, rubricVersion: versions.version,
      referenceSignatureHash: hash(entry.signature),
      cacheBaseline: entry.cache || null,
      originalCacheHash: hash(audit.crawlState.jevCache[key] ?? null),
      aliases: aliases.map(alias => ({ articleId: articleIdentity(alias.original), articleHash: hash(alias.original),
        cohort: parseDate(alias.item.firstSeenAt)?.valueOf() >= cutoff.valueOf() ? "post_boundary" : "historical",
        relevant: typeof alias.original.relevant === "boolean" ? alias.original.relevant : null,
        sentiment: alias.original.sentiment || null, feedbackSentiment: Boolean(alias.item.feedbackSentiment) })) };
  });
  const manifest = { schema: SCHEMA, createdAt: now.toISOString(), status: expectedPending != null && targets.length !== expectedPending ? "count_mismatch" : "frozen",
    endpoint: REPAIR_ENDPOINT, model: REPAIR_MODEL, questionKeys: ["sentiment"], freePlan: "existing_no_card", maxBatchSize: 25,
    snapshotHash: hash(context.raw), protectedSnapshotHash: protectedSnapshot(audit, targets),
    generatedAt: audit.generatedAt, totalArticles: audit.items.length, priorReportedPending: audit.crawlMetrics?.jev?.sentimentBackfillPending ?? null,
    expectedPending: expectedPending ?? null, targetCount: targets.length, aliasCount: targets.reduce((sum, target) => sum + target.aliases.length, 0),
    versions, rubricHash: context.rubricHash, references: referenceInfo, enforceAfter: cutoff.toISOString(),
    payloadFields: { article: ["title", "excerpt", "excerptSource", "outlet", "matchedKeywords", "category", "sourceType", "eligibleBcbsVtSentiment", "curatedInclusion"],
      references: ["title", "outlet", "excerpt", "editorialContext", "human labels", "provenance"],
      policy: ["sentiment question", "sentiment rules", "selected storylines"] }, targets };
  return { ...manifest, manifestHash: hash(manifest) };
}

export function validateRepairManifest(context, manifest) {
  if (manifest?.schema !== SCHEMA || manifest.status !== "frozen" || manifest.model !== REPAIR_MODEL ||
      manifest.endpoint !== REPAIR_ENDPOINT || manifest.maxBatchSize !== 25 || !Array.isArray(manifest.targets)) fail("invalid_manifest");
  const { manifestHash, ...contents } = manifest;
  if (!HASH.test(manifestHash || "") || hash(contents) !== manifestHash) fail("manifest_hash_mismatch");
  const rebuilt = freezeRepairManifest(context, { expectedPending: manifest.expectedPending, now: new Date(manifest.createdAt) });
  if (rebuilt.manifestHash !== manifestHash) fail("frozen_context_changed");
  const byKey = new Map(context.entries.map(entry => [entry.key, entry]));
  return manifest.targets.map(target => ({ ...byKey.get(target.key), target }));
}

export function parseRepairResponse(response) {
  if (response?.model !== REPAIR_MODEL) fail("response_model_mismatch");
  const answer = response?.answers?.sentiment;
  const odds = answer?.probabilities;
  if (answer?.type !== "choice" || !SENTIMENT_VALUES.includes(answer.choice) || !probability(answer.confidence) ||
      !odds || Object.keys(odds).length !== SENTIMENT_VALUES.length || !SENTIMENT_VALUES.every(label => probability(odds[label])) ||
      Math.abs(SENTIMENT_VALUES.reduce((sum, label) => sum + odds[label], 0) - 1) > 0.001 ||
      SENTIMENT_VALUES.some(label => odds[label] > odds[answer.choice])) fail("malformed_sentiment_response");
  return { sentiment: answer.choice, sentimentConfidence: answer.confidence,
    sentimentProbabilities: Object.fromEntries(SENTIMENT_VALUES.map(label => [label, odds[label]])) };
}

export function normalizeUsageReceipt(response) {
  const usage = response?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return { status: "unavailable" };
  const receipt = {};
  for (const field of ["input_tokens", "output_tokens", "total_tokens", "prompt_tokens", "completion_tokens", "billable_input_tokens", "cached_input_tokens"]) {
    if (Number.isSafeInteger(usage[field]) && usage[field] >= 0) receipt[field] = usage[field];
  }
  return Object.keys(receipt).length ? { status: "reported", ...receipt } : { status: "unavailable" };
}

export function applySentimentResult(original, result, { feedbackSentiment = false } = {}) {
  const item = clone(original);
  if (feedbackSentiment || !shouldScoreSentiment(original)) return item;
  if (result.sentimentConfidence >= SENTIMENT_CONFIDENCE_THRESHOLD) {
    item.sentiment = result.sentiment;
    item.sentimentReason = "";
  }
  const score = sentimentScoreFromProbabilities(result.sentimentProbabilities);
  if (score !== null && item.sentiment) item.sentimentScore = score;
  return item;
}

function resultCache(originalCache, target, result) {
  return { ...(originalCache || target.cacheBaseline || { storyKey: target.storyKey,
    alignmentVersion: target.alignmentVersion,
    model: REPAIR_MODEL, rubricVersion: target.rubricVersion, include: null, localAngle: null, relevanceScore: null, sentimentOnly: true }), ...result };
}

function checkpointSummary(checkpoint, manifest) {
  const rows = Object.values(checkpoint.entries);
  checkpoint.attempted = rows.length;
  checkpoint.succeeded = rows.filter(row => row.status === "succeeded").length;
  checkpoint.remaining = manifest.targetCount - checkpoint.succeeded;
  return checkpoint;
}

export function validateCheckpoint(checkpoint, manifest) {
  if (!checkpoint || checkpoint.schema !== SCHEMA || checkpoint.manifestHash !== manifest.manifestHash ||
      !checkpoint.entries || typeof checkpoint.entries !== "object" || Array.isArray(checkpoint.entries)) fail("invalid_checkpoint");
  const targets = new Map(manifest.targets.map(target => [target.key, target]));
  for (const [key, row] of Object.entries(checkpoint.entries)) {
    const target = targets.get(key);
    if (!target || row.requestHash !== target.requestHash || !["sending", "succeeded", "failed"].includes(row.status)) fail("invalid_checkpoint_entry");
    if (row.status === "succeeded") {
      const parsed = parseRepairResponse({ model: REPAIR_MODEL, answers: { sentiment: { type: "choice", choice: row.result?.sentiment,
        confidence: row.result?.sentimentConfidence, probabilities: row.result?.sentimentProbabilities } } });
      if (hash(parsed) !== hash(row.result) || row.usage?.status !== "reported" ||
          !Number.isSafeInteger(row.usage.input_tokens) || row.usage.input_tokens < 0 ||
          !Number.isSafeInteger(row.usage.output_tokens) || row.usage.output_tokens < 0) fail("invalid_checkpoint_result");
    }
  }
  return checkpoint;
}

// Exactly one HTTP attempt. HTTP bodies and exceptions never enter logs or
// checkpoints; provider failure, quota refusal and ambiguous sends stop the run.
export async function postRepairRequest(body, { env = process.env, fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const key = env.TYPESAFE_API_KEY?.trim();
  if (!key) fail("credentials_missing");
  let response;
  try {
    response = await fetchImpl(REPAIR_ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  } catch { fail("request_transport_failure"); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    fail(`http_${response.status}`);
  }
  try { return await response.json(); } catch { fail("response_json_failure"); }
}

export async function executeRepairBatch(context, manifest, { checkpoint, checkpointPath, batchSize = 25,
  currentAudit = context.audit, post = postRepairRequest, env = process.env,
  persist = value => writeJsonAtomic(checkpointPath, value), now = () => new Date() } = {}) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 25) fail("invalid_batch_size");
  const entries = validateRepairManifest(context, manifest);
  checkpoint = checkpoint ? clone(validateCheckpoint(checkpoint, manifest))
    : { schema: SCHEMA, manifestHash: manifest.manifestHash, entries: {}, status: "pending" };
  // Refuse a stale publication base before spending a logical request slot.
  applyRepairCheckpoint(context, manifest, checkpoint, currentAudit);
  // A timeout/crash can have reached the provider. Never infer twice without
  // a human resolving the ambiguous receipt; failed targets are never replaced.
  if (Object.values(checkpoint.entries).some(row => row.status !== "succeeded")) {
    checkpoint.status = "blocked_prior_attempt";
    await persist(checkpointSummary(checkpoint, manifest));
    return checkpoint;
  }
  const selected = entries.filter(entry => !checkpoint.entries[entry.key]).slice(0, batchSize);
  for (const entry of selected) {
    // Hash the actual immutable string that will be handed to fetch, rather
    // than a second serialization that might differ from preflight.
    const body = entry.body;
    if (hash(body) !== entry.target.requestHash) fail("request_body_changed");
    const row = checkpoint.entries[entry.key] = { requestHash: entry.target.requestHash, status: "sending", attemptedAt: now().toISOString() };
    checkpoint.status = "running";
    await persist(checkpointSummary(checkpoint, manifest));
    let response;
    try {
      response = await post(body, { env });
      row.result = parseRepairResponse(response);
      row.usage = normalizeUsageReceipt(response);
      if (!Number.isSafeInteger(row.usage.input_tokens) || !Number.isSafeInteger(row.usage.output_tokens)) fail("missing_usage_receipt");
      row.status = "succeeded";
      row.completedAt = now().toISOString();
    } catch (error) {
      row.status = "failed";
      // Only locally defined codes survive. Exception strings can contain
      // a provider body, credentials, or the private request context.
      row.error = /^(http_\d{3}|credentials_missing|request_transport_failure|response_json_failure|response_model_mismatch|malformed_sentiment_response|missing_usage_receipt)$/.test(error?.message || "")
        ? error.message : "request_failed";
      row.usage = response ? normalizeUsageReceipt(response) : { status: "unavailable" };
      checkpoint.status = "blocked";
      await persist(checkpointSummary(checkpoint, manifest));
      return checkpoint;
    }
    await persist(checkpointSummary(checkpoint, manifest));
  }
  checkpointSummary(checkpoint, manifest);
  checkpoint.status = checkpoint.succeeded === manifest.targetCount ? "complete" : "batch_complete";
  await persist(checkpointSummary(checkpoint, manifest));
  return checkpoint;
}

export function applyRepairCheckpoint(context, manifest, checkpoint, currentAudit = context.audit) {
  validateRepairManifest(context, manifest);
  validateCheckpoint(checkpoint, manifest);
  if (protectedSnapshot(currentAudit, manifest.targets) !== manifest.protectedSnapshotHash) fail("publication_snapshot_changed");
  const updated = clone(currentAudit);
  const originals = new Map(context.audit.items.map(item => [articleIdentity(item), item]));
  const currentById = new Map(updated.items.map(item => [articleIdentity(item), item]));
  const replacements = new Map();
  for (const target of manifest.targets) {
    const row = checkpoint.entries[target.key];
    const originalCache = context.audit.crawlState.jevCache[target.key];
    const finalCache = row?.status === "succeeded" ? resultCache(originalCache, target, row.result) : originalCache;
    const currentCacheHash = hash(updated.crawlState.jevCache[target.key] ?? null);
    if (currentCacheHash !== target.originalCacheHash && currentCacheHash !== hash(finalCache ?? null)) fail("target_cache_changed");
    for (const alias of target.aliases) {
      const original = originals.get(alias.articleId), current = currentById.get(alias.articleId);
      if (!original || !current || hash(original) !== alias.articleHash) fail("target_article_missing");
      const final = row?.status === "succeeded" ? applySentimentResult(original, row.result, alias) : original;
      if (hash(current) !== alias.articleHash && hash(current) !== hash(final)) fail("target_article_changed");
      if (row?.status === "succeeded") replacements.set(alias.articleId, final);
    }
    if (row?.status === "succeeded") updated.crawlState.jevCache[target.key] = finalCache;
  }
  updated.items = updated.items.map(item => replacements.get(articleIdentity(item)) || item);
  if (protectedSnapshot(updated, manifest.targets) !== manifest.protectedSnapshotHash) fail("protected_state_changed");
  return updated;
}

function parseArguments(argv) {
  const [command, ...args] = argv;
  if (!["manifest", "execute", "apply"].includes(command)) fail("expected_manifest_execute_or_apply");
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!/^--[a-z-]+$/.test(args[index]) || !args[index + 1] || args[index + 1].startsWith("--")) fail("invalid_arguments");
    const name = args[index].slice(2);
    if (!["audit", "manifest", "checkpoint", "batch-size", "expected-pending", "current-audit", "output-audit"].includes(name) || Object.hasOwn(options, name)) fail("invalid_arguments");
    options[name] = args[index + 1];
  }
  if (!options.audit || !options.manifest) fail("audit_and_manifest_required");
  return { command, options };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const context = await buildRepairContext({ auditPath: options.audit });
  if (command === "manifest") {
    const expectedPending = options["expected-pending"] == null ? undefined : Number(options["expected-pending"]);
    if (expectedPending != null && (!Number.isSafeInteger(expectedPending) || expectedPending < 0)) fail("invalid_expected_pending");
    const manifest = freezeRepairManifest(context, { expectedPending });
    await writeJsonAtomic(options.manifest, manifest);
    console.log(JSON.stringify({ status: manifest.status, manifestHash: manifest.manifestHash, targets: manifest.targetCount,
      aliases: manifest.aliasCount, priorReportedPending: manifest.priorReportedPending, references: manifest.references.referenceCount }));
    if (manifest.status !== "frozen") process.exitCode = 2;
    return;
  }
  if (!options.checkpoint) fail("checkpoint_required");
  const manifest = JSON.parse(await readFile(options.manifest, "utf8"));
  let checkpoint;
  try { checkpoint = JSON.parse(await readFile(options.checkpoint, "utf8")); }
  catch (error) { if (command !== "execute" || error.code !== "ENOENT") fail("checkpoint_unavailable"); }
  if (command === "execute") {
    // Refuse missing credentials before writing a send intent.
    if (!process.env.TYPESAFE_API_KEY?.trim()) fail("credentials_missing");
    const currentAudit = options["current-audit"] ? JSON.parse(await readFile(options["current-audit"], "utf8")) : context.audit;
    checkpoint = await executeRepairBatch(context, manifest, { checkpoint, checkpointPath: options.checkpoint, currentAudit,
      batchSize: options["batch-size"] == null ? 25 : Number(options["batch-size"]) });
    console.log(JSON.stringify({ status: checkpoint.status, attempted: checkpoint.attempted, succeeded: checkpoint.succeeded, remaining: checkpoint.remaining }));
    if (!["complete", "batch_complete"].includes(checkpoint.status)) process.exitCode = 2;
    return;
  }
  if (!options["output-audit"]) fail("output_audit_required");
  const current = options["current-audit"] ? JSON.parse(await readFile(options["current-audit"], "utf8")) : context.audit;
  const updated = applyRepairCheckpoint(context, manifest, checkpoint, current);
  await writeJsonAtomic(options["output-audit"], updated);
  console.log(JSON.stringify({ status: "applied", succeeded: checkpoint.succeeded, remaining: checkpoint.remaining, outputHash: hash(updated) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = error instanceof RepairError ? error.code : "local_input_or_filesystem_failure";
    console.error(`Sentiment repair stopped: ${code}.`);
    process.exitCode = 1;
  });
}
