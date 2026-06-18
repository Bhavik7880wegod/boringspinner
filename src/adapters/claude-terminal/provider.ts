// src/adapters/claude-terminal/provider.ts — VS Code integrated-terminal ad surface.
//
// A NEW RENDER TARGET, not a new ad pipeline. When the user runs the `claude` CLI
// in the integrated terminal, Claude Code prints a "thinking" spinner line. We
// detect it (detect.ts) and attach a clickable terminal link to that span whose
// TOOLTIP is the sponsored ad copy and whose click opens the advertiser URL —
// reusing the SAME portfolio ad, the SAME MetricsClient impression/click events,
// the SAME nonce-per-impression dedupe, and the SAME surface id as the existing
// claude-cli-spinner surface.
//
// NOTE on the VS Code API: a TerminalLinkProvider attaches a link to EXISTING
// rendered terminal text (it cannot inject new glyphs). So the ad copy rides in
// the link tooltip while the spinner verb is the clickable target. This file is
// `vscode`-free (structural types only) so it unit-tests without the host; the
// extension adapts the real vscode.TerminalLink* types to it on activation.

import { detectSpinner } from './detect';
import type { MetricEvent, MetricInput } from '../../metrics/client';
import type { PatchAd } from '../../portfolio/client';

// The logical surface this terminal render maps onto (§3 surface 5). Reused so
// the auction's existing claude-cli-spinner bids/analytics apply unchanged.
export const TERMINAL_SURFACE = 'claude-cli-spinner';

// Minimal structural view of vscode.TerminalLinkContext we consume.
export interface TerminalLinkContextLike {
  terminal: { name?: string };
  line: string;
}

// Our TerminalLink subtype: the vscode-required {startIndex,length,tooltip} plus a
// private `data` payload threaded to handleTerminalLink (vscode passes the link
// object back verbatim).
export interface TerminalAdLink {
  startIndex: number;
  length: number;
  tooltip: string;
  data: {
    adId: string;
    campaignId: string;
    surface: string;
    corr: string;
    sessionNonce: string;
    sessionToken: string;
    clickUrl: string;
  };
}

// Just the slice of MetricsClient we need — keeps the provider testable without a
// live backend (tests pass a recording sink; the extension passes the real client).
export interface MetricSender {
  send(input: MetricInput): unknown | Promise<unknown>;
}

export interface TerminalAdProviderOpts {
  // Current head ad from the session/portfolio (null ⇒ nothing to serve).
  getAd: () => PatchAd | null;
  metrics: MetricSender;
  openExternal: (url: string) => void | Promise<void>;
  // Heuristic: is this terminal plausibly running `claude`? Defaults to accepting
  // claude-named terminals and generic shells (the spinner pattern is the decisive
  // signal); only rejects terminals clearly named for a different tool.
  isClaudeTerminal?: (name?: string) => boolean;
  surface?: string;
  rand?: () => string; // correlation-id randomness; injectable for tests
  impressionEvent?: Extract<MetricEvent, 'impression_rendered' | 'view_threshold_met'>;
}

export interface TerminalAdProvider {
  provideTerminalLinks(ctx: TerminalLinkContextLike): TerminalAdLink[];
  handleTerminalLink(link: TerminalAdLink): void;
}

// Default terminal-name heuristic: accept claude + common shells / unnamed; reject
// terminals explicitly named for another known tool so we don't decorate those.
function defaultIsClaudeTerminal(name?: string): boolean {
  if (!name) return true;
  return /claude|zsh|bash|fish|pwsh|powershell|sh\b|terminal|cmd/i.test(name);
}

export function createTerminalAdProvider(opts: TerminalAdProviderOpts): TerminalAdProvider {
  const surface = opts.surface ?? TERMINAL_SURFACE;
  const isClaudeTerminal = opts.isClaudeTerminal ?? defaultIsClaudeTerminal;
  const rand = opts.rand ?? (() => Math.random().toString(36).slice(2, 8));
  const impressionEvent = opts.impressionEvent ?? 'impression_rendered';

  // Nonce-per-impression gate (§6.3 spirit): post at most one impression per ad
  // session (sessionNonce), even though provideTerminalLinks is called for every
  // scanned line. This is the terminal-surface analogue of the cooldown/dedupe
  // applied on the DOM surfaces.
  const impressed = new Set<string>();

  function provideTerminalLinks(ctx: TerminalLinkContextLike): TerminalAdLink[] {
    if (!isClaudeTerminal(ctx.terminal?.name)) return [];
    const range = detectSpinner(ctx.line);
    if (!range) return [];
    const ad = opts.getAd();
    if (!ad) return [];

    // Mirror extension.ts: sessionNonce = the ad's sessionToken; corr = <adId>.<rand>.
    const sessionNonce = ad.sessionToken;
    const corr = `${ad.adId}.${rand()}`;

    if (!impressed.has(sessionNonce)) {
      impressed.add(sessionNonce);
      void opts.metrics.send({
        event: impressionEvent,
        adId: ad.adId,
        campaignId: ad.campaignId,
        surface,
        corr,
        sessionNonce,
        sessionToken: ad.sessionToken,
        viewable: true,
        viewPct: 1.0,
        visibleMs: 0,
        viewMs: 0,
      });
    }

    return [
      {
        startIndex: range.startIndex,
        length: range.length,
        tooltip: `${ad.adText}  ·  BoringSpinner (click to open)`,
        data: {
          adId: ad.adId,
          campaignId: ad.campaignId,
          surface,
          corr,
          sessionNonce,
          sessionToken: ad.sessionToken,
          clickUrl: ad.clickUrl,
        },
      },
    ];
  }

  function handleTerminalLink(link: TerminalAdLink): void {
    const d = link.data;
    // Billable click (§6.1) — carries the same corr + sessionNonce as the impression.
    void opts.metrics.send({
      event: 'click',
      adId: d.adId,
      campaignId: d.campaignId,
      surface: d.surface,
      corr: d.corr,
      sessionNonce: d.sessionNonce,
      sessionToken: d.sessionToken,
      viewable: true,
      viewPct: 1.0,
      visibleMs: 0,
      viewMs: 0,
    });
    void opts.openExternal(d.clickUrl);
  }

  return { provideTerminalLinks, handleTerminalLink };
}
