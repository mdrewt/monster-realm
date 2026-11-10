// render/art/packs/landmarks.ts — the landmarks sheet (wap-6): the heal landmark and the
// warp-marker pulse, plus the frame manifest `render/decorLayout.ts` lays out.
import type { Landmark } from '../../map';
import type { ArtRow } from '../registry';

const GENERATOR = 'client/art-src/generate_art.py';

export const LANDMARKS_FILE = 'landmarks.png';

/** Every landmarks frame is one tile wide and two tall, bottom-anchored on its tile. */
export const DECOR_FRAME = { w: 32, h: 64 } as const;

/** The frame a landmark of each kind shows (total over `Landmark['kind']`: a new kind is a compile error). */
export const LANDMARK_FRAME: Readonly<Record<Landmark['kind'], string>> = {
  heal: 'heal_landmark',
};

/** The warp-marker pulse frames in play order (the atlas json `animations.warp`); frame 0 is the reduced-motion hold. */
export const WARP_MARKER_FRAMES: readonly string[] = ['warp_f0', 'warp_f1', 'warp_f2', 'warp_f3'];

export const LANDMARKS_PACK: readonly ArtRow[] = [
  {
    key: 'landmarks/sheet',
    file: LANDMARKS_FILE,
    kind: 'sprite',
    sheet: { w: 160, h: 64 },
    frame: DECOR_FRAME,
    scale: 1,
    source: GENERATOR,
    provenance: 'placeholder-procedural',
    license: 'project-original',
  },
];
