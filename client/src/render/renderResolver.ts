// render/renderResolver.ts — the M8.6b smoothness coordinator.
//
// Glue (functional-core/imperative-shell): the pure decision logic lives in
// `SlideClock` (own char) and `interpolation.ts` (remotes); this stateful coordinator
// just routes each stored character to the right one and folds the predicted state
// in for the own entity. It owns the own `SlideClock` and each remote's last drawn
// position, and nothing else — it never reads/writes the store or the predictor, and never
// calls `performance.now()`: `now` is injected, so it stays pure-of-IO and trivially testable.
//
// One-way flow: `server -> store -> resolve -> render`. The own
// character animates on a LOCAL slide clock keyed to the predicted TARGET-TILE (never
// the server's `move_started_at` — that re-stamps every tick and would restart the
// slide, the v1 stutter). A remote is drawn in the past from the interpolation buffer and
// HOLDS at its newest snapshot, except on a straight walk: then it is continued at most half
// a tile past its newest tile, toward a walkable tile, until the continuation window after
// its newest step runs out. Its drawn position is walked to each frame's target at no more
// than one tile per step, so a late step, a turn or the end of the window does not jump it;
// only a remote two tiles or more from its target is drawn at the target.

import type { WasmCharacterState } from '../convert/convert';
import type { StoredCharacter } from '../net/store';
import { JITTER_IDLE_GAP_STEPS, REMOTE_SNAP_TILES } from './config';
import {
  adaptiveInterpDelayMs,
  continueWalk,
  interpDelayMs,
  interpolate,
  interpolateHistory,
  interpolateReducedMotion,
  type RenderPos,
  slewToward,
  type Walk,
  walkOf,
} from './interpolation';
import { SlideClock, type SlideTile } from './slideClock';
import type { RenderEntity } from './world';

/**
 * A new authoritative own-target farther than this many tiles
 * (Chebyshev) from the slide clock's CURRENT target is a POSITION jump (server
 * correction / same-zone respawn / dropped-update catch-up), not a step — snap
 * through the existing `snapped` path instead of gliding it over one STEP_MS.
 * `1` because a normal single-axis step is exactly Chebyshev 1 and must still
 * slide (the anti-stutter core). Parallels predictor's `SNAP_GAP_STEPS`.
 */
const SNAP_DIVERGENCE_TILES = 1;

/** Chebyshev (chessboard) tile distance = the largest per-axis gap. Chosen over
 *  Manhattan so a 1-tile diagonal (dx=dy=1) is distance 1 (still slides), not 2. */
function chebyshev(a: SlideTile, b: SlideTile): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

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
  /** Only render characters in this zone. When undefined, all
   *  characters are rendered (pre-M11c behaviour, used in unit tests). */
  readonly currentZoneId?: number;
  /** The OS reduced-motion preference, injected the
   *  same way `now` is — this module never reads a global (`motionPreference.ts` is
   *  the sole owner of that read). OPTIONAL with default false, a declared deviation
   *  from §2.5's required-field wording: S7 may not touch main.ts (spec §4 keeps S7
   *  main.ts-free), so the existing resolve() call there must keep compiling unedited.
   *  S5 wires the live value at that call site and may then tighten it to required. */
  readonly reduceMotion?: boolean;
  /** Whether a character may stand on a tile of the current zone; false outside the map
   *  (`walkableIn`). A remote's walk is continued only toward a tile this allows, so without
   *  it no remote is drawn past its newest authoritative tile. */
  readonly walkable?: (tileX: number, tileY: number) => boolean;
}

/** The walkability predicate over a zone's wasm tile grid (`zone_map()`): a tile outside the
 *  grid, like a fractional coordinate, is not walkable. */
export function walkableIn(grid: {
  readonly width: number;
  readonly height: number;
  readonly walkable: readonly boolean[];
}): (tileX: number, tileY: number) => boolean {
  return (x, y) =>
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < grid.width &&
    y < grid.height &&
    grid.walkable[y * grid.width + x] === true;
}

/** Where a remote was last drawn, and when. */
interface RemoteRender extends RenderPos {
  readonly at: number;
}

export class RenderResolver {
  readonly #stepMs: number;
  /** The own character's self-owned slide clock; lazily seeded on first own frame. */
  #ownClock: SlideClock | undefined;
  /** Where each remote was drawn on the last frame, so a change of target is walked, not
   *  jumped. Rebuilt every frame: a remote that was not drawn (gone from the store, in another
   *  zone, or drawn by the reduced-motion arm) starts over at its target. */
  #remotes = new Map<bigint, RemoteRender>();

  constructor(stepMs: number) {
    this.#stepMs = stepMs;
  }

