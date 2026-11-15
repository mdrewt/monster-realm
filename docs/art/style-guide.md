# Art style guide

The one page every placeholder and every piece of final art follows. Code owns the
facts it can (the terrain grammar, the registry rules, the world scale); this page
cites them and is never parsed.

## Base (#587 D5, answered 2026-10-24)

- **Perspective:** ¾ oblique. Objects show a front face and a little top.
- **Tile:** 32 px (`TILE_PX` in `client/src/render/config.ts`).
- **Character canvas:** 32×32 for hero and monster frames.
- **Look:** "warm vibrant storybook". 2D-HD is a lighting and post-processing
  stack over this base (`wap-9`), not a new asset format.
- **Fidelity model A:** a strict integer pixel grid. The world renders at an
  integer device scale derived from the viewport, not at a fixed native
  resolution. See DECISIONS.md "Integer pixel scaling" and "One viewport number
  scales the world by integers and the chrome continuously". Every atlas, chunk
  and LUT texture samples `nearest`.
- **Sources:** extend the committed stdlib generators (`client/art-src/`) by
  default. A CC0 or CC-BY pack (Kenney-style kitbash) is allowed when it saves
  real work, within the provenance rules below.

## Light

- **Direction:** from the top-left. The `wap-9` lightmap and the normal maps
  assume it.
- **Albedo is neutrally lit:** symmetric form shading only.
- **No baked cast shadows.** Only a small, low-alpha contact shadow (AO) under
  characters and props, so a later light pass wins.

## Palette

The master ramps live at the top of `client/art-src/generate_art.py`: grass `G`,
tall grass `TG`, dirt and path `D`, stone `S`, water `WAT`, wood `WD`, roof and
brick `RF`, foliage `F`, and the character ramps. That table is the source.
`palette.png` is the swatch of the ramps listed in `PALETTE_ROWS`. Ramps run dark to light, with shadows shifted
cool and violet and highlights shifted warm and yellow. Never darken a single
hue. Characters contrast the terrain: the teal-and-rust hero reads on green.

**One value band per terrain class.** Each band is the mean relative luminance Y
(Rec. 709, linearised sRGB) of the opaque pixels of a class's base frames, the three
variants in the terrain kit (`terrain-kit.png`, `wap-2`). Every readability pair below is
at least 0.06 apart from edge to edge. The measured column is what
`client/src/render/art/terrainKit.test.ts` printed for the shipped kit. The test asserts
the 0.06 pair gap on the atlas itself, never against this table. Move a band only if
every pair keeps its gap.

| Class | Value band (mean Y) | Measured (wap-2) |
|---|---|---|
| tree | 0.04–0.06 | 0.051 |
| wall | 0.05–0.07 | 0.063 |
| tall grass | 0.08–0.10 | 0.090 |
| deep water | 0.09–0.11 | 0.102 |
| ground | 0.28–0.30 | 0.290 |
| bush | 0.37–0.40 | 0.385 |
| path | 0.40–0.42 | 0.411 |
| shallow water | 0.40–0.42 | 0.411 |
| rock | 0.47–0.49 | 0.480 |
| sand | 0.57–0.60 | 0.583 |

The tightest pairs are ground–bush (0.096), sand–rock (0.103), ground–path and
ground–shallow water (0.121 each). Box-downsampled to 16×16, a 4×4-tile patch of
shallow water still reads 0.13 lighter than ground (0.40 vs 0.27) and bluer than green.

**Readability pairs** (adjacent classes that must separate by value): ground–tall
grass, ground–path, ground–sand, path–sand, sand–shallow water, shallow–deep water,
ground–shallow water, tall grass–shallow water, ground–rock, ground–tree,
ground–bush, tall grass–bush, ground–wall, path–wall, sand–rock.

Value alone is never the only cue. Water also reads by its wave texture, motion and
shore band. Landmarks and warp markers read by shape. Character actions read by
pose.

## Outlines

- **Characters, monsters and props:** a 1 px selective outline in the
  generators' `INK` (warm violet-black) or the sprite's own darkest ramp step,
  softened toward the local colour on lit edges. Never pure black.
- **Terrain tiles:** no outline. Edges read by value and by the autotile
  transition.

## Frame budgets

| Animation | Frames |
|---|---|
| water | 4 |
| warp pulse | 2–4 |
| hero walk | 2 steps + mid (`stepA, idle, stepB, mid`) |
| monster | idle + 2 walk per facing |

