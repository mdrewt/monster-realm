// tactics/boardModel.ts — bt-10: the pure tactical board view-model (BT10.1, BT10.4, BT10.6).
//
// Pure: no DOM, no clock, no resolver. It never derives a tile set (distance, reach, danger are
// game rules owned by game-core and arrive here as an injected OverlaySets); it only layers the
// sets onto a grid, shapes the unit view-models, and keeps the per-unit cursor memory. Art URLs
// come from the art registry (wap-3), never from a name-derived path.
import { ART_REGISTRY, type ArtRow } from '../render/art/registry';
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
  /** The species' registered sheet (`assets/<file>`), or null: no row, no request. */
  readonly spriteUrl: string | null;
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
  /** The registered battle backdrop (`assets/<file>`), or null. */
  readonly backdropUrl: string | null;
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

/** Highest `hpPermille` (a full bar). */
const FULL_PERMILLE = 1000;
const HP_HIGH_ABOVE = 500;
const HP_MID_ABOVE = 200;

const inBounds = (t: Tile, width: number, height: number): boolean =>
  Number.isInteger(t.x) &&
  Number.isInteger(t.y) &&
  t.x >= 0 &&
  t.y >= 0 &&
  t.x < width &&
  t.y < height;

const assetUrl = (row: ArtRow | undefined): string | null =>
  row === undefined ? null : `assets/${row.file}`;

/** The registered sheet of a species: the `monsters/<lower-cased name>` sprite row's file. A
 *  name outside `[A-Za-z]+`, or one with no sprite row, has no sprite (and requests nothing). */
export function spriteUrl(
  speciesName: string,
  rows: readonly ArtRow[] = ART_REGISTRY,
): string | null {
  if (!/^[A-Za-z]+$/.test(speciesName)) return null;
  const key = `monsters/${speciesName.toLowerCase()}`;
  return assetUrl(rows.find((r) => r.key === key && r.kind === 'sprite'));
}

/** The registered battle backdrop (the `battle/backdrop` row), or null. */
export function backdropUrl(rows: readonly ArtRow[] = ART_REGISTRY): string | null {
  return assetUrl(rows.find((r) => r.key === 'battle/backdrop'));
}

function hpPermille(curHp: number, maxHp: number): number {
  if (!(maxHp > 0)) return 0;
  const cur = Math.min(Math.max(curHp, 0), maxHp);
  return Math.min(FULL_PERMILLE, Math.floor((cur * FULL_PERMILLE) / maxHp));
}

function hpBand(permille: number): UnitVM['hpBand'] {
  if (permille > HP_HIGH_ABOVE) return 'high';
  if (permille > HP_MID_ABOVE) return 'mid';
  return 'low';
}

/** Tile -> overlay kinds present on it, for every in-bounds tile of every set. */
function layerOverlays(input: BoardInput): Map<number, Set<OverlayKind>> {
  const { width, height, overlays, dangerOn } = input;
  const layers = new Map<number, Set<OverlayKind>>();
  const mark = (kind: OverlayKind, tiles: readonly Tile[]): void => {
    for (const t of tiles) {
      if (!inBounds(t, width, height)) continue;
      const at = t.y * width + t.x;
      const set = layers.get(at) ?? new Set<OverlayKind>();
      set.add(kind);
      layers.set(at, set);
    }
  };
  mark('reach1', overlays.reach1);
  mark('reach2', overlays.reach2);
  mark('range', overlays.range);
  mark('aoe', overlays.aoe);
  if (dangerOn) for (const enemy of overlays.danger) mark('danger', enemy);
  mark('shield', overlays.shield);
  return layers;
}

export function buildBoard(input: BoardInput): BoardVM {
  const { width, height } = input;
  const layers = layerOverlays(input);
  const tiles: TileVM[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const present = layers.get(y * width + x);
      const overlays: OverlayKind[] = [];
      if (present !== undefined) {
        for (const kind of OVERLAY_ORDER) {
          if (!present.has(kind)) continue;
          // A tile in both reach sets shows only the nearer (blue) one.
          if (kind === 'reach2' && present.has('reach1')) continue;
          overlays.push(kind);
        }
      }
      const c = input.cursor;
      tiles.push({ x, y, overlays, cursor: c !== null && c.x === x && c.y === y });
    }
  }

  const intents = new Map<number, IntentKind>();
  for (const i of input.overlays.intents) intents.set(i.unitId, i.kind);

  const units: UnitVM[] = [];
  for (const u of input.units) {
    if (u.state !== 'Active') continue;
    const permille = hpPermille(u.curHp, u.maxHp);
    units.push({
      unitId: u.unitId,
      x: u.x,
      y: u.y,
      side: u.side,
      mine: u.mine,
      speciesName: u.speciesName,
      spriteUrl: spriteUrl(u.speciesName),
      hpPermille: permille,
      hpBand: hpBand(permille),
      active: input.activeUnitId === u.unitId,
      intent: intents.get(u.unitId) ?? null,
    });
  }
  return { width, height, tiles, units, backdropUrl: backdropUrl() };
}

const clamp = (n: number, hi: number): number => Math.max(0, Math.min(n, hi));
const clampTile = (t: Tile, width: number, height: number): Tile => ({
  x: clamp(t.x, width - 1),
  y: clamp(t.y, height - 1),
});

/** The remembered cursor tile of `unit` (clamped into the board), else the unit's own tile. */
export function cursorFor(
  mem: CursorMemory,
  unit: TacticalUnit,
  width: number,
  height: number,
): Tile {
  const remembered = mem.get(unit.unitId);
  return remembered === undefined ? { x: unit.x, y: unit.y } : clampTile(remembered, width, height);
}

const STEP: Readonly<Record<Dir, Tile>> = {
  Up: { x: 0, y: -1 },
  Down: { x: 0, y: 1 },
  Left: { x: -1, y: 0 },
  Right: { x: 1, y: 0 },
};

/** A NEW memory with `unitId`'s cursor moved one tile from `from`, clamped to the board. */
export function moveCursor(
  mem: CursorMemory,
  unitId: number,
  from: Tile,
  dir: Dir,
  width: number,
  height: number,
): CursorMemory {
  const d = STEP[dir];
  const next = clampTile({ x: from.x + d.x, y: from.y + d.y }, width, height);
  const out = new Map(mem);
  out.set(unitId, next);
  return out;
}

/** The ACTIVE unit standing on `tile`, or null. */
export function unitAt(units: readonly TacticalUnit[], tile: Tile): TacticalUnit | null {
  return units.find((u) => u.state === 'Active' && u.x === tile.x && u.y === tile.y) ?? null;
}
