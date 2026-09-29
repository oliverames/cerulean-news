// Tests for the email subscription Worker in mail/. D1 is an in-memory SQLite
// database (node:sqlite) behind the same prepare/bind/first/all/run/batch
// surface, and it runs the real migration, so the SQL is exercised as written.
// EMAIL and fetch are fakes. Nothing here touches the network or Cloudflare.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  CRON_ALERTS,
  CRON_DIGEST,
  CRON_MONTHLY,
  DISCLAIMER,
  LIST_IDS,
  classifySendError,
  deliverList,
  handleRequest,
  hashIp,
  makeContext,
  needsCatchUp,
  normalizeEmail,
  normalizeLists,
  parseAlerts,
  parseDigest,
  parseMonthly,
  runList,
  runScheduled,
  settings,
  signToken,
  verifyToken,
} from "../mail/worker.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  // Node older than 22.5. The database tests skip; the pure tests still run.
}
const needsSqlite = DatabaseSync ? {} : { skip: "node:sqlite needs Node 22.5 or newer" };

// Every migration in order, the way `wrangler d1 migrations apply` runs them.
const MIGRATION = readdirSync(new URL("../mail/migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(new URL(`../mail/migrations/${name}`, import.meta.url), "utf8"))
  .join("\n");
const SECRET = "test-secret-with-plenty-of-length-0123456789";
const SITE = "https://cerulean.news";
const API = `${SITE}/api/mail`;
const T0 = Date.parse("2026-09-29T11:05:00Z");

// --------------------------------------------------------------------- fakes

function createD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(MIGRATION);
  const clean = (params) => params.map((value) => (value === undefined ? null : value));
  class Statement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...params) {
      return new Statement(this.sql, params);
    }
    async first(column) {
      const row = sqlite.prepare(this.sql).get(...clean(this.params));
      if (!row) {
        return null;
      }
      return column ? row[column] : { ...row };
    }
    async all() {
      const results = sqlite.prepare(this.sql).all(...clean(this.params)).map((row) => ({ ...row }));
      return { results, success: true, meta: {} };
    }
    async run() {
      const info = sqlite.prepare(this.sql).run(...clean(this.params));
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    }
  }
  return {
    sqlite,
    prepare: (sql) => new Statement(sql),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const statement of statements) {
          out.push(await statement.run());
        }
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

const digestJson = (over = {}) => ({
  generatedAt: "2026-09-29T10:30:00Z",
  subject: "Cerulean digest for Sept. 29",
  html: "<html><body><p>Three stories today.</p></body></html>",
  text: "Three stories today.",
  sections: [],
  ...over,
});

const alertsJson = (over = {}) => ({
  id: "batch-001",
  generatedAt: "2026-09-29T10:50:00Z",
  subject: "New coverage naming Blue Cross VT",
  html: "<html><body><p>One new story.</p></body></html>",
  text: "One new story.",
  count: 1,
  ...over,
});

const monthlyJson = (over = {}) => ({
  month: "2026-09",
  subject: "Cerulean monthly report, September 2026",
  html: "<html><body><p>Report.</p></body></html>",
  text: "Report.",
  ...over,
});

