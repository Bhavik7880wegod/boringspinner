import { describe, it, expect } from 'vitest';
import { AD_SURFACES } from '../src/types/surface';
import { METRIC_EVENTS } from '../src/metrics/client';

// §3 / §5.7 — the five ad surface ids, verbatim and in spec order.
describe('AdSurface ids (§3)', () => {
  it('are exactly the five spec strings in order', () => {
    expect([...AD_SURFACES]).toEqual([
      'claude-overlay',
      'claude-banner',
      'codex-shimmer',
      'claude-cli-statusline',
      'claude-cli-spinner',
    ]);
  });

  it('has exactly 5 surfaces', () => {
    expect(AD_SURFACES.length).toBe(5);
  });
});

// §6.1 — the seven metric events, verbatim and in spec order.
describe('MetricEvent ids (§6.1)', () => {
  it('are exactly the seven spec strings in order', () => {
    expect([...METRIC_EVENTS]).toEqual([
      'impression_rendered',
      'impression_viewable',
      'prompt_view',
      'view_tick',
      'view_threshold_met',
      'error_impression',
      'click',
    ]);
  });

  it('has exactly 7 events', () => {
    expect(METRIC_EVENTS.length).toBe(7);
  });
});
