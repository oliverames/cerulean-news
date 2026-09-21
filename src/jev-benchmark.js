// Offline, resumable evaluation. Human judgments are joined AFTER requests.
// Outputs contain private evaluation labels and must remain outside Git.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { buildJevRequest, classifyItemRelevance, decideJevRelevance, jevSkipReason, loadRelevanceRubric, loadSentimentRubric, normalizeJevCache, SENTIMENT_CONFIDENCE_THRESHOLD } from "./jev-relevance.js";
import { SENTIMENT_VALUES } from "./summaries.js";
import { mapWithConcurrency } from "./utils.js";

export function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sentimentAgreement(rows, field, { confidentOnly = false } = {}) {
  const eligible = rows.filter((row) => row.sentimentEligible && SENTIMENT_VALUES.includes(row.expectedSentiment));
  const scored = eligible.filter((row) => SENTIMENT_VALUES.includes(row[field]) &&
    (!confidentOnly || row.sentimentConfidence >= SENTIMENT_CONFIDENCE_THRESHOLD));
  const confusion = SENTIMENT_VALUES.map(() => SENTIMENT_VALUES.map(() => 0));
  let exact = 0, withinOne = 0, distance = 0, signed = 0;
  for (const row of scored) {
    const expected = SENTIMENT_VALUES.indexOf(row.expectedSentiment), actual = SENTIMENT_VALUES.indexOf(row[field]);
    confusion[expected][actual]++;
    exact += expected === actual ? 1 : 0;
    withinOne += Math.abs(expected - actual) <= 1 ? 1 : 0;
    distance += Math.abs(expected - actual);
    signed += expected - actual; // Positive means more favorable than human.
  }
  const perLabel = SENTIMENT_VALUES.map((label, index) => {
    const support = confusion[index].reduce((sum, count) => sum + count, 0);
    return { label, support, exact: confusion[index][index], recall: support ? confusion[index][index] / support : null };
  });
  const supported = perLabel.filter((row) => row.support);
  return { eligible: eligible.length, scored: scored.length, exact, withinOne,
    perLabel, macroRecall: supported.length ? supported.reduce((sum, row) => sum + row.recall, 0) / supported.length : null,
    exactRate: scored.length ? exact / scored.length : null,
    withinOneRate: scored.length ? withinOne / scored.length : null,
    meanAbsoluteDistance: scored.length ? distance / scored.length : null,
    meanFavorableBias: scored.length ? signed / scored.length : null,
    confusionLabels: SENTIMENT_VALUES, confusion };
}

export function summarizeBenchmark(rows) {
  const evaluated = rows.filter((row) => !row.skipReason);
  const successful = evaluated.filter((row) => row.ok);
  const mutable = successful.filter((row) => !row.curatedInclusion);
  const sentiment = successful.filter((row) => row.sentimentEligible);
  const paired = sentiment.filter((row) => SENTIMENT_VALUES.includes(row.baselineSentiment));
  const holdout = (predicate) => {
    const selected = rows.filter(predicate);
    const paired = selected.filter((row) => row.ok && SENTIMENT_VALUES.includes(row.baselineSentiment) && SENTIMENT_VALUES.includes(row.jevSentiment));
    return { commonPaired: { count: paired.filter((row) => row.sentimentEligible && row.expectedSentiment).length,
        jev: sentimentAgreement(paired, "jevSentiment"), baseline: sentimentAgreement(paired, "baselineSentiment") },
      lostHumanClips: selected.filter((row) => row.sentimentEligible && row.expectedSentiment && row.baselineRelevant && row.jevRelevant === false).length,
      alwaysPositive: sentimentAgreement(selected.map((row) => ({ ...row, constantSentiment: "positive" })), "constantSentiment"),
      jev: sentimentAgreement(selected, "jevSentiment"),
      jevConfident: sentimentAgreement(selected, "jevSentiment", { confidentOnly: true }),
      baseline: sentimentAgreement(selected, "baselineSentiment"),
      enforcedHybrid: sentimentAgreement(selected, "enforcedSentiment") };
  };
  return {
    total: rows.length, candidates: evaluated.length, succeeded: successful.length,
    failed: evaluated.length - successful.length,
    skips: rows.filter((row) => row.skipReason).reduce((counts, row) => ({ ...counts, [row.skipReason]: (counts[row.skipReason] || 0) + 1 }), {}),
    generatedSummaryFallback: evaluated.filter((row) => row.excerptSource === "generated summary").length,
    inclusion: {
      mutable: mutable.length, curatedProtected: successful.length - mutable.length,
      include: mutable.filter((row) => row.decision === "include").length,
      exclude: mutable.filter((row) => row.decision === "exclude").length,
      uncertain: mutable.filter((row) => row.decision === "keyword").length,
      added: mutable.filter((row) => row.jevRelevant && !row.baselineRelevant).length,
      removed: mutable.filter((row) => !row.jevRelevant && row.baselineRelevant).length,
      generatedSummaryDisagreements: mutable.filter((row) => row.excerptSource === "generated summary" && row.jevRelevant !== row.baselineRelevant).length,
      curatedModelRejections: successful.filter((row) => row.curatedInclusion && row.decision === "exclude").length,
    },
    sentiment: { requested: evaluated.filter((row) => row.sentimentEligible).length, succeeded: sentiment.length,
      confident: sentiment.filter((row) => row.sentimentConfidence >= SENTIMENT_CONFIDENCE_THRESHOLD).length,
      baselinePaired: paired.length, baselineExact: paired.filter((row) => row.jevSentiment === row.baselineSentiment).length,
      generatedSummaryFallback: sentiment.filter((row) => row.excerptSource === "generated summary").length },
    human: {
      all: holdout((row) => Boolean(row.expectedSentiment)),
      cleanHoldout: holdout((row) => row.isCleanHoldout),
      conservativeHoldout: holdout((row) => row.isCleanConservativeHoldout),
      sourceExcerptHoldout: holdout((row) => row.isCleanHoldout && row.excerptSource !== "generated summary"),
      generatedSummaryHoldout: holdout((row) => row.isCleanHoldout && row.excerptSource === "generated summary"),
    },
  };
}

