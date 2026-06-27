// heldKeys.ts — tiny pure held-direction tracking for the integrated loop (M8.6c).
//
// Extracted (like inputGuards.ts) so the held-key fallback + re-issue dedup are
// unit-testable — main.ts is the thin e2e-only wiring. No DOM, no clock.
import type { WasmDirection } from '../convert/convert';

/**
 * Tracks currently-held movement directions as a most-recently-pressed stack so a
 * two-key hold falls back to the still-held key on release (M8.6c, ADR-0013).
 */
export class HeldDirections {
  // Ordered array, last element = most-recently-pressed still-held dir. Bounded
  // domain (≤4 dirs), so the `includes`/`filter` scans are O(1) in practice.
  #stack: WasmDirection[] = [];

  /** Register `dir` as held + make it the active (most-recent). A press of an
   *  already-held dir is a no-op (no duplicate). [In real input this can't double-
   *  fire because the keydown e.repeat guard filters OS repeats — but keep it
   *  idempotent.] */
  press(dir: WasmDirection): void {
    if (!this.#stack.includes(dir)) this.#stack.push(dir);
  }

  /** Remove `dir` from the held set (no-op if not held). */
  release(dir: WasmDirection): void {
    this.#stack = this.#stack.filter((d) => d !== dir);
  }

  /** Remove all held dirs (blur / reconnect). */
  clear(): void {
    this.#stack = [];
  }

  /** The most-recently-pressed STILL-HELD dir, or undefined if none held. */
  active(): WasmDirection | undefined {
    return this.#stack[this.#stack.length - 1];
  }
}

/**
 * Pure dedup decision for the frame-loop CONTINUATION re-issue: returns `active`
 * iff a held dir exists AND it is not already the queue tail (else undefined → do
 * not enqueue).
 */
export function reissueDir(
  active: WasmDirection | undefined,
  lastQueuedDir: WasmDirection | undefined,
): WasmDirection | undefined {
  return active !== undefined && active !== lastQueuedDir ? active : undefined;
}
