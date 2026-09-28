# Proposal: fetch VermontBiz article pages through the relay

September 28, 2026
Author: Oliver Ames

Status: proposal only. Nothing described here has been changed.

## Summary

Vermont Business Magazine (vermontbiz.com) is the team's top clip outlet: 27 of the tracker's brand clips come from it. It sits behind Cloudflare, which answers GitHub Actions runners with HTTP 403 on article pages. The same pages return 200 from other networks. The existing fetch relay on home-server could fetch those pages from a residential address.

The change is small: a setting on the relay, two Actions secrets, and one workflow line. A short code change would keep a relay outage from breaking the feed. The measured benefit is also small, because VermontBiz's RSS feed already carries full article text. Routing around the 403 also means deliberately getting past a publisher's bot block, which the README currently says this crawler does not do.

## What fails today, measured on 2026-09-28

- **The feed works.** `https://vermontbiz.com/rss.xml` answers the runner normally, most recently with 304 Not Modified. It carries full article text (median 7,114 characters across its 10 items), so Blue Cross mentions in article bodies are matched without fetching the page.
- **Article pages fail from the runner.** Both VermontBiz entries in the article cache are HTTP 403 from Actions. The 2026-09-24 excerpt rebuild also logged 403s, mostly from Becker's and VermontBiz. From this session's network, the same Williston-Richmond Rotary page returned 200.
- **Few items need a page fetch.** Of 139 VermontBiz items in the archive, 58 came from the RSS feed and 78 from the media tracker. Only 3 came through Google News searches, which is the path that needs a page fetch. Nine have no stored excerpt.
- **Coverage is nearly complete.** Google News finds 12 VermontBiz stories from 2026 that mention Blue Cross. Eleven are in the archive. The one missing story, "Snelling Center announces Vermont Leadership Institute graduates" (2026-06-09), names us only in the body.
- **Feed depth is adequate.** VermontBiz publishes about 50 stories a week. At about five runs a day, each 10-item poll covers roughly a day and a half of stories.

## The change

1. **Relay (home-server).** Add `vermontbiz.com` to `ALLOW_HOSTS` in `~/docker/cerulean-fetch-relay/.env`, then restart the container. The relay stays GET-only, token-only, and allowlist-only.
2. **Secrets (GitHub).** Add `FETCH_PROXY_URL` (`https://fetch.amesvt.com/`) and `FETCH_PROXY_TOKEN` as Actions secrets. The token's canonical home stays in 1Password.
3. **Workflow.** In the Generate step, set `FETCH_PROXY_HOSTS: vermontbiz.com`, plus the two secrets. Google News keeps going direct from Actions, since it answers the runner normally.
4. **Code, recommended.** `src/egress.js` sends every request for a listed host through the relay, including the feed. If home-server is asleep or the tunnel is down, the currently working feed would fail over to its Google News fallback. A direct retry on relay network errors or 5xx responses would make an outage no worse than today. It is about 15 lines in `src/fetching.js`, with a test.
5. **Verify.** Run one manual dispatch with `rebuild_brand_excerpts`, and confirm that the nine empty VermontBiz excerpts are rebuilt with no 403s in the log.

The existing per-domain delay still applies, so load on VermontBiz stays at a few article fetches a week.

## Risks and trade-offs

- **Policy.** This deliberately routes around a publisher's Cloudflare block on datacenter traffic. The README says the collector does not use alternate routes to bypass access controls. That line would need to change, and the publisher could reasonably object. The Google News relay set a precedent, but Google was blocking an IP range, not a site defending its own pages.
- **Dependency.** Page fetches would depend on home-server being awake and on the amesvt tunnel.
- **Reputation.** Relayed requests come from the home connection's IP address, so VermontBiz's logs would show that address.
- **Benefit.** On current evidence the relay would recover about one missed story a year, fill nine excerpts once, and give three Google-found items a proper excerpt.

## Alternatives, ranked by effort

1. **Do nothing.** The RSS feed's full text already covers VermontBiz, and 11 of 12 known 2026 brand stories are in the archive.
2. **Add missed stories by hand.** Add them to the tracker seed, as the team already does for clips the crawler cannot reach.
3. **Ask VermontBiz.** Ask them to allow the crawler, or to publish a deeper feed (for example, 50 items). This fixes the cause and needs no infrastructure. It depends on their answer.
4. **The relay change above.**

## Recommendation

Ask VermontBiz first (alternative 3), and add the Snelling Center story by hand now if it matters. Use the relay only if VermontBiz declines and the missed coverage turns out to be larger than measured here. If you approve the relay anyway, include the direct-retry code change, so that a relay outage cannot break the one VermontBiz route that works today.
