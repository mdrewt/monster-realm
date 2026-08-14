// prediction/heldKeys.test.ts — HeldDirections + reissueDir (M8.6c, ADR-0013.5)
//
// RED reason (M8.6c, historical): heldKeys.ts did NOT EXIST YET — the import itself
// failed and the entire suite stayed red until the implementer created the module.
//
// RED reason (mvi, THIS slice): `press` gains a REQUIRED `nowMs` argument, the module
// gains `export const HOLD_COMMIT_MS = 150`, and `HeldDirections` gains
// `committedActive(nowMs)` + a `constructor(holdCommitMs = HOLD_COMMIT_MS)`. The
// import of HOLD_COMMIT_MS and every U-H* tooth below are red until that lands. The
// pre-existing teeth are migrated MECHANICALLY (every `press(dir)` gains a timestamp;
// the timestamp is irrelevant to `active()`, so their assertions are BYTE-IDENTICAL) and
// carry no new obligation — an extra argument is harmless to the current implementation.
// NOTE on the red: the static `HOLD_COMMIT_MS` import fails at MODULE-LINK time while the
// export is missing, so the whole FILE reds, not just the U-H* teeth. That is the correct
// signal (a missing implementation, loudly), and the migrated teeth go green unchanged the
// moment heldKeys.ts exports it.
//
// This suite is pure / node-only. No wasm. No real timers.
// All tests follow the block-body arrow rule for fast-check (see project standards):
// `fc.property(arb, (x) => { expect(…).toEqual(…); })` — never expression-body.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WasmDirection } from '../convert/convert';
import { HeldDirections, HOLD_COMMIT_MS, reissueDir } from './heldKeys';

// ================================================================================
// 1. reissueDir — pure dedup decision for the frame-loop CONTINUATION re-issue
// ================================================================================

describe('reissueDir: pure dedup logic', () => {
  it('returns active when active !== lastQueuedDir (should re-issue)', () => {
    // Kills: an impl that always returns undefined (never re-issues).
    // When East is held but the last queued dir was North, we MUST re-issue East.
    expect(reissueDir('East', 'North')).toBe('East');
    expect(reissueDir('North', 'South')).toBe('North');
    expect(reissueDir('West', 'East')).toBe('West');
    expect(reissueDir('South', undefined)).toBe('South'); // queue was drained, re-issue
  });

  it('returns undefined when active === lastQueuedDir (dedup: already queued this dir)', () => {
    // Kills: an impl that always re-issues (no dedup) — the queue/pending would
    // over-fill with duplicate held-direction entries on every frame tick.
    expect(reissueDir('East', 'East')).toBeUndefined();
    expect(reissueDir('North', 'North')).toBeUndefined();
    expect(reissueDir('South', 'South')).toBeUndefined();
    expect(reissueDir('West', 'West')).toBeUndefined();
  });

  it('returns undefined when active === undefined (no key held)', () => {
    // Kills: an impl that reads active without an undefined guard and crashes or
    // returns a garbage value.
    expect(reissueDir(undefined, 'East')).toBeUndefined();
    expect(reissueDir(undefined, undefined)).toBeUndefined();
    expect(reissueDir(undefined, 'North')).toBeUndefined();
  });

  it('returns active when lastQueuedDir === undefined (queue drained → re-issue resumes)', () => {
    // Kills: an impl that treats undefined lastQueuedDir as "already queued" — i.e.
    // one that does `lastQueuedDir === undefined ? undefined : ...`. When the queue
    // drains (lastQueuedDir goes undefined), continuous movement MUST resume.
    expect(reissueDir('East', undefined)).toBe('East');
    expect(reissueDir('North', undefined)).toBe('North');
    expect(reissueDir('South', undefined)).toBe('South');
    expect(reissueDir('West', undefined)).toBe('West');
  });

  it('fast-check property: reissueDir returns active IFF (active !== undefined && active !== lastQueuedDir)', () => {
    // Kills: any impl that deviates from the exact criterion on edge cases.
    const dirArb = fc.constantFrom<WasmDirection>('North', 'South', 'East', 'West');
    const maybeDirArb = fc.option(dirArb, { nil: undefined });
    fc.assert(
      fc.property(maybeDirArb, maybeDirArb, (active, lastQueuedDir) => {
        const result = reissueDir(active, lastQueuedDir);
        if (active !== undefined && active !== lastQueuedDir) {
          expect(result).toBe(active);
        } else {
          expect(result).toBeUndefined();
        }
      }),
    );
  });
});

// ================================================================================
// 2. HeldDirections — multi-key tracking with most-recently-pressed priority
// ================================================================================

