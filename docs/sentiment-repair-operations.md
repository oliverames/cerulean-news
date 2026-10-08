# Frozen sentiment repair operations

The dedicated `sentiment-repair.yml` workflow repairs sentiment odds from a frozen live archive. It does not crawl, summarize, rejudge inclusion, or run Gemini. Normal generation remains a separate workflow. Use the owning [GitHub issue #14](https://github.com/oliverames/cerulean-news/issues/14) and [Linear AME-39](https://linear.app/ames-consulting/issue/AME-39) to track unfinished sentiment work.

## Standard modes

- `manifest`: prepare and save the exact eligible request manifest and frozen audit without provider calls.
- `drain`: execute at most 25 untouched requests, sequentially, against the verified freeze and latest checkpoint. Save each sending intent and result durably. Stop on any provider or validation error.
- `recover`: reconcile a failed publication only when every saved attempt succeeded and reapplying the checkpoint changes nothing in the live archive. This mode makes no provider calls.

Every continuation supplies the original `freeze_run_id` and latest `checkpoint_run_id`. The lineage guard rejects ambiguous, repeated, stale or incompatible runs. Do not rerun an inference job or substitute a fresh freeze to evade an unresolved attempt. Save checkpoint artifacts privately before their GitHub retention expires; they contain model evaluation results. The private editorial reference seed must never be committed or uploaded as an artifact.

## Explicit October 8 recovery

The additional modes are restricted to manifest `1d3bebd2ead988aea59b8e55dc59943503a55645b214863fd3521e9fbfc24971`, frozen by [run 37822663207](https://github.com/oliverames/cerulean-news/actions/runs/37822663207). Oliver approved publishing 15 saved valid responses, continuing 91 untouched requests, and one isolated retry of the original malformed response. These modes do not authorize another manifest or another retry.

- `salvage`: publish the 65 valid saved outcomes from the original 66-attempt checkpoint, preserving its failed entry. No provider calls occur.
- `continue`: send at most 25 untouched requests and skip the original failed target. Additional errors stop the operation.
- `retry`: require 156 successes and all 157 targets attempted; send only the original failed target once. Persist the retry flag before sending and retain the original attempt in the new row's history. There is no second retry.

Requests retain the existing article fields, selected private editorial/reference context, TypeSafe recipient, pinned `jev-1.13.0` model and free-plan scope. The strict five-label probability contract is unchanged. A rejected answer's private diagnostic records only fixed-label numeric values, schema checks and a response hash; it excludes arbitrary response strings and article/reference text.

## Publication acceptance

The checkpoint is saved before publication. Only valid results and their sentiment caches may be applied. Before deployment, verify that the live publication still matches the seeded snapshot. Preserve all non-sentiment audit/feed fields, inclusion decisions, archive and digest membership, storyline membership, generation time, and calendar/alert artifacts. Read back all nine generated files after deployment with bounded propagation checks. A successful deployment alone is insufficient evidence that publication completed.

Use the manifest and durable checkpoint for exact backlog counts. The frozen archive's crawl metrics describe an earlier generation and are not a current repair-queue counter. The Gemini rubric backlog is separate, even when a story now has valid Jev odds and a numeric score. Its existing rescore path can also rewrite summaries and relevance; define and approve the allowed output contract before running it.
