import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildCalendar,
  buildIcs,
  calendarSources,
  collectCalendarEvents,
  escapeIcsText,
  foldIcsLine,
  generateCalendar,
  normalizeEvent,
  parseGmcbHospitalSchedule,
  parseGmcbMeetings,
  parseGmcbPublicComment,
  parseLegislatureMeetings,
  parseStateMeetingsIcs,
  todayInVermont,
  withinWindow,
} from "../src/calendar.js";

// Pages saved from the live sources on 2026-09-28. The HTML ones are trimmed
// to the region the parsers read; the ICS keeps eleven of the 334 events.
const fixtureUrl = (name) => new URL(`./fixtures/calendar/${name}`, import.meta.url);
const fixture = (name) => readFile(fixtureUrl(name), "utf8");

const NOW = new Date("2026-09-28T16:00:00Z"); // noon in Vermont
const noThrottle = async () => {};
const src = (name, url) => ({ name, url });

// A fetch stand-in that serves the fixtures by URL and fails the ones named.
async function fixtureFetch({ fail = [] } = {}) {
  const pages = {
    "/2026-meetings": await fixture("gmcb-2026-meetings.html"),
    "/hospital-budget-review-schedule": await fixture("gmcb-hospital-budget-review-schedule.html"),
    "/board/comment": await fixture("gmcb-board-comment.html"),
    "/committee/loadAllMeetings/2026": await fixture("legislature-load-all-meetings.json"),
    "/calendar.ics": await fixture("state-meetings.ics"),
  };
  const calls = [];
  const fetchPage = async (url) => {
    calls.push(url);
    const key = Object.keys(pages).find((suffix) => url.endsWith(suffix));
    if (fail.some((name) => url.includes(name))) {
      throw new Error("HTTP 503 while fetching " + url);
    }
    if (!key) {
      const error = new Error(`HTTP 404 while fetching ${url}`);
      error.status = 404;
      throw error;
    }
    return { text: pages[key], url };
  };
  fetchPage.calls = calls;
  return fetchPage;
}

const tmp = () => mkdtemp(path.join(tmpdir(), "calendar-"));

// ------------------------------------------------------------ normalization ---

test("GMCB meeting lines become board and committee events and skip NO BOARD MEETING", async () => {
  const events = parseGmcbMeetings(await fixture("gmcb-2026-meetings.html"), src("GMCB meetings", "https://gmcboard.vermont.gov/2026-meetings"));
  const summary = events.map((e) => `${e.date} ${e.time || "--"} ${e.kind} ${e.title}`);
  assert.deepEqual(summary, [
    "2026-10-06 -- committee GMCB: Data Governance Council meeting",
    "2026-10-07 -- board GMCB: Board meeting",
    "2026-10-21 -- board GMCB: Board meeting",
    "2026-09-21 14:00 committee GMCB: General Advisory Committee meeting",
  ]);
  // A linked committee name supplies the event link; otherwise the page does.
  assert.equal(events[0].url, "https://gmcboard.vermont.gov/data-and-analytics/data-governance/data-governance-council");
  assert.equal(events[1].url, "https://gmcboard.vermont.gov/2026-meetings");
  // Call-in details and Teams links never reach the published body.
  assert.doesNotMatch(events[1].body, /942|802-828|safelinks/);
});

test("a meeting line whose weekday does not match its date is dropped", () => {
  const html = `<p><strong>Tuesday, October 7, 2026: Board meeting</strong></p>
    <p><strong>Wednesday, October 7, 2026: Board meeting</strong></p>`;
  const events = parseGmcbMeetings(html, src("GMCB meetings", "https://gmcboard.vermont.gov/2026-meetings"));
  assert.equal(events.length, 1);
  assert.equal(events[0].date, "2026-10-07");
});

test("hospital schedule gives a timed event per hearing and one for a deliberation day", async () => {
  const events = parseGmcbHospitalSchedule(
    await fixture("gmcb-hospital-budget-review-schedule.html"),
    src("GMCB hospital budget hearings", "https://gmcboard.vermont.gov/hospital-budget-review-schedule"),
  );
  const aug5 = events.filter((e) => e.date === "2026-08-05").map((e) => `${e.time}-${e.endTime} ${e.title}`);
  assert.deepEqual(aug5, [
    "09:00-11:30 Hospital Budget Hearing: UVM Medical Center (UVMMC)",
    "12:15-14:30 Hospital Budget Hearing: Central Vermont Medical Center (CVMC)",
    "14:45-17:00 Hospital Budget Hearing: Porter Hospital",
  ]);
  const aug7 = events.find((e) => e.date === "2026-08-07");
  assert.match(aug7.body, /^Public location: 89 Main Street/);
  const deliberation = events.find((e) => e.date === "2026-09-02");
  assert.equal(deliberation.title, "Hospital Budget Review Deliberations");
  assert.equal(deliberation.time, undefined);
  assert.ok(events.every((e) => e.kind === "hearing"));
});

