## 2026-10-29 - Recent-change release review

**What changed**: Reviewed the default-only mail entry and passed the mail tests. Deployed main through the existing dispatch workflow, run 40974705845, which passed. Cloudflare reports version `168bbe19-d418-409d-b5f3-4b409660bda3`; GET on the POST-only subscribe route returns 405. No subscription or mail delivery was requested.

**Left off at**: Remaining publication checks are recorded in the cross-project review handoff.

---

# Worklog

## Current guidance

- [README](README.md) covers the reader, sources, matching, configuration and development.
- [Mail Worker](mail/README.md) covers subscriptions, team sign-in and mail operations.
- [Sentiment repair operations](docs/sentiment-repair-operations.md) defines the bounded repair process. The [preservation record](docs/2026-10-08-sentiment-preservation.md) and [Gemini inventory](docs/2026-10-08-remaining-gemini-sentiment.md) retain exact evidence and remaining targets.
- [Release reporting](.github/RELEASES.md) explains how verified delivery is recorded. The [old Cloudflare migration plan](CLOUDFLARE_MIGRATION_PLAN.md) points to its existing historical archive.

The saved-sentiment preservation repair landed on October 8. Further inference remains paused pending lineage and current-context checks; the linked inventories overlap and must not be added together. The excluded-stories reader is implemented in [site/excluded.html](site/excluded.html) and [site/feedback.js](site/feedback.js), with coverage in [feedback-ui.test.js](test/feedback-ui.test.js).

