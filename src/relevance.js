// Deterministic relevance rules and per-item source/access classification.
import { cleanText } from "./utils.js";
import {
  canonicalizeMatchedTerms,
  categorizeTerms,
  CATEGORY_BRAND,
  MENTION_TERMS,
} from "./matching.js";
import {
  BROAD_NATIONAL_SOURCE_NAMES,
  VERMONT_SOURCE_NAMES,
} from "./sources.js";

const BLUECROSSVT_HOST_PATTERN = /^https?:\/\/(?:www\.)?bluecrossvt\.org\//i;
const FACEBOOK_HOST_PATTERN = /^https?:\/\/(?:www\.)?facebook\.com\//i;

const PAYWALL_HOSTS = [
  "burlingtonfreepress.com",
  "modernhealthcare.com",
  "nytimes.com",
  "statnews.com",
  "timesargus.com",
  "vnews.com",
  "washingtonpost.com",
  "wsj.com",
];

const FREE_ACCESS_HOST_PATTERN =
  /(?:abcnews\.go\.com|addisonindependent\.com|apnews\.com|axios\.com|bcbs\.com|beckershospitalreview\.com|beckerspayer\.com|benningtonbanner\.com|bluecrossvt\.org|cbsnews\.com|cnn\.com|compassvermont\.com|fiercehealthcare\.com|healthcaredive\.com|kffhealthnews\.org|mynbc5\.com|mychamplainvalley\.com|npr\.org|reformer\.com|samessenger\.com|sevendaysvt\.com|thehill\.com|uvmhealth\.org|vermontbiz\.com|vermontdailychronicle\.com|vermontpublic\.org|vtcng\.com|vtdigger\.org|wcax\.com)/i;

const REGIONAL_SIGNAL_PATTERN =
  /\b(?:vermont|vt\.?|vermonters?|new\s+england|maine|new\s+hampshire|n\.?h\.?|massachusetts|mass\.?|rhode\s+island|connecticut|burlington|montpelier|rutland|bennington|brattleboro|st\.?\s+albans|stowe|barre|essex|colchester|south\s+burlington|winooski|williston|waterbury|middlebury|newport|st\.?\s+johnsbury|springfield|white\s+river\s+junction|townshend|uvm|dartmouth[\s-]+hitchcock|dartmouth\s+health|dhmc|cvph)\b/i;

const NON_NEW_ENGLAND_STATE_PATTERN =
  /\b(?:alabama|alaska|arizona|arkansas|california|colorado|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maryland|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new\s+jersey|new\s+mexico|new\s+york|north\s+carolina|north\s+dakota|ohio|oklahoma|oregon|pennsylvania|south\s+carolina|south\s+dakota|tennessee|texas|utah|virginia|washington|west\s+virginia|wisconsin|wyoming)\b/i;

// Washington, Georgia, and Florida are also Vermont place names (Washington
// County plus the towns of Washington, Georgia, and Florida). A Vermont
// outlet using them is usually citing those places, not those states, so
// they are stripped before the out-of-region state veto tests this text.
// The veto only gates the VERMONT_SOURCE_NAMES fallback; national outlets
// are still filtered by the broad-national and low-priority rules.
const AMBIGUOUS_VT_PLACE_PATTERN = /\b(?:washington|georgia|florida)\b/gi;

const LOCAL_INCIDENT_PATTERN =
  /\b(?:shooting|shooter|stabbing|homicide|murder|assault|crash|collision|accident|wreck|police|sheriff|trooper|suspect|victims?|injur(?:y|ed|ies)|killed|dead|fatal|airlifted|transported)\b/i;

const ISOLATED_OUTBREAK_PATTERN =
  /\b(?:measles|mumps|whooping\s+cough|pertussis|outbreak|exposure|avian\s+flu|bird\s+flu)\b/i;

const LOW_PRIORITY_REASON =
  "Low-priority health mention outside Vermont or New England.";

const LOW_PRIORITY_TOPIC_LABELS = new Set([
  "Dental care",
  "Health care",
  "Hospital & nurse labor",
  "Hospitals",
  "Public health",
  "Vaccines",
  "Vermont hospitals & providers",
  "Women's health",
]);

const NATIONAL_POLICY_TOPIC_LABELS = new Set([
  "ACA & marketplace",
  "Federal health agencies",
  "GLP-1 & weight-loss drugs",
  "Health care AI",
  "Health records & interoperability",
  "Health insurance",
  "Medicaid",
  "Medical costs & billing",
  "Medicare",
  "Medicare Advantage",
  "Maternity & birthing",
  "PBM",
  "Physician workforce",
  "Prescription drugs & pharmacy",
  "Premiums & rate review",
  "Prior authorization & claims",
  "Private equity in health care",
  "Reproductive health",
  "Senior & long-term care",
  "Telehealth",
  "Universal health care",
]);