test("public comment prose yields deadlines and forums with conservative patterns", async () => {
  const html = await fixture("gmcb-board-comment.html");
  const source = src("GMCB public comment", "https://gmcboard.vermont.gov/board/comment");

  const now = parseGmcbPublicComment(html, source, NOW);
  const upcoming = withinWindow(
    now.map((e) => normalizeEvent(e, source)),
    NOW,
  );
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0].date, "2026-10-05");
  assert.equal(upcoming[0].title, "Public comment closes: AHS 2026 Health Care Workforce Development Strategic Plan");
  assert.equal(upcoming[0].kind, "deadline");
  assert.match(upcoming[0].body, /accepted until Monday, October 5, 2026/);

  // In early July the rate filing deadline and the evening forum were ahead.
  // The forum sentence names no year, so the weekday settles it.
  const july = new Date("2026-07-01T16:00:00Z");
  const early = withinWindow(
    parseGmcbPublicComment(html, source, july).map((e) => normalizeEvent(e, source)),
    july,
  );
  const forum = early.find((e) => e.kind === "hearing");
  assert.equal(forum.date, "2026-07-23");
  assert.equal(forum.time, "16:00");
  assert.ok(early.some((e) => e.date === "2026-07-27" && e.kind === "deadline"));
});

test("a comment date with no year and no matching weekday is not guessed", () => {
  const html = `<div class="usa-accordion"><h4><button class="usa-accordion__button">Topic</button></h4>
    <div class="usa-accordion__content"><p>Comments will be accepted until October 5.</p>
    <p>Comments will be accepted until Friday, October 5.</p></div></div>`;
  const events = parseGmcbPublicComment(html, src("GMCB public comment", "https://x.test/"), NOW);
  assert.deepEqual(events, []);
});

test("legislature rows keep health-related committees and ignore slot numbers as times", async () => {
  const events = parseLegislatureMeetings(
    await fixture("legislature-load-all-meetings.json"),
    src("Vermont Legislature", "https://legislature.vermont.gov/committee/meetings/2026"),
  );
  const summary = events.map((e) => `${e.date} ${e.time || "--"} ${e.title}`);
  assert.deepEqual(summary, [
    "2026-10-09 -- House Committee on Human Services",
    "2026-10-09 -- Senate Committee on Health and Welfare",
    "2026-10-15 10:00 Legislative Committee on Administrative Rules (LCAR)",
  ]);
  assert.equal(events[0].url, "https://legislature.vermont.gov/committee/detail/2026/16");
  assert.equal(events[0].body, "Room 11 (Large Hearing Room), State House");
});

test("a legislature payload without a data array is an error, an empty one is not", () => {
  const source = src("Vermont Legislature", "https://legislature.vermont.gov/");
  assert.throws(() => parseLegislatureMeetings("{}", source), /no data array/);
  assert.deepEqual(parseLegislatureMeetings('{"data":[]}', source), []);
});

test("state agency ICS keeps health finance meetings and drops the rest", async () => {
  const events = parseStateMeetingsIcs(
    await fixture("state-meetings.ics"),
    src("Vermont state agency meetings", "https://libraries.vermont.gov/public-meeting-calendar-state-agencies"),
  );
  const titles = events.map((e) => `${e.date} ${e.time} ${e.title}`);
  assert.deepEqual(titles, [
    "2026-09-10 18:30 Drug Utilization Review Board Meeting",
    "2026-10-07 13:00 Blueprint Payment Implementation Workgroup",
    "2026-10-13 16:00 VSCCPHC Payment Reform Subcommittee",
    "2026-10-20 16:00 Vermont Steering Committee for Comprehensive Primary Health Care",
    "2026-11-19 08:30 Blueprint Executive Committee",
  ]);
  const blueprint = events[1];
  assert.equal(blueprint.endTime, "14:00");
  assert.equal(blueprint.body, "Agency of Human Services Vermont Blueprint for Health");
  assert.equal(blueprint.url, "https://blueprintforhealth.vermont.gov/");
  // No Teams join details, IDs, or passcodes in anything published.
  assert.ok(events.every((e) => !/teams|passcode|meeting id/i.test(e.body + e.url)));
});

