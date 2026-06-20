/*
 * Shared host helpers. Loaded by the popup (script tag), the content script
 * (manifest content_scripts), and the background service worker (importScripts).
 *
 * Gating is applied at the FULL HOST level — `mail.example.com`,
 * `app.example.com` and `example.com` are treated as distinct sites. (DNR's
 * requestDomains additionally matches subdomains of an allowed host, which is
 * the natural "this host and anything under it" behaviour.)
 */
(function (root) {
  "use strict";

  function normalizeHost(host) {
    if (!host) return "";
    return String(host).toLowerCase().replace(/\.$/, "");
  }

  // Normalized hostname from a URL string, or from a bare hostname.
  function hostOf(urlOrHost) {
    if (!urlOrHost) return "";
    if (/^[/.?#]/.test(urlOrHost)) return "";
    if (/^[a-z0-9+-.]+:/i.test(urlOrHost) && !/^https?:/i.test(urlOrHost)) {
      return "";
    }
    var cleaned = urlOrHost;
    if (typeof urlOrHost === "string") {
      cleaned = urlOrHost.trim().replace(/ /g, "%20");
    }
    try {
      return normalizeHost(new URL(cleaned).hostname);
    } catch (e) {
      var match = cleaned.match(/^https?:\/\/([^/?#:]+)/i);
      if (match) {
        return normalizeHost(match[1]);
      }
      if (urlOrHost.indexOf("/") !== -1) return "";
      if (/\.(html|htm|php|asp|aspx|jsp|js|css)$/i.test(urlOrHost)) return "";
      return normalizeHost(urlOrHost);
    }
  }

  // True when `urlOrHost` is a different host than `base`.
  function isExternalHost(urlOrHost, base) {
    if (!urlOrHost || !base) return false;
    if (/^[/.?#]/.test(urlOrHost)) return false;
    
    var target = hostOf(urlOrHost);
    var b = hostOf(base);
    return Boolean(target) && Boolean(b) && target !== b;
  }

  var api = {
    normalizeHost: normalizeHost,
    hostOf: hostOf,
    isExternalHost: isExternalHost
  };

  // Export for: ES-less popup/content (window) and service worker (self/globalThis).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.SandboxDomain = api;
  }
})(typeof self !== "undefined" ? self : this);
