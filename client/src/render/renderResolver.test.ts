// render/renderResolver.test.ts — M8.6b acceptance suite (vitest, node-only).
//
// SOURCE OF TRUTH: M8.6b "render smoothness wiring" acceptance criteria.
// Every test imports from the (not-yet-existing) renderResolver.ts module so the
// suite starts RED on a missing implementation — that is the intended state.
//
// STEP_MS = 200 throughout. `now` is always injected (never calls performance.now).
//
// Proof-of-teeth (ADR-0010): every critical assertion has an inline BAD-renderer
// model that kills a wrong implementation, making the assertion meaningful (not
// vacuous). Pattern mirrors slideClock.test.ts §"the test bites".

import { describe, expect, it } from 'vitest';
import type { WasmCharacterState } from '../convert/convert';
import type { StoredCharacter } from '../net/store';
import { RenderResolver, type ResolveInput } from './renderResolver';
// ptc5g: standalone BITES fixture (§9 below) drives the pure SlideClock directly,
// alongside (not through) the RenderResolver, to prove the divergence-snap
// assertion is meaningful.
import { SlideClock } from './slideClock';

// ---------------------------------------------------------------------------
// Test-fixture helpers
// ---------------------------------------------------------------------------

const STEP_MS = 200;

/** Build a typed ResolveInput with safe defaults; callers override what they need.
 *  The explicit return type is the load-bearing use of the ResolveInput interface. */
function makeInput(overrides: Partial<ResolveInput>): ResolveInput {
  return {
    characters: [],
    ownEntityId: undefined,
    predicted: undefined,
    snapped: false,
    now: 0,
    ...overrides,
  };
}

/** Build a minimal StoredCharacter. The caller fills in what they need. */
function makeChar(
  entityId: bigint,
  latestTileX: number,
  latestTileY: number,
  latestReceivedAt: number,
  prevTileX?: number,
  prevTileY?: number,
  prevReceivedAt?: number,
): StoredCharacter {
  const latestSnap = { tileX: latestTileX, tileY: latestTileY, receivedAt: latestReceivedAt };
  const prevSnap =
    prevTileX !== undefined && prevReceivedAt !== undefined
      ? { tileX: prevTileX, tileY: prevTileY ?? 0, receivedAt: prevReceivedAt }
      : undefined;
  return {
    row: {
      entityId,
      zoneId: 1,
      tileX: latestTileX,
      tileY: latestTileY,
      facing: 'East',
      action: 'Walking',
      moveStartedAtMs: 0n,
      moveQueue: [],
    },
    receivedAt: latestReceivedAt,
    latest: latestSnap,
    prev: prevSnap,
    // Empty snapshots → resolver falls back to interpolate(prev, latest, fixedDelay)
    // (ADR-0090 backward compat for pre-ADR-0090 fixtures).
    snapshots: [],
    jitterEwma: 0,
  };
}

/** Build a minimal WasmCharacterState at a given tile. */
function makePredicted(
  x: number,
  y: number,
  action: WasmCharacterState['action'] = 'Walking',
  facing: WasmCharacterState['facing'] = 'South',
): WasmCharacterState {
  return { pos: { x, y }, facing, action, move_started_at: 0 };
}

const OWN_ID = 1n;
const REMOTE_ID = 2n;

// ---------------------------------------------------------------------------
// 1. Own entity — fractional mid-motion + the bite (the core proof-of-teeth)
// ---------------------------------------------------------------------------
// This is the central anti-stutter proof: the own character renders at a
// FRACTIONAL sub-tile position during a slide, NOT at the raw integer tile.
// A renderer that feeds `predicted.pos.x` directly returns integer 1 mid-slide
// and FAILS the fractional assertion — proving the assertion is meaningful.

describe('RenderResolver — own entity slide clock: fractional mid-motion', () => {
  it('own entity x is fractional ≈ 0.5 at the midpoint of a 0→1 slide', () => {
    // Drive a real tile change so the SlideClock actually starts.
    // Sequence:
    //   now=0  predicted=(0,0)  snapped=false  → seeds clock at tile (0,0)
    //   now=0  predicted=(1,0)  snapped=false  → setTarget → slide 0→1 starts at t=0
    //   now=100 predicted=(1,0) snapped=false  → positionAt(100) mid-slide → x≈0.5

    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 0, 0, 0); // authoritative position irrelevant for own path

    // Seed at tile (0,0)
    resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(0, 0),
        now: 0,
      }),
    );

    // Change predicted tile to (1,0) — this starts the slide from 0→1 at t=0
    resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(1, 0),
        now: 0,
      }),
    );

    // Mid-slide at now=100: should be at x≈0.5
    const entities = resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(1, 0),
        now: 100,
      }),
    );

    const own = entities.find((e) => e.entityId === OWN_ID);
    expect(own, 'own entity must be in the output').toBeDefined();
    expect(own!.x).toBeCloseTo(0.5, 3);
    expect(Number.isInteger(own!.x)).toBe(false);
  });

  it('BITES: a raw-integer renderer returns integer 1 mid-slide, failing the fractional assertion', () => {
    // Model the BAD renderer: it feeds `predicted.pos.x` directly, which is the
    // target integer tile. At the same state (mid-slide, now=100), it yields 1.
    // This proves the fractional assertion above is NOT vacuous — a wrong impl fails it.
    const predicted = makePredicted(1, 0);
    const rawX = predicted.pos.x; // raw integer tile — what a naive renderer does
    expect(rawX).toBe(1);
    expect(Number.isInteger(rawX)).toBe(true);
    // The fractional assertion WOULD fail: Number.isInteger(rawX) === true, not false.
    // A RenderResolver using raw tile integers can never pass the assertion above.
  });
});

// ---------------------------------------------------------------------------
// 2. Own entity — mid-slide stays fractional (kills "snapTo every frame" impl)
// ---------------------------------------------------------------------------
// If the resolver mistakenly called snapTo() on every frame (instead of setTarget),
// the clock would jump to tile 1 immediately and positionAt would return integer 1.
// This test catches that bug: after a single 0→1 tile change with snapped=false,
// the mid-slide position must be strictly between 0 and 1 (fractional).

