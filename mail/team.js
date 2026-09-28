// Team sign-in and feedback votes for the Cerulean News mail Worker.
//
// A team member is anyone who proves control of an address at bcbsvt.com by
// opening a single-use link we email, or an address on the ADMIN_EMAILS
// secret (an admin may use any address). The link sets a signed, HttpOnly session
// cookie. A signed-in member can keep, drop, or correct the sentiment of a
// story, and the pipeline fetches the current votes with a bearer token.
//
// Routes, all under /api/mail (the existing Worker route, so there is no new
// route to deploy):
//   GET|POST /team/signin        the form, and the request for a link
//   GET|POST /team/link          the emailed link: a page, then the sign-in
//   POST     /team/signout
//   GET      /feedback           my votes
//   PUT|DELETE /feedback/{item}  cast or replace, and undo, my vote
//   GET      /feedback/admin     every vote with the voter (admin)
//   DELETE   /feedback/admin/{id}  remove any vote (admin)
//   GET      /feedback/export    current votes for the pipeline (bearer token)
//
// This file imports helpers from worker.js and worker.js imports
// handleTeamRequest from here. The cycle is safe because nothing below uses an
// import until a request arrives.
import {
  BASE_HEADERS,
  DAY,
  DISCLAIMER,
  HOUR,
  clientIp,
  escapeHtml,
  hashIp,
  hitRateLimit,
  htmlResponse,
  jsonResponse,
  maskEmail,
  normalizeEmail,
  nowSecOf,
  readBody,
  reply,
  sendEmail,
  signToken,
  verifyToken,
  wantsJson,
} from "./worker.js";

export const TEAM_DOMAIN = "bcbsvt.com";
export const SESSION_COOKIE = "__Secure-cerulean_team";
export const SESSION_PURPOSE = "team-session";
export const LINK_PURPOSE = "team-link";

// The site's five sentiment labels, in the order the reader shows them.
export const SENTIMENT_LABELS = Object.freeze([
  "positive",
  "neutral to positive",
  "neutral",
  "neutral to negative",
  "negative",
]);
export const VOTES = Object.freeze(["keep", "drop", "sentiment"]);
const ITEM_ID = /^[0-9a-f]{64}$/;

// ----------------------------------------------------------------- identity

// The identity for an address at the team domain, or null. The part after the
// last @ must equal the domain exactly, so a subdomain, a lookalike
// (evilbcbsvt.com), and a longer name (bcbsvt.com.example.org) all fail. The
// local part is narrowed to characters that cannot route the message
// elsewhere (no % or ! relaying), and a +tag is dropped so every alias of one
// mailbox is one person. Returns the canonical address.
export function teamIdentity(input) {
  const email = normalizeEmail(input);
  if (!email) {
    return null;
  }
  const at = email.lastIndexOf("@");
  if (email.slice(at + 1) !== TEAM_DOMAIN) {
    return null;
  }
  const local = email.slice(0, at);
  if (!/^[a-z0-9._'+-]+$/.test(local)) {
    return null;
  }
  const base = local.split("+")[0];
  return base ? `${base}@${TEAM_DOMAIN}` : null;
}

// The admin allowlist: a comma-separated Worker secret, trimmed, lowercased,
// and compared by exact match. Unset or empty means nobody is an admin.
export function adminEmails(env) {
  return new Set(
    String(env?.ADMIN_EMAILS || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminEmail(env, email) {
  return typeof email === "string" && adminEmails(env).has(email.trim().toLowerCase());
}

// Whether this address may be sent a sign-in link, and under which identity.
// An admin address signs in as itself, at any domain. Everyone else needs the
// team domain and must not be blocked.
export async function resolveSignInAddress(ctx, input) {
  const email = normalizeEmail(input);
  if (!email) {
    return null;
  }
  if (isAdminEmail(ctx.env, email)) {
    return email;
  }
  const identity = teamIdentity(email);
  if (!identity) {
    return null;
  }
  const canonical = await ctx.db
    .prepare("SELECT blocked FROM team_members WHERE email = ?")
    .bind(identity)
    .first();
  return canonical?.blocked === 1 ? null : identity;
}

// -------------------------------------------------------------------- utils

const encoder = new TextEncoder();

// Constant-time string comparison. Both sides are hashed to a fixed length
// first, so neither the content nor the length of the secret leaks through
// timing, and the byte loop never exits early.
export async function safeEqual(a, b) {
  const [left, right] = await Promise.all(
    [a, b].map(async (value) => new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(String(value))))),
  );
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

export function readCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) {
      return part.slice(index + 1).trim();
    }
  }
  return "";
}

