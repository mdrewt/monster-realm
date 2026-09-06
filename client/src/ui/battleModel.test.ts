// ui/battleModel.test.ts — Pure view-model tests for M7c battle view (vitest).
// SOURCE OF TRUTH: specs/monster-realm-v2/M7-battle-view.spec.md
// Tests the pure functions in ui/battleModel.ts, which has no SDK or PixiJS deps.
// All inputs are plain objects; deterministic; node-only.
//
// These tests start RED because battleModel.ts does not exist yet.
// Every test has a `// Kills:` comment explaining which wrong impl it catches.

import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
// Parity guard: import generated enums READ-ONLY to derive variant lists at runtime.
// These imports are allowed in test files only (not in store/rowConvert which must
// stay SDK-agnostic). The algebraicType.value.variants path is probe-confirmed
// (m14.5d plan Design Decision E).
import { BattleOutcome, StatusEffect, WeatherEffect } from '../module_bindings/types';
import type {
  StoreBattle,
  StoreBattleMonster,
  StoreBattleSide,
  StoreSkillRow,
  StoreSpeciesRow,
} from '../net/store';
import {
  type BattleOutcomeTag,
  type BattleViewModel,
  battleVMsEqual,
  buildBattleViewModel,
  decideBattleOverlay,
  isPvpBattle,
  type OverlayState,
  shouldSkipBattleRefresh,
  statusBadge,
  unknownStatusToken,
  weatherBanner,
} from './battleModel';
import { hpPercent } from './boxModel';

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
  };
}

function battleSide(overrides: Partial<StoreBattleSide> = {}): StoreBattleSide {
  return { active: 0, team: [battleMonster()], ...overrides };
}

