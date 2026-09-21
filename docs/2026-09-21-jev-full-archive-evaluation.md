# Jev full-archive evaluation, September 21, 2026

Author: Oliver Ames

## Decision

Keep Jev in live shadow mode for both article selection and eligible BCBSVT sentiment. The complete retained-archive comparison does not support replacing the current decisions. Jev did not improve agreement with the available human sentiment labels, and its current selection thresholds would remove 326 published articles while recovering one rejected article. Inclusion disagreements require policy review rather than assuming either model is correct.

The corrected v2 implementation and reproducible offline evaluator are ready for continued comparison. No historical verdicts from this evaluation were applied to the live reader. Gemini continues to provide summaries and baseline judgments.

## Scope and method

The fixed public audit snapshot was generated on September 21, 2026, at 16:39:37 UTC. It contains 4,490 retained articles, including older curated clips. This is the full available archive, not every article ever encountered: keyword misses, expired articles, and previously discarded content cannot be recovered from this snapshot.

| Archive accounting | Articles |
| --- | ---: |
| All retained articles | 4,490 |
| Evaluated by Jev | 3,179 |
| Existing deterministic exclusions | 1,270 |
| Existing deterministic inclusions | 39 |
| Curated items without eligible sentiment | 2 |
| Eligible brand sentiment evaluations | 221 |
| Curated inclusions protected within model candidates | 184 |

The 186 tracker articles are human selections, not model-generated inclusion labels. All retain protected inclusion.

Human editorial input also shaped the existing rules: the June 12 work log cites a colleague's News Export, and the June 16 entry records alignment with her 18 Boolean queries. Existing matching and deterministic rules remain in force; their historical provenance is distinct from a fresh labeled evaluation set.

No additional article-level human inclusion/exclusion dataset was recovered from repository data, work logs, relevant history, or archive metadata. The original News Export was not preserved in those searched paths. Untagged historical decisions lack author metadata, so the comparison calls them current pipeline judgments without claiming that every decision was exclusively machine-made.

Every candidate received inclusion, local-angle, and relevance-score questions. Every eligible brand article also received sentiment, including three currently rejected articles. Existing deterministic editorial rules and curated inclusion remain authoritative.

The run used `jev-1.13.0`, `relevance-v2`, and `sentiment-v2`, at concurrency four. The initial pass produced 3,177 usable results and two malformed sentiment answers. A resume reused those successes and successfully retried both failures. Final coverage is 3,179 of 3,179 candidates and 221 of 221 sentiment requests, with no remaining failures. A further credential-free resume reused all 3,179 checkpoints and made zero API calls.

### Corrected policy and inputs

The earlier v1 wording omitted independent New England coverage and unnecessarily required qualifying national stories to bear on Vermont coverage. V2 uses the same priority and relevance strings as Gemini: brand coverage, Vermont health care broadly, New England health care, and national insurance/payer, health-policy, or drug-coverage reporting. The change preserves small local provider stories and ordinary brand sponsorship visibility. A Vermont publisher alone does not make syndicated subject matter local.

Jev now receives the resolved outlet, matched terms, trusted brand eligibility, curated provenance, and excerpt provenance. Its excerpt allowance matches the existing 1,200-character budget, with a 300-character title limit. Current verdicts, sentiment labels, model rationales, and human evaluation labels are excluded from requests. Full pages and feed bodies remain excluded.

The earlier context loss was mostly missing metadata. In this snapshot, 108 of 221 eligible brand articles do not name the brand in their saved title/excerpt. Only two candidate excerpts exceed 600 characters, and neither is sentiment-eligible. Increasing the limit therefore does not explain sentiment performance here.

Generated summaries supply fallback text for 747 of 3,179 requests, including 31 sentiment requests. These inputs already contain Gemini's interpretation. Their results are reported separately and cannot establish independence from Gemini.

## Sentiment against human scores