function setup({ now = T0, env = {}, site = {} } = {}) {
  const db = createD1();
  const sent = [];
  const logs = [];
  const fetched = [];
  const clock = { now };
  const email = {
    behavior: () => null,
    async send(message) {
      const failure = this.behavior(message);
      if (failure) {
        throw Object.assign(new Error(failure.message ?? failure.code), { code: failure.code });
      }
      sent.push(message);
      return { messageId: `msg-${sent.length}` };
    },
  };
  const pages = { "/digest.json": digestJson(), "/alerts.json": alertsJson(), "/reports/latest-email.json": monthlyJson(), ...site };
  const ctx = makeContext(
    { SITE_URL: SITE, MAIL_SIGNING_SECRET: SECRET, DB: db, EMAIL: email, ...env },
    {
      now: () => clock.now,
      log: (level, message, fields) => logs.push({ level, message, ...fields }),
      fetch: async (url) => {
        const path = new URL(url).pathname;
        fetched.push(path);
        const page = pages[path];
        if (page instanceof Error) {
          throw page;
        }
        if (typeof page === "function") {
          return page();
        }
        if (page === undefined) {
          return new Response("not found", { status: 404 });
        }
        return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  );
  return { ctx, db, sent, logs, fetched, clock, email, pages };
}

let ipCounter = 0;
function request(path, { method = "GET", body, json = false, form = false, headers = {}, ip } = {}) {
  const init = { method, headers: { "cf-connecting-ip": ip ?? `198.51.100.${(ipCounter += 1)}`, ...headers } };
  if (body !== undefined) {
    if (form) {
      init.headers["content-type"] = "application/x-www-form-urlencoded";
      init.body = typeof body === "string" ? body : new URLSearchParams(body).toString();
    } else {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  if (json) {
    init.headers.accept = "application/json";
  }
  return new Request(`${API}${path}`, init);
}

const call = (t, req) => handleRequest(req, t.ctx);
const rows = (t, sql, ...params) => t.db.sqlite.prepare(sql).all(...params);

function urlIn(message, label) {
  const match = new RegExp(`${label}: (https://\\S+)`).exec(message.text);
  assert.ok(match, `${label} link in text part`);
  return match[1];
}

async function subscribe(t, email, lists = ["digest"], extra = {}) {
  return call(t, request("/subscribe", { method: "POST", json: true, body: { email, lists, ...extra } }));
}

async function subscribeAndConfirm(t, email, lists = ["digest"]) {
  const before = t.sent.length;
  const response = await subscribe(t, email, lists);
  assert.equal(response.status, 200);
  const message = t.sent.slice(before).find((item) => item.to === email);
  assert.ok(message, `confirmation email to ${email}`);
  const confirm = await call(t, new Request(urlIn(message, "Confirm")));
  assert.equal(confirm.status, 200);
  return message;
}

const ALLOWED_HEADERS = new Set(["list-unsubscribe", "list-unsubscribe-post", "list-id", "precedence"]);

async function assertCompliant(message, { to } = {}) {
  assert.equal(message.from.email, "news@cerulean.news");
  if (to) {
    assert.equal(message.to, to);
  }
  const headers = message.headers;
  assert.match(headers["List-Unsubscribe"], /^<https:\/\/cerulean\.news\/api\/mail\/unsubscribe\?token=[\w.-]+>$/);
  assert.equal(headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  for (const name of Object.keys(headers)) {
    assert.ok(ALLOWED_HEADERS.has(name.toLowerCase()), `${name} is on Email Service's header allowlist`);
  }
  const unsubscribe = urlIn(message, "Unsubscribe");
  const preferences = urlIn(message, "Change your lists");
  assert.equal(headers["List-Unsubscribe"], `<${unsubscribe}>`);
  assert.match(preferences, /\/api\/mail\/preferences\?token=/);
  assert.ok(message.text.trim().length > 0, "plain-text part");
  assert.ok(message.text.includes(DISCLAIMER), "disclaimer in text");
  assert.ok(message.html.includes(DISCLAIMER), "disclaimer in html");
  assert.ok(message.html.includes(`href="${unsubscribe}"`), "unsubscribe link in html");
  assert.ok(message.html.includes(`href="${preferences}"`), "preferences link in html");
  const token = new URL(unsubscribe).searchParams.get("token");
  const verified = await verifyToken(SECRET, token, { purpose: "manage", nowSec: Math.floor(T0 / 1000) });
  assert.ok(verified.ok, "the personal link verifies");
  assert.equal(verified.payload.e, message.to, "the link belongs to the recipient");
}

const sentTo = (t) => t.sent.map((message) => message.to);

// ---------------------------------------------------------------- validation

test("normalizeEmail accepts ordinary addresses and lowercases them", () => {
  assert.equal(normalizeEmail("  Oliver@Ames.Consulting "), "oliver@ames.consulting");
  assert.equal(normalizeEmail("first.last+news@sub.example.co"), "first.last+news@sub.example.co");
});

test("normalizeEmail rejects malformed and dangerous input", () => {
  for (const bad of [
    "",
    "plain",
    "a@b",
    "@example.com",
    "a@@example.com",
    "a b@example.com",
    "a@exa mple.com",
    "a..b@example.com",
    ".a@example.com",
    "a@-example.com",
    "a@example.c",
    "a@example.123",
    "a@example.com\r\nBcc: victim@example.net",
    "a@example.com,b@example.com",
    "<a@example.com>",
    `${"x".repeat(65)}@example.com`,
    `a@${"x".repeat(250)}.com`,
    null,
    42,
    { email: "a@example.com" },
  ]) {
    assert.equal(normalizeEmail(bad), null, JSON.stringify(bad));
  }
});

test("normalizeLists keeps known lists in a fixed order and rejects unknown ones", () => {
  assert.deepEqual(normalizeLists(["monthly", "digest", "digest"]), ["digest", "monthly"]);
  assert.deepEqual(normalizeLists("alerts"), ["alerts"]);
  assert.deepEqual(normalizeLists([]), []);
  assert.equal(normalizeLists(["digest", "weekly"]), null);
  assert.equal(normalizeLists(["digest", 3]), null);
  assert.equal(normalizeLists(undefined), null);
  assert.deepEqual(LIST_IDS, ["digest", "alerts", "monthly"]);
});

// -------------------------------------------------------------------- tokens

test("tokens round-trip, and carry the purpose and expiry they were signed with", async () => {
  const nowSec = 1_800_000_000;
  const token = await signToken(SECRET, { p: "manage", e: "a@example.com", x: nowSec + 60 });
  const ok = await verifyToken(SECRET, token, { purpose: "manage", nowSec });
  assert.equal(ok.ok, true);
  assert.equal(ok.payload.e, "a@example.com");
  assert.equal((await verifyToken(SECRET, token, { purpose: "confirm", nowSec })).reason, "purpose");
});

test("tokens expire", async () => {
  const nowSec = 1_800_000_000;
  const token = await signToken(SECRET, { p: "confirm", e: "a@example.com", x: nowSec + 60 });
  assert.equal((await verifyToken(SECRET, token, { purpose: "confirm", nowSec: nowSec + 59 })).ok, true);
  assert.equal((await verifyToken(SECRET, token, { purpose: "confirm", nowSec: nowSec + 60 })).reason, "expired");
  assert.equal((await verifyToken(SECRET, token, { purpose: "confirm", nowSec: nowSec + 9999 })).reason, "expired");
});

test("tampered tokens, wrong secrets, and junk are all rejected", async () => {
  const nowSec = 1_800_000_000;
  const token = await signToken(SECRET, { p: "manage", e: "a@example.com", x: nowSec + 60 });
  const [body, signature] = token.split(".");

  // Swap in a payload for a different address, keeping the old signature.
  const forgedBody = Buffer.from(JSON.stringify({ p: "manage", e: "victim@example.com", x: nowSec + 60 })).toString("base64url");
  assert.equal((await verifyToken(SECRET, `${forgedBody}.${signature}`, { purpose: "manage", nowSec })).reason, "signature");

  // Flip one character of the signature.
  const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
  assert.equal((await verifyToken(SECRET, `${body}.${flipped}`, { purpose: "manage", nowSec })).reason, "signature");

  assert.equal((await verifyToken("a-different-secret-of-similar-length!!", token, { purpose: "manage", nowSec })).reason, "signature");
  assert.equal((await verifyToken(SECRET, `${body}.`, { purpose: "manage", nowSec })).ok, false);
  for (const junk of [undefined, null, "", "abc", "a.b.c", `${body}.!!!`, "x".repeat(2000)]) {
    assert.equal((await verifyToken(SECRET, junk, { purpose: "manage", nowSec })).ok, false, String(junk).slice(0, 20));
  }
});

// -------------------------------------------------------------- subscribe

test("subscribe stores a pending row and sends a signed confirmation email", needsSqlite, async () => {
  const t = setup();
  const response = await subscribe(t, "Reader@Example.com", ["monthly", "digest"]);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);

  const [row] = rows(t, "SELECT * FROM subscribers");
  assert.equal(row.email, "reader@example.com");
  assert.equal(row.status, "pending");
  assert.equal(row.pending_lists, "digest,monthly");
  assert.equal(rows(t, "SELECT * FROM subscriptions").length, 0, "nothing is subscribed before confirmation");

  assert.equal(t.sent.length, 1);
  const message = t.sent[0];
  assert.equal(message.to, "reader@example.com");
  assert.match(message.subject, /Confirm/);
  const link = new URL(urlIn(message, "Confirm"));
  assert.equal(link.pathname, "/api/mail/confirm");
  const verified = await verifyToken(SECRET, link.searchParams.get("token"), { purpose: "confirm", nowSec: Math.floor(T0 / 1000) });
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.x - Math.floor(T0 / 1000), 48 * 3600, "the link lasts 48 hours");
});

test("subscribe validates the address and the lists", needsSqlite, async () => {
  const t = setup();
  for (const [body, error] of [
    [{ email: "nope", lists: ["digest"] }, "invalid_email"],
    [{ email: "a@example.com", lists: [] }, "invalid_lists"],
    [{ email: "a@example.com", lists: ["weekly"] }, "invalid_lists"],
    [{ email: "a@example.com" }, "invalid_lists"],
    [{ lists: ["digest"] }, "invalid_email"],
  ]) {
    const response = await call(t, request("/subscribe", { method: "POST", json: true, body }));
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error, error);
  }
  const notJson = await call(t, request("/subscribe", { method: "POST", json: true, body: "{oops", headers: { "content-type": "application/json" } }));
  assert.equal(notJson.status, 400);
  assert.equal(t.sent.length, 0);
  assert.equal(rows(t, "SELECT * FROM subscribers").length, 0);
});

test("the honeypot answers like a success and stores and sends nothing", needsSqlite, async () => {
  const t = setup();
  const real = await (await subscribe(t, "real@example.com")).json();
  const trap = await subscribe(t, "bot@example.com", ["digest"], { website: "http://spam.example" });
  assert.equal(trap.status, 200);
  assert.deepEqual(await trap.json(), real);
  assert.deepEqual(sentTo(t), ["real@example.com"]);
  assert.deepEqual(rows(t, "SELECT email FROM subscribers").map((row) => row.email), ["real@example.com"]);
});

test("subscribe rate limits by hashed IP, per hour", needsSqlite, async () => {
  const t = setup();
  const ip = "203.0.113.9";
  const attempt = (n) =>
    call(t, request("/subscribe", { method: "POST", json: true, ip, body: { email: `user${n}@example.com`, lists: ["digest"] } }));
  for (let n = 1; n <= 5; n += 1) {
    assert.equal((await attempt(n)).status, 200, `attempt ${n}`);
  }
  const blocked = await attempt(6);
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error, "rate_limited");
  assert.ok(Number(blocked.headers.get("retry-after")) > 0);
  assert.equal(t.sent.length, 5, "the blocked attempt sent nothing");

  // Another address is unaffected, and the window rolls over after an hour.
  const other = await call(t, request("/subscribe", { method: "POST", json: true, ip: "203.0.113.10", body: { email: "other@example.com", lists: ["digest"] } }));
  assert.equal(other.status, 200);
  t.clock.now += 3600 * 1000;
  assert.equal((await attempt(7)).status, 200);

  const stored = rows(t, "SELECT key FROM rate_limits");
  assert.ok(stored.length > 0);
  assert.ok(stored.every((row) => !row.key.includes(ip)), "the IP address itself is never stored");
  assert.equal(await hashIp(SECRET, ip), await hashIp(SECRET, ip));
  assert.notEqual(await hashIp(SECRET, ip), await hashIp(SECRET, "203.0.113.10"));
});

test("a daily ceiling on confirmation emails protects the sending quota", needsSqlite, async () => {
  const t = setup({ env: { MAX_CONFIRMATIONS_PER_DAY: "2" } });
  assert.equal((await subscribe(t, "a@example.com")).status, 200);
  assert.equal((await subscribe(t, "b@example.com")).status, 200);
  assert.equal((await subscribe(t, "c@example.com")).status, 429);
  assert.equal(t.sent.length, 2);
});

test("subscribe never reveals whether an address already exists", needsSqlite, async () => {
  const t = setup();
  const fresh = await subscribe(t, "new@example.com");
  const freshBody = await fresh.text();

  await subscribeAndConfirm(t, "member@example.com", ["digest"]);
  t.clock.now += 3600 * 1000; // past the resend cooldown
  const active = await subscribe(t, "member@example.com", ["alerts"]);
  const cooling = await subscribe(t, "member@example.com", ["alerts"]);

  for (const response of [active, cooling]) {
    assert.equal(response.status, fresh.status);
    assert.equal(await response.text(), freshBody);
  }
  // The existing member is asked to confirm the change rather than being told.
  const confirmations = t.sent.filter((message) => message.to === "member@example.com");
  assert.equal(confirmations.length, 2);
  // Their current subscription is untouched until they confirm.
  assert.deepEqual(rows(t, "SELECT list FROM subscriptions s JOIN subscribers b ON b.id = s.subscriber_id WHERE b.email = 'member@example.com'").map((r) => r.list), ["digest"]);
});

test("a second sign-up inside the cooldown sends no second confirmation", needsSqlite, async () => {
  const t = setup();
  await subscribe(t, "once@example.com");
  await subscribe(t, "once@example.com");
  await subscribe(t, "once@example.com");
  assert.equal(t.sent.length, 1);
  t.clock.now += 11 * 60 * 1000;
  await subscribe(t, "once@example.com");
  assert.equal(t.sent.length, 2);
});

test("subscribe hides recipient-side send failures but reports our own", needsSqlite, async () => {
  const t = setup();
  const good = await (await subscribe(t, "fine@example.com")).json();
  t.email.behavior = () => ({ code: "E_RECIPIENT_SUPPRESSED" });
  const suppressed = await subscribe(t, "suppressed@example.com");
  assert.equal(suppressed.status, 200);
  assert.deepEqual(await suppressed.json(), good);

  t.email.behavior = () => ({ code: "E_DAILY_LIMIT_EXCEEDED" });
  const limited = await subscribe(t, "later@example.com");
  assert.equal(limited.status, 503);
  // The failed send does not start the cooldown, so a retry is not blocked.
  t.email.behavior = () => null;
  assert.equal((await subscribe(t, "later@example.com")).status, 200);
  assert.equal(t.sent.at(-1).to, "later@example.com");
});

test("subscribe refuses a cross-origin form post but accepts the site", needsSqlite, async () => {
  const t = setup();
  const foreign = await call(t, request("/subscribe", { method: "POST", json: true, headers: { origin: "https://evil.example" }, body: { email: "a@example.com", lists: ["digest"] } }));
  assert.equal(foreign.status, 403);
  const own = await call(t, request("/subscribe", { method: "POST", json: true, headers: { origin: SITE }, body: { email: "a@example.com", lists: ["digest"] } }));
  assert.equal(own.status, 200);
});

test("the plain HTML form works too, and answers with a page", needsSqlite, async () => {
  const t = setup();
  const response = await call(t, request("/subscribe", { method: "POST", form: true, body: "email=form%40example.com&lists=digest&lists=alerts&website=" }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const page = await response.text();
  assert.match(page, /Not affiliated/);
  assert.equal(rows(t, "SELECT pending_lists FROM subscribers")[0].pending_lists, "digest,alerts");
});

// ------------------------------------------------------------------ confirm

test("confirm turns the pending row into subscriptions for the chosen lists", needsSqlite, async () => {
  const t = setup();
  await subscribe(t, "reader@example.com", ["digest", "monthly"]);
  const link = urlIn(t.sent[0], "Confirm");
  const response = await call(t, new Request(link));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /You are subscribed/);

  const [row] = rows(t, "SELECT * FROM subscribers");
  assert.equal(row.status, "active");
  assert.equal(row.pending_lists, null);
  assert.ok(row.confirmed_at);
  assert.deepEqual(rows(t, "SELECT list FROM subscriptions ORDER BY list").map((r) => r.list), ["digest", "monthly"]);
});

test("a confirmation link can be opened twice without harm", needsSqlite, async () => {
  const t = setup();
  await subscribe(t, "reader@example.com", ["digest"]);
  const link = urlIn(t.sent[0], "Confirm");
  assert.equal((await call(t, new Request(link))).status, 200);
  const again = await call(t, new Request(link, { headers: { accept: "application/json" } }));
  assert.equal(again.status, 200);
  assert.deepEqual((await again.json()).lists, ["digest"]);
  assert.equal(rows(t, "SELECT * FROM subscriptions").length, 1);
});

test("confirm rejects tampered, expired, wrong-purpose, and superseded links", needsSqlite, async () => {
  const t = setup();
  await subscribe(t, "reader@example.com", ["digest"]);
  const link = urlIn(t.sent[0], "Confirm");
  const token = new URL(link).searchParams.get("token");

  const tampered = await call(t, new Request(`${API}/confirm?token=${token.slice(0, -2)}xx`));
  assert.equal(tampered.status, 400);
  assert.equal((await call(t, new Request(`${API}/confirm`))).status, 400);

  const manage = await signToken(SECRET, { p: "manage", e: "reader@example.com", x: Math.floor(T0 / 1000) + 999 });
  assert.equal((await call(t, new Request(`${API}/confirm?token=${manage}`))).status, 400, "an unsubscribe token cannot confirm");

  // A newer request replaces the older link.
  t.clock.now += 11 * 60 * 1000;
  await subscribe(t, "reader@example.com", ["alerts"]);
  assert.equal((await call(t, new Request(link))).status, 400, "the superseded link no longer works");
  assert.equal(rows(t, "SELECT * FROM subscriptions").length, 0);
  assert.equal((await call(t, new Request(urlIn(t.sent.at(-1), "Confirm")))).status, 200);
  assert.deepEqual(rows(t, "SELECT list FROM subscriptions").map((r) => r.list), ["alerts"]);

  // Expiry.
  t.clock.now += 11 * 60 * 1000;
  await subscribe(t, "reader@example.com", ["digest"]);
  const fresh = urlIn(t.sent.at(-1), "Confirm");
  t.clock.now += 49 * 3600 * 1000;
  assert.equal((await call(t, new Request(fresh))).status, 400, "expired after 48 hours");
});

test("confirming adds lists to an existing subscription", needsSqlite, async () => {
  const t = setup();
  await subscribeAndConfirm(t, "reader@example.com", ["digest"]);
  t.clock.now += 3600 * 1000;
  await subscribeAndConfirm(t, "reader@example.com", ["alerts"]);
  assert.deepEqual(rows(t, "SELECT list FROM subscriptions ORDER BY list").map((r) => r.list), ["alerts", "digest"]);
});

test("link scanners that send HEAD do not confirm or unsubscribe anyone", needsSqlite, async () => {
  const t = setup();
  await subscribe(t, "reader@example.com", ["digest"]);
  const link = urlIn(t.sent[0], "Confirm");
  const head = await call(t, new Request(link, { method: "HEAD" }));
  assert.equal(head.status, 200);
  assert.equal(rows(t, "SELECT status FROM subscribers")[0].status, "pending");
});

// -------------------------------------------------------------- unsubscribe

test("the unsubscribe link removes every subscription", needsSqlite, async () => {
  const t = setup();
  const confirmation = await subscribeAndConfirm(t, "reader@example.com", ["digest", "alerts"]);
  const link = urlIn(confirmation, "Unsubscribe");
  const response = await call(t, new Request(link));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /You are unsubscribed/);
  assert.equal(rows(t, "SELECT status FROM subscribers")[0].status, "unsubscribed");
  assert.equal(rows(t, "SELECT * FROM subscriptions").length, 0);
  // Idempotent.
  assert.equal((await call(t, new Request(link))).status, 200);
});

test("RFC 8058 one-click POST unsubscribes with no page interaction", needsSqlite, async () => {
  const t = setup();
  const confirmation = await subscribeAndConfirm(t, "reader@example.com", ["digest"]);
  const header = confirmation.headers["List-Unsubscribe"];
  const url = header.slice(1, -1);
  const response = await call(
    t,
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: confirmation.headers["List-Unsubscribe-Post"],
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(rows(t, "SELECT status FROM subscribers")[0].status, "unsubscribed");

  // A later digest skips them.
  await runList(t.ctx, "digest", { remaining: 100 });
  assert.equal(t.sent.filter((message) => /digest/i.test(message.subject)).length, 0);
});

test("unsubscribe rejects bad tokens and changes nothing", needsSqlite, async () => {
  const t = setup();
  await subscribeAndConfirm(t, "reader@example.com", ["digest"]);
  const confirmToken = new URL(urlIn(t.sent[0], "Confirm")).searchParams.get("token");
  for (const token of ["", "junk", confirmToken, `${confirmToken}x`]) {
    for (const method of ["GET", "POST"]) {
      const response = await call(t, new Request(`${API}/unsubscribe?token=${token}`, { method }));
      assert.equal(response.status, 400, `${method} ${token.slice(0, 10)}`);
    }
  }
  assert.equal(rows(t, "SELECT status FROM subscribers")[0].status, "active");
  assert.equal((await call(t, new Request(`${API}/unsubscribe`, { method: "PUT" }))).status, 405);
});

test("unsubscribing an unknown address answers the same as a known one", needsSqlite, async () => {
  const t = setup();
  const token = await signToken(SECRET, { p: "manage", e: "ghost@example.com", x: Math.floor(T0 / 1000) + 1000 });
  const response = await call(t, new Request(`${API}/unsubscribe?token=${token}`, { method: "POST" }));
  assert.equal(response.status, 200);
});

// -------------------------------------------------------------- preferences

test("preferences shows current lists and saves a new selection", needsSqlite, async () => {
  const t = setup();
  const confirmation = await subscribeAndConfirm(t, "reader@example.com", ["digest"]);
  const link = urlIn(confirmation, "Change your lists");
  const page = await (await call(t, new Request(link))).text();
  assert.match(page, /name="lists" value="digest" checked/);
  assert.doesNotMatch(page, /value="alerts" checked/);
  assert.match(page, /Unsubscribe from everything/);

  const saved = await call(t, new Request(link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "lists=alerts&lists=monthly" }));
  assert.equal(saved.status, 200);
  assert.deepEqual(rows(t, "SELECT list FROM subscriptions ORDER BY list").map((r) => r.list), ["alerts", "monthly"]);

  const json = await call(t, new Request(link, { headers: { accept: "application/json" } }));
  assert.deepEqual((await json.json()).lists, ["alerts", "monthly"]);
});

test("preferences can unsubscribe, and an empty selection means the same", needsSqlite, async () => {
  const t = setup();
  const confirmation = await subscribeAndConfirm(t, "reader@example.com", ["digest"]);
  const link = urlIn(confirmation, "Change your lists");
  const post = (body) => call(t, new Request(link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body }));
  assert.equal((await post("action=unsubscribe")).status, 200);
  assert.equal(rows(t, "SELECT status FROM subscribers")[0].status, "unsubscribed");

  // The same signed link can choose lists again, since it proves the mailbox.
  assert.equal((await post("lists=digest")).status, 200);
  assert.equal(rows(t, "SELECT status FROM subscribers")[0].status, "active");
  assert.equal((await post("")).status, 200);
  assert.equal(rows(t, "SELECT status FROM subscribers")[0].status, "unsubscribed");
  assert.equal((await post("lists=weekly")).status, 400);
});

