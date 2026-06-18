// src/adapters/claude-code/adapter.ts — surfaces 1 + 2 (`claude-overlay` +
// `claude-banner`) for the Claude Code VS Code webview.
//
// Contract: §5.7 TargetAdapter. Every method returns a typed result; NEVER
// throws. This adapter is unusual in that it touches TWO host files:
//
//   • webview/index.js  — the visible ad block (applyPatch / restore).
//   • extension.js      — CSP connect-src relaxation, the only invisible
//                         structural prerequisite (prime / restore).
//
// Both files get an independent, sha256-verified, byte-exact backup
// (`<file>.boringspinner.bak.<timestamp>`; legacy `.coads.bak.<timestamp>` is
// still recognized on restore), exactly like the proven claude-cli adapter.
// restore() rolls each file back to its EARLIEST backup (the true pre-install
// state). `prime()` applies CSP only (no ad) for the §5.7 "structural
// prerequisites without creative" case.

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
import { CLAUDE_OVERLAY_BLOCK } from './block.asset';
import {
  applyOverlayBlock,
  hasCspRelax,
  hasOverlayBlock,
  materializeBlock,
  relaxCsp,
  restoreCsp,
  stripOverlayBlock,
} from './injection';
import { findEarliestBackupFor, newBackupPath } from '../../util/backup';

