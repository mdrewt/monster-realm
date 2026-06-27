// rowConvert — SDK generated row -> normalized store row (M4a + M6c extension).
// M6c adds monsterPubRowToStore and speciesRowToStore.
import { describe, expect, it } from 'vitest';
import {
  battleRowToStore,
  characterRowToStore,
  monsterPubRowToStore,
  playerRowToStore,
  type SdkBattleRow,
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
