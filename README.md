# Anti-Phishing Gate

A Chrome extension (Manifest V3) that helps you **avoid phishing redirects**.
(Packaged as `sandbox-link-guard` by the build script.)

You mark sites you want to protect (your bank, your company portal, your
webmail) as **sandboxed**. While you are on one of those sites, if a link tries
to open a **different host in a new window/tab**, the extension pauses and
shows a confirmation modal that clearly displays the destination — so a
malicious "click here to verify your account" link can't quietly whisk you off
to a look-alike phishing site.

Matching is at the **full host level** — `mail.example.com`, `app.example.com`
and `example.com` are distinct. Sandboxing or trusting one does not cover the
others.

There are two lists:

- **Sandboxed hosts** — sites where protection is *active*. While browsing
  these, links to any other host are confirmed.
- **Trusted hosts** — destination allowlist. A link *to* one of these is
  **never** prompted, even from a sandboxed site (e.g. trust your SSO provider
  so legit logins don't nag you).

## How it works

1. Open a site you want to protect and click the toolbar icon → **Add to
   sandbox**. (Or **Mark trusted** to allowlist it as a destination.)
2. The **host** (e.g. `app.example.com`) is saved to `chrome.storage.local`.
3. On any sandboxed page, the content script watches link clicks. When a click
   would open a **different host** in a **new window** (`target="_blank"`,
   `Ctrl`/`Cmd`/`Shift`-click, or middle-click) **and that host isn't trusted**,
   it blocks the click and shows a confirmation modal. The URL is used
   **verbatim** — it is never transformed, unwrapped, or fetched.
4. The modal shows the destination host (with a **Trust** button that asks for
   confirmation before whitelisting it) and the full URL. Its **"Open external
   site"** button is disabled for **5 seconds** (a forced pause with a small
   loading animation), then becomes clickable. Nothing is navigated by the click
   itself.
5. On **Open**, the background worker opens the link in a **new window it
   guards**. As the browser navigates — including through **every** redirect hop
   (HTTP 3xx, `<meta refresh>`, JS `location=`, or an interstitial you click
   through) — any main-frame request to a **non-trusted** host is intercepted
   *before it loads* and replaced with a confirmation page (whose **Continue**
   button also has a 5-second pause). **Continue** whitelists that host and
   proceeds; **Close window** cancels entirely.
6. The window stays guarded for its whole lifetime (until you close it), so a
   chain that passes through several hosts is confirmed at **each** one.

The toolbar badge shows **ON** (green) when the current tab's domain is
sandboxed.

### Redirectors and phishing

Phishing mail often hides the real target behind a redirector so the visible
link looks harmless. The extension does **not** try to decode or pre-fetch the
link (that would either leak a request or rely on guessing the format).
Instead it lets the browser navigate for real and gates every hop:

- The guarded window follows the actual HTTP redirects, and a
  `declarativeNetRequest` rule redirects each main-frame request to a
  non-trusted domain to the confirmation page **before it loads**.
- So a redirector chain (e.g. `list-manage.com/track/click` → the real site)
  prompts for **each** untrusted domain it passes through — including the
  redirector domain itself — as the navigation happens. No request is ever made
  until you've confirmed that hop.

## Architecture

```
manifest.json          MV3 manifest. Permissions: storage, tabs, activeTab,
                       declarativeNetRequest, webNavigation. host_permissions:
                       http/https. confirm/confirm.html is web-accessible (the
                       DNR rule redirects to it). Content script on <all_urls>,
                       gated at runtime.
background.js          Service worker. (1) Toolbar badge in sync with the active
                       tab's sandbox status. (2) Guarded navigation: opens the
                       confirmed link in a new window, installs DNR session rules
                       that allow trusted/authorized domains and redirect every
                       other main-frame hop to the confirmation page, and
                       unguards the window once it lands on a real page.
lib/domain.js          Shared helpers: hostOf() (normalized hostname) and
                       isExternalHost(). Loaded by the popup and confirm page
                       (script tag), content script (manifest), worker
                       (importScripts).
content/
  content.js           Activates only when the page domain is in the sandbox list.
                       Capture-phase click/auxclick interception + the modal with
                       the 5-second "Open" countdown and a confirm-to-trust button;
                       hands the URL verbatim to the worker.
  content.css          Modal styles, prefixed `slg-` and forced with !important so
                       host-page CSS cannot hide the warning.
confirm/
  confirm.html/.css/.js  In-extension interstitial the DNR rule redirects to when
                       a guarded navigation hits a non-trusted domain. Continue
                       (whitelist + proceed) or Close window (cancel). The blocked
                       URL arrives appended raw after "?d=".
popup/
  popup.html/.css/.js  Toolbar UI: current domain, add/remove + trust/untrust
                       toggles, and both lists with per-item removal.
scripts/
  build.sh             Validates sources and packages dist/ (unpacked + zip).
icons/
  icon.svg             Source artwork — a gradient security shield with a white
                       fish-hook emblem (anti-phishing theme).
  make-icons.sh        Regenerates icon-{16,32,48,128}.png with ImageMagick.
  icon-*.png           Rasterized toolbar/store icons (referenced by the manifest;
                       the .svg and .sh are dev-only and excluded from the build).
```

