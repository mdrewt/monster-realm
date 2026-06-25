// convert round-trip + rebasing properties (M3 acceptance criteria, fast-check).
// The marshaling boundary is dumb and reversible for the faithful conversions, and
// the predicted-baseline rebasing is a deliberately lossy local-time clamp.
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  characterFieldsFromWasm,
  characterToPredictedBaseline,
  characterToWasm,
  directionToSdk,
  directionToWasm,
  moveInputToSdk,
  moveInputToWasm,
  moveQueueToSdk,
  moveQueueToWasm,
  type SdkCharacterFields,
  type WasmAction,
  type WasmCharacterState,
  type WasmDirection,
  type WasmMoveInput,
} from './convert';

const DIRS: readonly WasmDirection[] = ['North', 'South', 'East', 'West'];
const ACTIONS: readonly WasmAction[] = ['Idle', 'Walking', 'Jumping'];
const dirArb = fc.constantFrom(...DIRS);
const actionArb = fc.constantFrom(...ACTIONS);
const moveInputArb: fc.Arbitrary<WasmMoveInput> = fc.oneof(
  fc.constant<WasmMoveInput>('Jump'),
  dirArb.map((d): WasmMoveInput => ({ Step: d })),
);
const i32 = fc.integer({ min: -2_147_483_648, max: 2_147_483_647 });
const msArb = fc.integer({ min: 0, max: 2 ** 40 }); // bounded ms, far under 2^53

const wasmCharArb: fc.Arbitrary<WasmCharacterState> = fc.record({
  pos: fc.record({ x: i32, y: i32 }),
  facing: dirArb,
  action: actionArb,
  move_started_at: msArb,
});

describe('convert: faithful round-trips (handles tagged unions + bigint)', () => {
  it('Direction wasm -> sdk -> wasm', () => {
    fc.assert(
      fc.property(dirArb, (d) => {
        expect(directionToWasm(directionToSdk(d))).toBe(d);
      }),
    );
  });
  it('Direction sdk -> wasm -> sdk', () => {
    fc.assert(
      fc.property(dirArb, (d) => {
        expect(directionToSdk(directionToWasm({ tag: d }))).toEqual({ tag: d });
      }),
    );
  });
  it('MoveInput wasm -> sdk -> wasm (Step replaces, Jump unit)', () => {
    fc.assert(
      fc.property(moveInputArb, (m) => {
        expect(moveInputToWasm(moveInputToSdk(m))).toEqual(m);
      }),
    );
  });
  it('move_queue round-trips elementwise (order + arity preserved)', () => {
    fc.assert(
      fc.property(fc.array(moveInputArb), (q) => {
        expect(moveQueueToWasm(moveQueueToSdk(q))).toEqual(q);
      }),
    );
  });
  it('CharacterState wasm -> sdk -> wasm (bounded move_started_at)', () => {
    fc.assert(
      fc.property(wasmCharArb, (w) => {
        expect(characterToWasm(characterFieldsFromWasm(w))).toEqual(w);
      }),
    );
  });
  it('move_started_at stays bigint on the SDK side (never downcast to number)', () => {
    fc.assert(
      fc.property(msArb, (t) => {
        const back = characterFieldsFromWasm(
          characterToWasm({ tileX: 0, tileY: 0, facing: { tag: 'North' }, action: { tag: 'Idle' }, moveStartedAtMs: BigInt(t) }),
        );
        expect(typeof back.moveStartedAtMs).toBe('bigint');
        expect(back.moveStartedAtMs).toBe(BigInt(t));
      }),
    );
  });
});

describe('convert: predicted-baseline rebasing (ADR-0012, lossy)', () => {
  const row: SdkCharacterFields = {
    tileX: 3,
    tileY: 4,
    facing: { tag: 'East' },
    action: { tag: 'Walking' },
    moveStartedAtMs: 1_700_000_000_000n, // a realistic server epoch
  };

  it('rebases to max(0, floor(localNow) - 2*stepMs); floored, non-negative, not the server epoch', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1e12, noNaN: true, noDefaultInfinity: true }),
        fc.integer({ min: 1, max: 1000 }),
        (now, step) => {
          const b = characterToPredictedBaseline(row, now, step);
          expect(b.move_started_at).toBe(Math.max(0, Math.floor(now) - 2 * step));
          expect(b.move_started_at).toBeGreaterThanOrEqual(0); // sane-baseline clamp
          expect(Number.isInteger(b.move_started_at)).toBe(true); // floored => serde-safe i64
          expect(b.move_started_at).not.toBe(Number(row.moveStartedAtMs)); // never the raw epoch
          expect(b.pos).toEqual({ x: 3, y: 4 }); // position carried faithfully
          expect(b.facing).toBe('East');
        },
      ),
    );
  });

  it('clamps a small localNow to a non-negative baseline (no negative Millis)', () => {
    expect(characterToPredictedBaseline(row, 5, 200).move_started_at).toBe(0);
  });

  it('is "two steps ago" so the first queued move is immediately due', () => {
    // localNow 10_000, step 200 -> baseline 9_600; a move drained at 10_000 is due
    // because 10_000 - 9_600 = 400 >= step (200).
    expect(characterToPredictedBaseline(row, 10_000, 200).move_started_at).toBe(9_600);
  });
});