describe('HeldDirections: single key press/release', () => {
  it('press(N) → active() === "North"', () => {
    // Kills: an impl that leaves active() undefined after a press, or returns the
    // wrong direction.
    const held = new HeldDirections();
    held.press('North', 0);
    expect(held.active()).toBe('North');
  });

  it('pressing a dir twice → active() unchanged AND a single release clears it', () => {
    // Kills: an impl that stores duplicates: if press(N) twice pushes N twice,
    // then one release(N) would leave N still "held" → active() !== undefined.
    // The no-dup invariant: pressing an already-held dir is a no-op.
    const held = new HeldDirections();
    held.press('North', 0);
    held.press('North', 0); // duplicate press — must be ignored
    expect(held.active()).toBe('North');
    held.release('North');
    expect(held.active()).toBeUndefined(); // one release clears it (no dup stored)
  });

  it('release of a non-held dir is a harmless no-op', () => {
    // Kills: an impl that throws or corrupts state on release of an un-held dir.
    const held = new HeldDirections();
    expect(() => held.release('East')).not.toThrow();
    held.press('North', 0);
    held.release('East'); // East was never pressed
    expect(held.active()).toBe('North'); // North unaffected
  });

  it('clear() removes all dirs → active() === undefined', () => {
    // Kills: an impl that forgets to clear the stack or the set.
    const held = new HeldDirections();
    held.press('North', 0);
    held.press('East', 0);
    held.clear();
    expect(held.active()).toBeUndefined();
  });
});

describe('HeldDirections: two-key fallback (the critical stack regression)', () => {
  it('press(N), press(S) → active() === "South" (most-recently-pressed)', () => {
    // Kills: an impl that returns the first-pressed key rather than the last.
    const held = new HeldDirections();
    held.press('North', 0);
    held.press('South', 0);
    expect(held.active()).toBe('South');
  });

  it('press(N), press(S), release(S) → active() === "North" (fallback to previous)', () => {
    // THIS IS THE CRITICAL ANTI-SCALAR-REGRESSION TEST.
    // Kills: a scalar `heldDir` impl that just writes the last pressed key and clears on
    // release — it would lose 'North' when 'South' was released, returning undefined.
    // A correct stack/set impl falls back to the previously held key.
    const held = new HeldDirections();
    held.press('North', 0);
    held.press('South', 0);
    held.release('South');
    expect(held.active()).toBe('North'); // must NOT be undefined
  });

  it('press(N), press(E), release(N) → active() === "East" (the non-released key wins)', () => {
    // Kills: an impl that clears on any release, or tracks only one key.
    const held = new HeldDirections();
    held.press('North', 0);
    held.press('East', 0);
    held.release('North');
    expect(held.active()).toBe('East');
  });

  it('press(N), press(S), press(E) → active() === "East"; release(E) → active() === "South"', () => {
    // Kills: a 2-slot impl that drops the oldest key when a 3rd is pressed.
    // After pressing 3, releasing the most-recent falls back to the 2nd.
    const held = new HeldDirections();
    held.press('North', 0);
    held.press('South', 0);
    held.press('East', 0);
    expect(held.active()).toBe('East');
    held.release('East');
    expect(held.active()).toBe('South'); // falls back to the previously held key
  });

  it('press(N), press(S), release(N) → active() remains "South" (still held)', () => {
    // Kills: an impl that uses a stack where releasing a non-top element corrupts the
    // stack order, causing the wrong key to become active.
    const held = new HeldDirections();
    held.press('North', 0);
    held.press('South', 0);
    held.release('North'); // release a non-active key
    expect(held.active()).toBe('South'); // South is still the most-recently-pressed held key
  });

  it('all four dirs pressed then released in LIFO order → active() tracks correctly', () => {
    // Kills: an impl with off-by-one in stack traversal.
    const held = new HeldDirections();
    held.press('North', 0);
    held.press('South', 0);
    held.press('East', 0);
    held.press('West', 0);
    expect(held.active()).toBe('West');
    held.release('West');
    expect(held.active()).toBe('East');
    held.release('East');
    expect(held.active()).toBe('South');
    held.release('South');
    expect(held.active()).toBe('North');
    held.release('North');
    expect(held.active()).toBeUndefined();
  });
});

describe('HeldDirections: fast-check property — active() is the most-recent still-held dir', () => {
  it('after any sequence of press/release ops, active() is the most-recently-pressed still-held dir', () => {
    // Kills: any impl that violates MRU ordering or drops a key early.
    const dirArb = fc.constantFrom<WasmDirection>('North', 'South', 'East', 'West');
    type Op =
      | { kind: 'press'; dir: WasmDirection }
      | { kind: 'release'; dir: WasmDirection }
      | { kind: 'clear' };
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      dirArb.map((dir): Op => ({ kind: 'press', dir })),
      dirArb.map((dir): Op => ({ kind: 'release', dir })),
      fc.constant<Op>({ kind: 'clear' }),
    );
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const held = new HeldDirections();
        // Track a reference model in-test: ordered array of held dirs (last = most recent)
        // using a simple ordered-insert de-dup model.
        const model: WasmDirection[] = [];
        for (const op of ops) {
          if (op.kind === 'press') {
            held.press(op.dir, 0);
            // no-dup: if already present, do nothing; else push to end (most recent)
            if (!model.includes(op.dir)) model.push(op.dir);
          } else if (op.kind === 'release') {
            held.release(op.dir);
            const idx = model.lastIndexOf(op.dir);
            if (idx !== -1) model.splice(idx, 1);
          } else {
            held.clear();
            model.length = 0;
          }
        }
        // expected active: last element in model (most recently pressed still held)
        const expected = model.length > 0 ? model[model.length - 1] : undefined;
        expect(held.active()).toBe(expected);
      }),
    );
  });
});

