// render/art/packs/battle.ts — battle backdrop rows (`wap-3`).
//
// One backdrop behind the DOM board (per-zone backdrops are a named backlog
// deferral). It is one frameless image, so it takes the registry's frameless
// `palette` kind: a framed kind would demand a sibling `.json` sheet it has no
// use for. (A dedicated frameless `backdrop` kind is a registry follow-up.)
import type { ArtRow } from '../registry';

export const BATTLE_PACK: readonly ArtRow[] = [
  {
    key: 'battle/backdrop',
    file: 'battle-backdrop.png',
    kind: 'palette',
    sheet: { w: 320, h: 192 },
    scale: 1,
    source: 'client/art-src/generate_backdrop.py',
    provenance: 'placeholder-procedural',
    license: 'project-original',
  },
];
