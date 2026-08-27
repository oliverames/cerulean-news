// Brand and topic term matching: which stories mention Blue Cross VT or the
// Vermont health care topics the comms team tracks.
import { cleanText } from "./utils.js";

const OTHER_BLUES_REGIONS = [
  "alabama",
  "alaska",
  "arizona",
  "arkansas",
  "california",
  "colorado",
  "connecticut",
  "delaware",
  "district\\s+of\\s+columbia",
  "florida",
  "georgia",
  "hawaii",
  "idaho",
  "illinois",
  "indiana",
  "iowa",
  "kansas",
  "kentucky",
  "louisiana",
  "maine",
  "maryland",
  "massachusetts",
  "michigan",
  "minnesota",
  "mississippi",
  "missouri",
  "montana",
  "nebraska",
  "nevada",
  "new\\s+hampshire",
  "new\\s+jersey",
  "new\\s+mexico",
  "new\\s+york",
  "north\\s+carolina",
  "north\\s+dakota",
  "ohio",
  "oklahoma",
  "oregon",
  "pennsylvania",
  "puerto\\s+rico",
  "rhode\\s+island",
  "south\\s+carolina",
  "south\\s+dakota",
  "tennessee",
  "texas",
  "utah",
  "virginia",
  "washington",
  "west\\s+virginia",
  "wisconsin",
  "wyoming",
].join("|");

const OTHER_BLUES_PLAN_PATTERN = new RegExp(
  `\\b(?:bcbs|bluecross|blue\\s*cross(?:\\s*(?:(?:and|&|/)\\s*)?blue\\s*shield)?)\\s+(?:of\\s+)?(?:${OTHER_BLUES_REGIONS})\\b`,
  "i",
);

const VERMONT_PLAN_RELATION_PATTERN = new RegExp(
  `\\b(?:the\\s+)?(?:vermont|vt)\\s+(?:plan|affiliate|insurer)\\b|\\b(?:${OTHER_BLUES_REGIONS})\\s+(?:and|&)\\s+(?:vermont|vt)\\b`,
  "i",
);

export function namesOtherBluesPlan(text) {
  return OTHER_BLUES_PLAN_PATTERN.test(cleanText(text));
}

export function namesVermontBluesRelationship(text) {
  return VERMONT_PLAN_RELATION_PATTERN.test(cleanText(text));
}

