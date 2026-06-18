// src/activation/cliSync.ts — keeps ~/.claude/settings.json in sync.
//
// Phase 2: on activation (and on reassert), if serving is allowed, run the
// claude-cli-spinner adapter's preflight then applyPatch with the current
// (hardcoded) ad. Respects the servingGate (§6.5). Idempotent.
//
// SAFETY: this is the live runtime behavior. It is wired + unit-tested against
// fixtures, but per the Phase-2 safety rules it is NOT executed against the real
// ~/.claude/settings.json during the build.

import type { TargetAdapter, PatchParams } from '../adapters/types';
import { canPatch, type KillPosture } from '../servingGate';
import { dlog } from '../log';

export interface CliSyncDeps {
  adapter: TargetAdapter;
  enabled: () => boolean;
  killPosture: () => KillPosture;
  // The head ad text — single-verb fallback when the queue is empty / `verbs`
  // is not supplied (keeps back-compat with the Phase-2 single-ad path).
  adText: () => string;
  // The FULL rotation set: every ad text in the current auction queue. When
  // present and non-empty, ALL are written to spinnerVerbs so Claude Code
  // rotates the whole sampled set per session (not just the head ad).
  verbs?: () => string[];
}

// A minimal PatchParams for the CLI surface. The terminal surface ignores the
// webview/loopback fields; only adText + verbs are load-bearing here.
function cliPatchParams(adText: string, verbs: string[]): PatchParams {
  return {
    tier: 0,
    adText,
    verbs,
    iconRef: '',
    iconUrl: '',
    clickToken: '',
    clickUrl: '',
    corr: '',
    loopbackPort: 0,
    loopbackToken: '',
    loopbackBase: '',
  };
}

// Run one sync pass. Returns true iff an apply (or idempotent no-op) succeeded.
export function syncOnce(deps: CliSyncDeps): boolean {
  const pf = deps.adapter.preflight();
  const gateOk = canPatch({
    enabled: deps.enabled(),
    killPosture: deps.killPosture(),
    compatible: pf.compatible,
  });
  if (!gateOk) {
    dlog('[cliSync] gate closed — not writing', pf.reason ?? '');
    return false;
  }
  // Prefer the full auction queue (rotation set); fall back to the single head ad.
  const verbs = (deps.verbs?.() ?? []).map((v) => v.trim()).filter(Boolean);
  const head = verbs[0] ?? deps.adText();
  const res = deps.adapter.applyPatch(cliPatchParams(head, verbs));
  if (!res.ok) {
    dlog('[cliSync] applyPatch failed', res.reason ?? '');
    return false;
  }
  dlog('[cliSync] synced', res.reason ?? 'applied');
  return true;
}

// Wire activation: run an initial sync. (Periodic reassert is scheduled by the
// caller's timer loop in §5.6 step 17 — Phase 2 just provides syncOnce.)
export function setupCliSync(deps: CliSyncDeps): { syncOnce: () => boolean } {
  syncOnce(deps);
  return { syncOnce: () => syncOnce(deps) };
}
