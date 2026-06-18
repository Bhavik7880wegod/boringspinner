// src/metrics/client.ts — MetricsClient.send() (§6.1, §6.2).
//
// Builds the §6.2 wire JSON for all 7 event types and POSTs it:
//   signed-in  → POST /v1/metrics      (Authorization: Bearer)
//   signed-out → POST /v1/metrics/demo (no Authorization, ext.demo:true)
//   demoted    → POST /v1/metrics/demo (ext.demoted:true) when a signed-in token
//                dies mid-session (§6.2).
// Each event carries a client-generated UUIDv4 nonce (§6.3). The in-memory
// dedupe cache suppresses double-fires within one activation.

import { timeoutFetch, trimBase } from '../util/http';
import { dlog } from '../log';
import { uuidv4, isUuidV4 } from '../util/crypto';
import { NonceDedupe } from './dedupe';

// The 7 metric events (§6.1) — verbatim, in spec order.
export type MetricEvent =
  | 'impression_rendered' // ad inserted into the DOM / settings.json
  | 'impression_viewable' // ad first crossed visibility check
  | 'prompt_view' // user's prompt visible alongside ad
  | 'view_tick' // 5s heartbeat while accumulating
  | 'view_threshold_met' // billable (crossed view threshold)
  | 'error_impression' // safety-net at each maxSessionMs (default 5s)
  | 'click'; // anchor click captured by the loopback

// Canonical, ordered list of every metric event id (§6.1). Tested.
export const METRIC_EVENTS: readonly MetricEvent[] = [
  'impression_rendered',
  'impression_viewable',
  'prompt_view',
  'view_tick',
  'view_threshold_met',
  'error_impression',
  'click',
] as const;

// The fields a caller supplies for one event. Identity fields (client_id,
// versions, ext base) come from MetricsClient config.
export interface MetricInput {
  event: MetricEvent;
  adId: string;
  campaignId: string;
  surface: string;
  corr: string; // X-CoAds-Corr header value (<adId>.<rand>)
  sessionNonce: string; // server-stamped nonce for this ad+device
  sessionToken: string; // server-signed token
  visibleMs?: number;
  viewable?: boolean;
  viewPct?: number;
  viewMs?: number;
  ts?: string; // ISO; defaults to now
}

// The non-secret host facts stamped into `ext` (§6.2).
export interface ExtInfo {
  os: string;
  arch: string;
  os_version: string;
  editor: string;
}

export interface MetricsClientOpts {
  backendBase: string;
  clientId: string;
  claudeCodeVersion: string;
  extensionVersion: string;
  ext: ExtInfo;
  // Live auth view: bearer token when signed in, else null. Read at send-time so
  // a mid-session token death routes to /demo with ext.demoted (§6.2).
  getAccessToken: () => string | null;
  // Recover a merely-expired access token on 401: refresh once (single-flight)
  // and retry, so billable events keep recording instead of silently dropping
  // for the rest of the session (§10.1). Mirrors PortfolioClient.refresh.
  refresh?: () => Promise<boolean>;
  // True only when the user was signed in but the token just died mid-session.
  // Distinguishes genuine demo (never signed in) from refresh-failure demotion.
  isDemoted?: () => boolean;
  fetchImpl?: typeof fetch;
  dedupe?: NonceDedupe;
}

// The exact §6.2 wire shape. Only `ext` is free-form; the backend 400s on any
// other unknown top-level key, so this type is the source of truth.
export interface MetricWire {
  event_type: MetricEvent;
  ad_id: string;
  campaign_id: string;
  client_id: string;
  ts: string;
  claude_code_version: string;
  extension_version: string;
  nonce: string; // UUIDv4
  surface: string;
  visible_ms: number;
  session_nonce: string;
  viewable: boolean;
  view_pct: number;
  view_ms: number;
  session_token: string;
  ext: Record<string, unknown>;
}

