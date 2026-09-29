// Cerulean News mail Worker: email subscriptions and delivery.
//
// A separate Worker from the parked fetch-relay build in worker/. It owns
// cerulean.news/api/mail/*, keeps subscribers in D1, sends through the
// Cloudflare Email Service `send_email` binding, and fetches the content it
// mails from the public site (digest.json, alerts.json, reports/latest-email.json).
//
// Everything that decides something is an exported pure function or takes its
// dependencies through `ctx` ({ env, cfg, db, email, fetch, now, log }), so the
// tests can drive it with fakes. The default export is the thin Workers shell.
// Team sign-in and feedback votes live in team.js, which imports the helpers
// it shares from this file and is routed to from handleRequest below.

import { handleTeamRequest, teamHousekeeping } from "./team.js";

export const LISTS = Object.freeze({
  digest: {
    label: "Daily clip digest",
    description: "One email each morning with the day's Vermont health care and Blue Cross VT coverage.",
  },
  alerts: {
    label: "Brand-mention alerts",
    description: "A short note when new coverage names Blue Cross VT, checked every 30 minutes.",
  },
  monthly: {
    label: "Monthly leadership report",
    description: "Coverage volume, sentiment, and themes for the month, sent on the first.",
  },
});
export const LIST_IDS = Object.freeze(Object.keys(LISTS));

export const DISCLAIMER =
  "You subscribed at cerulean.news. Cerulean News is not affiliated with Blue Cross and Blue Shield of Vermont.";

// These must match [triggers] crons in wrangler.toml (a test checks).
export const CRON_ALERTS = "*/30 * * * *";
export const CRON_DIGEST = "5 11 * * *";
export const CRON_MONTHLY = "5 13 1 * *";

// Minutes past midnight UTC of a "minute hour ..." cron string.
function cronMinutes(cron) {
  const [minute, hour] = cron.split(" ").map(Number);
  return hour * 60 + minute;
}

export const HOUR = 3600;
export const DAY = 86400;

export function settings(env = {}) {
  const num = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const siteUrl = String(env.SITE_URL || "https://cerulean.news").replace(/\/+$/, "");
  return {
    siteUrl,
    apiBase: `${siteUrl}/api/mail`,
    from: String(env.MAIL_FROM || "news@cerulean.news"),
    fromName: String(env.MAIL_FROM_NAME || "Cerulean News"),
    confirmTtlSec: num(env.CONFIRM_TTL_HOURS, 48) * HOUR,
    // Unsubscribe and preferences links must keep working for as long as an
    // old email might sit in an inbox.
    manageTtlSec: num(env.MANAGE_TTL_DAYS, 1095) * DAY,
    subscribeLimitPerHour: num(env.SUBSCRIBE_LIMIT_PER_HOUR, 5),
    confirmCooldownSec: num(env.CONFIRM_COOLDOWN_MINUTES, 10) * 60,
    confirmationsPerDay: num(env.MAX_CONFIRMATIONS_PER_DAY, 300),
    // D1 allows 1,000 queries and Workers 10,000 subrequests per invocation.
    // Each delivery costs two D1 queries (claim, then outcome) and one send, so
    // 250 leaves wide headroom. A larger list is finished by the next tick.
    maxSendsPerRun: num(env.MAX_SENDS_PER_RUN, 250),
    concurrency: Math.min(5, Math.floor(num(env.SEND_CONCURRENCY, 4))),
    maxAttempts: Math.floor(num(env.MAX_SEND_ATTEMPTS, 3)),
    maxConsecutiveFailures: 5,
    maxAgeHours: {
      digest: num(env.DIGEST_MAX_AGE_HOURS, 36),
      alerts: num(env.ALERTS_MAX_AGE_HOURS, 12),
    },
    fetchTimeoutMs: num(env.CONTENT_FETCH_TIMEOUT_MS, 15000),
    // Team sign-in and feedback (team.js). A sign-in link is short lived and a
    // session lasts two weeks. Sign-in reuses the subscribe limits per IP and
    // per address, and adds a site-wide daily ceiling on sign-in emails.
    signinLinkTtlSec: num(env.SIGNIN_LINK_MINUTES, 15) * 60,
    sessionTtlSec: num(env.SESSION_DAYS, 14) * DAY,
    signinsPerDay: num(env.MAX_SIGNINS_PER_DAY, 100),
    voteWritesPerMinute: num(env.VOTE_WRITES_PER_MINUTE, 60),
    maxVotesPerMember: num(env.MAX_VOTES_PER_MEMBER, 5000),
    exportLimitPerHour: num(env.EXPORT_LIMIT_PER_HOUR, 60),
  };
}

// ---------------------------------------------------------------- validation

const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Returns the lowercased address, or null when it is not a plain, deliverable
// looking ASCII address. Rejects anything that could carry a header injection.
export function normalizeEmail(input) {
  if (typeof input !== "string") {
    return null;
  }
  const email = input.trim().toLowerCase();
  if (email.length < 6 || email.length > 254) {
    return null;
  }
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@")) {
    return null;
  }
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART.test(local)) {
    return null;
  }
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return null;
  }
  const labels = domain.split(".");
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) {
    return null;
  }
  if (!/^[a-z]{2,63}$/.test(labels[labels.length - 1])) {
    return null;
  }
  return email;
}

// Returns an ordered, de-duplicated array of known list ids, or null when the
// input is not a list of known ids. An empty selection returns [].
export function normalizeLists(input) {
  const raw = Array.isArray(input) ? input : typeof input === "string" ? [input] : null;
  if (!raw) {
    return null;
  }
  const chosen = new Set();
  for (const value of raw) {
    if (typeof value !== "string") {
      return null;
    }
    const id = value.trim().toLowerCase();
    if (!LIST_IDS.includes(id)) {
      return null;
    }
    chosen.add(id);
  }
  return LIST_IDS.filter((id) => chosen.has(id));
}

export function maskEmail(email) {
  const [local = "", domain = ""] = String(email).split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

// ------------------------------------------------------------------- tokens

const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) {
    throw new Error("not base64url");
  }
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function hmacKey(secret, usages) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

