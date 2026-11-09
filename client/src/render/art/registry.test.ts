import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, readPngSize } from '../../../test-util/pngDecode';
import { ART_REGISTRY, type ArtRow, validateArtRegistry } from './registry';

const CLIENT_ROOT = join(import.meta.dirname, '..', '..', '..');
const REPO_ROOT = join(CLIENT_ROOT, '..');
const ASSETS = join(CLIENT_ROOT, 'public', 'assets');

const hero: ArtRow = {
  key: 'characters/hero',
  file: 'hero.png',
  kind: 'sprite',
  sheet: { w: 64, h: 64 },
  frame: { w: 32, h: 32 },
  scale: 1,
  source: 'client/art-src/generate_art.py',
  provenance: 'placeholder-procedural',
  license: 'project-original',
};
const palette: ArtRow = {
  key: 'terrain/palette',
  file: 'palette.png',
  kind: 'palette',
  sheet: { w: 16, h: 1 },
  scale: 1,
  source: 'client/art-src/generate_art.py',
  provenance: 'placeholder-procedural',
  license: 'project-original',
};
const tile: ArtRow = {
  key: 'terrain/grass',
  file: 'grass.png',
  kind: 'tile',
  sheet: { w: 32, h: 32 },
  frame: { w: 16, h: 16 },
  scale: 1,
  source: 'client/art-src/generate_art.py',
  provenance: 'placeholder-procedural',
  license: 'project-original',
};
const mk = (base: ArtRow, over: Record<string, unknown>): ArtRow =>
  ({ ...base, ...over }) as unknown as ArtRow;

describe('WAP0.2 registry row type', () => {
  it('WAP0.2 makes forbidden provenance, license and shape rows unrepresentable', () => {
    // Each fixture is a deliberately ill-typed row; @ts-expect-error fails tsc if it becomes legal.
    const aiProvenance: ArtRow = {
      ...hero,
      // @ts-expect-error ai-placeholder provenance is not representable
      provenance: 'ai-placeholder',
    };
    const shareAlike: ArtRow = {
      ...hero,
      attribution: 'x',
      // @ts-expect-error share-alike license is not representable
      license: 'CC-BY-SA-4.0',
    };
    const eula: ArtRow = {
      ...hero,
      attribution: 'x',
      // @ts-expect-error EULA license is not representable
      license: 'EULA',
    };
    // @ts-expect-error a row without a source is not representable
    const noSource: ArtRow = {
      key: 'characters/hero',
      file: 'hero.png',
      kind: 'sprite',
      sheet: { w: 64, h: 64 },
      frame: { w: 32, h: 32 },
      scale: 1,
      provenance: 'placeholder-procedural',
      license: 'project-original',
    };
    // @ts-expect-error a row without a license is not representable
    const noLicense: ArtRow = {
      key: 'characters/hero',
      file: 'hero.png',
      kind: 'sprite',
      sheet: { w: 64, h: 64 },
      frame: { w: 32, h: 32 },
      scale: 1,
      source: 'client/art-src/generate_art.py',
      provenance: 'placeholder-procedural',
    };
    // @ts-expect-error a row without a provenance is not representable
    const noProvenance: ArtRow = {
      key: 'characters/hero',
      file: 'hero.png',
      kind: 'sprite',
      sheet: { w: 64, h: 64 },
      frame: { w: 32, h: 32 },
      scale: 1,
      source: 'client/art-src/generate_art.py',
      license: 'project-original',
    };
    // @ts-expect-error a CC-BY row without an attribution is not representable
    const ccByNoAttribution: ArtRow = {
      key: 'characters/hero',
      file: 'hero.png',
      kind: 'sprite',
      sheet: { w: 64, h: 64 },
      frame: { w: 32, h: 32 },
      scale: 1,
      source: 'https://example.invalid/pack',
      provenance: 'placeholder-licensed',
      license: 'CC-BY-4.0',
    };
    // @ts-expect-error a palette row must not carry a frame
    const paletteWithFrame: ArtRow = {
      key: 'terrain/palette',
      file: 'palette.png',
      kind: 'palette',
      sheet: { w: 16, h: 1 },
      frame: { w: 16, h: 16 },
      scale: 1,
      source: 'client/art-src/generate_art.py',
      provenance: 'placeholder-procedural',
      license: 'project-original',
    };
    // @ts-expect-error a sprite row without a frame is not representable
    const spriteNoFrame: ArtRow = {
      key: 'characters/hero',
      file: 'hero.png',
      kind: 'sprite',
      sheet: { w: 64, h: 64 },
      scale: 1,
      source: 'client/art-src/generate_art.py',
      provenance: 'placeholder-procedural',
      license: 'project-original',
    };
    expect(
      [
        aiProvenance,
        shareAlike,
        eula,
        noSource,
        noLicense,
        noProvenance,
        ccByNoAttribution,
        paletteWithFrame,
        spriteNoFrame,
      ].length,
    ).toBe(9);
    // A well-typed attributed CC-BY row and the valid fixtures are accepted.
    const ccBy: ArtRow = {
      ...hero,
      key: 'characters/ccby',
      file: 'ccby.png',
      provenance: 'placeholder-licensed',
      license: 'CC-BY-4.0',
      attribution: 'Jane Artist, CC-BY 4.0',
    };
    expect(validateArtRegistry([hero, palette, tile, ccBy])).toEqual([]);
  });
});

