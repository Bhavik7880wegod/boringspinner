// src/adapters/claude-banner/block.asset.ts — the injected JS block for the
// `claude-banner` surface (§3 #2). This string is APPENDED to the installed
// Claude Code `webview/index.js` bundle and injects ONE sponsored line into the
// usage-limit banner — the secondary slot called out in §3 (lower CTR, doubles
// inventory, gated by the server flag `banner_enabled`).
//
// This is a STANDALONE block: it shares the host bundle with the
// `claude-overlay` surface but uses ITS OWN marker pair and ITS OWN body-level
// banner element so the two surfaces are independently apply/strip-able and the
// overlay's files are never touched by this adapter.
//
// Safety posture (the same constraints the overlay observes):
//   • Locate by class, never by glyph — the usage-limit banner sits in a container
//     classed `usageLimitBanner_<hash>` (per-build hash suffix; we match the stable
//     `usageLimitBanner_` prefix). A text/glyph heuristic could catch the user's
//     own chat or markdown and paint over it; class-scoping rules that out. If CC
//     renames the class the ad just doesn't appear — the safe way to fail.
//   • Don't mutate CC's React tree — we READ the banner row's rect
//     (getBoundingClientRect is reconciliation-safe) and draw our own absolutely-
//     positioned node appended to <body>, outside every React root, parked over the
//     banner. React can't tear out a node it doesn't own.
//   • Never read user content (§1.3 #1) — only layout geometry and a stable
//     container class; no prompt text, no completion text, ever.
//   • Icon fallback is wired in JS: the icon <img> carries data-coads-bicon="1",
//     and one document-level CAPTURE-phase `error` listener swaps a broken image
//     for our inline brand-dot SVG. It has to be programmatic — CC's webview
//     script-src CSP omits 'unsafe-inline', so an inline onerror="" would be blocked.
//   • CLICK BEACON — a fire-and-forget no-cors POST to the loopback (§5.9 / §6.4)
//     records the click; the real advertiser href is left for the VS Code host
//     to open externally (no preventDefault).
//
// In a CommonJS context (tests/headless) the block detects `module.exports`,
// exports its PURE helpers, and returns BEFORE any DOM work — so the renderer's
// pure behavior is unit-testable with no jsdom.

// Marker pair — DISTINCT from the overlay's `__COADS_OVERLAY_*__` so the two
// surfaces strip independently and byte-exactly.
export const BANNER_START = '/*__COADS_BANNER_START__*/';
export const BANNER_END = '/*__COADS_BANNER_END__*/';

// Placeholders substituted by the adapter (string values via JSON.stringify;
// numbers/bools as bare literals). Kept in sync with the adapter's replacements().
export const BANNER_PLACEHOLDERS = [
  '__COADS_AD_TEXT__',
  '__COADS_CLICK_URL__',
  '__COADS_ICON_URL__',
  '__COADS_LB_BASE__',
  '__COADS_LB_TOKEN__',
  '__COADS_CORR__',
  '__COADS_AD_ID__',
  '__COADS_SURFACE__',
  '__COADS_VIEW_THRESHOLD_MS__',
  '__COADS_DEBUG__',
] as const;

