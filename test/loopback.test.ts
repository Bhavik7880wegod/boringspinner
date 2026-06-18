import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startLoopback, type LoopbackServer } from '../src/loopback';

let server: LoopbackServer | null = null;
afterEach(async () => {
  if (server) await server.close();
  server = null;
});

describe('loopback HTTP server (§5.9)', () => {
  it('binds 127.0.0.1 on a random free port and exposes the base url', async () => {
    server = await startLoopback({ token: 'tok' });
    expect(server.port).toBeGreaterThan(0);
    expect(server.baseUrl).toBe(`http://127.0.0.1:${server.port}`);
  });

  it('POST /coads/<token>/click → 204 and fires onClick with parsed query', async () => {
    let got: URLSearchParams | null = null;
    server = await startLoopback({ token: 'secret', onClick: (q) => (got = q) });
    const res = await fetch(`${server.baseUrl}/coads/secret/click?corr=ad_1.r&ad=ad_1&surface=claude-overlay`, {
      method: 'POST',
    });
    expect(res.status).toBe(204);
    expect(got).not.toBeNull();
    expect(got!.get('corr')).toBe('ad_1.r');
    expect(got!.get('ad')).toBe('ad_1');
    expect(got!.get('surface')).toBe('claude-overlay');
  });

  it('wrong token → 404 (path token guards both routes)', async () => {
    let clicked = false;
    server = await startLoopback({ token: 'right', onClick: () => (clicked = true) });
    const res = await fetch(`${server.baseUrl}/coads/wrong/click`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(clicked).toBe(false);
  });

  it('GET on the click route → 404 (POST only)', async () => {
    server = await startLoopback({ token: 't' });
    const res = await fetch(`${server.baseUrl}/coads/t/click`);
    expect(res.status).toBe(404);
  });

  it('POST /coads/<token>/log → 204 and appends a line to the debug log', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coads-lb-'));
    const logPath = path.join(dir, 'debug.log');
    server = await startLoopback({ token: 't', debugLogPath: logPath });
    const res = await fetch(`${server.baseUrl}/coads/t/log?ev=impression_rendered&ad=ad_1`, {
      method: 'POST',
    });
    expect(res.status).toBe(204);
    // give the append a tick
    await new Promise((r) => setTimeout(r, 20));
    const contents = fs.readFileSync(logPath, 'utf8');
    expect(contents).toContain('ev=impression_rendered');
    expect(contents).toContain('ad=ad_1');
  });

  it('GET /coads/<token>/ads → 200 JSON with the current queue (CORS-readable)', async () => {
    const ads = [{ adId: 'ad_1', adText: 'Hi', clickUrl: 'https://x', iconUrl: '', corr: 'ad_1.r' }];
    server = await startLoopback({ token: 't', getAds: () => ads });
    const res = await fetch(`${server.baseUrl}/coads/t/ads`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as { ads: typeof ads };
    expect(body.ads).toEqual(ads); // live overlay refresh reads this
  });

  it('GET /ads with the wrong token → 404 (token-gated)', async () => {
    server = await startLoopback({ token: 'right', getAds: () => [{ adId: 'x' }] });
    const res = await fetch(`${server.baseUrl}/coads/wrong/ads`);
    expect(res.status).toBe(404);
  });

  it('OPTIONS preflight → 204 with permissive CORS', async () => {
    server = await startLoopback({ token: 't' });
    const res = await fetch(`${server.baseUrl}/coads/t/click`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });
});
