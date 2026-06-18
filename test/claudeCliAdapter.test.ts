import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import {
  ClaudeCliSpinnerAdapter,
  PHASE2_AD_TEXT,
} from '../src/adapters/claude-cli/adapter';
import type { PatchParams } from '../src/adapters/types';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const sha = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

// Each test gets its own isolated temp dir with a COPY of a fixture — the real
// ~/.claude/settings.json is NEVER touched.
let tmpDir: string;
function copyFixtureToTmp(name: string): string {
  const dest = path.join(tmpDir, 'settings.json');
  fs.copyFileSync(path.join(FIX, name), dest);
  return dest;
}

// A throwaway PatchParams; only adText is load-bearing for the CLI surface.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coads-cli-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ClaudeCliSpinnerAdapter — identity (§0)', () => {
  it('name matches the §0 surface id verbatim', () => {
    const a = new ClaudeCliSpinnerAdapter(path.join(tmpDir, 'settings.json'));
    expect(a.name).toBe('claude-cli-spinner');
  });
  it('hardcoded ad is the Phase-2 Linear line (§15)', () => {
    expect(PHASE2_AD_TEXT).toBe('Sponsored: Linear — fast issue tracking →');
  });
});

describe('applyPatch → restore is byte-exact (checksum-verified)', () => {
  it('restores the original bytes exactly after a patch', () => {
    const file = copyFixtureToTmp('settings.plain.json');
    const original = fs.readFileSync(file, 'utf8');
    const originalSha = sha(original);

    const a = new ClaudeCliSpinnerAdapter(file);

    const applied = a.applyPatch(params());
    expect(applied.ok).toBe(true);
    // File changed + ad present.
    const patched = fs.readFileSync(file, 'utf8');
    expect(patched).not.toBe(original);
    expect(a.isPatched()).toBe(true);
    expect(patched).toContain('Sponsored: Linear');

    // A pristine backup exists.
    const backups = fs.readdirSync(tmpDir).filter((f) => f.includes('.boringspinner.bak.'));
    expect(backups.length).toBe(1);

    const restored = a.restore();
    expect(restored.ok).toBe(true);
    expect(restored.restored).toBe(true);

    const after = fs.readFileSync(file, 'utf8');
    expect(sha(after)).toBe(originalSha); // BYTE-EXACT
    expect(after).toBe(original);
    expect(a.isPatched()).toBe(false);
  });

  it('preserves comments through patch then restores them byte-exact', () => {
    const file = copyFixtureToTmp('settings.withComments.jsonc');
    const original = fs.readFileSync(file, 'utf8');
    const a = new ClaudeCliSpinnerAdapter(file);

    expect(a.applyPatch(params()).ok).toBe(true);
    const patched = fs.readFileSync(file, 'utf8');
    // Comments survive the patch.
    expect(patched).toContain("// user's preferred model — do not change");
    expect(patched).toContain('Sponsored: Linear');

    expect(a.restore().ok).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});

describe('applyPatch idempotency', () => {
  it('second apply is a no-op (no second backup, same bytes)', () => {
    const file = copyFixtureToTmp('settings.plain.json');
    const a = new ClaudeCliSpinnerAdapter(file);

    expect(a.applyPatch(params()).ok).toBe(true);
    const afterFirst = fs.readFileSync(file, 'utf8');

    const second = a.applyPatch(params());
    expect(second.ok).toBe(true);
    expect(second.reason).toMatch(/no-op|already/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(afterFirst);

    // Still exactly one backup.
    const backups = fs.readdirSync(tmpDir).filter((f) => f.includes('.boringspinner.bak.'));
    expect(backups.length).toBe(1);
  });
});

describe('applyPatch — multi-verb rotation set (auction queue)', () => {
  const verbsOf = (file: string): string[] => {
    const d = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      spinnerVerbs?: { mode?: string; verbs?: string[] };
    };
    return d.spinnerVerbs?.verbs ?? [];
  };

  it('writes EVERY queue ad text into spinnerVerbs (not just the head)', () => {
    const file = copyFixtureToTmp('settings.plain.json');
    const a = new ClaudeCliSpinnerAdapter(file);
    const queue = ['Automate Job Applications', 'Bet on the insiders not everywhere!'];

    const r = a.applyPatch({ ...params(), verbs: queue });
    expect(r.ok).toBe(true);
    expect(verbsOf(file)).toEqual(queue); // both campaigns present → Claude rotates
  });

  it('is a no-op when the SAME set is re-applied, but rewrites on a changed set', () => {
    const file = copyFixtureToTmp('settings.plain.json');
    const a = new ClaudeCliSpinnerAdapter(file);
    const q1 = ['Ad A', 'Ad B'];

    expect(a.applyPatch({ ...params(), verbs: q1 }).ok).toBe(true);
    const afterFirst = fs.readFileSync(file, 'utf8');

    const second = a.applyPatch({ ...params(), verbs: q1 });
    expect(second.reason).toMatch(/no-op|already/i);
    expect(fs.readFileSync(file, 'utf8')).toBe(afterFirst); // unchanged

    // A new campaign joins the queue → the set changes → rewrite.
    const q2 = ['Ad A', 'Ad B', 'Ad C'];
    expect(a.applyPatch({ ...params(), verbs: q2 }).ok).toBe(true);
    expect(verbsOf(file)).toEqual(q2);

    // Still exactly one backup (the pristine pre-install state).
    const backups = fs.readdirSync(tmpDir).filter((f) => f.includes('.boringspinner.bak.'));
    expect(backups.length).toBe(1);
  });

  it('falls back to the single adText when no verbs are supplied', () => {
    const file = copyFixtureToTmp('settings.plain.json');
    const a = new ClaudeCliSpinnerAdapter(file);
    expect(a.applyPatch(params('Solo Ad')).ok).toBe(true);
    expect(verbsOf(file)).toEqual(['Solo Ad']);
  });
});

describe('restore idempotency', () => {
  it('restore with no backup is a safe no-op success', () => {
    const file = copyFixtureToTmp('settings.plain.json');
    const a = new ClaudeCliSpinnerAdapter(file);
    const r = a.restore();
    expect(r.ok).toBe(true);
    expect(r.restored).toBe(false);
  });

  it('restore twice is idempotent (second is byte-exact no-op)', () => {
    const file = copyFixtureToTmp('settings.plain.json');
    const a = new ClaudeCliSpinnerAdapter(file);
    a.applyPatch(params());
    expect(a.restore().restored).toBe(true);
    const second = a.restore();
    expect(second.ok).toBe(true);
    expect(second.restored).toBe(false); // already byte-exact
  });
});

describe('prime()', () => {
  it('is a no-op success for the CLI surface (no CSP work)', () => {
    const a = new ClaudeCliSpinnerAdapter(path.join(tmpDir, 'settings.json'));
    const r = a.prime();
    expect(r.ok).toBe(true);
  });
});

describe('diagnose() shape (§5.7)', () => {
  it('reports the correct shape with isPatched reflecting state', () => {
    const file = copyFixtureToTmp('settings.plain.json');
    const a = new ClaudeCliSpinnerAdapter(file);

    const before = a.diagnose();
    expect(before.name).toBe('claude-cli-spinner');
    expect(before.target).toBe(file);
    expect(before.targetExists).toBe(true);
    expect(before.isPatched).toBe(false);
    expect(before.backup.exists).toBe(false);
    expect(before.backup.hasBlock).toBe(false);
    expect(before.live.hasArray).toBe(false);
    // shape keys present
    expect(before).toHaveProperty('compatible');
    expect(before).toHaveProperty('version');
    expect(before.backup).toHaveProperty('path');
    expect(before.live).toHaveProperty('bareVerbPresent');

    a.applyPatch(params());
    const after = a.diagnose();
    expect(after.isPatched).toBe(true);
    expect(after.backup.exists).toBe(true);
    expect(after.live.hasArray).toBe(true);
    expect(after.live.bareVerbPresent).toBe(true);
  });
});

describe('never throws — returns typed results', () => {
  it('applyPatch on an unwritable path returns ok:false, not a throw', () => {
    // Point at a path whose parent dir does not exist and cannot be created
    // under a file (using a file as a directory component).
    const bogusParent = path.join(tmpDir, 'afile');
    fs.writeFileSync(bogusParent, 'x');
    const a = new ClaudeCliSpinnerAdapter(path.join(bogusParent, 'settings.json'));
    const r = a.applyPatch(params());
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe('string');
  });
});