function makeBattle(overrides: Partial<StoreBattle> = {}): StoreBattle {
  return {
    battleId: 1n,
    // m16b: PvE/trainer uses playerIdentity===opponentIdentity so isPvP=false.
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

function skillRow(id: number, overrides: Partial<StoreSkillRow> = {}): StoreSkillRow {
  return {
    id,
    name: `Skill-${id}`,
    affinity: 'Fire',
    power: 40,
    accuracy: 100,
    pp: 20,
    ...overrides,
  };
}

function speciesRow(id: number, name = `Species-${id}`): StoreSpeciesRow {
  return {
    id,
    name,
    baseHp: 45,
    baseAttack: 49,
    baseDefense: 49,
    baseSpeed: 45,
    baseSpAttack: 65,
    baseSpDefense: 65,
    affinity: 'Fire',
    learnableSkillIds: [],
  };
}

function makeSkillMap(...ids: number[]): ReadonlyMap<number, StoreSkillRow> {
  const m = new Map<number, StoreSkillRow>();
  for (const id of ids) m.set(id, skillRow(id));
  return m;
}

function makeSpeciesMap(...rows: StoreSpeciesRow[]): ReadonlyMap<number, StoreSpeciesRow> {
  const m = new Map<number, StoreSpeciesRow>();
  for (const row of rows) m.set(row.id, row);
  return m;
}

// ---------------------------------------------------------------------------
// buildBattleViewModel: null guard paths
// ---------------------------------------------------------------------------

describe('buildBattleViewModel: null guard — empty / out-of-bounds team', () => {
  it('BITES: returns null when sideA.team is empty', () => {
    // Kills: an impl that accesses team[active] without guarding empty team,
    // causing an undefined dereference crash.
    const b = makeBattle({ sideA: battleSide({ team: [] }) });
    const result = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(result).toBeNull();
  });

  it('BITES: returns null when sideA.active >= sideA.team.length (defensive guard)', () => {
    // Kills: an impl that trusts the active index without bounds-checking —
    // if server sends corrupt data (active=1, team=[oneMonster]), it would crash.
    const b = makeBattle({
      sideA: { active: 1, team: [battleMonster()] }, // active out of bounds
    });
    const result = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(result).toBeNull();
  });

  it('BITES: returns null when sideB.team is empty (opponent crash guard)', () => {
    // Kills: an impl that guards sideA but forgets to guard sideB.
    const b = makeBattle({ sideB: battleSide({ team: [] }) });
    const result = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(result).toBeNull();
  });

  it('BITES: returns null when sideB.active >= sideB.team.length', () => {
    // Kills: an impl that bounds-checks sideA.active but not sideB.active.
    const b = makeBattle({
      sideB: { active: 2, team: [battleMonster()] }, // active out of bounds
    });
    const result = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildBattleViewModel: player monster card
// ---------------------------------------------------------------------------

describe('buildBattleViewModel: player monster card data', () => {
  it('BITES: player card has correct speciesName from speciesMap', () => {
    // Kills: an impl that uses speciesId as the name, ignores the map, or
    // always returns the fallback string even when the species exists.
    const b = makeBattle({
      sideA: battleSide({ team: [battleMonster({ speciesId: 7 })] }),
    });
    const vm = buildBattleViewModel(
      b,
      makeSkillMap(1),
      makeSpeciesMap(speciesRow(7, 'Thundercub')),
    );
    expect(vm).not.toBeNull();
    expect(vm!.playerCard.speciesName).toBe('Thundercub');
  });

  it('BITES: player card unknown species falls back to "Unknown (#id)"', () => {
    // Kills: an impl that throws when speciesId is absent from the map, or
    // returns undefined instead of the fallback string.
    const b = makeBattle({
      sideA: battleSide({ team: [battleMonster({ speciesId: 99 })] }),
    });
    const vm = buildBattleViewModel(b, makeSkillMap(1), new Map()); // empty species map
    expect(vm).not.toBeNull();
    expect(vm!.playerCard.speciesName).toBe('Unknown (#99)');
  });

  it('BITES: player card level matches active monster level', () => {
    // Kills: an impl that hardcodes level or reads from the wrong team member.
    const b = makeBattle({
      sideA: battleSide({ team: [battleMonster({ level: 17 })] }),
    });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.playerCard.level).toBe(17);
  });

  it('BITES: player card currentHp and maxHp match the active monster', () => {
    // Kills: an impl that swaps currentHp/maxHp or reads from the wrong side.
    const b = makeBattle({
      sideA: battleSide({ team: [battleMonster({ currentHp: 13, maxHp: 40 })] }),
    });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.playerCard.currentHp).toBe(13);
    expect(vm!.playerCard.maxHp).toBe(40);
  });

  it('BITES: player card hpPercent uses the same guarded formula as hpPercent()', () => {
    // Kills: an impl that uses raw division without the guard, producing NaN when maxHp=0
    // or a value outside [0,100].
    const b = makeBattle({
      sideA: battleSide({ team: [battleMonster({ currentHp: 25, maxHp: 50 })] }),
    });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.playerCard.hpPercent).toBe(hpPercent(25, 50)); // 50
    expect(vm!.playerCard.hpPercent).toBe(50);
  });

  it('BITES: player card hpPercent is 0 (not NaN) when maxHp === 0', () => {
    // Kills: an impl that skips the divide-by-zero guard for the battle card,
    // yielding NaN which poisons subsequent renders.
    const b = makeBattle({
      sideA: battleSide({ team: [battleMonster({ currentHp: 0, maxHp: 0 })] }),
    });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.playerCard.hpPercent).toBe(0);
    expect(Number.isFinite(vm!.playerCard.hpPercent)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildBattleViewModel: opponent monster card
// ---------------------------------------------------------------------------

describe('buildBattleViewModel: opponent monster card data', () => {
  it('BITES: opponent card speciesName comes from sideB active monster, not sideA', () => {
    // Kills: an impl that reads both cards from sideA (copy-paste bug).
    const b = makeBattle({
      sideA: battleSide({ team: [battleMonster({ speciesId: 1 })] }),
      sideB: battleSide({ team: [battleMonster({ speciesId: 2 })] }),
    });
    const vm = buildBattleViewModel(
      b,
      makeSkillMap(1),
      makeSpeciesMap(speciesRow(1, 'Flameling'), speciesRow(2, 'Aqualing')),
    );
    expect(vm!.playerCard.speciesName).toBe('Flameling');
    expect(vm!.opponentCard.speciesName).toBe('Aqualing');
  });

  it('BITES: opponent card HP values come from sideB active monster', () => {
    // Kills: an impl that mirrors player card data onto opponent card.
    const b = makeBattle({
      sideA: battleSide({ team: [battleMonster({ currentHp: 20, maxHp: 20 })] }),
      sideB: battleSide({ team: [battleMonster({ currentHp: 8, maxHp: 30 })] }),
    });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.opponentCard.currentHp).toBe(8);
    expect(vm!.opponentCard.maxHp).toBe(30);
  });

  it('BITES: opponent card hpPercent is guarded (maxHp=0 → 0, not NaN)', () => {
    // Kills: an impl that guards the player card but forgets the opponent card.
    const b = makeBattle({
      sideB: battleSide({ team: [battleMonster({ currentHp: 0, maxHp: 0 })] }),
    });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.opponentCard.hpPercent).toBe(0);
    expect(Number.isFinite(vm!.opponentCard.hpPercent)).toBe(true);
  });

  it('BITES: sideB.active index selects the correct team member for opponentCard', () => {
    // Kills: an impl that always reads sideB.team[0] regardless of sideB.active.
    const slotZero = battleMonster({ speciesId: 1, level: 5 });
    const slotOne = battleMonster({ speciesId: 2, level: 12 });
    const b = makeBattle({
      sideB: { active: 1, team: [slotZero, slotOne] },
    });
    const vm = buildBattleViewModel(
      b,
      makeSkillMap(1),
      makeSpeciesMap(speciesRow(1, 'First'), speciesRow(2, 'Second')),
    );
    expect(vm!.opponentCard.speciesName).toBe('Second');
    expect(vm!.opponentCard.level).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// buildBattleViewModel: skills array
// ---------------------------------------------------------------------------

describe('buildBattleViewModel: skills array from active monster knownSkillIds', () => {
  it('BITES: skills array matches active monster knownSkillIds filtered through skillMap', () => {
    // Kills: an impl that returns all skills in the map, ignores knownSkillIds,
    // or reads skills from the wrong monster.
    const b = makeBattle({
      sideA: battleSide({ team: [battleMonster({ knownSkillIds: [2, 4] })] }),
    });
    const vm = buildBattleViewModel(
      b,
      makeSkillMap(1, 2, 3, 4, 5), // all skills available in the map
      makeSpeciesMap(speciesRow(1)),
    );
    expect(vm!.skills).toHaveLength(2);
    const skillIds = vm!.skills.map((sk) => sk.id);
    expect(skillIds).toContain(2);
    expect(skillIds).toContain(4);
    expect(skillIds).not.toContain(1);
    expect(skillIds).not.toContain(3);
  });

  it('BITES: missing skill in skillMap is excluded (no crash, no undefined entry)', () => {
    // Kills: an impl that crashes on skillMap.get(id) returning undefined, or
    // that includes an undefined entry in the skills array.
    const b = makeBattle({
      sideA: battleSide({ team: [battleMonster({ knownSkillIds: [1, 99] })] }),
    });
    const vm = buildBattleViewModel(
      b,
      makeSkillMap(1), // skill 99 not in map
      makeSpeciesMap(speciesRow(1)),
    );
    expect(vm!.skills).toHaveLength(1);
    expect(vm!.skills[0]!.id).toBe(1);
    for (const sk of vm!.skills) expect(sk).toBeDefined();
  });

  it('BITES: empty knownSkillIds yields empty skills array (no crash)', () => {
    // Kills: an impl that iterates undefined or throws on empty knownSkillIds.
    const b = makeBattle({
      sideA: battleSide({ team: [battleMonster({ knownSkillIds: [] })] }),
    });
    const vm = buildBattleViewModel(b, makeSkillMap(1, 2), makeSpeciesMap(speciesRow(1)));
    expect(vm!.skills).toEqual([]);
  });

  it('BITES: skills are derived from sideA active monster, not sideB or another team slot', () => {
    // Kills: an impl that accidentally reads knownSkillIds from the opponent or
    // from a non-active team member.
    const activeMonster = battleMonster({ knownSkillIds: [10, 20] });
    const benchMonster = battleMonster({ knownSkillIds: [30, 40] });
    const opponentMonster = battleMonster({ knownSkillIds: [50] });
    const b = makeBattle({
      sideA: { active: 0, team: [activeMonster, benchMonster] },
      sideB: battleSide({ team: [opponentMonster] }),
    });
    const skillMap = new Map<number, StoreSkillRow>([
      [10, skillRow(10)],
      [20, skillRow(20)],
      [30, skillRow(30)],
      [40, skillRow(40)],
      [50, skillRow(50)],
    ]);
    const vm = buildBattleViewModel(b, skillMap, makeSpeciesMap(speciesRow(1)));
    const ids = vm!.skills.map((sk) => sk.id);
    expect(ids).toContain(10);
    expect(ids).toContain(20);
    expect(ids).not.toContain(30);
    expect(ids).not.toContain(40);
    expect(ids).not.toContain(50);
  });
});

// ---------------------------------------------------------------------------
// buildBattleViewModel: canFlee
// ---------------------------------------------------------------------------

describe('buildBattleViewModel: canFlee follows outcome', () => {
  it('BITES: canFlee is true when outcome === "Ongoing"', () => {
    // Kills: an impl that hardcodes canFlee=false or ignores outcome.
    const b = makeBattle({ outcome: 'Ongoing' });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.canFlee).toBe(true);
  });

  it('BITES: canFlee is false when outcome === "SideAWins"', () => {
    // Kills: an impl that always returns canFlee=true (the broken adversarial stub).
    const b = makeBattle({ outcome: 'SideAWins' });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.canFlee).toBe(false);
  });

  it('BITES: canFlee is false when outcome === "SideBWins"', () => {
    // Kills: an impl that only checks for 'SideAWins' and misses the other terminal states.
    const b = makeBattle({ outcome: 'SideBWins' });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.canFlee).toBe(false);
  });

  it('BITES: canFlee is false when outcome === "Fled"', () => {
    // Kills: an impl that leaves the flee button visible after the player fled.
    const b = makeBattle({ outcome: 'Fled' });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.canFlee).toBe(false);
  });

  it('BITES: unknown outcome variant returns null (not a VM with canFlee=false)', () => {
    // CORRECTION (m14.5d, review refinement 5 / red-team 3): prior assertion was
    // `vm!.canFlee === false`, valid under the old default-arm behaviour. New spec:
    // unknown outcome tag → console.warn + return null (same as corrupt-team guard).
    // The bite is STRENGTHENED: an impl returning a non-null VM for 'Draw' now fails
    // both this test AND the dedicated unknown-outcome describe below.
    // Rationale: unknown outcome → null is safer than silently producing a partial VM
    // (the view's null-check hides the overlay rather than showing corrupt state).
    const b = makeBattle({ outcome: 'Draw' }); // hypothetical future variant
    const result = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildBattleViewModel: canSwap
// ---------------------------------------------------------------------------

describe('buildBattleViewModel: canSwap — ongoing AND valid bench member', () => {
  it('BITES: canSwap is true when ongoing AND sideA has a non-active, non-fainted bench member', () => {
    // Kills: an impl that ignores outcome when computing canSwap.
    const active = battleMonster({ currentHp: 20, maxHp: 20 });
    const bench = battleMonster({ currentHp: 15, maxHp: 20 }); // alive, not active
    const b = makeBattle({
      outcome: 'Ongoing',
      sideA: { active: 0, team: [active, bench] },
    });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.canSwap).toBe(true);
  });

  it('BITES: canSwap is false when ongoing but only one team member', () => {
    // Kills: an impl that sets canSwap=true without checking whether bench is non-empty.
    const b = makeBattle({
      outcome: 'Ongoing',
      sideA: { active: 0, team: [battleMonster()] }, // only one monster
    });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.canSwap).toBe(false);
  });

  it('BITES: canSwap is false when ongoing but all bench members are fainted (currentHp=0)', () => {
    // Kills: an impl that counts bench size but ignores fainted status.
    const active = battleMonster({ currentHp: 20, maxHp: 20 });
    const fainted = battleMonster({ currentHp: 0, maxHp: 20 }); // fainted
    const b = makeBattle({
      outcome: 'Ongoing',
      sideA: { active: 0, team: [active, fainted] },
    });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.canSwap).toBe(false);
  });

  it('BITES: canSwap is false when battle outcome is "SideAWins"', () => {
    // Kills: an impl that computes canSwap from team composition only, ignoring outcome
    // (the AUTHZ-1 threat from the adversarial test file).
    const active = battleMonster({ currentHp: 20, maxHp: 20 });
    const bench = battleMonster({ currentHp: 15, maxHp: 20 });
    const b = makeBattle({
      outcome: 'SideAWins',
      sideA: { active: 0, team: [active, bench] },
    });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.canSwap).toBe(false);
  });

  it('BITES: canSwap is false when battle is over (Fled outcome)', () => {
    // Kills: an impl that special-cases only SideAWins/SideBWins but misses Fled.
    const active = battleMonster({ currentHp: 20, maxHp: 20 });
    const bench = battleMonster({ currentHp: 15, maxHp: 20 });
    const b = makeBattle({
      outcome: 'Fled',
      sideA: { active: 0, team: [active, bench] },
    });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.canSwap).toBe(false);
  });

  it('BITES: unknown outcome variant returns null (not a VM with canSwap=false)', () => {
    // CORRECTION (m14.5d, review refinement 5 / red-team 3): prior assertion was
    // `vm!.canSwap === false`. New spec: unknown outcome → null (same null-guard
    // path as corrupt-team). Bite is preserved and strengthened — a VM returned for
    // 'Draw' fails this test and the dedicated unknown-outcome describe below.
    const active = battleMonster({ currentHp: 20, maxHp: 20 });
    const bench = battleMonster({ currentHp: 15, maxHp: 20 });
    const b = makeBattle({
      outcome: 'Draw',
      sideA: { active: 0, team: [active, bench] },
    });
    const result = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildBattleViewModel: battleId passthrough
// ---------------------------------------------------------------------------

describe('buildBattleViewModel: battleId passthrough', () => {
  it('BITES: battleId on the view-model matches the StoreBattle battleId (bigint)', () => {
    // Kills: an impl that drops battleId, casts it to number (lossy), or omits
    // it from BattleViewModel (the field is needed to dispatch reducer calls).
    const b = makeBattle({ battleId: 12345678901234567890n });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(typeof vm!.battleId).toBe('bigint');
    expect(vm!.battleId).toBe(12345678901234567890n);
  });
});

// ---------------------------------------------------------------------------
// buildBattleViewModel: canRecruit — ongoing AND wild (M8d, ADR-0045/0047)
// ---------------------------------------------------------------------------

describe('buildBattleViewModel: canRecruit — wild detection by opponentMonsterIds', () => {
  it('BITES: canRecruit is true in an ongoing WILD battle (opponentMonsterIds empty)', () => {
    // Kills: an impl that never surfaces recruit, or that uses opponentIdentity
    // instead of the documented empty-opponentMonsterIds wild signal.
    const b = makeBattle({ outcome: 'Ongoing', opponentMonsterIds: [] });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.canRecruit).toBe(true);
  });

  it('BITES: canRecruit is false in a PvP battle (opponentMonsterIds non-empty)', () => {
    // Kills: an impl that shows Recruit in PvP — the server rejects it, but the
    // UI must not even offer it (no owned-monster theft surface).
    const b = makeBattle({ outcome: 'Ongoing', opponentMonsterIds: [2n] });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.canRecruit).toBe(false);
  });

  it('BITES: canRecruit is false once a wild battle has ended (outcome != Ongoing)', () => {
    // Kills: an impl that gates only on wildness and ignores the outcome.
    const b = makeBattle({ outcome: 'SideAWins', opponentMonsterIds: [] });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.canRecruit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildBattleViewModel: baitOptions — classify by DATA (recruit_bonus > 0)
// ---------------------------------------------------------------------------

describe('buildBattleViewModel: baitOptions classify by recruit_bonus, not item id', () => {
  it('BITES: only items with recruit_bonus > 0 AND count > 0 appear as bait', () => {
    // Kills: an impl that lists ALL inventory items, or filters by a hardcoded id.
    const b = makeBattle({ outcome: 'Ongoing', opponentMonsterIds: [] });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)), [
      { itemId: 1, name: 'Lure Berry', recruitBonus: 150, count: 3 },
      { itemId: 2, name: 'Potion', recruitBonus: 0, count: 5 }, // not bait
      { itemId: 3, name: 'Empty Lure', recruitBonus: 150, count: 0 }, // none held
    ]);
    expect(vm!.baitOptions).toHaveLength(1);
    expect(vm!.baitOptions[0]!.itemId).toBe(1);
    expect(vm!.baitOptions[0]!.recruitBonus).toBe(150);
  });

  it('BITES: baitOptions is empty when the battle is not recruitable (PvP)', () => {
    // Kills: an impl that surfaces bait even when recruit is impossible.
    const b = makeBattle({ outcome: 'Ongoing', opponentMonsterIds: [2n] });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)), [
      { itemId: 1, name: 'Lure Berry', recruitBonus: 150, count: 3 },
    ]);
    expect(vm!.baitOptions).toEqual([]);
  });

  it('BITES: baitOptions defaults to empty when no bait list is provided', () => {
    // Kills: an impl that crashes or returns undefined when the optional arg is omitted.
    const b = makeBattle({ outcome: 'Ongoing', opponentMonsterIds: [] });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.baitOptions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M8.6c — negative active index: fail-soft (returns null, does NOT throw)
// SOURCE OF TRUTH: specs/monster-realm-v2/M8.6-residual-hardening.spec.md
//
// RED reason (before impl): the current guard is `sideX.active >= sideX.team.length`
// which uses strict `>=`. When active === -1:
//   -1 >= team.length  →  false  (guard does NOT fire)
//   team[-1]           →  undefined
//   monsterCard(undefined, …) → crashes (TypeError: Cannot read properties of undefined)
//
// After fix: both side guards add `|| sideX.active < 0`, so a negative active
// returns null WITHOUT throwing, matching the existing behavior for out-of-bounds.
//
// BITES: the `>=`-only guard which lets -1 through, crashing downstream.
// ---------------------------------------------------------------------------

describe('buildBattleViewModel M8.6c: negative active index → null, no throw', () => {
  it('BITES: sideA.active = -1 returns null and does NOT throw', () => {
    // RED reason: current guard `-1 >= 1` is false → team[-1] = undefined → crash.
    // After fix: `active < 0` check fires before the team access → returns null.
    // Wrong impl killed: a guard that only checks `active >= team.length` (the
    // current `>=`-only impl lets negative actives slip through to `team[-1]`).
    const b = makeBattle({
      sideA: { active: -1, team: [battleMonster()] },
    });
    const act = () => buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(act).not.toThrow();
    expect(act()).toBeNull();
  });

  it('BITES: sideB.active = -1 returns null and does NOT throw', () => {
    // RED reason: sideB guard also only uses `>=` today. -1 for sideB passes the
    // guard and crashes on `sideB.team[-1]`.
    // Wrong impl killed: a guard that patches sideA but forgets sideB.
    const b = makeBattle({
      sideB: { active: -1, team: [battleMonster()] },
    });
    const act = () => buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(act).not.toThrow();
    expect(act()).toBeNull();
  });

  it('BITES: both sides negative → still returns null, still does NOT throw', () => {
    // Kills: a partial-fix that patches one side but not the other, and any order-
    // dependent crash when both sides simultaneously carry a negative active index.
    const b = makeBattle({
      sideA: { active: -1, team: [battleMonster()] },
      sideB: { active: -2, team: [battleMonster(), battleMonster()] },
    });
    const act = () => buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(act).not.toThrow();
    expect(act()).toBeNull();
  });

  it('BITES: sideA.active = -1 is rejected even when sideA.team is non-empty', () => {
    // Kills: an impl that adds `team.length === 0` as the only new guard (misses
    // the negative-index case for a non-empty team).
    const b = makeBattle({
      sideA: {
        active: -1,
        team: [battleMonster(), battleMonster(), battleMonster()], // 3 members
      },
    });
    const result = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(result).toBeNull();
  });

  it('BITES: sideB.active = -1 is rejected even when sideB.team is non-empty', () => {
    // Symmetric guard check for sideB: a large team must not rescue a negative index.
    const b = makeBattle({
      sideB: {
        active: -1,
        team: [battleMonster(), battleMonster()],
      },
    });
    const result = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(result).toBeNull();
  });

  it('valid active=0 on both sides still returns a non-null view-model (guard not over-eager)', () => {
    // Regression guard: the new `< 0` check must NOT fire for the normal case active=0.
    // Kills: an over-eager impl that treats active=0 as "falsy" and returns null.
    const b = makeBattle({
      sideA: { active: 0, team: [battleMonster()] },
      sideB: { active: 0, team: [battleMonster()] },
    });
    const result = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(result).not.toBeNull();
  });
});

// =============================================================================
// M8.7e — decideBattleOverlay pure reducer
// SOURCE OF TRUTH: specs/monster-realm-v2/M8.7-third-review-residuals.spec.md §3
//   "WHEN a player's battle resolves … THE SYSTEM SHALL render the terminal
//   outcome frame at least once … explicit dismiss (Escape) … Ongoing auto-show
//   preserved."
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
// RED: `decideBattleOverlay`, `OverlayState`, `BattleOverlayAction`, `OverlayResult`
// do not exist in battleModel.ts yet.
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

// =============================================================================
// m14.5d — weatherBanner pure function
// SOURCE OF TRUTH: specs/monster-realm-v2/M14.5-eighth-review-residuals.spec.md §14.5d-2
//
// RED REASON: `weatherBanner` does not exist yet in battleModel.ts.
// =============================================================================

describe('battleModel m14.5d: weatherBanner — tag to label mapping', () => {
  it('BITES: weatherBanner("Rain") returns non-empty label', () => {
    // Kills: an impl that returns '' for Rain (treats every tag as unknown).
    expect(weatherBanner('Rain').length).toBeGreaterThan(0);
  });

  it('BITES: weatherBanner("Sun") returns non-empty label', () => {
    // Kills: an impl that only handles Rain and falls through to '' for Sun.
    expect(weatherBanner('Sun').length).toBeGreaterThan(0);
  });

  it('BITES: weatherBanner("Sandstorm") returns non-empty label', () => {
    // Kills: an impl missing the Sandstorm case.
    expect(weatherBanner('Sandstorm').length).toBeGreaterThan(0);
  });

  it('BITES: weatherBanner("Hail") returns non-empty label', () => {
    // Kills: an impl missing the Hail case.
    expect(weatherBanner('Hail').length).toBeGreaterThan(0);
  });

  it('BITES: weatherBanner(null) returns empty string (no banner for no weather)', () => {
    // Kills: an impl that returns a label even when weather is absent.
    expect(weatherBanner(null)).toBe('');
  });

  it('BITES: weatherBanner(undefined) returns empty string', () => {
    // Kills: an impl that crashes on undefined rather than returning ''.
    expect(weatherBanner(undefined)).toBe('');
  });

  it('BITES: weatherBanner("UnknownWeather") warns + returns empty string (reviewer m-1)', () => {
    // m23-s8: the two contracts DIVERGE here, deliberately - this is no longer "identical to
    // statusBadge's default arm". statusBadge now returns a VISIBLE derived token (see
    // unknownStatusToken) because a per-monster status badge that renders NOTHING is
    // indistinguishable from "this monster is healthy": the absence is a lie about game state,
    // and the badge is the HP bar's only non-colour channel for a status effect (M23 2.6).
    // A weather banner carries no such ambiguity - no banner means no weather, which is the
    // true and overwhelmingly common case - so an unknown weather tag must still render
    // nothing rather than invent a label across the battlefield. Both arms still warn.
    // Kills: an impl that throws on unknown tags, or that returns a non-empty string.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = weatherBanner('UnknownWeather');
    expect(result).toBe('');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// =============================================================================
// m14.5d — parity guards (js-path-parity-style; red-team 1/3)
// SOURCE OF TRUTH: specs/monster-realm-v2/M14.5-eighth-review-residuals.spec.md §14.5d-3
//
// RED REASON: weatherBanner / BattleOutcomeTag / shouldSkipBattleRefresh / battleVMsEqual
// do not yet exist; StatusEffect/WeatherEffect/BattleOutcome are imported from
// module_bindings/types (already present) — those imports succeed now, but the
// functions under test do not exist.
//
// ANTI-PATTERN: never iterate variants without the length anchor + known-member
// check. An empty variants array must FAIL, never vacuously pass.
// =============================================================================

describe('battleModel m14.5d: parity — StatusEffect variants all produce non-empty statusBadge', () => {
  it('BITES anchor: StatusEffect has exactly 5 variants and contains "Poison"', () => {
    // Red-team 3 / proof-of-teeth: anchor BEFORE iterating. An empty variants array
    // must cause this test to fail (length check), not vacuously pass the loop.
    // Kills: a bindings regen that added/removed a variant without updating statusBadge.
    const variants = (StatusEffect.algebraicType.value as { variants: Array<{ name: string }> })
      .variants;
    expect(variants.length).toBe(5);
    expect(variants.map((v) => v.name)).toContain('Poison');
  });

  it('BITES: every StatusEffect variant name produces a non-empty statusBadge', () => {
    // Kills: an impl where statusBadge has a gap for any current variant (not just
    // a hypothetical future one). The length anchor in the prior test ensures we
    // never vacuously pass an empty variants array.
    // statusBadge is imported at the top of this file from battleModel.
    // m23-s8 HARDENING - DO NOT REMOVE. MEASURED: once statusBadge's default arm returns a
    // VISIBLE token instead of the empty string, the `length > 0` assertion below stops biting
    // at all - deleting `case 'Poison':` from statusBadge went from REDding 2 tests to 118/118
    // GREEN. Two oracles restore the bite, neither of them length-based:
    //   * ZERO WARNINGS across all five variants - the default arm console.warns, so a deleted
    //     case is observable no matter what string it returns. This is the universal tooth.
    //   * The SHADOW CENSUS - which variants' curated badge is byte-identical to the unknown
    //     fallback. Deleting a case moves that variant INTO the set. The fallback is spelled so
    //     that it can never collide with a curated token, so the census is EXACTLY empty.
    const variants = (StatusEffect.algebraicType.value as { variants: Array<{ name: string }> })
      .variants;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const v of variants) {
        const badge = statusBadge(v.name);
        expect(badge.length, `statusBadge("${v.name}") must be non-empty`).toBeGreaterThan(0);
      }
      expect(
        warnSpy,
        'm23-s8: statusBadge must not warn for ANY current StatusEffect variant. A warning ' +
          'means that variant fell through to the unknown-tag default arm, i.e. the map has ' +
          'a gap that the now-visible fallback would otherwise hide from the length check ' +
          'above',
      ).not.toHaveBeenCalled();
      const shadowed = variants
        .filter((v) => statusBadge(v.name) === unknownStatusToken(v.name))
        .map((v) => v.name)
        .sort();
      expect(
        shadowed,
        'm23-s8 SHADOW CENSUS: no curated badge may be byte-identical to the unknown-tag ' +
          'fallback. A name appearing here means its case was deleted and the fallback is ' +
          "wearing the curated badge's clothes",
      ).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('battleModel m14.5d: parity — WeatherEffect variants all produce non-empty weatherBanner', () => {
  it('BITES anchor: WeatherEffect has exactly 4 variants and contains "Rain"', () => {
    // Proof-of-teeth anchor: an empty/missing variants array must fail, never pass.
    // Kills: a bindings regen that changed the weather variant set without updating weatherBanner.
    const variants = (WeatherEffect.algebraicType.value as { variants: Array<{ name: string }> })
      .variants;
    expect(variants.length).toBe(4);
    expect(variants.map((v) => v.name)).toContain('Rain');
  });

  it('BITES: every WeatherEffect variant name produces a non-empty weatherBanner', () => {
    // Kills: an impl where weatherBanner is missing any current WeatherEffect variant.
    // The length anchor ensures we cannot vacuously pass an empty array.
    const variants = (WeatherEffect.algebraicType.value as { variants: Array<{ name: string }> })
      .variants;
    for (const v of variants) {
      const label = weatherBanner(v.name);
      expect(label.length, `weatherBanner("${v.name}") must be non-empty`).toBeGreaterThan(0);
    }
  });
});

describe('battleModel m14.5d: parity — BattleOutcome variants all accepted by buildBattleViewModel', () => {
  it('BITES anchor: BattleOutcome has exactly 4 variants and contains "Ongoing"', () => {
    // Proof-of-teeth anchor: a bindings regen that removed a variant must fail here,
    // not silently iterate an empty array. An empty variants array must fail this test.
    // Kills: an impl that hardcodes a 3-variant union and misses a new server variant.
    const variants = (BattleOutcome.algebraicType.value as { variants: Array<{ name: string }> })
      .variants;
    expect(variants.length).toBe(4);
    expect(variants.map((v) => v.name)).toContain('Ongoing');
  });

  it('BITES: every BattleOutcome variant name is accepted by buildBattleViewModel (non-null VM, outcome equals name)', () => {
    // Kills: an impl that returns null for a valid BattleOutcome variant name
    // (e.g. if buildBattleViewModel treats all non-Ongoing as unknown → null).
    // The BattleOutcomeTag union must include every variant the server can emit.
    // Red-team 3: 'Ongoing' → non-null VM, outcome==='Ongoing'; etc.
    const variants = (BattleOutcome.algebraicType.value as { variants: Array<{ name: string }> })
      .variants;
    for (const v of variants) {
      const b = makeBattle({ outcome: v.name });
      const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
      expect(
        vm,
        `buildBattleViewModel with outcome="${v.name}" must return non-null`,
      ).not.toBeNull();
      expect(vm!.outcome, `vm.outcome must equal "${v.name}"`).toBe(v.name as BattleOutcomeTag);
    }
  });
});

// =============================================================================
// m14.5d — unknown outcome: buildBattleViewModel returns null + warns (red-team 3)
// SOURCE OF TRUTH: specs/monster-realm-v2/M14.5-eighth-review-residuals.spec.md §14.5d-3
//
// RED REASON: current buildBattleViewModel returns a VM with outcome:'Draw' (string)
// rather than returning null. The new spec requires: unknown outcome tag → console.warn
// + return null (same as corrupt-team guard). This replaces the `default: text = ...`
// arm in #renderOutcome.
// =============================================================================

describe('battleModel m14.5d: unknown outcome → buildBattleViewModel returns null + warns', () => {
  it('BITES: StoreBattle with outcome:"Draw" → buildBattleViewModel returns null', () => {
    // Red-team 3 / review refinement 5: unknown outcome tag → null (not a VM with
    // outcome:'Draw'). This is a BEHAVIOUR CHANGE from the existing default arm.
    // Wrong impl killed: current impl returns a VM with outcome==='Draw' (string).
    const b = makeBattle({ outcome: 'Draw' });
    const result = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(result).toBeNull();
  });

  it('BITES: buildBattleViewModel warns when outcome is unknown', () => {
    // Kills: an impl that silently returns null without console.warn (making it
    // impossible to detect missing union members in development).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = makeBattle({ outcome: 'FutureTournamentDraw' });
    buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('BITES: unknown outcome guard does NOT fire for valid BattleOutcomeTag values', () => {
    // Regression guard: the null-on-unknown must NOT fire for the 4 known variants.
    // Kills: an over-eager impl that rejects all non-'Ongoing' outcomes as unknown.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const outcome of ['Ongoing', 'SideAWins', 'SideBWins', 'Fled'] as const) {
      const b = makeBattle({ outcome });
      const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
      expect(vm, `outcome="${outcome}" must produce a non-null VM`).not.toBeNull();
    }
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// =============================================================================
// m14.5d — BattleViewModel.weather propagation via buildBattleViewModel
// SOURCE OF TRUTH: specs/monster-realm-v2/M14.5-eighth-review-residuals.spec.md §14.5d-2
//
// RED REASON: BattleViewModel does not yet have a `weather` field; StoreBattle
// does not yet have a `weather` field; weatherBanner does not yet exist.
// =============================================================================

describe('battleModel m14.5d: BattleViewModel.weather propagation', () => {
  it('BITES: battle.weather={tag:"Rain",turnsRemaining:3} → vm.weather non-null with turnsRemaining:3 and non-empty label', () => {
    // Kills: an impl that ignores StoreBattle.weather when building the VM.
    // Also kills: an impl that maps weather but produces an empty label.
    const b = makeBattle({
      weather: { tag: 'Rain', turnsRemaining: 3 },
    } as Partial<StoreBattle>);
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm).not.toBeNull();
    expect(vm!.weather).not.toBeNull();
    expect(vm!.weather!.turnsRemaining).toBe(3);
    expect(vm!.weather!.label.length).toBeGreaterThan(0);
  });

  it('BITES: battle.weather=null → vm.weather === null', () => {
    // Kills: an impl that fabricates a weather VM even when the store says no weather.
    const b = makeBattle({ weather: null } as Partial<StoreBattle>);
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm).not.toBeNull();
    expect(vm!.weather).toBeNull();
  });
});

// =============================================================================
// m14.5d — battleVMsEqual field-by-field equality
// SOURCE OF TRUTH: specs/monster-realm-v2/M14.5-eighth-review-residuals.spec.md §14.5d-4
//
// RED REASON: battleVMsEqual does not exist yet in battleModel.ts.
// =============================================================================

/** Build a full BattleViewModel for equality tests — uses buildBattleViewModel
 *  with deterministic inputs so two calls with identical args produce identical VMs. */
function makeFullVM(overrides: Partial<StoreBattle> = {}): BattleViewModel {
  const b = makeBattle({
    battleId: 10n,
    turnNumber: 2,
    outcome: 'Ongoing',
    weather: null,
    sideA: {
      active: 0,
      team: [battleMonster({ speciesId: 1, currentHp: 30, maxHp: 40, knownSkillIds: [1, 2] })],
    },
    sideB: {
      active: 0,
      team: [battleMonster({ speciesId: 2, currentHp: 20, maxHp: 35 })],
    },
    opponentMonsterIds: [],
    ...overrides,
  } as Partial<StoreBattle>);
  const vm = buildBattleViewModel(
    b,
    new Map([
      [1, skillRow(1, { name: 'Ember', power: 40 })],
      [2, skillRow(2, { name: 'Tackle', power: 35 })],
    ]),
    makeSpeciesMap(speciesRow(1, 'Flameling'), speciesRow(2, 'Aqualing')),
    [{ itemId: 7, name: 'Lure Berry', recruitBonus: 150, count: 3 }],
  );
  if (vm === null) throw new Error('makeFullVM: buildBattleViewModel returned null');
  return vm;
}

describe('battleModel m14.5d: battleVMsEqual — identical VMs → true', () => {
  it('BITES: two independently built identical VMs are equal', () => {
    // Kills: an impl that always returns false (reference comparison, not field compare).
    const a = makeFullVM();
    const b = makeFullVM();
    expect(battleVMsEqual(a, b)).toBe(true);
  });
});

describe('battleModel m14.5d: battleVMsEqual — each field class flips equality', () => {
  it('BITES: differing turnNumber → not equal', () => {
    // Kills: an impl that omits turnNumber from the comparison.
    const a = makeFullVM({ turnNumber: 1 });
    const b = makeFullVM({ turnNumber: 2 });
    expect(battleVMsEqual(a, b)).toBe(false);
  });

  it('BITES: differing playerCard.currentHp → not equal', () => {
    // Kills: an impl that skips HP fields in the card comparison.
    const a = makeFullVM({
      sideA: {
        active: 0,
        team: [battleMonster({ speciesId: 1, currentHp: 30, maxHp: 40, knownSkillIds: [1, 2] })],
      },
    } as Partial<StoreBattle>);
    const b = makeFullVM({
      sideA: {
        active: 0,
        team: [battleMonster({ speciesId: 1, currentHp: 15, maxHp: 40, knownSkillIds: [1, 2] })],
      },
    } as Partial<StoreBattle>);
    expect(battleVMsEqual(a, b)).toBe(false);
  });

  it('BITES: playerCard.status null vs "PSN" → not equal', () => {
    // Kills: an impl that ignores status in the card comparison (weather churn fix).
    const a = makeFullVM({
      sideA: {
        active: 0,
        team: [
          battleMonster({
            speciesId: 1,
            currentHp: 30,
            maxHp: 40,
            knownSkillIds: [1, 2],
            status: null,
          }),
        ],
      },
    } as Partial<StoreBattle>);
    const b = makeFullVM({
      sideA: {
        active: 0,
        team: [
          battleMonster({
            speciesId: 1,
            currentHp: 30,
            maxHp: 40,
            knownSkillIds: [1, 2],
            status: { tag: 'Poison' },
          }),
        ],
      },
    } as Partial<StoreBattle>);
    expect(battleVMsEqual(a, b)).toBe(false);
  });

  it('BITES: weather null vs {tag:"Rain",turnsRemaining:3} → not equal (Escape→weather-arrives→re-show path)', () => {
    // Red-team 4 / review refinement 4: the shouldSkipBattleRefresh visible-guard
    // test covers the escape path; this test covers the equality predicate that
    // makes it work. A stale-hidden escape followed by a weather-effect arriving
    // must re-render — so two VMs differing only on weather must NOT be equal.
    // Kills: an impl that omits weather from battleVMsEqual.
    const a = makeFullVM({ weather: null } as Partial<StoreBattle>);
    const b = makeFullVM({ weather: { tag: 'Rain', turnsRemaining: 3 } } as Partial<StoreBattle>);
    expect(battleVMsEqual(a, b)).toBe(false);
  });

  it('BITES: weather same tag but different turnsRemaining → not equal', () => {
    // Kills: an impl that compares weather.tag but ignores turnsRemaining (the
    // countdown would freeze on screen; players need to see it tick down).
    const a = makeFullVM({
      weather: { tag: 'Rain', turnsRemaining: 3 },
    } as Partial<StoreBattle>);
    const b = makeFullVM({
      weather: { tag: 'Rain', turnsRemaining: 2 },
    } as Partial<StoreBattle>);
    expect(battleVMsEqual(a, b)).toBe(false);
  });

  it('BITES: weather different tag → not equal', () => {
    // Kills: an impl that ignores weather.tag (compares only turnsRemaining).
    const a = makeFullVM({
      weather: { tag: 'Rain', turnsRemaining: 3 },
    } as Partial<StoreBattle>);
    const b = makeFullVM({
      weather: { tag: 'Sun', turnsRemaining: 3 },
    } as Partial<StoreBattle>);
    expect(battleVMsEqual(a, b)).toBe(false);
  });

  it('BITES: skills array length differs → not equal (reviewer B-2: length-first)', () => {
    // Reviewer B-2: length check FIRST before per-element compare.
    // Kills: an impl that iterates elements without checking length first (could
    // produce true when the shorter array is a prefix of the longer one).
    const a = makeFullVM({
      sideA: {
        active: 0,
        team: [battleMonster({ speciesId: 1, currentHp: 30, maxHp: 40, knownSkillIds: [1] })],
      },
    } as Partial<StoreBattle>);
    const b = makeFullVM({
      sideA: {
        active: 0,
        team: [battleMonster({ speciesId: 1, currentHp: 30, maxHp: 40, knownSkillIds: [1, 2] })],
      },
    } as Partial<StoreBattle>);
    expect(battleVMsEqual(a, b)).toBe(false);
  });

  it('BITES: bench length differs → not equal (reviewer B-2: length-first)', () => {
    // Kills: an impl that skips bench in the comparison or checks it without
    // a length-first guard (a bench addition must re-render swap options).
    const baseA = makeBattle({
      battleId: 10n,
      turnNumber: 2,
      outcome: 'Ongoing',
      weather: null,
      sideA: {
        active: 0,
        team: [battleMonster({ speciesId: 1, currentHp: 30, maxHp: 40, knownSkillIds: [1, 2] })],
      },
      sideB: { active: 0, team: [battleMonster({ speciesId: 2, currentHp: 20, maxHp: 35 })] },
      opponentMonsterIds: [],
    } as Partial<StoreBattle>);
    const baseB = makeBattle({
      battleId: 10n,
      turnNumber: 2,
      outcome: 'Ongoing',
      weather: null,
      sideA: {
        active: 0,
        team: [
          battleMonster({ speciesId: 1, currentHp: 30, maxHp: 40, knownSkillIds: [1, 2] }),
          battleMonster({ speciesId: 3, currentHp: 25, maxHp: 30, knownSkillIds: [] }), // bench member
        ],
      },
      sideB: { active: 0, team: [battleMonster({ speciesId: 2, currentHp: 20, maxHp: 35 })] },
      opponentMonsterIds: [],
    } as Partial<StoreBattle>);
    const skillMap = new Map([
      [1, skillRow(1, { name: 'Ember', power: 40 })],
      [2, skillRow(2, { name: 'Tackle', power: 35 })],
    ]);
    const sMap = makeSpeciesMap(
      speciesRow(1, 'Flameling'),
      speciesRow(2, 'Aqualing'),
      speciesRow(3, 'Leafling'),
    );
    const vmA = buildBattleViewModel(baseA, skillMap, sMap, []);
    const vmB = buildBattleViewModel(baseB, skillMap, sMap, []);
    expect(vmA).not.toBeNull();
    expect(vmB).not.toBeNull();
    expect(battleVMsEqual(vmA!, vmB!)).toBe(false);
  });

  it('BITES: baitOptions length differs → not equal', () => {
    // Kills: an impl that omits baitOptions from the comparison
    // (an item being added/removed from inventory must re-render the selector).
    const bA = makeBattle({
      battleId: 10n,
      turnNumber: 2,
      outcome: 'Ongoing',
      weather: null,
      sideA: {
        active: 0,
        team: [battleMonster({ speciesId: 1, currentHp: 30, maxHp: 40, knownSkillIds: [1, 2] })],
      },
      sideB: { active: 0, team: [battleMonster({ speciesId: 2, currentHp: 20, maxHp: 35 })] },
      opponentMonsterIds: [],
    } as Partial<StoreBattle>);
    const skillMap = new Map([
      [1, skillRow(1, { name: 'Ember', power: 40 })],
      [2, skillRow(2, { name: 'Tackle', power: 35 })],
    ]);
    const sMap = makeSpeciesMap(speciesRow(1, 'Flameling'), speciesRow(2, 'Aqualing'));
    const vmA = buildBattleViewModel(bA, skillMap, sMap, [
      { itemId: 7, name: 'Lure Berry', recruitBonus: 150, count: 3 },
    ]);
    const vmB = buildBattleViewModel(bA, skillMap, sMap, [
      { itemId: 7, name: 'Lure Berry', recruitBonus: 150, count: 3 },
      { itemId: 9, name: 'Sweet Bait', recruitBonus: 250, count: 1 },
    ]);
    expect(vmA).not.toBeNull();
    expect(vmB).not.toBeNull();
    expect(battleVMsEqual(vmA!, vmB!)).toBe(false);
  });

  it('BITES: baitOptions count differs → not equal (inventory change must re-render)', () => {
    // The plan explicitly calls out baitOptions.count in the compare as intentional:
    // inventory changes MUST re-render. Kills: an impl that compares itemId but not count.
    const bBase = makeBattle({
      battleId: 10n,
      turnNumber: 2,
      outcome: 'Ongoing',
      weather: null,
      sideA: {
        active: 0,
        team: [battleMonster({ speciesId: 1, currentHp: 30, maxHp: 40, knownSkillIds: [1, 2] })],
      },
      sideB: { active: 0, team: [battleMonster({ speciesId: 2, currentHp: 20, maxHp: 35 })] },
      opponentMonsterIds: [],
    } as Partial<StoreBattle>);
    const skillMap = new Map([
      [1, skillRow(1, { name: 'Ember', power: 40 })],
      [2, skillRow(2, { name: 'Tackle', power: 35 })],
    ]);
    const sMap = makeSpeciesMap(speciesRow(1, 'Flameling'), speciesRow(2, 'Aqualing'));
    const vmA = buildBattleViewModel(bBase, skillMap, sMap, [
      { itemId: 7, name: 'Lure Berry', recruitBonus: 150, count: 3 },
    ]);
    const vmB = buildBattleViewModel(bBase, skillMap, sMap, [
      { itemId: 7, name: 'Lure Berry', recruitBonus: 150, count: 1 }, // count changed
    ]);
    expect(vmA).not.toBeNull();
    expect(vmB).not.toBeNull();
    expect(battleVMsEqual(vmA!, vmB!)).toBe(false);
  });

  it('BITES: differing outcome → not equal', () => {
    // Kills: an impl that omits outcome from the comparison.
    const a = makeFullVM({ outcome: 'Ongoing' });
    const b = makeFullVM({ outcome: 'SideAWins' });
    expect(battleVMsEqual(a, b)).toBe(false);
  });

  it('BITES: differing canRecruit → not equal', () => {
    // Kills: an impl that omits canRecruit from the comparison.
    // wild: opponentMonsterIds:[] vs pvp: opponentMonsterIds:[2n]
    const a = makeFullVM({ opponentMonsterIds: [] });
    const b = makeFullVM({ opponentMonsterIds: [2n] });
    expect(battleVMsEqual(a, b)).toBe(false);
  });

  it('BITES: identical non-null weather → equal (non-null-weather branch returns true)', () => {
    // Kills: a broken final `return true` path for the non-null-weather branch
    // that mistakenly returns false when both VMs have the same weather object.
    // Two VMs with the same weather tag and turnsRemaining must be equal.
    const a = makeFullVM({ weather: { tag: 'Rain', turnsRemaining: 3 } } as Partial<StoreBattle>);
    const b = makeFullVM({ weather: { tag: 'Rain', turnsRemaining: 3 } } as Partial<StoreBattle>);
    expect(battleVMsEqual(a, b)).toBe(true);
  });

  it('BITES: differing battleId (bigint) → not equal (no Number() coercion)', () => {
    // Bigint comparison must use === directly; Number() is lossy for u64 values
    // above 2^53. Kills: an impl using Number(battleId) for comparison.
    const a = makeFullVM({ battleId: 9007199254740993n }); // 2^53 + 1
    const b = makeFullVM({ battleId: 9007199254740992n }); // 2^53 (same when Number()-cast)
    expect(battleVMsEqual(a, b)).toBe(false);
  });

  it('BITES: equal bigint battleIds → no false-negative (bigint === bigint is correct)', () => {
    // Kills: an impl that uses Object.is(Number(a), Number(b)) which would coerce
    // both 9007199254740993n and 9007199254740992n to the same number.
    const a = makeFullVM({ battleId: 9007199254740993n });
    const b = makeFullVM({ battleId: 9007199254740993n });
    expect(battleVMsEqual(a, b)).toBe(true);
  });
});

// =============================================================================
// m14.5d — shouldSkipBattleRefresh pure guard (red-team 4 / review refinement 4)
// SOURCE OF TRUTH: specs/monster-realm-v2/M14.5-eighth-review-residuals.spec.md §14.5d-4
//
// RED REASON: shouldSkipBattleRefresh does not exist yet in battleModel.ts.
//
// Contract: returns true ONLY when visible && both non-null && battleVMsEqual(lastVm, vm).
// All other combinations → false (never skip).
// =============================================================================

describe('battleModel m14.5d: shouldSkipBattleRefresh — skip conditions', () => {
  it('BITES: (visible=true, equal VMs) → true (the only skip path)', () => {
    // Kills: an impl that always returns false (disables the optimisation entirely).
    const vm = makeFullVM();
    const vmCopy = makeFullVM(); // independently built, structurally identical
    expect(shouldSkipBattleRefresh(true, vm, vmCopy)).toBe(true);
  });

  it('BITES: (visible=false, equal VMs) → false (hidden → never skip)', () => {
    // Review refinement 7: while the view is hidden, the check must never skip.
    // A skip while hidden causes the re-show render to be dropped (stale-hidden trap).
    // Kills: an impl that skips based only on VM equality without the visible guard.
    const vm = makeFullVM();
    const vmCopy = makeFullVM();
    expect(shouldSkipBattleRefresh(false, vm, vmCopy)).toBe(false);
  });

  it('BITES: (visible=true, lastVm=null) → false (after reset, same VM re-renders)', () => {
    // After the hide-branch resets lastBattleVM=null, the next call must NOT skip.
    // Kills: an impl that treats null as "equal to anything".
    const vm = makeFullVM();
    expect(shouldSkipBattleRefresh(true, null, vm)).toBe(false);
  });

  it('BITES: (visible=true, vm=null) → false (null VM is not a valid skip)', () => {
    // Kills: an impl that returns true when vm is null (would prevent the hide render).
    const vm = makeFullVM();
    expect(shouldSkipBattleRefresh(true, vm, null)).toBe(false);
  });

  it('BITES: (visible=true, both null) → false (null,null → never skip)', () => {
    // Kills: an impl that treats (null === null) as equality and skips.
    expect(shouldSkipBattleRefresh(true, null, null)).toBe(false);
  });

  it('BITES: (visible=false, both null) → false', () => {
    // Symmetric: hidden + both null → false.
    expect(shouldSkipBattleRefresh(false, null, null)).toBe(false);
  });

  it('BITES: vmNoWeather vs vmWithWeather → false (Escape→weather-arrives→re-show path)', () => {
    // Red-team 4 review refinement 4: if the player presses Escape (bare-hide at
    // main.ts:489) and then a weather effect arrives on the next batch, the next
    // visible=false call must not skip (already covered), but after re-show the
    // first call with visible=true must also not skip because the VMs differ.
    // This test covers the VM-differ case: noWeather vs withWeather.
    // Kills: an impl that ignores weather in battleVMsEqual or shouldSkipBattleRefresh.
    const vmNoWeather = makeFullVM({ weather: null } as Partial<StoreBattle>);
    const vmWithWeather = makeFullVM({
      weather: { tag: 'Rain', turnsRemaining: 3 },
    } as Partial<StoreBattle>);
    expect(shouldSkipBattleRefresh(true, vmNoWeather, vmWithWeather)).toBe(false);
  });

  it('BITES: after hide-branch reset (lastVm=null), same VM still re-renders → false', () => {
    // Simulates: hide branch sets lastBattleVM=null, then the next refresh
    // arrives with the same VM it had before. Must NOT skip — the view needs
    // to re-render to be visible again.
    // Kills: an impl that caches the pre-hide VM and re-uses it after hide.
    const vm = makeFullVM();
    // lastVm is null (reset on hide), vm is the new one
    expect(shouldSkipBattleRefresh(true, null, vm)).toBe(false);
  });
});

// =============================================================================
// m14.5d — battleVMsEqual: weather undefined-safety invariant
// FINDING: battleVMsEqual crashes (TypeError: Cannot read property 'label' of undefined)
// when BOTH VMs carry weather=undefined. The current strict null-check (=== null) does
// not match undefined, so both the null-null early-return and the mixed-null guard are
// bypassed, and `aw.label` throws. The production path through buildBattleViewModel
// always produces weather=null (not undefined), so the crash is currently unreachable —
// but it is latent: any test factory that builds a BattleViewModel without the weather
// field and then passes it to battleVMsEqual will trigger the crash.
//
// FIX: replace `=== null` with `== null` (loose equality) in the two weather null-checks
// at battleVMsEqual lines 410-411. Loose equality treats both null and undefined as
// "absent weather", which is the correct semantic (both mean no active weather).
// The fix has zero behavior change for the production path (weather is always null there).
//
// This test is GREEN after the fix and acts as a permanent regression guard.
// =============================================================================

describe('battleModel m14.5d invariant: battleVMsEqual weather=undefined never throws', () => {
  it('GATING: battleVMsEqual(vmWithUndefinedWeather, vmWithUndefinedWeather) must not throw', () => {
    // Repro: build two VMs with weather=undefined (simulating a test factory that
    // omits the weather field), then call battleVMsEqual. Current impl throws TypeError.
    // Fixed impl: treats undefined as "no weather" (same as null) → returns true.
    //
    // WHY IT MATTERS: the production path is safe (buildBattleViewModel always sets
    // weather=null), but any future test factory or direct VM construction that omits
    // the weather field will silently crash battleVMsEqual. The loose-equality fix
    // closes this gap at negligible cost.
    //
    // Kills: any impl that uses `=== null` for the weather null-check in battleVMsEqual
    // (both the early-return and the mixed-null guard).
    const vmBase = makeFullVM();
    // Simulate a VM built without the weather field (e.g., from a test factory
    // that predates m14.5d). We must use `as` to bypass TypeScript's required field.
    const vmUndefinedWeather = { ...vmBase } as BattleViewModel;
    delete (vmUndefinedWeather as Record<string, unknown>).weather;

    // Both VMs have weather=undefined. Must return true (no weather === no weather),
    // not throw TypeError: Cannot read properties of undefined (reading 'label').
    expect(() => battleVMsEqual(vmUndefinedWeather, vmUndefinedWeather)).not.toThrow();
    expect(battleVMsEqual(vmUndefinedWeather, vmUndefinedWeather)).toBe(true);
  });

  it('GATING: battleVMsEqual(vmWithWeather, vmWithUndefinedWeather) → false, no throw', () => {
    // If one VM has active weather and the other has undefined weather, they must
    // NOT compare as equal (weather present ≠ no weather). Must not throw.
    // Kills: an impl where the mixed null/undefined check silently falls through.
    const vmWithWeather = makeFullVM({
      weather: { tag: 'Rain', turnsRemaining: 2 },
    } as Partial<StoreBattle>);
    const vmBase = makeFullVM();
    const vmUndefinedWeather = { ...vmBase } as BattleViewModel;
    delete (vmUndefinedWeather as Record<string, unknown>).weather;

    expect(() => battleVMsEqual(vmWithWeather, vmUndefinedWeather)).not.toThrow();
    expect(battleVMsEqual(vmWithWeather, vmUndefinedWeather)).toBe(false);
  });
});

// =============================================================================
// m14.5d-1b — cureItems in BattleViewModel (classify-by-data, bait-selector pattern)
// SOURCE OF TRUTH: specs/monster-realm-v2/M14.5-eighth-review-residuals.spec.md §14.5d-1
//
// RED REASON: BattleViewModel does not yet have a `cureItems` field; buildBattleViewModel
// does not yet accept a 5th arg; CureItem type does not yet exist in battleModel.ts.
// All tests below will fail until the implementer adds:
//   - `interface CureItem { itemId: number; name: string; cureStatus: string; count: number; }`
//   - `cureItems: readonly CureItem[]` on BattleViewModel
//   - 5th arg `cureItems: readonly CureItem[] = []` to buildBattleViewModel
//   - classify-by-data filter: cureStatus !== null && count > 0, only when battle is ongoing
//   - cureItems comparison in battleVMsEqual
//
// Classify-by-data rule (mirroring bait-selector): inclusion is decided by
// `cureStatus !== null` on the item — never by a hardcoded item id.
// =============================================================================

/** Minimal CureItem stub used in tests (typed via type assertion below). */
interface CureItemStub {
  itemId: number;
  name: string;
  cureStatus: string | null;
  count: number;
}

// =============================================================================
// RT-CI-01 — CureItem.cureStatus runtime null-filter invariant (red-team gating)
//
// FINDING (red-team m14.5d-1b): CureItem.cureStatus is typed as `string` (non-null),
// so the filter `c.cureStatus !== null` in buildBattleViewModel is vacuous at the TS
// type level. However, the model defends at RUNTIME against a caller that passes a
// null cureStatus via an `as never` cast (i.e. bypassing the type system). This test
// locks that runtime behavior so a future refactor that removes the null check does
// NOT accidentally let null-cureStatus items leak into the VM.
//
// The test uses `as never` intentionally — it is the only way to represent a runtime
// scenario where the field is null despite the type contract. The `as never` pattern
// is the established project convention for defense-in-depth runtime probes.
// =============================================================================
describe('battleModel RT-CI-01: cureItems null-cureStatus runtime filter invariant', () => {
  it('GATING: item with null cureStatus is excluded even when passed via as-never cast', () => {
    // Kills: any future refactor that removes the `c.cureStatus !== null` runtime
    // check from buildBattleViewModel, assuming the type contract is sufficient.
    // The type contract (cureStatus: string) does NOT protect against a runtime null
    // from an untyped source (e.g., a future SDK version that sends null directly).
    const b = makeBattle({ outcome: 'Ongoing' });
    const withNull: CureItemStub[] = [
      { itemId: 1, name: 'Antidote', cureStatus: 'Poison', count: 2 }, // valid
      { itemId: 2, name: 'Mystery', cureStatus: null, count: 1 }, // null cureStatus
    ];
    const vm = buildBattleViewModel(
      b,
      makeSkillMap(1),
      makeSpeciesMap(speciesRow(1)),
      [],
      withNull as never,
    );
    expect(vm).not.toBeNull();
    const cureItems = (vm as Record<string, unknown>).cureItems as CureItemStub[];
    // Only the non-null cureStatus item must appear; the null one must be filtered out.
    expect(cureItems).toHaveLength(1);
    expect(cureItems[0]!.itemId).toBe(1);
    // Kills: an impl that removes the `c.cureStatus !== null` check trusting the type alone.
  });

  it('GATING: item with null cureStatus AND count=0 is doubly excluded (both guards fire)', () => {
    // Verifies that even if both guards are removed one at a time, this test still catches
    // the regression: the null-cureStatus item must be excluded regardless of count.
    const b = makeBattle({ outcome: 'Ongoing' });
    const input: CureItemStub[] = [{ itemId: 3, name: 'BadItem', cureStatus: null, count: 0 }];
    const vm = buildBattleViewModel(
      b,
      makeSkillMap(1),
      makeSpeciesMap(speciesRow(1)),
      [],
      input as never,
    );
    expect(vm).not.toBeNull();
    const cureItems = (vm as Record<string, unknown>).cureItems as CureItemStub[];
    expect(cureItems).toHaveLength(0);
  });
});

describe('battleModel m14.5d-1b: buildBattleViewModel — cureItems classify-by-data', () => {
  it('BITES: only items with cureStatus !== null AND count > 0 appear in cureItems', () => {
    // Kills: an impl that lists all inventory items regardless of cureStatus,
    // or that includes zero-count items (items the player doesn't own).
    const b = makeBattle({ outcome: 'Ongoing' });
    const cureItemsInput: CureItemStub[] = [
      { itemId: 1, name: 'Antidote', cureStatus: 'Poison', count: 2 },
      { itemId: 2, name: 'Potion', cureStatus: null, count: 5 }, // not a cure item
    ];
    const vm = buildBattleViewModel(
      b,
      makeSkillMap(1),
      makeSpeciesMap(speciesRow(1)),
      [],
      cureItemsInput as never,
    );
    expect(vm).not.toBeNull();
    const cureItems = (vm as Record<string, unknown>).cureItems as CureItemStub[];
    expect(cureItems).toHaveLength(1);
    expect(cureItems[0]!.itemId).toBe(1);
    // Kills: an impl that lists all items regardless of cureStatus
  });

  it('BITES: item with cureStatus set but count === 0 is excluded from cureItems', () => {
    // Kills: an impl that filters by cureStatus but forgets the count > 0 guard
    // (would show items the player doesn't actually own).
    const b = makeBattle({ outcome: 'Ongoing' });
    const cureItemsInput: CureItemStub[] = [
      { itemId: 1, name: 'Antidote', cureStatus: 'Poison', count: 0 }, // owned: none
    ];
    const vm = buildBattleViewModel(
      b,
      makeSkillMap(1),
      makeSpeciesMap(speciesRow(1)),
      [],
      cureItemsInput as never,
    );
    expect(vm).not.toBeNull();
    const cureItems = (vm as Record<string, unknown>).cureItems as CureItemStub[];
    expect(cureItems).toHaveLength(0);
    // Kills: an impl that shows the cure item even when count is 0
  });

  it('BITES: cureItems is empty when battle is not ongoing (outcome SideAWins)', () => {
    // Kills: an impl that surfaces cure items on the outcome screen.
    // The cure-item action is only valid during an ongoing battle.
    const b = makeBattle({ outcome: 'SideAWins' });
    const cureItemsInput: CureItemStub[] = [
      { itemId: 1, name: 'Antidote', cureStatus: 'Poison', count: 3 },
    ];
    const vm = buildBattleViewModel(
      b,
      makeSkillMap(1),
      makeSpeciesMap(speciesRow(1)),
      [],
      cureItemsInput as never,
    );
    expect(vm).not.toBeNull();
    const cureItems = (vm as Record<string, unknown>).cureItems as CureItemStub[];
    expect(cureItems).toHaveLength(0);
    // Kills: an impl that gates only on cureStatus/count but ignores outcome
  });

  it('BITES: cureItems defaults to empty array when 5th arg is omitted', () => {
    // Kills: an impl that crashes or returns undefined when the optional 5th arg is absent.
    // The default must be [] (empty array), not undefined.
    const b = makeBattle({ outcome: 'Ongoing' });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm).not.toBeNull();
    const cureItems = (vm as Record<string, unknown>).cureItems;
    // Must be an empty array — not undefined, not null, not throwing
    expect(Array.isArray(cureItems)).toBe(true);
    expect((cureItems as unknown[]).length).toBe(0);
    // Kills: an impl that omits the default arg or returns undefined for cureItems
  });
});

describe('battleModel m14.5d-1b: battleVMsEqual — cureItems comparison', () => {
  it('BITES: cureItems array presence differs (one empty, one non-empty) → not equal', () => {
    // Kills: an impl that omits cureItems from the comparison
    // (a cure item being added/removed from inventory must re-render the selector).
    const b = makeBattle({
      battleId: 10n,
      turnNumber: 2,
      outcome: 'Ongoing',
      weather: null,
      sideA: {
        active: 0,
        team: [battleMonster({ speciesId: 1, currentHp: 30, maxHp: 40, knownSkillIds: [1, 2] })],
      },
      sideB: { active: 0, team: [battleMonster({ speciesId: 2, currentHp: 20, maxHp: 35 })] },
      opponentMonsterIds: [],
    } as Partial<StoreBattle>);
    const skillMap = new Map([
      [1, skillRow(1, { name: 'Ember', power: 40 })],
      [2, skillRow(2, { name: 'Tackle', power: 35 })],
    ]);
    const sMap = makeSpeciesMap(speciesRow(1, 'Flameling'), speciesRow(2, 'Aqualing'));
    // One VM: no cure items; other VM: one cure item
    const cureItemNone: CureItemStub[] = [];
    const cureItemOne: CureItemStub[] = [
      { itemId: 5, name: 'Antidote', cureStatus: 'Poison', count: 1 },
    ];
    const vmA = buildBattleViewModel(b, skillMap, sMap, [], cureItemNone as never);
    const vmB = buildBattleViewModel(b, skillMap, sMap, [], cureItemOne as never);
    expect(vmA).not.toBeNull();
    expect(vmB).not.toBeNull();
    expect(battleVMsEqual(vmA!, vmB!)).toBe(false);
    // Kills: an impl that omits cureItems from battleVMsEqual
  });

  it('BITES: cureItems count differs for same itemId → not equal (inventory change must re-render)', () => {
    // The count must be part of the comparison — the UI shows how many you own.
    // Kills: an impl that compares itemId but ignores count.
    const b = makeBattle({
      battleId: 10n,
      turnNumber: 2,
      outcome: 'Ongoing',
      weather: null,
      sideA: {
        active: 0,
        team: [battleMonster({ speciesId: 1, currentHp: 30, maxHp: 40, knownSkillIds: [1, 2] })],
      },
      sideB: { active: 0, team: [battleMonster({ speciesId: 2, currentHp: 20, maxHp: 35 })] },
      opponentMonsterIds: [],
    } as Partial<StoreBattle>);
    const skillMap = new Map([
      [1, skillRow(1, { name: 'Ember', power: 40 })],
      [2, skillRow(2, { name: 'Tackle', power: 35 })],
    ]);
    const sMap = makeSpeciesMap(speciesRow(1, 'Flameling'), speciesRow(2, 'Aqualing'));
    const cureItemCountTwo: CureItemStub[] = [
      { itemId: 5, name: 'Antidote', cureStatus: 'Poison', count: 2 },
    ];
    const cureItemCountOne: CureItemStub[] = [
      { itemId: 5, name: 'Antidote', cureStatus: 'Poison', count: 1 },
    ];
    const vmA = buildBattleViewModel(b, skillMap, sMap, [], cureItemCountTwo as never);
    const vmB = buildBattleViewModel(b, skillMap, sMap, [], cureItemCountOne as never);
    expect(vmA).not.toBeNull();
    expect(vmB).not.toBeNull();
    expect(battleVMsEqual(vmA!, vmB!)).toBe(false);
    // Kills: an impl that skips the count field in cureItems comparison
  });
});

// --- m16b: isPvp / pvpPendingSubmit / pvpOpponentName (ADR-0110) -----------------

describe('buildBattleViewModel: isPvp detection', () => {
  it('isPvp=false when opponentIdentity equals playerIdentity (wild/PvE: same placeholder)', () => {
    // Wild battle: server sets opponentIdentity = playerIdentity (ADR-0045).
    const b = makeBattle({
      playerIdentity: 'alice',
      opponentIdentity: 'alice',
      opponentMonsterIds: [],
    });
    const sMap = makeSpeciesMap(speciesRow(1));
    const vm = buildBattleViewModel(b, makeSkillMap(1), sMap);
    expect(vm?.isPvp).toBe(false);
    // Kills: an impl that sets isPvp=true for wild battles
  });

  it('isPvp=true when playerIdentity !== opponentIdentity and opponentMonsterIds is non-empty', () => {
    const b = makeBattle({
      playerIdentity: 'alice',
      opponentIdentity: 'bob',
      opponentMonsterIds: [99n],
    });
    const sMap = makeSpeciesMap(speciesRow(1));
    const vm = buildBattleViewModel(b, makeSkillMap(1), sMap);
    expect(vm?.isPvp).toBe(true);
    // Kills: an impl that uses opponentMonsterIds.length to detect PvP
  });

  it('canFlee=false in PvP battles', () => {
    const b = makeBattle({
      playerIdentity: 'alice',
      opponentIdentity: 'bob',
      outcome: 'Ongoing',
      opponentMonsterIds: [99n],
    });
    const sMap = makeSpeciesMap(speciesRow(1));
    const vm = buildBattleViewModel(b, makeSkillMap(1), sMap);
    expect(vm?.canFlee).toBe(false);
    // Kills: an impl that allows flee in PvP
  });
});

describe('buildBattleViewModel: pvpPendingSubmit', () => {
  it('pvpPendingSubmit=false when isPvp=false regardless of pvpPendingSubmit arg', () => {
    // Non-PvP battle: pvpPendingSubmit arg is ignored
    const b = makeBattle({ playerIdentity: 'alice', opponentIdentity: 'alice' });
    const sMap = makeSpeciesMap(speciesRow(1));
    const vm = buildBattleViewModel(b, makeSkillMap(1), sMap, [], [], true, null);
    expect(vm?.pvpPendingSubmit).toBe(false);
    // Kills: an impl that passes pvpPendingSubmit through even for wild/PvE
  });

  it('pvpPendingSubmit=true when isPvp=true and pvpPendingSubmit arg is true', () => {
    const b = makeBattle({
      playerIdentity: 'alice',
      opponentIdentity: 'bob',
      opponentMonsterIds: [99n],
    });
    const sMap = makeSpeciesMap(speciesRow(1));
    const vm = buildBattleViewModel(b, makeSkillMap(1), sMap, [], [], true, null);
    expect(vm?.pvpPendingSubmit).toBe(true);
    // Kills: an impl that ignores the pvpPendingSubmit argument
  });

  it('pvpPendingSubmit=false when isPvp=true but arg is false', () => {
    const b = makeBattle({
      playerIdentity: 'alice',
      opponentIdentity: 'bob',
      opponentMonsterIds: [99n],
    });
    const sMap = makeSpeciesMap(speciesRow(1));
    const vm = buildBattleViewModel(b, makeSkillMap(1), sMap, [], [], false, null);
    expect(vm?.pvpPendingSubmit).toBe(false);
  });
});

describe('buildBattleViewModel: pvpOpponentName', () => {
  it('pvpOpponentName=null when not a PvP battle', () => {
    const b = makeBattle({ playerIdentity: 'alice', opponentIdentity: 'alice' });
    const sMap = makeSpeciesMap(speciesRow(1));
    const vm = buildBattleViewModel(b, makeSkillMap(1), sMap, [], [], false, 'SomeName');
    expect(vm?.pvpOpponentName).toBeNull();
    // Kills: an impl that leaks opponent name to wild battles
  });

  it('pvpOpponentName is set when isPvp=true', () => {
    const b = makeBattle({
      playerIdentity: 'alice',
      opponentIdentity: 'bob',
      opponentMonsterIds: [99n],
    });
    const sMap = makeSpeciesMap(speciesRow(1));
    const vm = buildBattleViewModel(b, makeSkillMap(1), sMap, [], [], false, 'Bob');
    expect(vm?.pvpOpponentName).toBe('Bob');
    // Kills: an impl that ignores the pvpOpponentName argument
  });
});

describe('battleVMsEqual: PvP fields', () => {
  function pvpBattle(overrides: Partial<StoreBattle> = {}): StoreBattle {
    return makeBattle({
      playerIdentity: 'alice',
      opponentIdentity: 'bob',
      opponentMonsterIds: [99n],
      ...overrides,
    });
  }

  it('BITES: isPvp toggle makes VMs unequal', () => {
    const b = pvpBattle();
    const sMap = makeSpeciesMap(speciesRow(1));
    const vmPvp = buildBattleViewModel(b, makeSkillMap(1), sMap);
    const bPve = makeBattle({
      playerIdentity: 'alice',
      opponentIdentity: 'alice',
      opponentMonsterIds: [],
    });
    const vmPve = buildBattleViewModel(bPve, makeSkillMap(1), sMap);
    expect(vmPvp).not.toBeNull();
    expect(vmPve).not.toBeNull();
    expect(battleVMsEqual(vmPvp!, vmPve!)).toBe(false);
    // Kills: an impl that omits isPvp from battleVMsEqual
  });

  it('BITES: pvpPendingSubmit toggle makes VMs unequal', () => {
    const b = pvpBattle();
    const sMap = makeSpeciesMap(speciesRow(1));
    const vmA = buildBattleViewModel(b, makeSkillMap(1), sMap, [], [], false, null);
    const vmB = buildBattleViewModel(b, makeSkillMap(1), sMap, [], [], true, null);
    expect(vmA).not.toBeNull();
    expect(vmB).not.toBeNull();
    expect(battleVMsEqual(vmA!, vmB!)).toBe(false);
    // Kills: an impl that omits pvpPendingSubmit from battleVMsEqual
  });

  it('BITES: pvpOpponentName change makes VMs unequal', () => {
    const b = pvpBattle();
    const sMap = makeSpeciesMap(speciesRow(1));
    const vmA = buildBattleViewModel(b, makeSkillMap(1), sMap, [], [], false, 'Bob');
    const vmB = buildBattleViewModel(b, makeSkillMap(1), sMap, [], [], false, 'Alice');
    expect(vmA).not.toBeNull();
    expect(vmB).not.toBeNull();
    expect(battleVMsEqual(vmA!, vmB!)).toBe(false);
    // Kills: an impl that omits pvpOpponentName from battleVMsEqual
  });
});

// ---------------------------------------------------------------------------
// ptc5e e-3 — isPvpBattle canonical export (ADR-0110 seam)
//
// RED state: isPvpBattle is NOT yet exported from ./battleModel.
//   → import-resolve error (TS2305 / vitest resolution failure) — all three
//     tests below are red for this reason today.
//
// Contract: isPvpBattle({ opponentMonsterIds, opponentIdentity, playerIdentity })
//   returns true iff identities differ AND opponentMonsterIds is non-empty.
//   This matches the PvP detection rule in ADR-0110 and the `isPvp` field logic
//   already exercised via buildBattleViewModel above — this suite pins the
//   standalone exported function that other modules (e.g. battleView) will call
//   directly without constructing a full ViewModel.
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

describe('battleModel m23-s8: statusBadge unknown-tag fallback is visible', () => {
  it('m23s8 badge is non empty and not the fallback for every known status', () => {
    // ANCHOR FIRST (the m14.5d idiom): an empty or missing `variants` array must FAIL here,
    // never vacuously satisfy the loop below.
    const variants = (StatusEffect.algebraicType.value as { variants: Array<{ name: string }> })
      .variants;
    expect(
      variants.length,
      'm23s8 ANCHOR: StatusEffect must expose exactly 5 generated variants. An empty array ' +
        'would make every per-variant assertion below vacuous',
    ).toBe(5);
    expect(
      variants.map((v) => v.name),
      'm23s8 ANCHOR: the generated variant list must still contain a known member',
    ).toContain('Poison');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const v of variants) {
        const badge = statusBadge(v.name);
        expect(
          badge.length,
          `m23s8: statusBadge("${v.name}") must be non-empty — a blank badge is read by a ` +
            'player as "this monster has no status effect", which is a lie about game state',
        ).toBeGreaterThan(0);
        expect(
          badge.length,
          `m23s8: statusBadge("${v.name}") must be at most 3 characters — the badge is a pill ` +
            'rendered inside the monster card and a longer label overflows it',
        ).toBeLessThanOrEqual(3);
      }

      // THE UNIVERSAL TOOTH. Once the default arm returns a visible token, `length > 0` no
      // longer distinguishes a curated badge from a fallback — MEASURED: deleting
      // `case 'Poison':` goes from REDding 2 tests to 118/118 GREEN. The default arm warns, so
      // a deleted case is observable regardless of what string it returns.
      expect(
        warnSpy,
        'm23s8: statusBadge must not warn for ANY current StatusEffect variant. A warning ' +
          'means that variant fell through to the unknown-tag default arm — i.e. the map has a ' +
          'gap that the visible fallback would otherwise hide',
      ).not.toHaveBeenCalled();

      // THE SHADOW CENSUS — the second, warn-independent oracle. It kills an implementation
      // that keeps the visible fallback but drops the console.warn.
      const shadowed = variants
        .filter((v) => statusBadge(v.name) === unknownStatusToken(v.name))
        .map((v) => v.name)
        .sort();
      expect(
        shadowed,
        'm23s8 SHADOW CENSUS: NO curated badge may be byte-identical to the unknown-tag ' +
          'fallback, which is why the fallback carries a leading "?" that no curated token ' +
          'has. A name appearing here means its case was deleted from statusBadge and the ' +
          "fallback is now wearing that curated badge's clothes. Do NOT repair a failure " +
          'here by widening the expected array — that absorbs the deletion this clause exists ' +
          'to catch',
      ).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('m23s8 badge falls back visibly for an unknown status tag', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const curse = statusBadge('Curse');
      expect(
        curse.length,
        'm23s8: an unknown status tag must still produce a VISIBLE badge. Returning the empty ' +
          'string makes a poisoned monster indistinguishable from a healthy one — that is the ' +
          'whole defect this criterion closes',
      ).toBeGreaterThan(0);
      expect(
        curse.length,
        'm23s8: the fallback token is capped at 3 characters so it fits the same pill as a ' +
          'curated badge',
      ).toBeLessThanOrEqual(3);
      expect(
        curse,
        'm23s8: the fallback token must already be upper-case, like every curated badge — a ' +
          'mixed-case token reads as a different kind of thing on screen',
      ).toBe(curse.toUpperCase());
      expect(
        curse,
        'm23s8: statusBadge must return exactly the token unknownStatusToken names. The ' +
          'exported helper exists so a test can name the expected fallback without ' +
          're-implementing the transform (and thereby testing only itself)',
      ).toBe(unknownStatusToken('Curse'));
      expect(
        warnSpy,
        'm23s8: the default arm must STILL console.warn. The visible fallback is a player-side ' +
          'repair, not a reason to stop surfacing a missing bindings regen at development time',
      ).toHaveBeenCalledTimes(1);

      // DERIVATION, not a constant. Kills a fallback that returns one shared literal (e.g.
      // '???') for every unknown tag: visible, capped, upper-case, and identical for two
      // different server variants, so the badge stops distinguishing them.
      const hex = statusBadge('Hex');
      expect(
        hex,
        'm23s8: two DIFFERENT unknown tags must produce two DIFFERENT tokens — the fallback is ' +
          'derived from the tag, never one shared placeholder constant',
      ).not.toBe(curse);
      expect(
        hex,
        'm23s8: the second unknown tag must also route through unknownStatusToken, so the one ' +
          'export is the sole source of the fallback value for every tag the map does not know',
      ).toBe(unknownStatusToken('Hex'));
      expect(warnSpy, 'm23s8: each unknown lookup warns once').toHaveBeenCalledTimes(2);

      // THE OTHER SIDE OF THE BOUNDARY. Absence of a status is NOT an unknown tag: it must
      // still map to '' so `statusBadge(...) || null` at battleModel.ts:196 yields null and the
      // view renders no pill at all.
      expect(
        statusBadge(null),
        'm23s8: a monster with NO status must still map to the empty string — a fallback that ' +
          'fires on absence would stamp a badge on every healthy monster in the game',
      ).toBe('');
      expect(statusBadge(undefined), 'm23s8: undefined is absence, not an unknown tag').toBe('');
      expect(statusBadge(''), 'm23s8: the empty tag is absence, not an unknown tag').toBe('');
      expect(
        warnSpy,
        'm23s8: absence must not warn — the warn is reserved for a genuine bindings gap, and a ' +
          'warning on every healthy monster would drown it',
      ).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('m23s8 badge survives the view model chain for an unknown status tag', () => {
    // WHY THIS GOES THROUGH buildBattleViewModel AND NOT THE VIEW. MEASURED:
    // battleView.test.ts:32 imports BattleViewModel as a TYPE only and hand-builds every VM, so
    // it contains zero live calls to buildBattleViewModel. A badge test written on the view
    // side never exercises the real chain — statusBadge → `... || null` (battleModel.ts:196) →
    // `if (card.status)` (battleView.ts:277) — and would pass with this fix reverted, because
    // the hand-built VM supplies the non-null status the production path fails to produce.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const b = makeBattle({
        sideA: battleSide({
          active: 0,
          team: [battleMonster({ speciesId: 1, status: { tag: 'Curse' } })],
        }),
      } as Partial<StoreBattle>);
      const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
      expect(vm, 'm23s8: an unknown status tag must not sink the view model').not.toBeNull();
      expect(
        vm!.playerCard.status,
        'm23s8 CHAIN: vm.playerCard.status must NOT be null for an unknown status tag. This is ' +
          'the single assertion the whole criterion turns on: the "|| null" coercion at ' +
          'battleModel.ts:196 converts an EMPTY fallback into null, and the card.status gate at ' +
          'battleView.ts:277 then renders no badge element at all — so a monster carrying a ' +
          'server-side status the client has not learned about yet looks perfectly healthy',
      ).not.toBeNull();
      expect(
        typeof vm!.playerCard.status,
        'm23s8 CHAIN: the propagated status must be a STRING — not a boolean or a number that ' +
          'happens to be truthy at the card.status gate in the view',
      ).toBe('string');
      expect(
        (vm!.playerCard.status as string).length,
        'm23s8 CHAIN: the propagated badge must be non-empty',
      ).toBeGreaterThan(0);
      expect(
        vm!.playerCard.status,
        'm23s8 CHAIN: the propagated badge must be exactly the fallback token, proving the VM ' +
          'carried the value through rather than substituting some placeholder of its own',
      ).toBe(unknownStatusToken('Curse'));

      // CONTROL PROBE — proves the assertion above is not tautological. The SAME chain, with a
      // monster that has no status at all, must still yield null. Without this, an
      // implementation that hardcoded a non-null status on every card would pass.
      const bNone = makeBattle();
      const vmNone = buildBattleViewModel(bNone, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
      expect(vmNone, 'm23s8 CONTROL: the no-status battle must still build').not.toBeNull();
      expect(
        vmNone!.playerCard.status,
        'm23s8 CONTROL: a monster with NO status must still map to null, so the assertion ' +
          'above is about the fallback and not about "status is always non-null"',
      ).toBeNull();

      // The KNOWN path must be untouched by the fallback change.
      const bKnown = makeBattle({
        sideA: battleSide({
          active: 0,
          team: [battleMonster({ speciesId: 1, status: { tag: 'Poison' } })],
        }),
      } as Partial<StoreBattle>);
      const vmKnown = buildBattleViewModel(bKnown, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
      expect(
        vmKnown!.playerCard.status,
        'm23s8 REGRESSION: a KNOWN status tag must still map to its curated badge, not to the ' +
          'fallback token — the visible default arm must not have swallowed the switch',
      ).toBe('PSN');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// =============================================================================
// rb-55 — statusBadge and A11Y_TOKENS are ONE contract, mechanically linked
// SOURCE OF TRUTH: residual R-m23-s8-TSDUP, recorded at docs/adr/0233-*.md:179-182
// ("nothing correlates the two tables"). Do NOT cite content.rs:1621-1625 for that
// claim — this slice rewrote those lines, and they now say the opposite.
//
// The five status tokens are hand-written TWICE: as `A11yToken` rows inside
// `pub const A11Y_TOKENS` (game-core/src/content.rs:1692) and as `case` arms in
// `statusBadge` (client/src/ui/battleModel.ts). Each side pins its OWN literals
// and, BEFORE this block existed, was perfectly green while disagreeing with the other
// (measured: 4 of the 5 tokens). This block reads the Rust const at runtime and compares
// it to what statusBadge RETURNS, so a drift in EITHER direction is now red.
//
// THIS IS NOT A THIRD TRANSCRIPTION. No token literal appears anywhere below, and
// the keys are derived from the generated StatusEffect roster rather than listed.
// The oracle is deliberately the RETURN VALUE, never a constant battleModel.ts
// merely contains: three mutants survive a "does the file contain the string"
// oracle with the whole suite green — an early `if (tag === 'Poison') return 'POI';`
// above the switch, a parallel unwired copy of the map, and `.toLowerCase()` on the
// returned token.
// =============================================================================

/** The a11y token SSOT, resolved from this spec's own URL (no cwd dependence). */
const RB55_CONTENT_RS_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'game-core',
  'src',
  'content.rs',
);

/** Region anchor for the shipped table. A LOCATION, not a value — carries no token. */
const RB55_TOKENS_ANCHOR = 'pub const A11Y_TOKENS: &[A11yToken] = &[';

/**
 * One `A11yToken { key: "status.x", token: "…" }` struct literal in any rustfmt shape
 * (the shipped rows are broken across four lines; a one-line row must match too).
 *
 * Struct-literal form ONLY, and `status.` keys ONLY. Both restrictions are load-bearing:
 * content.rs also carries a TUPLE-form copy of the same pairs (`M23S8_EXPECTED_PAIRS` at
 * :7516, rows shaped `("status.poison", <token>),`) which this pattern must never match,
 * and the eight `affinity.*` rows in the const are deliberately unconsumed by the client.
 *
 * No token VALUE is written anywhere in this block — not in code, not in a comment. This
 * test asserts a relation between two hand-copies; it must not become hand-copy number 3.
 */
/** As RB55_STATUS_ROW but for ANY key family — the totality clause counts rows it can parse
 *  against `A11yToken {` openers, so it must not restrict itself to `status.`. */
const RB55_ANY_ROW =
  /A11yToken\s*\{\s*key\s*:\s*"([a-z]+\.[A-Za-z0-9_]+)"\s*,\s*token\s*:\s*"([^"\n]*)"\s*,?\s*\}/g;

const RB55_STATUS_ROW =
  /A11yToken\s*\{\s*key\s*:\s*"(status\.[A-Za-z0-9_]+)"\s*,\s*token\s*:\s*"([^"\n]*)"\s*,?\s*\}/g;

/** Appended to every failure below: the repair is always bilateral. */
const RB55_ONE_CONTRACT =
  'game-core/src/content.rs (A11Y_TOKENS — the SSOT) and client/src/ui/battleModel.ts ' +
  '(statusBadge — the mirror) are ONE contract: repair BOTH files, never one. Editing ' +
  'only the side this test names just moves the drift.';

/** The trap that makes "just change the Rust token" the wrong repair. */
const RB55_CEILING =
  'CEILING CONTRADICTION — read before choosing a side to edit: A11Y_TOKEN_MAX_LEN is 4 ' +
  '(game-core/src/content.rs:1749) but the badge pill caps every token at 3 characters ' +
  '(client/src/ui/battleModel.test.ts:2033). A 4-character Rust token is therefore legal ' +
  'in content.rs and has NO legal client repair — shorten the token, do not widen the pill.';

/**
 * Read the SSOT, or FAIL LOUD naming the resolved path (the indexShell.test.ts:99-106
 * idiom). Never `?? ''`, never an existsSync guard, never it.skip: a swallowed read turns
 * this whole gate into a permanently green no-op the day the crate moves.
 */
function rb55ReadContentRs(): string {
  try {
    return readFileSync(RB55_CONTENT_RS_PATH, 'utf8');
  } catch (err) {
    throw new Error(
      `rb-55: the a11y token SSOT could not be read at ${RB55_CONTENT_RS_PATH} — ${err}. ` +
        `Every assertion in this block is vacuous without it. ${RB55_ONE_CONTRACT}`,
    );
  }
}

describe('battleModel rb-55: statusBadge is mechanically linked to A11Y_TOKENS (content.rs)', () => {
  it('rb55 every StatusEffect variant badge equals its A11Y_TOKENS row token', () => {
    // ONE `it` ON PURPOSE. MEASURED: a sibling anti-vacuity `it` is a one-line CI-clean
    // deletion, after which the parity assertion below passes 1/1 comparing [] to [].
    // Every anchor therefore lives HERE, above the toEqual it protects.
    //
    // Kills (in clause order):
    //  1. anchor index      — a whole-file or wrongly-anchored scan; a doc comment that
    //                         steers the region slice off the const.
    //  2. terminator index  — an unterminated / re-shaped const body.
    //  3. variants length   — an empty generated roster making the map/compare vacuous.
    //  4. key census        — a Rust row added, deleted, renamed or duplicated; a region
    //                         slice that picked up the out-of-const test fixtures.
    //  5. the toEqual       — ANY value drift, in either direction, including the three
    //                         mutants a contains-the-constant oracle cannot see.
    const src = rb55ReadContentRs();

    const anchorAt = src.indexOf(RB55_TOKENS_ANCHOR);
    expect(
      anchorAt,
      `rb55 ANCHOR: the literal \`${RB55_TOKENS_ANCHOR}\` was not found in ` +
        `${RB55_CONTENT_RS_PATH}. There is then no region to parse and every assertion ` +
        'below is vacuous. KNOWN FALSE-RED PATH: the region is sliced from the FIRST ' +
        'occurrence of that literal, so a doc comment that QUOTES the anchor verbatim ' +
        '(the A11yToken struct docs at :1618 and the table docs at :1685 both sit above ' +
        'the const) steers the slice at the comment instead of the table. If you just ' +
        'edited prose above A11Y_TOKENS, that is the cause — describe the const, do not ' +
        `quote its opening line. ${RB55_ONE_CONTRACT}`,
    ).toBeGreaterThanOrEqual(0);

    // MEASURED BYPASS, DO NOT REMOVE. The slice as first written took the FIRST match and
    // asserted nothing about how many there were. A red-team pass then shipped a decoy that
    // defeated the whole gate with the ENTIRE CI green (client 3119 passed, cargo nextest
    // 2238 passed, evals 99 PASS): a `pub const A11Y_TOKENS_SNIPPET: &str = r#"..."#` raw
    // string placed above the real const, reproducing the anchor line AND a line-initial
    // `];` of its own. The region then slices over the decoy's stale rows, and the shipped
    // table is free to drift. A raw string is never touched by the `//` strip below, so
    // comment-handling cannot help here — only counting can.
    expect(
      src.split(RB55_TOKENS_ANCHOR).length - 1,
      'rb55 ANCHOR UNIQUENESS: the const-opening literal must occur EXACTLY ONCE in ' +
        'content.rs. A second occurrence — a raw string, a block comment, a doc line that ' +
        'quotes it — steers the region slice off the shipped table, and a decoy carrying ' +
        'its own line-initial `];` passes every clause below while the real const drifts. ' +
        'This was MEASURED to defeat the entire gate with all of CI green. Describe the ' +
        `const in prose; never reproduce its opening line. ${RB55_ONE_CONTRACT}`,
    ).toBe(1);

    // The const body ends at the first line-initial `];` at or after the anchor.
    const endAt = src.indexOf('\n];', anchorAt);
    expect(
      endAt,
      'rb55 ANCHOR: no line-initial `];` terminates the A11Y_TOKENS body after the anchor, ' +
        'so the region slice would be empty and the census below trivially satisfiable. ' +
        `${RB55_ONE_CONTRACT}`,
    ).toBeGreaterThan(anchorAt);

    // Strip `//`-to-end-of-line INSIDE the region: `///` doc lines and `//` notes between
    // rows must not be parsed as data, and a commented-out row must not count as shipped.
    const region = src.slice(anchorAt, endAt).replace(/\/\/[^\n]*/g, '');

    const variants = (StatusEffect.algebraicType.value as { variants: Array<{ name: string }> })
      .variants;
    expect(
      variants.length,
      'rb55 ANCHOR: StatusEffect must expose exactly 5 generated variants. An empty roster ' +
        'makes BOTH sides of the parity toEqual below the empty array, which is the exact ' +
        'shape in which this gate stops gating anything.',
    ).toBe(5);
    expect(
      variants.map((v) => v.name),
      'rb55 ANCHOR: the generated variant roster must still contain a known member.',
    ).toContain('Poison');

    // MEASURED BYPASS, DO NOT REMOVE. RB55_STATUS_ROW proves a row is WRITTEN, not that it is
    // COMPILED, and it only recognises one spelling. A red-team pass shipped, with all of CI
    // green: a `#[cfg(any())]`-disabled copy of the correct row (visible to this regex, never
    // compiled) beside the real row spelled `key: concat!("status.", "burn")` (compiled,
    // invisible to this regex). The two clauses below close that pair — the first makes every
    // `A11yToken {` opener in the region have to parse, the second bans the attribute/macro
    // escape hatch outright. Both MUST stay above the contract assertion.
    const rowOpeners = region.match(/A11yToken\s*\{/g) ?? [];
    const allParsedRows = [...region.matchAll(RB55_ANY_ROW)];
    expect(
      allParsedRows.length,
      'rb55 TOTALITY: every `A11yToken {` inside the const body must parse as a literal ' +
        'key/token pair. A row this parse cannot see — fields reordered, `concat!`, a const ' +
        'reference, a raw string — is a row the compiler still ships and this gate would ' +
        `silently ignore. ${RB55_ONE_CONTRACT}`,
    ).toBe(rowOpeners.length);
    expect(
      region,
      'rb55 TOTALITY: no attribute or macro may appear inside the A11Y_TOKENS body. A ' +
        '`#[cfg(...)]`-disabled row is visible to this parse and invisible to the compiler, ' +
        `which is a shipped drift this gate would report as clean. ${RB55_ONE_CONTRACT}`,
    ).not.toMatch(/#\[|cfg!\(/);
    expect(
      region,
      'rb55 TOTALITY: no block-comment delimiter may appear inside the A11Y_TOKENS body. ' +
        'The stripper below removes `//` to end-of-line only, so a `/* ... */` row would be ' +
        `parsed as shipped data. ${RB55_ONE_CONTRACT}`,
    ).not.toMatch(/\/\*|\*\//);

    const rustRows = [...region.matchAll(RB55_STATUS_ROW)];
    const rustByKey = new Map(rustRows.map((m) => [m[1], m[2]]));

    // KEY CENSUS — the row SET, before any token value is looked at. Keys are derived from
    // the roster, never listed here.
    const foundKeys = rustRows.map((m) => m[1]).sort();
    const wantedKeys = variants.map((v) => `status.${v.name.toLowerCase()}`).sort();
    expect(
      foundKeys,
      'rb55 CENSUS: the `status.*` rows inside A11Y_TOKENS must be exactly one row per ' +
        'generated StatusEffect variant — no extra row, no missing row, no duplicate key. ' +
        'A MISMATCH IS USUALLY REAL DRIFT, but check the region slice first: content.rs has ' +
        '17 occurrences of `A11yToken {` and FOUR are OUTSIDE this const (the struct ' +
        'definition at :1627 and the test fixtures at :7819, :8017, :8039). The :7819 ' +
        'fixture deliberately ships a WRONG token for `status.burn`, so a whole-file scan ' +
        'false-REDs on it — never widen this parse past the const body to make a failure go ' +
        `away. ${RB55_ONE_CONTRACT}`,
    ).toEqual(wantedKeys);

    const rustTokenFor = (name: string): string => {
      const key = `status.${name.toLowerCase()}`;
      return rustByKey.get(key) ?? `<A11Y_TOKENS has no ${key} row>`;
    };

    // THE CONTRACT. The left side is what statusBadge RETURNS; the right side is what the
    // Rust table SAYS. Nothing is compared to a literal in this file, which is the point:
    // this test asserts a RELATION between two hand-written copies rather than becoming a
    // third hand-written copy of the same five strings.
    expect(
      variants.map((v) => [v.name, statusBadge(v.name)]).sort(),
      'rb55 CONTRACT: statusBadge() must RETURN, for every generated StatusEffect variant, ' +
        'byte-exactly the token that variant\'s row carries in A11Y_TOKENS. The "actual" ' +
        'side is the live return value of `statusBadge` in client/src/ui/battleModel.ts; the "expected" ' +
        'side is parsed from game-core/src/content.rs:1692. A screen reader announces the ' +
        'Rust token while the sighted pill renders the client one, so a drift here is two ' +
        `players being told two different things about the same monster. ${RB55_ONE_CONTRACT} ` +
        `${RB55_CEILING}`,
    ).toEqual(variants.map((v) => [v.name, rustTokenFor(v.name)]).sort());

    // MEASURED GAP, DO NOT REMOVE. The assertion above stops at the pure function; production
    // reads the badge through monsterCard (`status: statusBadge(...) || null`), and a red-team
    // pass shipped `statusBadge(mon.status?.tag).replace('BRN', 'BUR')` at that hop with the
    // WHOLE client suite green (3119 passed) — the view model carried a token the SSOT never
    // authorised. Re-run the same comparison through buildBattleViewModel so the value a card
    // actually carries is bound to the Rust table too, not just the function's return.
    expect(
      variants
        .map((v) => {
          const vm = buildBattleViewModel(
            makeBattle({
              sideA: battleSide({
                active: 0,
                team: [battleMonster({ speciesId: 1, status: { tag: v.name } })],
              }),
            } as Partial<StoreBattle>),
            makeSkillMap(1),
            makeSpeciesMap(speciesRow(1)),
          );
          return [v.name, vm?.playerCard.status ?? '<no view model>'];
        })
        .sort(),
      'rb55 CONTRACT (view-model chain): the badge a BattleMonsterCardVM actually carries must ' +
        'be byte-exactly the token A11Y_TOKENS ships for that variant. The assertion above ' +
        "binds statusBadge's return; this one binds what monsterCard propagates, so a rewrite " +
        'between the two — a .replace(), a truncation, a re-map — cannot ship a badge the SSOT ' +
        'never authorised. NOT COVERED, by declared scope: the final DOM hop at ' +
        `battleView.ts:290 (\`statusEl.textContent = card.status\`). ${RB55_ONE_CONTRACT}`,
    ).toEqual(variants.map((v) => [v.name, rustTokenFor(v.name)]).sort());
  });
});

// =============================================================================
// rb-58 — the unknown-status fallback token must spend the entropy its 3-character
// budget allows, on EVERY code point of the tag
//
// SOURCE OF TRUTH: residual R-m23-s8-postmerge-fallback (the harness slice ledger)
// == R-m23-s8-FALLBACK-COLLIDE (docs/adr/0233-a11y-colour-independence-token-ssot.md:195).
// BOTH ids are real: the first is the harness-side ledger name, the second the ADR-side
// name, and they denote ONE residual. Neither is a typo and neither is fabricated — do
// not "correct" either spelling to the other (that mis-edit has been made before).
//
// THE DEFECT. The shipped fallback derived its two payload characters from the first
// two code points of the tag only, so any two unknown server statuses sharing a
// two-code-point prefix rendered the SAME badge — a systematic, guessable collision
// (`Confusion` / `Corrosion`, `Pestilence` / `Pestilent`, and so on). The badge's job
// during deployed-server / stale-bundle skew is to prove a status EXISTS *and* to keep
// two unknown statuses distinguishable (battleModel.ts:44-49); a prefix-only derivation
// discharges only the first half.
//
// WHAT THIS SUITE DOES AND DOES NOT CLAIM. Three characters hold at most 1296 tokens
// after the leading '?', so nothing here claims the fallback is injective over all
// possible tags — that is pigeonhole-impossible and asserting it would make the suite
// unsatisfiable. It claims something weaker and achievable: every code point of the tag
// feeds the token, so collisions become unpredictable rather than systematic on a
// shared prefix, and the token space is used broadly rather than clustered.
//
// NOT A TRANSCRIPTION. No expected token VALUE is written anywhere below — not in code,
// not in a comment. Every oracle is a RELATION (distinctness, shape, determinism,
// pairwise inequality) computed from the live return value, so this block cannot become
// a second hand-written copy of the derivation that an implementer "repairs" instead of
// repairing battleModel.ts. Likewise the dead prefix-only transform is never given a
// name: it appears exactly once, inline, inside the anti-vacuity assertion that needs it.
// =============================================================================

/**
 * Seventeen tags that are NOT StatusEffect variants (so every one of them reaches the
 * `default:` arm of statusBadge) and that deliberately cluster on shared two-code-point
 * prefixes. The clustering is the whole point: it is what makes the distinctness clauses
 * in T1 falsifiable. Chosen so the dead prefix-only transform collapses them to far fewer
 * than 17 buckets while a whole-tag derivation keeps all 17 apart.
 */
const RB58_CORPUS: readonly string[] = [
  'Confusion',
  'Corrosion',
  'Curse',
  'Curdle',
  'Cruse',
  'Xurse',
  'Blight',
  'Blightx',
  'Blighty',
  'Bleed',
  'Petrify',
  'Pestilence',
  'Pestilent',
  'Slow',
  'Slime',
  'Frostbite',
  'Frenzy',
];

/** Appended to every rb-58 failure: where the repair goes, and where it does NOT go. */
const RB58_REPAIR =
  'THE REPAIR IS ALWAYS IN client/src/ui/battleModel.ts (unknownStatusToken), never in ' +
  'this file. Do not edit the corpus, lower a floor, widen a regex, or delete a clause to ' +
  'make this green — each of those absorbs exactly the defect the clause exists to catch. ' +
  'Residual R-m23-s8-postmerge-fallback == R-m23-s8-FALLBACK-COLLIDE (ADR-0233:195).';

/** Scope disclaimer carried by the distinctness clauses so they are not over-read. */
const RB58_NO_UNIQUENESS_CLAIM =
  'SCOPE: this is NOT a uniqueness claim over all tags — a 3-character budget holds at ' +
  'most 1296 tokens, so collisions must remain possible. It is a claim that collisions ' +
  'are not SYSTEMATIC on a shared prefix, which is what made the shipped fallback useless ' +
  'for exactly the skew case it exists to serve.';

/** The implementation under scan, resolved from this spec's own URL (no cwd dependence) —
 *  the same idiom RB55_CONTENT_RS_PATH uses above, pointed at a sibling file. */
const RB58_IMPL_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'battleModel.ts');

/** Region anchor for the derivation. A LOCATION, not a value — carries no token. */
const RB58_FN_ANCHOR = 'export function unknownStatusToken';

/**
 * Read the implementation, or FAIL LOUD naming the resolved path (the rb55ReadContentRs
 * idiom above). Never `?? ''`, never an existsSync guard, never it.skip: a swallowed read
 * turns the whole source-scan tier into a permanently green no-op.
 */
function rb58ReadImplSrc(): string {
  try {
    return readFileSync(RB58_IMPL_PATH, 'utf8');
  } catch (err) {
    throw new Error(
      `rb58: the implementation under scan could not be read at ${RB58_IMPL_PATH} — ${err}. ` +
        `Every assertion in the source-scan test is vacuous without it. ${RB58_REPAIR}`,
    );
  }
}

/**
 * Remove comments from TypeScript source in ONE left-to-right pass that ALSO recognises
 * string and template literals — so a comment delimiter appearing inside a literal can
 * never open or close a comment.
 *
 * MEASURED BYPASS THIS CLOSES, DO NOT SIMPLIFY BACK: a two-step stripper (one regex for
 * block comments, then a second for line comments) is desynchronised FROM INSIDE the
 * scanned code by planting `const open = <a single-quoted block-comment opener>;` and a
 * matching closer a few lines later. The first regex then deletes everything between them
 * — including an environment fork and its `return` — and every clause downstream inspects
 * a doctored region while the shipped bundle carries the defect. Here the literal
 * alternatives are tried at the same positions as the comment alternatives, so the planted
 * opener is consumed as the string it is.
 *
 * (This doc block deliberately spells no comment delimiter and no regex source: a stray
 * two-character sequence in here would close this very comment and corrupt the file.)
 *
 * String contents are PRESERVED, not blanked: an ambient read hidden inside a template
 * literal's `${...}` must remain visible to the file-wide purity census below.
 *
 * ASSUMPTIONS, true of the file under scan and pinned by the clauses in T4: no regex
 * literal (a `/` starting a regex could be read as a comment opener) and no nested
 * template literal. Both are checked indirectly — a mis-scan drops the export signatures
 * or the surviving-delimiter clause fires.
 */
function rb58StripComments(text: string): string {
  return text.replace(
    /'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (m) => (m.startsWith('/') ? '' : m),
  );
}

describe('rb58 unknown-status fallback token entropy', () => {
  it('rb58 T1 seventeen prefix-clustered unknown tags get seventeen distinct badges', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // ANCHOR 0 — the guidance itself. MEASURED GUT: both message constants can be
      // emptied to '' with byte-identical pass/fail behaviour, which silently deletes
      // every repair instruction AND both residual ids while the suite stays green. A
      // failure message is part of the gate, so it gets asserted like one.
      expect(
        RB58_REPAIR,
        'rb58 T1 ANCHOR: the shared repair guidance must still name the residual. Emptying ' +
          'it changes no test outcome and destroys the only in-file record of what this ' +
          'suite is for.',
      ).toContain('R-m23-s8-FALLBACK-COLLIDE');
      expect(
        RB58_REPAIR,
        'rb58 T1 ANCHOR: the shared repair guidance must still name the harness-side id too ' +
          '— both names are real and denote one residual.',
      ).toContain('R-m23-s8-postmerge-fallback');
      expect(
        RB58_REPAIR.length,
        'rb58 T1 ANCHOR: the repair guidance must still be substantive prose, not a stub.',
      ).toBeGreaterThan(200);
      expect(
        RB58_NO_UNIQUENESS_CLAIM,
        'rb58 T1 ANCHOR: the scope disclaimer must still state the size of the token space, ' +
          'so a reader cannot mistake the distinctness clauses below for a uniqueness claim.',
      ).toContain('1296');
      expect(
        RB58_NO_UNIQUENESS_CLAIM.length,
        'rb58 T1 ANCHOR: the scope disclaimer must still be substantive prose, not a stub.',
      ).toBeGreaterThan(150);

      // ANCHOR 1 — the corpus itself. An emptied or shortened corpus would make every
      // distinctness clause below satisfiable by a constant function.
      expect(
        RB58_CORPUS.length,
        'rb58 T1 ANCHOR: the corpus must still hold exactly 17 tags. Deleting members is ' +
          'the cheapest way to make the distinctness clauses below pass without fixing ' +
          `anything — a 1-tag corpus is trivially "all distinct". ${RB58_REPAIR}`,
      ).toBe(17);

      // ANCHOR 2 — every corpus member must actually REACH the default arm. Derived from
      // the generated roster, never a hand-listed set of variant names.
      const curated = (
        StatusEffect.algebraicType.value as { variants: Array<{ name: string }> }
      ).variants.map((v) => v.name);
      expect(
        curated.length,
        'rb58 T1 ANCHOR: StatusEffect must expose exactly 5 generated variants; an empty ' +
          'roster makes the "no corpus member is curated" check below vacuous.',
      ).toBe(5);
      expect(
        RB58_CORPUS.filter((t) => curated.includes(t)),
        'rb58 T1 ANCHOR: no corpus member may be a real StatusEffect variant. A member that ' +
          'IS curated returns its curated badge instead of the fallback, so it silently ' +
          'stops exercising unknownStatusToken at all. If a bindings regen just added a ' +
          'variant whose name collides with a corpus member, RENAME THE CORPUS MEMBER to ' +
          `another prefix-sharing invented tag — do not delete it. ${RB58_REPAIR}`,
      ).toEqual([]);

      // ANTI-VACUITY — stated as a property OF THE CORPUS, not as a named reproduction of
      // the dead transform (a named copy would be a third artefact an implementer could
      // "repair" instead of repairing the impl). Keeping only the first two code points
      // collapses these 17 tags to 8 buckets; that collapse is what the distinctness
      // clauses below are falsifiable AGAINST. If this number ever equalled 17, the
      // clauses below would be satisfied by literally any injective-on-this-corpus
      // function — including the defect — and would gate nothing.
      expect(
        new Set(RB58_CORPUS.map((t) => [...t].slice(0, 2).join('').toUpperCase())).size,
        'rb58 T1 ANTI-VACUITY: the corpus must still COLLAPSE (to 8 buckets) under a ' +
          'two-code-point prefix. This number being 17 — i.e. not fewer than 17 — means the ' +
          'corpus no longer contains any prefix-sharing pair, and the distinctness clauses ' +
          'below would then be satisfied by the very implementation this slice replaces. ' +
          'THE REPAIR IS NEVER TO EDIT THE CORPUS: this clause exists precisely to catch ' +
          `an edit that de-clusters it. ${RB58_REPAIR}`,
      ).toBe(8);

      // THE HELPER. 17 tags in, 17 distinct tokens out.
      //
      // MEASURED LAUNDERING GUT, WHICH IS WHY THE TOKENS ARE BOUND AND SHAPE-CHECKED
      // FIRST: changing the mapped expression from `unknownStatusToken(t)` to
      // `unknownStatusToken(t) + t` makes both distinctness counts 17 on the UNFIXED
      // implementation — the tag itself supplies the entropy the derivation lacks — and
      // the IDENTITY clause below still passes because both of its sides launder
      // identically. Counting a set of values nobody checked the SHAPE of counts nothing.
      // The shape clause is what makes the count a statement about the BADGE.
      //
      // MEASURED on the landing implementation: 17 distinct helper tokens, 17 distinct
      // badges, 0 malformed on either side.
      const helperTokens = RB58_CORPUS.map((t) => unknownStatusToken(t));
      expect(
        helperTokens.filter((t) => !/^\?[0-9A-Z]{2}$/.test(t)),
        'rb58 T1 SHAPE: every value counted below must be a real fallback token — "?" plus ' +
          'two upper-case base-36 digits. A row here means the counted values are not the ' +
          'badges the player sees: either the derivation is malformed, or this test is ' +
          'counting something with the tag concatenated onto it, in which case the ' +
          `distinctness count below is measuring the corpus and not the code. ${RB58_REPAIR}`,
      ).toEqual([]);
      expect(
        new Set(helperTokens).size,
        'rb58 T1: 17 unknown tags that share two-code-point prefixes must produce 17 ' +
          'DISTINCT fallback tokens. A number well below 17 (8, for the shipped ' +
          'prefix-only transform) means two different server statuses render the same ' +
          'badge purely because their names start alike — the player sees one label for ' +
          'two conditions, which is the defect ADR-0233:195 records. The expected value is ' +
          'RB58_CORPUS.length BY CONSTRUCTION: writing a literal here (8, say) is a retune, ' +
          'not a repair, and contradicts the two anchors above. ' +
          `${RB58_NO_UNIQUENESS_CLAIM} ${RB58_REPAIR}`,
      ).toBe(RB58_CORPUS.length);

      // THE BADGE. Load-bearing, and NOT implied by the clause above. MEASURED BYPASS, DO
      // NOT REMOVE: a red-team pass left unknownStatusToken honest and truncated the tag at
      // the CALL SITE instead — `return unknownStatusToken([...tag].slice(0, 5).join(''))`
      // in the default arm of statusBadge. Every helper-only clause stayed green while
      // `Pestilence` and `Pestilent` (identical for 5 code points) collided on screen. The
      // badge is what the player actually reads, so the badge is what must be distinct.
      const badgeTokens = RB58_CORPUS.map((t) => statusBadge(t));
      expect(
        badgeTokens.filter((t) => !/^\?[0-9A-Z]{2}$/.test(t)),
        'rb58 T1 SHAPE (badge): every badge counted below must itself be a well-formed ' +
          'fallback token, for the same reason as the helper clause above — an unshaped ' +
          `count is laundering waiting to happen. ${RB58_REPAIR}`,
      ).toEqual([]);
      expect(
        new Set(badgeTokens).size,
        'rb58 T1 BADGE: the value statusBadge RETURNS must be distinct for all 17 tags, not ' +
          'merely the value unknownStatusToken returns. MEASURED: truncating the tag at the ' +
          'statusBadge call site keeps the helper perfectly honest and still ships colliding ' +
          'badges for two tags with a long shared prefix. Never repair this by loosening the ' +
          `count; the default arm must pass the WHOLE tag through. ${RB58_REPAIR}`,
      ).toBe(RB58_CORPUS.length);

      // ...and the two must be the SAME value for EVERY member (the shipped m23s8 test
      // pins this for one tag only). Kills a default arm that post-processes, re-maps or
      // re-truncates the helper's output for some tags but not others.
      expect(
        RB58_CORPUS.filter((t) => statusBadge(t) !== unknownStatusToken(t)),
        'rb58 T1 IDENTITY: for every unknown tag, statusBadge must return byte-exactly ' +
          'unknownStatusToken(tag). A name listed here is a tag whose badge was rewritten ' +
          'between the helper and the default arm — a .replace(), a re-slice, a special ' +
          'case — so the exported helper is no longer the single source of the fallback ' +
          `value the player sees. ${RB58_REPAIR}`,
      ).toEqual([]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rb58 T2 every code point of the tag feeds the token', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // EVERY PAIR PINS ITS OWN DISCRIMINATING STRUCTURE — `lenA`/`lenB` (in CODE POINTS)
      // and `diffAt`, the first index at which the two differ, or -1 when one is a proper
      // prefix of the other. MEASURED GUT THIS CLOSES: rewriting pair 1 from
      // "299 x's then a y" to "a y then 299 x's" makes the whole of T2 green on the
      // UNFIXED implementation (only pair 1 is red today), while `pairs.length` and the
      // now-lying `label`/`kills` prose survive untouched. With the structure pinned, a
      // pair edited to differ somewhere else reds on `diffAt` instead of going quiet.
      const pairs: ReadonlyArray<{
        readonly a: string;
        readonly b: string;
        readonly label: string;
        readonly kills: string;
        readonly lenA: number;
        readonly lenB: number;
        readonly diffAt: number;
      }> = [
        {
          // Kills: prefix truncation at EVERY k, and drop-the-last-code-point. Two tags
          // that agree on the first 299 code points and differ only in the 300th.
          // MEASURED: a red-team truncation at k=9 survived a `Status${i}` corpus, because
          // 'Status199' is exactly 9 code points long — a corpus-shaped tooth cannot see a
          // truncation whose cut point sits past the corpus's own tag lengths. This pair
          // has no cut point that works.
          a: `${'x'.repeat(299)}y`,
          b: 'x'.repeat(300),
          label: 'two 300-code-point tags differing only in the LAST code point',
          kills:
            'a derivation that stops after the first k code points (for ANY k), or that ' +
            'drops the final code point. MEASURED: truncating at k=9 passed a corpus of ' +
            '9-character tags; only an unbounded-length pair like this one can see it',
          lenA: 300,
          lenB: 300,
          diffAt: 299,
        },
        {
          // Kills: a suffix-only derivation. MEASURED: under a multiplier-36 mutant these
          // two hash identically, because 36 is a multiple of the base the digits are read
          // in and the leading code point's contribution vanishes modulo the space size.
          a: 'Curse',
          b: 'Xurse',
          label: 'two tags differing only in the FIRST code point',
          kills:
            'a suffix-only derivation, and a rolling hash whose multiplier annihilates the ' +
            'leading term (MEASURED: multiplier 36 makes exactly this pair collide while ' +
            'the whole 17-tag corpus above still separates)',
          lenA: 5,
          lenB: 5,
          diffAt: 0,
        },
        {
          // Kills: an order-invariant accumulator (sum / xor / bitwise-or of code points),
          // which spreads tokens beautifully and still gives every anagram one badge.
          a: 'AB',
          b: 'BA',
          label: 'two tags that are anagrams of each other',
          kills:
            'an order-invariant accumulator — a plain sum, xor or bitwise-or of the code ' +
            'points passes every corpus and every spread floor while collapsing all ' +
            'anagrams onto one badge',
          lenA: 2,
          lenB: 2,
          diffAt: 0,
        },
        {
          // Kills: charCodeAt substituted for codePointAt. MEASURED: under that mutant both
          // of these hash identically, because a UTF-16 code unit read only sees the shared
          // high surrogate of the two astral characters. This is the behavioural half of
          // the source-scan clause in T4.
          a: '\u{1F600}',
          b: '\u{1F601}',
          label: 'two adjacent astral (non-BMP) tags',
          kills:
            'reading UTF-16 code units instead of code points (charCodeAt for codePointAt) ' +
            '— MEASURED: both of these then hash to the same value because they share a ' +
            'high surrogate, so the badge cannot tell two emoji-named statuses apart',
          lenA: 1,
          lenB: 1,
          diffAt: 0,
        },
        {
          // Kills: FIXED-ARITY FEATURE SAMPLING — a derivation that reads only a bounded
          // set of positions, e.g. (length, first, middle, last). MEASURED: such a
          // derivation passes all four pairs above BY CONSTRUCTION (each of them differs
          // in length, first, or last) while ignoring 297 of 300 code points on a long
          // tag, and it collapses `Corrosion`, `Cordosion` and `Corposion` onto ONE token.
          // This pair differs at index 3 ONLY — not at 0 (first), not at 8 (last), not at
          // 4 (middle of nine) — so no bounded sample of endpoints can separate it. It is
          // the pair that falsifies this test's own title, and therefore the one to keep
          // if you are ever tempted to prune the table.
          a: 'Corrosion',
          b: 'Cordosion',
          label: 'two 9-code-point tags differing ONLY at interior index 3',
          kills:
            'a fixed-arity feature sample — reading only (length, first, middle, last), or ' +
            'any other bounded set of positions, instead of folding over every code point ' +
            '(MEASURED: those three 9-letter tags all render one token under such a scheme)',
          lenA: 9,
          lenB: 9,
          diffAt: 3,
        },
        {
          // Kills: a DEDUPLICATING derivation, e.g. folding over `new Set(tag)` — which
          // looks like a reasonable "normalise the input" step and is invisible to every
          // pair above. MEASURED: it renders Poison, Poisonn, Poisson and Poiison as one
          // token. `Poison` IS a curated variant, which is irrelevant here: T2 calls the
          // HELPER directly, so the switch in statusBadge never runs. That is deliberate —
          // the tag space the fallback must survive is the server's, not this bundle's.
          a: 'Poison',
          b: 'Poisonn',
          label: 'a tag and the same tag with its final code point repeated',
          kills:
            'a deduplicating derivation (folding over the SET of code points) and any ' +
            'other multiplicity-blind normalisation — repetition is information, and a ' +
            'server variant name may differ from another only by a doubled letter',
          lenA: 6,
          lenB: 7,
          diffAt: -1,
        },
        {
          // Kills: an ASCII case-fold (`tag.toLowerCase()` / `toUpperCase()` before the
          // fold). Case-folding the INPUT is a different thing from upper-casing the
          // OUTPUT (which the token format requires): the first destroys entropy the
          // server may be using, the second only formats what survived.
          a: 'Curse',
          b: 'curse',
          label: 'two tags differing only in the CASE of their first code point',
          kills:
            'a case-fold of the INPUT before the fold. Upper-casing the OUTPUT token is ' +
            'required and fine; upper- or lower-casing the TAG throws away a distinction ' +
            'the server is entitled to make between two variant names',
          lenA: 5,
          lenB: 5,
          diffAt: 0,
        },
      ];

      expect(
        pairs.length,
        'rb58 T2 ANCHOR: all seven discriminating pairs must still be present. Each kills a ' +
          'different wrong derivation and none of the others covers it — truncation at any ' +
          'k, suffix-only folding, order-invariance, code-unit reads, fixed-arity feature ' +
          `sampling, deduplication, and input case-folding. ${RB58_REPAIR}`,
      ).toBe(7);

      for (const { a, b, label, kills, lenA, lenB, diffAt } of pairs) {
        // STRUCTURE PINS, ABOVE THE BEHAVIOURAL CLAUSE. These say what this pair IS, so
        // the pair cannot be quietly rewritten into an easier one that the unfixed
        // implementation already separates (MEASURED on pair 1; see the table comment).
        const cpA = [...a];
        const cpB = [...b];
        expect(
          cpA.length,
          `rb58 T2 STRUCTURE (${label}): the first member must still be ${lenA} code points ` +
            'long. A changed length means the pair is no longer the one whose comment ' +
            `explains it, and the mutant named there is no longer covered. ${RB58_REPAIR}`,
        ).toBe(lenA);
        expect(
          cpB.length,
          `rb58 T2 STRUCTURE (${label}): the second member must still be ${lenB} code ` +
            `points long. ${RB58_REPAIR}`,
        ).toBe(lenB);
        expect(
          cpA.findIndex((c, i) => c !== cpB[i]),
          `rb58 T2 STRUCTURE (${label}): these two tags must still first differ at code ` +
            `point index ${diffAt} (-1 meaning one is a proper prefix of the other). WHERE ` +
            'they differ is the entire point of the pair: moving the difference to another ' +
            'position turns a discriminating pair into one the defect already separates, ' +
            'which is a MEASURED way to make this whole test green without changing the ' +
            `implementation at all. ${RB58_REPAIR}`,
        ).toBe(diffAt);

        const ta = unknownStatusToken(a);
        const tb = unknownStatusToken(b);
        // ANCHOR per pair: a pair that silently degenerated into two undefineds, two empty
        // strings, or two thrown-away values must not be able to satisfy the inequality
        // below by accident.
        expect(
          ta,
          `rb58 T2 ANCHOR (${label}): the first member must still produce a full 3-character ` +
            'token. A short or absent token here means the inequality below would be ' +
            `comparing garbage rather than two real badges. ${RB58_REPAIR}`,
        ).toHaveLength(3);
        expect(
          tb,
          `rb58 T2 ANCHOR (${label}): the second member must still produce a full ` +
            `3-character token. ${RB58_REPAIR}`,
        ).toHaveLength(3);
        expect(
          ta,
          `rb58 T2 (${label}): these two tags must NOT share a badge. This clause kills ` +
            `${kills}. ${RB58_NO_UNIQUENESS_CLAIM} A collision on THIS pair is never an ` +
            'unlucky pigeonhole hit — it is a structural blindness in the derivation, ' +
            `because the two tags differ by construction in exactly one place. ${RB58_REPAIR}`,
        ).not.toBe(tb);
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rb58 T3 the token is total, structurally invariant and deterministic', async () => {
    const cases: readonly string[] = [
      // The EMPTY tag. This case, and only this case, hashes below the base so its
      // unpadded rendering is a single digit — it is therefore the SOLE killer of a
      // dropped zero-pad, which would ship a 2-character badge where the pill and the
      // shipped `length <= 3` / `length > 0` clauses both expect 3.
      '',
      'A',
      // A character whose uppercase form is LONGER than itself ('ß' -> 'SS'):
      // the historical reason the old implementation needed a trailing cap at all.
      'ß',
      // Astral, and astral-plus-ASCII: a lone surrogate in the output would render as
      // U+FFFD in the badge pill.
      '\u{1F600}',
      '\u{1F600}x',
      'Curse',
      'Confusion',
      // Far longer than any real variant name — the derivation must not overflow, wrap to
      // NaN, or blow the 3-character budget on a long tag.
      'x'.repeat(300),
    ];
    expect(
      cases.length,
      'rb58 T3 ANCHOR: all 8 shape cases must still be present. Deleting the empty-tag or ' +
        'the astral case removes the only coverage of the zero-pad and the surrogate ' +
        `hazards respectively. ${RB58_REPAIR}`,
    ).toBe(8);

    const tokens = cases.map((t) => unknownStatusToken(t));

    // ANCHOR for the upper-case clause below. A token made only of digits satisfies
    // `t === t.toUpperCase()` vacuously, so a `.toLowerCase()` mutant would survive a
    // corpus that happened to hash to all-numeric tokens. At least one case must produce a
    // letter for the invariance clause to have any teeth at all.
    expect(
      tokens.some((t) => /[A-Z]/.test(t)),
      'rb58 T3 ANCHOR: at least one case must produce a token containing a LETTER. Every ' +
        'clause of the form `token === token.toUpperCase()` is vacuously true for an ' +
        'all-digit token, so without this anchor a derivation that lower-cased its output ' +
        `would pass the case-invariance clause below unchallenged. ${RB58_REPAIR}`,
    ).toBe(true);

    // ONE WHOLE-ARRAY ORACLE, NOT A LOOP. MEASURED ONE-CHARACTER GUT THIS CLOSES: with a
    // `for (let i = 0; …)` loop, changing the initialiser to `i = 5` made this test PASS on
    // the unfixed implementation — silently skipping the empty tag, 'A', the sharp s and
    // both astral cases, i.e. the only coverage of the zero-pad and surrogate hazards —
    // while the `cases.length === 8` anchor above happily reported 8. A single toEqual over
    // a census built from `cases` has no index to move: the expected side is derived from
    // the same array, so a skipped case is a missing ROW and reds immediately.
    const shapeCensus = tokens.map((token, i) => ({
      index: i,
      tag: JSON.stringify(cases[i] ?? '').slice(0, 24),
      length: token.length,
      wellFormed: /^\?[0-9A-Z]{2}$/.test(token),
      alreadyUpperCase: token === token.toUpperCase(),
    }));
    expect(
      shapeCensus,
      'rb58 T3 SHAPE CENSUS: for EVERY case the fallback must be 3 characters long, must ' +
        "match /^\\?[0-9A-Z]{2}$/ ('?' plus two upper-case base-36 digits), and must already " +
        'be upper-case. Read the diff by row: `wellFormed: false` with `length: 2` on the ' +
        'empty tag is a dropped zero-pad (that row is the ONLY case that exposes it); ' +
        '`wellFormed: false` with `length: 3` on an astral tag is a raw code point or a lone ' +
        'surrogate in the badge, which renders as U+FFFD; a length above 3 overflows the ' +
        'pill (upper-casing can LENGTHEN a string — the sharp-s row is why that is checked ' +
        'per case rather than argued from the format). Do NOT repair a failure here by ' +
        `deleting the offending row: every row is a hazard class. ${RB58_REPAIR}`,
    ).toEqual(
      cases.map((tag, i) => ({
        index: i,
        tag: JSON.stringify(tag).slice(0, 24),
        length: 3,
        wellFormed: true,
        alreadyUpperCase: true,
      })),
    );

    // DETERMINISM, tier 1: three calls in one process.
    const first = unknownStatusToken('Confusion');
    expect(
      [unknownStatusToken('Confusion'), unknownStatusToken('Confusion')],
      'rb58 T3 DETERMINISM: the same tag must produce the same token on every call. A ' +
        'badge that changes between two renders of the same battle tells the player the ' +
        `status changed when it did not. ${RB58_REPAIR}`,
    ).toEqual([first, first]);

    // DETERMINISM, tier 2: TWO FRESH MODULE INSTANCES WITH DIFFERENT CALL HISTORIES.
    //
    // MEASURED BYPASS THIS EXISTS FOR: a derivation seeded from a module-scope
    // `Math.random()`. Every call within one process agrees, so the three-call clause above
    // is structurally incapable of seeing it, while two browser tabs (or one reload) render
    // different badges for the same status.
    //
    // MEASURED WEAKNESS OF THE OBVIOUS VERSION, WHICH IS WHY THE ORDER IS PERTURBED: a
    // module-scope Map handing out tokens in FIRST-SEEN CALL ORDER passes a single
    // reset-and-reimport comparison, because the fresh instance is asked for 'Confusion'
    // first in both runs. It only reds by luck — through unrelated tests earlier in this
    // file consuming slots in the statically imported instance — which means `-t rb58`
    // alone would have missed it. Instance 1 is therefore deliberately given a DIFFERENT
    // call history from instance 2, and both are compared to the long-lived instance the
    // rest of this file has been using. Any state that survives a call now separates them.
    vi.resetModules();
    const m1 = await import('./battleModel');
    m1.unknownStatusToken('Zzz');
    m1.unknownStatusToken('Qqq');
    m1.unknownStatusToken('Zzz');
    const t1 = m1.unknownStatusToken('Confusion');

    vi.resetModules();
    const m2 = await import('./battleModel');
    const t2 = m2.unknownStatusToken('Confusion');

    expect(
      [t1, t2],
      'rb58 T3 DETERMINISM (fresh modules, different call histories): the token for one tag ' +
        'must not depend on which module instance asks, nor on what that instance was asked ' +
        'BEFORE. The three values compared here come from an instance that answered three ' +
        'other calls first, an instance asked this tag first, and the instance the rest of ' +
        'this file has been using all along. A mismatch means the derivation carries state ' +
        'or ambient entropy — a module-scope RNG seed, a first-seen-order allocation table, ' +
        'a memo keyed on something other than the tag — and the same status will render ' +
        'different badges in two browser tabs, or before and after a reload. The token is a ' +
        `pure function of the tag, of nothing else. ${RB58_REPAIR}`,
    ).toEqual([first, first]);
  });

  it('rb58 T4 the derivation reads only its argument — no env fork, no ambient entropy', () => {
    // WHY A SOURCE SCAN, WHEN EVERY OTHER TIER IS BEHAVIOURAL. This is the ONLY tier that
    // can see an ENVIRONMENT FORK. MEASURED BYPASS, DO NOT REMOVE: a red-team pass wrapped
    // the honest hash in `if (import.meta.env.PROD) { return <the old colliding transform>; }`.
    // vitest sets PROD false, so every behavioural test above ran the honest branch and was
    // green — while a real `vite build` tree-shook the bundle back to the exact defect this
    // slice exists to close. No runtime assertion in a test process can distinguish those
    // two builds; only reading the source can.
    //
    // MEASURED BYPASS 2, WHY THE PURITY BAN IS FILE-WIDE: the fork does not have to live in
    // the function. A red-team pass kept `unknownStatusToken` textually perfect — the honest
    // loop, exactly one `return`, no ambient name anywhere in its body — and moved the fork
    // into a module-scope helper it calls. A region-scoped scan sees nothing; the bundle
    // ships the defect. The blacklist below is therefore applied to the WHOLE stripped file.
    // That costs nothing: battleModel.ts is a pure view-model module (its own header at :1-4
    // declares "No DOM, no SDK, no side effects") and has ZERO legitimate uses of any banned
    // name. The region-scoped single-exit clause is kept as well — the two are complementary,
    // not redundant.
    //
    // MEASURED BYPASS 3, WHY THE STRIPPER IS A ONE-PASS SCANNER: a two-step stripper is
    // desynchronised from INSIDE the scanned code by planting a block-comment opener and
    // closer as ordinary string literals, deleting the fork and its `return` before either
    // clause runs. See rb58StripComments — string literals are consumed as strings and
    // PRESERVED, so an ambient read hidden inside a template literal stays visible too.
    const src = rb58ReadImplSrc();
    const strippedSrc = rb58StripComments(src);

    // FILE-LEVEL POSITIVE CONTROL. Every file-wide clause below is a "must not contain",
    // and a file that got blanked — by a stripper desync, a regex-literal mis-scan, a read
    // that returned something else — satisfies all of them perfectly. These two clauses are
    // what make the negatives mean anything at the file level.
    expect(
      [
        'export function unknownStatusToken',
        'export function statusBadge',
        'export function buildBattleViewModel',
      ].filter((sig) => !strippedSrc.includes(sig)),
      'rb58 T4 POSITIVE CONTROL (file): the stripped source must still contain every one of ' +
        'these top-level signatures. A name listed here means the comment strip ate live ' +
        'code — which is exactly what a planted comment delimiter is FOR — and every ' +
        `"must not contain" clause below would then pass vacuously. ${RB58_REPAIR}`,
    ).toEqual([]);
    expect(
      strippedSrc.length,
      'rb58 T4 POSITIVE CONTROL (file mass): stripping comments must not remove most of the ' +
        'file. A collapse to a fraction of the original is a desynchronised strip, not a ' +
        `well-commented module. ${RB58_REPAIR}`,
    ).toBeGreaterThan(src.length / 5);

    // NO COMMENT DELIMITER MAY SURVIVE THE STRIP. After a correct one-pass scan the only way
    // `/*` or `*/` can remain is inside a string literal — which is precisely the desync
    // payload. Green today; this is the tripwire for the planted-delimiter attack.
    expect(
      strippedSrc,
      'rb58 T4 STRIPPER INTEGRITY: no comment delimiter may survive the strip. Surviving ' +
        'delimiters mean one of two things, both bad: a real comment was not stripped (so ' +
        'the clauses below are reading prose as code), or a delimiter is sitting inside a ' +
        'STRING LITERAL — the MEASURED payload that desynchronises a naive stripper and ' +
        'deletes an environment fork from this scan before it can be seen. There is no ' +
        `legitimate reason for battleModel.ts to contain one. ${RB58_REPAIR}`,
    ).not.toMatch(/\/\*|\*\//);

    // THE FILE-WIDE PURITY CENSUS. This is the clause that closes the delegated fork.
    const ambient: ReadonlyArray<readonly [string, RegExp]> = [
      ['import.meta', /import\s*\.\s*meta/],
      ['process.env', /process\s*\.\s*env/],
      ['globalThis', /\bglobalThis\b/],
      ['Math.random', /Math\s*\.\s*random/],
      ['Date', /\bDate\b/],
      ['crypto', /\bcrypto\b/],
      ['window', /\bwindow\b/],
      ['navigator', /\bnavigator\b/],
    ];
    expect(
      ambient.filter(([, re]) => re.test(strippedSrc)).map(([name]) => name),
      'rb58 T4 PURITY (whole file): battleModel.ts must not read the environment ANYWHERE. ' +
        'Each name listed here is a way the badge can differ between two builds, two ' +
        'processes or two moments while every unit test in this file stays green: a ' +
        'build-mode fork (import.meta / process.env), a shared mutable seed (globalThis), ' +
        'ambient entropy (Math.random / Date / crypto), or a browser-environment fork ' +
        '(window / navigator). THE BAN IS FILE-WIDE ON PURPOSE — MEASURED: a fork delegated ' +
        'to a module-scope helper leaves unknownStatusToken textually spotless and still ' +
        'tree-shakes the original collision back into a production bundle. The module ' +
        'declares itself pure at :1-4; this clause holds it to that, so what this suite ' +
        `measures under vitest is what a player sees in a real build. ${RB58_REPAIR}`,
    ).toEqual([]);

    expect(
      src.split(RB58_FN_ANCHOR).length - 1,
      `rb58 T4 ANCHOR UNIQUENESS: the literal \`${RB58_FN_ANCHOR}\` must occur EXACTLY ONCE ` +
        `in ${RB58_IMPL_PATH}. The region below is sliced from the FIRST occurrence, so a ` +
        'second one — in a comment, a string, a re-export — steers the whole scan off the ' +
        'shipped function and every clause below then inspects something that is not the ' +
        `derivation. Describe the function in prose; never reproduce its signature line. ${RB58_REPAIR}`,
    ).toBe(1);

    const lines = src.split('\n');
    const startLine = lines.findIndex((l) => l.startsWith(RB58_FN_ANCHOR));
    expect(
      startLine,
      `rb58 T4 ANCHOR: no line in ${RB58_IMPL_PATH} begins with \`${RB58_FN_ANCHOR}\`, so ` +
        'there is no region to scan and every clause below is vacuous. The fallback helper ' +
        `must remain a top-level named export of that module. ${RB58_REPAIR}`,
    ).toBeGreaterThanOrEqual(0);

    let endLine = -1;
    for (let i = startLine + 1; i < lines.length; i++) {
      if ((lines[i] ?? '').trimEnd() === '}') {
        endLine = i;
        break;
      }
    }
    expect(
      endLine,
      'rb58 T4 ANCHOR: the function body must be terminated by a line that is exactly `}` at ' +
        'column 0. Without that terminator the region slice is empty or runs to end of file, ' +
        `and this scan stops being a statement about the derivation. ${RB58_REPAIR}`,
    ).toBeGreaterThan(startLine);

    // The region is sliced from the RAW source (so the line rule is about the file as
    // written) and then stripped with the SAME one-pass scanner, so the desync payload
    // cannot doctor it either.
    const region = rb58StripComments(lines.slice(startLine, endLine + 1).join('\n'));

    // REGION LIVENESS — deliberately SEPARATE from the code-point pin below. MEASURED GUT:
    // when one clause carried both jobs, swapping its needle to a spelling-agnostic one
    // ('tag') deleted the code-point pin while still looking like a positive control — and
    // the previous version of this comment openly invited that edit. Liveness is proven
    // here, by needles that say nothing about HOW the token is derived; the pin below is
    // then free to be strict.
    expect(
      region.trim().length,
      'rb58 T4 LIVENESS: the stripped region must be non-empty. An empty region satisfies ' +
        'every "must not contain" clause vacuously, so the scan would report clean on any ' +
        `implementation whatsoever. ${RB58_REPAIR}`,
    ).toBeGreaterThan(0);
    expect(
      region,
      'rb58 T4 LIVENESS: the stripped region must still contain live code (a `return`). ' +
        `If it does not, the region slice or the strip captured prose, not a function. ${RB58_REPAIR}`,
    ).toContain('return');
    expect(
      region.split('\n').filter((l) => l.trim().length > 0).length,
      'rb58 T4 LIVENESS: the stripped region must still have at least three non-blank lines ' +
        '(a signature, a body, a closing brace). A region reduced below that has been eaten ' +
        `by a mis-scan and proves nothing. ${RB58_REPAIR}`,
    ).toBeGreaterThanOrEqual(3);

    // THE CODE-POINT PIN. Not a liveness proof (that is settled above) — a statement about
    // the derivation: it must read CODE POINTS, not UTF-16 code units. T2's astral pair
    // kills the code-unit read behaviourally; this is its source-tier twin, and it is the
    // tier that still speaks when someone re-shapes the loop into something T2's two emoji
    // happen to survive. DO NOT swap this needle for a weaker one to make a failure go
    // away: if a rewrite genuinely reads whole code points by another spelling, that is a
    // deliberate, reviewed change to BOTH this clause and the comment above it — and the
    // landing implementation reads `(ch.codePointAt(0) ?? 0)`, with no non-null assertion,
    // so nothing here depends on a `!`.
    expect(
      region,
      'rb58 T4 CODE-POINT PIN: the derivation must read full code points (`codePointAt`), ' +
        'not UTF-16 code units. A code-unit read makes every pair of astral-named statuses ' +
        'that shares a high surrogate render one badge — the same class of systematic ' +
        'collision this whole slice exists to remove, just moved from the ASCII prefix to ' +
        'the surrogate prefix. This clause is a PIN, not a liveness control (liveness is ' +
        `proven separately above): do not weaken the needle, fix the derivation. ${RB58_REPAIR}`,
    ).toContain('codePointAt');

    // EXACTLY ONE `return`, region-scoped. Complementary to the file-wide purity census
    // above, not redundant with it: that one bans the ambient READS, this one bans the
    // second EXIT — a depth-0 early return needs no ambient name at all (a module-scope
    // `const LEGACY = …` reachable only in one build does the job).
    expect(
      (region.match(/\breturn\b/g) ?? []).length,
      'rb58 T4 SINGLE EXIT: the derivation must have EXACTLY ONE `return`. A second one is ' +
        'either a depth-0 early exit above the hash or the far branch of a fork — and ' +
        'MEASURED, the fork shape `if (<a build-mode flag>) { return <old transform>; }` ' +
        'kept every behavioural test in this file green (vitest evaluates the flag false) ' +
        'while the production bundle shipped the original collision. Do not repair this by ' +
        `inlining the branch into a ternary; repair it by deleting the branch. ${RB58_REPAIR}`,
    ).toBe(1);
  });

  it('rb58 T5 unseen tags spread across the token space', () => {
    // WHY THE INPUTS ARE NOT WRITTEN IN THIS FILE. MEASURED BYPASS, DO NOT REMOVE: a
    // red-team pass shipped a 220-row lookup table fitted to the named corpora, returning
    // one shared token for every tag not in the table. It passed every corpus-based clause
    // above — the corpora ARE the table's keys — and shipped a single badge for the entire
    // real world. Only inputs this file does not know can catch that. The seed is fixed, so
    // the draws are identical on every machine and every re-run: this is a deterministic
    // test with unwritten inputs, not a flaky one.
    const samples = fc.sample(fc.string({ minLength: 1 }), { numRuns: 300, seed: 58 });
    expect(
      samples.length,
      'rb58 T5 ANCHOR: 300 samples must be drawn. A shortened or empty sample set makes the ' +
        `shape census and the spread floor below trivially satisfiable. ${RB58_REPAIR}`,
    ).toBe(300);

    // THE DRAW ITSELF IS PINNED. MEASURED GUT: swapping the arbitrary for a tame one —
    // `fc.stringMatching(/^[A-Z]{2,8}$/)` — yields 238 distinct tokens on the UNFIXED
    // implementation, clearing the spread floor below and turning this whole test green
    // without touching the derivation. The two clauses here describe the INPUT DISTRIBUTION,
    // so a tamed generator reds before the impl is ever consulted. MEASURED on the real
    // seed-58 draw: 297 distinct inputs, 237 of them containing a non-alphanumeric
    // character, longest 12 characters.
    //
    // VERSION NOTE: the seed pins these values only while the fast-check version holds
    // (client/package-lock.json). A future fast-check bump can legitimately change the draw
    // — if these two clauses red together right after a dependency bump, that is the cause,
    // and the repair is to re-measure and re-record the values here (in the same commit as
    // the bump), never to delete the clauses.
    expect(
      new Set(samples).size,
      'rb58 T5 DRAW: the 300 drawn tags must be nearly all distinct (measured 297). A ' +
        'collapsed input set means the generator was swapped or narrowed, and the spread ' +
        `floor below would then be measuring the generator, not the derivation. ${RB58_REPAIR}`,
    ).toBeGreaterThanOrEqual(250);
    expect(
      samples.filter((s) => /[^A-Za-z0-9]/.test(s)).length,
      'rb58 T5 DRAW: at least half the drawn tags must contain a NON-ALPHANUMERIC character ' +
        '(measured 237 of 300). This is what makes the shape census below a real test: an ' +
        'alphanumeric-only generator can never produce the raw-punctuation badge that the ' +
        'prefix-slicing derivation ships, so a tamed generator would report the defect as ' +
        `clean. MEASURED: exactly that swap makes this test pass unfixed. ${RB58_REPAIR}`,
    ).toBeGreaterThanOrEqual(150);

    // SHAPE over unseen inputs. Slicing to the first 5 offenders is loss-free as a
    // predicate (the slice is empty iff the census is) and keeps the failure output
    // readable when a derivation is wrong for every input.
    const malformed = samples
      .filter((s) => !/^\?[0-9A-Z]{2}$/.test(unknownStatusToken(s)))
      .slice(0, 5)
      .map((s) => ({ tag: JSON.stringify(s).slice(0, 40), token: unknownStatusToken(s) }));
    expect(
      malformed,
      'rb58 T5 SHAPE: EVERY tag — not just the curated-looking ones in the corpora above — ' +
        "must yield '?' plus two upper-case base-36 digits. Each row here is a real string a " +
        'server could name a status and the unreadable badge it produced: raw punctuation, a ' +
        'lone surrogate, a lower-case character, or a short token from a dropped pad. The ' +
        'derivation must be TOTAL over strings, because the whole point of the fallback is ' +
        `tags this bundle has never seen. Showing at most 5 rows. ${RB58_REPAIR}`,
    ).toEqual([]);

    // SPREAD. 300 draws into 1296 slots collide by the birthday bound: the expected number
    // of distinct tokens is about 264, and 200 sits far below that — a wide, deliberately
    // non-tight floor so this can never flake, even though the seed already pins the draws.
    expect(
      new Set(samples.map((s) => unknownStatusToken(s))).size,
      'rb58 T5 SPREAD: 300 unseen tags must land on at least 200 distinct tokens. This ' +
        'floor is a MUTANT CATCHER, NOT A STATISTICAL CLAIM: 300 draws into the 1296 ' +
        'available tokens are expected to give about 264 distinct, so a healthy derivation ' +
        'clears 200 with enormous margin and only a structurally degenerate one falls ' +
        'below it — a lookup table with a shared default, a constant, a derivation keyed on ' +
        'the first character alone, or one whose payload space collapsed to a handful of ' +
        'values. LOWERING THIS FLOOR IS THE FORBIDDEN REPAIR: a number chosen to fit the ' +
        'measured value is a number that catches nothing. The draws are seeded, so a ' +
        `failure here is reproducible and is telling you about the derivation. ${RB58_REPAIR}`,
    ).toBeGreaterThanOrEqual(200);

    // THE IMAGE CENSUS — the clause that actually gates TOKEN-SPACE SIZE, and the reason
    // the 300-draw floor above is not enough on its own. MEASURED on the seed-58 300-draw,
    // varying only the modulus: 1296 -> 270 distinct, 1024 -> 257, 648 -> 242, 512 -> 223,
    // 400 -> 205, 324 -> 206. EVERY ONE of those clears 200 — i.e. a fourfold loss of
    // entropy, which is precisely this residual's subject, is invisible to a 300-draw floor
    // because 300 draws cannot distinguish a 1296-token space from a 400-token one.
    // Widening the draw is what separates them: with 3000 draws the image approaches the
    // space size. MEASURED at 3000 draws, seed 58: honest 1156 distinct, %648 -> 640,
    // %512 -> 510, %400 -> 400, %324 -> 324.
    //
    // WHAT THE 900 FLOOR DOES AND DOES NOT CATCH — stated precisely, because a floor whose
    // reach is overclaimed is worse than one that is understood. It kills every collapse at
    // or below 648 (measured 640) with a 256-token margin below the honest 1156. It does
    // NOT catch a mild collapse: 1024 slots drawn 3000 times still yields roughly a thousand
    // distinct tokens, which clears 900. Closing that case needs a floor near 1050, and no
    // one has yet measured a SECOND honest derivation shape to know how much slack 1050
    // leaves — so the conservative floor is what ships, and the gap is recorded here rather
    // than papered over. A halving of the token space is caught; a 20% shave is not.
    const wide = fc.sample(fc.string({ minLength: 1 }), { numRuns: 3000, seed: 58 });
    expect(
      wide.length,
      'rb58 T5 ANCHOR: 3000 samples must be drawn for the image census. A shortened draw ' +
        `caps the image and makes the floor below unreachable-or-meaningless. ${RB58_REPAIR}`,
    ).toBe(3000);
    expect(
      new Set(wide.map((s) => unknownStatusToken(s))).size,
      'rb58 T5 IMAGE: 3000 unseen tags must reach at least 900 DISTINCT tokens. This is the ' +
        'clause that gates how big the token space actually is — the 300-draw floor above ' +
        'cannot: MEASURED, shrinking the space fourfold (1296 -> 400) still gave 205 ' +
        'distinct in 300 draws and sailed past it. At 3000 draws the honest derivation ' +
        'reaches 1156 while a %512 collapse caps out at 510 and a %324 collapse at 324, so ' +
        'this floor separates them with room to spare. A failure here means the badge has ' +
        'fewer usable values than its 3-character budget allows, which is the residual ' +
        'itself in a subtler form: the fallback stops distinguishing unknown statuses ' +
        'sooner than it needs to. LOWERING THIS FLOOR IS THE FORBIDDEN REPAIR — widen the ' +
        `token space instead. ${RB58_NO_UNIQUENESS_CLAIM} ${RB58_REPAIR}`,
    ).toBeGreaterThanOrEqual(900);
  });
});
