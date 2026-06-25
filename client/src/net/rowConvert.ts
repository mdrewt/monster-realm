// net/rowConvert.ts — map the generated SpacetimeDB row types to the store's
// normalized shapes: `bigint` ids kept, tagged-union enums ({tag}) flattened to
// the bare strings the store/wasm use, and the SDK move_queue converted to
// wasm `MoveInput[]`. This is the ONLY place SDK Character/Player rows are read,
// so the store stays SDK-agnostic and synchronously testable.
import { moveInputToWasm, type SdkMoveInput, type WasmAction, type WasmDirection } from '../convert/convert';
import type { StoreCharacter, StorePlayer } from './store';

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
