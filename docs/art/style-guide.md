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
