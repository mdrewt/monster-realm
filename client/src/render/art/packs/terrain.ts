// render/art/packs/terrain.ts — terrain art rows (POC tileset + master palette; `wap-2` extends).
import type { ArtRow } from '../registry';

const GENERATOR = 'client/art-src/generate_art.py';

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
