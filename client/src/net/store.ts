// net/store.ts — the AuthoritativeStore (M4a, ADR-0013/0014).
//
// A READ-ONLY mirror of SpacetimeDB subscription truth. Written ONLY by the
// connection adapter's reducer/row callbacks (which convert SDK rows to these
// normalized shapes first); never by the renderer or the predictor (one-way data
// flow — `server -> store -> render`). Keyed Maps make a reconnect re-insert
// idempotent (overwrite, never the v1 array-store duplication). Each character
// records `receivedAt` + the last TWO authoritative snapshots so the M4b remote
// interpolation buffer can render between them. A per-transaction **batch-applied**
// signal (`flushBatch`) lets the loop reconcile once on a coherent snapshot rather
// than mid-update (the rubberband race) — the live SDK exposes only per-row
// callbacks, so the adapter coalesces them within a microtask and calls
// `flushBatch` once per transaction burst (validation-findings: per-tx fallback).
import type { WasmAction, WasmDirection, WasmMoveInput } from '../convert/convert';

/** A character row, normalized at the SDK boundary (ids `bigint`, enums as strings). */
export interface StoreCharacter {
  readonly entityId: bigint;
  readonly zoneId: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly facing: WasmDirection;
  readonly action: WasmAction;
  readonly moveStartedAtMs: bigint;
  readonly moveQueue: readonly WasmMoveInput[];
}

/** A player row, normalized (identity as its hex key string). */
export interface StorePlayer {
  readonly identity: string;
  readonly entityId: bigint;
  readonly name: string;
  readonly online: boolean;
  readonly lastInputSeq: bigint;
}

// NOTE: StoreMonsterPub is a `type` alias (not `interface`) — store.test.ts and
// rowConvert.test.ts probe fields via `as Record<string, unknown>`, which TS only
// permits for object-literal types (an interface lacks the implicit index-signature
// overlap). Same pattern as StoreInventory/StoreItemRow (M9c comment below).
/** A monster public projection row, normalized (no hidden IVs/EVs/nature — ADR-0015). */
export type StoreMonsterPub = {
  readonly monsterId: bigint;
  readonly ownerIdentity: string;
  readonly speciesId: number;
  readonly nickname: string;
  readonly level: number;
  readonly xp: number;
  readonly bond: number;
  readonly currentHp: number;
  readonly statHp: number;
  readonly statAttack: number;
  readonly statDefense: number;
  readonly statSpeed: number;
  readonly statSpAttack: number;
  readonly statSpDefense: number;
  readonly partySlot: number;
  /** Server-computed evolution target species id (M10c, ADR-0019). Undefined = not eligible. */
  readonly evolvesTo?: number;
};

/** A fusion recipe row (public content — M10c, ADR-0019). */
export interface StoreFusionRow {
  readonly fusionId: bigint;
  readonly aSpecies: number;
  readonly bSpecies: number;
  readonly toSpecies: number;
}

/** A skill definition row, normalized (affinity as bare string). */
export interface StoreSkillRow {
  readonly id: number;
  readonly name: string;
  readonly affinity: string;
  readonly power: number;
  readonly accuracy: number;
  readonly pp: number;
}

/** A monster projected into battle — flat stats, normalized affinity. */
export interface StoreBattleMonster {
  readonly speciesId: number;
  readonly affinity: string;
  readonly level: number;
  readonly currentHp: number;
  readonly maxHp: number;
  readonly statHp: number;
  readonly statAttack: number;
  readonly statDefense: number;
  readonly statSpeed: number;
  readonly statSpAttack: number;
  readonly statSpDefense: number;
  readonly knownSkillIds: readonly number[];
}

/** One side of the battle: the active slot index and the team roster. */
export interface StoreBattleSide {
  readonly active: number;
  readonly team: readonly StoreBattleMonster[];
}

/** A battle row, normalized (identities as hex strings, outcome as bare string). */
export interface StoreBattle {
  readonly battleId: bigint;
  readonly playerIdentity: string;
  readonly opponentIdentity: string;
  readonly outcome: string;
  readonly turnNumber: number;
  readonly sideA: StoreBattleSide;
  readonly sideB: StoreBattleSide;
  readonly partyMonsterIds: readonly bigint[];
  readonly opponentMonsterIds: readonly bigint[];
  readonly createdAtMs: bigint;
}

// NOTE: these two are `type` aliases (not `interface`s) on purpose — store.test.ts
// S8 single-casts a StoreInventory to `Record<string, unknown>` to probe snapshot
// isolation, which TS only permits for an object-literal type (an interface lacks
// the implicit index-signature overlap). Same fields, drop-in for a consumer.
/** An inventory row, normalized (identity as its hex key string; M9c). */
export type StoreInventory = {
  readonly invId: bigint;
  readonly ownerIdentity: string;
  readonly itemId: number;
  readonly count: number;
};

