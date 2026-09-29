// Frozen reference text (#21). A reference example's excerpt and outlet are
// looked up from the archive copy of its URL on every run, so any change to
// that copy (a re-scrape, a backfill that adds the first copy, a story that
// leaves the archive) changes the words Jev sees. The first non-empty value
// seen for each example is kept in crawlState.jevExamples and reused, so the
// same example sends the same text run after run.
import { cleanText } from "./utils.js";

// Far above the library (about 1,600 examples), so it only guards a runaway.
const MAX_FROZEN_EXAMPLES = 5000;
const TEXT_LIMITS = { excerpt: 700, outlet: 160, title: 300 };
// Examples whose headline also comes from the archive copy. A seed row's
// headline is human-supplied and already stable, so it is never frozen.
const ARCHIVE_TITLE_PROVENANCE = new Set(["human label review", "team feedback"]);

// Same shape as the other crawlState maps: bounded, string-only, and dropped
// entry by entry when malformed.
export function normalizeJevExampleState(value) {
  const state = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return state;
  for (const [id, entry] of Object.entries(value)) {
    if (Object.keys(state).length >= MAX_FROZEN_EXAMPLES) break;
    if (!/^[a-f0-9]{64}$/.test(id) || !entry || typeof entry !== "object") continue;
    const frozen = {};
    for (const [field, limit] of Object.entries(TEXT_LIMITS)) {
      const text = typeof entry[field] === "string" ? cleanText(entry[field]).slice(0, limit) : "";
      if (text) frozen[field] = text;
    }
    if (Object.keys(frozen).length) state[id] = frozen;
  }
  return state;
}

// Returns the library with frozen text applied, and updates `state` in place.
// A field is set once, the first time it is non-empty, and never overwritten.
// An example whose archive copy has gone blank keeps its frozen text.
// `changed` counts examples whose live text differs from the frozen text, and
// `lost` those whose live text went blank, which is the churn this absorbs.
export function freezeReferenceText(examples, state = {}) {
  const result = { examples, added: 0, changed: 0, lost: 0 };
  const frozen = examples.map((example) => {
    if (!/^[a-f0-9]{64}$/.test(example?.id || "")) return example;
    const fields = ARCHIVE_TITLE_PROVENANCE.has(example.provenance) ? ["excerpt", "outlet", "title"] : ["excerpt", "outlet"];
    let entry = state[example.id], next = example, added = false, changed = false, lost = false;
    for (const field of fields) {
      const live = cleanText(example[field] || "").slice(0, TEXT_LIMITS[field]);
      const kept = entry?.[field] || "";
      if (kept) {
        if (!live) lost = true;
        else if (live !== kept) changed = true;
        if (kept !== example[field]) next = next === example ? { ...example, [field]: kept } : { ...next, [field]: kept };
      } else if (live && (entry || Object.keys(state).length < MAX_FROZEN_EXAMPLES)) {
        entry = state[example.id] = { ...entry, [field]: live };
        added = true;
      }
    }
    result.added += added ? 1 : 0;
    result.changed += changed ? 1 : 0;
    result.lost += lost ? 1 : 0;
    return next;
  });
  result.examples = frozen;
  return result;
}
