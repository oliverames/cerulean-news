// Groups different outlets' reports of one news event so the reader and RSS
// show the story once, with every outlet listed beneath it. Grouping is a
// presentation layer: each article stays a separate item in the JSON Feed and
// audit archive, so coverage spread, sentiment, and trend counts are intact.
//
// Blue Cross VT brand coverage is never grouped. The team tracks each brand
// clip separately, with its own sentiment, so those stay one entry apiece.
import { cleanText, parseDate } from "./utils.js";

// Two reports of one event usually publish within a day or two of each other.
const GROUP_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
// Weighted cosine similarity over title and summary terms. The thresholds
// were set by reviewing all 162 groups they produce on the live feed of
// 2026-09-23. Reworded same-event reports mostly score 0.45 or higher, and
// the shared-figure rule below catches the rest.
const SIMILARITY_THRESHOLD = 0.45;
// A title-only match needs a rarer shared detail, so it has its own floor.
const TITLE_SIMILARITY_THRESHOLD = 0.5;
// Two reports quoting the same specific figure need less wording in common,
// but their headlines must still overlap: "200 jobs" alone tied a Dartmouth
// layoff story to UVM Health coverage.
const SHARED_FIGURE_THRESHOLD = 0.25;
const SHARED_FIGURE_TITLE_THRESHOLD = 0.2;
const NEAR_IDENTICAL_TITLE_THRESHOLD = 0.8;
const OPINION_PATTERN = /\b(letter to the editor|letters?:|commentary|opinion|op-ed|editorial|column|endors(e|es|ing)|headlines:)/i;

const STOPWORDS = new Set(
  (
    "a about after again against all also am an and any are as at be because been before being " +
    "between both but by can could did do does doing down during each few for from further had " +
    "has have having he her here hers him his how i if in into is it its just may me more most " +
    "much must my new no nor not now of off on once only or other our out over own per said same " +
    "says she should so some such than that the their them then there these they this those " +
    "through to too under until up us very was we were what when where which while who whom why " +
    "will with would you your amid plans plan set sets expected report reports reportedly according " +
    "announce announces announced latest week today year years news"
  ).split(" "),
);

const PHRASES = [
  [/\baffordable care act\b/g, " aca "],
  [/\bobamacare\b/g, " aca "],
  [/\bhealthcare\.gov\b/g, " aca "],
  [/\bcenters for medicare (?:and|&) medicaid services\b/g, " cms "],
  [/\bhealth and human services\b/g, " hhs "],
  [/\bblue cross (?:and|&) blue shield\b/g, " bcbs "],
  [/\bu\.s\.(?=\s|$)/g, " us "],
];

// "760,000", "760K", and "760 thousand" name the same figure.
function normalizeNumbers(text) {
  return text
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/\b(\d+(?:\.\d+)?)\s*(k|thousand)\b/g, (_, n) => String(Math.round(Number(n) * 1e3)))
    .replace(/\b(\d+(?:\.\d+)?)\s*(m|million)\b/g, (_, n) => String(Math.round(Number(n) * 1e6)))
    .replace(/\b(\d+(?:\.\d+)?)\s*(b|billion)\b/g, (_, n) => String(Math.round(Number(n) * 1e9)));
}

// Crude suffix folding so "enrolled", "enrollees", and "enrollment" meet.
function stem(word) {
  if (/^\d/.test(word) || word.length <= 4) return word;
  return word
    .replace(/(ments?|ees?|ing|ed|ers?|ies|es|s)$/, "")
    .replace(/(.)\1$/, "$1");
}

export function storyTerms(text) {
  let value = ` ${cleanText(text || "").toLowerCase()} `;
  for (const [pattern, replacement] of PHRASES) value = value.replace(pattern, replacement);
  value = normalizeNumbers(value).replace(/[’']s\b/g, "").replace(/[^a-z0-9]+/g, " ");
  return value
    .split(" ")
    .filter((word) => word.length > 1 && !STOPWORDS.has(word))
    .map(stem)
    .filter((word) => word.length > 1);
}

// Google News titles end in " - Outlet"; the suffix is not part of the story.
function storyTitle(item) {
  return cleanText(item.title || "").replace(/\s+-\s+[^-]{2,80}$/, "");
}

function vectorize(terms, idf) {
  const weights = new Map();
  for (const term of terms) weights.set(term, (weights.get(term) || 0) + 1);
  let norm = 0;
  for (const [term, count] of weights) {
    const weight = (1 + Math.log(count)) * (idf.get(term) || 0);
    weights.set(term, weight);
    norm += weight * weight;
  }
  return { weights, norm: Math.sqrt(norm) };
}

function cosine(a, b) {
  if (!a.norm || !b.norm) return 0;
  const [small, large] = a.weights.size <= b.weights.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, weight] of small.weights) dot += weight * (large.weights.get(term) || 0);
  return dot / (a.norm * b.norm);
}

// Tracker clips group like crawled stories: brand clips are excluded by
// category, and a Vermont clip-email row should join the crawled copy of
// the same story rather than sit beside it as a duplicate.
export function isGroupableStory(item, category) {
  return category !== "Blue Cross VT" &&
    item.sourceType !== "BlueCrossVT.org" && item.sourceType !== "Social";
}

