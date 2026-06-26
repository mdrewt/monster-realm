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
import type { StoreCharacter, StoreMonsterPub, StorePlayer, StoreSpeciesRow } from './store';

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
