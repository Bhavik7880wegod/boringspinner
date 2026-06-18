// src/adapters/claude-cli/adapter.ts — surfaces 4 + 5 (statusline + spinner).
//
// Phase 2 implements ONLY surface 5 (`claude-cli-spinner`): inject a single
// sponsored verb into ~/.claude/settings.json → top-level `spinnerVerbs` (§3).
// Surface 4 (`claude-cli-statusline`) is TODO(Phase 5).
//
// Contract: §5.7 TargetAdapter. Every method returns a typed result; NEVER throws.
// Byte-exact backup before first write; restore verified by checksum.
//
// SAFETY: the adapter is constructed with an explicit settings-file path. Tests
// and the safe build path pass a fixture / temp copy. The real
// ~/.claude/settings.json is only used by the live extension at runtime.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type {
  AdapterDiagnostics,
  OpResult,
  PatchParams,
  PreflightResult,
  RestoreResult,
  TargetAdapter,
} from '../types';
import { dlog } from '../../log';
import {
  hasSpinnerVerbs,
  hasStatusLine,
  removeSpinnerVerbs,
  spinnerVerbsContain,
  spinnerVerbsEqual,
  statusLineContains,
  statusLineIsCoads,
  upsertSpinnerVerbs,
  upsertStatusLine,
} from './settingsEdit';
import { meetsSpinnerMinimum, readClaudeCliVersion } from './cliVersion';
import { findEarliestBackupFor, newBackupPath } from '../../util/backup';

// Hardcoded Phase-2 ad. TODO(Phase 4): replace with auction queue (PortfolioClient).
export const PHASE2_AD_TEXT = 'Sponsored: Linear — fast issue tracking →';

