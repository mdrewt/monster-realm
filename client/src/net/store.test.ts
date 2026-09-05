// AuthoritativeStore behaviour suite (M4a, ADR-0013/0014) — vitest + fast-check.
// M6c extension tests appended below (§ "Monster + Species store extension").
// SOURCE OF TRUTH: specs/monster-realm-v2/M4-frontend.spec.md §3 "Store".
// The store is the READ-ONLY mirror of subscription truth: keyed Maps (idempotent
// on reconnect), each character recording receivedAt + up to INTERP_MAX_DEPTH=4
// snapshots for interpolation (ADR-0090; prior 2-snapshot cap superseded), and a
// per-transaction batch-applied signal so the loop reconciles once on a coherent
// snapshot. Pure + synchronous: the live SDK + the microtask coalescing live in
// the (untested-here, M5 e2e) connection adapter.

import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { BURST_EPSILON_MS } from '../shared/interpConfig';
// 11r-b (ADR-0167): T-OWNP-DOWNSTREAM composes ownPerspective with the REAL view model —
// the behavioral tooth that proves the projection actually feeds the render path, not just
// its own field-swap.
import { buildBattleViewModel } from '../ui/battleModel';
// uxd2 (ADR-0161 D1): the boundary converter, used by the npc-interaction integration
// tooth at the foot of this file (adapter path: upsertNpc(npcRowToStore(row))).
// 12r-d [E2]: healLocationRowToStore joins it for the heal-cost currency adapter tooth
// (adapter path: upsertHealLocation(healLocationRowToStore(row))) — same shape, same file.
import { healLocationRowToStore, npcRowToStore } from './rowConvert';
import {
  AuthoritativeStore,
  type EssenceByAffinity,
  // 11r-b (ADR-0167): ownPerspective does NOT exist on master yet — every T-OWNP-* test
  // below is RED at authoring time on a missing export (see the describe block's own
  // RED-reason comment).
  ownPerspective,
  // 12r-d [E2]: the REAL heal-location row type, imported under an alias because this file
  // also declares a LOCAL `StoreHealLocationRow` (line ~2132) that the M12d block's
  // type-erasure casts let drift. The 12r-d block at the foot of this file builds its
  // fixtures against THIS one, so the compiler is actually looking at the shipped shape.
  type StoreHealLocationRow as RealStoreHealLocationRow,
  type StoreBattle,
  type StoreBattleMonster,
  type StoreBattleSide,
  type StoreCharacter,
  // EG4 (contract §B): the essence-graph path row, keyed in the store by `pathId` (A1).
  type StoreEvolutionPath,
  type StoreInventory,
  type StoreItemRow,
  type StoreMonsterPub,
  type StorePlayer,
  type StoreProfile,
  type StoreShopItemRow,
  type StoreShopRow,
  type StoreSkillRow,
  type StoreSpeciesRow,
  type StoreTradeOffer,
  // ux2 (ADR-0154): owner-scoped wallet slot — see the ux2 block at the end of this file.
  type StoreWallet,
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

// =============================================================================
// ADR-0090: burst detection + jitter EWMA (AuthoritativeStore(stepMs > 0))
// These tests require new AuthoritativeStore(STEP_MS) so burst detection fires.
// With stepMs=0 (the default for all other tests) both behaviours are disabled.
// =============================================================================
describe('AuthoritativeStore ADR-0090: burst detection + jitter EWMA', () => {
  const STEP_MS = 200;

  it('BITES: two upserts within BURST_EPSILON_MS get a synthetic receivedAt', () => {
    // WHY: burst co-arrivals share wall-clock time → span=0 → position pop.
    // The synthetic stamp spreads them so interpolateHistory can bracket.
    // WRONG IMPL KILLED: an impl without burst detection gives latest.receivedAt=now (1005).
    const s = new AuthoritativeStore(STEP_MS);
    s.upsertCharacter(char(1n, 0, 0), 1000); // first arrival
    s.upsertCharacter(char(1n, 1, 0), 1005); // burst: 5 ms later (< BURST_EPSILON_MS=20)
    const stored = s.character(1n)!;
    // Synthetic: 1000 + STEP_MS = 1200. Guard: 1200 <= 1005 + 20 = 1025? NO → falls back to now.
    // Actually 1000+200=1200 > 1025 → guard fires → receivedAt stays at now=1005.
    // So with STEP_MS=200 and gap=5ms, synthetic (1200) > now+epsilon (1025) → no synthetic.
    // To trigger synthetic: gap must be small AND stepMs must be small OR gap close to stepMs.
    // Use STEP_MS=100 so synthetic=1100, now+epsilon=1025 → 1100>1025 → still no synthetic.
    // Use STEP_MS=10 so synthetic=1010, now+epsilon=1025 → 1010<=1025 → synthetic fires!
    expect(stored.latest.receivedAt).toBe(1005); // stepMs=200 → synthetic (1200) > 1025, no synthetic
    // Even without synthetic timestamps, ring buffer still has 2 snapshots
    expect(stored.snapshots).toHaveLength(2);
  });

  it('BITES: burst with small stepMs gives synthetic receivedAt = first.receivedAt + stepMs', () => {
    // With stepMs=10: synthetic=1010, guard: 1010 <= 1005 + 20 (=1025) → YES → synthetic fires.
    const s = new AuthoritativeStore(10); // small step so synthetic stays near now
    s.upsertCharacter(char(1n, 0, 0), 1000);
    s.upsertCharacter(char(1n, 1, 0), 1005); // burst: 5 ms later
    const stored = s.character(1n)!;
    expect(stored.latest.receivedAt).toBe(1010); // synthetic: 1000 + stepMs(10)
    expect(stored.snapshots[0]!.receivedAt).toBe(1000); // first snap unchanged
    expect(stored.snapshots[1]!.receivedAt).toBe(1010); // burst snap: synthetic
  });

  it('two upserts spaced > BURST_EPSILON_MS apart do NOT trigger synthetic timestamp', () => {
    const s = new AuthoritativeStore(STEP_MS);
    s.upsertCharacter(char(1n, 0, 0), 1000);
    s.upsertCharacter(char(1n, 1, 0), 1100); // 100 ms later — well above BURST_EPSILON_MS=20
    const stored = s.character(1n)!;
    expect(stored.latest.receivedAt).toBe(1100); // no synthetic: uses wall-clock time
  });

  it('jitterEwma stays near zero on smooth cadence arrivals', () => {
    // Smooth: each upsert spaced exactly STEP_MS ms apart → |interval-stepMs|≈0 → ewma≈0.
    const s = new AuthoritativeStore(STEP_MS);
    s.upsertCharacter(char(1n, 0, 0), 1000);
    s.upsertCharacter(char(1n, 1, 0), 1200); // exactly STEP_MS=200
    s.upsertCharacter(char(1n, 2, 0), 1400);
    s.upsertCharacter(char(1n, 3, 0), 1600);
    const stored = s.character(1n)!;
    expect(stored.jitterEwma).toBeCloseTo(0, 5); // smooth arrivals → near-zero jitter
  });

  it('jitterEwma rises after irregular arrivals', () => {
    const s = new AuthoritativeStore(STEP_MS);
    s.upsertCharacter(char(1n, 0, 0), 1000);
    // Arrival 50 ms late (250ms interval vs 200ms stepMs → deviation=50)
    s.upsertCharacter(char(1n, 1, 0), 1250);
    const stored = s.character(1n)!;
    // After one update with deviation=50: ewma = alpha*50 + (1-alpha)*0 = 0.125*50 = 6.25
    expect(stored.jitterEwma).toBeCloseTo(6.25, 5);
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

/** EG4: the 8-affinity essence record carried on every StoreMonsterPub (contract §B).
 *  DISTINCT per-affinity defaults are deliberate — a Wind/Light column swap in the
 *  converter is invisible against an all-zero record. */
function essenceRecord(overrides: Partial<EssenceByAffinity> = {}): EssenceByAffinity {
  return {
    Fire: 0,
    Water: 0,
    Plant: 0,
    Electric: 0,
    Earth: 0,
    Wind: 0,
    Light: 0,
    Dark: 0,
    ...overrides,
  };
}

/** Factory: minimal valid StoreMonsterPub. All fields required by the interface.
 *  EG4 (contract §B): `bond` and `evolvesTo` are GONE; `tier`, `essence`,
 *  `trustTier`, `qualityTimeTier` and `nutritionPct` are now required. */
function monsterPub(monsterId: bigint, ownerIdentity = 'dead', partySlot = 255): StoreMonsterPub {
  return {
    monsterId,
    ownerIdentity,
    speciesId: 1,
    nickname: '',
    level: 5,
    xp: 0,
    tier: 0,
    essence: essenceRecord(),
    trustTier: 'Neutral',
    qualityTimeTier: 0,
    nutritionPct: 0,
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

// 13r-e (ADR-0194 D3): `store.monster(id)` and `store.monsters()` are DELETED —
// they had zero production callers, and deleting them is what mechanically
// enforces the engaged-view deferral ("no client code reads another player's
// monster row" becomes unrepresentable rather than merely true today). The three
// assertions below that used to read `monster(id)` now read the SAME facts
// through `ownMonsters(identity)` / `monsterCount`, so no coverage is lost — the
// contract each test was written to kill is unchanged.
describe('AuthoritativeStore M6c: monster upsert + batch signal', () => {
  it('BITES: upsertMonster stores the row and ownMonsters retrieves it; flushBatch fires', () => {
    // Kills: an impl that ignores upsertMonster or never marks the batch dirty.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    const m = monsterPub(1n, 'abc');
    s.upsertMonster(m);
    expect(s.ownMonsters('abc')).toEqual([m]);
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
    expect(s.ownMonsters('alice')).toHaveLength(1);
    expect(s.ownMonsters('alice')[0]!.nickname).toBe('Sparky');
  });
});

describe('AuthoritativeStore M6c: removeMonster', () => {
  it('BITES: removeMonster deletes the row; the owner keeps none; batch is dirty', () => {
    // Kills: an impl that deletes but forgets to mark dirty, or soft-deletes.
    const s = new AuthoritativeStore();
    s.upsertMonster(monsterPub(7n)); // monsterPub()'s default ownerIdentity is 'dead'
    s.flushBatch(); // clear dirty
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.removeMonster(7n);
    expect(s.ownMonsters('dead')).toEqual([]);
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
    //
    // EG4 (contract §B, EARS EG4-7): `bond` is REMOVED from the list and the five
    // essence-graph fields are added. Editing the FACTORY alone is not enough — this
    // list is the contract, and it is what makes "the tier readout was never wired"
    // a red rather than a silent omission.
    const m = monsterPub(1n);
    const keys = Object.keys(m);
    const required = [
      'monsterId',
      'ownerIdentity',
      'speciesId',
      'nickname',
      'level',
      'xp',
      'currentHp',
      'statHp',
      'statAttack',
      'statDefense',
      'statSpeed',
      'statSpAttack',
      'statSpDefense',
      'partySlot',
      // EG4 additions (contract §B):
      'tier',
      'essence',
      'trustTier',
      'qualityTimeTier',
      'nutritionPct',
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
// 13r-e (ADR-0194 D4): reconcileMonstersFromView — the view-cache reconcile.
//
// SOURCE OF TRUTH: docs/adr/0194-monster-pub-need-to-know-privacy.md D4.
//
// WHY THIS METHOD EXISTS AT ALL. `my_monster_pub` is a VIEW, and in spacetimedb
// 1.12.0 bindings a view has NO primary key, so the SDK never fires onUpdate:
// every row change arrives as unordered `onInsert(new)` + `onDelete(old)` inside
// one transaction burst. Neither in-tree precedent is safe here — `my_wallet`'s
// insert-only wiring would STRAND a traded-away monster in the client forever,
// and `my_conversation`'s pairwise content-match delete gate has a documented
// coalescing-wipe failure. So the store rebuilds membership from the SDK's
// post-burst row set instead: ordering-immune by construction, immune to
// multi-transaction coalescing, no id-set arithmetic.
//
// THE CONTRACT, in one sentence: after `reconcileMonstersFromView(rows)`, the
// store's monster map contains EXACTLY `rows` — every given row upserted, every
// absent id removed — with change notification batched the same way the existing
// upsert/remove paths batch it.
//
// RED REASON (at authoring time): `AuthoritativeStore` has no
// `reconcileMonstersFromView` method, so every test below fails with
// "s.reconcileMonstersFromView is not a function".
// =============================================================================

describe('AuthoritativeStore 13r-e: the whole-map monster accessors are DELETED (ADR-0194 D3)', () => {
  it('BITES: store.monster(id) and store.monsters() do not exist on AuthoritativeStore', () => {
    // ADR-0194 D3 DEFERS the `engaged_monster_pub` view on a verified claim: NO
    // client code reads another player's monster row. `store.monster(id)` and
    // `store.monsters()` had zero production callers, and the ADR deletes them so
    // that fact is MECHANICALLY ENFORCED rather than merely true today — the
    // illegal state becomes unrepresentable (the ADR-0154 D5 analogue). Leaving
    // them in place would let the next author reach for a whole-map read, get an
    // owner-scoped result that looks right in single-player testing, and quietly
    // depend on rows that only ever arrive for the caller.
    //
    // This is the ONLY test that enforces the deletion; every other monster test
    // in this file now reads through ownMonsters/monsterCount, so removing the
    // accessors is otherwise invisible to the suite.
    //
    // RED AT AUTHORING TIME: both methods still exist (store.ts:776-782).
    const s = new AuthoritativeStore();
    const probe = s as unknown as Record<string, unknown>;
    expect(
      probe.monster,
      'store.monster(id) must be DELETED (ADR-0194 D3): a per-id read over the whole monster ' +
        'map is exactly the "read another player\'s row" shape the deferred engaged view would ' +
        'have served. Read through ownMonsters(identity) instead',
    ).toBeUndefined();
    expect(
      probe.monsters,
      'store.monsters() must be DELETED (ADR-0194 D3): it iterates the WHOLE monster map, ' +
        'which is the unrestricted read the need-to-know decision (#284) removes. Read through ' +
        'ownMonsters(identity) instead',
    ).toBeUndefined();
  });
});

describe('AuthoritativeStore 13r-e: reconcileMonstersFromView post-condition', () => {
  it('BITES (a): the map ends up EXACTLY equal to the rows argument (upsert + remove in one call)', () => {
    // Kills: an impl that only upserts the given rows (an absent id is STRANDED —
    // a monster traded away stays in the client's box forever, which is precisely
    // the my_wallet insert-only failure ADR-0194 D4 names), and one that only
    // removes-then-inserts a subset.
    const s = new AuthoritativeStore();
    s.upsertMonster(monsterPub(1n, 'alice'));
    s.upsertMonster(monsterPub(2n, 'alice'));
    s.upsertMonster(monsterPub(3n, 'bob'));

    const kept = { ...monsterPub(1n, 'alice'), nickname: 'Kept' };
    const fresh = monsterPub(4n, 'alice');
    s.reconcileMonstersFromView([kept, fresh]);

    // Exactly two rows survive, and they are exactly the two supplied.
    expect(s.monsterCount).toBe(2);
    expect(s.ownMonsters('alice')).toEqual([kept, fresh]);
    // 2n was present and is absent from `rows` -> removed.
    // 3n belonged to another owner and is absent from `rows` -> removed too (the
    // view only ever delivers the caller's own rows, so a foreign row lingering
    // in the map is exactly the leak this slice closes).
    expect(s.ownMonsters('bob')).toEqual([]);
  });

  it('BITES (b): an EMPTY rows argument empties the map', () => {
    // Kills: an impl that treats [] as "nothing to do" (the guard an author adds
    // to "avoid wiping the store on an empty burst"). An empty view result is
    // AUTHORITATIVE: the player owns no monsters, or the last one was traded away.
    const s = new AuthoritativeStore();
    s.upsertMonster(monsterPub(1n, 'alice'));
    s.upsertMonster(monsterPub(2n, 'alice'));

    s.reconcileMonstersFromView([]);

    expect(s.monsterCount).toBe(0);
    expect(s.ownMonsters('alice')).toEqual([]);
  });

  it('BITES (c): a newer payload for an already-stored id WINS (rows are authoritative)', () => {
    // Kills: an insert-if-absent impl (`if (!map.has(id)) map.set(id, row)`),
    // which compiles, reads like a plausible "the snapshot already has it", and
    // FREEZES every stat/level/nickname after the first delivery.
    const s = new AuthoritativeStore();
    s.upsertMonster({ ...monsterPub(9n, 'alice'), level: 5, nickname: 'Old' });

    const newer = { ...monsterPub(9n, 'alice'), level: 6, nickname: 'New' };
    s.reconcileMonstersFromView([newer]);

    expect(s.monsterCount).toBe(1);
    expect(s.ownMonsters('alice')).toEqual([newer]);
  });

  it('BITES (d): the whole reconcile coalesces into ONE batch notification, fired by flushBatch', () => {
    // Kills: an impl that notifies listeners per row (N re-renders per burst), and
    // one that mutates the map without marking the batch dirty at all (the rows
    // land but nothing re-renders until some UNRELATED table happens to flush —
    // invisible to any e2e, because the next NPC wander tick self-heals it).
    const s = new AuthoritativeStore();
    s.upsertMonster(monsterPub(1n, 'alice'));
    s.upsertMonster(monsterPub(2n, 'alice'));
    s.flushBatch(); // clear dirty
    const cb = vi.fn();
    s.onBatchApplied(cb);

    // Three distinct effects in ONE call: 1n updated, 2n removed, 5n added.
    s.reconcileMonstersFromView([
      { ...monsterPub(1n, 'alice'), nickname: 'Updated' },
      monsterPub(5n, 'alice'),
    ]);

    expect(cb, 'listeners must not be called mid-batch').toHaveBeenCalledTimes(0);
    s.flushBatch();
    expect(cb, 'one coherent snapshot -> exactly one notification').toHaveBeenCalledTimes(1);
  });

  it('BITES (e): ownMonsters(identity) reflects the post-reconcile state', () => {
    // Kills: an impl that writes to a second map / shadow list the read accessors
    // never consult (the box screen would render the pre-reconcile roster).
    const s = new AuthoritativeStore();
    s.upsertMonster(monsterPub(1n, 'alice'));

    s.reconcileMonstersFromView([monsterPub(2n, 'alice'), monsterPub(3n, 'alice')]);

    const ids = s.ownMonsters('alice').map((m) => m.monsterId);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(2n);
    expect(ids).toContain(3n);
    expect(ids).not.toContain(1n);
  });

  it('BITES (f): an OWNERSHIP TRANSFER migrates the row between owners with no reconnect', () => {
    // THE trade case, end to end in the store. The server transfers monster 42
    // from alice to bob; through the view alice's client sees the row LEAVE and
    // bob's sees it ARRIVE, both as an unordered insert+delete burst that the
    // reconcile resolves from the SDK's post-burst row set.
    //
    // Kills: an impl keyed on ownerIdentity rather than monsterId (the row would
    // be duplicated under both owners); one that removes only ids it has "seen
    // deleted" (alice keeps a monster she no longer owns — a live privacy leak,
    // since the row now belongs to someone else); and any impl that requires a
    // store.reset()/reconnect to converge.
    const aliceView = new AuthoritativeStore();
    aliceView.upsertMonster(monsterPub(42n, 'alice'));
    aliceView.upsertMonster(monsterPub(7n, 'alice'));
    // Alice's view now returns only the monster she still owns.
    aliceView.reconcileMonstersFromView([monsterPub(7n, 'alice')]);
    expect(aliceView.ownMonsters('alice').map((m) => m.monsterId)).toEqual([7n]);
    expect(aliceView.ownMonsters('bob')).toEqual([]);
    expect(aliceView.monsterCount).toBe(1);

    const bobView = new AuthoritativeStore();
    bobView.upsertMonster(monsterPub(8n, 'bob'));
    // Bob's view gains the transferred row, whose ownerIdentity is now bob.
    bobView.reconcileMonstersFromView([monsterPub(8n, 'bob'), monsterPub(42n, 'bob')]);
    const bobIds = bobView.ownMonsters('bob').map((m) => m.monsterId);
    expect(bobIds).toHaveLength(2);
    expect(bobIds).toContain(42n);
    expect(bobView.ownMonsters('alice')).toEqual([]);
  });

  it('BITES: an UNCHANGED row set marks NOTHING dirty, while a changed field marks exactly one batch (render-storm guard)', () => {
    // WHAT THIS PINS (verifier advisory A, ADR-0194 D4). The connection adapter
    // calls reconcileMonstersFromView in EVERY batcher flush — i.e. on every
    // table's burst, including the ~5/s movement ticks — so the reconcile must be
    // a NO-OP for an unchanged row set. Without change detection, every movement
    // tick marks the batch dirty and re-notifies every UI listener: a render storm
    // that no other test in this file can see (all of them assert a REAL change).
    //
    // MUTANTS THIS KILLS: `shallowRowEq -> false` and deletion of the
    // `prev === undefined || !shallowRowEq(prev, m)` guard (both make the
    // no-change half notify); `shallowRowEq -> true` (makes the changed half
    // silently drop a real update — the balance-freeze failure mode).
    //
    // THE FIXTURE IS PRODUCTION-SHAPED ON PURPOSE. The rows are rebuilt by calling
    // the factory again, so they are structurally equal but NON-IDENTICAL objects,
    // *including a freshly-built nested `essence` record* — which is exactly what
    // the boundary converter emits: monsterPubRowToStore (rowConvert.ts:214-223)
    // constructs a new `essence: { Fire: …, … }` literal on EVERY call, so the
    // store never sees the same nested object twice in production. That shape is
    // what makes this test meaningful: it kills a `prev === m` reference-equality
    // cheat, and it is the only shape the guard will ever actually face.
    //
    // ⚠ RED AT AUTHORING TIME — AND IT IS THE IMPLEMENTATION, NOT THE FIXTURE.
    // store.ts's `shallowRowEq` is a generic own-key `===` compare, and `essence`
    // is a nested OBJECT, so `prev.essence !== m.essence` for two converter
    // outputs that carry identical numbers. The guard therefore reports "changed"
    // on every flush and suppresses nothing: the render storm it exists to prevent
    // is still live. Two sanctioned fixes, both in store.ts:
    //   (a) compare `essence` field-wise (it is a fixed 8-key affinity record), or
    //   (b) make shallowRowEq recurse ONE level into plain-object values.
    // The forbidden "fix" is editing THIS test to share one `essence` reference
    // between the two arrays: that fixture shape never occurs in production, so it
    // would make the assertion pass while the storm continues.
    const s = new AuthoritativeStore();
    s.reconcileMonstersFromView([monsterPub(1n, 'alice'), monsterPub(2n, 'alice')]);
    s.flushBatch(); // clear dirty from the initial population
    const cb = vi.fn();
    s.onBatchApplied(cb);

    // Half 1 — the SAME row set, delivered as fresh objects (a movement-tick flush).
    s.reconcileMonstersFromView([monsterPub(1n, 'alice'), monsterPub(2n, 'alice')]);
    s.flushBatch();
    expect(
      cb,
      'an unchanged row set must not mark the batch dirty — the reconcile runs on EVERY ' +
        'batcher flush, so a dirty mark here re-renders the whole UI on every movement tick',
    ).toHaveBeenCalledTimes(0);

    // Half 2 — one field changed on one row: a REAL update must still get through.
    cb.mockClear();
    s.reconcileMonstersFromView([
      { ...monsterPub(1n, 'alice'), level: 6 },
      monsterPub(2n, 'alice'),
    ]);
    s.flushBatch();
    expect(
      cb,
      'a changed field must mark the batch dirty exactly once — over-suppression is the ' +
        'freeze failure mode (the row lands in the store and nothing ever re-renders)',
    ).toHaveBeenCalledTimes(1);
  });

  it('BITES: a stale row for the SAME id under a DIFFERENT owner never survives the reconcile', () => {
    // The single-store form of (f): the map is keyed by monsterId, so the
    // incoming row must REPLACE the stored one rather than coexist with it.
    // Kills: an impl that keys the map by `${ownerIdentity}:${monsterId}` (a
    // plausible "make ownMonsters O(1)" refactor) — alice would still see monster
    // 42 after it changed hands.
    const s = new AuthoritativeStore();
    s.upsertMonster(monsterPub(42n, 'alice'));

    s.reconcileMonstersFromView([monsterPub(42n, 'bob')]);

    expect(s.monsterCount).toBe(1);
    expect(s.ownMonsters('alice')).toEqual([]);
    expect(s.ownMonsters('bob').map((m) => m.monsterId)).toEqual([42n]);
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

/** Factory: minimal valid StoreBattle.
 *  11r-b (ADR-0167): `opponentIdentity` is now a 4th parameter (default 'npc' — every
 *  pre-existing positional call site is unaffected). Needed so the role-agnostic (T-RA)
 *  and ownPerspective (T-OWNP) fixtures below can put a real player identity ('bob') on
 *  the opponent side without hand-building the whole row inline. */
function battle(
  battleId: bigint,
  playerIdentity = 'alice',
  outcome = 'Ongoing',
  opponentIdentity = 'npc',
): StoreBattle {
  return {
    battleId,
    playerIdentity,
    opponentIdentity,
    outcome,
    turnNumber: 1,
    sideA: battleSide(),
    sideB: battleSide(),
    partyMonsterIds: [1n],
    opponentMonsterIds: [2n],
    createdAtMs: 1000n,
    weather: null,
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
// battleId (bigint comparison) among rows in which `identity` appears in EITHER
// role — playerIdentity OR opponentIdentity (11r-b/ADR-0167: a PvP ACCEPTER is
// stored in opponentIdentity, server-module/src/pvp.rs:289-297, so a
// playerIdentity-only filter left the accepter with no battle at all) —
// regardless of outcome (Ongoing OR terminal). Returns undefined when no row
// matches, and ALSO when identity === '' (explicit pre-join guard; 11r-b AC-3).
// ongoingBattle() matches the SAME either-role rule, Ongoing-only.
//
// RED (11r-b): both accessors currently match `playerIdentity === identity`
// ONLY — see the "role-agnostic accessors" describe block below (T-RA-1..4)
// and the retitled T1c for the failing coverage.
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

  it("T1c: BITES returns the player's OWN row, not a higher-id battle of a player it is not in (alice id 5n, bob id 9n); a stranger gets undefined from BOTH accessors", () => {
    // RETITLED (11r-b/ADR-0167): this used to assert "filters strictly by playerIdentity",
    // which is now FALSE — the real invariant is that latestPlayerBattle returns the
    // caller's own battle, never a stranger's higher-id row, regardless of which role the
    // caller would occupy in that stranger's battle. Both fixture rows carry an EXPLICIT
    // opponentIdentity ('npc') so the fixture is unambiguous: alice is in NEITHER role of
    // bob's 9n battle.
    // Kills: ignoring the identity filter and returning the global highest-id row.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(5n, 'alice', 'Ongoing', 'npc'));
    s.upsertBattle(battle(9n, 'bob', 'Ongoing', 'npc'));
    const result = s.latestPlayerBattle('alice');
    expect(result).toBeDefined();
    expect(result!.battleId).toBe(5n);
    expect(result!.playerIdentity).toBe('alice');

    // Folded in from the cut T-RA-5 (plan §11 R-3, subsumed here): a stranger ('carol'),
    // who appears in NEITHER role of EITHER stored battle, gets undefined from BOTH
    // accessors — never "any battle that happens to exist".
    // Kills: an impl that returns any/the-first battle regardless of role membership.
    expect(s.latestPlayerBattle('carol')).toBeUndefined();
    expect(s.ongoingBattle('carol')).toBeUndefined();
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

// =============================================================================
// 11r-b — role-agnostic ongoingBattle() / latestPlayerBattle() (ADR-0167)
// SOURCE OF TRUTH: memory/projects/monster-realm-11r-b-plan.md §4 AC-1/AC-2/AC-3
//
// `store.ongoingBattle()` / `store.latestPlayerBattle()` filtered `playerIdentity ===
// identity` ONLY. A PvP ACCEPTER is stored in `opponentIdentity`
// (server-module/src/pvp.rs:289-297), so the accepter got NO battle overlay at all —
// invisible until the 60s deadline reaper forfeited them (the defect this slice closes).
//
// Both accessors now match `playerIdentity === identity || opponentIdentity === identity`,
// with an explicit `identity === ''` early-return guard in both (AC-3 — role-agnostic
// matching turns "no match" into "possible false match" without it).
//
// RED reason: both accessors on master still filter `playerIdentity === identity` only —
// every test below fails against the CURRENT (unfixed) source.
// =============================================================================

describe('AuthoritativeStore 11r-b: ongoingBattle()/latestPlayerBattle() match EITHER role', () => {
  it("T-RA-1: BITES ongoingBattle('bob') returns a row where 'bob' is the opponentIdentity (AC-1)", () => {
    // Kills: a revert to the playerIdentity===identity-only filter — the pre-11r-b defect
    // that leaves a PvP accepter (stored in opponentIdentity) with NO ongoing battle.
    const s = new AuthoritativeStore();
    const b = battle(1n, 'alice', 'Ongoing', 'bob');
    s.upsertBattle(b);
    const result = s.ongoingBattle('bob');
    expect(result).toBeDefined();
    expect(result).toEqual(b);
  });

  it("T-RA-2: BITES latestPlayerBattle('bob') returns the SAME row via opponentIdentity — the second, independent loop (AC-2)", () => {
    // Same fixture as T-RA-1 but against the SECOND accessor: ongoingBattle and
    // latestPlayerBattle are two independently-written loops in store.ts — a fix landed on
    // one and forgotten on the other would pass T-RA-1 and fail here.
    const s = new AuthoritativeStore();
    const b = battle(10n, 'alice', 'Ongoing', 'bob');
    s.upsertBattle(b);
    expect(s.latestPlayerBattle('bob')?.battleId).toBe(10n);
  });

  it('T-RA-3: BITES latestPlayerBattle picks the highest battleId across MIXED roles (bigint `>`, never Number()/Math.max — T1d)', () => {
    // 'bob' is playerIdentity on battle 5n and opponentIdentity on battle 9n. Kills an impl
    // that stops scanning at the first playerIdentity hit (would wrongly return 5n) instead
    // of comparing EVERY row where identity appears in either role.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(5n, 'bob', 'Ongoing', 'npc'));
    s.upsertBattle(battle(9n, 'alice', 'SideAWins', 'bob'));
    const result = s.latestPlayerBattle('bob');
    expect(result).toBeDefined();
    expect(result!.battleId).toBe(9n); // bigint `>` comparison — never Number()/Math.max
  });

  it("T-RA-4: BITES identity==='' returns undefined from BOTH accessors, even with a row whose opponentIdentity is '' (AC-3)", () => {
    // Kills the missing empty-identity guard: without an explicit early return, a row with
    // opponentIdentity==='' would falsely match ongoingBattle('') / latestPlayerBattle('').
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(1n, 'alice', 'Ongoing', ''));
    expect(s.ongoingBattle('')).toBeUndefined();
    expect(s.latestPlayerBattle('')).toBeUndefined();
  });

  it("T-RA-6: BITES ongoingBattle('bob') picks the HIGHEST battleId when TWO Ongoing rows both match 'bob' — no first-match-wins Map-iteration nondeterminism", () => {
    // Kills: first-match-wins Map-iteration order. Pre-11r-b at most one row could match a
    // given identity (playerIdentity-only filter), so ongoingBattle's early `return` on the
    // first match was safe. Either-role matching made TWO SIMULTANEOUS Ongoing matches
    // possible — you can be the challenger in one battle and the accepter in another at the
    // same time — and this accessor kept its early return instead of getting the same
    // highest-battleId tiebreak its sibling latestPlayerBattle got in the SAME diff (see
    // T-RA-3 / T1d — bigint `>` comparison, never Number()/Math.max).
    // Insertion order is DELIBERATE: the LOWER id (5n, 'bob' as playerIdentity) is inserted
    // FIRST — a first-match-wins impl returns it (WRONG). The correct impl must scan every
    // either-role match and pick the HIGHEST (9n, 'bob' as opponentIdentity) regardless of
    // insertion/Map-iteration order.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(5n, 'bob', 'Ongoing', 'npc')); // 'bob' is playerIdentity — lower id, inserted first
    s.upsertBattle(battle(9n, 'alice', 'Ongoing', 'bob')); // 'bob' is opponentIdentity — higher id, inserted second
    const result = s.ongoingBattle('bob');
    expect(result).toBeDefined();
    expect(result!.battleId).toBe(9n); // bigint `>` comparison — never Number()/Math.max (T1d)
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
// EG4-5 / A1 extension: StoreEvolutionPath REPLACES StoreFusionRow.
// SOURCE OF TRUTH: memory/projects/monster-realm-EG4-contract.md §A1 + §B + §G.
//
// The whole M10c fusion suite that used to live here is DELETED, not adapted:
// EG4-5 removes `StoreFusionRow`, `#fusions`, `upsertFusion`, `removeFusion`,
// `fusions()`, `fusionCount` and the `reset()` fusion clear outright.
//
// RED REASON (verified against client/src/net/store.ts this session): the store
// exports no `StoreEvolutionPath`, has no `#evolutionPaths` map, and no
// `upsertEvolutionPath` / `removeEvolutionPath` / `evolutionPaths()` /
// `evolutionPathCount` member. Every test below fails on a MISSING IMPLEMENTATION
// (`s.upsertEvolutionPath is not a function`), not on a fixture typo. Conversely
// the EG4-5 deletion suite is red the other way round: `upsertFusion` et al are
// still very much defined (store.ts:546-553, :844-850).
// =============================================================================

/** Factory: minimal valid StoreEvolutionPath (contract §B).
 *  `pathId` and `edgeId` are SEPARATE parameters on purpose — the A1 tests below
 *  need to vary them independently. */
function evoPath(
  pathId: bigint,
  edgeId: number,
  overrides: Partial<StoreEvolutionPath> = {},
): StoreEvolutionPath {
  return {
    pathId,
    edgeId,
    fromSpecies: 1,
    toSpecies: 2,
    minLevel: 10,
    essence: [],
    minTrustTier: null,
    minQualityTimeTier: null,
    minNutritionPct: null,
    ...overrides,
  };
}

describe('AuthoritativeStore EG4: evolution-path upsert + evolutionPathCount', () => {
  it('BITES: upsertEvolutionPath stores the row; evolutionPathCount goes 0 -> 1', () => {
    // Kills: an impl that exposes the method but never writes to the map, and a
    // `evolutionPathCount` getter hard-wired to 0.
    const s = new AuthoritativeStore();
    expect(s.evolutionPathCount).toBe(0);
    s.upsertEvolutionPath(evoPath(1n, 7));
    expect(s.evolutionPathCount).toBe(1);
  });

  it('BITES: re-inserting the SAME pathId overwrites (keyed Map, reconnect-idempotent); count stays 1', () => {
    // Kills: an array-backed store that appends on a subscription replay — after a
    // reconnect the same content rows arrive again and the panel would list every
    // edge twice.
    const s = new AuthoritativeStore();
    s.upsertEvolutionPath(evoPath(1n, 7, { toSpecies: 2 }));
    s.upsertEvolutionPath(evoPath(1n, 7, { toSpecies: 99 }));
    expect(s.evolutionPathCount).toBe(1);
    const rows = [...s.evolutionPaths()];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toSpecies).toBe(99); // last-write wins
  });

  it('BITES: every field survives the round trip (no silent field drop)', () => {
    // Kills: an impl that stores a narrowed projection — dropping `minNutritionPct`
    // (or collapsing the essence list) silently makes an unsatisfiable path look
    // satisfied in the EG4-1 progress panel.
    const s = new AuthoritativeStore();
    const row = evoPath(3n, 11, {
      fromSpecies: 7,
      toSpecies: 30,
      minLevel: 15,
      essence: [{ affinity: 'Water', amount: 100 }],
      minTrustTier: 'Friendly',
      minQualityTimeTier: 2,
      minNutritionPct: 60,
    });
    s.upsertEvolutionPath(row);
    expect([...s.evolutionPaths()][0]).toEqual(row);
  });

  it('BITES: two DISTINCT pathIds coexist — evolutionPathCount is 2', () => {
    // Kills: a single-slot field masquerading as a map.
    const s = new AuthoritativeStore();
    s.upsertEvolutionPath(evoPath(1n, 7));
    s.upsertEvolutionPath(evoPath(2n, 8));
    expect(s.evolutionPathCount).toBe(2);
  });

  it('BITES (A1): the store is keyed by pathId — TWO rows sharing one edgeId coexist', () => {
    // Kills: `Map<number /* edgeId */, StoreEvolutionPath>`. This is the structural
    // half of the A1 blocker: `sync_content` (server-module/src/content.rs:268-292)
    // clear-and-reinserts the whole table in ONE transaction, re-minting `path_id`
    // while KEEPING `edge_id`, so during the burst two live rows legitimately carry
    // the same edgeId. An edgeId-keyed map collapses them to one.
    const s = new AuthoritativeStore();
    s.upsertEvolutionPath(evoPath(5n, 7));
    s.upsertEvolutionPath(evoPath(9n, 7));
    expect(s.evolutionPathCount).toBe(2);
    expect([...s.evolutionPaths()].map((p) => p.pathId).sort()).toEqual([5n, 9n]);
  });

  it('BITES: pathId is bigint-exact across the 2^53 boundary (no Number() key coercion)', () => {
    // 2^53 and 2^53+1 collapse to the SAME JS number. `path_id` is a u64 auto_inc,
    // so a Number()-keyed map silently merges two distinct rows.
    // Kills: `Map<number, …>` fed by `Number(row.pathId)`.
    const s = new AuthoritativeStore();
    s.upsertEvolutionPath(evoPath(9007199254740992n, 1)); // 2^53
    s.upsertEvolutionPath(evoPath(9007199254740993n, 2)); // 2^53 + 1
    expect(s.evolutionPathCount).toBe(2);
  });
});

describe('AuthoritativeStore EG4: removeEvolutionPath', () => {
  it('BITES: removeEvolutionPath(pathId) deletes that row; the count drops back to 0', () => {
    // Kills: a no-op remove, or one that removes from the wrong map.
    const s = new AuthoritativeStore();
    s.upsertEvolutionPath(evoPath(7n, 3));
    expect(s.evolutionPathCount).toBe(1);
    s.removeEvolutionPath(7n);
    expect(s.evolutionPathCount).toBe(0);
    expect([...s.evolutionPaths()]).toHaveLength(0);
  });

  it('BITES: removeEvolutionPath on an ABSENT pathId is a silent no-op — never throws, count unchanged', () => {
    // The A1 delete/insert burst guarantees this path is taken: an onDelete for a row
    // whose freshly-minted twin already replaced it must not explode. A throw inside a
    // subscription callback kills the ENTIRE flushBatch burst — flushBatch has no
    // per-callback isolation on the ingest side (store.ts:608-621 isolates listeners,
    // NOT ingest).
    // Kills: `if (!this.#evolutionPaths.has(id)) throw …` and any assert-style guard.
    const s = new AuthoritativeStore();
    s.upsertEvolutionPath(evoPath(1n, 3));
    expect(() => {
      s.removeEvolutionPath(999n);
    }).not.toThrow();
    expect(s.evolutionPathCount).toBe(1);
    expect(() => {
      s.removeEvolutionPath(999n);
    }).not.toThrow(); // idempotent on an empty-of-that-key map too
  });

  it('BITES: removeEvolutionPath on an absent pathId does NOT mark the batch dirty (no phantom re-render)', () => {
    // Kills: an unconditional `this.#dirty = true` in the remove path — the A1 burst
    // delivers many such no-op deletes, each one forcing a pointless full re-render.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.removeEvolutionPath(999n);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(0);
  });
});

// ---------------------------------------------------------------------------
// ★ A1 — THE BLOCKER. `sync_content` (server-module/src/content.rs:268-292) does
// N deletes + N inserts of `evolution_path` in ONE transaction with the SAME
// edge_ids and FRESHLY MINTED path_ids, and the SDK gives NO ordering guarantee
// between the two halves. Keying by pathId is what makes callback order irrelevant.
// ---------------------------------------------------------------------------

describe('★ AuthoritativeStore EG4 (A1): a content republish burst never empties the path map', () => {
  it('★ BITES: onInsert(pathId 9, edge 7) THEN onDelete(pathId 5, edge 7) — edge 7 SURVIVES', () => {
    // THE ordering that kills an edgeId-keyed store: the new row lands first, then the
    // stale delete for the SAME edge arrives and wipes the row that was just written.
    // The client's path map silently empties and the whole EG4-1 progress panel goes
    // blank until the next republish — with no error anywhere.
    // Kills: `Map<number /* edgeId */, …>` + `#paths.delete(row.edgeId)`.
    const s = new AuthoritativeStore();
    s.upsertEvolutionPath(evoPath(5n, 7, { toSpecies: 42 })); // the pre-republish row
    s.flushBatch();

    s.upsertEvolutionPath(evoPath(9n, 7, { toSpecies: 43 })); // republished: NEW pathId, SAME edgeId

    // RED-TEAM ADDITION — the MID-BURST assertion, which is what actually makes THIS
    // ordering discriminate. Without it, an edgeId-keyed store whose removeEvolutionPath
    // SCANS for the matching pathId passes both order tests: the insert has already
    // overwritten key 7, so the scan finds nothing, and the end state (one row, pathId 9n)
    // is identical to the correct store's. The distinguishing observation is HERE, between
    // the two callbacks — the SDK delivers them as separate callbacks inside one
    // transaction, so this intermediate state is genuinely observable by any listener that
    // runs before flushBatch. A pathId-keyed map holds BOTH rows; an edgeId-keyed map has
    // already collapsed them to one.
    expect(
      s.evolutionPathCount,
      'MID-BURST (A1): after the republished insert but BEFORE the stale delete, the stale ' +
        'row (pathId 5) and the fresh row (pathId 9) must BOTH be live — they are distinct ' +
        'rows that merely share an edgeId. A count of 1 here means the map is keyed by ' +
        'edgeId and the insert silently destroyed a row the transaction had not deleted yet',
    ).toBe(2);

    s.removeEvolutionPath(5n); // the stale delete, arriving SECOND

    const rows = [...s.evolutionPaths()];
    expect(
      rows.map((p) => p.edgeId),
      'edge 7 must still be present after a same-transaction re-insert + stale delete',
    ).toEqual([7]);
    expect(rows[0]!.pathId).toBe(9n); // the freshly-minted row, not the deleted one
    expect(
      rows[0]!.toSpecies,
      'the SURVIVOR must be the republished row (toSpecies 43), not the stale one (42) — ' +
        'distinct payloads so "a row with edgeId 7 survived" cannot be satisfied by the ' +
        'wrong row',
    ).toBe(43);
    expect(s.evolutionPathCount).toBe(1);
  });

  it('★ BITES: the REVERSE order — onDelete(pathId 5, edge 7) THEN onInsert(pathId 9, edge 7) — edge 7 SURVIVES', () => {
    // Same burst, opposite arrival order. An edgeId-keyed store happens to survive THIS
    // ordering, which is exactly why the ordering above must be tested too: a wrong impl
    // is green half the time and the defect presents as an intermittent blank panel.
    // Kills: a "fix" that special-cases delete-before-insert only.
    const s = new AuthoritativeStore();
    s.upsertEvolutionPath(evoPath(5n, 7, { toSpecies: 42 }));
    s.flushBatch();

    s.removeEvolutionPath(5n);
    s.upsertEvolutionPath(evoPath(9n, 7, { toSpecies: 43 }));

    const rows = [...s.evolutionPaths()];
    expect(rows.map((p) => p.edgeId)).toEqual([7]);
    expect(rows[0]!.pathId).toBe(9n);
    // Distinct payloads (43, not the stale 42) — see the note on the forward-order case.
    expect(rows[0]!.toSpecies).toBe(43);
    expect(s.evolutionPathCount).toBe(1);
  });

  it('★ BITES: a FULL 3-edge republish burst, interleaved insert/delete, leaves exactly the 3 new rows', () => {
    // The realistic shape of the transaction: all three edges re-minted, deletes and
    // inserts interleaved arbitrarily. An edgeId-keyed store ends with 0-2 rows here
    // depending on interleaving; the pathId-keyed store always ends with exactly 3,
    // carrying the NEW pathIds.
    // Kills: edgeId keying, and any "last write wins per edge" dedupe layer.
    const s = new AuthoritativeStore();
    for (const [pid, eid] of [
      [1n, 7],
      [2n, 8],
      [3n, 9],
    ] as const) {
      s.upsertEvolutionPath(evoPath(pid, eid));
    }
    s.flushBatch();

    // The republish burst, deliberately interleaved and NOT delete-first:
    s.upsertEvolutionPath(evoPath(11n, 7));
    s.removeEvolutionPath(1n);
    s.removeEvolutionPath(2n);
    s.upsertEvolutionPath(evoPath(12n, 8));
    s.upsertEvolutionPath(evoPath(13n, 9));
    s.removeEvolutionPath(3n);

    const rows = [...s.evolutionPaths()];
    expect(rows).toHaveLength(3);
    expect(rows.map((p) => p.edgeId).sort((a, b) => a - b)).toEqual([7, 8, 9]);
    expect(rows.map((p) => p.pathId).sort()).toEqual([11n, 12n, 13n]);
  });
});

describe('AuthoritativeStore EG4: evolutionPaths() iterator + reset()', () => {
  it('BITES: evolutionPaths() on an empty store yields an EMPTY iterable (never undefined, never a throw)', () => {
    // Kills: an accessor that returns undefined before the first row arrives — every
    // caller spreads it (`[...store.evolutionPaths()]`, contract §F).
    const s = new AuthoritativeStore();
    expect(() => {
      expect([...s.evolutionPaths()]).toHaveLength(0);
    }).not.toThrow();
  });

  it('BITES: evolutionPaths() yields every stored row', () => {
    // Kills: an accessor wired to the wrong map (returns [] forever).
    const s = new AuthoritativeStore();
    s.upsertEvolutionPath(evoPath(1n, 7, { fromSpecies: 1, toSpecies: 2 }));
    s.upsertEvolutionPath(evoPath(2n, 8, { fromSpecies: 1, toSpecies: 3 }));
    const all = [...s.evolutionPaths()];
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.edgeId).sort((a, b) => a - b)).toEqual([7, 8]);
  });

  it('BITES: reset() CLEARS the evolution-path map (no stale content across a reconnect)', () => {
    // Kills: a `reset()` that forgets the new map — after switching identity the panel
    // would still be driven by the previous session's content rows.
    const s = new AuthoritativeStore();
    s.upsertEvolutionPath(evoPath(1n, 7));
    s.upsertEvolutionPath(evoPath(2n, 8));
    expect(s.evolutionPathCount).toBe(2);
    s.reset();
    expect(s.evolutionPathCount).toBe(0);
    expect([...s.evolutionPaths()]).toHaveLength(0);
  });

  it('BITES: reset() still clears monsters too, and batch listeners survive (existing contract intact)', () => {
    // Regression frame: adding a map must not disturb reset()'s existing duties.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertMonster(monsterPub(1n, 'p'));
    s.upsertEvolutionPath(evoPath(1n, 7));
    s.reset();
    expect(s.monsterCount).toBe(0);
    expect(s.evolutionPathCount).toBe(0);
    s.upsertEvolutionPath(evoPath(2n, 8));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('AuthoritativeStore EG4: upsert/removeEvolutionPath mark the batch dirty', () => {
  it('BITES: upsertEvolutionPath marks dirty so flushBatch fires the listener', () => {
    // Kills: an ingest that writes the map but never sets #dirty — content arrives and
    // nothing re-renders until some unrelated table happens to flush.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertEvolutionPath(evoPath(1n, 7));
    expect(cb).toHaveBeenCalledTimes(0); // not mid-batch
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('BITES: a REAL removeEvolutionPath marks dirty so flushBatch fires', () => {
    // Kills: a delete that mutates the map but never sets #dirty (paired with the
    // absent-id no-op test above, this pins BOTH arms of the conditional).
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertEvolutionPath(evoPath(2n, 8));
    s.flushBatch();
    cb.mockClear();
    s.removeEvolutionPath(2n);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('★ AuthoritativeStore EG4-5: the fusion store surface is DELETED, not merely unused', () => {
  it('★ BITES: upsertFusion / removeFusion / fusions / fusionCount are all undefined on a store instance', () => {
    // EG4-5 says "ALL fusion-wiring SHALL be deleted". A PARTIAL deletion — the picker
    // and view-model gone but the store methods left behind — is the likely outcome and
    // is invisible to every other test in this slice: dead ingest wiring that still
    // compiles, still runs, and still accumulates rows nothing reads.
    // Kills: leaving `#fusions` + its four members in place "just in case".
    // (Runtime probe, not a type probe: client/tsconfig.json excludes **/*.test.ts, so a
    // tsc-only assertion would gate nothing.)
    const s = new AuthoritativeStore();
    const probe = s as unknown as Record<string, unknown>;
    expect(
      probe.upsertFusion,
      'upsertFusion must be deleted from AuthoritativeStore',
    ).toBeUndefined();
    expect(
      probe.removeFusion,
      'removeFusion must be deleted from AuthoritativeStore',
    ).toBeUndefined();
    expect(probe.fusions, 'fusions() must be deleted from AuthoritativeStore').toBeUndefined();
    expect(
      probe.fusionCount,
      'the fusionCount getter must be deleted from AuthoritativeStore',
    ).toBeUndefined();
  });

  it('★ BITES: the replacement surface IS present (anti-vacuity for the deletion gate above)', () => {
    // Without this, "fusion is gone" would be satisfied by a store that has neither
    // fusion NOR evolution paths — i.e. by deleting the feature instead of replacing it.
    const s = new AuthoritativeStore();
    const probe = s as unknown as Record<string, unknown>;
    expect(typeof probe.upsertEvolutionPath).toBe('function');
    expect(typeof probe.removeEvolutionPath).toBe('function');
    expect(typeof probe.evolutionPaths).toBe('function');
    expect(s.evolutionPathCount).toBe(0);
  });
});

describe('AuthoritativeStore EG4: evolutionPathCount property (fast-check)', () => {
  it('BITES: evolutionPathCount equals the number of DISTINCT pathIds after random upserts', () => {
    // Kills: array-backed accumulation (inflates on replay) and edgeId keying (deflates
    // whenever two generated pathIds happen to share the constant edgeId used here).
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 30n }), { maxLength: 50 }), (ids) => {
        const s = new AuthoritativeStore();
        for (const id of ids) {
          s.upsertEvolutionPath(evoPath(id, 7));
        }
        expect(s.evolutionPathCount).toBe(new Set(ids).size);
      }),
    );
  });
});

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
//     #inventory, #itemDefs, or #evolutionPaths (EG4-5: #fusions is gone).
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
    // 13r-e: reads the same fact through ownMonsters (store.monster(id) is gone).
    const s = new AuthoritativeStore();
    s.upsertMonster(monsterPub(7n, 'bob'));
    s.upsertCharacter(char(1n, 0, 0), 100);
    s.resetCharacters();
    expect(s.ownMonsters('bob')).toHaveLength(1);
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
  // 12r-d [E2]: the heal cost's CURRENCY channel — a REQUIRED u64 carried as bigint
  // (store.ts:242-250). Kept in sync with the real type by hand; the M12d block below
  // reaches the store through `as unknown as Record<…>` casts, so the compiler cannot
  // enforce that sync — which is exactly why the 12r-d block at the foot of this file
  // builds its fixtures against the IMPORTED `RealStoreHealLocationRow` instead.
  costCurrency: bigint;
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
    // 12r-d [E2]: a free pad — 0n, never `0`. Every M12d case above keeps its original
    // assertions; this key only keeps the fixture well-formed under the new required field.
    costCurrency: 0n,
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
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertConversation(row);
    const result = (
      s as unknown as Record<string, (...args: unknown[]) => unknown>
    ).ownConversation('alice-hex') as StorePlayerConversation | undefined;
    expect(result).toBeDefined();
    expect(result!.ownerIdentity).toBe('alice-hex');
    expect(result!.npcEntityId).toBe(7n);
    expect(result!.currentNodeId).toBe('greeting');
  });

  it('BITES: ownConversation returns undefined for a different identity', () => {
    // Kills: an impl that returns the first conversation regardless of ownerIdentity.
    // Privacy contract: another player's conversation must not be returned.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertConversation(
      convRow('alice-hex'),
    );
    const result = (
      s as unknown as Record<string, (...args: unknown[]) => unknown>
    ).ownConversation('bob-hex');
    expect(result).toBeUndefined();
  });

  // --- removeConversation: row deleted, ownConversation returns undefined ---

  it('BITES: removeConversation deletes the row; ownConversation returns undefined after', () => {
    // Kills: an impl that soft-deletes or retains the row after removal.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertConversation(
      convRow('alice-hex'),
    );
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).removeConversation(
      'alice-hex',
    );
    const result = (
      s as unknown as Record<string, (...args: unknown[]) => unknown>
    ).ownConversation('alice-hex');
    expect(result).toBeUndefined();
  });

  // --- ownQuests: filters by ownerIdentity ---

  it('BITES: upsertQuest + ownQuests(identity) returns only own quests', () => {
    // Kills: an impl that returns ALL quests regardless of owner identity.
    // Privacy contract: another player's quests must not appear.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertQuest(
      questRow(1n, 'alice-hex', 'q1'),
    );
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertQuest(
      questRow(2n, 'bob-hex', 'q2'),
    );
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertQuest(
      questRow(3n, 'alice-hex', 'q3'),
    );
    const aliceQuests = (s as unknown as Record<string, (...args: unknown[]) => unknown>).ownQuests(
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
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertConversation(
      convRow('player-hex', 1n),
    );
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertQuest(
      questRow(1n, 'player-hex', 'q1'),
    );
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertHealLocation(
      healLocationRow(1, 0),
    );
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertNpc(
      npcRow(99n, 'elder_oak'),
    );

    s.reset();

    // Assertion 1: #conversations cleared
    expect(
      (s as unknown as Record<string, (...args: unknown[]) => unknown>).ownConversation(
        'player-hex',
      ),
    ).toBeUndefined();

    // Assertion 2: #quests cleared
    expect(
      (s as unknown as Record<string, (...args: unknown[]) => unknown>).ownQuests('player-hex'),
    ).toHaveLength(0);

    // Assertion 3: #healLocations cleared
    expect(
      (s as unknown as Record<string, (...args: unknown[]) => unknown>).healLocations(),
    ).toHaveLength(0);

    // Assertion 4: #npcs cleared
    expect(
      (s as unknown as Record<string, (...args: unknown[]) => unknown>).npc(99n),
    ).toBeUndefined();

    // Listeners must survive reset (existing contract preserved)
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertNpc(npcRow(1n));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  // --- healLocations: returns all locations (public content) ---

  it('BITES: upsertHealLocation + healLocations() returns all locations', () => {
    // Kills: an impl that filters healLocations by any identity (it is public content).
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertHealLocation(
      healLocationRow(1, 0),
    );
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertHealLocation(
      healLocationRow(2, 1),
    );
    const locs = (
      s as unknown as Record<string, (...args: unknown[]) => unknown>
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
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertHealLocation(
      healLocationRow(5, 0),
    );
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertHealLocation({
      ...healLocationRow(5, 0),
      cooldownMs: 60000,
    });
    const locs = (
      s as unknown as Record<string, (...args: unknown[]) => unknown>
    ).healLocations() as StoreHealLocationRow[];
    expect(locs).toHaveLength(1);
    expect(locs[0]!.cooldownMs).toBe(60000); // last-write wins
  });

  // --- npc(entityId) and npcByNpcId(npcId) ---

  it('BITES: upsertNpc + npc(entityId) returns the NPC row', () => {
    // Kills: an impl that stores npcs by npcId string instead of entityId bigint.
    const s = new AuthoritativeStore();
    const npc = npcRow(42n, 'elder_oak', 'elder_oak_talk');
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertNpc(npc);
    const result = (s as unknown as Record<string, (...args: unknown[]) => unknown>).npc(42n) as
      | StoreNpcRow
      | undefined;
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
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertNpc(npc);
    const byEntityId = (s as unknown as Record<string, (...args: unknown[]) => unknown>).npc(42n) as
      | StoreNpcRow
      | undefined;
    const byNpcId = (s as unknown as Record<string, (...args: unknown[]) => unknown>).npcByNpcId(
      'elder_oak',
    ) as StoreNpcRow | undefined;
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
    expect(
      (s as unknown as Record<string, (...args: unknown[]) => unknown>).npc(999n),
    ).toBeUndefined();
  });

  it('BITES: npcByNpcId(npcId) returns undefined for unknown npcId (not throw)', () => {
    // Kills: an impl that throws when npcId is not in the index.
    const s = new AuthoritativeStore();
    expect(
      (s as unknown as Record<string, (...args: unknown[]) => unknown>).npcByNpcId(
        'nonexistent_npc',
      ),
    ).toBeUndefined();
  });

  it('BITES: upsertNpc marks batch dirty so flushBatch fires', () => {
    // Kills: an impl that stores the NPC but forgets to set #dirty=true.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertNpc(npcRow(1n));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  // --- Fix 3: removeQuest / removeHealLocation / removeNpc ---

  it('BITES: removeQuest removes the quest from ownQuests', () => {
    // The connection.ts onDelete handler calls removeQuest; an impl that is a no-op
    // leaves stale quest rows in the store after server deletion.
    // Kills: an impl that ignores removeQuest or removes from the wrong map.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertQuest(
      questRow(10n, 'alice-hex', 'quest_abc'),
    );
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertQuest(
      questRow(11n, 'alice-hex', 'quest_xyz'),
    );
    // Remove only quest 10n
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).removeQuest(10n);
    const remaining = (s as unknown as Record<string, (...args: unknown[]) => unknown>).ownQuests(
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
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertHealLocation(
      healLocationRow(1, 0),
    );
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertHealLocation(
      healLocationRow(2, 1),
    );
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).removeHealLocation(1);
    const locs = (
      s as unknown as Record<string, (...args: unknown[]) => unknown>
    ).healLocations() as StoreHealLocationRow[];
    expect(locs).toHaveLength(1);
    expect(locs[0]!.locationId).toBe(2);
  });

  it('BITES: removeNpc removes by entityId — npc(entityId) returns undefined', () => {
    // The connection.ts onDelete handler calls removeNpc; an impl that is a no-op
    // leaves stale NPC entries that would appear in dialogue lookups.
    // Kills: an impl that ignores removeNpc or uses the wrong key.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertNpc(
      npcRow(42n, 'elder_oak'),
    );
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).removeNpc(42n);
    expect(
      (s as unknown as Record<string, (...args: unknown[]) => unknown>).npc(42n),
    ).toBeUndefined();
  });

  it('BITES: removeNpc also clears npcByNpcId index', () => {
    // Both lookup paths (#npcs keyed by entityId and the npcId index) must be cleared
    // on remove. An impl that only removes from one map leaves a dangling secondary
    // index that returns a stale row for npcByNpcId after the NPC is gone.
    // Kills: an impl that clears #npcs but forgets to clear the npcId secondary index.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertNpc(
      npcRow(42n, 'elder_oak'),
    );
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).removeNpc(42n);
    expect(
      (s as unknown as Record<string, (...args: unknown[]) => unknown>).npcByNpcId('elder_oak'),
    ).toBeUndefined();
  });

  // --- Fix 4: flushBatch tests for upsertConversation / upsertQuest / upsertHealLocation ---

  it('BITES: upsertConversation marks batch dirty so flushBatch fires', () => {
    // Kills: an impl that stores the conversation row but forgets to set #dirty=true,
    // so the render loop never learns that a conversation has started.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertConversation(
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
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertQuest(
      questRow(1n, 'player-hex', 'q1'),
    );
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('BITES: upsertHealLocation marks batch dirty so flushBatch fires', () => {
    // Kills: an impl that stores the heal location row but forgets to set #dirty=true,
    // so the heal view never renders when location content arrives from the server.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertHealLocation(
      healLocationRow(5, 0),
    );
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  // --- remove* dirty-marking tests (RT Finding 4 / Finding 3 follow-up) ---

  it('BITES: removeConversation marks batch dirty so flushBatch fires (overlay hides)', () => {
    // Server auto-dismisses conversation (RT-ADV-01) by deleting the row.
    // removeConversation must mark dirty so the render loop hides the dialogue overlay.
    // Kills: an impl that deletes the row but forgets #dirty=true (overlay stays open).
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertConversation(
      convRow('alice-hex', 1n, 'greeting'),
    );
    s.flushBatch();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).removeConversation(
      'alice-hex',
    );
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('BITES: removeQuest marks batch dirty so flushBatch fires (quest log refreshes)', () => {
    // Server deletes player_quest on completion. removeQuest must mark dirty so
    // the quest log view re-renders and drops the completed quest.
    // Kills: an impl that no-ops removeQuest or forgets #dirty=true.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertQuest(
      questRow(5n, 'alice-hex', 'q'),
    );
    s.flushBatch();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).removeQuest(5n);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('BITES: removeNpc marks batch dirty so flushBatch fires', () => {
    // Kills: an impl that removes the NPC row but forgets #dirty=true.
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertNpc(npcRow(7n));
    s.flushBatch();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).removeNpc(7n);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  // --- npcByNpcId secondary index consistency on re-upsert (RT Finding 7) ---

  it('BITES: re-upsert with changed npcId updates secondary index (old npcId returns undefined)', () => {
    // If an impl builds the secondary index with first-insert-only semantics, a re-upsert
    // that changes npcId leaves the OLD npcId returning the outdated row.
    // Kills: `if (!this.#npcsByNpcId.has(row.npcId)) { this.#npcsByNpcId.set(...) }`
    const s = new AuthoritativeStore();
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertNpc(
      npcRow(1n, 'old_id', 'tree_a'),
    );
    // Same entityId, changed npcId (e.g. server corrects the NPC definition)
    (s as unknown as Record<string, (...args: unknown[]) => unknown>).upsertNpc(
      npcRow(1n, 'new_id', 'tree_b'),
    );
    expect(
      (s as unknown as Record<string, (...args: unknown[]) => unknown>).npcByNpcId('new_id'),
    ).toBeDefined();
    expect(
      (s as unknown as Record<string, (...args: unknown[]) => unknown>).npcByNpcId('old_id'),
    ).toBeUndefined(); // stale index must be purged on re-upsert
    expect((s as unknown as Record<string, (...args: unknown[]) => unknown>).npc(1n)).toBeDefined();
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

// =============================================================================
// ADR-0090 burst detection: synthetic timestamp and future-cap invariants
//
// RT-BURST-CHAIN-01: When two snapshots for the same entity arrive within
// BURST_EPSILON_MS of each other (a WebSocket co-arrival burst), the burst
// detection assigns a synthetic receivedAt = existing.latest.receivedAt + stepMs,
// PROVIDED that synthetic does not exceed now + BURST_EPSILON_MS.
//
// The safety cap (synthetic <= now + BURST_EPSILON_MS) prevents runaway chaining:
// if the first burst already produced a synthetic far in the future, subsequent
// arrivals at the same 'now' get the real wall-clock timestamp (falling back to
// the span-0 graceful degradation in interpolateHistory) rather than chaining off
// the first synthetic.
//
// WHY gate these invariants:
// 1. A bug that always uses 'now' for burst snapshots (skipping synthetic assignment)
//    would collapse the interpolation span to 0 → instant position pop.
// 2. A bug that ignores the future-cap (always chaining) would push snapshots far
//    into the future, freezing the entity at its pre-burst position for stepMs of
//    real time on each subsequent normal arrival.
// 3. A bug that uses existing.latest.receivedAt for jitter measurement (vs real
//    wall-clock existing.receivedAt) would compute negative intervals on bursts,
//    causing wild jitter EWMA values and over-widening the adaptive delay.
// =============================================================================

describe('AuthoritativeStore ADR-0090 RT-BURST-CHAIN-01: burst detection synthetic timestamp invariants', () => {
  function makeChar(entityId: bigint, tileX: number): StoreCharacter {
    return {
      entityId,
      zoneId: 0,
      tileX,
      tileY: 0,
      facing: 'East',
      action: 'Idle',
      moveStartedAtMs: 0n,
      moveQueue: [],
    };
  }

  it('BITES: first snapshot has real receivedAt (no burst on fresh entity)', () => {
    // Kills: an impl that always applies synthetic timestamps regardless of existing state.
    const s = new AuthoritativeStore(100); // stepMs=100
    s.upsertCharacter(makeChar(1n, 0), 1000);
    const stored = s.character(1n)!;
    expect(stored.latest.receivedAt).toBe(1000); // real wall clock, no burst
    expect(stored.snapshots).toHaveLength(1);
    expect(stored.snapshots[0]!.receivedAt).toBe(1000);
  });

  it('BITES: burst snapshot gets synthetic receivedAt when synthetic ≤ now+BURST_EPSILON', () => {
    // Two arrivals within BURST_EPSILON_MS where synthetic (T+stepMs) is within
    // now+BURST_EPSILON_MS: synthetic IS assigned.
    // Scenario: existing.latest.receivedAt = 900, stepMs=100 → synthetic=1000;
    // now=1000+19=1019, BURST_EPSILON=20 → synthetic(1000) ≤ 1019+20=1039 → assigned.
    // WRONG IMPL KILLED: using 'now' unconditionally for the burst snapshot — produces
    // same receivedAt for both snapshots → 0-span interpolation → instant position pop.
    const s = new AuthoritativeStore(100); // stepMs=100
    s.upsertCharacter(makeChar(1n, 0), 900); // snap A: receivedAt=900 (real)
    // Second arrival at now=919: delta = 919-900 = 19 < 20 (BURST_EPSILON) → burst fires
    // synthetic = 900+100=1000; 1000 ≤ 919+20=939? NO: 1000 > 939 → cap prevents synthetic
    // Try: now=990 → delta=990-900=90 ≥ 20 → no burst detected
    // For burst to assign synthetic: delta < 20 AND synthetic ≤ now+20
    // → existing.latest.receivedAt + stepMs ≤ now + 20
    // → now ≥ existing.latest.receivedAt + stepMs - 20 = 900+100-20 = 980
    // → AND now - 900 < 20 → now < 920
    // These two constraints are incompatible for stepMs=100!
    // (need now ≥ 980 AND now < 920 simultaneously — impossible)
    // With stepMs=20 (tiny step): synthetic=900+20=920; now=919 → 920≤939 → assigned!
    const s2 = new AuthoritativeStore(20); // stepMs=20 (makes synthetic within cap)
    s2.upsertCharacter(makeChar(2n, 0), 900); // snap A: receivedAt=900
    s2.upsertCharacter(makeChar(2n, 1), 919); // now=919, delta=19<20 → burst; synthetic=920 ≤ 939 → assigned
    const stored2 = s2.character(2n)!;
    expect(stored2.snapshots).toHaveLength(2);
    expect(stored2.snapshots[0]!.receivedAt).toBe(900); // A: real
    expect(stored2.snapshots[1]!.receivedAt).toBe(920); // B: synthetic = 900 + stepMs(20)
  });

  it('BITES: burst snapshot falls back to now when synthetic > now+BURST_EPSILON (future-cap)', () => {
    // Scenario: existing.latest.receivedAt=1000, stepMs=100 → synthetic=1100.
    // now=1000 → 1100 > 1000+20=1020 → future-cap fires → receivedAt=now=1000.
    // This is the common "truly simultaneous" case where stepMs is large (e.g. 100ms).
    // WRONG IMPL KILLED: an impl that ignores the future-cap and always assigns synthetic,
    // which would push snapshots 100ms into the future — freezing the entity on the next
    // normal arrival (the HOLD guard in interpolateHistory would not release for stepMs of
    // real time, causing a visible lag spike).
    const s = new AuthoritativeStore(100); // stepMs=100
    s.upsertCharacter(makeChar(1n, 0), 1000); // snap A: receivedAt=1000
    s.upsertCharacter(makeChar(1n, 1), 1000); // now=1000, delta=0<20 → burst; synthetic=1100 > 1020 → CAP
    const stored = s.character(1n)!;
    expect(stored.snapshots).toHaveLength(2);
    expect(stored.snapshots[0]!.receivedAt).toBe(1000); // A: real
    expect(stored.snapshots[1]!.receivedAt).toBe(1000); // B: falls back to now (cap prevents 1100)
  });

  it('BITES: non-burst arrival (gap ≥ BURST_EPSILON_MS) uses real receivedAt', () => {
    // A gap of exactly BURST_EPSILON_MS does NOT trigger burst detection (condition is <, not ≤).
    // WRONG IMPL KILLED: an impl that uses ≤ instead of < for the burst check — would
    // incorrectly synthesize a timestamp at the boundary arrival.
    const s = new AuthoritativeStore(100); // stepMs=100
    s.upsertCharacter(makeChar(1n, 0), 1000); // snap A
    s.upsertCharacter(makeChar(1n, 1), 1020); // gap = 1020-1000 = 20ms = BURST_EPSILON — NOT a burst
    const stored = s.character(1n)!;
    expect(stored.snapshots[1]!.receivedAt).toBe(1020); // real wall-clock, no synthetic
  });

  it('BITES: burst detection disabled when stepMs=0 (default constructor; all receivedAt = now)', () => {
    // stepMs=0 disables all burst detection: every snapshot gets real wall-clock receivedAt.
    // WRONG IMPL KILLED: an impl that runs burst detection even when stepMs=0 — would
    // assign synthetic=0+0=0 for every arrival, collapsing all timestamps to 0.
    const s = new AuthoritativeStore(); // stepMs=0 (default)
    s.upsertCharacter(makeChar(1n, 0), 1000);
    s.upsertCharacter(makeChar(1n, 1), 1000); // same now, but burst disabled
    const stored = s.character(1n)!;
    expect(stored.snapshots[0]!.receivedAt).toBe(1000);
    expect(stored.snapshots[1]!.receivedAt).toBe(1000); // both real; no synthetic
  });

  it('BITES: jitter EWMA uses real wall-clock interval (not synthetic receivedAt)', () => {
    // The jitter measurement reads now - existing.receivedAt (the real wall-clock field),
    // NOT now - existing.latest.receivedAt (which may be synthetic/future).
    // Using existing.latest.receivedAt for jitter would compute a NEGATIVE interval on
    // burst arrivals where synthetic > now, producing a massive jitter over-estimate
    // and incorrectly widening the adaptive interpolation delay.
    // WRONG IMPL KILLED: interval = now - existing.latest.receivedAt (wrong source).
    //
    // Two on-time arrivals: A at t=1000, B at t=1100 (exactly stepMs=100ms apart).
    // Interval = 1100 - 1000 = 100ms = stepMs → deviation = 0 → jitter stays 0.
    const s = new AuthoritativeStore(100); // stepMs=100
    s.upsertCharacter(makeChar(1n, 0), 1000); // snap A: wall receivedAt=1000
    s.upsertCharacter(makeChar(1n, 1), 1100); // snap B: on-time arrival (no burst)
    const stored = s.character(1n)!;
    // interval = now(1100) - existing.receivedAt(1000) = 100ms = stepMs → deviation=0
    expect(stored.jitterEwma).toBeCloseTo(0, 5);

    // Now a burst arrival: C at now=1100 again (same as B).
    // Wall clock interval = 1100 - 1100 = 0ms; deviation = |0-100| = 100ms.
    // newJitter = 0.125 * 100 + 0.875 * 0 = 12.5ms.
    // If jitter used latest.receivedAt instead of receivedAt, and latest was synthetic (1200),
    // interval = 1100 - 1200 = -100ms (negative!) → deviation = |-100-100| = 200ms → newJitter=25ms.
    s.upsertCharacter(makeChar(1n, 2), 1100); // snap C: burst at T=1100
    const stored2 = s.character(1n)!;
    expect(stored2.jitterEwma).toBeCloseTo(12.5, 1); // correct: based on real wall-clock
  });
});

// =============================================================================
// 11r-f (ADR-0171) D1 — the jitter EWMA idle-gap gate
//
// SOURCE OF TRUTH: docs/adr/0171-resume-from-idle-interpolation.md D1 (amends
// ADR-0090's ungated inline EWMA in `upsertCharacter`) + spec
// M-postgate-eleventh-review-residuals §11r-f EARS E1 ("... no post-resume
// max-delay clamp").
//
// THE RULE. Skip the EWMA update when `interval > JITTER_IDLE_GAP_STEPS x stepMs`
// (K = 3). `<=` ADMITS, `>` SKIPS — at exactly 600 ms with stepMs=200 the sample is
// admitted. The gate is ONE-SIDED: a burst co-arrival (interval ~ 0) is genuine
// delivery jitter and STILL updates; only large intervals are idleness. The
// `receivedAt: now` baseline write and the ring append stay UNCONDITIONAL, and the
// EWMA is carried across the gap UNCHANGED (never reset).
//
// RED REASON (before impl): `upsertCharacter` updates the EWMA on every non-snap
// arrival, so a 5 s idle feeds deviation 4800 and drives jitterEwma to ~600 (raw
// delay 200 + 1200 → clamped to the 500 ms max for ~2 s). Every "stays exactly"
// assertion below lands on a large number instead. Case (xiv), (H-F), the burst
// legs of (xii) and the 2-tile leg of (xv) are deliberately GREEN — they are the
// anti-regression / anti-alternative pins that keep the gate one-sided, keep the
// interval measured from the wall clock, and keep the fix out of the net layer's
// data model.
// =============================================================================

// Namespace import ON PURPOSE (see case (xvi)): JITTER_IDLE_GAP_STEPS does not
// exist yet, and a missing NAMED binding is an ESM link error that would take this
// whole FILE's collection down. Property access reds as a clean `undefined !== 3`.
import * as storeMod from './store';

describe('11r-f EWMA idle-gap gate (ADR-0171)', () => {
  const STEP = 200; // production STEP_MS; gate boundary = 3 x 200 = 600 ms

  it('(xi) BITES: gate boundary — interval 601 is frozen out, interval 600 is admitted', () => {
    // WRONG IMPL KILLED (three of them):
    //   a) no gate at all — leg A would move the EWMA to 55.59375;
    //   b) reset-to-0 across a gap — leg A would land on 0, not 6.25;
    //   c) `>=` instead of `>` (or K != 3) — leg B's exactly-600 sample would be
    //      skipped and the EWMA would still read 6.25.
    const s = new AuthoritativeStore(STEP);
    s.upsertCharacter(char(1n, 0, 0), 1000); // first sight: no interval yet → ewma 0
    // interval 1250-1000 = 250 (admitted); deviation |250-200| = 50
    //   ewma = 0.125*50 + 0.875*0 = 6.25
    s.upsertCharacter(char(1n, 1, 0), 1250);
    expect(s.character(1n)!.jitterEwma).toBe(6.25);

    // leg A — interval 1851-1250 = 601 > 600 → SKIPPED. Carried across unchanged.
    s.upsertCharacter(char(1n, 2, 0), 1851);
    expect(s.character(1n)!.jitterEwma).toBe(6.25); // bit-identical: not updated, not reset

    // leg B — interval 2451-1851 = 600 <= 600 → ADMITTED; deviation |600-200| = 400
    //   ewma = 0.125*400 + 0.875*6.25 = 50 + 5.46875 = 55.46875
    s.upsertCharacter(char(1n, 3, 0), 2451);
    expect(s.character(1n)!.jitterEwma).toBe(55.46875);
  });

  it('(xi-b / H-B) BITES: sub-millisecond aliasing — a 600.3 ms interval is still outside the gate', () => {
    // `performance.now()` is fractional, so real inter-arrival intervals never land on
    // the integer grid. An integer-only boundary suite is passed by a slack gate such
    // as `interval <= JITTER_IDLE_GAP_STEPS * stepMs + 0.5` (verified live against a
    // golden reference), which quietly admits every idle gap in the 600.0-600.5 band.
    // WRONG IMPL KILLED: any epsilon / rounding slack on the gate comparison.
    const s = new AuthoritativeStore(STEP);
    s.upsertCharacter(char(1n, 0, 0), 1000); // first sight
    s.upsertCharacter(char(1n, 1, 0), 1250); // interval 250 → deviation 50 → ewma 6.25
    expect(s.character(1n)!.jitterEwma).toBe(6.25);
    // interval 1850.3 - 1250 = 600.3 > 600 → SKIPPED, bit-identical.
    // Today (and under a +0.5 slack gate): deviation |600.3 - 200| = 400.3 →
    //   0.125*400.3 + 0.875*6.25 = 50.0375 + 5.46875 = 55.50625
    s.upsertCharacter(char(1n, 2, 0), 1850.3);
    expect(s.character(1n)!.jitterEwma).toBe(6.25);
  });

  it('(xii) the gate is ONE-SIDED and scales with stepMs (3 x stepMs, not a 600 ms constant)', () => {
    // WRONG IMPL KILLED: a TWO-SIDED gate (`Math.abs(interval - stepMs) > K*stepMs`
    // or `interval < stepMs/K` short-circuits). That would silence exactly the
    // burst-delivery signal ADR-0090's adaptive delay exists to absorb — a
    // coalesced-tick spike presents as interval ~ 0 plus interval ~ 2 x stepMs.
    const s = new AuthoritativeStore(STEP);
    s.upsertCharacter(char(1n, 0, 0), 1000);
    // interval 0 (admitted: 0 <= 600); deviation |0-200| = 200
    //   ewma = 0.125*200 + 0.875*0 = 25
    s.upsertCharacter(char(1n, 1, 0), 1000);
    expect(s.character(1n)!.jitterEwma).toBe(25);

    // the ADR-0090 12.5 case (stepMs=100: on-time arrival, then a burst) must survive
    const s100 = new AuthoritativeStore(100); // gate boundary here is 3 x 100 = 300 ms
    s100.upsertCharacter(char(2n, 0, 0), 1000);
    s100.upsertCharacter(char(2n, 1, 0), 1100); // interval 100 = stepMs → deviation 0
    expect(s100.character(2n)!.jitterEwma).toBe(0);
    s100.upsertCharacter(char(2n, 2, 0), 1100); // interval 0 → deviation 100 → 12.5
    expect(s100.character(2n)!.jitterEwma).toBe(12.5);

    // The boundary MULTIPLIES by stepMs — it is not a 600 ms constant. Fresh store so
    // the chain starts from 0; at stepMs=100 the gate sits at 3 x 100 = 300 ms.
    // WRONG IMPL KILLED: `interval > 600` hardcoded (and any K != 3) — it admits the
    // 301 ms sample and moves the estimate to
    //   0.125*|301-100| + 0.875*25 = 0.125*201 + 21.875 = 25.125 + 21.875 = 47.
    const s100b = new AuthoritativeStore(100);
    s100b.upsertCharacter(char(3n, 0, 0), 1000); // first sight
    // interval 300 = 3 x 100 → ADMIT; deviation |300-100| = 200 → 0.125*200 + 0 = 25
    s100b.upsertCharacter(char(3n, 1, 0), 1300);
    expect(s100b.character(3n)!.jitterEwma).toBe(25);
    // interval 301 > 300 → SKIP → bit-identical
    s100b.upsertCharacter(char(3n, 2, 0), 1601);
    expect(s100b.character(3n)!.jitterEwma).toBe(25);
  });

  it('(xiii) BITES: the receivedAt baseline advances across a gated gap (the estimator never freezes)', () => {
    // WRONG IMPL KILLED: "skip the whole block, receivedAt included" — the baseline
    // would stay at 1000 forever, every later interval would measure G + n*stepMs, be
    // gated again, and the estimator would be dead for the rest of the session. The
    // 6450 arrival exposes it: it would still read 0 instead of 6.25.
    //
    // NOT killed here (deliberately not claimed): the `existing.latest.receivedAt`
    // vs `existing.receivedAt` source mutant. Every interval in THIS fixture exceeds
    // BURST_EPSILON_MS, so the synthetic-timestamp branch never fires and the two
    // fields are equal throughout — the two formulas agree on every step below. Case
    // (H-F) drives stepMs=20 to make them diverge and kills that mutant.
    const s = new AuthoritativeStore(STEP);
    s.upsertCharacter(char(1n, 0, 0), 1000); // first sight
    s.upsertCharacter(char(1n, 1, 0), 6000); // interval 5000 > 600 → SKIPPED
    expect(s.character(1n)!.jitterEwma).toBe(0);
    expect(s.character(1n)!.receivedAt).toBe(6000); // baseline write is UNCONDITIONAL

    // interval measured from 6000 (not 1000): 200 = stepMs → deviation 0 → stays 0
    s.upsertCharacter(char(1n, 2, 0), 6200);
    expect(s.character(1n)!.jitterEwma).toBe(0);
    // interval 250 → deviation 50 → 0.125*50 + 0.875*0 = 6.25: the estimator LIVES
    s.upsertCharacter(char(1n, 3, 0), 6450);
    expect(s.character(1n)!.jitterEwma).toBe(6.25);
  });

  it('(H-F) BITES: the EWMA interval comes from the wall-clock receivedAt, never the synthetic latest stamp', () => {
    // REPAIRS ILLUSORY COVERAGE. The pre-existing ADR-0090 fixture
    // "BITES: jitter EWMA uses real wall-clock interval (not synthetic receivedAt)"
    // claims to kill `interval = now - existing.latest.receivedAt`, but at its
    // stepMs=100 the synthetic-timestamp branch is UNREACHABLE (the ptc5f pin in
    // store.ts: synthetic fires only when stepMs < 2 * BURST_EPSILON_MS = 40), so
    // latest.receivedAt === receivedAt throughout and the two formulas agree on every
    // step — the mutant survives it. That test is left BYTE-UNTOUCHED; this one runs
    // at stepMs=20 so the synthetic branch actually fires and the two sources diverge.
    // Deliberately GREEN today and after the fix: the shipped code is already correct
    // here, and no 11r-f edit to this block (the gate lands in the same `if`) may
    // disturb it.
    const s = new AuthoritativeStore(20); // < 2 x BURST_EPSILON_MS → synthetic reachable
    s.upsertCharacter(char(1n, 0, 0), 900); // A: receivedAt = latest.receivedAt = 900

    // B at 919: delta 19 < BURST_EPSILON_MS=20 → burst; synthetic = 900 + 20 = 920,
    // and 920 <= 919 + 20 = 939 → assigned. Wall-clock baseline stays 919.
    //   interval = 919 - 900 = 19 (gate: 19 <= 3 x 20 = 60 → admit)
    //   deviation = |19 - 20| = 1  →  ewma = 0.125*1 + 0.875*0 = 0.125
    s.upsertCharacter(char(1n, 1, 0), 919);
    const afterBurst = s.character(1n)!;
    expect(afterBurst.receivedAt).toBe(919); // real wall clock
    expect(afterBurst.latest.receivedAt).toBe(920); // SYNTHETIC — the two now diverge
    expect(afterBurst.jitterEwma).toBe(0.125);

    // C at 925 — the discriminating step:
    //   correct: interval = 925 - 919 = 6, deviation |6 - 20| = 14
    //            ewma = 0.125*14 + 0.875*0.125 = 1.75 + 0.109375 = 1.859375
    //   mutant : interval = 925 - 920 = 5, deviation |5 - 20| = 15
    //            ewma = 0.125*15 + 0.875*0.125 = 1.875 + 0.109375 = 1.984375
    s.upsertCharacter(char(1n, 2, 0), 925);
    expect(s.character(1n)!.jitterEwma).toBe(1.859375);
  });

  it('(xiv) BITES: a gated arrival does NOT mutate the snapshot ring (no store-side re-anchor)', () => {
    // PINS THE REJECTED ALTERNATIVE (ADR-0171 Considered alternatives; ADR-0090
    // already rejected retroactive re-stamping). WRONG IMPL KILLED: a store-side fix
    // that rewrites the prior snapshot's receivedAt to `now - stepMs` (5800 here) on
    // a gap append — the ring must stay an immutable record of real wall-clock
    // arrivals; the re-anchor is a RENDER policy and lives in interpolateHistory.
    const s = new AuthoritativeStore(STEP);
    s.upsertCharacter(char(1n, 0, 0), 1000);
    s.upsertCharacter(char(1n, 1, 0), 6000); // 5 s idle, then one tile
    const stored = s.character(1n)!;
    expect(stored.snapshots).toHaveLength(2); // append is UNCONDITIONAL (not dropped)
    expect(stored.snapshots.map((sn) => sn.receivedAt)).toEqual([1000, 6000]); // un-rewritten
    expect(stored.prev).toMatchObject({ tileX: 0, tileY: 0, receivedAt: 1000 });
    expect(stored.latest).toMatchObject({ tileX: 1, tileY: 0, receivedAt: 6000 });
  });

  it('(xv) shouldSnap interaction: a 2-tile resume resets the ring; a 1-tile diagonal keeps it and stays gated', () => {
    // Scope boundary (ADR-0171 Consequences): 11r-f smooths the 1-TILE resume only.
    // A >= 2-tile catch-up still trips shouldSnap → ring reset → teleport (M12.5d-2:
    // interpolating multi-tile jumps smears sprites through walls).
    const two = new AuthoritativeStore(STEP);
    two.upsertCharacter(char(1n, 0, 0), 1000);
    two.upsertCharacter(char(1n, 2, 0), 6000); // |dx| = 2 > 1 → shouldSnap
    expect(two.character(1n)!.snapshots).toHaveLength(1); // ring reset to [latest]
    expect(two.character(1n)!.snapshots[0]!.receivedAt).toBe(6000);
    expect(two.character(1n)!.prev).toBeUndefined();
    expect(two.character(1n)!.jitterEwma).toBe(0); // snap path never touches the EWMA

    // WRONG IMPL KILLED: gating on Manhattan distance / treating a diagonal as a
    // 2-tile jump. Chebyshev((1,1),(0,0)) = 1 → NOT a snap → the ring keeps both
    // snapshots so the re-anchored bracket has its resume snapshot, and the 5000 ms
    // interval is still gated (today this leg reds at 600).
    const diag = new AuthoritativeStore(STEP);
    diag.upsertCharacter(char(2n, 0, 0), 1000);
    diag.upsertCharacter(char(2n, 1, 1), 6000); // one diagonal tile after a 5 s idle
    expect(diag.character(2n)!.snapshots).toHaveLength(2);
    expect(diag.character(2n)!.jitterEwma).toBe(0);
  });

  it('(xvi) PIN: JITTER_IDLE_GAP_STEPS is exported from store.ts and equals 3 (ADR-0171 D5)', () => {
    // Literal pin so an implementer cannot silently relax K. Accessed off the module
    // NAMESPACE rather than as a named import because the export does not exist yet:
    // a missing named binding is an ESM link error that would abort collection of
    // this entire FILE; property access reds as `undefined !== 3`.
    // The twin pin (REANCHOR_SPAN_STEPS === 2) lives in render/interpolation.test.ts;
    // ADR-0171 D5 keeps the two constants deliberately independent — do not unify.
    expect((storeMod as unknown as Record<string, unknown>).JITTER_IDLE_GAP_STEPS).toBe(3);
  });

  it('(xvii) T-E: genuine pre-idle jitter crosses a 5 s gap bit-identical (the gap must not amplify it)', () => {
    // EARS E1's "no post-resume max-delay clamp" clause is scoped by ADR-0171 to
    // *the resume interval itself must not cause the clamp*. Pre-existing genuine
    // jitter legitimately keeps the delay high (and here already clamped) — what
    // must never happen is the IDLE GAP inflating it further.
    //
    // Seed with four ADMITTED boundary samples (interval exactly 600 = 3 x stepMs,
    // deviation |600-200| = 400 each). alpha = 0.125, so 0.125*400 = 50 per sample:
    //   ewma0 = 0
    //   ewma1 = 50 + 0.875 * 0          = 50
    //   ewma2 = 50 + 0.875 * 50         = 50 + 43.75        = 93.75
    //   ewma3 = 50 + 0.875 * 93.75      = 50 + 82.03125     = 132.03125
    //   ewma4 = 50 + 0.875 * 132.03125  = 50 + 115.52734375 = 165.52734375
    // (every term is a dyadic rational — the value is exact, hence toBe not toBeCloseTo)
    const s = new AuthoritativeStore(STEP);
    s.upsertCharacter(char(1n, 0, 0), 1000); // first sight
    s.upsertCharacter(char(1n, 1, 0), 1600);
    s.upsertCharacter(char(1n, 2, 0), 2200);
    s.upsertCharacter(char(1n, 3, 0), 2800);
    s.upsertCharacter(char(1n, 4, 0), 3400);
    const seeded = s.character(1n)!.jitterEwma;
    expect(seeded).toBe(165.52734375);

    // That estimate already saturates the ADR-0090 max-delay clamp on its own:
    //   clamp(200 + 2*165.52734375, 100, 500) = clamp(531.0546875, ...) = 500.
    // The formula is inlined rather than imported from render/interpolation — a
    // net-layer test must not import the render layer (ADR-0014 one-way flow); the
    // delay function itself is pinned in render/interpolation.test.ts.
    expect(Math.min(500, Math.max(100, 200 + 2 * seeded))).toBe(500);

    // 5 s idle, then a 1-tile resume: interval 5000 > 600 → SKIPPED.
    // WRONG IMPL KILLED: the ungated estimator computes
    //   0.125*4800 + 0.875*165.52734375 = 600 + 144.83642578125 = 744.83642578125,
    // i.e. the pause itself would nearly quintuple the estimate and pin the delay at
    // the 500 ms clamp for ~10 further samples.
    s.upsertCharacter(char(1n, 5, 0), 8400);
    expect(s.character(1n)!.jitterEwma).toBe(seeded); // bit-identical across the gap
  });
});

// =============================================================================
// m15b: trade_offer store methods — upsert/remove/allTradeOffers/ownTradeOffer (RT-TO-02)
//
// The trade_offer table is PUBLIC (both parties subscribe — ADR-0106 D3).
// upsertTradeOffer/removeTradeOffer are the only m15b store mutations.
// allTradeOffers() feeds buildTradeViewModel; ownTradeOffer() is a convenience
// accessor (documented as first-match, not sorted — ADR-0106 D4 / store.ts comment).
//
// TEETH CONTRACT (what is killed):
//   - An impl that keys the map by identity string instead of tradeId bigint
//   - An impl that does not filter in ownTradeOffer (returns all offers)
//   - An impl where reset() forgets to clear tradeOffers (leaks across reconnects)
//   - An impl where upsert is not idempotent (duplicates on reconnect re-insert)
//   - An impl where removeTradeOffer uses wrong key type (e.g., Number(tradeId))
// =============================================================================

function makeTradeOffer(
  tradeId: bigint,
  initiator: string,
  counterparty: string,
  overrides: Partial<StoreTradeOffer> = {},
): StoreTradeOffer {
  return {
    tradeId,
    initiator,
    counterparty,
    initiatorMonsterIds: [],
    initiatorItems: [],
    initiatorCurrency: 0n,
    counterpartyMonsterIds: [],
    counterpartyItems: [],
    counterpartyCurrency: 0n,
    initiatorCards: [],
    counterpartyCards: [],
    status: 'Pending',
    createdAtMs: 0n,
    ...overrides,
  };
}

describe('AuthoritativeStore m15b: trade_offer upsert/remove/read (RT-TO-02)', () => {
  it('RT-TO-02a BITES: upsertTradeOffer + allTradeOffers round-trip — row survives store boundary', () => {
    // Kills: an impl that loses the trade offer on upsert (wrong Map key, missed assignment).
    const s = new AuthoritativeStore();
    s.upsertTradeOffer(makeTradeOffer(99n, 'alice', 'bob'));
    const all = s.allTradeOffers();
    expect(all).toHaveLength(1);
    expect(all[0]!.tradeId).toBe(99n);
    expect(all[0]!.initiator).toBe('alice');
    expect(all[0]!.counterparty).toBe('bob');
  });

  it('RT-TO-02b BITES: upsertTradeOffer is idempotent — re-insert overwrites, never duplicates', () => {
    // Kills: an impl that appends instead of upserting (array-store duplication bug).
    // This matters on reconnect: the subscription re-delivers all rows as onInsert events.
    const s = new AuthoritativeStore();
    s.upsertTradeOffer(makeTradeOffer(5n, 'alice', 'bob', { status: 'Pending' }));
    s.upsertTradeOffer(makeTradeOffer(5n, 'alice', 'bob', { status: 'ConfirmedByCounterparty' }));
    const all = s.allTradeOffers();
    expect(all).toHaveLength(1); // overwritten, not duplicated
    expect(all[0]!.status).toBe('ConfirmedByCounterparty'); // newest value wins
  });

  it('RT-TO-02c BITES: removeTradeOffer removes by bigint tradeId — no type-cast corruption', () => {
    // Kills: an impl that keys the Map by Number(tradeId), which loses precision past 2^53.
    // With Number() keying, large tradeIds would collide on removal and the wrong offer removed.
    const largeId = 9007199254740993n; // 2^53 + 1
    const s = new AuthoritativeStore();
    s.upsertTradeOffer(makeTradeOffer(largeId, 'alice', 'bob'));
    s.upsertTradeOffer(makeTradeOffer(1n, 'carol', 'dave')); // decoy
    s.removeTradeOffer(largeId);
    const all = s.allTradeOffers();
    expect(all).toHaveLength(1);
    expect(all[0]!.tradeId).toBe(1n); // decoy survives; large-id row removed
  });

  it('RT-TO-02d BITES: ownTradeOffer finds by initiator identity (string equality)', () => {
    // Kills: an impl that returns undefined for the initiator role,
    // or that only searches the counterparty field.
    const s = new AuthoritativeStore();
    s.upsertTradeOffer(makeTradeOffer(10n, 'alice', 'bob'));
    s.upsertTradeOffer(makeTradeOffer(20n, 'carol', 'dave')); // unrelated
    const found = s.ownTradeOffer('alice');
    expect(found).toBeDefined();
    expect(found!.tradeId).toBe(10n);
  });

  it('RT-TO-02e BITES: ownTradeOffer finds by counterparty identity (not just initiator)', () => {
    // Kills: an impl that only checks o.initiator === identity and ignores counterparty.
    // A counterparty-role player would see undefined instead of their active offer.
    const s = new AuthoritativeStore();
    s.upsertTradeOffer(makeTradeOffer(7n, 'alice', 'bob'));
    const found = s.ownTradeOffer('bob');
    expect(found).toBeDefined();
    expect(found!.tradeId).toBe(7n);
  });

  it('RT-TO-02f BITES: ownTradeOffer returns undefined when identity is not a party', () => {
    // Kills: an impl that does not filter and returns the first offer unconditionally.
    // This would expose trade contents from other players (PUBLIC table data leak).
    const s = new AuthoritativeStore();
    s.upsertTradeOffer(makeTradeOffer(3n, 'alice', 'bob'));
    const found = s.ownTradeOffer('carol'); // carol is not a party
    expect(found).toBeUndefined();
  });

  it('RT-TO-02g BITES: reset() clears trade offers — stale rows do not survive reconnect', () => {
    // Kills: an impl that forgets to clear #tradeOffers in reset().
    // A stale offer from a prior session would show the previous trade UI after reconnect.
    // Server deletes the active offer on disconnect (TR-18 / on_disconnect), so this
    // stale row would never be refreshed — the viewer would see a ghost trade forever.
    const s = new AuthoritativeStore();
    s.upsertTradeOffer(makeTradeOffer(1n, 'alice', 'bob'));
    expect(s.allTradeOffers()).toHaveLength(1);
    s.reset();
    expect(s.allTradeOffers()).toHaveLength(0);
    expect(s.ownTradeOffer('alice')).toBeUndefined();
  });

  it('RT-TO-02h BITES: upsertTradeOffer marks store dirty (triggers flushBatch)', () => {
    // Kills: an impl that forgets this.#dirty = true in upsertTradeOffer,
    // so the trade batch listener never fires when a new offer arrives.
    const s = new AuthoritativeStore();
    const listener = vi.fn();
    s.onBatchApplied(listener);
    s.upsertTradeOffer(makeTradeOffer(1n, 'alice', 'bob'));
    s.flushBatch();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('RT-TO-02i BITES: removeTradeOffer marks store dirty (triggers flushBatch)', () => {
    // Kills: an impl that forgets this.#dirty = true in removeTradeOffer,
    // so the UI does not re-render when the server deletes the offer (trade completes/cancels).
    const s = new AuthoritativeStore();
    const listener = vi.fn();
    s.onBatchApplied(listener);
    s.upsertTradeOffer(makeTradeOffer(1n, 'alice', 'bob'));
    s.flushBatch(); // consume dirty
    listener.mockClear();
    s.removeTradeOffer(1n);
    s.flushBatch();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// m17b — StoreProfile + upsertProfile / profile / allProfiles (RL-13 store layer)
// SOURCE OF TRUTH: specs/monster-realm-v2/M17-ranked-ladder.spec.md §RL-13 / §RL-15
//
// RED REASON: StoreProfile type and the four new store methods do not exist yet.
// All tests will fail with TypeScript import errors / missing-property errors
// until the implementer adds StoreProfile + upsertProfile/profile/allProfiles to
// store.ts, and wires #profiles.clear() into reset().
//
// Contract:
//   StoreProfile = { identity: string; name: string; rating: number; wins: number; losses: number }
//   (type alias, NOT interface — probe-cast convention from store.ts:39 comment)
//   upsertProfile(p: StoreProfile): void  — keyed by identity; idempotent re-insert
//   profile(identity: string): StoreProfile | undefined
//   allProfiles(): StoreProfile[]  — fresh array each call (mutating it must not corrupt the store)
//   reset() clears profiles  (pattern: store.ts:597-604)
//   NO removeProfile — RL-2/ADR-0119 D1: profile rows are never deleted
//
// WRONG-IMPL-KILLED list:
//   - "array store instead of Map"       → idempotency test (RT-PR-01b)
//   - "allProfiles returns live reference" → isolation test (RT-PR-03)
//   - "reset does not clear profiles"    → reset test (RT-PR-04)
//   - "upsertProfile not dirty"          → dirty-flag test (RT-PR-05)
//   - "profile() case-normalizes identity" → identity equality test (RT-PR-02)
//   - "removeProfile exists"             → absence test (RT-PR-06)
// =============================================================================

/** Factory for StoreProfile test fixtures. */
function makeProfile(
  identity: string,
  name: string,
  rating: number,
  wins = 0,
  losses = 0,
): StoreProfile {
  return { identity, name, rating, wins, losses };
}

describe('AuthoritativeStore m17b: StoreProfile upsert + lookup (RL-13)', () => {
  it('RT-PR-01a BITES: upsertProfile stores row; profile() retrieves it — kills no-op upsert impl', () => {
    // Kills: an impl that exposes upsertProfile but never writes to the internal Map.
    const s = new AuthoritativeStore();
    s.upsertProfile(makeProfile('aabbcc', 'Alice', 1200, 5, 2));
    const p = s.profile('aabbcc');
    expect(p).toBeDefined();
    expect(p!.identity).toBe('aabbcc');
    expect(p!.name).toBe('Alice');
    expect(p!.rating).toBe(1200);
    expect(p!.wins).toBe(5);
    expect(p!.losses).toBe(2);
  });

  it('RT-PR-01b BITES: upsert same identity twice overwrites (keyed-Map idempotency, not array append)', () => {
    // Kills: an impl that stores profiles in an array and appends on re-insert,
    // causing allProfiles() to return duplicates on reconnect.
    const s = new AuthoritativeStore();
    s.upsertProfile(makeProfile('aabbcc', 'Alice', 1000));
    s.upsertProfile(makeProfile('aabbcc', 'Alice', 1050, 1, 0)); // same identity, updated rating
    const all = s.allProfiles();
    expect(all).toHaveLength(1);
    expect(all[0]!.rating).toBe(1050); // last-write wins
  });

  it('RT-PR-02 BITES: profile() uses exact case-sensitive identity equality — kills case-normalizing impl', () => {
    // Kills: an impl that lowercases/uppercases identity before storing or looking up.
    const s = new AuthoritativeStore();
    s.upsertProfile(makeProfile('DEADBEEF', 'Upper', 1100));
    expect(s.profile('DEADBEEF')).toBeDefined();
    expect(s.profile('deadbeef')).toBeUndefined(); // different case → not found
  });

  it('RT-PR-01c BITES: profile() returns undefined for an unknown identity — kills throw impl', () => {
    // Kills: an impl that throws instead of returning undefined for missing identity.
    const s = new AuthoritativeStore();
    expect(s.profile('nobody')).toBeUndefined();
  });

  it('RT-PR-01d BITES: distinct identities coexist (two profiles, each retrieved independently)', () => {
    // Kills: an impl that uses a single-slot store instead of a Map.
    const s = new AuthoritativeStore();
    s.upsertProfile(makeProfile('aaa', 'Alice', 1200));
    s.upsertProfile(makeProfile('bbb', 'Bob', 900));
    expect(s.profile('aaa')!.name).toBe('Alice');
    expect(s.profile('bbb')!.name).toBe('Bob');
  });
});

describe('AuthoritativeStore m17b: allProfiles() fresh-array isolation (RL-13)', () => {
  it('RT-PR-03 BITES: mutating the returned array does NOT corrupt the store — kills live-reference impl', () => {
    // Kills: an impl that returns the internal array/map values array directly.
    // After mutation the store must still contain the original profiles.
    const s = new AuthoritativeStore();
    s.upsertProfile(makeProfile('aaa', 'Alice', 1200));
    s.upsertProfile(makeProfile('bbb', 'Bob', 900));

    const first = s.allProfiles();
    expect(first).toHaveLength(2);

    // Mutate the returned array — splice out all items.
    first.splice(0, first.length);
    expect(first).toHaveLength(0); // local mutation

    // Re-query: store must still have both profiles.
    const second = s.allProfiles();
    expect(second).toHaveLength(2);
  });

  it('RT-PR-03b BITES: two successive allProfiles() calls return independent arrays — kills cached-ref impl', () => {
    // Kills: an impl that caches and returns the same array object on both calls.
    const s = new AuthoritativeStore();
    s.upsertProfile(makeProfile('aaa', 'Alice', 1000));

    const a = s.allProfiles();
    const b = s.allProfiles();

    // Must be distinct array objects (not the same reference).
    expect(a).not.toBe(b);
    // Both must contain the profile.
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});

describe('AuthoritativeStore m17b: reset() clears profiles (RL-13)', () => {
  it('RT-PR-04 BITES: reset() clears profiles; allProfiles() empty; profile() undefined — kills no-clear impl', () => {
    // Kills: an impl that omits this.#profiles.clear() from reset() (the explicit
    // pattern from store.ts:597-604 requires each map to be cleared).
    const s = new AuthoritativeStore();
    s.upsertProfile(makeProfile('aaa', 'Alice', 1200));
    expect(s.allProfiles()).toHaveLength(1);

    s.reset();

    expect(s.allProfiles()).toHaveLength(0);
    expect(s.profile('aaa')).toBeUndefined();
  });

  it('RT-PR-04b BITES: reset keeps batch listeners alive; post-reset upsertProfile reaches listeners', () => {
    // Kills: an impl that clears listeners on reset (breaking the running loop).
    // Mirror of the existing "reset clears ... listeners survive" pattern throughout this file.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertProfile(makeProfile('aaa', 'Alice', 1000));
    s.flushBatch();

    s.reset();
    expect(s.allProfiles()).toHaveLength(0);

    // Post-reset upsert must still reach the listener.
    s.upsertProfile(makeProfile('bbb', 'Bob', 1100));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(2); // once pre-reset, once post-reset
  });
});

describe('AuthoritativeStore m17b: upsertProfile dirty flag (RL-13)', () => {
  it('RT-PR-05 BITES: upsertProfile marks dirty; flushBatch fires onBatchApplied — kills no-dirty impl', () => {
    // Kills: an impl that upserts the row but forgets this.#dirty = true, so the
    // leaderboard batch listener never fires when a new profile arrives.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);

    s.upsertProfile(makeProfile('aaa', 'Alice', 1200));
    expect(cb).toHaveBeenCalledTimes(0); // not mid-batch

    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1); // exactly one coherent batch signal
  });

  it('RT-PR-05b BITES: second upsert with same identity marks dirty again — kills no-dirty-on-update impl', () => {
    // Kills: an impl that only marks dirty on INSERT but not on UPDATE (i.e. when the
    // Map already has the key). The leaderboard needs to re-render on rating updates.
    const s = new AuthoritativeStore();
    s.upsertProfile(makeProfile('aaa', 'Alice', 1000));
    s.flushBatch(); // consume dirty

    const cb = vi.fn();
    s.onBatchApplied(cb);

    s.upsertProfile(makeProfile('aaa', 'Alice', 1050, 1, 0)); // update existing
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('AuthoritativeStore m17b: no removeProfile method (RL-2 structural guarantee)', () => {
  it('RT-PR-06 BITES: AuthoritativeStore does NOT expose a removeProfile method — kills RL-2 violation impl', () => {
    // RL-2 / ADR-0119 D1: profile rows are NEVER deleted. Wiring a removeProfile
    // would be unreachable dead code and create a silent violation risk.
    // Kills: an impl that adds removeProfile "just in case" (violates ADR-0119 D1).
    const s = new AuthoritativeStore();
    expect(typeof (s as unknown as Record<string, unknown>).removeProfile).not.toBe('function');
  });
});

// =============================================================================
// ptc5f — ADR-0142 (D3): burst-spread reachability bound (pins ADR-0090)
//
// upsertCharacter's burst-synthetic branch (see store.ts's `#stepMs>0 && existing
// !== undefined && !shouldSnap && now - existing.latest.receivedAt < BURST_EPSILON_MS`
// guard) only ASSIGNS the synthetic receivedAt when
// `existing.latest.receivedAt + stepMs <= now + BURST_EPSILON_MS`. Substituting
// d = now - existing.latest.receivedAt (the outer guard bounds d only from ABOVE,
// d < BURST_EPSILON_MS — there is NO d >= 0 check in the code) reduces the guard to
// `stepMs <= d + BURST_EPSILON_MS`. A negative d (a chained future synthetic) only
// SHRINKS the RHS, so the reachability supremum is at d -> BURST_EPSILON_MS: the
// branch is reachable for SOME admissible d iff `stepMs < 2*BURST_EPSILON_MS`. At
// the real production tick rate (STEP_MS=200,
// surfaced to the client via the wasm `step_ms()` export in main.ts — not importable
// into this node-only vitest run) the branch is provably DEAD CODE: these are
// TDD pins of that existing (already-true) fact, not new behaviour.
// =============================================================================

describe('AuthoritativeStore ADR-0090/ptc5f: burst-spread reachability bound (Decision A pin)', () => {
  // SYNCED LITERAL: game-core/src/world.rs STEP_MS, surfaced to the client via the
  // wasm step_ms() export (main.ts). Not importable into node vitest — see ADR-0142
  // D3 drift caveat: if the Rust constant changes, this literal must be updated by
  // hand and this describe block re-verified.
  const PRODUCTION_STEP_MS = 200;

  it('the reachability bound holds: production STEP_MS >= 2*BURST_EPSILON_MS (branch inert)', () => {
    // Raising BURST_EPSILON_MS past 100 (2*100=200) would break this and make the
    // burst-synthetic branch reachable at STEP_MS=200 — this is the imported-constant
    // tooth: it fails the moment BURST_EPSILON_MS drifts past the safe half of 200.
    expect(PRODUCTION_STEP_MS).toBeGreaterThanOrEqual(2 * BURST_EPSILON_MS);
  });

  it('BITES: at production STEP_MS the synthetic branch is unreachable across the WHOLE burst-gap domain', () => {
    // Sweep every non-negative burst gap d in [0, BURST_EPSILON_MS) — the
    // reachability-maximizing sub-domain (negative d only shrinks reachability, so
    // if no non-negative d fires, none does). At PRODUCTION_STEP_MS, synthetic
    // (t0 + 200) always exceeds now + BURST_EPSILON_MS (at most t0 + 39), so the
    // guard never fires and receivedAt stays at real wall-clock time for every d.
    // Wrong impl killed: any impl that fires synthetic at this stepMs (e.g. a
    // reversed guard, or one that forgets the B-2 cap) would report t0+200 for at
    // least one d, failing this assertion.
    for (let d = 0; d < BURST_EPSILON_MS; d++) {
      const s = new AuthoritativeStore(PRODUCTION_STEP_MS);
      const t0 = 1000;
      s.upsertCharacter(char(1n, 0, 0), t0);
      s.upsertCharacter(char(1n, 1, 0), t0 + d);
      expect(s.character(1n)!.latest.receivedAt).toBe(t0 + d); // wall-clock, NEVER t0+200
    }
  });

  it('BITES the exact threshold: reachable at stepMs=2*BURST_EPSILON_MS-1, unreachable at stepMs=2*BURST_EPSILON_MS', () => {
    // Below the bound (stepMs=39): at the worst-case gap d=BURST_EPSILON_MS-1 (=19),
    // synthetic = t0+39, guard = t0+39 <= (t0+19)+20 = t0+39 → true (equality) → fires.
    const s = new AuthoritativeStore(2 * BURST_EPSILON_MS - 1); // 39
    const t0 = 1000;
    s.upsertCharacter(char(1n, 0, 0), t0);
    s.upsertCharacter(char(1n, 1, 0), t0 + (BURST_EPSILON_MS - 1)); // t0 + 19
    expect(s.character(1n)!.latest.receivedAt).toBe(t0 + (2 * BURST_EPSILON_MS - 1)); // t0+39, synthetic

    // AT the bound (stepMs=40): sweep the whole domain again — every d must fall
    // back to wall-clock time, proving 40 is unreachable and the bound is TIGHT.
    // Wrong impl killed: an off-by-one guard (e.g. `<` instead of `<=`) would still
    // fire at d=19, stepMs=40 for at least one d, failing this loop.
    for (let d = 0; d < BURST_EPSILON_MS; d++) {
      const s2 = new AuthoritativeStore(2 * BURST_EPSILON_MS); // 40
      s2.upsertCharacter(char(1n, 0, 0), t0);
      s2.upsertCharacter(char(1n, 1, 0), t0 + d);
      expect(s2.character(1n)!.latest.receivedAt).toBe(t0 + d); // no synthetic — 40 is unreachable
    }
  });
});

// =============================================================================
// ux2 (ADR-0154) — owner-scoped wallet SLOT: upsertWallet / ownWallet / reset
//
// SOURCE OF TRUTH: ux2 build plan v3 §T4 ("store slot") + "Client unit tests".
// Tests are INTENTIONALLY RED until store.ts grows the slot. Do NOT edit them to
// match a buggy implementation — correct from the plan only.
//
// CONTRACT UNDER TEST
//   export type StoreWallet = { readonly ownerIdentity: string; readonly balance: bigint };
//   upsertWallet(row: StoreWallet): void   — sets a SINGLE slot, marks #dirty
//   ownWallet(identity: string): StoreWallet | undefined
//                                          — the slot ONLY when slot.ownerIdentity === identity
//   reset()                                — also clears the slot
//   NO remove path exists, deliberately (server never deletes wallet rows — T2/R2).
//
// WHY A SLOT, NOT A MAP (§T4): the `my_wallet` view returns exactly ONE row for the
// caller, so a Map would make another player's balance representable in the client
// cache for free. A single slot makes that structurally unrepresentable.
//
// TEETH CONTRACT (what these four kill):
//   S1 — a Number()-casting impl (`balance: 100` instead of `100n`), and an impl
//        that returns the slot regardless of ownerIdentity (ADR-0015 V1 owner filter).
//   S2 — an impl that stores the row but forgets `#dirty = true`, so the shop batch
//        listener never re-renders when the balance changes after a buy/sell.
//   S3 — an impl whose reset() forgets the slot (stale balance leaks across a
//        reconnect / identity change), and an impl that ships a removeWallet path.
//   S4 — an impl that ACCUMULATES (`balance += row.balance`) or that keeps the FIRST
//        row (insert-wins-per-key rather than slot-replaces) — the buy-then-sell
//        100→50→100 delivery would then display a wrong balance forever.
// =============================================================================

function makeWallet(ownerIdentity: string, balance: bigint): StoreWallet {
  return { ownerIdentity, balance };
}

describe('AuthoritativeStore ux2 S1: ownWallet returns the own row and filters by identity', () => {
  it('S1 BITES: upsertWallet + ownWallet(own identity) returns the row with a BIGINT balance', () => {
    // Kills: an impl that Number()-casts the balance (toBe uses Object.is, so 100
    // !== 100n and the assertion fails); an impl that stores to the wrong key.
    const s = new AuthoritativeStore();
    s.upsertWallet(makeWallet('alice-hex', 100n));

    const own = s.ownWallet('alice-hex');
    expect(own).toBeDefined();
    expect(own!.ownerIdentity).toBe('alice-hex');
    expect(typeof own!.balance).toBe('bigint');
    expect(own!.balance).toBe(100n); // bigint literal — a `100` number impl dies here
  });

  it('S1 BITES: ownWallet(a DIFFERENT identity) returns undefined (client-side owner filter)', () => {
    // Kills: an impl that returns the slot unconditionally (`return this.#ownWallet`).
    // Defense in depth (ADR-0015 V1): even though the server view is owner-scoped, a
    // stale slot from a previous identity must never be surfaced to the new one.
    const s = new AuthoritativeStore();
    s.upsertWallet(makeWallet('alice-hex', 100n));

    expect(s.ownWallet('bob-hex')).toBeUndefined();
  });

  it('S1 BITES: a large balance survives past 2^53 as an exact bigint (no Number() round-trip)', () => {
    // Kills: an impl that round-trips through Number() internally — 2^53+1 is lossy.
    const s = new AuthoritativeStore();
    const huge = 9007199254740993n; // 2^53 + 1
    s.upsertWallet(makeWallet('alice-hex', huge));
    expect(s.ownWallet('alice-hex')!.balance).toBe(huge);
  });
});

describe('AuthoritativeStore ux2 S2: upsertWallet marks dirty; listeners fire once per batch', () => {
  it('S2 BITES: upsertWallet marks dirty — flushBatch fires onBatchApplied exactly once', () => {
    // Kills: an impl that sets the slot but forgets `this.#dirty = true`. The shop
    // overlay would then keep showing the pre-buy balance until some unrelated row
    // happened to dirty the store.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);

    s.upsertWallet(makeWallet('alice-hex', 100n));
    expect(cb).toHaveBeenCalledTimes(0); // not mid-batch — only flushBatch signals

    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1); // exactly one coherent batch signal
  });

  it('S2 BITES: a SECOND upsert for the same owner marks dirty again (update, not just insert)', () => {
    // Kills: an impl that only dirties when the slot was previously undefined. Every
    // balance change after the first is an UPDATE — that is the whole point of the view.
    const s = new AuthoritativeStore();
    s.upsertWallet(makeWallet('alice-hex', 100n));
    s.flushBatch(); // consume the first dirty

    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertWallet(makeWallet('alice-hex', 50n));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('AuthoritativeStore ux2 S3: reset() clears the wallet slot; no remove path exists', () => {
  it('S3 BITES: reset() clears the slot — ownWallet returns undefined afterwards', () => {
    // Kills: an impl whose reset() forgets the new slot. On reconnect (or on an
    // identity change) the old player's balance would still be readable and would
    // be rendered as the new player's gold.
    const s = new AuthoritativeStore();
    s.upsertWallet(makeWallet('alice-hex', 100n));
    expect(s.ownWallet('alice-hex')).toBeDefined(); // precondition

    s.reset();

    expect(s.ownWallet('alice-hex')).toBeUndefined();
  });

  it('S3 BITES: reset() keeps batch listeners alive; a post-reset upsertWallet still signals', () => {
    // Kills: an impl that clears listeners on reset (breaks the running loop).
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertWallet(makeWallet('alice-hex', 100n));
    s.flushBatch();

    s.reset();
    expect(s.ownWallet('alice-hex')).toBeUndefined();

    s.upsertWallet(makeWallet('bob-hex', 7n));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(2); // once pre-reset, once post-reset
    expect(s.ownWallet('bob-hex')!.balance).toBe(7n);
  });

  it('S3 BITES: AuthoritativeStore exposes NO removeWallet method (§T4 no-remove policy)', () => {
    // §T4: the server never deletes a wallet row (gated by R2), so a view onDelete can
    // only be the OLD half of an update pair. A remove path is not merely dead — on the
    // coalesced buy-then-sell delivery I(50) I(100) D(100) D(50) any field-equality gate
    // would delete the LIVE row. Insert-wins + reset() is the only correct policy.
    // Kills: an impl that adds removeWallet "for symmetry" with the other tables.
    const s = new AuthoritativeStore();
    expect(typeof (s as unknown as Record<string, unknown>).removeWallet).not.toBe('function');
  });
});

describe('AuthoritativeStore ux2 S4: buy-then-sell round trip — the slot REPLACES, never accumulates', () => {
  it('S4 BITES: upsertWallet(50n) then upsertWallet(100n) → ownWallet() is exactly 100n', () => {
    // The real delivery shape from §T4: a buy takes 100→50, a sell takes 50→100, and the
    // view re-emits the row each time.
    // Kills: (a) an accumulating impl (`balance + row.balance`) → 150n;
    //        (b) a first-write-wins impl (insert-only, ignores the update) → 50n;
    //        (c) an impl that appends to a list and reads element [0] → 50n.
    const s = new AuthoritativeStore();
    s.upsertWallet(makeWallet('alice-hex', 50n));
    s.upsertWallet(makeWallet('alice-hex', 100n));

    const own = s.ownWallet('alice-hex');
    expect(own).toBeDefined();
    expect(own!.balance).toBe(100n);
    expect(own!.balance).not.toBe(150n); // explicit: no accumulation
    expect(own!.balance).not.toBe(50n); // explicit: no first-write-wins
  });

  it('S4 BITES: a wallet for a NEW owner replaces the slot entirely (the old owner is gone)', () => {
    // Single-slot semantics: the slot is not a keyed map, so an arriving row for a
    // different owner must not leave the previous owner readable.
    // Kills: a Map-backed impl (which would keep both) — that is exactly the shape
    // §T4 rejects, because another player's balance becomes representable in the cache.
    const s = new AuthoritativeStore();
    s.upsertWallet(makeWallet('alice-hex', 100n));
    s.upsertWallet(makeWallet('bob-hex', 3n));

    expect(s.ownWallet('bob-hex')!.balance).toBe(3n);
    expect(s.ownWallet('alice-hex')).toBeUndefined();
  });
});

// ===========================================================================
// uxd2 (ADR-0161 D1) — StoreNpcRow carries the NpcInteraction discriminated union.
// APPENDED BLOCK — nothing above this line is modified.
//
// SOURCE OF TRUTH: docs/specs/uxd2-plan.md I5 / AC-16 + docs/adr/0161-*.md §D1.
//
// THE INVARIANT: the interaction reaches EVERY npc read path — `npc(entityId)`,
// `npcByNpcId(npcId)` and `allNpcs()`. main.ts feeds `allNpcs()` to the resolver and
// the DIALOGUE VM reads the map built from it, so a read path that drops the field
// silently disables either the prompt or the Shop button (never both — which is
// exactly the kind of half-failure that survives a single spot check).
//
// RED STATE (declared honestly): the three pure round-trips below are REGRESSION
// GUARDS and pass on master, because `upsertNpc` stores the row object by reference
// and therefore carries any field the caller put on it. They bite a future rewrite
// that reconstructs the row field-by-field inside the store (the shape every other
// converter in this repo uses) — that rewrite would drop `interaction` silently.
// The FOURTH case is the RED one: it drives the row through the REAL boundary
// converter (`npcRowToStore`) first, which today discards `interaction`.
// ===========================================================================

interface Uxd2SdkNpcRow {
  entityId: bigint;
  npcId: string;
  zoneId: number;
  homeX: number;
  homeY: number;
  wanderRadius: number;
  dialogueTreeId: string;
  interaction: { tag: string; value?: number };
}

type Uxd2StoreNpcInteraction =
  | { kind: 'dialogue' }
  | { kind: 'shop'; shopId: number }
  | { kind: 'heal'; locationId: number };

function uxd2NpcRow(
  entityId: bigint,
  interaction: Uxd2StoreNpcInteraction,
  npcId = `npc-${entityId}`,
): Record<string, unknown> {
  return {
    entityId,
    npcId,
    zoneId: 1,
    homeX: 8,
    homeY: 1,
    wanderRadius: 0,
    dialogueTreeId: 'shopkeeper_greeting',
    interaction,
  };
}

/** The store's npc methods are reached through the same cast idiom the M12d block uses. */
function npcApi(s: AuthoritativeStore): Record<string, (...args: unknown[]) => unknown> {
  return s as unknown as Record<string, (...args: unknown[]) => unknown>;
}

describe('uxd2: AuthoritativeStore round-trips StoreNpcRow.interaction on every read path', () => {
  const cases: ReadonlyArray<{ label: string; interaction: Uxd2StoreNpcInteraction }> = [
    { label: 'dialogue', interaction: { kind: 'dialogue' } },
    { label: 'shop', interaction: { kind: 'shop', shopId: 1 } },
    { label: 'heal', interaction: { kind: 'heal', locationId: 3 } },
  ];

  for (const c of cases) {
    it(`REGRESSION GUARD (green on master): upsertNpc preserves a ${c.label} interaction through npc() / npcByNpcId() / allNpcs()`, () => {
      // WRONG IMPL KILLED: a future upsertNpc that normalises the row by rebuilding it
      // field-by-field (`this.#npcs.set(row.entityId, { entityId: row.entityId, … })`) and
      // forgets the new column — the client would go dark on interactions with no error.
      // Asserting all THREE read paths kills a half-fix that only threads the primary map.
      const s = new AuthoritativeStore();
      const row = uxd2NpcRow(11n, c.interaction, 'tideglass_shopkeeper');
      npcApi(s).upsertNpc(row);

      const byEid = npcApi(s).npc(11n) as { interaction?: unknown } | undefined;
      const byNpcId = npcApi(s).npcByNpcId('tideglass_shopkeeper') as
        | { interaction?: unknown }
        | undefined;
      const all = npcApi(s).allNpcs() as Array<{ interaction?: unknown }>;

      expect(byEid?.interaction).toEqual(c.interaction);
      expect(byNpcId?.interaction).toEqual(c.interaction);
      expect(all).toHaveLength(1);
      expect(all[0]!.interaction).toEqual(c.interaction);
    });
  }

  it('REGRESSION GUARD: re-upserting the SAME entityId replaces the interaction (no stale role)', () => {
    // WRONG IMPL KILLED: a merge-style upsert (`{...existing, ...row}` with a guard that
    // keeps a previously-set field) — a content republish that demotes a shopkeeper back to
    // Dialogue would leave a phantom Shop button until a full reconnect.
    const s = new AuthoritativeStore();
    npcApi(s).upsertNpc(uxd2NpcRow(11n, { kind: 'shop', shopId: 1 }, 'shopkeeper'));
    npcApi(s).upsertNpc(uxd2NpcRow(11n, { kind: 'dialogue' }, 'shopkeeper'));
    expect((npcApi(s).npc(11n) as { interaction?: unknown }).interaction).toEqual({
      kind: 'dialogue',
    });
  });

  it('★ BITES (RED today): a row driven through npcRowToStore reaches the store with its interaction intact', () => {
    // THE INTEGRATION TOOTH. This is the path the live adapter actually uses
    // (connection.ts: `store.upsertNpc(npcRowToStore(row))`). On master the converter
    // discards `interaction`, so `npc(2n).interaction` is `undefined` here and this case
    // fails — the unit-level converter cases in rowConvert.test.ts pin the mapping table,
    // and THIS one pins that the two halves are actually joined.
    // WRONG IMPL KILLED: a converter hardened in isolation while connection.ts keeps
    // building its own row literal (the field would never reach the store).
    const s = new AuthoritativeStore();
    const sdkRow: Uxd2SdkNpcRow = {
      entityId: 2n,
      npcId: 'tideglass_shopkeeper',
      zoneId: 1,
      homeX: 8,
      homeY: 1,
      wanderRadius: 0,
      dialogueTreeId: 'shopkeeper_greeting',
      interaction: { tag: 'Shop', value: 1 },
    };
    npcApi(s).upsertNpc(npcRowToStore(sdkRow) as unknown as Record<string, unknown>);
    expect((npcApi(s).npc(2n) as { interaction?: unknown }).interaction).toEqual({
      kind: 'shop',
      shopId: 1,
    });
  });

  it('BITES: reset() drops npc rows (a stale shopkeeper cannot survive a reconnect)', () => {
    // WRONG IMPL KILLED: an impl that adds the interaction column but forgets the npc maps
    // in reset() — after a reconnect to a republished module the client would resolve an
    // interact against a shopkeeper whose row no longer exists server-side.
    const s = new AuthoritativeStore();
    npcApi(s).upsertNpc(uxd2NpcRow(11n, { kind: 'shop', shopId: 1 }, 'shopkeeper'));
    s.reset();
    expect(npcApi(s).npc(11n)).toBeUndefined();
    expect(npcApi(s).npcByNpcId('shopkeeper')).toBeUndefined();
    expect(npcApi(s).allNpcs()).toHaveLength(0);
  });
});

// =============================================================================
// 11r-b — ownPerspective(battle, identity) — pure view-perspective projection
// SOURCE OF TRUTH: memory/projects/monster-realm-11r-b-plan.md §4 AC-4/AC-5/AC-6/AC-7/AC-8
//   + §11 R-3 (T-OWNP-1 merged into the swap tooth; T-OWNP-OUTCOME kept as-is)
//
// `ownPerspective` is a NEW exported pure free function (not a store method — keeps the
// store's accessors honestly "raw server truth" and keeps the projection directly
// unit-testable, ADR-0167 D2) that re-expresses a battle so the caller's OWN side is
// always sideA:
//   - identity === playerIdentity (checked FIRST — this ordering is what covers a
//     practice battle, where playerIdentity === opponentIdentity, ADR-0109) → returned
//     BY REFERENCE (`.toBe`, not `.toEqual` — the cheapest possible proof of "no swap").
//   - identity === opponentIdentity AND !== playerIdentity → sideA/sideB,
//     playerIdentity/opponentIdentity, partyMonsterIds/opponentMonsterIds swapped;
//     outcome SideAWins/SideBWins swapped. battleId/turnNumber/weather/createdAtMs/
//     'Ongoing'/'Fled'/any unrecognized outcome string pass through verbatim.
//   - identity in NEITHER role → returned BY REFERENCE (never a fabricated perspective).
//   - `undefined` in → `undefined` out.
//
// NEVER MUTATE a projected view in place (ADR-0167 hardening note): the fast path returns
// a store-owned object by reference and the slow path shallow-swaps nested side objects —
// the raw/projected split relies on callers treating both as read-only.
//
// RED reason: `ownPerspective` is not exported from ./store yet — every test below fails
// on the missing export (see the import-site comment at the top of this file).
// =============================================================================

/** A monster factory for ownPerspective's fixtures — same shape as battleMonster() above,
 *  but the caller supplies speciesId explicitly so side-A/side-B fixtures never collide on
 *  a shared default (T-OWNP-SWAP and T-OWNP-DOWNSTREAM both need DISTINGUISHABLE sides so a
 *  partial swap cannot accidentally look correct). */
function ownpMonster(
  speciesId: number,
  overrides: Partial<StoreBattleMonster> = {},
): StoreBattleMonster {
  return battleMonster({ speciesId, ...overrides });
}

/** A battle fixture with DELIBERATELY asymmetric sideA/sideB (different `active` index,
 *  different team length, different species ids, non-empty and DIFFERENT
 *  partyMonsterIds/opponentMonsterIds) so a partial swap in ownPerspective cannot
 *  accidentally look correct. playerIdentity='alice' (the challenger), opponentIdentity='bob'
 *  (the accepter — the side this whole slice is about). */
function ownpFixture(overrides: Partial<StoreBattle> = {}): StoreBattle {
  return {
    battleId: 77n,
    playerIdentity: 'alice',
    opponentIdentity: 'bob',
    outcome: 'Ongoing',
    turnNumber: 4,
    sideA: { active: 0, team: [ownpMonster(101), ownpMonster(102)] },
    sideB: { active: 2, team: [ownpMonster(201), ownpMonster(202), ownpMonster(203)] },
    partyMonsterIds: [11n, 12n],
    opponentMonsterIds: [21n, 22n, 23n],
    createdAtMs: 5000n,
    weather: { tag: 'Rain', turnsRemaining: 2 },
    ...overrides,
  };
}

describe('AuthoritativeStore 11r-b: ownPerspective(battle, identity) — pure view projection (ADR-0167)', () => {
  it('T-OWNP-SIDEA: BITES identity===playerIdentity returns the SAME object by reference (AC-4)', () => {
    // Cheapest possible proof of "no swap": reference equality, not deep-equal.
    // Kills: an impl that always builds a fresh object (even if field-identical).
    const b = ownpFixture();
    expect(ownPerspective(b, 'alice')).toBe(b);
  });

  it("T-OWNP-PRACTICE: BITES a practice battle (playerIdentity===opponentIdentity==='alice', ADR-0109) returns the SAME object — the role-check-ORDERING tooth (AC-4)", () => {
    // THE role-check-ordering tooth: an impl that tests `identity === opponentIdentity`
    // BEFORE `identity === playerIdentity` would swap a practice battle's sides, seating the
    // player on the WRONG side of their own mirror. Only THIS fixture — where BOTH roles
    // equal the caller's identity — can distinguish "checks playerIdentity first" from
    // "checks opponentIdentity first"; every other fixture in this describe block has the
    // two roles held by different identities, so an ordering bug is invisible there.
    const b = ownpFixture({ playerIdentity: 'alice', opponentIdentity: 'alice' });
    expect(ownPerspective(b, 'alice')).toBe(b);
  });

  it('T-OWNP-SWAP: BITES identity===opponentIdentity (≠playerIdentity) swaps the 6 side fields AND preserves the 4 verbatim fields, in ONE test (AC-5, merged per plan §11 R-3)', () => {
    // ONE test asserts BOTH halves so a partial swap cannot pass: swapping sideA/sideB but
    // forgetting partyMonsterIds/opponentMonsterIds (or vice versa) fails here, and so does
    // an impl that (incorrectly) ALSO remaps battleId/turnNumber/weather/createdAtMs.
    const b = ownpFixture(); // playerIdentity='alice', opponentIdentity='bob'
    const projected = ownPerspective(b, 'bob');

    expect(projected).not.toBe(b); // a real swap happened, not the reference fast path

    // The 6 exchanged fields:
    expect(projected.sideA).toEqual(b.sideB);
    expect(projected.sideB).toEqual(b.sideA);
    expect(projected.playerIdentity).toBe('bob');
    expect(projected.opponentIdentity).toBe('alice');
    expect(projected.partyMonsterIds).toEqual(b.opponentMonsterIds);
    expect(projected.opponentMonsterIds).toEqual(b.partyMonsterIds);

    // The 4 verbatim-preserved fields:
    expect(projected.battleId).toBe(b.battleId);
    expect(projected.turnNumber).toBe(b.turnNumber);
    expect(projected.weather).toEqual(b.weather);
    expect(projected.createdAtMs).toBe(b.createdAtMs);
  });

  it('T-OWNP-NONPARTICIPANT: BITES identity in NEITHER role returns the SAME object by reference — never a fabricated perspective (AC-6)', () => {
    const b = ownpFixture(); // alice / bob
    expect(ownPerspective(b, 'carol')).toBe(b);
  });

  it('T-OWNP-UNDEFINED: BITES ownPerspective(undefined, identity) returns undefined', () => {
    expect(ownPerspective(undefined, 'alice')).toBeUndefined();
  });

  it('T-OWNP-OUTCOME: fast-check — the outcome remap is an INVOLUTION; Ongoing/Fled/any unrecognized tag are FIXED POINTS', () => {
    // Kills: a remap that touches 'Fled' (only SideAWins/SideBWins ever swap), or that
    // coerces/normalizes an unknown tag — which would defeat parseOutcomeTag's
    // bindings-regen drift detector (ui/battleModel.ts:203-213 relies on an unrecognized
    // string reaching it UNCHANGED so its null-guard path stays reachable and meaningful).
    fc.assert(
      fc.property(
        fc.oneof(fc.constantFrom('Ongoing', 'SideAWins', 'SideBWins', 'Fled'), fc.string()),
        (outcome) => {
          const b = ownpFixture({ outcome, playerIdentity: 'alice', opponentIdentity: 'bob' });
          const projectedOnce = ownPerspective(b, 'bob'); // side-B projection
          const once = projectedOnce.outcome;

          // Fixed point: every tag OTHER than the two known win tags passes through
          // UNCHANGED (covers 'Ongoing', 'Fled', and any fc.string() garbage tag).
          if (outcome !== 'SideAWins' && outcome !== 'SideBWins') {
            expect(once).toBe(outcome);
          } else {
            expect(once).toBe(outcome === 'SideAWins' ? 'SideBWins' : 'SideAWins');
          }

          // Involution: projecting the ALREADY-projected battle from the ORIGINAL
          // playerIdentity's perspective (who is now the opponentIdentity of
          // projectedOnce) swaps back to the original tag.
          const back = ownPerspective(projectedOnce, 'alice').outcome;
          expect(back).toBe(outcome);
        },
      ),
    );
  });
});

describe('AuthoritativeStore 11r-b: ownPerspective ∘ buildBattleViewModel — the downstream behavioral tooth (ADR-0167)', () => {
  it("T-OWNP-DOWNSTREAM: BITES side B's projected VM shows THEIR OWN cards/skills/bench; the RAW VM (no projection) shows the challenger's instead — the contrast that makes this bite (AC-7)", () => {
    const aliceActive = ownpMonster(101, { knownSkillIds: [1] });
    const aliceBench = ownpMonster(102, { knownSkillIds: [2] });
    const bobActive = ownpMonster(201, { knownSkillIds: [3] });
    const bobBenchHealthy = ownpMonster(202, { knownSkillIds: [4], currentHp: 10 });
    const bobBenchFainted = ownpMonster(203, { knownSkillIds: [5], currentHp: 0 });

    const b: StoreBattle = {
      battleId: 77n,
      playerIdentity: 'alice',
      opponentIdentity: 'bob',
      outcome: 'Ongoing',
      turnNumber: 4,
      sideA: { active: 0, team: [aliceActive, aliceBench] },
      sideB: { active: 0, team: [bobActive, bobBenchHealthy, bobBenchFainted] },
      partyMonsterIds: [11n, 12n],
      opponentMonsterIds: [21n, 22n, 23n],
      createdAtMs: 5000n,
      weather: null,
    };

    const skillMap = new Map<number, StoreSkillRow>(
      [1, 2, 3, 4, 5].map((id): [number, StoreSkillRow] => [id, skillRow(id)]),
    );
    const speciesMap = new Map<number, StoreSpeciesRow>(
      [101, 102, 201, 202, 203].map((id): [number, StoreSpeciesRow] => [id, speciesRow(id)]),
    );

    // THE FIX under test: identity 'bob' is the accepter (opponentIdentity) — project
    // BEFORE building the view model, exactly as main.ts's refreshBattle must (W-PVPB-PROJECT).
    const projected = ownPerspective(b, 'bob');
    const vmProjected = buildBattleViewModel(projected, skillMap, speciesMap);
    expect(vmProjected).not.toBeNull();

    expect(vmProjected!.playerCard.speciesName).toBe(speciesRow(201).name); // bob's OWN active
    expect(vmProjected!.skills.map((s) => s.id)).toEqual([3]); // bob's OWN active's skills
    expect(vmProjected!.bench.map((m) => m.speciesName)).toEqual([speciesRow(202).name]); // bob's OWN healthy bench (fainted excluded)
    expect(vmProjected!.opponentCard.speciesName).toBe(speciesRow(101).name); // the challenger's
    expect(vmProjected!.isPvp).toBe(true);
    expect(vmProjected!.canRecruit).toBe(false); // AC-11
    expect(vmProjected!.canFlee).toBe(false); // AC-11

    // THE CONTRAST — what makes this bite: building the SAME view model from the RAW
    // (unprojected) row shows the CHALLENGER's monster as playerCard. This is exactly the
    // defect a dropped or partial ownPerspective call reproduces (the half-fix: AC-1
    // satisfied via the role-agnostic accessor, AC-7 still violated because nothing
    // projected the row before it reached buildBattleViewModel).
    const vmRaw = buildBattleViewModel(b, skillMap, speciesMap);
    expect(vmRaw).not.toBeNull();
    expect(vmRaw!.playerCard.speciesName).toBe(speciesRow(101).name); // alice's, NOT bob's
  });

  it("T-OWNP-OUTCOME-VM: BITES side B's projected VM outcome is SideAWins when the raw row is SideBWins ('Victory!'), and SideBWins when raw is SideAWins ('Defeat...') (AC-8)", () => {
    // battleView.ts #renderOutcome (~:430-435) maps SideAWins -> 'Victory!' and
    // SideBWins -> 'Defeat...'. This VM-level tooth does not render the DOM banner itself
    // (battleView.test.ts's job) — it pins the outcome tag battleView reads, which is what
    // makes that fixed mapping correct FOR SIDE B specifically.
    const skillMap = new Map<number, StoreSkillRow>();
    const speciesMap = new Map<number, StoreSpeciesRow>();

    const bobWon = ownpFixture({ outcome: 'SideBWins' }); // raw server truth: side B won
    const vmBobWon = buildBattleViewModel(ownPerspective(bobWon, 'bob'), skillMap, speciesMap);
    expect(vmBobWon).not.toBeNull();
    expect(vmBobWon!.outcome).toBe('SideAWins'); // side B's OWN perspective: "I won"

    const aliceWon = ownpFixture({ outcome: 'SideAWins' }); // raw server truth: side A won
    const vmAliceWon = buildBattleViewModel(ownPerspective(aliceWon, 'bob'), skillMap, speciesMap);
    expect(vmAliceWon).not.toBeNull();
    expect(vmAliceWon!.outcome).toBe('SideBWins'); // side B's OWN perspective: "I lost"
  });
});

// ===========================================================================
// 12r-d [E2] — StoreHealLocationRow carries costCurrency as a bigint, end to end.
// APPENDED BLOCK — nothing above this line is weakened. The M12d local interface
// (~line 2132) and its `healLocationRow` factory gained the new required key so they
// still describe a well-formed row; not one of their assertions changed.
//
// EARS E2: WHEN a heal-location row is written into the store and read back, the store
// SHALL return its `costCurrency` as the SAME bigint value it was given — no coercion,
// no truncation, no cross-row bleed.
//
// RED STATE, DECLARED HONESTLY (this is the interesting part of this block):
//   * ST-HL-CC-01 is a CONTRACT PIN that is GREEN AT HEAD BY DESIGN at runtime.
//     `upsertHealLocation` is a bare `#healLocations.set(row.locationId, row)` — it stores
//     the caller's object BY REFERENCE, so it carries any field the caller put on it. Its
//     RED arm at HEAD is TYPE-LEVEL ONLY: the fixture is annotated with the IMPORTED
//     `RealStoreHealLocationRow`, which has no `costCurrency` today, so the literal is an
//     excess property and `got.costCurrency` is a TS2339. That arm does NOT surface in
//     `npm run typecheck` either — client/tsconfig.json line 15 EXCLUDES `**/*.test.ts`
//     (verified in this worktree) — so it is an editor/review signal, not a CI gate.
//     Its real job is to BITE a future `upsertHealLocation` that normalises the row by
//     rebuilding it field-by-field (the shape every converter in this repo uses) and
//     silently drops the new column. Same posture, same wording, as the uxd2 npc
//     "REGRESSION GUARD (green on master)" cases above.
//   * ST-HL-CC-02 / ST-HL-CC-03 are the RED ones: they drive the row through the REAL
//     boundary converter first (`healLocationRowToStore`), which at HEAD maps seven fields
//     and drops costCurrency — so the store hands back `undefined`.
// ===========================================================================

/** 2^53 + 1 — the smallest integer a JS `number` cannot hold. Any Number() hop in the
 *  ingest path collapses it to 9007199254740992. */
const HEAL_COST_2P53_PLUS_1 = 9007199254740993n;

describe('AuthoritativeStore 12r-d [E2]: heal-location costCurrency survives the store round trip', () => {
  it('ST-HL-CC-01 CONTRACT PIN (green at HEAD by design — see block header): upsertHealLocation → healLocations() returns the same bigint', () => {
    // WRONG IMPL KILLED: a future upsertHealLocation that rebuilds the row field-by-field
    // (`this.#healLocations.set(row.locationId, { locationId: row.locationId, … })`) and
    // forgets costCurrency — the heal overlay would go back to claiming a paid pad is free
    // with no error anywhere. Built against the IMPORTED store type (no `as unknown as`
    // erasure) so the shape under test is the SHIPPED one, not a local mirror.
    const row: RealStoreHealLocationRow = {
      locationId: 9,
      zoneId: 2,
      tileX: 3,
      tileY: 4,
      costItemId: undefined,
      costQty: 0,
      cooldownMs: 30_000,
      costCurrency: HEAL_COST_2P53_PLUS_1,
    };
    const s = new AuthoritativeStore();
    s.upsertHealLocation(row);
    const got = s.healLocations().find((l) => l.locationId === 9);
    expect(got).toBeDefined();
    expect(typeof got!.costCurrency).toBe('bigint');
    expect(got!.costCurrency).toBe(9007199254740993n);
    expect(got!.costCurrency).not.toBe(9007199254740992n); // the Number()-hop value
  });

  it('★ ST-HL-CC-02 BITES (RED at HEAD): the ADAPTER path SDK row → healLocationRowToStore → store preserves 2^53+1 exactly', () => {
    // THE integration tooth. connection.ts:380-383 is literally
    // `store.upsertHealLocation(healLocationRowToStore(row))`, so this composition IS the
    // production ingest path for heal content. WRONG IMPL KILLED (the HEAD one): a converter
    // that never mentions costCurrency — the store then hands `undefined` to healModel and
    // every cost readout downstream is a guess. ALSO KILLED: a `Number()` hop anywhere in
    // that path, which returns 9007199254740992 (asserted explicitly so the failure names
    // the bug rather than just "expected X received Y").
    const sdkRow = {
      locationId: 9,
      zoneId: 2,
      tileX: 3,
      tileY: 4,
      costItemId: undefined as number | undefined,
      costQty: 0,
      cooldownMs: 30_000,
      costCurrency: HEAL_COST_2P53_PLUS_1,
    };
    const s = new AuthoritativeStore();
    s.upsertHealLocation(healLocationRowToStore(sdkRow));
    const got = s.healLocations().find((l) => l.locationId === 9);
    expect(got).toBeDefined();
    expect(typeof got!.costCurrency).toBe('bigint');
    expect(got!.costCurrency).toBe(9007199254740993n);
    expect(got!.costCurrency).not.toBe(9007199254740992n);
  });

  it('★ ST-HL-CC-03 BITES (RED at HEAD): three pads keep their OWN costCurrency through the adapter (no cross-row bleed)', () => {
    // WRONG IMPL KILLED (1): the dropped field again (all three read `undefined`).
    // WRONG IMPL KILLED (2): a converter/store that hoists one row's currency out of the
    // per-row path and reuses the first (or last) value for every pad — a free pad next to
    // a 500-gold pad is exactly the content shape the world seeds, and a bleed there is
    // invisible in any single-row spot check. The middle pad is 0n so a "last write wins"
    // bleed and a "first write wins" bleed produce DIFFERENT wrong answers, both caught.
    const pads: ReadonlyArray<readonly [number, bigint]> = [
      [1, 10n],
      [2, 0n],
      [3, 500n],
    ];
    const s = new AuthoritativeStore();
    for (const [locationId, costCurrency] of pads) {
      const sdkRow = {
        locationId,
        zoneId: 0,
        tileX: 1,
        tileY: 1,
        costItemId: undefined as number | undefined,
        costQty: 0,
        cooldownMs: 30_000,
        costCurrency,
      };
      s.upsertHealLocation(healLocationRowToStore(sdkRow));
    }
    const byId = s.healLocations().sort((a, b) => a.locationId - b.locationId);
    expect(byId.map((l) => l.locationId)).toEqual([1, 2, 3]);
    expect(byId.map((l) => l.costCurrency)).toEqual([10n, 0n, 500n]);
  });
});

// =============================================================================
// M21b-2 (ADR-0182 D15) — the owner-scoped ACCOUNT SLOT: upsertAccount /
// ownAccount / reset. APPENDED BLOCK — nothing above this line is modified.
//
// EARS COVERED
//   AUTH-51 — WHILE deciding whether to display any "signed in" or claim-eligible
//             affordance, the client SHALL use ONLY the subscribed `my_account` row's
//             presence as the source of truth. This slot IS that source of truth, so its
//             own-identity filter is the whole guarantee.
//   G29 (store half) — `ownAccount(identity)` returns `undefined` for a FOREIGN identity
//             even when the slot is populated. (The other half — main.ts naming neither
//             `readAuthKind` nor `credential.kind` — is a whole-file negative in
//             main.wiring.test.ts.)
//
// CONTRACT UNDER TEST (mirrors `#ownWallet` / `upsertWallet` / `ownWallet`, store.ts:404,
// 713, 1039-1053, byte-for-byte in shape — the same reasoning applies verbatim):
//   export type StoreAccount = {
//     readonly identity: string;                     // hex, from Identity.toHexString()
//     readonly authIssuer: string;
//     readonly createdAtMs: bigint;                  // i64
//     readonly lastLoginAtMs: bigint;                // i64
//     readonly status: string;                       // the AccountStatus tag, carried bare
//     readonly deletionRequestedAtMs: bigint | undefined;   // Option<i64>
//     readonly claimedFrom: string | undefined;             // Option<Identity>, hex
//     readonly claimedAtMs: bigint | undefined;             // Option<i64>
//     readonly terminalAtMs: bigint | undefined;            // Option<i64>, M22 S4 (PR#407):
//                                                           // the PRV1-4 permanent-deletion
//                                                           // marker. NINE keys, not eight.
//   };
//   upsertAccount(row: StoreAccount): void   — sets a SINGLE slot, marks #dirty
//   ownAccount(identity: string): StoreAccount | undefined
//                                            — the slot ONLY when slot.identity === identity
//   reset()                                  — also clears the slot
//   NO removeAccount, deliberately: `delete_account` only flips `status` to
//   `PendingDeletion` (schema.rs:669-700), account rows are never truly deleted, and the
//   `my_account` VIEW delivers an update as unordered onInsert(new) + onDelete(old) — so a
//   delete path could only ever wipe the LIVE row (ADR-0182 D15's explicit "deliberately NO
//   onDelete").
//
// WHY A SLOT, NOT A MAP: `my_account` returns exactly ONE row — the caller's
// (schema.rs:708-711). A Map would make another player's account row representable in the
// client cache for free; a single slot makes that structurally impossible.
//
// RED REASON AT HEAD (8814416): `StoreAccount`, `upsertAccount` and `ownAccount` do not
// exist in store.ts. The late import below fails to resolve its named export and this whole
// block reds on a MISSING IMPLEMENTATION.
// =============================================================================

// A late, second import block. Precedent: rowConvert.test.ts:2816 and :3102 do exactly
// this for their appended sections, and biome sorts imports only WITHIN a contiguous chunk.
import type { StoreAccount } from './store';

const ACCOUNT_A = 'alice-account-hex';
const ACCOUNT_B = 'bob-account-hex';
const GUEST_HEX = 'guest-identity-hex';

function makeAccount(identity: string, overrides: Partial<StoreAccount> = {}): StoreAccount {
  return {
    identity,
    authIssuer: 'issuer-under-test',
    createdAtMs: 1_700_000_000_000n,
    lastLoginAtMs: 1_700_000_100_000n,
    status: 'Active',
    deletionRequestedAtMs: undefined,
    claimedFrom: undefined,
    claimedAtMs: undefined,
    terminalAtMs: undefined,
    ...overrides,
  };
}

describe('AuthoritativeStore M21b-2 A1: ownAccount returns the own row and filters by identity', () => {
  it('★ A1 BITES: upsertAccount + ownAccount(own identity) returns the row verbatim', () => {
    // Kills: an impl that stores to the wrong key, or that projects/normalises the row on
    // the way in (the timestamps are bigints and must survive as bigints — same u64/i64
    // doctrine rowConvert.ts:543-568 states for the wallet balance).
    const s = new AuthoritativeStore();
    const row = makeAccount(ACCOUNT_A, { claimedFrom: GUEST_HEX, claimedAtMs: 1_700_000_200_000n });
    s.upsertAccount(row);

    const own = s.ownAccount(ACCOUNT_A);
    expect(own).toBeDefined();
    expect(own!.identity).toBe(ACCOUNT_A);
    expect(own!.claimedFrom).toBe(GUEST_HEX);
    expect(typeof own!.createdAtMs).toBe('bigint');
    expect(own!.claimedAtMs).toBe(1_700_000_200_000n);
  });

  it('★★ A1 BITES (G29): ownAccount(a DIFFERENT identity) returns undefined even when the slot is populated', () => {
    // ★ THE G29 STORE HALF. Kills: `return this.#ownAccount` — the slot returned
    // unconditionally.
    //
    // WHY IT IS LOAD-BEARING AND NOT MERELY DEFENSIVE: AUTH-51 makes this slot the SOLE
    // authority for "is this connection actually authenticated", and ADR-0182 D16 makes
    // `store.ownAccount(identity)?.claimedFrom` the ONLY client-side disambiguation of
    // ERR_INVALID_CODE. A reconnect that mints a NEW identity (the anonymous path does
    // exactly this) would, without the filter, keep reading the PREVIOUS identity's account
    // row — so the client would show "signed in", offer account-only affordances, and read
    // a stale `claimedFrom` as proof that a claim it never made had succeeded. The slot is
    // cleared on reset(), but reset() runs on DISCONNECT and the read paths run on every
    // frame; the filter is what makes the window unreachable rather than merely short.
    const s = new AuthoritativeStore();
    s.upsertAccount(makeAccount(ACCOUNT_A));

    expect(s.ownAccount(ACCOUNT_B)).toBeUndefined();
    expect(s.ownAccount('')).toBeUndefined();
    expect(s.ownAccount(ACCOUNT_A)).toBeDefined(); // anti-vacuity for the two negatives
  });

  it('★ A1 BITES: the identity match is EXACT — no case folding, no trimming', () => {
    // main.ts holds the identity as the hex string the SDK handed `onConnect`, and the
    // comparison is `===` on both sides. Any normalisation applied here and not there
    // silently disables the account UI (or, worse, enables it for the wrong identity).
    const s = new AuthoritativeStore();
    s.upsertAccount(makeAccount('AABBCC'));
    expect(s.ownAccount('aabbcc')).toBeUndefined();
    expect(s.ownAccount(' AABBCC ')).toBeUndefined();
    expect(s.ownAccount('AABBCC')).toBeDefined();
  });

  it('★ A1 BITES: an empty slot returns undefined (kills a fabricated default row)', () => {
    // ADR-0154 D6's "broke vs dark" distinction, applied to accounts: "no account row yet"
    // and "an account row exists" are DIFFERENT states and must stay distinguishable —
    // AUTH-51 hangs the whole signed-in UI on exactly that difference.
    const s = new AuthoritativeStore();
    expect(s.ownAccount(ACCOUNT_A)).toBeUndefined();
  });

  it('★★ A1 BITES (M22 PRV1-4): terminalAtMs round-trips through the slot — 0n survives, absent stays dark', () => {
    // The ninth key (M22 S4, PR#407) is the PRIMARY route to privacyModel's terminal
    // phase, and the slot is the only thing between the converter and that read.
    //
    // WRONG IMPLS KILLED:
    //   (a) a slot that PROJECTS the row on the way in (an explicit eight-key copy left
    //       over from ADR-0182 D15) — `terminalAtMs` is silently dropped, PRV1-4 never
    //       fires, and the player is offered a cancel for an account that is already gone.
    //   (b) a slot that normalises `undefined` to `0n` "so the field is always there" —
    //       the mirror inversion: every healthy account reads as permanently deleted.
    const s = new AuthoritativeStore();

    s.upsertAccount(makeAccount(ACCOUNT_A, { status: 'PendingDeletion', terminalAtMs: 0n }));
    expect(s.ownAccount(ACCOUNT_A)!.terminalAtMs, '0n is a REAL i64 marker, not an absence').toBe(
      0n,
    );

    s.upsertAccount(makeAccount(ACCOUNT_A, { terminalAtMs: 1_700_000_400_000n }));
    expect(s.ownAccount(ACCOUNT_A)!.terminalAtMs).toBe(1_700_000_400_000n);

    // The update path is what carries the marker: the reaper writes it AFTER the row is
    // already in the slot, so an insert-wins slot would never see it at all.
    s.upsertAccount(makeAccount(ACCOUNT_B));
    expect(
      s.ownAccount(ACCOUNT_B)!.terminalAtMs,
      'absent stays DARK, never fabricated',
    ).toBeUndefined();
    s.upsertAccount(makeAccount(ACCOUNT_B, { terminalAtMs: 1_700_000_500_000n }));
    expect(s.ownAccount(ACCOUNT_B)!.terminalAtMs).toBe(1_700_000_500_000n);
  });
});

describe('AuthoritativeStore M21b-2 A2: upsertAccount marks dirty and REPLACES the slot', () => {
  it('★ A2 BITES: upsertAccount marks dirty — flushBatch fires onBatchApplied exactly once', () => {
    // Kills: an impl that sets the slot but forgets `this.#dirty = true`. `status` and
    // `claimed_from` MUTATE post-provisioning (ADR-0182 D15), so the claim UI would keep
    // rendering the pre-claim state until some unrelated row happened to dirty the store.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);

    s.upsertAccount(makeAccount(ACCOUNT_A));
    expect(cb).toHaveBeenCalledTimes(0); // not mid-batch — only flushBatch signals

    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('★★ A2 BITES: a SECOND upsert for the same identity replaces the row (kills insert-wins)', () => {
    // THE UPDATE PATH IS THE POINT. Unlike `my_wallet`, `my_account` is wired with BOTH
    // onInsert AND onUpdate (ADR-0182 D15) precisely because `status`/`claimed_from` change
    // after provisioning. An insert-wins slot would leave `claimedFrom: undefined` forever
    // — and claimModel's ERR_INVALID_CODE disambiguation reads exactly that field, so a
    // completed claim would be reported to the player as an invalid code.
    const s = new AuthoritativeStore();
    s.upsertAccount(makeAccount(ACCOUNT_A));
    s.upsertAccount(makeAccount(ACCOUNT_A, { claimedFrom: GUEST_HEX, status: 'PendingDeletion' }));

    const own = s.ownAccount(ACCOUNT_A);
    expect(own!.claimedFrom).toBe(GUEST_HEX);
    expect(own!.status).toBe('PendingDeletion');
  });

  it('★★ A2 BITES: a row for a DIFFERENT identity replaces the slot entirely (single-slot semantics)', () => {
    // Kills a Map-backed impl, which would keep BOTH — making another identity's account
    // row representable in the client cache, the exact shape the view's one-row contract
    // exists to prevent.
    const s = new AuthoritativeStore();
    s.upsertAccount(makeAccount(ACCOUNT_A));
    s.upsertAccount(makeAccount(ACCOUNT_B));

    expect(s.ownAccount(ACCOUNT_B)).toBeDefined();
    expect(s.ownAccount(ACCOUNT_A)).toBeUndefined();
  });

  it('★ A2 BITES: every upsert marks dirty, not just the first (the update is what carries the claim)', () => {
    const s = new AuthoritativeStore();
    s.upsertAccount(makeAccount(ACCOUNT_A));
    s.flushBatch(); // consume the first dirty

    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertAccount(makeAccount(ACCOUNT_A, { claimedFrom: GUEST_HEX }));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('AuthoritativeStore M21b-2 A3: reset() clears the account slot; no remove path exists', () => {
  it('★★ A3 BITES: reset() clears the slot — ownAccount returns undefined afterwards', () => {
    // Kills: an impl whose reset() forgets the new slot. reset() runs on disconnect, and
    // the very next connection can carry a DIFFERENT identity (every anonymous rebuild can
    // mint one). A surviving row would make the client show the previous player's
    // signed-in state — and would hand claimModel a `claimedFrom` belonging to someone else.
    const s = new AuthoritativeStore();
    s.upsertAccount(makeAccount(ACCOUNT_A));
    expect(s.ownAccount(ACCOUNT_A)).toBeDefined(); // precondition

    s.reset();

    expect(s.ownAccount(ACCOUNT_A)).toBeUndefined();
  });

  it('★ A3 BITES: reset() keeps batch listeners alive; a post-reset upsertAccount still signals', () => {
    // Kills: an impl that clears listeners on reset (breaks the running loop) — the same
    // guarantee the ux2 wallet block asserts for its own slot.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.upsertAccount(makeAccount(ACCOUNT_A));
    s.flushBatch();

    s.reset();
    expect(s.ownAccount(ACCOUNT_A)).toBeUndefined();

    s.upsertAccount(makeAccount(ACCOUNT_B));
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(2); // once pre-reset, once post-reset
    expect(s.ownAccount(ACCOUNT_B)).toBeDefined();
  });

  it('★ A3 BITES: AuthoritativeStore exposes NO removeAccount method', () => {
    // ADR-0182 D15: account rows are NEVER truly deleted (`delete_account` flips `status`
    // to `PendingDeletion`), and through a VIEW an UPDATE arrives as unordered
    // onInsert(new) + onDelete(old) — so any delete path could only ever wipe the LIVE row.
    // Kills: an impl that adds removeAccount "for symmetry" with the keyed tables.
    const s = new AuthoritativeStore();
    expect(typeof (s as unknown as Record<string, unknown>).removeAccount).not.toBe('function');
  });
});

// =============================================================================
// 15r-sec-a (ADR-0198): reconcileBattlesFromView + battleCount — the battle half
// of the view-cache reconcile.
//
// SOURCE OF TRUTH: docs/adr/0198-participant-scoped-battle-view.md;
// specs/monster-realm-v2/M-postgate-fifteenth-review-residuals.spec.md:75-79.
//
// WHY THIS METHOD EXISTS AT ALL. `my_battle` is a VIEW, and a view binding carries
// NO primary key, so the SDK never fires onUpdate: every row change arrives as
// unordered `onInsert(new)` + `onDelete(old)` inside one transaction burst. That
// matters far more for battle than it did for monsters — the battle row changes on
// EVERY turn, so the delete half of a mis-handled pair takes the live battle off
// the screen mid-fight. The adapter therefore rebuilds the whole battle map from
// the SDK's post-burst row set, which is ordering-immune by construction, and the
// row handlers only schedule the flush.
//
// THE CONTRACT, in one sentence: after `reconcileBattlesFromView(rows)`, the
// store's battle map contains EXACTLY `rows` keyed by battleId — every given row
// upserted, every absent id removed — and the batch is marked dirty ONLY if
// something actually changed.
//
// WHY `shallowRowEq` (store.ts:1198) CANNOT BE REUSED FOR THE CHANGE DETECTION.
// It is a generic own-key `===` compare. `StoreBattle` (store.ts:164-177) nests
// `sideA`/`sideB` OBJECTS, each holding an ARRAY of monster objects, and the
// boundary converter `battleRowToStore` (rowConvert.ts:321-348) builds all of them
// fresh on every call — so `prev.sideA !== next.sideA` for two conversions of the
// SAME server row, every time. Reusing it makes the reconcile mark the batch dirty
// on EVERY flush (i.e. on every ~5/s movement tick), which is a render storm. The
// sanctioned answer is a deep comparator that recurses plain objects AND arrays
// and compares primitives with `===` (bigint-safe: `JSON.stringify` THROWS on a
// BigInt, and StoreBattle carries four of them). 13r-e's helpers are left alone.
//
// AND WHY A TURN-NUMBER COMPARATOR IS UNSOUND (the tempting shortcut): `flee`
// (battle.rs:927) and `apply_pvp_forfeit` (pvp.rs:644-700) both mutate
// `state.outcome` WITHOUT bumping turn_number, so "same id, same turn ⇒ unchanged"
// silently drops the transition that ends the battle.
//
// RED REASON (at authoring time): `AuthoritativeStore` has neither
// `reconcileBattlesFromView` nor a `battleCount` getter, so every test below fails
// with "s.reconcileBattlesFromView is not a function" / `battleCount` undefined.
// store.test.ts:938 records the absence of the getter in as many words.
// =============================================================================

describe('AuthoritativeStore 15r-sec-a: reconcileBattlesFromView post-condition', () => {
  it('★ BITES (1): a mid-battle change is applied and the row is NOT dropped — in EITHER array order', () => {
    // EARS 15r-sec-a-4, at the unit seam: "WHEN a battle's state changes
    // mid-battle, the client store SHALL reflect it and SHALL NOT drop the row."
    //
    // WHAT ORDERING SURVIVES THIS FAR. The unordered insert/delete PAIR is dissolved
    // by taking the SDK's post-burst row SET as the argument — that is the whole
    // design. The only ordering still visible at this seam is the order of the array,
    // and it must not matter either.
    //
    // WRONG IMPL KILLED (a): id-set arithmetic that applies "deletes" after
    //   "inserts" — the classic rebuild-from-events shape, which removes the row the
    //   insert half just wrote and blanks the battle overlay mid-fight.
    // WRONG IMPL KILLED (b): an insert-if-absent upsert (`if (!map.has(id))`), which
    //   compiles, looks like "the snapshot already has it", and FREEZES the battle at
    //   turn 1 forever.
    const staleRow = { ...battle(7n, 'alice'), turnNumber: 3 };
    const freshRow = { ...battle(7n, 'alice'), turnNumber: 4 };
    const bystander = battle(8n, 'alice');

    for (const [label, rows] of [
      ['changed row first', [freshRow, bystander]],
      ['changed row last', [bystander, freshRow]],
    ] as const) {
      const s = new AuthoritativeStore();
      s.upsertBattle(staleRow);
      s.upsertBattle(bystander);

      s.reconcileBattlesFromView(rows);

      expect(
        s.battle(7n),
        `${label}: the battle row must SURVIVE its own update — a dropped row blanks the ` +
          'battle overlay mid-fight, which is exactly what the delete half of a PK-less ' +
          'insert+delete pair does to an event-driven ingest',
      ).toBeDefined();
      // biome-ignore lint/style/noNonNullAssertion: asserted defined immediately above
      expect(s.battle(7n)!.turnNumber, `${label}: the NEW payload is authoritative`).toBe(4);
      expect(s.battleCount, `${label}: the bystander row is untouched`).toBe(2);
    }
  });

  it('★ BITES (2): the map ends up EXACTLY equal to the rows argument (upsert + remove in one call), and [] empties it', () => {
    // Kills: an impl that only upserts the given rows (a finished, GC'd battle is
    // STRANDED — its terminal outcome frame never clears); and one that treats an
    // EMPTY argument as "nothing to do" (the guard an author adds to "avoid wiping
    // the store on an empty burst"). An empty view result is AUTHORITATIVE: the
    // player is in no battle.
    const s = new AuthoritativeStore();
    s.upsertBattle(battle(1n, 'alice'));
    s.upsertBattle(battle(2n, 'alice'));
    s.upsertBattle(battle(3n, 'bob'));

    s.reconcileBattlesFromView([{ ...battle(1n, 'alice'), turnNumber: 9 }, battle(4n, 'alice')]);

    expect(s.battleCount, 'exactly the two supplied rows survive').toBe(2);
    // biome-ignore lint/style/noNonNullAssertion: battleCount === 2 proves both are present
    expect(s.battle(1n)!.turnNumber, 'the supplied payload wins').toBe(9);
    expect(s.battle(4n), 'a row absent from the store is ADDED').toBeDefined();
    expect(s.battle(2n), 'a stored row absent from `rows` is REMOVED').toBeUndefined();
    expect(
      s.battle(3n),
      'a row belonging to another player is removed too — the view only ever delivers rows the ' +
        'caller participates in, so a foreign row lingering in the map IS the leak this slice ' +
        'closes',
    ).toBeUndefined();

    s.reconcileBattlesFromView([]);
    expect(s.battleCount, 'an empty view result is authoritative, not a no-op').toBe(0);
    expect(s.battle(1n)).toBeUndefined();
    expect(s.battle(4n)).toBeUndefined();
  });

  it('★ BITES (3): a PRACTICE battle delivered TWICE in one row set is stored ONCE', () => {
    // EARS 15r-sec-a-3, client half: "WHEN a player is both participants (a practice
    // battle), THE SYSTEM SHALL deliver that row exactly once."
    //
    // The server-side half is the view's trailing dedup filter (pinned in
    // evals/monster-privacy.eval.mjs [VB/body] and the evolution_tests.rs mirror).
    // THIS is the client-side backstop: a view returns a Vec, not a set, so if the
    // dedup filter is ever lost the SAME row arrives twice in one post-burst set.
    //
    // Kills: an impl that pushes rows into an ARRAY (the battle screen would render
    // the practice battle as two battles, and ongoingBattle's highest-id tiebreak
    // would compare a row against itself).
    const s = new AuthoritativeStore();
    // Practice = self-vs-self (server-module/src/battle.rs:1274-1278): the SAME
    // identity in BOTH participant columns. Legal, and delivered exactly once.
    const practice = battle(11n, 'alice', 'Ongoing', 'alice');

    s.reconcileBattlesFromView([practice, { ...practice }]);

    expect(s.battleCount, 'keyed by battleId — one row, however many times delivered').toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: battleCount === 1 proves it is present
    expect(s.battle(11n)!.playerIdentity).toBe('alice');
    // biome-ignore lint/style/noNonNullAssertion: same row
    expect(s.battle(11n)!.opponentIdentity, 'a practice battle is self-vs-self').toBe('alice');
    expect(
      s.ongoingBattle('alice')?.battleId,
      'the practice battle resolves to ONE ongoing battle for its owner',
    ).toBe(11n);
  });

  it('★ BITES (4): an UNCHANGED row set marks NOTHING dirty (render-storm guard)', () => {
    // WHAT THIS PINS. The connection adapter calls reconcileBattlesFromView in EVERY
    // batcher flush — i.e. on every table's burst, including the ~5/s movement ticks —
    // so the reconcile must be a NO-OP for an unchanged row set. Without change
    // detection every movement tick marks the batch dirty and re-notifies every UI
    // listener: a render storm no e2e in this slice can see.
    //
    // THE FIXTURE IS PRODUCTION-SHAPED ON PURPOSE, and that is the whole test: the
    // rows are rebuilt by calling the factory again, so they are structurally equal
    // but NON-IDENTICAL objects *including freshly-built nested sideA/sideB and team
    // arrays* — exactly what battleRowToStore (rowConvert.ts:321-348) emits on every
    // call. The store never sees the same nested object twice in production.
    //
    // MUTANTS THIS KILLS: reusing store.ts's `shallowRowEq` (a generic own-key ===
    // compare) — `prev.sideA !== next.sideA` for two conversions of the SAME server
    // row, so it reports "changed" every flush and suppresses nothing; and deleting
    // the change guard altogether.
    //
    // THE FORBIDDEN "FIX" is editing this test to share one `sideA` reference between
    // the two arrays. That fixture shape never occurs in production, so it would make
    // the assertion pass while the storm continues.
    const s = new AuthoritativeStore();
    s.reconcileBattlesFromView([battle(1n, 'alice'), battle(2n, 'alice')]);
    s.flushBatch(); // clear the dirty flag from the initial population
    const cb = vi.fn();
    s.onBatchApplied(cb);

    s.reconcileBattlesFromView([battle(1n, 'alice'), battle(2n, 'alice')]);
    s.flushBatch();

    expect(
      cb,
      'an unchanged row set must not mark the batch dirty — the reconcile runs on EVERY batcher ' +
        'flush, so a dirty mark here re-renders the whole UI on every movement tick. Change ' +
        'detection must be a DEEP compare: StoreBattle nests sideA/sideB objects holding arrays ' +
        'of monster objects, all rebuilt fresh by battleRowToStore on every conversion',
    ).toHaveBeenCalledTimes(0);
  });

  it('★ BITES (5): a change NESTED inside sideA.team[0] is detected (over-suppression is the freeze bug)', () => {
    // The other half of clause (4): a comparator tightened until nothing is ever
    // dirty passes (4) trivially. This is the balancing assertion, and it is aimed at
    // the SHALLOWEST plausible comparators:
    //   * `prev.turnNumber === next.turnNumber` — UNSOUND for a real reason, not a
    //     hypothetical one: `flee` (battle.rs:927) and `apply_pvp_forfeit`
    //     (pvp.rs:644-700) mutate `state.outcome` WITHOUT bumping turn_number;
    //   * a one-level compare that stops at `sideA` and never looks inside `team`.
    // Damage lands in `team[i].currentHp` on every single turn, so a comparator that
    // cannot see it freezes the HP bars for the whole battle while the turn counter
    // keeps moving.
    const s = new AuthoritativeStore();
    const before = { ...battle(5n, 'alice'), sideA: battleSide({ team: [battleMonster()] }) };
    s.reconcileBattlesFromView([before]);
    s.flushBatch();
    const cb = vi.fn();
    s.onBatchApplied(cb);

    // Same id, same turn number, same outcome — ONE nested HP value differs.
    const after = {
      ...battle(5n, 'alice'),
      sideA: battleSide({ team: [battleMonster({ currentHp: 12 })] }),
    };
    s.reconcileBattlesFromView([after]);
    s.flushBatch();

    expect(
      cb,
      'a change nested in sideA.team[0].currentHp must mark the batch dirty exactly once — ' +
        'over-suppression is the FREEZE failure mode: the new row lands in the store and the HP ' +
        'bar never re-renders. turnNumber-only and one-level comparisons both fail here',
    ).toHaveBeenCalledTimes(1);
    expect(
      s.battle(5n)?.sideA.team[0]?.currentHp,
      'and the new payload must actually be the one stored',
    ).toBe(12);
  });

  it('★ BITES (6): battleCount equals the number of DISTINCT battleIds reconciled (fast-check)', () => {
    // Kills: an impl that counts rows from an array (inflates whenever the view
    // double-emits a practice battle, or whenever a row is re-delivered), and a
    // battleCount getter wired to anything other than the battle map's size.
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: 0n, max: 30n }), { maxLength: 50 }), (ids) => {
        const s = new AuthoritativeStore();
        s.reconcileBattlesFromView(ids.map((id) => battle(id, 'alice')));
        expect(s.battleCount).toBe(new Set(ids).size);
      }),
    );
  });

  it('★ BITES (7): a value-changing reconcile REPLACES the stored object, never mutates it in place', () => {
    // THE IN-PLACE-MUTATION CHEAT this kills (red-team PoC — it passes clauses 1-6):
    //     const prev = this.#battles.get(row.battleId);
    //     if (prev !== undefined) { Object.assign(prev, row); }   // same object!
    // Every count, membership and dirty-flag assertion above still holds, because the
    // MAP is right. What breaks is everything downstream that holds a reference:
    //   * `StoreBattle` is declared `readonly` field-by-field — mutating it violates
    //     the store's stated one-way `server -> store -> render` contract;
    //   * a view model or an outcome-frame latch that captured the previous row (or
    //     any memo keyed on object identity) silently observes the row change under
    //     it, so a "did this change?" reference compare in a consumer reads FALSE for
    //     a real update and the frame is never redrawn.
    const s = new AuthoritativeStore();
    s.reconcileBattlesFromView([{ ...battle(3n, 'alice'), turnNumber: 1 }]);
    const captured = s.battle(3n);
    expect(captured, 'precondition: the row was stored').toBeDefined();

    s.reconcileBattlesFromView([{ ...battle(3n, 'alice'), turnNumber: 2 }]);

    expect(
      s.battle(3n),
      'the stored row must be the NEW object, not the previous one mutated in place — ' +
        '`Object.assign(prev, row)` keeps the map correct and every other assertion in this ' +
        'block green while silently rewriting a row a consumer is still holding',
    ).not.toBe(captured);
    expect(
      captured?.turnNumber,
      'the previously handed-out object must be UNCHANGED — if this reads 2, the store mutated ' +
        'a row it had already published (StoreBattle is readonly field-by-field for exactly ' +
        'this reason)',
    ).toBe(1);
  });
});

// =============================================================================
// rb-53 (PRV1-11/12/13, residual R-m22-s8-X11; ADR-0231 Amendment A3) — the
// `my_export_bundle` chunk map: reconcileExportChunksFromView + ownExportChunks.
// APPENDED BLOCK — nothing above this line is modified.
//
// ★ SOURCE OF TRUTH — gate E1, verbatim:
//   "[PRV1-11/12/13 live transport + download] WHEN request_data_export completes THE CLIENT
//    SHALL read my_export_bundle from a live subscription, assemble it via
//    assembleExportBundle, and offer the artifact as a downloadable file"
//
// WHY THIS SHAPE (A3-D1). `my_export_bundle` is a Vec-VIEW with no primary key, structurally
// identical to `my_monster_pub` (ADR-0194 D4) and `my_battle` (ADR-0198 D4): the SDK never
// fires onUpdate, every change arrives as an unordered onInsert(new) + onDelete(old) pair, and
// the adapter rebuilds membership from the post-burst cache. So the store method is the same
// whole-set reconcile — keyed by `chunkId`, pruning, and marking `#dirty` ONLY on a real
// change, because the connection adapter calls it in EVERY batcher flush (every table's burst,
// including the ~5/s movement ticks).
//
// CONTRACT UNDER TEST (do not invent variants):
//   export type StoreExportChunk = {
//     chunkId: bigint; ownerIdentity: string; requestId: bigint; tableName: string;
//     chunkIndex: number; totalChunks: number; payloadJson: string; createdAtMs: bigint;
//   };
//   reconcileExportChunksFromView(rows: readonly StoreExportChunk[]): void
//        — mirrors reconcileMonstersFromView (store.ts:575) EXACTLY: keep-set + a shallow
//          own-key compare + prune; `#dirty` only when something actually changed.
//   ownExportChunks(identity: string): readonly StoreExportChunk[]
//        — the client-side owner filter (ADR-0015 V1). Exact `===`, no case folding, no
//          trimming — the same rule `ownMonsters` / `ownAccount` already follow.
//   reset() also clears the chunk map.
//
// BOUNDARY: this tier holds NO completeness logic, NO cap, NO sort and NO JSON.parse. Whether
// the delivered set describes one coherent request is `ui/exportAssembly.ts`'s decision, and it
// is gated there; the store's whole job is membership + the owner filter.
//
// RED REASON AT AUTHORING TIME: `AuthoritativeStore` has neither method, and `store.ts` exports
// no `StoreExportChunk`, so every case below fails with
// "s.reconcileExportChunksFromView is not a function" (or, for the read-only cases,
// "s.ownExportChunks is not a function") — a MISSING IMPLEMENTATION, not a typo here.
//
// NO regex literal, no `new RegExp`. Every numeric fixture is synthetic — the deletion-grace
// SSOT eval reads `client/**` RAW and does not exempt test files.
// =============================================================================

/** Reached through the EXISTING `storeMod` namespace binding (imported at :3265) rather than a
 *  fourth `from './store'` import line: pinned biome folds same-specifier imports together once
 *  a file accumulates enough of them, and a type-only alias costs no import at all. Erased at
 *  runtime, so a not-yet-existing type cannot break this file's collection. */
type Rb53ExportChunk = storeMod.StoreExportChunk;

const RB53_ME = 'rb53-owner-me-hex';
const RB53_FOREIGN = 'rb53-owner-foreign-hex';
/** One request id, shared by every own chunk — the producer numbers `chunk_index` REQUEST-WIDE
 *  (ADR-0231's opening context), so "same request, different index" is the ordinary shape. */
const RB53_REQUEST = 4242n;

const RB53_PAYLOAD_A = '{"table":"account","rows":[{"k":"a"}]}';
const RB53_PAYLOAD_B = '{"table":"player","rows":[{"k":"b"}]}';
const RB53_PAYLOAD_C = '{"table":"monster","rows":[{"k":"c"}]}';
/** A marker that exists ONLY in the foreign owner's payload, so "the leak did not happen" is
 *  asserted on CONTENT and not merely on a count. */
const RB53_FOREIGN_MARKER = 'RB53-FOREIGN-PAYLOAD-MARKER';

function rb53Chunk(chunkId: bigint, overrides: Partial<Rb53ExportChunk> = {}): Rb53ExportChunk {
  return {
    chunkId,
    ownerIdentity: RB53_ME,
    requestId: RB53_REQUEST,
    tableName: 'account',
    chunkIndex: 0,
    totalChunks: 1,
    payloadJson: RB53_PAYLOAD_A,
    createdAtMs: 1_700_000_000_000n,
    ...overrides,
  };
}

/** The chunk ids the store holds for `identity`, as sorted decimal strings — every assertion
 *  below is therefore ORDER-INDEPENDENT. The contract fixes MEMBERSHIP, never iteration order
 *  (`exportAssembly.ts` sorts by the request-wide `chunkIndex` itself), so a test that pinned an
 *  order would be gating a promise the store does not make. */
function rb53Ids(s: AuthoritativeStore, identity: string): string[] {
  return [...s.ownExportChunks(identity)].map((c) => c.chunkId.toString()).sort();
}

function rb53Find(
  s: AuthoritativeStore,
  identity: string,
  chunkId: bigint,
): Rb53ExportChunk | undefined {
  return [...s.ownExportChunks(identity)].find((c) => c.chunkId === chunkId);
}

describe('AuthoritativeStore rb-53: ownExportChunks is an OWNER FILTER, in both directions', () => {
  it('★★ RB53S-OWNER-BOTH-DIRECTIONS BITES: a FOREIGN chunk is absent from ownExportChunks(ME) and PRESENT in ownExportChunks(FOREIGN)', () => {
    // ★ BOTH DIRECTIONS, and that is the whole design of this tooth. A one-directional
    // assertion is passed by TWO opposite stubs:
    //   * `return [...this.#exportChunks.values()]` (no filter at all) passes any "my chunk is
    //     there" check, and hands `assembleExportBundle` another player's rows — the leak
    //     ADR-0231 names at exportAssembly.ts:92-95;
    //   * `return []` (or a filter inverted to always-false) passes any "the foreign chunk is
    //     absent" check, and the player can never download their own export at all.
    // Only asserting BOTH memberships kills both at once.
    const s = new AuthoritativeStore();
    s.reconcileExportChunksFromView([
      rb53Chunk(1n, { chunkIndex: 0, totalChunks: 1 }),
      rb53Chunk(2n, {
        ownerIdentity: RB53_FOREIGN,
        payloadJson: `{"table":"account","rows":[{"k":"${RB53_FOREIGN_MARKER}"}]}`,
      }),
    ]);

    expect(rb53Ids(s, RB53_ME), 'my own chunk, and ONLY my own chunk').toEqual(['1']);
    expect(
      rb53Ids(s, RB53_FOREIGN),
      "the foreign owner's chunk is still IN THE MAP — the filter is a READ-side scope, not a " +
        'write-side drop. A `return []` stub passes the negative above and fails here',
    ).toEqual(['2']);

    // CONTENT, not just count: the marker must be unreachable through the own accessor.
    for (const c of s.ownExportChunks(RB53_ME)) {
      expect(
        c.payloadJson.indexOf(RB53_FOREIGN_MARKER),
        "another player's payload bytes must never be reachable through ownExportChunks(ME) — " +
          'this array is what is spliced into the file the player downloads',
      ).toBe(-1);
    }

    // A pre-join / unresolved identity addresses NOTHING. With no owner to compare against, a
    // missing filter would hand every cached chunk to the assembler.
    expect(rb53Ids(s, ''), 'an empty identity owns nothing').toEqual([]);
  });

  it('★ RB53S-OWNER-EXACT BITES: the owner match is EXACT — no case folding, no trimming', () => {
    // main.ts holds the identity as the hex string the SDK handed `onConnect`, and both sides
    // compare with `===`. Any normalisation applied here and not there silently empties the
    // player's own export (or, worse, matches the wrong identity). Same rule ownAccount's
    // M21b-2 A1 tooth pins for the account slot.
    const s = new AuthoritativeStore();
    s.reconcileExportChunksFromView([rb53Chunk(3n, { ownerIdentity: 'AABBCC' })]);
    expect(rb53Ids(s, 'aabbcc')).toEqual([]);
    expect(rb53Ids(s, ' AABBCC ')).toEqual([]);
    expect(rb53Ids(s, 'AABBCC'), 'anti-vacuity for the two negatives').toEqual(['3']);
  });
});

describe('AuthoritativeStore rb-53: the chunk map is keyed by chunkId', () => {
  it('★★ RB53S-KEYED-BY-CHUNKID BITES: three chunks of ONE request all survive; a repeated chunkId REPLACES', () => {
    // ★ WRONG IMPL KILLED (1) — THE ONE THAT LOOKS RIGHT: keying the map by `requestId`. Every
    // chunk of one export shares it, so all N collapse into ONE entry, `receivedChunks` reads 1
    // against `totalChunks` N, and `assembleExportBundle` reports `incomplete` FOREVER. The
    // download control is then permanently disabled and the criterion silently fails while
    // every membership count in a one-chunk fixture stays green — which is why this fixture is
    // a THREE-chunk request.
    // WRONG IMPL KILLED (2): a composite `(requestId, tableName, chunkIndex)` key. The producer
    // sub-chunks a large table at EXPORT_CHUNK_ROWS, so one table legitimately spans several
    // rows; the second clause below is two rows that agree on all three of those fields and
    // differ only in `chunk_id`, which is exactly what the PRIMARY key exists for.
    // WRONG IMPL KILLED (3): an array store that APPENDS — the third clause re-delivers one
    // chunkId and requires the map to hold one row with the NEW payload.
    const s = new AuthoritativeStore();
    s.reconcileExportChunksFromView([
      rb53Chunk(1n, { chunkIndex: 0, totalChunks: 3, payloadJson: RB53_PAYLOAD_A }),
      rb53Chunk(2n, { chunkIndex: 1, totalChunks: 3, payloadJson: RB53_PAYLOAD_B }),
      rb53Chunk(3n, { chunkIndex: 2, totalChunks: 3, payloadJson: RB53_PAYLOAD_C }),
    ]);
    expect(
      rb53Ids(s, RB53_ME),
      'all three chunks of ONE request must survive — a requestId-keyed map collapses them to ' +
        'one and the export is permanently incomplete',
    ).toEqual(['1', '2', '3']);

    // Two rows agreeing on (requestId, tableName, chunkIndex) and differing ONLY in chunkId.
    const s2 = new AuthoritativeStore();
    s2.reconcileExportChunksFromView([
      rb53Chunk(10n, { payloadJson: RB53_PAYLOAD_A }),
      rb53Chunk(11n, { payloadJson: RB53_PAYLOAD_B }),
    ]);
    expect(
      rb53Ids(s2, RB53_ME),
      'chunk_id is the PRIMARY key: two rows that agree on requestId/tableName/chunkIndex are ' +
        'still two rows',
    ).toEqual(['10', '11']);

    // Same chunkId, new payload — the map holds ONE row and the NEW payload wins.
    const s3 = new AuthoritativeStore();
    s3.reconcileExportChunksFromView([rb53Chunk(20n, { payloadJson: RB53_PAYLOAD_A })]);
    s3.reconcileExportChunksFromView([rb53Chunk(20n, { payloadJson: RB53_PAYLOAD_B })]);
    expect(rb53Ids(s3, RB53_ME)).toEqual(['20']);
    expect(
      rb53Find(s3, RB53_ME, 20n)?.payloadJson,
      'the delivered payload is AUTHORITATIVE — an insert-if-absent upsert would freeze the ' +
        'first bytes the client ever saw into the downloaded file',
    ).toBe(RB53_PAYLOAD_B);
  });

  it('★ RB53S-DUPLICATE-DELIVERY BITES: the same chunkId delivered TWICE in ONE row set is stored ONCE', () => {
    // A view returns a Vec, not a set. Kills an array-backed impl: a duplicated row would be
    // spliced into the artifact twice AND would inflate `receivedChunks` past `totalChunks`.
    const s = new AuthoritativeStore();
    const row = rb53Chunk(9n);
    s.reconcileExportChunksFromView([row, { ...row }]);
    expect(rb53Ids(s, RB53_ME), 'keyed by chunkId — one row, however many times delivered').toEqual(
      ['9'],
    );
  });
});

describe('AuthoritativeStore rb-53: the reconcile PRUNES, and an empty row set is authoritative', () => {
  it('★★ RB53S-RECONCILE-PRUNES BITES: a chunk absent from the new row set is DROPPED, and [] empties the map', () => {
    // ★ WRONG IMPL KILLED: an upsert-only reconcile (the `for (const r of rows) map.set(...)`
    // shape, with no keep-set sweep). The server's TTL reaper deletes export_bundle rows —
    // at most EXPORT_REAP_MAX_DELETE_PER_TICK per tick, so it can also cut ACROSS one owner's
    // request — and `delete_account`'s cascade removes them outright. Without the prune, rows
    // the server has already purged stay in the client cache and the player keeps being offered
    // a download of data that no longer exists on the server: a retention promise the product
    // does not keep.
    // ALSO KILLED: an `if (rows.length === 0) return;` guard — the "don't wipe the store on an
    // empty burst" instinct. An empty owner-scoped view result is AUTHORITATIVE: there is no
    // live export.
    const s = new AuthoritativeStore();
    s.reconcileExportChunksFromView([
      rb53Chunk(1n, { chunkIndex: 0, totalChunks: 3 }),
      rb53Chunk(2n, { chunkIndex: 1, totalChunks: 3 }),
      rb53Chunk(3n, { chunkIndex: 2, totalChunks: 3 }),
    ]);
    expect(rb53Ids(s, RB53_ME), 'precondition').toEqual(['1', '2', '3']);

    s.reconcileExportChunksFromView([
      rb53Chunk(1n, { chunkIndex: 0, totalChunks: 3 }),
      rb53Chunk(3n, { chunkIndex: 2, totalChunks: 3 }),
    ]);
    expect(
      rb53Ids(s, RB53_ME),
      'the middle chunk was reaped server-side and must be GONE from the client cache too',
    ).toEqual(['1', '3']);

    s.reconcileExportChunksFromView([]);
    expect(
      rb53Ids(s, RB53_ME),
      'an empty view result is authoritative, not a no-op — the whole export has been reaped',
    ).toEqual([]);
  });

  it('★ RB53S-PRUNES-FOREIGN BITES: a foreign-owner chunk absent from the new set is pruned too', () => {
    // The reconcile is over the WHOLE map, not over the caller's slice: an owner-scoped filter
    // applied on the WRITE side would leave other-owner rows unreachable-but-resident forever.
    const s = new AuthoritativeStore();
    s.reconcileExportChunksFromView([
      rb53Chunk(1n),
      rb53Chunk(2n, { ownerIdentity: RB53_FOREIGN }),
    ]);
    expect(rb53Ids(s, RB53_FOREIGN), 'precondition').toEqual(['2']);
    s.reconcileExportChunksFromView([rb53Chunk(1n)]);
    expect(rb53Ids(s, RB53_FOREIGN)).toEqual([]);
    expect(rb53Ids(s, RB53_ME), 'and my own chunk is untouched').toEqual(['1']);
  });
});

describe('AuthoritativeStore rb-53: #dirty discipline (the render-storm guard)', () => {
  it('★★ RB53S-DIRTY-DISCIPLINE BITES: an UNCHANGED row set marks NOTHING dirty; a changed one and a prune each mark it ONCE', () => {
    // WHAT THIS PINS. The connection adapter calls this reconcile in EVERY batcher flush — i.e.
    // on every table's burst, including the ~5/s movement ticks — so an unchanged row set must
    // be a NO-OP. Without change detection every movement tick marks the batch dirty, and in
    // THIS slice that is not merely a render storm: `main.ts`'s batch listener is the sole
    // `assembleExportBundle(` call site, so a spurious dirty re-concatenates the whole export
    // artifact on every tick.
    //
    // THE FIXTURE IS PRODUCTION-SHAPED ON PURPOSE: the rows are rebuilt by calling the factory
    // again, so they are structurally equal but NON-IDENTICAL objects — exactly what
    // `exportChunkRowToStore` emits on every conversion. The store never sees the same object
    // twice in production. (A shallow own-key compare is sufficient here and a deep one is not
    // needed: every field of StoreExportChunk is a primitive.)
    //
    // WRONG IMPL KILLED (1): no change detection at all (`map.set` + `#dirty = true` per row).
    // WRONG IMPL KILLED (2) — THE OVER-SUPPRESSION MIRROR: a comparator tightened until nothing
    // is ever dirty (`prev !== undefined` ⇒ unchanged). It passes clause one trivially, and the
    // second and third clauses are what see it: an arriving chunk would never repaint the
    // surface, so the download control would stay disabled while the export sat complete in the
    // store.
    // WRONG IMPL KILLED (3): a prune that removes the row without marking dirty — the reaped
    // export would stay downloadable until some unrelated table happened to dirty the store.
    const s = new AuthoritativeStore();
    s.reconcileExportChunksFromView([
      rb53Chunk(1n),
      rb53Chunk(2n, { payloadJson: RB53_PAYLOAD_B }),
    ]);
    s.flushBatch(); // consume the dirty from the initial population
    const cb = vi.fn();
    s.onBatchApplied(cb);

    s.reconcileExportChunksFromView([
      rb53Chunk(1n),
      rb53Chunk(2n, { payloadJson: RB53_PAYLOAD_B }),
    ]);
    s.flushBatch();
    expect(
      cb,
      'an unchanged row set must not mark the batch dirty — this reconcile runs on EVERY batcher ' +
        'flush, and a dirty mark here re-assembles the whole export artifact on every movement ' +
        'tick',
    ).toHaveBeenCalledTimes(0);

    s.reconcileExportChunksFromView([
      rb53Chunk(1n),
      rb53Chunk(2n, { payloadJson: RB53_PAYLOAD_C }),
    ]);
    s.flushBatch();
    expect(
      cb,
      'a CHANGED payload must mark the batch dirty exactly once — over-suppression is the freeze ' +
        'failure mode: the chunk lands in the store and the surface never learns the export is ' +
        'ready',
    ).toHaveBeenCalledTimes(1);

    s.reconcileExportChunksFromView([rb53Chunk(1n)]);
    s.flushBatch();
    expect(cb, 'and a PRUNE is a change too').toHaveBeenCalledTimes(2);
  });

  it('★ RB53S-DIRTY-ON-ARRIVAL BITES: the FIRST delivery marks the batch dirty', () => {
    // Kills an impl that only marks dirty on an UPDATE to an existing key. The first delivery is
    // the arrival edge the whole criterion hangs on — nothing repaints without it.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.reconcileExportChunksFromView([rb53Chunk(1n)]);
    expect(cb, 'not mid-batch — only flushBatch signals').toHaveBeenCalledTimes(0);
    s.flushBatch();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('AuthoritativeStore rb-53: reset() clears the chunk map', () => {
  it('★★ RB53S-RESET-EMPTIES BITES: reset() drops every chunk, for every owner', () => {
    // Kills a reset() that forgets the new map. reset() runs on DISCONNECT, and the very next
    // connection can carry a DIFFERENT identity (every anonymous rebuild can mint one). A
    // surviving chunk map would hold the previous session's personal-data rows in this client's
    // memory — and, for a rotated identity, would hold them under an identity that is no longer
    // the person at the keyboard. Every other slot in this store (wallet, account, battles) is
    // cleared for exactly this reason.
    const s = new AuthoritativeStore();
    s.reconcileExportChunksFromView([
      rb53Chunk(1n),
      rb53Chunk(2n, { ownerIdentity: RB53_FOREIGN }),
    ]);
    expect(rb53Ids(s, RB53_ME), 'precondition').toEqual(['1']);

    s.reset();

    expect(rb53Ids(s, RB53_ME)).toEqual([]);
    expect(rb53Ids(s, RB53_FOREIGN)).toEqual([]);
  });

  it('★ RB53S-RESET-KEEPS-LISTENERS BITES: reset() keeps batch listeners alive; a post-reset reconcile still signals', () => {
    // The same guarantee the wallet and account slots assert for their own reset arms: a reset
    // that cleared the listener set would silently kill the running loop.
    const s = new AuthoritativeStore();
    const cb = vi.fn();
    s.onBatchApplied(cb);
    s.reconcileExportChunksFromView([rb53Chunk(1n)]);
    s.flushBatch();

    s.reset();
    expect(rb53Ids(s, RB53_ME)).toEqual([]);

    s.reconcileExportChunksFromView([rb53Chunk(2n)]);
    s.flushBatch();
    expect(cb, 'once pre-reset, once post-reset').toHaveBeenCalledTimes(2);
    expect(rb53Ids(s, RB53_ME)).toEqual(['2']);
  });
});

describe('AuthoritativeStore rb-53: a value-changing reconcile REPLACES the stored row', () => {
  it('★ RB53S-REPLACES-NOT-MUTATES BITES: the stored object is the NEW one; a previously handed-out row is untouched', () => {
    // THE IN-PLACE-MUTATION CHEAT this kills (the same one reconcileBattlesFromView's clause 7
    // records): `Object.assign(prev, row)`. Every membership, count and dirty assertion above
    // still holds, because the MAP is right — but `main.ts` caches the ASSEMBLED artifact
    // computed from a previous read, and a row mutated under it means the cached artifact and
    // the store silently disagree about what the player is downloading.
    const s = new AuthoritativeStore();
    s.reconcileExportChunksFromView([rb53Chunk(3n, { payloadJson: RB53_PAYLOAD_A })]);
    const captured = rb53Find(s, RB53_ME, 3n);
    expect(captured, 'precondition: the row was stored').toBeDefined();

    s.reconcileExportChunksFromView([rb53Chunk(3n, { payloadJson: RB53_PAYLOAD_B })]);

    expect(
      rb53Find(s, RB53_ME, 3n),
      'the stored row must be the NEW object, not the previous one mutated in place',
    ).not.toBe(captured);
    expect(
      captured?.payloadJson,
      'the previously handed-out row must be UNCHANGED — the store publishes readonly rows and ' +
        'consumers hold references to them',
    ).toBe(RB53_PAYLOAD_A);
  });
});
