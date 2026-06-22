const fs = require("fs");
const path = require("path");

let mockTabUrls = {};

// Mock the global chrome APIs
const mockChrome = {
  runtime: {
    getURL: jest.fn(p => `chrome-extension://mock-id/${p}`),
    onMessage: { addListener: jest.fn() },
    onInstalled: { addListener: jest.fn() },
    onStartup: { addListener: jest.fn() }
  },
  action: {
    setBadgeText: jest.fn(),
    setBadgeBackgroundColor: jest.fn()
  },
  tabs: {
    query: jest.fn((queryInfo, cb) => cb([])),
    get: jest.fn((id, cb) => cb({ id, url: mockTabUrls[id] || "" })),
    update: jest.fn(() => Promise.resolve()),
    goBack: jest.fn((id, cb) => cb && cb()),
    remove: jest.fn((id, cb) => cb && cb()),
    onActivated: { addListener: jest.fn() },
    onUpdated: { addListener: jest.fn() },
    onRemoved: { addListener: jest.fn() }
  },
  storage: {
    local: {
      get: jest.fn((keys, cb) => {
        if (typeof cb === "function") return cb({});
        return Promise.resolve({});
      }),
      set: jest.fn((obj, cb) => {
        if (typeof cb === "function") return cb();
        return Promise.resolve();
      })
    },
    onChanged: { addListener: jest.fn() }
  },
  declarativeNetRequest: {
    updateSessionRules: jest.fn(() => Promise.resolve()),
    getSessionRules: jest.fn(() => Promise.resolve([]))
  },
  webNavigation: {
    onErrorOccurred: { addListener: jest.fn() },
    onCreatedNavigationTarget: { addListener: jest.fn() },
    onCommitted: { addListener: jest.fn() },
    onBeforeNavigate: { addListener: jest.fn() }
  }
};

global.chrome = mockChrome;
global.self = global;
global.SandboxDomain = require("./lib/domain");

// Mock importScripts for background.js
global.importScripts = jest.fn(file => {
  const libCode = fs.readFileSync(path.resolve(__dirname, file), "utf8");
  eval(libCode);
});

// Load background.js code
const bgCode = fs.readFileSync(path.resolve(__dirname, "background.js"), "utf8");
eval(bgCode);

// Capture the onErrorOccurred event listener registered by background.js
const calls = mockChrome.webNavigation.onErrorOccurred.addListener.mock.calls;
const onErrorOccurredCallback = calls[calls.length - 1][0];

const storageCalls = mockChrome.storage.onChanged.addListener.mock.calls;
const storageCallback = storageCalls[storageCalls.length - 1][0];

const committedCalls = mockChrome.webNavigation.onCommitted.addListener.mock.calls;
const onCommittedCallback = committedCalls[committedCalls.length - 1][0];

const beforeNavCalls = mockChrome.webNavigation.onBeforeNavigate.addListener.mock.calls;
const onBeforeNavigateCallback = beforeNavCalls[beforeNavCalls.length - 1][0];

