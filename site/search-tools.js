/* Reader search upgrades: a publication date range, saved searches, and CSV
   export. A classic script that index.html loads with a plain <script> tag.
   The pure helpers come first and are tested from test/search-tools.test.js,
   which runs this file in a vm sandbox. The browser wiring at the bottom only
   runs when `mount` is called from the reader. */
(function () {
  "use strict";

  // Same ids as SECTION_OPTIONS in index.html.
  const SECTION_IDS = ["all", "brand", "vermont", "national"];
  const STORAGE_KEY = "cerulean-news:saved-searches:v1";
  const MAX_SAVED = 20;
  const MAX_NAME = 40;
  const MAX_QUERY = 200;

  /* ---- Dates ---- */

  // A YYYY-MM-DD string that is a real calendar day, or "".
  function normalizeDay(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
    if (!match) {
      return "";
    }
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const probe = new Date(year, month - 1, day);
    const real = probe.getFullYear() === year &&
      probe.getMonth() === month - 1 &&
      probe.getDate() === day;
    return real ? match[0] : "";
  }

  // The reader's local calendar day, matching the date shown on each story.
  function dayKey(date) {
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function itemDay(item) {
    if (!item || !item.pubDate) {
      return "";
    }
    const date = new Date(item.pubDate);
    return Number.isNaN(date.valueOf()) ? "" : dayKey(date);
  }

  // The start date is after the end date, so nothing can match.
  function dateRangeProblem(from, to) {
    const start = normalizeDay(from);
    const end = normalizeDay(to);
    return start && end && start > end ? "The start date is after the end date." : "";
  }

  // Inclusive on both ends. Items without a usable date drop out as soon as
  // either bound is set. YYYY-MM-DD strings compare correctly as text.
  function filterByDateRange(items, from, to) {
    const start = normalizeDay(from);
    const end = normalizeDay(to);
    if (!start && !end) {
      return items;
    }
    if (start && end && start > end) {
      return [];
    }
    return items.filter((item) => {
      const day = itemDay(item);
      return day !== "" && (!start || day >= start) && (!end || day <= end);
    });
  }

  /* ---- Address state ---- */

  function cleanState(state = {}) {
    const query = String(state.q || "").trim().slice(0, MAX_QUERY);
    return {
      q: query,
      section: SECTION_IDS.includes(state.section) ? state.section : "all",
      from: normalizeDay(state.from),
      to: normalizeDay(state.to),
    };
  }

  // The search, date, and section parts of the hash, in a fixed order.
  // Defaults are left out so an unfiltered reader keeps a bare "#".
  function stateToHashParts(state) {
    const clean = cleanState(state);
    const parts = [];
    if (clean.section !== "all") {
      parts.push(`section=${clean.section}`);
    }
    if (clean.q) {
      parts.push(`q=${encodeURIComponent(clean.q)}`);
    }
    if (clean.from) {
      parts.push(`from=${clean.from}`);
    }
    if (clean.to) {
      parts.push(`to=${clean.to}`);
    }
    return parts;
  }

  function hashValue(hash, name) {
    const match = new RegExp(`(?:^|[#&])${name}=([^&]*)`).exec(String(hash || ""));
    if (!match) {
      return "";
    }
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return "";
    }
  }

  function parseHashState(hash) {
    return cleanState({
      q: hashValue(hash, "q"),
      section: hashValue(hash, "section"),
      from: hashValue(hash, "from"),
      to: hashValue(hash, "to"),
    });
  }

  function sameState(a, b) {
    const x = cleanState(a);
    const y = cleanState(b);
    return x.q === y.q && x.section === y.section && x.from === y.from && x.to === y.to;
  }

  function isDefaultState(state) {
    return sameState(state, {});
  }

  /* ---- Saved searches ---- */

  function sanitizeSaved(entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    const name = String(entry.name || "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
    if (!name) {
      return null;
    }
    return { name, ...cleanState(entry) };
  }

  function serializeSaved(list) {
    const clean = (Array.isArray(list) ? list : []).map(sanitizeSaved).filter(Boolean);
    return JSON.stringify(clean.slice(0, MAX_SAVED));
  }

  // Tolerant of anything storage might hold: bad JSON, the wrong shape, or
  // entries from a future version. Duplicate names keep the first entry.
  function parseSaved(text) {
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) {
      return [];
    }
    const seen = new Set();
    const list = [];
    for (const entry of raw) {
      const clean = sanitizeSaved(entry);
      const key = clean && clean.name.toLowerCase();
      if (clean && !seen.has(key)) {
        seen.add(key);
        list.push(clean);
      }
    }
    return list.slice(0, MAX_SAVED);
  }

  // Saving under an existing name (any case) replaces that entry in place.
  function addSavedSearch(list, entry) {
    const clean = sanitizeSaved(entry);
    if (!clean) {
      return list;
    }
    const key = clean.name.toLowerCase();
    const index = list.findIndex((saved) => saved.name.toLowerCase() === key);
    if (index >= 0) {
      return list.map((saved, position) => (position === index ? clean : saved));
    }
    return [...list, clean].slice(-MAX_SAVED);
  }

  function removeSavedSearch(list, name) {
    const key = String(name).toLowerCase();
    return list.filter((saved) => saved.name.toLowerCase() !== key);
  }

  function savedSearchHash(entry) {
    const parts = stateToHashParts(entry);
    return parts.length ? `#${parts.join("&")}` : "#";
  }

  /* ---- CSV ---- */

  const CSV_COLUMNS = [
    "date",
    "section",
    "outlet",
    "title",
    "url",
    "sentiment",
    "sentimentScore",
    "summary",
  ];

  // RFC 4180: quote a field holding a comma, quote, CR, or LF, and double any
  // quote inside it. Text that a spreadsheet would read as a formula gets a
  // leading apostrophe, the usual guard for exporting scraped headlines.
  function csvField(value) {
    if (value === null || value === undefined) {
      return "";
    }
    let text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : String(value);
    if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) {
      text = `'${text}`;
    }
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function csvRow(values) {
    return values.map(csvField).join(",");
  }

  function itemCsvValues(item, sectionOf) {
    const url = item.link || item.url || "";
    return [
      itemDay(item),
      typeof sectionOf === "function" ? sectionOf(item) : item.section || "",
      item.outlet || item.sourceName || "",
      item.title || "",
      url,
      item.sentiment || "",
      Number.isFinite(item.sentimentScore) ? item.sentimentScore : "",
      item.summary || item.snippet || "",
    ];
  }

  // CRLF line ends, header first, one row per item. The byte order mark is
  // added when the Blob is built, not here, so the text stays easy to test.
  function itemsToCsv(items, sectionOf) {
    const lines = [csvRow(CSV_COLUMNS)];
    for (const item of items) {
      lines.push(csvRow(itemCsvValues(item, sectionOf)));
    }
    return `${lines.join("\r\n")}\r\n`;
  }

  function csvFilename(date = new Date()) {
    return `cerulean-news-${dayKey(date)}.csv`;
  }

  const api = {
    CSV_COLUMNS,
    STORAGE_KEY,
    normalizeDay,
    dayKey,
    itemDay,
    dateRangeProblem,
    filterByDateRange,
    cleanState,
    stateToHashParts,
    parseHashState,
    sameState,
    isDefaultState,
    sanitizeSaved,
    serializeSaved,
    parseSaved,
    addSavedSearch,
    removeSavedSearch,
    savedSearchHash,
    csvField,
    csvRow,
    itemsToCsv,
    csvFilename,
  };

  /* ---- Browser wiring ---- */

  // Storage throws in some private windows and when site data is blocked, so
  // every access is guarded and saved searches fall back to memory.
  function loadSaved() {
    try {
      const text = window.localStorage.getItem(STORAGE_KEY);
      return { list: text ? parseSaved(text) : [], persistent: true };
    } catch {
      return { list: [], persistent: false };
    }
  }

  function storeSaved(list) {
    try {
      window.localStorage.setItem(STORAGE_KEY, serializeSaved(list));
      return true;
    } catch {
      return false;
    }
  }

  // context: { searchInput, getFilteredItems(), sectionLabel(item), onChange() }
  function mount(context) {
    const byId = (id) => document.getElementById(id);
    const searchInput = context.searchInput;
    const fromInput = byId("date-from");
    const toInput = byId("date-to");
    const clearDates = byId("date-clear");
    const dateNote = byId("date-note");
    const saveForm = byId("save-search-form");
    const nameInput = byId("save-search-name");
    const savedList = byId("saved-searches");
    const savedNote = byId("saved-note");
    const exportButton = byId("export-csv");
    const toolsStatus = byId("search-tools-status");
    if (!fromInput || !toInput || !saveForm || !savedList || !exportButton) {
      return;
    }

    let saved = loadSaved();
    let statusTimer = null;

    function say(message) {
      window.clearTimeout(statusTimer);
      toolsStatus.textContent = "";
      // A short delay makes a repeated message announce again.
      statusTimer = window.setTimeout(() => {
        toolsStatus.textContent = message;
      }, 60);
    }

    function currentState() {
      return cleanState({
        q: searchInput.value,
        section: parseHashState(location.hash).section,
        from: fromInput.value,
        to: toInput.value,
      });
    }

    function renderDateChrome() {
      // min and max let the browser flag a reversed range.
      toInput.min = normalizeDay(fromInput.value);
      fromInput.max = normalizeDay(toInput.value);
      clearDates.hidden = !(fromInput.value || toInput.value);
      dateNote.textContent = dateRangeProblem(fromInput.value, toInput.value);
      dateNote.hidden = !dateNote.textContent;
    }

    function renderSaved() {
      const state = currentState();
      savedList.replaceChildren();
      savedList.hidden = saved.list.length === 0;
      for (const entry of saved.list) {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = savedSearchHash(entry);
        link.textContent = entry.name;
        link.title = describe(entry);
        if (sameState(entry, state)) {
          link.setAttribute("aria-current", "true");
        }
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "saved-remove";
        remove.setAttribute("aria-label", `Remove saved search ${entry.name}`);
        remove.textContent = "×";
        remove.addEventListener("click", () => removeSaved(entry.name));
        item.append(link, remove);
        savedList.appendChild(item);
      }
      savedNote.hidden = saved.persistent;
    }

    function describe(entry) {
      const bits = [];
      if (entry.q) {
        bits.push(`“${entry.q}”`);
      }
      if (entry.section !== "all") {
        bits.push(`section: ${entry.section}`);
      }
      if (entry.from || entry.to) {
        bits.push(`${entry.from || "any"} to ${entry.to || "any"}`);
      }
      return bits.join(", ");
    }

    function persist() {
      saved.persistent = storeSaved(saved.list) && saved.persistent;
      renderSaved();
    }

    function removeSaved(name) {
      const index = saved.list.findIndex((entry) => entry.name === name);
      saved.list = removeSavedSearch(saved.list, name);
      persist();
      say(`Removed saved search ${name}.`);
      // Keep focus in the list, or fall back to the name field.
      const remaining = savedList.querySelectorAll("a");
      const next = remaining[Math.min(index, remaining.length - 1)];
      (next || nameInput).focus();
    }

    saveForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const state = currentState();
      if (isDefaultState(state)) {
        say("Nothing to save yet. Enter a search, pick a section, or set dates first.");
        return;
      }
      const name = nameInput.value.trim() ||
        state.q.slice(0, MAX_NAME) ||
        "Saved search";
      const before = saved.list.length;
      saved.list = addSavedSearch(saved.list, { name, ...state });
      persist();
      nameInput.value = "";
      say(saved.list.length > before || before >= MAX_SAVED
        ? `Saved search ${name}.`
        : `Updated saved search ${name}.`);
    });

    function onDatesChanged() {
      renderDateChrome();
      renderSaved();
      context.onChange();
    }

    fromInput.addEventListener("input", onDatesChanged);
    toInput.addEventListener("input", onDatesChanged);
    clearDates.addEventListener("click", () => {
      fromInput.value = "";
      toInput.value = "";
      onDatesChanged();
      fromInput.focus();
    });
    searchInput.addEventListener("input", renderSaved);

    exportButton.addEventListener("click", () => {
      const items = context.getFilteredItems();
      if (items.length === 0) {
        say("No stories to export.");
        return;
      }
      const csv = itemsToCsv(items, context.sectionLabel);
      // The byte order mark lets Excel read the file as UTF-8.
      const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = csvFilename();
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      say(`Downloaded ${items.length.toLocaleString("en-US")} ${items.length === 1 ? "story" : "stories"} as ${link.download}.`);
    });

    // Called by the reader on load and whenever the address changes.
    mount.sync = function sync() {
      const state = parseHashState(location.hash);
      if (searchInput.value.trim() !== state.q) {
        searchInput.value = state.q;
      }
      if (fromInput.value !== state.from) {
        fromInput.value = state.from;
      }
      if (toInput.value !== state.to) {
        toInput.value = state.to;
      }
      renderDateChrome();
      renderSaved();
    };

    // The address may carry a search or dates before the first render.
    mount.sync();
  }

  api.mount = mount;
  api.syncControls = function syncControls() {
    if (typeof mount.sync === "function") {
      mount.sync();
    }
  };
  // The current controls as hash parts; empty until mounted.
  api.currentHashParts = function currentHashParts() {
    if (typeof document === "undefined") {
      return [];
    }
    const field = (id) => (document.getElementById(id) || {}).value || "";
    const search = document.getElementById("search-input");
    return stateToHashParts({
      q: search ? search.value : "",
      from: field("date-from"),
      to: field("date-to"),
    }).filter((part) => !part.startsWith("section="));
  };
  api.filterDates = function filterDates(items) {
    if (typeof document === "undefined") {
      return items;
    }
    const field = (id) => (document.getElementById(id) || {}).value || "";
    return filterByDateRange(items, field("date-from"), field("date-to"));
  };
  api.hasActiveFilters = function hasActiveFilters() {
    return api.currentHashParts().length > 0;
  };

  globalThis.CeruleanSearchTools = api;
})();
