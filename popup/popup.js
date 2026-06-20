/* Popup logic: show the active tab's domain, toggle it in the sandbox list or
   the trusted list, and render both lists with per-item removal. */
(function () {
  "use strict";

  var SANDBOX_KEY = "sandboxDomains";
  var TRUSTED_KEY = "trustedDomains";
  var domainLib = self.SandboxDomain;

  var els = {
    currentDomain: document.getElementById("currentDomain"),
    status: document.getElementById("status"),
    toggleBtn: document.getElementById("toggleBtn"),
    list: document.getElementById("domainList"),
    count: document.getElementById("count"),
    emptyHint: document.getElementById("emptyHint"),
    trustedList: document.getElementById("trustedList"),
    trustedCount: document.getElementById("trustedCount"),
    trustedEmptyHint: document.getElementById("trustedEmptyHint")
  };

  var currentDomain = null;

  function getState(cb) {
    chrome.storage.local.get([SANDBOX_KEY, TRUSTED_KEY], function (data) {
      data = data || {};
      cb((data[SANDBOX_KEY]) || [], (data[TRUSTED_KEY]) || []);
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
    getState(function (sandbox, trusted) {
      var inSandbox = currentDomain && sandbox.indexOf(currentDomain) !== -1;
      var inTrusted = currentDomain && trusted.indexOf(currentDomain) !== -1;

      if (!currentDomain) {
        els.status.textContent = "This page can't be managed.";
        els.status.className = "status off";
        els.toggleBtn.disabled = true;
      } else {
        els.toggleBtn.disabled = false;

        if (inSandbox) {
          els.status.textContent = "Protected — external links are confirmed.";
          els.status.className = "status on";
        } else if (inTrusted) {
          els.status.textContent = "Trusted destination — never prompted.";
          els.status.className = "status on";
        } else {
          els.status.textContent = "Not protected.";
          els.status.className = "status off";
        }

        els.toggleBtn.textContent = inSandbox ? "Remove from sandbox" : "Add to sandbox";
        els.toggleBtn.classList.toggle("remove", inSandbox);
      }

      renderList(els.list, els.count, els.emptyHint, sandbox, SANDBOX_KEY);
      renderList(els.trustedList, els.trustedCount, els.trustedEmptyHint, trusted, TRUSTED_KEY);
    });
  }

  els.toggleBtn.addEventListener("click", function () {
    toggle(SANDBOX_KEY, render);
  });

  // Resolve the active tab's domain, then render.
  chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
    var tab = tabs && tabs[0];
    if (tab && tab.url && /^https?:/i.test(tab.url)) {
      currentDomain = domainLib.hostOf(tab.url) || null;
    }
    els.currentDomain.textContent = currentDomain || "Unsupported page";
    render();
  });
})();
