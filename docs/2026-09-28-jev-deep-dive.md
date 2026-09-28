# How Cerulean News selects and scores articles with Jev

September 28, 2026
Author: Oliver Ames

This review traces how an article reaches the feed and how its sentiment is scored. It compares the code with the live audit and with the history recorded in `WORKLOG.md`, the dated reports, and GitHub issues #1 to #14. The live figures come from `https://cerulean.news/feed-audit.json`, generated 2026-09-28T16:01:44Z (run 36447952877). The code is `main` at `14279ae`, where `npm test` passes 276 of 276.

## Status after the same day's fixes

- Finding 1: fixed in 1324b5e (#15).
- Finding 2: partly addressed by Oliver's 17 rejections as references. The enlarged library is still unmeasured.
- Finding 3: the score now appears whenever Jev has odds (c5f8119).
- Finding 5: fixed in 5714f5e.
- Finding 4 (cadence): awaiting Oliver's decision. See `WORKLOG.md`.

## Summary

Jev works as designed in one important way and against its intended policy in another.

- **Mechanics are sound.** Every failure path keeps the existing decision. Deterministic rules and hand-vetted clips stay authoritative. The enforcement boundary holds, and no internal field leaks into the public feed.
- **Oliver's 2026-09-24 inclusion rules do not reach Jev's decision.** The deployed profile ignores Jev's answer to the `include` question and uses the highest of three scope answers instead. The new exclusions were written only into `include` and into Gemini's prompt. As a result, all four stories Oliver rejected in the Label Desk are still published, along with every other story the 2026-09-24 report said the rule would drop. This is verified in the code, the tests, and the live feed.
- **The 0-100 sentiment score adds little beyond the label, and it will stay sparse.** Jev's label odds are nearly all-or-nothing, so each score sits at its label's position. The score appears only beside a Jev label with confidence of at least 0.7. That gate passed about a third of archive answers on 2026-09-21. It also skews heavily positive.
- **The publish schedule runs about five times a day, not 48.** The workflow's cron asks for every 30 minutes, but the last 12 successful runs came 2.5 to 8.3 hours apart. Every Jev throughput estimate in the repository assumes the 30-minute cadence.

## How an article reaches the feed

Each run of `src/index.js` performs these steps in order.

1. **Collect** (`src/fetching.js`, `src/sources.js`). The run fetches 97 default sources: outlet RSS and Atom feeds, listing pages, and Google News searches. The media tracker seed is also read as a source. That seed combines the tracker workbook rows and the decrypted clip-email rows.
2. **Match** (`src/enrich.js`, `src/matching.js`). A story becomes a candidate only when it matches a brand or topic term. Brand terms scan feed text and, selectively, article bodies. Topic terms scan feed text only. A story with no term match never reaches Jev or Gemini. Seed rows bypass matching. Rows marked `referenceOnly` (the 967 national clip-email rows) are skipped as items and serve only as Jev references.
3. **Merge and dedupe** (`src/archive.js`). New items merge with the archive from the live audit. Earlier verdicts, summaries, sentiment, `firstSeenAt`, and `jevBaseline` carry forward. Brand and curated items are kept indefinitely. Other items are kept for 92 days.
4. **Deterministic rules** (`applyDeterministicRelevance` in `src/relevance.js`). Code rules reject job boards, publisher placeholders, crash briefs, isolated out-of-region outbreaks, and broad national items without a payer, policy, or regional word. That last rule rejected 998 archived items on 2026-09-24. Code rules also force-include owned posts, BCBSA coverage, and every tracker clip.
5. **Gemini** (`src/summaries.js`). Items without a summary, or never judged, go to Gemini in batches of 10, with up to 10 requests per run. Gemini writes `summary`, `reason`, `relevant`, and, for eligible brand coverage, `sentiment` and `sentimentReason`. Each item is judged once. A rejected item is never sent again unless someone dispatches `rejudge_all`.
6. **Jev** (`src/jev-relevance.js`). Jev runs last, so its applied decisions overwrite Gemini's. This step is described in the next section.
7. **Publish** (`src/outputs.js`, `src/story-groups.js`). The run writes the RSS, the public JSON Feed, and the audit JSON. Grouping collapses different outlets' reports of one event for display only.

## How Jev is asked and how its answer is applied

### The request

`buildJevRequest` sends the title (up to 300 characters) and an excerpt (up to 1,200). The excerpt is the stored snippet, else the feed description, else Gemini's summary. The request adds the outlet, matched terms, category, source type, the sentiment-eligibility flag, and a curated flag. Full article text is never sent. The model is pinned to `jev-1.13.0` in `src/rubrics/relevance-v2.json`, and calls go to `https://api.typesafe.ai/v1/systemone`.

The workflow sets `JEV_ALIGNMENT_PROFILE=src/rubrics/editorial-alignment-v1.json`. `addEditorialAlignment` in `src/jev-alignment.js` then shapes each request as follows:

| Question | Type | Guidance attached | Used for |
| --- | --- | --- | --- |
| `include` | yes/no probability | v2 wording, `INCLUSION_PRIORITIES`, `INCLUSION_RULES`, 8 reference examples | **Nothing** (see finding 1) |
| `local_angle` | yes/no probability | v2 wording | Logging only |
| `relevance` | 0-5 score | v2 wording | Logging only |
| `scope_brand` | yes/no probability | Fixed text in `jev-alignment.js`, 8 reference examples | Inclusion (maximum of the three scopes) |
| `scope_regional` | yes/no probability | Same | Inclusion |
| `scope_policy` | yes/no probability | Same | Inclusion |
| `sentiment` (eligible brand coverage only) | five-label choice | `sentiment-v2.json`, the five tracker rules, contrastive label definitions, matching storyline notes, up to 16 human-labeled examples | Sentiment label and 0-100 score |

### Reference examples

`src/jev-examples.js` turns every seed row into an inclusion example marked `include: true`. Rows with a workbook sentiment label also become sentiment examples. Twelve URLs with conflicting labels and 85 reserved evaluation IDs are excluded. For each article, retrieval ranks examples by word overlap with the title and excerpt. It removes the article itself and known same-story examples, keeps at least one example per sentiment label, and takes the top 8 for inclusion and 16 for sentiment. Jev does not support customer fine-tuning, so this reference library is the only form of "training."

### The decision

- **Inclusion.** `alignedInclusionAnswer` takes the maximum of the three scope probabilities. A value of at least 0.7 includes the article. A value of 0.3 or less excludes it. Anything between keeps the current decision.
- **Sentiment.** A label is applied only when Jev's confidence is at least 0.7. The label odds must be valid probabilities that sum to 1, and the chosen label must have the highest probability.
- **Score.** `sentimentScoreFromProbabilities` maps the odds to 50 plus 25 times the expected position on a -2 to +2 scale.

### Where it applies

- **Mode.** The `JEV_RELEVANCE` repository variable is `enforce`.
- **Inclusion boundary.** Inclusion changes only for articles first seen on or after `JEV_ENFORCE_AFTER` (2026-09-21T18:13:31Z). Tracker clips are never changed.
- **Sentiment.** Since `9d88b09`, sentiment applies to eligible coverage on both sides of the boundary.
- **Baseline.** Each touched article keeps its pre-Jev verdict and sentiment in `jevBaseline`, in the audit only.

### Budget and cache

- **Cap.** Each run makes at most 25 evaluations (`JEV_RELEVANCE_MAX_ITEMS`), with 2 in flight at once.
- **Priority.** New post-boundary articles are evaluated first. Next come scope-only refreshes, then sentiment-only backfills for eligible coverage without stored odds.
- **Cache.** Successful answers are cached in `crawlState.jevCache`. The key is a SHA-256 hash of the full request, including the retrieved reference examples.
- **Invalidation.** Any change to the rubric wording, the seed, an article's excerpt, or a summary used as the excerpt changes the key. The old entry is then pruned and the article waits for a fresh call.

## Live state on 2026-09-28

| Measure | Value |
| --- | --- |
| Audit items / relevant / rejected | 5,014 / 2,255 / 2,759 |
| Jev mode, status | enforce, complete |
| Inclusion references / sentiment references | 1,567 / 68 |
| This run: requested, succeeded, failed, cached | 25, 25, 0, 383 |
| New-cohort articles still pending | 11 |
| Sentiment backfills this run / still pending | 0 / 113 |
| Post-boundary candidates (enforcement-eligible) | 310 |
| Articles carrying `jevBaseline` | 335 |
| Inclusion flips vs. baseline | 92: 60 added, 32 removed |
| Sentiment-eligible brand coverage | 246, all labeled |
| ...with a Jev 0-100 score | 73 (58 positive, 4 neutral to positive, 0 neutral, 9 neutral to negative, 2 negative) |
| ...with a Jev label that changed Gemini's | 7 of 73 |
| ...on the current Gemini sentiment rubric (`2026-09-24`) | 50; 196 never stamped |

## Findings

Findings are ranked by effect on what readers see. Each is marked verified (checked against code, tests, or live data) or inferred.

### 1. The 2026-09-24 inclusion rules never reach Jev's decision (verified)

`classifyItemRelevance` replaces the `include` answer with `alignedInclusionAnswer`, which returns the maximum of the three scope answers whenever `scope_brand` exists (`src/jev-relevance.js:310`, `src/jev-alignment.js:64-72`). The test at `test/jev-alignment.test.js:61-63` asserts this: an `include` of 0.1 loses to a regional scope of 0.93.

Commits `40a5d1a`, `f0ab57a`, and `1bb169d` edited only the `include` question in `relevance-v2.json` and the shared Gemini rules. The three scope questions have not changed since `07be473` on 2026-09-21. `scope_policy` still says "Any US geography qualifies" and names "insurance premiums" as qualifying. It carries none of the single-state, vendor-promotion, or how-to exclusions.

The rewording did change the request, so the cache re-evaluated the new cohort as the 2026-09-24 report expected. The re-evaluation used the unchanged scope questions and reached the same result. These stories are published in the live feed, each with a Jev "Fits U.S. health coverage, insurance, or policy news" note at 89% to 97% confidence:

- Duke employee premiums (dukechronicle.com)
- "Review finds millionaires on Ohio's Medicaid roles" (two outlets)
- Missouri 2027 premium increases (missourinet.com)
- Two Colorado marketplace premium stories
- Florida attorney general's PBM suit
- A California law-firm appellate release
- St. Lawrence County (N.Y.) Medicare sessions
- An ElderLawAnswers Medicare Advantage denial how-to
- Cotiviti's payment-accuracy platform

The first four are the stories Oliver rejected in the Label Desk. Every item on the report's "drops" list is still live. The report's claim that "Gemini and Jev apply the same policy" (`docs/2026-09-24-issue-8-followups.md`, line 45) is therefore wrong for the deployed profile.

Other Jev additions look like the reason Jev was deployed: the 760,000 ACA enrollee removals, CMS broker rules, Medicaid work-requirement suits, and Medicare lab cuts. The problem is confined to the missing exclusions.

### 2. The reference library is 15 times the size that was validated, and every example is positive (verified count, inferred effect)

The profile was validated on 2026-09-21 with 101 inclusion and 50 sentiment references. The live run loads 1,567 and 68. The profile's `unknownIdPolicy` admits every new seed row, including the 967 national clip-email rows, and every row is an inclusion example. With no rejection examples, retrieval shows Jev only stories that were kept. For a national article, the nearest references are national stories the team included.

Additions rose from 34 on 2026-09-23 to 60 on 2026-09-28, and removals fell from 39 to 32. That fits a shift toward inclusion after the seed grew, but those counts also depend on which articles arrived. No run has measured the enlarged library. The 2026-09-24 plan for a held-out digest measurement would.

### 3. The 0-100 score mostly restates the label and will stay sparse (verified numbers, inferred cause)

The live scores cluster at their label's fixed point:

| Label | Scores |
| --- | --- |
| Positive | 88 to 100 (median 100) |
| Neutral to positive | 67 to 75 |
| Neutral to negative | 21 to 30 |
| Negative | 1 |

Jev's odds are nearly all-or-nothing, so the extra granularity is a few points around each label.

Coverage is limited by the confidence gate rather than by the backfill.

- **Archive rate.** On the 2026-09-21 full-archive run, 75 of 221 sentiment answers (34%) cleared 0.7.
- **Live rate.** 246 items are eligible and 113 still lack odds, so about 133 have odds. Only 73 of those carry a score. The other 60 most likely fell below the threshold. The audit does not record confidence per item, so this is an inference.
- **Skew.** 58 of the 73 scored items are positive. No neutral item has a score.

Issue #14's expectation of a score on "most of about 239 scored brand items" will not be met by finishing the backfill.

### 4. The schedule delivers about five runs a day (verified)

The cron is `17,47 * * * *`. The 12 most recent runs, all successful, started 2.5 to 8.3 hours apart (for example, 12:07Z, 17:00Z, 20:10Z, and 23:05Z on 2026-09-27). GitHub delays or drops scheduled runs under load.

At 25 Jev calls a run, real capacity is roughly 125 evaluations a day, not the 1,200 cited in #8. The 113-item sentiment backfill gets only the cap left over after new articles. The 2026-09-24 estimate of "about five hours" to re-evaluate the new cohort was off by days.

### 5. Disagreement counts compare Jev with its own earlier output (verified)

`inclusionDisagreements` and `sentimentDisagreements` compare Jev's answer with the item's current `relevant` and `sentiment` values. After Jev applies a decision, those fields hold Jev's own value, so later runs count agreement with itself. The per-run inclusion figure measures only fresh disagreements. The sentiment figure (34 today) mostly counts unconfident Jev labels that were never applied. Comparing against `jevBaseline` would give the intended measure.

### 6. Unrelated edits quietly re-queue Jev work (verified mechanism)

The cache key hashes the full request. These edits each change requests and send articles back into the 25-call queue:

- A seed update, which changes the retrieved references.
- An excerpt rebuild.
- A Gemini re-score that rewrites `summary` for an item whose excerpt falls back to the summary, or whose storyline match reads it.

While an article waits, it keeps its last applied decision. Nothing reverts.

### 7. The Gemini re-score in #14 is mostly overwritten (verified mechanism)

Jev runs after Gemini in the same run and reapplies its cached, confident labels. A Gemini re-score therefore changes the published label only where Jev is unconfident or has no answer yet. The re-score also rewrites summaries, so it can re-queue Jev work (finding 6). It still matters for the roughly 170 eligible items without a confident Jev label.

### 8. Jev-scored items show no rationale (verified)

Applying a Jev label clears `sentimentReason`, because Jev returns no written rationale. All 73 scored items show "Sentiment: NN · label" with no explanation. Gemini-scored items keep their one-line reason.

### 9. Smaller notes

- The README still cites "101 verified human selections, including 50 unambiguous sentiment labels." The live counts are 1,567 and 68.
- The national inclusion standard was narrowed at 14:29Z on 2026-09-24 (`f0ab57a`) and widened 13 minutes later (`1bb169d`). The follow-up report still states both. `INCLUSION_PRIORITIES` now says national news qualifies when "its outcome reaches a Vermont health insurer," while the v2 `include` wording lists broad national categories. Only Gemini acts on either.
- Every Jev request still sends the `include`, `local_angle`, and `relevance` questions. Only logging uses them.

## History of the work

| Date | Session outcome |
| --- | --- |
| 2026-06-12 to 08-26 | The feed grew to 97 sources with Gemini summaries, deterministic relevance rules, crawl politeness, and hardening passes. |
| 2026-08-27 | Five-point sentiment scoring from the team's media tracker. The 186-row tracker seed became a must-include source. Trends page and coverage audit added. |
| 2026-09-03 | History scrub and the private-repo move for legal exposure. Rebrand to cerulean.news. bluecrossvt.org crawling stopped. |
| 2026-09-05 to 09-18 | Actions billing block. A Cloudflare Worker fallback ran, Google News was relayed, and Actions returned. The Worker is parked. |
| 2026-09-21 | Jev merged off (PR #7). Direct API, sentiment question, and shadow mode added. Full-archive evaluation: Jev did not beat the baseline. Human-reference alignment followed: 13/16 sentiment vs. 12/16, 34/34 retention. Oliver approved live selection and confident sentiment for new articles. Enforcement started at 18:13:31Z. |
| 2026-09-23 | Repo made public and schedule set to 30 minutes. Story grouping added. Jev inclusion notes and removal wording changed. |
| 2026-09-24 | Label Desk: 47 labels, and on 43 decided items the feed agreed 35 times vs. 34 for the baseline. Out-of-state rule (finding 1). BCBSA include. Clip-email seed added 1,560 rows. Section filter, excerpt repair, SEO pass. Re-score resume fix (#11). Clip grouping (#12). 0-100 score (`9d88b09`). |

## Decisions and open items

The work log's open items remain accurate, with three changes:

- The planned re-score of Oliver's 43 labels will not show the rule working until finding 1 is fixed.
- Any plan sized in runs per day should assume about five runs.
- #14's success condition for the 0-100 score needs restating.

Decisions for Oliver, in suggested order:

1. **How to make Jev honor the exclusions.** The simplest fix copies the out-of-region, vendor-promotion, and how-to exclusions into `scope_policy` and `scope_regional`, keeping the maximum rule that won development testing. Alternatives are to require `include` as well (more conservative, fewer additions) or to decide on `include` alone (drops the scope design). Any change re-evaluates about 310 post-boundary articles through the 25-call cap.
2. **Whether to add rejection examples.** Oliver's 17 Label Desk exclusions are the only human negatives. Adding them as `include: false` references would let retrieval show Jev what to leave out.
3. **What the 0-100 score should mean.** Options: accept a score only on confident labels, lower the gate for the score alone, or publish the score whenever odds exist.
4. **Whether to raise `JEV_RELEVANCE_MAX_ITEMS`** to fit the real cadence. This is Oliver's setting, and TypeSafe billing is still unverified (#8).
5. **Whether to re-judge the pre-boundary archive with Jev.** This was deferred on 2026-09-24. It should wait for decisions 1 and 2.
