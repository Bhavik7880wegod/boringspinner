import { describe, it, expect } from 'vitest';
import { canPatch, whyNotPatch } from '../src/servingGate';

// §6.5 — serving gate folds enabled + kill posture + compatibility.
describe('canPatch', () => {
  it('allows when enabled + compatible + kill clear', () => {
    expect(canPatch({ enabled: true, compatible: true, killPosture: 'clear' })).toBe(true);
  });
  it('blocks when disabled', () => {
    expect(canPatch({ enabled: false, compatible: true, killPosture: 'clear' })).toBe(false);
  });
  it('blocks when incompatible', () => {
    expect(canPatch({ enabled: true, compatible: false, killPosture: 'clear' })).toBe(false);
  });
  it('blocks on confirmed kill', () => {
    expect(canPatch({ enabled: true, compatible: true, killPosture: 'confirmed' })).toBe(false);
  });
  it('fails closed when offline', () => {
    expect(canPatch({ enabled: true, compatible: true, killPosture: 'offline' })).toBe(false);
  });
});

describe('whyNotPatch', () => {
  it('returns null when serving is allowed', () => {
    expect(whyNotPatch({ enabled: true, compatible: true, killPosture: 'clear' })).toBeNull();
  });
  it('explains each block reason', () => {
    expect(whyNotPatch({ enabled: false, compatible: true, killPosture: 'clear' })).toMatch(/disabled/);
    expect(whyNotPatch({ enabled: true, compatible: false, killPosture: 'clear' })).toMatch(/compatible/);
    expect(whyNotPatch({ enabled: true, compatible: true, killPosture: 'confirmed' })).toMatch(/killed/);
    expect(whyNotPatch({ enabled: true, compatible: true, killPosture: 'offline' })).toMatch(/offline/);
  });
});
