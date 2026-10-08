import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LIVE_ARTIFACTS } from "../scripts/publish-sentiment-repair.js";
import { verifySentimentReadback } from "../scripts/verify-sentiment-readback.js";

async function withSite(run) {
  const siteDir = await mkdtemp(path.join(os.tmpdir(), "sentiment-readback-"));
  try { for (const name of LIVE_ARTIFACTS) await writeFile(path.join(siteDir, name), name); await run(siteDir); }
  finally { await rm(siteDir, { recursive: true, force: true }); }
}
test("stale publication reads wait then verify all nine exact files", () => withSite(async siteDir => {
  let calls = 0, waits = 0;
  const result = await verifySentimentReadback({ siteDir, wait: async () => { waits++; }, fetchImpl: async url => {
    const name = new URL(url).pathname.slice(1); calls++;
    return new Response(calls === 1 ? "stale" : name);
  } });
  assert.deepEqual(result, { verifiedFiles: 9, readbackAttempt: 2 });
  assert.equal(calls, 18); assert.equal(waits, 1);
}));
test("persistent mismatch stops after bounded public reads", () => withSite(async siteDir => {
  let calls = 0, waits = 0;
  await assert.rejects(verifySentimentReadback({ siteDir, wait: async () => { waits++; }, fetchImpl: async () => { calls++; return new Response("stale"); } }), /sentiment_publication_readback_mismatch/);
  assert.equal(calls, 54); assert.equal(waits, 5);
}));
