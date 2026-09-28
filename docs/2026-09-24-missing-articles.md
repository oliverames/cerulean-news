# Why tracked articles never reached the feed, 2026-09-24

This traces the 49 articles from five of the team's daily clip emails (Sept. 17 to 24) that were absent from the 12:20 UTC audit. It is a proposal: nothing here has been changed. The team's article choices stay private, so this records causes and fixes, not the list.

## Findings

Of the 49, 15 were already in the audit under another outlet or as a close counterpart: 7 included and 8 rejected. The other 34 were absent.

| Cause | Absent articles |
| --- | --- |
| Google News site search returns off-topic or out-of-window results | 17 |
| Outlet is a source, but the headline matches no topic term | 10 |
| Outlet is not a source | 4 |
| Not a normal web article (newsletter item, email-only) | 3 |

Live checks, one fetch each on 2026-09-24:
- **National Health Policy** and **Kristina Source** searches returned mostly general news, such as sports, the UN, and entertainment. The health terms in the query had no visible effect.
- **Health Trade** ignored its `when:14d` window. Only 4 of 100 results were from Sept. 17 or later; the rest went back to 2021.
- **Vermont Health Search A** returned one item.
- **Short single-site queries** returned the missing articles directly. For example, `site:nytimes.com health when:7d` and `site:beckerspayer.com when:7d` returned 100 of 100 and 46 of 50 in-window results.

Even when collected, most national articles would then be rejected by the broad-national code rule in `src/relevance.js`, which needs a payer or policy word in the title or description. That rule is paused until the clip-email corpus is used to rewrite it.

## Proposed fixes, ranked

1. **Topic terms (`src/matching.js`).** Low effort, low flood risk. Add patterns for:
   - insurance coverage, group coverage, ICHRA
   - family medicine, medical education and physician training
   - drug pricing, prior auth abbreviations, and "healthcare costs" (written as one word)
   - rural transformation and RRMC
   - postpartum, prenatal, and birth control
   - home-based care and flu shots
   - the major national payers by name

   Tested against 1,001 fetched Google News titles, these added 29 matches, all health or payer stories.
2. **Replace the three broken Google News queries (`src/sources.js`)** with short single-site queries, and split Vermont Health Search A into its three clauses. That is about 8 more requests per run. Retrieval was confirmed live for 11 of the 17 query-caused articles.
3. **Rewrite the broad-national rule.** Paused until the rule rewrite, as agreed on 2026-09-24.
4. **Body scan for the Blue Cross spelling-variant search.** This reverses a deliberate feed-only choice, so it needs Oliver's sign-off.
5. **New sources:** WMUR, News10, and WAMC through site-scoped Vermont health queries, plus Becker's ASC Review. Reuters is not recommended.
6. **Brand body scan on four Vermont outlet feeds.** This raises request volume to those publishers, so it needs Oliver's sign-off.

The clip-email seed makes every Blue Cross VT and Vermont clip must-include whatever the crawler misses. These fixes matter most for national coverage and for future articles before they appear in an email.

## Outcome, 2026-09-28

Oliver approved all four remaining fixes and asked for every Vermont source that can be added. The broad-national rule rewrite (item 3) is still paused.

- **Topic terms** (e9e2024): these are in. The two false positives found in a check of 616 live items came from "insurance coverage", so that phrase and "group coverage" were dropped.
- **Google News searches** (088c675): the three broken OR searches are now seven single-site searches. Vermont Health Search A is split into three, and Becker's Hospital Review has its own brand-scoped search.
- **Body scans** (28c0f75): WCAX, VTDigger, Vermont Public, and the Times Argus scan every new article body for the brand, and so does the spelling-variant search. VermontBiz's feed already carries full article text. Its article pages answer the runner with 403, and a relay proposal (`docs/2026-09-28-vermontbiz-relay-proposal.md`) was declined.
- **Sources** (81c8722 and the following commit): 44 were added from a verified inventory of 101 candidates. They include state health agencies, hospitals, neighboring outlets searched with Vermont in the query (WMUR, NEWS10, NHPR, the Keene Sentinel, the Press-Republican, WAMC, and the Berkshire Eagle), and Becker's ASC Review. Three moved hosts were fixed (Deerfield Valley News, The Bridge, the Hardwick Gazette).
