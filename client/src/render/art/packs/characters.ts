// render/art/packs/characters.ts — character art rows: the hero sheet (with its json
// atlas beside it, which `render/atlasAssets.ts` reads since wap-5) and its normal map.
import type { ArtRow } from '../registry';

const GENERATOR = 'client/art-src/generate_art.py';

/** The hero sheet in `client/public/assets/`; its Pixi json atlas is `hero.json`. */
export const HERO_SHEET_FILE = 'hero.png';

export const CHARACTERS_PACK: readonly ArtRow[] = [
  {
    key: 'characters/hero',
    file: HERO_SHEET_FILE,
    kind: 'sprite',
    sheet: { w: 160, h: 128 },
    frame: { w: 32, h: 32 },
    scale: 1,
    source: GENERATOR,
    provenance: 'placeholder-procedural',
    license: 'project-original',
  },
  {
    key: 'characters/hero_normal',
    file: 'hero-normal.png',
    kind: 'normal',
    sheet: { w: 160, h: 128 },
    frame: { w: 32, h: 32 },
    scale: 1,
    source: GENERATOR,
    provenance: 'placeholder-procedural',
    license: 'project-original',
  },
];
