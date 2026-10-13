# ☁️ Cloudflare Hosting and Crawler Migration Plan

*Research and implementation plan for `vt-news-rss-bcbs`.*
*Last updated: July 21, 2026*

## Executive Summary

The recommended first step is to host the generated reader and feeds directly on Cloudflare at `https://amesvt.com/vt-news-rss-bcbs/` while retaining GitHub Pages as a working secondary copy. The existing GitHub Actions workflow should continue running the crawler hourly and deploy the same generated artifact to both destinations.

Moving the crawler itself to Cloudflare is also feasible, but it is a separate application migration. It would require Workers Paid, an hourly Cron Trigger, persistent state in R2, overlap protection, runtime compatibility work, and a synchronization mechanism if the GitHub Pages copy should continue receiving hourly updates.

**Recommended decision:** Complete Cloudflare hosting first. Evaluate Cloudflare-native crawling only after the dual-host deployment is stable.

## Goals

- Make `https://amesvt.com/vt-news-rss-bcbs/` the preferred public address.
- Host the HTML, icons, RSS feed, JSON feed, and audit data on Cloudflare.
- Keep `https://oliverames.github.io/vt-news-rss-bcbs/` available for now.
- Preserve the existing hourly crawler, archive retention, source cooldowns, summaries, and alerts.
- Avoid coupling the hourly news deployment to the separate `amesvt-website` deployment.
- Keep credentials out of the repository, generated artifacts, logs, and documentation.

## Verified Current State

**GitHub Pages:** The repository publishes `site/` through `.github/workflows/publish-feed.yml`. GitHub Pages has no custom domain configured.

**Schedule:** The workflow runs at minute 17 of every hour, on pushes to `main`, and on manual dispatch. Scheduled and manual executions perform a full crawl and generation pass.

**Archive:** `site/feed-audit.json` is both the durable archive and the summary cache. The workflow seeds it from the currently published feed before generating the next version.

**Reader behavior:** `site/index.html` loads `feed.json` with a relative URL. Icons, RSS links, and JSON Feed links are also relative, which makes the reader compatible with subdirectory hosting.

**Generated metadata:** The current workflow sets `SITE_URL` to the GitHub Pages address. This causes the RSS and JSON Feed metadata to advertise GitHub as the public home.

**Cloudflare:** `amesvt.com` is an existing Cloudflare Pages site. The requested path currently falls through to that site's single-page application behavior and returns the utilities homepage with HTTP 200. No zone-level Workers Routes were configured when this research was performed.

**Artifact size:** The complete `site/` directory is currently about 896 KB. The largest file is `feed-audit.json` at about 353 KB. This is comfortably suited to Workers Static Assets and, if the crawler later moves, R2.

## Phase 1: Host the Generated Site on Cloudflare

### Architecture

```text
GitHub repository
      |
      v
Hourly and push-triggered GitHub Actions workflow
      |
      +--> Crawl sources and generate site/ once
      |
      +--> Deploy the artifact to GitHub Pages
      |
      +--> Deploy the same artifact to Cloudflare Workers Static Assets
                    |
                    v
          amesvt.com/vt-news-rss-bcbs/
```

### Cloudflare Deployment Shape

Create a dedicated Worker with Static Assets for this repository. Its asset directory should mirror the requested path:

```text
cloudflare-dist/
└── vt-news-rss-bcbs/
    ├── index.html
    ├── feed.json
    ├── feed.rss
    ├── feed-audit.json
    ├── site.webmanifest
    └── icons and other static files
```

Configure two narrow routes so the Worker owns only the requested location:

- `amesvt.com/vt-news-rss-bcbs`
- `amesvt.com/vt-news-rss-bcbs/*`

The exact route should redirect to the trailing-slash URL. The wildcard route should serve the nested static assets. Requests outside this path must continue to reach the existing `amesvt.com` Pages project.

