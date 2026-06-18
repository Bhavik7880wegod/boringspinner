import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AuthClient } from '../src/auth/client';
import { SecretVault, plaintextSeal, type TokenBundle } from '../src/auth/vault';

// SAFETY: temp-dir vault + plaintext seal. No real network — fetch is injected.
let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coads-auth-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function newVault() {
  return new SecretVault({ root: tmpDir, seal: plaintextSeal });
}

const tokens: TokenBundle = { access: 'a0', refresh: 'r0', email: 'u@x.io' };

// Seed a vault with tokens so refresh() has something to rotate.
async function signedInClient(fetchImpl: typeof fetch) {
  const vault = newVault();
  await vault.store(tokens);
  const auth = new AuthClient({
    backendBase: 'https://api.coads.ai',
    vault,
    open: () => {},
    fetchImpl,
    sleep: async () => {},
  });
  await auth.loadCached();
  return { auth, vault };
}

const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('AuthClient — single-flight refresh (§10.1 S1)', () => {
  it('coalesces 2 concurrent refresh() calls into ONE network request', async () => {
    let calls = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/v1/auth/refresh')) {
        calls += 1;
        // Slow response so the second caller arrives while the first is in flight.
        await new Promise((r) => setTimeout(r, 20));
        return jsonRes({ access: 'a1', refresh: 'r1', email: 'u@x.io' });
      }
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;

    const { auth } = await signedInClient(fetchImpl);
    const [r1, r2] = await Promise.all([auth.refresh(), auth.refresh()]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(calls).toBe(1); // single-flight: exactly one request
    expect(auth.getAccessToken()).toBe('a1');
  });
});

describe('AuthClient — transient vs fatal refresh (§10.1)', () => {
  it('5xx is TRANSIENT: keeps the token', async () => {
    const fetchImpl = (async () => jsonRes({ error: 'boom' }, 503)) as unknown as typeof fetch;
    const { auth } = await signedInClient(fetchImpl);
    const ok = await auth.refresh();
    expect(ok).toBe(false);
    expect(auth.isSignedIn()).toBe(true); // token kept
    expect(auth.getAccessToken()).toBe('a0');
  });

  it('network error is TRANSIENT: keeps the token', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const { auth } = await signedInClient(fetchImpl);
    const ok = await auth.refresh();
    expect(ok).toBe(false);
    expect(auth.isSignedIn()).toBe(true);
  });

  it('explicit 401 is FATAL: clears the token + demotes (vault wiped)', async () => {
    const fetchImpl = (async () => jsonRes({ error: 'invalid_grant' }, 401)) as unknown as typeof fetch;
    const { auth, vault } = await signedInClient(fetchImpl);
    const ok = await auth.refresh();
    expect(ok).toBe(false);
    expect(auth.isSignedIn()).toBe(false); // cleared
    expect(auth.getAccessToken()).toBeNull();
    expect(await vault.load()).toBeNull(); // demoted: vault wiped
  });
});

describe('AuthClient — device flow poll (§10.1)', () => {
  it('start → poll pending → ready persists tokens + fires onSignedIn', async () => {
    let pollCount = 0;
    let signedInEmail = '';
    const fetchImpl = (async (url: string) => {
      const u = String(url);
      if (u.includes('/v1/auth/start')) {
        return jsonRes({ url: 'https://accounts.google.com/...', state: 'st_1', pollMs: 5 });
      }
      if (u.includes('/v1/auth/poll')) {
        pollCount += 1;
        if (pollCount < 3) return jsonRes({ status: 'pending' });
        return jsonRes({ access: 'A', refresh: 'R', email: 'dev@coads.ai' });
      }
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;

    const vault = newVault();
    let opened = '';
    const auth = new AuthClient({
      backendBase: 'https://api.coads.ai',
      vault,
      open: (url) => void (opened = url),
      fetchImpl,
      sleep: async () => {},
      onSignedIn: (e) => (signedInEmail = e),
    });

    const ok = await auth.signIn();
    expect(ok).toBe(true);
    expect(opened).toContain('accounts.google.com');
    expect(pollCount).toBe(3); // polled past two pending responses
    expect(auth.getEmail()).toBe('dev@coads.ai');
    expect(signedInEmail).toBe('dev@coads.ai');
    // Tokens persisted to the temp-dir vault.
    expect((await vault.load())?.access).toBe('A');
  });

  it('poll times out → returns false (no tokens)', async () => {
    const fetchImpl = (async () => jsonRes({ status: 'pending' })) as unknown as typeof fetch;
    const vault = newVault();
    const auth = new AuthClient({
      backendBase: 'https://api.coads.ai',
      vault,
      open: () => {},
      fetchImpl,
      sleep: async () => {},
      pollTimeoutMs: 1, // immediate timeout
    });
    const ok = await auth.poll('st_x', 0);
    expect(ok).toBe(false);
    expect(auth.isSignedIn()).toBe(false);
  });

  // The interactive terminal login (cli.ts) passes a SHORT per-call timeoutMs so
  // each "press Enter to refresh" does ONE bounded check — Srijan's fix.
  it('poll(timeoutMs) honors a short per-call window and succeeds when ready in-window', async () => {
    let polls = 0;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/v1/auth/poll')) {
        polls += 1;
        return jsonRes({ access: 'A', refresh: 'R', email: 'srijan@x.io' });
      }
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const auth = new AuthClient({
      backendBase: 'https://api.coads.ai',
      vault: newVault(),
      open: () => {},
      fetchImpl,
      sleep: async () => {},
      pollTimeoutMs: 180_000, // big device-flow default…
    });
    const ok = await auth.poll('st', 0, 8_000); // …but a short per-Enter window
    expect(ok).toBe(true);
    expect(polls).toBe(1);
    expect(auth.getEmail()).toBe('srijan@x.io');
  });

  it('poll(timeoutMs) is BOUNDED by the per-call window, not the 180s default', async () => {
    const fetchImpl = (async () => jsonRes({ status: 'pending' })) as unknown as typeof fetch;
    const auth = new AuthClient({
      backendBase: 'https://api.coads.ai',
      vault: newVault(),
      open: () => {},
      fetchImpl,
      sleep: async (ms) => new Promise((r) => setTimeout(r, ms)),
      pollTimeoutMs: 180_000, // would block 3 min if the override were ignored
    });
    const t0 = Date.now();
    const ok = await auth.poll('st', 2, 30); // bounded ~30ms
    expect(ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2_000); // proves the 180s default was NOT used
  });
});

describe('AuthClient — revoke (§5.5 sign-out)', () => {
  it('POSTs revoke then clears every storage location', async () => {
    let revoked = false;
    const fetchImpl = (async (url: string) => {
      if (String(url).includes('/v1/auth/revoke')) {
        revoked = true;
        return jsonRes({ ok: true });
      }
      return jsonRes({}, 404);
    }) as unknown as typeof fetch;
    const { auth, vault } = await signedInClient(fetchImpl);
    await auth.revoke();
    expect(revoked).toBe(true);
    expect(auth.isSignedIn()).toBe(false);
    expect(await vault.load()).toBeNull();
  });
});
