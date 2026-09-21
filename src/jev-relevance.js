// EXPERIMENTAL second-opinion relevance classifier backed by Jev (TypeSafe
// System One). Off by default; see the decision policy below before enabling.
//
// Where it sits in the pipeline
// -----------------------------
// Keyword matching (matching.js) stays the cheap recall stage: it decides what
// is even a candidate, and nothing here loosens it. The deterministic editorial
// rules stay authoritative too - URL dedup (archive.js), the obituary and other
// item exclusions (filters.js), and every rule in applyDeterministicRelevance
// (relevance.js) run first, and an item they have already rejected is never
// sent to the model. Jev only re-judges items the cheap stages kept.
//
// Decision policy
// ---------------
// One request per article asks three independent questions over the same state
// (they run in parallel and cannot see one another's answers):
//
//   include      noul   should this article be in the feed?
//   local_angle  noul   does it have a Vermont or local angle?
//   relevance    score  how relevant is it, on the rubric's levels?
//
// Only `include` gates the verdict, through an uncertainty band:
//
//   include >= 0.7   include the item
//   include <= 0.3   exclude the item
//   in between       keep the keyword verdict (fail open to today's behavior)
//
// `local_angle` and `relevance` are recorded as diagnostics, not applied. They
// exist so a shadow run produces the signals needed to calibrate a future
// policy (for example a local-angle floor) against real items, rather than
// having thresholds chosen before any data exists.
//
// Anything that goes wrong - a missing rubric, a CLI that is not installed, a
// timeout, an HTTP error, a malformed answer - falls back to the keyword
// verdict and logs. The classifier must never be able to fail the run.
//
// Modes (JEV_RELEVANCE)
// ---------------------
//   off      (default) no requests, items untouched
//   shadow   classify and log what Jev would have decided; output unchanged
//   enforce  apply the decisions above to item.relevant / item.reason
//
// Nothing here publishes, sends, or approves anything on its own.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { cleanText, mapWithConcurrency, parsePositiveInteger } from "./utils.js";

const execFileAsync = promisify(execFile);

export const JEV_MODE_OFF = "off";
export const JEV_MODE_SHADOW = "shadow";
export const JEV_MODE_ENFORCE = "enforce";

const JEV_MODES = new Set([JEV_MODE_OFF, JEV_MODE_SHADOW, JEV_MODE_ENFORCE]);

// The uncertainty band. Chosen as a starting point, not a measured optimum:
// run in shadow mode and move them once real disagreements are in hand.
export const INCLUDE_THRESHOLD = 0.7;
export const EXCLUDE_THRESHOLD = 0.3;

// Title plus a short excerpt only. Full article text is deliberately never
// sent: it is large, it is untrusted, and the feed's own keyword matching is
// title/description-scoped for the same reason.
const MAX_TITLE_CHARS = 300;
const MAX_EXCERPT_CHARS = 600;

const DEFAULT_RUBRIC_RELATIVE_PATH = "src/rubrics/relevance-v1.json";
const DEFAULT_CLI_PATH = "jev";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_CONCURRENCY = 2;
// A bounded number of requests per run, so switching the flag on cannot turn
// one crawl into thousands of API calls.
const DEFAULT_MAX_ITEMS = 25;

export const DECISION_INCLUDE = "include";
export const DECISION_EXCLUDE = "exclude";
export const DECISION_KEYWORD = "keyword";

const ENFORCED_EXCLUDE_REASON =
  "Jev relevance classifier judged this outside the feed's editorial scope.";

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
    return fileURLToPath(new URL("./rubrics/relevance-v1.json", import.meta.url));
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

// The rubric is the single source of the question wording. Nothing in this
// module restates it, so a wording change is one diffable JSON edit.
export async function loadRelevanceRubric({ rubricPath, env } = {}) {
  const resolved = resolveRubricPath(rubricPath, env || process.env);
  const raw = await readFile(resolved, "utf8");
  return validateRelevanceRubric(JSON.parse(raw));
}

