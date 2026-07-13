// net/rowConvert.ts — map the generated SpacetimeDB row types to the store's
// normalized shapes: `bigint` ids kept, tagged-union enums ({tag}) flattened to
// the bare strings the store/wasm use, and the SDK move_queue converted to
// wasm `MoveInput[]`. This is the ONLY place SDK Character/Player rows are read,
// so the store stays SDK-agnostic and synchronously testable.
import {
  moveInputToWasm,
  type SdkMoveInput,
  type WasmAction,
  type WasmDirection,
} from '../convert/convert';
import type {
  StoreBattle,
  StoreBattleMonster,
  StoreCharacter,
  StoreFusionRow,
  StoreHealLocationRow,
  StoreInventory,
  StoreItemRow,
  StoreMonsterPub,
  StoreNpcRow,
  StorePlayer,
  StorePlayerConversation,
  StorePlayerQuest,
  StoreShopItemRow,
  StoreShopRow,
  StoreSkillRow,
  StoreSpeciesRow,
  StoreWeather,
} from './store';

// Structural views of the generated rows (just the fields convert reads). Kept
// structural — not the SDK runtime classes — so tests build plain objects and the
// store never imports the SDK. The real generated rows satisfy these shapes.
export interface SdkCharacterRow {
  readonly entityId: bigint;
  readonly zoneId: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly facing: { readonly tag: WasmDirection };
  readonly action: { readonly tag: WasmAction };
  readonly moveStartedAtMs: bigint;
  readonly moveQueue: readonly SdkMoveInput[];
}

export interface SdkPlayerRow {
  readonly identity: { toHexString(): string };
  readonly entityId: bigint;
  readonly name: string;
  readonly online: boolean;
  readonly lastInputSeq: bigint;
}

export function characterRowToStore(row: SdkCharacterRow): StoreCharacter {
  return {
    entityId: row.entityId,
    zoneId: row.zoneId,
    tileX: row.tileX,
    tileY: row.tileY,
    facing: row.facing.tag,
    action: row.action.tag,
    moveStartedAtMs: row.moveStartedAtMs,
    moveQueue: row.moveQueue.map(moveInputToWasm),
  };
}

export function playerRowToStore(row: SdkPlayerRow): StorePlayer {
  return {
    identity: row.identity.toHexString(),
    entityId: row.entityId,
    name: row.name,
    online: row.online,
    lastInputSeq: row.lastInputSeq,
  };
}

// --- M6c: monster_pub + species_row converters --------------------------------

export interface SdkMonsterPubRow {
  readonly monsterId: bigint;
  readonly ownerIdentity: { toHexString(): string };
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
  /** Option<u32> decodes as number | undefined for primitive options (M10c). */
  readonly evolvesTo?: number;
}

export interface SdkSpeciesRowRow {
  readonly id: number;
  readonly name: string;
  readonly baseHp: number;
  readonly baseAttack: number;
  readonly baseDefense: number;
  readonly baseSpeed: number;
  readonly baseSpAttack: number;
  readonly baseSpDefense: number;
  readonly affinity: { readonly tag: string };
  readonly learnableSkillIds: readonly number[];
}

export function monsterPubRowToStore(row: SdkMonsterPubRow): StoreMonsterPub {
  return {
    monsterId: row.monsterId,
    ownerIdentity: row.ownerIdentity.toHexString(),
    speciesId: row.speciesId,
    nickname: row.nickname,
    level: row.level,
    xp: row.xp,
    bond: row.bond,
    currentHp: row.currentHp,
    statHp: row.statHp,
    statAttack: row.statAttack,
    statDefense: row.statDefense,
    statSpeed: row.statSpeed,
    statSpAttack: row.statSpAttack,
    statSpDefense: row.statSpDefense,
    partySlot: row.partySlot,
    evolvesTo: row.evolvesTo,
  };
}

export function speciesRowToStore(row: SdkSpeciesRowRow): StoreSpeciesRow {
  return {
    id: row.id,
    name: row.name,
    baseHp: row.baseHp,
    baseAttack: row.baseAttack,
    baseDefense: row.baseDefense,
    baseSpeed: row.baseSpeed,
    baseSpAttack: row.baseSpAttack,
    baseSpDefense: row.baseSpDefense,
    affinity: row.affinity.tag,
    learnableSkillIds: [...row.learnableSkillIds],
  };
}

// --- M7c: battle + skill_row converters --------------------------------------

export interface SdkBattleMonster {
  readonly speciesId: number;
  readonly affinity: { readonly tag: string };
  readonly level: number;
  readonly currentHp: number;
  readonly maxHp: number;
  readonly stats: {
    readonly hp: number;
    readonly attack: number;
    readonly defense: number;
    readonly speed: number;
    readonly spAttack: number;
    readonly spDefense: number;
  };
  readonly knownSkillIds: readonly number[];
  // Optional: Sleep carries a `value` (turns_remaining u8); others are unit variants.
  readonly status?: { readonly tag: string; readonly value?: number } | null;
}