test("the state ICS is not trusted for GMCB meetings, recurring series, or other zones", () => {
  const vevent = (extra) => `BEGIN:VEVENT\r\nSUMMARY:Blueprint Payment Implementation Workgroup\r\nDESCRIPTION:x\r\n${extra}\r\nEND:VEVENT\r\n`;
  const wrap = (body) => `BEGIN:VCALENDAR\r\n${body}END:VCALENDAR\r\n`;
  const source = src("State", "https://libraries.vermont.gov/x");
  const run = (extra) => parseStateMeetingsIcs(wrap(vevent(extra)), source);

  assert.equal(run("DTSTART;TZID=Eastern Standard Time:20261007T130000").length, 1);
  assert.equal(run("DTSTART;TZID=Eastern Standard Time:20261007T130000\r\nRRULE:FREQ=WEEKLY").length, 0);
  assert.equal(run("DTSTART;TZID=Eastern Standard Time:20261007T130000\r\nSTATUS:CANCELLED").length, 0);
  assert.equal(run("DTSTART;TZID=Pacific Standard Time:20261007T130000").length, 0);
  // A UTC time converts to Vermont time (14:00Z on Oct 7 is 10:00 EDT).
  assert.equal(run("DTSTART:20261007T140000Z")[0].time, "10:00");
  assert.equal(run("DTSTART;VALUE=DATE:20261007")[0].time, "");
  assert.throws(() => parseStateMeetingsIcs("BEGIN:VCALENDAR\r\nEND:VCALENDAR", source), /No VEVENT/);
});

test("normalizeEvent trims, fills the source link, and rejects impossible dates", () => {
  const source = { name: "Src", url: "https://example.test/page" };
  const event = normalizeEvent(
    { date: "2026-10-07", time: "10:30", endTime: "09:00", title: "  Board \n meeting  ", body: " a   b ", url: "javascript:alert(1)", kind: "board" },
    source,
  );
  assert.deepEqual(event, {
    date: "2026-10-07",
    time: "10:30",
    title: "Board meeting",
    body: "a b",
    source: "Src",
    url: "https://example.test/page",
    kind: "board",
  });
  assert.equal(normalizeEvent({ date: "2026-09-31", title: "x" }, source), null);
  assert.equal(normalizeEvent({ date: "2026-10-07", title: " " }, source), null);
});

// -------------------------------------------------------------- the window ---

test("the window runs from today through day 60 in Vermont time and de-duplicates", () => {
  const make = (date, title = "t", time) => ({ date, time, title, body: "", source: "S", url: "https://x.test/", kind: "board" });
  // 02:00Z on Sept 29 is still the evening of Sept 28 in Vermont.
  const late = new Date("2026-09-29T02:00:00Z");
  assert.equal(todayInVermont(late), "2026-09-28");
  const events = withinWindow(
    [
      make("2026-09-27", "yesterday"),
      make("2026-09-28", "today"),
      make("2026-11-27", "day 60"),
      make("2026-11-28", "day 61"),
      make("2026-10-01", "dup"),
      make("2026-10-01", "dup"),
    ],
    late,
  );
  assert.deepEqual(events.map((e) => e.title), ["today", "dup", "day 60"]);
});

test("events sort by date, then untimed before timed, then title", () => {
  const make = (date, time, title) => ({ date, time, title, body: "", source: "S", url: "https://x.test/", kind: "board" });
  const events = withinWindow(
    [make("2026-10-02", "09:00", "b"), make("2026-10-01", "14:00", "a"), make("2026-10-02", undefined, "z"), make("2026-10-02", "09:00", "a")],
    NOW,
  );
  assert.deepEqual(events.map((e) => `${e.date} ${e.time || "--"} ${e.title}`), [
    "2026-10-01 14:00 a",
    "2026-10-02 -- z",
    "2026-10-02 09:00 a",
    "2026-10-02 09:00 b",
  ]);
});

// ------------------------------------------------------ the run and fallback ---

test("one run reads every source once through the injected fetcher", async () => {
  const fetchPage = await fixtureFetch();
  const results = await collectCalendarEvents({ now: NOW, fetchPage, throttle: noThrottle });
  assert.deepEqual(results.map((r) => [r.id, r.ok]), [
    ["gmcb-meetings", true],
    ["gmcb-hospital-budget", true],
    ["gmcb-public-comment", true],
    ["vt-legislature", true],
    ["vt-state-meetings", true],
  ]);
  assert.equal(fetchPage.calls.length, 5);
  assert.equal(new Set(fetchPage.calls).size, 5);
  assert.ok(fetchPage.calls.every((url) => !/bluecrossvt\.org/.test(url)));
});

