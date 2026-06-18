import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ClaudeBannerAdapter } from '../src/adapters/claude-banner/adapter';
import {
  applyBannerBlock,
  hasBannerAnchor,
  hasBannerBlock,
  materializeBlock,
  stripBannerBlock,
  BANNER_ANCHOR,
} from '../src/adapters/claude-banner/injection';
import {
  CLAUDE_BANNER_BLOCK,
  BANNER_START,
  BANNER_END,
  BANNER_PLACEHOLDERS,
} from '../src/adapters/claude-banner/block.asset';
import { canPatch } from '../src/servingGate';
import type { PatchParams } from '../src/adapters/types';

const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// A faithful slice of a real Claude Code bundle that DOES carry the usage-limit
// banner container class (the anchor). The real installed bundle is NEVER touched.
const FAKE_BUNDLE_WITH_BANNER =
  'var x=Object.create;/* minified */function B(){return jsx("div",{className:"usageLimitBanner_07S1Yg flex"})}mount();';
// A bundle WITHOUT the banner class — the adapter must report "incompatible".
const FAKE_BUNDLE_NO_BANNER = 'var x=Object.create;/* minified */mount();';

function params(over: Partial<PatchParams> = {}): PatchParams {
  return {
    tier: 0,
    adText: 'Sponsored: Linear — fast issue tracking →',
    iconRef: '',
    iconUrl: '',
    clickToken: 'ct',
    clickUrl: 'https://linear.app',
    corr: 'ad_abc.r1',
    loopbackPort: 5555,
    loopbackToken: 'lbtok',
    loopbackBase: 'http://127.0.0.1:5555',
    viewThresholdMs: 3000,
    debug: false,
    bannerOn: true, // server `banner_enabled` flag ON (default for these tests)
    ...over,
  };
}

let dir: string;
let wv: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coads-banner-'));
  wv = path.join(dir, 'webview', 'index.js');
  fs.mkdirSync(path.dirname(wv), { recursive: true });
  fs.writeFileSync(wv, FAKE_BUNDLE_WITH_BANNER, 'utf8');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ClaudeBannerAdapter — identity (§0 / §3 surface 2)', () => {
  it('name matches the §3 surface id verbatim', () => {
    const a = new ClaudeBannerAdapter({ webviewJsPath: wv });
    expect(a.name).toBe('claude-banner');
  });
});

describe('location / preflight (§1.3 never-guess)', () => {
  it('compatible when the bundle is writable AND carries the banner anchor', () => {
    const a = new ClaudeBannerAdapter({ webviewJsPath: wv, version: '2.1.175' });
    const pf = a.preflight();
    expect(pf.compatible).toBe(true);
    expect(pf.version).toBe('2.1.175');
  });

  it('INCOMPATIBLE (does nothing) when the banner target is absent — never guess', () => {
    fs.writeFileSync(wv, FAKE_BUNDLE_NO_BANNER, 'utf8');
    const a = new ClaudeBannerAdapter({ webviewJsPath: wv });
    const pf = a.preflight();
    expect(pf.compatible).toBe(false);
    expect(pf.reason).toMatch(/banner target not found|incompatible/i);
    // applyPatch must refuse and write NOTHING (no backup, bundle unchanged).
    const before = fs.readFileSync(wv, 'utf8');
    const r = a.applyPatch(params());
    expect(r.ok).toBe(false);
    expect(fs.readFileSync(wv, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(wv)).some((f) => f.includes('.boringspinner.bak.'))).toBe(false);
  });

  it('incompatible when the bundle path does not exist', () => {
    const a = new ClaudeBannerAdapter({ webviewJsPath: path.join(dir, 'nope', 'index.js') });
    expect(a.preflight().compatible).toBe(false);
  });
});