const POLICY_SIGNAL_PATTERN =
  /\b(?:340B|aca|affordable\s+care\s+act|AHIP|AMA|CMS|denials?|federal|fraud\s+scrutiny|health\s+coverage|health\s+policy|HHS|hidden\s+fees?|insurers?|insurance|lawmakers?|legislation|medicaid|medicare|payer|pbms?|policy|premiums?|price\s+transparency|prior\s+authorization|regulat(?:e|es|ed|ion|or|ors|ory)|reimbursement|state\s+laws?|transparency|watchdog|WISeR|work\s+requirements?)\b/i;

const REGIONAL_INFRASTRUCTURE_GRANT_PATTERN =
  /\b(?:commission|economic\s+development|grant|grants|funded|funding|infrastructure|municipal|transportation|water|wastewater)\b/i;

const HEALTH_CARE_DELIVERY_SIGNAL_PATTERN =
  /\b(?:bcbs|blue\s+cross|birthing|care\s+access|claim|claims|clinic|coverage|dental|doctor|emergency\s+department|er\s+visits?|health\s+care\s+system|healthcare\s+system|health\s+center|hospital|insurers?|insurance|maternity|medical\s+center|medicaid|medicare|mental\s+health|nurse|patient|patients|pharmacy|physician|premium|primary\s+care|prior\s+authorization|provider|public\s+health|rural\s+health\s+care|surgery|treatment)\b/i;

function isBlueCrossVtOwnedItem(item) {
  return BLUECROSSVT_HOST_PATTERN.test(item.link || "");
}

function itemLink(item) {
  return item.link || item.url || "";
}

