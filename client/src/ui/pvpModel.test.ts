// ui/pvpModel.test.ts — bt-15 increment A RED gating tests: the pure party-size pick model (BT15.1).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-battle-tactics.spec.md §bt-15 BT15.1 ("THE confirm flow
//   SHALL let the challenger pick 1-3 party monsters"); memory/projects/monster-realm-bt-15-plan.md §2
//   BT15.1a + §6 (M2, M4, L) and the tester brief's API freeze.
//
// RED REASON: client/src/ui/pvpModel.ts does not exist yet (module-not-found at collection).
//
// CONTRACT:
//   PVP_FORMAT_MAX = 3 (the disclosed mirror of server pvp.rs PVP_FORMAT_MAX)
//   consciousPartyIds(monsters, excluded, partySlotNone) -> bigint[]
//     party-slotted (partySlot !== partySlotNone) AND currentHp > 0 AND not in `excluded`, in
//     ASCENDING partySlot order (never input order).
//   challengeSizes(eligible) -> number[]
//     [min(PVP_FORMAT_MAX, eligible), ..., 1] DESCENDING; [] when eligible <= 0.
//
// Every monster id sits past 2^53 (a Number()-keyed compare collides neighbours); the fixture mixes
// out-of-order slots, a boxed row, a fainted row and an excluded (in-trade) row, so "the first N of
// the input" and "every party row" both die.
//
// Do NOT edit these tests to match a buggy implementation; correct them from the spec only.

import { describe, expect, it } from 'vitest';
import { challengeSizes, consciousPartyIds, type PartyPickRow, PVP_FORMAT_MAX } from './pvpModel';

/** The boxed sentinel the fixture uses (main.ts passes the bindings' PARTY_SLOT_NONE). */
const NONE = 255;

const row = (monsterId: bigint, partySlot: number, currentHp: number): PartyPickRow => ({
  monsterId,
  partySlot,
  currentHp,
});

const S0 = 9_007_199_254_740_993n;
const S1 = 9_007_199_254_740_995n;
const S2 = 9_007_199_254_740_997n;
const S3 = 9_007_199_254_740_999n;
const BOXED = 9_007_199_254_741_001n;
const FAINTED = 9_007_199_254_741_003n;
const TRADED = 9_007_199_254_741_005n;

describe('pvpModel: the conscious, untraded party in slot order (bt-15, BT15.1)', () => {
  it('consciousPartyIds keeps exactly the party-slotted, conscious, not-excluded monsters in ascending party slot, whatever the input order, ids past 2^53 kept apart [BT15-1]', () => {
    // WRONG IMPL KILLED: the input (store) order instead of slot order (the fixture's input order
    // 2, 0, 3, 1 differs from it); a fainted monster kept (`currentHp >= 0`), or a 1-HP one dropped
    // (`> 1`); a boxed monster kept (the partySlotNone row); the in-trade monster kept (`excluded`
    // ignored); `ownPartyIds()` as is (every party slot, fainted and traded included); a Set keyed on
    // Number(id) (neighbouring ids past 2^53 collide and one is lost or wrongly excluded).
    const input: readonly PartyPickRow[] = [
      row(S2, 2, 17),
      row(BOXED, NONE, 40),
      row(S0, 0, 23),
      row(FAINTED, 4, 0),
      row(S3, 3, 1),
      row(TRADED, 5, 31),
      row(S1, 1, 29),
    ];
    expect(consciousPartyIds(input, new Set([TRADED]), NONE), 'slot order 0, 1, 2, 3').toEqual([
      S0,
      S1,
      S2,
      S3,
    ]);
    expect(
      consciousPartyIds(input, new Set(), NONE),
      'nothing excluded: the in-trade monster takes its slot (5)',
    ).toEqual([S0, S1, S2, S3, TRADED]);
    expect(
      consciousPartyIds(input, new Set([S1, TRADED]), NONE),
      'two excluded: the rest keep slot order',
    ).toEqual([S0, S2, S3]);
    // The neighbour of an excluded id past 2^53 is NOT excluded (Number(S0) === Number(S0 + 1n)).
    expect(
      consciousPartyIds([row(S0, 1, 5), row(S0 + 1n, 0, 5)], new Set([S0]), NONE),
      'an id past 2^53 and its neighbour are two monsters',
    ).toEqual([S0 + 1n]);
    expect(consciousPartyIds([], new Set(), NONE), 'no monster, no id').toEqual([]);
    expect(
      consciousPartyIds([row(FAINTED, 0, 0), row(BOXED, NONE, 9)], new Set(), NONE),
      'only a fainted and a boxed monster: nobody',
    ).toEqual([]);
    // The sentinel is the caller's: a different partySlotNone changes who is boxed.
    expect(
      consciousPartyIds([row(S1, 7, 5), row(S0, 0, 5)], new Set(), 7),
      'partySlotNone 7: slot 7 is the box',
    ).toEqual([S0]);
    expect(PVP_FORMAT_MAX, 'fixture sanity: the mirror is three').toBe(3);
  });

  it('challengeSizes offers min(3, eligible) down to 1, largest first, and nothing for no eligible monster; PVP_FORMAT_MAX is 3 [BT15-1]', () => {
    // WRONG IMPL KILLED: ascending sizes (the default first row would be "1 vs 1", not the largest);
    // a cap of 6 (MAX_PARTY_SIZE) instead of the format max; a cap ignored (five eligible offer five
    // sizes); `[1]` for zero eligible (a pick the server refuses: party size 0); a negative count
    // that throws or offers rows; an off-by-one that drops the 1.
    expect(PVP_FORMAT_MAX, 'the server pvp.rs PVP_FORMAT_MAX mirror').toBe(3);
    const cases: readonly (readonly [number, readonly number[]])[] = [
      [6, [3, 2, 1]],
      [5, [3, 2, 1]],
      [4, [3, 2, 1]],
      [3, [3, 2, 1]],
      [2, [2, 1]],
      [1, [1]],
      [0, []],
      [-1, []],
    ];
    for (const [eligible, want] of cases) {
      expect(challengeSizes(eligible), `${eligible} eligible`).toEqual(want);
    }
  });
});
