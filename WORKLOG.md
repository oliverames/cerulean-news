## 2026-08-25 - Bug-fix pass on the crawler and source-finder layers

**What changed**: Four fixes, each with a regression test. (1) `VERMONT_SOURCE_NAMES` covered only 24 of the ~65 hand-curated Vermont outlets, so small-town papers (Cabot Chronicle, Waterbury Roundabout, The Commons, and roughly 37 more) lost the sourceName regional fallback and their local health stories were rejected as "outside Vermont" whenever the copy named no other Vermont place; the set now covers every curated outlet except national/search feeds and brand-owned listings, and a new sync test forces any future source to be either registered or explicitly excepted. (2) The out-of-region state veto misfired on Vermont geography: "Washington County" (plus the towns of Washington, Georgia, and Florida) matched `NON_NEW_ENGLAND_STATE_PATTERN`, so e.g. a Times Argus Washington County story was rejected as out-of-state; `hasRegionalSignal` now strips those three ambiguous tokens before the veto, which only ever gates the Vermont-outlet branch, so national outlets are unaffected. (3) `fetchText` threw on non-OK responses without consuming the body, pinning each error response's socket until GC; it now cancels the unread body before raising. (4) `writeOutput` created only the RSS directory, so independently configured output paths in other directories crashed with ENOENT; it now mkdirs each output's own directory.

**Decisions made**: Treated the `VERMONT_SOURCE_NAMES` gap as a bug rather than calibration because the set's purpose (per the summary prompt, "small local items" matter) contradicts leaving curated outlets unregistered; noise risk is bounded because Gemini still judges everything that passes. Chose token-stripping over reordering the veto because flipping the precedence would have re-admitted Vermont outlets' national syndications wholesale. Probed two suspected bugs and disproved them rather than "fixing" them: the UVM newsroom parser cannot crash on malformed hrefs (its `a[href^="/newsroom/"]` selector filters them before `new URL`), and `TRANSPORT_IDIOM`'s global flag is safe (only used via `String.replace`, which resets `lastIndex`).

**Left off at**: All changes verified and pushed to `origin/main`. Candidate follow-ups not taken: `parseFacebookPageHtml` anchor-path descriptions are unbounded (embedded-posts path is fine), article comment replies found in HTML are dropped rather than nested, and only policy hosts get the Cache-Control freshness skip (see 2026-08-07 open question).

**Open questions**: None from this pass.

**Verification**: `npm test` green (101/101: 97 prior + 4 new covering the roster sync, the Washington/Georgia/Cabot rescues with a CNN guard, error-body release, and per-directory output creation). `node --check` clean on all `src/*.js`. Offline pipeline smoke (`sources: []`, seeded audit copy, zero network) preserved 2,686 items — byte-identical count to the same smoke run against clean HEAD in a throwaway worktree, proving no regression in merge/archive behavior. `xmllint --noout` passed on the generated feed.

---

## 2026-08-07 - Cut the hourly crawl load on bluecrossvt.org

**What changed**: Added `src/politeness.js`, a per-host crawl policy layer, and applied it to `bluecrossvt.org`. Two fixes cover almost all of the traffic. First, both listing pages send `Cache-Control: max-age=86400` but the workflow polled them hourly; the generator now stores `freshUntil` from the response's own `max-age` minus `Age` and skips the fetch entirely while it holds, taking each page from 24 fetches a day to one. Second, revalidation had been silently failing: these pages advertise a weak `ETag` the origin never validates against, and RFC 9110 makes `If-None-Match` suppress `If-Modified-Since` when both are sent, so every hourly poll pulled a full 119 KB body. `fetchText` now detects a 200 whose validators match the ones it sent, records `preferLastModified` for that URL, and drops `If-None-Match` from then on. Both fields persist through `normalizeCrawlState` so they survive the audit-JSON round trip. Also gave the host a shared 5s throttle queue (`RSS_BLUECROSSVT_DELAY_MS`) covering both listing pages and any article page reached via a Google News result, and added a `cacheFreshSkips` collection metric. The live audit confirmed the starting state: neither BCBSVT source had ever recorded `notModified`.

**Decisions made**: Scoped everything to a host policy table rather than changing global fetch behavior, so the blast radius stays on the one host the request was about. Honor `Cache-Control: max-age` in full rather than capping deference at a shorter window. Oliver chose this over an initial 6-hour cap, accepting that a new Blue Cross post can take up to a day to reach the reader in exchange for taking the site at its word. `RSS_CACHE_FRESHNESS_CAP_MS` survives at 24h purely as a backstop against an origin advertising an absurd `max-age`, not as a policy dial. Two other candidate changes were built and then reverted at Oliver's direction, both by design rather than oversight: an identifying bot user agent for this host (the Chrome user agent and its `sec-ch-ua`/`sec-fetch` client hints are deliberate), and robots.txt fetching and compliance (deliberately absent). Did not extend `preferLastModified` persistence to the article cache, whose 14-day TTL makes per-URL revalidation tuning near-worthless there.

