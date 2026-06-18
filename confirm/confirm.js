/*
 * Interstitial shown when a guarded navigation hits a non-trusted domain.
 * The blocked URL arrives appended raw after "?d=" by the DNR redirect rule
 * (so we parse by substring, NOT URLSearchParams — the target has its own
 * query string and we must not corrupt it).
 */
(function () {
  "use strict";

  var lib = self.SandboxDomain;

  // Everything after the first "d=" is the original target URL, verbatim.
  var search = location.search || "";
  var marker = search.indexOf("d=");
  var target = marker >= 0 ? search.slice(marker + 2) : "";

  var host, domain;
  try {
    host = new URL(target).hostname;
    domain = lib.registrableDomain(host);
  } catch (e) {
    host = target;
    domain = target;
  }

  var els = {
    domain: document.getElementById("domain"),
    full: document.getElementById("full"),
    always: document.getElementById("always"),
    cancel: document.getElementById("cancel"),
    cont: document.getElementById("continue")
  };

  els.domain.textContent = domain || "(unknown)";
  els.full.textContent = target;
  els.full.title = target;
  document.title = "Confirm: " + (domain || "navigation");

  var tabId = null;
  chrome.tabs.getCurrent(function (tab) {
    tabId = tab && tab.id;
    els.cont.disabled = false; // enable once we know which tab to drive
  });

  els.cont.addEventListener("click", function () {
    if (els.cont.disabled) return;
    els.cont.disabled = true;
    chrome.runtime.sendMessage({
      type: "allowDomain",
      domain: domain,
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
