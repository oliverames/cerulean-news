import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildRepairContext, validateRepairManifest, validateCheckpoint, applyRepairCheckpoint, parseRepairResponse,
  normalizeUsageReceipt, postRepairRequest, writeJsonAtomic, hash } from "./sentiment-repair.js";

export const APPROVED_MANIFEST = "1d3bebd2ead988aea59b8e55dc59943503a55645b214863fd3521e9fbfc24971";
export const FAILED_KEY = "ed967118afe8af84568ddd583e6ae898859280edfae4e878b42a1dc38bb08ec3";
const fail = code => { throw new Error(code); };
const labels = ["positive", "neutral to positive", "neutral", "neutral to negative", "negative"];
export function responseDiagnostic(response) {
  const answer = response?.answers?.sentiment, odds = answer?.probabilities;
  const finite = value => Number.isFinite(value) ? value : null;
  const values = Object.fromEntries(labels.map(label => [label, finite(odds?.[label])]));
  const complete = Object.values(values).every(value => value !== null);
  return { responseHash: hash(response), modelMatches: response?.model === "jev-1.13.0", typeMatches: answer?.type === "choice",
    choiceAllowed: labels.includes(answer?.choice), confidence: finite(answer?.confidence),
    probabilityKeysMatch: Boolean(odds && Object.keys(odds).length === 5 && labels.every(label => Object.hasOwn(odds, label))),
    probabilities: values, sum: complete ? Object.values(values).reduce((a, b) => a + b, 0) : null,
    chosenProbability: labels.includes(answer?.choice) ? finite(odds?.[answer.choice]) : null,
    maximumProbability: complete ? Math.max(...Object.values(values)) : null };
}
export function validateAuthorizedCheckpoint(checkpoint, manifest) {
  validateCheckpoint(checkpoint, manifest);
  if (manifest.manifestHash !== APPROVED_MANIFEST) fail("recovery_not_authorized_for_manifest");
  const original = checkpoint.recovery?.originalFailed || checkpoint.entries[FAILED_KEY];
  const target = manifest.targets.find(row => row.key === FAILED_KEY);
  if (!original || original.status !== "failed" || original.error !== "malformed_sentiment_response" || original.requestHash !== target?.requestHash) fail("original_failure_not_preserved");
  for (const [key, row] of Object.entries(checkpoint.entries)) {
    if (key !== FAILED_KEY && row.status !== "succeeded") fail("additional_unresolved_attempt_no_replay");
  }
  const failed = checkpoint.entries[FAILED_KEY];
  if (!checkpoint.recovery?.retryUsed && JSON.stringify(failed) !== JSON.stringify(original)) fail("original_failure_changed");
  if (checkpoint.recovery?.retryUsed && hash(failed?.priorAttempts?.[0]) !== hash(original)) fail("retry_history_missing");
  return original;
}
export async function executeAuthorizedRecovery(context, manifest, checkpoint, { mode, currentAudit = context.audit,
  persist, post = postRepairRequest, now = () => new Date(), validateContext = validateRepairManifest, apply = applyRepairCheckpoint } = {}) {
  const entries = validateContext(context, manifest);
  checkpoint = structuredClone(checkpoint);
  const original = validateAuthorizedCheckpoint(checkpoint, manifest);
  apply(context, manifest, checkpoint, currentAudit);
  checkpoint.recovery ||= { originalFailed: structuredClone(original), approval: "2026-10-08 publish15/continue91/one-isolated-retry" };
  const summary = () => {
    const rows = Object.values(checkpoint.entries);
    checkpoint.attempted = rows.length;
    checkpoint.succeeded = rows.filter(row => row.status === "succeeded").length;
    checkpoint.remaining = manifest.targetCount - checkpoint.succeeded;
    checkpoint.httpAttempts = rows.length + (checkpoint.recovery.retryUsed ? 1 : 0);
    return checkpoint;
  };
  if (mode === "salvage") {
    if (checkpoint.recovery.retryUsed || checkpoint.succeeded !== 65 || checkpoint.attempted !== 66) fail("salvage_requires_original65_results");
    checkpoint.status = "salvaged"; await persist(summary()); return checkpoint;
  }
  if (!["continue", "retry"].includes(mode)) fail("invalid_authorized_recovery_mode");
  let selected;
  if (mode === "continue") {
    if (checkpoint.recovery.retryUsed) fail("continuation_after_retry_not_authorized");
    selected = entries.filter(entry => !checkpoint.entries[entry.key]).slice(0, 25);
    if (!selected.length) fail("no_untouched_targets");
  } else {
    if (checkpoint.recovery.retryUsed || Object.keys(checkpoint.entries).length !== manifest.targetCount || checkpoint.succeeded !== manifest.targetCount - 1) fail("isolated_retry_not_ready_or_used");
    selected = entries.filter(entry => entry.key === FAILED_KEY);
    checkpoint.recovery.retryUsed = true;
  }
  for (const entry of selected) {
    if (hash(entry.body) !== entry.target.requestHash) fail("request_body_changed");
    const row = { requestHash: entry.target.requestHash, status: "sending", attemptedAt: now().toISOString(),
      ...(mode === "retry" ? { priorAttempts: [structuredClone(original)] } : {}) };
    checkpoint.entries[entry.key] = row; checkpoint.status = "running"; await persist(summary());
    let response;
    try {
      response = await post(entry.body);
      row.diagnostic = responseDiagnostic(response);
      row.result = parseRepairResponse(response);
      row.usage = normalizeUsageReceipt(response);
      if (!Number.isSafeInteger(row.usage.input_tokens) || !Number.isSafeInteger(row.usage.output_tokens)) fail("missing_usage_receipt");
      row.status = "succeeded"; row.completedAt = now().toISOString();
    } catch (error) {
      row.status = "failed";
      row.error = /^(http_\d{3}|credentials_missing|request_transport_failure|response_json_failure|response_model_mismatch|malformed_sentiment_response|missing_usage_receipt)$/.test(error.message) ? error.message : "request_failed";
      row.usage = response ? normalizeUsageReceipt(response) : { status: "unavailable" };
      checkpoint.status = "blocked"; await persist(summary()); return checkpoint;
    }
    await persist(summary());
  }
  checkpoint.status = summary().remaining === 0 ? "complete" : "batch_complete";
  await persist(summary()); return checkpoint;
}
async function main() {
  const mode = process.argv[2];
  const context = await buildRepairContext({ auditPath: "repair/freeze/frozen-feed-audit.json" });
  const manifest = JSON.parse(await readFile("repair/freeze/manifest.json"));
  const checkpoint = JSON.parse(await readFile("repair/checkpoint.json"));
  const currentAudit = JSON.parse(await readFile("site/feed-audit.json"));
  const result = await executeAuthorizedRecovery(context, manifest, checkpoint, { mode, currentAudit,
    persist: value => writeJsonAtomic("repair/checkpoint.json", value) });
  console.log(JSON.stringify({ status: result.status, attempted: result.attempted, succeeded: result.succeeded, remaining: result.remaining, httpAttempts: result.httpAttempts }));
  if (result.status === "blocked") process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
