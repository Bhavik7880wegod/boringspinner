// src/adapters/claude-banner/injection.ts — pure string transforms for the
// `claude-banner` surface (§3 #2). NO fs, NO vscode: every function is a
// deterministic string→string so it is unit-testable and the adapter owns all
// I/O.
//
// The banner block is APPENDED to the installed Claude Code `webview/index.js`
// bundle (after the React app's IIFE has run), delimited by the banner-specific
// marker pair so it strips out byte-exactly and INDEPENDENTLY of the overlay
// surface. This module never touches the overlay's markers or files.
//
// All edits use split/join (NOT String.replace) so `$` / `{` bytes in the host
// bundle are never interpreted as replacement patterns.

import { BANNER_START, BANNER_END } from './block.asset';

// The stable container-class PREFIX of Claude Code's usage-limit banner. We
// require this string to be present in the host bundle before we agree the
// banner target is locatable — this is the §1.3 "never guess" gate. If a future
// Claude Code build renames the class, the marker is absent → the adapter
// reports "incompatible" and does nothing.
export const BANNER_ANCHOR = 'usageLimitBanner_';

// Is the bundle compatible with the banner surface? True only when the banner
// container class prefix is actually present in the shipped bundle.
export function hasBannerAnchor(js: string): boolean {
  return js.indexOf(BANNER_ANCHOR) !== -1;
}

export function hasBannerBlock(js: string): boolean {
  return js.indexOf(BANNER_START) !== -1;
}

// Substitute each `__COADS_KEY__` placeholder with the caller-provided JS
// literal (strings via JSON.stringify, numbers/bools as bare literals).
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

// Remove a previously-appended banner block byte-exactly (markers + the single
// newline we add on append). Idempotent: returns the input unchanged if absent.
export function stripBannerBlock(js: string): string {
  const s = js.indexOf(BANNER_START);
  if (s === -1) return js;
  const e = js.indexOf(BANNER_END, s);
  if (e === -1) return js;
  const end = e + BANNER_END.length;
  let start = s;
  if (start > 0 && js[start - 1] === '\n') start -= 1; // consume the appended NL
  return js.slice(0, start) + js.slice(end);
}

// Append the materialized banner block. Strips any prior banner block first so
// re-applying new creative is a clean swap (idempotent in shape).
export function applyBannerBlock(js: string, materializedBlock: string): string {
  return stripBannerBlock(js) + '\n' + materializedBlock;
}
