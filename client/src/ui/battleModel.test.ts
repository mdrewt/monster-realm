// ui/battleModel.test.ts — Pure view-model tests for M7c battle view (vitest).
// SOURCE OF TRUTH: specs/monster-realm-v2/M7-battle-view.spec.md
// Tests the pure functions in ui/battleModel.ts, which has no SDK or PixiJS deps.
// All inputs are plain objects; deterministic; node-only.
//
// These tests start RED because battleModel.ts does not exist yet.
// Every test has a `// Kills:` comment explaining which wrong impl it catches.

import { describe, expect, it } from 'vitest';
import type {
  StoreBattle,
  StoreBattleMonster,
  StoreBattleSide,
  StoreSkillRow,
  StoreSpeciesRow,
} from '../net/store';
import { buildBattleViewModel } from './battleModel';
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
    playerIdentity: 'alice',
    opponentIdentity: 'npc',
    outcome: 'Ongoing',
    turnNumber: 1,
    sideA: battleSide(),
    sideB: battleSide(),
    partyMonsterIds: [1n],
    opponentMonsterIds: [2n],
    createdAtMs: 1000n,
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

  it('BITES: unknown outcome variant is treated as terminal (canFlee=false)', () => {
    // Kills: an impl that uses a whitelist of terminal states instead of
    // an exclusive check for 'Ongoing' — a future server variant leaks through.
    const b = makeBattle({ outcome: 'Draw' }); // hypothetical future variant
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.canFlee).toBe(false);
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

  it('BITES: unknown outcome variant treated as terminal (canSwap=false)', () => {
    // Kills: an impl that uses a terminal-state blacklist instead of an exclusive
    // 'Ongoing' check — a future server outcome variant enables swap on a dead battle.
    const active = battleMonster({ currentHp: 20, maxHp: 20 });
    const bench = battleMonster({ currentHp: 15, maxHp: 20 });
    const b = makeBattle({
      outcome: 'Draw',
      sideA: { active: 0, team: [active, bench] },
    });
    const vm = buildBattleViewModel(b, makeSkillMap(1), makeSpeciesMap(speciesRow(1)));
    expect(vm!.canSwap).toBe(false);
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
