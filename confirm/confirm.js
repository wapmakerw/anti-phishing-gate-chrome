/*
 * Interstitial shown when a guarded navigation hits a non-trusted host.
 * The blocked URL arrives appended raw after "?d=" by the DNR redirect rule
 * (so we parse by substring, NOT URLSearchParams — the target has its own
 * query string and we must not corrupt it).
 *
 * Like the in-page modal, "Continue" is gated behind a 5-second forced pause.
 */
(function () {
  "use strict";

  var lib = self.SandboxDomain;
  var DELAY_SECONDS = 5;

  // Everything after the first "d=" is the original target URL, verbatim.
  var search = location.search || "";
  var marker = search.indexOf("d=");
  var target = marker >= 0 ? decodeURIComponent(search.slice(marker + 2)) : "";
  var host = lib.hostOf(target) || target;

  var els = {
    domain: document.getElementById("domain"),
    lookalike: document.getElementById("lookalike"),
    full: document.getElementById("full"),
    always: document.getElementById("always"),
    cancel: document.getElementById("cancel"),
    cont: document.getElementById("continue")
  };

  els.domain.textContent = host || "(unknown)";
  els.full.textContent = target;
  els.full.title = target;
  document.title = "Confirm: " + (host || "navigation");

  // Extra notice when the destination host looks like a look-alike trap
  // (look-alike digits such as 0/1, or international/punycode characters).
  renderLookalike(els.lookalike, lib.confusableRisk(host));

  function renderLookalike(el, reasons) {
    if (!el || !reasons) return;
    var title = document.createElement("strong");
    title.textContent = "⚠ This domain name may be a look-alike";
    el.appendChild(title);
    var ul = document.createElement("ul");
    reasons.forEach(function (reason) {
      var li = document.createElement("li");
      li.textContent = reason;
      ul.appendChild(li);
    });
    el.appendChild(ul);
    el.hidden = false;
  }

  // "Continue" enables only once we know the tab AND the 5s pause has elapsed.
  var tabId = null;
  var waited = false;
  function refresh() {
    els.cont.disabled = !(tabId !== null && waited);
  }

  chrome.tabs.getCurrent(function (tab) {
    tabId = tab && tab.id;
    refresh();
  });

  var remaining = DELAY_SECONDS;
  renderWait(els.cont, remaining);
  var timer = setInterval(function () {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(timer);
      waited = true;
      els.cont.textContent = "Continue";
      refresh();
    } else {
      renderWait(els.cont, remaining);
    }
  }, 1000);

  function renderWait(btn, seconds) {
    btn.textContent = "";
    var sp = document.createElement("span");
    sp.className = "spinner";
    var txt = document.createElement("span");
    txt.textContent = " Continue in " + seconds + "s";
    btn.appendChild(sp);
    btn.appendChild(txt);
  }

  els.cont.addEventListener("click", function () {
    if (els.cont.disabled) return;
    els.cont.disabled = true;
    chrome.runtime.sendMessage({
      type: "allowDomain",
      domain: host,
      target: target,
      tabId: tabId,
      always: els.always.checked
    });
    // Background navigates this tab to `target`; this page goes away.
  });

  els.cancel.addEventListener("click", function () {
    chrome.runtime.sendMessage({ type: "cancelGuard", tabId: tabId });
  });
})();
