// Team feedback. The mail Worker (mail/) keeps the votes of signed-in team
// members. Each run fetches the current votes with a bearer token and applies
// them before Jev, so a vote takes effect on the next run and an undone vote
// stops taking effect on the one after it.
//
// The three votes, in the pipeline's terms:
//   drop       the item is excluded like a human rejection, and Jev skips it
//   keep       the item stays even if a model would drop it (deterministic
//              rules such as obituaries and job boards still win)
//   sentiment  the corrected label replaces the published one
// Each also becomes a Jev reference example, alongside the editorial profile's
// rejectedIds and the media-tracker seed.
//
// What an item looked like before a vote touched it is kept in
// crawlState.feedback, so undoing a vote restores it. A failed fetch changes
// nothing: the last applied votes are re-asserted and nothing is reverted.
import { exampleId } from "./jev-examples.js";
import { isObituaryItem } from "./filters.js";
import { applyDeterministicRelevance, itemOutletName } from "./relevance.js";
import { SENTIMENT_VALUES, shouldScoreSentiment } from "./summaries.js";
import { cleanText } from "./utils.js";

export const FEEDBACK_DROP_REASON = "Excluded by team feedback.";
export const FEEDBACK_KEEP_REASON = "Kept by team feedback.";
export const FEEDBACK_SENTIMENT_REASON = "Corrected by team feedback.";

const VOTE_KINDS = new Set(["keep", "drop", "sentiment"]);
const ITEM_ID = /^[0-9a-f]{64}$/;
const MAX_VOTES = 20000;
const MAX_RESPONSE_CHARS = 8 * 1024 * 1024;
const MAX_STATE_ENTRIES = 5000;

// ------------------------------------------------------------------- fetch