Every animation holds a static frame while reduced motion is set.

## Post stack

The world layer (terrain, decor, actors; never the DOM UI) runs four passes in
this order: an ambient lightmap with a vignette falloff, AdvancedBloom on the
brightest highlights, Godray, then a ColorMap LUT grade. Each pass can be turned
off on its own, and an off pass is not run at all. Each time-of-day keyframe is a
LUT from `client/art-src/generate_luts.py` plus an ambient light colour: `day`
(a light warm lift on the identity), `dusk` (warm, less blue) and `night` (cool,
dark, desaturated). The renderer starts with the stack off at `day`.

**Frame-time budget per pass**, measured by the look-dev scene
(`client/e2e/lookdev.spec.ts`, WAP9.6): mean of 20 frames, each one `render()`
followed by a one-pixel `readPixels` sync. 1280×720 at DPR 1, headless Chromium
with software GL (SwiftShader), on a 16-core Ryzen 9 9950X under WSL2. A hardware
GPU is far faster. These numbers are a record, not a gate.

| Stack | ms / frame |
|---|---|
| none | 2.0 |
| lightmap alone | 4.0 |
| bloom alone | 14.2 |
| godray alone | 19.9 |
| LUT alone | 3.9 |
| all four | 35.1 |

## Low-end frame times

Frame intervals of the live client, read against the client frame-rate objective:
`mr:client_fps_p50` at least 55 fps (`ops/observability/rules/recording.rules.yml`), the
five-minute median over all clients of each client's one-second frame-rate windows. The
same objective read per frame is a median interval of at most 18.2 ms; every row gives its
median, but on a 60 Hz tick that reading is necessary, not sufficient (a row with 45%
two-tick frames keeps a 16.7 ms median), so rows are judged on fps. These numbers are a
record, not a gate.

**What ran.** The production client and the release module, served by `just playtest-up`
with `STDB_SERVER=http://127.0.0.1:<port>`, `VITE_STDB_URI=ws://127.0.0.1:<port>` and a
scratch `MR_PLAYTEST_DB`, against `spacetime start --in-memory --data-dir <tmp>
--listen-addr 127.0.0.1:<port>`. One player joins zone 0 (28×20 tiles) at tile (1, 1),
with one NPC in view, the HUD (the hint bar) up and the post stack off, in a 1280×720
viewport at DPR 1. The stack-on rows use the Vite dev server (`npm run dev` with the same
variables and `VITE_STDB_DB`), the only build with the switch (`__game().setPostStack`).
Host: the 16-core Ryzen 9 9950X under WSL2 (Ubuntu 24.04, Mesa 25.2.8). Browser:
Playwright 1.61.1's Chromium 149, headless (`channel: 'chromium'`).

**Renderers.** With the launch flags below, Chromium reaches hardware GL on this host, and
the host exposes an integrated GPU: the Ryzen's own Radeon, beside a GeForce RTX 5080.
Headless Chromium's default is SwiftShader. Rows name each renderer by its WebGL renderer
string (`UNMASKED_RENDERER_WEBGL`, read in the page):

| Row name | Renderer string | Launch |
|---|---|---|
| RTX 5080 | `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 5080), OpenGL ES 3.1)` | args `--use-gl=angle --use-angle=gl-egl --ignore-gpu-blocklist --enable-gpu`, env `GALLIUM_DRIVER=d3d12 MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA` |
| Radeon (integrated) | `ANGLE (Microsoft Corporation, D3D12 (AMD Radeon(TM) Graphics), OpenGL ES 3.1)` | the same args, env `GALLIUM_DRIVER=d3d12 MESA_D3D12_DEFAULT_ADAPTER_NAME=AMD` |
| SwiftShader | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)` | no args |
| llvmpipe | `ANGLE (Mesa, llvmpipe (LLVM 20.1.2 256 bits), OpenGL ES 3.2)` | the same args, env `LIBGL_ALWAYS_SOFTWARE=1` |

Both GPUs are reached through WSL2's D3D12 layer (Mesa's `d3d12` driver under ANGLE's
OpenGL backend). The Radeon rows are an integrated GPU behind a desktop CPU, not a low-end
laptop. `chrome://gpu` reports WebGL as "Software only" for SwiftShader and as "Hardware
accelerated" for the other three, llvmpipe included, and a WebGL context requested with
`failIfMajorPerformanceCaveat` is created on all four.