export const OVERLAY_SURFACE = 'claude-overlay';
export const BANNER_SURFACE = 'claude-banner';

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export class ClaudeOverlayAdapter implements TargetAdapter {
  readonly name = OVERLAY_SURFACE;
  private readonly webviewJsPath: string;
  private readonly hostJsPath: string | null;
  private readonly hostVersion: string | null;

  // Paths are explicit so tests pass fixture copies; the real installed bundle
  // is only used by the live extension (via locateClaudeCode()).
  constructor(opts: {
    webviewJsPath: string;
    hostJsPath?: string | null;
    version?: string | null;
  }) {
    this.webviewJsPath = opts.webviewJsPath;
    this.hostJsPath = opts.hostJsPath ?? null;
    this.hostVersion = opts.version ?? null;
  }

  version(): string | null {
    return this.hostVersion;
  }

  // --- preflight ---------------------------------------------------------
  // Compatible iff both target files exist and are writable. (A missing
  // extension.js disables the click beacon but not the visible ad; we still
  // require it so prime() can relax CSP — the beacon is core to §6.4.)
  preflight(): PreflightResult {
    const wvOk = this.fileWritable(this.webviewJsPath);
    const hostOk = this.hostJsPath ? this.fileWritable(this.hostJsPath) : false;
    const compatible = wvOk && hostOk;
    let reason: string | undefined;
    if (!wvOk) reason = `webview bundle not writable: ${this.webviewJsPath}`;
    else if (!hostOk) reason = `host bundle (CSP) not writable: ${this.hostJsPath ?? '(not located)'}`;
    return { ok: true, compatible, version: this.hostVersion, reason };
  }

  // --- prime -------------------------------------------------------------
  // Relax the webview CSP connect-src so the in-page beacon can reach the
  // loopback (§5.9). Invisible; safe to run repeatedly; backs up extension.js
  // byte-exactly before the first edit.
  prime(): OpResult {
    if (!this.hostJsPath) {
      return { ok: false, reason: 'host bundle (extension.js) not located — cannot relax CSP' };
    }
    try {
      const current = fs.readFileSync(this.hostJsPath, 'utf8');
      if (hasCspRelax(current)) return { ok: true, reason: 'CSP already relaxed (no-op)' };
      const op = relaxCsp(current);
      if (!op.ok) return { ok: false, reason: op.reason };
      const backed = this.ensureBackup(this.hostJsPath, current);
      if (!backed.ok) return backed;
      fs.writeFileSync(this.hostJsPath, op.out, 'utf8');
      dlog(`[claude-overlay] CSP relaxed in ${this.hostJsPath}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `prime failed: ${String(e)}` };
    }
  }

  // --- applyPatch --------------------------------------------------------
  // prime CSP (if a host file is present) → backup index.js → append the
  // materialized ad block. Re-applying swaps creative cleanly (idempotent shape).
  applyPatch(p: PatchParams): OpResult {
    try {
      const pf = this.preflight();
      if (!pf.compatible) return { ok: false, reason: pf.reason ?? 'incompatible target' };

      // Structural prerequisite first; without CSP the click beacon is blocked.
      const primed = this.prime();
      if (!primed.ok) return { ok: false, reason: `prime: ${primed.reason}` };

      const current = fs.readFileSync(this.webviewJsPath, 'utf8');
      const backed = this.ensureBackup(this.webviewJsPath, stripOverlayBlock(current));
      if (!backed.ok) return backed;

      const block = materializeBlock(CLAUDE_OVERLAY_BLOCK, this.replacements(p));
      const next = applyOverlayBlock(current, block);
      if (sha256(next) === sha256(current)) {
        return { ok: true, reason: 'already applied (no-op)' };
      }
      fs.writeFileSync(this.webviewJsPath, next, 'utf8');
      dlog(`[claude-overlay] ad block applied to ${this.webviewJsPath}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `applyPatch failed: ${String(e)}` };
    }
  }

  // --- restore -----------------------------------------------------------
  // index.js → earliest backup (byte-exact). extension.js CSP → earliest backup
  // unless keepCsp (creative rotation keeps the invisible prereq in place).
  restore(opts?: { keepCsp?: boolean }): RestoreResult {
    try {
      let restoredAny = false;

      // 1. webview bundle (visible ad).
      const wv = this.restoreFile(this.webviewJsPath, (txt) => stripOverlayBlock(txt));
      if (!wv.ok) return wv;
      restoredAny = restoredAny || wv.restored;

      // 2. host bundle (CSP) — only on a full restore.
      if (!opts?.keepCsp && this.hostJsPath) {
        const host = this.restoreFile(this.hostJsPath, (txt) => restoreCsp(txt).out);
        if (!host.ok) return host;
        restoredAny = restoredAny || host.restored;
      }
      return { ok: true, restored: restoredAny };
    } catch (e) {
      return { ok: false, restored: false, reason: `restore failed: ${String(e)}` };
    }
  }

  // --- isPatched ---------------------------------------------------------
  isPatched(): boolean {
    try {
      return hasOverlayBlock(fs.readFileSync(this.webviewJsPath, 'utf8'));
    } catch {
      return false;
    }
  }

  // --- diagnose ----------------------------------------------------------
  diagnose(): AdapterDiagnostics {
    const pf = this.preflight();
    const exists = this.fileExists(this.webviewJsPath);
    const wvBackup = this.findEarliestBackup(this.webviewJsPath);
    let liveHasBlock = false;
    let liveHasCsp = false;
    try {
      liveHasBlock = hasOverlayBlock(fs.readFileSync(this.webviewJsPath, 'utf8'));
    } catch {
      /* leave false */
    }
    try {
      if (this.hostJsPath) liveHasCsp = hasCspRelax(fs.readFileSync(this.hostJsPath, 'utf8'));
    } catch {
      /* leave false */
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
        exists: wvBackup !== null,
        path: wvBackup,
        hasArray: liveHasCsp, // reuse: "structural prereq (CSP) present"
        hasBlock: liveHasBlock,
      },
      live: {
        hasArray: liveHasCsp,
        bareVerbPresent: liveHasBlock,
      },
    };
  }

  // --- internals ---------------------------------------------------------

  private replacements(p: PatchParams): Record<string, string> {
    const adId = (p.corr || '').split('.')[0] || p.clickToken || 'ad';
    const surface = p.bannerOn ? BANNER_SURFACE : OVERLAY_SURFACE;
    return {
      // The full rotation queue (JSON array literal in value position). Empty
      // array ⇒ the block falls back to the single baked creative below.
      __COADS_ADS__: JSON.stringify(
        (p.overlayAds ?? []).map((a) => ({
          adId: a.adId,
          adText: a.adText,
          clickUrl: a.clickUrl,
          iconUrl: a.iconUrl,
          corr: a.corr,
        })),
      ),
      __COADS_AD_TEXT__: JSON.stringify(p.adText ?? ''),
      __COADS_CLICK_URL__: JSON.stringify(p.clickUrl ?? ''),
      __COADS_ICON_URL__: JSON.stringify(p.iconUrl ?? ''),
      __COADS_LB_BASE__: JSON.stringify(p.loopbackBase ?? ''),
      __COADS_LB_TOKEN__: JSON.stringify(p.loopbackToken ?? ''),
      __COADS_CORR__: JSON.stringify(p.corr ?? ''),
      __COADS_AD_ID__: JSON.stringify(adId),
      __COADS_SURFACE__: JSON.stringify(surface),
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

  // Write a byte-exact backup of `pristine` for `target`, once. Subsequent
  // applies reuse the earliest backup so restore always returns to true origin.
  private ensureBackup(target: string, pristine: string): OpResult {
    try {
      if (this.findEarliestBackup(target)) return { ok: true };
      const stamp = Date.now();
      const backupPath = newBackupPath(target, stamp);
      fs.writeFileSync(backupPath, pristine, 'utf8');
      const wrote = fs.readFileSync(backupPath, 'utf8');
      if (sha256(wrote) !== sha256(pristine)) {
        return { ok: false, reason: 'backup checksum mismatch' };
      }
      dlog(`[claude-overlay] backup written ${backupPath}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `backup failed: ${String(e)}` };
    }
  }

  // Restore `target` to its earliest backup (byte-exact). If no backup exists,
  // fall back to the supplied string-strip (idempotent). sha256-verified.
  private restoreFile(target: string, strip: (txt: string) => string): RestoreResult {
    const backupPath = this.findEarliestBackup(target);
    const current = this.fileExists(target) ? fs.readFileSync(target, 'utf8') : null;

    if (!backupPath) {
      // No backup → strip any of our markers as a best-effort revert.
      if (current === null) return { ok: true, restored: false, reason: 'target missing' };
      const stripped = strip(current);
      if (stripped === current) return { ok: true, restored: false, reason: 'no backup; nothing to strip' };
      fs.writeFileSync(target, stripped, 'utf8');
      return { ok: true, restored: true, reason: 'stripped (no backup)' };
    }

    const backup = fs.readFileSync(backupPath, 'utf8');
    if (current !== null && sha256(current) === sha256(backup)) {
      return { ok: true, restored: false, reason: 'already byte-exact' };
    }
    fs.writeFileSync(target, backup, 'utf8');
    const after = fs.readFileSync(target, 'utf8');
    if (sha256(after) !== sha256(backup)) {
      return { ok: false, restored: false, reason: `checksum mismatch after restore: ${target}` };
    }
    dlog(`[claude-overlay] restored ${target} (checksum OK)`);
    return { ok: true, restored: true };
  }

  // Earliest backup of `target`; scans new `.boringspinner.bak.` + legacy `.coads.bak.`.
  private findEarliestBackup(target: string): string | null {
    return findEarliestBackupFor(target);
  }
}
