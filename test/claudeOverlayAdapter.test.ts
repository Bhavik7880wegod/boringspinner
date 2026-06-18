import { describe, it, expect, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeOverlayAdapter } from '../src/adapters/claude-code/adapter';
import type { PatchParams } from '../src/adapters/types';

// Fixtures: a fake webview bundle + a fake host bundle carrying the REAL CSP
// anchor. We NEVER touch the installed extension here.
const FAKE_BUNDLE = 'var btt=Object.create;/* 4.8MB minified react bundle */mount();';
const FAKE_HOST =
  'getHtml(){return `<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; ${p}; ${f}; ${m}; script-src \'nonce-${u}\'; ${g};">`}';

const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

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
    ...over,
  };
}

describe('ClaudeOverlayAdapter (§5.7 surfaces 1+2)', () => {
  let dir: string;
  let wv: string;
  let host: string;
  let adapter: ClaudeOverlayAdapter;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coads-overlay-'));
    wv = path.join(dir, 'webview', 'index.js');
    host = path.join(dir, 'extension.js');
    fs.mkdirSync(path.dirname(wv), { recursive: true });
    fs.writeFileSync(wv, FAKE_BUNDLE, 'utf8');
    fs.writeFileSync(host, FAKE_HOST, 'utf8');
    adapter = new ClaudeOverlayAdapter({ webviewJsPath: wv, hostJsPath: host, version: '2.1.175' });
  });

  it('preflight reports compatible when both files are writable', () => {
    const pf = adapter.preflight();
    expect(pf.compatible).toBe(true);
    expect(pf.version).toBe('2.1.175');
  });

  it('prime() relaxes CSP only (no ad block) and backs up the host byte-exactly', () => {
    const r = adapter.prime();
    expect(r.ok).toBe(true);
    const after = fs.readFileSync(host, 'utf8');
    expect(after).toContain('connect-src http://127.0.0.1:* https://*.boringspinner.com');
    expect(fs.readFileSync(wv, 'utf8')).toBe(FAKE_BUNDLE); // ad bundle untouched
    // a byte-exact backup of the original host exists
    const bak = fs.readdirSync(dir).find((f) => f.startsWith('extension.js.boringspinner.bak.'));
    expect(bak).toBeTruthy();
    expect(fs.readFileSync(path.join(dir, bak!), 'utf8')).toBe(FAKE_HOST);
  });

  it('applyPatch injects the ad + relaxes CSP; isPatched flips true', () => {
    const r = adapter.applyPatch(params());
    expect(r.ok).toBe(true);
    const bundle = fs.readFileSync(wv, 'utf8');
    expect(bundle).toContain('Sponsored: Linear');
    expect(bundle).toContain('https://linear.app');
    expect(bundle).toContain('/coads/');
    expect(adapter.isPatched()).toBe(true);
    expect(fs.readFileSync(host, 'utf8')).toContain('connect-src http://127.0.0.1:*');
  });

  it('full restore returns BOTH files to byte-exact pristine', () => {
    adapter.applyPatch(params());
    const r = adapter.restore();
    expect(r.ok).toBe(true);
    expect(sha(fs.readFileSync(wv, 'utf8'))).toBe(sha(FAKE_BUNDLE));
    expect(sha(fs.readFileSync(host, 'utf8'))).toBe(sha(FAKE_HOST));
    expect(adapter.isPatched()).toBe(false);
  });

  it('restore({keepCsp}) reverts the ad but leaves CSP relaxed', () => {
    adapter.applyPatch(params());
    const r = adapter.restore({ keepCsp: true });
    expect(r.ok).toBe(true);
    expect(sha(fs.readFileSync(wv, 'utf8'))).toBe(sha(FAKE_BUNDLE)); // ad gone
    expect(fs.readFileSync(host, 'utf8')).toContain('connect-src http://127.0.0.1:*'); // CSP stays
  });

  it('re-applying new creative does not corrupt restore (earliest backup wins)', () => {
    adapter.applyPatch(params({ adText: 'Sponsored: Vercel →', clickUrl: 'https://vercel.com' }));
    adapter.applyPatch(params({ adText: 'Sponsored: Linear →', clickUrl: 'https://linear.app' }));
    const bundle = fs.readFileSync(wv, 'utf8');
    expect(bundle).toContain('Sponsored: Linear');
    expect(bundle).not.toContain('Vercel'); // swapped, not stacked
    adapter.restore();
    expect(sha(fs.readFileSync(wv, 'utf8'))).toBe(sha(FAKE_BUNDLE));
  });

  it('applyPatch is idempotent for identical creative (no redundant write churn)', () => {
    adapter.applyPatch(params());
    const second = adapter.applyPatch(params());
    expect(second.ok).toBe(true);
    expect(second.reason).toMatch(/already applied/);
  });

  it('preflight incompatible when host bundle missing (CSP cannot be relaxed)', () => {
    const a2 = new ClaudeOverlayAdapter({ webviewJsPath: wv, hostJsPath: null });
    expect(a2.preflight().compatible).toBe(false);
    expect(a2.applyPatch(params()).ok).toBe(false);
  });

  it('diagnose reports patched + CSP state', () => {
    adapter.applyPatch(params());
    const d = adapter.diagnose();
    expect(d.name).toBe('claude-overlay');
    expect(d.isPatched).toBe(true);
    expect(d.backup.exists).toBe(true);
    expect(d.live.hasArray).toBe(true); // CSP relaxed
  });
});
