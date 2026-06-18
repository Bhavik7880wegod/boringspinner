// src/portfolio/client.ts — PortfolioClient + demo fallback (§5.8, §5.11).
//
// Signed-in  → GET /v1/portfolio?claude_code_version=… (bearer, billable).
// Signed-out / demoted → GET /v1/portfolio/demo?…&client_id=… (not billable).
//
// Parses the §5.8 PortfolioResponse (camelCase) and clamps the rotation floors:
//   rotationIntervalMs ≥ 15_000 (never rewrite host files faster, §5.8)
//   ttlMs              ≤ 3_600_000 (refetch at least hourly, §5.8)
//   viewThresholdMs    ≥ 1_000 (§5.8)

import { timeoutFetch, trimBase } from '../util/http';
import { dlog } from '../log';

export interface PatchAd {
  adId: string;
  campaignId: string;
  adText: string;
  iconRef: string;
  iconUrl: string;
  clickUrl: string;
  bannerEnabled: boolean;
  sessionToken: string;
  demo?: boolean;
  // "Thought of the Day" served when the publisher is over their daily cap.
  // A quote is NOT a paid ad: it carries no adId/sessionToken/clickUrl, so the
  // billing guards (which require those) never fire a billable event for it.
  type?: 'quote';
  text?: string;
  author?: string;
}

// A quote row served in place of a paid ad (publisher over daily cap).
export function isQuoteAd(ad: Pick<PatchAd, 'type'> | null | undefined): boolean {
  return ad?.type === 'quote';
}

export interface Balances {
  lifetimeUsd: string;
  todayUsd: string;
  lastUpdatedMs: number;
}

export interface PortfolioResponse {
  ad: PatchAd | null;
  ads: PatchAd[];
  queueId: string;
  ttlMs: number;
  rotationIntervalMs: number;
  viewThresholdMs: number;
  balances: Balances | null;
  // True when the server served quotes instead of paid ads (over daily cap).
  over_cap?: boolean;
}

// §5.8 floors.
export const ROTATION_INTERVAL_FLOOR_MS = 15_000;
export const TTL_CAP_MS = 3_600_000;
export const VIEW_THRESHOLD_FLOOR_MS = 1_000;

// Render a quote row into a 💭-prefixed spinner line and strip every billable
// field so no surface can ever charge an advertiser for a "Thought of the Day".
// "💭 {text} — {author}" (the " — author" is omitted when the author is empty).
function normalizeQuote(ad: PatchAd): PatchAd {
  if (ad.type !== 'quote') return ad;
  const author = (ad.author ?? '').trim();
  const text = (ad.text ?? ad.adText ?? '').trim();
  return {
    ...ad,
    adText: `💭 ${author ? `${text} — ${author}` : text}`,
    adId: '',
    campaignId: '',
    sessionToken: '',
    clickUrl: '',
  };
}

// Clamp the server-supplied cadence fields to the §5.8 floors/cap, and render any
// quote rows (over-cap "Thought of the Day") into non-billable 💭 lines. Pure; tested.
export function clampFloors(r: PortfolioResponse): PortfolioResponse {
  const ads = (r.ads ?? []).map(normalizeQuote);
  return {
    ...r,
    ads,
    ad: ads[0] ?? null,
    rotationIntervalMs: Math.max(r.rotationIntervalMs, ROTATION_INTERVAL_FLOOR_MS),
    ttlMs: Math.min(r.ttlMs, TTL_CAP_MS),
    viewThresholdMs: Math.max(r.viewThresholdMs, VIEW_THRESHOLD_FLOOR_MS),
  };
}

export interface PortfolioClientOpts {
  backendBase: string;
  clientId: string;
  claudeCodeVersion: string;
  getAccessToken: () => string | null; // null ⇒ signed out / demoted
  // Refresh the access token (single-flight) when an authed request 401s, so a
  // merely-expired access token recovers to the REAL portfolio instead of demo.
  refresh?: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
}

export class PortfolioClient {
  private readonly base: string;
  private readonly opts: PortfolioClientOpts;
  private readonly doFetch: typeof fetch;

  constructor(opts: PortfolioClientOpts) {
    this.base = trimBase(opts.backendBase);
    this.opts = opts;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  // Fetch the appropriate queue based on sign-in state. Returns null on failure
  // (caller holds prior state / shows offline). Floors are always clamped.
  async fetch(): Promise<PortfolioResponse | null> {
    const token = this.opts.getAccessToken();
    return token ? this.fetchAuthed(token) : this.fetchDemo();
  }

  // §7.2 GET /v1/portfolio (bearer, billable).
  async fetchAuthed(token: string): Promise<PortfolioResponse | null> {
    const url =
      `${this.base}/v1/portfolio?claude_code_version=` +
      encodeURIComponent(this.opts.claudeCodeVersion);
    const first = await this.get(url, { Authorization: `Bearer ${token}` });
    // On 401 the access token has expired — refresh once (single-flight) and
    // retry with the new token so we stay on the REAL portfolio (§10.1), instead
    // of silently falling back to the demo queue.
    if (first.status === 401 && this.opts.refresh) {
      dlog('[portfolio] 401 — refreshing access token and retrying');
      if (await this.opts.refresh()) {
        const fresh = this.opts.getAccessToken();
        if (fresh) return (await this.get(url, { Authorization: `Bearer ${fresh}` })).body;
      }
    }
    return first.body;
  }

  // §7.2 GET /v1/portfolio/demo (no auth, signed-out preview, §5.11).
  async fetchDemo(): Promise<PortfolioResponse | null> {
    const url =
      `${this.base}/v1/portfolio/demo?claude_code_version=` +
      encodeURIComponent(this.opts.claudeCodeVersion) +
      `&client_id=${encodeURIComponent(this.opts.clientId)}`;
    return (await this.get(url, {})).body;
  }

  private async get(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ body: PortfolioResponse | null; status: number }> {
    try {
      const res = await timeoutFetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json', ...headers },
        fetchImpl: this.doFetch,
      });
      if (!res.ok) {
        dlog('[portfolio] non-200', String(res.status), url);
        return { body: null, status: res.status };
      }
      const raw = (await res.json()) as PortfolioResponse;
      return { body: clampFloors(raw), status: res.status };
    } catch (e) {
      dlog('[portfolio] fetch failed', String(e));
      return { body: null, status: 0 };
    }
  }
}
