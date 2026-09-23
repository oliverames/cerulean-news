// Jev evaluates inclusion and eligible BCBSVT sentiment after Gemini summaries.
// Keyword recall and deterministic editorial rules remain authoritative.
// Shadow mode records evidence without changing reader output. Enforce applies
// confident decisions; uncertainty or service failure keeps the current result.
// Successful evaluations are cached by their exact bounded request and rubrics.
import { createHash } from "node:crypto";
import { loadReferenceExamples } from "./jev-examples.js";
import { isObituaryItem } from "./filters.js";
import { addEditorialAlignment, alignedInclusionAnswer, loadAlignmentProfile } from "./jev-alignment.js";
import { applyDeterministicRelevance, itemCategory, itemOutletName, itemSourceType } from "./relevance.js";
import { INCLUSION_PRIORITIES, INCLUSION_RULES, matchStorylines, SENTIMENT_RULES, SENTIMENT_VALUES, shouldScoreSentiment, TRACKER_EXAMPLES } from "./summaries.js";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cleanText, mapWithConcurrency, parseDate, parsePositiveInteger, sleep } from "./utils.js";

const execFileAsync = promisify(execFile);

export const JEV_MODE_OFF = "off";
export const JEV_MODE_SHADOW = "shadow";
export const JEV_MODE_ENFORCE = "enforce";

const JEV_MODES = new Set([JEV_MODE_OFF, JEV_MODE_SHADOW, JEV_MODE_ENFORCE]);

// The uncertainty band. Chosen as a starting point, not a measured optimum:
// run in shadow mode and move them once real disagreements are in hand.
export const INCLUDE_THRESHOLD = 0.7;
export const EXCLUDE_THRESHOLD = 0.3;
export const SENTIMENT_CONFIDENCE_THRESHOLD = 0.7;

// Title plus a short excerpt only. Full article text is deliberately never
// sent: it is large, it is untrusted, and the feed's own keyword matching is
// title/description-scoped for the same reason.
const MAX_TITLE_CHARS = 300;
const MAX_EXCERPT_CHARS = 1200;

const DEFAULT_RUBRIC_RELATIVE_PATH = "src/rubrics/relevance-v2.json";
const DEFAULT_CLI_PATH = "jev";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CONCURRENCY = 2;
// A bounded number of requests per run, so switching the flag on cannot turn
// one crawl into thousands of API calls.
const DEFAULT_MAX_ITEMS = 25;

export const DECISION_INCLUDE = "include";
export const DECISION_EXCLUDE = "exclude";
export const DECISION_KEYWORD = "keyword";

// Reapplied on every run, so earlier wording is replaced when next seen.
const ENFORCED_EXCLUDE_REASON = "Outside the feed's editorial scope.";
// The editorial scope each aligned Jev question tests, in reader wording.
const SCOPE_REASONS = {
  scope_brand: "Blue Cross and Blue Shield coverage",
  scope_regional: "Vermont or New England health care news",
  scope_policy: "U.S. health coverage, insurance, or policy news",
};

// Gemini writes a reason even for articles it rejects. Most describe the
// topic ("National ACA enrollment changes"), but some state the rejection
// ("Outside scope", "New Hampshire grant, not Vermont") and would contradict
// an inclusion note, so those are left out. Earlier notes named the model
// instead of the article; they are never reused as a description.
const REJECTION_WORDING = /\b(?:not|no|outside|unrelated|irrelevant|incidental|generic|only|but|lacks?|without|jev)\b/i;

// Explains an article added after the first review left it out: Gemini's
// description of the article, then the editorial scope it was judged to fit
// most strongly, with that judgment's confidence.
export function jevInclusionReason(description, scopeSignals) {
  const strongest = Object.entries(SCOPE_REASONS)
    .map(([name, scope]) => ({ scope, value: scopeSignals?.[name] }))
    .filter(({ value }) => isProbability(value))
    .sort((a, b) => b.value - a.value)[0];
  const scope = strongest && strongest.value >= INCLUDE_THRESHOLD
    ? `Fits ${strongest.scope} (${Math.round(strongest.value * 100)}% confidence).`
    : "";
  const subject = cleanText(description || "").replace(/[.\s]+$/, "");
  const lead = subject && !REJECTION_WORDING.test(subject) ? `${subject}.` : "";
  return [lead, scope].filter(Boolean).join(" ") || "Fits the feed's editorial scope.";
}

