// Article-body matches for the indefinite-retention topic labels (MVP Health
// Care and UVM Health), so share of voice counts a rate-review story that
// names MVP only in its body.
//
// A body match annotates an item that is already kept. It is never evidence
// for keeping one. Enrichment adds the label to `matchedTerms` only after the
// keep-or-drop decision, and records it in `bodyOnlyTerms` so every later
// reader of `matchedTerms` that decides inclusion can set it aside. The
// article body is not kept, so `bodyOnlyTerms` is carried through the article
// cache and the audit JSON, as `bodyQuotedSpokespeople` is (src/quotes.js).
import {
  canonicalizeMatchedTerms,
  findMentionTerms,
  INDEFINITE_RETENTION_LABELS,
  TOPIC_TERMS,
} from "./matching.js";

const LABEL_TERMS = TOPIC_TERMS.filter((term) =>
  INDEFINITE_RETENTION_LABELS.includes(term.label),
);

// The retention labels named in an article body.
export function findBodyLabels(text) {
  return text ? findMentionTerms(text, LABEL_TERMS) : [];
}

// Labels that came from the body alone, dropping any that a feed-text or
// fallback match already supplies. `supportedTerms` are the terms that stand
// on their own.
export function reconcileBodyOnly(bodyLabels, supportedTerms = []) {
  const supported = new Set(canonicalizeMatchedTerms(supportedTerms));
  return canonicalizeMatchedTerms(bodyLabels || []).filter(
    (label) => !supported.has(label),
  );
}

// Spread target, like bodyQuoteField: empty results add no key, so a merge
// cannot overwrite a stored list with undefined.
export function bodyOnlyField(labels) {
  const list = Array.isArray(labels)
    ? labels.filter((label) => typeof label === "string" && label)
    : [];
  return list.length > 0 ? { bodyOnlyTerms: list } : {};
}

// matchedTerms without the body-only labels. Everything that decides
// inclusion, retention, or what Jev and Gemini see reads this, so a body
// mention changes none of them. Returns the input array itself when there is
// nothing to remove, which keeps Jev request hashes unchanged.
export function withoutBodyOnly(item) {
  const terms = Array.isArray(item?.matchedTerms) ? item.matchedTerms : [];
  const bodyOnly = Array.isArray(item?.bodyOnlyTerms) ? item.bodyOnlyTerms : [];
  if (bodyOnly.length === 0) {
    return terms;
  }
  const skip = new Set(bodyOnly);
  return terms.filter((term) => !skip.has(term));
}

// Two copies of one story: a label stays body-only only when neither copy
// supports it from feed text.
export function mergeBodyOnly(primary, fallback) {
  const supported = [primary, fallback].flatMap((copy) =>
    canonicalizeMatchedTerms(withoutBodyOnly(copy)),
  );
  return reconcileBodyOnly(
    [...(primary?.bodyOnlyTerms || []), ...(fallback?.bodyOnlyTerms || [])],
    supported,
  );
}
