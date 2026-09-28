// Tests for the team feedback UI (site/feedback.js): the pure helpers, and the
// browser wiring against a small fake DOM. site/feedback.js is a classic
// script, so it runs in this realm and publishes on globalThis.CeruleanFeedback.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { exampleId, exampleUrl } from "../src/jev-examples.js";

// ------------------------------------------------------------- a fake DOM

class Node_ {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.attrs = {};
    this.dataset = {};
    this.listeners = {};
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this._text = "";
    this.href = "";
    this.type = "";
    this.focused = false;
  }
  get isConnected() { return this.root === true || Boolean(this.parent && this.parent.isConnected); }
  get textContent() { return this._text + this.children.map((child) => child.textContent ?? "").join(""); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get previousElementSibling() {
    const siblings = this.parent ? this.parent.children.filter((child) => child instanceof Node_) : [];
    return siblings[siblings.indexOf(this) - 1] || null;
  }
  append(...items) { for (const item of items) this.appendChild(typeof item === "string" ? new Text_(item) : item); }
  appendChild(child) {
    if (child.parent) child.remove();
    child.parent = this;
    this.children.push(child);
    return child;
  }
  replaceChildren(...items) { this.children = []; this._text = ""; this.append(...items); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  insertAdjacentElement(where, element) {
    assert.equal(where, "afterend");
    if (element.parent) element.remove();
    const siblings = this.parent.children;
    siblings.splice(siblings.indexOf(this) + 1, 0, element);
    element.parent = this.parent;
    return element;
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  focus() { this.focused = true; Node_.active = this; }
  click() { if (!this.disabled) for (const handler of this.listeners.click || []) handler({ target: this }); }
  matches(selector) {
    if (selector.startsWith(".")) return this.className.split(" ").includes(selector.slice(1));
    const attr = /^\[data-([a-z]+)="([^"]+)"\]$/.exec(selector);
    if (attr) return this.dataset[attr[1]] === attr[2];
    return this.tagName === selector.toUpperCase();
  }
  querySelector(selector) {
    for (const child of this.children) {
      if (!(child instanceof Node_)) continue;
      if (child.matches(selector)) return child;
      const deeper = child.querySelector(selector);
      if (deeper) return deeper;
    }
    return null;
  }
  querySelectorAll(selector) {
    return this.children.filter((child) => child instanceof Node_).flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
}
class Text_ {
  constructor(text) { this.textContent = text; this.parent = null; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
}

function loadScript(env) {
  const saved = {};
  for (const key of Object.keys(env)) saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  for (const [key, value] of Object.entries(env)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  delete globalThis.CeruleanFeedback;
  vm.runInThisContext(fs.readFileSync(new URL("../site/feedback.js", import.meta.url), "utf8"), { filename: "site/feedback.js" });
  const api = globalThis.CeruleanFeedback;
  const restore = () => {
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  };
  return { api, restore };
}

// Just enough of a page: the live region, the footer note, and a story list.
function makePage() {
  const ids = {};
  const status = new Node_("p");
  const dt = new Node_("dt");
  dt.hidden = true;
  const note = new Node_("dd");
  note.hidden = true;
  const dl = new Node_("dl");
  dl.append(dt, note);
  const body = new Node_("body");
  body.root = true;
  body.append(status, dl);
  ids["feedback-status"] = status;
  ids["team-note"] = note;
  const store = new Map();
  const document = {
    createElement: (tag) => new Node_(tag),
    getElementById: (id) => ids[id] || null,
  };
  const window = {
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    localStorage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) },
  };
  const story = (item) => {
    const li = new Node_("li");
    const meta = new Node_("div");
    meta.className = "meta";
    meta.textContent = "Sep 28, 2026 · VTDigger";
    li.appendChild(meta);
    body.appendChild(li);
    return { li, meta, item };
  };
  return { document, window, status, note, dt, body, story, store };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const LINK = "https://vtdigger.org/2026/09/28/blue-cross-rates";
const brandItem = { title: "Blue Cross VT rates", link: LINK, sentimentEligible: true, sentiment: "neutral", section: "Blue Cross VT News" };
const topicItem = { title: "Hospital budgets", link: "https://vtdigger.org/hospital-budgets", section: "Vermont Healthcare News" };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

function harness(fetchImpl) {
  const page = makePage();
  const requests = [];
  const fetchFake = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : undefined, init });
    return fetchImpl(String(url), init);
  };
  const { api, restore } = loadScript({ window: page.window, document: page.document, fetch: fetchFake });
  return { ...page, api, requests, restore };
}

