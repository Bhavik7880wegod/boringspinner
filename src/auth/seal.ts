// src/auth/seal.ts — platform SealProviders for the SecretVault Layer-2 floor.
//
// Each provider protects the refresh token at rest using the OS-native secret
// store (§10.1). These shell out to `security` / `secret-tool`, or call DPAPI.
//
// SAFETY: nothing here runs at import time. The vault defaults to the plaintext
// floor; the real platform providers are only constructed by production wiring
// (extension.ts) — automated tests inject `plaintextSeal` and never touch the
// real Keychain. macOS guidance forbids `security add-generic-password` against
// the login keychain during verification, so the Keychain provider below is the
// documented prod path only.

import { execFileSync } from 'child_process';
import type { SealProvider, VaultScheme } from './vault';
import { detectScheme, plaintextSeal } from './vault';

const KEYCHAIN_SERVICE = 'boringspinner.com';
const KEYCHAIN_ACCOUNT = 'refresh';
const SECRET_TOOL_ATTRS = ['service', 'boringspinner.com', 'account', 'refresh'];

// macOS Keychain via `security`. The sealed value is an opaque marker; the real
// secret lives in the login keychain. unseal() reads it back.
function macKeychainSeal(): SealProvider {
  return {
    scheme: 'Keychain',
    seal(plaintext: string): string {
      // Upsert: delete any prior entry, then add. -U would also work on newer
      // macOS but delete+add is the broadest-compatible upsert.
      try {
        execFileSync('security', [
          'delete-generic-password',
          '-s', KEYCHAIN_SERVICE,
          '-a', KEYCHAIN_ACCOUNT,
        ], { stdio: 'ignore' });
      } catch {
        /* no prior entry — fine */
      }
      execFileSync('security', [
        'add-generic-password',
        '-s', KEYCHAIN_SERVICE,
        '-a', KEYCHAIN_ACCOUNT,
        '-w', plaintext,
      ], { stdio: 'ignore' });
      return 'keychain://boringspinner.com/refresh';
    },
    unseal(_sealed: string): string {
      return execFileSync('security', [
        'find-generic-password',
        '-s', KEYCHAIN_SERVICE,
        '-a', KEYCHAIN_ACCOUNT,
        '-w',
      ], { encoding: 'utf8' }).trim();
    },
  };
}

// Linux libsecret via `secret-tool`.
function libsecretSeal(): SealProvider {
  return {
    scheme: 'libsecret',
    seal(plaintext: string): string {
      execFileSync('secret-tool', ['store', '--label=BoringSpinner refresh token', ...SECRET_TOOL_ATTRS], {
        input: plaintext,
        stdio: ['pipe', 'ignore', 'ignore'],
      });
      return 'libsecret://boringspinner.com/refresh';
    },
    unseal(_sealed: string): string {
      return execFileSync('secret-tool', ['lookup', ...SECRET_TOOL_ATTRS], {
        encoding: 'utf8',
      }).trim();
    },
  };
}

// Windows DPAPI. Sealed bytes are base64 of CryptProtectData output. We invoke
// PowerShell so no native module is needed (keeps the .vsix small, §5.1).
function dpapiSeal(): SealProvider {
  const ps = (script: string) =>
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    }).trim();
  return {
    scheme: 'DPAPI',
    seal(plaintext: string): string {
      const b64 = Buffer.from(plaintext, 'utf8').toString('base64');
      return ps(
        `Add-Type -AssemblyName System.Security; ` +
          `$b=[Convert]::FromBase64String('${b64}'); ` +
          `$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); ` +
          `[Convert]::ToBase64String($p)`,
      );
    },
    unseal(sealed: string): string {
      const out = ps(
        `Add-Type -AssemblyName System.Security; ` +
          `$b=[Convert]::FromBase64String('${sealed}'); ` +
          `$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); ` +
          `[Convert]::ToBase64String($p)`,
      );
      return Buffer.from(out, 'base64').toString('utf8');
    },
  };
}

// Pick the platform seal. If the native tool isn't available, callers may catch
// the seal()/unseal() throw and fall back; the vault treats failures as "no
// token" (cold start). `platform` is injectable for tests/diagnostics.
export function platformSeal(platform: string = process.platform): SealProvider {
  const scheme: VaultScheme = detectScheme(platform);
  switch (scheme) {
    case 'Keychain':
      return macKeychainSeal();
    case 'libsecret':
      return libsecretSeal();
    case 'DPAPI':
      return dpapiSeal();
    default:
      return plaintextSeal;
  }
}
