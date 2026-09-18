import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import {
  buildJsonSummary,
  buildRss,
  DEFAULT_SOURCES,
  generateFeed,
  BROAD_NATIONAL_SOURCE_NAMES,
  VERMONT_SOURCE_NAMES,
  cleanStorySnippet,
  buildSourcesFromEnv,
  backfillWindowFromEnv,
  applyBackfillWindow,
  buildSnippet,
  buildSummaryPrompt,
  buildFailureAlertMessages,
  articlePageHasArticleEvidence,
  applyDeterministicRelevance,
  applyFailureStreaks,
  selectFailureAlerts,
  triggerWebhooks,
  webhookTargetId,
  selectPreviewBackfillItems,
  canonicalizeMatchedTerms,
  categorizeTerms,
  CATEGORY_BRAND,
  CATEGORY_TOPIC,
  findMentionTerms,
  dedupeResolvedItems,
  loadPreviousState,
  mergeWithArchive,
  mergeFacebookPagePostItem,
  normalizePreviewText,
  parseBlueCrossVtListingItems,
  parseBcbsAssociationNewsItems,
  parseCnnHealthSitemapItems,
  parseFeedItems,
  parseFacebookEmbeddedPosts,
  parseFacebookPageHtml,
  parseFacebookPostHtml,
  parseSummaryResponse,
  geminiGenerate,
  isFeedDocument,
  parseMediaTrackerSeedItems,
  matchStorylines,
  orderItemsForRun,
  selectPendingSummaryItems,
  enrichAndFilterItems,
  normalizeSentiment,
  shouldScoreSentiment,
  itemOutletName,
  isAssociationItem,
  isJobListingItem,
  isSocialVideoItem,
  namesBlueCrossVermont,
  SENTIMENT_VALUES,
  parseUvmHealthNewsroomItems,
  collectFeedItems,
  extractArticleComments,
  extractArticlePreview,
  fetchText,
  filterSourceItemsByDateWindow,
  isObituaryItem,
  isSourceWindowClosed,
  htmlToArticleText,
  isLikelyPaywalled,
  normalizeCrawlState,
  readResponseTextWithLimit,
  freshUntilFromHeaders,
  politenessPolicyFor,
  TOPIC_TERMS,
} from "../src/index.js";

test("findMentionTerms catches requested and similar Blue Cross VT variants", () => {
  const text = [
    "BCBSVT requested a rate increase.",
    "Blue Cross VT filed documents.",
    "Blue Cross and Blue Shield of Vermont responded.",
    "BCBS of Vermont is another shorthand.",
    "Visit bluecrossvt.org for more information.",
  ].join(" ");

  assert.deepEqual(findMentionTerms(text), [
    "BCBSVT",
    "BCBS of Vermont",
    "Blue Cross VT",
    "Blue Cross and Blue Shield of Vermont",
    "bluecrossvt.org",
  ]);
});

test("findMentionTerms groups close Blue Cross spelling variants under canonical labels", () => {
  assert.deepEqual(findMentionTerms("BCBS VT filed documents."), ["BCBSVT"]);

  const blueCrossVtVariants = [
    "Blue Cross VT filed documents.",
    "BlueCrossVT filed documents.",
    "Blue CrossVT filed documents.",
    "BlueCross VT filed documents.",
    "Blue Cross Vermont filed documents.",
  ];

  for (const text of blueCrossVtVariants) {
    assert.deepEqual(findMentionTerms(text), ["Blue Cross VT"]);
  }

  const blueShieldVariants = [
    "BlueCross and BlueShield of Vermont responded.",
    "BlueCross and BlueShield of VT responded.",
    "BlueCross & BlueShield of Vermont responded.",
    "BlueCross & BlueShield of VT responded.",
    "Blue Cross Blue Shield of Vermont responded.",
  ];

  for (const text of blueShieldVariants) {
    assert.deepEqual(findMentionTerms(text), [
      "Blue Cross and Blue Shield of Vermont",
    ]);
  }

  assert.deepEqual(
    canonicalizeMatchedTerms([
      "BlueCrossVT",
      "Blue CrossVT",
      "BlueCross BlueShield of Vermont",
    ]),
    ["Blue Cross VT", "Blue Cross and Blue Shield of Vermont"],
  );
});

test("findMentionTerms catches Kristina's Blue Cross Boolean pairings", () => {
  const cases = [
    ["BlueCross announced a change in VT.", "Blue Cross VT"],
    ["BlueCross announced a change in Vermont.", "Blue Cross VT"],
    ["BCBS announced a change in VT.", "BCBSVT"],
    ["bcbs announced a change in Vermont.", "BCBSVT"],
    [
      "Blue Cross and Blue Shield announced a change in Vermont.",
      "Blue Cross and Blue Shield of Vermont",
    ],
    [
      "Blue Cross and Blue Shield announced a change in VT.",
      "Blue Cross and Blue Shield of Vermont",
    ],
    [
      "BlueCross BlueShield announced a change in Vermont.",
      "Blue Cross and Blue Shield of Vermont",
    ],
  ];

  for (const [text, expectedTerm] of cases) {
    const matches = findMentionTerms(text);
    assert.ok(
      matches.includes(expectedTerm),
      `"${text}" should match "${expectedTerm}", got: ${matches.join(", ")}`,
    );
  }
});

test("findMentionTerms catches indirect and branded variants", () => {
  assert.deepEqual(findMentionTerms("Blue Cross of Vermont announced a plan."), [
    "Blue Cross of Vermont",
  ]);
  assert.deepEqual(findMentionTerms("Enrollment opened for Vermont Blue Advantage."), [
    "Vermont Blue Advantage",
  ]);
  assert.deepEqual(
    findMentionTerms("Michigan, Vermont Blues plans finalize merger."),
    ["Vermont Blues plan"],
  );
  // Curly apostrophe, as published by VTDigger
  assert.deepEqual(
    findMentionTerms("Vermont’s largest health insurer wants to offer a cheaper plan."),
    ["Vermont's largest health insurer"],
  );
  // Straight apostrophe variant
  assert.deepEqual(
    findMentionTerms("Vermont's largest private insurer filed for rates."),
    ["Vermont's largest health insurer"],
  );
});

test("findMentionTerms ignores unrelated text", () => {
  assert.deepEqual(
    findMentionTerms("The Vermont blues festival drew a crowd in Burlington."),
    [],
  );
  assert.deepEqual(findMentionTerms("New England's largest insurer reported earnings."), []);
});

test("default sources cover recurring clip-log outlets", () => {
  const sourceText = decodeURIComponent(
    DEFAULT_SOURCES.map((source) =>
      [
        source.name,
        source.homepage,
        source.feedUrl,
        source.fallbackFeed?.feedUrl,
        source.listingUrl,
        source.minPubDate,
        source.maxPubDate,
      ]
        .filter(Boolean)
        .join(" "),
    ).join(" "),
  ).replaceAll("+", " ");
  assert.equal(DEFAULT_SOURCES.length, 97);

  const expectedHosts = [
    "bcbs.com",
    "burlingtonfreepress.com",
    "abcnews.go.com",
    "cbsnews.com",
    "wsj.com",
    "cnn.com",
    "vermontdailychronicle.com",
    "beckershospitalreview.com",
    "samessenger.com",
    "caledonianrecord.com",
    "bartonchronicle.com",
    "commonsnews.org",
    "vt-world.com",
    "jonews.com",
    "brandonreporter.com",
    "northavenuenews.com",
    "lakesidenews.org",
    "charlottenewsvt.org",
    "eagletimes.com",
    "colchestersun.com",
    "northstarmonthly.com",
    "countycourier.net",
    "essexreporter.com",
    "hardwickgazette.com",
    "hinesburgrecord.org",
    "vermontjournal.com",
    "manchesterjournal.com",
    "vtnewsguide.com",
    "suncommunitynews.com",
    "miltonindependent.com",
    "montpelierbridge.org",
    "thenorthfieldnews.com",
    "theislandernewspaper.com",
    "nyvtmedia.com",
    "ourherald.com",
    "springfieldvt.blogspot.com",
    "mtngazettevt.com",
    "valleyreporter.com",
    "willistonobserver.com",
    "dvalnews.com",
    "thevermontstandard.com",
    "vtcommunitynews.org",
    "waterburyroundabout.org",
    "chestertelegraph.org",
    "newportdispatch.com",
    "cabotchronicle.org",
    "emsignpost.com",
    "thewinooskinews.com",
    "cctv.org",
    "ibrattleboro.com",
    "rakevt.org",
    "poultneyjournal.com",
    "magic967.com",
    "vtcynic.com",
    "strattonmagazine.com",
  ];

  for (const host of expectedHosts) {
    assert.match(sourceText, new RegExp(host.replaceAll(".", "\\.")));
  }

  const expectedLocalOutlets = [
    "Caledonian-Record",
    "Barton Chronicle",
    "The Commons",
    "The World",
    "Journal Opinion",
    "Brandon Reporter",
    "North Avenue News",
    "Lakeside News & The Rutland Sun",
    "Charlotte News",
    "Eagle Times",
    "Colchester Sun",
    "North Star Monthly",
    "County Courier",
    "Essex Reporter",
    "The Hardwick Gazette",
    "Hinesburg Record",
    "Vermont Journal",
    "The Shopper",
    "Manchester Journal",
    "Vermont News Guide",
    "Addison Eagle",
    "Milton Independent",
    "The Bridge",
    "Northfield News",
    "The Islander",
    "Lakes Region Free Press",
    "White River Valley Herald",
    "Springfield Reporter",
    "Mountain Gazette",
    "Valley Reporter",
    "Williston Observer",
    "Deerfield Valley News",
    "Vermont Standard",
    "Community News Service",
    "Waterbury Roundabout",
    "Chester Telegraph",
    "Newport Dispatch",
    "Cabot Chronicle",
    "East Montpelier Signpost",
    "Winooski News",
    "Town Meeting TV",
    "iBrattleboro",
    "Burlington Free Press",
    "The Rake Vermont",
    "Poultney Journal",
    "Magic 96.7 Vermont News",
    "The Vermont Cynic",
    "Stratton Magazine",
  ];
  for (const outletName of expectedLocalOutlets) {
    assert.match(sourceText, new RegExp(outletName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const kristinaBooleans = [
    '"Blue Cross VT"',
    '"blue cross" AND VT',
    '"blue cross" AND Vermont',
    '"bluecross" AND VT',
    '"bluecross" AND Vermont',
    '"BCBS" AND VT',
    '"bcbs" AND Vermont',
    '"BCBSVT"',
    '"Blue Cross and Blue Shield" AND Vermont',
    '"Blue Cross and Blue Shield" AND VT',
    '"Bluecross Blueshield" AND Vermont',
    'Vermont AND "healthcare"',
    'Vermont AND "health care"',
    'Vermont AND "hospitals"',
    '"health insurers"',
    '"health care" AND affordability',
    '"UVM Health"',
    '"MVP Health Care"',
  ];

  for (const booleanQuery of kristinaBooleans) {
    assert.ok(
      sourceText.includes(booleanQuery),
      `DEFAULT_SOURCES should include Kristina Boolean query: ${booleanQuery}`,
    );
  }
  assert.match(sourceText, /site:vermontbiz\.com/);
  assert.match(sourceText, /site:mountaintimes\.info/);

  const townNewsSourceNames = DEFAULT_SOURCES.filter(
    (source) => source.throttleGroup === "townnews-search",
  ).map((source) => source.name);
  assert.deepEqual(townNewsSourceNames, [
    "Rutland Herald",
    "Times Argus",
    "Times Argus UVM Health Search",
    "Bennington Banner",
    "Brattleboro Reformer",
    "Vermont Community Newspaper Group",
    "Newport Daily Express",
    "St. Albans Messenger",
    "Caledonian-Record",
    "Colchester Sun",
    "North Star Monthly",
    "Essex Reporter",
    "Manchester Journal",
    "Milton Independent",
    "Williston Observer",
  ]);
  for (const sourceName of townNewsSourceNames) {
    const source = DEFAULT_SOURCES.find((candidate) => candidate.name === sourceName);
    assert.equal(Number.isInteger(source.throttleDelayMs), true);
    assert.equal(source.throttleDelayMs > 0, true);
    assert.match(source.fallbackFeed?.feedUrl || "", /news\.google\.com\/rss\/search/);
  }
});

test("current Google News searches apply their freshness window to the full query", () => {
  const siteSearch = DEFAULT_SOURCES.find(
    (source) => source.name === "Google News Blue Cross Site Search",
  );
  const currentBlueCross = DEFAULT_SOURCES.find(
    (source) => source.name === "Google News Blue Cross Boolean Search A",
  );
  const vermontHealth = DEFAULT_SOURCES.filter(
    (source) => /^Google News Vermont Health Search [A-E]$/.test(source.name),
  );
  const siteSearchQuery = new URL(siteSearch.feedUrl).searchParams.get("q");
  const blueCrossQuery = new URL(currentBlueCross.feedUrl).searchParams.get("q");

  assert.match(siteSearchQuery, /site:bluecrossvt\.org/);
  assert.equal(siteSearchQuery.split(/\s+/).includes("bluecrossvt.org"), false);
  assert.match(blueCrossQuery, /\) when:30d$/);
  assert.equal(currentBlueCross.maxItemAgeDays, 30);
  assert.equal(vermontHealth.length, 5);

  const healthQueries = vermontHealth.map((source) =>
    new URL(source.feedUrl).searchParams.get("q"),
  );
  for (const [index, query] of healthQueries.entries()) {
    assert.match(query, /^\(.+\) when:7d$/);
    assert.ok(query.length <= 120, `${vermontHealth[index].name}: ${query.length}`);
    assert.equal(vermontHealth[index].maxItemAgeDays, 7);
  }

  const combinedQueries = healthQueries.join(" ");
  for (const term of [
    'Vermont AND "healthcare"',
    'Vermont AND "health care"',
    'Vermont AND "hospitals"',
    '"health insurers"',
    '"health care" AND affordability',
    '"UVM Health"',
    '"MVP Health Care"',
    '"Green Mountain Care Board"',
    '"Vermont health care"',
    '"Vermont hospital"',
    '"Vermont Medicaid"',
    '"Vermont Health Connect"',
    'DVHA',
    '"Vermont Department of Health"',
    '"health insurance premiums" AND Vermont',
    '"Medicare Advantage" AND Vermont',
  ]) {
    assert.ok(combinedQueries.includes(term), `missing health query: ${term}`);
  }
});

test("the Times Argus UVM fallback stays specialized and source-bounded", () => {
  const general = DEFAULT_SOURCES.find((source) => source.name === "Times Argus");
  const uvm = DEFAULT_SOURCES.find(
    (source) => source.name === "Times Argus UVM Health Search",
  );
  const generalQuery = new URL(general.fallbackFeed.feedUrl).searchParams.get("q");
  const uvmQuery = new URL(uvm.fallbackFeed.feedUrl).searchParams.get("q");

  assert.notEqual(uvmQuery, generalQuery);
  assert.match(uvmQuery, /site:timesargus\.com "UVM Health" when:30d/);
  assert.equal(uvm.maxItems, 20);
});

test("first-party listing sources fail closed when their parsers return nothing", () => {
  const listingSources = [
    "UVM Health Newsroom",
    "BCBSA Association News",
  ].map((name) => DEFAULT_SOURCES.find((source) => source.name === name));

  for (const source of listingSources) {
    assert.equal(source.minimumParsedItems, 1, source.name);
  }
  assert.equal(
    listingSources[0].listingUrl,
    "https://www.uvmhealth.org/newsroom/search",
  );
  assert.equal(listingSources[0].maxItems, 15);
});

test("parseFeedItems accepts publisher dates without a space before am or pm", () => {
  const [item] = parseFeedItems(
    `
      <rss><channel><item>
        <title>Health policy update</title>
        <link>https://www.fiercehealthcare.com/example</link>
        <pubDate>Jul 10, 2026 11:00am</pubDate>
      </item></channel></rss>
    `,
    { name: "Fierce Healthcare", feedUrl: "https://example.com/feed" },
  );

  // The publisher date carries no zone, so Date resolves it in the runner's
  // local zone. The feed itself always runs on ubuntu-latest, so production is
  // consistently UTC; assert the calendar parts so the test holds anywhere.
  assert.equal(item.pubDate?.getFullYear(), 2026);
  assert.equal(item.pubDate?.getMonth(), 6);
  assert.equal(item.pubDate?.getDate(), 10);
});

test("feed document validation accepts RSS, Atom, and RDF but rejects HTML", () => {
  assert.equal(isFeedDocument("<rss><channel /></rss>"), true);
  assert.equal(isFeedDocument('<feed xmlns="http://www.w3.org/2005/Atom" />'), true);
  assert.equal(
    isFeedDocument(
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" />',
    ),
    true,
  );
  assert.equal(isFeedDocument("<html><body>Checking your browser</body></html>"), false);
  assert.equal(isFeedDocument(""), false);
});

test("parseCnnHealthSitemapItems keeps current health URLs only", () => {
  const items = parseCnnHealthSitemapItems(
    `
      <urlset xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
        <url>
          <loc>https://www.cnn.com/2026/07/12/health/vermont-care-wellness</loc>
          <news:news><news:publication_date>2026-07-12T14:30:00Z</news:publication_date><news:title>Vermont health care update</news:title></news:news>
        </url>
        <url>
          <loc>https://www.cnn.com/2026/07/12/politics/example</loc>
          <news:news><news:publication_date>2026-07-12T13:00:00Z</news:publication_date><news:title>Political story</news:title></news:news>
        </url>
      </urlset>
    `,
    {
      name: "CNN Health",
      listingUrl: "https://www.cnn.com/sitemap/news.xml",
      scanArticle: false,
    },
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Vermont health care update");
  assert.equal(items[0].scanArticle, false);
  assert.equal(items[0].pubDate.toISOString(), "2026-07-12T14:30:00.000Z");
});

test("topic terms catch the healthcare stories the comms team pulls", () => {
  const cases = [
    ["UVM Health cuts 142 jobs as budget strains continue", "UVM Health"],
    ["Green Mountain Care Board reviews hospital budgets", "Green Mountain Care Board"],
    ["Regulators signal they aren't done asking hospitals to cut costs", "Hospitals"],
    ["Lawmakers Pass Bill Targeting Health Care Costs", "Health care"],
    ["Brattleboro hospital nurses vote to strike", "Hospital & nurse labor"],
    ["Vermont lawmakers advance limits on AI in mental health care", "Mental health"],
    ["Legislature approves prescription drug discount card proposal", "Prescription drugs & pharmacy"],
    ["Vermonters adjust to a landscape without Medicare Advantage", "Medicare Advantage"],
    ["Some Vermont doctors embrace the new direct primary care model", "Primary care"],
    ["BCBS, MVP Health Care request lower premium increases", "MVP Health Care"],
    ["Deadline approaches for Vermont to receive $195M for rural health care", "Rural health"],
    ["New community mental health center planned for Montpelier", "Mental health"],
    ["More than half of states have taken up menopause legislation", "Women's health"],
    ["The shortage of many medicines in the U.S. remains a systemic problem", "Prescription drugs & pharmacy"],
    ["Poll: Trust in federal health agencies dropped sharply", "Federal health agencies"],
    ["Inside the push to bring AI doctors into American medicine", "Health care AI"],
    ["Payers build digital health records for members", "Health records & interoperability"],
  ];

  for (const [headline, expectedTerm] of cases) {
    const matches = findMentionTerms(headline, TOPIC_TERMS);
    assert.ok(
      matches.includes(expectedTerm),
      `"${headline}" should match "${expectedTerm}", got: ${matches.join(", ")}`,
    );
  }
});

test("topic terms avoid product-marketing false positives", () => {
  const cases = [
    "Shenzhen Haiyuncheng Showcases Premium Waterproof Connector Solutions",
    "Forlong Medical Rolls Out Premium Certified Gauze Roll Series for Global Medical Wound Care Applications",
  ];

  for (const headline of cases) {
    assert.deepEqual(findMentionTerms(headline, TOPIC_TERMS), []);
  }
});

test("transport idiom strip covers named facilities and treatment phrasing", () => {
  // The Townshend crash story that leaked into production
  assert.deepEqual(
    findMentionTerms(
      "Three injured, one seriously, in Townshend crash. One person was airlifted to Dartmouth-Hitchcock Medical Center.",
      TOPIC_TERMS,
    ).filter((t) => t.includes("hospital") || t.includes("Hospital")),
    [],
  );
  assert.deepEqual(
    findMentionTerms(
      "Driver treated at a nearby hospital after the collision.",
      TOPIC_TERMS,
    ).filter((t) => t === "Hospitals"),
    [],
  );
  assert.deepEqual(
    findMentionTerms(
      "DUI driver sends teen biker to hospital after crash.",
      TOPIC_TERMS,
    ).filter((t) => t === "Hospitals"),
    [],
  );
  // Real institutional coverage still matches
  assert.ok(
    findMentionTerms(
      "Dartmouth-Hitchcock Medical Center announces new birthing pavilion program",
      TOPIC_TERMS,
    ).includes("Vermont hospitals & providers"),
  );
});

test("dedupeResolvedItems drops same link and same title+domain, keeps cross-outlet copies", () => {
  const items = [
    { link: "https://news.yahoo.com/uvm-cuts-142", title: "UVM Health eliminates 142 positions - Yahoo" },
    { link: "https://news.yahoo.com/uvm-cuts-142", title: "UVM Health eliminates 142 positions - Yahoo" },
    { link: "https://news.yahoo.com/uvm-cuts-142-alt", title: "UVM Health eliminates 142 positions - Yahoo" },
    { link: "https://www.wptz.com/uvm-cuts", title: "UVM Health eliminates 142 positions" },
    { link: "https://www.wcax.com/uvm-cuts", title: "UVM Health eliminates 142 positions" },
  ];
  const deduped = dedupeResolvedItems(items);
  assert.deepEqual(
    deduped.map((item) => item.link),
    [
      "https://news.yahoo.com/uvm-cuts-142",
      "https://www.wptz.com/uvm-cuts",
      "https://www.wcax.com/uvm-cuts",
    ],
  );
});

test("dedupeResolvedItems drops Google News wrappers when the outlet item exists", () => {
  const items = [
    {
      sourceName: "Google News Health Insurance Search",
      link: "https://news.google.com/rss/articles/example",
      title:
        "Major Medicare Advantage insurers appear to deny care for profit, federal watchdog finds - Healthcare Dive",
    },
    {
      sourceName: "Healthcare Dive",
      link: "https://www.healthcaredive.com/news/medicare-advantage-denials/",
      title:
        "Major Medicare Advantage insurers appear to deny care for profit, federal watchdog finds",
    },
  ];

  assert.deepEqual(
    dedupeResolvedItems(items).map((item) => item.link),
    ["https://www.healthcaredive.com/news/medicare-advantage-denials/"],
  );

  const numberedOutlet = [
    {
      sourceName: "Google News Vermont Health Search",
      link: "https://news.google.com/rss/articles/numbered-outlet",
      title: "Hospital announces new primary care clinic - ABC22 & FOX44",
    },
    {
      sourceName: "ABC22 & FOX44",
      link: "https://www.mychamplainvalley.com/news/primary-care-clinic/",
      title: "Hospital announces new primary care clinic",
    },
  ];
  assert.deepEqual(
    dedupeResolvedItems(numberedOutlet).map((item) => item.link),
    ["https://www.mychamplainvalley.com/news/primary-care-clinic/"],
  );
});

test("dedupe strips known tracking parameters but preserves semantic queries", () => {
  const direct = {
    sourceName: "STAT Health News",
    title: "STAT+: A suspicious denial pattern",
    link: "https://www.statnews.com/2026/07/20/denials/?utm_campaign=rss&utm_source=feed#top",
  };
  const search = {
    sourceName: "Google News Health Trade Search",
    title: "A suspicious denial pattern in Medicare Advantage - STAT",
    link: "https://www.statnews.com/2026/07/20/denials/",
  };
  const pages = [
    { sourceName: "Example", title: "Directory page 1", link: "https://example.com/directory?page=1" },
    { sourceName: "Example", title: "Directory page 2", link: "https://example.com/directory?page=2" },
  ];

  assert.deepEqual(dedupeResolvedItems([search, direct]), [direct]);
  assert.equal(dedupeResolvedItems(pages).length, 2);
});

test("tracking-link dedupe merges evidence and is independent of input order", () => {
  const curated = {
    sourceName: "Media Tracker Backfill",
    trackerOutlet: "VTDigger",
    fromMediaTracker: true,
    matchSource: "mediaTracker",
    title: "Blue Cross VT files 2027 rates",
    link: "https://vtdigger.org/2026/08/27/rates?utm_source=tracker",
    matchedTerms: ["Blue Cross VT"],
  };
  const enriched = {
    sourceName: "VTDigger",
    title: "Blue Cross VT files 2027 rates",
    link: "https://vtdigger.org/2026/08/27/rates",
    matchedTerms: ["Premiums & rate review"],
    snippet: "The filing proposes new individual market premiums.",
    previewText: "Regulators will review the proposal this fall.",
    summary: "BCBSVT filed its proposed 2027 rates.",
    relevant: true,
  };

  const forward = dedupeResolvedItems([curated, enriched]);
  const reverse = dedupeResolvedItems([enriched, curated]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.length, 1);
  assert.equal(forward[0].link, curated.link);
  assert.equal(forward[0].fromMediaTracker, true);
  assert.equal(forward[0].snippet, enriched.snippet);
  assert.equal(forward[0].previewText, enriched.previewText);
  assert.equal(forward[0].summary, enriched.summary);
  assert.deepEqual(forward[0].matchedTerms, [
    "Blue Cross VT",
    "Premiums & rate review",
  ]);

  const tracked = {
    sourceName: "Example",
    title: "Vermont hospital rate review",
    link: "https://example.com/rates?utm_campaign=rss",
    matchedTerms: ["Hospitals"],
  };
  const clean = {
    ...tracked,
    link: "https://example.com/rates",
    snippet: "The regulator opened a rate review.",
  };
  assert.deepEqual(
    dedupeResolvedItems([tracked, clean]),
    dedupeResolvedItems([clean, tracked]),
  );
  assert.equal(dedupeResolvedItems([tracked, clean])[0].link, clean.link);
});

test("a curated same-title clip does not erase a different direct outlet", () => {
  const direct = {
    sourceName: "WCAX",
    title: "Shared health policy headline",
    link: "https://www.wcax.com/2026/08/27/shared",
  };
  const curated = {
    sourceName: "Media Tracker Backfill",
    trackerOutlet: "VT Digger",
    fromMediaTracker: true,
    title: "Shared health policy headline",
    link: "https://vtdigger.org/2026/08/27/shared",
  };

  assert.equal(dedupeResolvedItems([direct, curated]).length, 2);
  assert.equal(dedupeResolvedItems([curated, direct]).length, 2);
});

test("parseSummaryResponse applies the relevance verdict", () => {
  const batch = [
    { title: "Texas shooting", snippet: "x" },
    { title: "GMCB hearing", snippet: "y" },
    { title: "No verdict story", snippet: "z" },
  ];
  parseSummaryResponse(
    JSON.stringify([
      { id: 1, summary: "A shooting.", reason: "Not health care", relevant: false },
      { id: 2, summary: "Rate hearing.", reason: "Regulator action", relevant: true },
      { id: 3, summary: "Something.", reason: "..." },
    ]),
    batch,
  );
  assert.equal(batch[0].relevant, false);
  assert.equal(batch[1].relevant, true);
  // Missing verdict defaults to relevant — only explicit false excludes
  assert.equal(batch[2].relevant, true);
});

test("deterministic relevance rejects out-of-region low-priority false positives", () => {
  const rejected = [
    {
      sourceName: "MyNBC5",
      title: "Suspect dead after Texas shooting kills 1 and leaves 9 injured",
      description: "Those injured were taken to the hospital.",
      matchedTerms: ["Hospitals"],
      category: CATEGORY_TOPIC,
    },
    {
      sourceName: "MyChamplainValley",
      title: "Massive measles outbreak in Virginia county continues to grow",
      description: "Officials advise unvaccinated people to avoid gatherings.",
      matchedTerms: ["Vaccines"],
      category: CATEGORY_TOPIC,
    },
  ];

  for (const item of rejected) {
    assert.equal(applyDeterministicRelevance(item).relevant, false);
  }

  assert.equal(
    applyDeterministicRelevance({
      sourceName: "Google News Health Insurance Search",
      title:
        "Major Medicare Advantage insurers appear to deny care for profit, federal watchdog finds",
      description: "The report concerns insurer practices.",
      matchedTerms: ["Medicare Advantage", "Health insurance"],
      category: CATEGORY_TOPIC,
    }).relevant,
    undefined,
  );

  assert.equal(
    applyDeterministicRelevance({
      sourceName: "MyChamplainValley",
      title:
        "Northern Border Regional Commission grants announced for Vermont",
      description:
        "The awards support water, transportation, and healthcare improvements.",
      matchedTerms: ["Health care"],
      category: CATEGORY_TOPIC,
    }).relevant,
    false,
  );

  assert.equal(
    applyDeterministicRelevance({
      sourceName: "Vermont Daily Chronicle",
      title:
        "Deadline approaches for Vermont to receive $195M for rural health care",
      description:
        "Federal funding would support rural health care access for patients.",
      matchedTerms: ["Rural health"],
      category: CATEGORY_TOPIC,
    }).relevant,
    undefined,
  );

  assert.equal(
    applyDeterministicRelevance({
      sourceName: "Google News Health Trade Search",
      title: "CMS proposes new deadlines for prior authorizations for drugs",
      description: "Federal policy update affects coverage operations.",
      matchedTerms: ["Health care", "Prior authorization & claims"],
      category: CATEGORY_TOPIC,
      relevant: false,
      reason: "Low-priority health mention outside Vermont or New England.",
    }).relevant,
    undefined,
  );

  assert.equal(
    applyDeterministicRelevance({
      sourceName: "CNN Health",
      title: "The best coupons at CVS Pharmacy",
      description: "A shopping coupon page.",
      matchedTerms: ["Prescription drugs & pharmacy"],
      category: CATEGORY_TOPIC,
    }).relevant,
    false,
  );

  assert.equal(
    applyDeterministicRelevance({
      sourceName: "CBS News Health",
      title:
        'Americans on health insurance: "I pay a lot of money for and it covers very little"',
      description:
        "Consumers describe frustration with what their insurance covers.",
      matchedTerms: ["Health insurance"],
      category: CATEGORY_TOPIC,
    }).relevant,
    undefined,
  );

  assert.equal(
    applyDeterministicRelevance({
      sourceName: "Fierce Healthcare",
      title: "Virtual care tech companies launch RPM tool for pharmacies",
      description:
        "The program helps pharmacies support chronic care patients between visits.",
      matchedTerms: ["Prescription drugs & pharmacy"],
      category: CATEGORY_TOPIC,
    }).relevant,
    false,
  );

  assert.equal(
    applyDeterministicRelevance({
      sourceName: "KFF Health News",
      title:
        "California Health Worker Union, Hospital Association Tout Dueling Ballot Initiatives",
      description:
        "Get our weekly newsletter with a roundup of original coverage.",
      matchedTerms: ["Hospitals", "Hospital & nurse labor"],
      category: CATEGORY_TOPIC,
    }).relevant,
    false,
  );

  assert.equal(
    applyDeterministicRelevance({
      sourceName: "Google News National Health Policy Search",
      title: "Surprising ways menopause can affect your mouth",
      description: "Wellness advice from a national outlet.",
      matchedTerms: ["Women's health"],
      category: CATEGORY_TOPIC,
    }).relevant,
    false,
  );

  assert.equal(
    applyDeterministicRelevance({
      sourceName: "Fierce Healthcare",
      title:
        "AHIP 2026: Why Ascendiun CEO is bullish on building digital health records",
      description:
        "AHIP discussion of health records and interoperability for patients.",
      matchedTerms: ["Health records & interoperability"],
      category: CATEGORY_TOPIC,
    }).relevant,
    undefined,
  );

  // An in-state crash brief that only name-drops a hospital is still a low
  // priority false positive. The out-of-region rule cannot catch it, because
  // Townshend supplies a genuine Vermont signal, so the crash-brief rule
  // rejects it on the incidental provider mention instead.
  const townshendCrash = applyDeterministicRelevance({
    sourceName: "MyChamplainValley",
    title: "Three injured, one seriously, in Townshend crash",
    description: "One person was airlifted to Dartmouth-Hitchcock Medical Center.",
    matchedTerms: ["Vermont hospitals & providers"],
    category: CATEGORY_TOPIC,
  });
  assert.equal(townshendCrash.relevant, false);
  assert.equal(
    townshendCrash.reason,
    "Crime or crash brief with only an incidental provider mention.",
  );
});

test("failure streaks retry pending alerts and stop after endpoint delivery", () => {
  const endpointIds = ["endpoint-a", "endpoint-b"];
  const previous = new Map([
    ["Flaky Facebook", 23],
    ["Recovered Outlet", 9],
  ]);
  const results = applyFailureStreaks(
    [
      { name: "Flaky Facebook", ok: false, error: "HTTP 500" },
      { name: "Recovered Outlet", ok: true, itemCount: 12 },
      { name: "Newly Broken", ok: false, error: "timeout" },
      { name: "Skipped Backfill", ok: true, skipped: true, itemCount: 0 },
    ],
    previous,
  );

  assert.equal(results[0].consecutiveFailures, 24);
  assert.equal(results[1].consecutiveFailures, 0);
  assert.equal(results[2].consecutiveFailures, 1);
  assert.equal(results[3].consecutiveFailures, 0);

  // A failed delivery remains pending after the threshold run.
  assert.deepEqual(
    selectFailureAlerts(results, 24, endpointIds).map((result) => result.name),
    ["Flaky Facebook"],
  );
  const retry = applyFailureStreaks(
    [{ name: "Flaky Facebook", ok: false, error: "HTTP 500" }],
    new Map([["Flaky Facebook", 24]]),
  );
  assert.deepEqual(
    selectFailureAlerts(retry, 24, endpointIds).map((result) => result.name),
    ["Flaky Facebook"],
  );

  const delivered = applyFailureStreaks(
    [{ name: "Flaky Facebook", ok: false, error: "HTTP 500" }],
    new Map([["Flaky Facebook", 25]]),
    new Map([["Flaky Facebook", endpointIds]]),
  );
  assert.deepEqual(selectFailureAlerts(delivered, 24, endpointIds), []);
});

test("rotating a webhook creates a new alert delivery target", () => {
  const oldTargetId = webhookTargetId("https://hooks.example/old-secret");
  const newTargetId = webhookTargetId("https://hooks.example/new-secret");
  const [failed] = applyFailureStreaks(
    [{ name: "Flaky Facebook", ok: false, error: "HTTP 500" }],
    new Map([["Flaky Facebook", 24]]),
    new Map([["Flaky Facebook", [oldTargetId]]]),
  );

  assert.deepEqual(selectFailureAlerts([failed], 24, [oldTargetId]), []);
  assert.deepEqual(selectFailureAlerts([failed], 24, [newTargetId]), [failed]);
  assert.notEqual(oldTargetId, newTargetId);
  assert.doesNotMatch(oldTargetId, /slack|discord/i);
});

test("webhooks reject HTTP failures and send configured endpoints concurrently", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const originalSlack = process.env.SLACK_WEBHOOK_URL;
  const originalDiscord = process.env.DISCORD_WEBHOOK_URL;
  const calls = [];
  const logs = [];
  const errors = [];
  let active = 0;
  let maxActive = 0;

  process.env.SLACK_WEBHOOK_URL = "https://hooks.example/slack";
  process.env.DISCORD_WEBHOOK_URL = "https://hooks.example/discord";
  globalThis.fetch = async (url) => {
    calls.push(url);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return url.endsWith("/slack")
      ? new Response("rate limited", { status: 429 })
      : new Response(null, { status: 204 });
  };
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));

  try {
    const failedSource = {
      name: "Broken Outlet",
      consecutiveFailures: 24,
      error: "HTTP 500",
    };
    await triggerWebhooks([failedSource]);
    assert.deepEqual(failedSource.failureAlertDeliveries, [
      webhookTargetId("https://hooks.example/discord"),
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    if (originalSlack === undefined) {
      delete process.env.SLACK_WEBHOOK_URL;
    } else {
      process.env.SLACK_WEBHOOK_URL = originalSlack;
    }
    if (originalDiscord === undefined) {
      delete process.env.DISCORD_WEBHOOK_URL;
    } else {
      process.env.DISCORD_WEBHOOK_URL = originalDiscord;
    }
  }

  assert.deepEqual(calls.sort(), [
    "https://hooks.example/discord",
    "https://hooks.example/slack",
  ]);
  assert.equal(maxActive, 2, "both webhook requests should overlap");
  assert.ok(errors.some((message) => /Slack.*HTTP 429/.test(message)));
  assert.ok(!logs.some((message) => /Slack/.test(message)));
  assert.ok(logs.some((message) => /Discord/.test(message)));
});

test("failure alert messages stay within webhook payload limits", () => {
  const failedSources = Array.from({ length: 99 }, (_, index) => ({
    name: `Source ${index + 1}`,
    consecutiveFailures: 24,
    error: "A long repeated failure description ".repeat(12),
  }));
  const messages = buildFailureAlertMessages(failedSources, 24, 600);
  assert.ok(messages.length > 1);
  assert.ok(messages.every((message) => message.length <= 600));
  assert.ok(messages.every((message) => /Sources failing for 24\+/.test(message)));
});

test("a partial webhook delivery retries only sources in unsent chunks", async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const failedSources = Array.from({ length: 20 }, (_, index) => ({
    name: `Source ${index + 1}`,
    consecutiveFailures: 24,
    error: "A long repeated failure description ".repeat(12),
  }));
  const target = {
    id: webhookTargetId("https://hooks.example/slack"),
    label: "Slack",
    url: "https://hooks.example/slack",
    payloadKey: "text",
  };
  let calls = 0;
  console.error = () => {};
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1
      ? new Response(null, { status: 204 })
      : new Response("failed", { status: 500 });
  };

  try {
    await triggerWebhooks(failedSources, [target]);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
  }

  const delivered = failedSources.filter(
    (source) => source.failureAlertDeliveries?.includes(target.id),
  );
  const pending = selectFailureAlerts(failedSources, 24, [target.id]);
  assert.ok(delivered.length > 0);
  assert.ok(pending.length > 0);
  assert.equal(delivered.length + pending.length, failedSources.length);
});

