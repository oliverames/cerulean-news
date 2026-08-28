// Source-failure alerting: consecutive-failure streaks and webhook pings.
import { createHash } from "node:crypto";
import { cleanText, parsePositiveInteger } from "./utils.js";

// One-off fetch failures are routine across public feeds, so webhook
// alerts fire only when a source crosses this many consecutive failed runs
// (~a day at the hourly cadence). Streaks persist in the audit JSON.
const WEBHOOK_FAILURE_THRESHOLD = parsePositiveInteger(
  process.env.WEBHOOK_FAILURE_THRESHOLD,
  24,
);
const WEBHOOK_MESSAGE_MAX_CHARACTERS = 1800;

export function webhookTargetId(url) {
  const normalized = String(url || "").trim();
  if (!normalized) {
    return "";
  }
  return `wh_${createHash("sha256").update(normalized).digest("base64url").slice(0, 24)}`;
}

export function configuredWebhookTargets() {
  return [
    {
      id: webhookTargetId(process.env.SLACK_WEBHOOK_URL),
      label: "Slack",
      url: process.env.SLACK_WEBHOOK_URL || "",
      payloadKey: "text",
    },
    {
      id: webhookTargetId(process.env.DISCORD_WEBHOOK_URL),
      label: "Discord",
      url: process.env.DISCORD_WEBHOOK_URL || "",
      payloadKey: "content",
    },
  ].filter((target) => target.url);
}

export function applyFailureStreaks(
  sourceResults,
  previousStreaks = new Map(),
  previousAlertState = new Map(),
) {
  return sourceResults.map((result) => {
    if (result.ok) {
      return { ...result, consecutiveFailures: 0 };
    }
    const failureAlertDeliveries = [
      ...new Set(previousAlertState.get(result.name) || []),
    ].filter(Boolean);
    return {
      ...result,
      consecutiveFailures: (previousStreaks.get(result.name) || 0) + 1,
      ...(failureAlertDeliveries.length > 0
        ? { failureAlertDeliveries }
        : {}),
    };
  });
}

// Delivery state is endpoint-specific. A failed Slack attempt can retry on
// the next run without duplicating an alert already accepted by Discord.
export function selectFailureAlerts(
  sourceResults,
  threshold = WEBHOOK_FAILURE_THRESHOLD,
  targetIds = [],
) {
  return sourceResults.filter(
    (result) =>
      !result.ok &&
      result.consecutiveFailures >= threshold &&
      (targetIds.length === 0 ||
        targetIds.some((id) =>
          !(result.failureAlertDeliveries || []).includes(id),
        )),
  );
}

function buildFailureAlertBatches(
  failedSources,
  threshold = WEBHOOK_FAILURE_THRESHOLD,
  maxCharacters = WEBHOOK_MESSAGE_MAX_CHARACTERS,
) {
  const header =
    "⚠️ *Blue Cross VT News Mention Monitor Alert*\n" +
    `Sources failing for ${threshold}+ consecutive runs:`;
  const batches = [];
  let message = header;
  let sources = [];

  for (const source of failedSources) {
    const name = cleanText(source.name || "Unknown source").slice(0, 120);
    const error = cleanText(source.error || "Unknown error").slice(0, 240);
    let line = `\n- *${name}*: ${source.consecutiveFailures ?? "?"} consecutive failures (${error})`;
    const available = Math.max(1, maxCharacters - header.length - 2);
    if (line.length > available) {
      line = `${line.slice(0, available - 3)}...`;
    }
    if (message.length + line.length > maxCharacters && message !== header) {
      batches.push({ message, sources });
      message = header;
      sources = [];
    }
    message += line;
    sources.push(source);
  }

  if (message !== header) {
    batches.push({ message, sources });
  }
  return batches;
}

export function buildFailureAlertMessages(
  failedSources,
  threshold = WEBHOOK_FAILURE_THRESHOLD,
  maxCharacters = WEBHOOK_MESSAGE_MAX_CHARACTERS,
) {
  return buildFailureAlertBatches(
    failedSources,
    threshold,
    maxCharacters,
  ).map((batch) => batch.message);
}

async function postWebhookBatches(target, batches) {
  try {
    for (const batch of batches) {
      const response = await fetch(target.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [target.payloadKey]: batch.message }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          // The status is enough to report the failed delivery.
        }
        throw new Error(`HTTP ${response.status}`);
      }
      // Persist each accepted chunk immediately. If a later chunk fails, only
      // that chunk and those after it retry on the next run.
      for (const source of batch.sources) {
        source.failureAlertDeliveries = [
          ...new Set([
            ...(source.failureAlertDeliveries || []),
            target.id,
          ]),
        ];
      }
    }
    console.log(`Successfully sent ${target.label} alert.`);
    return true;
  } catch (error) {
    console.error(`Failed to send ${target.label} alert:`, error.message);
    return false;
  }
}

export async function triggerWebhooks(
  failedSources,
  targets = configuredWebhookTargets(),
) {
  if (failedSources.length === 0 || targets.length === 0) {
    return;
  }

  await Promise.all(
    targets.map(async (target) => {
      const pendingSources = failedSources.filter(
        (source) =>
          !(source.failureAlertDeliveries || []).includes(target.id),
      );
      if (pendingSources.length === 0) {
        return;
      }
      const batches = buildFailureAlertBatches(pendingSources);
      await postWebhookBatches(target, batches);
    }),
  );
}
