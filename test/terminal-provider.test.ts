import { describe, it, expect } from 'vitest';
import { createTerminalAdProvider } from '../src/adapters/claude-terminal/provider';
import type { MetricInput } from '../src/metrics/client';
import type { PatchAd } from '../src/portfolio/client';

const AD: PatchAd = {
  adId: 'ad_term1',
  campaignId: 'cmp_term',
  adText: 'Sponsored: Neon — serverless Postgres →',
  iconRef: 'neon',
  iconUrl: 'https://cdn.boringspinner.com/i/neon.png',
  clickUrl: 'https://neon.tech',
  bannerEnabled: false,
  sessionToken: 'tok_sess_term',
};

// A metrics sink that records every MetricInput instead of hitting the network
// (mirrors the repo's "no real network" test posture). The provider drives the
// REAL metrics pipeline shape; only the transport is captured.
function recorder() {
  const sent: MetricInput[] = [];
  const metrics = { send: async (input: MetricInput) => { sent.push(input); return true; } };
  return { metrics, sent };
}

function provider(over: Partial<Parameters<typeof createTerminalAdProvider>[0]> = {}) {
  const rec = recorder();
  const opened: string[] = [];
  const p = createTerminalAdProvider({
    getAd: () => AD,
    metrics: rec.metrics,
    openExternal: (url: string) => { opened.push(url); },
    rand: () => 'r4nd', // deterministic corr
    ...over,
  });
  return { p, sent: rec.sent, opened };
}

const SPINNER_CTX = { terminal: { name: 'claude' }, line: '✻ Cogitating… (esc to interrupt)' };

describe('terminal ad provider — provideTerminalLinks', () => {
  it('posts an impression and returns a link whose tooltip is the ad copy', () => {
    const { p, sent } = provider();
    const links = p.provideTerminalLinks(SPINNER_CTX);

    expect(links).toHaveLength(1);
    expect(links[0].tooltip).toContain(AD.adText);
    expect(links[0].startIndex).toBeGreaterThanOrEqual(0);
    expect(links[0].length).toBeGreaterThan(0);

    // An impression event was posted through the metrics pipeline for this ad,
    // on the reused claude-cli-spinner surface, with sessionNonce = ad.sessionToken.
    const imp = sent.find((e) => e.event === 'impression_rendered');
    expect(imp, 'an impression should be posted').toBeTruthy();
    expect(imp!.adId).toBe(AD.adId);
    expect(imp!.surface).toBe('claude-cli-spinner');
    expect(imp!.sessionNonce).toBe(AD.sessionToken);
    expect(links[0].data.sessionNonce).toBe(AD.sessionToken);
  });

  it('returns no link (and posts nothing) for ordinary terminal output', () => {
    const { p, sent } = provider();
    const links = p.provideTerminalLinks({ terminal: { name: 'claude' }, line: 'npm run build' });
    expect(links).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it('does not double-count impressions across repeated scans of the same ad session', () => {
    const { p, sent } = provider();
    p.provideTerminalLinks(SPINNER_CTX);
    p.provideTerminalLinks(SPINNER_CTX);
    p.provideTerminalLinks(SPINNER_CTX);
    expect(sent.filter((e) => e.event === 'impression_rendered')).toHaveLength(1);
  });
});

describe('terminal ad provider — handleTerminalLink', () => {
  it('posts a billable click carrying the SAME nonce as the impression, and opens the destination', async () => {
    const { p, sent, opened } = provider();
    const [link] = p.provideTerminalLinks(SPINNER_CTX);
    const imp = sent.find((e) => e.event === 'impression_rendered')!;

    p.handleTerminalLink(link);

    const click = sent.find((e) => e.event === 'click');
    expect(click, 'a click event should be posted').toBeTruthy();
    expect(click!.adId).toBe(AD.adId);
    expect(click!.surface).toBe('claude-cli-spinner');
    // Click ties back to the impression: identical session nonce + correlation id.
    expect(click!.sessionNonce).toBe(imp.sessionNonce);
    expect(click!.corr).toBe(imp.corr);
    // And the advertiser destination is opened.
    expect(opened).toEqual([AD.clickUrl]);
  });
});
