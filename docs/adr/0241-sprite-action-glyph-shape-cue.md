# 0241 — The placeholder sprite's action is cued by a monochrome glyph shape, not by tint alone

**Status:** Accepted
**Date:** 2026-09-06
**Slice:** rb-57 (residual R-m23-s8-postmerge-tint, M-residual-backlog.spec.md#rb-57)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0233 (closes the colour-independence gap its §8.2 escalation accepted as out of scope), ADR-0004 (the AssetProvider seam this stays behind), ADR-0160 (the device-integer `nearest` scaling the glyph is designed to survive)
**Subsystems:** client-ui
**Decision:** `#build()` draws a third fill — a per-action glyph of axis-aligned integer rects in the notch's ink `0x10131a`, in a 6x6 field centred on the tile — so action is carried by SHAPE, and `ACTION_TINT` is no longer the sole cue.

---

## Context and problem statement

`client/src/render/placeholderAssets.ts` generates one placeholder texture per `(action, facing)`.
Before this slice it drew exactly two fills:

| # | draw | varies with |
| --- | --- | --- |
| 0 | `roundRect(5,5,22,22,4)` filled `ACTION_TINT[action]` | **colour only** |
| 1 | `circle(16 + n.x*8, 16 + n.y*8, 3)` filled `0x10131a` | facing (geometry) |

So **facing** already had a non-colour cue — the notch's position — while **action** had none.
At a fixed facing, switching `Idle` / `Walking` / `Jumping` changed *only* the body fill's colour;
the draw geometry was byte-identical. Measured on the pre-slice tree via the draw-instruction
capture this slice adds, the three actions' colour-stripped signatures collided for all three
pairs. A player who cannot distinguish `0x6fd3a0` from `0x4fb3ff` from `0xf2c14e` — or anyone
reading a greyscale capture — had no way to tell the three states apart.

ADR-0233 met this in M23 and took its §8.2 escalation default **(a)**: accept `ACTION_TINT` as out
of scope, on the grounds that sprite-art contrast is an art-direction property covered by the
spec's §3.1 partial-conformance declaration, and record it as residual **R-m23-s8-TINT** (promoted
as `R-m23-s8-postmerge-tint`). That deferral is what this slice drains. The concession was never
that the defect was acceptable — only that M23 would not open `client/src/render/`.

## Decision

Add a module-private `ACTION_GLYPH: Record<WasmAction, readonly GlyphBar[]>` of **centre-relative**
`{dx, dy, w, h}` bars, and draw them in `#build()` after the facing notch, in one `.fill(0x10131a)`
call — the same ink the notch already uses.

| action | bars (absolute px, `TILE_PX = 32`) | silhouette | rects | ink area |
| --- | --- | --- | --- | --- |
| `Idle` | `rect(13,15,6,2)` | one bar, at rest | 1 | 12 |
| `Walking` | `rect(13,13,6,2)`, `rect(13,17,6,2)` | `=`, repeating steps | 2 | 24 |
| `Jumping` | `rect(13,15,6,2)`, `rect(15,13,2,6)` | `+`, lifting off | 2 | 20 |

Four properties are deliberate, and each is pinned by a test:

1. **The ink is the notch's, not a second tint.** The cue is a *shape* difference. Re-colouring
   would re-commit the original defect in a new place.
2. **Axis-aligned integer rects only** — no strokes, curves or diagonals. Integer rects rasterise
   with no anti-aliasing, and ADR-0160 scales the stage by a device-*integer* factor with
   `nearest` filtering, so the glyph survives every device scale exactly. A 6px circle or a
   diagonal would be grey mush before the upscale ever ran.
3. **A 6x6 field at half-extent 3**, not 4. The notch bounding boxes are N `y 5..11`, S `y 21..27`,
   E `x 21..27`, W `x 5..11`; a half-extent of 3 leaves exactly **2 clear pixels on every side in
   all four facings**, which the test derives from the captured render rather than from the table.
4. **Every glyph is invariant under a 180-degree rotation about the tile centre.** This makes it
   structurally impossible for a glyph to encode a heading, so it can never grow into a second,
   competing facing cue alongside the notch.

`Record<WasmAction, …>` is the same exhaustive-table shape `ACTION_TINT` and `FACING_NOTCH` already
use: a fourth `WasmAction` variant becomes a compile error. A `switch` with a `default` would
silently ship a colour-only sprite for the new variant — precisely the defect being closed.

