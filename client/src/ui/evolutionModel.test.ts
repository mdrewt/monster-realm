// ui/evolutionModel.test.ts — M10c gating tests for the evolution view-model.
// SOURCE OF TRUTH: specs/monster-realm-v2/M10c (Client evolution/fuse UI).
//
// These tests are INTENTIONALLY RED until evolutionModel.ts is implemented.
// Do NOT edit these tests to match a buggy implementation — correct them from
// the spec only, and log a rationale when doing so.
//
// Pattern follows raisingModel.test.ts: pure function, no DOM, no SDK, no
// side-effects. All inputs are plain objects; deterministic; node-only.

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StoreMonsterPub, StoreSpeciesRow } from '../net/store';
import {
  buildEvolutionViewModel,
  type EvolutionMonsterViewModel,
  type EvolutionViewModel,
} from './evolutionModel';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/** Minimal valid StoreMonsterPub. evolvesTo is not yet on the base type —
 *  we cast to `any` so the factory compiles before the field is added. */
function monster(
  monsterId: bigint,
  overrides: Partial<StoreMonsterPub> & { evolvesTo?: number } = {},
): StoreMonsterPub & { evolvesTo?: number } {
  return {
    monsterId,
    ownerIdentity: 'player',
    speciesId: 1,
    nickname: `M-${monsterId}`,
    level: 5,
    xp: 0,
    bond: 50,
    currentHp: 30,
    statHp: 40,
    statAttack: 10,
    statDefense: 10,
    statSpeed: 10,
    statSpAttack: 10,
    statSpDefense: 10,
    partySlot: 255,
    ...overrides,
  };
}

function speciesRow(id: number, name: string): StoreSpeciesRow {
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

// ---------------------------------------------------------------------------
// Criterion 1 — WHEN a monster has evolvesTo=N, canEvolve is true and
//               evolvesToSpeciesName resolves from speciesMap.
//               If species not found, fallback to "Unknown (#N)".
// ---------------------------------------------------------------------------

describe('buildEvolutionViewModel criterion 1: evolvesTo present → canEvolve true + name resolved', () => {
  it('BITES: evolvesTo=5 with species 5 in map → canEvolve true, evolvesToSpeciesName="Pyrodrake"', () => {
    // Kills: an impl that ignores evolvesTo or always sets canEvolve:false.
    // Also kills: an impl that doesn't look up the species name from the map.
    const speciesMap = new Map([
      [1, speciesRow(1, 'Flameling')],
      [5, speciesRow(5, 'Pyrodrake')],
    ]);
    const m = monster(1n, { speciesId: 1, evolvesTo: 5 });
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], speciesMap);
    const mon = vm.monsters[0]!;
    expect(mon.canEvolve).toBe(true);
    expect(mon.evolvesToSpeciesName).toBe('Pyrodrake');
  });

  it('BITES: evolvesTo present but species NOT in map → canEvolve true, evolvesToSpeciesName="Unknown (#5)"', () => {
    // Kills: an impl that returns null when the species is missing, or that sets
    // canEvolve:false when the lookup fails (the server said evolvesTo=5, so canEvolve
    // must still be true even if speciesMap doesn't have species 5 yet).
    // Rationale: spec says canEvolve is true iff evolvesTo !== undefined; the fallback
    // name is "Unknown (#N)" matching the boxModel.ts pattern for missing species.
    const speciesMap = new Map([[1, speciesRow(1, 'Flameling')]]); // species 5 absent
    const m = monster(1n, { speciesId: 1, evolvesTo: 5 });
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], speciesMap);
    const mon = vm.monsters[0]!;
    expect(mon.canEvolve).toBe(true);
    expect(mon.evolvesToSpeciesName).toBe('Unknown (#5)');
  });

  it('BITES fast-check: any evolvesTo number → canEvolve true; name resolves or falls back', () => {
    // Property: for any non-negative species id, canEvolve is always true when evolvesTo
    // is defined, and the name is either from the map or "Unknown (#id)".
    // Kills: any conditional path that sets canEvolve:false when evolvesTo is defined.
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9999 }), (targetId) => {
        const speciesMap = new Map([[targetId, speciesRow(targetId, `Species-${targetId}`)]]);
        const m = monster(1n, { evolvesTo: targetId });
        const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], speciesMap);
        const mon = vm.monsters[0]!;
        expect(mon.canEvolve).toBe(true);
        expect(mon.evolvesToSpeciesName).toBe(`Species-${targetId}`);
      }),
    );
  });

  it('BITES: fallback name format is "Unknown (#N)" not "Unknown" or "Unknown (N)"', () => {
    // Kills: an impl that uses a different fallback pattern — must be exact "Unknown (#5)".
    const speciesMap = new Map<number, StoreSpeciesRow>();
    const m = monster(1n, { evolvesTo: 99 });
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], speciesMap);
    const mon = vm.monsters[0]!;
    expect(mon.evolvesToSpeciesName).toBe('Unknown (#99)');
    expect(mon.evolvesToSpeciesName).not.toBe('Unknown');
    expect(mon.evolvesToSpeciesName).not.toBe('Unknown (99)');
    expect(mon.evolvesToSpeciesName).not.toBe('Unknown #99');
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 — WHEN a monster has evolvesTo=undefined, canEvolve is false
//               and evolvesToSpeciesName is null.
// ---------------------------------------------------------------------------

