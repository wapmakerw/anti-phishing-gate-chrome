/* Background service worker.
 *
 * Two responsibilities:
 *   1. Toolbar badge — show "ON" when the active tab's domain is sandboxed.
 *   2. Guarded navigation — when the user confirms opening an external link
 *      from a sandboxed page, we open it in a NEW WINDOW that we "guard":
 *      every main-frame request to a non-trusted domain (including each HTTP
 *      redirect hop) is intercepted by a declarativeNetRequest rule and
 *      redirected to our in-extension confirmation page BEFORE it loads. The
 *      user authorizes each untrusted domain as the browser actually navigates;
 *      once it lands on an allowed HTML page, guarding stops.
 *
 * Why declarativeNetRequest: in MV3 a normal extension can't block webRequests
 * or read a redirect's Location header, and webNavigation doesn't fire per
 * HTTP-redirect hop. DNR is the only API that can gate every main-frame hop.
 */

importScripts("lib/domain.js");

var SANDBOX_KEY = "sandboxDomains";
var TRUSTED_KEY = "trustedDomains";
var domainLib = self.SandboxDomain;

// DNR session-rule ids
var BLOCK_GUARDED_RULE_ID = 2;
var BLOCK_SANDBOX_RULE_ID = 3;

var CONFIRM_URL = chrome.runtime.getURL("confirm/confirm.html");

// In-memory guard state (session scoped).
var guardedTabs = new Set();      // tab ids whose navigation we gate
var sessionAllowed = {};          // tabId -> Set of domains authorized this session
var tabOriginHost = {};           // tabId -> last committed main-frame host
var pendingSandboxNav = {};       // tabId -> sandbox host a pending navigation aims at
var sandboxList = [];             // cached copy of SANDBOX_KEY
var trustedList = [];             // cached copy of TRUSTED_KEY

function hostOf(url) {
  return domainLib.hostOf(url);
}
function uniq(arr) {
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    if (arr[i] && out.indexOf(arr[i]) === -1) out.push(arr[i]);
  }
  return out;
}

// True when `host` equals or is a subdomain of any entry in `list` — matching
// the way declarativeNetRequest treats requestDomains (host + its subdomains).
function hostMatches(host, list) {
  if (!host) return false;
  for (var i = 0; i < list.length; i++) {
    var d = list[i];
    if (d && (host === d || host.slice(-(d.length + 1)) === "." + d)) return true;
  }
  return false;
}

// A destination that should never be gated for this tab: a sandboxed host
// itself, an always-trusted host, or one allowed "just once" this session.
function isAllowedDestination(host, tabId) {
  if (hostMatches(host, sandboxList) || hostMatches(host, trustedList)) return true;
  var allowed = sessionAllowed[tabId];
  return Boolean(allowed && allowed.has(host));
}

// ----------------------------------------------------------------------------
// Badge
// ----------------------------------------------------------------------------

function updateBadge(tabId, url) {
  var host = /^https?:/i.test(url || "") ? hostOf(url) : null;
  chrome.storage.local.get(SANDBOX_KEY, function (data) {
    var list = (data && data[SANDBOX_KEY]) || [];
    var on = host && list.indexOf(host) !== -1;
    chrome.action.setBadgeText({ tabId: tabId, text: on ? "ON" : "" });
    if (on) chrome.action.setBadgeBackgroundColor({ tabId: tabId, color: "#166534" });
  });
}

function refreshActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (tab) updateBadge(tab.id, tab.url);
  });
}

chrome.tabs.onActivated.addListener(function (info) {
  chrome.tabs.get(info.tabId, function (tab) {
    if (chrome.runtime.lastError || !tab) return;
    updateBadge(tab.id, tab.url);
  });
});

chrome.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
  if (changeInfo.url || changeInfo.status === "complete") updateBadge(tabId, tab.url);
});

// ----------------------------------------------------------------------------
// Trusted-list cache
// ----------------------------------------------------------------------------