export function jevRelevanceMode(env = process.env) {
  const configured = String(env.JEV_RELEVANCE || "").trim().toLowerCase();
  if (!configured) {
    return JEV_MODE_OFF;
  }
  if (!JEV_MODES.has(configured)) {
    console.warn(
      `Unknown JEV_RELEVANCE mode "${configured}"; the classifier stays off.`,
    );
    return JEV_MODE_OFF;
  }
  return configured;
}

function resolveRubricPath(rubricPath, env = process.env) {
  if (rubricPath) {
    return path.resolve(process.cwd(), rubricPath);
  }
  const configured = env.JEV_RELEVANCE_RUBRIC_PATH?.trim();
  if (configured) {
    return path.resolve(process.cwd(), configured);
  }
  try {
    // Next to the module, which is where the wording belongs; import.meta.url
    // is unavailable in a bundled Worker, hence the cwd fallback.
    return fileURLToPath(new URL("./rubrics/relevance-v2.json", import.meta.url));
  } catch {
    return path.resolve(process.cwd(), DEFAULT_RUBRIC_RELATIVE_PATH);
  }
}

function assertQuestion(rubric, id, type) {
  const question = rubric?.questions?.[id];
  if (!question || question.type !== type) {
    throw new Error(`Rubric is missing a "${id}" ${type} question.`);
  }
  if (!question.instructions) {
    throw new Error(`Rubric question "${id}" has no instructions.`);
  }
}

export function validateRelevanceRubric(rubric) {
  if (!rubric || typeof rubric !== "object") {
    throw new Error("Rubric is not an object.");
  }
  if (!rubric.version) {
    throw new Error("Rubric has no version.");
  }
  if (!rubric.model) {
    throw new Error("Rubric has no model.");
  }
  assertQuestion(rubric, "include", "noul");
  assertQuestion(rubric, "local_angle", "noul");
  assertQuestion(rubric, "relevance", "score");
  if (!Array.isArray(rubric.questions.relevance.criteria)) {
    throw new Error('Rubric question "relevance" needs an array of levels.');
  }
  return rubric;
}

// Versioned questions combine with the same editorial priorities Gemini uses.
// Keeping the policy shared prevents independent classifiers drifting in scope.
export async function loadRelevanceRubric({ rubricPath, env } = {}) {
  const resolved = resolveRubricPath(rubricPath, env || process.env);
  const raw = await readFile(resolved, "utf8");
  const rubric = validateRelevanceRubric(JSON.parse(raw));
  if (rubric.version === "relevance-v2") {
    rubric.questions.include.instructions = {
      question: rubric.questions.include.instructions,
      priorities: INCLUSION_PRIORITIES,
      rules: INCLUSION_RULES,
    };
  }
  return rubric;
}

function articleExcerpt(item) {
  // Prefer source excerpts, with an explicitly marked generated-summary fallback.
  // item.articleText / feedContent hold fetched pages and are never considered.
  const source = item?.snippet || item?.description || item?.summary || "";
  return cleanText(source).slice(0, MAX_EXCERPT_CHARS);
}

export function buildJevRequest(item, rubric, { sentimentRubric, alignment, referenceExamples } = {}) {
  validateRelevanceRubric(rubric);
  const questions = { ...rubric.questions };
  if (sentimentRubric && shouldScoreSentiment({ ...item, relevant: undefined })) {
    questions.sentiment = {
      ...sentimentRubric.question,
      instructions: {
        question: sentimentRubric.question.instructions,
        rules: SENTIMENT_RULES,
        examples: TRACKER_EXAMPLES,
        storylines: matchStorylines(item).map(({ name, note }) => ({ name, note })),
      },
    };
  }
  const request = {
    state: {
      article: {
        title: cleanText(item?.title || "").slice(0, MAX_TITLE_CHARS),
        excerpt: articleExcerpt(item),
        excerptSource: item?.snippet ? "source snippet" : item?.description ? "source description" : item?.summary ? "generated summary" : "none",
        outlet: cleanText(itemOutletName(item)).slice(0, 200),
        matchedKeywords: (Array.isArray(item?.matchedTerms) ? item.matchedTerms : []).slice(0, 30).map((term) => cleanText(String(term)).slice(0, 100)),
        category: itemCategory(item),
        sourceType: itemSourceType(item),
        eligibleBcbsVtSentiment: shouldScoreSentiment({ ...item, relevant: undefined }),
        curatedInclusion: item?.fromMediaTracker === true,
      },
    },
    model: rubric.model,
    questions,
  };
  return alignment ? addEditorialAlignment(request, item, { ...alignment, examples: referenceExamples || [] }) : request;
}

