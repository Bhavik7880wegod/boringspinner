import { describe, it, expect } from 'vitest';
import {
  shouldRestart,
  MAX_RESTARTS_PER_SESSION,
  type SentinelPayload,
} from '../src/reloadSignal';

// §11 — reload sentinel decision logic. Capped at 3 restarts/session.
const p = (version: string, mtimeMs: number): SentinelPayload => ({ version, mtimeMs });

describe('shouldRestart', () => {
  it('restarts on first-ever sentinel', () => {
    expect(shouldRestart(null, p('0.2.1', 100), 0)).toBe(true);
  });
  it('does not restart when nothing changed', () => {
    expect(shouldRestart(p('0.2.1', 100), p('0.2.1', 100), 0)).toBe(false);
  });
  it('restarts when version changes', () => {
    expect(shouldRestart(p('0.2.1', 100), p('0.2.2', 100), 0)).toBe(true);
  });
  it('restarts when mtime advances for same version', () => {
    expect(shouldRestart(p('0.2.1', 100), p('0.2.1', 200), 0)).toBe(true);
  });
  it('never restarts on a null next sentinel', () => {
    expect(shouldRestart(p('0.2.1', 100), null, 0)).toBe(false);
  });
  it('caps at MAX_RESTARTS_PER_SESSION (3)', () => {
    expect(MAX_RESTARTS_PER_SESSION).toBe(3);
    expect(shouldRestart(p('0.2.1', 100), p('0.2.9', 999), 3)).toBe(false);
    expect(shouldRestart(p('0.2.1', 100), p('0.2.9', 999), 2)).toBe(true);
  });
});
