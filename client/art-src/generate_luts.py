#!/usr/bin/env python3
"""The post stack's colour-grade LUTs: one per time-of-day keyframe (wap-9).

Companion to `generate_art.py`, which it IMPORTS and never edits (the same
contract as `generate_backdrop.py`). Stdlib only and deterministic: every value
is closed-form arithmetic on the lattice coordinate, no RNG.

Run:  cd client/art-src && python3 generate_luts.py [--out DIR]

Emits (default DIR is ../public/assets):
    lut-day.png    1024x32 RGBA
    lut-dusk.png   1024x32 RGBA
    lut-night.png  1024x32 RGBA

Layout is the one pixi-filters' ColorMapFilter reads: a horizontal strip of
SIZE slices, each SIZE x SIZE; the slice index is blue, x inside a slice is red,
y is green. Lattice point (r, g, b) in 0..SIZE-1 maps to the input colour
(r, g, b) * 255 / (SIZE - 1), and the pixel stores that colour graded.

Grades (`grade_*` below): day is a gentle storybook lift on the identity (a
touch of warmth and saturation); dusk warms toward orange and pulls blue down;
night cools toward blue, darkens and desaturates. The look-dev scene renders
each one; `client/src/render/art/packs/grade.ts` registers the three files.
"""

import argparse
import os

from generate_art import OUT, Img, write_png

SIZE = 32  # lattice points per axis; the strip is SIZE*SIZE x SIZE


def clamp01(v):
    return 0.0 if v < 0.0 else 1.0 if v > 1.0 else v


def luma(r, g, b):
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def saturate(rgb, amount):
    """Scale chroma about the pixel's luma (amount 1 = unchanged)."""
    y = luma(*rgb)
    return tuple(y + (c - y) * amount for c in rgb)


def grade_day(rgb):
    r, g, b = saturate(rgb, 1.08)
    return (r * 1.03 + 0.01, g * 1.01 + 0.005, b * 0.97)


def grade_dusk(rgb):
    r, g, b = saturate(rgb, 0.95)
    return (r * 1.06 + 0.04, g * 0.88 + 0.01, b * 0.70)


def grade_night(rgb):
    r, g, b = saturate(rgb, 0.55)
    return (r * 0.42, g * 0.52 + 0.01, b * 0.78 + 0.05)


GRADES = (
    ("lut-day.png", grade_day),
    ("lut-dusk.png", grade_dusk),
    ("lut-night.png", grade_night),
)


def build(grade):
    im = Img(SIZE * SIZE, SIZE)
    step = 1.0 / (SIZE - 1)
    for b in range(SIZE):
        for g in range(SIZE):
            for r in range(SIZE):
                out = grade((r * step, g * step, b * step))
                px = tuple(int(round(clamp01(c) * 255)) for c in out)
                im.put(b * SIZE + r, g, (*px, 255))
    return im


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default=OUT, help="output directory (default: the served assets)")
    out = parser.parse_args().out
    os.makedirs(out, exist_ok=True)
    for name, grade in GRADES:
        im = build(grade)
        write_png(os.path.join(out, name), im)
        print(f"{name} {im.w}x{im.h}")
    print(f"-> {out}")


if __name__ == "__main__":
    main()
