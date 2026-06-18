import { describe, it, expect } from 'vitest';
import { buildVersion, buildLabel } from '../src/buildinfo';
import pkg from '../package.json';

describe('buildinfo', () => {
  it('buildVersion matches package.json version', () => {
    expect(buildVersion()).toBe((pkg as { version: string }).version);
    expect(buildVersion()).toBe('0.3.14'); // 0.3.14 — final DMCA copy wording
  });

  it('buildLabel includes the version', () => {
    expect(buildLabel()).toBe(`BoringSpinner ${buildVersion()}`);
  });
});