**Method.** A Playwright page loads the client, waits for the hint bar and 3 s more, sets
`Emulation.setCPUThrottlingRate` over CDP, lets 120 frames pass, then records 600
consecutive `requestAnimationFrame` timestamp deltas from a second callback loop it adds.
Each row pools that sample over separate browser launches, three (1,800 intervals) or two
(1,200) as each table says, interleaved across the configurations; the stack-on launches
above 1280×720 ran back to back after the rest. Steady state only: no load, battle or menu
frames.

- **Median and p95** are nearest-rank.
- **Shares.** Headless Chromium ticks frames at 60 Hz, so every interval is a whole number
  of 16.67 ms ticks (within 0.17 ms here) on a 0.1 ms grain. The share columns count
  ticks: "> 16.7 ms" is an interval of two ticks or more, "> 33.3 ms" one of three or
  more. Compared literally, 4–6% of one-tick intervals read 16.8 ms and 31–38% of two-tick
  intervals read 33.4 ms.
- **fps** is the median of the one-second windows the client forms
  (`client/src/observability/frameWindow.ts`), replayed over the same intervals. The
  recording rule estimates that median from the client's histogram buckets (`50, 55, 60,
  90`, …); recomputed that way a row moves by up to 6.5 fps and no verdict changes.
- **CPU throttling slows the page's main thread only.** SwiftShader and llvmpipe rasterise
  in the GPU process at the host's full speed. The "2 cores" rows run the Playwright driver
  under `taskset -c 0,2` (two different cores), and every browser process inherits the pin.
- **The sample registers both kinds of load.** On the RTX 5080, a 20 ms busy loop in each
  frame turns 22% of intervals into two ticks. On the Radeon, a full-canvas fragment shader
  costing 20.8 ms a frame gives a 20.2 ms mean interval, and one costing 68.0 ms gives
  68.8 ms.
- **Synced frame** is the per-pass table's sync applied to the live game: a one-pixel
  `readPixels` straight after the game's own frame, the median of 300 frames.

**Post stack off, 1280×720 at DPR 1** (1,800 intervals a row):

| Renderer | CPU | Median ms | p95 ms | > 16.7 ms | > 33.3 ms | fps | Objective |
|---|---|---|---|---|---|---|---|
| RTX 5080 | 1× | 16.7 | 16.8 | 0% | 0% | 60.0 | meets |
| RTX 5080 | 4× | 16.7 | 16.7 | 0% | 0% | 60.0 | meets |
| RTX 5080 | 6× | 16.7 | 16.7 | 0% | 0% | 60.0 | meets |
| Radeon (integrated) | 1× | 16.7 | 16.7 | 0% | 0% | 60.0 | meets |
| Radeon (integrated) | 4× | 16.7 | 16.7 | 0% | 0% | 60.0 | meets |
| Radeon (integrated) | 6× | 16.7 | 16.8 | 0% | 0% | 60.0 | meets |
| SwiftShader | 1× | 16.7 | 16.8 | 0% | 0% | 60.0 | meets |
| SwiftShader | 4× | 16.7 | 16.8 | 0% | 0% | 60.0 | meets |
| SwiftShader | 6× | 16.7 | 16.7 | 0% | 0% | 60.0 | meets |
| llvmpipe | 1× | 16.7 | 16.7 | 0% | 0% | 60.0 | meets |
| llvmpipe | 4× | 16.7 | 16.7 | 0% | 0% | 60.0 | meets |

**Post stack off, larger canvases and two cores**, CPU 1× (1,200 intervals a row). The
canvas is in device pixels: 2560×1440 is the 1280×720 viewport at DPR 2, and 3840×2160 the
1920×1080 viewport at DPR 2.

| Renderer | Canvas | Cores | Median ms | p95 ms | > 16.7 ms | > 33.3 ms | fps | Objective |
|---|---|---|---|---|---|---|---|---|
| SwiftShader | 1920×1080 | all | 16.7 | 16.8 | 0% | 0% | 60.0 | meets |
| SwiftShader | 2560×1440 | all | 16.7 | 33.3 | 7.3% | 0% | 56.0 | meets |
| SwiftShader | 3840×2160 | all | 33.4 | 50.0 | 100% | 30.5% | 26.0 | misses |
| SwiftShader | 1280×720 | 2 | 16.7 | 16.8 | 0% | 0% | 60.0 | meets |
| SwiftShader | 1920×1080 | 2 | 16.7 | 33.3 | 6.6% | 0% | 56.1 | meets |
| SwiftShader | 3840×2160 | 2 | 66.8 | 83.4 | 100% | 100% | 13.5 | misses |
| llvmpipe | 3840×2160 | all | 16.7 | 16.8 | 0% | 0% | 60.0 | meets |
| Radeon (integrated) | 3840×2160 | all | 16.7 | 16.8 | 0% | 0% | 60.0 | meets |
| RTX 5080 | 3840×2160 | all | 16.7 | 16.7 | 0% | 0% | 60.0 | meets |

The two 56 fps rows are close to the line: their launches read 56.0 and 56.0 (2560×1440)
and 55.1 and 57.1 (two cores, 1920×1080).

**Post stack on** (all four passes, Vite dev server), CPU 1×, all cores (1,800 intervals a
row at 1280×720, 1,200 at the larger canvases):

| Renderer | Canvas | Median ms | p95 ms | > 16.7 ms | > 33.3 ms | fps | Objective |
|---|---|---|---|---|---|---|---|
| SwiftShader | 1280×720 | 50.0 | 50.1 | 100% | 85.7% | 21.0 | misses |
| llvmpipe | 1280×720 | 16.7 | 33.4 | 45.1% | 0% | 41.3 | misses |
| llvmpipe | 1920×1080 | 33.3 | 50.0 | 99.7% | 6.6% | 29.0 | misses |
| Radeon (integrated) | 1280×720 | 16.7 | 16.7 | 0% | 0% | 60.0 | meets |
| Radeon (integrated) | 1920×1080 | 33.3 | 33.4 | 74.8% | 0% | 34.4 | misses |
| Radeon (integrated) | 3840×2160 | 100.0 | 100.1 | 99.8% | 99.8% | 10.3 | misses |
| RTX 5080 | 1280×720 | 16.7 | 16.7 | 0% | 0% | 60.0 | meets |
| RTX 5080 | 3840×2160 | 16.7 | 16.7 | 0% | 0% | 60.0 | meets |

**Reading.**

- **Stack off, every renderer meets the objective at 1280×720** at 1×, 4× and 6×, and
  SwiftShader does on two cores at 1× and 4×. A hero walking a two-tile shuttle (Up then
  Down, each held 450 ms) changes nothing: at most 0.2% of frames take more than one tick,
  at 6× on either GPU, at 4× on SwiftShader, and at 1× on SwiftShader's two cores.
- **The 60 Hz tick hides the margin**, which the synced frame shows. Stack off at 1280×720
  it is 2.3 ms on SwiftShader (the look-dev scene's 2.0 ms above, in live zone 0) and
  3.5 ms on llvmpipe. On the GPUs it is 4.3 ms (RTX 5080) and 6.4 ms (Radeon), an upper
  bound: a second readback straight after the first takes 1.6 ms and 1.7 ms. The frame
  loop's script is 0.25 ms a frame in the production build; in a profile of the dev
  server's build it is 0.28 ms, about half of it Pixi's scene render.
- **Raising the throttle further** costs frames only once the main thread is full: 48.2
  and 51.2 fps at 40× on the RTX 5080 and the Radeon (60.0 at 20×), and 38.0 fps at 20× on
  SwiftShader (60.0 at 10×). Most of that time is the browser's own work outside the
  client's script (29 ms against 7.5 ms of frame-loop script on SwiftShader at 20×, in a
  dev-server profile). These factors lie beyond the 6× this record targets and model no
  device, so they carry no follow-up.

**Rows that miss**, with the largest per-frame cost and the follow-up row of each:

- **SwiftShader at 3840×2160, stack off** (26.0 fps; 13.5 fps on two cores, whose launches
  ran at 66.7 and 83.2 ms medians). The cost is software rasterisation and compositing,
  which grow with device pixels: the synced frame is 2.3 ms at 1280×720 and 15.1 ms at
  3840×2160, and the browser then composites 8.3 M pixels in software. The renderer's
  backing store follows the device pixel ratio. Follow-up: `R-th-6-SWRASTER-PIXELS`.
- **Stack on, SwiftShader and llvmpipe** (21.0 and 41.3 fps at 1280×720, and 29.0 fps on
  llvmpipe at 1920×1080). The cost is the four passes: the synced frame is 47.0 ms against
  2.3 ms on SwiftShader and 21.7 ms against 3.5 ms on llvmpipe, with godray and bloom the
  largest (per-pass table above). DECISIONS.md "The world post stack is `pixi-filters`…"
  keeps the stack off on a software rasteriser. Follow-up: `R-th-6-POSTSTACK-GUARD`.
- **Stack on, the Radeon at 1920×1080 and above** (34.4 fps, 10.3 fps at 3840×2160). The
  cost is the same four passes on a small GPU: the synced frame is 11.9 ms at 1280×720 and
  97.5 ms at 3840×2160, where the RTX 5080 takes 5.7 ms. The software-rasteriser rule does
  not cover this, and a GPU driven without the WSL2 layer may differ. Follow-up:
  `R-th-6-POSTSTACK-GUARD`.

Not measured: a displayed browser, a GPU driven without the WSL2 layer, a laptop
integrated GPU, a browser other than Chromium, more than one player in view, and the
battle, tactics and menu screens.

## Names and atlas keys

- **Registry key:** `<pack>/<id>`, where `<pack>` is one of `characters`,
  `monsters`, `terrain`, `landmarks`, `battle` or `grade` and `<id>` matches
  `[a-z][a-z0-9_]*`. A normal map is `<id>_normal`. Monster ids are the lower-cased
  species name. Flameling is `monsters/flameling`, even though its file is
  `monster-emberkit.png`.
- **Frame names inside an atlas:** `<class>_<variant>` (for example `water_c2`).
- **Keys are stable ids.** Never rename one. Final art is a file swap behind the
  same key.
- **Frames sit on a 16 px grid.** A `sprite`, `tile` or `normal` frame's width and
  height are whole multiples of 16 px. Atlas `meta.scale` is always 1. `palette`
  and `lut` images have no frames.

## Provenance

Every PNG served from `client/public/assets/` has exactly one row in the art
registry (`client/src/render/art/registry.ts`, one pack file per asset family under
`client/src/render/art/packs/`). A new asset and its row land in the same change.

**Row fields:**

- `key`, `file`, `kind` (`sprite`, `tile`, `normal`, `palette` or `lut`)
- `sheet`, `frame` and `scale`
- `source`: the generator path. A generator later deleted from the tree is written
  `<path>.py@<commit>`. For a third-party pack, it is the pack's URL.
- `license` and `attribution`
- `provenance`: `placeholder-procedural`, `placeholder-licensed` or `final`

**License ladder** (most to least preferred): CC0 > CC-BY > share-alike > EULA >
AI-generated. This milestone accepts only `project-original` (this repo's own
generators), `CC0-1.0`, and `CC-BY-4.0` or `CC-BY-3.0` with an attribution string.
Share-alike and EULA licenses wait for counsel sign-off.

**Image-model output never ships.** The `ai-placeholder` tag exists only to be
forbidden. AI output is for ideation only. The row type makes these rules
unrepresentable where it can, and `validateArtRegistry` rejects the rest:
duplicate keys or files, off-grid frames, a scale other than 1, a malformed key,
and an empty attribution. See DECISIONS.md "Every served asset carries a
provenance row; image-model output never ships".

## Terrain classes

**Code owns this table.** `TileKind` in `game-core/src/types.rs` is the single
definition of glyph, Tiled GID, walkability and encounter flag. Today it holds
`Floor`, `Wall` and `TallGrass`. `wap-1` appends the seven new variants at the
tail, in table order. This copy is for review only.

| Class | `TileKind` | Glyph | Tiled GID | Walkable | Encounter | Notes |
|---|---|---|---|---|---|---|
| ground (short grass) | `Floor` | `.` | 1 | yes | no | the existing floor glyph, drawn as outdoor ground |
| tall grass | `TallGrass` | `~` | 2 | yes | yes | the only encounter class |
| path | `Path` | `=` | 3 | yes | no | |
| sand | `Sand` | `:` | 4 | yes | no | |
| shallow water | `ShallowWater` | `w` | 5 | no | no | animated; shore band where it meets land |
| deep water | `DeepWater` | `W` | 6 | no | no | darker than shallow; animated; borders only water |
| rock | `Rock` | `^` | 7 | no | no | |
| tree | `Tree` | `T` | 8 | no | no | |
| bush | `Bush` | `*` | 9 | no | no | |
| wall | `Wall` | `#` | 0 | no | no | the existing wall glyph |
