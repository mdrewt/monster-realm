import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type DecodedPng, decodePng } from '../../../test-util/pngDecode';
import {
  TERRAIN_KIT_CLASSES,
  TERRAIN_KIT_FILE,
  TERRAIN_KIT_NORMAL_FILE,
  TERRAIN_KIT_SHORE,
  TERRAIN_PACK,
  type TerrainKitClass,
} from './packs/terrain';
import { ART_REGISTRY, validateArtRegistry } from './registry';

const CLIENT_ROOT = join(import.meta.dirname, '..', '..', '..');
const ASSETS = join(CLIENT_ROOT, 'public', 'assets');

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface SheetFrame {
  frame: Rect;
  sourceSize?: unknown;
  spriteSourceSize?: unknown;
}
interface SheetJson {
  frames: Record<string, SheetFrame>;
  animations?: Record<string, string[]>;
  meta: { scale: number; size: { w: number; h: number }; image: string };
}
interface Atlas {
  json: SheetJson;
  png: DecodedPng;
}

const cache = new Map<string, Atlas>();
/** Lazy: loaded inside tests so a missing file fails the test, not collection. */
function atlas(png: string): Atlas {
  let hit = cache.get(png);
  if (!hit) {
    const json = JSON.parse(readFileSync(join(ASSETS, png.replace('.png', '.json')), 'utf8'));
    hit = { json, png: decodePng(new Uint8Array(readFileSync(join(ASSETS, png)))) };
    cache.set(png, hit);
  }
  return hit;
}
const albedo = (): Atlas => atlas(TERRAIN_KIT_FILE);
const normal = (): Atlas => atlas(TERRAIN_KIT_NORMAL_FILE);

const CLASSES = Object.keys(TERRAIN_KIT_CLASSES) as TerrainKitClass[];
const WATER: TerrainKitClass[] = ['ShallowWater', 'DeepWater'];

/** RGBA bytes of one frame, copied out of the sheet. */
function framePixels(a: Atlas, key: string): Uint8Array {
  const entry = a.json.frames[key];
  if (!entry) throw new Error(`frame key missing from json: ${key}`);
  const { x, y, w, h } = entry.frame;
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * a.png.width + x) * 4;
    out.set(a.png.rgba.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}
const sig = (px: Uint8Array): string => Buffer.from(px).toString('base64');

function distinct(a: Atlas, keys: readonly string[]): number {
  return new Set(keys.map((k) => sig(framePixels(a, k)))).size;
}

function lin(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
/** Rec. 709 relative luminance of an 8-bit sRGB pixel. */
const lum = (r: number, g: number, b: number): number =>
  0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/** Mean Y over the OPAQUE (alpha > 0, unweighted) pixels of all base frames of a class. */
function classY(cls: TerrainKitClass): number {
  let sum = 0;
  let n = 0;
  for (const key of TERRAIN_KIT_CLASSES[cls].variants) {
    const px = framePixels(albedo(), key);
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      sum += lum(px[i], px[i + 1], px[i + 2]);
      n++;
    }
  }
  return n === 0 ? Number.NaN : sum / n;
}

interface Thumb {
  w: number;
  h: number;
  meanY: number;
  meanG: number;
  meanB: number;
}
/** 4x4-tile patch (tile (tx,ty) -> variants[(tx + 2ty) % n]) box-downsampled 8x8 -> 16x16. */
function thumb(cls: TerrainKitClass): Thumb {
  const vars = TERRAIN_KIT_CLASSES[cls].variants.map((k) => framePixels(albedo(), k));
  const S = 128;
  const patch = new Uint8Array(S * S * 4);
  for (let ty = 0; ty < 4; ty++) {
    for (let tx = 0; tx < 4; tx++) {
      const src = vars[(tx + 2 * ty) % vars.length];
      for (let row = 0; row < 32; row++) {
        patch.set(src.subarray(row * 128, row * 128 + 128), ((ty * 32 + row) * S + tx * 32) * 4);
      }
    }
  }
  const T = 16;
  let sumY = 0;
  let sumG = 0;
  let sumB = 0;
  for (let by = 0; by < T; by++) {
    for (let bx = 0; bx < T; bx++) {
      const acc = [0, 0, 0];
      for (let dy = 0; dy < 8; dy++) {
        for (let dx = 0; dx < 8; dx++) {
          const at = ((by * 8 + dy) * S + bx * 8 + dx) * 4;
          for (let c = 0; c < 3; c++) acc[c] += patch[at + c];
        }
      }
      const [r, g, b] = acc.map((v) => v / 64);
      sumY += lum(r, g, b);
      sumG += g;
      sumB += b;
    }
  }
  const n = T * T;
  return { w: T, h: T, meanY: sumY / n, meanG: sumG / n, meanB: sumB / n };
}