export function defaultSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export class ClaudeCliSpinnerAdapter implements TargetAdapter {
  readonly name = 'claude-cli-spinner';
  private readonly settingsPath: string;
  private readonly adText: string;

  // settingsPath defaults to the real file at runtime; tests inject a temp copy.
  constructor(settingsPath: string = defaultSettingsPath(), adText: string = PHASE2_AD_TEXT) {
    this.settingsPath = settingsPath;
    this.adText = adText;
  }

  // --- version -----------------------------------------------------------
  version(): string | null {
    return readClaudeCliVersion();
  }

  // --- preflight ---------------------------------------------------------
  // Compatible iff the settings file path is usable (exists or its dir is
  // creatable) AND the CLI version ≥ 2.1.143 (§3).
  preflight(): PreflightResult {
    const version = this.version();
    const dir = path.dirname(this.settingsPath);
    const pathOk = this.exists() || this.dirWritable(dir);
    const versionOk = meetsSpinnerMinimum(version);
    const compatible = pathOk && versionOk;
    let reason: string | undefined;
    if (!versionOk) {
      reason = version
        ? `Claude Code CLI ${version} < 2.1.143 (spinnerVerbs unsupported)`
        : 'Claude Code CLI not found';
    } else if (!pathOk) {
      reason = `settings.json path not usable: ${this.settingsPath}`;
    }
    return { ok: true, compatible, version, reason };
  }

  // --- applyPatch --------------------------------------------------------
  // Save a byte-exact backup (once) then upsert the spinner verb. Idempotent.
  applyPatch(_p: PatchParams): OpResult {
    try {
      // The rotation set: the full auction queue (`verbs`) when supplied, else
      // the single head ad (`adText`) for back-compat. Claude Code rotates
      // among whatever verbs land here, so writing the whole queue is what makes
      // multiple campaigns rotate in the spinner.
      const verbs = _p?.verbs && _p.verbs.length > 0 ? _p.verbs : [_p?.adText || this.adText];
      const current = this.readSettingsOrEmptyObject();

      // Idempotent: if this EXACT verb set is already present, no write.
      if (spinnerVerbsEqual(current, verbs)) {
        return { ok: true, reason: 'already applied (no-op)' };
      }

      // Byte-exact backup before the first mutating write.
      const backed = this.ensureBackup(current);
      if (!backed.ok) return backed;

      const next = upsertSpinnerVerbs(current, {
        mode: 'replace',
        verbs,
      });
      fs.writeFileSync(this.settingsPath, next, 'utf8');
      dlog(`[claude-cli-spinner] applied ${verbs.length} verb(s) to ${this.settingsPath}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `applyPatch failed: ${String(e)}` };
    }
  }

  // --- restore -----------------------------------------------------------
  // Write the backup back, verify byte-exact via sha256. Idempotent.
  restore(_opts?: { keepCsp?: boolean }): RestoreResult {
    try {
      const backupPath = this.findBackup();
      if (!backupPath) {
        // Nothing was ever patched → nothing to restore (idempotent success).
        return { ok: true, restored: false, reason: 'no backup found' };
      }
      const backup = fs.readFileSync(backupPath, 'utf8');
      const current = this.exists()
        ? fs.readFileSync(this.settingsPath, 'utf8')
        : null;

      // Already byte-equal → idempotent no-op.
      if (current !== null && sha256(current) === sha256(backup)) {
        return { ok: true, restored: false, reason: 'already byte-exact' };
      }

      fs.writeFileSync(this.settingsPath, backup, 'utf8');
      const after = fs.readFileSync(this.settingsPath, 'utf8');
      if (sha256(after) !== sha256(backup)) {
        return {
          ok: false,
          restored: false,
          reason: 'checksum mismatch after restore',
        };
      }
      dlog(`[claude-cli-spinner] restored ${this.settingsPath} (checksum OK)`);
      return { ok: true, restored: true };
    } catch (e) {
      return { ok: false, restored: false, reason: `restore failed: ${String(e)}` };
    }
  }

  // --- prime -------------------------------------------------------------
  // No invisible structural prerequisites for the CLI surface (CSP work is
  // webview-only). Prime is a no-op success here.
  prime(): OpResult {
    return { ok: true, reason: 'no structural prerequisites for CLI surface' };
  }

  // --- isPatched ---------------------------------------------------------
  isPatched(): boolean {
    if (!this.exists()) return false;
    try {
      const text = fs.readFileSync(this.settingsPath, 'utf8');
      return spinnerVerbsContain(text, this.adText);
    } catch {
      return false;
    }
  }

  // --- diagnose ----------------------------------------------------------
  diagnose(): AdapterDiagnostics {
    const pf = this.preflight();
    const exists = this.exists();
    const backupPath = this.findBackup();
    let liveHasArray = false;
    let bareVerbPresent = false;
    if (exists) {
      try {
        const text = fs.readFileSync(this.settingsPath, 'utf8');
        liveHasArray = hasSpinnerVerbs(text);
        bareVerbPresent = spinnerVerbsContain(text, this.adText);
      } catch {
        /* read failure → leave flags false */
      }
    }
    let backupHasArray = false;
    if (backupPath) {
      try {
        backupHasArray = hasSpinnerVerbs(fs.readFileSync(backupPath, 'utf8'));
      } catch {
        /* ignore */
      }
    }
    return {
      name: this.name,
      target: this.settingsPath,
      targetExists: exists,
      version: pf.version,
      compatible: pf.compatible,
      reason: pf.reason,
      isPatched: this.isPatched(),
      backup: {
        exists: backupPath !== null,
        path: backupPath,
        hasArray: backupHasArray,
        hasBlock: false, // no JS block on the CLI surface
      },
      live: {
        hasArray: liveHasArray,
        bareVerbPresent,
      },
    };
  }

  // --- internals ---------------------------------------------------------

  private exists(): boolean {
    try {
      return fs.existsSync(this.settingsPath);
    } catch {
      return false;
    }
  }

  private dirWritable(dir: string): boolean {
    try {
      if (fs.existsSync(dir)) {
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
      }
      // Dir doesn't exist; consider its parent (we'd mkdir on write).
      return fs.existsSync(path.dirname(dir));
    } catch {
      return false;
    }
  }

  private readSettingsOrEmptyObject(): string {
    if (this.exists()) {
      try {
        return fs.readFileSync(this.settingsPath, 'utf8');
      } catch {
        /* fall through to empty */
      }
    }
    return '{\n}\n';
  }

  // Write a byte-exact backup once per current content. We use a stable backup
  // (one per adapter instance/file) keyed by timestamp; subsequent applies reuse
  // the existing backup so restore always returns to the true pre-install state.
  private ensureBackup(currentContent: string): OpResult {
    try {
      const existing = this.findBackup();
      if (existing) return { ok: true }; // already have a pristine backup

      const dir = path.dirname(this.settingsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const stamp = Date.now();
      const backupPath = newBackupPath(this.settingsPath, stamp);
      fs.writeFileSync(backupPath, currentContent, 'utf8');
      // Verify byte-exact.
      const wrote = fs.readFileSync(backupPath, 'utf8');
      if (sha256(wrote) !== sha256(currentContent)) {
        return { ok: false, reason: 'backup checksum mismatch' };
      }
      dlog(`[claude-cli-spinner] backup written ${backupPath}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `backup failed: ${String(e)}` };
    }
  }

  // Locate the EARLIEST `<file>.boringspinner.bak.<ts>` (or legacy `.coads.bak.<ts>`)
  // next to settings.json — the true pre-install state.
  private findBackup(): string | null {
    return findEarliestBackupFor(this.settingsPath);
  }
}

