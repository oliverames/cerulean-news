// Writes the clip-email draft next to the RSS output. Kept apart from
// digest.js so buildDigest stays free of I/O.
import path from "node:path";
import { writeText } from "./fsx.js";
import { buildDigest, buildDigestPage } from "./digest.js";

// The feed is already on disk when this runs, so a digest problem is logged
// rather than thrown: it must never block the deploy of a fresh feed.
export async function writeDigestOutputs(items, { now, rssOutputPath }) {
  try {
    const dir = path.dirname(rssOutputPath);
    const digest = buildDigest(items, { now });
    const generatedAt = now.toISOString();
    await writeText(path.join(dir, "digest.html"), buildDigestPage(digest, { generatedAt }));
    await writeText(
      path.join(dir, "digest.json"),
      `${JSON.stringify({ generatedAt, subject: digest.subject, text: digest.text, html: digest.html, sections: digest.sections }, null, 2)}\n`,
    );
    return digest;
  } catch (error) {
    console.error("Clip email digest error:", error);
    return null;
  }
}
