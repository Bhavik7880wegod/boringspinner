// src/update/client.ts — /v1/update polling + .vsix install (§11).
//
// Phase 2: a lean but structured self-update client. Polls the manifest,
// exposes signature + sha256 verification (structured; full ed25519 verify is a
// thin stub keyed off a baked-in public key), and honors the COADS_LOCAL_VSIX
// dogfood bypass. The actual `code --install-extension` + sentinel touch is the
// `applyUpdate` path; download is a thin implementation.

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

import { coadsHomeDirRead } from '../config';
import { dlog } from '../log';

// §11 manifest shape.
export interface UpdateManifest {
  available: boolean;
  version: string;
  downloadUrl: string;
  sha256: string;
  signature: string; // ed25519-hex
}

export interface UpdateClientOpts {
  updateBase: string; // e.g. https://api.boringspinner.com
  channel?: string; // default 'stable'
  currentVersion: string;
  localVsixPath?: string | null; // COADS_LOCAL_VSIX dogfood bypass
  // Injectable for tests; defaults to global fetch with a 15s timeout (§5.1).
  fetchImpl?: typeof fetch;
}

// Baked-in update-signing public key. TODO(Phase 6): real ed25519 key + rotation.
export const COADS_UPDATE_PUBKEY_HEX = ''; // empty ⇒ verify is a structured stub

export function reloadSentinelPath(): string {
  return path.join(coadsHomeDirRead(), 'reload.sentinel');
}

export function vsixCachePath(version: string): string {
  // `coads-<version>.vsix` cache filename kept verbatim (internal artifact name).
  return path.join(coadsHomeDirRead(), 'cache', `coads-${version}.vsix`);
}

// Build the manifest URL per §7.2 / §11.
export function manifestUrl(opts: UpdateClientOpts): string {
  const channel = opts.channel ?? 'stable';
  const base = opts.updateBase.replace(/\/+$/, '');
  return `${base}/v1/update/manifest?channel=${encodeURIComponent(
    channel,
  )}&from=${encodeURIComponent(opts.currentVersion)}`;
}

export class UpdateClient {
  private readonly opts: UpdateClientOpts;
  private readonly doFetch: typeof fetch;

  constructor(opts: UpdateClientOpts) {
    this.opts = opts;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  // Poll the manifest. The COADS_LOCAL_VSIX dogfood path (§11) short-circuits:
  // if set, we synthesize an "available" manifest pointing at the local file.
  async checkForUpdate(): Promise<UpdateManifest | null> {
    if (this.opts.localVsixPath) {
      dlog('[update] COADS_LOCAL_VSIX set — bypassing manifest', this.opts.localVsixPath);
      return {
        available: true,
        version: 'local',
        downloadUrl: this.opts.localVsixPath,
        sha256: '',
        signature: '',
      };
    }
    try {
      const res = await this.doFetch(manifestUrl(this.opts), {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        dlog('[update] manifest non-200', String(res.status));
        return null;
      }
      const json = (await res.json()) as UpdateManifest;
      return json.available ? json : null;
    } catch (e) {
      dlog('[update] manifest fetch failed', String(e));
      return null;
    }
  }

  // Verify the downloaded bytes match the manifest sha256.
  static verifySha256(bytes: Buffer, expectedHex: string): boolean {
    if (!expectedHex) return true; // local dogfood path has no checksum
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    return actual.toLowerCase() === expectedHex.toLowerCase();
  }

  // Verify the ed25519 signature against the baked-in public key (§11).
  // Structured stub: with no baked key (Phase 2) we accept; once a key is baked
  // (Phase 6) this becomes a real crypto.verify. Never throws.
  static verifySignature(bytes: Buffer, signatureHex: string): boolean {
    if (!COADS_UPDATE_PUBKEY_HEX) {
      // TODO(Phase 6): require a real signature once the pubkey is baked in.
      return true;
    }
    try {
      const key = crypto.createPublicKey({
        key: Buffer.from(COADS_UPDATE_PUBKEY_HEX, 'hex'),
        format: 'der',
        type: 'spki',
      });
      return crypto.verify(null, bytes, key, Buffer.from(signatureHex, 'hex'));
    } catch {
      return false;
    }
  }

  // Apply an update: (download →) verify → install → touch reload sentinel (§11).
  // For the local dogfood path the downloadUrl IS a local file (no fetch).
  async applyUpdate(m: UpdateManifest): Promise<boolean> {
    try {
      let vsixPath: string;
      if (this.opts.localVsixPath) {
        vsixPath = this.opts.localVsixPath;
      } else {
        const res = await this.doFetch(m.downloadUrl, { method: 'GET' });
        if (!res.ok) {
          dlog('[update] download non-200', String(res.status));
          return false;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (!UpdateClient.verifySha256(buf, m.sha256)) {
          dlog('[update] sha256 mismatch — refusing install');
          return false;
        }
        if (!UpdateClient.verifySignature(buf, m.signature)) {
          dlog('[update] signature invalid — refusing install');
          return false;
        }
        vsixPath = vsixCachePath(m.version);
        fs.mkdirSync(path.dirname(vsixPath), { recursive: true });
        fs.writeFileSync(vsixPath, buf);
      }

      // §11 step 4: install. Thin implementation; never throws upward.
      try {
        execFileSync('code', ['--install-extension', vsixPath], {
          stdio: 'ignore',
          timeout: 60_000,
        });
      } catch (e) {
        dlog('[update] code --install-extension failed', String(e));
        return false;
      }

      // §11 step 5: touch the reload sentinel for reloadSignal to observe.
      writeReloadSentinel(m.version);
      return true;
    } catch (e) {
      dlog('[update] applyUpdate failed', String(e));
      return false;
    }
  }
}

// Write {version, mtimeMs} to ~/.coads/reload.sentinel (§11 step 5).
export function writeReloadSentinel(version: string): void {
  try {
    const p = reloadSentinelPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const payload = JSON.stringify({ version, mtimeMs: Date.now() });
    fs.writeFileSync(p, payload, 'utf8');
  } catch (e) {
    dlog('[update] writeReloadSentinel failed', String(e));
  }
}
