// net/store.ts — the AuthoritativeStore (M4a, ADR-0013/0014).
//
// A READ-ONLY mirror of SpacetimeDB subscription truth. Written ONLY by the
// connection adapter's reducer/row callbacks (which convert SDK rows to these
// normalized shapes first); never by the renderer or the predictor (one-way data
// flow — `server -> store -> render`). Keyed Maps make a reconnect re-insert
// idempotent (overwrite, never the v1 array-store duplication). Each character
// records `receivedAt` + up to INTERP_MAX_DEPTH=4 authoritative snapshots (ADR-0090)
// so the M4b remote interpolation buffer can render between them. A per-transaction
// **batch-applied** signal (`flushBatch`) lets the loop reconcile once on a coherent
// snapshot rather than mid-update (the rubberband race) — the live SDK exposes only
// per-row callbacks, so the adapter coalesces them within a microtask and calls
// `flushBatch` once per transaction burst (validation-findings: per-tx fallback).
import type { WasmAction, WasmDirection, WasmMoveInput } from '../convert/convert';
import { BURST_EPSILON_MS, INTERP_JITTER_ALPHA, INTERP_MAX_DEPTH } from '../shared/interpConfig';

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

// NOTE: StoreFusionRow is a `type` alias (not `interface`) for consistency with the
// other store row types (StoreMonsterPub, StoreInventory, StoreItemRow).
/** A fusion recipe row (public content — M10c, ADR-0019). */
export type StoreFusionRow = {
  readonly fusionId: bigint;
  readonly aSpecies: number;
  readonly bSpecies: number;
  readonly toSpecies: number;
};

/** A skill definition row, normalized (affinity as bare string). */
export interface StoreSkillRow {
  readonly id: number;
  readonly name: string;
  readonly affinity: string;
  readonly power: number;
  readonly accuracy: number;
  readonly pp: number;
}

/** Status condition display shape: tag is the variant name (e.g. "Poison"),
 *  turnsRemaining is only present for Sleep (m14e, ADR-0096). */
export interface StoreStatusEffect {
  readonly tag: string;
  readonly turnsRemaining?: number;
}

/** Active weather effect shape: tag is the WeatherEffect variant name (e.g. "Rain"),
 *  turnsRemaining is the remaining turn count (m14d weather + m14.5d threading). */
