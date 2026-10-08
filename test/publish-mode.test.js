import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/publish-mode.sh", import.meta.url));
const env = { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
async function git(root, ...args) {
  return (await execFileAsync("git", args, { cwd: root, env })).stdout.trim();
}
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "cerulean-publish-mode-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "--quiet");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/index.js"), "original runtime\n");
  await writeFile(path.join(root, "README.md"), "original docs\n");
  await git(root, "add", ".");
  await git(root, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Initial fixture");
  return { root, before: await git(root, "rev-parse", "HEAD") };
}
async function change(root, file, message = "Update fixture") {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), `changed ${file}\n`);
  await git(root, "add", "--", file);
  await git(root, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", message);
  return git(root, "rev-parse", "HEAD");
}
async function mode(root, event, before, sha) {
  const result = await execFileAsync("bash", [script, event, before, sha], { cwd: root, env });
  assert.match(result.stdout, /^full=(true|false)\n$/, "stdout contains only a single workflow output");
  return result.stdout.trim();
}

test("runtime changes use full generation unless the pushed tip explicitly requests static publication", async (t) => {
  const { root, before } = await fixture(t);
  const normal = await change(root, "src/index.js");
  assert.equal(await mode(root, "push", before, normal), "full=true");
  const explicit = await change(root, "src/second.js", "Release reviewed source\n\nPublish-Mode: static");
  assert.equal(await mode(root, "push", before, explicit), "full=false");
});

test("static reader and documentation changes reuse the published feed", async (t) => {
  const { root, before } = await fixture(t);
  const docs = await change(root, "README.md");
  assert.equal(await mode(root, "push", before, docs), "full=false");
  const reader = await change(root, "site/index.html");
  assert.equal(await mode(root, "push", before, reader), "full=false");
});

test("a real merge commit's static trailer covers its source changes", async (t) => {
  const { root, before } = await fixture(t);
  const baseBranch = await git(root, "branch", "--show-current");
  await git(root, "checkout", "--quiet", "-b", "reviewed-change");
  await change(root, "src/index.js");
  await git(root, "checkout", "--quiet", baseBranch);
  await git(root, "-c", "commit.gpgsign=false", "merge", "--quiet", "--no-ff", "reviewed-change", "-m", "Merge reviewed change\n\nPublish-Mode: static");
  const sha = await git(root, "rev-parse", "HEAD");
  assert.equal((await git(root, "show", "-s", "--format=%P", sha)).split(" ").length, 2);
  assert.equal(await mode(root, "push", before, sha), "full=false");
});

test("schedule and manual dispatch always generate even when the commit has a static trailer", async (t) => {
  const { root, before } = await fixture(t);
  const sha = await change(root, "src/index.js", "Release\n\nPublish-Mode: static");
  for (const event of ["schedule", "workflow_dispatch", ""]) {
    assert.equal(await mode(root, event, before, sha), "full=true");
    assert.equal(await mode(root, event, "", sha), "full=true");
  }
});

test("invalid or missing comparison objects fail to full generation even with a static trailer", async (t) => {
  const { root, before } = await fixture(t);
  const sha = await change(root, "src/index.js", "Release\n\nPublish-Mode: static");
  const blob = await git(root, "rev-parse", `${sha}:src/index.js`);
  for (const invalid of ["", "0".repeat(40), "f".repeat(40), "--help", blob]) {
    assert.equal(await mode(root, "push", invalid, sha), "full=true");
    assert.equal(await mode(root, "push", before, invalid), "full=true");
  }
});

test("an empty comparison preserves full generation", async (t) => {
  const { root, before } = await fixture(t);
  assert.equal(await mode(root, "push", before, before), "full=true");
  await git(root, "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "Empty release\n\nPublish-Mode: static");
  assert.equal(await mode(root, "push", before, await git(root, "rev-parse", "HEAD")), "full=true");
});

test("valid but divergent comparison commits fail to full generation", async (t) => {
  const { root, before } = await fixture(t);
  const sha = await change(root, "src/index.js", "Release\n\nPublish-Mode: static");
  await git(root, "checkout", "--quiet", "-b", "divergent", before);
  const divergent = await change(root, "README.md");
  assert.equal(await mode(root, "push", divergent, sha), "full=true");
});

test("only the pushed tip's trailer overrides the entire multi-commit range", async (t) => {
  const { root, before } = await fixture(t);
  const earlier = await change(root, "src/index.js", "Earlier commit\n\nPublish-Mode: static");
  const head = await change(root, "README.md", "Later docs only");
  assert.equal(await mode(root, "push", before, head), "full=true");
  assert.equal(await mode(root, "push", earlier, head), "full=false");
});

test("subject or prose mentions of static publication do not count as a trailer", async (t) => {
  for (const message of [
    "Publish-Mode: static",
    "Discuss release\n\nPublish-Mode: static\nThis is prose rather than a trailer block.",
    "Discuss Publish-Mode: static in the release instructions",
  ]) {
    const { root, before } = await fixture(t);
    const sha = await change(root, "src/index.js", message);
    assert.equal(await mode(root, "push", before, sha), "full=true");
  }
});

test("conflicting, repeated or malformed mode trailers choose full generation", async (t) => {
  for (const trailer of [
    "Publish-Mode: static\nPublish-Mode: full",
    "Publish-Mode: static\nPublish-Mode: static",
    "Publish-Mode: Static",
    "Publish-Mode: static extra",
  ]) {
    const { root, before } = await fixture(t);
    const sha = await change(root, "README.md", `Docs release\n\n${trailer}`);
    assert.equal(await mode(root, "push", before, sha), "full=true");
  }
});

test("runtime renames and unusual runtime filenames cannot hide source changes", async (t) => {
  const { root, before } = await fixture(t);
  await mkdir(path.join(root, "docs"));
  await git(root, "mv", "src/index.js", "docs/former-runtime.txt");
  await git(root, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "Move runtime into docs");
  assert.equal(await mode(root, "push", before, await git(root, "rev-parse", "HEAD")), "full=true");
  const unusual = await change(root, "src/new\nname.js");
  assert.equal(await mode(root, "push", await git(root, "rev-parse", "HEAD^"), unusual), "full=true");
});

test("generation inputs and the mode helper itself default to full generation", async (t) => {
  for (const file of ["test/new.test.js", "data/source.json", "certs/new.pem", "package.json", "package-lock.json",
    ".github/workflows/publish-feed.yml", "scripts/publish-mode.sh"]) {
    const { root, before } = await fixture(t);
    const sha = await change(root, file);
    assert.equal(await mode(root, "push", before, sha), "full=true", file);
  }
});

test("commit message shell syntax stays data and cannot change the output", async (t) => {
  const { root, before } = await fixture(t);
  const sha = await change(root, "src/index.js", "Release $(touch injected) `touch injected-too`\n\nPublish-Mode: static");
  assert.equal(await mode(root, "push", before, sha), "full=false");
  await assert.rejects(readFile(path.join(root, "injected")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(root, "injected-too")), { code: "ENOENT" });
});
