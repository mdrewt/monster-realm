// ui/battleModel.test.ts — Pure tests for the battle-model cores that outlive the 1v1 view.
// SOURCE OF TRUTH: specs/monster-realm-v2/M7-battle-view.spec.md (the overlay lifecycle) and
// specs/monster-realm-v2/M-battle-tactics.spec.md §bt-17 (BT17.1: the 1v1 renderer and model are
// deleted; BT17.2: every removed 1v1 test is re-proven by a named test or named "subject deleted").
// All inputs are plain objects; deterministic; node-only.
//
// bt-17 (named intentional change, BT17.1 / BT17.2): ui/battleModel.ts keeps ONLY `isPvpBattle`,
// `BaitItem`, `buildBaitItems`, `BattleOverlayAction`, `OverlayState`, `OverlayResult`,
// `decideBattleOverlay` and `CursorDir`. Every test of the deleted 1v1 view model
// (`buildBattleViewModel`, `battleVMsEqual`, `shouldSkipBattleRefresh`, `statusBadge`,
// `unknownStatusToken`, `weatherBanner`, `battleCommands`, `cursorStep`, `skillCursor`,
// `resolveBattlePick`, `buildCureItems`, `pvpPendingAfterBatch`, `pvpSubmitPending`) is removed;
// each removed `it` is named, with its survivor or "subject deleted", in
// memory/projects/monster-realm-bt-17-deletions.md. The surviving tests below are unchanged
// (the PGCCD-D1 empty-edge case loses its cure half with `buildCureItems`).
//
// Every test has a `// Kills:` comment explaining which wrong impl it catches.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type {
  StoreBattle,
  StoreBattleMonster,
  StoreBattleSide,
  StoreInventory,
  StoreItemRow,
} from '../net/store';
import { buildBaitItems, decideBattleOverlay, isPvpBattle, type OverlayState } from './battleModel';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function battleMonster(overrides: Partial<StoreBattleMonster> = {}): StoreBattleMonster {
  return {
    speciesId: 1,
    affinity: 'Fire',
    level: 5,
    currentHp: 20,
    maxHp: 20,
    statHp: 20,
    statAttack: 10,
    statDefense: 10,
    statSpeed: 10,
    statSpAttack: 10,
    statSpDefense: 10,
    knownSkillIds: [1],
    ...overrides,
  } as StoreBattleMonster;
}

function battleSide(overrides: Partial<StoreBattleSide> = {}): StoreBattleSide {
  return { active: 0, team: [battleMonster()], ...overrides };
}

function makeBattle(overrides: Partial<StoreBattle> = {}): StoreBattle {
  return {
    battleId: 1n,
    // PvE/trainer uses playerIdentity===opponentIdentity so isPvP=false.
    // PvP tests override opponentIdentity explicitly.
    playerIdentity: 'alice',
    opponentIdentity: 'alice',
    outcome: 'Ongoing',
    turnNumber: 1,
    sideA: battleSide(),
    sideB: battleSide(),
    partyMonsterIds: [1n],
    opponentMonsterIds: [2n],
    createdAtMs: 1000n,
    weather: null,
    ...overrides,
  };
}

// =============================================================================
// decideBattleOverlay pure reducer
//
// decideBattleOverlay(latest, state) → { action, dismissedBattleId, synced }
//
// Rules:
//   1. latest === undefined → hide, state unchanged.
//   2. state.synced === false (first observation this session):
//      - result.synced becomes true.
//      - terminal (outcome !== 'Ongoing'): pre-dismiss → hide, dismissedBattleId=latest.battleId.
//      - Ongoing: show, dismissedBattleId unchanged.
//   3. state.synced === true (steady state):
//      - dismissedBattleId === latest.battleId → hide (no re-pop).
//      - else → show (Ongoing auto-shows; mid-session terminal shows once).
//
// =============================================================================

/** Local factory: a minimal valid StoreBattle with a configurable battleId + outcome. */
function overlayBattle(battleId: bigint, outcome: string): StoreBattle {
  return makeBattle({ battleId, outcome });
}

