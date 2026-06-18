// src/adapters/claude-cli/cliVersion.ts — reads Claude Code CLI version.
//
// Phase 2: surface 5 (`claude-cli-spinner`) requires Claude Code CLI 2.1.143+
// (§3). Detection is READ-ONLY — we shell out to `claude --version` (or a known
// install path) and parse the semver. We never read or write settings.json here.

import { execFileSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// Minimum CLI version that supports the top-level `spinnerVerbs` field (§3).
export const SPINNER_MIN_VERSION = '2.1.143';

// Candidate binary names / paths to probe (in order). The bare `claude` resolves
// via PATH; the rest cover common user-space install locations (no admin).
function candidateBinaries(): string[] {
  const home = os.homedir();
  return [
    'claude',
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
}

// Parse a version like "2.1.150 (Claude Code)" → "2.1.150". null if unparseable.
export function parseVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

// Read the installed Claude Code CLI version, or null if absent/undetectable.
export function readClaudeCliVersion(): string | null {
  for (const bin of candidateBinaries()) {
    // For absolute paths, skip if the file doesn't exist (avoids noisy throws).
    if (path.isAbsolute(bin) && !safeExists(bin)) continue;
    try {
      const out = execFileSync(bin, ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const v = parseVersion(out);
      if (v) return v;
    } catch {
      // Not found on PATH / not executable / timed out → try next candidate.
    }
  }
  return null;
}

function safeExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// Compare two semver-ish strings; returns -1 / 0 / 1 (a<b / a==b / a>b).
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// Does the given version meet the spinnerVerbs minimum (≥ 2.1.143)?
// null / unparseable ⇒ incompatible.
export function meetsSpinnerMinimum(version: string | null | undefined): boolean {
  const v = parseVersion(version ?? null);
  if (!v) return false;
  return compareVersions(v, SPINNER_MIN_VERSION) >= 0;
}
