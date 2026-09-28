import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { generateFeed } from "../src/index.js";
import { webhookTargetId } from "../src/alerts.js";
import {
  BRAND_ALERT_MAX_KEYS,
  brandAlertKey,
  buildBrandAlertMessage,
  emailAlertsDocument,
  nextEmailAlertBatch,
  normalizeBrandAlertState,
  renderBrandAlertEmail,
  sendBrandAlerts,
} from "../src/brand-alerts.js";

const SLACK_URL = "https://hooks.example/slack";
const DISCORD_URL = "https://hooks.example/discord";
const NOW = new Date("2026-09-28T16:00:00Z");

function archiveItem(slug, overrides = {}) {
  return {
    title: `Blue Cross VT story ${slug}`,
    link: `https://vtdigger.org/2026/09/28/${slug}`,
    guid: `https://vtdigger.org/2026/09/28/${slug}`,
    sourceName: "VTDigger",
    matchedTerms: ["BCBSVT"],
    pubDate: "2026-09-28T12:00:00.000Z",
    summary: `Summary of ${slug}.`,
    reason: "Names BCBSVT directly",
    relevant: true,
    sentiment: "neutral",
    sentimentScore: 50,
    ...overrides,
  };
}

// Items shaped like the generator's in-memory items, for the pure tests.
function liveItem(slug, overrides = {}) {
  return {
    ...archiveItem(slug),
    pubDate: new Date("2026-09-28T12:00:00Z"),
    ...overrides,
  };
}

async function withEnv(values, callback) {
  const saved = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    return await callback();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

// Records every webhook POST. `respond` can fail chosen endpoints.
async function withWebhookFetch(callback, respond = () => 204) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const posts = [];
  globalThis.fetch = async (url, init) => {
    const status = respond(String(url));
    posts.push({ url: String(url), body: JSON.parse(init.body) });
    if (status === "throw") {
      throw new Error("network down");
    }
    return new Response(null, { status });
  };
  console.log = () => {};
  console.error = () => {};
  try {
    return await callback(posts);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
  }
}

async function auditWorkspace(items) {
  const workdir = await mkdtemp(path.join(tmpdir(), "vt-news-brand-alerts-"));
  const paths = {
    rssOutputPath: path.join(workdir, "feed.rss"),
    jsonOutputPath: path.join(workdir, "feed.json"),
    auditJsonOutputPath: path.join(workdir, "feed-audit.json"),
  };
  await writeFile(
    paths.auditJsonOutputPath,
    JSON.stringify({ generatedAt: "2026-09-28T10:00:00.000Z", items }),
  );
  const run = (now = NOW) => generateFeed({ sources: [], now, ...paths });
  const readAudit = async () =>
    JSON.parse(await readFile(paths.auditJsonOutputPath, "utf8"));
  // Adds coverage to the audit the way a later crawl would, keeping the state
  // the previous run wrote.
  const addItems = async (...added) => {
    const audit = await readAudit();
    audit.items.push(...added);
    await writeFile(paths.auditJsonOutputPath, JSON.stringify(audit));
  };
  const readEmailAlerts = async () =>
    JSON.parse(await readFile(path.join(workdir, "alerts.json"), "utf8"));
  return { run, readAudit, addItems, readEmailAlerts };
}

const ON = {
  BRAND_ALERTS: "on",
  SLACK_WEBHOOK_URL: SLACK_URL,
  DISCORD_WEBHOOK_URL: undefined,
};

test("the first run seeds every current item and sends nothing", async () => {
  const workspace = await auditWorkspace([
    archiveItem("one"),
    archiveItem("two", { sentiment: "negative", sentimentScore: 12 }),
  ]);
  await withEnv(ON, () =>
    withWebhookFetch(async (posts) => {
      await workspace.run();
      assert.equal(posts.length, 0, "the first run must not alert on existing coverage");
      const state = (await workspace.readAudit()).crawlState.brandAlerts;
      assert.equal(state.seeded, true);
      for (const slug of ["one", "two"]) {
        assert.ok(
          state.keys.includes(
            brandAlertKey({ guid: `https://vtdigger.org/2026/09/28/${slug}` }),
          ),
          `${slug} should be recorded as already alerted`,
        );
      }
    }),
  );
});