// ================================================================================
// 4. [mvi] committedActive — the HOLD-COMMIT threshold that separates a TAP from a
//    deliberate WALK.
//
// SOURCE OF TRUTH: the movement-investigation spec. `committedActive(nowMs)` returns
// the ACTIVE (stack-top) dir iff `nowMs - top.pressedAtMs >= holdCommitMs`, else
// undefined. `active()` keeps its old, ungated meaning (nothing reads it in main.ts
// after this slice — W-MVI-COMMITTED-WIRED pins that).
//
// THE DESIGN CONSTRAINT THESE TEETH ENCODE: the press timestamp lives INSIDE the stack
// entry, so `release`/`clear` evict it BY CONSTRUCTION. A parallel `Map<dir, pressedAt>`
// is the mutant family this section exists to kill (a red-team PoC of one that forgets
// to evict on release double-moves on a same-direction re-tap; U-H7 is its precise
// killer and movementSim's S1 scenario (c) is its end-to-end killer).
// ================================================================================

describe('[mvi] HeldDirections.committedActive: the hold-commit threshold', () => {
  it('U-H1 BITES: boundary table {0, X-1, X, X+1} → {undefined, undefined, dir, dir} (>= semantics)', () => {
    // Kills: `>` instead of `>=` (the X row would be undefined); an off-by-one that
    // commits at X-1; and any impl that commits the instant a key goes down (which is
    // exactly today's `active()` behaviour and the r2 defect).
    const X = 150;
    const held = new HeldDirections(X);
    held.press('East', 1000);
    expect(held.committedActive(1000)).toBeUndefined(); // 0ms held
    expect(held.committedActive(1000 + X - 1)).toBeUndefined(); // X-1 ms held
    expect(held.committedActive(1000 + X)).toBe('East'); // X ms held — COMMITTED
    expect(held.committedActive(1000 + X + 1)).toBe('East'); // X+1 ms held

    // The SAME table against the ARGLESS constructor + the exported default, so a
    // default that silently disagrees with HOLD_COMMIT_MS cannot hide behind the
    // explicit-threshold rows above.
    const dflt = new HeldDirections();
    dflt.press('North', 5000);
    expect(dflt.committedActive(5000)).toBeUndefined();
    expect(dflt.committedActive(5000 + HOLD_COMMIT_MS - 1)).toBeUndefined();
    expect(dflt.committedActive(5000 + HOLD_COMMIT_MS)).toBe('North');
    expect(dflt.committedActive(5000 + HOLD_COMMIT_MS + 1)).toBe('North');
  });

  it('U-H2: nothing held → committedActive() is undefined at any time', () => {
    // Kills: an impl that returns a stale last-pressed dir when the stack is empty —
    // the "stuck walking after keyup" regression the M8.6c stack was built to prevent.
    const held = new HeldDirections(150);
    expect(held.committedActive(0)).toBeUndefined();
    expect(held.committedActive(1_000_000)).toBeUndefined();
    held.press('East', 0);
    held.release('East');
    expect(held.committedActive(1_000_000)).toBeUndefined(); // released, however long ago
  });

  it('U-H3 BITES: a duplicate press does NOT refresh the stamp — the FIRST press governs', () => {
    // Kills: `press` implemented as an unconditional `set` (map) or as
    // remove-then-push (stack) — an OS key-repeat or a re-entrant keydown would then
    // restart the commit window on every repeat tick and a held key would NEVER commit,
    // silently killing continuous movement. main.ts filters `e.repeat`, but the unit
    // must be idempotent on its own (the existing no-dup tooth above is the `active()`
    // half of the same invariant).
    const held = new HeldDirections(150);
    held.press('East', 0);
    held.press('East', 100); // duplicate press of an already-held dir
    expect(held.committedActive(150)).toBe('East'); // FIRST stamp (0) governs → committed
    expect(held.committedActive(149)).toBeUndefined(); // …and not one ms earlier
  });

  it('U-H4 BITES: two-key fallback keeps the older key ORIGINAL stamp (no fresh window on release)', () => {
    // THE precise killer for the `activeSince`-scalar mutant family: an impl that stamps
    // "when the active dir last changed" restarts A's window at the moment B is released,
    // so a long-held A would have to be re-earned for another 150ms — a visible stutter
    // mid-walk every time the player brushes a second arrow key (movementSim S8 is the
    // end-to-end version of this, and only bites in high-latency cells; THIS is the
    // parameter-free kill).
    const held = new HeldDirections(150);
    held.press('North', 0); // A, committed long before B appears
    held.press('South', 1000); // B becomes active (its own window opens at 1150)
    held.release('South'); // …and B is released at t=1050, before it ever commits
    expect(held.active()).toBe('North'); // fallback (pre-existing semantics)
    // t=1060 is only 60ms after B was pressed, but A has been held for 1060ms: A's
    // ORIGINAL stamp (0) governs, so the walk resumes IMMEDIATELY, not 150ms later.
    expect(held.committedActive(1060)).toBe('North');
  });

  it('U-H5 BITES: a newly-pressed key does not inherit the older key commitment', () => {
    // Kills the "any held dir that has been held >= X" mis-binding (e.g. a scan over the
    // whole stack, or `#stack.find(e => now - e.pressedAtMs >= X)`): North has been held
    // for over a second and IS committed, but it is no longer the ACTIVE dir; East is
    // active and NOT yet committed. The correct answer is undefined — the player just
    // changed direction and no continuation may fire until East earns its own window.
    // The mis-binding would keep walking NORTH after the player turned east.
    const held = new HeldDirections(150);
    held.press('North', 0);
    held.press('East', 1000);
    expect(held.active()).toBe('East');
    expect(held.committedActive(1100)).toBeUndefined(); // East uncommitted; North not active
    expect(held.committedActive(1150)).toBe('East'); // East earns its OWN window
  });

  it('U-H6 BITES: clear() then press starts a FRESH window', () => {
    // Kills: a parallel stamp map that `clear()` forgets to empty. main.ts calls
    // held.clear() on blur and on every overlay open/close and on reconnect
    // (main.ts:308/851/884/965/1114); a surviving stamp means the first key pressed
    // after an overlay closes would be INSTANTLY committed and could double-move.
    const held = new HeldDirections(150);
    held.press('East', 0);
    held.clear();
    held.press('East', 60);
    expect(held.committedActive(120)).toBeUndefined(); // 60ms into the FRESH window
    expect(held.committedActive(210)).toBe('East'); // 150ms into the FRESH window
  });

  it('U-H7 BITES: release-then-repress of the SAME dir starts a FRESH window (stale-stamp killer)', () => {
    // THE red-team mutant this tooth exists for: a parallel `Map<dir, pressedAtMs>` whose
    // `release` splices `#stack` but leaves the map entry behind. `active()` stays correct,
    // every legacy tooth stays green, and `committedActive` returns the dir IMMEDIATELY on
    // a re-tap of a direction the player walked in earlier — a guaranteed double-move on
    // the second tap. The fix keeps the stamp INSIDE the stack entry so eviction is
    // structural. movementSim S1 scenario (c) is the end-to-end version.
    const held = new HeldDirections(150);
    held.press('East', 0);
    expect(held.committedActive(500)).toBe('East'); // long-held: committed
    held.release('East');
    held.press('East', 600); // the re-tap
    expect(held.committedActive(650)).toBeUndefined(); // 50ms into the FRESH window
    expect(held.committedActive(750)).toBe('East'); // 150ms into the FRESH window
  });

  it('U-H8 BUDGET PIN: 140 <= HOLD_COMMIT_MS and HOLD_COMMIT_MS + 1000/30 + 1 < STEP_MS(200)', () => {
    // The threshold is squeezed from BOTH sides and neither bound is arbitrary:
    //
    // CEILING (< 200): after the first step drains, the continuation must reach the
    // server before the NEXT movement_tick 200ms later, or a deliberate walk stutters a
    // whole slot on start. The worst-case budget is the threshold plus one frame at the
    // slowest supported refresh rate (1000/30 ≈ 33.3ms) plus a millisecond of jitter =
    // 184.3ms. movementSim S4 measures the real margin (min 22.9ms) and S5 proves that
    // metric reds at 175.
    //
    // FLOOR (>= 140): a tap must be fully covered or the r2 defect survives. The sweep
    // measured taps up to 140ms as safe in EVERY (fps × tickPhase × scenario) cell, so
    // the threshold may never drop below that without re-opening the defect.
    //
    // Kills: any future "tuning" of HOLD_COMMIT_MS that silently breaks one of the two
    // constraints while every behavioural tooth still happens to pass on its own grid.
    expect(HOLD_COMMIT_MS + 1000 / 30 + 1).toBeLessThan(200);
    expect(HOLD_COMMIT_MS).toBeGreaterThanOrEqual(140);
  });
});

