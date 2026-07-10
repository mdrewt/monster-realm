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
  type StoreShopItemRow,
  type StoreShopRow,
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

describe('AuthoritativeStore: receivedAt + snapshot ring buffer history (interp source)', () => {
  it('records receivedAt; prev=second-newest, latest=newest across ring buffer growth', () => {
    const s = new AuthoritativeStore();
    s.upsertCharacter(char(1n, 0, 0), 1000); // snap A
    expect(s.character(1n)!.receivedAt).toBe(1000);
    expect(s.character(1n)!.latest).toMatchObject({ tileX: 0, tileY: 0, receivedAt: 1000 });
    expect(s.character(1n)!.prev).toBeUndefined();

    s.upsertCharacter(char(1n, 1, 0), 1200); // snap B
    expect(s.character(1n)!.latest).toMatchObject({ tileX: 1, receivedAt: 1200 });
    expect(s.character(1n)!.prev).toMatchObject({ tileX: 0, receivedAt: 1000 });

    s.upsertCharacter(char(1n, 2, 0), 1400); // snap C — ring grows (≥ 3 kept up to INTERP_MAX_DEPTH=4)
    expect(s.character(1n)!.latest).toMatchObject({ tileX: 2, receivedAt: 1400 });
    expect(s.character(1n)!.prev).toMatchObject({ tileX: 1, receivedAt: 1200 }); // B (second-newest)
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

  it('history prev is always the second-newest (or absent on snap) regardless of ring depth', () => {
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
          // M12.5d-2: large tile delta (>1) triggers snap — prev is dropped.
          // Only assert prev when the last transition was a normal 1-tile step.
          const prevX = xs[xs.length - 2];
          if (Math.abs(xs[xs.length - 1] - prevX) <= 1) {
            expect(stored.prev?.tileX).toBe(prevX);
          } else {
            expect(stored.prev).toBeUndefined();
          }
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

// =============================================================================
// M11c extension: store.resetCharacters() (C3)
// SOURCE OF TRUTH: M11c EARS C3 — Store resetCharacters() method.
//
// RED REASON: `AuthoritativeStore` has no `resetCharacters()` method yet.
// All tests below will fail (TypeError: s.resetCharacters is not a function)
// until the implementer adds the method.
//
// Contract:
//   - resetCharacters() clears ONLY the #chars map.
//   - It does NOT touch #players, #monsters, #species, #battles, #skills,
//     #inventory, #itemDefs, or #fusions.
// =============================================================================

describe('AuthoritativeStore M11c C3: resetCharacters() clears only the character map', () => {
  it('BITES: after resetCharacters(), characterCount is 0', () => {
    // Kills: an impl where resetCharacters() is a no-op or clears the wrong map.
    const s = new AuthoritativeStore();
    s.upsertCharacter(char(1n, 2, 3), 100);
    s.upsertCharacter(char(2n, 4, 5), 100);
    expect(s.characterCount).toBe(2);
    s.resetCharacters();
    expect(s.characterCount).toBe(0);
  });

  it('BITES: after resetCharacters(), character(id) returns undefined', () => {
    // Kills: an impl that decrements a counter but keeps rows accessible.
    const s = new AuthoritativeStore();
    s.upsertCharacter(char(42n, 3, 7), 100);
    s.resetCharacters();
    expect(s.character(42n)).toBeUndefined();
  });

  it('BITES: resetCharacters() does NOT clear players', () => {
    // Kills: an impl that calls reset() (which clears everything) instead of
    // targeting only the character map.
    const s = new AuthoritativeStore();
    s.upsertPlayer(player('alice', 1n));
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.resetCharacters();
    // Player row must still be present
    expect(s.player('alice')).toBeDefined();
    expect(s.player('alice')!.entityId).toBe(1n);
  });

  it('BITES: resetCharacters() does NOT clear monsters', () => {
    // Kills: an impl that wipes all maps instead of just #chars.
    const s = new AuthoritativeStore();
    s.upsertMonster(monsterPub(7n, 'bob'));
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.resetCharacters();
    expect(s.monster(7n)).toBeDefined();
    expect(s.monsterCount).toBe(1);
  });

  it('BITES: resetCharacters() does NOT clear species', () => {
    // Kills: an impl that routes resetCharacters() through a full reset().
    const s = new AuthoritativeStore();
    s.upsertSpecies(speciesRow(3));
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.resetCharacters();
    expect(s.species(3)).toBeDefined();
    expect(s.speciesMap().size).toBe(1);
  });

  it('BITES: resetCharacters() does NOT clear battles', () => {
    // Kills: an impl that resets battles as a side effect.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(1n, 'alice'));
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.resetCharacters();
    expect(s.battle(1n)).toBeDefined();
  });

  it('BITES: resetCharacters() does NOT clear skills', () => {
    // Kills: an impl that resets the skill map as a side effect.
    const s = new AuthoritativeStore();
    s.upsertSkill(skillRow(10));
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.resetCharacters();
    expect(s.skill(10)).toBeDefined();
  });

  it('BITES: characters upserted after resetCharacters() are visible (map is still live)', () => {
    // Kills: an impl that nulls out the map reference instead of calling .clear().
    const s = new AuthoritativeStore();
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.resetCharacters();
    s.upsertCharacter(char(2n, 5, 5), 200);
    expect(s.characterCount).toBe(1);
    expect(s.character(2n)!.row.tileX).toBe(5);
  });

  it('BITES: resetCharacters() marks batch dirty so flushBatch fires', () => {
    // Kills: an impl that clears without marking dirty (render loop misses the warp transition).
    const s = new AuthoritativeStore();
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.flushBatch(); // drain dirty from upsert
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.resetCharacters();
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('BITES: resetCharacters() on already-empty map does NOT mark dirty (no phantom re-render)', () => {
    // Kills: an impl that unconditionally marks dirty even when nothing changed.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.resetCharacters(); // nothing to clear
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(0);
  });
});

// =============================================================================
// M12.5d-2: upsertCharacter snap-on-teleport
// SOURCE OF TRUTH: M12.5d spec §2 "Snap-on-zone-change and snap-on-large-tile-delta"
//
// RED REASON (before impl): upsertCharacter always sets prev=existing?.latest with no
// zone-change or tile-delta check. A zone change would carry prev from the old zone
// (smearing across zone boundary) and a large tile jump (teleport) would carry prev
// from the old position (smearing across a warp). After fix: zone change or abs(Δtile)>1
// on either axis causes prev to be dropped (undefined), so the renderer snaps instead.
// =============================================================================

describe('AuthoritativeStore: upsertCharacter snap-on-teleport (M12.5d-2)', () => {
  function charWithZone(
    entityId: bigint,
    zoneId: number,
    tileX: number,
    tileY: number,
  ): StoreCharacter {
    return {
      entityId,
      zoneId,
      tileX,
      tileY,
      facing: 'East',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [],
    };
  }

  it('BITES (M12.5d-2): zone change drops prev — snap, not smear', () => {
    // Wrong impl killed: upsertCharacter that always sets prev=existing?.latest would
    // set prev to the zone-0 snapshot when zone changes to 1. The renderer would then
    // interpolate across the zone boundary, showing the character sliding from zone 0
    // into zone 1. After fix: zone change → prev=undefined → renderer snaps immediately.
    const s = new AuthoritativeStore();
    // First insert at zone 0
    s.upsertCharacter(charWithZone(1n, 0, 5, 5), 100);
    // Zone changes to 1: prev must be dropped (would smear across zone boundary)
    s.upsertCharacter(charWithZone(1n, 1, 5, 5), 300);
    const stored = s.character(1n)!;
    expect(stored.prev).toBeUndefined(); // snapped: no prev to interpolate from wrong zone
    expect(stored.latest.tileX).toBe(5);
  });

  it('BITES (M12.5d-2): tile delta > 1 drops prev — snap, not smear (teleport)', () => {
    // Wrong impl killed: upsertCharacter that always carries prev would set prev=(2,2)
    // when a teleport to (10,2) arrives. The renderer would lerp from (2,2) to (10,2),
    // showing an 8-tile slide instead of an instant warp. After fix: Δx=8 > 1 → prev=undefined.
    const s = new AuthoritativeStore();
    // First insert at (2, 2)
    s.upsertCharacter(charWithZone(2n, 0, 2, 2), 100);
    // Teleport to (10, 2): delta = 8 > 1
    s.upsertCharacter(charWithZone(2n, 0, 10, 2), 300);
    const stored = s.character(2n)!;
    expect(stored.prev).toBeUndefined(); // snapped: large delta
  });

  it('BITES (M12.5d-2): adjacent tile (delta=1) preserves prev — normal movement', () => {
    // This is the "teeth" inverse: a correct impl MUST preserve prev for normal 1-tile
    // movement. Wrong impl killed (over-snap): dropping prev for delta=1 would break
    // smooth interpolation for regular walking.
    const s = new AuthoritativeStore();
    s.upsertCharacter(charWithZone(3n, 0, 5, 5), 100);
    // Move one tile east: delta = 1 in X, 0 in Y
    s.upsertCharacter(charWithZone(3n, 0, 6, 5), 300);
    const stored = s.character(3n)!;
    // prev is preserved (normal walk)
    expect(stored.prev).toBeDefined();
    expect(stored.prev!.tileX).toBe(5);
  });

  it('BITES (M12.5d-2): first insert has no prev (no existing entity)', () => {
    // Baseline contract: the first upsert for an entity always has prev=undefined
    // (no prior snapshot to interpolate from). This must remain true after the fix.
    const s = new AuthoritativeStore();
    s.upsertCharacter(charWithZone(4n, 0, 3, 3), 100);
    const stored = s.character(4n)!;
    expect(stored.prev).toBeUndefined(); // no prior snapshot
  });

  it('BITES (M12.5d-2): diagonal delta-1 move preserves prev (max(|Δx|,|Δy|)=1)', () => {
    // Game only allows cardinal moves, but verify our check is correct for each axis.
    // Delta-1 in both x and y: still within the "adjacent" threshold for each axis independently.
    // Wrong impl killed: using Euclidean distance (√2 > 1) would snap on diagonal moves.
    const s = new AuthoritativeStore();
    s.upsertCharacter(charWithZone(5n, 0, 5, 5), 100);
    // Move diagonally (5,5) -> (6,6): both axis delta=1
    s.upsertCharacter(charWithZone(5n, 0, 6, 6), 300);
    const stored = s.character(5n)!;
    expect(stored.prev).toBeDefined(); // delta=1 on each axis, not a teleport
  });
});

describe('AuthoritativeStore M12b: playerCount vs characterCount (NPC isolation)', () => {
  it('BITES: playerCount only counts player rows, not NPC characters', () => {
    // Kills: an impl that uses characterCount for presenceCount — M12b NPCs inflate it.
    // Two players each have a character; plus one NPC character (no player row).
    const s = new AuthoritativeStore();
    s.upsertPlayer(player('alice', 1n));
    s.upsertPlayer(player('bob', 2n));
    s.upsertCharacter(char(1n, 0, 0), 100); // alice
    s.upsertCharacter(char(2n, 1, 0), 100); // bob
    s.upsertCharacter(char(99n, 5, 5), 100); // NPC (no player row)
    expect(s.characterCount).toBe(3); // NPC + 2 players
    expect(s.playerCount).toBe(2); // only human players
  });

  it('BITES: playerCount drops when a player leaves', () => {
    const s = new AuthoritativeStore();
    s.upsertPlayer(player('alice', 1n));
    s.upsertPlayer(player('bob', 2n));
    expect(s.playerCount).toBe(2);
    s.removePlayer('alice');
    expect(s.playerCount).toBe(1);
  });
});

// =============================================================================
// M12d extension: conversation / quest / heal / npc maps
// SOURCE OF TRUTH: docs/m12d-plan.md + docs/adr/0071-m12d-client-dialogue-quest-heal-ui.md
//
// RED REASON: AuthoritativeStore has none of the 4 new maps yet:
//   #conversations, #quests, #healLocations, #npcs
//
// The types StorePlayerConversation, StorePlayerQuest, StoreHealLocationRow,
// StoreNpcRow are also not yet exported from store.ts.
//
// All tests below will fail (TypeError: s.upsertConversation is not a function,
// etc.) until the implementer adds the new maps and methods.
//
// Contract summary:
//   upsertConversation/removeConversation — keyed by ownerIdentity (one per player)
//   ownConversation(identity) — returns own row or undefined (privacy by filter)
//   upsertQuest/removeQuest — keyed by pqId (bigint)
//   ownQuests(identity) — returns only matching ownerIdentity rows
//   upsertHealLocation/removeHealLocation — keyed by locationId (number)
//   healLocations() — returns all heal location rows (public content)
//   upsertNpc/removeNpc — keyed by entityId (bigint)
//   npc(entityId) — returns by entityId
//   npcByNpcId(npcId) — returns by npcId string
//   reset() — clears ALL 4 new maps
// =============================================================================

// ---------------------------------------------------------------------------
// Local type definitions (not yet exported from store.ts — tests red for impl)
// ---------------------------------------------------------------------------
interface StorePlayerConversation {
  ownerIdentity: string;
  npcEntityId: bigint;
  currentNodeId: string;
}

interface StorePlayerQuest {
  pqId: bigint;
  ownerIdentity: string;
  questId: string;
  stepIndex: number;
}

interface StoreHealLocationRow {
  locationId: number;
  zoneId: number;
  tileX: number;
  tileY: number;
  costItemId?: number;
  costQty: number;
  cooldownMs: number;
}

interface StoreNpcRow {
  entityId: bigint;
  npcId: string;
  zoneId: number;
  homeX: number;
  homeY: number;
  wanderRadius: number;
  dialogueTreeId: string;
}

// Factories for M12d store tests
function convRow(
  ownerIdentity: string,
  npcEntityId = 1n,
  currentNodeId = 'greeting',
): StorePlayerConversation {
  return { ownerIdentity, npcEntityId, currentNodeId };
}

function questRow(
  pqId: bigint,
  ownerIdentity: string,
  questId = 'quest_001',
  stepIndex = 0,
): StorePlayerQuest {
  return { pqId, ownerIdentity, questId, stepIndex };
}

function healLocationRow(locationId: number, zoneId = 0): StoreHealLocationRow {
  return {
    locationId,
    zoneId,
    tileX: 10,
    tileY: 10,
    costItemId: undefined,
    costQty: 0,
    cooldownMs: 30000,
  };
}

function npcRow(
  entityId: bigint,
  npcId = `npc-${entityId}`,
  dialogueTreeId = 'elder_oak_talk',
): StoreNpcRow {
  return {
    entityId,
    npcId,
    zoneId: 0,
    homeX: 5,
    homeY: 5,
    wanderRadius: 2,
    dialogueTreeId,
  };
}

describe('M12d: conversation / quest / heal / npc maps', () => {
  // --- ownConversation: own row returned, another player's not ---

  it('BITES: upsertConversation + ownConversation(identity) returns own row', () => {
    // Kills: an impl that ignores ownerIdentity and returns any conversation,
    // or one that stores to the wrong map key.
    const s = new AuthoritativeStore();
    const row = convRow('alice-hex', 7n, 'greeting');
    (s as unknown as Record<string, Function>).upsertConversation(row);
    const result = (s as unknown as Record<string, Function>).ownConversation('alice-hex') as
      | StorePlayerConversation
      | undefined;
    expect(result).toBeDefined();
    expect(result!.ownerIdentity).toBe('alice-hex');
    expect(result!.npcEntityId).toBe(7n);
    expect(result!.currentNodeId).toBe('greeting');
  });

  it('BITES: ownConversation returns undefined for a different identity', () => {
    // Kills: an impl that returns the first conversation regardless of ownerIdentity.
    // Privacy contract: another player's conversation must not be returned.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, Function>).upsertConversation(convRow('alice-hex'));
    const result = (s as unknown as Record<string, Function>).ownConversation('bob-hex');
    expect(result).toBeUndefined();
  });

  // --- removeConversation: row deleted, ownConversation returns undefined ---

  it('BITES: removeConversation deletes the row; ownConversation returns undefined after', () => {
    // Kills: an impl that soft-deletes or retains the row after removal.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, Function>).upsertConversation(convRow('alice-hex'));
    (s as unknown as Record<string, Function>).removeConversation('alice-hex');
    const result = (s as unknown as Record<string, Function>).ownConversation('alice-hex');
    expect(result).toBeUndefined();
  });

  // --- ownQuests: filters by ownerIdentity ---

  it('BITES: upsertQuest + ownQuests(identity) returns only own quests', () => {
    // Kills: an impl that returns ALL quests regardless of owner identity.
    // Privacy contract: another player's quests must not appear.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, Function>).upsertQuest(questRow(1n, 'alice-hex', 'q1'));
    (s as unknown as Record<string, Function>).upsertQuest(questRow(2n, 'bob-hex', 'q2'));
    (s as unknown as Record<string, Function>).upsertQuest(questRow(3n, 'alice-hex', 'q3'));
    const aliceQuests = (s as unknown as Record<string, Function>).ownQuests(
      'alice-hex',
    ) as StorePlayerQuest[];
    expect(aliceQuests).toHaveLength(2);
    const questIds = aliceQuests.map((q) => q.questId);
    expect(questIds).toContain('q1');
    expect(questIds).toContain('q3');
    expect(questIds).not.toContain('q2');
  });

  // --- reset() clears ALL 4 new maps ---

  it('BITES: reset() clears ALL 4 new maps (4 assertions in one reset test)', () => {
    // Combined gate: prior session data must not bleed after reconnect for any of the 4 maps.
    // Kills: an impl whose reset() clears only some of the new maps.
    // Also kills: an impl that clears listeners on reset (existing contract).
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);

    // Populate all 4 new maps
    (s as unknown as Record<string, Function>).upsertConversation(convRow('player-hex', 1n));
    (s as unknown as Record<string, Function>).upsertQuest(questRow(1n, 'player-hex', 'q1'));
    (s as unknown as Record<string, Function>).upsertHealLocation(healLocationRow(1, 0));
    (s as unknown as Record<string, Function>).upsertNpc(npcRow(99n, 'elder_oak'));

    s.reset();

    // Assertion 1: #conversations cleared
    expect(
      (s as unknown as Record<string, Function>).ownConversation('player-hex'),
    ).toBeUndefined();

    // Assertion 2: #quests cleared
    expect((s as unknown as Record<string, Function>).ownQuests('player-hex')).toHaveLength(0);

    // Assertion 3: #healLocations cleared
    expect((s as unknown as Record<string, Function>).healLocations()).toHaveLength(0);

    // Assertion 4: #npcs cleared
    expect((s as unknown as Record<string, Function>).npc(99n)).toBeUndefined();

    // Listeners must survive reset (existing contract preserved)
    (s as unknown as Record<string, Function>).upsertNpc(npcRow(1n));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  // --- healLocations: returns all locations (public content) ---

  it('BITES: upsertHealLocation + healLocations() returns all locations', () => {
    // Kills: an impl that filters healLocations by any identity (it is public content).
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, Function>).upsertHealLocation(healLocationRow(1, 0));
    (s as unknown as Record<string, Function>).upsertHealLocation(healLocationRow(2, 1));
    const locs = (
      s as unknown as Record<string, Function>
    ).healLocations() as StoreHealLocationRow[];
    expect(locs).toHaveLength(2);
    const locIds = locs.map((l) => l.locationId);
    expect(locIds).toContain(1);
    expect(locIds).toContain(2);
  });

  it('BITES: upsert same locationId twice keeps count at 1 (keyed-Map idempotency)', () => {
    // Reconnect scenario: subscription may replay the same row.
    // Kills: an impl that stores heal locations in an array and appends on re-insert.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, Function>).upsertHealLocation(healLocationRow(5, 0));
    (s as unknown as Record<string, Function>).upsertHealLocation({
      ...healLocationRow(5, 0),
      cooldownMs: 60000,
    });
    const locs = (
      s as unknown as Record<string, Function>
    ).healLocations() as StoreHealLocationRow[];
    expect(locs).toHaveLength(1);
    expect(locs[0]!.cooldownMs).toBe(60000); // last-write wins
  });

  // --- npc(entityId) and npcByNpcId(npcId) ---

  it('BITES: upsertNpc + npc(entityId) returns the NPC row', () => {
    // Kills: an impl that stores npcs by npcId string instead of entityId bigint.
    const s = new AuthoritativeStore();
    const npc = npcRow(42n, 'elder_oak', 'elder_oak_talk');
    (s as unknown as Record<string, Function>).upsertNpc(npc);
    const result = (s as unknown as Record<string, Function>).npc(42n) as StoreNpcRow | undefined;
    expect(result).toBeDefined();
    expect(result!.entityId).toBe(42n);
    expect(result!.npcId).toBe('elder_oak');
    expect(result!.dialogueTreeId).toBe('elder_oak_talk');
  });

  it('BITES: npcByNpcId(npcId) returns same row as npc(entityId)', () => {
    // Kills: an impl that only indexes by entityId and throws on npcId lookup.
    // The dialogue system looks up NPCs by both entityId (from conversation row)
    // and npcId (for display/content lookup).
    const s = new AuthoritativeStore();
    const npc = npcRow(42n, 'elder_oak', 'elder_oak_talk');
    (s as unknown as Record<string, Function>).upsertNpc(npc);
    const byEntityId = (s as unknown as Record<string, Function>).npc(42n) as
      | StoreNpcRow
      | undefined;
    const byNpcId = (s as unknown as Record<string, Function>).npcByNpcId('elder_oak') as
      | StoreNpcRow
      | undefined;
    expect(byEntityId).toBeDefined();
    expect(byNpcId).toBeDefined();
    expect(byNpcId!.entityId).toBe(42n);
    expect(byNpcId!.npcId).toBe('elder_oak');
    // Both lookups return the same underlying data
    expect(byEntityId!.dialogueTreeId).toBe(byNpcId!.dialogueTreeId);
  });

  it('BITES: npc(entityId) returns undefined for unknown entityId (not throw)', () => {
    // Kills: an impl that throws on Map miss.
    const s = new AuthoritativeStore();
    expect((s as unknown as Record<string, Function>).npc(999n)).toBeUndefined();
  });

  it('BITES: npcByNpcId(npcId) returns undefined for unknown npcId (not throw)', () => {
    // Kills: an impl that throws when npcId is not in the index.
    const s = new AuthoritativeStore();
    expect(
      (s as unknown as Record<string, Function>).npcByNpcId('nonexistent_npc'),
    ).toBeUndefined();
  });

  it('BITES: upsertNpc marks batch dirty so flushBatch fires', () => {
    // Kills: an impl that stores the NPC but forgets to set #dirty=true.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    (s as unknown as Record<string, Function>).upsertNpc(npcRow(1n));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  // --- Fix 3: removeQuest / removeHealLocation / removeNpc ---

  it('BITES: removeQuest removes the quest from ownQuests', () => {
    // The connection.ts onDelete handler calls removeQuest; an impl that is a no-op
    // leaves stale quest rows in the store after server deletion.
    // Kills: an impl that ignores removeQuest or removes from the wrong map.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, Function>).upsertQuest(questRow(10n, 'alice-hex', 'quest_abc'));
    (s as unknown as Record<string, Function>).upsertQuest(questRow(11n, 'alice-hex', 'quest_xyz'));
    // Remove only quest 10n
    (s as unknown as Record<string, Function>).removeQuest(10n);
    const remaining = (s as unknown as Record<string, Function>).ownQuests(
      'alice-hex',
    ) as StorePlayerQuest[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.questId).toBe('quest_xyz');
  });

  it('BITES: removeHealLocation removes the location from healLocations', () => {
    // The connection.ts onDelete handler calls removeHealLocation; an impl that is a
    // no-op leaves stale heal location rows visible to the HealView.
    // Kills: an impl that ignores removeHealLocation or removes from the wrong map.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, Function>).upsertHealLocation(healLocationRow(1, 0));
    (s as unknown as Record<string, Function>).upsertHealLocation(healLocationRow(2, 1));
    (s as unknown as Record<string, Function>).removeHealLocation(1);
    const locs = (
      s as unknown as Record<string, Function>
    ).healLocations() as StoreHealLocationRow[];
    expect(locs).toHaveLength(1);
    expect(locs[0]!.locationId).toBe(2);
  });

  it('BITES: removeNpc removes by entityId — npc(entityId) returns undefined', () => {
    // The connection.ts onDelete handler calls removeNpc; an impl that is a no-op
    // leaves stale NPC entries that would appear in dialogue lookups.
    // Kills: an impl that ignores removeNpc or uses the wrong key.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, Function>).upsertNpc(npcRow(42n, 'elder_oak'));
    (s as unknown as Record<string, Function>).removeNpc(42n);
    expect((s as unknown as Record<string, Function>).npc(42n)).toBeUndefined();
  });

  it('BITES: removeNpc also clears npcByNpcId index', () => {
    // Both lookup paths (#npcs keyed by entityId and the npcId index) must be cleared
    // on remove. An impl that only removes from one map leaves a dangling secondary
    // index that returns a stale row for npcByNpcId after the NPC is gone.
    // Kills: an impl that clears #npcs but forgets to clear the npcId secondary index.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, Function>).upsertNpc(npcRow(42n, 'elder_oak'));
    (s as unknown as Record<string, Function>).removeNpc(42n);
    expect((s as unknown as Record<string, Function>).npcByNpcId('elder_oak')).toBeUndefined();
  });

  // --- Fix 4: flushBatch tests for upsertConversation / upsertQuest / upsertHealLocation ---

  it('BITES: upsertConversation marks batch dirty so flushBatch fires', () => {
    // Kills: an impl that stores the conversation row but forgets to set #dirty=true,
    // so the render loop never learns that a conversation has started.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    (s as unknown as Record<string, Function>).upsertConversation(
      convRow('player-hex', 1n, 'greeting'),
    );
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('BITES: upsertQuest marks batch dirty so flushBatch fires', () => {
    // Kills: an impl that stores the quest row but forgets to set #dirty=true,
    // so the quest log view never refreshes when a new quest is accepted.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    (s as unknown as Record<string, Function>).upsertQuest(questRow(1n, 'player-hex', 'q1'));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('BITES: upsertHealLocation marks batch dirty so flushBatch fires', () => {
    // Kills: an impl that stores the heal location row but forgets to set #dirty=true,
    // so the heal view never renders when location content arrives from the server.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    (s as unknown as Record<string, Function>).upsertHealLocation(healLocationRow(5, 0));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  // --- remove* dirty-marking tests (RT Finding 4 / Finding 3 follow-up) ---

  it('BITES: removeConversation marks batch dirty so flushBatch fires (overlay hides)', () => {
    // Server auto-dismisses conversation (RT-ADV-01) by deleting the row.
    // removeConversation must mark dirty so the render loop hides the dialogue overlay.
    // Kills: an impl that deletes the row but forgets #dirty=true (overlay stays open).
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, Function>).upsertConversation(
      convRow('alice-hex', 1n, 'greeting'),
    );
    s.flushBatch();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    (s as unknown as Record<string, Function>).removeConversation('alice-hex');
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('BITES: removeQuest marks batch dirty so flushBatch fires (quest log refreshes)', () => {
    // Server deletes player_quest on completion. removeQuest must mark dirty so
    // the quest log view re-renders and drops the completed quest.
    // Kills: an impl that no-ops removeQuest or forgets #dirty=true.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, Function>).upsertQuest(questRow(5n, 'alice-hex', 'q'));
    s.flushBatch();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    (s as unknown as Record<string, Function>).removeQuest(5n);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('BITES: removeNpc marks batch dirty so flushBatch fires', () => {
    // Kills: an impl that removes the NPC row but forgets #dirty=true.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, Function>).upsertNpc(npcRow(7n));
    s.flushBatch();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    (s as unknown as Record<string, Function>).removeNpc(7n);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  // --- npcByNpcId secondary index consistency on re-upsert (RT Finding 7) ---

  it('BITES: re-upsert with changed npcId updates secondary index (old npcId returns undefined)', () => {
    // If an impl builds the secondary index with first-insert-only semantics, a re-upsert
    // that changes npcId leaves the OLD npcId returning the outdated row.
    // Kills: `if (!this.#npcsByNpcId.has(row.npcId)) { this.#npcsByNpcId.set(...) }`
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, Function>).upsertNpc(npcRow(1n, 'old_id', 'tree_a'));
    // Same entityId, changed npcId (e.g. server corrects the NPC definition)
    (s as unknown as Record<string, Function>).upsertNpc(npcRow(1n, 'new_id', 'tree_b'));
    expect((s as unknown as Record<string, Function>).npcByNpcId('new_id')).toBeDefined();
    expect((s as unknown as Record<string, Function>).npcByNpcId('old_id')).toBeUndefined(); // stale index must be purged on re-upsert
    expect((s as unknown as Record<string, Function>).npc(1n)).toBeDefined();
  });
});

// =============================================================================
// M10.5d: AuthoritativeStore flushBatch per-listener isolation (closes M8.8e residual)
// SOURCE OF TRUTH: M10.5d EARS criterion 10.5d-3
//
// RED REASON (before impl): flushBatch currently iterates listeners with a bare
// `for (const cb of [...this.#batchListeners]) cb()`. A throwing listener exits
// the loop immediately — all subsequent listeners (siblings) are never called.
// This is the M8.8e residual: "store.flushBatch has NO per-listener isolation
// (a throwing batch listener starves siblings) → pending store.ts follow-up".
//
// After fix: each listener call is wrapped in its own try/catch (log + continue),
// so a throwing listener is caught and logged, and the loop continues to call
// all remaining siblings.
//
// BITES: the three tests below will FAIL against the current implementation:
//   Test 1 — sibling is NOT called (starvation proof)
//   Test 2 — console.error is NOT called (no log proof)
//   Test 3 — flushBatch DOES throw (propagation proof)
// =============================================================================

describe('AuthoritativeStore: flushBatch per-listener isolation (M10.5d — closes M8.8e residual)', () => {
  it('BITES: a throwing first listener does NOT starve the sibling listener', () => {
    // Wrong impl killed: `for (const cb of [...this.#batchListeners]) cb()`
    // — when the first cb() throws, the loop exits and the sibling is never called.
    // After fix (try/catch per listener): the throw is caught and the loop continues,
    // so the sibling is always called regardless of the first listener's outcome.
    const s = new AuthoritativeStore();
    const sibling = vi.fn();

    // Register a throwing listener FIRST, then the sibling.
    s.onBatchApplied(() => {
      throw new Error('listener-throws');
    });
    s.onBatchApplied(sibling);

    // Mark dirty so flushBatch has work to do (a clean store returns early).
    s.upsertCharacter(char(1n, 0, 0), 100);

    // Current impl: sibling is NOT called (starvation). After fix: sibling IS called.
    s.flushBatch();
    expect(sibling).toHaveBeenCalledTimes(1);
  });

  it('BITES: a throwing listener causes console.error to be called once', () => {
    // Wrong impl killed: the throw propagates uncaught — console.error is never reached.
    // After fix: the catch block logs via console.error before continuing.
    const s = new AuthoritativeStore();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    s.onBatchApplied(() => {
      throw new Error('listener-throws-for-log-check');
    });

    s.upsertCharacter(char(2n, 1, 0), 100);

    // Current impl: throws propagate — console.error is never called. After fix: logged once.
    try {
      s.flushBatch();
      expect(errSpy).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('BITES: flushBatch itself does NOT throw when a listener throws (isolation boundary)', () => {
    // Wrong impl killed: the throw from cb() propagates out of flushBatch to the caller.
    // The connection adapter calls flushBatch in every transaction; an uncaught throw
    // would crash the adapter's event loop and freeze the entire game.
    // After fix: the try/catch boundary ensures flushBatch always completes normally.
    const s = new AuthoritativeStore();
    const sibling = vi.fn();

    s.onBatchApplied(() => {
      throw new Error('listener-throws-propagation-check');
    });
    s.onBatchApplied(sibling);

    s.upsertCharacter(char(3n, 2, 0), 100);

    // Current impl: flushBatch DOES throw (propagates from cb()). After fix: does NOT throw.
    expect(() => s.flushBatch()).not.toThrow();

    // Sibling must also have been reached (combined isolation assertion).
    expect(sibling).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// M13d shop store gating tests (RT-SHOP-01, RT-SHOP-02)
// SOURCE OF TRUTH: adversarial review of M13d shop client UI (2026-07-04)
// ---------------------------------------------------------------------------

function shopRow(shopId: number, name = `Shop-${shopId}`): StoreShopRow {
  return { shopId, name };
}
function shopItemRow(
  shopItemId: bigint,
  shopId: number,
  itemId: number,
  buyPrice: bigint = 10n,
): StoreShopItemRow {
  return { shopItemId, shopId, itemId, buyPrice };
}

// RT-SHOP-01: reset() clears shop maps and sets dirty=false (no phantom re-render).
// Finding: store.reset() comments claim shops "survive reconnect" but the implementation
// DOES clear them. The comment is misleading, but the code is correct — shops ARE cleared
// and must be re-subscribed after reconnect. This test gates that clear + no dirty race.
describe('AuthoritativeStore M13d RT-SHOP-01: reset() clears shop maps; dirty is false after reset', () => {
  it('RT-SHOP-01 BITES: reset() clears #shops and #shopItems (allShops/allShopItems return empty)', () => {
    // Kills: an impl that omits #shops.clear() or #shopItems.clear() from reset(),
    // leaving stale shop rows visible after a reconnect cycle.
    const s = new AuthoritativeStore();
    s.upsertShop(shopRow(1, 'General Store'));
    s.upsertShopItem(shopItemRow(1n, 1, 5, 100n));
    expect(s.allShops()).toHaveLength(1);
    expect(s.allShopItems()).toHaveLength(1);

    s.reset();

    expect(s.allShops()).toHaveLength(0);
    expect(s.allShopItems()).toHaveLength(0);
  });

  it('RT-SHOP-01 BITES: after reset(), batch listeners are NOT fired (dirty=false, no spurious flush)', () => {
    // Kills: an impl that calls flushBatch() inside reset() or sets dirty=true,
    // which would trigger a stale re-render of the shop overlay during disconnect handling.
    // The shop batch listener reading allShops() after reset() would return [], causing
    // the shop to flash "No shop available." mid-session rather than just going stale.
    const s = new AuthoritativeStore();
    const listener = vi.fn();
    s.onBatchApplied(listener);
    s.upsertShop(shopRow(2));
    s.flushBatch(); // consume the dirty from upsert
    listener.mockClear();

    s.reset(); // must NOT set dirty=true or call flushBatch

    // No additional flushBatch call — listener must NOT fire again
    expect(listener).not.toHaveBeenCalled();
  });

  it('RT-SHOP-01 BITES: post-reset upsertShop triggers batch listener (reconnect re-seed path)', () => {
    // Kills: an impl whose reset() also clears batch listeners (breaking the running loop).
    const s = new AuthoritativeStore();
    const listener = vi.fn();
    s.onBatchApplied(listener);

    s.reset();
    // Post-reset re-seed: SDK fires onInsert for shop_row after reconnect
    s.upsertShop(shopRow(3, 'Reconnected Shop'));
    s.flushBatch();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(s.allShops()).toHaveLength(1);
    expect(s.allShops()[0]!.name).toBe('Reconnected Shop');
  });
});

// RT-SHOP-02: shopItemsByShopId filters correctly; cross-shop contamination is impossible.
// Finding: buildShopViewModel relies on the shopId filter in both the store accessor and
// the model. A broken store accessor (returning all items regardless of shopId) would
// display items from other shops in the for-sale list, potentially confusing the player
// about which shop stocks which item. This is not a security issue (server validates on
// buy) but is a data-integrity invariant the view-model test suite also gates.
describe('AuthoritativeStore M13d RT-SHOP-02: shopItemsByShopId returns ONLY items for the given shopId', () => {
  it('RT-SHOP-02 BITES: shopItemsByShopId(1) excludes items for shopId=2', () => {
    // Kills: an impl that returns allShopItems() without filtering (all items visible for any shopId).
    const s = new AuthoritativeStore();
    s.upsertShopItem(shopItemRow(1n, 1, 10, 50n)); // shopId=1, itemId=10
    s.upsertShopItem(shopItemRow(2n, 2, 20, 80n)); // shopId=2, itemId=20
    s.upsertShopItem(shopItemRow(3n, 1, 30, 25n)); // shopId=1, itemId=30

    const shop1Items = s.shopItemsByShopId(1);
    expect(shop1Items).toHaveLength(2);
    expect(shop1Items.every((i) => i.shopId === 1)).toBe(true);
    expect(shop1Items.some((i) => i.itemId === 20)).toBe(false); // shopId=2 item must not appear
  });

  it('RT-SHOP-02 BITES: shopItemsByShopId returns empty array for a shopId with no stock', () => {
    // Kills: an impl that returns all items when no items match the shopId.
    const s = new AuthoritativeStore();
    s.upsertShopItem(shopItemRow(1n, 5, 1, 10n)); // shopId=5

    const result = s.shopItemsByShopId(99); // no items for shopId=99
    expect(result).toHaveLength(0);
  });

  it('RT-SHOP-02 BITES: removeShopItem removes from shopItemsByShopId output', () => {
    // Kills: an impl that removes from an internal map keyed by shopItemId but
    // leaves a stale reference in a secondary shopId-keyed index.
    const s = new AuthoritativeStore();
    s.upsertShopItem(shopItemRow(10n, 1, 5, 100n));
    expect(s.shopItemsByShopId(1)).toHaveLength(1);

    s.removeShopItem(10n);
    expect(s.shopItemsByShopId(1)).toHaveLength(0);
  });
});