**Left off at**: All changes committed and pushed to `origin/main`. Confirmed in production on the 2026-08-08T20:49Z run: both BCBSVT sources recorded `preferLastModified: true` and a ~24h `freshUntil`, and `cacheFreshSkips: 2` means the run made zero requests to bluecrossvt.org while both source rows stayed `ok` with `consecutiveFailures: 0`. Also refreshed the committed `site/feed-audit.json` fallback seed from that run (169 -> 2,700 items, 37 -> 86 sources), with `crawlState.articleCache` emptied: its 20,792 entries are 77% of the payload, carry 14-day TTLs, and would be pruned as expired before the committed copy is ever read, so they cost ~2.5 MB of permanent git history for nothing. That run also shows 39 `news.google.com` 503s and a long-standing `BCBSA Association News` failure at 283 consecutive; both predate this work and are unrelated to it.

**Open questions**: The weak-ETag adaptation is general and now benefits any origin behaving the same way (35 of the stored feed-header entries carry weak ETags), but only policy hosts get the freshness skip, so it is worth revisiting if other outlets turn out to send useful `max-age` values.

**Verification**: `npm test` green (97/97, 5 new tests covering the host policy, `Cache-Control` freshness math including the `Age` subtraction and cap, the weak-ETag adaptation against a mock origin that mimics bluecrossvt.org, the fresh-cache fetch skip, and the crawl-state round trip). `node --check` clean on all `src/*.js`. Offline pipeline smoke with `sources: []` and a seeded audit copy preserved 144 archived items with zero network; `xmllint --noout` passed on the generated feed. Live check against the real site: `freshUntil` resolved from their `max-age` and `Age`, sending both validators still returned 200 with 119,303 bytes, and the adapted request returned 304 with 0 bytes.

## 2026-07-22 - Add a password gate to the reader page

**What changed**: Added a client-side password gate to `site/index.html`, adapted from the local `sunshine-trail` overlay pattern. An early `localStorage` check in `<head>` prevents a flash of the gate for returning visitors; a full-viewport overlay (styled with the existing tricolor bar and Helvetica, no BCBS logo) blocks the page until the password `bcbs-quad-horse` is entered (case-insensitive, trimmed). Auth persists via the `bcbsNewsAuth` localStorage key; wrong entries show an inline error and stay gated. Updated the README Reader Experience section to document the gate and its limits.

**Decisions made**: Treat this as a presentation gate, not real access control; the password is visible in page source and `feed.rss`/`feed.json`/`feed-audit.json` remain publicly fetchable by direct URL. Styled the gate to the site's own look rather than copying sunshine-trail's sun/beer visuals, and deliberately used no BCBS logo per request. Edited `site/index.html` directly because the generator writes only the feed/audit files, not the reader HTML, so the change is not overwritten by a build.

**Left off at**: Commit `7b71ccc` (gate) pushed to `origin/main`; README/WORKLOG docs follow-up committed on top. Repo clean and synchronized.

**Open questions**: If real access control is ever needed, move to server-side auth (Cloudflare Access fits the migration plan in `CLOUDFLARE_MIGRATION_PLAN.md`). The reader's indexable-vs-noindex question from the 2026-07-21 entry is unchanged.

**Verification**: `npm test` green (90/90). Headless Chromium checks passed: first-load gate visible, wrong-password error and still gated, correct-password unlock, case-insensitive/trimmed unlock, and persistence across reload. Gate script passed `node --check`.

---

## 2026-07-22 - Exercise test and release automation safely

**What changed**: Added manual entry points for the test workflow and a non-publishing release dry run, then exercised both through GitHub Actions.

**Decisions made**: The release test must prove packaging without creating tags, releases, or production feed mutations.

**Left off at**: Both manual runs are green and the repository is synchronized.

**Open questions**: The Cloudflare hosting and crawler-migration decisions recorded below remain unchanged.

**Verification**: All 90 tests passed, the audit reported zero vulnerabilities, and the release dry run completed without publishing artifacts.

---

## 2026-07-21 - Document Cloudflare hosting and crawler migration

**What changed**: Added `CLOUDFLARE_MIGRATION_PLAN.md`, documenting a phased move of the reader and feeds to `amesvt.com/vt-news-rss-bcbs/`. Phase 1 keeps the hourly crawler in GitHub Actions and deploys the same generated artifact to GitHub Pages and a narrowly routed Cloudflare Worker with Static Assets. Phase 2 records the optional migration of crawling to a paid scheduled Worker with R2-backed state, overlap protection, and a GitHub Pages mirror strategy.

**Decisions made**: Keep the existing crawler and archive behavior unchanged during the hosting move. Avoid deploying hourly news artifacts through the separate `amesvt-website` Pages project because independent deployments could overwrite each other. Treat Cloudflare-native crawling as a later migration, with a likely cost near $5 per month and an $8 planning ceiling until production CPU usage is measured. Keep credential values and account-specific identifiers out of tracked files.

**Left off at**: The research plan was re-read, passed `git diff --check`, and passed a targeted credential-pattern scan. Commit `3c11ebc` was pushed to `origin/main`; the repository was clean and synchronized after the push.