export class MetricsClient {
  private readonly base: string;
  private readonly opts: MetricsClientOpts;
  private readonly doFetch: typeof fetch;
  private readonly dedupe: NonceDedupe;

  constructor(opts: MetricsClientOpts) {
    this.base = trimBase(opts.backendBase);
    this.opts = opts;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.dedupe = opts.dedupe ?? new NonceDedupe();
  }

  // Build the §6.2 wire JSON. Pure + exported for tests. Stamps ext.demo /
  // ext.demoted per the signed-out / demoted routing (§5.11, §6.2).
  buildWire(input: MetricInput, opts: { demo: boolean; demoted: boolean }): MetricWire {
    const ext: Record<string, unknown> = { ...this.opts.ext };
    if (opts.demo) ext.demo = true;
    if (opts.demoted) ext.demoted = true;
    return {
      event_type: input.event,
      ad_id: input.adId,
      campaign_id: input.campaignId,
      client_id: this.opts.clientId,
      ts: input.ts ?? new Date().toISOString(),
      claude_code_version: this.opts.claudeCodeVersion,
      extension_version: this.opts.extensionVersion,
      nonce: uuidv4(), // §6.3 client-generated UUIDv4
      surface: input.surface,
      visible_ms: input.visibleMs ?? 0,
      session_nonce: input.sessionNonce,
      viewable: input.viewable ?? false,
      view_pct: input.viewPct ?? 0,
      view_ms: input.viewMs ?? input.visibleMs ?? 0,
      session_token: input.sessionToken,
      ext,
    };
  }

  // Send one event. Routes to /v1/metrics (bearer) or /v1/metrics/demo per
  // sign-in state. Returns false on dedupe-suppress or non-2xx (never throws).
  async send(input: MetricInput): Promise<boolean> {
    const token = this.opts.getAccessToken();
    const signedIn = token !== null;
    const demoted = !signedIn && (this.opts.isDemoted?.() ?? false);
    const demo = !signedIn;

    const wire = this.buildWire(input, { demo, demoted });

    // Guard: never send a nonce we already sent this activation (§6.3).
    if (!this.dedupe.markFresh(wire.nonce)) {
      dlog('[metrics] duplicate nonce suppressed', wire.nonce);
      return false;
    }
    // Defensive: our own nonce must match the UUIDv4 the server enforces.
    if (!isUuidV4(wire.nonce)) {
      dlog('[metrics] generated nonce failed UUIDv4 check (not sent)', wire.nonce);
      return false;
    }

    const path = signedIn ? '/v1/metrics' : '/v1/metrics/demo';

    // POST the (already-built, deduped) wire with an optional bearer. Reused for
    // the post-refresh retry so the SAME nonce is sent — the server's idempotency
    // key — never double-counting (the 401'd first attempt recorded nothing).
    const attempt = async (bearer: string | null): Promise<Response | null> => {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-CoAds-Corr': input.corr, // §0 correlation header (verbatim)
      };
      if (bearer) headers['Authorization'] = `Bearer ${bearer}`;
      try {
        return await timeoutFetch(`${this.base}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(wire),
          fetchImpl: this.doFetch,
        });
      } catch (e) {
        dlog('[metrics] send failed (dropped)', String(e), input.event);
        return null;
      }
    };

    let res = await attempt(signedIn ? token : null);
    // On 401 the access token has expired — refresh once (single-flight) and
    // retry with the fresh token so billable impression / click events keep
    // recording (§10.1) instead of silently dropping for the whole session.
    if (res && res.status === 401 && signedIn && this.opts.refresh) {
      dlog('[metrics] 401 — refreshing access token and retrying', input.event);
      if (await this.opts.refresh()) {
        const fresh = this.opts.getAccessToken();
        if (fresh) res = await attempt(fresh);
      }
    }
    if (!res) return false;
    if (!res.ok) {
      dlog('[metrics] non-2xx', String(res.status), input.event);
      return false;
    }
    return true;
  }
}
