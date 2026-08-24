// render/world.ts — the WorldRenderer (M4b, ADR-0013/0014). Imperative shell.
//
// Draws the authoritative world: the tile map ONCE from the wasm `zone_map()`
// value (never a hard-coded TS grid), then one POOLED CharacterView per entity,
// mutated in place each frame, torn down on despawn, painted in a STABLE z-order.
// It owns NO game state and reads NO store/predictor directly — the M4c loop feeds
// it already-resolved `RenderEntity` positions (own from the predictor's slide
// clock, remote from the interpolation buffer), keeping `server -> store -> render`
// one-way (ADR-0014). The renderer's correctness is validated by the M5 e2e via
// `window.__game()` (no pixel tests); its decision logic is the tested pure core
// (map / interpolation / slideClock / zorder / viewRegistry).
import { Application, Container, Graphics } from 'pixi.js';
import type { WasmAction, WasmDirection } from '../convert/convert';
import { t } from '../ui/a11yCopy';
import { FollowCamera } from './camera';
import type { AssetProvider } from './characterView';
import { CharacterView } from './characterView';
import { TILE_PX } from './config';
import { type RawTileMap, TileMap } from './map';
import { PlaceholderAssets } from './placeholderAssets';
import { appInitOptions, type ViewportScale, viewportScale, worldToScreen } from './viewport';
import { ViewRegistry } from './viewRegistry';
import { zIndexForEntity } from './zorder';

const WALL_COLOR = 0x222838;
const FLOOR_COLOR = 0x10131a;
// Grass is walkable floor PLUS an additive overlay (M8c) — the tile the wild
// encounter triggers on. Visual-SSOT: the overlay is driven by `map.isGrass`,
// never a hard-coded grid.
const GRASS_COLOR = 0x1f4d2b;

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
  readonly #actors = new Container();
  readonly #views = new Map<bigint, CharacterView>();
  readonly #registry = new ViewRegistry();
  readonly #camera = new FollowCamera();
  // The resolved viewport scale, tracked by resize() so render() can compute the
  // camera offset in SOURCE px and the stage transform. NON-OPTIONAL and seeded
  // with a valid record: an undefined-gated field would leave any frame drawn
  // before the first resize() with NO camera transform at all.
  #vs: ViewportScale = viewportScale(1, 1, 1);
  // uxd2 (ADR-0161 D6): the camera offset render() ACTUALLY applied last frame,
  // stashed so screenFor() reuses the exact stage transform (never a parallel
  // camera recomputation, which desyncs by the sub-tile slide amount).
  #lastOffset = { x: 0, y: 0 };

  /** Create the Pixi app, mount its canvas, and draw the tile map ONCE. */
  async init(mount: HTMLElement, rawMap: RawTileMap): Promise<void> {
    const map = TileMap.fromRaw(rawMap);
    const app = new Application();
    // Read the window ONCE and derive both the Pixi options and #vs from that one
    // triple, so the backing store and the stage transform can never disagree.
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const dpr = window.devicePixelRatio;
    // M11c: viewport-sized canvas; camera offset via stage.position. uxd1: the
    // DPR-correct backing store (resolution/autoDensity) is decided in viewport.ts.
    await app.init(appInitOptions(cssW, cssH, dpr, FLOOR_COLOR));
    mount.appendChild(app.canvas);
    // m23-s4 (M23 §2.3, A11Y-17): the canvas IS the world region, and it is the ONLY node that may
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
    app.stage.addChild(this.#actors);
    // e-4 (ADR-0090): Pixi sorts children by zIndex when sortableChildren is true.
    // This replaces the O(n²) setChildIndex loop with O(n log n) auto-sort.
    this.#actors.sortableChildren = true;
    this.#app = app;
    this.#map = map;
    this.#assets = new PlaceholderAssets(app.renderer);
    this.#drawMap(map);
  }

  #drawMap(map: TileMap): void {
    // Destroy removed children to release GPU memory (M12.5d-5: removeChildren without
    // destroy leaks Pixi Graphics resources on every zone switch).
    for (const child of this.#bg.removeChildren()) child.destroy();
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
  }

  /** Render one frame: pool create/destroy (teardown on despawn — no ghost),
   *  mutate each view in place, apply a stable z-order, and scroll the
   *  follow-camera to keep the own entity centred. (M11c, ADR-0067) */
  render(entities: readonly RenderEntity[], ownTileX = 0, ownTileY = 0): void {
    const assets = this.#assets;
    if (assets === undefined) return; // not initialised yet
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
      // offsetFor takes the EFFECTIVE viewport in SOURCE px, never CSS px (uxd1 R1).
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
  }

  /** uxd1: resize to CSS viewport dimensions at the live dpr, and apply the
   *  device-integer stage scale (ADR-0160). Pixi's 3-arg resize re-resolutions the
   *  backing store, so a monitor drag re-crisps without a reload. */
  resize(cssW: number, cssH: number, dpr: number): void {
    const vs = viewportScale(cssW, cssH, dpr);
    this.#vs = vs;
    const app = this.#app;
    if (app === undefined) return;
    app.renderer.resize(vs.cssW, vs.cssH, vs.dpr);
    app.stage.scale.set(vs.stageScale);
  }

  /** uxd2 (ADR-0161 D6): world (SOURCE px) → screen (CSS px) under the camera
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
    // #28c: generated placeholder textures are not in the stage tree, so
    // app.destroy(true) alone leaks them — release them explicitly first.
    this.#assets?.destroy?.();
    this.#assets = undefined;
    this.#app?.destroy(true);
    this.#app = undefined;
  }
}
