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
  type OverlayState,
  shouldSkipBattleRefresh,
  statusBadge,
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
    // Identical contract to statusBadge's default arm: console.warn + ''.
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
    const variants = (StatusEffect.algebraicType.value as { variants: Array<{ name: string }> })
      .variants;
    for (const v of variants) {
      const badge = statusBadge(v.name);
      expect(badge.length, `statusBadge("${v.name}") must be non-empty`).toBeGreaterThan(0);
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