export const MENTION_TERMS = [
  { label: "BCBSVT", pattern: /\bbcbs[\s-]?vt\b/i },
  { label: "BCBS of Vermont", pattern: /\bbcbs\s+(?:of\s+)?vermont\b|\bbcbs\s+of\s+vt\b/i },
  {
    label: "BCBS Vermont",
    pattern:
      /\bbcbs\b[^.!?\n]{0,240}\b(?:vermont|vt)\b\.?|\b(?:vermont|vt)\b\.?[^.!?\n]{0,240}\bbcbs\b/i,
    reject: OTHER_BLUES_PLAN_PATTERN,
    rejectUnless: VERMONT_PLAN_RELATION_PATTERN,
  },
  { label: "Blue Cross VT", pattern: /\bblue\s*cross\s*(?:vt|vermont)\b/i },
  {
    label: "BlueCross Vermont",
    pattern:
      /\bbluecross\b(?!\s*(?:(?:and|&|\/)\s*)?blue\s*shield\b)[^.!?\n]{0,240}\b(?:vermont|vt)\b\.?|\b(?:vermont|vt)\b\.?[^.!?\n]{0,240}\bbluecross\b(?!\s*(?:(?:and|&|\/)\s*)?blue\s*shield\b)/i,
    reject: OTHER_BLUES_PLAN_PATTERN,
    rejectUnless: VERMONT_PLAN_RELATION_PATTERN,
  },
  {
    label: "Blue Cross and Blue Shield of Vermont",
    pattern:
      /\bblue\s*cross\s*(?:(?:and|&|\/)\s*)?blue\s*shield\b[^.!?\n]{0,240}\b(?:vermont|vt)\b\.?|\b(?:vermont|vt)\b\.?[^.!?\n]{0,240}\bblue\s*cross\s*(?:(?:and|&|\/)\s*)?blue\s*shield\b/i,
    reject: OTHER_BLUES_PLAN_PATTERN,
    rejectUnless: VERMONT_PLAN_RELATION_PATTERN,
  },
  {
    label: "Blue Cross of Vermont",
    pattern: /\bblue\s*cross\s+of\s+(?:vermont|vt)\b/i,
  },
  {
    label: "Vermont Blue Advantage",
    pattern: /\bvermont\s+blue\s+advantage\b/i,
  },
  {
    label: "Vermont Blues plan",
    pattern: /\bvermont\s+blues?\s+plans?\b/i,
  },
  {
    label: "Vermont's largest health insurer",
    pattern: /\bvermont[’']s\s+largest\s+(?:private\s+)?(?:health\s+)?insurer\b/i,
  },
  {
    label: "Blue Cross",
    pattern:
      /\bblue\s+cross\b(?!\s*(?:vt\b|vermont\b|of\s+(?:vt|vermont)\b|(?:and|&|\/)?\s*blue\s*shield))/i,
  },
  { label: "bluecrossvt.org", pattern: /\bbluecrossvt\.org\b/i },
  // BCBSVT sponsorship properties — community items the comms team tracks
  { label: "Girls on the Run", pattern: /\bgirls\s+on\s+the\s+run\b/i },
  { label: "Mountain Days", pattern: /\bmountain\s+days\b/i },
  { label: "Walk@Lunch", pattern: /\bwalk\s*@\s*lunch\b/i },
];

// Vermont healthcare topic terms. These mirror the broader stories the
// communications team pulls manually: regulators, hospitals, legislature
// health bills, coverage programs, and recurring health topics. They are
// matched against feed title + description only (not full article text),
// because nearly every article mentions "health care" somewhere in its body.
// Transport/treatment idiom from crime and accident briefs. Covers both
// generic ("taken to the hospital") and named facilities ("airlifted to
// Dartmouth-Hitchcock Medical Center"). Stripped from text before testing
// hospital-related terms so accident stories don't read as health news.
const TRANSPORT_IDIOM =
  /\b(?:taken|airlifted|transported|rushed|flown|brought|treated|died|sent|sends?)\b(?:\s+(?!(?:to|at)\b)[\w'’.-]+){0,5}\s+(?:to|at)\s+(?:(?:a|the|an)\s+)?(?:(?:area|local|nearby)\s+)?(?:[\w'’.-]+\s+){0,5}?(?:hospitals?\b|medical\s+cent(?:er|re)\b)/gi;

export const TOPIC_TERMS = [
  // Regulators, agencies, and associations
  {
    label: "Green Mountain Care Board",
    pattern: /\bgreen\s+mountain\s+care\s+board\b|\bGMCB\b/i,
  },
  {
    label: "Vermont health agencies",
    pattern:
      /\bdepartment\s+of\s+vermont\s+health\s+access\b|\bDVHA\b|\bvermont\s+department\s+of\s+health\b|\bagency\s+of\s+human\s+services\b|\bhealth\s+commissioner\b|\bdepartment\s+of\s+financial\s+regulation\b/i,
  },
  {
    label: "Vermont Health Connect",
    pattern: /\bvermont\s+health\s+connect\b/i,
  },
  { label: "OneCare Vermont", pattern: /\bonecare\b/i },
  {
    label: "VAHHS",
    pattern: /\bVAHHS\b|\bvermont\s+association\s+of\s+hospitals\b/i,
  },
  // Payers and coverage programs
  { label: "MVP Health Care", pattern: /\bmvp\s+health\b/i },
  { label: "Medicare Advantage", pattern: /\bmedicare\s+advantage\b/i },
  { label: "Medicare", pattern: /\bmedicare\b/i },
  { label: "Medicaid", pattern: /\bmedicaid\b/i },
  {
    label: "Health insurance",
    pattern:
      /\bhealth\s+insur\w*|\binsurers?\b|\bhealth\s+plans?\b|\bhealth\s+coverage\b|\buninsured\b/i,
  },
  {
    label: "ACA & marketplace",
    pattern: /\baffordable\s+care\s+act\b|\bobamacare\b|\bACA\b/i,
  },
  // Providers
  {
    label: "UVM Health",
    pattern:
      /\buvm\s+(?:health|medical\s+center|cancer\s+center)\b|\buvmmc\b|\buvmhn?\b|\buniversity\s+of\s+vermont\s+(?:health|medical)\b/i,
  },
  {
    label: "Vermont hospitals & providers",
    pattern:
      /\bbrattleboro\s+(?:memorial|retreat|hospital)\b|\brutland\s+regional\b|\bcopley\s+hospital\b|\bgifford\s+(?:medical|health)\b|\bporter\s+(?:medical|hospital)\b|\bgrace\s+cottage\b|\bspringfield\s+hospital\b|\bnorth\s+country\s+hospital\b|\bnortheastern\s+vermont\s+regional\b|\bNVRH\b|\bnorthwestern\s+medical\s+center\b|\bcentral\s+vermont\s+medical\s+center\b|\bCVMC\b|\bmt\.?\s+ascutney\b|\bsouthwestern\s+vermont\s+(?:medical|health)\b|\bSVMC\b|\bchamplain\s+valley\s+physicians\b|\bCVPH\b|\balice\s+hyde\b|\bdartmouth[\s-]+(?:hitchcock|health)\b|\bhoward\s+center\b|\bnortheast\s+kingdom\s+human\s+services\b|\blamoille\s+health\b|\bbattenkill\s+valley\b/i,
    strip: TRANSPORT_IDIOM,
  },
  {
    label: "Hospitals",
    pattern: /\bhospitals?\b/i,
    // Crime/accident briefs ("taken to the hospital", "airlifted to
    // Dartmouth-Hitchcock Medical Center", "treated at a nearby hospital")
    // are not healthcare coverage; strip the transport/treatment idiom —
    // including named facilities — before testing.
    strip: TRANSPORT_IDIOM,
  },
  // Topics
  { label: "Health care", pattern: /\bhealth\s*care\b/i },
  {
    label: "Primary care",
    pattern: /\bprimary\s+care\b|\bconcierge\s+(?:medicine|care|doctor)/i,
  },
  {
    label: "Mental health",
    pattern: /\bmental\s+health\b|\bbehavioral\s+health\b|\bpsychiatric\b/i,
  },
  {
    label: "Prescription drugs & pharmacy",
    pattern:
      /\bprescription\s+drug\w*|\bpharmac(?:y|ies|ist)\b|\bPBM\b|\bpharmacy\s+benefit\w*|\bArrayRx\b|\bdrug\s+(?:prices?|costs?|discounts?|shortages?)\b|\bmedicine\s+shortages?\b|\bshortages?\s+of\s+(?:many\s+)?medicines?\b/i,
  },
  {
    label: "Prior authorization & claims",
    pattern:
      /\bprior\s+authorization\b|\bclaim\s+denial\w*|\bcoverage\s+denial\w*|\bdenied\s+claims?\b/i,
  },
  {
    label: "Premiums & rate review",
    pattern:
      /\b(?:health\s+insurance|insurance|health\s+plan|coverage)\s+premiums?\b|\bpremiums?\s+(?:for|on)\s+(?:health\s+insurance|insurance|health\s+plans?|coverage)\b|\b(?:rate|premium)\s+(?:filing|review|increase|decrease|request)s?\b/i,
  },
  { label: "Vaccines", pattern: /\bvaccin\w*|\bimmuniz\w*/i },
  {
    label: "Hospital & nurse labor",
    pattern:
      /\b(?:nurses?|hospital|medical\s+center)\b[^.!?]{0,60}\b(?:union\w*|strike\w*|picket\w*|contract)\b|\b(?:union|strike)\w*\b[^.!?]{0,60}\b(?:nurses?|hospital|medical\s+center)\b/i,
  },
  {
    label: "Rural health",
    pattern: /\brural\s+(?:health|hospital|medical)\w*|\bcritical\s+access\b/i,
  },
  {
    label: "Universal health care",
    pattern:
      /\buniversal\s+(?:health|primary)\s*care\b|\bsingle[-\s]payer\b|\ball-payer\b/i,
  },
  {
    label: "Medical costs & billing",
    pattern:
      /\bmedical\s+(?:debt|bills?|billing)\b|\bbilling\s+(?:abuse|disputes?)\b|\bsurprise\s+bill\w*|\bno\s+surprises\s+act\b|\bhealth\s+(?:care\s+)?costs?\b|\bhealth\s+care\s+affordability\b|\bhospital\s+pric\w*|\breference[-\s]based\s+pricing\b|\bhealth\s+care\s+spending\b/i,
  },
  { label: "Telehealth", pattern: /\btelehealth\b|\btelemedicine\b/i },
  { label: "Public health", pattern: /\bpublic\s+health\b/i },
  {
    label: "Maternity & birthing",
    pattern: /\bbirthing\b|\bmaternity\b|\bmidwi(?:fe|ves|fery)\b|\bOB-?\s?GYNs?\b/i,
  },
  {
    label: "Opioids & addiction",
    pattern:
      /\bopioids?\b|\boverdoses?\b|\bsubstance\s+(?:ab)?use\b|\baddiction\b/i,
  },
  {
    label: "GLP-1 & weight-loss drugs",
    pattern:
      /\bGLP-?1s?\b|\bozempic\b|\bwegovy\b|\bzepbound\b|\bweight[-\s]loss\s+drugs?\b/i,
  },
  {
    label: "Reproductive health",
    pattern:
      /\babortion\w*|\breproductive\s+(?:health|care)\b|\bgender-affirming\b/i,
  },
  {
    label: "Women's health",
    pattern: /\bmenopause\b|\bwomen'?s\s+health\b/i,
  },
  {
    label: "Federal health agencies",
    pattern: /\bfederal\s+health\s+agenc(?:y|ies)\b/i,
  },
  {
    label: "Health care AI",
    pattern:
      /\b(?:clinical|medical|health\s+care|healthcare|medical-billing)\s+AI\b|\bAI\s+(?:doctors?|in\s+(?:health\s+care|healthcare|medicine))\b|\bWISeR\b/i,
  },
  {
    label: "Health records & interoperability",
    pattern:
      /\b(?:digital|electronic)\s+health\s+records?\b|\bEHRs?\b|\binteroperability\b/i,
  },
  {
    label: "Physician workforce",
    pattern:
      /\bphysicians?\b|\bdoctor\s+shortage\b|\bnurse\s+practitioners?\b|\bphysician\s+assistants?\b|\bscope\s+of\s+practice\b|\bmedical\s+residen\w*/i,
  },
  {
    label: "Private equity in health care",
    pattern: /\bprivate\s+equity\b/i,
  },
  {
    label: "Senior & long-term care",
    pattern:
      /\bnursing\s+homes?\b|\blong-?term\s+care\b|\bhome\s+health\b|\bassisted\s+living\b|\bhospice\b|\bsenior\s+(?:care|health)\b/i,
  },
  { label: "Dental care", pattern: /\bdental\s+clinics?\b|\bdentists?\b/i },
  {
    label: "Certificate of need",
    pattern: /\bcertificate\s+of\s+need\b/i,
  },
];

export const CATEGORY_BRAND = "Blue Cross VT";
export const CATEGORY_TOPIC = "VT Health Care";

const TERM_LABEL_ALIASES = new Map([
  ["BCBS Vermont", "BCBSVT"],
  ["Blue Cross Vermont", "Blue Cross VT"],
  ["BlueCross Vermont", "Blue Cross VT"],
  ["BlueCrossVT", "Blue Cross VT"],
  ["Blue CrossVT", "Blue Cross VT"],
  ["BlueCross VT", "Blue Cross VT"],
  ["Blue Cross Blue Shield of Vermont", "Blue Cross and Blue Shield of Vermont"],
  ["BlueCross BlueShield of Vermont", "Blue Cross and Blue Shield of Vermont"],
  ["Blue Cross/Blue Shield of Vermont", "Blue Cross and Blue Shield of Vermont"],
  ["BlueCross and BlueShield of Vermont", "Blue Cross and Blue Shield of Vermont"],
  ["BlueCross and BlueShield of VT", "Blue Cross and Blue Shield of Vermont"],
  ["BlueCross & BlueShield of Vermont", "Blue Cross and Blue Shield of Vermont"],
  ["BlueCross & BlueShield of VT", "Blue Cross and Blue Shield of Vermont"],
]);

function acceptedTermMatch(term, subject) {
  term.pattern.lastIndex = 0;
  const match = term.pattern.exec(subject);
  if (!match) {
    return null;
  }
  if (term.reject) {
    term.reject.lastIndex = 0;
    const rejectionContext = subject.slice(
      match.index,
      match.index + match[0].length + 40,
    );
    if (term.reject.test(rejectionContext)) {
      if (term.rejectUnless) {
        term.rejectUnless.lastIndex = 0;
      }
      if (!term.rejectUnless || !term.rejectUnless.test(rejectionContext)) {
        return null;
      }
    }
  }
  return match;
}

export function findMentionTerms(text, terms = MENTION_TERMS) {
  const haystack = cleanText(text);
  const matches = [];

  for (const term of terms) {
    const subject = term.strip ? haystack.replace(term.strip, " ") : haystack;
    if (acceptedTermMatch(term, subject)) {
      matches.push(term.label);
    }
  }

  return canonicalizeMatchedTerms(matches);
}

export function canonicalizeMatchedTerms(matchedTerms = []) {
  return [
    ...new Set(
      matchedTerms
        .map((label) => TERM_LABEL_ALIASES.get(label) || label)
        .filter(Boolean),
    ),
  ];
}

export function categorizeTerms(matchedTerms) {
  const brandLabels = new Set(MENTION_TERMS.map((term) => term.label));
  const hasBrand = canonicalizeMatchedTerms(matchedTerms).some((label) =>
    brandLabels.has(label),
  );
  return hasBrand ? CATEGORY_BRAND : CATEGORY_TOPIC;
}

function findFirstMentionIndex(text, terms = MENTION_TERMS) {
  let bestIndex = -1;

  for (const term of terms) {
    // Blank stripped regions with same-length whitespace (rather than the
    // single space findMentionTerms uses) so the match index below still
    // points into the caller's original text. Without this, snippets could
    // center on a transport-idiom mention the matcher deliberately ignored.
    const subject = term.strip
      ? text.replace(term.strip, (stripped) => " ".repeat(stripped.length))
      : text;
    const match = acceptedTermMatch(term, subject);
    if (!match) {
      continue;
    }

    if (bestIndex === -1 || match.index < bestIndex) {
      bestIndex = match.index;
    }
  }

  return bestIndex;
}

export function buildSnippet(text, terms = MENTION_TERMS) {
  const cleaned = cleanText(text);
  if (!cleaned) {
    return "";
  }

  const index = findFirstMentionIndex(cleaned, terms);
  if (index === -1) {
    return cleaned.slice(0, 320);
  }

  const start = Math.max(0, index - 180);
  const end = Math.min(cleaned.length, index + 260);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < cleaned.length ? " ..." : "";

  return `${prefix}${cleaned.slice(start, end)}${suffix}`;
}