test("a failed source is recorded and the others still publish", async () => {
  const fetchPage = await fixtureFetch({ fail: ["loadAllMeetings"] });
  const results = await collectCalendarEvents({ now: NOW, fetchPage, throttle: noThrottle });
  const calendar = buildCalendar(results, { now: NOW });
  const legislature = calendar.sources.find((s) => s.id === "vt-legislature");
  assert.equal(legislature.ok, false);
  assert.match(legislature.error, /503/);
  assert.equal(legislature.eventCount, 0);
  assert.equal(calendar.sources.filter((s) => s.ok).length, 4);
  assert.ok(calendar.events.some((e) => e.source === "GMCB meetings"));
  assert.ok(!calendar.events.some((e) => e.source === "Vermont Legislature"));
});

test("a failed source keeps its events from the previous run, cut to the window", async () => {
  const dir = await tmp();
  const first = await generateCalendar({ now: NOW, outputDir: dir, fetchPage: await fixtureFetch(), throttle: noThrottle });
  const firstLegislature = first.calendar.events.filter((e) => e.source === "Vermont Legislature");
  assert.equal(firstLegislature.length, 3);

  // Two days later the legislature endpoint is down: its events stay.
  const later = new Date("2026-09-30T16:00:00Z");
  const second = await generateCalendar({
    now: later,
    outputDir: dir,
    fetchPage: await fixtureFetch({ fail: ["loadAllMeetings"] }),
    throttle: noThrottle,
  });
  const kept = second.calendar.events.filter((e) => e.source === "Vermont Legislature");
  assert.deepEqual(kept, firstLegislature);
  const entry = second.calendar.sources.find((s) => s.id === "vt-legislature");
  assert.equal(entry.ok, false);
  assert.equal(entry.keptFromPreviousRun, 3);
  assert.equal(entry.lastOkAt, NOW.toISOString());

  // Once past, kept events fall out with the window like any other.
  const muchLater = new Date("2026-10-16T16:00:00Z");
  const third = await generateCalendar({
    now: muchLater,
    outputDir: dir,
    fetchPage: await fixtureFetch({ fail: ["loadAllMeetings"] }),
    throttle: noThrottle,
  });
  assert.deepEqual(third.calendar.events.filter((e) => e.source === "Vermont Legislature"), []);
});

test("when every source fails the previous calendar survives and nothing throws", async () => {
  const dir = await tmp();
  await generateCalendar({ now: NOW, outputDir: dir, fetchPage: await fixtureFetch(), throttle: noThrottle });
  const before = JSON.parse(await readFile(path.join(dir, "calendar.json"), "utf8"));

  const down = async () => {
    throw new Error("network down");
  };
  const result = await generateCalendar({ now: NOW, outputDir: dir, fetchPage: down, throttle: noThrottle });
  assert.equal(result.error, undefined);
  const after = JSON.parse(await readFile(path.join(dir, "calendar.json"), "utf8"));
  assert.deepEqual(after.events, before.events);
  assert.ok(after.sources.every((s) => s.ok === false && /network down/.test(s.error)));
  const ics = await readFile(path.join(dir, "calendar.ics"), "utf8");
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, before.events.length);
});

test("a page that loads but has none of the expected structure counts as a failure", async () => {
  const results = await collectCalendarEvents({
    now: NOW,
    throttle: noThrottle,
    fetchPage: async () => ({ text: "<html><body><p>Site redesigned</p></body></html>" }),
    sources: calendarSources(NOW).filter((s) => s.id.startsWith("gmcb")),
  });
  assert.ok(results.every((r) => r.ok === false && r.error));
});

test("next year's Board page is optional until it is published", async () => {
  const nov = new Date("2026-11-10T16:00:00Z");
  const sources = calendarSources(nov);
  assert.deepEqual(
    sources.filter((s) => s.id.startsWith("gmcb-meetings")).map((s) => s.url),
    ["https://gmcboard.vermont.gov/2026-meetings", "https://gmcboard.vermont.gov/2027-meetings"],
  );
  const results = await collectCalendarEvents({
    now: nov,
    throttle: noThrottle,
    fetchPage: await fixtureFetch(),
    sources,
  });
  const next = results.find((r) => r.id === "gmcb-meetings-2027");
  assert.equal(next.ok, true);
  assert.equal(next.note, "Not published yet");
  assert.equal(calendarSources(NOW).filter((s) => s.id.startsWith("gmcb-meetings")).length, 1);
});

