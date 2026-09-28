# Cerulean News email subscriptions

Anyone can subscribe at [cerulean.news/subscribe](https://cerulean.news/subscribe), confirm by email (double opt-in), and choose any of three lists:

| List | What it sends | When |
| --- | --- | --- |
| `digest` | The daily clip digest | 11:05 UTC each day |
| `alerts` | Brand-mention alerts | Checked every 30 minutes |
| `monthly` | The monthly leadership report | 13:05 UTC on day 1 |

This is a separate Worker, `cerulean-news-mail`, so the parked `worker/` build is untouched. It owns `cerulean.news/api/mail/*`, keeps subscribers in D1, sends through the Cloudflare Email Service `send_email` binding, and fetches the content it mails from the public site.

Email Sending is in public beta. It needs the Workers Paid plan and `cerulean.news` onboarded as a sending domain.

## Files

| File | Purpose |
| --- | --- |
| `worker.js` | The Worker: endpoints, delivery, cron handlers. Pure functions are exported for tests |
| `wrangler.toml` | Name, bindings, route, cron triggers. `database_id` is a marked placeholder |
| `migrations/0001_init.sql` | D1 schema |
| `../site/subscribe.html` | The signup page |
| `../.github/workflows/deploy-mail.yml` | Dispatch-only deploy |
| `../test/mail.test.js` | Tests, run by `npm test` |

## Setup (Oliver)

1. **Upgrade to Workers Paid.** Email Sending and the 250-cron-trigger limit both need it. Cloudflare dashboard, Workers & Pages, Plans.
2. **Onboard `cerulean.news` in Email Service.** Dashboard, Compute, Email Service, Email Sending, Onboard Domain, pick `cerulean.news`. Cloudflare adds MX, SPF, DKIM, and DMARC records on the `cf-bounce` subdomain and `_dmarc.cerulean.news`. Check first that no other DMARC record exists at `_dmarc.cerulean.news`. Wait for the domain to show as verified, which is usually 5 to 15 minutes. Leave "Drop suppressed recipients" at its default (off) or turn it on, either works (see Suppressions below).
3. **Create the D1 database and put its id in `wrangler.toml`.** Run `npx wrangler@4 d1 create cerulean-news-mail`, then replace `REPLACE_WITH_D1_DATABASE_ID` in `mail/wrangler.toml` with the printed id and commit. The deploy workflow refuses to run while the placeholder is there.
4. **Set the `MAIL_SIGNING_SECRET` secret.** 1Password is its canonical home. Generate it once, save it there, then load it into the Worker:

   ```bash
   openssl rand -base64 48        # save the output in 1Password as "Cerulean News mail signing secret"
   op read "op://Private/Cerulean News mail signing secret/password" | npx wrangler@4 secret put MAIL_SIGNING_SECRET --name cerulean-news-mail
   ```

   Adjust the vault and item name to match. If the Worker does not exist yet, Wrangler offers to create it, which is fine. **Do not rotate this secret casually.** It signs every link, so a new value breaks every unsubscribe and preferences link in emails already sent. Rotating is only for a suspected leak.
5. **Widen the API token.** The existing `CLOUDFLARE_API_TOKEN` GitHub secret needs these permissions in addition to what Pages deploys use:
   - Account: Workers Scripts, Edit
   - Account: D1, Edit
   - Account: Email Sending, Edit
   - Zone `cerulean.news`: Workers Routes, Edit

   Edit the token in the Cloudflare dashboard (My Profile, API Tokens). The `CLOUDFLARE_ACCOUNT_ID` secret is already set.
6. **Run the deploy workflow.** GitHub, Actions, "Deploy mail Worker", Run workflow. It applies the D1 migrations, then deploys. New or changed cron triggers can take up to 15 minutes to start.
7. **Test with your own address.** Open the site's subscribe page, pick all three lists, and submit your address. Check the confirmation email arrives (look in spam the first time), click Confirm, then open the preferences link and the unsubscribe link from any email. To force a send without waiting, either publish the content files below and wait for a cron tick, or run the worker locally with `npx wrangler@4 dev --test-scheduled` and `curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=5+11+*+*+*"` (local sends are written to files, not delivered).

## Content contracts

The Worker fetches these from `https://cerulean.news` when a cron fires. Each is a JSON object. A missing file, a non-200 response, invalid JSON, or a missing field sends nothing and logs the reason (visible in Workers Logs).

Renderers must not add their own unsubscribe link or disclaimer. The Worker appends a personal unsubscribe link, a preferences link, and the required disclaimer to every message, in both the HTML and the plain-text part. Inline styles only in the HTML, since mail clients drop `<style>` blocks unpredictably.

### `/digest.json`

```json
{ "generatedAt": "2026-09-29T10:30:00Z", "subject": "...", "html": "...", "text": "...", "sections": [] }
```

- `subject`, `html`, and `text` must be non-empty strings. `sections` is not used by the mailer.
- `generatedAt` must be an ISO timestamp no more than 36 hours old (`DIGEST_MAX_AGE_HOURS`).
- Dedupe key: the UTC calendar date of `generatedAt`. Rebuilding the digest several times in one day sends it once. A stale file that was already delivered sends nothing.
- Publish it before 11:05 UTC. If it is late, the 30-minute ticks keep retrying until about 17:00 UTC.

### `/alerts.json`

```json
{ "id": "2026-09-29T10:47-3", "generatedAt": "2026-09-29T10:50:00Z", "subject": "...", "html": "...", "text": "...", "count": 3 }
```

- Written by `writeEmailAlerts` in `src/brand-alerts.js` on every run. `id` is stable for one batch of alerts and changes when the batch changes. It is the dedupe key, so reusing an id for new alerts would mean nobody receives them.
- A batch stays published until a newer one replaces it, so a run with nothing new keeps the last batch visible. A batch younger than 35 minutes is folded into the next one, so the 30-minute ticks cannot miss it. Past 12 hours the file publishes `count: 0`.
- The batch is independent of `BRAND_ALERTS`, which governs only the Slack and Discord webhooks.
- `count` is the number of alerts in the batch. Zero (or missing) sends nothing.
- `generatedAt` must be no more than 12 hours old (`ALERTS_MAX_AGE_HOURS`), so a stale file is never mailed to someone who joined later.

### `/reports/latest-email.json`

```json
{ "month": "2026-09", "subject": "...", "html": "...", "text": "..." }
```

- Written by `buildMonthlyReportPages` in `src/monthly-report.js`, beside the report pages, for the last complete Eastern month. `month` is `YYYY-MM` and must be the current or previous UTC month. On day 1 it is the month that just ended.
- Dedupe key: `month`. Publish it before 13:05 UTC on day 1. Ticks retry through day 3.

Each body (`html` plus `text`) may be up to 2 MiB. Cloudflare's own message limit is 5 MiB.

## Endpoints

All under `https://cerulean.news/api/mail`. Responses are small HTML pages in the site's look, or JSON when the request sends `Accept: application/json` or a JSON body.

| Request | What it does |
| --- | --- |
| `POST /subscribe` | Body `{ "email": "...", "lists": ["digest"] }`. Validates, stores a pending row, sends a confirmation email. Also accepts a plain form post |
| `GET /confirm?token=` | Confirms the pending lists. The link is single use, expires after 48 hours, and a newer request replaces an older link. Opening a used link again says "already confirmed" because mail scanners often open links first |
| `GET` or `POST /unsubscribe?token=` | Unsubscribes from every list. `POST` is the RFC 8058 one-click request behind the `List-Unsubscribe` header |
| `GET /preferences?token=` | A page to change lists or unsubscribe. `POST` saves the choice |

Abuse controls on `subscribe`:

- A hidden honeypot field named `website`. If it is filled, the request looks like a success and nothing is stored or sent.
- A per-IP limit of 5 attempts per hour, kept in D1 under a salted hash of the IP address (`SUBSCRIBE_LIMIT_PER_HOUR`).
- One confirmation email per address per 10 minutes, so the form cannot be used to mail-bomb someone.
- A daily ceiling of 300 confirmation emails for the whole site (`MAX_CONFIRMATIONS_PER_DAY`), to protect the sending quota.
- The response never reveals whether an address already exists, is unsubscribed, or is suppressed. A person already subscribed gets a confirmation email like anyone else, and their lists only change when they confirm.

Tokens are `base64url(payload).base64url(HMAC-SHA256)` signed with `MAIL_SIGNING_SECRET` through Web Crypto. The payload holds the purpose, the address, an expiry, and for confirmations a nonce. A confirmation token cannot unsubscribe and an unsubscribe token cannot confirm. Confirmation links last 48 hours. Unsubscribe and preferences links last three years so old emails keep working.

Unsubscribing removes every list, not just the list of the email it came from. The preferences page is the way to drop one list.

## Delivery

- **Every email** carries a personal unsubscribe link and preferences link (HTML and text), `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers, a plain-text part, and the line "You subscribed at cerulean.news. Cerulean News is not affiliated with Blue Cross and Blue Shield of Vermont." The confirmation email included. Only headers on Email Service's allowlist are used.
- **At most once.** Each send claims a row in `sends` before the message goes out, keyed on subscriber, list, and content (`digest:<date>`, `alerts:<id>`, `monthly:<month>`). If the outcome is unknown, for example the Worker was cut off after sending, the row stays and is never retried. The worst case is a missed email, never a duplicate.
- **Limits.** One message per recipient, since every link is personal. The binding sends four at a time. A run sends at most 250 messages (`MAX_SENDS_PER_RUN`), because a Worker invocation allows 1,000 D1 queries and each delivery costs two. The 30-minute ticks finish a longer list. New Email Service accounts start with a conservative daily quota that grows with good sending. On `E_DAILY_LIMIT_EXCEEDED` or `E_RATE_LIMIT_EXCEEDED` the batch stops without using up anyone's attempts and resumes on the next tick. If the list outgrows the quota, request an increase with Cloudflare's limit form.
- **Suppressions.** Cloudflare suppresses addresses after hard bounces, soft bounces, and spam complaints. With "Drop suppressed recipients" off (the default), `send()` throws `E_RECIPIENT_SUPPRESSED`. The Worker records that address as suppressed for that content and moves on. They stay subscribed and are tried again for the next issue, when a soft-bounce suppression may have expired. With the setting on, Cloudflare drops the address silently and the Worker logs it as sent. Complaint suppressions never expire, so those addresses stop receiving mail until someone removes the entry in Email Service.
- **Failures.** One failing recipient never stops the others. A failed send is retried on later ticks up to 3 attempts. Five failures in a row stop the batch, on the assumption that the service is down.
- **Catch-up.** The digest and monthly report each fire once, but the site may publish late or a run may hit its cap. Ticks from 25 minutes after the scheduled run (11:30 UTC for the digest) for about five and a half hours keep trying the digest, and ticks from 13:30 UTC on day 1 through day 3 keep trying the monthly report, until the job finishes. The window follows the cron constants in `worker.js`.

## Schedule

Cron triggers run in UTC and ignore daylight saving time, so the local send time moves by an hour twice a year.

| Trigger | UTC | Eastern in summer (EDT) | Eastern in winter (EST) |
| --- | --- | --- | --- |
| Alerts | every 30 minutes | every 30 minutes | every 30 minutes |
| Digest | 11:05 | 7:05 a.m. | 6:05 a.m. |
| Monthly | 13:05 on day 1 | 9:05 a.m. | 8:05 a.m. |

To keep the digest near 7:05 a.m. year-round, change `5 11 * * *` to `5 12 * * *` in November and back in March. Update `CRON_DIGEST` in `worker.js` in the same commit, because a test checks the two agree.

## What is stored

Only the email address, the chosen lists, and a send log (which content went to whom, when, and the outcome). The rate limiter stores a salted hash of the visitor's IP address for at most two days. Addresses that never confirm are deleted after 30 days. Send-log rows are deleted after about 400 days. An address that unsubscribes stays on file as `unsubscribed` so a later sign-up needs a fresh confirmation.

## Operations

```bash
# Subscriber counts
npx wrangler@4 d1 execute cerulean-news-mail --remote --command "SELECT status, COUNT(*) FROM subscribers GROUP BY status"
# Recent sends and failures
npx wrangler@4 d1 execute cerulean-news-mail --remote --command "SELECT list, content_key, status, COUNT(*) FROM sends GROUP BY 1,2,3 ORDER BY MAX(updated_at) DESC LIMIT 20"
# Job progress
npx wrangler@4 d1 execute cerulean-news-mail --remote --command "SELECT * FROM jobs ORDER BY updated_at DESC LIMIT 10"
```

Logs are in Workers Logs for `cerulean-news-mail`. Email addresses in logs are masked (`o***@example.com`). Delivery, bounce, and complaint data are in Email Service's own logs and metrics.

Replies to the emails go nowhere because the Worker sets no reply address and no inbound route exists. Add one in Email Routing if that matters.

## Tests

`npm test` runs `test/mail.test.js`. D1 is an in-memory SQLite database (`node:sqlite`, Node 22.5 or newer) that runs the real migration behind the D1 `prepare`, `bind`, `first`, `all`, `run`, and `batch` methods. `EMAIL` and `fetch` are fakes. On older Node the database tests skip and the pure-function tests still run.
