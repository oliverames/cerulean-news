// Spokesperson quote tracking: flags brand coverage that quotes Blue Cross VT
// staff and names who is quoted.
//
// data/spokespeople.json lists staff who have been quoted in press coverage.
// A name on its own is not a quote. It counts only beside attribution
// language ("said", "told", "according to", "spokesperson", or a quote mark),
// so a story that merely mentions the CEO does not credit her with a quote.
// Precision is preferred over recall: a missed quote is cheap, a wrong
// "Quotes: Name" line on a story about someone else is not.
import { readFileSync } from "node:fs";
import { cleanText, parseDate } from "./utils.js";

const SPOKESPEOPLE_PATH =
  process.env.SPOKESPEOPLE_PATH || "data/spokespeople.json";

const VERBS =
  "(?:said|says|told|tells|wrote|writes|stated|states|added|adds|explained|explains|noted|notes|described|describes|emphasized|acknowledged|argued|testified|according to)";
// Words that may sit between an attribution verb and a name: "said Blue Cross
// CFO Ruth Greene", "according to the insurer's chief financial officer".
const TITLE_FILLER =
  "(?:(?:the|a|an|of|and|blue\\s?cross|bcbs\\w*|blue\\s+shield|vermont|vt|insurer['’]?s?|president|ceo|chief|financial|executive|medical|operating|officer|vice|spokes\\w+|dr\\.?)\\s+)";
// A title that ties the name to some other organization: "Mayor Beth
// Roberts", "Sen. Don George".
const OTHER_TITLE_BEFORE =
  /\b(?:mayor|sen\.?|senator|rep\.?|representative|gov\.?|governor|commissioner|treasurer|secretary|judge|sheriff|superintendent|principal|coach|professor|chair(?:man|woman)?|auditor|speaker)\s+$/i;
