# 0160 — Responsive viewport: DPR-correct backing store, device-integer scaling, per-axis map centering

**Status:** Accepted
**Date:** 2026-07-27
**Slice:** uxd1 (M-postgate-ux-design — responsive viewport scaling)
**Supersedes:** —
**Amends:** 0067
**Subsystems:** client-ui
**Decision:** The render edge gains a pure viewport core: the Pixi app runs at resolution=devicePixelRatio with autoDensity, scale is an INTEGER deviceScale applied as a fractional stageScale=deviceScale/dpr, and FollowCamera centers per-axis when the map is smaller than the effective viewport.

## Context

Drew's 2026-07-25 closed playtest reported three symptoms from one root cause: the canvas resized but
the world did not, retina displays looked blurry, and small zones sat stranded in the top-left corner.

Three facts about the existing code shaped the design:

1. **The retina blur is a Pixi v8 default.** `world.ts:57-62` called `app.init({width, height,
   background, antialias})` with no `resolution` and no `autoDensity`. Pixi v8 defaults those to `1`
   and `false`, so the backing store was `cssW × cssH` device pixels on a dpr-2 display — a 2× upscale
   of a half-resolution image.
2. **The camera pinned small maps top-left by construction.** `camera.ts` clamped both axes to
   `[0, max(0, mapPx − view)]`. When `mapPx < view` the max is `0`, so every offset clamped to `0` —
   the map hugged the origin and the rest of the screen was `FLOOR_COLOR`.
3. **The whole game-core/netcode pipeline is fractional-tile and `TILE_PX` is applied only at the
   render leaf** (`characterView.ts:48-49`). So `stage.scale` / `stage.position` / the Application
   `resolution` touch nothing stored, sent, predicted, or interpolated. Server authority (ADR-0015/0081)
   and smoothness (ADR-0013) are untouched **by construction**, not by care.

A fourth fact drove the module boundary: `client/vite.config.ts` coverage-**excludes** `world.ts`,
`main.ts`, `characterView.ts` and `placeholderAssets.ts` as hand-wired DOM shells, and the slice's
declared `touches:` set contains no `world.test.ts` and no `evals/**`. **Any logic placed in those
files is untested by construction.** That is the reason a new pure module exists at all.

## Decision

### D1 — DPR-correct backing store

`app.init()` receives `resolution = devicePixelRatio` and `autoDensity = true`; `resize()` re-applies
both via Pixi v8's three-argument `renderer.resize(cssW, cssH, resolution)`. `autoDensity` is what keeps
the canvas *CSS box* at `cssW × cssH` while the backing store grows to `cssW·dpr × cssH·dpr`; without it
the canvas would lay out at `cssW·dpr` CSS pixels and the world would render twice too large.

### D2 — Device-integer crisp, fractional-CSS fill

`deviceScale = max(1, round(idealCssScale × dpr))` is an **integer**; `stageScale = deviceScale / dpr`
is fractional. One source texel therefore maps to a whole number of device pixels at any dpr, while the
fractional CSS scale still fills the viewport (no letterbox). This is free today with procedural
placeholders and is what makes authored bitmap art crisp when it lands.

### D3 — Zoom is a BOUND, not a knob: MAX strict, MIN best-effort

`viewportScale` targets `TARGET_VISIBLE_TILES` (11) on the shorter axis and clamps the result so the
visible-tile count stays in `[MIN_VISIBLE_TILES, MAX_VISIBLE_TILES]` = `[7, 16]`.

The two bounds are **not** symmetric, and the spec's EARS text cannot be satisfied literally. MAX is
enforced strictly; MIN is best-effort, because `deviceScale >= 1` is a hard floor. The admissible
window can only be empty when the shorter axis is under `MIN_VISIBLE_TILES × TILE_PX = 224` device
pixels, where satisfying MIN would require a sub-1 device scale — which is exactly the blur bug D1
fixes. So the floor wins and a very small window simply shows fewer than 7 tiles.

**Honest note on the clamps.** At the shipped constants (11/7/16) the MIN clamp **never binds** for any
input — deleting it would produce identical output — and the MAX clamp binds only for a shorter axis of
513–527 device pixels. Both lines stay because these three constants are explicitly Drew-tunable feel
numbers, and a retune must not silently exceed a bound. But the MIN clamp ships as a *future-constant
guard*, not as a discriminating tooth, and the test suite says so rather than claiming a kill it does
not have. The MAX clamp gets a deterministic tooth inside its narrow binding band
(`viewportScale(1024,512,1).deviceScale === 1` vs `(1024,513,1) === 2`), because a property-based test
alone hits a 16-pixel-wide band on roughly one seed in nine.

### D4 — Per-axis centering in `FollowCamera`

`offsetFor` branches **per axis**: scroll-clamp when `mapPx >= viewW` (unchanged ADR-0067 behavior),
center at `-(viewW − mapPx)/2` when smaller. The comparison is `>=`, not `>`, so the exactly-fits case
takes the scroll branch and yields `+0` rather than `-0` (vitest routes numeric comparison through
`Object.is`, so `-0` would fail the pre-existing green assertions at `camera.test.ts:98-105`).

