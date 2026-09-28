// Brand-mention alerts: tell the team when new press coverage names Blue Cross
// VT, and flag the unfavorable stories. Delivery reuses the failure-alert
// webhook helpers, and the "already alerted" set rides in the audit crawl state.
import { createHash } from "node:crypto";
import { cleanText } from "./utils.js";
import { shouldScoreSentiment } from "./summaries.js";
import { itemOutletName } from "./relevance.js";
import { configuredWebhookTargets, postWebhookBatches } from "./alerts.js";

// The stored set is bounded so the audit JSON cannot grow without limit.
export const BRAND_ALERT_MAX_KEYS = 2000;
// One message per run lists at most this many stories, then a "+N more" line.
export const BRAND_ALERT_MAX_ITEMS = 10;
// Discord rejects content over 2,000 characters. Slack takes far more, but a
// long alert stops being read, so it gets a tighter cap than its hard limit.
const DISCORD_MAX_CHARACTERS = 1900;
const SLACK_MAX_CHARACTERS = 3500;
const PRIORITY_SENTIMENTS = new Set(["negative", "neutral to negative"]);
const PRIORITY_SCORE_BELOW = 35;
const SUMMARY_LENGTHS = [140, 90, 50];

export function brandAlertsEnabled(env = process.env) {
  return String(env.BRAND_ALERTS || "").trim().toLowerCase() === "on";
}

// Keys are short hashes of the feed id, which keeps 2,000 of them small in the
// audit JSON. The same id the published feed uses, so a story keeps one key.
export function brandAlertKey(item) {
  const id = item?.guid || item?.link || item?.url || "";
  return id
    ? createHash("sha256").update(String(id)).digest("base64url").slice(0, 16)
    : "";
}

function boundKeys(keys) {
  const unique = new Map();
  for (const key of Array.isArray(keys) ? keys : []) {
    if (typeof key === "string" && key) {
      // Re-inserting moves a repeated key to the end, so the newest survive.
      unique.delete(key);
      unique.set(key, true);
    }
  }
  return [...unique.keys()].slice(-BRAND_ALERT_MAX_KEYS);
}

// `seeded` is false until a run has recorded the items that already existed.
// `undelivered` holds, per webhook endpoint (by hashed id, never the URL), the
// keys whose alert that endpoint has not accepted yet, so a failed endpoint
// retries on the next run without repeating one that already got the alert.
export function normalizeBrandAlertState(value) {
  const undelivered = {};
  if (value?.undelivered && typeof value.undelivered === "object") {
    for (const [targetId, keys] of Object.entries(value.undelivered)) {
      const bounded = boundKeys(keys);
      if (targetId && bounded.length > 0) {
        undelivered[targetId] = bounded;
      }
    }
  }
  return {
    seeded: Array.isArray(value?.keys) && value.seeded !== false,
    keys: boundKeys(value?.keys),
    undelivered,
  };
}

export function isPriorityBrandAlert(item) {
  const sentiment = cleanText(item?.sentiment || "").toLowerCase();
  const score = item?.sentimentScore;
  return (
    PRIORITY_SENTIMENTS.has(sentiment) ||
    (typeof score === "number" &&
      Number.isFinite(score) &&
      score < PRIORITY_SCORE_BELOW)
  );
}

