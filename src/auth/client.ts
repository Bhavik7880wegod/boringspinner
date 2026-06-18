// src/auth/client.ts — AuthClient: Google OAuth device flow + single-flight refresh.
//
// Device flow (§10.1): start() → open(url) → poll() until tokens or 180s timeout.
// Tokens persist via the layered SecretVault. refresh() coalesces concurrent
// callers onto ONE request (single-flight, §10.1 S1 semantics): the refresh
// token rotates on each use, so two parallel refreshes would race — one rotates,
// the other 401s with the consumed token. We hold an inFlight Promise.
//
// Transient vs fatal (§10.1):
//   network error / 5xx → transient: KEEP the token, retry next time.
//   explicit 401        → fatal: CLEAR the token, demote to demo mode.
//
// No `vscode` import here — `open` is injected so the module loads under vitest.

import { timeoutFetch, trimBase } from '../util/http';
import { dlog } from '../log';
import { SecretVault, type TokenBundle } from './vault';

export interface AuthStartResponse {
  url: string;
  state: string;
  pollMs: number; // default 1500 (§10.1)
}

export interface AuthClientOpts {
  backendBase: string;
  vault: SecretVault;
  open: (url: string) => Promise<void> | void; // vscode.env.openExternal in prod
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number; // default 1500 (§10.1)
  pollTimeoutMs?: number; // default 180_000 (§10.1)
  sleep?: (ms: number) => Promise<void>; // injectable for tests
  onSignedIn?: (email: string) => void; // §5.6 step 19
}

const DEFAULT_POLL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 180_000;

export class AuthClient {
  private readonly base: string;
  private readonly vault: SecretVault;
  private readonly open: (url: string) => Promise<void> | void;
  private readonly doFetch: typeof fetch;
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onSignedIn?: (email: string) => void;

  private tokens: TokenBundle | null = null;
  private inFlight: Promise<boolean> | null = null; // single-flight refresh

  constructor(opts: AuthClientOpts) {
    this.base = trimBase(opts.backendBase);
    this.vault = opts.vault;
    this.open = opts.open;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onSignedIn = opts.onSignedIn;
  }

  isSignedIn(): boolean {
    return this.tokens !== null;
  }
  getAccessToken(): string | null {
    return this.tokens?.access ?? null;
  }
  getEmail(): string | null {
    return this.tokens?.email ?? null;
  }

  // §5.6 step 11 — load cached tokens (keychain → file fallback inside vault).
  async loadCached(): Promise<boolean> {
    const bundle = await this.vault.load();
    if (bundle) {
      this.tokens = bundle;
      dlog('[auth] loaded cached tokens for', bundle.email);
      return true;
    }
    return false;
  }

  // GET /v1/auth/start → { url, state, pollMs } (§7.2 / §10.1).
  async start(): Promise<AuthStartResponse> {
    const res = await timeoutFetch(`${this.base}/v1/auth/start`, {
      method: 'GET',
      fetchImpl: this.doFetch,
    });
    if (!res.ok) throw new Error(`auth/start ${res.status}`);
    return (await res.json()) as AuthStartResponse;
  }

  // Run the full device flow: start → open → poll. Persists tokens on success.
  async signIn(): Promise<boolean> {
    const started = await this.start();
    await this.open(started.url);
    const ok = await this.poll(started.state, started.pollMs || this.pollIntervalMs);
    return ok;
  }

  // GET /v1/auth/poll?state=… every pollMs until tokens or timeout (§10.1).
  // timeoutMs defaults to the 180s device-flow window; the interactive terminal
  // login passes a SHORT window (a few seconds) so each "press Enter to check"
  // does one bounded poll rather than blocking the whole 180s.
  async poll(
    state: string,
    pollMs: number = this.pollIntervalMs,
    timeoutMs: number = this.pollTimeoutMs,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await timeoutFetch(
          `${this.base}/v1/auth/poll?state=${encodeURIComponent(state)}`,
          { method: 'GET', fetchImpl: this.doFetch },
        );
        if (res.status === 200) {
          const body = (await res.json()) as Partial<TokenBundle> & { status?: string };
          if (body.access && body.refresh && body.email) {
            await this.setTokens(body as TokenBundle);
            return true;
          }
          // 200 with {status:'pending'} → keep polling.
        }
      } catch (e) {
        dlog('[auth] poll error (retrying)', String(e));
      }
      await this.sleep(pollMs);
    }
    dlog('[auth] poll timed out after', String(timeoutMs), 'ms');
    return false;
  }

  // Single-flight refresh (§10.1). Concurrent callers share one inFlight promise.
  async refresh(): Promise<boolean> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<boolean> {
    const refresh = this.tokens?.refresh;
    if (!refresh) return false;
    let res: Response;
    try {
      res = await timeoutFetch(`${this.base}/v1/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh }),
        fetchImpl: this.doFetch,
      });
    } catch (e) {
      // Network error → TRANSIENT: keep the token, retry next time (§10.1).
      dlog('[auth] refresh network error — transient, keeping token', String(e));
      return false;
    }
    if (res.status === 401) {
      // Explicit 401 → FATAL: clear + demote to demo (§10.1).
      dlog('[auth] refresh 401 — fatal, clearing token + demoting to demo');
      await this.clear();
      return false;
    }
    if (!res.ok) {
      // 5xx / other non-200 → TRANSIENT: keep token (§10.1).
      dlog('[auth] refresh non-200 (transient)', String(res.status));
      return false;
    }
    const body = (await res.json()) as TokenBundle;
    await this.setTokens({ ...body, email: body.email ?? this.tokens?.email ?? '' });
    return true;
  }

  // POST /v1/auth/revoke then clear every storage location (§5.5 sign-out).
  async revoke(): Promise<void> {
    const refresh = this.tokens?.refresh;
    if (refresh) {
      try {
        await timeoutFetch(`${this.base}/v1/auth/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh }),
          fetchImpl: this.doFetch,
        });
      } catch (e) {
        dlog('[auth] revoke network error (clearing locally anyway)', String(e));
      }
    }
    await this.clear();
  }

  private async setTokens(bundle: TokenBundle): Promise<void> {
    const firstSignIn = this.tokens === null;
    this.tokens = bundle;
    await this.vault.store(bundle);
    if (firstSignIn) this.onSignedIn?.(bundle.email);
  }

  private async clear(): Promise<void> {
    this.tokens = null;
    await this.vault.clear();
  }
}
