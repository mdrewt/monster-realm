// render/textureCache.test.ts — #28c: placeholder-texture teardown (vitest, node-only).
//
// SOURCE OF TRUTH: issue #28(c) — `generateTexture` results cached in
// `PlaceholderAssets` were never destroyed -> GPU-texture leak on teardown /
// real-asset swap. The testable contract is the pure `destroyAllTextures`
// helper; `PlaceholderAssets.destroy()` / `WorldRenderer.destroy()` are thin
// callers (not constructible in node — see zorderZIndex.test.ts header).
//
// Proof-of-teeth (ADR-0010): each assertion names the wrong impl it kills.

import { describe, expect, it } from 'vitest';
import { type DestroyableTexture, destroyAllTextures } from './textureCache';

class FakeTexture implements DestroyableTexture {
  destroyCalls: (boolean | undefined)[] = [];
  destroy(destroyBase?: boolean): void {
    this.destroyCalls.push(destroyBase);
  }
}

describe('destroyAllTextures (#28c)', () => {
  it('destroys EVERY cached texture with destroyBase=true and empties the cache', () => {
    const a = new FakeTexture();
    const b = new FakeTexture();
    const cache = new Map<string, FakeTexture>([
      ['Idle|South', a],
      ['Walking|North', b],
    ]);

    destroyAllTextures(cache);

    // Kills: an impl that only clear()s the map (textures kept alive by the
    // GPU even with no JS references — the original leak).
    expect(a.destroyCalls).toEqual([true]);
    expect(b.destroyCalls).toEqual([true]);
    // Kills: an impl that destroys but keeps stale (destroyed) entries that a
    // later texture() call would hand back to a Sprite.
    expect(cache.size).toBe(0);
  });

  it('is idempotent: a second call on the emptied cache is a no-op (no double-destroy)', () => {
    const a = new FakeTexture();
    const cache = new Map<string, FakeTexture>([['Idle|South', a]]);

    destroyAllTextures(cache);
    destroyAllTextures(cache);

    // Kills: an impl that iterates a retained snapshot and double-destroys
    // (pixi throws/warns on destroying an already-destroyed texture).
    expect(a.destroyCalls).toEqual([true]);
    expect(cache.size).toBe(0);
  });
});