// A token is base64url(JSON payload) + "." + base64url(HMAC-SHA256 of that
// first part). The payload is { p: purpose, e: email, x: expiry (Unix
// seconds), n?: nonce }. The purpose stops a confirmation link from acting as
// an unsubscribe link and the reverse.
export async function signToken(secret, payload) {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await hmacKey(secret, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

// Returns { ok: true, payload } or { ok: false, reason } where reason is
// "malformed", "signature", "purpose", or "expired". Signature checking uses
// SubtleCrypto's verify, which compares in constant time.
export async function verifyToken(secret, token, { purpose, nowSec }) {
  if (typeof token !== "string" || token.length === 0 || token.length > 1024) {
    return { ok: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    return { ok: false, reason: "malformed" };
  }
  let signature;
  try {
    signature = fromBase64Url(parts[1]);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const key = await hmacKey(secret, ["verify"]);
  const valid = await crypto.subtle.verify("HMAC", key, signature, encoder.encode(parts[0]));
  if (!valid) {
    return { ok: false, reason: "signature" };
  }
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(parts[0])));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!payload || typeof payload !== "object" || typeof payload.e !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (payload.p !== purpose) {
    return { ok: false, reason: "purpose" };
  }
  if (typeof payload.x !== "number" || payload.x <= nowSec) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}

// ------------------------------------------------------------- rate limiting

export async function hashIp(secret, ip) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${secret}|ip|${ip}`));
  return [...new Uint8Array(digest)].slice(0, 16).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Fixed-window counter in D1. Counts the attempt, then reports whether it is
// still within the limit.
export async function hitRateLimit(db, key, { limit, windowSec, nowSec }) {
  const windowStart = Math.floor(nowSec / windowSec) * windowSec;
  const row = await db
    .prepare(
      "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) " +
        "ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count",
    )
    .bind(key, windowStart)
    .first();
  const count = Number(row?.count ?? 1);
  return { allowed: count <= limit, count, retryAfterSec: Math.max(1, windowStart + windowSec - nowSec) };
}

// ------------------------------------------------------------------- emails

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function cleanSubject(subject) {
  return String(subject).replace(/\s+/g, " ").trim().slice(0, 200);
}

export function footerParts({ unsubscribeUrl, preferencesUrl }) {
  const text = [
    "",
    "--",
    DISCLAIMER,
    `Unsubscribe: ${unsubscribeUrl}`,
    `Change your lists: ${preferencesUrl}`,
    "",
  ].join("\n");
  const html =
    '<div style="margin-top:24px;padding-top:12px;border-top:1px solid #cccccc;' +
    'font:13px/1.45 Helvetica,Arial,sans-serif;color:#555555">' +
    `<p style="margin:0 0 6px">${escapeHtml(DISCLAIMER)}</p>` +
    `<p style="margin:0"><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe</a> &middot; ` +
    `<a href="${escapeHtml(preferencesUrl)}">Change your lists</a></p></div>`;
  return { text, html };
}

function appendHtml(html, block) {
  const closing = html.search(/<\/body\s*>/i);
  return closing === -1 ? html + block : html.slice(0, closing) + block + html.slice(closing);
}

// Builds the message object for env.EMAIL.send(). Every message, whatever its
// list, carries a personal unsubscribe link and preferences link in both parts,
// the RFC 8058 one-click headers, and the disclaimer line.
export async function buildEmail(ctx, { to, subject, html, text, listId, transactional = false }) {
  const { cfg } = ctx;
  const nowSec = Math.floor(ctx.now() / 1000);
  const manageToken = await signToken(ctx.secret, {
    p: "manage",
    e: to,
    x: nowSec + cfg.manageTtlSec,
  });
  const unsubscribeUrl = `${cfg.apiBase}/unsubscribe?token=${manageToken}`;
  const preferencesUrl = `${cfg.apiBase}/preferences?token=${manageToken}`;
  const footer = footerParts({ unsubscribeUrl, preferencesUrl });
  const headers = {
    "List-Unsubscribe": `<${unsubscribeUrl}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
  if (listId && LISTS[listId]) {
    headers["List-Id"] = `Cerulean News ${listId} <${listId}.cerulean.news>`;
  }
  if (!transactional) {
    headers.Precedence = "bulk";
  }
  return {
    to,
    from: { email: cfg.from, name: cfg.fromName },
    subject: cleanSubject(subject),
    html: appendHtml(String(html), footer.html),
    text: String(text).replace(/\s+$/, "") + "\n" + footer.text,
    headers,
  };
}

export function buildConfirmationContent(confirmUrl, lists) {
  const labels = lists.map((id) => LISTS[id].label);
  const text = [
    "Please confirm your Cerulean News subscription.",
    "",
    `You asked for: ${labels.join(", ")}.`,
    "",
    `Confirm: ${confirmUrl}`,
    "",
    "The link works for 48 hours. If you did not ask for this, ignore this email and nothing will be sent to you.",
  ].join("\n");
  const html =
    '<div style="font:16px/1.45 Helvetica,Arial,sans-serif;color:#111111;max-width:520px">' +
    "<p>Please confirm your Cerulean News subscription.</p>" +
    `<p>You asked for: ${labels.map(escapeHtml).join(", ")}.</p>` +
    `<p><a href="${escapeHtml(confirmUrl)}">Confirm my subscription</a></p>` +
    "<p>The link works for 48 hours. If you did not ask for this, ignore this email and nothing will be sent to you.</p>" +
    "</div>";
  return { subject: "Confirm your Cerulean News subscription", html, text };
}

// Never throws. Resolves { ok: true, messageId } or { ok: false, code, message }.
export async function sendEmail(ctx, message) {
  try {
    const result = await ctx.email.send(message);
    return { ok: true, messageId: result?.messageId ?? null };
  } catch (error) {
    return { ok: false, code: error?.code ? String(error.code) : "", message: String(error?.message ?? error) };
  }
}

// "suppressed": the address is on Email Service's suppression list (only
//   thrown while "Drop suppressed recipients" is off). Skip it, try next time.
// "stop": the problem is ours or the platform's limit, not the recipient's,
//   so sending more would fail the same way. Halt the batch and resume later.
// "failed": this recipient failed; count an attempt and carry on.
const STOP_CODES = new Set([
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
]);

export function classifySendError(error) {
  const code = String(error?.code ?? "");
  if (code === "E_RECIPIENT_SUPPRESSED") {
    return "suppressed";
  }
  return STOP_CODES.has(code) ? "stop" : "failed";
}

// ------------------------------------------------------------ content fetch

export async function fetchContent(ctx, path) {
  const url = `${ctx.cfg.siteUrl}${path}`;
  let response;
  try {
    response = await ctx.fetch(url, {
      headers: { accept: "application/json", "cache-control": "no-cache", "user-agent": "cerulean-news-mail/1" },
      signal: AbortSignal.timeout(ctx.cfg.fetchTimeoutMs),
    });
  } catch (error) {
    return { ok: false, reason: `fetch of ${path} failed: ${error?.message ?? error}` };
  }
  if (!response.ok) {
    return { ok: false, reason: `fetch of ${path} returned HTTP ${response.status}` };
  }
  let json;
  try {
    json = await response.json();
  } catch {
    return { ok: false, reason: `${path} is not valid JSON` };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, reason: `${path} is not a JSON object` };
  }
  return { ok: true, json };
}