// The insurer's own name in its many spellings, removed before a clause is
// checked for some other organization.
const BRAND_NAME =
  /\b(?:(?:blue\s?cross|bcbs\w*)(?:\s+(?:and\s+)?blue\s?shield)?|blue\s?shield)(?:\s+of\s+(?:vermont|vt\b\.?))?(?:['’]s)?/gi;
const ABBREVIATIONS = /\b(?:Dr|Mr|Ms|Mrs|St|Sen|Rep|Gov|Vt|Inc|Co|Jr|Sr|U\.S)\.$/;

let cachedList;

function normalizeDate(value, endOfDay) {
  const text = String(value || "").trim();
  if (!text) return null;
  const date = parseDate(/^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`
    : text);
  return date || null;
}

export function normalizeSpokespeople(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => ({
      name: cleanText(entry?.name || ""),
      aliases: (Array.isArray(entry?.aliases) ? entry.aliases : [])
        .map((alias) => cleanText(alias || ""))
        .filter(Boolean),
      title: cleanText(entry?.title || ""),
      since: normalizeDate(entry?.since, false),
      until: normalizeDate(entry?.until, true),
    }))
    .filter((person) => person.name);
}

// Read once. A missing or malformed file means no spokespeople, never a
// failed run.
export function loadSpokespeople(path = SPOKESPEOPLE_PATH) {
  if (path === SPOKESPEOPLE_PATH && cachedList) return cachedList;
  let list = [];
  try {
    list = normalizeSpokespeople(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    list = [];
  }
  if (path === SPOKESPEOPLE_PATH) cachedList = list;
  return list;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameRegExp(name, flags) {
  const body = escapeRegExp(name).replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, flags);
}

// Text after a name, cut at the end of its sentence.
function sentenceTail(text, from, max = 200) {
  const tail = text.slice(from, from + max);
  const boundary = /[.!?]["”’']?\s+(?=[A-Z“"])/g;
  let match;
  while ((match = boundary.exec(tail))) {
    if (!ABBREVIATIONS.test(tail.slice(0, match.index + 1))) {
      return tail.slice(0, match.index + 1);
    }
  }
  return tail;
}

// A quote mark that closes a quotation, not one that opens a term.
function endsWithClosingQuote(before) {
  return /[^\s(\[“"'][”"’]\s*[,—–-]?\s*$/.test(before) ||
    /[—–]\s*$/.test(before);
}

// The clause between a name and its verb ("Beth Roberts, President and CEO of
// Blue Cross, said") is checked for a different organization: "Beth Roberts,
// mayor of Springfield, said" is somebody else with the same name.
function namesOtherOrganization(appositive) {
  const withoutBrand = appositive.replace(BRAND_NAME, " ");
  const pattern = /\b(?:of|at|with|from|for)\s+(?:the\s+)?[A-Z]/g;
  return pattern.test(withoutBrand);
}

function attributedAfter(tail) {
  const direct = new RegExp(`^['’]?\\s+(?:(?:also|later|then|recently)\\s+)?${VERBS}\\b`, "i");
  if (direct.test(tail)) return { attributed: true, appositive: "" };
  const withClause = new RegExp(
    `^,\\s*([^;]{0,160}?),\\s*(?:(?:also|later|then|recently)\\s+)?${VERBS}\\b`,
    "i",
  ).exec(tail);
  if (withClause) return { attributed: true, appositive: withClause[1] };
  const spokes = /^,\s*([^.;,]{0,60}?\bspokes(?:person|woman|man)\b[^.;]{0,80})/i.exec(tail);
  if (spokes) return { attributed: true, appositive: spokes[1] };
  if (/^\s*:\s*["“]/.test(tail)) return { attributed: true, appositive: "" };
  return { attributed: false, appositive: "" };
}

function attributedBefore(before, tail) {
  if (/\bspokes(?:person|woman|man)\s+$/i.test(before)) return true;
  if (/\bspokes(?:person|woman|man)\s+(?:for|at|of)\s+[^,.]{1,60},\s*$/i.test(before)) return true;
  if (new RegExp(`\\baccording to\\s+${TITLE_FILLER}{0,10}$`, "i").test(before)) return true;
  // Inverted attribution after a quotation: "...," said Ruth Greene, CFO.
  const inverted = new RegExp(
    `[”"’',]\\s*(?:said|says|wrote)\\s+${TITLE_FILLER}{0,10}$`,
    "i",
  );
  if (
    inverted.test(before) &&
    !/^\s+(?:was|is|has|had|will|would|could|should|did|does|joined|took|became|and|may)\b/i.test(tail)
  ) {
    return true;
  }
  return endsWithClosingQuote(before);
}

function mentionIsAttributed(text, start, end) {
  const before = text.slice(Math.max(0, start - 90), start);
  if (OTHER_TITLE_BEFORE.test(before)) return false;
  const tail = sentenceTail(text, end);
  const after = attributedAfter(tail);
  if (after.attributed) return !namesOtherOrganization(after.appositive);
  // Inverted forms keep the affiliation after the name, so the same check
  // applies to the clause that follows it.
  if (attributedBefore(before, tail)) {
    return !namesOtherOrganization(tail.slice(0, 100));
  }
  return false;
}

function fullNames(person) {
  return [person.name, ...person.aliases];
}

// Last names of a person's names, longer than three letters so short
// surnames do not match inside ordinary prose.
function surnames(person) {
  return [...new Set(
    fullNames(person)
      .map((name) => name.split(/\s+/).pop())
      .filter((word) => word.length > 3),
  )];
}

function personQuotedInText(text, person) {
  let firstFullStart = -1;
  for (const name of fullNames(person)) {
    const pattern = nameRegExp(name, "giu");
    let match;
    while ((match = pattern.exec(text))) {
      if (firstFullStart === -1 || match.index < firstFullStart) {
        firstFullStart = match.index;
      }
      if (mentionIsAttributed(text, match.index, match.index + match[0].length)) {
        return true;
      }
    }
  }
  if (firstFullStart === -1) return false;
  // "George said" counts only after the full name has appeared in the same
  // text, which rules out a different George.
  for (const surname of surnames(person)) {
    const pattern = nameRegExp(surname, "gu");
    let match;
    while ((match = pattern.exec(text))) {
      if (match.index <= firstFullStart) continue;
      // "Jane Roberts" is not Beth Roberts.
      if (/[A-Z][a-z]+\s+$/.test(text.slice(Math.max(0, match.index - 20), match.index))) {
        continue;
      }
      if (mentionIsAttributed(text, match.index, match.index + match[0].length)) {
        return true;
      }
    }
  }
  return false;
}

function activeAt(person, at) {
  if (!person.since && !person.until) return true;
  // A dated role cannot be checked against an undated story.
  if (!at) return false;
  if (person.since && at < person.since) return false;
  if (person.until && at > person.until) return false;
  return true;
}

// Names quoted in one block of text, in list order. `at` is the story's
// publication date, checked against each person's since and until.
export function detectQuotedSpokespeople(text, options = {}) {
  const people = options.spokespeople || loadSpokespeople();
  const body = cleanText(String(text || ""));
  if (!body) return [];
  const at = options.at ? parseDate(options.at) : null;
  return people
    .filter((person) => activeAt(person, at) && personQuotedInText(body, person))
    .map((person) => person.name);
}

// Names quoted anywhere in an item's snippet, description, or preview text,
// plus names found earlier in the article body during enrichment.
export function quotedSpokespeopleForItem(item, options = {}) {
  const people = options.spokespeople || loadSpokespeople();
  const at = item.pubDate || null;
  const found = new Set();
  for (const field of [item.snippet, item.description, item.previewText]) {
    for (const name of detectQuotedSpokespeople(field, { spokespeople: people, at })) {
      found.add(name);
    }
  }
  const atDate = at ? parseDate(at) : null;
  for (const name of item.bodyQuotedSpokespeople || []) {
    const person = people.find((entry) => entry.name === name);
    if (person && activeAt(person, atDate)) found.add(name);
  }
  return people.filter((person) => found.has(person.name)).map((person) => person.name);
}

// Spread target for carrying enrichment's body-scan result through the article
// cache and the archive. Empty results add no key, so a merge can never
// overwrite a stored list with undefined.
export function bodyQuoteField(names) {
  const list = Array.isArray(names)
    ? names.filter((name) => typeof name === "string" && name)
    : [];
  return list.length > 0 ? { bodyQuotedSpokespeople: list } : {};
}

// Name to title, for the reader's "Quotes: Name (title)" line.
export function spokespersonTitles(names, spokespeople = loadSpokespeople()) {
  const titles = {};
  for (const name of names) {
    const person = spokespeople.find((entry) => entry.name === name);
    if (person?.title) titles[name] = person.title;
  }
  return titles;
}
