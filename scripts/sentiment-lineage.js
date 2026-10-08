// Prevent duplicate paid/quota-consuming sends after a cancelled or failed run.
// Only GitHub run metadata is read; no article or reference text is transmitted.
import { fileURLToPath } from "node:url";
import path from "node:path";

const workflowPath = ".github/workflows/sentiment-repair.yml";
const fail = code => { throw new Error(code); };
const sameWorkflow = run => run?.path?.split("@")[0] === workflowPath &&
  run.event === "workflow_dispatch" && run.head_branch === "main";

export function compatibleSourceTrees(left, right) {
  if (left?.truncated !== false || right?.truncated !== false || !Array.isArray(left.tree) || !Array.isArray(right.tree)) return false;
  const critical = entry => entry.type === "blob" && (/^(src|data)\//.test(entry.path) ||
    ["package.json", "package-lock.json", "scripts/sentiment-repair.js", "scripts/publish-sentiment-repair.js"].includes(entry.path));
  const signature = tree => JSON.stringify(tree.tree.filter(critical).map(row => [row.path, row.sha]).sort((a, b) => a[0].localeCompare(b[0])));
  return left.tree.some(critical) && signature(left) === signature(right);
}

export function isVerifiedRecovery(run, jobs, current) {
  if (!sameWorkflow(run) || run.status !== "completed" || run.conclusion !== "success" ||
      run.run_attempt !== 1 || run.head_sha !== current.head_sha || !/^Sentiment (?:recover|salvage) freeze=[1-9][0-9]* checkpoint=[1-9][0-9]*$/.test(run.display_title || "")) return false;
  if (!Array.isArray(jobs?.jobs) || !jobs.jobs.length || jobs.total_count > 100 || jobs.jobs.some(job => !Array.isArray(job.steps) || !job.steps.length)) return false;
  const steps = jobs.jobs.flatMap(job => job.steps);
  const completed = name => steps.some(step => step.name === name && step.conclusion === "success");
  const inference = steps.filter(step => ["Execute at most 25 frozen sentiment requests", "Execute authorized bounded continuation"].includes(step.name));
  return inference.length > 0 && inference.every(step => step.conclusion === "skipped") &&
    (run.display_title.startsWith("Sentiment salvage ")
      ? completed("Prepare authorized salvage checkpoint") && completed("Save inference checkpoint before publication") && completed("Publish verified sentiment repairs to existing Pages project") && completed("Read back exact published generated files")
      : completed("Verify recovered publication without inference") && completed("Save recovered checkpoint"));
}

export function validateRepairLineage({ current, freeze, runs, checkpointId = "", unresolvedRuns = [], mode = "drain", sourceCompatible = false, compatiblePriorSources = [freeze?.head_sha] }) {
  if (!sameWorkflow(current) || current.run_attempt !== 1 || current.status !== "in_progress") fail("current_run_not_fresh_manual_main");
  if (!sameWorkflow(freeze) || freeze.run_attempt !== 1 || freeze.status !== "completed" ||
      freeze.conclusion !== "success" || (freeze.head_sha !== current.head_sha && !sourceCompatible) ||
      freeze.display_title !== "Sentiment manifest freeze=new checkpoint=none" || freeze.run_number >= current.run_number) fail("invalid_freeze_run");
  const pattern = /^Sentiment (?:drain|recover|salvage|continue|retry) freeze=([1-9][0-9]*) checkpoint=(none|[1-9][0-9]*)$/;
  const lineage = runs.filter(run => {
    const match = pattern.exec(run.display_title || "");
    return sameWorkflow(run) && match?.[1] === String(freeze.id) && run.run_number < current.run_number;
  }).sort((left, right) => right.run_number - left.run_number);
  const latest = lineage[0];
  if (unresolvedRuns.some(run => sameWorkflow(run) && run.run_number < current.run_number &&
      !( ["recover", "salvage"].includes(mode) && run.id === latest?.id && String(run.id) === checkpointId))) fail("unresolved_inference_across_freezes_no_replay");
  if (!latest) {
    if (["recover", "salvage"].includes(mode)) fail("recovery_requires_prior_attempt");
    if (checkpointId) fail("unexpected_checkpoint");
    return { priorDrain: null };
  }
  if (String(latest.id) !== checkpointId) fail("latest_checkpoint_required");
  if ((latest.head_sha !== current.head_sha && !(sourceCompatible && compatiblePriorSources.includes(latest.head_sha))) || latest.run_attempt !== 1 || latest.status !== "completed") fail("prior_drain_unresolved_no_replay");
  if (["recover", "salvage"].includes(mode)) {
    if (!/^Sentiment (?:drain|continue|retry) /.test(latest.display_title) || latest.conclusion !== "failure") fail("recovery_requires_failed_drain");
  } else if (latest.conclusion !== "success") fail("prior_drain_unresolved_no_replay");
  return { priorDrain: latest.id };
}

