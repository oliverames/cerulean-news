# CLAUDE.md

Personal project: an hourly news monitor that publishes RSS/JSON feeds and a
text-only reader page for Blue Cross VT mentions and Vermont health care news.
GitHub Actions regenerates and deploys `site/` to GitHub Pages hourly; the
live `feed-audit.json` is the durable archive, summary cache, and
failure-streak store (each run seeds from it before generating).

## Layout

```
src/index.js      Entry point: generateFeed, main, re-export barrel (public surface)
src/sources.js    DEFAULT_SOURCES, Google News queries, env-configured Facebook sources
src/matching.js   Brand/topic term patterns, canonicalization, snippets
src/parsers.js    RSS/Atom, listing pages, article text, Facebook no-login HTML
src/fetching.js   fetchText (retries, size cap), per-domain throttle, source collection
src/politeness.js Per-host crawl policy (request pacing, Cache-Control freshness)
src/enrich.js     Article scanning, Google News link resolution, term matching
src/relevance.js  Deterministic relevance rules, access/source labels
src/archive.js    Previous-state loading, archive merge, resolved-item dedupe
src/summaries.js  Gemini batch summaries (cached; capped per run)
src/alerts.js     Failure streaks and webhook alerts
src/utils.js      Text/date/concurrency helpers
site/index.html   Static reader (vanilla JS, renders feed.json)
test/index.test.js  node:test suite; imports only from src/index.js
```

Import from `src/index.js` in tests and tooling; it re-exports the public
surface. Modules are flat with an acyclic dependency graph (utils at the
bottom, index at the top).

## Commands

```bash
npm test              # node --test (no network)
npm run generate      # full generation; writes site/feed.{rss,json} + feed-audit.json
```

Env vars are documented in README.md. For a local run that does not touch
committed outputs, set `RSS_OUTPUT_PATH`/`JSON_OUTPUT_PATH`/`AUDIT_JSON_OUTPUT_PATH`
to a temp dir, copy `site/feed-audit.json` there first to seed the archive,
and set `RSS_ARTICLE_SCAN=false` for speed.

## Verification ritual (used by WORKLOG entries)

1. `npm test` and `node --check src/*.js`
2. `xmllint --noout <generated feed.rss>`
3. Offline pipeline smoke: `generateFeed({ sources: [], ...tmp paths })` with a
   seeded audit copy (zero network, exercises archive → relevance → outputs)
4. Push, then watch the Actions run (`gh run watch`) and spot-check the live
   page and `feed-audit.json`

## Gotchas

- The audit JSON is the persistence layer: anything written into its `sources`
  array or item fields survives across runs via the workflow's seed step.
  Rejected items stay in the audit but are excluded from public feeds.
- The per-domain politeness delay (`RSS_DOMAIN_DELAY_MS`, 1s) genuinely
  dominates run time (~9 min builds) because only matched items are cached;
  unmatched articles are re-fetched each run. See WORKLOG 2026-06-12.
- TownNews-platform outlets (Times Argus, Rutland Herald, Bennington Banner,
  Reformer, VTCNG, Newport, St. Albans) share rate limiting; clustered 429s
  usually mean too many runs in a short window, not a broken source.
- Date-bounded sources auto-skip once `maxPubDate` passes (see
  `isSourceWindowClosed`); archived brand items are retained indefinitely.
- WORKLOG.md gets an entry per meaningful session, newest first.
