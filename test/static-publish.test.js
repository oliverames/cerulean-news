import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Execute the workflow's real Bash, rather than a second implementation of
// its validators. Only the named YAML literal block is extracted here.
function reuseStepScript() {
  const lines = fs.readFileSync(new URL("../.github/workflows/publish-feed.yml", import.meta.url), "utf8").split("\n");
  const step = lines.findIndex((line) => /^\s*- name: Reuse live feed for static deploy\s*$/.test(line));
  assert.ok(step >= 0, "the static artifact reuse step exists");
  const stepIndent = lines[step].search(/\S/);
  let run = -1;
  for (let index = step + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && line.search(/\S/) <= stepIndent) break;
    if (/^\s*run: \|\s*$/.test(line)) { run = index; break; }
  }
  assert.ok(run >= 0, "the reuse step has a Bash literal block");
  const runIndent = lines[run].search(/\S/);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() && line.search(/\S/) <= runIndent) break;
    body.push(line);
  }
  const indent = Math.min(...body.filter((line) => line.trim()).map((line) => line.search(/\S/)));
  assert.ok(Number.isFinite(indent), "the reuse script is not empty");
  return body.map((line) => line.slice(indent)).join("\n");
}

const script = reuseStepScript();
const names = ["feed.json", "feed.rss", "digest.json", "digest.html", "storylines.json", "calendar.json", "calendar.ics", "alerts.json"];
const jsonNames = names.filter((name) => name.endsWith(".json"));

function artifacts(marker) {
  const html = `<!doctype html><html><body>${marker}</body></html>\n`;
  return {
    "feed.json": JSON.stringify({ items: [{ title: marker, link: "https://news.example/story" }] }) + "\n",
    "feed.rss": `<?xml version="1.0"?><rss version="2.0"><channel><title>${marker}</title></channel></rss>\n`,
    // Production digests contain sections, html and text, not a root items array.
    "digest.json": JSON.stringify({ sections: [{ title: marker, items: [] }], html, text: marker }) + "\n",
    "digest.html": html,
    "storylines.json": JSON.stringify({ storylines: [{ title: marker }] }) + "\n",
    "calendar.json": JSON.stringify({ events: [{ title: marker }] }) + "\n",
    "calendar.ics": `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:${marker}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`,
    "alerts.json": JSON.stringify({ count: 1, html, text: marker }) + "\n",
  };
}

const mockCurl = `#!/bin/bash
set -euo pipefail
url=""
output=""
while (( $# )); do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    --retry|--retry-delay|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[[ "$url" == "$LIVE_SITE_URL/"* && -n "$output" ]] || exit 64
name="$(basename "$url")"
printf '%s\\n' "$name" >> "$CURL_LOG"
if [[ "$name" == "$FAIL_ARTIFACT" ]]; then
  printf 'partial failed download' > "$output"
  exit 22
fi
cp "$FIXTURE_DIR/$name" "$output"
`;

