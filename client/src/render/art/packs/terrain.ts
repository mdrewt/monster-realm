// render/art/packs/terrain.ts — terrain art rows: the POC tileset, the master palette and the
// terrain kit (wap-2), plus the kit's frame manifest — per class, its variant and animation
// frame keys, and the shallow-water shore band — that the terrain renderer (wap-4) lays out.
import type { ArtRow } from '../registry';

const GENERATOR = 'client/art-src/generate_art.py';

/** TileKind wire names (`game-core/src/types.rs`, wap-1); the style guide's terrain class table. */
export type TerrainKitClass =
  | 'Floor'
  | 'TallGrass'
  | 'Path'
  | 'Sand'
  | 'ShallowWater'
  | 'DeepWater'
  | 'Rock'
  | 'Tree'
  | 'Bush'
  | 'Wall';

export interface TerrainKitClassFrames {
  /** Static variant frame keys; these are the class's base frames. */
  readonly variants: readonly string[];
  /** Animation frame keys in play order; water classes only (the atlas json `animations` entry). */
  readonly animation?: readonly string[];
}

/**
 * A shallow-water tile's shore frame, named for where its LAND (ground) lies:
 * - `n`/`e`/`s`/`w`: a land band along that one edge (water on the other three);
 * - `ne`/`nw`/`se`/`sw`: land bands along BOTH named edges — the water body's
 *   convex corner (e.g. the NE tile of a rectangular pond is `ne`);
 * - `inner_*`: water except a land notch in that corner — the water body's
 *   concave corner (land diagonally touches it).
 * Shore frames are static and their water matches the phase-0 frame
 * (`<class>_f0`, pixel-equal to `<class>_0`), which reduced motion holds.
 */
export type ShoreSlot =
  | 'n'
  | 'e'
  | 's'
  | 'w'
  | 'ne'
  | 'nw'
  | 'se'
  | 'sw'
  | 'inner_ne'
  | 'inner_nw'
  | 'inner_se'
  | 'inner_sw';

export const TERRAIN_KIT_FILE = 'terrain-kit.png';
export const TERRAIN_KIT_NORMAL_FILE = 'terrain-kit-normal.png';

const variants = (prefix: string): readonly string[] => [0, 1, 2].map((v) => `${prefix}_${v}`);
const waterFrames = (prefix: string): readonly string[] =>
  [0, 1, 2, 3].map((f) => `${prefix}_f${f}`);

/** Frame keys per class, mirrored by hand from `generate_art.py` `build_terrain_kit` (the test cross-checks the json). */
export const TERRAIN_KIT_CLASSES: Readonly<Record<TerrainKitClass, TerrainKitClassFrames>> = {
  Floor: { variants: variants('ground') },
  TallGrass: { variants: variants('tall_grass') },
  Path: { variants: variants('path') },
  Sand: { variants: variants('sand') },
  ShallowWater: { variants: variants('shallow_water'), animation: waterFrames('shallow_water') },
  DeepWater: { variants: variants('deep_water'), animation: waterFrames('deep_water') },
  Rock: { variants: variants('rock') },
  Tree: { variants: variants('tree') },
  Bush: { variants: variants('bush') },
  Wall: { variants: variants('wall') },
};

/** The shore band where shallow water meets land (ground), one frame per slot. */
export const TERRAIN_KIT_SHORE: Readonly<Record<ShoreSlot, string>> = {
  n: 'shore_n',
  e: 'shore_e',
  s: 'shore_s',
  w: 'shore_w',
  ne: 'shore_ne',
  nw: 'shore_nw',
  se: 'shore_se',
  sw: 'shore_sw',
  inner_ne: 'shore_inner_ne',
  inner_nw: 'shore_inner_nw',
  inner_se: 'shore_inner_se',
  inner_sw: 'shore_inner_sw',
};

export const TERRAIN_PACK: readonly ArtRow[] = [
  {
    key: 'terrain/edge_of_town',
    file: 'tileset-edge-of-town.png',
    kind: 'tile',
    sheet: { w: 256, h: 192 },
    frame: { w: 32, h: 32 },
    scale: 1,
    source: GENERATOR,
    provenance: 'placeholder-procedural',
    license: 'project-original',
  },
  {
    key: 'terrain/edge_of_town_normal',
    file: 'tileset-edge-of-town-normal.png',
    kind: 'normal',
    sheet: { w: 256, h: 192 },
    frame: { w: 32, h: 32 },
    scale: 1,
    source: GENERATOR,
    provenance: 'placeholder-procedural',
    license: 'project-original',
  },
  {
    key: 'terrain/kit',
    file: TERRAIN_KIT_FILE,
    kind: 'tile',
    sheet: { w: 256, h: 224 },
    frame: { w: 32, h: 32 },
    scale: 1,
    source: GENERATOR,
    provenance: 'placeholder-procedural',
    license: 'project-original',
  },
  {
    key: 'terrain/kit_normal',
    file: TERRAIN_KIT_NORMAL_FILE,
    kind: 'normal',
    sheet: { w: 256, h: 224 },
    frame: { w: 32, h: 32 },
    scale: 1,
    source: GENERATOR,
    provenance: 'placeholder-procedural',
    license: 'project-original',
  },
  {
    key: 'terrain/palette',
    file: 'palette.png',
    kind: 'palette',
    sheet: { w: 82, h: 210 },
    scale: 1,
    source: GENERATOR,
    provenance: 'placeholder-procedural',
    license: 'project-original',
  },
];
