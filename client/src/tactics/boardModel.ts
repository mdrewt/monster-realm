// tactics/boardModel.ts — bt-10 API FREEZE STUB (behaviour lands in the implementation commit).
import type { CursorDir } from '../ui/battleModel';

export type Side = 'A' | 'B';
export interface Tile {
  readonly x: number;
  readonly y: number;
}
export type Stance = 'Aggressive' | 'Territorial' | 'Skittish';
export type StatusTag = 'Poison' | 'Burn' | 'Paralysis' | 'Sleep' | 'Freeze';
export interface TacticalUnit {
  readonly unitId: number;
  readonly side: Side;
  readonly mine: boolean;
  /** A wild (ownerless) unit: its turns are AI turns. */
  readonly ai: boolean;
  readonly speciesId: number;
  readonly speciesName: string;
  readonly level: number;
  readonly affinity: string;
  readonly x: number;
  readonly y: number;
  readonly curHp: number;
  readonly maxHp: number;
  readonly status: StatusTag | null;
  readonly ap: number;
  readonly guard: boolean;
  readonly firstStand: boolean;
  readonly role: string | null;
  readonly stance: Stance | null;
  readonly state: 'Active' | 'Fainted' | 'Recruited';
}
export type IntentKind = 'attack' | 'move' | 'hold';
export interface OverlaySets {
  readonly reach1: readonly Tile[];
  readonly reach2: readonly Tile[];
  readonly range: readonly Tile[];
  readonly aoe: readonly Tile[];
  readonly danger: readonly (readonly Tile[])[];
  readonly shield: readonly Tile[];
  readonly intents: readonly { readonly unitId: number; readonly kind: IntentKind }[];
}
export const EMPTY_OVERLAYS: OverlaySets = Object.freeze({
  reach1: [],
  reach2: [],
  range: [],
  aoe: [],
  danger: [],
  shield: [],
  intents: [],
});
export type OverlayKind = 'reach1' | 'reach2' | 'range' | 'aoe' | 'danger' | 'shield';
export const OVERLAY_ORDER: readonly OverlayKind[] = [
  'reach1',
  'reach2',
  'range',
  'aoe',
  'danger',
  'shield',
];
export interface TileVM {
  readonly x: number;
  readonly y: number;
  readonly overlays: readonly OverlayKind[];
  readonly cursor: boolean;
}
export interface UnitVM {
  readonly unitId: number;
  readonly x: number;
  readonly y: number;
  readonly side: Side;
  readonly mine: boolean;
  readonly speciesName: string;
  readonly spriteSlug: string | null;
  readonly hpPermille: number;
  readonly hpBand: 'high' | 'mid' | 'low';
  readonly active: boolean;
  readonly intent: IntentKind | null;
}
export interface BoardVM {
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly TileVM[];
  readonly units: readonly UnitVM[];
}
export interface BoardInput {
  readonly width: number;
  readonly height: number;
  readonly units: readonly TacticalUnit[];
  readonly activeUnitId: number | null;
  readonly cursor: Tile | null;
  readonly overlays: OverlaySets;
  readonly dangerOn: boolean;
}
export type Dir = CursorDir;
export type CursorMemory = ReadonlyMap<number, Tile>;

const todo = (): never => {
  throw new Error('bt-10: not implemented');
};
export function buildBoard(_input: BoardInput): BoardVM {
  return todo();
}
export function spriteSlug(_speciesName: string): string | null {
  return todo();
}
export function cursorFor(
  _mem: CursorMemory,
  _unit: TacticalUnit,
  _width: number,
  _height: number,
): Tile {
  return todo();
}
export function moveCursor(
  _mem: CursorMemory,
  _unitId: number,
  _from: Tile,
  _dir: Dir,
  _width: number,
  _height: number,
): CursorMemory {
  return todo();
}
export function unitAt(_units: readonly TacticalUnit[], _tile: Tile): TacticalUnit | null {
  return todo();
}
