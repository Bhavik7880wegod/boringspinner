// src/viewTracking/timer.ts — ViewTimer: absolute-epoch baseline (§5.10).
//
// Model (§5.10): on show(adId, surface, sessionNonce) record sessionStartedAt =
// now(). Elapsed = now() - sessionStartedAt. NO accumulator, NO show/hide pause
// — an absolute baseline is immune to a 250ms poll throttled by an inactive tab.
//
// poll() (~250ms) emits:
//   view_tick           — every tickMs (default 5000), once per crossed boundary
//   view_threshold_met  — EXACTLY once per session when elapsed crosses thresholdMs
//   error_impression    — at every maxSessionMs boundary (default 5000), stuck-net
//
// MUTEX (§5.10): once any error_impression has fired in a session, suppress
// view_threshold_met. Cap-first is the default. To get threshold-first, set
// maxSessionMs:0 or maxSessionMs > thresholdMs.
//
// now() is injected so tests are fully deterministic.

import type { MetricEvent } from '../metrics/client';

export interface ViewEvent {
  event: Extract<MetricEvent, 'view_tick' | 'view_threshold_met' | 'error_impression'>;
  adId: string;
  surface: string;
  sessionNonce: string;
  visibleMs: number; // elapsed at emit time
}

export interface ViewTimerOpts {
  tickMs?: number; // default 5000 (§5.10 view_tick cadence)
  thresholdMs?: number; // default 3000 (§2.1 view threshold floor 3s)
  maxSessionMs?: number; // default 5000 (§5.10 error_impression boundary); 0 disables
  now?: () => number; // injectable clock; default Date.now
  onEvent: (e: ViewEvent) => void;
}

interface Session {
  adId: string;
  surface: string;
  sessionNonce: string;
  startedAt: number;
  lastTickBoundary: number; // count of tickMs boundaries already emitted
  lastErrorBoundary: number; // count of maxSessionMs boundaries already emitted
  thresholdMet: boolean; // view_threshold_met already emitted
  errorFired: boolean; // any error_impression fired → mutex active
}

const DEFAULT_TICK_MS = 5000;
const DEFAULT_THRESHOLD_MS = 3000;
const DEFAULT_MAX_SESSION_MS = 5000;

export class ViewTimer {
  private readonly tickMs: number;
  private readonly thresholdMs: number;
  private readonly maxSessionMs: number;
  private readonly now: () => number;
  private readonly onEvent: (e: ViewEvent) => void;
  private session: Session | null = null;

  constructor(opts: ViewTimerOpts) {
    this.tickMs = opts.tickMs ?? DEFAULT_TICK_MS;
    this.thresholdMs = opts.thresholdMs ?? DEFAULT_THRESHOLD_MS;
    this.maxSessionMs = opts.maxSessionMs ?? DEFAULT_MAX_SESSION_MS;
    this.now = opts.now ?? Date.now;
    this.onEvent = opts.onEvent;
  }

  // Start (or restart) a session. Idempotent on the same sessionNonce; a new
  // nonce restarts the absolute baseline (§5.10).
  show(adId: string, surface: string, sessionNonce: string): void {
    if (this.session && this.session.sessionNonce === sessionNonce) {
      return; // idempotent — same session, baseline preserved
    }
    this.session = {
      adId,
      surface,
      sessionNonce,
      startedAt: this.now(),
      lastTickBoundary: 0,
      lastErrorBoundary: 0,
      thresholdMet: false,
      errorFired: false,
    };
  }

  // The active session's elapsed ms (absolute baseline). 0 when no session.
  elapsedMs(): number {
    if (!this.session) return 0;
    return this.now() - this.session.startedAt;
  }

  // Run one poll pass (~250ms). Emits any boundaries crossed since the last poll.
  poll(): void {
    const s = this.session;
    if (!s) return;
    const elapsed = this.now() - s.startedAt;

    // view_tick — emit for every tickMs boundary crossed (handles a poll that
    // skipped multiple boundaries while throttled).
    if (this.tickMs > 0) {
      const boundary = Math.floor(elapsed / this.tickMs);
      while (s.lastTickBoundary < boundary) {
        s.lastTickBoundary += 1;
        this.emit('view_tick', s, s.lastTickBoundary * this.tickMs);
      }
    }

    // error_impression — at each maxSessionMs boundary. Sets the mutex.
    if (this.maxSessionMs > 0) {
      const eb = Math.floor(elapsed / this.maxSessionMs);
      while (s.lastErrorBoundary < eb) {
        s.lastErrorBoundary += 1;
        s.errorFired = true; // MUTEX engaged (§5.10)
        this.emit('error_impression', s, s.lastErrorBoundary * this.maxSessionMs);
      }
    }

    // view_threshold_met — exactly once, UNLESS an error_impression has fired
    // this session (mutex, §5.10).
    if (!s.thresholdMet && !s.errorFired && elapsed >= this.thresholdMs) {
      s.thresholdMet = true;
      this.emit('view_threshold_met', s, elapsed);
    }
  }

  // End the current session (e.g. ad rotated away). No event emitted.
  stop(): void {
    this.session = null;
  }

  private emit(
    event: ViewEvent['event'],
    s: Session,
    visibleMs: number,
  ): void {
    this.onEvent({
      event,
      adId: s.adId,
      surface: s.surface,
      sessionNonce: s.sessionNonce,
      visibleMs,
    });
  }
}