test("generateFeed waits for a started failure alert before returning", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalSlack = process.env.SLACK_WEBHOOK_URL;
  const originalDiscord = process.env.DISCORD_WEBHOOK_URL;
  const workdir = await mkdtemp(path.join(tmpdir(), "vt-news-webhook-join-"));
  const rssOutputPath = path.join(workdir, "feed.rss");
  const jsonOutputPath = path.join(workdir, "feed.json");
  const auditJsonOutputPath = path.join(workdir, "feed-audit.json");
  await writeFile(
    auditJsonOutputPath,
    JSON.stringify({
      generatedAt: "2026-08-27T00:00:00Z",
      sources: [{ name: "Missing Seed", consecutiveFailures: 23 }],
      items: [],
    }),
  );

  let releaseWebhook;
  let markWebhookStarted;
  let generationSettled = false;
  const webhookStarted = new Promise((resolve) => {
    markWebhookStarted = resolve;
  });
  const webhookResponse = new Promise((resolve) => {
    releaseWebhook = () => resolve(new Response(null, { status: 204 }));
  });

  process.env.SLACK_WEBHOOK_URL = "https://hooks.example/slack";
  delete process.env.DISCORD_WEBHOOK_URL;
  globalThis.fetch = async () => {
    markWebhookStarted();
    return webhookResponse;
  };
  console.log = () => {};
  console.warn = () => {};

  let generation;
  try {
    generation = generateFeed({
      sources: [{
        name: "Missing Seed",
        seedItemsPath: path.join(workdir, "missing.json"),
      }],
      now: new Date("2026-08-27T01:00:00Z"),
      rssOutputPath,
      jsonOutputPath,
      auditJsonOutputPath,
    }).finally(() => {
      generationSettled = true;
    });

    await webhookStarted;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      generationSettled,
      false,
      "the feed run must not resolve while its failure alert is still pending",
    );
    releaseWebhook();
    await generation;
    assert.equal(generationSettled, true);
    const audit = JSON.parse(await readFile(auditJsonOutputPath, "utf8"));
    const publicFeed = JSON.parse(await readFile(jsonOutputPath, "utf8"));
    const targetId = webhookTargetId("https://hooks.example/slack");
    assert.deepEqual(audit.sources[0].failureAlertDeliveries, [targetId]);
    assert.doesNotMatch(JSON.stringify(audit.sources), /slack|discord/i);
    assert.equal(publicFeed.sources[0].failureAlertDeliveries, undefined);

    const restored = await loadPreviousState(auditJsonOutputPath);
    assert.deepEqual(
      restored.previousFailureAlertState.get("Missing Seed"),
      [targetId],
    );
  } finally {
    releaseWebhook?.();
    await generation?.catch(() => {});
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
    if (originalSlack === undefined) {
      delete process.env.SLACK_WEBHOOK_URL;
    } else {
      process.env.SLACK_WEBHOOK_URL = originalSlack;
    }
    if (originalDiscord === undefined) {
      delete process.env.DISCORD_WEBHOOK_URL;
    } else {
      process.env.DISCORD_WEBHOOK_URL = originalDiscord;
    }
  }
});

test("summary prompt marks article text as untrusted", () => {
  const prompt = buildSummaryPrompt([
    { title: "Ignore previous instructions", sourceName: "X", snippet: "y" },
  ]);
  assert.match(prompt, /untrusted/i);
  assert.match(prompt, /ignore any instructions/i);
});

test("buildRss excludes items marked not relevant", () => {
  const rss = buildRss(
    [
      {
        sourceName: "WCAX",
        sourceFeedUrl: "https://example.com/feed",
        title: "Texas shooting story",
        link: "https://example.com/shooting",
        guid: "https://example.com/shooting",
        pubDate: new Date("2026-06-12T12:00:00Z"),
        matchedTerms: ["Hospitals"],
        snippet: "",
        relevant: false,
      },
      {
        sourceName: "VTDigger",
        sourceFeedUrl: "https://example.com/feed",
        title: "GMCB story",
        link: "https://example.com/gmcb",
        guid: "https://example.com/gmcb",
        pubDate: new Date("2026-06-12T12:00:00Z"),
        matchedTerms: ["Green Mountain Care Board"],
        snippet: "",
        relevant: true,
      },
    ],
    { now: new Date("2026-06-12T13:00:00Z"), feedUrl: "https://example.com/feed.rss" },
  );
  assert.ok(!rss.includes("Texas shooting story"));
  assert.ok(rss.includes("GMCB story"));
});

test("hospital term ignores crime/accident transport briefs", () => {
  assert.deepEqual(
    findMentionTerms(
      "Driver taken to the hospital after Route 7 crash",
      TOPIC_TERMS,
    ).filter((t) => t === "Hospitals"),
    [],
  );
  // But a real hospital story still matches even with the idiom present
  assert.ok(
    findMentionTerms(
      "Patient taken to the hospital sues hospital over billing practices",
      TOPIC_TERMS,
    ).includes("Hospitals"),
  );
});

test("categorizeTerms separates brand from topic stories", () => {
  assert.equal(categorizeTerms(["BCBSVT", "Health care"]), CATEGORY_BRAND);
  assert.equal(categorizeTerms(["Hospitals", "Medicaid"]), CATEGORY_TOPIC);
});

test("summary prompt and response round-trip applies summaries", () => {
  const batch = [
    {
      title: "UVM Health cuts 142 jobs",
      sourceName: "VTDigger",
      matchedTerms: ["UVM Health"],
      snippet: "The network said the cuts save $9 million.",
    },
    {
      title: "Rate filing story",
      sourceName: "WCAX",
      matchedTerms: ["BCBSVT"],
      snippet: "Blue Cross filed rates.",
    },
  ];

  const prompt = buildSummaryPrompt(batch);
  assert.match(prompt, /ARTICLE 1/);
  assert.match(prompt, /UVM Health cuts 142 jobs/);
  assert.match(prompt, /ARTICLE 2/);

  const applied = parseSummaryResponse(
    JSON.stringify([
      { id: 1, summary: "UVM cut jobs.", reason: "Provider cost pressure" },
      { id: 2, summary: "Rates filed.", reason: "Names BCBSVT" },
    ]),
    batch,
  );
  assert.equal(applied, 2);
  assert.equal(batch[0].summary, "UVM cut jobs.");
  assert.equal(batch[1].reason, "Names BCBSVT");

  // Malformed responses apply nothing and don't throw
  assert.equal(parseSummaryResponse("not json", batch), 0);
  assert.equal(parseSummaryResponse('{"a":1}', batch), 0);
});

test("geminiGenerate retries a rate limit using the API retry delay", async () => {
  const responses = [
    new Response(
      JSON.stringify({
        error: {
          message: "Rate limit reached",
        },
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "2",
        },
      },
    ),
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "[]" }] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  ];
  const sleeps = [];
  const result = await geminiGenerate("prompt", {
    apiKey: "test-key",
    models: ["test-model"],
    fetchImpl: async () => responses.shift(),
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
    random: () => 0,
  });

  assert.equal(result, "[]");
  assert.deepEqual(sleeps, [2000]);
});

test("geminiGenerate honors a structured RetryInfo delay", async () => {
  const responses = [
    new Response(
      JSON.stringify({
        error: {
          message: "Quota exhausted",
          details: [{
            "@type": "type.googleapis.com/google.rpc.RetryInfo",
            retryDelay: "55s",
          }],
        },
      }),
      { status: 429, headers: { "content-type": "application/json" } },
    ),
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: "[]" }] } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  ];
  const sleeps = [];
  const result = await geminiGenerate("prompt", {
    apiKey: "test-key",
    models: ["test-model"],
    fetchImpl: async () => responses.shift(),
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
    random: () => 0,
    retryMaxDelayMs: 60_000,
  });

  assert.equal(result, "[]");
  assert.deepEqual(sleeps, [55_000]);
});

test("geminiGenerate retries transient server errors but not client errors", async () => {
  let serverCalls = 0;
  const sleeps = [];
  const result = await geminiGenerate("prompt", {
    apiKey: "test-key",
    models: ["test-model"],
    fetchImpl: async () => {
      serverCalls += 1;
      if (serverCalls === 1) {
        return new Response("server error", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
    random: () => 0,
    retryBaseDelayMs: 100,
  });
  assert.equal(result, "ok");
  assert.equal(serverCalls, 2);
  assert.deepEqual(sleeps, [100]);

  let clientCalls = 0;
  await assert.rejects(
    geminiGenerate("prompt", {
      apiKey: "test-key",
      models: ["test-model", "must-not-run"],
      fetchImpl: async () => {
        clientCalls += 1;
        return new Response("bad request", { status: 400 });
      },
      sleepImpl: async () => assert.fail("400 must not sleep or retry"),
    }),
    /HTTP 400/,
  );
  assert.equal(clientCalls, 1);

  let missingModelCalls = 0;
  const fallbackResult = await geminiGenerate("prompt", {
    apiKey: "test-key",
    models: ["missing-model", "fallback-model"],
    fetchImpl: async () => {
      missingModelCalls += 1;
      if (missingModelCalls === 1) {
        return new Response("model not found", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "fallback" }] } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    sleepImpl: async () => assert.fail("404 fallback must not sleep"),
  });
  assert.equal(fallbackResult, "fallback");
  assert.equal(missingModelCalls, 2);
});

test("geminiGenerate treats every 5xx status as transient", async () => {
  for (const status of [520, 599]) {
    let calls = 0;
    const result = await geminiGenerate("prompt", {
      apiKey: "test-key",
      models: ["test-model"],
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("temporary server error", { status });
        }
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "ok" }] } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      sleepImpl: async () => {},
      random: () => 0,
    });
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  }
});

test("geminiGenerate bounds retry attempts and sleep", async () => {
  let calls = 0;
  const sleeps = [];
  await assert.rejects(
    geminiGenerate("prompt", {
      apiKey: "test-key",
      models: ["test-model"],
      fetchImpl: async () => {
        calls += 1;
        return new Response("rate limited", { status: 429 });
      },
      sleepImpl: async (milliseconds) => sleeps.push(milliseconds),
      random: () => 0,
      maxAttemptsPerModel: 3,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 150,
    }),
    /HTTP 429/,
  );
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [100, 150]);
});

test("mergeWithArchive keeps stories that left their source feeds", () => {
  const now = new Date("2026-06-12T12:00:00Z");
  const current = [
    {
      link: "https://example.com/new",
      title: "Blue Cross new story",
      pubDate: new Date("2026-06-11T12:00:00Z"),
      summary: "",
    },
    {
      link: "https://example.com/shared",
      title: "Updated Blue Cross story",
      pubDate: new Date("2026-06-10T12:00:00Z"),
      summary: "fresh",
    },
  ];
  const archived = [
    {
      link: "https://example.com/shared",
      title: "Old Blue Cross version",
      pubDate: new Date("2026-06-10T12:00:00Z"),
      summary: "stale",
    },
    {
      link: "https://example.com/old-but-kept",
      title: "UVM Health story fell out of feed",
      pubDate: new Date("2026-05-01T12:00:00Z"),
      summary: "kept",
    },
    {
      link: "https://example.com/ancient",
      title: "Ancient UVM Health story",
      pubDate: new Date("2024-01-01T12:00:00Z"),
      summary: "pruned",
    },
    {
      link: "https://example.com/ancient-brand",
      title: "Ancient Blue Cross VT story",
      pubDate: new Date("2024-01-01T12:00:00Z"),
      matchedTerms: ["BCBSVT"],
      summary: "kept indefinitely",
    },
    {
      link: "https://example.com/false-positive",
      title: "Premium connector",
      pubDate: new Date("2026-06-10T12:00:00Z"),
      reason: "Irrelevant; keyword match is a false positive.",
    },
    {
      link: "https://example.com/online_features/press_releases/topic-wire.html",
      title: "Medical product wire",
      pubDate: new Date("2026-06-10T12:00:00Z"),
      matchedTerms: ["Health care"],
    },
    {
      link: "https://example.com/online_features/press_releases/brand-wire.html",
      title: "BCBSVT wire",
      pubDate: new Date("2026-06-10T12:00:00Z"),
      matchedTerms: ["BCBSVT"],
    },
    {
      link: "https://example.com/stale-federal-agency-match",
      title: "FDA issues emergency use authorization to treat dogs and cats",
      pubDate: new Date("2026-06-10T12:00:00Z"),
      matchedTerms: ["Federal health agencies"],
    },
    {
      link: "https://example.com/search-fallback",
      title: "Implicit brand search result",
      pubDate: new Date("2026-06-10T12:00:00Z"),
      matchedTerms: ["Blue Cross"],
      matchSource: "searchFallback",
    },
  ];

  const merged = mergeWithArchive(current, archived, now);
  const links = merged.map((item) => item.link).sort();
  assert.deepEqual(links, [
    "https://example.com/ancient-brand",
    "https://example.com/new",
    "https://example.com/old-but-kept",
    "https://example.com/online_features/press_releases/brand-wire.html",
    "https://example.com/search-fallback",
    "https://example.com/shared",
  ]);
  const shared = merged.find((item) => item.link === "https://example.com/shared");
  assert.equal(shared.summary, "fresh");
});

test("undated topic retention uses a stable first-seen date", () => {
  const firstRun = new Date("2026-01-01T12:00:00Z");
  const [newItem] = mergeWithArchive(
    [{
      link: "https://example.com/undated-topic",
      title: "Health care policy briefing",
      pubDate: null,
      matchedTerms: ["Health care"],
    }],
    [],
    firstRun,
  );
  assert.equal(newItem.firstSeenAt.toISOString(), firstRun.toISOString());

  const oneDayLater = new Date("2026-01-02T12:00:00Z");
  const [rediscovered] = mergeWithArchive(
    [{ ...newItem, firstSeenAt: undefined }],
    [newItem],
    oneDayLater,
  );
  assert.equal(rediscovered.firstSeenAt.toISOString(), firstRun.toISOString());

  const afterRetention = new Date("2026-04-04T12:00:00Z");
  assert.deepEqual(mergeWithArchive([], [rediscovered], afterRetention), []);
  assert.equal(
    mergeWithArchive(
      [],
      [{ ...rediscovered, fromMediaTracker: true }],
      afterRetention,
    ).length,
    1,
  );
});

test("loadPreviousState migrates first-seen from the archive timestamp", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "vt-news-first-seen-"));
  const auditPath = path.join(workdir, "feed-audit.json");
  await writeFile(
    auditPath,
    JSON.stringify({
      generatedAt: "2026-08-27T12:00:00Z",
      sources: [],
      items: [{
        title: "Undated health care item",
        link: "https://example.com/undated",
        matchedTerms: ["Health care"],
      }],
    }),
  );

  const state = await loadPreviousState(auditPath);
  assert.equal(
    state.archivedItems[0].firstSeenAt.toISOString(),
    "2026-08-27T12:00:00.000Z",
  );
});

test("loadPreviousState falls back when the preferred archive has no items array", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "vt-news-archive-fallback-"));
  const preferredPath = path.join(workdir, "feed-audit.json");
  const fallbackPath = path.join(workdir, "feed.json");
  await writeFile(
    preferredPath,
    JSON.stringify({ generatedAt: "2026-08-27T00:00:00Z", sources: [] }),
  );
  await writeFile(
    fallbackPath,
    JSON.stringify({
      generatedAt: "2026-08-27T00:00:00Z",
      sources: [],
      items: [{
        title: "Valid fallback item",
        link: "https://example.com/valid-fallback",
        matchedTerms: ["BCBSVT"],
        relevant: true,
      }],
    }),
  );

  const state = await loadPreviousState(preferredPath, fallbackPath);
  assert.equal(state.cache.size, 1);
  assert.deepEqual(
    state.archivedItems.map((item) => item.title),
    ["Valid fallback item"],
  );
});