export interface SdkBattleSide {
  readonly active: number;
  readonly team: readonly SdkBattleMonster[];
}

export interface SdkBattleRow {
  readonly battleId: bigint;
  readonly playerIdentity: { toHexString(): string };
  readonly opponentIdentity: { toHexString(): string };
  readonly state: {
    readonly sideA: SdkBattleSide;
    readonly sideB: SdkBattleSide;
    readonly outcome: { readonly tag: string };
    readonly turnNumber: number;
    // Optional: m14d WeatherEffect carries a value (turns_remaining u8); absent when no weather.
    // Optional field keeps existing test factories compiling (no weather field required).
    readonly weather?: { readonly tag: string; readonly value: number } | null;
  };
  readonly partyMonsterIds: readonly bigint[];
  readonly opponentMonsterIds: readonly bigint[];
  readonly createdAtMs: bigint;
}

export interface SdkSkillRowRow {
  readonly id: number;
  readonly name: string;
  readonly affinity: { readonly tag: string };
  readonly power: number;
  readonly accuracy: number;
  readonly pp: number;
}

function battleMonsterToStore(m: SdkBattleMonster): StoreBattleMonster {
  return {
    speciesId: m.speciesId,
    affinity: m.affinity.tag,
    level: m.level,
    currentHp: m.currentHp,
    maxHp: m.maxHp,
    statHp: m.stats.hp,
    statAttack: m.stats.attack,
    statDefense: m.stats.defense,
    statSpeed: m.stats.speed,
    statSpAttack: m.stats.spAttack,
    statSpDefense: m.stats.spDefense,
    knownSkillIds: [...m.knownSkillIds],
    status: m.status ? { tag: m.status.tag, turnsRemaining: m.status.value } : null,
  };
}

export function battleRowToStore(row: SdkBattleRow): StoreBattle {
  // m14.5d: map state.weather → StoreBattle.weather.
  // ANTI-PATTERN: do NOT use `?.value || null` — falsy-value trap when value=0.
  // Use explicit object-truthiness check so turnsRemaining:0 is preserved as 0
  // (parallel to status.value→turnsRemaining at line 211).
  const w = row.state.weather;
  const weather: StoreWeather | null = w != null ? { tag: w.tag, turnsRemaining: w.value } : null;

  return {
    battleId: row.battleId,
    playerIdentity: row.playerIdentity.toHexString(),
    opponentIdentity: row.opponentIdentity.toHexString(),
    outcome: row.state.outcome.tag,
    turnNumber: row.state.turnNumber,
    sideA: {
      active: row.state.sideA.active,
      team: row.state.sideA.team.map(battleMonsterToStore),
    },
    sideB: {
      active: row.state.sideB.active,
      team: row.state.sideB.team.map(battleMonsterToStore),
    },
    partyMonsterIds: [...row.partyMonsterIds],
    opponentMonsterIds: [...row.opponentMonsterIds],
    createdAtMs: row.createdAtMs,
    weather,
  };
}

export function skillRowToStore(row: SdkSkillRowRow): StoreSkillRow {
  return {
    id: row.id,
    name: row.name,
    affinity: row.affinity.tag,
    power: row.power,
    accuracy: row.accuracy,
    pp: row.pp,
  };
}

// --- M9c: inventory + item_row converters -------------------------------------

export interface SdkInventoryRow {
  readonly invId: bigint;
  readonly ownerIdentity: { toHexString(): string };
  readonly itemId: number;
  readonly count: number;
}

export interface SdkItemRowRow {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly recruitBonus: number;
  // SpacetimeDB 2.6 decodes Option<StatKind> as {tag} for Some, undefined for None.
  readonly trainStat: { readonly tag: string } | undefined;
  readonly trainAmount: number;
  /** M13b: sell price in currency units (u64 in Rust; bigint in TS). */
  readonly sellPrice: bigint;
  // SpacetimeDB 2.6 decodes Option<StatusKind> as {tag} for Some, undefined for None.
  readonly cureStatus: { readonly tag: string } | undefined;
}

export function inventoryRowToStore(row: SdkInventoryRow): StoreInventory {
  return {
    invId: row.invId,
    ownerIdentity: row.ownerIdentity.toHexString(),
    itemId: row.itemId,
    count: row.count,
  };
}

export function itemRowToStore(row: SdkItemRowRow): StoreItemRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    recruitBonus: row.recruitBonus,
    trainStat: row.trainStat?.tag ?? null,
    trainAmount: row.trainAmount,
    sellPrice: row.sellPrice,
    cureStatus: row.cureStatus?.tag ?? null,
  };
}

// --- M13d: shop row converters -----------------------------------------------

export interface SdkShopRowRow {
  readonly shopId: number;
  readonly name: string;
}

export interface SdkShopItemRowRow {
  readonly shopItemId: bigint;
  readonly shopId: number;
  readonly itemId: number;
  readonly buyPrice: bigint;
}