// Returns a Map from each grouped item to its group: { id, lead, members },
// with members newest first. Items that match nothing are absent. `category`
// resolves an item's reader section, since groups never cross sections;
// `outlet` resolves its publisher.
export function groupRelatedStories(items, {
  category = (item) => item.category,
  outlet = (item) => item.outlet || item.sourceName,
} = {}) {
  const candidates = items
    .map((item) => ({ item, category: category(item), time: parseDate(item.pubDate)?.valueOf() }))
    .filter(({ item, category: section, time }) => Number.isFinite(time) && isGroupableStory(item, section));
  if (candidates.length < 2) return new Map();

  for (const candidate of candidates) {
    candidate.titleTerms = storyTerms(storyTitle(candidate.item));
    candidate.bodyTerms = storyTerms(
      [candidate.item.summary, cleanText(candidate.item.snippet || "").slice(0, 400)].filter(Boolean).join(" "),
    );
  }
  const documentFrequency = new Map();
  for (const { titleTerms, bodyTerms } of candidates) {
    for (const term of new Set([...titleTerms, ...bodyTerms])) {
      documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
    }
  }
  const idf = new Map(
    [...documentFrequency].map(([term, count]) => [term, Math.log((candidates.length + 1) / (count + 1)) + 1]),
  );
  for (const candidate of candidates) {
    // The headline carries the event; the summary adds shared specifics.
    candidate.full = vectorize([...candidate.titleTerms, ...candidate.titleTerms, ...candidate.bodyTerms], idf);
    candidate.title = vectorize(candidate.titleTerms, idf);
    // Roundups ("VT Headlines:") summarize several stories, so they are
    // treated like opinion pieces and match only a copy of themselves.
    candidate.opinion = OPINION_PATTERN.test(candidate.item.title || "");
    candidate.outlet = cleanText(outlet(candidate.item) || "").toLowerCase();
    // Specific figures ("760,000", "199 jobs") identify an event across very
    // different headlines. Four-digit years are too common to count.
    candidate.figures = new Set(
      [...candidate.titleTerms, ...candidate.bodyTerms].filter((term) => /^\d{3,}$/.test(term) && !/^(19|20)\d\d$/.test(term)),
    );
  }

  candidates.sort((a, b) => a.time - b.time);
  const matches = (a, b) => {
    const full = cosine(a.full, b.full);
    const title = cosine(a.title, b.title);
    // One outlet runs a series under near-identical headlines (candidate
    // forums, weekly briefs), so its own items need a near-exact headline.
    if (a.outlet && a.outlet === b.outlet) return title >= NEAR_IDENTICAL_TITLE_THRESHOLD;
    // Letters and columns on one topic are different pieces by different
    // writers; only a syndicated copy of the same piece belongs together.
    if (a.opinion || b.opinion) return title >= NEAR_IDENTICAL_TITLE_THRESHOLD;
    const sharesFigure = [...a.figures].some((figure) => b.figures.has(figure));
    return full >= SIMILARITY_THRESHOLD || title >= TITLE_SIMILARITY_THRESHOLD ||
      (sharesFigure && full >= SHARED_FIGURE_THRESHOLD && title >= SHARED_FIGURE_TITLE_THRESHOLD);
  };
  const linked = candidates.map(() => new Set());
  for (let i = 0; i < candidates.length; i += 1) {
    for (let j = i + 1; j < candidates.length && candidates[j].time - candidates[i].time <= GROUP_WINDOW_MS; j += 1) {
      if (candidates[i].category === candidates[j].category && matches(candidates[i], candidates[j])) {
        linked[i].add(j);
        linked[j].add(i);
      }
    }
  }

  // Average linkage over those matches: two groups merge only when more than
  // half of the article pairs between them match, best-supported merge first.
  // Chaining through single matches joined a layoff announcement, a union
  // protest, and a weekly news review into one entry.
  const clusterOf = candidates.map((_, index) => index);
  const clusters = new Map(candidates.map((_, index) => [index, [index]]));
  const share = (left, right) => {
    let count = 0;
    for (const member of left) for (const other of right) if (linked[member].has(other)) count += 1;
    return count / (left.length * right.length);
  };
  for (;;) {
    let best = null;
    const compared = new Set();
    linked.forEach((neighbors, index) => {
      for (const neighbor of neighbors) {
        const left = clusterOf[index];
        const right = clusterOf[neighbor];
        const key = left < right ? `${left}|${right}` : `${right}|${left}`;
        if (left === right || compared.has(key)) continue;
        compared.add(key);
        const value = share(clusters.get(left), clusters.get(right));
        if (value > 0.5 && (!best || value > best.value)) best = { left, right, value };
      }
    });
    if (!best) break;
    const merged = [...clusters.get(best.left), ...clusters.get(best.right)];
    clusters.delete(best.right);
    clusters.set(best.left, merged);
    for (const index of merged) clusterOf[index] = best.left;
  }

  const groups = new Map();
  for (const indexes of clusters.values()) {
    if (indexes.length < 2) continue;
    const members = indexes.map((index) => candidates[index].item);
    members.sort((a, b) => parseDate(b.pubDate) - parseDate(a.pubDate));
    // The newest report leads: it is usually the most complete account and it
    // keeps the story at the position a reader expects from its latest date.
    const lead = members[0];
    const group = { id: lead.guid || lead.link, lead, members };
    for (const member of members) groups.set(member, group);
  }
  return groups;
}