Use the [GitHub issues](https://github.com/oliverames/cerulean-news/issues) for current task status. Older worklog entries describe what was known on their dates.

## October 29, 2026: mail Worker entry

**What changed**: `mail/wrangler.toml` now points `main` at a new `mail/entry.js` that imports `worker.js` and exports only the default handler. `worker.js` keeps its constants and helpers because the tests import them. A test asserts the entry's only export is `default`, the wrangler test expects `main = "entry.js"`, and the mail README's file table lists the new module. Closes [#34](https://github.com/oliverames/cerulean-news/issues/34).

**Decisions made**: workerd treats every named export of the entry module as an entrypoint, so `CRON_ALERTS`, a string, failed validation. A one-module entry is a smaller change than relocating the roughly sixty named exports that `worker.js` provides to the tests, and it leaves every existing import unchanged. `wrangler deploy --dry-run` had not caught this; only `wrangler dev` starts workerd.

**Verification**: reproduced first with wrangler 4.155.0 — `wrangler dev` failed with `Incorrect type for map entry 'CRON_ALERTS'`. After the change the same command reached `Ready on http://127.0.0.1:8801` with no validation error, `wrangler deploy --dry-run` completed, and `npm test` passed 837 of 837.

**Left off at**: source only. Neither Worker was deployed from here; the mail Worker publishes through the dispatch-only `deploy-mail.yml` workflow.

**Open questions**: none.

---

## October 13, 2026: documentation cleanup

Moved the complete previous worklog into the dated archive linked below and replaced repeated status summaries with links to the maintained guides. Source, provider settings and publishing workflows are unchanged. No deployment, crawl or model request ran for this cleanup.

## October 23, 2026: security review

The fetch relay in `proxy/server.mjs` checked only the first URL against `ALLOW_HOSTS` and then followed redirects anywhere, so an allowlisted host's redirect could reach the home network. It now follows redirects one hop at a time, applies the scheme and host checks to each, and stops after five. Its bearer check now uses `timingSafeEqual`, as its comment already said. A local harness confirmed the old build followed a redirect to a non-allowlisted host and the new one answers 502. The running `cerulean-fetch-relay` container on home-server keeps the old code until it is rebuilt from this source. The mail Worker, the parked Worker and the workflows needed no change.

The relay image also ran `npm install` with no lockfile, so every rebuild took whatever decoder dependencies were newest. `proxy/package-lock.json` now pins them and the Dockerfile uses `npm ci`. The deploy steps in `proxy/README.md` now copy `package.json` and the lockfile, which the image needs and the old `scp` line left out. `npm ci --omit=dev` and the decoder import were checked locally; the image itself was not built here.

## October 26, 2026: Sentry error reporting (committed, not pushed)

Both Workers now report errors to the `cerulean-news` Sentry project through `@sentry/cloudflare` 11.9.0, pinned exactly. `worker/sentry.js` holds the shared options, and each event carries a `worker` tag of `cerulean-news` or `cerulean-news-mail`. The SDK is inert until the `SENTRY_DSN` secret is set on a Worker. Tracing is off and every `dataCollection` field is off (SDK 11 dropped `sendDefaultPii`, and its replacement collects by default). `beforeSend` keeps only the request method and path, drops the user, breadcrumbs, extra data and timezone, removes long tokens, query strings and email addresses from error messages, and reduces stack frame paths to file names, so subscriber and team addresses, signed links and session cookies stay out. Uncaught errors from either Worker are reported, and so are the errors the mail Worker's request handler and the parked Worker's `/__run` route catch and answer with a 500. The mail Worker gains `nodejs_compat`, both gain the `CF_VERSION_METADATA` binding, `deploy-mail.yml` runs `npm ci` at the root before deploying, and `.wrangler/` is ignored.

Verification: `npm test` passed 836 of 836 with the provider credentials unset (three publisher-preservation tests refuse to run while `GEMINI_API_KEY` or `TYPESAFE_API_KEY` is in the environment). Both dry runs bundled and list `CF_VERSION_METADATA`. Under `wrangler dev`, temporary throwing routes (removed) got a POST with a body, a cookie, a custom header, a query string and `CF-Connecting-IP`, with an email address, a 40-character token and a URL query in the error text. Events `f24ffb5de76847bfb82ecbd8e2317d0c` (tag `cerulean-news`) and `e2ed17b6e8fa4bf08d33ffa661709a2b` (tag `cerulean-news-mail`) arrived with environment `development` and a release, and no marker string appeared anywhere in either.

Found along the way: `wrangler dev` 4.152.0 refuses to start the mail Worker, before and after this change, with "Incorrect type for map entry 'CRON_ALERTS'", because `worker.js` exports constants and helpers beside the default handler. The local check ran through a temporary entry that re-exports only the default. A deploy may hit the same check.

Not pushed, because a push to main runs the publish workflow, which deploys Pages. Production steps, in order: push; `op read 'op://Development/Cerulean News Sentry DSN/credential' | npx wrangler@4 secret put SENTRY_DSN --name cerulean-news-mail`, then run the Deploy mail Worker workflow; for the parked Worker, `op read 'op://Development/Cerulean News Sentry DSN/credential' | npx wrangler secret put SENTRY_DSN` and `npx wrangler deploy` from the root, only if it is meant to be redeployed.

## Historical record

The [complete worklog through October 13, 2026](WORKLOG-2026-10-13.md) is an exact copy of the previous file. It stays at the repository root to preserve each relative link's original context. The [preservation record](docs/archive/worklog-2026-10-13.json) records the source revision, byte count and SHA-256 digest.

<details>
<summary>Previous entry links</summary>

<a id="2026-10-08---preserve-saved-sentiment-across-publications"></a>
- [2026-10-08 - Preserve saved sentiment across publications](WORKLOG-2026-10-13.md#2026-10-08---preserve-saved-sentiment-across-publications)
<a id="2026-10-08---checkpointed-sentiment-repair-and-closeout"></a>
- [2026-10-08 - Checkpointed sentiment repair and closeout](WORKLOG-2026-10-13.md#2026-10-08---checkpointed-sentiment-repair-and-closeout)
<a id="2026-10-08---publish-the-reviewed-change-without-model-execution"></a>
- [2026-10-08 - Publish the reviewed change without model execution](WORKLOG-2026-10-13.md#2026-10-08---publish-the-reviewed-change-without-model-execution)
<a id="2026-10-08---bounded-sentiment-allocation-and-excluded-story-review"></a>
- [2026-10-08 - Bounded sentiment allocation and excluded-story review](WORKLOG-2026-10-13.md#2026-10-08---bounded-sentiment-allocation-and-excluded-story-review)
<a id="2026-10-07---github-issue-review-closeout"></a>
- [2026-10-07 - GitHub Issue Review Closeout](WORKLOG-2026-10-13.md#2026-10-07---github-issue-review-closeout)
<a id="2026-10-07---readme-refresh-closeout"></a>
- [2026-10-07 - README Refresh Closeout](WORKLOG-2026-10-13.md#2026-10-07---readme-refresh-closeout)
<a id="open-items"></a>
- [Open items](WORKLOG-2026-10-13.md#open-items)
<a id="2026-09-29---archive-re-check-finished"></a>
- [2026-09-29 - Archive re-check finished](WORKLOG-2026-10-13.md#2026-09-29---archive-re-check-finished)
<a id="2026-09-29---17-done-the-mail-worker-is-live"></a>
- [2026-09-29 - #17 done: the mail Worker is live](WORKLOG-2026-10-13.md#2026-09-29---17-done-the-mail-worker-is-live)
<a id="2026-09-29---21-fixed-19-fixed-17-partly-done"></a>
- [2026-09-29 - #21 fixed, #19 fixed, #17 partly done](WORKLOG-2026-10-13.md#2026-09-29---21-fixed-19-fixed-17-partly-done)
<a id="2026-09-29---plan-done-mail-worker-setup-share-of-voice-body-matching-jev-cache-churn"></a>
- [2026-09-29 - Plan (done): mail Worker setup, share-of-voice body matching, Jev cache churn](WORKLOG-2026-10-13.md#2026-09-29---plan-done-mail-worker-setup-share-of-voice-body-matching-jev-cache-churn)
<a id="2026-09-29---features-shipped-january-history-backfilled-archive-re-check-paused"></a>
- [2026-09-29 - Features shipped, January history backfilled, archive re-check paused](WORKLOG-2026-10-13.md#2026-09-29---features-shipped-january-history-backfilled-archive-re-check-paused)
<a id="2026-09-28---plan-done-2026-09-29-january-history-report-findings-and-feedback-buttons"></a>
- [2026-09-28 - Plan (done 2026-09-29): January history, report findings, and feedback buttons](WORKLOG-2026-10-13.md#2026-09-28---plan-done-2026-09-29-january-history-report-findings-and-feedback-buttons)
<a id="2026-09-28---plan-done-2026-09-29-ten-reader-and-pipeline-features-and-the-password-gate"></a>
- [2026-09-28 - Plan (done 2026-09-29): ten reader and pipeline features, and the password gate](WORKLOG-2026-10-13.md#2026-09-28---plan-done-2026-09-29-ten-reader-and-pipeline-features-and-the-password-gate)
<a id="2026-09-28---plan-done-2026-09-29-archive-re-check-and-missing-article-fixes"></a>
- [2026-09-28 - Plan (done 2026-09-29): archive re-check and missing-article fixes](WORKLOG-2026-10-13.md#2026-09-28---plan-done-2026-09-29-archive-re-check-and-missing-article-fixes)
<a id="2026-09-28---human-exclusions-decide-their-own-articles-cadence-accepted"></a>
- [2026-09-28 - Human exclusions decide their own articles; cadence accepted](WORKLOG-2026-10-13.md#2026-09-28---human-exclusions-decide-their-own-articles-cadence-accepted)
<a id="2026-09-28---jev-honors-the-shared-exclusions-learns-from-rejections-and-scores-more-stories"></a>
- [2026-09-28 - Jev honors the shared exclusions, learns from rejections, and scores more stories](WORKLOG-2026-10-13.md#2026-09-28---jev-honors-the-shared-exclusions-learns-from-rejections-and-scores-more-stories)
<a id="2026-09-28---jev-selection-and-sentiment-deep-dive"></a>
- [2026-09-28 - Jev selection and sentiment deep dive](WORKLOG-2026-10-13.md#2026-09-28---jev-selection-and-sentiment-deep-dive)
<a id="2026-09-24---jev-0-100-sentiment-score"></a>
- [2026-09-24 - Jev 0-100 sentiment score](WORKLOG-2026-10-13.md#2026-09-24---jev-0-100-sentiment-score)
<a id="2026-09-24---admin-follow-ups-re-score-resume-and-clip-grouping"></a>
- [2026-09-24 - Admin follow-ups, re-score resume, and clip grouping](WORKLOG-2026-10-13.md#2026-09-24---admin-follow-ups-re-score-resume-and-clip-grouping)
<a id="2026-09-24---clip-email-seed-rollout-and-section-filter-layout"></a>
- [2026-09-24 - Clip-email seed rollout and section filter layout](WORKLOG-2026-10-13.md#2026-09-24---clip-email-seed-rollout-and-section-filter-layout)
<a id="2026-09-24---issue-8-follow-ups-ga4-steps-and-an-seo-pass"></a>
- [2026-09-24 - Issue #8 follow-ups, GA4 steps, and an SEO pass](WORKLOG-2026-10-13.md#2026-09-24---issue-8-follow-ups-ga4-steps-and-an-seo-pass)
<a id="2026-09-23---grouped-story-coverage-and-specific-jev-inclusion-notes"></a>
- [2026-09-23 - Grouped story coverage and specific Jev inclusion notes](WORKLOG-2026-10-13.md#2026-09-23---grouped-story-coverage-and-specific-jev-inclusion-notes)
<a id="2026-09-22---worklog-compaction-and-open-item-decisions"></a>
- [2026-09-22 - Worklog compaction and open-item decisions](WORKLOG-2026-10-13.md#2026-09-22---worklog-compaction-and-open-item-decisions)
<a id="2026-09-21---approve-jev-selection-and-confident-sentiment-for-new-articles"></a>
- [2026-09-21 - Approve Jev selection and confident sentiment for new articles](WORKLOG-2026-10-13.md#2026-09-21---approve-jev-selection-and-confident-sentiment-for-new-articles)
<a id="2026-09-21---human-reference-alignment-for-future-jev-decisions"></a>
- [2026-09-21 - Human reference alignment for future Jev decisions](WORKLOG-2026-10-13.md#2026-09-21---human-reference-alignment-for-future-jev-decisions)
<a id="2026-09-21---full-archive-jev-inclusion-and-sentiment-comparison"></a>
- [2026-09-21 - Full-archive Jev inclusion and sentiment comparison](WORKLOG-2026-10-13.md#2026-09-21---full-archive-jev-inclusion-and-sentiment-comparison)
<a id="2026-09-21---jev-evaluation-wired-for-inclusion-and-sentiment"></a>
- [2026-09-21 - Jev evaluation wired for inclusion and sentiment](WORKLOG-2026-10-13.md#2026-09-21---jev-evaluation-wired-for-inclusion-and-sentiment)
<a id="2026-09-21---a-jev-second-opinion-on-relevance-off-by-default-and-the-actions-issue-closed"></a>
- [2026-09-21 - A Jev second opinion on relevance, off by default, and the Actions issue closed](WORKLOG-2026-10-13.md#2026-09-21---a-jev-second-opinion-on-relevance-off-by-default-and-the-actions-issue-closed)
<a id="2026-09-18---actions-publishing-restored-worker-handed-off-stall-gap-measured"></a>
- [2026-09-18 - Actions publishing restored, Worker handed off, stall gap measured](WORKLOG-2026-10-13.md#2026-09-18---actions-publishing-restored-worker-handed-off-stall-gap-measured)
<a id="2026-09-16---build-moved-from-github-actions-to-a-cloudflare-worker"></a>
- [2026-09-16 - Build moved from GitHub Actions to a Cloudflare Worker](WORKLOG-2026-10-13.md#2026-09-16---build-moved-from-github-actions-to-a-cloudflare-worker)
<a id="2026-09-04---footer-search-metadata-mit-license-and-trends-layout"></a>
- [2026-09-04 - Footer, search metadata, MIT license, and trends layout](WORKLOG-2026-10-13.md#2026-09-04---footer-search-metadata-mit-license-and-trends-layout)
<a id="2026-09-03---history-scrub-cerulean-news-rebrand-bluecrossvtorg-crawl-stop"></a>
- [2026-09-03 - History scrub, Cerulean News rebrand, bluecrossvt.org crawl stop](WORKLOG-2026-10-13.md#2026-09-03---history-scrub-cerulean-news-rebrand-bluecrossvtorg-crawl-stop)
<a id="2026-09-03---legal-exposure-pass-private-repo-cloudflare-pages-disclaimer-new-icons"></a>
- [2026-09-03 - Legal-exposure pass: private repo, Cloudflare Pages, disclaimer, new icons](WORKLOG-2026-10-13.md#2026-09-03---legal-exposure-pass-private-repo-cloudflare-pages-disclaimer-new-icons)
<a id="2026-09-03---google-analytics-tag-and-the-bluenewsonline-custom-domain"></a>
- [2026-09-03 - Google Analytics tag and the bluenews.online custom domain](WORKLOG-2026-10-13.md#2026-09-03---google-analytics-tag-and-the-bluenewsonline-custom-domain)
<a id="2026-08-27---finished-the-interrupted-feed-quality-pass-released-120"></a>
- [2026-08-27 - Finished the interrupted feed-quality pass; released 1.2.0](WORKLOG-2026-10-13.md#2026-08-27---finished-the-interrupted-feed-quality-pass-released-120)
<a id="2026-08-27---remove-publisher-shells-stale-roundup-previews-and-employment-pages"></a>
- [2026-08-27 - Remove publisher shells, stale roundup previews, and employment pages](WORKLOG-2026-10-13.md#2026-08-27---remove-publisher-shells-stale-roundup-previews-and-employment-pages)
<a id="2026-08-27---harden-archive-continuity-matching-retries-and-deployment"></a>
- [2026-08-27 - Harden archive continuity, matching, retries, and deployment](WORKLOG-2026-10-13.md#2026-08-27---harden-archive-continuity-matching-retries-and-deployment)
<a id="2026-08-27---re-score-ordering-a-stale-deploy-fix-verified-in-production-and-what-the-scored-coverage-says"></a>
- [2026-08-27 - Re-score ordering, a stale-deploy fix verified in production, and what the scored coverage says](WORKLOG-2026-10-13.md#2026-08-27---re-score-ordering-a-stale-deploy-fix-verified-in-production-and-what-the-scored-coverage-says)
<a id="2026-08-27---harden-cache-provenance-dedupe-webhooks-and-dependencies"></a>
- [2026-08-27 - Harden cache provenance, dedupe, webhooks, and dependencies](WORKLOG-2026-10-13.md#2026-08-27---harden-cache-provenance-dedupe-webhooks-and-dependencies)
<a id="2026-08-27---close-the-three-open-items-negative-cache-drop-standing-context-and-the-august-question"></a>
- [2026-08-27 - Close the three open items: negative-cache drop, standing context, and the August question](WORKLOG-2026-10-13.md#2026-08-27---close-the-three-open-items-negative-cache-drop-standing-context-and-the-august-question)
<a id="2026-08-27---seed-the-media-tracker-into-the-archive-and-fix-the-dedupe-bug-that-was-eating-roundups"></a>
- [2026-08-27 - Seed the media tracker into the archive, and fix the dedupe bug that was eating roundups](WORKLOG-2026-10-13.md#2026-08-27---seed-the-media-tracker-into-the-archive-and-fix-the-dedupe-bug-that-was-eating-roundups)
<a id="2026-08-27---stop-scoring-other-blues-plans-and-broaden-the-trends-page-to-volume-and-themes"></a>
- [2026-08-27 - Stop scoring other Blues plans, and broaden the trends page to volume and themes](WORKLOG-2026-10-13.md#2026-08-27---stop-scoring-other-blues-plans-and-broaden-the-trends-page-to-volume-and-themes)
<a id="2026-08-27---payer-trade-press-sources-and-sentiment-calibrated-on-the-trackers-own-scores"></a>
- [2026-08-27 - Payer trade press sources, and sentiment calibrated on the tracker's own scores](WORKLOG-2026-10-13.md#2026-08-27---payer-trade-press-sources-and-sentiment-calibrated-on-the-trackers-own-scores)
<a id="2026-08-27---sentiment-scoring-from-kristinas-media-tracker-plus-a-trends-page-and-a-coverage-audit"></a>
- [2026-08-27 - Sentiment scoring from Kristina's media tracker, plus a trends page and a coverage audit](WORKLOG-2026-10-13.md#2026-08-27---sentiment-scoring-from-kristinas-media-tracker-plus-a-trends-page-and-a-coverage-audit)
<a id="2026-08-26---clear-the-deferred-follow-ups-bounded-facebook-text-nested-comment-replies-global-cache-freshness-backfill-retirement"></a>
- [2026-08-26 - Clear the deferred follow-ups: bounded Facebook text, nested comment replies, global cache freshness, backfill retirement](WORKLOG-2026-10-13.md#2026-08-26---clear-the-deferred-follow-ups-bounded-facebook-text-nested-comment-replies-global-cache-freshness-backfill-retirement)
<a id="2026-08-25---fix-brand-search-recall-the-bcbsa-tls-outage-and-outlet-fallbacks-live-data-pass"></a>
- [2026-08-25 - Fix brand-search recall, the BCBSA TLS outage, and outlet fallbacks (live-data pass)](WORKLOG-2026-10-13.md#2026-08-25---fix-brand-search-recall-the-bcbsa-tls-outage-and-outlet-fallbacks-live-data-pass)
<a id="2026-08-25---bug-fix-pass-on-the-crawler-and-source-finder-layers"></a>
- [2026-08-25 - Bug-fix pass on the crawler and source-finder layers](WORKLOG-2026-10-13.md#2026-08-25---bug-fix-pass-on-the-crawler-and-source-finder-layers)
<a id="earlier-history-before-2026-08-23"></a>
- [Earlier history (before 2026-08-23)](WORKLOG-2026-10-13.md#earlier-history-before-2026-08-23)

</details>
