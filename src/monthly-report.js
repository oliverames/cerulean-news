// Monthly leadership report: a one-page summary of brand press coverage built
// from the published feed items, an email rendering of it, and the static
// pages under site/reports/. Everything here is deterministic. The summary
// paragraph is a template over the numbers, with no model calls.
//
// The numbers reuse the definitions on site/trends.html: the coverage set is
// the items the generator marked sentimentEligible (with a publication date),
// volume counts every item in it, and net sentiment is the mean of the five
// labels mapped to +2 through -2 over the scored subset. The one deliberate
// difference is the calendar. Trends buckets by UTC month, and this report
// buckets by America/New_York, because leadership reads the calendar month as
// Vermont lived it.
import { escapeXml } from "./utils.js";
import { writeText } from "./fsx.js";
import { ARCHIVE_MAX_AGE_DAYS } from "./archive.js";

export const REPORT_TIME_ZONE = "America/New_York";
// The first month that gets a page. Blue Cross VT coverage is complete from
// January 1, 2026 (backfilled, and brand stories are kept indefinitely).
export const FIRST_REPORT_MONTH = "2026-01";
const DEFAULT_SITE_URL = "https://cerulean.news";
const OUTLET_LIMIT = 5;
const THEME_LIMIT = 5;
const STORY_LIMIT = 3;
const VERMONT_SECTION = "Vermont Healthcare News";

// Worst-to-best order is reversed so the mix reads positive first, as on the
// trends page. Scores are the same +2 through -2 mapping.
export const SENTIMENT_SCALE = [
  { key: "positive", label: "Positive", score: 2, anchor: 100 },
  { key: "neutral to positive", label: "Neutral to positive", score: 1, anchor: 75 },
  { key: "neutral", label: "Neutral", score: 0, anchor: 50 },
  { key: "neutral to negative", label: "Neutral to negative", score: -1, anchor: 25 },
  { key: "negative", label: "Negative", score: -2, anchor: 0 },
];
const SCALE_BY_KEY = new Map(SENTIMENT_SCALE.map((step) => [step.key, step]));

// Labels that say only that a story is about the brand, which every story in
// the coverage set already is. Mirrors BRAND_LABELS in site/trends.html, and a
// test fails if the two drift apart.
export const BRAND_THEME_LABELS = new Set([
  "BCBSVT",
  "BCBS of Vermont",
  "BCBS Vermont",
  "Blue Cross VT",
  "BlueCross Vermont",
  "Blue Cross and Blue Shield of Vermont",
  "Blue Cross of Vermont",
  "Blue Cross",
  "bluecrossvt.org",
  "Vermont Blue Advantage",
  "Vermont Blues plan",
  "Vermont's largest health insurer",
]);

const monthFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: REPORT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function easternParts(date) {
  const parts = {};
  for (const part of monthFormatter.formatToParts(date)) {
    parts[part.type] = part.value;
  }
  return { year: parts.year, month: parts.month, day: parts.day };
}

// "YYYY-MM" of an instant on the Eastern calendar.
export function easternMonthKey(date) {
  const { year, month } = easternParts(date);
  return `${year}-${month}`;
}

function easternDay(date) {
  const { year, month, day } = easternParts(date);
  return `${year}-${month}-${day}`;
}

function assertMonth(month) {
  if (typeof month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new TypeError(`month must be "YYYY-MM", got ${JSON.stringify(month)}`);
  }
}

function shiftMonth(month, delta) {
  const [year, number] = month.split("-").map(Number);
  const index = year * 12 + (number - 1) + delta;
  const nextYear = Math.floor(index / 12);
  return `${nextYear}-${String((index % 12) + 1).padStart(2, "0")}`;
}

// Every month from `from` through `to`, inclusive.
export function monthsBetween(from, to) {
  const months = [];
  for (let month = from; month <= to; month = shiftMonth(month, 1)) {
    months.push(month);
  }
  return months;
}

function longMonthLabel(month) {
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year, number - 1, 15)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function longDayLabel(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function shortDayLabel(date) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: REPORT_TIME_ZONE,
  });
}

function outletOf(item) {
  return item.outlet || item.sourceName || "Unknown";
}

function publishedAt(item) {
  if (!item?.pubDate) {
    return null;
  }
  const date = item.pubDate instanceof Date ? item.pubDate : new Date(item.pubDate);
  return Number.isNaN(date.valueOf()) ? null : date;
}

function percentChange(value, prior) {
  return prior > 0 ? Math.round(((value - prior) / prior) * 100) : null;
}

