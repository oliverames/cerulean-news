## Open items

- After PR #9 deploys and the new cohort is re-evaluated (about five hours at 25 per run), re-score Oliver's 43 decided labels in the [Label Desk](https://claude.ai/artifact/EQH9mfaJk5FcPuGXTmP9wE) against the key, and check the keep and drop lists in `docs/2026-09-24-issue-8-followups.md` (since 2026-09-24; [#8](https://github.com/oliverames/cerulean-news/issues/8))
- Run the publish workflow once with `rebuild_brand_excerpts` and `rescore_sentiment` checked, after PR #9 merges (since 2026-09-24; [#8](https://github.com/oliverames/cerulean-news/issues/8))
- Compare the TypeSafe console against 305 logged Jev requests for 2026-09-21 to 09-24, and confirm balance, alerts, and recharge (since 2026-09-24; [#8](https://github.com/oliverames/cerulean-news/issues/8))
- Sample the 451 proposed additions and 234 removals from `artifacts/jev-evaluation/` into the Label Desk from a Mac session (since 2026-09-24; [#8](https://github.com/oliverames/cerulean-news/issues/8))
- Oliver: create the clip-email passphrase in 1Password, add it as the `CLIP_EMAILS_PASSPHRASE` repo secret, encrypt `clip-emails.json` with gpg, and commit only `data/clip-emails.json.gpg` (since 2026-09-24; [#8](https://github.com/oliverames/cerulean-news/issues/8))
- After the clip-email seed is live: rewrite the broad-national code rule against the 967 national rows, measure Jev on held-out recent digests, then re-judge the archive with Jev at a raised cap (since 2026-09-24; [#8](https://github.com/oliverames/cerulean-news/issues/8))
- Decide on the missing-article fixes in `docs/2026-09-24-missing-articles.md` (topic terms, replacement Google News queries, new sources, two body-scan changes) (since 2026-09-24)
- Decide on keyword-miss rescue; the 2026-09-24 analysis recommends against it (since 2026-09-21; [#8](https://github.com/oliverames/cerulean-news/issues/8))
- Watch the small September Actions storage charge (about $0.44 net), the kind of overage that can re-trip a zero spending limit (since 2026-09-18) (unverified)
- Decide whether the six projects whose Mac builds were disabled get self-hosted runners on the MacBook Pro and home-server, or stay manual (since 2026-09-16) (unverified)
- Establish why `xcode-27` appears as a `runs-on` label with no registered runner before that label is reused (since 2026-09-16)
- `ames-plugins-local/marketplace-validation.yml` is still on `macos-latest`, which bills at 10x if it fires (since 2026-09-16)
- Remove bluenews.online and oliverames.github.io from the GA4 cross-domain list; steps are on the issue (since 2026-09-04; [#4](https://github.com/oliverames/cerulean-news/issues/4))
- After the SEO deploy: submit the sitemap in Search Console and Bing, change the `/trends/` redirect rule from 302 to 301 in Cloudflare, and check that an unknown path returns 404 (since 2026-09-24)
- Prove the `data/coverage-context.json` VT Basic storyline in production with a re-score sweep that completes (`rescore_sentiment` with a small `summary_max_requests`) (since 2026-08-27) (unverified)
- The calendar and briefs recall gap is a product decision that needs Oliver's call before any matcher work (since 2026-08-27) (unverified)
- Parked: Facebook embedded-post association (dormant while social sources are disabled) and compacting cache aliases, which needs a migration design that cannot discard the newer alias (since 2026-08-27) (unverified)
- Whether Oliver should report bcbs.com's incomplete TLS chain to the association's web team (since 2026-08-25) (unverified)

## 2026-09-24 - Issue #8 follow-ups, GA4 steps, and an SEO pass

**Request**: Resolve all open issues, read as #4 plus the seven open items in #8, and add a comprehensive SEO pass. Oliver chose GA4 steps rather than code, a review page for human labels, and repo-wide SEO scope.

**#4**: GA4 admin steps are on the issue. It closes once Oliver confirms the change.

**#8**: The full account is in `docs/2026-09-24-issue-8-followups.md`.
- The Label Desk is a private, blinded review page with 207 new-cohort inclusion items and 35 non-tracker sentiment items. The answer key is committed.
- Snippets now center on the brand mention when the fetched body names it. That fixes the multi-story brief case and the rate-review stories that opened on the Green Mountain Care Board. A manual `rebuild_brand_excerpts` dispatch option repairs the 112 existing candidates.
- The keyword-miss analysis recommends against general rescue. Only 13 of 186 human clips match no term in their title or excerpt.
- Logs show 305 successful Jev requests from 2026-09-21 to 09-24. The 30-minute schedule raises the daily cap to 1,200.
- Oliver dropped the two orphan workbook records and deferred the historical sample to a Mac session.

**Labels and rule change**: Oliver labeled 47 items and judged the original tracker lists the best reference. On 43 decided items the feed agreed 35 times and the pre-Jev baseline 34 times. All 4 Jev additions he rejected were single-state stories from outside New England, so the shared inclusion rules now exclude another state's own Medicaid, premiums, rate filings, lawsuits, or single-employer plan unless the story involves a Blues plan, BCBSA, or federal or multi-state policy. Oliver then set the national standard: a trend story counts only when its outcome would matter to BCBSVT as a Vermont insurer, and BCBSA news counts as Blue Cross coverage. All seven out-of-region tracker picks still fit. Two older BCBSA stories on AI billing costs were wrongly rejected and sit before the enforcement boundary.

**Clip emails, BCBSA, and sections**: Oliver shared five daily clip emails (85 articles) and wants every one in the feed. Only 23 of the 85 are included today. Most national rejections come from the broad-national code rule, which rejects 998 archived items. The rule rewrite and a Jev re-judge of the archive wait for his larger export. BCBSA coverage is now a code-level include; a dry run over 4,602 archived items changed exactly the three BCBSA stories. The reader has a section filter (All, Blue Cross VT News, Vermont Healthcare News, National Healthcare News) driven by a new `section` field, and the selection stays in the URL.

**Clip-email corpus**: Oliver's export of Kristina's emails yielded 112 digests with 1,560 unique articles after link cleaning (per-recipient tokens removed). Blue Cross VT (127) and Vermont (466, including Industry News Vermont items) rows are must-include through the tracker backfill; national rows (967) are Jev references only. The list is too large for a secret, so the workflow decrypts a committed `data/clip-emails.json.gpg` with a passphrase secret. An offline build published all 593 must-include rows under the right section.

**SEO**: The site gained robots.txt, a sitemap, a real 404 page, and noindex on pages.dev hosts and the audit JSON. Metadata and structured data were tightened, and the feeds now point at canonical URLs. The audit is `docs/2026-09-24-seo-audit.md`. The README now states the 30-minute cadence.

**Verification**: `npm test` passes 271 of 271. Nothing here is verified in production yet.

---

## 2026-09-23 - Grouped story coverage and specific Jev inclusion notes

**Request**: Combine duplicate coverage such as the six reader entries for the 760,000 ACA enrollee removal, and replace the generic "Jev judged this relevant" note.

**Completed**: The reader and RSS feed now show one entry per event, led by the newest report, with other outlets listed beneath it. The JSON Feed keeps every article and adds `storyGroupId`. Brand coverage, opinion pieces, and roundups are not grouped. On the 2026-09-23 live feed this forms 162 groups from 396 of 1,855 visible articles, and the ACA story becomes one entry covering seven reports. Jev inclusion notes now keep Gemini's description of the article and name Jev's strongest scope with its confidence. Scope scores are now cached for that purpose.

**Verification**: All 251 tests pass. The reader was checked locally against the live feed with grouping applied. Each group with differing headlines was reviewed by hand, and letters, candidate forums, a daily roundup, and one Dartmouth story were removed as false matches.

**Follow-up the same day**: Notes no longer name Jev. They read as the article description plus the scope it fits, for example "Federal action impacting ACA coverage for many individuals. Fits U.S. health coverage, insurance, or policy news (97% confidence)." Additions cached before scope storage were asked again for scope scores only, keeping their cached include decisions. Runs 35876558495 and the next push filled 15 and then 8. The live audit at 2026-09-23T14:53Z shows scope on all 34 added articles and no public note naming Jev. Related coverage now shows as an "Also covered by" line of outlet links, styled like the reason and meta lines.

**Removal reason**: Articles Jev removes now read "Outside the feed's editorial scope." The live audit at 2026-09-23T15:00Z shows 39 removals with that wording and no reason naming Jev.

**Limits**: A few true duplicates stay separate where wording differs too much, which is the safer failure.

---

## 2026-09-22 - Worklog compaction and open-item decisions

**What changed**: Compacted this worklog: entries before 2026-08-23 became the Earlier history digest and every unresolved item moved to Open items.

**Decisions made**: Pre-rewrite commits such as `7b71ccc` still resolve on GitHub by SHA and contain the old reader password. Oliver accepted that exposure because the password gate was removed on 2026-09-03 and the password no longer protects anything. No GitHub Support purge request will be sent.

---

## 2026-09-21 - Approve Jev selection and confident sentiment for new articles

**Authorization**: Oliver chose "Live selection and confident sentiment" after the separate results and uncertainty were explained. The 34/34 result describes retention of human-selected articles; sentiment agreement is 13/16, not 34/34.

**Change**: Restrict aligned enforcement to articles first discovered on or after `2026-09-21T18:13:31Z`. Persist discovery dates for all audit records so dated history cannot drift across the boundary. Historical backlog does not consume the 25-request live quota. Uncertain or failed evaluations retain the current result, and the audit preserves original judgments for targeted restoration.

**Verification**: All 245 tests pass, including two-cycle historical migration, rediscovery, confidence fallback, missing-date protection, workflow reference loading, and audit-only baseline persistence. The preceding shadow deployment successfully loaded 101 human selections and 50 sentiment examples. The provided workbook was verified in place and was not copied into the repository.

**Follow-up**: [Issue #8](https://github.com/oliverames/cerulean-news/issues/8) continues prospective review, rare sentiment labels, better brand excerpts, and review of proposed article changes. The rollout does not claim definitive superiority across both tasks.

**Live activation verified**: [Run 35637740901](https://github.com/oliverames/cerulean-news/actions/runs/35637740901) passed all 245 tests and deployed `7196169`. The receiving audit confirms `enforce`, the fixed discovery cutoff, 101 inclusion references, and 50 sentiment references. It applied three new-cohort inclusion decisions, made two successful API requests, and reported no failures or pending new-cohort evaluations. All 4,493 historical records in the current archive remained outside enforcement, with zero historical decision changes and zero leaked internal fields in public JSON. Discovery times persisted for all 4,497 audit records. No new sentiment-eligible article appeared in this pass. A separate actual-API replay applied a 0.99-confidence positive sentiment to an isolated eligible copy while preserving its historical counterpart; no test record was published.

## 2026-09-21 - Human reference alignment for future Jev decisions

**Request**: Use the team's human selections and sentiment judgments to improve Jev on incoming articles, beyond keyword matching.

**Completed**: Built a private corpus and fixed story-group split. The selected profile supplies up to eight inclusion examples and 16 sentiment examples per question, drawn from 101 human selections and 50 unambiguous sentiment labels. Independent scope questions cover brand, regional health care, and national payer/policy coverage. Future requests load the existing private tracker seed. Known conflicts and reserved groups remain excluded; model predictions never become human labels.

**Evidence**: Compared five development configurations, then froze the selected profile. Reserved validation retains 34/34 human selections and matches 13/16 human sentiment scores versus 12/16 baseline. On 21 provisional agent-reviewed selection cases, it matches 20 versus 15 for the pipeline and 13 for keyword matching. Equal story-group weighting and uncertainty are documented. All 3,179 archive candidates and 221 sentiment requests completed, followed by a zero-call cache verification. Selection uncertainty falls from 43.7% to 12.3%; proposed additions and removals remain unapplied.

**Decision**: Deploy the reference profile in shadow. Confidence-gated sentiment still equals the current baseline, negative labels are scarce, and the human inclusion set contains no rejection labels. [The dated report](docs/2026-09-21-jev-human-alignment.md) records the findings and reproduction steps. [Issue #8](https://github.com/oliverames/cerulean-news/issues/8) retains prospective human review, better brand excerpts, and threshold validation before enforcement. Jev uses request-level guidance; its provider does not offer customer-specific weight training.

## 2026-09-21 - Full-archive Jev inclusion and sentiment comparison

**Request**: Evaluate the retained historical archive against the established article-selection and sentiment criteria before deciding whether Jev can replace live judgments.

**Completed**: Corrected v1 scope drift and missing metadata in versioned v2 requests. Added a private, resumable evaluator. All 4,490 archived articles were accounted for, including 3,179 successful model evaluations and 221 successful sentiment evaluations. Two malformed sentiment answers succeeded on retry. A final resume reused every checkpoint with zero new API calls. All 234 tests pass.

**Evidence**: The clean 77-article human comparison gives Jev 48 exact sentiment matches, versus 51 for the current baseline. Confidence-gated application gives 50. Current selection thresholds would remove 326 articles and recover one, with 1,309 non-curated decisions still falling back to the existing system. Blinded policy adjudication and targeted disagreement review supplement model agreement. Private labels and article-level results remain outside Git.

**Decision**: Retain shadow mode for both selection and sentiment. This run does not demonstrate readiness to replace live judgments. The [full dated report](docs/2026-09-21-jev-full-archive-evaluation.md) records scope, comparisons, caveats, and next steps. [Issue #8](https://github.com/oliverames/cerulean-news/issues/8) retains the unfinished calibration and editorial-validation work.

**Additional human inclusion check**: With the curated marker hidden, all 184 eligible human-selected clips were evaluated again for inclusion only. Jev confidently included 142, excluded none, and deferred on 42. All requests succeeded. This is positive-only retention evidence, not a general accuracy measure; all 186 curated inclusions remain protected in production.

**Live verification**: Commit `d94ec5a` deployed successfully in [run 35630033814](https://github.com/oliverames/cerulean-news/actions/runs/35630033814). The receiving audit reports 25 successful v2 shadow calls and zero failures. Its first batch contains no eligible sentiment, while the full offline run covers all 221 eligible articles. Original human scores and 186 human-selected clips were verified separately from current pipeline judgments; untagged historical decisions lack author metadata.

## 2026-09-21 - Jev evaluation wired for inclusion and sentiment

**Review**: The checkout is now `cerulean-news`, with one registered worktree.
The Jev implementation from #7 was merged, but the publisher never called it.
Gemini still owned relevance and sentiment. The local Jev branch contains no
unmerged work; its remote-tracking reference is stale, and no branch was deleted.

**Changes**: Added direct TypeSafe API support and a five-label sentiment
question using the existing tracker rules, examples, and storyline context.
Jev now runs after Gemini. Cached typed evaluations survive the audit round trip,
reapply after a Gemini re-judge, and let the request cap advance through articles.
Invalid probabilities fall back. Deterministic exclusions remain authoritative,
and curated tracker inclusion stays protected while eligible clips receive
sentiment checks. The publishing workflow is configured for shadow evaluation.

**Verification**: All 230 tests pass, including 14 new regressions covering
pipeline ordering, sentiment eligibility, request privacy, caching, and API
behavior. An independent review found no remaining scoped defects. Oliver saved
a TypeSafe key in 1Password during this review. Fifty authenticated calls to
`jev-1.13.0` succeeded. On 30 current articles, inclusion agreed with existing
decisions 22 times. In ten tracker examples with each target omitted from its
own prompt, sentiment matched four labels. Only three of seven predictions at
confidence 0.70 or above matched. The sample is small and excerpt-limited.

**Decision**: Keep shadow mode. These results do not justify enforcement.
[Issue #8](https://github.com/oliverames/cerulean-news/issues/8) retains rubric
calibration, independent holdout review, and the separate keyword-miss rescue
scope decision. The [dated review](docs/2026-09-21-jev-evaluation-review.md)
records the evidence and limits.

**Receiving-host verification**: Commit `8fdd1a3` deployed successfully in
[run 35625768907](https://github.com/oliverames/cerulean-news/actions/runs/35625768907).
That initial run correctly reported missing credentials and zero requests.
Oliver then explicitly approved the credential destination. The key was copied
securely from 1Password to the private repository's `TYPESAFE_API_KEY` Actions
secret, and `JEV_RELEVANCE` was set to `shadow`.

The activation [run 35626956144](https://github.com/oliverames/cerulean-news/actions/runs/35626956144)
passed all 230 tests and deployed successfully. Its live audit reports shadow
mode, complete status, 25 requested and successful evaluations, zero failures,
25 persisted cache entries, and 3,154 remaining candidates. Nine inclusion
judgments disagreed with the current decisions. The public feed retains 1,813
items and contains no internal cache or Jev diagnostics.

The first batch contained no sentiment-eligible articles. Scheduled sentiment
is configured and queued, while authenticated sentiment calls were verified in
the separate calibration above. The 25-item cap and four-hour schedule remain
unchanged. Enforcement and rubric improvement remain tracked in issue #8.

---

## 2026-09-21 - A Jev second opinion on relevance, off by default, and the Actions issue closed

**What changed**: Merged [#7](https://github.com/oliverames/cerulean-news/pull/7)
as `3ab34b3`. `src/jev-relevance.js` asks Jev (TypeSafe System One) three
questions per candidate article over its title and a 600-character excerpt, and
only the `include` noul gates the verdict: 0.7 and above includes, 0.3 and below
excludes, and the band between keeps the keyword verdict. `local_angle` and
`relevance` are recorded as diagnostics so a shadow run produces calibration
signals rather than having thresholds chosen before any data exists. Question
wording lives in `src/rubrics/relevance-v1.json` with the model pinned to
`jev-1.13.0`.

**The work arrived as a patch, not as a branch.** It was built in a Claude cloud
VM that could not reach GitHub, and an earlier handoff described the work as
already on a `jev-relevance` branch. It was not: no branch, commit, stash, or PR
existed anywhere, and the only artifact that had escaped the VM was an Apple Note
append, because Notes syncs through iCloud. The patch bundle turned up later on
the Desktop and applied cleanly to `a23222b`.

**Verification**: 216 tests pass, 18 of them new, none touching the network. The
suite was checked for teeth rather than trusted: breaking the shadow
short-circuit failed 1 test, failing open on an unknown mode failed 1, sending
deterministic rejections to Jev failed 2, and throwing instead of falling back
failed 3. The privacy guarantee is asserted directly, with `SECRET FULL ARTICLE
TEXT` planted in `articleText` and the serialized request checked for its absence.
`outputs.js` builds an explicit field list, so the `jevRelevance` diagnostics
cannot reach `feed.json`. CI passed on the PR in 32s.

**Nothing calls Jev yet.** `JEV_RELEVANCE` defaults to `off`, no workflow or repo
variable sets it, and there is no `jev` CLI on the Mac, so even `enforce` would
fail closed to the keyword verdict.

**Resolved this session**:
[#5](https://github.com/oliverames/cerulean-news/issues/5), the Actions billing
block. The last eight `publish-feed` runs all succeeded, and the live pages were
checked rather than inferred from green runs: both `/` and `/trends` return 200
with no password-gate source, and the feed carries 1,807 items with the newest
timestamped 2026-09-21T10:20Z.

**Left off at**: `main` at `3ab34b3`, clean, `jev-relevance` branch deleted.

**Open questions**: [#8](https://github.com/oliverames/cerulean-news/issues/8)
carries the calibration work. The rescue case the design note describes cannot
happen in this implementation, because an article with no keyword hit never
becomes a candidate and a deterministically rejected item is skipped. Only the
filtering direction works today, and whether rescue is worth building is the open
question.

---

## 2026-09-18 - Actions publishing restored, Worker handed off, stall gap measured

**Why**: GitHub Pro activated, which cleared the account-wide billing block that
had failed every private-repo run since 2026-09-05. Publishing needed to move
back to Actions, the Worker's archive needed to carry over before its cron was
turned off, and the days the stall left thin needed filling if they could be.

**Actions is green**: a dispatched run succeeded end to end in 8m56s and the
four-hour schedule is live again. Nine runs today, all green. No workflow
change was needed for the unblock itself; the block was purely billing.

**Archive handoff**: the Worker's R2 copy and the Pages copy had each moved on,
so neither was a superset. R2 held 70 items Pages lacked (54 from September, 42
of them never relevance-judged, including the UVM Health layoffs and the Blue
Cross VT food-insecurity story); Pages held 15 the Actions run had just
collected, plus the only copy of the 140-entry articleCache, which the Worker
keeps in KV instead. Merging Pages-as-base plus the 70 gave 4,460 items with no
duplicate links, deployed to Pages so the next Actions run would seed from it.
That run kept all 54 September items. The 36 it removed were 16 June items at
the 92-day ARCHIVE_MAX_AGE_DAYS boundary and 20 cross-outlet duplicates; every
story in the 20 survives under another outlet, so no coverage was lost.

**Judging recovered more than crawling did**: the merge left 68 unjudged items,
56 of them inside the stall window, and they sat at the head of the pending
queue under the 100-item cap. One run cleared all 68 and turned up 41 relevant
stories that had been sitting in the archive unscored: 8 September went 0 to 7
relevant, 9 September 0 to 7, 10 September 0 to 13, 11 September 0 to 12.

**Backfill**: Google News search ranks by recency and each search source keeps
only its newest `maxItems`, so once collection resumes the stalled days are
crowded out of every `when:30d` result permanently. BACKFILL_AFTER and
BACKFILL_BEFORE swap the rolling window for explicit `after:`/`before:` bounds
on all 33 Google search sources; the 60 non-Google sources are untouched.
Two bugs surfaced in use and are fixed. Setting maxPubDate at the end of the
window tripped isSourceWindowClosed, whose guard is meant for permanently
bounded historical searches, so the first sweep skipped all 33 sources and
added 2 items; Google's `before:` already bounds the top end, so maxPubDate is
simply not set. And capping freshness by env was not enough, because
cachedResponseStillFresh reads a freshUntil earlier runs persisted into
crawlState, so backfilled sources now carry refetchIgnoringCache. Cooldowns are
deliberately left alone: those are outlets returning 429.

**Outcome of the backfill: close to nothing, and the reason matters.** With the
mechanism fully correct, 86 of 97 sources queried and 976 items collected, the
gap window gained 1 item. Measured against each day's own weekday baseline
(weekends run 16-25 items, weekdays 43-94), 6-13 September is short by roughly
250-300 items. Of a normal day's items, 46 to 56 of 77 to 84 arrive through
direct RSS feeds, which only serve their current window and cannot be replayed;
that share is unrecoverable by any mechanism. The Google-search share is
reachable, and this sweep establishes that what it can still return for those
days is already archived: the site-scoped fallback queries do return content
from the window, but it is generic wire copy that the matcher correctly
rejects. The gap is therefore closed as far as it can be, not left open.

**Worker parked**: cron removed from wrangler.toml and redeployed, so the two
publishers no longer both crawl every source. The Worker, R2 bucket, KV
namespace and the fetch relay stay deployed; restoring the cadence is
uncommenting one line.

**Left off at**: the four-hour cadence is unchanged. At about 6.3 minutes a run
that is roughly 1,134 minutes a month against Pro's 3,000, so three hours
(about 1,512) would fit if it is wanted. September shows a small non-zero
Actions storage charge, about $0.44 net against otherwise fully discounted
usage, which is the kind of overage that can re-trip a zero spending limit.
Nine runs in one hour left 18 Vermont outlets in 429 cooldown, one
(bartonchronicle.com) on a 403 until 2026-09-19; they clear on their own.

## 2026-09-16 - Build moved from GitHub Actions to a Cloudflare Worker

**Why**: The publish workflow last succeeded 2026-09-05 15:19 UTC. Every run
since failed in under ten seconds with "The job was not started because recent
account payments have failed or your spending limit needs to be increased".
The block is account-wide and hits private repositories only, which is why the
public repos kept building. September private usage was about 3,981 billed
units against the 2,000 the Free plan allows, and roughly 90% of that was
`apple-core`'s macOS CI (334 macOS minutes bill at 10x). Cerulean News was
collateral: it went private on 2026-09-03, which moved it onto the metered
allowance two days before the allowance ran out. The site sat frozen for
eleven days at 1,743 items, newest 2026-09-05 14:06 UTC.

**What changed**: The generator is unchanged. Its storage and trigger moved.

- `src/fsx.js` is a new indirection over the four file reads and writes the
  generator makes. Node behaviour is the default, so the CLI and the tests are
  untouched; the Worker swaps in R2-backed equivalents and keeps the existing
  paths as object keys.
- The article cache moved out of the audit JSON into KV, one entry per article
  URL, keyed by SHA-256 because Google News links exceed KV's 512-byte key
  limit. Holding the whole cache cost about 80 MB of a 128 MB isolate; the run
  now loads only the entries it can touch, roughly 1,400 of 9,600, and writes
  back only what changed. `previewBackfillCandidates` was split out of
  `selectPreviewBackfillItems` so the prefetch and the selection cannot drift.
- `RSS_ENRICH_BUDGET_MS` caps article fetching within a run. A scheduled
  invocation is killed at fifteen minutes and a cold cache runs far longer than
  a warm one, so past the budget fetches are deferred rather than recorded:
  every `writeArticleCache` is guarded by `fetchArticle`, so a deferred item
  leaves no entry and a later run picks it up. Default is unlimited.
- `worker/index.js` runs the generator on the existing `17 */3 * * *` cadence
  and serves the site. The generated feeds are served from R2 and routed with
  `run_worker_first`, so the stale committed copies in `site/` can never
  shadow them, which is the failure that rolled the reader back on 2026-08-27.

**Verified**: 191 tests pass. A full run on Cloudflare completed in 319s
(collect 307s, enrich 1.5s), well inside the fifteen-minute ceiling. The
Worker serves the reader, feed.json and feed.rss correctly from R2. The 188
archived items that dropped were all dated 5-16 June and rolled off the
`ARCHIVE_MAX_AGE_DAYS` window; no newer item was lost. `www.bcbs.com`, whose
incomplete TLS chain needed `NODE_EXTRA_CA_CERTS` under Actions, fetches
cleanly from Cloudflare's edge, so that workaround is not needed there.

**Google News**: Google returns HTTP 503 with its "Sorry..." page to every
request from a Worker, while the same URLs return 200 from a laptop. Tested
with the default agent, a browser user-agent, and a different Google News
endpoint; it is IP reputation, not headers. That is 39 of 97 sources, 28% of
published items, and 39 Vermont outlets that have no other route into the
feed. Resolved by relaying those fetches through a container on home-server
(`~/docker/cerulean-fetch-relay`, `https://fetch.amesvt.com` over the amesvt
tunnel, GET only, news.google.com only, bearer token). Relaying the feeds was
not enough on its own: the URL decoder makes two further calls to
news.google.com from inside the library with no way to redirect them, which
cost 8.3 minutes of enrichment for a single article fetch, so the decode runs
on the relay too. After that, 96 of 97 sources healthy and a run in 151s.

**Outcome**: the Worker is not what the site will run on. Cutting apple-core's
macOS CI took projected private-repo usage from ~3,981 billed units to ~2,160,
which still exceeds the 2,000 GitHub Free allows, so waiting for the monthly
reset would have failed again mid-October. GitHub Pro at $4/month raises the
allowance to 3,000, which fits with headroom and avoids the Worker path's
dependency on a machine at home being awake. Oliver chose Actions plus Pro.

The Worker's archive was published to the Pages project on 2026-09-16, which
ended the eleven-day freeze and, more importantly, preserved 235 items (163
publishable, covering 6-16 September) that the Actions workflow would
otherwise have discarded when it reseeded from the frozen 5 September copy.
The Worker, R2 bucket, KV namespace and relay stay parked as a fallback; the
Worker cron keeps the archive advancing until Actions is green again, at which
point the archive is republished to Pages one last time and the cron is
disabled so the two do not both crawl every source every four hours.

**Allowance audit**: the earlier figure of ~3,981 billed units for September was
wrong; redlink-lite's macOS minutes had been read as Linux. The real total is
5,695 against a 2,000 allowance, and 5,306 of it was macOS minutes from two
repos (apple-core 3,592, redlink-lite 1,714). Exactly one scheduled workflow
exists across all 23 private repos, and it is this one, so nothing else was
draining the budget quietly. Seven Xcode and macOS build workflows were disabled
with `gh workflow disable` (reversible, no code changed): redlink-lite/tests.yml,
scanflow/ci.yml, scanflow/release.yml, skylight-bridge-ios/ci.yml,
amesdashboard/ci.yml, cloud-force/ci.yml, lookout-vermont/deploy-to-testflight.yml.
All seven were sitting blocked on the billing error and would have fired the
moment Pro activated. Publishing dropped to every four hours in the same pass.
Projected private usage is now ~1,760 units a month against Pro's 3,000.

**Left off at**: waiting on GitHub Pro. When Actions runs green, republish the
archive from R2 to Pages so anything the Worker collected meanwhile carries over,
then disable the Worker cron. `xcode-27` appears as a `runs-on` label in three
repos with no registered runner matching it anywhere on the account, which is
unexplained and should be established before that label is reused.

**Open questions**: whether the six projects whose builds were disabled get
self-hosted runners on the MacBook Pro and home-server, or stay manual.
`ames-plugins-local/marketplace-validation.yml` is still on `macos-latest`; it
uses no Xcode and cost nothing in September, but it bills at 10x if it fires.

## 2026-09-04 - Footer, search metadata, MIT license, and trends layout

**What changed**: The dateline on both pages dropped the weekday and uses a
short month ("Updated Sep 4, 2026, 4:24 PM"); both footers end with an Ames
Consulting, LLC copyright whose year is filled by script. Both pages carry a
descriptive title, meta description and keywords, canonical link, Open Graph
and Twitter cards, and a JSON-LD block; the reader's meta description and
About text frame the site as one that looks for Vermont health care news and
news about regional health insurers based in Vermont. The About text lives as
the first row of the footer notes list, under the affiliation box. The source
is released under the MIT License (`LICENSE`, package.json, README badge), and
both footers say the source is available by email since the repository stays
private. On the trends page the container width matches the reader (560px),
the outlet select fills the filter row and truncates long names with an
ellipsis, and each chart sizes its plot to the page column so the charts run
to the same right margin as the reader. README no longer describes the
section filter as live.

**Decisions made**: Kept the MIT license with a private repository and a
source-on-request footer line, which was Oliver's call for the letter to
legal. Sized chart plots in the render code rather than stretching the SVGs
with CSS, because tooltips are placed in chart units and would have drifted.
Kept each chart's per-month minimum width so a long range still scrolls. On
the first render `#report` is hidden and the chart wrap measures zero, so
`columnPlotWidth` falls back to the page column's content width.

**Verification**: `npm test` 179 pass and `node --check` clean on every source
module after each change; every push deployed through Cloudflare Pages
(latest run for `9fbcd46`). The in-app Browser pane reports a zero viewport
and zero `clientWidth` for this site, so the chart widths were confirmed in
real Chrome: every chart SVG measures 560px, equal to its wrap, with no
console errors. The outlet select was checked at desktop and phone widths.

**Left off at**: Site work complete for the day. Commits `acb3d31` through
`9fbcd46`.

**Open questions**: The GA4 cross-domain list still names bluenews.online and
oliverames.github.io, harmless since both redirect.

---

## 2026-09-03 - History scrub, Cerulean News rebrand, bluecrossvt.org crawl stop

**What changed**: Rewrote git history with `git filter-repo` to drop
`data/media-tracker-seed.json` from every commit and replace the old reader
password with `REDACTED-OLD-PASSWORD`, then force-pushed `main`. The seed now
lives outside git: the workflow materializes it from the
`MEDIA_TRACKER_SEED_B64` repo secret (gzip + base64, 25.6 KB) before a full
generation, the path is gitignored, and a missing secret warns rather than
failing the deploy. Renamed the site from Blue News to Cerulean News at
https://cerulean.news (registered through Cloudflare Registrar at 19:10 UTC):
zone `fbeba584302dd105a25112b80e914fdc`, proxied CNAMEs for apex and `www` to
`bluenews-7g0.pages.dev`, Always Use HTTPS on, the same four redirect rules as
before, and both hostnames attached to the existing `bluenews` Pages project.
The old zone's ruleset is now a single 301 to `https://cerulean.news` plus
path and query. Stopped crawling bluecrossvt.org: the Newsroom and Be Well
listing sources are gone (97 default sources), and a `noCrawl` host policy in
`src/politeness.js` makes `fetchText` refuse the host before connecting, so
an article page reached through Google News is never fetched either. The
trends page prose no longer names the insurer, the clip log, or its keeper,
and the `__bcbs*` script globals were renamed; the scoring code is unchanged.
Both pages now carry a bordered "Not affiliated" box above the footer notes,
the reader footer no longer names the insurer outside that box, and the
section filter UI is switched off (default selection unchanged: all news
categories on, owned and social posts off). The workflow seeds and reuses the
live feed from the pages.dev hostname rather than the public domain, so a
custom-domain DNS change cannot stop a run.

**Decisions made**: Kept the Pages project name `bluenews`, because renaming a
project is not supported and the name is only visible in the pages.dev URL.
Kept the localStorage key from the morning's rotation rather than forcing a
third re-entry. Blocked the host in `fetchText` rather than only removing the
sources, because Google News results still resolve to bluecrossvt.org links
and article scanning would otherwise fetch them. Left `docs/2026-08-27-media-
tracker-coverage.md`, README, and WORKLOG history alone: the ask named the
seed and the password, and those files describe method rather than data.

**Verification**: After the rewrite, `git log --all` shows zero commits
touching the seed path and zero containing the old password; the working
tree kept the untracked seed. A `--mirror` backup of the pre-rewrite remote is
at `~/Developer/Projects/vt-news-rss-bcbs-backup-2026-09-03.git` with a copy
of the seed beside it. `npm test` 179 pass after every step. Run 33796005142
(`711ca09`) seeded from pages.dev, warned on the missing seed secret, and
deployed; its audit lists 97 sources with one failure (the backfill source,
ENOENT) and no policy refusals, and 185 of the 186 seed articles are still in
the archive under their crawl-time match sources. cerulean.news answered
through the Cloudflare edge before the local resolver caught up: `/` 200 with
the new title and the affiliation box, `/feed-audit.json` 200 (20.5 MB),
`/sentiment`, `/rss`, `/json` 302 to their targets, `http://` 301 to https,
and the RSS self-link reads `https://cerulean.news`. bluenews.online now
301s to the same path on cerulean.news.

**Closed later the same afternoon**: the `MEDIA_TRACKER_SEED_B64` secret is
set (a second `gh secret set` went through), and manual run 33798932403
materialized 186 articles and fetched all of them from the backfill source.
The Universal SSL certificate for cerulean.news went active at 19:33 UTC and
`www` now 301s to the apex over TLS. The GA4 account, property, and web
stream are renamed to Cerulean News with URL https://cerulean.news. The Mac's
"Safari Can't Find the Server" was the home router caching NXDOMAIN from
before the registry published the delegation (negative TTL 3600 s from the
.news SOA); public resolvers were correct throughout.

**Left open**: pre-rewrite commits remain fetchable on GitHub by SHA until
GitHub's garbage collection or a support request purges them.

**Evening addendum**: the password gate is commented out on both pages (page
containers no longer hidden or inert, the gate script returns before touching
the DOM, the head script marks the document authenticated so the scroll lock
never applies, and the trends page sets its ready flag on the same early
return). While checking that in the browser, `/trends` turned out to loop:
the Cloudflare rule sent `/trends` to `trends.html` and Pages 308s
`trends.html` back to `/trends`. The rule now targets `/trends` and no longer
matches `/trends` itself; `/sentiment`, `trends.html`, `/trends/`, and the
old-domain path all end at `/trends` with a 200. The reader loads with no
gate, no console errors, and all stories visible.

## 2026-09-03 - Legal-exposure pass: private repo, Cloudflare Pages, disclaimer, new icons

**Why**: A review of what Blue Cross VT's legal department could object to
found two strong grounds. The public repo carried the communications team's
media tracker (`data/media-tracker-seed.json`, with Kristina's hand scores),
the coverage audit docs, and README text describing the team's workflow. And
the site presented as a Blue Cross property: the name, a Blue Cross brand blue
theme colour, the registered cross-and-shield marks as every icon, and no
statement of independence. The reader password also sat in public history.

**What changed**: Added an affiliation statement to the reader and trends
footers, the page meta description, and the RSS and JSON feed headers. Moved
hosting from GitHub Pages to the Cloudflare Pages project `bluenews` (direct
upload from the workflow with `wrangler pages deploy`, secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`), replaced the eight
GitHub Pages A/AAAA records with proxied CNAMEs to `bluenews-7g0.pages.dev`,
removed `site/CNAME` and the Pages permissions, and made the repo private.
Slowed the schedule to every three hours, rotated the password with a new
localStorage key so every browser re-enters it, and replaced all six icons
with a solid square in the reader accent blue `#0033a0`, which is now also the
theme colour. README and CLAUDE.md follow the new hosting.

**Decisions made**: Cloudflare Pages over a GitHub Pro upgrade because the
zone, redirect rules, and a Pages deploy token already existed, so the move
cost nothing and took under an hour. Three-hour cadence because GitHub Free
meters private repos at 2,000 Actions minutes a month and 29 recent runs
averaged 380 seconds, about 4,550 minutes a month hourly; every three hours is
about 1,500. The tracker seed and audit docs stay in the repo now that it is
private rather than being rewritten out of history. The `www` custom domain
on the Pages project stays "pending" because the zone's `www` redirect rule
answers before Cloudflare's validation request; it does no harm.

**Verification**: `npm test` 179 pass, `node --check` clean, workflow YAML
parses. A live-seeded manual deploy to the pages.dev URL served every file
including the 20.6 MB `feed-audit.json` (under the 25 MiB Pages limit) before
DNS moved. After the swap, every path answered through Cloudflare: `/` 200,
`/feed-audit.json` 200, `/sentiment`, `/rss`, `/json` 302 to their targets,
`http://` and `www` 301 to the apex, `trends.html` 308 to `/trends`. Actions
run 33793380459 (commit `b5497e4`) was the first to deploy through wrangler
and succeeded; run 33794123700 (`c3eff1a`) deployed the icons through the
static-only path. The live page carries the new password constant and storage
key. Repo visibility reads PRIVATE and the old oliverames.github.io address
now 404s. One misstep on the way: a bad pathspec in a combined `git add`
staged nothing, so commit `9d2e379` shipped only the CNAME deletion and one
more run went to GitHub Pages before `b5497e4` carried the workflow change.

**Left open**: the old password and the tracker seed remain in git history,
which is private now but not scrubbed. If legal ever asks for the seed to be
gone, that is a history rewrite plus a fresh export from the spreadsheet.

## 2026-09-03 - Google Analytics tag and the bluenews.online custom domain

**What changed**: Created the Google Analytics account "Blue News", property
"Blue News site" (News, US Eastern, USD), and web stream "Blue News (GitHub
Pages)" with measurement ID `G-X1CZ0X5LMG`. The gtag.js snippet now sits at the
top of `<head>` in `site/index.html` and `site/trends.html`, the only two pages.
Pointed the site at `bluenews.online`: `site/CNAME`, the GitHub Pages custom
domain setting, and the workflow's three `SITE_URL` values (so the RSS and JSON
feed self-links move too). In the Cloudflare zone (registered and activated
2026-09-03): four A and four AAAA records for the GitHub Pages anycast IPs plus a
`www` CNAME to `oliverames.github.io`, all proxied; SSL mode Full; a dynamic
redirect ruleset with `www` -> apex (301) and `/sentiment`, `/trends` ->
`trends.html`, `/rss`, `/feed` -> `feed.rss`, `/json` -> `feed.json` (302).
README now names the new address and shortcuts.

**Decisions made**: Proxied records rather than DNS-only, because the path
shortcuts need Cloudflare redirect rules and GitHub Pages cannot serve a
clean `/rss` path. The old `oliverames.github.io/vt-news-rss-bcbs` URL keeps
working because GitHub 301s it to the custom domain. Google's default
data-sharing checkboxes were left as offered; the GDPR Data Processing Terms
box was left unticked.

**Verification**: 179 tests pass, `node --check` clean. Before public DNS
existed, the chain was tested with the Cloudflare edge IP pinned via
`curl --resolve`: plain HTTP returned 200 from GitHub and every redirect rule
fired as written, while Cloudflare's Universal SSL sat in `pending_validation`
until the `.online` registry published the delegation.

**Left off at**: The `.online` delegation went public about 45 seconds after
the first poll, Cloudflare issued the edge certificate about two minutes later,
and the re-run of the failed workflow deployed cleanly. Live checks at
https://bluenews.online: both pages carry the tag, the RSS `<link>` and
`atom:link` and the JSON `home_page_url`/`feed_url` point at the new domain,
`feed.rss` passes `xmllint`, the shortcuts redirect, and the old github.io URL
301s. GitHub never issued its own certificate, and its docs explain why:
provisioning fails when the records do not point at GitHub Pages IPs, which is
exactly what a proxied Cloudflare record looks like. Decision: leave GitHub's
"Enforce HTTPS" off and enforce at the edge instead. Cloudflare "Always Use
HTTPS" is on, so http:// on either host 301s to https://bluenews.online.

**Open questions**: The GA stream
URL question from earlier in the day is Resolved this session: the stream now
points at https://bluenews.online with oliverames.github.io in its cross-domain
list.

## 2026-08-27 - Finished the interrupted feed-quality pass; released 1.2.0

**What changed**: A Codex session was killed mid-fix and left the tree failing 4
of 179 tests, three of them the exact defects it had named in its last message.
Commit `973c86c` completes the work. A second `canonicalLinkPresentation` layer
was overriding the dedupe winner's link with the tidiest URL in the group;
`canonicalLinkQuality` already penalizes tracking parameters, so a cleaner URL
should only win between peers. The override discarded the URL a hand-logged clip
recorded and made the result order-dependent. Dedupe also stopped inventing a
`guid` on items that never carried one. Released as v1.2.0.

**Decisions made**: Kept the new crash-brief rule, which rejects an in-state
crime or crash brief whose only health tie is an incidental provider mention;
the out-of-region rule cannot catch these because a Vermont placename supplies a
genuine regional signal. The pre-existing assertion that encoded the older,
weaker behavior was stale and was updated with the rejection reason pinned.
`canonicalLinkPresentation` is still used by the archive-merge path, which is
correct there, so only the winner path changed.

**Verification**: 179 tests pass under America/New_York, UTC, and Asia/Tokyo.
Both UVM newsroom date assertions now compare calendar parts rather than an
instant, because a bare card date resolves in the runner's local zone; the new
one passed only under UTC, so CI would have hidden it.

**Left off at**: Released and clean at v1.2.0.

**Open questions**: Test 10 ("publisher dates without a space before am or pm")
has the same latent zone dependence and fails under UTC+12. It predates this
work and turns on whether bare publisher dates should be UTC-normalized in
production, which is a separate decision. NEW.

---

## 2026-08-27 - Remove publisher shells, stale roundup previews, and employment pages

**What changed**: The Blue Cross site search omitted `site:` before `bluecrossvt.org`, so Google treated the domain as a search term and returned unrelated pages. The corrected query now stays on the four named domains. The relevance gate rejects Times Argus page placeholders, Vermont Journal full-edition wrappers, employment platform pages, and brand-search fallbacks with no Blue Cross text in the source material. Curated media-tracker entries remain authoritative, and the same deterministic gate runs after Gemini so a relevance re-judge cannot restore excluded pages.

**Publisher previews**: Times Argus roundup pages can contain several unrelated briefs, while the scraper can only capture the first paragraphs. RSS and JSON now publish a roundup preview only when its canonical Blue Cross or health topic matches the selected item. The Kayak Days story remains public with its generated summary, but the unrelated chronic wasting disease excerpt is gone.

**Verification**: `npm test` passes 152/152, every changed JavaScript file passes `node --check`, `git diff --check` is clean, and `npm audit --omit=dev` reports zero vulnerabilities. The corrected Google News source returned five domain-scoped pages in a live fetch. A zero-network replay produced valid RSS and newly rejected nine non-articles. It marked all six employment pages rejected, removed five mismatched Times Argus previews, preserved three aligned previews, and retained all 186 curated items. After commit `11ffc6e` reached `main`, a cache-busted fetch of the live Pages site returned an audit generated at 2026-08-27T20:42:29.574Z with 3,928 audit items, 1,627 public items, 99 source rows, and zero failures. The placeholder and every employment page are absent from the public feed, while Kayak Days remains with its correct summary and no publisher preview.

## 2026-08-27 - Harden archive continuity, matching, retries, and deployment

**What changed**: An adversarial review confirmed 23 defects across archive state, cache reuse, deduplication, matching, fetching, publishing, deployment, and the trends page. Archive loading now rejects unusable JSON, cache aliases choose the newest valid evidence, and same-link merges preserve curated provenance and terms. Google News deduplication now respects publisher identity, while the matcher rejects other Blues plans and sentence-spanning Vermont coincidences without losing real comparisons or ownership stories. Feed fetches validate RSS, Atom, or RDF before storing validators; every retry is throttled; fallback feeds retain parent limits; and the oversized Vermont health search is five bounded queries. Relevance re-judges include rejected items and sweep oldest-first, RSS drops stale sentiment, failure alerts finish before the run returns, and mobile Facebook links keep social rules.

**Deployment and reader fixes**: The publish workflow now classifies `data/` and `certs/` as runtime inputs, maps both alert secrets, and checks out enough history to compare a complete push. If that comparison is impossible, it selects a full generation instead of guessing from the tip commit. The archive seed must be a complete audit document, and the workflow fails rather than replacing durable state with the public feed or a stale committed copy. The trends page now trims isolated historical clips from the volume axis and anchors each sentiment tooltip to its own segment. The README source count is synchronized at 99.

**Review decisions**: Eight plausible reports were refuted or narrowed through focused probes, so they produced no speculative code. Two candidates remain parked: Facebook embedded-post association is dormant while social sources are disabled, and compacting cache aliases needs a migration design that cannot discard the newer alias. The production Gemini summary request still hit the documented HTTP 429 rate limit, but generation completed from cached summaries and published the full archive.

**Verification**: `npm test` passes 150/150 locally and in Actions; `node --check` passes every source module and the test file; all three inline trends scripts parse; the workflow YAML parses; and `git diff --check` is clean. `npm audit --omit=dev` reports zero vulnerabilities. A zero-network archive smoke preserved 3,922 audit items and 1,635 public items, with valid RSS and separated audit-only state. A separate live crawl reached all 99 sources with zero failures, and every split health query returned valid XML. Production run [33111764108](https://github.com/oliverames/vt-news-rss-bcbs/actions/runs/33111764108) passed the full build and Pages deployment from implementation commit `72ff305`. The deployed audit was generated at 2026-08-27T20:07:50.372Z with 3,940 items, 1,650 public items, 99 source rows, zero hard failures, and all 186 curated links carrying an outlet; the RSS parses and the deployed trends page contains both chart fixes.

## 2026-08-27 - Re-score ordering, a stale-deploy fix verified in production, and what the scored coverage says

**What changed**: A re-score always took the newest 100 items, so the same head was redone every run and older items were never reached; that is why the VT Basic clips kept stale scores through repeated re-scores despite being the whole point of the exercise. Re-scoring now sweeps oldest-first, and the per-run request cap is exposed as a `workflow_dispatch` input so a sweep can finish in one pass. `selectPendingSummaryItems` and `orderItemsForRun` were extracted from inside `summarizeItems`, which had made the logic testable only by driving a network call. Separately, `docs/2026-08-27-media-tracker-coverage.md` gained an analysis of the scored coverage set.

**Verification**: The static-only deploy fix from earlier today was confirmed against the exact condition that broke production: a docs-only push took the reuse path and the live feed came through unchanged at 1,636 items, where the same shape of commit had previously rolled the reader back to a June 12 archive of 129 items. `npm test` passes 149/149 on the merged tree and `node --check` is clean across `src/`. Live state at close: 1,636 items, 212 sentiment-eligible, 189 scored, agreement with the media tracker 68% exact and 84% within one step over 93 overlapping articles.

**What the coverage says**: Over 189 scored stories, two results run against expectation. Rate coverage is not hurting us: premiums and rate review scores +0.40 and the Green Mountain Care Board +0.14, despite being the largest single subject in the set, so the story that dominates volume is not the story that damages us. And adding payer trade press did not import a block of negative coverage, which is what it looked like at first: Becker's (+1.00) and Health Payer Specialist (+1.20) are among the most favourable outlets in the whole set, while Modern Healthcare alone sits at -0.78, and its nine stories are the same Medicare Advantage and ACA pieces that drive the three worst themes. That is one finding counted twice rather than two problems. Vermont press overall is +0.71 with 57% positive-leaning.

**Left off at**: The standing-context mechanism (`data/coverage-context.json`) is shipped and unit-tested but still unproven in production. Its first test was invalid because of the re-score ordering bug above, and the second was throttled. Gemini returns HTTP 429 after roughly one batch, which is a per-minute rate limit rather than an exhausted daily quota: a run at 19:30 summarized 10/10 in its first batch and 429'd on the second. `summarizeItems` abandons the whole run on the first batch failure, so a transient limit costs an entire run's scoring. Backing off and retrying a batch two or three times, and/or raising `SUMMARY_BATCH_DELAY_MS` above the current 5s, is the obvious next change; it was not made because another session held uncommitted edits in `src/summaries.js` at the time.

**Open questions**: Whether the VT Basic storyline note actually changes those four scores, which needs a re-score sweep that completes (`rescore_sentiment` with a small `summary_max_requests`, perhaps 5, rather than a large one that guarantees a first-batch failure). Four items in the coverage set are not press coverage and were crawled rather than logged by the team: a page-scan artefact ("Page A18"), an employer-review page on `breakroom.cc`, a shopper insert, and an events listing. At ~2% they move no figure, but the first two are not articles.

## 2026-08-27 - Harden cache provenance, dedupe, webhooks, and dependencies

**What changed**: Four confirmed defects were fixed. Media-tracker provenance now supplies `Blue Cross VT` and `mediaTracker` through both article and matched-item cache paths, so a cached no-match cannot drop or misclassify a hand-logged clip. Deduplication always removes Google News publisher suffixes, but removes a direct-publisher suffix only when it matches the resolved outlet, which preserves real subtitles. Slack and Discord deliveries now reject non-2xx responses, cancel failed response bodies, and run concurrently. The lockfile now resolves `undici` 7.29.0, which clears the advisories attached to 7.28.0.

**Decisions made**: Kept curated fallback behavior in one helper so every enrichment exit assigns the same terms and source. Used the resolved outlet instead of a broad suffix heuristic because subtitles and publisher labels use the same punctuation. Left nested comment counts unchanged because the work log records the 25 top-level cap, with nested replies beneath it, as intentional. Discarded unproven changes to stale validators and preview opt-outs because their configured production paths did not reproduce defects.

**Verification**: `npm ci` and `npm audit --omit=dev --package-lock-only` report zero vulnerabilities, and GitHub's Dependabot API reports zero open alerts. `npm test` passes 135/135, `node --check` passes every source module and the test file, and `git diff --check` is clean. Two offline runs keep 3,907 items in byte-identical RSS and public JSON, and `xmllint` accepts the RSS. A production-shaped replay restores all three missing tracker URLs and produces 3,910 items. Actions run 33105674280 passed its full build and Pages deployment. The deployed audit was generated at 2026-08-27T18:53:24.771Z with 3,923 items, and all three URLs appear as `Blue Cross VT` with `matchSource: mediaTracker`.

## 2026-08-27 - Close the three open items: negative-cache drop, standing context, and the August question

**What changed**: (1) A negative article cache was silently dropping curated clips. Three tracker entries never reached the always-include path because the same URLs had already been crawled, found non-matching, and cached as such; `itemFromArticleCache` returning null short-circuits the whole enrichment branch. A crawler's earlier verdict must not override a hand-logged clip, so curated entries now pass that gate. Coverage goes 183 → **186 of 186 rows, none rejected**. (2) `data/coverage-context.json` carries standing storyline notes into the sentiment prompt, matched per article so a batch only ever sees the notes it needs. It ships with one storyline, VT Basic, derived entirely from scores already in the tracker. (3) The August volume question is answered, and an earlier claim about it corrected.

**On the August correction**: An earlier reading reported August as roughly double any prior month. That was wrong, and wrong in an instructive way: it measured before the tracker was seeded, so each month counted only what the crawler independently found, and the crawler's reach grew across the period. Early months were undercounted, not quiet. Seeded, the run is 23, 5, 31, 26, 18, 25 for March through August, which makes August ordinary and May the busiest. What August genuinely shows is a change of subject rather than volume: Green Mountain Care Board mentions go 2 → 8 against July and premiums and rate review 3 → 8, which is the annual rate-decision cycle, plus Kayak Days sponsorship coverage across four outlets. Both are annual events, so the pattern is predictable rather than surprising.

**Decisions made**: Put standing context in a data file rather than the prompt source, because it is the communications team's input and not the crawler's; the generator cannot derive it, and asking someone to edit a JavaScript template string to record a storyline is the wrong ask. Read it once at startup and degrade to no storylines on any error, since a typo in a context note must never stop hourly generation. Matched storylines per article and included only the notes a batch actually touches, so the prompt does not grow with the file. Seeded only the one storyline for which the tracker carries direct evidence across four scored clips, rather than inventing plausible-sounding notes about the business.

**Verification**: `npm test` 130 pass, with new tests for a curated clip surviving a negative article cache, storyline notes reaching the prompt only for matching articles, and a malformed context file degrading safely. Full offline run against the live archive: all 186 tracker rows present, none rejected.

## 2026-08-27 - Seed the media tracker into the archive, and fix the dedupe bug that was eating roundups

**What changed**: Three related things. (1) `data/media-tracker-seed.json` carries all 186 rows of the communications team's media tracker, and a new `Media Tracker Backfill` source reads it from disk each run. It is local input, so there is no fetch, no throttle and no failure mode that can mark the source unhealthy, and re-emitting every run means the archive self-heals. Roughly 40% of the list names us only in the article body, which the seed cannot see, so a curated entry survives without a term match (`matchSource: "mediaTracker"`), counts as brand coverage regardless of terms, and is exempt from the three-month retention window, since most of the list predates it. Source count goes 94 → 95. (2) `dedupeResolvedItems` was collapsing successive roundup editions. It stripped any trailing `- ...` to remove an outlet suffix, which on "Health Briefs - Jan 22, 2026" removed the date, so every briefs edition normalized to "health briefs" and all but the first were discarded. A suffix carrying a digit is a date, not an outlet, and is now kept. The Times Argus briefs count in the archive goes from one to seven. (3) `itemCategory` gives the reader's sections a single definition, applied at both enrichment and publishing.

**Decisions made**: Seeded rather than crawled, because the tracker runs from December 2025 and this repo's first commit is 2026-05-13, so no crawl can reach most of it; several entries also sit behind outlets that answer 403. Turned article scanning off for the source: 186 extra fetches would risk the workflow's 30-minute timeout, and the tracker's headline, outlet and topic already carry what the matcher and summarizer need. Recomputed `category` at the publishing boundary rather than trusting the stored value, the same lesson as the stale sentiment score earlier today: an item classified under an older rule never re-enters enrichment, so publishing has to be the gate or the archive stays wrong forever. Applying it moved 88 `bcbs.com` association pages out of Blue Cross VT, which matches how Oliver defines the sections: Blue Cross VT means the story mentions us, and those pages match a bare "Blue Cross" while never mentioning Vermont.

**Verification**: `npm test` 126 pass, with new tests for the seed parser, curated retention outliving the window, provenance standing in for Vermont corroboration, and successive roundup editions surviving dedupe while a genuine same-outlet duplicate still collapses. Full offline run against the live archive seed: 3,953 items, RSS valid under `xmllint`, sections read VT Health Care 1,436 / Blue Cross VT 221 / BlueCrossVT.org 39, and sentiment-eligible rises from 62 to 215. 184 of the 186 tracker rows are present as stories; two of the four URL-level absences are same-title duplicates inside the tracker itself, where the story is present under the other URL.

**Two follow-on fixes the live run exposed**: The summarizer was vetoing a hand-logged clip. "Payers pitch 2027 ACA rates: 7 updates" landed in the archive with `relevant=false`, because `applyDeterministicRelevance` exempts curated entries but the Gemini relevance pass does not. The model sees only a headline and a topic note, so its veto is worse-informed than the judgement it overrides; a media-tracker entry is now never marked irrelevant. Separately, a curated entry now wins a dedupe title collision against a crawler copy, since it carries the outlet and URL the team actually recorded. Together these take coverage from 179 to 183 of 186 rows with none rejected.

**Follow-ups**: Three rows are still absent from the merged archive despite surviving enrichment, merge and dedupe in isolation: two Becker's roundups ("Meet the CEO of the BCBS affiliate in every state", "7 Blue Cross Blue Shield updates") and "Health Briefs - May 28, 2026". The cause is not isolated; they vanish only when merged against the full archive. Scoring the ~125 newly eligible items will take about two hourly runs at the current summary cap.

## 2026-08-27 - Stop scoring other Blues plans, and broaden the trends page to volume and themes

**What changed**: Three things. (1) A bare "Blue Cross" match no longer qualifies for sentiment on its own. The matcher accepts the generic term, which is right for surfacing a story but too loose to score, and it had scored a BCBS Massachusetts story (gazettenet.com, "Blue Cross, Cooley Dickinson assure Medicare Advantage patients") and a generic "new Blue Cross CEO" piece in Modern Healthcare. `namesBlueCrossVermont` now requires corroboration for a bare match: a Vermont-specific brand label, a known Vermont outlet host, or Vermont in the text. Two TikTok explainers were also being scored, because `itemSourceType` only recognises Facebook as social, so `isSocialVideoItem` now excludes short-video hosts from scoring. Together these drop exactly four items and keep all five legitimate Vermont stories that matched only on the bare term. (2) The reader's sentiment line moved below "Included because" and now flows as prose rather than a flex row, which was pushing a wrapped label and its rationale into separate columns. (3) The trends page gained a coverage-volume chart and a themes chart, was renamed Coverage Trends, and the nav button with it.

**Decisions made**: Wrote a Vermont-only pattern rather than reusing `REGIONAL_SIGNAL_PATTERN`, which counts all of New England and so would have let the Massachusetts story through. Excluded social video from sentiment only, leaving `itemSourceType` alone, because reclassifying those items would move them into the reader's Social section and that is a wider change than this. Published a `sentimentEligible` flag from the generator instead of re-deriving the gate in browser JavaScript, which keeps one definition of the coverage set and lets the volume chart count a story the hour it arrives rather than the hour it is scored. Used a single hue for volume and themes rather than the diverging sentiment ramp, because those are magnitude, not polarity.

**What the data says**: Of 1,566 published items, 1,369 never name us. Of the 197 that do, 86 are bcbs.com association pages ("Transplant Static List" and the like, matching on "Blue Cross" alone), 39 are our own BlueCrossVT.org posts, and 10 are job listings, Facebook or social video, leaving 62 pieces of press coverage. So a low scored count measures how much coverage exists, not a scoring backlog. Brand coverage volume by month runs 15, 16, 13, 41 for May through August 2026, and the themes we are covered for are led by health insurance (13), premiums and rate review (11), health care (11) and the Green Mountain Care Board (9). Net sentiment by outlet spans VTDigger at -0.20 to Vermont Business Magazine at +1.86.

**Verification**: `npm test` 122 pass, with new tests covering the bare-match corroboration rule (Massachusetts excluded, Seven Days and a Vermont-in-text story kept, a Vermont-specific term never needing corroboration) and social-video exclusion. Measured the change against the live feed before shipping: 66 scored becomes 62, dropping exactly the four leaks with no legitimate item lost and nothing newly eligible left unscored. Both pages rendered in the browser against a preview built from the live feed with the real gate applied; the volume, sentiment, mix, outlet and theme charts all render, tooltips and filters work, and there were no console errors.

## 2026-08-27 - Payer trade press sources, and sentiment calibrated on the tracker's own scores

**What changed**: Added Becker's Payer Issues, Modern Healthcare and Health Payer Specialist, the three outlets the coverage audit named as the largest gap (Becker's alone is 17 of the tracker's 185 clips). None exposes a usable feed: beckerspayer.com and modernhealthcare.com answer 403 to any user agent and healthpayerspecialist.com redirects to a login, so all three are Google News site-scoped searches instead. Source count goes 91 → 94. Separately, the sentiment prompt now carries ten worked examples taken verbatim from the tracker, with the scorer's own rationale attached, plus a fifth rule and an explicit instruction not to hedge toward neutral on a thin excerpt; the excerpt cap rose from 700 to 1,200 characters.

**Decisions made**: Scoped the trade searches by brand name rather than by "Vermont". The looser form looked convincing when probed unbounded, because Google orders by relevance and the Vermont stories sit at the top, but a live run showed the local date window then keeps only recent items and the survivors were national filler: Modern Healthcare returned job adverts, and the broad-national relevance gate did not catch them because "Registered Nurse Job Opening in Whitefield, New Hampshire" reads as a regional signal. Six of seven kept items were junk. Naming the brand takes Becker's to 32 matching stories that are almost exactly the tracker's own clips, and a live run then kept three real items with nothing rejected. Left out any `when:` bound because adding one made Google News fall back to unrelated results, the same degradation already documented for long OR queries; the window is enforced locally by `maxItemAgeDays`, set to 180 because these are low-volume and a short window misses the back catalogue the sources were added to capture. Kept Health Payer Specialist despite it returning zero, because it costs one request per run, an empty 200 is not a fetch failure and so does not trip failure-streak alerting, and the brand matcher gates anything it does return.

**On calibration**: The first live scoring run diverged from the tracker in a specific, correctable way. The tracker's scored set is 65% positive; the model produced 29% positive and 40% neutral. Reading the tracker's rationale text against its scores showed why: she treats ordinary favourable brand presence as positive, where the model defaulted to neutral. "Business Briefs - Saturday, May 2", logged only for BCBSVT taking part in Walk@Lunch Day, is positive to her. So is "2026 Best of Business in Vermont recipients announced". Rule 5 now states that outright, and the ten worked examples span all five points of the scale so the anchor is not lopsided. The excerpt cap rose alongside it because several live scores were neutral for want of evidence rather than for balance, one reading "Article content is unknown, only that it mentions Blue Cross"; the scorer reads the article, so the model should see more of it.

**Verification**: `npm test` 120 pass. Two new tests cover the trade sources (site scoping, search-feed flags, absence of a `when:` bound, presence of a local date window, broad-national gating) and the worked examples (every scale point represented, calibration lines present); the existing source-count assertion moved 91 → 94. Live fetch of the three new sources through `generateFeed`: Becker's 7 items, Modern Healthcare 0, Health Payer Specialist 0, all three fetching cleanly, with three items kept and none rejected. Before tightening, the same run kept 6 junk items out of 7, which is what prompted the brand-scoped rewrite.

**Follow-ups**: "Payers pitch 2027 ACA rates: 7 updates" comes through as VT Health Care rather than Blue Cross VT, so it will not be scored, while the tracker scores it positive. It is a Becker's roundup naming several payers, and reclassifying it means touching the brand matcher, which is a wider change than this one. Modern Healthcare's two matching stories are older than the 180-day window, so it will sit at zero until it next covers us.

## 2026-08-27 - Sentiment scoring from Kristina's media tracker, plus a trends page and a coverage audit

**What changed**: Press coverage that names Blue Cross VT now carries a five-point sentiment score, and `site/trends.html` charts those scores over time. The scale (`positive`, `neutral to positive`, `neutral`, `neutral to negative`, `negative`) is lifted from the communications team's own `Media Tracker.xlsx`, where 155 of 362 rows are hand-scored; the free-text rationale several of those cells carry turned out to encode the actual method, and four rules taken from it now travel in the Gemini prompt: judge tone toward BCBSVT rather than toward the story, weight the headline separately and heavily, weight mention prominence so a footnote pulls toward neutral, and let a negative topic drag the score even when we are not the target. Scores ride in the existing batched summary request, so sentiment costs no additional API calls, and they persist through `feed-audit.json` like summaries do. Scoring is gated locally in `shouldScoreSentiment` rather than trusted to the model: brand category, press only, excluding BlueCrossVT.org (owned), Facebook (social), `bcbs.com` (national association pages that match only the generic term "Blue Cross"), and job-board listings. Every item also gained an `outlet` field resolved from the article link, because Google News search feeds carry the query name and 84% of brand items would otherwise report an outlet of "Google News Search". `docs/2026-08-27-media-tracker-coverage.md` records the coverage audit that prompted all of this.

**Decisions made**: Scored only brand press coverage rather than everything, per the ask, which turned out to matter more than expected: of 1,560 visible items only 66 qualify, so the whole backfill fits inside one hourly run and the summary cap never binds. Excluded `bcbs.com` after finding 87 of 161 brand-category items were association web pages like "Transplant Static List" and "Bariatric Surgery Static List", matching on "Blue Cross" alone; these are not coverage and would have dominated the average. Excluded job listings (5 of the remaining 74) because recruitment copy reads bland-positive for no editorial reason. Added `outlet` to the published JSON rather than deriving it in the trends page alone, so the RSS and JSON consumers see the same publisher the charts group by. Chose a diverging colour ramp with a neutral midpoint over a categorical one because the scale is polarity, and validated it rather than eyeballing: the first candidate built from the site's existing blues failed normal-vision separation at ΔE 14.2 between the light blue and the grey, so the ramp was re-stepped around a pale neutral to reach ΔE 20.7 for colour-vision deficiency and 21.2 for normal vision. The all-time view trims its time axis to the current run of coverage, because the archive holds isolated clips from 2018 and 2021 that otherwise bury 20 real months under 80 empty ones; the trimmed months stay in the totals and in the table, with a note saying so.

**Coverage audit**: Compared all 185 unique articles in the tracker against the live archive by URL and by title similarity. Whole-tracker recall is 45/185 (24%), but that number is dominated by the period before this repo existed (first commit 2026-05-13, real archive density from June). Over the window the crawler actually ran, June 1 to August 27 2026, recall is 29/58 (50%) and improving: June 42%, July 38%, August 72%. The 29 in-window misses split two ways. Fourteen are on outlets not in the source list at all, dominated by payer trade press (Becker's Payer Issues 4 in window and 17 across the tracker, Health Payer Specialist, Modern Healthcare, WSJ); adding Becker's, Modern Healthcare and Health Payer Specialist would close about ten of them. The other fifteen are on domains already crawled but are mostly calendar entries, business-briefs roundups, letters to the editor and event listings, where the brand name sits in one line of an unrelated roundup page; three are substantive and worth chasing (VermontBiz on the AM Best upgrade, the Times Argus "Mutual benefit" editorial, VermontBiz on the pharmacy discount card bill).

**Verification**: `npm test` 118 pass (13 new, covering the scale, the tracker's real-world misspellings, the scoring gate and each exclusion, prompt contents, stray-score rejection, output shape, and an archive round-trip proving a score survives a run). `node --check` clean on all of `src/`. Offline pipeline smoke with `sources: []` against a seeded audit copy wrote 2,686 audit items and 1,218 public items, all carrying `outlet`; `xmllint --noout` clean on the generated feed. Both pages rendered in the browser against a local preview built from the live archive, with the charts, all three tooltip layers, both filters, the legend and the table view exercised and no console errors.

**Follow-ups**: Two TikTok items classify as `News` rather than `Social` and so are eligible for scoring; `itemSourceType` only recognises Facebook. Deliberately left alone because changing it moves those items into the reader's Social section, which is beyond this change. The calendar and briefs recall gap is a product decision rather than a bug and needs Oliver's call before any matcher work. The payer trade press sources are the highest-value coverage gap and are not yet added.

## 2026-08-26 - Clear the deferred follow-ups: bounded Facebook text, nested comment replies, global cache freshness, backfill retirement

**What changed**: Four deferred items from the two August 25 passes, each measured or tested before landing. (1) `parseFacebookPageHtml`'s anchor path took `closest("article, section, div, li")` for post descriptions, and Facebook's deep div wrappers meant that could be page-wide text; it now walks outward from the link (max six levels) and takes the first text-bearing container within 1,200 characters, falling back to the shortest container hard-truncated. (2) `extractArticleComments` dropped nested reply elements entirely; replies now attach to their nearest enclosing captured comment via a document-order element map, so WordPress-style threaded comments survive into feeds, JSON output, and reader rendering, which already had reply markup paths. (3) Cache-Control freshness honoring is no longer limited to politeness-policy hosts. A live sample of 22 production origins showed about half sending useful `max-age` (mostly 5-15 minutes) and one advertising 31 days, so non-policy origins honor their declared freshness up to a new `RSS_GLOBAL_CACHE_FRESHNESS_CAP_MS` cap (default one hour, `0` disables); the cap is what makes this safe, and policy hosts keep their own longer caps. (4) The retired Jan. 1-June 13, 2026 backfill search was deleted outright rather than kept as an inert row: its window can never reopen, its 25-term mega-query was the exact shape proven broken in the recall pass, and its items persist in the archive regardless. Source count goes 92 → 91.

**Decisions made**: Chose a bounded walk for Facebook descriptions over picking a tighter selector set because Facebook's markup depth is unpredictable and the walk degrades gracefully at every level. Kept comment nesting inside the existing 25-comment cap with top-level entries only counted against it, matching how the reader and RSS render threads. Set the global freshness default to one hour rather than the policy hosts' 24 because hourly pickup latency matters more for ordinary outlets than for the site being monitored, and the County Courier measurement (31-day max-age) showed uncapped trusting would park sources for a month.

**Left off at**: Committed and pushed to `origin/main`; CI watched green and the deployed run verified. Remaining known gaps are unchanged: bcbs.com's incomplete TLS chain is worth reporting to whoever operates the site (workaround in place either way), and the parked social-source pipeline remains off by default.

**Open questions**: None new.

**Verification**: `npm test` green (106/106: two tests updated for comment nesting and the source count, four new covering the Facebook bound, global freshness honoring with the cap, and the disable switch). `node --check` clean on all `src/*.js`. Offline pipeline smoke with the seeded audit copy preserved the baseline 2,686 items exactly and `xmllint --noout` passed.

---

## 2026-08-25 - Fix brand-search recall, the BCBSA TLS outage, and outlet fallbacks (live-data pass)

**What changed**: Three production-facing fixes driven by measurements against live origins and today's audit. (1) The flagship "Google News Search" brand query had collapsed: Google News degrades long OR queries so badly that the 23-term query returned 3 items while its own terms unioned to 49 (94% recall loss; the production run got 0). Mixing `site:` operators with quoted phrases is especially destructive (1 item vs ~17 for the parts), and even homogeneous groups degrade past a few terms. Replaced it with seven small homogeneous sources — site search (4 site terms), phrase search, spelling-variant search, two Boolean searches, two full-name searches — each validated live before landing; a pipeline run over just these seven collected 51 items and matched 42. A test pins every brand query under 160 characters and forbids `site:`/phrase mixing. (2) BCBSA Association News had failed 637 consecutive hourly runs: `www.bcbs.com` serves an incomplete TLS chain (leaf only, no DigiCert Global G2 intermediate), which browsers repair via AIA fetching but Node deliberately will not, so both Actions and local Node failed with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. Bundled the missing intermediate from DigiCert's own CA issuers endpoint (`certs/digicert-global-g2-tls-rsa-sha256-2020-ca1.pem`, fingerprint C8:02:5F:...:25:A9) and pointed `NODE_EXTRA_CA_CERTS` at it in the publish workflow; verified 200 + parser extraction of 6 real items afterward. (3) The outlet fallback feeds shared the same query disease: the 13-term mixed fallback returned 4 items for timesargus.com where a compact 4-term query returns 101 (37 for vtdigger.org). Trimmed `LOCAL_OUTLET_FALLBACK_TERMS` to health care / health insurance / hospital / blue cross — every removed term already lives in the Vermont Health Search query, so nothing is lost project-wide.

**Decisions made**: Treated recall loss as the top finding because the brand search is this project's reason to exist and the data was unambiguous. Chose chunk splitting over one mega-query because OR-composition itself proved unreliable at size while small chunks measured at or near their union. Accepted that more items now flow into enrichment (longer runs) as the price of actually seeing coverage; steady-state cache absorption bounds the marginal fetches. Kept the spelling-variant chunk feed-only since its hits duplicate the Boolean searches' by construction. The cert bundle is the authentic DigiCert intermediate fetched from cacerts.digicert.com, not a self-signed bypass; trusting it is consistent with the default store, which already trusts its parent root. Worth reporting the incomplete chain to whoever operates bcbs.com (likely an Akamai origin misconfiguration); the workaround stays correct either way.

**Left off at**: Committed and pushed to `origin/main`; CI watched green. Candidate follow-ups not taken: `parseFacebookPageHtml` anchor-path descriptions are unbounded, HTML article comment replies are dropped rather than nested, only policy hosts get the Cache-Control freshness skip, and the closed-window backfill source still carries a 25-term mega-query (inert, kept for provenance).

**Open questions**: Whether bcbs.com's TLS misconfiguration should be reported internally by Oliver to the association's web team.

**Verification**: `npm test` green (103/103: two updated for the source split, three new covering brand-query shape invariants, cause-code surfacing, plus the prior pass's tests). `node --check` clean on all touched modules. Live end-to-end: the seven new sources ran through `generateFeed` (51 collected → 42 matched, 26 brand-category), `xmllint --noout` clean on the generated feed, and `NODE_EXTRA_CA_CERTS` + the bundle produced HTTP 200 from www.bcbs.com under plain Node with the existing parser extracting 6 items from the served HTML.

---

## 2026-08-25 - Bug-fix pass on the crawler and source-finder layers

**What changed**: Four fixes, each with a regression test. (1) `VERMONT_SOURCE_NAMES` covered only 24 of the ~65 hand-curated Vermont outlets, so small-town papers (Cabot Chronicle, Waterbury Roundabout, The Commons, and roughly 37 more) lost the sourceName regional fallback and their local health stories were rejected as "outside Vermont" whenever the copy named no other Vermont place; the set now covers every curated outlet except national/search feeds and brand-owned listings, and a new sync test forces any future source to be either registered or explicitly excepted. (2) The out-of-region state veto misfired on Vermont geography: "Washington County" (plus the towns of Washington, Georgia, and Florida) matched `NON_NEW_ENGLAND_STATE_PATTERN`, so e.g. a Times Argus Washington County story was rejected as out-of-state; `hasRegionalSignal` now strips those three ambiguous tokens before the veto, which only ever gates the Vermont-outlet branch, so national outlets are unaffected. (3) `fetchText` threw on non-OK responses without consuming the body, pinning each error response's socket until GC; it now cancels the unread body before raising. (4) `writeOutput` created only the RSS directory, so independently configured output paths in other directories crashed with ENOENT; it now mkdirs each output's own directory.

**Decisions made**: Treated the `VERMONT_SOURCE_NAMES` gap as a bug rather than calibration because the set's purpose (per the summary prompt, "small local items" matter) contradicts leaving curated outlets unregistered; noise risk is bounded because Gemini still judges everything that passes. Chose token-stripping over reordering the veto because flipping the precedence would have re-admitted Vermont outlets' national syndications wholesale. Probed two suspected bugs and disproved them rather than "fixing" them: the UVM newsroom parser cannot crash on malformed hrefs (its `a[href^="/newsroom/"]` selector filters them before `new URL`), and `TRANSPORT_IDIOM`'s global flag is safe (only used via `String.replace`, which resets `lastIndex`).

**Left off at**: All changes verified and pushed to `origin/main`. Candidate follow-ups not taken: `parseFacebookPageHtml` anchor-path descriptions are unbounded (embedded-posts path is fine), article comment replies found in HTML are dropped rather than nested, and only policy hosts get the Cache-Control freshness skip (see 2026-08-07 open question).

**Open questions**: None from this pass.

**Verification**: `npm test` green (101/101: 97 prior + 4 new covering the roster sync, the Washington/Georgia/Cabot rescues with a CNN guard, error-body release, and per-directory output creation). `node --check` clean on all `src/*.js`. Offline pipeline smoke (`sources: []`, seeded audit copy, zero network) preserved 2,686 items — byte-identical count to the same smoke run against clean HEAD in a throwaway worktree, proving no regression in merge/archive behavior. `xmllint --noout` passed on the generated feed.

---

## Earlier history (before 2026-08-23)

- 2026-08-07 - Added `src/politeness.js`, a per-host crawl policy for bluecrossvt.org: stored `freshUntil` honors `Cache-Control: max-age` minus `Age`, a shared 5s throttle, and `preferLastModified` drops `If-None-Match` when an origin ignores its weak ETag (RFC 9110 makes `If-None-Match` suppress `If-Modified-Since`); honor max-age in full (Oliver's call over a 6-hour cap); the Chrome user agent with client hints and the absence of robots.txt fetching are deliberate; committed `site/feed-audit.json` seed refreshed with `articleCache` emptied; 97 tests.
- 2026-07-22 - Added a client-side password gate to the reader, a presentation gate rather than access control (`7b71ccc`); added a manual test-workflow entry point and a non-publishing release dry run, both green; 90 tests.
- 2026-07-21 - Added `CLOUDFLARE_MIGRATION_PLAN.md` for a phased Cloudflare move (`3c11ebc`); do not deploy news artifacts through the `amesvt-website` Pages project, because independent deployments could overwrite each other.
- 2026-07-13 - Rewrote `main` and `v1.1.0` history to replace old emails with the noreply address and remove donation and social links, a machine-local path, and AI trailers; force-pushed with leases, Gitleaks clean; GitHub still serves old objects by exact hash, and only GitHub Support can purge them.
- 2026-07-12 - Added bounded paywall previews (unauthenticated HTML, at most two paragraphs and 600 characters, not a bypass) and revisit up to 25 archived paywall stories per run; sources to 86 rows, The Times Ink removed; Google News can ignore `when:`, so searches carry local rolling date guards.
- 2026-07-02 - Reliability sweep for v1.1.0: Retry-After HTTP-date parsing capped at 24h, 15s in-run retry cap, 408 retryable, charset-aware decoding, one-day TTL for fetch-failure no-match verdicts, validated seed download, compact audit JSON, and `release.yml`; Charlotte News and Times Ink 415s are runner IP-reputation blocks; 70 tests.
- 2026-06-22 - Bumped `actions/upload-pages-artifact` to v5.0.0, SHA-pinned (`fc324d35`); sibling `bcbs-rss` failed because a private repo on the Free plan cannot use Pages, so it was made public (`4e0748b`), with one gitleaks false positive.
- 2026-06-18 - Expanded `DEFAULT_SOURCES` from 39 to 81 rows of Vermont Press Association and community outlets, using site-scoped Google News for outlets without usable feeds; Northfield News only via Google because its domain returned spam HTML; 61 tests.
- 2026-06-16 - Crawl hardening: audit-only crawl state with feed validators, 304 handling, primary-feed cooldowns (24h for 403, Retry-After or 2h for 429, 1h otherwise), `smart` article scan mode, bounded negative cache, and a static-only deploy path; Google News fallbacks for 403/429 primary feeds and an 8s `townnews-search` throttle group; 61 tests.
- 2026-06-16 - Parked social sources behind `ENABLE_SOCIAL_SOURCES=true`, added article comment extraction and site icons (`a29ac13`), excluded obituaries at collection and archive load, and added Kristina's Boolean list to the Google News queries.
- 2026-06-13 - Rewrote the README to the `readme-style` structure (`6fbf24d`), with a "license not specified" badge rather than an invented license.
- 2026-06-12 - Review backlog cleared: persisted failure-streak alerts (`WEBHOOK_FAILURE_THRESHOLD` 24), concurrent source fetch (`RSS_SOURCE_CONCURRENCY` 4), SHA-pinned actions, `test.yml`, a response size cap (`RSS_MAX_RESPONSE_BYTES`), 30-minute job timeouts, and `src/index.js` split into eleven modules; the old throttle raced and never enforced its delay, so fixing it raised runs from about 2:15 to 9:10; Dependabot skipped.
- 2026-06-12 - Expanded the monitor to Blue Cross VT and Vermont health care with JSON Feed, Facebook discovery, and capped `gemini-2.5-flash-lite` batching; split public `feed.json` from `feed-audit.json`; three-month rolling archive with direct Blue Cross VT mentions kept indefinitely; paginated reader with search and multiselect sections; runs `27440191807`, `27441377646`, `27441758972`.
