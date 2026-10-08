// Jev cache keys and the numbers that explain misses (#21).
//
// The cache used to hash the whole request, reference example text included.
// That text is looked up at run time, so a change to one widely retrieved
// example invalidated every story that retrieves it. The key now has two
// parts: the story part (the request without its reference examples, plus the
// rubric and alignment versions) and the reference part (the ids and labels of
// the examples the request carries). A story part is also kept, short, beside
// each cache entry, which is what lets a miss be classified.
import { createHash } from "node:crypto";

const sha = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export const shortKey = (hex) => String(hex).slice(0, 12);

// The story part: everything the request says except the reference examples.
export function jevStoryKey({ alignmentVersion, version, sentimentVersion, request }) {
  const withoutReferences = JSON.stringify(request, (key, value) => (key === "reference_examples" ? undefined : value));
  return sha({ alignmentVersion, version, sentimentVersion, request: withoutReferences });
}

// The reference part: which examples the request carries, in order, with the
// label each list actually shows Jev (include for the inclusion list,
// sentiment for the sentiment list). Ids and labels only. Not their text.
// `trace` is what addEditorialAlignment reports, or empty without references.
export function referenceSignature(trace) {
  if (!trace?.inclusion) return null;
  return {
    inclusion: trace.inclusion.map((row) => [row.id, row.include !== false]),
    sentiment: (trace.sentiment || []).map((row) => [row.id, row.sentiment || null]),
  };
}

export function jevCacheKey(storyKey, signature) {
  return sha({ story: storyKey, references: signature });
}

// Independent sentiment evidence must match every word actually sent, including
// selected reference text. Inclusion-only retrieval changes cannot invalidate it.
export const sentimentRequestHash = request => sha(JSON.stringify({
  state: request.state, model: request.model, questions: { sentiment: request.questions.sentiment },
}));

// The key before #21, for migration only: the whole request hashed with the
// example text in it. An old entry whose legacy key still matches is one no
// reference text has changed under since it was written.
export function legacyJevCacheKey({ alignmentVersion, version, sentimentVersion, request }) {
  return sha({ alignmentVersion, version, sentimentVersion, request });
}

// The story keys of the last run's candidates. Only their short form is kept,
// so a miss can be told apart from a story the run has never seen.
const MAX_STORY_KEYS = 20000;
export function normalizeJevStoryKeys(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((key) => typeof key === "string" && /^[a-f0-9]{12}$/.test(key)))].slice(0, MAX_STORY_KEYS);
}

// Why an entry missed. `answered` holds the story keys of the cache entries the
// run started with, `seen` those of the last run's candidates.
//   referenceChanged: this story part was answered before, under a request
//     with different references. The churn the id key removes.
//   unanswered: this story part was a candidate last run but never answered.
//     Backlog, not invalidation.
//   storyChanged: the story part is new or changed since the last run.
//   unclassified: the run started with entries that carry no story key, so a
//     stale answer for this story cannot be ruled out.
export function classifyMiss(storyShort, { answered, seen, unclassified }) {
  if (unclassified) return "unclassified";
  if (answered.has(storyShort)) return "referenceChanged";
  if (seen.has(storyShort)) return "unanswered";
  return "storyChanged";
}

// Short hashes of the reference library, so two runs' audits can be compared:
// ids and labels, the text as looked up this run, and the text after freezing.
// The live and frozen text hashes differ exactly when the archive copies moved.
export function referenceLibraryHashes(liveExamples, frozenExamples) {
  const lines = (rows, text) => rows.map((row) => [row.id, row.include !== false, row.sentiment || "", ...(text ? [row.title, row.outlet, row.excerpt, row.context] : [])].join("|")).sort().join("\n");
  return {
    referenceCount: liveExamples.length,
    referenceIdHash: shortKey(sha(`${liveExamples.length}\n${lines(liveExamples, false)}`)),
    referenceLiveTextHash: shortKey(sha(`${liveExamples.length}\n${lines(liveExamples, true)}`)),
    referenceFrozenTextHash: shortKey(sha(`${frozenExamples.length}\n${lines(frozenExamples, true)}`)),
  };
}
