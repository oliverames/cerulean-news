import test from "node:test";
import assert from "node:assert/strict";
import { validateRepairLineage, compatibleSourceTrees, isVerifiedRecovery } from "../scripts/sentiment-lineage.js";

const base = { path: ".github/workflows/sentiment-repair.yml", event: "workflow_dispatch", head_branch: "main", head_sha: "a".repeat(40), run_attempt: 1 };
const freeze = { ...base, id: 10, run_number: 1, status: "completed", conclusion: "success", display_title: "Sentiment manifest freeze=new checkpoint=none" };
const current = { ...base, id: 30, run_number: 3, status: "in_progress", display_title: "Sentiment drain freeze=10 checkpoint=20" };
const prior = { ...base, id: 20, run_number: 2, status: "completed", conclusion: "success", display_title: "Sentiment drain freeze=10 checkpoint=none" };
const validate = (overrides = {}) => validateRepairLineage({ current, freeze, runs: [], ...overrides });

test("first drain requires no previous attempt", () => assert.deepEqual(validate(), { priorDrain: null }));
test("continuation requires the latest successful checkpoint", () => assert.deepEqual(validate({ runs: [prior], checkpointId: "20" }), { priorDrain: 20 }));
test("empty checkpoint cannot replay any prior drain", () => assert.throws(() => validate({ runs: [prior] }), /latest_checkpoint_required/));
test("an older receipt cannot replay more recent attempts", () => assert.throws(() => validate({ runs: [prior, { ...prior, id: 21, run_number: 2.5 }], checkpointId: "20" }), /latest_checkpoint_required/));
for (const state of ["cancelled", "failure", "timed_out", "action_required", null]) {
  test(`a ${state} prior run blocks continuation`, () => assert.throws(() => validate({ runs: [{ ...prior, conclusion: state }], checkpointId: "20" }), /prior_drain_unresolved_no_replay/));
}
test("an active prior run blocks continuation", () => assert.throws(() => validate({ runs: [{ ...prior, status: "in_progress" }], checkpointId: "20" }), /prior_drain_unresolved_no_replay/));
test("rerun of current job blocks inference", () => assert.throws(() => validate({ current: { ...current, run_attempt: 2 } }), /current_run_not_fresh_manual_main/));
test("rerun of prior job blocks inference", () => assert.throws(() => validate({ runs: [{ ...prior, run_attempt: 2 }], checkpointId: "20" }), /prior_drain_unresolved_no_replay/));
test("freeze must be successful manifest from same source on main", () => {
  for (const changes of [{ conclusion: "failure" }, { head_sha: "b".repeat(40) }, { event: "push" }, { head_branch: "feature" }, { path: ".github/workflows/publish-feed.yml" }, { display_title: prior.display_title }]) {
    assert.throws(() => validate({ freeze: { ...freeze, ...changes } }), /invalid_freeze_run/);
  }
});
test("other freezes and future queued runs do not affect the current lineage", () => assert.deepEqual(validate({ runs: [{ ...prior, display_title: "Sentiment drain freeze=11 checkpoint=none" }, { ...prior, run_number: 4 }] }), { priorDrain: null }));
test("invented checkpoint fails first drain", () => assert.throws(() => validate({ checkpointId: "99" }), /unexpected_checkpoint/));
test("a new freeze cannot hide unresolved inference in another freeze", () => assert.throws(() => validate({ unresolvedRuns: [{ ...prior, display_title: "Sentiment drain freeze=9 checkpoint=none", conclusion: "cancelled" }] }), /unresolved_inference_across_freezes_no_replay/));
test("a failed pre-inference check does not create an unresolved inference", () => assert.deepEqual(validate({ unresolvedRuns: [] }), { priorDrain: null }));

