<p align="center">
  <img src="site/readme-icon.svg" width="80" height="80" alt="Blue News">
</p>

<h1 align="center">Blue News</h1>

<p align="center">
  <strong>A text-first news monitor for Blue Cross VT mentions and Vermont health care coverage.</strong>
</p>

<p align="center">
  <code>92 default sources</code> &bull;
  <code>RSS + JSON Feed</code> &bull;
  <code>hourly GitHub Pages refresh</code>
</p>

<p align="center">
  <a href="https://github.com/oliverames/vt-news-rss-bcbs/actions/workflows/publish-feed.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/oliverames/vt-news-rss-bcbs/publish-feed.yml?branch=main&style=flat-square&label=publish&color=f5a542" alt="Publish workflow">
  </a>
  <img src="https://img.shields.io/badge/license-not_specified-f5a542?style=flat-square" alt="License not specified">
  <a href="https://oliverames.github.io/vt-news-rss-bcbs/">
    <img src="https://img.shields.io/badge/live-reader-f5a542?style=flat-square" alt="Live reader">
  </a>
</p>

---

Blue News collects public news items that matter to a Vermont health care communications team: direct Blue Cross VT mentions first, Vermont health care coverage second, then regional and national policy stories when they have a clear payer, coverage, or system angle. It publishes a plain reader, RSS feed, JSON Feed, and audit feed from a scheduled GitHub Actions workflow.

The project is intentionally text-heavy. It follows the spirit of `text.npr.org`: fast, readable, useful, and clear about what was collected.

## Why This Exists

News monitoring gets messy when the search target is both narrow and broad. A direct BCBSVT mention is obvious. A hospital budget story, rate review hearing, Vermont Medicaid update, or Medicare Advantage policy story can matter just as much, but only when it fits the team’s actual geography and business context.

This monitor is built around that judgment. It prioritizes Vermont and Blue Cross VT, keeps official BlueCrossVT.org posts available without letting them flood the default view, and archives direct Blue Cross VT mentions indefinitely so important coverage does not disappear when a source feed rolls over.

It also keeps an audit trail. Rejected items, source failures, matched terms, summary reasons, comments, failure streaks, source cooldowns, crawler cache state, and crawl metrics all live in `feed-audit.json`, which makes the system inspectable instead of mysterious.

## Quick Start

```bash
npm install
npm run generate
```

The generator writes:

| Output | Path | Purpose |
| --- | --- | --- |
| RSS | `site/feed.rss` | Subscriber-friendly RSS 2.0 feed |
| JSON Feed | `site/feed.json` | Public reader data and machine-readable feed |
| Audit JSON | `site/feed-audit.json` | Rejected items, source status, summary cache, and archive state |
| Reader | `site/index.html` | Text-only browser with search, sections, and paging |

