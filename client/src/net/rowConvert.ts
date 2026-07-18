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
  StoreBattleChallenge,
  StoreBattleMonster,
  StoreCharacter,
  StoreFusionRow,
  StoreHealLocationRow,
  StoreInventory,
  StoreItemRow,
  StoreMonsterCard,
  StoreMonsterPub,
  StoreNpcRow,
  StorePlayer,
  StorePlayerConversation,
  StorePlayerQuest,
  StoreProfile,
  StoreShopItemRow,
  StoreShopRow,
  StoreSkillRow,
  StoreSpeciesRow,
  StoreTradeItem,
  StoreTradeOffer,
  StoreWeather,
} from './store';

// --- m17.5f (ADR-0127): SDK-boundary enum exhaustiveness --------------------------
//
// HANDLED_ENUM_VARIANTS is the client-side registry of every enum whose `.tag`
// crosses the SDK→store boundary in this file (row READS only — write-direction
// enums such as PvpAction are excluded: rowConvert never reads them from a row).
// It is the data half of a three-part ratchet:
//   1. evals/sdk-enum-exhaustiveness.eval.mjs statically diffs this registry
//      against the generated `__t.enum` blocks in module_bindings/types.ts — a
//      server-added variant widens types.ts on regen and turns the eval RED until
//      the registry (and the handling code) are consciously updated.
//   2. Widening a registry entry widens narrowTag's inferred T at its call site;
//      assigning that wider union to a narrower store field (StoreTradeOffer.status)
//      is a tsc error — forcing a deliberate store-union + consumer decision.
//   3. narrowTag is the runtime net: an unknown tag is logged and passed through
//      (fail-soft — NEVER throw; flushBatch has no per-listener isolation).
// Registry entries WITHOUT a narrowTag call site feed bare-string store fields,
// where the eval alone forces author awareness (accepted limitation, ADR-0127).
//
// The variant lists mirror module_bindings/types.ts EXACTLY (unit-test-pinned).
export const HANDLED_ENUM_VARIANTS = {
  TradeStatus: ['Pending', 'ConfirmedByCounterparty'],
  ChallengeStatus: ['Pending', 'Accepted', 'Declined', 'Cancelled'],
  BattleOutcome: ['Ongoing', 'SideAWins', 'SideBWins', 'Fled'],
  Affinity: ['Fire', 'Water', 'Plant', 'Electric', 'Earth', 'Wind', 'Light', 'Dark'],
  StatusKind: ['Poison', 'Burn', 'Paralysis', 'Sleep', 'Freeze'],
  WeatherEffect: ['Rain', 'Sun', 'Sandstorm', 'Hail'],
  ActionState: ['Idle', 'Walking', 'Jumping'],
  Direction: ['North', 'South', 'East', 'West'],
} as const;

/** Narrow a raw SDK enum tag to its registry-typed union. A known tag returns
 *  typed; an unknown tag (a future server-side variant) logs once per call via
 *  console.warn and passes through raw — fail-soft, NEVER throw: a throw inside
 *  a subscription callback would kill the entire flushBatch burst (no
 *  per-listener isolation). */
export function narrowTag<T extends string>(raw: string, known: readonly T[], enumName: string): T {
  if (!known.some((k) => k === raw)) {
    console.warn(
      `[rowConvert] unknown ${enumName} tag '${raw}' — not in the handled-variant registry; passing through raw (ADR-0127 fail-soft)`,
    );
  }
  // The ONE centralized, audited cast (ADR-0127): known tags are provably in T;
  // unknown tags widen at runtime only — callers see the raw string.
  return raw as T;
}

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

// --- m15b: trade_offer converter ---------------------------------------------

interface SdkMonsterCard {
  readonly monsterId: bigint;
  readonly speciesId: number;
  readonly nickname: string;
  readonly level: number;
  readonly currentHp: number;
  readonly statHp: number;
}

interface SdkTradeItem {
  readonly itemId: number;
  readonly qty: number;
}

