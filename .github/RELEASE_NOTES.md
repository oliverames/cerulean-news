# v1.2.0 — Coverage quality and sentiment

Forty-three commits since 1.1.0. This release adds sentiment scoring and a
trends page, seeds the media tracker as a first-class source, and works
through a long run of relevance and deduplication defects. 179 tests pass.

## Sentiment and trends
- Brand coverage now carries a sentiment score, calibrated against the media
  tracker, with a trends page showing volume and theme over time.
- Other Blues plans are no longer scored as Blue Cross VT coverage.
- A stale sentiment score is dropped at the publishing boundary rather than
  shipped, and a one-shot re-score or relevance re-judge can be triggered from
  workflow dispatch.

## Media tracker
- Hand-logged clips are seeded into the pipeline and can never be vetoed or
  deduplicated away by a crawler copy of the same story.
- A curated clip wins a title collision against a copy the crawler found, and
  keeps the outlet and URL the team recorded.

## Relevance
- Job listings, publisher e-edition placeholders, edition wrappers,
  association directories and news indexes, and social search pages are all
  rejected as non-articles.
- A crime or crash brief whose only health tie is an incidental provider
  mention is rejected. The existing out-of-region rule could not catch these,
  because an in-state placename supplies a genuine regional signal.
- Broad national health items without a payer, policy, or regional angle are
  rejected.

## Deduplication
- Tracking parameters are used to match stories, not to rewrite them. The
  winning item keeps its own link, so a hand-logged clip's recorded URL
  survives, and the result no longer depends on input order.
- Deduplication no longer invents a `guid` on items that never carried one.

## Crawler and sources
- Payer trade press sources added; brand-search recall, the BCBSA TLS chain,
  and outlet fallbacks fixed.
- bluecrossvt.org's full 24-hour Cache-Control window is honored, cutting
  hourly request load.
- Cached coverage is preserved across runs, and a re-score reaches the whole
  archive rather than a recent slice.

## Site and CI
- The reader is now Blue News, with a password gate, clearer story details,
  and the update date moved into the title row.
- A static-only change can no longer deploy a stale feed, and workflows are
  validated safely. The test job now runs on every mode, not only full runs.
