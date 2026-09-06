// render/placeholderAssets.test.ts — rb-57: the action cue must not be colour-alone
// (vitest, node-only; DRAW-INSTRUCTION assertions, not rasterized pixels).
//
// SOURCE OF TRUTH: residual R-m23-s8-postmerge-tint / ADR-0233 §8.2.
//
// THE DEFECT: `PlaceholderAssets#build()` draws exactly two fills today — a body
// roundRect tinted by `ACTION_TINT[action]`, and a facing-notch circle in a fixed
// ink. At a FIXED facing, swapping Idle/Walking/Jumping changes ONLY the body
// fill's colour: the draw GEOMETRY is byte-identical across all three actions.
// A colour-blind player (or a greyscale screenshot) cannot tell Idle from
// Jumping. T1 below is the RED that encodes this.
//
// THE FIX (not implemented here — that is the specialist's job): a THIRD fill,
// a per-action monochrome glyph in the same ink as the notch, drawn in a 6x6
// field centred on the tile, AFTER the notch, sharing one `.fill()` call per
// action. T2-T8 pin its exact geometry, its ink, its independence from facing,
// its non-overlap with the notch, its non-directionality, and (T4/T7) that the
// pre-existing body/notch/cache behaviour is undisturbed.
//
// CAPTURE STRATEGY: `PlaceholderAssets#build()` calls `renderer.generateTexture()`
// with a live `Graphics` as `target`, then immediately calls `g.destroy()` — which
// nulls `.context` — so any read of the Graphics AFTER `texture()` returns throws.
// The fake renderer below reads `target.context.instructions` SYNCHRONOUSLY inside
// `generateTexture`, before that destroy runs. Every `.fill()` after the first on
// the same Graphics gets a phantom `{action:'moveTo', data:[0,0]}` prefixed onto
// its path (measured pixi.js behaviour) — the shared helper filters this out by
// `action`, never by position, so it is robust to however many moveTo insertions
// a multi-bar glyph's single `.fill()` produces. The trailing element of each raw
// `data` array is a pixi `Matrix` instance — plain numbers are extracted
// immediately (`typeof x === 'number'`); nothing pixi-owned is retained past the
// callback (no `structuredClone` — it throws on a `Matrix`).
//
// Proof-of-teeth (ADR-0010): each assertion below names the wrong impl it kills.

import type { Renderer } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import type { WasmAction, WasmDirection } from '../convert/convert';
import { TILE_PX } from './config';
import { PlaceholderAssets } from './placeholderAssets';

const ACTIONS: readonly WasmAction[] = ['Idle', 'Walking', 'Jumping'];
const FACINGS: readonly WasmDirection[] = ['North', 'South', 'East', 'West'];

/** Unit offset (tile space) mirrored from the module under test's own facing
 *  table, as a LITERAL — never imported (an oracle must not read its own
 *  source of truth). */
const NOTCH_OFFSET: Record<WasmDirection, { readonly x: number; readonly y: number }> = {
  North: { x: 0, y: -1 },
  South: { x: 0, y: 1 },
  East: { x: 1, y: 0 },
  West: { x: -1, y: 0 },
};

const ACTION_TINTS: readonly number[] = [0x6fd3a0, 0x4fb3ff, 0xf2c14e];
const NOTCH_INK = 0x10131a;

/** Per-action tint literals (never imported from the module under test) — a
 *  NEW mapping distinct from `ACTION_TINTS` (T3's exclusion-list array),
 *  needed because T11 pins each action to its OWN colour, not merely that
 *  the glyph avoids the set of all three. */
const ACTION_TINT_BY_ACTION: Record<WasmAction, number> = {
  Idle: 0x6fd3a0,
  Walking: 0x4fb3ff,
  Jumping: 0xf2c14e,
};

interface CapturedOp {
  readonly action: string;
  readonly data: readonly number[];
}
interface CapturedInstruction {
  readonly style: { readonly color: number; readonly alpha: number };
  readonly ops: readonly CapturedOp[];
}
interface RawPathOp {
  readonly action: string;
  readonly data: readonly unknown[];
}
interface RawFillInstruction {
  readonly action: string;
  readonly data: {
    readonly style: { readonly color: number; readonly alpha: number };
    readonly path: { readonly instructions: readonly RawPathOp[] };
  };
}

