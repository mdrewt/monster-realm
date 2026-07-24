#!/usr/bin/env python3
"""Per-species monster spritesheets (pt-d2, ADR-0144 D2/D3).

Companion to `generate_art.py`, which it IMPORTS and never edits. `generate_art`
guards `main()` behind `if __name__ == "__main__"` and derives OUT/PREVIEW from
its own directory, so importing it is side-effect-free and cwd-independent.
The PNG codec, the PixiJS sheet-JSON writer, the normal-map builder and the
lighting preview all come from there — this module only adds body plans and a
per-species data table.

Run:  cd client/art-src && python3 generate_monsters.py

Emits, for every row of the plan table below:
    ../public/assets/monster-<slug>.png / .json
    ../public/assets/monster-<slug>-normal.png / .json
    preview/monster-<slug>@6x.png (+ -normal / -lit)

Sheet format is fixed by the shipped emberkit convention and must not drift:
96x128, 3 cols (idle, walk0, walk1) x 4 rows (down, up, right, left), frame keys
`mon_<face>_<col>`, animations `walk_<face>` / `idle_<face>`. `left` is always an
hflip of the right-facing draw, so every plan is drawn bilaterally symmetric
enough that the mirror does not read as a bug.

Species 1 (Flameling) is deliberately NOT regenerated: `monster-emberkit.*` is
already shipped and is referenced by `demo/index.html`.

The bar is DISTINCT SILHOUETTE, not just palette (H2 attachment). Seven body
plans cover nine species; `evals/pt-d2-roster-wave-2.eval.mjs` enforces both a
unique (plan, size, features) tuple per species AND a >=10% pairwise difference
between the decoded, bbox-cropped alpha masks of every pair's `mon_down_idle`.
"""

import os

from generate_art import (
    INK,
    OUT,
    PREVIEW,
    SHADOW,
    TILE,
    Img,
    blob,
    build_normal_sheet,
    hflip,
    lerp_c,
    light_sheet,
    upscale,
    write_png,
    write_sheet_json,
)

FACINGS = ["down", "up", "right", "left"]
COLS = ["idle", "walk0", "walk1"]
FACE_OF = {"down": "S", "up": "N", "right": "E", "left": "E"}


def hx(s):
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), 255)


def ramp(*hexes):
    return [hx(h) for h in hexes]


# --------------------------------------------------------------------------- #
# Per-species palettes.  Same idiom as generate_art's master palette: 5-step
# dark->light main ramp with cool/violet shadows and warm highlights, a 3-step
# secondary (belly / underside) ramp, and a 3-step dark accent ramp.
#
# Within an affinity the ramps are separated by VALUE, not only hue, so the two
# Water forms and the two Fire forms stay distinguishable under colour-vision
# deficiency (luminance carries the distinction, per the accessibility rule).
# Sproutlet is deliberately shifted toward teal, away from the grass terrain
# ramp it stands on.
# --------------------------------------------------------------------------- #
PALETTES = {
    "tidalin": (
        ramp("#182a52", "#253f7c", "#3a67a8", "#5f95c8", "#8fc1dd"),
        ramp("#274a63", "#4d7f93", "#b7dfe0"),
        ramp("#0f1a33", "#182a52", "#253f7c"),
    ),
    "sproutlet": (
        ramp("#123330", "#1d5248", "#2f7f68", "#55ad84", "#94d9a8"),
        ramp("#a6803c", "#d9b866", "#f6e6a8"),
        ramp("#0a1f1c", "#123330", "#1d5248"),
    ),
    "pyroleo": (
        ramp("#5c1a12", "#9c3418", "#d9611f", "#f5993c", "#ffcf7a"),
        ramp("#7a4a26", "#c08a4a", "#f0d19a"),
        ramp("#2c0e0a", "#5c1a12", "#9c3418"),
    ),
    "embersworn": (
        ramp("#2a1a2e", "#4d2b45", "#7a3f5c", "#b3597a", "#e08fa0"),
        ramp("#5c3a24", "#a86a3e", "#e8c088"),
        ramp("#160d18", "#2a1a2e", "#4d2b45"),
    ),
    "steamveil": (
        ramp("#1c3d4a", "#2f6272", "#4a8f96", "#7cbdb8", "#c4ede0"),
        ramp("#e0955c", "#f5c583", "#fff0d0"),
        ramp("#0f232c", "#1c3d4a", "#2f6272"),
    ),
    "umbraquill": (
        ramp("#100a1a", "#201430", "#38224e", "#5a3f78", "#8a6bb0"),
        ramp("#2e4a2a", "#5c8a4a", "#9ecf6e"),
        ramp("#0a0612", "#100a1a", "#201430"),
    ),
    "venumbra": (
        ramp("#0c0714", "#1c1030", "#341c50", "#543a80", "#7e5cb2"),
        ramp("#3a5c34", "#6ea852", "#b0e888"),
        ramp("#050310", "#0c0714", "#1c1030"),
    ),
    "gustwyrm": (
        ramp("#1a3a3e", "#2c5f5e", "#468a80", "#6fb8a0", "#a6e0bc"),
        ramp("#8a7a4e", "#c2b078", "#f0e3b6"),
        ramp("#0e2226", "#1a3a3e", "#2c5f5e"),
    ),
    "tempestrix": (
        ramp("#123236", "#1e5250", "#348478", "#5cb8a2", "#9ce6c8"),
        ramp("#d8cf9a", "#f4eec4", "#fffbe8"),
        ramp("#081c1e", "#123236", "#1e5250"),
    ),
}

