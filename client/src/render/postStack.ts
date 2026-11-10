// render/postStack.ts — the world post stack's plan (wap-9). Functional core.
//
// `planPostStack` decides, from injected inputs only, which filter passes run over the
// world layer and with what parameters; `world.ts` (the coverage-excluded Pixi shell)
// constructs exactly the passes the plan lists and nothing else. Passes run in a fixed
// order — ambient lightmap with a vignette falloff, AdvancedBloom, Godray, then the
// ColorMap LUT grade — and a disabled pass is absent from the plan, never present at
// zero strength. Every pass renders at the renderer's device-pixel resolution, so the
// integer-scaled world's tile edges stay one-pixel hard steps (DECISIONS "Integer pixel
// scaling"); the LUT samples `nearest`.
//
// Time enters only as the injected `nowMs` (constraint 6) and is held at 0 while reduced
// motion is set (constraint 8). Where filters are unsupported or a pass failed to
// construct, the plan is empty with one warning: the world draws unfiltered.

import { type GradeKeyframe, LUT_FILE } from './art/packs/grade';

export type PostPassId = 'lightmap' | 'bloom' | 'godray' | 'lut';

/** The order the passes run in over the world layer. */
export const POST_PASS_ORDER: readonly PostPassId[] = ['lightmap', 'bloom', 'godray', 'lut'];

/** Which passes are on. */
export type PostStackToggles = Readonly<Record<PostPassId, boolean>>;

/** Every pass off: the renderer's stack until `setPostStack` turns passes on. */
export const NO_POST_STACK: PostStackToggles = {
  lightmap: false,
  bloom: false,
  godray: false,
  lut: false,
};

/** The full stack, every pass on (the look-dev scene's stack-on frame). */
export const LIVE_POST_STACK: PostStackToggles = {
  lightmap: true,
  bloom: true,
  godray: true,
  lut: true,
};

/** What the shell knows about the renderer's ability to run the stack. */
export type PostSupport =
  | { readonly kind: 'supported' }
  | { readonly kind: 'unsupported'; readonly detail: string }
  | { readonly kind: 'pass-failed'; readonly pass: PostPassId; readonly detail: string };

export interface PostStackInput {
  readonly toggles: PostStackToggles;
  readonly nowMs: number;
  readonly reduceMotion: boolean;
  readonly keyframe: GradeKeyframe;
  /** The renderer's device-pixel resolution (the dpr its backing store uses). */
  readonly resolution: number;
  readonly support: PostSupport;
}

/** The lightmap's radial falloff: `centre` light inside the `inner` radius, `edge` light
 *  at the corners (radii are fractions of the centre-to-corner distance). */
export interface VignetteFalloff {
  readonly inner: number;
  readonly centre: number;
  readonly edge: number;
}

/** One planned pass. `options` is the pixi-filters constructor options verbatim (the
 *  shell adds only the textures it owns), so no parameter is re-mapped in the shell. */
export type PostPass =
  | {
      readonly id: 'lightmap';
      readonly resolution: number;
      /** Ambient light colour (0xRRGGBB) and strength, added to the lightmap's light. */
      readonly options: { readonly color: number; readonly alpha: number };
      readonly vignette: VignetteFalloff;
    }
  | {
      readonly id: 'bloom';
      readonly resolution: number;
      readonly options: {
        readonly threshold: number;
        readonly bloomScale: number;
        readonly brightness: number;
        readonly blur: number;
        readonly quality: number;
      };
    }
  | {
      readonly id: 'godray';
      readonly resolution: number;
      readonly options: {
        readonly time: number;
        readonly angle: number;
        readonly gain: number;
        readonly lacunarity: number;
        readonly alpha: number;
      };
    }
  | {
      readonly id: 'lut';
      readonly resolution: number;
      /** The keyframe's LUT, relative to `client/public/assets/`. */
      readonly file: string;
      readonly options: { readonly nearest: true; readonly mix: number };
    };

export interface PostStackWarning {
  readonly code: 'filters-unsupported' | 'pass-failed';
  readonly detail: string;
}

export interface PostStackPlan {
  readonly target: 'world';
  readonly passes: readonly PostPass[];
  readonly warnings: readonly PostStackWarning[];
}