function itemHost(item) {
  try {
    return new URL(itemLink(item)).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function itemSourceType(item) {
  const link = itemLink(item);
  if (BLUECROSSVT_HOST_PATTERN.test(link)) {
    return "BlueCrossVT.org";
  }
  if (FACEBOOK_HOST_PATTERN.test(link) || /\bfacebook\b/i.test(item.sourceName || "")) {
    return "Social";
  }
  return "News";
}

// The national association's own site is not Vermont press coverage: its
// pages match only the generic term "Blue Cross" and are things like
// "Transplant Static List". Excluded from sentiment for the same reason
// bluecrossvt.org is - it is not somebody reporting on us.
const BCBSA_HOST_PATTERN = /^https?:\/\/(?:www\.)?bcbs\.com\//i;

export function isAssociationItem(item) {
  return BCBSA_HOST_PATTERN.test(itemLink(item));
}

// Google News search feeds carry the search's name, not the publisher's, so
// 84% of brand items would otherwise report an outlet of "Google News Search".
// The publisher is recoverable from the resolved link host.
const OUTLET_NAMES = new Map([
  ["vtdigger.org", "VTDigger"],
  ["vermontbiz.com", "Vermont Business Magazine"],
  ["vermontpublic.org", "Vermont Public"],
  ["sevendaysvt.com", "Seven Days"],
  ["wcax.com", "WCAX"],
  ["mynbc5.com", "NBC5"],
  ["wptz.com", "WPTZ"],
  ["timesargus.com", "Times Argus"],
  ["rutlandherald.com", "Rutland Herald"],
  ["benningtonbanner.com", "Bennington Banner"],
  ["reformer.com", "Brattleboro Reformer"],
  ["manchesterjournal.com", "Manchester Journal"],
  ["vnews.com", "Valley News"],
  ["samessenger.com", "St. Albans Messenger"],
  ["caledonianrecord.com", "Caledonian Record"],
  ["newportvermontdailyexpress.com", "Newport Daily Express"],
  ["vermontdailychronicle.com", "Vermont Daily Chronicle"],
  ["burlingtonfreepress.com", "Burlington Free Press"],
  ["beckerspayer.com", "Becker's Payer Issues"],
  ["modernhealthcare.com", "Modern Healthcare"],
  ["healthpayerspecialist.com", "Health Payer Specialist"],
  ["wsj.com", "The Wall Street Journal"],
  ["washingtonpost.com", "The Washington Post"],
  ["usnews.com", "US News & World Report"],
  ["compassvermont.com", "Compass Vermont"],
  ["willistonobserver.com", "Williston Observer"],
  ["vermontjournal.com", "Vermont Journal"],
  ["bluecrossvt.org", "BlueCrossVT.org"],
  ["bcbs.com", "BCBS Association"],
]);

export function itemOutletName(item) {
  const host = itemHost(item);
  if (host && OUTLET_NAMES.has(host)) {
    return OUTLET_NAMES.get(host);
  }

  const sourceName = item.sourceName || "";
  // A named outlet feed is authoritative; a search feed is not.
  if (sourceName && !/^Google News\b/i.test(sourceName)) {
    return sourceName;
  }

  if (!host) {
    return sourceName || "Unknown";
  }

  // Fall back to the bare domain, which reads better than the search name.
  return host.replace(/^(?:www|amp|m)\./, "");
}

// Recruitment listings name us but are not somebody reporting on us, and
// they read as bland-positive, so they would drag the average toward neutral
// for no editorial reason. Excluded from sentiment only; they still appear in
// the feeds.
const JOB_BOARD_PATTERN =
  /(?:^|\.)(?:linkedin|snagajob|jobleads|indeed|ziprecruiter|glassdoor|simplyhired|talent|monster|careerbuilder)\.[a-z.]+$/i;

export function isJobListingItem(item) {
  return JOB_BOARD_PATTERN.test(itemHost(item));
}

// itemSourceType only recognises Facebook as social, so short-video hosts
// arrive labelled "News". They are not press and had been scored: two TikTok
// explainers ("How to Find Insurance Policy Number on Insurance Card") carried
// scores on 2026-08-27. Excluded from sentiment only; itemSourceType is left
// alone so these keep their existing place in the reader.
const SOCIAL_VIDEO_HOST_PATTERN =
  /(?:^|\.)(?:tiktok|youtube|youtu\.be|instagram|threads|x|twitter|reddit)\.[a-z.]+$|^youtu\.be$/i;

export function isSocialVideoItem(item) {
  return SOCIAL_VIDEO_HOST_PATTERN.test(itemHost(item));
}

// Sentiment must not be scored for another Blues plan. The brand matcher
// accepts a bare "Blue Cross", which is correct for surfacing a story but too
// loose to score: on 2026-08-27 it had scored a BCBS Massachusetts story
// (gazettenet.com, "Blue Cross, Cooley Dickinson assure Medicare Advantage
// patients") and a generic "new Blue Cross CEO" piece in Modern Healthcare.
// A bare "Blue Cross" match therefore has to be corroborated by Vermont.
//
// Deliberately narrower than REGIONAL_SIGNAL_PATTERN, which counts all of New
// England and so would have let the Massachusetts story through.
const VERMONT_SPECIFIC_BRAND_LABELS = new Set([
  "BCBSVT",
  "BCBS of Vermont",
  "BCBS Vermont",
  "Blue Cross VT",
  "BlueCross Vermont",
  "Blue Cross and Blue Shield of Vermont",
  "Blue Cross of Vermont",
  "Vermont Blue Advantage",
  "Vermont Blues plan",
  "Vermont's largest health insurer",
  "bluecrossvt.org",
]);

const VERMONT_TEXT_PATTERN =
  /\b(?:vermont|vermonters?|vt\.?|vtdigger|montpelier|burlington|rutland|bennington|brattleboro|st\.?\s+albans|st\.?\s+johnsbury|stowe|barre|winooski|williston|colchester|middlebury|waterbury|uvm|green\s+mountain)\b/i;

const VERMONT_OUTLET_HOSTS = new Set([
  "vtdigger.org",
  "vermontbiz.com",
  "vermontpublic.org",
  "sevendaysvt.com",
  "wcax.com",
  "mynbc5.com",
  "mychamplainvalley.com",
  "timesargus.com",
  "rutlandherald.com",
  "benningtonbanner.com",
  "reformer.com",
  "manchesterjournal.com",
  "samessenger.com",
  "caledonianrecord.com",
  "newportvermontdailyexpress.com",
  "vermontdailychronicle.com",
  "burlingtonfreepress.com",
  "vermontjournal.com",
  "willistonobserver.com",
  "vtcng.com",
  "compassvermont.com",
  "vnews.com",
]);

export function namesBlueCrossVermont(item) {
  const matchedTerms = canonicalizeMatchedTerms(item.matchedTerms || []);
  if (matchedTerms.some((label) => VERMONT_SPECIFIC_BRAND_LABELS.has(label))) {
    return true;
  }

  if (VERMONT_OUTLET_HOSTS.has(itemHost(item))) {
    return true;
  }

  const evidence = cleanText(
    [item.title, item.snippet, item.summary, item.sourceName]
      .filter(Boolean)
      .join(" "),
  );
  return VERMONT_TEXT_PATTERN.test(evidence);
}

export function itemAccessLabel(item) {
  const link = itemLink(item);
  if (FACEBOOK_HOST_PATTERN.test(link)) {
    return "May require login";
  }
  if (isLikelyPaywalled(item)) {
    return "Paywall likely";
  }
  const host = itemHost(item);
  if (FREE_ACCESS_HOST_PATTERN.test(host)) {
    return "Free to read";
  }
  return "Access varies";
}

export function isLikelyPaywalled(item) {
  const host = itemHost(item).toLowerCase();
  return PAYWALL_HOSTS.some(
    (paywallHost) => host === paywallHost || host.endsWith(`.${paywallHost}`),
  );
}

function hasNationalPolicySignal(text, matchedTerms = []) {
  return (
    matchedTerms.some((term) => NATIONAL_POLICY_TOPIC_LABELS.has(term)) ||
    POLICY_SIGNAL_PATTERN.test(text)
  );
}

function hasPolicyTextSignal(text) {
  return POLICY_SIGNAL_PATTERN.test(text);
}

function hasRegionalSignal(item, text) {
  if (REGIONAL_SIGNAL_PATTERN.test(text)) {
    return true;
  }

  return (
    VERMONT_SOURCE_NAMES.has(item.sourceName) &&
    !NON_NEW_ENGLAND_STATE_PATTERN.test(
      text.replace(AMBIGUOUS_VT_PLACE_PATTERN, " "),
    )
  );
}

function hasOnlyLowPriorityTopicTerms(matchedTerms = []) {
  const topicTerms = canonicalizeMatchedTerms(matchedTerms).filter(
    (term) => !MENTION_TERMS.some((mentionTerm) => mentionTerm.label === term),
  );

  return (
    topicTerms.length > 0 &&
    topicTerms.every((term) => LOW_PRIORITY_TOPIC_LABELS.has(term))
  );
}

export function applyDeterministicRelevance(item) {
  const matchedTerms = canonicalizeMatchedTerms(item.matchedTerms || []);
  const category = item.category || categorizeTerms(matchedTerms);

  if (isBlueCrossVtOwnedItem(item)) {
    return item.relevant === false ? { ...item, relevant: true } : item;
  }

  if (category === CATEGORY_BRAND) {
    return item;
  }

  const contentEvidence = cleanText(
    [
      item.title,
      item.description,
      item.snippet,
      item.summary,
    ]
      .filter(Boolean)
      .join(" "),
  );
  const evidence = cleanText(
    [contentEvidence, item.sourceName].filter(Boolean).join(" "),
  );
  const hasRegional = hasRegionalSignal(item, evidence);
  const hasPolicy = hasNationalPolicySignal(contentEvidence, matchedTerms);
  const hasPolicyText = hasPolicyTextSignal(contentEvidence);

  if (
    BROAD_NATIONAL_SOURCE_NAMES.has(item.sourceName) &&
    !hasRegional &&
    !hasPolicyText
  ) {
    return {
      ...item,
      relevant: false,
      reason: "Broad national health item without payer, policy, or regional angle.",
    };
  }

  if (!hasRegional && !hasPolicy && LOCAL_INCIDENT_PATTERN.test(evidence)) {
    return {
      ...item,
      relevant: false,
      reason: "Out-of-region incident with incidental health mention.",
    };
  }

  if (!hasRegional && !hasPolicy && ISOLATED_OUTBREAK_PATTERN.test(evidence)) {
    return {
      ...item,
      relevant: false,
      reason: "Out-of-region public health item without payer or policy angle.",
    };
  }

  if (
    hasRegional &&
    !hasPolicy &&
    hasOnlyLowPriorityTopicTerms(matchedTerms) &&
    REGIONAL_INFRASTRUCTURE_GRANT_PATTERN.test(contentEvidence) &&
    !HEALTH_CARE_DELIVERY_SIGNAL_PATTERN.test(contentEvidence)
  ) {
    return {
      ...item,
      relevant: false,
      reason: "Regional funding item with only incidental health care mention.",
    };
  }

  if (!hasRegional && !hasPolicy && hasOnlyLowPriorityTopicTerms(matchedTerms)) {
    return {
      ...item,
      relevant: false,
      reason: LOW_PRIORITY_REASON,
    };
  }

  if (item.relevant === false && item.reason === LOW_PRIORITY_REASON) {
    return {
      ...item,
      relevant: undefined,
      reason: "",
    };
  }

  return item;
}
