// render/postStack.test.ts — wap-9 (M-world-art-pass): the pure post-stack planner.
//
// WAP9.1 the ordered pass list (disabled passes omitted, never zeroed; world target; resolution
//        carried; nearest LUT; ambient headroom) + the lightmap texture generator.
// WAP9.2 godray time is the injected clock (and holds at 0 under reduced motion).
// WAP9.3 keyframe selection is a pure total lookup (the file/PNG half lives in grade.test.ts).
// WAP9.4 an unsupported / failed filter path plans an empty stack with exactly one warning.
//
// No pixi import: postStack.ts is a functional core. The real filters are measured in
// client/e2e/lookdev.spec.ts.
import { describe, expect, it } from 'vitest';
import { GRADE_KEYFRAMES, type GradeKeyframe, LIVE_KEYFRAME, LUT_FILE } from './art/packs/grade';
import {
  GODRAY_TIME_PER_MS,
  godrayTime,
  LIVE_POST_STACK,
  lightmapPixels,
  POST_PASS_ORDER,
  type PostPass,
  type PostPassId,
  type PostStackInput,
  type PostSupport,
  planPostStack,
  selectKeyframe,
} from './postStack';

const SUPPORTED: PostSupport = { kind: 'supported' };
const ALL_ON = { lightmap: true, bloom: true, godray: true, lut: true } as const;
const ALL_OFF = { lightmap: false, bloom: false, godray: false, lut: false } as const;

function input(over: Partial<PostStackInput> = {}): PostStackInput {
  return {
    toggles: ALL_ON,
    nowMs: 1000,
    reduceMotion: false,
    keyframe: 'day',
    resolution: 2,
    support: SUPPORTED,
    ...over,
  };
}

/** The pass with `id` (the test fails loudly when it is absent). */
function passOf<T extends PostPassId>(
  passes: readonly PostPass[],
  id: T,
): Extract<PostPass, { id: T }> {
  const found = passes.find((p) => p.id === id);
  if (found === undefined) throw new Error(`the plan has no ${id} pass`);
  return found as Extract<PostPass, { id: T }>;
}