describe('RenderResolver — own entity slide: not snapTo on every frame', () => {
  it('snapped=false: own position is strictly between 0 and 1 mid-slide (not integer 1)', () => {
    // A "snapTo every frame" implementation would yield integer 1 here and fail.
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 0, 0, 0);

    // Seed at (0,0)
    resolver.resolve({
      characters: [char],
      ownEntityId: OWN_ID,
      predicted: makePredicted(0, 0),
      snapped: false,
      now: 0,
    });

    // Tile change: 0→1 at t=0 with snapped=false (should call setTarget, NOT snapTo)
    resolver.resolve({
      characters: [char],
      ownEntityId: OWN_ID,
      predicted: makePredicted(1, 0),
      snapped: false,
      now: 0,
    });

    // Mid-slide at now=100: position MUST be fractional (between 0 and 1 exclusive)
    const entities = resolver.resolve({
      characters: [char],
      ownEntityId: OWN_ID,
      predicted: makePredicted(1, 0),
      snapped: false,
      now: 100,
    });

    const own = entities.find((e) => e.entityId === OWN_ID);
    expect(own).toBeDefined();
    // strictly between 0 and 1 — a snapTo-every-frame impl would land on integer 1
    expect(own!.x).toBeGreaterThan(0);
    expect(own!.x).toBeLessThan(1);
    expect(Number.isInteger(own!.x)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Own entity — snapped=true jumps immediately (no animated backlog)
// ---------------------------------------------------------------------------
// When snapped=true, the resolver must call snapTo() (not setTarget()), so the
// own position equals the target tile immediately — no fractional slide.

describe('RenderResolver — own entity slide: snapped=true teleports to target', () => {
  it('snapped=true: own position equals the target tile immediately (integer, no slide)', () => {
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 0, 0, 0);

    // Seed at (0,0)
    resolver.resolve({
      characters: [char],
      ownEntityId: OWN_ID,
      predicted: makePredicted(0, 0),
      snapped: true,
      now: 0,
    });

    // Large tile change with snapped=true: snapTo should place us at (5,0) instantly
    const entities = resolver.resolve({
      characters: [char],
      ownEntityId: OWN_ID,
      predicted: makePredicted(5, 0),
      snapped: true,
      now: 0,
    });

    const own = entities.find((e) => e.entityId === OWN_ID);
    expect(own).toBeDefined();
    // snapTo: position equals the target tile, no animated backlog
    expect(own!.x).toBe(5);
    expect(own!.y).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Own entity absent / predicted undefined — no throw, falls to interpolation
// ---------------------------------------------------------------------------
// When predicted is undefined, the own entity must fall through to the
// interpolation path (not throw). Integer result when prev is undefined.

describe('RenderResolver — own entity absent / predicted undefined', () => {
  it('predicted=undefined: does NOT throw, renders own entity via interpolation', () => {
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 3, 4, 0); // no prev

    expect(() => {
      const entities = resolver.resolve({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: undefined,
        snapped: false,
        now: 500,
      });
      const own = entities.find((e) => e.entityId === OWN_ID);
      expect(own).toBeDefined();
      // Falls to interpolation; no prev → sits on latest (integer)
      expect(own!.x).toBe(3);
      expect(own!.y).toBe(4);
    }).not.toThrow();
  });

  it('ownEntityId=undefined: does NOT throw, all entities use interpolation', () => {
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 2, 2, 0);

    expect(() => {
      const entities = resolver.resolve({
        characters: [char],
        ownEntityId: undefined,
        predicted: makePredicted(9, 9),
        snapped: false,
        now: 500,
      });
      expect(entities.length).toBeGreaterThan(0);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Remote entity — fractional interpolation + the bite
// ---------------------------------------------------------------------------
// Remote entities use the interpolation path (not the slide clock).
// With prev.receivedAt=0, latest.receivedAt=200, stepMs=200 → interpDelayMs=200,
// choosing now=300 → renderTime = 300 - 200 = 100, which is between 0 and 200.
// The result is linearly interpolated to x≈0.5 (FRACTIONAL).
//
// BITE: a raw-latest renderer yields integer 1, failing the fractional assertion.
// DISTINCT receivedAt values are required: equal timestamps degenerate to latest (integer).

describe('RenderResolver — remote entity fractional interpolation', () => {
  it('remote x is fractional ≈ 0.5 at renderTime=100 between snapshots', () => {
    // interpDelayMs(200) === 200   [1.0 × 200]  (M12.5d-1: was 1.5 → 300ms)
    // now=300 → renderTime = 300 - 200 = 100
    // prev={tileX:0, receivedAt:0}, latest={tileX:1, receivedAt:200}
    // lerp at t=100 between 0 and 200 → alpha=0.5 → x=0.5 (FRACTIONAL)
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(REMOTE_ID, 1, 0, 200, 0, 0, 0); // distinct receivedAt: 0 vs 200

    const entities = resolver.resolve({
      characters: [char],
      ownEntityId: OWN_ID, // different from REMOTE_ID → remote path
      predicted: makePredicted(0, 0),
      snapped: false,
      now: 300,
    });

    const remote = entities.find((e) => e.entityId === REMOTE_ID);
    expect(remote, 'remote entity must be in the output').toBeDefined();
    expect(remote!.x).toBeCloseTo(0.5, 3);
    expect(Number.isInteger(remote!.x)).toBe(false);
  });

  it('BITES: a raw-latest renderer returns integer 1, failing the fractional assertion', () => {
    // Model the BAD renderer: feeds c.latest.tileX directly (no interpolation buffer).
    // At the same state, it yields 1 (integer), not 0.5.
    // This proves the fractional assertion above is NOT vacuous — a wrong impl fails it.
    const char = makeChar(REMOTE_ID, 1, 0, 200, 0, 0, 0);
    const rawX = char.latest.tileX; // raw latest snapshot tile — what a naive renderer does
    expect(rawX).toBe(1);
    expect(Number.isInteger(rawX)).toBe(true);
    // The fractional assertion WOULD fail: Number.isInteger(rawX) === true, not false.
  });
});

// ---------------------------------------------------------------------------
// 6. Remote entity — hold-not-extrapolate
// ---------------------------------------------------------------------------
// Past the latest snapshot, the remote position must HOLD at latest (never
// extrapolate). With now=600, renderTime = 600-200 = 400 > latest.receivedAt=200
// → must return x=1 (held at latest), NOT x > 1.

describe('RenderResolver — remote entity hold-not-extrapolate', () => {
  it('remote position holds at latest past the latest snapshot (no overshoot)', () => {
    // now=600 → renderTime = 600 - 200 = 400 > latest.receivedAt=200 → HOLD at x=1
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(REMOTE_ID, 1, 0, 200, 0, 0, 0);

    const entities = resolver.resolve({
      characters: [char],
      ownEntityId: OWN_ID,
      predicted: makePredicted(0, 0),
      snapped: false,
      now: 600,
    });

    const remote = entities.find((e) => e.entityId === REMOTE_ID);
    expect(remote).toBeDefined();
    // Held at latest: x must equal 1, never extrapolated beyond it
    expect(remote!.x).toBe(1);
    expect(remote!.y).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. action/facing passthrough
// ---------------------------------------------------------------------------
// Own entity takes action/facing from predicted; remote takes them from c.row.

describe('RenderResolver — action/facing passthrough', () => {
  it('own entity uses predicted.action and predicted.facing', () => {
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 0, 0, 0);
    // row has action='Walking', facing='East' (from makeChar defaults)
    // predicted has action='Jumping', facing='North'
    const predicted = makePredicted(0, 0, 'Jumping', 'North');

    const entities = resolver.resolve({
      characters: [char],
      ownEntityId: OWN_ID,
      predicted,
      snapped: false,
      now: 0,
    });

    const own = entities.find((e) => e.entityId === OWN_ID);
    expect(own).toBeDefined();
    expect(own!.action).toBe('Jumping'); // from predicted, not from c.row
    expect(own!.facing).toBe('North'); // from predicted, not from c.row
  });

  it('remote entity uses c.row.action and c.row.facing', () => {
    // Build a remote char with distinct row action/facing from predicted
    const char: StoredCharacter = {
      row: {
        entityId: REMOTE_ID,
        zoneId: 1,
        tileX: 0,
        tileY: 0,
        facing: 'West', // the authoritative facing for this remote
        action: 'Idle', // the authoritative action for this remote
        moveStartedAtMs: 0n,
        moveQueue: [],
      },
      receivedAt: 0,
      latest: { tileX: 0, tileY: 0, receivedAt: 0 },
      prev: undefined,
      snapshots: [],
      jitterEwma: 0,
    };

    const resolver = new RenderResolver(STEP_MS);
    const entities = resolver.resolve({
      characters: [char],
      ownEntityId: OWN_ID, // OWN_ID ≠ REMOTE_ID → remote path
      predicted: makePredicted(0, 0, 'Jumping', 'North'), // predicted is for the own, irrelevant
      snapped: false,
      now: 0,
    });

    const remote = entities.find((e) => e.entityId === REMOTE_ID);
    expect(remote).toBeDefined();
    expect(remote!.action).toBe('Idle'); // from c.row, not from predicted
    expect(remote!.facing).toBe('West'); // from c.row, not from predicted
  });
});

// ---------------------------------------------------------------------------
// 8. reset() — drops the own slide clock
// ---------------------------------------------------------------------------
// After driving a slide, reset() must drop the clock so a fresh seed-and-change
// reproduces a fresh slide starting at the new seeded origin (no stale origin from
// before the reset).

describe('RenderResolver — reset() drops the own slide clock', () => {
  it('after reset(), a fresh seed-and-change starts a fresh slide with no stale origin', () => {
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 0, 0, 0);

    // Drive a slide from (0,0) → (5,0)
    resolver.resolve({
      characters: [char],
      ownEntityId: OWN_ID,
      predicted: makePredicted(0, 0),
      snapped: false,
      now: 0,
    });
    resolver.resolve({
      characters: [char],
      ownEntityId: OWN_ID,
      predicted: makePredicted(5, 0),
      snapped: false,
      now: 0,
    });

    // reset() — must drop the clock
    resolver.reset();

    // Fresh seed at (2,0) after the reset (simulates reconnect → new authoritative)
    resolver.resolve({
      characters: [char],
      ownEntityId: OWN_ID,
      predicted: makePredicted(2, 0),
      snapped: false,
      now: 1000, // a new wall-clock epoch after reconnect
    });

    // Tile change (2,0) → (3,0) at t=1000
    resolver.resolve({
      characters: [char],
      ownEntityId: OWN_ID,
      predicted: makePredicted(3, 0),
      snapped: false,
      now: 1000,
    });

    // Mid-slide at now=1100: should be ≈2.5 (fresh slide from 2→3), NOT ≈5.5
    // If the stale clock survived the reset it would interpolate from the old
    // origin (5) → wrong position; the assertion below would fail.
    const entities = resolver.resolve({
      characters: [char],
      ownEntityId: OWN_ID,
      predicted: makePredicted(3, 0),
      snapped: false,
      now: 1100,
    });

    const own = entities.find((e) => e.entityId === OWN_ID);
    expect(own).toBeDefined();
    // Fresh slide 2→3 at mid-point: x ≈ 2.5
    expect(own!.x).toBeCloseTo(2.5, 3);
    // Must NOT be near 5 (stale pre-reset origin)
    expect(own!.x).toBeLessThan(4);
    expect(own!.x).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// 9. ptc5g — own-path position-divergence snap (Chebyshev > 1 tile ⇒ snap, not slide)
// ---------------------------------------------------------------------------
// EARS criterion ptc5g-2: when a NEW authoritative own-target arrives that is
// more than 1 tile away (Chebyshev = max(|dx|,|dy|)) from the slide clock's
// CURRENT target, the own path must SNAP (jump instantly) instead of gliding —
// folded into the existing `snapped` branch of RenderResolver.resolve. Today
// (unmodified source) `resolve` ALWAYS calls `setTarget` when `snapped=false`,
// so even a 10-tile jump glides smoothly across STEP_MS — the anti-teleport-
// glide bug this slice fixes. T2/T3 pin the boundary so the fix cannot
// over-snap (1-tile and 1-tile-diagonal steps must keep sliding).

describe('RenderResolver — ptc5g: position-divergence snap (Chebyshev > 1 tile)', () => {
  it('T1 CORE: a >1-tile authoritative jump SNAPS instead of gliding', () => {
    // Sequence:
    //   now=0   predicted=(0,0)  snapped=false → seeds #ownClock at tile (0,0)
    //   now=0   predicted=(10,0) snapped=false → chebyshev((10,0),(0,0)) = 10 > 1
    //           → must SNAP (jump), not setTarget (glide)
    //   now=100 predicted=(10,0) snapped=false → sample
    //
    // TODAY (RED): resolve() unconditionally calls setTarget on this branch, so
    // the slide clock glides 0→10 over STEP_MS=200; positionAt(100) =
    // 0 + 10 * clamp01(100/200) = 10 * 0.5 = 5 (WRONG — a visible teleport-glide).
    // AFTER THE FIX (GREEN): the large-jump branch calls snapTo instead, so the
    // origin is already (10,0) by t=0; positionAt(100) = 10 (instant, correct).
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 0, 0, 0);

    // Seed at tile (0,0)
    resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(0, 0),
        snapped: false,
        now: 0,
      }),
    );

    // Large jump: chebyshev((10,0), (0,0)) = 10 > 1 → must snap
    resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(10, 0),
        snapped: false,
        now: 0,
      }),
    );

    const entities = resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(10, 0),
        snapped: false,
        now: 100,
      }),
    );

    const own = entities.find((e) => e.entityId === OWN_ID);
    expect(own, 'own entity must be in the output').toBeDefined();
    expect(own!.x).toBe(10);
    expect(own!.y).toBe(0);
    expect(Number.isInteger(own!.x)).toBe(true);
  });

  it('T2 COMPANION: an exactly-1-tile step STILL slides (no false snap)', () => {
    // chebyshev((1,0), (0,0)) = 1, which is NOT > 1 → must keep sliding.
    // GREEN today (current source always slides on snapped=false) AND after the
    // fix (a correct fix only snaps strictly above 1 tile). A fix that snapped
    // on `>= 1` instead of `> 1` would break this test — the anti-over-snap anchor.
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 0, 0, 0);

    resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(0, 0),
        snapped: false,
        now: 0,
      }),
    );

    resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(1, 0),
        snapped: false,
        now: 0,
      }),
    );

    const entities = resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(1, 0),
        snapped: false,
        now: 100,
      }),
    );

    const own = entities.find((e) => e.entityId === OWN_ID);
    expect(own).toBeDefined();
    expect(own!.x).toBeCloseTo(0.5, 3);
    expect(own!.x).toBeGreaterThan(0);
    expect(own!.x).toBeLessThan(1);
    expect(Number.isInteger(own!.x)).toBe(false);
  });

  it('T3 METRIC TOOTH: a 1-tile diagonal step slides (pins Chebyshev, not Manhattan)', () => {
    // chebyshev((1,1), (0,0)) = max(|1|,|1|) = 1 → NOT > 1 → must keep sliding.
    // A wrong implementation using MANHATTAN distance (|dx|+|dy| = 2) would treat
    // this as a >1 jump and snap straight to integer (1,1) — this test bites that
    // wrong metric. GREEN today and after a correct (Chebyshev) fix; RED only
    // under a Manhattan-metric mutation.
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 0, 0, 0);

    resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(0, 0),
        snapped: false,
        now: 0,
      }),
    );

    resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(1, 1),
        snapped: false,
        now: 0,
      }),
    );

    const entities = resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(1, 1),
        snapped: false,
        now: 100,
      }),
    );

    const own = entities.find((e) => e.entityId === OWN_ID);
    expect(own).toBeDefined();
    expect(own!.x).toBeCloseTo(0.5, 3);
    expect(own!.y).toBeCloseTo(0.5, 3);
    expect(Number.isInteger(own!.x)).toBe(false);
  });

  it('T4 BITES (inline mutation proof for T1): a setTarget-only clock GLIDES across the jump', () => {
    // Models the OLD (pre-ptc5g) mechanism directly on the pure SlideClock: a
    // clock that only ever calls setTarget (never snapTo) glides across a
    // 10-tile jump instead of snapping. This proves the T1 snap assertion is
    // meaningful — removing the `> 1` divergence branch (i.e. reverting to
    // always-setTarget) re-fails T1's `own.x === 10` assertion, landing back
    // on 5 exactly as this fixture demonstrates.
    const clock = new SlideClock(STEP_MS, { x: 0, y: 0 }, 0); // seeded at (0,0)
    clock.setTarget({ x: 10, y: 0 }, 0); // OLD behavior: setTarget, not snapTo

    const mid = clock.positionAt(100);

    expect(mid.x).toBeCloseTo(5, 3);
    expect(mid.x).not.toBe(10);
  });

  it('T5 REFERENT TOOTH: a mid-slide continuation compares against .target, not positionAt(now) (slides, no false snap)', () => {
    // ADR-0141 sub-decision 1: the divergence check must compare the new
    // authoritative target against the slide clock's CURRENT COMMITTED TARGET
    // (`.target`), NOT its animated `positionAt(now)`. This test discriminates
    // the two referents (symmetric with T3's metric pin, but for the referent
    // instead of the metric).
    //
    // Sequence:
    //   now=0   predicted=(0,0) snapped=false → seeds #ownClock at (0,0)
    //   now=0   predicted=(1,0) snapped=false → chebyshev((1,0),(0,0))=1, not >1
    //           → slides; slide 0→1 starts at t=0 (target becomes (1,0))
    //   now=150 predicted=(2,0) snapped=false → MID-slide sample; positionAt(150)
    //           on the in-flight 0→1 slide would be 0.75 (NOT yet at target 1).
    //
    // SHIPPED semantics (compare vs `.target` = (1,0)):
    //   chebyshev((2,0), (1,0)) = 1, NOT > 1 → setTarget (slide continues).
    //   setTarget re-roots the origin at the current animated position (0.75),
    //   so resolve() returns own.x ≈ 0.75 (FRACTIONAL, GREEN).
    //
    // REJECTED alternative (compare vs `positionAt(150)` = (0.75, 0)):
    //   chebyshev((2,0), (0.75,0)) = 1.25 > 1 → would wrongly snapTo → own.x
    //   would be integer 2 — a fragmented multi-frame delivery force-snapped
    //   mid-slide, which is exactly the "memoryless-by-committed-target"
    //   semantics ADR-0141 rejects (consecutive ≤1-tile targets should each
    //   slide, never snap, even if sampled mid-animation).
    //
    // So this test is GREEN on the shipped (target-referent) code and RED if
    // someone ever swaps `.target` for `positionAt(now)` in the divergence check.
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 0, 0, 0);

    // Seed at (0,0)
    resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(0, 0),
        snapped: false,
        now: 0,
      }),
    );

    // Normal step: chebyshev((1,0),(0,0))=1 → slides; slide 0→1 starts at t=0
    resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(1, 0),
        snapped: false,
        now: 0,
      }),
    );

    // MID-slide (positionAt(150) on the 0→1 slide would be 0.75). New target (2,0).
    const entities = resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted: makePredicted(2, 0),
        snapped: false,
        now: 150,
      }),
    );

    const own = entities.find((e) => e.entityId === OWN_ID);
    expect(own).toBeDefined();
    expect(Number.isInteger(own!.x)).toBe(false);
    expect(own!.x).toBeLessThan(2);
    expect(own!.x).toBeCloseTo(0.75, 3);
  });
});

