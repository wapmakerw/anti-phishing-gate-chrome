/* Popup logic: show the active tab's domain, toggle it in the gate list or
   the trusted list, and render both lists with per-item removal. */
(function () {
  "use strict";

  // Legacy storage key name (kept so existing installs keep their gated list).
  var GATE_KEY = "sandboxDomains";
  var TRUSTED_KEY = "trustedDomains";
  var domainLib = self.GateDomain;

  var els = {
    currentDomain: document.getElementById("currentDomain"),
    lookalike: document.getElementById("lookalike"),
    status: document.getElementById("status"),
    toggleBtn: document.getElementById("toggleBtn"),
    list: document.getElementById("domainList"),
    count: document.getElementById("count"),
    emptyHint: document.getElementById("emptyHint"),
    trustedList: document.getElementById("trustedList"),
    trustedCount: document.getElementById("trustedCount"),
    trustedEmptyHint: document.getElementById("trustedEmptyHint"),
    manualForm: document.getElementById("manualAdd"),
    manualInput: document.getElementById("manualDomain"),
    manualError: document.getElementById("manualError"),
    exportBtn: document.getElementById("exportBtn"),
    importBtn: document.getElementById("importBtn"),
    importFile: document.getElementById("importFile"),
    backupStatus: document.getElementById("backupStatus")
  };

  var currentDomain = null;

  function getState(cb) {
    chrome.storage.local.get([GATE_KEY, TRUSTED_KEY], function (data) {
      data = data || {};
      cb((data[GATE_KEY]) || [], (data[TRUSTED_KEY]) || []);
    });
  }

  function setKey(key, list, cb) {
    var obj = {};
    obj[key] = list;
    chrome.storage.local.set(obj, cb || function () {});
  }

  function toggle(key, cb) {
    if (!currentDomain) return;
    chrome.storage.local.get(key, function (data) {
      var list = (data && data[key]) || [];
      var next = list.indexOf(currentDomain) !== -1
        ? list.filter(function (d) { return d !== currentDomain; })
        : list.concat([currentDomain]);
      setKey(key, next, cb);
    });
  }

  function renderList(listEl, countEl, emptyEl, items, key) {
    countEl.textContent = String(items.length);
    listEl.innerHTML = "";
    emptyEl.style.display = items.length ? "none" : "block";

    items.slice().sort().forEach(function (domain) {
      var li = document.createElement("li");
      var name = document.createElement("span");
      name.textContent = domain;
      var remove = document.createElement("button");
      remove.className = "remove-link";
      remove.textContent = "Remove";
      remove.addEventListener("click", function () {
        chrome.storage.local.get(key, function (data) {
          var cur = (data && data[key]) || [];
          setKey(key, cur.filter(function (d) { return d !== domain; }), render);
        });
      });
      li.appendChild(name);
      li.appendChild(remove);
      listEl.appendChild(li);
    });
  }

  function render() {
    getState(function (gate, trusted) {
      var inGate = currentDomain && gate.indexOf(currentDomain) !== -1;
      var inTrusted = currentDomain && trusted.indexOf(currentDomain) !== -1;

      if (!currentDomain) {
        els.status.textContent = "This page can't be managed.";
        els.status.className = "status off";
        els.toggleBtn.disabled = true;
      } else {
        els.toggleBtn.disabled = false;

        if (inGate) {
          els.status.textContent = "Protected — external links are confirmed.";
          els.status.className = "status on";
        } else if (inTrusted) {
          els.status.textContent = "Trusted destination — never prompted.";
          els.status.className = "status on";
        } else {
          els.status.textContent = "Not protected.";
          els.status.className = "status off";
        }

        els.toggleBtn.textContent = inGate ? "Stop gating" : "Gate this site";
        els.toggleBtn.classList.toggle("remove", inGate);
      }

      renderList(els.list, els.count, els.emptyHint, gate, GATE_KEY);
      renderList(els.trustedList, els.trustedCount, els.trustedEmptyHint, trusted, TRUSTED_KEY);
    });
  }

  els.toggleBtn.addEventListener("click", function () {
    toggle(GATE_KEY, render);
  });

  // Normalize free-form input to a host and validate its shape. Returns either
  // { host } or { error } with a human-readable message.
  function normalizeAndValidate(input) {
    var raw = String(input || "").trim();
    if (!raw) return { error: "Enter a domain to add." };

    var host = domainLib.hostOf(raw);
    if (!host) return { error: "That doesn't look like a valid domain." };
    if (host.indexOf(".") === -1) return { error: "Enter a full domain, e.g. example.com." };
    if (
      !/^[a-z0-9.-]+$/.test(host) ||
      host.indexOf("..") !== -1 ||
      host.charAt(0) === "." || host.charAt(host.length - 1) === "." ||
      host.charAt(0) === "-" || host.charAt(host.length - 1) === "-"
    ) {
      return { error: "That doesn't look like a valid domain." };
    }
    return { host: host };
  }

  function showManualError(message) {
    if (!message) {
      els.manualError.hidden = true;
      els.manualError.textContent = "";
      return;
    }
    els.manualError.textContent = message;
    els.manualError.hidden = false;
  }

  els.manualForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var result = normalizeAndValidate(els.manualInput.value);
    if (result.error) {
      showManualError(result.error);
      return;
    }
    chrome.storage.local.get(GATE_KEY, function (data) {
      var list = (data && data[GATE_KEY]) || [];
      if (list.indexOf(result.host) !== -1) {
        showManualError('"' + result.host + '" is already gated.');
        return;
      }
      setKey(GATE_KEY, list.concat([result.host]), function () {
        els.manualInput.value = "";
        showManualError("");
        render();
      });
    });
  });

  els.manualInput.addEventListener("input", function () {
    if (!els.manualError.hidden) showManualError("");
  });

  // --------------------------------------------------------------------------
  // Export / import (CSV)
  //
  // One file covers both lists. Each row is `type,domain` where type is
  // "gated" or "trusted", e.g.
  //   type,domain
  //   gated,example.com
  //   trusted,partner.com
  // --------------------------------------------------------------------------

  function showBackupStatus(message, ok) {
    els.backupStatus.textContent = message;
    els.backupStatus.className = "backup-status " + (ok ? "ok" : "err");
    els.backupStatus.hidden = false;
  }

  function dateStamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  // Domains never contain commas/quotes, but quote defensively if they ever do.
  function csvEscape(value) {
    return /[",\n\r]/.test(value)
      ? '"' + value.replace(/"/g, '""') + '"'
      : value;
  }

  function buildCsv(gate, trusted) {
    var rows = ["type,domain"];
    gate.slice().sort().forEach(function (d) { rows.push("gated," + csvEscape(d)); });
    trusted.slice().sort().forEach(function (d) { rows.push("trusted," + csvEscape(d)); });
    return rows.join("\r\n") + "\r\n";
  }

  // Split a single CSV line into fields, honoring quoted values.
  function parseCsvLine(line) {
    var fields = [];
    var cur = "";
    var inQuotes = false;
    for (var i = 0; i < line.length; i++) {
      var c = line.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (line.charAt(i + 1) === '"') { cur += '"'; i++; }
          else inQuotes = false;
        } else {
          cur += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        fields.push(cur);
        cur = "";
      } else {
        cur += c;
      }
    }
    fields.push(cur);
    return fields;
  }

  // Parse CSV text into deduped gate/trusted host lists, counting rows we drop.
  function parseCsv(text) {
    var result = { gate: [], trusted: [], invalid: 0, skipped: 0 };
    var lines = String(text).split(/\r\n|\r|\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;

      var fields = parseCsvLine(line);
      var type = (fields[0] || "").trim().toLowerCase();
      var rawDomain = (fields[1] || "").trim();

      // Skip an optional header row.
      if (i === 0 && type === "type" && rawDomain.toLowerCase() === "domain") continue;

      var target;
      if (type === "gated" || type === "gate" || type === "sandbox") target = result.gate;
      else if (type === "trusted" || type === "trust") target = result.trusted;
      else { result.skipped++; continue; }

      var v = normalizeAndValidate(rawDomain);
      if (v.error) { result.invalid++; continue; }
      if (target.indexOf(v.host) === -1) target.push(v.host);
    }
    return result;
  }

  els.exportBtn.addEventListener("click", function () {
    getState(function (gate, trusted) {
      var blob = new Blob([buildCsv(gate, trusted)], { type: "text/csv" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = "anti-phishing-gate-rules-" + dateStamp() + ".csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      showBackupStatus(
        "Exported " + gate.length + " gated and " + trusted.length + " trusted domain(s).",
        true
      );
    });
  });

  els.importBtn.addEventListener("click", function () {
    els.importFile.click();
  });

  els.importFile.addEventListener("change", function () {
    var file = els.importFile.files && els.importFile.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function () {
      var parsed = parseCsv(reader.result);
      if (!parsed.gate.length && !parsed.trusted.length) {
        showBackupStatus("No valid domains found in that file.", false);
        els.importFile.value = "";
        return;
      }
      getState(function (gate, trusted) {
        var addedGate = 0;
        var nextGate = gate.slice();
        parsed.gate.forEach(function (d) {
          if (nextGate.indexOf(d) === -1) { nextGate.push(d); addedGate++; }
        });
        var addedTrusted = 0;
        var nextTrusted = trusted.slice();
        parsed.trusted.forEach(function (d) {
          if (nextTrusted.indexOf(d) === -1) { nextTrusted.push(d); addedTrusted++; }
        });
        setKey(GATE_KEY, nextGate, function () {
          setKey(TRUSTED_KEY, nextTrusted, function () {
            var parts = ["Imported " + addedGate + " gated, " + addedTrusted + " trusted."];
            if (parsed.invalid) parts.push(parsed.invalid + " invalid skipped.");
            showBackupStatus(parts.join(" "), true);
            render();
          });
        });
      });
      els.importFile.value = "";
    };
    reader.onerror = function () {
      showBackupStatus("Could not read that file.", false);
      els.importFile.value = "";
    };
    reader.readAsText(file);
  });

  // Resolve the active tab's domain, then render.
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (tab && tab.url && /^https?:/i.test(tab.url)) {
      currentDomain = domainLib.hostOf(tab.url) || null;
    }
    els.currentDomain.textContent = currentDomain || "Unsupported page";
    renderLookalike(els.lookalike, domainLib.confusableRisk(currentDomain));
    render();
  });

  // Flag when the current domain itself looks like a look-alike trap.
  function renderLookalike(el, reasons) {
    el.textContent = "";
    if (!reasons) {
      el.hidden = true;
      return;
    }
    var title = document.createElement("strong");
    title.textContent = "⚠ Possible look-alike domain";
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
})();