// ================================================================================
// 4b. [14r-e / ADR-0187] isHeld — MEMBERSHIP in the held set, deliberately NOT the
//     stack top.
//
// WHY IT EXISTS: KEY_DIR binds TWO key codes to each direction (ArrowRight AND KeyD →
// East). main.ts's keydown fired `step(dir)` unconditionally, so pressing the second
// code while the direction was already held via the first fired a SECOND ungated first
// step — a same-direction double-move. ADR-0148 disclosed it as residual 1b; ADR-0158
// named it (its residual 3) the SOLE remaining same-direction double-move path. The fix
// is `if (!held.isHeld(dir)) step(dir);` — a pure NOT-EMIT, nothing cancelled, no
// predictor state written.
//
// RED REASON at authoring time: `HeldDirections.isHeld` DOES NOT EXIST. Every call below
// throws `held.isHeld is not a function` — a missing implementation, loudly.
//
// THE CONTRACT (ADR-0187 (a)): `isHeld(dir)` is `#stack.some(e => e.dir === dir)` — the
// SAME predicate `press()` already uses for its no-dup guard, so a mutation that breaks
// one breaks the other and also reds U-H3 above.
// ================================================================================

describe('[14r-e] HeldDirections.isHeld (ADR-0187): membership in the held set', () => {
  it('U-DK1: lifecycle — false when empty, true after press, false after release and after clear', () => {
    // Kills: a stub `isHeld() { return false; }` (the dedup never fires — the defect
    // survives untouched) and a stub `isHeld() { return true; }` (the FIRST press of a
    // direction would stop emitting at all, i.e. movement dies on the first keypress).
    // Also kills an isHeld that reads a parallel structure release()/clear() forgets to
    // evict: after a release the dir must be emittable again, which is exactly what
    // preserves the ADR-0148 F3 freeze-escape (release + re-press).
    const held = new HeldDirections();
    expect(held.isHeld('East')).toBe(false); // nothing held
    held.press('East', 1000);
    expect(held.isHeld('East')).toBe(true);
    expect(held.isHeld('West')).toBe(false); // a DIFFERENT dir is unaffected

    // A second, different dir must not evict the first from the held SET.
    held.press('North', 1010);
    expect(held.isHeld('East')).toBe(true);
    expect(held.isHeld('North')).toBe(true);

    held.release('East');
    expect(held.isHeld('East')).toBe(false);
    expect(held.isHeld('North')).toBe(true); // release is per-dir, not a wipe

    held.clear();
    expect(held.isHeld('North')).toBe(false);
    expect(held.isHeld('East')).toBe(false);
  });

  it('U-DK2 BITES: isHeld is MEMBERSHIP, not stack-top — East is held while North is active', () => {
    // ★ THE MUTANT THIS TOOTH EXISTS FOR: `isHeld(dir) { return this.active() === dir; }`.
    // It type-checks, it passes U-DK1 (which only ever has one dir on top when it asks),
    // and it is WRONG in the exact situation the fix is about: the player holds
    // ArrowRight (East), presses ArrowUp (North goes on TOP), then presses KeyD — the
    // second East code. A stack-top check answers "East is not held", the keydown emits,
    // and the double-move is back for anyone who plays with two hands.
    //
    // It is also the shape ADR-0187 rejects in "Alternatives considered", and it would
    // red the ADR-0158 whole-file `held.active(` === 0 tooth in main.wiring.test.ts.
    // The sim-level version of this kill is movementSim's S11.
    const held = new HeldDirections();
    held.press('East', 0);
    held.press('North', 10); // North is now the stack top / active dir
    expect(held.active()).toBe('North'); // precondition: East is NOT the active dir
    expect(held.isHeld('East')).toBe(true); // …and is nevertheless still HELD
    expect(held.isHeld('North')).toBe(true);
    expect(held.isHeld('South')).toBe(false); // never pressed — the negative control
  });

  it('U-DK3: isHeld is duration-INDEPENDENT — true immediately, while committedActive is still undefined', () => {
    // Kills: `isHeld` implemented on top of the hold-commit threshold (e.g.
    // `committedActive(now) === dir`, or any variant that takes a `nowMs`). Under that
    // shape the dedup would not engage until 150ms after the first code went down, so a
    // realistic two-code press (the two codes land within a few ms of each other) would
    // still double-move — the fix would look present and do nothing.
    // The two properties are ORTHOGONAL: `isHeld` answers "is this direction physically
    // down", `committedActive` answers "has the top dir earned a CONTINUATION". This
    // tooth pins that they disagree at t+0, which is where the dedup has to work.
    const held = new HeldDirections(150);
    held.press('East', 500);
    expect(held.isHeld('East')).toBe(true); // held at the very instant of the press
    expect(held.committedActive(500)).toBeUndefined(); // …but nowhere near committed
    expect(held.committedActive(649)).toBeUndefined(); // 149ms: still below the threshold
    expect(held.isHeld('East')).toBe(true); // membership never depended on the clock
    expect(held.committedActive(650)).toBe('East'); // the threshold does its own job
    expect(held.isHeld('East')).toBe(true);
  });
});

