import { describe, it, expect } from 'vitest';
import { MetricsClient, type MetricInput } from '../src/metrics/client';

function res(status: number): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => ({}) } as unknown as Response;
}

const INPUT: MetricInput = {
  event: 'view_threshold_met', // the billable event
  adId: 'ad_1',
  campaignId: 'cmp_1',
  surface: 'claude-overlay',
  corr: 'ad_1.abc',
  sessionNonce: 'sn',
  sessionToken: 'st',
};

const EXT = { os: 'darwin', arch: 'arm64', os_version: '24.0', editor: 'Visual Studio Code' };

function mk(overrides: Partial<ConstructorParameters<typeof MetricsClient>[0]>) {
  return new MetricsClient({
    backendBase: 'https://api.test',
    clientId: 'cid',
    claudeCodeVersion: '2.1.177',
    extensionVersion: '0.3.1',
    ext: EXT,
    getAccessToken: () => null,
    ...overrides,
  });
}

describe('MetricsClient refresh-on-401 (§10.1 billable-event recovery)', () => {
  it('refreshes an expired access token on 401, retries, and records the event', async () => {
    let token = 'expired';
    let calls = 0;
    const client = mk({
      getAccessToken: () => token,
      refresh: async () => {
        token = 'fresh';
        return true;
      },
      fetchImpl: (async (_url: string, init: { headers?: Record<string, string> }) => {
        calls++;
        return init.headers?.Authorization === 'Bearer fresh' ? res(200) : res(401);
      }) as unknown as typeof fetch,
    });

    expect(await client.send(INPUT)).toBe(true);
    expect(calls).toBe(2); // 401, then a retry that 2xxs with the refreshed token
  });

  it('drops the event (no infinite retry) when refresh fails', async () => {
    let calls = 0;
    const client = mk({
      getAccessToken: () => 'expired',
      refresh: async () => false,
      fetchImpl: (async () => {
        calls++;
        return res(401);
      }) as unknown as typeof fetch,
    });

    expect(await client.send(INPUT)).toBe(false);
    expect(calls).toBe(1); // one attempt; refresh failed so no retry
  });

  it('does not retry a 2xx (no wasted refresh on the happy path)', async () => {
    let refreshed = 0;
    let calls = 0;
    const client = mk({
      getAccessToken: () => 'good',
      refresh: async () => {
        refreshed++;
        return true;
      },
      fetchImpl: (async () => {
        calls++;
        return res(200);
      }) as unknown as typeof fetch,
    });

    expect(await client.send(INPUT)).toBe(true);
    expect(calls).toBe(1);
    expect(refreshed).toBe(0);
  });
});
