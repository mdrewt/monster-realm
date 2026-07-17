// render/textureCache.ts — texture-cache teardown helper (#28c).
//
// Extracted as a PURE module (no pixi.js import) per the render-test convention
// (see zorderZIndex.test.ts header): the destroy-all contract is unit-tested in
// node with structural fakes, while `PlaceholderAssets`/`WorldRenderer` stay
// thin callers. `generateTexture` results are NOT owned by the stage tree, so
// `app.destroy(true)` never reaches them — without an explicit destroy pass
// they leak GPU memory on teardown / real-asset swap.

/** Structural slice of `pixi.js` `Texture` needed for teardown. */
export interface DestroyableTexture {
  destroy(destroyBase?: boolean): void;
}

/**
 * Destroy every cached texture (including its base/GPU resource — the caches
 * hold `generateTexture` results, which own their base) and empty the cache.
 * Idempotent: safe on an already-empty cache.
 */
export function destroyAllTextures<K, T extends DestroyableTexture>(cache: Map<K, T>): void {
  for (const tex of cache.values()) tex.destroy(true);
  cache.clear();
}