describe('buildEvolutionViewModel criterion 2: evolvesTo undefined → canEvolve false + null name', () => {
  it('BITES: monster with evolvesTo=undefined → canEvolve false, evolvesToSpeciesName null', () => {
    // Kills: an impl that always sets canEvolve:true or sets evolvesToSpeciesName to
    // "" or "Unknown" instead of null.
    const speciesMap = new Map([[1, speciesRow(1, 'Flameling')]]);
    const m = monster(1n, { speciesId: 1 }); // no evolvesTo
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], speciesMap);
    const mon = vm.monsters[0]!;
    expect(mon.canEvolve).toBe(false);
    expect(mon.evolvesToSpeciesName).toBeNull();
  });

  it('BITES: canEvolve is exactly false (boolean), not falsy string or 0', () => {
    // Kills: an impl that returns undefined/null/""/0 instead of the boolean false.
    const speciesMap = new Map<number, StoreSpeciesRow>();
    const m = monster(2n);
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], speciesMap);
    const mon = vm.monsters[0]!;
    expect(mon.canEvolve).toBe(false);
    expect(typeof mon.canEvolve).toBe('boolean');
  });

  it('BITES: evolvesToSpeciesName is strictly null (not undefined, not empty string)', () => {
    // Kills: an impl that returns undefined or "" when evolvesTo is absent.
    const m = monster(3n);
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], new Map());
    const mon = vm.monsters[0]!;
    expect(mon.evolvesToSpeciesName).toBeNull();
    expect(mon.evolvesToSpeciesName).not.toBeUndefined();
    expect(mon.evolvesToSpeciesName).not.toBe('');
  });

  it('BITES fast-check: any monster without evolvesTo → canEvolve false', () => {
    // Property: no matter what other fields look like, absence of evolvesTo means no evolution.
    // Kills: any impl that infers evolvesTo from other fields (level, bond, speciesId, etc.).
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 9999n }),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 255 }),
        (monsterId, level, bond) => {
          const m = monster(monsterId, { level, bond }); // no evolvesTo
          const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], new Map());
          const mon = vm.monsters[0]!;
          expect(mon.canEvolve).toBe(false);
          expect(mon.evolvesToSpeciesName).toBeNull();
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 — Pass-through: monsterId, speciesName, nickname, level, bond
//               are copied verbatim. Never throws on 0/empty/0n.
// ---------------------------------------------------------------------------