// ---------------------------------------------------------------------------
// 10. 11r-f (ADR-0171) — resolver wiring + evolving-D bounded wobble
// ---------------------------------------------------------------------------
// SOURCE OF TRUTH: docs/adr/0171-resume-from-idle-interpolation.md — D3 ("the sole
// production consumer passes its existing #stepMs") and Consequences ("bounded
// evolving-D wobble", closed-form worst case 0.2 tile) — plus spec
// M-postgate-eleventh-review-residuals §11r-f EARS E1.
//
// These two tests drive the REAL AuthoritativeStore(200) through the REAL
// RenderResolver(200) instead of hand-built StoredCharacter fixtures, because the
// SEAM is the thing under test: the store's idle-gated EWMA feeds the resolver's
// adaptive delay, and the resolver must forward its own `#stepMs` into
// `interpolateHistory`. Every fixture in §§1-9 above uses `snapshots: []` and takes
// the legacy 2-snapshot fallback — they are deliberately left untouched.
//
// RED REASON (before impl), both tests: (a) the store's ungated EWMA turns the 5 s
// idle into jitterEwma ~600, so the adaptive delay clamps to 500 ms; and (b)
// `resolve()` calls `interpolateHistory(c.snapshots, now - delay)` with two
// arguments, so the whole 5000 ms bracket is lerped — the resume frame pops ~0.9
// tile and the trailing crawl never reaches the new tile inside the walk.
import { AuthoritativeStore, type StoreCharacter } from '../net/store';

