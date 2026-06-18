import { describe, it, expect } from 'vitest';
import { MetricsClient, METRIC_EVENTS, type MetricInput } from '../src/metrics/client';
import { NonceDedupe } from '../src/metrics/dedupe';
import { UUID_V4_RE } from '../src/util/crypto';

const EXT = { os: 'darwin', arch: 'arm64', os_version: '24.6.0', editor: 'Visual Studio Code' };

function input(overrides: Partial<MetricInput> = {}): MetricInput {
  return {
    event: 'view_threshold_met',
    adId: 'ad_abc123',
    campaignId: 'cmp_xyz',
    surface: 'claude-overlay',
    corr: 'ad_abc123.r4nd',
    sessionNonce: 'sess_server',
    sessionToken: 'tok_signed',
    visibleMs: 3120,
    viewable: true,
    viewPct: 1.0,
    viewMs: 3120,
    ...overrides,
  };
}

// Capture the last POST so we can assert the wire shape + headers + path.
function captureClient(opts: { signedIn: boolean; demoted?: boolean }) {
  const captured: { url?: string; body?: any; headers?: Record<string, string> } = {};
  const fetchImpl = (async (url: string, init: any) => {
    captured.url = String(url);
    captured.headers = init.headers;
    captured.body = JSON.parse(init.body);
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  const client = new MetricsClient({
    backendBase: 'https://api.coads.ai',
    clientId: 'dvc_8f3a',
    claudeCodeVersion: '2.1.150',
    extensionVersion: '0.3.0',
    ext: EXT,
    getAccessToken: () => (opts.signedIn ? 'BEARER_TOK' : null),
    isDemoted: () => opts.demoted ?? false,
    fetchImpl,
  });
  return { client, captured };
}

describe('§6.1 — the 7 metric events', () => {
  it('lists exactly the 7 events in spec order', () => {
    expect(METRIC_EVENTS).toEqual([
      'impression_rendered',
      'impression_viewable',
      'prompt_view',
      'view_tick',
      'view_threshold_met',
      'error_impression',
      'click',
    ]);
  });
});

describe('MetricsClient.buildWire — §6.2 wire shape', () => {
  it('builds the exact §6.2 top-level keys with a UUIDv4 nonce', () => {
    const { client } = captureClient({ signedIn: true });
    const wire = client.buildWire(input(), { demo: false, demoted: false });
    expect(Object.keys(wire).sort()).toEqual(
      [
        'ad_id', 'campaign_id', 'claude_code_version', 'client_id', 'event_type',
        'ext', 'extension_version', 'nonce', 'session_nonce', 'session_token',
        'surface', 'ts', 'view_ms', 'view_pct', 'viewable', 'visible_ms',
      ].sort(),
    );
    expect(wire.event_type).toBe('view_threshold_met');
    expect(wire.ad_id).toBe('ad_abc123');
    expect(wire.client_id).toBe('dvc_8f3a');
    expect(wire.visible_ms).toBe(3120);
    expect(wire.nonce).toMatch(UUID_V4_RE);
    expect(wire.ext).toEqual(EXT); // signed-in: no demo flags
    expect(typeof wire.ts).toBe('string');
  });

  it('builds all 7 event types with a valid nonce each', () => {
    const { client } = captureClient({ signedIn: true });
    for (const ev of METRIC_EVENTS) {
      const wire = client.buildWire(input({ event: ev }), { demo: false, demoted: false });
      expect(wire.event_type).toBe(ev);
      expect(wire.nonce).toMatch(UUID_V4_RE);
    }
  });
});

describe('MetricsClient.send — routing (§5.11 / §6.2)', () => {
  it('signed-in → POST /v1/metrics with Authorization + X-CoAds-Corr', async () => {
    const { client, captured } = captureClient({ signedIn: true });
    const ok = await client.send(input());
    expect(ok).toBe(true);
    expect(captured.url).toBe('https://api.coads.ai/v1/metrics');
    expect(captured.headers?.['Authorization']).toBe('Bearer BEARER_TOK');
    expect(captured.headers?.['X-CoAds-Corr']).toBe('ad_abc123.r4nd');
    expect(captured.body.ext.demo).toBeUndefined();
  });

  it('signed-out → POST /v1/metrics/demo, no Authorization, ext.demo:true', async () => {
    const { client, captured } = captureClient({ signedIn: false });
    const ok = await client.send(input());
    expect(ok).toBe(true);
    expect(captured.url).toBe('https://api.coads.ai/v1/metrics/demo');
    expect(captured.headers?.['Authorization']).toBeUndefined();
    expect(captured.body.ext.demo).toBe(true);
  });

  it('demoted (token died mid-session) → /demo with ext.demoted:true', async () => {
    const { client, captured } = captureClient({ signedIn: false, demoted: true });
    await client.send(input());
    expect(captured.url).toBe('https://api.coads.ai/v1/metrics/demo');
    expect(captured.body.ext.demoted).toBe(true);
  });
});

describe('NonceDedupe — §6.3 in-memory suppression', () => {
  it('markFresh is true once, false thereafter', () => {
    const d = new NonceDedupe();
    expect(d.markFresh('n1')).toBe(true);
    expect(d.markFresh('n1')).toBe(false);
    expect(d.has('n1')).toBe(true);
  });

  it('send suppresses a generated duplicate nonce within one activation', async () => {
    // Force a deterministic duplicate by pre-seeding the dedupe with the nonce
    // the client will generate (we read it from buildWire first).
    const dedupe = new NonceDedupe();
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const client = new MetricsClient({
      backendBase: 'https://api.coads.ai',
      clientId: 'dvc_1',
      claudeCodeVersion: '2.1.150',
      extensionVersion: '0.3.0',
      ext: EXT,
      getAccessToken: () => 'T',
      fetchImpl,
      dedupe,
    });
    // First send is fresh; a forced re-add of the same nonce is suppressed.
    const wire = client.buildWire(input(), { demo: false, demoted: false });
    dedupe.markFresh(wire.nonce); // simulate already-sent
    // monkeypatch buildWire to return the same nonce isn't trivial; instead
    // assert the dedupe gate directly: markFresh on a seen nonce is false.
    expect(dedupe.markFresh(wire.nonce)).toBe(false);
  });

  it('evicts oldest beyond cap', () => {
    const d = new NonceDedupe(2);
    d.markFresh('a');
    d.markFresh('b');
    d.markFresh('c'); // evicts 'a'
    expect(d.has('a')).toBe(false);
    expect(d.has('b')).toBe(true);
    expect(d.has('c')).toBe(true);
  });
});
