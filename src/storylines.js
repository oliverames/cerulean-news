// Storyline tracking: ongoing subjects the timelines page follows over time.
//
// data/storylines.json defines them for tracking only. It carries no scoring
// notes; those live in data/coverage-context.json, which the communications
// team owns and summaries.js reads. This module tags items with the storylines
// they belong to and rolls them up into weekly volume and brand sentiment.
//
// The file is read once at startup. A missing or malformed file simply means no
// storylines, because a broken tracking file must never stop the run.
import { readFileSync } from "node:fs";
import path from "node:path";
import { writeText } from "./fsx.js";
import { itemOutletName } from "./relevance.js";
import { cleanText, parseDate } from "./utils.js";
import { SENTIMENT_VALUES, shouldScoreSentiment } from "./summaries.js";

const STORYLINES_PATH = process.env.STORYLINES_PATH || "data/storylines.json";

function lowerTerms(value) {
  return (Array.isArray(value) ? value : [])
    .map((term) => String(term || "").toLowerCase().trim())
    .filter(Boolean);
}

// Keeps the well-formed entries and drops the rest, so one bad entry cannot
// take the others down. Ids must be unique because items are tagged by id.
export function normalizeStorylines(doc) {
  const entries = Array.isArray(doc?.storylines) ? doc.storylines : [];
  const seen = new Set();
  const storylines = [];
  for (const entry of entries) {
    const id = String(entry?.id || "").toLowerCase().trim();
    const name = cleanText(entry?.name || "");
    const match = lowerTerms(entry?.match);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !name || match.length === 0 || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(String(entry.start || ""))
      ? entry.start
      : "";
    storylines.push({
      id,
      name,
      description: cleanText(entry.description || ""),
      match,
      exclude: lowerTerms(entry.exclude),
      start,
    });
  }
  return storylines;
}

function loadStorylines() {
  try {
    const raw = readFileSync(path.resolve(process.cwd(), STORYLINES_PATH), "utf8");
    return normalizeStorylines(JSON.parse(raw));
  } catch {
    return [];
  }
}

let STORYLINES = loadStorylines();

export function getStorylines() {
  return STORYLINES;
}

// A Worker has no filesystem, so it can hand in the same document from its own
// storage. Tests use it to swap definitions.
export function setStorylines(doc) {
  STORYLINES = normalizeStorylines(doc);
  return STORYLINES;
}

function itemHaystack(item) {
  return [item?.title, item?.summary, item?.snippet, item?.description]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function itemDateKey(item) {
  const date = parseDate(item?.pubDate);
  return date ? date.toISOString().slice(0, 10) : "";
}

// Ids of the storylines an item belongs to, in definition order. A story with
// no usable date cannot satisfy a storyline's start date, so it stays out of
// those.
export function storylinesForItem(item, storylines = STORYLINES) {
  const haystack = itemHaystack(item);
  if (!haystack) {
    return [];
  }
  const day = itemDateKey(item);
  return storylines
    .filter(
      (entry) =>
        entry.match.some((term) => haystack.includes(term)) &&
        !entry.exclude.some((term) => haystack.includes(term)) &&
        (!entry.start || (day && day >= entry.start)),
    )
    .map((entry) => entry.id);
}

// Weeks start on Monday, in UTC, and are keyed by that Monday's date.
export function weekStart(date) {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}

function nextWeek(key) {
  const day = new Date(`${key}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 7);
  return day.toISOString().slice(0, 10);
}

// Per-storyline weekly counts and brand sentiment. Weeks run unbroken from the
// first story to the current week, so a quiet week is a zero rather than a gap.
// Sentiment counts only scored brand press coverage, the same set the trends
// page scores. Stories with no date are listed last, counted in `undated`, and
// left out of the weeks. Each storyline also carries its stories, newest first,
// so the page reads one file and its list always agrees with its strip.
export function buildStorylinesSummary(items, now = new Date(), storylines = STORYLINES) {
  const visible = items.filter((item) => item.relevant !== false);
  const currentWeek = weekStart(now);
  return {
    generatedAt: now.toISOString(),
    storylines: storylines.map((entry) => {
      const byWeek = new Map();
      const stories = [];
      let undated = 0;
      let total = 0;
      for (const item of visible) {
        if (!storylinesForItem(item, [entry]).length) {
          continue;
        }
        total += 1;
        const date = parseDate(item.pubDate);
        const scored =
          shouldScoreSentiment(item) && SENTIMENT_VALUES.includes(item.sentiment);
        stories.push({
          title: cleanText(item.title || ""),
          url: item.link || item.url || "",
          date: date ? date.toISOString() : null,
          outlet: item.outlet || itemOutletName(item),
          sentiment: scored ? item.sentiment : undefined,
        });
        if (!date) {
          undated += 1;
          continue;
        }
        const key = weekStart(date);
        const bucket = byWeek.get(key) || { week: key, count: 0, scored: 0, sentiment: {} };
        bucket.count += 1;
        if (scored) {
          bucket.scored += 1;
          bucket.sentiment[item.sentiment] = (bucket.sentiment[item.sentiment] || 0) + 1;
        }
        byWeek.set(key, bucket);
      }
      stories.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
      const weeks = [];
      const keys = [...byWeek.keys()].sort();
      if (keys.length > 0) {
        const last = keys.at(-1) > currentWeek ? keys.at(-1) : currentWeek;
        for (let key = keys[0]; key <= last; key = nextWeek(key)) {
          weeks.push(byWeek.get(key) || { week: key, count: 0, scored: 0, sentiment: {} });
        }
      }
      return {
        id: entry.id,
        name: entry.name,
        description: entry.description,
        total,
        undated,
        weeks,
        stories,
      };
    }),
  };
}

export function resolveStorylinesOutputPath(rssOutputPath) {
  if (process.env.STORYLINES_OUTPUT_PATH) {
    return path.resolve(process.cwd(), process.env.STORYLINES_OUTPUT_PATH);
  }
  return path.join(path.dirname(rssOutputPath), "storylines.json");
}

export async function writeStorylinesSummary(items, outputPath, now = new Date()) {
  const summary = buildStorylinesSummary(items, now);
  await writeText(outputPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
