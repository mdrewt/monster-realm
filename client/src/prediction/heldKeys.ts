// heldKeys.ts — tiny pure held-direction tracking for the integrated loop (M8.6c),
// plus the hold-commit tap/hold discrimination (ADR-0158): a stack-top dir is only
// eligible for CONTINUATION once it has been physically held for the commit threshold,
// which is what closes the r2 "one tap moves 2 tiles" defect. The keydown's FIRST step
// stays ungated — the threshold gates CONTINUATION only (the two main.ts re-issue
// emitters), never the immediate step.
//
// Extracted (like inputGuards.ts) so the held-key fallback + re-issue dedup are
// unit-testable — main.ts is the thin e2e-only wiring. No DOM, no clock: both times
// (press stamp and decision instant) are injected parameters.
import type { WasmDirection } from '../convert/convert';

/**
 * The hold-commit threshold (ms): a held dir earns CONTINUATION re-issues only after
 * being down this long. Squeezed from BOTH sides (ADR-0158):
 *
 * CEILING — `X + framePeriod(30fps) + latency < STEP_MS(200)`: after the ungated first
 * step drains, walk-start step-2 must reach the server before the next movement_tick
 * 200ms later, or the server goes Idle for a slot = visible stutter on every deliberate
 * walk start. Measured min step-2 slack: 22.9ms at X=150, −0.6ms at X=175.
 *
 * FLOOR — `>= 140`: tap coverage. maxSafeTap(X)=X measured across every
 * (fps × tickPhase × scenario) cell, and human taps run 50–150ms, so dropping below
 * 140 re-opens the r2 double-move on the longest ordinary taps.
 */
export const HOLD_COMMIT_MS = 150;

/**
 * Tracks currently-held movement directions as a most-recently-pressed stack so a
 * two-key hold falls back to the still-held key on release (M8.6c, ADR-0013).
 * Each entry carries its own press stamp — INSIDE the stack entry, never a parallel
 * map — so release()/clear() evict the stamp by construction (ADR-0158: a surviving
 * stale stamp is exactly the re-tap double-move mutant).
 */
export class HeldDirections {
  // Ordered array, last element = most-recently-pressed still-held dir. Bounded
  // domain (≤4 dirs), so the `some`/`filter` scans are O(1) in practice.
  #stack: { dir: WasmDirection; pressedAtMs: number }[] = [];

  readonly #holdCommitMs: number;

  constructor(holdCommitMs: number = HOLD_COMMIT_MS) {
    this.#holdCommitMs = holdCommitMs;
  }

  /** Register `dir` as held + make it the active (most-recent), stamped `nowMs`. A
   *  press of an already-held dir is a no-op (no duplicate, no re-stamp — the FIRST
   *  stamp governs, so an OS key-repeat can never restart the commit window). [In real
   *  input this can't double-fire because the keydown e.repeat guard filters OS
   *  repeats — but keep it idempotent.] */
  press(dir: WasmDirection, nowMs: number): void {
    if (!this.#stack.some((e) => e.dir === dir)) this.#stack.push({ dir, pressedAtMs: nowMs });
  }

  /** Remove `dir` from the held set (no-op if not held). Evicts its stamp with it. */
  release(dir: WasmDirection): void {
    this.#stack = this.#stack.filter((e) => e.dir !== dir);
  }

  /** Remove all held dirs — and all stamps (blur / reconnect). */
  clear(): void {
    this.#stack = [];
  }

  /** The most-recently-pressed STILL-HELD dir, or undefined if none held. */
  active(): WasmDirection | undefined {
    return this.#stack[this.#stack.length - 1]?.dir;
  }

  /** The active (stack-top) dir iff it has been held for at least the commit
   *  threshold at `nowMs` (>= semantics), else undefined. The press timestamp never
   *  leaves the class — callers only learn committed-or-not. */
  committedActive(nowMs: number): WasmDirection | undefined {
    const top = this.#stack[this.#stack.length - 1];
    if (top === undefined) return undefined;
    return nowMs - top.pressedAtMs >= this.#holdCommitMs ? top.dir : undefined;
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