/** An item definition row, normalized (trainStat as bare string or null; M9c). */
export type StoreItemRow = {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly recruitBonus: number;
  readonly trainStat: string | null;
  readonly trainAmount: number;
};

/** A species row, normalized (affinity as bare string). */
export interface StoreSpeciesRow {
  readonly id: number;
  readonly name: string;
  readonly baseHp: number;
  readonly baseAttack: number;
  readonly baseDefense: number;
  readonly baseSpeed: number;
  readonly baseSpAttack: number;
  readonly baseSpDefense: number;
  readonly affinity: string;
  readonly learnableSkillIds: readonly number[];
}

/** A positional snapshot stamped with local receive time (remote interpolation). */
export interface Snapshot {
  readonly tileX: number;
  readonly tileY: number;
  readonly receivedAt: number; // performance.now()
}

export interface StoredCharacter {
  readonly row: StoreCharacter;
  readonly receivedAt: number;
  /** Newest authoritative snapshot. */
  readonly latest: Snapshot;
  /** Second-newest snapshot (the interpolation lower bound); undefined on first sight. */
  readonly prev: Snapshot | undefined;
}

export class AuthoritativeStore {
  readonly #chars = new Map<bigint, StoredCharacter>();
  readonly #players = new Map<string, StorePlayer>();
  readonly #monsters = new Map<bigint, StoreMonsterPub>();
  readonly #species = new Map<number, StoreSpeciesRow>();
  readonly #battles = new Map<bigint, StoreBattle>();
  readonly #skills = new Map<number, StoreSkillRow>();
  readonly #inventory = new Map<bigint, StoreInventory>();
  readonly #itemDefs = new Map<number, StoreItemRow>();
  readonly #fusions = new Map<bigint, StoreFusionRow>();
  readonly #batchListeners = new Set<() => void>();
  #dirty = false;

  // --- ingest (adapter-only; truth in) ------------------------------------------

  upsertCharacter(row: StoreCharacter, now: number): void {
    const existing = this.#chars.get(row.entityId);
    const latest: Snapshot = { tileX: row.tileX, tileY: row.tileY, receivedAt: now };
    this.#chars.set(row.entityId, { row, receivedAt: now, latest, prev: existing?.latest });
    this.#dirty = true;
  }

