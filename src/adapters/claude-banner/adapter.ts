// src/adapters/claude-banner/adapter.ts — surface 2 (`claude-banner`).
//
// Injects ONE sponsored line into Claude Code's usage-limit banner (§3 #2,
// "secondary slot in the usage-limit banner"; gated by the server flag
// `banner_enabled`). Lower CTR than the overlay, but doubles inventory.
//
// Contract: §5.7 TargetAdapter. Every method returns a typed result; NEVER
// throws. The banner block is APPENDED to the installed Claude Code
// `webview/index.js` bundle, delimited by banner-specific markers so it is
// independent of (and never touches) the `claude-overlay` surface and its files.
//
// HARD RULES honored (§1.3):
//   • Never read user content — only geometry + a stable container class.
//   • Byte-exact reversibility — sha256-verified `.boringspinner.bak.<ts>` backup
//     BEFORE the first patch (legacy `.coads.bak.<ts>` still recognized on
//     restore); restore rolls back to the EARLIEST backup (true origin).
//   • Never break the user's tool — if the banner anchor cannot be located in
//     the bundle, report "incompatible" and DO NOTHING. Never guess.
//   • Fail-closed — applyPatch requires the caller to have gated on canPatch()
//     /killswitch; the banner additionally serves ONLY when bannerOn is set
//     (the server's `banner_enabled` flag). No write otherwise.
//   • Idempotent — re-applying identical creative is a no-op; restore twice is a
//     byte-exact no-op.
//   • No try/catch that could silently corrupt the host — every write is
//     preceded by a verified backup and bounded by a typed result.
//
// SAFETY: the adapter is constructed with an explicit webview-bundle path. Tests
// pass a fixture copy; the real installed bundle is only used by the live
// extension (via locateClaudeCode()).

import * as crypto from 'crypto';
import * as fs from 'fs';

import type {
  AdapterDiagnostics,
  OpResult,
  PatchParams,
  PreflightResult,
  RestoreResult,
  TargetAdapter,
} from '../types';
import { dlog } from '../../log';
import { CLAUDE_BANNER_BLOCK } from './block.asset';
import {
  applyBannerBlock,
  hasBannerAnchor,
  hasBannerBlock,
  materializeBlock,
  stripBannerBlock,
} from './injection';
import { findEarliestBackupFor, newBackupPath } from '../../util/backup';