# --------------------------------------------------------------------------- #
# The plan table.  One row per species sheet: (slug, body_plan, size, features).
# `features` is a `|`-separated flag string.  The pt-d2 eval parses the rows
# between the two markers below and requires every (plan, size, features) tuple
# to be unique — two species that differ only by palette are exactly the
# palette-swap failure the distinct-silhouette bar exists to prevent.
#
# Species 1 (Flameling / emberkit) is absent on purpose: already shipped.
# --------------------------------------------------------------------------- #
# PLAN-TABLE-BEGIN
PLAN_TABLE = [
    ("tidalin", "serpent", "small", "fin"),
    ("sproutlet", "sprout", "small", "leafcrown"),
    ("pyroleo", "quadruped", "large", "mane"),
    ("embersworn", "armored", "large", "horns"),
    ("steamveil", "vapor", "large", "veil"),
    ("umbraquill", "orb", "small", "quills"),
    ("venumbra", "orb", "large", "skirt"),
    ("gustwyrm", "avian", "small", "folded"),
    ("tempestrix", "avian", "large", "openwings"),
]
# PLAN-TABLE-END


# --------------------------------------------------------------------------- #
# Shared drawing helpers (thin wrappers over generate_art's primitives).
# --------------------------------------------------------------------------- #
def contact_shadow(im, cx, y, rx, ry=1.6):
    for x in range(cx - rx, cx + rx + 1):
        for yy in range(y - 2, y + 2):
            if ((x - cx) / float(rx)) ** 2 + ((yy - y) / ry) ** 2 <= 1.0:
                im.put(x, yy, SHADOW)


def body(im, cx, cy, rx, ry, pal, outline=True):
    """Main-ramp blob: mid body colour, dark shade, light highlight."""
    blob(im, cx, cy, rx, ry, pal[2], pal[0], pal[4], outline=outline)


def under(im, cx, cy, rx, ry, sec):
    blob(im, cx, cy, rx, ry, sec[1], sec[0], sec[2], outline=False)


def eye(im, x, y, pal):
    im.rect(x, y, 2, 2, INK)
    im.put(x, y, pal[4])


