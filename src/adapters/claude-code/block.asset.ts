// src/adapters/claude-code/block.asset.ts — the JS we append to Claude Code's
// installed `webview/index.js` (it runs after the React bundle's own IIFE). For
// the `claude-overlay` surface (§3 #1) it draws a sponsored line — text, an
// animated brand mark, and an elapsed counter — over Claude Code's loading verb
// (the "Discombobulating…" line) while a turn is running, and on click pings the
// local loopback for billing (§5.9 / §6.4) before VS Code opens the advertiser
// link in the browser.
//
// Invariants that keep the overlay from fighting Claude Code's renderer — each
// earned against shipping CC builds, so change none of them without reading the
// rest of this file first:
//
//   • Find the verb by its CONTAINER CLASS, not by sniffing for a glyph. On CC
//     2.1.175 the loading verb sits in a row whose class begins `spinnerRow_`
//     (the suffix is a per-build hash), next to `messagesContainer_*` /
//     `stickyMode_*`, and CC cycles a sparkle from ["·","✢","*","✶","✻","✽"]
//     inside it. We anchor on the stable `spinnerRow_` prefix. Matching the glyph
//     instead would also catch Monaco and markdown spans and paint over the
//     user's text; class-scoping rules that out. If CC renames the row the
//     overlay simply doesn't appear — the safe way to fail.
//
//   • Leave CC's React subtree alone. Any innerHTML / append / restyle inside the
//     spinner row gets torn out on the next reconcile and won't re-render that
//     turn. We only READ the row's rect (getBoundingClientRect is safe to call)
//     and draw into our own absolutely-positioned node appended to <body>, outside
//     every React root, parked over the verb. It's opaque (background sampled from
//     the theme), so CC's glyph behind it is fully hidden.
//
//   • Each frame, write only the cached child text nodes (the dots span + the
//     elapsed span). Rebuilding innerHTML every tick (~12×/s) would swap the anchor
//     out between mousedown and mouseup and eat the click. A full structural rebuild
//     happens only when the creative signature (adText|clickUrl|iconUrl) changes,
//     refreshing the cached `_dotsEl` / `_elapsedEl` refs at that point.
//
//   • Render only while the turn is genuinely active, judged by content FRESHNESS
//     rather than glyph presence: at turn end CC blanks/freezes the row but leaves
//     it mounted, so "row exists" — and even "glyph exists" — stay true forever.
//     We remember the row's first non-space code point and treat it as active only
//     if that code point changed within GRACE_MS; otherwise we drop the overlay and
//     leave CC's idle UI untouched. That stops a frozen, stale row from animating
//     an ad indefinitely at idle.
//
//   • The icon fallback is wired in JS: the ad <img> carries data-coads-icon="1",
//     and one document-level CAPTURE-phase `error` listener swaps a broken image
//     for our inline brand-dot SVG. It has to be programmatic — CC's webview
//     script-src CSP omits 'unsafe-inline', so an inline onerror="" would be blocked.
//
// Mechanics (load-bearing):
//   • The `/*__COADS_OVERLAY_START__*/ … /*__COADS_OVERLAY_END__*/` markers let
//     injection.ts find the block and strip it byte-for-byte; Restore additionally
//     reinstates a sha256-checked backup of the original bundle (belt and braces).
//   • Placeholders are bare `__COADS_*__` tokens that materializeBlock replaces with
//     fully-formed JS literals (strings JSON.stringify'd by the adapter), so the
//     block never concatenates untrusted text — a placeholder always lands in a value
//     slot, e.g. `adText:__COADS_AD_TEXT__` → `adText:"Linear — fast issue tracking"`.
//   • Inline styles are permitted (host CSP `style-src ${cspSource} 'unsafe-inline'`,
//     confirmed in extension.js@2.1.175); our code runs under the bundle's nonce'd
//     <script>, which `script-src 'nonce-…'` allows.
//   • The beacon is `mode:'no-cors'` with no custom headers and an empty body — a
//     CORS simple request, so no preflight; the only CSP tweak needed is
//     `connect-src http://127.0.0.1:*` (added by the adapter's prime()).
//   • We never preventDefault the anchor: the webview opens http(s) links in the
//     browser by default, which IS the §6.4 click-out. The /click beacon is only
//     the billing ping; losing it must never cost the click-through.

