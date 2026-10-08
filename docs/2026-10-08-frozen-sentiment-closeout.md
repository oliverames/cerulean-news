# Frozen Jev repair closeout — October 8, 2026

Tracked in [GitHub #14](https://github.com/oliverames/cerulean-news/issues/14) and [Linear AME-39](https://linear.app/ames-consulting/issue/AME-39).

## Verified outcome

The original 157-target freeze has 115 valid published outcomes after 116 HTTP attempts. One original malformed answer remains preserved; 41 targets have never been attempted. The isolated retry was not used. Successful publications passed protected-field and membership checks and exact readback of nine generated files. The repair preserved 6,050 audit entries, 3,127 public stories, inclusion, summaries, generation time, digest/storyline membership and calendar/alert artifacts within its frozen snapshot.

| Operation | Run | Valid results | Remaining frozen targets |
| --- | --- | ---: | ---: |
| Publish 15 saved results, no inference | [37831238640](https://github.com/oliverames/cerulean-news/actions/runs/37831238640) | 65 | 92 |
| Continue 25 untouched targets | [37831561907](https://github.com/oliverames/cerulean-news/actions/runs/37831561907) | 90 | 67 |
| Continue 25 untouched targets | [37831995856](https://github.com/oliverames/cerulean-news/actions/runs/37831995856) | 115 | 42 |
| Canceled before any job started | [37832438422](https://github.com/oliverames/cerulean-news/actions/runs/37832438422) | 115 | 42 |

The last verified checkpoint belongs to run `37831995856`; its published audit hash is `e657e7fe199816b4d8a8f884da07f89ac1500a05009307921a143d720d88c96d`. The original freeze is run `37822663207`, manifest `1d3bebd2ead988aea59b8e55dc59943503a55645b214863fd3521e9fbfc24971`. The canceled run's GitHub jobs API returned zero jobs; it made no provider request. It was canceled while the scheduled publisher and merged-PR release occupied the shared deployment queue. Pending-run replacement appears to explain the timeline, but no explicit cancellation reason was returned by GitHub. Automatic continuation stopped.

## Next steps and acceptance

1. Reconcile the canceled run against GitHub metadata and the latest durable checkpoint without replaying inference. The lineage guard must distinguish a verified zero-job cancellation from an ambiguous started attempt; cover both with meaningful tests. Do not rerun the canceled job or create a fresh freeze to bypass the guard.
2. Read the current live audit and compare the protected snapshot and request hashes. Scheduled generation is independent and can change the archive. These frozen publication counts do not describe a later scheduled publication. If compatibility fails, prepare a concrete reconciliation plan before changing the frozen authorization.
3. If compatible, continue only the 41 untouched targets in batches of at most 25 using the latest verified checkpoint. Preserve prior rows and stop on any provider, quota, validation or publication error.
4. Only after 156 valid outcomes and all 157 targets attempted, use the authorized isolated retry once for the original malformed target. Persist intent before sending; retain its original attempt and private schema/numeric diagnostic. Never weaken probability validation.
5. Verify publication, protected fields, membership and all nine files after each batch. Prove the exact queue from the manifest/checkpoint, rather than the old crawl metric. Keep #14 / AME-39 open for the separately listed [remaining Gemini rubric articles](2026-10-08-remaining-gemini-sentiment.md).

The existing free plan, TypeSafe recipient, `jev-1.13.0`, outgoing article/reference fields and maximum batch size remain fixed. Persistent reservation, cap and concurrency were not changed. Private checkpoints and reference context remain outside Git. Below are frozen ordinals, hashed publication identities and public URLs.

## All 42 remaining frozen targets

| Frozen ordinal | Status | Article identity hash | Public article URL |
| ---: | --- | --- | --- |
| 66 | original malformed response; retry unused | `c5c7574f071b5ff08187747e5f5a41b3758c179c846b8be1b1e2a443d7201e2a` | <https://vermontmedicalsociety51665.wildapricot.org/resources/EmailTemplates/20260623%20VMS%20Rounds/index_preview.html> |
| 117 | untouched | `072ca6ef958db10901ae1bf6a260e9da8e81fcfd1de089b0406441c52e81ffe2` | <https://vtdigger.org/2026/02/13/a-rare-condition-can-send-kids-into-fits-of-rage-treatment-could-help-if-insurance-covers-it/> |
| 118 | untouched | `d42fa45e960e449aebd3a4bacfaeeecdc8ffea3a4ba159825250d93fd5b25450` | <https://www.crainsdetroit.com/health-care/blue-cross-blue-shield-michigan-sell-af-group> |
| 119 | untouched | `11bfb737dcc90ce982390d27b060d04b0a4a02a2b4b3fc05326520e9e535d725` | <https://www.reformer.com/local-news/representative-bos-lun-fighting-rare-lung-cancer/article_215eaddb-8581-4990-9434-0df02c0d0344.html> |
| 120 | untouched | `a8ea195f2a09d110fb1751caa70bc1c2687baa8d1237ff0ba718f2e5bb112def` | <https://www.vermontpublic.org/show/vermont-edition/2026-02-04/new-bluecross-blueshield-ceo-says-we-have-an-affordability-crisis-in-vermont> |
| 121 | untouched | `abb6db29dbb6c006ab176d2529691ed7e25f6d479101d0882ba5bd37229640f5` | <https://vermontbiz.com/news/2026/february/03/vahhs-legislature-moving-full-steam-ahead> |
| 122 | untouched | `6496c89b0a88768f3c3c0d156af38baf7d7addaf7bc05fe1c2526b2d7d1071f1` | <https://www.beckerspayer.com/leadership/bcbs-vermonts-new-ceo-points-to-a-major-affordability-concern-and-how-she-is-tackling-it/> |
| 123 | untouched | `fd006db811946a6f2b128bf45d9e237a4a8aa24cda15147f9bdfd04234c86f04` | <https://www.timesargus.com/news/local/sanders-leffler-talk-health-care-concerns/article_6e71f310-acf8-4873-b184-265e24a778fc.html> |
| 124 | untouched | `aabcc948ebbe2944a868c5570fa8eac378947df9f69464f431a477309d577297` | <https://vtdigger.org/2026/01/22/early-numbers-show-many-vermonters-dropping-their-insurance-for-2026/?utm_medium=email&utm_campaign=Daily%20Digger%201%2F23%2F26&utm_source=dc3c5486db&utm_source=VTDigger+Subscribers+and+Donors&utm_campaign=58f9d37c5f-EMAIL_CAMPAIGN_2026_01_23_12_15&utm_medium=email&utm_term=0_-58f9d37c5f-381308666> |
| 125 | untouched | `957558e8cdc71ff46a6ac745f0a694ed51404a6f838c436bea6d6cc72f030733` | <https://www.sevendaysvt.com/arts-culture/stuck-in-vermont-vermonters-struggle-with-rising-health-insurance-costs-and-some-are-going-without/> |
| 126 | untouched | `c108fd8acb7b820454941d1ea47243bce5bab8fe2996991afbce0f74758183a5` | <https://www.vtcng.com/thecitizenvt/news/local_news_charlotte/charlotte-agrees-to-raises-for-non-union-workers/article_718b3c1c-9f2c-4d04-ae17-f44e1881c550.html> |
| 127 | untouched | `791868d623a4b7ebbb351115859fda58505c1b972aa34e6f1db3509c27504189` | <https://www.benningtonbanner.com/opinion/letters/letter-to-the-editor-lee-russ-we-need-to-fix-health-care-in-vermont-and/article_e715ee7c-3993-4621-9433-1856e9deac78.html> |
| 128 | untouched | `e40f167f3dc6265e2b6605be9c4b3ff753993f75b7d656e4b18d23639bf75c43` | <https://www.mynbc5.com/article/rising-health-care-costs-strain-vt-families-as-lawmakers-search-for-solutions/70083234> |
| 129 | untouched | `0930ea77839b6c876521212d993f7f5d61cec88f4370f1a1b05a88f3cfc56f2f` | <https://www.samessenger.com/opinion/editorials/how-nmc-can-be-used-to-lower-health-care-costs/article_078e0015-600f-416b-ac79-028ad43feda5.html> |
| 130 | untouched | `8e220c77b2a9445dc3957a0a3eeea4ccec0b8cca95b4d75b971e97fdd7adc363` | <https://www.timesargus.com/news/local/business-briefs-for-saturday-jan-17-2026/article_a3fc22af-5a79-5723-b90a-141baa8b8d2a.html> |
| 131 | untouched | `6312c8f16e66b5953277b0931e3eecd133af65c616ae08fc4a0cd09020515127` | <https://vtdigger.org/2026/01/16/bluecross-blueshields-new-ceo-takes-over-as-insurer-faces-federal-and-statewide-challenges/?utm_medium=email&utm_campaign=Daily%20Digger%201%2F17%2F26&utm_source=dc3c5486db&utm_source=VTDigger+Subscribers+and+Donors&utm_campaign=31f366a632-EMAIL_CAMPAIGN_2026_01_17_01_30&utm_medium=email&utm_term=0_-31f366a632-381308666> |
| 132 | untouched | `87e8b02f6269db551f5348ffa3c2a2603759885e9f650d9d7bdcdd7af71a304a` | <https://www.vermontpublic.org/show/vermont-this-week/2026-01-16/in-review-cheaper-health-care-motel-program-supreme-court> |
| 133 | untouched | `435e23514cdbed508ea93b36cdf116264e98bbd15d23b0d87e39624aff1c84fc` | <https://citizenportal.ai/articles/7282517/Vermont/DFR-tells-Appropriations-committee-Vermont-insurers-need-adequate-rates-to-avert-Blue-Cross-insolvency> |
| 134 | untouched | `6982132af85bec380763daa59c31106577e96d4018a822dfda3eac6bd8d365e1` | <https://www.ourherald.com/articles/roberts-is-named-vermont-blue-cross-blue-shield-ceo/> |
| 135 | untouched | `3e4acac08b17f0958e16b37e514256605bafc29e5afbbad4f7f3596a5e94b083` | <https://www.sevendaysvt.com/news/healthcare/in-ad-campaign-blue-cross-asks-patients-to-shop-around/> |
| 136 | untouched | `6fabe44c24542bc75573d5c46581ec4b3c532328d1b88de44a84e02ec2dc0ca2` | <https://www.wcax.com/2026/01/14/ad-campaign-blue-cross-asks-patients-shop-around/> |
| 137 | untouched | `9301b8e8771990b8dc6bcc342a21a41caa887ea2c725f77ae527c013202bc1e0` | <https://gnat-tv.org/pressrelease-blue-cross-and-blue-shield-of-vermont-enters-next-chapter-as-beth-roberts-assumes-role-of-president-and-ceo/> |
| 138 | untouched | `cc6a704e584fe41e857c0d321f829d446b869e09c6feb0e7221854938a4fbedc` | <https://vermontdailychronicle.com/uvms-north-country-hospitals-bargain-amid-nyc-15000-nurse-walkout/> |
| 139 | untouched | `26edd66e279bfe17db7df9ffe5020e06fca6406cec86cff283d5855cc2c0bf1d` | <https://vermontbiz.com/news/2026/january/12/beth-roberts-assumes-role-ceo-blue-cross-and-blue-shield-vermont> |
| 140 | untouched | `41930766784ee9fbf764d36a7bddd7b21e2dee19172b8382b6c990f26fe5388e` | <https://vermontbiz.com/news/2026/january/12/vahhs-hospitals-also-back-state-house> |
| 141 | untouched | `a3de40da496741cbaa6dc01e5a0fb14f662242d2dc09ae563ad1204bf5841acb` | <https://www.compassvermont.com/p/uvms-north-country-hospitals-bargain> |
| 142 | untouched | `a95ffee8a3adf145816b8193c1ed2ab6b9b9a8437d832389d296cd0ed53a2a11` | <https://www.vermontpublic.org/show/vermont-edition/2026-01-07/the-state-of-affordability-in-vermont> |
| 143 | untouched | `87709d12cf673bb16ee37e160bbc8e6607e70bfbb04d8a71f074a2823a0753a0` | <https://nhjournal.com/business-groups-warn-white-bagging-ban-will-send-healthcare-costs-higher/> |
| 144 | untouched | `fc0d4378ea7e5d087b1ad8c3aa9382ae0d0314616d477827f1754505cd0ac64b` | <https://vermontbiz.com/news/2026/january/04/employee-health-care-beth-schillers-primary-concern> |
| 145 | untouched | `9545ce37cc4318f9abcf98e0ce49a231ef523403269271d243f718d07e3b6dee` | <https://www.vermontpublic.org/show/vermont-this-week/2026-01-02/legislative-preview-2026-education-health-care-housing> |
| 146 | untouched | `af9ec2a8300c994e2f5e9f7e7bd5c0078c22a96cb5faaa58a2c2c005abf18231` | <https://www.vermontpublic.org/local-news/2025-12-29/burlington-mental-health-provider-to-pay-200k-to-settle-medicaid-fraud-claims> |
| 147 | untouched | `a5d3d79af6877bce05daf98043ecd3d86030919c9a136823d455482ac8e6a27c` | <https://vermontdailychronicle.com/understanding-the-blue-cross-uvm-health-network-split/> |
| 148 | untouched | `88cb049bb3b53448f5204114fc8952d89e8e24b7cf9cbd27345c4a547d164531` | <https://www.vermontpublic.org/show/vermont-this-week/2025-12-26/in-review-top-10-stories-2025> |
| 149 | untouched | `e04e5703021c8adc883e8761c4fdc608b5c702041d952d7f3a3128cbe21f4c66` | <https://blubrry.com/vermontviewpoint/150963094/december-23-2025-rob-roper-with-republican-party-chair-paul-dame-and-amy-hornblas-founder-of-the-new-online-forum-vermont-back-porch/> |
| 150 | untouched | `3c3827e8da1f05082aca7d4ce1276a90b770c5c2c992abac98a4573c68a49015` | <https://www.beckerspayer.com/payer/bcbs-of-vermont-campaign-questions-academic-medical-center-pricing/> |
| 151 | untouched | `3c6bb14a9623cb2cd7fc798cf8578491a14d7de0aaba202b02f4ce829e55801e` | <https://www.vermontpublic.org/local-news/2025-12-08/farmers-crisis-rising-health-care-costs> |
| 152 | untouched | `65feca4810fef3f0db122affe4a99b4ecf0d32ef5553884df755252dfb829a88` | <https://vermontdailychronicle.com/roper-healthcare-in-vermont-is-a-government-facilitated-grift/amp/> |
| 153 | untouched | `bf241cfb1aafc79fadbbc9d2233d2b9eaac1d056af33582390b5913289a36752` | <https://vtdigger.org/2025/12/05/vermont-health-officials-reaffirm-importance-of-hepatitis-b-vaccine-after-federal-advisory-panel-recommends-delays/> |
| 154 | untouched | `6915605ea93cb503963d8d895dc25833d26d168d32cb0f8f9329b69f68605aa7` | <https://vermontbiz.com/news/2025/september/30/blue-cross-vermont-names-beth-ann-roberts-president-and-ceo> |
| 155 | untouched | `0bdb7a8abf3f5450e1792b38f6524314c256733bc8147c2cfcedc3788a50e0aa` | <https://vermontbiz.com/news/2021/june/01/bmh-now-part-anthem-blue-cross-and-blue-shields-pathway-network> |
| 156 | untouched | `ce2947fc7ba2391344c577aa10babcc76d10c9d23e70070e76383c641c7f92d6` | <https://vermontbiz.com/people/july/blue-cross-vt-ceo-employees-honored-vermont-alzheimers-association> |
| 157 | untouched | `0bf976f89b78af8a37f9df4103a841840f50f004d369912fbe0ebae3a1302de4` | <https://www.wsj.com/opinion/free-market-health-reform-in-bernie-sanderss-vermont-32a2ba68> |