function noulValue(answer) {
  return answer?.type === "noul" && isProbability(answer.noul)
    ? answer.noul
    : null;
}

function scoreValue(answer) {
  return answer?.type === "score" && Number.isFinite(answer.score)
    ? answer.score
    : null;
}

// The keyword/deterministic verdict as the rest of the pipeline reads it:
// undefined means "not yet judged", which publishes, so only an explicit
// false is a rejection.
export function keywordVerdict(item) {
  return item?.relevant !== false;
}

// Pure policy. Everything the decision depends on is an argument, so the
// thresholds can be exercised without touching the network.
export function decideJevRelevance({
  answers,
  keywordRelevant,
  includeThreshold = INCLUDE_THRESHOLD,
  excludeThreshold = EXCLUDE_THRESHOLD,
} = {}) {
  const include = noulValue(answers?.include);
  const localAngle = noulValue(answers?.local_angle);
  const relevanceScore = scoreValue(answers?.relevance);
  const signals = { include, localAngle, relevanceScore };

  if (include === null) {
    return {
      ...signals,
      decision: DECISION_KEYWORD,
      relevant: keywordRelevant,
      agreesWithKeyword: true,
      note: "no usable include answer",
    };
  }

  if (include >= includeThreshold) {
    return {
      ...signals,
      decision: DECISION_INCLUDE,
      relevant: true,
      agreesWithKeyword: keywordRelevant === true,
      note: "",
    };
  }

  if (include <= excludeThreshold) {
    return {
      ...signals,
      decision: DECISION_EXCLUDE,
      relevant: false,
      agreesWithKeyword: keywordRelevant === false,
      note: "",
    };
  }

  // The uncertainty band: the model is not confident enough either way, so
  // today's behavior stands.
  return {
    ...signals,
    decision: DECISION_KEYWORD,
    relevant: keywordRelevant,
    agreesWithKeyword: true,
    note: "uncertainty band",
  };
}

