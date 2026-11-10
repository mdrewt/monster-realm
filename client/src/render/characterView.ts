// render/characterView.ts — one POOLED sprite per entity.
//
// Imperative shell (no pixel tests — the renderer is validated by the M5 e2e via
// `window.__game()`; its LOGIC lives in the tested pure modules). A CharacterView
// wraps ONE Pixi sprite, mutated in place every frame (never recreated — the v1
// "recreate-Pixi" pitfall), swapping its texture ONLY when the (action, facing, phase)
// swap key actually changes. wap-5: the walk phase is derived from the fractional
// tile position `update` already receives, so it follows the slide clock with no
// second clock.

import type { Texture } from 'pixi.js';
import { Sprite } from 'pixi.js';
import type { WasmAction, WasmDirection } from '../convert/convert';
import { TILE_PX } from './config';

export type AnimKey = `${WasmAction}:${WasmDirection}`;

export function animKey(action: WasmAction, facing: WasmDirection): AnimKey {
  return `${action}:${facing}`;
}

/** Walk-cycle phases per step (one tile): the hero atlas plays stepA, mid, stepB, mid. */
export const WALK_PHASES = 4;

/**
 * The walk phase (an integer in [0, WALK_PHASES)) at a fractional tile position: the
 * fractional part of the position within the current step, quantised. Mid-slide only
 * the moving axis is fractional (the other is a whole tile), so summing both fractions
 * needs no facing. A West/North slide counts the fraction down, so it plays the cycle
 * in reverse — the same stepA, mid, stepB, mid alternation, since the cycle is symmetric.
 */
export function walkPhase(tileX: number, tileY: number): number {
  const slid = tileX - Math.floor(tileX) + (tileY - Math.floor(tileY));
  return Math.floor(slid * WALK_PHASES) % WALK_PHASES;
}

/**
 * The renderer's asset seam (HD-2D readiness). A sprite is an "albedo"
 * texture today; a later provider can additionally supply normal/material channels
 * for a lighting/post-processing render mode — an ADDITIVE change behind this same
 * interface, `render/`-only. Assets are authored NEUTRALLY-LIT (no baked
 * directional shadows) so they are normal-map-ready.
 */
export interface AssetProvider {
  /** `phase` (wap-5): the walk phase from {@link walkPhase}; 0 for a non-walking
   *  action. Optional, so a phase-blind provider (PlaceholderAssets) still fits. */
  texture(action: WasmAction, facing: WasmDirection, phase?: number): Texture;
  /** Release provider-owned GPU resources (#28c). Optional: a provider that
   *  owns no textures (e.g. an atlas managed elsewhere) may omit it. */
  destroy?(): void;
  /** The WebGL context was restored: drop every texture this provider GENERATED, since
   *  its pixels did not survive. The caller recreates its views, so the next `texture()`
   *  call regenerates. Optional: image-backed textures re-upload on their own. */
  contextRestored?(): void;
}

export class CharacterView {
  readonly sprite: Sprite;
  readonly #assets: AssetProvider;
  #key: `${AnimKey}:${number}` | undefined;

  constructor(assets: AssetProvider) {
    this.#assets = assets;
    this.sprite = new Sprite();
    this.sprite.anchor.set(0.5, 0.5);
  }

  /** Mutate-in-place: place at a FRACTIONAL tile position (sub-tile is render-only,
   *  never stored/sent) and swap the texture only on a swap-key change. */
  update(tileX: number, tileY: number, action: WasmAction, facing: WasmDirection): void {
    this.sprite.x = (tileX + 0.5) * TILE_PX;
    this.sprite.y = (tileY + 0.5) * TILE_PX;
    const phase = action === 'Walking' ? walkPhase(tileX, tileY) : 0;
    const key = `${animKey(action, facing)}:${phase}` as const;
    if (key !== this.#key) {
      this.sprite.texture = this.#assets.texture(action, facing, phase);
      this.#key = key;
    }
  }

  destroy(): void {
    this.sprite.destroy();
  }
}
