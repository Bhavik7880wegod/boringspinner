import { describe, it, expect } from 'vitest';
import {
  meetsSpinnerMinimum,
  parseVersion,
  compareVersions,
  SPINNER_MIN_VERSION,
} from '../src/adapters/claude-cli/cliVersion';

// §3 — surface 5 requires Claude Code CLI 2.1.143+.
describe('parseVersion', () => {
  it('extracts semver from `--version` output', () => {
    expect(parseVersion('2.1.150 (Claude Code)')).toBe('2.1.150');
    expect(parseVersion('claude-code/2.1.143 darwin-arm64')).toBe('2.1.143');
  });
  it('returns null for unparseable / empty input', () => {
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion('no version here')).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders correctly', () => {
    expect(compareVersions('2.1.143', '2.1.143')).toBe(0);
    expect(compareVersions('2.1.150', '2.1.143')).toBe(1);
    expect(compareVersions('2.1.142', '2.1.143')).toBe(-1);
    expect(compareVersions('2.0.9', '2.1.143')).toBe(-1);
  });
});

describe('meetsSpinnerMinimum (§3 — 2.1.143+)', () => {
  it('accepts >= 2.1.143', () => {
    expect(meetsSpinnerMinimum('2.1.143')).toBe(true);
    expect(meetsSpinnerMinimum('2.1.150')).toBe(true);
    expect(meetsSpinnerMinimum('2.1.150 (Claude Code)')).toBe(true);
    expect(meetsSpinnerMinimum('3.0.0')).toBe(true);
  });
  it('rejects < 2.1.143, null, and unparseable', () => {
    expect(meetsSpinnerMinimum('2.1.142')).toBe(false);
    expect(meetsSpinnerMinimum('2.0.9')).toBe(false);
    expect(meetsSpinnerMinimum('2.1.119')).toBe(false); // this machine's CLI
    expect(meetsSpinnerMinimum(null)).toBe(false);
    expect(meetsSpinnerMinimum(undefined)).toBe(false);
    expect(meetsSpinnerMinimum('garbage')).toBe(false);
  });
  it('exposes the documented minimum constant', () => {
    expect(SPINNER_MIN_VERSION).toBe('2.1.143');
  });
});
