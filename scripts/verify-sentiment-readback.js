import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LIVE_ARTIFACTS } from "./publish-sentiment-repair.js";

export async function verifySentimentReadback({ siteDir = "site", fetchImpl = fetch, attempts = 6,
  wait = () => new Promise(resolve => setTimeout(resolve, 10000)) } = {}) {
  const expected = await Promise.all(LIVE_ARTIFACTS.map(name => readFile(path.join(siteDir, name))));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const matches = await Promise.all(LIVE_ARTIFACTS.map(async (name, index) => {
      try {
        const response = await fetchImpl(`https://bluenews-7g0.pages.dev/${name}`, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) { await response.body?.cancel(); return false; }
        return Buffer.from(await response.arrayBuffer()).equals(expected[index]);
      } catch { return false; }
    }));
    if (matches.every(Boolean)) return { verifiedFiles: LIVE_ARTIFACTS.length, readbackAttempt: attempt };
    if (attempt < attempts) await wait();
  }
  throw new Error("sentiment_publication_readback_mismatch");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifySentimentReadback().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