test("generateFeed drops obituaries loaded from the archive", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "vt-news-archive-obit-"));
  const rssOutputPath = path.join(workdir, "feed.rss");
  const jsonOutputPath = path.join(workdir, "feed.json");
  const auditJsonOutputPath = path.join(workdir, "feed-audit.json");
  await writeFile(
    auditJsonOutputPath,
    JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      generatedAt: "2026-06-16T16:10:08.282Z",
      sources: [],
      items: [
        {
          title: "David Jon Bursey, 77, of Monkton",
          link: "https://www.addisonindependent.com/2026/06/16/david-jon-bursey-77-of-monkton/",
          guid: "obit-1",
          pubDate: "2026-06-16T16:10:08.000Z",
          sourceName: "Addison Independent",
          matchedTerms: ["UVM Health"],
          summary: "This article is an obituary for David Jon Bursey.",
          content_text:
            "This article is an obituary for David Jon Bursey, who passed away at UVM Medical Center.",
        },
        {
          title: "UVM Health announces new primary care clinic",
          link: "https://example.com/uvm-health-primary-care",
          guid: "story-1",
          pubDate: "2026-06-16T15:10:08.000Z",
          sourceName: "Example",
          matchedTerms: ["UVM Health"],
          summary: "UVM Health announced a new primary care clinic.",
          relevant: true,
        },
      ],
    }),
  );

  await generateFeed({
    sources: [],
    now: new Date("2026-06-16T16:30:00Z"),
    rssOutputPath,
    jsonOutputPath,
    auditJsonOutputPath,
  });

  const output = JSON.parse(await readFile(auditJsonOutputPath, "utf8"));
  assert.deepEqual(
    output.items.map((item) => item.title),
    ["UVM Health announces new primary care clinic"],
  );
});

test("generateFeed drops archived social items when social sources are disabled", async () => {
  const originalEnabled = process.env.ENABLE_SOCIAL_SOURCES;
  delete process.env.ENABLE_SOCIAL_SOURCES;

  const workdir = await mkdtemp(path.join(tmpdir(), "vt-news-archive-social-"));
  const rssOutputPath = path.join(workdir, "feed.rss");
  const jsonOutputPath = path.join(workdir, "feed.json");
  const auditJsonOutputPath = path.join(workdir, "feed-audit.json");
  await writeFile(
    auditJsonOutputPath,
    JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      generatedAt: "2026-06-16T16:10:08.282Z",
      sources: [],
      items: [
        {
          title: "VTDigger Facebook post: Blue Cross VT update",
          link: "https://www.facebook.com/vtdigger/posts/123",
          guid: "social-1",
          pubDate: "2026-06-16T16:10:08.000Z",
          sourceName: "VTDigger Facebook",
          sourceFeedUrl: "https://www.facebook.com/vtdigger",
          matchedTerms: ["Blue Cross VT"],
          summary: "A social post about Blue Cross VT.",
          relevant: true,
        },
        {
          title: "Blue Cross VT rate filing",
          link: "https://example.com/blue-cross-vt-rate-filing",
          guid: "story-1",
          pubDate: "2026-06-16T15:10:08.000Z",
          sourceName: "Example",
          matchedTerms: ["Blue Cross VT"],
          summary: "A news story about Blue Cross VT.",
          relevant: true,
        },
      ],
    }),
  );

  try {
    await generateFeed({
      sources: [],
      now: new Date("2026-06-16T16:30:00Z"),
      rssOutputPath,
      jsonOutputPath,
      auditJsonOutputPath,
    });

    const output = JSON.parse(await readFile(auditJsonOutputPath, "utf8"));
    assert.deepEqual(
      output.items.map((item) => item.title),
      ["Blue Cross VT rate filing"],
    );
  } finally {
    if (originalEnabled === undefined) {
      delete process.env.ENABLE_SOCIAL_SOURCES;
    } else {
      process.env.ENABLE_SOCIAL_SOURCES = originalEnabled;
    }
  }
});

test("mergeWithArchive drops future-dated stories beyond clock skew", () => {
  const now = new Date("2026-06-12T12:00:00Z");
  const merged = mergeWithArchive(
    [
      {
        link: "https://example.com/future",
        title: "Future Blue Cross story",
        pubDate: new Date("2026-06-14T12:00:00Z"),
      },
      {
        link: "https://example.com/current",
        title: "Current Blue Cross story",
        pubDate: new Date("2026-06-12T12:00:00Z"),
      },
    ],
    [
      {
        link: "https://example.com/archived-future",
        title: "Archived future Blue Cross story",
        pubDate: new Date("2026-06-15T12:00:00Z"),
      },
    ],
    now,
  );

  assert.deepEqual(
    merged.map((item) => item.link),
    ["https://example.com/current"],
  );
});

test("collectFeedItems skips sources whose date window has closed", async () => {
  // Closed-window sources are skipped before any fetch, so this test runs
  // with zero network access.
  const expired = {
    name: "Google News Blue Cross VT Backfill Since Jan 1 2026",
    feedUrl: "https://news.google.com/rss/search?q=backfill",
    minPubDate: "2026-01-01T00:00:00Z",
    maxPubDate: "2026-06-13T00:00:00Z",
  };

  const expiredToo = {
    ...expired,
    name: "Second Closed Window",
    feedUrl: "https://news.google.com/rss/search?q=other",
  };
  const { items, sourceResults } = await collectFeedItems(
    [expired, expiredToo],
    new Date("2026-06-14T12:00:00Z"),
  );

  assert.deepEqual(items, []);
  // Results stay in source-list order even though sources fetch concurrently.
  assert.deepEqual(
    sourceResults.map((result) => result.name),
    [expired.name, expiredToo.name],
  );
  assert.equal(sourceResults[0].ok, true);
  assert.equal(sourceResults[0].skipped, true);
  assert.equal(sourceResults[0].itemCount, 0);
  assert.match(sourceResults[0].note, /window closed/i);

  // Still open one second before the boundary (would fetch, so only check
  // the predicate, not collectFeedItems).
  assert.equal(
    isSourceWindowClosed(expired, new Date("2026-06-12T23:59:59Z")),
    false,
  );
  assert.equal(
    isSourceWindowClosed(expired, new Date("2026-06-13T00:00:00Z")),
    true,
  );
  assert.equal(isSourceWindowClosed({ feedUrl: "https://x.example/" }), false);
});

test("filterSourceItemsByDateWindow enforces backfill boundaries", () => {
  const source = {
    minPubDate: "2026-01-01T00:00:00Z",
    maxPubDate: "2026-06-13T00:00:00Z",
  };
  const items = [
    { title: "Too old", pubDate: new Date("2025-12-31T23:59:59Z") },
    { title: "In range", pubDate: new Date("2026-05-13T12:00:00Z") },
    { title: "Too new", pubDate: new Date("2026-06-13T00:00:00Z") },
    { title: "Undated" },
  ];

  assert.deepEqual(
    filterSourceItemsByDateWindow(items, source).map((item) => item.title),
    ["In range"],
  );
});

test("filterSourceItemsByDateWindow enforces a rolling source age limit", () => {
  const now = new Date("2026-07-12T12:00:00Z");
  const items = [
    { title: "current", pubDate: new Date("2026-07-10T12:00:00Z") },
    { title: "stale", pubDate: new Date("2026-07-01T12:00:00Z") },
    { title: "undated", pubDate: null },
  ];

  assert.deepEqual(
    filterSourceItemsByDateWindow(items, { maxItemAgeDays: 7 }, now).map(
      (item) => item.title,
    ),
    ["current"],
  );
});

test("isObituaryItem catches source categories, title/path signals, and obituary prose", () => {
  const items = [
    {
      title: "David Jon Bursey, 77, of Monkton",
      link: "https://www.addisonindependent.com/2026/06/16/david-jon-bursey-77-of-monkton/",
      sourceCategories: "Obituaries",
      description:
        "MONKTON — David Jon Bursey, 77, passed away Thursday, June 11, 2026, at University of Vermont Medical Center in Burlington.",
    },
    {
      title: "Obituary: Dieter Gump, 1933-2026",
      link: "https://www.sevendaysvt.com/life-lines/obituaries/obituary-dieter-gump-1933-2026/",
      description: "Accomplished research physician and professor.",
    },
    {
      title: "Michael Ray Jensen, 54, of Brandon",
      link: "https://www.example.com/story",
      description:
        "BRANDON — Michael Ray Jensen, 54, passed away Wednesday, June 3, 2026, at Dartmouth Hitchcock Medical Center.",
    },
  ];

  for (const item of items) {
    assert.equal(isObituaryItem(item), true, `${item.title} should be an obituary`);
  }
});

test("isObituaryItem avoids general mortality and policy stories", () => {
  assert.equal(
    isObituaryItem({
      title: "Hospital leaders discuss overdose death prevention",
      link: "https://example.com/news/overdose-prevention/",
      sourceCategories: "Health News",
      description:
        "Officials discussed new public health funding after overdose deaths rose statewide.",
    }),
    false,
  );
});