/**
 * The ONE shared capture helper every tooth goes through (T1-T3, T5-T6, T8 at
 * their default `requireGlyph: true`; T4 opts OUT with `requireGlyph: false`
 * since it pins only the pre-existing body+notch and must stay GREEN today —
 * before the third, glyph fill exists at all). T7 does not need draw-op
 * extraction and uses its own minimal fake (build-count only).
 *
 * Builds a single texture for (action,facing) on a FRESH PlaceholderAssets +
 * fake renderer, and returns the ordered, colour-INCLUSIVE draw instructions
 * (style is kept here; T1 strips it down to ops-only itself — A1).
 *
 * Anti-vacuity guards (A4) live HERE, not per-tooth:
 *  - `builds.length !== 1` — the callback never ran (or ran more than once).
 *  - `instructions.length === 0` — a `?? []` "fix" to the post-destroy read
 *    that would let a bbox-fold tooth (T6) pass VACUOUSLY against an empty
 *    seed. This check is UNCONDITIONAL — even a `requireGlyph: false` caller
 *    must see real draws.
 *  - `requireGlyph && instructions.length !== 3` (A5/A6) — pins the exact
 *    post-fix instruction count (body, notch, glyph in ONE fill each) so a
 *    stray 4th draw call, or a glyph split across two `.fill()`s, cannot
 *    silently shift which instruction index a downstream tooth reads.
 */
function captureBuild(
  action: WasmAction,
  facing: WasmDirection,
  { requireGlyph = true }: { requireGlyph?: boolean } = {},
): readonly CapturedInstruction[] {
  const builds: CapturedInstruction[][] = [];
  const fake = {
    generateTexture(opts: {
      target: { context: { instructions: readonly RawFillInstruction[] } };
    }) {
      const captured = opts.target.context.instructions.map(
        (instr): CapturedInstruction => ({
          style: { color: instr.data.style.color, alpha: instr.data.style.alpha },
          ops: instr.data.path.instructions
            .filter((p) => p.action !== 'moveTo')
            .map((p) => ({
              action: p.action,
              data: p.data.filter((x): x is number => typeof x === 'number'),
            })),
        }),
      );
      builds.push(captured);
      return { destroy() {} };
    },
  };
  const assets = new PlaceholderAssets(fake as unknown as Renderer);
  assets.texture(action, facing);

  if (builds.length !== 1) {
    throw new Error(
      `capture helper expected exactly 1 generateTexture() call for ${action}/${facing}, got ${builds.length}`,
    );
  }
  const instructions = builds[0]!;
  if (instructions.length === 0) {
    throw new Error(
      `capture helper yielded NO draw instructions for ${action}/${facing} (A4 anti-vacuity guard tripped)`,
    );
  }
  if (requireGlyph && instructions.length !== 3) {
    throw new Error(
      `expected exactly 3 fill instructions (body, notch, glyph) for ${action}/${facing}, got ${instructions.length}`,
    );
  }
  return instructions;
}

/** Colour-stripped signature (A1): ordered path-ops of ALL instructions, with
 *  the entire `style` object excluded — not merely its `color` key, so a
 *  per-action alpha nudge on the pre-existing fills cannot fake a distinct
 *  signature with no glyph shipped at all. */
function opsSignature(instructions: readonly CapturedInstruction[]): string {
  return JSON.stringify(instructions.map((i) => i.ops));
}

