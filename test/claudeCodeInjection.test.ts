import { describe, it, expect } from 'vitest';
import {
  applyOverlayBlock,
  hasCspRelax,
  hasOverlayBlock,
  materializeBlock,
  relaxCsp,
  restoreCsp,
  stripOverlayBlock,
  CSP_ANCHOR,
  CSP_CONNECT,
} from '../src/adapters/claude-code/injection';
import {
  CLAUDE_OVERLAY_BLOCK,
  OVERLAY_START,
  OVERLAY_END,
  OVERLAY_PLACEHOLDERS,
} from '../src/adapters/claude-code/block.asset';

// A faithful slice of the real 2.1.175 host CSP template literal.
const HOST_CSP =
  'x.html=`<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ${p}; ${f}; ${m}; script-src \'nonce-${u}\'; ${g};">`;rest()';

describe('claude-overlay injection — ad block (webview/index.js)', () => {
  const block = materializeBlock(CLAUDE_OVERLAY_BLOCK, {
    __COADS_ADS__: JSON.stringify([
      { adId: 'ad_1', adText: 'Sponsored: Linear →', clickUrl: 'https://linear.app', iconUrl: '', corr: 'ad_1.r' },
      { adId: 'ad_2', adText: 'Bet on the insiders', clickUrl: 'https://poly.bet', iconUrl: '', corr: 'ad_2.r' },
    ]),
    __COADS_AD_TEXT__: JSON.stringify('Sponsored: Linear →'),
    __COADS_CLICK_URL__: JSON.stringify('https://linear.app'),
    __COADS_ICON_URL__: JSON.stringify(''),
    __COADS_LB_BASE__: JSON.stringify('http://127.0.0.1:5555'),
    __COADS_LB_TOKEN__: JSON.stringify('tok123'),
    __COADS_CORR__: JSON.stringify('ad_1.r'),
    __COADS_AD_ID__: JSON.stringify('ad_1'),
    __COADS_SURFACE__: JSON.stringify('claude-overlay'),
    __COADS_VIEW_THRESHOLD_MS__: '3000',
    __COADS_DEBUG__: 'false',
  });

  it('materializes every placeholder (none left behind)', () => {
    // every value placeholder is substituted (the START/END markers remain by design)
    for (const ph of OVERLAY_PLACEHOLDERS) expect(block).not.toContain(ph);
    expect(block).toContain('Sponsored: Linear');
    expect(block).toContain('https://linear.app');
    expect(block).toContain('/coads/');
    expect(block.startsWith(OVERLAY_START)).toBe(true);
    expect(block.endsWith(OVERLAY_END)).toBe(true);
  });

  it('bakes the FULL rotation queue (per-message swap) + the rotate hook', () => {
    // both campaigns' creatives are present in CFG.ads → the block can rotate.
    expect(block).toContain('Bet on the insiders');
    expect(block).toContain('https://poly.bet');
    // the rotation machinery is wired: advance on each active turn.
    expect(block).toContain('function rotate(');
    expect(block).toContain('function _turnStart(');
    expect(block).toContain('_turnStart()');
  });

  it('is a VERB-PINNED spinner clobber (not the old fixed bottom bar)', () => {
    // Prime-directive locator: the verb is found by CC's spinner CONTAINER
    // CLASS prefix, NEVER a glyph/markdown heuristic.
    expect(block).toContain('spinnerRow_');
    expect(block).toContain('querySelectorAll');
    // The body-level overlay + its hot-path child hooks the renderer caches.
    expect(block).toContain('data-coads-overlay');
    expect(block).toContain('data-coads-dots');
    expect(block).toContain('data-coads-elapsed');
    // Clickable ad anchor (capture-phase billing) + programmatic icon fallback
    // (no inline onerror — CSP forbids it).
    expect(block).toContain('data-coads-ad');
    expect(block).toContain('data-coads-icon');
    // The OLD fixed-bottom-bar implementation is gone: no fixed bottom bar, no
    // `coads-overlay` id, no uppercase "Sponsored" tag, no `×` close button.
    expect(block).not.toContain('bottom:0');
    expect(block).not.toContain('id="coads-overlay"');
    expect(block).not.toContain('coads-overlay-link');
    expect(block).not.toContain('text-transform:uppercase');
    expect(block).not.toContain('\\u00d7'); // the × close glyph
    // We must NOT preventDefault — the VS Code host opens the http(s) href
    // externally, which is the intended click-out.
    expect(block).not.toContain('preventDefault');
    // Idempotent mount guard is retained.
    expect(block).toContain('window.__coadsOverlayMounted');
  });

  it('keeps the loopback beacon plumbing (impression + threshold + click)', () => {
    // POST to <lbBase>/coads/<lbToken>/<kind>?corr=..&ad=..&surface=..
    expect(block).toContain('mode:"no-cors"');
    expect(block).toContain('keepalive:true');
    expect(block).toContain('"/coads/"');
    expect(block).toContain('ev=impression_rendered');
    expect(block).toContain('ev=view_threshold_met');
    expect(block).toContain('beacon("click")');
  });

  it('append → strip is byte-exact (reversible)', () => {
    const original = 'var btt=Object.create;/*4.8MB of bundle*/console.log(1);';
    const patched = applyOverlayBlock(original, block);
    expect(hasOverlayBlock(patched)).toBe(true);
    expect(patched).toContain('Sponsored: Linear');
    expect(stripOverlayBlock(patched)).toBe(original);
  });

  it('re-apply swaps creative without stacking blocks', () => {
    const original = 'BUNDLE();';
    const once = applyOverlayBlock(original, block);
    const twice = applyOverlayBlock(once, block);
    // exactly one block present
    expect(twice.split(OVERLAY_START).length - 1).toBe(1);
    expect(stripOverlayBlock(twice)).toBe(original);
  });

  it('strip is a no-op when no block present', () => {
    expect(stripOverlayBlock('clean bundle')).toBe('clean bundle');
    expect(hasOverlayBlock('clean bundle')).toBe(false);
  });
});