const MAX_CONTENT_CHARS = 2 * 1024 * 1024;

function filled(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function checkBody(name, json) {
  if (!filled(json.subject) || !filled(json.html) || !filled(json.text)) {
    return `${name} is missing a subject, html, or text`;
  }
  if (json.html.length + json.text.length > MAX_CONTENT_CHARS) {
    return `${name} is too large to send`;
  }
  return null;
}

function checkFresh(name, generatedAt, nowMs, maxAgeHours) {
  const time = Date.parse(generatedAt);
  if (!Number.isFinite(time)) {
    return { error: `${name} has no valid generatedAt` };
  }
  if (time > nowMs + 6 * HOUR * 1000) {
    return { error: `${name} generatedAt is in the future` };
  }
  if (nowMs - time > maxAgeHours * HOUR * 1000) {
    return { error: `${name} is stale (generated ${generatedAt})` };
  }
  return { time };
}

// Each parser returns { ok: true, content: { key, subject, html, text } } or
// { ok: false, reason, quiet? }. The key is what the send log dedupes on.
export function parseDigest(json, { nowMs, cfg }) {
  const bodyError = checkBody("digest.json", json);
  if (bodyError) {
    return { ok: false, reason: bodyError };
  }
  const fresh = checkFresh("digest.json", json.generatedAt, nowMs, cfg.maxAgeHours.digest);
  if (fresh.error) {
    return { ok: false, reason: fresh.error };
  }
  const day = new Date(fresh.time).toISOString().slice(0, 10);
  return { ok: true, content: { key: `digest:${day}`, subject: json.subject, html: json.html, text: json.text } };
}

export function parseAlerts(json, { nowMs, cfg }) {
  if (!filled(json.id) || json.id.length > 200) {
    return { ok: false, reason: "alerts.json has no usable id" };
  }
  if (!Number.isInteger(json.count) || json.count < 1) {
    return { ok: false, reason: "alerts.json has no alerts in this batch", quiet: true };
  }
  const bodyError = checkBody("alerts.json", json);
  if (bodyError) {
    return { ok: false, reason: bodyError };
  }
  const fresh = checkFresh("alerts.json", json.generatedAt, nowMs, cfg.maxAgeHours.alerts);
  if (fresh.error) {
    return { ok: false, reason: fresh.error, quiet: true };
  }
  return { ok: true, content: { key: `alerts:${json.id.trim()}`, subject: json.subject, html: json.html, text: json.text } };
}

export function parseMonthly(json, { nowMs }) {
  const bodyError = checkBody("latest-email.json", json);
  if (bodyError) {
    return { ok: false, reason: bodyError };
  }
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(json.month ?? ""));
  if (!match) {
    return { ok: false, reason: "latest-email.json month must look like 2026-09" };
  }
  // The report is sent on the 1st for the month that just ended. Accept the
  // current or previous month and nothing older.
  const now = new Date(nowMs);
  const index = (year, month) => year * 12 + month;
  const current = index(now.getUTCFullYear(), now.getUTCMonth() + 1);
  const reportIndex = index(Number(match[1]), Number(match[2]));
  if (reportIndex > current || reportIndex < current - 1) {
    return { ok: false, reason: `latest-email.json is for ${json.month}, not the current or previous month` };
  }
  return { ok: true, content: { key: `monthly:${json.month}`, subject: json.subject, html: json.html, text: json.text } };
}

export const CONTENT_SOURCES = Object.freeze({
  digest: { path: "/digest.json", parse: parseDigest },
  alerts: { path: "/alerts.json", parse: parseAlerts },
  monthly: { path: "/reports/latest-email.json", parse: parseMonthly },
});

// ----------------------------------------------------------------- delivery

const CANDIDATES_FROM =
  "FROM subscriptions x JOIN subscribers s ON s.id = x.subscriber_id " +
  "LEFT JOIN sends d ON d.subscriber_id = s.id AND d.list = x.list AND d.content_key = ? " +
  "WHERE x.list = ? AND s.status = 'active' " +
  "AND (d.subscriber_id IS NULL OR (d.status = 'failed' AND d.attempts < ?))";

// Inserts the claim, or takes over a retryable failed row. RETURNING yields a
// row only when this run got the claim, so no row means another run already
// claimed or finished this delivery.
const CLAIM_SQL =
  "INSERT INTO sends (subscriber_id, list, content_key, status, attempts, created_at, updated_at) " +
  "VALUES (?, ?, ?, 'sending', 1, ?, ?) " +
  "ON CONFLICT (subscriber_id, list, content_key) DO UPDATE SET " +
  "status = 'sending', attempts = sends.attempts + 1, updated_at = excluded.updated_at " +
  "WHERE sends.status = 'failed' AND sends.attempts < ? RETURNING subscriber_id";

