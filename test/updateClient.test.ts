import { describe, it, expect } from 'vitest';
import {
  UpdateClient,
  manifestUrl,
  type UpdateManifest,
} from '../src/update/client';

// §11 — self-update manifest poll + verify + COADS_LOCAL_VSIX dogfood bypass.
describe('manifestUrl (§7.2 / §11)', () => {
  it('builds the channel + from query against the update base', () => {
    const url = manifestUrl({
      updateBase: 'https://api.coads.ai/',
      currentVersion: '0.2.0',
    });
    expect(url).toBe(
      'https://api.coads.ai/v1/update/manifest?channel=stable&from=0.2.0',
    );
  });
});

describe('verifySha256', () => {
  it('matches the correct digest and rejects a wrong one', () => {
    const bytes = Buffer.from('hello coads');
    const correct = require('crypto')
      .createHash('sha256')
      .update(bytes)
      .digest('hex');
    expect(UpdateClient.verifySha256(bytes, correct)).toBe(true);
    expect(UpdateClient.verifySha256(bytes, 'deadbeef')).toBe(false);
  });
  it('treats empty expected hash as pass (local dogfood path)', () => {
    expect(UpdateClient.verifySha256(Buffer.from('x'), '')).toBe(true);
  });
});

describe('verifySignature (Phase-2 structured stub)', () => {
  it('accepts when no pubkey is baked in yet (Phase 2) and never throws', () => {
    expect(UpdateClient.verifySignature(Buffer.from('x'), 'whatever')).toBe(true);
  });
});

describe('checkForUpdate — COADS_LOCAL_VSIX bypass (§11)', () => {
  it('synthesizes an available manifest pointing at the local file', async () => {
    const client = new UpdateClient({
      updateBase: 'https://api.coads.ai',
      currentVersion: '0.2.0',
      localVsixPath: '/tmp/coads-dogfood.vsix',
      fetchImpl: (async () => {
        throw new Error('fetch must NOT be called on the dogfood path');
      }) as unknown as typeof fetch,
    });
    const m = await client.checkForUpdate();
    expect(m).not.toBeNull();
    expect((m as UpdateManifest).downloadUrl).toBe('/tmp/coads-dogfood.vsix');
    expect((m as UpdateManifest).available).toBe(true);
  });
});

describe('checkForUpdate — manifest fetch', () => {
  it('returns the manifest when available:true', async () => {
    const fake: UpdateManifest = {
      available: true,
      version: '0.2.1',
      downloadUrl: 'https://api.coads.ai/v1/update/download/0.2.1',
      sha256: 'abc',
      signature: 'sig',
    };
    const client = new UpdateClient({
      updateBase: 'https://api.coads.ai',
      currentVersion: '0.2.0',
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => fake,
      })) as unknown as typeof fetch,
    });
    expect(await client.checkForUpdate()).toEqual(fake);
  });

  it('returns null when available:false', async () => {
    const client = new UpdateClient({
      updateBase: 'https://api.coads.ai',
      currentVersion: '0.2.0',
      fetchImpl: (async () => ({
        ok: true,
        status: 200,
        json: async () => ({ available: false }),
      })) as unknown as typeof fetch,
    });
    expect(await client.checkForUpdate()).toBeNull();
  });

  it('returns null on a non-200 (does not throw)', async () => {
    const client = new UpdateClient({
      updateBase: 'https://api.coads.ai',
      currentVersion: '0.2.0',
      fetchImpl: (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch,
    });
    expect(await client.checkForUpdate()).toBeNull();
  });
});
