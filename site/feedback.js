/* Team feedback for the reader: Keep, Drop, and "Sentiment is wrong" on each
   story, and the admin page that lists every vote. A classic script that
   index.html and feedback-admin.html load with a plain <script> tag.

   It stays out of sight for everyone else. The reader asks the mail Worker
   whether this browser has a team session, and any failure (no session, the
   Worker not deployed, a network error) leaves the page exactly as it was.

   The pure helpers come first and are tested from test/feedback-ui.test.js,
   which runs this file in a vm sandbox. The browser wiring below them only
   runs when the reader or the admin page calls into it. Every value that
   reaches the page goes in through textContent or a property, never as HTML. */
(function () {
  "use strict";

  const API = "/api/mail";
  const HINT_KEY = "cerulean-news:team-hint:v1";
  // The site's five labels, most favorable first, as the feed publishes them.
  const SENTIMENT_LABELS = [
    "positive",
    "neutral to positive",
    "neutral",
    "neutral to negative",
    "negative",
  ];
  const VOTES = ["keep", "drop", "sentiment"];

  /* ---- Story ids ---- */

  // The same normalization as exampleUrl in src/jev-examples.js, so the id the
  // reader sends is the id the pipeline computes (its rejectedIds use it too):
  // SHA-256 of the URL without tracking parameters, "www.", or a trailing
  // slash. test/feedback-ui.test.js checks the two agree.
  function exampleUrl(value) {
    try {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()]) {
        if (/^utm_/i.test(key) || /^(fbclid|gclid|mc_cid|mc_eid)$/i.test(key)) {
          url.searchParams.delete(key);
        }
      }
      url.searchParams.sort();
      return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/$/, "")}${url.search}`;
    } catch {
      return String(value || "").trim().toLowerCase();
    }
  }

  async function itemId(link) {
    const bytes = new TextEncoder().encode(exampleUrl(link));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  /* ---- Rules ---- */

  // "Sentiment is wrong" is offered only on Blue Cross VT stories that carry a
  // sentiment, the coverage the score is defined for.
  function canCorrectSentiment(item) {
    return Boolean(item && item.sentimentEligible && SENTIMENT_LABELS.includes(item.sentiment));
  }

  // The labels to offer: every label except the one the story shows now.
  function optionLabels(item) {
    return SENTIMENT_LABELS.filter((label) => label !== (item && item.sentiment));
  }

  // The request body for a vote, or null when it is not a valid one.
  function voteBody(vote, label) {
    if (!VOTES.includes(vote)) {
      return null;
    }
    if (vote === "sentiment") {
      return SENTIMENT_LABELS.includes(label) ? { vote, label } : null;
    }
    return { vote };
  }

  function voteText(vote) {
    if (!vote) {
      return "";
    }
    if (vote.vote === "keep") {
      return "Kept";
    }
    if (vote.vote === "drop") {
      return "Dropped";
    }
    return vote.vote === "sentiment" && SENTIMENT_LABELS.includes(vote.label)
      ? `Sentiment should be ${vote.label}`
      : "";
  }

  // What the Worker says about the signed-in member: { admin, votes: Map }.
  // Anything that is not a well-formed answer is null, so a 404 page or a
  // proxy's error page can never look like a session.
  function parseVotesResponse(json) {
    if (!json || json.ok !== true || !Array.isArray(json.votes)) {
      return null;
    }
    const votes = new Map();
    for (const row of json.votes) {
      const valid = row && typeof row.item === "string" && /^[0-9a-f]{64}$/.test(row.item) &&
        VOTES.includes(row.vote) &&
        (row.vote === "sentiment" ? SENTIMENT_LABELS.includes(row.label) : !row.label);
      if (valid) {
        votes.set(row.item, { vote: row.vote, label: row.vote === "sentiment" ? row.label : null });
      }
    }
    return { admin: json.admin === true, votes };
  }

  // Only http and https links, since feed links come from scraped content.
  function safeHref(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch {
      return "";
    }
  }

  function shortId(id) {
    return String(id || "").slice(0, 10);
  }

  // Newest first, then by story id so the order is stable.
  function sortAdminRows(rows) {
    return [...rows].sort(
      (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.item).localeCompare(String(b.item)),
    );
  }

  function summarizeAdminRows(rows) {
    const counts = { keep: 0, drop: 0, sentiment: 0 };
    for (const row of rows) {
      if (row && Object.hasOwn(counts, row.vote)) {
        counts[row.vote] += 1;
      }
    }
    return counts;
  }

  // The admin page's own check of the Worker's list. Rows that do not look
  // right are dropped rather than shown.
  function parseAdminResponse(json) {
    if (!json || json.ok !== true || !Array.isArray(json.votes)) {
      return null;
    }
    return json.votes.filter(
      (row) => row && Number.isInteger(row.id) && typeof row.item === "string" &&
        /^[0-9a-f]{64}$/.test(row.item) && VOTES.includes(row.vote) &&
        typeof row.voter === "string" && typeof row.updatedAt === "string",
    );
  }

  const EXCLUDED_PAGE_SIZE = 25;
  const EXCLUDED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const dateValue = (value) => typeof value === "string" && value.trim() ? Date.parse(value) : NaN;

  // Recency means first discovery, not the last time a model rejected a story.
  // Legacy rows fall back to publication date. Undated rows cannot establish
  // recency; count them explicitly instead of quietly treating them as new.
  function selectExcludedRows(items, now = Date.now()) {
    const byKey = new Map();
    let undated = 0;
    let invalidLinks = 0;
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || item.relevant !== false) continue;
      const discovered = dateValue(item.firstSeenAt);
      const published = dateValue(item.pubDate);
      const date = Number.isFinite(discovered) ? discovered : published;
      if (!Number.isFinite(date)) { undated += 1; continue; }
      if (date < now - EXCLUDED_WINDOW_MS || date > now) continue;
      const link = safeHref(item.link || item.url || "");
      if (!link) { invalidLinks += 1; continue; }
      const row = {
        key: exampleUrl(link), link, date,
        dateKind: Number.isFinite(discovered) ? "Discovered" : "Published (discovery date unavailable)",
        title: typeof item.title === "string" && item.title.trim() ? item.title : "Untitled story",
        outlet: typeof item.outlet === "string" ? item.outlet : "",
        reason: typeof item.reason === "string" && item.reason.trim() ? item.reason : "No exclusion reason recorded.",
      };
      const previous = byKey.get(row.key);
      // A fixed tie-breaker also makes duplicate rows independent of input order.
      if (!previous || row.date > previous.date || (row.date === previous.date &&
          compareText(JSON.stringify(row), JSON.stringify(previous)) < 0)) byKey.set(row.key, row);
    }
    return { rows: [...byKey.values()].sort((a, b) => b.date - a.date || compareText(a.key, b.key)), undated, invalidLinks };
  }

  function excludedPage(rows, requested = 0) {
    const pages = Math.max(1, Math.ceil(rows.length / EXCLUDED_PAGE_SIZE));
    const page = Math.min(pages - 1, Math.max(0, Number.isInteger(requested) ? requested : 0));
    const start = page * EXCLUDED_PAGE_SIZE;
    return { rows: rows.slice(start, start + EXCLUDED_PAGE_SIZE), page, pages, start, total: rows.length };
  }

  const api = {
    SENTIMENT_LABELS,
    exampleUrl,
    itemId,
    canCorrectSentiment,
    optionLabels,
    voteBody,
    voteText,
    parseVotesResponse,
    parseAdminResponse,
    safeHref,
    shortId,
    sortAdminRows,
    summarizeAdminRows,
    selectExcludedRows,
    excludedPage,
  };

  /* ---- Browser wiring ---- */

  const state = { signedIn: false, admin: false, live: false, votes: new Map(), busy: new Set() };
  const entries = [];
  // Story ids are SHA-256 hashes computed off the main thread. start() waits
  // for any still pending so the first render has every id.
  const pendingIds = new Set();
  let statusEl = null;
  let statusTimer = null;
  let noteEl = null;
  let onSessionChange = null;

  function say(message) {
    if (!statusEl) {
      return;
    }
    window.clearTimeout(statusTimer);
    statusEl.textContent = "";
    // A short delay makes a repeated message announce again.
    statusTimer = window.setTimeout(() => {
      statusEl.textContent = message;
    }, 60);
  }

  function hint(value) {
    try {
      if (value === undefined) {
        return window.localStorage.getItem(HINT_KEY) === "1";
      }
      if (value) {
        window.localStorage.setItem(HINT_KEY, "1");
      } else {
        window.localStorage.removeItem(HINT_KEY);
      }
    } catch {
      // Storage can be blocked. The hint is a convenience only.
    }
    return false;
  }

  // One request helper. A network failure or an unreadable body is an
  // ordinary result, never an exception, so callers can stay quiet.
  async function request(path, { method = "GET", body } = {}) {
    try {
      const response = await fetch(`${API}${path}`, {
        method,
        credentials: "same-origin",
        cache: "no-store",
        headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const type = response.headers.get("content-type") || "";
      const json = type.includes("json") ? await response.json().catch(() => null) : null;
      return { ok: response.ok, status: response.status, json };
    } catch {
      return { ok: false, status: 0, json: null };
    }
  }

  const idCache = new Map();
  function idFor(link) {
    if (!idCache.has(link)) {
      idCache.set(link, itemId(link).catch(() => ""));
    }
    return idCache.get(link);
  }

  function makeButton(text, label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "feedback-link";
    button.textContent = text;
    if (label) {
      button.setAttribute("aria-label", label);
    }
    button.addEventListener("click", onClick);
    return button;
  }

  function separator() {
    const dot = document.createElement("span");
    dot.setAttribute("aria-hidden", "true");
    dot.textContent = " · ";
    return dot;
  }

  function removeControls(entry) {
    if (entry.box) {
      entry.box.remove();
      entry.box = null;
    }
    if (entry.picker) {
      entry.picker.remove();
      entry.picker = null;
    }
  }

  function focusIn(entry, selector) {
    const target = entry.box && entry.box.querySelector(selector);
    if (target) {
      target.focus();
    }
  }

  function render(entry, { focus = "" } = {}) {
    removeControls(entry);
    if (!state.signedIn || !entry.id || !entry.meta.isConnected) {
      return;
    }
    const title = String(entry.item.title || "this story");
    const vote = state.votes.get(entry.id);
    const box = document.createElement("span");
    box.className = "feedback-actions";
    box.append(separator());
    const disabled = state.busy.has(entry.id);

    if (vote) {
      const current = document.createElement("span");
      current.className = "feedback-current";
      current.textContent = `Your vote: ${entry.keepOnly && vote.vote === "keep" ? "Keep requested" : voteText(vote)}`;
      const undo = makeButton("Undo", `Undo your vote on: ${title}`, () => undoVote(entry));
      undo.dataset.action = "undo";
      undo.disabled = disabled;
      box.append(current, separator(), undo);
    } else {
      const keep = makeButton("Keep", `Keep: ${title}`, () => castVote(entry, "keep"));
      keep.dataset.action = "keep";
      keep.disabled = disabled;
      box.append(keep);
      if (!entry.keepOnly) {
        const drop = makeButton("Drop", `Drop: ${title}`, () => castVote(entry, "drop"));
        drop.dataset.action = "drop";
        drop.disabled = disabled;
        box.append(separator(), drop);
      }
      if (!entry.keepOnly && canCorrectSentiment(entry.item)) {
        const wrong = makeButton("Sentiment is wrong", `Sentiment is wrong: ${title}`, () => togglePicker(entry));
        wrong.dataset.action = "sentiment";
        wrong.setAttribute("aria-expanded", entry.pickerOpen ? "true" : "false");
        box.append(separator(), wrong);
      }
    }
    entry.meta.appendChild(box);
    entry.box = box;

    if (!vote && entry.pickerOpen && canCorrectSentiment(entry.item)) {
      const picker = document.createElement("div");
      picker.className = "feedback-picker";
      picker.setAttribute("role", "group");
      picker.setAttribute("aria-label", `Sentiment should be, for: ${title}`);
      const lead = document.createElement("span");
      lead.textContent = "Should be: ";
      picker.appendChild(lead);
      optionLabels(entry.item).forEach((label, index) => {
        if (index > 0) {
          picker.appendChild(separator());
        }
        const choice = makeButton(label, `Sentiment should be ${label}: ${title}`, () => castVote(entry, "sentiment", label));
        choice.dataset.label = label;
        choice.disabled = disabled;
        picker.appendChild(choice);
      });
      picker.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          togglePicker(entry, false);
          focusIn(entry, '[data-action="sentiment"]');
        }
      });
      entry.meta.insertAdjacentElement("afterend", picker);
      entry.picker = picker;
    }

    if (focus === "picker" && entry.picker) {
      entry.picker.querySelector("button")?.focus();
    } else if (focus) {
      focusIn(entry, `[data-action="${focus}"]`);
    }
  }

  function renderAll() {
    for (const entry of entries) {
      render(entry);
    }
    renderNote();
    onSessionChange?.(state.signedIn);
  }

  function togglePicker(entry, open = !entry.pickerOpen) {
    entry.pickerOpen = open;
    render(entry, { focus: open ? "picker" : "sentiment" });
  }

  function sessionEnded() {
    state.signedIn = false;
    state.admin = false;
    state.votes.clear();
    renderAll();
    say("Your team sign-in has ended. Sign in again to keep giving feedback.");
  }

  async function castVote(entry, vote, label) {
    const body = voteBody(vote, label);
    if (!state.signedIn || !body || state.busy.has(entry.id)) {
      return;
    }
    state.busy.add(entry.id);
    render(entry);
    const result = await request(`/feedback/${entry.id}`, { method: "PUT", body });
    state.busy.delete(entry.id);
    if (result.status === 401) {
      sessionEnded();
      return;
    }
    if (!state.signedIn) return;
    const saved = result.ok && result.json && result.json.ok === true ? result.json.vote : null;
    if (!saved || saved.item !== entry.id || saved.vote !== body.vote || (saved.label || null) !== (body.label || null)) {
      entry.pickerOpen = false;
      render(entry, { focus: vote });
      say("Could not save your vote. Try again in a moment.");
      return;
    }
    state.votes.set(entry.id, { vote: saved.vote, label: saved.label || null });
    entry.pickerOpen = false;
    for (const other of entries) {
      if (other.id === entry.id) {
        render(other, { focus: other === entry ? "undo" : "" });
      }
    }
    say(entry.keepOnly
      ? `Keep requested: ${entry.item.title}. It will be considered at the next publishing run, subject to editorial and exclusion rules.`
      : `${voteText(state.votes.get(entry.id))}: ${entry.item.title}. It takes effect at the next update.`);
  }

  async function undoVote(entry) {
    if (!state.signedIn || state.busy.has(entry.id)) {
      return;
    }
    state.busy.add(entry.id);
    render(entry);
    const result = await request(`/feedback/${entry.id}`, { method: "DELETE" });
    state.busy.delete(entry.id);
    if (result.status === 401) {
      sessionEnded();
      return;
    }
    if (!state.signedIn) return;
    if (!(result.ok && result.json && result.json.ok === true)) {
      render(entry, { focus: "undo" });
      say("Could not undo your vote. Try again in a moment.");
      return;
    }
    state.votes.delete(entry.id);
    for (const other of entries) {
      if (other.id === entry.id) {
        render(other, { focus: other === entry ? "keep" : "" });
      }
    }
    say(`Vote removed: ${entry.item.title}.${entry.keepOnly ? " The change applies at the next publishing run." : ""}`);
  }

  // The reader calls this for every story it draws. It does nothing visible
  // until a team session is known.
  function decorate(li, item, { keepOnly = false } = {}) {
    const meta = li && li.querySelector && li.querySelector(".meta");
    if (!meta || !item) {
      return;
    }
    if (entries.length > 100) {
      entries.splice(0, entries.length, ...entries.filter((entry) => entry.li.isConnected));
    }
    const entry = { li, item, meta, keepOnly, id: "", box: null, picker: null, pickerOpen: false };
    entries.push(entry);
    const pending = idFor(item.link || item.url || "").then((id) => {
      entry.id = id;
      render(entry);
    });
    pendingIds.add(pending);
    pending.finally(() => pendingIds.delete(pending));
  }

  // The footer line: who can sign in, and what a signed-in member can reach.
  // Once the Worker answers (a 401 means it is live but this browser is not
  // signed in), everyone sees the sign-in link so staff can find it. Before
  // the Worker is deployed the line stays hidden, since the link would 404.
  function renderNote() {
    if (!noteEl) {
      return;
    }
    const term = noteEl.previousElementSibling;
    noteEl.replaceChildren();
    const show = state.signedIn || state.live || hint();
    noteEl.hidden = !show;
    if (term && term.tagName === "DT") {
      term.hidden = !show;
    }
    if (!show) {
      return;
    }
    if (state.signedIn) {
      noteEl.append("Signed in for team feedback. ");
      const excluded = document.createElement("a");
      excluded.href = "excluded";
      excluded.textContent = "Excluded stories";
      noteEl.append(excluded, " · ");
      if (state.admin) {
        const votes = document.createElement("a");
        votes.href = "feedback-admin";
        votes.textContent = "All votes";
        noteEl.append(votes, " · ");
      }
      const out = makeButton("Sign out", "Sign out of team feedback", signOut);
      noteEl.appendChild(out);
    } else {
      const link = document.createElement("a");
      link.href = `${API}/team/signin`;
      // Deliberately plain and unbranded: the site is independent.
      link.textContent = "Sign in";
      noteEl.appendChild(link);
    }
  }

  async function signOut() {
    const result = await request("/team/signout", { method: "POST", body: {} });
    if (!result.ok) {
      say("Could not sign out. Try again in a moment.");
      return;
    }
    hint(false);
    state.signedIn = false;
    state.admin = false;
    state.votes.clear();
    renderAll();
    say("Signed out of team feedback.");
  }

  // Asks the Worker for this browser's votes. Any failure, including a 404
  // from a site whose Worker is not deployed, changes nothing.
  async function start(options = {}) {
    statusEl = options.status || document.getElementById("feedback-status");
    noteEl = options.note || document.getElementById("team-note");
    onSessionChange = options.onSessionChange || null;
    const result = await request("/feedback");
    await Promise.all([...pendingIds]);
    const parsed = result.ok ? parseVotesResponse(result.json) : null;
    if (parsed) {
      state.signedIn = true;
      state.admin = parsed.admin;
      state.votes = parsed.votes;
      hint(true);
    } else {
      state.signedIn = false;
      state.admin = false;
      state.votes.clear();
      state.live = result.status === 401;
    }
    renderAll();
    return { signedIn: state.signedIn, status: result.status };
  }

  api.decorate = decorate;
  api.start = start;

  /* ---- Recent excluded stories ---- */

  async function mountExcluded({ list, status, summary, message, pager, note, now = Date.now() }) {
    let selected = { rows: [], undated: 0, invalidLinks: 0 };
    let page = 0;
    function show(text) {
      message.textContent = text;
      message.hidden = !text;
    }
    function clear() {
      selected = { rows: [], undated: 0, invalidLinks: 0 };
      list.replaceChildren();
      pager.replaceChildren();
      summary.textContent = "";
    }
    function signInMessage() {
      show("Sign in with a team or admin address to review excluded stories.");
      const link = document.createElement("a");
      link.href = `${API}/team/signin`;
      link.textContent = "Team sign-in";
      message.append(" ", link, ".");
    }
    function draw() {
      if (!state.signedIn) return;
      list.replaceChildren();
      pager.replaceChildren();
      const view = excludedPage(selected.rows, page);
      page = view.page;
      summary.textContent = view.total
        ? `Showing ${view.start + 1}–${view.start + view.rows.length} of ${view.total} recent excluded stories.`
        : "";
      if (selected.undated) summary.append(` ${selected.undated} undated excluded ${selected.undated === 1 ? "story is" : "stories are"} not shown because recency is unknown.`);
      if (selected.invalidLinks) summary.append(` ${selected.invalidLinks} recent ${selected.invalidLinks === 1 ? "story has" : "stories have"} no usable article link and cannot be reviewed here.`);
      show(view.total ? "" : "No excluded stories were found in this 14-day window.");
      for (const item of view.rows) {
        const li = document.createElement("li");
        const head = document.createElement("a");
        head.className = "story-title";
        head.href = item.link;
        head.textContent = item.title;
        const reason = document.createElement("p");
        reason.className = "reason";
        reason.textContent = `Exclusion reason: ${item.reason}`;
        const meta = document.createElement("div");
        meta.className = "meta";
        const date = new Date(item.date).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
        meta.textContent = [item.outlet, `${item.dateKind}: ${date} UTC`].filter(Boolean).join(" · ");
        li.append(head, reason, meta);
        list.appendChild(li);
        decorate(li, item, { keepOnly: true });
      }
      if (view.pages > 1) {
        const move = (step) => {
          if (!state.signedIn) return;
          page += step;
          draw();
          list.focus();
        };
        const previous = makeButton("Previous", "Previous page of excluded stories", () => move(-1));
        const next = makeButton("Next", "Next page of excluded stories", () => move(1));
        previous.disabled = page === 0;
        next.disabled = page === view.pages - 1;
        pager.append(previous, ` Page ${page + 1} of ${view.pages} `, next);
      }
    }

    clear();
    show("Checking team sign-in…");
    const session = await start({ status, note, onSessionChange: (signedIn) => {
      if (!signedIn) { clear(); signInMessage(); }
    } });
    if (!session.signedIn) {
      if (session.status !== 401) show("The feedback service is not available right now. Please try again later.");
      return;
    }
    show("Loading recent excluded stories…");
    try {
      // The audit is already public. Session gating protects this team workflow,
      // not the underlying file; no API or data-publication policy changes here.
      const response = await fetch("feed-audit.json", { cache: "no-cache" });
      if (!response.ok) throw new Error("audit unavailable");
      const data = await response.json();
      if (!Array.isArray(data?.items)) throw new Error("invalid audit");
      if (!state.signedIn) return;
      selected = selectExcludedRows(data.items, now);
      draw();
      await Promise.all([...pendingIds]);
    } catch {
      if (state.signedIn) show("Could not load excluded stories. Refresh this page to try again.");
    }
  }

  api.mountExcluded = mountExcluded;

  /* ---- Admin page ---- */

  // Story titles for the vote list. The published feed has every story that is
  // still in, and a dropped story lives only in the audit file, which is large
  // and is fetched only when a vote names a story the feed does not have.
  async function titlesFor(ids) {
    const titles = new Map();
    const wanted = new Set(ids);
    for (const file of ["feed.json", "feed-audit.json"]) {
      if (![...wanted].some((id) => !titles.has(id))) {
        break;
      }
      try {
        const response = await fetch(file, { cache: "no-cache" });
        if (!response.ok) {
          continue;
        }
        const data = await response.json();
        for (const item of data.items || []) {
          const id = await idFor(item.link || item.url || "");
          if (wanted.has(id) && !titles.has(id)) {
            titles.set(id, { title: String(item.title || ""), link: safeHref(item.link || item.url || ""), outlet: String(item.outlet || item.sourceName || "") });
          }
        }
      } catch {
        // Leave those votes showing their short id.
      }
    }
    return titles;
  }

  function mountAdmin({ list, status, summary, message }) {
    const say = (text) => {
      window.clearTimeout(statusTimer);
      status.textContent = "";
      statusTimer = window.setTimeout(() => { status.textContent = text; }, 60);
    };
    const show = (text) => {
      message.textContent = text;
      message.hidden = !text;
    };
    let rows = [];
    let titles = new Map();

    function draw() {
      list.replaceChildren();
      const counts = summarizeAdminRows(rows);
      summary.textContent = rows.length
        ? `${rows.length} current ${rows.length === 1 ? "vote" : "votes"}: ${counts.drop} drop, ${counts.keep} keep, ${counts.sentiment} sentiment.`
        : "";
      for (const row of sortAdminRows(rows)) {
        const li = document.createElement("li");
        const story = titles.get(row.item);
        const head = document.createElement("div");
        head.className = "vote-title";
        const href = story && story.link;
        if (href) {
          const anchor = document.createElement("a");
          anchor.href = href;
          anchor.textContent = story.title || shortId(row.item);
          head.appendChild(anchor);
        } else {
          head.textContent = story && story.title ? story.title : `Story ${shortId(row.item)}`;
        }
        const meta = document.createElement("div");
        meta.className = "vote-meta";
        const when = new Date(row.updatedAt);
        meta.textContent = [
          voteText(row),
          row.voter + (row.voterBlocked ? " (blocked)" : ""),
          Number.isNaN(when.valueOf()) ? "" : when.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }),
          story && story.outlet,
        ].filter(Boolean).join(" · ");
        const undo = makeButton("Undo", `Remove the vote by ${row.voter} on: ${(story && story.title) || shortId(row.item)}`, () => remove(row, li));
        meta.append(separator(), undo);
        li.append(head, meta);
        list.appendChild(li);
      }
    }

    async function remove(row, li) {
      const index = [...list.children].indexOf(li);
      const result = await request(`/feedback/admin/${row.id}`, { method: "DELETE" });
      if (!(result.ok && result.json && result.json.ok === true)) {
        say("Could not remove that vote. Try again in a moment.");
        return;
      }
      rows = rows.filter((other) => other.id !== row.id);
      draw();
      say(`Vote removed. ${rows.length} ${rows.length === 1 ? "vote" : "votes"} left.`);
      const buttons = list.querySelectorAll("button");
      (buttons[Math.min(index, buttons.length - 1)] || list.parentElement).focus?.();
    }

    async function load() {
      const result = await request("/feedback/admin");
      if (result.status === 401) {
        show("Sign in with a team or admin address to see this page.");
        const link = document.createElement("a");
        link.href = `${API}/team/signin`;
        link.textContent = "Team sign-in";
        message.append(" ", link, ".");
        return;
      }
      if (result.status === 403) {
        show("This page is for admins.");
        return;
      }
      const parsed = result.ok ? parseAdminResponse(result.json) : null;
      if (!parsed) {
        show("The feedback service is not available right now.");
        return;
      }
      rows = parsed;
      show(rows.length ? "" : "No votes yet.");
      titles = await titlesFor(rows.map((row) => row.item));
      draw();
    }

    return load();
  }

  api.mountAdmin = mountAdmin;

  globalThis.CeruleanFeedback = api;
})();
