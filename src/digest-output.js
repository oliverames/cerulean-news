// Writes the clip-email draft next to the RSS output. Kept apart from
// digest.js so buildDigest stays free of I/O.
import path from "node:path";
import { writeText } from "./fsx.js";
import { MAIL_FOOTER_TEXT, buildDigest, buildDigestPage } from "./digest.js";

// The feed is already on disk when this runs, so a digest problem is logged
// rather than thrown: it must never block the deploy of a fresh feed.
export async function writeDigestOutputs(items, { now, rssOutputPath }) {
  try {
    const dir = path.dirname(rssOutputPath);
    const digest = buildDigest(items, { now });
    // digest.json feeds the mail Worker, which adds its own disclaimer.
    const mailed = buildDigest(items, { now, footer: MAIL_FOOTER_TEXT });
    const generatedAt = now.toISOString();
    await writeText(path.join(dir, "digest.html"), buildDigestPage(digest, { generatedAt }));
    await writeText(
      path.join(dir, "digest.json"),
      `${JSON.stringify({ generatedAt, subject: mailed.subject, text: mailed.text, html: mailed.html, sections: mailed.sections }, null, 2)}\n`,
    );
    return digest;
  } catch (error) {
    console.error("Clip email digest error:", error);
    return null;
  }
}
