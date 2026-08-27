// Source list: Vermont outlets, national health feeds, Google News searches,
// listing pages, and parked Facebook source definitions.
import { parseNonNegativeInteger, parsePositiveInteger } from "./utils.js";

const FACEBOOK_HOST_PATTERN = /^https?:\/\/(?:m\.|www\.)?facebook\.com\//i;

function googleNewsSearchUrl(query) {
  const params = new URLSearchParams({
    q: query,
    hl: "en-US",
    gl: "US",
    ceid: "US:en",
  });

  return `https://news.google.com/rss/search?${params.toString()}`;
}

const LOCAL_OUTLET_FALLBACK_TERMS = [
  '"health care"',
  '"health insurance"',
  'hospital',
  '"blue cross"',
];

// Naming the brand is what keeps the national Blues firehose out of the trade
// press searches; scoping to "Vermont" alone was measurably too loose.
const TRADE_PRESS_BRAND_QUERY =
  '("BCBS Vermont" OR "Blue Cross Vermont" OR "Blue Cross Blue Shield of Vermont")';

const TOWNNEWS_SEARCH_THROTTLE = {
  throttleGroup: "townnews-search",
  throttleDelayMs: parseNonNegativeInteger(process.env.RSS_TOWNNEWS_DELAY_MS, 8000),
};

function localOutletFallbackFeed(site, days = 30) {
  return {
    feedUrl: googleNewsSearchUrl(
      `site:${site} (${LOCAL_OUTLET_FALLBACK_TERMS.join(" OR ")}) when:${days}d`,
    ),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: days,
    maxItems: 25,
  };
}

function localOutletSearchSource(name, homepage, site, days = 30) {
  return {
    name,
    homepage,
    ...localOutletFallbackFeed(site, days),
  };
}

export function socialSourcesEnabled() {
  return process.env.ENABLE_SOCIAL_SOURCES === "true";
}

export function isSocialSourceItem(item = {}) {
  return (
    FACEBOOK_HOST_PATTERN.test(item.link || item.url || "") ||
    FACEBOOK_HOST_PATTERN.test(item.sourceFeedUrl || "") ||
    /\bfacebook\b/i.test(item.sourceName || "")
  );
}

