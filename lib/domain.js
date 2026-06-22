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

 // Look-alike / typo-squat / homograph detector.
// Returns an array of human-readable risk reasons for a host, or null.
//
// Goals:
// - Catch real phishing patterns.
// - Avoid common false positives like www, mail, api, cdn, static, etc.
// - Stay configurable with watchlists and allowlists.
function confusableRisk(urlOrHost, options) {
  options = options || {};

  var watchlist = Array.isArray(options.watchlist) ? options.watchlist : [];
  var benignLabels = new Set(
    (options.benignLabels || [
      "www", "www1", "www2", "ww1", "ww2",
      "mail", "smtp", "imap", "pop", "pop3", "webmail",
      "api", "api1", "api2", "dev", "test", "staging", "beta",
      "cdn", "static", "assets", "img", "images", "files",
      "m", "mobile",
      "ns1", "ns2", "ns3", "ns4",
      "vpn", "intranet", "portal", "auth", "login", "secure",
      "help", "support", "status", "docs", "blog", "shop"
    ]).map(function (s) { return String(s).toLowerCase(); })
  );

  var technicalLabels = new Set(
    (options.technicalLabels || [
      "i18n", "l10n", "mp3", "mp4", "3d", "4k", "hd", "sd",
      "x64", "x86", "ipv4", "ipv6", "r2d2", "g20", "h2o",
      "v1", "v2", "v3", "v4", "v5", "p2p", "b2b", "b2c"
    ]).map(function (s) { return String(s).toLowerCase(); })
  );

  var h = hostOf(urlOrHost);
  if (!h) return null;

  h = String(h).trim().toLowerCase().replace(/\.$/, "");
  if (!h) return null;

  var reasons = [];
  var seen = Object.create(null);

  function add(reason) {
    if (!seen[reason]) {
      seen[reason] = true;
      reasons.push(reason);
    }
  }

  function isIPv4(host) {
    return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host);
  }

  function isIPv6(host) {
    return /^\[[0-9a-f:]+\]$/.test(host) || /^[0-9a-f:]*:[0-9a-f:]*$/i.test(host);
  }

  function hasUnicodePropertyEscapes() {
    try {
      new RegExp("\\p{L}", "u");
      return true;
    } catch (e) {
      return false;
    }
  }

  var HAS_UNICODE_PROPS = hasUnicodePropertyEscapes();

  var INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF\u180E\u00AD]/g;
  var BIDI_RE = /[\u202A-\u202E\u2066-\u2069]/g;
  var CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;

  function splitLabels(host) {
    return host.split(".");
  }

  function stripMarks(s) {
    try {
      return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
    } catch (e) {
      return s;
    }
  }

  function normalizeForCompare(s) {
    s = stripMarks(String(s).toLowerCase());
    s = s.replace(INVISIBLE_RE, "").replace(BIDI_RE, "").replace(CONTROL_RE, "");
    s = s.replace(/[\.\-_]/g, "");

    var map = {
      "0": "o",
      "1": "l",
      "2": "z",
      "3": "e",
      "4": "a",
      "5": "s",
      "6": "g",
      "7": "t",
      "8": "b",
      "9": "g",
      "@": "a",
      "$": "s",
      "!": "i",
      "|": "l"
    };

    var out = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      out += map[ch] || ch;
    }

    if (HAS_UNICODE_PROPS) {
      out = out.replace(/[^\p{L}\p{N}]/gu, "");
    } else {
      out = out.replace(/[^a-z0-9]/g, "");
    }

    return out;
  }

  function confusableSkeleton(s) {
    s = normalizeForCompare(s);

    var map = {
      // Cyrillic
      "а": "a", "с": "c", "е": "e", "о": "o", "р": "p", "х": "x",
      "у": "y", "і": "i", "ј": "j", "ӏ": "l", "Ӏ": "l", "ѕ": "s",
      "ԁ": "d", "һ": "h", "в": "b", "к": "k", "т": "t", "л": "l",
      "г": "r", "д": "d", "з": "z", "я": "r", "ф": "f", "ж": "zh",
      "ш": "sh", "щ": "shch",

      // Greek
      "α": "a", "β": "b", "γ": "y", "δ": "d", "ε": "e", "ζ": "z",
      "η": "n", "ι": "i", "κ": "k", "μ": "m", "ν": "v", "ο": "o",
      "π": "p", "ρ": "p", "τ": "t", "υ": "y", "χ": "x", "ω": "w",
      "ς": "s", "σ": "s", "ϲ": "c", "ϵ": "e"
    };

    var out = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      out += map[ch] || ch;
    }
    return out;
  }

  function editDistanceAtMost(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) return false;
    if (a === b) return true;

    var prev = new Array(b.length + 1);
    var curr = new Array(b.length + 1);

    for (var j = 0; j <= b.length; j++) prev[j] = j;

    for (var i = 1; i <= a.length; i++) {
      curr[0] = i;
      var rowMin = curr[0];

      for (var j = 1; j <= b.length; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(
          prev[j] + 1,
          curr[j - 1] + 1,
          prev[j - 1] + cost
        );
        if (curr[j] < rowMin) rowMin = curr[j];
      }

      if (rowMin > limit) return false;

      var tmp = prev;
      prev = curr;
      curr = tmp;
    }

    return prev[b.length] <= limit;
  }

  function scriptSet(text) {
    var scripts = Object.create(null);

    function mark(script) {
      if (script && script !== "common" && script !== "inherited" && script !== "unknown") {
        scripts[script] = true;
      }
    }

    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);

      if (/[a-z0-9-]/.test(ch)) {
        mark("latin");
        continue;
      }

      if (!HAS_UNICODE_PROPS) {
        var code = ch.charCodeAt(0);
        if (code >= 0x0400 && code <= 0x04FF) mark("cyrillic");
        else if (code >= 0x0370 && code <= 0x03FF) mark("greek");
        else if (code >= 0x0600 && code <= 0x06FF) mark("arabic");
        else if (code >= 0x0590 && code <= 0x05FF) mark("hebrew");
        else if (code >= 0x4E00 && code <= 0x9FFF) mark("han");
        else if (code >= 0x3040 && code <= 0x30FF) mark("japanese");
        else if (code >= 0xAC00 && code <= 0xD7AF) mark("hangul");
        else mark("other");
        continue;
      }

      if (/\p{Script=Latin}/u.test(ch)) mark("latin");
      else if (/\p{Script=Cyrillic}/u.test(ch)) mark("cyrillic");
      else if (/\p{Script=Greek}/u.test(ch)) mark("greek");
      else if (/\p{Script=Arabic}/u.test(ch)) mark("arabic");
      else if (/\p{Script=Hebrew}/u.test(ch)) mark("hebrew");
      else if (/\p{Script=Han}/u.test(ch)) mark("han");
      else if (/\p{Script=Hiragana}/u.test(ch) || /\p{Script=Katakana}/u.test(ch)) mark("japanese");
      else if (/\p{Script=Hangul}/u.test(ch)) mark("hangul");
      else mark("other");
    }

    return Object.keys(scripts);
  }

  function isCommonLabel(label) {
    return benignLabels.has(label) || technicalLabels.has(label);
  }

  function isPunycodeLabel(label) {
    return /^xn--/.test(label) || (label.length >= 4 && label.charAt(2) === "-" && label.charAt(3) === "-");
  }

  function suspiciousLabelChars(label) {
    if (HAS_UNICODE_PROPS) return /[^\p{L}\p{N}-]/u.test(label);
    return /[^a-z0-9-]/i.test(label);
  }

  function hasSuspiciousRepeat(label) {
    // Avoid flagging normal labels like "www", "mail", "cool", "book".
    // Only flag longer or more extreme runs.
    if (isCommonLabel(label)) return false;
    if (label.length < 5) return false;

    // 4+ repeated same character is suspicious almost everywhere.
    if (/(.)\1{3,}/i.test(label)) return true;

    // 3 repeated chars can be suspicious in longer labels, e.g. "gooogle".
    if (label.length >= 7 && /(.)\1{2,}/i.test(label)) return true;

    return false;
  }

  function hasSuspiciousDigitMix(label) {
    // Avoid common technical names like i18n, x64, ipv6, mp3, v2, etc.
    if (isCommonLabel(label)) return false;
    if (/^(?:v\d+|x\d+|mp\d+|ipv\d+|i18n|l10n|g\d+|r2d2|b2b|b2c|p2p|3d|4k|hd|sd)$/i.test(label)) {
      return false;
    }

    // Only flag labels that look mostly alphabetic but contain a digit in the middle.
    var letters = (label.match(/[a-z]/gi) || []).length;
    var digits = (label.match(/[0-9]/g) || []).length;
    if (letters < 4 || digits === 0) return false;

    // Typical phishing pattern: one or two digits embedded in an otherwise alphabetic word.
    if (digits <= 2 && /[a-z][0-9]|[0-9][a-z]/i.test(label)) return true;

    return false;
  }

  // Raw host hygiene.
  if (CONTROL_RE.test(h)) add("Contains control characters, which should never appear in a normal domain.");
  if (INVISIBLE_RE.test(h)) add("Contains invisible characters that can hide the real domain.");
  if (BIDI_RE.test(h)) add("Contains bidirectional text controls that can make the domain read differently than it looks.");

  if (isIPv4(h) || isIPv6(h)) {
    add("Uses an IP address instead of a normal domain name.");
  }

  if (h.length > 253) {
    add("Domain is unusually long.");
  }

  if (h.indexOf("..") !== -1) {
    add("Contains an empty label (consecutive dots).");
  }

  if (h.charAt(0) === "." || h.charAt(h.length - 1) === ".") {
    add("Starts or ends with a dot.");
  }

  var labels = splitLabels(h);
  var hasNonASCII = /[^\x00-\x7f]/.test(h);
  if (hasNonASCII) {
    add("Uses non-ASCII characters that can imitate familiar Latin letters.");
  }

  if (/^xn--/.test(h) || /(^|\.)xn--/.test(h)) {
    add("Uses punycode/IDN encoding, which can hide look-alike Unicode letters.");
  }

  if (labels.length >= 4) {
    add("Uses many labels (subdomains), which can be abused to hide the real destination.");
  }

  for (var i = 0; i < labels.length; i++) {
    var label = labels[i];
    if (!label) continue;

    // Skip obvious safe infrastructure labels from most aggressive checks.
    var common = isCommonLabel(label);

    if (label.length > 63) {
      add('Label "' + label + '" is longer than the DNS limit of 63 characters.');
    }

    if (label.charAt(0) === "-" || label.charAt(label.length - 1) === "-") {
      add('Label "' + label + '" starts or ends with a hyphen.');
    }

    if (label.indexOf("--") !== -1 && !/^xn--/.test(label)) {
      add('Label "' + label + '" contains double hyphens, which are unusual outside punycode.');
    }

    if (/[_\/@\\\.]/.test(label)) {
      add('Label "' + label + '" contains separator-like characters that are unusual in a host name.');
    }

    if (!common && suspiciousLabelChars(label)) {
      add('Label "' + label + '" contains unusual characters for a domain name.');
    }

    if (!common && isPunycodeLabel(label)) {
      add('Label "' + label + '" looks like punycode or an IDN label.');
    }

    if (!common && /[^\x00-\x7f]/.test(label)) {
      add('Label "' + label + '" contains international characters that can be visually confusable.');
    }

    var scripts = scriptSet(label);
    if (!common && scripts.length > 1) {
      add('Label "' + label + '" mixes writing systems (' + scripts.join(", ") + "), which is a strong homograph signal.");
    }

    if (!common && hasSuspiciousRepeat(label)) {
      add('Label "' + label + '" contains an unusual repeated-character pattern.');
    }

    if (!common && hasSuspiciousDigitMix(label)) {
      add('Label "' + label + '" mixes letters with look-alike digits in a way that is often used for typo-squatting.');
    }

    if (!common && /[^\x00-\x7f]/.test(label)) {
      var skeleton = confusableSkeleton(label);
      var normalized = normalizeForCompare(label);
      if (skeleton !== normalized && /^[a-z0-9]+$/i.test(skeleton)) {
        add('Label "' + label + '" collapses into a very different ASCII-looking form after confusable normalization.');
      }
    }
  }

  // Watchlist comparison: this is the strongest signal for real phishing.
  if (watchlist.length) {
    var hostNorm = normalizeForCompare(h);
    var hostSkel = confusableSkeleton(h);

    for (var w = 0; w < watchlist.length; w++) {
      var target = String(watchlist[w] || "").trim().toLowerCase();
      if (!target) continue;

      var targetNorm = normalizeForCompare(target);
      if (!targetNorm) continue;

      if (hostNorm === targetNorm) {
        add('Host matches protected name "' + target + '" after normalization.');
        continue;
      }

      if (hostSkel === targetNorm) {
        add('Host looks like protected name "' + target + '" after confusable normalization.');
        continue;
      }

      if (editDistanceAtMost(hostNorm, targetNorm, 1)) {
        add('Host is one edit away from protected name "' + target + '".');
        continue;
      }

      if (editDistanceAtMost(hostNorm, targetNorm, 2) && hostNorm.length <= targetNorm.length + 3) {
        add('Host is very close to protected name "' + target + '".');
      }
    }
  }

  return reasons.length ? reasons : null;
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
    confusableRisk: confusableRisk,
    isExternalHost: isExternalHost
  };

  // Export for: ES-less popup/content (window) and service worker (self/globalThis).
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.GateDomain = api;
  }
})(typeof self !== "undefined" ? self : this);
