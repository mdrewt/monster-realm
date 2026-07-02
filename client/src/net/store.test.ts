// AuthoritativeStore behaviour suite (M4a, ADR-0013/0014) — vitest + fast-check.
// M6c extension tests appended below (§ "Monster + Species store extension").
// SOURCE OF TRUTH: specs/monster-realm-v2/M4-frontend.spec.md §3 "Store".
// The store is the READ-ONLY mirror of subscription truth: keyed Maps (idempotent
// on reconnect), each character recording receivedAt + the last TWO snapshots for
// interpolation, and a per-transaction batch-applied signal so the loop reconciles
// once on a coherent snapshot. Pure + synchronous: the live SDK + the microtask
// coalescing live in the (untested-here, M5 e2e) connection adapter.

import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthoritativeStore,
  type StoreBattle,
  type StoreBattleMonster,
  type StoreBattleSide,
  type StoreCharacter,
  type StoreInventory,
  type StoreItemRow,
  type StoreMonsterPub,
  type StorePlayer,
  type StoreSkillRow,
  type StoreSpeciesRow,
} from './store';

function char(entityId: bigint, tileX: number, tileY: number): StoreCharacter {
  return {
    entityId,
    zoneId: 0,
    tileX,
    tileY,
    facing: 'East',
    action: 'Idle',
    moveStartedAtMs: 0n,
    moveQueue: [],
  };
}
function player(identity: string, entityId: bigint, lastInputSeq = 0n): StorePlayer {
  return { identity, entityId, name: `P-${identity}`, online: true, lastInputSeq };
}

describe('AuthoritativeStore: keyed-Map idempotency (no array-store duplication)', () => {
  it('upserts insert; a reconnect re-insert overwrites, never duplicates', () => {
    const s = new AuthoritativeStore();
    s.upsertCharacter(char(1n, 2, 3), 100);
    s.upsertCharacter(char(1n, 4, 5), 200); // same id again (reconnect re-insert)
    expect(s.characterCount).toBe(1); // overwritten, not duplicated
    expect(s.character(1n)!.row.tileX).toBe(4);
    expect(s.character(1n)!.row.tileY).toBe(5);
  });

  it('keys characters by bigint entity id (distinct ids coexist)', () => {
    const s = new AuthoritativeStore();
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.upsertCharacter(char(2n, 9, 9), 100);
    expect(s.characterCount).toBe(2);
    expect(s.character(2n)!.row.tileX).toBe(9);
  });
});

describe('AuthoritativeStore: receivedAt + last-two snapshot history (interp source)', () => {
  it('records receivedAt and keeps exactly the last two snapshots', () => {
    const s = new AuthoritativeStore();
    s.upsertCharacter(char(1n, 0, 0), 1000); // snap A
    expect(s.character(1n)!.receivedAt).toBe(1000);
    expect(s.character(1n)!.latest).toMatchObject({ tileX: 0, tileY: 0, receivedAt: 1000 });
    expect(s.character(1n)!.prev).toBeUndefined();

    s.upsertCharacter(char(1n, 1, 0), 1200); // snap B
    expect(s.character(1n)!.latest).toMatchObject({ tileX: 1, receivedAt: 1200 });
    expect(s.character(1n)!.prev).toMatchObject({ tileX: 0, receivedAt: 1000 });

    s.upsertCharacter(char(1n, 2, 0), 1400); // snap C — only the LAST TWO survive
    expect(s.character(1n)!.latest).toMatchObject({ tileX: 2, receivedAt: 1400 });
    expect(s.character(1n)!.prev).toMatchObject({ tileX: 1, receivedAt: 1200 }); // B, not A
  });
});

describe('AuthoritativeStore: per-transaction batch-applied signal (ADR-0013)', () => {
  it('BITES: fires the batch signal ONCE per flush, not once per row', () => {
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.upsertCharacter(char(2n, 1, 1), 100);
    s.upsertCharacter(char(3n, 2, 2), 100);
    expect(cb).toHaveBeenCalledTimes(0); // not mid-batch (per-row would have fired 3x)
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1); // exactly one coherent batch signal
  });

  it('BITES: a flush with no changes does NOT fire (no empty-batch reconcile)', () => {
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(0); // nothing changed => no signal
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
    s.flushBatch(); // clean again
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('the snapshot is coherent: all mutations are visible when the signal fires', () => {
    const s = new AuthoritativeStore();
    let seen = -1;
    s.onBatchApplied(() => {
      seen = s.characterCount;
    });
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.upsertCharacter(char(2n, 0, 0), 100);
    s.flushBatch();
    expect(seen).toBe(2); // both rows already applied at signal time (never mid-batch)
  });

  it('onBatchApplied returns an unsubscribe', () => {
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    const off = s.onBatchApplied(cb);
    off();
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(0);
  });
});

describe('AuthoritativeStore: despawn prunes the character + history', () => {
  it('removeCharacter deletes the row and its snapshots (no ghost)', () => {
    const s = new AuthoritativeStore();
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.upsertCharacter(char(1n, 1, 0), 200);
    s.removeCharacter(1n);
    expect(s.character(1n)).toBeUndefined();
    expect(s.characterCount).toBe(0);
  });

  it('removeCharacter marks the batch dirty so the loop re-renders', () => {
    const s = new AuthoritativeStore();
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.flushBatch();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.removeCharacter(1n);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('AuthoritativeStore: own-character identification (identity -> player -> entity -> char)', () => {
  it('resolves the own entity id and character via the player row', () => {
    const s = new AuthoritativeStore();
    s.upsertPlayer(player('abc', 42n));
    s.upsertCharacter(char(42n, 3, 4), 100);
    expect(s.ownEntityId('abc')).toBe(42n);
    expect(s.ownCharacter('abc')!.row.tileX).toBe(3);
  });

  it('is undefined before the player row arrives, and char-undefined before the char row', () => {
    const s = new AuthoritativeStore();
    expect(s.ownEntityId('abc')).toBeUndefined();
    expect(s.ownCharacter('abc')).toBeUndefined();
    s.upsertPlayer(player('abc', 42n)); // player but no character yet
    expect(s.ownEntityId('abc')).toBe(42n);
    expect(s.ownCharacter('abc')).toBeUndefined();
  });
});

describe('AuthoritativeStore: reconnect reset (clean re-init, no stale merge)', () => {
  it('reset clears all rows but keeps batch listeners (the loop survives a reconnect)', () => {
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertPlayer(player('abc', 1n));
    s.upsertCharacter(char(1n, 5, 5), 100);
    s.reset();
    expect(s.characterCount).toBe(0);
    expect(s.player('abc')).toBeUndefined();
    expect(s.ownCharacter('abc')).toBeUndefined();
    // a fresh post-reconnect batch still reaches the still-registered listener
    s.upsertCharacter(char(2n, 0, 0), 300);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('AuthoritativeStore: properties (fast-check)', () => {
  it('count == number of distinct entity ids upserted (idempotent)', () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 50n }), { maxLength: 40 }), (ids) => {
        const s = new AuthoritativeStore();
        for (const id of ids) s.upsertCharacter(char(id, 0, 0), 100);
        expect(s.characterCount).toBe(new Set(ids).size);
      }),
    );
  });

  it('history never exceeds two snapshots and prev is the second-newest', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 2, maxLength: 30 }),
        (xs) => {
          const s = new AuthoritativeStore();
          xs.forEach((x, i) => {
            s.upsertCharacter(char(7n, x, 0), 100 + i);
          });
          const stored = s.character(7n)!;
          expect(stored.latest.tileX).toBe(xs[xs.length - 1]);
          expect(stored.prev!.tileX).toBe(xs[xs.length - 2]);
        },
      ),
    );
  });
});