test("no story alerts twice across two runs through the audit", async () => {
  const workspace = await auditWorkspace([archiveItem("old")]);
  await withEnv(ON, () =>
    withWebhookFetch(async (posts) => {
      await workspace.run();
      assert.equal(posts.length, 0);

      await workspace.addItems(
        archiveItem("fresh", { title: "Fresh coverage of Blue Cross VT" }),
      );
      await workspace.run();
      assert.equal(posts.length, 1, "the new story alerts once");
      assert.equal(posts[0].url, SLACK_URL);
      assert.match(posts[0].body.text, /Fresh coverage of Blue Cross VT/);
      assert.doesNotMatch(posts[0].body.text, /story old/);

      await workspace.run();
      assert.equal(posts.length, 1, "the same story must not alert again");

      const audit = await workspace.readAudit();
      assert.ok(
        audit.crawlState.brandAlerts.keys.includes(
          brandAlertKey({ guid: "https://vtdigger.org/2026/09/28/fresh" }),
        ),
      );
      // Endpoint URLs never reach the audit.
      assert.doesNotMatch(
        JSON.stringify(audit.crawlState.brandAlerts),
        /hooks\.example/,
      );
    }),
  );
});

test("an unset or off BRAND_ALERTS sends nothing and still records coverage", async () => {
  for (const value of [undefined, "off"]) {
    const workspace = await auditWorkspace([archiveItem("old")]);
    await withEnv({ ...ON, BRAND_ALERTS: value }, () =>
      withWebhookFetch(async (posts) => {
        await workspace.run();
        await workspace.addItems(archiveItem("fresh"));
        await workspace.run();
        assert.equal(posts.length, 0, `BRAND_ALERTS=${value} must not post`);
        const state = (await workspace.readAudit()).crawlState.brandAlerts;
        assert.ok(
          state.keys.includes(
            brandAlertKey({ guid: "https://vtdigger.org/2026/09/28/fresh" }),
          ),
          "recording while off keeps a later switch-on from flooding",
        );
      }),
    );
  }
});

test("items that are not relevant brand press coverage never alert", async () => {
  const workspace = await auditWorkspace([archiveItem("old")]);
  await withEnv(ON, () =>
    withWebhookFetch(async (posts) => {
      await workspace.run();
      await workspace.addItems(
        archiveItem("rejected", { relevant: false }),
        archiveItem("topic", { matchedTerms: ["Vermont hospital"] }),
        archiveItem("own-post", {
          sourceName: "Blue Cross VT",
          link: "https://www.bluecrossvt.org/news/own-post",
          guid: "https://www.bluecrossvt.org/news/own-post",
        }),
      );
      await workspace.run();
      assert.equal(posts.length, 0);
    }),
  );
});

test("delivery failures never fail the run and retry only the failed endpoint", async () => {
  const workspace = await auditWorkspace([archiveItem("old")]);
  const env = { ...ON, DISCORD_WEBHOOK_URL: DISCORD_URL };
  let discordDown = true;
  await withEnv(env, () =>
    withWebhookFetch(
      async (posts) => {
        await workspace.run();
        await workspace.addItems(archiveItem("fresh", { title: "Retry me" }));
        await workspace.run();
        assert.equal(posts.length, 2, "both endpoints were tried");
        assert.deepEqual(
          Object.keys((await workspace.readAudit()).crawlState.brandAlerts.undelivered),
          [webhookTargetId(DISCORD_URL)],
        );

        // Discord recovers. Only Discord gets the alert on the next run.
        posts.length = 0;
        discordDown = false;
        await workspace.run();
        assert.deepEqual(posts.map((post) => post.url), [DISCORD_URL]);
        assert.match(posts[0].body.content, /Retry me/);
        assert.deepEqual(
          (await workspace.readAudit()).crawlState.brandAlerts.undelivered,
          {},
        );

        posts.length = 0;
        await workspace.run();
        assert.equal(posts.length, 0);
      },
      (url) => (url === DISCORD_URL && discordDown ? "throw" : 204),
    ),
  );
});

