// src/util/http.ts — timeoutFetch(ms): native fetch with a timeout wrapper (§5.1).
//
// All BoringSpinner network calls go through this so the 15s timeout (§5.1) is uniform
// and an unreachable backend can never hang activation. AbortController-based;
// never leaks the timer. `fetchImpl` is injectable so clients/tests can swap it.

export const DEFAULT_TIMEOUT_MS = 15_000; // §5.1 — native fetch with a 15s timeout

export interface TimeoutFetchOpts extends RequestInit {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

// fetch() that rejects with an AbortError after `timeoutMs`. The caller decides
// whether that's transient or fatal (see AuthClient.refresh §10.1).
export async function timeoutFetch(
  url: string,
  opts: TimeoutFetchOpts = {},
): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, signal, ...init } = opts;
  const doFetch = fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // Honor a caller-supplied signal too (abort either way).
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    return await doFetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Trim trailing slashes from a base so `${base}/v1/...` never double-slashes.
export function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}