/** All 16 toggle subsets, each as [mask, toggles, ids in POST_PASS_ORDER]. */
function subsets(): Array<{ toggles: Record<PostPassId, boolean>; ids: PostPassId[] }> {
  const out: Array<{ toggles: Record<PostPassId, boolean>; ids: PostPassId[] }> = [];
  for (let mask = 0; mask < 16; mask++) {
    const toggles = { lightmap: false, bloom: false, godray: false, lut: false };
    const ids: PostPassId[] = [];
    POST_PASS_ORDER.forEach((id, bit) => {
      const on = (mask & (1 << bit)) !== 0;
      toggles[id] = on;
      if (on) ids.push(id);
    });
    out.push({ toggles, ids });
  }
  return out;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Every number reachable in a pass's `options` object is finite. */
function numbersOf(options: object): number[] {
  return Object.values(options).filter((v): v is number => typeof v === 'number');
}

describe('WAP9.1 the ordered post stack', () => {
  it('WAP9.1 the pass order constant is lightmap, bloom, godray, lut', () => {
    expect([...POST_PASS_ORDER]).toEqual(['lightmap', 'bloom', 'godray', 'lut']);
  });

  it('WAP9.1 the live stack enables all four passes', () => {
    expect(LIVE_POST_STACK).toEqual({ lightmap: true, bloom: true, godray: true, lut: true });
  });

  it('WAP9.1 all four enabled plan lightmap, bloom, godray, lut in that order on the world target', () => {
    const plan = planPostStack(input());
    expect(plan.passes.map((p) => p.id)).toEqual(['lightmap', 'bloom', 'godray', 'lut']);
    expect(plan.target).toBe('world');
    expect(plan.warnings).toEqual([]);
  });

  it('WAP9.1 each of the 16 toggle subsets plans exactly the enabled ids in POST_PASS_ORDER order', () => {
    const all = subsets();
    expect(all).toHaveLength(16);
    for (const { toggles, ids } of all) {
      const plan = planPostStack(input({ toggles }));
      expect(plan.passes.map((p) => p.id)).toEqual(ids);
      expect(plan.target).toBe('world');
      expect(plan.warnings).toEqual([]);
    }
  });

  it('WAP9.1 a disabled pass is omitted, never present with a zeroed strength', () => {
    for (const { toggles } of subsets()) {
      for (const pass of planPostStack(input({ toggles })).passes) {
        const strengths: number[] = [];
        if (pass.id === 'lightmap') strengths.push(pass.options.alpha);
        if (pass.id === 'godray') strengths.push(pass.options.alpha, pass.options.gain);
        if (pass.id === 'lut') strengths.push(pass.options.mix);
        if (pass.id === 'bloom') strengths.push(pass.options.bloomScale, pass.options.brightness);
        expect(strengths.length).toBeGreaterThan(0);
        for (const s of strengths) {
          expect(Number.isFinite(s)).toBe(true);
          expect(s).toBeGreaterThan(0);
        }
      }
    }
  });

  it('WAP9.1 all toggles off plans an empty stack with no warning', () => {
    const plan = planPostStack(input({ toggles: ALL_OFF }));
    expect(plan.passes).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.target).toBe('world');
  });

  it('WAP9.1 every pass carries the renderer resolution (a hard-coded 1 fails)', () => {
    for (const resolution of [2, 1.5, 3, 1]) {
      const plan = planPostStack(input({ resolution }));
      expect(plan.passes).toHaveLength(4);
      for (const pass of plan.passes) expect(pass.resolution).toBe(resolution);
    }
  });

  it('WAP9.1 the lut pass samples nearest and names the keyframe LUT file', () => {
    for (const keyframe of GRADE_KEYFRAMES) {
      const lut = passOf(planPostStack(input({ keyframe })).passes, 'lut');
      expect(lut.options.nearest).toBe(true);
      expect(lut.file).toBe(LUT_FILE[keyframe]);
    }
  });

  it('WAP9.1 the full canonical plan: exact structure, injected time, no stray keys', () => {
    const num = expect.any(Number);
    const plan = planPostStack(input({ nowMs: 2500, resolution: 2, keyframe: 'dusk' }));
    expect(plan).toEqual({
      target: 'world',
      warnings: [],
      passes: [
        {
          id: 'lightmap',
          resolution: 2,
          options: { color: num, alpha: num },
          vignette: expect.objectContaining({ centre: num }),
        },
        {
          id: 'bloom',
          resolution: 2,
          options: { threshold: num, bloomScale: num, brightness: num, blur: num, quality: num },
        },
        {
          id: 'godray',
          resolution: 2,
          options: {
            time: 2500 * GODRAY_TIME_PER_MS,
            angle: num,
            gain: num,
            lacunarity: num,
            alpha: num,
          },
        },
        {
          id: 'lut',
          resolution: 2,
          file: LUT_FILE.dusk,
          options: { nearest: true, mix: num },
        },
      ],
    });
    for (const pass of plan.passes) {
      for (const n of numbersOf(pass.options)) expect(Number.isFinite(n)).toBe(true);
    }
  });

  it('WAP9.1 the lightmap ambient plus the vignette centre never exceeds 1 on any channel, on every keyframe', () => {
    for (const keyframe of GRADE_KEYFRAMES) {
      const lightmap = passOf(
        planPostStack(input({ keyframe, toggles: { ...ALL_OFF, lightmap: true } })).passes,
        'lightmap',
      );
      const { color, alpha } = lightmap.options;
      const centre = lightmap.vignette.centre;
      expect(centre).toBeGreaterThan(0);
      for (const shift of [16, 8, 0]) {
        const channel = (((color as number) >> shift) & 255) / 255;
        expect(channel * alpha + centre).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('WAP9.1 the lightmap pass takes the keyframe ambient colour and alpha from selectKeyframe', () => {
    for (const keyframe of GRADE_KEYFRAMES) {
      const grade = selectKeyframe(keyframe);
      const lightmap = passOf(planPostStack(input({ keyframe })).passes, 'lightmap');
      expect(lightmap.options.color).toBe(grade.ambient);
      expect(lightmap.options.alpha).toBe(grade.ambientAlpha);
    }
  });

  it('WAP9.1 lightmap pixels: RGBA, opaque, w*h*4 long', () => {
    const vignette = passOf(planPostStack(input()).passes, 'lightmap').vignette;
    for (const [w, h] of [
      [33, 21],
      [32, 20],
      [8, 8],
    ] as const) {
      const px = lightmapPixels(w, h, vignette);
      expect(px).toBeInstanceOf(Uint8Array);
      expect(px.length).toBe(w * h * 4);
      for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255);
    }
  });

  it('WAP9.1 lightmap pixels: the centre is the brightest pixel and strictly brighter than every corner', () => {
    const vignette = passOf(planPostStack(input()).passes, 'lightmap').vignette;
    const w = 33;
    const h = 21;
    const px = lightmapPixels(w, h, vignette);
    const lum = (x: number, y: number): number => {
      const i = (y * w + x) * 4;
      return (px[i] as number) + (px[i + 1] as number) + (px[i + 2] as number);
    };
    const centre = lum(16, 10);
    let max = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) max = Math.max(max, lum(x, y));
    expect(centre).toBe(max);
    for (const [x, y] of [
      [0, 0],
      [w - 1, 0],
      [0, h - 1],
      [w - 1, h - 1],
    ] as const) {
      expect(centre - lum(x, y)).toBeGreaterThanOrEqual(12);
    }
  });

  it('WAP9.1 lightmap pixels: the corners are the darkest pixels', () => {
    const vignette = passOf(planPostStack(input()).passes, 'lightmap').vignette;
    const w = 33;
    const h = 21;
    const px = lightmapPixels(w, h, vignette);
    const lum = (x: number, y: number): number => {
      const i = (y * w + x) * 4;
      return (px[i] as number) + (px[i + 1] as number) + (px[i + 2] as number);
    };
    const corner = Math.max(lum(0, 0), lum(w - 1, 0), lum(0, h - 1), lum(w - 1, h - 1));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) expect(lum(x, y)).toBeGreaterThanOrEqual(corner);
    }
  });

  it('WAP9.1 lightmap pixels: brightness never increases on a ray from the centre to the edge', () => {
    const vignette = passOf(planPostStack(input()).passes, 'lightmap').vignette;
    const w = 33;
    const h = 21;
    const px = lightmapPixels(w, h, vignette);
    const lum = (x: number, y: number): number => {
      const i = (y * w + x) * 4;
      return (px[i] as number) + (px[i + 1] as number) + (px[i + 2] as number);
    };
    const cx = 16;
    const cy = 10;
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ] as const;
    for (const [dx, dy] of dirs) {
      let x = cx;
      let y = cy;
      let prev = lum(x, y);
      for (;;) {
        x += dx;
        y += dy;
        if (x < 0 || y < 0 || x >= w || y >= h) break;
        const here = lum(x, y);
        expect(here).toBeLessThanOrEqual(prev);
        prev = here;
      }
    }
  });

  it('WAP9.1 lightmap pixels: left/right and top/bottom symmetric, and deterministic', () => {
    const vignette = passOf(planPostStack(input()).passes, 'lightmap').vignette;
    for (const [w, h] of [
      [33, 21],
      [32, 20],
    ] as const) {
      const px = lightmapPixels(w, h, vignette);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          for (let c = 0; c < 3; c++) {
            const here = px[(y * w + x) * 4 + c] as number;
            const mirrorX = px[(y * w + (w - 1 - x)) * 4 + c] as number;
            const mirrorY = px[((h - 1 - y) * w + x) * 4 + c] as number;
            expect(Math.abs(here - mirrorX)).toBeLessThanOrEqual(1);
            expect(Math.abs(here - mirrorY)).toBeLessThanOrEqual(1);
          }
        }
      }
      expect(lightmapPixels(w, h, vignette)).toEqual(px);
    }
  });
});

