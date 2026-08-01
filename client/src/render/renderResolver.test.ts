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
});
