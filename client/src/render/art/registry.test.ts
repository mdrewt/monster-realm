import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      // @ts-expect-error share-alike license is not representable
      license: 'CC-BY-SA-4.0',
    };
    const eula: ArtRow = {
      ...hero,
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
