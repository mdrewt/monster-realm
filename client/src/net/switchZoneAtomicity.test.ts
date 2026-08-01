// net/switchZoneAtomicity.test.ts — gating test for M12.5c-RT-SZ-01.
//
// INVARIANT: switchZone(newZoneId) must be ALL-OR-NOTHING with respect to
// module-level state. If ANY step after "validate" fails, rawMap MUST remain
// equal to the pre-switch value. The current implementation violates this:
//   1. zone_map(newZoneId)      — OK
//   2. TileMap.fromRaw(newRaw)  — validation passes (the guard)
//   3. set_active_zone(newZoneId) — WASM mutation (committed)
//   4. rawMap = newRawMap         — JS mutation (committed)
//   5. renderer.setMap(rawMap)   — can throw (Pixi error, OOM, etc.)
//   6. resetPredictionState()    — skipped
//
// If step 5 throws, the catch block logs "keeping current zone" but rawMap is
// already pointing at newZoneId (step 4 committed). The predictor still holds
// its stale state from the old zone (step 6 skipped). The WASM zone is already
// set to newZoneId (step 3 committed). Three pieces of state now disagree.
//
// This test models the switchZone logic using an injectable renderer interface
// (the same shape WorldRenderer.setMap uses) so it can run without Pixi.js.
// It demonstrates the invariant failure and will go GREEN only after the fix
// restructures switchZone so that renderer.setMap is called before rawMap is
// mutated (or is wrapped so a throw rolls back rawMap).
//
// SOURCE OF TRUTH: M12.5c red-team finding RT-SZ-01 (partial-mutation split-brain).
// EARS: After switchZone completes (including when its renderer call throws),
// rawMap.zone_id MUST equal the zone_id it held on entry.

import { describe, expect, it } from 'vitest';
// 11r-h (ADR-0172 D6): RT-SZ-02 below drives the REAL Predictor against a deterministic,
// node-only `applyMove` stand-in (the same injection pattern as
// client/src/prediction/predictor.test.ts:49-63). The wasm movement rule itself is proven in
// Rust at M1 — this file never imports wasm. The convert imports are TYPE-ONLY, so nothing
// executable crosses the boundary.
import type { WasmCharacterState, WasmDirection, WasmMoveInput } from '../convert/convert';
import { type ApplyMove, Predictor } from '../prediction/predictor';

// ---------------------------------------------------------------------------
// Minimal stub types — mirror the shapes main.ts depends on from wasm and
// WorldRenderer without pulling in the real implementations.
// ---------------------------------------------------------------------------

interface FakeRawMap {
  zone_id: number;
  width: number;
  height: number;
  walkable: boolean[];
  grass: boolean[];
}

function makeFakeMap(zoneId: number): FakeRawMap {
  return {
    zone_id: zoneId,
    width: 2,
    height: 2,
    walkable: [true, true, true, true],
    grass: [false, false, false, false],
  };
}

// Models the switchZone logic AS WRITTEN in M12.5c — with the bug.
// Returns the rawMap zone_id after the attempted switch.
function switchZoneBuggy(
  currentRawMap: FakeRawMap,
  newZoneId: number,
  zoneMapFn: (id: number) => FakeRawMap,
  validateFn: (raw: FakeRawMap) => void, // TileMap.fromRaw
  setActiveZoneFn: (id: number) => void, // set_active_zone WASM
  setMapFn: (raw: FakeRawMap) => void, // renderer.setMap (can throw)
  resetPredictionFn: () => void,
): { rawMapZoneAfter: number; setActiveCalled: boolean; resetCalled: boolean } {
  let rawMap = { ...currentRawMap };
  let setActiveCalled = false;
  let resetCalled = false;

  if (newZoneId === rawMap.zone_id) {
    return { rawMapZoneAfter: rawMap.zone_id, setActiveCalled, resetCalled };
  }

  try {
    const newRawMap = zoneMapFn(newZoneId);
    validateFn(newRawMap); // step 2: validate — does NOT mutate
    setActiveZoneFn(newZoneId); // step 3: wasm mutation
    setActiveCalled = true;
    rawMap = newRawMap; // step 4: rawMap mutated HERE
    setMapFn(rawMap); // step 5: can throw
    resetPredictionFn(); // step 6: skipped on throw
    resetCalled = true;
  } catch {
    // bug: rawMap is already newRawMap if step 5 threw
  }

  return { rawMapZoneAfter: rawMap.zone_id, setActiveCalled, resetCalled };
}

