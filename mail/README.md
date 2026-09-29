# Cerulean News email subscriptions

Anyone can subscribe at [cerulean.news/subscribe](https://cerulean.news/subscribe), confirm by email (double opt-in), and choose any of three lists:

| List | What it sends | When |
| --- | --- | --- |
| `digest` | The daily clip digest | 11:05 UTC each day |
| `alerts` | Brand-mention alerts | Checked every 30 minutes |
| `monthly` | The monthly leadership report | 13:05 UTC on day 1 |

This is a separate Worker, `cerulean-news-mail`, so the parked `worker/` build is untouched. It owns `cerulean.news/api/mail/*`, keeps subscribers in D1, sends through the Cloudflare Email Service `send_email` binding, and fetches the content it mails from the public site.

The same Worker also runs team sign-in and the Keep, Drop, and "Sentiment is wrong" votes that feed Jev. That has its own section below, [Team feedback](#team-feedback).

Email Sending is in public beta. It needs the Workers Paid plan and `cerulean.news` onboarded as a sending domain.

## Files

| File | Purpose |
| --- | --- |
| `worker.js` | The Worker: endpoints, delivery, cron handlers. Pure functions are exported for tests |
| `team.js` | Team sign-in, sessions, votes, and the pipeline export. Imported by `worker.js` |
| `wrangler.toml` | Name, bindings, route, cron triggers. `database_id` is a marked placeholder |
| `migrations/0001_init.sql` | D1 schema for subscriptions |
| `migrations/0002_team_feedback.sql` | Team members, used sign-in links, and votes |
| `../site/subscribe.html` | The signup page |
| `../site/feedback.js` | The reader's feedback controls and the admin page's logic |
| `../site/feedback-admin.html` | Admin list of every vote, behind the site's password gate |
| `../src/feedback.js` | The pipeline side: fetches the export and applies the votes |
| `../.github/workflows/deploy-mail.yml` | Dispatch-only deploy |
| `../test/mail.test.js` | Subscription tests, run by `npm test` |
| `../test/team-feedback.test.js` | Sign-in, session, vote, and export tests |
| `../test/feedback.test.js`, `../test/feedback-ui.test.js` | Pipeline and reader tests |

## Setup (Oliver)

1. **Upgrade to Workers Paid.** Email Sending and the 250-cron-trigger limit both need it. Cloudflare dashboard, Workers & Pages, Plans.
2. **Onboard `cerulean.news` in Email Service.** Dashboard, Compute, Email Service, Email Sending, Onboard Domain, pick `cerulean.news`. Cloudflare adds MX, SPF, DKIM, and DMARC records on the `cf-bounce` subdomain and `_dmarc.cerulean.news`. Check first that no other DMARC record exists at `_dmarc.cerulean.news`. Wait for the domain to show as verified, which is usually 5 to 15 minutes. Leave "Drop suppressed recipients" at its default (off) or turn it on, either works (see Suppressions below).
3. **D1 database.** Done 2026-09-29: `cerulean-news-mail` (ENAM) exists and its id is in `mail/wrangler.toml`. Its tables are created by the deploy workflow's `d1 migrations apply` step, so do not create them by hand. (To recreate it elsewhere: `npx wrangler@4 d1 create cerulean-news-mail`, then put the printed id in `wrangler.toml`. The deploy workflow refuses to run while the placeholder `REPLACE_WITH_D1_DATABASE_ID` is there.)
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
- The body carries a short "What stood out" section after the summary when Gemini findings exist for the month. It is labeled AI-generated and is left out without a key or on any failure, so the contract is unchanged: `html` and `text` are the same fields either way. The Vermont figure reads "n/a" for a month whose total is not available.
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

## Team feedback

Team members give each story a vote in the reader, and the pipeline applies the votes to the next run. The public reader shows no change. Only a signed-in team member sees the controls.

### Who can sign in

- **Anyone at `bcbsvt.com`.** The part of the address after the last `@` must equal `bcbsvt.com` exactly, after lowercasing and trimming. A subdomain, `evilbcbsvt.com`, and `bcbsvt.com.example.org` all fail. The local part is limited to letters, digits, and `. _ ' + -`, so a `%` or `!` cannot route the message elsewhere. A `+tag` is dropped, so every alias of one mailbox is one person.
- **Admins.** Any address on the `ADMIN_EMAILS` secret, at any domain. Nobody is an admin while it is unset.

No subscription is needed. The emailed link is the proof of control, and a row is created in `team_members` at the first sign-in.

### Sign-in

1. The person opens `https://cerulean.news/api/mail/team/signin` and enters their address. The page is small and matches the Worker's other pages. Once this Worker is deployed, the reader's footer shows a plain "Team: Sign in" line to every visitor, deliberately unbranded. Before deployment the line stays hidden, because the link would not resolve.
2. The Worker answers the same way for every well-formed address, whether or not it can sign in. The lookup and the email run after the response, so the timing is alike too. Only a team-domain or admin address is mailed a link.
3. The link is single use and expires in 15 minutes (`SIGNIN_LINK_MINUTES`). Opening it shows a page with a button, and only the button signs in. Mail scanners open links but never press buttons, so a scanner cannot use one up.
4. The button sets the session cookie and lands on the reader. The cookie is `__Secure-cerulean_team`, `HttpOnly`, `Secure`, `SameSite=Lax`, scoped to `/api/mail`, and lasts 14 days (`SESSION_DAYS`).

The session token is signed with `MAIL_SIGNING_SECRET` like the mail tokens, with its own purpose (`team-session`), so a confirm, unsubscribe, or sign-in token can never act as a session and a session can never act as a link. Every request re-checks the database: the address must still qualify, must not be blocked, and its `session_epoch` must match. Signing out raises the epoch, which ends every session for that address.

Abuse controls on sign-in reuse the subscribe limits: 5 requests per hour per connection, one link per address per 10 minutes, and a site-wide ceiling of 100 sign-in requests a day (`MAX_SIGNINS_PER_DAY`). Every well-formed request counts against the ceiling and the cooldown whoever it names, so hitting a limit reveals nothing about a particular address. A filled honeypot field looks like success. Every state-changing team request must carry the site's own `Origin`. The Worker's forms set `Referrer-Policy: same-origin` so the browser sends it.

### Routes

The team routes stay under the existing `/api/mail/*` route, so there is no new route to deploy. All paths below are under `/api/mail`.

| Request | What it does |
| --- | --- |
| `GET /team/signin` | The sign-in form |
| `POST /team/signin` | Body `{ "email": "..." }`. Mails a link to an eligible address, with the same answer for all |
| `GET /team/link?token=` | The page with the sign-in button. Consumes nothing |
| `POST /team/link` | Form field `token`. Consumes the link, sets the cookie, redirects to the reader |
| `POST /team/signout` | Clears the cookie and ends every session for the address |
| `GET /feedback` | My votes and whether I am an admin. `401` without a session, which is how the reader detects one |
| `PUT /feedback/{item}` | Cast or replace my vote. Body `{ "vote": "keep" }`, `{ "vote": "drop" }`, or `{ "vote": "sentiment", "label": "neutral" }` |
| `DELETE /feedback/{item}` | Undo my vote |
| `GET /feedback/admin` | Admin only. Every current vote with the voter's address |
| `DELETE /feedback/admin/{id}` | Admin only. Removes any vote by its id |
| `GET /feedback/export` | The pipeline's feed of votes, with a bearer token |

`{item}` is the story's SHA-256 URL hash, the same scheme as the editorial `rejectedIds` (`exampleId` in `src/jev-examples.js`), 64 lowercase hex characters. The reader computes it in the browser and a test checks the two agree. Bodies are strict JSON: only `vote` and `label`, `label` exactly when the vote is `sentiment`, and one of the five labels (`positive`, `neutral to positive`, `neutral`, `neutral to negative`, `negative`). There is one current vote per person and story, so a new vote replaces the old one. Votes are limited to 60 writes a minute per person and 5,000 per person. Votes older than 200 days are deleted by the daily housekeeping, since the story has long left the archive.

### The pipeline export

`GET /api/mail/feedback/export` with `Authorization: Bearer <FEEDBACK_EXPORT_TOKEN>` returns

```json
{ "ok": true, "generatedAt": "2026-09-29T10:00:00.000Z", "votes": [{ "item": "<64 hex>", "vote": "drop", "label": null, "updatedAt": "2026-09-29T09:41:00.000Z" }] }
```

Nothing identifies a voter: no address, no id, one row per vote. The token is compared in constant time, and the route answers `404` until a token of at least 32 characters is set. Votes from a blocked address are left out. Each run of the publish workflow fetches it early, and `src/feedback.js` applies the votes before summaries and Jev. Drop excludes the story, keep protects it from the models, and a sentiment vote replaces the label. On a disagreement the latest vote wins for each question, and a tie keeps the story. Undoing a vote restores the story on the next run. Any failure to fetch is logged and the run continues.

### Setup for Oliver

Do these after the mail Worker's own setup above, or as part of it.

1. **The migration.** It applies by itself. The deploy workflow runs `wrangler d1 migrations apply cerulean-news-mail --remote`, which applies `0002_team_feedback.sql` after `0001`. To apply it by hand, run `npx wrangler@4 d1 migrations apply cerulean-news-mail --remote` from `mail/`. It only adds tables.
2. **Admins.** Set `ADMIN_EMAILS` to a comma-separated list of the addresses that may sign in as admins, whatever their domain. Keep the canonical copy in 1Password, as the item "Cerulean News admin emails". Trimming and lowercasing are automatic, and matching is exact.

   ```bash
   op read "op://Private/Cerulean News admin emails/password" | npx wrangler@4 secret put ADMIN_EMAILS --name cerulean-news-mail
   ```

   An admin can sign in, vote, list every vote, and undo any vote. There is no admin column in the database. To remove an admin, edit the secret. The change ends that session on the next request.
3. **The export token.** Generate it once, keep it in 1Password as "Cerulean News feedback export token", and put the same value in both places:

   ```bash
   openssl rand -base64 48        # save the output in 1Password
   op read "op://Private/Cerulean News feedback export token/password" | npx wrangler@4 secret put FEEDBACK_EXPORT_TOKEN --name cerulean-news-mail
   op read "op://Private/Cerulean News feedback export token/password" | gh secret set FEEDBACK_EXPORT_TOKEN
   ```

   The GitHub secret is `FEEDBACK_EXPORT_TOKEN`. The publish workflow also reads an optional `FEEDBACK_EXPORT_URL` secret and otherwise uses `https://cerulean.news/api/mail/feedback/export`. Until the token secret exists the pipeline does not fetch anything and nothing changes.
4. **Deploy.** Run "Deploy mail Worker" (step 6 above). No new route, cron, or binding is added.
5. **Try it.** Open `https://cerulean.news/api/mail/team/signin` with an admin address, follow the emailed link, and reload the reader. Each story's meta line gains "Keep · Drop · Sentiment is wrong". Cast a vote, check that `https://cerulean.news/feedback-admin` (behind the site's password gate) lists it, and undo it there.
6. **Tell the team** to sign in at `https://cerulean.news/api/mail/team/signin` with their `bcbsvt.com` address.

### Managing people and votes

```bash
# Who has signed in, and how many votes each has cast
npx wrangler@4 d1 execute cerulean-news-mail --remote --command "SELECT m.email, m.blocked, COUNT(f.id) AS votes FROM team_members m LEFT JOIN feedback f ON f.member_id = m.id GROUP BY m.id"
# Block a person. Their session ends and their votes leave the export
npx wrangler@4 d1 execute cerulean-news-mail --remote --command "UPDATE team_members SET blocked = 1 WHERE email = 'person@bcbsvt.com'"
# Unblock
npx wrangler@4 d1 execute cerulean-news-mail --remote --command "UPDATE team_members SET blocked = 0 WHERE email = 'person@bcbsvt.com'"
# End every session for one person, without blocking
npx wrangler@4 d1 execute cerulean-news-mail --remote --command "UPDATE team_members SET session_epoch = session_epoch + 1 WHERE email = 'person@bcbsvt.com'"
# End every session for everyone
npx wrangler@4 d1 execute cerulean-news-mail --remote --command "UPDATE team_members SET session_epoch = session_epoch + 1"
```

Blocking applies to `bcbsvt.com` members. An admin is controlled by the secret. Admins undo any vote on the `/feedback-admin` page.

### Possible future hardening

Cloudflare Turnstile on the sign-in form and passkey accounts are tabled as possible future hardening. Neither is built.

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

Only the email address, the chosen lists, and a send log (which content went to whom, when, and the outcome). Team feedback adds the address of each person who signed in, a used-link log, and one row per current vote (story hash, vote, corrected label, times). The pipeline's export and the audit file carry the votes without any address. The rate limiter stores a salted hash of the visitor's IP address for at most two days. Addresses that never confirm are deleted after 30 days. Send-log rows are deleted after about 400 days. An address that unsubscribes stays on file as `unsubscribed` so a later sign-up needs a fresh confirmation.

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

`npm test` runs `test/mail.test.js` and `test/team-feedback.test.js`. D1 is an in-memory SQLite database (`node:sqlite`, Node 22.5 or newer) that runs every migration in order behind the D1 `prepare`, `bind`, `first`, `all`, `run`, and `batch` methods. `EMAIL` and `fetch` are fakes. On older Node the database tests skip and the pure-function tests still run.