function errorText(result) {
  return `${result.code || "error"}: ${result.message}`.slice(0, 300);
}

async function deliverOne(ctx, list, content, row, stats) {
  const { db, cfg } = ctx;
  const nowSec = () => Math.floor(ctx.now() / 1000);
  const claim = await db
    .prepare(CLAIM_SQL)
    .bind(row.id, list, content.key, nowSec(), nowSec(), cfg.maxAttempts)
    .first();
  if (!claim) {
    stats.duplicate += 1;
    return;
  }
  stats.attempted += 1;

  const settle = (status, fields = {}) =>
    db
      .prepare(
        "UPDATE sends SET status = ?, message_id = ?, error = ?, updated_at = ?, " +
          "attempts = CASE WHEN ? THEN MAX(attempts - 1, 0) ELSE attempts END " +
          "WHERE subscriber_id = ? AND list = ? AND content_key = ?",
      )
      .bind(status, fields.messageId ?? null, fields.error ?? null, nowSec(), fields.release ? 1 : 0, row.id, list, content.key)
      .run();

  let result;
  try {
    const message = await buildEmail(ctx, {
      to: row.email,
      subject: content.subject,
      html: content.html,
      text: content.text,
      listId: list,
    });
    result = await sendEmail(ctx, message);
  } catch (error) {
    result = { ok: false, code: "", message: String(error?.message ?? error) };
  }

  try {
    if (result.ok) {
      stats.sent += 1;
      stats.consecutiveFailures = 0;
      await settle("sent", { messageId: result.messageId });
      return;
    }
    const kind = classifySendError({ code: result.code });
    if (kind === "suppressed") {
      stats.suppressed += 1;
      await settle("suppressed", { error: errorText(result) });
    } else if (kind === "stop") {
      stats.stopped = `${result.code}: ${result.message}`.slice(0, 200);
      // Not this recipient's fault, so it keeps its attempt.
      await settle("failed", { error: errorText(result), release: true });
    } else {
      stats.failed += 1;
      stats.consecutiveFailures += 1;
      if (stats.consecutiveFailures >= cfg.maxConsecutiveFailures) {
        stats.stopped = `${stats.consecutiveFailures} sends in a row failed`;
      }
      await settle("failed", { error: errorText(result) });
      ctx.log("warn", "send failed", { list, key: content.key, to: maskEmail(row.email), code: result.code });
    }
  } catch (error) {
    // The message may already be out. The row stays "sending", which is never
    // retried, so the worst case is a missed email and never a duplicate.
    ctx.log("error", "could not record a send outcome", { list, key: content.key, error: String(error?.message ?? error) });
  }
}

// Sends `content` to every active subscriber of `list` that has not had this
// content_key yet, up to budget.remaining sends. One recipient failing never
// stops the others. Halts early only on a platform limit or a problem that
// would hit every recipient. Records progress in `jobs` so a later tick resumes.
export async function deliverList(ctx, list, content, budget) {
  const { db, cfg } = ctx;
  const stats = {
    list,
    key: content.key,
    attempted: 0,
    sent: 0,
    suppressed: 0,
    failed: 0,
    duplicate: 0,
    consecutiveFailures: 0,
    stopped: null,
    remaining: 0,
  };

  const take = Math.max(0, Math.floor(budget.remaining));
  const rows = take
    ? (
        await db
          .prepare(`SELECT s.id AS id, s.email AS email ${CANDIDATES_FROM} ORDER BY s.id LIMIT ?`)
          .bind(content.key, list, cfg.maxAttempts, take)
          .all()
      ).results ?? []
    : [];

  for (let i = 0; i < rows.length && !stats.stopped; i += cfg.concurrency) {
    const chunk = rows.slice(i, i + cfg.concurrency);
    await Promise.all(chunk.map((row) => deliverOne(ctx, list, content, row, stats)));
    budget.remaining -= chunk.length;
  }

  const left = await db
    .prepare(`SELECT COUNT(*) AS n ${CANDIDATES_FROM}`)
    .bind(content.key, list, cfg.maxAttempts)
    .first();
  stats.remaining = Number(left?.n ?? 0);
  await db
    .prepare(
      "INSERT INTO jobs (list, content_key, status, sent, failed, updated_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (list, content_key) DO UPDATE SET status = excluded.status, " +
        "sent = jobs.sent + excluded.sent, failed = jobs.failed + excluded.failed, updated_at = excluded.updated_at",
    )
    .bind(list, content.key, stats.remaining ? "partial" : "done", stats.sent, stats.failed, Math.floor(ctx.now() / 1000))
    .run();

  ctx.log(stats.stopped || stats.failed ? "warn" : "info", "delivery run", {
    list,
    key: content.key,
    sent: stats.sent,
    failed: stats.failed,
    suppressed: stats.suppressed,
    remaining: stats.remaining,
    stopped: stats.stopped,
  });
  return stats;
}

// Fetches one list's content and delivers it. A failed or missing fetch, or
// content that fails its contract, sends nothing and logs why.
export async function runList(ctx, list, budget) {
  const source = CONTENT_SOURCES[list];
  const fetched = await fetchContent(ctx, source.path);
  if (!fetched.ok) {
    ctx.log("warn", `${list}: nothing sent`, { reason: fetched.reason });
    return { list, sent: 0, skipped: fetched.reason };
  }
  const parsed = source.parse(fetched.json, { nowMs: ctx.now(), cfg: ctx.cfg });
  if (!parsed.ok) {
    ctx.log(parsed.quiet ? "info" : "warn", `${list}: nothing sent`, { reason: parsed.reason });
    return { list, sent: 0, skipped: parsed.reason };
  }
  return deliverList(ctx, list, parsed.content, budget);
}

