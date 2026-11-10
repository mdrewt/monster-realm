// render/world.ts — the WorldRenderer. Imperative shell.
//
// Draws the authoritative world: the tile map ONCE from the wasm `zone_map()`
// value (never a hard-coded TS grid), then one POOLED CharacterView per entity,
// mutated in place each frame, torn down on despawn, painted in a STABLE z-order.
// It owns NO game state and reads NO store/predictor directly — the M4c loop feeds
// it already-resolved `RenderEntity` positions (own from the predictor's slide
// clock, remote from the interpolation buffer), keeping `server -> store -> render`
// one-way. The renderer's correctness is validated by the M5 e2e via
// `window.__game()` (no pixel tests); its decision logic is the tested pure core
// (map / interpolation / slideClock / zorder / viewRegistry / terrainLayout).
//
// wap-4: the terrain is the kit atlas laid out by `terrainLayout.ts` — static tiles
// baked into nearest-sampled chunk textures at the device scale, animated water as
// per-tile sprites whose texture swaps only when its frame index changes. Without
// the kit or a terrain layer it falls back to the flat wall/grass rects.
//
// wap-5: characters draw from the hero atlas (`atlasAssets.ts`), loaded beside the kit;
// without it they fall back to the procedural `PlaceholderAssets`.
//
// wap-6: landmarks and warp markers are laid out from the map's content rows by
// `decorLayout.ts`. Landmarks join the actors' row z-order (two tiles tall, bottom-
// anchored, so the top half rises over the row above); warp markers are ground decals
// under every actor, their pulse swapping texture only when its frame index changes.
// Without the landmarks atlas no decor is drawn.
//
// Drawing: Pixi's own ticker is stopped (`appInitOptions`), so nothing is drawn unless
// this class draws it — `render()` once per frame-loop frame, and `resize()` because a
// resize clears the canvas. A restored WebGL context re-applies the batch-texture cap
// and re-bakes the chunk and placeholder textures, which Pixi cannot restore itself.
import {
  Application,
  Assets,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  type Spritesheet,
  type Texture,
} from 'pixi.js';
import type { WasmAction, WasmDirection } from '../convert/convert';
import { t } from '../ui/a11yCopy';
import { HERO_SHEET_FILE } from './art/packs/characters';
import { LANDMARKS_FILE } from './art/packs/landmarks';
import { TERRAIN_KIT_FILE } from './art/packs/terrain';
import { createCharacterAssets, type HeroAtlas } from './atlasAssets';
import { FollowCamera } from './camera';
import type { AssetProvider } from './characterView';
import { CharacterView } from './characterView';
import { MAX_BATCH_TEXTURES, TILE_PX } from './config';
import { layoutDecor, warpFrameIndex } from './decorLayout';
import { type RawTileMap, TileMap } from './map';
import {
  type Chunk,
  ChunkCache,
  type ChunkTextureOptions,
  chunkTextureRequest,
  kitAtlasAsset,
  layoutTerrain,
  planChunks,
  type TerrainFrameInput,
  waterFrameIndex,
} from './terrainLayout';
import { appInitOptions, type ViewportScale, viewportScale, worldToScreen } from './viewport';
import { ViewRegistry } from './viewRegistry';
import { zIndexForEntity } from './zorder';

const WALL_COLOR = 0x222838;
const FLOOR_COLOR = 0x10131a;
// Grass is walkable floor PLUS an additive overlay (M8c) — the tile the wild
// encounter triggers on. Visual-SSOT: the overlay is driven by `map.isGrass`,
// never a hard-coded grid.
const GRASS_COLOR = 0x1f4d2b;
/** The kit atlas json beside its png in `client/public/assets/` (served at `assets/`). */
const KIT_ATLAS_URL = `assets/${TERRAIN_KIT_FILE.replace(/\.png$/, '.json')}`;
/** The hero atlas json beside its png (wap-5). */
const HERO_ATLAS_URL = `assets/${HERO_SHEET_FILE.replace(/\.png$/, '.json')}`;
/** The landmarks atlas json beside its png (wap-6). */
const LANDMARKS_ATLAS_URL = `assets/${LANDMARKS_FILE.replace(/\.png$/, '.json')}`;