function loadSandboxAndTrusted(cb) {
  chrome.storage.local.get([SANDBOX_KEY, TRUSTED_KEY], function (data) {
    sandboxList = (data && data[SANDBOX_KEY]) || [];
    trustedList = (data && data[TRUSTED_KEY]) || [];
    if (cb) cb();
  });
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local") return;
  if (changes[SANDBOX_KEY]) {
    sandboxList = changes[SANDBOX_KEY].newValue || [];
    refreshActiveTab();
    rebuildRules();
  }
  if (changes[TRUSTED_KEY]) {
    var oldVal = changes[TRUSTED_KEY].oldValue || [];
    var newVal = changes[TRUSTED_KEY].newValue || [];
    var changed = false;
    if (newVal.length !== trustedList.length) {
      changed = true;
    } else {
      for (var i = 0; i < newVal.length; i++) {
        if (trustedList.indexOf(newVal[i]) === -1) {
          changed = true;
          break;
        }
      }
    }
    for (var i = 0; i < oldVal.length; i++) {
      if (newVal.indexOf(oldVal[i]) === -1) {
        for (var tabId in sessionAllowed) {
          if (sessionAllowed[tabId]) {
            sessionAllowed[tabId].delete(oldVal[i]);
          }
        }
      }
    }
    if (changed) {
      trustedList = newVal;
      rebuildRules(); // newly trusted domains stop being gated
    }
  }
});

// ----------------------------------------------------------------------------
// declarativeNetRequest gating rules
// ----------------------------------------------------------------------------

async function rebuildRules() {
  var tabIds = Array.from(guardedTabs);
  var addRules = [];

  // 1. Guarded tabs block rules (one rule per guarded tab)
  for (var i = 0; i < tabIds.length; i++) {
    var tabId = tabIds[i];
    var allowed = sessionAllowed[tabId] ? Array.from(sessionAllowed[tabId]) : [];
    // Sandboxed hosts are excluded too: a guarded tab sitting ON a sandboxed
    // page must be able to load it (and navigate within it) — only the onward
    // hops to other hosts get gated.
    var excludedDomains = uniq(trustedList.concat(sandboxList).concat(allowed));
    
    var ruleId = 1000 + tabId;
    addRules.push({
      id: ruleId,
      priority: 10,
      action: { type: "block" },
      condition: {
        resourceTypes: ["main_frame"],
        tabIds: [tabId],
        excludedRequestDomains: excludedDomains
      }
    });
  }

  // 2. Initiator-based sandbox block rule
  if (sandboxList.length) {
    var excludedDomainsForSandbox = uniq(trustedList.concat(sandboxList));
    addRules.push({
      id: BLOCK_SANDBOX_RULE_ID,
      priority: 10,
      action: { type: "block" },
      condition: {
        resourceTypes: ["main_frame"],
        initiatorDomains: sandboxList,
        excludedRequestDomains: excludedDomainsForSandbox
      }
    });
  }

  // Get currently registered session rules to ensure we remove them cleanly
  var existingRules = [];
  try {
    existingRules = await chrome.declarativeNetRequest.getSessionRules();
  } catch (e) {
    // Fallback if not supported or fails
  }
  var removeRuleIds = (existingRules || []).map(function (r) { return r.id; });

  return chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: removeRuleIds,
    addRules: addRules
  });
}

function unguard(tabId) {
  delete sessionAllowed[tabId];
  if (guardedTabs.delete(tabId)) rebuildRules();
}

chrome.tabs.onRemoved.addListener(function (tabId) {
  delete tabOriginHost[tabId];
  delete pendingSandboxNav[tabId];
  unguard(tabId);
});

// ----------------------------------------------------------------------------
// Blocked Navigation Interception
// ----------------------------------------------------------------------------