The private tracker export has 99 unique labeled articles. All labels were verified against the source workbook and joined to the archive by exact URL. The workbook contains conflicting judgments for 12 URLs. Excluding explicit prompt examples, storyline-source articles, and conflicts leaves 78 labeled rows, of which 77 qualify for sentiment. A stricter split excludes all matching storyline articles and contains 75 eligible rows.

These are withheld from explicit examples and storyline sources, but not pristine unseen data. Earlier policy development and calibration used the same tracker. Human reviewers also had more article context than the saved excerpts used here. No rubric was tuned after inspecting these results.

All principal comparisons below use the same 77 articles. “Within one” allows an adjacent label on the five-point scale. “Average label recall” gives each represented label equal weight, reducing the effect of the positive-heavy sample.

| Measure | Jev | Current baseline | Current confidence-gated Jev fallback |
| --- | ---: | ---: | ---: |
| Exact agreement | 48/77, 62.3% | 51/77, 66.2% | 50/77, 64.9% |
| Within one label | 64/77, 83.1% | 66/77, 85.7% | 65/77, 84.4% |
| Average label recall | 40.0% | 47.6% | 42.6% |
| Mean absolute distance in labels | 0.623 | 0.519 | 0.571 |
| Mean signed bias, positive means more favorable | -0.519 | -0.260 | -0.286 |

Both models matched 44 labels. Jev alone matched four, and the current baseline alone matched seven. This small difference does not establish a statistically reliable ranking. It does establish that this run supplies no improvement evidence for the proposed replacement.

Fifty-four of 77 human labels are positive. Always predicting positive would achieve 70.1% exact agreement but only 20.0% average label recall. Overall agreement alone is therefore inadequate for approving a five-label sentiment system.

| Human label | Articles | Jev exact | Current exact |
| --- | ---: | ---: | ---: |
| Positive | 54 | 42 | 43 |
| Neutral to positive | 9 | 2 | 3 |
| Neutral | 8 | 2 | 2 |
| Neutral to negative | 2 | 1 | 1 |
| Negative | 4 | 1 | 2 |

Only 100 of 221 archive sentiment predictions reach the current 0.70 confidence threshold. In the clean comparison, 42 of 77 reach it, with 31 exact matches. Applying those predictions and retaining existing scores for the rest produces 50 of 77 exact matches, below the current 51. Confidence alone does not solve the gap.

The stricter 75-article comparison gives Jev 48/75 exact and the current baseline 51/75. Among 64 clean comparison articles with source excerpts, Jev matches 39 and the current baseline 43. Among the 13 generated-summary cases, Jev matches nine and the current baseline eight. The small fallback cohort cannot support a separate deployment decision.

## Article selection

At the existing 0.70 inclusion and 0.30 exclusion thresholds, 2,995 non-curated candidates divide into 400 confident inclusions, 1,286 confident exclusions, and 1,309 uncertain results. The latter retain the current verdict. This means 43.7% still depend on the existing decision system.

