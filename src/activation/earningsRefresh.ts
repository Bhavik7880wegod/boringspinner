// src/activation/earningsRefresh.ts — polls /v1/earnings every 30s (§5.6 step 17).
//
// Thin scheduler: repaints the status bar's Active state on an interval. The
// actual fetch + render lives in the injected `refresh` callback (extension.ts)
// so this module is dependency-free and trivially testable.

export interface EarningsRefreshDeps {
  intervalMs?: number; // default 30_000 (§5.6 step 17)
  refresh: () => void | Promise<void>;
}

export interface EarningsRefreshHandle {
  dispose: () => void;
}

export function setupEarningsRefresh(deps: EarningsRefreshDeps): EarningsRefreshHandle {
  const interval = deps.intervalMs ?? 30_000;
  const timer = setInterval(() => {
    void deps.refresh();
  }, interval);
  // Don't keep the host process alive on this timer.
  if (typeof timer.unref === 'function') timer.unref();
  return {
    dispose: () => clearInterval(timer),
  };
}
