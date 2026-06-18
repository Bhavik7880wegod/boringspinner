// src/activation/webviewInjection.ts — orchestrates the `claude-overlay` surface
// at runtime: boot the loopback (§5.9), resolve a webview-reachable base via
// vscode.env.asExternalUri (Remote-SSH/devcontainer-safe), then apply the ad to
// the located Claude Code bundle — but ONLY when canPatch() says so (§6.5
// fail-closed). Restore tears it back down byte-exactly.
//
// This module owns the vscode + I/O glue; all string/byte logic lives in the
// (unit-tested) adapter / injection / loopback / locate modules.

import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

import { ClaudeOverlayAdapter } from '../adapters/claude-code/adapter';
import { locateClaudeCode } from '../locate';
import { startLoopback, type LoopbackServer } from '../loopback';
import { canPatch, whyNotPatch, type KillPosture } from '../servingGate';
import { dlog } from '../log';

export interface OverlayCreative {
  adId: string;
  adText: string;
  clickUrl: string; // real advertiser URL (anchor href)
  iconUrl?: string;
}

export interface OverlayGate {
  enabled: boolean;
  killPosture: KillPosture;
  viewThresholdMs?: number;
  debug?: boolean;
  // Called when the in-webview anchor is clicked (loopback /click). Wire to the
  // MetricsClient in extension.ts to emit the §6.1 `click` event.
  onClick?: (q: URLSearchParams) => void;
  onLog?: (q: URLSearchParams) => void;
  // Returns the CURRENT auction queue (live, from session). Served by the
  // loopback at GET /ads so the injected overlay can poll + swap campaigns in a
  // kept-open session with no reload (v0.3.6).
  getAds?: () => OverlayCreative[];
}

export interface OverlaySession {
  adapter: ClaudeOverlayAdapter;
  loopback: LoopbackServer;
  restore(): void;
  dispose(): Promise<void>;
}

// Apply the overlay ad. Returns null (and patches nothing) when no compatible
// target exists or canPatch() refuses — the fail-closed contract (§6.5).
export async function startWebviewInjection(
  creative: OverlayCreative,
  gate: OverlayGate,
  // The full auction sample. When supplied (len ≥ 1) the injected block rotates
  // through it one creative per message; `creative` is the head (also baked into
  // the single-creative placeholders for back-compat). Omit ⇒ single ad.
  queue?: OverlayCreative[],
): Promise<OverlaySession | null> {
  const host = locateClaudeCode();
  if (!host || !host.webviewJs) {
    dlog('[claude-overlay] no Claude Code webview bundle located — skipping');
    return null;
  }

  const adapter = new ClaudeOverlayAdapter({
    webviewJsPath: host.webviewJs,
    hostJsPath: host.hostJs,
    version: host.version,
  });

  const pf = adapter.preflight();
  const gateInputs = {
    enabled: gate.enabled,
    killPosture: gate.killPosture,
    compatible: pf.compatible,
  };
  if (!canPatch(gateInputs)) {
    dlog(`[claude-overlay] not patching: ${whyNotPatch(gateInputs) ?? pf.reason ?? 'gated'}`);
    return null;
  }

  // 1) Loopback first so its URL can be baked into the injected block.
  const token = randomUUID().replace(/-/g, '');
  const loopback = await startLoopback({
    token,
    onClick: gate.onClick,
    onLog: gate.onLog,
    // Live overlay refresh (v0.3.6): serve the CURRENT queue at GET /ads, each
    // ad stamped with its own corr so a click on a live-swapped ad still bills.
    getAds: gate.getAds
      ? () =>
          gate.getAds!().map((c) => ({
            adId: c.adId,
            adText: c.adText,
            clickUrl: c.clickUrl,
            iconUrl: c.iconUrl ?? '',
            corr: `${c.adId}.${randomUUID().slice(0, 8)}`,
          }))
      : undefined,
  });

  // 2) Resolve a webview-reachable base (transparently proxied on remote).
  let loopbackBase = loopback.baseUrl;
  try {
    const ext = await vscode.env.asExternalUri(vscode.Uri.parse(loopback.baseUrl));
    loopbackBase = ext.toString().replace(/\/$/, '');
  } catch {
    /* local: the direct 127.0.0.1 base already works */
  }

  // 3) Patch (prime CSP + inject ad). corr = <adId>.<rand> per §6.2.
  const corr = `${creative.adId}.${randomUUID().slice(0, 8)}`;
  // The per-message rotation queue: every sampled creative gets its OWN corr so a
  // click on a rotated ad bills the correct campaign (the in-block beacon sends
  // CFG.corr + CFG.adId, which rotate() swaps per turn). Head reuses `corr`.
  const rotation = (queue && queue.length ? queue : [creative]).map((c, i) => ({
    adId: c.adId,
    adText: c.adText,
    clickUrl: c.clickUrl,
    iconUrl: c.iconUrl ?? '',
    corr: i === 0 ? corr : `${c.adId}.${randomUUID().slice(0, 8)}`,
  }));
  const res = adapter.applyPatch({
    tier: 0,
    adText: creative.adText,
    iconRef: '',
    iconUrl: creative.iconUrl ?? '',
    clickToken: token,
    clickUrl: creative.clickUrl,
    corr,
    overlayAds: rotation,
    loopbackPort: loopback.port,
    loopbackToken: token,
    loopbackBase,
    viewThresholdMs: gate.viewThresholdMs ?? 3000,
    debug: gate.debug,
  });

  if (!res.ok) {
    dlog(`[claude-overlay] applyPatch failed: ${res.reason}`);
    await loopback.close();
    return null;
  }
  dlog(`[claude-overlay] applied (reload the Claude Code webview to render). corr=${corr}`);

  return {
    adapter,
    loopback,
    restore: () => {
      const r = adapter.restore();
      if (!r.ok) dlog(`[claude-overlay] restore failed: ${r.reason}`);
    },
    dispose: async () => {
      await loopback.close();
    },
  };
}
