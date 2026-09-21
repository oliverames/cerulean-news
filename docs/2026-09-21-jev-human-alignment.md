# Human alignment for future Jev evaluations

September 21, 2026  
Author: Oliver Ames

## Outcome

The publisher now has persistent human reference guidance for incoming articles. Jev evaluates editorial scope through separate brand, regional health-care, and national payer/policy questions. Eligible brand coverage receives paired human sentiment examples. Word overlap retrieves relevant examples; Jev makes the semantic judgment.

The selected configuration improves the small reserved comparison. Oliver subsequently approved live selection and confident sentiment for new articles, after the distinction between selection and sentiment evidence was explained. Confidence-gated sentiment still equals the current baseline, negative labels are scarce, and human rejection examples are absent. This is an approved bounded rollout, not a claim of definitive superiority.

Jev does not support customer-specific fine-tuning. Its supported adaptation uses reference material, instructions, and criteria supplied with each request. Separate questions are evaluated independently, so references accompany each relevant question. See TypeSafe's [model customization documentation](https://docs.typesafe.ai/models#customizing-jev), [state guidance](https://docs.typesafe.ai/concepts/state), and [System One design guidance](https://docs.typesafe.ai/concepts/how-to-build-with-system-one).

## Human evidence and separation

The corpus contains 186 human-selected tracker articles and 99 original human sentiment labels verified against the workbook. Twelve URLs have conflicting judgments. These labels remain quarantined. Existing pipeline decisions and agent reviews are never presented as human training labels.

A fixed split groups duplicate coverage and related events before looking at candidate outcomes:

| Purpose | Articles | Unambiguous sentiment labels |
| --- | ---: | ---: |
| Training references | 101 | 50 |
| Development | 34 | 16 |
| Reserved validation | 34 | 16 |
| Conflict and related-story quarantine | 17 | 5 clean labels withheld alongside conflicts |

The 50 training sentiment examples comprise 34 positive, six neutral-to-positive, five neutral, one neutral-to-negative, and four negative judgments. The previous ten worked examples and matching storyline cases remain in training or quarantine. Target articles and known related-story groups cannot appear in their own references.

The runtime reads the existing private tracker seed. Git stores settings and identity hashes, without article titles, URLs, or raw human scores in the profile. Future articles automatically receive the reference guidance. Additional human feedback becomes available when the private seed is updated. Jev predictions do not automatically become training labels.

Historical reviewers often had more context than the archive retains. Some saved excerpts contain only a headline and tracker topic, and some requests fall back to generated summaries. This is a retrospective evaluation using an archive involved in earlier development, not a pristine prospective study.

## Development and reserved results

Five bounded development configurations tested paired examples, independent scope questions, 16 versus 32 sentiment examples, and revised attribution wording. The selected profile uses eight inclusion examples per scope question, up to 16 sentiment examples, and explicit distinctions between the five sentiment labels. The larger example set did not improve development agreement. The alternative attribution wording reduced agreement and was not selected.

| Development configuration | Human sentiment agreement | Agent-reviewed selection agreement |
| --- | ---: | ---: |
| References with original inclusion question | 8/16 | 29/40 |
| Independent scope questions without expanded references | 8/16 | 39/40 |
| Independent questions and 16 sentiment examples, selected | 9/16 | 39/40 |
| Independent questions and 32 sentiment examples | 9/16 | 39/40 |
| Alternative brand-attribution wording, sentiment-only test | 8/16 | Not retested |
| Current pipeline | 9/16 | 25/40 |
| Keyword-only selection | Not applicable | 29/40 |

The configuration was frozen before the reserved validation run. All 55 calls succeeded: 34 human-selected articles and 21 separately reviewed policy cases. Expected labels were joined after requests. The curated-selection flag was hidden without changing the article's normal brand eligibility.

| Reserved validation measure | Aligned Jev | Current pipeline | Keyword-only |
| --- | ---: | ---: | ---: |
| Human-selected articles retained | 34/34 | 34/34 | Not the primary comparison |
| Human sentiment exact agreement | 13/16, 81.25% | 12/16, 75% | Not applicable |
| Human sentiment within one label | 15/16 | 14/16 | Not applicable |
| Average sentiment label recall | 58.2% | 56.4% | Not applicable |
| Mean sentiment label distance | 0.313 | 0.438 | Not applicable |
| Agent-reviewed selection agreement | 20/21 | 15/21 | 13/21 |

Equal weighting of related-story groups gives validation sentiment 80.0% versus 73.3% for the baseline across 15 groups. Development gives 50.0% versus 53.8% across 13 groups. The article-level 95% Wilson interval for 13/16 is approximately 57.0% to 93.4%, before accounting for correlated coverage. A one-article improvement is encouraging but inconclusive.

The policy cases are provisional agent adjudications of the established criteria, not human ground truth. Ambiguous cases and eight disputed earlier adjudications were removed before splitting. The positive-only human inclusion set cannot measure false inclusion. On the reserved policy set, Jev makes no false inclusions and retains one incorrect baseline rejection through uncertainty.