test("preferences cannot activate an address that never confirmed", needsSqlite, async () => {
  const t = setup();
  await subscribe(t, "reader@example.com", ["digest"]);
  const link = urlIn(t.sent[0], "Change your lists");
  const response = await call(t, new Request(link, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "lists=digest" }));
  assert.equal(response.status, 400);
  assert.equal(rows(t, "SELECT status FROM subscribers")[0].status, "pending");
  assert.equal(rows(t, "SELECT * FROM subscriptions").length, 0);
});

// ----------------------------------------------------------------- delivery

async function roster(t, entries) {
  for (const [email, lists] of entries) {
    await subscribeAndConfirm(t, email, lists);
  }
  t.sent.length = 0;
}

test("a digest goes only to digest subscribers, and each list gets its own content", needsSqlite, async () => {
  const t = setup();
  await roster(t, [
    ["daily@example.com", ["digest"]],
    ["watcher@example.com", ["alerts"]],
    ["boss@example.com", ["monthly"]],
    ["everything@example.com", ["digest", "alerts", "monthly"]],
  ]);
  await runList(t.ctx, "digest", { remaining: 100 });
  assert.deepEqual(sentTo(t).sort(), ["daily@example.com", "everything@example.com"]);
  t.sent.length = 0;

  await runList(t.ctx, "alerts", { remaining: 100 });
  assert.deepEqual(sentTo(t).sort(), ["everything@example.com", "watcher@example.com"]);
  assert.ok(t.sent.every((message) => message.subject === "New coverage naming Blue Cross VT"));
  t.sent.length = 0;

  t.clock.now = Date.parse("2026-10-01T13:05:00Z");
  await runList(t.ctx, "monthly", { remaining: 100 });
  assert.deepEqual(sentTo(t).sort(), ["boss@example.com", "everything@example.com"]);
});