/** What a keyframe grades the world to: its LUT and its ambient light. */
export interface KeyframeGrade {
  readonly lutFile: string;
  readonly ambient: number;
  readonly ambientAlpha: number;
}

const KEYFRAME_GRADES: Readonly<Record<GradeKeyframe, KeyframeGrade>> = {
  day: { lutFile: LUT_FILE.day, ambient: 0xfff4e0, ambientAlpha: 0.3 },
  dusk: { lutFile: LUT_FILE.dusk, ambient: 0xffb070, ambientAlpha: 0.25 },
  night: { lutFile: LUT_FILE.night, ambient: 0x6070b0, ambientAlpha: 0.2 },
};

/** A keyframe's grade (a total lookup: a new keyframe is a compile error until graded). */
export function selectKeyframe(keyframe: GradeKeyframe): KeyframeGrade {
  return KEYFRAME_GRADES[keyframe];
}

/** Godray noise units advanced per injected millisecond (≈ the filter demo's drift). */
export const GODRAY_TIME_PER_MS = 0.0005;

/** The godray time uniform: the injected clock, held at 0 under reduced motion. */
export function godrayTime(nowMs: number, reduceMotion: boolean): number {
  if (reduceMotion || !Number.isFinite(nowMs)) return 0;
  return nowMs * GODRAY_TIME_PER_MS;
}

/** The lightmap falloff; with each keyframe's ambient the centre adds up to about full light. */
export const VIGNETTE: VignetteFalloff = { inner: 0.35, centre: 0.7, edge: 0.45 };

/** The lightmap texture's size; it is a smooth gradient stretched over the filtered area. */
export const LIGHTMAP_SIZE = { w: 64, h: 36 } as const;

/** Plan the post stack for one frame's inputs. Pure. */
export function planPostStack(input: PostStackInput): PostStackPlan {
  const { support } = input;
  if (support.kind === 'unsupported') {
    return {
      target: 'world',
      passes: [],
      warnings: [{ code: 'filters-unsupported', detail: support.detail }],
    };
  }
  if (support.kind === 'pass-failed') {
    return {
      target: 'world',
      passes: [],
      warnings: [{ code: 'pass-failed', detail: `${support.pass}: ${support.detail}` }],
    };
  }
  const { resolution } = input;
  const grade = selectKeyframe(input.keyframe);
  const build: Readonly<Record<PostPassId, () => PostPass>> = {
    lightmap: () => ({
      id: 'lightmap',
      resolution,
      options: { color: grade.ambient, alpha: grade.ambientAlpha },
      vignette: VIGNETTE,
    }),
    bloom: () => ({
      id: 'bloom',
      resolution,
      options: { threshold: 0.7, bloomScale: 0.6, brightness: 1, blur: 4, quality: 3 },
    }),
    godray: () => ({
      id: 'godray',
      resolution,
      options: {
        time: godrayTime(input.nowMs, input.reduceMotion),
        angle: 30,
        gain: 0.4,
        lacunarity: 2.5,
        alpha: 0.2,
      },
    }),
    lut: () => ({ id: 'lut', resolution, file: grade.lutFile, options: { nearest: true, mix: 1 } }),
  };
  return {
    target: 'world',
    passes: POST_PASS_ORDER.filter((id) => input.toggles[id]).map((id) => build[id]()),
    warnings: [],
  };
}

/**
 * The ambient lightmap with its vignette falloff: grey RGBA, `centre` light inside the
 * `inner` radius, easing (smoothstep) to `edge` light at the corners. Radii are fractions
 * of the centre-to-corner distance; the texture is stretched over the filtered area.
 */
export function lightmapPixels(w: number, h: number, vignette: VignetteFalloff): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const cx = w / 2;
  const cy = h / 2;
  const corner = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / corner;
      const t = Math.min(1, Math.max(0, (r - vignette.inner) / (1 - vignette.inner)));
      const ease = t * t * (3 - 2 * t);
      const v = Math.round((vignette.centre + (vignette.edge - vignette.centre) * ease) * 255);
      const i = (y * w + x) * 4;
      out[i] = v;
      out[i + 1] = v;
      out[i + 2] = v;
      out[i + 3] = 255;
    }
  }
  return out;
}
