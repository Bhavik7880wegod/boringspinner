import { describe, it, expect } from 'vitest';
import { PortfolioClient } from '../src/portfolio/client';

function res(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const REAL = {
  ad: null,
  ads: [
    {
      adId: 'ad_1',
      campaignId: 'cmp_1',
      adText: 'Automate Job Applications',
      iconRef: '',
      iconUrl: '',
      clickUrl: 'https://autojobsai.com',
      bannerEnabled: false,
      sessionToken: 'st',
    },
  ],
  queueId: 'q',
  ttlMs: 60_000,
  rotationIntervalMs: 60_000,
  viewThresholdMs: 3_000,
  balances: null,
};

describe('PortfolioClient refresh-on-401 (§10.1 token recovery)', () => {
  it('refreshes an expired access token on 401, retries, and serves the REAL portfolio', async () => {
    let token = 'expired';
    let calls = 0;
    const client = new PortfolioClient({
      backendBase: 'https://api.test',
      clientId: 'cid',
      claudeCodeVersion: '2.1.177',
      getAccessToken: () => token,
      refresh: async () => {
        token = 'fresh';
        return true;
      },
      fetchImpl: (async (_url: string, init: { headers?: Record<string, string> }) => {
        calls++;
        return init.headers?.Authorization === 'Bearer fresh' ? res(200, REAL) : res(401, {});
      }) as unknown as typeof fetch,
    });

    const out = await client.fetch();
    expect(out?.ads[0]?.adText).toBe('Automate Job Applications');
    expect(calls).toBe(2); // 401, then a retry that 200s with the refreshed token
  });

  it('returns null (no infinite retry) when refresh fails', async () => {
    let calls = 0;
    const client = new PortfolioClient({
      backendBase: 'https://api.test',
      clientId: 'cid',
      claudeCodeVersion: '2.1.177',
      getAccessToken: () => 'expired',
      refresh: async () => false,
      fetchImpl: (async () => {
        calls++;
        return res(401, {});
      }) as unknown as typeof fetch,
    });

    expect(await client.fetch()).toBeNull();
    expect(calls).toBe(1); // one attempt; refresh failed so no retry
  });
});