test("recovery accepts only the latest completed failed attempt, without waiving other unresolved runs", () => {
  const failed = { ...prior, conclusion: "failure" };
  assert.deepEqual(validate({ mode: "recover", runs: [failed], checkpointId: "20", unresolvedRuns: [failed] }), { priorDrain: 20 });
  assert.throws(() => validate({ mode: "recover", runs: [prior], checkpointId: "20" }), /recovery_requires_failed_drain/);
  assert.throws(() => validate({ mode: "recover" }), /recovery_requires_prior_attempt/);
  assert.throws(() => validate({ mode: "recover", runs: [failed], checkpointId: "20", unresolvedRuns: [failed, { ...failed, id: 19 }] }), /unresolved_inference_across_freezes/);
});
test("source migration requires unchanged complete request-critical trees", () => {
  const tree = { truncated: false, tree: [{ type: "blob", path: "src/rubrics/sentiment-v2.json", sha: "one" }, { type: "blob", path: ".github/workflows/sentiment-repair.yml", sha: "old" }] };
  assert.ok(compatibleSourceTrees(tree, { ...tree, tree: [tree.tree[0], { ...tree.tree[1], sha: "new" }] }));
  assert.equal(compatibleSourceTrees(tree, { ...tree, truncated: true }), false);
  assert.equal(compatibleSourceTrees(tree, { ...tree, tree: [{ ...tree.tree[0], sha: "changed" }] }), false);
  const migrated = { ...current, head_sha: "b".repeat(40) };
  assert.deepEqual(validate({ current: migrated, sourceCompatible: true }), { priorDrain: null });
  assert.throws(() => validate({ current: migrated }), /invalid_freeze_run/);
});
test("successful recovery evidence requires skipped inference and completed verification/checkpoint at current source", () => {
  const recovery = { ...prior, display_title: "Sentiment recover freeze=10 checkpoint=19" };
  const jobs = { total_count: 1, jobs: [{ steps: [
    { name: "Execute at most 25 frozen sentiment requests", conclusion: "skipped" },
    { name: "Verify recovered publication without inference", conclusion: "success" },
    { name: "Save recovered checkpoint", conclusion: "success" },
  ] }] };
  assert.ok(isVerifiedRecovery(recovery, jobs, current));
  assert.equal(isVerifiedRecovery(recovery, { ...jobs, jobs: [{ steps: jobs.jobs[0].steps.slice(1) }] }, current), false);
  assert.equal(isVerifiedRecovery({ ...recovery, run_attempt: 2 }, jobs, current), false);
  assert.equal(isVerifiedRecovery({ ...recovery, head_sha: "b".repeat(40) }, jobs, current), false);
  assert.equal(isVerifiedRecovery(recovery, { ...jobs, jobs: [{ steps: jobs.jobs[0].steps.map(step => ({ ...step, conclusion: "success" })) }] }, current), false);
});
test("authorized salvage accepts its latest failure and requires complete no-inference publication evidence", () => {
  const failed = { ...prior, conclusion: "failure" };
  assert.deepEqual(validate({ mode: "salvage", runs: [failed], checkpointId: "20", unresolvedRuns: [failed] }), { priorDrain: 20 });
  const salvage = { ...prior, display_title: "Sentiment salvage freeze=10 checkpoint=19" };
  const names = ["Prepare authorized salvage checkpoint", "Save inference checkpoint before publication", "Publish verified sentiment repairs to existing Pages project", "Read back exact published generated files"];
  const jobs = { total_count: 1, jobs: [{ steps: [
    { name: "Execute at most 25 frozen sentiment requests", conclusion: "skipped" },
    { name: "Execute authorized bounded continuation", conclusion: "skipped" },
    ...names.map(name => ({ name, conclusion: "success" })),
  ] }] };
  assert.ok(isVerifiedRecovery(salvage, jobs, current));
  assert.equal(isVerifiedRecovery(salvage, { ...jobs, jobs: [{ steps: jobs.jobs[0].steps.slice(0, -1) }] }, current), false);
});