test("the same content is never sent to a subscriber twice", needsSqlite, async () => {
  const t = setup();
  await roster(t, [["a@example.com", ["digest", "alerts"]], ["b@example.com", ["digest"]]]);

  await runList(t.ctx, "digest", { remaining: 100 });
  await runList(t.ctx, "digest", { remaining: 100 });
  await runList(t.ctx, "digest", { remaining: 100 });
  assert.equal(t.sent.length, 2);

  // A rebuild later the same day keeps the same date key, so still nothing new.
  t.pages["/digest.json"] = digestJson({ generatedAt: "2026-09-29T15:00:00Z", subject: "Rebuilt digest" });
  t.clock.now = Date.parse("2026-09-29T16:00:00Z");
  await runList(t.ctx, "digest", { remaining: 100 });
  assert.equal(t.sent.length, 2);

  // Tomorrow's digest is new.
  t.pages["/digest.json"] = digestJson({ generatedAt: "2026-09-30T10:30:00Z" });
  t.clock.now = Date.parse("2026-09-30T11:05:00Z");
  await runList(t.ctx, "digest", { remaining: 100 });
  assert.equal(t.sent.length, 4);

  // Alerts dedupe on their stable id.
  t.pages["/alerts.json"] = alertsJson({ generatedAt: "2026-09-30T10:50:00Z" });
  await runList(t.ctx, "alerts", { remaining: 100 });
  await runList(t.ctx, "alerts", { remaining: 100 });
  assert.equal(t.sent.length, 5);
  t.pages["/alerts.json"] = alertsJson({ id: "batch-002", generatedAt: "2026-09-30T10:55:00Z" });
  await runList(t.ctx, "alerts", { remaining: 100 });
  assert.equal(t.sent.length, 6);

  assert.equal(rows(t, "SELECT * FROM sends WHERE status = 'sent'").length, 6);
});

