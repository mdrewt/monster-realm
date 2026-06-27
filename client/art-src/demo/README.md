# HD-2D lighting demo

A self-contained, runnable demo that lights the generated **albedo + normal** sheets in real
time: a small tilemap, a walkable normal-mapped hero, and a wild **Emberkit** creature that
wanders the tall-grass corner — all under two moving lights (a torch that follows the hero +
a light that follows your mouse). It does **not** touch the game client — it's just a static
HTML page that loads `../../public/assets/*` and runs a PixiJS v8 deferred light pass (two
RenderTextures → a custom light-shader filter). Both characters and every tile are lit by the
same normal-mapped pass.

## Run it (simplest — static server + CDN PixiJS)

```bash
cd projects/monster-realm/client
python3 -m http.server 8080
# then open:  http://localhost:8080/art-src/demo/
```

That's it. The page pulls `pixi.js@8.19.0` from a CDN (esm.sh) via an import map and fetches the
assets at `/public/assets/…` (served because the server is rooted at `client/`). Needs network
for the one CDN import.

**Controls**

| Key | Action |
|-----|--------|
| `W` `A` `S` `D` / arrows | walk the hero (animates + faces direction) |
| mouse over the scene | the cool light follows the cursor |
| `Space` | toggle day / night ambient |
| `T` | torch-follows-hero on/off |
| `N` | flip the normal-map **Y sign** — press once if the relief looks *inverted* |
| `V` | flip normal **sampling V** — press once if lighting lands on the wrong vertical half |

The orientation is **verified** and baked in: `normalY = 1`, `flipV = 1`. (`flipV` accounts for the
vertical flip when sampling a PixiJS RenderTexture raw inside a filter; `normalY` matches the
normal map's screen-space green channel to the light vector.) The `N` / `V` keys remain so the
demo still adapts if you swap in differently-encoded maps or a different render path.

## Run it offline (no CDN)

Download the single-file PixiJS ESM bundle next to the demo and repoint the import map:

```bash
cd projects/monster-realm/client/art-src/demo
curl -L https://cdn.jsdelivr.net/npm/pixi.js@8.19.0/dist/pixi.min.mjs -o pixi.min.mjs
# then edit index.html's import map:  "pixi.js": "./pixi.min.mjs"
```

…and serve as above. (Alternatively, if you run the client's own Vite dev server, delete the
import map so Vite resolves `pixi.js` from `node_modules`, and change `ASSETS` in `index.html`
to `'/assets/'` since Vite serves `public/` at the web root.)

## What it demonstrates

This is the additive, render-only HD-2D upgrade from the research notes: game logic is untouched;
the scene is drawn twice (albedo + normal) into two `RenderTexture`s, then a fragment shader
samples both plus the light uniforms to produce per-pixel lit output. Add bloom / tilt-shift
`Filter`s on the result for the full HD-2D stack. See [`../README.md`](../README.md) for the
encoding details and the production wiring sketch.
