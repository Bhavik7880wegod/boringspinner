import { describe, it, expect } from 'vitest';
import { syncOnce } from '../src/activation/cliSync';
import type {
  TargetAdapter,
  PreflightResult,
  OpResult,
  PatchParams,
} from '../src/adapters/types';

// A fake adapter that records applyPatch calls — no real file is ever touched.
function fakeAdapter(compatible: boolean): TargetAdapter & { applied: PatchParams[] } {
  const applied: PatchParams[] = [];
  return {
    name: 'claude-cli-spinner',
    applied,
    preflight(): PreflightResult {
      return { ok: true, compatible, version: compatible ? '2.1.150' : '2.1.119' };
    },
    version: () => (compatible ? '2.1.150' : '2.1.119'),
    applyPatch(p: PatchParams): OpResult {
      applied.push(p);
      return { ok: true };
    },
    restore: () => ({ ok: true, restored: false }),
  };
}

describe('syncOnce — servingGate respected', () => {
  it('writes when enabled + compatible + kill clear', () => {
    const a = fakeAdapter(true);
    const ok = syncOnce({
      adapter: a,
      enabled: () => true,
      killPosture: () => 'clear',
      adText: () => 'Sponsored: Linear — fast issue tracking →',
    });
    expect(ok).toBe(true);
    expect(a.applied.length).toBe(1);
    expect(a.applied[0].adText).toBe('Sponsored: Linear — fast issue tracking →');
  });

  it('threads the FULL queue (verbs) through to applyPatch — head = verbs[0]', () => {
    const a = fakeAdapter(true);
    const queue = ['Automate Job Applications', 'Bet on the insiders not everywhere!'];
    const ok = syncOnce({
      adapter: a,
      enabled: () => true,
      killPosture: () => 'clear',
      adText: () => 'fallback only',
      verbs: () => queue,
    });
    expect(ok).toBe(true);
    expect(a.applied[0].verbs).toEqual(queue); // whole sampled set forwarded
    expect(a.applied[0].adText).toBe(queue[0]); // head is the first queued ad
  });

  it('falls back to single adText when verbs() yields nothing', () => {
    const a = fakeAdapter(true);
    const ok = syncOnce({
      adapter: a,
      enabled: () => true,
      killPosture: () => 'clear',
      adText: () => 'Solo Ad',
      verbs: () => [],
    });
    expect(ok).toBe(true);
    expect(a.applied[0].adText).toBe('Solo Ad');
    expect(a.applied[0].verbs).toEqual([]);
  });

  it('writes NOTHING when the surface is incompatible (old CLI)', () => {
    const a = fakeAdapter(false);
    const ok = syncOnce({
      adapter: a,
      enabled: () => true,
      killPosture: () => 'clear',
      adText: () => 'Ad',
    });
    expect(ok).toBe(false);
    expect(a.applied.length).toBe(0);
  });

  it('writes NOTHING when disabled', () => {
    const a = fakeAdapter(true);
    const ok = syncOnce({
      adapter: a,
      enabled: () => false,
      killPosture: () => 'clear',
      adText: () => 'Ad',
    });
    expect(ok).toBe(false);
    expect(a.applied.length).toBe(0);
  });

  it('fails closed when offline', () => {
    const a = fakeAdapter(true);
    const ok = syncOnce({
      adapter: a,
      enabled: () => true,
      killPosture: () => 'offline',
      adText: () => 'Ad',
    });
    expect(ok).toBe(false);
    expect(a.applied.length).toBe(0);
  });
});