const PAIRS: ReadonlyArray<readonly [TerrainKitClass, TerrainKitClass]> = [
  ['Floor', 'TallGrass'],
  ['Floor', 'Path'],
  ['Floor', 'Sand'],
  ['Path', 'Sand'],
  ['Sand', 'ShallowWater'],
  ['ShallowWater', 'DeepWater'],
  ['Floor', 'ShallowWater'],
  ['TallGrass', 'ShallowWater'],
  ['Floor', 'Rock'],
  ['Floor', 'Tree'],
  ['Floor', 'Bush'],
  ['TallGrass', 'Bush'],
  ['Floor', 'Wall'],
  ['Path', 'Wall'],
  ['Sand', 'Rock'],
];

const shoreKeys = (): string[] => Object.values(TERRAIN_KIT_SHORE);
const animKeys = (): string[] =>
  WATER.flatMap((c) => [...(TERRAIN_KIT_CLASSES[c].animation ?? [])]);
const variantKeys = (): string[] => CLASSES.flatMap((c) => [...TERRAIN_KIT_CLASSES[c].variants]);
const allKeys = (): string[] => [...variantKeys(), ...animKeys(), ...shoreKeys()];

type Side = 'n' | 'e' | 's' | 'w';
const STRIP: Record<Side, Rect> = {
  n: { x: 0, y: 0, w: 32, h: 4 },
  s: { x: 0, y: 28, w: 32, h: 4 },
  w: { x: 0, y: 0, w: 4, h: 32 },
  e: { x: 28, y: 0, w: 4, h: 32 },
};
const CORNER: Record<'ne' | 'nw' | 'se' | 'sw', Rect> = {
  nw: { x: 0, y: 0, w: 4, h: 4 },
  ne: { x: 28, y: 0, w: 4, h: 4 },
  sw: { x: 0, y: 28, w: 4, h: 4 },
  se: { x: 28, y: 28, w: 4, h: 4 },
};
const OPPOSITE: Record<Side, Side> = { n: 's', s: 'n', e: 'w', w: 'e' };
const FLIP: Record<'ne' | 'nw' | 'se' | 'sw', 'ne' | 'nw' | 'se' | 'sw'> = {
  ne: 'sw',
  sw: 'ne',
  nw: 'se',
  se: 'nw',
};

/** 'land' when mean G > mean B, 'water' when mean B > mean G, over a frame region. */
function region(px: Uint8Array, r: Rect): 'land' | 'water' | 'tie' {
  let g = 0;
  let b = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      g += px[(y * 32 + x) * 4 + 1];
      b += px[(y * 32 + x) * 4 + 2];
    }
  }
  if (g > b) return 'land';
  return b > g ? 'water' : 'tie';
}

