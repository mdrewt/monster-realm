// render/art/packs/monsters.ts — monster sheet rows, keyed by species name.
//
// The key is the lower-cased species name; the file is whatever the generator
// wrote (Flameling's sheet ships as `monster-emberkit.png`). Every species has
// a sheet (Tidecrag and Cindershade since `wap-3`). Every sheet is 3×4 frames
// of 32 px; the wave-1 sheets (Cragling, Shadelet, Stoneward, Umbrafang) have no
// normal map and came from a generator since deleted from the tree.
import type { ArtRow } from '../registry';

const ORIGINAL = 'client/art-src/generate_art.py';
const ROSTER = 'client/art-src/generate_monsters.py';
const WAVE_1 = 'docs/adr/0143-appendix-gen-wave1.py@b791ecf4';

const SHEET = { w: 96, h: 128 } as const;
const FRAME = { w: 32, h: 32 } as const;

function sheetRows(species: string, slug: string, source: string, normal: boolean): ArtRow[] {
  const id = species.toLowerCase();
  const albedo: ArtRow = {
    key: `monsters/${id}`,
    file: `monster-${slug}.png`,
    kind: 'sprite',
    sheet: SHEET,
    frame: FRAME,
    scale: 1,
    source,
    provenance: 'placeholder-procedural',
    license: 'project-original',
  };
  if (!normal) return [albedo];
  return [
    albedo,
    { ...albedo, key: `monsters/${id}_normal`, file: `monster-${slug}-normal.png`, kind: 'normal' },
  ];
}

export const MONSTERS_PACK: readonly ArtRow[] = [
  ...sheetRows('Flameling', 'emberkit', ORIGINAL, true),
  ...sheetRows('Tidalin', 'tidalin', ROSTER, true),
  ...sheetRows('Sproutlet', 'sproutlet', ROSTER, true),
  ...sheetRows('Pyroleo', 'pyroleo', ROSTER, true),
  ...sheetRows('Embersworn', 'embersworn', ROSTER, true),
  ...sheetRows('Steamveil', 'steamveil', ROSTER, true),
  ...sheetRows('Cragling', 'cragling', WAVE_1, false),
  ...sheetRows('Shadelet', 'shadelet', WAVE_1, false),
  ...sheetRows('Stoneward', 'stoneward', WAVE_1, false),
  ...sheetRows('Umbrafang', 'umbrafang', WAVE_1, false),
  ...sheetRows('Umbraquill', 'umbraquill', ROSTER, true),
  ...sheetRows('Gustwyrm', 'gustwyrm', ROSTER, true),
  ...sheetRows('Venumbra', 'venumbra', ROSTER, true),
  ...sheetRows('Tempestrix', 'tempestrix', ROSTER, true),
  ...sheetRows('Voltkit', 'voltkit', ROSTER, true),
  ...sheetRows('Voltarion', 'voltarion', ROSTER, true),
  ...sheetRows('Aurelet', 'aurelet', ROSTER, true),
  ...sheetRows('Aurelith', 'aurelith', ROSTER, true),
  ...sheetRows('Tidecrag', 'tidecrag', ROSTER, true),
  ...sheetRows('Cindershade', 'cindershade', ROSTER, true),
];
