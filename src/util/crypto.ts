// src/util/crypto.ts — stable client_id derivation + UUIDv4 generation/validation.
//
// client_id (§6.2 "stable device ID"): a hash of stable host facts, prefixed
// `dvc_`. Stable across activations on the same machine; never leaves anything
// identifying — it's a one-way hash of hostname+platform+arch+homedir.

import * as crypto from 'crypto';
import * as os from 'os';

// §6.2 — the UUIDv4 regex the backend enforces (8-4-4-4-12, version nibble 4,
// variant nibble 8/9/a/b). The client generates nonces that match this.
export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// A client-generated UUIDv4 nonce (§6.3). Uses the platform crypto.randomUUID.
export function uuidv4(): string {
  return crypto.randomUUID();
}

export function isUuidV4(s: string): boolean {
  return UUID_V4_RE.test(s);
}

// Stable device id (§6.2). Derived from facts that don't change between boots.
// `facts` is injectable so the derivation is unit-testable without touching os.
export function deriveClientId(facts?: {
  hostname?: string;
  platform?: string;
  arch?: string;
  homedir?: string;
}): string {
  const f = {
    hostname: facts?.hostname ?? os.hostname(),
    platform: facts?.platform ?? process.platform,
    arch: facts?.arch ?? process.arch,
    homedir: facts?.homedir ?? os.homedir(),
  };
  const material = `${f.hostname}|${f.platform}|${f.arch}|${f.homedir}`;
  const hex = crypto.createHash('sha256').update(material, 'utf8').digest('hex');
  return `dvc_${hex.slice(0, 24)}`;
}