  removeCharacter(entityId: bigint): void {
    if (this.#chars.delete(entityId)) this.#dirty = true;
  }

  upsertPlayer(p: StorePlayer): void {
    this.#players.set(p.identity, p);
    this.#dirty = true;
  }

  removePlayer(identity: string): void {
    if (this.#players.delete(identity)) this.#dirty = true;
  }

  upsertMonster(m: StoreMonsterPub): void {
    this.#monsters.set(m.monsterId, m);
    this.#dirty = true;
  }

  removeMonster(monsterId: bigint): void {
    if (this.#monsters.delete(monsterId)) this.#dirty = true;
  }

  upsertSpecies(s: StoreSpeciesRow): void {
    this.#species.set(s.id, s);
    this.#dirty = true;
  }

  removeSpecies(id: number): void {
    if (this.#species.delete(id)) this.#dirty = true;
  }

  upsertBattle(b: StoreBattle): void {
    this.#battles.set(b.battleId, b);
    this.#dirty = true;
  }

  removeBattle(battleId: bigint): void {
    if (this.#battles.delete(battleId)) this.#dirty = true;
  }

  upsertSkill(s: StoreSkillRow): void {
    this.#skills.set(s.id, s);
    this.#dirty = true;
  }

  removeSkill(id: number): void {
    if (this.#skills.delete(id)) this.#dirty = true;
  }

  upsertInventory(i: StoreInventory): void {
    this.#inventory.set(i.invId, i);
    this.#dirty = true;
  }

  removeInventory(invId: bigint): void {
    if (this.#inventory.delete(invId)) this.#dirty = true;
  }

  upsertItemDef(d: StoreItemRow): void {
    this.#itemDefs.set(d.id, d);
    this.#dirty = true;
  }

  removeItemDef(id: number): void {
    if (this.#itemDefs.delete(id)) this.#dirty = true;
  }

  upsertFusion(f: StoreFusionRow): void {
    this.#fusions.set(f.fusionId, f);
    this.#dirty = true;
  }

  removeFusion(fusionId: bigint): void {
    if (this.#fusions.delete(fusionId)) this.#dirty = true;
  }

  /** Emit ONE batch-applied signal iff something changed since the last flush.
   *  Called once per coalesced transaction burst by the connection adapter. */
  flushBatch(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    for (const cb of [...this.#batchListeners]) cb();
  }

  onBatchApplied(cb: () => void): () => void {
    this.#batchListeners.add(cb);
    return () => {
      this.#batchListeners.delete(cb);
    };
  }

  /** Reconnect clean re-init: drop all stale rows (never merge), keep listeners so
   *  the running loop survives the reconnect. The predictor is reset separately. */
  reset(): void {
    this.#chars.clear();
    this.#players.clear();
    this.#monsters.clear();
    this.#species.clear();
    this.#battles.clear();
    this.#skills.clear();
    this.#inventory.clear();
    this.#itemDefs.clear();
    this.#fusions.clear();
    this.#dirty = false;
  }

  // --- read (render / loop / reconcile read truth here; never write) -------------

  character(entityId: bigint): StoredCharacter | undefined {
    return this.#chars.get(entityId);
  }

  characters(): IterableIterator<StoredCharacter> {
    return this.#chars.values();
  }

  player(identity: string): StorePlayer | undefined {
    return this.#players.get(identity);
  }

  /** Own-character identification: identity -> player row -> entity_id. */
  ownEntityId(identity: string): bigint | undefined {
    return this.#players.get(identity)?.entityId;
  }

  ownCharacter(identity: string): StoredCharacter | undefined {
    const eid = this.ownEntityId(identity);
    return eid === undefined ? undefined : this.#chars.get(eid);
  }

  get characterCount(): number {
    return this.#chars.size;
  }

  // --- monster + species read (M6c box/party view reads truth here) ----------

  monster(monsterId: bigint): StoreMonsterPub | undefined {
    return this.#monsters.get(monsterId);
  }

  monsters(): IterableIterator<StoreMonsterPub> {
    return this.#monsters.values();
  }

  ownMonsters(identity: string): StoreMonsterPub[] {
    const out: StoreMonsterPub[] = [];
    for (const m of this.#monsters.values()) {
      if (m.ownerIdentity === identity) out.push(m);
    }
    return out;
  }

  species(id: number): StoreSpeciesRow | undefined {
    return this.#species.get(id);
  }

  /** A defensive snapshot copy — a caller mutating it cannot corrupt the store
   *  (upholds the one-way `server -> store -> render` flow). */
  speciesMap(): ReadonlyMap<number, StoreSpeciesRow> {
    return new Map(this.#species);
  }

  get monsterCount(): number {
    return this.#monsters.size;
  }

  // --- battle + skill read (M7c battle view reads truth here) ----------------

  battle(battleId: bigint): StoreBattle | undefined {
    return this.#battles.get(battleId);
  }

  /** The player's own ongoing battle (ADR-0042: public table, client-side filter). */
  ongoingBattle(identity: string): StoreBattle | undefined {
    for (const b of this.#battles.values()) {
      if (b.playerIdentity === identity && b.outcome === 'Ongoing') return b;
    }
    return undefined;
  }

  /** The player's most-recent battle of ANY outcome (highest battleId among
   *  playerIdentity === identity). Highest battleId = most recent (server auto-inc,
   *  monotonic; single current battle per player). Feeds the outcome-frame lifecycle;
   *  ongoingBattle() (Ongoing-only) is unchanged. (M8.7e, ADR-0014/0042.) */
  latestPlayerBattle(identity: string): StoreBattle | undefined {
    let best: StoreBattle | undefined;
    for (const b of this.#battles.values()) {
      if (b.playerIdentity !== identity) continue;
      // bigint `>` (never Number()/Math.max — ids exceed 2^53; T1d).
      if (best === undefined || b.battleId > best.battleId) best = b;
    }
    return best;
  }

  skill(id: number): StoreSkillRow | undefined {
    return this.#skills.get(id);
  }

  /** A defensive snapshot copy — a caller mutating it cannot corrupt the store
   *  (upholds the one-way `server -> store -> render` flow). */
  skillMap(): ReadonlyMap<number, StoreSkillRow> {
    return new Map(this.#skills);
  }

  // --- inventory + itemDef read (M9c raising/inventory view reads truth here) ----

  /** The player's own inventory (ADR-0015/0046 V1: public table, client-side owner
   *  filter). A FRESH array of FRESH row copies — a caller mutating the array OR a
   *  returned row's field cannot corrupt the store (one-way `server -> store ->
   *  render` flow; store.test.ts S8 deep-isolation). There is deliberately NO
   *  unfiltered `inventories()` accessor. */
  ownInventory(identity: string): StoreInventory[] {
    const out: StoreInventory[] = [];
    for (const i of this.#inventory.values()) {
      if (i.ownerIdentity === identity) out.push({ ...i });
    }
    return out;
  }

  itemDef(id: number): StoreItemRow | undefined {
    return this.#itemDefs.get(id);
  }

  /** A fresh Map of the item defs — adding/removing entries on the returned map
   *  cannot corrupt the store (same structure-copy contract as `speciesMap()` /
   *  `skillMap()`; upholds the one-way `server -> store -> render` flow). The row
   *  VALUES are shared by reference and `readonly`; consumers only read them. */
  itemDefs(): ReadonlyMap<number, StoreItemRow> {
    return new Map(this.#itemDefs);
  }

  // --- fusion read (M10c evolution view reads truth here) ----------------------

  fusions(): IterableIterator<StoreFusionRow> {
    return this.#fusions.values();
  }

  get fusionCount(): number {
    return this.#fusions.size;
  }
}