// One `jev raw` request per article. The CLI holds the credential; nothing
// here reads, logs, or persists a key.
export async function callJevCli(requestBody, options = {}) {
  const cliPath =
    options.cliPath || process.env.JEV_CLI_PATH?.trim() || DEFAULT_CLI_PATH;
  const timeoutMs = parsePositiveInteger(
    options.timeoutMs ?? process.env.JEV_RELEVANCE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const directory = await mkdtemp(path.join(tmpdir(), "jev-relevance-"));
  const requestPath = path.join(directory, "request.json");
  try {
    await writeFile(requestPath, JSON.stringify(requestBody), "utf8");
    const { stdout } = await execFileAsync(
      cliPath,
      ["raw", "--file", requestPath],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {
      // A leftover temp directory is not worth failing a crawl over.
    });
  }
}

// Classifies one item. Never throws: a failure returns the keyword verdict
// with the error attached for the caller to log.
export async function classifyItemRelevance(item, options = {}) {
  const keywordRelevant = keywordVerdict(item);
  try {
    const rubric = options.rubric || (await loadRelevanceRubric(options));
    const request = options.request || buildJevRequest(item, rubric, options);
    const callJev = options.callJev || callJevApi;
    const response = await callJev(request, options);
    const decision = decideJevRelevance({
      answers: { ...response?.answers, include: alignedInclusionAnswer(response?.answers, request) },
      keywordRelevant,
      includeThreshold: options.includeThreshold,
      excludeThreshold: options.excludeThreshold,
    });
    const sentiment = request.questions.sentiment
      ? parseSentimentAnswer(response?.answers?.sentiment)
      : null;
    return {
      ...decision,
      sentiment: sentiment?.choice || null,
      sentimentConfidence: sentiment?.confidence ?? null,
      sentimentProbabilities: sentiment ? response.answers.sentiment.probabilities : null,
      scopeSignals: request.questions.scope_brand ? Object.fromEntries(["scope_brand", "scope_regional", "scope_policy"].map((name) => [name, response?.answers?.[name]?.noul ?? null])) : undefined,
      ok: decision.include !== null && (!request.questions.sentiment || sentiment !== null),
      error: decision.include === null ? "no usable include answer"
        : request.questions.sentiment && !sentiment ? "no usable sentiment answer" : "",
      rubricVersion: rubric.version,
      model: response?.model || rubric.model,
    };
  } catch (error) {
    return {
      decision: DECISION_KEYWORD,
      relevant: keywordRelevant,
      agreesWithKeyword: true,
      include: null,
      localAngle: null,
      relevanceScore: null,
      ok: false,
      error: cleanText(error?.message || String(error)).slice(0, 200),
      note: "classifier unavailable",
      rubricVersion: "",
      model: "",
    };
  }
}

// Deterministic rules own these items, so the model is never asked about them.
export function jevSkipReason(item) {
  if (isObituaryItem(item) || applyDeterministicRelevance({ ...item, relevant: undefined }).relevant === false) {
    return "rejected by a deterministic rule";
  }
  if (item?.fromMediaTracker) {
    return shouldScoreSentiment({ ...item, relevant: undefined }) ? "" : "hand-vetted entry without eligible sentiment";
  }
  if (applyDeterministicRelevance({ ...item, relevant: false }).relevant === true) {
    return "explicitly included by a deterministic rule";
  }
  if (!cleanText(item?.title || "") && !articleExcerpt(item)) {
    return "no title or excerpt to judge";
  }
  return "";
}

export function selectJevCandidates(items, maxItems) {
  const candidates = [];
  for (const item of items) {
    if (jevSkipReason(item)) {
      continue;
    }
    if (candidates.length >= maxItems) {
      break;
    }
    candidates.push(item);
  }
  return candidates;
}

function describeDecision(item, classification) {
  const parts = [
    classification.decision,
    `include=${classification.include === null ? "n/a" : classification.include.toFixed(2)}`,
    `local=${classification.localAngle === null ? "n/a" : classification.localAngle.toFixed(2)}`,
    `score=${classification.relevanceScore === null ? "n/a" : classification.relevanceScore.toFixed(2)}`,
  ];
  if (classification.note) {
    parts.push(classification.note);
  }
  if (classification.error) {
    parts.push(`error: ${classification.error}`);
  }
  return `[${parts.join(" ")}] ${cleanText(item.title || "").slice(0, 70)}`;
}


function isProbability(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseSentimentAnswer(answer) {
  if (answer?.type !== "choice" || !SENTIMENT_VALUES.includes(answer.choice) || !isProbability(answer.confidence)) return null;
  const probabilities = answer.probabilities;
  if (!probabilities || Object.keys(probabilities).length !== SENTIMENT_VALUES.length ||
      !SENTIMENT_VALUES.every((label) => isProbability(probabilities[label]))) return null;
  const total = SENTIMENT_VALUES.reduce((sum, label) => sum + probabilities[label], 0);
  if (Math.abs(total - 1) > 0.001 || SENTIMENT_VALUES.some((label) => probabilities[label] > probabilities[answer.choice])) return null;
  return { choice: answer.choice, confidence: answer.confidence };
}

export async function loadSentimentRubric() {
  const rubric = JSON.parse(await readFile(new URL("./rubrics/sentiment-v2.json", import.meta.url), "utf8"));
  if (!rubric.version || rubric.question?.type !== "choice" ||
      !SENTIMENT_VALUES.every((label) => typeof rubric.question.criteria?.[label] === "string")) {
    throw new Error("Invalid Jev sentiment rubric");
  }
  return rubric;
}

// Use the provider's HTTPS endpoint directly in Actions. No CLI installation
// or credential file is required. Never log response bodies or authorization.
export async function callJevApi(requestBody, options = {}) {
  const env = options.env || process.env;
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    if (options.cliPath || env.JEV_CLI_PATH?.trim()) {
      return callJevCli(requestBody, { ...options, cliPath: options.cliPath || env.JEV_CLI_PATH });
    }
    throw new Error("TYPESAFE_API_KEY is not configured");
  }
  const timeoutMs = parsePositiveInteger(options.timeoutMs ?? env.JEV_RELEVANCE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl || fetch;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetchImpl("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (response.ok) return response.json();
    if (attempt === 0 && [429, 529].includes(response.status)) {
      const retryAfter = response.headers.get("retry-after");
      const parsedDelay = retryAfter && (/^\d+(?:\.\d+)?$/.test(retryAfter)
        ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now());
      const delay = Math.max(1000, Number.isFinite(parsedDelay) ? parsedDelay : 1000);
      if (delay <= 10000) {
        await response.body?.cancel();
        await (options.sleepImpl || sleep)(delay);
        continue;
      }
    }
    await response.body?.cancel();
    throw new Error(`TypeSafe API HTTP ${response.status}`);
  }
}

// The audit cache carries only typed signals, never article text, credentials,
// raw responses, or exception strings. Invalid persisted entries are dropped.
export function normalizeJevCache(value) {
  const cache = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return cache;
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !entry || !isProbability(entry.include) ||
        typeof entry.model !== "string" || typeof entry.rubricVersion !== "string" ||
        (entry.sentiment != null && (!SENTIMENT_VALUES.includes(entry.sentiment) || !isProbability(entry.sentimentConfidence)))) continue;
    cache[key] = {
      ...(typeof entry.alignmentVersion === "string" ? { alignmentVersion: entry.alignmentVersion.slice(0, 80) } : {}),
      model: entry.model.slice(0, 80),
      rubricVersion: entry.rubricVersion.slice(0, 80),
      include: entry.include,
      localAngle: isProbability(entry.localAngle) ? entry.localAngle : null,
      relevanceScore: Number.isFinite(entry.relevanceScore) && entry.relevanceScore >= 0 && entry.relevanceScore <= 9 ? entry.relevanceScore : null,
      sentiment: entry.sentiment || null,
      sentimentConfidence: entry.sentiment ? entry.sentimentConfidence : null,
      // Kept so the published note can name the scope that qualified an article.
      ...(normalizeScopeSignals(entry.scopeSignals) ? { scopeSignals: normalizeScopeSignals(entry.scopeSignals) } : {}),
    };
  }
  return cache;
}

