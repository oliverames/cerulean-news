import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildJsonSummary, buildRss, siteHomeUrl } from "../src/outputs.js";

const SITE = "https://cerulean.news";

// Cloudflare Pages 308s /index.html to / and /trends.html to /trends, so these
// are the only URLs that should be indexed, linked, and listed.
const PAGES = [
  { file: "../site/index.html", url: `${SITE}/` },
  { file: "../site/trends.html", url: `${SITE}/trends` },
];

function readSite(relative) {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

function metaContent(html, attr, name) {
  const pattern = new RegExp(`<meta ${attr}="${name}" content="([^"]*)">`);
  return html.match(pattern)?.[1];
}

test("each page declares its extensionless canonical URL in every tag", async () => {
  for (const { file, url } of PAGES) {
    const html = await readSite(file);
    assert.equal((html.match(/<link rel="canonical"/g) || []).length, 1, file);
    assert.match(html, new RegExp(`<link rel="canonical" href="${url}">`), file);
    assert.equal(metaContent(html, "property", "og:url"), url, file);

    const ld = JSON.parse(
      html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1],
    );
    assert.equal(ld["@context"], "https://schema.org", file);
    assert.equal(ld.url, url, file);
  }
});

test("each page has a unique title and a description that fits a result snippet", async () => {
  const titles = new Set();
  for (const { file } of PAGES) {
    const html = await readSite(file);
    const title = html.match(/<title>([^<]+)<\/title>/)[1];
    assert.ok(title.length <= 65, `${file} title is ${title.length} chars`);
    assert.ok(!titles.has(title), `${file} repeats a title`);
    titles.add(title);

    const description = metaContent(html, "name", "description");
    assert.ok(description, `${file} needs a meta description`);
    assert.ok(description.length <= 165, `${file} description is ${description.length} chars`);
    assert.match(description, /not affiliated/i, `${file} description keeps the disclaimer`);
    assert.equal(metaContent(html, "property", "og:description"), description, file);
    assert.equal(metaContent(html, "name", "twitter:description"), description, file);
    assert.ok(metaContent(html, "property", "og:image:alt"), `${file} needs og:image:alt`);
  }
});

test("each page advertises both feeds and exactly one h1", async () => {
  for (const { file } of PAGES) {
    const html = await readSite(file);
    assert.match(html, /<link rel="alternate" type="application\/rss\+xml"[^>]*href="feed\.rss">/, file);
    assert.match(html, /<link rel="alternate" type="application\/feed\+json"[^>]*href="feed\.json">/, file);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, file);
  }
});

test("internal links point at canonical URLs, not redirecting .html paths", async () => {
  for (const { file } of PAGES) {
    const html = await readSite(file);
    assert.doesNotMatch(html, /href="(?:\.\/)?(?:index|trends)\.html"/, file);
  }
});

test("WebSite structured data names the site, and trends links back to it", async () => {
  const home = JSON.parse(
    (await readSite("../site/index.html")).match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    )[1],
  );
  assert.equal(home["@type"], "WebSite");
  assert.equal(home.name, "Cerulean News");
  assert.equal(home["@id"], `${SITE}/#website`);

  const trends = JSON.parse(
    (await readSite("../site/trends.html")).match(
      /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
    )[1],
  );
  assert.equal(trends.isPartOf["@id"], home["@id"]);
});

test("sitemap lists every indexable page and robots.txt points at it", async () => {
  const sitemap = await readSite("../site/sitemap.xml");
  assert.match(sitemap, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(sitemap, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(locs, PAGES.map((page) => page.url));

  const robots = await readSite("../site/robots.txt");
  assert.match(robots, /^User-agent: \*$/m);
  assert.doesNotMatch(robots, /^Disallow: \/\s*$/m);
  assert.match(robots, new RegExp(`^Sitemap: ${SITE}/sitemap\\.xml$`, "m"));
});

test("a top-level 404 page exists so unknown paths are real 404s", async () => {
  // Without site/404.html, Cloudflare Pages treats the site as a single-page
  // app and returns the homepage with a 200 for every unknown path.
  const notFound = await readSite("../site/404.html");
  assert.match(notFound, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(notFound, /<link rel="canonical"/);
  assert.match(notFound, /href="\/"/);
});

test("_headers keeps pages.dev copies and the audit archive out of search", async () => {
  const headers = await readSite("../site/_headers");
  assert.match(headers, /^https:\/\/:project\.pages\.dev\/\*\n\s+X-Robots-Tag: noindex$/m);
  assert.match(headers, /^https:\/\/:version\.:project\.pages\.dev\/\*\n\s+X-Robots-Tag: noindex$/m);
  assert.match(headers, /^\/feed-audit\.json\n\s+X-Robots-Tag: noindex$/m);
  // A bare /* noindex rule would deindex the custom domain too.
  assert.doesNotMatch(headers, /^\/\*\n\s+X-Robots-Tag: noindex/m);
});

test("siteHomeUrl returns the canonical homepage with one trailing slash", () => {
  assert.equal(siteHomeUrl("https://cerulean.news"), "https://cerulean.news/");
  assert.equal(siteHomeUrl("https://cerulean.news/"), "https://cerulean.news/");
  assert.equal(siteHomeUrl(" https://cerulean.news// "), "https://cerulean.news/");
  assert.equal(siteHomeUrl(""), "");
});

test("feeds link to the canonical homepage and carry artwork", () => {
  const now = new Date("2026-09-24T12:00:00Z");
  const rss = buildRss([], { now, siteUrl: SITE, feedUrl: `${SITE}/feed.rss` });
  assert.match(rss, /<link>https:\/\/cerulean\.news\/<\/link>/);
  assert.match(rss, /<title>Cerulean News<\/title>/);
  assert.match(rss, /<language>en-us<\/language>/);

  const json = buildJsonSummary([], [], now, {
    siteUrl: SITE,
    feedUrl: `${SITE}/feed.json`,
  });
  assert.equal(json.title, "Cerulean News");
  assert.equal(json.home_page_url, `${SITE}/`);
  assert.equal(json.feed_url, `${SITE}/feed.json`);
  assert.equal(json.icon, `${SITE}/icon-512.png`);
  assert.equal(json.favicon, `${SITE}/favicon-32x32.png`);
  assert.equal(json.language, "en-US");

  const bare = buildJsonSummary([], [], now, { siteUrl: "", feedUrl: "" });
  assert.equal(bare.home_page_url, "");
  assert.equal(bare.icon, undefined);
  assert.equal(bare.favicon, undefined);
});

test("generator output uses the current brand, not the retired one", async () => {
  for (const file of ["../src/outputs.js", "../site/index.html", "../site/trends.html", "../site/site.webmanifest"]) {
    const text = await readSite(file);
    assert.doesNotMatch(text, /Blue News/, file);
  }
});