// The digest and monthly report each have one cron time, and the site may not
// have published yet when it fires. Every 30-minute tick after that time keeps
// trying until the day's (or month's) send has finished.
export async function needsCatchUp(ctx, list) {
  const now = new Date(ctx.now());
  const nowSec = Math.floor(ctx.now() / 1000);
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let windowOpen = false;
  let since = 0;
  // Windows follow the cron constants, so moving the digest an hour for
  // daylight saving time moves its catch-up window too. Catch-up starts on the
  // first tick after the scheduled run and never before it.
  if (list === "digest") {
    const start = cronMinutes(CRON_DIGEST) + 25;
    windowOpen = minutes >= start && minutes < start + 330;
    since = nowSec - (nowSec % DAY);
  } else if (list === "monthly") {
    const day = now.getUTCDate();
    windowOpen = (day === 1 && minutes >= cronMinutes(CRON_MONTHLY) + 25) || day === 2 || day === 3;
    since = nowSec - 3 * DAY;
  }
  if (!windowOpen) {
    return false;
  }
  const done = await ctx.db
    .prepare("SELECT 1 AS ok FROM jobs WHERE list = ? AND status = 'done' AND updated_at >= ?")
    .bind(list, since)
    .first();
  return !done;
}

export async function housekeeping(ctx) {
  const nowSec = Math.floor(ctx.now() / 1000);
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(nowSec - 2 * DAY),
    // Addresses that never confirmed are not kept.
    ctx.db
      .prepare("DELETE FROM subscribers WHERE status = 'pending' AND confirmed_at IS NULL AND created_at < ?")
      .bind(nowSec - 30 * DAY),
    ctx.db.prepare("DELETE FROM sends WHERE created_at < ?").bind(nowSec - 400 * DAY),
    ctx.db.prepare("DELETE FROM jobs WHERE updated_at < ?").bind(nowSec - 400 * DAY),
  ]);
  await teamHousekeeping(ctx);
}

export async function runScheduled(ctx, cron) {
  const budget = { remaining: ctx.cfg.maxSendsPerRun };
  const results = [];
  if (cron === CRON_ALERTS) {
    results.push(await runList(ctx, "alerts", budget));
    for (const list of ["digest", "monthly"]) {
      if (budget.remaining > 0 && (await needsCatchUp(ctx, list))) {
        results.push(await runList(ctx, list, budget));
      }
    }
  } else if (cron === CRON_DIGEST) {
    await housekeeping(ctx);
    results.push(await runList(ctx, "digest", budget));
  } else if (cron === CRON_MONTHLY) {
    results.push(await runList(ctx, "monthly", budget));
  } else {
    ctx.log("warn", "unrecognized cron", { cron });
  }
  return results;
}

// -------------------------------------------------------------------- pages

const PAGE_CSS = `
:root{--fg:#111;--muted:#555;--link:#00c;--visited:#551a8b;--rule:#ccc;--surface:#f5f8fc;--bar-1:#0033a0;--bar-2:#111;--bar-3:#418fde;--bg:#fff}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 Helvetica,Arial,sans-serif}
.page{max-width:560px;margin:0 auto;padding:18px 16px 48px}
.topbar{font-size:.9rem;margin-bottom:24px}
h1{margin:0 0 6px;font-size:1.65rem}
.tricolor{display:flex;height:5px;margin:0 0 18px}.tricolor span{flex:1}
.c1{background:var(--bar-1)}.c2{background:var(--bar-2)}.c3{background:var(--bar-3)}
a{color:var(--link)}a:visited{color:var(--visited)}
fieldset{border:1px solid var(--rule);margin:16px 0;padding:8px 14px}
label.opt{display:block;margin:10px 0}
label.opt small{display:block;color:var(--muted)}
button{font:inherit;padding:6px 14px;border:1px solid var(--fg);background:var(--bg);color:var(--fg);cursor:pointer;margin-right:8px}
button:hover{background:var(--surface)}
footer{margin-top:28px;font-size:.8rem;color:var(--muted)}
.affiliation{margin:0;padding:10px 12px;border:2px solid var(--bar-1);border-radius:4px;color:var(--fg);font-size:15px}
.affiliation strong{color:var(--bar-1)}
`;

