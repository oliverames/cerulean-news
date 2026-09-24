# Issue #8 follow-ups, 2026-09-24

This report covers the seven open items in [#8](https://github.com/oliverames/cerulean-news/issues/8). It uses the live audit at `https://cerulean.news/feed-audit.json`, generated 2026-09-24T12:20:10Z, which holds 4,602 articles. Private tracker labels and evaluation artifacts were not available in this session.

## Status by item

| Item | Status | Needs |
| --- | --- | --- |
| Prospective human inclusion decisions, including exclusions | 47 labeled; out-of-state rule added | Live re-check after deploy |
| Neutral and negative sentiment evidence | Review page built | Oliver's labels |
| Excerpts that omit the Blue Cross VT passage | Fixed for new articles, with a one-time repair for existing ones | Oliver runs the repair once |
| Review of historical additions and removals | Deferred by Oliver | A local session on the Mac |
| Two workbook records outside the corpus | Resolved: dropped | Nothing |
| Keyword-miss rescue | Analysis done | Oliver's decision |
| TypeSafe usage and billing | 305 requests tallied from logs | Oliver's console check |

## Label Desk

The [Cerulean Label Desk](https://claude.ai/artifact/EQH9mfaJk5FcPuGXTmP9wE) is a private page for blinded labeling. It shows no model or pipeline verdicts. Labels save to the page's `labels` store as Oliver clicks.

- **Inclusion set:** all 207 articles first seen after the 2026-09-21T18:13:31Z enforcement boundary, in a fixed random order. It contains 47 articles Jev added, 13 it removed, and 147 where Jev agreed or did not act. Exclusions are as useful as inclusions here, because the earlier human data was positive-only.
- **Sentiment set:** all 35 brand-eligible articles that did not come from the human tracker. The current pipeline scores 19 of them below positive, so the set adds neutral and negative coverage.
- **Answer key:** `docs/review/2026-09-24-label-desk-key.json` maps each item to the current decision and the pre-Jev baseline. Score against it only after labeling.

Report both direct Jev agreement and baseline agreement, split by Jev-changed and unchanged items. Items with a generated summary (33 inclusion, 13 sentiment) or no excerpt (19) should be reported separately, because the reviewer and the model saw less source text.

## Label results and the out-of-state rule

Oliver labeled 47 inclusion items on 2026-09-24: 26 include, 17 exclude, and 4 unsure. On the 43 decided items, the current feed agreed with him on 35 (81%) and the pre-Jev baseline on 34 (79%). A one-item gap on 43 items is not a measurable difference.

Jev had added 10 of the labeled items, and Oliver rejected 4. All 4 were single-state stories from outside New England: Ohio Medicaid (two outlets), Missouri marketplace premiums, and Duke's employee plan. Jev had removed 1 labeled item, which Oliver would keep. Oliver would also include 3 items that neither pipeline selected.

Oliver judged the original tracker lists the best reference data and stopped labeling there. The tracker is richer, but it records only inclusions. The labels supplied the missing exclusion signal, and that signal pointed at one rule.

The inclusion rules now exclude another state's own Medicaid administration, marketplace premiums, rate filings, lawsuits, or single-employer plan outside New England, even when the story names national companies. The exception keeps a Blue Cross or Blue Shield plan, the Blue Cross Blue Shield Association, and federal or multi-state policy. That exception preserves all seven out-of-region tracker picks: five Michigan Blue Cross business stories, a Washington Post national coverage story, and a UVM story with a New York angle.

On review, Oliver set the standard for national stories: include a general health insurance or health industry trend only when its outcome would matter to BCBSVT as a Vermont health insurer. He also asked that BCBSA news count as Blue Cross coverage, because BCBSVT is a member. The rules now say both, and the old instruction not to demand a Vermont consequence is gone. Against the 47 Jev additions, that standard:

- **Keeps** federal ACA enrollment removals, Medicaid work-requirement rules and the lawsuits over them, Medicare Advantage policy (BCBSVT sells Vermont Blue Advantage), federal drug pricing, large payers contesting Medicare rules, NCQA plan ratings, and BCBSA statements.
- **Drops** the Florida attorney general's PBM suit, the Colorado and Missouri premium stories, both Ohio Medicaid copies, the Duke plan, a California law-firm appellate release, a St. Lawrence County Medicare session, a Medicare Advantage denial how-to, and a Cotiviti product announcement.
- **Leaves to the model** the medical-debt surveys and a reintroduced hospital cybersecurity bill, which sit near the line.

It should also recover two wrongly rejected BCBSA stories: the association's analysis of AI billing tools, and Fierce Healthcare's report that those tools cost Blue plans $942 million. The association's CFO appointment would qualify too. Those are older than the enforcement boundary, so Jev will not revisit them. A separate archive-wide decision would be needed.

The rule sits in the shared `INCLUSION_RULES` and `INCLUSION_PRIORITIES` and in the `relevance-v2` question and criteria, so Gemini and Jev apply the same policy. Jev's cache key hashes the full request, so new-cohort articles are re-evaluated automatically at up to 25 per run. That is roughly 250 extra requests over about five hours. Curated tracker clips stay protected.

Validation happens live, because this session has no TypeSafe key. After the cohort is re-evaluated, score the 43 labels again against the new decisions, and check the keep and drop lists above.

## Excerpts

Of 219 brand-eligible articles, 109 give Jev an excerpt with no Blue Cross mention. Most are rate-review and hospital-budget stories. Their stored snippets start at an earlier topic term, such as the Green Mountain Care Board, because `buildSnippet` centered on the earliest mention or topic match. PR #9 centers on the brand mention whenever the fetched body names the brand.

Cached snippets are reused, so existing articles keep the old excerpt. Oliver approved a one-time repair. The publish workflow's manual dispatch now has a `rebuild_brand_excerpts` option. It refetches free, relevant brand articles whose excerpt lacks a brand mention, through the same fetcher, throttle, and page-identity check as enrichment. It replaces a snippet only when the rebuilt one names the brand, and updates the article cache so later runs keep it.

Against the 2026-09-24 audit, the repair has 112 candidates. Thirteen are on beckerspayer.com, which refuses crawlers with a 403 that is not retried, so those cost one refused request each and stay unchanged. Run it once with `rebuild_brand_excerpts` and `rescore_sentiment` both checked, so sentiment is rescored from the new excerpts. Rerun the affected comparisons after that.

## Keyword-miss rescue

The question is whether articles with no keyword hit should be sent to Jev, since today they never become candidates.

- Of 186 human-selected tracker clips, 114 match a brand term and 59 a topic term in their title or excerpt. Only 13 match nothing. This check sees less text than the crawler, which also scans article bodies, so 13 is an upper bound.
- The 13 fall into three groups. Calendars and briefs make up four, and that recall gap is already an open product decision. National roundups from Becker's Payer Issues make up three, where Blue Cross VT sits deep in a list. The other six are a radio show, a university magazine, a town budget story, and three Vermont news pieces where the insurer is a passing mention.
- The latest run saw 1,369 unique feed items and skipped article fetches for 996 of them because nothing matched. General rescue would make those Jev candidates, multiplying request volume, and would still miss calendars whose text never names the brand.

Recommendation: do not build general rescue. It would not recover the Becker's roundups either. `src/sources.js:727` records that beckerspayer.com answers 403 to any crawler, so only the Google News title and blurb are ever available, and neither names Blue Cross VT.

## TypeSafe usage and billing

TypeSafe's public documentation has no pricing, billing, or usage page. The API page covers only 429 and 529 retry handling. Actual billing therefore needs Oliver's console.

The publish logs record every Jev call. From the enforcement boundary through the 12:20 UTC run on 2026-09-24, 23 publish runs started:

- 19 ran feed generation and made 305 Jev requests, all successful. No live 429, 529, or timeout retries appear in any generation step.
- Two pushes deployed static changes without generating, and two scheduled runs failed at startup. None of the four called Jev.
- The first run, just after the boundary, was still in shadow mode and made 25 requests. The 18 enforce-mode runs made 280.

That averages about 110 requests a day. The ceiling has changed, though. #8 describes six scheduled runs a day, or 150 uncached evaluations. The workflow has run every 30 minutes since 2026-09-23, so the 25-per-run cap now allows up to 1,200 a day before push and manual runs. Actual use stays far lower, because most candidates are cached after their first evaluation.

To close this item, Oliver should compare the TypeSafe console's request or credit use for 2026-09-21 to 2026-09-24 against the 305 requests above, and confirm the account's balance, alerts, and recharge settings. If 1,200 a day is too high a ceiling, lower the `JEV_RELEVANCE_MAX_ITEMS` repository variable.

## Deferred and resolved items

- **Historical additions and removals.** The 451 proposed additions and 234 removals live in the ignored `artifacts/jev-evaluation/` directory on Oliver's Mac. Oliver deferred this until a local session can add a blinded sample to the Label Desk.
- **Two workbook records.** One was a neutral-scored podcast whose URL existed only as an Excel hyperlink. The other was a positive-scored article with no URL. On 2026-09-24 Oliver chose to drop both. The 101-selection, 50-sentiment reference library is unchanged.