export const DEFAULT_SOURCES = [
  {
    name: "WCAX",
    homepage: "https://www.wcax.com/",
    feedUrl:
      "https://www.wcax.com/arc/outboundfeeds/whiz-rss/category/news/?outputType=xml&size=50&sort=display_date%3Adesc",
  },
  {
    name: "VTDigger",
    homepage: "https://vtdigger.org/",
    feedUrl: "https://vtdigger.org/feed/",
  },
  {
    name: "Vermont Public",
    homepage: "https://www.vermontpublic.org/",
    feedUrl: "https://www.vermontpublic.org/local-news.rss",
  },
  {
    name: "Seven Days",
    homepage: "https://www.sevendaysvt.com/",
    feedUrl: "https://www.sevendaysvt.com/vermont/Rss.xml",
  },
  {
    name: "MyNBC5",
    homepage: "https://www.mynbc5.com/",
    feedUrl: "https://www.mynbc5.com/topstories-rss",
  },
  {
    name: "MyChamplainValley",
    homepage: "https://www.mychamplainvalley.com/",
    feedUrl: "https://www.mychamplainvalley.com/feed/",
  },
  {
    name: "Vermont Business Magazine",
    homepage: "https://vermontbiz.com/",
    feedUrl: "https://vermontbiz.com/rss.xml",
    fallbackFeed: localOutletFallbackFeed("vermontbiz.com"),
  },
  {
    name: "UVM Health Newsroom",
    homepage: "https://www.uvmhealth.org/newsroom",
    listingUrl: "https://www.uvmhealth.org/newsroom",
    listingParser: "uvmHealthNewsroom",
    searchFallbackTerms: ["UVM Health"],
    scanArticle: false,
    maxItems: 10,
  },
  {
    name: "BlueCrossVT Newsroom",
    homepage: "https://www.bluecrossvt.org/health-community/news",
    listingUrl: "https://www.bluecrossvt.org/health-community/news",
    searchFallbackTerms: ["bluecrossvt.org"],
    scanArticle: false,
  },
  {
    name: "BlueCrossVT Be Well VT Blog",
    homepage: "https://www.bluecrossvt.org/health-community/blog/listing",
    listingUrl: "https://www.bluecrossvt.org/health-community/blog/listing",
    searchFallbackTerms: ["bluecrossvt.org"],
    scanArticle: false,
  },
  {
    name: "BCBSA Association News",
    homepage: "https://www.bcbs.com/about-us/association-news",
    listingUrl: "https://www.bcbs.com/about-us/association-news",
    listingParser: "bcbsAssociationNews",
    searchFallbackTerms: ["Blue Cross Blue Shield Association"],
    scanArticle: false,
    maxItems: 20,
  },
  {
    name: "Addison Independent",
    homepage: "https://www.addisonindependent.com/",
    feedUrl: "https://www.addisonindependent.com/feed/",
  },
  {
    name: "Rutland Herald",
    homepage: "https://www.rutlandherald.com/",
    feedUrl:
      "https://www.rutlandherald.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    fallbackFeed: localOutletFallbackFeed("rutlandherald.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "Times Argus",
    homepage: "https://www.timesargus.com/",
    feedUrl:
      "https://www.timesargus.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    fallbackFeed: localOutletFallbackFeed("timesargus.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "Times Argus UVM Health Search",
    homepage: "https://www.timesargus.com/",
    feedUrl:
      "https://www.timesargus.com/search/?q=%22UVM%20Health%22&f=rss&t=article&l=50&s=start_time&sd=desc",
    scanArticle: false,
    maxItems: 20,
    fallbackFeed: localOutletFallbackFeed("timesargus.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "Bennington Banner",
    homepage: "https://www.benningtonbanner.com/",
    feedUrl:
      "https://www.benningtonbanner.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    fallbackFeed: localOutletFallbackFeed("benningtonbanner.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "Brattleboro Reformer",
    homepage: "https://www.reformer.com/",
    feedUrl:
      "https://www.reformer.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    fallbackFeed: localOutletFallbackFeed("reformer.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "Vermont Community Newspaper Group",
    homepage: "https://www.vtcng.com/",
    feedUrl:
      "https://www.vtcng.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    fallbackFeed: localOutletFallbackFeed("vtcng.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "Valley News",
    homepage: "https://vnews.com/",
    feedUrl: "https://vnews.com/feed/",
  },
  {
    name: "The Mountain Times",
    homepage: "https://mountaintimes.info/",
    feedUrl: "https://mountaintimes.info/feed/",
    fallbackFeed: localOutletFallbackFeed("mountaintimes.info"),
  },
  {
    name: "Newport Daily Express",
    homepage: "https://www.newportvermontdailyexpress.com/",
    feedUrl:
      "https://www.newportvermontdailyexpress.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    fallbackFeed: localOutletFallbackFeed("newportvermontdailyexpress.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "Vermont Daily Chronicle",
    homepage: "https://vermontdailychronicle.com/",
    feedUrl: "https://vermontdailychronicle.com/feed/",
  },
  {
    name: "St. Albans Messenger",
    homepage: "https://www.samessenger.com/",
    feedUrl:
      "https://www.samessenger.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    fallbackFeed: localOutletFallbackFeed("samessenger.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "Caledonian-Record",
    homepage: "https://www.caledonianrecord.com/",
    feedUrl:
      "https://www.caledonianrecord.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    fallbackFeed: localOutletFallbackFeed("caledonianrecord.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "The Chronicle / Barton Chronicle",
    homepage: "https://www.bartonchronicle.com/",
    feedUrl: "https://www.bartonchronicle.com/feed/",
    fallbackFeed: localOutletFallbackFeed("bartonchronicle.com"),
  },
  localOutletSearchSource(
    "The Commons",
    "https://www.commonsnews.org/",
    "commonsnews.org",
  ),
  localOutletSearchSource("The World", "https://www.vt-world.com/", "vt-world.com"),
  {
    name: "Journal Opinion",
    homepage: "https://www.jonews.com/",
    feedUrl: "https://www.jonews.com/feed/",
    fallbackFeed: localOutletFallbackFeed("jonews.com"),
  },
  {
    name: "Brandon Reporter",
    homepage: "https://brandonreporter.com/",
    feedUrl: "https://brandonreporter.com/feed/",
    fallbackFeed: localOutletFallbackFeed("brandonreporter.com"),
  },
  localOutletSearchSource(
    "North Avenue News",
    "https://www.northavenuenews.com/",
    "northavenuenews.com",
  ),
  localOutletSearchSource(
    "Lakeside News & The Rutland Sun",
    "https://www.lakesidenews.org/",
    "lakesidenews.org",
  ),
  {
    name: "Charlotte News",
    homepage: "https://www.charlottenewsvt.org/",
    feedUrl: "https://www.charlottenewsvt.org/feed/",
    fallbackFeed: localOutletFallbackFeed("charlottenewsvt.org"),
  },
  localOutletSearchSource("Eagle Times", "https://www.eagletimes.com/", "eagletimes.com"),
  {
    name: "Colchester Sun",
    homepage: "https://www.colchestersun.com/",
    feedUrl:
      "https://www.colchestersun.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    fallbackFeed: localOutletFallbackFeed("colchestersun.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "North Star Monthly",
    homepage: "https://www.northstarmonthly.com/",
    feedUrl:
      "https://www.northstarmonthly.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    fallbackFeed: localOutletFallbackFeed("northstarmonthly.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "County Courier",
    homepage: "https://countycourier.net/",
    feedUrl: "https://countycourier.net/feed/",
    fallbackFeed: localOutletFallbackFeed("countycourier.net"),
  },
  {
    name: "Essex Reporter",
    homepage: "https://www.essexreporter.com/",
    feedUrl:
      "https://www.essexreporter.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    fallbackFeed: localOutletFallbackFeed("essexreporter.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "The Hardwick Gazette",
    homepage: "https://hardwickgazette.com/",
    feedUrl: "https://hardwickgazette.com/feed/",
    fallbackFeed: localOutletFallbackFeed("hardwickgazette.com"),
  },
  {
    name: "Hinesburg Record",
    homepage: "https://www.hinesburgrecord.org/",
    feedUrl: "https://www.hinesburgrecord.org/feed/",
    fallbackFeed: localOutletFallbackFeed("hinesburgrecord.org"),
  },
  {
    name: "Vermont Journal & The Shopper",
    homepage: "https://www.vermontjournal.com/",
    feedUrl: "https://www.vermontjournal.com/feed/",
    fallbackFeed: localOutletFallbackFeed("vermontjournal.com"),
  },
  {
    name: "Manchester Journal",
    homepage: "https://www.manchesterjournal.com/",
    feedUrl:
      "https://www.manchesterjournal.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    fallbackFeed: localOutletFallbackFeed("manchesterjournal.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  localOutletSearchSource(
    "Vermont News Guide",
    "https://www.vtnewsguide.com/",
    "vtnewsguide.com",
  ),
  localOutletSearchSource(
    "Addison Eagle",
    "https://www.suncommunitynews.com/",
    "suncommunitynews.com",
  ),
  {
    name: "Milton Independent",
    homepage: "https://www.miltonindependent.com/",
    feedUrl:
      "https://www.miltonindependent.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    fallbackFeed: localOutletFallbackFeed("miltonindependent.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "The Bridge",
    homepage: "https://montpelierbridge.org/",
    feedUrl: "https://montpelierbridge.org/feed/",
    fallbackFeed: localOutletFallbackFeed("montpelierbridge.org"),
  },
  localOutletSearchSource(
    "Northfield News",
    "https://www.thenorthfieldnews.com/",
    "thenorthfieldnews.com",
  ),
  {
    name: "The Islander",
    homepage: "https://www.theislandernewspaper.com/",
    feedUrl: "https://www.theislandernewspaper.com/feed/",
    fallbackFeed: localOutletFallbackFeed("theislandernewspaper.com"),
  },
  localOutletSearchSource(
    "Lakes Region Free Press",
    "https://nyvtmedia.com/",
    "nyvtmedia.com",
  ),
  {
    name: "White River Valley Herald",
    homepage: "https://www.ourherald.com/",
    feedUrl: "https://www.ourherald.com/feed/",
    fallbackFeed: localOutletFallbackFeed("ourherald.com"),
  },
  {
    name: "Springfield Reporter / Springfield Vermont News",
    homepage: "https://springfieldvt.blogspot.com/p/springfield-reporter.html",
    feedUrl: "https://springfieldvt.blogspot.com/feeds/posts/default?alt=rss",
    fallbackFeed: localOutletFallbackFeed("springfieldvt.blogspot.com"),
  },
  localOutletSearchSource(
    "Mountain Gazette",
    "https://www.mtngazettevt.com/",
    "mtngazettevt.com",
  ),
  {
    name: "Valley Reporter",
    homepage: "https://www.valleyreporter.com/",
    feedUrl:
      "https://www.valleyreporter.com/index.php/news?format=feed&type=rss",
    fallbackFeed: localOutletFallbackFeed("valleyreporter.com"),
  },
  {
    name: "Williston Observer",
    homepage: "https://www.willistonobserver.com/",
    feedUrl:
      "https://www.willistonobserver.com/search/?f=rss&t=article&l=50&s=start_time&sd=desc",
    fallbackFeed: localOutletFallbackFeed("willistonobserver.com"),
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "Deerfield Valley News",
    homepage: "https://www.dvalnews.com/",
    feedUrl: "https://www.dvalnews.com/rss.xml",
    fallbackFeed: localOutletFallbackFeed("dvalnews.com"),
  },
  {
    name: "Vermont Standard",
    homepage: "https://thevermontstandard.com/",
    feedUrl: "https://thevermontstandard.com/feed/",
    fallbackFeed: localOutletFallbackFeed("thevermontstandard.com"),
  },
  {
    name: "Community News Service",
    homepage: "https://vtcommunitynews.org/",
    feedUrl: "https://vtcommunitynews.org/feed/",
    fallbackFeed: localOutletFallbackFeed("vtcommunitynews.org"),
  },
  localOutletSearchSource(
    "Waterbury Roundabout",
    "https://www.waterburyroundabout.org/",
    "waterburyroundabout.org",
  ),
  {
    name: "Chester Telegraph",
    homepage: "https://www.chestertelegraph.org/",
    feedUrl: "https://www.chestertelegraph.org/feed/",
    fallbackFeed: localOutletFallbackFeed("chestertelegraph.org"),
  },
  {
    name: "Newport Dispatch",
    homepage: "https://www.newportdispatch.com/",
    feedUrl: "https://www.newportdispatch.com/feed/",
    fallbackFeed: localOutletFallbackFeed("newportdispatch.com"),
  },
  localOutletSearchSource(
    "Cabot Chronicle",
    "https://www.cabotchronicle.org/",
    "cabotchronicle.org",
  ),
  localOutletSearchSource(
    "East Montpelier Signpost",
    "https://emsignpost.com/",
    "emsignpost.com",
  ),
  {
    name: "Winooski News",
    homepage: "https://thewinooskinews.com/",
    feedUrl: "https://vtcommunitynews.org/category/winooski/feed/",
    fallbackFeed: localOutletFallbackFeed("thewinooskinews.com"),
  },
  {
    name: "Town Meeting TV",
    homepage: "https://www.cctv.org/",
    feedUrl:
      "https://www.youtube.com/feeds/videos.xml?channel_id=UCJkWMLSqRNKLoyUZQiNoAcQ",
    scanArticle: false,
    fallbackFeed: localOutletFallbackFeed("cctv.org"),
  },
  {
    name: "iBrattleboro",
    homepage: "https://www.ibrattleboro.com/",
    feedUrl: "https://www.ibrattleboro.com/feed/",
    fallbackFeed: localOutletFallbackFeed("ibrattleboro.com"),
  },
  localOutletSearchSource(
    "Burlington Free Press",
    "https://www.burlingtonfreepress.com/",
    "burlingtonfreepress.com",
  ),
  {
    name: "The Rake Vermont",
    homepage: "https://www.rakevt.org/",
    feedUrl: "https://www.rakevt.org/feed/",
    fallbackFeed: localOutletFallbackFeed("rakevt.org"),
  },
  {
    name: "Poultney Journal",
    homepage: "https://www.poultneyjournal.com/",
    feedUrl: "https://www.poultneyjournal.com/rss/",
    fallbackFeed: localOutletFallbackFeed("poultneyjournal.com"),
  },
  {
    name: "Magic 96.7 Vermont News",
    homepage: "https://www.magic967.com/",
    feedUrl: "https://www.magic967.com/news/vermont/feed.xml",
    fallbackFeed: localOutletFallbackFeed("magic967.com"),
  },
  {
    name: "The Vermont Cynic",
    homepage: "https://vtcynic.com/",
    feedUrl: "https://vtcynic.com/feed/",
    fallbackFeed: localOutletFallbackFeed("vtcynic.com"),
  },
  {
    name: "Stratton Magazine",
    homepage: "https://strattonmagazine.com/",
    feedUrl: "https://strattonmagazine.com/feed/",
    fallbackFeed: localOutletFallbackFeed("strattonmagazine.com"),
  },
  // The Blue Cross brand searches. Google News degrades long OR queries
  // badly — the original single 23-term query returned 3 items while its
  // own terms unioned to 49, and mixing site: operators with phrases is
  // especially destructive (1 item vs ~17). These are split into small,
  // homogeneous chunks; each chunk was measured live against Google News
  // before being added (see WORKLOG 2026-08-25).
  {
    name: "Google News Blue Cross Site Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      "(site:bcbsvt.org OR bluecrossvt.org OR site:bcbs.com OR site:bluewebportal.bcbs.com) when:30d",
    ),
    isSearchFeed: true,
    searchFallbackTerms: ["Blue Cross"],
    maxItemAgeDays: 30,
    maxItems: 30,
  },
  {
    name: "Google News Blue Cross Phrase Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      '("Blue Cross VT" OR "BCBSVT" OR "BCBS VT" OR "BlueCrossVT") when:30d',
    ),
    isSearchFeed: true,
    searchFallbackTerms: ["Blue Cross"],
    maxItemAgeDays: 30,
    maxItems: 10,
  },
  {
    name: "Google News Blue Cross Spelling Variant Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      '("Blue CrossVT" OR "BlueCross VT" OR "Blue Cross Vermont" OR "Blue Cross of Vermont") when:30d',
    ),
    isSearchFeed: true,
    searchFallbackTerms: ["Blue Cross"],
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 10,
  },
  {
    name: "Google News Blue Cross Boolean Search A",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      '("blue cross" AND VT) OR ("blue cross" AND Vermont) OR ("bluecross" AND VT) when:30d',
    ),
    isSearchFeed: true,
    searchFallbackTerms: ["Blue Cross"],
    maxItemAgeDays: 30,
    maxItems: 20,
  },
  {
    name: "Google News Blue Cross Boolean Search B",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      '("bluecross" AND Vermont) OR ("BCBS" AND VT) OR ("bcbs" AND Vermont) when:30d',
    ),
    isSearchFeed: true,
    searchFallbackTerms: ["Blue Cross"],
    maxItemAgeDays: 30,
    maxItems: 20,
  },
  {
    name: "Google News Blue Cross Full-Name Search A",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      '("Blue Cross and Blue Shield" AND Vermont) OR ("Blue Cross and Blue Shield" AND VT) OR ("Blue Cross and Blue Shield of Vermont") when:30d',
    ),
    isSearchFeed: true,
    searchFallbackTerms: ["Blue Cross"],
    maxItemAgeDays: 30,
    maxItems: 15,
  },
  {
    name: "Google News Blue Cross Full-Name Search B",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      '("Bluecross Blueshield" AND Vermont) OR ("BlueCross and BlueShield of Vermont") OR ("BlueCross & BlueShield of Vermont") when:30d',
    ),
    isSearchFeed: true,
    searchFallbackTerms: ["Blue Cross"],
    maxItemAgeDays: 30,
    maxItems: 15,
  },
  {
    name: "Google News Vermont Health Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      `(${[
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
        '"DVHA"',
        '"Vermont Department of Health"',
        '"health insurance premiums" Vermont',
        '"Medicare Advantage" Vermont',
      ].join(" OR ")}) when:7d`,
    ),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 50,
  },
  {
    name: "Google News Kristina Source Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      [
        "(site:burlingtonfreepress.com OR site:wsj.com OR site:abcnews.go.com OR site:cbsnews.com OR site:cnn.com OR site:beckershospitalreview.com OR site:samessenger.com OR site:vermontdailychronicle.com)",
        '("Vermont" OR "Blue Cross" OR "health care" OR healthcare OR "health insurance" OR Medicare OR Medicaid OR hospital OR insurer OR payer)',
      ].join(" ") + " when:14d",
    ),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 14,
    maxItems: 75,
  },
  {
    name: "Google News Health Insurance Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      [
        '"Medicare Advantage"',
        '"prior authorization"',
        '"medical debt"',
        '"health insurance premiums"',
        '"PBM"',
        '"No Surprises Act"',
        '"ACA coverage losses"',
        '"GLP-1 coverage"',
        '"payer issues"',
      ].join(" OR ") + " when:7d",
    ),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 30,
  },
  {
    name: "ABC News Health",
    homepage: "https://abcnews.go.com/Health",
    feedUrl: "https://abcnews.go.com/abcnews/healthheadlines",
    scanArticle: false,
    maxItems: 50,
  },
  {
    name: "CBS News Health",
    homepage: "https://www.cbsnews.com/health/",
    feedUrl: "https://www.cbsnews.com/latest/rss/health",
    scanArticle: false,
    maxItems: 50,
  },
  {
    name: "CNN Health",
    homepage: "https://www.cnn.com/health",
    listingUrl: "https://www.cnn.com/sitemap/news.xml",
    listingParser: "cnnHealthSitemap",
    scanArticle: false,
    maxItems: 50,
  },
  {
    name: "STAT Health News",
    homepage: "https://www.statnews.com/",
    feedUrl: "https://www.statnews.com/feed/",
    scanArticle: false,
    maxItems: 50,
  },
  {
    name: "Fierce Healthcare",
    homepage: "https://www.fiercehealthcare.com/",
    feedUrl: "https://www.fiercehealthcare.com/rss/xml",
    scanArticle: false,
    maxItems: 50,
  },
  {
    name: "Healthcare Dive",
    homepage: "https://www.healthcaredive.com/",
    feedUrl: "https://www.healthcaredive.com/feeds/news/",
    scanArticle: false,
    maxItems: 50,
  },
  // Payer trade press. Kristina's media tracker leans on these three (Becker's
  // alone is 17 of her 185 clips), but all three block direct crawling:
  // beckerspayer.com and modernhealthcare.com answer 403 to any user agent and
  // healthpayerspecialist.com redirects to a login, so none exposes a usable
  // feed. They are reached through Google News site-scoped searches instead.
  //
  // Three deliberate choices, each measured on 2026-08-27.
  //
  // The queries name the brand explicitly rather than scoping to "Vermont".
  // A bare `site:beckerspayer.com Vermont` looked good unbounded, because
  // Google orders by relevance, but once the local date window trimmed it to
  // recent items the survivors were national filler and Modern Healthcare
  // returned job adverts. The broad-national relevance gate did not save it:
  // "Registered Nurse Job Opening in Whitefield, New Hampshire" reads as a
  // regional signal, so 6 of 7 kept items were junk. Naming the brand takes
  // Becker's to 32 results that are almost exactly the tracker's own clips.
  //
  // None carries a `when:` bound. Adding one made Google News fall back to
  // loosely-related results ("Senate confirms UnitedHealth leader"), the same
  // degradation documented for long OR queries, so the date window is
  // enforced locally by maxItemAgeDays instead.
  //
  // The window is wide because these are low-volume: Becker's has 32 matching
  // stories in total and only 3 in the last 60 days, so a short window would
  // miss most of the back catalogue this was added to capture.
  //
  // All three are in BROAD_NATIONAL_SOURCE_NAMES, so the relevance gate is a
  // second guard. See docs/2026-08-27-media-tracker-coverage.md.
  {
    name: "Becker's Payer Issues",
    homepage: "https://www.beckerspayer.com/",
    feedUrl: googleNewsSearchUrl(
      `site:beckerspayer.com ${TRADE_PRESS_BRAND_QUERY}`,
    ),
    isSearchFeed: true,
    scanArticle: false,
    maxItems: 25,
    maxItemAgeDays: 180,
  },
  {
    name: "Modern Healthcare",
    homepage: "https://www.modernhealthcare.com/",
    feedUrl: googleNewsSearchUrl(
      `site:modernhealthcare.com ${TRADE_PRESS_BRAND_QUERY}`,
    ),
    isSearchFeed: true,
    scanArticle: false,
    maxItems: 25,
    maxItemAgeDays: 180,
  },
  // Thin by measurement, not by mistake: Google News barely indexes this
  // subscription trade title. On 2026-08-27 a brand-scoped search returned
  // nothing and an unscoped one returned mostly newsletter signup pages, so
  // this source is expected to sit at zero items. Kept because it costs one
  // request per run, the brand matcher gates whatever it does return, and the
  // index may improve. An empty 200 is not a fetch failure, so it will not
  // trip the failure-streak alerting.
  {
    name: "Health Payer Specialist",
    homepage: "https://www.healthpayerspecialist.com/",
    feedUrl: googleNewsSearchUrl(
      `site:healthpayerspecialist.com ${TRADE_PRESS_BRAND_QUERY}`,
    ),
    isSearchFeed: true,
    scanArticle: false,
    maxItems: 25,
    maxItemAgeDays: 180,
  },
  {
    name: "KFF Health News",
    homepage: "https://kffhealthnews.org/",
    feedUrl: "https://kffhealthnews.org/feed/",
    scanArticle: false,
    maxItems: 50,
  },
  {
    name: "The Hill Health Care",
    homepage: "https://thehill.com/policy/healthcare/",
    feedUrl: "https://thehill.com/policy/healthcare/feed/",
    scanArticle: false,
    maxItems: 50,
  },
  {
    name: "NPR Health",
    homepage: "https://www.npr.org/sections/health/",
    feedUrl: "https://www.npr.org/rss/rss.php?id=1128",
    scanArticle: false,
    maxItems: 50,
  },
  {
    name: "Google News Health Trade Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      [
        "(site:modernhealthcare.com OR site:beckerspayer.com OR site:beckershospitalreview.com OR site:fiercehealthcare.com OR site:statnews.com OR site:healthcaredive.com)",
        '("Medicare Advantage" OR "prior authorization" OR PBM OR "No Surprises Act" OR Medicaid OR Medicare OR "health insurers" OR "health plans" OR "medical debt" OR "GLP-1" OR payer OR "price transparency" OR "reimbursement cuts" OR "claim denials" OR "rural hospitals" OR physicians OR "340B")',
      ].join(" ") + " when:14d",
    ),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 14,
    maxItems: 75,
  },
  {
    name: "Google News National Health Policy Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      [
        "(site:abcnews.go.com OR site:apnews.com OR site:cbsnews.com OR site:cnn.com OR site:nbcnews.com OR site:nytimes.com OR site:washingtonpost.com OR site:wsj.com OR site:axios.com OR site:npr.org OR site:thehill.com OR site:kffhealthnews.org OR site:newsfromthestates.com OR site:stateline.org)",
        '("Medicare Advantage" OR "prior authorization" OR Medicaid OR Medicare OR Obamacare OR ACA OR "medical debt" OR "No Surprises Act" OR GLP-1 OR vaccines OR "health insurance" OR "health care costs" OR "price transparency" OR menopause OR maternity OR "private equity")',
      ].join(" ") + " when:14d",
    ),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 14,
    maxItems: 75,
  },
];

// Social post collection is intentionally parked. Set
// ENABLE_SOCIAL_SOURCES=true for a deliberate one-off run that includes the
// built-in Facebook pages and any configured Facebook URLs.
const SOCIAL_SOURCES = [
  {
    name: "VTDigger Facebook",
    homepage: "https://www.facebook.com/vtdigger",
    facebookPageUrl: "https://www.facebook.com/vtdigger",
    requireBrandMatch: true,
  },
  {
    name: "WCAX Facebook",
    homepage: "https://www.facebook.com/wcaxtv",
    facebookPageUrl: "https://www.facebook.com/wcaxtv",
    requireBrandMatch: true,
  },
  {
    name: "Seven Days Facebook",
    homepage: "https://www.facebook.com/sevendaysvt",
    facebookPageUrl: "https://www.facebook.com/sevendaysvt",
    requireBrandMatch: true,
  },
  {
    name: "Vermont Public Facebook",
    homepage: "https://www.facebook.com/vermontpublic",
    facebookPageUrl: "https://www.facebook.com/vermontpublic",
    requireBrandMatch: true,
  },
  {
    name: "MyNBC5 Facebook",
    homepage: "https://www.facebook.com/MyNBC5",
    facebookPageUrl: "https://www.facebook.com/MyNBC5",
    requireBrandMatch: true,
  },
  {
    name: "Vermont Business Magazine Facebook",
    homepage: "https://www.facebook.com/vermontbiz",
    facebookPageUrl: "https://www.facebook.com/vermontbiz",
    requireBrandMatch: true,
  },
];

function parseConfiguredUrlSources(value, buildSource) {
  return String(value || "")
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry, index) => {
      const [maybeName, maybeUrl] = entry.includes("|")
        ? entry.split("|", 2).map((part) => part.trim())
        : ["", entry];
      if (!maybeUrl) {
        return null;
      }

      try {
        const url = new URL(maybeUrl).toString();
        const name =
          maybeName ||
          `Configured Facebook ${index + 1}`;
        return buildSource(name, url);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function buildSourcesFromEnv(baseSources = DEFAULT_SOURCES) {
  if (!socialSourcesEnabled()) {
    return [...baseSources];
  }

  const configuredPosts = parseConfiguredUrlSources(
    process.env.FACEBOOK_POST_URLS,
    (name, url) => ({
      name: `${name} Facebook post`,
      homepage: url,
      facebookPostUrl: url,
      requireBrandMatch: true,
    }),
  );

  const configuredPages = parseConfiguredUrlSources(
    process.env.FACEBOOK_PAGE_URLS,
    (name, url) => ({
      name: `${name} Facebook page`,
      homepage: url,
      facebookPageUrl: url,
      maxItems: parsePositiveInteger(process.env.FACEBOOK_PAGE_MAX_POSTS, 10),
      requireBrandMatch: true,
    }),
  );

  const defaultSocialSources = baseSources === DEFAULT_SOURCES ? SOCIAL_SOURCES : [];
  return [...baseSources, ...defaultSocialSources, ...configuredPosts, ...configuredPages];
}

// Every hand-curated Vermont outlet in DEFAULT_SOURCES belongs here:
// hasRegionalSignal falls back to this set, so an outlet left out loses its
// regional classification and its small-town health stories get rejected as
// "outside Vermont" whenever the copy names no other Vermont place.
export const VERMONT_SOURCE_NAMES = new Set([
  "Addison Eagle",
  "Addison Independent",
  "Bennington Banner",
  "Brandon Reporter",
  "Brattleboro Reformer",
  "Burlington Free Press",
  "Cabot Chronicle",
  "Caledonian-Record",
  "Charlotte News",
  "Chester Telegraph",
  "Colchester Sun",
  "Community News Service",
  "County Courier",
  "Deerfield Valley News",
  "Eagle Times",
  "East Montpelier Signpost",
  "Essex Reporter",
  "Hinesburg Record",
  "iBrattleboro",
  "Journal Opinion",
  "Lakes Region Free Press",
  "Lakeside News & The Rutland Sun",
  "Magic 96.7 Vermont News",
  "Manchester Journal",
  "Milton Independent",
  "Mountain Gazette",
  "MyChamplainValley",
  "MyNBC5",
  "Newport Daily Express",
  "Newport Dispatch",
  "North Avenue News",
  "North Star Monthly",
  "Northfield News",
  "Poultney Journal",
  "Rutland Herald",
  "Seven Days",
  "Springfield Reporter / Springfield Vermont News",
  "St. Albans Messenger",
  "Stratton Magazine",
  "The Bridge",
  "The Chronicle / Barton Chronicle",
  "The Commons",
  "The Hardwick Gazette",
  "The Islander",
  "The Mountain Times",
  "The Rake Vermont",
  "The Vermont Cynic",
  "The World",
  "Times Argus",
  "Times Argus UVM Health Search",
  "Town Meeting TV",
  "UVM Health Newsroom",
  "Valley News",
  "Valley Reporter",
  "Vermont Business Magazine",
  "Vermont Community Newspaper Group",
  "Vermont Daily Chronicle",
  "Vermont Journal & The Shopper",
  "Vermont News Guide",
  "Vermont Public",
  "Vermont Standard",
  "VTDigger",
  "Waterbury Roundabout",
  "White River Valley Herald",
  "Williston Observer",
  "Winooski News",
  "WCAX",
]);

export const BROAD_NATIONAL_SOURCE_NAMES = new Set([
  "ABC News Health",
  "Becker's Payer Issues",
  "CBS News Health",
  "CNN Health",
  "Fierce Healthcare",
  "Health Payer Specialist",
  "Google News Health Insurance Search",
  "Google News Health Trade Search",
  "Google News Kristina Source Search",
  "Google News National Health Policy Search",
  "Healthcare Dive",
  "KFF Health News",
  "Modern Healthcare",
  "NPR Health",
  "STAT Health News",
  "The Hill Health Care",
]);
