// render/art/packs/characters.ts — character art rows (hero; `wap-5` extends).
import type { ArtRow } from '../registry';

const GENERATOR = 'client/art-src/generate_art.py';

export const CHARACTERS_PACK: readonly ArtRow[] = [
  {
    key: 'characters/hero',
    file: 'hero.png',
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