describe('buildEvolutionViewModel criterion 3: verbatim pass-through of identity fields', () => {
  it('BITES: monsterId stays bigint and is copied verbatim (not downcast to number)', () => {
    // Kills: any impl that converts monsterId via Number().
    // Value > 2^53 proves bigint is preserved.
    const largeId = 9007199254740993n; // 2^53 + 1
    const speciesMap = new Map([[1, speciesRow(1, 'Flameling')]]);
    const m = monster(largeId, { speciesId: 1 });
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], speciesMap);
    const mon = vm.monsters[0]!;
    expect(typeof mon.monsterId).toBe('bigint');
    expect(mon.monsterId).toBe(largeId);
  });

  it('BITES: speciesName is resolved from speciesMap using speciesId (not a hardcoded string)', () => {
    // Kills: an impl that ignores speciesMap or hardcodes the species name.
    const speciesMap = new Map([[7, speciesRow(7, 'Aquazor')]]);
    const m = monster(1n, { speciesId: 7 });
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], speciesMap);
    expect(vm.monsters[0]!.speciesName).toBe('Aquazor');
  });

  it('BITES: speciesName falls back to "Unknown (#N)" when speciesId not in map', () => {
    // Kills: an impl that throws on missing species or returns empty string.
    const m = monster(1n, { speciesId: 42 });
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], new Map());
    expect(vm.monsters[0]!.speciesName).toBe('Unknown (#42)');
  });

  it('BITES: nickname is copied verbatim (not trimmed, not default-replaced)', () => {
    // Kills: an impl that normalizes or replaces empty/short nicknames.
    const speciesMap = new Map([[1, speciesRow(1, 'Flameling')]]);
    const m = monster(1n, { speciesId: 1, nickname: 'Blaze' });
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], speciesMap);
    expect(vm.monsters[0]!.nickname).toBe('Blaze');
  });

  it('BITES: empty nickname is copied verbatim as empty string (no replacement)', () => {
    // Kills: an impl that substitutes a default name when nickname is "".
    const m = monster(1n, { nickname: '' });
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], new Map());
    expect(vm.monsters[0]!.nickname).toBe('');
  });

  it('BITES: level is copied verbatim (including 0)', () => {
    // Kills: an impl that clamps level to [1, 100] or computes it from xp.
    const m = monster(1n, { level: 0 });
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], new Map());
    expect(vm.monsters[0]!.level).toBe(0);
    expect(typeof vm.monsters[0]!.level).toBe('number');
  });

  it('BITES: bond is copied verbatim (including 0)', () => {
    // Kills: an impl that recomputes bond from other fields.
    const m = monster(1n, { bond: 0 });
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], new Map());
    expect(vm.monsters[0]!.bond).toBe(0);
  });

  it('BITES: monsterId=0n, empty nickname, level=0, bond=0 — does not throw', () => {
    // Edge-case: boundary values must not crash. A throw here would starve batch listeners.
    expect(() => {
      buildEvolutionViewModel(
        [monster(0n, { nickname: '', level: 0, bond: 0 }) as unknown as StoreMonsterPub],
        new Map(),
      );
    }).not.toThrow();
  });

  it('BITES fast-check: level and bond are copied verbatim for any values', () => {
    // Kills: any impl that recomputes or clamps these server-authoritative fields.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 200 }),
        fc.integer({ min: 0, max: 255 }),
        (level, bond) => {
          const m = monster(1n, { level, bond });
          const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], new Map());
          const mon = vm.monsters[0]!;
          expect(mon.level).toBe(level);
          expect(mon.bond).toBe(bond);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 — Empty monster array → { monsters: [] }
// ---------------------------------------------------------------------------

describe('buildEvolutionViewModel criterion 4: empty input → empty output', () => {
  it('BITES: empty monsters array → { monsters: [] }', () => {
    // Kills: an impl that returns a non-empty default list or throws on empty input.
    const vm = buildEvolutionViewModel([], new Map());
    expect(vm).toHaveProperty('monsters');
    expect(Array.isArray(vm.monsters)).toBe(true);
    expect(vm.monsters).toHaveLength(0);
  });

  it('BITES: the returned object has exactly the expected shape (monsters property)', () => {
    // Kills: an impl that returns a flat array rather than { monsters: [...] }.
    let vm: EvolutionViewModel;
    expect(() => {
      vm = buildEvolutionViewModel([], new Map());
    }).not.toThrow();
    expect(vm!).toEqual({ monsters: [] });
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 — MUST NOT throw on any input (safety / total function)
// ---------------------------------------------------------------------------

describe('buildEvolutionViewModel criterion 5: total function — never throws', () => {
  it('BITES: empty map + monster with unknown speciesId + undefined evolvesTo → no throw', () => {
    // A throw here would starve sibling store batch-listeners (one-way flow rule).
    // Kills: any impl that throws on a Map miss.
    expect(() => {
      buildEvolutionViewModel(
        [monster(1n, { speciesId: 999 }) as unknown as StoreMonsterPub],
        new Map(),
      );
    }).not.toThrow();
  });

  it('BITES: monsterId=0n does not throw', () => {
    // Kills: an impl that guards against zero id and throws.
    expect(() => {
      buildEvolutionViewModel([monster(0n) as unknown as StoreMonsterPub], new Map());
    }).not.toThrow();
  });

  it('BITES: evolvesTo=0 (species id 0, valid id value) does not throw', () => {
    // Kills: an impl that guards against id=0 as "falsy" and fails.
    expect(() => {
      buildEvolutionViewModel(
        [monster(1n, { evolvesTo: 0 }) as unknown as StoreMonsterPub],
        new Map(),
      );
    }).not.toThrow();
  });

  it('BITES: evolvesTo=0 with species 0 absent from map → canEvolve true, fallback name', () => {
    // Spec: canEvolve is true iff evolvesTo !== undefined. 0 is defined.
    // Kills: an impl that treats 0 as falsy and sets canEvolve:false.
    const m = monster(1n, { evolvesTo: 0 });
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], new Map());
    expect(vm.monsters[0]!.canEvolve).toBe(true);
    expect(vm.monsters[0]!.evolvesToSpeciesName).toBe('Unknown (#0)');
  });

  it('BITES fast-check: never throws on arbitrary valid monster inputs', () => {
    // Kills: any impl that crashes for unusual but structurally valid inputs.
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 99999n }),
        fc.string({ maxLength: 30 }),
        fc.integer({ min: 0, max: 500 }),
        fc.integer({ min: 0, max: 300 }),
        fc.option(fc.integer({ min: 0, max: 1000 })),
        (monsterId, nickname, level, bond, evolvesTo) => {
          const m = monster(monsterId, {
            nickname,
            level,
            bond,
            ...(evolvesTo != null ? { evolvesTo } : {}),
          });
          expect(() => {
            buildEvolutionViewModel([m as unknown as StoreMonsterPub], new Map());
          }).not.toThrow();
        },
      ),
    );
  });

  it('BITES: large list of monsters (30) with mixed evolvesTo — no throw', () => {
    // Regression guard: the function must be safe at scale.
    const speciesMap = new Map(
      Array.from({ length: 20 }, (_, i) => [i + 1, speciesRow(i + 1, `Species-${i + 1}`)]),
    );
    const monsters = Array.from({ length: 30 }, (_, i) =>
      monster(BigInt(i + 1), {
        speciesId: (i % 20) + 1,
        ...(i % 3 === 0 ? { evolvesTo: ((i + 1) % 20) + 1 } : {}),
      }),
    );
    expect(() => {
      buildEvolutionViewModel(monsters as unknown as StoreMonsterPub[], speciesMap);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Criterion 6 — monsters array in output MUST preserve input order
// ---------------------------------------------------------------------------

describe('buildEvolutionViewModel criterion 6: output order matches input order', () => {
  it('BITES: three monsters in insertion order — output order is identical', () => {
    // Kills: an impl that sorts by monsterId, canEvolve, speciesId, or any other field.
    const speciesMap = new Map([[1, speciesRow(1, 'Flameling')]]);
    const monsters = [
      monster(3n, { speciesId: 1 }),
      monster(1n, { speciesId: 1 }),
      monster(2n, { speciesId: 1 }),
    ];
    const vm = buildEvolutionViewModel(monsters as unknown as StoreMonsterPub[], speciesMap);
    expect(vm.monsters).toHaveLength(3);
    expect(vm.monsters[0]!.monsterId).toBe(3n);
    expect(vm.monsters[1]!.monsterId).toBe(1n);
    expect(vm.monsters[2]!.monsterId).toBe(2n);
  });

  it('BITES: mixed canEvolve/cannot-evolve — order still matches input', () => {
    // Kills: an impl that sorts canEvolve=true entries before canEvolve=false.
    const speciesMap = new Map([
      [1, speciesRow(1, 'Flameling')],
      [5, speciesRow(5, 'Pyrodrake')],
    ]);
    // Order: no-evolve, can-evolve, no-evolve
    const monsters = [
      monster(10n, { speciesId: 1 }), // no evolvesTo
      monster(20n, { speciesId: 1, evolvesTo: 5 }), // evolvesTo=5
      monster(30n, { speciesId: 1 }), // no evolvesTo
    ];
    const vm = buildEvolutionViewModel(monsters as unknown as StoreMonsterPub[], speciesMap);
    expect(vm.monsters[0]!.monsterId).toBe(10n);
    expect(vm.monsters[0]!.canEvolve).toBe(false);
    expect(vm.monsters[1]!.monsterId).toBe(20n);
    expect(vm.monsters[1]!.canEvolve).toBe(true);
    expect(vm.monsters[2]!.monsterId).toBe(30n);
    expect(vm.monsters[2]!.canEvolve).toBe(false);
  });

  it('BITES fast-check: output monsters are always in same order as input array', () => {
    // Property: shuffle the input, the output must mirror the same permutation.
    // Kills: any impl that sorts or reorders the monster list.
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 100n }), { minLength: 1, maxLength: 15 }),
        (ids) => {
          const speciesMap = new Map([[1, speciesRow(1, 'S')]]);
          const monsters = ids.map((id) => monster(id, { speciesId: 1 }));
          const vm = buildEvolutionViewModel(monsters as unknown as StoreMonsterPub[], speciesMap);
          expect(vm.monsters).toHaveLength(monsters.length);
          for (let i = 0; i < monsters.length; i++) {
            expect(vm.monsters[i]!.monsterId).toBe(ids[i]);
          }
        },
      ),
    );
  });

  it('BITES: EvolutionMonsterViewModel has all required fields (shape contract)', () => {
    // Kills: an impl that omits any required field from the view-model interface.
    const speciesMap = new Map([
      [1, speciesRow(1, 'Flameling')],
      [5, speciesRow(5, 'Pyrodrake')],
    ]);
    const m = monster(1n, { speciesId: 1, evolvesTo: 5, nickname: 'Blaze', level: 10, bond: 80 });
    const vm = buildEvolutionViewModel([m as unknown as StoreMonsterPub], speciesMap);
    const mon: EvolutionMonsterViewModel = vm.monsters[0]!;
    expect(mon).toHaveProperty('monsterId');
    expect(mon).toHaveProperty('speciesName');
    expect(mon).toHaveProperty('nickname');
    expect(mon).toHaveProperty('level');
    expect(mon).toHaveProperty('bond');
    expect(mon).toHaveProperty('evolvesToSpeciesName');
    expect(mon).toHaveProperty('canEvolve');
    // spot-check values
    expect(mon.monsterId).toBe(1n);
    expect(mon.speciesName).toBe('Flameling');
    expect(mon.nickname).toBe('Blaze');
    expect(mon.level).toBe(10);
    expect(mon.bond).toBe(80);
    expect(mon.evolvesToSpeciesName).toBe('Pyrodrake');
    expect(mon.canEvolve).toBe(true);
  });
});
