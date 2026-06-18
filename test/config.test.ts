import { describe, it, expect } from 'vitest';
import { resolveConfig, CONFIG_DEFAULTS } from '../src/config';

// §12 configuration defaults + env overrides.
describe('config defaults (§12)', () => {
  it('uses the §12 template defaults when no file and no env', () => {
    const cfg = resolveConfig(null, {});
    expect(cfg).toEqual({
      backendBase: 'https://api.boringspinner.com',
      updateBase: 'https://api.boringspinner.com',
      localVsixPath: null,
      updatePollIntervalMs: 21_600_000, // 6h
      debug: false,
    });
  });

  it('CONFIG_DEFAULTS matches the §12 template', () => {
    expect(CONFIG_DEFAULTS.backendBase).toBe('https://api.boringspinner.com');
    expect(CONFIG_DEFAULTS.updatePollIntervalMs).toBe(21_600_000);
  });
});

describe('config env overrides (§12)', () => {
  it('COADS_BASE / COADS_UPDATE_BASE / COADS_DEBUG / COADS_LOCAL_VSIX override', () => {
    const cfg = resolveConfig(null, {
      COADS_BASE: 'http://127.0.0.1:8787',
      COADS_UPDATE_BASE: 'https://upd.example',
      COADS_DEBUG: '1',
      COADS_LOCAL_VSIX: '/tmp/coads.vsix',
    });
    expect(cfg.backendBase).toBe('http://127.0.0.1:8787');
    expect(cfg.updateBase).toBe('https://upd.example');
    expect(cfg.debug).toBe(true);
    expect(cfg.localVsixPath).toBe('/tmp/coads.vsix');
  });

  it('updateBase falls back to file backendBase when unset in file', () => {
    const cfg = resolveConfig({ backendBase: 'https://b.example' }, {});
    expect(cfg.updateBase).toBe('https://b.example');
  });
});
