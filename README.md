<p align="center">
  <img src="site/readme-icon.svg" width="80" height="80" alt="Cerulean News">
</p>

<h1 align="center">Cerulean News</h1>

<p align="center">
  <strong>A text-first news monitor for Blue Cross VT mentions and Vermont health care coverage.</strong>
</p>

<p align="center">
  <code>97 default sources</code> &bull;
  <code>RSS + JSON Feed</code> &bull;
  <code>Cloudflare Pages refresh every 4 hours</code>
</p>

<p align="center">
  <a href="https://github.com/oliverames/cerulean-news/actions/workflows/publish-feed.yml">
    <img src="https://img.shields.io/github/actions/workflow/status/oliverames/cerulean-news/publish-feed.yml?branch=main&style=flat-square&label=publish&color=f5a542" alt="Publish workflow">
  </a>
  <img src="https://img.shields.io/badge/license-MIT-f5a542?style=flat-square" alt="MIT license">
  <a href="https://cerulean.news/">
    <img src="https://img.shields.io/badge/live-reader-f5a542?style=flat-square" alt="Live reader">
  </a>
</p>

---

Cerulean News collects public news items that matter to a Vermont health care communications team: direct Blue Cross VT mentions first, Vermont health care coverage second, then regional and national policy stories when they have a clear payer, coverage, or system angle. It publishes a plain reader, RSS feed, JSON Feed, and audit feed from a scheduled GitHub Actions workflow.

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
| Reader | `site/index.html` | Text-only browser with search and paging |