def spike(im, tipx, basey, h, lean, col):
    """Narrow triangular protrusion (ear / quill / leaf / feather / horn)."""
    for i in range(h):
        w = max(1, h - i)
        x0 = tipx - w // 2 + int(round(lean * i / max(1, h)))
        im.hline(x0, basey - i, w, col)
        im.put(x0, basey - i, lerp_c(col, INK, 0.45))
        im.put(x0 + w - 1, basey - i, lerp_c(col, INK, 0.45))


def sz(size, small, large):
    return small if size == "small" else large


# --------------------------------------------------------------------------- #
# Body plans.  Each returns a 32x32 cell for one facing/column.
#
# Every plan keeps the generate_art convention of NEUTRAL, symmetric form
# shading (no baked directional light), so the auto-generated normal map does
# not double up with a real light pass.  Each plan's signature protrusion breaks
# a DIFFERENT edge of the bounding box, which is what keeps nine creatures
# telling apart at 32px.
# --------------------------------------------------------------------------- #
def draw_serpent(facing, col, pal, sec, acc, size, feats):
    """Wide, low, legless S-curve of coil segments. Tell: horizontal mass."""
    im = Img(TILE, TILE)
    b = 1 if col == "walk0" else 0
    sway = {"idle": 0, "walk0": 1, "walk1": -1}[col]
    r = sz(size, 5, 6)
    contact_shadow(im, 16, 29, r + 4)
    if facing == "N":
        body(im, 20 + sway, 24 - b, r, r - 1, pal)
        body(im, 11 - sway, 20 - b, r - 1, r - 2, pal)
        body(im, 18 + sway, 15 - b, r + 1, r, pal)
        im.vline(18 + sway, 12 - b, 5, pal[1])
    else:
        # tail coil (back), mid coil, head (front) — an S read left-to-right
        body(im, 8 - sway, 24 - b, r - 2, r - 3, pal)
        body(im, 15 + sway, 21 - b, r, r - 2, pal)
        head_x = 22 + sway if facing != "S" else 16
        head_y = 15 - b
        body(im, head_x, head_y, r + 1, r, pal)
        under(im, head_x, head_y + 2, r - 2, 2, sec)
        if "fin" in feats:
            spike(im, head_x - 4, head_y - r + 1, 4, -1, acc[2])
            spike(im, head_x + 4, head_y - r + 1, 4, 1, acc[2])
        if facing == "S":
            eye(im, head_x - 3, head_y, pal)
            eye(im, head_x + 2, head_y, pal)
        else:
            eye(im, head_x + 2, head_y, pal)
    return im


def draw_sprout(facing, col, pal, sec, acc, size, feats):
    """Squat round body with a leaf crown breaking the TOP edge. Tell: crown."""
    im = Img(TILE, TILE)
    b = 1 if col == "walk0" else 0
    sway = {"idle": 0, "walk0": 1, "walk1": -1}[col]
    r = sz(size, 8, 10)
    contact_shadow(im, 16, 29, r)
    for dx in (-4, 4):  # stubby roots
        im.rect(16 + dx, 26 - b, 3, 3, acc[2])
    body(im, 16, 20 - b, r, r - 2, pal)
    body(im, 16, 13 - b, r - 2, r - 3, pal)
    if facing != "N":
        under(im, 16, 22 - b, r - 4, 2, sec)
    if "leafcrown" in feats:
        spike(im, 16 + sway, 6 - b, 6, 0, sec[1])
        spike(im, 10 + sway, 9 - b, 5, -2, sec[1])
        spike(im, 22 + sway, 9 - b, 5, 2, sec[1])
    if facing == "S":
        eye(im, 12, 13 - b, pal)
        eye(im, 18, 13 - b, pal)
    elif facing == "E":
        eye(im, 19, 13 - b, pal)
    return im