function runReuse(t, { replace = {}, fail = "" } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cerulean-static-publish-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  for (const directory of ["bin", "fixtures", "site", "staging"]) fs.mkdirSync(path.join(cwd, directory));
  const fresh = { ...artifacts("fresh receiving artifact"), ...replace };
  const stale = artifacts("STALE_COMMITTED_SENTINEL");
  for (const name of names) {
    fs.writeFileSync(path.join(cwd, "fixtures", name), fresh[name]);
    fs.writeFileSync(path.join(cwd, "site", name), stale[name]);
  }
  fs.writeFileSync(path.join(cwd, "bin", "curl"), mockCurl, { mode: 0o755 });
  const log = path.join(cwd, "curl.log");
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", script], {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    env: {
      // No inherited credentials: every curl resolves
      // to the fixture copier above. jq and basic shell tools come from the OS.
      PATH: `${path.join(cwd, "bin")}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      TMPDIR: path.join(cwd, "staging"),
      LIVE_SITE_URL: "https://static-artifacts.invalid",
      FIXTURE_DIR: path.join(cwd, "fixtures"),
      CURL_LOG: log,
      FAIL_ARTIFACT: fail,
    },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  const attempted = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];
  assert.deepEqual(fs.readdirSync(path.join(cwd, "staging")), [], "the temporary staging directory is cleaned up");
  return { result, attempted, fresh, stale, read: (name) => fs.readFileSync(path.join(cwd, "site", name)) };
}

function assertStoppedAt(run, failedName) {
  assert.notEqual(run.result.status, 0, `invalid ${failedName} must fail the step instead of deploying a stale copy`);
  const failedIndex = names.indexOf(failedName);
  assert.deepEqual(run.attempted, names.slice(0, failedIndex + 1), "no later artifact is fetched after a rejection");
  for (const name of names.slice(failedIndex)) {
    assert.deepEqual(run.read(name), Buffer.from(run.stale[name]), `${name}: failed and later files retain their exact sentinel bytes`);
  }
  // Earlier validated files may have moved already, but failure prevents the
  // deployment step. The invalid/partial download itself is never published.
  for (const name of names.slice(0, failedIndex)) {
    assert.deepEqual(run.read(name), Buffer.from(run.fresh[name]), `${name}: earlier validated file was copied exactly`);
  }
}

test("static publishing copies all eight live artifacts exactly, including a sections-based digest", (t) => {
  const run = runReuse(t);
  assert.equal(run.result.status, 0, run.result.stderr);
  assert.deepEqual(run.attempted, names, "all established generated artifacts are required");
  assert.equal(Object.hasOwn(JSON.parse(run.fresh["digest.json"]), "items"), false);
  for (const name of names) assert.deepEqual(run.read(name), Buffer.from(run.fresh[name]), name);
});

test("every one of the eight required downloads fails closed, even with a valid stale copy present", async (t) => {
  for (const fail of names) {
    await t.test(fail, (t) => assertStoppedAt(runReuse(t, { fail }), fail));
  }
});

test("HTML masquerading as any JSON artifact is rejected before replacing its stale copy", async (t) => {
  for (const name of jsonNames) {
    await t.test(name, (t) => assertStoppedAt(runReuse(t, { replace: { [name]: "<!doctype html><html>upstream error</html>\n" } }), name));
  }
});

test("malformed JSON is rejected for every JSON artifact", async (t) => {
  for (const name of jsonNames) {
    await t.test(name, (t) => assertStoppedAt(runReuse(t, { replace: { [name]: '{"truncated":' } }), name));
  }
});

test("valid JSON with the wrong generated-artifact schema is rejected", async (t) => {
  const invalid = {
    "feed.json": { items: {} },
    "digest.json": { items: [], html: "legacy wrong shape", text: "no sections" },
    "storylines.json": { storylines: null },
    "calendar.json": { events: "not an array" },
    "alerts.json": { count: "1", html: "", text: "" },
  };
  for (const [name, body] of Object.entries(invalid)) {
    await t.test(name, (t) => assertStoppedAt(runReuse(t, { replace: { [name]: JSON.stringify(body) } }), name));
  }
});

test("digest and alert text representations are required, not just their array/count field", async (t) => {
  for (const name of ["digest.json", "alerts.json"]) {
    for (const field of ["html", "text"]) {
      await t.test(`${name} missing ${field}`, (t) => {
        const body = JSON.parse(artifacts("fixture")[name]);
        delete body[field];
        assertStoppedAt(runReuse(t, { replace: { [name]: JSON.stringify(body) } }), name);
      });
    }
  }
});

test("truncated RSS, digest HTML and calendar exports are rejected", async (t) => {
  for (const [name, body] of Object.entries({
    "feed.rss": '<?xml version="1.0"?><rss><channel>truncated',
    "digest.html": "<!doctype html><html><body>truncated",
    "calendar.ics": "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n",
  })) {
    await t.test(name, (t) => assertStoppedAt(runReuse(t, { replace: { [name]: body } }), name));
  }
});
