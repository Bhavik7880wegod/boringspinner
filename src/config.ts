// src/config.ts — reads ~/.boringspinner/config.json (falling back to the legacy
// ~/.coads/) + BORINGSPINNER_* env vars (with COADS_* as a back-compat alias).
// Defaults match §12. Pure-ish: file/env reads are isolated so the resolver
// (resolveConfig) is unit-testable from injected inputs.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Read an env var by its BARE name, preferring the new BORINGSPINNER_<X> over the
// legacy COADS_<X> alias (back-compat for existing dev installs). Exported for tests.
export function bsEnv(env: NodeJS.ProcessEnv, bare: string): string | undefined {
  return env[`BORINGSPINNER_${bare}`] ?? env[`COADS_${bare}`];
}

export interface CoAdsConfig {
  backendBase: string;
  updateBase: string;
  localVsixPath: string | null;
  updatePollIntervalMs: number;
  debug: boolean;
}

// Defaults from §12 config template.
export const CONFIG_DEFAULTS: CoAdsConfig = {
  backendBase: 'https://api.boringspinner.com',
  updateBase: 'https://api.boringspinner.com',
  localVsixPath: null,
  updatePollIntervalMs: 21_600_000, // 6h
  debug: false,
};

// Brand home dir. New code WRITES here (~/.boringspinner). The legacy ~/.coads
// path is still READ as a fallback (coadsHomeDirRead) so an already-installed
// dev keeps its sealed token / config until the new dir is materialized.
const NEW_HOME = '.boringspinner';
const LEGACY_HOME = '.coads';

// WRITE path — always the new brand dir.
export function coadsHomeDir(): string {
  return path.join(os.homedir(), NEW_HOME);
}

// READ path — prefer the new dir; fall back to legacy ~/.coads ONLY when the new
// dir is absent but the legacy one exists. Returns the new dir otherwise.
export function coadsHomeDirRead(): string {
  const next = coadsHomeDir();
  try {
    if (fs.existsSync(next)) return next;
    const legacy = path.join(os.homedir(), LEGACY_HOME);
    if (fs.existsSync(legacy)) return legacy;
  } catch {
    /* fall through to the new dir */
  }
  return next;
}

// Config file path for READS — resolves through the legacy fallback.
export function configPath(): string {
  return path.join(coadsHomeDirRead(), 'config.json');
}

// The §12 template written on first `BoringSpinner: Edit config`.
export const CONFIG_TEMPLATE = `{
  // Required: backend base. Must be HTTPS unless loopback (test only).
  "backendBase": "https://api.boringspinner.com",
  // Optional: separate update host (defaults to backendBase).
  "updateBase": "https://api.boringspinner.com",
  // Optional: local .vsix path for dogfooding (skips manifest fetch).
  "localVsixPath": null,
  // Optional: poll cadence for self-update (ms). Default 21_600_000 (6h).
  "updatePollIntervalMs": 21600000,
  // Optional: enable verbose debug log at ~/.coads/debug.log.
  "debug": false
}
`;

// Pure resolver: layer env over file over defaults. Exported for tests.
export function resolveConfig(
  fileJson: Partial<CoAdsConfig> | null,
  env: NodeJS.ProcessEnv,
): CoAdsConfig {
  const cfg: CoAdsConfig = { ...CONFIG_DEFAULTS, ...(fileJson ?? {}) };

  // updateBase defaults to backendBase when not explicitly set in the file.
  if (fileJson && fileJson.backendBase && fileJson.updateBase === undefined) {
    cfg.updateBase = fileJson.backendBase;
  }

  // BORINGSPINNER_* overrides (§12), with COADS_* honored as a back-compat alias.
  const base = bsEnv(env, 'BASE');
  const updateBase = bsEnv(env, 'UPDATE_BASE');
  const localVsix = bsEnv(env, 'LOCAL_VSIX');
  if (base) cfg.backendBase = base;
  if (updateBase) cfg.updateBase = updateBase;
  if (localVsix) cfg.localVsixPath = localVsix;
  if (bsEnv(env, 'DEBUG') === '1') cfg.debug = true;

  return cfg;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoAdsConfig {
  let fileJson: Partial<CoAdsConfig> | null = null;
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    fileJson = JSON.parse(stripJsonComments(raw)) as Partial<CoAdsConfig>;
  } catch {
    fileJson = null; // missing or unreadable → defaults
  }
  return resolveConfig(fileJson, env);
}

// Minimal JSONC tolerance for the config file's `//` comments.
export function stripJsonComments(input: string): string {
  return input.replace(/^\s*\/\/.*$/gm, '');
}