chrome.webNavigation.onErrorOccurred.addListener(function (details) {
  if (details.frameId !== 0) return;
  if (details.error === "net::ERR_BLOCKED_BY_CLIENT") {
    var blockedUrl = details.url;
    var host = hostOf(blockedUrl);

    // The fast-path rule won the race for this navigation; the onCommitted
    // fallback must not also fire for it.
    delete pendingSandboxNav[details.tabId];

    // If the blocked URL is our own sandbox domain, do not prompt the user for it.
    if (host && sandboxList.indexOf(host) !== -1) {
      return;
    }

    var tabId = details.tabId;
    
    return new Promise(function (resolve) {
      chrome.tabs.get(tabId, function (tab) {
        if (!chrome.runtime.lastError && tab && tab.url) {
          var currentHost = hostOf(tab.url);
          if (currentHost && sandboxList.indexOf(currentHost) !== -1) {
            // Reset session-allowed domains for this tab on fresh navigation from sandbox
            sessionAllowed[tabId] = new Set();
          }
        }
        
        guardedTabs.add(tabId);
        resolve(rebuildRules().then(function () {
          return chrome.tabs.update(tabId, { url: CONFIRM_URL + "?d=" + encodeURIComponent(blockedUrl) });
        }));
      });
    });
  }
});

chrome.webNavigation.onCreatedNavigationTarget.addListener(function (details) {
  if (details.sourceTabId == null || details.sourceTabId === -1) return;
  var isSourceGuarded = guardedTabs.has(details.sourceTabId);
  if (isSourceGuarded) {
    guardedTabs.add(details.tabId);
    rebuildRules();
    return;
  }
  chrome.tabs.get(details.sourceTabId, function (tab) {
    if (chrome.runtime.lastError || !tab || !tab.url) return;
    var host = hostOf(tab.url);
    if (host && sandboxList.indexOf(host) !== -1) {
      guardedTabs.add(details.tabId);
      rebuildRules();
    }
  });
});

// A transition that represents the user (or the page) following a link in the
// same tab, rather than typing/bookmarking a fresh address.
function isDirectLinkTransition(transitionType, qualifiers) {
  if (transitionType === "link" || transitionType === "form_submit") return true;
  var q = qualifiers || [];
  return q.indexOf("client_redirect") !== -1 || q.indexOf("server_redirect") !== -1;
}

// Start guarding a tab (idempotent). Resets the per-tab session-allow list so a
// fresh sandbox session doesn't inherit "just once" allows from a previous one.
function guardTab(tabId) {
  if (guardedTabs.has(tabId)) return;
  sessionAllowed[tabId] = new Set();
  guardedTabs.add(tabId);
  rebuildRules();
}

// Landing ON a sandboxed domain — by ANY means: typed in the address bar, a
// bookmark, a link, or a redirect — guards the tab BEFORE the page loads. This
// is what catches a sandboxed redirector (e.g. urldefense.com) reached from the
// address bar: its onward 3xx/JS redirect is initiated with no sandbox referrer,
// so the initiator rule can't see it, but the per-tab rule (installed here,
// before the page loads) gates every hop that leaves the sandboxed host.
chrome.webNavigation.onBeforeNavigate.addListener(function (details) {
  if (details.frameId !== 0) return;
  var targetHost = hostOf(details.url);
  if (targetHost && sandboxList.indexOf(targetHost) !== -1) {
    // Fast path: install the per-tab gate before the page loads. This wins the
    // race against a *client-side* redirect (which fires after the page commits)
    // but can lose against an immediate *server-side* 3xx, so we also record the
    // intent and verify where we actually land in onCommitted below.
    pendingSandboxNav[details.tabId] = targetHost;
    guardTab(details.tabId);
  } else {
    // A fresh navigation that doesn't aim at a sandboxed host clears any stale
    // intent so the redirect fallback can't mis-fire on the next commit.
    delete pendingSandboxNav[details.tabId];
  }
});