describe('claude-overlay injection — CSP relaxation (extension.js)', () => {
  it('inserts connect-src after default-src and is reversible byte-exact', () => {
    expect(hasCspRelax(HOST_CSP)).toBe(false);
    const relaxed = relaxCsp(HOST_CSP);
    expect(relaxed.ok).toBe(true);
    expect(relaxed.changed).toBe(true);
    expect(hasCspRelax(relaxed.out)).toBe(true);
    expect(relaxed.out).toContain('connect-src http://127.0.0.1:* https://*.boringspinner.com');
    // the ${p} template var is preserved verbatim (no $ interpretation)
    expect(relaxed.out).toContain('${p}; ${f}; ${m}');
    // round-trip
    const back = restoreCsp(relaxed.out);
    expect(back.out).toBe(HOST_CSP);
  });

  it('relax is idempotent', () => {
    const once = relaxCsp(HOST_CSP).out;
    const twice = relaxCsp(once);
    expect(twice.changed).toBe(false);
    expect(twice.out).toBe(once);
  });

  it('fails cleanly when the anchor is absent (wrong/changed bundle)', () => {
    const op = relaxCsp('no csp here');
    expect(op.ok).toBe(false);
    expect(op.changed).toBe(false);
    expect(op.reason).toMatch(/anchor not found/);
  });

  it('does NOT match the secondary markdown webview CSP', () => {
    const markdownCsp = `content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-{{NONCE}}'; img-src data:;"`;
    expect(relaxCsp(markdownCsp).ok).toBe(false); // no `${var}` after default-src, no native loopback
    expect(CSP_ANCHOR).toContain('${p}');
    expect(CSP_CONNECT).toContain('127.0.0.1:*');
  });

  // Version-tolerance: the minified CSP directive var changes across Claude Code
  // builds (`${p}` on VS Code 2.1.175, others elsewhere). The regex matches ANY
  // `${var};` immediately after `default-src 'none';`, not just `${p}`.
  it('relaxes a build that uses a DIFFERENT minified CSP var (${D})', () => {
    const otherBuild =
      'x.html=`<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ${D}; ${J}; script-src \'nonce-${q}\';">`;';
    const relaxed = relaxCsp(otherBuild);
    expect(relaxed.ok).toBe(true);
    expect(relaxed.changed).toBe(true);
    expect(relaxed.out).toContain('connect-src http://127.0.0.1:* https://*.boringspinner.com');
    expect(relaxed.out).toContain('${D}; ${J}'); // the build's var preserved verbatim
    expect(restoreCsp(relaxed.out).out).toBe(otherBuild); // round-trip byte-exact
  });

  // Cursor's Claude Code 2.1.63 ALREADY bakes the loopback into its panel CSP
  // (`default-src 'none'; connect-src http://127.0.0.1:* http://localhost:*; ${D}`).
  // relaxCsp must treat this as a no-op SUCCESS (not a failure) so the overlay
  // still injects — the beacon reaches 127.0.0.1 via the host's own CSP.
  it('treats a build that already allows the loopback as a no-op success (Cursor 2.1.63)', () => {
    const cursorCsp =
      'x.html=`<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; connect-src http://127.0.0.1:* http://localhost:*; ${D}; script-src \'nonce-${q}\';">`;';
    const op = relaxCsp(cursorCsp);
    expect(op.ok).toBe(true); // success, NOT "anchor not found"
    expect(op.changed).toBe(false); // host CSP already permits the loopback
    expect(op.reason).toMatch(/loopback already allowed/);
    expect(op.out).toBe(cursorCsp); // untouched
    // restore is also a clean no-op — we never injected our directive.
    expect(restoreCsp(cursorCsp).changed).toBe(false);
    expect(restoreCsp(cursorCsp).out).toBe(cursorCsp);
  });
});

