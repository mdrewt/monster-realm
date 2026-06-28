// ui/battleModel.test.ts — Pure view-model tests for M7c battle view (vitest).
// SOURCE OF TRUTH: specs/monster-realm-v2/M7-battle-view.spec.md
// Tests the pure functions in ui/battleModel.ts, which has no SDK or PixiJS deps.
// All inputs are plain objects; deterministic; node-only.
//
// These tests start RED because battleModel.ts does not exist yet.
// Every test has a `// Kills:` comment explaining which wrong impl it catches.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type {
  StoreBattle,
  StoreBattleMonster,
  StoreBattleSide,
  StoreSkillRow,
  StoreSpeciesRow,
} from '../net/store';
import { buildBattleViewModel, decideBattleOverlay, type OverlayState } from './battleModel';
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
