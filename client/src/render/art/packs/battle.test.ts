// render/art/packs/battle.test.ts — wap-3 WAP3.4: the battle backdrop row exists, is valid, and the
// generated PNG is a mid-tone image (the board's overlays and sprites must read over it).
//
// Measures the decoded PNG only; thresholds live here, never read from the style guide
// (Constraint 7b).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../../../../test-util/pngDecode';
import { ART_REGISTRY, validateArtRegistry } from '../registry';

const ASSETS = join(import.meta.dirname, '..', '..', '..', '..', 'public', 'assets');
const LUM_MIN = 0.15;
const LUM_MAX = 0.4;

function lin(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const lum = (r: number, g: number, b: number): number =>
  0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

describe('WAP3.4 battle backdrop art', () => {
  it('WAP3.4 ART_REGISTRY has exactly one frameless battle/backdrop row and the registry validates', () => {
    // WRONG IMPL KILLED: no row (the board has no backdrop url); a framed row (sprite/tile/normal,
    // which would demand a sibling json sheet the backdrop does not ship) or a row of the wrong
    // size; a duplicate key; a row that breaks provenance rules.
    const rows = ART_REGISTRY.filter((r) => r.key === 'battle/backdrop');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.file).toBe('battle-backdrop.png');
    expect(['palette', 'lut']).toContain(row.kind);
    expect('frame' in row).toBe(false);
    expect(row.sheet).toEqual({ w: 320, h: 192 });
    expect(row.scale).toBe(1);
    expect(row.source).toBe('client/art-src/generate_backdrop.py');
    expect(row.provenance).toBe('placeholder-procedural');
    expect(row.license).toBe('project-original');
    expect(validateArtRegistry(ART_REGISTRY)).toEqual([]);
  });

  it('WAP3.4 the backdrop PNG decodes at the row size, is not a flat fill, and has mean linear luminance in [0.15, 0.40]', () => {
    // WRONG IMPL KILLED: a missing file; a PNG whose size disagrees with the row; an all-black or
    // all-white backdrop (overlays and sprites vanish into it); a single flat colour.
    const row = ART_REGISTRY.find((r) => r.key === 'battle/backdrop');
    expect(row, 'battle/backdrop row').toBeDefined();
    const png = decodePng(new Uint8Array(readFileSync(join(ASSETS, row?.file ?? 'missing.png'))));
    expect({ w: png.width, h: png.height }).toEqual(row?.sheet);
    let sum = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const n = png.width * png.height;
    for (let i = 0; i < n; i++) {
      const y = lum(png.rgba[i * 4], png.rgba[i * 4 + 1], png.rgba[i * 4 + 2]);
      sum += y;
      min = Math.min(min, y);
      max = Math.max(max, y);
    }
    const mean = sum / n;
    expect(mean, `mean luminance ${mean.toFixed(4)}`).toBeGreaterThanOrEqual(LUM_MIN);
    expect(mean, `mean luminance ${mean.toFixed(4)}`).toBeLessThanOrEqual(LUM_MAX);
    expect(max - min, 'some pixel variance').toBeGreaterThan(0);
  });
});