async function privateJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, filename);
}

export async function evaluateArchive({ snapshot, holdout = { rows: [] }, outputDirectory, concurrency = 4, callJev,
  rubric, sentimentRubric, onProgress = () => {}, limit = Infinity } = {}) {
  if (!Array.isArray(snapshot?.items)) throw new Error("Snapshot must contain an items array");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("Concurrency must be 1–16");
  rubric ||= await loadRelevanceRubric();
  sentimentRubric ||= await loadSentimentRubric();
  const directory = path.resolve(outputDirectory), checkpointDirectory = path.join(directory, "requests");
  await mkdir(checkpointDirectory, { recursive: true, mode: 0o700 });
  const labels = new Map((holdout.rows || []).map((row) => [row.url, row]));
  if (labels.size !== (holdout.rows || []).length) throw new Error("Holdout URLs must be unique");
  const entries = snapshot.items.map((item, index) => {
    const request = buildJevRequest(item, rubric, { sentimentRubric });
    return { item, index, request, skipReason: jevSkipReason(item),
      key: fingerprint({ version: rubric.version, sentimentVersion: sentimentRubric.version, request }) };
  });
  const manifest = { requestSetHash: fingerprint(entries.map(({ key, skipReason }) => ({ key, skipReason }))), snapshotHash: fingerprint(snapshot), holdoutHash: fingerprint(holdout), generatedAt: snapshot.generatedAt,
    model: rubric.model, rubricVersion: rubric.version, sentimentVersion: sentimentRubric.version,
    policyHash: fingerprint({ rubric, sentimentRubric }), total: snapshot.items.length };
  const manifestPath = path.join(directory, "manifest.json");
  try {
    const previous = JSON.parse(await readFile(manifestPath, "utf8"));
    if (fingerprint(previous) !== fingerprint(manifest)) throw new Error("Evaluation inputs changed; choose a new output directory");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await privateJson(manifestPath, manifest);
  let requested = 0, cached = 0, completed = 0, failed = 0;
  const inFlight = new Map();
  const rows = await mapWithConcurrency(entries, concurrency, async ({ item, index, skipReason, request, key }) => {
    // Explicit allowlist: never merge labels or verdicts into request input.
    const label = labels.get(item.link || item.url) || {};
    const row = { index, url: item.link || item.url, title: item.title, pubDate: item.pubDate,
      ...request.state.article, skipReason, requestKey: key,
      baselineRelevant: item.relevant !== false, baselineReason: item.reason || "",
      baselineSentiment: item.sentiment || null,
      sentimentEligible: Boolean(request.questions.sentiment),
      expectedSentiment: label.expectedSentiment || null,
      isCleanHoldout: label.isCleanHoldout === true,
      isCleanConservativeHoldout: label.isCleanConservativeHoldout === true,
      isTrainingExample: label.isTrainingExample === true,
      isStorylineTraining: label.isStorylineTraining === true,
      humanLabelConflict: label.humanLabelsConflict === true };
    if (skipReason) return row;
    const checkpoint = path.join(checkpointDirectory, `${key}.json`);
    if (!inFlight.has(key)) inFlight.set(key, (async () => {
      try {
        const saved = JSON.parse(await readFile(checkpoint, "utf8"));
        const valid = saved.requestKey === key && saved.result?.ok && normalizeJevCache({ [key]: saved.result })[key];
        if (valid && (!row.sentimentEligible || valid.sentiment)) {
          cached++;
          return saved.result;
        }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (requested >= limit) return null;
      requested++;
      const result = await classifyItemRelevance(item, { rubric, request, callJev });
      // Record successes and failures. A resume retries failed calls only.
      await privateJson(checkpoint, { requestKey: key, evaluatedAt: new Date().toISOString(), result });
      return result;
    })());
    let result = await inFlight.get(key);
    if (result) result = { ...result, ...decideJevRelevance({ answers: {
      include: { type: "noul", noul: result.include },
      local_angle: { type: "noul", noul: result.localAngle },
      relevance: { type: "score", score: result.relevanceScore },
    }, keywordRelevant: row.baselineRelevant }) };
    if (!result) return { ...row, ok: false, error: "not evaluated" };
    completed++;
    if (!result.ok) failed++;
    if (completed % 50 === 0) onProgress({ completed, requested, cached, failed });
    const jevRelevant = row.curatedInclusion || !result.ok ? row.baselineRelevant : result.relevant;
    return { ...row, ...result, jevRelevant,
      jevSentiment: result.sentiment || null,
      enforcedSentiment: jevRelevant && row.sentimentEligible && result.ok && result.sentimentConfidence >= SENTIMENT_CONFIDENCE_THRESHOLD
        ? result.sentiment : jevRelevant ? row.baselineSentiment : null };
  });
  const summary = summarizeBenchmark(rows);
  const report = { ...manifest, evaluatedAt: new Date().toISOString(), requested, cached, summary, rows };
  await privateJson(path.join(directory, "comparison.json"), report);
  onProgress({ completed, requested, cached, failed, done: true });
  return report;
}
