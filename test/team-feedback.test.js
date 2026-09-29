// Tests for team sign-in and feedback votes in the mail Worker (mail/team.js).
// Same approach as mail.test.js: D1 is in-memory SQLite (node:sqlite) running
// the real migrations, and EMAIL is a fake. Nothing touches the network.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { handleRequest, makeContext, signToken, verifyToken } from "../mail/worker.js";
import {
  SESSION_COOKIE,
  adminEmails,
  isAdminEmail,
  parseVote,
  readCookie,
  safeEqual,
  teamIdentity,
} from "../mail/team.js";

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  // Node older than 22.5: the database tests skip, the pure ones still run.
}
const needsSqlite = DatabaseSync ? {} : { skip: "node:sqlite needs Node 22.5 or newer" };

const MIGRATIONS = readdirSync(new URL("../mail/migrations/", import.meta.url))
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => readFileSync(new URL(`../mail/migrations/${name}`, import.meta.url), "utf8"))
  .join("\n");
const SECRET = "test-secret-with-plenty-of-length-0123456789";
const EXPORT_TOKEN = "export-token-with-plenty-of-length-0123456789";
const SITE = "https://cerulean.news";
const API = `${SITE}/api/mail`;
const T0 = Date.parse("2026-09-29T11:05:00Z");
const ADMIN = "admin@example.com";
const TEAM = "jane.doe@bcbsvt.com";
const TEAM2 = "sam.roe@bcbsvt.com";
const ITEM_A = "a".repeat(64);
const ITEM_B = "b".repeat(64);