describe("Background Service Worker Redirect Flow", () => {
  let ruleUpdates = [];

  beforeEach(() => {
    jest.clearAllMocks();
    ruleUpdates = [];
    mockTabUrls = {};
    sandboxList = [];
    trustedList = [];
    sessionAllowed = {};
    tabOriginHost = {};

    // Capture DNR rule updates to inspect what domains are excluded
    mockChrome.declarativeNetRequest.updateSessionRules.mockImplementation(rules => {
      ruleUpdates.push(rules);
      return Promise.resolve();
    });
  });

  test("HTTP Redirect scenario: prompts user for every untrusted redirect hop", async () => {
    // Scenario: User is navigating from a sandboxed domain.
    // The initial link redirects through redirect1.com -> redirect2.com.
    // Each untrusted hop should trigger a block and redirect to confirm.html.

    const targetTabId = 42;

    // --- HOP 1: Navigation to redirect1.com ---
    // Simulate Chrome blocking navigation to redirect1.com due to DNR block rules
    await onErrorOccurredCallback({
      frameId: 0,
      tabId: targetTabId,
      url: "https://redirect1.com/link",
      error: "net::ERR_BLOCKED_BY_CLIENT"
    });

    // Verify background script updated the tab to the confirmation page for redirect1.com
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(
      targetTabId,
      expect.objectContaining({
        url: expect.stringContaining("confirm/confirm.html?d=https%3A%2F%2Fredirect1.com%2Flink")
      })
    );

    // Simulate user clicking "Continue" in the confirmation popup for redirect1.com
    // This calls allowDomain for redirect1.com
    mockChrome.tabs.update.mockClear();
    await allowDomain("redirect1.com", "https://redirect1.com/link", targetTabId);

    // Verify rules were updated to exclude redirect1.com
    const lastRuleUpdate = ruleUpdates[ruleUpdates.length - 1];
    const blockRule = lastRuleUpdate.addRules.find(r => r.id === 1000 + targetTabId);
    expect(blockRule.condition.excludedRequestDomains).toContain("redirect1.com");

    // Verify background script updated the tab to continue the navigation to redirect1.com
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(
      targetTabId,
      { url: "https://redirect1.com/link" }
    );

    // --- HOP 2: redirect1.com redirects to redirect2.com ---
    // The browser now requests redirect2.com.
    // Since redirect2.com is not in the allowed list, the DNR block rule blocks it.
    mockChrome.tabs.update.mockClear();
    await onErrorOccurredCallback({
      frameId: 0,
      tabId: targetTabId,
      url: "https://redirect2.com/landing",
      error: "net::ERR_BLOCKED_BY_CLIENT"
    });

    // Verify background script blocks redirect2.com and shows another confirmation popup
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(
      targetTabId,
      expect.objectContaining({
        url: expect.stringContaining("confirm/confirm.html?d=https%3A%2F%2Fredirect2.com%2Flanding")
      })
    );
  });

  test("Untrust domain: removes domain from sessionAllowed when removed from trusted list", async () => {
    // Simulate user trusting a domain
    await allowDomain("trusted-domain.com", "https://trusted-domain.com", 42, true);

    // Verify it is excluded
    let lastRuleUpdate = ruleUpdates[ruleUpdates.length - 1];
    let blockRule = lastRuleUpdate.addRules.find(r => r.id === 1000 + 42);
    expect(blockRule.condition.excludedRequestDomains).toContain("trusted-domain.com");

    // Simulate user untrusting the domain (removing it from storage)
    ruleUpdates = [];
    storageCallback({
      trustedDomains: {
        oldValue: ["trusted-domain.com"],
        newValue: []
      }
    }, "local");

    await new Promise(resolve => setTimeout(resolve, 0));

    // Verify it is no longer excluded
    lastRuleUpdate = ruleUpdates[ruleUpdates.length - 1];
    blockRule = lastRuleUpdate.addRules.find(r => r.id === 1000 + 42);
    expect(blockRule.condition.excludedRequestDomains).not.toContain("trusted-domain.com");
  });

  test("HTTP Redirect scenario with Always Trust: next hops are still blocked", async () => {
    const targetTabId = 99;

    // Simulate Hop 1 blocked
    await onErrorOccurredCallback({
      frameId: 0,
      tabId: targetTabId,
      url: "https://always1.com/link",
      error: "net::ERR_BLOCKED_BY_CLIENT"
    });

    mockChrome.tabs.update.mockClear();
    ruleUpdates = [];

    // Simulate clicking "Always trust" and "Continue"
    await allowDomain("always1.com", "https://always1.com/link", targetTabId, true);

    // Verify rules were updated to exclude always1.com
    let lastRuleUpdate = ruleUpdates[ruleUpdates.length - 1];
    let blockRule = lastRuleUpdate.addRules.find(r => r.id === 1000 + targetTabId);
    expect(blockRule.condition.excludedRequestDomains).toContain("always1.com");

    // Simulate storage.onChanged event that is triggered by the write
    ruleUpdates = [];
    storageCallback({
      trustedDomains: {
        oldValue: [],
        newValue: ["always1.com"]
      }
    }, "local");

    // Because trustedList was already updated, no new rules should be rebuilt (avoiding race conditions)
    expect(ruleUpdates.length).toBe(0);

    // Simulate Hop 2 to always2.com
    await onErrorOccurredCallback({
      frameId: 0,
      tabId: targetTabId,
      url: "https://always2.com/link",
      error: "net::ERR_BLOCKED_BY_CLIENT"
    });

    // Verify second hop is still blocked and triggers confirmation page
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(
      targetTabId,
      expect.objectContaining({
        url: expect.stringContaining("confirm/confirm.html?d=https%3A%2F%2Falways2.com%2Flink")
      })
    );
  });

  test("Ezoic redirect scenario: only trusted domain is trusted, others show popup", async () => {
    const targetTabId = 100;

    // 1. Navigation to r.marketing.ezoic.com is blocked
    await onErrorOccurredCallback({
      frameId: 0,
      tabId: targetTabId,
      url: "https://r.marketing.ezoic.com/mk/cl/f/sh/7nVU1aA2nfuMSqHSMTa8h0lSVGSAuk0/jKPEO9LfVeGS",
      error: "net::ERR_BLOCKED_BY_CLIENT"
    });

    // Verify it updates to confirmation page
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(
      targetTabId,
      expect.objectContaining({
        url: expect.stringContaining("confirm/confirm.html?d=https%3A%2F%2Fr.marketing.ezoic.com")
      })
    );

    mockChrome.tabs.update.mockClear();
    ruleUpdates = [];

    // 2. User trusts r.marketing.ezoic.com
    await allowDomain(
      "r.marketing.ezoic.com",
      "https://r.marketing.ezoic.com/mk/cl/f/sh/7nVU1aA2nfuMSqHSMTa8h0lSVGSAuk0/jKPEO9LfVeGS",
      targetTabId,
      true
    );

    // Verify rules exclude r.marketing.ezoic.com
    let lastRuleUpdate = ruleUpdates[ruleUpdates.length - 1];
    let blockRule = lastRuleUpdate.addRules.find(r => r.id === 1000 + targetTabId);
    expect(blockRule.condition.excludedRequestDomains).toContain("r.marketing.ezoic.com");

    // Simulate storage.onChanged (no-op now since already updated)
    ruleUpdates = [];
    storageCallback({
      trustedDomains: {
        oldValue: [],
        newValue: ["r.marketing.ezoic.com"]
      }
    }, "local");
    expect(ruleUpdates.length).toBe(0);

    // 3. Page redirects via JS to www.adweek.com (which should be blocked)
    await onErrorOccurredCallback({
      frameId: 0,
      tabId: targetTabId,
      url: "https://www.adweek.com/media/how-ranker-grew-revenue-fourfold-thanks-to-its-first-party-data-play/?utm_source=brevo&utm_campaign=Marketing Newsletter  no 1  MAR26  2025 &utm_medium=email&utm_id=1337",
      error: "net::ERR_BLOCKED_BY_CLIENT"
    });

    // Verify www.adweek.com is blocked and redirects to confirmation page
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(
      targetTabId,
      expect.objectContaining({
        url: expect.stringContaining("confirm/confirm.html?d=https%3A%2F%2Fwww.adweek.com")
      })
    );
  });

  test("Address-bar navigation to a sandboxed redirector guards the tab and gates the redirect", async () => {
    // urldefense.com is sandboxed; the user pastes a urldefense link in the
    // address bar (typed transition, no sandbox initiator).
    sandboxList = ["urldefense.com"];
    const tabId = 300;

    // onBeforeNavigate to the sandboxed host fires before it loads.
    onBeforeNavigateCallback({
      frameId: 0,
      tabId: tabId,
      url: "https://urldefense.com/v3/__https://evil.example/__;!!abc$"
    });

    // The tab is guarded before the page loads, and its per-tab rule excludes
    // the sandboxed host (so urldefense.com itself loads) but not other hosts.
    expect(guardedTabs.has(tabId)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    let rule = ruleUpdates[ruleUpdates.length - 1].addRules.find(r => r.id === 1000 + tabId);
    expect(rule).toBeDefined();
    expect(rule.condition.excludedRequestDomains).toContain("urldefense.com");

    // urldefense.com 302-redirects onward; the request to evil.example is on the
    // sandboxed page, so DNR blocks it and we show the confirmation page.
    mockTabUrls[tabId] = "https://urldefense.com/v3/__https://evil.example/__;!!abc$";
    mockChrome.tabs.update.mockClear();
    await onErrorOccurredCallback({
      frameId: 0,
      tabId: tabId,
      url: "https://evil.example/landing",
      error: "net::ERR_BLOCKED_BY_CLIENT"
    });
    expect(mockChrome.tabs.update).toHaveBeenCalledWith(
      tabId,
      expect.objectContaining({
        url: expect.stringContaining("confirm/confirm.html?d=https%3A%2F%2Fevil.example%2Flanding")
      })
    );
  });

  test("Committing on a sandboxed domain guards the tab (onCommitted backstop)", async () => {
    sandboxList = ["bank.com"];
    const tabId = 200;

    // The tab lands on the sandboxed page (worker missed onBeforeNavigate).
    onCommittedCallback({
      frameId: 0,
      tabId: tabId,
      url: "https://bank.com/home",
      transitionType: "typed",
      transitionQualifiers: []
    });

    // Landing on the sandboxed host guards the tab, so any onward hop is gated.
    expect(guardedTabs.has(tabId)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    const lastRuleUpdate = ruleUpdates[ruleUpdates.length - 1];
    expect(lastRuleUpdate.addRules.some(r => r.id === 1000 + tabId)).toBe(true);
  });

  test("Direct link leaving a sandboxed page guards even if the landing was missed", async () => {
    sandboxList = ["bank.com"];
    const tabId = 201;

    // Pretend the tab was already on the sandboxed page but never got guarded
    // (e.g. it was already open when the domain was sandboxed).
    tabOriginHost[tabId] = "bank.com";
    expect(guardedTabs.has(tabId)).toBe(false);

    // A direct link to another host in the same tab guards it.
    onCommittedCallback({
      frameId: 0, tabId, url: "https://partner.com/welcome",
      transitionType: "link", transitionQualifiers: []
    });
    expect(guardedTabs.has(tabId)).toBe(true);
  });

  test("Navigations that never touch a sandboxed host do not guard the tab", async () => {
    sandboxList = ["bank.com"];
    const tabId = 202;

    onCommittedCallback({
      frameId: 0, tabId, url: "https://example.com/",
      transitionType: "typed", transitionQualifiers: []
    });
    onCommittedCallback({
      frameId: 0, tabId, url: "https://example.com/page",
      transitionType: "link", transitionQualifiers: []
    });
    onCommittedCallback({
      frameId: 0, tabId, url: "https://other.com/",
      transitionType: "link", transitionQualifiers: []
    });
    expect(guardedTabs.has(tabId)).toBe(false);
  });

  test("Tab isolation and navigation reset scenario", async () => {
    // Enable a sandbox domain
    sandboxList = ["sandbox.com"];

    const tab1 = 101;
    const tab2 = 102;

    // Simulate Tab 1 starting navigation from sandbox
    mockTabUrls[tab1] = "https://sandbox.com/page1";
    await onErrorOccurredCallback({
      frameId: 0,
      tabId: tab1,
      url: "https://domain1.com/link",
      error: "net::ERR_BLOCKED_BY_CLIENT"
    });

    // Tab 1 allows domain1.com
    await allowDomain("domain1.com", "https://domain1.com/link", tab1);

    // Verify Tab 1 excludes domain1.com
    let lastRuleUpdate = ruleUpdates[ruleUpdates.length - 1];
    let tab1Rule = lastRuleUpdate.addRules.find(r => r.id === 1000 + tab1);
    expect(tab1Rule.condition.excludedRequestDomains).toContain("domain1.com");

    // Simulate Tab 2 starting navigation from sandbox
    mockTabUrls[tab2] = "https://sandbox.com/page2";
    await onErrorOccurredCallback({
      frameId: 0,
      tabId: tab2,
      url: "https://domain2.com/link",
      error: "net::ERR_BLOCKED_BY_CLIENT"
    });

    // Tab 2 allows domain2.com
    await allowDomain("domain2.com", "https://domain2.com/link", tab2);

    // Verify Tab 2 excludes domain2.com but NOT domain1.com (tab isolation)
    lastRuleUpdate = ruleUpdates[ruleUpdates.length - 1];
    let tab2Rule = lastRuleUpdate.addRules.find(r => r.id === 1000 + tab2);
    expect(tab2Rule.condition.excludedRequestDomains).toContain("domain2.com");
    expect(tab2Rule.condition.excludedRequestDomains).not.toContain("domain1.com");

    // Verify Tab 1 still excludes domain1.com and NOT domain2.com
    tab1Rule = lastRuleUpdate.addRules.find(r => r.id === 1000 + tab1);
    expect(tab1Rule.condition.excludedRequestDomains).toContain("domain1.com");
    expect(tab1Rule.condition.excludedRequestDomains).not.toContain("domain2.com");

    // Simulate Tab 1 navigating back to sandbox and starting a fresh navigation
    mockTabUrls[tab1] = "https://sandbox.com/page1";
    ruleUpdates = [];
    await onErrorOccurredCallback({
      frameId: 0,
      tabId: tab1,
      url: "https://domain1.com/link", // Try to navigate again
      error: "net::ERR_BLOCKED_BY_CLIENT"
    });

    // Since it was a new navigation from sandbox, the session allowed list for Tab 1 should be reset
    lastRuleUpdate = ruleUpdates[ruleUpdates.length - 1];
    tab1Rule = lastRuleUpdate.addRules.find(r => r.id === 1000 + tab1);
    expect(tab1Rule.condition.excludedRequestDomains).not.toContain("domain1.com");
  });
});

