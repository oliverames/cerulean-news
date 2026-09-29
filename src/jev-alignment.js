// Supported request-level adaptation, not customer-specific model weights.
import { readFile } from "node:fs/promises";
import { chooseReferenceExamples, exampleId, referenceExampleView } from "./jev-examples.js";
import { INCLUSION_PRIORITIES, INCLUSION_RULES } from "./summaries.js";

export const ALIGNMENT_VERSION = "editorial-examples-v2";

const SCOPE_QUESTIONS = {
  scope_brand: {
    type: "noul",
    instructions: "Does this article cover Blue Cross and Blue Shield of Vermont, a Blue Cross plan, or its ordinary community/sponsorship presence? Evaluate article evidence only. eligibleBcbsVtSentiment=true is trusted prior identification of BCBSVT coverage even if the short saved excerpt omits the name. An article about insurance generally without a Blue Cross connection is not a brand mention.",
    criteria: { true: "Identifies Blue Cross/BCBS coverage or presence, including ordinary favorable participation and passing relevant mentions.", false: "No identified Blue Cross connection." },
  },
  scope_regional: {
    type: "noul",
    instructions: "Is the article substantively about health care in Vermont or New England, or a nearby provider serving Vermont such as CVPH? Include small local provider operations, access, budgets, leadership, public health, mental-health awareness, and community health events. A local publisher can identify local institutions but does not make a syndicated foreign/national story local. Incidental treatment in a crash/crime brief is not health-care reporting. Health news from another state outside New England is not regional, and company, vendor, or law-firm promotions from outside New England do not qualify. Apply the supplied priorities and rules.",
    criteria: { true: "Substantive Vermont/New England or Vermont-serving provider/public-health coverage.", false: "Health care is incidental, or the subject is outside the region with no Vermont-serving provider connection." },
  },
  scope_policy: {
    type: "noul",
    instructions: "Is the article substantively national US health news of the kind the supplied priorities list: federal health policy and programs (ACA, Medicare, Medicare Advantage, Medicaid), the insurance/payer industry and PBMs, drugs, vaccines, and FDA decisions, national public-health data, health costs and affordability, or health politics? National reporting qualifies without mentioning Vermont. Another state's own Medicaid administration, marketplace premiums, rate filings, lawsuits, or a single employer's health plan outside New England does NOT qualify, even when it names national companies, unless it involves a Blue Cross or Blue Shield plan or the Blue Cross Blue Shield Association, or federal or multi-state policy. Also exclude individual out-of-region patient, crime, or human-interest stories, consumer how-to advice, isolated foreign outbreaks, unrelated politics, and company, vendor, or law-firm promotions outside New England. Apply the supplied priorities and rules.",
    criteria: { true: "National US health policy, program, payer-industry, drug, public-health, cost, or health-politics reporting or substantive commentary.", false: "No qualifying national subject, or a single state's own program, market, lawsuit, or employer plan outside New England, a how-to, or an out-of-region promotion." },
  },
};

export function addEditorialAlignment(request, item, { examples = [], strategy = "references", inclusionExamples = 8, sentimentExamples = 16, criteria = "current", references = {}, trace } = {}) {
  if (!["references", "atomic", "atomic-references"].includes(strategy)) throw new Error("Unknown alignment strategy");
  const result = structuredClone(request);
  const useReferences = strategy.includes("references");
  const includeRows = useReferences ? chooseReferenceExamples(item, examples, { task: "inclusion", limit: inclusionExamples, storyGroupById: references.storyGroupById }) : [];
  const sentimentRows = useReferences ? chooseReferenceExamples(item, examples, { task: "sentiment", limit: sentimentExamples, storyGroupById: references.storyGroupById }) : [];
  const includeRefs = includeRows.map((row) => referenceExampleView(row, "inclusion"));
  const sentimentRefs = sentimentRows.map((row) => referenceExampleView(row, "sentiment"));
  // Optional out-parameter for the cache key: the rows behind each list that
  // actually enters the request. It never becomes part of the request.
  if (trace) Object.assign(trace, { inclusion: includeRows, sentiment: [] });
  const old = result.questions.include.instructions;
  result.questions.include.instructions = {
    ...(typeof old === "object" ? old : { question: old }),
    reference_guidance: "Evaluate only article. The paired reference articles show the communications team's human inclusion decisions: articles it kept (include true) and articles it left out (include false). Generalize their editorial purpose to new articles; shared words alone do not establish relevance. Most examples are inclusions, which does not imply that every candidate belongs.",
    reference_examples: includeRefs,
  };
  if (strategy.startsWith("atomic")) {
    Object.assign(result.questions, structuredClone(SCOPE_QUESTIONS));
    // The decision uses these scope answers, not the include answer, so the
    // regional and national scopes carry the shared editorial policy. Without
    // it, rule changes made for Gemini and the include question never reached
    // the decision (#15).
    for (const name of ["scope_regional", "scope_policy"]) {
      result.questions[name].instructions = { question: result.questions[name].instructions,
        priorities: INCLUSION_PRIORITIES, rules: INCLUSION_RULES };
    }
    if (useReferences && includeRefs.length) for (const name of Object.keys(SCOPE_QUESTIONS)) {
      const scoped = result.questions[name].instructions;
      result.questions[name].instructions = {
        ...(typeof scoped === "object" ? scoped : { question: scoped }),
        reference_guidance: "These are human examples of OVERALL inclusion and exclusion, not labels for this individual scope question. Learn the editorial intent, then assess whether the target article satisfies this specific scope. A reference can qualify through a different scope.",
        reference_examples: includeRefs,
      };
    }
  }
  if (result.questions.sentiment) {
    result.questions.sentiment.instructions = {
      ...result.questions.sentiment.instructions,
      reference_guidance: "Evaluate only article. Match the communications team's HUMAN judgment in the paired reference cases, including their editorial context. Scores concern BCBSVT specifically. Ordinary favorable presence without adverse framing is positive. Distinguish costs blamed on other organizations from criticism directed at BCBSVT. Similar wording does not imply the same tone or score.",
      ...(useReferences && sentimentRefs.length ? { examples: [], reference_examples: sentimentRefs } : {}),
    };
    if (trace && useReferences && sentimentRefs.length) trace.sentiment = sentimentRows;
    if (criteria === "contrastive") result.questions.sentiment.criteria = {
      positive: "Ordinary favorable or unopposed BCBSVT presence: awards, sponsorship, participation, useful programs, routine payer mentions, or favorably representing members. Criticism of other organizations can coexist with positive tone toward BCBSVT. Use this even for a brief mention when no adverse BCBSVT context is present.",
      "neutral to positive": "Some favorable BCBSVT positioning or benefit, qualified by an adverse headline, mixed context, or limitations. Favorable direction remains clearer than neutral balance.",
      neutral: "A genuinely balanced or informational account of BCBSVT with meaningful offsetting positives/negatives or affordability pressure. Not a default just because the excerpt is short or the brand mention is brief.",
      "neutral to negative": "Adverse subject matter or criticism relevant to BCBSVT, moderated by a passing/background mention, balance, or limited blame. Worse than balanced, less direct than clear adverse framing.",
      negative: "Direct adverse framing of BCBSVT: blamed for costs, denials, barriers, or harmful decisions; a critical opinion or strong adverse headline making the insurer the problem. General hospital/system problems alone do not establish this label.",
    };
  }
  return result;
}

