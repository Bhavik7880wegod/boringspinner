import { describe, it, expect } from 'vitest';
import {
  PortfolioClient,
  clampFloors,
  isQuoteAd,
  ROTATION_INTERVAL_FLOOR_MS,
  TTL_CAP_MS,
  VIEW_THRESHOLD_FLOOR_MS,
  type PortfolioResponse,
  type PatchAd,
} from '../src/portfolio/client';

const demoResponse: PortfolioResponse = {
  ad: {
    adId: 'ad_demo_1',
    campaignId: 'cmp_demo',
    adText: 'Sponsored: Linear — fast issue tracking →',
    iconRef: 'linear',
    iconUrl: 'https://cdn.coads.ai/i/linear.png',
    clickUrl: 'https://linear.app',
    bannerEnabled: false,
    sessionToken: 'demo_tok_1',
    demo: true,
  },
  ads: [],
  queueId: 'q_demo',
  ttlMs: 60_000,
  rotationIntervalMs: 30_000,
  viewThresholdMs: 3000,
  balances: null,
};
demoResponse.ads = [demoResponse.ad!];

function client(opts: { signedIn: boolean; capture?: (url: string, headers: any) => void }) {
  const fetchImpl = (async (url: string, init: any) => {
    opts.capture?.(String(url), init.headers);
    return new Response(JSON.stringify(demoResponse), { status: 200 });
  }) as unknown as typeof fetch;
  return new PortfolioClient({
    backendBase: 'https://api.coads.ai',
    clientId: 'dvc_1',
    claudeCodeVersion: '2.1.150',
    getAccessToken: () => (opts.signedIn ? 'TOK' : null),
    fetchImpl,
  });
}

describe('PortfolioClient — demo fallback when signed out (§5.11)', () => {
  it('signed-out → GET /v1/portfolio/demo with client_id, no auth', async () => {
    let url = '';
    let headers: any = {};
    const c = client({ signedIn: false, capture: (u, h) => ((url = u), (headers = h)) });
    const res = await c.fetch();
    expect(url).toContain('/v1/portfolio/demo');
    expect(url).toContain('client_id=dvc_1');
    expect(headers?.Authorization).toBeUndefined();
    expect(res?.ad?.demo).toBe(true);
  });

  it('signed-in → GET /v1/portfolio (billable) with bearer', async () => {
    let url = '';
    let headers: any = {};
    const c = client({ signedIn: true, capture: (u, h) => ((url = u), (headers = h)) });
    await c.fetch();
    expect(url).toContain('/v1/portfolio?');
    expect(url).not.toContain('/demo');
    expect(headers?.Authorization).toBe('Bearer TOK');
  });
});

describe('PortfolioClient — §5.8 floor clamps', () => {
  it('clamps rotationIntervalMs up to 15s floor', () => {
    const r = clampFloors({ ...demoResponse, rotationIntervalMs: 1000 });
    expect(r.rotationIntervalMs).toBe(ROTATION_INTERVAL_FLOOR_MS);
  });
  it('clamps ttlMs down to the 1h cap', () => {
    const r = clampFloors({ ...demoResponse, ttlMs: 9_999_999 });
    expect(r.ttlMs).toBe(TTL_CAP_MS);
  });
  it('clamps viewThresholdMs up to the 1000ms floor', () => {
    const r = clampFloors({ ...demoResponse, viewThresholdMs: 100 });
    expect(r.viewThresholdMs).toBe(VIEW_THRESHOLD_FLOOR_MS);
  });
  it('leaves in-range values untouched', () => {
    const r = clampFloors({ ...demoResponse, rotationIntervalMs: 30_000, ttlMs: 60_000, viewThresholdMs: 3000 });
    expect(r.rotationIntervalMs).toBe(30_000);
    expect(r.ttlMs).toBe(60_000);
    expect(r.viewThresholdMs).toBe(3000);
  });
  it('fetch() applies the floor clamp to a server response', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ ...demoResponse, rotationIntervalMs: 1, ttlMs: 99_999_999, viewThresholdMs: 1 }), {
        status: 200,
      })) as unknown as typeof fetch;
    const c = new PortfolioClient({
      backendBase: 'https://api.coads.ai',
      clientId: 'd',
      claudeCodeVersion: 'x',
      getAccessToken: () => null,
      fetchImpl,
    });
    const res = await c.fetch();
    expect(res?.rotationIntervalMs).toBe(ROTATION_INTERVAL_FLOOR_MS);
    expect(res?.ttlMs).toBe(TTL_CAP_MS);
    expect(res?.viewThresholdMs).toBe(VIEW_THRESHOLD_FLOOR_MS);
  });
});

describe('clampFloors — over-cap "Thought of the Day" quote rows', () => {
  const quote = (text: string, author: string): PatchAd =>
    ({ adId: '', campaignId: '', adText: `${text} — ${author}`, iconRef: '', iconUrl: '', clickUrl: '', bannerEnabled: false, sessionToken: '', type: 'quote', text, author } as PatchAd);
  const quoteResponse: PortfolioResponse = {
    over_cap: true, ad: null, ads: [quote('Make something people want.', 'Paul Graham')],
    queueId: 'q_quote', ttlMs: 60_000, rotationIntervalMs: 60_000, viewThresholdMs: 1000, balances: null,
  };

  it('renders 💭 {text} — {author} and strips every billable field', () => {
    const r = clampFloors(quoteResponse);
    expect(r.over_cap).toBe(true);
    expect(isQuoteAd(r.ads[0])).toBe(true);
    expect(r.ads[0].adText).toBe('💭 Make something people want. — Paul Graham');
    expect(r.ads[0].adId).toBe('');
    expect(r.ads[0].sessionToken).toBe('');
    expect(r.ads[0].clickUrl).toBe('');
    expect(r.ad?.adText).toBe(r.ads[0].adText); // ad mirrors ads[0]
  });

  it('omits the “ — author” for contextual quotes (empty author)', () => {
    const r = clampFloors({ ...quoteResponse, ads: [quote('You earned today’s max.', '')] });
    expect(r.ads[0].adText).toBe('💭 You earned today’s max.');
  });

  it('leaves a normal paid ad untouched (no 💭, keeps its session token)', () => {
    const r = clampFloors(demoResponse);
    expect(isQuoteAd(r.ads[0])).toBe(false);
    expect(r.ads[0].adText).not.toContain('💭');
    expect(r.ads[0].sessionToken).toBe('demo_tok_1');
  });
});
