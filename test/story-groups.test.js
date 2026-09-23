import assert from "node:assert/strict";
import test from "node:test";
import { groupRelatedStories } from "../src/story-groups.js";
import { buildJsonSummary, buildRss } from "../src/outputs.js";

const hour = 60 * 60 * 1000;
const base = new Date("2026-09-22T12:00:00Z").valueOf();
function story(title, sourceName, hoursLater, extra = {}) {
  const slug = `${sourceName}-${title}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80);
  return { title, sourceName, link: `https://example.test/${slug}`, pubDate: new Date(base + hoursLater * hour),
    matchedTerms: ["ACA & marketplace"], category: "VT Health Care", relevant: true, ...extra };
}

// The live coverage of 2026-09-22 and 23: five outlets, four different headlines.
const aca = [
  story("CMS to cancel ACA coverage for 760K, crack down on brokers in latest anti-fraud push", "Fierce Healthcare", 0,
    { summary: "CMS plans to cancel ACA coverage for over 760,000 individuals and crack down on brokers as part of an anti-fraud initiative." }),
  story("Trump administration to remove 760,000 Affordable Care Act enrollees over fraud claims - Caledonian Record", "Caledonian-Record", 3,
    { summary: "The Trump administration intends to remove 760,000 Affordable Care Act enrollees based on fraud claims." }),
  story("Trump administration to remove 760,000 Affordable Care Act enrollees over fraud claims", "Rutland Herald", 4,
    { summary: "The Trump administration plans to remove 760,000 Affordable Care Act enrollees due to alleged fraud." }),
  story("HHS cancels health insurance of 760,000 individuals enrolled in healthcare.gov plans - npr.org", "Google News", 8,
    { summary: "The U.S. Department of Health and Human Services has canceled health insurance for 760,000 individuals enrolled in Healthcare.gov plans." }),
  story("Trump administration drops 760,000 Americans from ACA coverage, citing fraud", "NPR Health", 20,
    { summary: "The Trump administration is reportedly dropping 760,000 Americans from ACA coverage, citing fraud concerns." }),
];
const unrelated = [
  story("Insurers propose a median ACA rate hike of 15% for 2027", "KFF Health News", 2,
    { summary: "Insurers selling ACA marketplace plans propose a median premium increase of 15% for 2027." }),
  story("Medicare Part D paid $588M for OTC drugs labeled as prescription-only", "STAT", 5,
    { summary: "A federal audit found Medicare Part D paid for over-the-counter drugs." }),
  story("Vermont hospital budgets approved by Green Mountain Care Board", "VTDigger", 6,
    { summary: "The Green Mountain Care Board approved hospital budgets with rate cuts." }),
];

// Term weights come from the whole visible feed, about 1,400 stories in
// production. A background of distinct stories gives the fixtures the same
// footing; in a ten-item corpus every shared word would look common.
const subjects = ["hospital", "clinic", "nurses", "vaccine", "budget", "Medicaid", "pharmacy", "rural", "school", "dental"];
const actions = ["expands", "cuts", "reviews", "delays", "funds", "studies", "opens", "closes", "hires", "audits"];
const background = Array.from({ length: 100 }, (_, index) =>
  story(`${subjects[index % 10]} ${actions[Math.floor(index / 10)]} program ${index}`, `Outlet ${index}`, (index % 60) - 30,
    { summary: `A ${subjects[index % 10]} in county ${index} ${actions[Math.floor(index / 10)]} a local program.` }));

test("reports of one event group together with the newest leading", () => {
  const groups = groupRelatedStories([...aca, ...unrelated, ...background]);
  const group = groups.get(aca[0]);
  assert.ok(group);
  assert.deepEqual(new Set(group.members), new Set(aca));
  assert.equal(group.lead, aca[4]);
  for (const item of unrelated) assert.equal(groups.has(item), false);
});

test("brand coverage, separate letters, and one outlet's series stay separate", () => {
  const brandCopies = [
    story("Blue Cross VT rate request cut by regulators", "VTDigger", 0, { category: "Blue Cross VT" }),
    story("Blue Cross VT rate request cut by regulators", "WCAX", 1, { category: "Blue Cross VT" }),
  ];
  const letters = [
    story("Letter to the Editor: Molly Gray for lieutenant governor", "Brattleboro Reformer", 0),
    story("Letter to the Editor | Howard Dean: In support of Molly Gray", "Bennington Banner", 2),
  ];
  const forums = [
    story("Elections: State Rep Chitt-13 (Burlington) (Two Seats) Candidate Forum - 9/14/2026", "Town Meeting TV", 0),
    story("Elections: State Rep Chittenden-22 (Essex Junction) (Two Seats) Candidate Forum - 9/16/2026", "Town Meeting TV", 30),
  ];
  const groups = groupRelatedStories([...brandCopies, ...letters, ...forums, ...background]);
  for (const item of [...brandCopies, ...letters, ...forums]) assert.equal(groups.has(item), false);
});

test("stories outside the three-day window never group", () => {
  const later = story(aca[2].title, "Times Argus", 24 * 5, { summary: aca[2].summary });
  const groups = groupRelatedStories([aca[2], later, ...background]);
  assert.equal(groups.has(later), false);
});

test("the RSS feed lists grouped coverage once and the JSON Feed marks every member", () => {
  const items = [...aca, ...unrelated, ...background];
  const rss = buildRss(items, { now: new Date(base + 30 * hour), feedUrl: "https://example.test/feed.rss" });
  const leads = new Set(groupRelatedStories(items).values());
  const grouped = [...leads].reduce((total, group) => total + group.members.length, 0);
  assert.equal((rss.match(/<item>/g) || []).length, items.length - grouped + leads.size);
  assert.equal((rss.match(/760,000/g) || []).length > 0, true);
  assert.equal(rss.includes(`<link>${aca[0].link}</link>`), false);
  assert.ok(rss.includes(`<link>${aca[4].link}</link>`));
  assert.match(rss, /<strong>Also covered by:<\/strong> <a href=/);
  for (const item of aca.slice(0, 4)) assert.ok(rss.includes(item.link));

  const json = buildJsonSummary(items, [], new Date(base + 30 * hour));
  assert.equal(json.items.length, items.length);
  const ids = new Set(json.items.filter((item) => aca.some((source) => source.link === item.url)).map((item) => item.storyGroupId));
  assert.deepEqual([...ids], [aca[4].link]);
  assert.equal(json.items.find((item) => item.url === unrelated[0].link).storyGroupId, undefined);
  const audit = buildJsonSummary(items, [], new Date(base + 30 * hour), { includeRejected: true });
  assert.ok(audit.items.every((item) => item.storyGroupId === undefined));
});