describe('applyPatch → restore is byte-exact (checksum-verified)', () => {
  it('injects the sponsored line + click beacon, then restores byte-exact', () => {
    const original = fs.readFileSync(wv, 'utf8');
    const a = new ClaudeBannerAdapter({ webviewJsPath: wv });

    const applied = a.applyPatch(params());
    expect(applied.ok).toBe(true);

    const patched = fs.readFileSync(wv, 'utf8');
    expect(patched).not.toBe(original);
    expect(a.isPatched()).toBe(true);
    expect(patched).toContain('Sponsored: Linear');
    expect(patched).toContain('https://linear.app');
    expect(patched).toContain('/coads/'); // loopback beacon plumbing

    // Exactly one backup, namespaced to the banner (does not collide w/ overlay).
    const backups = fs.readdirSync(path.dirname(wv)).filter((f) => f.includes('.boringspinner.bak.'));
    expect(backups.length).toBe(1);
    expect(backups[0]).toContain('.banner.boringspinner.bak.');

    const restored = a.restore();
    expect(restored.ok).toBe(true);
    expect(restored.restored).toBe(true);
    expect(sha(fs.readFileSync(wv, 'utf8'))).toBe(sha(original)); // BYTE-EXACT
    expect(fs.readFileSync(wv, 'utf8')).toBe(original);
    expect(a.isPatched()).toBe(false);
  });
});

describe('idempotency', () => {
  it('second apply with identical creative is a no-op (one backup, same bytes)', () => {
    const a = new ClaudeBannerAdapter({ webviewJsPath: wv });
    expect(a.applyPatch(params()).ok).toBe(true);
    const afterFirst = fs.readFileSync(wv, 'utf8');

    const second = a.applyPatch(params());
    expect(second.ok).toBe(true);
    expect(second.reason).toMatch(/no-op|already/i);
    expect(fs.readFileSync(wv, 'utf8')).toBe(afterFirst);

    const backups = fs.readdirSync(path.dirname(wv)).filter((f) => f.includes('.boringspinner.bak.'));
    expect(backups.length).toBe(1);
  });

  it('re-applying NEW creative swaps cleanly; restore returns earliest pristine', () => {
    const original = fs.readFileSync(wv, 'utf8');
    const a = new ClaudeBannerAdapter({ webviewJsPath: wv });
    a.applyPatch(params({ adText: 'Sponsored: Vercel →', clickUrl: 'https://vercel.com' }));
    a.applyPatch(params({ adText: 'Sponsored: Linear →', clickUrl: 'https://linear.app' }));
    const patched = fs.readFileSync(wv, 'utf8');
    expect(patched).toContain('Sponsored: Linear');
    expect(patched).not.toContain('Vercel'); // swapped, not stacked
    expect(patched.split(BANNER_START).length - 1).toBe(1); // exactly one block

    a.restore();
    expect(sha(fs.readFileSync(wv, 'utf8'))).toBe(sha(original));
  });

  it('restore with no prior patch is a safe no-op success', () => {
    const a = new ClaudeBannerAdapter({ webviewJsPath: wv });
    const r = a.restore();
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(false);
  });

  it('restore twice is idempotent (second is byte-exact no-op)', () => {
    const a = new ClaudeBannerAdapter({ webviewJsPath: wv });
    a.applyPatch(params());
    expect(a.restore().restored).toBe(true);
    const second = a.restore();
    expect(second.ok).toBe(true);
    expect(second.restored).toBe(false);
  });
});

describe('banner_enabled gate (§3 — server flag)', () => {
  it('does NOT write when bannerOn is off — and creates no backup', () => {
    const a = new ClaudeBannerAdapter({ webviewJsPath: wv });
    const before = fs.readFileSync(wv, 'utf8');
    const r = a.applyPatch(params({ bannerOn: false }));
    expect(r.ok).toBe(true);
    expect(r.reason).toMatch(/banner_enabled flag off/i);
    expect(fs.readFileSync(wv, 'utf8')).toBe(before); // untouched
    expect(a.isPatched()).toBe(false);
    expect(fs.readdirSync(path.dirname(wv)).some((f) => f.includes('.boringspinner.bak.'))).toBe(false);
  });
});