def draw_quadruped(facing, col, pal, sec, acc, size, feats):
    """Four-legged, separated head+body, maned. Tell: tall stance + mane."""
    im = Img(TILE, TILE)
    b = 1 if col == "walk0" else 0
    lp = {"idle": 0, "walk0": 1, "walk1": -1}[col]
    r = sz(size, 7, 9)
    contact_shadow(im, 16, 29, r + 1)
    if facing == "N":
        body(im, 16, 22 - b, r + 1, r - 3, pal)
        body(im, 16, 12 - b, r - 1, r - 2, pal)
        im.vline(16, 17 - b, 6, pal[1])
    else:
        cx = 16 if facing == "S" else 14
        for dx, ph in ((-r + 1, lp), (r - 3, -lp)):  # legs, alternating
            im.rect(cx + dx, 24 - b + (1 if ph > 0 else 0), 3, 5, acc[2])
        body(im, cx, 21 - b, r + 1, r - 3, pal)
        under(im, cx, 23 - b, r - 3, 2, sec)
        hx_ = cx if facing == "S" else cx + 6
        body(im, hx_, 12 - b, r - 1, r - 2, pal)
        if "mane" in feats:  # mane wedges ring the head — breaks the TOP+SIDES
            for a, lean in ((-r, -2), (0, 0), (r, 2)):
                spike(im, hx_ + a, 5 - b, 5, lean, pal[1])
        spike(im, hx_ - 5, 8 - b, 4, -1, pal[1])
        spike(im, hx_ + 5, 8 - b, 4, 1, pal[1])
        if facing == "S":
            eye(im, hx_ - 4, 12 - b, pal)
            eye(im, hx_ + 2, 12 - b, pal)
        else:
            eye(im, hx_ + 2, 12 - b, pal)
    return im


def draw_armored(facing, col, pal, sec, acc, size, feats):
    """Tall, narrow, rectangular plate armour. Tell: only boxy silhouette."""
    im = Img(TILE, TILE)
    b = 1 if col == "walk0" else 0
    lp = {"idle": 0, "walk0": 1, "walk1": -1}[col]
    # `size` widens the torso block and the shoulder plates, so two rows of the
    # plan table that differ only in size cannot render identically.
    hw = sz(size, 4, 5)  # torso half-width
    contact_shadow(im, 16, 30, hw + 2)
    for dx, ph in ((-hw, lp), (hw - 3, -lp)):  # planted legs, under the torso
        im.rect(16 + dx, 25 - b + (1 if ph > 0 else 0), 3, 5, acc[1])
    im.rect(16 - hw - 1, 22 - b, 2 * hw + 2, 4, pal[1])  # hips
    im.rect(16 - hw, 13 - b, 2 * hw, 10, pal[2])  # torso block
    im.hline(16 - hw, 13 - b, 2 * hw, pal[3])
    im.hline(16 - hw, 22 - b, 2 * hw, pal[0])
    im.rect(16 - hw - 3, 13 - b, 3, 3, pal[1])  # shoulder plates, 3px wider
    im.rect(16 + hw, 13 - b, 3, 3, pal[1])
    im.rect(13, 17 - b, 6, 3, sec[1])  # chest emblem / underlayer
    im.rect(12, 6 - b, 8, 7, pal[2])  # helm
    im.hline(12, 6 - b, 8, pal[3])
    if "horns" in feats:  # single vertical crest + side horns break the TOP
        spike(im, 16, 3 - b, 4, 0, sec[2])
        spike(im, 11, 6 - b, 4, -2, pal[1])
        spike(im, 21, 6 - b, 4, 2, pal[1])
    if facing == "S":
        im.rect(13, 10 - b, 6, 2, acc[0])  # visor slit
        im.put(14, 10 - b, pal[4])
        im.put(18, 10 - b, pal[4])
    elif facing == "E":
        im.rect(16, 10 - b, 4, 2, acc[0])
        im.put(19, 10 - b, pal[4])
    return im


