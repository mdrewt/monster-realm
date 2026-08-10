// rowConvert — SDK generated row -> normalized store row (M4a + M6c extension).
// M6c adds monsterPubRowToStore and speciesRowToStore.
// M9c adds inventoryRowToStore and itemRowToStore.
// uxd2: fast-check is used by the AC-16 totality property at the foot of this file.
import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
// EG4-5 (contract §B "Deleted: … SdkFusionRow, fusionRowToStore …"): the namespace
// import is what lets the deletion tooth at the foot of the fusion section PROVE the
// export is gone at runtime. A named `import { fusionRowToStore }` cannot express
// "this must not exist" — it would either red at module-eval or (once deleted) fail to
// compile; the namespace object is the only runtime-inspectable surface, and
// client/tsconfig.json EXCLUDES **/*.test.ts, so a tsc-only probe would gate nothing.
import * as rowConvertModule from './rowConvert';
import {
  battleRowToStore,
  characterRowToStore,
  // EG4 (contract §B): the evolution_path converter REPLACES fusionRowToStore, which
  // EG4-5 deletes outright together with SdkFusionRow.
  evolutionPathRowToStore,
  inventoryRowToStore,
  itemRowToStore,
  monsterPubRowToStore,
  playerRowToStore,
  type SdkBattleRow,
  type SdkEvolutionPathRow,
  type SdkInventoryRow,
  type SdkItemRowRow,
  type SdkMonsterPubRow,
  type SdkSkillRowRow,
  type SdkTradeOfferRow,
  skillRowToStore,
  speciesRowToStore,
  tradeOfferRowToStore,
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

// ---------------------------------------------------------------------------
// EG4 fixture helper: a full SdkMonsterPubRow.
//
// VERIFIED against client/src/module_bindings/types.ts:335-366 (`MonsterPub`) this
// session: the eight essence columns are FLAT `essenceFire … essenceDark` u32s, and
// `trustTier` is a `TrustTier` enum — which the SDK deserializes as
// `{ tag: 'Neutral', value: {} }`, NOT a bare `{ tag }` (red-team probe, contract
// §"Verified probe facts"). The fixtures below therefore always carry `value: {}`;
// a structural `SdkMonsterPubRow` that assumes a bare `{tag}` is a real drift hazard.
//
// `bond` / `evolvesTo` are DELIBERATELY ABSENT: EG4 removes both from the client type
// (contract §B), and the Sdk* interfaces in rowConvert.ts are documented as "just the
// fields convert reads" — the converter reads neither any more. (Migration B removes
// them from the server row in EG5-6; until then the live SDK row still carries them
// and the converter simply ignores them.)
// ---------------------------------------------------------------------------
function sdkMonsterPub(overrides: Partial<SdkMonsterPubRow> = {}): SdkMonsterPubRow {
  return {
    monsterId: 1n,
    ownerIdentity: { toHexString: () => 'ff' },
    speciesId: 1,
    nickname: '',
    level: 1,
    xp: 0,
    currentHp: 10,
    statHp: 10,
    statAttack: 10,
    statDefense: 10,
    statSpeed: 10,
    statSpAttack: 10,
    statSpDefense: 10,
    partySlot: 255,
    tier: 0,
    essenceFire: 0,
    essenceWater: 0,
    essencePlant: 0,
    essenceElectric: 0,
    essenceEarth: 0,
    essenceWind: 0,
    essenceLight: 0,
    essenceDark: 0,
    trustTier: { tag: 'Neutral', value: {} },
    qualityTimeTier: 0,
    nutritionPct: 0,
    ...overrides,
  };
}

describe('rowConvert M6c: monsterPubRowToStore — SDK row -> StoreMonsterPub', () => {
  it('BITES: monsterId stays bigint, ownerIdentity becomes hex string, stats are numbers', () => {
    // Kills: an impl that downcasts monsterId to number (lossy for u64) or
    // forgets to call toHexString() on identity (leaves an object in the store).
    const store = monsterPubRowToStore(
      sdkMonsterPub({
        monsterId: 12345678901234567890n,
        ownerIdentity: { toHexString: () => 'deadbeef' },
        speciesId: 7,
        nickname: 'Sparky',
        level: 12,
        xp: 3000,
        currentHp: 45,
        statHp: 60,
        statAttack: 55,
        statDefense: 40,
        statSpeed: 70,
        statSpAttack: 65,
        statSpDefense: 50,
        partySlot: 0,
      }),
    );

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
    const store = monsterPubRowToStore(sdkMonsterPub());
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

  // -------------------------------------------------------------------------
  // EG4-1 / EG4-6 / EG4-7 — the essence-graph half of MonsterPub.
  // RED REASON: monsterPubRowToStore (rowConvert.ts:165-184) maps `bond` and
  // `evolvesTo` and knows nothing about tier / the eight essence columns /
  // trustTier / qualityTimeTier / nutritionPct. Missing implementation.
  // -------------------------------------------------------------------------

  it('★ BITES (EG4-1): the EIGHT essence columns map to the affinity-keyed record, each to ITS OWN key', () => {
    // EIGHT DISTINCT VALUES, deliberately. With an all-equal (or all-zero) fixture a
    // Wind/Light — or Plant/Electric, or Earth/Wind — transposition in the converter's
    // hand-written map is completely invisible, and it is exactly the mistake an
    // 8-line literal map invites. Every downstream essence gate (EG4-1's requirements
    // panel, EG4-8's badge) reads through this record, so one swapped key silently
    // mis-reports eligibility for two affinities at once.
    // Kills: any pairwise column transposition; also a record built by ZIPPING the
    // column values against HANDLED_ENUM_VARIANTS.Affinity in the wrong order.
    const store = monsterPubRowToStore(
      sdkMonsterPub({
        essenceFire: 11,
        essenceWater: 22,
        essencePlant: 33,
        essenceElectric: 44,
        essenceEarth: 55,
        essenceWind: 66,
        essenceLight: 77,
        essenceDark: 88,
      }),
    );
    expect(store.essence).toEqual({
      Fire: 11,
      Water: 22,
      Plant: 33,
      Electric: 44,
      Earth: 55,
      Wind: 66,
      Light: 77,
      Dark: 88,
    });
  });

  it('BITES (EG4-1): the essence record has EXACTLY the eight Affinity keys — no extras, none missing', () => {
    // Kills: a record built from a partial map (a missing key reads `undefined` and
    // every comparison against a threshold becomes `undefined >= n` === false, i.e. a
    // permanently unsatisfiable gate that looks like "not enough essence yet").
    const store = monsterPubRowToStore(sdkMonsterPub());
    expect(Object.keys(store.essence).sort()).toEqual(
      ['Dark', 'Earth', 'Electric', 'Fire', 'Light', 'Plant', 'Water', 'Wind'].sort(),
    );
  });

  it('BITES (EG4-6): tier, qualityTimeTier and nutritionPct are mapped as DISTINCT numbers', () => {
    // Three different values so a copy-paste (`qualityTimeTier: row.tier`) is caught.
    // Kills: a converter that maps one of the three from the wrong column, and one
    // that drops a field entirely (undefined !== the asserted number).
    const store = monsterPubRowToStore(
      sdkMonsterPub({ tier: 3, qualityTimeTier: 4, nutritionPct: 87 }),
    );
    expect(store.tier).toBe(3);
    expect(store.qualityTimeTier).toBe(4);
    expect(store.nutritionPct).toBe(87);
    expect(typeof store.tier).toBe('number');
    expect(typeof store.qualityTimeTier).toBe('number');
    expect(typeof store.nutritionPct).toBe('number');
  });

  it('BITES (EG4-6): zero-valued tier / qualityTimeTier / nutritionPct survive (no falsy coercion)', () => {
    // 0 is a REAL value for all three (a tier-0 base-form monster with no quality time
    // and an empty stomach). Kills: `row.tier || 1`, `?? `-with-a-default applied to a
    // non-optional field, or any `if (row.nutritionPct)` gating.
    const store = monsterPubRowToStore(
      sdkMonsterPub({ tier: 0, qualityTimeTier: 0, nutritionPct: 0 }),
    );
    expect(store.tier).toBe(0);
    expect(store.qualityTimeTier).toBe(0);
    expect(store.nutritionPct).toBe(0);
  });

  it('★ BITES (EG4-4/EG4-6): trustTier is NORMALIZED to the bare tag string, for every one of the five variants', () => {
    // The SDK hands over `{ tag: 'Hostile', value: {} }` — a UNIT enum variant still
    // carries `value: {}` (verified probe). Storing the object instead of the tag makes
    // every `===` comparison in trustTierRank fail and the raising status line render
    // "[object Object]".
    // Kills: `trustTier: row.trustTier` (object passthrough); a hard-coded 'Neutral';
    // and a converter that only handles the one variant its author happened to test.
    for (const tag of ['Hostile', 'Wary', 'Neutral', 'Friendly', 'Devoted'] as const) {
      const store = monsterPubRowToStore(sdkMonsterPub({ trustTier: { tag, value: {} } }));
      expect(store.trustTier).toBe(tag);
      expect(typeof store.trustTier).toBe('string');
    }
  });

  it('★ BITES (EG4-7): the store row carries NO `bond` and NO `evolvesTo` key', () => {
    // Both are retired by the essence graph (contract §B "REMOVED: bond, evolvesTo").
    // A converter that keeps mapping them leaves a second, stale source of truth alive:
    // raisingView could keep rendering `Bond` (EG4-4 half-done) and the evolution panel
    // could keep resolving a single `toSpecies` scalar (the EG4-2 auto-resolve defect).
    // Kills: a spread-the-SDK-row converter, and a "leave them, they're harmless" patch.
    const keys = Object.keys(monsterPubRowToStore(sdkMonsterPub()));
    expect(keys).not.toContain('bond');
    expect(keys).not.toContain('evolvesTo');
  });

  it('★ BITES (fail-soft): an UNKNOWN trustTier tag does NOT throw — the row still converts', () => {
    // SDK row callbacks dispatch UNGUARDED (connection.ts:236-247 — `ingestMonster` is
    // called straight from `conn.db.monster_pub.onInsert`), and a throw there kills the
    // whole coalesced transaction burst, not just this row. rowConvert.ts:69-83 states
    // the rule outright: "fail-soft, NEVER throw". A future server-side TrustTier
    // variant must degrade, not blank the world.
    // Kills: `narrowTag`-with-a-throw, a `switch` with a `default: throw`, and a lookup
    // table dereference that explodes on a miss.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let store: ReturnType<typeof monsterPubRowToStore> | undefined;
      expect(() => {
        store = monsterPubRowToStore(
          sdkMonsterPub({ trustTier: { tag: 'Adoring', value: {} }, level: 9 }),
        );
      }).not.toThrow();
      // The rest of the row must still be intact — degraded, never dropped.
      expect(store!.level).toBe(9);
    } finally {
      warnSpy.mockRestore();
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
// EG4 extension: evolutionPathRowToStore REPLACES fusionRowToStore.
// SOURCE OF TRUTH: memory/projects/monster-realm-EG4-contract.md §B + §G
//                  (EARS EG4-1 / EG4-5 / EG4-7).
//
// The M10c `evolvesTo` and `fusionRowToStore` suites that lived here are DELETED,
// not adapted: EG4 removes `evolvesTo` from the client type (contract §B "REMOVED:
// bond, evolvesTo") and EG4-5 deletes `SdkFusionRow` / `fusionRowToStore` outright.
// These are removals from the client type, NOT backfills.
//
// RED REASON: `evolutionPathRowToStore` and `SdkEvolutionPathRow` do not exist in
// client/src/net/rowConvert.ts (verified this session — the file's last converter
// block is the M10c fusion one at :387-404). The VALUE import at the head of this
// file therefore reds either at module-eval time ("does not provide an export named
// evolutionPathRowToStore") or at the first call ("is not a function"), depending on
// how the runner resolves the missing specifier. Either way it is a MISSING
// IMPLEMENTATION, not a typo here — and adding the export is the first thing the
// implementer does, after which the individual teeth below start reporting for
// themselves.
//
// SHAPE VERIFIED against client/src/module_bindings/types.ts:199-222:
//   EvolutionPathRow { pathId u64, edgeId u32, fromSpecies u32, toSpecies u32,
//                      minLevel u8, essence: array(EssenceRequirementRow),
//                      minTrustTier: option(TrustTier),
//                      minQualityTimeTier: option(u8),
//                      minNutritionPct: option(u8) }
//   EssenceRequirementRow { affinity: Affinity, amount: u32 }
//
// THREE VERIFIED SDK DECODE FACTS the fixtures below are built against:
//   1. `t.option(T)` decodes None as **undefined**, never null. The converter
//      normalizes undefined -> null so consumers use `=== null` (contract §B:
//      "null = PERMISSIVE (absent), not lowest tier").
//   2. `t.option(t.u8())` decodes Some(0) as **0** — the falsy-coercion trap is live.
//   3. A UNIT enum variant deserializes to `{ tag: 'Friendly', value: {} }`, NOT a
//      bare `{ tag }`. Every enum fixture below carries `value: {}`.
// =============================================================================

/** Factory: a full SdkEvolutionPathRow with permissive (absent) optional gates.
 *  Absent options are spelled `undefined` — the shape the SDK actually delivers. */
function sdkEvoPath(overrides: Partial<SdkEvolutionPathRow> = {}): SdkEvolutionPathRow {
  return {
    pathId: 1n,
    edgeId: 7,
    fromSpecies: 1,
    toSpecies: 2,
    minLevel: 10,
    essence: [],
    minTrustTier: undefined,
    minQualityTimeTier: undefined,
    minNutritionPct: undefined,
    ...overrides,
  };
}

describe('rowConvert EG4: evolutionPathRowToStore — field-by-field', () => {
  it('BITES: every scalar field is mapped, with pathId staying bigint and the rest numbers', () => {
    // Kills: a converter that drops a field (undefined then silently satisfies or
    // silently blocks a gate downstream) and one that Number()-s the u64 pathId.
    const store = evolutionPathRowToStore(
      sdkEvoPath({
        pathId: 42n,
        edgeId: 11,
        fromSpecies: 7,
        toSpecies: 30,
        minLevel: 15,
      }),
    );
    expect(typeof store.pathId).toBe('bigint');
    expect(store.pathId).toBe(42n);
    expect(store.edgeId).toBe(11);
    expect(store.fromSpecies).toBe(7);
    expect(store.toSpecies).toBe(30);
    expect(store.minLevel).toBe(15);
    expect(typeof store.edgeId).toBe('number');
  });

  it('★ BITES (A1): pathId survives the 2^53 boundary byte-exactly — it is the STORE KEY', () => {
    // `path_id` is a u64 auto_inc and it is the store's Map key (contract §A1). A
    // Number() round-trip merges 2^53 and 2^53+1 into one key, so a content republish
    // would silently drop an edge.
    // Kills: `pathId: Number(row.pathId)`, and a `pathId` typed/stored as number.
    const hi = 9007199254740993n; // 2^53 + 1
    const store = evolutionPathRowToStore(sdkEvoPath({ pathId: hi }));
    expect(store.pathId).toBe(hi);
    expect(store.pathId).not.toBe(9007199254740992n); // the Number-coerced (wrong) value
  });

  it('BITES: edgeId and pathId are NOT interchanged', () => {
    // Kills: the single most plausible converter typo — `pathId: row.edgeId`. It
    // typechecks nowhere (bigint vs number) but a `BigInt(row.edgeId)` "fix" does, and
    // it would make every republished row collide on the same handful of keys.
    const store = evolutionPathRowToStore(sdkEvoPath({ pathId: 500n, edgeId: 3 }));
    expect(store.pathId).toBe(500n);
    expect(store.edgeId).toBe(3);
  });

  it('BITES: fromSpecies and toSpecies are NOT swapped', () => {
    // Kills: a transposition that would make every edge point backwards — the panel
    // would offer to evolve a monster into its own pre-evolution.
    const store = evolutionPathRowToStore(sdkEvoPath({ fromSpecies: 100, toSpecies: 200 }));
    expect(store.fromSpecies).toBe(100);
    expect(store.toSpecies).toBe(200);
  });
});

describe('★ rowConvert EG4 (A10): the essence requirement list stays an ORDERED ARRAY', () => {
  it('★ BITES: essence maps to an ordered array of {affinity, amount}, NOT an affinity-keyed record', () => {
    // Rust evaluates the requirement LIST with `.all()` (game-core eligibility), and a
    // DUPLICATE affinity is legal content. Collapsing the list to a Record is last-wins:
    // `[(Fire,900),(Fire,150)]` becomes `{Fire:150}` and a Fire-200 monster reads as
    // ELIGIBLE when the server says it is not. The list ORDER is load-bearing too — it
    // is the order `unmetRequirement` reports the first unmet gate in.
    // Kills: `Object.fromEntries(row.essence.map(...))` and any record-shaped port.
    const store = evolutionPathRowToStore(
      sdkEvoPath({
        essence: [
          { affinity: { tag: 'Fire', value: {} }, amount: 900 },
          { affinity: { tag: 'Fire', value: {} }, amount: 150 },
          { affinity: { tag: 'Water', value: {} }, amount: 10 },
        ],
      }),
    );
    expect(Array.isArray(store.essence)).toBe(true);
    expect(store.essence).toEqual([
      { affinity: 'Fire', amount: 900 },
      { affinity: 'Fire', amount: 150 },
      { affinity: 'Water', amount: 10 },
    ]);
    // Explicit anti-collapse assertion: both Fire entries survive, in authored order.
    expect(store.essence).toHaveLength(3);
    expect(store.essence.filter((e) => e.affinity === 'Fire')).toHaveLength(2);
  });

  it('BITES: each requirement affinity is normalized from the tagged union to a bare string', () => {
    // Kills: `affinity: req.affinity` (object passthrough) — every `===` against an
    // AffinityName in the eligibility port would then be false and no essence gate
    // could ever be satisfied.
    const store = evolutionPathRowToStore(
      sdkEvoPath({
        essence: [{ affinity: { tag: 'Electric', value: {} }, amount: 5 }],
      }),
    );
    expect(store.essence[0]!.affinity).toBe('Electric');
    expect(typeof store.essence[0]!.affinity).toBe('string');
  });

  it('BITES: an EMPTY essence list maps to an empty array (a permissive gate), not to undefined', () => {
    // Kills: `essence: row.essence.length ? … : undefined`. Downstream the port does
    // `p.essence.every(...)`; undefined throws inside an unguarded subscription
    // callback and takes the whole transaction burst with it.
    const store = evolutionPathRowToStore(sdkEvoPath({ essence: [] }));
    expect(store.essence).toEqual([]);
    expect(Array.isArray(store.essence)).toBe(true);
  });

  it('BITES: amount 0 is preserved (not dropped as falsy)', () => {
    // Kills: a `.filter((e) => e.amount)` "cleanup" — a 0-amount requirement is a
    // trivially-satisfied gate that must still RENDER in the progress panel.
    const store = evolutionPathRowToStore(
      sdkEvoPath({ essence: [{ affinity: { tag: 'Dark', value: {} }, amount: 0 }] }),
    );
    expect(store.essence).toEqual([{ affinity: 'Dark', amount: 0 }]);
  });

  it('★ BITES (fail-soft): an UNKNOWN Affinity tag in a requirement does NOT throw', () => {
    // `conn.db.evolution_path.onInsert` dispatches this converter UNGUARDED (the same
    // shape as connection.ts:236-247's ingestMonster), and rowConvert.ts:69-83 states
    // the rule: "fail-soft, NEVER throw" — a throw inside a subscription callback kills
    // the entire coalesced flushBatch burst, not just this row.
    // Kills: a `switch (tag) { default: throw }` mapping and an index-into-a-table
    // dereference that explodes on a miss.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let store: ReturnType<typeof evolutionPathRowToStore> | undefined;
      expect(() => {
        store = evolutionPathRowToStore(
          sdkEvoPath({
            edgeId: 77,
            essence: [{ affinity: { tag: 'Cosmic', value: {} }, amount: 5 }],
          }),
        );
      }).not.toThrow();
      // Degraded, never dropped: the rest of the row must still be intact.
      expect(store!.edgeId).toBe(77);
      expect(store!.essence).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('★ rowConvert EG4: the three Option thresholds normalize absent -> null', () => {
  it('★ BITES: an ABSENT (undefined) option becomes null — never undefined', () => {
    // VERIFIED SDK FACT: `t.option(T)` decodes None as **undefined**, never null. The
    // store contract (§B) says `TrustTierName | null`, with null meaning PERMISSIVE.
    // Kills: a passthrough that leaves `undefined` on the row — `undefined === null` is
    // false, so a `threshold === null` permissive check silently turns every absent
    // gate into an unsatisfiable one, and every path in the game becomes ineligible.
    const store = evolutionPathRowToStore(
      sdkEvoPath({
        minTrustTier: undefined,
        minQualityTimeTier: undefined,
        minNutritionPct: undefined,
      }),
    );
    expect(store.minTrustTier).toBeNull();
    expect(store.minQualityTimeTier).toBeNull();
    expect(store.minNutritionPct).toBeNull();
    // Explicit: not merely "falsy" — the exact null the contract names.
    expect(store.minTrustTier).not.toBeUndefined();
    expect(store.minQualityTimeTier).not.toBeUndefined();
    expect(store.minNutritionPct).not.toBeUndefined();
  });

  it('★ BITES: Some(0) on BOTH u8 options survives as 0 — the falsy-coercion trap', () => {
    // VERIFIED SDK FACT: `t.option(t.u8())` decodes Some(0) as `0`. A converter written
    // as `row.minQualityTimeTier || null` turns an authored `Some(0)` — a REAL, if
    // trivially satisfied, gate — into "no gate at all", which silently DELETES a row
    // from the EG4-1 progress panel. `nutrition 0%` is likewise a real authored value.
    // Kills: `||`-based normalization anywhere in this converter. Only `?? null` /
    // an explicit `=== undefined` check passes.
    const store = evolutionPathRowToStore(
      sdkEvoPath({ minQualityTimeTier: 0, minNutritionPct: 0 }),
    );
    expect(store.minQualityTimeTier).toBe(0);
    expect(store.minNutritionPct).toBe(0);
    expect(store.minQualityTimeTier).not.toBeNull();
    expect(store.minNutritionPct).not.toBeNull();
  });

  it('BITES: non-zero Some(n) values pass through on BOTH u8 options, not swapped', () => {
    // Two DISTINCT values so a copy-paste (`minNutritionPct: row.minQualityTimeTier`)
    // is caught — the two gates would otherwise be indistinguishable in any fixture
    // that used the same number for both.
    const store = evolutionPathRowToStore(
      sdkEvoPath({ minQualityTimeTier: 2, minNutritionPct: 60 }),
    );
    expect(store.minQualityTimeTier).toBe(2);
    expect(store.minNutritionPct).toBe(60);
  });

  it('★ BITES: Some(TrustTier) normalizes to the BARE TAG STRING for all five variants', () => {
    // The SDK delivers `{ tag: 'Friendly', value: {} }` for a UNIT variant — the
    // `value: {}` key is real and a structural Sdk* interface that assumes a bare
    // `{tag}` is a drift hazard. Storing the object makes `trustTierRank(threshold)`
    // read `undefined` and the trust gate unsatisfiable.
    // Kills: object passthrough; a hard-coded single tag; a converter that only
    // handles the variant its author tested.
    for (const tag of ['Hostile', 'Wary', 'Neutral', 'Friendly', 'Devoted'] as const) {
      const store = evolutionPathRowToStore(sdkEvoPath({ minTrustTier: { tag, value: {} } }));
      expect(store.minTrustTier).toBe(tag);
      expect(typeof store.minTrustTier).toBe('string');
    }
  });

  it("★ BITES: minTrustTier 'Hostile' is NOT collapsed to null (lowest tier is a REAL threshold)", () => {
    // The permissive sentinel is `null` = ABSENT. `Some(Hostile)` is a real (if
    // trivially satisfied) authored gate that must still render a row in the
    // requirements panel. Conflating the two loses the distinction the contract calls
    // out explicitly: "null = PERMISSIVE (absent), not 'lowest tier'".
    // Kills: a converter that maps the lowest tier to null "because it's a no-op".
    const store = evolutionPathRowToStore(
      sdkEvoPath({ minTrustTier: { tag: 'Hostile', value: {} } }),
    );
    expect(store.minTrustTier).toBe('Hostile');
    expect(store.minTrustTier).not.toBeNull();
  });

  it('★ BITES (fail-soft): an UNKNOWN trustTier tag does NOT throw and does NOT become null', () => {
    // Two teeth in one. (a) No throw — an unguarded row callback would take the whole
    // burst down. (b) It must NOT be silently normalized to `null`: null means
    // PERMISSIVE, so a future server variant would turn an unrecognized threshold into
    // NO threshold and grant phantom eligibility — the exact fail-OPEN direction the
    // contract's A2 adjudication forbids. Passing the raw tag through keeps the gate
    // unsatisfiable (fail-closed) in the eligibility port.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      let store: ReturnType<typeof evolutionPathRowToStore> | undefined;
      expect(() => {
        store = evolutionPathRowToStore(
          sdkEvoPath({ minTrustTier: { tag: 'Adoring', value: {} } }),
        );
      }).not.toThrow();
      expect(store!.minTrustTier).not.toBeNull();
      expect(typeof store!.minTrustTier).toBe('string');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// RED-TEAM ADDITION (gap against contract §G, EG4-5 row): that row names
// `rowConvert.test.ts` as one of the three files that must prove "a partial deletion
// leaving dead wiring" reds — but the authored suite only DELETED the fusion describe
// block and swapped the import specifier. Deleting a test is not a gate: nothing here
// asserted that `fusionRowToStore` / `SdkFusionRow` actually left rowConvert.ts.
//
// They could survive as live exports. `SdkFusionRow` is type-only (erased), but
// `fusionRowToStore` is a runtime export, and connection.test.ts's whole-file scan only
// proves connection.ts stopped IMPORTING it — a dead-but-exported converter satisfies
// every other gate in this slice and is precisely the shape a half-done EG4-5 takes.
//
// Runtime probe on the module namespace, not a type probe: client/tsconfig.json excludes
// **/*.test.ts, so a tsc-only assertion would gate nothing at all.
// ---------------------------------------------------------------------------
describe('★ rowConvert EG4-5: the fusion converter surface is DELETED from the module', () => {
  it('★ BITES: rowConvert exports no fusionRowToStore', () => {
    // Kills: leaving the converter exported "because nothing calls it" — dead wiring that
    // still compiles, still ships in the bundle, and reads to the next author as if fusion
    // were still a supported path.
    const exported = rowConvertModule as unknown as Record<string, unknown>;
    expect(
      exported.fusionRowToStore,
      'fusionRowToStore must be deleted from rowConvert.ts (contract §B "Deleted: … ' +
        'SdkFusionRow, fusionRowToStore …"). RED TODAY: it is still exported.',
    ).toBeUndefined();
  });

  it('★ BITES: the replacement converter IS exported (anti-vacuity for the deletion above)', () => {
    // Without this, "fusion is gone" would be satisfied by deleting the feature instead
    // of replacing it — the same anti-vacuity frame store.test.ts uses for its own
    // fusion-surface deletion gate.
    const exported = rowConvertModule as unknown as Record<string, unknown>;
    expect(typeof exported.evolutionPathRowToStore).toBe('function');
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
      // 12r-d: `costCurrency` becomes a REQUIRED bigint on SdkHealLocationRow /
      // StoreHealLocationRow. Carried here so this pre-existing fixture still describes a
      // well-formed row after the type change (its assertions are untouched).
      costCurrency: 0n,
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
      costCurrency: 0n, // 12r-d: required field, carried so the fixture stays well-formed.
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
      costCurrency: 0n, // 12r-d: required field, carried so the fixture stays well-formed.
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
// uxd2 (ADR-0161 D1/AC-16) — npcRowToStore: the NpcInteraction boundary converter.
// APPENDED BLOCK — nothing above this line is modified.
//
// SOURCE OF TRUTH: docs/specs/uxd2-plan.md I5 + AC-16 + docs/adr/0161-*.md §D1.
//
// CONTRACT:
//   SdkNpcRow += readonly interaction: { readonly tag: string; readonly value?: number }
//   StoreNpcRow += readonly interaction:
//        { kind:'dialogue' } | { kind:'shop'; shopId:number } | { kind:'heal'; locationId:number }
//
//   CONVERSION TABLE (TOTAL — never throws, for ANY tag/value pair):
//     tag 'Dialogue'                     -> { kind:'dialogue' }
//     tag 'Shop', typeof value==='number'-> { kind:'shop',   shopId: value }
//     tag 'Heal', typeof value==='number'-> { kind:'heal',   locationId: value }
//     ANY other tag                      -> { kind:'dialogue' }   (no throw)
//     'Shop'/'Heal' with a missing or non-numeric value -> { kind:'dialogue' } (no throw)
//
// WHY TOTALITY (AC-16): this converter runs inside a SpacetimeDB subscription callback.
// A throw there is not caught by the app — it aborts the row-callback batch and leaves the
// store half-applied. An unknown tag is exactly what a NEWER server module (a 4th
// NpcInteraction variant) sends to an older client, so it MUST degrade, never crash.
//
// WHY `??`/typeof AND NOT `||` (AC-16, rowConvert.ts:277 precedent): value 0 is a
// representable u32 payload. `value || fallback` silently rewrites shop 0 / location 0.
//
// RED TODAY: npcRowToStore ignores `row.interaction` entirely, so `store.interaction`
// reads `undefined` and every assertion below fails. No throw is involved — these are
// plain value mismatches, i.e. red for exactly the right reason.
// =============================================================================

/** Build a well-formed SdkNpcRow with a caller-chosen interaction payload. */
function sdkNpc(interaction: { tag: string; value?: number }): {
  entityId: bigint;
  npcId: string;
  zoneId: number;
  homeX: number;
  homeY: number;
  wanderRadius: number;
  dialogueTreeId: string;
  interaction: { tag: string; value?: number };
} {
  return {
    entityId: 2n,
    npcId: 'tideglass_shopkeeper',
    zoneId: 1,
    homeX: 8,
    homeY: 1,
    wanderRadius: 0,
    dialogueTreeId: 'shopkeeper_greeting',
    interaction,
  };
}

describe('uxd2 AC-16: npcRowToStore normalises the NpcInteraction enum (total, no throw)', () => {
  it('BITES: tag "Dialogue" → { kind: "dialogue" }', () => {
    // WRONG IMPL KILLED: a converter that drops the field (today's behaviour) or that
    // stores the raw SDK `{tag, value}` shape — the resolver + dialogue VM both switch on
    // `kind`, so a raw tag would make every NPC fall through to the default arm.
    expect(npcRowToStore(sdkNpc({ tag: 'Dialogue' })).interaction).toEqual({ kind: 'dialogue' });
  });

  it('BITES: tag "Shop" with value 1 → { kind: "shop", shopId: 1 }', () => {
    // WRONG IMPL KILLED: a converter that maps every tag to 'dialogue' — the shopkeeper
    // would greet and never offer a Shop action (the whole slice, silently inert).
    expect(npcRowToStore(sdkNpc({ tag: 'Shop', value: 1 })).interaction).toEqual({
      kind: 'shop',
      shopId: 1,
    });
  });

  it('★ BITES (falsy-0 tooth): tag "Shop" with value 0 → { kind: "shop", shopId: 0 }', () => {
    // THE `||` TRAP. `shopId: row.interaction.value || 0` happens to survive this one, but
    // `value || undefined` / `if (!value) return {kind:'dialogue'}` — the natural shapes a
    // "guard against a missing payload" reflex produces — both convert a legitimate shop 0
    // into a plain dialogue NPC. Only a `typeof value === 'number'` guard passes.
    expect(npcRowToStore(sdkNpc({ tag: 'Shop', value: 0 })).interaction).toEqual({
      kind: 'shop',
      shopId: 0,
    });
  });

  it('BITES: tag "Heal" with value 2 → { kind: "heal", locationId: 2 }', () => {
    // WRONG IMPL KILLED: a converter that stores the Heal payload under `shopId` (a
    // copy-paste of the Shop arm) — main.ts's heal arm would bind the wrong overlay.
    expect(npcRowToStore(sdkNpc({ tag: 'Heal', value: 2 })).interaction).toEqual({
      kind: 'heal',
      locationId: 2,
    });
  });

  it('★ BITES (falsy-0 tooth): tag "Heal" with value 0 → { kind: "heal", locationId: 0 }', () => {
    // Same `||` trap on the Heal arm — pinned separately so a half-fix (Shop hardened, Heal
    // left on truthiness) still reds.
    expect(npcRowToStore(sdkNpc({ tag: 'Heal', value: 0 })).interaction).toEqual({
      kind: 'heal',
      locationId: 0,
    });
  });

  it('★ BITES: an UNKNOWN tag degrades to { kind: "dialogue" } and does NOT throw', () => {
    // AC-16 subscription-callback totality. A newer server module with a 4th variant
    // (e.g. `Trainer(u32)`) sends a tag this client has never heard of.
    // WRONG IMPL KILLED: `throw new Error('unhandled NpcInteraction tag')` — an exhaustive
    // `never`-check pattern copied from the Rust side. Inside an SDK onInsert callback that
    // aborts the batch and the store is left half-applied for the rest of the session.
    let out!: ReturnType<typeof npcRowToStore>;
    expect(() => {
      out = npcRowToStore(sdkNpc({ tag: 'Trainer', value: 5 }));
    }).not.toThrow();
    expect(out.interaction).toEqual({ kind: 'dialogue' });
  });

  it('★ BITES: tag "Shop" with a MISSING value degrades to { kind: "dialogue" } (no throw)', () => {
    // WRONG IMPL KILLED: `shopId: row.interaction.value!` — a non-null assertion. The store
    // would carry `shopId: undefined`, the dialogue VM would render a Shop button, and the
    // click would open `buildShopViewModelForShop(undefined, …)` → a dead "no shop" overlay.
    let out!: ReturnType<typeof npcRowToStore>;
    expect(() => {
      out = npcRowToStore(sdkNpc({ tag: 'Shop' }));
    }).not.toThrow();
    expect(out.interaction).toEqual({ kind: 'dialogue' });
  });

  it('BITES: tag "Heal" with a NON-NUMERIC value degrades to { kind: "dialogue" } (no throw)', () => {
    // WRONG IMPL KILLED: a `value !== undefined` guard (rather than `typeof === 'number'`) —
    // a string payload from a schema drift would be stored as a locationId and every
    // downstream `===` comparison against a number would silently never match.
    const malformed = { tag: 'Heal', value: '2' } as unknown as { tag: string; value?: number };
    let out!: ReturnType<typeof npcRowToStore>;
    expect(() => {
      out = npcRowToStore(sdkNpc(malformed));
    }).not.toThrow();
    expect(out.interaction).toEqual({ kind: 'dialogue' });
  });

  it('BITES: tag "Dialogue" with a stray value still yields exactly { kind: "dialogue" }', () => {
    // WRONG IMPL KILLED: an impl that keys off the PRESENCE of `value` rather than the tag
    // (e.g. `value !== undefined ? shop : dialogue`) — a Dialogue variant that the SDK
    // happens to serialise with a 0 payload would become a shop.
    const out = npcRowToStore(sdkNpc({ tag: 'Dialogue', value: 9 }));
    expect(out.interaction).toEqual({ kind: 'dialogue' });
    expect(Object.keys(out.interaction).sort()).toEqual(['kind']);
  });

  it('BITES: the other npc fields are unaffected by the new interaction field', () => {
    // WRONG IMPL KILLED: an impl that rewrites the converter around the new field and drops
    // one of the seven originals (entityId is the u64 one that must stay bigint).
    const out = npcRowToStore(sdkNpc({ tag: 'Shop', value: 1 }));
    expect(typeof out.entityId).toBe('bigint');
    expect(out.entityId).toBe(2n);
    expect(out.npcId).toBe('tideglass_shopkeeper');
    expect(out.zoneId).toBe(1);
    expect(out.homeX).toBe(8);
    expect(out.homeY).toBe(1);
    expect(out.wanderRadius).toBe(0);
    expect(out.dialogueTreeId).toBe('shopkeeper_greeting');
  });

  it('★ BITES fast-check: TOTAL — any tag/value pair converts to one of the 3 kinds without throwing', () => {
    // AC-16 as a property: the converter is a boundary function, so its totality must hold
    // over the whole input space, not just the 9 hand-written rows above.
    // WRONG IMPL KILLED: any residual throw path (an exhaustive switch's default arm, a
    // `JSON.parse`, a non-null assertion) reachable only from an input shape nobody enumerated.
    // Block-body arrow per [[vitest-fast-check]] — an expression body would hand fast-check
    // the matcher's return value and report a spurious counterexample.
    fc.assert(
      fc.property(
        fc.string(),
        fc.option(fc.integer({ min: -5, max: 5 }), { nil: undefined }),
        (tag, value) => {
          let out!: ReturnType<typeof npcRowToStore>;
          expect(() => {
            out = npcRowToStore(sdkNpc({ tag, value }));
          }).not.toThrow();
          expect(
            out.interaction,
            'npcRowToStore must always emit an interaction field (RED today: it emits none)',
          ).toBeDefined();
          expect(['dialogue', 'shop', 'heal']).toContain(out.interaction.kind);
          // And the payload arms are internally consistent (no `shopId: undefined`).
          if (out.interaction.kind === 'shop') {
            expect(typeof out.interaction.shopId).toBe('number');
          }
          if (out.interaction.kind === 'heal') {
            expect(typeof out.interaction.locationId).toBe('number');
          }
        },
      ),
    );
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
      costCurrency: 0n, // 12r-d: required field, carried so the fixture stays well-formed.
    };
    const store = healLocationRowToStore(sdkRow);
    // After the fix: SdkHealLocationRow.cooldownMs is bigint and the converter
    // passes it through as bigint.  StoreHealLocationRow.cooldownMs is bigint.
    expect(typeof store.cooldownMs).toBe('bigint');
  });
});

// =============================================================================
// M13d converters: shopRowToStore, shopItemRowToStore
//                  itemRowToStore gains sellPrice field
// SOURCE OF TRUTH: specs/monster-realm-v2/M13d (shop client UI slice)
//
// RED REASON: shopRowToStore and shopItemRowToStore don't exist yet.
//   SdkShopRowRow and SdkShopItemRowRow interfaces don't exist yet.
//   SdkItemRowRow is missing sellPrice field.
//   All tests below will fail until the implementer adds them.
//
// Key invariants:
//   - shopId and itemId are number (u32, safe as number)
//   - shopItemId, buyPrice, sellPrice are bigint (u64/u128 – keep bigint)
//   - sellPrice on itemRowToStore: passes through as-is (0n or positive)
// =============================================================================

import {
  type SdkShopItemRowRow,
  type SdkShopRowRow,
  shopItemRowToStore,
  shopRowToStore,
} from './rowConvert';

// [m13d-8] sellPrice passthrough in itemRowToStore
describe('rowConvert M13d: itemRowToStore — sellPrice field passthrough [m13d-8]', () => {
  it('[m13d-8] BITES: sellPrice=100n on SDK row → sellPrice=100n on store row', () => {
    // Kills: an impl that omits sellPrice from the converter or defaults it to 0n.
    const sdk: SdkItemRowRow = {
      id: 3,
      name: 'Herb',
      description: 'A healing herb',
      recruitBonus: 0,
      trainStat: undefined,
      trainAmount: 0,
      sellPrice: 100n,
    };
    const store = itemRowToStore(sdk);
    expect((store as Record<string, unknown>).sellPrice).toBe(100n);
    expect(typeof (store as Record<string, unknown>).sellPrice).toBe('bigint');
  });

  it('[m13d-8] BITES: sellPrice=0n on SDK row → sellPrice=0n on store row (not undefined or omitted)', () => {
    // Kills: an impl that omits sellPrice when it is 0n or treats 0n as falsy/missing.
    const sdk: SdkItemRowRow = {
      id: 5,
      name: 'Quest Key',
      description: 'Cannot be sold',
      recruitBonus: 0,
      trainStat: undefined,
      trainAmount: 0,
      sellPrice: 0n,
    };
    const store = itemRowToStore(sdk);
    expect((store as Record<string, unknown>).sellPrice).toBe(0n);
    expect((store as Record<string, unknown>).sellPrice).not.toBeUndefined();
    expect((store as Record<string, unknown>).sellPrice).not.toBeNull();
  });

  it('[m13d-8] BITES: sellPrice stays bigint (not converted to number)', () => {
    // Kills: an impl that Number()-casts sellPrice (lossy for large values).
    const largeSellPrice = 9007199254740993n; // 2^53 + 1 — lossy if Number()-cast
    const sdk: SdkItemRowRow = {
      id: 1,
      name: 'Rare Gem',
      description: 'Very expensive',
      recruitBonus: 0,
      trainStat: undefined,
      trainAmount: 0,
      sellPrice: largeSellPrice,
    };
    const store = itemRowToStore(sdk);
    expect(typeof (store as Record<string, unknown>).sellPrice).toBe('bigint');
    expect((store as Record<string, unknown>).sellPrice).toBe(largeSellPrice);
    // Ensure it's not the Number-coerced (wrong) value
    expect((store as Record<string, unknown>).sellPrice).not.toBe(9007199254740992n);
  });

  it('[m13d-8] BITES: existing fields still correct when sellPrice is added (no regression)', () => {
    // Kills: an impl that adds sellPrice by spreading the SDK row, accidentally
    // breaking existing field mappings (e.g., trainStat object not flattened).
    const sdk: SdkItemRowRow = {
      id: 2,
      name: 'Power Root',
      description: 'Boosts attack',
      recruitBonus: 3,
      trainStat: { tag: 'Attack' },
      trainAmount: 10,
      sellPrice: 50n,
    };
    const store = itemRowToStore(sdk);
    expect(store.id).toBe(2);
    expect(store.name).toBe('Power Root');
    expect(store.trainStat).toBe('Attack'); // must still flatten {tag:'Attack'} → 'Attack'
    expect(store.trainAmount).toBe(10);
    expect(store.recruitBonus).toBe(3);
    expect((store as Record<string, unknown>).sellPrice).toBe(50n);
  });
});

// [m13d-9] shopRowToStore converts correctly
describe('rowConvert M13d: shopRowToStore — SdkShopRowRow -> StoreShopRow [m13d-9]', () => {
  it('[m13d-9] BITES: shopRowToStore({ shopId: 1, name: "General Store" }) → { shopId: 1, name: "General Store" }', () => {
    // Kills: an impl that doesn't exist yet (RED) or that drops either field.
    const sdk: SdkShopRowRow = { shopId: 1, name: 'General Store' };
    const store = shopRowToStore(sdk);
    expect(store.shopId).toBe(1);
    expect(store.name).toBe('General Store');
  });

  it('[m13d-9] BITES: shopId is number (u32, not bigint)', () => {
    // Kills: an impl that bigints the shopId field.
    const sdk: SdkShopRowRow = { shopId: 42, name: 'Magic Shop' };
    const store = shopRowToStore(sdk);
    expect(typeof store.shopId).toBe('number');
    expect(store.shopId).toBe(42);
  });

  it('[m13d-9] BITES: name is preserved verbatim as string (no trimming or case change)', () => {
    // Kills: an impl that lowercases or trims the shop name.
    const sdk: SdkShopRowRow = { shopId: 3, name: 'The Grand Bazaar v2' };
    const store = shopRowToStore(sdk);
    expect(store.name).toBe('The Grand Bazaar v2');
    expect(typeof store.name).toBe('string');
  });

  it('[m13d-9] BITES: both fields are present on output (no silent field drop)', () => {
    // Kills: an impl that returns only one of the two required fields.
    const sdk: SdkShopRowRow = { shopId: 7, name: 'Item World' };
    const store = shopRowToStore(sdk);
    expect(store).toHaveProperty('shopId', 7);
    expect(store).toHaveProperty('name', 'Item World');
  });
});

// [m13d-10] shopItemRowToStore converts correctly
describe('rowConvert M13d: shopItemRowToStore — SdkShopItemRowRow -> StoreShopItemRow [m13d-10]', () => {
  it('[m13d-10] BITES: shopItemRowToStore({ shopItemId:5n, shopId:1, itemId:3, buyPrice:50n }) → exact passthrough', () => {
    // Kills: an impl that doesn't exist yet (RED) or that converts any field incorrectly.
    const sdk: SdkShopItemRowRow = { shopItemId: 5n, shopId: 1, itemId: 3, buyPrice: 50n };
    const store = shopItemRowToStore(sdk);
    expect(store.shopItemId).toBe(5n);
    expect(store.shopId).toBe(1);
    expect(store.itemId).toBe(3);
    expect(store.buyPrice).toBe(50n);
  });

  it('[m13d-10] BITES: shopItemId stays bigint (u64 — lossy if Number()-cast)', () => {
    // shopItemId is u64 — must stay bigint to avoid precision loss above 2^53.
    // Kills: an impl that Number()-casts shopItemId.
    const largeId = 9007199254740993n; // 2^53 + 1
    const sdk: SdkShopItemRowRow = { shopItemId: largeId, shopId: 1, itemId: 2, buyPrice: 10n };
    const store = shopItemRowToStore(sdk);
    expect(typeof store.shopItemId).toBe('bigint');
    expect(store.shopItemId).toBe(largeId);
    expect(store.shopItemId).not.toBe(9007199254740992n); // the Number-coerced (wrong) value
  });

  it('[m13d-10] BITES: buyPrice stays bigint (u64 — lossy if Number()-cast)', () => {
    // buyPrice is u64 — must stay bigint.
    // Kills: an impl that Number()-casts buyPrice.
    const largeBuyPrice = 9007199254740994n;
    const sdk: SdkShopItemRowRow = {
      shopItemId: 1n,
      shopId: 1,
      itemId: 1,
      buyPrice: largeBuyPrice,
    };
    const store = shopItemRowToStore(sdk);
    expect(typeof store.buyPrice).toBe('bigint');
    expect(store.buyPrice).toBe(largeBuyPrice);
  });

  it('[m13d-10] BITES: shopId and itemId are number (u32, safe as number)', () => {
    // Kills: an impl that bigints shopId or itemId.
    const sdk: SdkShopItemRowRow = { shopItemId: 1n, shopId: 10, itemId: 20, buyPrice: 5n };
    const store = shopItemRowToStore(sdk);
    expect(typeof store.shopId).toBe('number');
    expect(store.shopId).toBe(10);
    expect(typeof store.itemId).toBe('number');
    expect(store.itemId).toBe(20);
  });

  it('[m13d-10] BITES: all four fields are present on output (no silent field drop)', () => {
    // Kills: an impl that omits any of the four required fields from the store row.
    const sdk: SdkShopItemRowRow = { shopItemId: 99n, shopId: 3, itemId: 7, buyPrice: 200n };
    const store = shopItemRowToStore(sdk);
    expect(store).toHaveProperty('shopItemId', 99n);
    expect(store).toHaveProperty('shopId', 3);
    expect(store).toHaveProperty('itemId', 7);
    expect(store).toHaveProperty('buyPrice', 200n);
  });

  it('[m13d-10] BITES: distinct shopId and itemId values are not swapped', () => {
    // Kills: an impl that accidentally swaps shopId and itemId on output.
    const sdk: SdkShopItemRowRow = { shopItemId: 1n, shopId: 100, itemId: 200, buyPrice: 1n };
    const store = shopItemRowToStore(sdk);
    expect(store.shopId).toBe(100);
    expect(store.itemId).toBe(200);
  });

  it('[m13d-10] BITES: shopItemId=0n is preserved as 0n (not treated as falsy/absent)', () => {
    // Kills: an impl that treats shopItemId=0n as "no id" and returns undefined or throws.
    const sdk: SdkShopItemRowRow = { shopItemId: 0n, shopId: 1, itemId: 1, buyPrice: 0n };
    const store = shopItemRowToStore(sdk);
    expect(store.shopItemId).toBe(0n);
    expect(typeof store.shopItemId).toBe('bigint');
  });
});

// =============================================================================
// m14.5d-1b — cureStatus field in itemRowToStore
// SOURCE OF TRUTH: specs/monster-realm-v2/M14.5-eighth-review-residuals.spec.md §14.5d-1
//
// RED REASON: SdkItemRowRow does not yet have a `cureStatus` field, and
// itemRowToStore does not yet map it. StoreItemRow does not yet have a
// `cureStatus` field. All tests below will fail (TypeScript compile error or
// wrong-value assertion) until the implementer adds:
//   - `cureStatus?: { readonly tag: string } | undefined` to SdkItemRowRow
//   - `cureStatus: string | null` to StoreItemRow (store.ts)
//   - mapping logic in itemRowToStore: Some({tag}) → tag string, None/undefined → null
//
// Classify-by-data rule: the client infers cure intent from cureStatus !== null
// (the data itself), never from a hardcoded item id.
//
// ANTI-PATTERN: `row.cureStatus?.tag || null` maps {tag:""} → null (falsy tag trap).
// Correct: `row.cureStatus != null ? row.cureStatus.tag : null`.
// =============================================================================

describe('rowConvert m14.5d-1b: itemRowToStore — cureStatus field [m14.5d-1b]', () => {
  it('[m14.5d-1b] BITES: cureStatus Some({tag:"Poison"}) → string "Poison" (not the object)', () => {
    // The SDK delivers Option<StatusKind> as {tag:"Poison"} for Some, undefined for None.
    // The store must carry the bare string tag — not the {tag} object.
    // Kills: an impl that stores the {tag:"Poison"} object (downstream === checks all fail),
    // or that maps it to undefined instead of the string.
    const sdk: SdkItemRowRow = {
      id: 1,
      name: 'Antidote',
      description: 'Cures poison',
      recruitBonus: 0,
      trainStat: undefined,
      trainAmount: 0,
      sellPrice: 50n,
      cureStatus: { tag: 'Poison' },
    };
    const store = itemRowToStore(sdk);
    expect((store as Record<string, unknown>).cureStatus).toBe('Poison');
    expect(typeof (store as Record<string, unknown>).cureStatus).toBe('string');
  });

  it('[m14.5d-1b] BITES: cureStatus None (undefined) → null (not undefined, not "")', () => {
    // SpacetimeDB 2.6 decodes Option<StatusKind> None as undefined.
    // The store normalizes undefined → null so callers use strict null checks,
    // not undefined checks (matches the trainStat pattern).
    // Kills: an impl that passes through undefined, or uses ?? "" instead of ?? null.
    const sdk: SdkItemRowRow = {
      id: 2,
      name: 'Potion',
      description: 'Restores HP',
      recruitBonus: 0,
      trainStat: undefined,
      trainAmount: 0,
      sellPrice: 30n,
      // cureStatus field absent/undefined (None)
    };
    const store = itemRowToStore(sdk);
    expect((store as Record<string, unknown>).cureStatus).toBeNull();
    expect((store as Record<string, unknown>).cureStatus).not.toBeUndefined();
    expect((store as Record<string, unknown>).cureStatus).not.toBe('');
  });

  it('[m14.5d-1b] BITES: cureStatus field is present (and null) on rows with no cure_status', () => {
    // The field must always be present on StoreItemRow — not just when non-null.
    // Downstream code can use `item.cureStatus !== null` without optional chaining.
    // Kills: an impl that omits the cureStatus key from the returned object when undefined.
    const sdk: SdkItemRowRow = {
      id: 3,
      name: 'Berry',
      description: 'A basic item',
      recruitBonus: 5,
      trainStat: undefined,
      trainAmount: 0,
      sellPrice: 10n,
    };
    const store = itemRowToStore(sdk);
    expect(Object.keys(store as Record<string, unknown>)).toContain('cureStatus');
    expect((store as Record<string, unknown>).cureStatus).toBeNull();
  });

  it('[m14.5d-1b] BITES: all 5 StatusKind tags round-trip correctly (not just Poison)', () => {
    // Kills: an impl that hard-codes "Poison" or only handles one tag in the mapping.
    const tags = ['Poison', 'Burn', 'Paralysis', 'Sleep', 'Freeze'] as const;
    for (const tag of tags) {
      const sdk: SdkItemRowRow = {
        id: 1,
        name: `${tag} Cure`,
        description: `Cures ${tag}`,
        recruitBonus: 0,
        trainStat: undefined,
        trainAmount: 0,
        sellPrice: 40n,
        cureStatus: { tag },
      };
      const store = itemRowToStore(sdk);
      expect(
        (store as Record<string, unknown>).cureStatus,
        `cureStatus for tag "${tag}" must be the bare string`,
      ).toBe(tag);
    }
  });

  it('[m14.5d-1b] BITES: existing fields are still correct when cureStatus is present (no regression)', () => {
    // Kills: an impl that adds cureStatus by spreading the SDK row, accidentally
    // breaking existing field mappings (e.g., trainStat {tag} not flattened).
    const sdk: SdkItemRowRow = {
      id: 5,
      name: 'Antidote',
      description: 'Cures poison in battle',
      recruitBonus: 0,
      trainStat: undefined,
      trainAmount: 0,
      sellPrice: 50n,
      cureStatus: { tag: 'Poison' },
    };
    const store = itemRowToStore(sdk);
    expect(store.id).toBe(5);
    expect(store.name).toBe('Antidote');
    expect(store.trainStat).toBeNull(); // must still flatten undefined → null
    expect(store.trainAmount).toBe(0);
    expect(store.sellPrice).toBe(50n);
    expect((store as Record<string, unknown>).cureStatus).toBe('Poison');
  });
});

// =============================================================================
// m14.5d — weather threading: state.weather -> StoreBattle.weather
// SOURCE OF TRUTH: specs/monster-realm-v2/M14.5-eighth-review-residuals.spec.md §14.5d-2
//
// RED REASON: SdkBattleRow.state does not yet have a `weather` field, and
// battleRowToStore does not yet map it. StoreBattle does not yet have a `weather`
// field either. All four tests below will fail (missing field / undefined access)
// until the implementer adds:
//   - `weather?: { readonly tag: string; readonly value: number } | null` to SdkBattleRow.state
//   - `weather: StoreWeather | null` to StoreBattle (store.ts)
//   - mapping logic in battleRowToStore: present → { tag, turnsRemaining: value },
//     absent/undefined/null → null
//
// KEY ANTI-PATTERN (reviewer B-1 + red-team 6):
//   `?.value || null` would map value:0 → null (zero-falsy trap).
//   The correct mapping is `weather != null ? { tag: weather.tag, turnsRemaining: weather.value } : null`
//   so that turnsRemaining:0 is preserved exactly as 0.
// =============================================================================

/** Extends SdkBattleRow.state with the optional weather field for m14.5d tests. */
type SdkBattleRowWithWeather = Omit<ReturnType<typeof makeSdkBattleRow>, 'state'> & {
  state: ReturnType<typeof makeSdkBattleRow>['state'] & {
    weather?: { readonly tag: string; readonly value: number } | null;
  };
};

function makeSdkBattleRowWithWeather(
  weather: { readonly tag: string; readonly value: number } | null | undefined,
): SdkBattleRowWithWeather {
  const base = makeSdkBattleRow();
  return {
    ...base,
    state: {
      ...base.state,
      ...(weather !== undefined ? { weather } : {}),
    },
  } as SdkBattleRowWithWeather;
}

describe('rowConvert m14.5d: battleRowToStore — weather field threading', () => {
  it('BITES: state.weather {tag:"Rain", value:3} → StoreBattle.weather {tag:"Rain", turnsRemaining:3}', () => {
    // Kills: an impl that omits weather from battleRowToStore, or that passes
    // the raw SDK shape through (leaving .value instead of .turnsRemaining).
    // Reviewer B-1: explicit value→turnsRemaining rename is required, parallel to
    // status.value→turnsRemaining at rowConvert.ts line 211.
    const row = makeSdkBattleRowWithWeather({ tag: 'Rain', value: 3 });
    const store = battleRowToStore(row as unknown as ReturnType<typeof makeSdkBattleRow>);
    const weather = (store as Record<string, unknown>).weather as {
      tag: string;
      turnsRemaining: number;
    } | null;
    expect(weather).not.toBeNull();
    expect(weather!.tag).toBe('Rain');
    expect(weather!.turnsRemaining).toBe(3);
  });

  it('BITES: state.weather {tag:"Rain", value:0} → turnsRemaining === 0 (zero-falsy trap)', () => {
    // Red-team 6 / reviewer B-1: `?.value || null` would coerce 0 → null.
    // The correct impl uses explicit null-check: `weather != null ? {...value} : null`.
    // Kills: any impl that uses `|| null` or `&& { turnsRemaining: value }` patterns
    // where falsy value (0) gets swallowed.
    const row = makeSdkBattleRowWithWeather({ tag: 'Rain', value: 0 });
    const store = battleRowToStore(row as unknown as ReturnType<typeof makeSdkBattleRow>);
    const weather = (store as Record<string, unknown>).weather as {
      tag: string;
      turnsRemaining: number;
    } | null;
    expect(weather).not.toBeNull();
    expect(weather!.turnsRemaining).toBe(0);
  });

  it('BITES: state.weather null → StoreBattle.weather null', () => {
    // Kills: an impl that maps null → undefined, or that crashes on null input.
    const row = makeSdkBattleRowWithWeather(null);
    const store = battleRowToStore(row as unknown as ReturnType<typeof makeSdkBattleRow>);
    const weather = (store as Record<string, unknown>).weather;
    expect(weather).toBeNull();
  });

  it('BITES: state.weather absent (field not present) → StoreBattle.weather null', () => {
    // Kills: an impl that leaves weather as undefined when the SDK field is absent.
    // StoreBattle.weather must be null (not undefined) — null is the typed sentinel
    // meaning "no active weather"; undefined would escape the strict null check and
    // silently propagate as an absent field in downstream model/view code.
    // Backward-compat proof: existing SdkBattleRow factories that omit weather must
    // still produce a valid StoreBattle where weather===null.
    const row = makeSdkBattleRowWithWeather(undefined); // field absent from state
    const store = battleRowToStore(row as unknown as ReturnType<typeof makeSdkBattleRow>);
    const weather = (store as Record<string, unknown>).weather;
    // null is the required sentinel; undefined is NOT acceptable.
    expect(weather).toBeNull();
  });
});

// =============================================================================
// m15b: tradeOfferRowToStore — SDK Identity.toHexString() gate (RT-TO-01)
//
// The trade_offer table is PUBLIC (both parties see all rows — ADR-0106 D3).
// buildTradeViewModel filters by string equality: o.initiator === identity.
// If toHexString() is NOT called on initiator/counterparty in tradeOfferRowToStore,
// the store holds raw Identity objects, and the string equality check always fails —
// the viewer permanently sees "no-trade" even when a live offer involves them.
//
// This is the exact class of bug that already bit playerRowToStore (tested above at line 43)
// and inventoryRowToStore (tested at line S2). These tests exist because toHexString()
// was confirmed necessary. tradeOfferRowToStore is the only m15b converter without
// equivalent teeth. These tests close that gap.
//
// TEETH CONTRACT (what is killed):
//   - An impl that stores raw SDK Identity objects → string equality filter always fails
//   - An impl that calls toString() instead of toHexString() → wrong format
//   - An impl that omits status.tag extraction → raw {tag:'Pending'} in StoreTradeOffer
//   - An impl that casts tradeId/currency to Number() → precision loss past 2^53
// =============================================================================

function makeSdkTradeOfferRow(overrides: Partial<SdkTradeOfferRow> = {}): SdkTradeOfferRow {
  return {
    tradeId: 42n,
    initiator: { toHexString: () => 'aaaa1111' },
    counterparty: { toHexString: () => 'bbbb2222' },
    initiatorMonsterIds: [],
    initiatorItems: [],
    initiatorCurrency: 0n,
    counterpartyMonsterIds: [],
    counterpartyItems: [],
    counterpartyCurrency: 0n,
    initiatorCards: [],
    counterpartyCards: [],
    status: { tag: 'Pending' },
    createdAtMs: 0n,
    ...overrides,
  };
}

describe('rowConvert m15b: tradeOfferRowToStore — identity toHexString() gate (RT-TO-01)', () => {
  it('RT-TO-01a BITES: initiator.toHexString() is called; store field is a string not an object', () => {
    // Kills: an impl that stores the raw SDK Identity object instead of calling toHexString().
    // Downstream: buildTradeViewModel filter (o.initiator === identity) uses string equality;
    // if initiator is an object the filter always fails → viewer always sees no-trade.
    const sdk = makeSdkTradeOfferRow({
      initiator: { toHexString: () => 'deadbeef1234' },
    });
    const stored = tradeOfferRowToStore(sdk);
    expect(typeof stored.initiator).toBe('string');
    expect(stored.initiator).toBe('deadbeef1234');
  });

  it('RT-TO-01b BITES: counterparty.toHexString() is called; store field is a string not an object', () => {
    // Kills: an impl that calls toHexString() on initiator but forgets counterparty.
    // A counterparty-role player would permanently see no-trade.
    const sdk = makeSdkTradeOfferRow({
      counterparty: { toHexString: () => 'cafebabe5678' },
    });
    const stored = tradeOfferRowToStore(sdk);
    expect(typeof stored.counterparty).toBe('string');
    expect(stored.counterparty).toBe('cafebabe5678');
  });

  it('RT-TO-01c BITES: status.tag is extracted; store field is a bare string not a tagged-union object', () => {
    // Kills: an impl that passes { tag: 'Pending' } through unchanged.
    // Downstream: deriveActionsAndLabel compares status === 'ConfirmedByCounterparty' (string equality);
    // if status is an object, the comparison always fails → wrong actions rendered.
    const sdk = makeSdkTradeOfferRow({ status: { tag: 'ConfirmedByCounterparty' } });
    const stored = tradeOfferRowToStore(sdk);
    expect(typeof stored.status).toBe('string');
    expect(stored.status).toBe('ConfirmedByCounterparty');
  });

  it('RT-TO-01d BITES: tradeId stays bigint past 2^53 (no Number() cast)', () => {
    // Kills: an impl that casts tradeId to Number(), losing precision for large server IDs.
    // The identity filter in buildTradeViewModel sorts by tradeId using bigint comparison.
    const largeId = 9007199254740993n; // 2^53 + 1 — lossy as JS number
    const sdk = makeSdkTradeOfferRow({ tradeId: largeId });
    const stored = tradeOfferRowToStore(sdk);
    expect(typeof stored.tradeId).toBe('bigint');
    expect(stored.tradeId).toBe(largeId);
  });

  it('RT-TO-01e BITES: initiatorCurrency and counterpartyCurrency stay bigint past 2^53', () => {
    // Kills: an impl that casts currency fields to Number().
    // buildTradeViewModel passes currency directly to TradeSideViewModel.currency (bigint).
    const largeCurrency = 9007199254740994n;
    const sdk = makeSdkTradeOfferRow({
      initiatorCurrency: largeCurrency,
      counterpartyCurrency: largeCurrency + 1n,
    });
    const stored = tradeOfferRowToStore(sdk);
    expect(typeof stored.initiatorCurrency).toBe('bigint');
    expect(stored.initiatorCurrency).toBe(largeCurrency);
    expect(typeof stored.counterpartyCurrency).toBe('bigint');
    expect(stored.counterpartyCurrency).toBe(largeCurrency + 1n);
  });

  it('RT-TO-01f BITES: initiatorCards and counterpartyCards are mapped (monsterId stays bigint)', () => {
    // Kills: an impl that passes card arrays through as raw SDK objects without mapping.
    // StoreMonsterCard.monsterId is bigint; if cards are not mapped the downstream
    // li.dataset.monsterId = card.monsterId.toString() would produce '[object Object]'.
    const largeMonsterId = 9007199254740995n;
    const sdk = makeSdkTradeOfferRow({
      initiatorCards: [
        {
          monsterId: largeMonsterId,
          speciesId: 3,
          nickname: 'Sparky',
          level: 10,
          currentHp: 20,
          statHp: 30,
        },
      ],
    });
    const stored = tradeOfferRowToStore(sdk);
    expect(stored.initiatorCards).toHaveLength(1);
    expect(typeof stored.initiatorCards[0]!.monsterId).toBe('bigint');
    expect(stored.initiatorCards[0]!.monsterId).toBe(largeMonsterId);
    expect(stored.initiatorCards[0]!.nickname).toBe('Sparky');
  });
});

// =============================================================================
// m17b — profileRowToStore: SdkProfileRow -> StoreProfile (RL-13 boundary ingest)
// SOURCE OF TRUTH: specs/monster-realm-v2/M17-ranked-ladder.spec.md §RL-13 / §RL-15
//
// RED REASON: SdkProfileRow type and profileRowToStore do not exist yet in
// rowConvert.ts. All tests will fail with import errors until the implementer adds:
//   export type SdkProfileRow = {
//     identity: { toHexString(): string };
//     name: string; rating: number; wins: number; losses: number;
//   }
//   export function profileRowToStore(row: SdkProfileRow): StoreProfile
//
// Contract:
//   - identity resolved via .toHexString() to a plain string (never stored as object)
//   - name/rating/wins/losses passed through as-is
//   - rating/wins/losses are typeof 'number' (i32 → number, NOT bigint)
//   - empty name passes through as '' (never normalized to a fallback string)
//   - negative rating passes through (i32 can be negative after rating loss)
//
// WRONG-IMPL-KILLED list:
//   - "identity stored as SDK object"        → toHexString test (RC-PR-01)
//   - "rating biginted"                      → typeof number tests (RC-PR-02/03)
//   - "empty name replaced with fallback"    → empty-name test (RC-PR-04)
//   - "negative rating clamped to 0"         → negative-rating test (RC-PR-05)
//   - "wins/losses dropped or defaulted"     → passthrough test (RC-PR-02)
// =============================================================================

import { profileRowToStore, type SdkProfileRow } from './rowConvert';

/** Factory: minimal valid SdkProfileRow with a mock identity object. */
function makeSdkProfileRow(
  identityHex: string,
  name: string,
  rating: number,
  wins = 0,
  losses = 0,
): SdkProfileRow {
  return {
    identity: { toHexString: () => identityHex },
    name,
    rating,
    wins,
    losses,
  };
}

describe('rowConvert m17b: profileRowToStore — identity via toHexString() (RC-PR-01)', () => {
  it('RC-PR-01a BITES: identity.toHexString() is called; store field is a plain string — kills raw-object impl', () => {
    // Kills: an impl that stores row.identity directly (an SDK Identity object).
    // Downstream: store.profile(identity) uses Map.get() with string keys;
    // if identity is an object, Map.get() always misses (object !== object by reference).
    const sdk = makeSdkProfileRow('deadbeef1234abcd', 'Alice', 1200, 5, 2);
    const stored = profileRowToStore(sdk);
    expect(typeof stored.identity).toBe('string');
    expect(stored.identity).toBe('deadbeef1234abcd');
  });

  it('RC-PR-01b BITES: identity is preserved verbatim (case-sensitive, no normalization)', () => {
    // Kills: an impl that lowercases or uppercases the hex string from toHexString().
    // SpacetimeDB identity hex strings are lowercase; the store must preserve exactly
    // what toHexString() returns.
    const lowerSdk = makeSdkProfileRow('aabbccdd', 'Lower', 1000);
    const upperSdk = makeSdkProfileRow('AABBCCDD', 'Upper', 1000);
    expect(profileRowToStore(lowerSdk).identity).toBe('aabbccdd');
    expect(profileRowToStore(upperSdk).identity).toBe('AABBCCDD');
    expect(profileRowToStore(lowerSdk).identity).not.toBe(profileRowToStore(upperSdk).identity);
  });
});

describe('rowConvert m17b: profileRowToStore — numbers stay numbers (RC-PR-02)', () => {
  it('RC-PR-02a BITES: rating, wins, losses are typeof "number" (i32 → number, NOT bigint)', () => {
    // profile table: rating is i32, wins/losses are u32 — all map to JS number.
    // Kills: an impl that bigints i32/u32 fields by accident (wrong SDK column type).
    const sdk = makeSdkProfileRow('aaa', 'Alice', 1200, 10, 3);
    const stored = profileRowToStore(sdk);
    expect(typeof stored.rating).toBe('number');
    expect(stored.rating).toBe(1200);
    expect(typeof stored.wins).toBe('number');
    expect(stored.wins).toBe(10);
    expect(typeof stored.losses).toBe('number');
    expect(stored.losses).toBe(3);
  });

  it('RC-PR-02b BITES: all five fields are present with correct values (no silent field drop)', () => {
    // Kills: an impl that maps identity + name but forgets wins or losses.
    const sdk = makeSdkProfileRow('cafebabe', 'Bob', 950, 7, 4);
    const stored = profileRowToStore(sdk);
    expect(stored.identity).toBe('cafebabe');
    expect(stored.name).toBe('Bob');
    expect(stored.rating).toBe(950);
    expect(stored.wins).toBe(7);
    expect(stored.losses).toBe(4);
  });

  it('RC-PR-02c BITES: output has exactly the five expected keys (kills spread-the-SDK-row impl)', () => {
    // An impl that spreads the raw SDK row (e.g. `{ ...row, identity: row.identity.toHexString() }`)
    // would leak the SDK Identity object as a second key (the original `identity` before
    // the spread override is processed — or any other extra SDK-only fields the SDK adds
    // in future). The exact key set proves the converter performs explicit field mapping.
    // Kills: `return { ...row, identity: row.identity.toHexString() }` spread impls.
    const sdk = makeSdkProfileRow('deadbeef', 'Alice', 1100, 3, 1);
    const stored = profileRowToStore(sdk);
    const keys = Object.keys(stored as Record<string, unknown>).sort();
    expect(keys).toEqual(['identity', 'losses', 'name', 'rating', 'wins']);
  });
});

describe('rowConvert m17b: profileRowToStore — edge cases (RC-PR-03 / RC-PR-04 / RC-PR-05)', () => {
  it('RC-PR-03 BITES: zero wins and zero losses are preserved (not treated as absent/falsy)', () => {
    // Kills: an impl that defaults wins/losses to undefined when 0, or uses `|| 0`
    // which would hide the correct 0 if the field was already 0 from a different default.
    const sdk = makeSdkProfileRow('aaa', 'Alice', 1000, 0, 0);
    const stored = profileRowToStore(sdk);
    expect(stored.wins).toBe(0);
    expect(stored.losses).toBe(0);
    expect(typeof stored.wins).toBe('number');
    expect(typeof stored.losses).toBe('number');
  });

  it('RC-PR-04 BITES: empty name passes through as "" (not replaced with fallback string)', () => {
    // The server seeds profile.name from player.name at get_or_init_profile.
    // A player with an empty name (rare but valid) must be passed through literally.
    // The display fallback '#<hex8>' is a VIEW-layer concern (leaderboardModel.ts).
    // Kills: an impl that replaces '' with a default string in the converter.
    const sdk = makeSdkProfileRow('abc123', '', 1000);
    const stored = profileRowToStore(sdk);
    expect(stored.name).toBe('');
    expect(typeof stored.name).toBe('string');
  });

  it('RC-PR-05 BITES: negative rating passes through unchanged (i32 can be negative)', () => {
    // After a rating loss from INITIAL_RATING=1000 with a long losing streak,
    // rating could theoretically go below 0 (i32 permits negative values).
    // Kills: an impl that clamps rating to >= 0 in the converter (clamping is a
    // game-rule concern for apply_elo, not a wire-format concern for the converter).
    const sdk = makeSdkProfileRow('bbb', 'Loser', -42, 0, 10);
    const stored = profileRowToStore(sdk);
    expect(stored.rating).toBe(-42);
    expect(typeof stored.rating).toBe('number');
  });
});

// =============================================================================
// m17.5f — narrowTag + HANDLED_ENUM_VARIANTS (EARS 17.5f-3, T4)
// SOURCE OF TRUTH: docs/specs/m17.5f-plan.md §C T4
//
// RED REASON: narrowTag and HANDLED_ENUM_VARIANTS do not exist yet in
// rowConvert.ts. All imports below fail at runtime until the implementer adds:
//
//   export function narrowTag<T extends string>(
//     raw: string,
//     known: readonly T[],
//     enumName: string,
//   ): T
//
//   export const HANDLED_ENUM_VARIANTS = {
//     TradeStatus:     ['Pending', 'ConfirmedByCounterparty'] as const,
//     ChallengeStatus: ['Pending', 'Accepted', 'Declined', 'Cancelled'] as const,
//     BattleOutcome:   ['Ongoing', 'SideAWins', 'SideBWins', 'Fled'] as const,
//     Affinity:        ['Fire','Water','Plant','Electric','Earth','Wind','Light','Dark'] as const,
//     StatusKind:      ['Poison','Burn','Paralysis','Sleep','Freeze'] as const,
//     WeatherEffect:   ['Rain','Sun','Sandstorm','Hail'] as const,
//     ActionState:     ['Idle','Walking','Jumping'] as const,
//     Direction:       ['North','South','East','West'] as const,
//   } as const;
//
// SCOPE: narrowTag is applied at ONE site only — rowConvert.ts:525 (the
//   `as 'Pending' | 'ConfirmedByCounterparty'` cast on row.status.tag).
//   Other .tag reads feed bare-string store fields where narrowing is a type
//   no-op (reviewer W-1/W-5 YAGNI; plan §C T4 §narrowTag applies at ONE site).
//
// PvpAction is EXCLUDED from the registry because rowConvert never READS it
//   (PvpAction is a write-direction enum: the client writes it in submitPvpAction
//   via the hook; the store never ingests a PvpAction .tag field from a row).
//
// WHAT THESE TESTS KILL
// =====================
//   "narrowTag identity miss"  — unknown tag silently assigned as typed union →
//                                consumer compares with valid variant and always
//                                mismatches; the warn test catches the missing log.
//   "narrowTag throws on unknown" — a throw kills the whole flushBatch (no
//                                per-listener isolation; plan B §3); never-throw test.
//   "registry wrong variants"  — a registry that lists stale or wrong variants
//                                would let the eval pass for the wrong types.
//   "registry missing enum key" — the eval cannot check an enum that is not in
//                                the registry; the key-set test enforces coverage.
//   "tradeOfferRowToStore crash on future variant" — if rowConvert.ts throws on
//                                an unknown tag, live subscription batches would
//                                be disrupted; the fail-soft test catches this.
// =============================================================================

import { HANDLED_ENUM_VARIANTS, narrowTag } from './rowConvert';

// ---------------------------------------------------------------------------
// T4-1: narrowTag returns typed value for a known tag (identity for known input)
// ---------------------------------------------------------------------------
describe('rowConvert m17.5f: narrowTag — known tag passes through typed (T4-1)', () => {
  it('BITES: narrowTag("Pending", [...], "TradeStatus") returns "Pending" typed', () => {
    // Kills: an impl that returns undefined or throws for a known tag.
    // A SetMove replayed as a raw append would land on wrong tile — this assertion
    // catches a narrowTag that coerces known tags to something else.
    const result = narrowTag(
      'Pending',
      ['Pending', 'ConfirmedByCounterparty'] as const,
      'TradeStatus',
    );
    expect(result).toBe('Pending');
    expect(typeof result).toBe('string');
  });

  it('BITES: narrowTag("ConfirmedByCounterparty", [...], "TradeStatus") returns the same string', () => {
    // Kills: an impl that only handles the first element of the known array.
    const result = narrowTag(
      'ConfirmedByCounterparty',
      ['Pending', 'ConfirmedByCounterparty'] as const,
      'TradeStatus',
    );
    expect(result).toBe('ConfirmedByCounterparty');
  });

  it('BITES: narrowTag works for each Affinity variant (not just TradeStatus)', () => {
    // Kills: an impl hard-coded only for TradeStatus.
    const affinities = [
      'Fire',
      'Water',
      'Plant',
      'Electric',
      'Earth',
      'Wind',
      'Light',
      'Dark',
    ] as const;
    for (const tag of affinities) {
      const result = narrowTag(tag, affinities, 'Affinity');
      expect(result).toBe(tag);
    }
  });
});

// ---------------------------------------------------------------------------
// T4-2: narrowTag returns raw string AND logs exactly once for unknown tag
// ---------------------------------------------------------------------------
describe('rowConvert m17.5f: narrowTag — unknown tag returns raw string AND logs (T4-2)', () => {
  it('BITES: unknown tag returns the raw string (fail-soft — no throw)', () => {
    // Kills: an impl that returns undefined, null, or the first known variant
    // when encountering an unknown tag (future server addition).
    const result = narrowTag(
      'FutureVariant',
      ['Pending', 'ConfirmedByCounterparty'] as const,
      'TradeStatus',
    );
    // The raw string must be returned — fail-soft passthrough.
    expect(result).toBe('FutureVariant');
  });

  it('BITES: unknown tag logs via console.warn exactly once, message contains enum name and tag', () => {
    // Kills: an impl that silently ignores unknown tags (logging is the audit trail
    // that lets operators detect new server variants after a server-side enum addition).
    // The message must contain both the enum name and the unknown tag so log grep works.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      narrowTag('NewServerVariant', ['Pending', 'ConfirmedByCounterparty'] as const, 'TradeStatus');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0]?.[0] ?? '');
      // The log must contain the enum name so operators know WHICH enum has a new variant.
      expect(message).toContain('TradeStatus');
      // The log must contain the raw tag so operators know WHICH variant is unhandled.
      expect(message).toContain('NewServerVariant');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('BITES: known tag does NOT trigger console.warn (no spurious log noise)', () => {
    // Kills: an impl that logs for every call regardless of whether the tag is known.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      narrowTag('Pending', ['Pending', 'ConfirmedByCounterparty'] as const, 'TradeStatus');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// T4-3: narrowTag NEVER throws (fail-soft for any input — flushBatch isolation)
// ---------------------------------------------------------------------------
describe('rowConvert m17.5f: narrowTag — never throws for any input (T4-3)', () => {
  it('BITES: narrowTag does not throw for an unknown tag (flushBatch has no per-listener isolation)', () => {
    // A throw inside a subscription callback kills the entire flushBatch burst
    // (ADR-0085 A6; rowConvert.ts:1-5 design rationale). narrowTag must NEVER throw.
    // Kills: an impl that throws when the tag is not in the known array.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => {
        narrowTag('AbsolutelyUnknown', ['Pending'] as const, 'SomeEnum');
      }).not.toThrow();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('BITES: narrowTag does not throw for an empty known array', () => {
    // Edge case: an empty known array means every tag is unknown; must still not throw.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(() => {
        narrowTag('AnyTag', [] as const, 'EmptyEnum');
      }).not.toThrow();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// T4-4: tradeOfferRowToStore with {tag:'FutureVariant'} does NOT throw and
//        produces status 'FutureVariant' (fail-soft passthrough via narrowTag)
// ---------------------------------------------------------------------------
describe('rowConvert m17.5f: tradeOfferRowToStore — fail-soft on unknown status tag (T4-4)', () => {
  it('BITES: {tag:"FutureVariant"} does not throw AND produces status "FutureVariant"', () => {
    // A new server-side TradeStatus variant (e.g. 'Expired') must not crash the client.
    // Without narrowTag, the existing `as 'Pending' | 'ConfirmedByCounterparty'` cast
    // would silently assign the wrong type. With narrowTag, the raw value is returned
    // and logged — callers see 'FutureVariant' in status and can handle unknown variants.
    //
    // WHAT THIS KILLS:
    //   - An impl that throws on unknown tag (crashes the subscription batch).
    //   - An impl that returns undefined instead of the raw string (downstream
    //     status === 'Pending' check never matches AND status is undefined — double bug).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sdk: SdkTradeOfferRow = {
        tradeId: 99n,
        initiator: { toHexString: () => 'aaa' },
        counterparty: { toHexString: () => 'bbb' },
        initiatorMonsterIds: [],
        initiatorItems: [],
        initiatorCurrency: 0n,
        counterpartyMonsterIds: [],
        counterpartyItems: [],
        counterpartyCurrency: 0n,
        initiatorCards: [],
        counterpartyCards: [],
        status: { tag: 'FutureVariant' },
        createdAtMs: 0n,
      };

      let stored: ReturnType<typeof tradeOfferRowToStore> | undefined;
      expect(() => {
        stored = tradeOfferRowToStore(sdk);
      }).not.toThrow();

      // The status must be the raw string 'FutureVariant' (fail-soft passthrough).
      // A type assertion is required because StoreTradeOffer.status is typed as
      // 'Pending' | 'ConfirmedByCounterparty'; the raw passthrough widens it at runtime.
      expect((stored as unknown as { status: string }).status).toBe('FutureVariant');

      // The warn was emitted (logged once for the unknown tag).
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// T4-5: HANDLED_ENUM_VARIANTS.TradeStatus deep-equals the current generated variants
// ---------------------------------------------------------------------------
describe('rowConvert m17.5f: HANDLED_ENUM_VARIANTS.TradeStatus — registry matches types.ts (T4-5)', () => {
  it('BITES: TradeStatus registry deep-equals [Pending, ConfirmedByCounterparty]', () => {
    // Verified against client/src/module_bindings/types.ts:
    //   export const TradeStatus = __t.enum("TradeStatus", {
    //     Pending: __t.unit(),
    //     ConfirmedByCounterparty: __t.unit(),
    //   });
    //
    // Kills: an impl that lists stale/extra variants (the eval would flag them,
    // but the unit test catches it immediately in the vitest run).
    expect(HANDLED_ENUM_VARIANTS.TradeStatus).toEqual(['Pending', 'ConfirmedByCounterparty']);
  });
});

// ---------------------------------------------------------------------------
// T4-6: HANDLED_ENUM_VARIANTS registry keys cover exactly the row-read boundary enums
//
// REGISTRY KEY DETERMINATION:
//   Enums that rowConvert reads as .tag fields from SDK rows (boundary reads):
//     ActionState    — characterRowToStore: row.action.tag (SdkCharacterRow.action)
//     Direction      — characterRowToStore: row.facing.tag (SdkCharacterRow.facing)
//     Affinity       — speciesRowToStore: row.affinity.tag; skillRowToStore; battleMonsterToStore
//     BattleOutcome  — battleRowToStore: row.state.outcome.tag
//     StatusKind     — itemRowToStore: row.cureStatus?.tag (SdkItemRowRow.cureStatus)
//     WeatherEffect  — battleRowToStore: row.state.weather?.tag
//     TradeStatus    — tradeOfferRowToStore: row.status.tag (the narrowTag site)
//     ChallengeStatus — battleChallengeRowToStore: row.status.tag
//     NpcInteraction — npcRowToStore: row.interaction.tag  // uxd2: registered — ADR-0161
//     TrustTier      — monsterPubRowToStore: row.trustTier.tag;                  // EG4
//                      evolutionPathRowToStore: row.minTrustTier?.tag
//
//   Excluded (write-direction or non-.tag reads):
//     PvpAction      — the client WRITES this via submitPvpAction; rowConvert never
//                      reads a PvpAction .tag from an incoming row
//     StatKind       — itemRowToStore reads row.trainStat?.tag (a write-direction
//                      enum; the store field trainStat is string|null, not StatKind)
//                      INCLUDED only as a boundary read — verify actual read sites
//     MoveInput      — moveInputToWasm in convert.ts (not rowConvert.ts boundary)
//     StatusEffect   — battleMonsterToStore: row.status?.tag read as bare string
//                      (store.StoreStatusEffect.tag: string — no narrowTag needed)
//
// NOTE: StatKind is read in itemRowToStore as row.trainStat?.tag → bare string
//   (store field is `string | null`). It is a boundary read but the store field
//   is string-typed, not a union — narrowTag is YAGNI here (plan W-1/W-5).
//   So StatKind is NOT in the required set per plan §C T4.
//
// The exact required registry keys are:
//   TradeStatus, ChallengeStatus, BattleOutcome, Affinity,
//   StatusKind, WeatherEffect, ActionState, Direction,
//   NpcInteraction,                       // uxd2: NpcInteraction registered — ADR-0161
//   TrustTier                             // EG4: monsterPubRowToStore reads
//                                         //   row.trustTier.tag and
//                                         //   evolutionPathRowToStore reads
//                                         //   row.minTrustTier?.tag (contract §A7/A8)
// ---------------------------------------------------------------------------
describe('rowConvert m17.5f: HANDLED_ENUM_VARIANTS — registry key set (T4-6)', () => {
  it('BITES: registry contains all TEN required boundary enum keys (EG4: +TrustTier)', () => {
    // These are the enums whose .tag values cross the SDK→store boundary in rowConvert.ts.
    // Verified by reading each .tag access site in rowConvert.ts.
    // Kills: an impl that omits any boundary enum (eval cannot check an unregistered enum).
    const requiredKeys = [
      'TradeStatus',
      'ChallengeStatus',
      'BattleOutcome',
      'Affinity',
      'StatusKind',
      'WeatherEffect',
      'ActionState',
      'Direction',
      // uxd2: NpcInteraction registered — ADR-0161. npcRowToStore reads
      // `row.interaction.tag` at the SDK→store boundary, so a server-added 4th
      // variant MUST ratchet the sdk-enum-exhaustiveness eval RED (plan I5).
      'NpcInteraction',
      // EG4: TrustTier registered. TWO new boundary reads in this slice —
      // `monsterPubRowToStore` reads `row.trustTier.tag` (MonsterPub gained the
      // column in EG1) and `evolutionPathRowToStore` reads
      // `row.minTrustTier?.tag`. A server-side reorder or a 6th variant is
      // invisible to tsc and, unregistered, invisible to the eval too — and the
      // ORDER is semantically load-bearing here in a way no other registry entry
      // is (it is the ranking the trust gate compares through).
      'TrustTier',
    ] as const;
    for (const key of requiredKeys) {
      expect(
        Object.hasOwn(HANDLED_ENUM_VARIANTS, key),
        `HANDLED_ENUM_VARIANTS must contain key '${key}' (boundary read enum)`,
      ).toBe(true);
    }
  });

  it('BITES: registry does NOT contain PvpAction (write-direction, never read by rowConvert)', () => {
    // PvpAction is written by the client (submitPvpAction hook) but never read
    // from an incoming SDK row by rowConvert. Including it would be misleading.
    // Kills: an impl that accidentally registers PvpAction (the eval would then
    // check it against types.ts, but it should never be in the read-boundary set).
    expect(
      Object.hasOwn(HANDLED_ENUM_VARIANTS, 'PvpAction'),
      'HANDLED_ENUM_VARIANTS must NOT contain PvpAction (write-direction enum, not a row-read boundary)',
    ).toBe(false);
  });

  it('BITES: registry has EXACTLY 10 keys — no extra keys allowed (T4-6 exact-count pin)', () => {
    // Exact-count gate: the required set is exactly the boundary-read enums listed
    // in the T4-6 comment above. No more, no less. This kills:
    //   - An impl that adds extra enums (e.g. StatKind, PvpAction, MoveInput) that
    //     are NOT boundary-read enums in rowConvert.ts — the eval would silently
    //     check them against types.ts, masking gaps in the real required set.
    //   - An impl that correctly includes the 9 required keys but also adds extras,
    //     making the registry a superset rather than the exact required set.
    // The presence test above confirms the 9 required keys exist; this test pins
    // that no additional keys were added.
    //
    // uxd2 RECALIBRATION (8 -> 9): NpcInteraction registered — ADR-0161.
    // EG4 RECALIBRATION (9 -> 10): TrustTier registered. Same reasoning as uxd2's: the
    // slice MANDATES the entry (two new `.tag` boundary reads — MonsterPub.trustTier
    // and EvolutionPathRow.minTrustTier), so leaving the pin at 9 would make it
    // impossible for any correct implementation to satisfy both this gate and the
    // key-presence gate above. RED TODAY (the live registry has 9 keys) — correct
    // TDD red, recalibrated FROM the contract, not to fit the code.
    expect(
      Object.keys(HANDLED_ENUM_VARIANTS).length,
      'HANDLED_ENUM_VARIANTS must have EXACTLY 10 keys: TradeStatus, ChallengeStatus, ' +
        'BattleOutcome, Affinity, StatusKind, WeatherEffect, ActionState, Direction, ' +
        'NpcInteraction, TrustTier. ' +
        `Got ${Object.keys(HANDLED_ENUM_VARIANTS).length} keys: ${Object.keys(HANDLED_ENUM_VARIANTS).sort().join(', ')}`,
    ).toBe(10);
  });

  it('★ BITES (EG4): TrustTier registry matches types.ts variants in DECLARATION order', () => {
    // Verified against the generated client/src/module_bindings/types.ts:650-656 this
    // session:
    //   export const TrustTier = __t.enum("TrustTier", {
    //     Hostile: __t.unit(), Wary: __t.unit(), Neutral: __t.unit(),
    //     Friendly: __t.unit(), Devoted: __t.unit(),
    //   });
    // The generator emits variants in RUST DECLARATION order, and for TrustTier that
    // order IS the ranking (ascending hostile -> devoted) the eligibility port compares
    // through — which makes this the one registry entry where order is semantic, not
    // cosmetic.
    //
    // WRONG IMPL KILLED (1): an ALPHABETISED entry ['Devoted','Friendly','Hostile',
    //   'Neutral','Wary'] — it satisfies the sdk-enum-exhaustiveness eval (C2/C3 are
    //   SET-based), the key-presence gate and the exact-count gate above. This array
    //   pin is the only thing standing between the registry and a silent ordering drift.
    // WRONG IMPL KILLED (2): a dropped variant (e.g. only the three tiers some fixture
    //   happened to use) — the eval reds only on regen; this reds at unit speed.
    expect(HANDLED_ENUM_VARIANTS.TrustTier).toEqual([
      'Hostile',
      'Wary',
      'Neutral',
      'Friendly',
      'Devoted',
    ]);
  });

  it('BITES: ChallengeStatus registry matches types.ts variants', () => {
    // Verified against types.ts: ChallengeStatus = {Pending, Accepted, Declined, Cancelled}
    expect(HANDLED_ENUM_VARIANTS.ChallengeStatus).toEqual([
      'Pending',
      'Accepted',
      'Declined',
      'Cancelled',
    ]);
  });

  it('BITES: BattleOutcome registry matches types.ts variants', () => {
    // Verified against types.ts: BattleOutcome = {Ongoing, SideAWins, SideBWins, Fled}
    expect(HANDLED_ENUM_VARIANTS.BattleOutcome).toEqual([
      'Ongoing',
      'SideAWins',
      'SideBWins',
      'Fled',
    ]);
  });

  it('BITES: Affinity registry matches types.ts variants (all 8)', () => {
    // Verified against types.ts: Affinity = {Fire, Water, Plant, Electric, Earth, Wind, Light, Dark}
    expect(HANDLED_ENUM_VARIANTS.Affinity).toEqual([
      'Fire',
      'Water',
      'Plant',
      'Electric',
      'Earth',
      'Wind',
      'Light',
      'Dark',
    ]);
  });

  it('BITES: WeatherEffect registry matches types.ts variants (all payload-carrying)', () => {
    // Verified against types.ts: WeatherEffect = {Rain: __t.u8(), Sun: __t.u8(), Sandstorm: __t.u8(), Hail: __t.u8()}
    // These are payload-carrying variants (__t.u8()) — the KEY names are what matter for tag matching.
    expect(HANDLED_ENUM_VARIANTS.WeatherEffect).toEqual(['Rain', 'Sun', 'Sandstorm', 'Hail']);
  });

  it('BITES: NpcInteraction registry matches types.ts variants in DECLARATION order', () => {
    // uxd2: NpcInteraction registered — ADR-0161.
    //
    // ORDERING CONVENTION (read from rowConvert.ts:55 and verified against the generated
    // client/src/module_bindings/types.ts this session): the registry's variant lists are
    // DECLARATION-ORDERED — they "mirror module_bindings/types.ts EXACTLY", and the SDK
    // generator emits each `__t.enum` variant map in Rust declaration order. They are NOT
    // alphabetical, and every existing entry proves it:
    //     Direction    = North, South, East, West        (alphabetical: East, North, …)
    //     ActionState  = Idle, Walking, Jumping          (alphabetical: Idle, Jumping, …)
    //     BattleOutcome= Ongoing, SideAWins, SideBWins, Fled  (alphabetical: Fled first)
    //     Affinity     = Fire, Water, Plant, Electric, … (not remotely alphabetical)
    // game-core declares `NpcInteraction { #[default] Dialogue, Shop(u32), Heal(u32) }`
    // (plan I0), so `just gen` will emit
    //     __t.enum("NpcInteraction", { Dialogue: __t.unit(), Shop: __t.u32(), Heal: __t.u32() })
    // and the registry entry is therefore ['Dialogue', 'Shop', 'Heal'] — Shop BEFORE Heal.
    //
    // Shop/Heal are payload-carrying (__t.u32()); as with WeatherEffect, only the KEY names
    // matter for tag matching, so the payload type is not pinned here.
    //
    // WRONG IMPL KILLED (1): an alphabetised entry ['Dialogue', 'Heal', 'Shop'] — it would
    //   still satisfy the sdk-enum-exhaustiveness eval (C2/C3 are set-based) and would
    //   still satisfy the key-presence and exact-count gates above, so THIS array pin is
    //   the only thing standing between the registry and a silent drift away from the
    //   file's stated "mirrors types.ts EXACTLY" contract.
    // WRONG IMPL KILLED (2): an entry that omits a variant (e.g. ['Dialogue']) — the eval's
    //   C2 would red on regen, but this pins it at unit speed with the enum named.
    expect(HANDLED_ENUM_VARIANTS.NpcInteraction).toEqual(['Dialogue', 'Shop', 'Heal']);
  });
});

// =============================================================================
// 11r-e (ux2b) — playerWalletRowToStore: the `my_wallet` view row converter
// SOURCE OF TRUTH: docs/adr/0169-wallet-view-runtime-path.md D3, amending
//   docs/adr/0154-owner-scoped-wallet-view.md D1/D6.
//
// EARS 11r-e-2 — WHERE an SDK `my_wallet` row is supplied, playerWalletRowToStore
//   SHALL return `{ownerIdentity: <hex string>, balance: <the same bigint>}`, SHALL
//   preserve `0n` and `18446744073709551615n` byte-identically, and SHALL NOT throw
//   for any well-typed input.
//
// RED REASON (verified by reading client/src/net/rowConvert.ts this session):
//   `playerWalletRowToStore` does NOT exist anywhere in rowConvert.ts. The M12d
//   own-row converter block stops at `playerConversationRowToStore` (rowConvert.ts:416)
//   and `shouldRemoveOnViewDelete` (:444); neither the function nor the
//   `SdkPlayerWalletRow` type is exported. The `import { playerWalletRowToStore, type
//   SdkPlayerWalletRow }` below therefore fails at module-eval time and EVERY test in
//   this section reds. That is a MISSING IMPLEMENTATION, not a typo in this file.
//   (`StoreWallet` DOES already exist — store.ts:185 — because ux2/ADR-0154 shipped the
//   pure client half; only the runtime path is missing. So the `StoreWallet` import
//   below is green today and cannot be the cause of the red.)
//
// REQUIRED CONTRACT (ADR-0169 D3 — the exact shape the implementer must ship, and the
// exact shape these tests call):
//
//   export interface SdkPlayerWalletRow {
//     readonly ownerIdentity: { toHexString(): string };
//     readonly balance: bigint;
//   }
//
//   export function playerWalletRowToStore(row: SdkPlayerWalletRow): StoreWallet {
//     return { ownerIdentity: row.ownerIdentity.toHexString(), balance: row.balance };
//   }
//
// WHY THIS FILE CARRIES REAL BEHAVIORAL TESTS (and connection.test.ts does not):
//   rowConvert.ts is PURE and importable — no DOM, no wasm, no generated-binding side
//   effects — so it is the one surface of this slice where an actual call can be made.
//   connection.ts is coverage-excluded (vite.config.ts:99-100) and can only be source
//   scanned. Neither substitutes for the other.
//
// WHAT THESE TESTS KILL (ADR-0169 D3 names all four wrong implementations):
//   (a) `Number(row.balance)` — silent precision loss at/near u64 MAX plus a type lie
//       (StoreWallet.balance is `bigint`). `50` is exactly representable as a JS number,
//       so NO e2e in this slice can ever see this bug: RC-PW-02b/02c are the only gate.
//   (b) `row.balance ?? 0n` (or `|| 0n`, or `BigInt(row.balance ?? 0)`) — fabricates
//       "broke" out of "dark". shopModel.balanceViewModel (shopModel.ts:75-79) decides
//       `unknown` vs `known` on `typeof amount !== 'bigint'`, so a coerced 0n renders
//       `Gold: 0` where the player actually has NO wallet row at all — the exact
//       ADR-0154 D6 collapse. RC-PW-03b/03c are the only gate (a well-typed row can
//       never trip `??`, so the malformed-input probe is required to see it).
//   (c) `String(row.ownerIdentity)` → `"[object Object]"`. store.ownWallet(identity)
//       (store.ts:992-995) filters `slot.ownerIdentity === identity`, so this makes the
//       owner filter miss FOREVER and the readout is `unknown` in perpetuity — a bug
//       that looks exactly like "the feature was never wired". RC-PW-01a/01b.
//   (d) a THROWING converter — it runs inside a subscription row callback
//       (connection.ts wireTables) and flushBatch has no per-listener isolation
//       (ADR-0085 A6), so one throw starves every sibling table's ingest for that
//       batch. RC-PW-05a/05b.
//   (e) `{ ...row, ownerIdentity: row.ownerIdentity.toHexString() }` — a spread impl
//       leaks whatever extra fields the SDK row carries into the store row. RC-PW-04.
//
// NO `shouldRemoveOnViewDelete` SIBLING IS TESTED HERE, deliberately: ADR-0154 D4
//   forbids a delete gate for wallets (through a view an UPDATE arrives as unordered
//   onInsert(new) + onDelete(old), so the coalesced `I(50) I(100) D(100) D(50)` makes
//   ANY net-effect delete gate remove the LIVE row). That invariant is a wiring fact,
//   so it is gated in connection.test.ts, not here — one fact, one file.
// =============================================================================

import { playerWalletRowToStore, type SdkPlayerWalletRow } from './rowConvert';
import type { StoreWallet } from './store';

/** Factory: a minimal well-typed SdkPlayerWalletRow with a mock SDK Identity object.
 *  Mirrors makeSdkProfileRow above — the SDK hands rowConvert an object whose only
 *  contract is `toHexString()`, never a bare string. */
function makeSdkWalletRow(ownerHex: string, balance: bigint): SdkPlayerWalletRow {
  return {
    ownerIdentity: { toHexString: () => ownerHex },
    balance,
  };
}

/** u64::MAX — the widest value the server's `player_wallet.balance` column can hold.
 *  Not representable as a JS number: Number(this) === 18446744073709551616. */
const U64_MAX = 18446744073709551615n;

describe('rowConvert 11r-e: playerWalletRowToStore — ownerIdentity via toHexString() (RC-PW-01)', () => {
  it('RC-PW-01a BITES: ownerIdentity is the plain hex string from toHexString() — kills String(row.ownerIdentity) => "[object Object]"', () => {
    // WRONG IMPL KILLED (ADR-0169 D3 c): `String(row.ownerIdentity)` or storing the raw
    // SDK Identity object. store.ownWallet(identity) (store.ts:992-995) compares
    // `slot.ownerIdentity === identity` against a hex string; an object (or the string
    // "[object Object]") NEVER matches, so buildShopViewModel* always receives undefined
    // and #shop-balance renders `unknown` forever — indistinguishable from an unwired
    // feature, but with the subscription burning bandwidth.
    const sdk = makeSdkWalletRow('deadbeef1234abcd', 50n);
    const stored = playerWalletRowToStore(sdk);
    expect(typeof stored.ownerIdentity).toBe('string');
    expect(stored.ownerIdentity).toBe('deadbeef1234abcd');
    // Explicit: the exact wrong value a String() coercion would produce.
    expect(stored.ownerIdentity).not.toBe('[object Object]');
  });

  it('RC-PW-01b BITES: toHexString() is actually invoked (exactly once) — kills a converter that reads some other field', () => {
    // WRONG IMPL KILLED: an impl that reads `row.ownerIdentity.toString()`,
    // `row.ownerIdentity.data`, or a hard-coded constant and coincidentally produces a
    // string. Counting the call proves the documented SDK contract is the source.
    let calls = 0;
    const sdk = {
      ownerIdentity: {
        toHexString: (): string => {
          calls += 1;
          return 'cafebabe';
        },
      },
      balance: 7n,
    } as SdkPlayerWalletRow;
    const stored = playerWalletRowToStore(sdk);
    expect(stored.ownerIdentity).toBe('cafebabe');
    expect(calls, 'playerWalletRowToStore must call ownerIdentity.toHexString() exactly once').toBe(
      1,
    );
  });

  it('RC-PW-01c BITES: the hex string is preserved verbatim — no case normalization, no trimming', () => {
    // WRONG IMPL KILLED: `.toLowerCase()` / `.trim()` "helpfulness". The owner filter is
    // an exact `===` against the identity main.ts holds, so ANY normalization applied on
    // one side and not the other silently disables the readout.
    const lower = playerWalletRowToStore(makeSdkWalletRow('aabbccdd', 1n));
    const upper = playerWalletRowToStore(makeSdkWalletRow('AABBCCDD', 1n));
    expect(lower.ownerIdentity).toBe('aabbccdd');
    expect(upper.ownerIdentity).toBe('AABBCCDD');
    expect(lower.ownerIdentity).not.toBe(upper.ownerIdentity);
  });

  it('RC-PW-01d BITES: an empty hex string passes through as "" — no fabricated fallback owner', () => {
    // WRONG IMPL KILLED: `row.ownerIdentity.toHexString() || 'unknown'`. store.ownWallet('')
    // must return the row only for the '' identity; substituting a sentinel owner would
    // make the slot match the WRONG player (or no player) at the shop call sites, and
    // main.ts:1345's dialogue listener genuinely can pass '' (ADR-0169 D5).
    const stored = playerWalletRowToStore(makeSdkWalletRow('', 999n));
    expect(stored.ownerIdentity).toBe('');
    expect(typeof stored.ownerIdentity).toBe('string');
  });
});

describe('rowConvert 11r-e: playerWalletRowToStore — balance is a pass-through bigint (RC-PW-02)', () => {
  it('RC-PW-02a BITES: balance stays typeof "bigint" and byte-identical — kills Number(row.balance)', () => {
    // WRONG IMPL KILLED (ADR-0169 D3 a): `Number(row.balance)` / `BigInt(Number(...))`.
    // The typeof pin alone kills the plain Number() cast; RC-PW-02b/02c kill the
    // round-tripped variant that restores the bigint TYPE but not the VALUE.
    const stored = playerWalletRowToStore(makeSdkWalletRow('aaa', 50n));
    expect(typeof stored.balance).toBe('bigint');
    expect(stored.balance).toBe(50n);
  });

  it('RC-PW-02b BITES (CRITICAL): u64::MAX (18446744073709551615n) survives byte-identically', () => {
    // WRONG IMPL KILLED (ADR-0169 D3 a): any impl that routes the balance through a JS
    // number. Number(18446744073709551615n) === 18446744073709551616 — off by one, and
    // BigInt()-ing it back restores the TYPE while silently keeping the WRONG VALUE.
    // The second assertion states that mutant's exact output so the failure message
    // names the bug rather than just "expected X received Y".
    const stored = playerWalletRowToStore(makeSdkWalletRow('aaa', U64_MAX));
    expect(typeof stored.balance).toBe('bigint');
    expect(stored.balance).toBe(18446744073709551615n);
    expect(
      stored.balance,
      'balance must NOT equal BigInt(Number(u64::MAX)) === 18446744073709551616n — that is ' +
        'exactly what a Number() round trip produces (ADR-0169 D3 a)',
    ).not.toBe(BigInt(Number(U64_MAX)));
  });

  it('RC-PW-02c BITES: 2^53 + 1 (9007199254740993n) survives — the first value a JS number cannot hold', () => {
    // The smallest realistic witness of the lossy cast: Number(9007199254740993n) is
    // 9007199254740992. A wallet can reach this through repeated grant_currency calls.
    const stored = playerWalletRowToStore(makeSdkWalletRow('aaa', 9007199254740993n));
    expect(stored.balance).toBe(9007199254740993n);
    expect(stored.balance).not.toBe(9007199254740992n);
  });

  it('RC-PW-02d BITES: the returned object is assignable to StoreWallet (compile-time contract pin)', () => {
    // Not a runtime tooth — a tsc tooth. If the implementer returns
    // `{ ownerIdentity: string; balance: number }` this ANNOTATION fails typecheck even
    // though every runtime assertion above could be rewritten to pass. It also pins the
    // field NAMES against store.ts:185-188 (a converter emitting `owner`/`amount` would
    // typecheck-fail here rather than mysteriously never matching the owner filter).
    const stored: StoreWallet = playerWalletRowToStore(makeSdkWalletRow('abc', 12n));
    expect(stored.balance).toBe(12n);
    expect(stored.ownerIdentity).toBe('abc');
  });
});

describe('rowConvert 11r-e: playerWalletRowToStore — "broke" is never fabricated from "dark" (RC-PW-03)', () => {
  it('RC-PW-03a BITES: a genuine 0n balance is preserved as 0n (not dropped, not undefined)', () => {
    // ADR-0154 D6: "broke" (balance 0n, renders `Gold: 0`) and "dark" (no wallet row at
    // all, renders nothing) are DIFFERENT states and must stay distinguishable end to end.
    // WRONG IMPL KILLED: an impl that treats 0n as falsy-and-absent (`balance: row.balance
    // ? row.balance : undefined`), which would turn a broke player's readout into a blank.
    const stored = playerWalletRowToStore(makeSdkWalletRow('aaa', 0n));
    expect(stored.balance).toBe(0n);
    expect(typeof stored.balance).toBe('bigint');
    expect(stored.balance).not.toBeUndefined();
  });

  it('RC-PW-03b BITES (CRITICAL): an ABSENT balance passes through as undefined — kills `row.balance ?? 0n`', () => {
    // This is the ONLY assertion that can see ADR-0169 D3 (b). A well-typed row always
    // has a bigint, so `?? 0n` is unobservable on well-typed input — the mutant has to be
    // probed with the malformed row the SDK could hand us after a schema drift.
    //
    // WHY IT MATTERS DOWNSTREAM: shopModel.balanceViewModel (shopModel.ts:75-79) branches
    // on `typeof amount !== 'bigint'`. Passing `undefined` through yields {kind:'unknown'}
    // -> the node stays hidden, which is correct and honest. Coercing to 0n yields
    // {kind:'known', label:'Gold: 0'} -> the client CONFIDENTLY tells the player they have
    // zero gold when the truth is that the client has no idea. That is the exact
    // fabrication ADR-0154 D1 refused to let `economy::wallet_balance`'s `.unwrap_or(0)`
    // reach the UI, re-introduced one layer up.
    const malformed = {
      ownerIdentity: { toHexString: () => 'aaa' },
      balance: undefined,
    } as unknown as SdkPlayerWalletRow;
    const stored = playerWalletRowToStore(malformed);
    expect(
      (stored as { balance: unknown }).balance,
      'an absent balance must pass through as undefined so shopModel renders `unknown` — ' +
        'a `?? 0n` / `|| 0n` default fabricates `Gold: 0` (ADR-0154 D6 collapse)',
    ).toBeUndefined();
    expect((stored as { balance: unknown }).balance).not.toBe(0n);
  });

  it('RC-PW-03c BITES: a null balance is NOT defaulted to 0n either', () => {
    // Same tooth against the `??`-sibling that only some impls write (`row.balance ?? 0n`
    // catches null too; `row.balance === undefined ? 0n : row.balance` does not). Either
    // way, no fabricated zero.
    const malformed = {
      ownerIdentity: { toHexString: () => 'aaa' },
      balance: null,
    } as unknown as SdkPlayerWalletRow;
    const stored = playerWalletRowToStore(malformed);
    expect((stored as { balance: unknown }).balance).not.toBe(0n);
    expect((stored as { balance: unknown }).balance).toBeNull();
  });
});

describe('rowConvert 11r-e: playerWalletRowToStore — exact key set (RC-PW-04)', () => {
  it('RC-PW-04 BITES: output has EXACTLY the keys ["balance", "ownerIdentity"] — kills the spread impl', () => {
    // WRONG IMPL KILLED (ADR-0169 D3 e): `{ ...row, ownerIdentity: row.ownerIdentity.
    // toHexString() }`. Any SDK-only field the generator adds later (or the raw Identity
    // object itself, under a differently-cased key) would be smuggled into the store row,
    // where store.ownWallet hands it to shopModel and, ultimately, to the DOM. The exact
    // key set proves the converter performs EXPLICIT field mapping — the same tooth
    // RC-PR-02c applies to profileRowToStore.
    const sdk = {
      ownerIdentity: { toHexString: () => 'deadbeef' },
      balance: 42n,
      // A field the current generated binding does not have; a spread impl leaks it.
      serverOnlyScratch: 'leak-me',
    } as unknown as SdkPlayerWalletRow;
    const stored = playerWalletRowToStore(sdk);
    const keys = Object.keys(stored as Record<string, unknown>).sort();
    expect(keys).toEqual(['balance', 'ownerIdentity']);
  });

  it('RC-PW-04b BITES: the result is a FRESH object, not the SDK row itself', () => {
    // WRONG IMPL KILLED: `return row as unknown as StoreWallet` — a zero-work "converter"
    // that satisfies a naive `stored.balance === 50n` assertion while leaving the SDK
    // Identity object in ownerIdentity (and aliasing SDK-owned memory into the store).
    const sdk = makeSdkWalletRow('aaa', 5n);
    const stored = playerWalletRowToStore(sdk);
    expect(stored as unknown).not.toBe(sdk as unknown);
  });
});

describe('rowConvert 11r-e: playerWalletRowToStore — totality (RC-PW-05)', () => {
  it('RC-PW-05a BITES: never throws across the full u64 balance domain, and round-trips both fields (property)', () => {
    // ADR-0169 D3 (d): the converter runs inside a subscription row callback and
    // flushBatch has NO per-listener isolation (ADR-0085 A6) — one throw starves every
    // sibling table's ingest for that batch, so the world goes stale, not just the wallet.
    // The property also carries the "byte-identical for ANY u64" half of EARS 11r-e-2:
    // a Number() round trip fails here for every value above 2^53.
    fc.assert(
      fc.property(fc.bigUintN(64), fc.string(), (balance, ownerHex) => {
        // Block body (not expression body): fast-check reads an expression-bodied
        // matcher's return value as a `false` predicate and fails spuriously.
        const stored = playerWalletRowToStore(makeSdkWalletRow(ownerHex, balance));
        expect(stored.balance).toBe(balance);
        expect(typeof stored.balance).toBe('bigint');
        expect(stored.ownerIdentity).toBe(ownerHex);
      }),
    );
  });

  it('RC-PW-05b BITES: does not throw for hostile/degenerate rows (fail-soft, not fail-loud)', () => {
    // WRONG IMPL KILLED: a defensive converter that VALIDATES and throws
    // (`if (typeof row.balance !== 'bigint') throw new Error(...)`). Rejecting a bad row
    // loudly is the right instinct in a reducer and the WRONG one here: the throw
    // escapes into the SDK's row-callback dispatch and takes the batch with it.
    const cases: readonly SdkPlayerWalletRow[] = [
      makeSdkWalletRow('', 0n),
      makeSdkWalletRow('aaa', U64_MAX),
      { ownerIdentity: { toHexString: () => '' }, balance: -1n } as SdkPlayerWalletRow,
      { ownerIdentity: { toHexString: () => 'x' }, balance: 0 } as unknown as SdkPlayerWalletRow,
      {
        ownerIdentity: { toHexString: () => 'x' },
        balance: '100',
      } as unknown as SdkPlayerWalletRow,
    ];
    for (const row of cases) {
      expect(() => {
        playerWalletRowToStore(row);
      }, 'playerWalletRowToStore must never throw — a throw inside a row callback kills the whole flushBatch (ADR-0085 A6)').not.toThrow();
    }
  });

  it('RC-PW-05c BITES: a negative balance passes through unchanged (no clamping in the converter)', () => {
    // The server column is u64 so this is unreachable today, but clamping is a GAME-RULE
    // concern, never a wire-format concern (the same reasoning as RC-PR-05's negative
    // rating). WRONG IMPL KILLED: `balance: row.balance < 0n ? 0n : row.balance`, which is
    // another route to fabricating a zero the server never sent.
    const stored = playerWalletRowToStore(makeSdkWalletRow('aaa', -7n));
    expect(stored.balance).toBe(-7n);
  });
});

// =============================================================================
// 12r-d [E1] — healLocationRowToStore carries the heal cost CURRENCY as a bigint.
// APPENDED BLOCK — nothing above this line is weakened. Four pre-existing heal
// fixtures gained a `costCurrency: 0n` key so they still describe a WELL-FORMED row
// once the field becomes required; not one of their assertions changed.
//
// EARS E1: WHEN a `heal_location_row` arrives from the SDK, the client SHALL carry its
// `costCurrency` (u64) into the store as a `bigint`, byte-identical, with NO numeric
// coercion and NO defaulting.
//
// CONTRACT (the implementer builds exactly this):
//   interface SdkHealLocationRow { …; readonly costCurrency: bigint }   // REQUIRED
//   type StoreHealLocationRow   = { …; readonly costCurrency: bigint }  // REQUIRED
//   healLocationRowToStore: `costCurrency: row.costCurrency`  — a bare pass-through.
//
// WHY BIGINT AND WHY NO DEFAULT — the doctrine is already written down one function up,
// at rowConvert.ts:543-568 (playerWalletRowToStore):
//   * NO `Number(row.costCurrency)`: the column is u64; Number() is lossy above 2^53 and
//     `BigInt(Number(x))` restores the TYPE while keeping the WRONG VALUE.
//   * NO `?? 0n` / `|| 0n` / `< 0n` clamp: a fabricated zero turns "the client has no
//     idea" into "this heal is free", which is the exact silent-debit lie ADR-0170's
//     §D3 heal-cost seam exists to prevent (the server debits; only the UI lies).
//   * NO throw of its own: this runs inside an SDK row callback, dispatched in a bare
//     unguarded loop — a throw starves every sibling table's ingest for that transaction.
//
// RED AT HEAD: rowConvert.ts:602-612 maps seven fields and never mentions costCurrency,
// so `store.costCurrency` is `undefined` and the key is ABSENT from the result object.
// Every case below fails on that (`undefined` !== the expected bigint; `Object.hasOwn`
// false; the key-set assertion missing an entry). Note client/tsconfig.json EXCLUDES
// `**/*.test.ts`, so `npm run typecheck` does NOT see this file — the gating signal is
// the runtime failure under vitest, exactly as the 11r-e wallet block above.
// =============================================================================

import type { StoreHealLocationRow } from './store';

/** A well-formed SDK heal-location row. `costCurrency` is the only knob under test.
 *  No spread of a `Record<string, unknown>` here on purpose: that would widen the
 *  inferred return type and defuse the assignability pin in RC-HL-CC-08. */
function makeSdkHealRow(costCurrency: bigint, locationId = 3) {
  return {
    locationId,
    zoneId: 1,
    tileX: 8,
    tileY: 4,
    costItemId: undefined as number | undefined,
    costQty: 0,
    cooldownMs: 30000,
    costCurrency,
  };
}

/** 2^64 - 1: the largest value the u64 column can hold. */
const HEAL_U64_MAX = 18446744073709551615n;
/** 2^53 + 1: the smallest integer a JS `number` cannot represent. */
const HEAL_2P53_PLUS_1 = 9007199254740993n;

describe('rowConvert 12r-d [E1]: healLocationRowToStore — costCurrency is a pass-through bigint', () => {
  it('RC-HL-CC-01 BITES: costCurrency 0n arrives as 0n with typeof "bigint" — kills the dropped field', () => {
    // WRONG IMPL KILLED (the HEAD one): a converter that maps the other seven fields and
    // never mentions costCurrency — every consumer downstream reads `undefined`, and the
    // heal overlay renders a cost it cannot describe.
    // ALSO KILLED: `costCurrency: Number(row.costCurrency)` — 0n and 0 are DIFFERENT under
    // Object.is (`toBe`), so the typeof pin AND `.toBe(0n)` each bite the numeric variant
    // even at the one value where the two numeric domains agree.
    const store = healLocationRowToStore(makeSdkHealRow(0n));
    expect(typeof store.costCurrency).toBe('bigint');
    expect(store.costCurrency).toBe(0n);
  });

  it('RC-HL-CC-02 BITES: costCurrency 120n arrives as 120n (a realistic seeded gold cost)', () => {
    // WRONG IMPL KILLED: a hardcoded 0n, or a re-derivation from costQty (`BigInt(costQty)`
    // would yield 0n here while looking plausible on an item-cost row).
    const store = healLocationRowToStore(makeSdkHealRow(120n));
    expect(store.costCurrency).toBe(120n);
    expect(typeof store.costCurrency).toBe('bigint');
  });

  it('★ RC-HL-CC-03 BITES (DISCRIMINATOR): 2^53 + 1 (9007199254740993n) survives byte-identically', () => {
    // THE ROW THAT IS IMPOSSIBLE TO PASS UNDER A `Number()` IMPLEMENTATION. This is the
    // successor discriminator to the retired 11r-g `?? 0` vs `|| 0` NaN case (no NaN exists
    // in the bigint domain — see healModel.test.ts's 12r-d inventory).
    //   Number(9007199254740993n)          === 9007199254740992   (off by one, silently)
    //   BigInt(Number(9007199254740993n))  === 9007199254740992n  (right TYPE, wrong VALUE)
    // The second assertion states that mutant's exact output so a failure NAMES the bug.
    const store = healLocationRowToStore(makeSdkHealRow(HEAL_2P53_PLUS_1));
    expect(typeof store.costCurrency).toBe('bigint');
    expect(store.costCurrency).toBe(9007199254740993n);
    expect(
      store.costCurrency,
      'costCurrency must NOT equal BigInt(Number(2^53+1)) === 9007199254740992n — that is ' +
        'exactly what a Number() round trip produces (rowConvert.ts:543-568 doctrine)',
    ).not.toBe(9007199254740992n);
  });

  it('RC-HL-CC-04 BITES: u64::MAX (18446744073709551615n) survives byte-identically', () => {
    // The far end of the same discriminator: Number(u64::MAX) === 18446744073709551616 —
    // one ABOVE the true value, so a lossy impl overstates the price instead of understating
    // it. Kills any float round trip that RC-HL-CC-03's smaller witness might survive by
    // accident on some engine.
    const store = healLocationRowToStore(makeSdkHealRow(HEAL_U64_MAX));
    expect(store.costCurrency).toBe(18446744073709551615n);
    expect(store.costCurrency).not.toBe(BigInt(Number(HEAL_U64_MAX)));
  });

  it('★ RC-HL-CC-05 BITES: an ABSENT costCurrency passes through as undefined with the KEY PRESENT — kills `?? 0n`', () => {
    // The no-defaulting half of the doctrine, and the ONLY assertion that can see it: a
    // well-typed row always carries a bigint, so `?? 0n` is unobservable on well-typed
    // input. It has to be probed with the malformed row a schema drift would hand us.
    //
    // The `Object.hasOwn` pre-assertion is what stops this case from being VACUOUSLY GREEN
    // at HEAD: HEAD also yields `undefined` for `store.costCurrency` — but because the key
    // is ABSENT, not because it was mapped. Explicit mapping of an undefined value keeps
    // the key. So: hasOwn === true kills the dropped field, value === undefined kills the
    // fabricated `0n` that would paint a dark row as a free heal.
    const malformed = {
      locationId: 3,
      zoneId: 1,
      tileX: 8,
      tileY: 4,
      costItemId: undefined,
      costQty: 0,
      cooldownMs: 30000,
    } as unknown as Parameters<typeof healLocationRowToStore>[0];
    const store = healLocationRowToStore(malformed);
    expect(
      Object.hasOwn(store as unknown as Record<string, unknown>, 'costCurrency'),
      'the converter must map costCurrency EXPLICITLY (the key must exist on the result) — ' +
        'HEAD omits the field entirely, which reads as `undefined` for the wrong reason',
    ).toBe(true);
    expect((store as { costCurrency: unknown }).costCurrency).toBeUndefined();
    expect((store as { costCurrency: unknown }).costCurrency).not.toBe(0n);
    expect((store as { costCurrency: unknown }).costCurrency).not.toBe(0);
  });

  it('RC-HL-CC-06 BITES: exact key set — costCurrency joins the eight mapped keys, nothing leaks', () => {
    // WRONG IMPL KILLED (1): the dropped field (costCurrency missing from the key set).
    // WRONG IMPL KILLED (2): `{ ...row }` — a spread would smuggle every SDK-only field the
    // generator adds later into the store row, where the heal overlay eventually renders it.
    // The explicit-field-mapping tooth that RC-PW-04 applies to the wallet converter.
    const sdk = {
      ...makeSdkHealRow(7n),
      // A field the current generated binding does not have; a spread impl leaks it.
      serverOnlyScratch: 'leak-me',
    } as unknown as Parameters<typeof healLocationRowToStore>[0];
    const store = healLocationRowToStore(sdk);
    const keys = Object.keys(store as unknown as Record<string, unknown>).sort();
    expect(keys).toEqual([
      'cooldownMs',
      'costCurrency',
      'costItemId',
      'costQty',
      'locationId',
      'tileX',
      'tileY',
      'zoneId',
    ]);
  });

  it('RC-HL-CC-07 BITES: a negative costCurrency passes through UNCLAMPED (u64 makes it unreachable; clamping is not a wire concern)', () => {
    // The column is u64, so a negative value cannot arrive from a healthy server — this
    // pins that the converter does not invent a policy anyway. WRONG IMPL KILLED:
    // `row.costCurrency < 0n ? 0n : row.costCurrency`, another route to fabricating a zero
    // the server never sent (and one that HIDES a corrupt row instead of surfacing it).
    const store = healLocationRowToStore(makeSdkHealRow(-25n));
    expect(store.costCurrency).toBe(-25n);
  });

  it('RC-HL-CC-08 BITES: the result is assignable to StoreHealLocationRow (compile-time contract pin)', () => {
    // A tsc tooth, not a runtime one: if the implementer types the field `number` (or names
    // it `cost_currency` / `costGold`), THIS ANNOTATION stops compiling even though every
    // runtime assertion above could be rewritten to pass. HONEST LIMIT: client/tsconfig.json
    // excludes `**/*.test.ts`, so this arm surfaces in the editor and in review — NOT in
    // `npm run typecheck`. The runtime assertions beside it are the gating signal.
    const store: StoreHealLocationRow = healLocationRowToStore(makeSdkHealRow(42n));
    expect(store.costCurrency).toBe(42n);
    expect(store.locationId).toBe(3);
  });

  it('★ RC-HL-CC-09 BITES fast-check: EVERY u64 value round-trips exactly, and the converter never throws', () => {
    // Property form of E1 over the whole u64 domain. A Number()-based impl fails here for
    // every value above 2^53 — which is most of the domain, so this shrinks straight to a
    // named counterexample. Block-bodied arrow: fast-check reads an expression-bodied
    // matcher's return value as a `false` predicate and fails spuriously.
    fc.assert(
      fc.property(
        fc.bigUintN(64),
        fc.integer({ min: 0, max: 9999 }),
        (costCurrency, locationId) => {
          const store = healLocationRowToStore(makeSdkHealRow(costCurrency, locationId));
          expect(typeof store.costCurrency).toBe('bigint');
          expect(store.costCurrency).toBe(costCurrency);
          expect(store.locationId).toBe(locationId);
        },
      ),
    );
  });
});

// =============================================================================
// M21b-2 (ADR-0182 D15) — accountRowToStore: the `my_account` view row converter.
// APPENDED BLOCK — nothing above this line is weakened.
//
// EARS COVERED
//   AUTH-50 (ingest half) — the client subscribes `SELECT * FROM my_account` on every
//             (re)built connection; this converter is what that subscription's onInsert /
//             onUpdate callbacks hand to `store.upsertAccount`.
//   AUTH-51 — the stored row is the SOLE authority for every "signed in" / claim-eligible
//             decision, so a field this converter drops or fabricates is a UI decision made
//             on data the server never sent.
//
// THE EXACT FIELD LIST, verified against the SCHEMA rather than transcribed from prose:
// `server-module/src/schema.rs:685-700` declares `Account { identity, auth_issuer,
// created_at_ms, last_login_at_ms, status, deletion_requested_at_ms, claimed_from,
// claimed_at_ms }`, and the generated binding at `client/src/module_bindings/types.ts:13-24`
// mirrors it in camelCase with `__t.i64()` timestamps and `__t.option(...)` on the last
// three. ADR-0182 D15 lists the same eight. EIGHT fields, no more, no fewer.
//
// CONTRACT (modelled byte-for-byte on `playerWalletRowToStore`, rowConvert.ts:537-574 —
// explicit field mapping, NO spread, NO coercion, NO defaulting, NO throw):
//
//   export interface SdkAccountRow {
//     readonly identity: { toHexString(): string };
//     readonly authIssuer: string;
//     readonly createdAtMs: bigint;
//     readonly lastLoginAtMs: bigint;
//     readonly status: { tag: string };
//     readonly deletionRequestedAtMs: bigint | undefined;
//     readonly claimedFrom: { toHexString(): string } | undefined;
//     readonly claimedAtMs: bigint | undefined;
//   }
//   export function accountRowToStore(row: SdkAccountRow): StoreAccount;
//
// RED REASON (verified by reading client/src/net/rowConvert.ts this session): neither
// `accountRowToStore` nor `SdkAccountRow` exists — the file's own-row converter family runs
// `playerWalletRowToStore` (:569), `healLocationRowToStore` (:606), `profileRowToStore`
// (:769) and nothing else. The import below fails at module-eval time and EVERY test in
// this section reds. That is a MISSING IMPLEMENTATION, not a typo here. `StoreAccount` does
// NOT exist either (store.test.ts's appended block is its gate), so the type import reds
// with it.
//
// NOTE, as the 12r-d block above already records: client/tsconfig.json EXCLUDES
// `**/*.test.ts`, so `npm run typecheck` does not see this file — the gating signal is the
// runtime failure under vitest.
// =============================================================================

import { accountRowToStore, type SdkAccountRow } from './rowConvert';
import type { StoreAccount } from './store';

const ACCOUNT_HEX = 'ac0011223344aabb';
const GUEST_HEX = 'be99887766554433';

/** A well-formed SDK `my_account` row. Mirrors makeSdkWalletRow: the SDK hands rowConvert
 *  an Identity OBJECT whose only contract is `toHexString()`, never a bare string. */
function makeSdkAccountRow(overrides: Partial<Record<string, unknown>> = {}): SdkAccountRow {
  return {
    identity: { toHexString: () => ACCOUNT_HEX },
    authIssuer: 'issuer-under-test',
    createdAtMs: 1_700_000_000_000n,
    lastLoginAtMs: 1_700_000_100_000n,
    status: { tag: 'Active' },
    deletionRequestedAtMs: undefined,
    claimedFrom: undefined,
    claimedAtMs: undefined,
    ...overrides,
  } as unknown as SdkAccountRow;
}

describe('rowConvert M21b-2: accountRowToStore — identities via toHexString() (RC-AC-01)', () => {
  it('★ RC-AC-01a BITES: identity is the plain hex string — kills String(row.identity) => "[object Object]"', () => {
    // WRONG IMPL KILLED: `String(row.identity)`, or storing the raw SDK Identity object.
    // `store.ownAccount(identity)` compares `slot.identity === identity` against the hex
    // string main.ts holds; an object (or the literal "[object Object]") NEVER matches, so
    // AUTH-51's sole "is this connection authenticated" signal reads `undefined` forever —
    // indistinguishable from an unwired feature, but with the subscription live.
    const stored = accountRowToStore(makeSdkAccountRow());
    expect(typeof stored.identity).toBe('string');
    expect(stored.identity).toBe(ACCOUNT_HEX);
    expect(stored.identity).not.toBe('[object Object]');
  });

  it('★★ RC-AC-01b BITES: claimedFrom is hex-converted when PRESENT and stays undefined when ABSENT', () => {
    // `claimed_from` is `Option<Identity>` (schema.rs:698). Both arms are load-bearing and
    // they fail in opposite directions:
    //   * present-but-not-converted → claimModel's ERR_INVALID_CODE disambiguation
    //     (ADR-0182 D16) compares an OBJECT and can never recognise a completed claim, so a
    //     player whose claim SUCCEEDED is told the code was invalid;
    //   * absent-but-fabricated (`?? ''`, `?? row.identity`) → the same disambiguation reads
    //     a claim that never happened as proof one did.
    const withClaim = accountRowToStore(
      makeSdkAccountRow({ claimedFrom: { toHexString: () => GUEST_HEX } }),
    );
    expect(withClaim.claimedFrom).toBe(GUEST_HEX);
    expect(typeof withClaim.claimedFrom).toBe('string');

    const withoutClaim = accountRowToStore(makeSdkAccountRow({ claimedFrom: undefined }));
    expect(withoutClaim.claimedFrom).toBeUndefined();
    expect(withoutClaim.claimedFrom).not.toBe('');
    expect(withoutClaim.claimedFrom).not.toBe(ACCOUNT_HEX);
  });

  it('★ RC-AC-01c BITES: hex strings are preserved VERBATIM — no case normalization, no trimming', () => {
    // The owner filter is an exact `===` against the identity main.ts holds, so ANY
    // normalization applied on one side and not the other silently disables the account UI.
    const lower = accountRowToStore(
      makeSdkAccountRow({ identity: { toHexString: () => 'aabbccdd' } }),
    );
    const upper = accountRowToStore(
      makeSdkAccountRow({ identity: { toHexString: () => 'AABBCCDD' } }),
    );
    expect(lower.identity).toBe('aabbccdd');
    expect(upper.identity).toBe('AABBCCDD');
    expect(lower.identity).not.toBe(upper.identity);
  });

  it('★ RC-AC-01d BITES: toHexString() is called EXACTLY once per identity (no double-conversion)', () => {
    let identityCalls = 0;
    let claimedFromCalls = 0;
    const row = makeSdkAccountRow({
      identity: {
        toHexString: () => {
          identityCalls += 1;
          return ACCOUNT_HEX;
        },
      },
      claimedFrom: {
        toHexString: () => {
          claimedFromCalls += 1;
          return GUEST_HEX;
        },
      },
    });
    accountRowToStore(row);
    expect(identityCalls, 'identity.toHexString() must be called exactly once').toBe(1);
    expect(claimedFromCalls, 'claimedFrom.toHexString() must be called exactly once').toBe(1);
  });
});

describe('rowConvert M21b-2: accountRowToStore — timestamps are pass-through bigints (RC-AC-02)', () => {
  it('★★ RC-AC-02a BITES: createdAtMs / lastLoginAtMs stay typeof "bigint" and byte-identical', () => {
    // The columns are `i64` (schema.rs:692-693) and the generated binding decodes them as
    // bigint (`types.ts:16-17`). WRONG IMPL KILLED: `Number(row.createdAtMs)` — lossy above
    // 2^53, and `BigInt(Number(x))` restores the TYPE while keeping the WRONG VALUE.
    const stored = accountRowToStore(makeSdkAccountRow());
    expect(typeof stored.createdAtMs).toBe('bigint');
    expect(typeof stored.lastLoginAtMs).toBe('bigint');
    expect(stored.createdAtMs).toBe(1_700_000_000_000n);
    expect(stored.lastLoginAtMs).toBe(1_700_000_100_000n);
  });

  it('★★ RC-AC-02b BITES: 2^53 + 1 survives byte-identically (the first value a JS number cannot hold)', () => {
    const huge = 9007199254740993n;
    const stored = accountRowToStore(makeSdkAccountRow({ createdAtMs: huge, lastLoginAtMs: huge }));
    expect(stored.createdAtMs).toBe(huge);
    expect(stored.createdAtMs).not.toBe(9007199254740992n);
    expect(stored.lastLoginAtMs).toBe(huge);
  });

  it('★★ RC-AC-02c BITES (CRITICAL): the two OPTIONAL timestamps pass through as undefined — kills `?? 0n`', () => {
    // `deletion_requested_at_ms` and `claimed_at_ms` are `Option<i64>` (schema.rs:695,699).
    // WRONG IMPL KILLED: `row.deletionRequestedAtMs ?? 0n`. A fabricated `0n` turns "this
    // account has NOT requested deletion" into "deletion was requested at the epoch" — and
    // AUTH-54's `'account pending deletion'` copy hangs off exactly that distinction. This
    // is the same fabrication ADR-0154 D1 refused to let `.unwrap_or(0)` reach the UI, one
    // layer up (rowConvert.ts:543-568 states the doctrine).
    const stored = accountRowToStore(makeSdkAccountRow());
    expect(stored.deletionRequestedAtMs).toBeUndefined();
    expect(stored.deletionRequestedAtMs).not.toBe(0n);
    expect(stored.claimedAtMs).toBeUndefined();
    expect(stored.claimedAtMs).not.toBe(0n);
  });

  it('★ RC-AC-02d BITES: a PRESENT optional timestamp is carried, and a genuine 0n is not dropped', () => {
    // The mirror of RC-AC-02c: `0n` is a REAL value (the epoch) and must survive an impl
    // that treats it as falsy-and-absent (`x ? x : undefined`).
    const present = accountRowToStore(
      makeSdkAccountRow({ deletionRequestedAtMs: 1_700_000_300_000n, claimedAtMs: 0n }),
    );
    expect(present.deletionRequestedAtMs).toBe(1_700_000_300_000n);
    expect(present.claimedAtMs).toBe(0n);
    expect(present.claimedAtMs).not.toBeUndefined();
  });
});

describe('rowConvert M21b-2: accountRowToStore — status carries the enum TAG (RC-AC-03)', () => {
  it('★★ RC-AC-03a BITES: status is the bare tag string, both variants', () => {
    // `AccountStatus` is a unit enum (`schema.rs:669-672`, `types.ts:28-31`); the SDK
    // delivers `{ tag: 'Active' | 'PendingDeletion' }`. Carried bare, exactly as
    // characterRowToStore does for `facing`/`action` (rowConvert.ts:123-124).
    //
    // WRONG IMPL KILLED (a): storing the whole `{tag}` OBJECT — every downstream `===
    // 'PendingDeletion'` comparison is then permanently false, so a pending-deletion account
    // is rendered as a healthy one.
    // WRONG IMPL KILLED (b): a boolean projection (`isActive: row.status.tag === 'Active'`),
    // which throws away the distinction the moment a third variant is added server-side.
    expect(accountRowToStore(makeSdkAccountRow()).status).toBe('Active');
    expect(
      accountRowToStore(makeSdkAccountRow({ status: { tag: 'PendingDeletion' } })).status,
    ).toBe('PendingDeletion');
  });

  it('★ RC-AC-03b BITES: an UNKNOWN tag passes through RAW (fail-soft, never normalised away)', () => {
    // A future server-side variant must not be silently rewritten to 'Active' — that would
    // fail OPEN, presenting an account in an unknown state as healthy. Passing it through
    // raw is the same fail-soft choice `narrowTag` makes (rowConvert.ts:79-83): log or
    // carry, never default.
    const stored = accountRowToStore(makeSdkAccountRow({ status: { tag: 'Suspended' } }));
    expect(stored.status).toBe('Suspended');
    expect(stored.status).not.toBe('Active');
  });
});

describe('rowConvert M21b-2: accountRowToStore — exact key set, explicit mapping (RC-AC-04)', () => {
  it('★★ RC-AC-04a BITES: the output has EXACTLY the eight D15 keys — kills the spread impl', () => {
    // WRONG IMPL KILLED: `{ ...row, identity: row.identity.toHexString() }`. `my_account` is
    // a PRIVATE table's owner-scoped view (schema.rs:674-711) and the account record is the
    // one row in this client that is deliberately PII-free by construction; smuggling any
    // future SDK-only field into the store puts it one `JSON.stringify` away from the F9 bug
    // bundle. The exact key set is what proves the mapping is EXPLICIT — the same tooth
    // RC-PW-04 applies to the wallet and RC-PR-02c to the profile.
    const sdk = makeSdkAccountRow({
      // A field the current generated binding does not have; a spread impl leaks it.
      serverOnlyScratch: 'leak-me',
    });
    const stored = accountRowToStore(sdk);
    expect(Object.keys(stored as unknown as Record<string, unknown>).sort()).toEqual(
      [
        'authIssuer',
        'claimedAtMs',
        'claimedFrom',
        'createdAtMs',
        'deletionRequestedAtMs',
        'identity',
        'lastLoginAtMs',
        'status',
      ].sort(),
    );
  });

  it('★★ RC-AC-04b BITES: the OPTIONAL keys are PRESENT (as undefined), not omitted', () => {
    // `Object.keys` on `{a: undefined}` includes 'a'; on `{}` it does not. An impl that
    // conditionally spreads the optionals (`...(x !== undefined && {claimedAtMs: x})`)
    // passes RC-AC-04a's sorted-key comparison ONLY when they are present — so this pins
    // the absent case explicitly, and with it the "eight keys, always" contract that makes
    // the key-set tooth mean something.
    const stored = accountRowToStore(makeSdkAccountRow()) as unknown as Record<string, unknown>;
    for (const key of ['deletionRequestedAtMs', 'claimedFrom', 'claimedAtMs']) {
      expect(Object.hasOwn(stored, key), `${key} must be present-but-undefined, not omitted`).toBe(
        true,
      );
    }
  });

  it('★ RC-AC-04c BITES: the result is a FRESH object, not the SDK row itself', () => {
    // WRONG IMPL KILLED: `return row as unknown as StoreAccount` — a zero-work "converter"
    // that satisfies naive field assertions while leaving the SDK Identity OBJECT in
    // `identity` and aliasing SDK-owned memory into the store.
    const sdk = makeSdkAccountRow();
    expect(accountRowToStore(sdk) as unknown).not.toBe(sdk as unknown);
  });

  it('★ RC-AC-04d BITES: the result is assignable to StoreAccount (compile-time contract pin)', () => {
    // A tsc tooth, not a runtime one — and, as RC-HL-CC-08 records, client/tsconfig.json
    // excludes `**/*.test.ts`, so it surfaces in the editor and in review rather than in
    // `npm run typecheck`. It pins the field NAMES against store.ts: a converter emitting
    // `issuer`/`created` would fail here rather than mysteriously never matching.
    const stored: StoreAccount = accountRowToStore(makeSdkAccountRow());
    expect(stored.identity).toBe(ACCOUNT_HEX);
    expect(stored.authIssuer).toBe('issuer-under-test');
  });
});

describe('rowConvert M21b-2: accountRowToStore — totality (RC-AC-05)', () => {
  it('★★ RC-AC-05a BITES: never throws for hostile/degenerate rows (fail-soft, not fail-loud)', () => {
    // WRONG IMPL KILLED: a defensive converter that VALIDATES and throws
    // (`if (typeof row.createdAtMs !== 'bigint') throw ...`). Rejecting a bad row loudly is
    // the right instinct in a reducer and the WRONG one here: the throw escapes into the
    // SDK's row-callback dispatch and takes the whole flushBatch with it — ADR-0085 A6, no
    // per-listener isolation, so every SIBLING table's ingest starves for that transaction.
    const hostile: readonly unknown[] = [
      makeSdkAccountRow({ authIssuer: undefined }),
      makeSdkAccountRow({ createdAtMs: undefined }),
      makeSdkAccountRow({ lastLoginAtMs: null }),
      makeSdkAccountRow({ status: undefined }),
      makeSdkAccountRow({ status: { tag: undefined } }),
      makeSdkAccountRow({ claimedFrom: null }),
      makeSdkAccountRow({ deletionRequestedAtMs: 'not-a-bigint' }),
      makeSdkAccountRow({ identity: { toHexString: () => '' } }),
    ];
    for (const row of hostile) {
      expect(
        () => accountRowToStore(row as SdkAccountRow),
        'accountRowToStore must never throw — a throw inside a row callback kills the whole flushBatch (ADR-0085 A6)',
      ).not.toThrow();
    }
  });

  it('★★ RC-AC-05b BITES: an ABSENT authIssuer passes through as undefined — kills `?? ""`', () => {
    // `auth_issuer` is audit provenance (schema.rs:688-691) and is the field the G22 e2e
    // asserts on to prove an account was provisioned by the RIGHT issuer. Coercing an absent
    // value to `''` fabricates "provisioned by the empty issuer", which reads as a valid
    // (and equal-to-nothing) provenance rather than as "the client has no idea".
    const stored = accountRowToStore(makeSdkAccountRow({ authIssuer: undefined }));
    expect((stored as { authIssuer: unknown }).authIssuer).toBeUndefined();
    expect((stored as { authIssuer: unknown }).authIssuer).not.toBe('');
  });

  it('★ RC-AC-05c BITES fast-check: every i64 timestamp pair round-trips exactly, and the converter never throws', () => {
    // Property form over the signed 64-bit domain, so a Number()-based impl fails for most
    // of it and shrinks to a named counterexample. Block-bodied arrow: fast-check reads an
    // expression-bodied matcher's return value as a `false` predicate and fails spuriously.
    fc.assert(
      fc.property(
        fc.bigIntN(64),
        fc.bigIntN(64),
        fc.string(),
        (createdAtMs, lastLoginAtMs, issuer) => {
          const stored = accountRowToStore(
            makeSdkAccountRow({ createdAtMs, lastLoginAtMs, authIssuer: issuer }),
          );
          expect(typeof stored.createdAtMs).toBe('bigint');
          expect(stored.createdAtMs).toBe(createdAtMs);
          expect(stored.lastLoginAtMs).toBe(lastLoginAtMs);
          expect(stored.authIssuer).toBe(issuer);
        },
      ),
    );
  });
});