**State:** two `chrome.storage.local` keys — `sandboxDomains` (protected sites)
and `trustedDomains` (destination allowlist) — each an array of **host** strings
(despite the key names), observed live via `storage.onChanged`. Guard state
(which windows are guarded, which hosts were allowed "just once" this session)
lives in memory in the worker and drives the `declarativeNetRequest` session
rules; "always trust" choices are persisted to `trustedDomains`.

## Build / package

No transpilation step — the source is plain MV3 JS/CSS/HTML. The build script
validates everything and produces an installable bundle:

```sh
./scripts/build.sh
```

Requirements: `zip` (required). `node` is **optional** — if present it
syntax-checks the JS and reads the manifest version; if absent the build still
runs, prints a warning, and reads the version without it. The script also
prepends common install dirs (`~/.local/bin`, `/usr/local/bin`,
`/opt/homebrew/bin`) to `PATH`, so it finds tools even from an IDE/non-login
shell. It is POSIX `sh`, so `sh scripts/build.sh` and `./scripts/build.sh` both
work.

Outputs:

- `dist/sandbox-link-guard/` — unpacked, ready for **Load unpacked**.
- `dist/sandbox-link-guard-<version>.zip` — ready for the Chrome Web Store or
  for sharing.

The version is read from `manifest.json`. `dist/` is git-ignored.

## Install / dev environment (for smoke-testing)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder
   (`fish-chrome-extension`).
4. After editing files, click the **reload** icon on the extension card. For
   content-script changes, also reload the target page.

### Smoke test

1. Visit e.g. `https://en.wikipedia.org`, open the popup, **Add to sandbox**.
   Badge should read **ON**.
2. On that page, `Ctrl`/`Cmd`-click (or open in a new tab) a link to a different
   domain → the modal appears; **Open external site** is disabled with a
   countdown for 5 s, then enables.
3. Click **Open external site** → a new window opens and navigates to the
   destination.
4. Per-hop gating: open a link that HTTP-redirects through another untrusted
   domain (a `list-manage.com/track/click?...` style URL, or any shortener) →
   the new window shows the **confirmation page** for the next domain *before*
   it loads. **Continue** (leave "always trust" checked to remember it) proceeds
   to that domain; if it redirects again to a new untrusted domain you're asked
   again. **Close window** cancels.
   - In the initial modal you can also click **Trust** next to the destination
     domain and confirm **Yes** to whitelist it up front.
5. Click a link to a **different host** (even a sibling subdomain) in a new tab
   → modal appears; a link to the **same host** → no modal.
6. **Remove from sandbox** in the popup → badge clears, links open normally.

### Debugging

- **Popup / background:** `chrome://extensions` → the extension → **service
  worker** (background) and **Inspect** on the popup.
- **Content script:** the page's own DevTools console (it runs in the page's
  isolated world). Look for the `slg-overlay` element and `SandboxDomain` global.
- **State:** in any of those consoles,
  `chrome.storage.local.get(['sandboxDomains','trustedDomains'], console.log)`.
- **Guard rules:** in the service-worker console,
  `chrome.declarativeNetRequest.getSessionRules(console.log)` shows the active
  allow/redirect rules while a guarded window is open.
- **Confirmation page:** it's a normal extension page — right-click → Inspect
  inside the guarded window when it's showing.

## Known limitations

- **Host-level matching is exact.** `app.example.com` and `example.com` are
  treated as different sites; sandboxing/trusting one does not cover the other.
  (When the worker installs an allow rule for a host, `declarativeNetRequest`
  also allows that host's *subdomains* — i.e. allowing `example.com` covers
  `x.example.com`, but never a sibling like `evil.com`.)
- **Per-hop gating covers `main_frame` requests.** The guarded window catches
  every main-frame request via `declarativeNetRequest` — the initial load, each
  HTTP 3xx hop, `<meta refresh>`, JS `location =`, and clicks to a new host —
  and confirms each non-trusted host. The window stays guarded for its whole
  lifetime, so it does not skip hops after an intermediate page loads. It cannot
  see same-document changes (hash updates) or content swapped in via `fetch`/XHR
  without a new main-frame navigation.
- **Guarding is per new window.** The flow opens the link in its own window and
  gates it until you close it. Links opened in the same tab are not gated (the
  extension targets new-window/new-tab opens, the common phishing vector).
- **"Just once" allows last for the browser session.** Continuing past a host
  without the "always trust" checkbox authorizes it for the rest of the session
  (kept in worker memory); checking the box persists it to `trustedDomains`.
- **JavaScript-driven popups** (`window.open(...)` called by page scripts) are
  not intercepted at the click stage. Content scripts run in an isolated world,
  so overriding the page's `window.open` would require a `world: "MAIN"`
  injection. Anchor links opening new windows — the common phishing vector —
  are covered.
- The icons are generated with ImageMagick (`./icons/make-icons.sh`). Edit
  `icons/icon.svg` (or the draw commands in the script) and re-run it to
  regenerate the PNGs; the manifest references the rasterized sizes.
