# Monster Realm — example art (POC)

A small, **high-quality** starter art set in the locked direction:
**¾ oblique · 32 px/tile · "warm vibrant storybook" palette · 2D-HD-ready (neutrally lit).**

Everything here is generated **deterministically** by [`generate_art.py`](./generate_art.py)
(pure Python stdlib — no Pillow, no external image service), so the art is reproducible and
tweakable: change a palette ramp or a draw routine, re-run, done.

```bash
python3 art-src/generate_art.py      # run from the client/ dir
```

**See it lit, live:** [`demo/`](./demo/) is a runnable HD-2D scene — a walkable, normal-mapped
hero on a small tilemap under two moving lights. `cd client && python3 -m http.server 8080`,
then open <http://localhost:8080/art-src/demo/>. Details in [`demo/README.md`](./demo/README.md).

## What ships (served by Vite at `/assets/…`)

| File | Size | Contents |
|------|------|----------|
| `hero.png` + `hero.json` | 160×128, 20 frames | ¾ tamer/ranger — 4 facings × {idle, stepA, mid, stepB, jump} (albedo) |
| `hero-normal.png` + `hero-normal.json` | 160×128, 20 frames | matching **normal map**, identical atlas layout |
| `tileset-edge-of-town.png` + `.json` | 256×192, 47 tiles | grass route ↔ town: grass/tall-grass/flowers, grass↔dirt + grass↔water autotile sets, cobble/brick/window/door/roof, props (albedo) |
| `tileset-edge-of-town-normal.png` + `.json` | 256×192, 47 tiles | matching **normal map**, identical atlas layout |
| `monster-emberkit.png` + `.json` | 96×128, 12 frames | wild creature "Emberkit" — 4 facings × {idle, walk0, walk1} (albedo) |
| `monster-emberkit-normal.png` + `.json` | 96×128, 12 frames | matching **normal map**, identical atlas layout |
| `palette.png` | 82×210 | the shared master palette swatch (13 ramps) |
| `art-src/preview/*@6x.png` | — | 6× previews: `*@6x` albedo · `*-normal@6x` · `*-lit@6x` (NOT served) |

The JSON is the **PixiJS v8 spritesheet (hash) format** — `Assets.load()` resolves the PNG
relative to the JSON automatically. 2-space indented so a `biome check` stays clean. Each
`-normal.json` shares **byte-identical frame rects** with its albedo, so the two sheets register
pixel-for-pixel under a deferred light pass.

## Art direction (the decisions baked in)

- **Perspective ¾ oblique.** Objects show a front face + a little top (e.g. the 2-tile tree =
  `tree_canopy` over `tree_trunk`; window/door faces on the brick wall).
- **One hue-shifted master palette.** Ramps go dark→light with **shadows shifted cool/violet and
  highlights warm/yellow** (not a single hue darkened). The hero's **teal coat + rust scarf**
  deliberately *contrast* the green terrain so he stays readable on grass (the readability rule).
- **Neutrally lit albedo.** Gentle, symmetric form-shading only — **no baked directional shadows**
  — so every frame doubles as an albedo for a later HD-2D normal-map + lighting pass (additive,
  render-only; ADR-0004 / `characterView.ts` `AssetProvider` seam). The only baked light is a
  faint, low-alpha contact shadow under the hero/props, kept subtle so a future light pass wins.

## Hero sheet layout (`hero.json`)

Frame names: `hero_{down|up|right|left}_{idle|stepA|mid|stepB|jump}` (`left` = mirror of `right`).
Maps straight onto the renderer's `(action, facing)` seam:

- `Idle` → `*_idle` · `Jumping` → `*_jump`
- `Walking` → the `walk_{facing}` animation = `[stepA, idle, stepB, mid]` (contact, passing, contact, passing)

Animations in the JSON: `walk_down/up/right/left`, `idle_down/up/right/left`.

## Tileset layout (`tileset-edge-of-town.json`), 8 cols

- **Grass & decals:** `grass`, `grass_tuft`, `grass_pebbles`, `tall_grass` *(the encounter tile —
  deeper/bluer base + bladed silhouette so it reads distinct)*, `flowers_red`, `flowers_gold`,
  `bush`, `rock`
- **grass↔dirt path autotile (13):** `path_c`, `path_{n,s,e,w}`, `path_{ne,nw,se,sw}` (outer),
  `path_inner_{ne,nw,se,sw}`
- **grass↔water edge (10):** `water_c`, `water_c2` *(shimmer frame 2)*, `water_{n,s,e,w}`,
  `water_{ne,nw,se,sw}` — grass side gets a foam rim. Anim: `water_shimmer = [water_c, water_c2]`.
- **Town:** `cobble`, `cobble_var`, `wall_brick`, `wall_window`, `wall_door`,
  `roof_{l,c,r,peak}`
- **Props (transparent surround, layer over terrain):** `fence_h`, `fence_post`, `sign`,
  `tree_canopy`, `tree_trunk`, `stump`, `barrel`

The autotile names follow a **marching-squares / blob** subset (center + 4 edges + 4 outer +
4 inner corners). Pick the tile from a neighbour bitmask — the boundaries are jittered with
*local* tile coords so adjacent same-type tiles stay **seamless**.

## Using it in the POC (PixiJS v8)