describe('WAP0.3 validateArtRegistry', () => {
  it('WAP0.3 accepts a valid registry', () => {
    expect(validateArtRegistry([hero, palette, tile])).toEqual([]);
    expect(validateArtRegistry([])).toEqual([]);
  });

  it('WAP0.3 rejects a duplicate key and names the later row', () => {
    const dup = mk(tile, { key: 'characters/hero', file: 'other.png' });
    expect(validateArtRegistry([hero, palette, dup])).toEqual([
      { key: 'characters/hero', file: 'other.png', reason: 'duplicate-key' },
    ]);
  });

  it('WAP0.3 rejects a duplicate file and names the later row', () => {
    const dup = mk(tile, { key: 'terrain/other', file: 'hero.png' });
    expect(validateArtRegistry([hero, palette, dup])).toEqual([
      { key: 'terrain/other', file: 'hero.png', reason: 'duplicate-file' },
    ]);
  });

  it.each([
    ['width off-grid', { w: 32, h: 16 + 16 }, { w: 40, h: 32 }],
    ['height off-grid', { w: 32, h: 32 }, { w: 32, h: 40 }],
    ['zero width', { w: 16, h: 16 }, { w: 0, h: 16 }],
    ['zero height', { w: 16, h: 16 }, { w: 16, h: 0 }],
    ['negative width', { w: 16, h: 16 }, { w: -16, h: 16 }],
    ['negative height', { w: 16, h: 16 }, { w: 16, h: -16 }],
  ])('WAP0.3 rejects a frame with %s and names the row', (_n, _ok, bad) => {
    for (const base of [hero, tile, mk(hero, { kind: 'normal' })]) {
      const offender = mk(base, { key: 'characters/bad', file: 'bad.png', frame: bad });
      expect(validateArtRegistry([palette, hero, offender])).toEqual([
        { key: 'characters/bad', file: 'bad.png', reason: 'frame-off-grid' },
      ]);
    }
  });

  it('WAP0.3 accepts a palette or lut with no frame', () => {
    const lut = mk(palette, { key: 'grade/lut', file: 'lut.png', kind: 'lut' });
    expect(validateArtRegistry([palette, lut])).toEqual([]);
  });

  it.each([2, 0.5, 0])('WAP0.3 rejects scale %s and names the row', (scale) => {
    const offender = mk(tile, { key: 'terrain/scaled', file: 'scaled.png', scale });
    expect(validateArtRegistry([hero, palette, offender])).toEqual([
      { key: 'terrain/scaled', file: 'scaled.png', reason: 'scale-not-1' },
    ]);
  });

  it.each([
    'Hero',
    'characters/Hero',
    'hero',
    'characters/',
    'characters/1up',
    'nopack/hero',
  ])('WAP0.3 rejects malformed key %s and names the row', (key) => {
    const offender = mk(hero, { key, file: 'm.png' });
    expect(validateArtRegistry([palette, offender])).toEqual([
      { key, file: 'm.png', reason: 'malformed-key' },
    ]);
  });

  it('WAP0.3 rejects a CC-BY row with an empty attribution and names the row', () => {
    const offender = mk(hero, {
      key: 'characters/ccby',
      file: 'ccby.png',
      provenance: 'placeholder-licensed',
      license: 'CC-BY-4.0',
      attribution: '',
    });
    expect(validateArtRegistry([palette, offender])).toEqual([
      { key: 'characters/ccby', file: 'ccby.png', reason: 'empty-attribution' },
    ]);
  });

  it.each([
    ['CC-BY-4.0', '   '],
    ['CC-BY-3.0', ''],
    ['CC-BY-3.0', '  \t '],
  ])('WAP0.3 rejects %s with blank attribution %j and names the row', (license, attribution) => {
    const offender = mk(hero, {
      key: 'characters/ccby',
      file: 'ccby.png',
      provenance: 'placeholder-licensed',
      license,
      attribution,
    });
    expect(validateArtRegistry([palette, offender])).toEqual([
      { key: 'characters/ccby', file: 'ccby.png', reason: 'empty-attribution' },
    ]);
  });

  it('WAP0.3 rejects a CC-BY row with an absent attribution without throwing', () => {
    const offender = mk(hero, {
      key: 'characters/ccby',
      file: 'ccby.png',
      provenance: 'placeholder-licensed',
      license: 'CC-BY-4.0',
    });
    expect('attribution' in offender).toBe(false);
    expect(validateArtRegistry([palette, offender])).toEqual([
      { key: 'characters/ccby', file: 'ccby.png', reason: 'empty-attribution' },
    ]);
  });

  it.each([
    'characters/a-b',
    'characters/ok!',
    'characters/hero ',
    'characters/hero\n',
  ])('WAP0.3 rejects malformed key with trailing junk %j', (key) => {
    const offender = mk(hero, { key, file: 'm.png' });
    expect(validateArtRegistry([palette, offender])).toEqual([
      { key, file: 'm.png', reason: 'malformed-key' },
    ]);
  });

  it.each(['', '   '])('WAP0.3 rejects blank source %j and names the row', (source) => {
    const offender = mk(hero, { key: 'characters/bad', file: 'bad.png', source });
    expect(validateArtRegistry([palette, offender])).toEqual([
      { key: 'characters/bad', file: 'bad.png', reason: 'empty-source' },
    ]);
  });

  it.each([
    './hero.png',
    'Hero.png',
    'a//b.png',
    'hero.PNG',
    'hero.json',
    '../x.png',
    '',
  ])('WAP0.3 rejects malformed file %j and names the row', (file) => {
    const offender = mk(hero, { key: 'characters/bad', file });
    expect(validateArtRegistry([palette, offender])).toEqual([
      { key: 'characters/bad', file, reason: 'malformed-file' },
    ]);
  });

  it.each([
    'hero.png',
    'tileset-edge-of-town.png',
    'sub/dir_1/x-y.png',
  ])('WAP0.3 accepts well-formed file %j', (file) => {
    const row = mk(hero, { key: 'characters/good', file });
    expect(validateArtRegistry([palette, row])).toEqual([]);
  });

  it.each([
    ['placeholder-procedural', 'CC0-1.0'],
    ['placeholder-licensed', 'project-original'],
  ])('WAP0.3 rejects provenance %s with license %s as a mismatch', (provenance, license) => {
    const offender = mk(hero, { key: 'characters/bad', file: 'bad.png', provenance, license });
    expect(validateArtRegistry([palette, offender])).toEqual([
      { key: 'characters/bad', file: 'bad.png', reason: 'provenance-license-mismatch' },
    ]);
  });

  it.each([
    ['final', 'project-original'],
    ['final', 'CC0-1.0'],
    ['placeholder-licensed', 'CC0-1.0'],
  ])('WAP0.3 accepts provenance %s with license %s', (provenance, license) => {
    const row = mk(hero, { key: 'characters/good', file: 'good.png', provenance, license });
    expect(validateArtRegistry([palette, row])).toEqual([]);
  });
});

