// Private, human-labeled reference material. The seed is materialized by Actions
// from its existing secret; examples never enter public feed fields or Git.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cleanText } from "./utils.js";
import { normalizeSentiment, SENTIMENT_VALUES } from "./summaries.js";

export function exampleUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || /^(fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}${url.search}`;
  } catch { return String(value || "").trim().toLowerCase(); }
}
export function exampleTitle(value) {
  return cleanText(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
export function exampleId(value) {
  return createHash("sha256").update(exampleUrl(value)).digest("hex");
}
function terms(value) {
  return new Set(exampleTitle(value).split(" ").filter((word) => word.length > 3 &&
    !new Set(["with", "from", "that", "this", "have", "will", "about", "into", "their", "more", "news", "says"]).has(word)));
}
function overlap(left, right) {
  const shared = [...left].filter((term) => right.has(term)).length;
  return shared / Math.max(1, Math.min(left.size, right.size));
}
export function sameExampleStory(left, right) {
  if (exampleUrl(left.url || left.link) && exampleUrl(left.url || left.link) === exampleUrl(right.url || right.link)) return true;
  const a = exampleTitle(left.title), b = exampleTitle(right.title);
  if (a && a === b) return true;
  const at = terms(a), bt = terms(b);
  return Math.min(at.size, bt.size) >= 5 && overlap(at, bt) >= 0.85;
}

export function buildReferenceExamples(seed, items = [], { conflictIds = [], excludedIds = [], storyGroupById = {} } = {}) {
  const byUrl = new Map(items.map((item) => [exampleUrl(item.link || item.url), item]));
  const conflicts = new Set(conflictIds), excluded = new Set(excludedIds);
  const rows = Array.isArray(seed?.articles) ? seed.articles : [];
  const labelsById = new Map();
  for (const row of rows) {
    const id = exampleId(row.url), label = normalizeSentiment(row.trackerSentiment);
    if (!label) continue;
    if (!labelsById.has(id)) labelsById.set(id, new Set());
    labelsById.get(id).add(label);
    if (labelsById.get(id).size > 1) conflicts.add(id);
  }
  const seen = new Set();
  return rows.flatMap((row) => {
    const url = cleanText(row.url || ""), id = exampleId(url);
    if (!/^https?:\/\//i.test(url) || !cleanText(row.title || "") || seen.has(id) || excluded.has(id)) return [];
    seen.add(id);
    const archived = byUrl.get(exampleUrl(url));
    // Seed topic is human-supplied context. Never take an archive's generated
    // sentiment, inclusion verdict, or rationale as a training label.
    const excerpt = cleanText(archived?.snippet || archived?.description || "").slice(0, 700);
    const sentiment = conflicts.has(id) ? "" : normalizeSentiment(row.trackerSentiment);
    return [{ id, url, title: cleanText(row.title).slice(0, 300),
      outlet: cleanText(row.outlet || archived?.sourceName || "").slice(0, 160),
      excerpt, context: cleanText(row.topic || "").slice(0, 600),
      include: true, sentiment: SENTIMENT_VALUES.includes(sentiment) ? sentiment : null,
      storyGroup: storyGroupById[id] || null, provenance: "human media tracker", sentimentConflict: conflicts.has(id) }];
  });
}

export async function loadReferenceExamples(items, { env = process.env, config = {} } = {}) {
  const filename = env.JEV_EXAMPLES_PATH || "data/media-tracker-seed.json";
  try {
    const seed = JSON.parse(await readFile(filename, "utf8"));
    const examples = buildReferenceExamples(seed, items, config);
    return { status: examples.length ? "loaded" : "empty", examples };
  } catch (error) {
    return { status: error.code === "ENOENT" ? "missing" : "invalid", examples: [] };
  }
}

export function selectReferenceExamples(item, examples, { task, limit = 16, storyGroupById = {} } = {}) {
  if (!Number.isInteger(limit) || limit < 0 || limit > 200) throw new Error("Example limit must be 0–200");
  const query = terms([item.title, item.snippet, item.description].filter(Boolean).join(" "));
  const targetGroup = storyGroupById[exampleId(item.link || item.url)];
  const eligible = examples.filter((example) => !(targetGroup && targetGroup === example.storyGroup) && !sameExampleStory(item, example) &&
    (task !== "sentiment" || SENTIMENT_VALUES.includes(example.sentiment)));
  const ranked = eligible.map((example) => ({ example, score: overlap(query, terms(`${example.title} ${example.context} ${example.excerpt}`)) }))
    .sort((left, right) => right.score - left.score || left.example.id.localeCompare(right.example.id));
  const chosen = [];
  // Keep at least one observed example per label when available, then retrieve
  // relevant cases. Retrieval chooses context; Jev makes the editorial decision.
  if (task === "sentiment") for (const label of SENTIMENT_VALUES) {
    const entry = ranked.find(({ example }) => example.sentiment === label);
    if (entry && chosen.length < limit && !chosen.some((existing) => sameExampleStory(existing, entry.example))) chosen.push(entry.example);
  }
  for (const { example } of ranked) {
    if (chosen.length >= limit) break;
    if (!chosen.includes(example) && !chosen.some((existing) => sameExampleStory(existing, example))) chosen.push(example);
  }
  return chosen.map((example) => ({
    article: { title: example.title, outlet: example.outlet, excerpt: example.excerpt, editorialContext: example.context },
    expected: task === "sentiment" ? { sentiment: example.sentiment } : { include: example.include },
    provenance: example.provenance,
  }));
}
