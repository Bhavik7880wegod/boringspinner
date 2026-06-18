// src/adapters/claude-code/injection.ts — pure string transforms for the
// `claude-overlay` surface. NO fs, NO vscode: every function is a deterministic
// string→string so it is unit-testable and the adapter owns all I/O.
//
// Two host files are touched:
//   1. webview/index.js  — the ad block is APPENDED (materialized from
//      block.asset.ts). Marker-delimited so it strips out byte-exactly.
//   2. extension.js      — the CSP `connect-src` is relaxed so the in-webview
//      beacon can reach the loopback (§5.9). The host builds the panel CSP as
//      `…default-src 'none'; ${p}; …` (verified in 2.1.175); we insert a
//      connect-src directive right after `default-src 'none';`.
//
// All edits use split/join (NOT String.replace) so the `$` / `{` bytes in the
// `${p}` template literal are never interpreted as replacement patterns.

import { OVERLAY_START, OVERLAY_END } from './block.asset';

// ---- ad block (webview/index.js) -----------------------------------------

export function hasOverlayBlock(js: string): boolean {
  return js.indexOf(OVERLAY_START) !== -1;
}

// Substitute each `__COADS_KEY__` placeholder with the caller-provided JS
// literal. The caller (adapter) is responsible for encoding values (strings via
// JSON.stringify, numbers/bools as bare literals).
export function materializeBlock(
  template: string,
  replacements: Record<string, string>,
): string {
  let out = template;
  for (const [key, literal] of Object.entries(replacements)) {
    out = out.split(key).join(literal);
  }
  return out;
}

// Remove a previously-appended block byte-exactly (markers + the single newline
// we add on append). Idempotent: returns the input unchanged if absent.
export function stripOverlayBlock(js: string): string {
  const s = js.indexOf(OVERLAY_START);
  if (s === -1) return js;
  const e = js.indexOf(OVERLAY_END, s);
  if (e === -1) return js;
  const end = e + OVERLAY_END.length;
  let start = s;
  if (start > 0 && js[start - 1] === '\n') start -= 1; // consume the appended NL
  return js.slice(0, start) + js.slice(end);
}

// Append the materialized block. Strips any prior block first so re-applying new
// creative is a clean swap (idempotent in shape).
export function applyOverlayBlock(js: string, materializedBlock: string): string {
  return stripOverlayBlock(js) + '\n' + materializedBlock;
}

// ---- CSP relaxation (extension.js) ---------------------------------------

// The MAIN panel CSP (loads webview/index.js) is `default-src 'none'; ${VAR}; …`
// where VAR is a MINIFIED directive variable that CHANGES across Claude Code
// builds — `${p}` on 2.1.175 (VS Code), `${D}` on 2.1.63 (Cursor), etc. We match
// it version-tolerantly so the overlay works across editors/versions, not just
// the build it was authored against. The secondary markdown webview uses
// `default-src 'none'; style-src 'unsafe-inline'` (no `${var}` immediately after
// default-src), so it is NOT matched — we only touch the panel that loads
// webview/index.js.
const CSP_PREFIX = "default-src 'none'; ";
const MAIN_CSP_RE = /default-src 'none'; (\$\{[\w$]+\};)/;

// Kept for tests / reference: the exact 2.1.175 anchor (one case the regex matches).
export const CSP_ANCHOR = "default-src 'none'; ${p};";

// §5.9: allow the loopback (any 127.0.0.1 port — robust to the random port we
// pick each boot) and our API. CSP host-source grammar permits `:*` for the port.
export const CSP_CONNECT = 'connect-src http://127.0.0.1:* https://*.boringspinner.com; ';

export function hasCspRelax(host: string): boolean {
  return host.indexOf(CSP_CONNECT) !== -1;
}

export interface StringOp {
  ok: boolean;
  out: string;
  changed: boolean;
  reason?: string;
}

export function relaxCsp(host: string): StringOp {
  if (host.indexOf(CSP_CONNECT) !== -1) {
    return { ok: true, out: host, changed: false, reason: 'already relaxed' };
  }
  // Some builds (e.g. Cursor's CC 2.1.63) ALREADY bake the loopback into their
  // panel CSP (`connect-src http://127.0.0.1:* …`). The in-webview beacon reaches
  // 127.0.0.1 fine, so no relax is needed — prime is a no-op success (do NOT
  // fail, which previously blocked the whole overlay from injecting).
  if (/connect-src[^;'"]*127\.0\.0\.1/.test(host)) {
    return { ok: true, out: host, changed: false, reason: 'loopback already allowed' };
  }
  const m = host.match(MAIN_CSP_RE);
  if (!m) {
    return { ok: false, out: host, changed: false, reason: 'CSP anchor not found' };
  }
  const anchor = m[0]; // e.g. "default-src 'none'; ${p};" or "...; ${D};"
  const relaxed = CSP_PREFIX + CSP_CONNECT + m[1];
  return { ok: true, out: host.split(anchor).join(relaxed), changed: true };
}

// Remove the connect-src we injected → restores the original CSP byte-exactly,
// whatever ${var} the build uses.
export function restoreCsp(host: string): StringOp {
  if (host.indexOf(CSP_CONNECT) === -1) {
    return { ok: true, out: host, changed: false, reason: 'no relaxation present' };
  }
  return { ok: true, out: host.split(CSP_PREFIX + CSP_CONNECT).join(CSP_PREFIX), changed: true };
}