test("priority stories lead the message and are marked", () => {
  const items = [
    liveItem("calm", { sentiment: "positive", sentimentScore: 90 }),
    liveItem("mixed", { sentiment: "neutral", sentimentScore: 50 }),
    liveItem("negative", { sentiment: "negative", sentimentScore: 20 }),
    liveItem("leaning", { sentiment: "neutral to negative", sentimentScore: 40 }),
    liveItem("low-score", { sentiment: "neutral", sentimentScore: 34 }),
    liveItem("edge", { sentiment: "neutral", sentimentScore: 35 }),
  ];
  for (const format of ["slack", "discord"]) {
    const message = buildBrandAlertMessage(items, { format, maxCharacters: 100000 });
    const position = (slug) => message.indexOf(`story ${slug}`);
    for (const slug of ["negative", "leaning", "low-score"]) {
      for (const other of ["calm", "mixed", "edge"]) {
        assert.ok(position(slug) < position(other), `${slug} leads ${other}`);
      }
    }
    assert.equal(message.match(/PRIORITY/g).length, 3);
    assert.match(message, /3 flagged unfavorable/);
    // Headline link, outlet, label with score, and summary all present.
    assert.match(message, /VTDigger, negative \(score 20\)\. Summary of negative\./);
  }
  const slack = buildBrandAlertMessage(items, { format: "slack" });
  assert.match(
    slack,
    /<https:\/\/vtdigger\.org\/2026\/09\/28\/negative\|Blue Cross VT story negative>/,
  );
  const discord = buildBrandAlertMessage(items, { format: "discord" });
  assert.match(
    discord,
    /\[Blue Cross VT story negative\]\(https:\/\/vtdigger\.org\/2026\/09\/28\/negative\)/,
  );
});

test("one message lists at most ten stories and counts the rest", () => {
  const items = Array.from({ length: 13 }, (_, index) => liveItem(`s${index}`));
  const message = buildBrandAlertMessage(items, {
    format: "slack",
    maxCharacters: 100000,
  });
  assert.equal(message.match(/<https:/g).length, 10);
  assert.match(message, /^\+3 more$/m);
  assert.match(message, /13 new stories name Blue Cross VT/);

  // Discord's 2,000-character limit shrinks the list further, never overflows.
  const long = items.map((item, index) => ({
    ...item,
    summary: "A long summary sentence about premiums and coverage. ".repeat(6),
    link: `https://vtdigger.org/2026/09/28/${"a-long-slug-".repeat(6)}${index}`,
  }));
  const discord = buildBrandAlertMessage(long, { format: "discord" });
  assert.ok(discord.length <= 1900, `discord message was ${discord.length} characters`);
  assert.match(discord, /^\+\d+ more$/m);
});

