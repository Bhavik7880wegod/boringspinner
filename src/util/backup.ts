// src/util/backup.ts — byte-exact backup suffix policy shared by every target
// adapter (claude-cli spinner/statusline, claude-overlay, claude-banner).
//
// REBRAND SAFETY (§0): new backups are written with the `.boringspinner.bak.<ts>`
// suffix, BUT locate/restore MUST also recognize the legacy `.coads.bak.<ts>`
// suffix. The currently-live patched Claude Code install on real machines has
// `.coads.bak` backups and MUST still restore. When in doubt, scan both.
//
// The namespace `base` passed in already includes any per-surface infix (e.g.
// `index.js.banner` or `settings.json.statusline`) so a bare `<file>.coads.bak.`
// belonging to a DIFFERENT surface is never matched — preserving backup isolation.

import * as fs from 'fs';
import * as path from 'path';

// New backups are written with this suffix.
export const BACKUP_SUFFIX = '.boringspinner.bak';
// Legacy suffix from before the rebrand — still scanned on restore/locate.
export const LEGACY_BACKUP_SUFFIX = '.coads.bak';

// Build the full path for a freshly-written backup of `base` at timestamp `stamp`.
export function newBackupPath(base: string, stamp: number): string {
  return `${base}${BACKUP_SUFFIX}.${stamp}`;
}

// Locate the EARLIEST backup of `base` (the true pre-install state), scanning
// BOTH the new `.boringspinner.bak.` and legacy `.coads.bak.` prefixes. `base`
// is the file path including any surface namespace infix; the backup lives in
// the same directory. Returns null when no backup exists.
export function findEarliestBackupFor(base: string): string | null {
  try {
    const dir = path.dirname(base);
    const stem = path.basename(base);
    if (!fs.existsSync(dir)) return null;
    const newPrefix = `${stem}${BACKUP_SUFFIX}.`;
    const legacyPrefix = `${stem}${LEGACY_BACKUP_SUFFIX}.`;
    const matches = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(newPrefix) || f.startsWith(legacyPrefix))
      .sort(); // trailing timestamp sorts chronologically; earliest = pristine
    return matches.length ? path.join(dir, matches[0]) : null;
  } catch {
    return null;
  }
}