// Never throws. status is "unconfigured" when either variable is unset (the
// feature is off), "ok" with the parsed votes, or "failed" with the reason.
// Failure is logged and the run carries on with no feedback.
export async function fetchTeamFeedback({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const url = String(env.FEEDBACK_EXPORT_URL || "").trim();
  const token = String(env.FEEDBACK_EXPORT_TOKEN || "").trim();
  if (!url || !token) {
    return { status: "unconfigured", votes: [], invalid: 0 };
  }
  try {
    const target = new URL(url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname);
    if (target.protocol !== "https:" && !(local && target.protocol === "http:")) {
      throw new Error("the export URL must be https");
    }
    const response = await fetchImpl(target, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": "cerulean-news-feedback/1" },
      // The token goes to the configured host only, never along a redirect.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new Error("response too large");
    }
    const parsed = parseFeedbackExport(JSON.parse(text));
    console.log(`Team feedback: ${parsed.votes.length} votes fetched${parsed.invalid ? `, ${parsed.invalid} malformed ignored` : ""}.`);
    return { status: "ok", ...parsed };
  } catch (error) {
    // The message never includes the token: it is only ever sent in a header.
    const reason = cleanText(String(error?.message || error)).slice(0, 160);
    console.warn(`Team feedback unavailable (${reason}); continuing with no new feedback.`);
    return { status: "failed", votes: [], invalid: 0, error: reason };
  }
}

// { ok: true, votes: [{ item, vote, label, updatedAt }] } from the Worker. A
// row that does not validate is dropped and counted, never guessed at.
export function parseFeedbackExport(body) {
  if (!body || typeof body !== "object" || body.ok !== true || !Array.isArray(body.votes)) {
    throw new Error("unexpected response shape");
  }
  const votes = [];
  let invalid = 0;
  for (const row of body.votes.slice(0, MAX_VOTES)) {
    const at = Date.parse(row?.updatedAt);
    const valid = row && typeof row.item === "string" && ITEM_ID.test(row.item) && VOTE_KINDS.has(row.vote) &&
      Number.isFinite(at) &&
      (row.vote === "sentiment" ? SENTIMENT_VALUES.includes(row.label) : row.label === null || row.label === undefined);
    if (valid) votes.push({ item: row.item, vote: row.vote, label: row.vote === "sentiment" ? row.label : null, at });
    else invalid += 1;
  }
  return { votes, invalid: invalid + Math.max(0, body.votes.length - MAX_VOTES) };
}

// ----------------------------------------------------------------- resolve

// Several people may vote on one story. Inclusion (keep or drop) and
// sentiment are separate questions, and on each the most recent vote wins.
// On an exact tie a keep beats a drop, so a tie never hides coverage.
export function resolveVotes(votes) {
  const resolved = new Map();
  for (const { item, vote, label, at } of votes) {
    const entry = resolved.get(item) || {};
    if (vote === "sentiment") {
      const current = entry.sentiment;
      if (!current || at > current.at || (at === current.at && label < current.label)) entry.sentiment = { label, at };
    } else {
      const current = entry.inclusion;
      if (!current || at > current.at || (at === current.at && vote === "keep" && current.vote === "drop")) {
        entry.inclusion = { vote, at };
      }
    }
    resolved.set(item, entry);
  }
  return resolved;
}

// ------------------------------------------------------------------- state

// crawlState.feedback: { applied: { [itemId]: { inclusion?, sentiment? } } }.
// It holds what each applied vote replaced, so an undo can put it back. It is
// part of the audit file, so it carries story hashes and label names only.
export function normalizeFeedbackState(value) {
  const applied = {};
  const source = value?.applied && typeof value.applied === "object" ? value.applied : {};
  for (const [id, entry] of Object.entries(source).slice(0, MAX_STATE_ENTRIES)) {
    if (!ITEM_ID.test(id) || !entry || typeof entry !== "object") continue;
    const clean = {};
    const inclusion = entry.inclusion;
    if ((inclusion?.vote === "keep" || inclusion?.vote === "drop") && inclusion.baseline && typeof inclusion.baseline === "object") {
      clean.inclusion = { vote: inclusion.vote, baseline: {
        relevant: typeof inclusion.baseline.relevant === "boolean" ? inclusion.baseline.relevant : null,
        reason: cleanText(String(inclusion.baseline.reason || "")).slice(0, 500) } };
    }
    const sentiment = entry.sentiment;
    if (SENTIMENT_VALUES.includes(sentiment?.label) && sentiment.baseline && typeof sentiment.baseline === "object") {
      const base = sentiment.baseline;
      clean.sentiment = { label: sentiment.label, baseline: {
        sentiment: SENTIMENT_VALUES.includes(base.sentiment) ? base.sentiment : null,
        sentimentReason: cleanText(String(base.sentimentReason || "")).slice(0, 500),
        sentimentScore: Number.isFinite(base.sentimentScore) ? base.sentimentScore : null,
        sentimentRubric: typeof base.sentimentRubric === "string" ? base.sentimentRubric.slice(0, 80) : null } };
    }
    if (clean.inclusion || clean.sentiment) applied[id] = clean;
  }
  return { applied };
}

// The votes the state says are in force, as fetchTeamFeedback would report
// them. Used when the fetch fails, so a network blip re-asserts what is
// already applied and never reverts it.
function votesFromState(state) {
  const votes = [];
  for (const [item, entry] of Object.entries(state.applied)) {
    if (entry.inclusion) votes.push({ item, vote: entry.inclusion.vote, label: null, at: 0 });
    if (entry.sentiment) votes.push({ item, vote: "sentiment", label: entry.sentiment.label, at: 0 });
  }
  return votes;
}

function restoreInclusion(item, baseline) {
  const restored = { ...item };
  if (baseline.relevant === null) delete restored.relevant;
  else restored.relevant = baseline.relevant;
  restored.reason = baseline.reason;
  delete restored.humanRejected;
  delete restored.feedbackKept;
  return restored;
}

function restoreSentiment(item, baseline) {
  const restored = { ...item };
  for (const field of ["sentiment", "sentimentReason", "sentimentScore", "sentimentRubric"]) {
    if (baseline[field] === null || baseline[field] === "") delete restored[field];
    else restored[field] = baseline[field];
  }
  delete restored.feedbackSentiment;
  return restored;
}

const isRuleRejected = (item) => isObituaryItem(item) || applyDeterministicRelevance({ ...item, relevant: undefined }).relevant === false;

// ------------------------------------------------------------------- apply

// Applies the current votes to the run's items and returns
// { items, examples, summary }. `items` are new objects for the ones a vote
// changed, and `examples` are Jev references for every vote in force. With
// feedback unconfigured the items come back untouched. A tracker clip keeps
// its inclusion, the way it does against editorial rejections, and an
// editorial rejection applied after this still outranks a keep.
export function applyTeamFeedback(items, feedback, state) {
  const summary = { status: feedback?.status || "unconfigured", votes: feedback?.votes?.length || 0, malformed: feedback?.invalid || 0,
    drop: 0, keep: 0, sentiment: 0, applied: 0, reverted: 0, unmatched: 0, ignoredTracker: 0, blockedByRule: 0, ineligibleSentiment: 0 };
  if (!Array.isArray(items) || !feedback || feedback.status === "unconfigured") return { items, examples: [], summary };

  const store = state && typeof state === "object" ? state : {};
  const current = normalizeFeedbackState(store);
  const active = resolveVotes(feedback.status === "ok" ? feedback.votes : votesFromState(current));
  const next = {};
  const examples = [];
  const seenIds = new Set();

  const result = items.map((original) => {
    const id = exampleId(original?.link || original?.url || "");
    const want = active.get(id);
    const have = current.applied[id];
    if (!want && !have) return original;
    seenIds.add(id);
    let item = original;
    const record = {};

    // Inclusion: revert what a changed or removed vote did, then apply.
    if (have?.inclusion && have.inclusion.vote !== want?.inclusion?.vote) {
      item = restoreInclusion(item, have.inclusion.baseline);
      summary.reverted += 1;
    } else if (have?.inclusion) record.inclusion = have.inclusion;
    if (want?.inclusion) {
      const vote = want.inclusion.vote;
      if (item.fromMediaTracker) summary.ignoredTracker += 1;
      else if (vote === "keep" && isRuleRejected(item)) summary.blockedByRule += 1;
      else {
        const baseline = record.inclusion?.baseline || { relevant: typeof item.relevant === "boolean" ? item.relevant : null, reason: item.reason || "" };
        item = vote === "drop"
          ? { ...item, relevant: false, reason: FEEDBACK_DROP_REASON, humanRejected: true }
          : { ...item, relevant: true, reason: item.relevant === false ? FEEDBACK_KEEP_REASON : item.reason, feedbackKept: true };
        if (!record.inclusion) summary.applied += 1;
        record.inclusion = { vote, baseline };
        summary[vote] += 1;
        examples.push(referenceFor(item, id, { include: vote === "keep", sentiment: null }));
      }
    }

    // Sentiment: the same, on the label.
    if (have?.sentiment && have.sentiment.label !== want?.sentiment?.label) {
      item = restoreSentiment(item, have.sentiment.baseline);
      summary.reverted += 1;
    } else if (have?.sentiment) record.sentiment = have.sentiment;
    if (want?.sentiment) {
      const label = want.sentiment.label;
      if (!shouldScoreSentiment(item)) summary.ineligibleSentiment += 1;
      else {
        const baseline = record.sentiment?.baseline || { sentiment: item.sentiment || null, sentimentReason: item.sentimentReason || "",
          sentimentScore: Number.isFinite(item.sentimentScore) ? item.sentimentScore : null, sentimentRubric: item.sentimentRubric || null };
        item = { ...item, sentiment: label, sentimentReason: FEEDBACK_SENTIMENT_REASON, feedbackSentiment: true };
        // Jev's 0-100 score belongs to Jev's label, not the team's.
        delete item.sentimentScore;
        if (!record.sentiment) summary.applied += 1;
        record.sentiment = { label, baseline };
        summary.sentiment += 1;
        if (!examples.some((example) => example.id === id)) examples.push(referenceFor(item, id, { include: true, sentiment: label }));
        else examples.find((example) => example.id === id).sentiment = label;
      }
    }

    if (record.inclusion || record.sentiment) next[id] = record;
    return item;
  });

  summary.unmatched = [...active.keys()].filter((id) => !seenIds.has(id)).length;
  // Entries for stories that left the archive are dropped with the story.
  store.applied = next;
  return { items: result, examples, summary };
}

// Jev reference material built from a vote. The text comes from the archive
// copy, so nothing about the voter is involved.
function referenceFor(item, id, { include, sentiment }) {
  return {
    id,
    url: cleanText(item.link || item.url || ""),
    title: cleanText(item.title || "").slice(0, 300),
    outlet: cleanText(itemOutletName(item)).slice(0, 160),
    excerpt: cleanText(item.snippet || item.description || "").slice(0, 700),
    context: "",
    include,
    sentiment,
    storyGroup: null,
    provenance: "team feedback",
    sentimentConflict: false,
  };
}

// Team examples join the library. A drop replaces any example of the same
// story, since it contradicts an inclusion label. A keep or a correction
// refines the existing one and keeps its editorial context.
export function mergeFeedbackExamples(examples, feedbackExamples) {
  const usable = (feedbackExamples || []).filter((example) => /^https?:\/\//i.test(example.url) && example.title);
  if (!usable.length) return examples;
  const byId = new Map(usable.map((example) => [example.id, example]));
  const merged = examples.map((existing) => {
    const team = byId.get(existing.id);
    if (!team) return existing;
    byId.delete(existing.id);
    if (team.include === false) return team;
    return { ...existing, include: true, sentiment: team.sentiment || existing.sentiment,
      sentimentConflict: team.sentiment ? false : existing.sentimentConflict,
      provenance: `${existing.provenance} + team feedback` };
  });
  return [...merged, ...byId.values()];
}
