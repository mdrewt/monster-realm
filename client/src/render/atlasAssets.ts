// render/atlasAssets.ts — the hero atlas behind the AssetProvider seam (wap-5).
//
// Pure module (no pixi.js runtime import; node-tested with structural fakes). The
// hero sheet (`hero.json`) holds five poses x four facings; `heroFrameKey` maps any
// (action, facing, phase) to one of them through tables TOTAL over both enums, so a
// new `WasmAction`/`WasmDirection` member is a compile error here, never a missing
// frame at runtime. `createCharacterAssets` is the one place a provider is chosen:
// no sheet (load failure) or an incomplete one falls back to `PlaceholderAssets`,
// whose non-colour glyph cue stays the load-failure look.

import type { Renderer, Texture } from 'pixi.js';
import type { WasmAction, WasmDirection } from '../convert/convert';
import type { AssetProvider } from './characterView';
import { PlaceholderAssets } from './placeholderAssets';

/** The loaded hero sheet, structurally: its frame textures by name (a Pixi `Spritesheet`). */
export interface HeroAtlas {
  readonly textures: Readonly<Record<string, Texture>>;
}

type HeroPose = 'idle' | 'stepA' | 'mid' | 'stepB' | 'jump';

const HERO_FACING: Record<WasmDirection, string> = {
  South: 'down',
  North: 'up',
  East: 'right',
  West: 'left',
};

/** Each action's pose cycle, indexed by walk phase modulo its length. The three
 *  actions use disjoint poses: idle, the step poses, jump. */
const HERO_POSES: Record<WasmAction, readonly HeroPose[]> = {
  Idle: ['idle'],
  Walking: ['stepA', 'mid', 'stepB', 'mid'],
  Jumping: ['jump'],
};

/** The atlas frame name for (action, facing, phase): `hero_<dir>_<pose>`. */
export function heroFrameKey(action: WasmAction, facing: WasmDirection, phase = 0): string {
  const poses = HERO_POSES[action];
  const pose = poses[((phase % poses.length) + poses.length) % poses.length];
  return `hero_${HERO_FACING[facing]}_${pose}`;
}

/** Every frame name `heroFrameKey` can produce: the sheet must hold all of them. */
const HERO_FRAME_KEYS: readonly string[] = Object.values(HERO_FACING).flatMap((dir) =>
  [...new Set(Object.values(HERO_POSES).flat())].map((pose) => `hero_${dir}_${pose}`),
);

export class AtlasAssets implements AssetProvider {
  readonly #atlas: HeroAtlas;
  #release: (() => void) | undefined;

  /** `release` frees the sheet this provider owns (world.ts: `Assets.unload`). */
  constructor(atlas: HeroAtlas, release: () => void) {
    this.#atlas = atlas;
    this.#release = release;
  }

  /** Total for a sheet that passed `createCharacterAssets`' every-frame check. */
  texture(action: WasmAction, facing: WasmDirection, phase = 0): Texture {
    return this.#atlas.textures[heroFrameKey(action, facing, phase)] as Texture;
  }

  /** Release the sheet's textures, once: it creates none of its own. */
  destroy(): void {
    const release = this.#release;
    this.#release = undefined;
    release?.();
  }
}

/**
 * Choose the character provider: the hero atlas when it holds every hero frame, else
 * `PlaceholderAssets` (an incomplete sheet is released, since nothing will use it).
 */
export function createCharacterAssets(
  renderer: Renderer,
  atlas: HeroAtlas | undefined,
  release: () => void,
): AssetProvider {
  if (atlas !== undefined && HERO_FRAME_KEYS.every((key) => atlas.textures[key] !== undefined)) {
    return new AtlasAssets(atlas, release);
  }
  if (atlas !== undefined) release();
  return new PlaceholderAssets(renderer);
}