export const BANNER_SURFACE = 'claude-banner';

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export class ClaudeBannerAdapter implements TargetAdapter {
  readonly name = BANNER_SURFACE;
  private readonly webviewJsPath: string;
  private readonly hostVersion: string | null;

  // webviewJsPath is the located Claude Code `webview/index.js`. Tests inject a
  // fixture copy; the live extension injects the located bundle.
  constructor(opts: { webviewJsPath: string; version?: string | null }) {
    this.webviewJsPath = opts.webviewJsPath;
    this.hostVersion = opts.version ?? null;
  }

  version(): string | null {
    return this.hostVersion;
  }

  // --- preflight ---------------------------------------------------------
  // Compatible iff the bundle is writable AND actually contains the usage-limit
  // banner container class (the §1.3 "never guess" gate). A bundle that lacks
  // the banner anchor → incompatible, and the adapter does nothing.
  preflight(): PreflightResult {
    if (!this.fileWritable(this.webviewJsPath)) {
      return {
        ok: true,
        compatible: false,
        version: this.hostVersion,
        reason: `webview bundle not writable: ${this.webviewJsPath}`,
      };
    }
    let anchorOk = false;
    try {
      anchorOk = hasBannerAnchor(fs.readFileSync(this.webviewJsPath, 'utf8'));
    } catch {
      anchorOk = false;
    }
    if (!anchorOk) {
      return {
        ok: true,
        compatible: false,
        version: this.hostVersion,
        reason: 'usage-limit banner target not found in bundle (incompatible)',
      };
    }
    return { ok: true, compatible: true, version: this.hostVersion };
  }

  // --- prime -------------------------------------------------------------
  // The banner shares the overlay's host bundle; the only structural prereq
  // (CSP connect-src relaxation) is owned by the `claude-overlay` adapter and
  // MUST NOT be duplicated here (that would touch the overlay's concern + files).
  // So prime() is an explicit no-op for the banner surface.
  prime(): OpResult {
    return {
      ok: true,
      reason: 'banner has no own structural prerequisite (CSP owned by claude-overlay)',
    };
  }

  // --- applyPatch --------------------------------------------------------
  // Gate on bannerOn (server `banner_enabled`) → confirm compatibility →
  // byte-exact backup (once) → append the materialized banner block. Idempotent.
  applyPatch(p: PatchParams): OpResult {
    try {
      // The banner is OPTIONAL and server-gated (§3). Never write unless the
      // caller passes the `banner_enabled` flag through PatchParams.bannerOn.
      if (!p?.bannerOn) {
        return { ok: true, reason: 'banner_enabled flag off — no-op' };
      }

      const pf = this.preflight();
      if (!pf.compatible) {
        // Fail-closed: incompatible target → do nothing, report why.
        return { ok: false, reason: pf.reason ?? 'incompatible target' };
      }

      const current = fs.readFileSync(this.webviewJsPath, 'utf8');

      // Byte-exact backup of the PRISTINE bundle (with any prior banner block
      // stripped) before the first mutating write.
      const backed = this.ensureBackup(stripBannerBlock(current));
      if (!backed.ok) return backed;

      const block = materializeBlock(CLAUDE_BANNER_BLOCK, this.replacements(p));
      const next = applyBannerBlock(current, block);
      if (sha256(next) === sha256(current)) {
        return { ok: true, reason: 'already applied (no-op)' };
      }
      fs.writeFileSync(this.webviewJsPath, next, 'utf8');
      dlog(`[claude-banner] banner block applied to ${this.webviewJsPath}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `applyPatch failed: ${String(e)}` };
    }
  }

  // --- restore -----------------------------------------------------------
  // Roll the bundle back to its EARLIEST backup (byte-exact, sha256-verified).
  // Idempotent: byte-equal → no-op; no backup → strip our markers best-effort.
  restore(_opts?: { keepCsp?: boolean }): RestoreResult {
    try {
      const backupPath = this.findEarliestBackup();
      const current = this.fileExists(this.webviewJsPath)
        ? fs.readFileSync(this.webviewJsPath, 'utf8')
        : null;

      if (!backupPath) {
        if (current === null) {
          return { ok: true, restored: false, reason: 'target missing' };
        }
        const stripped = stripBannerBlock(current);
        if (stripped === current) {
          return { ok: true, restored: false, reason: 'no backup; nothing to strip' };
        }
        fs.writeFileSync(this.webviewJsPath, stripped, 'utf8');
        return { ok: true, restored: true, reason: 'stripped (no backup)' };
      }

      const backup = fs.readFileSync(backupPath, 'utf8');
      if (current !== null && sha256(current) === sha256(backup)) {
        return { ok: true, restored: false, reason: 'already byte-exact' };
      }
      fs.writeFileSync(this.webviewJsPath, backup, 'utf8');
      const after = fs.readFileSync(this.webviewJsPath, 'utf8');
      if (sha256(after) !== sha256(backup)) {
        return { ok: false, restored: false, reason: 'checksum mismatch after restore' };
      }
      dlog(`[claude-banner] restored ${this.webviewJsPath} (checksum OK)`);
      return { ok: true, restored: true };
    } catch (e) {
      return { ok: false, restored: false, reason: `restore failed: ${String(e)}` };
    }
  }

  // --- isPatched ---------------------------------------------------------
  isPatched(): boolean {
    try {
      return hasBannerBlock(fs.readFileSync(this.webviewJsPath, 'utf8'));
    } catch {
      return false;
    }
  }

  // --- diagnose ----------------------------------------------------------
  diagnose(): AdapterDiagnostics {
    const pf = this.preflight();
    const exists = this.fileExists(this.webviewJsPath);
    const backupPath = this.findEarliestBackup();
    let liveHasBlock = false;
    let liveHasAnchor = false;
    try {
      const text = fs.readFileSync(this.webviewJsPath, 'utf8');
      liveHasBlock = hasBannerBlock(text);
      liveHasAnchor = hasBannerAnchor(text);
    } catch {
      /* leave false */
    }
    let backupHasBlock = false;
    if (backupPath) {
      try {
        backupHasBlock = hasBannerBlock(fs.readFileSync(backupPath, 'utf8'));
      } catch {
        /* ignore */
      }
    }
    return {
      name: this.name,
      target: this.webviewJsPath,
      targetExists: exists,
      version: pf.version,
      compatible: pf.compatible,
      reason: pf.reason,
      isPatched: liveHasBlock,
      backup: {
        exists: backupPath !== null,
        path: backupPath,
        hasArray: false, // no JSON array on this surface
        hasBlock: backupHasBlock,
      },
      live: {
        hasArray: liveHasAnchor, // reuse: "banner anchor present in bundle"
        bareVerbPresent: liveHasBlock,
      },
    };
  }

  // --- internals ---------------------------------------------------------

  private replacements(p: PatchParams): Record<string, string> {
    const adId = (p.corr || '').split('.')[0] || p.clickToken || 'ad';
    return {
      __COADS_AD_TEXT__: JSON.stringify(p.adText ?? ''),
      __COADS_CLICK_URL__: JSON.stringify(p.clickUrl ?? ''),
      __COADS_ICON_URL__: JSON.stringify(p.iconUrl ?? ''),
      __COADS_LB_BASE__: JSON.stringify(p.loopbackBase ?? ''),
      __COADS_LB_TOKEN__: JSON.stringify(p.loopbackToken ?? ''),
      __COADS_CORR__: JSON.stringify(p.corr ?? ''),
      __COADS_AD_ID__: JSON.stringify(adId),
      __COADS_SURFACE__: JSON.stringify(BANNER_SURFACE),
      __COADS_VIEW_THRESHOLD_MS__: String(Number(p.viewThresholdMs ?? 0)),
      __COADS_DEBUG__: p.debug ? 'true' : 'false',
    };
  }

  private fileExists(p: string): boolean {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }

  private fileWritable(p: string): boolean {
    try {
      if (!fs.existsSync(p)) return false;
      fs.accessSync(p, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  // Write a byte-exact backup of `pristine`, once. Subsequent applies reuse the
  // earliest backup so restore always returns to the true pre-install state.
  private ensureBackup(pristine: string): OpResult {
    try {
      if (this.findEarliestBackup()) return { ok: true };
      const stamp = Date.now();
      const backupPath = newBackupPath(this.backupBase(), stamp);
      fs.writeFileSync(backupPath, pristine, 'utf8');
      const wrote = fs.readFileSync(backupPath, 'utf8');
      if (sha256(wrote) !== sha256(pristine)) {
        return { ok: false, reason: 'backup checksum mismatch' };
      }
      dlog(`[claude-banner] backup written ${backupPath}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `backup failed: ${String(e)}` };
    }
  }

  // The banner adapter owns its OWN backup namespace by suffixing the backup
  // base with `.banner` so it never collides with the overlay's backups of the
  // SAME `webview/index.js` file.
  private backupBase(): string {
    return `${this.webviewJsPath}.banner`;
  }

  // Earliest backup under the `.banner`-namespaced base; scans new + legacy suffixes.
  // A bare `<file>.coads.bak.` (an overlay backup of the SAME file) is NOT matched
  // because it lacks the `.banner` infix.
  private findEarliestBackup(): string | null {
    return findEarliestBackupFor(this.backupBase());
  }
}