describe('WAP2.1 kit atlas contents', () => {
  it('WAP2.1 every kit frame is fully opaque (alpha 255 on every pixel)', () => {
    for (const k of allKeys()) {
      const px = framePixels(albedo(), k);
      for (let i = 3; i < px.length; i += 4) {
        if (px[i] !== 255) expect(px[i], `${k} pixel ${(i - 3) / 4} alpha`).toBe(255);
      }
    }
  });

  it('WAP2.1 shore frames put land on the named side and water on the opposite side', () => {
    for (const [slot, key] of Object.entries(TERRAIN_KIT_SHORE)) {
      const px = framePixels(albedo(), key);
      const at = (r: Rect): string => region(px, r);
      if (slot.length === 1) {
        const s = slot as Side;
        expect(at(STRIP[s]), `${slot} named strip`).toBe('land');
        expect(at(STRIP[OPPOSITE[s]]), `${slot} opposite strip`).toBe('water');
      } else if (slot.startsWith('inner_')) {
        const c = slot.slice(6) as keyof typeof CORNER;
        expect(at(CORNER[c]), `${slot} notch`).toBe('land');
        expect(at(STRIP[c[0] === 'n' ? 's' : 'n']), `${slot} opposite ns strip`).toBe('water');
        expect(at(STRIP[c[1] === 'e' ? 'w' : 'e']), `${slot} opposite ew strip`).toBe('water');
      } else {
        const c = slot as keyof typeof CORNER;
        expect(at(STRIP[c[0] as Side]), `${slot} ns strip`).toBe('land');
        expect(at(STRIP[c[1] as Side]), `${slot} ew strip`).toBe('land');
        expect(at(CORNER[FLIP[c]]), `${slot} opposite corner`).toBe('water');
      }
    }
  });

  it('WAP2.1 atlas is scale 1, every frame 32x32 inside the sheet, and meta.size matches the PNG', () => {
    const { json, png } = albedo();
    expect(json.meta.scale).toBe(1);
    expect(json.meta.size).toEqual({ w: png.width, h: png.height });
    const entries = Object.values(json.frames);
    expect(entries.length).toBeGreaterThan(0);
    for (const { frame } of entries) {
      expect([frame.w, frame.h]).toEqual([32, 32]);
      expect(frame.x).toBeGreaterThanOrEqual(0);
      expect(frame.y).toBeGreaterThanOrEqual(0);
      expect(frame.x + frame.w).toBeLessThanOrEqual(png.width);
      expect(frame.y + frame.h).toBeLessThanOrEqual(png.height);
    }
  });

  it('WAP2.1 all ten classes exist, each with at least three present, pairwise-distinct variants', () => {
    expect([...CLASSES].sort()).toEqual(
      [
        'Bush',
        'DeepWater',
        'Floor',
        'Path',
        'Rock',
        'Sand',
        'ShallowWater',
        'TallGrass',
        'Tree',
        'Wall',
      ].sort(),
    );
    for (const cls of CLASSES) {
      const { variants } = TERRAIN_KIT_CLASSES[cls];
      expect(variants.length, `${cls} variant count`).toBeGreaterThanOrEqual(3);
      for (const k of variants) expect(albedo().json.frames[k], `${cls}:${k}`).toBeDefined();
      expect(distinct(albedo(), variants), `${cls} distinct variants`).toBe(variants.length);
    }
  });

  it('WAP2.1 each water class has exactly four present, pairwise-distinct animation frames matching json animations', () => {
    for (const cls of WATER) {
      const anim = TERRAIN_KIT_CLASSES[cls].animation;
      expect(anim, `${cls} animation`).toBeDefined();
      expect(anim?.length).toBe(4);
      for (const k of anim ?? []) expect(albedo().json.frames[k], `${cls}:${k}`).toBeDefined();
      expect(distinct(albedo(), anim ?? []), `${cls} distinct anim`).toBe(4);
      const listed = Object.values(albedo().json.animations ?? {});
      expect(listed, `${cls} json animations entry`).toContainEqual([...(anim ?? [])]);
    }
  });

  it('WAP2.1 non-water classes carry no animation frames', () => {
    for (const cls of CLASSES.filter((c) => !WATER.includes(c))) {
      expect(TERRAIN_KIT_CLASSES[cls].animation, cls).toBeUndefined();
    }
  });

  it('WAP2.1 all twelve shore slots map to present, pairwise-distinct frames', () => {
    expect(Object.keys(TERRAIN_KIT_SHORE).sort()).toEqual(
      [
        'e',
        'inner_ne',
        'inner_nw',
        'inner_se',
        'inner_sw',
        'n',
        'ne',
        'nw',
        's',
        'se',
        'sw',
        'w',
      ].sort(),
    );
    for (const k of shoreKeys()) expect(albedo().json.frames[k], k).toBeDefined();
    expect(distinct(albedo(), shoreKeys())).toBe(12);
  });

  it('WAP2.1 shore frames are genuine water-meets-land blends, not copies of a plain water or ground frame', () => {
    const plain = new Set(
      [...TERRAIN_KIT_CLASSES.ShallowWater.variants, ...TERRAIN_KIT_CLASSES.Floor.variants].map(
        (k) => sig(framePixels(albedo(), k)),
      ),
    );
    for (const k of shoreKeys()) {
      expect(plain.has(sig(framePixels(albedo(), k))), `${k} duplicates a plain frame`).toBe(false);
    }
  });

  it('WAP2.1 every manifest frame key is unique (no frame serves two roles)', () => {
    const keys = allKeys();
    expect(keys.length).toBeGreaterThanOrEqual(CLASSES.length * 3 + 8 + 12);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('WAP2.2 readability pairs', () => {
  it('WAP2.2 measured class luminance is finite in (0,1) and printed for the style guide', () => {
    const rows = CLASSES.map((c) => ({ class: c, Y: Number(classY(c).toFixed(4)) }));
    console.log(
      `WAP2.2 class mean relative luminance (Rec. 709)\n${JSON.stringify(rows, null, 1)}`,
    );
    for (const { class: c, Y } of rows) {
      expect(Number.isFinite(Y), c).toBe(true);
      expect(Y, c).toBeGreaterThan(0);
      expect(Y, c).toBeLessThan(1);
    }
  });

  it('WAP2.2 every readability pair differs in mean luminance by at least 0.06', () => {
    for (const [a, b] of PAIRS) {
      const ya = classY(a);
      const yb = classY(b);
      const d = Math.abs(ya - yb);
      expect(
        d,
        `${a} (Y=${ya.toFixed(4)}) vs ${b} (Y=${yb.toFixed(4)}) delta=${d.toFixed(4)}`,
      ).toBeGreaterThanOrEqual(0.06);
    }
  });
});

describe('WAP2.3 16px thumbnail readability', () => {
  it('WAP2.3 water and ground 4x4-tile patches downsample to 16x16 thumbnails', () => {
    for (const cls of ['ShallowWater', 'Floor'] as const) {
      const t = thumb(cls);
      expect([t.w, t.h]).toEqual([16, 16]);
    }
  });

  it('WAP2.3 water and ground thumbnails differ in mean luminance by at least 0.06', () => {
    const w = thumb('ShallowWater');
    const g = thumb('Floor');
    const d = Math.abs(w.meanY - g.meanY);
    expect(
      d,
      `water Y=${w.meanY.toFixed(4)} ground Y=${g.meanY.toFixed(4)}`,
    ).toBeGreaterThanOrEqual(0.06);
  });

  it('WAP2.3 the water thumbnail is bluer than it is green', () => {
    const w = thumb('ShallowWater');
    expect(
      w.meanB,
      `mean blue ${w.meanB.toFixed(2)} vs green ${w.meanG.toFixed(2)}`,
    ).toBeGreaterThan(w.meanG);
  });
});

describe('WAP2.4 normal atlas and provenance', () => {
  it('WAP2.4 normal atlas has the same frame keys and byte-identical rects as the albedo atlas', () => {
    const a = albedo().json.frames;
    const n = normal().json.frames;
    expect(Object.keys(n).sort()).toEqual(Object.keys(a).sort());
    for (const k of Object.keys(a)) {
      expect(n[k].frame, `${k} frame`).toEqual(a[k].frame);
      expect(n[k].sourceSize, `${k} sourceSize`).toEqual(a[k].sourceSize);
      expect(n[k].spriteSourceSize, `${k} spriteSourceSize`).toEqual(a[k].spriteSourceSize);
    }
  });

  it('WAP2.4 normal atlas meta.size and decoded PNG size equal the albedo atlas', () => {
    expect(normal().json.meta.size).toEqual(albedo().json.meta.size);
    expect([normal().png.width, normal().png.height]).toEqual([
      albedo().png.width,
      albedo().png.height,
    ]);
  });

  it('WAP2.4 normal frames are real tangent-space normals, not copies of the albedo', () => {
    for (const k of allKeys()) {
      const n = framePixels(normal(), k);
      expect(sig(n), `${k} identical to albedo`).not.toBe(sig(framePixels(albedo(), k)));
      let blue = 0;
      for (let i = 0; i < n.length; i += 4) blue += n[i + 2];
      expect(blue / (n.length / 4), `${k} mean blue`).toBeGreaterThan(128);
    }
  });

  it('WAP2.4 normal frames carry surface detail (R and G channels vary, not a flat map)', () => {
    const { rgba } = normal().png;
    for (const [name, off] of [
      ['R', 0],
      ['G', 1],
    ] as const) {
      const n = rgba.length / 4;
      let sum = 0;
      let sumSq = 0;
      for (let i = off; i < rgba.length; i += 4) {
        sum += rgba[i];
        sumSq += rgba[i] * rgba[i];
      }
      const variance = sumSq / n - (sum / n) ** 2;
      expect(variance, `${name} channel variance`).toBeGreaterThan(0);
    }
  });

  it('WAP2.4 TERRAIN_PACK has one tile row and one normal row for the kit, sized to the decoded PNGs', () => {
    const tile = TERRAIN_PACK.filter((r) => r.file === TERRAIN_KIT_FILE);
    const norm = TERRAIN_PACK.filter((r) => r.file === TERRAIN_KIT_NORMAL_FILE);
    expect(tile.length).toBe(1);
    expect(norm.length).toBe(1);
    expect(tile[0].kind).toBe('tile');
    expect(norm[0].kind).toBe('normal');
    for (const [row, a] of [
      [tile[0], albedo()],
      [norm[0], normal()],
    ] as const) {
      expect(row.sheet).toEqual({ w: a.png.width, h: a.png.height });
      expect(row.frame).toEqual({ w: 32, h: 32 });
      expect(row.scale).toBe(1);
    }
  });

  it('WAP2.4 the kit rows pass validateArtRegistry alone and inside the full registry', () => {
    const rows = TERRAIN_PACK.filter(
      (r) => r.file === TERRAIN_KIT_FILE || r.file === TERRAIN_KIT_NORMAL_FILE,
    );
    expect(rows.length).toBe(2);
    expect(validateArtRegistry(rows)).toEqual([]);
    expect(validateArtRegistry(ART_REGISTRY)).toEqual([]);
    expect(ART_REGISTRY.filter((r) => rows.some((k) => k.key === r.key)).length).toBe(2);
  });
});
