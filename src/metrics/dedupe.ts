// src/metrics/dedupe.ts — in-memory recent-nonce cache (§6.3).
//
// Suppresses double-fires of the same nonce WITHIN one activation (the backend
// also dedupes on (client_id, nonce), but the client shouldn't even send twice).
// Bounded FIFO so a long-running session can't grow it unbounded.

export class NonceDedupe {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private readonly cap: number;

  constructor(cap = 2000) {
    this.cap = cap;
  }

  // Returns true the FIRST time a nonce is seen; false on every repeat.
  markFresh(nonce: string): boolean {
    if (this.seen.has(nonce)) return false;
    this.seen.add(nonce);
    this.order.push(nonce);
    if (this.order.length > this.cap) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
    return true;
  }

  has(nonce: string): boolean {
    return this.seen.has(nonce);
  }

  get size(): number {
    return this.seen.size;
  }
}
