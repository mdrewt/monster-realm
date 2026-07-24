#!/usr/bin/env python3
"""ADR-0143 appendix — generator for the pt-d1 playtest roster wave-1 spritesheets.

Emits the four wave-1 monster sheets into `client/public/assets/` in the emberkit
format: 96x128 (a 3-wide x 4-tall grid of 32x32 cells), 12 frames named
`mon_{down,up,right,left}_{idle,walk0,walk1}`, 8 animation keys, 8-bit RGBA
non-interlaced PNG.

WHY THIS LIVES HERE AND NOT IN `client/art-src/generate_art.py`
    `generate_art.py` is the tracked SSOT entry point for every other asset, but it
    sits outside slice pt-d1's declared `touches:` path-set, and a concurrent roster
    wave would have edited the same 1200-line file. Committing binaries whose
    generator is untracked would be a real SSOT violation, so the generator is
    committed *here* instead: it imports the shared drawing/PNG primitives from
    `generate_art.py` and only supplies its own creature routines. The assets stay
    regenerable from tracked source; only the entry point moved. Folding these four
    creatures into `generate_art.py` proper is ADR-0143 residual 1.

    Albedo only — no `-normal.*` sheets. Nothing in `client/src` consumes a normal
    map (there is no light pass), so emitting four more unused binaries is YAGNI.
    Deferred with the HD-2D pass (ADR-0004). ADR-0143 residual 2.

RUN (from the repo root):
    python3 docs/adr/0143-appendix-gen-wave1.py

The output is deterministic — no RNG, no clock — so a re-run reproduces the
committed bytes exactly.

SILHOUETTE BAR (ADR-0143 D5, the H2 "attachment" requirement): none of these may
read as a recolour of Emberkit, which is a round two-eared fox-kit with a curled
tail. Each creature below therefore changes the *shape language*, not just the ramp:
Cragling/Stoneward are rectilinear and earless; Shadelet is a tall single-horned
wisp; Umbrafang is a low crouched quadruped with a forked tail.
"""
import os
import sys

# Import the shared primitives from the tracked generator.
_ART_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "client", "art-src")
sys.path.insert(0, os.path.abspath(_ART_SRC))

from generate_art import (  # noqa: E402
    CREAM,
    INK,
    OUT,
    SHADOW,
    TILE,
    Img,
    blob,
    hflip,
    hx,
    lerp_c,
    write_png,
    write_sheet_json,
)

# --------------------------------------------------------------------------- #
# Wave-1 palette ramps (dark -> light), authored per species so each reads as a
# distinct colour identity on the green terrain as well as in a battle scene.
# --------------------------------------------------------------------------- #
# 7 Cragling (Earth) — slate shadows into warm ochre: a mossy roadside boulder.
CRAG = [hx(c) for c in ("#2b2f3a", "#454b5c", "#6b6350", "#9c8a5f", "#c9b273")]
CRAG_MOSS = hx("#5d8a44")

# 9 Stoneward (Earth) — basalt near-black into moss green: the evolved bulwark.
WARD = [hx(c) for c in ("#1b1f26", "#31394a", "#4a5666", "#6d8069", "#93ad78")]
WARD_CORE = hx("#c9b273")

# 8 Shadelet (Dark) — indigo into violet, one cyan catchlight.
SHAD = [hx(c) for c in ("#1a1430", "#2e2352", "#4a3480", "#6f4fae", "#9c7ad6")]
SHAD_GLOW = hx("#5fe0d8")

# 10 Umbrafang (Dark) — near-black indigo with a magenta rim.
UMBRA = [hx(c) for c in ("#120e21", "#241a3d", "#3b2a5c", "#5b3f7e", "#7d569e")]
UMBRA_RIM = hx("#e0559b")
FANG = hx("#f6f1e3")


def _shadow(im, cx, rx=8):
    """The shared soft contact shadow every creature sits on."""
    for x in range(cx - rx, cx + rx + 1):
        for y in range(27, 30):
            if ((x - cx) / float(rx)) ** 2 + ((y - 28) / 1.6) ** 2 <= 1.0:
                im.put(x, y, SHADOW)