def draw_vapor(facing, col, pal, sec, acc, size, feats):
    """Wide-bottomed bell of vapour with trailing veils, no face, no legs."""
    im = Img(TILE, TILE)
    drift = {"idle": 0, "walk0": 1, "walk1": -1}[col]
    # `size` sets the bell's flare, so two rows of the plan table that differ
    # only in size cannot render identically.
    flare = sz(size, 9, 12)
    contact_shadow(im, 16, 30, flare - 7)  # small + offset: it hovers
    body(im, 16, 23, flare, 6, pal)
    body(im, 16, 15, flare - 6, 6, pal)
    body(im, 16, 19, flare - 3, 4, pal, outline=False)
    under(im, 16, 21, 4, 3, sec)  # warm ember core glowing through the veil
    if "veil" in feats:  # ribbons trail BELOW the bbox — a unique bottom edge
        for dx, ph in ((-flare + 3, drift), (flare - 3, -drift)):
            for i in range(6):
                im.put(16 + dx + int(round(ph * i / 3.0)), 25 + i, pal[1])
                im.put(16 + dx + int(round(ph * i / 3.0)) + 1, 25 + i, pal[3])
    if facing != "N":
        im.put(13 + drift, 14, pal[4])  # two faint vapour glints, not eyes
        im.put(19 + drift, 14, pal[4])
    return im