Cloudflare documents this nested-directory approach specifically for serving Workers Static Assets from a subdirectory: [Serving a subdirectory](https://developers.cloudflare.com/workers/static-assets/routing/advanced/serving-a-subdirectory/).

### Workflow Changes

1. Preserve the existing crawl and generation steps.
2. Stage the generated `site/` contents beneath `cloudflare-dist/vt-news-rss-bcbs/`.
3. Upload one immutable build artifact for both deployment jobs.
4. Keep the existing GitHub Pages deployment.
5. Add a Cloudflare deployment using a pinned Wrangler version.
6. Deploy Cloudflare last because it will be the preferred public destination.
7. Verify the Cloudflare reader and feed endpoints before reporting success.

The Cloudflare deployment must use a narrowly scoped deployment credential supplied through GitHub Actions secrets. No credential value or account-specific identifier should be committed to the repository.

### Public URL and Feed Metadata

After the Cloudflare route is live and verified, set the generator's public site URL to:

```text
https://amesvt.com/vt-news-rss-bcbs
```

The existing output code will derive the RSS and JSON Feed URLs from this value. Update the archive seed order to:

1. Cloudflare `feed-audit.json`
2. Cloudflare `feed.json`
3. GitHub Pages `feed-audit.json`
4. GitHub Pages `feed.json`
5. The committed archive as the final fallback

This preserves the current safety behavior if either public host is temporarily unavailable.

Add a canonical link to the reader identifying the `amesvt.com` URL as preferred. The same HTML may continue to be served at GitHub Pages, but search engines will receive one canonical address.

### Why This Should Not Deploy Through `amesvt-website`

The news feed updates hourly, while the `amesvt-website` repository owns the utilities homepage and Matrix discovery files. Having two repositories deploy independently to the same Pages project would create a race in which one deployment could replace files published by the other.

A dedicated static-assets Worker and narrow path routes avoid that coupling. The existing `amesvt-website` project does not need to be edited or redeployed for routine news updates.

## Phase 2: Optionally Move Crawling to Cloudflare

### Architecture

```text
Cloudflare Cron Trigger, hourly
      |
      v
Crawler running in a paid Worker
      |
      +--> Fetch source feeds and eligible articles
      +--> Generate summaries when configured
      +--> Merge archive and summary cache
      |
      v
R2 bucket
      ├── feed.json
      ├── feed.rss
      └── feed-audit.json
      |
      v
Public Worker response at amesvt.com/vt-news-rss-bcbs/
```

The static reader and icons can remain Workers Static Assets. The changing feeds and archive should be read from R2 by the public Worker.

### Required Code Changes

**Persistent storage:** Replace persistent `node:fs` reads and writes with R2 object operations. Cloudflare's virtual filesystem supports temporary files, but those files do not persist between invocations. See [Cloudflare Workers filesystem](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/).

**Entrypoint:** Convert the command-line generator into a reusable function called by a Worker's scheduled handler.

**Configuration:** Replace direct dependence on process-level environment variables with an explicit configuration object populated from Worker variables and secrets.

**Output layer:** Separate string generation from file persistence. The output module should return RSS, JSON Feed, and audit strings that either the local command or the R2 adapter can store.

**Archive layer:** Add an R2-backed archive adapter that reads the previous audit object and writes the new objects only after a successful crawl.

**Atomic publication:** Generate and validate all three outputs before changing the public objects. Use temporary object keys or versioned keys followed by a small current-version pointer so readers cannot observe a partially updated set.

**Overlap protection:** Prevent two scheduled crawls from updating the archive concurrently. Use a Durable Object coordinator, or another tested lease mechanism with clear expiration and recovery behavior.

**Runtime compatibility:** Test Cheerio, the Google News URL decoder, Node compatibility, response decoding, timers, and bundle size under the deployed Workers runtime.

**Observability:** Record crawl start and finish times, source failures, item counts, output version, R2 publication status, wall time, CPU time, and the scheduled invocation outcome.

### Cron Trigger or Workflow

Start with a normal hourly Cron Trigger if the migrated crawler completes reliably within the platform limits. Cloudflare currently allows a 15-minute wall time for scheduled Workers. The existing GitHub Actions runs have generally completed in roughly four minutes of wall time, much of which is network waiting and deliberate throttling.

Cloudflare Workflows would be appropriate only if the crawl needs durable multi-step retries, long pauses, or recovery across separate stages. It adds operational complexity and is not required for the initial migration.

### Plan Requirement

The current crawler has 86 default sources before article scans and summary requests. The Workers Free plan allows only 50 external subrequests per invocation and 10 milliseconds of CPU time. The complete crawler therefore requires Workers Paid unless it is substantially decomposed across queues or workflows.

Workers Paid currently includes 10 million monthly requests, 30 million CPU milliseconds, and up to 10,000 subrequests per invocation by default. Current limits are documented at [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/).

### Keeping GitHub Pages Current

Once Cloudflare performs the crawl, GitHub Pages will not receive new feed files automatically. Choose one mirror strategy before switching off the GitHub-hosted crawler:

1. Keep a lightweight hourly GitHub Action that downloads the validated Cloudflare outputs and republishes GitHub Pages.
2. Have Cloudflare request a GitHub mirror deployment only after a successful R2 publication.
3. Allow GitHub Pages to remain available but no longer promise hourly freshness.

The first option is the simplest while the GitHub Pages URL remains an active secondary copy. It removes duplicate crawling but preserves the existing mirror.

## Cost Estimate

### Cloudflare Hosting Only

Workers Static Assets requests are free and unlimited, and Cloudflare does not charge separately for storing the deployed assets. Expected incremental cost: approximately $0 per month. See [Static Assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

### Cloudflare Hosting and Hourly Crawling

Workers Paid currently has a $5 monthly minimum. It includes 10 million requests and 30 million CPU milliseconds per month. Waiting for network responses does not count as CPU time. Current pricing is documented at [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

With 720 hourly runs in a 30-day month, the included CPU allowance averages about 41.7 seconds of active CPU per crawl.

| Active CPU per crawl | Estimated monthly Workers total |
|---:|---:|
| 30 seconds | $5.00 |
| 45 seconds | $5.05 |
| 60 seconds | $5.26 |
| 3 minutes | $6.99 |
| 4 minutes | $7.86 |

The current four-minute GitHub Actions duration is wall time, not active CPU time. Because the crawler spends significant time waiting on external sources and intentional delays, the likely Cloudflare total is close to $5 per month. Budgeting $8 per month provides a conservative ceiling until production CPU measurements exist.

### R2

R2 Standard includes 10 GB-month of storage, one million Class A operations, 10 million Class B operations, and free Internet egress each month. The current dataset is under 1 MB. Four writes per hourly run would total only 2,880 monthly writes, so expected R2 cost is $0. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/).

### Other Services

Gemini usage remains a separate Google service cost. The migration should preserve the current batching, request cap, and summary cache so hosting changes do not increase summary usage unexpectedly.

## Security and Credential Handling

- Store deployment credentials only in the CI secret store.
- Store runtime credentials only as encrypted Worker secrets.
- Use the least-privileged Cloudflare token that can deploy this Worker and manage only its required bindings and routes.
- Do not place credential values, credential references, account identifiers, request headers, or secret-bearing command output in tracked files.
- Do not forward visitor cookies or authorization headers to external origins.
- Keep secrets out of Wrangler configuration files, generated feeds, audit output, test fixtures, and logs.
- Validate that no credential-like values appear in the final diff before committing.

## Implementation Sequence

### Phase 1 Checklist

- [ ] Add a test fixture representing the nested Cloudflare asset layout.
- [ ] Add a pinned Wrangler development dependency and validated configuration.
- [ ] Configure exact and wildcard routes for the requested path only.
- [ ] Add a build step that stages `site/` beneath the matching path.
- [ ] Validate trailing-slash behavior and missing-file behavior locally.
- [ ] Add a Cloudflare deployment job that consumes the same build artifact as GitHub Pages.
- [ ] Add the scoped deployment credential through the CI secret store.
- [ ] Perform the initial Cloudflare deployment without changing feed metadata.
- [ ] Verify the Cloudflare reader, feeds, icons, manifest, search, and cache validators.
- [ ] Change the public site URL and archive seed order.
- [ ] Add the canonical URL and update repository documentation.
- [ ] Verify both public hosts after a scheduled crawl.

### Phase 2 Checklist

- [ ] Refactor the crawler into runtime-neutral collection and generation functions.
- [ ] Add local filesystem and R2 storage adapters behind the same interface.
- [ ] Add Worker-compatible configuration injection.
- [ ] Add an hourly scheduled handler.
- [ ] Add atomic, versioned R2 publication.
- [ ] Add overlap protection and failure recovery.
- [ ] Test external-request count, CPU time, memory, wall time, and bundle size.
- [ ] Run GitHub Actions and Cloudflare crawling in comparison mode without publishing Cloudflare results.
- [ ] Compare item selection, summaries, source failures, and output bytes across several runs.
- [ ] Switch the public feed to R2 only after parity is demonstrated.
- [ ] Replace GitHub's crawl with a mirror-only deployment if the old URL must remain current.

## Verification Plan

### Before Deployment

- Run the complete Node test suite.
- Validate every JavaScript source file.
- Run a Wrangler dry-run and inspect the resolved routes, bindings, compatibility date, bundle size, and asset count.
- Confirm the route configuration cannot match sibling `amesvt.com` paths.
- Scan the diff and staged artifact for credential patterns and unintended files.

### After Phase 1 Deployment

- Confirm `https://amesvt.com/` still serves the utilities homepage.
- Confirm both Matrix discovery endpoints are unchanged.
- Confirm `/vt-news-rss-bcbs` redirects to `/vt-news-rss-bcbs/`.
- Confirm the reader loads stories from the Cloudflare-hosted `feed.json`.
- Confirm RSS, JSON Feed, audit JSON, icons, and manifest return correct content types.
- Confirm cache validators and conditional requests work.
- Confirm the GitHub Pages URL remains available.
- Confirm the next scheduled GitHub Actions run updates both hosts with matching output.

### After Phase 2 Deployment

- Confirm the scheduled invocation runs once per hour.
- Confirm the crawler completes below the wall-time, CPU, memory, and subrequest limits.
- Confirm the previous archive is loaded from R2 and retained correctly.
- Confirm a failed crawl does not replace the last known-good public feed.
- Confirm overlapping or manually triggered runs cannot corrupt state.
- Confirm alert thresholds and source cooldowns behave exactly as they did under GitHub Actions.
- Confirm the GitHub Pages mirror receives the same validated outputs if hourly freshness is still promised.

## Rollback

### Phase 1

Remove or disable only the two narrow Worker routes. The existing `amesvt.com` Pages project will resume handling the path with its prior fallback behavior. GitHub Pages remains the live fallback throughout the migration.

### Phase 2

Keep the GitHub Actions crawler workflow intact until Cloudflare parity and reliability are demonstrated. If the Cloudflare crawler fails, restore GitHub Actions as the hourly publisher and redeploy the most recent known-good `site/` artifact to Cloudflare.

Do not delete the R2 archive during rollback. Preserve it for diagnosis and as a possible recovery source.

## Decision Points

Before Phase 1 implementation:

- Decide whether the news reader should inherit the current `amesvt.com` `noindex, nofollow` posture or be independently indexable.
- Confirm that `amesvt.com` should be canonical while GitHub Pages remains accessible.

Before Phase 2 implementation:

- Confirm acceptance of the Workers Paid minimum charge.
- Decide how fresh the GitHub Pages mirror must remain.
- Decide whether a normal Cron Trigger is sufficient or whether durable Workflows behavior is required.
- Define the maximum acceptable monthly spend and configure CPU and usage safeguards accordingly.

## Official References

- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Serving Static Assets from a Subdirectory](https://developers.cloudflare.com/workers/static-assets/routing/advanced/serving-a-subdirectory/)
- [Workers Routes](https://developers.cloudflare.com/workers/configuration/routing/routes/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Workers Platform Limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers Filesystem](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 Pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare Workflows](https://developers.cloudflare.com/workflows/)
- [GitHub Pages Custom Domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/about-custom-domains-and-github-pages)