function normalizeScopeSignals(value) {
  if (!value || typeof value !== "object") return undefined;
  const signals = Object.fromEntries(Object.keys(SCOPE_REASONS)
    .map((name) => [name, isProbability(value[name]) ? value[name] : null]));
  return Object.values(signals).some((signal) => signal !== null) ? signals : undefined;
}

// Audit-only original decisions enable a targeted restoration without
// replacing the whole archive or losing subsequently discovered articles.
export function normalizeJevBaseline(value) {
  const capturedAt = parseDate(value?.capturedAt);
  if (!capturedAt || ![true, false, null].includes(value.relevant) ||
      (value.sentiment !== null && !SENTIMENT_VALUES.includes(value.sentiment))) return undefined;
  return { capturedAt: capturedAt.toISOString(), relevant: value.relevant,
    reason: cleanText(value.reason || "").slice(0, 1000), sentiment: value.sentiment,
    sentimentReason: cleanText(value.sentimentReason || "").slice(0, 1000) };
}

function decisionFromCache(entry, item, options) {
  return {
    ...entry,
    ...decideJevRelevance({
      answers: {
        include: { type: "noul", noul: entry.include },
        local_angle: { type: "noul", noul: entry.localAngle },
        relevance: { type: "score", score: entry.relevanceScore },
      },
      keywordRelevant: keywordVerdict(item),
      includeThreshold: options.includeThreshold,
      excludeThreshold: options.excludeThreshold,
    }),
    ok: true,
  };
}

