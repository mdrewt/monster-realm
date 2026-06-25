// render/slideClock.ts — the OWN-character self-owned slide clock (M4b, ADR-0013).
// PURE. The own character animates on a LOCAL visual clock keyed to TARGET-TILE
// changes — it deliberately ignores the server's `move_started_at`. This is the
// core anti-stutter decision: a no-divergence reconcile re-stamps `move_started_at`
// every server tick, so a renderer that animated off it would restart the slide on
// every update (jitter/stutter). Keyed to the target tile instead, a redundant
// re-affirmation of the same tile is a NO-OP, so the slide runs out smoothly.
//
// Two clocks (ADR-0013): the predictor advances logical tiles on STEP_MS; THIS
// clock advances the visual sub-tile slide on its own local time. Never stores or
// sends sub-tile position (render-only).

export interface SlideTile {
  readonly x: number;
  readonly y: number;
}

export interface SlidePos {
  readonly x: number; // fractional tile units
  readonly y: number;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class SlideClock {
  readonly #stepMs: number;
  #origin: SlidePos;
  #target: SlideTile;
  #startedAt: number;

  constructor(stepMs: number, start: SlideTile, now: number) {
    this.#stepMs = stepMs;
    this.#origin = { x: start.x, y: start.y };
    this.#target = start;
    this.#startedAt = now;
  }

  /** The current animated sub-tile position (clamped: holds at target past STEP_MS,
   *  never overshoots). */
  positionAt(now: number): SlidePos {
    const a = clamp01((now - this.#startedAt) / this.#stepMs);
    return {
      x: this.#origin.x + (this.#target.x - this.#origin.x) * a,
      y: this.#origin.y + (this.#target.y - this.#origin.y) * a,
    };
  }

  /** Aim at `tile`. A NEW tile starts a fresh slide from the current animated
   *  position (smooth, never a teleport); the SAME tile is a NO-OP (no restart —
   *  the decoupling that kills v1's stutter). */
  setTarget(tile: SlideTile, now: number): void {
    if (tile.x === this.#target.x && tile.y === this.#target.y) return; // no restart
    this.#origin = this.positionAt(now);
    this.#target = tile;
    this.#startedAt = now;
  }

  /** Snap instantly to `tile` (the predictor's large-gap signal — jump, don't
   *  animate the backlog). */
  snapTo(tile: SlideTile, now: number): void {
    this.#origin = { x: tile.x, y: tile.y };
    this.#target = tile;
    this.#startedAt = now;
  }

  get target(): SlideTile {
    return this.#target;
  }
}
