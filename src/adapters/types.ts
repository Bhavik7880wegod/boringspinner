// src/adapters/types.ts — TargetAdapter interface + supporting types (§5.7).
// Type-only file: fully implemented (no runtime logic).

import type { AdSurface } from '../types/surface';

export type { AdSurface };

export interface OpResult {
  ok: boolean;
  reason?: string;
}

export interface PreflightResult extends OpResult {
  compatible: boolean;
  version: string | null;
}

export interface RestoreResult extends OpResult {
  restored: boolean;
}

export interface PatchParams {
  tier: 0 | 1 | 2 | 3; // rotation tier for the rendered slot
  adText: string;
  iconRef: string;
  iconUrl: string;
  clickToken: string;
  clickUrl: string; // advertiser landing URL (the anchor's real href)
  corr: string; // correlation id (<adId>.<rand>)
  loopbackPort: number;
  loopbackToken: string;
  loopbackBase: string; // webview-reachable, resolved via vscode.env.asExternalUri
  debug?: boolean;
  bannerOn?: boolean;
  viewThresholdMs?: number; // baked into the injected block
  // claude-cli-spinner: the FULL rotation set — every ad text in the auction
  // queue. When present and non-empty, ALL are written to `spinnerVerbs` so
  // Claude Code rotates the whole sampled set (not just the head ad). Falls back
  // to `adText` when absent/empty.
  verbs?: string[];
  // claude-overlay: the FULL creative rotation queue baked into the webview
  // block. The injected overlay advances to the next entry on each new turn
  // (per-message rotation); each entry carries its own corr so a click attributes
  // to the ad actually shown. Empty ⇒ single-creative back-compat.
  overlayAds?: OverlayAdSlot[];
}

// One creative in the webview overlay's per-message rotation queue (§3 #1).
export interface OverlayAdSlot {
  adId: string;
  adText: string;
  clickUrl: string;
  iconUrl: string;
  corr: string;
}

export interface AdapterDiagnostics {
  name: string;
  target: string;
  targetExists: boolean;
  version: string | null;
  compatible: boolean;
  reason?: string;
  isPatched: boolean;
  backup: {
    exists: boolean;
    path: string | null;
    hasArray: boolean;
    hasBlock: boolean;
  };
  live: {
    hasArray: boolean;
    bareVerbPresent: boolean;
  };
}

export interface TargetAdapter {
  readonly name: string;
  preflight(): PreflightResult;
  version(): string | null;
  applyPatch(p: PatchParams): OpResult;
  restore(opts?: { keepCsp?: boolean }): RestoreResult;
  isPatched?(): boolean;
  diagnose?(): AdapterDiagnostics;
  prime?(): OpResult; // invisible structural prerequisites only
}