interface BBox {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

function rectBBox(op: CapturedOp): BBox {
  const [x, y, w, h] = op.data;
  return { x0: x!, y0: y!, x1: x! + w!, y1: y! + h! };
}
function circleBBox(op: CapturedOp): BBox {
  const [cx, cy, r] = op.data;
  return { x0: cx! - r!, y0: cy! - r!, x1: cx! + r!, y1: cy! + r! };
}
function unionBBox(a: BBox, b: BBox): BBox {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}
/** Non-negative clearance (px) between two axis-aligned boxes; 0 or negative
 *  means touching/overlapping. A conservative LOWER BOUND on true separation
 *  when the boxes are offset diagonally — safe for a ">= 1 clear px" floor. */
function bboxClearance(a: BBox, b: BBox): number {
  const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (overlapX > 0 && overlapY > 0) return -Math.min(overlapX, overlapY);
  const gapX = overlapX <= 0 ? -overlapX : 0;
  const gapY = overlapY <= 0 ? -overlapY : 0;
  return Math.max(gapX, gapY);
}

/** Rotate a rect op 180 degrees about the tile centre (TILE_PX/2, TILE_PX/2). */
function rotate180(op: CapturedOp): CapturedOp {
  const [x, y, w, h] = op.data;
  const c = TILE_PX / 2;
  return { action: op.action, data: [2 * c - x! - w!, 2 * c - y! - h!, w!, h!] };
}
function sortedRectStrings(ops: readonly CapturedOp[]): string[] {
  return ops.map((o) => JSON.stringify(o.data)).sort();
}

describe('PlaceholderAssets action cue (rb-57 / R-m23-s8-postmerge-tint / ADR-0233 §8.2)', () => {
  it('T1 (the RED): at a FIXED facing, the three actions must NOT draw identical geometry — colour alone is not a valid cue', () => {
    const signatures = ACTIONS.map((a) => opsSignature(captureBuild(a, 'South')));
    for (let i = 0; i < ACTIONS.length; i++) {
      for (let j = i + 1; j < ACTIONS.length; j++) {
        // Kills: an impl that ships no glyph (or an action-agnostic one) — the
        // colour-stripped signatures collide for every pair.
        expect(
          signatures[i],
          `${ACTIONS[i]} and ${ACTIONS[j]} draw colour-identical geometry at facing South`,
        ).not.toBe(signatures[j]);
      }
    }
  });

  it('T2: the third draw instruction is exactly the per-action glyph bar geometry', () => {
    const GLYPH_OPS: Record<WasmAction, readonly CapturedOp[]> = {
      Idle: [{ action: 'rect', data: [13, 15, 6, 2] }],
      Walking: [
        { action: 'rect', data: [13, 13, 6, 2] },
        { action: 'rect', data: [13, 17, 6, 2] },
      ],
      Jumping: [
        { action: 'rect', data: [13, 15, 6, 2] },
        { action: 'rect', data: [15, 13, 2, 6] },
      ],
    };
    for (const action of ACTIONS) {
      const glyph = captureBuild(action, 'South')[2]!;
      // Kills: wrong bar count, wrong bar order, wrong offsets, or bars drawn
      // as `roundRect`/`circle` instead of `rect`.
      expect(glyph.ops).toEqual(GLYPH_OPS[action]);
    }
  });

  it('T3: the glyph is drawn in the notch ink, fully opaque, and never an action tint colour', () => {
    for (const action of ACTIONS) {
      const [, notch, glyph] = captureBuild(action, 'South');
      // Kills: a glyph tinted with ACTION_TINT (defeats the whole point) or any
      // other colour drift from the notch's ink.
      expect(glyph!.style.color).toBe(NOTCH_INK);
      expect(glyph!.style.color).toBe(notch!.style.color);
      expect(ACTION_TINTS).not.toContain(glyph!.style.color);
      // Kills: A2 — a `{color: 0x10131a, alpha: 0}` glyph that is invisible but
      // passes every colour-only check.
      expect(glyph!.style.alpha).toBe(1);
    }
  });

  it('T4 (green today): body fill and facing notch geometry/colour are unaffected by the glyph fix', () => {
    for (const facing of FACINGS) {
      // requireGlyph:false — this tooth pins ONLY the pre-existing body+notch
      // and must stay green both before and after the fix lands.
      const [body, notch] = captureBuild('Idle', facing, { requireGlyph: false });
      // Kills: a fix that perturbs the body roundRect args or its tint.
      expect(body!.ops).toEqual([{ action: 'roundRect', data: [5, 5, 22, 22, 4] }]);
      expect(body!.style.color).toBe(0x6fd3a0);
      const off = NOTCH_OFFSET[facing];
      // Kills: a fix that shifts the notch's circle args (e.g. reusing its
      // radius/centre math for the new glyph and drifting it).
      expect(notch!.ops).toEqual([{ action: 'circle', data: [16 + off.x * 8, 16 + off.y * 8, 3] }]);
    }
  });

  it('T5: the glyph is identical across all four facings (fixed action); the notch is identical across all three actions (fixed facing)', () => {
    for (const action of ACTIONS) {
      const glyphsByFacing = FACINGS.map((f) => captureBuild(action, f)[2]!.ops);
      for (let i = 1; i < glyphsByFacing.length; i++) {
        // Kills: a glyph that (wrongly) reads facing, competing with the notch.
        expect(glyphsByFacing[i]).toEqual(glyphsByFacing[0]);
      }
    }
    for (const facing of FACINGS) {
      const notchesByAction = ACTIONS.map((a) => captureBuild(a, facing)[1]!.ops);
      for (let i = 1; i < notchesByAction.length; i++) {
        // Kills: a fix that (wrongly) makes the notch action-dependent.
        expect(notchesByAction[i]).toEqual(notchesByAction[0]);
      }
    }
  });

  it('T6: the glyph never overlaps the facing notch, across all 12 (action,facing) combinations', () => {
    for (const action of ACTIONS) {
      for (const facing of FACINGS) {
        const [, notch, glyph] = captureBuild(action, facing);
        const notchBBox = circleBBox(notch!.ops[0]!);
        const glyphBBoxes = glyph!.ops.map(rectBBox);
        const glyphUnion = glyphBBoxes.reduce(unionBBox);
        const clearance = bboxClearance(glyphUnion, notchBBox);
        // Kills: a glyph field sized/placed so it collides with the notch for
        // some facing (A4: this is derived from the CAPTURED render, not from
        // reading the source constants — a fold over an accidental `[]` would
        // vacuously "pass" a naive intersection test, but captureBuild's A4
        // guard above already threw before this line could run on empty ops).
        expect(
          clearance,
          `glyph/notch clearance for ${action}/${facing} was ${clearance}px`,
        ).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it('T7 (green today): texture() caches per (action,facing) — repeat calls do not rebuild', () => {
    let buildCount = 0;
    const fake = {
      generateTexture() {
        buildCount++;
        return { destroy() {} };
      },
    };
    const assets = new PlaceholderAssets(fake as unknown as Renderer);

    const idleSouth1 = assets.texture('Idle', 'South');
    expect(buildCount).toBe(1);
    const walkingSouth = assets.texture('Walking', 'South');
    // Kills: a cache keyed on action alone (or facing alone), which would
    // short-circuit this second, distinct key to a build count of 1.
    expect(buildCount).toBe(2);
    expect(walkingSouth).not.toBe(idleSouth1);

    const idleSouth2 = assets.texture('Idle', 'South');
    // Kills: a cache that is bypassed (or invalidated) by the glyph fix,
    // rebuilding on every call.
    expect(buildCount).toBe(2);
    expect(idleSouth2).toBe(idleSouth1);
  });

  it('T8: the per-action glyph is invariant under a 180-degree rotation about the tile centre (it can never encode a heading)', () => {
    for (const action of ACTIONS) {
      const glyph = captureBuild(action, 'South')[2]!.ops;
      const rotated = glyph.map(rotate180);
      // Kills: a glyph whose bars are directional (e.g. an arrow) and would
      // therefore compete with the facing notch instead of only cueing action.
      expect(sortedRectStrings(rotated)).toEqual(sortedRectStrings(glyph));
    }
  });

  it('T9: an unknown action string (a Rust-side ActionState variant not yet mirrored into WasmAction) must fail-soft, not throw, and still return a texture', () => {
    // Own minimal fake (T7 precedent) — NOT captureBuild: an unrecognised
    // action legitimately draws only 2 fills (body, notch; no glyph bars),
    // which would wrongly trip captureBuild's A5/A6 "exactly 3" guard. This
    // tooth cares only about "did it throw / what did it return", not draw-op
    // geometry, so it needs none of captureBuild's instruction-extraction.
    const fakeTexture = { label: 'T9-fake-texture' };
    const fake = {
      generateTexture() {
        return fakeTexture;
      },
    };
    const assets = new PlaceholderAssets(fake as unknown as Renderer);

    let result: unknown;
    // Kills: deleting the `?? []` on `ACTION_GLYPH[action]` in `#build` — an
    // unmirrored action then runs `for (const bar of undefined)`, which
    // throws `TypeError: undefined is not iterable` INSIDE the render frame
    // loop, violating the house fail-soft rule (rowConvert.ts:82-85) that a
    // hand-written enum mirror lagging the real `ActionState` must never crash
    // the renderer.
    expect(() => {
      result = assets.texture('Running' as WasmAction, 'South');
    }).not.toThrow();
    // Kills: a "fix" that swallows the exception (e.g. wrapping `#build` in a
    // try/catch that returns `undefined`) instead of genuinely completing the
    // draw — the caller still needs a real texture to render the sprite with.
    expect(result).toBe(fakeTexture);
  });

  it('T10: at the instant generateTexture() is called, the Graphics target is in a fully renderable container state — alpha=1, visible, renderable, unscaled — so the cue actually rasterizes instead of drawing into a blank/collapsed target', () => {
    // Own local fake (T7/T9 precedent) — NOT captureBuild: this tooth reads
    // CONTAINER-LEVEL render state off `opts.target` (alpha/visible/renderable/
    // scale), which captureBuild's helper never inspects (it only reads
    // `target.context.instructions`, the recorded PATH data). A `g.alpha =
    // 0.0001` (or `.visible = false` / `.renderable = false` / `.scale.set(0)`)
    // inserted right before the real `generateTexture()` call leaves every
    // draw-instruction assertion in T1-T9 green while pixi's real
    // GenerateTextureSystem — which does `getLocalBounds(container).rectangle`
    // then a real `renderer.render({ container })` — would rasterize a blank
    // or size-collapsed texture. Captured SYNCHRONOUSLY inside the callback,
    // same as captureBuild, since `g.destroy()` runs immediately after and
    // nulls internal Container state.
    for (const action of ACTIONS) {
      let snapshot:
        | {
            readonly alpha: number;
            readonly visible: boolean;
            readonly renderable: boolean;
            readonly scaleX: number;
            readonly scaleY: number;
          }
        | undefined;
      const fake = {
        generateTexture(opts: {
          target: {
            readonly alpha: number;
            readonly visible: boolean;
            readonly renderable: boolean;
            readonly scale: { readonly x: number; readonly y: number };
          };
        }) {
          snapshot = {
            alpha: opts.target.alpha,
            visible: opts.target.visible,
            renderable: opts.target.renderable,
            scaleX: opts.target.scale.x,
            scaleY: opts.target.scale.y,
          };
          return { destroy() {} };
        },
      };
      const assets = new PlaceholderAssets(fake as unknown as Renderer);
      assets.texture(action, 'South');

      if (!snapshot) {
        throw new Error(`T10 capture: generateTexture() never called for ${action}`);
      }
      // Kills: `g.alpha = 0.0001` inserted just before `generateTexture()` —
      // every fill on this Graphics (body, notch, glyph) rasterizes to
      // (near-)invisible.
      expect(snapshot.alpha).toBe(1);
      // Kills: `g.visible = false` inserted just before `generateTexture()` —
      // pixi's real render pass skips the container's transform update and
      // draw entirely; the returned texture would be blank.
      expect(snapshot.visible).toBe(true);
      // Kills: `g.renderable = false` inserted just before `generateTexture()`
      // — the container is still transformed but never actually drawn into
      // the render target.
      expect(snapshot.renderable).toBe(true);
      // Kills: `g.scale.set(0)` inserted just before `generateTexture()` — the
      // container's local bounds collapse to a point, so
      // `getLocalBounds(container).rectangle` sizes the output texture as
      // degenerate (0-area).
      expect(snapshot.scaleX).toBe(1);
      expect(snapshot.scaleY).toBe(1);
    }
  });

  it('T11: the body fill is tinted PER-ACTION with its own opaque colour — the three body tints are pairwise distinct, not collapsed onto a shared value', () => {
    const bodyColors: number[] = [];
    for (const action of ACTIONS) {
      const [body] = captureBuild(action, 'South');
      // Kills: collapsing Walking/Jumping's body tint onto Idle's (or any
      // other shared/hard-coded body colour) for this action — each action's
      // body must match its OWN literal tint, not merely "some" tint.
      expect(body!.style.color).toBe(ACTION_TINT_BY_ACTION[action]);
      // Kills: `.fill({ color: ACTION_TINT[action] ?? 0, alpha: 0.01 })` — a
      // near-invisible body that still carries the right colour but never
      // actually rasterizes.
      expect(body!.style.alpha).toBe(1);
      bodyColors.push(body!.style.color);
    }
    // Kills: collapsing ANY pair of the three per-action body tints onto a
    // shared value (not just a collapse onto a specific hard-coded literal
    // like Idle's) — a future 2-of-3 merge still reds here even if it picks
    // a colour no existing test happens to pin.
    for (let i = 0; i < bodyColors.length; i++) {
      for (let j = i + 1; j < bodyColors.length; j++) {
        expect(
          bodyColors[i],
          `${ACTIONS[i]} and ${ACTIONS[j]} share the same body tint (${bodyColors[i]})`,
        ).not.toBe(bodyColors[j]);
      }
    }
  });
});