The live reader is published at [oliverames.github.io/vt-news-rss-bcbs](https://oliverames.github.io/vt-news-rss-bcbs/).

## What It Watches

The default source list combines Vermont outlets, official Blue Cross and health system pages, national health policy feeds, and Google News searches. Some direct outlet feeds also have site-scoped Google News fallbacks for GitHub runner blocks or rate limits.

| Category | Coverage | Notes |
| --- | --- | --- |
| Vermont news outlets | WCAX, VTDigger, Vermont Public, Seven Days, MyNBC5, MyChamplainValley, Burlington Free Press, The Rake Vermont, Poultney Journal, Magic 96.7, The Vermont Cynic, Addison Independent, Valley News, Caledonian-Record, The Chronicle/Barton Chronicle, The Commons, The Bridge, Community News Service, Waterbury Roundabout, and more | RSS, Atom, first-party sitemaps, outlet search feeds, or site-scoped Google News depending on what each outlet exposes; blocked primary feeds can fall back to site-scoped Google News |
| Official pages | BlueCrossVT Newsroom, BlueCrossVT Be Well VT Blog, UVM Health Newsroom, BCBSA Association News | Public listing pages are parsed because normal RSS feeds are not available |
| Search feeds | Blue Cross VT brand searches (site-, phrase-, Boolean-, and full-name-scoped), Vermont health search, Kristina source search, health insurance search, trade search, national policy search, outlet fallbacks | Google News degrades long OR queries, so each brand search is split into small homogeneous chunks; search feeds are capped and bounded to avoid turning the reader into generic health news |
| National health feeds | ABC Health, CBS Health, CNN Health, STAT, Fierce Healthcare, Healthcare Dive, KFF Health News, The Hill, NPR Health | Broad national items are filtered unless they have a payer, policy, coverage, or regional angle |
| Payer trade press | Becker's Payer Issues, Modern Healthcare, Health Payer Specialist | All three block direct crawling (403, or a redirect to a login), so each is a Google News search naming Blue Cross VT explicitly. Scoping to "Vermont" alone was measurably too loose. Health Payer Specialist is barely indexed and normally returns nothing |
| Social surfaces | Public Facebook pages for selected Vermont outlets | Parked by default; set `ENABLE_SOCIAL_SOURCES=true` for a deliberate one-off Facebook collection run |

Direct Blue Cross VT mentions are kept indefinitely. Other stories are kept for three months. (The 2026 backfill search that covered Jan. 1 through June 13, 2026 has been retired; its items remain in the archive.)

## How Matching Works

The matcher scans feed titles, descriptions, source text, and, when enabled, selected article pages. Brand terms scan both feed text and article body text. Topic terms scan feed text only, because full article bodies mention health care too often for that to be precise.

Article scanning is selective. Items with a brand, topic, declared search fallback, or brand-required source signal can fetch article pages for body text and comments. Items with no feed-level signal are cached as negative results for a bounded period instead of being scraped again every run. Sources can also opt into `feedOnly`, `smart`, `brandBody`, or `always` article scan modes through source metadata.

For articles labeled `Paywall likely`, the collector also tries to publish a clearly labeled publisher preview from the normal unauthenticated page response. The preview is capped at two editorial paragraphs and 600 characters, excludes subscription and login prompts, and is cached separately from generated summaries. The collector does not use authenticated sessions, alternate user agents, AMP or cache copies, archive services, or embedded full-article metadata to bypass access controls.

The brand matcher includes common variants:

| Canonical area | Examples |
| --- | --- |
| BCBSVT shorthand | `BCBSVT`, `BCBS VT`, `BCBS of Vermont` |
| Blue Cross VT variants | `Blue Cross VT`, `BlueCrossVT`, `Blue Cross Vermont` |
| Full legal name | `Blue Cross and Blue Shield of Vermont`, `BlueCross & BlueShield of Vermont` |
| Related products and references | `Vermont Blue Advantage`, `Vermont Blues plan`, `Vermont's largest health insurer` |
| Community properties | `Girls on the Run`, `Mountain Days`, `Walk@Lunch` |

Topic matching covers Vermont health care agencies, hospitals, providers, coverage programs, rate review, Medicaid, Medicare, prior authorization, pharmacy, rural health, mental health, public health, medical costs, and related policy areas.

The Google News search feeds also carry Kristina's current Boolean set directly: Blue Cross and BCBS variants paired with VT/Vermont, Vermont healthcare/health care/hospitals, health insurers, health care affordability, UVM Health, and MVP Health Care.

The relevance gate then removes common false positives:

| False positive pattern | How it is handled |
| --- | --- |
| Crime, crash, and incident briefs | Hospital transport language is stripped before hospital matching |
| Obituaries | RSS categories, obituary URLs/titles, and narrow obituary prose are excluded before matching and archive merge |
| Broad national health lifestyle stories | Rejected unless they include payer, policy, coverage, or regional signals |
| Out-of-region outbreaks | Rejected unless they include policy, payer, or regional relevance |
| Infrastructure or grant stories | Rejected when health care is only an incidental phrase |
| BlueCrossVT.org posts | Available as a section but hidden from the default All view |
| Social posts | Not collected by default; archived social items are pruned unless `ENABLE_SOCIAL_SOURCES=true` is set |

## Reader Experience

The reader is a static HTML page that loads `feed.json` in the browser. It shows the newest 25 stories first, supports simple search, uses plain checkbox sections for multi-select filtering, and keeps comments hidden behind a per-story button.

The reader page opens behind a client-side password gate. Visitors enter the shared password once; the reader then stays unlocked in that browser through `localStorage`. This is a presentation gate to keep the page from being casually browsed, not real access control: the password lives in the page source, and the underlying `feed.rss`, `feed.json`, and `feed-audit.json` files stay publicly fetchable by direct URL.

Each story can include:

| Field | Purpose |
| --- | --- |
| Date | Publication date from the source feed, listing page, or post HTML |
| Access label | `Free to read`, `Paywall likely`, `May require login`, or `Access varies` |
| Summary | AI-generated one or two sentence summary when Gemini is configured |
| Publisher preview | Up to two lead paragraphs and 600 characters from a paywalled publisher's ordinary unauthenticated page, when available |
| Sentiment | Five-point score, shown only on press coverage that names Blue Cross VT |
| Why it is here | Short relevance reason for a reader who wants to skim quickly |
| Comments | Publicly parseable article or post comments, hidden by default |

The browser does not recrawl sources. GitHub Actions does the collection and deploys the latest feed hourly; reloading the page loads the latest published feed.

## Sentiment

Press coverage that names Blue Cross VT carries a sentiment score on a
five-point scale: `positive`, `neutral to positive`, `neutral`,
`neutral to negative`, `negative`. The scale and the judging rules come from
the communications team's own media tracker, where 155 clips are hand-scored.
See `docs/2026-08-27-media-tracker-coverage.md` for the audit that derived them.

Four rules travel in the Gemini prompt, taken from the rationale the tracker
records alongside its scores:

1. Judge the tone toward Blue Cross VT specifically, not the tone of the story
   overall.
2. Weight the headline heavily and separately from the body.
3. Weight mention prominence; a footnote mention pulls toward neutral.
4. A negative story topic drags the score down even when Blue Cross VT is not
   the target.

Scoring is deliberately narrow. An item is scored only when it is brand
coverage (`category` is `Blue Cross VT`) **and** it is press about us. These
are excluded:

- Vermont health care stories that never name us, which have no tone toward us
- BlueCrossVT.org posts, which are owned content
- Facebook items and short-video hosts such as TikTok, which are not press
- `bcbs.com` pages, which are national association web pages matching only the
  generic term "Blue Cross"
- Recruitment listings on job boards, which name us without reporting on us
- Stories about a *different* Blues plan. The matcher accepts a bare
  "Blue Cross", which is right for surfacing a story but too loose to score, so
  a bare match must be corroborated by Vermont: a Vermont-specific brand term,
  a Vermont outlet, or Vermont in the text. Without this the generator scored a
  BCBS Massachusetts story and a generic "new Blue Cross CEO" piece.

Of 1,566 published items on 2026-08-27, 1,369 never name us and 197 do; of
those 197, 86 are bcbs.com association pages and 39 are our own posts, leaving
62 pieces of actual press coverage to score. A low scored count is a measure of
how much coverage exists, not of a scoring backlog.

Items in that coverage set carry `sentimentEligible: true` in the JSON feed,
so the trends page can count a story the hour it arrives, before it is scored.

Scores ride in the same batched Gemini request as the summary, so sentiment
costs no extra API calls. They persist in `feed-audit.json` like summaries do,
and an item is scored exactly once.

`site/trends.html` charts the coverage set over time: volume by month, net
sentiment by month, sentiment mix by month, net sentiment by outlet, and the
themes we get covered for. It has a range and outlet filter, hover detail on
every mark, and a table view of the same numbers, and sits behind the same
password gate as the reader. Sentiment uses a diverging colour ramp with a
neutral midpoint; volume and themes are magnitude, so they use a single hue.

Because Google News search feeds name the query rather than the publisher,
every item also carries an `outlet` field, resolved from the article link. The
trends page groups by that rather than by `sourceName`.

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `RSS_OUTPUT_PATH` | No | `site/feed.rss` | Output path for the RSS file |
| `JSON_OUTPUT_PATH` | No | next to RSS as `feed.json` | Output path for the public JSON feed |
| `AUDIT_JSON_OUTPUT_PATH` | No | next to RSS as `feed-audit.json` | Output path for the audit JSON and summary cache |
| `RSS_CONCURRENCY` | No | `6` | Number of article pages to fetch at once |
| `RSS_SOURCE_CONCURRENCY` | No | `4` | Number of sources to fetch at once |
| `RSS_DOMAIN_DELAY_MS` | No | `1000` | Politeness delay between requests to the same domain (`0` disables it for local runs) |
| `RSS_TOWNNEWS_DELAY_MS` | No | `8000` | Shared delay between TownNews search-feed requests across outlet domains (`0` disables it) |
| `RSS_BLUECROSSVT_DELAY_MS` | No | `5000` | Delay between requests to `bluecrossvt.org`, applied across its listing pages and any article page reached through a search result |
| `RSS_CACHE_FRESHNESS_CAP_MS` | No | `86400000` | Ceiling on how long a politeness-policy host's own `Cache-Control: max-age` may defer the next fetch. A backstop against an origin advertising an absurd `max-age`, not a policy dial; lower it only if a source needs to be picked up sooner than it says |
| `RSS_GLOBAL_CACHE_FRESHNESS_CAP_MS` | No | `3600000` | Ceiling on Cache-Control freshness for origins without a politeness policy. About half of the watched origins send `max-age`; their declared freshness is honored up to this cap, and `0` disables the deferral entirely |
| `RSS_TIMEOUT_MS` | No | `12000` | Request timeout in milliseconds |
| `RSS_FETCH_ATTEMPTS` | No | `3` | Fetch attempts before a source or article is marked failed |
| `RSS_MAX_RESPONSE_BYTES` | No | `10485760` | Maximum decompressed response size before a fetch is abandoned |
| `RSS_ARTICLE_SCAN` | No | `true` | Set to `false` to filter only RSS feed text |
| `RSS_PREVIEW_BACKFILL_MAX_PER_RUN` | No | `25` | Maximum archived paywall stories to revisit for previews in one run |
| `RSS_NEGATIVE_CACHE_TTL_DAYS` | No | `14` | Days to keep article cache entries, including negative no-match results, before validating or refreshing. No-match verdicts caused by a failed article fetch expire after one day regardless, so a transient 429 or timeout cannot suppress matching for two weeks. |
| `RSS_MAX_FUTURE_HOURS` | No | `6` | Future-dated item tolerance before exclusion |
| `ARCHIVE_MAX_AGE_DAYS` | No | `92` | Maximum age for topic-only archived stories |
| `FEED_URL` | No | empty | Public URL for the RSS self-link |
| `JSON_FEED_URL` | No | empty | Public URL for the JSON Feed |
| `SITE_URL` | No | empty | Public base URL for the channel link |
| `GEMINI_API_KEY` | No | empty | Optional Gemini key for batched summaries and reasons |
| `SUMMARY_BATCH_SIZE` | No | `10` | Stories summarized per Gemini request |
| `SUMMARY_BATCH_DELAY_MS` | No | `5000` | Delay between Gemini summary requests |
| `SUMMARY_MAX_REQUESTS_PER_RUN` | No | `10` | Maximum Gemini summary requests per run |
| `SUMMARY_REJUDGE_ALL` | No | empty | Set to `true` for one run after changing the relevance rubric |
| `SUMMARY_RESCORE_SENTIMENT` | No | empty | Set to `true` for one run after changing the sentiment rubric |
| `SLACK_WEBHOOK_URL` | No | empty | Optional Slack webhook for source failure alerts |
| `DISCORD_WEBHOOK_URL` | No | empty | Optional Discord webhook for source failure alerts |
| `WEBHOOK_FAILURE_THRESHOLD` | No | `24` | Consecutive failed runs before a source triggers an alert |
| `ENABLE_SOCIAL_SOURCES` | No | `false` | Set to `true` to include the parked built-in Facebook pages and configured Facebook URLs |
| `FACEBOOK_POST_URLS` | No | empty | Optional comma- or newline-separated `Name\|URL` public Facebook posts, used only when social sources are enabled |
| `FACEBOOK_PAGE_URLS` | No | empty | Optional comma- or newline-separated `Name\|URL` public Facebook pages, used only when social sources are enabled |
| `FACEBOOK_PAGE_MAX_POSTS` | No | `10` | Maximum post links to read from each configured Facebook page when social sources are enabled |

Gemini rate limits vary by project, model, and usage tier. The summarizer starts with `gemini-2.5-flash-lite`, batches stories, caches successful summaries in `feed-audit.json`, and caps requests per run so hourly refreshes stay conservative.

Source cooldowns are automatic when a primary feed has a fallback. HTTP 403 primary failures cool down for 24 hours, HTTP 429 failures use `Retry-After` (delta-seconds or HTTP-date form, capped at 24 hours) when present or two hours otherwise, and other primary errors cool down for one hour. During cooldown, the run goes straight to the fallback feed and records the reason in the audit feed. In-run retries treat HTTP 429 and 408 as transient and sleep up to 15 seconds between attempts; if `Retry-After` asks for longer than that, the fetch fails fast and the cooldown machinery takes over. Non-UTF-8 responses decode using the `Content-Type` charset or the document's own declaration, with bytes that validate as UTF-8 always taking precedence. Feed and article responses also store `ETag` and `Last-Modified` validators when servers provide them.

`www.bcbs.com` (the BCBSA listing page) serves an incomplete TLS chain: leaf certificate only, with no DigiCert intermediate. Browsers recover by fetching the missing certificate from the authority-information-access URL; Node deliberately does not do this, so every request fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The workflow therefore points `NODE_EXTRA_CA_CERTS` at `certs/digicert-global-g2-tls-rsa-sha256-2020-ca1.pem`, the missing intermediate taken from DigiCert's own CA issuers endpoint. Local runs need the same variable set to fetch that source.

## Crawl Politeness

`bluecrossvt.org` is the subject of this feed rather than an incidental source, and the hourly workflow polls two of its listing pages. `src/politeness.js` holds a per-host policy that keeps that load minimal:

- **Their cache window, not ours.** Both listing pages send `Cache-Control: max-age=86400`, and that is honored in full: the generator stores the remaining lifetime (`max-age` minus `Age`) and skips the fetch entirely while it lasts, so each page is fetched once a day rather than 24 times. `RSS_CACHE_FRESHNESS_CAP_MS` is only a backstop against an origin advertising an absurd `max-age`. The tradeoff is deliberate: a new Blue Cross post can take up to a day to reach the reader.
- **Revalidation that works.** These pages advertise a weak `ETag` the origin never validates against, and RFC 9110 makes `If-None-Match` suppress `If-Modified-Since` whenever both are sent, so the pair returned a full 119 KB body every hour. After one such response the generator records `preferLastModified` for that URL and sends `If-Modified-Since` alone, which returns `304` with an empty body.
- **One queue per host.** The listing pages and any article page reached through a Google News result share a single request queue with a five-second gap (`RSS_BLUECROSSVT_DELAY_MS`), so source concurrency cannot stack requests on them.

Both the freshness deadline and the revalidation verdict persist in `feed-audit.json`, so they carry across runs. Together they take a typical run from two full-body fetches to zero, and a day from roughly 48 requests and 5.7 MB to two conditional requests that usually return `304` with an empty body.

Every other origin gets the same treatment in a bounded form: a measured sample of production sources showed about half sending useful `max-age` values (mostly 5-15 minutes) and one advertising 31 days. Their declared freshness is honored up to `RSS_GLOBAL_CACHE_FRESHNESS_CAP_MS` (one hour by default), which trims redundant re-fetches when runs land close together without letting an absurd `max-age` park a source for more than one cycle.

## Architecture

```text
src/index.js       Entry point, generator orchestration, public re-export surface
src/sources.js     Default source list, Google News queries, parked Facebook sources
src/matching.js    Brand terms, topic terms, canonical labels, snippets
src/parsers.js     RSS, Atom, listing pages, article text and comments, Facebook public HTML
src/fetching.js    Fetch retries, size caps, source collection, domain throttling
src/politeness.js  Per-host crawl policy: request pacing and cache freshness
src/enrich.js      Google News decoding, article scanning, match enrichment
src/relevance.js   Deterministic relevance, source type, access labels
src/archive.js     Audit loading, archive retention, dedupe rules
src/summaries.js   Gemini prompt, batching, parsing, summary cache behavior
src/alerts.js      Failure streaks and optional webhook alerts
src/outputs.js     RSS, JSON Feed, audit JSON, file writes
src/utils.js       Shared text, date, URL, and concurrency helpers
site/index.html    Static text reader
site/trends.html   Sentiment-over-time charts
test/index.test.js Node test suite
```

The workflow is deliberately simple:

1. Fetch source feeds and listing pages.
2. Apply source cooldowns and fallbacks when primary feeds are blocked.
3. Resolve and enrich matching items, using selective article scanning and the article cache.
4. Merge with the live audit archive.
5. Apply deterministic relevance rules.
6. Add summaries when Gemini is configured.
7. Write RSS, JSON Feed, and audit JSON.
8. Publish `site/` to GitHub Pages.

## Development

```bash
npm test
for file in src/*.js; do node --check "$file"; done
```

For a local run that does not touch committed outputs, write to a temporary directory:

```bash
mkdir -p /tmp/vt-news-rss-bcbs
cp site/feed-audit.json /tmp/vt-news-rss-bcbs/feed-audit.json

RSS_OUTPUT_PATH=/tmp/vt-news-rss-bcbs/feed.rss \
JSON_OUTPUT_PATH=/tmp/vt-news-rss-bcbs/feed.json \
AUDIT_JSON_OUTPUT_PATH=/tmp/vt-news-rss-bcbs/feed-audit.json \
RSS_ARTICLE_SCAN=false \
npm run generate
```

The publish workflow runs on pushes to `main`, manual dispatches, and an hourly schedule. Scheduled and manual runs always do a full test and feed generation pass. Pushes that only change static reader or documentation files reuse the live feed seeded into `site/` and deploy the static artifact without crawling every source again.

## License

No license file is currently included in this repository.