// The FIXED version: setMap is called BEFORE rawMap is permanently assigned,
// or rawMap is only assigned after setMap succeeds.
function switchZoneFixed(
  currentRawMap: FakeRawMap,
  newZoneId: number,
  zoneMapFn: (id: number) => FakeRawMap,
  validateFn: (raw: FakeRawMap) => void,
  setActiveZoneFn: (id: number) => void,
  setMapFn: (raw: FakeRawMap) => void,
  resetPredictionFn: () => void,
): { rawMapZoneAfter: number; setActiveCalled: boolean; resetCalled: boolean } {
  let rawMap = { ...currentRawMap };
  let setActiveCalled = false;
  let resetCalled = false;

  if (newZoneId === rawMap.zone_id) {
    return { rawMapZoneAfter: rawMap.zone_id, setActiveCalled, resetCalled };
  }

  try {
    const newRawMap = zoneMapFn(newZoneId);
    validateFn(newRawMap);
    setMapFn(newRawMap); // attempt renderer FIRST — throws before any mutation
    setActiveZoneFn(newZoneId); // wasm mutation only after renderer succeeded
    setActiveCalled = true;
    rawMap = newRawMap; // rawMap assigned only after both succeeded
    resetPredictionFn();
    resetCalled = true;
  } catch {
    // rawMap unchanged: zone_id still equals currentRawMap.zone_id
  }

  return { rawMapZoneAfter: rawMap.zone_id, setActiveCalled, resetCalled };
}

// ---------------------------------------------------------------------------
// Gating suite: RT-SZ-01
// ---------------------------------------------------------------------------

