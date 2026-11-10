// render/art/packs/grade.test.ts — wap-9 (M-world-art-pass) WAP9.3: the grade pack registers the
// three LUT strips, and the committed PNGs obey the ColorMapFilter layout.
//
// ColorMapFilter layout (a `size^2 x size` strip): blue selects the slice, so the pixel for the
// lattice point (r, g, b) is at x = b * size + r, y = g. Each assertion below reads decoded PNG
// pixels, never the generator's text.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../../../../test-util/pngDecode';
import { validateArtRegistry } from '../registry';
import { GRADE_KEYFRAMES, GRADE_PACK, type GradeKeyframe, LUT_FILE, LUT_SIZE } from './grade';

const ASSETS = fileURLToPath(new URL('../../../../public/assets/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const GENERATOR = 'client/art-src/generate_luts.py';

function load(kf: GradeKeyframe) {
  return decodePng(new Uint8Array(readFileSync(`${ASSETS}${LUT_FILE[kf]}`)));
}

/** The pixel (r, g, b) channels of a strip. */
function texel(
  png: ReturnType<typeof load>,
  r: number,
  g: number,
  b: number,
): readonly [number, number, number] {
  const i = (g * png.width + b * LUT_SIZE + r) * 4;
  return [png.rgba[i] as number, png.rgba[i + 1] as number, png.rgba[i + 2] as number];
}

function means(png: ReturnType<typeof load>): { r: number; g: number; b: number; luma: number } {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = png.width * png.height;
  for (let p = 0; p < n; p++) {
    r += png.rgba[p * 4] as number;
    g += png.rgba[p * 4 + 1] as number;
    b += png.rgba[p * 4 + 2] as number;
  }
  r /= n;
  g /= n;
  b /= n;
  return { r, g, b, luma: 0.299 * r + 0.587 * g + 0.114 * b };
}

describe('WAP9.3 the grade pack registers the three LUT strips', () => {
  it('WAP9.3 the LUT lattice is 32 and the three keyframes have distinct png files', () => {
    expect(LUT_SIZE).toBe(32);
    expect([...GRADE_KEYFRAMES]).toEqual(['day', 'dusk', 'night']);
    const files = GRADE_KEYFRAMES.map((kf) => LUT_FILE[kf]);
    expect(new Set(files).size).toBe(3);
    for (const file of files) expect(file).toMatch(/\.png$/);
  });

  it('WAP9.3 GRADE_PACK has exactly the three grade/lut_* rows', () => {
    expect(GRADE_PACK).toHaveLength(3);
    expect(GRADE_PACK.map((row) => row.key).sort()).toEqual([
      'grade/lut_day',
      'grade/lut_dusk',
      'grade/lut_night',
    ]);
  });

  it('WAP9.3 each row is a procedural, project-original lut at scale 1 over its keyframe file', () => {
    for (const kf of GRADE_KEYFRAMES) {
      const row = GRADE_PACK.find((r) => r.key === `grade/lut_${kf}`);
      expect(row).toBeDefined();
      expect(row?.kind).toBe('lut');
      expect(row?.file).toBe(LUT_FILE[kf]);
      expect(row?.sheet).toEqual({ w: LUT_SIZE * LUT_SIZE, h: LUT_SIZE });
      expect(row?.scale).toBe(1);
      expect(row?.source).toBe(GENERATOR);
      expect(row?.provenance).toBe('placeholder-procedural');
      expect(row?.license).toBe('project-original');
    }
  });

  it('WAP9.3 the pack validates as an art registry and its generator source exists', () => {
    expect(GRADE_PACK.length).toBeGreaterThan(0);
    expect(validateArtRegistry(GRADE_PACK)).toEqual([]);
    expect(existsSync(`${REPO_ROOT}${GENERATOR}`)).toBe(true);
  });

  it('WAP9.3 each registered sheet size is the committed png size', () => {
    expect(GRADE_PACK.length).toBe(3);
    for (const row of GRADE_PACK) {
      const png = decodePng(new Uint8Array(readFileSync(`${ASSETS}${row.file}`)));
      expect({ w: png.width, h: png.height }).toEqual(row.sheet);
    }
  });
});

describe('WAP9.3 the committed LUT pngs follow the ColorMap layout', () => {
  it('WAP9.3 every strip is 1024x32', () => {
    for (const kf of GRADE_KEYFRAMES) {
      const png = load(kf);
      expect(png.width).toBe(LUT_SIZE * LUT_SIZE);
      expect(png.height).toBe(LUT_SIZE);
    }
  });

  it('WAP9.3 the day strip is near the identity grade at every lattice point (x = b*32 + r, y = g)', () => {
    const png = load('day');
    for (let b = 0; b < LUT_SIZE; b++) {
      for (let g = 0; g < LUT_SIZE; g++) {
        for (let r = 0; r < LUT_SIZE; r++) {
          const got = texel(png, r, g, b);
          const want = [r, g, b].map((v) => Math.round((v * 255) / (LUT_SIZE - 1)));
          for (let c = 0; c < 3; c++) {
            expect(Math.abs((got[c] as number) - (want[c] as number))).toBeLessThanOrEqual(40);
          }
        }
      }
    }
  });

  it('WAP9.3 every strip is fully opaque, and rises with red along x, green along y and blue across slices', () => {
    for (const kf of GRADE_KEYFRAMES) checkLayout(kf);
  });

  function checkLayout(kf: GradeKeyframe): void {
    const png = load(kf);
    for (let p = 3; p < png.rgba.length; p += 4) expect(png.rgba[p]).toBe(255);
    const last = LUT_SIZE - 1;
    const SLACK = 2;
    // Day spans most of each channel; the darker grades must still be far from flat.
    const range = kf === 'day' ? 150 : 40;
    for (let b = 0; b < LUT_SIZE; b++) {
      for (let g = 0; g < LUT_SIZE; g++) {
        for (let r = 1; r < LUT_SIZE; r++) {
          const a = texel(png, r - 1, g, b);
          const c = texel(png, r, g, b);
          expect(c[0]).toBeGreaterThanOrEqual(a[0] - SLACK);
        }
      }
    }
    for (let b = 0; b < LUT_SIZE; b++) {
      for (let r = 0; r < LUT_SIZE; r++) {
        for (let g = 1; g < LUT_SIZE; g++) {
          const a = texel(png, r, g - 1, b);
          const c = texel(png, r, g, b);
          expect(c[1]).toBeGreaterThanOrEqual(a[1] - SLACK);
        }
      }
    }
    for (let g = 0; g < LUT_SIZE; g++) {
      for (let r = 0; r < LUT_SIZE; r++) {
        for (let b = 1; b < LUT_SIZE; b++) {
          const a = texel(png, r, g, b - 1);
          const c = texel(png, r, g, b);
          expect(c[2]).toBeGreaterThanOrEqual(a[2] - SLACK);
        }
      }
    }
    // Real range, not a flat strip: each axis spans most of the channel.
    expect(
      (texel(png, last, 0, 0)[0] as number) - (texel(png, 0, 0, 0)[0] as number),
    ).toBeGreaterThan(range);
    expect(
      (texel(png, 0, last, 0)[1] as number) - (texel(png, 0, 0, 0)[1] as number),
    ).toBeGreaterThan(range);
    expect(
      (texel(png, 0, 0, last)[2] as number) - (texel(png, 0, 0, 0)[2] as number),
    ).toBeGreaterThan(range);
  }

  it('WAP9.3 the strips get darker from day to dusk to night', () => {
    const day = means(load('day')).luma;
    const dusk = means(load('dusk')).luma;
    const night = means(load('night')).luma;
    expect(night).toBeLessThan(dusk);
    expect(dusk).toBeLessThan(day);
  });

  it('WAP9.3 night is cooler than day and dusk is warmer than day (blue over red)', () => {
    const ratio = (kf: GradeKeyframe): number => {
      const m = means(load(kf));
      return m.b / m.r;
    };
    expect(ratio('night')).toBeGreaterThan(ratio('day'));
    expect(ratio('dusk')).toBeLessThan(ratio('day'));
  });

  it('WAP9.3 the three strips are pairwise different images', () => {
    const [day, dusk, night] = GRADE_KEYFRAMES.map((kf) => Buffer.from(load(kf).rgba));
    expect((day as Buffer).equals(dusk as Buffer)).toBe(false);
    expect((dusk as Buffer).equals(night as Buffer)).toBe(false);
    expect((day as Buffer).equals(night as Buffer)).toBe(false);
  });
});