The glyph gets its **own** `.fill()` call rather than sharing the notch's. Pixi batches consecutive
path operations into a single fill instruction (`GraphicsContext.fill()` clones the whole active
path and only then resets it), so a shared fill would merge glyph and notch into one instruction
and mutate the existing notch draw. Two fills keep the change purely **additive**: instruction `[0]`
(body) and `[1]` (notch) are byte-identical to before, and `[2]` is new.

## Consequences

- **Positive:** action is perceivable without colour. Adding a `WasmAction` variant now fails to
  compile until it has a glyph. Facing and action have separate, non-competing cues. The file
  gains its first unit test — it had none, and it is coverage-excluded, so the draw-instruction
  suite plus a mutant register is the only mechanical proof available for it.
- **Negative / accepted:** the glyph is a **learned legend**, not self-evident iconography. WCAG
  1.4.1 requires that colour not be the *sole* means of conveying information; it does not require
  the alternative to be self-describing, and one bar / two bars / a cross is not guessable without
  being taught. Overclaiming this as "readable iconography" would be false — it is a
  discriminable, colour-independent state cue, which is what the criterion asks for.
- **Negative / accepted:** the bar sizing (6x2, half-extent 3) is tuned for `TILE_PX = 32` and
  `body = 22`. The offsets are centre-relative so the glyph stays centred if `TILE_PX` changes, but
  the *clearance* against the notch would need re-deriving. The test computes clearance from the
  render, so a `TILE_PX` change that broke it would fail rather than ship silently.
- **Negative / accepted:** `client/src/render/placeholderAssets.ts` stays in `vite.config.ts`'s
  `coverage.exclude` (it is a Pixi shell, and that set is exact-set-guarded by
  `evals/dom-shell-coverage-exclusion.eval.mjs`). The new test therefore contributes no coverage
  number. This is by design, not an oversight: the tests are draw-instruction assertions over a
  structural fake renderer, not rasterized-pixel tests, and `ARCHITECTURE.md`'s "no pixel tests"
  description of the Pixi shell remains literally true.

### Alternatives rejected

- **A `Text` / `BitmapText` label per action.** Drags in a font pipeline and a glyph atlas for
  three states, and is illegible inside a 22px body. YAGNI.
- **A second colour dimension** (e.g. a differently-tinted corner mark). Fails the same WCAG 1.4.1
  criterion this ADR exists to satisfy. A test asserts the glyph's fill is exactly the notch ink
  and is none of the three `ACTION_TINT` values, so this cannot be reintroduced silently.
- **Extracting a pure `actionGlyph.ts` module** and unit-testing that, which is the render-layer
  convention `textureCache.ts:3-6` describes. Out of this slice's declared `touches:` set. It would
  also have been the *weaker* option here: a pure-table test proves the table, whereas testing
  through the public `texture()` covers the table **and** the wiring that draws it. A later
  extraction remains available and is not blocked by this decision.
- **Distinct per-action body silhouettes** instead of a glyph inside a shared body. A larger art
  change with no additional accessibility value, and it would disturb the body roundRect the
  camera/z-order tests reason about.

### Deferred: the assistive-technology arm

The residual's EARS line names two things: the cue is *colour-only*, **and** it has *no DOM
representation*. This ADR closes the first. It does **not** close the second, and the glyph is not
a substitute for it — a baked-in texture is invisible to a screen reader.

The slice's Scope sentence admits either arm ("a companion text/glyph **or** DOM-visible cue"), and
the glyph arm is the one reachable inside `touches: client/src/render/placeholderAssets.ts`. The AT
arm is deferred as acceptance gate **X4 -> backlog**, because it is unreachable from this file:

- `client/src/render/characterView.ts` — the `Sprite` lives here; PixiJS v8's `AccessibilitySystem`
  reads `accessible` / `accessibleTitle` / `accessibleType` off the display object, so the natural
  home is `CharacterView.update()` on an animation-key change.
- `client/src/render/world.ts` — enables the accessibility system on the `Application` and owns the
  `CharacterView` lifecycle.
- `client/e2e/golden.spec.ts` — the only tier that can observe Pixi's accessibility shadow DOM.
- `client/vite.config.ts` — in play only if the arm extracts a pure `accessibleLabel(action, facing)`
  core; its `coverage.exclude` set is exact-set-guarded by
  `evals/dom-shell-coverage-exclusion.eval.mjs`.

It also needs a product decision rather than only wiring: ADR-0233 §3.1 declares partial WCAG
conformance for sprite art, so whether a canvas game announces per-entity action state to assistive
technology — and how it avoids flooding the accessibility tree at 60Hz — is a design question this
slice is not the place to settle.
