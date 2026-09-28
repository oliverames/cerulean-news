// Regulatory calendar: upcoming Vermont health care regulatory and
// legislative events, so the team sees what is coming before coverage lands.
//
// Five verified public sources feed it. Each parser returns every event it can
// read from its page and throws when the page has none of the structure it
// expects, which is how a redesign shows up as a recorded source failure
// instead of a silently empty calendar. A failed source keeps the previous
// run's events for that source. Output is site/calendar.json for the page and
// site/calendar.ics for subscribers.
import * as cheerio from "cheerio";
import path from "node:path";
import { fetchText, throttleRequest } from "./fetching.js";
import { readText, writeText } from "./fsx.js";

export const CALENDAR_WINDOW_DAYS = 60;
const TIME_ZONE = "America/New_York";
const SITE_HOST = "cerulean.news";
const GMCB = "https://gmcboard.vermont.gov";
const LEGISLATURE = "https://legislature.vermont.gov";
const STATE_CALENDAR_PAGE =
  "https://libraries.vermont.gov/public-meeting-calendar-state-agencies";
const STATE_CALENDAR_ICS =
  "https://outlook.office365.com/owa/calendar/c903965306604c928f5dfd6ec61bfe49@vermont.gov/bb8831f67e5b4e1ea4c1c1d212c596ca11980096348958269749/calendar.ics";

const HTML_ACCEPT = "text/html, application/xhtml+xml, */*";
const JSON_ACCEPT = "application/json, */*";
const ICS_ACCEPT = "text/calendar, text/plain, */*";

const MONTHS = [
  "january", "february", "march", "april", "may", "june", "july",
  "august", "september", "october", "november", "december",
];
const WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];
const MONTH_PATTERN = MONTHS.join("|");
const WEEKDAY_PATTERN = WEEKDAYS.join("|");

// ---------------------------------------------------------------- dates ---

function pad(value) {
  return String(value).padStart(2, "0");
}

// A real calendar date or null. The round trip through Date.UTC rejects
// impossible days such as September 31 rather than rolling them forward.
function isoDate(year, month, day) {
  const value = Date.UTC(year, month - 1, day);
  const check = new Date(value);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

function weekdayOf(iso) {
  const [year, month, day] = iso.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

function addDays(iso, days) {
  const [year, month, day] = iso.split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return isoDate(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

const easternParts = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function easternFields(ms) {
  const fields = {};
  for (const part of easternParts.formatToParts(new Date(ms))) {
    fields[part.type] = Number(part.value);
  }
  return fields;
}

// The Vermont calendar date and clock time of an instant.
function easternDateTime(ms) {
  const f = easternFields(ms);
  return {
    date: `${f.year}-${pad(f.month)}-${pad(f.day)}`,
    time: `${pad(f.hour)}:${pad(f.minute)}`,
  };
}

function easternOffsetMs(ms) {
  const f = easternFields(ms);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// The instant a Vermont wall-clock date and time falls on. Two passes settle
// the offset on the hour a daylight saving change happens.
function easternToUtcMs(date, time) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const first = naive - easternOffsetMs(naive);
  return naive - easternOffsetMs(first);
}

export function todayInVermont(now = new Date()) {
  return easternDateTime(now.valueOf()).date;
}

// Month, day, and optional weekday and year to a date. A written year is
// checked against the weekday when both are given. A missing year is taken
// from the weekday (this year or next, never in the past), and with neither
// the date is left unresolved rather than guessed.
function resolveDate({ month, day, weekday, year }, now) {
  const monthNumber = MONTHS.indexOf(String(month).toLowerCase()) + 1;
  const dayNumber = Number(day);
  if (!monthNumber || !dayNumber) {
    return null;
  }
  const weekdayName = weekday ? String(weekday).toLowerCase() : "";
  if (year) {
    const iso = isoDate(Number(year), monthNumber, dayNumber);
    if (!iso || (weekdayName && weekdayOf(iso) !== weekdayName)) {
      return null;
    }
    return iso;
  }
  if (!weekdayName) {
    return null;
  }
  const today = todayInVermont(now);
  const thisYear = Number(today.slice(0, 4));
  for (const candidateYear of [thisYear, thisYear + 1]) {
    const iso = isoDate(candidateYear, monthNumber, dayNumber);
    if (iso && iso >= today && weekdayOf(iso) === weekdayName) {
      return iso;
    }
  }
  return null;
}

// "9:00", "9:30 am", "4:00 p.m" to 24-hour "HH:MM", or "" when there is no
// real clock time in the text.
function clockTime(hour, minute, meridiem) {
  let h = Number(hour);
  const m = Number(minute || 0);
  const marker = String(meridiem || "").toLowerCase().replace(/[^ap]/g, "");
  if (!Number.isFinite(h) || h < 1 || h > 12 || m > 59 || !marker) {
    return "";
  }
  if (marker === "p" && h < 12) h += 12;
  if (marker === "a" && h === 12) h = 0;
  return `${pad(h)}:${pad(m)}`;
}

// "9:00-11:00am" and "12:15-2:30pm": only the end carries am or pm, so the
// start takes it and steps back twelve hours if that would pass the end.
function clockRange(startHour, startMinute, endHour, endMinute, meridiem) {
  const end = clockTime(endHour, endMinute, meridiem);
  let start = clockTime(startHour, startMinute, meridiem);
  if (!start || !end) {
    return { time: "", endTime: "" };
  }
  if (start > end) {
    const [h, m] = start.split(":").map(Number);
    start = `${pad(h - 12)}:${pad(m)}`;
  }
  return { time: start, endTime: end };
}

// ---------------------------------------------------------------- events ---

function clean(value) {
  return String(value ?? "")
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value, limit) {
  const text = clean(value);
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

// The published event shape. Returns null for anything without a real date and
// a title, so a parser slip cannot put a malformed row on the page.
export function normalizeEvent(raw, source) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw?.date || "") ? raw.date : "";
  const title = truncate(raw?.title, 160);
  if (!date || !title || !isoDate(...date.split("-").map(Number))) {
    return null;
  }
  const event = { date };
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.time || "")) {
    event.time = raw.time;
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(raw.endTime || "") && raw.endTime > raw.time) {
      event.endTime = raw.endTime;
    }
  }
  event.title = title;
  event.body = truncate(raw.body, 400);
  event.source = source.name;
  event.url = /^https?:\/\//i.test(raw.url || "") ? raw.url : source.url;
  event.kind = raw.kind || "meeting";
  return event;
}