def _box(im, x, y, w, h, ramp, outline=True):
    """A rectilinear body block: lit top face, mid body, shaded base + outline.

    This is the shape primitive that separates the Earth line from every rounded
    `blob`-built creature in the registry.
    """
    im.rect(x, y, w, h, ramp[2])
    im.hline(x, y, w, ramp[3])
    im.hline(x, y + h - 1, w, ramp[1])
    im.vline(x, y, h, ramp[1])
    im.vline(x + w - 1, y, h, ramp[3])
    if outline:
        edge = lerp_c(ramp[1], INK, 0.55)
        im.hline(x, y - 1, w, edge)
        im.hline(x, y + h, w, edge)
        im.vline(x - 1, y, h, edge)
        im.vline(x + w, y, h, edge)


def _gem_eye(im, x, y, col):
    im.rect(x, y, 2, 2, col)
    im.put(x, y, CREAM)


# --------------------------------------------------------------------------- #
# 7 Cragling — Earth, tanky. A squat rectilinear boulder: no ears, no tail, a
# flat crest and four stubby feet. Reads as "rock" at 32px from silhouette alone.
# --------------------------------------------------------------------------- #
def draw_cragling(facing, col):
    im = Img(TILE, TILE)
    b = 1 if col == "walk0" else 0
    lp = {"idle": 0, "walk0": 1, "walk1": -1}[col]
    cx = 16
    _shadow(im, cx, 8)

    for dx, ph in ((-6, lp), (-1, -lp), (3, lp), (8, -lp)):  # four stubby feet
        im.rect(cx + dx, 25 - b + (1 if ph > 0 else 0), 3, 3, CRAG[1])
    _box(im, cx - 9, 15 - b, 18, 10, CRAG)                   # boulder body
    _box(im, cx - 6, 9 - b, 12, 6, CRAG)                     # head block
    # Jagged crest: chunks of decreasing height, NOT a full-width slab — a flat
    # slab silhouettes as furniture rather than as a creature at 32px.
    for ox, ch in ((-6, 2), (-3, 3), (0, 2), (3, 3), (5, 1)):
        im.rect(cx + ox, 8 - b - ch + 1, 2, ch, CRAG[4])
        im.put(cx + ox, 8 - b - ch + 1, lerp_c(CRAG[4], INK, 0.45))

    if facing == "S":
        _gem_eye(im, cx - 4, 11 - b, CRAG_MOSS)
        _gem_eye(im, cx + 2, 11 - b, CRAG_MOSS)
        im.hline(cx - 2, 13 - b, 4, CRAG[1])                 # mouth seam
        im.put(cx - 7, 18 - b, CRAG_MOSS)                    # moss patches
        im.put(cx + 6, 20 - b, CRAG_MOSS)
    elif facing == "N":
        im.hline(cx - 5, 11 - b, 10, CRAG[1])                # back seam
        im.put(cx - 4, 18 - b, CRAG_MOSS)
        im.put(cx + 3, 17 - b, CRAG_MOSS)
        im.put(cx + 6, 21 - b, CRAG_MOSS)
    else:  # E
        _gem_eye(im, cx + 2, 11 - b, CRAG_MOSS)
        im.hline(cx + 1, 13 - b, 4, CRAG[1])
        im.put(cx - 6, 19 - b, CRAG_MOSS)
        im.put(cx + 5, 21 - b, CRAG_MOSS)
    return im


