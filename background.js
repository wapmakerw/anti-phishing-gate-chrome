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

// DNR session-rule ids (we keep exactly these two and rebuild them as needed).
var ALLOW_RULE_ID = 1;
var REDIRECT_RULE_ID = 2;

var CONFIRM_URL = chrome.runtime.getURL("confirm/confirm.html");
var EXT_ORIGIN = chrome.runtime.getURL("");

// In-memory guard state (session scoped).
var guardedTabs = new Set();      // tab ids whose navigation we gate
var sessionAllowed = new Set();   // domains authorized this session ("once")
var trustedList = [];             // cached copy of TRUSTED_KEY

function hostOf(url) {
  try { return new URL(url).hostname; } catch (e) { return ""; }
}
function domainOf(url) {
  return domainLib.registrableDomain(hostOf(url));
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
  var domain = /^https?:/i.test(url || "") ? domainOf(url) : null;
  chrome.storage.local.get(SANDBOX_KEY, function (data) {
    var list = (data && data[SANDBOX_KEY]) || [];
    var on = domain && list.indexOf(domain) !== -1;
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

function loadTrusted(cb) {
  chrome.storage.local.get(TRUSTED_KEY, function (data) {
    trustedList = (data && data[TRUSTED_KEY]) || [];
    if (cb) cb();
  });
}

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local") return;
  if (changes[SANDBOX_KEY]) refreshActiveTab();
  if (changes[TRUSTED_KEY]) {
    trustedList = changes[TRUSTED_KEY].newValue || [];
    rebuildRules(); // newly trusted domains stop being gated
  }
});

// ----------------------------------------------------------------------------
// declarativeNetRequest gating rules
// ----------------------------------------------------------------------------

// ALLOW (high priority): trusted + session-allowed domains load normally in
// guarded tabs. REDIRECT (low priority): everything else main-frame in a
// guarded tab is sent to the confirmation page, with the blocked URL appended
// raw after "?d=" (parsed by substring, not URLSearchParams).
function rebuildRules() {
  var tabIds = Array.from(guardedTabs);
  var addRules = [];

  if (tabIds.length) {
    var allowDomains = uniq(trustedList.concat(Array.from(sessionAllowed)));
    if (allowDomains.length) {
      addRules.push({
        id: ALLOW_RULE_ID,
        priority: 100,
        action: { type: "allow" },
        condition: {
          resourceTypes: ["main_frame"],
          tabIds: tabIds,
          requestDomains: allowDomains
        }
      });
    }
    addRules.push({
      id: REDIRECT_RULE_ID,
      priority: 10,
      action: {
        type: "redirect",
        redirect: { regexSubstitution: CONFIRM_URL + "?d=\\1" }
      },
      condition: {
        resourceTypes: ["main_frame"],
        tabIds: tabIds,
        regexFilter: "^(https?:\\/\\/.*)$"
      }
    });
  }

  return chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ALLOW_RULE_ID, REDIRECT_RULE_ID],
    addRules: addRules
  });
}

function unguard(tabId) {
  if (guardedTabs.delete(tabId)) rebuildRules();
}

// Stop guarding once a guarded tab successfully lands on a real http(s) page
// (i.e. a request that was allowed through, not our confirmation interstitial).
chrome.webNavigation.onCompleted.addListener(function (d) {
  if (d.frameId !== 0 || !guardedTabs.has(d.tabId)) return;
  if (!/^https?:/i.test(d.url)) return;               // about:blank, etc.
  if (d.url.indexOf(EXT_ORIGIN) === 0) return;        // the confirmation page
  unguard(d.tabId);
});

chrome.tabs.onRemoved.addListener(function (tabId) { unguard(tabId); });

// ----------------------------------------------------------------------------
// Messages from the content script (open) and confirmation page (allow/cancel)
// ----------------------------------------------------------------------------

async function guardedOpen(targetUrl) {
  var destDomain = domainOf(targetUrl);
  // Open a blank window first so the guard rules are active BEFORE the real
  // navigation begins (avoids a race where the target loads ungated).
  var win = await chrome.windows.create({ url: "about:blank", focused: true });
  var tabId = win && win.tabs && win.tabs[0] && win.tabs[0].id;
  if (tabId == null) return;

  guardedTabs.add(tabId);
  if (destDomain) sessionAllowed.add(destDomain); // user already validated it
  await rebuildRules();
  await chrome.tabs.update(tabId, { url: targetUrl });
}

async function allowDomain(domain, target, tabId, always) {
  if (domain) sessionAllowed.add(domain);
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

async function cancelGuard(tabId) {
  if (tabId != null) {
    guardedTabs.delete(tabId);
    await rebuildRules();
    try { await chrome.tabs.remove(tabId); } catch (e) {}
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return;
  if (msg.type === "guardedOpen" && msg.url) {
    guardedOpen(msg.url).then(function () { sendResponse({ ok: true }); },
      function (e) { sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
  if (msg.type === "allowDomain") {
    allowDomain(msg.domain, msg.target, msg.tabId, !!msg.always)
      .then(function () { sendResponse({ ok: true }); },
        function (e) { sendResponse({ ok: false, error: String(e) }); });
    return true;
  }
  if (msg.type === "cancelGuard") {
    cancelGuard(msg.tabId).then(function () { sendResponse({ ok: true }); },
      function () { sendResponse({ ok: false }); });
    return true;
  }
});

// ----------------------------------------------------------------------------
// Init
// ----------------------------------------------------------------------------

function init() {
  loadTrusted(rebuildRules);
  refreshActiveTab();
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
init();
