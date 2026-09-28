// Rebuilds site/reports/ from a published feed.json, without a crawl.
// Usage: node scripts/build-monthly-reports.js [siteDirectory]
//
// A static deploy has no crawl state of its own, but the workflow seeds the
// live feed-audit.json into the site directory first. Its crawlState carries
// the Vermont snapshots and the AI findings the last full run recorded, so old
// months keep their totals and the findings still show. This script only reads
// them. It has no API key and never writes the state back.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { writeMonthlyReports } from "../src/monthly-report.js";
import { normalizeMonthlyReportState } from "../src/monthly-report-state.js";

const siteDir = path.resolve(process.argv[2] || "site");
const feed = JSON.parse(await readFile(path.join(siteDir, "feed.json"), "utf8"));

let state = normalizeMonthlyReportState();
try {
  const audit = JSON.parse(await readFile(path.join(siteDir, "feed-audit.json"), "utf8"));
  state = normalizeMonthlyReportState(audit?.crawlState?.monthlyReports);
} catch {
  console.warn("No feed-audit.json to read report snapshots from; old months show as incomplete.");
}

const result = await writeMonthlyReports(feed.items || [], {
  outputDir: path.join(siteDir, "reports"),
  state,
});
if (result.error) {
  process.exitCode = 1;
} else {
  console.log(`Wrote ${result.written} report pages to ${path.join(siteDir, "reports")}`);
}