  resolve(input: ResolveInput): RenderEntity[] {
    const {
      characters,
      ownEntityId,
      predicted,
      snapped,
      now,
      currentZoneId,
      reduceMotion = false,
      walkable,
    } = input;
    const out: RenderEntity[] = [];
    const drawn = new Map<bigint, RemoteRender>();

    for (const c of characters) {
      // The store holds the own zone and any zone whose set still lingers; only the current
      // zone is drawn.
      if (currentZoneId !== undefined && c.row.zoneId !== currentZoneId) continue;
      const isOwn =
        ownEntityId !== undefined && c.row.entityId === ownEntityId && predicted !== undefined;

      if (isOwn) {
        // Own path: animate from the slide clock keyed to the predicted target tile.
        const tile = { x: predicted.pos.x, y: predicted.pos.y };
        // Lazily seed the clock AT the current tile on first use so the first slide
        // starts from the right origin (no teleport from a stale 0,0).
        this.#ownClock ??= new SlideClock(this.#stepMs, tile, now);
        // Snap on the predictor's time-gap signal OR a large authoritative POSITION
        // divergence. Compare against the clock's CURRENT target
        // tile (the spec's referent; positionAt(now) would be frame-timing-sensitive
        // and could under-trigger at slide start). A same-tile re-affirm is a
        // SlideClock no-op (anti-stutter); the seed frame above targets `tile` already
        // → distance 0 → no false snap, and a reset-covered warp re-seeds here → also
        // distance 0 → no double-handling.
        // `reduceMotion` forces the snap arm EVERY frame. That is
        // safe and deliberate: snapTo sets origin === target === tile, so positionAt
        // returns exactly `tile` for any startedAt (the per-frame re-stamp is
        // observationally inert) — and the clock KEEPS TRACKING the predicted tile,
        // so a later reduceMotion:false frame resumes a normal slide from the current
        // integer tile with no teleport (renderResolver.test.ts S7T-OWN-FREEZE pins
        // the tracked-through-the-window consequence).
        const targetGapTiles = chebyshev(tile, this.#ownClock.target);
        if (reduceMotion || snapped || targetGapTiles > SNAP_DIVERGENCE_TILES)
          this.#ownClock.snapTo(tile, now);
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
        // The reduced-motion arm comes FIRST and bypasses BOTH
        // interpolation paths — the remote is drawn at its authoritative row tile,
        // and `now` is not even referenced, so clock-independence holds by
        // construction. It records no drawn position either.
        let pos: RenderPos;
        if (reduceMotion) {
          pos = interpolateReducedMotion(c.row);
        } else {
          pos = this.#remotePosition(c, now, walkable);
          drawn.set(c.row.entityId, { x: pos.x, y: pos.y, at: now });
        }
        // The server writes `Idle` whenever a tick finds the queue empty, between the steps of
        // a walk too. A remote that is not yet drawn on the row's tile is still walking.
        const arrived = pos.x === c.row.tileX && pos.y === c.row.tileY;
        out.push({
          entityId: c.row.entityId,
          x: pos.x,
          y: pos.y,
          action: !arrived && c.row.action === 'Idle' ? 'Walking' : c.row.action,
          facing: c.row.facing,
        });
      }
    }

    this.#remotes = drawn;
    return out;
  }

  /** One remote's position this frame: its target, approached from where it was last drawn. */
  #remotePosition(c: StoredCharacter, now: number, walkable: ResolveInput['walkable']): RenderPos {
    const stepMs = this.#stepMs;
    let target: RenderPos;
    let walk: Walk | undefined;
    // Per-character adaptive render time derived from EWMA jitter.
    // WHY per-character: NPCs and remote players have different jitter profiles;
    // a single global renderTime would over-buffer smooth entities.
    // Backward compat: when snapshots is empty (older fixtures / tests that
    // only supply prev+latest), fall back to the fixed delay + 2-snapshot interpolate.
    if (c.snapshots.length > 0) {
      const windowMs = JITTER_IDLE_GAP_STEPS * stepMs;
      const renderTime = now - adaptiveInterpDelayMs(c.jitterEwma, stepMs);
      walk = walkOf(c.positionChanges ?? [], c.turnedInPlace === true, now, stepMs, windowMs);
      // The stepMs argument arms the idle-gap re-anchor — without it the
      // resume-from-idle fix is inert in production (renderResolver.test.ts pins it). A
      // walking remote's steps arrive up to the window apart, so for it only a longer gap is
      // idle.
      target = interpolateHistory(
        c.snapshots,
        renderTime,
        stepMs,
        walk === undefined ? undefined : windowMs,
      );
      if (
        walk?.ahead !== undefined &&
        renderTime > c.latest.receivedAt &&
        walkable?.(c.latest.tileX + walk.ahead.dx, c.latest.tileY + walk.ahead.dy) === true
      ) {
        target = continueWalk(c.latest, walk.ahead, walk.cadenceMs, renderTime);
      }
    } else {
      target = interpolate(c.prev, c.latest, now - interpDelayMs(stepMs));
    }

    const ahead = walk?.ahead;
    const last = this.#remotes.get(c.row.entityId);
    let pos = target;
    // The remote is drawn AT its target when there is nowhere to walk from: no last position,
    // a clock that moved backward, or `prev` undefined (first sight, or the store's snap on a
    // zone change or a teleport).
    if (last !== undefined && c.prev !== undefined && now - last.at >= 0) {
      // Otherwise it is walked there, unless it has fallen REMOTE_SNAP_TILES behind.
      if (Math.abs(target.x - last.x) + Math.abs(target.y - last.y) < REMOTE_SNAP_TILES)
        pos = slewToward(last, target, (now - last.at) / stepMs);
      if (ahead !== undefined) {
        // On a straight walk the target can step back (the delay grows as a step arrives, a
        // late step re-anchors its bracket, or a burst evicts the snapshot under the render
        // clock). The remote waits for it instead of moving backward.
        const along = (pos.x - last.x) * ahead.dx + (pos.y - last.y) * ahead.dy;
        if (along < 0) pos = { x: pos.x - along * ahead.dx, y: pos.y - along * ahead.dy };
      }
    }
    return pos;
  }

  /** Drop the own slide clock and every remote's last drawn position, so the next frame
   *  re-seeds each from its target (no stale origin). main.ts calls it when it resets
   *  prediction state: on a zone switch and on a reconnect. */
  reset(): void {
    this.#ownClock = undefined;
    this.#remotes.clear();
  }
}