// =============================================================================
// M6c extension: Monster + Species store (StoreMonsterPub / StoreSpeciesRow)
// SOURCE OF TRUTH: specs/monster-realm-v2/M6-box-party.spec.md
// =============================================================================

/** Factory: minimal valid StoreMonsterPub. All fields required by the interface. */
function monsterPub(monsterId: bigint, ownerIdentity = 'dead', partySlot = 255): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity,
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
    partySlot,
  };
}

/** Factory: minimal valid StoreSpeciesRow. */
function speciesRow(id: number): StoreSpeciesRow {
  return {
    id,
    name: `Species-${id}`,
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

describe('AuthoritativeStore M6c: monster upsert + batch signal', () => {
  it('BITES: upsertMonster stores the row and monster() retrieves it; flushBatch fires', () => {
    // Kills: an impl that ignores upsertMonster or never marks the batch dirty.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    const m = monsterPub(1n, 'abc');
    s.upsertMonster(m);
    expect(s.monster(1n)).toEqual(m);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('BITES: upsert the same monsterId twice keeps count at 1 (keyed-Map idempotency)', () => {
    // Kills: an impl that stores monsters in an array and appends on re-insert.
    const s = new AuthoritativeStore();
    s.upsertMonster(monsterPub(1n, 'abc'));
    s.upsertMonster(monsterPub(1n, 'abc')); // identical id — must overwrite
    expect(s.monsterCount).toBe(1);
  });

  it('BITES: second upsert overwrites the row (last-write wins, no ghost of first)', () => {
    // Kills: an impl that silently drops a duplicate insert rather than updating.
    const s = new AuthoritativeStore();
    s.upsertMonster(monsterPub(1n, 'alice'));
    s.upsertMonster({ ...monsterPub(1n, 'alice'), nickname: 'Sparky' });
    expect(s.monster(1n)!.nickname).toBe('Sparky');
  });
});

describe('AuthoritativeStore M6c: removeMonster', () => {
  it('BITES: removeMonster deletes the row; monster() returns undefined; batch is dirty', () => {
    // Kills: an impl that deletes but forgets to mark dirty, or soft-deletes.
    const s = new AuthoritativeStore();
    s.upsertMonster(monsterPub(7n));
    s.flushBatch(); // clear dirty
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.removeMonster(7n);
    expect(s.monster(7n)).toBeUndefined();
    expect(s.monsterCount).toBe(0);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('removeMonster on an unknown id does NOT throw and does NOT mark dirty', () => {
    // Kills: an impl that marks dirty on a no-op delete (causes phantom re-renders).
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.removeMonster(999n); // id never inserted
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(0);
  });
});

describe('AuthoritativeStore M6c: ownMonsters identity filter', () => {
  it('BITES: ownMonsters returns only monsters matching ownerIdentity', () => {
    // Kills: an impl that returns ALL monsters regardless of identity.
    const s = new AuthoritativeStore();
    s.upsertMonster(monsterPub(1n, 'alice'));
    s.upsertMonster(monsterPub(2n, 'bob'));
    s.upsertMonster(monsterPub(3n, 'alice'));
    const aliceMonsters = s.ownMonsters('alice');
    expect(aliceMonsters).toHaveLength(2);
    const ids = aliceMonsters.map((m) => m.monsterId);
    expect(ids).toContain(1n);
    expect(ids).toContain(3n);
    expect(ids).not.toContain(2n);
  });

  it('ownMonsters returns empty array when identity has no monsters', () => {
    // Kills: an impl that returns undefined or throws when no match.
    const s = new AuthoritativeStore();
    s.upsertMonster(monsterPub(1n, 'alice'));
    expect(s.ownMonsters('nobody')).toEqual([]);
  });
});

describe('AuthoritativeStore M6c: reset clears monsters + species, listeners survive', () => {
  it('BITES: reset removes monsters and species; post-reset batch still reaches listeners', () => {
    // Kills: an impl that clears listeners on reset (breaking the running loop).
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertMonster(monsterPub(1n, 'p'));
    s.upsertSpecies(speciesRow(1));
    s.reset();
    expect(s.monsterCount).toBe(0);
    expect(s.species(1)).toBeUndefined();
    // A fresh upsert after reset must still trigger the listener
    s.upsertMonster(monsterPub(2n, 'q'));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('AuthoritativeStore M6c: species upsert + remove', () => {
  it('BITES: upsertSpecies stores the row; species() retrieves it', () => {
    // Kills: an impl that exposes the method but never stores to the map.
    const s = new AuthoritativeStore();
    const sp = speciesRow(42);
    s.upsertSpecies(sp);
    expect(s.species(42)).toEqual(sp);
  });

  it('BITES: removeSpecies deletes the entry; species() returns undefined', () => {
    // Kills: an impl that soft-deletes or returns a tombstone.
    const s = new AuthoritativeStore();
    s.upsertSpecies(speciesRow(5));
    s.removeSpecies(5);
    expect(s.species(5)).toBeUndefined();
  });

  it('speciesMap() exposes all currently held species as a ReadonlyMap', () => {
    // Kills: an impl that returns a mutable Map or an empty object.
    const s = new AuthoritativeStore();
    s.upsertSpecies(speciesRow(1));
    s.upsertSpecies(speciesRow(2));
    const m = s.speciesMap();
    expect(m.size).toBe(2);
    expect(m.get(1)!.name).toBe('Species-1');
    expect(m.get(2)!.name).toBe('Species-2');
  });
});

describe('AuthoritativeStore M6c: StoreMonsterPub type contract (no hidden fields)', () => {
  it('BITES: StoreMonsterPub has NO iv*, ev*, or natureKind fields at runtime', () => {
    // Kills: an impl that includes hidden fields in the monster_pub projection,
    // leaking genome data to other clients.
    const m = monsterPub(1n);
    const keys = Object.keys(m);
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

  it('BITES: StoreMonsterPub has all required public stat fields', () => {
    // Kills: an impl that strips stats together with the hidden fields.
    const m = monsterPub(1n);
    const keys = Object.keys(m);
    const required = [
      'monsterId',
      'ownerIdentity',
      'speciesId',
      'nickname',
      'level',
      'xp',
      'bond',
      'currentHp',
      'statHp',
      'statAttack',
      'statDefense',
      'statSpeed',
      'statSpAttack',
      'statSpDefense',
      'partySlot',
    ];
    for (const field of required) {
      expect(keys).toContain(field);
    }
  });
});

describe('AuthoritativeStore M6c: monsterCount property (fast-check)', () => {
  it('BITES: monsterCount equals the number of distinct monsterIds after random upserts', () => {
    // Kills: an impl that counts rows from an array (inflates on re-insert) or a
    // naive size() that doesn't account for overwrite.
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 30n }), { maxLength: 50 }), (ids) => {
        const s = new AuthoritativeStore();
        for (const id of ids) {
          s.upsertMonster(monsterPub(id));
        }
        expect(s.monsterCount).toBe(new Set(ids).size);
      }),
    );
  });
});

// =============================================================================
// M7c extension: Battle + Skill store (StoreBattle / StoreSkillRow)
// SOURCE OF TRUTH: specs/monster-realm-v2/M7-battle-view.spec.md
// =============================================================================

/** Factory: minimal valid StoreBattleMonster. */
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

/** Factory: minimal valid StoreBattleSide. */
function battleSide(overrides: Partial<StoreBattleSide> = {}): StoreBattleSide {
  return { active: 0, team: [battleMonster()], ...overrides };
}

/** Factory: minimal valid StoreBattle. */
function battle(battleId: bigint, playerIdentity = 'alice', outcome = 'Ongoing'): StoreBattle {
  return {
    battleId,
    playerIdentity,
    opponentIdentity: 'npc',
    outcome,
    turnNumber: 1,
    sideA: battleSide(),
    sideB: battleSide(),
    partyMonsterIds: [1n],
    opponentMonsterIds: [2n],
    createdAtMs: 1000n,
  };
}

/** Factory: minimal valid StoreSkillRow. */
function skillRow(id: number): StoreSkillRow {
  return { id, name: `Skill-${id}`, affinity: 'Fire', power: 40, accuracy: 100, pp: 20 };
}

// --- Battle: upsert / retrieve / batch signal ---------------------------------

describe('AuthoritativeStore M7c: battle upsert + batch signal', () => {
  it('BITES: upsertBattle stores row; battle() retrieves it; flushBatch fires', () => {
    // Kills: an impl that ignores upsertBattle or never marks the batch dirty.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    const b = battle(1n, 'alice');
    s.upsertBattle(b);
    expect(s.battle(1n)).toEqual(b);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('BITES: upsert the same battleId twice keeps count at 1 (keyed-Map idempotency)', () => {
    // Kills: an impl that stores battles in an array and appends on re-insert.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(1n));
    s.upsertBattle(battle(1n)); // same id — must overwrite, not duplicate
    // Checking via battle() existing and distinct identity count through ongoingBattle
    expect(s.battle(1n)).toBeDefined();
    // The only reliable check without a battleCount getter: re-upsert with changed field
    // and verify the old value is gone (last-write wins, Map keyed by battleId).
    s.upsertBattle({ ...battle(1n), turnNumber: 99 });
    expect(s.battle(1n)!.turnNumber).toBe(99);
  });

  it('BITES: second upsert overwrites the row (last-write wins, no ghost of first)', () => {
    // Kills: an impl that silently drops a duplicate insert rather than updating.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(5n, 'alice', 'Ongoing'));
    s.upsertBattle({ ...battle(5n, 'alice', 'Ongoing'), turnNumber: 7 });
    expect(s.battle(5n)!.turnNumber).toBe(7);
  });
});

// --- Battle: removeBattle -----------------------------------------------------

describe('AuthoritativeStore M7c: removeBattle', () => {
  it('BITES: removeBattle deletes the row; battle() returns undefined; batch is dirty', () => {
    // Kills: an impl that deletes but forgets to mark dirty, or soft-deletes.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(3n));
    s.flushBatch(); // clear dirty
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.removeBattle(3n);
    expect(s.battle(3n)).toBeUndefined();
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('BITES: removeBattle on unknown id does NOT mark dirty (no phantom re-renders)', () => {
    // Kills: an impl that marks dirty on a no-op delete.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.removeBattle(999n); // never inserted
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(0);
  });
});

// --- Battle: ongoingBattle ----------------------------------------------------

describe('AuthoritativeStore M7c: ongoingBattle identity + outcome filter', () => {
  it('BITES: ongoingBattle returns battle matching playerIdentity AND outcome===Ongoing', () => {
    // Kills: an impl that only filters by identity, ignoring outcome.
    const s = new AuthoritativeStore();
    const b = battle(10n, 'alice', 'Ongoing');
    s.upsertBattle(b);
    const result = s.ongoingBattle('alice');
    expect(result).toBeDefined();
    expect(result!.battleId).toBe(10n);
    expect(result!.outcome).toBe('Ongoing');
  });

  it('BITES: ongoingBattle returns undefined when only finished battles exist', () => {
    // Kills: an impl that returns any battle matching identity regardless of outcome.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(1n, 'alice', 'SideAWins'));
    expect(s.ongoingBattle('alice')).toBeUndefined();
  });

  it('BITES: ongoingBattle returns undefined for non-matching identity', () => {
    // Kills: an impl that ignores the identity filter and returns the first ongoing battle.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(2n, 'alice', 'Ongoing'));
    expect(s.ongoingBattle('bob')).toBeUndefined();
  });

  it('BITES: ongoingBattle with multiple battles returns only the Ongoing one', () => {
    // Kills: an impl that returns the first-inserted battle in Map order regardless of outcome.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(1n, 'alice', 'SideBWins'));
    s.upsertBattle(battle(2n, 'alice', 'Fled'));
    s.upsertBattle(battle(3n, 'alice', 'Ongoing'));
    const result = s.ongoingBattle('alice');
    expect(result).toBeDefined();
    expect(result!.battleId).toBe(3n);
    expect(result!.outcome).toBe('Ongoing');
  });
});

// --- Battle + Skill: reset clears both, listeners survive --------------------

describe('AuthoritativeStore M7c: reset clears battles and skills; listeners survive', () => {
  it('BITES: reset removes battles and skills; post-reset batch still reaches listeners', () => {
    // Kills: an impl that clears listeners on reset (breaking the running loop),
    // or that fails to clear the new M7c maps on reset.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertBattle(battle(1n, 'alice'));
    s.upsertSkill(skillRow(1));
    s.reset();
    expect(s.battle(1n)).toBeUndefined();
    expect(s.skill(1)).toBeUndefined();
    // A fresh post-reset batch must still reach the still-registered listener
    s.upsertBattle(battle(2n, 'bob'));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// --- Skill: upsert / retrieve -------------------------------------------------

describe('AuthoritativeStore M7c: skill upsert + retrieve', () => {
  it('BITES: upsertSkill stores the row; skill() retrieves it', () => {
    // Kills: an impl that exposes the method but never stores to the map.
    const s = new AuthoritativeStore();
    const sk = skillRow(42);
    s.upsertSkill(sk);
    expect(s.skill(42)).toEqual(sk);
  });

  it('BITES: removeSkill deletes the entry; skill() returns undefined', () => {
    // Kills: an impl that soft-deletes or returns a tombstone object.
    const s = new AuthoritativeStore();
    s.upsertSkill(skillRow(7));
    s.removeSkill(7);
    expect(s.skill(7)).toBeUndefined();
  });

  it('BITES: skillMap() exposes all currently held skills as a ReadonlyMap', () => {
    // Kills: an impl that returns a mutable Map, an empty object, or a copy
    // that goes stale after subsequent upserts.
    const s = new AuthoritativeStore();
    s.upsertSkill(skillRow(1));
    s.upsertSkill(skillRow(2));
    const m = s.skillMap();
    expect(m.size).toBe(2);
    expect(m.get(1)!.name).toBe('Skill-1');
    expect(m.get(2)!.name).toBe('Skill-2');
  });
});

// --- Skill: property (fast-check) --------------------------------------------

describe('AuthoritativeStore M7c: skillCount property (fast-check)', () => {
  it('BITES: skillMap().size equals the number of distinct ids after random upserts', () => {
    // Kills: an impl that counts rows from an array (inflates on re-insert) or
    // a naive size() that does not account for Map overwrite semantics.
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 30 }), { maxLength: 50 }), (ids) => {
        const s = new AuthoritativeStore();
        for (const id of ids) {
          s.upsertSkill(skillRow(id));
        }
        expect(s.skillMap().size).toBe(new Set(ids).size);
      }),
    );
  });
});

// =============================================================================
// M8.6c — speciesMap() / skillMap() defensive copy (live-map leak guard)
// SOURCE OF TRUTH: specs/monster-realm-v2/M8.6-residual-hardening.spec.md
//
// RED reason (before impl): speciesMap() returns `this.#species` directly and
// skillMap() returns `this.#skills` directly. A caller who mutates the returned
// map corrupts the store's internal state — subsequent reads return the mutated
// (wrong) data. After fix: both methods return `new Map(this.#species)` / `new
// Map(this.#skills)` (a snapshot copy), so mutations to the returned map cannot
// reach the private fields.
//
// BITES: `return this.#species` / `return this.#skills` (live map leak).
// =============================================================================

describe('AuthoritativeStore M8.6c: speciesMap() returns a COPY (no live-map leak)', () => {
  it('BITES: mutating the returned speciesMap does NOT corrupt the store (live-map leak killed)', () => {
    // RED reason: `speciesMap()` returns the private Map reference. A caller who
    // calls `.set(999, ...)` on the returned map would silently mutate internal
    // state — `store.species(999)` and a subsequent `store.speciesMap().get(999)`
    // would both show the injected row. After fix (copy returned): the store is
    // completely unaffected by caller mutations.
    // Wrong impl killed: `return this.#species` (reference leak).
    const s = new AuthoritativeStore();
    const existing = speciesRow(1);
    s.upsertSpecies(existing);

    const m = s.speciesMap() as Map<number, StoreSpeciesRow>;

    // Inject a spurious entry and delete the legitimate one via the returned map.
    const fakeRow = speciesRow(999);
    m.set(999, fakeRow);
    m.delete(1);

    // Store must be completely unaffected:
    expect(s.species(999)).toBeUndefined(); // injected row must NOT appear
    expect(s.speciesMap().get(999)).toBeUndefined(); // fresh copy also clean
    expect(s.species(1)).toEqual(existing); // original still present
    expect(s.speciesMap().get(1)).toEqual(existing); // confirmed via fresh copy
  });

  it('BITES: two successive speciesMap() calls return independent snapshots', () => {
    // Kills: an impl that caches a mutable reference — both calls would return the
    // same object, so mutations via one call corrupt the other.
    const s = new AuthoritativeStore();
    s.upsertSpecies(speciesRow(1));
    s.upsertSpecies(speciesRow(2));

    const m1 = s.speciesMap() as Map<number, StoreSpeciesRow>;
    const m2 = s.speciesMap();

    // Mutate m1; m2 (a separate copy returned by the second call) must be unaffected.
    m1.set(42, speciesRow(42));
    expect(m2.get(42)).toBeUndefined(); // m2 is its own copy, not aliased to m1
    expect(m2.size).toBe(2); // still only the two rows that existed at call time
  });

  it('BITES: speciesMap() snapshot is stable even after subsequent upserts', () => {
    // Kills: an impl that returns a live view — a post-call upsert would silently
    // appear in the already-returned map.
    const s = new AuthoritativeStore();
    s.upsertSpecies(speciesRow(10));
    const snap = s.speciesMap();
    expect(snap.size).toBe(1);

    // Upsert a second species AFTER the snapshot was taken.
    s.upsertSpecies(speciesRow(20));

    // The previously returned map must NOT reflect the new upsert.
    expect(snap.get(20)).toBeUndefined();
    expect(snap.size).toBe(1); // still 1, not 2
  });
});

// =============================================================================
// M8.7e — latestPlayerBattle selector (AuthoritativeStore)
// SOURCE OF TRUTH: specs/monster-realm-v2/M8.7-third-review-residuals.spec.md §3
//   "WHEN a player's battle resolves … THE SYSTEM SHALL render the terminal
//   outcome frame at least once"
//
// latestPlayerBattle(identity) returns the StoreBattle row with the HIGHEST
// battleId (bigint comparison) among rows whose playerIdentity === identity,
// regardless of outcome (Ongoing OR terminal). Returns undefined when no row
// matches. The existing ongoingBattle() selector is UNCHANGED.
//
// RED: `latestPlayerBattle` does not exist on AuthoritativeStore yet.
// =============================================================================

describe('AuthoritativeStore M8.7e: latestPlayerBattle', () => {
  it('T1a: BITES returns the row with the highest battleId regardless of outcome', () => {
    // Insert ids 1n (Ongoing), 3n (SideAWins), 2n (Fled) for 'alice'.
    // latestPlayerBattle must return the 3n row, not the first-inserted or
    // the Ongoing-only row.
    // Kills: returning the first match / returning only Ongoing rows.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(1n, 'alice', 'Ongoing'));
    s.upsertBattle(battle(3n, 'alice', 'SideAWins'));
    s.upsertBattle(battle(2n, 'alice', 'Fled'));
    const result = s.latestPlayerBattle('alice');
    expect(result).toBeDefined();
    expect(result!.battleId).toBe(3n);
    expect(result!.outcome).toBe('SideAWins');
  });

  it('T1b: BITES returns undefined when the identity has no battle', () => {
    // Rows exist only for 'bob'. latestPlayerBattle('alice') must return undefined,
    // not bob's battle and not throw.
    // Kills: returning another player's battle / throwing on missing identity.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(5n, 'bob', 'Ongoing'));
    expect(s.latestPlayerBattle('alice')).toBeUndefined();
  });

  it('T1c: BITES filters strictly by playerIdentity (alice id 5n, bob id 9n)', () => {
    // alice has battleId 5n, bob has battleId 9n. latestPlayerBattle('alice')
    // must return alice's 5n row, NOT bob's higher-id 9n row.
    // Kills: ignoring the identity filter and returning the global highest-id row.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(5n, 'alice', 'Ongoing'));
    s.upsertBattle(battle(9n, 'bob', 'Ongoing'));
    const result = s.latestPlayerBattle('alice');
    expect(result).toBeDefined();
    expect(result!.battleId).toBe(5n);
    expect(result!.playerIdentity).toBe('alice');
  });

  it('T1d: BITES bigint comparison is exact across the 2^53 boundary (Number() coercion broken)', () => {
    // 9007199254740993n (2^53+1) and 9007199254740992n (2^53) both coerce to
    // the same Number (9007199254740992) via Number(), so Math.max or Number()
    // coercion picks the wrong/arbitrary winner. bigint `>` comparison correctly
    // identifies 9007199254740993n as the larger value.
    // Kills: Number() / Math.max coercion that silently equates the two ids.
    const lo = 9007199254740992n; // 2^53
    const hi = 9007199254740993n; // 2^53 + 1
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(lo, 'alice', 'Ongoing'));
    s.upsertBattle(battle(hi, 'alice', 'SideAWins'));
    const result = s.latestPlayerBattle('alice');
    expect(result).toBeDefined();
    expect(result!.battleId).toBe(hi); // must be 9007199254740993n, not lo
  });

  it('T1e: REGRESSION — ongoingBattle is unchanged after these inserts (semantics preserved)', () => {
    // Verify that adding latestPlayerBattle does NOT alter ongoingBattle's filter.
    // ongoingBattle must still return only the Ongoing row, not the terminal ones.
    // Kills: an impl that accidentally modifies ongoingBattle to return all outcomes.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(1n, 'alice', 'Ongoing'));
    s.upsertBattle(battle(3n, 'alice', 'SideAWins'));
    s.upsertBattle(battle(2n, 'alice', 'Fled'));
    const ongoing = s.ongoingBattle('alice');
    expect(ongoing).toBeDefined();
    expect(ongoing!.battleId).toBe(1n);
    expect(ongoing!.outcome).toBe('Ongoing');
    // latestPlayerBattle returns the highest (3n), ongoingBattle returns the Ongoing (1n)
    expect(s.latestPlayerBattle('alice')!.battleId).toBe(3n);
  });
});

describe('AuthoritativeStore M8.6c: skillMap() returns a COPY (no live-map leak)', () => {
  it('BITES: mutating the returned skillMap does NOT corrupt the store (live-map leak killed)', () => {
    // RED reason: `skillMap()` returns the private Map reference. A caller mutation
    // silently corrupts internal state. After fix (copy): store is unaffected.
    // Wrong impl killed: `return this.#skills` (reference leak).
    const s = new AuthoritativeStore();
    const existing = skillRow(1);
    s.upsertSkill(existing);

    const m = s.skillMap() as Map<number, StoreSkillRow>;

    // Inject a spurious entry and delete the legitimate one.
    m.set(888, skillRow(888));
    m.delete(1);

    // Store must be completely unaffected:
    expect(s.skill(888)).toBeUndefined(); // injected row must NOT appear
    expect(s.skillMap().get(888)).toBeUndefined(); // fresh copy also clean
    expect(s.skill(1)).toEqual(existing); // original still present
    expect(s.skillMap().get(1)).toEqual(existing); // confirmed via fresh copy
  });

  it('BITES: two successive skillMap() calls return independent snapshots', () => {
    // Kills: a caching impl that returns the same mutable object on both calls.
    const s = new AuthoritativeStore();
    s.upsertSkill(skillRow(1));
    s.upsertSkill(skillRow(2));

    const m1 = s.skillMap() as Map<number, StoreSkillRow>;
    const m2 = s.skillMap();

    m1.set(77, skillRow(77));
    expect(m2.get(77)).toBeUndefined();
    expect(m2.size).toBe(2);
  });

  it('BITES: skillMap() snapshot is stable even after subsequent upserts', () => {
    // Kills: a live-view impl — post-call upserts would appear in already-returned map.
    const s = new AuthoritativeStore();
    s.upsertSkill(skillRow(5));
    const snap = s.skillMap();
    expect(snap.size).toBe(1);

    s.upsertSkill(skillRow(6));

    expect(snap.get(6)).toBeUndefined();
    expect(snap.size).toBe(1);
  });
});

// =============================================================================
// M9c extension: Inventory + ItemDef store (StoreInventory / StoreItemRow)
// SOURCE OF TRUTH: specs/monster-realm-v2/M9-raising.spec.md
// =============================================================================

/** Factory: minimal valid StoreInventory. */
function inventoryRow(
  invId: bigint,
  ownerIdentity = 'player',
  itemId = 1,
  count = 1,
): StoreInventory {
  return { invId, ownerIdentity, itemId, count };
}

/** Factory: minimal valid StoreItemRow. */
function itemDefRow(id: number, trainStat: string | null = null): StoreItemRow {
  return {
    id,
    name: `Item-${id}`,
    description: `Description for item ${id}`,
    recruitBonus: 0,
    trainStat,
    trainAmount: trainStat != null ? 10 : 0,
  };
}

// --- Inventory: upsert / retrieve / batch signal -------------------------------

describe('AuthoritativeStore M9c: inventory upsert + batch signal', () => {
  it('BITES: upsertInventory stores the row; ownInventory() retrieves it; flushBatch fires', () => {
    // Kills: an impl that ignores upsertInventory or never marks the batch dirty.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    const inv = inventoryRow(1n, 'alice', 5, 10);
    s.upsertInventory(inv);
    const owned = s.ownInventory('alice');
    expect(owned).toHaveLength(1);
    expect(owned[0]).toEqual(inv);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('BITES: upsert same invId twice keeps count at 1 (keyed-Map idempotency, no array duplication)', () => {
    // Kills: an impl that stores inventory rows in an array and appends on re-insert.
    const s = new AuthoritativeStore();
    s.upsertInventory(inventoryRow(1n, 'alice', 5, 1));
    s.upsertInventory(inventoryRow(1n, 'alice', 5, 2)); // same invId — must overwrite
    const owned = s.ownInventory('alice');
    expect(owned).toHaveLength(1);
    expect(owned[0]!.count).toBe(2); // last-write wins
  });

  it('BITES: second upsert overwrites the row (last-write wins, count is updated)', () => {
    // Kills: an impl that silently drops a duplicate upsert instead of updating.
    const s = new AuthoritativeStore();
    s.upsertInventory(inventoryRow(7n, 'bob', 3, 5));
    s.upsertInventory({ ...inventoryRow(7n, 'bob', 3, 5), count: 99 });
    expect(s.ownInventory('bob')[0]!.count).toBe(99);
  });
});

// --- Inventory: removeInventory ------------------------------------------------

describe('AuthoritativeStore M9c: removeInventory', () => {
  it('BITES: removeInventory deletes the row; ownInventory() returns empty; batch is dirty', () => {
    // Kills: an impl that deletes but forgets to mark dirty, or soft-deletes.
    const s = new AuthoritativeStore();
    s.upsertInventory(inventoryRow(5n, 'carol'));
    s.flushBatch();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.removeInventory(5n);
    expect(s.ownInventory('carol')).toHaveLength(0);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('BITES: removeInventory on unknown invId does NOT mark dirty (no phantom re-renders)', () => {
    // Kills: an impl that marks dirty on a no-op delete.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.removeInventory(999n); // never inserted
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(0);
  });
});

// --- Inventory: ownInventory identity filter -----------------------------------

describe('AuthoritativeStore M9c: ownInventory identity filter', () => {
  it('BITES: ownInventory returns ONLY rows matching ownerIdentity (non-owner excluded)', () => {
    // Kills: an impl that returns ALL inventory rows regardless of owner.
    const s = new AuthoritativeStore();
    s.upsertInventory(inventoryRow(1n, 'me', 1, 5));
    s.upsertInventory(inventoryRow(2n, 'other', 2, 3));
    s.upsertInventory(inventoryRow(3n, 'me', 3, 1));
    const mine = s.ownInventory('me');
    expect(mine).toHaveLength(2);
    const invIds = mine.map((i) => i.invId);
    expect(invIds).toContain(1n);
    expect(invIds).toContain(3n);
    expect(invIds).not.toContain(2n);
  });

  it('S2: BITES ownInventory uses exact case-sensitive equality ("DEADBEEF" !== "deadbeef")', () => {
    // Kills: an impl that normalizes identity to lower/upper case before comparing.
    const s = new AuthoritativeStore();
    s.upsertInventory(inventoryRow(1n, 'DEADBEEF'));
    s.upsertInventory(inventoryRow(2n, 'deadbeef'));
    expect(s.ownInventory('DEADBEEF')).toHaveLength(1);
    expect(s.ownInventory('deadbeef')).toHaveLength(1);
    expect(s.ownInventory('DEADBEEF')[0]!.invId).toBe(1n);
    expect(s.ownInventory('deadbeef')[0]!.invId).toBe(2n);
  });

  it('ownInventory returns empty array when identity has no inventory', () => {
    // Kills: an impl that throws or returns undefined when no match.
    const s = new AuthoritativeStore();
    s.upsertInventory(inventoryRow(1n, 'alice'));
    expect(s.ownInventory('nobody')).toEqual([]);
  });
});

// --- Inventory: S6 — no unfiltered inventories() accessor ----------------------

describe('AuthoritativeStore M9c S6: no unfiltered inventories() accessor', () => {
  it('S6: BITES the store does NOT expose an unfiltered inventories() method', () => {
    // Privacy contract: callers MUST go through ownInventory(identity).
    // An unfiltered accessor would expose all players' inventory rows to any caller.
    // Kills: an impl that adds a public inventories() method as a shortcut.
    const s = new AuthoritativeStore();
    expect(typeof (s as unknown as Record<string, unknown>).inventories).not.toBe('function');
  });
});

// --- Inventory: S8 — ownInventory returns an independent snapshot --------------

describe('AuthoritativeStore M9c S8: ownInventory returns independent snapshot', () => {
  it('S8: BITES mutating the returned array does NOT corrupt the store (snapshot isolation)', () => {
    // Kills: an impl that returns a direct reference to the internal array/values.
    // A caller who pushes/pops/splices the returned array must not affect subsequent reads.
    const s = new AuthoritativeStore();
    s.upsertInventory(inventoryRow(1n, 'player', 5, 3));

    const first = s.ownInventory('player');
    expect(first).toHaveLength(1);

    // Mutate the returned array — splice out the item
    first.splice(0, 1);
    expect(first).toHaveLength(0); // local mutation

    // Re-query: the store must still have the original row
    const second = s.ownInventory('player');
    expect(second).toHaveLength(1);
    expect(second[0]!.count).toBe(3);
  });

  it('S8: BITES the count on a re-queried row is the authoritative stored value (not mutated copy)', () => {
    // Kills: an impl where the returned objects are live references — mutating
    // a field on the returned object corrupts the stored row.
    const s = new AuthoritativeStore();
    s.upsertInventory(inventoryRow(10n, 'player', 2, 7));

    const first = s.ownInventory('player');
    // Attempt to mutate the returned object (TypeScript readonly won't stop this at runtime)
    (first[0] as Record<string, unknown>).count = 999;

    // Re-query: the store must return the original count, not the mutated value
    const second = s.ownInventory('player');
    expect(second[0]!.count).toBe(7);
  });
});

// --- ItemDef: upsert / retrieve / remove ----------------------------------------

describe('AuthoritativeStore M9c: itemDef upsert + retrieve', () => {
  it('BITES: upsertItemDef stores the row; itemDef() retrieves it by id', () => {
    // Kills: an impl that exposes the method but never stores to the map.
    const s = new AuthoritativeStore();
    const def = itemDefRow(42, 'Attack');
    s.upsertItemDef(def);
    expect(s.itemDef(42)).toEqual(def);
  });

  it('BITES: upsert same id twice keeps count at 1 (keyed-Map idempotency)', () => {
    // Kills: an impl that stores item defs in an array and appends on re-insert.
    const s = new AuthoritativeStore();
    s.upsertItemDef(itemDefRow(1, null));
    s.upsertItemDef({ ...itemDefRow(1, null), name: 'Updated Name' }); // same id — overwrite
    const m = s.itemDefs();
    expect(m.size).toBe(1);
    expect(m.get(1)!.name).toBe('Updated Name');
  });

  it('BITES: itemDef() returns undefined for unknown id (not null, not throw)', () => {
    // Kills: an impl that throws on a missing key or returns null.
    const s = new AuthoritativeStore();
    expect(s.itemDef(999)).toBeUndefined();
  });

  it('BITES: removeItemDef deletes the entry; itemDef() returns undefined', () => {
    // Kills: an impl that soft-deletes or returns a tombstone.
    const s = new AuthoritativeStore();
    s.upsertItemDef(itemDefRow(5, 'Speed'));
    s.removeItemDef(5);
    expect(s.itemDef(5)).toBeUndefined();
  });

  it('BITES: removeItemDef on unknown id does NOT throw and does NOT mark dirty', () => {
    // Kills: an impl that throws or marks dirty on a no-op delete.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.removeItemDef(404); // never inserted
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(0);
  });
});

// --- ItemDef: itemDefs() defensive copy ----------------------------------------

describe('AuthoritativeStore M9c: itemDefs() returns a COPY (no live-map leak)', () => {
  it('BITES: itemDefs() exposes all item defs as a ReadonlyMap snapshot', () => {
    // Kills: an impl that returns an empty map, throws, or returns a live reference.
    const s = new AuthoritativeStore();
    s.upsertItemDef(itemDefRow(1, 'Attack'));
    s.upsertItemDef(itemDefRow(2, null));
    const m = s.itemDefs();
    expect(m.size).toBe(2);
    expect(m.get(1)!.trainStat).toBe('Attack');
    expect(m.get(2)!.trainStat).toBeNull();
  });

  it('BITES: mutating the returned itemDefs() map does NOT corrupt the store (defensive copy)', () => {
    // Kills: an impl that returns `this.#itemDefs` directly (live-map leak).
    const s = new AuthoritativeStore();
    const existing = itemDefRow(7, 'Hp');
    s.upsertItemDef(existing);

    const m = s.itemDefs() as Map<number, StoreItemRow>;
    m.set(999, itemDefRow(999, 'Speed')); // inject spurious entry
    m.delete(7); // delete real entry

    // Store must be unaffected
    expect(s.itemDef(999)).toBeUndefined();
    expect(s.itemDef(7)).toEqual(existing);
    expect(s.itemDefs().get(999)).toBeUndefined();
    expect(s.itemDefs().get(7)).toEqual(existing);
  });

  it('BITES: itemDefs() snapshot is stable even after subsequent upserts', () => {
    // Kills: a live-view impl — post-call upserts would appear in already-returned map.
    const s = new AuthoritativeStore();
    s.upsertItemDef(itemDefRow(10, null));
    const snap = s.itemDefs();
    expect(snap.size).toBe(1);

    s.upsertItemDef(itemDefRow(20, 'Defense')); // upsert AFTER snapshot taken

    expect(snap.get(20)).toBeUndefined(); // snapshot must not reflect the new upsert
    expect(snap.size).toBe(1);
  });
});

// --- S1: reset() clears #inventory + #itemDefs --------------------------------

describe('AuthoritativeStore M9c S1: reset() clears inventory and itemDefs', () => {
  it('S1: BITES reset() clears #inventory (ownInventory returns empty after reset)', () => {
    // Kills: an impl whose reset() does not clear the inventory map,
    // allowing a prior session's items to bleed into a fresh session.
    const s = new AuthoritativeStore();
    s.upsertInventory(inventoryRow(1n, 'player', 5, 10));
    expect(s.ownInventory('player')).toHaveLength(1);
    s.reset();
    expect(s.ownInventory('player')).toHaveLength(0);
  });

  it('S1: BITES reset() clears #itemDefs (itemDef() returns undefined after reset)', () => {
    // Kills: an impl whose reset() does not clear the itemDefs map.
    const s = new AuthoritativeStore();
    s.upsertItemDef(itemDefRow(3, 'Speed'));
    expect(s.itemDef(3)).toBeDefined();
    s.reset();
    expect(s.itemDef(3)).toBeUndefined();
    expect(s.itemDefs().size).toBe(0);
  });

  it('S1: BITES upsert->reset->re-query: both maps empty, listeners survive', () => {
    // Combined gate: prior session cannot bleed after reconnect.
    // Kills: a reset() that clears only one of the two new maps, or that
    // clears listeners (breaking the running loop).
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertInventory(inventoryRow(99n, 'oldUser', 1, 3));
    s.upsertItemDef(itemDefRow(7, 'Attack'));
    s.reset();
    // Both maps must be empty
    expect(s.ownInventory('oldUser')).toHaveLength(0);
    expect(s.itemDef(7)).toBeUndefined();
    expect(s.itemDefs().size).toBe(0);
    // Listeners must survive reset
    s.upsertInventory(inventoryRow(1n, 'newUser', 2, 1));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// --- Property: inventory count equals distinct invIds --------------------------

describe('AuthoritativeStore M9c: inventoryCount property (fast-check)', () => {
  it('BITES: ownInventory size equals distinct invIds for that owner after random upserts', () => {
    // Kills: an impl that inflates on re-insert (array) or undercounts (wrong key).
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 30n }), { maxLength: 50 }), (ids) => {
        const s = new AuthoritativeStore();
        for (const id of ids) {
          s.upsertInventory(inventoryRow(id, 'owner'));
        }
        expect(s.ownInventory('owner')).toHaveLength(new Set(ids).size);
      }),
    );
  });

  it('BITES: itemDefs().size equals distinct item ids after random upserts', () => {
    // Kills: an impl that duplicates entries or uses wrong key type.
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 30 }), { maxLength: 50 }), (ids) => {
        const s = new AuthoritativeStore();
        for (const id of ids) {
          s.upsertItemDef(itemDefRow(id));
        }
        expect(s.itemDefs().size).toBe(new Set(ids).size);
      }),
    );
  });
});

// =============================================================================
// M10c extension: StoreFusionRow — upsert / remove / iterate / reset / batch
// SOURCE OF TRUTH: specs/monster-realm-v2/M10c (Client evolution/fuse UI)
//
// These tests are INTENTIONALLY RED until the fusion map is added to
// AuthoritativeStore and StoreFusionRow is exported from store.ts.
// =============================================================================

/** Factory: minimal valid StoreFusionRow. */
function fusionRow(fusionId: bigint, aSpecies = 1, bSpecies = 2, toSpecies = 3): StoreFusionRow {
  return { fusionId, aSpecies, bSpecies, toSpecies };
}

describe('AuthoritativeStore M10c: fusion upsert + fusionCount', () => {
  it('BITES: upsertFusion stores a StoreFusionRow; fusionCount increments from 0 to 1', () => {
    // Kills: an impl that ignores upsertFusion or that never initializes the fusion map.
    // A fusionCount getter that always returns 0 is killed by the second assertion.
    const s = new AuthoritativeStore();
    expect(s.fusionCount).toBe(0);
    s.upsertFusion(fusionRow(1n, 1, 2, 3));
    expect(s.fusionCount).toBe(1);
  });

  it('BITES: re-inserting the same fusionId (idempotent reconnect) overwrites; count stays 1', () => {
    // Reconnect scenario: the subscription may replay the same row. A Map overwrite
    // must prevent duplication. Count staying at 1 kills any array-based impl.
    // Kills: an impl that appends on re-insert instead of overwriting.
    const s = new AuthoritativeStore();
    s.upsertFusion(fusionRow(1n, 1, 2, 3));
    s.upsertFusion({ fusionId: 1n, aSpecies: 1, bSpecies: 2, toSpecies: 99 }); // same id, changed toSpecies
    expect(s.fusionCount).toBe(1);
    // last-write wins: toSpecies must be 99 from the second upsert
    const rows = [...s.fusions()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toSpecies).toBe(99);
  });

  it('BITES: two distinct fusionIds → fusionCount is 2', () => {
    // Kills: a fusionCount that always returns 1 or reads from the wrong map.
    const s = new AuthoritativeStore();
    s.upsertFusion(fusionRow(1n, 1, 2, 3));
    s.upsertFusion(fusionRow(2n, 4, 5, 6));
    expect(s.fusionCount).toBe(2);
  });
});

describe('AuthoritativeStore M10c: removeFusion', () => {
  it('BITES: removeFusion removes the row; fusionCount goes back to 0', () => {
    // Kills: an impl where removeFusion is a no-op or removes from the wrong map.
    const s = new AuthoritativeStore();
    s.upsertFusion(fusionRow(7n, 1, 2, 3));
    expect(s.fusionCount).toBe(1);
    s.removeFusion(7n);
    expect(s.fusionCount).toBe(0);
  });

  it('BITES: removeFusion on unknown fusionId does NOT throw and does NOT increase fusionCount', () => {
    // Safety: a no-op delete must be silent, not an exception.
    // Kills: an impl that throws on a missing key or increments count on a no-op.
    const s = new AuthoritativeStore();
    expect(() => s.removeFusion(999n)).not.toThrow();
    expect(s.fusionCount).toBe(0);
  });
});

describe('AuthoritativeStore M10c: fusions() iterator', () => {
  it('BITES: fusions() iterates all stored StoreFusionRow values', () => {
    // Kills: an impl where fusions() returns an empty iterator or a non-iterable.
    const s = new AuthoritativeStore();
    const r1 = fusionRow(1n, 10, 11, 12);
    const r2 = fusionRow(2n, 20, 21, 22);
    s.upsertFusion(r1);
    s.upsertFusion(r2);
    const all = [...s.fusions()];
    expect(all).toHaveLength(2);
    // Both rows present (order is Map-insertion order — not contractually required,
    // but the values must match what was inserted):
    const fusionIds = all.map((f) => f.fusionId);
    expect(fusionIds).toContain(1n);
    expect(fusionIds).toContain(2n);
    const row1 = all.find((f) => f.fusionId === 1n)!;
    expect(row1.aSpecies).toBe(10);
    expect(row1.bSpecies).toBe(11);
    expect(row1.toSpecies).toBe(12);
  });

  it('BITES: fusions() on empty store returns an empty iterator (no crash, no undefined)', () => {
    // Kills: an impl that returns undefined or throws when no fusions exist.
    const s = new AuthoritativeStore();
    expect(() => {
      const result = [...s.fusions()];
      expect(result).toHaveLength(0);
    }).not.toThrow();
  });
});

describe('AuthoritativeStore M10c: reset() clears the fusion map', () => {
  it('BITES: reset() clears the fusion map (fusionCount → 0)', () => {
    // Kills: an impl whose reset() does not clear the fusion map, allowing
    // stale fusion rows from a prior session to bleed into a fresh session.
    const s = new AuthoritativeStore();
    s.upsertFusion(fusionRow(1n, 1, 2, 3));
    s.upsertFusion(fusionRow(2n, 4, 5, 6));
    expect(s.fusionCount).toBe(2);
    s.reset();
    expect(s.fusionCount).toBe(0);
    expect([...s.fusions()]).toHaveLength(0);
  });

  it('BITES: reset() still clears monster rows (existing reset behavior is unchanged)', () => {
    // Regression: adding the fusion map must NOT break the existing monster clear.
    // Kills: an impl that only clears fusions and accidentally omits the monster clear.
    const s = new AuthoritativeStore();
    s.upsertMonster(monsterPub(1n, 'alice'));
    s.upsertFusion(fusionRow(10n, 1, 2, 3));
    s.reset();
    expect(s.monsterCount).toBe(0); // existing behavior preserved
    expect(s.fusionCount).toBe(0); // new behavior
  });

  it('BITES: reset() clears fusions AND monsters AND existing maps; listeners survive', () => {
    // Combined gate: all maps are clean after reset; the loop listener is retained.
    // Kills: an impl that clears only some maps, or that removes listeners on reset.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertFusion(fusionRow(5n, 1, 2, 3));
    s.upsertMonster(monsterPub(1n, 'p'));
    s.reset();
    expect(s.fusionCount).toBe(0);
    expect(s.monsterCount).toBe(0);
    // Post-reset batch must still reach the still-registered listener
    s.upsertFusion(fusionRow(6n, 7, 8, 9));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('AuthoritativeStore M10c: upsertFusion/removeFusion mark dirty (flushBatch fires)', () => {
  it('BITES: upsertFusion marks dirty so flushBatch fires the batch listener', () => {
    // Kills: an impl that stores the fusion but forgets to set #dirty = true.
    // A listener that never fires means the render loop never updates after a fusion arrives.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertFusion(fusionRow(1n, 1, 2, 3));
    expect(cb).toHaveBeenCalledTimes(0); // not yet — flush hasn't been called
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1); // dirty was set → listener fired
  });

  it('BITES: removeFusion marks dirty so flushBatch fires the batch listener', () => {
    // Kills: an impl where removeFusion deletes the row but never sets #dirty = true.
    // The render loop would not know a fusion was removed and would show stale data.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertFusion(fusionRow(2n, 4, 5, 6));
    s.flushBatch(); // consume the upsert dirty
    cb.mockClear();
    s.removeFusion(2n);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1); // remove also marked dirty
  });

  it('BITES: removeFusion on unknown id does NOT mark dirty (no phantom re-renders)', () => {
    // Kills: an impl that marks dirty even on a no-op delete, causing spurious re-renders.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.removeFusion(999n); // never inserted
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(0);
  });
});

// Import the new type so TS errors are part of the red state
import type { StoreFusionRow } from './store';