export interface StoreWeather {
  readonly tag: string;
  readonly turnsRemaining: number;
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
  readonly status: StoreStatusEffect | null;
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
  /** Active weather effect (m14d weather; m14.5d threading). null = no active weather. */
  readonly weather: StoreWeather | null;
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

/** An item definition row, normalized (trainStat as bare string or null; M9c/M13d). */
export type StoreItemRow = {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly recruitBonus: number;
  readonly trainStat: string | null;
  readonly trainAmount: number;
  /** Server-set sell price in currency units (M13b). 0 = not sellable. */
  readonly sellPrice: bigint;
  /** StatusKind variant name cured by this item in battle, or null (m14.5d-1a, ADR-0105). */
  readonly cureStatus: string | null;
};

/** A shop definition row (public content; M13b/M13d). */
export type StoreShopRow = {
  readonly shopId: number;
  readonly name: string;
};

/** A shop stock entry row (public content; M13b/M13d). */
export type StoreShopItemRow = {
  readonly shopItemId: bigint;
  readonly shopId: number;
  readonly itemId: number;
  readonly buyPrice: bigint;
};

/** A player conversation row, normalized (ownerIdentity as hex string; M12d). */
export type StorePlayerConversation = {
  readonly ownerIdentity: string;
  readonly npcEntityId: bigint;
  readonly currentNodeId: string;
};

/** The caller's own wallet row, normalized (ownerIdentity as hex string; ux2/ADR-0154).
 *  Sourced from the owner-scoped `my_wallet` view — never a whole-table subscription. */
export type StoreWallet = {
  readonly ownerIdentity: string;
  readonly balance: bigint;
};

/** A player quest row, normalized (ownerIdentity as hex string; M12d). */
export type StorePlayerQuest = {
  readonly pqId: bigint;
  readonly ownerIdentity: string;
  readonly questId: string;
  readonly stepIndex: number;
};

/** A heal location row (public content; M12d). */
export type StoreHealLocationRow = {
  readonly locationId: number;
  readonly zoneId: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly costItemId?: number;
  readonly costQty: number;
  readonly cooldownMs: number;
};

/** An NPC row, normalized (entityId as bigint; M12d). */
export type StoreNpcRow = {
  readonly entityId: bigint;
  readonly npcId: string;
  readonly zoneId: number;
  readonly homeX: number;
  readonly homeY: number;
  readonly wanderRadius: number;
  readonly dialogueTreeId: string;
  /** uxd2 (ADR-0161 D1): the normalized NpcInteraction discriminated union.
   *  Total at the boundary (rowConvert AC-16): unknown/malformed SDK payloads
   *  arrive here already degraded to `{ kind: 'dialogue' }`. */
  readonly interaction:
    | { readonly kind: 'dialogue' }
    | { readonly kind: 'shop'; readonly shopId: number }
    | { readonly kind: 'heal'; readonly locationId: number };
};

/** A monster card snapshot (public display fields only — no genes, per ADR-0015). */
export type StoreMonsterCard = {
  readonly monsterId: bigint;
  readonly speciesId: number;
  readonly nickname: string;
  readonly level: number;
  readonly currentHp: number;
  readonly statHp: number;
};

/** A trade item line (item_id + quantity to trade). */
export type StoreTradeItem = {
  readonly itemId: number;
  readonly qty: number;
};

/** A battle challenge row, normalized (identities as hex strings; m16b). */
export type StoreBattleChallenge = {
  readonly challengeId: bigint;
  readonly challenger: string;
  readonly target: string;
  readonly challengerPartyIds: readonly bigint[];
  /** 'Pending' | 'Accepted' | 'Declined' | 'Cancelled' */
  readonly status: string;
  readonly createdAtMs: bigint;
};

/** A trade offer row, normalized (identities as hex strings; m15b). */
export type StoreTradeOffer = {
  readonly tradeId: bigint;
  readonly initiator: string;
  readonly counterparty: string;
  readonly initiatorMonsterIds: readonly bigint[];
  readonly initiatorItems: readonly StoreTradeItem[];
  readonly initiatorCurrency: bigint;
  readonly counterpartyMonsterIds: readonly bigint[];
  readonly counterpartyItems: readonly StoreTradeItem[];
  readonly counterpartyCurrency: bigint;
  readonly initiatorCards: readonly StoreMonsterCard[];
  readonly counterpartyCards: readonly StoreMonsterCard[];
  readonly status: 'Pending' | 'ConfirmedByCounterparty';
  readonly createdAtMs: bigint;
};

// NOTE: StoreProfile is a `type` alias (not `interface`) — the m17b tests probe
// fields via `as Record<string, unknown>`, which TS only permits for object-literal
// types (same pattern as StoreMonsterPub/StoreInventory above).
/** A ranked profile row, normalized (identity as its hex key string; m17b, ADR-0119). */
export type StoreProfile = {
  readonly identity: string;
  readonly name: string;
  readonly rating: number;
  readonly wins: number;
  readonly losses: number;
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
  /** Newest authoritative snapshot. Alias for snapshots[last]. */
  readonly latest: Snapshot;
  /** Second-newest snapshot; undefined on first sight. Alias for snapshots[last-1].
   *  Kept for backward compat with RenderResolver (which falls back to interpolate
   *  when snapshots is absent) and existing test fixtures. */
  readonly prev: Snapshot | undefined;
  /** Ordered oldest-first; newest = latest; length ≤ INTERP_MAX_DEPTH (ADR-0090).
   *  Deeper than the former 2-snapshot cap to keep the pre-burst snapshot alive
   *  for interpolateHistory to bracket against during burst delivery. */
  readonly snapshots: readonly Snapshot[];
  /** EWMA of inter-arrival deviation from STEP_MS (ms); 0 = smooth/no history.
   *  Fed to adaptiveInterpDelayMs in RenderResolver (ADR-0090). */
  readonly jitterEwma: number;
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
  // M12d: dialogue / quest / heal / npc maps
  readonly #conversations = new Map<string, StorePlayerConversation>();
  readonly #quests = new Map<bigint, StorePlayerQuest>();
  readonly #healLocations = new Map<number, StoreHealLocationRow>();
  readonly #npcs = new Map<bigint, StoreNpcRow>();
  readonly #npcsByNpcId = new Map<string, StoreNpcRow>();
  // M13d: shop content tables
  readonly #shops = new Map<number, StoreShopRow>();
  readonly #shopItems = new Map<bigint, StoreShopItemRow>();
  // m16b: battle_challenge rows (public table — challenger + target subscribe)
  readonly #challenges = new Map<bigint, StoreBattleChallenge>();
  // m15b: trade_offer rows (public table — both parties subscribe)
  readonly #tradeOffers = new Map<bigint, StoreTradeOffer>();
  // m17b: profile rows keyed by identity hex (public table — world-readable
  // leaderboard). Deliberately NO removeProfile: profile rows are never deleted
  // server-side (RL-2, ADR-0119 D1), so a remove path would be unreachable dead code.
  readonly #profiles = new Map<string, StoreProfile>();
  // ux2: the caller's own wallet row (ADR-0154). A SLOT, not a Map: the
  // `my_wallet` view returns exactly one row — the caller's — so a keyed map
  // would make another player's balance representable in the client cache.
  // Deliberately NO removeWallet: wallet rows are never deleted server-side, so
  // a view onDelete can only ever be the old half of an update pair.
  #ownWallet: StoreWallet | undefined;
  readonly #batchListeners = new Set<() => void>();
  #dirty = false;
  /** Nominal server step interval (ms), used for burst detection + jitter EWMA.
   *  0 = disabled (tests that don't need adaptive behavior; backward compat). */
  readonly #stepMs: number;

  /**
   * @param stepMs - Server tick interval from wasm `step_ms()` export. When 0
   *   (default), burst detection and jitter estimation are disabled — existing
   *   tests that construct `new AuthoritativeStore()` are unaffected. */
  constructor(stepMs = 0) {
    this.#stepMs = stepMs;
  }

  // --- ingest (adapter-only; truth in) ------------------------------------------

  upsertCharacter(row: StoreCharacter, now: number): void {
    const existing = this.#chars.get(row.entityId);

    // Snap (drop prev) on zone change or large tile delta (M12.5d-2): interpolating
    // across a zone transition or a >1-tile jump smears the sprite through walls.
    const shouldSnap =
      existing !== undefined &&
      (row.zoneId !== existing.row.zoneId ||
        Math.abs(row.tileX - existing.row.tileX) > 1 ||
        Math.abs(row.tileY - existing.row.tileY) > 1);

    // ADR-0090 burst detection: when two snapshots for the same entity arrive
    // within BURST_EPSILON_MS of each other (same WebSocket flush), attempt to
    // assign a synthetic receivedAt one nominal step after the existing latest.
    // WHY: burst co-arrivals can share the same receivedAt millisecond, collapsing
    // the interpolation span to zero → instant position pop. A synthetic timestamp
    // spreads them temporally so interpolateHistory can bracket between them.
    // NOTE: the B-2 guard below prevents synthetic when stepMs >> BURST_EPSILON_MS
    // (typical production tick rates). In that case both snapshots keep their real
    // wall-clock receivedAt values, which are close-but-distinct (differ by the true
    // burst gap, typically < BURST_EPSILON_MS=20ms). The ring buffer's depth-4 history
    // handles this via its oldest pre-burst snapshot; the span≤0 guard in
    // interpolateHistory covers the rare true-zero-span case.
    let receivedAt = now;
    if (
      this.#stepMs > 0 &&
      existing !== undefined &&
      !shouldSnap &&
      now - existing.latest.receivedAt < BURST_EPSILON_MS
    ) {
      const synthetic = existing.latest.receivedAt + this.#stepMs;
      // B-2 guard: synthetic must stay within BURST_EPSILON_MS of wall-clock now.
      // WHY: if existing.latest.receivedAt is itself a chained synthetic far in the
      // future, an uncapped synthetic would push further ahead, breaking the ring-buffer
      // ordering invariant — the next genuine arrival (at wall-clock now) would land
      // BEFORE the over-extended synthetic, producing an unsorted ring that confuses
      // interpolateHistory. Trade-off: for large stepMs this guard prevents synthetic
      // entirely, which is acceptable (see NOTE above).
      //
      // ptc5f reachability pin (ADR-0090 amendment / ADR-0142 D3): this synthetic
      // assignment fires ONLY when `stepMs < 2*BURST_EPSILON_MS` (= 40 ms). Proof:
      // the outer guard forces `d = now - existing.latest.receivedAt < BURST_EPSILON_MS`,
      // and this inner guard is `existing.latest.receivedAt + stepMs <= now + BURST_EPSILON_MS`
      // ⟺ `stepMs <= BURST_EPSILON_MS + d < 2*BURST_EPSILON_MS`. At the production
      // STEP_MS=200 the branch is UNREACHABLE (burst smoothness is carried by the
      // depth-4 ring buffer). store.test.ts pins this + BITES below the bound.
      if (synthetic <= now + BURST_EPSILON_MS) {
        receivedAt = synthetic;
      }
    }

    const latest: Snapshot = { tileX: row.tileX, tileY: row.tileY, receivedAt };

    // Build the snapshot ring buffer (oldest-first, max INTERP_MAX_DEPTH).
    // WHY: keeping more than 2 snapshots preserves the genuine pre-burst snapshot
    // so interpolateHistory has a real anchor when the render window is widened.
    let newSnapshots: readonly Snapshot[];
    if (existing === undefined || shouldSnap) {
      newSnapshots = [latest];
    } else {
      const base =
        existing.snapshots.length >= INTERP_MAX_DEPTH
          ? existing.snapshots.slice(1) // evict oldest to make room
          : existing.snapshots;
      newSnapshots = [...base, latest];
    }

    // Update jitter EWMA (ADR-0090).
    // WHY: the estimate informs adaptiveInterpDelayMs in RenderResolver, which widens
    // the render window during bursty delivery so the pre-burst snapshot is bracketed.
    let newJitter = existing?.jitterEwma ?? 0;
    if (this.#stepMs > 0 && existing !== undefined && !shouldSnap) {
      // Use wall-clock now (not synthetic receivedAt) for the true interval measure.
      const interval = now - existing.receivedAt;
      const deviation = Math.abs(interval - this.#stepMs);
      newJitter = INTERP_JITTER_ALPHA * deviation + (1 - INTERP_JITTER_ALPHA) * newJitter;
    }

    this.#chars.set(row.entityId, {
      row,
      receivedAt: now, // always real wall-clock time (jitter base for the NEXT update)
      latest,
      prev: newSnapshots.length >= 2 ? newSnapshots[newSnapshots.length - 2] : undefined,
      snapshots: newSnapshots,
      jitterEwma: newJitter,
    });
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

  // --- M12d: conversation / quest / heal / npc ingest --------------------------

  upsertConversation(row: StorePlayerConversation): void {
    this.#conversations.set(row.ownerIdentity, row);
    this.#dirty = true;
  }

  removeConversation(ownerIdentity: string): void {
    if (this.#conversations.delete(ownerIdentity)) this.#dirty = true;
  }

  upsertQuest(row: StorePlayerQuest): void {
    this.#quests.set(row.pqId, row);
    this.#dirty = true;
  }

  removeQuest(pqId: bigint): void {
    if (this.#quests.delete(pqId)) this.#dirty = true;
  }

  upsertHealLocation(row: StoreHealLocationRow): void {
    this.#healLocations.set(row.locationId, row);
    this.#dirty = true;
  }

  removeHealLocation(locationId: number): void {
    if (this.#healLocations.delete(locationId)) this.#dirty = true;
  }

  /** Upsert an NPC row into both the primary map (keyed by entityId) and the secondary
   *  npcId index. CRITICAL: purge the OLD npcId from the secondary index first if the
   *  entityId already exists (handles re-upsert where npcId changes). */
  upsertNpc(row: StoreNpcRow): void {
    const existing = this.#npcs.get(row.entityId);
    if (existing !== undefined && existing.npcId !== row.npcId) {
      this.#npcsByNpcId.delete(existing.npcId);
    }
    this.#npcs.set(row.entityId, row);
    this.#npcsByNpcId.set(row.npcId, row);
    this.#dirty = true;
  }

  removeNpc(entityId: bigint): void {
    const existing = this.#npcs.get(entityId);
    if (existing !== undefined) {
      this.#npcsByNpcId.delete(existing.npcId);
      this.#npcs.delete(entityId);
      this.#dirty = true;
    }
  }

  /** Emit ONE batch-applied signal iff something changed since the last flush.
   *  Called once per coalesced transaction burst by the connection adapter. */
  flushBatch(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    // M10.5d: per-listener try/catch (closes M8.8e residual). A throwing listener
    // is caught+logged and the loop continues, so one bad listener cannot starve
    // siblings (e.g. a crashing dialogueView listener must not freeze the renderer).
    for (const cb of [...this.#batchListeners]) {
      try {
        cb();
      } catch (err) {
        console.error('AuthoritativeStore.flushBatch: batch listener threw (continuing)', err);
      }
    }
  }

  onBatchApplied(cb: () => void): () => void {
    this.#batchListeners.add(cb);
    return () => {
      this.#batchListeners.delete(cb);
    };
  }

  /** Zone-warp character flush: drop ONLY the character map so remote positions
   *  from the old zone are never interpolated in the new zone. All other tables
   *  (players, monsters, species, battles, skills, inventory, itemDefs, fusions)
   *  are untouched — they survive the zone transition. (M11c, ADR-0067 Option C) */
  resetCharacters(): void {
    if (this.#chars.size === 0) return; // no-op → no dirty mark (no phantom re-render)
    this.#chars.clear();
    this.#dirty = true;
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
    // M12d: clear the 5 new maps
    this.#conversations.clear();
    this.#quests.clear();
    this.#healLocations.clear();
    this.#npcs.clear();
    this.#npcsByNpcId.clear();
    // M13d: shop content maps — cleared on disconnect; repopulated from the
    // initial onInsert burst when the subscription re-applies on reconnect.
    this.#shops.clear();
    this.#shopItems.clear();
    // m15b: trade_offer rows — cleared on disconnect; no escrow survives a drop
    // (on_disconnect deletes the player's active offer server-side per TR-18).
    this.#tradeOffers.clear();
    // m16b: battle_challenge rows — cleared on disconnect; server cancels/declines
    // pending challenges via on_disconnect hooks (pvp.rs cancel_challenges_on_disconnect).
    this.#challenges.clear();
    // m17b: profile rows — cleared on disconnect; repopulated from the initial
    // onInsert burst when the subscription re-applies on reconnect.
    this.#profiles.clear();
    // ux2: own-wallet slot — cleared on disconnect so a previous identity's balance
    // can never be surfaced to the next one; repopulated from the `my_wallet` view's
    // initial onInsert when the subscription re-applies (ADR-0154).
    this.#ownWallet = undefined;
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

  /** Human player count (excludes NPC characters seeded by M12b+). */
  get playerCount(): number {
    return this.#players.size;
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

  /** Is `identity` one of the battle's two PARTICIPANT columns? A PvP accepter is stored
   *  in `opponentIdentity` (server-module/src/pvp.rs:289-297), so a `playerIdentity`-only
   *  match left side B with no battle at all (11r-b, ADR-0167 D1). ONE condition shared by
   *  both accessors below, deliberately — two hand-written copies can drift (a fix landed
   *  on one and forgotten on the other). Exact equality against participant columns only:
   *  the `battle` table is subscribed unfiltered (connection.ts:554-559), so this is what
   *  keeps a stranger's row out. */
  #isParticipant(b: StoreBattle, identity: string): boolean {
    return b.playerIdentity === identity || b.opponentIdentity === identity;
  }

  /** The player's own ongoing battle — matched in EITHER PvP role, `playerIdentity` OR
   *  `opponentIdentity` (11r-b/ADR-0167 D1; ADR-0042: public table, client-side filter).
   *  Returns the RAW server row: the store stays a mirror of server truth, and the
   *  own-side-is-sideA view projection lives in `ownPerspective()` below. When more than
   *  one Ongoing row matches, the HIGHEST battleId wins — the same tiebreak
   *  `latestPlayerBattle()` uses (T-RA-6). */
  ongoingBattle(identity: string): StoreBattle | undefined {
    // Pre-join guard: matching two participant columns instead of one turns "no match"
    // into "possible false match" for an empty identity (AC-3).
    if (identity === '') return undefined;
    let best: StoreBattle | undefined;
    for (const b of this.#battles.values()) {
      if (!this.#isParticipant(b, identity) || b.outcome !== 'Ongoing') continue;
      // Scan-and-keep-highest, NOT return-on-first-match: while this accessor matched a
      // single identity column at most one row could ever match, so an early return was
      // safe. Either-role matching makes TWO simultaneous Ongoing matches possible (you can
      // be the challenger in one battle and the accepter in another), and first-match-wins
      // would then hand back whichever row `Map` iteration reached first — insertion-order
      // nondeterminism, and a disagreement with latestPlayerBattle() about which battle is
      // "the" one. Both accessors must agree: the __game() DEV hook, the F9 bug bundle and
      // e2e/pvp-side-b.spec.ts's AC-1 witness all read THIS one.
      // bigint `>` (never Number()/Math.max — ids exceed 2^53; T1d).
      if (best === undefined || b.battleId > best.battleId) best = b;
    }
    return best;
  }

  /** The player's most-recent battle of ANY outcome (highest battleId among rows where
   *  `identity` holds EITHER PvP role — 11r-b/ADR-0167 D1). Highest battleId = most recent
   *  (server auto-inc, monotonic; single current battle per player). Returns the RAW server
   *  row (see `ownPerspective()` for the view projection). Feeds the outcome-frame
   *  lifecycle; ongoingBattle() (Ongoing-only) matches the same either-role rule.
   *  (M8.7e, ADR-0014/0042.) */
  latestPlayerBattle(identity: string): StoreBattle | undefined {
    // Pre-join guard — same reason as ongoingBattle() above (AC-3).
    if (identity === '') return undefined;
    let best: StoreBattle | undefined;
    for (const b of this.#battles.values()) {
      if (!this.#isParticipant(b, identity)) continue;
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

  // --- M12d: conversation / quest / heal / npc read ----------------------------

  ownConversation(ownerIdentity: string): StorePlayerConversation | undefined {
    return this.#conversations.get(ownerIdentity);
  }

  ownQuests(ownerIdentity: string): StorePlayerQuest[] {
    const out: StorePlayerQuest[] = [];
    for (const q of this.#quests.values()) {
      if (q.ownerIdentity === ownerIdentity) out.push(q);
    }
    return out;
  }

  healLocations(): StoreHealLocationRow[] {
    return [...this.#healLocations.values()];
  }

  npc(entityId: bigint): StoreNpcRow | undefined {
    return this.#npcs.get(entityId);
  }

  npcByNpcId(npcId: string): StoreNpcRow | undefined {
    return this.#npcsByNpcId.get(npcId);
  }

  /** Returns all NPC rows as an array (for building the npcsMap in main.ts). */
  allNpcs(): StoreNpcRow[] {
    return [...this.#npcs.values()];
  }

  // --- M13d: shop row ingest (adapter-only) ------------------------------------

  upsertShop(row: StoreShopRow): void {
    this.#shops.set(row.shopId, row);
    this.#dirty = true;
  }

  removeShop(shopId: number): void {
    if (this.#shops.delete(shopId)) this.#dirty = true;
  }

  upsertShopItem(row: StoreShopItemRow): void {
    this.#shopItems.set(row.shopItemId, row);
    this.#dirty = true;
  }

  removeShopItem(shopItemId: bigint): void {
    if (this.#shopItems.delete(shopItemId)) this.#dirty = true;
  }

  // --- M13d: shop read ---------------------------------------------------------

  /** All shop definitions (public content — all players see all shops). */
  allShops(): StoreShopRow[] {
    return [...this.#shops.values()];
  }

  /** All shop stock entries filtered by shopId. */
  shopItemsByShopId(shopId: number): StoreShopItemRow[] {
    const out: StoreShopItemRow[] = [];
    for (const item of this.#shopItems.values()) {
      if (item.shopId === shopId) out.push(item);
    }
    return out;
  }

  /** All shop stock entries (for the model to filter by selected shop). */
  allShopItems(): StoreShopItemRow[] {
    return [...this.#shopItems.values()];
  }

  // --- m16b: battle_challenge ingest (adapter-only) ----------------------------

  upsertChallenge(challenge: StoreBattleChallenge): void {
    this.#challenges.set(challenge.challengeId, challenge);
    this.#dirty = true;
  }

  removeChallenge(challengeId: bigint): void {
    if (this.#challenges.delete(challengeId)) this.#dirty = true;
  }

  // --- m16b: battle_challenge read ---------------------------------------------

  /** All challenge rows (challenger + target subscribe to this public table). */
  allChallenges(): StoreBattleChallenge[] {
    return [...this.#challenges.values()];
  }

  /** All online players (for PvP challenge target selection). */
  allPlayers(): StorePlayer[] {
    return [...this.#players.values()];
  }

  // --- m15b: trade_offer ingest (adapter-only) ---------------------------------

  upsertTradeOffer(row: StoreTradeOffer): void {
    this.#tradeOffers.set(row.tradeId, row);
    this.#dirty = true;
  }

  removeTradeOffer(tradeId: bigint): void {
    if (this.#tradeOffers.delete(tradeId)) this.#dirty = true;
  }

  // --- m15b: trade_offer read --------------------------------------------------

  /**
   * The active trade offer where `identity` is initiator OR counterparty, or undefined.
   * Returns the first match in Map insertion order — not lowest-tradeId. ADR-0106 D4
   * guarantees at most one active offer per player, so tiebreak never matters in practice.
   * For tiebreak-deterministic selection use buildTradeViewModel (passes allTradeOffers()).
   */
  ownTradeOffer(identity: string): StoreTradeOffer | undefined {
    for (const offer of this.#tradeOffers.values()) {
      if (offer.initiator === identity || offer.counterparty === identity) return offer;
    }
    return undefined;
  }

  /** All trade offers (for future browse / multi-offer UIs). */
  allTradeOffers(): StoreTradeOffer[] {
    return [...this.#tradeOffers.values()];
  }

  // --- m17b: profile ingest/read (RL-13 leaderboard; adapter writes, view reads) --

  /** Upsert keyed by identity hex — reconnect re-inserts overwrite, never duplicate.
   *  Deliberately NO removeProfile counterpart: profile rows are never deleted
   *  server-side (RL-2, ADR-0119 D1). */
  upsertProfile(row: StoreProfile): void {
    this.#profiles.set(row.identity, row);
    this.#dirty = true;
  }

  profile(identity: string): StoreProfile | undefined {
    return this.#profiles.get(identity);
  }

  /** All profile rows as a FRESH array each call — a caller mutating it cannot
   *  corrupt the store (one-way `server -> store -> render` flow). */
  allProfiles(): StoreProfile[] {
    return [...this.#profiles.values()];
  }

  // --- ux2: own-wallet slot ingest/read (ADR-0154 `my_wallet` view) --------------

  /** Replace the own-wallet slot (insert-wins: the view re-emits the whole row on
   *  every balance change). Deliberately NO removeWallet counterpart — wallet rows
   *  are never deleted server-side, so an onDelete is only ever the old half of an
   *  update pair, and `reset()` is the sole clearing path. */
  upsertWallet(row: StoreWallet): void {
    this.#ownWallet = row;
    this.#dirty = true;
  }

  /** The own wallet ONLY when it belongs to `identity` — client-side owner filter,
   *  defense in depth behind the server-side owner-scoped view (ADR-0015 V1). */
  ownWallet(identity: string): StoreWallet | undefined {
    const slot = this.#ownWallet;
    return slot !== undefined && slot.ownerIdentity === identity ? slot : undefined;
  }
}

// --- 11r-b: the ONE view-perspective seam (ADR-0167 D2) -------------------------
// Companion to ongoingBattle()/latestPlayerBattle() above, which return RAW server rows
// in EITHER PvP role. A free function, not a store method, on purpose: it keeps the
// accessors honestly "a mirror of server truth" and keeps the projection directly
// unit-testable (store.test.ts T-OWNP-*).

/** Re-express `battle` so the CALLER's own side is always sideA — the projection that lets
 *  a PvP accepter (stored in `opponentIdentity`, server-module/src/pvp.rs:289-297) use a
 *  view layer that hardcodes sideA = the local player (`buildBattleViewModel`
 *  ui/battleModel.ts:239-271, `battleView.#renderOutcome` ui/battleView.ts:430-435).
 *
 *  Returned BY REFERENCE — no swap — when `identity` is `playerIdentity`, when it is in
 *  NEITHER role (never fabricate a perspective), or when `battle` is undefined. The
 *  `playerIdentity` test comes FIRST and that ordering is load-bearing: it is also what
 *  makes a practice battle (`playerIdentity === opponentIdentity`, ADR-0109) a no-op
 *  instead of seating the player on the wrong side of their own mirror.
 *
 *  Otherwise sideA/sideB, playerIdentity/opponentIdentity and
 *  partyMonsterIds/opponentMonsterIds are exchanged (all six are load-bearing — the id
 *  lists feed `isWild` and therefore `canRecruit`) and `outcome` SideAWins<->SideBWins is
 *  permuted. `battleId`, `turnNumber`, `weather`, `createdAtMs`, 'Ongoing', 'Fled' and any
 *  UNRECOGNIZED outcome string pass through verbatim — the last of these deliberately, so
 *  `parseOutcomeTag`'s bindings-regen drift detector (ui/battleModel.ts:203-213) still
 *  fires on a new server variant. Do not normalize or coerce an unknown tag.
 *
 *  VIEW-PERSPECTIVE ONLY — never feed the result to logs, the event ring, the F9 bug
 *  bundle, or a DEV hook; those carry server truth, where sideA is always the challenger,
 *  so that two players' bug bundles and event rings agree on who won (ADR-0167 D3).
 *
 *  NEVER MUTATE a projected view in place: the fast path returns a store-owned object by
 *  reference and the slow path shallow-swaps store-owned nested side objects, so an
 *  in-place edit would corrupt the canonical row for BOTH players. */
export function ownPerspective(battle: StoreBattle, identity: string): StoreBattle;
export function ownPerspective(
  battle: StoreBattle | undefined,
  identity: string,
): StoreBattle | undefined;
export function ownPerspective(
  battle: StoreBattle | undefined,
  identity: string,
): StoreBattle | undefined {
  if (battle === undefined) return undefined;
  // Two sequential by-reference fast paths, in THIS order — playerIdentity first is
  // load-bearing (see the practice-battle note above; pinned by T-OWNP-PRACTICE).
  if (identity === battle.playerIdentity) return battle; // I am side A (also: a practice battle)
  if (identity !== battle.opponentIdentity) return battle; // not a participant — never fabricate
  return {
    ...battle,
    playerIdentity: battle.opponentIdentity,
    opponentIdentity: battle.playerIdentity,
    sideA: battle.sideB,
    sideB: battle.sideA,
    partyMonsterIds: battle.opponentMonsterIds,
    opponentMonsterIds: battle.partyMonsterIds,
    outcome: swapWinnerTag(battle.outcome),
  };
}

/** SideAWins <-> SideBWins; EVERY other tag (including 'Ongoing', 'Fled' and an
 *  unrecognized one) is a fixed point. An involution, by construction. */
function swapWinnerTag(outcome: string): string {
  if (outcome === 'SideAWins') return 'SideBWins';
  if (outcome === 'SideBWins') return 'SideAWins';
  return outcome;
}
