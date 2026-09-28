// The monthly report's slice of the crawl state that rides in feed-audit.json.
// Two things must outlive the 92-day archive window, so they are kept here.
//
// - vermontTotals: per month, the Vermont health care story count and the
//   distinct-story count, recorded while the whole month was still inside the
//   archive. Older months would otherwise shrink as their stories aged out.
// - findings: the AI-written "What stood out" lines per month, keyed by a hash
//   of the data they were written from, so a month is generated once.
//
// findingFailures remembers a failed attempt per month and input hash, so a
// broken reply or an outage does not repeat the call on every run.
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const MAX_MONTHS = 120;
const MAX_FINDING_LINES = 4;
const MAX_FINDING_LINE_CHARS = 400;

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isoOrEmpty(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : "";
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// Keeps the newest months when a map grows past the bound.
function boundedByMonth(map) {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)).slice(-MAX_MONTHS));
}

export function normalizeMonthlyReportState(value) {
  const vermontTotals = {};
  for (const [month, entry] of Object.entries(isRecord(value?.vermontTotals) ? value.vermontTotals : {})) {
    const volume = nonNegativeInteger(entry?.volume);
    const distinctStories = nonNegativeInteger(entry?.distinctStories);
    if (MONTH_PATTERN.test(month) && volume !== null && distinctStories !== null) {
      vermontTotals[month] = { volume, distinctStories, recordedAt: isoOrEmpty(entry.recordedAt) };
    }
  }

  const findings = {};
  for (const [month, entry] of Object.entries(isRecord(value?.findings) ? value.findings : {})) {
    const lines = Array.isArray(entry?.lines)
      ? entry.lines
          .filter((line) => typeof line === "string" && line.trim())
          .map((line) => line.trim().slice(0, MAX_FINDING_LINE_CHARS))
          .slice(0, MAX_FINDING_LINES)
      : [];
    if (MONTH_PATTERN.test(month) && typeof entry?.hash === "string" && entry.hash && lines.length > 0) {
      findings[month] = {
        hash: entry.hash,
        lines,
        generatedAt: isoOrEmpty(entry.generatedAt),
        asOf: typeof entry.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.asOf) ? entry.asOf : "",
      };
    }
  }

  const findingFailures = {};
  for (const [month, entry] of Object.entries(isRecord(value?.findingFailures) ? value.findingFailures : {})) {
    if (MONTH_PATTERN.test(month) && typeof entry?.hash === "string" && entry.hash && isoOrEmpty(entry.at)) {
      findingFailures[month] = { hash: entry.hash, at: entry.at };
    }
  }

  return {
    vermontTotals: boundedByMonth(vermontTotals),
    findings: boundedByMonth(findings),
    findingFailures: boundedByMonth(findingFailures),
  };
}
