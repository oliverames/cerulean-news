// Source-failure alerting: consecutive-failure streaks and webhook pings.
import { parsePositiveInteger } from "./utils.js";

// One-off fetch failures are routine across public feeds, so webhook
// alerts fire only when a source crosses this many consecutive failed runs
// (~a day at the hourly cadence). Streaks persist in the audit JSON.
const WEBHOOK_FAILURE_THRESHOLD = parsePositiveInteger(
  process.env.WEBHOOK_FAILURE_THRESHOLD,
  24,
);

export function applyFailureStreaks(sourceResults, previousStreaks = new Map()) {
  return sourceResults.map((result) => ({
    ...result,
    consecutiveFailures: result.ok
      ? 0
      : (previousStreaks.get(result.name) || 0) + 1,
  }));
}

// Alert exactly when a source crosses the threshold — once per outage, not
// once per hour for the rest of the outage.
export function selectFailureAlerts(
  sourceResults,
  threshold = WEBHOOK_FAILURE_THRESHOLD,
) {
  return sourceResults.filter(
    (result) => !result.ok && result.consecutiveFailures === threshold,
  );
}

async function postWebhook(url, payload, label) {
  if (!url) return;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
    console.log(`Successfully sent ${label} alert.`);
  } catch (err) {
    console.error(`Failed to send ${label} alert:`, err.message);
  }
}

export async function triggerWebhooks(failedSources) {
  if (failedSources.length === 0) return;

  const message = `⚠️ *Blue Cross VT News Mention Monitor Alert*\nSources failing for ${WEBHOOK_FAILURE_THRESHOLD}+ consecutive runs:\n` +
    failedSources.map(s => `- *${s.name}*: ${s.consecutiveFailures ?? "?"} consecutive failures (${s.error})`).join("\n");

  await Promise.all([
    postWebhook(process.env.SLACK_WEBHOOK_URL, { text: message }, "Slack"),
    postWebhook(process.env.DISCORD_WEBHOOK_URL, { content: message }, "Discord"),
  ]);
}
