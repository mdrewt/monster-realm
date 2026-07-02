// render/renderResolver.ts — the M8.6b smoothness coordinator (M4c, ADR-0013).
//
// Glue (functional-core/imperative-shell): the pure decision logic lives in
// `SlideClock` (own char) and `interpolate` (remotes); this stateful coordinator
// just routes each stored character to the right one and folds the predicted state
// in for the own entity. It owns ONLY the own `SlideClock` — never reads/writes the
// store or the predictor, and never calls `performance.now()`: `now` is injected, so
// it stays pure-of-IO and trivially testable.
//
// One-way flow (ADR-0013/0014): `server -> store -> resolve -> render`. The own
// character animates on a LOCAL slide clock keyed to the predicted TARGET-TILE (never
// the server's `move_started_at` — that re-stamps every tick and would restart the
// slide, the v1 stutter). Remotes HOLD-not-extrapolate via the interpolation buffer.

import type { WasmCharacterState } from '../convert/convert';
import type { StoredCharacter } from '../net/store';
import { interpDelayMs, interpolate } from './interpolation';
import { SlideClock } from './slideClock';
import type { RenderEntity } from './world';

export interface ResolveInput {
  readonly characters: Iterable<StoredCharacter>;
  /** The own player's entity id, or undefined before login resolves it. */
  readonly ownEntityId: bigint | undefined;
  /** The predictor's current own state, or undefined before the first drain. */
  readonly predicted: WasmCharacterState | undefined;
  /** The predictor's last-drain snap signal: jump the own render, don't animate. */
  readonly snapped: boolean;
  /** Injected render clock (ms) — never `performance.now()` in here. */
  readonly now: number;
  /** M11c (ADR-0067): only render characters in this zone. When undefined, all
   *  characters are rendered (pre-M11c behaviour, used in unit tests). */
  readonly currentZoneId?: number;
}

export class RenderResolver {
  readonly #stepMs: number;
  /** The own character's self-owned slide clock; lazily seeded on first own frame. */
  #ownClock: SlideClock | undefined;

  constructor(stepMs: number) {
    this.#stepMs = stepMs;
  }

  resolve(input: ResolveInput): RenderEntity[] {
    const { characters, ownEntityId, predicted, snapped, now, currentZoneId } = input;
    const renderTime = now - interpDelayMs(this.#stepMs);
    const out: RenderEntity[] = [];

    for (const c of characters) {
      // M11c (ADR-0067): global subscription delivers all zones; only render the current zone.
      if (currentZoneId !== undefined && c.row.zoneId !== currentZoneId) continue;
      const isOwn =
        ownEntityId !== undefined && c.row.entityId === ownEntityId && predicted !== undefined;

      if (isOwn) {
        // Own path: animate from the slide clock keyed to the predicted target tile.
        const tile = { x: predicted.pos.x, y: predicted.pos.y };
        // Lazily seed the clock AT the current tile on first use so the first slide
        // starts from the right origin (no teleport from a stale 0,0).
        this.#ownClock ??= new SlideClock(this.#stepMs, tile, now);
        // Every frame (incl. the seed frame): snapTo on a large-gap signal, else
        // setTarget — a same-tile re-affirm is a SlideClock no-op (anti-stutter).
        if (snapped) this.#ownClock.snapTo(tile, now);
        else this.#ownClock.setTarget(tile, now);
        const pos = this.#ownClock.positionAt(now);
        out.push({
          entityId: c.row.entityId,
          x: pos.x,
          y: pos.y,
          action: predicted.action,
          facing: predicted.facing,
        });
      } else {
        // Interpolation path: remotes, and the own entity during the login/reconnect
        // gap (predicted/ownEntityId absent). Holds at latest past it (no overshoot);
        // sits on latest cleanly when prev is undefined (no throw).
        const pos = interpolate(c.prev, c.latest, renderTime);
        out.push({
          entityId: c.row.entityId,
          x: pos.x,
          y: pos.y,
          action: c.row.action,
          facing: c.row.facing,
        });
      }
    }

    return out;
  }

  /** Drop the own slide clock so a post-reconnect re-seed starts fresh (no stale
   *  pre-reconnect origin). Called from main.ts onReconnect. */
  reset(): void {
    this.#ownClock = undefined;
  }
}
