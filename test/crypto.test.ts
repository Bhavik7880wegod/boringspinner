import { describe, it, expect } from 'vitest';
import { uuidv4, isUuidV4, deriveClientId, UUID_V4_RE } from '../src/util/crypto';
import { canServeBillable, canServeDemo, canPatch } from '../src/servingGate';

describe('uuidv4 — §6.3 nonce', () => {
  it('generates strings that match the UUIDv4 regex the server enforces', () => {
    for (let i = 0; i < 50; i++) {
      const id = uuidv4();
      expect(id).toMatch(UUID_V4_RE);
      expect(isUuidV4(id)).toBe(true);
    }
  });
  it('rejects non-UUIDv4 strings (the server 400s these)', () => {
    expect(isUuidV4('not-a-uuid')).toBe(false);
    expect(isUuidV4('12345678-1234-1234-1234-123456789012')).toBe(false); // version != 4
    expect(isUuidV4('')).toBe(false);
  });
});

describe('deriveClientId — §6.2 stable device id', () => {
  it('is stable for the same host facts and dvc_-prefixed', () => {
    const facts = { hostname: 'mac', platform: 'darwin', arch: 'arm64', homedir: '/Users/x' };
    const a = deriveClientId(facts);
    const b = deriveClientId(facts);
    expect(a).toBe(b);
    expect(a.startsWith('dvc_')).toBe(true);
  });
  it('differs for different machines', () => {
    const a = deriveClientId({ hostname: 'mac1', platform: 'darwin', arch: 'arm64', homedir: '/Users/x' });
    const b = deriveClientId({ hostname: 'mac2', platform: 'darwin', arch: 'arm64', homedir: '/Users/y' });
    expect(a).not.toBe(b);
  });
});

describe('servingGate — Phase 3 sign-in gating (§5.11)', () => {
  const base = { enabled: true, killPosture: 'clear' as const, compatible: true };
  it('demo serves regardless of sign-in', () => {
    expect(canServeDemo({ ...base, signedIn: false })).toBe(true);
    expect(canServeDemo({ ...base, signedIn: true })).toBe(true);
  });
  it('billable requires signed-in', () => {
    expect(canServeBillable({ ...base, signedIn: false })).toBe(false);
    expect(canServeBillable({ ...base, signedIn: true })).toBe(true);
  });
  it('a closed base gate blocks both', () => {
    expect(canServeDemo({ ...base, enabled: false })).toBe(false);
    expect(canServeBillable({ ...base, signedIn: true, killPosture: 'offline' })).toBe(false);
    expect(canPatch({ ...base, killPosture: 'confirmed' })).toBe(false);
  });
});