test("two overlapping runs cannot both send to the same person", needsSqlite, async () => {
  const t = setup();
  await roster(t, [["a@example.com", ["digest"]], ["b@example.com", ["digest"]], ["c@example.com", ["digest"]]]);
  await Promise.all([runList(t.ctx, "digest", { remaining: 100 }), runList(t.ctx, "digest", { remaining: 100 })]);
  assert.deepEqual(sentTo(t).sort(), ["a@example.com", "b@example.com", "c@example.com"]);
});

test("every outgoing email carries the unsubscribe links, headers, text part, and disclaimer", needsSqlite, async () => {
  const t = setup();
  await roster(t, [["everything@example.com", ["digest", "alerts", "monthly"]]]);
  await subscribe(t, "confirming@example.com", ["digest"]); // a confirmation email too
  t.clock.now = Date.parse("2026-10-01T13:05:00Z");
  t.pages["/digest.json"] = digestJson({ generatedAt: "2026-10-01T10:30:00Z" });
  t.pages["/alerts.json"] = alertsJson({ generatedAt: "2026-10-01T12:50:00Z" });
  await runList(t.ctx, "digest", { remaining: 100 });
  await runList(t.ctx, "alerts", { remaining: 100 });
  await runList(t.ctx, "monthly", { remaining: 100 });

  assert.equal(t.sent.length, 4);
  for (const message of t.sent) {
    await assertCompliant(message);
  }
  // The renderer's own markup survives; the footer sits inside the body.
  const digest = t.sent.find((message) => message.subject.startsWith("Cerulean digest"));
  assert.match(digest.html, /Three stories today\.<\/p>[\s\S]*Unsubscribe[\s\S]*<\/body>/);
  assert.equal(digest.headers["List-Id"], "Cerulean News digest <digest.cerulean.news>");
  assert.equal(digest.text.includes("Three stories today."), true);
});