function compareEvents(a, b) {
  return (
    a.date.localeCompare(b.date) ||
    (a.time || "").localeCompare(b.time || "") ||
    a.title.localeCompare(b.title)
  );
}

function eventKey(event) {
  return [event.source, event.date, event.time || "", event.title].join("|");
}

// Events from today through the window's last day, sorted and de-duplicated.
export function withinWindow(events, now = new Date(), days = CALENDAR_WINDOW_DAYS) {
  const today = todayInVermont(now);
  const last = addDays(today, days);
  const seen = new Set();
  return events
    .filter((event) => event.date >= today && event.date <= last)
    .filter((event) => {
      const key = eventKey(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(compareEvents);
}

// ------------------------------------------------------ GMCB meetings page ---

const MEETING_LINE = new RegExp(
  `^(${WEEKDAY_PATTERN}),\\s+(${MONTH_PATTERN})\\s+(\\d{1,2}),\\s+(\\d{4})\\s*:\\s*(.+)$`,
  "i",
);

function absoluteUrl(href, base) {
  try {
    const url = new URL(href, base);
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

const CALL_IN_LINE = /call-in|conference id|join the ms teams/i;

// gmcboard.vermont.gov/{year}-meetings lists one bold line per meeting:
// "Wednesday, October 7, 2026: Board meeting", sometimes with a linked
// committee name and a "(2:00pm)" time. "NO BOARD MEETING" lines are skipped.
export function parseGmcbMeetings(html, source) {
  const $ = cheerio.load(html);
  const events = [];
  let seen = 0;
  $("p").each((_, element) => {
    const line = clean($(element).text()).match(MEETING_LINE);
    if (!line) return;
    seen += 1;
    const [, weekday, month, day, year, rest] = line;
    const date = resolveDate({ month, day, weekday, year });
    if (!date || /^no\b|cancel/i.test(rest)) return;

    const timeMatch = rest.match(/\(\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*\)\s*$/i);
    const time = timeMatch ? clockTime(timeMatch[1], timeMatch[2], timeMatch[3]) : "";
    const label = clean(rest.replace(/\([^)]*\)\s*$/, ""))
      .replace(/\bMeeting\b/g, "meeting")
      .replace(/^./, (c) => c.toUpperCase());

    const agenda = [];
    let participation = false;
    for (let next = $(element).next(); next.length && !next.is("hr"); next = next.next()) {
      if (next.is("p") && MEETING_LINE.test(clean(next.text()))) break;
      next.find("li").each((__, li) => {
        const text = clean($(li).text());
        if (CALL_IN_LINE.test(text)) {
          participation = true;
        } else if (text) {
          agenda.push(text);
        }
      });
    }
    let body = agenda.join(" | ");
    if (!body && participation) {
      body = "Public meeting with Microsoft Teams and phone participation. Details are on the meeting page.";
    }
    const link = $(element).find("a[href]").first().attr("href");
    events.push({
      date,
      time,
      title: `GMCB: ${label}`,
      body,
      url: (link && absoluteUrl(link, source.url)) || source.url,
      kind: /\bboard meeting\b/i.test(label) ? "board" : "committee",
    });
  });
  if (seen === 0) {
    throw new Error("No dated meeting lines found; the page layout may have changed");
  }
  return events;
}

// ------------------------------------------- GMCB hospital budget schedule ---

const TIMED_AGENDA_ITEM = /^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?\s*-\s*(.+)$/i;
const DAY_HEADING = new RegExp(
  `^(${WEEKDAY_PATTERN}),\\s+(${MONTH_PATTERN})\\s+(\\d{1,2}),\\s+(\\d{4})$`,
  "i",
);

// gmcboard.vermont.gov/hospital-budget-review-schedule has one heading per
// hearing day and a bulleted agenda under it. Timed bullets ("12:15-2:30pm -
// Hospital Budget Hearing: CVMC") become one event each. A day with no timed
// bullets, such as a deliberation day, becomes one event from its "Agenda:" line.
export function parseGmcbHospitalSchedule(html, source) {
  const $ = cheerio.load(html);
  const events = [];
  let seen = 0;
  $("h3").each((_, heading) => {
    const day = clean($(heading).text()).match(DAY_HEADING);
    if (!day) return;
    seen += 1;
    const [, weekday, month, dayNumber, year] = day;
    const date = resolveDate({ month, day: dayNumber, weekday, year });
    if (!date) return;

    let location = "";
    let agendaTitle = "";
    const timed = [];
    const plain = [];
    for (let next = $(heading).next(); next.length && !next.is("hr, h3"); next = next.next()) {
      const text = clean(next.text());
      if (next.is("p") && /^public location/i.test(text)) {
        location = text.replace(/^public location\W*/i, "").trim();
      } else if (next.is("p") && /^agenda\s*:\s*\S/i.test(text)) {
        agendaTitle = text.replace(/^agenda\s*:\s*/i, "");
      }
      next.children("li").each((__, li) => {
        const own = clean($(li).clone().children("ul").remove().end().text());
        const item = own.match(TIMED_AGENDA_ITEM);
        if (item) {
          timed.push({ ...clockRange(item[1], item[2], item[3], item[4], item[5]), title: item[6] });
        } else if (own) {
          plain.push(own);
        }
      });
    }
    const where = location ? `Public location: ${location}` : "";
    for (const entry of timed) {
      events.push({
        date,
        time: entry.time,
        endTime: entry.endTime,
        title: entry.title,
        body: where,
        url: source.url,
        kind: "hearing",
      });
    }
    if (timed.length === 0 && agendaTitle) {
      events.push({
        date,
        title: agendaTitle,
        body: [where, plain.join(", ")].filter(Boolean).join(". "),
        url: source.url,
        kind: "hearing",
      });
    }
  });
  if (seen === 0) {
    throw new Error("No hearing day headings found; the page layout may have changed");
  }
  return events;
}

// ----------------------------------------------- GMCB public comment page ---

const COMMENT_DEADLINE = new RegExp(
  `\\b(?:accept(?:ed|ing|s)?|open)\\b[^.;]{0,100}?\\b(?:until|through)\\s+(?:(${WEEKDAY_PATTERN}),?\\s+)?(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?`,
  "i",
);
const COMMENT_FORUM = new RegExp(
  `\\b(?:public\\s+(?:comment\\s+)?(?:forum|hearing))\\b[^.;]{0,60}?\\b(?:held|scheduled)\\s+on\\s+(?:(${WEEKDAY_PATTERN}),?\\s+)?(${MONTH_PATTERN})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s*(\\d{4}))?(?:\\s+at\\s+(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?\\s*m\\b)?`,
  "i",
);

// gmcboard.vermont.gov/board/comment keeps one accordion per comment period,
// and the prose names the deadline: "Public comments will be accepted until
// Monday, October 5, 2026." Only two sentence patterns are read, and only when
// the date resolves to a real day (year written, or weekday that fixes it).
export function parseGmcbPublicComment(html, source, now = new Date()) {
  const $ = cheerio.load(html);
  const events = [];
  const blocks = $(".usa-accordion");
  blocks.each((_, block) => {
    const topic = clean($(block).find(".usa-accordion__button").first().text()).replace(/\s*\(closed\)\s*$/i, "");
    const text = clean($(block).find(".usa-accordion__content").first().text());
    for (const sentence of text.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      const deadline = sentence.match(COMMENT_DEADLINE);
      if (deadline) {
        const date = resolveDate(
          { weekday: deadline[1], month: deadline[2], day: deadline[3], year: deadline[4] },
          now,
        );
        if (date) {
          events.push({
            date,
            title: `Public comment closes: ${topic}`,
            body: truncate(sentence, 300),
            url: source.url,
            kind: "deadline",
          });
        }
      }
      const forum = sentence.match(COMMENT_FORUM);
      if (forum) {
        const date = resolveDate(
          { weekday: forum[1], month: forum[2], day: forum[3], year: forum[4] },
          now,
        );
        if (date) {
          events.push({
            date,
            time: clockTime(forum[5], forum[6], forum[7]),
            title: `Public comment forum: ${topic}`,
            body: truncate(sentence, 300),
            url: source.url,
            kind: "hearing",
          });
        }
      }
    }
  });
  if (blocks.length === 0) {
    throw new Error("No comment period sections found; the page layout may have changed");
  }
  return events;
}

// ------------------------------------------------------------ Legislature ---

// Committees a health care team follows. Interim meetings are few, so a broad
// name match keeps the list short without missing the ones that matter.
export const LEGISLATURE_COMMITTEE_PATTERN =
  /health|human services|medicaid|hospital|insurance|fiscal|administrative rules/i;

const LEGISLATURE_DATE = new RegExp(
  `^(${WEEKDAY_PATTERN}),\\s+(${MONTH_PATTERN})\\s+(\\d{1,2}),\\s+(\\d{4})$`,
  "i",
);

// legislature.vermont.gov/committee/loadAllMeetings/{session} is the JSON the
// site's own scheduled-meetings table loads. Rows carry a long date string,
// a start time (or a slot number outside session), and the committee name.
export function parseLegislatureMeetings(jsonText, source) {
  const payload = JSON.parse(jsonText);
  if (!Array.isArray(payload?.data)) {
    throw new Error("Meeting list has no data array; the endpoint may have changed");
  }
  const events = [];
  for (const row of payload.data) {
    const day = clean(row.MeetingDate).match(LEGISLATURE_DATE);
    const name = clean(row.LongName || row.CommName);
    if (!day || !name || !LEGISLATURE_COMMITTEE_PATTERN.test(name)) continue;
    const date = resolveDate({ weekday: day[1], month: day[2], day: day[3], year: day[4] });
    if (!date) continue;

    // Outside session StartTime is a slot number such as 1, which is not a time.
    const clock = clean(row.StartTime).match(/^(\d{1,2}):(\d{2})\s*([AP])M$/i);
    const room = row.RoomNbr
      ? `Room ${clean(row.RoomNbr)}${row.Room ? ` (${clean(row.Room)})` : ""}, ${clean(row.BuildingName) || "State House"}`
      : clean(row.AlternateRoomLocation);
    const url =
      row.Published === "1" || row.Published === 1
        ? `${LEGISLATURE}/committee/agenda/${sessionKeyFor(date)}/${row.CommitteeMeetingID}`
        : `${LEGISLATURE}/committee/detail/${sessionKeyFor(date)}/${row.PermanentID}`;
    events.push({
      date,
      time: clock ? clockTime(clock[1], clock[2], clock[3]) : "",
      title: name,
      body: [room, clean(row.notes)].filter(Boolean).join(". "),
      url,
      kind: "legislature",
    });
  }
  return events;
}

// Vermont sessions are keyed by their even-numbered second year.
function sessionKeyFor(dateOrYear) {
  const year = Number(String(dateOrYear).slice(0, 4));
  return year % 2 === 0 ? year : year + 1;
}

// ------------------------------------------- State agency meetings (ICS) ---

// Meetings on the state's published agency calendar that bear on health care
// finance and policy. The Green Mountain Care Board's own entries are left out
// on purpose: that calendar holds placeholder biweekly board meetings that
// disagree with the Board's page, which is authoritative.
export const STATE_MEETING_INCLUDE =
  /blueprint|payment reform|drug utilization|primary health care|VEHBFA|medicaid|DVHA|hospital|health (?:care|insurance)|AI in medicine|rate review|certificate of need/i;
export const STATE_MEETING_EXCLUDE =
  /GMCB|green mountain care|hospital budget/i;

function unfoldIcs(text) {
  return String(text).replace(/\r?\n[ \t]/g, "");
}

function unescapeIcsText(value) {
  return String(value).replace(/\\([\\;,nN])/g, (_, char) =>
    char === "n" || char === "N" ? "\n" : char,
  );
}

function parseIcsEvents(text) {
  const events = [];
  for (const block of unfoldIcs(text).matchAll(/BEGIN:VEVENT\r?\n([\s\S]*?)END:VEVENT/g)) {
    const props = {};
    for (const line of block[1].split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9-]+)((?:;[^:]*)*):(.*)$/);
      if (match && !(match[1] in props)) {
        props[match[1]] = { params: match[2], value: match[3] };
      }
    }
    events.push(props);
  }
  return events;
}

// A DTSTART or DTEND to a Vermont date and time. Exchange writes
// "TZID=Eastern Standard Time" for Vermont wall-clock times, UTC values end in
// Z, and all-day events use VALUE=DATE. Any other zone is not read.
function icsMoment(prop) {
  if (!prop) return null;
  const value = prop.value.trim();
  const dateOnly = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnly) {
    return { date: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`, time: "" };
  }
  const stamp = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!stamp) return null;
  if (stamp[7]) {
    return easternDateTime(
      Date.UTC(+stamp[1], +stamp[2] - 1, +stamp[3], +stamp[4], +stamp[5], +stamp[6]),
    );
  }
  if (!/TZID=(?:Eastern|America\/New_York)/i.test(prop.params)) return null;
  return { date: `${stamp[1]}-${stamp[2]}-${stamp[3]}`, time: `${stamp[4]}:${stamp[5]}` };
}

function agencyUrl(description, fallback) {
  for (const candidate of description.match(/https?:\/\/[^\s\\]+/g) || []) {
    try {
      const host = new URL(candidate).hostname;
      if (host === "vermont.gov" || host.endsWith(".vermont.gov")) {
        return candidate;
      }
    } catch {
      // Not a URL; try the next candidate.
    }
  }
  return fallback;
}

// The description opens with the agency name and site, then the times, then
// "Meeting Location:" and Teams joining details that stay out of the page.
function agencyBody(description, title) {
  const head = description.split(/Meeting Location:|Additional Details:/i)[0];
  return clean(
    head
      .split("\n")
      .map((line) => line.replace(/https?:\/\/\S+/g, "").trim())
      .filter(
        (line) =>
          line &&
          line.toLowerCase() !== title.toLowerCase() &&
          !/^\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*-\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)$/i.test(line),
      )
      .join(". "),
  );
}

export function parseStateMeetingsIcs(text, source) {
  const vevents = parseIcsEvents(text);
  if (vevents.length === 0) {
    throw new Error("No VEVENT entries found; the calendar may have moved");
  }
  const events = [];
  for (const props of vevents) {
    const title = clean(unescapeIcsText(props.SUMMARY?.value || ""));
    // Recurring series masters are not expanded; only dated instances are read.
    if (!title || props.RRULE || /CANCEL/i.test(props.STATUS?.value || "")) continue;
    if (!STATE_MEETING_INCLUDE.test(title) || STATE_MEETING_EXCLUDE.test(title)) continue;
    const start = icsMoment(props.DTSTART);
    if (!start) continue;
    const end = icsMoment(props.DTEND);
    const description = unescapeIcsText(props.DESCRIPTION?.value || "");
    events.push({
      date: start.date,
      time: start.time,
      endTime: end && end.date === start.date ? end.time : "",
      title,
      body: agencyBody(description, title),
      url: agencyUrl(description, STATE_CALENDAR_PAGE),
      kind: "agency",
    });
  }
  return events;
}

// --------------------------------------------------------------- sources ---

// The verified sources, in fetch order. The Board's per-year pages are named
// for the year in their path, so the list is built from the run date. A page
// for a year that has not started may not exist yet, which is not a failure.
export function calendarSources(now = new Date()) {
  const today = todayInVermont(now);
  const thisYear = Number(today.slice(0, 4));
  const lastYear = Number(addDays(today, CALENDAR_WINDOW_DAYS).slice(0, 4));
  const sources = [];
  for (let year = thisYear; year <= lastYear; year += 1) {
    sources.push({
      id: year === thisYear ? "gmcb-meetings" : `gmcb-meetings-${year}`,
      name: year === thisYear ? "GMCB meetings" : `GMCB meetings ${year}`,
      url: `${GMCB}/${year}-meetings`,
      accept: HTML_ACCEPT,
      parse: parseGmcbMeetings,
      optional: year !== thisYear,
    });
  }
  sources.push(
    {
      id: "gmcb-hospital-budget",
      name: "GMCB hospital budget hearings",
      url: `${GMCB}/hospital-budget-review-schedule`,
      accept: HTML_ACCEPT,
      parse: parseGmcbHospitalSchedule,
    },
    {
      id: "gmcb-public-comment",
      name: "GMCB public comment",
      url: `${GMCB}/board/comment`,
      accept: HTML_ACCEPT,
      parse: (html, source) => parseGmcbPublicComment(html, source, now),
    },
    {
      id: "vt-legislature",
      name: "Vermont Legislature",
      url: `${LEGISLATURE}/committee/loadAllMeetings/${sessionKeyFor(thisYear)}`,
      pageUrl: `${LEGISLATURE}/committee/meetings/${sessionKeyFor(thisYear)}`,
      accept: JSON_ACCEPT,
      parse: parseLegislatureMeetings,
    },
    {
      id: "vt-state-meetings",
      name: "Vermont state agency meetings",
      url: STATE_CALENDAR_ICS,
      pageUrl: STATE_CALENDAR_PAGE,
      accept: ICS_ACCEPT,
      parse: parseStateMeetingsIcs,
    },
  );
  return sources;
}

// Fetches every source once. A failed source is recorded and contributes no
// fresh events; the caller decides what to keep in its place.
export async function collectCalendarEvents({
  now = new Date(),
  sources = calendarSources(now),
  fetchPage = fetchText,
  throttle = throttleRequest,
} = {}) {
  const results = [];
  for (const source of sources) {
    const result = {
      id: source.id,
      name: source.name,
      url: source.pageUrl || source.url,
      ok: true,
      events: [],
    };
    try {
      await throttle(source.url);
      const { text } = await fetchPage(source.url, source.accept, { now });
      const parsed = source.parse(text, { ...source, url: source.pageUrl || source.url });
      result.events = parsed
        .map((raw) => normalizeEvent(raw, { name: source.name, url: source.pageUrl || source.url }))
        .filter(Boolean);
    } catch (error) {
      if (source.optional && error.status === 404) {
        result.note = "Not published yet";
      } else {
        result.ok = false;
        result.error = String(error.message || error).slice(0, 200);
      }
    }
    results.push(result);
  }
  return results;
}

// Fresh events from working sources, plus the previous run's events for any
// source that failed. Returns the public document.
export function buildCalendar(results, { now = new Date(), previous = null } = {}) {
  const previousSources = new Map((previous?.sources || []).map((s) => [s.name, s]));
  const events = [];
  const sources = results.map((result) => {
    const entry = {
      id: result.id,
      name: result.name,
      url: result.url,
      ok: result.ok,
      lastOkAt: result.ok ? now.toISOString() : previousSources.get(result.name)?.lastOkAt || "",
    };
    if (result.error) entry.error = result.error;
    if (result.note) entry.note = result.note;
    if (result.ok) {
      events.push(...result.events);
    } else {
      const kept = (previous?.events || []).filter((event) => event.source === result.name);
      events.push(...kept);
      entry.keptFromPreviousRun = withinWindow(kept, now).length;
    }
    entry.eventCount = withinWindow(
      events.filter((event) => event.source === result.name),
      now,
    ).length;
    return entry;
  });
  const today = todayInVermont(now);
  return {
    version: 1,
    generatedAt: now.toISOString(),
    timeZone: TIME_ZONE,
    windowDays: CALENDAR_WINDOW_DAYS,
    from: today,
    to: addDays(today, CALENDAR_WINDOW_DAYS),
    sources,
    events: withinWindow(events, now),
  };
}

// ------------------------------------------------------------------ ICS ---

// RFC 5545 TEXT values: backslash, semicolon, comma, and newlines.
export function escapeIcsText(value) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// Content lines fold at 75 octets with CRLF and a leading space. Folding by
// code point keeps a multi-byte character from being split across lines.
export function foldIcsLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const lines = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const width = encoder.encode(char).length;
    const limit = lines.length === 0 ? 75 : 74;
    if (size + width > limit) {
      lines.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += width;
  }
  lines.push(current);
  return lines.join("\r\n ");
}

function icsStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

// A short stable hash so an event keeps its UID from run to run and a
// subscriber's calendar updates it in place instead of duplicating it.
function stableId(text) {
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function buildIcs(events, { now = new Date() } = {}) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cerulean News//Vermont health care calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText("Cerulean News: Vermont health care calendar")}`,
    `X-WR-TIMEZONE:${TIME_ZONE}`,
  ];
  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${stableId(eventKey(event))}-${stableId(event.title + event.date)}@${SITE_HOST}`);
    lines.push(`DTSTAMP:${icsStamp(now.valueOf())}`);
    if (event.time) {
      const start = easternToUtcMs(event.date, event.time);
      const end = event.endTime
        ? easternToUtcMs(event.date, event.endTime)
        : start + 60 * 60 * 1000;
      lines.push(`DTSTART:${icsStamp(start)}`);
      lines.push(`DTEND:${icsStamp(end)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${event.date.replaceAll("-", "")}`);
      lines.push(`DTEND;VALUE=DATE:${addDays(event.date, 1).replaceAll("-", "")}`);
    }
    lines.push(`SUMMARY:${escapeIcsText(event.title)}`);
    const description = [event.body, `Source: ${event.source}`].filter(Boolean).join("\n");
    lines.push(`DESCRIPTION:${escapeIcsText(description)}`);
    lines.push(`URL:${event.url}`);
    lines.push(`CATEGORIES:${escapeIcsText(event.kind)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

// ------------------------------------------------------------ the run ---

async function loadPreviousCalendar(jsonPath) {
  try {
    const previous = JSON.parse(await readText(jsonPath));
    return Array.isArray(previous?.events) ? previous : null;
  } catch {
    return null;
  }
}

// Fetches the sources, merges with the previous calendar for any that failed,
// and writes calendar.json and calendar.ics. Never throws: a calendar problem
// must not fail the feed run, so an unexpected error is logged and reported.
export async function generateCalendar({
  now = new Date(),
  outputDir = path.resolve(process.cwd(), "site"),
  fetchPage = fetchText,
  throttle = throttleRequest,
  sources,
} = {}) {
  try {
    const jsonPath = path.join(outputDir, "calendar.json");
    const icsPath = path.join(outputDir, "calendar.ics");
    const previous = await loadPreviousCalendar(jsonPath);
    const results = await collectCalendarEvents({
      now,
      fetchPage,
      throttle,
      ...(sources ? { sources } : {}),
    });
    const calendar = buildCalendar(results, { now, previous });
    await writeText(jsonPath, `${JSON.stringify(calendar, null, 2)}\n`);
    await writeText(icsPath, buildIcs(calendar.events, { now }));
    const failed = calendar.sources.filter((source) => !source.ok);
    console.log(
      `Wrote ${calendar.events.length} calendar events to ${jsonPath}` +
        (failed.length ? ` (${failed.length} source(s) failed: ${failed.map((s) => s.name).join(", ")})` : ""),
    );
    return { calendar, jsonPath, icsPath };
  } catch (error) {
    console.error("Calendar generation failed:", error);
    return { calendar: null, error };
  }
}