export function shopRowToStore(row: SdkShopRowRow): StoreShopRow {
  return { shopId: row.shopId, name: row.name };
}

export function shopItemRowToStore(row: SdkShopItemRowRow): StoreShopItemRow {
  return {
    shopItemId: row.shopItemId,
    shopId: row.shopId,
    itemId: row.itemId,
    buyPrice: row.buyPrice,
  };
}

// --- M10c: fusion converter ---------------------------------------------------

/** Structural view of the generated fusion table row (all primitives — no tagged unions). */
export interface SdkFusionRow {
  readonly fusionId: bigint;
  readonly aSpecies: number;
  readonly bSpecies: number;
  readonly toSpecies: number;
}

export function fusionRowToStore(row: SdkFusionRow): StoreFusionRow {
  return {
    fusionId: row.fusionId,
    aSpecies: row.aSpecies,
    bSpecies: row.bSpecies,
    toSpecies: row.toSpecies,
  };
}

// --- M12d: player_conversation / player_quest / heal_location_row / npc converters ----

// M13.5c (ADR-0087): rows now arrive through the owner-scoped `my_conversation`
// VIEW binding — structurally identical to the old table row (the view returns
// Option<PlayerConversation>), so this converter is unchanged.
interface SdkPlayerConversation {
  readonly ownerIdentity: { toHexString(): string };
  readonly npcEntityId: bigint;
  readonly currentNodeId: string;
}

export function playerConversationRowToStore(row: SdkPlayerConversation): StorePlayerConversation {
  return {
    ownerIdentity: row.ownerIdentity.toHexString(),
    npcEntityId: row.npcEntityId,
    currentNodeId: row.currentNodeId,
  };
}

/**
 * Net-effect delete gate for the owner-scoped `my_conversation` VIEW subscription
 * (M13.5c, ADR-0087 — T0 spike finding 4): through a view, a row UPDATE arrives as
 * `onInsert(new)` + `onDelete(old)` — NO onUpdate (the view table has no PK for SDK
 * correlation) — and the pair is UNORDERED. A naive onDelete → remove(owner) would
 * wipe the just-updated conversation on every advance_dialogue.
 *
 * Returns true (remove the stored row) ONLY when `stored` is defined and matches
 * `deleted` on BOTH npcEntityId AND currentNodeId — a genuine delete (dismiss, or
 * an end-of-dialogue advance). Returns false when stored is undefined or differs on
 * either field (the delete-of-the-old-version half of an update pair). npcEntityId
 * is compared as bigint (coercion-free: Number() would collapse ids past 2^53).
 *
 * KNOWN EDGE (RT-M13.5C-03, ADR-0087): an UPDATE to IDENTICAL values is
 * indistinguishable from a genuine delete here (insert-first ordering would
 * remove the live row). Unreachable from this client — KeyT is overlay-guarded,
 * so `talk` is never sent while a conversation exists, and no current dialogue
 * tree self-loops — the durable fix is a server-side no-op-skip in the talk /
 * advance_dialogue upserts (npc.rs, outside this slice's touch-set).
 */
export function shouldRemoveOnViewDelete(
  stored: StorePlayerConversation | undefined,
  deleted: StorePlayerConversation,
): boolean {
  if (stored === undefined) return false;
  return (
    stored.npcEntityId === deleted.npcEntityId && stored.currentNodeId === deleted.currentNodeId
  );
}

interface SdkPlayerQuest {
  readonly pqId: bigint;
  readonly ownerIdentity: { toHexString(): string };
  readonly questId: string;
  readonly stepIndex: number;
}

export function playerQuestRowToStore(row: SdkPlayerQuest): StorePlayerQuest {
  return {
    pqId: row.pqId,
    ownerIdentity: row.ownerIdentity.toHexString(),
    questId: row.questId,
    stepIndex: row.stepIndex,
  };
}

interface SdkHealLocationRow {
  readonly locationId: number;
  readonly zoneId: number;
  readonly tileX: number;
  readonly tileY: number;
  readonly costItemId?: number;
  readonly costQty: number;
  readonly cooldownMs: number;
}

export function healLocationRowToStore(row: SdkHealLocationRow): StoreHealLocationRow {
  return {
    locationId: row.locationId,
    zoneId: row.zoneId,
    tileX: row.tileX,
    tileY: row.tileY,
    costItemId: row.costItemId,
    costQty: row.costQty,
    cooldownMs: row.cooldownMs,
  };
}

interface SdkNpcRow {
  readonly entityId: bigint;
  readonly npcId: string;
  readonly zoneId: number;
  readonly homeX: number;
  readonly homeY: number;
  readonly wanderRadius: number;
  readonly dialogueTreeId: string;
}

export function npcRowToStore(row: SdkNpcRow): StoreNpcRow {
  return {
    entityId: row.entityId,
    npcId: row.npcId,
    zoneId: row.zoneId,
    homeX: row.homeX,
    homeY: row.homeY,
    wanderRadius: row.wanderRadius,
    dialogueTreeId: row.dialogueTreeId,
  };
}