Enforcement would remove 326 currently included articles and add one. Thirty-nine changed decisions use generated-summary input. The one recovered story concerns [CVPH funding for a psychiatric emergency program](https://www.mynbc5.com/article/cvph-funding-comprehensive-psychiatric-emergency-program/73394864), a Vermont-serving regional provider. All 184 curated candidates retain inclusion; none received a confident model exclusion.

### Human-selected inclusion controls

After Oliver highlighted the historical human decisions, an additional inclusion-only pass tested all 184 human-selected tracker candidates with the `curatedInclusion` marker hidden. The other two tracker articles remain outside the model-candidate set under existing deterministic rules. Normal publisher, matched-term, and brand-eligibility evidence remained available. No human selection label, baseline verdict, sentiment label, or sentiment question entered these requests.

All 184 requests succeeded. Jev confidently included 142, confidently excluded none, and left 42 in the uncertainty band. This positive-only control set supports retention of established tracker coverage, but cannot measure false inclusions or general selection accuracy. The 42 uncertain answers would still need a fallback. Live protection of all 186 human-selected articles was unchanged.

An independent agent review sampled 40 accepted and 40 rejected non-curated candidates deterministically. Reviewers saw titles, excerpts, and publisher context, but neither model's verdict or rationale. They proposed 46 inclusions, 26 exclusions, and eight unresolved cases. Nineteen inputs used generated summaries. These are provisional policy assessments, not human ground truth or a prevalence-weighted accuracy estimate.

The review exposes weaknesses in both systems, including missed national coverage-policy stories. A second review found that some provisional rationales broadened the national scope or imposed blanket promotional exclusions absent from the established policy. Consequently, the blinded sample is retained as a review queue, not reported as an accuracy score.

A separate, unblinded agent review of a deterministic sample assessed 40 of the 326 proposed removals: 35 source-excerpt cases and five generated-summary cases. All proposed removals were topic articles; none were brand articles. The review found 17 apparent false removals under the existing policy, 19 supported removals, and four unresolved cases. These are agent assessments of bounded evidence, not editorial sign-off or a full-archive error-rate estimate.

Two clear examples independently checked against the current rules are:

- [Medicare Advantage patients losing Cooley Dickinson primary-care coverage](https://recorder.com/2026/08/14/bcbsma-cooley-dickinson-coverage-change/), assigned 0.30 inclusion. This concerns New England health care and insurance coverage.
- [Mass General and Dana-Farber hospital executive compensation](https://www.statnews.com/2026/08/18/massachusetts-hospital-ceo-compensation-2024/), assigned 0.26 inclusion. This concerns New England hospital operations and costs.

The saved Afterglow Festival article also explicitly describes a Vermont event raising mental-health and suicide-prevention awareness, yet Jev assigns 0.14 inclusion. These findings support withholding enforcement independently of disagreements with Gemini. Detailed assessments remain in private local artifacts.

## Reproduction and evidence

Run `scripts/evaluate-jev.js` with a fixed audit snapshot, a private URL-keyed label file, and a private output directory. The README documents arguments and runtime credential injection. Request checkpoints include only typed model results. The manifest fingerprints the snapshot, labels, rubric, and ordered complete requests. It refuses a mixed run if any input changes. Failed calls retry while successes remain cached.

Private files are stored under the Git-ignored `artifacts/jev-evaluation/2026-09-21-v2/` directory: the snapshot, verified human-label split, per-request results, full JSON/CSV comparison, blinded inclusion review, targeted removal review, masked human-inclusion controls and their reproduction script, sampling map, and initial/retry/cache-only logs. Human labels and raw tracker records are not added to Git or the live feed.

All 234 repository tests pass. New tests verify shared policy, label exclusion, request deduplication, per-article uncertainty fallback, checkpoint reuse, failed-call retry, unchanged-input enforcement, and matched sentiment denominators. Commit `d94ec5a` was pushed to `main`. [Publishing run 35630033814](https://github.com/oliverames/cerulean-news/actions/runs/35630033814) passed and deployed successfully. The live audit generated at 17:08:36 UTC contains 25 successful `relevance-v2` / `jev-1.13.0` shadow evaluations, zero failures, and 3,156 pending candidates. The current archive has 4,492 articles after two new arrivals; the reader has 1,814 articles and exposes neither the internal cache nor human evaluation-label fields.

The first production v2 batch contains no sentiment-eligible articles, so its live cache has zero sentiment answers. The separate full-archive API run verifies all 221 eligible sentiment requests, and integration tests verify production eligibility and ordering. Historical offline results were not imported into the published cache. Scheduled evaluation continues under the existing 25-new-request cap; Jev has not changed reader inclusion or sentiment decisions.

## Remaining work

[Issue #8](https://github.com/oliverames/cerulean-news/issues/8) tracks the deployment decision. Before enforcement, use a fresh editorially labeled inclusion set, review the false-removal boundary, and calibrate thresholds on separate development examples. For sentiment, improve source context or the decision rubric using development data, then test on newly labeled clips. Reserve the current comparison as historical evidence rather than repeatedly tuning against it.

Current thresholds remain provisional. Keep both evaluation dimensions active in shadow and preserve the current publishing decision path until a new, independently checked comparison demonstrates an acceptable benefit.