test("email output escapes scraped text and stays script-free", () => {
  const hostile = liveItem("evil", {
    title: '<script>alert(1)</script> "quoted" & <b>bold</b>',
    link: "javascript:alert(1)",
    outlet: "<img src=x onerror=alert(1)>",
    summary: "<iframe src=//evil></iframe> Rates rise.",
    sentiment: "negative",
    sentimentScore: 10,
  });
  const linked = liveItem("linked", {
    title: "Fine story",
    link: 'https://vtdigger.org/a?x="onmouseover="alert(1)&y=2',
    sentiment: "positive",
    sentimentScore: 80,
  });
  const { subject, html, text } = renderBrandAlertEmail([linked, hostile], {
    now: NOW,
  });

  assert.doesNotMatch(subject, /[\r\n<>]/);
  assert.match(subject, /2 new stories, 1 unfavorable/);
  assert.doesNotMatch(html, /<script|<iframe|<img|<style|javascript:|<b>/i);
  assert.doesNotMatch(html, /href="[^"]*"onmouseover/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt; &quot;quoted&quot; &amp;/);
  assert.match(html, /<table/);
  assert.match(html, /style="/);
  assert.match(html, /Monday, September 28, 2026/);
  // The priority story leads even though it was passed second.
  assert.ok(html.indexOf("PRIORITY") < html.indexOf("Fine story"));
  // The unsafe scheme is dropped, the http link is kept and escaped.
  assert.match(html, /href="https:\/\/vtdigger\.org\/a\?x=%22onmouseover=%22alert\(1\)&amp;y=2"/);
  assert.match(text, /\[PRIORITY: UNFAVORABLE\]/);
  assert.doesNotMatch(text, /javascript:/);
});

test("the stored alert set stays bounded to the newest keys", async () => {
  const keys = Array.from({ length: BRAND_ALERT_MAX_KEYS + 500 }, (_, i) => `k${i}`);
  const state = normalizeBrandAlertState({ keys });
  assert.equal(state.keys.length, BRAND_ALERT_MAX_KEYS);
  assert.equal(state.keys.at(-1), `k${BRAND_ALERT_MAX_KEYS + 499}`);
  assert.equal(state.keys[0], "k500");
  assert.equal(normalizeBrandAlertState({}).seeded, false);
  assert.equal(normalizeBrandAlertState({ keys: [] }).seeded, true);

  const crawlState = { brandAlerts: normalizeBrandAlertState({ keys }) };
  const items = Array.from({ length: 30 }, (_, i) => liveItem(`n${i}`));
  await withWebhookFetch(async () => {
    await sendBrandAlerts(items, crawlState, {
      env: { BRAND_ALERTS: "on" },
      targets: [],
    });
  });
  assert.equal(crawlState.brandAlerts.keys.length, BRAND_ALERT_MAX_KEYS);
});

test("alerts.json publishes new coverage for the mail Worker, even with webhooks off", async () => {
  const workspace = await auditWorkspace([archiveItem("old")]);
  await withEnv({ ...ON, BRAND_ALERTS: undefined }, () =>
    withWebhookFetch(async (posts) => {
      await workspace.run();
      assert.equal((await workspace.readEmailAlerts()).count, 0, "seeding publishes nothing");

      await workspace.addItems(archiveItem("fresh", { title: "Fresh coverage of Blue Cross VT" }));
      await workspace.run();
      const batch = await workspace.readEmailAlerts();
      assert.equal(posts.length, 0, "BRAND_ALERTS governs only the webhooks");
      assert.equal(batch.count, 1);
      assert.match(batch.id, /^2026-09-28T16:00-1-/);
      assert.match(batch.subject, /1 new story/);
      assert.match(batch.html, /Fresh coverage of Blue Cross VT/);
      assert.match(batch.text, /Fresh coverage of Blue Cross VT/);
      // The Worker appends the disclaimer and the unsubscribe links.
      assert.doesNotMatch(batch.html, /affiliated|unsubscribe/i);

      // A later run with nothing new keeps the batch, so the Worker still sees it.
      await workspace.run(new Date("2026-09-28T19:00:00Z"));
      assert.equal((await workspace.readEmailAlerts()).id, batch.id);

      // Past the Worker's 12-hour limit the file empties.
      await workspace.run(new Date("2026-09-29T05:00:00Z"));
      assert.equal((await workspace.readEmailAlerts()).count, 0);
    }),
  );
});

test("a batch younger than the Worker's check interval is folded into the next", () => {
  const candidates = new Map(
    ["a", "b", "c"].map((slug) => [brandAlertKey(liveItem(slug)), liveItem(slug)]),
  );
  const [a, b, c] = [...candidates.keys()];
  const first = nextEmailAlertBatch(null, [a], candidates, { now: NOW });
  assert.equal(first.count, 1);

  const soon = nextEmailAlertBatch(first, [b], candidates, {
    now: new Date(NOW.getTime() + 10 * 60000),
  });
  assert.deepEqual(soon.keys, [a, b]);
  assert.notEqual(soon.id, first.id);

  const later = nextEmailAlertBatch(soon, [c], candidates, {
    now: new Date(NOW.getTime() + 3 * 3600000),
  });
  assert.deepEqual(later.keys, [c]);
  assert.equal(nextEmailAlertBatch(later, [], candidates, { now: NOW }).id, later.id);
});

test("the alerts document matches the mail Worker's contract", () => {
  const candidates = new Map([[brandAlertKey(liveItem("a")), liveItem("a")]]);
  const batch = nextEmailAlertBatch(null, [...candidates.keys()], candidates, { now: NOW });
  const document = emailAlertsDocument(batch, { now: NOW });
  assert.deepEqual(Object.keys(document).sort(), ["count", "generatedAt", "html", "id", "subject", "text"]);
  assert.equal(document.count, 1);
  assert.equal(emailAlertsDocument(null, { now: NOW }).count, 0);
  // The batch survives the audit round trip.
  const restored = normalizeBrandAlertState({ keys: [], emailBatch: batch });
  assert.equal(restored.emailBatch.id, batch.id);
  assert.equal(normalizeBrandAlertState({ keys: [], emailBatch: { id: "" } }).emailBatch, undefined);
});
