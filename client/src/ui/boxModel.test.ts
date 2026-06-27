// Box/party pure model tests (M6c) — vitest.
// SOURCE OF TRUTH: specs/monster-realm-v2/M6-box-party.spec.md
// Tests the pure functions in ui/boxModel.ts, which has no SDK or PixiJS deps.
// All inputs are plain objects; deterministic; node-only.
import { describe, expect, it } from 'vitest';
import type { StoreMonsterPub, StoreSpeciesRow } from '../net/store';
import { buildBoxViewModel, buildPartyViewModel, hpPercent, nextFreePartySlot } from './boxModel';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function monster(
  monsterId: bigint,
  speciesId: number,
  partySlot: number,
  overrides: Partial<StoreMonsterPub> = {},
): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity: 'player',
    speciesId,
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
    partySlot,
    ...overrides,
  };
}

function species(id: number, name = `Species-${id}`): StoreSpeciesRow {
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
// buildPartyViewModel
// ---------------------------------------------------------------------------

describe('buildPartyViewModel: slot assignment', () => {
  it('BITES: monsters with slots 0,1,3 fill those slots; slots 2,4,5 are null', () => {
    // Kills: an impl that packs monsters left-to-right instead of honouring partySlot.
    const monsters = [monster(1n, 1, 0), monster(2n, 2, 1), monster(3n, 3, 3)];
    const speciesMap = new Map([
      [1, species(1, 'Flameling')],
      [2, species(2, 'Aqualing')],
      [3, species(3, 'Leaflet')],
    ]);
    const party = buildPartyViewModel(monsters, speciesMap);

    expect(party).toHaveLength(6); // always 6 slots
    expect(party[0]).not.toBeNull();
    expect(party[0]!.monsterId).toBe(1n);
    expect(party[1]).not.toBeNull();
    expect(party[1]!.monsterId).toBe(2n);
    expect(party[2]).toBeNull(); // gap
    expect(party[3]).not.toBeNull();
    expect(party[3]!.monsterId).toBe(3n);
    expect(party[4]).toBeNull();
    expect(party[5]).toBeNull();
  });

  it('BITES: an empty monster list produces 6 null slots', () => {
    // Kills: an impl that returns fewer than 6 entries when input is empty.
    const party = buildPartyViewModel([], new Map());
    expect(party).toHaveLength(6);
    expect(party.every((s) => s === null)).toBe(true);
  });

  it('BITES: all 6 slots filled — no nulls, correct monsterId ordering by slot', () => {
    // Kills: an impl that truncates the array or skips the last slot.
    const monsters = [5, 4, 3, 2, 1, 0].map((slot, i) => monster(BigInt(i + 1), 1, slot));
    const speciesMap = new Map([[1, species(1)]]);
    const party = buildPartyViewModel(monsters, speciesMap);
    expect(party).toHaveLength(6);
    for (let slot = 0; slot < 6; slot++) {
      expect(party[slot]).not.toBeNull();
      expect(party[slot]!.partySlot).toBe(slot);
    }
  });
});

describe('buildPartyViewModel: speciesName fallback', () => {
  it('BITES: missing species entry defaults to "Unknown (#speciesId)"', () => {
    // Kills: an impl that throws or returns undefined when speciesId not in map.
    const monsters = [monster(1n, 99, 0)]; // speciesId 99 not in map
    const party = buildPartyViewModel(monsters, new Map()); // empty species map
    expect(party[0]).not.toBeNull();
    expect(party[0]!.speciesName).toBe('Unknown (#99)');
  });

  it('speciesName is the species name when the map entry exists', () => {
    // Kills: an impl that always returns the fallback string.
    const monsters = [monster(1n, 7, 0)];
    const speciesMap = new Map([[7, species(7, 'Thundercub')]]);
    const party = buildPartyViewModel(monsters, speciesMap);
    expect(party[0]!.speciesName).toBe('Thundercub');
  });
});

describe('buildPartyViewModel: hpPercent embedded in view model', () => {
  it('BITES: the hpPercent field on the card matches hpPercent(currentHp, statHp)', () => {
    // Kills: an impl that omits hpPercent from MonsterCardViewModel or sets it to 0.
    const monsters = [monster(1n, 1, 0, { currentHp: 25, statHp: 50 })];
    const speciesMap = new Map([[1, species(1)]]);
    const party = buildPartyViewModel(monsters, speciesMap);
    expect(party[0]!.hpPercent).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// buildBoxViewModel
// ---------------------------------------------------------------------------

describe('buildBoxViewModel: only partySlot === 255 monsters', () => {
  it('BITES: monsters with partySlot 0–5 are excluded; only slot 255 (box) included', () => {
    // Kills: an impl that returns ALL monsters regardless of partySlot, leaking
    // party members into the box view.
    const monsters = [
      monster(1n, 1, 0), // in party — must NOT appear
      monster(2n, 1, 255), // in box — must appear
      monster(3n, 1, 1), // in party — must NOT appear
      monster(4n, 1, 255), // in box — must appear
    ];
    const speciesMap = new Map([[1, species(1)]]);
    const box = buildBoxViewModel(monsters, speciesMap);
    expect(box).toHaveLength(2);
    expect(box.map((m) => m.monsterId)).toContain(2n);
    expect(box.map((m) => m.monsterId)).toContain(4n);
  });

  it('BITES: empty monster list produces an empty box', () => {
    // Kills: an impl that pre-fills placeholder entries in the box.
    const box = buildBoxViewModel([], new Map());
    expect(box).toHaveLength(0);
  });

  it('BITES: all box monsters (partySlot 255) are included, none omitted', () => {
    // Kills: an impl that caps the box at 6 entries (confusing party with box).
    const monsters = Array.from({ length: 10 }, (_, i) => monster(BigInt(i + 1), 1, 255));
    const speciesMap = new Map([[1, species(1)]]);
    const box = buildBoxViewModel(monsters, speciesMap);
    expect(box).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------
// hpPercent
// ---------------------------------------------------------------------------

describe('hpPercent: pure percentage calculation', () => {
  it('BITES: hpPercent(50, 100) === 50', () => {
    // Kills: an impl that inverts numerator/denominator or multiplies by 1 instead of 100.
    expect(hpPercent(50, 100)).toBe(50);
  });

  it('BITES: hpPercent(0, 100) === 0 (fainted monster shows 0%)', () => {
    // Kills: an impl that returns 1 as a floor or fails on zero currentHp.
    expect(hpPercent(0, 100)).toBe(0);
  });

  it('BITES: hpPercent(100, 100) === 100 (full health)', () => {
    // Kills: an impl that caps at 99 or uses floor/round incorrectly.
    expect(hpPercent(100, 100)).toBe(100);
  });

  it('BITES: hpPercent(any, 0) === 0 (no division-by-zero crash)', () => {
    // Kills: an impl that throws on divide-by-zero; zero maxHp returns 0 not Infinity/NaN.
    expect(hpPercent(100, 0)).toBe(0);
    expect(hpPercent(0, 0)).toBe(0);
  });

  it('hpPercent is clamped to [0, 100] (never negative, never > 100)', () => {
    // Kills: an impl that returns raw ratio when currentHp somehow exceeds statHp.
    expect(hpPercent(120, 100)).toBe(100); // clamped
    expect(hpPercent(-5, 100)).toBe(0); // clamped
  });
});

// ---------------------------------------------------------------------------
// nextFreePartySlot
// ---------------------------------------------------------------------------

describe('nextFreePartySlot: first unused slot 0–5', () => {
  it('BITES: slots [0,1,2] filled → nextFreePartySlot returns 3', () => {
    // Kills: an impl that always returns 0 or ignores current party state.
    const monsters = [monster(1n, 1, 0), monster(2n, 1, 1), monster(3n, 1, 2)];
    expect(nextFreePartySlot(monsters)).toBe(3);
  });

  it('BITES: no party slots filled → returns 0 (first slot)', () => {
    // Kills: an impl that searches from 1 instead of 0.
    const monsters = [monster(1n, 1, 255)]; // only in box
    expect(nextFreePartySlot(monsters)).toBe(0);
  });

  it('BITES: all 6 party slots (0–5) filled → returns null', () => {
    // Kills: an impl that returns 6 (out-of-bounds slot) instead of null.
    const monsters = [0, 1, 2, 3, 4, 5].map((slot) => monster(BigInt(slot + 1), 1, slot));
    expect(nextFreePartySlot(monsters)).toBeNull();
  });

  it('BITES: gaps in party are honoured — slot 1 free when 0,2 are taken', () => {
    // Kills: an impl that returns the slot AFTER the last occupied rather than
    // scanning for the lowest free index.
    const monsters = [monster(1n, 1, 0), monster(2n, 1, 2)];
    expect(nextFreePartySlot(monsters)).toBe(1);
  });

  it('box monsters (partySlot 255) are ignored when computing the next free slot', () => {
    // Kills: an impl that counts partySlot 255 as an occupied party slot,
    // which would falsely advance the free-slot pointer.
    const monsters = [monster(1n, 1, 255), monster(2n, 1, 255)];
    expect(nextFreePartySlot(monsters)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M8.5f / ADR-0052 Criterion C — PARTY SSOT param-threading
//
// The fix: delete the hardcoded `PARTY_SIZE = 6` and `BOX_SLOT = 255` module
// constants; thread them as explicit parameters:
//   buildPartyViewModel(monsters, speciesMap, partySize: number)
//   nextFreePartySlot(monsters, partySize: number)
//   buildBoxViewModel(monsters, speciesMap, partySlotNone: number)
//
// RED strategy: JS silently ignores extra positional args, so a 2-arg call with
// a 3rd arg passes at runtime — the RED must come from behaviour that DIFFERS
// when the param is live vs hardcoded. Tests use non-canonical param values
// (partySize=3 ≠ 6; partySize=2 → null; partySlotNone=99 ≠ 255) whose expected
// outcomes CANNOT be produced by the current hardcoded implementation.
//
// Wrong impl killed: an impl that re-hardcodes `6` or `255` instead of using
// the passed param — the non-canonical-value assertions fail by construction.
// ---------------------------------------------------------------------------

describe('M8.5f PARTY SSOT: buildPartyViewModel threaded partySize param', () => {
  it('BITES: buildPartyViewModel with partySize=3 returns exactly 3 slots (param is live)', () => {
    // RED: current impl hardcodes PARTY_SIZE=6, returns length=6 → toHaveLength(3) fails.
    // Kills: any impl that ignores the param and uses a hardcoded 6.
    const monsters = [monster(1n, 1, 0), monster(2n, 2, 1)];
    const speciesMap = new Map([
      [1, species(1)],
      [2, species(2)],
    ]);
    const party = buildPartyViewModel(monsters, speciesMap, 3);
    expect(party).toHaveLength(3); // RED: current impl returns 6
    expect(party[0]).not.toBeNull();
    expect(party[1]).not.toBeNull();
    expect(party[2]).toBeNull();
  });

  it('BITES: buildPartyViewModel with partySize=6 returns length 6 (canonical value, param-driven)', () => {
    // GREEN even before fix (hardcoded 6 coincides) — this is the acceptance test.
    // Kept to confirm the param-driven path returns the right length when set to 6.
    const monsters = [monster(1n, 1, 0), monster(2n, 2, 1)];
    const speciesMap = new Map([
      [1, species(1, 'Flameling')],
      [2, species(2, 'Aqualing')],
    ]);
    const party = buildPartyViewModel(monsters, speciesMap, 6);
    expect(party).toHaveLength(6);
    expect(party[0]).not.toBeNull();
    expect(party[5]).toBeNull();
  });
});

describe('M8.5f PARTY SSOT: nextFreePartySlot threaded partySize param', () => {
  it('BITES: nextFreePartySlot with partySize=2 returns null when both slots filled', () => {
    // RED: current impl hardcodes PARTY_SIZE=6, so with slots 0,1 taken it returns 2
    // (slot 2 is free in a 6-slot party). But partySize=2 means those 2 slots are the
    // entire party → should return null. Current impl returns 2 → toBeNull() fails.
    // Kills: any impl that ignores the param and uses a hardcoded 6.
    const monsters = [monster(1n, 1, 0), monster(2n, 1, 1)];
    const slot = nextFreePartySlot(monsters, 2);
    expect(slot).toBeNull(); // RED: current impl returns 2
  });

  it('BITES: nextFreePartySlot with partySize=6 returns 2 when slots 0,1 taken (param-driven)', () => {
    // Acceptance test: with partySize=6 (canonical), behaviour matches the current impl.
    // Confirms the param-driven path produces the right answer for the canonical value.
    const monsters = [monster(1n, 1, 0), monster(2n, 1, 1)];
    const slot = nextFreePartySlot(monsters, 6);
    expect(slot).toBe(2);
  });
});

describe('M8.5f PARTY SSOT: buildBoxViewModel threaded partySlotNone param', () => {
  it('BITES: buildBoxViewModel with partySlotNone=99 filters on that sentinel (param is live)', () => {
    // RED: current impl hardcodes BOX_SLOT=255. With the 99 sentinel, monster(2n,1,99)
    // should be included, but current impl checks `partySlot === 255` → returns [] (length 0).
    // toHaveLength(1) fails. Kills: re-hardcoding 255 in the impl.
    const monsters = [
      monster(1n, 1, 255), // slot=255, excluded under partySlotNone=99
      monster(2n, 1, 99), // slot=99, included under partySlotNone=99
    ];
    const speciesMap = new Map([[1, species(1)]]);
    const box = buildBoxViewModel(monsters, speciesMap, 99);
    expect(box).toHaveLength(1); // RED: current impl returns []
    expect(box[0].monsterId).toBe(2n);
  });

  it('BITES: buildBoxViewModel with partySlotNone=255 (canonical) includes only slot-255 monsters', () => {
    // Acceptance test at the canonical value: confirms the param-driven path still
    // works correctly for the production sentinel.
    const monsters = [
      monster(1n, 1, 0), // party — excluded
      monster(2n, 1, 255), // box — included
    ];
    const speciesMap = new Map([[1, species(1)]]);
    const box = buildBoxViewModel(monsters, speciesMap, 255);
    expect(box).toHaveLength(1);
    expect(box[0].monsterId).toBe(2n);
  });
});