**Open questions**: Before implementation, decide whether the news reader should be indexable or inherit the current `amesvt.com` `noindex, nofollow` posture. Before moving the crawler, confirm the Workers Paid minimum and how the GitHub Pages mirror should remain fresh.

---

## 2026-07-13 - Privacy history cleanup

**What changed**: Rewrote `main` and `v1.1.0` so old maintainer emails use the GitHub noreply address, removed former donation and social-profile links, replaced a machine-local asset path with neutral wording, and removed AI co-author and session trailers. The current feed, reader, and application code are unchanged.

**Verification**: All 90 tests pass, `npm audit` reports zero vulnerabilities, Gitleaks reports no findings across the rewritten history, and no branch or tag contains the former email, profile, machine-path, or AI-attribution patterns. Both `main` and `v1.1.0` were force-pushed with leases.

**Remaining privacy step**: GitHub still serves the previous commits when someone requests an old object by its exact hash, even though no branch or tag points to that history. GitHub Support is the only documented route for asking GitHub to remove cached views and run server-side garbage collection, but GitHub says it will not remove non-sensitive data. The removed material is personal contact and workstation metadata, not a live credential, so Support may decline the request. If it does, the clean history needs to move to a new public repository while the old repository becomes private.

---

## 2026-07-12 - Add paywall previews and refresh source coverage

**What changed**: Added a publisher preview for articles labeled `Paywall
likely`. The collector reads only the publisher's ordinary unauthenticated
HTML, keeps at most two editorial paragraphs and 600 characters, removes
subscription and login prompts, and labels the text separately from generated
summaries in RSS, JSON, and the browser reader. Preview results and completed
checks persist in the article cache. Transient fetch failures retain the
one-day retry path, and legacy cache entries fetch a full response instead of
accepting an empty 304 during migration. Each run also revisits up to 25
recent archived paywall stories, so the existing reader history gains previews
without sending a large one-time request burst. Recognized publisher domains
do not fall back to arbitrary body paragraphs when no article body is present.

The source review added Burlington Free Press, The Rake Vermont, Poultney
Journal, Magic 96.7 Vermont News, The Vermont Cynic, and Stratton Magazine.
The revised list has 86 default rows. Town Meeting TV now uses its current
official YouTube Atom feed, and CNN Health uses CNN's current news sitemap.
The Times Ink was removed because its homepage, feeds, WordPress API, sitemap,
and robots.txt all returned HTTP 500, while its Google fallback returned no
items. The four stale TownNews category searches now use their current broad
article feeds. Fierce Healthcare's compact `11:00am` dates parse correctly.
Google News searches have local rolling date guards because live results
showed that Google can ignore a `when:` operator even when the query is
parenthesized.

