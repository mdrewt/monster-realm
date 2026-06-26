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
  StoreMonsterPub,
  StorePlayer,
  StoreSkillRow,
  StoreSpeciesRow,
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
  };
}

export function battleRowToStore(row: SdkBattleRow): StoreBattle {
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
