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

## Calibration measured against the tracker

Agreement is measurable wherever the tracker and the archive have both scored
the same article. Seeding the tracker took that overlap from 25 articles to
91, and agreement improved rather than regressing to the mean, which is the
stronger evidence that the calibration is real.

| | Rules only | Rules plus worked examples | Same, over the seeded archive |
|---|---|---|---|
| Overlapping articles | 25 | 25 | **91** |
| Exact agreement | 40% | 60% | **69%** |
| Within one step | 72% | 84% | **85%** |
| Mean bias (steps) | −0.56 | −0.36 | **−0.21** |

Negative bias means the generator scores lower than the tracker does. The
first pass scored ordinary favourable brand presence as neutral where the
tracker scores it positive, so the prompt gained an explicit fifth rule and
ten worked examples lifted verbatim from the tracker, spanning all five points
of the scale. Published positives went from 12% of scored items to 23%.

### The residual gap is context, not calibration

Four of the ten remaining disagreements need knowledge of our own business
that no model can read off a headline, and they run in both directions:

| Article | Tracker | Generator |
|---|---|---|
| Vermont's largest health insurer wants to offer a cheaper plan | neutral to negative | neutral to positive |
| BlueCross BlueShield of VT pulls its proposed lower-cost plan | positive | neutral to negative |
| BCBS Vermont takes step back with proposed product line | neutral to positive | neutral to negative |
| Vermont will join multi-state prescription drug purchasing pool | positive | neutral |

The first three are all the same underlying story, the VT Basic lower-cost
qualified health plan. The tracker reads coverage of *proposing* it as adverse
and coverage of *withdrawing* it as favourable, which inverts what the
headlines suggest. Its topic column records the reason ("VT Basic - pulling
from QHP"); the generator sees only the headline and excerpt.

Closing this needs standing context notes rather than a better rubric: a short
list of live storylines and how coverage of each should read. That list has to
come from the communications team, so it is not something the generator can
derive. Re-running the agreement measurement after any rubric change is the
way to tell whether a change helped, rather than reasoning about it.

## Coverage volume, and a correction

An earlier reading of this data reported August 2026 as roughly double any
prior month. That was an artefact of measuring before the tracker was seeded:
each month was counted only from what the crawler independently found, and the
crawler's reach grew over the period, so early months were undercounted rather
than quiet.

With the tracker seeded, the monthly coverage set reads:

| Month | Stories naming us |
|-------|-------------------|
| 2026-03 | 23 |
| 2026-04 | 5 |
| 2026-05 | 31 |
| 2026-06 | 26 |
| 2026-07 | 18 |
| 2026-08 | 25 |

August is an ordinary month, not an outlier. May is the busiest.

What August does show is a clear shift in subject. Against July, Green Mountain
Care Board mentions go from 2 to 8 and premiums and rate review from 3 to 8,
which is the annual rate-decision cycle: the board set 2027 premium rates in
mid-August and five separate outlets covered it. The rest of the month is
Kayak Days sponsorship coverage, which produces calendar and community items
across four outlets. Both are predictable annual events, so the pattern is
worth expecting next year rather than explaining after the fact.

## Standing context

`data/coverage-context.json` closes the part of the sentiment gap that no
rubric can. It records how the team reads coverage of an ongoing storyline
where that reading is not recoverable from a headline, and the notes reach the
scorer only for articles that match. It is the team's file: the generator
cannot derive its contents, and a malformed entry degrades to "no storylines"
rather than stopping the run.

It ships with one storyline, VT Basic, derived entirely from scores already
recorded in the tracker:

| Article | Tracker score |
|---|---|
| Vermont's largest health insurer wants to offer a cheaper plan | neutral to negative |
| BlueCross BlueShield of VT pulls its proposed lower-cost plan | positive |
| BCBS Vermont takes step back with proposed product line | neutral to positive |
| No one struggling to pay rent can meet a $12,000 deductible | negative |

Coverage of proposing the plan reads adverse; coverage of withdrawing it reads
favourable. That inverts the headlines, which is exactly why it has to be
stated rather than inferred. Add a storyline whenever scores keep coming out
wrong for the same subject.

## What the scored coverage says

Measured 2026-08-27 over 189 scored stories, once the tracker backfill was in.
Scores run +2 (positive) to −2 (negative).

### Sentiment by theme

| Theme | Net | Stories |
|-------|-----|---------|
| ACA & marketplace | −0.80 | 5 |
| Medicare Advantage | −0.67 | 6 |
| Medicare | −0.67 | 6 |
| Medical costs & billing | −0.40 | 5 |
| UVM Health | −0.25 | 16 |
| Health care | −0.13 | 47 |
| Health insurance | +0.10 | 31 |
| Green Mountain Care Board | +0.14 | 14 |
| Premiums & rate review | +0.40 | 20 |
| Hospitals | +0.42 | 12 |
| Prescription drugs & pharmacy | +0.70 | 10 |
| VAHHS | +1.60 | 5 |
| Girls on the Run | +2.00 | 5 |

Two results are worth pausing on, because both run against expectation.

**Rate coverage is not hurting us.** Premiums and rate review scores +0.40 and
the Green Mountain Care Board +0.14, despite being the single largest subject
in the coverage set. The story that dominates our volume is not the story that
damages us.

**The adverse coverage is federal-programme coverage.** ACA and marketplace,
Medicare Advantage, and Medicare are the three worst themes, and the stories
behind them are industry pieces about federal policy where BCBSVT is named
among a list of payers.

### Vermont press against national trade

| | Stories | Net | Positive-leaning | Negative-leaning |
|---|---|---|---|---|
| Vermont press | 160 | +0.71 | 57% | 26% |
| National trade | 29 | +0.28 | 48% | 48% |

National trade coverage is polarized rather than negative, and the split is
almost entirely one outlet:

| Outlet | Net | Stories |
|--------|-----|---------|
| Modern Healthcare | −0.78 | 9 |
| Becker's Payer Issues | +1.00 | 12 |
| Health Payer Specialist | +1.20 | 5 |

Adding payer trade press did not import a block of negative coverage, which is
what it looked like at first. Becker's and Health Payer Specialist are two of
the most favourable outlets in the whole set. Modern Healthcare specifically is
adverse, and its nine stories are the Medicare Advantage and ACA industry
pieces that also drive the worst themes above. Those are the same articles
counted twice, not two separate problems.

### Known noise

Four of the 212 items in the coverage set are not press coverage and were
found by the crawler rather than logged by the team: a page-scan artefact
("Page A18"), an employer-review page on `breakroom.cc`, a shopper insert, and
an events listing. At roughly 2% they do not move any figure above, but the
first two are not articles at all and should be filtered.