async function main() {
  const env = process.env;
  if (env.GITHUB_REPOSITORY !== "oliverames/cerulean-news" || env.GITHUB_RUN_ATTEMPT !== "1" ||
      !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID || "") || !/^[1-9][0-9]*$/.test(env.FREEZE_RUN_ID || "") ||
      !/^(?:[1-9][0-9]*)?$/.test(env.CHECKPOINT_RUN_ID || "") || !env.GH_TOKEN) fail("invalid_lineage_environment");
  async function get(route, prefix = "actions/") {
    const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${prefix}${route}`, {
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      redirect: "error", signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) { await response.body?.cancel(); fail("github_lineage_read_failed"); }
    return response.json();
  }
  const current = await get(`runs/${env.GITHUB_RUN_ID}`);
  const freeze = await get(`runs/${env.FREEZE_RUN_ID}`);
  const sourceCompatible = current.head_sha === freeze.head_sha || compatibleSourceTrees(
    await get(`git/trees/${current.head_sha}?recursive=1`, ""), await get(`git/trees/${freeze.head_sha}?recursive=1`, ""));
  const runs = [];
  let complete = false;
  for (let page = 1; page <= 100; page += 1) {
    const result = await get(`workflows/sentiment-repair.yml/runs?event=workflow_dispatch&branch=main&per_page=100&page=${page}`);
    if (!Array.isArray(result.workflow_runs)) fail("invalid_lineage_history");
    runs.push(...result.workflow_runs);
    if (result.workflow_runs.length < 100 || runs.length >= result.total_count) { complete = true; break; }
  }
  if (!complete) fail("lineage_history_incomplete");
  const recoveries = [];
  const compatiblePriorSources = [freeze.head_sha, current.head_sha];
  for (const sha of new Set(runs.filter(run => run.run_number < current.run_number).map(run => run.head_sha))) {
    if (!compatiblePriorSources.includes(sha) && compatibleSourceTrees(await get(`git/trees/${sha}?recursive=1`, ""), await get(`git/trees/${freeze.head_sha}?recursive=1`, ""))) compatiblePriorSources.push(sha);
  }
  for (const run of runs.filter(run => run.run_number < current.run_number && /^Sentiment (?:recover|salvage) /.test(run.display_title || ""))) {
    if (compatiblePriorSources.includes(run.head_sha) && isVerifiedRecovery(run, await get(`runs/${run.id}/jobs?per_page=100`), { ...current, head_sha: run.head_sha })) recoveries.push(run);
  }
  const unresolvedRuns = [];
  for (const run of runs.filter(run => sameWorkflow(run) && run.run_number < current.run_number &&
    /^Sentiment (?:drain|continue|retry) freeze=[1-9][0-9]* checkpoint=(none|[1-9][0-9]*)$/.test(run.display_title || "") &&
    (run.conclusion !== "success" || run.run_attempt !== 1))) {
    const jobs = await get(`runs/${run.id}/jobs?per_page=100`);
    if (!Array.isArray(jobs.jobs) || !jobs.jobs.length || jobs.total_count > 100 ||
        jobs.jobs.some(job => !Array.isArray(job.steps) || !job.steps.length)) fail("incomplete_prior_attempt_evidence");
    // A failed test/input/preflight before the inference step spent nothing.
    // Any inference step that started is unresolved until its durable receipt
    // is explicitly reconciled; a fresh manifest cannot hide that attempt.
    const inferenceSteps = jobs.jobs.flatMap(job => job.steps || []).filter(step => ["Execute at most 25 frozen sentiment requests", "Execute authorized bounded continuation"].includes(step.name));
    if (!inferenceSteps.length) fail("incomplete_prior_attempt_evidence");
    const reconciled = recoveries.some(recovery => {
      const match = /^Sentiment (?:recover|salvage) freeze=([1-9][0-9]*) checkpoint=([1-9][0-9]*)$/.exec(recovery.display_title);
      const original = /^Sentiment (?:drain|continue|retry) freeze=([1-9][0-9]*) /.exec(run.display_title);
      return match[2] === String(run.id) && match[1] === original?.[1] && recovery.run_number > run.run_number;
    });
    if (!reconciled && (run.run_attempt !== 1 || inferenceSteps.some(step => step.conclusion !== "skipped" && (step.started_at || step.status === "completed")))) unresolvedRuns.push(run);
  }
  const mode = env.REPAIR_MODE || "drain";
  if (!["drain", "recover", "salvage", "continue", "retry"].includes(mode)) fail("invalid_lineage_mode");
  const result = validateRepairLineage({ current, freeze, runs, checkpointId: env.CHECKPOINT_RUN_ID || "", unresolvedRuns, mode, sourceCompatible, compatiblePriorSources });
  console.log(`Verified frozen run ${freeze.id}; previous drain ${result.priorDrain || "none"}; rerun/replay disabled.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