const GEN_SOURCE = /^(?<path>[^@\s]+\.py)(?:@(?<sha>[0-9a-f]{7,40}))?$/;

function servedPngs(): string[] {
  return (readdirSync(ASSETS, { recursive: true, encoding: 'utf8' }) as string[])
    .map((p) => p.split('\\').join('/'))
    .filter((p) => p.endsWith('.png'));
}

describe('WAP0.4 the real registry matches the served assets', () => {
  it('WAP0.4 validateArtRegistry accepts ART_REGISTRY', () => {
    expect(validateArtRegistry(ART_REGISTRY)).toEqual([]);
  });

  it('WAP0.4 every row file exists with PNG dimensions equal to its sheet', () => {
    for (const row of ART_REGISTRY) {
      const path = join(ASSETS, row.file);
      expect(existsSync(path), row.key).toBe(true);
      const bytes = new Uint8Array(readFileSync(path));
      expect(readPngSize(bytes), row.key).toEqual(row.sheet);
      const decoded = decodePng(bytes);
      expect(decoded.width, row.key).toBe(row.sheet.w);
      expect(decoded.height, row.key).toBe(row.sheet.h);
      expect(decoded.rgba.length, row.key).toBe(row.sheet.w * row.sheet.h * 4);
    }
  });

  it('WAP0.4 every served PNG is named by exactly one row', () => {
    const served = servedPngs();
    expect(served.length).toBeGreaterThan(0);
    for (const rel of served) {
      expect(ART_REGISTRY.filter((r) => r.file === rel).length, rel).toBe(1);
    }
  });

  it('WAP0.4 sprite/tile/normal sheets are whole multiples of the frame', () => {
    for (const row of ART_REGISTRY) {
      if (row.kind !== 'sprite' && row.kind !== 'tile' && row.kind !== 'normal') continue;
      expect(row.frame, row.key).toBeDefined();
      if (!row.frame) continue;
      expect(row.sheet.w % row.frame.w, row.key).toBe(0);
      expect(row.sheet.h % row.frame.h, row.key).toBe(0);
    }
  });

  it('WAP0.4 a sibling generator json agrees with the row scale and sheet', () => {
    let checked = 0;
    for (const row of ART_REGISTRY) {
      const jsonPath = join(ASSETS, row.file.replace(/\.png$/, '.json'));
      if (!existsSync(jsonPath)) continue;
      const meta = JSON.parse(readFileSync(jsonPath, 'utf8')).meta;
      expect(meta.scale, row.key).toBe(row.scale);
      expect(meta.size, row.key).toEqual(row.sheet);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('WAP0.4 every sprite/tile/normal row has a sibling json whose frames match the row frame', () => {
    for (const row of ART_REGISTRY) {
      if (row.kind !== 'sprite' && row.kind !== 'tile' && row.kind !== 'normal') continue;
      const jsonPath = join(ASSETS, row.file.replace(/\.png$/, '.json'));
      expect(existsSync(jsonPath), `${row.key}: sibling json`).toBe(true);
      const frames = Object.values(JSON.parse(readFileSync(jsonPath, 'utf8')).frames ?? {});
      expect(frames.length, row.key).toBeGreaterThan(0);
      for (const entry of frames as {
        frame?: { w: number; h: number };
        w?: number;
        h?: number;
      }[]) {
        const f = entry.frame ?? entry;
        expect(f.w, row.key).toBe(row.frame?.w);
        expect(f.h, row.key).toBe(row.frame?.h);
      }
    }
  });

  it('WAP0.4 a file ends with -normal.png iff its kind is normal', () => {
    for (const row of ART_REGISTRY) {
      expect(row.file.endsWith('-normal.png'), row.key).toBe(row.kind === 'normal');
    }
  });

  it('WAP0.4 decoded row pixels are real: some opaque pixel and at least two distinct values', () => {
    expect(ART_REGISTRY.length).toBeGreaterThan(0);
    for (const row of ART_REGISTRY) {
      const { rgba } = decodePng(new Uint8Array(readFileSync(join(ASSETS, row.file))));
      let anyAlpha = false;
      const seen = new Set<string>();
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3] > 0) anyAlpha = true;
        seen.add(`${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},${rgba[i + 3]}`);
      }
      expect(anyAlpha, row.key).toBe(true);
      expect(seen.size, row.key).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('WAP0.5 existing assets are registered as project-original placeholders', () => {
  it('WAP0.5 every served PNG row is placeholder-procedural / project-original', () => {
    for (const rel of servedPngs()) {
      const row = ART_REGISTRY.find((r) => r.file === rel);
      expect(row, rel).toBeDefined();
      expect(row?.provenance, rel).toBe('placeholder-procedural');
      expect(row?.license, rel).toBe('project-original');
    }
  });

  it('WAP0.5 every placeholder-procedural row names a generator path as source', () => {
    const procedural = ART_REGISTRY.filter((r) => r.provenance === 'placeholder-procedural');
    expect(procedural.length).toBeGreaterThan(0);
    for (const row of procedural) {
      expect(row.license, row.key).toBe('project-original');
      const m = GEN_SOURCE.exec(row.source ?? '');
      expect(m, `${row.key}: ${row.source}`).not.toBeNull();
      const path = m?.groups?.path ?? '';
      expect(path.startsWith('/') || path.startsWith('..'), row.key).toBe(false);
      if (!m?.groups?.sha) {
        expect(existsSync(join(REPO_ROOT, path)), `${row.key}: ${path}`).toBe(true);
      }
    }
  });
});

interface BuildPng {
  width: number;
  height: number;
  colorType: number;
  bitDepth?: number;
  interlace?: number;
  rows: { filter: number; bytes: number[] }[];
  splitIdat?: boolean;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// chunk = length(4, BE) + type(4) + data + crc(4); the CRC stays zero (decoder ignores it).
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  return out;
}

function buildPng(spec: BuildPng): Uint8Array {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(spec.width, 0);
  ihdr.writeUInt32BE(spec.height, 4);
  ihdr[8] = spec.bitDepth ?? 8;
  ihdr[9] = spec.colorType;
  ihdr[12] = spec.interlace ?? 0;
  const raw = Buffer.from(spec.rows.flatMap((r) => [r.filter, ...r.bytes]));
  const z = deflateSync(raw);
  const idats = spec.splitIdat
    ? [
        chunk('IDAT', z.subarray(0, Math.floor(z.length / 2))),
        chunk('IDAT', z.subarray(Math.floor(z.length / 2))),
      ]
    : [chunk('IDAT', z)];
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(SIGNATURE),
      chunk('IHDR', ihdr),
      ...idats,
      chunk('IEND', new Uint8Array(0)),
    ]),
  );
}

// Target 3x3 RGBA grid (row-major), pixels as (r,g,b,a):
//   row0: (10,20,30,255) (250,30,40,255) (5,200,60,128)
//   row1: (20,10,40,0)   (0,255,50,255)  (255,0,70,100)
//   row2: (60,30,30,30)  (40,5,100,255)  (10,77,90,99)
// filtered = (target - predictor) & 0xff.
//   row0 Sub (left, 0 for first px): px1 = target - px0; px2 = target - px1 (wraps: 5-250 -> 11, 128-255 -> 129).
//   row1 Up: target - row0 (wraps: 10-20 -> 246, 0-255 -> 1, 0-250 -> 6, 0-200 -> 56, 100-128 -> 228).
//   row2 Paeth: px0 predictor = up. px1 R: a=60,b=0,c=20 -> pa=20,pb=40,pc=20, pa===pc tie must pick a.
//   px1 G picks b=255, px1 B (a=30,b=50,c=40) picks c=40, A picks b=255.
//   px2 R picks b=255, G picks b=0, B picks a=100, A picks b=100.
const GRID_3X3 = [
  10, 20, 30, 255, 250, 30, 40, 255, 5, 200, 60, 128, 20, 10, 40, 0, 0, 255, 50, 255, 255, 0, 70,
  100, 60, 30, 30, 30, 40, 5, 100, 255, 10, 77, 90, 99,
];
const ROWS_3X3 = [
  { filter: 1, bytes: [10, 20, 30, 255, 240, 10, 10, 0, 11, 170, 20, 129] },
  { filter: 2, bytes: [10, 246, 10, 1, 6, 225, 10, 0, 250, 56, 10, 228] },
  { filter: 4, bytes: [40, 20, 246, 30, 236, 6, 60, 0, 11, 77, 246, 255] },
];

describe('pngDecode shared helper', () => {
  it('WAP0.4 pngDecode reverses Sub, Up and Paeth filters with byte wraparound', () => {
    const png = buildPng({ width: 3, height: 3, colorType: 6, rows: ROWS_3X3 });
    const out = decodePng(png);
    expect([out.width, out.height]).toEqual([3, 3]);
    expect(Array.from(out.rgba)).toEqual(GRID_3X3);
  });

  it('WAP0.4 pngDecode Paeth breaks a pb===pc tie toward b', () => {
    // target: row0 (10,10,10,10) (20,20,20,20); row1 (5,5,5,5) (50,50,50,50)
    // row1 px0: a=0,b=10,c=0 -> predictor b=10, filtered 5-10 -> 251.
    // row1 px1: a=5,b=20,c=10 -> p=15, pa=10, pb=5, pc=5; pb===pc and b!==c must pick b=20,
    // so filtered = 50-20 = 30 (picking c=10 would decode 40).
    const png = buildPng({
      width: 2,
      height: 2,
      colorType: 6,
      rows: [
        { filter: 0, bytes: [10, 10, 10, 10, 20, 20, 20, 20] },
        { filter: 4, bytes: [251, 251, 251, 251, 30, 30, 30, 30] },
      ],
    });
    expect(Array.from(decodePng(png).rgba)).toEqual([
      10, 10, 10, 10, 20, 20, 20, 20, 5, 5, 5, 5, 50, 50, 50, 50,
    ]);
  });

  it('WAP0.4 pngDecode reverses Average (filter 3) after a None (filter 0) row', () => {
    // target: row0 (100,200,50,255) (10,0,255,128); row1 (7,201,255,0) (250,100,0,255)
    // row1 Average: px0 pred = floor(up/2) = (50,100,25,127); px1 pred = floor((left+up)/2) = (8,100,255,64).
    const png = buildPng({
      width: 2,
      height: 2,
      colorType: 6,
      rows: [
        { filter: 0, bytes: [100, 200, 50, 255, 10, 0, 255, 128] },
        { filter: 3, bytes: [213, 101, 230, 129, 242, 0, 1, 191] },
      ],
    });
    expect(Array.from(decodePng(png).rgba)).toEqual([
      100, 200, 50, 255, 10, 0, 255, 128, 7, 201, 255, 0, 250, 100, 0, 255,
    ]);
  });

  it('WAP0.4 pngDecode expands RGB (colorType 2) to opaque RGBA', () => {
    const png = buildPng({
      width: 2,
      height: 1,
      colorType: 2,
      rows: [{ filter: 0, bytes: [1, 2, 3, 250, 251, 252] }],
    });
    const out = decodePng(png);
    expect([out.width, out.height]).toEqual([2, 1]);
    expect(Array.from(out.rgba)).toEqual([1, 2, 3, 255, 250, 251, 252, 255]);
  });

  it('WAP0.4 pngDecode joins pixel data split across two IDAT chunks', () => {
    const png = buildPng({ width: 3, height: 3, colorType: 6, rows: ROWS_3X3, splitIdat: true });
    expect(Array.from(decodePng(png).rgba)).toEqual(GRID_3X3);
  });

  it('WAP0.4 pngDecode throws on a bad signature', () => {
    const png = buildPng({ width: 3, height: 3, colorType: 6, rows: ROWS_3X3 });
    png[0] = 0x88;
    expect(() => decodePng(png)).toThrow();
  });

  it('WAP0.4 pngDecode throws on an interlaced image', () => {
    const png = buildPng({ width: 3, height: 3, colorType: 6, interlace: 1, rows: ROWS_3X3 });
    expect(() => decodePng(png)).toThrow();
  });

  it('WAP0.4 pngDecode throws on a palette (colorType 3) image', () => {
    const png = buildPng({
      width: 2,
      height: 1,
      colorType: 3,
      rows: [{ filter: 0, bytes: [0, 1] }],
    });
    expect(() => decodePng(png)).toThrow();
  });

  it('WAP0.4 pngDecode throws on a 16-bit image', () => {
    const png = buildPng({
      width: 1,
      height: 1,
      colorType: 6,
      bitDepth: 16,
      rows: [{ filter: 0, bytes: [0, 0, 0, 0, 0, 0, 0, 0] }],
    });
    expect(() => decodePng(png)).toThrow();
  });

  it('WAP0.4 pngDecode throws when the inflated data is truncated', () => {
    const png = buildPng({
      width: 2,
      height: 2,
      colorType: 6,
      rows: [{ filter: 0, bytes: [1, 2, 3, 4, 5, 6, 7, 8] }],
    });
    expect(() => decodePng(png)).toThrow();
  });

  it('WAP0.4 pngDecode throws on an unknown filter byte', () => {
    const png = buildPng({
      width: 1,
      height: 1,
      colorType: 6,
      rows: [{ filter: 9, bytes: [1, 2, 3, 4] }],
    });
    expect(() => decodePng(png)).toThrow();
  });

  it('WAP0.4 readPngSize returns the IHDR width and height', () => {
    const png = buildPng({ width: 3, height: 3, colorType: 6, rows: ROWS_3X3 });
    expect(readPngSize(png)).toEqual({ w: 3, h: 3 });
    const wide = buildPng({
      width: 5,
      height: 1,
      colorType: 2,
      rows: [{ filter: 0, bytes: new Array(15).fill(7) }],
    });
    expect(readPngSize(wide)).toEqual({ w: 5, h: 1 });
  });

  it('WAP0.4 readPngSize throws on a bad signature', () => {
    const png = buildPng({ width: 3, height: 3, colorType: 6, rows: ROWS_3X3 });
    png[1] = 0x00;
    expect(() => readPngSize(png)).toThrow();
  });
});