export interface SdkTradeOfferRow {
  readonly tradeId: bigint;
  readonly initiator: { toHexString(): string };
  readonly counterparty: { toHexString(): string };
  readonly initiatorMonsterIds: readonly bigint[];
  readonly initiatorItems: readonly SdkTradeItem[];
  readonly initiatorCurrency: bigint;
  readonly counterpartyMonsterIds: readonly bigint[];
  readonly counterpartyItems: readonly SdkTradeItem[];
  readonly counterpartyCurrency: bigint;
  readonly initiatorCards: readonly SdkMonsterCard[];
  readonly counterpartyCards: readonly SdkMonsterCard[];
  readonly status: { readonly tag: string };
  readonly createdAtMs: bigint;
}

function sdkCardToStore(card: SdkMonsterCard): StoreMonsterCard {
  return {
    monsterId: card.monsterId,
    speciesId: card.speciesId,
    nickname: card.nickname,
    level: card.level,
    currentHp: card.currentHp,
    statHp: card.statHp,
  };
}

function sdkTradeItemToStore(item: SdkTradeItem): StoreTradeItem {
  return { itemId: item.itemId, qty: item.qty };
}

export function tradeOfferRowToStore(row: SdkTradeOfferRow): StoreTradeOffer {
  return {
    tradeId: row.tradeId,
    initiator: row.initiator.toHexString(),
    counterparty: row.counterparty.toHexString(),
    initiatorMonsterIds: [...row.initiatorMonsterIds],
    initiatorItems: row.initiatorItems.map(sdkTradeItemToStore),
    initiatorCurrency: row.initiatorCurrency,
    counterpartyMonsterIds: [...row.counterpartyMonsterIds],
    counterpartyItems: row.counterpartyItems.map(sdkTradeItemToStore),
    counterpartyCurrency: row.counterpartyCurrency,
    initiatorCards: row.initiatorCards.map(sdkCardToStore),
    counterpartyCards: row.counterpartyCards.map(sdkCardToStore),
    // SDK boundary (ADR-0127, supersedes the m16.5c ADR-0114 trust-cast): an unknown
    // TradeStatus variant is logged and passed through raw via narrowTag (fail-soft).
    status: narrowTag(row.status.tag, HANDLED_ENUM_VARIANTS.TradeStatus, 'TradeStatus'),
    createdAtMs: row.createdAtMs,
  };
}

// --- m16b: battle_challenge conversion -----------------------------------------

export interface SdkBattleChallengeRow {
  readonly challengeId: bigint;
  readonly challenger: { toHexString(): string };
  readonly target: { toHexString(): string };
  readonly challengerPartyIds: readonly bigint[];
  readonly status: { readonly tag: string };
  readonly createdAtMs: bigint;
}

export function battleChallengeRowToStore(row: SdkBattleChallengeRow): StoreBattleChallenge {
  return {
    challengeId: row.challengeId,
    challenger: row.challenger.toHexString(),
    target: row.target.toHexString(),
    challengerPartyIds: [...row.challengerPartyIds],
    status: row.status.tag,
    createdAtMs: row.createdAtMs,
  };
}

// --- m17b: profile conversion ---------------------------------------------------

// `type` alias (not `interface`) to match the StoreProfile probe-cast convention
// (store.ts NOTE at StoreMonsterPub). rating is i32, wins/losses are u32 — all
// decode as plain JS numbers, never bigint.
/** Structural view of the generated profile row (PUBLIC table — RL-13 leaderboard). */
export type SdkProfileRow = {
  readonly identity: { toHexString(): string };
  readonly name: string;
  readonly rating: number;
  readonly wins: number;
  readonly losses: number;
};

/** Explicit field-by-field mapping — NEVER spread the SDK row (a spread would leak
 *  SDK-only fields into the store; the exact five-key set is test-pinned). */
export function profileRowToStore(row: SdkProfileRow): StoreProfile {
  return {
    identity: row.identity.toHexString(),
    name: row.name,
    rating: row.rating,
    wins: row.wins,
    losses: row.losses,
  };
}