describe('killswitch / canPatch gate (§6.5)', () => {
  // The adapter is gated by the caller via canPatch(); confirm the banner is
  // never applied unless the gate is open, and that a confirmed/offline posture
  // keeps the bundle pristine.
  function maybeApply(posture: 'clear' | 'confirmed' | 'offline', enabled = true) {
    const a = new ClaudeBannerAdapter({ webviewJsPath: wv });
    const compatible = a.preflight().compatible;
    const before = fs.readFileSync(wv, 'utf8');
    if (canPatch({ enabled, killPosture: posture, compatible })) {
      a.applyPatch(params());
    }
    return { a, before, after: fs.readFileSync(wv, 'utf8') };
  }

  it('clear posture → patch is allowed and applied', () => {
    const { a, before, after } = maybeApply('clear');
    expect(after).not.toBe(before);
    expect(a.isPatched()).toBe(true);
  });

  it('confirmed kill → gate closed → bundle stays pristine (no write)', () => {
    const { a, before, after } = maybeApply('confirmed');
    expect(after).toBe(before);
    expect(a.isPatched()).toBe(false);
  });

  it('offline → fail-closed → bundle stays pristine (no write)', () => {
    const { a, before, after } = maybeApply('offline');
    expect(after).toBe(before);
    expect(a.isPatched()).toBe(false);
  });

  it('disabled by user → gate closed → no write', () => {
    const { a, before, after } = maybeApply('clear', false);
    expect(after).toBe(before);
    expect(a.isPatched()).toBe(false);
  });
});

describe('never throws — returns typed results', () => {
  it('applyPatch on an unwritable path returns ok:false, not a throw', () => {
    const bogusParent = path.join(dir, 'afile');
    fs.writeFileSync(bogusParent, 'x');
    const a = new ClaudeBannerAdapter({ webviewJsPath: path.join(bogusParent, 'index.js') });
    const r = a.applyPatch(params());
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe('string');
  });
});

describe('diagnose() shape (§5.7)', () => {
  it('reports the correct shape with isPatched reflecting state', () => {
    const a = new ClaudeBannerAdapter({ webviewJsPath: wv });

    const before = a.diagnose();
    expect(before.name).toBe('claude-banner');
    expect(before.target).toBe(wv);
    expect(before.targetExists).toBe(true);
    expect(before.compatible).toBe(true);
    expect(before.isPatched).toBe(false);
    expect(before.backup.exists).toBe(false);
    expect(before).toHaveProperty('version');
    expect(before.backup).toHaveProperty('path');
    expect(before.live).toHaveProperty('bareVerbPresent');
    expect(before.live.hasArray).toBe(true); // banner anchor present in bundle

    a.applyPatch(params());
    const after = a.diagnose();
    expect(after.isPatched).toBe(true);
    expect(after.backup.exists).toBe(true);
    expect(after.live.bareVerbPresent).toBe(true);
  });
});

describe('independence from the claude-overlay surface', () => {
  it('banner backup is namespaced so it never collides with an overlay backup', () => {
    const a = new ClaudeBannerAdapter({ webviewJsPath: wv });
    a.applyPatch(params());
    // Simulate a LEGACY overlay backup of the SAME file written by the (separate)
    // overlay adapter — bare `index.js.coads.bak.` prefix (no `.banner` namespace).
    fs.writeFileSync(`${wv}.coads.bak.1`, FAKE_BUNDLE_WITH_BANNER, 'utf8');
    // The banner restore must still pick its OWN `.banner.boringspinner.bak.` backup
    // (and never the un-namespaced legacy overlay backup above).
    const r = a.restore();
    expect(r.ok).toBe(true);
    expect(sha(fs.readFileSync(wv, 'utf8'))).toBe(sha(FAKE_BUNDLE_WITH_BANNER));
  });
});