```ts
import { Assets, Sprite, AnimatedSprite, Texture } from 'pixi.js';
import { TILE_PX } from './render/config';

// ── load both sheets ──────────────────────────────────────────────────────
const hero = await Assets.load('/assets/hero.json');
const tiles = await Assets.load('/assets/tileset-edge-of-town.json');

// ── a tile by name (all batch from ONE atlas → 1–2 draw calls) ────────────
function tile(name: string): Sprite {
  const s = new Sprite(tiles.textures[name]);
  return s; // place at (col*TILE_PX, row*TILE_PX)
}
const grass = tile('grass');
const tallGrass = tile('tall_grass'); // the wild-encounter tile

// shimmering water from the animation set
const water = new AnimatedSprite(tiles.animations.water_shimmer);
water.animationSpeed = 0.03; water.play();

// ── adapter onto the existing render/characterView.ts AssetProvider seam ──
// The seam returns ONE Texture per (action,facing); for Walking, drive the
// frame swap from the Ticker using the walk_* animation arrays.
import type { AssetProvider } from './render/characterView';
import type { WasmAction, WasmDirection } from './convert/convert';

const FACE: Record<WasmDirection, string> = {
  South: 'down', North: 'up', East: 'right', West: 'left',
};

class SpritesheetAssetProvider implements AssetProvider {
  constructor(private readonly sheet = hero) {}
  texture(action: WasmAction, facing: WasmDirection): Texture {
    const f = FACE[facing];
    if (action === 'Jumping') return this.sheet.textures[`hero_${f}_jump`];
    if (action === 'Idle') return this.sheet.textures[`hero_${f}_idle`];
    // Walking: representative frame; cycle this.sheet.animations[`walk_${f}`]
    // in the Ticker (≈8 fps) for the full gait.
    return this.sheet.animations[`walk_${f}`][0];
  }
}
```

> Note: the current `AssetProvider` contract is single-texture. To animate the walk gait you
> either (a) cycle `animations.walk_${f}` on a frame index in the `CharacterView` Ticker step, or
> (b) widen the seam to return a frame set. Both are render-only; neither touches game logic.

## Regenerating / extending

- Tune the ramps at the top of `generate_art.py` (`G`, `D`, `WAT`, `CT`, `SC`, …) — one edit
  recolours everything consistently.
- Add a tile: write a `tile_*()` returning a 32×32 `Img`, `add("name", …)` it in `build_tileset()`
  (8-wide grid; JSON frame coords are derived from catalogue order — no manual bookkeeping).
- Add a hero pose: extend the `cols`/`facings` loop in `build_hero()`.
- Add a tile's normal profile in `prof_for()` inside `build_tileset()` (defaults to `terrain`).

## Normal maps & HD-2D lighting

The `*-normal.*` sheets are **generated from a height field, not faked from luminance**
([`generate_art.py`](./generate_art.py) §"Normal maps"):

- **Sprites & props** (hero, tree, bush, rock, barrel, fence, sign) get an **alpha-distance
  bevel** that rounds the silhouette into a dome — so they catch real rim light and read as
  volumes — plus a little surface relief from the albedo's symmetric form-shading.
- **Structural tiles** (cobble, brick, window/door, roof ribs, water ripples, dirt/grass) take
  their relief from that same form-shading; opaque terrain samples the gradient with **wrap** so
  the normals stay seamless across tiles. Transparent pixels are left fully transparent so the
  light pass skips them.

Encoding: tangent-space, flat = `(128,128,255)`. Green is **Y-down (screen space)** — matching the
common PixiJS shader `normalize(tex.rgb*2-1)` with a screen-space light vector. If your light pass
looks vertically inverted, set `FLIP_Y = True` at the top of the generator (OpenGL /
SpriteIlluminator "Y up"). Verified end-to-end against the `*-lit@6x.png` previews (a 2-light
software render of albedo×normal).

### Deferred light pass in PixiJS v8 (sketch)

```ts
import { Assets, Sprite, Container, RenderTexture, Mesh, Geometry, Shader } from 'pixi.js';

const [heroA, heroN] = await Promise.all([
  Assets.load('/assets/hero.json'),         // albedo
  Assets.load('/assets/hero-normal.json'),  // normal (same frame names!)
]);
const tilesA = await Assets.load('/assets/tileset-edge-of-town.json');
const tilesN = await Assets.load('/assets/tileset-edge-of-town-normal.json');

// 1. Render the scene twice into two RenderTextures with identical transforms:
//    albedoRT  <- sprites using *A.textures[name]
//    normalRT  <- the SAME sprites using *N.textures[name]
//    (the byte-identical frame rects guarantee pixel registration.)
// 2. A full-screen Mesh samples both + light uniforms (GLSL ES 3.0):
//      vec3 N = normalize(texture(uNormal, vUV).rgb * 2.0 - 1.0);
//      vec2 d = uLightPos - gl_FragCoord.xy;             // screen space, y-down
//      vec3 L = normalize(vec3(d, uLightZ));
//      float diff = max(dot(N, L), 0.0) / (1.0 + dot(d,d)*uFalloff);
//      fragColor = texture(uAlbedo, vUV) * (uAmbient + uLightColor * diff);
// 3. Add bloom / tilt-shift Filters on the result for the full HD-2D stack.
```

This is exactly the additive, render-only upgrade described in the `pixijs-2d-rendering` and
`top-down-2d-art` research notes — **no game-logic change**. For a batteries-included path,
`pixijs-userland/lights` implements the same albedo+normal deferred approach (confirm v8
compatibility first). Budget one extra RenderTexture pass per light layer.