// ------------------------------------------------------------ pure helpers

const pure = loadScript({ window: {}, document: {} }).api;

test("the reader computes the same story id as the pipeline", async () => {
  for (const link of [
    LINK,
    "https://www.vtdigger.org/2026/09/28/blue-cross-rates/",
    "https://vtdigger.org/story?utm_source=x&b=2&a=1&fbclid=abc",
    "http://example.com/a/b/?mc_cid=1&Z=9",
    "https://news.test/path#fragment",
    "https://news.test/café",
    "not a url",
    "",
  ]) {
    assert.equal(pure.exampleUrl(link), exampleUrl(link), link);
    assert.equal(await pure.itemId(link), exampleId(link), link);
  }
  assert.match(await pure.itemId(LINK), /^[0-9a-f]{64}$/);
  assert.equal(await pure.itemId(LINK), await pure.itemId(`${LINK}/?utm_campaign=x`), "tracking parameters do not change the id");
});

test("sentiment correction is offered only on Blue Cross VT stories that carry sentiment", () => {
  assert.equal(pure.canCorrectSentiment(brandItem), true);
  assert.equal(pure.canCorrectSentiment(topicItem), false);
  assert.equal(pure.canCorrectSentiment({ ...brandItem, sentiment: undefined }), false);
  assert.equal(pure.canCorrectSentiment({ ...brandItem, sentiment: "mixed" }), false);
  assert.equal(pure.canCorrectSentiment({ ...brandItem, sentimentEligible: false }), false);
  assert.equal(pure.canCorrectSentiment(null), false);
  assert.deepEqual(pure.optionLabels(brandItem), ["positive", "neutral to positive", "neutral to negative", "negative"]);
  assert.equal(pure.optionLabels({ sentiment: "positive" }).length, 4);
});

test("vote bodies are valid or refused", () => {
  assert.deepEqual(pure.voteBody("keep"), { vote: "keep" });
  assert.deepEqual(pure.voteBody("drop", "positive"), { vote: "drop" });
  assert.deepEqual(pure.voteBody("sentiment", "neutral"), { vote: "sentiment", label: "neutral" });
  assert.equal(pure.voteBody("sentiment"), null);
  assert.equal(pure.voteBody("sentiment", "mixed"), null);
  assert.equal(pure.voteBody("love"), null);
  assert.equal(pure.voteText({ vote: "keep" }), "Kept");
  assert.equal(pure.voteText({ vote: "drop" }), "Dropped");
  assert.equal(pure.voteText({ vote: "sentiment", label: "negative" }), "Sentiment should be negative");
  assert.equal(pure.voteText({ vote: "sentiment", label: "bogus" }), "");
  assert.equal(pure.voteText(null), "");
});

test("only a well-formed Worker answer counts as a session", () => {
  const id = "a".repeat(64);
  const parsed = pure.parseVotesResponse({ ok: true, admin: true, votes: [
    { item: id, vote: "drop", label: null },
    { item: "b".repeat(64), vote: "sentiment", label: "negative" },
    { item: "short", vote: "drop" },
    { item: "c".repeat(64), vote: "sentiment", label: "mixed" },
    { item: "d".repeat(64), vote: "keep", label: "positive" },
    null,
  ] });
  assert.equal(parsed.admin, true);
  assert.deepEqual([...parsed.votes.keys()], [id, "b".repeat(64)]);
  for (const junk of [null, undefined, {}, { ok: false, votes: [] }, { ok: true }, { ok: true, votes: "x" }, "<html>", []]) {
    assert.equal(pure.parseVotesResponse(junk), null, JSON.stringify(junk));
  }
  assert.equal(pure.parseVotesResponse({ ok: true, votes: [] }).admin, false);
});

