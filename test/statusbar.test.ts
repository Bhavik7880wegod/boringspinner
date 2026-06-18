import { describe, it, expect } from 'vitest';
import { statusText, statusTooltip, type StatusState } from '../src/statusbar';

// §5.4 status bar UX state→text mapping.
describe('statusText (§5.4)', () => {
  it('signed out shows "BoringSpinner: Sign in"', () => {
    expect(statusText({ kind: 'signedOut' })).toBe('BoringSpinner: Sign in');
  });

  it('active shows today / lifetime', () => {
    const s: StatusState = { kind: 'active', todayUsd: '0.42', lifetimeUsd: '7.11' };
    expect(statusText(s)).toBe('BoringSpinner ($0.42 today · $7.11)');
  });

  it('maps every §5.4 state to its exact text', () => {
    const cases: Array<[StatusState, string]> = [
      [{ kind: 'signedOut' }, 'BoringSpinner: Sign in'],
      [{ kind: 'disabled' }, 'BoringSpinner: Off'],
      [{ kind: 'killed' }, 'BoringSpinner: Paused'],
      [{ kind: 'offline' }, 'BoringSpinner: Offline'],
      [{ kind: 'incompatible' }, 'BoringSpinner: incompatible'],
      [{ kind: 'hourlyCap', resetLabel: '47m' }, 'BoringSpinner: Hourly cap (47m)'],
      [{ kind: 'dailyCap', resetLabel: '3h 12m' }, 'BoringSpinner: Daily cap (3h 12m)'],
      [{ kind: 'needsReload' }, 'BoringSpinner: reload to start'],
    ];
    for (const [state, text] of cases) {
      expect(statusText(state)).toBe(text);
    }
  });
});

describe('statusTooltip (§5.4)', () => {
  it('signed out tooltip is "Click to sign in"', () => {
    expect(statusTooltip({ kind: 'signedOut' })).toBe('Click to sign in');
  });

  it('offline tooltip names api.boringspinner.com', () => {
    expect(statusTooltip({ kind: 'offline' })).toBe("Can't reach api.boringspinner.com");
  });
});