describe('battleModel M8.7e: decideBattleOverlay', () => {
  // ---------------------------------------------------------------------------
  // T2 — live resolve shows outcome (EARS "render at least once")
  // ---------------------------------------------------------------------------
  it('T2: BITES shows a resolved battle that appeared mid-session (the original bug)', () => {
    // A terminal battle (SideAWins) that is NOT the dismissed id must produce
    // action { kind:'show', battle: that battle }.
    // This is the core bug: the old refreshBattle() sourced from ongoingBattle()
    // (Ongoing filter), so any resolved battle produced {kind:'hide'} — dead code.
    // Kills: hiding a resolved battle by re-using the ongoingBattle Ongoing-only filter.
    const b = overlayBattle(10n, 'SideAWins');
    const state: OverlayState = { dismissedBattleId: null, synced: true };
    const result = decideBattleOverlay(b, state);
    expect(result.action.kind).toBe('show');
    if (result.action.kind === 'show') {
      expect(result.action.battle.battleId).toBe(10n);
      expect(result.action.battle.outcome).toBe('SideAWins');
    }
    expect(result.synced).toBe(true);
    expect(result.dismissedBattleId).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // T3 — stale-on-login pre-dismiss (first sight of a terminal = historical)
  // ---------------------------------------------------------------------------
  it('T3a: BITES pre-dismisses a terminal battle seen for the first time (synced=false)', () => {
    // At login, if the first batch already has outcome !== 'Ongoing', the battle
    // is historical (the player already finished it before this session). It must
    // be pre-dismissed (hidden immediately) and never popped as a notification.
    // Kills: popping a historical resolved battle on login (annoying / confusing).
    const b = overlayBattle(7n, 'SideBWins');
    const state: OverlayState = { dismissedBattleId: null, synced: false };
    const result = decideBattleOverlay(b, state);
    expect(result.action.kind).toBe('hide');
    expect(result.dismissedBattleId).toBe(7n); // pre-dismissed
    expect(result.synced).toBe(true); // synced becomes true after first observation
  });

  it('T3b: BITES pre-dismissed battle stays hidden on the follow-up call (no re-pop)', () => {
    // After T3a, the next batch fires with the same terminal battle.
    // dismissedBattleId=7n, synced=true → must still be {kind:'hide'}.
    // Kills: an impl that pre-dismisses on first sight but re-pops on the next batch.
    const b = overlayBattle(7n, 'SideBWins');
    const followUp: OverlayState = { dismissedBattleId: 7n, synced: true };
    const result = decideBattleOverlay(b, followUp);
    expect(result.action.kind).toBe('hide');
  });

  // ---------------------------------------------------------------------------
  // T4 — no re-pop after explicit dismiss
  // ---------------------------------------------------------------------------
  it('T4: BITES does NOT re-pop after the player dismissed (dismissedBattleId === latest.battleId)', () => {
    // Once dismissedBattleId matches the latest battle's id, every subsequent
    // batch must keep {kind:'hide'} — no infinite re-pop.
    // Kills: an impl that shows again after dismiss (e.g. checks dismissedBattleId
    // only on the first call, or compares by Number() losing bigint identity).
    const b = overlayBattle(4n, 'SideAWins');
    const state: OverlayState = { dismissedBattleId: 4n, synced: true };
    const result = decideBattleOverlay(b, state);
    expect(result.action.kind).toBe('hide');
  });

  // ---------------------------------------------------------------------------
  // T5 — Ongoing auto-show preserved (three sub-cases)
  // ---------------------------------------------------------------------------
  it('T5a: BITES Ongoing battle on first session observation auto-shows (synced=false)', () => {
    // First batch, battle is Ongoing → must show immediately (not pre-dismiss).
    // synced becomes true; dismissedBattleId stays null.
    // Kills: pre-dismissing Ongoing battles on login (breaks the always-show-active guarantee).
    const b = overlayBattle(2n, 'Ongoing');
    const state: OverlayState = { dismissedBattleId: null, synced: false };
    const result = decideBattleOverlay(b, state);
    expect(result.action.kind).toBe('show');
    expect(result.synced).toBe(true);
    expect(result.dismissedBattleId).toBeNull();
  });

  it('T5b: BITES Ongoing battle in steady state auto-shows when not dismissed', () => {
    // Steady state (synced=true), dismissedBattleId=null: Ongoing must produce show.
    // Kills: an impl that only shows the first time or requires an explicit event.
    const b = overlayBattle(2n, 'Ongoing');
    const state: OverlayState = { dismissedBattleId: null, synced: true };
    const result = decideBattleOverlay(b, state);
    expect(result.action.kind).toBe('show');
  });

  it('T5c: BITES undefined latest hides overlay and leaves all state unchanged', () => {
    // When the store has no battle for this player, the overlay must hide without
    // mutating dismissedBattleId or synced.
    // Kills: clearing dismissedBattleId or resetting synced when latest is undefined
    // (which would forget a dismiss and re-pop on the next batch).
    const state: OverlayState = { dismissedBattleId: 9n, synced: true };
    const result = decideBattleOverlay(undefined, state);
    expect(result.action.kind).toBe('hide');
    expect(result.dismissedBattleId).toBe(9n); // unchanged
    expect(result.synced).toBe(true); // unchanged
  });

  // ---------------------------------------------------------------------------
  // T6 — mid-session terminal still shows with a DIFFERENT dismissed id (F1 under-showing)
  // ---------------------------------------------------------------------------
  it('T6: BITES shows a freshly-resolved battle even when a DIFFERENT battle was dismissed', () => {
    // Scenario: player dismissed battle 11 earlier this session. Now the server
    // sends a NEW terminal battle (id=20). dismissedBattleId=11 !== 20, so the
    // reducer must show battle 20 — there is no "seen-ongoing" gate in the spec.
    // Kills: a "seen-ongoing"-gated impl that hides a terminal battle it never saw
    // as Ongoing (would under-show freshly-resolved battles whose Ongoing frame
    // was coalesced into the same batch as the terminal frame).
    const b = overlayBattle(20n, 'SideAWins');
    const state: OverlayState = { dismissedBattleId: 11n, synced: true };
    const result = decideBattleOverlay(b, state);
    expect(result.action.kind).toBe('show');
    if (result.action.kind === 'show') {
      expect(result.action.battle.battleId).toBe(20n);
    }
  });

  // ---------------------------------------------------------------------------
  // T7 — totality + no-throw property (fast-check)
  // ---------------------------------------------------------------------------
  it('T7: BITES never throws and always returns a valid action.kind for any input combination', () => {
    // Tests the totality of the reducer: for every outcome string (including
    // unknown future variants) × synced × dismissedBattleId, the call returns
    // 'show'|'hide' and never throws. Also asserts that result.synced === true
    // whenever latest !== undefined (synced is sticky-on-observe).
    // Kills: a non-total reducer / NaN/throw on unknown outcome string / accidentally
    // resetting synced to false when a battle is present.
    const outcomes = ['Ongoing', 'SideAWins', 'SideBWins', 'Fled', 'Draw', 'Weird'];
    const syncedValues = [false, true];

    for (const outcome of outcomes) {
      for (const synced of syncedValues) {
        for (const dismissedBattleId of [null, 1n, 99n]) {
          const b = overlayBattle(1n, outcome);
          const state: OverlayState = { dismissedBattleId, synced };
          let result: ReturnType<typeof decideBattleOverlay> | undefined;
          expect(() => {
            result = decideBattleOverlay(b, state);
          }).not.toThrow();
          expect(result!.action.kind === 'show' || result!.action.kind === 'hide').toBe(true);
          // Synced must be true after observing any battle (sticky-on-observe).
          expect(result!.synced).toBe(true);
        }
      }
    }

    // Also test undefined latest for completeness.
    for (const synced of syncedValues) {
      for (const dismissedBattleId of [null, 1n]) {
        const state: OverlayState = { dismissedBattleId, synced };
        let result: ReturnType<typeof decideBattleOverlay> | undefined;
        expect(() => {
          result = decideBattleOverlay(undefined, state);
        }).not.toThrow();
        expect(result!.action.kind === 'show' || result!.action.kind === 'hide').toBe(true);
      }
    }
  });

  it('T7 fast-check: totality property — no throw, valid kind, synced sticky on any battle', () => {
    // Property-based version of T7. Covers arbitrary bigint ids and outcome strings
    // via fast-check's combinatorial generation.
    // Kills: edge-case throws on large bigints, empty strings, or unexpected outcome tags.
    fc.assert(
      fc.property(
        fc.option(
          fc.record({
            battleId: fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }),
            outcome: fc.oneof(
              fc.constantFrom('Ongoing', 'SideAWins', 'SideBWins', 'Fled', 'Draw'),
              fc.string({ minLength: 1, maxLength: 20 }),
            ),
          }),
          { nil: undefined },
        ),
        fc.boolean(),
        fc.option(fc.bigInt({ min: 0n, max: 2n ** 64n - 1n }), { nil: null }),
        (battleInfo, synced, dismissedBattleId) => {
          const latest =
            battleInfo !== undefined
              ? overlayBattle(battleInfo.battleId, battleInfo.outcome)
              : undefined;
          const state: OverlayState = { dismissedBattleId, synced };
          let result: ReturnType<typeof decideBattleOverlay> | undefined;
          expect(() => {
            result = decideBattleOverlay(latest, state);
          }).not.toThrow();
          expect(result!.action.kind === 'show' || result!.action.kind === 'hide').toBe(true);
          // When a battle is present, synced must be true after the call.
          if (latest !== undefined) {
            expect(result!.synced).toBe(true);
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// isPvpBattle canonical export (ADR-0110 seam)
//
// Contract: isPvpBattle({ opponentMonsterIds, opponentIdentity, playerIdentity })
//   returns true iff identities differ AND opponentMonsterIds is non-empty.
//   This matches the PvP detection rule in ADR-0110 — this suite pins the
//   standalone exported function that other modules (battleEmitModel, eventRing,
//   tactics/boardModel) call directly.
// ---------------------------------------------------------------------------

describe('isPvpBattle — standalone canonical export (ptc5e e-3)', () => {
  it('wild: opponentMonsterIds empty and different identities → false', () => {
    // A wild battle sends opponentIdentity='00' (server placeholder ≠ playerIdentity)
    // but opponentMonsterIds is empty. isPvpBattle must require BOTH conditions.
    // Kills: an identity-inequality-alone impl that mislabels wild as PvP.
    expect(
      isPvpBattle({ opponentMonsterIds: [], opponentIdentity: '00', playerIdentity: 'aa' }),
    ).toBe(false);
  });

  it('pvp: non-empty opponentMonsterIds AND different identities → true', () => {
    // Canonical PvP: server sets a real opponent identity and populated monsterIds.
    // Kills: an opponentMonsterIds-only impl that would also label practice as PvP.
    expect(
      isPvpBattle({ opponentMonsterIds: [1n], opponentIdentity: 'bb', playerIdentity: 'aa' }),
    ).toBe(true);
  });

  it('practice: same identity with non-empty opponentMonsterIds → false', () => {
    // Practice battle: player fights their own party (playerIdentity===opponentIdentity).
    // opponentMonsterIds is non-empty but identities match → not PvP.
    // Kills: an opponentMonsterIds.length-only impl that would label practice as PvP.
    expect(
      isPvpBattle({ opponentMonsterIds: [1n], opponentIdentity: 'aa', playerIdentity: 'aa' }),
    ).toBe(false);
  });
});

// =============================================================================
// pgcc-d — the bait item list as a pure core (D1). Table cases, no DOM.
// bt-17: the cure half (`buildCureItems`) and the D2 PvP pending latch are deleted with the 1v1
// Bag and the secret-pick turn; the bait builder survives (main.ts still reads it).
// =============================================================================

function pgccdStack(itemId: number, count: number): StoreInventory {
  return { invId: BigInt(1000 + itemId * 10 + count), ownerIdentity: 'alice', itemId, count };
}

function pgccdDef(id: number, overrides: Partial<StoreItemRow> = {}): StoreItemRow {
  return {
    id,
    name: `Item-${id}`,
    description: '',
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    sellPrice: 0n,
    cureStatus: null,
    ...overrides,
  };
}

function pgccdDefs(...defs: StoreItemRow[]): ReadonlyMap<number, StoreItemRow> {
  return new Map(defs.map((d) => [d.id, d]));
}

describe('PGCCD-D1 buildBaitItems / buildCureItems', () => {
  it('PGCCD-D1 bait: one row per stack with the exact fields, in inventory order', () => {
    // Kills: reordering by id/bonus/name; a missing or extra field; reading count from the def.
    const defs = pgccdDefs(
      pgccdDef(1, { name: 'Berry', recruitBonus: 10 }),
      pgccdDef(2, { name: 'Pebble', recruitBonus: 0 }),
      pgccdDef(3, { name: 'Feast', recruitBonus: 25 }),
    );
    const inventory = [pgccdStack(3, 2), pgccdStack(1, 5), pgccdStack(2, 1)];
    expect(buildBaitItems(inventory, defs)).toStrictEqual([
      { itemId: 3, name: 'Feast', recruitBonus: 25, count: 2 },
      { itemId: 1, name: 'Berry', recruitBonus: 10, count: 5 },
      { itemId: 2, name: 'Pebble', recruitBonus: 0, count: 1 },
    ]);
  });

  it('PGCCD-D1 bait: no recruitBonus filter — a zero-bonus item and a cure item are both kept', () => {
    // Kills: a `recruitBonus > 0` filter (the consumer classifies later); a
    // `cureStatus === null` filter.
    const defs = pgccdDefs(
      pgccdDef(1, { name: 'Pebble', recruitBonus: 0 }),
      pgccdDef(2, { name: 'Antidote', recruitBonus: 0, cureStatus: 'Poison' }),
    );
    expect(buildBaitItems([pgccdStack(1, 3), pgccdStack(2, 4)], defs)).toStrictEqual([
      { itemId: 1, name: 'Pebble', recruitBonus: 0, count: 3 },
      { itemId: 2, name: 'Antidote', recruitBonus: 0, count: 4 },
    ]);
  });

  it('PGCCD-D1 bait: a stack with no def is dropped without throwing, neighbours kept', () => {
    // Kills: a placeholder row for the missing def; a non-null assertion that throws;
    // dropping the stacks after the missing one.
    const defs = pgccdDefs(pgccdDef(1, { name: 'Berry', recruitBonus: 5 }), pgccdDef(2));
    let rows: unknown;
    expect(() => {
      rows = buildBaitItems([pgccdStack(1, 1), pgccdStack(99, 7), pgccdStack(2, 2)], defs);
    }).not.toThrow();
    expect(rows).toStrictEqual([
      { itemId: 1, name: 'Berry', recruitBonus: 5, count: 1 },
      { itemId: 2, name: 'Item-2', recruitBonus: 0, count: 2 },
    ]);
  });

  it('PGCCD-D1 bait: two stacks of the same item stay two rows (no dedupe or merge)', () => {
    // Kills: collapsing by itemId; summing counts.
    const defs = pgccdDefs(pgccdDef(1, { name: 'Berry', recruitBonus: 5 }));
    expect(buildBaitItems([pgccdStack(1, 2), pgccdStack(1, 3)], defs)).toStrictEqual([
      { itemId: 1, name: 'Berry', recruitBonus: 5, count: 2 },
      { itemId: 1, name: 'Berry', recruitBonus: 5, count: 3 },
    ]);
  });

  it('PGCCD-D1 bait: empty inventory or empty defs gives an empty list', () => {
    // Kills: a throw / non-array on the empty edge.
    // bt-17 (named intentional change): was "bait and cure: …"; the two `buildCureItems`
    // assertions leave with the function (subject deleted: the 1v1 Bag's cure list).
    const defs = pgccdDefs(pgccdDef(1, { recruitBonus: 5, cureStatus: 'Poison' }));
    expect(buildBaitItems([], defs)).toStrictEqual([]);
    expect(buildBaitItems([pgccdStack(1, 1)], pgccdDefs())).toStrictEqual([]);
  });
});
