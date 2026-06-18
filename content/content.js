/*
 * Content script — runs on every page, but only *activates* when the page's
 * full host is in the user's sandbox list.
 *
 * Anti-phishing flow: on a sandboxed page, when a link would open a different
 * domain in a NEW WINDOW, we block it and show a confirmation modal. The
 * "Open external site" button is disabled for 5 seconds (forced pause) and then
 * enabled. The link is NOT navigated, transformed, or fetched here — the
 * background worker opens the URL verbatim in a guarded window and asks for
 * confirmation of each untrusted domain it redirects through (see
 * background.js). The modal also lets you trust the destination domain outright
 * (with a confirmation step).
 */
(function () {
  "use strict";

  var SANDBOX_KEY = "sandboxDomains";
  var TRUSTED_KEY = "trustedDomains";
  var OPEN_DELAY_SECONDS = 5;
  var lib = self.SandboxDomain;
  var currentHost = lib.hostOf(location.hostname);
  var active = false;
  var trusted = [];
  var modalOpen = false;

  // --- activation / trust state --------------------------------------------

  chrome.storage.local.get([SANDBOX_KEY, TRUSTED_KEY], function (data) {
    data = data || {};
    active = ((data[SANDBOX_KEY]) || []).indexOf(currentHost) !== -1;
    trusted = (data[TRUSTED_KEY]) || [];
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") return;
    if (changes[SANDBOX_KEY]) {
      active = (changes[SANDBOX_KEY].newValue || []).indexOf(currentHost) !== -1;
    }
    if (changes[TRUSTED_KEY]) trusted = changes[TRUSTED_KEY].newValue || [];
  });

  function isTrusted(host) { return trusted.indexOf(host) !== -1; }

  // --- link interception ---------------------------------------------------

  function opensNewWindow(anchor, event) {
    var t = (anchor.target || "").toLowerCase();
    if (t === "_blank" || t === "_new") return true;
    if (event.metaKey || event.ctrlKey || event.shiftKey) return true;
    if (event.button === 1) return true;
    return false;
  }

  function handle(event) {
    if (!active || modalOpen) return;
    var anchor = event.target && event.target.closest
      ? event.target.closest("a[href]") : null;
    if (!anchor) return;

    var url = anchor.href;
    if (!/^https?:/i.test(url)) return; // ignore mailto:, tel:, javascript:, #fragments
    if (!lib.isExternalHost(url, location.hostname)) return;
    if (!opensNewWindow(anchor, event)) return;

    // The URL is used verbatim — never transformed, fetched, or pre-navigated.
    var destHost = lib.hostOf(url);
    if (isTrusted(destHost)) return;

    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();

    openModal(url);
  }

  document.addEventListener("click", handle, true);
  document.addEventListener("auxclick", handle, true);

  // --- confirmation modal --------------------------------------------------

  function openModal(clickedUrl) {
    modalOpen = true;

    var destHost = lib.hostOf(clickedUrl);
    var destTrusted = isTrusted(destHost);

    var overlay = el("div", "slg-overlay");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    var card = el("div", "slg-card");

    var title = el("div", "slg-title", "Leaving a trusted site");
    var body = el("div", "slg-body");
    body.appendChild(el("p", "slg-lead",
      "This link opens in a new window. You'll be asked to confirm each " +
      "untrusted domain it redirects through before any page loads."));

    var fromRow = el("div", "slg-row");
    fromRow.appendChild(el("span", "slg-label", "From (trusted)"));
    fromRow.appendChild(el("span", "slg-value slg-from", currentHost));

    var toRow = el("div", "slg-row");
    toRow.appendChild(el("span", "slg-label", "Going to"));
    var toVal = el("span", "slg-value");
    toVal.appendChild(el("span", null, destHost));
    var badge = el("span", "slg-badge " + (destTrusted ? "slg-badge-ok" : "slg-badge-warn"),
      destTrusted ? "trusted" : "not trusted");
    toVal.appendChild(badge);
    if (!destTrusted) toVal.appendChild(buildTrustControl(destHost, badge));
    toRow.appendChild(toVal);

    body.appendChild(fromRow);
    body.appendChild(toRow);

    var full = el("div", "slg-full", clickedUrl);
    full.title = clickedUrl;
    body.appendChild(full);

    var actions = el("div", "slg-actions");
    var cancel = el("button", "slg-btn slg-cancel", "Stay here");
    var confirm = el("button", "slg-btn slg-confirm slg-wait");
    actions.appendChild(cancel);
    actions.appendChild(confirm);

    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(actions);
    overlay.appendChild(card);

    var countdownTimer = null;
    function close() {
      modalOpen = false;
      if (countdownTimer) clearInterval(countdownTimer);
      document.removeEventListener("keydown", onKey, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }
    function onKey(e) { if (e.key === "Escape") { e.preventDefault(); close(); } }

    // 5-second forced pause with a tiny loading animation, then enable "Open".
    var remaining = OPEN_DELAY_SECONDS;
    confirm.disabled = true;
    renderWait(confirm, remaining);
    countdownTimer = setInterval(function () {
      remaining -= 1;
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        confirm.disabled = false;
        confirm.classList.remove("slg-wait");
        confirm.textContent = "Open external site";
      } else {
        renderWait(confirm, remaining);
      }
    }, 1000);

    cancel.addEventListener("click", function (e) { e.preventDefault(); close(); });
    confirm.addEventListener("click", function (e) {
      e.preventDefault();
      if (confirm.disabled) return;
      close();
      // Background opens it in a guarded window — no navigation happens here,
      // and the URL is passed verbatim (never unwrapped or pre-fetched).
      chrome.runtime.sendMessage({ type: "guardedOpen", url: clickedUrl });
    });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey, true);

    (document.body || document.documentElement).appendChild(overlay);
    cancel.focus();
  }

  function renderWait(btn, seconds) {
    btn.textContent = "";
    btn.appendChild(el("span", "slg-spinner"));
    btn.appendChild(el("span", null, " Open in " + seconds + "s"));
  }

  // "Trust" button for the destination domain. Requires an explicit
  // confirmation step before the domain is added to the trusted list.
  function buildTrustControl(domain, badgeEl) {
    var wrap = el("span", "slg-trust-wrap");
    var trustBtn = el("button", "slg-btn-mini slg-trust", "Trust");

    trustBtn.addEventListener("click", function (e) {
      e.preventDefault();
      wrap.innerHTML = "";
      wrap.appendChild(el("span", "slg-confirm-text", "Always trust " + domain + "?"));
      var yes = el("button", "slg-btn-mini slg-trust", "Yes");
      var no = el("button", "slg-btn-mini slg-cancel-mini", "No");
      wrap.appendChild(yes);
      wrap.appendChild(no);

      no.addEventListener("click", function (ev) {
        ev.preventDefault();
        wrap.innerHTML = "";
        wrap.appendChild(trustBtn);
      });
      yes.addEventListener("click", function (ev) {
        ev.preventDefault();
        addTrusted(domain, function () {
          badgeEl.className = "slg-badge slg-badge-ok";
          badgeEl.textContent = "trusted";
          if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        });
      });
    });

    wrap.appendChild(trustBtn);
    return wrap;
  }

  function addTrusted(domain, cb) {
    chrome.storage.local.get(TRUSTED_KEY, function (data) {
      var list = (data && data[TRUSTED_KEY]) || [];
      if (list.indexOf(domain) === -1) list = list.concat([domain]);
      var obj = {};
      obj[TRUSTED_KEY] = list;
      chrome.storage.local.set(obj, function () {
        trusted = list;
        if (cb) cb();
      });
    });
  }

  // --- tiny DOM helper -----------------------------------------------------

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  }
})();
