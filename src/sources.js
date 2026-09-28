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
    // Brand body scan: every article is fetched unless its feed text already
    // names us, because a brief or roundup can name Blue Cross VT only in the
    // body. These four outlets carry the most hand-logged clips among direct
    // feeds (VermontBiz has more but refuses the runner with 403).
    articleScanMode: "brandBody",
  },
  {
    name: "VTDigger",
    homepage: "https://vtdigger.org/",
    feedUrl: "https://vtdigger.org/feed/",
    articleScanMode: "brandBody",
  },
  {
    name: "Vermont Public",
    homepage: "https://www.vermontpublic.org/",
    feedUrl: "https://www.vermontpublic.org/local-news.rss",
    articleScanMode: "brandBody",
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
  // Curated backfill of the communications team's media tracker. Local file,
  // no network. Re-emitted every run so the archive self-heals: an entry that
  // is somehow lost comes back on the next crawl. Article scanning is off
  // because 186 extra fetches would risk the workflow's 30-minute timeout, and
  // the tracker's headline, outlet and topic already carry what the matcher
  // and summarizer need. See docs/2026-08-27-media-tracker-coverage.md.
  {
    name: "Media Tracker Backfill",
    homepage: "https://www.bluecrossvt.org/",
    seedItemsPath: "data/media-tracker-seed.json",
    scanArticle: false,
  },
  {
    name: "UVM Health Newsroom",
    homepage: "https://www.uvmhealth.org/newsroom/search",
    listingUrl: "https://www.uvmhealth.org/newsroom/search",
    listingParser: "uvmHealthNewsroom",
    searchFallbackTerms: ["UVM Health"],
    scanArticle: false,
    maxItems: 15,
    minimumParsedItems: 1,
  },
  // The two bluecrossvt.org listing pages (Newsroom, Be Well VT Blog) were
  // removed on 2026-09-03: the site no longer crawls bluecrossvt.org at all
  // (see politeness.js noCrawl). Coverage of the insurer still arrives
  // through the Google News searches and the outlet feeds.
  {
    name: "BCBSA Association News",
    homepage: "https://www.bcbs.com/about-us/association-news",
    listingUrl: "https://www.bcbs.com/about-us/association-news",
    listingParser: "bcbsAssociationNews",
    searchFallbackTerms: ["Blue Cross Blue Shield Association"],
    scanArticle: false,
    maxItems: 20,
    minimumParsedItems: 1,
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
    articleScanMode: "brandBody",
  },
  {
    name: "Times Argus UVM Health Search",
    homepage: "https://www.timesargus.com/",
    feedUrl:
      "https://www.timesargus.com/search/?q=%22UVM%20Health%22&f=rss&t=article&l=50&s=start_time&sd=desc",
    scanArticle: false,
    maxItems: 20,
    fallbackFeed: {
      ...localOutletFallbackFeed("timesargus.com"),
      feedUrl: googleNewsSearchUrl(
        'site:timesargus.com "UVM Health" when:30d',
      ),
    },
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
    // hardwickgazette.com now redirects to the .org host.
    name: "The Hardwick Gazette",
    homepage: "https://hardwickgazette.org/",
    feedUrl: "https://hardwickgazette.org/feed/",
    fallbackFeed: localOutletFallbackFeed("hardwickgazette.org"),
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
    // Moved to thebridgevt.org; both hosts answer direct fetches with a bot
    // challenge, so the fallback search does the work.
    name: "The Bridge",
    homepage: "https://thebridgevt.org/",
    feedUrl: "https://thebridgevt.org/feed/",
    fallbackFeed: localOutletFallbackFeed("thebridgevt.org"),
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
    // dvalnews.com now redirects here; the old site: scope returned 0 items.
    name: "Deerfield Valley News",
    homepage: "https://www.deerfieldvalleynews.org/",
    feedUrl: "https://www.deerfieldvalleynews.org/rss.xml",
    fallbackFeed: localOutletFallbackFeed("deerfieldvalleynews.org"),
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
  // Added 2026-09-28 from a verified inventory of Vermont sources: state
  // health agencies and officials, Vermont hospitals and health groups,
  // online and radio outlets, neighbors searched with Vermont in the query,
  // and Becker's ASC Review. Every feed and query below was fetched and
  // parsed before it was added. Sites that answer direct fetches with a
  // 403 or a bot challenge are reached through a site-scoped Google News
  // search instead. Organizations that publish rarely get a 90-day window,
  // since Google returned nothing for them inside 30 days.
  {
    name: "Green Mountain Care Board",
    homepage: "https://gmcboard.vermont.gov/",
    feedUrl: "https://gmcboard.vermont.gov/rss.xml",
  },
  {
    name: "Vermont Department of Financial Regulation",
    homepage: "https://dfr.vermont.gov/",
    feedUrl: "https://dfr.vermont.gov/rss.xml",
  },
  {
    name: "Department of Vermont Health Access",
    homepage: "https://dvha.vermont.gov/",
    feedUrl: "https://dvha.vermont.gov/rss.xml",
  },
  {
    name: "Vermont Health Connect",
    homepage: "https://info.healthconnect.vermont.gov/",
    feedUrl: "https://info.healthconnect.vermont.gov/rss.xml",
  },
  {
    name: "Vermont Department of Health",
    homepage: "https://www.healthvermont.gov/",
    feedUrl: "https://www.healthvermont.gov/taxonomy/term/8797/feed",
  },
  {
    name: "Vermont Agency of Human Services",
    homepage: "https://humanservices.vermont.gov/",
    feedUrl: "https://humanservices.vermont.gov/rss.xml",
  },
  {
    name: "Vermont Department of Mental Health",
    homepage: "https://mentalhealth.vermont.gov/",
    feedUrl: "https://mentalhealth.vermont.gov/rss.xml",
  },
  {
    name: "Vermont Department of Disabilities, Aging and Independent Living",
    homepage: "https://dail.vermont.gov/",
    feedUrl: "https://dail.vermont.gov/rss.xml",
  },
  {
    name: "Vermont Governor's Office",
    homepage: "https://governor.vermont.gov/press-releases",
    feedUrl: "https://governor.vermont.gov/rss.xml",
  },
  {
    name: "Vermont Attorney General",
    homepage: "https://ago.vermont.gov/",
    feedUrl: "https://ago.vermont.gov/rss.xml",
  },
  {
    name: "Vermont Joint Fiscal Office",
    homepage: "https://ljfo.vermont.gov/",
    feedUrl: googleNewsSearchUrl("site:ljfo.vermont.gov when:90d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 90,
    maxItems: 25,
  },
  {
    name: "Office of the Health Care Advocate",
    homepage: "https://vtlawhelp.org/health",
    // The site's RSS answers GitHub's runners with HTTP 403 (it works from
    // other networks), so read it through a Google News site search, as for
    // NVRH. Measured 2026-09-28: 40 items in a 90-day window.
    feedUrl: googleNewsSearchUrl("site:vtlawhelp.org when:90d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 90,
    maxItems: 25,
  },
  {
    name: "Northwestern Medical Center",
    homepage: "https://www.northwesternmedicalcenter.org/",
    feedUrl: "https://www.northwesternmedicalcenter.org/feed/",
  },
  {
    name: "Northeastern Vermont Regional Hospital",
    homepage: "https://nvrh.org/",
    feedUrl: googleNewsSearchUrl("site:nvrh.org when:90d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 90,
    maxItems: 25,
  },
  {
    name: "Copley Hospital",
    homepage: "https://www.copleyvt.org/",
    feedUrl: "https://www.copleyvt.org/feed/",
  },
  {
    name: "Gifford Health Care",
    homepage: "https://giffordhealthcare.org/",
    feedUrl: "https://giffordhealthcare.org/feed/",
  },
  {
    name: "Springfield Hospital",
    homepage: "https://www.springfieldhospital.org/",
    feedUrl: "https://springfieldhospital.org/feed/",
  },
  {
    name: "Grace Cottage Family Health & Hospital",
    homepage: "https://www.gracecottage.org/",
    feedUrl: "https://gracecottage.org/feed/",
  },
  {
    name: "Brattleboro Memorial Hospital",
    homepage: "https://www.bmhvt.org/",
    feedUrl: "https://www.bmhvt.org/feed/",
  },
  {
    name: "Brattleboro Retreat",
    homepage: "https://www.brattlebororetreat.org/",
    feedUrl: "https://www.brattlebororetreat.org/feed",
  },
  {
    name: "Rutland Regional Medical Center",
    homepage: "https://www.rrmc.org/",
    feedUrl: googleNewsSearchUrl("site:rrmc.org when:90d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 90,
    maxItems: 25,
  },
  {
    name: "Southwestern Vermont Medical Center",
    homepage: "https://svmc.org/news-events/news",
    feedUrl: googleNewsSearchUrl("site:svmc.org (\"health care\" OR \"health insurance\" OR hospital OR \"blue cross\") when:30d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 25,
  },
  {
    name: "North Country Hospital",
    homepage: "https://www.northcountryhospital.org/",
    feedUrl: googleNewsSearchUrl("site:northcountryhospital.org when:90d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 90,
    maxItems: 25,
  },
  {
    name: "White River Junction VA Medical Center",
    homepage: "https://www.va.gov/white-river-junction-health-care/news-releases/",
    feedUrl: googleNewsSearchUrl("site:va.gov/white-river-junction-health-care (\"health care\" OR \"health insurance\" OR hospital OR \"blue cross\") when:30d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 25,
  },
  {
    name: "Dartmouth Health",
    homepage: "https://www.dartmouth-health.org/news",
    feedUrl: googleNewsSearchUrl("site:dartmouth-health.org (\"health care\" OR \"health insurance\" OR hospital OR \"blue cross\") when:30d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 25,
  },
  {
    name: "UVM News",
    homepage: "https://www.uvm.edu/news",
    feedUrl: googleNewsSearchUrl("site:uvm.edu (\"health care\" OR \"health insurance\" OR hospital OR \"blue cross\") when:30d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 25,
  },
  {
    name: "Vermont Medical Society",
    homepage: "https://vtmd.org/",
    feedUrl: googleNewsSearchUrl("site:vtmd.org when:90d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 90,
    maxItems: 25,
  },
  {
    name: "Vermont Care Partners",
    homepage: "https://vermontcarepartners.org/",
    feedUrl: googleNewsSearchUrl("site:vermontcarepartners.org (\"health care\" OR \"health insurance\" OR hospital OR \"blue cross\") when:30d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 25,
  },
  {
    name: "Compass Vermont",
    homepage: "https://www.compassvermont.com/",
    feedUrl: "https://www.compassvermont.com/feed",
  },
  {
    name: "Vermont Political Observer",
    homepage: "https://thevpo.org/",
    feedUrl: "https://thevpo.org/feed/",
  },
  {
    name: "Public Assets Institute",
    homepage: "https://publicassets.org/",
    feedUrl: "https://publicassets.org/sitemap.rss",
  },
  {
    name: "Daybreak",
    homepage: "https://news.daybreak.news/",
    feedUrl: googleNewsSearchUrl("site:news.daybreak.news when:90d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 90,
    maxItems: 25,
  },
  {
    name: "WVMT 620 News Talk",
    homepage: "https://www.wvmtradio.com/",
    feedUrl: googleNewsSearchUrl("site:wvmtradio.com when:30d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 25,
  },
  {
    name: "WDEV Radio Vermont",
    homepage: "https://www.wdevradio.com/",
    feedUrl: googleNewsSearchUrl("site:wdevradio.com when:90d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 90,
    maxItems: 25,
  },
  {
    name: "ORCA Media",
    homepage: "https://www.orcamedia.net/",
    feedUrl: googleNewsSearchUrl("site:orcamedia.net (\"health care\" OR \"health insurance\" OR hospital OR \"blue cross\") when:30d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 25,
  },
  {
    name: "Vermont Chamber of Commerce",
    homepage: "https://www.vtchamber.com/",
    feedUrl: "https://www.vtchamber.com/feed/",
  },
  {
    name: "New Hampshire Public Radio",
    homepage: "https://www.nhpr.org/",
    feedUrl: googleNewsSearchUrl("site:nhpr.org Vermont (\"health care\" OR \"health insurance\" OR hospital OR \"blue cross\") when:30d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 25,
  },
  {
    name: "The Keene Sentinel",
    homepage: "https://www.sentinelsource.com/",
    feedUrl: googleNewsSearchUrl("site:keenesentinel.com Vermont (\"health care\" OR \"health insurance\" OR hospital OR \"blue cross\") when:30d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 25,
  },
  {
    name: "Press-Republican",
    homepage: "https://www.pressrepublican.com/",
    feedUrl: googleNewsSearchUrl("site:pressrepublican.com Vermont (\"health care\" OR \"health insurance\" OR hospital OR \"blue cross\") when:30d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 25,
  },
  {
    name: "WMUR",
    homepage: "https://www.wmur.com/",
    feedUrl: googleNewsSearchUrl("site:wmur.com Vermont (\"health care\" OR \"health insurance\" OR hospital OR \"blue cross\") when:30d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 25,
  },
  {
    name: "NEWS10 ABC",
    homepage: "https://www.news10.com/",
    feedUrl: googleNewsSearchUrl("site:news10.com Vermont (\"health care\" OR \"health insurance\" OR hospital OR \"blue cross\") when:30d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 25,
  },
  {
    name: "WAMC Northeast Public Radio",
    homepage: "https://www.wamc.org/",
    feedUrl: googleNewsSearchUrl("site:wamc.org Vermont (\"health care\" OR \"health insurance\" OR hospital OR \"blue cross\") when:30d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 25,
  },
  {
    name: "The Berkshire Eagle",
    homepage: "https://www.berkshireeagle.com/",
    feedUrl: "https://www.berkshireeagle.com/search/?f=rss&t=article&q=Vermont&l=50&s=start_time&sd=desc",
    fallbackFeed: {
      ...localOutletFallbackFeed("berkshireeagle.com"),
      feedUrl: googleNewsSearchUrl(
        `site:berkshireeagle.com Vermont (${LOCAL_OUTLET_FALLBACK_TERMS.join(" OR ")}) when:30d`,
      ),
    },
    ...TOWNNEWS_SEARCH_THROTTLE,
  },
  {
    name: "Becker's ASC Review",
    homepage: "https://www.beckersasc.com/",
    feedUrl: "https://www.beckersasc.com/feed/",
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
      "(site:bcbsvt.org OR site:bluecrossvt.org OR site:bcbs.com OR site:bluewebportal.bcbs.com) when:30d",
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
    // Scanned since 2026-09-28 at Oliver's request: a spelling-variant hit
    // whose snippet omits the brand is confirmed from the article body.
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
    // The three-clause OR form returned 2 items on 2026-09-28; its clauses
    // alone returned 33, 55, and 17, so each clause is its own search.
    name: "Google News Vermont Health Search A",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl('Vermont "healthcare" when:7d'),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 25,
  },
  {
    name: "Google News Vermont Health Search F",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl('Vermont "health care" when:7d'),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 25,
  },
  {
    name: "Google News Vermont Health Search G",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl("Vermont hospitals when:7d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 25,
  },
  {
    name: "Google News Vermont Health Search B",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      '("health insurers" OR ("health care" AND affordability) OR ("Medicare Advantage" AND Vermont)) when:7d',
    ),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 25,
  },
  {
    name: "Google News Vermont Health Search C",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      '("UVM Health" OR "MVP Health Care" OR "Green Mountain Care Board" OR DVHA) when:7d',
    ),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 25,
  },
  {
    name: "Google News Vermont Health Search D",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      '("Vermont health care" OR "Vermont hospital" OR "Vermont Medicaid") when:7d',
    ),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 25,
  },
  {
    name: "Google News Vermont Health Search E",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      '("Vermont Health Connect" OR "Vermont Department of Health" OR ("health insurance premiums" AND Vermont)) when:7d',
    ),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 25,
  },
  // Share of voice charts MVP Health Care and UVM Health from 2026-01, so their
  // stories are kept indefinitely (INDEFINITE_RETENTION_LABELS in matching.js)
  // and these two searches are the ones a backfill rebounds to fill 2026.
  // MVP also operates in New York, hence the Vermont scope. Measured live on
  // 2026-09-28: 1 and 25 items in a 30-day window.
  {
    name: "Google News MVP Health Care Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl('"MVP Health Care" (Vermont OR VT) when:30d'),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 100,
  },
  {
    name: "Google News UVM Health Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl(
      '("UVM Health" OR "UVM Health Network" OR "UVM Medical Center" OR "University of Vermont Health") when:30d',
    ),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 30,
    maxItems: 100,
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
    // Becker's Hospital Review recurs in the team's clip log. Google ignores
    // topic scoping for this site and returns its whole feed, so it is
    // brand-scoped like the other trade press. Formerly reached through the
    // retired Kristina source search.
    name: "Becker's Hospital Review",
    homepage: "https://www.beckershospitalreview.com/",
    feedUrl: googleNewsSearchUrl(
      `site:beckershospitalreview.com ${TRADE_PRESS_BRAND_QUERY}`,
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
  // Short single-site searches replace three long OR queries (Health Trade,
  // National Health Policy, and the Kristina source list) that on 2026-09-24
  // returned mostly off-topic or years-old results. Each one returned 46-100
  // in-window items on 2026-09-28. Outlets with a direct feed here are left
  // out, and so are Becker's Hospital Review and Modern Healthcare, whose
  // volume would crowd out the per-run summary and Jev caps.
  {
    name: "Google News NYT Health Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl("site:nytimes.com health when:7d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 40,
  },
  {
    name: "Google News Washington Post Health Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl("site:washingtonpost.com health when:7d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 40,
  },
  {
    name: "Google News WSJ Health Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl("site:wsj.com health when:7d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 40,
  },
  {
    name: "Google News AP Health Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl("site:apnews.com health when:7d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 40,
  },
  {
    name: "Google News Axios Health Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl("site:axios.com health when:7d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 40,
  },
  {
    name: "Google News NBC News Health Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl("site:nbcnews.com health when:7d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 40,
  },
  {
    name: "Google News Becker's Payer Search",
    homepage: "https://news.google.com/",
    feedUrl: googleNewsSearchUrl("site:beckerspayer.com when:7d"),
    isSearchFeed: true,
    scanArticle: false,
    maxItemAgeDays: 7,
    maxItems: 40,
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

// A stalled build leaves a hole in the archive that ordinary runs never fill.
// Google News search returns a ranked set and each source keeps only its newest
// `maxItems`, so once collection resumes the fresh stories crowd the stalled
// days out of every `when:30d` result and those days stay thin for good: the
// 2026-09-05 to 2026-09-13 outage left 1-to-21 items a day against a 43-to-94
// baseline. BACKFILL_AFTER and BACKFILL_BEFORE (YYYY-MM-DD) swap the rolling
// window for explicit bounds, so a one-off run sweeps only the missing days and
// the per-source cap applies within them. Both must be set; scheduled runs
// leave them unset and nothing changes.
function parseBackfillDate(value) {
  const trimmed = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : "";
}

export function backfillWindowFromEnv(env = process.env) {
  const after = parseBackfillDate(env.BACKFILL_AFTER);
  const before = parseBackfillDate(env.BACKFILL_BEFORE);
  // Half a window is a misconfiguration, not a narrower sweep: honouring one
  // bound alone would silently re-crawl months and blow the per-source cap.
  return after && before && after < before ? { after, before } : null;
}

export function applyBackfillWindow(sources, window) {
  if (!window) {
    return sources;
  }
  const bounded = `after:${window.after} before:${window.before}`;
  return sources.map((source) => {
    if (!source.isSearchFeed || !source.feedUrl) {
      return source;
    }
    let url;
    try {
      url = new URL(source.feedUrl);
    } catch {
      return source;
    }
    if (url.hostname !== "news.google.com") {
      return source;
    }
    const query = url.searchParams.get("q") || "";
    // Replace in place so the rest of the query — site scoping, brand terms —
    // is preserved; a query with no rolling window just gains the bounds.
    url.searchParams.set(
      "q",
      /when:\d+d/.test(query)
        ? query.replace(/when:\d+d/g, bounded)
        : `${query} ${bounded}`.trim(),
    );
    return {
      ...source,
      feedUrl: url.toString(),
      // The rolling minimum is measured from "now", so it would discard the
      // whole window as soon as it is older than maxItemAgeDays. The explicit
      // bounds replace it rather than stacking with it. A day of slack below
      // keeps a timezone difference between Google's date handling and ours
      // from trimming the start of the sweep.
      maxItemAgeDays: undefined,
      minPubDate: `${shiftDay(window.after, -1)}T00:00:00Z`,
      // A backfill asks the same URL a different question, so a cached
      // response is the wrong answer by construction. The freshness window is
      // persisted in crawlState from earlier runs, so capping it by env is not
      // enough to reach these sources: the flag makes the fetcher ignore a
      // still-fresh cache entry. Cooldowns are deliberately left alone, since
      // those mean the origin asked us to back off.
      refetchIgnoringCache: true,
      // Deliberately no maxPubDate. Google's `before:` already bounds the top
      // end server-side, and a maxPubDate in the past makes
      // isSourceWindowClosed skip the source entirely — that guard exists for
      // permanently bounded historical sources, and it silently turned the
      // first backfill run into 33 skips and no fetches. Anything newer than
      // the window that slips through is already in the archive, where the
      // merge dedupes it.
    };
  });
}

function shiftDay(date, days) {
  const shifted = new Date(`${date}T00:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

export function buildSourcesFromEnv(baseSources = DEFAULT_SOURCES) {
  const backfill = backfillWindowFromEnv();
  if (!socialSourcesEnabled()) {
    return applyBackfillWindow([...baseSources], backfill);
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
  // Social sources carry no feedUrl, so the backfill pass leaves them alone.
  return applyBackfillWindow(
    [...baseSources, ...defaultSocialSources, ...configuredPosts, ...configuredPages],
    backfill,
  );
}

// Every hand-curated Vermont outlet in DEFAULT_SOURCES belongs here:
// hasRegionalSignal falls back to this set, so an outlet left out loses its
// regional classification and its small-town health stories get rejected as
// "outside Vermont" whenever the copy names no other Vermont place.
export const VERMONT_SOURCE_NAMES = new Set([
  "Green Mountain Care Board",
  "Vermont Department of Financial Regulation",
  "Department of Vermont Health Access",
  "Vermont Health Connect",
  "Vermont Department of Health",
  "Vermont Agency of Human Services",
  "Vermont Department of Mental Health",
  "Vermont Department of Disabilities, Aging and Independent Living",
  "Vermont Governor's Office",
  "Vermont Attorney General",
  "Vermont Joint Fiscal Office",
  "Office of the Health Care Advocate",
  "Northwestern Medical Center",
  "Northeastern Vermont Regional Hospital",
  "Copley Hospital",
  "Gifford Health Care",
  "Springfield Hospital",
  "Grace Cottage Family Health & Hospital",
  "Brattleboro Memorial Hospital",
  "Brattleboro Retreat",
  "Rutland Regional Medical Center",
  "Southwestern Vermont Medical Center",
  "North Country Hospital",
  "White River Junction VA Medical Center",
  "Dartmouth Health",
  "UVM News",
  "Vermont Medical Society",
  "Vermont Care Partners",
  "Compass Vermont",
  "Vermont Political Observer",
  "Public Assets Institute",
  "Daybreak",
  "WVMT 620 News Talk",
  "WDEV Radio Vermont",
  "ORCA Media",
  "Vermont Chamber of Commerce",
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
  "Becker's ASC Review",
  "Becker's Hospital Review",
  "Becker's Payer Issues",
  "CBS News Health",
  "CNN Health",
  "Fierce Healthcare",
  "Health Payer Specialist",
  "Google News Health Insurance Search",
  // Retired searches stay listed so their archived items keep this rule.
  "Google News Health Trade Search",
  "Google News Kristina Source Search",
  "Google News National Health Policy Search",
  "Google News NYT Health Search",
  "Google News Washington Post Health Search",
  "Google News WSJ Health Search",
  "Google News AP Health Search",
  "Google News Axios Health Search",
  "Google News NBC News Health Search",
  "Google News Becker's Payer Search",
  "Healthcare Dive",
  "KFF Health News",
  "Modern Healthcare",
  "NPR Health",
  "STAT Health News",
  "The Hill Health Care",
]);
