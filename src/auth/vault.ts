// src/auth/vault.ts — SecretVault: layered token storage (§10.1).
//
// Layer 1: VS Code ctx.secrets (SecretStorage) — fast cache, injected so it's
//          testable. Holds the whole token bundle (access + refresh + email).
// Layer 2: <root>/auth.json (chmod 0600) — universal floor. The refresh token is
//          SEALED by the platform vault before it lands on disk:
//            macOS   → `security` (Keychain)
//            Windows → DPAPI (CryptProtectData)
//            Linux   → `secret-tool` (libsecret)
//            floor   → plaintext (logged; status bar warns)
//
// SAFETY: the storage ROOT is a constructor param so tests use a temp dir and
// the `seal`/`unseal` functions are injectable so automated runs exercise ONLY
// the file + plaintext layers — never the real Keychain or real ~/.coads/.

import * as fs from 'fs';
import * as path from 'path';

// The platform seal scheme surfaced to `BoringSpinner: Show status` (§5.5).
export type VaultScheme = 'Keychain' | 'DPAPI' | 'libsecret' | 'file';

// The token bundle the auth flow stores (§10.1 / §7.2 poll response).
export interface TokenBundle {
  access: string;
  refresh: string;
  email: string;
}

// Optional VS Code SecretStorage shape (Layer 1). Injected — never imported
// from `vscode` here so the module loads under vitest without the host.
export interface SecretStore {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

// A platform seal: protect/unprotect a refresh token at rest. Injectable so
// tests run the plaintext floor without touching the OS keychain.
export interface SealProvider {
  scheme: VaultScheme;
  seal(plaintext: string): string;   // returns the on-disk representation
  unseal(sealed: string): string;    // reverses seal()
}

const SECRET_KEY = 'coads.tokens'; // Layer-1 SecretStorage key
const AUTH_FILE = 'auth.json'; // Layer-2 file name under the vault root

// On-disk Layer-2 shape. The refresh token is sealed; access/email are plain
// (access is short-lived; email is non-secret) so a cold start can show state.
interface AuthFile {
  scheme: VaultScheme;
  access: string;
  email: string;
  refreshSealed: string;
}

// Detect the platform seal scheme by capability (§10.1). The actual seal/unseal
// commands are only run lazily, never at detection time.
export function detectScheme(platform: string = process.platform): VaultScheme {
  if (platform === 'darwin') return 'Keychain';
  if (platform === 'win32') return 'DPAPI';
  if (platform === 'linux') return 'libsecret';
  return 'file';
}

// The plaintext floor (§10.1 "last resort"). Marked `file` scheme; the caller
// logs + warns in the status bar when this is the active scheme.
export const plaintextSeal: SealProvider = {
  scheme: 'file',
  seal: (p) => p,
  unseal: (s) => s,
};

export interface SecretVaultOpts {
  root: string; // storage root — a temp dir in tests, ~/.coads in prod
  secretStore?: SecretStore; // Layer 1 (ctx.secrets); optional
  seal?: SealProvider; // platform seal; defaults to plaintext floor in tests
  onPlaintextWarn?: () => void; // called when the plaintext floor is used
}

export class SecretVault {
  private readonly root: string;
  private readonly secretStore?: SecretStore;
  private readonly seal: SealProvider;
  private readonly onPlaintextWarn?: () => void;

  constructor(opts: SecretVaultOpts) {
    this.root = opts.root;
    this.secretStore = opts.secretStore;
    // Default to the plaintext floor so automated runs NEVER hit the real
    // keychain. Production wiring injects the platform seal explicitly.
    this.seal = opts.seal ?? plaintextSeal;
    this.onPlaintextWarn = opts.onPlaintextWarn;
  }

  // The active seal scheme, for `BoringSpinner: Show status` (§5.5).
  get scheme(): VaultScheme {
    return this.seal.scheme;
  }

  private get authFilePath(): string {
    return path.join(this.root, AUTH_FILE);
  }

  // Store the bundle in both layers. Layer 1 (fast) + Layer 2 (durable floor).
  async store(bundle: TokenBundle): Promise<void> {
    // Layer 1: whole bundle as JSON in SecretStorage.
    if (this.secretStore) {
      try {
        await this.secretStore.store(SECRET_KEY, JSON.stringify(bundle));
      } catch {
        /* Layer 1 is best-effort; the file floor is authoritative. */
      }
    }
    // Layer 2: file with the refresh token sealed.
    if (this.seal.scheme === 'file') this.onPlaintextWarn?.();
    const file: AuthFile = {
      scheme: this.seal.scheme,
      access: bundle.access,
      email: bundle.email,
      refreshSealed: this.seal.seal(bundle.refresh),
    };
    fs.mkdirSync(this.root, { recursive: true });
    fs.writeFileSync(this.authFilePath, JSON.stringify(file, null, 2), {
      encoding: 'utf8',
      mode: 0o600, // §10.1 — chmod 0600
    });
    // Re-assert mode in case the file pre-existed with looser perms.
    try {
      fs.chmodSync(this.authFilePath, 0o600);
    } catch {
      /* best effort on platforms without chmod semantics */
    }
  }

  // Load the bundle: Layer 1 (keychain/SecretStorage) → Layer 2 (file) fallback.
  async load(): Promise<TokenBundle | null> {
    // Layer 1 first (§5.6 step 11: keychain → file fallback).
    if (this.secretStore) {
      try {
        const raw = await this.secretStore.get(SECRET_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as TokenBundle;
          if (parsed.access && parsed.refresh) return parsed;
        }
      } catch {
        /* fall through to file */
      }
    }
    // Layer 2 file floor.
    return this.loadFromFile();
  }

  private loadFromFile(): TokenBundle | null {
    try {
      const raw = fs.readFileSync(this.authFilePath, 'utf8');
      const file = JSON.parse(raw) as AuthFile;
      return {
        access: file.access,
        email: file.email,
        refresh: this.seal.unseal(file.refreshSealed),
      };
    } catch {
      return null; // missing / unreadable / undecryptable
    }
  }

  // Clear every storage location (§5.5 sign-out / fatal refresh failure §10.1).
  async clear(): Promise<void> {
    if (this.secretStore) {
      try {
        await this.secretStore.delete(SECRET_KEY);
      } catch {
        /* best effort */
      }
    }
    try {
      fs.rmSync(this.authFilePath, { force: true });
    } catch {
      /* best effort */
    }
  }
}