/** An animated tile (water, warp marker): its sprite, its frame textures, and the frame it shows. */
interface AnimatedTile {
  readonly sprite: Sprite;
  readonly frames: readonly Texture[];
  shown: number;
}

/** An atlas frame's texture; the layout planners have already checked every key they emit. */
function atlasTexture(sheet: Spritesheet, key: string): Texture {
  const texture = sheet.textures[key];
  if (texture === undefined) throw new Error(`render/world: atlas has no frame "${key}"`);
  return texture;
}

/** Constraint 7: swap a tile's texture only when its frame index changes. */
function showFrame(tile: AnimatedTile, k: number): void {
  const texture = tile.frames[k];
  if (k !== tile.shown && texture !== undefined) {
    tile.sprite.texture = texture;
    tile.shown = k;
  }
}

/** A decor sprite bottom-anchored on tile (x, y): a two-tile-tall frame's upper half
 *  covers the row above, exactly where a character on that row is drawn. */
function decorSprite(texture: Texture, x: number, y: number): Sprite {
  const sprite = new Sprite(texture);
  sprite.anchor.set(0, 1);
  sprite.position.set(x * TILE_PX, (y + 1) * TILE_PX);
  return sprite;
}

/** A draw-ready entity: a FRACTIONAL tile position already resolved by the loop. */
export interface RenderEntity {
  readonly entityId: bigint;
  readonly x: number;
  readonly y: number;
  readonly action: WasmAction;
  readonly facing: WasmDirection;
}

export class WorldRenderer {
  #app: Application | undefined;
  #map: TileMap | undefined;
  #assets: AssetProvider | undefined;
  readonly #bg = new Container();
  readonly #decor = new Container();
  readonly #actors = new Container();
  readonly #views = new Map<bigint, CharacterView>();
  readonly #registry = new ViewRegistry();
  readonly #camera = new FollowCamera();
  // The resolved viewport scale, tracked by resize() so render() can compute the
  // camera offset in SOURCE px and the stage transform. NON-OPTIONAL and seeded
  // with a valid record: an undefined-gated field would leave any frame drawn
  // before the first resize() with NO camera transform at all.
  #vs: ViewportScale = viewportScale(1, 1, 1);
  // The camera offset render() ACTUALLY applied last frame,
  // stashed so screenFor() reuses the exact stage transform (never a parallel
  // camera recomputation, which desyncs by the sub-tile slide amount).
  #lastOffset = { x: 0, y: 0 };
  // wap-4 terrain: the loaded kit (undefined ⟹ flat fallback), the chunk textures it
  // bakes (owned by the cache, destroyed on setMap / rescale / destroy), the device
  // scale they were baked at, and the animated water tiles.
  #kit: Spritesheet | undefined;
  #chunks: ChunkCache<Texture> | undefined;
  #chunkScale = 0;
  #water: AnimatedTile[] = [];
  // wap-6 decor: the loaded landmarks atlas (undefined ⟹ no decor), the landmark
  // sprites it placed in #actors (tracked explicitly: #actors also holds the
  // character sprites), and the pulsing warp markers in #decor.
  #landmarksSheet: Spritesheet | undefined;
  #landmarkSprites: Sprite[] = [];
  #warpMarkers: AnimatedTile[] = [];

