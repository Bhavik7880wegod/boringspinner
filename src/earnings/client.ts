// src/earnings/client.ts — EarningsClient (§7.2 GET /v1/earnings).
//
// Fetches the today / month / lifetime summary and produces the §5.4 "Active"
// status text:  BoringSpinner ($X today · $Y)   (X = today, Y = lifetime).

import { timeoutFetch, trimBase } from '../util/http';
import { dlog } from '../log';

// §7.2 earnings summary. Amounts are USD decimal strings (ledger is in cents
// server-side; the wire carries pre-formatted strings).
export interface EarningsSummary {
  today: string;
  month: string;
  lifetime: string;
}

// §5.4 Active status text. Pure + exported for tests.
//   BoringSpinner ($0.42 today · $7.11)
export function activeStatusText(today: string, lifetime: string): string {
  return `BoringSpinner ($${today} today · $${lifetime})`;
}

export interface EarningsClientOpts {
  backendBase: string;
  // Device id → publisherAccount(clientId). MUST match the metrics client_id so
  // earnings read the account credits actually land in (else the server reports
  // publisherAccount(email), which is empty → $0.00).
  clientId: string;
  getAccessToken: () => string | null;
  // Recover a merely-expired access token on 401: refresh once (single-flight) +
  // retry, so the balance keeps loading instead of falling back to $0.00 (§10.1).
  refresh?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

export class EarningsClient {
  private readonly base: string;
  private readonly opts: EarningsClientOpts;
  private readonly doFetch: typeof fetch;

  constructor(opts: EarningsClientOpts) {
    this.base = trimBase(opts.backendBase);
    this.opts = opts;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  // GET /v1/earnings?since=… (bearer). `since` is an ISO/epoch hint; the server
  // returns the full summary regardless. Returns null on failure / signed out.
  async fetch(since?: string): Promise<EarningsSummary | null> {
    const token = this.opts.getAccessToken();
    if (!token) return null; // earnings are authed-only (§7.2)
    // client_id selects publisherAccount(clientId) — the account credits land in.
    // Without it the server reports publisherAccount(email), which is empty.
    const params = new URLSearchParams({ client_id: this.opts.clientId });
    if (since) params.set('since', since);
    const url = `${this.base}/v1/earnings?${params.toString()}`;

    const attempt = async (bearer: string): Promise<Response | null> => {
      try {
        return await timeoutFetch(url, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
          fetchImpl: this.doFetch,
        });
      } catch (e) {
        dlog('[earnings] fetch failed', String(e));
        return null;
      }
    };

    let res = await attempt(token);
    // On 401 the access token expired — refresh once (single-flight) and retry so
    // the balance loads instead of showing $0.00 (§10.1). Same recovery as
    // Portfolio/MetricsClient.
    if (res && res.status === 401 && this.opts.refresh) {
      dlog('[earnings] 401 — refreshing access token and retrying');
      if (await this.opts.refresh()) {
        const fresh = this.opts.getAccessToken();
        if (fresh) res = await attempt(fresh);
      }
    }
    if (!res) return null;
    if (!res.ok) {
      dlog('[earnings] non-200', String(res.status));
      return null;
    }
    return (await res.json()) as EarningsSummary;
  }

  // Convenience: fetch and render the §5.4 Active status text. null on failure.
  async activeText(since?: string): Promise<string | null> {
    const s = await this.fetch(since);
    if (!s) return null;
    return activeStatusText(s.today, s.lifetime);
  }
}
