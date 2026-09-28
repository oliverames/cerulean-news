// Rebuilds site/reports/ from a published feed.json, without a crawl.
// Usage: node scripts/build-monthly-reports.js [siteDirectory]
import path from "node:path";
import { readFile } from "node:fs/promises";
import { writeMonthlyReports } from "../src/monthly-report.js";

const siteDir = path.resolve(process.argv[2] || "site");
const feed = JSON.parse(await readFile(path.join(siteDir, "feed.json"), "utf8"));
const result = await writeMonthlyReports(feed.items || [], {
  outputDir: path.join(siteDir, "reports"),
});
if (result.error) {
  process.exitCode = 1;
} else {
  console.log(`Wrote ${result.written} report pages to ${path.join(siteDir, "reports")}`);
}