describe('WAP9.2 godray time is the injected clock', () => {
  const TIMES = [0, 1, 16.7, 1000, 60_000, 123_456_789, 1e12];

  it('WAP9.2 GODRAY_TIME_PER_MS is a positive finite rate', () => {
    expect(Number.isFinite(GODRAY_TIME_PER_MS)).toBe(true);
    expect(GODRAY_TIME_PER_MS).toBeGreaterThan(0);
  });

  it('WAP9.2 the planned godray time equals godrayTime(nowMs) equals nowMs * GODRAY_TIME_PER_MS', () => {
    for (const nowMs of TIMES) {
      const time = passOf(planPostStack(input({ nowMs })).passes, 'godray').options.time;
      expect(godrayTime(nowMs, false)).toBe(nowMs * GODRAY_TIME_PER_MS);
      expect(time).toBe(godrayTime(nowMs, false));
      expect(time).toBe(nowMs * GODRAY_TIME_PER_MS);
    }
  });

  it('WAP9.2 the planned time is non-zero for nowMs > 0 and strictly increases with nowMs', () => {
    let prev = -Infinity;
    for (const nowMs of TIMES) {
      const time = passOf(planPostStack(input({ nowMs })).passes, 'godray').options.time as number;
      if (nowMs > 0) expect(time).not.toBe(0);
      expect(time).toBeGreaterThan(prev);
      prev = time;
    }
  });

  it('WAP9.2 under reduced motion the godray time is exactly 0 for every nowMs', () => {
    for (const nowMs of TIMES) {
      expect(Object.is(godrayTime(nowMs, true), 0)).toBe(true);
      const time = passOf(planPostStack(input({ nowMs, reduceMotion: true })).passes, 'godray')
        .options.time;
      expect(Object.is(time, 0)).toBe(true);
    }
  });

  it('WAP9.2 a non-finite nowMs plans time 0, never NaN or Infinity', () => {
    for (const nowMs of [Number.NaN, Infinity, -Infinity]) {
      expect(Object.is(godrayTime(nowMs, false), 0)).toBe(true);
      const time = passOf(planPostStack(input({ nowMs })).passes, 'godray').options.time;
      expect(Object.is(time, 0)).toBe(true);
    }
  });

  it('WAP9.2 planning is pure: the same input twice is deep-equal and a frozen input is not mutated', () => {
    const frozen = deepFreeze(input({ nowMs: 4321, keyframe: 'night' }));
    const a = planPostStack(frozen);
    const b = planPostStack(frozen);
    expect(a).toEqual(b);
    expect(frozen).toEqual(input({ nowMs: 4321, keyframe: 'night' }));
    // The clock is an input, not read: a different nowMs is the only thing that moves the plan.
    const later = planPostStack(input({ nowMs: 4322, keyframe: 'night' }));
    expect(later).not.toEqual(a);
  });
});