Always predicting positive matches 11/16 validation scores but has only 20% average label recall. Jev's ten predictions at confidence at least 0.70 all match, but cover only favorable labels. Applying those ten and keeping the baseline for six uncertain scores produces 12/16 exact matches, equal to the current system. Development confidence-gated agreement is also unchanged at 9/16. These figures do not establish readiness across the five-label scale.

## Full-archive operational check

The selected profile was run once over the same 4,490-article snapshot. All 3,179 model candidates and all 221 eligible sentiment requests completed successfully. Six initial malformed sentiment answers succeeded on retry, with one requiring a second retry. A final resume reused all 3,179 checkpoints and made zero API calls.

Of 2,995 non-curated candidates, 1,598 receive confident inclusion, 1,028 confident exclusion, and 369 retain the baseline through uncertainty. Uncertainty falls from 43.7% under the earlier configuration to 12.3%. Enforcement would add 451 currently rejected articles and remove 234 currently included articles. These changes require editorial review and were not applied to the live reader. All 186 curated articles remain protected, including the two skipped by model evaluation.

The operational run retains normal curated metadata and is distinct from the masked validation experiment. Its reserved sentiment subset again gives 13/16 exact, versus 12/16 baseline and 12/16 confidence-gated hybrid. Seventy-five of 221 archive sentiment predictions meet the confidence threshold. Overall archive human scores include training articles, so they are not used to claim generalization. Full-archive agreement cannot establish correctness without independent labels.

## Runtime safeguards and verification

The workflow enables `src/rubrics/editorial-alignment-v1.json` through `JEV_ALIGNMENT_PROFILE`. Each incoming candidate receives the same profile used in evaluation. Any qualifying scope can support inclusion. The maximum of three scope signals is a decision rule, not a calibrated joint probability. Existing thresholds remain 0.70 for inclusion, 0.30 for exclusion, and 0.70 for sentiment confidence.

The existing 25-request cap, deterministic exclusions, and protected human selections remain active. Live enforcement is restricted to articles first discovered on or after `2026-09-21T18:13:31Z`. Discovery dates persist for both dated and undated audit records, preserving the boundary through later runs and rediscovery. Missing dates or an invalid configured boundary preserve existing decisions. Only the new cohort consumes the live request allowance. Requests and caches are versioned by the full reference-bearing input. Updating the guidance invalidates affected cached judgments. Missing or invalid profiles or reference files preserve the current output and record an explicit status.

Tests cover group exclusions, conflicting labels, query-sensitive article identity, future human-reference additions, environment-only workflow activation, privacy, malformed scope answers, missing inputs, unchanged shadow output, and cache invalidation when human context changes. All 245 tests pass, including historical migration across repeated audit reloads, new-cohort priority, missing boundary protection, and original-decision persistence.

The pre-enforcement shadow deployment was verified in [run 35635050909](https://github.com/oliverames/cerulean-news/actions/runs/35635050909). Its receiving audit reports 101 inclusion references, 50 sentiment references, 25 successful requests, zero failures, and `editorial-examples-v1` in every cache entry.

The audit now preserves original decisions for touched articles in `jevBaseline`. Switching to shadow stops further writes; restoration of already changed articles requires applying those saved originals to the affected cohort. No whole-archive restore is part of this rollout.

The supplied workbook was read in place and matched the corpus source digest. Its 99 exported sentiment labels and 12 conflicts were reverified. The workbook was not copied into the repository.

**Live activation verified**: [Run 35637740901](https://github.com/oliverames/cerulean-news/actions/runs/35637740901) passed all 245 tests and deployed `7196169`. The receiving audit confirms `enforce`, the fixed discovery cutoff, 101 inclusion references, and 50 sentiment references. It applied three new-cohort inclusion decisions, made two successful API requests, and reported no failures or pending new-cohort evaluations. All 4,493 historical records in the current archive remained outside enforcement, with zero historical decision changes and zero leaked internal fields in public JSON. Discovery times persisted for all 4,497 audit records. No new sentiment-eligible article appeared in this pass. A separate actual-API replay applied a 0.99-confidence positive sentiment to an isolated eligible copy while preserving its historical counterpart; no test record was published.

## Reproduction and next evidence

The grouped split, private corpus, development runs, reserved results, and request checkpoints are retained in the ignored `artifacts/jev-evaluation/2026-09-21-alignment/` directory. The full-archive evaluator accepts `--alignment src/rubrics/editorial-alignment-v1.json` and reads the same private reference seed. It fingerprints all inputs and resumes successful requests without repeating them.

[Issue #8](https://github.com/oliverames/cerulean-news/issues/8) tracks follow-up quality work during the approved rollout: obtain human-reviewed exclusions and new prospective sentiment judgments, improve excerpts that miss the brand passage, review the broader proposed inclusion changes, and validate confidence thresholds separately. No further tuning was performed on the reserved results.