test("admin rows are filtered, ordered, and counted", () => {
  const row = (id, item, vote, updatedAt) => ({ id, item: item.repeat(64), vote, label: null, voter: "a@example.com", updatedAt });
  const parsed = pure.parseAdminResponse({ ok: true, votes: [
    row(1, "a", "drop", "2026-09-28T10:00:00Z"),
    row(2, "b", "keep", "2026-09-29T10:00:00Z"),
    { ...row(3, "c", "keep", "2026-09-29T11:00:00Z"), id: "3" },
    { ...row(4, "d", "keep", "2026-09-29T11:00:00Z"), voter: undefined },
    { ...row(5, "e", "keep", "2026-09-29T11:00:00Z"), item: "x" },
  ] });
  assert.deepEqual(parsed.map((entry) => entry.id), [1, 2]);
  assert.deepEqual(pure.sortAdminRows(parsed).map((entry) => entry.id), [2, 1]);
  assert.deepEqual(pure.summarizeAdminRows(parsed), { keep: 1, drop: 1, sentiment: 0 });
  assert.equal(pure.parseAdminResponse({ ok: false }), null);
});

test("only http and https links are ever linked", () => {
  assert.equal(pure.safeHref("https://vtdigger.org/x"), "https://vtdigger.org/x");
  assert.equal(pure.safeHref("javascript:alert(1)"), "");
  assert.equal(pure.safeHref("data:text/html,x"), "");
  assert.equal(pure.safeHref("nonsense"), "");
});

// ------------------------------------------------------------ browser wiring

test("a public visitor sees no change at all, whatever the Worker does", async () => {
  const responses = {
    "Worker not deployed (404 page)": () => new Response("<html>Not found</html>", { status: 404, headers: { "content-type": "text/html" } }),
    "no session (401)": () => json({ ok: false, error: "unauthorized" }, 401),
    "server error": () => new Response("oops", { status: 500 }),
    "network failure": () => { throw new TypeError("offline"); },
    "a 200 that is not the vote list": () => new Response("<html>SPA</html>", { status: 200, headers: { "content-type": "text/html" } }),
    "a 200 JSON of the wrong shape": () => json({ hello: "world" }),
  };
  for (const [name, respond] of Object.entries(responses)) {
    const t = harness(respond);
    try {
      const stories = [t.story(brandItem), t.story(topicItem)];
      const before = stories.map(({ li }) => li.textContent);
      for (const { li, item } of stories) t.api.decorate(li, item);
      await t.api.start();
      await settle();
      assert.deepEqual(stories.map(({ li }) => li.textContent), before, name);
      assert.ok(stories.every(({ li }) => li.querySelectorAll("button").length === 0), `${name}: no buttons`);
      assert.equal(t.note.hidden, true, `${name}: no footer note`);
      assert.equal(t.dt.hidden, true);
      assert.equal(t.status.textContent, "");
      assert.equal(t.store.size, 0, `${name}: nothing stored`);
      assert.deepEqual(t.requests.map((request) => request.method), ["GET"], `${name}: one quiet request`);
    } finally {
      t.restore();
    }
  }
});

test("a team session adds Keep, Drop, and Sentiment is wrong to the meta line", async () => {
  const t = harness(() => json({ ok: true, admin: false, votes: [] }));
  try {
    const brand = t.story(brandItem);
    const topic = t.story(topicItem);
    t.api.decorate(brand.li, brand.item);
    t.api.decorate(topic.li, topic.item);
    await t.api.start();
    await settle();
    assert.equal(brand.meta.textContent, "Sep 28, 2026 · VTDigger · Keep · Drop · Sentiment is wrong");
    assert.equal(topic.meta.textContent, "Sep 28, 2026 · VTDigger · Keep · Drop", "no sentiment link on a story without sentiment");
    const wrong = brand.meta.querySelector('[data-action="sentiment"]');
    assert.equal(wrong.getAttribute("aria-expanded"), "false");
    assert.equal(wrong.getAttribute("aria-label"), "Sentiment is wrong: Blue Cross VT rates");
    assert.equal(brand.meta.querySelector('[data-action="keep"]').type, "button");
    assert.equal(t.store.get("cerulean-news:team-hint:v1"), "1");
  } finally {
    t.restore();
  }
});