describe('WAP9.3 keyframe selection is a pure total lookup', () => {
  it('WAP9.3 the keyframes are day, dusk, night and the live one is day', () => {
    expect([...GRADE_KEYFRAMES]).toEqual(['day', 'dusk', 'night']);
    expect(LIVE_KEYFRAME).toBe('day');
  });

  it('WAP9.3 every keyframe selects its own LUT file and the three files are distinct', () => {
    for (const kf of GRADE_KEYFRAMES) expect(selectKeyframe(kf).lutFile).toBe(LUT_FILE[kf]);
    expect(new Set(GRADE_KEYFRAMES.map((kf) => selectKeyframe(kf).lutFile)).size).toBe(3);
  });

  it('WAP9.3 the three grades are pairwise different and each is deterministic', () => {
    const grades = GRADE_KEYFRAMES.map((kf) => selectKeyframe(kf));
    for (let i = 0; i < grades.length; i++) {
      for (let j = i + 1; j < grades.length; j++) expect(grades[i]).not.toEqual(grades[j]);
    }
    for (const kf of GRADE_KEYFRAMES) expect(selectKeyframe(kf)).toEqual(selectKeyframe(kf));
  });

  it('WAP9.3 the plan for each keyframe carries that keyframe LUT file and a different plan from the others', () => {
    const plans = GRADE_KEYFRAMES.map((keyframe: GradeKeyframe) => {
      const plan = planPostStack(input({ keyframe }));
      expect(passOf(plan.passes, 'lut').file).toBe(LUT_FILE[keyframe]);
      return plan;
    });
    expect(plans[0]).not.toEqual(plans[1]);
    expect(plans[1]).not.toEqual(plans[2]);
    expect(plans[0]).not.toEqual(plans[2]);
  });
});

describe('WAP9.4 an unsupported filter path plans an empty stack with one warning', () => {
  const TOGGLE_SETS = [ALL_ON, ALL_OFF, { ...ALL_OFF, bloom: true }, { ...ALL_ON, lut: false }];

  it('WAP9.4 unsupported plans no passes and exactly one filters-unsupported warning, whatever the toggles', () => {
    for (const toggles of TOGGLE_SETS) {
      const plan = planPostStack(
        input({ toggles, support: { kind: 'unsupported', detail: 'no filter support' } }),
      );
      expect(plan.passes).toEqual([]);
      expect(plan.warnings).toHaveLength(1);
      expect(plan.warnings[0]?.code).toBe('filters-unsupported');
    }
  });

  it('WAP9.4 each failed pass plans no passes and exactly one pass-failed warning naming it', () => {
    for (const pass of POST_PASS_ORDER) {
      for (const toggles of TOGGLE_SETS) {
        const plan = planPostStack(
          input({ toggles, support: { kind: 'pass-failed', pass, detail: `${pass} blew up` } }),
        );
        expect(plan.passes).toEqual([]);
        expect(plan.warnings).toHaveLength(1);
        const [warning] = plan.warnings;
        expect(warning?.code).toBe('pass-failed');
        const named =
          (warning as { pass?: string } | undefined)?.pass === pass ||
          JSON.stringify(warning).includes(pass);
        expect(named).toBe(true);
      }
    }
  });

  it('WAP9.4 the fallback never throws and keeps the world target', () => {
    const supports: PostSupport[] = [
      { kind: 'unsupported', detail: 'x' },
      ...POST_PASS_ORDER.map((pass): PostSupport => ({ kind: 'pass-failed', pass, detail: 'x' })),
    ];
    for (const support of supports) {
      expect(() => planPostStack(input({ support }))).not.toThrow();
      expect(planPostStack(input({ support })).target).toBe('world');
    }
  });

  it('WAP9.4 a supported stack plans zero warnings', () => {
    for (const { toggles } of subsets()) {
      expect(planPostStack(input({ toggles })).warnings).toEqual([]);
    }
  });
});
