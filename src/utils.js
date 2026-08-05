// Shared text, date, and concurrency helpers used across the generator.

// Accepts 0, for settings where zero is a meaningful "off" value (e.g.
// RSS_DOMAIN_DELAY_MS=0 disables the politeness delay for local runs).
export function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function parsePositiveInteger(value, fallback) {
  const parsed = parseNonNegativeInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

export function cleanText(value = "") {
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PREVIEW_PROMOTION_PATTERN =
  /^(?:get (?:our|your) (?:daily|weekly) dose\b|good morning, everyone\b)/i;

export function normalizePreviewText(value = "", maxCharacters = 600) {
  const cleaned = cleanText(value);
  if (PREVIEW_PROMOTION_PATTERN.test(cleaned)) {
    return "";
  }
  if (cleaned.length <= maxCharacters) {
    return cleaned;
  }

  const room = Math.max(0, maxCharacters - 3);
  const candidate = cleaned.slice(0, room).trimEnd();
  const lastSpace = candidate.lastIndexOf(" ");
  const truncated = lastSpace > 0 ? candidate.slice(0, lastSpace) : candidate;
  return `${truncated.trimEnd()}...`;
}

function normalizeForDuplicateCheck(value = "") {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function titleDuplicateVariants(title = "") {
  const cleanedTitle = cleanText(title);
  const variants = new Set([normalizeForDuplicateCheck(cleanedTitle)]);
  const publicationSuffixMatch = cleanedTitle.match(/\s+-\s+(.{2,80})$/);

  if (publicationSuffixMatch) {
    const withoutSuffix = cleanedTitle.replace(/\s+-\s+.{2,80}$/, "");
    const publication = publicationSuffixMatch[1];
    variants.add(normalizeForDuplicateCheck(withoutSuffix));
    variants.add(normalizeForDuplicateCheck(publication));
    variants.add(
      normalizeForDuplicateCheck(`${withoutSuffix} ${publication}`),
    );
  }

  return [...variants].filter((variant) => variant.length > 0);
}

export function cleanStorySnippet(snippet = "", title = "") {
  const cleaned = cleanText(snippet);
  if (!cleaned || !title) {
    return cleaned;
  }

  let residual = normalizeForDuplicateCheck(cleaned);
  const variants = titleDuplicateVariants(title).sort(
    (a, b) => b.length - a.length,
  );

  for (const variant of variants) {
    residual = cleanText(residual.split(variant).join(" "));
  }

  const residualWords = residual ? residual.split(/\s+/).length : 0;
  return residualWords <= 3 ? "" : cleaned;
}

export function escapeXml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function wrapCdata(value = "") {
  return `<![CDATA[${String(value).replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

export function resolveUrl(value, baseUrl) {
  if (!value) {
    return "";
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

export function parseDate(value) {
  if (!value) {
    return null;
  }

  const normalized = String(value).replace(/(\d)(am|pm)\b/gi, "$1 $2");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

export async function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return results;
}

export function sortItemsByDate(items) {
  return [...items].sort((a, b) => {
    const aTime = a.pubDate?.valueOf() ?? 0;
    const bTime = b.pubDate?.valueOf() ?? 0;
    return bTime - aTime;
  });
}