# --------------------------------------------------------------------------- #
# 9 Stoneward — Earth, support. The same rectilinear language scaled up, with a
# wide shoulder shelf and TWO back spires that break the top silhouette.
# --------------------------------------------------------------------------- #
def draw_stoneward(facing, col):
    im = Img(TILE, TILE)
    b = 1 if col == "walk0" else 0
    lp = {"idle": 0, "walk0": 1, "walk1": -1}[col]
    cx = 16
    _shadow(im, cx, 10)

    for dx, ph in ((-8, lp), (-2, -lp), (2, lp), (7, -lp)):  # heavy legs
        im.rect(cx + dx, 24 - b + (1 if ph > 0 else 0), 4, 4, WARD[1])
    for sx, sh in ((cx - 7, 6), (cx + 4, 8)):                # two back spires
        for i in range(sh):
            w = max(1, (sh - i) // 2 + 1)
            im.hline(sx - w // 2, 12 - b - i, w, WARD[3] if i % 2 else WARD[2])
        im.put(sx, 12 - b - sh, WARD_CORE)
    _box(im, cx - 10, 16 - b, 20, 9, WARD)                   # body
    _box(im, cx - 11, 13 - b, 22, 4, WARD)                   # shoulder shelf
    _box(im, cx - 5, 8 - b, 10, 5, WARD)                     # head

    if facing == "S":
        _gem_eye(im, cx - 4, 10 - b, WARD_CORE)
        _gem_eye(im, cx + 2, 10 - b, WARD_CORE)
        im.rect(cx - 2, 19 - b, 5, 3, WARD_CORE)             # glowing core plate
        im.put(cx - 2, 19 - b, CREAM)
    elif facing == "N":
        im.hline(cx - 4, 10 - b, 9, WARD[1])
        im.vline(cx, 17 - b, 7, WARD[1])                     # spine seam
    else:  # E
        _gem_eye(im, cx + 1, 10 - b, WARD_CORE)
        im.rect(cx + 1, 19 - b, 4, 3, WARD_CORE)
        im.put(cx + 1, 19 - b, CREAM)
    return im


# --------------------------------------------------------------------------- #
# 8 Shadelet — Dark, status. Tall and thin with ONE long horn-ear, a wispy
# trailing tail and a single oversized eye. Vertical silhouette, no legs.
# --------------------------------------------------------------------------- #
def draw_shadelet(facing, col):
    im = Img(TILE, TILE)
    b = 1 if col == "walk0" else 0
    drift = {"idle": 0, "walk0": 1, "walk1": -1}[col]
    cx = 16
    _shadow(im, cx, 5)

    for i in range(7):                                       # wispy trailing tail
        w = max(1, 5 - i // 2)
        im.hline(cx - w // 2 + drift * (i // 3), 26 - b - i, w, SHAD[1] if i % 2 else SHAD[2])
    blob(im, cx, 18 - b, 5, 8, SHAD[2], SHAD[0], SHAD[3])    # tall slender body
    blob(im, cx, 11 - b, 5, 5, SHAD[2], SHAD[0], SHAD[3])    # small head
    for i in range(9):                                       # single long horn-ear
        im.put(cx + 1 + i // 4, 6 - b - i, SHAD[3] if i % 2 else SHAD[4])
    im.put(cx + 3, 6 - b - 8, SHAD_GLOW)                     # horn tip glow

    if facing == "S":
        im.rect(cx - 2, 10 - b, 4, 3, INK)                   # one oversized eye
        im.put(cx - 1, 10 - b, SHAD_GLOW)
        im.hline(cx - 5, 18 - b, 3, SHAD_GLOW)               # side wisps
        im.hline(cx + 3, 20 - b, 3, SHAD_GLOW)
    elif facing == "N":
        im.hline(cx - 3, 11 - b, 7, SHAD[1])
        im.vline(cx, 15 - b, 8, SHAD[1])
    else:  # E
        im.rect(cx + 1, 10 - b, 3, 3, INK)
        im.put(cx + 2, 10 - b, SHAD_GLOW)
        im.hline(cx - 5, 19 - b, 4, SHAD_GLOW)
    return im


# --------------------------------------------------------------------------- #
# 10 Umbrafang — Dark, fast sweeper. Low, crouched and elongated, with twin
# downward fangs, a FORKED tail and a swept-back ear. Horizontal silhouette.
# --------------------------------------------------------------------------- #
def draw_umbrafang(facing, col):
    im = Img(TILE, TILE)
    b = 1 if col == "walk0" else 0
    lp = {"idle": 0, "walk0": 1, "walk1": -1}[col]
    cx = 16
    _shadow(im, cx, 11)

    for i in range(6):                                       # forked tail
        im.put(cx - 9 - i // 2, 18 - b - i, UMBRA[2])
    im.put(cx - 12, 12 - b, UMBRA_RIM)
    im.put(cx - 10, 11 - b, UMBRA_RIM)
    for dx, ph in ((-6, lp), (6, -lp)):                      # low sprinter legs
        im.rect(cx + dx, 24 - b, 3, 3 + (1 if ph < 0 else 0), UMBRA[1])
    blob(im, cx, 21 - b, 11, 4, UMBRA[2], UMBRA[0], UMBRA[3])  # long low body
    im.hline(cx - 10, 18 - b, 20, UMBRA_RIM)                 # magenta back rim
    # The head sits forward along the facing axis: centred when the creature faces
    # the camera or away, offset right on the side view (hflip covers "left").
    hx_off = 0 if facing in ("S", "N") else 6
    blob(im, cx + hx_off, 16 - b, 6, 4, UMBRA[2], UMBRA[0], UMBRA[3])
    for i in range(5):                                       # swept-back ear
        im.put(cx + hx_off - 4 - i, 12 - b - i // 2, UMBRA[3])

    if facing == "S":
        _gem_eye(im, cx - 3, 15 - b, UMBRA_RIM)
        _gem_eye(im, cx + 2, 15 - b, UMBRA_RIM)
        im.put(cx - 2, 18 - b, FANG)                         # twin downward fangs
        im.put(cx + 2, 18 - b, FANG)
    elif facing == "N":
        im.hline(cx - 4, 15 - b, 9, UMBRA[1])                # back of the skull
    else:  # E
        _gem_eye(im, cx + 8, 15 - b, UMBRA_RIM)
        im.put(cx + 8, 18 - b, FANG)
        im.put(cx + 10, 18 - b, FANG)
    return im


# --------------------------------------------------------------------------- #
# Sheet assembly — identical layout contract to `generate_art.build_monster`.
# --------------------------------------------------------------------------- #
FACINGS = ["down", "up", "right", "left"]
COLS = ["idle", "walk0", "walk1"]
FACE_CODE = {"down": "S", "up": "N", "right": "E", "left": "E"}

WAVE1 = [
    ("monster-cragling", draw_cragling),
    ("monster-shadelet", draw_shadelet),
    ("monster-stoneward", draw_stoneward),
    ("monster-umbrafang", draw_umbrafang),
]


def build_sheet(slug, draw_fn):
    sheet = Img(3 * TILE, 4 * TILE)
    frames = {}
    for r, face in enumerate(FACINGS):
        for c, col in enumerate(COLS):
            cell = draw_fn(FACE_CODE[face], col)
            if face == "left":
                cell = hflip(cell)
            ox, oy = c * TILE, r * TILE
            sheet.blit(cell, ox, oy)
            frames["mon_%s_%s" % (face, col)] = (ox, oy)
    animations = {}
    for face in FACINGS:
        animations["walk_%s" % face] = ["mon_%s_walk0" % face, "mon_%s_walk1" % face]
        animations["idle_%s" % face] = ["mon_%s_idle" % face]
    write_png(os.path.join(OUT, "%s.png" % slug), sheet)
    write_sheet_json(os.path.join(OUT, "%s.json" % slug), "%s.png" % slug,
                     sheet.w, sheet.h, frames, animations)
    return sheet


def main():
    os.makedirs(OUT, exist_ok=True)
    for slug, fn in WAVE1:
        s = build_sheet(slug, fn)
        print("%-22s %dx%d  (12 frames)" % (slug + ".png", s.w, s.h))
    print("-> %s" % OUT)


if __name__ == "__main__":
    main()