describe('injection helpers (pure string transforms)', () => {
  const block = materializeBlock(CLAUDE_BANNER_BLOCK, {
    __COADS_AD_TEXT__: JSON.stringify('Sponsored: Linear →'),
    __COADS_CLICK_URL__: JSON.stringify('https://linear.app'),
    __COADS_ICON_URL__: JSON.stringify(''),
    __COADS_LB_BASE__: JSON.stringify('http://127.0.0.1:5555'),
    __COADS_LB_TOKEN__: JSON.stringify('tok123'),
    __COADS_CORR__: JSON.stringify('ad_1.r'),
    __COADS_AD_ID__: JSON.stringify('ad_1'),
    __COADS_SURFACE__: JSON.stringify('claude-banner'),
    __COADS_VIEW_THRESHOLD_MS__: '3000',
    __COADS_DEBUG__: 'false',
  });

  it('materializes every placeholder (none left behind)', () => {
    for (const ph of BANNER_PLACEHOLDERS) expect(block).not.toContain(ph);
    expect(block).toContain('Sponsored: Linear');
    expect(block.startsWith(BANNER_START)).toBe(true);
    expect(block.endsWith(BANNER_END)).toBe(true);
  });

  it('append → strip is byte-exact (reversible)', () => {
    const original = 'var x=1;/* bundle */ usageLimitBanner_abc; mount();';
    const patched = applyBannerBlock(original, block);
    expect(hasBannerBlock(patched)).toBe(true);
    expect(stripBannerBlock(patched)).toBe(original);
  });

  it('re-apply swaps creative without stacking blocks', () => {
    const original = 'BUNDLE();';
    const once = applyBannerBlock(original, block);
    const twice = applyBannerBlock(once, block);
    expect(twice.split(BANNER_START).length - 1).toBe(1);
    expect(stripBannerBlock(twice)).toBe(original);
  });

  it('the banner anchor is the stable usage-limit container class prefix', () => {
    expect(BANNER_ANCHOR).toBe('usageLimitBanner_');
    expect(hasBannerAnchor('x usageLimitBanner_07S1Yg y')).toBe(true);
    expect(hasBannerAnchor('no banner here')).toBe(false);
  });
});

describe('block.asset pure renderer helpers (module.exports harness)', () => {
  function loadHelpers() {
    const block = materializeBlock(CLAUDE_BANNER_BLOCK, {
      __COADS_AD_TEXT__: JSON.stringify('Linear'),
      __COADS_CLICK_URL__: JSON.stringify('https://linear.app'),
      __COADS_ICON_URL__: JSON.stringify(''),
      __COADS_LB_BASE__: JSON.stringify('http://127.0.0.1:5555'),
      __COADS_LB_TOKEN__: JSON.stringify('tok123'),
      __COADS_CORR__: JSON.stringify('ad_1.r'),
      __COADS_AD_ID__: JSON.stringify('ad_1'),
      __COADS_SURFACE__: JSON.stringify('claude-banner'),
      __COADS_VIEW_THRESHOLD_MS__: '3000',
      __COADS_DEBUG__: 'false',
    });
    const mod: { exports: Record<string, unknown> } = { exports: {} };
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function('module', 'exports', block);
    run(mod, mod.exports);
    return mod.exports as {
      esc: (s: string) => string;
      buildBannerHtml: (s: { ad: string; href?: string; iconUrl?: string }) => string;
    };
  }

  it('exports the pure helpers and never touches the DOM in CJS mode', () => {
    const h = loadHelpers();
    expect(typeof h.esc).toBe('function');
    expect(typeof h.buildBannerHtml).toBe('function');
  });

  it('esc escapes HTML-significant chars (XSS-safe innerHTML write)', () => {
    const { esc } = loadHelpers();
    expect(esc('a<b>&"c')).toBe('a&lt;b&gt;&amp;&quot;c');
  });

  it('buildBannerHtml renders a clickable sponsored line with a real href', () => {
    const { buildBannerHtml } = loadHelpers();
    const html = buildBannerHtml({ ad: 'Linear', href: 'https://linear.app', iconUrl: '' });
    expect(html).toContain('href="https://linear.app"');
    expect(html).toContain('data-coads-bad="1"');
    expect(html).toContain('<svg'); // inline brand-orange dot fallback when no icon
    expect(html).toContain('fill="#F26321"');
    expect(html).not.toContain('>C</text>'); // no longer a lettered badge
  });

  it('buildBannerHtml escapes hostile ad text (no raw tag injection)', () => {
    const { buildBannerHtml } = loadHelpers();
    const html = buildBannerHtml({ ad: '<script>x</script>', href: '#' });
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;script&gt;');
  });
});