// Same-tab direct-link gating: when a direct link/redirect LEAVES a sandboxed
// domain in the same tab, guard the tab so every redirect hop that follows is
// gated — even when this first destination is itself trusted. (The initiator
// DNR rule already gates hops while the initiator is the sandbox page; this
// covers client-side redirects fired after the link's destination has loaded,
// whose initiator is no longer the sandbox domain.)
chrome.webNavigation.onCommitted.addListener(function (details) {
  if (details.frameId !== 0) return;
  var tabId = details.tabId;
  var prevHost = tabOriginHost[tabId];
  var newHost = hostOf(details.url);
  var pendingSandbox = pendingSandboxNav[tabId];
  delete pendingSandboxNav[tabId];

  // Reliable fallback for the server-side-redirect race: we set out for a
  // sandboxed host but COMMITTED on a different, non-trusted host — the
  // sandboxed redirector bounced us before the per-tab rule could block it.
  // Gate that landing now (the page hasn't been interacted with yet).
  if (
    pendingSandbox &&
    newHost &&
    newHost !== pendingSandbox &&
    !isAllowedDestination(newHost, tabId)
  ) {
    guardTab(tabId);
    tabOriginHost[tabId] = newHost;
    chrome.tabs.update(tabId, { url: CONFIRM_URL + "?d=" + encodeURIComponent(details.url) });
    return;
  }

  // Backstop for onBeforeNavigate (the worker may have been dormant): committed
  // ON a sandboxed host -> guard.
  var landedOnSandbox = newHost && sandboxList.indexOf(newHost) !== -1;

  // Followed a direct link/redirect that LEFT a sandboxed host -> guard, so the
  // chain stays gated even when this first destination is trusted.
  var leftSandboxViaLink =
    prevHost &&
    sandboxList.indexOf(prevHost) !== -1 &&
    newHost && newHost !== prevHost &&
    isDirectLinkTransition(details.transitionType, details.transitionQualifiers);

  if (landedOnSandbox || leftSandboxViaLink) {
    guardTab(tabId);
  }

  // Remember the committed host so the next navigation knows where it came from.
  tabOriginHost[tabId] = newHost || prevHost;
});

// ----------------------------------------------------------------------------
// Messages from the confirmation page (allow/cancel)
// ----------------------------------------------------------------------------

async function allowDomain(domain, target, tabId, always) {
  if (domain && tabId != null) {
    if (!sessionAllowed[tabId]) {
      sessionAllowed[tabId] = new Set();
    }
    sessionAllowed[tabId].add(domain);
  }
  if (always && domain) {
    var data = await chrome.storage.local.get(TRUSTED_KEY);
    var list = (data && data[TRUSTED_KEY]) || [];
    if (list.indexOf(domain) === -1) {
      list = list.concat([domain]);
      await chrome.storage.local.set({ [TRUSTED_KEY]: list });
      trustedList = list;
    }
  }
  await rebuildRules();
  if (tabId != null && target) await chrome.tabs.update(tabId, { url: target });
}

function cancelGuard(tabId) {
  if (tabId == null) return;
  guardedTabs.delete(tabId);
  delete sessionAllowed[tabId];
  rebuildRules();
  chrome.tabs.goBack(tabId, function () {
    if (chrome.runtime.lastError) {
      chrome.tabs.remove(tabId, function () {
        if (chrome.runtime.lastError) {}
      });
    }
  });
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  if (msg.type === "allowDomain") {
    allowDomain(msg.domain, msg.target, msg.tabId, !!msg.always)
      .then(function () { sendResponse({ ok: true }); },
        function (e) { sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
  if (msg.type === "cancelGuard") {
    cancelGuard(msg.tabId);
    sendResponse({ ok: true });
    return true;
  }
});

// ----------------------------------------------------------------------------
// Init
// ----------------------------------------------------------------------------

function init() {
  loadSandboxAndTrusted(rebuildRules);
  refreshActiveTab();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init();
