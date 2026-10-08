import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ARTIFACTS, fetchPublication, seedPublication, verifyCurrentMain, verifyPublicationUnchanged } from "../scripts/publication-guard.js";

function fixture() {
  const generatedAt = "2026-10-08T19:30:20.508Z";
  return {
    "feed-audit.json": JSON.stringify({ audit: true, generatedAt, items: [], sources: [], crawlState: {} }),
    "feed.json": JSON.stringify({ generatedAt, items: [] }),
    "feed.rss": "<rss></rss>",
    "digest.json": JSON.stringify({ sections: [], html: "", text: "" }),
    "digest.html": "<html></html>",
    "storylines.json": JSON.stringify({ storylines: [] }),
    "calendar.json": JSON.stringify({ events: [] }),
    "calendar.ics": "BEGIN:VCALENDAR\nEND:VCALENDAR",
    "alerts.json": JSON.stringify({ count: 0, html: "", text: "" }),
  };
}
const fakeFetch = (bundle, intercept) => async url => {
  const name = new URL(url).pathname.split("/").at(-1);
  const replacement = intercept?.(name);
  return replacement || new Response(bundle[name], { status: bundle[name] === undefined ? 404 : 200 });
};

test("publication source refuses a queued commit after main advances", async () => {
  const sha = "a".repeat(40);
  const options = { repository: "oliverames/cerulean-news", sha, token: "test-only" };
  await assert.rejects(verifyCurrentMain({ ...options, fetchImpl: async () => Response.json({ object: { sha: "b".repeat(40) } }) }), /stale_publication_source/);
  await assert.rejects(verifyCurrentMain({ ...options, fetchImpl: async () => new Response("", { status: 503 }) }), /stale_publication_source/);
  await verifyCurrentMain({ ...options, fetchImpl: async () => Response.json({ object: { sha } }) });
});

test("missing, malformed, and incoherent live publications cannot seed", async t => {
  await t.test("missing reader artifact", async () => {
    const bundle = fixture(); delete bundle["digest.html"];
    await assert.rejects(fetchPublication({ fetchImpl: fakeFetch(bundle) }), /publication_artifact_unavailable/);
  });
  await t.test("invalid JSON", async () => {
    const bundle = fixture(); bundle["feed-audit.json"] = "{";
    await assert.rejects(fetchPublication({ fetchImpl: fakeFetch(bundle) }), SyntaxError);
  });
  await t.test("public and durable archives differ in generation", async () => {
    const bundle = fixture(); bundle["feed.json"] = JSON.stringify({ generatedAt: "older", items: [] });
    await assert.rejects(fetchPublication({ fetchImpl: fakeFetch(bundle) }), /invalid_publication_bundle/);
  });
  await t.test("invalid artifact shape", async () => {
    const bundle = fixture(); bundle["calendar.json"] = JSON.stringify({ events: null });
    await assert.rejects(fetchPublication({ fetchImpl: fakeFetch(bundle) }), /invalid_publication_bundle/);
  });
});

test("a publication advancing while its artifacts download is rejected", async () => {
  const bundle = fixture(); let audits = 0;
  await assert.rejects(fetchPublication({ fetchImpl: fakeFetch(bundle, name => {
    if (name === "feed-audit.json" && ++audits === 2) return new Response(`${bundle[name]}\n`);
  }) }), /publication_changed_during_seed/);
});

test("all nine seeded files survive byte-for-byte and every changed artifact blocks deployment", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cerulean-publication-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const siteDir = path.join(root, "site"), baselineDir = path.join(root, "baseline");
  const bundle = fixture();
  assert.deepEqual(await seedPublication({ siteDir, baselineDir, fetchImpl: fakeFetch(bundle) }), { seededFiles: 9 });
  for (const name of ARTIFACTS) assert.equal(await readFile(path.join(siteDir, name), "utf8"), bundle[name]);
  assert.deepEqual(await verifyPublicationUnchanged({ baselineDir, fetchImpl: fakeFetch(bundle) }), { verifiedFiles: 9 });
  for (const name of ARTIFACTS) await t.test(name, async () => {
    const changed = { ...bundle, [name]: `${bundle[name]}\n` };
    await assert.rejects(verifyPublicationUnchanged({ baselineDir, fetchImpl: fakeFetch(changed) }), /publication_live_changed_before_deploy/);
  });
});
