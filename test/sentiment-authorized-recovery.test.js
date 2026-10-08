import test from "node:test";
import assert from "node:assert/strict";
import { executeAuthorizedRecovery, validateAuthorizedCheckpoint, responseDiagnostic, APPROVED_MANIFEST, FAILED_KEY } from "../scripts/sentiment-authorized-recovery.js";
import { hash } from "../scripts/sentiment-repair.js";
const odds = { positive: 0.8, "neutral to positive": 0.1, neutral: 0.05, "neutral to negative": 0.03, negative: 0.02 };
const result = { sentiment: "positive", sentimentConfidence: 0.8, sentimentProbabilities: odds };
const response = { model: "jev-1.13.0", answers: { sentiment: { type: "choice", choice: "positive", confidence: 0.8, probabilities: odds } }, usage: { input_tokens: 100, output_tokens: 20 } };
function fixture(count = 65) {
  const entries = Array.from({ length: 157 }, (_, i) => { const body = JSON.stringify({ n: i }); return { key: i === 65 ? FAILED_KEY : hash(`key${i}`), body, target: { requestHash: hash(body) } }; });
  const manifest = { schema: "sentiment-repair-v1", manifestHash: APPROVED_MANIFEST, targetCount: 157, targets: entries.map(e => ({ key: e.key, requestHash: e.target.requestHash })) };
  const checkpoint = { schema: "sentiment-repair-v1", manifestHash: APPROVED_MANIFEST, status: "blocked", entries: {}, attempted: count + 1, succeeded: count, remaining: 157 - count };
  for (const e of entries.filter(e => e.key !== FAILED_KEY).slice(0, count)) checkpoint.entries[e.key] = { requestHash: e.target.requestHash, status: "succeeded", result, usage: { status: "reported", input_tokens: 100, output_tokens: 20 } };
  checkpoint.entries[FAILED_KEY] = { requestHash: entries[65].target.requestHash, status: "failed", error: "malformed_sentiment_response", usage: { status: "reported", input_tokens: 100, output_tokens: 20 } };
  return { entries, manifest, checkpoint, options: { persist: async () => {}, validateContext: () => entries, apply: () => {} } };
}
test("publish-only salvage retains the complete failed checkpoint and makes no send", async () => {
  const f = fixture(); const original = structuredClone(f.checkpoint);
  const cp = await executeAuthorizedRecovery({}, f.manifest, f.checkpoint, { ...f.options, mode: "salvage", post: () => assert.fail("No provider call") });
  assert.deepEqual(cp.entries, original.entries); assert.equal(cp.succeeded, 65); assert.equal(cp.httpAttempts, 66);
});
test("continuation sends only25 untouched exact bodies and preserves all prior attempts", async () => {
  const f = fixture();let calls = 0;const original = structuredClone(f.checkpoint.entries);
  const cp = await executeAuthorizedRecovery({}, f.manifest, f.checkpoint, { ...f.options, mode: "continue", post: async body => { calls++; assert.equal(body, f.entries[65 + calls].body); return response; } });
  assert.equal(calls, 25); assert.equal(cp.succeeded, 90); for (const [k, v] of Object.entries(original)) assert.deepEqual(cp.entries[k], v);
});
test("retry requires all91 untouched targets finished and is spent before sending", async () => {
  const f = fixture(156);let persisted, calls = 0;
  const cp = await executeAuthorizedRecovery({}, f.manifest, f.checkpoint, { ...f.options, mode: "retry", persist: async value => { persisted = structuredClone(value); }, post: async () => { assert.equal(persisted.recovery.retryUsed, true); assert.equal(persisted.entries[FAILED_KEY].status, "sending"); calls++; return response; } });
  assert.equal(calls, 1); assert.equal(cp.succeeded, 157); assert.equal(cp.httpAttempts, 158); assert.equal(cp.entries[FAILED_KEY].priorAttempts[0].status, "failed");
  await assert.rejects(executeAuthorizedRecovery({}, f.manifest, cp, { ...f.options, mode: "retry", post: () => assert.fail("Never repeat") }), /isolated_retry_not_ready_or_used/);
  const notReady = fixture(); await assert.rejects(executeAuthorizedRecovery({}, notReady.manifest, notReady.checkpoint, { ...notReady.options, mode: "retry" }), /isolated_retry_not_ready_or_used/);
});
test("an invalid retry stops, preserves original failure and stores diagnostic numbers without arbitrary strings", async () => {
  const f = fixture(156); const bad = structuredClone(response);bad.answers.sentiment.choice = "PRIVATE_SENTINEL";bad.answers.sentiment.probabilities.negative = 0.9;
  const cp = await executeAuthorizedRecovery({}, f.manifest, f.checkpoint, { ...f.options, mode: "retry", post: async () => bad });
  assert.equal(cp.status, "blocked"); assert.equal(cp.entries[FAILED_KEY].error, "malformed_sentiment_response"); assert.equal(cp.entries[FAILED_KEY].diagnostic.choiceAllowed, false); assert.ok(!JSON.stringify(cp).includes("PRIVATE_SENTINEL"));
});
test("unexpected failed attempts remain blocked and diagnostics respect confidence semantics", () => {
  const f = fixture();const key = Object.keys(f.checkpoint.entries)[0];f.checkpoint.entries[key].status = "failed";
  assert.throws(() => validateAuthorizedCheckpoint(f.checkpoint, f.manifest), /additional_unresolved_attempt/);
  assert.equal(responseDiagnostic(response).chosenProbability, 0.8);
});
