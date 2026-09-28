// Share of voice: how often press coverage names Blue Cross VT, MVP Health
// Care, and UVM Health each month. Pure functions with no DOM access, so the
// trends page imports them and test/share-of-voice.test.js loads the same file.

// Entities are defined by the matcher's own labels (src/matching.js), which
// the feed publishes as `matchedTerms`. Blue Cross VT is the brand category
// (`category`), which also applies the Vermont corroboration rule that a bare
// "Blue Cross" needs. An item can count for more than one entity.
export const ENTITIES = [
  {
    key: "bcvt",
    label: "Blue Cross VT",
    matches: (item) => item.category === "Blue Cross VT",
  },
  {
    key: "mvp",
    label: "MVP Health Care",
    matches: (item) => termsOf(item).includes("MVP Health Care"),
  },
  {
    key: "uvm",
    label: "UVM Health",
    matches: (item) => termsOf(item).includes("UVM Health"),
  },
];

// Non-brand stories leave the archive after this long (ARCHIVE_MAX_AGE_DAYS
// in src/archive.js), while Blue Cross VT stories are kept indefinitely. Older
// months therefore hold Blue Cross VT coverage but only a remnant of the rest.
export const NON_BRAND_RETENTION_DAYS = 92;

function termsOf(item) {
  return Array.isArray(item.matchedTerms) ? item.matchedTerms : [];
}

function hostOf(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const OWNED_HOST = /(?:^|\.)bluecrossvt\.org$/i;
const ASSOCIATION_HOST = /(?:^|\.)bcbs\.com$/i;
const FACEBOOK_HOST = /(?:^|\.)facebook\.com$/i;
// The same short-video and social hosts src/relevance.js keeps out of the
// coverage set.
const SOCIAL_VIDEO_HOST =
  /(?:^|\.)(?:tiktok|youtube|instagram|threads|x|twitter|reddit)\.[a-z.]+$|^youtu\.be$/i;

// Relevant press coverage: the same exclusions as the trends page's coverage
// set, which are the insurer's own site, the Blues association's pages, and
// social or short-video items.
export function isPressItem(item) {
  if (!item || item.relevant === false) {
    return false;
  }
  if (!/^\d{4}-\d{2}/.test(String(item.pubDate || ""))) {
    return false;
  }
  if (item.sourceType && item.sourceType !== "News") {
    return false;
  }
  const host = hostOf(item.link || item.url || "");
  if (
    OWNED_HOST.test(host) ||
    ASSOCIATION_HOST.test(host) ||
    FACEBOOK_HOST.test(host) ||
    SOCIAL_VIDEO_HOST.test(host)
  ) {
    return false;
  }
  return !/\bfacebook\b/i.test(item.sourceName || "");
}

// Keys of the entities a press item counts for, possibly none or several.
export function entityKeysFor(item) {
  if (!isPressItem(item)) {
    return [];
  }
  return ENTITIES.filter((entity) => entity.matches(item)).map(
    (entity) => entity.key,
  );
}

export function monthKeyOf(iso) {
  return String(iso || "").slice(0, 7);
}

function nextMonthKey(key) {
  let [year, month] = key.split("-").map(Number);
  month += 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

// The first month the archive holds in full for every entity: the first month
// that starts on or after the retention cutoff. Earlier months are "partial".
export function completeFromKey(
  generatedAt,
  retentionDays = NON_BRAND_RETENTION_DAYS,
) {
  const generated = new Date(generatedAt);
  if (Number.isNaN(generated.getTime())) {
    return "";
  }
  const cutoff = new Date(generated.getTime() - retentionDays * 86400000);
  const key = cutoff.toISOString().slice(0, 7);
  const monthStart = Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth(), 1);
  return monthStart >= cutoff.getTime() ? key : nextMonthKey(key);
}

function emptyCounts() {
  return Object.fromEntries(ENTITIES.map((entity) => [entity.key, 0]));
}

function sharesOf(counts, total) {
  return Object.fromEntries(
    ENTITIES.map((entity) => [
      entity.key,
      total > 0 ? counts[entity.key] / total : null,
    ]),
  );
}

// Counts per month, sorted, from the first month with any mention to the last,
// with quiet months in between kept as zero rows so the axis stays linear.
// `total` is the combined mention count, so an item naming two entities adds
// two. `partial` marks months before `completeFrom`.
export function monthlyShareOfVoice(items, { completeFrom = "" } = {}) {
  const byMonth = new Map();
  for (const item of items) {
    const keys = entityKeysFor(item);
    if (keys.length === 0) {
      continue;
    }
    const month = monthKeyOf(item.pubDate);
    if (!byMonth.has(month)) {
      byMonth.set(month, emptyCounts());
    }
    const counts = byMonth.get(month);
    for (const key of keys) {
      counts[key] += 1;
    }
  }

  const sorted = [...byMonth.keys()].sort();
  if (sorted.length === 0) {
    return [];
  }
  const months = [];
  for (
    let key = sorted[0];
    key <= sorted[sorted.length - 1];
    key = nextMonthKey(key)
  ) {
    const counts = byMonth.get(key) || emptyCounts();
    const total = ENTITIES.reduce((sum, entity) => sum + counts[entity.key], 0);
    months.push({
      key,
      counts,
      total,
      shares: sharesOf(counts, total),
      partial: Boolean(completeFrom) && key < completeFrom,
    });
  }
  return months;
}

// Whole-range counts and shares across the given months.
export function totalsOf(months) {
  const counts = emptyCounts();
  for (const month of months) {
    for (const entity of ENTITIES) {
      counts[entity.key] += month.counts[entity.key];
    }
  }
  const total = ENTITIES.reduce((sum, entity) => sum + counts[entity.key], 0);
  return { counts, total, shares: sharesOf(counts, total) };
}