test("a header-injection subject cannot add headers", needsSqlite, async () => {
  const t = setup({ site: { "/digest.json": digestJson({ subject: "Hello\r\nBcc: victim@example.net" }) } });
  await roster(t, [["a@example.com", ["digest"]]]);
  await runList(t.ctx, "digest", { remaining: 100 });
  assert.equal(t.sent[0].subject.includes("\n"), false);
  assert.equal(t.sent[0].subject.includes("\r"), false);
});

for (const [name, site] of [
  ["a 500 response", { "/digest.json": () => new Response("boom", { status: 500 }) }],
  ["a 404 response", { "/digest.json": undefined }],
  ["a network error", { "/digest.json": new TypeError("network down") }],
  ["a body that is not JSON", { "/digest.json": () => new Response("<html>oops</html>", { status: 200 }) }],
  ["a JSON array", { "/digest.json": () => new Response("[]", { status: 200 }) }],
  ["a missing subject", { "/digest.json": digestJson({ subject: "" }) }],
  ["missing html", { "/digest.json": digestJson({ html: undefined }) }],
  ["a bad generatedAt", { "/digest.json": digestJson({ generatedAt: "yesterday-ish" }) }],
  ["a stale digest", { "/digest.json": digestJson({ generatedAt: "2026-09-20T10:30:00Z" }) }],
]) {
  test(`a failed content fetch sends nothing and logs why: ${name}`, needsSqlite, async () => {
    const t = setup({ site });
    if (name === "a 404 response") {
      delete t.pages["/digest.json"];
    }
    await roster(t, [["a@example.com", ["digest"]], ["b@example.com", ["digest"]]]);
    const result = await runList(t.ctx, "digest", { remaining: 100 });
    assert.equal(t.sent.length, 0);
    assert.equal(rows(t, "SELECT * FROM sends").length, 0);
    assert.ok(result.skipped, "the run reports why it skipped");
    const log = t.logs.find((entry) => entry.message === "digest: nothing sent");
    assert.ok(log?.reason, "the reason is logged");
  });
}

test("alerts with a zero count, and reports for the wrong month, send nothing", needsSqlite, async () => {
  const t = setup({ site: { "/alerts.json": alertsJson({ count: 0 }), "/reports/latest-email.json": monthlyJson({ month: "2026-07" }) } });
  await roster(t, [["a@example.com", ["alerts", "monthly"]]]);
  await runList(t.ctx, "alerts", { remaining: 100 });
  t.clock.now = Date.parse("2026-10-01T13:05:00Z");
  await runList(t.ctx, "monthly", { remaining: 100 });
  assert.equal(t.sent.length, 0);
  assert.equal(parseMonthly(monthlyJson({ month: "September" }), { nowMs: T0 }).ok, false);
  assert.equal(parseMonthly(monthlyJson({ month: "2026-10" }), { nowMs: Date.parse("2026-10-01T13:05:00Z") }).ok, true);
  assert.equal(parseAlerts(alertsJson({ id: "" }), { nowMs: T0, cfg: settings({}) }).ok, false);
  assert.equal(parseDigest(digestJson(), { nowMs: T0, cfg: settings({}) }).content.key, "digest:2026-09-29");
});

test("one failing recipient does not stop the others, and is retried a limited number of times", needsSqlite, async () => {
  const t = setup();
  await roster(t, [["a@example.com", ["digest"]], ["bad@example.com", ["digest"]], ["c@example.com", ["digest"]], ["d@example.com", ["digest"]]]);
  t.email.behavior = (message) => (message.to === "bad@example.com" ? { code: "E_DELIVERY_FAILED", message: "mailbox rejected" } : null);

  const first = await runList(t.ctx, "digest", { remaining: 100 });
  assert.deepEqual(sentTo(t).sort(), ["a@example.com", "c@example.com", "d@example.com"]);
  assert.equal(first.failed, 1);
  assert.equal(first.stopped, null);
  const [failed] = rows(t, "SELECT * FROM sends WHERE status = 'failed'");
  assert.equal(failed.attempts, 1);
  assert.match(failed.error, /E_DELIVERY_FAILED/);
  assert.equal(rows(t, "SELECT status FROM jobs")[0].status, "partial");

  // Next runs retry only the failure, up to the attempt cap.
  await runList(t.ctx, "digest", { remaining: 100 });
  await runList(t.ctx, "digest", { remaining: 100 });
  const [attempts] = rows(t, "SELECT attempts FROM sends WHERE status = 'failed'");
  assert.equal(attempts.attempts, 3);
  const before = t.sent.length;
  const last = await runList(t.ctx, "digest", { remaining: 100 });
  assert.equal(last.attempted, 0, "no fourth attempt");
  assert.equal(t.sent.length, before);
  assert.equal(rows(t, "SELECT status FROM jobs")[0].status, "done");

  // The recipient recovering later still gets no duplicate of what others got.
  t.email.behavior = () => null;
  await runList(t.ctx, "digest", { remaining: 100 });
  assert.equal(t.sent.length, 3);
});

