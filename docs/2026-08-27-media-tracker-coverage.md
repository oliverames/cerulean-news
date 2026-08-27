# Media Tracker Coverage Audit

**Date:** 2026-08-27
**Source:** `Media Tracker.xlsx` (Kristina Massari), 362 rows across 5 coverage sheets, 185 unique articles
**Compared against:** live `feed-audit.json`, generated 2026-08-27T09:52:58Z, 3,818 items

## Headline

Across the whole tracker we hold 45 of 185 articles (24%). That number is
misleading on its own, because this system did not exist for most of the
period the tracker covers. The first commit lands 2026-05-13 and the archive
only reaches real density in June 2026.

Measured over the window where the crawler actually ran continuously,
**June 1 to August 27 2026, we hold 29 of 58 tracker articles (50%)**, and the
trend is improving:

| Month | Caught | Tracker total | Recall |
|-------|--------|---------------|--------|
| 2026-06 | 10 | 24 | 42% |
| 2026-07 | 6 | 16 | 38% |
| 2026-08 | 13 | 18 | 72% |

Everything before June is a backfill artifact, not a recall failure. The
backfill searches recovered only 4 to 6 items per month for Dec 2025 through
April 2026, against 13 to 31 tracker rows per month.

## The 29 in-window misses

They split cleanly into two different problems.

### 1. Outlets we do not crawl at all (14 of 29)

Payer trade press dominates, and it is the single highest-value gap because
these are substantive stories about BCBSVT, not passing mentions:

- Becker's Payer Issues (4 in window, 17 across the tracker)
- Health Payer Specialist (2 in window, 6 total)
- Modern Healthcare (1 in window, 7 total)
- The Wall Street Journal (1 in window, 2 total)

Also missing: `vermonttreasurer.gov` press releases, Georgetown CHIR, and a
podcast episode featuring Beth Roberts.

Adding Becker's, Modern Healthcare, and Health Payer Specialist would close
roughly 10 of these 14. Becker's publishes RSS. The other two are paywalled
and would need the existing preview path.

### 2. Outlets we do crawl but did not match (15 of 29)

Reviewed individually, most are community and calendar filler that Kristina
logs for completeness:

- Event and calendar listings: Blue Cross Kayak Days (Caledonian Record,
  Vermont Journal, VTCNG), Times Argus world calendar and events pages
- Business briefs roundups: Times Argus x2, Vermont Business Magazine
- Letters to the editor (Seven Days), a golf tournament (Manchester Journal),
  a senior walk (Brattleboro Reformer)

Three are genuine substantive misses worth chasing:

- `vermontbiz.com` 2026-07-24, AM Best boosts credit rating for Blue Cross VT
- `timesargus.com` 2026-06, editorial "Mutual benefit"
- `vermontbiz.com` 2026-06-16, pharmacy discount card bill signed into law

The calendar and briefs pattern is a product decision, not a bug. Those items
appear inside roundup pages where the brand name sits in a single line among
many unrelated entries. Capturing them means accepting a lot of low-value
noise. Flagging for Oliver rather than fixing unilaterally.

## Sentiment methodology observed in the tracker

The `Sentiment` column appears on two sheets, `Media Coverage` and `Q2`. Of
362 rows, 155 carry a judgment. Normalized (correcting `Postive`, `Neuttral`,
and stripping appended rationale), the scale has five points:

| Value | Count |
|-------|-------|
| positive | 100 |
| neutral to positive | 15 |
| neutral | 20 |
| neutral to negative | 9 |
| negative | 11 |

Several cells carry free-text rationale after the label. Those notes reveal
the actual rules Kristina applies, and they are worth encoding verbatim:

- Sentiment is judged **toward BCBSVT specifically**, not toward the story
  overall. One row reads: neutral to positive, the article is focused on UVMH
  but we are mentioned in relation to our contract.
- **Headline tone is weighted heavily**, independent of the body. One row
  reads: neutral to positive, the headline is holding me back from saying
  positive. Another: neutral, headline focused on increase, story was balanced
  but leaned into the affordability struggles.
- **Mention prominence matters.** A story where BCBSVT is a footnote scores
  closer to neutral even when the topic is negative. One row reads: neutral to
  negative, article is negative re underperforming financials for BCBS plans
  but Vermont is just a footnote.
- **A negative topic drags the score** even when BCBSVT is not the target. One
  row reads: neutral to negative, while we are only mentioned in conjunction
  with Michigan, the story topic is a negative one.

These four rules are what the generator's prompt now implements.
