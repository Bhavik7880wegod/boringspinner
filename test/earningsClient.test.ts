import { describe, it, expect } from 'vitest';
import { EarningsClient, activeStatusText } from '../src/earnings/client';

describe('activeStatusText — §5.4 Active state', () => {
  it('renders BoringSpinner ($X today · $Y)', () => {
    expect(activeStatusText('0.42', '7.11')).toBe('BoringSpinner ($0.42 today · $7.11)');
  });
});

describe('EarningsClient — §7.2 GET /v1/earnings', () => {
  it('signed-in → sends client_id, fetches summary, produces the Active status text', async () => {
    let url = '';
    let auth = '';
    const fetchImpl = (async (u: string, init: any) => {
      url = String(u);
      auth = init.headers?.Authorization;
      return new Response(JSON.stringify({ today: '0.42', month: '3.10', lifetime: '7.11' }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const c = new EarningsClient({
      backendBase: 'https://api.coads.ai',
      clientId: 'dvc_abc',
      getAccessToken: () => 'TOK',
      fetchImpl,
    });
    const text = await c.activeText('2026-06-12T00:00:00Z');
    expect(url).toContain('/v1/earnings?');
    expect(url).toContain('client_id=dvc_abc'); // reads publisherAccount(device) where credits land
    expect(url).toContain('since=');
    expect(auth).toBe('Bearer TOK');
    expect(text).toBe('BoringSpinner ($0.42 today · $7.11)');
  });

  it('signed-out → returns null (earnings are authed-only)', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const c = new EarningsClient({
      backendBase: 'https://api.coads.ai',
      clientId: 'dvc_abc',
      getAccessToken: () => null,
      fetchImpl,
    });
    expect(await c.fetch()).toBeNull();
    expect(await c.activeText()).toBeNull();
  });

  it('non-200 → null (never throws)', async () => {
    const fetchImpl = (async () => new Response('err', { status: 500 })) as unknown as typeof fetch;
    const c = new EarningsClient({
      backendBase: 'https://api.coads.ai',
      clientId: 'dvc_abc',
      getAccessToken: () => 'T',
      fetchImpl,
    });
    expect(await c.fetch()).toBeNull();
  });

  it('401 → refreshes the token, retries, and returns the balance (status bar shows real $)', async () => {
    let token = 'expired';
    let calls = 0;
    const c = new EarningsClient({
      backendBase: 'https://api.coads.ai',
      clientId: 'dvc_abc',
      getAccessToken: () => token,
      refresh: async () => {
        token = 'fresh';
        return true;
      },
      fetchImpl: (async (_u: string, init: any) => {
        calls++;
        return init.headers?.Authorization === 'Bearer fresh'
          ? new Response(JSON.stringify({ today: '0.10', month: '0.10', lifetime: '0.10' }), {
              status: 200,
            })
          : new Response('', { status: 401 });
      }) as unknown as typeof fetch,
    });
    expect(await c.activeText()).toBe('BoringSpinner ($0.10 today · $0.10)');
    expect(calls).toBe(2); // 401, then a retry that 200s with the refreshed token
  });

  it('401 with no refresh available → null (no retry)', async () => {
    let calls = 0;
    const c = new EarningsClient({
      backendBase: 'https://api.coads.ai',
      clientId: 'dvc_abc',
      getAccessToken: () => 'expired',
      fetchImpl: (async () => {
        calls++;
        return new Response('', { status: 401 });
      }) as unknown as typeof fetch,
    });
    expect(await c.fetch()).toBeNull();
    expect(calls).toBe(1);
  });
});