// ===========================================================================
// surface 4 — `claude-cli-statusline` (§3 #4): top-level `statusLine` field of
// ~/.claude/settings.json. Works on EVERY Claude Code CLI version (no version
// floor — unlike spinnerVerbs).
//
// CHAIN-CAPTURE (§ requirement): if the user already has a `statusLine` command
// configured, we do NOT clobber their HUD. Our injected command prints the
// sponsored ad line FIRST, then runs THEIR command on the same stdin and stacks
// its output BELOW. See settingsEdit.buildChainedCommand / upsertStatusLine.
//
// Contract: §5.7 TargetAdapter. Never throws. Byte-exact backup BEFORE the first
// write; restore rolls back to the EARLIEST backup, verified by sha256. The
// backup is NAMESPACED (`<file>.statusline.boringspinner.bak.<ts>`, or the legacy
// `.statusline.coads.bak.<ts>`) so it never collides with the spinner adapter's
// backup of the SAME settings.json.
// ===========================================================================

const STATUSLINE_BACKUP_INFIX = '.statusline'; // namespaces this surface's backup.

export class ClaudeCliStatuslineAdapter implements TargetAdapter {
  readonly name = 'claude-cli-statusline';
  private readonly settingsPath: string;
  private readonly adText: string;

  constructor(settingsPath: string = defaultSettingsPath(), adText: string = PHASE2_AD_TEXT) {
    this.settingsPath = settingsPath;
    this.adText = adText;
  }

  // statusLine works on every CLI version; version is informational only.
  version(): string | null {
    return readClaudeCliVersion();
  }

  // Compatible iff the settings path is usable (exists or its dir is creatable).
  // No version floor (§3: "Works on every Claude Code CLI version").
  preflight(): PreflightResult {
    const version = this.version();
    const dir = path.dirname(this.settingsPath);
    const compatible = this.exists() || this.dirWritable(dir);
    const reason = compatible ? undefined : `settings.json path not usable: ${this.settingsPath}`;
    return { ok: true, compatible, version, reason };
  }