test("Keep saves the vote, announces it, shows Undo, and Undo removes it", async () => {
  const t = harness((url, init) => {
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      return json({ ok: true, vote: { item: url.split("/").pop(), vote: body.vote, label: body.label ?? null, updatedAt: "2026-09-29T10:00:00.000Z" } });
    }
    if (init.method === "DELETE") return json({ ok: true, deleted: true });
    return json({ ok: true, admin: false, votes: [] });
  });
  try {
    const { li, meta, item } = t.story(topicItem);
    t.api.decorate(li, item);
    await t.api.start();
    await settle();
    const id = exampleId(item.link);
    meta.querySelector('[data-action="keep"]').click();
    await settle();
    const put = t.requests.find((request) => request.method === "PUT");
    assert.equal(put.url, `/api/mail/feedback/${id}`);
    assert.deepEqual(put.body, { vote: "keep" });
    assert.equal(put.init.credentials, "same-origin");
    assert.equal(meta.textContent, "Sep 28, 2026 · VTDigger · Your vote: Kept · Undo");
    assert.equal(Node_.active, meta.querySelector('[data-action="undo"]'), "focus lands on Undo");
    assert.match(t.status.textContent, /^Kept: Hospital budgets\. It takes effect at the next update\.$/);

    meta.querySelector('[data-action="undo"]').click();
    await settle();
    assert.equal(t.requests.at(-1).method, "DELETE");
    assert.equal(t.requests.at(-1).url, `/api/mail/feedback/${id}`);
    assert.equal(meta.textContent, "Sep 28, 2026 · VTDigger · Keep · Drop");
    assert.equal(Node_.active, meta.querySelector('[data-action="keep"]'));
    assert.equal(t.status.textContent, "Vote removed: Hospital budgets.");
  } finally {
    t.restore();
  }
});

test("Sentiment is wrong reveals the other four labels, and choosing one saves it", async () => {
  const t = harness((url, init) => {
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      return json({ ok: true, vote: { item: url.split("/").pop(), vote: body.vote, label: body.label, updatedAt: "2026-09-29T10:00:00.000Z" } });
    }
    return json({ ok: true, admin: false, votes: [] });
  });
  try {
    const { li, meta, item } = t.story(brandItem);
    t.api.decorate(li, item);
    await t.api.start();
    await settle();
    assert.equal(li.querySelector(".feedback-picker"), null);
    meta.querySelector('[data-action="sentiment"]').click();
    const picker = li.querySelector(".feedback-picker");
    assert.ok(picker);
    assert.equal(picker.getAttribute("role"), "group");
    assert.deepEqual(picker.querySelectorAll("button").map((button) => button.textContent), ["positive", "neutral to positive", "neutral to negative", "negative"]);
    assert.equal(meta.querySelector('[data-action="sentiment"]').getAttribute("aria-expanded"), "true");
    assert.equal(Node_.active, picker.querySelector("button"), "focus moves into the labels");
    picker.querySelectorAll("button")[3].click();
    await settle();
    assert.deepEqual(t.requests.find((request) => request.method === "PUT").body, { vote: "sentiment", label: "negative" });
    assert.equal(li.querySelector(".feedback-picker"), null, "the labels close");
    assert.match(meta.textContent, /Your vote: Sentiment should be negative · Undo$/);
  } finally {
    t.restore();
  }
});

