import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';

import {
  ClaudeCliStatuslineAdapter,
  PHASE2_AD_TEXT,
} from '../src/adapters/claude-cli/adapter';
import {
  upsertStatusLine,
  removeStatusLine,
  readStatusLine,
  statusLineContains,
  statusLineIsCoads,
  extractChainedUserCommand,
  buildChainedCommand,
  STATUSLINE_MARKER,
} from '../src/adapters/claude-cli/settingsEdit';
import type { PatchParams } from '../src/adapters/types';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const read = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf8');

let tmpDir: string;
function copyFixtureToTmp(name: string): string {
  const dest = path.join(tmpDir, 'settings.json');
  fs.copyFileSync(path.join(FIX, name), dest);
  return dest;
}
function params(adText = PHASE2_AD_TEXT): PatchParams {
  return {
    tier: 0,
    adText,
    iconRef: '',
    iconUrl: '',
    clickToken: '',
    clickUrl: '',
    corr: '',
    loopbackPort: 0,
    loopbackToken: '',
    loopbackBase: '',
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coads-statusline-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// CHAIN-CAPTURE: the load-bearing requirement (D4).
// ---------------------------------------------------------------------------
describe('statusLine chain-capture (pure string ops)', () => {
  it('with NO existing statusLine: installs an ad-only command carrying the marker', () => {
    const before = read('settings.plain.json');
    const after = upsertStatusLine(before, 'Sponsored: Linear →');
    const sl = readStatusLine(after)!;
    expect(sl.type).toBe('command');
    expect(sl.command).toContain(STATUSLINE_MARKER);
    expect(sl.command).toContain('Sponsored: Linear');
    // No user command was chained → no inner replay pipe.
    expect(sl.command).not.toContain('| (');
    // Other keys preserved.
    const parsed = JSON.parse(after);
    expect(parsed.model).toBe('claude-sonnet-4');
  });

  it('with an EXISTING user statusLine: ad line is printed FIRST, user command runs BELOW', () => {
    const before = read('settings.withStatusLine.json');
    const userCmd = readStatusLine(before)!.command; // "~/.config/myhud.sh"
    expect(userCmd).toBe('~/.config/myhud.sh');

    const after = upsertStatusLine(before, 'Sponsored: Linear →');
    const sl = readStatusLine(after)!;
    // Our marker + ad text present.
    expect(sl.command).toContain(STATUSLINE_MARKER);
    expect(sl.command).toContain('Sponsored: Linear');
    // The USER's command is preserved and CHAINED below (stdin replayed to it).
    expect(sl.command).toContain('~/.config/myhud.sh');
    expect(sl.command).toContain('| (');
    // Ad line is emitted BEFORE the user command runs (printed first).
    const adIdx = sl.command.indexOf('Sponsored: Linear');
    const userIdx = sl.command.indexOf('~/.config/myhud.sh');
    expect(adIdx).toBeLessThan(userIdx);
    // User's padding is preserved.
    expect(sl.padding).toBe(1);
    // Their original command is recoverable (no data loss).
    expect(extractChainedUserCommand(sl.command)).toBe('~/.config/myhud.sh');
  });

  it('re-applying does NOT nest/double-wrap (idempotent chain; ad swaps cleanly)', () => {
    const before = read('settings.withStatusLine.json');
    const once = upsertStatusLine(before, 'Sponsored: Vercel →');
    const twice = upsertStatusLine(once, 'Sponsored: Linear →');
    const sl = readStatusLine(twice)!;
    // New ad replaced the old one; the old ad text is gone.
    expect(sl.command).toContain('Sponsored: Linear');
    expect(sl.command).not.toContain('Vercel');
    // Still exactly one marker (no nesting).
    expect(sl.command.split(STATUSLINE_MARKER).length - 1).toBe(1);
    // User command preserved through the re-wrap.
    expect(extractChainedUserCommand(sl.command)).toBe('~/.config/myhud.sh');
  });

  it('removeStatusLine RESTORES the user command when ours wrapped it', () => {
    const before = read('settings.withStatusLine.json');
    const patched = upsertStatusLine(before, 'Sponsored: Linear →');
    const removed = removeStatusLine(patched);
    const sl = readStatusLine(removed)!;
    expect(sl.command).toBe('~/.config/myhud.sh'); // user's HUD intact
    expect(statusLineIsCoads(removed)).toBe(false);
    expect(sl.padding).toBe(1);
  });

  it('removeStatusLine removes the key entirely when there was no user command', () => {
    const before = read('settings.plain.json');
    const patched = upsertStatusLine(before, 'Sponsored: Linear →');
    const removed = removeStatusLine(patched);
    expect(readStatusLine(removed)).toBeNull();
    const parsed = JSON.parse(removed);
    expect('statusLine' in parsed).toBe(false);
    expect(parsed.model).toBe('claude-sonnet-4');
  });

  it('removeStatusLine leaves a non-BoringSpinner user statusLine untouched', () => {
    const before = read('settings.withStatusLine.json');
    expect(removeStatusLine(before)).toBe(before);
  });

  it('buildChainedCommand single-quote-escapes ad text (shell-injection safe)', () => {
    const cmd = buildChainedCommand("Joe's Ads → save 50%", null);
    expect(cmd).toContain(STATUSLINE_MARKER);
    // The apostrophe is closed-escaped-reopened for /bin/sh single quotes.
    expect(cmd).toContain(`Joe'\\''s Ads`);
  });
});

// ---------------------------------------------------------------------------
// ADAPTER: byte-exact backup / apply / restore / idempotency / never-throws.
// ---------------------------------------------------------------------------
describe('ClaudeCliStatuslineAdapter (§3 surface 4)', () => {
  it('name matches the §3 surface id verbatim', () => {
    const a = new ClaudeCliStatuslineAdapter(path.join(tmpDir, 'settings.json'));
    expect(a.name).toBe('claude-cli-statusline');
  });

  it('applyPatch → restore is byte-exact (preserves the user HUD)', () => {
    const file = copyFixtureToTmp('settings.withStatusLine.json');
    const original = fs.readFileSync(file, 'utf8');
    const a = new ClaudeCliStatuslineAdapter(file);

    expect(a.applyPatch(params()).ok).toBe(true);
    const patched = fs.readFileSync(file, 'utf8');
    expect(patched).not.toBe(original);
    expect(a.isPatched()).toBe(true);
    expect(patched).toContain('~/.config/myhud.sh'); // user command chained, not lost

    // Backup is namespaced for this surface.
    const backups = fs.readdirSync(tmpDir).filter((f) => f.includes('.boringspinner.bak.'));
    expect(backups.length).toBe(1);
    expect(backups[0]).toContain('.statusline.boringspinner.bak.');

    expect(a.restore().restored).toBe(true);
    expect(sha(fs.readFileSync(file, 'utf8'))).toBe(sha(original)); // BYTE-EXACT
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
    expect(a.isPatched()).toBe(false);
  });

  it('works with no settings file present (no version floor) and restores', () => {
    const file = path.join(tmpDir, 'settings.json'); // does not exist yet
    const a = new ClaudeCliStatuslineAdapter(file);
    expect(a.preflight().compatible).toBe(true); // dir is writable
    expect(a.applyPatch(params()).ok).toBe(true);
    expect(a.isPatched()).toBe(true);
    expect(a.restore().ok).toBe(true);
  });

  it('idempotent: second apply is a no-op (one backup, same bytes)', () => {
    const file = copyFixtureToTmp('settings.plain.json');
    const a = new ClaudeCliStatuslineAdapter(file);
    expect(a.applyPatch(params()).ok).toBe(true);
    const afterFirst = fs.readFileSync(file, 'utf8');
    const second = a.applyPatch(params());
    expect(second.reason).toMatch(/no-op|already/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(afterFirst);
    expect(fs.readdirSync(tmpDir).filter((f) => f.includes('.boringspinner.bak.')).length).toBe(1);
  });

  it('restore with no backup is a safe no-op success', () => {
    const file = copyFixtureToTmp('settings.plain.json');
    const a = new ClaudeCliStatuslineAdapter(file);
    const r = a.restore();
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(false);
  });

  it('never throws — unwritable path returns ok:false', () => {
    const bogusParent = path.join(tmpDir, 'afile');
    fs.writeFileSync(bogusParent, 'x');
    const a = new ClaudeCliStatuslineAdapter(path.join(bogusParent, 'settings.json'));
    const r = a.applyPatch(params());
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe('string');
  });

  it('diagnose() reports the §5.7 shape', () => {
    const file = copyFixtureToTmp('settings.withStatusLine.json');
    const a = new ClaudeCliStatuslineAdapter(file);
    const before = a.diagnose();
    expect(before.name).toBe('claude-cli-statusline');
    expect(before.target).toBe(file);
    expect(before.isPatched).toBe(false);
    expect(before.live.hasArray).toBe(true); // user statusLine present
    a.applyPatch(params());
    const after = a.diagnose();
    expect(after.isPatched).toBe(true);
    expect(after.backup.exists).toBe(true);
    expect(after.live.bareVerbPresent).toBe(true); // ours now
  });
});

// Confirm the spinner adapter's backup namespace does not collide with ours
// (both target the SAME settings.json).
describe('statusline backup does not collide with spinner backup', () => {
  it('uses a distinct .statusline.boringspinner.bak. prefix', () => {
    const file = copyFixtureToTmp('settings.plain.json');
    const a = new ClaudeCliStatuslineAdapter(file);
    a.applyPatch(params());
    const backups = fs.readdirSync(tmpDir).filter((f) => f.includes('.boringspinner.bak.'));
    expect(backups.every((f) => f.startsWith('settings.json.statusline.boringspinner.bak.'))).toBe(true);
    // None match the spinner's bare `settings.json.boringspinner.bak.` prefix exactly.
    expect(backups.some((f) => /^settings\.json\.boringspinner\.bak\./.test(f))).toBe(false);
  });
});
