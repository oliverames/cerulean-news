# Worklog

## Current guidance

- [README](README.md) covers the reader, sources, matching, configuration and development.
- [Mail Worker](mail/README.md) covers subscriptions, team sign-in and mail operations.
- [Sentiment repair operations](docs/sentiment-repair-operations.md) defines the bounded repair process. The [preservation record](docs/2026-10-08-sentiment-preservation.md) and [Gemini inventory](docs/2026-10-08-remaining-gemini-sentiment.md) retain exact evidence and remaining targets.
- [Release reporting](.github/RELEASES.md) explains how verified delivery is recorded. The [old Cloudflare migration plan](CLOUDFLARE_MIGRATION_PLAN.md) points to its existing historical archive.

The saved-sentiment preservation repair landed on October 8. Further inference remains paused pending lineage and current-context checks; the linked inventories overlap and must not be added together. The excluded-stories reader is implemented in [site/excluded.html](site/excluded.html) and [site/feedback.js](site/feedback.js), with coverage in [feedback-ui.test.js](test/feedback-ui.test.js).

Use the [GitHub issues](https://github.com/oliverames/cerulean-news/issues) for current task status. Older worklog entries describe what was known on their dates.

## October 13, 2026: documentation cleanup

Moved the complete previous worklog into the dated archive linked below and replaced repeated status summaries with links to the maintained guides. Source, provider settings and publishing workflows are unchanged. No deployment, crawl or model request ran for this cleanup.

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