// Priority stories lead. Order within each group is left as given.
function orderBrandAlertItems(items) {
  const priority = [];
  const rest = [];
  for (const item of items || []) {
    (isPriorityBrandAlert(item) ? priority : rest).push(item);
  }
  return [...priority, ...rest];
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 3).trimEnd()}...` : text;
}

// Accepts crawler items and published feed items alike.
function describeItem(item) {
  const label = cleanText(item.sentiment || "");
  const score =
    typeof item.sentimentScore === "number" && Number.isFinite(item.sentimentScore)
      ? Math.round(item.sentimentScore)
      : null;
  return {
    title: cleanText(item.title || "") || "Untitled",
    url: safeHttpUrl(item.link || item.url),
    outlet: cleanText(item.outlet || "") || cleanText(itemOutletName(item) || ""),
    sentiment: label
      ? `${label}${score === null ? "" : ` (score ${score})`}`
      : score === null
        ? "not yet scored"
        : `score ${score}`,
    summary: cleanText(item.summary || item.snippet || ""),
    priority: isPriorityBrandAlert(item),
  };
}

function formatChatLine(view, format, { titleMax, summaryMax, withLink }) {
  const discord = format === "discord";
  const escape = (text) =>
    discord
      ? text.replaceAll("@", "@​")
      : text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const title = escape(truncate(view.title, titleMax));
  let headline = title;
  if (view.url && withLink) {
    headline = discord
      ? `[${title.replaceAll("[", "(").replaceAll("]", ")")}](${view.url.replaceAll(")", "%29")})`
      : `<${view.url}|${title.replaceAll("|", "/")}>`;
  }
  const marker = view.priority ? (discord ? "🚨 **PRIORITY** " : "🚨 *PRIORITY* ") : "- ";
  const meta = [view.outlet && escape(view.outlet), escape(view.sentiment)]
    .filter(Boolean)
    .join(", ");
  const summary = summaryMax > 0 && view.summary ? `. ${escape(truncate(view.summary, summaryMax))}` : "";
  return `${marker}${headline}\n  ${meta}${summary}`;
}

// One message, priority stories first, shrunk to fit the endpoint's limit by
// shortening summaries and then listing fewer stories behind the "+N more" line.
export function buildBrandAlertMessage(
  items,
  { format = "slack", maxCharacters, maxItems = BRAND_ALERT_MAX_ITEMS } = {},
) {
  const views = orderBrandAlertItems(items).map(describeItem);
  if (views.length === 0) {
    return "";
  }
  const limit =
    maxCharacters ?? (format === "discord" ? DISCORD_MAX_CHARACTERS : SLACK_MAX_CHARACTERS);
  const bold = (text) => (format === "discord" ? `**${text}**` : `*${text}*`);
  const priorityCount = views.filter((view) => view.priority).length;
  const header =
    `📰 ${bold("Blue Cross VT News Mention Monitor")}\n` +
    `${views.length} new ${views.length === 1 ? "story names" : "stories name"} Blue Cross VT` +
    (priorityCount > 0 ? `, ${priorityCount} flagged unfavorable (listed first).` : ".");

  const build = (shown, options) => {
    const lines = views
      .slice(0, shown)
      .map((view) => formatChatLine(view, format, options));
    const more = views.length - shown;
    return [header, ...lines, ...(more > 0 ? [`+${more} more`] : [])].join("\n");
  };

  for (let shown = Math.min(maxItems, views.length); shown >= 1; shown -= 1) {
    for (const summaryMax of SUMMARY_LENGTHS) {
      const message = build(shown, { titleMax: 110, summaryMax, withLink: true });
      if (message.length <= limit) {
        return message;
      }
    }
  }
  // A single very long link can still overflow. Drop it rather than send a
  // truncated, broken one.
  return truncate(build(1, { titleMax: 80, summaryMax: 0, withLink: false }), limit);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatEmailDate(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.valueOf())) {
    return "";
  }
  return date.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// Email-safe rendering for later delivery to subscribers: nested tables and
// inline styles only, no scripts, styles blocks, or remote images. Every value
// is scraped text, so all of it is escaped and links must be http(s).
export function renderBrandAlertEmail(items, { now = new Date() } = {}) {
  const views = orderBrandAlertItems(items).map(describeItem);
  const shown = views.slice(0, BRAND_ALERT_MAX_ITEMS);
  const more = views.length - shown.length;
  const priorityCount = views.filter((view) => view.priority).length;
  const noun = views.length === 1 ? "story" : "stories";
  const subject =
    views.length === 0
      ? "Blue Cross VT coverage: no new stories"
      : `Blue Cross VT coverage: ${views.length} new ${noun}` +
        (priorityCount > 0 ? `, ${priorityCount} unfavorable` : "");
  const date = formatEmailDate(now);
  const siteUrl = safeHttpUrl(process.env.SITE_URL) || "https://cerulean.news/";

  const rows = shown
    .map((view) => {
      const headline = view.url
        ? `<a href="${escapeHtml(view.url)}" style="color:#0b5cad;text-decoration:underline;">${escapeHtml(view.title)}</a>`
        : escapeHtml(view.title);
      const cell = view.priority
        ? "padding:14px 20px;border-top:1px solid #e3e7eb;border-left:4px solid #b3261e;background-color:#fdf1f0;"
        : "padding:14px 20px;border-top:1px solid #e3e7eb;border-left:4px solid #ffffff;";
      const badge = view.priority
        ? `<div style="font-size:12px;font-weight:bold;letter-spacing:0.05em;color:#b3261e;padding-bottom:4px;">PRIORITY: UNFAVORABLE COVERAGE</div>`
        : "";
      const summary = view.summary
        ? `<div style="font-size:14px;line-height:1.5;color:#333333;padding-top:6px;">${escapeHtml(truncate(view.summary, 300))}</div>`
        : "";
      return (
        `<tr><td style="${cell}">${badge}` +
        `<div style="font-size:17px;line-height:1.35;font-weight:bold;">${headline}</div>` +
        `<div style="font-size:13px;line-height:1.4;color:#555555;padding-top:4px;">${escapeHtml(
          [view.outlet, view.sentiment].filter(Boolean).join(" | "),
        )}</div>${summary}</td></tr>`
      );
    })
    .join("\n");
  const moreRow =
    more > 0
      ? `<tr><td style="padding:14px 20px;border-top:1px solid #e3e7eb;font-size:14px;color:#555555;">+${more} more on <a href="${escapeHtml(siteUrl)}" style="color:#0b5cad;">Cerulean News</a></td></tr>`
      : "";
  const intro =
    views.length === 0
      ? "No new coverage."
      : `${views.length} new ${noun} name${views.length === 1 ? "s" : ""} Blue Cross VT` +
        (priorityCount > 0 ? `, ${priorityCount} flagged unfavorable (listed first).` : ".");

  const html = [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(subject)}</title></head>`,
    '<body style="margin:0;padding:0;background-color:#f4f6f8;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f6f8;"><tr><td align="center" style="padding:24px 12px;">',
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;background-color:#ffffff;font-family:Georgia,\'Times New Roman\',serif;color:#1a1a1a;">',
    `<tr><td style="padding:20px;"><div style="font-size:20px;font-weight:bold;">Blue Cross VT News Mention Monitor</div>` +
      (date ? `<div style="font-size:13px;color:#555555;padding-top:2px;">${escapeHtml(date)}</div>` : "") +
      `<div style="font-size:15px;line-height:1.5;padding-top:10px;">${escapeHtml(intro)}</div></td></tr>`,
    rows,
    moreRow,
    `<tr><td style="padding:16px 20px;border-top:1px solid #e3e7eb;font-size:12px;line-height:1.5;color:#777777;">Automated alert from Cerulean News. Sentiment is a model estimate, so read the story before acting on it. Not affiliated with Blue Cross and Blue Shield of Vermont.</td></tr>`,
    "</table></td></tr></table></body></html>",
  ]
    .filter(Boolean)
    .join("\n");

  const text = [
    "Blue Cross VT News Mention Monitor",
    ...(date ? [date] : []),
    "",
    intro,
    ...shown.flatMap((view) => [
      "",
      `${view.priority ? "[PRIORITY: UNFAVORABLE] " : ""}${view.title}`,
      [view.outlet, view.sentiment].filter(Boolean).join(" | "),
      ...(view.summary ? [truncate(view.summary, 300)] : []),
      ...(view.url ? [view.url] : []),
    ]),
    ...(more > 0 ? ["", `+${more} more on Cerulean News: ${siteUrl}`] : []),
    "",
    "Automated alert from Cerulean News. Sentiment is a model estimate. Not affiliated with Blue Cross and Blue Shield of Vermont.",
  ].join("\n");

  return { subject, html, text };
}