export async function applyJevRelevance(items, options = {}) {
  const env = options.env || process.env;
  const mode = jevRelevanceMode({ JEV_RELEVANCE: options.mode ?? env.JEV_RELEVANCE });
  const metrics = options.metrics || {};
  Object.assign(metrics, { mode, status: mode === JEV_MODE_OFF ? "off" : "pending", eligible: 0,
    requested: 0, succeeded: 0, failed: 0, cached: 0, pending: 0,
    inclusionDisagreements: 0, sentimentDisagreements: 0 });
  if (mode === JEV_MODE_OFF || !Array.isArray(items) || items.length === 0) return items;

  let rubric, sentimentRubric;
  try {
    rubric = options.rubric || await loadRelevanceRubric(options);
    sentimentRubric = options.sentimentRubric || await loadSentimentRubric();
    validateRelevanceRubric(rubric);
  } catch {
    metrics.status = "rubric_unavailable";
    console.warn(`Jev evaluation (${mode}): rubric unavailable; keeping existing decisions.`);
    return items;
  }

  let alignment, referenceExamples = [];
  if (options.alignment || env.JEV_ALIGNMENT_PROFILE) {
    try {
      alignment = options.alignment || await loadAlignmentProfile(env.JEV_ALIGNMENT_PROFILE);
    } catch {
      metrics.status = "alignment_unavailable";
      console.warn(`Jev evaluation (${mode}): alignment profile unavailable; keeping existing decisions.`);
      return items;
    }
    const reference = options.referenceExamples
      ? { status: "loaded", examples: options.referenceExamples }
      : await loadReferenceExamples(items, { env, config: alignment.references });
    Object.assign(metrics, { alignmentVersion: alignment.version, referenceStatus: reference.status,
      inclusionReferences: reference.examples.length, sentimentReferences: reference.examples.filter(row => row.sentiment).length });
    if (reference.status !== "loaded" || !reference.examples.length) {
      metrics.status = "examples_unavailable";
      console.warn(`Jev evaluation (${mode}): human references ${reference.status}; keeping existing decisions.`);
      return items;
    }
    referenceExamples = reference.examples;
  }

  const enforceAfter = options.enforceAfter ?? env.JEV_ENFORCE_AFTER;
  const boundedEnforcement = Boolean(alignment) || enforceAfter !== undefined;
  const cutoff = parseDate(enforceAfter);
  const mayEnforce = item => !boundedEnforcement || Boolean(cutoff && parseDate(item.firstSeenAt) &&
    parseDate(item.firstSeenAt).valueOf() >= cutoff.valueOf());
  if (boundedEnforcement) {
    metrics.enforceAfter = cutoff?.toISOString() || null;
    metrics.historicalProtected = items.filter(item => !mayEnforce(item)).length;
  }
  if (mode === JEV_MODE_ENFORCE && boundedEnforcement && !cutoff) {
    metrics.status = "activation_boundary_unavailable";
    console.warn("Jev enforcement: valid activation boundary required; keeping existing decisions.");
    return items;
  }
  Object.assign(metrics, { inclusionApplied: 0, sentimentApplied: 0 });

  const maxItems = parsePositiveInteger(options.maxItems ?? env.JEV_RELEVANCE_MAX_ITEMS, DEFAULT_MAX_ITEMS);
  const concurrency = parsePositiveInteger(options.concurrency ?? env.JEV_RELEVANCE_CONCURRENCY, DEFAULT_CONCURRENCY);
  const candidates = selectJevCandidates(items, Infinity);
  metrics.eligible = candidates.length;
  metrics.enforcementEligible = candidates.filter(mayEnforce).length;
  const cache = options.cache || {};
  const normalized = normalizeJevCache(cache);
  const entries = candidates.map((item) => {
    const request = buildJevRequest(item, rubric, { sentimentRubric, alignment, referenceExamples });
    const key = createHash("sha256").update(JSON.stringify({ alignmentVersion: alignment?.version, version: rubric.version, sentimentVersion: sentimentRubric.version, request })).digest("hex");
    return { item, request, key };
  });
  const activeKeys = new Set(entries.map(({ key }) => key));
  for (const key of Object.keys(cache)) {
    if (!activeKeys.has(key) || !normalized[key]) delete cache[key];
    else cache[key] = normalized[key];
  }
  const classifications = new Map();
  const pending = [];
  for (const entry of entries) {
    if (cache[entry.key]) {
      classifications.set(entry.item, decisionFromCache(cache[entry.key], entry.item, options));
      metrics.cached += 1;
    } else pending.push(entry);
  }
  const configured = options.callJev || env.TYPESAFE_API_KEY?.trim() || options.cliPath || env.JEV_CLI_PATH?.trim();
  const eligiblePending = mode === JEV_MODE_ENFORCE ? pending.filter(entry => mayEnforce(entry.item)) : pending;
  const runEntries = configured ? eligiblePending.slice(0, maxItems) : [];
  // Additions cached before scope scores were stored have notes that cannot
  // name a scope. Re-ask for those scores within the same per-run cap. Only
  // the scope scores are kept, so published decisions cannot change.
  const needsScope = configured && alignment && mode === JEV_MODE_ENFORCE
    ? entries.filter(({ item, key }) => cache[key] && !cache[key].scopeSignals && mayEnforce(item) &&
        !item.fromMediaTracker && classifications.get(item)?.decision === DECISION_INCLUDE &&
        (item.relevant === false || normalizeJevBaseline(item.jevBaseline)?.relevant === false))
    : [];
  const scopeBackfill = needsScope.slice(0, Math.max(0, maxItems - runEntries.length));
  metrics.scopeBackfillPending = needsScope.length;
  metrics.scopeBackfilled = 0;
  await mapWithConcurrency(scopeBackfill, concurrency, async ({ item, request, key }) => {
    const refreshed = await classifyItemRelevance(item, { ...options, rubric, request });
    const scopeSignals = refreshed.ok ? normalizeScopeSignals(refreshed.scopeSignals) : undefined;
    if (!scopeSignals) return;
    cache[key] = { ...cache[key], scopeSignals };
    classifications.set(item, { ...classifications.get(item), scopeSignals });
    metrics.scopeBackfilled += 1;
  });
  metrics.scopeBackfillPending -= metrics.scopeBackfilled;
  metrics.requested = runEntries.length;
  metrics.status = configured ? "complete" : "credentials_missing";
  if (!configured) console.warn(`Jev evaluation (${mode}): TYPESAFE_API_KEY is not configured; no live evaluations can run.`);
  await mapWithConcurrency(runEntries, concurrency, async ({ item, request, key }) => {
    const classification = await classifyItemRelevance(item, { ...options, rubric, request });
    if (alignment) classification.alignmentVersion = alignment.version;
    classifications.set(item, classification);
    if (classification.ok) {
      cache[key] = normalizeJevCache({ [key]: classification })[key];
      metrics.succeeded += 1;
    } else metrics.failed += 1;
    console.log(`  jev ${mode} -> ${describeDecision(item, classification)} sentiment=${classification.sentiment || "n/a"} confidence=${classification.sentimentConfidence ?? "n/a"}`);
  });
  metrics.pending = eligiblePending.length - metrics.succeeded;
  if (metrics.failed) metrics.status = "partial_failure";
  for (const [item, classification] of classifications) {
    if (!item.fromMediaTracker && !classification.agreesWithKeyword) metrics.inclusionDisagreements += 1;
    if (classification.sentiment && item.sentiment && classification.sentiment !== item.sentiment) metrics.sentimentDisagreements += 1;
  }
  console.log(`Jev evaluation (${mode}): ${metrics.succeeded}/${metrics.requested} successful, ${metrics.cached} cached, ${metrics.pending} pending, ${metrics.scopeBackfilled} scope backfills (${metrics.scopeBackfillPending} left); ${metrics.inclusionDisagreements} inclusion and ${metrics.sentimentDisagreements} sentiment disagreements. Status: ${metrics.status}.`);
  if (mode === JEV_MODE_SHADOW) return items;

  return items.map((item) => {
    const classification = classifications.get(item);
    if (!classification?.ok || !mayEnforce(item)) return item;
    let result = item;
    if (!item.fromMediaTracker && classification.decision !== DECISION_KEYWORD) {
      const baseline = normalizeJevBaseline(item.jevBaseline);
      result = { ...item, relevant: classification.relevant,
        reason: classification.decision === DECISION_EXCLUDE ? ENFORCED_EXCLUDE_REASON
          : item.relevant === false ? jevInclusionReason(item.reason, classification.scopeSignals)
            // Rebuilt from the saved first-review description on every run,
            // so a note picks up backfilled scope scores and wording changes.
            : baseline?.relevant === false ? jevInclusionReason(baseline.reason, classification.scopeSignals)
              : item.reason || "",
        jevRelevance: { rubricVersion: classification.rubricVersion, model: classification.model,
          include: classification.include, localAngle: classification.localAngle,
          relevanceScore: classification.relevanceScore, decision: classification.decision },
      };
    }
    if (classification.sentiment && classification.sentimentConfidence >= SENTIMENT_CONFIDENCE_THRESHOLD && shouldScoreSentiment(result)) {
      result = { ...result, sentiment: classification.sentiment, sentimentReason: "" };
    }
    if (result !== item) {
      if (result.relevant !== item.relevant) metrics.inclusionApplied += 1;
      if (result.sentiment !== item.sentiment) metrics.sentimentApplied += 1;
      result = { ...result, jevBaseline: normalizeJevBaseline(item.jevBaseline) || normalizeJevBaseline({
        capturedAt: (options.now || new Date()).toISOString(), relevant: typeof item.relevant === "boolean" ? item.relevant : null,
        reason: item.reason || "", sentiment: SENTIMENT_VALUES.includes(item.sentiment) ? item.sentiment : null,
        sentimentReason: item.sentimentReason || "",
      }) };
    }
    return result;
  });
}