  // Backup once (byte-exact) then upsert OUR chained statusLine. Idempotent.
  applyPatch(_p: PatchParams): OpResult {
    try {
      const adText = _p?.adText || this.adText;
      const current = this.readSettingsOrEmptyObject();

      // Idempotent: our ad already chained for this exact text → no write.
      if (statusLineContains(current, adText)) {
        return { ok: true, reason: 'already applied (no-op)' };
      }

      const backed = this.ensureBackup(current);
      if (!backed.ok) return backed;

      const next = upsertStatusLine(current, adText);
      fs.writeFileSync(this.settingsPath, next, 'utf8');
      dlog(`[claude-cli-statusline] applied chained statusLine to ${this.settingsPath}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `applyPatch failed: ${String(e)}` };
    }
  }

  // Restore the byte-exact backup (the user's original statusLine, if any),
  // sha256-verified. Idempotent.
  restore(_opts?: { keepCsp?: boolean }): RestoreResult {
    try {
      const backupPath = this.findBackup();
      if (!backupPath) return { ok: true, restored: false, reason: 'no backup found' };
      const backup = fs.readFileSync(backupPath, 'utf8');
      const current = this.exists() ? fs.readFileSync(this.settingsPath, 'utf8') : null;
      if (current !== null && sha256(current) === sha256(backup)) {
        return { ok: true, restored: false, reason: 'already byte-exact' };
      }
      fs.writeFileSync(this.settingsPath, backup, 'utf8');
      const after = fs.readFileSync(this.settingsPath, 'utf8');
      if (sha256(after) !== sha256(backup)) {
        return { ok: false, restored: false, reason: 'checksum mismatch after restore' };
      }
      dlog(`[claude-cli-statusline] restored ${this.settingsPath} (checksum OK)`);
      return { ok: true, restored: true };
    } catch (e) {
      return { ok: false, restored: false, reason: `restore failed: ${String(e)}` };
    }
  }

  prime(): OpResult {
    return { ok: true, reason: 'no structural prerequisites for CLI surface' };
  }

  isPatched(): boolean {
    if (!this.exists()) return false;
    try {
      return statusLineContains(fs.readFileSync(this.settingsPath, 'utf8'), this.adText);
    } catch {
      return false;
    }
  }

  diagnose(): AdapterDiagnostics {
    const pf = this.preflight();
    const exists = this.exists();
    const backupPath = this.findBackup();
    let liveHasArray = false;
    let bareVerbPresent = false;
    if (exists) {
      try {
        const text = fs.readFileSync(this.settingsPath, 'utf8');
        liveHasArray = hasStatusLine(text);
        bareVerbPresent = statusLineIsCoads(text);
      } catch {
        /* leave false */
      }
    }
    let backupHasArray = false;
    if (backupPath) {
      try {
        backupHasArray = hasStatusLine(fs.readFileSync(backupPath, 'utf8'));
      } catch {
        /* ignore */
      }
    }
    return {
      name: this.name,
      target: this.settingsPath,
      targetExists: exists,
      version: pf.version,
      compatible: pf.compatible,
      reason: pf.reason,
      isPatched: this.isPatched(),
      backup: {
        exists: backupPath !== null,
        path: backupPath,
        hasArray: backupHasArray,
        hasBlock: false,
      },
      live: { hasArray: liveHasArray, bareVerbPresent },
    };
  }

  // --- internals (mirror the spinner adapter; namespaced backup) ----------

  private exists(): boolean {
    try {
      return fs.existsSync(this.settingsPath);
    } catch {
      return false;
    }
  }

  private dirWritable(dir: string): boolean {
    try {
      if (fs.existsSync(dir)) {
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
      }
      return fs.existsSync(path.dirname(dir));
    } catch {
      return false;
    }
  }

  private readSettingsOrEmptyObject(): string {
    if (this.exists()) {
      try {
        return fs.readFileSync(this.settingsPath, 'utf8');
      } catch {
        /* fall through */
      }
    }
    return '{\n}\n';
  }

  private backupBase(): string {
    return `${this.settingsPath}${STATUSLINE_BACKUP_INFIX}`;
  }

  private ensureBackup(currentContent: string): OpResult {
    try {
      if (this.findBackup()) return { ok: true };
      const dir = path.dirname(this.settingsPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const stamp = Date.now();
      const backupPath = newBackupPath(this.backupBase(), stamp);
      fs.writeFileSync(backupPath, currentContent, 'utf8');
      const wrote = fs.readFileSync(backupPath, 'utf8');
      if (sha256(wrote) !== sha256(currentContent)) {
        return { ok: false, reason: 'backup checksum mismatch' };
      }
      dlog(`[claude-cli-statusline] backup written ${backupPath}`);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: `backup failed: ${String(e)}` };
    }
  }

  // Earliest backup under this surface's namespaced base; scans new + legacy suffixes.
  private findBackup(): string | null {
    return findEarliestBackupFor(this.backupBase());
  }
}
