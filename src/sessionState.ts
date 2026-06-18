// src/sessionState.ts — in-memory session snapshot for one activation.
//
// Holds the current ad/queue, view-threshold, balances and demo flag so the
// status bar, cliSync, and view-tick loop read a single source of truth without
// re-fetching. Phase 3 populates this from the PortfolioClient + EarningsClient.

import type { PatchAd, Balances } from './portfolio/client';

export class SessionState {
  private queue: PatchAd[] = [];
  private head: PatchAd | null = null;
  private balances: Balances | null = null;
  private viewThresholdMs = 3000;
  private rotationIntervalMs = 15_000;
  private demo = true; // signed-out by default (§5.11)

  setQueue(ads: PatchAd[], opts?: { viewThresholdMs?: number; rotationIntervalMs?: number }): void {
    this.queue = [...ads];
    this.head = this.queue[0] ?? null;
    if (opts?.viewThresholdMs !== undefined) this.viewThresholdMs = opts.viewThresholdMs;
    if (opts?.rotationIntervalMs !== undefined) this.rotationIntervalMs = opts.rotationIntervalMs;
    // Demo state follows the head ad's demo flag (§5.8 / §5.11).
    this.demo = this.head?.demo === true;
  }

  setBalances(b: Balances | null): void {
    this.balances = b;
  }

  currentAd(): PatchAd | null {
    return this.head;
  }
  getQueue(): readonly PatchAd[] {
    return this.queue;
  }
  // Every ad text in the current queue (deduped, non-empty), in queue order. The
  // claude-cli-spinner surface writes ALL of these into spinnerVerbs so Claude
  // Code rotates the whole auction-sampled set per session — not just the head.
  allAdTexts(): string[] {
    const out: string[] = [];
    for (const ad of this.queue) {
      const t = ad.adText?.trim();
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  }
  getBalances(): Balances | null {
    return this.balances;
  }
  getViewThresholdMs(): number {
    return this.viewThresholdMs;
  }
  getRotationIntervalMs(): number {
    return this.rotationIntervalMs;
  }
  isDemo(): boolean {
    return this.demo;
  }
}
