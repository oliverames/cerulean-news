// Password gate, restored 2026-09-28 at Oliver's request.
// A PRESENTATION gate only, not security: the feeds stay public, and anyone
// can bypass a check that runs in the browser. It keeps the pages from
// greeting a casual visitor. The password itself is not in this file, only
// its SHA-256 hash. Oliver changed the password on 2026-10-06.
// Every gated page loads gate.css in <head>, runs the one-line early check
// that sets html.authenticated for a returning visitor, and loads this file
// at the start of <body>. Pages that must stay open (subscribe, unsubscribe)
// simply do not include it.
(function () {
  const PASSWORD_SHA256 = "7d8ab1a9d93287a2cb62a4e8a78c71e147727b5dba00fbb324387b658fbc8666";
  const STORAGE_KEY = "blueNewsAuth";
  const waiting = [];
  let unlocked = false;

  function stored() {
    try { return localStorage.getItem(STORAGE_KEY) === "true"; } catch { return false; }
  }
  function remember() {
    try { localStorage.setItem(STORAGE_KEY, "true"); } catch { /* storage blocked */ }
  }
  async function sha256Hex(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  function pages() { return document.querySelectorAll(".page"); }
  function finish({ focus = false } = {}) {
    unlocked = true;
    document.documentElement.classList.add("authenticated");
    document.getElementById("password-gate")?.remove();
    for (const page of pages()) {
      page.removeAttribute("inert");
      page.removeAttribute("aria-hidden");
    }
    if (focus) document.querySelector(".page h1[tabindex], .page h1")?.focus?.({ preventScroll: true });
    while (waiting.length) {
      try { waiting.shift()(); } catch (error) { console.error(error); }
    }
  }

  // Runs a callback once the page is visible, which matters for code that
  // measures layout (the trends charts size themselves to the column).
  window.CeruleanGate = {
    whenUnlocked(callback) { if (unlocked) callback(); else waiting.push(callback); },
  };

  if (stored()) { finish(); return; }

  for (const page of pages()) {
    page.setAttribute("inert", "");
    page.setAttribute("aria-hidden", "true");
  }
  const gate = document.createElement("div");
  gate.className = "password-gate";
  gate.id = "password-gate";
  gate.setAttribute("role", "dialog");
  gate.setAttribute("aria-modal", "true");
  gate.setAttribute("aria-labelledby", "password-gate-title");
  gate.setAttribute("aria-describedby", "password-gate-description");
  gate.innerHTML = `
    <div class="password-card">
      <div class="tricolor" aria-hidden="true"><span class="c1"></span><span class="c2"></span><span class="c3"></span></div>
      <h1 id="password-gate-title">Cerulean News</h1>
      <p id="password-gate-description">This page is password protected. Enter the password to continue.</p>
      <form class="password-form" id="password-form" autocomplete="off">
        <label class="visually-hidden" for="password-input">Password</label>
        <input type="password" id="password-input" name="password" placeholder="Enter password"
          autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"
          aria-describedby="password-error" aria-invalid="false">
        <button type="submit">Enter</button>
        <p class="password-error" id="password-error" role="alert">Incorrect password</p>
      </form>
    </div>`;
  document.body.prepend(gate);
  const form = gate.querySelector("form");
  const input = gate.querySelector("input");
  const errorEl = gate.querySelector("#password-error");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const entered = (input.value || "").trim().toLowerCase();
    if (entered && (await sha256Hex(entered)) === PASSWORD_SHA256) {
      remember();
      finish({ focus: true });
    } else {
      errorEl.classList.add("visible");
      input.setAttribute("aria-invalid", "true");
      input.value = "";
      input.focus();
    }
  });
  input.addEventListener("input", () => {
    errorEl.classList.remove("visible");
    input.setAttribute("aria-invalid", "false");
  });
  window.setTimeout(() => input.focus(), 60);
})();
