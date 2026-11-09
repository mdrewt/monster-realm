#!/usr/bin/env python3
"""The battle backdrop: one meadow battlefield behind the tactical board (wap-3).

Companion to `generate_art.py`, which it IMPORTS and never edits (the same
contract as `generate_monsters.py`). Stdlib only and deterministic: every tuft
and dither choice comes from an integer hash of its pixel, never `random`.

Run:  cd client/art-src && python3 generate_backdrop.py

Emits:
    ../public/assets/battle-backdrop.png   320x192 RGBA, one full-sheet frame
    (no preview: the asset itself is large enough to judge)

Composition, top to bottom: a dark tree line, a lit horizon band, then the
meadow the board sits on — the terrain grass ramp `G` from `generate_art.py`,
so the battlefield shares the world's palette. The meadow stays mid-value
(mean relative luminance inside the style guide's battlefield band, default
0.15-0.40) so the board's tile overlays and HP bars read on top of it; the
script prints the measured value for the style guide.
"""

import os

from generate_art import OUT, G, Img, write_png

W, H = 320, 192
TREE_LINE = 28   # rows of distant canopy
HORIZON = 6      # rows of lit band under the canopy


def h32(x, y, salt):
    """Deterministic integer hash of a pixel (no RNG)."""
    v = (x * 374761393 + y * 668265263 + salt * 2246822519) & 0xFFFFFFFF
    v = ((v ^ (v >> 13)) * 1274126177) & 0xFFFFFFFF
    return v ^ (v >> 16)


def bayer(x, y):
    """4x4 ordered-dither threshold in [0, 16)."""
    m = (0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5)
    return m[(y & 3) * 4 + (x & 3)]


def build():
    im = Img(W, H)
    # Distant canopy: the darkest grass shade, its lower edge a bumpy lit fringe.
    for x in range(W):
        fringe = 4 + (h32(x // 6, 0, 1) % 6)
        for y in range(TREE_LINE):
            im.put(x, y, G[0] if y < TREE_LINE - fringe else G[1])
    # Horizon band: dither from the dark shade into the base meadow colour.
    for y in range(TREE_LINE, TREE_LINE + HORIZON):
        level = (y - TREE_LINE) * 16 // HORIZON
        for x in range(W):
            im.put(x, y, G[2] if bayer(x, y) < level else G[1])
    # Meadow: the base colour, a soft value gradient toward the viewer (dither),
    # and sparse two-pixel grass tufts with a highlight tip.
    top = TREE_LINE + HORIZON
    for y in range(top, H):
        depth = (y - top) * 6 // (H - top)  # 0..5: nearer rows get more shade
        for x in range(W):
            im.put(x, y, G[1] if bayer(x, y) < depth else G[2])
    for y in range(top + 2, H):
        for x in range(W):
            if h32(x, y, 7) % 53 == 0:
                im.put(x, y, G[3])
                im.put(x, y - 1, G[4] if h32(x, y, 9) % 3 == 0 else G[3])
    return im


def mean_relative_luminance(im):
    """Rec. 709 relative luminance on linearised sRGB, averaged over pixels."""
    def lin(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    total = 0.0
    for i in range(0, len(im.px), 4):
        r, g, b = im.px[i], im.px[i + 1], im.px[i + 2]
        total += 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
    return total / (im.w * im.h)


def main():
    os.makedirs(OUT, exist_ok=True)
    im = build()
    write_png(os.path.join(OUT, "battle-backdrop.png"), im)
    print(f"battle-backdrop.png {im.w}x{im.h}  mean Y = {mean_relative_luminance(im):.3f}")
    print(f"-> {OUT}")


if __name__ == "__main__":
    main()