function sessionCookie(value, maxAgeSec) {
  return `${SESSION_COOKIE}=${value}; Path=/api/mail; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}

// State-changing requests must come from the site itself. A form post sent
// under a no-referrer policy carries no usable origin, so the Worker's own
// forms use a same-origin referrer policy (see FORM_PAGE_HEADERS), and a
// request with no Origin header passes only when the browser says the
// navigation is same-origin.
export function fromSite(request, cfg) {
  const origin = request.headers.get("origin");
  if (origin) {
    return origin === cfg.siteUrl;
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}

const FORM_PAGE_HEADERS = { "referrer-policy": "same-origin" };

function forbidden(ctx, request) {
  return reply(ctx, request, 403, {
    title: "Not allowed",
    heading: "Not allowed",
    message: "This request has to come from cerulean.news.",
    json: { error: "bad_origin" },
  });
}

const unauthorized = (ctx, request) =>
  reply(
    ctx,
    request,
    401,
    {
      title: "Sign in",
      heading: "Sign in",
      message: "Sign in with your team email address first.",
      extraHtml: `<p><a href="${escapeHtml(ctx.cfg.apiBase)}/team/signin">Team sign-in</a></p>`,
      json: { error: "unauthorized" },
    },
    // Clear a stale cookie, but send nothing to a visitor who has none.
    readCookie(request, SESSION_COOKIE) ? { "set-cookie": sessionCookie("", 0) } : {},
  );

// ------------------------------------------------------------------ sign-in

function signInForm(ctx, note = "") {
  const action = `${ctx.cfg.apiBase}/team/signin`;
  return (
    `${note ? `<p>${escapeHtml(note)}</p>` : ""}` +
    `<p>Team members can sign in to keep, drop, or correct stories. Enter your work email address and we will send you a link. ` +
    `The link works once and expires in ${Math.round(ctx.cfg.signinLinkTtlSec / 60)} minutes.</p>` +
    `<form method="post" action="${escapeHtml(action)}">` +
    `<p><label for="email">Email address</label><br><input id="email" name="email" type="email" required autocomplete="email" style="font:inherit;padding:6px;width:100%;box-sizing:border-box"></p>` +
    `<p style="position:absolute;left:-9999px" aria-hidden="true"><label>Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label></p>` +
    `<button type="submit">Email me a sign-in link</button></form>`
  );
}

const SIGNIN_NOTICE =
  "If that address can sign in, a link is on its way. It works once and expires soon. " +
  "Nothing there after a few minutes? Look in spam, then try again in ten minutes.";

// The same answer for every well-formed address, whether or not it can sign
// in, so the response never says who is on the team.
function signInOk(ctx, request) {
  return reply(ctx, request, 200, {
    title: "Check your inbox",
    heading: "Check your inbox",
    message: SIGNIN_NOTICE,
    json: { pending: true },
  });
}

export function buildSignInEmail(ctx, { to, linkUrl }) {
  const minutes = Math.round(ctx.cfg.signinLinkTtlSec / 60);
  const text = [
    "Sign in to Cerulean News team feedback.",
    "",
    `Sign in: ${linkUrl}`,
    "",
    `The link works once and expires in ${minutes} minutes. If you did not ask for it, ignore this email. Nobody can sign in without it.`,
    "",
    "--",
    DISCLAIMER.replace("You subscribed at cerulean.news. ", ""),
    "",
  ].join("\n");
  const html =
    '<div style="font:16px/1.45 Helvetica,Arial,sans-serif;color:#111111;max-width:520px">' +
    "<p>Sign in to Cerulean News team feedback.</p>" +
    `<p><a href="${escapeHtml(linkUrl)}">Sign in</a></p>` +
    `<p>The link works once and expires in ${minutes} minutes. If you did not ask for it, ignore this email. Nobody can sign in without it.</p>` +
    '<p style="margin-top:24px;padding-top:12px;border-top:1px solid #cccccc;font-size:13px;color:#555555">' +
    `${escapeHtml(DISCLAIMER.replace("You subscribed at cerulean.news. ", ""))}</p></div>`;
  return {
    to,
    from: { email: ctx.cfg.from, name: ctx.cfg.fromName },
    subject: "Your Cerulean News sign-in link",
    html,
    text,
    // No List-Unsubscribe: this is a one-off message the recipient asked for.
    headers: {},
  };
}

async function mailSignInLink(ctx, address) {
  const nowSec = nowSecOf(ctx);
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const token = await signToken(ctx.secret, {
    p: LINK_PURPOSE,
    e: address,
    n: nonce,
    x: nowSec + ctx.cfg.signinLinkTtlSec,
  });
  const linkUrl = `${ctx.cfg.apiBase}/team/link?token=${token}`;
  const result = await sendEmail(ctx, buildSignInEmail(ctx, { to: address, linkUrl }));
  if (!result.ok) {
    ctx.log("warn", "sign-in link not sent", { to: maskEmail(address), code: result.code });
  }
}

export async function handleSignInRequest(request, ctx) {
  const { cfg, db } = ctx;
  if (!fromSite(request, cfg)) {
    return forbidden(ctx, request);
  }
  const body = await readBody(request);
  if (!body) {
    return reply(ctx, request, 400, {
      title: "Bad request",
      heading: "Bad request",
      message: "Send an email address.",
      json: { error: "bad_body" },
    });
  }
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return signInOk(ctx, request);
  }

  const nowSec = nowSecOf(ctx);
  const tooMany = (retryAfterSec) =>
    reply(
      ctx,
      request,
      429,
      {
        title: "Too many requests",
        heading: "Too many requests",
        message: "Too many sign-in requests. Please try again later.",
        json: { error: "rate_limited" },
      },
      { "retry-after": String(retryAfterSec) },
    );
  const ipKey = await hashIp(ctx.secret, clientIp(request));
  const perIp = await hitRateLimit(db, `signin:${ipKey}`, { limit: cfg.subscribeLimitPerHour, windowSec: HOUR, nowSec });
  if (!perIp.allowed) {
    return tooMany(perIp.retryAfterSec);
  }
  const email = normalizeEmail(body.email);
  if (!email) {
    return reply(ctx, request, 400, {
      title: "Check the address",
      heading: "Check the address",
      message: "That does not look like a valid email address.",
      json: { error: "invalid_email" },
    });
  }
  // Every well-formed request counts against the site-wide ceiling, whoever
  // it names, so hitting the ceiling reveals nothing about a particular address.
  const global = await hitRateLimit(db, "signin:global", { limit: cfg.signinsPerDay, windowSec: DAY, nowSec });
  if (!global.allowed) {
    return tooMany(global.retryAfterSec);
  }
  // One link per address per cooldown, again for every address alike.
  // Aliases of one team mailbox share it, so +tags cannot dodge the limit.
  const addressKey = await hashIp(ctx.secret, `signin-address|${teamIdentity(email) || email}`);
  const perAddress = await hitRateLimit(db, `signin-addr:${addressKey}`, { limit: 1, windowSec: cfg.confirmCooldownSec, nowSec });
  if (!perAddress.allowed) {
    return signInOk(ctx, request);
  }

  const work = (async () => {
    const address = await resolveSignInAddress(ctx, email);
    if (address) {
      await mailSignInLink(ctx, address);
    }
  })().catch((error) => ctx.log("error", "sign-in request failed", { error: String(error?.message ?? error) }));
  // The lookup and the send are the only work that differs between a team
  // address and any other, so they run after the response goes out.
  if (typeof ctx.defer === "function") {
    ctx.defer(work);
  } else {
    await work;
  }
  return signInOk(ctx, request);
}

function invalidSignInLink(ctx, request) {
  return reply(
    ctx,
    request,
    400,
    {
      title: "Link not valid",
      heading: "This link is not valid",
      message: "This sign-in link is invalid, has expired, or was already used.",
      extraHtml: `<p><a href="${escapeHtml(ctx.cfg.apiBase)}/team/signin">Get a new link</a></p>`,
      json: { error: "invalid_token" },
    },
    FORM_PAGE_HEADERS,
  );
}

// GET shows a page with a button, and only the POST signs in. Mail scanners
// open links before people do, and they never press buttons, so a scanner
// cannot use up the link.
export async function handleLinkPage(request, ctx, url) {
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: BASE_HEADERS });
  }
  const token = url.searchParams.get("token");
  const verified = await verifyToken(ctx.secret, token, { purpose: LINK_PURPOSE, nowSec: nowSecOf(ctx) });
  if (!verified.ok || typeof verified.payload.n !== "string") {
    return invalidSignInLink(ctx, request);
  }
  const action = `${ctx.cfg.apiBase}/team/link`;
  return htmlResponse(
    ctx,
    200,
    {
      title: "Sign in to Cerulean News",
      heading: "Team sign-in",
      bodyHtml:
        `<p>Sign in to Cerulean News as ${escapeHtml(verified.payload.e)}?</p>` +
        `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="token" value="${escapeHtml(token)}">` +
        `<button type="submit">Sign in</button></form>`,
    },
    FORM_PAGE_HEADERS,
  );
}

// The member row plus `admin`, which comes from the secret on every request
// and is never stored.
async function loadMember(ctx, email) {
  const row = await ctx.db
    .prepare("SELECT id, email, blocked, session_epoch FROM team_members WHERE email = ?")
    .bind(email)
    .first();
  return row ? { ...row, admin: isAdminEmail(ctx.env, row.email) } : null;
}

// Consumes the link and starts a session.
export async function handleLinkSignIn(request, ctx) {
  if (!fromSite(request, ctx.cfg)) {
    return forbidden(ctx, request);
  }
  const body = (await readBody(request)) ?? {};
  const nowSec = nowSecOf(ctx);
  const verified = await verifyToken(ctx.secret, body.token, { purpose: LINK_PURPOSE, nowSec });
  if (!verified.ok || typeof verified.payload.n !== "string" || verified.payload.n.length < 16) {
    return invalidSignInLink(ctx, request);
  }
  const address = await resolveSignInAddress(ctx, verified.payload.e);
  if (!address || address !== verified.payload.e) {
    return invalidSignInLink(ctx, request);
  }
  // Single use. The insert yields a row only for the first use of this nonce.
  const claimed = await ctx.db
    .prepare("INSERT INTO signin_links (nonce, used_at) VALUES (?, ?) ON CONFLICT (nonce) DO NOTHING RETURNING nonce")
    .bind(verified.payload.n, nowSec)
    .first();
  if (!claimed) {
    return invalidSignInLink(ctx, request);
  }
  await ctx.db
    .prepare(
      "INSERT INTO team_members (email, created_at, last_signin_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (email) DO UPDATE SET last_signin_at = excluded.last_signin_at",
    )
    .bind(address, nowSec, nowSec)
    .run();
  const member = await loadMember(ctx, address);
  if (!member || (member.blocked === 1 && !member.admin)) {
    return invalidSignInLink(ctx, request);
  }
  const session = await signToken(ctx.secret, {
    p: SESSION_PURPOSE,
    e: member.email,
    v: member.session_epoch,
    x: nowSec + ctx.cfg.sessionTtlSec,
  });
  const cookie = sessionCookie(session, ctx.cfg.sessionTtlSec);
  if (wantsJson(request)) {
    return jsonResponse(200, { ok: true, admin: member.admin }, { "set-cookie": cookie });
  }
  return new Response(null, {
    status: 303,
    headers: { ...BASE_HEADERS, location: `${ctx.cfg.siteUrl}/`, "set-cookie": cookie },
  });
}

// ---------------------------------------------------------------- sessions

// Returns the signed-in member, or null. Everything is checked on every
// request: the token's signature, purpose, and expiry, then the database, so
// blocking an address or signing out ends a session at once.
export async function sessionMember(ctx, request) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) {
    return null;
  }
  const verified = await verifyToken(ctx.secret, token, { purpose: SESSION_PURPOSE, nowSec: nowSecOf(ctx) });
  if (!verified.ok) {
    return null;
  }
  const member = await loadMember(ctx, verified.payload.e);
  if (!member || (member.blocked === 1 && !member.admin) || member.session_epoch !== verified.payload.v) {
    return null;
  }
  if (!member.admin && !teamIdentity(member.email)) {
    return null;
  }
  return member;
}

export async function handleSignOut(request, ctx) {
  if (!fromSite(request, ctx.cfg)) {
    return forbidden(ctx, request);
  }
  const member = await sessionMember(ctx, request);
  if (member) {
    // A new epoch invalidates every cookie signed for this address.
    await ctx.db.prepare("UPDATE team_members SET session_epoch = session_epoch + 1 WHERE id = ?").bind(member.id).run();
  }
  const clear = { "set-cookie": sessionCookie("", 0) };
  if (wantsJson(request)) {
    return jsonResponse(200, { ok: true }, clear);
  }
  return new Response(null, { status: 303, headers: { ...BASE_HEADERS, location: `${ctx.cfg.siteUrl}/`, ...clear } });
}

// -------------------------------------------------------------------- votes

const iso = (seconds) => new Date(seconds * 1000).toISOString();

function voteView(row) {
  return { item: row.item_id, vote: row.vote, label: row.label ?? null, updatedAt: iso(row.updated_at) };
}

// Strict parse of a vote body: only vote and label, and a label exactly when
// the vote is a sentiment correction. Returns { vote, label } or { error }.
export function parseVote(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "bad_body" };
  }
  if (Object.keys(body).some((key) => key !== "vote" && key !== "label")) {
    return { error: "unknown_field" };
  }
  if (typeof body.vote !== "string" || !VOTES.includes(body.vote)) {
    return { error: "invalid_vote" };
  }
  if (body.vote === "sentiment") {
    if (typeof body.label !== "string" || !SENTIMENT_LABELS.includes(body.label)) {
      return { error: "invalid_label" };
    }
    return { vote: "sentiment", label: body.label };
  }
  if (body.label !== undefined && body.label !== null) {
    return { error: "invalid_label" };
  }
  return { vote: body.vote, label: null };
}

const apiError = (status, error, message) => jsonResponse(status, { ok: false, error, message });

async function handleMyVotes(request, ctx, member) {
  const found = await ctx.db
    .prepare("SELECT item_id, vote, label, updated_at FROM feedback WHERE member_id = ? ORDER BY updated_at DESC LIMIT ?")
    .bind(member.id, ctx.cfg.maxVotesPerMember)
    .all();
  return jsonResponse(200, { ok: true, admin: member.admin, votes: (found.results ?? []).map(voteView) });
}

async function handleCastVote(request, ctx, member, item) {
  const body = await readBody(request);
  const parsed = parseVote(body);
  if (parsed.error) {
    return apiError(400, parsed.error, "Send JSON like {\"vote\":\"drop\"} or {\"vote\":\"sentiment\",\"label\":\"neutral\"}.");
  }
  const nowSec = nowSecOf(ctx);
  const limited = await hitRateLimit(ctx.db, `vote:${member.id}`, { limit: ctx.cfg.voteWritesPerMinute, windowSec: 60, nowSec });
  if (!limited.allowed) {
    return jsonResponse(429, { ok: false, error: "rate_limited", message: "Too many votes. Please slow down." }, { "retry-after": String(limited.retryAfterSec) });
  }
  const existing = await ctx.db.prepare("SELECT id FROM feedback WHERE member_id = ? AND item_id = ?").bind(member.id, item).first();
  if (!existing) {
    const count = await ctx.db.prepare("SELECT COUNT(*) AS n FROM feedback WHERE member_id = ?").bind(member.id).first();
    if (Number(count?.n ?? 0) >= ctx.cfg.maxVotesPerMember) {
      return apiError(409, "too_many_votes", "This account has reached its limit of votes.");
    }
  }
  // One current vote per member and story: a new vote replaces the old one.
  const row = await ctx.db
    .prepare(
      "INSERT INTO feedback (member_id, item_id, vote, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (member_id, item_id) DO UPDATE SET vote = excluded.vote, label = excluded.label, updated_at = excluded.updated_at " +
        "RETURNING item_id, vote, label, updated_at",
    )
    .bind(member.id, item, parsed.vote, parsed.label, nowSec, nowSec)
    .first();
  return jsonResponse(200, { ok: true, vote: voteView(row) });
}

async function handleUndoVote(request, ctx, member, item) {
  const result = await ctx.db.prepare("DELETE FROM feedback WHERE member_id = ? AND item_id = ?").bind(member.id, item).run();
  return jsonResponse(200, { ok: true, deleted: Number(result.meta?.changes ?? 0) > 0 });
}

async function handleAdminList(request, ctx) {
  const found = await ctx.db
    .prepare(
      "SELECT f.id, f.item_id, f.vote, f.label, f.updated_at, m.email, m.blocked FROM feedback f " +
        "JOIN team_members m ON m.id = f.member_id ORDER BY f.updated_at DESC LIMIT 5000",
    )
    .all();
  return jsonResponse(200, {
    ok: true,
    votes: (found.results ?? []).map((row) => ({ id: row.id, ...voteView(row), voter: row.email, voterBlocked: row.blocked === 1 })),
  });
}

async function handleAdminDelete(request, ctx, id) {
  const result = await ctx.db.prepare("DELETE FROM feedback WHERE id = ?").bind(id).run();
  return jsonResponse(200, { ok: true, deleted: Number(result.meta?.changes ?? 0) > 0 });
}

// Current votes for the pipeline. No email, no voter id, no way to tell voters
// apart: only what each vote says about a story. A blocked member's votes are
// left out, so blocking an address takes its votes out of the next run.
export async function handleExport(request, ctx) {
  const configured = String(ctx.env.FEEDBACK_EXPORT_TOKEN || "");
  // Without a real token the export does not exist.
  if (configured.length < 32) {
    return jsonResponse(404, { ok: false, error: "not_found" });
  }
  const nowSec = nowSecOf(ctx);
  const ipKey = await hashIp(ctx.secret, clientIp(request));
  const limited = await hitRateLimit(ctx.db, `export:${ipKey}`, { limit: ctx.cfg.exportLimitPerHour, windowSec: HOUR, nowSec });
  if (!limited.allowed) {
    return jsonResponse(429, { ok: false, error: "rate_limited" }, { "retry-after": String(limited.retryAfterSec) });
  }
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get("authorization") || "");
  if (!match || !(await safeEqual(match[1], configured))) {
    return jsonResponse(401, { ok: false, error: "unauthorized" }, { "www-authenticate": "Bearer" });
  }
  const found = await ctx.db
    .prepare(
      "SELECT f.item_id, f.vote, f.label, f.updated_at FROM feedback f JOIN team_members m ON m.id = f.member_id " +
        "WHERE m.blocked = 0 ORDER BY f.updated_at DESC, f.id DESC LIMIT 20000",
    )
    .all();
  return jsonResponse(200, { ok: true, generatedAt: iso(nowSec), votes: (found.results ?? []).map(voteView) });
}

// ------------------------------------------------------------------ routing

const methodNotAllowed = (methods) =>
  jsonResponse(405, { ok: false, error: "method_not_allowed" }, { allow: methods.join(", ") });

// Returns a Response for a team or feedback path, or null for any other path.
export async function handleTeamRequest(request, ctx, url, path) {
  const method = request.method;
  const team = /^\/api\/mail\/team\/(signin|link|signout)$/.exec(path);
  if (team) {
    const [, name] = team;
    if (name === "signin") {
      if (method === "POST") {
        return handleSignInRequest(request, ctx);
      }
      if (method === "GET" || method === "HEAD") {
        return htmlResponse(ctx, 200, { title: "Team sign-in", heading: "Team sign-in", bodyHtml: signInForm(ctx) }, FORM_PAGE_HEADERS);
      }
      return methodNotAllowed(["GET", "HEAD", "POST"]);
    }
    if (name === "link") {
      if (method === "POST") {
        return handleLinkSignIn(request, ctx);
      }
      return method === "GET" || method === "HEAD" ? handleLinkPage(request, ctx, url) : methodNotAllowed(["GET", "HEAD", "POST"]);
    }
    return method === "POST" ? handleSignOut(request, ctx) : methodNotAllowed(["POST"]);
  }

  const feedback = /^\/api\/mail\/feedback(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(path);
  if (!feedback) {
    return null;
  }
  const [, first, second] = feedback;

  if (first === "export" && !second) {
    return method === "GET" ? handleExport(request, ctx) : methodNotAllowed(["GET"]);
  }

  // Every other route needs a team session.
  const member = await sessionMember(ctx, request);
  if (!member) {
    return unauthorized(ctx, request);
  }
  const mutating = method !== "GET" && method !== "HEAD";
  if (mutating && !fromSite(request, ctx.cfg)) {
    return forbidden(ctx, request);
  }

  if (!first) {
    return method === "GET" ? handleMyVotes(request, ctx, member) : methodNotAllowed(["GET"]);
  }
  if (first === "admin") {
    if (!member.admin) {
      return apiError(403, "forbidden", "Only an admin can do that.");
    }
    if (!second) {
      return method === "GET" ? handleAdminList(request, ctx) : methodNotAllowed(["GET"]);
    }
    if (!/^[1-9][0-9]{0,15}$/.test(second)) {
      return apiError(400, "invalid_id", "That is not a vote id.");
    }
    return method === "DELETE" ? handleAdminDelete(request, ctx, Number(second)) : methodNotAllowed(["DELETE"]);
  }
  if (second || !ITEM_ID.test(first)) {
    return apiError(400, "invalid_item", "The story id must be 64 lowercase hex characters.");
  }
  if (method === "PUT") {
    return handleCastVote(request, ctx, member, first);
  }
  if (method === "DELETE") {
    return handleUndoVote(request, ctx, member, first);
  }
  return methodNotAllowed(["PUT", "DELETE"]);
}

// Called from the daily housekeeping. Used sign-in links only matter until
// their token would have expired, and a vote about a story is moot once the
// story has left the 92-day archive.
export async function teamHousekeeping(ctx) {
  const nowSec = nowSecOf(ctx);
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM signin_links WHERE used_at < ?").bind(nowSec - 2 * DAY),
    ctx.db.prepare("DELETE FROM feedback WHERE updated_at < ?").bind(nowSec - 200 * DAY),
  ]);
}