describe('RT-SZ-01: switchZone partial-mutation split-brain when renderer.setMap throws', () => {
  const originalZoneId = 0;
  const newZoneId = 1;
  const startMap = makeFakeMap(originalZoneId);

  const validZoneMap = (id: number): FakeRawMap => makeFakeMap(id);
  const passingValidate = (_raw: FakeRawMap): void => {
    /* no-op: parse succeeds */
  };
  const noopSetActive = (_id: number): void => {
    /* wasm stub */
  };
  const noopReset = (): void => {
    /* predictor stub */
  };

  // Renderer.setMap that always throws (simulates Pixi error, OOM, etc.)
  const throwingSetMap = (_raw: FakeRawMap): void => {
    throw new Error('Pixi: out of GPU memory');
  };

  it('BITES (buggy): rawMap.zone_id is corrupted to newZoneId when renderer.setMap throws', () => {
    // This assertion documents the bug as it exists in the current implementation.
    // If switchZone is fixed, this test must be updated (or replaced by the fixed test below).
    const result = switchZoneBuggy(
      startMap,
      newZoneId,
      validZoneMap,
      passingValidate,
      noopSetActive,
      throwingSetMap,
      noopReset,
    );

    // DOCUMENTS THE BUG: rawMap has been mutated even though setMap threw.
    // After the catch block the code believes it "kept current zone" (console.error says so)
    // but rawMap.zone_id is newZoneId, not originalZoneId.
    expect(result.rawMapZoneAfter).toBe(newZoneId); // BUG: should be originalZoneId
    expect(result.setActiveCalled).toBe(true); // set_active_zone already fired
    expect(result.resetCalled).toBe(false); // resetPredictionState never ran
  });

  it('FIXED: rawMap.zone_id stays at originalZoneId when renderer.setMap throws', () => {
    // This assertion documents the correct behaviour after the fix.
    // The fix moves renderer.setMap BEFORE the rawMap mutation so a throw
    // leaves rawMap unchanged.
    const result = switchZoneFixed(
      startMap,
      newZoneId,
      validZoneMap,
      passingValidate,
      noopSetActive,
      throwingSetMap,
      noopReset,
    );

    // INVARIANT: rawMap must still be at the original zone after a failed switch.
    expect(result.rawMapZoneAfter).toBe(originalZoneId);
    expect(result.setActiveCalled).toBe(false); // wasm mutation was not committed either
    expect(result.resetCalled).toBe(false); // prediction state was not disturbed
  });

  it('FIXED: successful switch completes all three mutations atomically', () => {
    const passingSetMap = (_raw: FakeRawMap): void => {
      /* no-op: success */
    };
    const result = switchZoneFixed(
      startMap,
      newZoneId,
      validZoneMap,
      passingValidate,
      noopSetActive,
      passingSetMap,
      noopReset,
    );
    expect(result.rawMapZoneAfter).toBe(newZoneId);
    expect(result.setActiveCalled).toBe(true);
    expect(result.resetCalled).toBe(true);
  });

  it('FIXED: idempotent guard — same-zone call never mutates anything', () => {
    const sameZone = makeFakeMap(0);
    const passingSetMap = (_raw: FakeRawMap): void => {
      /* success */
    };
    const result = switchZoneFixed(
      sameZone,
      0, // same as current
      validZoneMap,
      passingValidate,
      noopSetActive,
      passingSetMap,
      noopReset,
    );
    expect(result.rawMapZoneAfter).toBe(0);
    expect(result.setActiveCalled).toBe(false);
    expect(result.resetCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RT-SZ-02: prediction on the zone-switch batch (UPDATED by commit 8c18860)
// ---------------------------------------------------------------------------
// BEHAVIOUR UNDER TEST (after 8c18860): the batch listener does NOT return early
// after switchZone. It FALLS THROUGH and runs the prediction reconcile on the SAME
// batch as the zone transition. switchZone() calls resetPredictionState(), which
// leaves #predicted undefined, so the subsequent predictor.reconcile() is a SEEDING
// reconcile — `before === undefined` ⇒ it returns false. Consequences:
//   - ownPredictedTile is non-null on the SAME batch that triggered the switch;
//   - no held-key re-issue fires on that batch (the seeding reconcile returns false).
//
// PRIOR BEHAVIOUR (before 8c18860): an unconditional early `return` after switchZone()
// skipped prediction on the zone-switch batch, leaving ownPredictedTile null until the
// next server batch — a CI Chromium flake when the SpacetimeDB tick cadence was slow
// enough that no second batch arrived before snap().
//
// 11r-h (ADR-0172 D6) — WHAT CHANGED HERE, STATED PLAINLY: this block previously ended
// with "No assertion required: this is a documentation test" over a single
// `expect(true).toBe(true)`. That prose was false — the contract WAS assertable, and the
// suite below now asserts it against the real `Predictor`. Both `it`s construct their OWN
// instance (no shared mutated state across cases).
//
// The two cases here are DELIBERATELY stronger than predictor.test.ts:117 (which covers
// the EMPTY-queue seeding reconcile): case A's authQueue is NON-EMPTY, so the reconcile's
// own step-4 drain advances the predicted tile DURING the very call that returns false.
// Asserting the moved tile is what stops "false because nothing happened" being a new
// flavour of vacuous pass.
//
// HONEST SCOPE: this pins `Predictor.reconcile`. It does NOT pin RT-SZ-02's other half —
// that the batch listener FALLS THROUGH to reconcile after switchZone. That half is a
// source-scan tooth over main.ts, `W-11RH-ZONESWITCH-FALLTHROUGH` in
// client/src/main.wiring.test.ts, plus e2e 12.5c-1/5.
//
// DETERMINISM: no clock, no wasm, no RNG. `NOW`/`STEP_MS` are fixed constants and the
// injected applyMove is a pure function of (state, input, now).

const STEP_MS = 200;
const QUEUE_CAP = 8;
/** Fixed logical "now" for every case below — nothing here reads a real clock. */
const NOW = 10_000;

// --- the injected deterministic applyMove fake (copied from predictor.test.ts:49-63) ---
// Walls at x <= 0 (west border): a West step from x=1 bumps (Idle, no move). Everything
// else is walkable. Jump moves one tile in `facing` (hop in place if blocked).
function stepTile(dir: WasmDirection, x: number, y: number): { x: number; y: number } {
  switch (dir) {
    case 'North':
      return { x, y: y - 1 };
    case 'South':
      return { x, y: y + 1 };
    case 'East':
      return { x: x + 1, y };
    case 'West':
      return { x: x - 1, y };
  }
}
function walkableTile(p: { x: number; y: number }): boolean {
  return p.x > 0; // west wall at x <= 0
}
const applyMove: ApplyMove = (state, input, now): WasmCharacterState => {
  const stamp = Math.floor(now);
  if (input === 'Jump') {
    const target = stepTile(state.facing, state.pos.x, state.pos.y);
    const pos = walkableTile(target) ? target : state.pos; // hop in place if blocked
    return { ...state, pos, action: 'Jumping', move_started_at: stamp };
  }
  const dir = input.Step;
  const target = stepTile(dir, state.pos.x, state.pos.y);
  if (walkableTile(target)) {
    return { pos: target, facing: dir, action: 'Walking', move_started_at: stamp };
  }
  return { ...state, facing: dir, action: 'Idle', move_started_at: stamp };
};

/** An authoritative baseline already rebased to a local-time stamp (what M4 feeds). */
function baseline(x: number, y: number, rebasedAt: number): WasmCharacterState {
  return { pos: { x, y }, facing: 'East', action: 'Idle', move_started_at: rebasedAt };
}

const EAST: WasmMoveInput = { Step: 'East' };

describe('RT-SZ-02: prediction reconcile runs on same batch as zone switch', () => {
  it('RT-SZ-02a: the post-switchZone SEEDING reconcile returns false EVEN THOUGH its own drain advances the tile', () => {
    // EARS E1.1 — WHEN Predictor.reconcile is called on an instance whose #predicted is
    // undefined (exactly the post-resetPredictionState() state a zone switch leaves),
    // THE SYSTEM SHALL return false, even when the reconcile's own drain advances the
    // predicted tile. `false` here is what keeps the held-key re-issue path out of the
    // zone-switch batch (main.ts:768 gates on `diverged`).
    //
    // FIXTURE NOTE (deterministic by construction, and ON THE BOUNDARY): the baseline is
    // stamped at NOW - STEP_MS, so #stepForward's due-test `move_started_at + stepMs <= now`
    // holds with EQUALITY — the single queued East step is applied exactly once, taking the
    // predicted tile from (5,5) to (6,5). No clock, no wasm, no randomness is involved.
    const p = new Predictor(applyMove, STEP_MS, QUEUE_CAP);

    const diverged = p.reconcile(baseline(5, 5, NOW - STEP_MS), [EAST], 0, NOW);

    // WRONG IMPL KILLED (M1a): predictor.ts:290 `if (before === undefined) return false;`
    // flipped to `return true;`. Every zone switch would then report a divergence and
    // re-issue the held key on the switch batch.
    // WRONG IMPL KILLED (M1c-empty): `reconcile(...) { return false; }` with the BODY
    // DELETED — nothing ever seeds #predicted, so the `toBeDefined()` assertion below reds.
    // Recorded honestly: that is a DIFFERENT mutant from the body-RETAINED
    // `…; return false;` one, which survives this case entirely and is killed by RT-SZ-02b
    // alone. This case's `false` is NOT, on its own, evidence against an always-false impl.
    expect(
      diverged,
      'the seeding reconcile (post-switchZone, #predicted undefined) must return FALSE — a ' +
        'true here re-issues the held key on the zone-switch batch (predictor.ts:290)',
    ).toBe(false);

    // WRONG IMPL KILLED (M1b): deleting predictor.ts:290 entirely — `after.x !== before.x`
    // then throws on `before === undefined`, so this case reds with a TypeError.
    expect(
      p.predicted,
      'the seeding reconcile must SEED #predicted from the authoritative baseline — ' +
        'ownPredictedTile has to be non-null on the very batch that switched the zone',
    ).toBeDefined();

    // WRONG IMPL KILLED (M1d): deleting `this.#stepForward(now);` (predictor.ts:288) from
    // reconcile — the return value stays false and the assertion above still passes, but the
    // predicted tile would stay at (5,5). THIS is the assertion that stops "false because
    // nothing happened" from being a vacuous pass: the drain provably ran during the same
    // call that returned false.
    expect(
      p.predicted?.pos,
      'reconcile step 4 must drain the authoritative queue during the SAME call that returns ' +
        'false: one due East step from (5,5) lands on (6,5). A tile of (5,5) means the drain ' +
        'did not run and the `false` above proves nothing',
    ).toEqual({ x: 6, y: 5 });
  });

  it('RT-SZ-02b: an already-seeded instance whose corrected tile disagrees returns true', () => {
    // EARS E1.2 — WHEN reconcile is called on an already-seeded instance and the corrected
    // tile differs from the pre-reconcile predicted tile, THE SYSTEM SHALL return true.
    //
    // WHY THIS CASE EXISTS: without it, the always-false mutant
    //   reconcile(...) { …whole body retained…; return false; }
    // passes RT-SZ-02a completely (the drain still runs, the tile still moves to (6,5)) and
    // the `false` assertion there would be measuring nothing at all. This is the ONLY case
    // that kills it.
    const p = new Predictor(applyMove, STEP_MS, QUEUE_CAP);

    // Seed first, with an EMPTY authoritative queue so nothing drains: predicted = (5,5).
    const seeding = p.reconcile(baseline(5, 5, NOW), [], 0, NOW);
    expect(seeding, 'the first reconcile on a fresh instance is the seeding one').toBe(false);
    expect(
      p.predicted?.pos,
      'anti-vacuity: the instance must really be seeded at (5,5) before the divergence case — ' +
        'an unseeded instance would take the `before === undefined` branch again and the ' +
        '`true` below would be unreachable for the wrong reason',
    ).toEqual({ x: 5, y: 5 });

    // Now the server disagrees: the authoritative baseline is two tiles east.
    const diverged = p.reconcile(baseline(7, 5, NOW), [], 0, NOW);

    expect(
      diverged,
      'a genuine server pullback (predicted (5,5) → corrected (7,5)) must return TRUE — this ' +
        'is what re-commits the held direction (main.ts:768). An implementation that always ' +
        'returns false makes RT-SZ-02a vacuous and silently disables the re-issue path',
    ).toBe(true);
    expect(
      p.predicted?.pos,
      'and the predicted tile must be RESET to the authoritative truth (predictor.ts step 3)',
    ).toEqual({ x: 7, y: 5 });
  });
});