  /** Create the Pixi app, mount its canvas, and draw the tile map ONCE. */
  async init(mount: HTMLElement, rawMap: RawTileMap): Promise<void> {
    const map = TileMap.fromRaw(rawMap);
    const app = new Application();
    // Read the window ONCE and derive both the Pixi options and #vs from that one
    // triple, so the backing store and the stage transform can never disagree.
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const dpr = window.devicePixelRatio;
    // viewport-sized canvas; camera offset via stage.position. The
    // DPR-correct backing store (resolution/autoDensity) is decided in viewport.ts.
    await app.init(appInitOptions(cssW, cssH, dpr, FLOOR_COLOR));
    capBatchTextures(app);
    // Pixi's own listener (registered in app.init, so it runs first) has rebuilt its GL
    // state by the time this one runs.
    app.canvas.addEventListener('webglcontextrestored', this.#onContextRestored);
    mount.appendChild(app.canvas);
    // The canvas IS the world region, and it is the ONLY node that may
    // carry role="application". NOT `mount` (`#app`): main.ts passes that same element as the
    // parent of battleView/boxView/raisingView/evolutionView, so an application role there would
    // swallow four dialogs into an application region and destroy their dialog semantics.
    // `tabindex="0"` makes the region a single, real tab stop — the thing a screen-reader user
    // needs in order to reach the world at all — and the name comes from the copy catalog, never a
    // literal (§2.8, the M24 seam). This file is coverage-excluded, so the gate is a source scan
    // that is brace-scoped to THIS method body and fails loud if the append anchor above moves.
    app.canvas.setAttribute('role', 'application');
    app.canvas.setAttribute('tabindex', '0');
    app.canvas.setAttribute('aria-label', t('a11y.world.region'));
    // init() applies the stage scale ITSELF rather than relying on the caller to
    // land a resize() first. main.ts happens to call installResizeHandler (which
    // resizes synchronously) right after init(), but nothing enforces that
    // ordering — and world.ts is coverage-excluded, so a future `await` slipped
    // between the two would silently draw the first frame at scale 1.
    this.#vs = viewportScale(cssW, cssH, dpr);
    app.stage.scale.set(this.#vs.stageScale);
    app.stage.addChild(this.#bg);
    app.stage.addChild(this.#decor);
    app.stage.addChild(this.#actors);
    // e-4: Pixi sorts children by zIndex when sortableChildren is true.
    // This replaces the O(n²) setChildIndex loop with O(n log n) auto-sort.
    this.#actors.sortableChildren = true;
    this.#app = app;
    this.#map = map;
    const [kit, hero, landmarks] = await Promise.all([loadKit(), loadHero(), loadLandmarks()]);
    const releaseHero = (): void => {
      Assets.unload(HERO_ATLAS_URL).catch((err) =>
        console.warn('render/world: hero atlas failed to unload', err),
      );
    };
    if (this.#app !== app) {
      // destroy() ran while the atlases loaded: the hero and landmarks sheets have no owner yet.
      if (hero !== undefined) releaseHero();
      if (landmarks !== undefined) releaseLandmarks();
      return;
    }
    this.#assets = createCharacterAssets(app.renderer, hero, releaseHero);
    this.#kit = kit;
    // No kit ⟹ no chunk cache: #drawMap takes the flat fallback.
    this.#chunks =
      kit &&
      new ChunkCache<Texture>(
        (chunk, options) => bakeChunk(app, kit, chunk, options),
        (texture) => texture.destroy(true),
      );
    this.#landmarksSheet = landmarks;
    // A setMap() that ran while the atlases loaded already replaced #map: draw that one.
    const current = this.#map ?? map;
    this.#drawMap(current);
    this.#drawDecor(current);
  }

  /** A restored WebGL context comes back with Pixi's limits re-read from the device and
   *  with every render-target texture (the baked chunks, the generated placeholders)
   *  empty; atlas textures re-upload from their images on their own. */
  readonly #onContextRestored = (): void => {
    const app = this.#app;
    if (app === undefined) return;
    capBatchTextures(app);
    if (this.#assets?.contextRestored !== undefined) {
      // Views hold the dropped textures: recreate them on the next render().
      this.clear();
      this.#assets.contextRestored();
    }
    try {
      const map = this.#map;
      if (map !== undefined && (this.#chunks?.size ?? 0) > 0) this.#drawMap(map);
    } finally {
      // Draw even if the re-bake threw: the frame loop may be parked (session terminal).
      app.render();
    }
  };

  #drawMap(map: TileMap): void {
    const kit = this.#kit;
    const chunkCache = this.#chunks;
    const plan = layoutTerrain(
      map,
      kit === undefined ? undefined : new Set(Object.keys(kit.textures)),
    );
    if (plan.kind === 'flat' || kit === undefined || chunkCache === undefined) {
      this.#clearBg();
      chunkCache?.clear();
      if (plan.kind === 'flat') {
        const [warning] = plan.warnings;
        console.warn(`render/world: flat terrain fallback (${warning.code}): ${warning.detail}`);
      }
      this.#drawFlat(map);
      return;
    }
    const { chunks, animated } = planChunks(map.width, map.height, plan.tiles);
    const deviceScale = this.#vs.deviceScale;
    // Bake BEFORE tearing down: the build is atomic, so a Pixi/GPU throw here leaves
    // the previous terrain on screen (RT-SZ-01) instead of a blank world.
    const textures = chunkCache.build(chunks, deviceScale);
    this.#chunkScale = deviceScale;
    this.#clearBg();
    chunks.forEach((chunk, i) => {
      const sprite = new Sprite(textures[i]);
      sprite.position.set(chunk.x * TILE_PX, chunk.y * TILE_PX);
      this.#bg.addChild(sprite);
    });
    for (const tile of animated) {
      const frames = (tile.animation ?? [tile.frame]).map((key) => atlasTexture(kit, key));
      const sprite = new Sprite(frames[0]);
      sprite.position.set(tile.x * TILE_PX, tile.y * TILE_PX);
      this.#bg.addChild(sprite);
      this.#water.push({ sprite, frames, shown: 0 });
    }
  }

  /** Lay out the landmarks and warp markers from the map's content rows (decorLayout.ts).
   *  Every frame key is checked against the atlas and the new sprites are built BEFORE
   *  the old decor is torn down, so a bad sheet leaves no decor rather than a throw. */
  #drawDecor(map: TileMap): void {
    const sheet = this.#landmarksSheet;
    if (sheet === undefined) {
      this.#clearDecor();
      return;
    }
    const plan = layoutDecor(map);
    const keys = [...plan.landmarks.map((l) => l.frame), ...plan.warps.flatMap((w) => w.frames)];
    const missing = keys.find((key) => sheet.textures[key] === undefined);
    if (missing !== undefined) {
      console.warn(`render/world: landmarks atlas has no frame "${missing}"`);
      this.#clearDecor();
      return;
    }
    const landmarkSprites = plan.landmarks.map((l) => {
      const sprite = decorSprite(atlasTexture(sheet, l.frame), l.x, l.y);
      sprite.zIndex = l.zIndex;
      return sprite;
    });
    const warpMarkers = plan.warps.map((w): AnimatedTile => {
      const frames = w.frames.map((key) => atlasTexture(sheet, key));
      return { sprite: decorSprite(frames[0] as Texture, w.x, w.y), frames, shown: 0 };
    });
    this.#clearDecor();
    for (const sprite of landmarkSprites) this.#actors.addChild(sprite);
    for (const marker of warpMarkers) this.#decor.addChild(marker.sprite);
    this.#landmarkSprites = landmarkSprites;
    this.#warpMarkers = warpMarkers;
  }

  /** Remove and destroy exactly the decor sprites (never the character sprites that
   *  share #actors). Their textures belong to the landmarks atlas. */
  #clearDecor(): void {
    for (const sprite of this.#landmarkSprites) {
      this.#actors.removeChild(sprite);
      sprite.destroy();
    }
    this.#landmarkSprites = [];
    for (const child of this.#decor.removeChildren()) child.destroy();
    this.#warpMarkers = [];
  }

  /** Destroy the background's children to release GPU memory (M12.5d-5: removeChildren
   *  without destroy leaks Pixi Graphics resources on every zone switch). A chunk
   *  sprite's texture is NOT destroyed here — the chunk cache owns it. */
  #clearBg(): void {
    for (const child of this.#bg.removeChildren()) child.destroy();
    this.#water = [];
  }

  /** The pre-wap-4 flat look: wall rects + the tall-grass overlay over the floor clear. */
  #drawFlat(map: TileMap): void {
    const g = new Graphics();
    // Floor/wall pass.
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (!map.isWalkable(x, y)) {
          g.rect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX).fill(WALL_COLOR);
        }
      }
    }
    // Grass overlay pass (M8c): additive, AFTER floor/wall. Grass is still
    // walkable floor; the overlay marks where a wild encounter can trigger.
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.isGrass(x, y)) {
          g.rect(x * TILE_PX, y * TILE_PX, TILE_PX, TILE_PX).fill(GRASS_COLOR);
        }
      }
    }
    this.#bg.addChild(g);
  }

  /** Zone switch (M11c/M12.5c): replace the tile background with the new zone's map.
   *  Called by switchZone() in main.ts BEFORE rawMap reassignment (RT-SZ-01: renderer
   *  draw is the first real side-effect so a Pixi/GPU throw leaves rawMap unchanged).
   *  TileMap.fromRaw validation has already succeeded in the caller. Does NOT call
   *  resetCharacters(). */
  setMap(rawMap: RawTileMap): void {
    const map = TileMap.fromRaw(rawMap);
    this.#map = map;
    // Drop all pooled character views — they belong to the old zone.
    this.clear();
    this.#drawMap(map);
    // Decor is placed here, after clear() and before any render() re-creates a
    // character, so a character on a landmark's own row (an equal zIndex) is added
    // later and draws in front of it by insertion order.
    this.#drawDecor(map);
  }

  /** Render one frame: pool create/destroy (teardown on despawn — no ghost),
   *  mutate each view in place, apply a stable z-order, and scroll the
   *  follow-camera to keep the own entity centred. `frame` (wap-4) carries the
   *  injected clock + reduced-motion bit for the water and warp-marker animations;
   *  omitted ⟹ both hold. */
  render(
    entities: readonly RenderEntity[],
    ownTileX = 0,
    ownTileY = 0,
    frame?: TerrainFrameInput,
  ): void {
    const assets = this.#assets;
    if (assets === undefined) return; // not initialised yet
    if (frame !== undefined) {
      const { nowMs, reduceMotion } = frame;
      for (const water of this.#water) {
        showFrame(water, waterFrameIndex(nowMs, reduceMotion, water.frames.length));
      }
      for (const marker of this.#warpMarkers) {
        showFrame(marker, warpFrameIndex(nowMs, reduceMotion, marker.frames.length));
      }
    }
    const { created, removed } = this.#registry.reconcile(entities.map((e) => e.entityId));
    for (const id of created) {
      const view = new CharacterView(assets);
      this.#views.set(id, view);
      this.#actors.addChild(view.sprite);
    }
    for (const id of removed) {
      const view = this.#views.get(id);
      if (view !== undefined) {
        this.#actors.removeChild(view.sprite);
        view.destroy();
        this.#views.delete(id);
      }
    }
    // e-4: update position + set zIndex in the same pass so newly-spawned sprites
    // (just addChild'd above with default zIndex=0) get their depth assigned before
    // Pixi's sortableChildren sort fires at the next render tick.
    for (const e of entities) {
      const view = this.#views.get(e.entityId);
      if (view !== undefined) {
        view.update(e.x, e.y, e.action, e.facing);
        view.sprite.zIndex = zIndexForEntity(e.y);
      }
    }
    // M11c follow-camera: translate the stage so the own entity stays centred.
    const map = this.#map;
    const app = this.#app;
    if (app !== undefined && map !== undefined) {
      const vs = this.#vs;
      // offsetFor takes the EFFECTIVE viewport in SOURCE px, never CSS px.
      this.#lastOffset = this.#camera.offsetFor(
        ownTileX,
        ownTileY,
        vs.effectiveW,
        vs.effectiveH,
        map.width,
        map.height,
      );
      // The stage's screen position IS where the world origin lands under this
      // camera — routed through worldToScreen so the shipped transform is the
      // ONE tested formula, not a parallel copy of it.
      const origin = worldToScreen({ x: 0, y: 0 }, this.#lastOffset, vs.stageScale);
      app.stage.position.set(origin.x, origin.y);
    }
    // The one draw per frame: present the state resolved above in this same task.
    app?.render();
  }

  /** Resize to CSS viewport dimensions at the live dpr, and apply the
   *  device-integer stage scale. Pixi's 3-arg resize re-resolutions the
   *  backing store, so a monitor drag re-crisps without a reload. */
  resize(cssW: number, cssH: number, dpr: number): void {
    const vs = viewportScale(cssW, cssH, dpr);
    this.#vs = vs;
    const app = this.#app;
    if (app === undefined) return;
    app.renderer.resize(vs.cssW, vs.cssH, vs.dpr);
    app.stage.scale.set(vs.stageScale);
    // Chunk textures are baked at the device scale (Constraint 7a): re-bake on a change.
    const map = this.#map;
    if (map !== undefined && (this.#chunks?.size ?? 0) > 0 && vs.deviceScale !== this.#chunkScale) {
      this.#drawMap(map);
    }
    // Resizing cleared the canvas, and the frame loop may be parked (session terminal).
    app.render();
  }

  /** World (SOURCE px) → screen (CSS px) under the camera
   *  offset + stageScale the last render() ACTUALLY applied — the DOM interact
   *  prompt reuses the stage's own transform, so it cannot swim against the
   *  canvas mid-slide. Built on the tested worldToScreen (render/viewport.ts). */
  screenFor(world: { x: number; y: number }): { x: number; y: number } {
    return worldToScreen(world, this.#lastOffset, this.#vs.stageScale);
  }

  get viewCount(): number {
    return this.#views.size;
  }

  /** Reconnect/teardown: drop every pooled view (no leaked sprites). */
  clear(): void {
    for (const view of this.#views.values()) view.destroy();
    this.#views.clear();
    this.#registry.reconcile([]);
  }

  destroy(): void {
    this.clear();
    // #28c: provider textures (generated placeholders, or the hero sheet) are not in
    // the stage tree, so app.destroy(true) alone leaks them — release them explicitly first.
    this.#assets?.destroy?.();
    this.#assets = undefined;
    // The baked chunk textures are not in the atlas cache: release them explicitly.
    this.#chunks?.clear();
    this.#water = [];
    // Decor sprites leave the stage before app.destroy(true), then the atlas is released.
    this.#clearDecor();
    if (this.#landmarksSheet !== undefined) {
      this.#landmarksSheet = undefined;
      releaseLandmarks();
    }
    this.#app?.canvas.removeEventListener('webglcontextrestored', this.#onContextRestored);
    this.#app?.destroy(true);
    this.#app = undefined;
  }
}

/** Hold the sprite batcher to `MAX_BATCH_TEXTURES` (config.ts). Pixi re-reads the limit
 *  from the device on every context change, so this runs at init and after a restore. */
function capBatchTextures(app: Application): void {
  const { limits } = app.renderer;
  limits.maxBatchableTextures = Math.min(limits.maxBatchableTextures, MAX_BATCH_TEXTURES);
}

/** Load the terrain kit atlas, sampled `nearest` (Constraint 7a). A load failure is
 *  not fatal: the map draws the flat fallback. */
async function loadKit(): Promise<Spritesheet | undefined> {
  try {
    return await Assets.load<Spritesheet>(kitAtlasAsset(KIT_ATLAS_URL));
  } catch (err) {
    console.warn('render/world: terrain kit failed to load', err);
    return undefined;
  }
}

/** Load the hero atlas, sampled `nearest` like the kit. A load failure is not fatal:
 *  characters draw with the placeholder provider. */
async function loadHero(): Promise<HeroAtlas | undefined> {
  try {
    return await Assets.load<Spritesheet>(kitAtlasAsset(HERO_ATLAS_URL));
  } catch (err) {
    console.warn('render/world: hero atlas failed to load', err);
    return undefined;
  }
}

/** Load the landmarks atlas (wap-6), sampled `nearest` like the kit. A load failure is
 *  not fatal: no landmarks or warp markers are drawn. */
async function loadLandmarks(): Promise<Spritesheet | undefined> {
  try {
    return await Assets.load<Spritesheet>(kitAtlasAsset(LANDMARKS_ATLAS_URL));
  } catch (err) {
    console.warn('render/world: landmarks atlas failed to load', err);
    return undefined;
  }
}

function releaseLandmarks(): void {
  Assets.unload(LANDMARKS_ATLAS_URL).catch((err) =>
    console.warn('render/world: landmarks atlas failed to unload', err),
  );
}

/** Bake one chunk's static tiles into a texture with the cache's options. */
function bakeChunk(
  app: Application,
  kit: Spritesheet,
  chunk: Chunk,
  options: ChunkTextureOptions,
): Texture {
  const scratch = new Container();
  for (const tile of chunk.tiles) {
    const sprite = new Sprite(atlasTexture(kit, tile.frame));
    sprite.position.set((tile.x - chunk.x) * TILE_PX, (tile.y - chunk.y) * TILE_PX);
    scratch.addChild(sprite);
  }
  const texture = app.renderer.generateTexture({
    target: scratch,
    frame: new Rectangle(0, 0, chunk.w * TILE_PX, chunk.h * TILE_PX),
    ...chunkTextureRequest(options),
  });
  // The scratch sprites go; their textures belong to the atlas.
  scratch.destroy({ children: true });
  return texture;
}
