import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ARTIFACTS = ["feed-audit.json", "feed.json", "feed.rss", "digest.json", "digest.html", "storylines.json", "calendar.json", "calendar.ics", "alerts.json"];
export async function verifyCurrentMain({ repository = process.env.GITHUB_REPOSITORY, sha = process.env.GITHUB_SHA,
  token = process.env.GH_TOKEN, fetchImpl = fetch } = {}) {
  if (repository !== "oliverames/cerulean-news" || !/^[a-f0-9]{40}$/.test(sha || "") || !token) throw new Error("invalid_publication_source_environment");
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/git/ref/heads/main`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok || (await response.json()).object?.sha !== sha) throw new Error("stale_publication_source");
}
export async function fetchPublication({ fetchImpl = fetch, base = "https://bluenews-7g0.pages.dev" } = {}) {
  const get = async name => {
    const response = await fetchImpl(`${base}/${name}`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("publication_artifact_unavailable"); }
    return Buffer.from(await response.arrayBuffer());
  };
  const audit = await get("feed-audit.json");
  const rest = await Promise.all(ARTIFACTS.slice(1).map(async name => [name, await get(name)]));
  if (!audit.equals(await get("feed-audit.json"))) throw new Error("publication_changed_during_seed");
  const bundle = Object.fromEntries([["feed-audit.json", audit], ...rest]);
  const json = name => JSON.parse(bundle[name]);
  const a = json("feed-audit.json"), f = json("feed.json"), d = json("digest.json"), s = json("storylines.json");
  if (a.audit !== true || !Array.isArray(a.items) || !Array.isArray(a.sources) || !a.crawlState || typeof a.crawlState !== "object" || Array.isArray(a.crawlState) || !Array.isArray(f.items) || f.generatedAt !== a.generatedAt ||
    !Array.isArray(d.sections) || typeof d.html !== "string" || typeof d.text !== "string" || !Array.isArray(s.storylines) ||
    !Array.isArray(json("calendar.json").events) || typeof json("alerts.json").count !== "number" || typeof json("alerts.json").html !== "string" || typeof json("alerts.json").text !== "string" ||
    !bundle["feed.rss"].toString().includes("</rss>") || !bundle["digest.html"].toString().toLowerCase().includes("</html>") ||
    !bundle["calendar.ics"].toString().includes("END:VCALENDAR")) throw new Error("invalid_publication_bundle");
  return bundle;
}
export async function seedPublication({ siteDir = "site", baselineDir = "publication-seed", ...options } = {}) {
  const bundle = await fetchPublication(options);
  await Promise.all([mkdir(siteDir, { recursive: true }), mkdir(baselineDir, { recursive: true })]);
  for (const name of ARTIFACTS) await Promise.all([writeFile(path.join(siteDir, name), bundle[name]), writeFile(path.join(baselineDir, name), bundle[name], { mode: 0o600 })]);
  return { seededFiles: ARTIFACTS.length };
}
export async function verifyPublicationUnchanged({ baselineDir = "publication-seed", ...options } = {}) {
  const bundle = await fetchPublication(options);
  for (const name of ARTIFACTS) if (!bundle[name].equals(await readFile(path.join(baselineDir, name)))) throw new Error("publication_live_changed_before_deploy");
  return { verifiedFiles: ARTIFACTS.length };
}
async function main() {
  const command = process.argv[2];
  const result = command === "source" ? await verifyCurrentMain() : command === "seed" ? await seedPublication() : command === "unchanged" ? await verifyPublicationUnchanged() : (() => { throw new Error("invalid_publication_guard_command"); })();
  console.log(JSON.stringify(result || { currentMainVerified: true }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