test("a suppressed recipient is skipped and the rest are sent", needsSqlite, async () => {
  const t = setup();
  await roster(t, [["a@example.com", ["digest"]], ["gone@example.com", ["digest"]], ["c@example.com", ["digest"]]]);
  t.email.behavior = (message) => (message.to === "gone@example.com" ? { code: "E_RECIPIENT_SUPPRESSED" } : null);
  const result = await runList(t.ctx, "digest", { remaining: 100 });
  assert.deepEqual(sentTo(t).sort(), ["a@example.com", "c@example.com"]);
  assert.equal(result.suppressed, 1);
  assert.equal(result.failed, 0);
  assert.equal(rows(t, "SELECT status FROM sends WHERE status = 'suppressed'").length, 1);
  // Not retried for this digest, and they stay subscribed for the next one.
  await runList(t.ctx, "digest", { remaining: 100 });
  assert.equal(t.sent.length, 2);
  assert.equal(rows(t, "SELECT status FROM subscribers WHERE email = 'gone@example.com'")[0].status, "active");
  assert.equal(classifySendError({ code: "E_RECIPIENT_SUPPRESSED" }), "suppressed");
});

test("a sending limit halts the batch, and the next run resumes without repeats", needsSqlite, async () => {
  const t = setup({ env: { SEND_CONCURRENCY: "1" } });
  await roster(t, [["a@example.com", ["digest"]], ["b@example.com", ["digest"]], ["c@example.com", ["digest"]], ["d@example.com", ["digest"]]]);
  let allowed = 1;
  t.email.behavior = () => (allowed-- > 0 ? null : { code: "E_DAILY_LIMIT_EXCEEDED", message: "daily quota reached" });

  const first = await runList(t.ctx, "digest", { remaining: 100 });
  assert.equal(t.sent.length, 1);
  assert.match(first.stopped, /E_DAILY_LIMIT_EXCEEDED/);
  assert.equal(first.remaining, 3);
  assert.equal(rows(t, "SELECT status FROM jobs")[0].status, "partial");
  assert.ok(rows(t, "SELECT attempts FROM sends WHERE status = 'failed'").every((row) => row.attempts === 0), "the limit does not burn a recipient's attempts");

  t.email.behavior = () => null;
  await runList(t.ctx, "digest", { remaining: 100 });
  assert.deepEqual(sentTo(t).sort(), ["a@example.com", "b@example.com", "c@example.com", "d@example.com"]);
  assert.equal(rows(t, "SELECT status FROM jobs")[0].status, "done");
});

test("a run of failures in a row stops the batch instead of burning every recipient's attempts", needsSqlite, async () => {
  const t = setup({ env: { SEND_CONCURRENCY: "1" } });
  await roster(t, Array.from({ length: 8 }, (_, i) => [`user${i}@example.com`, ["digest"]]));
  t.email.behavior = () => ({ code: "E_INTERNAL_SERVER_ERROR" });
  const result = await runList(t.ctx, "digest", { remaining: 100 });
  assert.equal(result.attempted, 5);
  assert.match(result.stopped, /in a row failed/);
  assert.equal(rows(t, "SELECT * FROM sends").length, 5);
});

test("the per-run cap spreads a large list across ticks", needsSqlite, async () => {
  const t = setup({ env: { MAX_SENDS_PER_RUN: "2" } });
  await roster(t, Array.from({ length: 5 }, (_, i) => [`user${i}@example.com`, ["digest"]]));

  await runScheduled(t.ctx, CRON_DIGEST);
  assert.equal(t.sent.length, 2);
  assert.equal(rows(t, "SELECT status FROM jobs")[0].status, "partial");

  // The 30-minute ticks pick up where the digest run stopped.
  t.clock.now = Date.parse("2026-09-29T11:35:00Z");
  await runScheduled(t.ctx, CRON_ALERTS);
  assert.equal(t.sent.filter((m) => /digest/i.test(m.subject)).length, 4);
  t.clock.now = Date.parse("2026-09-29T12:05:00Z");
  await runScheduled(t.ctx, CRON_ALERTS);
  assert.equal(new Set(sentTo(t)).size, 5);
  assert.equal(t.sent.length, 5);
  assert.equal(rows(t, "SELECT status FROM jobs WHERE list = 'digest'")[0].status, "done");

  // Finished: later ticks no longer fetch the digest.
  t.fetched.length = 0;
  t.clock.now = Date.parse("2026-09-29T12:35:00Z");
  await runScheduled(t.ctx, CRON_ALERTS);
  assert.ok(!t.fetched.includes("/digest.json"));
});

test("a digest that publishes after 11:05 UTC is still sent by a later tick", needsSqlite, async () => {
  const t = setup({ site: { "/digest.json": undefined } });
  delete t.pages["/digest.json"];
  await roster(t, [["a@example.com", ["digest"]]]);
  await runScheduled(t.ctx, CRON_DIGEST);
  assert.equal(t.sent.length, 0);
  assert.ok(t.logs.some((entry) => entry.message === "digest: nothing sent"));

  t.pages["/digest.json"] = digestJson();
  t.clock.now = Date.parse("2026-09-29T11:35:00Z");
  await runScheduled(t.ctx, CRON_ALERTS);
  assert.deepEqual(sentTo(t), ["a@example.com"]);
});

test("catch-up runs only inside the digest and monthly windows", needsSqlite, async () => {
  const t = setup();
  const at = async (iso, list) => {
    t.clock.now = Date.parse(iso);
    return needsCatchUp(t.ctx, list);
  };
  assert.equal(await at("2026-09-29T11:00:00Z", "digest"), false, "before the 11:05 run");
  assert.equal(await at("2026-09-29T11:30:00Z", "digest"), true);
  assert.equal(await at("2026-09-29T17:00:00Z", "digest"), false, "window closed");
  assert.equal(await at("2026-10-01T13:00:00Z", "monthly"), false);
  assert.equal(await at("2026-10-01T14:00:00Z", "monthly"), true);
  assert.equal(await at("2026-10-02T09:00:00Z", "monthly"), true);
  assert.equal(await at("2026-10-05T14:00:00Z", "monthly"), false);
  assert.equal(await at("2026-10-15T20:00:00Z", "digest"), false);
  assert.equal(await at("2026-10-15T14:00:00Z", "digest"), true, "any day inside the window");
});