describe('11r-f resolver wiring + evolving-D (ADR-0171)', () => {
  const NPC_ID = 7n;
  const FRAME_MS = 16;

  /** An authoritative character row shaped as the SDK boundary converter emits it. */
  function row(entityId: bigint, tileX: number, tileY: number): StoreCharacter {
    return {
      entityId,
      zoneId: 1,
      tileX,
      tileY,
      facing: 'East',
      action: 'Walking',
      moveStartedAtMs: 0n,
      moveQueue: [],
    };
  }

  /** Resolve one frame for a NON-own entity (ownEntityId undefined → remote path)
   *  and return its rendered x. `currentZoneId` is omitted → no zone filtering. */
  function renderX(store: AuthoritativeStore, resolver: RenderResolver, now: number): number {
    const entities = resolver.resolve({
      characters: [...store.characters()],
      ownEntityId: undefined,
      predicted: undefined,
      snapped: false,
      now,
    });
    const npc = entities.find((e) => e.entityId === NPC_ID);
    expect(npc, 'the remote NPC must be in the resolver output').toBeDefined();
    return npc!.x;
  }

  it('(xviii) E1 LIVENESS: resolve() renders a post-idle 1-tile step as one <= stepMs slide', () => {
    // THE TEST THAT KILLS "renderResolver.ts does not pass stepMs" (its sibling (xix)
    // depends on the same wiring, but this is the headline E1 walk). Every test in
    // interpolation.test.ts calls `interpolateHistory` DIRECTLY, so all of them stay
    // green if the one-line consumer wiring at renderResolver.ts:110 is reverted or
    // never written — the fix would be inert in production and only this describe
    // would notice. Do not delete it as "an integration duplicate of case (v)".
    const store = new AuthoritativeStore(STEP_MS);
    const resolver = new RenderResolver(STEP_MS);

    // The NPC has stood on (5,5) since t=1000.
    store.upsertCharacter(row(NPC_ID, 5, 5), 1000);

    let resumeApplied = false;
    const times: number[] = [];
    const xs: number[] = [];
    for (let now = 5900; now <= 6450; now += FRAME_MS) {
      // The resume row lands on the wire at wall-clock 6000, between two frames.
      // Interval 5000 > 3 x 200 → the D1 gate keeps jitterEwma at 0 → delay = 200.
      if (!resumeApplied && now >= 6000) {
        store.upsertCharacter(row(NPC_ID, 6, 5), 6000);
        resumeApplied = true;
      }
      times.push(now);
      xs.push(renderX(store, resolver, now));
    }
    expect(resumeApplied).toBe(true);
    expect(store.character(NPC_ID)!.jitterEwma).toBe(0); // precondition: idle is not jitter

    expect(xs[0]).toBe(5); // rests on the old tile until the slide window opens
    expect(xs[xs.length - 1]).toBe(6); // fully arrived by the end of the walk
    expect(xs[xs.length - 1]! - xs[0]!).toBe(1); // exactly one tile of travel

    let maxDelta = 0;
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]!).toBeGreaterThanOrEqual(xs[i - 1]!); // never back-steps
      maxDelta = Math.max(maxDelta, Math.abs(xs[i]! - xs[i - 1]!));
    }
    // <= 0.08 tile per 16 ms frame. Today the resume frame moves ~0.90 tile in one
    // frame (delay clamped to 500 → renderTime 5512 → a = 0.9024 on the raw span).
    expect(maxDelta).toBeLessThanOrEqual(FRAME_MS / STEP_MS + 1e-9);

    // and the transition completes inside one step (+ one frame of sampling slack)
    const lastOnOldTile = xs.lastIndexOf(5);
    const firstOnNewTile = xs.indexOf(6);
    expect(lastOnOldTile).toBeGreaterThanOrEqual(0);
    expect(firstOnNewTile).toBeGreaterThan(lastOnOldTile);
    expect(times[firstOnNewTile]! - times[lastOnOldTile]!).toBeLessThanOrEqual(STEP_MS + FRAME_MS);
  });

  it('(xix) T-A: an EWMA bump one frame after the resume back-steps <= 0.2 tile and never below the old tile', () => {
    // Pins the ACCEPTED residual of ADR-0171 (Consequences → "bounded evolving-D
    // wobble") and its closed form. RenderResolver recomputes the adaptive delay
    // EVERY frame, so an arrival that moves the EWMA moves `renderTime` backward;
    // inside a re-anchored (stepMs-wide) window that reads as a back-step of
    // min(a_before, dD/stepMs) tiles — worst case 0.2 tile, floored at `prev` by the
    // dead zone. This is the same wobble class ordinary brackets already exhibit
    // (ADR-0090 accepted it); the test exists so the bound cannot silently grow.
    const store = new AuthoritativeStore(STEP_MS);
    const resolver = new RenderResolver(STEP_MS);

    store.upsertCharacter(row(NPC_ID, 0, 0), 1000); // A: idle on (0,0)
    store.upsertCharacter(row(NPC_ID, 1, 0), 6000); // B: resume step; interval 5000 → GATED
    expect(store.character(NPC_ID)!.jitterEwma).toBe(0); // precondition (today: 600)

    // Frame 1 — clean estimator → delay 200 → renderTime 5839.9.
    // Bracket A->B, rawSpan 5000 > 400 → window [5800, 6000] → a = 39.9/200 = 0.1995.
    const before = renderX(store, resolver, 6039.9);
    expect(before).toBeCloseTo(0.1995, 6);

    // C arrives 40 ms after B — the closed-form worst case. Interval 40 <= 600 →
    // ADMITTED; deviation |40-200| = 160 → ewma = 0.125*160 + 0.875*0 = 20
    // → delay = clamp(200 + 2*20, 100, 500) = 240.
    store.upsertCharacter(row(NPC_ID, 2, 0), 6040);
    expect(store.character(NPC_ID)!.jitterEwma).toBe(20);

    // Frame 2 — renderTime 6040.1 - 240 = 5800.1: STILL the A->B bracket, now only
    // 0.1 ms into its window → a = 0.0005. The render clock stepped backward 40 ms.
    const after = renderX(store, resolver, 6040.1);
    expect(after).toBeCloseTo(0.0005, 6);

    expect(before - after).toBeLessThanOrEqual(0.2 + 1e-3); // the pinned closed-form bound
    expect(after).toBeGreaterThanOrEqual(0); // dead-zone floor: never behind `prev`
  });

  it('(x) T-B: a uniform 700 ms cadence renders hold-then-slide per step, EWMA frozen at base delay', () => {
    // PINS A DELIBERATE SHAPE, NOT A BUG. ADR-0171 Consequences → "Slow-cadence
    // movers render hold-then-slide, deliberately" (red-team Finding B, adjudicated
    // INTENDED in PLAN v2). An entity whose rows arrive uniformly every 700 ms
    // (> 2 x stepMs) renders as rest → one stepMs slide per step: exactly the own
    // player's SlideClock motion language (slide stepMs, rest until the next step).
    // The pre-fix "smooth crawl" (one tile of continuous drift per 700 ms) is the
    // DEFECT class the spec names, not a virtue.
    //
    // Every interval here is > 3 x stepMs, so the D1 gate freezes the EWMA at 0.
    // That is BY DESIGN, not lost adaptation: the re-anchor makes wide-bracket
    // rendering independent of the span, so no delay adaptation is needed there, and
    // the delay stays at its 200 ms base instead of inflating toward the 500 ms
    // clamp. Sustained NETWORK degradation does not produce this shape — a stalled
    // connection burst-delivers (small intra-burst intervals still update the EWMA,
    // case (xii) in store.test.ts) or delivers a multi-tile delta that trips
    // shouldSnap (M12.5d-2, case (xv)).
    const store = new AuthoritativeStore(STEP_MS);
    const resolver = new RenderResolver(STEP_MS);

    // tile x = 0 @1000, 1 @1700, 2 @2400, 3 @3100, 4 @3800 — every interval 700 ms.
    const ARRIVALS = [1000, 1700, 2400, 3100, 3800];
    store.upsertCharacter(row(NPC_ID, 0, 0), ARRIVALS[0]!); // first sight

    let nextArrival = 1;
    const times: number[] = [];
    const xs: number[] = [];
    for (let now = 1000; now <= 4100; now += FRAME_MS) {
      while (nextArrival < ARRIVALS.length && now >= ARRIVALS[nextArrival]!) {
        const at = ARRIVALS[nextArrival]!;
        store.upsertCharacter(row(NPC_ID, nextArrival, 0), at);
        // CLAUSE 1 — the gate fires on EVERY arrival (700 > 3 x 200), so the estimate
        // never leaves 0 and the delay never leaves its 200 ms base.
        // WRONG IMPL KILLED: a gate that admits intervals above 3 x stepMs. Today the
        // ungated EWMA walks 62.5 -> 117.1875 -> 165.0390625 -> 206.9091796875
        // (deviation |700-200| = 500 every time), clamping the delay at 500 ms from
        // the third arrival onward — sustained lag inflation from pure cadence.
        expect(store.character(NPC_ID)!.jitterEwma).toBe(0);
        // CLAUSE 2a — sampled at exactly the arrival wall clock, renderTime sits on
        // the dead-zone edge (next - stepMs), so the render is EXACTLY the OLD tile:
        // the character holds first and slides after. An implementation that slides
        // across the whole 700 ms bracket is already fractional here.
        expect(renderX(store, resolver, at)).toBe(nextArrival - 1);
        nextArrival++;
      }
      times.push(now);
      xs.push(renderX(store, resolver, now));
    }
    expect(nextArrival).toBe(ARRIVALS.length); // every arrival was applied
    expect(store.character(NPC_ID)!.jitterEwma).toBe(0); // still frozen after the walk

    // CLAUSE 3 — no pop anywhere in the walk, bracket SEAMS included.
    // WRONG IMPL KILLED: today the per-frame delay grows with the ungated EWMA
    // (325 -> 434.375 -> 500 ms), stepping renderTime ~109 ms backward at an arrival —
    // a ~0.16-tile lurch on the 700 ms raw span, twice the per-frame budget.
    let maxDelta = 0;
    for (let i = 1; i < xs.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(xs[i]! - xs[i - 1]!));
    }
    expect(maxDelta).toBeLessThanOrEqual(FRAME_MS / STEP_MS + 1e-9);

    // CLAUSE 2b — hold-then-slide per bracket: every 1-tile step has a real rest
    // plateau on the previous tile and completes within one stepMs (+ up to one
    // frame of sampling slack at each end, the same allowance as the property walk
    // in interpolation.test.ts). Under the legacy whole-bracket crawl there is no
    // exact-integer plateau at all between the first and last tiles.
    for (let tile = 1; tile < ARRIVALS.length; tile++) {
      const lastOnPrevTile = xs.lastIndexOf(tile - 1);
      const firstOnTile = xs.indexOf(tile);
      expect(lastOnPrevTile).toBeGreaterThanOrEqual(0); // the rest plateau exists
      expect(firstOnTile).toBeGreaterThan(lastOnPrevTile); // ... and precedes the slide
      expect(times[firstOnTile]! - times[lastOnPrevTile]!).toBeLessThanOrEqual(
        STEP_MS + 2 * FRAME_MS,
      );
    }
    expect(xs[0]).toBe(0); // starts at rest on the first tile
    expect(xs[xs.length - 1]).toBe(4); // and ends at rest on the last
  });

  it('(H-E) BITES: the resolver forwards its OWN stepMs, not a hardcoded 200', () => {
    // Kills `interpolateHistory(c.snapshots, now - delay, 200)` — a wiring cheat
    // verified live to pass every other test in the repository, because EVERY other
    // resolver fixture (this describe included) constructs RenderResolver(200) and so
    // cannot tell the field from the literal. This one runs at stepMs = 50.
    //
    // A hand-built StoredCharacter (the §§1-9 idiom) rather than a real store: at
    // stepMs=50 the store's own gate ADMITS the 150 ms interval (150 <= 3 x 50) and
    // moves jitterEwma off 0 — store behaviour, not the wiring under test. Pinning
    // jitterEwma = 0 isolates the one argument this test exists for.
    //
    // Ring span 1150 - 1000 = 150 ms:
    //   correct (stepMs = 50): 150 >  2 x 50  = 100 → RE-ANCHOR, window [1100, 1150]
    //   cheat   (literal 200): 150 >  2 x 200 = 400 is FALSE → legacy lerp over 150 ms
    // delay = adaptiveInterpDelayMs(0, 50) = clamp(50 + 0, 25, 125) = 50 under BOTH,
    // so the third argument is the only difference between them.
    const resolver50 = new RenderResolver(50);
    const remote: StoredCharacter = {
      row: {
        entityId: NPC_ID,
        zoneId: 1,
        tileX: 1,
        tileY: 0,
        facing: 'East',
        action: 'Walking',
        moveStartedAtMs: 0n,
        moveQueue: [],
      },
      receivedAt: 1150,
      latest: { tileX: 1, tileY: 0, receivedAt: 1150 },
      prev: { tileX: 0, tileY: 0, receivedAt: 1000 },
      snapshots: [
        { tileX: 0, tileY: 0, receivedAt: 1000 },
        { tileX: 1, tileY: 0, receivedAt: 1150 },
      ],
      jitterEwma: 0,
    };
    const at = (now: number): number => {
      const out = resolver50.resolve({
        characters: [remote],
        ownEntityId: undefined,
        predicted: undefined,
        snapped: false,
        now,
      });
      const npc = out.find((e) => e.entityId === NPC_ID);
      expect(npc, 'the remote must be in the resolver output').toBeDefined();
      return npc!.x;
    };

    // now 1125 → renderTime 1075 <= lower 1100 → dead zone → EXACTLY the old tile.
    //   200-literal cheat: legacy a = (1075 - 1000)/150 = 0.5 → x = 0.5.
    expect(at(1125)).toBe(0);
    // now 1175 → renderTime 1125, inside the re-anchored window:
    //   a = (1125 - 1100)/50 = 0.5 → x = 0.5.
    //   200-literal cheat: a = (1125 - 1000)/150 = 0.8333... → x = 0.8333333333333334.
    expect(at(1175)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// 11. m23-s7 — reduced motion (A11Y-27)
// ---------------------------------------------------------------------------
// SOURCE OF TRUTH: M23-accessibility.spec.md §2.5 — under the OS reduced-motion
// preference the renderer draws every character AT its logical tile: the own
// character at the PREDICTED tile, remotes at their AUTHORITATIVE row tile. No
// sub-tile slide, no interpolation buffer, no dependence on `now`. `reduceMotion` is
// injected the way `now` is — a ResolveInput field — never a media query read from
// inside the renderer (A11Y-28; the source scan for that lives in
// motionPreference.test.ts).
//
// RED BEFORE THE IMPL: `ResolveInput` has no `reduceMotion` field yet, so every
// fixture below is resolved by today's slide/interpolate code and each position
// assertion reds on a concrete wrong number (each test names its own).
//
// FIXTURE NOTE (plan §5 AP1/AP4): makeChar builds row === latest, and the own-path
// tests above additionally keep predicted === row — a MONOCULTURE that cannot tell
// "renders the predicted tile" from "renders the authoritative row" or "renders the
// interpolated snapshot". The decoupled fixtures below are describe-local and
// deliberately violate the store's row/snapshot agreement for exactly that reason.
// makeInput / makeChar / makePredicted are used but never modified.

describe('m23-s7 reduced motion (A11Y-27)', () => {
  /** Resolve ONE own-path frame and return the own entity's rendered position.
   *  Fails loud when the own entity is missing — a filtered-out entity must never
   *  read as a passing position assertion. */
  function ownPos(
    resolver: RenderResolver,
    char: StoredCharacter,
    predicted: WasmCharacterState,
    now: number,
    reduceMotion: boolean,
  ): { readonly x: number; readonly y: number } {
    const entities = resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID,
        predicted,
        snapped: false,
        now,
        reduceMotion,
      }),
    );
    const own = entities.find((e) => e.entityId === OWN_ID);
    expect(own, 'the own entity must be in the resolver output').toBeDefined();
    return { x: own!.x, y: own!.y };
  }

  /** Resolve ONE remote-path frame and return the remote entity's rendered position. */
  function remotePos(
    resolver: RenderResolver,
    char: StoredCharacter,
    now: number,
    reduceMotion: boolean,
  ): { readonly x: number; readonly y: number } {
    const entities = resolver.resolve(
      makeInput({
        characters: [char],
        ownEntityId: OWN_ID, // != REMOTE_ID -> the remote path
        predicted: makePredicted(0, 0),
        snapped: false,
        now,
        reduceMotion,
      }),
    );
    const remote = entities.find((e) => e.entityId === REMOTE_ID);
    expect(remote, 'the remote entity must be in the resolver output').toBeDefined();
    return { x: remote!.x, y: remote!.y };
  }

  /** An OWN character whose authoritative row sits wherever the caller says — used
   *  to park the row far away from the predicted tile. */
  function ownRowAt(tileX: number, tileY: number): StoredCharacter {
    return {
      row: {
        entityId: OWN_ID,
        zoneId: 1,
        tileX,
        tileY,
        facing: 'East',
        action: 'Walking',
        moveStartedAtMs: 0n,
        moveQueue: [],
      },
      receivedAt: 0,
      latest: { tileX, tileY, receivedAt: 0 },
      prev: undefined,
      snapshots: [],
      jitterEwma: 0,
    };
  }

  const REMOTE_PREV = { tileX: 4, tileY: 5, receivedAt: 0 };
  const REMOTE_LATEST = { tileX: 5, tileY: 5, receivedAt: 200 };

  /** The DECOUPLED remote fixture (plan §8 RT-3). The authoritative row sits on
   *  (9,9) while every snapshot sits on (4,5)/(5,5).
   *
   *  WHY it violates a production invariant on purpose: the store keeps `row` and
   *  `latest` in agreement (makeChar copies one into the other), so with a faithful
   *  fixture "renders c.row" and "renders the newest snapshot" are indistinguishable
   *  — and the reduced-motion arm is specified to read c.row. Pulling them apart is
   *  the only way this suite can see which field the new arm actually uses. Each
   *  test asserts the decoupling itself before it asserts on the render. */
  function remoteDecoupled(withHistory: boolean): StoredCharacter {
    return {
      row: {
        entityId: REMOTE_ID,
        zoneId: 1,
        tileX: 9,
        tileY: 9,
        facing: 'East',
        action: 'Walking',
        moveStartedAtMs: 0n,
        moveQueue: [],
      },
      receivedAt: 200,
      latest: REMOTE_LATEST,
      prev: REMOTE_PREV,
      // withHistory=true -> the ADR-0090 interpolateHistory arm; false -> the legacy
      // 2-snapshot interpolate arm. Both must be bypassed under reduced motion.
      snapshots: withHistory ? [REMOTE_PREV, REMOTE_LATEST] : [],
      jitterEwma: 0,
    };
  }

  it('S7T-OWN-PRED: the own entity renders the PREDICTED tile, never the authoritative row', () => {
    // THE desync-critical cheat this kills (plan §6 R1): an own path that reads
    // `c.row.tileX/tileY` under reduceMotion. Every other own-path test in this file
    // drives predicted and row to the same tile, so none of them can see it — this is
    // the only own fixture where the two disagree.
    const resolver = new RenderResolver(STEP_MS);
    const char = ownRowAt(9, 9);
    // fixture self-check: the row really does disagree with the predicted tile
    expect(char.row.tileX).not.toBe(3);
    expect(char.row.tileY).not.toBe(7);

    // Frame 1 — the lazy clock seed and the reduced-motion frame in one: exactly the
    // predicted tile. TODAY (RED): the own path renders the slide clock, which is
    // seeded at the predicted tile too, so this first frame alone is NOT the tooth —
    // frame 2 is.
    expect(ownPos(resolver, char, makePredicted(3, 7), 0, true)).toEqual({ x: 3, y: 7 });

    // Frame 2 — 100 s later, nothing else changed: STILL exactly the predicted tile.
    // Under reduced motion the rendered position is a function of the predicted tile
    // ALONE and never of `now`.
    const later = ownPos(resolver, char, makePredicted(3, 7), 100000, true);
    expect(later).toEqual({ x: 3, y: 7 });

    // SECOND DATA POINT (plan §8 RT-6) — NEGATIVE tiles on a fresh resolver, so the
    // clock is seeded from scratch. WRONG IMPLS KILLED that positive-only fixtures
    // cannot see: a clamp-to-zero (`Math.max(0, x)`), an abs(), or a
    // floor-toward-zero of the predicted tile.
    const negResolver = new RenderResolver(STEP_MS);
    const negChar = ownRowAt(9, 9);
    const seeded = ownPos(negResolver, negChar, makePredicted(-2, -5), 0, true);
    expect(seeded).toEqual({ x: -2, y: -5 });

    // ... and a 1-tile step under reduced motion lands ON the new tile immediately.
    // TODAY (RED): the slide clock renders -2 at the transition frame (an ordinary
    // 1-tile step re-roots the origin) and -1.5 half a step later.
    const stepped = ownPos(negResolver, negChar, makePredicted(-1, -5), 100, true);
    expect(stepped).toEqual({ x: -1, y: -5 });
    const settled = ownPos(negResolver, negChar, makePredicted(-1, -5), 200, true);
    expect(settled).toEqual({ x: -1, y: -5 });
  });

  it('S7T-OWN-FREEZE: reduced motion KEEPS the slide clock tracking — a frozen clock lands a tile behind on resume', () => {
    // THE SHARPEST TOOTH IN THIS SLICE (plan §8 RT-1). The cheat it kills:
    //   if (reduceMotion) { pos = tile; }          // <-- never touches #ownClock
    //   else { ...the normal snapTo/setTarget path... }
    // That cheat passes every "renders the exact tile while reduced motion is on"
    // assertion in this file and only shows itself on the frame AFTER the user turns
    // reduced motion back off — as a phantom step the player never took.
    //
    // WHY THE LAG MUST BE EXACTLY ONE TILE: with a 2-tile lag the resume frame trips
    // the ptc5g divergence snap (chebyshev > SNAP_DIVERGENCE_TILES = 1) and the cheat
    // lands on the right tile anyway — such a fixture looks green and proves nothing.
    // At exactly 1 tile, chebyshev === 1 is NOT > 1, so the stale clock takes the
    // ordinary setTarget path and slides in from where it was frozen.
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 0, 0, 0);

    // f1 — reduced motion OFF: seed the clock at (0,0) at t=0.
    expect(ownPos(resolver, char, makePredicted(0, 0), 0, false)).toEqual({ x: 0, y: 0 });

    // f2 — reduced motion ON, one tile east at t=200: exactly the predicted tile.
    //   correct impl: snapTo((1,0), 200) -> origin === target === (1,0)
    //   frozen-clock cheat: also (1,0) here — it passes this line.
    expect(ownPos(resolver, char, makePredicted(1, 0), 200, true)).toEqual({ x: 1, y: 0 });

    // f3 — reduced motion OFF again at t=400, SAME predicted tile (1,0):
    //   correct impl: chebyshev((1,0), target=(1,0)) === 0 -> setTarget is a no-op and
    //     positionAt(400) is still exactly (1,0);
    //   frozen-clock cheat: the target is the stale (0,0), chebyshev === 1 (NOT > 1),
    //     so setTarget((1,0), 400) re-roots the origin at (0,0) and RESTARTS the slide
    //     -> positionAt(400) === 0. THIS is the assertion that bites.
    expect(ownPos(resolver, char, makePredicted(1, 0), 400, false)).toEqual({ x: 1, y: 0 });

    // f4 — steady state half a step later: still exactly (1,0). The cheat's restarted
    // slide reads 0.5 here (100/200 of one tile).
    expect(ownPos(resolver, char, makePredicted(1, 0), 500, false)).toEqual({ x: 1, y: 0 });
  });

  it('S7T-OWN-MIDSLIDE: the same 0->1 step renders the integer target with reduced motion and 0.5 without', () => {
    // The A/B pair. Kills BOTH halves of the flag bug space in one test:
    //   flag IGNORED  -> the reduced-motion arm reads 0.5 (the slide), red below;
    //   flag INVERTED -> the plain arm reads 1 (no slide), red below.
    // The final `not.toBe` makes the pair load-bearing: an implementation that
    // returned the same number for both flag values fails it even if one arm happens
    // to match its expectation.
    const seedThenStep = (reduceMotion: boolean): { readonly x: number; readonly y: number } => {
      const resolver = new RenderResolver(STEP_MS);
      const char = makeChar(OWN_ID, 0, 0, 0);
      ownPos(resolver, char, makePredicted(0, 0), 0, reduceMotion); // seed at (0,0)
      ownPos(resolver, char, makePredicted(1, 0), 0, reduceMotion); // step 0->1 at t=0
      return ownPos(resolver, char, makePredicted(1, 0), 100, reduceMotion); // mid-slide
    };

    const reduced = seedThenStep(true);
    const normal = seedThenStep(false);

    // Reduced motion: exactly the target tile, no sub-tile fraction at all.
    expect(reduced).toEqual({ x: 1, y: 0 });
    expect(Number.isInteger(reduced.x)).toBe(true);

    // Normal motion: the pre-S7 half-step. EXACT, not approximate — STEP_MS is 200
    // and 100/200 is 0.5 exactly in IEEE-754, so there is no rounding slack to hide
    // an off-by-a-frame implementation in.
    expect(normal).toEqual({ x: 0.5, y: 0 });
    expect(Number.isInteger(normal.x)).toBe(false);

    expect(reduced.x).not.toBe(normal.x); // the flag actually discriminates
  });

  it('S7T-OWN-RESUME: turning reduced motion OFF mid-walk RESUMES the slide from the integer tile (no teleport)', () => {
    // Corrected T-h1 (plan §8 R-MAJ-1). The original arithmetic was impossible:
    // resolve() calls positionAt with the SAME `now` it just passed to setTarget, so
    // the transition frame ALWAYS renders the slide's origin. The tooth is therefore
    // "origin at f2, half a tile at f3", not "half a tile at f2".
    //
    // WHAT THIS PROVES: reduced motion leaves the clock's ORIGIN and TARGET on the
    // integer tile, so the first normal frame after it is turned off starts a clean
    // one-tile slide. WRONG IMPLS KILLED: an own path that bypasses the clock while
    // reduced motion is on and then teleports (f2 reads 2 — its stale clock is two
    // tiles behind, which trips the ptc5g divergence snap), and one that resumes by
    // jumping to the new tile instead of sliding to it (f3 reads 2, not 1.5).
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 1, 0, 0);

    // f0 — reduced motion OFF: seed the clock at (0,0) at t=0.
    expect(ownPos(resolver, char, makePredicted(0, 0), 0, false)).toEqual({ x: 0, y: 0 });

    // f1 — reduced motion ON, one tile east at t=100: exactly the tile, mid-step.
    // TODAY (RED): this is an ordinary 1-tile step, so the clock starts a slide here
    // and renders its origin, 0.
    expect(ownPos(resolver, char, makePredicted(1, 0), 100, true)).toEqual({ x: 1, y: 0 });

    // f2 — reduced motion OFF at t=300, predicted steps to (2,0): the new slide STARTS
    // here, so this frame renders its origin — exactly the integer tile 1. No
    // back-step, no half-tile: reduced motion left the clock ON the tile it reported.
    expect(ownPos(resolver, char, makePredicted(2, 0), 300, false)).toEqual({ x: 1, y: 0 });

    // f3 — t=400, half a STEP_MS into that slide: exactly 1.5, i.e. it SLID. Exact,
    // not close-to: 100/200 = 0.5 in IEEE-754 and 1 + 1*0.5 = 1.5 exactly.
    expect(ownPos(resolver, char, makePredicted(2, 0), 400, false)).toEqual({ x: 1.5, y: 0 });
  });

  it('S7T-OWN-JUMP: turning reduced motion ON mid-slide jumps to the predicted tile immediately', () => {
    // INTENDED BEHAVIOUR, pinned so nobody "fixes" it: a user who turns reduced
    // motion on mid-step wants motion to stop NOW. Finishing the in-flight 0.5 tile
    // would be animating after the preference said not to; jumping the remaining
    // fraction is one instantaneous position change, which is what the preference
    // asks for. (The complementary direction, off -> on -> off, is the clock-tracking
    // test above.)
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 0, 0, 0);

    ownPos(resolver, char, makePredicted(0, 0), 0, false); // seed at (0,0)
    ownPos(resolver, char, makePredicted(1, 0), 0, false); // step 0->1 at t=0

    // mid-slide, reduced motion still OFF: exactly half a tile (the precondition that
    // makes the next line meaningful — without it "jumped to 1" could just be a slide
    // that had already finished).
    expect(ownPos(resolver, char, makePredicted(1, 0), 100, false)).toEqual({ x: 0.5, y: 0 });

    // the SAME `now`, reduced motion ON: no time has passed, yet the position is the
    // whole tile. WRONG IMPL KILLED: a "let the current slide finish" arm that keeps
    // returning 0.5 until t=200.
    expect(ownPos(resolver, char, makePredicted(1, 0), 100, true)).toEqual({ x: 1, y: 0 });
  });

  it('S7T-REM-ROW-HIST: with snapshot history, a remote renders its AUTHORITATIVE row tile, regardless of now', () => {
    // Kills: returning `latest` (5,5), returning `prev` (4,5), and returning anything
    // interpolated between them; and it proves `now`-independence, which is what
    // "no motion" means for a remote.
    const resolver = new RenderResolver(STEP_MS);
    const c = remoteDecoupled(true);

    // FIXTURE SELF-CHECK (plan §8 RT-3) — the decoupling is the whole point of this
    // fixture, so assert it before asserting on the render. If a future refactor of
    // this helper re-coupled row and snapshots, these lines fail instead of quietly
    // making the test vacuous.
    expect(c.snapshots.length).toBe(2); // really the interpolateHistory arm
    expect(c.row.tileX).not.toBe(c.latest.tileX);
    expect(c.row.tileY).not.toBe(c.latest.tileY);
    expect(c.row.tileX).not.toBe(c.prev!.tileX);
    expect(c.row.tileY).not.toBe(c.prev!.tileY);

    // TODAY (RED): now=0 -> renderTime = 0 - 200 = -200, before the oldest snapshot,
    // so the buffer clamps to (4,5); now=500 and now=100000 are past the newest, so
    // it HOLDs at (5,5). None of the three is (9,9).
    expect(remotePos(resolver, c, 0, true)).toEqual({ x: 9, y: 9 });
    expect(remotePos(resolver, c, 500, true)).toEqual({ x: 9, y: 9 });
    expect(remotePos(resolver, c, 100000, true)).toEqual({ x: 9, y: 9 });
  });

  it('S7T-REM-ROW-LEGACY: with an empty snapshot ring, a remote still renders its AUTHORITATIVE row tile', () => {
    // The legacy prev/latest arm (ADR-0090 backward compat) is a SECOND interpolation
    // call site. WRONG IMPL KILLED: a reduced-motion arm placed inside the
    // `snapshots.length > 0` branch only — every fixture in §§1-9 of this file uses
    // `snapshots: []`, so a one-arm fix would leave the whole legacy path animating.
    const resolver = new RenderResolver(STEP_MS);
    const c = remoteDecoupled(false);

    // FIXTURE SELF-CHECK — same decoupling, different arm.
    expect(c.snapshots.length).toBe(0); // really the legacy interpolate arm
    expect(c.row.tileX).not.toBe(c.latest.tileX);
    expect(c.row.tileY).not.toBe(c.latest.tileY);
    expect(c.row.tileX).not.toBe(c.prev!.tileX);

    // TODAY (RED): now=0 clamps to prev (4,5); now=500 and now=100000 HOLD at (5,5).
    expect(remotePos(resolver, c, 0, true)).toEqual({ x: 9, y: 9 });
    expect(remotePos(resolver, c, 500, true)).toEqual({ x: 9, y: 9 });
    expect(remotePos(resolver, c, 100000, true)).toEqual({ x: 9, y: 9 });
  });

  it('S7T-ZONE: reduced motion does not bypass the zone filter — off-zone characters stay out', () => {
    // WRONG IMPL KILLED (plan §6 R3): a reduced-motion arm hoisted ABOVE the
    // `currentZoneId` continue (or above the isOwn split). The global subscription
    // delivers every zone (M11c, ADR-0067), so that lands every character in the
    // world on screen — a visible cross-zone leak that only shows up in production.
    const resolver = new RenderResolver(STEP_MS);
    const own = ownRowAt(9, 9); // zoneId 1
    const remote = remoteDecoupled(true); // zoneId 1

    const offZone = resolver.resolve(
      makeInput({
        characters: [own, remote],
        ownEntityId: OWN_ID,
        predicted: makePredicted(3, 7),
        snapped: false,
        now: 500,
        currentZoneId: 2, // neither character is in zone 2
        reduceMotion: true,
      }),
    );
    expect(offZone).toEqual([]);
    expect(offZone.find((e) => e.entityId === OWN_ID)).toBeUndefined();
    expect(offZone.find((e) => e.entityId === REMOTE_ID)).toBeUndefined();

    // ANTI-VACUITY: the same call with the MATCHING zone renders both characters, so
    // the emptiness above is the filter doing its job and not a broken fixture, a
    // throw, or a resolver that dropped everything.
    const onZone = resolver.resolve(
      makeInput({
        characters: [own, remote],
        ownEntityId: OWN_ID,
        predicted: makePredicted(3, 7),
        snapped: false,
        now: 500,
        currentZoneId: 1,
        reduceMotion: true,
      }),
    );
    expect(onZone.length).toBe(2);
    // ... and both are still rendered the reduced-motion way (own = predicted tile,
    // remote = row tile), so this test also fails on a resolver that survives the
    // filter but forgets the flag.
    const ownOut = onZone.find((e) => e.entityId === OWN_ID);
    const remoteOut = onZone.find((e) => e.entityId === REMOTE_ID);
    expect(ownOut).toBeDefined();
    expect(remoteOut).toBeDefined();
    expect({ x: ownOut!.x, y: ownOut!.y }).toEqual({ x: 3, y: 7 });
    expect({ x: remoteOut!.x, y: remoteOut!.y }).toEqual({ x: 9, y: 9 });
  });

  it('S7T-FACING: reduced motion keeps own action/facing from predicted and remote action/facing from the row', () => {
    // The RM arm changes POSITION only. WRONG IMPL KILLED: an arm that returns early
    // with a whole RenderEntity of its own and copies the wrong sprite state into it
    // (own action/facing sourced from c.row, or remote sourced from `predicted`) —
    // the own character would animate the server's stale walk cycle instead of the
    // predicted one, which is the same desync class as reading c.row for position.
    const resolver = new RenderResolver(STEP_MS);
    const own = ownRowAt(9, 9); // row: action 'Walking', facing 'East'
    const remote = remoteDecoupled(false); // row: action 'Walking', facing 'East'
    const remoteIdle: StoredCharacter = {
      ...remote,
      row: { ...remote.row, action: 'Idle', facing: 'West' },
    };

    const entities = resolver.resolve(
      makeInput({
        characters: [own, remoteIdle],
        ownEntityId: OWN_ID,
        predicted: makePredicted(3, 7, 'Jumping', 'North'),
        snapped: false,
        now: 500,
        reduceMotion: true,
      }),
    );

    const ownOut = entities.find((e) => e.entityId === OWN_ID);
    const remoteOut = entities.find((e) => e.entityId === REMOTE_ID);
    expect(ownOut).toBeDefined();
    expect(remoteOut).toBeDefined();

    expect(ownOut!.action).toBe('Jumping'); // from predicted, never from c.row
    expect(ownOut!.facing).toBe('North');
    expect(remoteOut!.action).toBe('Idle'); // from c.row, never from predicted
    expect(remoteOut!.facing).toBe('West');

    // and the positions still follow the reduced-motion contract, so this test reds
    // pre-impl for the right reason instead of passing on the untouched passthrough.
    expect({ x: ownOut!.x, y: ownOut!.y }).toEqual({ x: 3, y: 7 });
    expect({ x: remoteOut!.x, y: remoteOut!.y }).toEqual({ x: 9, y: 9 });
  });

  it('S7T-BACKCOMPAT: an input with NO reduceMotion field renders exactly the pre-S7 fractional position', () => {
    // The optional-field ratchet (plan §5 AP12 / §6 R2). GREEN both before and after
    // the implementation, on purpose: it is what proves the new field is genuinely
    // optional with a `false` default, so the ~30 existing inline ResolveInput
    // literals in this file and the single production call site in main.ts keep their
    // byte-identical behaviour.
    // WRONG IMPLS KILLED: `reduceMotion = true` as the default; a REQUIRED field
    // (which would make `undefined` fall through as falsy today but is unfixable
    // inside this slice's touch set); and any restructuring of the pinned line-91
    // condition that changes what a plain step does.
    const resolver = new RenderResolver(STEP_MS);
    const char = makeChar(OWN_ID, 0, 0, 0);

    // NOTE: these three calls deliberately do NOT go through the ownPos helper — the
    // helper always passes the field, and the whole point here is its ABSENCE.
    const frame = (now: number, x: number): { readonly x: number; readonly y: number } => {
      const entities = resolver.resolve(
        makeInput({
          characters: [char],
          ownEntityId: OWN_ID,
          predicted: makePredicted(x, 0),
          snapped: false,
          now,
        }),
      );
      const own = entities.find((e) => e.entityId === OWN_ID);
      expect(own, 'the own entity must be in the resolver output').toBeDefined();
      return { x: own!.x, y: own!.y };
    };

    frame(0, 0); // seed at (0,0)
    frame(0, 1); // step 0->1 at t=0
    // exactly 0.5 — the same value §1 of this file has pinned since M8.6b
    expect(frame(100, 1)).toEqual({ x: 0.5, y: 0 });
  });
});