function articleExcerpt(item) {
  // Feed-supplied summary text only. item.articleText / feedContent hold the
  // fetched page and are deliberately not considered.
  const source = item?.snippet || item?.description || item?.summary || "";
  return cleanText(source).slice(0, MAX_EXCERPT_CHARS);
}

export function buildJevRequest(item, rubric) {
  validateRelevanceRubric(rubric);
  return {
    state: {
      article: {
        title: cleanText(item?.title || "").slice(0, MAX_TITLE_CHARS),
        excerpt: articleExcerpt(item),
      },
    },
    model: rubric.model,
    questions: rubric.questions,
  };
}

function noulValue(answer) {
  return answer?.type === "noul" && Number.isFinite(answer.noul)
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
    const request = buildJevRequest(item, rubric);
    const callJev = options.callJev || callJevCli;
    const response = await callJev(request, options);
    const decision = decideJevRelevance({
      answers: response?.answers,
      keywordRelevant,
      includeThreshold: options.includeThreshold,
      excludeThreshold: options.excludeThreshold,
    });
    return {
      ...decision,
      ok: true,
      error: "",
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
function skipReason(item) {
  if (item?.fromMediaTracker) {
    return "hand-vetted media tracker entry";
  }
  if (item?.relevant === false) {
    return "already rejected by a deterministic rule";
  }
  if (!cleanText(item?.title || "") && !articleExcerpt(item)) {
    return "no title or excerpt to judge";
  }
  return "";
}

export function selectJevCandidates(items, maxItems) {
  const candidates = [];
  for (const item of items) {
    if (skipReason(item)) {
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

// Returns the items, classified or untouched depending on the mode. In shadow
// mode the returned items are the ones passed in: it logs and changes nothing.
export async function applyJevRelevance(items, options = {}) {
  const env = options.env || process.env;
  const mode = options.mode || jevRelevanceMode(env);
  if (mode === JEV_MODE_OFF || !Array.isArray(items) || items.length === 0) {
    return items;
  }

  const maxItems = parsePositiveInteger(
    options.maxItems ?? env.JEV_RELEVANCE_MAX_ITEMS,
    DEFAULT_MAX_ITEMS,
  );
  const concurrency = parsePositiveInteger(
    options.concurrency ?? env.JEV_RELEVANCE_CONCURRENCY,
    DEFAULT_CONCURRENCY,
  );
  const candidates = selectJevCandidates(items, maxItems);
  if (candidates.length === 0) {
    return items;
  }

  let rubric = options.rubric;
  if (!rubric) {
    try {
      rubric = await loadRelevanceRubric(options);
    } catch (error) {
      console.warn(
        `Jev relevance (${mode}) disabled for this run: ${cleanText(error?.message || String(error))}`,
      );
      return items;
    }
  }

  const classifications = new Map();
  await mapWithConcurrency(candidates, concurrency, async (item) => {
    const classification = await classifyItemRelevance(item, {
      ...options,
      rubric,
    });
    classifications.set(item, classification);
    console.log(`  jev ${mode} -> ${describeDecision(item, classification)}`);
  });

  const disagreements = [...classifications.values()].filter(
    (classification) => !classification.agreesWithKeyword,
  ).length;
  console.log(
    `Jev relevance (${mode}): classified ${classifications.size} of ${items.length} items, ${disagreements} disagreed with the keyword verdict.`,
  );

  if (mode === JEV_MODE_SHADOW) {
    return items;
  }

  return items.map((item) => {
    const classification = classifications.get(item);
    if (!classification || classification.decision === DECISION_KEYWORD) {
      return item;
    }
    return {
      ...item,
      relevant: classification.relevant,
      reason:
        classification.decision === DECISION_EXCLUDE
          ? ENFORCED_EXCLUDE_REASON
          : item.reason || "",
      // In-memory diagnostics; the output serializers publish a fixed field
      // list, so this rides along for logging and debugging only.
      jevRelevance: {
        rubricVersion: classification.rubricVersion,
        model: classification.model,
        include: classification.include,
        localAngle: classification.localAngle,
        relevanceScore: classification.relevanceScore,
        decision: classification.decision,
      },
    };
  });
}