export const OVERLAY_START = '/*__COADS_OVERLAY_START__*/';
export const OVERLAY_END = '/*__COADS_OVERLAY_END__*/';

// The placeholder names the adapter must supply (see materializeBlock). These
// are the entire surface contract; the overlay block reuses all of them and adds
// NO new placeholder (there is no TIER input — the full layout always renders).
export const OVERLAY_PLACEHOLDERS = [
  '__COADS_ADS__',
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

// NOTE: leading `;` guards against ASI issues when appended after the bundle.
// The runtime is authored below as a readable IIFE and then folded into the
// marker-delimited export string. Authoring it as real source (not a minified
// one-liner) keeps the overlay logic reviewable; esbuild does not
// minify this file's string contents — the readability here is for humans.
export const CLAUDE_OVERLAY_BLOCK =
  OVERLAY_START +
  ';(function(){' +
  '"use strict";' +
  'try{' +
  // ---- config (placeholders land in JS value positions) ------------------
  'var CFG={' +
  // The full auction queue (per-message rotation set). Empty ⇒ single-creative
  // back-compat using the baked adText/clickUrl/etc. below.
  'ads:__COADS_ADS__,' +
  'adText:__COADS_AD_TEXT__,' +
  'clickUrl:__COADS_CLICK_URL__,' +
  'iconUrl:__COADS_ICON_URL__,' +
  'lbBase:__COADS_LB_BASE__,' +
  'lbToken:__COADS_LB_TOKEN__,' +
  'corr:__COADS_CORR__,' +
  'adId:__COADS_AD_ID__,' +
  'surface:__COADS_SURFACE__,' +
  'thresholdMs:__COADS_VIEW_THRESHOLD_MS__,' +
  'debug:__COADS_DEBUG__' +
  '};' +

  // ---- loopback beacon (§5.9 / §6.4) -------------------------------------
  // POST to <lbBase>/coads/<lbToken>/<kind>?corr=..&ad=..&surface=..[&extra].
  // fire-and-forget, no-cors, keepalive. sendBeacon is the most reliable path
  // across Electron versions for the click case (it races the host's external
  // navigation tearing the document down on the same tick); fall back to
  // fetch+keepalive. Metrics are best-effort and must NEVER disturb the page.
  'function beacon(kind,extra){try{' +
  'var u=String(CFG.lbBase).replace(/\\/$/,"")+"/coads/"+CFG.lbToken+"/"+kind+' +
  '"?corr="+encodeURIComponent(CFG.corr)+"&ad="+encodeURIComponent(CFG.adId)+' +
  '"&surface="+encodeURIComponent(CFG.surface)+(extra?("&"+extra):"");' +
  'try{if(navigator&&typeof navigator.sendBeacon==="function"&&' +
  'navigator.sendBeacon(u,new Blob([],{type:"application/x-www-form-urlencoded"}))){return;}}catch(e){}' +
  'fetch(u,{method:"POST",mode:"no-cors",keepalive:true});' +
  '}catch(e){}}' +

  // ---- pure helpers (also exported for unit tests, see module.exports) ----
  // Seconds-elapsed label, one decimal: round the tenths, then print (ms 1234 → "1.2s").
  'function fmtElapsed(ms){return (Math.round(ms/100)/10).toFixed(1)+"s";}' +
  // A run of `frame % 6` dots (0..5), built by repeating "." — wait-cadence comes
  // from the render loop. (Kept for the headless harness; the live row uses brandRing.)
  'function ellipsis(frame){return new Array((frame%6)+1).join(".");}' +
  // HTML-escape the one structural innerHTML write (rebuild path): & first, then
  // the angle brackets and the double quote, each its own pass.
  'function esc(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")' +
  '.replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
  // Fallback mark when no icon URL is supplied OR the <img> 404s: a brand-orange
  // dot with a white core — the BoringSpinner ring motif in miniature (not a
  // lettered badge). Inline SVG so it stays CSP-safe under the host webview.
  'var ICON_FALLBACK=' +
  '\'<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" \'+' +
  '\'style="vertical-align:middle;flex:0 0 auto;display:block">\'+' +
  '\'<circle cx="8" cy="8" r="7" fill="#F26321"/>\'+' +
  '\'<circle cx="8" cy="8" r="2.6" fill="#ffffff"/></svg>\';' +
  // The ad-icon <img>. data-coads-icon="1" lets the capture-phase error
  // listener swap it for the inline 'C' SVG if it fails to load.
  'function iconImg(url){return \'<img src="\'+esc(url)+\'" width="13" height="13" \'+' +
  '\'data-coads-icon="1" aria-hidden="true" \'+' +
  '\'style="vertical-align:middle;border-radius:3px;flex:0 0 auto;display:block;object-fit:contain" />\';}' +
  // Build the ad's inner HTML: favicon + clickable underlined anchor (the ad
  // text + a fixed-width animated-dots slot) pinned left, and a tabular-nums
  // elapsed timer pinned right (margin-left:auto). Fixed-width dots + tabular
  // digits prevent reflow/jitter as the strings change length. The anchor's
  // href is the advertiser URL (the VS Code host opens it externally) and is
  // tagged data-coads-ad="1" for the capture-phase click listener. Pure;
  // unit-tested via module.exports.
  // The animated BoringSpinner brand mark: 12 orange (#F26321) dots in a ring,
  // each fading in sequence (1s, staggered) — the logo "in motion". This REPLACES
  // the old text "…" dots. Pure CSS; the @keyframes `coadsfade` is injected once
  // at mount (style-src allows it). data-coads-dots is kept so existing refs work.
  'function brandRing(){' +
  'var R=13,rad=R/2-R*0.13,d=Math.max(2,R*0.16),h="";' +
  'for(var i=0;i<12;i++){' +
  'var a=(i/12)*Math.PI*2-Math.PI/2;' +
  'var cx=R/2+Math.cos(a)*rad,cy=R/2+Math.sin(a)*rad;' +
  'h+=\'<i style="position:absolute;border-radius:999px;background:#F26321;width:\'+d+\'px;height:\'+d+' +
  '\'px;left:\'+(cx-d/2).toFixed(2)+\'px;top:\'+(cy-d/2).toFixed(2)+\'px;\'+' +
  '\'animation:coadsfade 1s linear infinite;animation-delay:\'+(i/12).toFixed(3)+\'s"></i>\';' +
  '}' +
  'return \'<span data-coads-dots="1" aria-label="BoringSpinner" style="position:relative;\'+' +
  '\'display:inline-block;width:\'+R+\'px;height:\'+R+\'px;margin-left:6px;vertical-align:middle;\'+' +
  '\'flex:0 0 auto">\'+h+"</span>";' +
  '}' +
  'function buildAdHtml(s){' +
  'var ad=esc(s.ad);' +
  // Over-cap "Thought of the Day": no clickUrl → render the 💭 quote as a plain,
  // non-clickable line (no favicon, no animated ring, no elapsed timer). The 💭
  // and " — author" are already baked into the text; nothing here is billable.
  'if(!s.href){return \'<span style="display:flex;align-items:center;width:100%;\'+' +
  '\'box-sizing:border-box;padding:0 8px;white-space:nowrap;overflow:hidden;\'+' +
  '\'text-overflow:ellipsis;color:var(--vscode-foreground,currentColor)">\'+ad+"</span>";}' +
  'var href=s.href?esc(s.href):"#";' +
  'var FG="var(--vscode-foreground,currentColor)";' +
  'var DIM="var(--vscode-descriptionForeground,currentColor)";' +
  'var fav=s.iconUrl?iconImg(s.iconUrl):ICON_FALLBACK;' +
  'var DOTS=brandRing();' +
  'var anchor=\'<a href="\'+href+\'" target="_blank" rel="noopener noreferrer" \'+' +
  '\'data-coads-ad="1" style="color:\'+FG+\';text-decoration:underline;\'+' +
  '\'overflow:hidden;text-overflow:ellipsis">\'+ad+DOTS+"</a>";' +
  'var left=\'<span style="display:flex;align-items:center;gap:7px;color:\'+FG+\';min-width:0">\'+fav+anchor+"</span>";' +
  'var right=\'<span data-coads-elapsed="1" style="font-size:11px;color:\'+DIM+\';\'+' +
  '\'flex:0 0 auto;margin-left:auto;padding-left:24px;\'+' +
  '\'font-family:var(--vscode-editor-font-family,ui-monospace,monospace);\'+' +
  '\'font-variant-numeric:tabular-nums">\'+esc(s.elapsed||"")+"</span>";' +
  'return \'<span style="display:flex;align-items:center;width:100%;box-sizing:border-box;\'+' +
  '\'padding:0 8px;justify-content:flex-start;white-space:nowrap">\'+left+right+"</span>";' +
  '}' +

  // Test/headless harness: expose the pure helpers and return BEFORE any DOM /
  // `window` access (so the helpers can be unit-tested in a plain CJS module).
  // This MUST precede the mount guard below — the guard touches `window`, which
  // is absent in the exports harness.
  'if(typeof module!=="undefined"&&module.exports){' +
  'module.exports={fmtElapsed:fmtElapsed,ellipsis:ellipsis,esc:esc,buildAdHtml:buildAdHtml};' +
  'return;}' +

  // idempotent mount guard (DOM runtime begins here)
  'if(window.__coadsOverlayMounted){return;}window.__coadsOverlayMounted=true;' +
  // Inject the brand-ring keyframes once (host style-src allows inline <style>).
  // The 12 ring dots reference `coadsfade`; absent it they simply render static.
  'try{var _cs=document.createElement("style");' +
  '_cs.textContent="@keyframes coadsfade{0%{opacity:1}100%{opacity:0.18}}";' +
  '(document.head||document.documentElement).appendChild(_cs);}catch(e){}' +

  // ---- debug relay (gated) -----------------------------------------------
  // Relay a timestamped lifecycle line to the loopback (→ server-side debug
  // log) so a headless agent can diagnose without a screen. Gated on
  // CFG.debug; never disturbs the spinner. Reuses the beacon path's /log kind.
  'function dlog(evt,data){if(!CFG.debug){return;}try{' +
  'var extra="ev="+encodeURIComponent(evt);' +
  'if(data){for(var k in data){extra+="&"+encodeURIComponent(k)+"="+encodeURIComponent(String(data[k]));}}' +
  'beacon("log",extra);}catch(e){}}' +

  // ---- per-turn render state ---------------------------------------------
  'var st={simStart:0,frame:0};' +
  // The body-level overlay element + cached volatile children (hot path).
  'var overlay=null,_chromeSig="",_dotsEl=null,_elapsedEl=null;' +
  // Active-turn tracking: the verb node we last painted + when we last saw it
  // fresh, and the freshness signature (first non-ws code point + its change ts).
  'var lastNode=null,lastSeenMs=0,lastSig=null,lastSigMs=0;' +
  // Impression beacon latches (re-armed per turn by _turnStart so each rotated
  // creative fires its OWN impression).
  'var _sentRender=false,_sentThreshold=false;' +
  // Round-robin pointer into CFG.ads — advances one creative per active turn.
  'var _adIdx=0;' +
  // Idle debounce: how long the spinner may be stale before we drop the
  // overlay. CC re-renders spinnerRow continuously while thinking (content
  // CHANGES); at turn end it empties/freezes the row but keeps it mounted, so
  // freshness — not presence — is the liveness signal. GRACE_MS bridges the
  // (sometimes >1s) gaps between CC's intra-turn verb re-renders.
  'var GRACE_MS=1500;' +
  // view-threshold timer handle (cleared on drop so an idle drop cancels a
  // pending threshold beacon).
  'var _thresholdTimer=null;' +

  // ---- ad-icon load-failure → inline badge (capture phase) ----------------
  // `error` events don\'t bubble but DO fire in the capture phase on ancestors,
  // so one document-level capture listener covers the overlay icon. Programmatic
  // by necessity (inline onerror="" is blocked by CC\'s webview script-src CSP).
  // Idempotent: swapping outerHTML removes the data-coads-icon node so it can\'t
  // re-fire. Everything is wrapped so a fallback can never disturb the page.
  'try{document.addEventListener("error",function(ev){try{' +
  'var t=ev&&ev.target;' +
  'if(t&&t.tagName==="IMG"&&t.getAttribute&&t.getAttribute("data-coads-icon")==="1"){' +
  't.outerHTML=ICON_FALLBACK;}}catch(e){}},true);}catch(e){}' +

  // ---- click → billing beacon (capture phase) -----------------------------
  // The anchor\'s real http(s) href is what opens the advertiser page (the VS
  // Code host navigates it externally — the only click-out that survives CC\'s
  // `default-src \'none\'` CSP). We therefore do NOT preventDefault. The /click
  // beacon is purely the fire-and-forget billing metric. Capture phase, guarded.
  'try{document.addEventListener("click",function(ev){' +
  'var el=ev.target;' +
  'while(el&&el!==document){' +
  'if(el.getAttribute&&el.getAttribute("data-coads-ad")){' +
  'dlog("click");beacon("click");return;}' +
  'el=el.parentNode;}' +
  '},true);}catch(e){}' +

  // ---- spinner-verb locator ----------------------------------------------
  // On CC 2.1.175 the loading verb lives in a CSS-module row classed
  // `spinnerRow_<hash>` (a sibling of `messagesContainer_*` / `stickyMode_*`),
  // with CC's sparkle glyph animating in a child. We select on the `spinnerRow_`
  // class prefix only — never a glyph or markdown heuristic, which would also
  // match the Monaco editor and paint over the user's text — and we only READ the
  // node. Since the transcript grows downward, the live row is the LAST non-empty
  // match: CC can leave an earlier row frozen mid-glyph yet still mounted, so taking
  // the first match would let a dead row mask the live one. A blank/whitespace row
  // counts as "no spinner". We scan from the end and stop at the first non-empty hit.
  'function findSpinner(){' +
  'var rows=document.querySelectorAll(\'[class*="spinnerRow_"]\');' +
  'for(var i=rows.length-1;i>=0;i--){' +
  'var el=rows[i];' +
  'if(el.nodeType===1&&(el.textContent||"").trim()!==""){return el;}}' +
  'return null;}' +
  // Liveness gate: CC leaves spinnerRow mounted after a turn, so presence alone
  // doesn't tell active from idle. While CC is thinking it cycles a sparkle glyph
  // (✢ U+2722, ✶ U+2736, ✻ U+273B, ✽ U+273D) at the head of the row. Reading
  // textContent is read-only / React-safe and only ever looks at the class-scoped
  // node. SPARKLES holds CC's own glyph code points.
  'var SPARKLES=[0x2722,0x2736,0x273b,0x273d];' +
  'function rowActive(row){' +
  'if(!row){return false;}' +
  'var head=(row.textContent||"").replace(/^\\s+/,"").charCodeAt(0);' +
  'return SPARKLES.indexOf(head)>=0;}' +
  // Sample the panel\'s real background (getComputedStyle is reconciliation-safe)
  // so the overlay is opaque AND theme-matched — it has to be opaque to hide the
  // verb glyph underneath; a see-through overlay lets the glyph bleed through and
  // garble the ad. Walk up to ten ancestors for the first non-transparent
  // background, else fall back to the editor-bg theme var.
  'function surfaceBg(el){try{' +
  'for(var n=el,i=0;n&&n.nodeType===1&&i<10;i++,n=n.parentElement){' +
  'var bg=(window.getComputedStyle(n)||{}).backgroundColor;' +
  'if(bg&&bg!=="transparent"&&bg!=="rgba(0, 0, 0, 0)"){return bg;}}' +
  '}catch(e){}' +
  'return "var(--vscode-editor-background,#1e1e1e)";}' +

  // ---- body-level overlay create / position / drop ------------------------
  'function ensureOverlay(row){' +
  'if(overlay&&overlay.parentNode){return overlay;}' +
  'overlay=document.createElement("div");' +
  'overlay.setAttribute("data-coads-overlay","1");' +
  // opaque, theme-matched; visibility:hidden until the first placeOverlay sets
  // real coordinates (kills the flash over CC\'s input on first mount).
  'overlay.style.cssText="position:fixed;z-index:2147483646;pointer-events:auto;"+' +
  '"display:flex;align-items:center;box-sizing:border-box;overflow:hidden;"+' +
  '"white-space:nowrap;visibility:hidden;background:"+surfaceBg(row);' +
  'try{(document.body||document.documentElement).appendChild(overlay);}catch(e){}' +
  'return overlay;}' +
  'var _rect="";' +
  // Pin the overlay onto the verb\'s rect. getBoundingClientRect is READ-ONLY, and
  // we write styles only when the rect actually moved, so a no-op frame can\'t
  // thrash layout. Under jsdom there\'s no layout (rect all zero) — the ad still
  // renders, it just isn\'t positioned.
  'function placeOverlay(row){try{' +
  'var r=row.getBoundingClientRect();' +
  'if(!r||!(r.width||r.height||r.top||r.left)){return;}' +
  'var sig=[r.left,r.top,r.width,r.height].join(":");' +
  'if(sig===_rect){return;}' +
  '_rect=sig;' +
  'var s=overlay.style;' +
  's.left=r.left+"px";s.top=r.top+"px";s.minWidth=r.width+"px";s.height=r.height+"px";' +
  's.visibility="visible";' +
  '}catch(e){}}' +
  // Drop the overlay entirely (idle / watchdog). Leaves CC\'s own idle UI
  // untouched and clears every cached ref + per-turn state so the next active
  // turn opens a fresh session.
  'function dropOverlay(){' +
  'try{if(_thresholdTimer){clearTimeout(_thresholdTimer);_thresholdTimer=null;}}catch(e){}' +
  'try{if(overlay&&overlay.parentNode){overlay.parentNode.removeChild(overlay);}}catch(e){}' +
  'overlay=null;_rect="";lastNode=null;st.simStart=0;st.frame=0;' +
  '_chromeSig="";_dotsEl=null;_elapsedEl=null;}' +

  // ---- per-turn ad rotation (per-message creative swap) -------------------
  // The whole auction queue is baked into CFG.ads. rotate() advances to the next
  // entry (round-robin) and assigns it to the CFG fields paint()/beacon() read,
  // so the VS Code panel shows a DIFFERENT campaign on every message and a click
  // attributes to the ad actually shown. No-op when CFG.ads is empty (single
  // creative / banner keep the baked placeholders). _adIdx persists across the
  // idle-drop between turns, so rotation continues turn to turn.
  'function rotate(){try{' +
  'if(CFG.ads&&CFG.ads.length){' +
  'var a=CFG.ads[_adIdx%CFG.ads.length];_adIdx++;' +
  'if(a){CFG.adId=a.adId;CFG.adText=a.adText;CFG.clickUrl=a.clickUrl;CFG.iconUrl=a.iconUrl;CFG.corr=a.corr;}' +
  '}}catch(e){}}' +
  // Called once at the START of each active turn (from paint, when st.simStart is
  // 0 — reset by the idle drop between messages). Advance the creative, re-arm the
  // impression/threshold beacons for the NEW ad, and force a structural rebuild so
  // the new text/href/icon render this turn.
  'function _turnStart(){' +
  'rotate();' +
  '_sentRender=false;_sentThreshold=false;' +
  'try{if(_thresholdTimer){clearTimeout(_thresholdTimer);_thresholdTimer=null;}}catch(e){}' +
  '_chromeSig="";' +
  '}' +

  // ---- hot-path paint -----------------------------------------------------
  // Called while a turn is active. Structural rebuild (innerHTML) ONLY when the
  // creative signature changes; otherwise update ONLY the cached child
  // textContents (dots + elapsed). NEVER rewrite innerHTML per tick — that
  // detaches the click anchor mid-click. Fires impression_rendered once on the
  // first paint and arms the view_threshold_met timer.
  'function paint(row,anim){' +
  'var now=Date.now();' +
  'lastNode=row;lastSeenMs=now;' +
  'if(anim){st.frame++;}' +
  'if(!st.simStart){st.simStart=now;_turnStart();}' +
  // CFG.adId is empty for an over-cap "Thought of the Day" quote — fire NO
  // impression_rendered / view_threshold_met beacons for it (quotes never bill).
  'if(CFG.adId&&!_sentRender){_sentRender=true;dlog("impression_rendered");beacon("log","ev=impression_rendered");' +
  'if(CFG.thresholdMs>0&&!_sentThreshold){_thresholdTimer=setTimeout(function(){' +
  '_sentThreshold=true;dlog("view_threshold_met");beacon("log","ev=view_threshold_met");},CFG.thresholdMs);}}' +
  'var o=ensureOverlay(row);' +
  'placeOverlay(row);' +
  // The brand ring self-animates via CSS, so the hot path only updates the
  // elapsed timer; the ring is rebuilt only when the creative changes (no
  // per-tick textContent write that would wipe its dots).
  'var elapsed=fmtElapsed(now-st.simStart);' +
  'var sig=CFG.adId+"|"+CFG.adText+"|"+CFG.clickUrl+"|"+CFG.iconUrl;' +
  'if(sig!==_chromeSig){' +
  'o.innerHTML=buildAdHtml({ad:CFG.adText,href:CFG.clickUrl,iconUrl:CFG.iconUrl,elapsed:elapsed});' +
  '_chromeSig=sig;' +
  '_elapsedEl=o.querySelector("[data-coads-elapsed]");' +
  '}else{' +
  'if(_elapsedEl){_elapsedEl.textContent=elapsed;}}' +
  '}' +

  // ---- rAF positioner -----------------------------------------------------
  // Reposition every animation frame so the overlay stays glued to the verb
  // with zero perceptible lag while the row moves (scroll / streaming). ONE
  // gated getBoundingClientRect per frame; rAF self-pauses when the tab is
  // hidden. Content/animation + idle detection live on the slower interval.
  'function frame(){try{' +
  'if(overlay&&lastNode&&lastNode.isConnected){placeOverlay(lastNode);}' +
  '}catch(e){}' +
  'try{window.requestAnimationFrame(frame);}catch(e){setTimeout(frame,16);}}' +
  'try{window.requestAnimationFrame(frame);}catch(e){setTimeout(frame,16);}' +

  // ---- evaluator (active-turn gating) -------------------------------------
  // Primary cadence. find the live spinner row (class-scoped, read-only), track
  // its first-code-point freshness, and decide active vs idle. Active == the
  // sparkle glyph leads AND the content changed within GRACE_MS. A frozen stale
  // glyph fails the freshness gate so the ad does not animate at idle. Idle =>
  // DROP the overlay (we never strand it over CC\'s content). Biased toward
  // HIDE: a missed show is mild; a stuck overlay over CC\'s UI is the failure
  // that burned the reference repeatedly.
  'var _evaluating=false;' +
  'function evaluate(){' +
  'if(_evaluating){return;}_evaluating=true;' +
  'try{' +
  'var now=Date.now();' +
  'var row=findSpinner();' +
  'if(row){' +
  'var t=(row.textContent||"").replace(/^[\\s ]+/,"");' +
  'var cc=t.charCodeAt(0)|0;' +
  'if(cc!==lastSig){lastSig=cc;lastSigMs=now;}' +
  '}else{lastSig=null;}' +
  'var glyphLed=!!(row&&rowActive(row));' +
  'var fresh=glyphLed&&lastSigMs>0&&(now-lastSigMs)<=GRACE_MS;' +
  'if(glyphLed&&fresh){' +
  'paint(row,true);' +
  '}else if(overlay&&((now-lastSeenMs)>GRACE_MS||(glyphLed&&!fresh))){' +
  'dlog("idle.drop",{sinceSeenMs:now-lastSeenMs});' +
  'dropOverlay();' +
  '}' +
  '}catch(e){dlog("loop.error",{msg:String(e&&e.message||e).slice(0,160)});}' +
  'finally{_evaluating=false;}}' +
  'try{setInterval(evaluate,80);}catch(e){}' +

  // ---- live ad refresh (v0.3.6) -------------------------------------------
  // Poll the extension loopback for the CURRENT auction queue and swap CFG.ads
  // in place, so a chat session kept open for days picks up NEW campaigns with
  // no reload. The next turn\'s rotate() draws from the fresh set. CORS-readable
  // JSON (the loopback stamps access-control-allow-origin:*); connect-src already
  // permits 127.0.0.1:* for the beacons. Best-effort — never disturbs the page.
  'function pollAds(){try{' +
  'if(!CFG.lbBase||!CFG.lbToken){return;}' +
  'var u=String(CFG.lbBase).replace(/\\/$/,"")+"/coads/"+CFG.lbToken+"/ads";' +
  'fetch(u).then(function(r){return r&&r.ok?r.json():null;}).then(function(d){' +
  'if(d&&d.ads&&d.ads.length){CFG.ads=d.ads;dlog("ads.refreshed",{n:d.ads.length});}' +
  '}).catch(function(){});' +
  '}catch(e){}}' +
  'try{setInterval(pollAds,30000);}catch(e){}' +

  // ---- recovery signals ---------------------------------------------------
  // rAF pauses while the tab is hidden, so a turn that ended in the background
  // could leave a stale overlay. Re-evaluate on re-show / focus.
  'try{document.addEventListener("visibilitychange",function(){if(!document.hidden){evaluate();}},false);' +
  'window.addEventListener("focus",function(){evaluate();},false);}catch(e){}' +
  // Independent watchdog: lastSeenMs refreshes every active paint(), so this
  // only fires if the main loop itself wedged yet the overlay is still up — a
  // true backstop against "stuck forever". Its own timer so a broken evaluate()
  // can\'t disable it.
  'var WATCHDOG_MS=15000;' +
  'try{setInterval(function(){try{' +
  'if(overlay&&(Date.now()-lastSeenMs)>WATCHDOG_MS){dlog("watchdog.drop");dropOverlay();}' +
  '}catch(e){}},5000);}catch(e){}' +

  'dlog("block.start");' +
  '}catch(e){}' +
  '})();' +
  OVERLAY_END;