### D5 — The unit contract (the highest-risk detail in the slice)

After this change `offsetFor`'s `viewW`/`viewH` parameters are the **EFFECTIVE viewport in SOURCE
pixels** (`cssPx / stageScale`), not CSS pixels. The six-argument signature is unchanged and the camera
stays scale-agnostic — `stageScale` is knowledge owned by `viewport.ts` alone.

The mitigation for the resulting mixed-unit hazard is mechanical, not documentary: `WorldRenderer`'s
`#viewW`/`#viewH` fields are **deleted** and replaced by a single non-optional `#vs: ViewportScale`, so
the CSS-pixel value is never in scope at the `offsetFor` call site. `#vs` is initialized to
`viewportScale(1,1,1)` rather than left `undefined`, because an `undefined`-gated camera would silently
render with no transform at all on any frame preceding the first resize.

### D6 — `stage.position` is computed by `worldToScreen`, not inlined

`world.ts` sets `stage.position` to `worldToScreen({x:0,y:0}, offset, stageScale)` — where the world
origin lands under the camera. Inlining `(-cx*stageScale, -cy*stageScale)` would have been equivalent
arithmetic in a coverage-excluded file, which means the composition test would have verified a
*parallel* implementation: a sign error or a missing `* stageScale` in `world.ts` would have shipped
green. Routing through the pure function gives one formula and pulls the shipped transform under test.

### D7 — Restating two EARS criteria (recorded so the spec text is never cited as a regression)

**A7 (own player at the viewport center) contradicts A5 (center small maps) and A6 (clamp at map
edges).** It is already false on `master`: A6's clamp is the deliberate ADR-0067 behavior with green
tests at `camera.test.ts:72-90`. A7 is therefore scoped to the **unclamped axis**, where the identity
is algebraically exact (`off = (t+0.5)·TILE_PX − effW/2` ⟹ `screen = cssW/2`), and a companion **A7b**
covers the other two branches with the exact edge identity (`offset 0 ⟹ worldToScreen(0).x === 0`;
`offset = mapPx − effW ⟹ worldToScreen(mapPx).x === cssW`) plus map-center framing on a centered axis.
This is a narrowing of the precondition, not a weakening of the assertion: the restated form still
misses by `cssW/2·(stageScale−1)` — hundreds of pixels — under the mixed-unit bug it exists to catch.

**A3 (clamp to `[MIN,MAX]`) contradicts A4 (`deviceScale = max(1, round(idealCssScale·dpr))`)** in the
513–527 device-pixel band and below 224 device pixels. A3 wins; A4's formula describes the
pre-clamp target.

### D8 — Degenerate input is normalized, not rejected

`viewportScale`/`appInitOptions` normalize `dpr` to `[0.25, 8]` and CSS dimensions to `(0, 1e6]`,
falling back to `1` outside those bands. Two reasons for normalize-not-throw: this code runs from a
`resize` handler adjacent to the frame loop, so a throw on a browser-supplied `devicePixelRatio` stops
rendering; and this is not a trust boundary (the project `AGENTS.md` declares no reject-not-clamp
inversion, so the default applies). The bands are bounded rather than merely finite-and-positive
because `Number.isFinite` alone admits `Number.MAX_VALUE`, and `shorterCss * dpr` then overflows to
`Infinity`, making the documented `deviceScale` integer postcondition false. Bounding makes every
declared postcondition true **by parsing**.

### D9 — `nearest` scaleMode with texture `resolution` left at the renderer default

Generated placeholder textures use `scaleMode: 'nearest'` (spec EARS A10) and leave `resolution`
unset, so it defaults to `renderer.resolution` (= dpr).

**The measured consequence, stated plainly because the obvious reasoning is wrong:** the residual
nearest-magnification is `deviceScale / textureResolution = deviceScale / dpr = stageScale`, which is
**2–6× on desktop** (1920×1080 → 3.00×; 1366×768 → 2.00×; 2560×1440 → 4.00×; 3840×2160 → 6.00×;
390×844 at dpr 3 → 1.00×). The 22×22-texel placeholder therefore renders with 3×3-device-pixel blocks
on its rounded-rect corners at 1080p, and `antialias: false` means the source raster is aliased too.
Spec A10's "no visible degradation at scale 1" escape clause is satisfied only vacuously, since
`stageScale` is essentially never 1 after this slice. This is accepted as the intended chunky
placeholder look. Pinning `resolution: deviceScale` would give exact texel mapping but would require
regenerating the entire texture cache on every resize — a named deferral for when authored art lands.

### D10 — Accepted: the integer-`deviceScale` sawtooth

