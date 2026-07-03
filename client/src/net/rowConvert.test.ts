// rowConvert — SDK generated row -> normalized store row (M4a + M6c extension).
// M6c adds monsterPubRowToStore and speciesRowToStore.
// M9c adds inventoryRowToStore and itemRowToStore.
import { describe, expect, it } from 'vitest';
import {
  battleRowToStore,
  characterRowToStore,
  fusionRowToStore,
  inventoryRowToStore,
  itemRowToStore,
  monsterPubRowToStore,
  playerRowToStore,
  type SdkBattleRow,
  type SdkFusionRow,
  type SdkInventoryRow,
  type SdkItemRowRow,
  type SdkSkillRowRow,
  skillRowToStore,
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

// =============================================================================
// M7c extension: battleRowToStore + skillRowToStore
// SOURCE OF TRUTH: specs/monster-realm-v2/M7-battle-view.spec.md
// =============================================================================

// ---------------------------------------------------------------------------
// Minimal SDK row shapes (structural stubs — the real generated rows satisfy these)
// ---------------------------------------------------------------------------

/** SDK BattleMonster shape (nested stats, tagged-union affinity). */
function sdkBattleMonster(
  speciesId: number,
  affinity: string,
  level: number,
  currentHp: number,
  maxHp: number,
  stats: {
    hp: number;
    attack: number;
    defense: number;
    speed: number;
    spAttack: number;
    spDefense: number;
  },
  knownSkillIds: readonly number[],
) {
  return { speciesId, affinity: { tag: affinity }, level, currentHp, maxHp, stats, knownSkillIds };
}

/** Constructs a minimal valid SdkBattleRow for testing (matches the actual SDK shape:
 *  state wraps sideA/sideB/outcome/turnNumber; BattleMonster has nested stats object). */
function makeSdkBattleRow(
  stateOverrides: {
    outcome?: { tag: string };
    turnNumber?: number;
    sideA?: { active: number; team: ReturnType<typeof sdkBattleMonster>[] };
    sideB?: { active: number; team: ReturnType<typeof sdkBattleMonster>[] };
  } = {},
): SdkBattleRow {
  const defaultSideA = {
    active: 0,
    team: [
      sdkBattleMonster(
        7,
        'Fire',
        10,
        40,
        50,
        { hp: 50, attack: 60, defense: 45, speed: 55, spAttack: 70, spDefense: 50 },
        [1, 3],
      ),
    ],
  };
  const defaultSideB = {
    active: 0,
    team: [
      sdkBattleMonster(
        2,
        'Water',
        8,
        30,
        35,
        { hp: 35, attack: 40, defense: 55, speed: 48, spAttack: 42, spDefense: 58 },
        [2],
      ),
    ],
  };
  return {
    battleId: 42n,
    playerIdentity: { toHexString: () => 'aabbcc' },
    opponentIdentity: { toHexString: () => 'ddeeff' },
    state: {
      sideA: stateOverrides.sideA ?? defaultSideA,
      sideB: stateOverrides.sideB ?? defaultSideB,
      outcome: stateOverrides.outcome ?? { tag: 'Ongoing' },
      turnNumber: stateOverrides.turnNumber ?? 3,
    },
    partyMonsterIds: [100n, 101n],
    opponentMonsterIds: [200n],
    createdAtMs: 9999n,
  };
}

describe('rowConvert M7c: battleRowToStore — SDK row -> StoreBattle', () => {
  it('BITES: battleId stays bigint; identities become hex strings via toHexString()', () => {
    // Kills: an impl that downcasts battleId to number (lossy for u64) or
    // that stores the SDK identity object instead of calling toHexString().
    const store = battleRowToStore(makeSdkBattleRow());
    expect(typeof store.battleId).toBe('bigint');
    expect(store.battleId).toBe(42n);
    expect(typeof store.playerIdentity).toBe('string');
    expect(store.playerIdentity).toBe('aabbcc');
    expect(typeof store.opponentIdentity).toBe('string');
    expect(store.opponentIdentity).toBe('ddeeff');
  });

  it('BITES: outcome tagged union {tag:"Ongoing"} is flattened to bare string "Ongoing"', () => {
    // Kills: an impl that stores the object {tag:'Ongoing'} instead of 'Ongoing',
    // breaking every downstream outcome==='Ongoing' check.
    const store = battleRowToStore(makeSdkBattleRow({ outcome: { tag: 'Ongoing' } }));
    expect(typeof store.outcome).toBe('string');
    expect(store.outcome).toBe('Ongoing');
  });

  it('BITES: each outcome variant is flattened correctly', () => {
    // Kills: an impl that only handles 'Ongoing' and leaves other tags as objects.
    for (const tag of ['SideAWins', 'SideBWins', 'Fled']) {
      const store = battleRowToStore(makeSdkBattleRow({ outcome: { tag } }));
      expect(store.outcome).toBe(tag);
    }
  });

  it('BITES: nested BattleMonster affinity {tag:"Fire"} is flattened to "Fire"', () => {
    // Kills: an impl that passes through the tagged-union object for nested monster affinity.
    const store = battleRowToStore(makeSdkBattleRow());
    expect(typeof store.sideA.team[0]!.affinity).toBe('string');
    expect(store.sideA.team[0]!.affinity).toBe('Fire');
    expect(typeof store.sideB.team[0]!.affinity).toBe('string');
    expect(store.sideB.team[0]!.affinity).toBe('Water');
  });

  it('BITES: nested stats object is flattened (stats.hp -> statHp, etc.)', () => {
    // Kills: an impl that leaves a nested stats sub-object instead of spreading
    // stat fields onto the StoreBattleMonster directly (the store interface is flat).
    const store = battleRowToStore(makeSdkBattleRow());
    const mon = store.sideA.team[0]!;
    expect(mon.statHp).toBe(50);
    expect(mon.statAttack).toBe(60);
    expect(mon.statDefense).toBe(45);
    expect(mon.statSpeed).toBe(55);
    expect(mon.statSpAttack).toBe(70);
    expect(mon.statSpDefense).toBe(50);
    // Confirm the raw SDK nested shape is NOT present
    expect((mon as unknown as Record<string, unknown>).stats).toBeUndefined();
  });

  it('BITES: turnNumber, currentHp, maxHp, level, speciesId stay as numbers', () => {
    // Kills: an impl that accidentally bigints numeric fields or stringifies them.
    const store = battleRowToStore(makeSdkBattleRow());
    expect(typeof store.turnNumber).toBe('number');
    expect(store.turnNumber).toBe(3);
    const mon = store.sideA.team[0]!;
    expect(typeof mon.speciesId).toBe('number');
    expect(mon.speciesId).toBe(7);
    expect(typeof mon.level).toBe('number');
    expect(mon.level).toBe(10);
    expect(typeof mon.currentHp).toBe('number');
    expect(mon.currentHp).toBe(40);
    expect(typeof mon.maxHp).toBe('number');
    expect(mon.maxHp).toBe(50);
  });

  it('BITES: partyMonsterIds and opponentMonsterIds stay as bigint arrays', () => {
    // Kills: an impl that converts bigint monster ids to numbers (lossy for u64).
    const store = battleRowToStore(makeSdkBattleRow());
    expect(store.partyMonsterIds).toEqual([100n, 101n]);
    expect(store.opponentMonsterIds).toEqual([200n]);
    for (const id of store.partyMonsterIds) expect(typeof id).toBe('bigint');
    for (const id of store.opponentMonsterIds) expect(typeof id).toBe('bigint');
  });

  it('BITES: knownSkillIds on each BattleMonster stays as number array', () => {
    // Kills: an impl that bigints skill ids (they are u32 — safe as number).
    const store = battleRowToStore(makeSdkBattleRow());
    expect(store.sideA.team[0]!.knownSkillIds).toEqual([1, 3]);
    for (const id of store.sideA.team[0]!.knownSkillIds) expect(typeof id).toBe('number');
  });

  it('BITES: createdAtMs stays bigint', () => {
    // Kills: an impl that converts the timestamp to number (lossy for large u64 ms values).
    const store = battleRowToStore(makeSdkBattleRow());
    expect(typeof store.createdAtMs).toBe('bigint');
    expect(store.createdAtMs).toBe(9999n);
  });

  it('BITES: sideA.active and sideB.active are preserved correctly', () => {
    // Kills: an impl that hardcodes active=0 instead of reading the field.
    const mon = sdkBattleMonster(
      7,
      'Fire',
      10,
      40,
      50,
      { hp: 50, attack: 60, defense: 45, speed: 55, spAttack: 70, spDefense: 50 },
      [1],
    );
    const row = makeSdkBattleRow({
      sideA: { active: 1, team: [mon, mon] },
    });
    const store = battleRowToStore(row);
    expect(store.sideA.active).toBe(1);
  });
});

describe('rowConvert M7c: skillRowToStore — SDK row -> StoreSkillRow', () => {
  it('BITES: id is number, affinity {tag:"Water"} is flattened to "Water"', () => {
    // Kills: an impl that leaves affinity as the tagged-union object, or that
    // casts id to bigint (skill ids are u32, safe as number).
    const sdk: SdkSkillRowRow = {
      id: 5,
      name: 'Aqua Jet',
      affinity: { tag: 'Water' },
      power: 40,
      accuracy: 100,
      pp: 20,
    };
    const store = skillRowToStore(sdk);
    expect(typeof store.id).toBe('number');
    expect(store.id).toBe(5);
    expect(typeof store.affinity).toBe('string');
    expect(store.affinity).toBe('Water');
    expect(store.name).toBe('Aqua Jet');
  });

  it('BITES: power, accuracy, pp are numbers (not stringified)', () => {
    // Kills: an impl that accidentally serializes numeric fields to strings.
    const sdk: SdkSkillRowRow = {
      id: 1,
      name: 'Ember',
      affinity: { tag: 'Fire' },
      power: 40,
      accuracy: 100,
      pp: 25,
    };
    const store = skillRowToStore(sdk);
    expect(typeof store.power).toBe('number');
    expect(store.power).toBe(40);
    expect(typeof store.accuracy).toBe('number');
    expect(store.accuracy).toBe(100);
    expect(typeof store.pp).toBe('number');
    expect(store.pp).toBe(25);
  });

  it('BITES: each affinity variant is flattened correctly for skills', () => {
    // Kills: an impl that hard-codes Fire or only handles one tag for skills.
    const variants = [
      'Fire',
      'Water',
      'Plant',
      'Electric',
      'Earth',
      'Wind',
      'Light',
      'Dark',
    ] as const;
    for (const tag of variants) {
      const store = skillRowToStore({
        id: 1,
        name: 'X',
        affinity: { tag },
        power: 1,
        accuracy: 1,
        pp: 1,
      });
      expect(store.affinity).toBe(tag);
    }
  });
});

// =============================================================================
// M9c extension: inventoryRowToStore + itemRowToStore
// SOURCE OF TRUTH: specs/monster-realm-v2/M9-raising.spec.md
// =============================================================================

describe('rowConvert M9c: inventoryRowToStore — SDK row -> StoreInventory', () => {
  it('S2: BITES ownerIdentity is resolved via toHexString() (not stored as object)', () => {
    // Kills: an impl that stores row.ownerIdentity directly (an SDK Identity object)
    // instead of calling .toHexString() — downstream equality checks would all fail.
    const sdk: SdkInventoryRow = {
      invId: 1n,
      ownerIdentity: { toHexString: () => 'deadbeef' },
      itemId: 5,
      count: 10,
    };
    const store = inventoryRowToStore(sdk);
    expect(typeof store.ownerIdentity).toBe('string');
    expect(store.ownerIdentity).toBe('deadbeef');
  });

  it('S2: BITES ownerIdentity equality is case-sensitive (DEADBEEF !== deadbeef)', () => {
    // Kills: an impl that normalizes the hex string (e.g. toLowercase/toUpperCase);
    // the store must preserve the exact string returned by toHexString().
    const lowerSdk: SdkInventoryRow = {
      invId: 1n,
      ownerIdentity: { toHexString: () => 'deadbeef' },
      itemId: 5,
      count: 1,
    };
    const upperSdk: SdkInventoryRow = {
      invId: 2n,
      ownerIdentity: { toHexString: () => 'DEADBEEF' },
      itemId: 5,
      count: 1,
    };
    expect(inventoryRowToStore(lowerSdk).ownerIdentity).toBe('deadbeef');
    expect(inventoryRowToStore(upperSdk).ownerIdentity).toBe('DEADBEEF');
    // Must NOT be equal — the store preserves exact case
    expect(inventoryRowToStore(lowerSdk).ownerIdentity).not.toBe(
      inventoryRowToStore(upperSdk).ownerIdentity,
    );
  });

  it('S5: BITES invId stays bigint across the 2^53 boundary (no Number() downcast)', () => {
    // 9007199254740993n (2^53+1) cannot be represented exactly as a JS number.
    // Number(9007199254740993n) === 9007199254740992 (off by one).
    // Kills: an impl that converts invId via Number() or parseInt().
    const largeId = 9007199254740993n; // 2^53 + 1
    const sdk: SdkInventoryRow = {
      invId: largeId,
      ownerIdentity: { toHexString: () => 'abc' },
      itemId: 1,
      count: 1,
    };
    const store = inventoryRowToStore(sdk);
    expect(typeof store.invId).toBe('bigint');
    expect(store.invId).toBe(largeId);
    // Explicit anti-regression: must NOT equal the Number-coerced (wrong) value
    expect(store.invId).not.toBe(9007199254740992n);
  });

  it('BITES: itemId is number and count is number (not bigint)', () => {
    // Kills: an impl that accidentally bigints u32 fields (itemId and count are safe as number).
    const sdk: SdkInventoryRow = {
      invId: 42n,
      ownerIdentity: { toHexString: () => 'ff' },
      itemId: 7,
      count: 100,
    };
    const store = inventoryRowToStore(sdk);
    expect(typeof store.itemId).toBe('number');
    expect(store.itemId).toBe(7);
    expect(typeof store.count).toBe('number');
    expect(store.count).toBe(100);
  });

  it('BITES: all fields are preserved verbatim (no silent field drop)', () => {
    // Kills: an impl that only maps some fields and drops others.
    const sdk: SdkInventoryRow = {
      invId: 99n,
      ownerIdentity: { toHexString: () => 'cafebabe' },
      itemId: 3,
      count: 5,
    };
    const store = inventoryRowToStore(sdk);
    expect(store.invId).toBe(99n);
    expect(store.ownerIdentity).toBe('cafebabe');
    expect(store.itemId).toBe(3);
    expect(store.count).toBe(5);
  });
});

describe('rowConvert M9c: itemRowToStore — SDK row -> StoreItemRow', () => {
  it('S3: BITES trainStat Some({tag:"Speed"}) maps to string "Speed" (not the object)', () => {
    // VERIFIED SDK shape: SpacetimeDB 2.6 decodes Some(StatKind::Speed) as {tag:"Speed"}.
    // Kills: an impl that stores the {tag:"Speed"} object or maps it to "" instead of "Speed".
    const sdk: SdkItemRowRow = {
      id: 1,
      name: 'Speed Berry',
      description: 'Increases speed',
      recruitBonus: 0,
      trainStat: { tag: 'Speed' },
      trainAmount: 10,
    };
    const store = itemRowToStore(sdk);
    expect(typeof store.trainStat).toBe('string');
    expect(store.trainStat).toBe('Speed');
  });

  it('S3: BITES trainStat None (undefined) maps to null (not "" or undefined)', () => {
    // VERIFIED SDK shape: SpacetimeDB 2.6 decodes None as undefined (not null).
    // The store normalizes undefined->null so callers use strict null checks not undefined checks.
    // Kills: an impl that passes through undefined, or uses ?? "" instead of ?? null.
    const sdk: SdkItemRowRow = {
      id: 2,
      name: 'Bait',
      description: 'A simple bait',
      recruitBonus: 5,
      trainStat: undefined,
      trainAmount: 0,
    };
    const store = itemRowToStore(sdk);
    expect(store.trainStat).toBeNull();
    expect(store.trainStat).not.toBeUndefined();
    expect(store.trainStat).not.toBe('');
  });

  it('BITES: all six StatKind tags are mapped correctly (not just Speed)', () => {
    // Kills: an impl that hard-codes one tag or uses a partial mapping table.
    const tags = ['Hp', 'Attack', 'Defense', 'Speed', 'SpAttack', 'SpDefense'] as const;
    for (const tag of tags) {
      const sdk: SdkItemRowRow = {
        id: 1,
        name: 'Item',
        description: '',
        recruitBonus: 0,
        trainStat: { tag },
        trainAmount: 1,
      };
      expect(itemRowToStore(sdk).trainStat).toBe(tag);
    }
  });

  it('BITES: id, recruitBonus, trainAmount are number (not bigint or string)', () => {
    // Kills: an impl that accidentally bigints u32/u16 fields.
    const sdk: SdkItemRowRow = {
      id: 42,
      name: 'Power Root',
      description: 'Boosts attack',
      recruitBonus: 3,
      trainStat: { tag: 'Attack' },
      trainAmount: 20,
    };
    const store = itemRowToStore(sdk);
    expect(typeof store.id).toBe('number');
    expect(store.id).toBe(42);
    expect(typeof store.recruitBonus).toBe('number');
    expect(store.recruitBonus).toBe(3);
    expect(typeof store.trainAmount).toBe('number');
    expect(store.trainAmount).toBe(20);
  });

  it('BITES: name and description are preserved verbatim as strings', () => {
    // Kills: an impl that drops or truncates text fields.
    const sdk: SdkItemRowRow = {
      id: 1,
      name: 'Power Root',
      description: 'Raises the Attack stat when used as food.',
      recruitBonus: 0,
      trainStat: undefined,
      trainAmount: 0,
    };
    const store = itemRowToStore(sdk);
    expect(store.name).toBe('Power Root');
    expect(store.description).toBe('Raises the Attack stat when used as food.');
  });
});

// =============================================================================
// M10c extension: monsterPubRowToStore evolvesTo + fusionRowToStore
// SOURCE OF TRUTH: specs/monster-realm-v2/M10c (Client evolution/fuse UI)
//
// These tests are INTENTIONALLY RED until:
//   - SdkMonsterPubRow gains evolvesTo: number | undefined
//   - monsterPubRowToStore maps evolvesTo through
//   - SdkFusionRow and fusionRowToStore are added to rowConvert.ts
// =============================================================================

describe('rowConvert M10c: monsterPubRowToStore — evolvesTo field', () => {
  it('BITES: evolvesTo: 5 on SDK row is mapped to evolvesTo: 5 on the store row', () => {
    // Kills: an impl that ignores the new evolvesTo field and leaves it undefined
    // even when the SDK row carries a value. Without this field the evolution UI
    // cannot know which monsters are eligible to evolve.
    const store = monsterPubRowToStore({
      monsterId: 1n,
      ownerIdentity: { toHexString: () => 'abc' },
      speciesId: 1,
      nickname: 'Sparky',
      level: 10,
      xp: 0,
      bond: 50,
      currentHp: 30,
      statHp: 40,
      statAttack: 10,
      statDefense: 10,
      statSpeed: 10,
      statSpAttack: 10,
      statSpDefense: 10,
      partySlot: 0,
      evolvesTo: 5,
    } as Parameters<typeof monsterPubRowToStore>[0]);
    expect((store as Record<string, unknown>).evolvesTo).toBe(5);
    expect(typeof (store as Record<string, unknown>).evolvesTo).toBe('number');
  });

  it('BITES: evolvesTo: undefined on SDK row is mapped to evolvesTo: undefined on the store row', () => {
    // Kills: an impl that maps undefined to 0 (a valid species id) or drops the field
    // entirely when undefined — the model must distinguish "no evolution" from "evolves to id 0".
    const store = monsterPubRowToStore({
      monsterId: 2n,
      ownerIdentity: { toHexString: () => 'def' },
      speciesId: 1,
      nickname: '',
      level: 5,
      xp: 0,
      bond: 0,
      currentHp: 20,
      statHp: 20,
      statAttack: 10,
      statDefense: 10,
      statSpeed: 10,
      statSpAttack: 10,
      statSpDefense: 10,
      partySlot: 255,
      evolvesTo: undefined,
    } as Parameters<typeof monsterPubRowToStore>[0]);
    expect((store as Record<string, unknown>).evolvesTo).toBeUndefined();
  });

  it('BITES: evolvesTo is not converted to a string or bigint (must remain number | undefined)', () => {
    // Kills: an impl that accidentally stringifies or bigints the species id.
    const store = monsterPubRowToStore({
      monsterId: 3n,
      ownerIdentity: { toHexString: () => 'ff' },
      speciesId: 2,
      nickname: 'Blaze',
      level: 20,
      xp: 5000,
      bond: 100,
      currentHp: 60,
      statHp: 70,
      statAttack: 55,
      statDefense: 45,
      statSpeed: 65,
      statSpAttack: 75,
      statSpDefense: 55,
      partySlot: 1,
      evolvesTo: 7,
    } as Parameters<typeof monsterPubRowToStore>[0]);
    const evolvesTo = (store as Record<string, unknown>).evolvesTo;
    expect(typeof evolvesTo).toBe('number'); // not 'bigint', not 'string'
    expect(evolvesTo).toBe(7);
  });

  it('BITES: existing fields are still mapped correctly when evolvesTo is present (no regression)', () => {
    // Kills: an impl that maps evolvesTo but accidentally breaks existing field mapping
    // (e.g. by spreading the SDK row instead of picking fields explicitly).
    const store = monsterPubRowToStore({
      monsterId: 99n,
      ownerIdentity: { toHexString: () => 'cafebabe' },
      speciesId: 3,
      nickname: 'Tidal',
      level: 15,
      xp: 1000,
      bond: 60,
      currentHp: 50,
      statHp: 55,
      statAttack: 40,
      statDefense: 45,
      statSpeed: 50,
      statSpAttack: 60,
      statSpDefense: 50,
      partySlot: 2,
      evolvesTo: 8,
    } as Parameters<typeof monsterPubRowToStore>[0]);
    // Existing fields must be unaffected
    expect(store.monsterId).toBe(99n);
    expect(store.ownerIdentity).toBe('cafebabe');
    expect(store.speciesId).toBe(3);
    expect(store.nickname).toBe('Tidal');
    expect(store.level).toBe(15);
    expect(store.bond).toBe(60);
    // New field
    expect((store as Record<string, unknown>).evolvesTo).toBe(8);
  });
});

describe('rowConvert M10c: fusionRowToStore — SdkFusionRow -> StoreFusionRow', () => {
  it('BITES: fusionId stays bigint, aSpecies/bSpecies/toSpecies are numbers', () => {
    // Kills: an impl that converts fusionId to number (lossy for u64) or that
    // bigints the species ids (they are u32, safe as number).
    const sdk: SdkFusionRow = {
      fusionId: 1234567890123456789n,
      aSpecies: 10,
      bSpecies: 20,
      toSpecies: 30,
    };
    const store = fusionRowToStore(sdk);
    expect(typeof store.fusionId).toBe('bigint');
    expect(store.fusionId).toBe(1234567890123456789n);
    expect(typeof store.aSpecies).toBe('number');
    expect(store.aSpecies).toBe(10);
    expect(typeof store.bSpecies).toBe('number');
    expect(store.bSpecies).toBe(20);
    expect(typeof store.toSpecies).toBe('number');
    expect(store.toSpecies).toBe(30);
  });

  it('BITES: fusionId preserves precision across the 2^53 boundary (no Number() coercion)', () => {
    // 9007199254740993n (2^53 + 1) and 9007199254740992n (2^53) are distinct bigints
    // but coerce to the same Number. A Number() conversion would silently corrupt the id.
    // Kills: any impl that converts fusionId via Number() or parseInt().
    const hi = 9007199254740993n; // 2^53 + 1
    const sdk: SdkFusionRow = { fusionId: hi, aSpecies: 1, bSpecies: 2, toSpecies: 3 };
    const store = fusionRowToStore(sdk);
    expect(store.fusionId).toBe(hi);
    expect(store.fusionId).not.toBe(9007199254740992n); // the Number-coerced (wrong) value
  });

  it('BITES: all four fields are present and correct (no silent field drop)', () => {
    // Kills: an impl that omits one of the four required fields from the output.
    const sdk: SdkFusionRow = { fusionId: 42n, aSpecies: 5, bSpecies: 6, toSpecies: 7 };
    const store = fusionRowToStore(sdk);
    expect(store).toHaveProperty('fusionId', 42n);
    expect(store).toHaveProperty('aSpecies', 5);
    expect(store).toHaveProperty('bSpecies', 6);
    expect(store).toHaveProperty('toSpecies', 7);
  });

  it('BITES: distinct aSpecies/bSpecies values are not swapped', () => {
    // Kills: an impl that accidentally swaps aSpecies and bSpecies on output.
    const sdk: SdkFusionRow = { fusionId: 1n, aSpecies: 100, bSpecies: 200, toSpecies: 300 };
    const store = fusionRowToStore(sdk);
    expect(store.aSpecies).toBe(100);
    expect(store.bSpecies).toBe(200);
    expect(store.toSpecies).toBe(300);
  });

  it('BITES: fusionId=0n is preserved as 0n (not treated as falsy/absent)', () => {
    // Kills: an impl that treats fusionId=0n as "no id" and returns undefined or throws.
    const sdk: SdkFusionRow = { fusionId: 0n, aSpecies: 1, bSpecies: 2, toSpecies: 3 };
    const store = fusionRowToStore(sdk);
    expect(store.fusionId).toBe(0n);
    expect(typeof store.fusionId).toBe('bigint');
  });
});

// =============================================================================
// M12d converters: playerConversationRowToStore, playerQuestRowToStore,
//                  healLocationRowToStore, npcRowToStore
// SOURCE OF TRUTH: docs/m12d-plan.md + docs/adr/0071-m12d-client-dialogue-quest-heal-ui.md
//
// RED REASON: None of these 4 converter functions exist yet in rowConvert.ts.
// All tests below will fail (... is not a function) until the implementer adds them.
//
// Key invariants:
//   - ownerIdentity SDK objects must be resolved via .toHexString() to a plain string
//   - pqId must stay bigint (u64, lossy above 2^53 if Number()-ed)
//   - costItemId: undefined (Option<u32> None) must pass through as undefined
//   - entityId must stay bigint
// =============================================================================

import {
  healLocationRowToStore,
  npcRowToStore,
  playerConversationRowToStore,
  playerQuestRowToStore,
} from './rowConvert';

describe('M12d converters', () => {
  // --- playerConversationRowToStore ---

  it('BITES: playerConversationRowToStore — ownerIdentity SDK object → hex string', () => {
    // The SDK sends Identity objects, not plain strings. A store row must carry
    // the hex string so identity comparisons work (=== on objects always fails).
    // Kills: an impl that stores the raw SDK Identity object instead of calling toHexString().
    const sdkRow = {
      ownerIdentity: { toHexString: () => 'abc123' },
      npcEntityId: 5n,
      currentNodeId: 'greeting',
    };
    const store = playerConversationRowToStore(sdkRow);
    expect(typeof store.ownerIdentity).toBe('string');
    expect(store.ownerIdentity).toBe('abc123');
  });

  it('BITES: playerConversationRowToStore — npcEntityId stays bigint', () => {
    // u64 entity ids exceed Number.MAX_SAFE_INTEGER — must stay bigint.
    // Kills: an impl that casts npcEntityId via Number().
    const largeEid = 9007199254740993n; // 2^53 + 1
    const sdkRow = {
      ownerIdentity: { toHexString: () => 'ff' },
      npcEntityId: largeEid,
      currentNodeId: 'node_1',
    };
    const store = playerConversationRowToStore(sdkRow);
    expect(typeof store.npcEntityId).toBe('bigint');
    expect(store.npcEntityId).toBe(largeEid);
  });

  it('BITES: playerConversationRowToStore — currentNodeId passed through as string', () => {
    // Kills: an impl that drops currentNodeId or substitutes a default.
    const sdkRow = {
      ownerIdentity: { toHexString: () => 'aa' },
      npcEntityId: 1n,
      currentNodeId: 'quest_branch_2',
    };
    const store = playerConversationRowToStore(sdkRow);
    expect(store.currentNodeId).toBe('quest_branch_2');
    expect(typeof store.currentNodeId).toBe('string');
  });

  // --- playerQuestRowToStore ---

  it('BITES: playerQuestRowToStore — ownerIdentity.toHexString() called; pqId is bigint', () => {
    // Kills: an impl that stores the raw Identity object, or that Number()-casts pqId.
    const sdkRow = {
      pqId: 9007199254740993n, // 2^53 + 1 — lossy if converted to Number
      ownerIdentity: { toHexString: () => 'deadbeef' },
      questId: 'quest_001',
      stepIndex: 3,
    };
    const store = playerQuestRowToStore(sdkRow);
    expect(typeof store.ownerIdentity).toBe('string');
    expect(store.ownerIdentity).toBe('deadbeef');
    expect(typeof store.pqId).toBe('bigint');
    expect(store.pqId).toBe(9007199254740993n);
  });

  it('BITES: playerQuestRowToStore — stepIndex is number (not bigint)', () => {
    // stepIndex is u32 (safe as number). Kills: an impl that bigints u32 fields.
    const sdkRow = {
      pqId: 1n,
      ownerIdentity: { toHexString: () => 'ff' },
      questId: 'q',
      stepIndex: 7,
    };
    const store = playerQuestRowToStore(sdkRow);
    expect(typeof store.stepIndex).toBe('number');
    expect(store.stepIndex).toBe(7);
  });

  it('BITES: playerQuestRowToStore — questId passed through verbatim as string', () => {
    // Kills: an impl that transforms or truncates questId.
    const sdkRow = {
      pqId: 1n,
      ownerIdentity: { toHexString: () => 'ff' },
      questId: 'some_unique_quest_identifier_v2',
      stepIndex: 0,
    };
    const store = playerQuestRowToStore(sdkRow);
    expect(store.questId).toBe('some_unique_quest_identifier_v2');
  });

  // --- healLocationRowToStore ---

  it('BITES: healLocationRowToStore — costItemId: undefined (Option<u32> None) passes through as undefined', () => {
    // SpacetimeDB 2.6 decodes Option<u32> None as undefined (not null, not 0).
    // The store contract: undefined means "free heal, no item required".
    // Kills: an impl that converts undefined→null or undefined→0 (0 is a valid item id!).
    const sdkRow = {
      locationId: 1,
      zoneId: 0,
      tileX: 10,
      tileY: 15,
      costItemId: undefined,
      costQty: 0,
      cooldownMs: 30000,
    };
    const store = healLocationRowToStore(sdkRow);
    expect(store.costItemId).toBeUndefined();
    expect(store.costItemId).not.toBeNull();
  });

  it('BITES: healLocationRowToStore — costItemId: 2 (Some(2)) passes through as number 2', () => {
    // Kills: an impl that drops costItemId when it is defined.
    const sdkRow = {
      locationId: 5,
      zoneId: 1,
      tileX: 20,
      tileY: 25,
      costItemId: 2,
      costQty: 1,
      cooldownMs: 60000,
    };
    const store = healLocationRowToStore(sdkRow);
    expect(typeof store.costItemId).toBe('number');
    expect(store.costItemId).toBe(2);
  });

  it('BITES: healLocationRowToStore — locationId, zoneId, tileX, tileY, costQty, cooldownMs are numbers', () => {
    // Kills: an impl that accidentally bigints any u32/i64 field other than those
    // that should stay bigint (none in this row — all numeric fields are u32/i64 safe as number).
    const sdkRow = {
      locationId: 7,
      zoneId: 3,
      tileX: 42,
      tileY: 17,
      costItemId: undefined,
      costQty: 0,
      cooldownMs: 45000,
    };
    const store = healLocationRowToStore(sdkRow);
    expect(typeof store.locationId).toBe('number');
    expect(typeof store.zoneId).toBe('number');
    expect(typeof store.tileX).toBe('number');
    expect(typeof store.tileY).toBe('number');
    expect(typeof store.costQty).toBe('number');
    expect(typeof store.cooldownMs).toBe('number');
    expect(store.locationId).toBe(7);
    expect(store.zoneId).toBe(3);
    expect(store.tileX).toBe(42);
    expect(store.tileY).toBe(17);
    expect(store.cooldownMs).toBe(45000);
  });

  // --- npcRowToStore ---

  it('BITES: npcRowToStore — entityId is bigint; all other fields pass through correctly', () => {
    // entityId is u64 (must stay bigint). All other fields are primitive strings/numbers.
    // Kills: an impl that Number()-casts entityId, or that drops any field.
    const largeEid = 9007199254740993n; // 2^53 + 1
    const sdkRow = {
      entityId: largeEid,
      npcId: 'elder_oak',
      zoneId: 0,
      homeX: 12,
      homeY: 8,
      wanderRadius: 3,
      dialogueTreeId: 'elder_oak_talk',
    };
    const store = npcRowToStore(sdkRow);
    expect(typeof store.entityId).toBe('bigint');
    expect(store.entityId).toBe(largeEid);
    expect(store.npcId).toBe('elder_oak');
    expect(typeof store.zoneId).toBe('number');
    expect(store.zoneId).toBe(0);
    expect(store.homeX).toBe(12);
    expect(store.homeY).toBe(8);
    expect(store.wanderRadius).toBe(3);
    expect(store.dialogueTreeId).toBe('elder_oak_talk');
  });

  it('BITES: npcRowToStore — npcId and dialogueTreeId are passed through verbatim (no case change)', () => {
    // Kills: an impl that lowercases, trims, or transforms string fields.
    const sdkRow = {
      entityId: 1n,
      npcId: 'Weird_NPC_ID_v2',
      zoneId: 5,
      homeX: 0,
      homeY: 0,
      wanderRadius: 0,
      dialogueTreeId: 'MyTree_v2',
    };
    const store = npcRowToStore(sdkRow);
    expect(store.npcId).toBe('Weird_NPC_ID_v2');
    expect(store.dialogueTreeId).toBe('MyTree_v2');
  });
});

// =============================================================================
// M12d gating: heal_location_row cooldownMs i64 type invariant
//
// FINDING: schema.rs declares `cooldown_ms: i64` and the generated binding
// types it as `__t.i64()`. SpacetimeDB's TS SDK encodes i64 as bigint (same
// as `move_started_at_ms`, `created_at_ms`, etc.).  However,
// `SdkHealLocationRow` (rowConvert.ts) and `StoreHealLocationRow` (store.ts)
// both type `cooldownMs` as `number`.  The SDK delivers a bigint; the code
// passes it through as-is and types it as number — the type mismatch is
// invisible at runtime until a heal location has a cooldown > 2^53 ms
// (≈285 million years) but the *type contract* diverges from every other i64
// field in the codebase (moveStartedAtMs, createdAtMs — all bigint).
//
// The correct fix is `cooldownMs: bigint` in both SdkHealLocationRow and
// StoreHealLocationRow, matching the pattern established by every other i64.
//
// This test locks that invariant: once fixed, `typeof store.cooldownMs`
// must be 'bigint'. Currently (before fix) it passes number through and the
// test fails — proving the type bug.
// =============================================================================
describe('M12d gating: healLocationRowToStore cooldownMs must be bigint (i64 invariant)', () => {
  it('GATING: cooldownMs from the SDK (i64) must arrive as bigint, not number', () => {
    // The SDK delivers i64 as bigint — same contract as moveStartedAtMs and
    // createdAtMs.  Typing it as number silently truncates values > 2^53 and
    // diverges from the established i64 → bigint pattern throughout rowConvert.
    // Kills: a `number`-typed SdkHealLocationRow.cooldownMs that passes
    // through a bigint SDK value without conversion.
    const sdkRow = {
      locationId: 1,
      zoneId: 0,
      tileX: 8,
      tileY: 3,
      costItemId: undefined,
      costQty: 0,
      // Simulate the SDK delivering a bigint for the i64 column:
      cooldownMs: 30000n as unknown as number,
    };
    const store = healLocationRowToStore(sdkRow);
    // After the fix: SdkHealLocationRow.cooldownMs is bigint and the converter
    // passes it through as bigint.  StoreHealLocationRow.cooldownMs is bigint.
    expect(typeof store.cooldownMs).toBe('bigint');
  });
});
