// rowConvert — SDK generated row -> normalized store row (M4a + M6c extension).
// M6c adds monsterPubRowToStore and speciesRowToStore.
import { describe, expect, it } from 'vitest';
import {
  characterRowToStore,
  monsterPubRowToStore,
  playerRowToStore,
  speciesRowToStore,
} from './rowConvert';

describe('rowConvert: character row -> store', () => {
  it('keeps bigint ids, flattens tagged enums, converts the move_queue', () => {
    const store = characterRowToStore({
      entityId: 42n,
      zoneId: 0,
      tileX: 3,
      tileY: 4,
      facing: { tag: 'East' },
      action: { tag: 'Walking' },
      moveStartedAtMs: 1234n,
      moveQueue: [{ tag: 'Step', value: { tag: 'North' } }, { tag: 'Jump' }],
    });
    expect(store.entityId).toBe(42n);
    expect(typeof store.entityId).toBe('bigint'); // never downcast to number
    expect(store.facing).toBe('East'); // {tag:'East'} -> 'East'
    expect(store.action).toBe('Walking');
    expect(store.moveStartedAtMs).toBe(1234n); // i64 stays bigint
    expect(store.moveQueue).toEqual([{ Step: 'North' }, 'Jump']); // SDK -> wasm shape
  });
});

describe('rowConvert: player row -> store', () => {
  it('resolves identity to its hex key and keeps bigint entity id + seq', () => {
    const store = playerRowToStore({
      identity: { toHexString: () => 'abc123' },
      entityId: 7n,
      name: 'Drew',
      online: true,
      lastInputSeq: 9n,
    });
    expect(store.identity).toBe('abc123');
    expect(store.entityId).toBe(7n);
    expect(typeof store.lastInputSeq).toBe('bigint');
    expect(store.lastInputSeq).toBe(9n);
  });
});

// =============================================================================
// M6c extension: monsterPubRowToStore + speciesRowToStore
// =============================================================================

describe('rowConvert M6c: monsterPubRowToStore — SDK row -> StoreMonsterPub', () => {
  it('BITES: monsterId stays bigint, ownerIdentity becomes hex string, stats are numbers', () => {
    // Kills: an impl that downcasts monsterId to number (lossy for u64) or
    // forgets to call toHexString() on identity (leaves an object in the store).
    const store = monsterPubRowToStore({
      monsterId: 12345678901234567890n,
      ownerIdentity: { toHexString: () => 'deadbeef' },
      speciesId: 7,
      nickname: 'Sparky',
      level: 12,
      xp: 3000,
      bond: 80,
      currentHp: 45,
      statHp: 60,
      statAttack: 55,
      statDefense: 40,
      statSpeed: 70,
      statSpAttack: 65,
      statSpDefense: 50,
      partySlot: 0,
    });

    // monsterId must remain a bigint — u64 exceeds Number.MAX_SAFE_INTEGER
    expect(typeof store.monsterId).toBe('bigint');
    expect(store.monsterId).toBe(12345678901234567890n);

    // ownerIdentity: the SDK object must be resolved to its hex string
    expect(typeof store.ownerIdentity).toBe('string');
    expect(store.ownerIdentity).toBe('deadbeef');

    // All numeric stats must be JS numbers
    expect(typeof store.speciesId).toBe('number');
    expect(store.speciesId).toBe(7);
    expect(store.nickname).toBe('Sparky');
    expect(store.level).toBe(12);
    expect(store.xp).toBe(3000);
    expect(store.bond).toBe(80);
    expect(store.currentHp).toBe(45);
    expect(store.statHp).toBe(60);
    expect(store.statAttack).toBe(55);
    expect(store.statDefense).toBe(40);
    expect(store.statSpeed).toBe(70);
    expect(store.statSpAttack).toBe(65);
    expect(store.statSpDefense).toBe(50);
    expect(store.partySlot).toBe(0);
  });

  it('BITES: no hidden iv*, ev*, or natureKind fields appear in the output', () => {
    // Kills: an impl that passes through a wider SDK row without stripping private fields.
    const store = monsterPubRowToStore({
      monsterId: 1n,
      ownerIdentity: { toHexString: () => 'ff' },
      speciesId: 1,
      nickname: '',
      level: 1,
      xp: 0,
      bond: 0,
      currentHp: 10,
      statHp: 10,
      statAttack: 10,
      statDefense: 10,
      statSpeed: 10,
      statSpAttack: 10,
      statSpDefense: 10,
      partySlot: 255,
    });
    const keys = Object.keys(store);
    const forbidden = [
      'ivHp',
      'ivAttack',
      'ivDefense',
      'ivSpeed',
      'ivSpAttack',
      'ivSpDefense',
      'evHp',
      'evAttack',
      'evDefense',
      'evSpeed',
      'evSpAttack',
      'evSpDefense',
      'natureKind',
    ];
    for (const field of forbidden) {
      expect(keys).not.toContain(field);
    }
  });
});

describe('rowConvert M6c: speciesRowToStore — SDK row -> StoreSpeciesRow', () => {
  it('BITES: id is number, affinity is flattened from tagged-union to string', () => {
    // Kills: an impl that leaves affinity as {tag:'Fire'} instead of 'Fire', or
    // that downcasts id incorrectly.
    const store = speciesRowToStore({
      id: 3,
      name: 'Flameling',
      baseHp: 45,
      baseAttack: 60,
      baseDefense: 40,
      baseSpeed: 65,
      baseSpAttack: 70,
      baseSpDefense: 50,
      affinity: { tag: 'Fire' },
      learnableSkillIds: [1, 2, 5],
    });

    expect(typeof store.id).toBe('number');
    expect(store.id).toBe(3);
    expect(store.name).toBe('Flameling');

    // affinity must be the bare string, not the tagged-union object
    expect(typeof store.affinity).toBe('string');
    expect(store.affinity).toBe('Fire');

    // numeric bases pass through unchanged
    expect(store.baseHp).toBe(45);
    expect(store.baseAttack).toBe(60);
    expect(store.baseDefense).toBe(40);
    expect(store.baseSpeed).toBe(65);
    expect(store.baseSpAttack).toBe(70);
    expect(store.baseSpDefense).toBe(50);

    // learnable skill ids preserved as array
    expect(store.learnableSkillIds).toEqual([1, 2, 5]);
  });

  it('BITES: each affinity variant is flattened correctly (not just Fire)', () => {
    // Kills: an impl that hard-codes 'Fire' or only handles one tag.
    const variants = ['Water', 'Plant', 'Electric', 'Earth', 'Wind', 'Light', 'Dark'] as const;
    for (const tag of variants) {
      const store = speciesRowToStore({
        id: 1,
        name: 'X',
        baseHp: 1,
        baseAttack: 1,
        baseDefense: 1,
        baseSpeed: 1,
        baseSpAttack: 1,
        baseSpDefense: 1,
        affinity: { tag },
        learnableSkillIds: [],
      });
      expect(store.affinity).toBe(tag);
    }
  });
});
