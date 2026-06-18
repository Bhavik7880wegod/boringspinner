import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SecretVault,
  detectScheme,
  plaintextSeal,
  type SealProvider,
  type SecretStore,
  type TokenBundle,
} from '../src/auth/vault';

// SAFETY: all tests use a TEMP dir as the vault root and the plaintext/file seal
// — never the real ~/.coads/ and never the macOS Keychain.
let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coads-vault-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const bundle: TokenBundle = { access: 'acc_1', refresh: 'ref_1', email: 'a@b.co' };

// A reversible XOR-ish stand-in seal — proves seal/unseal roundtrip WITHOUT the
// real platform keychain (rule 5).
const reversibleSeal: SealProvider = {
  scheme: 'file',
  seal: (p) => Buffer.from(p, 'utf8').toString('base64'),
  unseal: (s) => Buffer.from(s, 'base64').toString('utf8'),
};

describe('detectScheme — §10.1 platform mapping', () => {
  it('maps each platform to its scheme verbatim', () => {
    expect(detectScheme('darwin')).toBe('Keychain');
    expect(detectScheme('win32')).toBe('DPAPI');
    expect(detectScheme('linux')).toBe('libsecret');
    expect(detectScheme('freebsd')).toBe('file');
  });
});

describe('SecretVault — file + plaintext floor (temp dir, no keychain)', () => {
  it('store→load roundtrips the bundle via the file floor', async () => {
    const v = new SecretVault({ root: tmpDir, seal: plaintextSeal });
    await v.store(bundle);
    // File exists and is 0600.
    const authPath = path.join(tmpDir, 'auth.json');
    expect(fs.existsSync(authPath)).toBe(true);
    const mode = fs.statSync(authPath).mode & 0o777;
    expect(mode).toBe(0o600);
    const loaded = await v.load();
    expect(loaded).toEqual(bundle);
  });

  it('seals the refresh token on disk and unseals on load', async () => {
    const v = new SecretVault({ root: tmpDir, seal: reversibleSeal });
    await v.store(bundle);
    const raw = fs.readFileSync(path.join(tmpDir, 'auth.json'), 'utf8');
    // The refresh token is NOT on disk in plaintext (it's sealed).
    expect(raw).not.toContain('ref_1');
    expect(raw).toContain(Buffer.from('ref_1').toString('base64'));
    const loaded = await v.load();
    expect(loaded?.refresh).toBe('ref_1'); // unsealed correctly
  });

  it('exposes the active scheme for BoringSpinner: Show status', () => {
    const v = new SecretVault({ root: tmpDir, seal: plaintextSeal });
    expect(v.scheme).toBe('file');
  });

  it('warns when the plaintext floor is used on store', async () => {
    let warned = false;
    const v = new SecretVault({ root: tmpDir, seal: plaintextSeal, onPlaintextWarn: () => (warned = true) });
    await v.store(bundle);
    expect(warned).toBe(true);
  });

  it('clear() removes the on-disk file', async () => {
    const v = new SecretVault({ root: tmpDir, seal: plaintextSeal });
    await v.store(bundle);
    await v.clear();
    expect(fs.existsSync(path.join(tmpDir, 'auth.json'))).toBe(false);
    expect(await v.load()).toBeNull();
  });

  it('load returns null when nothing is stored', async () => {
    const v = new SecretVault({ root: tmpDir, seal: plaintextSeal });
    expect(await v.load()).toBeNull();
  });
});

describe('SecretVault — Layer 1 (injected SecretStore) preferred over file', () => {
  it('loads from SecretStore first (keychain → file fallback, §5.6 step 11)', async () => {
    const store = new Map<string, string>();
    const secretStore: SecretStore = {
      get: async (k) => store.get(k),
      store: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
    };
    const v = new SecretVault({ root: tmpDir, secretStore, seal: plaintextSeal });
    await v.store(bundle);
    // Corrupt the file floor; Layer 1 must still satisfy load().
    fs.writeFileSync(path.join(tmpDir, 'auth.json'), 'not json', 'utf8');
    const loaded = await v.load();
    expect(loaded).toEqual(bundle);
  });

  it('falls back to the file floor when Layer 1 is empty', async () => {
    const secretStore: SecretStore = {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    };
    const v = new SecretVault({ root: tmpDir, secretStore, seal: plaintextSeal });
    await v.store(bundle);
    const loaded = await v.load();
    expect(loaded).toEqual(bundle); // came from the file floor
  });
});