export function alignedInclusionAnswer(answers, request) {
  if (!request.questions.scope_brand) return answers?.include;
  const names = ["scope_brand", "scope_regional", "scope_policy"];
  const values = names.map((name) => answers?.[name]);
  if (values.some((answer) => answer?.type !== "noul" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)) return null;
  // OR is the editorial rule. Maximum is a decision signal, not a calibrated
  // joint probability; thresholds must be validated on the complete rule.
  return { type: "noul", noul: Math.max(...values.map((answer) => answer.noul)) };
}

// Activation is explicit in the publishing workflow. The file contains only
// policy settings and hashes; all paired article content stays in the seed.
export async function loadAlignmentProfile(filename) {
  const profile = JSON.parse(await readFile(filename, "utf8"));
  const hash = /^[a-f0-9]{64}$/;
  if (profile.version !== ALIGNMENT_VERSION || profile.strategy !== "atomic-references" ||
      profile.criteria !== "contrastive" || !Number.isInteger(profile.inclusionExamples) ||
      profile.inclusionExamples < 1 || profile.inclusionExamples > 16 ||
      !Number.isInteger(profile.sentimentExamples) || profile.sentimentExamples < 1 || profile.sentimentExamples > 32 ||
      !profile.references || !Array.isArray(profile.references.excludedIds) || !Array.isArray(profile.references.conflictIds) ||
      (profile.references.rejectedIds !== undefined && (!Array.isArray(profile.references.rejectedIds) || !profile.references.rejectedIds.every(id => hash.test(id)))) ||
      !profile.references.excludedIds.every(id => hash.test(id)) || !profile.references.conflictIds.every(id => hash.test(id)) ||
      !profile.references.storyGroupById || typeof profile.references.storyGroupById !== "object" ||
      !Object.entries(profile.references.storyGroupById).every(([id, group]) => hash.test(id) && hash.test(group))) {
    throw new Error("Invalid Jev alignment profile");
  }
  return profile;
}

export const HUMAN_REJECTION_REASON = "Excluded by editorial review.";

// A human exclusion decides the article itself, the way a tracker clip's
// inclusion does. It cannot come through Jev: an article never sees its own
// label among its references, so Jev would judge it afresh. Runs after
// Gemini and before Jev on every pass, and marks the article so Jev skips
// it. Tracker clips keep their inclusion. A missing or invalid profile
// leaves every decision unchanged.
export async function applyHumanRejections(items, { env = process.env, alignment } = {}) {
  let profile = alignment;
  if (!profile && env.JEV_ALIGNMENT_PROFILE) {
    try { profile = await loadAlignmentProfile(env.JEV_ALIGNMENT_PROFILE); } catch { return items; }
  }
  const rejected = new Set(profile?.references?.rejectedIds || []);
  if (!rejected.size || !Array.isArray(items)) return items;
  return items.map((item) => {
    if (item?.fromMediaTracker || !rejected.has(exampleId(item?.link || item?.url || ""))) return item;
    return { ...item, relevant: false, reason: HUMAN_REJECTION_REASON, humanRejected: true };
  });
}