test("collectFeedItems excludes obituary feed entries", async () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <item>
          <title>David Jon Bursey, 77, of Monkton</title>
          <link>https://example.com/2026/06/16/david-jon-bursey-77-of-monkton/</link>
          <guid>obit-1</guid>
          <pubDate>Tue, 16 Jun 2026 16:10:08 GMT</pubDate>
          <category><![CDATA[Obituaries]]></category>
          <description><![CDATA[Passed away at University of Vermont Medical Center.]]></description>
        </item>
        <item>
          <title>UVM Health announces new primary care clinic</title>
          <link>https://example.com/2026/06/16/uvm-health-primary-care/</link>
          <guid>story-1</guid>
          <pubDate>Tue, 16 Jun 2026 15:10:08 GMT</pubDate>
          <category><![CDATA[Health Care]]></category>
          <description><![CDATA[The clinic expands access for patients.]]></description>
        </item>
      </channel>
    </rss>`;
  const source = {
    name: "Inline RSS",
    homepage: "https://example.com/",
    feedUrl: `data:application/rss+xml,${encodeURIComponent(xml)}`,
  };

  const { items, sourceResults } = await collectFeedItems(
    [source],
    new Date("2026-06-16T16:30:00Z"),
  );

  assert.deepEqual(
    items.map((item) => item.title),
    ["UVM Health announces new primary care clinic"],
  );
  assert.equal(sourceResults[0].itemCount, 1);
});

test("collectFeedItems uses a fallback feed after a blocked primary feed", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(403, { "content-type": "text/plain" });
    response.end("blocked");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const xml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <item>
            <title>UVM Health expands primary care access</title>
            <link>https://example.com/uvm-health-primary-care</link>
            <guid>story-1</guid>
            <pubDate>Tue, 16 Jun 2026 15:10:08 GMT</pubDate>
            <description><![CDATA[The Vermont clinic expands access for patients.]]></description>
          </item>
          <item>
            <title>UVM Health opens another clinic</title>
            <link>https://example.com/uvm-health-second-clinic</link>
            <guid>story-2</guid>
            <pubDate>Tue, 16 Jun 2026 14:10:08 GMT</pubDate>
            <description><![CDATA[Another Vermont clinic expands access.]]></description>
          </item>
        </channel>
      </rss>`;
    const primaryFeedUrl = `http://127.0.0.1:${port}/rss.xml`;
    const fallbackFeedUrl = `data:application/rss+xml,${encodeURIComponent(xml)}`;
    const { items, sourceResults } = await collectFeedItems(
      [
        {
          name: "Blocked Outlet",
          homepage: "https://example.com/",
          feedUrl: primaryFeedUrl,
          maxItems: 1,
          fallbackFeed: {
            feedUrl: fallbackFeedUrl,
            isSearchFeed: true,
            scanArticle: false,
            maxItems: 25,
          },
        },
      ],
      new Date("2026-06-16T16:30:00Z"),
    );

    assert.equal(sourceResults[0].ok, true);
    assert.equal(sourceResults[0].feedUrl, fallbackFeedUrl);
    assert.equal(sourceResults[0].fallbackFrom, primaryFeedUrl);
    assert.match(sourceResults[0].primaryError, /HTTP 403/);
    assert.equal(items[0].sourceFeedUrl, fallbackFeedUrl);
    assert.equal(items[0].isSearchFeed, true);
    assert.equal(items[0].scanArticle, false);
    assert.equal(items.length, 1, "the source maxItems must bound its fallback");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("collectFeedItems rejects an HTML challenge page and uses the feed fallback", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html",
      etag: '"challenge-v1"',
    });
    response.end("<html><body>Checking your browser</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const primaryFeedUrl = `http://127.0.0.1:${port}/rss.xml`;
    const fallbackXml = `
      <rss version="2.0"><channel><item>
        <title>Blue Cross VT fallback story</title>
        <link>https://example.com/blue-cross-vt-fallback-story</link>
        <pubDate>Thu, 27 Aug 2026 12:00:00 GMT</pubDate>
      </item></channel></rss>`;
    const fallbackFeedUrl =
      `data:application/rss+xml,${encodeURIComponent(fallbackXml)}`;
    const crawlState = normalizeCrawlState();
    const { items, sourceResults } = await collectFeedItems(
      [
        {
          name: "Challenge Outlet",
          homepage: "https://example.com/",
          feedUrl: primaryFeedUrl,
          throttleGroup: `challenge-outlet-${port}`,
          throttleDelayMs: 0,
          fallbackFeed: {
            feedUrl: fallbackFeedUrl,
            isSearchFeed: true,
            scanArticle: false,
          },
        },
      ],
      new Date("2026-08-27T13:00:00Z"),
      crawlState,
    );

    assert.equal(sourceResults[0].ok, true);
    assert.equal(sourceResults[0].feedUrl, fallbackFeedUrl);
    assert.match(sourceResults[0].primaryError, /not an RSS, Atom, or RDF feed/);
    assert.equal(items[0].title, "Blue Cross VT fallback story");
    assert.equal(
      crawlState.sourceState["Challenge Outlet"].feedHeaders[primaryFeedUrl],
      undefined,
      "an invalid body must not persist its response validators",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("source retries honor the source throttle before another request", async () => {
  const requestTimes = [];
  const server = createServer((_request, response) => {
    requestTimes.push(Date.now());
    if (requestTimes.length === 1) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("temporary failure");
      return;
    }
    response.writeHead(200, { "content-type": "application/rss+xml" });
    response.end(
      '<rss version="2.0"><channel><item><title>Blue Cross VT retry story</title><link>https://example.com/retry-story</link></item></channel></rss>',
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const { sourceResults } = await collectFeedItems([
      {
        name: "Retry Throttle Outlet",
        feedUrl: `http://127.0.0.1:${port}/rss.xml`,
        throttleGroup: `retry-throttle-${port}`,
        throttleDelayMs: 1000,
      },
    ]);

    assert.equal(sourceResults[0].ok, true);
    assert.equal(requestTimes.length, 2);
    assert.ok(
      requestTimes[1] - requestTimes[0] >= 900,
      `retry gap was ${requestTimes[1] - requestTimes[0]}ms`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("collectFeedItems honors active primary feed cooldowns", async () => {
  let primaryRequests = 0;
  const server = createServer((_request, response) => {
    primaryRequests += 1;
    response.writeHead(500, { "content-type": "text/plain" });
    response.end("primary should be cooled down");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const now = new Date("2026-06-16T16:30:00Z");
    const xml = `<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <item>
            <title>Blue Cross VT fallback story</title>
            <link>https://example.com/blue-cross-vt-fallback</link>
            <guid>story-1</guid>
            <pubDate>Tue, 16 Jun 2026 15:10:08 GMT</pubDate>
            <description><![CDATA[Blue Cross VT appears in fallback search.]]></description>
          </item>
        </channel>
      </rss>`;
    const primaryFeedUrl = `http://127.0.0.1:${port}/rss.xml`;
    const fallbackFeedUrl = `data:application/rss+xml,${encodeURIComponent(xml)}`;
    const crawlState = normalizeCrawlState({
      sourceState: {
        "Cooldown Outlet": {
          primaryCooldownUntil: "2026-06-16T18:30:00.000Z",
          lastPrimaryError: "HTTP 429 while fetching primary",
        },
      },
    });
    const metrics = { collection: {} };

    const { items, sourceResults } = await collectFeedItems(
      [
        {
          name: "Cooldown Outlet",
          homepage: "https://example.com/",
          feedUrl: primaryFeedUrl,
          fallbackFeed: {
            feedUrl: fallbackFeedUrl,
            isSearchFeed: true,
            scanArticle: false,
          },
        },
      ],
      now,
      crawlState,
      metrics,
    );

    assert.equal(primaryRequests, 0);
    assert.equal(sourceResults[0].ok, true);
    assert.equal(sourceResults[0].primaryCooldown, true);
    assert.equal(sourceResults[0].primaryCooldownUntil, "2026-06-16T18:30:00.000Z");
    assert.equal(sourceResults[0].fallbackFrom, primaryFeedUrl);
    assert.equal(metrics.collection.sourceCooldowns, 1);
    assert.equal(items[0].title, "Blue Cross VT fallback story");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("parseFeedItems parses RSS items", () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <item>
          <title>Blue Cross Blue Shield of Vermont files rates</title>
          <link>/story</link>
          <guid>story-1</guid>
          <pubDate>Tue, 12 May 2026 12:00:00 GMT</pubDate>
          <category><![CDATA[Health Care]]></category>
          <description><![CDATA[Regulators received the filing.]]></description>
        </item>
      </channel>
    </rss>`;

  const items = parseFeedItems(xml, {
    name: "Example",
    feedUrl: "https://example.com/feed.xml",
    homepage: "https://example.com/",
  });

  assert.equal(items.length, 1);
  assert.equal(
    items[0].link,
    "https://example.com/story",
  );
  assert.equal(items[0].sourceName, "Example");
  assert.equal(items[0].description, "Regulators received the filing.");
  assert.equal(items[0].sourceCategories, "Health Care");
});

test("parseFeedItems parses Atom entries", () => {
  const xml = `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Health care story</title>
        <link rel="alternate" href="https://example.com/atom-story" />
        <id>tag:example.com,2026:1</id>
        <updated>2026-05-12T12:00:00Z</updated>
        <summary>Blue Cross VT appears in the body.</summary>
      </entry>
    </feed>`;

  const items = parseFeedItems(xml, {
    name: "Atom Example",
    feedUrl: "https://example.com/atom.xml",
    homepage: "https://example.com/",
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Health care story");
  assert.equal(items[0].link, "https://example.com/atom-story");
});

test("parseFeedItems reads YouTube Atom media descriptions", () => {
  const items = parseFeedItems(
    `
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
        <entry>
          <title>Vermont candidate forum</title>
          <link rel="alternate" href="https://www.youtube.com/watch?v=example" />
          <id>yt:video:example</id>
          <published>2026-07-11T12:00:00Z</published>
          <media:group><media:description>Candidates discuss Vermont health care affordability.</media:description></media:group>
        </entry>
      </feed>
    `,
    {
      name: "Town Meeting TV",
      feedUrl: "https://www.youtube.com/feeds/videos.xml?channel_id=example",
      scanArticle: false,
    },
  );

  assert.equal(items[0].description, "Candidates discuss Vermont health care affordability.");
  assert.match(items[0].feedContent, /health care affordability/);
});

test("parseBlueCrossVtListingItems extracts dated Newsroom and blog rows", () => {
  const html = `<!doctype html>
    <html>
      <body>
        <div class="views-row">
          <article class="node--type-news">
            <div class="news--date"><time datetime="2026-05-12T12:00:00Z">May 12, 2026</time></div>
            <h3><a href="/health-community/news/rate-request" class="link-arrow">Blue Cross and Blue Shield of Vermont Requests Lowest Premium Increase in Five Years</a></h3>
            <p>Rate reflects collective work across the state.</p>
            <div class="news--category">Company &amp; Industry News</div>
          </article>
        </div>
        <div class="views-row">
          <article class="node--type-blog">
            <div class="blog-post--date"><time datetime="2026-06-15T12:00:00Z">Jun 15, 2026</time></div>
            <h3><a href="/health-community/blog/listing/medicare-caregivers" class="link-arrow">What Caregivers Need to Know About Medicare</a></h3>
            <p>Helpful guidance for caregivers.</p>
            <div class="blog-post--category">Understanding Insurance</div>
          </article>
        </div>
      </body>
    </html>`;

  const items = parseBlueCrossVtListingItems(html, {
    name: "BlueCrossVT Newsroom",
    homepage: "https://www.bluecrossvt.org/health-community/news",
    listingUrl: "https://www.bluecrossvt.org/health-community/news",
    searchFallbackTerms: ["bluecrossvt.org"],
    scanArticle: false,
  });

  assert.equal(items.length, 2);
  assert.equal(
    items[0].link,
    "https://www.bluecrossvt.org/health-community/news/rate-request",
  );
  assert.equal(items[0].pubDate.toISOString(), "2026-05-12T12:00:00.000Z");
  assert.match(items[1].feedContent, /bluecrossvt\.org/);
  assert.deepEqual(items[1].searchFallbackTerms, ["bluecrossvt.org"]);
  assert.equal(items[1].scanArticle, false);
});

test("parseBcbsAssociationNewsItems extracts dated BCBSA listing cards", () => {
  const html = `<!doctype html>
    <html>
      <body>
        <article class="bcbs-news-item-listing-content">
          <ul class="bcbs-categories-chips">
            <li class="bcbs-categories-chips__item">Press Release</li>
          </ul>
          <h1 class="bcbs-news-item-listing-content__title">
            <a class="bcbs-news-item-listing-content__link" href="/about-us/association-news/prior-authorization-standardization">Health Plans Take Next Step to Streamline and Simplify Prior Authorization for Patients and Providers</a>
          </h1>
          <p class="bcbs-news-item-listing-content__text">Leading health plans announced a new initiative to accelerate patient access to care.</p>
          <time class="bcbs-news-item-listing-content__date" dateTime="2026-04-24">April 24, 2026</time>
        </article>
        <article class="bcbs-news-item-listing-content">
          <h1 class="bcbs-news-item-listing-content__title">
            <a class="bcbs-news-item-listing-content__link" href="/support-resources/terminology-glossary-dictionary">Glossary</a>
          </h1>
        </article>
      </body>
    </html>`;

  const items = parseBcbsAssociationNewsItems(html, {
    name: "BCBSA Association News",
    homepage: "https://www.bcbs.com/about-us/association-news",
    listingUrl: "https://www.bcbs.com/about-us/association-news",
    searchFallbackTerms: ["Blue Cross Blue Shield Association"],
    scanArticle: false,
  });

  assert.equal(items.length, 1);
  assert.equal(
    items[0].link,
    "https://www.bcbs.com/about-us/association-news/prior-authorization-standardization",
  );
  assert.equal(items[0].pubDate.toISOString().slice(0, 10), "2026-04-24");
  assert.match(items[0].feedContent, /Blue Cross Blue Shield Association/);
  assert.deepEqual(items[0].searchFallbackTerms, [
    "Blue Cross Blue Shield Association",
  ]);
  assert.equal(items[0].scanArticle, false);
});

test("parseUvmHealthNewsroomItems extracts dated newsroom cards", () => {
  const html = `<!doctype html>
    <html>
      <body>
        <outline-card-clickable>
          <h4><a href="/newsroom/uvm-health-announces-elimination-of-76-positions">UVM Health Announces Elimination of 76 Positions</a></h4>
          <img alt="Front entrance of the UVM Medical Center in Burlington, Vermont.">
          <div slot="date">June 9, 2026</div>
        </outline-card-clickable>
        <outline-card-clickable>
          <h4><a href="/newsroom/search">Explore more news</a></h4>
          <div slot="date">June 1, 2026</div>
        </outline-card-clickable>
      </body>
    </html>`;

  const items = parseUvmHealthNewsroomItems(html, {
    name: "UVM Health Newsroom",
    homepage: "https://www.uvmhealth.org/newsroom",
    listingUrl: "https://www.uvmhealth.org/newsroom",
    searchFallbackTerms: ["UVM Health"],
    scanArticle: false,
  });

  assert.equal(items.length, 1);
  assert.equal(
    items[0].link,
    "https://www.uvmhealth.org/newsroom/uvm-health-announces-elimination-of-76-positions",
  );
  // Bare card dates resolve in the local zone, so compare calendar parts.
  assert.equal(items[0].pubDate.getFullYear(), 2026);
  assert.equal(items[0].pubDate.getMonth(), 5);
  assert.equal(items[0].pubDate.getDate(), 9);
  assert.match(items[0].feedContent, /UVM Health/);
  assert.deepEqual(items[0].searchFallbackTerms, ["UVM Health"]);
});

test("parseUvmHealthNewsroomItems reads the complete search-result card shape", () => {
  const items = parseUvmHealthNewsroomItems(
    `<outline-search-result>
      <div slot="eyebrow">Elizabethtown Community Hospital</div>
      <div slot="heading"><h4><a href="/newsroom/a-screening-saved-her-life">A Screening Saved her Life</a></h4></div>
      <div slot="date">August 27, 2026</div>
      <div slot="body">A screening program helped a patient receive care.</div>
    </outline-search-result>
    <outline-search-result>
      <div slot="heading"><a href="/newsroom/search">Search</a></div>
    </outline-search-result>`,
    {
      name: "UVM Health Newsroom",
      homepage: "https://www.uvmhealth.org/newsroom/search",
      listingUrl: "https://www.uvmhealth.org/newsroom/search",
      searchFallbackTerms: ["UVM Health"],
      scanArticle: false,
    },
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].title, "A Screening Saved her Life");
  // The card carries a bare date, which Date resolves in the runner's local
  // zone. Assert the calendar day rather than an instant, so the test holds
  // outside UTC as well as inside CI.
  assert.equal(items[0].pubDate.getFullYear(), 2026);
  assert.equal(items[0].pubDate.getMonth(), 7);
  assert.equal(items[0].pubDate.getDate(), 27);
  assert.equal(
    items[0].description,
    "A screening program helped a patient receive care.",
  );
  assert.match(items[0].feedContent, /Elizabethtown Community Hospital/);
});

test("parseFacebookPostHtml extracts public post metadata and comments when present", () => {
  const html = `<!doctype html>
    <html>
      <head>
        <meta property="og:title" content="VTDigger">
        <meta property="og:description" content="BlueCross BlueShield wants to offer cheaper plans.">
        <meta property="og:url" content="https://www.facebook.com/vtdigger/posts/123">
        <meta property="article:published_time" content="2026-06-11T13:00:00Z">
      </head>
      <body>
        <div aria-label="Comment by Jane Reader">This affects BCBS VT members.</div>
      </body>
    </html>`;

  const item = parseFacebookPostHtml(html, {
    name: "VTDigger Facebook",
    facebookPostUrl: "https://m.facebook.com/vtdigger/posts/123",
  });

  assert.equal(item.sourceName, "VTDigger Facebook");
  assert.equal(item.link, "https://www.facebook.com/vtdigger/posts/123");
  assert.equal(item.description, "BlueCross BlueShield wants to offer cheaper plans.");
  assert.deepEqual(item.comments, [
    {
      author: "Jane Reader",
      text: "This affects BCBS VT members.",
      date: null,
      replies: [],
    },
  ]);
  assert.match(item.feedContent, /BlueCross BlueShield/);
  assert.match(item.feedContent, /BCBS VT members/);
});

test("parseFacebookPostHtml uses embedded post dates and nested comments", () => {
  const html = `<!doctype html>
    <html>
      <head>
        <meta property="og:title" content="VTDigger">
        <meta property="og:description" content="BlueCross BlueShield wants to offer cheaper plans.">
        <meta property="og:url" content="https://www.facebook.com/vtdigger/posts/123">
      </head>
      <body>
        <script>{
          "creation_time":1781270103,
          "depth":0,
          "body":{"text":"Parent comment about BCBS VT."},
          "author":{"name":"Jane Reader"},
          "created_time":1781270200,
          "depth":1,
          "body":{"text":"Reply with more local detail."},
          "author":{"name":"Sam Reply"},
          "created_time":1781270300
        }</script>
      </body>
    </html>`;

  const item = parseFacebookPostHtml(html, {
    name: "VTDigger Facebook",
    facebookPostUrl: "https://m.facebook.com/vtdigger/posts/123",
  });

  assert.equal(
    item.pubDate.toISOString(),
    new Date(1781270103 * 1000).toISOString(),
  );
  assert.deepEqual(item.comments, [
    {
      author: "Jane Reader",
      text: "Parent comment about BCBS VT.",
      date: new Date(1781270200 * 1000).toISOString(),
      replies: [
        {
          author: "Sam Reply",
          text: "Reply with more local detail.",
          date: new Date(1781270300 * 1000).toISOString(),
        },
      ],
    },
  ]);
  assert.match(item.feedContent, /Reply with more local detail/);
});

test("parseFacebookPageHtml extracts public post links when page HTML exposes them", () => {
  const html = `<!doctype html>
    <html>
      <head><title>VTDigger</title></head>
      <body>
        <article>
          <p>VTDigger 3h · BlueCross BlueShield wants to offer cheaper health plans.</p>
          <a href="/vtdigger/posts/123?refid=52">Full Story</a>
        </article>
        <article>
          <p>Unrelated weather update.</p>
          <a href="https://www.facebook.com/vtdigger/posts/456?mibextid=abc">Full Story</a>
        </article>
      </body>
    </html>`;

  const items = parseFacebookPageHtml(html, {
    name: "VTDigger Facebook page",
    facebookPageUrl: "https://www.facebook.com/vtdigger",
    now: new Date("2026-06-12T18:00:00Z"),
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].sourceName, "VTDigger Facebook page");
  assert.equal(items[0].link, "https://www.facebook.com/vtdigger/posts/123");
  assert.match(items[0].description, /BlueCross BlueShield/);
  assert.match(items[0].feedContent, /cheaper health plans/);
  assert.equal(items[0].pubDate.toISOString(), "2026-06-12T15:00:00.000Z");
});

test("parseFacebookEmbeddedPosts extracts the server-rendered post from real page HTML", () => {
  // Facebook's no-login page HTML embeds the latest post as JSON-escaped
  // script data; there are no post links in anchor tags.
  const html = `<html><head><title>VTDigger</title></head><body>
    <script>requireLazy(["JSScheduler"],{"post_id":"1602446425217693",
    "message":{"text":"BlueCross BlueShield wants to offer a new suite of cheaper plans. \\u201cWe went hunting,\\u201d an executive said."},
    "creation_time":1781270103,"unpublished_content_type":"PUBLISHED",
    "wwwURL":"https:\\/\\/www.facebook.com\\/vtdigger\\/posts\\/pfbid02mozypSopS7PjQX3iFNX21rU8qKaVMk2aCvAL1qW3xTJg1gRMVE8B641tBJEorccCl",
    "comment_rendering_instance":{"comments":{"total_count":3}}}</script>
  </body></html>`;

  const source = {
    name: "VTDigger Facebook",
    facebookPageUrl: "https://www.facebook.com/vtdigger",
  };

  const embedded = parseFacebookEmbeddedPosts(html, source);
  assert.equal(embedded.length, 1);
  assert.equal(
    embedded[0].link,
    "https://www.facebook.com/vtdigger/posts/pfbid02mozypSopS7PjQX3iFNX21rU8qKaVMk2aCvAL1qW3xTJg1gRMVE8B641tBJEorccCl",
  );
  assert.match(embedded[0].description, /cheaper plans/);
  assert.match(embedded[0].description, /“We went hunting,”/);
  assert.equal(
    embedded[0].pubDate.toISOString(),
    new Date(1781270103 * 1000).toISOString(),
  );

  // parseFacebookPageHtml prefers the embedded path on the same HTML
  const items = parseFacebookPageHtml(html, source);
  assert.equal(items.length, 1);
  assert.equal(items[0].link, embedded[0].link);
});

test("enrichAndFilterItems drops brand-required items without a brand match", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "false";
  try {
    const items = [
      {
        sourceName: "WCAX Facebook",
        title: "WCAX post: Hospital announces new wing",
        link: "https://www.facebook.com/wcaxtv/posts/pfbid0aaa",
        feedContent: "Hospital announces new wing for primary care",
        requireBrandMatch: true,
      },
      {
        sourceName: "VTDigger Facebook",
        title: "VTDigger post: BlueCross BlueShield offers cheaper plans",
        link: "https://www.facebook.com/vtdigger/posts/pfbid0bbb",
        feedContent: "BlueCross BlueShield of Vermont offers cheaper plans",
        requireBrandMatch: true,
      },
    ];

    const filtered = await enrichAndFilterItems(items);
    assert.equal(filtered.length, 1);
    assert.match(filtered[0].link, /pfbid0bbb/);
  } finally {
    process.env.RSS_ARTICLE_SCAN = originalScan;
  }
});

test("mergeFacebookPagePostItem nests comments from enriched public posts", () => {
  const pageItem = {
    sourceName: "VTDigger Facebook page",
    sourceFeedUrl: "https://www.facebook.com/vtdigger",
    title: "VTDigger Facebook post: Blue Cross update",
    link: "https://www.facebook.com/vtdigger/posts/123",
    guid: "https://www.facebook.com/vtdigger/posts/123",
    pubDate: null,
    description: "Blue Cross update",
    comments: [],
    scanArticle: false,
    feedContent: "VTDigger Blue Cross update",
  };
  const postItem = {
    sourceName: "VTDigger Facebook page",
    sourceFeedUrl: "https://www.facebook.com/vtdigger/posts/123",
    title: "VTDigger Facebook post: Blue Cross update",
    link: "https://www.facebook.com/vtdigger/posts/123",
    guid: "https://www.facebook.com/vtdigger/posts/123",
    pubDate: new Date("2026-06-11T13:00:00Z"),
    description: "BlueCross BlueShield wants to offer cheaper plans.",
    comments: [{ author: "Jane Reader", text: "This affects BCBS VT members." }],
    scanArticle: false,
    feedContent: "BlueCross BlueShield wants to offer cheaper plans. This affects BCBS VT members.",
  };

  const merged = mergeFacebookPagePostItem(pageItem, postItem, {
    name: "VTDigger Facebook page",
    facebookPageUrl: "https://www.facebook.com/vtdigger",
  });

  assert.equal(merged.sourceFeedUrl, "https://www.facebook.com/vtdigger");
  assert.equal(merged.description, "BlueCross BlueShield wants to offer cheaper plans.");
  assert.deepEqual(merged.comments, [
    { author: "Jane Reader", text: "This affects BCBS VT members." },
  ]);
  assert.match(merged.feedContent, /BCBS VT members/);
});

test("buildSourcesFromEnv leaves social sources disabled by default", () => {
  const originalEnabled = process.env.ENABLE_SOCIAL_SOURCES;
  const originalPosts = process.env.FACEBOOK_POST_URLS;
  const originalPages = process.env.FACEBOOK_PAGE_URLS;

  delete process.env.ENABLE_SOCIAL_SOURCES;
  process.env.FACEBOOK_POST_URLS =
    "VTDigger|https://www.facebook.com/vtdigger/posts/123";
  process.env.FACEBOOK_PAGE_URLS =
    "WCAX|https://www.facebook.com/WCAXTV";

  try {
    assert.deepEqual(buildSourcesFromEnv([]), []);
    assert.equal(
      buildSourcesFromEnv().some(
        (source) =>
          /facebook/i.test(source.name) ||
          /facebook\.com/i.test(source.homepage || ""),
      ),
      false,
    );
  } finally {
    if (originalEnabled === undefined) {
      delete process.env.ENABLE_SOCIAL_SOURCES;
    } else {
      process.env.ENABLE_SOCIAL_SOURCES = originalEnabled;
    }
    if (originalPosts === undefined) {
      delete process.env.FACEBOOK_POST_URLS;
    } else {
      process.env.FACEBOOK_POST_URLS = originalPosts;
    }
    if (originalPages === undefined) {
      delete process.env.FACEBOOK_PAGE_URLS;
    } else {
      process.env.FACEBOOK_PAGE_URLS = originalPages;
    }
  }
});

test("buildSourcesFromEnv adds configured Facebook post and page sources", () => {
  const originalEnabled = process.env.ENABLE_SOCIAL_SOURCES;
  const originalPosts = process.env.FACEBOOK_POST_URLS;
  const originalPages = process.env.FACEBOOK_PAGE_URLS;
  const originalMaxPosts = process.env.FACEBOOK_PAGE_MAX_POSTS;
  process.env.ENABLE_SOCIAL_SOURCES = "true";
  process.env.FACEBOOK_POST_URLS =
    "VTDigger|https://www.facebook.com/vtdigger/posts/123";
  process.env.FACEBOOK_PAGE_URLS =
    "WCAX|https://www.facebook.com/WCAXTV";
  process.env.FACEBOOK_PAGE_MAX_POSTS = "4";

  try {
    const sources = buildSourcesFromEnv([]);
    assert.deepEqual(sources, [
      {
        name: "VTDigger Facebook post",
        homepage: "https://www.facebook.com/vtdigger/posts/123",
        facebookPostUrl: "https://www.facebook.com/vtdigger/posts/123",
        requireBrandMatch: true,
      },
      {
        name: "WCAX Facebook page",
        homepage: "https://www.facebook.com/WCAXTV",
        facebookPageUrl: "https://www.facebook.com/WCAXTV",
        maxItems: 4,
        requireBrandMatch: true,
      },
    ]);
  } finally {
    if (originalEnabled === undefined) {
      delete process.env.ENABLE_SOCIAL_SOURCES;
    } else {
      process.env.ENABLE_SOCIAL_SOURCES = originalEnabled;
    }
    if (originalPosts === undefined) {
      delete process.env.FACEBOOK_POST_URLS;
    } else {
      process.env.FACEBOOK_POST_URLS = originalPosts;
    }
    if (originalPages === undefined) {
      delete process.env.FACEBOOK_PAGE_URLS;
    } else {
      process.env.FACEBOOK_PAGE_URLS = originalPages;
    }
    if (originalMaxPosts === undefined) {
      delete process.env.FACEBOOK_PAGE_MAX_POSTS;
    } else {
      process.env.FACEBOOK_PAGE_MAX_POSTS = originalMaxPosts;
    }
  }
});

test("buildSnippet centers the first matched mention", () => {
  const snippet = buildSnippet(
    `${"before ".repeat(80)} Blue Cross and Blue Shield of Vermont filed testimony. ${"after ".repeat(80)}`,
  );

  assert.match(snippet, /Blue Cross and Blue Shield of Vermont/);
  assert.ok(snippet.startsWith("... "));
  assert.ok(snippet.endsWith(" ..."));
});

test("buildSnippet does not center on stripped transport idioms", () => {
  const filler = "word ".repeat(60);
  const text = `Driver was taken to the hospital after the crash. ${filler}Copley Hospital announced a new billing initiative.`;
  const snippet = buildSnippet(text, TOPIC_TERMS);

  // The real institutional mention is the match target; the accident
  // transport idiom near the start is stripped and outside the window.
  assert.match(snippet, /Copley Hospital announced/);
  assert.doesNotMatch(snippet, /taken to the hospital/);
});

test("cleanStorySnippet drops repeated title-only snippets", () => {
  const title =
    "How a new Blue Cross CEO plans to revive financial performance - Modern Healthcare";
  const snippet = [
    title,
    "How a new Blue Cross CEO plans to revive financial performance Modern Healthcare",
    "How a new Blue Cross CEO plans to revive financial performance Modern Healthcare",
  ].join(" ");

  assert.equal(cleanStorySnippet(snippet, title), "");
  assert.equal(
    cleanStorySnippet(
      "The CEO said rate pressure and claims trends are priorities.",
      title,
    ),
    "The CEO said rate pressure and claims trends are priorities.",
  );
});

test("buildRss emits valid channel and escaped item fields", () => {
  const rss = buildRss(
    [
      {
        sourceName: "WCAX",
        sourceFeedUrl: "https://www.wcax.com/feed.xml",
        title: "Blue Cross & rates",
        link: "https://www.wcax.com/story",
        guid: "https://www.wcax.com/story",
        pubDate: new Date("2026-05-12T12:00:00Z"),
        matchedTerms: ["Blue Cross"],
        snippet: "Blue Cross filed rates.",
        comments: [
          {
            author: "Reader",
            text: "Useful context.",
            replies: [{ author: "Reply Reader", text: "More context." }],
          },
        ],
      },
    ],
    {
      now: new Date("2026-05-13T12:00:00Z"),
      feedUrl: "https://example.com/feed.rss",
      siteUrl: "https://example.com/",
    },
  );

  assert.match(rss, /<rss version="2.0"/);
  assert.match(rss, /<title>Cerulean News<\/title>/);
  assert.match(rss, /WCAX: Blue Cross &amp; rates/);
  assert.match(rss, /<category>Blue Cross<\/category>/);
  assert.match(rss, /<strong>Comments:<\/strong>/);
  assert.match(rss, /Reader: Useful context\./);
  assert.match(rss, /Reply Reader: More context\./);
  assert.match(rss, /atom:link href="https:\/\/example.com\/feed.rss"/);
});

test("buildJsonSummary creates auditable item output", () => {
  const summary = buildJsonSummary(
    [
      {
        sourceName: "Seven Days",
        title: "Insurance story",
        link: "https://example.com/story",
        pubDate: new Date("2026-05-12T12:00:00Z"),
        matchedTerms: ["BCBSVT"],
        snippet: "BCBSVT mention.",
        comments: [
          {
            author: "Reader",
            text: "Good catch.",
            replies: [{ author: "Reply Reader", text: "Subcomment catch." }],
          },
        ],
      },
    ],
    [{ name: "Seven Days", ok: true, itemCount: 1 }],
    new Date("2026-05-13T12:00:00Z"),
  );

  assert.equal(summary.itemCount, 1);
  assert.equal(summary.version, "https://jsonfeed.org/version/1.1");
  assert.equal(summary.title, "Cerulean News");
  assert.equal(summary.sources[0].name, "Seven Days");
  assert.equal(summary.items[0].id, "https://example.com/story");
  assert.equal(summary.items[0].url, "https://example.com/story");
  assert.equal(summary.items[0].tags[0], "BCBSVT");
  assert.equal(summary.items[0].matchedTerms[0], "BCBSVT");
  assert.equal(summary.items[0].sourceType, "News");
  assert.equal(summary.items[0].access, "Access varies");
  assert.match(summary.items[0].content_text, /Good catch/);
  assert.match(summary.items[0].content_text, /Subcomment catch/);
});

test("buildJsonSummary keeps rejected items out of the public JSON feed", () => {
  const items = [
    {
      sourceName: "MyNBC5",
      title: "Texas shooting",
      link: "https://example.com/texas",
      pubDate: new Date("2026-06-12T12:00:00Z"),
      matchedTerms: ["Hospitals"],
      relevant: false,
      reason: "Mentions hospitals but not BCBSVT or Vermont.",
    },
    {
      sourceName: "VTDigger",
      title: "Blue Cross VT rate filing",
      link: "https://example.com/rate-filing",
      pubDate: new Date("2026-06-12T13:00:00Z"),
      matchedTerms: ["Blue Cross VT"],
      relevant: true,
      reason: "Blue Cross VT is the focus.",
    },
  ];

  const publicSummary = buildJsonSummary(
    items,
    [],
    new Date("2026-06-12T14:00:00Z"),
  );
  const auditSummary = buildJsonSummary(
    items,
    [],
    new Date("2026-06-12T14:00:00Z"),
    { includeRejected: true, feedUrl: "" },
  );

  assert.equal(publicSummary.itemCount, 1);
  assert.equal(publicSummary.totalItemCount, 2);
  assert.equal(publicSummary.rejectedItemCount, 1);
  assert.deepEqual(
    publicSummary.items.map((item) => item.title),
    ["Blue Cross VT rate filing"],
  );

  assert.equal(auditSummary.audit, true);
  assert.equal(auditSummary.itemCount, 2);
  assert.deepEqual(
    auditSummary.items.map((item) => item.title),
    ["Blue Cross VT rate filing", "Texas shooting"],
  );
});

test("buildJsonSummary keeps crawl state and metrics audit-only", () => {
  const crawlState = normalizeCrawlState({
    sourceState: {
      "Example Source": {
        primaryCooldownUntil: "2026-06-16T18:30:00.000Z",
        lastPrimaryError: "HTTP 429",
      },
    },
    articleCache: {
      "https://example.com/no-match": {
        resolvedUrl: "https://example.com/no-match",
        expiresAt: "2026-06-30T18:30:00.000Z",
        matchedTerms: [],
      },
    },
  });
  const crawlMetrics = {
    startedAt: "2026-06-16T16:30:00.000Z",
    finishedAt: "2026-06-16T16:31:00.000Z",
    durationMs: 60000,
    collection: { sourceCooldowns: 1 },
    enrichment: { negativeCacheHits: 1 },
  };
  const publicSummary = buildJsonSummary(
    [],
    [],
    new Date("2026-06-16T16:30:00Z"),
    { crawlState, crawlMetrics },
  );
  const auditSummary = buildJsonSummary(
    [],
    [],
    new Date("2026-06-16T16:30:00Z"),
    { includeRejected: true, crawlState, crawlMetrics },
  );

  assert.equal(publicSummary.crawlState, undefined);
  assert.equal(publicSummary.crawlMetrics, undefined);
  assert.equal(
    auditSummary.crawlState.sourceState["Example Source"].primaryCooldownUntil,
    "2026-06-16T18:30:00.000Z",
  );
  assert.equal(auditSummary.crawlMetrics.collection.sourceCooldowns, 1);
});

test("buildJsonSummary keeps preview completion state audit-only", () => {
  const item = {
    sourceName: "STAT Health News",
    title: "Coverage update",
    link: "https://www.statnews.com/example",
    matchedTerms: ["Health insurance"],
    previewText: "A bounded publisher preview.",
    previewChecked: true,
  };
  const publicSummary = buildJsonSummary([item], [], new Date("2026-07-12T12:00:00Z"));
  const auditSummary = buildJsonSummary(
    [item],
    [],
    new Date("2026-07-12T12:00:00Z"),
    { includeRejected: true },
  );

  assert.equal(publicSummary.items[0].previewChecked, undefined);
  assert.equal(auditSummary.items[0].previewChecked, true);
});

test("buildJsonSummary persists first-seen only in the audit feed", () => {
  const item = {
    sourceName: "Example",
    title: "Undated health care item",
    link: "https://example.com/undated",
    matchedTerms: ["Health care"],
    firstSeenAt: new Date("2026-08-27T12:00:00Z"),
  };
  const publicSummary = buildJsonSummary([item], [], new Date());
  const auditSummary = buildJsonSummary([item], [], new Date(), {
    includeRejected: true,
  });
  assert.equal(publicSummary.items[0].firstSeenAt, undefined);
  assert.equal(
    auditSummary.items[0].firstSeenAt,
    "2026-08-27T12:00:00.000Z",
  );
  const datedAudit = buildJsonSummary(
    [{ ...item, pubDate: new Date("2026-08-26T12:00:00Z") }],
    [],
    new Date(),
    { includeRejected: true },
  );
  assert.equal(datedAudit.items[0].firstSeenAt, undefined);
});

test("parseFeedItems supports isSearchFeed property", () => {
  const xml = `<?xml version="1.0"?>
    <rss version="2.0">
      <channel>
        <item>
          <title>Web mention</title>
          <link>https://example.com/story</link>
          <description>Mention found by search engine</description>
        </item>
      </channel>
    </rss>`;

  const items = parseFeedItems(xml, {
    name: "Google News Search",
    feedUrl: "https://news.google.com/rss/...",
    isSearchFeed: true,
    searchFallbackTerms: ["Blue Cross"],
    scanArticle: false,
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].isSearchFeed, true);
  assert.deepEqual(items[0].searchFallbackTerms, ["Blue Cross"]);
  assert.equal(items[0].scanArticle, false);
  assert.equal(items[0].articleScanMode, "feedOnly");
});

test("enrichAndFilterItems only uses fallback terms when the source declares them", async () => {
  const items = [
    {
      sourceName: "Google News Brand Search",
      isSearchFeed: true,
      searchFallbackTerms: ["Blue Cross"],
      scanArticle: false,
      title: "Implicit news item",
      link: "https://example.com/implicit-story",
      feedContent:
        "This text does not mention any target keywords directly but was indexed by a narrow brand search.",
    },
    {
      sourceName: "Google News Broad Health Search",
      isSearchFeed: true,
      scanArticle: false,
      title: "Unrelated broad search item",
      link: "https://example.com/unrelated-story",
      feedContent:
        "This text does not mention target keywords and should not inherit a broad search label.",
    },
  ];

  const filtered = await enrichAndFilterItems(items);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].link, "https://example.com/implicit-story");
  assert.deepEqual(filtered[0].matchedTerms, ["Blue Cross"]);
  assert.equal(filtered[0].matchSource, "searchFallback");
});

test("enrichAndFilterItems skips fresh negative article-cache entries", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<article><p>Blue Cross VT should not be fetched.</p></article>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const now = new Date("2026-06-16T16:30:00Z");
    const link = `http://127.0.0.1:${port}/cached-negative`;
    const articleCache = {
      [link]: {
        url: link,
        resolvedUrl: link,
        checkedAt: "2026-06-16T15:30:00.000Z",
        expiresAt: "2026-06-30T15:30:00.000Z",
        matchedTerms: [],
        comments: [],
        articleHeaders: {},
      },
    };
    const metrics = { enrichment: { scanModes: {} } };

    const filtered = await enrichAndFilterItems(
      [
        {
          sourceName: "Cached Negative Outlet",
          title: "Unrelated story",
          link,
          feedContent: "Unrelated local story without target terms.",
          articleScanMode: "always",
        },
      ],
      new Map(),
      { articleCache, metrics, now },
    );

    assert.deepEqual(filtered, []);
    assert.equal(requests, 0);
    assert.equal(metrics.enrichment.negativeCacheHits, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (originalScan === undefined) {
      delete process.env.RSS_ARTICLE_SCAN;
    } else {
      process.env.RSS_ARTICLE_SCAN = originalScan;
    }
  }
});

test("scan-disabled runs retain fresh negative cache entries and validators", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "false";
  const now = new Date("2026-06-16T16:30:00Z");
  const link = "https://example.com/cached-negative";
  const cachedEntry = {
    url: link,
    resolvedUrl: link,
    checkedAt: "2026-06-16T15:30:00.000Z",
    expiresAt: "2026-06-30T15:30:00.000Z",
    matchedTerms: [],
    comments: [],
    articleHeaders: { etag: '"negative-v1"', lastModified: "" },
  };
  const articleCache = { [link]: cachedEntry };
  const metrics = { enrichment: { scanModes: {} } };

  try {
    const filtered = await enrichAndFilterItems(
      [{
        sourceName: "Cached Negative Outlet",
        title: "Unrelated story",
        link,
        feedContent: "Unrelated local story without target terms.",
        articleScanMode: "always",
      }],
      new Map(),
      {
        articleCache,
        metrics,
        now,
        fetchText: async () => assert.fail("scan-disabled runs must not fetch"),
      },
    );

    assert.deepEqual(filtered, []);
    assert.equal(articleCache[link], cachedEntry);
    assert.equal(articleCache[link].articleHeaders.etag, '"negative-v1"');
    assert.equal(metrics.enrichment.articleFetchSkipped, 1);
  } finally {
    if (originalScan === undefined) {
      delete process.env.RSS_ARTICLE_SCAN;
    } else {
      process.env.RSS_ARTICLE_SCAN = originalScan;
    }
  }
});

test("enrichAndFilterItems skips smart article fetches with no feed signal", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<article><p>Blue Cross VT would match if fetched.</p></article>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const articleCache = {};
    const metrics = { enrichment: { scanModes: {} } };
    const filtered = await enrichAndFilterItems(
      [
        {
          sourceName: "No Signal Outlet",
          title: "School budget story",
          link: `http://127.0.0.1:${port}/no-signal`,
          feedContent: "School board discusses budget timing.",
          articleScanMode: "smart",
        },
      ],
      new Map(),
      { articleCache, metrics, now: new Date("2026-06-16T16:30:00Z") },
    );

    assert.deepEqual(filtered, []);
    assert.equal(requests, 0);
    assert.equal(metrics.enrichment.articleFetchSkipped, 1);
    assert.deepEqual(Object.keys(articleCache), []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (originalScan === undefined) {
      delete process.env.RSS_ARTICLE_SCAN;
    } else {
      process.env.RSS_ARTICLE_SCAN = originalScan;
    }
  }
});

test("enrichAndFilterItems caches a negative only after an article fetch", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";
  const link = "https://example.com/fetched-no-match";
  const articleCache = {};

  try {
    const filtered = await enrichAndFilterItems(
      [{
        sourceName: "Always Scan Outlet",
        title: "School budget story",
        link,
        feedContent: "School board discusses budget timing.",
        articleScanMode: "always",
      }],
      new Map(),
      {
        articleCache,
        now: new Date("2026-06-16T16:30:00Z"),
        fetchText: async (url) => ({
          text: "<article><h1>School budget story</h1><p>No target words appear here.</p></article>",
          url,
          notModified: false,
          etag: "",
          lastModified: "",
        }),
        throttleRequest: async () => {},
      },
    );

    assert.deepEqual(filtered, []);
    assert.deepEqual(articleCache[link].matchedTerms, []);
  } finally {
    if (originalScan === undefined) delete process.env.RSS_ARTICLE_SCAN;
    else process.env.RSS_ARTICLE_SCAN = originalScan;
  }
});

test("htmlToArticleText extracts clean editorial text ignoring boilerplates", () => {
  const html = `
    <!doctype html>
    <html>
      <head><title>Test Page</title></head>
      <body>
        <header>
          <nav><a href="/">Home</a> | <a href="/about">About Us</a></nav>
        </header>
        <aside class="sidebar">
          <h3>Trending Articles</h3>
          <p>Unrelated sidebar mention of Blue Cross</p>
        </aside>
        <main>
          <article>
            <h1>Main Editorial Story</h1>
            <p>This is the actual news content of the story.</p>
            <p>It has multiple paragraphs representing the article body.</p>
          </article>
        </main>
        <footer>
          <p>&copy; 2026 Publisher. All rights reserved.</p>
        </footer>
      </body>
    </html>
  `;

  const text = htmlToArticleText(html);
  assert.match(text, /This is the actual news content/);
  assert.match(text, /multiple paragraphs/);
  assert.ok(!text.includes("Trending Articles"));
  assert.ok(!text.includes("About Us"));
  assert.ok(!text.includes("Publisher"));
});

test("extractArticlePreview returns a bounded publisher lead without paywall boilerplate", () => {
  const preview = extractArticlePreview(
    `
      <html><body>
        <nav>Sections Subscribe Log in</nav>
        <article>
          <p>Vermont regulators opened a review of proposed health insurance rates for next year.</p>
          <p>The filing describes how hospital prices and prescription drug costs affect premiums.</p>
          <p>This third paragraph must not be republished in the preview.</p>
          <p>Subscribe now to continue reading.</p>
        </article>
        <script type="application/ld+json">{"articleBody":"Hidden full article text"}</script>
      </body></html>
    `,
    "https://www.timesargus.com/news/example",
  );

  assert.match(preview, /^Vermont regulators opened/);
  assert.match(preview, /prescription drug costs affect premiums\.$/);
  assert.doesNotMatch(preview, /third paragraph|Subscribe|Hidden full article/i);
  assert.ok(preview.length <= 600);
});

test("extractArticlePreview truncates on a word boundary and rejects boilerplate-only pages", () => {
  const preview = extractArticlePreview(
    `<article><p>${"Vermont health care coverage remains important for families. ".repeat(20)}</p></article>`,
    "https://www.statnews.com/example",
    { maxCharacters: 120, maxParagraphs: 2 },
  );

  assert.ok(preview.length <= 120);
  assert.match(preview, /\.\.\.$/);
  assert.doesNotMatch(preview, /\s\.\.\.$/);
  assert.equal(
    extractArticlePreview(
      "<article><p>Subscribe to continue reading.</p><p>Log in to access this article.</p></article>",
      "https://www.statnews.com/example",
    ),
    "",
  );
});

test("publisher previews reject newsletter greetings while preserving article leads", () => {
  assert.equal(
    normalizePreviewText(
      "Get your daily dose of health and medicine with STAT's free newsletter.",
    ),
    "",
  );
  assert.equal(
    normalizePreviewText(
      "Good morning, everyone, and welcome to another working week.",
    ),
    "",
  );
  assert.equal(
    normalizePreviewText(
      "WASHINGTON — State Medicaid directors warned that coverage losses are likely.",
    ),
    "WASHINGTON — State Medicaid directors warned that coverage losses are likely.",
  );
});

test("extractArticlePreview skips STAT author biography text", () => {
  const preview = extractArticlePreview(
    `
      <div class="article-body">
        <div class="article-content">
          <div class="author-pop-over"><p>Reporter at Large, Live and Feature Journalism</p><p>Damian covers the global drug industry.</p></div>
          <div class="entry-content the-content wp-block-post-content">
            <p>Vermont regulators opened a review of next year's health insurance premiums.</p>
            <p>The filing points to hospital prices and prescription drug costs.</p>
          </div>
        </div>
      </div>
    `,
    "https://www.statnews.com/2026/07/12/example/",
  );

  assert.match(preview, /^Vermont regulators opened/);
  assert.doesNotMatch(preview, /Reporter at Large|Damian covers/);
});

test("extractArticlePreview does not use unrelated body text on a recognized publisher", () => {
  const preview = extractArticlePreview(
    `
      <html><body>
        <h1>Prime Therapeutics faces price-fixing allegations</h1>
        <main class="related-card">
          <p>Results from an unrelated ACO program showed strong savings.</p>
        </main>
      </body></html>
    `,
    "https://www.modernhealthcare.com/insurance/example/",
  );

  assert.equal(preview, "");
});

test("selectPreviewBackfillItems chooses recent eligible archived paywall stories", () => {
  const now = new Date("2026-07-12T12:00:00Z");
  const selected = selectPreviewBackfillItems(
    [
      {
        title: "Fresh cached error",
        link: "https://www.statnews.com/fresh-error",
        pubDate: new Date("2026-07-12T13:00:00Z"),
      },
      {
        title: "Newest paywall story",
        link: "https://www.statnews.com/newest",
        pubDate: new Date("2026-07-12T12:00:00Z"),
        snippet: "Health insurance coverage changed.",
        relevant: true,
      },
      {
        sourceName: "STAT Health News",
        title: "Already in current feed",
        link: "https://www.statnews.com/current",
        pubDate: new Date("2026-07-11T12:00:00Z"),
      },
      {
        title: "Already checked",
        link: "https://www.timesargus.com/checked",
        pubDate: new Date("2026-07-10T12:00:00Z"),
        previewChecked: true,
      },
      {
        title: "Rejected",
        link: "https://www.vnews.com/rejected",
        pubDate: new Date("2026-07-09T12:00:00Z"),
        relevant: false,
      },
      {
        title: "Older paywall story",
        link: "https://www.statnews.com/older",
        pubDate: new Date("2026-07-08T12:00:00Z"),
        summary: "A saved coverage summary.",
      },
      {
        title: "Free story",
        link: "https://vtdigger.org/free",
        pubDate: new Date("2026-07-07T12:00:00Z"),
      },
    ],
    [{
      title: "Already in current feed - STAT",
      link: "https://news.google.com/rss/articles/wrapper",
    }],
    2,
    {
      "https://www.statnews.com/fresh-error": {
        articleError: "temporary timeout",
        expiresAt: "2026-07-13T12:00:00Z",
      },
    },
    now,
  );

  assert.deepEqual(selected.map((item) => item.title), [
    "Newest paywall story",
    "Older paywall story",
  ]);
  assert.match(selected[0].feedContent, /Health insurance coverage changed/);
  assert.match(selected[1].feedContent, /saved coverage summary/);
});

test("enrichAndFilterItems rejects a preview after a stale redirect", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";

  try {
    const [item] = await enrichAndFilterItems(
      [{
        sourceName: "STAT Health News",
        title: "Vermont premiums face new review",
        link: "https://www.statnews.com/2026/07/12/stale-story/",
        feedContent: "Vermont health insurance premiums face a regulatory review.",
        scanArticle: false,
      }],
      new Map(),
      {
        articleCache: {},
        metrics: { enrichment: { scanModes: {} } },
        now: new Date("2026-07-12T12:00:00Z"),
        fetchText: async () => ({
          text: "<main><h1>Latest health news</h1><p>An unrelated article appears on the publisher homepage.</p></main>",
          url: "https://www.statnews.com/",
          notModified: false,
          etag: "",
          lastModified: "",
        }),
        throttleRequest: async () => {},
      },
    );

    assert.equal(item.previewText, "");
    assert.equal(item.previewChecked, true);
    assert.equal(item.link, "https://www.statnews.com/2026/07/12/stale-story/");
  } finally {
    if (originalScan === undefined) delete process.env.RSS_ARTICLE_SCAN;
    else process.env.RSS_ARTICLE_SCAN = originalScan;
  }
});

test("unchanged article URLs keep body-only brand matches when headlines differ", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";
  const link = "https://example.com/article";

  try {
    const [item] = await enrichAndFilterItems(
      [{
        sourceName: "Example Outlet",
        title: "Feed headline before an editor update",
        link,
        feedContent: "A local business story.",
        articleScanMode: "always",
      }],
      new Map(),
      {
        articleCache: {},
        now: new Date("2026-07-12T12:00:00Z"),
        fetchText: async () => ({
          text: "<article><h1>Updated publisher headline</h1><p>Blue Cross VT announced a coverage change.</p></article>",
          url: link,
          notModified: false,
          etag: "",
          lastModified: "",
        }),
        throttleRequest: async () => {},
      },
    );

    assert.deepEqual(item.matchedTerms, ["Blue Cross VT"]);
    assert.equal(item.link, link);
  } finally {
    if (originalScan === undefined) delete process.env.RSS_ARTICLE_SCAN;
    else process.env.RSS_ARTICLE_SCAN = originalScan;
  }
});

test("unchanged soft-404 pages cannot contribute body-only brand matches", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";
  const link = "https://example.com/article";

  try {
    const items = await enrichAndFilterItems(
      [{
        sourceName: "Example Outlet",
        title: "Expected health story",
        link,
        feedContent: "A local business story.",
        articleScanMode: "always",
      }],
      new Map(),
      {
        articleCache: {},
        now: new Date("2026-07-12T12:00:00Z"),
        fetchText: async () => ({
          text: "<article><h1>Page not found</h1><p>The Blue Cross VT coverage page has moved.</p></article>",
          url: link,
          notModified: false,
          etag: "",
          lastModified: "",
        }),
        throttleRequest: async () => {},
      },
    );

    assert.deepEqual(items, []);
  } finally {
    if (originalScan === undefined) delete process.env.RSS_ARTICLE_SCAN;
    else process.env.RSS_ARTICLE_SCAN = originalScan;
  }
});

test("article evidence preserves semantic query identity and rejects punctuated 404s", () => {
  assert.equal(
    articlePageHasArticleEvidence(
      '<html><head><link rel="canonical" href="https://youtube.com/watch?v=wrong"></head><body><article><p>Blue Cross VT.</p></article></body></html>',
      "https://youtube.com/watch?v=expected&utm_source=rss",
    ),
    false,
  );
  assert.equal(
    articlePageHasArticleEvidence(
      '<html><head><link rel="canonical" href="https://youtube.com/watch?utm_medium=feed&v=expected"></head><body><article><p>Blue Cross VT.</p></article></body></html>',
      "https://youtube.com/watch?v=expected&utm_source=rss",
    ),
    true,
  );
  assert.equal(
    articlePageHasArticleEvidence(
      "<article><h1>Error 404: Not Found</h1><p>Blue Cross VT.</p></article>",
      "https://example.com/missing",
    ),
    false,
  );
});

test("matching canonical links preserve renamed article body matches", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";
  const link = "https://example.com/article";

  try {
    const [item] = await enrichAndFilterItems(
      [{
        sourceName: "Example Outlet",
        title: "Feed headline before an editor update",
        link,
        feedContent: "A local business story.",
        articleScanMode: "always",
      }],
      new Map(),
      {
        articleCache: {},
        now: new Date("2026-07-12T12:00:00Z"),
        fetchText: async () => ({
          text: `<html><head><link rel="canonical" href="${link}"></head><body><main><h1>Updated publisher headline</h1><p>Blue Cross VT announced a coverage change.</p></main></body></html>`,
          url: link,
          notModified: false,
          etag: "",
          lastModified: "",
        }),
        throttleRequest: async () => {},
      },
    );

    assert.deepEqual(item.matchedTerms, ["Blue Cross VT"]);
  } finally {
    if (originalScan === undefined) delete process.env.RSS_ARTICLE_SCAN;
    else process.env.RSS_ARTICLE_SCAN = originalScan;
  }
});

test("isLikelyPaywalled matches exact publisher hosts and their subdomains", () => {
  assert.equal(isLikelyPaywalled({ link: "https://www.statnews.com/story" }), true);
  assert.equal(isLikelyPaywalled({ link: "https://news.timesargus.com/story" }), true);
  assert.equal(isLikelyPaywalled({ link: "https://notstatnews.com/story" }), false);
  assert.equal(isLikelyPaywalled({ link: "https://timesargus.com.example/story" }), false);
});

test("enrichAndFilterItems fetches a preview for a signaled paywall item in feed-only mode", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";
  let requests = 0;

  try {
    const articleCache = {};
    const metrics = { enrichment: { scanModes: {} } };
    const items = await enrichAndFilterItems(
      [
        {
          sourceName: "STAT Health News",
          title: "Vermont premiums face new review",
          link: "https://www.statnews.com/2026/07/12/example/",
          feedContent: "Vermont health insurance premiums face a regulatory review.",
          scanArticle: false,
          articleScanMode: "feedOnly",
        },
      ],
      new Map(),
      {
        articleCache,
        metrics,
        now: new Date("2026-07-12T12:00:00Z"),
        fetchText: async (url) => {
          requests += 1;
          return {
            text: "<article><p>Vermont regulators are reviewing proposed premium increases.</p><p>The filing cites hospital and prescription drug costs.</p></article>",
            url,
            notModified: false,
            etag: "",
            lastModified: "",
          };
        },
        throttleRequest: async () => {},
      },
    );

    assert.equal(requests, 1);
    assert.equal(items.length, 1);
    assert.match(items[0].previewText, /^Vermont regulators/);
    assert.equal(items[0].previewChecked, true);
    assert.equal(articleCache[items[0].link].previewChecked, true);
    assert.equal(metrics.enrichment.previewFetches, 1);
    assert.equal(metrics.enrichment.previewsFound, 1);
  } finally {
    if (originalScan === undefined) {
      delete process.env.RSS_ARTICLE_SCAN;
    } else {
      process.env.RSS_ARTICLE_SCAN = originalScan;
    }
  }
});

test("RSS, JSON, and the reader label publisher previews separately", async () => {
  const item = {
    sourceName: "Times Argus",
    title: "Vermont health care story",
    link: "https://www.timesargus.com/news/example",
    pubDate: new Date("2026-07-12T12:00:00Z"),
    matchedTerms: ["Health care"],
    summary: "An independent summary.",
    previewText: "The publisher's first two paragraphs appear here.",
  };
  const rss = buildRss([item], { now: new Date("2026-07-12T13:00:00Z") });
  const json = buildJsonSummary(
    [item],
    [{ name: "Times Argus", ok: true, itemCount: 1 }],
    new Date("2026-07-12T13:00:00Z"),
  );
  const reader = await readFile(
    path.resolve(process.cwd(), "site", "index.html"),
    "utf8",
  );

  assert.match(rss, /<strong>Publisher preview:<\/strong>/);
  assert.match(rss, /publisher&apos;s first two paragraphs/i);
  assert.equal(json.items[0].previewText, item.previewText);
  assert.match(json.items[0].content_text, /Publisher preview:/);
  assert.match(reader, /item\.previewText/);
  assert.match(reader, /Publisher preview:/);
  assert.match(reader, /createElement\("blockquote"\)/);
  assert.match(reader, /className = "publisher-preview"/);
  assert.match(reader, /function displayablePreviewText\(value = ""\)/);
  assert.match(reader, /\.textContent\s*=/);
});

test("roundup previews publish only when they match the selected brief", () => {
  const kayak = {
    sourceName: "Google News Blue Cross Site Search",
    title: "Sports / Outdoors - Aug 27, 2026 - Times Argus",
    link: "https://www.timesargus.com/theworld/sports-outdoors---aug-27-2026/article_6d914917-d8c2-5922-bc4b-7731992d6dd6.html",
    pubDate: new Date("2026-08-27T12:00:00Z"),
    matchedTerms: ["Blue Cross VT", "bluecrossvt.org"],
    category: CATEGORY_BRAND,
    summary: "Blue Cross VT hosted its annual Kayak Days event.",
    previewText:
      "Hunters traveling outside Vermont must follow chronic wasting disease rules for deer, elk, and moose.",
  };
  const rss = buildRss([kayak], { now: new Date("2026-08-27T13:00:00Z") });
  const json = buildJsonSummary([kayak], [], new Date("2026-08-27T13:00:00Z"));

  assert.match(rss, /Blue Cross VT hosted its annual Kayak Days event/);
  assert.doesNotMatch(rss, /Publisher preview/);
  assert.doesNotMatch(rss, /chronic wasting disease/);
  assert.equal(json.items[0].previewText, "");
  assert.doesNotMatch(json.items[0].content_text, /chronic wasting disease/);

  const alignedBrand = buildJsonSummary(
    [
      {
        ...kayak,
        title: "Times Argus Business Briefs May 30, 2026",
        link: "https://www.timesargus.com/news/local/business-briefs-may-30",
        previewText: "Blue Cross VT announced new support for Vermont members.",
      },
    ],
    [],
    new Date("2026-08-27T13:00:00Z"),
  );
  assert.match(alignedBrand.items[0].previewText, /Blue Cross VT announced/);

  const alignedTopic = buildJsonSummary(
    [
      {
        ...kayak,
        title: "Health Briefs - Jul 23, 2026",
        link: "https://www.timesargus.com/theworld/health-briefs-jul-23",
        matchedTerms: ["Senior & long-term care"],
        category: CATEGORY_TOPIC,
        previewText: "A Vermont hospice expanded support for patients and families.",
      },
    ],
    [],
    new Date("2026-08-27T13:00:00Z"),
  );
  assert.match(alignedTopic.items[0].previewText, /Vermont hospice/);
});

test("reader is visible without a gate and exposes comment disclosure state", async () => {
  const reader = await readFile(
    path.resolve(process.cwd(), "site", "index.html"),
    "utf8",
  );

  // The reader is public and no longer ships the disabled presentation gate.
  assert.match(reader, /<div class="page" id="reader-page">/);
  assert.doesNotMatch(reader, /id="reader-page" hidden/);
  assert.doesNotMatch(reader, /password-gate|authenticated|blueNewsAuth/);
  assert.match(reader, /<title>Cerulean News[^<]*<\/title>/);
  assert.equal((reader.match(/>Cerulean News<\/h1>/g) || []).length, 1);
  assert.match(reader, /<div class="title-row">/);
  assert.match(reader, /<main aria-labelledby="reader-title">/);
  assert.match(reader, /id="results-status"/);
  assert.match(reader, /function announceResultCount\(count\)/);
  assert.match(reader, /setAttribute\("aria-expanded", "false"\)/);
  assert.match(reader, /setAttribute\(\s*"aria-expanded",\s*String\(!commentsContainer\.hidden\)/);
  assert.match(reader, /window\.scrollTo\(0, 0\)/);
  assert.match(reader, /readerTitleEl\.focus\(\{ preventScroll: true \}\)/);
});

test("normalizeCrawlState preserves preview cache state", () => {
  const oversizedPreview = `${"Vermont health care reporting. ".repeat(40)}END`;
  const state = normalizeCrawlState({
    articleCache: {
      "https://www.statnews.com/example": {
        expiresAt: "2026-07-20T12:00:00Z",
        previewText: oversizedPreview,
        previewChecked: true,
      },
    },
  });

  const cached = state.articleCache["https://www.statnews.com/example"];
  assert.ok(cached.previewText.length <= 600);
  assert.doesNotMatch(cached.previewText, /END$/);
  assert.equal(cached.previewChecked, true);
});

test("preview fetch errors use the short error cache without marking preview complete", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";
  let requests = 0;
  const articleCache = {};
  const item = {
    sourceName: "STAT Health News",
    title: "Vermont coverage update",
    link: "https://www.statnews.com/2026/07/12/error-example/",
    feedContent: "Vermont health insurance coverage update.",
    scanArticle: false,
  };
  const options = {
    articleCache,
    now: new Date("2026-07-12T12:00:00Z"),
    fetchText: async () => {
      requests += 1;
      throw new Error("temporary timeout");
    },
    throttleRequest: async () => {},
  };

  try {
    await enrichAndFilterItems([item], new Map(), options);
    await enrichAndFilterItems(
      [item],
      new Map(),
      { ...options, now: new Date("2026-07-12T13:00:00Z") },
    );

    assert.equal(requests, 1);
    assert.equal(articleCache[item.link].previewChecked, false);
    assert.match(articleCache[item.link].articleError, /temporary timeout/);
    assert.equal(articleCache[item.link].expiresAt, "2026-07-13T12:00:00.000Z");
  } finally {
    if (originalScan === undefined) delete process.env.RSS_ARTICLE_SCAN;
    else process.env.RSS_ARTICLE_SCAN = originalScan;
  }
});

test("legacy preview migration does not send validators that could yield an empty 304", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";
  const link = "https://www.statnews.com/2026/07/12/legacy-example/";
  const articleCache = {
    [link]: {
      url: link,
      resolvedUrl: link,
      expiresAt: "2026-07-20T12:00:00Z",
      matchedTerms: ["Health insurance"],
      matchSource: "searchFallback",
      articleHeaders: { etag: '"legacy"' },
    },
  };
  let conditionalHeaders;

  try {
    const items = await enrichAndFilterItems(
      [{
        sourceName: "STAT Health News",
        title: "Coverage",
        link,
        feedContent: "Vermont health insurance coverage update.",
      }],
      new Map(),
      {
        articleCache,
        now: new Date("2026-07-12T12:00:00Z"),
        fetchText: async (url, _accept, options) => {
          conditionalHeaders = options.conditionalHeaders;
          return {
            text: "<article><p>Vermont families are reviewing their health coverage options.</p></article>",
            url,
            notModified: false,
            etag: '"fresh"',
            lastModified: "",
          };
        },
        throttleRequest: async () => {},
      },
    );

    assert.deepEqual(conditionalHeaders, {});
    assert.match(items[0].previewText, /^Vermont families/);
    assert.equal(items[0].matchSource, "searchFallback");
  } finally {
    if (originalScan === undefined) delete process.env.RSS_ARTICLE_SCAN;
    else process.env.RSS_ARTICLE_SCAN = originalScan;
  }
});

test("preview article-cache hits preserve the matched archive summary and verdict", async () => {
  const link = "https://www.statnews.com/2026/07/12/cached-preview/";
  const now = new Date("2026-07-12T12:00:00Z");
  const cache = new Map([
    [link, {
      matchedTerms: ["Health insurance"],
      snippet: "Cached health insurance snippet.",
      summary: "The saved summary must survive the preview merge.",
      reason: "Coverage policy affects members.",
      relevant: true,
      matchSource: "searchFallback",
      previewChecked: false,
    }],
  ]);
  const articleCache = {
    [link]: {
      url: link,
      resolvedUrl: link,
      expiresAt: "2026-07-20T12:00:00Z",
      matchedTerms: ["Health insurance"],
      previewText: "A cached publisher preview.",
      previewChecked: true,
      comments: [],
      matchSource: "searchFallback",
    },
  };

  const [item] = await enrichAndFilterItems(
    [{
      sourceName: "STAT Health News",
      title: "Coverage",
      link,
      feedContent: "Vermont health insurance coverage update.",
    }],
    cache,
    { articleCache, now },
  );

  assert.equal(item.previewText, "A cached publisher preview.");
  assert.equal(item.summary, "The saved summary must survive the preview merge.");
  assert.equal(item.reason, "Coverage policy affects members.");
  assert.equal(item.relevant, true);
  assert.equal(item.matchSource, "searchFallback");
});

test("htmlToArticleText prefers domain-specific article selectors", () => {
  const html = `
    <!doctype html>
    <html>
      <body>
        <main>
          <p>Layout shell copy that should not become the article body.</p>
          <section class="storyBody">
            <p>Seven Days article text about Blue Cross VT members.</p>
            <p>Second paragraph with Vermont health care context.</p>
          </section>
        </main>
      </body>
    </html>
  `;

  const text = htmlToArticleText(
    html,
    "https://www.sevendaysvt.com/news/example-story-12345",
  );
  assert.match(text, /Seven Days article text/);
  assert.match(text, /Second paragraph/);
  assert.ok(!text.includes("Layout shell copy"));
});

test("extractArticleComments reads server-rendered article comments", () => {
  const html = `
    <!doctype html>
    <html>
      <body>
        <article>
          <p>Blue Cross VT filed a rate request.</p>
        </article>
        <section id="comments">
          <ol class="comment-list">
            <li id="comment-1" class="comment">
              <div class="comment-author"><span class="fn">Jane Reader</span></div>
              <time datetime="2026-06-16T10:00:00-04:00">June 16</time>
              <div class="comment-content">
                <p>This affects BCBS VT members in Vermont.</p>
              </div>
              <ul class="children">
                <li id="comment-2" class="comment">
                  <div class="comment-content"><p>Nested reply text.</p></div>
                </li>
              </ul>
            </li>
          </ol>
          <form><textarea>Leave a reply</textarea></form>
        </section>
        <script type="application/ld+json">
          {
            "@type": "NewsArticle",
            "comment": {
              "@type": "Comment",
              "author": { "name": "Json Reader" },
              "text": "JSON-LD comment about the story.",
              "datePublished": "2026-06-16T15:00:00Z"
            }
          }
        </script>
      </body>
    </html>
  `;

  assert.deepEqual(extractArticleComments(html), [
    {
      author: "Jane Reader",
      text: "This affects BCBS VT members in Vermont.",
      date: "2026-06-16T14:00:00.000Z",
      replies: [
        {
          author: "",
          text: "Nested reply text.",
          date: null,
          replies: [],
        },
      ],
    },
    {
      author: "Json Reader",
      text: "JSON-LD comment about the story.",
      date: "2026-06-16T15:00:00.000Z",
      replies: [],
    },
  ]);
});

test("enrichAndFilterItems attaches comments from matched article pages", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";

  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html>
      <html>
        <body>
          <article>
            <h1>Rate request</h1>
            <p>Blue Cross VT filed a new rate request for Vermont members.</p>
          </article>
          <section class="comments-area">
            <div class="comment">
              <div class="comment-author">Local Reader</div>
              <div class="comment-content">
                <p>Useful local context from the comment section.</p>
              </div>
            </div>
          </section>
        </body>
      </html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const filtered = await enrichAndFilterItems([
      {
        sourceName: "Local Outlet",
        title: "Rate request story",
        link: `http://127.0.0.1:${port}/story`,
        feedContent: "Rate request story",
      },
    ]);

    assert.equal(filtered.length, 1);
    assert.deepEqual(filtered[0].matchedTerms, [
      "Blue Cross VT",
      "Premiums & rate review",
    ]);
    assert.deepEqual(filtered[0].comments, [
      {
        author: "Local Reader",
        text: "Useful local context from the comment section.",
        date: null,
        replies: [],
      },
    ]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (originalScan === undefined) {
      delete process.env.RSS_ARTICLE_SCAN;
    } else {
      process.env.RSS_ARTICLE_SCAN = originalScan;
    }
  }
});

test("fetchText sends conditional headers and handles not-modified responses", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.headers);
    if (request.headers["if-none-match"] === '"feed-v1"') {
      response.writeHead(304, {
        etag: '"feed-v1"',
        "last-modified": "Tue, 16 Jun 2026 15:00:00 GMT",
      });
      response.end();
      return;
    }

    response.writeHead(200, {
      "content-type": "text/plain",
      etag: '"feed-v1"',
      "last-modified": "Tue, 16 Jun 2026 15:00:00 GMT",
    });
    response.end("fresh body");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/feed.xml`;
    const first = await fetchText(url, "text/plain");
    const second = await fetchText(url, "text/plain", {
      conditionalHeaders: {
        etag: first.etag,
        lastModified: first.lastModified,
      },
    });

    assert.equal(first.text, "fresh body");
    assert.equal(first.etag, '"feed-v1"');
    assert.equal(second.notModified, true);
    assert.equal(second.text, "");
    assert.equal(requests[1]["if-none-match"], '"feed-v1"');
    assert.equal(
      requests[1]["if-modified-since"],
      "Tue, 16 Jun 2026 15:00:00 GMT",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("readResponseTextWithLimit decodes normal bodies and rejects oversized ones", async () => {
  const small = new Response("Blue Cross VT update");
  assert.equal(
    await readResponseTextWithLimit(small, 1024),
    "Blue Cross VT update",
  );

  // Body larger than the cap is rejected mid-stream and marked non-retryable.
  const big = new Response("x".repeat(2048));
  await assert.rejects(
    () => readResponseTextWithLimit(big, 1024),
    (error) => /exceeds 1024 bytes/.test(error.message) && error.nonRetryable === true,
  );

  // A content-length header over the cap short-circuits before reading.
  const declared = new Response("tiny body", {
    headers: { "content-length": "999999" },
  });
  await assert.rejects(
    () => readResponseTextWithLimit(declared, 1024),
    (error) =>
      /content-length 999999/.test(error.message) && error.nonRetryable === true,
  );
});

test("enrichAndFilterItems skips network fetches on cache hits", async () => {
  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";
  
  try {
    const items = [
      {
        sourceName: "Cached Outlet",
        title: "News story",
        link: "https://example.com/cached-article",
        feedContent: "Prior authorization policy update for BCBSVT members.",
      }
    ];

    const cache = new Map([
      ["https://example.com/cached-article", {
        matchedTerms: ["BCBSVT"],
        snippet: "Cached snippet about BCBSVT.",
        articleError: "No error"
      }]
    ]);

    const filtered = await enrichAndFilterItems(items, cache);
    assert.equal(filtered.length, 1);
    assert.deepEqual(filtered[0].matchedTerms, [
      "BCBSVT",
      "Prior authorization & claims",
    ]);
    assert.equal(filtered[0].snippet, "Cached snippet about BCBSVT.");
    assert.equal(filtered[0].articleError, "No error");
  } finally {
    process.env.RSS_ARTICLE_SCAN = originalScan;
  }
});

test("fetchText retries 429 responses honoring Retry-After in both forms", async () => {
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    if (hits === 1) {
      response.writeHead(429, { "retry-after": "1" });
      response.end("slow down");
      return;
    }
    if (hits === 2) {
      // HTTP-date form: one second in the future.
      response.writeHead(429, {
        "retry-after": new Date(Date.now() + 1000).toUTCString(),
      });
      response.end("slow down");
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("recovered");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const result = await fetchText(
      `http://127.0.0.1:${port}/feed.xml`,
      "text/plain",
    );
    assert.equal(result.text, "recovered");
    assert.equal(hits, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("fetchText retries HTTP 408 but not other 4xx errors", async () => {
  let timeoutHits = 0;
  let forbiddenHits = 0;
  const server = createServer((request, response) => {
    if (request.url.includes("timeout")) {
      timeoutHits += 1;
      if (timeoutHits === 1) {
        response.writeHead(408);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("second try");
      return;
    }
    forbiddenHits += 1;
    response.writeHead(403);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const recovered = await fetchText(
      `http://127.0.0.1:${port}/timeout`,
      "text/plain",
    );
    assert.equal(recovered.text, "second try");
    assert.equal(timeoutHits, 2);

    await assert.rejects(
      () => fetchText(`http://127.0.0.1:${port}/forbidden`, "text/plain"),
      (error) => error.status === 403,
    );
    assert.equal(forbiddenHits, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("readResponseTextWithLimit decodes non-UTF-8 charsets", async () => {
  // "Montpelier’s" with a Windows-1252 right single quote (0x92).
  const win1252Body = Buffer.from("Montpelier\x92s premiums", "latin1");

  const declared = new Response(win1252Body, {
    headers: { "content-type": "text/xml; charset=windows-1252" },
  });
  assert.equal(
    await readResponseTextWithLimit(declared),
    "Montpelier’s premiums",
  );

  // No header charset: the XML prolog declaration is honored instead.
  const prologBody = Buffer.from(
    '<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Qu\xe9bec health</title></channel></rss>',
    "latin1",
  );
  const sniffed = new Response(prologBody, {
    headers: { "content-type": "text/xml" },
  });
  assert.match(await readResponseTextWithLimit(sniffed), /Québec health/);

  // Plain UTF-8 stays the default.
  const utf8 = new Response("Café stays café");
  assert.equal(await readResponseTextWithLimit(utf8), "Café stays café");
});

test("enrichAndFilterItems expires error-based no-match verdicts quickly", async () => {
  const server = createServer((request, response) => {
    if (request.url.includes("broken")) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body><article><p>Weather and local sports.</p></article></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const originalScan = process.env.RSS_ARTICLE_SCAN;
  process.env.RSS_ARTICLE_SCAN = "true";
  try {
    const { port } = server.address();
    const now = new Date("2026-07-02T12:00:00Z");
    const articleCache = {};
    const items = [
      {
        sourceName: "Outlet",
        title: "Story behind a broken page",
        link: `http://127.0.0.1:${port}/broken`,
        feedContent: "Announcement",
        requireBrandMatch: true,
      },
      {
        sourceName: "Outlet",
        title: "Story that fetched fine",
        link: `http://127.0.0.1:${port}/ok`,
        feedContent: "Announcement",
        requireBrandMatch: true,
      },
    ];

    const filtered = await enrichAndFilterItems(items, new Map(), {
      articleCache,
      now,
    });
    assert.equal(filtered.length, 0);

    const dayMs = 24 * 60 * 60 * 1000;
    const errorEntry = articleCache[`http://127.0.0.1:${port}/broken`];
    assert.ok(errorEntry.articleError, "error entry records the fetch failure");
    assert.ok(
      new Date(errorEntry.expiresAt).valueOf() - now.valueOf() <= dayMs,
      "fetch-error no-match entries expire within a day",
    );

    const cleanEntry = articleCache[`http://127.0.0.1:${port}/ok`];
    assert.equal(cleanEntry.articleError, "");
    assert.ok(
      new Date(cleanEntry.expiresAt).valueOf() - now.valueOf() > dayMs,
      "clean no-match entries keep the long negative-cache TTL",
    );
  } finally {
    process.env.RSS_ARTICLE_SCAN = originalScan;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("parseSummaryResponse tolerates markdown-fenced JSON", () => {
  const batch = [{ title: "Rate filing story" }];
  const fenced = [
    "```json",
    '[{"id": 1, "summary": "Regulators review the 2027 rate filing.", "reason": "Premiums affect members", "relevant": true}]',
    "```",
  ].join("\n");

  const applied = parseSummaryResponse(fenced, batch);
  assert.equal(applied, 1);
  assert.equal(batch[0].summary, "Regulators review the 2027 rate filing.");
  assert.equal(batch[0].relevant, true);
});

test("buildRss omits empty source elements and advertises a ttl", () => {
  const rss = buildRss(
    [
      {
        sourceName: "Archived Outlet",
        sourceFeedUrl: "",
        title: "Old story that lost its feed URL",
        link: "https://example.com/old-story",
        guid: "https://example.com/old-story",
        pubDate: new Date("2026-06-01T12:00:00Z"),
        matchedTerms: ["BCBSVT"],
        snippet: "BCBSVT mention.",
      },
    ],
    { now: new Date("2026-07-02T12:00:00Z"), feedUrl: "https://example.com/feed.rss" },
  );

  assert.ok(rss.includes("<ttl>60</ttl>"));
  assert.ok(!rss.includes("<source url=\"\">"));
  assert.ok(rss.includes("<link>https://example.com/old-story</link>"));
});

test("enrichAndFilterItems prunes expired cache entries unless validators remain useful", async () => {
  const now = new Date("2026-07-02T12:00:00Z");
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  const articleCache = {
    "https://example.com/expired-plain": {
      url: "https://example.com/expired-plain",
      expiresAt: new Date(now.valueOf() - hourMs).toISOString(),
      matchedTerms: [],
      articleHeaders: {},
    },
    "https://example.com/expired-with-etag": {
      url: "https://example.com/expired-with-etag",
      expiresAt: new Date(now.valueOf() - hourMs).toISOString(),
      matchedTerms: [],
      articleHeaders: { etag: '"v1"', lastModified: "" },
    },
    "https://example.com/long-expired-with-etag": {
      url: "https://example.com/long-expired-with-etag",
      expiresAt: new Date(now.valueOf() - 20 * dayMs).toISOString(),
      matchedTerms: [],
      articleHeaders: { etag: '"v1"', lastModified: "" },
    },
    "https://example.com/still-fresh": {
      url: "https://example.com/still-fresh",
      expiresAt: new Date(now.valueOf() + dayMs).toISOString(),
      matchedTerms: [],
      articleHeaders: {},
    },
  };

  await enrichAndFilterItems([], new Map(), { articleCache, now });

  assert.deepEqual(Object.keys(articleCache).sort(), [
    "https://example.com/expired-with-etag",
    "https://example.com/still-fresh",
  ]);
});

test("readResponseTextWithLimit prefers valid UTF-8 over a mislabeled charset", async () => {
  // Real UTF-8 bytes behind a classic Apache AddDefaultCharset misconfig.
  const mislabeled = new Response(Buffer.from("Café in Montpelier", "utf8"), {
    headers: { "content-type": "text/xml; charset=iso-8859-1" },
  });
  assert.equal(await readResponseTextWithLimit(mislabeled), "Café in Montpelier");

  // A UTF-8 BOM outranks the declared charset and is stripped.
  const withBom = new Response(
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Café", "utf8")]),
    { headers: { "content-type": "text/html; charset=windows-1252" } },
  );
  assert.equal(await readResponseTextWithLimit(withBom), "Café");
});

test("fetchText gives up in-run when Retry-After exceeds the sleep cap, and cooldowns are bounded", async () => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(429, {
      // Far-future HTTP-date form: a clock-skewed server.
      "retry-after": new Date("2031-01-01T00:00:00Z").toUTCString(),
    });
    response.end("come back much later");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const { port } = server.address();
    const primaryFeedUrl = `http://127.0.0.1:${port}/rss.xml`;
    const startedMs = Date.now();
    const now = new Date();
    const crawlState = { sourceState: {}, articleCache: {} };
    const { sourceResults } = await collectFeedItems(
      [
        {
          name: "Skewed Outlet",
          homepage: "https://example.com/",
          feedUrl: primaryFeedUrl,
          fallbackFeed: {
            feedUrl: `data:application/rss+xml,${encodeURIComponent(
              '<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>',
            )}`,
            scanArticle: false,
          },
        },
      ],
      now,
      crawlState,
    );

    // One attempt only: the requested backoff exceeds what an in-run retry
    // can honor, so retrying sooner would just hammer the server.
    assert.equal(hits, 1);
    assert.ok(Date.now() - startedMs < 10000, "no long retry sleep");
    assert.equal(sourceResults[0].ok, true);
    assert.match(sourceResults[0].primaryError, /HTTP 429/);

    // The persisted cooldown is capped (24h), not the ~4.5 years requested.
    const cooldownUntil = new Date(
      crawlState.sourceState["Skewed Outlet"].primaryCooldownUntil,
    );
    const maxCooldownMs = 24 * 60 * 60 * 1000 + 60 * 1000;
    assert.ok(
      cooldownUntil.valueOf() - now.valueOf() <= maxCooldownMs,
      `cooldown capped, got ${cooldownUntil.toISOString()}`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// bluecrossvt.org is the subject of this feed, so its politeness settings get
// held in place by tests rather than by comments alone.
const BLUE_CROSS_NEWS_URL = "https://www.bluecrossvt.org/health-community/news";

test("bluecrossvt.org gets a slower shared queue and honors its cache headers", () => {
  const policy = politenessPolicyFor(BLUE_CROSS_NEWS_URL);
  assert.ok(policy, "expected a host policy for bluecrossvt.org");
  assert.equal(policy.throttleGroup, "bluecrossvt.org");
  assert.ok(policy.throttleDelayMs >= 5000);
  assert.ok(policy.honorCacheControl);
  // Every other outlet keeps the global defaults.
  assert.equal(politenessPolicyFor("https://vtdigger.org/feed/"), null);
});

test("Cache-Control freshness subtracts Age and respects the cap", () => {
  const now = new Date("2026-08-07T12:00:00Z");
  const headersFor = (values) => ({ get: (name) => values[name] ?? "" });

  // max-age 86400 with Age 3600 leaves 23h; the cap passed here clamps it.
  assert.equal(
    freshUntilFromHeaders(
      headersFor({ "cache-control": "max-age=86400, public", age: "3600" }),
      now,
      6 * 60 * 60 * 1000,
    ),
    "2026-08-07T18:00:00.000Z",
  );
  // Under the cap, the server's own remaining lifetime is used verbatim.
  assert.equal(
    freshUntilFromHeaders(
      headersFor({ "cache-control": "max-age=7200", age: "1800" }),
      now,
      6 * 60 * 60 * 1000,
    ),
    "2026-08-07T13:30:00.000Z",
  );
  // No reusable signal: no-store, no max-age, or already stale.
  assert.equal(freshUntilFromHeaders(headersFor({ "cache-control": "no-store" }), now), "");
  assert.equal(freshUntilFromHeaders(headersFor({ "cache-control": "public" }), now), "");
  assert.equal(
    freshUntilFromHeaders(
      headersFor({ "cache-control": "max-age=600", age: "900" }),
      now,
    ),
    "",
  );
});

test("a weak ETag the origin ignores stops being sent, so revalidation returns 304", async () => {
  const requests = [];
  const etag = 'W/"1786040101"';
  const lastModified = "Thu, 06 Aug 2026 18:15:01 GMT";
  // Mimics bluecrossvt.org: advertises a weak ETag it never validates, but
  // honors If-Modified-Since when If-None-Match is absent.
  const server = createServer((request, response) => {
    requests.push({
      ifNoneMatch: request.headers["if-none-match"] || "",
      ifModifiedSince: request.headers["if-modified-since"] || "",
    });
    const canUseIms =
      !request.headers["if-none-match"] &&
      request.headers["if-modified-since"] === lastModified;
    if (canUseIms) {
      response.writeHead(304, { etag, "last-modified": lastModified });
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html",
      etag,
      "last-modified": lastModified,
    });
    response.end("<html><body>listing</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const url = `http://127.0.0.1:${server.address().port}/health-community/news`;
    const first = await fetchText(url, "text/html", {
      conditionalHeaders: { etag, lastModified },
    });
    assert.equal(first.notModified, undefined);
    assert.equal(
      first.preferLastModified,
      true,
      "unchanged validators on a 200 mean the ETag round trip is useless",
    );

    const second = await fetchText(url, "text/html", {
      conditionalHeaders: { etag, lastModified, preferLastModified: true },
    });
    assert.equal(second.notModified, true);
    assert.equal(second.text, "");

    assert.equal(requests.length, 2);
    assert.equal(requests[0].ifNoneMatch, etag);
    assert.equal(requests[1].ifNoneMatch, "", "If-None-Match must be dropped");
    assert.equal(requests[1].ifModifiedSince, lastModified);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a source stays unfetched while the origin's declared cache is still fresh", async () => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<outline-search-result>
      <div slot="heading"><a href="/newsroom/current-story">Current story</a></div>
      <div slot="date">August 7, 2026</div>
    </outline-search-result>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const listingUrl = `http://127.0.0.1:${server.address().port}/health-community/news`;
    const source = {
      name: "Fresh Listing",
      listingUrl,
      listingParser: "uvmHealthNewsroom",
      minimumParsedItems: 1,
      scanArticle: false,
    };
    const now = new Date("2026-08-07T12:00:00Z");
    const crawlState = normalizeCrawlState({
      sourceState: {
        "Fresh Listing": {
          feedHeaders: {
            [listingUrl]: {
              etag: "",
              lastModified: "",
              checkedAt: "2026-08-07T11:00:00.000Z",
              freshUntil: "2026-08-07T17:00:00.000Z",
            },
          },
        },
      },
    });

    const metrics = { collection: {} };
    const fresh = await collectFeedItems([source], now, crawlState, metrics);
    assert.equal(requestCount, 0, "a fresh cached copy must not be re-fetched");
    assert.equal(metrics.collection.cacheFreshSkips, 1);
    assert.equal(fresh.sourceResults[0].ok, true);

    // Once the window lapses the source is fetched again.
    const later = new Date("2026-08-07T18:00:00Z");
    await collectFeedItems([source], later, crawlState, { collection: {} });
    assert.equal(requestCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a fresh listing response that parses no items marks the source unhealthy", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><body><p>A redesigned listing with no known cards.</p></body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const listingUrl = `http://127.0.0.1:${server.address().port}/newsroom/search`;
    const result = await collectFeedItems(
      [{
        name: "Redesigned Listing",
        listingUrl,
        listingParser: "uvmHealthNewsroom",
        minimumParsedItems: 1,
        scanArticle: false,
      }],
      new Date("2026-08-27T12:00:00Z"),
      normalizeCrawlState({}),
      { collection: {} },
    );

    assert.equal(result.sourceResults[0].ok, false);
    assert.match(result.sourceResults[0].error, /parser returned 0 items/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("date bounds may reduce a healthy nonempty listing to zero items", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<outline-search-result>
      <div slot="heading"><a href="/newsroom/old-story">Old story</a></div>
      <div slot="date">June 1, 2026</div>
    </outline-search-result>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const listingUrl = `http://127.0.0.1:${server.address().port}/newsroom/search`;
    const result = await collectFeedItems(
      [{
        name: "Bounded Listing",
        listingUrl,
        listingParser: "uvmHealthNewsroom",
        minimumParsedItems: 1,
        maxItemAgeDays: 1,
        scanArticle: false,
      }],
      new Date("2026-08-27T12:00:00Z"),
      normalizeCrawlState({}),
      { collection: {} },
    );

    assert.equal(result.sourceResults[0].ok, true);
    assert.equal(result.sourceResults[0].itemCount, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("crawl state round-trips freshUntil and preferLastModified through the audit JSON", () => {
  const state = normalizeCrawlState({
    sourceState: {
      "BlueCrossVT Newsroom": {
        feedHeaders: {
          [BLUE_CROSS_NEWS_URL]: {
            etag: 'W/"1786040101"',
            lastModified: "Thu, 06 Aug 2026 18:15:01 GMT",
            checkedAt: "2026-08-07T12:00:00.000Z",
            freshUntil: "2026-08-07T18:00:00.000Z",
            preferLastModified: true,
          },
        },
      },
    },
  });
  const headers =
    state.sourceState["BlueCrossVT Newsroom"].feedHeaders[BLUE_CROSS_NEWS_URL];
  assert.equal(headers.freshUntil, "2026-08-07T18:00:00.000Z");
  assert.equal(headers.preferLastModified, true);

  // A malformed freshUntil is dropped rather than parking the source forever.
  const bad = normalizeCrawlState({
    sourceState: {
      X: { feedHeaders: { "https://x.test/": { checkedAt: "now", freshUntil: "soon" } } },
    },
  });
  assert.equal(bad.sourceState.X.feedHeaders["https://x.test/"].freshUntil, "");
});

test("every curated source is either a registered Vermont outlet or an explicit exception", () => {
  const nonRegionalSourceNames = new Set([
    ...BROAD_NATIONAL_SOURCE_NAMES,
    // Google News search feeds have no single home region.
    "Google News Blue Cross Site Search",
    "Google News Blue Cross Phrase Search",
    "Google News Blue Cross Spelling Variant Search",
    "Google News Blue Cross Boolean Search A",
    "Google News Blue Cross Boolean Search B",
    "Google News Blue Cross Full-Name Search A",
    "Google News Blue Cross Full-Name Search B",
    "Google News Vermont Health Search A",
    "Google News Vermont Health Search B",
    "Google News Vermont Health Search C",
    "Google News Vermont Health Search D",
    "Google News Vermont Health Search E",
    "Google News Kristina Source Search",
    "Google News Health Insurance Search",
    "Google News Health Trade Search",
    "Google News National Health Policy Search",
    // A curated backfill spans every outlet the team logged, so it has no
    // single home region of its own.
    "Media Tracker Backfill",
    // Brand-owned listings classify as brand regardless of region.
    "BCBSA Association News",
  ]);

  const uncovered = DEFAULT_SOURCES.map((source) => source.name).filter(
    (name) =>
      !VERMONT_SOURCE_NAMES.has(name) && !nonRegionalSourceNames.has(name),
  );
  assert.deepEqual(
    uncovered,
    [],
    `sources missing from VERMONT_SOURCE_NAMES: ${uncovered.join(", ")}`,
  );
});

test("Vermont outlets keep their regional signal through town and county names that collide with states", () => {
  // Washington County is a Vermont county; pre-fix this read as Washington
  // state and the item was rejected as out-of-region.
  const washingtonCounty = {
    sourceName: "Times Argus",
    title: "Washington County clinics expand evening hours",
    description: "The hospital board approved the schedule.",
    matchedTerms: ["Hospitals"],
    category: CATEGORY_TOPIC,
  };
  assert.equal(applyDeterministicRelevance(washingtonCounty).relevant, undefined);

  // Georgia is a town in Franklin County, Vermont.
  const georgiaTown = {
    sourceName: "VTDigger",
    title: "Georgia residents weigh in on a school health program",
    description: "The community meeting drew dozens of residents.",
    matchedTerms: ["Public health"],
    category: CATEGORY_TOPIC,
  };
  assert.equal(applyDeterministicRelevance(georgiaTown).relevant, undefined);

  // Small outlets newly registered as Vermont sources keep local coverage.
  const cabot = {
    sourceName: "Cabot Chronicle",
    title: "Town report highlights public health programs",
    description: "Selectboard members reviewed the year in town services.",
    matchedTerms: ["Public health"],
    category: CATEGORY_TOPIC,
  };
  assert.equal(applyDeterministicRelevance(cabot).relevant, undefined);

  // The strip must not rescue national outlets: an unregistered source
  // naming Georgia with no policy angle stays rejected.
  const georgiaState = {
    sourceName: "CNN Health",
    title: "A Georgia town approves a new clinic",
    description: "Local officials celebrated the opening.",
    matchedTerms: ["Hospitals"],
    category: CATEGORY_TOPIC,
  };
  assert.equal(applyDeterministicRelevance(georgiaState).relevant, false);
});

test("fetchText rejects HTTP errors without breaking subsequent requests on the origin", async () => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    if (hits === 1) {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("blocked".repeat(100000));
      return;
    }
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("recovered");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const url = `http://127.0.0.1:${server.address().port}/feed.xml`;
    await assert.rejects(
      () => fetchText(url, "text/plain"),
      (error) => error.status === 403,
    );
    const recovered = await fetchText(url, "text/plain");
    assert.equal(recovered.text, "recovered");
    assert.equal(hits, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("generateFeed creates each configured output directory", async () => {
  const workdir = await mkdtemp(path.join(tmpdir(), "vt-news-output-dirs-"));
  const rssOutputPath = path.join(workdir, "rss", "feed.rss");
  const jsonOutputPath = path.join(workdir, "json", "feed.json");
  const auditJsonOutputPath = path.join(workdir, "audit", "feed-audit.json");

  await generateFeed({
    sources: [],
    now: new Date("2026-08-25T12:00:00Z"),
    rssOutputPath,
    jsonOutputPath,
    auditJsonOutputPath,
  });

  for (const outputPath of [rssOutputPath, jsonOutputPath, auditJsonOutputPath]) {
    await readFile(outputPath, "utf8");
  }
});

test("Blue Cross brand searches stay small and never mix site: with phrases", () => {
  // Live measurement (WORKLOG 2026-08-25): the original combined 23-term
  // query returned 3 items while its own terms unioned to 49, and queries
  // mixing site: operators with quoted phrases collapsed hardest. These
  // invariants keep the brand searches inside the shape that Google News
  // actually evaluates.
  const brandSources = DEFAULT_SOURCES.filter((source) =>
    source.name.startsWith("Google News Blue Cross"),
  );
  assert.ok(brandSources.length >= 7, "expected the split brand searches");

  for (const source of brandSources) {
    const query = decodeURIComponent(
      new URL(source.feedUrl).searchParams.get("q"),
    );
    assert.ok(
      query.length <= 160,
      `${source.name} query grew to ${query.length} chars; Google News degrades long OR queries`,
    );
    if (query.includes("site:")) {
      assert.equal(
        query.includes('"'),
        false,
        `${source.name} mixes site: operators with quoted phrases`,
      );
    }
    assert.match(query, / when:30d$/);
    assert.deepEqual(source.searchFallbackTerms, ["Blue Cross"]);
  }
});

test("fetchText surfaces the undici cause code on network failures", async () => {
  // Nothing listens on this high loopback port, so the connection is
  // refused immediately.
  await assert.rejects(
    () => fetchText("http://127.0.0.1:47654/feed.xml", "text/plain"),
    (error) => /^fetch failed \(.+\)$/.test(error.message),
  );
});

test("parseFacebookPageHtml bounds anchor-path descriptions to the nearest post container", () => {
  const pageFiller = "Page boilerplate. ".repeat(400);
  const postText =
    "BlueCross BlueShield of Vermont is partnering with local clinics on a new preventive care program.";
  const html = `<html><head><title>VTDigger</title></head><body>
    <div>${pageFiller}
      <article>
        <div><p>${postText}</p></div>
        <a href="/vtdigger/posts/789?refid=7">Full Story</a>
      </article>
    </div>
  </body></html>`;

  const [item] = parseFacebookPageHtml(html, {
    name: "VTDigger Facebook page",
    facebookPageUrl: "https://www.facebook.com/vtdigger",
    now: new Date("2026-08-25T18:00:00Z"),
  });

  assert.ok(item, "expected a parsed post");
  assert.match(item.description, /preventive care program/);
  assert.ok(
    item.description.length <= 1200,
    `description should stay bounded, got ${item.description.length}`,
  );
  assert.doesNotMatch(item.description, /boilerplate/);
  assert.match(item.feedContent, /preventive care program/);
  assert.doesNotMatch(item.feedContent, /boilerplate/);
});

test("every origin's Cache-Control freshness is honored up to the global cap", async () => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, {
      "content-type": "text/html",
      "cache-control": "public, max-age=7200",
    });
    response.end("<html><body>feed</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const feedUrl = `http://127.0.0.1:${server.address().port}/feed.xml`;
    const source = { name: "Capped Fresh Outlet", listingUrl: feedUrl };
    const now = new Date("2026-08-25T12:00:00Z");
    const crawlState = normalizeCrawlState();
    const metrics = { collection: {} };

    await collectFeedItems([source], now, crawlState, metrics);
    assert.equal(requestCount, 1);
    const stored = crawlState.sourceState["Capped Fresh Outlet"].feedHeaders[feedUrl];
    const freshMs = new Date(stored.freshUntil).valueOf() - now.valueOf();
    assert.ok(
      freshMs > 0 && freshMs <= 60 * 60 * 1000,
      `freshUntil must be capped at one hour, got ${freshMs}ms`,
    );

    await collectFeedItems([source], now, crawlState, { collection: {} });
    assert.equal(requestCount, 1, "a fresh cached copy must not be re-fetched");

    // After the cap lapses, the source is fetched again.
    await collectFeedItems(
      [source],
      new Date("2026-08-25T13:01:00Z"),
      crawlState,
      { collection: {} },
    );
    assert.equal(requestCount, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("RSS_GLOBAL_CACHE_FRESHNESS_CAP_MS=0 disables non-policy freshness deferral", async () => {
  const original = process.env.RSS_GLOBAL_CACHE_FRESHNESS_CAP_MS;
  process.env.RSS_GLOBAL_CACHE_FRESHNESS_CAP_MS = "0";
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, {
      "content-type": "text/html",
      "cache-control": "public, max-age=86400",
    });
    response.end("<html><body>feed</body></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const feedUrl = `http://127.0.0.1:${server.address().port}/feed.xml`;
    const source = { name: "Disabled Cap Outlet", listingUrl: feedUrl };
    const now = new Date("2026-08-25T12:00:00Z");
    const crawlState = normalizeCrawlState();

    await collectFeedItems([source], now, crawlState, { collection: {} });
    await collectFeedItems([source], now, crawlState, { collection: {} });
    assert.equal(requestCount, 2, "no freshness window may be stored when disabled");
    assert.equal(
      crawlState.sourceState["Disabled Cap Outlet"].feedHeaders[feedUrl]?.freshUntil || "",
      "",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (original === undefined) {
      delete process.env.RSS_GLOBAL_CACHE_FRESHNESS_CAP_MS;
    } else {
      process.env.RSS_GLOBAL_CACHE_FRESHNESS_CAP_MS = original;
    }
  }
});

// ---------------------------------------------------------------------------
// Sentiment (media-tracker parity)
// ---------------------------------------------------------------------------

test("SENTIMENT_VALUES matches the tracker's five-point scale", () => {
  assert.deepEqual(SENTIMENT_VALUES, [
    "positive",
    "neutral to positive",
    "neutral",
    "neutral to negative",
    "negative",
  ]);
});

test("normalizeSentiment repairs the tracker's real-world spellings", () => {
  // Values observed verbatim in Media Tracker.xlsx.
  assert.equal(normalizeSentiment("Postive "), "positive");
  assert.equal(normalizeSentiment("neuttral to positive"), "neutral to positive");
  assert.equal(normalizeSentiment("Neutral"), "neutral");
  assert.equal(
    normalizeSentiment("negative (and more neg to uvm)"),
    "negative",
  );
  assert.equal(
    normalizeSentiment(
      "neutral to negative - while we are only mentioned in conjunction w/michgan",
    ),
    "neutral to negative",
  );
  assert.equal(
    normalizeSentiment("postive - mention lowest inc. in 5 yrs"),
    "positive",
  );
  assert.equal(normalizeSentiment(""), "");
  assert.equal(normalizeSentiment(null), "");
  assert.equal(normalizeSentiment("wildly enthusiastic"), "");
});

test("shouldScoreSentiment covers brand news only", () => {
  const brandNews = {
    matchedTerms: ["BCBSVT"],
    link: "https://vtdigger.org/2026/08/01/story",
  };
  assert.equal(shouldScoreSentiment(brandNews), true);

  // Vermont health care stories that never name us are out of scope.
  assert.equal(
    shouldScoreSentiment({
      matchedTerms: ["hospital"],
      link: "https://vtdigger.org/2026/08/01/other",
    }),
    false,
  );

  // Our own posts are owned content, not press coverage.
  assert.equal(
    shouldScoreSentiment({
      matchedTerms: ["BCBSVT"],
      link: "https://www.bluecrossvt.org/blog/post",
    }),
    false,
  );

  // Facebook items are social, not press coverage.
  assert.equal(
    shouldScoreSentiment({
      matchedTerms: ["BCBSVT"],
      link: "https://www.facebook.com/bcbsvt/posts/1",
    }),
    false,
  );
});

test("buildSummaryPrompt flags which articles get a sentiment score", () => {
  const prompt = buildSummaryPrompt([
    {
      title: "Blue Cross VT raises rates",
      sourceName: "VTDigger",
      matchedTerms: ["BCBSVT"],
      link: "https://vtdigger.org/2026/08/01/story",
      snippet: "Rates rise.",
    },
    {
      title: "Hospital opens wing",
      sourceName: "VTDigger",
      matchedTerms: ["hospital"],
      link: "https://vtdigger.org/2026/08/01/wing",
      snippet: "A new wing.",
    },
  ]);

  assert.match(prompt, /MENTIONS BCBSVT: yes/);
  assert.match(prompt, /MENTIONS BCBSVT: no/);
  assert.match(prompt, /neutral to negative/);
  // The four judging rules taken from the tracker must reach the model.
  assert.match(prompt, /tone TOWARD BCBSVT specifically/);
  assert.match(prompt, /Weight the headline heavily/);
  assert.match(prompt, /Weight mention prominence/);
});

test("buildSummaryPrompt names the resolved publisher, not the discovery feed", () => {
  const prompt = buildSummaryPrompt([{
    sourceName: "Google News Blue Cross Boolean Search A",
    title: "Blue Cross VT files 2027 rates",
    link: "https://www.wcax.com/2026/08/18/rates/",
    matchedTerms: ["BCBSVT"],
  }]);
  assert.match(prompt, /OUTLET: WCAX/);
  assert.doesNotMatch(prompt, /OUTLET: Google News/);
});

test("parseSummaryResponse scores brand items and ignores stray scores", () => {
  const batch = [
    {
      title: "Blue Cross VT wins award",
      sourceName: "VermontBiz",
      matchedTerms: ["BCBSVT"],
      link: "https://vermontbiz.com/news/award",
    },
    {
      title: "Hospital budget hearing",
      sourceName: "VTDigger",
      matchedTerms: ["hospital"],
      link: "https://vtdigger.org/budget",
    },
  ];

  const applied = parseSummaryResponse(
    JSON.stringify([
      {
        id: 1,
        summary: "BCBSVT named best health insurer.",
        reason: "Names BCBSVT directly",
        relevant: true,
        sentiment: "Postive",
        sentimentReason: "Award coverage naming us favorably",
      },
      {
        id: 2,
        summary: "Board reviews the hospital budget.",
        reason: "Cost pressure affects premiums",
        relevant: true,
        // A stray score on a topic-only story must be dropped locally.
        sentiment: "negative",
        sentimentReason: "should not survive",
      },
    ]),
    batch,
  );

  assert.equal(applied, 2);
  assert.equal(batch[0].sentiment, "positive");
  assert.equal(batch[0].sentimentReason, "Award coverage naming us favorably");
  assert.equal(batch[1].sentiment, undefined);
  assert.equal(batch[1].sentimentReason, undefined);
});

test("parseSummaryResponse drops an unusable sentiment value", () => {
  const batch = [
    {
      title: "Blue Cross VT statement",
      sourceName: "WCAX",
      matchedTerms: ["BCBSVT"],
      link: "https://www.wcax.com/2026/08/01/statement",
    },
  ];

  parseSummaryResponse(
    JSON.stringify([
      {
        id: 1,
        summary: "BCBSVT issued a statement.",
        reason: "Names BCBSVT directly",
        relevant: true,
        sentiment: "somewhat mixed",
      },
    ]),
    batch,
  );

  assert.equal(batch[0].summary, "BCBSVT issued a statement.");
  assert.equal(batch[0].sentiment, undefined);
});

test("buildJsonSummary publishes sentiment only for scored items", () => {
  const summary = buildJsonSummary(
    [
      {
        title: "Blue Cross VT wins award",
        link: "https://vermontbiz.com/news/award",
        sourceName: "VermontBiz",
        matchedTerms: ["BCBSVT"],
        pubDate: new Date("2026-08-01T12:00:00Z"),
        summary: "BCBSVT named best health insurer.",
        sentiment: "positive",
        sentimentReason: "Award coverage naming us favorably",
      },
      {
        title: "Hospital budget hearing",
        link: "https://vtdigger.org/budget",
        sourceName: "VTDigger",
        matchedTerms: ["hospital"],
        pubDate: new Date("2026-08-01T12:00:00Z"),
        summary: "Board reviews the budget.",
      },
    ],
    [],
    new Date("2026-08-02T00:00:00Z"),
  );

  const [scored, unscored] = summary.items;
  assert.equal(scored.sentiment, "positive");
  assert.equal(scored.sentimentReason, "Award coverage naming us favorably");
  assert.equal(unscored.sentiment, undefined);
  assert.equal(unscored.sentimentReason, undefined);
});

test("buildRss renders the sentiment line for scored items", () => {
  const rss = buildRss([
    {
      title: "Blue Cross VT wins award",
      link: "https://vermontbiz.com/news/award",
      guid: "https://vermontbiz.com/news/award",
      sourceName: "VermontBiz",
      matchedTerms: ["BCBSVT"],
      pubDate: new Date("2026-08-01T12:00:00Z"),
      summary: "BCBSVT named best health insurer.",
      sentiment: "positive",
      sentimentReason: "Award coverage naming us favorably",
    },
  ]);

  assert.match(rss, /<strong>Sentiment:<\/strong> positive/);
});

test("generateFeed preserves sentiment across an archive round-trip", async () => {
  // The audit JSON is the persistence layer, so a scored item must survive a
  // run with no network. If it does not, every run re-scores and burns quota.
  const workdir = await mkdtemp(path.join(tmpdir(), "vt-news-sentiment-"));
  const rssOutputPath = path.join(workdir, "feed.rss");
  const jsonOutputPath = path.join(workdir, "feed.json");
  const auditJsonOutputPath = path.join(workdir, "feed-audit.json");

  await writeFile(
    auditJsonOutputPath,
    JSON.stringify({
      generatedAt: "2026-08-01T12:00:00.000Z",
      items: [
        {
          title: "Blue Cross VT wins best health insurer",
          link: "https://vermontbiz.com/news/award",
          guid: "https://vermontbiz.com/news/award",
          sourceName: "Vermont Business Magazine",
          matchedTerms: ["BCBSVT"],
          pubDate: "2026-08-01T12:00:00.000Z",
          summary: "BCBSVT named best health insurance provider.",
          reason: "Names BCBSVT directly",
          relevant: true,
          sentiment: "positive",
          sentimentReason: "Award coverage naming us favorably",
        },
      ],
    }),
  );

  await generateFeed({
    sources: [],
    now: new Date("2026-08-02T16:30:00Z"),
    rssOutputPath,
    jsonOutputPath,
    auditJsonOutputPath,
  });

  const output = JSON.parse(await readFile(auditJsonOutputPath, "utf8"));
  assert.equal(output.items.length, 1);
  assert.equal(output.items[0].sentiment, "positive");
  assert.equal(
    output.items[0].sentimentReason,
    "Award coverage naming us favorably",
  );
});

test("itemOutletName recovers the publisher behind a Google News search", () => {
  // 84% of brand items arrive via a search feed whose name is the query, not
  // the outlet, so the link host is the only reliable source of the publisher.
  assert.equal(
    itemOutletName({
      sourceName: "Google News Search",
      link: "https://vtdigger.org/2026/08/01/story",
    }),
    "VTDigger",
  );

  // A named outlet feed is authoritative.
  assert.equal(
    itemOutletName({
      sourceName: "Some Local Paper",
      link: "https://example.com/story",
    }),
    "Some Local Paper",
  );

  // Unknown host behind a search feed falls back to the bare domain, which
  // still reads better than "Google News Search".
  assert.equal(
    itemOutletName({
      sourceName: "Google News Blue Cross Site Search",
      link: "https://www.example.org/story",
    }),
    "example.org",
  );

  assert.equal(itemOutletName({ trackerOutlet: "VT Digger" }), "VTDigger");
  assert.equal(
    itemOutletName({ trackerOutlet: "Vermon Business Magazine" }),
    "Vermont Business Magazine",
  );
  assert.equal(
    itemOutletName({ trackerOutlet: "The World" }),
    "The World",
  );
});

test("association pages are not scored for sentiment", () => {
  // bcbs.com carries national association pages that match only the generic
  // term "Blue Cross" — "Transplant Static List" and the like.
  assert.equal(
    shouldScoreSentiment({
      matchedTerms: ["Blue Cross"],
      link: "https://www.bcbs.com/transplant-static-list",
    }),
    false,
  );
  assert.equal(isAssociationItem({ link: "https://www.bcbs.com/news" }), true);
  assert.equal(
    isAssociationItem({ link: "https://vtdigger.org/story" }),
    false,
  );
});

test("employment platform pages are rejected without catching press coverage", () => {
  // Job postings name us without reporting on us.
  for (const link of [
    "https://www.linkedin.com/jobs/view/clinical-support-representative-at-blue-cross-and-blue-shield-of-vermont-4459024501",
    "https://www.snagajob.com/jobs/1290274288",
    "https://www.jobleads.com/us/job/clinical-case-manager--berlin--e2883d0c6297feb1d0087b5344a4489e8",
    "https://www.jobleads.com/us/job/customer-service-representative-federal-employment-program--berlin--e292b185acb2af2560d8b0e62528bb62a",
    "https://www.breakroom.cc/en-us/employers/blue-cross-blue-shield-of-vermont",
    "https://www.ziprecruiter.com/c/BlueCross-BlueShield-of-Vermont/Job/Customer-Service-Representative,-Federal-Employment-Program/-in-Montpelier,VT?jid=c52b6985a3bb5940",
  ]) {
    assert.equal(isJobListingItem({ link }), true, link);
    const rejected = applyDeterministicRelevance({
      title: "Blue Cross and Blue Shield of Vermont job",
      matchedTerms: ["BCBSVT"],
      category: CATEGORY_BRAND,
      link,
    });
    assert.equal(rejected.relevant, false, link);
    assert.equal(rejected.reason, "Employment platform page, not news coverage.");
    assert.equal(shouldScoreSentiment(rejected), false, link);
  }

  assert.equal(
    isJobListingItem({ link: "https://www.linkedin.com/company/bluecrossvt" }),
    false,
  );

  // A hand-curated entry remains authoritative, even on a platform URL.
  assert.equal(
    applyDeterministicRelevance({
      link: "https://www.linkedin.com/jobs/view/curated-example",
      matchedTerms: ["BCBSVT"],
      fromMediaTracker: true,
      relevant: false,
    }).relevant,
    true,
  );

  // A newsroom whose path contains a job word is still press.
  assert.equal(
    isJobListingItem({ link: "https://vtdigger.org/jobs-report" }),
    false,
  );
  assert.equal(
    shouldScoreSentiment({
      matchedTerms: ["BCBSVT"],
      link: "https://vtdigger.org/jobs-report",
    }),
    true,
  );

  const rejudgedJob = {
    title: "Clinical Support Representative",
    link: "https://www.linkedin.com/jobs/view/clinical-support-rep",
    matchedTerms: ["BCBSVT"],
    relevant: false,
    sentiment: "neutral",
  };
  parseSummaryResponse(
    JSON.stringify([
      {
        id: 1,
        summary: "Blue Cross VT is hiring a support representative.",
        reason: "Mentions Blue Cross VT.",
        relevant: true,
        sentiment: "positive",
      },
    ]),
    [rejudgedJob],
  );
  assert.equal(rejudgedJob.relevant, false);
  assert.equal(rejudgedJob.reason, "Employment platform page, not news coverage.");
  assert.equal(rejudgedJob.sentiment, undefined);
});

test("deterministic relevance rejects publisher placeholders and unverified search fallbacks", () => {
  const placeholder = applyDeterministicRelevance({
    title: "Page A18 - Times Argus",
    link: "https://www.timesargus.com/eedition_theworld/page-a18/page_d7e687e5-1125-5958-a7e0-5618e150e546.html",
    matchedTerms: ["Blue Cross"],
    category: CATEGORY_BRAND,
    matchSource: "searchFallback",
  });
  assert.equal(placeholder.relevant, false);
  assert.equal(
    placeholder.reason,
    "Publisher e-edition page placeholder, not an article.",
  );

  const curatedEditionPage = applyDeterministicRelevance({
    title: "National Walk@Lunch and Green Up Day",
    link: "https://www.timesargus.com/eedition_theworld/page-a3/page_123.html",
    matchedTerms: ["Walk@Lunch"],
    fromMediaTracker: true,
    relevant: false,
  });
  assert.equal(curatedEditionPage.relevant, true);

  const shopperWrapper = applyDeterministicRelevance({
    title: "Full online edition: The Shopper Edition 07-15-26",
    link: "https://vermontjournal.com/online-edition/full-online-edition-the-shopper-edition-07-15-26/",
    matchedTerms: ["Prescription drugs & pharmacy"],
    category: CATEGORY_TOPIC,
  });
  assert.equal(shopperWrapper.relevant, false);
  assert.equal(shopperWrapper.reason, "Publisher edition wrapper, not an article.");

  for (const item of [
    {
      title: "Join us for fun & relaxation at Vermont Distillers. Ragged Blue will perform.",
      link: "https://www.facebook.com/RaggedBlue/posts/1670528698407217/",
      sourceName: "Google News Blue Cross Site Search",
    },
    {
      title: "Fall Into Winter - The Vermont Journal & The Shopper -",
      link: "https://vermontjournal.com/event/fall-into-winter/",
      sourceName: "Google News Blue Cross Boolean Search A",
    },
  ]) {
    const rejected = applyDeterministicRelevance({
      ...item,
      matchedTerms: ["Blue Cross"],
      category: CATEGORY_BRAND,
      matchSource: "searchFallback",
    });
    assert.equal(rejected.relevant, false, item.link);
    assert.equal(
      rejected.reason,
      "Search result has no verifiable Blue Cross mention.",
    );
  }

  const rejudgedFallback = {
    title: "Fall Into Winter - The Vermont Journal & The Shopper -",
    link: "https://vermontjournal.com/event/fall-into-winter/",
    sourceName: "Google News Blue Cross Boolean Search A",
    matchedTerms: ["Blue Cross"],
    category: CATEGORY_BRAND,
    matchSource: "searchFallback",
    relevant: false,
  };
  parseSummaryResponse(
    JSON.stringify([
      {
        id: 1,
        summary: "The event page mentions Blue Cross VT.",
        reason: "Mentions Blue Cross VT.",
        relevant: true,
      },
    ]),
    [rejudgedFallback],
  );
  assert.equal(rejudgedFallback.relevant, false);
  assert.equal(
    rejudgedFallback.reason,
    "Search result has no verifiable Blue Cross mention.",
  );

  assert.equal(
    applyDeterministicRelevance({
      title: "Blue Cross VT hosts Kayak Days",
      link: "https://www.wcax.com/2026/08/15/kayak-days/",
      matchedTerms: ["Blue Cross"],
      category: CATEGORY_BRAND,
      matchSource: "searchFallback",
    }).relevant,
    undefined,
  );
});

test("deterministic relevance rejects exact non-article search result shapes", () => {
  const targets = [
    [
      "Transplant Static List - Blue Cross Blue Shield",
      "https://www.bcbs.com/media/pdf/Blue-Distinction-Transplants-Providers.pdf",
      "Association provider directory, not news coverage.",
    ],
    [
      "BCBS News - Association News & Press Releases",
      "https://www.bcbs.com/about-us/association-news?_rsc=abc&page=4",
      "Association news index, not an article.",
    ],
    [
      "How to Find Insurance Policy Number on Insurance Card",
      "https://www.tiktok.com/discover/how-to-find-insurance-policy-number-on-insurance-card",
      "Social search page, not news coverage.",
    ],
    [
      "Member Tools and Resources",
      "https://www.bluecrossvt.org/members/member-tools-and-resources",
      "Member resource page, not a news or blog post.",
    ],
  ];

  for (const [title, link, reason] of targets) {
    const rejected = applyDeterministicRelevance({
      title,
      link,
      matchedTerms: ["Blue Cross"],
      category: CATEGORY_BRAND,
    });
    assert.equal(rejected.relevant, false, link);
    assert.equal(rejected.reason, reason, link);
    assert.equal(
      applyDeterministicRelevance({
        title,
        link,
        matchedTerms: ["Blue Cross"],
        category: CATEGORY_BRAND,
        fromMediaTracker: true,
        relevant: false,
      }).relevant,
      true,
      `curated target should survive: ${link}`,
    );
  }

  for (const link of [
    "https://www.bcbs.com/media/pdf/health-policy-report.pdf",
    "https://www.bcbs.com/about-us/association-news/blue-cross-statement",
    "https://www.tiktok.com/@reporter/video/123",
    "https://www.bluecrossvt.org/health-community/news/community-update",
  ]) {
    assert.notEqual(
      applyDeterministicRelevance({
        title: "Blue Cross coverage update",
        link,
        matchedTerms: ["Blue Cross"],
        category: CATEGORY_BRAND,
      }).relevant,
      false,
      link,
    );
  }
});

test("buildSummaryPrompt carries the tracker's worked examples", () => {
  const prompt = buildSummaryPrompt([
    {
      title: "Blue Cross VT files 2027 rates",
      sourceName: "WCAX",
      matchedTerms: ["BCBSVT"],
      link: "https://www.wcax.com/2026/08/01/rates",
      snippet: "Filing details.",
    },
  ]);

  // Calibration is carried by examples, not by prose alone: a model working
  // from the rules only scored routine favourable coverage as neutral.
  assert.match(prompt, /2026 Best of Business in Vermont recipients announced/);
  assert.match(prompt, /SENTIMENT: positive/);
  assert.match(prompt, /SENTIMENT: neutral to negative/);
  assert.match(prompt, /SENTIMENT: negative/);
  assert.match(prompt, /Ordinary favourable presence IS positive/);
  assert.match(prompt, /Do not hedge toward neutral when the excerpt is thin/);

  // Every point on the scale must be represented, or the anchor is lopsided.
  for (const value of SENTIMENT_VALUES) {
    assert.ok(
      prompt.includes(`SENTIMENT: ${value}`),
      `no worked example for "${value}"`,
    );
  }
});

test("payer trade press is sourced through site-scoped searches", () => {
  // All three block direct crawling, so they are reached via Google News.
  // Scoped to Vermont: an unscoped site: search returns the national Blues
  // firehose, which is not coverage of us.
  const expected = [
    ["Becker's Payer Issues", "beckerspayer.com"],
    ["Modern Healthcare", "modernhealthcare.com"],
    ["Health Payer Specialist", "healthpayerspecialist.com"],
  ];

  for (const [name, host] of expected) {
    const source = DEFAULT_SOURCES.find((entry) => entry.name === name);
    assert.ok(source, `missing source: ${name}`);
    const query = decodeURIComponent(source.feedUrl).replaceAll("+", " ");
    assert.ok(query.includes(`site:${host}`), `${name}: ${query}`);
    assert.equal(source.isSearchFeed, true, name);
    assert.equal(source.scanArticle, false, name);
    // A `when:` bound made Google News fall back to unrelated results, so the
    // date window is enforced locally instead.
    assert.ok(!/when:/.test(query), `${name} must not carry a when: bound`);
    assert.ok(source.maxItemAgeDays > 0, `${name} needs a local date window`);
    // The broad-national gate is the second guard against other-Blues noise.
    assert.ok(
      BROAD_NATIONAL_SOURCE_NAMES.has(name),
      `${name} must be gated as broad national`,
    );
  }
});

test("a bare Blue Cross match must be corroborated by Vermont", () => {
  // The brand matcher accepts a plain "Blue Cross", which is right for
  // surfacing a story but too loose to score: it had scored a BCBS
  // Massachusetts story and a generic "new Blue Cross CEO" piece.
  const massachusetts = {
    matchedTerms: ["Blue Cross"],
    title: "Blue Cross, Cooley Dickinson assure Medicare Advantage patients",
    sourceName: "Google News Search",
    link: "https://www.gazettenet.com/blue-cross-cooley-dickinson",
  };
  assert.equal(namesBlueCrossVermont(massachusetts), false);
  assert.equal(shouldScoreSentiment(massachusetts), false);

  // A Vermont outlet on a bare match is ours.
  const sevenDays = {
    matchedTerms: ["Blue Cross"],
    title: "In Ad Campaign, Blue Cross Asks Patients to Shop Around",
    sourceName: "Google News Search",
    link: "https://www.sevendaysvt.com/news/ad-campaign",
  };
  assert.equal(namesBlueCrossVermont(sevenDays), true);
  assert.equal(shouldScoreSentiment(sevenDays), true);

  // So is a bare match with Vermont in the text.
  assert.equal(
    namesBlueCrossVermont({
      matchedTerms: ["Blue Cross"],
      title: "Blue Cross, MVP block Vermont advocate from testifying",
      link: "https://example.com/story",
    }),
    true,
  );

  // A Vermont-specific brand term never needs corroboration.
  assert.equal(
    namesBlueCrossVermont({
      matchedTerms: ["BCBSVT"],
      title: "Untitled",
      link: "https://example.com/story",
    }),
    true,
  );
});

test("social video is not press and is not scored", () => {
  // itemSourceType only knows Facebook, so these arrive labelled "News".
  const tiktok = {
    matchedTerms: ["Blue Cross"],
    title: "How to Find Insurance Policy Number on Insurance Card",
    link: "https://www.tiktok.com/@user/video/123",
  };
  assert.equal(isSocialVideoItem(tiktok), true);
  assert.equal(shouldScoreSentiment(tiktok), false);

  assert.equal(
    isSocialVideoItem({ link: "https://vtdigger.org/story" }),
    false,
  );
});

test("a stale score is dropped at the publishing boundary", () => {
  // An item that loses eligibility already has a summary, so it never
  // re-enters the Gemini batch where the score would be cleared. Publishing
  // has to be the gate, or the stale score persists in the archive forever.
  const summary = buildJsonSummary(
    [
      {
        title: "Blue Cross, Cooley Dickinson assure Medicare Advantage patients",
        link: "https://www.gazettenet.com/blue-cross-cooley-dickinson",
        sourceName: "Google News Search",
        matchedTerms: ["Blue Cross"],
        pubDate: new Date("2026-08-01T12:00:00Z"),
        summary: "A Massachusetts story.",
        sentiment: "positive",
        sentimentReason: "stale score from a looser rule",
      },
    ],
    [],
    new Date("2026-08-02T00:00:00Z"),
  );

  const [item] = summary.items;
  assert.equal(item.sentiment, undefined);
  assert.equal(item.sentimentReason, undefined);
  assert.equal(item.sentimentEligible, undefined);

  const rss = buildRss([
    {
      title: "Blue Cross, Cooley Dickinson assure Medicare Advantage patients",
      link: "https://www.gazettenet.com/blue-cross-cooley-dickinson",
      guid: "https://www.gazettenet.com/blue-cross-cooley-dickinson",
      sourceName: "Google News Search",
      matchedTerms: ["Blue Cross"],
      pubDate: new Date("2026-08-01T12:00:00Z"),
      summary: "A Massachusetts story.",
      sentiment: "positive",
      sentimentReason: "stale score from a looser rule",
    },
  ]);
  assert.doesNotMatch(rss, /<strong>Sentiment:<\/strong>/);
});

test("dedupe keeps successive roundup editions apart", () => {
  // Stripping any trailing "- ..." to remove an outlet suffix also removed the
  // date from "Health Briefs - Jan 22, 2026", so every briefs edition
  // collapsed into one and each roundup after the first was discarded. That is
  // exactly where a sponsorship or event mention tends to live.
  const editions = [
    {
      title: "Health Briefs - Jan 22, 2026",
      link: "https://www.timesargus.com/health-briefs-jan-22",
      matchedTerms: ["Blue Cross VT"],
      pubDate: new Date("2026-01-22T12:00:00Z"),
    },
    {
      title: "Health Briefs - May 28, 2026",
      link: "https://www.timesargus.com/health-briefs-may-28",
      matchedTerms: ["Blue Cross VT"],
      pubDate: new Date("2026-05-28T12:00:00Z"),
    },
    {
      title: "Business Briefs - Saturday, May 2",
      link: "https://www.timesargus.com/business-briefs-may-2",
      matchedTerms: ["Blue Cross VT"],
      pubDate: new Date("2026-05-02T12:00:00Z"),
    },
  ];
  assert.equal(dedupeResolvedItems(editions).length, 3);

  // The outlet suffix is still stripped when it carries no date, so the same
  // story from one outlet does not appear twice.
  const sameStory = [
    {
      title: "Blue Cross VT files 2027 rates - Times Argus",
      link: "https://www.timesargus.com/rates-a",
      matchedTerms: ["Blue Cross VT"],
      pubDate: new Date("2026-08-01T12:00:00Z"),
    },
    {
      title: "Blue Cross VT files 2027 rates",
      link: "https://www.timesargus.com/rates-b",
      matchedTerms: ["Blue Cross VT"],
      pubDate: new Date("2026-08-01T12:00:00Z"),
    },
  ];
  assert.equal(dedupeResolvedItems(sameStory).length, 1);
});

test("dedupe preserves semantic subtitles on direct-publisher stories", () => {
  const stories = [
    {
      sourceName: "Times Argus",
      title: "Hospital policy changes - What patients need to know",
      link: "https://www.timesargus.com/patients",
    },
    {
      sourceName: "Times Argus",
      title: "Hospital policy changes - What employers need to know",
      link: "https://www.timesargus.com/employers",
    },
  ];

  assert.equal(dedupeResolvedItems(stories).length, 2);
});

test("the media tracker seed parses into feed items", () => {
  const source = DEFAULT_SOURCES.find(
    (entry) => entry.name === "Media Tracker Backfill",
  );
  assert.ok(source, "the backfill source must be registered");
  assert.equal(source.scanArticle, false);
  assert.equal(source.seedItemsPath, "data/media-tracker-seed.json");

  const items = parseMediaTrackerSeedItems(
    JSON.stringify({
      articles: [
        {
          url: "https://vtdigger.org/2026/03/01/story",
          title: "Vermont hospitals face budget pressure",
          outlet: "VT Digger",
          pubDate: "2026-03-01T12:00:00.000Z",
          topic: "BCBSVT contract negotiations",
        },
        { url: "not-a-url", title: "dropped" },
      ],
    }),
    source,
  );

  assert.equal(items.length, 1);
  const [item] = items;
  assert.equal(item.fromMediaTracker, true);
  assert.equal(item.trackerOutlet, "VT Digger");
  // The topic column carries the brand evidence a headline often lacks.
  assert.match(item.feedContent, /BCBSVT contract negotiations/);
  assert.equal(item.pubDate.toISOString(), "2026-03-01T12:00:00.000Z");
});

test("a curated entry survives without a term match and outranks retention", () => {
  // Roughly 40% of the tracker names us only in the article body, which the
  // seed cannot see, so a term match cannot be the gate. And most of the list
  // predates the three-month retention window.
  const curated = {
    title: "Rising health care costs strain Vermont families",
    link: "https://vtdigger.org/2025/12/10/costs",
    guid: "https://vtdigger.org/2025/12/10/costs",
    matchedTerms: ["Blue Cross VT"],
    category: CATEGORY_BRAND,
    matchSource: "mediaTracker",
    fromMediaTracker: true,
    pubDate: new Date("2025-12-10T12:00:00Z"),
  };

  const merged = mergeWithArchive([curated], [], new Date("2026-08-27T12:00:00Z"));
  assert.equal(merged.length, 1, "a curated item must outlive the retention window");
  assert.equal(itemOutletName({ ...curated, trackerOutlet: "VT Digger" }), "VTDigger");
  // Provenance stands in for the Vermont corroboration a bare match needs.
  assert.equal(namesBlueCrossVermont({ fromMediaTracker: true }), true);
});

test("a curated clip is never vetoed or deduped away", () => {
  // The summarizer sees only a headline and a topic note, so its relevance
  // veto is worse-informed than the person who logged the clip.
  const batch = [
    {
      title: "Payers pitch 2027 ACA rates: 7 updates",
      sourceName: "Media Tracker Backfill",
      matchedTerms: ["Blue Cross VT"],
      link: "https://www.beckerspayer.com/payer/payers-pitch-2027-aca-rates",
      fromMediaTracker: true,
    },
  ];
  parseSummaryResponse(
    JSON.stringify([
      { id: 1, summary: "National rate filings.", reason: "n/a", relevant: false },
    ]),
    batch,
  );
  assert.equal(batch[0].relevant, true);

  // And it outranks a crawler copy when titles collide.
  const curated = {
    title: "Blue Cross VT files 2027 rates",
    link: "https://www.timesargus.com/tracker-url",
    matchedTerms: ["Blue Cross VT"],
    fromMediaTracker: true,
    pubDate: new Date("2026-08-01T12:00:00Z"),
  };
  const crawled = {
    title: "Blue Cross VT files 2027 rates",
    link: "https://news.google.com/rss/articles/abc",
    sourceName: "Google News Search",
    matchedTerms: ["Blue Cross VT"],
    pubDate: new Date("2026-08-01T12:00:00Z"),
  };
  const deduped = dedupeResolvedItems([crawled, curated]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].link, curated.link, "the curated URL must survive");
});

test("a negative article cache never drops a curated clip", async () => {
  // An earlier crawl can fetch a URL, find nothing worth keeping, and cache
  // that verdict. Three tracker entries were dropped there, before the
  // always-include path could run, because the crawler had already seen the
  // same URLs. A hand-logged clip outranks that cached verdict.
  const articleCache = {
    "https://www.beckerspayer.com/payer/7-blue-cross-blue-shield-updates/": {
      url: "https://www.beckerspayer.com/payer/7-blue-cross-blue-shield-updates/",
      resolvedUrl: "https://www.beckerspayer.com/payer/7-blue-cross-blue-shield-updates/",
      matchedTerms: [],
      snippet: "",
      comments: [],
      articleError: "",
      matchSource: "",
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      articleHeaders: {},
    },
  };

  const curated = {
    sourceName: "Media Tracker Backfill",
    link: "https://www.beckerspayer.com/payer/7-blue-cross-blue-shield-updates/",
    title: "7 Blue Cross Blue Shield updates",
    description: "2025 financials",
    feedContent: "7 Blue Cross Blue Shield updates 2025 financials",
    scanArticle: false,
    articleScanMode: "off",
    fromMediaTracker: true,
    pubDate: new Date("2026-07-01T12:00:00Z"),
  };

  let fetchCount = 0;
  const kept = await enrichAndFilterItems([curated], new Map(), {
    articleCache,
    now: new Date(),
    fetchText: async () => {
      fetchCount += 1;
      throw new Error("a fresh cache entry must prevent an article fetch");
    },
  });

  assert.equal(kept.length, 1, "the curated clip must survive a negative cache");
  assert.deepEqual(kept[0].matchedTerms, ["Blue Cross VT"]);
  assert.equal(kept[0].category, CATEGORY_BRAND);
  assert.equal(kept[0].matchSource, "mediaTracker");
  assert.equal(fetchCount, 0);
});

test("newer resolved cache evidence outranks an older Google wrapper alias", async () => {
  const wrapper = "https://news.google.com/rss/articles/cached-alias";
  const resolved = "https://www.beckerspayer.com/payer/cached-story/";
  const now = new Date("2026-08-27T19:00:00Z");
  const articleCache = {
    [wrapper]: {
      url: wrapper,
      resolvedUrl: resolved,
      matchedTerms: [],
      checkedAt: "2026-08-27T16:42:42.373Z",
      expiresAt: "2026-09-10T16:42:42.373Z",
      articleHeaders: {},
    },
    [resolved]: {
      url: resolved,
      resolvedUrl: resolved,
      matchedTerms: ["Blue Cross VT"],
      matchSource: "mediaTracker",
      checkedAt: "2026-08-27T18:41:19.446Z",
      expiresAt: "2026-09-10T18:41:19.446Z",
      articleHeaders: {},
    },
  };

  const kept = await enrichAndFilterItems(
    [{
      sourceName: "Google News Search",
      title: "A cached Blue Cross story",
      link: wrapper,
      feedContent: "",
      scanArticle: false,
    }],
    new Map(),
    {
      articleCache,
      now,
      decodeGoogleNewsUrl: async () => ({
        status: true,
        decoded_url: resolved,
      }),
      fetchText: async () => {
        throw new Error("a fresh cache entry must prevent an article fetch");
      },
    },
  );

  assert.equal(kept.length, 1);
  assert.equal(kept[0].link, resolved);
  assert.deepEqual(kept[0].matchedTerms, ["Blue Cross VT"]);
  assert.equal(kept[0].matchSource, "mediaTracker");
});

test("a matched cache entry without terms keeps curated classification", async () => {
  const link = "https://example.com/curated-clip";
  const kept = await enrichAndFilterItems(
    [
      {
        sourceName: "Media Tracker Backfill",
        link,
        title: "A hand-logged clip",
        feedContent: "",
        scanArticle: false,
        fromMediaTracker: true,
        pubDate: new Date("2026-07-01T12:00:00Z"),
      },
    ],
    new Map([
      [link, { matchedTerms: [], previewChecked: true, matchSource: "" }],
    ]),
  );

  assert.equal(kept.length, 1);
  assert.deepEqual(kept[0].matchedTerms, ["Blue Cross VT"]);
  assert.equal(kept[0].category, CATEGORY_BRAND);
  assert.equal(kept[0].matchSource, "mediaTracker");
});

test("standing context reaches the prompt only for the stories it applies to", () => {
  // The residual gap after calibration was context, not rubric: the tracker
  // reads coverage of proposing VT Basic as adverse and coverage of
  // withdrawing it as favourable, which inverts the headlines.
  const onStoryline = {
    title: "BlueCross BlueShield of VT pulls its proposed lower-cost plan",
    sourceName: "VTDigger",
    matchedTerms: ["BCBSVT"],
    link: "https://vtdigger.org/2026/07/01/pulls-plan",
  };
  const unrelated = {
    title: "Hospital budget hearing opens",
    sourceName: "VTDigger",
    matchedTerms: ["Hospitals"],
    link: "https://vtdigger.org/2026/07/01/budget",
  };

  assert.deepEqual(
    matchStorylines(onStoryline).map((entry) => entry.name),
    ["VT Basic lower-cost plan"],
  );
  assert.deepEqual(matchStorylines(unrelated), []);

  const prompt = buildSummaryPrompt([onStoryline, unrelated]);
  assert.match(prompt, /STORYLINE: VT Basic lower-cost plan/);
  assert.match(prompt, /Standing context from the communications team/);

  // A batch that touches no storyline must not carry the section at all.
  const quiet = buildSummaryPrompt([unrelated]);
  assert.ok(
    !/Standing context from the communications team/.test(quiet),
    "unrelated batches must not carry storyline notes",
  );
});

test("a malformed context file never stops a run", () => {
  // The file belongs to the team, so a typo in it must degrade to "no
  // storylines" rather than break the hourly generation.
  assert.deepEqual(matchStorylines({ title: "anything" }, []), []);
  assert.deepEqual(
    matchStorylines(
      { title: "vt basic story" },
      [{ name: "", note: "", match: [] }],
    ),
    [],
  );
});

test("a re-score sweeps oldest-first so it can reach the whole archive", () => {
  // Items arrive newest first. A re-score that took the head would redo the
  // same newest N every run and never reach older items, which is how a set
  // of June clips sat on stale scores through repeated re-scores.
  const pending = [
    { title: "newest" },
    { title: "middle" },
    { title: "oldest" },
  ];

  assert.deepEqual(
    orderItemsForRun(pending, true).map((i) => i.title),
    ["oldest", "middle", "newest"],
  );
  assert.deepEqual(
    orderItemsForRun(pending, false).map((i) => i.title),
    ["newest", "middle", "oldest"],
  );
  // Ordering must not mutate the caller's array.
  assert.equal(pending[0].title, "newest");
});

test("pending selection picks up coverage that still needs a score", () => {
  const brand = {
    matchedTerms: ["BCBSVT"],
    link: "https://vtdigger.org/story",
    summary: "Already summarized.",
    relevant: true,
  };
  const scored = { ...brand, sentiment: "positive" };
  const topic = {
    matchedTerms: ["Hospitals"],
    link: "https://vtdigger.org/other",
    summary: "Already summarized.",
    relevant: true,
  };
  const rejected = { ...brand, relevant: false };

  // Brand coverage with a summary but no score still needs a pass.
  assert.deepEqual(selectPendingSummaryItems([brand, topic, scored]), [brand]);
  // A re-score takes every eligible item, scored or not.
  assert.deepEqual(
    selectPendingSummaryItems([brand, topic, scored], { rescoreSentiment: true }),
    [brand, scored],
  );
  // A sentiment-only re-score does not revisit rejected items.
  assert.deepEqual(
    selectPendingSummaryItems([rejected], { rescoreSentiment: true }),
    [],
  );
  // A relevance re-judge must revisit rejected items, since its purpose is
  // to apply a changed relevance rubric to every archived verdict.
  assert.deepEqual(
    selectPendingSummaryItems([rejected], { rejudgeAll: true }),
    [rejected],
  );
});

test("paired Vermont brand patterns do not cross sentence boundaries", () => {
  const falsePositives = [
    "BCBS Massachusetts announced a change. Vermont lawmakers met Tuesday.",
    "Vermont regulators opened a hearing. BCBS Michigan filed comments.",
    "BlueCross North Carolina expanded coverage. Vermont hospitals responded.",
    "BCBS Massachusetts reported losses while Vermont lawmakers debated hospital budgets.",
    "Vermont regulators approved rates while BCBS Michigan named a new CEO.",
    "Blue Cross and Blue Shield of Massachusetts exits Medicare Advantage in Vermont.",
  ];

  for (const text of falsePositives) {
    const matches = findMentionTerms(text);
    assert.ok(
      !matches.some((term) =>
        [
          "BCBS Vermont",
          "BlueCross Vermont",
          "Blue Cross and Blue Shield of Vermont",
        ].includes(term),
      ),
      `${text}: ${matches.join(", ")}`,
    );
  }

  const longValidPair =
    "BCBS announced that after months of actuarial review and discussions with regulators it would continue offering coverage to families throughout Vermont.";
  assert.ok(findMentionTerms(longValidPair).includes("BCBSVT"));

  const comparativeCoverage = [
    "BCBS Massachusetts and Vermont plans filed their 2027 premium requests.",
    "BCBS Michigan acquired a controlling interest in the Vermont plan.",
    "Blue Cross and Blue Shield of Michigan and Vermont announced shared leadership.",
  ];
  for (const text of comparativeCoverage) {
    assert.ok(findMentionTerms(text).length > 0, text);
  }

  const verbFalsePositives = [
    "BCBS Massachusetts announced layoffs as Vermont plans a regulatory hearing.",
    "BCBS Michigan changed rates while Vermont plans an affordability study.",
    "Blue Cross and Blue Shield of Massachusetts exits as Vermont plans reforms.",
  ];
  for (const text of verbFalsePositives) {
    assert.deepEqual(findMentionTerms(text), [], text);
  }
});

test("a Google News source label is not Vermont brand evidence", () => {
  const item = {
    matchedTerms: ["Blue Cross"],
    sourceName: "Google News Vermont Health Search",
    title: "Blue Cross Massachusetts changes its pharmacy network",
    link: "https://www.modernhealthcare.com/insurance/pharmacy-network",
  };

  assert.equal(namesBlueCrossVermont(item), false);
  assert.equal(shouldScoreSentiment(item), false);
  assert.equal(
    namesBlueCrossVermont({
      matchedTerms: ["Blue Cross"],
      title:
        "Blue Cross and Blue Shield of Massachusetts exits Medicare Advantage in Vermont",
      link: "https://example.com/massachusetts-plan",
    }),
    false,
  );
  assert.equal(
    namesBlueCrossVermont({
      matchedTerms: ["Blue Cross"],
      title: "BCBS Michigan acquired a controlling interest in the Vermont plan",
      link: "https://example.com/vermont-plan-ownership",
    }),
    true,
  );
});

test("mobile Facebook links retain social publishing rules", () => {
  const summary = buildJsonSummary(
    [
      {
        sourceName: "Community Post",
        title: "Blue Cross VT community update",
        link: "https://m.facebook.com/story.php?story_fbid=1&id=2",
        pubDate: new Date("2026-08-27T12:00:00Z"),
        matchedTerms: ["BCBSVT"],
        sentiment: "positive",
        sentimentReason: "Stale press score",
      },
    ],
    [],
    new Date("2026-08-27T13:00:00Z"),
  );

  assert.equal(summary.items[0].sourceType, "Social");
  assert.equal(summary.items[0].access, "May require login");
  assert.equal(summary.items[0].sentiment, undefined);
});

test("resolved Google News stories remain distinct across publishers", () => {
  const items = [
    {
      sourceName: "Google News Vermont Health Search",
      title: "Payers prepare for the next enrollment period - Modern Healthcare",
      link: "https://www.modernhealthcare.com/insurance/enrollment-period",
    },
    {
      sourceName: "Google News Vermont Health Search",
      title: "Payers prepare for the next enrollment period - Becker's Payer Issues",
      link: "https://www.beckerspayer.com/payer/enrollment-period/",
    },
  ];

  assert.equal(dedupeResolvedItems(items).length, 2);

  const unresolved = [
    {
      sourceName: "Google News Vermont Health Search A",
      title: "Shared health policy headline - VTDigger",
      link: "https://news.google.com/rss/articles/vtdigger-copy",
    },
    {
      sourceName: "Google News Vermont Health Search B",
      title: "Shared health policy headline - WCAX",
      link: "https://news.google.com/rss/articles/wcax-copy",
    },
  ];
  assert.equal(dedupeResolvedItems(unresolved).length, 2);

  const withResolvedCopy = [
    ...unresolved,
    {
      sourceName: "VTDigger",
      title: "Shared health policy headline",
      link: "https://vtdigger.org/2026/08/27/shared-health-policy-headline",
    },
  ];
  const deduped = dedupeResolvedItems(withResolvedCopy);
  assert.deepEqual(
    deduped.map((item) => item.link),
    [
      "https://vtdigger.org/2026/08/27/shared-health-policy-headline",
      "https://news.google.com/rss/articles/wcax-copy",
    ],
  );
});

test("same-link merges preserve media-tracker provenance", () => {
  const link = "https://vtdigger.org/2026/08/27/rates";
  const archived = {
    title: "Blue Cross VT rate filing",
    link,
    pubDate: new Date("2026-08-27T10:00:00Z"),
    matchedTerms: ["Blue Cross VT"],
    fromMediaTracker: true,
    trackerOutlet: "VTDigger",
    matchSource: "mediaTracker",
  };
  const current = {
    title: "Blue Cross VT rate filing, updated",
    link,
    pubDate: new Date("2026-08-27T12:00:00Z"),
    matchedTerms: ["Premiums & rate review"],
    matchSource: "text",
  };

  const [merged] = mergeWithArchive(
    [current],
    [archived],
    new Date("2026-08-27T13:00:00Z"),
  );
  assert.equal(merged.title, current.title);
  assert.equal(merged.fromMediaTracker, true);
  assert.equal(merged.trackerOutlet, "VTDigger");
  assert.equal(merged.matchSource, "mediaTracker");
  assert.deepEqual(merged.matchedTerms, [
    "Blue Cross VT",
    "Premiums & rate review",
  ]);
});

test("a fresh tracking variant replaces a stale rejected archive record", () => {
  const archived = {
    sourceName: "Old feed label",
    title: "Outdated unrelated headline",
    link: "https://example.com/rates?utm_source=rss",
    pubDate: new Date("2026-08-26T10:00:00Z"),
    firstSeenAt: new Date("2026-08-26T11:00:00Z"),
    matchedTerms: ["Health insurance"],
    relevant: false,
    reason: "Low-priority health mention outside Vermont or New England.",
  };
  const current = {
    sourceName: "Example Vermont News",
    title: "Blue Cross VT files updated 2027 rates",
    link: "https://example.com/rates",
    pubDate: new Date("2026-08-27T10:00:00Z"),
    matchedTerms: ["Blue Cross VT", "Premiums & rate review"],
    snippet: "The Vermont filing updates proposed individual market rates.",
  };

  const merged = mergeWithArchive(
    [current],
    [archived],
    new Date("2026-08-27T12:00:00Z"),
  )
    .sort((left, right) => right.pubDate.valueOf() - left.pubDate.valueOf());
  const [item] = dedupeResolvedItems(merged).map(applyDeterministicRelevance);
  assert.equal(merged.length, 1);
  assert.equal(item.link, current.link);
  assert.equal(item.title, current.title);
  assert.notEqual(item.relevant, false);
  assert.equal(item.reason, undefined);
  assert.equal(
    item.firstSeenAt.toISOString(),
    archived.firstSeenAt.toISOString(),
  );
});

test("both enrichment caches apply contextual category rules", async () => {
  const now = new Date("2026-08-27T12:00:00Z");
  const link = "https://example.com/insurance/new-blue-cross-ceo";
  const sourceItem = {
    sourceName: "Modern Healthcare",
    title: "A Blue Cross plan names a new CEO",
    link,
    feedContent: "A Blue Cross plan names a new CEO.",
    scanArticle: false,
  };
  const matchedCache = new Map([
    [
      link,
      {
        matchedTerms: ["Blue Cross"],
        snippet: "A national Blues plan changed leadership.",
      },
    ],
  ]);
  const articleCache = {
    [link]: {
      url: link,
      resolvedUrl: link,
      checkedAt: now.toISOString(),
      expiresAt: new Date(now.valueOf() + 86_400_000).toISOString(),
      matchedTerms: ["Blue Cross"],
      snippet: "A national Blues plan changed leadership.",
      comments: [],
      articleHeaders: {},
    },
  };

  const [fromMatchedCache] = await enrichAndFilterItems(
    [sourceItem],
    matchedCache,
    { now },
  );
  const [fromArticleCache] = await enrichAndFilterItems(
    [sourceItem],
    new Map(),
    { articleCache, now },
  );

  for (const item of [fromMatchedCache, fromArticleCache]) {
    assert.equal(item.category, CATEGORY_TOPIC);
    assert.equal(applyDeterministicRelevance(item).relevant, false);
  }
});

test("publish workflow preserves durable state and classifies runtime inputs", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/publish-feed.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /fetch-depth: 0/);
  assert.doesNotMatch(workflow, /git diff --name-only HEAD\^ HEAD/);
  assert.match(
    workflow,
    /Could not compare the complete push range; using a full generation[\s\S]*echo "full=true"/,
  );
  assert.match(workflow, /\^\(src\/\|test\/\|data\/\|certs\//);
  assert.match(workflow, /\.audit == true/);
  assert.match(workflow, /\.crawlState \| type == "object"/);
  assert.doesNotMatch(workflow, /seed "\$SITE_URL\/feed\.json"/);
  assert.match(
    workflow,
    /SLACK_WEBHOOK_URL: \$\{\{ secrets\.SLACK_WEBHOOK_URL \}\}/,
  );
  assert.match(
    workflow,
    /DISCORD_WEBHOOK_URL: \$\{\{ secrets\.DISCORD_WEBHOOK_URL \}\}/,
  );
  assert.match(workflow, /name: Install dependencies\n\s+run: npm ci/);
  assert.match(workflow, /name: Run tests\n\s+run: npm test/);
  assert.doesNotMatch(
    workflow,
    /name: (?:Set up Node|Install dependencies|Run tests)\n\s+if:/,
  );
  assert.ok(
    (workflow.match(/curl [^\n]*--compressed/g) || []).length >= 2,
    "state seed and reuse requests must accept compressed JSON",
  );
});

test("reader and trends inline JavaScript compiles", async () => {
  for (const file of ["../site/index.html", "../site/trends.html"]) {
    const html = await readFile(new URL(file, import.meta.url), "utf8");
    const scripts = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)]
      .filter((match) => !/type=["']application\/(?:ld\+)?json["']/i.test(match[0]));

    assert.ok(scripts.length > 0, `${file} should contain executable JavaScript`);
    for (const [index, script] of scripts.entries()) {
      assert.doesNotThrow(
        () => new vm.Script(script[1], { filename: `${file}#script-${index + 1}` }),
      );
    }
  }
});

test("trends charts trim stale coverage and anchor sentiment tooltips", async () => {
  const trends = await readFile(
    new URL("../site/trends.html", import.meta.url),
    "utf8",
  );

  assert.match(trends, /function currentCoverageStart\(keys\)/);
  assert.match(
    trends,
    /function renderVolumeChart\(items\)[\s\S]*const startKey = currentCoverageStart\(keys\)/,
  );
  assert.match(trends, /const segmentTop = cursor/);
  assert.match(trends, /pad\.top \+ segmentTop \+ segHeight \/ 2/);
  assert.doesNotMatch(trends, /pad\.top \+ cursor \+ segHeight \/ 2/);
});

test("backfillWindowFromEnv requires both bounds in order", () => {
  assert.equal(backfillWindowFromEnv({}), null);
  assert.equal(backfillWindowFromEnv({ BACKFILL_AFTER: "2026-09-05" }), null);
  assert.equal(backfillWindowFromEnv({ BACKFILL_BEFORE: "2026-09-14" }), null);
  assert.equal(
    backfillWindowFromEnv({ BACKFILL_AFTER: "2026-09-14", BACKFILL_BEFORE: "2026-09-05" }),
    null,
  );
  assert.equal(backfillWindowFromEnv({ BACKFILL_AFTER: "nonsense", BACKFILL_BEFORE: "2026-09-14" }), null);
  assert.deepEqual(
    backfillWindowFromEnv({ BACKFILL_AFTER: "2026-09-05", BACKFILL_BEFORE: "2026-09-14" }),
    { after: "2026-09-05", before: "2026-09-14" },
  );
});

test("applyBackfillWindow swaps the rolling window for explicit bounds", () => {
  const sources = [
    {
      name: "Local outlet search",
      isSearchFeed: true,
      maxItemAgeDays: 30,
      feedUrl:
        "https://news.google.com/rss/search?q=site%3Aexample.com+%28hospital%29+when%3A30d&hl=en-US",
    },
  ];
  const [out] = applyBackfillWindow(sources, {
    after: "2026-09-05",
    before: "2026-09-14",
  });
  const q = new URL(out.feedUrl).searchParams.get("q");
  assert.match(q, /after:2026-09-05 before:2026-09-14/);
  assert.doesNotMatch(q, /when:\d+d/);
  // Site scoping and terms survive the rewrite.
  assert.match(q, /site:example\.com/);
  assert.match(q, /hospital/);
  // The rolling minimum is cleared so it cannot discard the whole window.
  assert.equal(out.maxItemAgeDays, undefined);
  assert.equal(out.minPubDate, "2026-09-04T00:00:00Z");
  // No maxPubDate: isSourceWindowClosed skips any source whose maxPubDate has
  // passed, which would make every backfill run a no-op.
  assert.equal(out.maxPubDate, undefined);
  assert.equal(isSourceWindowClosed(out, new Date("2026-09-18T00:00:00Z")), false);
  // A cached response answers the old question, so the backfill must refetch.
  assert.equal(out.refetchIgnoringCache, true);
});

test("applyBackfillWindow leaves non-search and non-Google sources untouched", () => {
  const rss = { name: "Plain RSS", feedUrl: "https://example.com/feed.xml" };
  const social = { name: "A Facebook page", facebookPageUrl: "https://facebook.com/x" };
  const other = {
    name: "Other search",
    isSearchFeed: true,
    feedUrl: "https://bing.com/news/search?q=when%3A30d",
  };
  const window = { after: "2026-09-05", before: "2026-09-14" };
  assert.deepEqual(applyBackfillWindow([rss, social, other], window), [rss, social, other]);
  // No window means no change at all.
  assert.deepEqual(applyBackfillWindow([rss, social, other], null), [rss, social, other]);
});