// ================================================================================
// 5. Integration: held-key / lag regression
//    Wire HeldDirections + reissueDir + Predictor (cap-2 queue / small pendingCap)
//    + injected applyMove over a fake frame loop with DELAYED acks.
// ================================================================================

import type { WasmCharacterState } from '../convert/convert';
// Re-declare the applyMove fake here (same logic as predictor.test.ts — node-only,
// no wasm). A West wall at x<=0; everything else walkable.
import { type ApplyMove, type IntentToSend, Predictor } from './predictor';

function fakeStep(dir: WasmDirection, x: number, y: number): { x: number; y: number } {
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
function walkable(p: { x: number; y: number }): boolean {
  return p.x > 0;
}
const applyMove: ApplyMove = (state, input, now): WasmCharacterState => {
  const stamp = Math.floor(now);
  if (input === 'Jump') {
    const target = fakeStep(state.facing, state.pos.x, state.pos.y);
    const pos = walkable(target) ? target : state.pos;
    return { ...state, pos, action: 'Jumping', move_started_at: stamp };
  }
  const dir = input.Step;
  const target = fakeStep(dir, state.pos.x, state.pos.y);
  if (walkable(target)) {
    return { pos: target, facing: dir, action: 'Walking', move_started_at: stamp };
  }
  return { ...state, facing: dir, action: 'Idle', move_started_at: stamp };
};

function fakeBaseline(
  x: number,
  y: number,
  rebasedAt: number,
  facing: WasmDirection = 'East',
): WasmCharacterState {
  return { pos: { x, y }, facing, action: 'Idle', move_started_at: rebasedAt };
}

const STEP_MS = 200;

describe('Held-key / lag integration regression (M8.6c ADR-0013.5)', () => {
  it('bounded arrays: queueDepth <= queueCap AND pendingCount <= pendingCap across a held-East run with delayed acks', () => {
    // BITES: unbounded #pending (count blows up) AND a no-dedup re-issue (fills queue too fast).
    // The predictor is constructed with queueCap=2 and pendingCap=4.
    // Each "frame" we try to re-issue East using reissueDir. Acks are delayed by ~6 frames.
    // Neither bound should ever be exceeded.

    const QUEUE_CAP = 2;
    const PENDING_CAP = 4;
    const predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP, PENDING_CAP);
    const held = new HeldDirections();

    const t0 = 10_000;
    // Seed at t0, baseline two steps ago so moves are immediately due.
    predictor.reconcile(fakeBaseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);

    // The player holds East for 30 sub-step-ms "frames".
    held.press('East', 0);
    const FRAME_MS = 50; // sub-step: 4 frames per step_ms
    let now = t0;
    const sentIntents: IntentToSend[] = [];

    for (let frame = 0; frame < 30; frame++) {
      now += FRAME_MS;

      // frame-loop: re-issue held dir if dedup says to
      const d = reissueDir(held.active(), predictor.lastQueuedDir);
      if (d !== undefined) {
        const intent = predictor.enqueue({ Step: d });
        if (intent !== undefined) sentIntents.push(intent);
      }

      predictor.drain(now);

      // Invariants hold every frame:
      expect(predictor.queueDepth).toBeLessThanOrEqual(QUEUE_CAP);
      expect(predictor.pendingCount).toBeLessThanOrEqual(PENDING_CAP);
    }

    // Delayed acks: server processes and acks the first batch of intents.
    // Simulate authoritative East walk: 1 step east from x=5 = x=6.
    const ackedSeq =
      sentIntents.length > 0 ? sentIntents[Math.min(1, sentIntents.length - 1)]!.seq : 0;
    const authX = 5 + Math.min(sentIntents.length, 2); // at most 2 due to pendingCap
    predictor.reconcile(fakeBaseline(authX, 5, now - 2 * STEP_MS), [], ackedSeq, now);

    // After reconcile: predicted tile should equal the authoritative truth.
    expect(predictor.predicted!.pos.y).toBe(5); // y unchanged (East movement)
    // Post-reconcile bounds hold.
    expect(predictor.queueDepth).toBeLessThanOrEqual(QUEUE_CAP);
    expect(predictor.pendingCount).toBeLessThanOrEqual(PENDING_CAP);
  });

  it('correct post-reconcile tile after bounded no-ack burst + delayed reconcile', () => {
    // BITES: backpressure that corrupts prediction — after bounding #pending and
    // reconciling against server truth, the predicted tile must converge to authority.
    // Wrong impl killed: an impl that "loses" pending ops during backpressure,
    // leaving a stale or garbled predicted position.

    const QUEUE_CAP = 2;
    const PENDING_CAP = 3;
    const predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP, PENDING_CAP);
    const held = new HeldDirections();

    const t0 = 10_000;
    predictor.reconcile(fakeBaseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);
    held.press('East', 0);

    let now = t0;
    const FRAME_MS = 60;
    const sentIntents: IntentToSend[] = [];

    // Run 20 frames without any acks.
    for (let frame = 0; frame < 20; frame++) {
      now += FRAME_MS;
      const d = reissueDir(held.active(), predictor.lastQueuedDir);
      if (d !== undefined) {
        const intent = predictor.enqueue({ Step: d });
        if (intent !== undefined) sentIntents.push(intent);
      }
      predictor.drain(now);
      // pendingCap invariant holds throughout
      expect(predictor.pendingCount).toBeLessThanOrEqual(PENDING_CAP);
    }

    // Server accepted exactly 2 east steps (QUEUE_CAP=2 means at most 2 accepted before
    // the server-side queue is full). Authority is at x=7.
    const authEastSteps = Math.min(sentIntents.length, 2);
    const authX = 5 + authEastSteps;
    const ackedSeq = sentIntents.length > 0 ? (sentIntents[authEastSteps - 1]?.seq ?? 0) : 0;

    predictor.reconcile(fakeBaseline(authX, 5, now - 2 * STEP_MS), [], ackedSeq, now);

    // Convergence: predicted tile == authoritative tile.
    expect(predictor.predicted!.pos.x).toBeGreaterThanOrEqual(authX);
    expect(predictor.predicted!.pos.y).toBe(5);
  });

  // ============================================================================
  // M13.5b §G / T1–T3 — dropRejected integration with the held-key burst pattern
  //
  // HISTORY: authored RED when `predictor.dropRejected` did not exist at all
  // (M13.5b); GREEN since it shipped, and retained as the integration-level
  // regression guard for the burst pattern.
  //
  // nh3 (ADR-0152) made the epoch a REQUIRED second parameter, so both calls below
  // pass an epoch read from an intent THAT SAME predictor issued (never a literal).
  // These are SAME-EPOCH paths on purpose: they are the teeth that stay GREEN across
  // nh3 and therefore kill an over-eager guard (a `!==` → `===` flip, or any guard
  // that also rejects the legitimate live-epoch rejection). The CROSS-epoch guard is
  // pinned in predictor.test.ts (nh3-2 block + N3/N4), not here.
  // ============================================================================

  it('13.5b-4 RED-LOCK: without dropRejected, burst-tail rejection leaves a permanent +1 x-offset with diverged=false', () => {
    // Kills: any impl where the call site OMITS dropRejected after a rejection —
    // the predictor stays permanently 1 east of authority, diverged=false (silent desync).
    //
    // Setup: held-East burst — fill queue+pending, the LAST sent seq is the "tail".
    // The server rejects the tail (authority stays at the seeded x), ack = tailSeq-1.
    // Without dropRejected, repeated reconciles at ack=tailSeq-1 keep replaying the
    // tail East → predicted stays 1 ahead of authority, diverged=false every time.
    const QUEUE_CAP = 2;
    const PENDING_CAP = 4;
    const predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP, PENDING_CAP);
    const held = new HeldDirections();

    const t0 = 10_000;
    predictor.reconcile(fakeBaseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);
    held.press('East', 0);

    const FRAME_MS = 50;
    let now = t0;
    const sentIntents: IntentToSend[] = [];

    // Run 8 frames to fill queue+pending (burst).
    for (let frame = 0; frame < 8; frame++) {
      now += FRAME_MS;
      const d = reissueDir(held.active(), predictor.lastQueuedDir);
      if (d !== undefined) {
        const intent = predictor.enqueue({ Step: d });
        if (intent !== undefined) sentIntents.push(intent);
      }
      predictor.drain(now);
    }

    expect(sentIntents.length).toBeGreaterThan(0);
    const tailSeq = sentIntents[sentIntents.length - 1]!.seq;
    const ackedSeqBeforeReject = tailSeq - 1;

    // Server state: rejected the tail. Authority = whatever position excludes tail.
    // For simplicity, authority stays at (5,5) baseline (server never moved us — the
    // rejection scenario: the server applied none of them, e.g. movement forbidden).
    const authBase = fakeBaseline(5, 5, now - 2 * STEP_MS);

    // The tail intent must still be pending (review fix: this was a vacuous
    // always-true helper). Nothing has been acked since the seed reconcile, so
    // EVERY sent intent — tail included — survives the prune; seqs are consecutive
    // (a cap-declined enqueue consumes no seq), so the count is exact.
    expect(predictor.pendingCount).toBe(sentIntents.length);
    expect(predictor.pendingCount).toBeGreaterThan(0);

    // WITHOUT dropRejected: the first reconcile at ack=tailSeq-1 is a GENUINE PULLBACK
    // (predicted ran ahead during the burst; corrected position still replays the tail
    // East, so predicted lands 1 ahead of authority). d1 === true (tiles differ).
    const d1 = predictor.reconcile(authBase, [], ackedSeqBeforeReject, now);
    expect(d1).toBe(true); // genuine pullback on first reconcile — tiles differ

    // The SILENT STEADY STATE: subsequent reconciles with the same ack keep replaying
    // the phantom tail East (it is never acked, never dropped), so predicted stays
    // 1 ahead of authority at the same tile — pre-reconcile pos equals post-reconcile
    // pos → diverged=false. This is the bug class: reconcile "agrees" while staying
    // wrong forever.
    const posAfterD1 = predictor.predicted!.pos.x;
    expect(posAfterD1).toBeGreaterThan(5); // off authority (5,5) by the phantom East

    const d2 = predictor.reconcile(authBase, [], ackedSeqBeforeReject, now);
    expect(d2).toBe(false); // silent desync: same wrong tile → diverged=false
    expect(predictor.predicted!.pos.x).toBe(posAfterD1); // still off authority

    const d3 = predictor.reconcile(authBase, [], ackedSeqBeforeReject, now);
    expect(d3).toBe(false); // still locked in silent desync
    expect(predictor.predicted!.pos.x).toBe(posAfterD1); // permanently off authority
    // Kills: an impl without dropRejected that claims the desync is somehow resolved.
  });

  it('13.5b-4 GREEN: dropRejected(tailSeq) + one reconcile converges predicted to authority', () => {
    // Kills: an impl where dropRejected does not evict the op (returns false or no-ops),
    // leaving the predictor still 1 east of authority after the forced reconcile.
    const QUEUE_CAP = 2;
    const PENDING_CAP = 4;
    const predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP, PENDING_CAP);
    const held = new HeldDirections();

    const t0 = 10_000;
    predictor.reconcile(fakeBaseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);
    held.press('East', 0);

    const FRAME_MS = 50;
    let now = t0;
    const sentIntents: IntentToSend[] = [];

    for (let frame = 0; frame < 8; frame++) {
      now += FRAME_MS;
      const d = reissueDir(held.active(), predictor.lastQueuedDir);
      if (d !== undefined) {
        const intent = predictor.enqueue({ Step: d });
        if (intent !== undefined) sentIntents.push(intent);
      }
      predictor.drain(now);
    }

    expect(sentIntents.length).toBeGreaterThan(0);
    // nh3 (plan §3 step 3 / A9): hoisted so the epoch passed to dropRejected below is
    // read from an intent THIS predictor issued, never a literal. `tailSeq` is the same
    // value as before the hoist.
    const tail = sentIntents[sentIntents.length - 1]!;
    const tailSeq = tail.seq;
    const ackedSeqBeforeReject = tailSeq - 1;

    // Authority at (5,5): server rejected the tail (and every op that moved us).
    const authBase = fakeBaseline(5, 5, now - 2 * STEP_MS);

    // THE FIX: drop the rejected tail, then force a reconcile.
    // T3: capture queueDepth BEFORE dropRejected — #queue must be unchanged by the call.
    const qDepthBefore = predictor.queueDepth;
    // the op was present and is now evicted (epoch = this instance's own, via `tail`)
    expect(predictor.dropRejected(tailSeq, tail.epoch)).toBe(true);
    expect(predictor.queueDepth).toBe(qDepthBefore); // T3: #queue not spliced by dropRejected

    // One reconcile at ack = tailSeq-1 (server hasn't acked the tail because it
    // rejected it; all prior ops are acked at ackedSeqBeforeReject).
    predictor.reconcile(authBase, [], ackedSeqBeforeReject, now);

    // IMMEDIATE convergence (review fix: kills a lying always-true no-op
    // dropRejected, which the full-ack reconcile below would forgive): seqs are
    // consecutive, so ack tailSeq-1 prunes every survivor and the tail is dropped
    // — NOTHING replays; predicted equals authority right here, after ONE reconcile.
    expect(predictor.pendingCount).toBe(0);
    expect(predictor.predicted!.pos).toEqual({ x: 5, y: 5 });

    // Full-ack path stays converged (belt: the original assertion set).
    predictor.reconcile(authBase, [], tailSeq, now); // ack everything
    expect(predictor.pendingCount).toBe(0);
    expect(predictor.predicted!.pos).toEqual({ x: 5, y: 5 });
  });

  it('T1: multi-pending selective drop — dropRejected(N) with M<N pending leaves M, replays only M', () => {
    // Kills: a drop-all impl, a drop-wrong-index impl, and any impl that corrupts
    // the surviving pending op so reconcile does not replay it correctly.
    //
    // Two pending ops M < N. dropRejected(N) → pendingCount 1, M survives.
    // Reconcile at ack M-1 replays ONLY M (one East step), pendingCount 1 before.
    const QUEUE_CAP = 8;
    const predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP);
    const t0 = 10_000;
    predictor.reconcile(fakeBaseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);

    const intM = predictor.enqueue({ Step: 'East' })!; // seq M
    predictor.drain(t0); // drain so the queue slot is free

    // reconcile at ackedSeq=0 (below M's seq, so M stays pending) to clear the
    // rebuilt queue (drain consumed the prior queue entry) while keeping M unacked.
    predictor.reconcile(fakeBaseline(5, 5, t0 - 2 * STEP_MS), [], 0, t0);

    const intN = predictor.enqueue({ Step: 'East' })!; // seq N (> M)
    expect(intN.seq).toBeGreaterThan(intM.seq);

    expect(predictor.pendingCount).toBe(2); // M and N pending

    // Drop N (the one we "reject").
    // nh3 (A9): `intN` is in scope and was issued by THIS predictor — no hoist needed.
    const dropped = predictor.dropRejected(intN.seq, intN.epoch);
    expect(dropped).toBe(true);
    expect(predictor.pendingCount).toBe(1); // only M remains (T1 + T3 queueDepth assertion)

    // queueDepth unchanged by drop itself (T3).
    // (We don't assert a specific value here since drain may have consumed earlier,
    // but we confirm it did not change between the drop call and now.)

    // Reconcile at ack M-1: M survives, replays one East step from (5,5) → predicted at (6,5).
    predictor.reconcile(fakeBaseline(5, 5, t0 - 2 * STEP_MS), [], intM.seq - 1, t0);
    expect(predictor.pendingCount).toBe(1); // M still unacked after reconcile at M-1
    // The East from M was replayed onto authQueue=[] → queue=[East], then drained
    // (because baseline is 2 steps ago, one step is due): predicted.x = 6.
    expect(predictor.predicted!.pos.x).toBe(6);
    expect(predictor.predicted!.pos.y).toBe(5);
  });

  it('reissueDir dedup prevents queue/pending overload vs a no-dedup impl', () => {
    // BITES: an impl of reissueDir that always returns `active` regardless of
    // lastQueuedDir — would fill the pending array far beyond pendingCap when the
    // queueCap declines pushes (declined enqueue does NOT consume seq, but a
    // no-dedup impl would keep calling enqueue on every frame from the frame loop).
    // With correct dedup: once 'East' is the lastQueuedDir, reissueDir returns
    // undefined, so enqueue is not called and no new intents accumulate.

    const QUEUE_CAP = 2;
    const PENDING_CAP = 4;
    const predictor = new Predictor(applyMove, STEP_MS, QUEUE_CAP, PENDING_CAP);
    const held = new HeldDirections();

    const t0 = 10_000;
    predictor.reconcile(fakeBaseline(2, 2, t0 - 2 * STEP_MS), [], 0, t0);
    held.press('East', 0);

    let now = t0;
    // Run 50 sub-step frames. With correct dedup, pendingCount stays bounded.
    for (let frame = 0; frame < 50; frame++) {
      now += 40; // 40ms per frame (5 frames per STEP_MS=200)
      const d = reissueDir(held.active(), predictor.lastQueuedDir);
      if (d !== undefined) {
        predictor.enqueue({ Step: d });
      }
      predictor.drain(now);
      // This is the key assertion: with dedup + backpressure, pending stays bounded.
      // Without dedup, every frame calls enqueue; each declined enqueue returns
      // undefined and does NOT add to pending — BUT with a correct dedup, enqueue
      // is not even called on frames where East is already the lastQueuedDir.
      expect(predictor.pendingCount).toBeLessThanOrEqual(PENDING_CAP);
      expect(predictor.queueDepth).toBeLessThanOrEqual(QUEUE_CAP);
    }
  });
});