Because `deviceScale` steps, a one-CSS-pixel resize can jump the world. At dpr 1, `cssH 512 → 513`
flips `deviceScale 1 → 2` and **doubles every sprite** (16.000 → 8.016 visible tiles); `879 → 880`
grows everything 50%. This is inherent to "device-integer crisp" and is accepted. It is **not** an
oscillation: `viewportScale` is pure, and `window.innerWidth/innerHeight` are unaffected by the canvas
the handler sizes, so there is no resize→layout→resize feedback loop. A hysteresis band would require
state in a pure function and is deferred.

### D11 — `main.ts` is not edited

`installResizeHandler`'s `ResizeWindow` gains a `readonly devicePixelRatio: number`, which the real
`window` structurally satisfies (`Window.devicePixelRatio` is a live getter; `readonly` is not checked
in property assignability). `installResizeHandler(renderer, window)` at `main.ts:1753` typechecks and
behaves correctly unchanged — and the getter is re-read on every fire, which is precisely the
fire-time semantics the spec demands. Threading a `dpr()` provider callback would be an abstraction for
a single implementation. The e2e fractional-motion latch at `main.ts:2185-2197` is untouched.

## Consequences

**The centered branch is the DEFAULT on shipped content, not an edge case.** At 1920×1080 dpr 1 the
effective viewport is 640×360 source pixels against a 320×224 map, so today's 10×7 zones are centered
on **both** axes and the follow-camera effectively stops scrolling. On a phone (390×844 at dpr 3) the
effective viewport is 390×844 source pixels, so roughly **73% of the screen height is `FLOOR_COLOR`**.

This is the design's committed direction (spec §uxd1 — "show the WHOLE 10×7 zone CENTERED") and ships
as the documented default rather than blocking on Drew. It is a feel call, and only the three constants
in `config.ts` change if the answer is "zoom further to fill edge-to-edge" — the EARS criteria use them
symbolically, so every test stays valid at any value.

**Known-weak verification, declared rather than papered over:**

- Three `world.ts` plumbing lines are review-only (`renderer.resize`, `stage.scale.set`, and `app.init`
  actually receiving the options object) — coverage-excluded shell with no legal test home in this
  slice's `touches:` set. D6 pulled the two highest-risk expressions out of that set.
- **Spec criterion A8 is NOT satisfied — uxd1 claims no-regression only.** Its premise is false on
  `master`: only `battleView`, `boxView`, `evolutionView`, `raisingView` and `#help-overlay` are
  `position:fixed; inset:0`; ten-plus overlays are plain in-flow divs, a pre-existing defect documented
  at `client/index.html:78-81` and `shopView.ts:52-54` and owned by the overlay-registry slice (uxd3).
  uxd1 touches no DOM/CSS file, and `autoDensity` keeps the canvas CSS box at `innerWidth × innerHeight`,
  so nothing regresses.
- Criterion A10 has no executable tooth (see D9) — review plus a manual retina check.
- Test files are outside the typechecker entirely (`client/tsconfig.json:15` excludes `**/*.test.ts` and
  vitest transpiles without checking), so a structurally-narrower test fake cannot be caught by `just ci`.

**Deferred:** the user-facing zoom control (+/−/pinch, persistence, help copy) routes through uxd3's
overlay registry, never a new open-coded `main.ts` hotkey; per-frame device-grid rounding of
`stage.position` for scrolled bitmap art (it would break ADR-0013 sub-tile slide smoothness);
scale hysteresis (D10); touch listeners.

`screenToWorld` ships with **no caller**, as the slice brief and spec directed, so a future
interaction-prompt or mobile tap-to-move consumes a seam rather than re-deriving one. The `/simplify`
lens dissented on YAGNI grounds and the dissent is recorded here: if the seam is still unused when
mobile input is scheduled, delete it rather than bend a real caller to fit it. A future
`PointerEvent.clientX` caller must subtract the canvas origin — this function's screen space is
canvas-relative CSS pixels. Relatedly, `WorldRenderer` exposes no `#vs` accessor; uxd2 must be given
one rather than re-deriving the scale from `window` and drifting.

## Considered alternatives

- **Letterbox / fixed-aspect fit.** Rejected: wastes screen on a free-scroll follow-camera overworld
  with tiny maps, and the "identical framing for fairness" argument does not apply because PvP is a
  separate battle overlay.
- **Fractional `stage.scale` straight from the ideal CSS scale.** Simpler, and it fills — but it maps
  source texels to fractional device pixels at every scale, which is the shimmer/blur artifact this
  slice exists to remove.
- **Adding a `stageScale` parameter to `offsetFor`.** Rejected under D5: it would put the CSS↔source
  conversion in two modules and make the camera scale-aware for no consumer.
- **A fake-Pixi injection seam on `WorldRenderer`** so the DPR criteria could be asserted against a
  mock. Rejected: it needs a `world.test.ts` outside the declared `touches:` set, and it adds an
  abstraction whose only second implementation is a test.
- **A source-grep eval** asserting `resolution`/`autoDensity` appear in `world.ts`. Rejected: outside
  the `touches:` set, and it proves text rather than behavior — it false-passes on a moved literal.
