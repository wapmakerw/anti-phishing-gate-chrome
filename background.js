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
    var excludedDomains = uniq(trustedList.concat(allowed));
    
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

chrome.tabs.onRemoved.addListener(function (tabId) { unguard(tabId); });

// ----------------------------------------------------------------------------
// Blocked Navigation Interception
// ----------------------------------------------------------------------------

chrome.webNavigation.onErrorOccurred.addListener(function (details) {
  if (details.frameId !== 0) return;
  if (details.error === "net::ERR_BLOCKED_BY_CLIENT") {
    var blockedUrl = details.url;
    var host = hostOf(blockedUrl);
    
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
