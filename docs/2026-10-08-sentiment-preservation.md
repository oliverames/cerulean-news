# Saved sentiment preservation and changed-context articles

Tracked in [GitHub #14](https://github.com/oliverames/cerulean-news/issues/14) and [Linear AME-39](https://linear.app/ames-consulting/issue/AME-39).

The scheduled publication [37832374065](https://github.com/oliverames/cerulean-news/actions/runs/37832374065) removed 94 saved cache entries and changed numeric scores for 45 repaired articles. [PR #30](https://github.com/oliverames/cerulean-news/pull/30) preserves tracker outlet provenance, keeps valid historical cache answers, gates sentiment reuse by the exact request hash, and prevents an inclusion-only answer or fresh primary response from erasing protected sentiment. Source and live-publication guards reject stale publication work.

The provider-free [preview 37838887931](https://github.com/oliverames/cerulean-news/actions/runs/37838887931) preserved all 115 valid saved responses through the actual generation pipeline, with zero source/provider requests and zero blocked fetches. There are 71 exact current contexts, 44 changed contexts retained as historical only, and 26 article-field repairs. Surgical rendering preserves 6,061 audit entries, 3,133 public stories, generation time, all protected fields and digest/storyline membership, calendar and alerts. Provider-free [reconciliation 37840146480](https://github.com/oliverames/cerulean-news/actions/runs/37840146480) deployed the repairs successfully. All nine artifacts matched on the native site, custom domain and immutable deployment. Post-live [verification 37841313655](https://github.com/oliverames/cerulean-news/actions/runs/37841313655) proved all 115 saved responses and all 71 exact-context article/audit and public-feed sentiment fields survive the actual generation pipeline, with zero outbound attempts. This executes the scheduled publisher's generator on temporary copies without collecting sources or invoking providers; the next ordinary scheduled run remains independent.

The original [42 unresolved frozen targets](2026-10-08-frozen-sentiment-closeout.md) remain paused: 41 untouched and one original malformed response, with the single retry unused. The [current Gemini inventory](2026-10-08-remaining-gemini-sentiment.md) is separate; eleven original feed-ID aliases are already represented by its canonical URLs. These inventories overlap; do not add their counts as distinct stories.

## All 44 saved responses whose current context changed

The saved answers remain durable historical evidence but cannot be reapplied to a changed outlet/reference context. Keep current article fields untouched. Before any fresh inference, compare the exact current request with its saved hash, deduplicate aliases and obtain authorization for the changed payload and bounded queue. Do not replay the old freeze, overwrite the newer archive or weaken response validation. Acceptance requires valid current-context odds, preserved human/inclusion/summary fields and verified live persistence.

| Frozen ordinal | Article identity hash | Public article URL |
| --- | --- | --- |
| 9 | `e369a2ed76116a746d99f21d7b77a26395aaf5374ef0358673ae468addf39cad` | <https://vermontmedicalsociety51665.wildapricot.org/resources/EmailTemplates/2026-09-22-Rounds-Speaker-Annual-Meeting/index_preview.html> |
| 12 | `0de9511aacf1f8fc600355eed5688e911f0053d0892645dacce4e091d77921c7` | <https://www.mynbc5.com/article/vermont-food-insecurity-day-of-service/73780135> |
| 13 | `88c488930365f79c5b6eb0add68a5336827cacb45d0646f388d1a892108617db` | <https://www.mychamplainvalley.com/news/blue-cross-vt-helps-combat-food-insecurity/> |
| 14 | `fc1c270c51f51341279046f19785f6278b9e99297d854a8b63bd5f0c14230a53` | <https://www.mychamplainvalley.com/video/health-insurance-staff-help-fight-vermont-food-insecurity/12181866/> |
| 18 | `5395cd8e637716603f639b6489c279c0c83d5770848a58221cc93f948366b5bd` | <https://www.vermontpublic.org/show/vermont-edition/2026-09-16/new-documentary-explores-the-goodness-in-vermonters> |
| 23 | `6e9d2472f741ad6be66f3edd94b808caa9610b6d3f4d4f049f749eb88c7e8a1f` | <https://www.mynbc5.com/article/green-mountain-care-board-approves-aggressive-cuts-to-uvm-revenue-rates/73729982> |
| 24 | `e6763589f644db3a98093166d56b38c10b5677e0e963fac86d2795133d9b8f65` | <https://www.beckershospitalreview.com/finance/5-states-finalize-2027-aca-rates/> |
| 28 | `fa5619d3dda10c90a4cb589bc3c6deb8ebde71125b00800f9659b5e4e9d7f381` | <https://www.timesargus.com/eedition_theworld/page-a18/page_d7e687e5-1125-5958-a7e0-5618e150e546.html> |
| 30 | `4302a57eb0cb49bfee8a698432a47ae63ffc4ca3ab28c9c51bea231e37b7d050` | <https://www.timesargus.com/news/local/green-mountain-care-board-sets-insurance-premium-rates/article_4180bbd8-298a-5c0d-9069-9a30040506e0.html> |
| 32 | `3954f7564e1469d44e87da66cf436281d18ecaa60b897ded80dfb7df2f96ab56` | <https://www.samessenger.com/opinion/editorials/the-44-percent-thats-costing-vt-big-bucks/article_333c89e5-837d-4fc2-ae81-b0f89f6d7753.html> |
| 35 | `3555ea9ecbaec17dc736774ca795ba9129cbed8ecf3c0f48058d412065af64f1` | <https://www.mychamplainvalley.com/news/local-news/vermont/green-mtn-care-board-sets-2027-health-insurance-rates/> |
| 37 | `89f2fde9b6431529f7782380d64f85a309db0ba9880a5372597acd0ddf22b94c` | <https://www.mynbc5.com/article/vermont-health-insurance-premiums-rise-2027/73472892> |
| 41 | `bc7da9f135b2562e54d201e46722cd52dd177f085ff104d90b509886dbabb2ae` | <https://vermontjournal.com/event/blue-cross-vt-kayak-days/> |
| 44 | `924df10d6162f9292198ef57291a2a9e7ee5f7b33da9864df36be520bd99ffdf` | <https://www.timesargus.com/theworld/world-calendar-08062026-copy/article_654f6a7a-4151-5713-ad8f-efdc79461a0e.html> |
| 48 | `750eba94ed38f6afd4a35559be460513f032d8d887bad1a0b879642a5c1b7724` | <https://www.vtcng.com/stowetoday/family_fun/blue-cross-blue-shield-of-vermont-hosts-kayak-days/article_edbeaf81-d800-4760-a956-70e430c4caf2.html> |
| 49 | `83ffa2f66b2e094becd58f523a28885861bf512c4ed0b4e116c01f971ca6d8f6` | <https://news.ambest.com/PR/PressContent.aspx?altsrc=186&RefNum=37577> |
| 53 | `fa78dc791c4e45e40d76d4f94124e02475ac4af2e0e3739f3f796b58a5c56db5` | <https://tradersunion.com/news/business-wealth/show/2774226-am-best-upgrades-blue-cross-vermont/> |
| 57 | `44bf632b1eb308affb87ea065cdf1fcc9ce2d45b6bff6027c5a88937a1a7e0bc` | <https://www.samessenger.com/opinion/letters_to_editor/letter-to-the-editor-cant-lower-healthcare-costs-until-vermont-fixes-bad-policy/article_0d2c3cb9-05de-4167-a74a-2bab75204f3b.html> |
| 58 | `d06ecd6c6ee81af959c3a698474c79f1c2c317a1a891d273af6aebc946d44bf9` | <https://www.wsj.com/health/healthcare/obamacare-insurers-seek-big-rate-hikes-again-8a4bf9e4> |
| 60 | `a7734a2cec3a5d70b150918ba7f6198d399aa75c5c3da02d9367bb90387f07f3` | <https://www.waterburyroundabout.org/opinion-archive/letter-if-healthcare-doesnt-need-regulation-nothing-does> |
| 62 | `28b3be10adcb29b78b98afa93abbaa01637ab5dfe5c35fd10ed3c8612e4acdec` | <https://www.vermontpublic.org/show/vermont-edition/2026-06-29/i-hate-this-but-that-is-our-reality-more-layoffs-coming-for-uvm-health> |
| 63 | `6a1722a6b0dcdeb23839abd5a4822c9b3a1720b180c9f7e354d1a0d9c10d9797` | <https://www.vermontpublic.org/show/vermont-this-week/2026-06-26/in-review-scott-vetoes-healthcare-reform-bill-systemic-challenges-rural-pharmacies> |
| 64 | `480aac3514a5537a79549c939c67c4d9ce810932bd699c70b56ad3135fa42579` | <https://www.manchesterjournal.com/sports/grace-cottage-hospital-hosts-17th-annual-tee-it-up-for-health-golf-tourney/article_75a2a3b0-9d0f-45fa-96e5-543b277584cb.html> |
| 65 | `5a91dc25e9bc53225faa66678d2a5c8c2a2fe7a52a760b9ffac90cecbec20d52` | <https://podcast.show/3864599/june-23-2026-joe-talks-with-beth-roberts-the-president-and-ceo-of-blue-cross-blue-shield-of-verm/> |
| 68 | `bbc9a67582107729f6c44ecc3355a1269c0cdcdabff95553d115042370c0cfd9` | <https://chir.georgetown.edu/early-signals-suggest-a-second-year-of-double-digit-marketplace-premium-increases/> |
| 70 | `8bbb51798768a2b0bedfa889fd4055801d4d2e06ffc532fcf2b3f35d56edf6c0` | <https://www.mychamplainvalley.com/news/local-news/vermont/pharmacy-discount-card-becomes-law-in-vermont/> |
| 72 | `368e11595ef146769a816d99e98c301e2fb892853f8c817654c177545eb85909` | <https://www.vermonttreasurer.gov/press-releases/treasurer-pieciaks-pharmacy-discount-card-proposal-signed-law> |
| 74 | `1493bb716debe1351f376a51b4b1310526bbd56e199fd869f02a1160e8a60301` | <https://www.mynbc5.com/article/vermont-senior-games-return/71582091> |
| 78 | `81166170177aa6823c68bc71d83d8f817ce1483e392b687fd6f8ec1afb1d0827` | <https://www.reformer.com/community-news/guilford-cares-senior-walk-on-june-9-at-guilford-central-school/article_7f65e8df-69b4-4906-b214-61f36d97137a.html> |
| 80 | `d0d9a131266a25cc812fdfd2a4ff08db48714ce35a843900c54e54769fc69aa5` | <https://www.manchesterjournal.com/local-news/girls-on-the-run-5k-set-to-return-to-manchester/article_7daca516-3996-441f-9244-46550f95b249.html> |
| 81 | `46a5cbe843e99eca2af84c1a09c56ca284f81fed98942439fd20b48358bb05d3` | <https://www.timesargus.com/eedition_theworld/page-a14/page_0770b010-d2f2-5079-8545-b2883ae50fd4.html> |
| 88 | `533e7f06176f6fea13885413619ba093d9d16a120b309884cc640deea2ac5a75` | <https://www.mynbc5.com/article/blue-cross-and-blue-shield-of-vermont-seeks-premium-increases/71287520> |
| 90 | `1f2320bc423eeeab21b603cb440cd27d21e2a92a51c13eb5cce6d7d3b9cee9a6` | <https://www.mychamplainvalley.com/news/local-news/vermont/blue-cross-blue-shield-requests-rate-increase-for-2027/> |
| 91 | `b5b658bee55538c08c310d15b4fcf0b0bcb55915891b9b65b78ef74edb261206` | <https://www.timesargus.com/eedition_theworld/page-a3/page_5acd23b6-a4fa-59e4-b6b7-a0519a900c2a.html> |
| 93 | `537820982f8c86bdf2e4a1ff77ca9130e8a7eafe53ea08a4e8f3a07f85b8cb81` | <https://podcast.show/3864599/episode/153844075/> |
| 98 | `f7fe23f4bf5b3b1b1bfcfd32f313e90d826afd5d5cb7033cba24f289bb60064e` | <https://www.mynbc5.com/article/vermont-drug-cost-relief-bill/70859348> |
| 99 | `d1d6350aa6f82ab2d8175f2b39c874f1a708437ca09cc9f136d99165850b2bfe` | <https://www.vermonttreasurer.gov/press-releases/house-advances-prescription-drug-discount-card-proposal-h577-overwhelming-bipartisan> |
| 100 | `f12f4149b37fdf84d56c6e9693622a1b31d6a6d641a4a8e5c2dd4a5711db24fd` | <https://kevinmd.com/2026/03/health-insurance-incentives-and-alternatives-to-opioids-for-chronic-pain.html> |
| 101 | `7a3b5bfee3a790d20118f7335b5d5ccb88c2a063cca3bcd2938cdda8ccd06a86` | <https://podcast.show/3864599/episode/153758041/> |
| 102 | `ef3002de5f709993b235732ad16e841da5a89191eb2e949a4f27537e5641d375` | <https://www.vermontpublic.org/show/vermont-edition/2026-03-24/as-health-plans-drop-glp-1s-whats-next-for-patients> |
| 104 | `10bdd0ce3cbf552151a265e6c8bf58a65fa1913624918db867b2378c749bb257` | <https://www.vermontpublic.org/show/vermont-edition/2026-03-16/reporter-roundtable-vt-legislatures-crossover-day> |
| 105 | `a3085ccf0c6ac79e4a49bec465d3ac89b59389704ac660ff4bc24d4265e9e827` | <https://www.healthcare-brew.com/stories/2026/03/10/nearly-entire-state-vermont-disenrolled-medicare-advantage> |
| 111 | `ec676dfcf07a690aa4f7ccacbf7c8614cf1f84239fc4c5e136164a4a6277c5ad` | <https://thepenngazette.com/prescribing-affordability/> |
| 113 | `00330ce52e447634f2cf896f9f7692f6ec381e9316e021f4b5fa4f6736833c85` | <https://podcast.show/vermontviewpoint/episode/152562235/> |