// The verb-pinned runtime detects a CommonJS `module.exports` and, in that
// (test/headless) mode, exports its PURE helpers and returns before any DOM
// work — that's the pure-helpers export branch. Evaluating the materialized
// block with a synthetic `module`/`exports` therefore gives us the helpers in
// isolation, with no jsdom and no React tree. This asserts the renderer's pure
// behavior (the real new contract), not just that markers/placeholders exist.
describe('claude-overlay block — pure renderer helpers (module.exports harness)', () => {
  function loadHelpers() {
    const block = materializeBlock(CLAUDE_OVERLAY_BLOCK, {
      __COADS_ADS__: JSON.stringify([]),
      __COADS_AD_TEXT__: JSON.stringify('Linear — fast issue tracking'),
      __COADS_CLICK_URL__: JSON.stringify('https://linear.app'),
      __COADS_ICON_URL__: JSON.stringify(''),
      __COADS_LB_BASE__: JSON.stringify('http://127.0.0.1:5555'),
      __COADS_LB_TOKEN__: JSON.stringify('tok123'),
      __COADS_CORR__: JSON.stringify('ad_1.r'),
      __COADS_AD_ID__: JSON.stringify('ad_1'),
      __COADS_SURFACE__: JSON.stringify('claude-overlay'),
      __COADS_VIEW_THRESHOLD_MS__: '3000',
      __COADS_DEBUG__: 'false',
    });
    // The block string itself contains the START/END comment markers, which is
    // fine inside a Function body. Provide module/exports; window/document/etc.
    // are never touched on the exports path.
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function('module', 'exports', block);
    run(mod, mod.exports);
    return mod.exports as {
      fmtElapsed: (ms: number) => string;
      ellipsis: (frame: number) => string;
      esc: (s: string) => string;
      buildAdHtml: (s: {
        ad: string;
        href?: string;
        iconUrl?: string;
        elapsed?: string;
        dots?: string;
      }) => string;
    };
  }

  it('exports the four pure helpers', () => {
    const h = loadHelpers();
    expect(typeof h.fmtElapsed).toBe('function');
    expect(typeof h.ellipsis).toBe('function');
    expect(typeof h.esc).toBe('function');
    expect(typeof h.buildAdHtml).toBe('function');
  });

  it('fmtElapsed renders one-decimal seconds', () => {
    const { fmtElapsed } = loadHelpers();
    expect(fmtElapsed(0)).toBe('0.0s');
    expect(fmtElapsed(1234)).toBe('1.2s');
    expect(fmtElapsed(15000)).toBe('15.0s');
  });

  it('ellipsis animates 0..5 dots over a 6-frame cycle', () => {
    const { ellipsis } = loadHelpers();
    expect(ellipsis(0)).toBe('');
    expect(ellipsis(1)).toBe('.');
    expect(ellipsis(5)).toBe('.....');
    expect(ellipsis(6)).toBe(''); // wraps
  });

  it('esc escapes the HTML-significant chars (XSS-safe innerHTML write)', () => {
    const { esc } = loadHelpers();
    expect(esc('a<b>&"c')).toBe('a&lt;b&gt;&amp;&quot;c');
  });

  it('buildAdHtml renders a clickable verb-pinned line with dots + elapsed', () => {
    const { buildAdHtml } = loadHelpers();
    const html = buildAdHtml({
      ad: 'Linear — fast',
      href: 'https://linear.app',
      iconUrl: '',
      elapsed: '1.2s',
      dots: '..',
    });
    // real navigable href (no preventDefault — host opens it externally)
    expect(html).toContain('href="https://linear.app"');
    expect(html).toContain('data-coads-ad="1"');
    // animated BRAND RING (12 orange #F26321 dots, self-animating via coadsfade)
    // replaces the old text dots; still tagged data-coads-dots for the ref hook.
    expect(html).toContain('data-coads-dots="1"');
    expect(html).toContain('#F26321'); // brand-orange ring dots
    expect(html).toContain('coadsfade'); // CSS keyframe animation
    // tabular elapsed timer
    expect(html).toContain('data-coads-elapsed="1"');
    expect(html).toContain('1.2s');
    // no icon URL → inline brand-orange dot fallback (programmatic, CSP-safe)
    expect(html).toContain('<svg');
    expect(html).toContain('fill="#F26321"'); // brand-orange dot
    expect(html).not.toContain('>C</text>'); // no longer a lettered badge
  });

  it('buildAdHtml renders an over-cap quote (no href) as a plain, non-clickable 💭 line', () => {
    const { buildAdHtml } = loadHelpers();
    const html = buildAdHtml({
      ad: '💭 What you seek is seeking you. — Rumi',
      href: '', // a quote carries no clickUrl
      iconUrl: '',
      elapsed: '2.0s',
    });
    expect(html).toContain('💭 What you seek is seeking you. — Rumi');
    // NOT a billable/clickable ad: no anchor, no click-capture hook, no brand ring.
    expect(html).not.toContain('data-coads-ad="1"');
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('data-coads-dots="1"');
    // no elapsed timer + no favicon fallback on a quote line
    expect(html).not.toContain('data-coads-elapsed="1"');
    expect(html).not.toContain('<svg');
  });

  it('buildAdHtml emits an <img> (data-coads-icon) when an icon URL is given', () => {
    const { buildAdHtml } = loadHelpers();
    const html = buildAdHtml({
      ad: 'Vercel',
      href: 'https://vercel.com',
      iconUrl: 'data:image/png;base64,AAAA',
      elapsed: '0.5s',
      dots: '.',
    });
    expect(html).toContain('data-coads-icon="1"');
    expect(html).toContain('src="data:image/png;base64,AAAA"');
  });

  it('buildAdHtml escapes hostile ad text (no raw tag injection)', () => {
    const { buildAdHtml } = loadHelpers();
    const html = buildAdHtml({ ad: '<script>x</script>', href: '#', dots: '', elapsed: '' });
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
  });
});