test("Escape closes the labels and returns focus to Sentiment is wrong", async () => {
  const t = harness(() => json({ ok: true, admin: false, votes: [] }));
  try {
    const { li, meta, item } = t.story(brandItem);
    t.api.decorate(li, item);
    await t.api.start();
    await settle();
    meta.querySelector('[data-action="sentiment"]').click();
    const picker = li.querySelector(".feedback-picker");
    let prevented = false;
    for (const handler of picker.listeners.keydown) handler({ key: "Escape", preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(li.querySelector(".feedback-picker"), null);
    assert.equal(Node_.active, meta.querySelector('[data-action="sentiment"]'));
  } finally {
    t.restore();
  }
});

test("an existing vote shows with Undo, and only for that story", async () => {
  const id = exampleId(topicItem.link);
  const t = harness(() => json({ ok: true, admin: false, votes: [{ item: id, vote: "drop", label: null, updatedAt: "2026-09-29T10:00:00Z" }] }));
  try {
    const dropped = t.story(topicItem);
    const other = t.story(brandItem);
    t.api.decorate(dropped.li, dropped.item);
    t.api.decorate(other.li, other.item);
    await t.api.start();
    await settle();
    assert.equal(dropped.meta.textContent, "Sep 28, 2026 · VTDigger · Your vote: Dropped · Undo");
    assert.equal(other.meta.textContent, "Sep 28, 2026 · VTDigger · Keep · Drop · Sentiment is wrong");
  } finally {
    t.restore();
  }
});

test("a failed save says so, and a lost session removes the controls", async () => {
  let mode = "fail";
  const t = harness((url, init) => {
    if (init.method === "PUT") return mode === "fail" ? json({ ok: false }, 500) : json({ ok: false, error: "unauthorized" }, 401);
    return json({ ok: true, admin: false, votes: [] });
  });
  try {
    const { li, meta, item } = t.story(topicItem);
    t.api.decorate(li, item);
    await t.api.start();
    await settle();
    meta.querySelector('[data-action="drop"]').click();
    await settle();
    assert.equal(t.status.textContent, "Could not save your vote. Try again in a moment.");
    assert.equal(meta.textContent, "Sep 28, 2026 · VTDigger · Keep · Drop", "no vote is shown that was not saved");
    mode = "expired";
    meta.querySelector('[data-action="drop"]').click();
    await settle();
    assert.equal(meta.textContent, "Sep 28, 2026 · VTDigger");
    assert.match(t.status.textContent, /^Your team sign-in has ended\./);
    assert.equal(t.note.querySelector("a").href, "/api/mail/team/signin", "the footer offers sign-in again");
  } finally {
    t.restore();
  }
});

test("the footer note shows sign out, and admins get the votes page", async () => {
  const t = harness((url, init) => (init.method === "POST" ? json({ ok: true }) : json({ ok: true, admin: true, votes: [] })));
  try {
    const { li, meta, item } = t.story(topicItem);
    t.api.decorate(li, item);
    await t.api.start();
    await settle();
    assert.equal(t.note.hidden, false);
    assert.equal(t.dt.hidden, false);
    assert.equal(t.note.textContent, "Signed in for team feedback. All votes · Sign out");
    assert.equal(t.note.querySelector("a").href, "feedback-admin");
    t.note.querySelector("button").click();
    await settle();
    assert.equal(t.requests.at(-1).url, "/api/mail/team/signout");
    assert.equal(t.requests.at(-1).method, "POST");
    assert.equal(meta.textContent, "Sep 28, 2026 · VTDigger");
    assert.equal(t.note.hidden, true, "no sign-in link is left behind on an explicit sign out");
    assert.equal(t.status.textContent, "Signed out of team feedback.");
  } finally {
    t.restore();
  }
});

test("values from the feed reach the page as text, never as markup", async () => {
  const t = harness(() => json({ ok: true, admin: false, votes: [] }));
  try {
    const hostile = { ...brandItem, title: '<img src=x onerror="alert(1)">', link: "https://vtdigger.org/x" };
    const { li, meta, item } = t.story(hostile);
    t.api.decorate(li, item);
    await t.api.start();
    await settle();
    const label = meta.querySelector('[data-action="keep"]').getAttribute("aria-label");
    assert.equal(label, 'Keep: <img src=x onerror="alert(1)">', "carried as an attribute string, inert");
    assert.ok(!meta.querySelectorAll("img").length);
  } finally {
    t.restore();
  }
});

// ------------------------------------------------------------- admin page

test("the admin page lists votes with the voter and undoes one", async () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  const list = new Node_("ul");
  const status = new Node_("p");
  const summary = new Node_("p");
  const message = new Node_("p");
  const body = new Node_("body");
  body.root = true;
  body.append(list, status, summary, message);
  const requests = [];
  const feed = { items: [{ title: "Hospital <b>budgets</b>", link: topicItem.link, outlet: "VTDigger" }] };
  const rows = [
    { id: 7, item: exampleId(topicItem.link), vote: "drop", label: null, voter: "jane@example.com", voterBlocked: false, updatedAt: "2026-09-29T10:00:00.000Z" },
    { id: 8, item: b, vote: "sentiment", label: "positive", voter: "sam@example.com", voterBlocked: true, updatedAt: "2026-09-29T11:00:00.000Z" },
  ];
  const fetchFake = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET" });
    if (String(url) === "/api/mail/feedback/admin") return json({ ok: true, votes: rows });
    if (String(url) === "/api/mail/feedback/admin/7" && init.method === "DELETE") return json({ ok: true, deleted: true });
    if (String(url) === "feed.json") return json(feed);
    if (String(url) === "feed-audit.json") return json({ items: [] });
    return new Response("no", { status: 404 });
  };
  const window = { setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {}, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } };
  const { api, restore } = loadScript({ window, document: { createElement: (tag) => new Node_(tag), getElementById: () => null }, fetch: fetchFake });
  try {
    await api.mountAdmin({ list, status, summary, message });
    assert.equal(summary.textContent, "2 current votes: 1 drop, 0 keep, 1 sentiment.");
    const [first, second] = list.children;
    assert.match(first.textContent, /^Story bbbbbbbbbb/, "an unknown story shows its short id");
    assert.match(first.textContent, /Sentiment should be positive · sam@example\.com \(blocked\)/);
    assert.match(second.textContent, /^Hospital <b>budgets<\/b>/, "the title is text, not markup");
    assert.match(second.textContent, /Dropped · jane@example\.com/);
    assert.ok(requests.some((request) => request.url === "feed-audit.json"), "the large audit file is fetched for the story the feed lacks");
    second.querySelector("button").click();
    await settle();
    assert.equal(requests.at(-1).url, "/api/mail/feedback/admin/7");
    assert.equal(list.children.length, 1);
    assert.match(status.textContent, /^Vote removed\. 1 vote left\.$/);
  } finally {
    restore();
  }
});