export function renderPage({ title, heading, bodyHtml, cfg }) {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>` +
    `<style>${PAGE_CSS}</style></head><body><div class="page">` +
    `<div class="topbar"><a href="${escapeHtml(cfg.siteUrl)}/">Cerulean News</a> &middot; <a href="${escapeHtml(cfg.siteUrl)}/subscribe">Email subscriptions</a></div>` +
    `<h1>${escapeHtml(heading)}</h1><div class="tricolor" aria-hidden="true"><span class="c1"></span><span class="c2"></span><span class="c3"></span></div>` +
    `${bodyHtml}<footer><p class="affiliation"><strong>Not affiliated.</strong> Cerulean News is an independent personal project. ` +
    `It is not affiliated with, endorsed by, or operated by Blue Cross and Blue Shield of Vermont or the Blue Cross Blue Shield Association.</p></footer>` +
    `</div></body></html>`
  );
}

export const BASE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex",
};

export function htmlResponse(ctx, status, { title, heading, bodyHtml }, extraHeaders = {}) {
  return new Response(renderPage({ title, heading, bodyHtml, cfg: ctx.cfg }), {
    status,
    headers: {
      ...BASE_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      ...extraHeaders,
    },
  });
}

export function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

export function wantsJson(request) {
  const accept = request.headers.get("accept") || "";
  const type = request.headers.get("content-type") || "";
  return accept.includes("application/json") || type.includes("application/json");
}

// One place that answers in the form the caller asked for.
export function reply(ctx, request, status, { title, heading, message, extraHtml = "", json = {} }, extraHeaders = {}) {
  if (wantsJson(request)) {
    return jsonResponse(status, { ok: status < 400, message, ...json }, extraHeaders);
  }
  return htmlResponse(
    ctx,
    status,
    { title, heading, bodyHtml: `<p>${escapeHtml(message)}</p>${extraHtml}` },
    extraHeaders,
  );
}

const MAX_BODY_CHARS = 8192;

// Reads a JSON or form-encoded body into a plain object; null if unreadable.
export async function readBody(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BODY_CHARS) {
    return null;
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY_CHARS) {
    return null;
  }
  const type = (request.headers.get("content-type") || "").toLowerCase();
  if (type.includes("application/json")) {
    try {
      const value = JSON.parse(raw);
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }
  if (type.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(raw);
    const body = {};
    for (const key of new Set(params.keys())) {
      const all = params.getAll(key);
      body[key] = key === "lists" || key === "list" ? all : all[0];
    }
    return body;
  }
  return null;
}

// ---------------------------------------------------------------- endpoints

export function nowSecOf(ctx) {
  return Math.floor(ctx.now() / 1000);
}

export function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "unknown";
}

const SUBSCRIBE_NOTICE =
  "Check your inbox. If that address can be subscribed, a confirmation email is on its way, and nothing is sent to you until you confirm. " +
  "Nothing there after a few minutes? Look in spam, then try again in ten minutes.";

function subscribeOk(ctx, request) {
  return reply(ctx, request, 200, {
    title: "Check your inbox",
    heading: "Check your inbox",
    message: SUBSCRIBE_NOTICE,
    json: { pending: true },
  });
}

async function findSubscriber(ctx, email) {
  return ctx.db.prepare("SELECT * FROM subscribers WHERE email = ?").bind(email).first();
}

async function sendConfirmation(ctx, email, lists, nonce) {
  const nowSec = nowSecOf(ctx);
  const token = await signToken(ctx.secret, { p: "confirm", e: email, n: nonce, x: nowSec + ctx.cfg.confirmTtlSec });
  const content = buildConfirmationContent(`${ctx.cfg.apiBase}/confirm?token=${token}`, lists);
  const message = await buildEmail(ctx, { to: email, ...content, transactional: true });
  return sendEmail(ctx, message);
}

// POST /api/mail/subscribe. The response is identical whether or not the
// address already exists, is suppressed, or was rate limited per address.
export async function handleSubscribe(request, ctx) {
  const { cfg, db } = ctx;
  const origin = request.headers.get("origin");
  if (origin && origin !== cfg.siteUrl) {
    return reply(ctx, request, 403, {
      title: "Not allowed",
      heading: "Not allowed",
      message: "Please subscribe from cerulean.news.",
      json: { error: "bad_origin" },
    });
  }
  const body = await readBody(request);
  if (!body) {
    return reply(ctx, request, 400, {
      title: "Bad request",
      heading: "Bad request",
      message: "Send an email address and at least one list.",
      json: { error: "bad_body" },
    });
  }

  // A hidden field real visitors never fill. Answer like a success and do nothing.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    return subscribeOk(ctx, request);
  }

  const nowSec = nowSecOf(ctx);
  const ipKey = await hashIp(ctx.secret, clientIp(request));
  const perIp = await hitRateLimit(db, `sub:${ipKey}`, { limit: cfg.subscribeLimitPerHour, windowSec: HOUR, nowSec });
  if (!perIp.allowed) {
    return reply(
      ctx,
      request,
      429,
      {
        title: "Too many requests",
        heading: "Too many requests",
        message: "Too many sign-ups from this connection. Please try again later.",
        json: { error: "rate_limited" },
      },
      { "retry-after": String(perIp.retryAfterSec) },
    );
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
  const lists = normalizeLists(body.lists ?? body.list);
  if (!lists || lists.length === 0) {
    return reply(ctx, request, 400, {
      title: "Choose a list",
      heading: "Choose a list",
      message: `Choose at least one of: ${LIST_IDS.join(", ")}.`,
      json: { error: "invalid_lists" },
    });
  }

  const existing = await findSubscriber(ctx, email);
  if (existing?.confirm_sent_at && nowSec - existing.confirm_sent_at < cfg.confirmCooldownSec) {
    // A confirmation went out moments ago. Send no more so the form cannot be
    // used to mail-bomb an address, and answer as usual.
    return subscribeOk(ctx, request);
  }

  // A daily ceiling on confirmation emails keeps a flood of sign-ups from using
  // up the account's sending quota. It counts only emails about to be sent.
  const global = await hitRateLimit(db, "sub:global", { limit: cfg.confirmationsPerDay, windowSec: DAY, nowSec });
  if (!global.allowed) {
    return reply(
      ctx,
      request,
      429,
      {
        title: "Try again later",
        heading: "Try again later",
        message: "We are receiving a lot of sign-ups. Please try again later.",
        json: { error: "rate_limited" },
      },
      { "retry-after": String(global.retryAfterSec) },
    );
  }

  const nonce = crypto.randomUUID().replace(/-/g, "");
  if (existing) {
    await db
      .prepare("UPDATE subscribers SET pending_lists = ?, confirm_nonce = ?, confirm_sent_at = ?, updated_at = ? WHERE id = ?")
      .bind(lists.join(","), nonce, nowSec, nowSec, existing.id)
      .run();
  } else {
    await db
      .prepare(
        "INSERT INTO subscribers (email, status, pending_lists, confirm_nonce, confirm_sent_at, created_at, updated_at) " +
          "VALUES (?, 'pending', ?, ?, ?, ?, ?)",
      )
      .bind(email, lists.join(","), nonce, nowSec, nowSec, nowSec)
      .run();
  }

  const sent = await sendConfirmation(ctx, email, lists, nonce);
  if (!sent.ok) {
    ctx.log("warn", "confirmation not sent", { to: maskEmail(email), code: sent.code });
    // Allow an immediate retry.
    await db.prepare("UPDATE subscribers SET confirm_sent_at = NULL WHERE email = ?").bind(email).run();
    // Anything about the recipient (suppressed, undeliverable) looks like
    // success. Only our own trouble is reported.
    const ours = ["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", "E_INTERNAL_SERVER_ERROR", "E_SENDER_NOT_VERIFIED", "E_SENDER_DOMAIN_NOT_AVAILABLE"];
    if (ours.includes(sent.code)) {
      return reply(ctx, request, 503, {
        title: "Try again later",
        heading: "Try again later",
        message: "We could not send the confirmation email just now. Please try again in a little while.",
        json: { error: "send_unavailable" },
      });
    }
  }
  return subscribeOk(ctx, request);
}

async function activeLists(ctx, subscriberId) {
  const rows = await ctx.db
    .prepare("SELECT list FROM subscriptions WHERE subscriber_id = ?")
    .bind(subscriberId)
    .all();
  const have = new Set((rows.results ?? []).map((row) => row.list));
  return LIST_IDS.filter((id) => have.has(id));
}

async function manageLinks(ctx, email) {
  const token = await signToken(ctx.secret, { p: "manage", e: email, x: nowSecOf(ctx) + ctx.cfg.manageTtlSec });
  return `${ctx.cfg.apiBase}/preferences?token=${token}`;
}

function invalidLink(ctx, request, what) {
  return reply(ctx, request, 400, {
    title: "Link not valid",
    heading: "This link is not valid",
    message: `This ${what} link is invalid or has expired.`,
    extraHtml: `<p><a href="${escapeHtml(ctx.cfg.siteUrl)}/subscribe">Subscribe again</a></p>`,
    json: { error: "invalid_token" },
  });
}

// GET /api/mail/confirm?token=. Single use: the newest confirmation link's
// nonce must match. Repeat visits to a used link (mail scanners often open
// links first) report "already confirmed" instead of an error.
export async function handleConfirm(request, ctx, url) {
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: BASE_HEADERS });
  }
  const verified = await verifyToken(ctx.secret, url.searchParams.get("token"), {
    purpose: "confirm",
    nowSec: nowSecOf(ctx),
  });
  if (!verified.ok) {
    return invalidLink(ctx, request, "confirmation");
  }
  const { e: email, n: nonce } = verified.payload;
  const sub = await findSubscriber(ctx, email);
  if (!sub || !nonce || sub.confirm_nonce !== nonce) {
    return invalidLink(ctx, request, "confirmation");
  }
  const nowSec = nowSecOf(ctx);
  if (sub.pending_lists) {
    const lists = normalizeLists(sub.pending_lists.split(",")) ?? [];
    await ctx.db.batch([
      ...lists.map((list) =>
        ctx.db.prepare("INSERT OR IGNORE INTO subscriptions (subscriber_id, list, created_at) VALUES (?, ?, ?)").bind(sub.id, list, nowSec),
      ),
      ctx.db
        .prepare(
          "UPDATE subscribers SET status = 'active', pending_lists = NULL, confirmed_at = COALESCE(confirmed_at, ?), " +
            "unsubscribed_at = NULL, updated_at = ? WHERE id = ?",
        )
        .bind(nowSec, nowSec, sub.id),
    ]);
  }
  const lists = await activeLists(ctx, sub.id);
  const labels = lists.map((id) => LISTS[id].label);
  const prefsUrl = await manageLinks(ctx, email);
  return reply(ctx, request, 200, {
    title: "Subscription confirmed",
    heading: "You are subscribed",
    message: labels.length ? `You will receive: ${labels.join(", ")}.` : "Your subscription is confirmed.",
    extraHtml: `<p>Every email has a link to unsubscribe. You can also <a href="${escapeHtml(prefsUrl)}">change your lists</a> at any time.</p>`,
    json: { lists },
  });
}

async function unsubscribeEmail(ctx, email) {
  const nowSec = nowSecOf(ctx);
  await ctx.db.batch([
    ctx.db
      .prepare("DELETE FROM subscriptions WHERE subscriber_id IN (SELECT id FROM subscribers WHERE email = ?)")
      .bind(email),
    ctx.db
      .prepare(
        "UPDATE subscribers SET status = 'unsubscribed', pending_lists = NULL, unsubscribed_at = ?, updated_at = ? " +
          "WHERE email = ? AND status != 'unsubscribed'",
      )
      .bind(nowSec, nowSec, email),
  ]);
}

// GET or POST /api/mail/unsubscribe?token=. The POST is the RFC 8058 one-click
// request a mail client sends for the List-Unsubscribe header. The token is the
// credential, so the body is not required.
export async function handleUnsubscribe(request, ctx, url) {
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: BASE_HEADERS });
  }
  const verified = await verifyToken(ctx.secret, url.searchParams.get("token"), {
    purpose: "manage",
    nowSec: nowSecOf(ctx),
  });
  if (!verified.ok) {
    return invalidLink(ctx, request, "unsubscribe");
  }
  const email = verified.payload.e;
  await unsubscribeEmail(ctx, email);
  const prefsUrl = await manageLinks(ctx, email);
  return reply(ctx, request, 200, {
    title: "Unsubscribed",
    heading: "You are unsubscribed",
    message: "You will not receive any more Cerulean News email.",
    extraHtml: `<p>Changed your mind? <a href="${escapeHtml(prefsUrl)}">Choose your lists again</a>.</p>`,
    json: { unsubscribed: true },
  });
}

function preferencesForm(ctx, token, sub, current) {
  const canEdit = Boolean(sub.confirmed_at);
  const boxes = LIST_IDS.map(
    (id) =>
      `<label class="opt"><input type="checkbox" name="lists" value="${id}"${current.includes(id) ? " checked" : ""}> ` +
      `${escapeHtml(LISTS[id].label)}<small>${escapeHtml(LISTS[id].description)}</small></label>`,
  ).join("");
  const action = `${ctx.cfg.apiBase}/preferences?token=${encodeURIComponent(token)}`;
  if (!canEdit) {
    return (
      `<p>This address is not confirmed yet. Use the link in your confirmation email to start receiving mail.</p>` +
      `<form method="post" action="${escapeHtml(action)}"><button type="submit" name="action" value="unsubscribe">Cancel and forget this request</button></form>`
    );
  }
  return (
    `<form method="post" action="${escapeHtml(action)}"><fieldset><legend>Send ${escapeHtml(sub.email)}</legend>${boxes}</fieldset>` +
    `<button type="submit">Save</button>` +
    `<button type="submit" name="action" value="unsubscribe">Unsubscribe from everything</button></form>`
  );
}

// GET shows the form. POST saves a list selection, or unsubscribes when the
// selection is empty or action=unsubscribe. Changing lists needs no new
// confirmation: the signed link already proves control of the mailbox.
export async function handlePreferences(request, ctx, url) {
  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers: BASE_HEADERS });
  }
  const token = url.searchParams.get("token");
  const verified = await verifyToken(ctx.secret, token, { purpose: "manage", nowSec: nowSecOf(ctx) });
  if (!verified.ok) {
    return invalidLink(ctx, request, "preferences");
  }
  const email = verified.payload.e;
  const sub = await findSubscriber(ctx, email);
  if (!sub) {
    return reply(ctx, request, 404, {
      title: "Not found",
      heading: "Not found",
      message: "We could not find a subscription for this link.",
      json: { error: "not_found" },
    });
  }

  if (request.method === "POST") {
    const body = (await readBody(request)) ?? {};
    if (body.action === "unsubscribe") {
      await unsubscribeEmail(ctx, email);
      return reply(ctx, request, 200, {
        title: "Unsubscribed",
        heading: "You are unsubscribed",
        message: "You will not receive any more Cerulean News email.",
        json: { unsubscribed: true, lists: [] },
      });
    }
    const raw = body.lists ?? body.list ?? [];
    const lists = normalizeLists(raw);
    if (!lists) {
      return reply(ctx, request, 400, {
        title: "Choose a list",
        heading: "Choose a list",
        message: `Lists can be: ${LIST_IDS.join(", ")}.`,
        json: { error: "invalid_lists" },
      });
    }
    if (!sub.confirmed_at) {
      return reply(ctx, request, 400, {
        title: "Not confirmed",
        heading: "Not confirmed yet",
        message: "Confirm your address from the confirmation email first.",
        json: { error: "not_confirmed" },
      });
    }
    if (lists.length === 0) {
      await unsubscribeEmail(ctx, email);
      return reply(ctx, request, 200, {
        title: "Unsubscribed",
        heading: "You are unsubscribed",
        message: "No lists were selected, so you will not receive any more Cerulean News email.",
        json: { unsubscribed: true, lists: [] },
      });
    }
    const nowSec = nowSecOf(ctx);
    await ctx.db.batch([
      ctx.db.prepare("DELETE FROM subscriptions WHERE subscriber_id = ?").bind(sub.id),
      ...lists.map((list) =>
        ctx.db.prepare("INSERT INTO subscriptions (subscriber_id, list, created_at) VALUES (?, ?, ?)").bind(sub.id, list, nowSec),
      ),
      ctx.db
        .prepare("UPDATE subscribers SET status = 'active', pending_lists = NULL, unsubscribed_at = NULL, updated_at = ? WHERE id = ?")
        .bind(nowSec, sub.id),
    ]);
    return reply(ctx, request, 200, {
      title: "Saved",
      heading: "Saved",
      message: `You will receive: ${lists.map((id) => LISTS[id].label).join(", ")}.`,
      json: { lists },
    });
  }

  const current = sub.status === "active" ? await activeLists(ctx, sub.id) : [];
  if (wantsJson(request)) {
    return jsonResponse(200, { ok: true, email, status: sub.status, lists: current });
  }
  return htmlResponse(ctx, 200, {
    title: "Your Cerulean News emails",
    heading: "Your emails",
    bodyHtml: preferencesForm(ctx, token, sub, current),
  });
}

export async function handleRequest(request, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = request.method;
  try {
    if (!ctx.secret || String(ctx.secret).length < 16) {
      ctx.log("error", "MAIL_SIGNING_SECRET is missing or too short");
      return reply(ctx, request, 500, {
        title: "Unavailable",
        heading: "Unavailable",
        message: "Email subscriptions are not available right now.",
        json: { error: "not_configured" },
      });
    }
    const allow = (methods, handler) =>
      methods.includes(method)
        ? handler()
        : jsonResponse(405, { ok: false, error: "method_not_allowed" }, { allow: methods.join(", ") });
    switch (path) {
      case "/api/mail/subscribe":
        return await allow(["POST"], () => handleSubscribe(request, ctx));
      case "/api/mail/confirm":
        return await allow(["GET", "HEAD"], () => handleConfirm(request, ctx, url));
      case "/api/mail/unsubscribe":
        return await allow(["GET", "HEAD", "POST"], () => handleUnsubscribe(request, ctx, url));
      case "/api/mail/preferences":
        return await allow(["GET", "HEAD", "POST"], () => handlePreferences(request, ctx, url));
      default: {
        // Team sign-in and feedback votes: /api/mail/team/* and /api/mail/feedback*.
        const team = await handleTeamRequest(request, ctx, url, path);
        return team || jsonResponse(404, { ok: false, error: "not_found" });
      }
    }
  } catch (error) {
    ctx.log("error", "request failed", { path, error: String(error?.stack ?? error) });
    return reply(ctx, request, 500, {
      title: "Something went wrong",
      heading: "Something went wrong",
      message: "Something went wrong on our side. Please try again later.",
      json: { error: "internal" },
    });
  }
}

// -------------------------------------------------------------------- shell

function defaultLog(level, message, fields = {}) {
  const line = JSON.stringify({ level, message, ...fields });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export function makeContext(env, overrides = {}) {
  return {
    env,
    cfg: settings(env),
    db: env.DB,
    email: env.EMAIL,
    secret: env.MAIL_SIGNING_SECRET,
    fetch: (...args) => globalThis.fetch(...args),
    now: () => Date.now(),
    log: defaultLog,
    // Set by the Workers shell so work that must not delay a response (the
    // sign-in email) runs after it. Without it the work is awaited.
    defer: null,
    ...overrides,
  };
}

export default {
  async fetch(request, env, executionContext) {
    return handleRequest(
      request,
      makeContext(env, { defer: (promise) => executionContext?.waitUntil?.(promise) }),
    );
  },

  async scheduled(controller, env) {
    const ctx = makeContext(env);
    try {
      await runScheduled(ctx, controller.cron);
    } catch (error) {
      ctx.log("error", "scheduled run failed", { cron: controller.cron, error: String(error?.stack ?? error) });
      throw error;
    }
  },
};
