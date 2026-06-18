// src/consent/client.ts — ConsentClient (§7.2 POST /v1/consent).
//
// Records the one-time consent acknowledgment server-side after the user accepts
// the dialog (consent/prompt.ts). Bearer-authed (§7.2). Lean by design.

import { timeoutFetch, trimBase } from '../util/http';
import { dlog } from '../log';

export interface ConsentClientOpts {
  backendBase: string;
  getAccessToken: () => string | null;
  fetchImpl?: typeof fetch;
}

export class ConsentClient {
  private readonly base: string;
  private readonly opts: ConsentClientOpts;
  private readonly doFetch: typeof fetch;

  constructor(opts: ConsentClientOpts) {
    this.base = trimBase(opts.backendBase);
    this.opts = opts;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  // POST /v1/consent { accepted, ts }. Returns true on 2xx. Never throws.
  async record(accepted: boolean): Promise<boolean> {
    const token = this.opts.getAccessToken();
    if (!token) return false; // consent is recorded against a signed-in publisher
    try {
      const res = await timeoutFetch(`${this.base}/v1/consent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ accepted, ts: new Date().toISOString() }),
        fetchImpl: this.doFetch,
      });
      if (!res.ok) {
        dlog('[consent] non-2xx', String(res.status));
        return false;
      }
      return true;
    } catch (e) {
      dlog('[consent] record failed', String(e));
      return false;
    }
  }
}