test("the admin page explains a missing sign-in, a non-admin, and a missing service", async () => {
  const cases = [
    [() => json({ ok: false }, 401), /Sign in with a team or admin address/],
    [() => json({ ok: false }, 403), /This page is for admins\./],
    [() => new Response("<html>", { status: 404, headers: { "content-type": "text/html" } }), /not available right now/],
    [() => { throw new TypeError("offline"); }, /not available right now/],
  ];
  for (const [respond, expected] of cases) {
    const message = new Node_("p");
    const window = { setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {} };
    const { api, restore } = loadScript({ window, document: { createElement: (tag) => new Node_(tag) }, fetch: async () => respond() });
    try {
      await api.mountAdmin({ list: new Node_("ul"), status: new Node_("p"), summary: new Node_("p"), message });
      assert.match(message.textContent, expected);
    } finally {
      restore();
    }
  }
});

// ------------------------------------------------------------ page markup

const read = (name) => fs.readFileSync(new URL(`../site/${name}`, import.meta.url), "utf8");

test("every reader edit sits inside feedback markers, and the page stays light and gated", () => {
  const html = read("index.html");
  const marks = [...html.matchAll(/(?:<!--|\/\/) (\/?)feature: feedback\b/g)];
  assert.ok(marks.length >= 12 && marks.length % 2 === 0, "balanced feature markers");
  let depth = 0;
  for (const [, closing] of marks) {
    depth += closing ? -1 : 1;
    assert.ok(depth === 0 || depth === 1, "markers do not nest");
  }
  assert.equal(depth, 0);
  // Outside the markers there is no trace of the feature.
  const outside = html
    .replace(/<!-- feature: feedback[\s\S]*?<!-- \/feature: feedback -->/g, "")
    .replace(/\/\/ feature: feedback[\s\S]*?\/\/ \/feature: feedback/g, "");
  assert.ok(!/feedback/i.test(outside), "no feedback code outside the markers");
  assert.ok(html.includes('<script src="feedback.js"></script>'));
  assert.ok(html.includes('id="team-note" hidden'), "the footer note is hidden by default");
  assert.ok(!/prefers-color-scheme/.test(read("feedback.js") + read("feedback-admin.html")), "light only");
  assert.ok(html.indexOf("feedback.js") < html.indexOf("CeruleanFeedback.start()"), "the script loads before it is used");
});

test("the admin page carries the gate, stays out of search and the sitemap, and follows the site's frame", () => {
  const page = read("feedback-admin.html");
  assert.ok(page.includes('<link rel="stylesheet" href="gate.css">'));
  assert.ok(page.includes('localStorage.getItem("blueNewsAuth")'));
  assert.ok(page.indexOf('<script src="gate.js"></script>') > page.indexOf("<body>"));
  assert.ok(page.indexOf('<script src="gate.js"></script>') < page.indexOf('class="page"'));
  assert.match(page, /<meta name="robots" content="noindex, nofollow">/);
  assert.ok(!/rel="canonical"/.test(page));
  assert.ok(page.includes('<a class="button" href="./">Back to stories</a>'));
  assert.ok(page.includes("<strong>Not affiliated.</strong>"));
  assert.ok(!/feedback-admin/.test(read("sitemap.xml")), "not in the sitemap");
  assert.ok(!/feedback-admin/.test(read("robots.txt")), "robots.txt does not advertise it");
});