// Runs after Jev, so sentiment is final. The first run with no stored state
// records every current item and sends nothing, so deploying never floods the
// channel with the archive. With BRAND_ALERTS off, new items are still
// recorded but nothing is sent, so switching it on later starts from now.
// Returns a summary for the log and never throws: an alert must not fail a run.
export async function sendBrandAlerts(
  items,
  crawlState,
  { env = process.env, targets = configuredWebhookTargets() } = {},
) {
  try {
    const state = (crawlState.brandAlerts ||= normalizeBrandAlertState());
    const eligible = items.filter(shouldScoreSentiment);

    if (!state.seeded) {
      // Eligible items go last so the bound keeps them over older topic items.
      const eligibleSet = new Set(eligible);
      const ordered = [
        ...items.filter((item) => !eligibleSet.has(item)),
        ...eligible,
      ];
      state.keys = boundKeys(ordered.map(brandAlertKey));
      state.seeded = true;
      state.undelivered = {};
      console.log(`Brand alerts: recorded ${state.keys.length} existing items, nothing sent.`);
      return { seeded: true, fresh: 0, sent: 0 };
    }

    // Only judged-relevant coverage alerts; an unjudged item waits a run.
    const candidates = new Map();
    for (const item of eligible) {
      const key = brandAlertKey(item);
      if (key && item.relevant === true && !candidates.has(key)) {
        candidates.set(key, item);
      }
    }
    const known = new Set(state.keys);
    const freshKeys = [...candidates.keys()].filter((key) => !known.has(key));
    const enabled = brandAlertsEnabled(env);
    let sent = 0;

    if (!enabled) {
      state.undelivered = {};
    } else {
      const live = Object.fromEntries(
        targets.map((target) => [target.id, state.undelivered[target.id] || []]),
      );
      await Promise.all(
        targets.map(async (target) => {
          const pendingKeys = [...new Set([...live[target.id], ...freshKeys])];
          const pending = pendingKeys
            .map((key) => candidates.get(key))
            .filter(Boolean);
          if (pending.length === 0) {
            live[target.id] = [];
            return;
          }
          const format = target.payloadKey === "content" ? "discord" : "slack";
          const delivered = await postWebhookBatches(target, [
            { message: buildBrandAlertMessage(pending, { format }), sources: [] },
          ]);
          if (delivered) {
            sent += 1;
            live[target.id] = [];
          } else {
            live[target.id] = pending.map(brandAlertKey);
          }
        }),
      );
      state.undelivered = normalizeBrandAlertState({ undelivered: live }).undelivered;
    }

    state.keys = boundKeys([...state.keys, ...freshKeys]);
    return { seeded: false, fresh: freshKeys.length, sent };
  } catch (error) {
    console.error("Brand alert error:", error);
    return { seeded: false, fresh: 0, sent: 0, error: String(error?.message || error) };
  }
}