// The body of the block. Wrapped in markers; the START/END markers stay in the
// emitted string by design so strip() can find them. The IIFE is self-guarding
// (idempotent mount) and CommonJS-aware.
export const CLAUDE_BANNER_BLOCK = `${BANNER_START}
;(function(){
  "use strict";
  // Pure, side-effect-free helpers (also exported under CommonJS for tests).
  function esc(s){
    return String(s==null?"":s)
      .split("&").join("&amp;")
      .split("<").join("&lt;")
      .split(">").join("&gt;")
      .split('"').join("&quot;");
  }
  function buildBannerHtml(o){
    o = o || {};
    var href = o.href || "#";
    var iconUrl = o.iconUrl || "";
    var ad = esc(o.ad || "");
    var icon = iconUrl
      ? '<img data-coads-bicon="1" src="' + esc(iconUrl) + '" width="16" height="16" style="border-radius:3px;vertical-align:middle" alt="">'
      : '<svg width="16" height="16" viewBox="0 0 16 16" style="vertical-align:middle"><circle cx="8" cy="8" r="7" fill="#F26321"></circle><circle cx="8" cy="8" r="2.6" fill="#fff"></circle></svg>';
    return '<a data-coads-bad="1" href="' + esc(href) + '" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;font:inherit;color:inherit;text-decoration:none;opacity:.85">'
      + icon + '<span>' + ad + '</span></a>';
  }
  // CommonJS / headless harness: export the pure helpers and DO NOT touch the DOM.
  if (typeof module !== "undefined" && module && module.exports) {
    module.exports.esc = esc;
    module.exports.buildBannerHtml = buildBannerHtml;
    return;
  }
  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (window.__coadsBannerMounted) return;
  window.__coadsBannerMounted = true;

  var AD_TEXT = __COADS_AD_TEXT__;
  var CLICK_URL = __COADS_CLICK_URL__;
  var ICON_URL = __COADS_ICON_URL__;
  var LB_BASE = __COADS_LB_BASE__;
  var LB_TOKEN = __COADS_LB_TOKEN__;
  var CORR = __COADS_CORR__;
  var AD_ID = __COADS_AD_ID__;
  var SURFACE = __COADS_SURFACE__;
  var DEBUG = __COADS_DEBUG__;

  // Fire-and-forget billing beacon to the loopback (§5.9 / §6.4). no-cors +
  // keepalive so it survives navigation; never reads a response.
  function beacon(ev){
    try{
      var u = LB_BASE + "/coads/" + LB_TOKEN + "/" + (ev === "click" ? "click" : "log")
        + "?ev=" + encodeURIComponent(ev) + "&corr=" + encodeURIComponent(CORR)
        + "&ad=" + encodeURIComponent(AD_ID) + "&surface=" + encodeURIComponent(SURFACE);
      fetch(u, {method:"POST", mode:"no-cors", keepalive:true});
    }catch(e){/* never throw into the host */}
  }

  // Programmatic icon fallback (CSP forbids inline onerror).
  document.addEventListener("error", function(e){
    var t = e && e.target;
    if(t && t.getAttribute && t.getAttribute("data-coads-bicon") === "1"){
      var span = document.createElement("span");
      span.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#F26321"></circle><circle cx="8" cy="8" r="2.6" fill="#fff"></circle></svg>';
      if(t.parentNode){ t.parentNode.replaceChild(span.firstChild, t); }
    }
  }, true);

  // Locate the usage-limit banner by its stable container-class prefix. Returns
  // null if absent — in which case we do nothing (safe).
  function findBanner(){
    var nodes = document.querySelectorAll('[class*="usageLimitBanner_"]');
    return nodes && nodes.length ? nodes[0] : null;
  }

  var overlayEl = null;
  function ensureOverlay(){
    if(overlayEl) return overlayEl;
    var el = document.createElement("div");
    el.setAttribute("data-coads-banner","1");
    el.style.cssText = "position:absolute;z-index:2147483646;display:flex;align-items:center;pointer-events:auto";
    el.innerHTML = buildBannerHtml({ad:AD_TEXT, href:CLICK_URL, iconUrl:ICON_URL});
    var a = el.querySelector('[data-coads-bad="1"]');
    if(a){ a.addEventListener("click", function(){ beacon("click"); }, true); }
    document.body.appendChild(el);
    overlayEl = el;
    beacon("impression_rendered");
    return el;
  }

  function paint(){
    var row = findBanner();
    if(!row){ if(overlayEl){ overlayEl.style.display = "none"; } return; }
    var r = row.getBoundingClientRect(); // READ-ONLY geometry; never reads content
    var el = ensureOverlay();
    el.style.display = "flex";
    el.style.left = (window.scrollX + r.left + 8) + "px";
    el.style.top = (window.scrollY + r.top + (r.height - 18) / 2) + "px";
  }

  try{
    paint();
    setInterval(paint, 1000);
  }catch(e){ if(DEBUG) beacon("error"); }
})();
${BANNER_END}`;
