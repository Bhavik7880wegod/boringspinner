// src/activation/cliTick.ts — view-tick billing loop for the terminal surfaces
// (§5.6 step 16, §5.10).
//
// Drives the ViewTimer's poll() at ~250ms so the absolute-epoch baseline emits
// view_tick / view_threshold_met / error_impression. The ViewTimer's onEvent
// (wired in extension.ts) forwards each to the MetricsClient. This module owns
// only the cadence; all the billing logic is in ViewTimer (§5.10).

import type { ViewTimer } from '../viewTracking/timer';

export const VIEW_POLL_MS = 250; // §5.10 — "poll() runs every ~250 ms"

export interface ViewMetricsHandle {
  dispose: () => void;
}

// Start the 250ms poll loop against an already-constructed ViewTimer (whose
// onEvent posts to MetricsClient). Returns a disposable that stops the loop.
export function wireViewMetrics(timer: ViewTimer, pollMs = VIEW_POLL_MS): ViewMetricsHandle {
  const id = setInterval(() => timer.poll(), pollMs);
  if (typeof id.unref === 'function') id.unref();
  return { dispose: () => clearInterval(id) };
}