function createD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(MIGRATIONS);
  const clean = (params) => params.map((value) => (value === undefined ? null : value));
  class Statement {
    constructor(sql, params = []) {
      this.sql = sql;
      this.params = params;
    }
    bind(...params) {
      return new Statement(this.sql, params);
    }
    async first() {
      const row = sqlite.prepare(this.sql).get(...clean(this.params));
      return row ? { ...row } : null;
    }
    async all() {
      return { results: sqlite.prepare(this.sql).all(...clean(this.params)).map((row) => ({ ...row })), success: true, meta: {} };
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
        for (const statement of statements) out.push(await statement.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function setup({ env = {}, now = T0 } = {}) {
  const db = createD1();
  const sent = [];
  const logs = [];
  const clock = { now };
  const email = {
    async send(message) {
      sent.push(message);
      return { messageId: `msg-${sent.length}` };
    },
  };
  const ctx = makeContext(
    {
      SITE_URL: SITE,
      MAIL_SIGNING_SECRET: SECRET,
      ADMIN_EMAILS: ` ${ADMIN.toUpperCase()} , other-admin@example.com `,
      FEEDBACK_EXPORT_TOKEN: EXPORT_TOKEN,
      DB: db,
      EMAIL: email,
      ...env,
    },
    { now: () => clock.now, log: (level, message, fields) => logs.push({ level, message, ...fields }) },
  );
  return { ctx, db, sent, logs, clock };
}

let ipCounter = 0;
// Requests default to the site's own origin, the way the reader and the
// Worker's own pages send them.
function req(path, { method = "GET", body, form, headers = {}, cookie, origin = SITE, ip, json = true } = {}) {
  const init = { method, headers: { "cf-connecting-ip": ip ?? `203.0.113.${(ipCounter += 1)}`, ...headers } };
  if (origin) init.headers.origin = origin;
  if (cookie) init.headers.cookie = cookie;
  if (json) init.headers.accept = "application/json";
  if (form) {
    init.headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request(`${API}${path}`, init);
}

const call = (t, request) => handleRequest(request, t.ctx);
const rows = (t, sql, ...params) => t.db.sqlite.prepare(sql).all(...params);

const linkIn = (message) => /Sign in: (https:\/\/\S+)/.exec(message.text)?.[1];

async function requestLink(t, address, options = {}) {
  return call(t, req("/team/signin", { method: "POST", body: { email: address }, ...options }));
}

// Signs in through the real flow: request, read the email, press the button.
async function signIn(t, address) {
  const before = t.sent.length;
  const asked = await requestLink(t, address);
  assert.equal(asked.status, 200);
  const message = t.sent.slice(before).find((item) => item.to === address);
  assert.ok(message, `sign-in email to ${address}`);
  const token = new URL(linkIn(message)).searchParams.get("token");
  const response = await call(t, req("/team/link", { method: "POST", form: { token } }));
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "the sign-in sets a cookie");
  return { cookie: setCookie.split(";")[0], setCookie, token };
}

const vote = (t, cookie, item, body, options = {}) =>
  call(t, req(`/feedback/${item}`, { method: "PUT", body, cookie, ...options }));

// ---------------------------------------------------------------- identity

test("teamIdentity accepts only the exact domain bcbsvt.com", () => {
  assert.equal(teamIdentity("Jane.Doe@BCBSVT.com"), "jane.doe@bcbsvt.com");
  assert.equal(teamIdentity("  jane@bcbsvt.com "), "jane@bcbsvt.com");
  for (const bad of [
    "jane@bcbsvt.com.example.org",
    "jane@evilbcbsvt.com",
    "jane@notbcbsvt.com",
    "jane@mail.bcbsvt.com",
    "jane@bcbsvt.co",
    "jane@bcbsvt.org",
    "jane@bcbsvt.com.",
    "jane@example.com",
    "jane@bcbsvt.com@example.com",
    "jane@example.com@bcbsvt.com",
    "jane%example.com@bcbsvt.com",
    "jane!example.com@bcbsvt.com",
    "jane@bcbsvt.com\r\nBcc: victim@example.net",
    "@bcbsvt.com",
    "",
    null,
  ]) {
    assert.equal(teamIdentity(bad), null, String(bad));
  }
});

test("teamIdentity drops a +tag so every alias of one mailbox is one person", () => {
  assert.equal(teamIdentity("jane+vote@bcbsvt.com"), "jane@bcbsvt.com");
  assert.equal(teamIdentity("jane+a+b@bcbsvt.com"), "jane@bcbsvt.com");
  assert.equal(teamIdentity("+only@bcbsvt.com"), null);
});

test("the admin allowlist is trimmed, lowercased, exact, and empty when unset", () => {
  const env = { ADMIN_EMAILS: " Admin@Example.com ,, second@example.com " };
  assert.deepEqual([...adminEmails(env)].sort(), ["admin@example.com", "second@example.com"]);
  assert.equal(isAdminEmail(env, "ADMIN@example.com"), true);
  assert.equal(isAdminEmail(env, "admin@example.com.evil.org"), false);
  assert.equal(isAdminEmail(env, "xadmin@example.com"), false);
  assert.equal(isAdminEmail({}, "admin@example.com"), false);
  assert.equal(isAdminEmail({ ADMIN_EMAILS: "" }, ""), false);
});

test("safeEqual compares whole strings", async () => {
  assert.equal(await safeEqual("abc", "abc"), true);
  assert.equal(await safeEqual("abc", "abd"), false);
  assert.equal(await safeEqual("abc", "abcd"), false);
  assert.equal(await safeEqual("", "x"), false);
});

test("parseVote is strict about its fields", () => {
  assert.deepEqual(parseVote({ vote: "keep" }), { vote: "keep", label: null });
  assert.deepEqual(parseVote({ vote: "drop", label: null }), { vote: "drop", label: null });
  assert.deepEqual(parseVote({ vote: "sentiment", label: "neutral to negative" }), { vote: "sentiment", label: "neutral to negative" });
  for (const bad of [
    null,
    [],
    {},
    { vote: "up" },
    { vote: "KEEP" },
    { vote: "sentiment" },
    { vote: "sentiment", label: "mixed" },
    { vote: "sentiment", label: null },
    { vote: "keep", label: "positive" },
    { vote: "drop", label: "" },
    { vote: "keep", extra: 1 },
    { vote: ["keep"] },
  ]) {
    assert.ok(parseVote(bad).error, JSON.stringify(bad));
  }
  assert.equal(readCookie(new Request("https://x.test", { headers: { cookie: `a=1; ${SESSION_COOKIE}=tok; b=2` } }), SESSION_COOKIE), "tok");
  assert.equal(readCookie(new Request("https://x.test"), SESSION_COOKIE), "");
});

// ----------------------------------------------------------------- sign-in

test("sign-in emails only team-domain and admin addresses, and answers all alike", needsSqlite, async () => {
  const t = setup();
  const answers = [];
  for (const address of [TEAM, "stranger@example.com", "jane@bcbsvt.com.example.org", "jane@evilbcbsvt.com", ADMIN, "nobody@bcbsvt.com"]) {
    const response = await requestLink(t, address);
    answers.push({ status: response.status, body: await response.json() });
  }
  for (const answer of answers) {
    assert.deepEqual(answer, answers[0], "the response never says who is on the team");
  }
  assert.equal(answers[0].status, 200);
  assert.deepEqual(t.sent.map((message) => message.to).sort(), [ADMIN, "jane.doe@bcbsvt.com", "nobody@bcbsvt.com"].sort());
  // The HTML form flow answers identically too.
  const html = await Promise.all(
    [TEAM2, "stranger2@example.com"].map(async (address) => (await requestLink(t, address, { json: false })).text()),
  );
  assert.equal(html[0], html[1]);
});

test("a team member does not need to be a subscriber", needsSqlite, async () => {
  const t = setup();
  assert.equal(rows(t, "SELECT * FROM subscribers").length, 0);
  await signIn(t, TEAM);
  assert.equal(rows(t, "SELECT * FROM subscribers").length, 0);
  assert.deepEqual(rows(t, "SELECT email FROM team_members").map((row) => row.email), [TEAM]);
});

test("sign-in mail is plain: link, no unsubscribe machinery, no team roster in the text", needsSqlite, async () => {
  const t = setup();
  await requestLink(t, "Jane.Doe+vote@BCBSVT.com");
  const [message] = t.sent;
  assert.equal(message.to, TEAM, "sent to the canonical address");
  assert.equal(message.from.email, "news@cerulean.news");
  assert.deepEqual(message.headers, {});
  assert.match(linkIn(message), /^https:\/\/cerulean\.news\/api\/mail\/team\/link\?token=[\w.-]+$/);
  assert.ok(message.html.includes(linkIn(message).replace(/&/g, "&amp;")));
});

test("aliases of one mailbox are one person and share the address cooldown", needsSqlite, async () => {
  const t = setup();
  await requestLink(t, "jane@bcbsvt.com");
  await requestLink(t, "JANE+two@bcbsvt.com");
  assert.equal(t.sent.length, 1, "no second link inside the cooldown");
  t.clock.now += 11 * 60 * 1000;
  await requestLink(t, "jane+three@bcbsvt.com");
  assert.equal(t.sent.length, 2);
  assert.ok(t.sent.every((message) => message.to === "jane@bcbsvt.com"));
});

test("the cooldown answers exactly as an unlimited request does", needsSqlite, async () => {
  const t = setup();
  const first = await requestLink(t, TEAM);
  const second = await requestLink(t, TEAM);
  assert.equal(second.status, first.status);
  assert.deepEqual(await second.json(), await first.json());
});

test("sign-in is limited per connection and site-wide, alike for any address", needsSqlite, async () => {
  const t = setup();
  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    statuses.push((await requestLink(t, `person${i}@example.com`, { ip: "198.51.100.9" })).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  const capped = setup({ env: { MAX_SIGNINS_PER_DAY: "2" } });
  const results = [];
  for (const address of [TEAM, "a@example.com", TEAM2]) results.push((await requestLink(capped, address)).status);
  assert.deepEqual(results, [200, 200, 429]);
});

test("a sign-in request needs the site's own origin and a real address", needsSqlite, async () => {
  const t = setup();
  assert.equal((await requestLink(t, TEAM, { origin: "https://evil.example" })).status, 403);
  assert.equal((await requestLink(t, TEAM, { origin: "null" })).status, 403);
  assert.equal((await requestLink(t, TEAM, { origin: null })).status, 403);
  assert.equal((await requestLink(t, TEAM, { origin: null, headers: { "sec-fetch-site": "same-origin" } })).status, 200);
  assert.equal((await requestLink(t, "not an address")).status, 400);
  // A filled honeypot looks like success and sends nothing.
  const before = t.sent.length;
  const bot = await call(t, req("/team/signin", { method: "POST", body: { email: "bot@bcbsvt.com", website: "x" } }));
  assert.equal(bot.status, 200);
  assert.equal(t.sent.length, before);
});

test("the sign-in form and link page are the site's light pages", needsSqlite, async () => {
  const t = setup();
  const form = await call(t, req("/team/signin", { json: false, origin: null }));
  assert.equal(form.status, 200);
  const html = await form.text();
  assert.match(html, /<form method="post" action="https:\/\/cerulean\.news\/api\/mail\/team\/signin">/);
  assert.ok(!/prefers-color-scheme/.test(html));
  assert.match(form.headers.get("referrer-policy"), /same-origin/);
  assert.match(form.headers.get("content-security-policy"), /default-src 'none'/);
});

// -------------------------------------------------------------- the link

test("opening the link page does not use it up, and pressing the button does, once", needsSqlite, async () => {
  const t = setup();
  await requestLink(t, TEAM);
  const url = linkIn(t.sent[0]);
  const token = new URL(url).searchParams.get("token");
  for (let i = 0; i < 3; i += 1) {
    const page = await call(t, req(new URL(url).pathname.replace("/api/mail", "") + new URL(url).search, { json: false, origin: null }));
    assert.equal(page.status, 200);
    assert.match(await page.text(), /name="token"/);
  }
  assert.equal(rows(t, "SELECT * FROM signin_links").length, 0, "a scanner's GET consumes nothing");
  const first = await call(t, req("/team/link", { method: "POST", form: { token } }));
  assert.equal(first.status, 200);
  const again = await call(t, req("/team/link", { method: "POST", form: { token } }));
  assert.equal(again.status, 400, "a used link is refused");
  assert.equal(again.headers.get("set-cookie"), null);
});

test("the session cookie is HttpOnly, Secure, SameSite=Lax, and scoped to the Worker", needsSqlite, async () => {
  const t = setup();
  const { setCookie } = await signIn(t, TEAM);
  assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=[\\w.-]+;`));
  for (const attribute of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/api/mail", `Max-Age=${14 * 86400}`]) {
    assert.ok(setCookie.includes(attribute), attribute);
  }
  assert.ok(!/Domain=/i.test(setCookie));
});

test("a browser form post to the link redirects to the reader with the cookie", needsSqlite, async () => {
  const t = setup();
  await requestLink(t, TEAM);
  const token = new URL(linkIn(t.sent[0])).searchParams.get("token");
  const response = await call(t, req("/team/link", { method: "POST", form: { token }, json: false }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${SITE}/`);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
});

test("the link needs the site's origin: a cross-site post cannot sign a victim in", needsSqlite, async () => {
  const t = setup();
  await requestLink(t, TEAM);
  const token = new URL(linkIn(t.sent[0])).searchParams.get("token");
  for (const origin of ["https://evil.example", "null", null]) {
    const response = await call(t, req("/team/link", { method: "POST", form: { token }, origin }));
    assert.equal(response.status, 403);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(rows(t, "SELECT * FROM signin_links").length, 0, "a refused request does not use the link");
});

test("a link expires", needsSqlite, async () => {
  const t = setup();
  await requestLink(t, TEAM);
  const token = new URL(linkIn(t.sent[0])).searchParams.get("token");
  t.clock.now += 16 * 60 * 1000;
  const response = await call(t, req("/team/link", { method: "POST", form: { token } }));
  assert.equal(response.status, 400);
});

test("a mail token can never become a session, and a session can never be a link", needsSqlite, async () => {
  const t = setup();
  await signIn(t, TEAM);
  const nowSec = Math.floor(T0 / 1000);
  // Real confirm and manage tokens for a team address, and a forged one signed
  // with the right secret but the wrong purpose.
  const foreign = await Promise.all(
    ["confirm", "manage", "team-link", "anything"].map((p) =>
      signToken(SECRET, { p, e: TEAM, n: "n".repeat(20), v: 0, x: nowSec + 3600 }),
    ),
  );
  for (const token of foreign) {
    const response = await call(t, req("/feedback", { cookie: `${SESSION_COOKIE}=${token}` }));
    assert.equal(response.status, 401, "not a session");
  }
  // A session cookie is not a sign-in link either.
  const { cookie } = await signIn(t, TEAM2);
  const sessionToken = cookie.split("=")[1];
  const asLink = await call(t, req("/team/link", { method: "POST", form: { token: sessionToken } }));
  assert.equal(asLink.status, 400);
  // The mail tokens the Worker itself issues verify only under their purpose.
  assert.equal((await verifyToken(SECRET, sessionToken, { purpose: "manage", nowSec })).ok, false);
  assert.equal((await verifyToken(SECRET, sessionToken, { purpose: "team-session", nowSec })).ok, true);
});

test("a tampered, wrong-secret, or expired session is refused", needsSqlite, async () => {
  const t = setup();
  const { cookie } = await signIn(t, TEAM);
  const token = cookie.split("=")[1];
  const flipped = `${token.slice(0, -2)}${token.endsWith("AA") ? "BB" : "AA"}`;
  assert.equal((await call(t, req("/feedback", { cookie: `${SESSION_COOKIE}=${flipped}` }))).status, 401);
  const nowSec = Math.floor(T0 / 1000);
  const forged = await signToken("another-secret-with-plenty-of-length-99", { p: "team-session", e: TEAM, v: 0, x: nowSec + 3600 });
  assert.equal((await call(t, req("/feedback", { cookie: `${SESSION_COOKIE}=${forged}` }))).status, 401);
  assert.equal((await call(t, req("/feedback", { cookie }))).status, 200);
  t.clock.now += 15 * 86400 * 1000;
  assert.equal((await call(t, req("/feedback", { cookie }))).status, 401, "expired after two weeks");
});

test("a signed-in stranger at another domain cannot be created by editing the cookie", needsSqlite, async () => {
  const t = setup();
  const nowSec = Math.floor(T0 / 1000);
  // Signed with the real secret but naming an address that never signed in.
  const forged = await signToken(SECRET, { p: "team-session", e: "ghost@bcbsvt.com", v: 0, x: nowSec + 3600 });
  assert.equal((await call(t, req("/feedback", { cookie: `${SESSION_COOKIE}=${forged}` }))).status, 401);
});

test("sign-out clears the cookie and ends every session for that address", needsSqlite, async () => {
  const t = setup();
  const one = await signIn(t, TEAM);
  t.clock.now += 11 * 60 * 1000;
  const two = await signIn(t, TEAM);
  assert.equal((await call(t, req("/feedback", { cookie: one.cookie }))).status, 200);
  const out = await call(t, req("/team/signout", { method: "POST", cookie: two.cookie }));
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await call(t, req("/feedback", { cookie: two.cookie }))).status, 401);
  assert.equal((await call(t, req("/feedback", { cookie: one.cookie }))).status, 401, "the other browser is signed out too");
  assert.equal((await call(t, req("/team/signout", { method: "POST", cookie: two.cookie, origin: "https://evil.example" }))).status, 403);
});

test("blocking a member ends the session and removes the votes from the export", needsSqlite, async () => {
  const t = setup();
  const { cookie } = await signIn(t, TEAM);
  await vote(t, cookie, ITEM_A, { vote: "drop" });
  t.db.sqlite.prepare("UPDATE team_members SET blocked = 1 WHERE email = ?").run(TEAM);
  assert.equal((await call(t, req("/feedback", { cookie }))).status, 401);
  const exported = await call(t, req("/feedback/export", { headers: { authorization: `Bearer ${EXPORT_TOKEN}` }, origin: null }));
  assert.deepEqual((await exported.json()).votes, []);
  t.clock.now += 11 * 60 * 1000;
  const before = t.sent.length;
  await requestLink(t, TEAM);
  assert.equal(t.sent.length, before, "a blocked address is not mailed");
});

// ------------------------------------------------------------------- votes

test("the vote routes need a valid team session", needsSqlite, async () => {
  const t = setup();
  const attempts = [
    req("/feedback"),
    req(`/feedback/${ITEM_A}`, { method: "PUT", body: { vote: "keep" } }),
    req(`/feedback/${ITEM_A}`, { method: "DELETE" }),
    req("/feedback/admin"),
    req("/feedback/admin/1", { method: "DELETE" }),
  ];
  for (const attempt of attempts) {
    const response = await call(t, attempt);
    assert.equal(response.status, 401, `${attempt.method} ${new URL(attempt.url).pathname}`);
  }
  assert.equal(rows(t, "SELECT * FROM feedback").length, 0);
  // A visitor with no cookie is sent none, and a stale cookie is cleared.
  assert.equal((await call(t, req("/feedback"))).headers.get("set-cookie"), null);
  assert.match((await call(t, req("/feedback", { cookie: `${SESSION_COOKIE}=stale` }))).headers.get("set-cookie"), /Max-Age=0/);
  // Nothing about the export's or the sign-in's existence changes this.
  assert.equal((await call(t, req("/feedback", { cookie: `${SESSION_COOKIE}=garbage` }))).status, 401);
});

test("casting a vote, replacing it, and undoing it", needsSqlite, async () => {
  const t = setup();
  const { cookie } = await signIn(t, TEAM);

  const kept = await vote(t, cookie, ITEM_A, { vote: "keep" });
  assert.equal(kept.status, 200);
  assert.deepEqual((await kept.json()).vote, { item: ITEM_A, vote: "keep", label: null, updatedAt: "2026-09-29T11:05:00.000Z" });

  t.clock.now += 60_000;
  const dropped = await vote(t, cookie, ITEM_A, { vote: "drop" });
  assert.equal((await dropped.json()).vote.vote, "drop");
  assert.equal(rows(t, "SELECT * FROM feedback").length, 1, "one current vote per person and story");
  const [row] = rows(t, "SELECT * FROM feedback");
  assert.equal(row.created_at, Math.floor(T0 / 1000), "the first time is kept");
  assert.equal(row.updated_at, Math.floor(T0 / 1000) + 60);

  await vote(t, cookie, ITEM_A, { vote: "sentiment", label: "neutral to negative" });
  await vote(t, cookie, ITEM_B, { vote: "keep" });
  const mine = await (await call(t, req("/feedback", { cookie }))).json();
  assert.equal(mine.ok, true);
  assert.equal(mine.admin, false);
  assert.deepEqual(
    mine.votes.map(({ item, vote: kind, label }) => [item, kind, label]).sort(),
    [[ITEM_A, "sentiment", "neutral to negative"], [ITEM_B, "keep", null]],
  );

  const undo = await call(t, req(`/feedback/${ITEM_A}`, { method: "DELETE", cookie }));
  assert.deepEqual(await undo.json(), { ok: true, deleted: true });
  const undoAgain = await call(t, req(`/feedback/${ITEM_A}`, { method: "DELETE", cookie }));
  assert.deepEqual(await undoAgain.json(), { ok: true, deleted: false });
  assert.equal(rows(t, "SELECT * FROM feedback").length, 1);
});

test("two people can vote on the same story, and each undoes only their own", needsSqlite, async () => {
  const t = setup();
  const jane = await signIn(t, TEAM);
  const sam = await signIn(t, TEAM2);
  await vote(t, jane.cookie, ITEM_A, { vote: "keep" });
  await vote(t, sam.cookie, ITEM_A, { vote: "drop" });
  assert.equal(rows(t, "SELECT * FROM feedback").length, 2);
  await call(t, req(`/feedback/${ITEM_A}`, { method: "DELETE", cookie: jane.cookie }));
  assert.deepEqual(rows(t, "SELECT vote FROM feedback").map((row) => row.vote), ["drop"]);
  const janeSees = await (await call(t, req("/feedback", { cookie: jane.cookie }))).json();
  assert.deepEqual(janeSees.votes, [], "a member reads only their own votes");
});

test("votes are validated strictly", needsSqlite, async () => {
  const t = setup();
  const { cookie } = await signIn(t, TEAM);
  const bad = [
    { vote: "up" },
    { vote: "sentiment" },
    { vote: "sentiment", label: "mixed" },
    { vote: "keep", label: "positive" },
    { vote: "keep", note: "x" },
    {},
  ];
  for (const body of bad) {
    assert.equal((await vote(t, cookie, ITEM_A, body)).status, 400, JSON.stringify(body));
  }
  for (const item of ["short", "A".repeat(64), "g".repeat(64), `${ITEM_A}0`, "../admin"]) {
    const response = await vote(t, cookie, item, { vote: "keep" });
    assert.ok([400, 404].includes(response.status), item);
  }
  // Not JSON, or JSON in a form content type.
  const plain = new Request(`${API}/feedback/${ITEM_A}`, {
    method: "PUT",
    headers: { origin: SITE, cookie, "content-type": "text/plain", "cf-connecting-ip": "203.0.113.200" },
    body: '{"vote":"keep"}',
  });
  assert.equal((await call(t, plain)).status, 400);
  assert.equal(rows(t, "SELECT * FROM feedback").length, 0);
});

test("state-changing vote requests must come from the site", needsSqlite, async () => {
  const t = setup();
  const { cookie } = await signIn(t, TEAM);
  for (const origin of ["https://evil.example", "null", null]) {
    assert.equal((await vote(t, cookie, ITEM_A, { vote: "keep" }, { origin })).status, 403);
    assert.equal((await call(t, req(`/feedback/${ITEM_A}`, { method: "DELETE", cookie, origin }))).status, 403);
  }
  assert.equal(rows(t, "SELECT * FROM feedback").length, 0);
  // Reading is not state changing.
  assert.equal((await call(t, req("/feedback", { cookie, origin: null }))).status, 200);
});

test("vote writes are rate limited per person", needsSqlite, async () => {
  const t = setup({ env: { VOTE_WRITES_PER_MINUTE: "3" } });
  const { cookie } = await signIn(t, TEAM);
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await vote(t, cookie, ITEM_A, { vote: "keep" })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
});

test("the database itself refuses an unlabeled correction or a stray label", needsSqlite, async () => {
  const t = setup();
  await signIn(t, TEAM);
  const insert = (vote, label) =>
    t.db.sqlite
      .prepare("INSERT INTO feedback (member_id, item_id, vote, label, created_at, updated_at) VALUES (1, ?, ?, ?, 1, 1)")
      .run(ITEM_A, vote, label);
  assert.throws(() => insert("sentiment", null));
  assert.throws(() => insert("keep", "positive"));
  assert.throws(() => insert("sentiment", "mixed"));
  assert.throws(() => insert("maybe", null));
  insert("sentiment", "neutral");
  assert.throws(() => insert("keep", null), /UNIQUE/);
});

// ------------------------------------------------------------------- admin

test("an admin address signs in from any domain, and only allowlisted ones", needsSqlite, async () => {
  const t = setup();
  const { cookie } = await signIn(t, ADMIN);
  assert.equal((await (await call(t, req("/feedback", { cookie }))).json()).admin, true);
  const off = setup({ env: { ADMIN_EMAILS: "" } });
  await requestLink(off, ADMIN);
  assert.equal(off.sent.length, 0, "with ADMIN_EMAILS unset nobody is an admin");
});

test("only an admin can list every vote or delete anyone's", needsSqlite, async () => {
  const t = setup();
  const jane = await signIn(t, TEAM);
  const admin = await signIn(t, ADMIN);
  await vote(t, jane.cookie, ITEM_A, { vote: "drop" });
  await vote(t, admin.cookie, ITEM_B, { vote: "sentiment", label: "positive" });

  assert.equal((await call(t, req("/feedback/admin", { cookie: jane.cookie }))).status, 403);
  assert.equal((await call(t, req("/feedback/admin/1", { method: "DELETE", cookie: jane.cookie }))).status, 403);
  assert.equal(rows(t, "SELECT * FROM feedback").length, 2);

  const listed = await (await call(t, req("/feedback/admin", { cookie: admin.cookie }))).json();
  const byItem = Object.fromEntries(listed.votes.map((row) => [row.item, row]));
  assert.equal(byItem[ITEM_A].voter, TEAM);
  assert.equal(byItem[ITEM_A].vote, "drop");
  assert.equal(byItem[ITEM_B].voter, ADMIN);
  assert.equal(byItem[ITEM_B].label, "positive");

  const removed = await call(t, req(`/feedback/admin/${byItem[ITEM_A].id}`, { method: "DELETE", cookie: admin.cookie }));
  assert.deepEqual(await removed.json(), { ok: true, deleted: true });
  assert.deepEqual(rows(t, "SELECT item_id FROM feedback").map((row) => row.item_id), [ITEM_B]);
  const missing = await call(t, req("/feedback/admin/9999", { method: "DELETE", cookie: admin.cookie }));
  assert.deepEqual(await missing.json(), { ok: true, deleted: false });
  for (const bad of ["abc", "0", "-1", "1.5", "1;DROP"]) {
    assert.equal((await call(t, req(`/feedback/admin/${bad}`, { method: "DELETE", cookie: admin.cookie }))).status, 400, bad);
  }
});

test("removing an address from ADMIN_EMAILS takes the admin rights away at once", needsSqlite, async () => {
  const t = setup();
  const { cookie } = await signIn(t, ADMIN);
  assert.equal((await call(t, req("/feedback/admin", { cookie }))).status, 200);
  t.ctx.env.ADMIN_EMAILS = "someone-else@example.com";
  assert.equal((await call(t, req("/feedback", { cookie }))).status, 401, "a non-team address loses its session");
});

// ------------------------------------------------------------------ export

const exportRequest = (token, extra = {}) =>
  req("/feedback/export", { headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, origin: null, ...extra });

test("the export needs the bearer token", needsSqlite, async () => {
  const t = setup();
  const { cookie } = await signIn(t, TEAM);
  await vote(t, cookie, ITEM_A, { vote: "drop" });
  for (const token of [undefined, "", "wrong", EXPORT_TOKEN.slice(0, -1), `${EXPORT_TOKEN}x`, EXPORT_TOKEN.toUpperCase()]) {
    const response = await call(t, exportRequest(token));
    assert.equal(response.status, 401, String(token));
    assert.ok(!(await response.text()).includes(ITEM_A));
  }
  // A team session is not the export token, and the token is not a session.
  assert.equal((await call(t, exportRequest(undefined, { cookie }))).status, 401);
  assert.equal((await call(t, req("/feedback", { headers: { authorization: `Bearer ${EXPORT_TOKEN}` } }))).status, 401);
  const ok = await call(t, exportRequest(EXPORT_TOKEN));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
});

test("the export does not exist until a real token is configured", needsSqlite, async () => {
  for (const FEEDBACK_EXPORT_TOKEN of [undefined, "", "short"]) {
    const t = setup({ env: { FEEDBACK_EXPORT_TOKEN } });
    for (const token of [FEEDBACK_EXPORT_TOKEN, "", "anything"]) {
      assert.equal((await call(t, exportRequest(token))).status, 404);
    }
  }
});

test("the export carries votes and nothing that identifies a voter", needsSqlite, async () => {
  const t = setup();
  const jane = await signIn(t, TEAM);
  const admin = await signIn(t, ADMIN);
  await vote(t, jane.cookie, ITEM_A, { vote: "drop" });
  await vote(t, admin.cookie, ITEM_B, { vote: "sentiment", label: "neutral to positive" });
  const response = await call(t, exportRequest(EXPORT_TOKEN));
  const text = await response.text();
  const body = JSON.parse(text);
  assert.equal(body.ok, true);
  assert.equal(body.generatedAt, "2026-09-29T11:05:00.000Z");
  assert.deepEqual(
    body.votes.map((row) => Object.keys(row).sort()),
    [["item", "label", "updatedAt", "vote"], ["item", "label", "updatedAt", "vote"]],
  );
  assert.deepEqual(
    body.votes.map(({ item, vote: kind, label }) => [item, kind, label]).sort(),
    [[ITEM_A, "drop", null], [ITEM_B, "sentiment", "neutral to positive"]],
  );
  assert.ok(!text.includes("@"), "no email address anywhere");
  assert.ok(!/bcbsvt|example\.com|jane|admin/i.test(text));
  // An undone vote leaves the export.
  await call(t, req(`/feedback/${ITEM_A}`, { method: "DELETE", cookie: jane.cookie }));
  const after = await (await call(t, exportRequest(EXPORT_TOKEN))).json();
  assert.deepEqual(after.votes.map((row) => row.item), [ITEM_B]);
});

test("export attempts are rate limited", needsSqlite, async () => {
  const t = setup({ env: { EXPORT_LIMIT_PER_HOUR: "2" } });
  const statuses = [];
  for (let i = 0; i < 4; i += 1) statuses.push((await call(t, exportRequest(EXPORT_TOKEN, { ip: "198.51.100.77" }))).status);
  assert.deepEqual(statuses, [200, 200, 429, 429]);
});

// ------------------------------------------------------------ housekeeping

test("subscription behavior is untouched: the old routes and 404s still answer", needsSqlite, async () => {
  const t = setup();
  assert.equal((await call(t, req("/nope"))).status, 404);
  assert.equal((await call(t, req("/team/other"))).status, 404);
  assert.equal((await call(t, req("/feedbackx"))).status, 404);
  assert.equal((await call(t, req("/unsubscribe", { method: "DELETE" }))).status, 405);
  assert.equal((await call(t, req("/team/signout"))).status, 405);
});
