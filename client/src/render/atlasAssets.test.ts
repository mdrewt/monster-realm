// render/atlasAssets.test.ts — the hero atlas provider and the provider factory
// (vitest, node-only; structural fakes, no GPU).
//
// Teeth (each names the wrong impl it kills):
// - WAP5.1 cell table: a mapping that swaps facings, or ignores action/phase.
// - WAP5.1 disjoint sets: Walking reusing the idle/jump frame (an action collapsed).
// - WAP5.1 stepA != stepB: a walk that never alternates its step pose.
// - WAP5.1 facings never share a frame: a facing collapsed onto another.
// - WAP5.3 undefined atlas -> PlaceholderAssets, release untouched: a factory that
//   throws or calls release for a missing sheet.
// - WAP5.3 incomplete atlas -> placeholder + release once: a half-sheet shipped
//   (undefined textures at runtime) or a leaked unusable sheet.
// - WAP5.3 destroy releases every created texture exactly once: a provider that
//   forgets textures, double-destroys, or calls release twice.
//
// Frame names are hard-coded literals here, never imported from the module.

import type { Renderer, Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import type { WasmAction, WasmDirection } from '../convert/convert';
import { AtlasAssets, createCharacterAssets, type HeroAtlas, heroFrameKey } from './atlasAssets';
import { PlaceholderAssets } from './placeholderAssets';

const ACTIONS: readonly WasmAction[] = ['Idle', 'Walking', 'Jumping'];
const FACINGS: readonly WasmDirection[] = ['North', 'South', 'East', 'West'];

const DIR: Record<WasmDirection, string> = {
  South: 'down',
  North: 'up',
  East: 'right',
  West: 'left',
};
const DIRS = ['down', 'up', 'right', 'left'] as const;
const POSES = ['idle', 'stepA', 'mid', 'stepB', 'jump'] as const;

/** Walking pose per phase, literal. */
const WALK_POSE = ['stepA', 'mid', 'stepB', 'mid'] as const;

function fullAtlas(): { atlas: HeroAtlas; textures: Record<string, Texture> } {
  const textures: Record<string, Texture> = {};
  for (const d of DIRS) {
    for (const p of POSES) textures[`hero_${d}_${p}`] = { name: `hero_${d}_${p}` } as never;
  }
  return { atlas: { textures }, textures };
}

function atlasWithout(missing: string): HeroAtlas {
  const { textures } = fullAtlas();
  delete textures[missing];
  return { textures };
}

interface FakeTex {
  destroyCalls: (boolean | undefined)[];
}

function fakeRenderer(): { renderer: Renderer; created: FakeTex[] } {
  const created: FakeTex[] = [];
  const renderer = {
    generateTexture() {
      const t: FakeTex & { destroy(b?: boolean): void } = {
        destroyCalls: [],
        destroy(b?: boolean) {
          t.destroyCalls.push(b);
        },
      };
      created.push(t);
      return t;
    },
  } as unknown as Renderer;
  return { renderer, created };
}

describe('heroFrameKey / AtlasAssets mapping', () => {
  it('WAP5.1 every (action, facing, phase) cell returns the expected atlas frame', () => {
    const { atlas, textures } = fullAtlas();
    const assets = new AtlasAssets(atlas, () => {});
    for (const action of ACTIONS) {
      for (const facing of FACINGS) {
        for (let phase = 0; phase < 4; phase++) {
          const pose =
            action === 'Idle' ? 'idle' : action === 'Jumping' ? 'jump' : WALK_POSE[phase];
          const name = `hero_${DIR[facing]}_${pose}`;
          expect(heroFrameKey(action, facing, phase)).toBe(name);
          expect(assets.texture(action, facing, phase)).toBe(textures[name]);
        }
      }
    }
  });

  it('WAP5.1 phase defaults to 0 and Idle/Jumping ignore the phase', () => {
    expect(heroFrameKey('Walking', 'South')).toBe('hero_down_stepA');
    expect(heroFrameKey('Idle', 'North')).toBe('hero_up_idle');
    expect(heroFrameKey('Jumping', 'East')).toBe('hero_right_jump');
    for (let p = 0; p < 4; p++) {
      expect(heroFrameKey('Idle', 'West', p)).toBe('hero_left_idle');
      expect(heroFrameKey('Jumping', 'West', p)).toBe('hero_left_jump');
    }
  });

  it('WAP5.1 phases wrap modulo 4, negatives non-negatively', () => {
    expect(heroFrameKey('Walking', 'East', 4)).toBe('hero_right_stepA');
    expect(heroFrameKey('Walking', 'East', 6)).toBe('hero_right_stepB');
    expect(heroFrameKey('Walking', 'East', -1)).toBe('hero_right_mid');
    expect(heroFrameKey('Walking', 'East', -2)).toBe('hero_right_stepB');
  });

  it('WAP5.1 Idle, Walking and Jumping frame sets are pairwise disjoint per facing', () => {
    const { atlas } = fullAtlas();
    const assets = new AtlasAssets(atlas, () => {});
    for (const facing of FACINGS) {
      const sets = ACTIONS.map((a) => {
        const s = new Set<Texture>();
        for (let p = 0; p < 4; p++) s.add(assets.texture(a, facing, p));
        return s;
      });
      for (let i = 0; i < sets.length; i++) {
        for (let j = i + 1; j < sets.length; j++) {
          const overlap = [...(sets[i] ?? [])].filter((t) => sets[j]?.has(t));
          expect(overlap).toEqual([]);
        }
      }
    }
  });

  it('WAP5.1 Walking visits stepA, mid and stepB and the step pose alternates', () => {
    const { atlas, textures } = fullAtlas();
    const assets = new AtlasAssets(atlas, () => {});
    for (const facing of FACINGS) {
      const d = DIR[facing];
      const seen = new Set<Texture>();
      for (let p = 0; p < 4; p++) seen.add(assets.texture('Walking', facing, p));
      expect(seen.has(textures[`hero_${d}_stepA`] as Texture)).toBe(true);
      expect(seen.has(textures[`hero_${d}_mid`] as Texture)).toBe(true);
      expect(seen.has(textures[`hero_${d}_stepB`] as Texture)).toBe(true);
      expect(assets.texture('Walking', facing, 0)).not.toBe(assets.texture('Walking', facing, 2));
    }
  });

  it('WAP5.1 the four facings never share a frame', () => {
    const { atlas } = fullAtlas();
    const assets = new AtlasAssets(atlas, () => {});
    const owner = new Map<Texture, WasmDirection>();
    for (const facing of FACINGS) {
      for (const action of ACTIONS) {
        for (let p = 0; p < 4; p++) {
          const t = assets.texture(action, facing, p);
          const prev = owner.get(t);
          expect(prev === undefined || prev === facing).toBe(true);
          owner.set(t, facing);
        }
      }
    }
    expect(owner.size).toBe(20);
  });
});

describe('createCharacterAssets', () => {
  it('WAP5.3 no atlas returns PlaceholderAssets and does not call release', () => {
    const { renderer } = fakeRenderer();
    let released = 0;
    const assets = createCharacterAssets(renderer, undefined, () => {
      released++;
    });
    expect(assets).toBeInstanceOf(PlaceholderAssets);
    expect(released).toBe(0);
  });

  it('WAP5.3 an atlas missing any hero frame falls back to placeholder and releases once', () => {
    const { renderer } = fakeRenderer();
    for (const d of DIRS) {
      for (const p of POSES) {
        let released = 0;
        const assets = createCharacterAssets(renderer, atlasWithout(`hero_${d}_${p}`), () => {
          released++;
        });
        expect(assets).toBeInstanceOf(PlaceholderAssets);
        expect(assets).not.toBeInstanceOf(AtlasAssets);
        expect(released).toBe(1);
      }
    }
  });

  it('WAP5.3 a complete atlas returns AtlasAssets without touching the renderer', () => {
    const { renderer, created } = fakeRenderer();
    let released = 0;
    const { atlas, textures } = fullAtlas();
    const assets = createCharacterAssets(renderer, atlas, () => {
      released++;
    });
    expect(assets).toBeInstanceOf(AtlasAssets);
    expect(assets.texture('Walking', 'West', 2)).toBe(textures.hero_left_stepB);
    expect(released).toBe(0);
    expect(created).toHaveLength(0);
  });

  it('WAP5.3 destroying the atlas provider calls release exactly once, even twice', () => {
    const { renderer, created } = fakeRenderer();
    let released = 0;
    const { atlas } = fullAtlas();
    const assets = createCharacterAssets(renderer, atlas, () => {
      released++;
    });
    assets.destroy?.();
    expect(released).toBe(1);
    assets.destroy?.();
    expect(released).toBe(1);
    expect(created).toHaveLength(0);
  });

  it('WAP5.3 AtlasAssets constructed directly releases once on repeated destroy', () => {
    let released = 0;
    const assets = new AtlasAssets(fullAtlas().atlas, () => {
      released++;
    });
    assets.destroy();
    assets.destroy();
    expect(released).toBe(1);
  });

  it('WAP5.3 destroying the placeholder provider destroys every created texture once', () => {
    const { renderer, created } = fakeRenderer();
    const assets = createCharacterAssets(renderer, undefined, () => {});
    for (const action of ACTIONS) {
      for (const facing of FACINGS) {
        for (let phase = 0; phase < 4; phase++) assets.texture(action, facing, phase);
      }
    }
    expect(created).toHaveLength(12);
    assets.destroy?.();
    expect(created.every((t) => t.destroyCalls.length === 1 && t.destroyCalls[0] === true)).toBe(
      true,
    );
    const destroyed = created.filter((t) => t.destroyCalls.length > 0).length;
    expect(destroyed).toBe(created.length);
  });

  it('WAP5.3 placeholder ignores phase: same texture for any phase of a cell', () => {
    const { renderer, created } = fakeRenderer();
    const assets = createCharacterAssets(renderer, undefined, () => {});
    const a = assets.texture('Walking', 'North', 0);
    expect(assets.texture('Walking', 'North', 3)).toBe(a);
    expect(created).toHaveLength(1);
  });

  it('WAP5.3 the fallback placeholder for an incomplete atlas still releases its textures', () => {
    const { renderer, created } = fakeRenderer();
    let released = 0;
    const assets = createCharacterAssets(renderer, atlasWithout('hero_up_jump'), () => {
      released++;
    });
    assets.texture('Idle', 'South');
    assets.texture('Jumping', 'North');
    assets.destroy?.();
    expect(created).toHaveLength(2);
    expect(created.every((t) => t.destroyCalls.length === 1)).toBe(true);
    expect(released).toBe(1);
  });
});