The live reader is published at [cerulean.news](https://cerulean.news/), with shortcuts at [/sentiment](https://cerulean.news/sentiment), [/rss](https://cerulean.news/rss), and [/json](https://cerulean.news/json). The old oliverames.github.io/vt-news-rss-bcbs address redirects there.

## What It Watches

The default source list combines Vermont outlets, official Blue Cross and health system pages, national health policy feeds, and Google News searches. Some direct outlet feeds also have site-scoped Google News fallbacks for GitHub runner blocks or rate limits.

| Category | Coverage | Notes |
| --- | --- | --- |
| Vermont news outlets | WCAX, VTDigger, Vermont Public, Seven Days, MyNBC5, MyChamplainValley, Burlington Free Press, The Rake Vermont, Poultney Journal, Magic 96.7, The Vermont Cynic, Addison Independent, Valley News, Caledonian-Record, The Chronicle/Barton Chronicle, The Commons, The Bridge, Community News Service, Waterbury Roundabout, and more | RSS, Atom, first-party sitemaps, outlet search feeds, or site-scoped Google News depending on what each outlet exposes; blocked primary feeds can fall back to site-scoped Google News |
| Official pages | UVM Health Newsroom, BCBSA Association News | Public listing pages are parsed because normal RSS feeds are not available. The site does not request anything from bluecrossvt.org (policy in `src/politeness.js`) |
| Curated backfill | A hand-kept clip log, read from `data/media-tracker-seed.json` | 186 clips. The file is not committed: the workflow materializes it from the `MEDIA_TRACKER_SEED_B64` secret (gzip + base64), and a local run needs a copy on disk. Re-emitted every run so the archive self-heals. Most of the list predates this crawler or sits behind outlets that block us, so no crawl can recover it |
| Search feeds | Blue Cross VT brand searches (site-, phrase-, Boolean-, and full-name-scoped), Vermont health search, Kristina source search, health insurance search, trade search, national policy search, outlet fallbacks | Google News degrades long OR queries, so each brand search is split into small homogeneous chunks; search feeds are capped and bounded to avoid turning the reader into generic health news |
| National health feeds | ABC Health, CBS Health, CNN Health, STAT, Fierce Healthcare, Healthcare Dive, KFF Health News, The Hill, NPR Health | Broad national items are filtered unless they have a payer, policy, coverage, or regional angle |
| Payer trade press | Becker's Payer Issues, Modern Healthcare, Health Payer Specialist | All three block direct crawling (403, or a redirect to a login), so each is a Google News search naming Blue Cross VT explicitly. Scoping to "Vermont" alone was measurably too loose. Health Payer Specialist is barely indexed and normally returns nothing |
| Social surfaces | Public Facebook pages for selected Vermont outlets | Parked by default; set `ENABLE_SOCIAL_SOURCES=true` for a deliberate one-off Facebook collection run |

Direct Blue Cross VT mentions are kept indefinitely. Other stories are kept for three months. (The 2026 backfill search that covered Jan. 1 through June 13, 2026 has been retired; its items remain in the archive.)

### Sections

The reader's three sections mean exactly this:

| Section | Meaning |
| --- | --- |
| Blue Cross VT | The story mentions us |
| VT Health Care | Vermont health news that does not mention us |
| BlueCrossVT.org | Our own site |

A brand term alone does not earn the first section. A bare "Blue Cross" also
matches `bcbs.com` association pages ("Transplant Static List") and other Blues
plans, so it must be corroborated by Vermont: a Vermont-specific brand term, a
Vermont outlet, or Vermont in the text. `itemCategory` is applied at both
enrichment and publishing, so an item classified under an older rule is
corrected in place rather than left misfiled in the archive. Applying it moved
88 `bcbs.com` pages out of Blue Cross VT.

Every article in the media tracker is Blue Cross VT by definition, whatever
terms the seed can see: roughly 40% of the list names us only in the article
body.

## How Matching Works

The matcher scans feed titles, descriptions, source text, and, when enabled, selected article pages. Brand terms scan both feed text and article body text. Topic terms scan feed text only, because full article bodies mention health care too often for that to be precise.

Article scanning is selective. Items with a brand, topic, declared search fallback, or brand-required source signal can fetch article pages for body text and comments. The collector caches a negative result only after it fetched the article and found no match. Items that source policy does not fetch leave no blank cache record. Sources can also opt into `feedOnly`, `smart`, `brandBody`, or `always` article scan modes through source metadata.

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
| Publisher placeholders, search pages, indexes, and provider directories | Rejected by narrow title and URL rules before summaries are published |
| Job listings and social discovery pages | Rejected because they are not press coverage |
| BlueCrossVT.org posts | Available as a section but hidden from the default All view |
| Social posts | Not collected by default; archived social items are pruned unless `ENABLE_SOCIAL_SOURCES=true` is set |

## Reader Experience

The reader is a static HTML page that loads `feed.json` in the browser. It shows the newest 25 stories first, supports simple search, and keeps comments hidden behind a per-story button. The section filter UI is switched off (since 2026-09-03; the markup and script remain), so the reader always shows the default selection: every news category, with the insurer's own posts and social items excluded.

The reader page has no access control. A client-side password gate existed until 2026-09-03 and is commented out in both pages rather than deleted; it was only ever a presentation gate, since the feed files were always fetchable by direct URL.

Each story can include:

| Field | Purpose |
| --- | --- |
| Date | Publication date from the source feed, listing page, or post HTML |
| Access label | `Free to read`, `Paywall likely`, `May require login`, or `Access varies` |
| Summary | AI-generated one or two sentence summary when Gemini is configured |
| Publisher preview | Up to two lead paragraphs and 600 characters from a paywalled publisher's ordinary unauthenticated page, when available |
| Sentiment | Five-point score, shown only on press coverage that names Blue Cross VT |
| Why it is here | Short relevance reason for a reader who wants to skim quickly |
| Also covered by | Other outlets' reports of the same event, listed under the newest one |
| Comments | Publicly parseable article or post comments, hidden by default |

When several outlets report one event, the reader and RSS feed show it once, led by the newest report, with the rest listed beneath it. `src/story-groups.js` compares headlines and summaries published within three days, including shared figures such as "760,000." An article joins a group only when it matches more than half of the group's articles. Blue Cross VT coverage, letters, columns, and roundups are not grouped, and one outlet's own articles group only when their headlines are nearly identical. Grouping is display only. The JSON Feed keeps every article and marks group members with a shared `storyGroupId`, so coverage counts and the trends page are unchanged. Search runs before grouping, so a search for one outlet still finds its report.

The browser does not recrawl sources. GitHub Actions does the collection and deploys the latest feed every four hours; reloading the page loads the latest published feed.

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

Gemini scores ride in the same batched request as the summary, so sentiment
costs no extra API calls. They persist in `feed-audit.json` like summaries do,
and an item is scored exactly once.

### Standing context

Some scores turn on knowledge of an ongoing storyline that a headline does not
carry. `data/coverage-context.json` records those, and the notes reach the
scorer only for articles that match. It is the communications team's file: the
generator cannot derive its contents, and a malformed entry degrades to no
storylines rather than stopping the run. Add a storyline whenever scores keep
coming out wrong for the same subject.

`site/trends.html` charts the coverage set over time: volume by month, net
sentiment by month, sentiment mix by month, net sentiment by outlet, and the
themes we get covered for. It has a range and outlet filter, hover detail on
every mark, and a table view of the same numbers. Sentiment uses a diverging colour ramp with a
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
| `RSS_NEGATIVE_CACHE_TTL_DAYS` | No | `14` | Days to keep article cache entries written after an article fetch, including negative no-match results, before validating or refreshing. No-match verdicts caused by a failed fetch expire after one day, so a transient 429 or timeout cannot suppress matching for two weeks. |
| `RSS_MAX_FUTURE_HOURS` | No | `6` | Future-dated item tolerance before exclusion |
| `ARCHIVE_MAX_AGE_DAYS` | No | `92` | Maximum age for topic-only archived stories. Undated stories use their persisted first-seen date. |
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
| `JEV_RELEVANCE` | No | `off` locally, `enforce` in Actions | Jev evaluation: `off`, `shadow` (compare inclusion and sentiment), or `enforce` (apply confident verdicts) |
| `JEV_ENFORCE_AFTER` | For aligned enforcement | repository activation timestamp | Only articles first discovered on or after this boundary can receive live Jev decisions |
| `JEV_ALIGNMENT_PROFILE` | No | `src/rubrics/editorial-alignment-v1.json` in Actions | Human example guidance and independent editorial scope questions for incoming articles |
| `JEV_EXAMPLES_PATH` | No | `data/media-tracker-seed.json` | Private human reference seed, supplied by the existing Actions secret |
| `JEV_RELEVANCE_RUBRIC_PATH` | No | `src/rubrics/relevance-v2.json` | Alternate rubric file, for trying a wording change without editing the versioned one |
| `TYPESAFE_API_KEY` | For live Jev calls | empty | TypeSafe credential, supplied from the Actions secret of the same name |
| `JEV_CLI_PATH` | No | empty | Explicit authenticated CLI fallback when no TypeSafe API key is supplied |
| `JEV_RELEVANCE_MAX_ITEMS` | No | `25` | Maximum new article evaluations per run; cached evaluations do not consume this cap |
| `JEV_RELEVANCE_CONCURRENCY` | No | `2` | Jev requests in flight at once |
| `JEV_RELEVANCE_TIMEOUT_MS` | No | `30000` | Timeout for a single Jev request |

### Jev article evaluation

Changing `JEV_RELEVANCE` back to `shadow` stops further changes but does not undo earlier applied decisions. The audit preserves each touched article's original judgment in `jevBaseline` for targeted restoration. Do not replace the entire archive, which would discard later arrivals.

The human reference library is supplied with every new evaluation. Jev does not retain customer-specific model training. The current profile draws from 101 verified human selections, including 50 unambiguous sentiment labels. It retrieves up to eight inclusion examples and 16 sentiment examples per request. Selection checks brand coverage, regional health care, and national payer or health policy independently, then combines the qualifying scope signals. Word overlap selects reference context, while Jev judges editorial meaning.

The versioned profile reserves evaluation groups and excludes known conflicting sentiment labels. It removes the candidate itself and known same-story examples before retrieval. Raw articles and labels remain in the existing private tracker input. Future articles receive this guidance automatically. New human feedback enters when the private seed is updated, rather than from recycling model judgments. Missing references preserve existing decisions and produce an explicit audit status.

Oliver approved live Jev selection and confident sentiment for newly discovered articles on September 21, 2026. The Actions publisher uses `enforce` with a fixed first-discovery boundary, preserving historical decisions. Live calls require the `TYPESAFE_API_KEY` Actions secret. Jev evaluates article inclusion, local relevance, and sentiment toward Blue Cross VT after Gemini creates summaries and its baseline judgments. Shadow mode records the comparison and leaves the published decisions unchanged. Set the repository variable `JEV_RELEVANCE=off` to pause it. [Issue #8](https://github.com/oliverames/cerulean-news/issues/8) tracks prospective quality review. The small reserved comparison improves, while sentiment coverage and editorial rejection labels remain limited. Uncertain or failed judgments retain the existing result. See the [human alignment results](docs/2026-09-21-jev-human-alignment.md), [earlier full evaluation](docs/2026-09-21-jev-full-archive-evaluation.md) and [initial integration review](docs/2026-09-21-jev-evaluation-review.md).

`src/jev-relevance.js` calls the [official TypeSafe API](https://docs.typesafe.ai/api) with the `TYPESAFE_API_KEY` secret. It does not require a CLI installation on the runner. The credential's canonical home is 1Password. Local runs are off unless `JEV_RELEVANCE` is set. Aligned enforcement requires a valid `JEV_ENFORCE_AFTER`; an absent or invalid boundary preserves existing decisions. Discovery times persist only in the audit feed. Historical backlog does not consume the live evaluation quota. An explicitly configured `JEV_CLI_PATH` remains available as a fallback when no API key is supplied.

Keyword matching still determines which articles enter the candidate archive. Deterministic exclusions, URL deduplication, and owned-content inclusion rules remain authoritative. Model-rejected candidates can be reconsidered, but articles never admitted by matching or removed by archive policy cannot be rescued. Hand-vetted tracker entries retain their inclusion decision while eligible press clips receive sentiment evaluation.

One bounded request includes a title of at most 300 characters and an excerpt of at most 1,200 characters. Requests also include the resolved outlet, matched terms, trusted BCBSVT sentiment eligibility, curated provenance, and whether the excerpt came from a generated summary. Existing verdicts, sentiment labels, and rationales are excluded. Full article text and feed bodies are never sent. The versioned relevance rubric asks `include`, `local_angle`, and `relevance`. Only `include` gates inclusion: at least 0.7 includes, at most 0.3 excludes, and the band between keeps the current decision. Local angle and relevance score remain diagnostics.

Eligible BCBSVT press coverage also receives a five-label sentiment question from `src/rubrics/sentiment-v2.json`. It starts with the existing tracker rules and matching storyline notes. The aligned profile supplies up to 16 paired human sentiment examples and more explicit label distinctions. In enforce mode, sentiment requires a valid answer with confidence of at least 0.7. Other coverage is not scored. Jev returns a label rather than a written rationale, so an applied Jev score clears the previous model's rationale. Jev likewise writes no inclusion rationale. When it adds an article that the first review left out, the "Why it is here" note keeps Gemini's description of the article and names the scope Jev rated highest, with its confidence, for example "National ACA enrollment changes. Jev added it as U.S. health coverage, insurance, or policy news (93% confidence) after the first review left it out." A Gemini line that states a rejection is dropped. Cached evaluations from before scope scores were stored give the description without the scope. Both inclusion and sentiment thresholds remain uncalibrated starting points.

The v2 inclusion question shares the existing Gemini policy: brand coverage, Vermont health care broadly, New England health care, and national insurance/payer, health-policy, or drug-coverage reporting. National reporting does not need a Vermont consequence. A Vermont publisher alone does not make syndicated subject matter local.

Successful evaluations are cached by the exact request, rubric versions, and model in the audit feed's `crawlState.jevCache`. Cached answers are reapplied after summaries, and the default 25-call cap advances to unevaluated articles. Changed input or rubric invalidates the matching cache entry. The cache retains typed signals only, and entries for departed candidates are pruned. Reader JSON and RSS do not contain the cache.

`crawlMetrics.jev` and Actions logs report successful calls, failures, cached evaluations, remaining candidates, and inclusion/sentiment disagreements. Missing credentials, failed requests, or malformed answers preserve the existing decisions and remain observable. Failed evaluations retry on a future run. TypeSafe overload and rate-limit responses receive one bounded retry, respecting short `Retry-After` delays.

### Offline archive comparison

`node scripts/evaluate-jev.js --snapshot PATH --holdout PRIVATE_LABELS --output artifacts/jev-evaluation/RUN_NAME` evaluates every retained candidate with the same requests and deterministic rules as publishing. Supply `TYPESAFE_API_KEY` through 1Password runtime injection. Add `--alignment src/rubrics/editorial-alignment-v1.json` to evaluate the deployed human-example configuration, using the same private seed. `--concurrency` defaults to four; `--limit` supports a bounded initial run.

Use a fixed audit snapshot and private labels keyed by URL, with `expectedSentiment`, `isCleanHoldout`, and `isCleanConservativeHoldout` flags. Those labels join after request construction and never enter model input. The evaluator records all deterministic skips, model uncertainty, selection changes, sentiment confidence, paired human-label comparisons, per-label performance, and an always-positive reference score. It distinguishes source excerpts from generated-summary fallback. Existing model judgments are a comparison baseline, not truth.

Successful request checkpoints resume without another API call. Failed requests retry; changed snapshots, labels, or complete request contracts require a new output directory. A partial run exits unsuccessfully and reports its missing evaluations. Private artifacts are ignored by Git and written with owner-only file permissions. The evaluator never updates the live feed or publication mode.

Gemini rate limits vary by project, model, and usage tier. The summarizer batches stories, caches successful summaries in `feed-audit.json`, and caps requests per run. Each configured model gets up to three attempts for network failures, HTTP 408 or 429, and transient 5xx responses. The retry uses exponential backoff with jitter and honors `Retry-After` when present. A batch that still fails remains pending for the next scheduled run.

Fresh first-party listing responses must produce at least one parser result. A zero-result response marks that source unhealthy instead of resetting its failure streak after a site redesign. Cached responses, `304 Not Modified` responses, and nonempty listings reduced to zero by date bounds remain healthy. Webhook delivery state is endpoint-specific, so a failed Slack or Discord request retries without duplicating a delivery the other endpoint accepted.

Source cooldowns are automatic when a primary feed has a fallback. HTTP 403 primary failures cool down for 24 hours, HTTP 429 failures use `Retry-After` (delta-seconds or HTTP-date form, capped at 24 hours) when present or two hours otherwise, and other primary errors cool down for one hour. During cooldown, the run goes straight to the fallback feed and records the reason in the audit feed. In-run retries treat HTTP 429 and 408 as transient and sleep up to 15 seconds between attempts; if `Retry-After` asks for longer than that, the fetch fails fast and the cooldown machinery takes over. Non-UTF-8 responses decode using the `Content-Type` charset or the document's own declaration, with bytes that validate as UTF-8 always taking precedence. Feed and article responses also store `ETag` and `Last-Modified` validators when servers provide them.

`www.bcbs.com` (the BCBSA listing page) serves an incomplete TLS chain: leaf certificate only, with no DigiCert intermediate. Browsers recover by fetching the missing certificate from the authority-information-access URL; Node deliberately does not do this, so every request fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The workflow therefore points `NODE_EXTRA_CA_CERTS` at `certs/digicert-global-g2-tls-rsa-sha256-2020-ca1.pem`, the missing intermediate taken from DigiCert's own CA issuers endpoint. Local runs need the same variable set to fetch that source.

## Crawl Politeness

`bluecrossvt.org` is the subject of this feed rather than an incidental source, and the scheduled workflow polls two of its listing pages. `src/politeness.js` holds a per-host policy that keeps that load minimal:

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
src/story-groups.js  Groups different outlets' reports of one event for display
src/summaries.js   Gemini prompt, batching, parsing, summary cache behavior
src/alerts.js      Failure streaks and optional webhook alerts
src/outputs.js     RSS, JSON Feed, audit JSON, file writes
src/utils.js       Shared text, date, URL, and concurrency helpers
src/fsx.js         Indirection over file reads and writes, so the generator can
                   run somewhere without a filesystem
src/egress.js      Routes hosts that refuse the runtime's IP range through a relay
site/index.html    Static text reader
site/trends.html   Sentiment-over-time charts
test/index.test.js Node test suite
worker/            Parked Cloudflare Worker build (see below)
proxy/             Fetch relay the Worker build needs (see proxy/README.md)
```

The workflow is deliberately simple:

1. Fetch source feeds and listing pages.
2. Apply source cooldowns and fallbacks when primary feeds are blocked.
3. Resolve and enrich matching items, using selective article scanning and the article cache.
4. Merge with the live audit archive.
5. Apply deterministic relevance rules.
6. Add summaries when Gemini is configured.
7. Write RSS, JSON Feed, and audit JSON.
8. Publish `site/` to Cloudflare Pages (direct upload with wrangler).

## The parked Cloudflare Worker

`worker/` and `proxy/` are a complete second way to run this, kept deployable
but not in use. They exist because GitHub Actions was cut off account-wide on
2026-09-05 when private-repo minutes ran out, and the site sat frozen for
eleven days before anyone noticed: a billing block fails as a red tick, not as
an outage.

The site went back to Actions once the macOS builds that had actually drained
the allowance were moved off it. The Worker stays for the next time billing
bites.

Two things are worth knowing before reaching for it:

- **Cloudflare cannot reach Google News.** It answers a Worker with HTTP 503
  and its "Sorry..." page while returning 200 from a residential connection,
  whatever headers you send. That is 39 of 97 sources and 39 Vermont outlets
  with no other route in, so the Worker build relays those fetches, and the
  Google News link decode, through `proxy/` on another host.
- **The article cache cannot live in the audit JSON there.** Loading it whole
  costs about 80 MB of a 128 MB isolate, so the Worker keeps it in KV and loads
  only the working set.

Both are inert here: `src/egress.js` does nothing unless `FETCH_PROXY_URL` is
set, and the article cache stays in the audit JSON unless a store is injected.
The Node CLI and the test suite behave exactly as they always did.

## Development

```bash
npm test
for file in src/*.js; do node --check "$file"; done
```

For a local run that does not touch committed outputs, write to a temporary directory:

```bash
mkdir -p /tmp/cerulean-news
cp site/feed-audit.json /tmp/cerulean-news/feed-audit.json

RSS_OUTPUT_PATH=/tmp/cerulean-news/feed.rss \
JSON_OUTPUT_PATH=/tmp/cerulean-news/feed.json \
AUDIT_JSON_OUTPUT_PATH=/tmp/cerulean-news/feed-audit.json \
RSS_ARTICLE_SCAN=false \
npm run generate
```

The publish workflow runs on pushes to `main`, manual dispatches, and a schedule of every four hours. Every run installs dependencies and runs the test suite. Scheduled and manual runs then generate the feed. Pushes that only change static reader or documentation files reuse the live feed seeded into `site/` and deploy the static artifact without crawling every source again.

## License

No license file is currently included in this repository.
