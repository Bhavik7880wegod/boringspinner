import { describe, it, expect } from 'vitest';
import { ViewTimer, type ViewEvent } from '../src/viewTracking/timer';

// A deterministic injected clock (§5.10 "inject a now() clock").
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

function harness(opts: { tickMs?: number; thresholdMs?: number; maxSessionMs?: number }) {
  const clock = fakeClock(1_000_000); // absolute epoch baseline (§5.10)
  const events: ViewEvent['event'][] = [];
  const detailed: ViewEvent[] = [];
  const timer = new ViewTimer({
    ...opts,
    now: clock.now,
    onEvent: (e) => {
      events.push(e.event);
      detailed.push(e);
    },
  });
  return { clock, events, detailed, timer };
}

describe('ViewTimer — view_tick cadence (§5.10)', () => {
  it('emits view_tick every tickMs (threshold-first config: maxSessionMs:0)', () => {
    const { clock, events, timer } = harness({ tickMs: 5000, thresholdMs: 3000, maxSessionMs: 0 });
    timer.show('ad_1', 'claude-cli-spinner', 'sess_1');
    clock.advance(5000);
    timer.poll();
    expect(events.filter((e) => e === 'view_tick').length).toBe(1);
    clock.advance(5000); // 10s total
    timer.poll();
    expect(events.filter((e) => e === 'view_tick').length).toBe(2);
  });

  it('catches up multiple skipped tick boundaries in one poll', () => {
    const { clock, events, timer } = harness({ tickMs: 5000, thresholdMs: 3000, maxSessionMs: 0 });
    timer.show('ad_1', 'claude-cli-spinner', 'sess_1');
    clock.advance(16000); // crossed 3 tick boundaries (5,10,15)
    timer.poll();
    expect(events.filter((e) => e === 'view_tick').length).toBe(3);
  });
});

describe('ViewTimer — view_threshold_met exactly once (§5.10)', () => {
  it('fires once when elapsed crosses thresholdMs and never again', () => {
    const { clock, events, timer } = harness({ tickMs: 5000, thresholdMs: 3000, maxSessionMs: 0 });
    timer.show('ad_1', 'claude-cli-spinner', 'sess_1');
    clock.advance(2999);
    timer.poll();
    expect(events).not.toContain('view_threshold_met');
    clock.advance(1); // 3000
    timer.poll();
    expect(events.filter((e) => e === 'view_threshold_met').length).toBe(1);
    clock.advance(10000);
    timer.poll();
    timer.poll();
    expect(events.filter((e) => e === 'view_threshold_met').length).toBe(1); // still once
  });
});

describe('ViewTimer — error_impression at each maxSessionMs boundary (§5.10)', () => {
  it('fires at each maxSessionMs boundary', () => {
    // cap-first: maxSessionMs <= thresholdMs so error precedes threshold.
    const { clock, events, timer } = harness({ tickMs: 5000, thresholdMs: 99999, maxSessionMs: 5000 });
    timer.show('ad_1', 'claude-cli-spinner', 'sess_1');
    clock.advance(5000);
    timer.poll();
    expect(events.filter((e) => e === 'error_impression').length).toBe(1);
    clock.advance(5000); // 10s
    timer.poll();
    expect(events.filter((e) => e === 'error_impression').length).toBe(2);
  });
});

describe('ViewTimer — error→threshold MUTEX (§5.10)', () => {
  it('cap-first default: once error_impression fired, view_threshold_met is suppressed', () => {
    // thresholdMs > maxSessionMs would normally let threshold fire, but the
    // mutex suppresses it because an error fired first. Here threshold=3000,
    // maxSession=2000 → error fires at 2000 before threshold at 3000.
    const { clock, events, timer } = harness({ tickMs: 5000, thresholdMs: 3000, maxSessionMs: 2000 });
    timer.show('ad_1', 'claude-cli-spinner', 'sess_1');
    clock.advance(3000); // crosses BOTH the 2000 error boundary and 3000 threshold
    timer.poll();
    expect(events).toContain('error_impression'); // error fired
    expect(events).not.toContain('view_threshold_met'); // MUTEX: suppressed
  });

  it('threshold-first config (maxSessionMs:0): threshold DOES fire, no error', () => {
    const { clock, events, timer } = harness({ tickMs: 5000, thresholdMs: 3000, maxSessionMs: 0 });
    timer.show('ad_1', 'claude-cli-spinner', 'sess_1');
    clock.advance(3000);
    timer.poll();
    expect(events).toContain('view_threshold_met');
    expect(events).not.toContain('error_impression');
  });

  it('threshold-first config (maxSessionMs > thresholdMs): threshold fires before any error', () => {
    const { clock, events, timer } = harness({ tickMs: 5000, thresholdMs: 3000, maxSessionMs: 5000 });
    timer.show('ad_1', 'claude-cli-spinner', 'sess_1');
    clock.advance(3000);
    timer.poll();
    expect(events).toContain('view_threshold_met'); // fired before the 5000 error boundary
    expect(events).not.toContain('error_impression');
  });
});

describe('ViewTimer — session identity (§5.10)', () => {
  it('is idempotent on the same sessionNonce (baseline preserved)', () => {
    const { clock, timer } = harness({ tickMs: 5000, thresholdMs: 3000, maxSessionMs: 0 });
    timer.show('ad_1', 'claude-cli-spinner', 'sess_1');
    clock.advance(2000);
    timer.show('ad_1', 'claude-cli-spinner', 'sess_1'); // same nonce — no restart
    expect(timer.elapsedMs()).toBe(2000); // baseline NOT reset
  });

  it('a new sessionNonce restarts the absolute baseline', () => {
    const { clock, events, timer } = harness({ tickMs: 5000, thresholdMs: 3000, maxSessionMs: 0 });
    timer.show('ad_1', 'claude-cli-spinner', 'sess_1');
    clock.advance(4000);
    timer.poll(); // threshold fires for sess_1
    expect(events.filter((e) => e === 'view_threshold_met').length).toBe(1);
    timer.show('ad_2', 'claude-cli-spinner', 'sess_2'); // restart
    expect(timer.elapsedMs()).toBe(0);
    clock.advance(2999);
    timer.poll();
    // sess_2 hasn't crossed threshold yet → still only the one from sess_1.
    expect(events.filter((e) => e === 'view_threshold_met').length).toBe(1);
    clock.advance(1);
    timer.poll();
    expect(events.filter((e) => e === 'view_threshold_met').length).toBe(2);
  });
});

describe('ViewTimer — full event-sequence sample (mutex demonstrated)', () => {
  it('cap-first timeline: tick, then error engages mutex, threshold suppressed', () => {
    const { clock, detailed, timer } = harness({ tickMs: 5000, thresholdMs: 3000, maxSessionMs: 5000 });
    // Use maxSessionMs == tickMs so error & tick land together at 5000; threshold
    // at 3000 fires first (threshold-first since maxSession>threshold).
    timer.show('ad_1', 'claude-cli-spinner', 'sess_1');
    const seq: string[] = [];
    for (let t = 0; t < 12000; t += 250) {
      clock.set(1_000_000 + t + 250);
      timer.poll();
    }
    detailed.forEach((e) => seq.push(`${e.event}@${e.visibleMs}`));
    // Expect threshold at 3000, ticks at 5000/10000, errors at 5000/10000.
    expect(seq).toContain('view_threshold_met@3000');
    expect(seq).toContain('view_tick@5000');
    expect(seq).toContain('error_impression@5000');
    expect(seq).toContain('view_tick@10000');
    expect(seq).toContain('error_impression@10000');
  });
});
