# Jev evaluation review, September 21, 2026

Author: Oliver Ames

Jev was merged but inactive when this review began. The updated publisher is configured for live shadow evaluation of inclusion, local relevance, and eligible Blue Cross VT sentiment. Enforcement is deferred because the calibration did not support it.

## Repository review

The canonical checkout is `/Users/oliverames/Developer/Projects/cerulean-news`. The former `vt-news-rss-bcbs` path no longer exists. Git lists one registered worktree on `main`.

The review started at `9392bc7`, following merge `3ab34b3` and implementation commit `fac8b6a` from pull request #7. The local Jev branch is fully merged. Its remote-tracking reference was stale: GitHub advertised only `main`. No worktree or branch was deleted. An unrelated local Dependabot branch was outside this review.

The September 21 work log accurately said Jev was off. GitHub initially had no Jev mode variable or TypeSafe secret. The pipeline used Gemini for relevance and sentiment. After the initial search, Oliver saved the TypeSafe credential in the Development vault, and authenticated API calls succeeded.

## Changes

- Added direct HTTPS calls to TypeSafe, with bounded timeout/retry behavior and optional CLI compatibility.
- Moved Jev after summaries so Gemini cannot overwrite an enforced decision.
- Added brand sentiment using the existing tracker rules, worked examples, and storyline context.
- Preserved deterministic exclusions, owned-content inclusion, and hand-vetted tracker inclusion. Eligible tracker press can receive sentiment.
- Persisted typed evaluation signals under request hashes in the audit state. Successful evaluations no longer repeatedly consume the newest-item cap.
- Rejected invalid probability values and exposed failure, pending, and disagreement metrics.
- Wired the publishing workflow to the TypeSafe secret and shadow mode. Keyword-miss rescue remains outside this change.

## Live calibration

The sampled audit was generated on September 21 at 15:06 UTC. Calls used `jev-1.13.0`, `relevance-v1`, and `sentiment-v1`. The sample included ten recent eligible brand items, ten accepted topic items, and ten rejected topic items. These were selected groups, not a random accuracy sample.

| Check | Result |
| --- | --- |
| Authenticated API calls | 50 successful, no errors |
| Current inclusion agreement | 22 of 30 live articles |
| Existing sentiment agreement | 2 of 9 live articles with a baseline label |
| Tracker sentiment exact agreement | 4 of 10 examples |
| Tracker agreement at confidence at least 0.70 | 3 of 7 examples |

The tracker comparison removed each target example from its own prompt. It remains a small comparison against known worked examples, not an independent holdout. Excerpts contain the saved context rather than full articles or scorer rationales. Ten additional initial tracker calls omitted the metadata needed to ask sentiment. They evaluated inclusion only and are excluded from sentiment statistics.

Jev excluded national Medicare coverage guidance at 0.11 inclusion probability. It scored the UVM $300 million expense-cut example neutral to negative at 0.94 confidence, against the tracker's neutral to positive label. Some other exclusions appear reasonable, so agreement with existing Gemini output should not be treated as ground truth.

The decision is to run shadow evaluation and retain current publication decisions. A larger independent review with improved rubric and input evidence is required before enforcement. [Issue #8](https://github.com/oliverames/cerulean-news/issues/8) tracks that work.

## Verification

The existing 216-test suite passed after the integration change. Fourteen new regression tests cover final pipeline ordering, inclusion and sentiment eligibility, curated inclusion, request privacy, cache progression and replay, durable archive persistence, malformed values, mode validation, missing credentials, and HTTP behavior. Tests use isolated fixtures and never call a live model.

Deployment evidence will be added after the publishing workflow completes.

## References

The implementation follows TypeSafe's [HTTP API contract](https://docs.typesafe.ai/api), [Choice response specification](https://docs.typesafe.ai/primitives/choice), and [confidence guidance](https://docs.typesafe.ai/confidence). The provider's [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13) also reinforce the need to calibrate before acting on scores.
