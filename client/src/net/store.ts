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

/** A monster public projection row, normalized (no hidden IVs/EVs/nature — ADR-0015). */
export interface StoreMonsterPub {
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
}

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

  speciesMap(): ReadonlyMap<number, StoreSpeciesRow> {
    return this.#species;
  }

  get monsterCount(): number {
    return this.#monsters.size;
  }
}