test("calendar.json is the published shape", async () => {
  const dir = await tmp();
  const { calendar } = await generateCalendar({ now: NOW, outputDir: dir, fetchPage: await fixtureFetch(), throttle: noThrottle });
  const written = JSON.parse(await readFile(path.join(dir, "calendar.json"), "utf8"));
  assert.deepEqual(written, calendar);
  assert.equal(written.from, "2026-09-28");
  assert.equal(written.to, "2026-11-27");
  assert.equal(written.windowDays, 60);
  assert.ok(written.events.length >= 10);
  for (const event of written.events) {
    assert.deepEqual(
      Object.keys(event).filter((k) => !["time", "endTime"].includes(k)),
      ["date", "title", "body", "source", "url", "kind"],
    );
    assert.match(event.url, /^https:\/\//);
  }
  assert.deepEqual(written.events.map((e) => e.date), [...written.events.map((e) => e.date)].sort());
});

// ------------------------------------------------------------------- ICS ---

test("ICS text escapes backslash, semicolon, comma, and newlines", () => {
  assert.equal(escapeIcsText("a, b; c\\d\ne\r\nf"), "a\\, b\\; c\\\\d\\ne\\nf");
  assert.equal(escapeIcsText(undefined), "");
});

test("ICS lines fold at 75 octets without splitting a character", () => {
  const long = `SUMMARY:${"café ".repeat(40)}`;
  const folded = foldIcsLine(long);
  const physical = folded.split("\r\n");
  assert.ok(physical.length > 1);
  for (const [index, line] of physical.entries()) {
    assert.ok(new TextEncoder().encode(line).length <= 75, `line ${index}`);
    if (index > 0) assert.ok(line.startsWith(" "));
  }
  // Unfolding restores the original exactly, accented letters intact.
  assert.equal(folded.replace(/\r\n /g, ""), long);
  assert.equal(foldIcsLine("short"), "short");
});

test("buildIcs writes CRLF lines, UTC times, all-day dates, and escaped text", () => {
  const events = [
    { date: "2026-10-07", time: "10:30", endTime: "12:00", title: "Board, hearing; day 1", body: "Line one\nLine two, with; punctuation \\ slash", source: "GMCB meetings", url: "https://gmcboard.vermont.gov/2026-meetings", kind: "board" },
    { date: "2026-11-10", time: "10:30", title: "After the clocks change", body: "", source: "S", url: "https://x.test/a", kind: "agency" },
    { date: "2026-10-05", title: "All day deadline", body: "", source: "S", url: "https://x.test/b", kind: "deadline" },
  ];
  const ics = buildIcs(events, { now: NOW });
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.doesNotMatch(ics.replace(/\r\n/g, ""), /[\r\n]/);
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 3);

  const unfolded = ics.replace(/\r\n /g, "");
  // 10:30 EDT is 14:30Z, and 10:30 EST after the change is 15:30Z.
  assert.match(unfolded, /DTSTART:20261007T143000Z\r\nDTEND:20261007T160000Z/);
  assert.match(unfolded, /DTSTART:20261110T153000Z\r\nDTEND:20261110T163000Z/);
  assert.match(unfolded, /DTSTART;VALUE=DATE:20261005\r\nDTEND;VALUE=DATE:20261006/);
  assert.match(unfolded, /SUMMARY:Board\\, hearing\\; day 1\r\n/);
  assert.match(unfolded, /DESCRIPTION:Line one\\nLine two\\, with\\; punctuation \\\\ slash\\nSource: GMCB meetings\r\n/);
  assert.match(unfolded, /URL:https:\/\/gmcboard\.vermont\.gov\/2026-meetings\r\n/);
  assert.match(unfolded, /DTSTAMP:20260928T160000Z/);
});

test("UIDs are stable between runs and distinct between events", () => {
  const event = (title, date) => ({ date, title, body: "", source: "S", url: "https://x.test/", kind: "board" });
  const uids = (ics) => [...ics.matchAll(/^UID:(.+)$/gm)].map((m) => m[1]);
  const a = uids(buildIcs([event("One", "2026-10-07"), event("Two", "2026-10-07")], { now: NOW }));
  const b = uids(buildIcs([event("One", "2026-10-07"), event("Two", "2026-10-07")], { now: new Date("2026-09-29T16:00:00Z") }));
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, 2);
  assert.ok(a.every((uid) => uid.endsWith("@cerulean.news")));
});
