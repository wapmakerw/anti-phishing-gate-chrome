/*
 * Shared domain helpers. Loaded by the popup (script tag), the content script
 * (manifest content_scripts), and the background service worker (importScripts).
 *
 * We compare the "registrable domain" (eTLD+1) rather than the full hostname so
 * that, e.g., `mail.example.com` and `www.example.com` are treated as the same
 * trusted site. The TLD list below is a pragmatic subset of common multi-part
 * public suffixes; it is not the full Public Suffix List.
 */
(function (root) {
  "use strict";

  var MULTI_PART_TLDS = [
    "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk",
    "com.au", "net.au", "org.au", "gov.au", "edu.au",
    "co.nz", "co.za", "co.in", "co.jp", "co.kr",
    "com.br", "com.mx", "com.tr", "com.cn", "com.sg",
    "com.hk", "com.tw", "gov.in", "ac.in"
  ];

  function registrableDomain(hostname) {
    if (!hostname) return "";
    hostname = String(hostname).toLowerCase().replace(/\.$/, "");
    // IP addresses and localhost: use as-is.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.indexOf(".") === -1) {
      return hostname;
    }
    var parts = hostname.split(".");
    if (parts.length <= 2) return hostname;
    var lastTwo = parts.slice(-2).join(".");
    if (MULTI_PART_TLDS.indexOf(lastTwo) !== -1 && parts.length >= 3) {
      return parts.slice(-3).join(".");
    }
    return lastTwo;
  }

  // True when `urlOrHost` belongs to a different registrable domain than `baseHost`.
  function isExternalDomain(urlOrHost, baseHost) {
    var targetHost;
    try {
      targetHost = new URL(urlOrHost).hostname;
    } catch (e) {
      targetHost = urlOrHost; // already a bare hostname
    }
    var base = registrableDomain(baseHost);
    var target = registrableDomain(targetHost);
    return Boolean(base) && Boolean(target) && base !== target;
  }

  var api = {
    registrableDomain: registrableDomain,
    isExternalDomain: isExternalDomain
  };

  // Export for: ES-less popup/content (window) and service worker (self/globalThis).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.SandboxDomain = api;
  }
})(typeof self !== "undefined" ? self : this);