function mean(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

// The scored subset of a coverage set, as trends.html defines it.
function scoredOf(coverage) {
  return coverage.filter((item) => SCALE_BY_KEY.has(item.sentiment));
}

function netOf(scored) {
  return mean(scored.map((item) => SCALE_BY_KEY.get(item.sentiment).score));
}

// Story title without the trailing " - Outlet" that Google News appends.
function cleanTitle(item) {
  const title = String(item.title || "").trim();
  const outlet = outletOf(item);
  const suffix = ` - ${outlet}`;
  return title.endsWith(suffix) ? title.slice(0, -suffix.length).trim() : title;
}

// Newest first is the tie-break, so a rerun never reshuffles equal stories.
function storyOrder(direction) {
  return (a, b) =>
    direction * (b.rank - a.rank) ||
    b.date.valueOf() - a.date.valueOf() ||
    a.title.localeCompare(b.title);
}

// Picks the strongest stories on one side of neutral. Several outlets often
// report one event, so each story group appears once, led by its best copy.
function pickStories(scored, side) {
  const candidates = scored
    .map((item) => {
      const step = SCALE_BY_KEY.get(item.sentiment);
      const hasScore = Number.isFinite(item.sentimentScore);
      return {
        item,
        step,
        // Label first, then Jev's 0-100 reading where present, else the
        // label's own point on that scale.
        rank: step.score * 1000 + (hasScore ? item.sentimentScore : step.anchor),
        date: publishedAt(item),
        title: cleanTitle(item),
      };
    })
    .filter((entry) => (side === "favorable" ? entry.step.score > 0 : entry.step.score < 0))
    .sort(storyOrder(side === "favorable" ? 1 : -1));

  const seen = new Set();
  const stories = [];
  for (const entry of candidates) {
    // A story group is one event. The title check also folds together the
    // same notice run by two outlets that no group links.
    const groupKey = entry.item.storyGroupId || entry.item.id || entry.item.url || entry.title;
    const titleKey = `title:${entry.title.toLowerCase()}`;
    if (seen.has(groupKey) || seen.has(titleKey)) {
      continue;
    }
    seen.add(groupKey);
    seen.add(titleKey);
    stories.push({
      title: entry.title,
      outlet: outletOf(entry.item),
      url: entry.item.url || entry.item.link || "",
      date: easternDay(entry.date),
      sentiment: entry.step.key,
      sentimentScore: Number.isFinite(entry.item.sentimentScore)
        ? entry.item.sentimentScore
        : null,
    });
    if (stories.length === STORY_LIMIT) {
      break;
    }
  }
  return stories;
}

function topOutlets(coverage) {
  const counts = new Map();
  for (const item of coverage) {
    counts.set(outletOf(item), (counts.get(outletOf(item)) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, OUTLET_LIMIT)
    .map(([outlet, count]) => ({
      outlet,
      count,
      share: coverage.length > 0 ? count / coverage.length : 0,
    }));
}

function topThemes(coverage) {
  const counts = new Map();
  for (const item of coverage) {
    // A story counts once per theme, however the matcher listed it.
    for (const term of new Set(item.matchedTerms || item.tags || [])) {
      if (!BRAND_THEME_LABELS.has(term)) {
        counts.set(term, (counts.get(term) || 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, THEME_LIMIT)
    .map(([term, count]) => ({ term, count }));
}

// The first instant of an Eastern calendar month. Midnight Eastern is 04:00 UTC
// in summer and 05:00 UTC in winter, so one of the two hours is the start.
function easternMonthStart(month) {
  const [year, number] = month.split("-").map(Number);
  const start = Date.UTC(year, number - 1, 1, 4);
  return new Date(easternMonthKey(new Date(start)) === month ? start : start + 60 * 60 * 1000);
}

// True while every story published in the month is still inside the archive
// window. Stories outside Blue Cross VT coverage leave the archive after
// `retentionDays`, so only such a month gives a Vermont total that is whole.
export function monthFullyRetained(month, now, retentionDays = ARCHIVE_MAX_AGE_DAYS) {
  const cutoff = now.valueOf() - retentionDays * 24 * 60 * 60 * 1000;
  return easternMonthStart(month).valueOf() >= cutoff;
}

// The trends page's coverage set for one month. Older feeds predate
// sentimentEligible, so it falls back to "has a score" as trends.html does.
export function coverageForMonth(items, month) {
  return (Array.isArray(items) ? items : []).filter(
    (item) =>
      (item.sentimentEligible || item.sentiment) &&
      publishedAt(item) &&
      easternMonthKey(publishedAt(item)) === month,
  );
}

export function vermontCounts(items, month) {
  const inMonth = items.filter(
    (item) =>
      item.relevant !== false &&
      item.section === VERMONT_SECTION &&
      publishedAt(item) &&
      easternMonthKey(publishedAt(item)) === month,
  );
  return {
    volume: inMonth.length,
    // Outlets that report one event share a storyGroupId.
    distinctStories: new Set(inMonth.map((item) => item.storyGroupId || item.id || item.url))
      .size,
  };
}

// One month's Vermont total: counted live while the month is fully in the
// archive, else the snapshot recorded then, else marked incomplete.
function vermontMonth(items, month, { now, retentionDays, totals }) {
  if (monthFullyRetained(month, now, retentionDays)) {
    return { complete: true, ...vermontCounts(items, month) };
  }
  const snapshot = totals?.[month];
  if (snapshot) {
    return { complete: true, volume: snapshot.volume, distinctStories: snapshot.distinctStories };
  }
  return { complete: false, volume: null, distinctStories: null };
}

export function vermontUnavailableText(retentionDays) {
  return `Not available: the archive keeps these stories for ${retentionDays} days.`;
}

export function formatNet(value) {
  if (value === null || value === undefined) {
    return "n/a";
  }
  const rounded = Math.round(value * 100) / 100;
  return (rounded > 0 ? "+" : "") + rounded.toFixed(2);
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function joinList(values) {
  if (values.length <= 1) {
    return values.join("");
  }
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function volumeClause(report, subject) {
  const { volume, priorVolume, change, changePct } = subject;
  const prior = report.priorLabel.split(" ")[0];
  if (report.toDate) {
    return `against ${priorVolume} in all of ${prior}`;
  }
  if (change === 0) {
    return `the same as the ${priorVolume} in ${prior}`;
  }
  const pct = changePct === null ? "" : ` (${Math.abs(changePct)}%)`;
  return `${change > 0 ? "up" : "down"} ${Math.abs(change)}${pct} from ${priorVolume} in ${prior}`;
}

// Plain-language paragraph over the report's own numbers.
function summaryText(report) {
  const { brand, vermont } = report;
  const period = report.toDate
    ? `${longMonthLabel(report.month)} so far, through ${longDayLabel(report.asOf)}`
    : longMonthLabel(report.month);
  const sentences = [];

  if (brand.volume === 0) {
    sentences.push(
      `In ${period}, no press coverage naming Blue Cross and Blue Shield of Vermont was recorded, ${volumeClause(report, brand)}.`,
    );
  } else {
    sentences.push(
      `In ${period}, ${plural(brand.volume, "story", "stories")} named Blue Cross and Blue Shield of Vermont, ${volumeClause(report, brand)}.`,
    );

    if (brand.scored === 0) {
      sentences.push("None of these has been scored for sentiment yet.");
    } else {
      const tone =
        brand.net > 0.25
          ? "leaning favorable"
          : brand.net < -0.25
            ? "leaning unfavorable"
            : "close to neutral";
      const prior =
        brand.priorNet === null
          ? ""
          : `, ${brand.net >= brand.priorNet ? "up" : "down"} from ${formatNet(brand.priorNet)} in ${report.priorLabel.split(" ")[0]}`;
      const awaiting =
        brand.awaitingScore > 0 ? `, with ${brand.awaitingScore} still awaiting a score` : "";
      sentences.push(
        `Net sentiment was ${formatNet(brand.net)} on a scale from -2 to +2, ${tone}${prior}. Of ${plural(brand.scored, "scored story", "scored stories")}, ${brand.favorable} ${brand.favorable === 1 ? "was" : "were"} favorable and ${brand.adverse} adverse${awaiting}.`,
      );
    }

    if (report.outlets.length > 0) {
      const lead = report.outlets[0];
      sentences.push(
        `${lead.outlet} carried the most coverage, with ${plural(lead.count, "story", "stories")}.`,
      );
    }
    if (report.themes.length > 0) {
      sentences.push(
        `The most frequent themes were ${joinList(report.themes.map((theme) => theme.term))}.`,
      );
    }
  }

  const priorMonthName = report.priorLabel.split(" ")[0];
  if (!vermont.complete) {
    sentences.push(
      `The Vermont health care total for ${longMonthLabel(report.month).split(" ")[0]} is not available, because the archive keeps these stories for ${report.retentionDays} days.`,
    );
  } else if (!vermont.priorComplete) {
    sentences.push(
      `Vermont health care coverage ran to ${plural(vermont.volume, "story", "stories")}. There is no comparison with ${priorMonthName}, because the archive keeps these stories for ${report.retentionDays} days.`,
    );
  } else {
    sentences.push(
      `Vermont health care coverage ran to ${plural(vermont.volume, "story", "stories")}, ${volumeClause(report, vermont)}.`,
    );
  }
  return sentences.join(" ");
}

// Builds the report for one Eastern calendar month from published feed items.
// `state` is the monthlyReports crawl state: Vermont snapshots for months that
// have left the archive window, and the cached AI findings.
export function buildMonthlyReport(
  items,
  { month, now = new Date(), state = null, retentionDays = ARCHIVE_MAX_AGE_DAYS } = {},
) {
  assertMonth(month);
  const nowDate = now instanceof Date ? now : new Date(now);
  const list = Array.isArray(items) ? items : [];
  const priorMonth = shiftMonth(month, -1);
  const toDate = month === easternMonthKey(nowDate);

  const current = coverageForMonth(list, month);
  const prior = coverageForMonth(list, priorMonth);

  const scored = scoredOf(current);
  const net = netOf(scored);
  const priorNet = netOf(scoredOf(prior));
  const counts = new Map();
  for (const item of scored) {
    counts.set(item.sentiment, (counts.get(item.sentiment) || 0) + 1);
  }
  const scores = scored
    .map((item) => item.sentimentScore)
    .filter((value) => Number.isFinite(value));
  const meanScore = mean(scores);
  const vermontOptions = { now: nowDate, retentionDays, totals: state?.vermontTotals };
  const vermontNow = vermontMonth(list, month, vermontOptions);
  const vermontPrior = vermontMonth(list, priorMonth, vermontOptions);
  const vermontCompare = vermontNow.complete && vermontPrior.complete;
  const cachedFindings = state?.findings?.[month];

  const report = {
    month,
    label: longMonthLabel(month),
    priorMonth,
    priorLabel: longMonthLabel(priorMonth),
    toDate,
    asOf: toDate ? easternDay(nowDate) : null,
    timeZone: REPORT_TIME_ZONE,
    brand: {
      volume: current.length,
      priorVolume: prior.length,
      change: current.length - prior.length,
      changePct: percentChange(current.length, prior.length),
      scored: scored.length,
      awaitingScore: current.length - scored.length,
      net,
      priorNet,
      netChange: net !== null && priorNet !== null ? net - priorNet : null,
      favorable: scored.filter((item) => SCALE_BY_KEY.get(item.sentiment).score > 0).length,
      adverse: scored.filter((item) => SCALE_BY_KEY.get(item.sentiment).score < 0).length,
      mix: SENTIMENT_SCALE.map((step) => ({
        key: step.key,
        label: step.label,
        score: step.score,
        count: counts.get(step.key) || 0,
        share: scored.length > 0 ? (counts.get(step.key) || 0) / scored.length : 0,
      })),
      // Jev's 0-100 reading, present on some scored stories only.
      meanScore: { mean: meanScore, count: scores.length, of: scored.length },
    },
    outlets: topOutlets(current),
    favorable: pickStories(scored, "favorable"),
    unfavorable: pickStories(scored, "unfavorable"),
    themes: topThemes(current),
    // volume is null when the month has left the archive with no snapshot,
    // and the change is null whenever either month is incomplete.
    vermont: {
      complete: vermontNow.complete,
      priorComplete: vermontPrior.complete,
      volume: vermontNow.volume,
      priorVolume: vermontPrior.volume,
      change: vermontCompare ? vermontNow.volume - vermontPrior.volume : null,
      changePct: vermontCompare ? percentChange(vermontNow.volume, vermontPrior.volume) : null,
      distinctStories: vermontNow.distinctStories,
    },
    retentionDays,
    // AI-written lines from the cache, shown after the deterministic summary.
    findings: cachedFindings
      ? { lines: cachedFindings.lines, asOf: toDate ? cachedFindings.asOf || null : null }
      : null,
  };
  report.summary = summaryText(report);
  return report;
}

// ---- shared display helpers -------------------------------------------------

// Only http(s) links are rendered as links. Story URLs come from feeds we do
// not control, and a javascript: or data: URL must never reach an href.
export function safeHref(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function periodLabel(report) {
  return report.toDate ? `${report.label} (to date)` : report.label;
}

function changeText(subject, report) {
  const prior = report.priorLabel.split(" ")[0];
  if (report.toDate) {
    return `Against ${subject.priorVolume} in all of ${prior}`;
  }
  if (subject.change === 0) {
    return `No change from ${prior}`;
  }
  const pct = subject.changePct === null ? "" : ` (${Math.abs(subject.changePct)}%)`;
  return `${subject.change > 0 ? "Up" : "Down"} ${Math.abs(subject.change)}${pct} from ${prior}`;
}

// The Vermont comparison line, which says so when a month's total is missing
// instead of computing a change from it.
function vermontChangeText(vermont, report) {
  if (!vermont.complete) {
    return vermontUnavailableText(report.retentionDays);
  }
  if (!vermont.priorComplete) {
    return `No comparison: ${report.priorLabel.split(" ")[0]}'s total is not available, because the archive keeps these stories for ${report.retentionDays} days`;
  }
  return changeText(vermont, report);
}

// "What stood out": AI-written lines, always labeled, empty when none exist.
function findingsLabel(report) {
  const asOf = report.findings?.asOf;
  return asOf ? `AI-generated, as of ${longDayLabel(asOf)}` : "AI-generated";
}

function meanScoreText(brand) {
  const { mean: value, count, of } = brand.meanScore;
  if (value === null) {
    return of > 0
      ? "No 0-100 sentiment score is available yet for these stories."
      : "No scored stories yet.";
  }
  return `Mean sentiment score ${value.toFixed(1)} on a 0-100 scale (50 is neutral), from ${count} of ${of} scored ${of === 1 ? "story" : "stories"}.`;
}

function storyMeta(story) {
  const score = story.sentimentScore === null ? "" : `, score ${Math.round(story.sentimentScore)}`;
  const label = SCALE_BY_KEY.get(story.sentiment)?.label || story.sentiment;
  return `${story.outlet}, ${shortDayLabel(new Date(`${story.date}T12:00:00Z`))}. ${label}${score}.`;
}

// ---- email ------------------------------------------------------------------

const EMAIL_FONT = "Helvetica, Arial, sans-serif";

function emailStoryRows(stories, emptyText) {
  if (stories.length === 0) {
    return `<tr><td style="padding:4px 0;font:14px/1.45 ${EMAIL_FONT};color:#555555;">${escapeXml(emptyText)}</td></tr>`;
  }
  return stories
    .map((story) => {
      const href = safeHref(story.url);
      const title = href
        ? `<a href="${escapeXml(href)}" style="color:#0000cc;">${escapeXml(story.title)}</a>`
        : escapeXml(story.title);
      return `<tr><td style="padding:5px 0;font:14px/1.45 ${EMAIL_FONT};color:#111111;">${title}<br><span style="font-size:12px;color:#555555;">${escapeXml(storyMeta(story))}</span></td></tr>`;
    })
    .join("");
}

function emailSection(title, body, label = "") {
  const tag = label
    ? ` <span style="font:italic 12px/1.3 ${EMAIL_FONT};font-weight:normal;color:#555555;">${escapeXml(label)}</span>`
    : "";
  return `<tr><td style="padding:18px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:0 0 4px;border-bottom:1px solid #cccccc;font:bold 15px/1.3 ${EMAIL_FONT};color:#111111;">${escapeXml(title)}${tag}</td></tr>${body}</table></td></tr>`;
}

// One bullet per line, as email-safe rows. Empty when there are no findings.
function emailFindings(report) {
  if (!report.findings) {
    return "";
  }
  const rows = report.findings.lines
    .map(
      (line) =>
        `<tr><td style="padding:3px 0;font:14px/1.45 ${EMAIL_FONT};color:#111111;">&bull; ${escapeXml(line)}</td></tr>`,
    )
    .join("");
  return `${emailSection("What stood out", rows, findingsLabel(report))}\n`;
}

function emailStat(value, caption) {
  return `<td width="25%" valign="top" style="padding:8px 8px;border:1px solid #e1e1e1;"><div style="font:bold 22px/1.15 ${EMAIL_FONT};color:#111111;">${escapeXml(value)}</div><div style="font:12px/1.3 ${EMAIL_FONT};color:#555555;padding-top:2px;">${escapeXml(caption)}</div></td>`;
}

// Email-safe rendering: tables and inline styles only, no scripts, no
// stylesheet, no remote images. Every value from the feed is escaped.
export function renderMonthlyReportEmail(report, { siteUrl = DEFAULT_SITE_URL } = {}) {
  const { brand, vermont } = report;
  const reportUrl = `${String(siteUrl).replace(/\/+$/, "")}/reports/${report.month}`;
  const subject = `Cerulean News monthly report: ${periodLabel(report)}`;

  const mixRows = brand.mix
    .map(
      (step) =>
        `<tr><td width="45%" style="padding:3px 0;font:13px/1.3 ${EMAIL_FONT};color:#111111;">${escapeXml(step.label)}</td><td width="10%" align="right" style="padding:3px 6px;font:13px/1.3 ${EMAIL_FONT};color:#111111;">${step.count}</td><td width="45%" style="padding:3px 0;"><table role="presentation" width="${Math.round(step.share * 100)}%" cellpadding="0" cellspacing="0" border="0"><tr><td height="10" bgcolor="${MIX_COLORS[step.key]}" style="font-size:1px;line-height:10px;">&nbsp;</td></tr></table></td></tr>`,
    )
    .join("");

  const outletRows =
    report.outlets.length === 0
      ? `<tr><td style="padding:4px 0;font:14px/1.45 ${EMAIL_FONT};color:#555555;">No brand coverage this month.</td></tr>`
      : report.outlets
          .map(
            (outlet) =>
              `<tr><td style="padding:3px 0;font:14px/1.4 ${EMAIL_FONT};color:#111111;">${escapeXml(outlet.outlet)}</td><td align="right" style="padding:3px 0;font:14px/1.4 ${EMAIL_FONT};color:#111111;">${outlet.count}</td></tr>`,
          )
          .join("");

  const themeRows =
    report.themes.length === 0
      ? `<tr><td style="padding:4px 0;font:14px/1.45 ${EMAIL_FONT};color:#555555;">No themes recorded.</td></tr>`
      : report.themes
          .map(
            (theme) =>
              `<tr><td style="padding:3px 0;font:14px/1.4 ${EMAIL_FONT};color:#111111;">${escapeXml(theme.term)}</td><td align="right" style="padding:3px 0;font:14px/1.4 ${EMAIL_FONT};color:#111111;">${theme.count}</td></tr>`,
          )
          .join("");

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeXml(subject)}</title></head>
<body style="margin:0;padding:0;background:#ffffff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff"><tr><td align="center" style="padding:18px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">
<tr><td style="font:bold 24px/1.2 ${EMAIL_FONT};color:#111111;padding:0 0 6px;">Monthly report: ${escapeXml(periodLabel(report))}</td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="33%" height="5" bgcolor="#0033a0" style="font-size:1px;line-height:5px;">&nbsp;</td><td width="34%" height="5" bgcolor="#111111" style="font-size:1px;line-height:5px;">&nbsp;</td><td width="33%" height="5" bgcolor="#418fde" style="font-size:1px;line-height:5px;">&nbsp;</td></tr></table></td></tr>
<tr><td style="padding:14px 0 0;font:16px/1.5 ${EMAIL_FONT};color:#111111;">${escapeXml(report.summary)}</td></tr>
${emailFindings(report)}<tr><td style="padding:14px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${emailStat(String(brand.volume), "Stories naming the brand")}${emailStat(formatNet(brand.net), "Net sentiment, -2 to +2")}${emailStat(String(brand.favorable), "Favorable stories")}${emailStat(vermont.complete ? String(vermont.volume) : "n/a", "Vermont health care stories")}</tr></table></td></tr>
${emailSection("Sentiment mix", `<tr><td style="padding:6px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${mixRows}</table><div style="padding-top:6px;font:12px/1.4 ${EMAIL_FONT};color:#555555;">${escapeXml(meanScoreText(brand))}</div></td></tr>`)}
${emailSection("Top outlets", `<tr><td style="padding:6px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${outletRows}</table></td></tr>`)}
${emailSection("Most favorable stories", `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${emailStoryRows(report.favorable, "No favorable stories this month.")}</table></td></tr>`)}
${emailSection("Least favorable stories", `<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${emailStoryRows(report.unfavorable, "No adverse stories this month.")}</table></td></tr>`)}
${emailSection("Top themes", `<tr><td style="padding:6px 0 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${themeRows}</table></td></tr>`)}
<tr><td style="padding:18px 0 0;font:14px/1.5 ${EMAIL_FONT};color:#111111;"><a href="${escapeXml(reportUrl)}" style="color:#0000cc;">Open the full report</a></td></tr>
<tr><td style="padding:18px 0 0;font:12px/1.45 ${EMAIL_FONT};color:#555555;">Sentiment scores are AI-generated, so treat them as a first pass.</td></tr>
</table>
</td></tr></table>
</body></html>
`;

  const lines = [
    `Cerulean News monthly report: ${periodLabel(report)}`,
    "",
    report.summary,
    "",
    ...(report.findings
      ? [
          `What stood out (${findingsLabel(report)})`,
          ...report.findings.lines.map((line) => `  - ${line}`),
          "",
        ]
      : []),
    `Stories naming the brand: ${brand.volume} (${changeText(brand, report)})`,
    `Net sentiment (-2 to +2): ${formatNet(brand.net)}`,
    `Scored stories: ${brand.scored}, favorable ${brand.favorable}, adverse ${brand.adverse}, awaiting a score ${brand.awaitingScore}`,
    meanScoreText(brand),
    "",
    "Sentiment mix",
    ...brand.mix.map((step) => `  ${step.label}: ${step.count}`),
    "",
    "Top outlets",
    ...(report.outlets.length > 0
      ? report.outlets.map((outlet) => `  ${outlet.outlet}: ${outlet.count}`)
      : ["  None"]),
    "",
    "Most favorable stories",
    ...(report.favorable.length > 0
      ? report.favorable.flatMap((story) => textStoryLines(story))
      : ["  None"]),
    "",
    "Least favorable stories",
    ...(report.unfavorable.length > 0
      ? report.unfavorable.flatMap((story) => textStoryLines(story))
      : ["  None"]),
    "",
    "Top themes",
    ...(report.themes.length > 0
      ? report.themes.map((theme) => `  ${theme.term}: ${theme.count}`)
      : ["  None"]),
    "",
    `Vermont health care stories: ${vermont.complete ? `${vermont.volume} (${vermontChangeText(vermont, report)})` : vermontChangeText(vermont, report)}`,
    "",
    `Full report: ${reportUrl}`,
    "",
    "Sentiment scores are AI-generated, so treat them as a first pass.",
  ];

  return { subject, html, text: `${lines.join("\n")}\n` };
}

function textStoryLines(story) {
  const href = safeHref(story.url);
  return [`  ${story.title}`, `    ${storyMeta(story)}`, ...(href ? [`    ${href}`] : [])];
}

// The diverging ramp from trends.html, so a colour always follows the label.
const MIX_COLORS = {
  positive: "#0d4c9e",
  "neutral to positive": "#4a90d9",
  neutral: "#dcdcd9",
  "neutral to negative": "#e8883a",
  negative: "#b02a1f",
};

// ---- pages ------------------------------------------------------------------

const PAGE_STYLE = `
      :root {
        --bg: #fff; --fg: #111; --muted: #555; --link: #0000cc; --visited: #551a8b;
        --rule: #ccc; --rule-soft: #e1e1e1; --surface: #f5f8fc;
        --bar-1: #0033a0; --bar-2: #111; --bar-3: #418fde;
        --s-pos: #0d4c9e; --s-npos: #4a90d9; --s-neu: #dcdcd9; --s-nneg: #e8883a; --s-neg: #b02a1f;
      }
      body { margin: 0; background: var(--bg); color: var(--fg); font-family: Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.45; }
      .page { max-width: 560px; margin: 0 auto; padding: 18px 16px 48px; }
      .topbar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; font-size: 0.9rem; margin-bottom: 24px; }
      .topbar .button { display: inline-block; padding: 4px 12px; border: 1px solid var(--fg); color: var(--fg); text-decoration: none; background: none; font: inherit; cursor: pointer; }
      .topbar .button:hover { background: var(--surface); }
      h1 { margin: 0 0 6px; font-size: 1.65rem; font-weight: 700; }
      h2 { margin: 26px 0 6px; padding: 0 0 3px; border-bottom: 1px solid var(--rule); font-size: 1rem; font-weight: 700; }
      .title-row { display: flex; align-items: baseline; gap: 24px; margin: 0 0 6px; }
      .title-row h1 { flex: 1 1 auto; margin: 0; }
      .tricolor { display: flex; height: 5px; margin: 0 0 18px; }
      .tricolor span { flex: 1; }
      .tricolor .c1 { background: var(--bar-1); }
      .tricolor .c2 { background: var(--bar-2); }
      .tricolor .c3 { background: var(--bar-3); }
      .dateline { font-style: italic; margin: 0 0 0 auto; text-align: right; white-space: nowrap; }
      @media (max-width: 640px) { .title-row { display: block; } .title-row h1 { margin-bottom: 4px; } .dateline { margin: 0; text-align: left; } }
      a { color: var(--link); }
      a:visited { color: var(--visited); }
      a:focus-visible, button:focus-visible { outline: 3px solid var(--bar-3); outline-offset: 2px; }
      .visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
      .summary { margin: 0 0 20px; }
      .findings h2 { margin-top: 0; }
      ul.findings-list { margin: 6px 0 20px; padding-left: 1.3em; }
      ul.findings-list li { margin: 0 0 6px; }
      .tag { margin-left: 8px; color: var(--muted); font-size: 0.8rem; font-style: italic; font-weight: 400; }
      .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; margin: 0 0 8px; background: var(--rule-soft); border: 1px solid var(--rule-soft); }
      .tile { background: var(--bg); padding: 10px 12px; }
      .tile .value { display: block; font-size: 1.5rem; font-weight: 700; line-height: 1.15; font-variant-numeric: tabular-nums; }
      .tile .caption { display: block; margin-top: 2px; color: var(--muted); font-size: 0.78rem; line-height: 1.3; }
      @media (max-width: 560px) { .tiles { grid-template-columns: repeat(2, 1fr); } }
      .note { margin: 6px 0 0; color: var(--muted); font-size: 0.82rem; line-height: 1.4; }
      table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
      th, td { padding: 4px 6px; border-bottom: 1px solid var(--rule-soft); text-align: right; font-variant-numeric: tabular-nums; vertical-align: middle; }
      th:first-child, td:first-child { text-align: left; padding-left: 0; }
      thead th { border-bottom: 1px solid var(--rule); color: var(--muted); font-size: 0.78rem; font-weight: 400; }
      td.track { width: 42%; padding-right: 0; }
      .bar { display: block; height: 10px; min-width: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; border: 1px solid rgba(0, 0, 0, 0.18); box-sizing: border-box; }
      .bar.empty { border-color: transparent; }
      ol.stories { margin: 6px 0 0; padding-left: 1.3em; }
      ol.stories li { margin: 0 0 8px; }
      .meta { display: block; color: var(--muted); font-size: 0.82rem; }
      .index-list { list-style: none; margin: 0; padding: 0; }
      .index-list li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 12px; padding: 8px 0; border-bottom: 1px solid var(--rule-soft); }
      .index-list .stat { margin-left: auto; color: var(--muted); font-size: 0.85rem; font-variant-numeric: tabular-nums; }
      footer { margin-top: 24px; font-size: 0.8rem; color: var(--muted); line-height: 1.45; }
      footer::before { content: ""; display: block; height: 5px; margin-bottom: 16px; background: linear-gradient(to right, var(--bar-1) 0 33.333%, var(--bar-2) 33.333% 66.666%, var(--bar-3) 66.666% 100%); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .affiliation { margin: 0 0 14px; padding: 10px 12px; border: 2px solid var(--bar-1); border-radius: 4px; color: var(--fg); font-size: 15px; line-height: 1.45; }
      .affiliation strong { color: var(--bar-1); }
      .copyright { margin: 14px 0 0; color: var(--muted); font-size: 13px; }
      .site-notes { display: grid; grid-template-columns: max-content 1fr; column-gap: 10px; row-gap: 5px; margin: 0; }
      .site-notes dt { color: var(--fg); font-weight: 700; }
      .site-notes dd { margin: 0; }
      footer a { color: var(--muted); }
      @media (max-width: 520px) {
        .site-notes { display: block; }
        .site-notes dt { display: inline; }
        .site-notes dt::after { content: ": "; }
        .site-notes dd { display: inline; }
        .site-notes dd::after { content: ""; display: block; margin-bottom: 6px; }
      }
      /* Print: Save as PDF gives one or two clean pages, light and without chrome. */
      @page { size: letter; margin: 0.6in; }
      @media print {
        :root { --bg: #fff; --fg: #000; --muted: #444; --link: #000; --visited: #000; --rule: #999; --rule-soft: #ccc; --surface: #fff; --bar-1: #0033a0; --bar-2: #111; --bar-3: #418fde; }
        body { font-size: 10.5pt; line-height: 1.35; }
        .page { max-width: none; padding: 0; }
        .topbar { display: none; }
        h1 { font-size: 20pt; }
        h2 { margin-top: 14pt; break-after: avoid; }
        .tile, ol.stories li, tr, .affiliation { break-inside: avoid; }
        section { break-inside: avoid-page; }
        .tiles { grid-template-columns: repeat(4, 1fr); }
        a { color: inherit; text-decoration: none; }
        footer { margin-top: 12pt; font-size: 8.5pt; }
        .affiliation { font-size: 9pt; padding: 6pt 8pt; }
        .site-notes { font-size: 8.5pt; }
        .copyright { font-size: 8pt; margin-top: 8pt; }
      }`;

const PAGE_FOOTER = `
      <footer>
        <p class="affiliation">
          <strong>Not affiliated.</strong> Cerulean News is an independent personal
          project. It is not affiliated with, endorsed by, or operated by Blue
          Cross and Blue Shield of Vermont or the Blue Cross Blue Shield
          Association.
        </p>
FOOTER_NOTES
        <p class="copyright">&copy; <span id="copyright-year">2026</span> Ames Consulting, LLC. The site's source code is released under the <a href="https://opensource.org/license/mit">MIT License</a>.</p>
        <script>
          document.getElementById("copyright-year").textContent = String(new Date().getFullYear());
        </script>
      </footer>`;

function pageShell({ title, description, body, notes }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeXml(title)}</title>
    <meta name="description" content="${escapeXml(description)}">
    <meta name="robots" content="noindex">
    <link rel="icon" type="image/png" sizes="32x32" href="../favicon-32x32.png">
    <link rel="icon" type="image/png" sizes="16x16" href="../favicon-16x16.png">
    <link rel="apple-touch-icon" sizes="180x180" href="../apple-touch-icon.png">
    <link rel="manifest" href="../site.webmanifest">
    <meta name="theme-color" content="#0033a0">
    <style>${PAGE_STYLE}
    </style>
    <link rel="stylesheet" href="../gate.css">
    <script>
      try { if (localStorage.getItem("blueNewsAuth") === "true") document.documentElement.classList.add("authenticated"); } catch (e) {}
    </script>
  </head>
  <body>
    <script src="../gate.js"></script>
    <div class="page">
${body}
${PAGE_FOOTER.replace("FOOTER_NOTES", notes)}
    </div>
  </body>
</html>
`;
}

function storyItems(stories, emptyText) {
  if (stories.length === 0) {
    return `<p class="note">${escapeXml(emptyText)}</p>`;
  }
  const items = stories
    .map((story) => {
      const href = safeHref(story.url);
      const title = href
        ? `<a href="${escapeXml(href)}">${escapeXml(story.title)}</a>`
        : escapeXml(story.title);
      return `<li>${title}<span class="meta">${escapeXml(storyMeta(story))}</span></li>`;
    })
    .join("\n          ");
  return `<ol class="stories">\n          ${items}\n        </ol>`;
}

function countRows(rows, key, empty) {
  if (rows.length === 0) {
    return `<p class="note">${escapeXml(empty)}</p>`;
  }
  return `<table><tbody>${rows
    .map(
      (row) =>
        `<tr><td>${escapeXml(row[key])}</td><td>${row.count}</td></tr>`,
    )
    .join("")}</tbody></table>`;
}

const REPORT_NOTES = `        <dl class="site-notes">
          <dt>Scope</dt>
          <dd>Press coverage that names the insurer, the same set the <a href="../trends">trends page</a> charts. Vermont health care counts stories filed in the Vermont section.</dd>
          <dt>Calendar</dt>
          <dd>Months run on Eastern time, so a story published late on the last night of a month counts in that month.</dd>
          <dt>Sentiment</dt>
          <dd>Five points from positive (+2) to negative (-2), judged toward the insurer. Net sentiment is the mean over scored stories. The 0-100 score is present on some stories only. Scores are AI-generated, so treat them as a first pass.</dd>
          <dt>Stories</dt>
          <dd>The favorable and adverse lists show one story per group of repeated reports, ranked by label and then by score.</dd>
          <dt>Reports</dt>
          <dd><a href="./">All monthly reports</a>, or <a href="../">back to the reader</a>. Use the browser's print dialog and choose Save as PDF for a copy.</dd>
        </dl>`;

// One month's page, styled like the reader. Print CSS keeps it to a page or two.
export function renderMonthlyReportPage(report) {
  const { brand, vermont } = report;
  const tag = report.toDate ? '<span class="tag">to date</span>' : "";
  const dateline = report.toDate
    ? `Through ${escapeXml(longDayLabel(report.asOf))}`
    : "Full month";
  const mixRows = brand.mix
    .map(
      (step) =>
        `<tr><td>${escapeXml(step.label)}</td><td>${step.count}</td><td>${Math.round(step.share * 100)}%</td><td class="track"><span class="bar${step.count === 0 ? " empty" : ""}" style="width:${Math.round(step.share * 100)}%;background:${MIX_COLORS[step.key]}"></span></td></tr>`,
    )
    .join("");
  const priorNote =
    brand.priorNet === null
      ? `No scored stories in ${escapeXml(report.priorLabel)} to compare with.`
      : `${escapeXml(report.priorLabel)} net sentiment was ${escapeXml(formatNet(brand.priorNet))}.`;
  const vermontNote =
    !vermont.complete || vermont.distinctStories === vermont.volume
      ? ""
      : ` That is ${vermont.distinctStories} distinct stories once repeated reports of one event are grouped.`;
  // Without a whole month there is no count to state and no change to compute.
  const vermontParagraph = !vermont.complete
    ? vermontUnavailableText(report.retentionDays)
    : `${vermont.volume} ${vermont.volume === 1 ? "story" : "stories"} in the Vermont section${
        vermont.priorComplete
          ? `, ${changeText(vermont, report).replace(/^./, (c) => c.toLowerCase())}`
          : `. ${vermontChangeText(vermont, report)}`
      }.`;
  const findings = report.findings
    ? `
        <section class="findings">
          <h2>What stood out<span class="tag">${escapeXml(findingsLabel(report))}</span></h2>
          <ul class="findings-list">
            ${report.findings.lines.map((line) => `<li>${escapeXml(line)}</li>`).join("\n            ")}
          </ul>
        </section>
`
    : "";

  const body = `      <div class="topbar">
        <a class="button" href="../">Back to stories</a>
        <a class="button" href="../trends">Trends</a>
        <a class="button" href="./">All reports</a>
        <button class="button" type="button" onclick="window.print()">Print or save as PDF</button>
      </div>

      <main>
        <div class="title-row">
          <h1>Monthly Report: ${escapeXml(report.label)}${tag}</h1>
          <p class="dateline">${dateline}</p>
        </div>
        <div class="tricolor" aria-hidden="true">
          <span class="c1"></span><span class="c2"></span><span class="c3"></span>
        </div>

        <p class="summary">${escapeXml(report.summary)}</p>
${findings}
        <div class="tiles">
          <div class="tile"><span class="value">${brand.volume}</span><span class="caption">Stories naming the insurer. ${escapeXml(changeText(brand, report))}</span></div>
          <div class="tile"><span class="value">${escapeXml(formatNet(brand.net))}</span><span class="caption">Net sentiment, -2 to +2, over ${brand.scored} scored</span></div>
          <div class="tile"><span class="value">${brand.favorable} / ${brand.adverse}</span><span class="caption">Favorable / adverse stories</span></div>
          <div class="tile"><span class="value">${vermont.complete ? vermont.volume : "n/a"}</span><span class="caption">Vermont health care stories. ${escapeXml(vermontChangeText(vermont, report))}</span></div>
        </div>
        ${report.toDate ? `<p class="note">This month is not over. Changes are shown against all of ${escapeXml(report.priorLabel)}.</p>` : ""}

        <section>
          <h2>Sentiment mix</h2>
          <table>
            <thead><tr><th scope="col">Label</th><th scope="col">Stories</th><th scope="col">Share</th><th scope="col"><span class="visually-hidden">Bar</span></th></tr></thead>
            <tbody>${mixRows}</tbody>
          </table>
          <p class="note">${escapeXml(meanScoreText(brand))} ${brand.awaitingScore > 0 ? `${brand.awaitingScore} more ${brand.awaitingScore === 1 ? "story is" : "stories are"} awaiting a score. ` : ""}${priorNote}</p>
        </section>

        <section>
          <h2>Top outlets</h2>
          ${countRows(report.outlets, "outlet", "No coverage naming the insurer this month.")}
        </section>

        <section>
          <h2>Most favorable stories</h2>
          ${storyItems(report.favorable, "No favorable stories this month.")}
        </section>

        <section>
          <h2>Least favorable stories</h2>
          ${storyItems(report.unfavorable, "No adverse stories this month.")}
        </section>

        <section>
          <h2>Top themes</h2>
          ${countRows(report.themes, "term", "No themes recorded this month.")}
          <p class="note">One story can carry several themes, so these do not sum to the story count.</p>
        </section>

        <section>
          <h2>Vermont health care coverage</h2>
          <p>${escapeXml(vermontParagraph)}${escapeXml(vermontNote)}</p>
        </section>
      </main>`;

  return pageShell({
    title: `Cerulean News: Monthly report, ${periodLabel(report)}`,
    description: `Press coverage summary for ${report.label}.`,
    body,
    notes: REPORT_NOTES,
  });
}

// The list of monthly reports, newest first.
export function renderReportsIndex(reports) {
  const rows = [...reports]
    .sort((a, b) => b.month.localeCompare(a.month))
    .map((report) => {
      const tag = report.toDate ? '<span class="tag">to date</span>' : "";
      const scored = report.brand.scored > 0 ? `, net ${escapeXml(formatNet(report.brand.net))}` : "";
      return `<li><a href="${report.month}">${escapeXml(report.label)}</a>${tag}<span class="stat">${report.brand.volume} ${report.brand.volume === 1 ? "story" : "stories"}${scored}</span></li>`;
    })
    .join("\n          ");
  const body = `      <div class="topbar">
        <a class="button" href="../">Back to stories</a>
        <a class="button" href="../trends">Trends</a>
      </div>

      <main>
        <div class="title-row">
          <h1>Monthly Reports</h1>
        </div>
        <div class="tricolor" aria-hidden="true">
          <span class="c1"></span><span class="c2"></span><span class="c3"></span>
        </div>
        <p class="summary">A one-page summary of press coverage naming the insurer for each month since ${escapeXml(longMonthLabel(FIRST_REPORT_MONTH))}. Each page prints cleanly for Save as PDF.</p>
        <ul class="index-list">
          ${rows}
        </ul>
      </main>`;
  return pageShell({
    title: "Cerulean News: Monthly reports",
    description: "One-page monthly summaries of press coverage.",
    body,
    notes: REPORT_NOTES.replace(/<dt>Stories<\/dt>\s*<dd>[^]*?<\/dd>\s*/, ""),
  });
}

// Every page for the months from the first report month through the current
// one, as { "2026-06.html": html, ..., "index.html": html }.
export function buildMonthlyReportPages(
  items,
  { now = new Date(), firstMonth = FIRST_REPORT_MONTH, state = null } = {},
) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const months = monthsBetween(firstMonth, easternMonthKey(nowDate));
  if (months.length === 0) {
    return {};
  }
  const reports = months.map((month) => buildMonthlyReport(items, { month, now: nowDate, state }));
  const pages = {};
  for (const report of reports) {
    pages[`${report.month}.html`] = renderMonthlyReportPage(report);
  }
  pages["index.html"] = renderReportsIndex(reports);
  // The mail Worker sends the last complete month on the 1st (contract in
  // mail/README.md), so the email is for the month before the current one.
  const lastComplete = reports.length > 1 ? reports[reports.length - 2] : null;
  if (lastComplete) {
    const email = renderMonthlyReportEmail(lastComplete);
    pages["latest-email.json"] = `${JSON.stringify({ month: lastComplete.month, ...email }, null, 2)}\n`;
  }
  return pages;
}

// Writes site/reports/ beside the feed. A reporting problem must never fail
// the feed run, so errors are logged and reported in the return value.
export async function writeMonthlyReports(items, { outputDir, now = new Date(), state = null } = {}) {
  try {
    const pages = buildMonthlyReportPages(items, { now, state });
    const names = Object.keys(pages);
    for (const name of names) {
      await writeText(`${outputDir.replace(/\/+$/, "")}/${name}`, pages[name]);
    }
    return { written: names.length, error: null };
  } catch (error) {
    console.error("Monthly report pages were not written:", error);
    return { written: 0, error };
  }
}