def draw_orb(facing, col, pal, sec, acc, size, feats):
    """Levitating sphere. small+quills = compact and spiky; large+skirt = wraith."""
    im = Img(TILE, TILE)
    float_y = {"idle": 0, "walk0": -1, "walk1": 1}[col]
    sway = {"idle": 0, "walk0": 1, "walk1": -1}[col]
    r = sz(size, 6, 9)
    cy = sz(size, 16, 15) + float_y
    contact_shadow(im, 16, 29, sz(size, 4, 7), ry=1.2)
    if "skirt" in feats:  # trapezoid hood flaring to the floor
        for i in range(9):
            w = 6 + i
            im.hline(16 - w // 2, cy + r - 2 + i, w, pal[1] if i % 2 else pal[2])
        for dx in (-7, 7):  # long clawed tendrils
            for i in range(5):
                im.put(16 + dx + int(round(sway * i / 2.0)), cy + 2 + i, acc[2])
    body(im, 16, cy, r, r, pal)
    under(im, 16, cy + 2, r - 3, 2, sec)
    if "quills" in feats:  # dorsal quill fan breaks the TOP edge
        for a, lean in ((-5, -2), (0, 0), (5, 2)):
            spike(im, 16 + a, cy - r - 1, 4, lean, sec[1])
        for i in range(4):  # thin dangling wisps, not touching the ground
            im.put(16 - 3 + sway, cy + r + i, acc[2])
            im.put(16 + 3 - sway, cy + r + i, acc[2])
    if facing == "S":
        eye(im, 16 - r + 2, cy - 1, pal)
        eye(im, 16 + r - 4, cy - 1, pal)
    elif facing == "E":
        eye(im, 16 + r - 4, cy - 1, pal)
    return im


def draw_avian(facing, col, pal, sec, acc, size, feats):
    """Bird. small = puffball with folded stub wings; large = full open wingspan."""
    im = Img(TILE, TILE)
    b = 1 if col == "walk0" else 0
    lp = {"idle": 0, "walk0": 1, "walk1": -1}[col]
    wing = {"idle": 0, "walk0": 1, "walk1": 2}[col]  # wing beat phase
    r = sz(size, 6, 8)
    contact_shadow(im, 16, 29, r + 1)
    for dx, ph in ((-3, lp), (2, -lp)):  # thin digitigrade legs
        im.vline(16 + dx, 24 - b + (1 if ph > 0 else 0), 4, acc[2])
        im.hline(16 + dx - 1, 27 - b, 3, acc[1])
    if "openwings" in feats:  # spans the FULL width — the widest silhouette
        for side in (-1, 1):
            for i in range(11):
                h = 6 - abs(i - 5) // 2
                x = 16 + side * (4 + i)
                y = 14 - b - wing + i // 3
                im.vline(x, y, h, pal[2] if i % 2 else pal[1])
                im.put(x, y, pal[3])
    else:  # folded stub wings hug the body
        for side in (-1, 1):
            for i in range(3):
                im.vline(16 + side * (r - 1 + i), 17 - b + i - wing, 4, pal[1])
    body(im, 16, 19 - b, r, r - 1, pal)
    under(im, 16, 21 - b, r - 3, 2, sec)
    body(im, 16, 12 - b, r - 2, r - 3, pal)
    for i in range(3):  # tail feathers break the BOTTOM edge
        spike(im, 16 - 2 + i * 2, 27 - b, 3, 0, pal[1])
    if "openwings" in feats:
        spike(im, 16, 5 - b, 5, 0, sec[1])  # head crest
    if facing == "S":
        eye(im, 13, 12 - b, pal)
        eye(im, 17, 12 - b, pal)
        im.rect(15, 14 - b, 2, 2, sec[1])  # beak
    elif facing == "E":
        eye(im, 17, 12 - b, pal)
        im.rect(19, 14 - b, 3, 2, sec[1])
    return im


PLANS = {
    "serpent": draw_serpent,
    "sprout": draw_sprout,
    "quadruped": draw_quadruped,
    "armored": draw_armored,
    "vapor": draw_vapor,
    "orb": draw_orb,
    "avian": draw_avian,
}


# --------------------------------------------------------------------------- #
# Sheet assembly — mirrors build_monster() exactly so the frame rects of the
# albedo and the normal map are byte-identical by construction: `cells` is built
# ONCE during albedo assembly and both sheets reuse the same frames/animations.
# --------------------------------------------------------------------------- #
def build_species_sheet(slug, plan, size, features):
    pal, sec, acc = PALETTES[slug]
    feats = features.split("|") if features else []
    draw = PLANS[plan]
    sheet = Img(len(COLS) * TILE, len(FACINGS) * TILE)
    frames, cells = {}, []
    for r, face in enumerate(FACINGS):
        for c, col in enumerate(COLS):
            cell = draw(FACE_OF[face], col, pal, sec, acc, size, feats)
            if face == "left":
                cell = hflip(cell)
            ox, oy = c * TILE, r * TILE
            sheet.blit(cell, ox, oy)
            frames[f"mon_{face}_{col}"] = (ox, oy)
            cells.append((f"mon_{face}_{col}", ox, oy, cell))

    animations = {}
    for face in FACINGS:
        animations[f"walk_{face}"] = [f"mon_{face}_walk0", f"mon_{face}_walk1"]
        animations[f"idle_{face}"] = [f"mon_{face}_idle"]

    write_png(os.path.join(OUT, f"monster-{slug}.png"), sheet)
    write_png(os.path.join(PREVIEW, f"monster-{slug}@6x.png"), upscale(sheet, 6))
    write_sheet_json(os.path.join(OUT, f"monster-{slug}.json"),
                     f"monster-{slug}.png", sheet.w, sheet.h, frames, animations)

    nsheet = build_normal_sheet(cells, lambda _n: "hero")
    write_png(os.path.join(OUT, f"monster-{slug}-normal.png"), nsheet)
    write_png(os.path.join(PREVIEW, f"monster-{slug}-normal@6x.png"), upscale(nsheet, 6))
    write_png(os.path.join(PREVIEW, f"monster-{slug}-lit@6x.png"),
              upscale(light_sheet(sheet, nsheet), 6))
    write_sheet_json(os.path.join(OUT, f"monster-{slug}-normal.json"),
                     f"monster-{slug}-normal.png", nsheet.w, nsheet.h, frames, animations)
    return sheet


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(PREVIEW, exist_ok=True)
    for slug, plan, size, features in PLAN_TABLE:
        sheet = build_species_sheet(slug, plan, size, features)
        print(f"monster-{slug}.png + -normal.png   {sheet.w}x{sheet.h}  "
              f"({plan}/{size}/{features or '-'})")
    print(f"-> {OUT}")
    print(f"-> previews (albedo / normal / lit) in {PREVIEW}")


if __name__ == "__main__":
    main()
