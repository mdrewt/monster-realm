// render/renderResolver.test.ts — M8.6b acceptance suite (vitest, node-only).
//
// STEP_MS = 200 throughout. `now` is always injected (never calls performance.now).
//
// Proof-of-teeth: every critical assertion has an inline BAD-renderer
// model that kills a wrong implementation, making the assertion meaningful (not
// vacuous). Pattern mirrors slideClock.test.ts §"the test bites".

import { describe, expect, it } from 'vitest';
import type { WasmCharacterState } from '../convert/convert';
import type { StoredCharacter } from '../net/store';
import { adaptiveInterpDelayMs, interpolateHistory } from './interpolation';
import { TileMap } from './map';
import { RenderResolver, type ResolveInput, walkableIn } from './renderResolver';
// Standalone BITES fixture (§9 below) drives the pure SlideClock directly,
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
      ackedSeq: 0n,
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
    // interpDelayMs(200) === 200   [1.0 × 200]
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
        ackedSeq: 0n,
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
// folded into the existing `snapped` branch of RenderResolver.resolve.
// T2/T3 pin the boundary so the fix cannot over-snap (1-tile and 1-tile-diagonal
// steps must keep sliding).

describe('RenderResolver — ptc5g: position-divergence snap (Chebyshev > 1 tile)', () => {
  it('T1 CORE: a >1-tile authoritative jump SNAPS instead of gliding', () => {
    // Sequence:
    //   now=0   predicted=(0,0)  snapped=false → seeds #ownClock at tile (0,0)
    //   now=0   predicted=(10,0) snapped=false → chebyshev((10,0),(0,0)) = 10 > 1
    //           → must SNAP (jump), not setTarget (glide)
    //   now=100 predicted=(10,0) snapped=false → sample
    //
    // the large-jump branch calls snapTo instead, so the
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
    // A fix that snapped on `>= 1` instead of `> 1` would break this test — the
    // anti-over-snap anchor.
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
    // wrong metric.
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
// 10. resolver wiring + evolving-D bounded wobble
// ---------------------------------------------------------------------------
//
// These two tests drive the REAL AuthoritativeStore(200) through the REAL
// RenderResolver(200) instead of hand-built StoredCharacter fixtures, because the
// SEAM is the thing under test: the store's idle-gated EWMA feeds the resolver's
// adaptive delay, and the resolver must forward its own `#stepMs` into
// `interpolateHistory`. Every fixture in §§1-9 above uses `snapshots: []` and takes
// the legacy 2-snapshot fallback — they are deliberately left untouched.
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
      ackedSeq: 0n,
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
    // green if the one-line consumer wiring is reverted or
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
    // 0.1 ms into its window → the interpolated target is a = 0.0005. The render clock stepped
    // backward 40 ms.
    // Named intentional change (np-a): B and C are a straight walk, on which the drawn position
    // never moves backward, so the remote waits at `before` for its target instead of stepping
    // back to 0.0005; it moves at most one tile per STEP_MS, i.e. 0.2 / 200 = 0.001 tile here.
    const after = renderX(store, resolver, 6040.1);
    expect(after).toBeGreaterThanOrEqual(before);
    expect(after - before).toBeLessThanOrEqual(0.2 / STEP_MS + 1e-9);

    expect(before - after).toBeLessThanOrEqual(0.2 + 1e-3); // the pinned closed-form bound
    expect(after).toBeGreaterThanOrEqual(0); // dead-zone floor: never behind `prev`
  });

  it('(x) T-B: a uniform 700 ms cadence renders hold-then-slide per step, EWMA frozen at base delay', () => {
    // PINS A DELIBERATE SHAPE, NOT A BUG. ADR-0171 Consequences → "Slow-cadence
    // movers render hold-then-slide, deliberately". An entity whose rows arrive
    // uniformly every 700 ms (> 2 x stepMs) renders as rest → one stepMs slide per
    // step: exactly the own player's SlideClock motion language (slide stepMs, rest
    // until the next step).
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
        ackedSeq: 0n,
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
// 11. reduced motion
// ---------------------------------------------------------------------------
// SOURCE OF TRUTH: M23-accessibility.spec.md §2.5 — under the OS reduced-motion
// preference the renderer draws every character AT its logical tile: the own
// character at the PREDICTED tile, remotes at their AUTHORITATIVE row tile. No
// sub-tile slide, no interpolation buffer, no dependence on `now`. `reduceMotion` is
// injected the way `now` is — a ResolveInput field — never a media query read from
// inside the renderer.
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
        ackedSeq: 0n,
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

  /** The DECOUPLED remote fixture. The authoritative row sits on
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
        ackedSeq: 0n,
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
    // THE desync-critical cheat this kills: an own path that reads
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

    // SECOND DATA POINT — NEGATIVE tiles on a fresh resolver, so the
    // clock is seeded from scratch. WRONG IMPLS KILLED that positive-only fixtures
    // cannot see: a clamp-to-zero (`Math.max(0, x)`), an abs(), or a
    // floor-toward-zero of the predicted tile.
    const negResolver = new RenderResolver(STEP_MS);
    const negChar = ownRowAt(9, 9);
    const seeded = ownPos(negResolver, negChar, makePredicted(-2, -5), 0, true);
    expect(seeded).toEqual({ x: -2, y: -5 });

    // ... and a 1-tile step under reduced motion lands ON the new tile immediately.
    const stepped = ownPos(negResolver, negChar, makePredicted(-1, -5), 100, true);
    expect(stepped).toEqual({ x: -1, y: -5 });
    const settled = ownPos(negResolver, negChar, makePredicted(-1, -5), 200, true);
    expect(settled).toEqual({ x: -1, y: -5 });
  });

  it('S7T-OWN-FREEZE: reduced motion KEEPS the slide clock tracking — a frozen clock lands a tile behind on resume', () => {
    // THE SHARPEST TOOTH IN THIS SLICE. The cheat it kills:
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

    // FIXTURE SELF-CHECK — the decoupling is the whole point of this
    // fixture, so assert it before asserting on the render. If a future refactor of
    // this helper re-coupled row and snapshots, these lines fail instead of quietly
    // making the test vacuous.
    expect(c.snapshots.length).toBe(2); // really the interpolateHistory arm
    expect(c.row.tileX).not.toBe(c.latest.tileX);
    expect(c.row.tileY).not.toBe(c.latest.tileY);
    expect(c.row.tileX).not.toBe(c.prev!.tileX);
    expect(c.row.tileY).not.toBe(c.prev!.tileY);

    // now=0 -> renderTime = 0 - 200 = -200, before the oldest snapshot,
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

    // now=0 clamps to prev (4,5); now=500 and now=100000 HOLD at (5,5).
    expect(remotePos(resolver, c, 0, true)).toEqual({ x: 9, y: 9 });
    expect(remotePos(resolver, c, 500, true)).toEqual({ x: 9, y: 9 });
    expect(remotePos(resolver, c, 100000, true)).toEqual({ x: 9, y: 9 });
  });

  it('S7T-ZONE: reduced motion does not bypass the zone filter — off-zone characters stay out', () => {
    // WRONG IMPL KILLED: a reduced-motion arm hoisted ABOVE the
    // `currentZoneId` continue (or above the isOwn split). The store also holds the zone the
    // player has just left while its set lingers, so that lands another zone's characters on
    // screen — a visible cross-zone leak that only shows up in production.
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
    // The optional-field ratchet. GREEN both before and after
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

// ---------------------------------------------------------------------------
// 12. np-a: a remote on a straight walk keeps walking between late steps
// ---------------------------------------------------------------------------
//
// Rows go through a REAL AuthoritativeStore(200) into RenderResolver(200), frame by frame, at
// the adaptive delay the store's jitter estimate gives (every scenario says how its delay is
// set). The contract the expected values are worked from, per remote per frame:
//   delay = adaptiveInterpDelayMs(jitterEwma, 200); renderTime = now - delay; window = 600 ms
//   walk  = walkOf(positionChanges, turnedInPlace, now, 200, 600)
//   target: interpolateHistory(snapshots, renderTime, 200, walk ? 600 : undefined); when the
//     walk is straight, renderTime > latest.receivedAt and `walkable(latest + ahead)`, instead
//     latest + min(0.5, (renderTime - latest.receivedAt) / cadence) along the walk
//   position: the target on first sight / after a snap / on a clock that did not move / when it
//     is REMOTE_SNAP_TILES (2) or more (Manhattan) from the last drawn position, else the last
//     drawn position moved toward it by at most (now - lastNow) / 200 tiles; then, on a straight
//     walk, any component of the move backward along the walk is removed
//   action: 'Walking' for an Idle row while the remote is not drawn on the row's tile
// "Timing facts" for the base walk A@1000 (0,0), B@1200 (1,0), C@1400 (2,0), all East, delay
// 200: the render clock passes C at now 1600; continuation adds one tile per 200 ms up to +0.5
// at 1700; the window ends at 2000 (C's arrival + 600); the settle back takes 100 ms.

describe('np-a remote continuation and slew (real store into the resolver)', () => {
  const EPS = 1e-9;
  const OPEN = (): boolean => true;

  type Facing = StoreCharacter['facing'];
  type Action = StoreCharacter['action'];

  function row(
    entityId: bigint,
    tileX: number,
    tileY: number,
    facing: Facing = 'East',
    action: Action = 'Walking',
    zoneId = 1,
  ): StoreCharacter {
    return {
      entityId,
      zoneId,
      tileX,
      tileY,
      facing,
      action,
      moveStartedAtMs: 0n,
      moveQueue: [],
      ackedSeq: 0n,
    };
  }

  interface Arrival {
    readonly at: number;
    readonly row: StoreCharacter;
  }
  interface Drawn {
    readonly now: number;
    readonly x: number;
    readonly y: number;
    readonly action: string;
    /** The stored character the frame was resolved from. */
    readonly c: StoredCharacter;
  }
  interface RunOpts {
    readonly from: number;
    readonly to: number;
    readonly frameMs: number;
    readonly walkable?: (tileX: number, tileY: number) => boolean;
    /** Hand the resolver `{ ...stored, jitterEwma: 0 }`: delay pinned at one STEP_MS. */
    readonly pinDelay?: boolean;
  }

  /** Apply each arrival at its own wall clock, before the first frame at or after it, and
   *  resolve a frame every `frameMs` from `from` to `to`. Returns every entity's frames. */
  function run(arrivals: readonly Arrival[], o: RunOpts): Map<bigint, Drawn[]> {
    const store = new AuthoritativeStore(STEP_MS);
    const resolver = new RenderResolver(STEP_MS);
    const queue = [...arrivals].sort((a, b) => a.at - b.at);
    let next = 0;
    const out = new Map<bigint, Drawn[]>();
    for (let i = 0; o.from + i * o.frameMs <= o.to; i++) {
      const now = o.from + i * o.frameMs;
      while (next < queue.length && queue[next]!.at <= now) {
        store.upsertCharacter(queue[next]!.row, queue[next]!.at);
        next++;
      }
      const held = [...store.characters()];
      const characters = o.pinDelay === true ? held.map((c) => ({ ...c, jitterEwma: 0 })) : held;
      const entities = resolver.resolve({
        characters,
        ownEntityId: undefined,
        predicted: undefined,
        snapped: false,
        now,
        walkable: o.walkable,
      });
      for (const c of characters) {
        const e = entities.find((d) => d.entityId === c.row.entityId);
        expect(e, `entity ${c.row.entityId} drawn at ${now}`).toBeDefined();
        const list = out.get(c.row.entityId) ?? [];
        list.push({ now, x: e!.x, y: e!.y, action: e!.action, c });
        out.set(c.row.entityId, list);
      }
    }
    expect(next, 'every arrival was applied').toBe(queue.length);
    return out;
  }

  function track(m: Map<bigint, Drawn[]>, id: bigint): Drawn[] {
    const t = m.get(id);
    expect(t, `frames for ${id}`).toBeDefined();
    return t!;
  }

  function frameAt(t: readonly Drawn[], now: number): Drawn {
    const f = t.find((d) => d.now === now);
    expect(f, `a frame at ${now}`).toBeDefined();
    return f!;
  }

  /** One East step per arrival time: tile k at times[k], on row y. */
  function walkEast(id: bigint, times: readonly number[], y = 0, x0 = 0): Arrival[] {
    return times.map((at, k) => ({ at, row: row(id, x0 + k, y) }));
  }

  /** No sampled move faster than one tile per STEP_MS (Manhattan), from frame `from` on. */
  function expectBoundedSpeed(t: readonly Drawn[], label: string, from = 1): void {
    for (let i = Math.max(1, from); i < t.length; i++) {
      const a = t[i - 1]!;
      const b = t[i]!;
      const moved = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      expect(
        moved,
        `${label}: ${a.now}->${b.now} moved (${a.x}, ${a.y}) -> (${b.x}, ${b.y})`,
      ).toBeLessThanOrEqual((b.now - a.now) / STEP_MS + EPS);
    }
  }

  /** Manhattan distance from p to the axis-aligned segment a-b. */
  function toSegment(
    p: { readonly x: number; readonly y: number },
    a: { readonly tileX: number; readonly tileY: number },
    b: { readonly tileX: number; readonly tileY: number },
  ): number {
    const cx = Math.min(Math.max(p.x, Math.min(a.tileX, b.tileX)), Math.max(a.tileX, b.tileX));
    const cy = Math.min(Math.max(p.y, Math.min(a.tileY, b.tileY)), Math.max(a.tileY, b.tileY));
    return Math.abs(p.x - cx) + Math.abs(p.y - cy);
  }

  /** Whether p lies on the polyline through the ring's tiles (the authoritative path). */
  function onPath(
    p: { readonly x: number; readonly y: number },
    ring: readonly { readonly tileX: number; readonly tileY: number }[],
  ): boolean {
    if (ring.length === 1) return toSegment(p, ring[0]!, ring[0]!) <= EPS;
    for (let i = 1; i < ring.length; i++) {
      if (toSegment(p, ring[i - 1]!, ring[i]!) <= EPS) return true;
    }
    return false;
  }

  // --- np-a.1 -------------------------------------------------------------------------------

  it("keeps walking past its newest tile, in the walk's direction, once the render clock passes it [np-a.1]", () => {
    // Steps exactly STEP_MS apart: every jitter sample deviates 0, the estimate stays 0 and the
    // delay is pinned at adaptiveInterpDelayMs(0, 200) = 200.
    // The render clock passes C (1400) at now 1600. The cadence is max(200, 1400 - 1200) = 200,
    // so x = 2 + (now - 1600) / 200 up to the 0.5 cap at 1700, then 2.5 to the end of the window
    // (2000). The 10 ms frames move 0.05 tile each: exactly the slew budget, so the drawn
    // position is the continued target.
    const t = track(
      run(walkEast(9n, [1000, 1200, 1400]), { from: 1000, to: 2000, frameMs: 10, walkable: OPEN }),
      9n,
    );
    for (const f of t) expect(adaptiveInterpDelayMs(f.c.jitterEwma, STEP_MS)).toBe(200);
    for (const f of t.filter((d) => d.now >= 1600 && d.now <= 1700)) {
      expect(f.x, `x at ${f.now}`).toBeCloseTo(2 + (f.now - 1600) / 200, 9);
      expect(f.y).toBeCloseTo(0, 12);
    }
    for (const f of t.filter((d) => d.now >= 1700 && d.now <= 2000)) {
      expect(f.x, `x at ${f.now}`).toBeCloseTo(2.5, 9);
    }
  });

  it("continues at the walk's own observed cadence, not at one tile per STEP_MS [np-a.1]", () => {
    // Steps 300 ms apart: A@1000, B@1300, C@1600; the resolver is handed jitterEwma 0, so the
    // delay is pinned at 200. Cadence = max(200, 1600 - 1300) = 300 ms per tile.
    // Before C, each new bracket starts 1/3 tile ahead of the held position and the slew
    // (0.05 / 10 ms frame) closes it in 17 frames, so by 1770 the drawn position is the target.
    // The render clock passes C at now 1800; then x = 2 + (now - 1800) / 300 (e.g. 2.3 at 1890;
    // a one-tile-per-STEP_MS continuation would read 2.45 there), capped at 2.5 from 1950 to
    // the end of the window (1600 + 600 = 2200).
    const t = track(
      run(walkEast(9n, [1000, 1300, 1600]), {
        from: 1000,
        to: 2200,
        frameMs: 10,
        walkable: OPEN,
        pinDelay: true,
      }),
      9n,
    );
    for (const f of t.filter((d) => d.now >= 1800 && d.now <= 1950)) {
      expect(f.x, `x at ${f.now}`).toBeCloseTo(2 + (f.now - 1800) / 300, 9);
    }
    for (const f of t.filter((d) => d.now >= 1950 && d.now <= 2200)) {
      expect(f.x, `x at ${f.now}`).toBeCloseTo(2.5, 9);
    }
  });

  // --- np-a.2 -------------------------------------------------------------------------------

  it('is drawn at most half a tile (Manhattan) past its newest tile, and does reach that half tile [np-a.2]', () => {
    // Cadence 200 (natural, delay 200) and cadence 300 (pinned delay 200), each at 10 ms and
    // 50 ms frames. The cap is reached at 1700 (cadence 200) / 1950 (cadence 300), both on
    // either frame grid, and held to the window's end.
    const cases = [
      { times: [1000, 1200, 1400], pinDelay: false, to: 2000 },
      { times: [1000, 1300, 1600], pinDelay: true, to: 2200 },
    ];
    for (const k of cases) {
      for (const frameMs of [10, 50]) {
        const t = track(
          run(walkEast(9n, k.times), {
            from: 1000,
            to: k.to,
            frameMs,
            walkable: OPEN,
            pinDelay: k.pinDelay,
          }),
          9n,
        );
        let farthest = Number.NEGATIVE_INFINITY;
        for (const f of t) {
          const past = f.x - f.c.latest.tileX;
          farthest = Math.max(farthest, past);
          if (past > 0) {
            const d = Math.abs(f.x - f.c.latest.tileX) + Math.abs(f.y - f.c.latest.tileY);
            expect(
              d,
              `cadence case ${k.times}, ${frameMs} ms frames, at ${f.now}`,
            ).toBeLessThanOrEqual(0.5 + EPS);
          }
        }
        expect(farthest, `cadence case ${k.times}, ${frameMs} ms frames`).toBeGreaterThanOrEqual(
          0.5 - EPS,
        );
      }
    }
  });

  it('holds short of a tile the walkability predicate rejects, while a walk toward an accepted tile is continued [np-a.2]', () => {
    // Two remotes walk east in step: 9n on row 0 toward (3,0), which the predicate rejects; 10n on
    // row 1 toward (3,1), which it accepts. Delay 200 (steps exactly 200 apart).
    const walkable = (x: number, y: number): boolean => !(x === 3 && y === 0);
    const m = run(
      [...walkEast(9n, [1000, 1200, 1400], 0), ...walkEast(10n, [1000, 1200, 1400], 1)],
      {
        from: 1000,
        to: 2000,
        frameMs: 10,
        walkable,
      },
    );
    const blocked = track(m, 9n);
    const open = track(m, 10n);
    for (const f of blocked) {
      expect(f.x, `9n never past its newest tile (at ${f.now})`).toBeLessThanOrEqual(2 + EPS);
    }
    expect(frameAt(blocked, 2000).x).toBeCloseTo(2, 9);
    expect(Math.max(...open.map((f) => f.x)), '10n is continued').toBeCloseTo(2.5, 9);
  });

  it('is never continued without a walkability predicate [np-a.2]', () => {
    const t = track(
      run(walkEast(9n, [1000, 1200, 1400]), { from: 1000, to: 2000, frameMs: 10 }),
      9n,
    );
    for (const f of t) expect(f.x, `x at ${f.now}`).toBeLessThanOrEqual(2 + EPS);
    expect(frameAt(t, 2000).x).toBeCloseTo(2, 9);
  });

  it('walkableIn agrees with TileMap.isWalkable on every tile of a grid and on its border [np-a.2]', () => {
    // An 8 x 3 grid (even width) whose pattern is not symmetric under an x/y swap, row-major
    // (# walkable). Off-grid coordinates land on other rows' indices: (-1, 2) reads index 15, a
    // walkable tile of row 1, and (0, 0.5) on width 8 reads index 4, a walkable tile of row 0.
    //   y=0: # . # . # # . .
    //   y=1: . # # . . # . #
    //   y=2: # # . # . # # .
    const walkable = [...'#.#.##...##..#.###.#.##.'].map((ch) => ch === '#');
    const raw = {
      zone_id: 3,
      width: 8,
      height: 3,
      walkable,
      grass: walkable.map(() => false),
    };
    const map = TileMap.fromRaw(raw);
    const pred = walkableIn(raw);
    let trues = 0;
    for (let y = -1; y <= 3; y++) {
      for (let x = -1; x <= 8; x++) {
        expect(pred(x, y), `(${x}, ${y})`).toBe(map.isWalkable(x, y));
        if (pred(x, y)) trues++;
      }
    }
    expect(trues, 'every walkable tile inside the grid, and no other').toBe(13);
    // A fractional coordinate is never a tile.
    for (const [x, y] of [
      [1.5, 0],
      [0, 1.5],
      [0, 0.5],
      [0, 0.25],
      [-0.5, 1],
    ] as const) {
      expect(pred(x, y), `(${x}, ${y})`).toBe(false);
      expect(map.isWalkable(x, y)).toBe(false);
    }
  });

  it('a walk toward the edge of the map is not continued off it; one toward the inside is [np-a.2]', () => {
    // A 4 x 2 open grid through walkableIn. 9n walks east on row 0 to (3,0): the tile ahead,
    // (4,0), is outside the map. 10n walks west on row 1 to (1,1): the tile ahead, (0,1), is
    // inside, so it is continued to x = 0.5.
    const grid = { width: 4, height: 2, walkable: Array.from({ length: 8 }, () => true) };
    const m = run(
      [
        ...walkEast(9n, [1000, 1200, 1400], 0, 1),
        { at: 1000, row: row(10n, 3, 1, 'West') },
        { at: 1200, row: row(10n, 2, 1, 'West') },
        { at: 1400, row: row(10n, 1, 1, 'West') },
      ],
      { from: 1000, to: 2000, frameMs: 10, walkable: walkableIn(grid) },
    );
    const edge = track(m, 9n);
    for (const f of edge) expect(f.x, `9n at ${f.now}`).toBeLessThanOrEqual(3 + EPS);
    expect(frameAt(edge, 2000).x).toBeCloseTo(3, 9);
    expect(Math.min(...track(m, 10n).map((f) => f.x)), '10n is continued west').toBeCloseTo(0.5, 9);
  });

  // --- np-a.3 -------------------------------------------------------------------------------

  /** A small seeded LCG (Numerical Recipes constants): deterministic arrival jitter. */
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s;
    };
  }

  const STEPS = 24;
  const SETTLED_FROM = 16; // sample from the 17th step on
  const exact400 = Array.from({ length: STEPS }, (_, k) => 1000 + 400 * k);
  const alternating: number[] = [1000];
  for (let k = 1; k < STEPS; k++) alternating.push(alternating[k - 1]! + (k % 2 === 1 ? 390 : 410));
  const rand = lcg(0x5eed);
  const seeded = Array.from({ length: STEPS }, (_, k) =>
    k === 0 ? 1000 : 1000 + 400 * k + ((rand() % 21) - 10),
  );

  /** A straight walk east with an Idle same-tile row 200 ms after each step. */
  function walkWithIdleRows(id: bigint, times: readonly number[]): Arrival[] {
    const out: Arrival[] = [];
    times.forEach((at, k) => {
      out.push({ at, row: row(id, k, 0, 'East', 'Walking') });
      out.push({ at: at + 200, row: row(id, k, 0, 'East', 'Idle') });
    });
    return out;
  }

  for (const [name, times] of [
    ['exactly 400 ms', exact400],
    ['alternating 390 / 410 ms', alternating],
    ['400 ms +- seeded 10 ms', seeded],
  ] as const) {
    it(`steps two STEP_MS apart (${name}) with Idle rows between them advance without a 100 ms stand-still, drawn Walking [np-a.3]`, () => {
      // Every step interval deviates ~200 ms from STEP_MS, so the estimate climbs toward 200 and
      // the delay reaches its 500 ms cap within a dozen steps; sampling starts at step 16.
      // Settled: renderTime = now - 500 trails the newest step (next step <= 420 ms later) by more
      // than 80 ms, every bracket spans 380..420 ms (<= the 600 ms walk span, so it is lerped,
      // never re-anchored), and the lerp moves at most 16 / 380 = 0.042 tile per 16 ms frame,
      // inside the 0.08 slew budget: the drawn position rises every frame. It is never on the
      // row's tile (it trails it by more than a quarter tile), so an Idle row is drawn Walking.
      // Frames run one 16 ms frame past the last scheduled arrival (the Idle row 200 ms after
      // the last step), so every arrival is applied. Sampling stops at that Idle row: with the
      // delay at 500 the render clock is then still 300 ms short of the last step, so the walk
      // is still under way (interpolated, never held) over the whole sampled range.
      const lastStep = times[STEPS - 1]!;
      const t = track(
        run(walkWithIdleRows(9n, times), {
          from: times[0]!,
          to: lastStep + 200 + 16,
          frameMs: 16,
          walkable: OPEN,
        }),
        9n,
      );
      const sampled = t.filter((f) => f.now >= times[SETTLED_FROM]! && f.now <= lastStep + 200);
      expect(
        sampled.length,
        'ANTI-VACUITY: frames sampled after the estimate settles',
      ).toBeGreaterThan(100);
      const last = sampled[sampled.length - 1]!;
      expect(last.now, 'the last sample is after the last step arrived').toBeGreaterThan(lastStep);

      // The drawn position first: it advances every frame and is drawn Walking.
      let runStart = sampled[0]!;
      let longestStill = 0;
      for (let i = 1; i < sampled.length; i++) {
        const a = sampled[i - 1]!;
        const b = sampled[i]!;
        expect(b.x, `never backward (${a.now} -> ${b.now})`).toBeGreaterThanOrEqual(a.x - EPS);
        expect(b.y).toBeCloseTo(0, 12);
        const still = Math.abs(b.x - a.x) + Math.abs(b.y - a.y) <= EPS;
        if (!still) runStart = b;
        longestStill = Math.max(longestStill, b.now - runStart.now);
      }
      expect(longestStill, 'longest stand-still (ms)').toBeLessThan(100);
      expect(last.x - sampled[0]!.x, 'advances along the walk').toBeGreaterThan(6);
      for (const f of sampled) expect(f.action, `action at ${f.now}`).toBe('Walking');

      // The store side of the same criterion: one snapshot per tile, and an estimate taken from
      // the step intervals alone has settled the delay at its 500 ms cap.
      expect(
        last.c.snapshots.map((sn) => sn.tileX),
        'one snapshot per tile',
      ).toEqual([STEPS - 4, STEPS - 3, STEPS - 2, STEPS - 1]);
      for (const f of sampled) {
        expect(
          adaptiveInterpDelayMs(f.c.jitterEwma, STEP_MS),
          `the delay has settled at its cap by ${f.now}`,
        ).toBe(500);
      }
    });
  }

  // --- np-a.4 -------------------------------------------------------------------------------

  it('with no position change within the window, returns to the newest tile within one STEP_MS, no faster than one tile per STEP_MS, and then shows the row action [np-a.4]', () => {
    // The base walk (delay 200) plus an Idle row on C's tile at 1600. Continued to 2.5 by 1700;
    // the window ends at 2000 (C + 600); from 2010 the target is C's tile and the 0.05-per-frame
    // slew brings 2.5 back to 2 by 2100, inside 2000 + STEP_MS. Drawn Walking while off the
    // tile, Idle once on it.
    const t = track(
      run([...walkEast(9n, [1000, 1200, 1400]), { at: 1600, row: row(9n, 2, 0, 'East', 'Idle') }], {
        from: 1000,
        to: 2400,
        frameMs: 10,
        walkable: OPEN,
      }),
      9n,
    );
    expect(Math.max(...t.map((f) => f.x)), 'ANTI-VACUITY: it was continued').toBeCloseTo(2.5, 9);
    expectBoundedSpeed(t, 'settle');
    const back = t.find((f) => f.now > 2000 && Math.abs(f.x - 2) <= EPS);
    expect(back, 'back on the newest tile').toBeDefined();
    expect(back!.now).toBeLessThanOrEqual(2000 + STEP_MS);
    for (const f of t.filter((d) => d.now >= 2000 + STEP_MS)) {
      expect(f.x, `x at ${f.now}`).toBeCloseTo(2, 9);
      expect(f.y).toBeCloseTo(0, 12);
      expect(f.action, `action at ${f.now}`).toBe('Idle');
    }
    for (const f of t.filter((d) => d.now >= 1700 && d.now <= 2000)) {
      expect(f.action, `action off the tile at ${f.now}`).toBe('Walking');
    }
  });

  it('a walk at two STEP_MS per step that stops settles back onto its last tile the same way [np-a.4]', () => {
    // 16 steps 400 ms apart with Idle rows (delay settled at 500 by the end); the last step is
    // tile 15 at 7000, its Idle row at 7200. The render clock passes 7000 at now 7500 and the
    // remote is continued at the 400 ms cadence until the window ends at 7600 (+0.25 tile);
    // then it returns to 15 well before 7600 + STEP_MS and shows Idle.
    const times = exact400.slice(0, 16);
    const t = track(
      run(walkWithIdleRows(9n, times), { from: 1000, to: 8200, frameMs: 16, walkable: OPEN }),
      9n,
    );
    expect(
      Math.max(...t.filter((f) => f.now > 7000).map((f) => f.x)),
      'ANTI-VACUITY: it was continued past tile 15',
    ).toBeGreaterThan(15.1);
    expectBoundedSpeed(t, 'walk and settle');
    for (const f of t.filter((d) => d.now >= 7600 + STEP_MS)) {
      expect(f.x, `x at ${f.now}`).toBeCloseTo(15, 9);
      expect(f.action, `action at ${f.now}`).toBe('Idle');
    }
  });

  // --- np-a.5 -------------------------------------------------------------------------------

  for (const [name, contradiction] of [
    ['a reversal', row(9n, 1, 0, 'West')],
    ['a perpendicular turn', row(9n, 2, 1, 'South')],
    ['a same-tile turn', row(9n, 2, 0, 'North', 'Idle')],
  ] as const) {
    it(`after ${name} it stays within half a tile of its last segment, moves no faster than one tile per STEP_MS and reaches the authoritative path within one STEP_MS [np-a.5]`, () => {
      // The base walk, continued to 2.5 by 1700; the contradicting row arrives at 1750.
      // Reversal: D (1,0) West. Interval 350 -> estimate 18.75 -> delay 237.5; a turn, so not
      //   continued; the target is the C->D lerp, 2 - 112.5/350 = 1.68 at 1750, heading for 1.
      // Perpendicular: D (2,1) South, the same delay; the target (2, 0.32) at 1750; the slew goes
      //   x first (its corner (2,0) is a tile centre), so it walks back along y = 0 to (2,0).
      // Same-tile turn: (2,0) facing North; no snapshot, no jitter sample; the target holds C.
      // Each way the drawn position goes from (2.5, 0) to x = 2 in 10 frames (1840), on the path.
      const t = track(
        run([...walkEast(9n, [1000, 1200, 1400]), { at: 1750, row: contradiction }], {
          from: 1000,
          to: 2400,
          frameMs: 10,
          walkable: OPEN,
        }),
        9n,
      );
      expect(frameAt(t, 1740).x, 'ANTI-VACUITY: continued when the row arrives').toBeCloseTo(
        2.5,
        9,
      );
      const after = t.filter((f) => f.now >= 1750);
      for (const f of after) {
        const ring = f.c.snapshots;
        const d = toSegment(f, ring[ring.length - 2]!, ring[ring.length - 1]!);
        expect(
          d,
          `distance from the last segment at ${f.now} (${f.x}, ${f.y})`,
        ).toBeLessThanOrEqual(0.5 + EPS);
      }
      expectBoundedSpeed(
        t.filter((f) => f.now >= 1740),
        name,
      );
      const reached = after.find((f) => onPath(f, f.c.snapshots));
      expect(reached, 'reaches the authoritative path').toBeDefined();
      expect(reached!.now).toBeLessThanOrEqual(1750 + STEP_MS);
    });
  }

  // --- np-a.6 -------------------------------------------------------------------------------

  for (const dAt of [1750, 1850, 1990]) {
    it(`a same-direction step arriving while continued (${dAt - 1400} ms after the last) never draws it backward [np-a.6]`, () => {
      // The base walk, continued to 2.5 by 1700, then D (3,0) East at dAt. 1850 and 1990 make
      // brackets of 450 and 590 ms, past REANCHOR_SPAN_STEPS (2) x STEP_MS = 400.
      // D at 1750: interval 350 -> estimate 18.75 -> delay 237.5; the C->D target is 2.32 at 1750,
      //   behind the drawn 2.5, which therefore waits (it is not past the newest tile, 3) until
      //   the target passes 2.5 at 1812.5, then walks on, continued to 3.5 by 2162.5.
      // D at 1850: delay 262.5, cadence 450, at 3.5 by 2337.5. D at 1990: delay 297.5, cadence
      //   590, at 3.5 by 2582.5. Each is still continued at its last frame, dAt + 600.
      const t = track(
        run(walkEast(9n, [1000, 1200, 1400, dAt]), {
          from: 1000,
          to: dAt + 600,
          frameMs: 10,
          walkable: OPEN,
        }),
        9n,
      );
      expect(frameAt(t, dAt - 10).x, 'ANTI-VACUITY: continued when D arrives').toBeCloseTo(2.5, 9);
      const walked = t.filter((f) => f.now >= 1600);
      for (let i = 1; i < walked.length; i++) {
        const a = walked[i - 1]!;
        const b = walked[i]!;
        expect(b.x, `never backward (${a.now}: ${a.x} -> ${b.now}: ${b.x})`).toBeGreaterThanOrEqual(
          a.x - EPS,
        );
        expect(b.y).toBeCloseTo(0, 12);
      }
      expect(walked[walked.length - 1]!.x, 'walks on past D').toBeGreaterThan(3);
    });
  }

  it('a south walk with a late same-direction step is never drawn backward along y [np-a.6]', () => {
    // The base walk turned south: (0,0)@1000, (0,1)@1200, (0,2)@1400, continued to y = 2.5 by
    // 1700; D (0,3) at 1750. The C->D target is y = 2.32 at 1750 (delay 237.5), behind the drawn
    // 2.5, so the remote waits; continued to 3.5 by 2162.5.
    const south = [1000, 1200, 1400, 1750].map((at, k) => ({ at, row: row(9n, 0, k, 'South') }));
    const t = track(run(south, { from: 1000, to: 2350, frameMs: 10, walkable: OPEN }), 9n);
    expect(frameAt(t, 1740).y, 'ANTI-VACUITY: continued when D arrives').toBeCloseTo(2.5, 9);
    const walked = t.filter((f) => f.now >= 1600);
    for (let i = 1; i < walked.length; i++) {
      const a = walked[i - 1]!;
      const b = walked[i]!;
      expect(b.y, `never backward (${a.now}: ${a.y} -> ${b.now}: ${b.y})`).toBeGreaterThanOrEqual(
        a.y - EPS,
      );
      expect(b.x).toBeCloseTo(0, 12);
    }
    expect(walked[walked.length - 1]!.y, 'walks on past D').toBeGreaterThan(3);
  });

  it('a burst of steps followed by a late step never draws it backward, not even by a jump to the target [np-a.6]', () => {
    // First sight (0,0) at 0, then East steps to x = 1..7 arriving at 1442, 1852, four at 3516
    // (one burst) and 3898; 18 ms frames from 990. Estimate: 26.25 after 1852 (410 ms), the
    // burst's first step gated (1664 ms), then three 0 ms samples: 47.97, 66.97, 83.60 (delay
    // 367.2). The burst leaves the ring [3,4,5,6], all stamped 3516; the render clock clamps to
    // the oldest snapshot (3) until it reaches 3516 at 3883.2, when the target (6, continued) is
    // 2+ tiles ahead and the remote is drawn at it (6.02 at 3888). The step at 3898 evicts 3 and
    // moves the estimate to 95.90 (delay 391.8): at 3906 the render clock (3514.2) is before the
    // new oldest snapshot, so the target is 4, two tiles back. The straight walk (East, 0 then
    // 382 ms apart) drops that backward move; from 3924 the target (6.04 on) is ahead again.
    // Checked from the burst to the end of the window after the last step (3898 + 600).
    const times = [1442, 1852, 3516, 3516, 3516, 3516, 3898];
    const arrivals = [
      { at: 0, row: row(9n, 0, 0) },
      ...times.map((at, k) => ({ at, row: row(9n, k + 1, 0) })),
    ];
    const t = track(run(arrivals, { from: 990, to: 4498, frameMs: 18, walkable: OPEN }), 9n);
    const checked = t.filter((f) => f.now >= 3516 && f.now <= 3898 + 600);
    expect(checked.length, 'ANTI-VACUITY: frames from the burst on').toBeGreaterThan(50);
    for (let i = 1; i < checked.length; i++) {
      const a = checked[i - 1]!;
      const b = checked[i]!;
      expect(b.x, `never backward (${a.now}: ${a.x} -> ${b.now}: ${b.x})`).toBeGreaterThanOrEqual(
        a.x - EPS,
      );
    }
    expect(checked[checked.length - 1]!.x, 'walks on past the last step').toBeGreaterThan(7);
  });

  // --- the jump to a far target (REMOTE_SNAP_TILES = 2) ---------------------------------------

  it('a remote two or more tiles behind its target is drawn at the target on that frame [np-a.5]', () => {
    // First sight (0,0)@1000, then three one-tile steps in one burst at 3000. The first is gated
    // (2000 ms idle); the two burst intervals (0 ms, deviation 200) give 25, then 46.875: delay
    // 293.75. Ring [0@1000, 1@3000, 2@3000, 3@3000]. The 0->1 bracket is re-anchored to
    // [2800, 3000], so x = (renderTime - 2800) / 200 from now 3093.75, 0.05 per 10 ms frame (the
    // slew budget): 0.98125 at 3290. At 3300 the render clock (3006.25) reaches 3000 and the
    // target is the newest snapshot, 3: 2.02 tiles away, so the remote is drawn at 3 at once.
    // No walkability predicate: never continued.
    const arrivals = [
      { at: 1000, row: row(9n, 0, 0) },
      { at: 3000, row: row(9n, 1, 0) },
      { at: 3000, row: row(9n, 2, 0) },
      { at: 3000, row: row(9n, 3, 0) },
    ];
    const t = track(run(arrivals, { from: 1000, to: 3600, frameMs: 10 }), 9n);
    expect(adaptiveInterpDelayMs(frameAt(t, 3300).c.jitterEwma, STEP_MS)).toBe(293.75);
    expect(frameAt(t, 3290).x).toBeCloseTo(0.98125, 9);
    expect(frameAt(t, 3300).x, 'drawn at the far target on the frame it jumps').toBeCloseTo(3, 9);
  });

  it('a remote less than two tiles behind its target is walked there at no more than one tile per STEP_MS [np-a.5]', () => {
    // As above with a two-step burst: ring [0@1000, 1@3000, 2@3000], estimate 25, delay 250.
    // x = (renderTime - 2800) / 200 from now 3050: 0.95 at 3240. At 3250 the render clock reaches
    // 3000 and the target is 2, 1.05 tiles away: walked, 1.0 at 3250, on 2 by 3450.
    const arrivals = [
      { at: 1000, row: row(9n, 0, 0) },
      { at: 3000, row: row(9n, 1, 0) },
      { at: 3000, row: row(9n, 2, 0) },
    ];
    const t = track(run(arrivals, { from: 1000, to: 3600, frameMs: 10 }), 9n);
    expect(adaptiveInterpDelayMs(frameAt(t, 3250).c.jitterEwma, STEP_MS)).toBe(250);
    expect(frameAt(t, 3240).x).toBeCloseTo(0.95, 9);
    expect(frameAt(t, 3250).x, 'walked toward the near target').toBeCloseTo(1, 9);
    expectBoundedSpeed(t, 'two-step burst');
    expect(frameAt(t, 3600).x).toBeCloseTo(2, 9);
  });

  // --- the action rule ----------------------------------------------------------------------

  it('a same-tile row with another action than Idle is drawn with that action while the remote is off its tile [np-a.4]', () => {
    // The base walk, continued to 2.5 by 1700; a same-tile row (2,0) facing East with action
    // Jumping at 1750 (not a turn: the walk stays continued, at 2.5, to the window's end, 2000).
    const t = track(
      run(
        [...walkEast(9n, [1000, 1200, 1400]), { at: 1750, row: row(9n, 2, 0, 'East', 'Jumping') }],
        { from: 1000, to: 2000, frameMs: 10, walkable: OPEN },
      ),
      9n,
    );
    for (const f of t.filter((d) => d.now >= 1750)) {
      expect(f.x, `off its tile at ${f.now}`).toBeCloseTo(2.5, 9);
      expect(f.action, `action at ${f.now}`).toBe('Jumping');
    }
  });

  // --- a turn in place ends the straight walk ------------------------------------------------

  it('after a turn in place and back, the remote is never drawn off its tile again [np-a.5]', () => {
    // The base walk to (2,0) at 1400, then same-tile Idle rows facing South at 1600 and East
    // again at 1800. The render clock passes C at 1600, the frame the South row lands: from then
    // the walk is a turn in place (not continuable), and facing East again does not undo it.
    // The target holds (2,0); the drawn position is on it from 1600 on.
    const t = track(
      run(
        [
          ...walkEast(9n, [1000, 1200, 1400]),
          { at: 1600, row: row(9n, 2, 0, 'South', 'Idle') },
          { at: 1800, row: row(9n, 2, 0, 'East', 'Idle') },
        ],
        { from: 1000, to: 2400, frameMs: 10, walkable: OPEN },
      ),
      9n,
    );
    for (const f of t.filter((d) => d.now >= 1600)) {
      expect(f.x, `on its tile at ${f.now}`).toBeCloseTo(2, 9);
      expect(f.y).toBeCloseTo(0, 12);
      expect(f.action, `action at ${f.now}`).toBe('Idle');
    }
  });

  // --- a walk that turns every step ----------------------------------------------------------

  it('a walk that turns a corner every step keeps moving: no 100 ms stand-still once the estimate settles [np-a.3]', () => {
    // East, South, East, South, ... from (0,0), steps 450 ms apart (24 steps). Walking (one-tile
    // steps within the window) but never straight, so never continued; brackets of 450 ms are
    // inside the 600 ms walk span, so they are lerped, not re-anchored. Every interval deviates
    // 250 ms: the delay reaches its 500 ms cap after 7 samples. Settled, the render clock trails
    // the newest step by 50 ms or more, and the lerp moves 16 / 450 = 0.036 tile per frame,
    // inside the 0.08 slew budget: the drawn position moves every frame.
    const N = 24;
    const arrivals: Arrival[] = [{ at: 1000, row: row(9n, 0, 0) }];
    for (let k = 1; k <= N; k++) {
      const east = k % 2 === 1;
      arrivals.push({
        at: 1000 + 450 * k,
        row: row(9n, Math.ceil(k / 2), Math.floor(k / 2), east ? 'East' : 'South'),
      });
    }
    const lastAt = 1000 + 450 * N;
    const t = track(run(arrivals, { from: 1000, to: lastAt, frameMs: 16, walkable: OPEN }), 9n);
    const sampled = t.filter((f) => f.now >= 1000 + 450 * 12);
    expect(
      sampled.length,
      'ANTI-VACUITY: frames sampled after the estimate settles',
    ).toBeGreaterThan(100);
    for (const f of sampled) {
      expect(adaptiveInterpDelayMs(f.c.jitterEwma, STEP_MS), `delay at ${f.now}`).toBe(500);
    }
    let runStart = sampled[0]!;
    let longestStill = 0;
    for (let i = 1; i < sampled.length; i++) {
      const a = sampled[i - 1]!;
      const b = sampled[i]!;
      const still = Math.abs(b.x - a.x) + Math.abs(b.y - a.y) <= EPS;
      if (!still) runStart = b;
      longestStill = Math.max(longestStill, b.now - runStart.now);
    }
    expect(longestStill, 'longest stand-still (ms)').toBeLessThan(100);
    const first = sampled[0]!;
    const last = sampled[sampled.length - 1]!;
    expect(last.x + last.y - (first.x + first.y), 'advances along the walk').toBeGreaterThan(8);
  });

  // --- np-a.7 -------------------------------------------------------------------------------

  /** The held baseline for a frame: interpolation at the adaptive delay, then HOLD. */
  function heldBaseline(f: Drawn): { readonly x: number; readonly y: number } {
    return interpolateHistory(
      f.c.snapshots,
      f.now - adaptiveInterpDelayMs(f.c.jitterEwma, STEP_MS),
      STEP_MS,
    );
  }

  function expectHeldBaseline(frames: readonly Drawn[], label: string): void {
    for (const f of frames) {
      const want = heldBaseline(f);
      expect(f.x, `${label}: x at ${f.now}`).toBeCloseTo(want.x, 9);
      expect(f.y, `${label}: y at ${f.now}`).toBeCloseTo(want.y, 9);
      expect(f.x, `${label}: never past the newest tile at ${f.now}`).toBeLessThanOrEqual(
        f.c.latest.tileX + EPS,
      );
    }
  }

  it('a lone step after a long idle renders as a held remote: one STEP_MS slide, then HOLD on the new tile [np-a.7]', () => {
    // (5,5) since 1000, one step to (6,5) at 6000: one position change, not a walk. The idle gap
    // is gated out of the estimate, delay 200; the re-anchored slide moves 16/200 = 0.08 tile
    // per 16 ms frame, exactly the slew budget, so the drawn position is the held baseline.
    const t = track(
      run(
        [
          { at: 1000, row: row(9n, 5, 5) },
          { at: 6000, row: row(9n, 6, 5) },
        ],
        { from: 5900, to: 6450, frameMs: 16, walkable: OPEN },
      ),
      9n,
    );
    expectHeldBaseline(t, 'lone step');
    expect(t[t.length - 1]!.x).toBeCloseTo(6, 9);
  });

  it('two same-direction steps 1000 ms apart (an NPC wandering) render as a held remote and come to rest on the newest tile [np-a.7]', () => {
    // 1000 ms between position changes is more than the 600 ms window: not a walk. Every interval
    // is gated (> 600), delay 200; each step is a hold-then-slide (0.08 tile / frame).
    // The Idle row at 3100 lands mid-slide: drawn Walking until the remote is on (2,0) at 3200.
    const t = track(
      run([...walkEast(9n, [1000, 2000, 3000]), { at: 3100, row: row(9n, 2, 0, 'East', 'Idle') }], {
        from: 1000,
        to: 3600,
        frameMs: 16,
        walkable: OPEN,
      }),
      9n,
    );
    expectHeldBaseline(t, 'wander');
    for (const f of t) {
      const onTile = Math.abs(f.x - f.c.row.tileX) <= EPS && Math.abs(f.y - f.c.row.tileY) <= EPS;
      const want = f.c.row.action === 'Idle' && !onTile ? 'Walking' : f.c.row.action;
      expect(f.action, `action at ${f.now}`).toBe(want);
    }
    for (const f of t.filter((d) => d.now >= 3200)) {
      expect(f.x).toBeCloseTo(2, 9);
      expect(f.action).toBe('Idle');
    }
  });

  it('after a zone change it renders as a held remote: drawn on the new tile at once, then interpolation and HOLD [np-a.7]', () => {
    // The base walk in zone 1, then (3,0)@1600 and (4,0)@1800 in zone 2. The zone change is a
    // snap (the record empties), so the second zone-2 step is a lone step: interpolated
    // 3 -> 4 over 1800..2000 at delay 200, then HOLD at 4, never continued.
    const t = track(
      run(
        [
          ...walkEast(9n, [1000, 1200, 1400]),
          { at: 1600, row: row(9n, 3, 0, 'East', 'Walking', 2) },
          { at: 1800, row: row(9n, 4, 0, 'East', 'Walking', 2) },
        ],
        { from: 1000, to: 2400, frameMs: 16, walkable: OPEN },
      ),
      9n,
    );
    const zone2 = t.filter((f) => f.c.row.zoneId === 2);
    expect(zone2.length, 'ANTI-VACUITY: frames after the zone change').toBeGreaterThan(40);
    expect(zone2[0]!.x, 'drawn on the new zone tile at once').toBeCloseTo(3, 9);
    expectHeldBaseline(zone2, 'zone change');
    expect(zone2[zone2.length - 1]!.x).toBeCloseTo(4, 9);
  });
});
