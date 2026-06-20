const fs = require("fs");
const path = require("path");

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
    get: jest.fn((id, cb) => cb({ id, url: "" })),
    update: jest.fn(() => Promise.resolve()),
    goBack: jest.fn((id, cb) => cb && cb()),
    remove: jest.fn((id, cb) => cb && cb()),
    onActivated: { addListener: jest.fn() },
    onUpdated: { addListener: jest.fn() },
    onRemoved: { addListener: jest.fn() }
  },
  storage: {
    local: {
      get: jest.fn((keys, cb) => cb({})),
      set: jest.fn((obj, cb) => cb && cb())
    },
    onChanged: { addListener: jest.fn() }
  },
  declarativeNetRequest: {
    updateSessionRules: jest.fn(() => Promise.resolve())
  },
  webNavigation: {
    onErrorOccurred: { addListener: jest.fn() },
    onCreatedNavigationTarget: { addListener: jest.fn() }
  }
};

global.chrome = mockChrome;
global.self = global;

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

describe("Background Service Worker Redirect Flow", () => {
  let ruleUpdates = [];

  beforeEach(() => {
    jest.clearAllMocks();
    ruleUpdates = [];

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
    const blockRule = lastRuleUpdate.addRules.find(r => r.id === BLOCK_GUARDED_RULE_ID);
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
});