**Decisions made**: The preview is an attributed lead excerpt, not a paywall
bypass or full-text mirror. The collector does not use authenticated sessions,
alternate user agents, AMP or cache copies, archive services, or embedded
full-article metadata. The outlet additions came from the [Seven Days Vermont
news outlet directory](https://www.sevendaysvt.com/news/vermont-news-outlets-directory/),
the [Vermont Press Association directory](https://www.vtpress.org/about-our-newspapers/),
and direct tests of each publisher's feed. WVMT was excluded because its feed
reposts WCAX links. WDEV remains out because its local news product is audio,
and the Guilford Gazette would need a PDF-specific ingestion path.

**Left off at**: All 90 tests passed. Every source file, the test file, and the
reader script parsed cleanly; `git diff --check` passed. A clean live run with
article scanning disabled fetched 85 active rows, skipped the closed 2026
backfill as designed, recorded zero hard failures, collected 1,771 bounded
source items, and wrote 155 matching stories. The generated RSS passed
`xmllint`, both JSON files parsed, and live unauthenticated preview probes
returned bounded text from Valley News, STAT, and a Wall Street Journal result.
A production-shaped smoke run against the live archive selected five archived
paywall stories, made five preview requests, found five bounded previews, and
published all five relevant previews in the public JSON feed.

**Open questions**: Fifteen valid search rows returned zero current items. The
list includes Burlington Free Press, twelve other site-scoped local outlets,
and the two broad Vermont and Blue Cross searches. Their endpoints worked, but
no result survived the 7-day or 30-day age guard. That is an honest empty
result rather than a source failure.

---

## 2026-07-02 - Reliability review sweep for v1.1.0

**What changed**: Full-app review pass focused on reliability. Dependencies:
cleared the high-severity undici advisory (`npm audit fix`) and bumped
`google-news-url-decoder` to 1.2.2. Fetch layer: `Retry-After` now parses the
HTTP-date form as well as delta-seconds; in-run retry sleeps are capped at 15s
(cooldowns still honor the full duration); HTTP 408 joined 429 as retryable;
response bodies decode via the `Content-Type` charset or the document's own
XML/HTML declaration instead of assuming UTF-8; `RSS_DOMAIN_DELAY_MS=0` and
`RSS_TOWNNEWS_DELAY_MS=0` now genuinely disable the politeness delay for local
runs. Enrichment: a no-match verdict recorded because the article fetch itself
failed now expires after one day instead of the 14-day negative-cache TTL, so
a transient 429/timeout can't suppress brand matching for two weeks.
Summaries: Gemini responses wrapped in markdown fences or lead-in prose are
salvaged before JSON.parse. Alerts: webhook posts get a 10s timeout. RSS
output: empty `<source url="">` elements are omitted and the channel
advertises `<ttl>60</ttl>`. Workflow: the archive seed step retries the
download and requires the payload to parse as JSON (with an `items` array)
before it replaces the checked-out archive, so a truncated download can't
shrink the live history. Reader: a failed `feed.json` load now offers a Retry
button. Audit size: the live feed-audit.json had grown to 19 MB (14.4 MB of
articleCache, 17k entries), re-downloaded and re-uploaded every hourly run.
Expired cache entries without ETag/Last-Modified validators are now dropped
at expiry instead of lingering an extra TTL window (only ~300 of 17k entries
actually carry validators), and the audit JSON is serialized compact instead
of pretty-printed (−2.6 MB immediately; roughly half the cache at steady
state). Releases: added `.github/workflows/release.yml` — pushing a `v*` tag
(or dispatching with a `tag_name` input, which creates the tag) publishes a
GitHub release, using `.github/RELEASE_NOTES.md` when its first line names
the tag. Version bumped to 1.1.0.

A follow-up 8-angle review pass over the branch diff caught and fixed three
bugs in the new code itself: a far-future Retry-After date could write a
years-long primary-feed cooldown into the persisted audit (now capped at
24h); digit-leading date forms ("2026-07-05T…") misparsed as delta-seconds
(now only all-digit values do); and a mislabeled `charset=iso-8859-1` header
on real UTF-8 bytes produced mojibake (bytes that validate as UTF-8, or carry
a BOM, now win over the declared charset). Retries that can't honor a long
Retry-After within the 15s cap now give up in-run instead of hammering the
server early. Also deduplicated the webhook/parser helpers and guarded
release notes against being reused by a future tag.

**Decisions made**: Kept the error-entry TTL a constant (1 day) rather than a
new env var. Investigated the recurring HTTP 415s from Charlotte News and The
Times Ink: both return 200 with identical headers from outside GitHub's
runners, so they are IP-reputation blocks, not header bugs — the existing
fallback + cooldown path is the right handling. Left the seed step's
soft-fallback to the committed archive in place (first-run bootstrap needs
it) but made the failure a workflow warning annotation.

**Left off at**: `npm test` passed with 70 tests (9 new), `node --check` clean
on all src files, `xmllint --noout` validated a generated feed, and an
offline pipeline smoke (`generateFeed({ sources: [] })` against a copy of the
live audit JSON) exercised archive → relevance → outputs with zero network.

**Open questions**: The v1.1.0 release itself must be cut after merge — this
session's sandbox cannot push tags (proxy returns 403). One click: Actions →
Release → Run workflow with `tag_name: v1.1.0`.

---

## 2026-06-22 - Bump upload-pages-artifact to v5; fix sibling bcbs-rss Pages

**What changed**: Bumped `actions/upload-pages-artifact` from `@v4`
(SHA `7b1f4a76`) to `@v5.0.0` (SHA `fc324d35`) in `publish-feed.yml`. v5
updates the bundled `actions/upload-artifact` to v7, clearing the Node 20
deprecation warning that was annotating every run. Most of the session was
spent on the separate `bcbs-rss` repo (the BCBS Be Well VT blog
RSS, a sibling project to this news monitor), whose weekly "Publish RSS Site"
run had been failing since 2026-06-08.

**Decisions made**: Root cause on bcbs-rss was not a workflow bug: it is a
private repo on a Free GitHub plan, and GitHub Pages requires a paid plan for
private repos (the `POST /pages` API returned "Your current plan does not
support GitHub Pages for this repository"). The repository was made public
rather than moving it to a paid plan or retiring it, matching this repository's
already-public posture. Pinned to the immutable v5 commit SHA with a
`# v5.0.0` comment rather than the floating `@v5` tag, consistent with this
repo's existing SHA-pin style.

**Left off at**: This repo: run #318 (push of 5e5ba4f) completed `success`
with 0 annotations on both jobs; full generation ran end to end in 3m24s, so
v5 is compatible with `deploy-pages@v5`. bcbs-rss: made public, Pages enabled
with `build_type: workflow`, same v5 bump committed (4e0748b); runs #25 and #26
both green with 0 annotations; site live at https://oliverames.github.io/bcbs-rss/.

**Open questions**: None. bcbs-rss is now publicly visible (code + history).
Ran `gitleaks detect` over its full 16-commit history: 1 finding, a confirmed
false positive (an `hkey=` query param in a third-party URL inside published
blog content in the generated `site/feed.rss`, which is now gitignored). No
real secrets exposed.

---

## 2026-06-18 - Expand Vermont local source coverage

**What changed**: Expanded `DEFAULT_SOURCES` from 39 to 81 rows by adding the missing Vermont Press Association and community-news outlets requested in the coverage audit. Used direct RSS or outlet search feeds where available, including Caledonian-Record, Barton Chronicle, Journal Opinion, Brandon Reporter, Charlotte News, County Courier, Hardwick Gazette, Hinesburg Record, Vermont Journal/The Shopper, The Bridge, The Islander, White River Valley Herald, Times Ink, Valley Reporter, Deerfield Valley News, Vermont Standard, Community News Service, Chester Telegraph, Newport Dispatch, Town Meeting TV, and iBrattleboro. Added site-scoped Google News sources for outlets with no reliable feed or stale/no-content web surfaces, including The Commons, The World, North Avenue News, Lakeside News & The Rutland Sun, Eagle Times, Vermont News Guide, Addison Eagle, Northfield News, Lakes Region Free Press, Mountain Gazette, Waterbury Roundabout, Cabot Chronicle, and East Montpelier Signpost.

**Decisions made**: Kept Vermont Journal and The Shopper as one source because the publisher exposes one combined feed. Used the Springfield Vermont News Blogspot RSS feed for the Springfield Reporter surface because the current Reporter web presence is subscription/Facebook oriented. Avoided directly fetching the Northfield News domain after the probe returned unrelated spam HTML, and covered it only through a site-scoped Google News search. Added the new TownNews-style sources to the shared `townnews-search` throttle group to preserve politeness and avoid recurring 429s.

**Left off at**: `npm test` passed with 61 tests, `node --check src/*.js test/index.test.js` passed, and a live-seeded scratch generate to `/tmp/vt-news-expanded-sources.XAONwM` with `RSS_ARTICLE_SCAN=false` fetched 81 source rows with zero failures. Only the closed Jan. 1-June 13 backfill source skipped as designed; the run wrote 318 audit items and 223 visible public items, and `xmllint --noout` validated the generated RSS.

**Open questions**: Some Google-only sources returned zero current search items. That is expected for stale, static, or lightly indexed local outlets, but the source rows are now present so any future Google-indexed health/Blue Cross results can be collected.

---

## 2026-06-16 - Harden crawling, caching, and deploy mode

**What changed**: Added persisted audit-only crawl state with per-source feed validators, primary-feed cooldowns, article-cache entries, and crawl metrics. Primary feeds with fallbacks now cool down after repeated 403/429/other failures instead of hammering a known-bad URL every run. Fetches now preserve `ETag` and `Last-Modified` headers and can handle 304 not-modified responses. Article enrichment now uses selective scan modes, skips no-signal article fetches, caches negative no-match decisions for a bounded TTL, and has domain-specific article text selectors for priority outlets. The publish workflow now distinguishes full feed-generation pushes from static-only site/docs pushes so static reader changes can deploy without recrawling every source.

**Decisions made**: Kept crawler state out of the public JSON feed and stored it only in `feed-audit.json`. Left the existing matched-item archive cache as the first positive cache layer so old summaries and accepted items continue to work. Used `smart` as the default article scan mode: fetch article pages only when feed text, topic text, search fallback metadata, or brand-required metadata gives the item a reason to be worth scraping. Kept source cooldown durations conservative: 24 hours for 403, `Retry-After` or two hours for 429, and one hour for other primary-feed errors.

**Left off at**: `npm test` passed with 61 tests, `node --check src/*.js test/index.test.js` passed, and `git diff --check` passed. A live-seeded scratch generate to `/tmp/vt-news-crawl.Ss6UhL` with `RSS_ARTICLE_SCAN=false` loaded 414 prior live items, fetched 39 configured sources with zero failures, skipped only the closed Jan. 1-June 13 backfill source, wrote 417 audit items and 286 public items, produced a well-formed RSS feed via `xmllint --noout`, and verified that crawler state/metrics are present in audit JSON but absent from public `feed.json`.

**Open questions**: None. The first production run with this commit should populate source cooldown state for any primary feeds blocked specifically on GitHub runners; the local scratch run did not hit those runner-only 403/429 cases.

---

## 2026-06-16 - Disable social collection, add article comments and icons

**What changed**: Parked the built-in Facebook/social sources behind `ENABLE_SOCIAL_SOURCES=true` and made env-configured Facebook post/page URLs inactive unless that flag is set. Archived Facebook/social items are now pruned when social collection is disabled, so old social posts do not carry forward from the live audit cache. Added conservative article comment extraction from server-rendered comment sections and JSON-LD `Comment` objects, then merged those comments into already-identified news items during enrichment. Added favicon, Apple touch icon, and web manifest icons generated from the provided BCBS profile asset.

**Decisions made**: Kept the existing Facebook parsers and reader Social fallback instead of deleting them, so a deliberate one-off social run remains possible with `ENABLE_SOCIAL_SOURCES=true`. Article comments enrich matched stories but do not create new relevance matches by themselves. Used the profile image directly for browser/iPhone assets because it is already square and brand-ready.

**Left off at**: `npm test` passed with 55 tests, `node --check test/index.test.js` and `node --check src/*.js` passed, `git diff --check` passed, `site/site.webmanifest` parsed as JSON, and ImageMagick verified the generated icon sizes (`16x16`, `32x32`, `180x180`, `192x192`, and `512x512`). A live-seeded scratch generate to `/tmp/vt-news-rss-bcbs-social-off*` with article scanning off loaded 168 archived items, wrote 278 audit items and 205 public items, and returned zero Facebook/social sources or items in both public and audit JSON. Implementation commit `a29ac13` was pushed to `main`; publish run `27643286441` had passed setup, install, tests, and archive seeding and was still in the live `Generate feed` step when wrap-up began.

**Open questions**: Live article-comment capture depends on each publisher rendering comments in the fetched article HTML. Iframe-only or client-rendered comment systems will not expose comments to this parser.

---

## 2026-06-16 - Reduce recurring source failures

**What changed**: Added per-source feed fallbacks so a blocked or rate-limited primary RSS feed can still collect through a site-scoped Google News search. Vermont Business Magazine and The Mountain Times keep their direct feeds as primary sources, but now fall back to Google News if the GitHub runner gets a 403. The TownNews search feeds also fall back to Google News when they hit 429. Added a shared `townnews-search` throttle group for the Rutland Herald, Times Argus, Bennington Banner, Brattleboro Reformer, VTCNG, Newport Daily Express, and St. Albans Messenger search feeds, with `RSS_TOWNNEWS_DELAY_MS` defaulting to eight seconds.

**Left off at**: `npm test` passed with 51 tests, `node --check src/fetching.js src/sources.js test/index.test.js` passed, and `git diff --check` passed. A live-seeded scratch generate to `/tmp/vt-news-failures.QfXfH0` with article scanning off loaded 390 prior live archive items, fetched all 45 sources with zero failures, wrote 393 audit items and 272 public items, produced a valid RSS feed via `xmllint --noout`, and returned zero obituary hits. A forced-403 check against the configured Vermont Business Magazine and The Mountain Times primary feeds proved both fall back to `news.google.com` and stay `ok: true`. After the next scheduled run showed fresh 429s from Times Argus and VTCNG, a forced-429 check verified every TownNews source also falls back to `news.google.com` and stays `ok: true`.

**Open questions**: The direct Vermont Business Magazine and Mountain Times feeds return 200 locally, so this targets the repeated GitHub Actions runner blocks shown in the live audit rather than a universal feed outage.

---

## 2026-06-16 - Exclude obituaries from collection and archive

**What changed**: Added a shared obituary exclusion filter that catches RSS obituary categories, obituary/death-notice URL and title patterns, and narrow obituary prose such as `passed away`, funeral-home/service language, celebration-of-life, and memorial-service wording. Feed parsers now preserve RSS/Atom categories as `sourceCategories` for filtering without adding category text to matcher evidence. The filter runs before source item bounds and again while loading the durable audit archive, so newly fetched obituaries are not collected and previously cached obituaries are purged on the next generation.

**Left off at**: `npm test` passed with 50 tests, `node --check src/*.js` passed, and `git diff --check` passed. A live-seeded scratch generate to `/tmp/vt-news-obits-final.5tWr6N` with article scanning off loaded 390 prior live archive items, wrote 393 audit items and 272 public items, produced a valid RSS feed via `xmllint --noout`, and returned zero public/audit obituary hits. Known live obituaries (`David Jon Bursey, 77, of Monkton`, `Michael Ray Jensen, 54, of Brandon`, and `Obituary: Dieter Gump, 1933-2026`) were absent from the generated public and audit JSON.

**Open questions**: None.

---

## 2026-06-16 - Align source searches with Kristina's Boolean list

**What changed**: Added Kristina's current Boolean search set directly to the Google News source queries: Blue Cross/BCBS variants paired with VT or Vermont, Vermont healthcare/health care/hospitals, health insurers, health care affordability, UVM Health, and MVP Health Care. Tightened local brand matching so `BCBS ... Vermont`, `BlueCross ... Vermont`, and `Blue Cross and Blue Shield ... Vermont/VT` are classified as Blue Cross VT evidence instead of relying only on search fallback. Documented the Boolean coverage in the README and added regression tests for source-query coverage and matcher behavior.

**Left off at**: `npm test` passed with 46 tests, `node --check src/*.js` passed, `git diff --check` passed, and the explicit Boolean comparison script returned YES for all 18 provided Boolean queries. A scratch live generate to `/tmp/vt-news-booleans.u0uqqb` with article scanning off fetched all 45 sources without failures, skipped only the closed Jan. 1-June 13 backfill source, wrote 277 audit items, 203 visible public items, and produced a well-formed RSS feed via `xmllint --noout`.

**Open questions**: None.

---

## 2026-06-13 - Apply branded README style

**What changed**: Reworked the public README around the `ames-writing:readme-style` structure: centered project mark, badges, strategic "Why This Exists" framing, quick start, source coverage, matching and relevance behavior, reader experience, configuration, architecture, and development commands. Added `site/readme-icon.svg` as a small local header mark so the README does not depend on a missing external asset.

**Decisions made**: Used a "license not specified" badge rather than inventing a license file. Kept the README factual to the current implementation: 45 configured sources, GitHub Actions doing the hourly crawl, browser-side reader filtering only, BlueCrossVT.org/social hidden from All by default, direct Blue Cross VT mentions retained indefinitely, and the Jan. 1 through June 13, 2026 backfill carried by the audit archive after the bounded source closes.

**Left off at**: `npm test` passed with 45 tests, `node --check src/*.js` passed, `git diff --check` passed, README local asset and source count checks passed, and the link check confirmed the repository, status badges, and live reader. The commit `6fbf24d` was pushed to `main`; publish run `27466251060` built in 6m7s and deployed successfully.

**Open questions**: None.

---

## 2026-06-12 - Clear the review backlog: alerts, parallel fetch, module split

**What changed**: Implemented the remaining items from the morning hardening review. Webhook alerts now gate on per-source consecutive-failure streaks (`WEBHOOK_FAILURE_THRESHOLD`, default 24) persisted in the audit JSON's sources array, which doubles as source-rot visibility; the Gemini prompt marks article text as untrusted. Date-bounded sources are skipped automatically once `maxPubDate` passes, so the 2026 backfill search retires itself on June 13 with no scheduled cleanup. Snippet centering now blanks `strip` regions with same-length whitespace so it cannot center on transport idioms the matcher ignored. Sources fetch concurrently (`RSS_SOURCE_CONCURRENCY`, default 4) with results assembled in source order, and the per-domain throttle was rebuilt as a promise chain that cannot race; source-level and Facebook post fetches now throttle too. All five actions are SHA-pinned with tag comments, and a standalone `test.yml` runs the suite on pull requests. Finally, split the 3,181-line `src/index.js` into eleven flat modules plus a barrel `index.js` that keeps `generateFeed`, `main`, and explicit re-exports, so test imports and `npm run generate` are unchanged.

**Decisions made**: Auto-skip beats a calendar reminder for the backfill source: the window stays open through its last day and the mechanism generalizes. Alert exactly at the threshold crossing (once per outage) rather than repeatedly during an outage. Keep the module split purely mechanical and last in the commit sequence so functional diffs stayed reviewable; bodies were extracted verbatim by line range with a Python splitter, with only import headers authored. Skipped Dependabot again (two stable deps; recurring PR noise outweighs benefit) and left the committed `site/feed.*` artifacts, the Chrome UA, and the Facebook parsing approach as they are.

**Left off at**: 45 tests pass, `node --check` on all twelve `src/*.js` files, offline `generateFeed` smoke through the seeded archive (169 items merged, RSS well-formed, JSON valid), and two live-network generates to `/tmp` (45/45 sources ok, zero failures, 238 then 246 items) — one before the split on the parallel-fetch commit, one after the split. Both workflows parse as YAML.

**Open questions**: The throttle's promise-chain behavior is verified structurally and by the live runs, not by a dedicated unit test; a timing test would be flake-prone. Revisit if politeness complaints ever surface.

**Post-deploy finding**: The first CI run on these changes built in 9:10 versus ~2:15 for prior runs. Source collection itself dropped to 17 seconds (parallel fetching works); the added time is article scanning, because the old racy throttle never actually enforced its 1-second per-domain delay under concurrency, and the fixed one does. Prior runs were fast by accident of broken politeness. 9 minutes is comfortable against the hourly cadence and 30-minute timeout, so the delay stays at 1s, now tunable via `RSS_DOMAIN_DELAY_MS`. The deeper inefficiency, re-fetching article pages for items that did not match on earlier runs (only matches are cached), is a candidate for a negative-result cache with a TTL if run length ever becomes a problem. Source failures after the burst of runs: Vermont Business Magazine and The Mountain Times return HTTP 403 (streak 3 by end of day; if these persist toward the threshold it is durable bot-blocking, not noise), and the TownNews-platform outlets (Times Argus ×2, VTCNG, Newport Daily Express, St. Albans Messenger) returned clustered HTTP 429s from shared rate limiting after ~5 generates in two hours; those should clear at the normal hourly cadence. The streak counters in the live audit are the dashboard for both.

---

## 2026-06-12 - Harden fetch, workflow, and reader; fix site title

**What changed**: Changed the site title and h1 from `Blue Cross VT : News Mentions` to `Blue Cross VT: News Mentions`. Added a decompressed response size cap to all generator fetches (`RSS_MAX_RESPONSE_BYTES`, default 10 MB) with a non-retryable error path so an oversized body is not re-downloaded three times. Guarded the reader's `hashParam` against malformed percent-encoding that previously threw `URIError` and broke rendering on hashchange. Added `timeout-minutes` to both workflow jobs, `persist-credentials: false` on checkout, and `--max-time 60` on the archive seed curls. Refreshed the README source table to match `DEFAULT_SOURCES` (added BCBSA Association News, Vermont Daily Chronicle, St. Albans Messenger, ABC/CBS/CNN health feeds, the backfill and Kristina Google News searches) and documented `RSS_MAX_RESPONSE_BYTES`, `SUMMARY_REJUDGE_ALL`, `SLACK_WEBHOOK_URL`, and `DISCORD_WEBHOOK_URL`.

**Decisions made**: Count the size cap against decompressed bytes by reading the response stream, which also covers compression bombs; decode accumulated bytes with `TextDecoder` to match `response.text()` UTF-8 semantics. Cap build at 30 minutes because runs are serialized (`cancel-in-progress: false`) and GitHub's 360-minute default would let one hung run back up six hourly runs. Left feed channel titles (`Blue Cross VT News Mentions`, no colon) unchanged; only the reader page title used the spaced colon. Skipped Dependabot (two stable deps, solo project, recurring PR noise outweighs benefit) and kept serial source fetching (politeness and simplicity; runtime is not a constraint on the hourly schedule).

**Left off at**: `npm test` passed with 41 tests (40 existing plus a new `readResponseTextWithLimit` test), `node --check src/index.js` passed, workflow YAML parsed, and the local preview verified the new title, 25 rendered stories, zero console errors, and intact rendering with a mangled `#page=%` hash.

**Open questions**: None.

---

## 2026-06-12 - Add reader search, multiselect sections, and brand archive retention

**What changed**: Added a browser-side search field, replaced single section links with plain checkbox multiselect controls, moved pagination to the bottom only, and changed the footer divider to match the tricolor reader rule. Updated archive retention so direct Blue Cross VT mentions stay indefinitely while topic-only Vermont health care stories keep the rolling window. Simplified the dateline to user-facing "refreshed hourly" copy and removed the story-count language.

**Decisions made**: Keep source collection and summarization server-side in GitHub Actions because browser-side crawling would expose secrets and run into cross-origin limits. Put browser-side work where it fits: reader filtering, section toggles, search, and pagination. Keep BlueCrossVT.org and social posts available but off by default.

**Left off at**: `npm test` passed with 37 tests, `node --check src/index.js`, `git diff --check`, static site script parsing, local Playwright, and live Playwright verification passed. GitHub Actions runs `27441377646` and `27441758972` both deployed successfully. Live page verified with default checked sections `Blue Cross VT (16)` and `VT Health Care (98)`, optional unchecked sections `BlueCrossVT.org (19)` and `Social posts (1)`, bottom-only pager, visible search, no GitHub Actions copy in the reader, and tricolor footer rule.

**Open questions**: None.

---

## 2026-06-12 - Refine reader defaults and relevance outputs

**What changed**: Split the public JSON feed from the full audit/cache JSON, added a three-month rolling archive, paginated the text reader at 25 stories, moved the article date into the meta line above each headline, added access labels, collapsed comments by default, and hid BlueCrossVT.org plus social/Facebook posts from the default All view while keeping them available as sections. Tightened national relevance filtering, removed keyword clutter from public surfaces, added BlueCrossVT.org newsroom/blog listings, and deduped Google News wrappers when the originating outlet article exists.

**Decisions made**: Keep `feed.json` reader-safe and put rejected/cache details in `feed-audit.json`. Preserve a text.npr.org-style reader: simple links, sections, newest-first order only, and minimal controls. Treat BlueCrossVT.org and social posts as opt-in sections because they are useful audit/context sources but too noisy for the default feed.

**Left off at**: `npm test` passed with 37 tests, `node --check src/index.js`, `git diff --check`, site script syntax check, and `xmllint --noout site/feed.rss` passed. Local Playwright verified 25 rendered stories, `1-25 of 116 Older` pagination, no keyword/matched/posting clutter, source/social hidden from All, comments collapsed in the Social section, and date/source/access displayed above headlines. GitHub Actions run `27440191807` passed and deployed to GitHub Pages.

**Open questions**: None. Access labels are heuristic by domain and should be revisited if a source changes its paywall behavior.

---

## 2026-06-12 - Expand BCBS VT news monitor coverage

**What changed**: Expanded the news monitor from a narrow BCBS mention feed into a broader Blue Cross VT and Vermont health care monitor. Added News Export-driven coverage patterns, broader keyword aliases, JSON Feed output, nested Facebook comment extraction, configured Facebook post/page sources, future-date filtering, archive revalidation, conservative Gemini batching controls, and refreshed generated feeds.

**Decisions made**: Use the colleague news export as a coverage reference without storing full article bodies; keep summaries, inclusion reasons, matched keywords, and source links as the durable output. Treat Facebook page scanning as public post discovery, then enrich discovered posts from public post pages when available. Keep Gemini usage conservative by starting with `gemini-2.5-flash-lite`, caching successful summaries, batching requests, and capping requests per run.

**Left off at**: `npm test`, `node --check src/index.js`, `git diff --check`, and `npm run generate` passed. The generated JSON has 98 items, no future-dated items, no known product-marketing false positives, Facebook content with nested comments, Vermont Public coverage, and Burlington Free Press coverage.

**Open questions**: None for the shipped implementation. Facebook may change no-login HTML behavior over time, so configured public post URLs remain the most reliable Facebook path.

---