test("unrecognized cron strings are logged, not run", needsSqlite, async () => {
  const t = setup();
  await runScheduled(t.ctx, "1 2 3 4 5");
  assert.equal(t.fetched.length, 0);
  assert.ok(t.logs.some((entry) => entry.message === "unrecognized cron"));
});

test("housekeeping drops stale counters and unconfirmed sign-ups", needsSqlite, async () => {
  const t = setup();
  await roster(t, [["keep@example.com", ["digest"]]]);
  await subscribe(t, "stale@example.com");
  const now = Math.floor(T0 / 1000);
  t.db.sqlite.prepare("UPDATE subscribers SET created_at = ? WHERE email = 'stale@example.com'").run(now - 31 * 86400);
  t.db.sqlite.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('sub:old', ?, 1)").run(now - 3 * 86400);
  await runScheduled(t.ctx, CRON_DIGEST);
  assert.deepEqual(rows(t, "SELECT email FROM subscribers").map((r) => r.email), ["keep@example.com"]);
  assert.equal(rows(t, "SELECT * FROM rate_limits WHERE key = 'sub:old'").length, 0);
});

test("deliverList reports what it did", needsSqlite, async () => {
  const t = setup();
  await roster(t, [["a@example.com", ["digest"]]]);
  const stats = await deliverList(t.ctx, "digest", { key: "digest:test", subject: "S", html: "<p>h</p>", text: "t" }, { remaining: 10 });
  assert.equal(stats.sent, 1);
  assert.equal(stats.remaining, 0);
  assert.equal(t.sent[0].html.startsWith("<p>h</p>"), true);
});

// ------------------------------------------------------------------ routing

test("routing: unknown paths 404, wrong methods 405, and a missing secret fails closed", needsSqlite, async () => {
  const t = setup();
  assert.equal((await call(t, request("/nope"))).status, 404);
  assert.equal((await call(t, request("/subscribe"))).status, 405);
  assert.equal((await call(t, request("/confirm", { method: "POST" }))).status, 405);
  const response = await call(t, request("/preferences", { json: true }));
  assert.equal(response.status, 400, "no token");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex");

  const bare = setup({ env: { MAIL_SIGNING_SECRET: "short" } });
  assert.equal((await call(bare, request("/subscribe", { method: "POST", json: true, body: { email: "a@example.com", lists: ["digest"] } }))).status, 500);
  assert.equal(bare.sent.length, 0);
});

test("HTML responses carry a locked-down content security policy and the site look", needsSqlite, async () => {
  const t = setup();
  const response = await call(t, request("/confirm?token=bad"));
  assert.equal(response.status, 400);
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/);
  const page = await response.text();
  assert.match(page, /max-width:560px/);
  assert.match(page, /Not affiliated\./);
});

test("an unexpected database error becomes a generic 500 and is logged", needsSqlite, async () => {
  const t = setup();
  t.ctx.db = { prepare() { throw new Error("db is down"); } };
  const response = await call(t, request("/subscribe", { method: "POST", json: true, body: { email: "a@example.com", lists: ["digest"] } }));
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error, "internal");
  assert.ok(t.logs.some((entry) => entry.level === "error"));
});

// ------------------------------------------------------------ configuration

test("wrangler.toml matches the code: name, bindings, sender allowlist, route, and crons", () => {
  const toml = readFileSync(new URL("../mail/wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /^name = "cerulean-news-mail"$/m);
  assert.match(toml, /^main = "worker\.js"$/m);
  assert.match(toml, /\[\[d1_databases\]\]\s*\nbinding = "DB"/);
  assert.match(toml, /database_id = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/, "a real D1 id, not the placeholder");
  assert.match(toml, /\[\[send_email\]\]\s*\nname = "EMAIL"\s*\nallowed_sender_addresses = \["news@cerulean\.news"\]/);
  assert.match(toml, /pattern = "cerulean\.news\/api\/mail\/\*", zone_name = "cerulean\.news"/);
  const crons = /crons = \[(.*)\]/.exec(toml)[1].match(/"([^"]+)"/g).map((cron) => cron.slice(1, -1));
  assert.deepEqual(crons, [CRON_ALERTS, CRON_DIGEST, CRON_MONTHLY]);
  assert.deepEqual([CRON_ALERTS, CRON_DIGEST, CRON_MONTHLY], ["*/30 * * * *", "5 11 * * *", "5 13 1 * *"]);
  assert.equal(settings({}).from, "news@cerulean.news");
});

test("the deploy workflow is dispatch-only and runs migrations then deploy in mail/", () => {
  const workflow = readFileSync(new URL("../.github/workflows/deploy-mail.yml", import.meta.url), "utf8");
  assert.match(workflow, /^on:\n {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(workflow, /^ {2}(push|pull_request|schedule):/m);
  assert.match(workflow, /working-directory: mail/);
  const migrate = workflow.indexOf("wrangler@4 d1 migrations apply");
  const deploy = workflow.indexOf("wrangler@4 deploy");
  assert.ok(migrate > 0 && deploy > migrate, "migrations run before the deploy");
  assert.match(workflow, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
});

test("the subscribe page has the form, the honeypot, the three lists, and a privacy note", () => {
  const page = readFileSync(new URL("../site/subscribe.html", import.meta.url), "utf8");
  assert.match(page, /type="email"/);
  assert.match(page, /name="website"/);
  for (const id of LIST_IDS) {
    assert.match(page, new RegExp(`name="lists" value="${id}"`));
  }
  assert.match(page, /fetch\("\/api\/mail\/subscribe"/);
  assert.match(page, /only your email address, the lists you chose, and a log of what we sent you/);
  assert.match(page, /<strong>Not affiliated\.<\/strong>/);
  assert.match(page, /max-width: 560px/);
  // The site is light only, like the reader.
  assert.doesNotMatch(page, /prefers-color-scheme/);
});

test("the reader and trends footers link to the subscribe page inside marked blocks", () => {
  for (const file of ["../site/index.html", "../site/trends.html"]) {
    const html = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.match(html, /<!-- feature: email-subscribe -->[\s\S]*href="subscribe"[\s\S]*<!-- \/feature: email-subscribe -->/, file);
  }
});
