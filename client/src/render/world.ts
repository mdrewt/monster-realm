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
import type { AssetProvider } from './characterView';
import { CharacterView } from './characterView';
import { TILE_PX } from './config';
import { type RawTileMap, TileMap } from './map';
import { PlaceholderAssets } from './placeholderAssets';
import { ViewRegistry } from './viewRegistry';
import { sortedByZ } from './zorder';

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

  /** Create the Pixi app, mount its canvas, and draw the tile map ONCE. */
  async init(mount: HTMLElement, rawMap: RawTileMap): Promise<void> {
    const map = TileMap.fromRaw(rawMap);
    const app = new Application();
    await app.init({
      width: map.width * TILE_PX,
      height: map.height * TILE_PX,
      background: FLOOR_COLOR,
      antialias: false,
    });
    mount.appendChild(app.canvas);
    app.stage.addChild(this.#bg);
    app.stage.addChild(this.#actors);
    this.#app = app;
    this.#map = map;
    this.#assets = new PlaceholderAssets(app.renderer);
    this.#drawMap(map);
  }

  #drawMap(map: TileMap): void {
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

  /** Render one frame: pool create/destroy (teardown on despawn — no ghost),
   *  mutate each view in place, then apply a stable z-order. */
  render(entities: readonly RenderEntity[]): void {
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
    for (const e of entities) {
      this.#views.get(e.entityId)?.update(e.x, e.y, e.action, e.facing);
    }
    const order = sortedByZ(entities.map((e) => ({ entityId: e.entityId, y: e.y })));
    order.forEach((it, i) => {
      const view = this.#views.get(it.entityId);
      if (view !== undefined) this.#actors.setChildIndex(view.sprite, i);
    });
  }

  /** Keep the WHOLE zone visible (no scrolling camera at M4 — follow-camera is M11). */
  resize(viewWidth: number, viewHeight: number): void {
    const app = this.#app;
    const map = this.#map;
    if (app === undefined || map === undefined) return;
    const scale = Math.min(viewWidth / (map.width * TILE_PX), viewHeight / (map.height * TILE_PX));
    app.stage.scale.set(scale > 0 ? scale : 1);
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
    this.#app?.destroy(true);
    this.#app = undefined;
  }
}
