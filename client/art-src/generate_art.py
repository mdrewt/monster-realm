#!/usr/bin/env python3
"""
generate_art.py — deterministic pixel-art generator for the Monster Realm POC.

Produces two PixiJS-v8 spritesheets (PNG + JSON) plus 6x preview PNGs:

  ../public/assets/hero.png                 4-dir tamer, idle/walk/jump (20 frames)
  ../public/assets/hero.json
  ../public/assets/tileset-edge-of-town.png 48 tiles: grass route <-> town
  ../public/assets/tileset-edge-of-town.json
  ../public/assets/palette.png              the shared master palette swatch
  ./preview/hero@6x.png                     nearest-neighbour previews (not served)
  ./preview/tileset@6x.png

Art direction (locked with the user):
  - 3/4 oblique perspective, 32x32 px/tile (TILE_PX), "warm vibrant storybook" palette.
  - ONE shared, hue-shifted master palette across hero + tiles (ramps: shadows shift
    cool/violet, highlights shift warm/yellow).
  - Hero = tamer/ranger hybrid: teal coat + rust scarf + tan satchel + cap. Teal/rust
    deliberately CONTRAST the green terrain so the hero stays readable on grass.
  - Neutrally lit (gentle symmetric form-shading, NO baked directional shadows) so each
    frame doubles as an albedo for a later HD-2D normal-map / lighting pass.

Pure stdlib (zlib) — no Pillow, no external image service. Fully reproducible:
  $ python3 generate_art.py
"""

import math
import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "public", "assets"))
PREVIEW = os.path.join(HERE, "preview")
TILE = 32

# Normal-map green-channel convention.  FLIP_Y=False => Y-DOWN (screen space),
# which matches the common PixiJS shader `normalize(tex.rgb*2-1)` with a
# screen-space (y-down) light vector.  Set True for OpenGL / SpriteIlluminator
# "Y is up" maps.  Verified against the generated *-lit@6x.png previews.
FLIP_Y = False

# --------------------------------------------------------------------------- #
# Master palette — hue-shifted ramps (dark -> light).  Shadows lean cool/violet,
# highlights lean warm/yellow.  Authored once; both sheets pull from it.
# --------------------------------------------------------------------------- #
def hx(s):
    s = s.lstrip("#")
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), 255)


INK = hx("#181225")        # selective-outline near-black (warm violet-black)
SHADOW = (24, 18, 37, 70)  # soft contact shadow (low-alpha)

# terrain
G = [hx(c) for c in ("#1f4030", "#2f6b3d", "#4a9b46", "#74c24a", "#a7df66")]  # grass
TG = [hx(c) for c in ("#15332a", "#1f4d35", "#2c6f3b")]                        # tallgrass base
D = [hx(c) for c in ("#43291f", "#6e4630", "#9c6a3e", "#c69a5b", "#e7cb8c")]   # dirt/path
S = [hx(c) for c in ("#2c2935", "#4d4954", "#726d79", "#9d99a3", "#cac6cc")]   # stone/cobble
WAT = [hx(c) for c in ("#143b57", "#1f6a86", "#2e9bb0", "#5fc3cf", "#abe8e1")] # water
WD = [hx(c) for c in ("#34211a", "#5c3a25", "#7e5331", "#a6743f", "#cba066")]  # wood
RF = [hx(c) for c in ("#5a231f", "#8a382a", "#b85738", "#e08653", "#f4b482")]  # roof/brick terracotta
F = [hx(c) for c in ("#103021", "#1d4e32", "#2c7440", "#46a04e", "#7cc95c")]   # foliage canopy

# accents
RED = hx("#e2524a")
GOLD = hx("#f2c14e")
VIO = hx("#8a5cc0")
CREAM = hx("#f6f1e3")
PINK = hx("#f08fb0")

# hero
SK = [hx(c) for c in ("#83502f", "#b6794a", "#df9f63", "#f4cb91")]  # skin
CT = [hx(c) for c in ("#143039", "#1f4f5c", "#2c7585", "#56a3ae")]  # coat (deep teal)
SC = [hx(c) for c in ("#8a3320", "#c2572a", "#e8853a", "#f7b75d")]  # scarf (rust)
LT = [hx(c) for c in ("#5c3a24", "#875730", "#b5854a", "#d8b070")]  # leather / satchel
HR = [hx(c) for c in ("#281b14", "#48311f", "#6e4d33")]            # hair
PT = [hx(c) for c in ("#23282f", "#394450", "#4f5d6b")]            # trousers
BOOT = [hx(c) for c in ("#2e1d16", "#4a3122", "#6b4a30")]          # boots

# creature — "Emberkit": warm amber fox-kit, complementary to green terrain (reads on grass)
MFUR = [hx(c) for c in ("#7a2f16", "#b8501f", "#e07c2c", "#f5a945", "#ffd27a")]  # fur
MBEL = [hx(c) for c in ("#b07a3e", "#e3bd82", "#f9efd0")]                        # belly/cream
MPAW = [hx(c) for c in ("#241712", "#43271b", "#5e3a26")]                        # paws/dark
MEAR = hx("#d9756a")                                                            # inner ear

PALETTE_ROWS = [G, D, S, WAT, WD, RF, F, CT, SC, LT, SK, HR, MFUR]


# --------------------------------------------------------------------------- #
# Image buffer (RGBA) + minimal PNG writer
# --------------------------------------------------------------------------- #
class Img:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.px = bytearray(w * h * 4)  # transparent black

    def _i(self, x, y):
        return (y * self.w + x) * 4

    def put(self, x, y, c):
        """Alpha-composite c over the existing pixel (straight alpha 'over')."""
        if not (0 <= x < self.w and 0 <= y < self.h):
            return
        a = c[3]
        if a == 0:
            return
        i = self._i(x, y)
        if a == 255:
            self.px[i:i + 4] = bytes(c)
            return
        br, bg, bb, ba = self.px[i], self.px[i + 1], self.px[i + 2], self.px[i + 3]
        af = a / 255.0
        oa = a + ba * (1 - af)
        if oa <= 0:
            self.px[i:i + 4] = b"\x00\x00\x00\x00"
            return
        r = (c[0] * af + br * (ba / 255.0) * (1 - af)) / (oa / 255.0)
        g = (c[1] * af + bg * (ba / 255.0) * (1 - af)) / (oa / 255.0)
        b = (c[2] * af + bb * (ba / 255.0) * (1 - af)) / (oa / 255.0)
        self.px[i:i + 4] = bytes((int(r + 0.5), int(g + 0.5), int(b + 0.5), int(oa + 0.5)))

    def rect(self, x, y, w, h, c):
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                self.put(xx, yy, c)

    def hline(self, x, y, w, c):
        for xx in range(x, x + w):
            self.put(xx, y, c)

    def vline(self, x, y, h, c):
        for yy in range(y, y + h):
            self.put(x, yy, c)

    def blit(self, src, ox, oy):
        for yy in range(src.h):
            for xx in range(src.w):
                i = src._i(xx, yy)
                if src.px[i + 3]:
                    self.put(ox + xx, oy + yy, tuple(src.px[i:i + 4]))


def write_png(path, img):
    def chunk(typ, data):
        body = typ + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)

    raw = bytearray()
    stride = img.w * 4
    for y in range(img.h):
        raw.append(0)  # filter: none
        raw += img.px[y * stride:(y + 1) * stride]
    out = b"\x89PNG\r\n\x1a\n"
    out += chunk(b"IHDR", struct.pack(">IIBBBBB", img.w, img.h, 8, 6, 0, 0, 0))
    out += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    out += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(out)


def upscale(img, k):
    out = Img(img.w * k, img.h * k)
    for y in range(img.h):
        for x in range(img.w):
            i = img._i(x, y)
            c = tuple(img.px[i:i + 4])
            if c[3]:
                out.rect(x * k, y * k, k, k, c)
    return out


def noise(x, y, seed=0):
    """Deterministic hash noise in [0,1). Use LOCAL tile coords for seamless tiling."""
    n = (x * 374761393 + y * 668265263 + seed * 1274126177) & 0xFFFFFFFF
    n = ((n ^ (n >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFF) / 65536.0


def lerp_c(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t + 0.5) for i in range(4))


# --------------------------------------------------------------------------- #
# Normal maps — derived from a per-asset HEIGHT field, not faked from luminance.
#
# height = (alpha-distance BEVEL, which "puffs" sprites/props so the silhouette
# rounds and catches rim light) + (form RELIEF from the albedo's symmetric
# shading, which is a faithful height cue precisely because each material is
# shaded — not directionally lit).  height -> normal via a Sobel gradient,
# encoded tangent-space (flat = 128,128,255).  Opaque tiles sample height with
# WRAP so terrain normals stay seamless; alpha assets CLAMP + go transparent
# outside the silhouette so the light pass ignores empty pixels.
# --------------------------------------------------------------------------- #
PROFILES = {  # bevel weight, luminance weight, gradient strength, wrap, alpha-masked
    "hero":    dict(bevel=0.65, lum=0.35, strength=2.3, wrap=False, alpha=True),
    "prop":    dict(bevel=0.72, lum=0.28, strength=2.6, wrap=False, alpha=True),
    "terrain": dict(bevel=0.0,  lum=1.0,  strength=1.5, wrap=True,  alpha=False),
    "tall":    dict(bevel=0.0,  lum=1.0,  strength=2.1, wrap=True,  alpha=False),
    "water":   dict(bevel=0.0,  lum=1.0,  strength=1.8, wrap=True,  alpha=False),
    "brick":   dict(bevel=0.0,  lum=1.0,  strength=2.4, wrap=True,  alpha=False),
    "roof":    dict(bevel=0.0,  lum=1.0,  strength=2.7, wrap=True,  alpha=False),
    "object":  dict(bevel=0.0,  lum=1.0,  strength=2.2, wrap=False, alpha=False),
}


def clamp8(v):
    return 0 if v < 0 else (255 if v > 255 else int(v + 0.5))


def smoothstep(t):
    t = 0.0 if t < 0 else (1.0 if t > 1 else t)
    return t * t * (3 - 2 * t)


def _luma(r, g, b):
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255.0


def bevel_field(mask):
    """Chamfer (1, 1.414) distance-to-edge inside the mask, smoothstepped over a
    ~5px bevel -> a rounded dome (0 at the silhouette, 1 in the interior)."""
    H = len(mask); W = len(mask[0])
    INF = 1e9
    d = [[(INF if mask[y][x] else 0.0) for x in range(W)] for y in range(H)]
    a, b = 1.0, 1.41421356
    for y in range(H):
        for x in range(W):
            if not mask[y][x]:
                continue
            m = d[y][x]
            if x > 0: m = min(m, d[y][x - 1] + a)
            if y > 0: m = min(m, d[y - 1][x] + a)
            if x > 0 and y > 0: m = min(m, d[y - 1][x - 1] + b)
            if x < W - 1 and y > 0: m = min(m, d[y - 1][x + 1] + b)
            d[y][x] = m
    for y in range(H - 1, -1, -1):
        for x in range(W - 1, -1, -1):
            if not mask[y][x]:
                continue
            m = d[y][x]
            if x < W - 1: m = min(m, d[y][x + 1] + a)
            if y < H - 1: m = min(m, d[y + 1][x] + a)
            if x < W - 1 and y < H - 1: m = min(m, d[y + 1][x + 1] + b)
            if x > 0 and y < H - 1: m = min(m, d[y + 1][x - 1] + b)
            d[y][x] = m
    bw = 5.0
    return [[smoothstep(min(d[y][x], bw) / bw) for x in range(W)] for y in range(H)]


def normal_from_albedo(cell, profile):
    """RGBA tangent-space normal map for one 32x32 albedo cell."""
    p = PROFILES[profile]
    W = H = TILE
    lum = [[0.0] * W for _ in range(H)]
    mask = [[False] * W for _ in range(H)]
    for y in range(H):
        for x in range(W):
            i = cell._i(x, y)
            on = cell.px[i + 3] >= 128
            mask[y][x] = on
            if on:
                lum[y][x] = _luma(cell.px[i], cell.px[i + 1], cell.px[i + 2])
    bev = bevel_field(mask) if p["bevel"] > 0 else None
    h = [[p["lum"] * lum[y][x] + (p["bevel"] * bev[y][x] if bev else 0.0)
          for x in range(W)] for y in range(H)]

    def hat(x, y):
        if p["wrap"]:
            return h[y % H][x % W]
        return h[min(max(y, 0), H - 1)][min(max(x, 0), W - 1)]

    out = Img(W, H)
    s = p["strength"]
    for y in range(H):
        for x in range(W):
            if p["alpha"] and not mask[y][x]:
                continue  # leave transparent so the light pass skips it
            gx = (hat(x + 1, y) - hat(x - 1, y)) * s
            gy = (hat(x, y + 1) - hat(x, y - 1)) * s
            nx, ny, nz = -gx, -gy, 1.0
            inv = 1.0 / math.sqrt(nx * nx + ny * ny + nz * nz)
            nx *= inv; ny *= inv; nz *= inv
            g = (ny * 0.5 + 0.5) * 255
            if FLIP_Y:
                g = 255 - g
            j = out._i(x, y)
            out.px[j:j + 4] = bytes((clamp8((nx * 0.5 + 0.5) * 255), clamp8(g),
                                     clamp8((nz * 0.5 + 0.5) * 255), 255))
    return out


def light_sheet(albedo, normal, bg=(38, 36, 46)):
    """Software deferred-lighting preview: 2 directional lights (warm key upper-
    left, cool fill lower-right) + ambient, exactly as a PixiJS light pass would
    sample albedo+normal.  Proves the normals respond correctly."""
    def unit(v):
        m = math.sqrt(sum(c * c for c in v)) or 1.0
        return [c / m for c in v]

    L1, c1, i1 = unit([-0.55, -0.55, 0.62]), (1.0, 0.92, 0.76), 0.95  # warm key
    L2, c2, i2 = unit([0.5, 0.38, 0.72]), (0.55, 0.68, 0.98), 0.42    # cool fill
    amb = 0.34
    out = Img(albedo.w, albedo.h)
    out.rect(0, 0, albedo.w, albedo.h, (*bg, 255))
    for y in range(albedo.h):
        for x in range(albedo.w):
            i = albedo._i(x, y)
            if not albedo.px[i + 3]:
                continue
            ar, ag, ab = albedo.px[i], albedo.px[i + 1], albedo.px[i + 2]
            j = normal._i(x, y)
            if normal.px[j + 3]:
                nx = normal.px[j] / 255 * 2 - 1
                ny = normal.px[j + 1] / 255 * 2 - 1
                nz = normal.px[j + 2] / 255 * 2 - 1
                if FLIP_Y:
                    ny = -ny
                m = math.sqrt(nx * nx + ny * ny + nz * nz) or 1.0
                nx /= m; ny /= m; nz /= m
            else:
                nx, ny, nz = 0.0, 0.0, 1.0
            d1 = max(0.0, nx * L1[0] + ny * L1[1] + nz * L1[2]) * i1
            d2 = max(0.0, nx * L2[0] + ny * L2[1] + nz * L2[2]) * i2
            out.px[i:i + 4] = bytes((
                clamp8(ar * (amb + c1[0] * d1 + c2[0] * d2)),
                clamp8(ag * (amb + c1[1] * d1 + c2[1] * d2)),
                clamp8(ab * (amb + c1[2] * d1 + c2[2] * d2)), 255))
    return out


def build_normal_sheet(cells, profile_of):
    """cells: list of (name, ox, oy, cell_img).  Returns a normal-map sheet."""
    w = max(ox for _, ox, _, _ in cells) + TILE
    h = max(oy for _, _, oy, _ in cells) + TILE
    sheet = Img(w, h)
    for name, ox, oy, cell in cells:
        sheet.blit(normal_from_albedo(cell, profile_of(name)), ox, oy)
    return sheet


# --------------------------------------------------------------------------- #
# Terrain fills
# --------------------------------------------------------------------------- #
def fill_grass(im, seed=0):
    """Seamless grass base: mid green + hue-shifted speckle + a few blades."""
    for y in range(TILE):
        for x in range(TILE):
            n = noise(x, y, seed)
            if n > 0.93:
                c = G[4]
            elif n > 0.72:
                c = G[3]
            elif n < 0.22:
                c = G[1]
            else:
                c = G[2]
            im.put(x, y, c)
    # scattered short blades for liveliness
    for bx in range(2, TILE, 6):
        ax = bx + int(noise(bx, 7, seed) * 4)
        ay = 4 + int(noise(bx, 11, seed) * 22)
        im.put(ax, ay, G[3])
        im.put(ax, ay - 1, G[4])
        im.put(ax + 1, ay, G[1])


def fill_tallgrass(im):
    """Distinct encounter tile: deeper/bluer base + a thicket of blades w/ bright tips."""
    for y in range(TILE):
        for x in range(TILE):
            n = noise(x, y, 9)
            base = TG[2] if n > 0.6 else (TG[0] if n < 0.25 else TG[1])
            # darker toward the bottom (roots in shadow) — symmetric, not directional
            if y > 24:
                base = lerp_c(base, TG[0], (y - 24) / 8.0)
            im.put(x, y, base)
    blades = [3, 7, 10, 14, 18, 21, 25, 29]
    for bx in blades:
        sway = int(noise(bx, 3, 9) * 3) - 1
        top = 7 + int(noise(bx, 5, 9) * 4)
        for y in range(top, 29):
            t = (y - top) / float(29 - top)
            x = bx + int(round(sway * (1 - t)))
            body = lerp_c(TG[2], G[2], t)
            im.put(x, y, body)
            im.put(x + 1, y, lerp_c(TG[1], TG[0], 0.4))
        im.put(bx + int(round(sway)), top, G[3])
        im.put(bx + int(round(sway)), top - 1, G[4])


def fill_dirt(im, seed=3):
    for y in range(TILE):
        for x in range(TILE):
            n = noise(x, y, seed)
            if n > 0.9:
                c = D[3]
            elif n > 0.7:
                c = D[2]
            elif n < 0.2:
                c = D[0]
            else:
                c = D[1]
            im.put(x, y, c)
    for _ in range(6):
        px = int(noise(_, 1, seed) * TILE)
        py = int(noise(_, 2, seed) * TILE)
        im.put(px, py, D[0])
        im.put(px + 1, py, D[3])


def fill_water(im, phase=0):
    for y in range(TILE):
        for x in range(TILE):
            band = (y + phase) % 8
            base = WAT[1] if band < 4 else WAT[2]
            n = noise(x, y, 5)
            if n < 0.15:
                base = WAT[0]
            im.put(x, y, base)
    # ripple highlights (shift with phase for the shimmer animation)
    for ry in range(3 + phase % 4, TILE, 7):
        for x in range(0, TILE):
            if noise(x, ry, 6 + phase) > 0.55:
                im.put(x, ry, WAT[3])
                if noise(x, ry, 9) > 0.85:
                    im.put(x, ry, WAT[4])


# --- grass <-> X autotile edge set ------------------------------------------ #
# Each edge tile = base X terrain with grass painted back over the neighbouring
# band(s), with an irregular (seamless, local-coord-jittered) boundary + a small
# embankment rim.  `sides` is a subset of NSEW; `corner` carves a single quadrant.
def edge_threshold(local, jitter_seed):
    return 6 + int(noise(local, 17, jitter_seed) * 3)  # 6..8 px irregular band


def make_edge(fill_fn, sides, corner=None, foam=False, **kw):
    im = Img(TILE, TILE)
    fill_fn(im, **kw)
    grass = Img(TILE, TILE)
    fill_grass(grass, seed=1)

    def is_grass(x, y):
        if corner:
            cx = x if "W" in corner else (TILE - 1 - x)
            cy = y if "N" in corner else (TILE - 1 - y)
            # inner corner: grass only inside one rounded quadrant notch
            r = edge_threshold(min(cx, cy), 31)
            return cx < r and cy < r
        g = False
        if "N" in sides and y < edge_threshold(x, 1):
            g = True
        if "S" in sides and y >= TILE - edge_threshold(x, 2):
            g = True
        if "W" in sides and x < edge_threshold(y, 3):
            g = True
        if "E" in sides and x >= TILE - edge_threshold(y, 4):
            g = True
        return g

    for y in range(TILE):
        for x in range(TILE):
            if is_grass(x, y):
                im.put(x, y, grass.px and tuple(grass.px[grass._i(x, y):grass._i(x, y) + 4]))
    # rim: darken the terrain pixel just inside the boundary; lighten grass edge / foam
    for y in range(TILE):
        for x in range(TILE):
            here = is_grass(x, y)
            edge = here != is_grass(min(x + 1, TILE - 1), y) or here != is_grass(x, min(y + 1, TILE - 1)) \
                or here != is_grass(max(x - 1, 0), y) or here != is_grass(x, max(y - 1, 0))
            if not edge:
                continue
            if here:
                im.put(x, y, G[1])  # grass lip in shadow
            else:
                im.put(x, y, WAT[4] if foam else D[0])  # foam or dirt embankment
    return im


# --------------------------------------------------------------------------- #
# Town surfaces
# --------------------------------------------------------------------------- #
def fill_cobble(im, variant=0):
    im.rect(0, 0, TILE, TILE, S[0])  # mortar
    for ry, oy in enumerate(range(1, TILE, 8)):
        off = 4 if ry % 2 else 0
        for ox in range(-4 + off, TILE, 8):
            sx, sy, sw, sh = ox + 1, oy, 6, 6
            n = noise(ox, oy, 21 + variant)
            top = S[3] if n > 0.5 else S[2]
            im.rect(sx, sy, sw, sh, S[2])
            im.hline(sx, sy, sw, top)            # lit top edge
            im.hline(sx, sy + sh - 1, sw, S[1])  # shaded bottom
            im.put(sx + 1, sy + 1, S[4])         # tiny specular
    if variant:
        im.put(20, 6, S[1])
        im.put(21, 7, S[1])


def fill_brick(im):
    im.rect(0, 0, TILE, TILE, RF[0])  # mortar
    for ry, oy in enumerate(range(1, TILE, 8)):
        off = 8 if ry % 2 else 0
        for ox in range(-8 + off, TILE, 16):
            bx, by, bw, bh = ox + 1, oy, 14, 6
            im.rect(bx, by, bw, bh, RF[2])
            im.hline(bx, by, bw, RF[3])          # top-lit course
            im.hline(bx, by + bh - 1, bw, RF[1])
            for x in range(bx, bx + bw):
                if noise(x, by, 13) > 0.8:
                    im.put(x, by + 2, RF[1])


def tile_wall_window():
    im = Img(TILE, TILE)
    fill_brick(im)
    im.rect(8, 7, 16, 16, WD[1])     # frame
    im.rect(10, 9, 12, 12, CT[1])    # glass
    for y in range(9, 21):           # glass shading + sky reflection
        for x in range(10, 22):
            im.put(x, y, lerp_c(CT[2], CT[1], (y - 9) / 12.0))
    for k in range(0, 9):            # diagonal highlight streak
        im.put(11 + k, 19 - k, CREAM)
    im.vline(15, 9, 12, WD[1])       # muntins
    im.hline(10, 14, 12, WD[1])
    im.hline(8, 23, 16, WD[3])       # lit sill
    return im


def tile_wall_door():
    im = Img(TILE, TILE)
    fill_brick(im)
    im.rect(9, 6, 14, 25, WD[0])     # frame/arch
    im.rect(10, 8, 12, 23, WD[2])    # door body
    for x in (13, 17):               # planks
        im.vline(x, 8, 23, WD[1])
    im.hline(10, 8, 12, WD[3])       # top-lit
    im.rect(11, 9, 10, 3, WD[3])     # arched lintel highlight
    im.put(19, 19, GOLD)             # knob
    im.put(19, 20, RF[1])
    return im


def fill_roof(im, kind="c"):
    """Clay pantiles: vertical ribs (rounded, lit at the centre) broken into
    overlapping horizontal courses."""
    colw = 6
    for cx0 in range(0, TILE, colw):
        for x in range(cx0, min(cx0 + colw, TILE)):
            rel = x - cx0
            if rel == 0:
                c = RF[0]            # groove between ribs (deep shadow)
            elif rel == colw - 1:
                c = RF[1]
            elif rel in (2, 3):
                c = RF[3]            # lit crown of the rib
            else:
                c = RF[2]
            im.vline(x, 0, TILE, c)
    for oy in range(7, TILE, 8):     # course breaks: shadow lip + sheen of next course
        for x in range(TILE):
            im.put(x, oy, RF[0])
            im.put(x, oy + 1, RF[4] if (x % colw) in (2, 3) else RF[2])
    for x in range(TILE):            # top course sheen
        im.put(x, 0, RF[4] if (x % colw) in (2, 3) else RF[3])
    if kind == "l":
        im.vline(0, 0, TILE, RF[0]); im.vline(1, 0, TILE, RF[1])  # verge board
    if kind == "r":
        im.vline(TILE - 1, 0, TILE, RF[0]); im.vline(TILE - 2, 0, TILE, RF[1])
    if kind == "peak":               # ridge cap across the top
        im.rect(0, 0, TILE, 6, RF[1])
        im.hline(0, 0, TILE, RF[3]); im.hline(0, 1, TILE, RF[4])
        im.hline(0, 5, TILE, RF[0])
        for x in range(2, TILE, 6):
            im.vline(x, 0, 6, RF[0])


# --------------------------------------------------------------------------- #
# Props (transparent surround so they layer over terrain)
# --------------------------------------------------------------------------- #
def blob(im, cx, cy, rx, ry, body, shade, light, outline=True):
    for y in range(cy - ry - 1, cy + ry + 2):
        for x in range(cx - rx - 1, cx + rx + 2):
            if not (0 <= x < im.w and 0 <= y < im.h):
                continue
            d = ((x - cx) / (rx + 0.001)) ** 2 + ((y - cy) / (ry + 0.001)) ** 2
            if d <= 1.0:
                sht = (y - (cy - ry)) / (2.0 * ry)  # vertical form shade (symmetric, gentle)
                c = lerp_c(light, body, min(1.0, sht * 1.6)) if sht < 0.5 else lerp_c(body, shade, (sht - 0.5) * 1.4)
                im.put(x, y, c)
            elif outline and d <= 1.5:
                im.put(x, y, INK)


def tile_tree_canopy():
    im = Img(TILE, TILE)
    blob(im, 16, 18, 14, 12, F[2], F[1], F[3])
    blob(im, 10, 12, 8, 7, F[2], F[1], F[3])
    blob(im, 22, 12, 8, 7, F[2], F[1], F[3])
    blob(im, 16, 8, 8, 6, F[2], F[1], F[4])
    for _ in range(40):                 # leaf speckle + rim light
        x = int(noise(_, 1, 7) * TILE)
        y = int(noise(_, 2, 7) * 26)
        i = im._i(x, y)
        if im.px[i + 3]:
            im.put(x, y, F[4] if noise(_, 3, 7) > 0.5 else F[1])
    return im


def tile_tree_trunk():
    im = Img(TILE, TILE)
    fill_grass(im, seed=4)
    im.rect(12, 2, 8, 22, WD[1])        # trunk
    im.vline(13, 2, 22, WD[3])          # lit side
    im.vline(18, 2, 22, WD[0])          # shaded side
    for y in range(4, 22, 4):
        im.put(15, y, WD[0]); im.put(16, y + 1, WD[3])  # bark
    im.rect(10, 23, 12, 3, WD[0])       # roots
    im.put(9, 25, WD[1]); im.put(22, 25, WD[1])
    blob(im, 16, 28, 9, 3, *( (24, 18, 37, 60),)*1, (24,18,37,40), (24,18,37,70), outline=False)  # soft base shadow
    return im


def tile_bush():
    im = Img(TILE, TILE)
    blob(im, 16, 20, 11, 8, F[2], F[1], F[3])
    blob(im, 11, 17, 6, 5, F[2], F[1], F[3])
    blob(im, 21, 17, 6, 5, F[2], F[1], F[4])
    for c, x, y in ((RED, 12, 16), (GOLD, 20, 15), (RED, 16, 20)):
        im.put(x, y, c); im.put(x + 1, y, CREAM)
    return im


def tile_rock():
    im = Img(TILE, TILE)
    blob(im, 16, 20, 11, 8, S[2], S[1], S[3])
    im.hline(8, 13, 16, S[4])           # lit crown
    im.put(11, 22, S[0]); im.put(20, 23, S[0])  # cracks
    im.put(10, 15, G[3]); im.put(22, 17, G[3])  # moss specks
    return im


def tile_stump():
    im = Img(TILE, TILE)
    fill_grass(im, seed=6)
    blob(im, 16, 19, 9, 6, WD[1], WD[0], WD[3])
    blob(im, 16, 16, 7, 4, WD[2], WD[1], WD[3], outline=False)  # top face (rings)
    blob(im, 16, 16, 4, 2, WD[3], WD[2], WD[4], outline=False)
    im.put(16, 16, WD[1])
    return im


def tile_barrel():
    im = Img(TILE, TILE)
    im.rect(10, 8, 12, 20, WD[2])
    im.vline(10, 8, 20, WD[0]); im.vline(21, 8, 20, WD[0])
    im.vline(11, 8, 20, WD[3]); im.vline(20, 8, 20, WD[1])
    for x in range(12, 20, 2):
        im.vline(x, 8, 20, WD[1])
    for y in (9, 17, 26):               # iron hoops
        im.hline(10, y, 12, S[1]); im.hline(10, y - 1, 12, S[3])
    im.rect(11, 7, 10, 2, WD[3])        # lid
    return im


def tile_fence_h():
    im = Img(TILE, TILE)
    for ry in (10, 18):                 # two rails
        im.rect(0, ry, TILE, 4, WD[2])
        im.hline(0, ry, TILE, WD[3]); im.hline(0, ry + 3, TILE, WD[0])
    for px in (4, 20):                  # posts
        im.rect(px, 4, 5, 24, WD[1])
        im.vline(px, 4, 24, WD[3]); im.vline(px + 4, 4, 24, WD[0])
        im.hline(px, 4, 5, WD[3])
    return im


def tile_fence_post():
    im = Img(TILE, TILE)
    im.rect(12, 3, 7, 26, WD[1])
    im.vline(12, 3, 26, WD[3]); im.vline(18, 3, 26, WD[0])
    im.hline(12, 3, 7, WD[3])
    im.rect(11, 2, 9, 2, WD[2])         # cap
    return im


def tile_sign():
    im = Img(TILE, TILE)
    im.rect(14, 16, 4, 14, WD[1])       # post
    im.vline(14, 16, 14, WD[3])
    im.rect(5, 6, 22, 13, WD[2])        # board
    im.rect(5, 6, 22, 2, WD[3])
    im.rect(5, 17, 22, 2, WD[0])
    im.vline(5, 6, 13, WD[3]); im.vline(26, 6, 13, WD[0])
    for ly, lw in ((10, 14), (13, 16)): # "text"
        im.hline(8, ly, lw, WD[0])
    return im


def tile_flowers(color):
    im = Img(TILE, TILE)
    fill_grass(im, seed=8)
    spots = [(7, 10), (22, 8), (12, 22), (25, 24), (17, 15)]
    for (x, y) in spots:
        im.put(x, y - 2, G[1]); im.put(x, y - 1, G[1])   # stem
        for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            im.put(x + dx, y + dy, color)
        im.put(x, y, CREAM if color is RED else GOLD)
    return im


def tile_grass_var(kind):
    im = Img(TILE, TILE)
    fill_grass(im, seed=2 if kind == 1 else 5)
    if kind == 1:                       # extra tufts
        for bx in (6, 14, 23):
            im.put(bx, 12, G[3]); im.put(bx, 11, G[4]); im.put(bx + 1, 12, G[1])
            im.put(bx - 1, 13, G[3])
    else:                               # pebbles
        for (x, y) in ((8, 18), (19, 22), (24, 12)):
            im.put(x, y, S[2]); im.put(x + 1, y, S[3]); im.put(x, y + 1, S[1])
    return im


# --------------------------------------------------------------------------- #
# Hero — 3/4 view tamer/ranger.  4 facings x {idle, walkA, mid, walkB, jump}.
# legphase: 0 neutral, +1 right-leg lead, -1 left-leg lead.  bob raises body.
# --------------------------------------------------------------------------- #
def draw_hero(facing, legphase, bob, jump=False):
    im = Img(TILE, TILE)
    cx = 16
    top = 4 - bob - (3 if jump else 0)

    # soft contact shadow (kept subtle so a future light pass dominates)
    sr = 5 if jump else 8
    for x in range(cx - sr, cx + sr):
        for y in range(28, 31):
            d = ((x - cx) / sr) ** 2 + ((y - 29) / 2.0) ** 2
            if d <= 1.0:
                im.put(x, y, SHADOW)

    def body_block(x, y, w, h, ramp, lit="L"):
        """Filled block with selective outline + a lit and a shaded vertical edge."""
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                im.put(xx, yy, ramp[1])
        edgeL, edgeR = (ramp[2], ramp[0]) if lit == "L" else (ramp[0], ramp[2])
        im.vline(x, y, h, edgeL)
        im.vline(x + w - 1, y, h, edgeR)
        im.hline(x, y, w, ramp[2 if lit == "L" else 1])

    legy = 23 - (3 if jump else 0)
    if facing in ("S", "N"):
        # ---- legs / boots ----
        loff = 0 if jump else legphase
        for side, dx in ((-1, -3), (1, 2)):
            step = loff if side == 1 else -loff
            ly = legy - (1 if step > 0 else 0)
            im.rect(cx + dx, ly, 4, 4 + (1 if jump else 0), PT[1])
            im.vline(cx + dx, ly, 5, PT[2])
            im.rect(cx + dx, ly + 4, 4, 2, BOOT[1])      # boot
            im.hline(cx + dx, ly + 5, 4, BOOT[0])
        # ---- coat / torso ----
        body_block(cx - 6, top + 9, 12, 9, CT)
        # satchel strap (diagonal) + bag
        for k in range(9):
            im.put(cx - 5 + k, top + 9 + k, LT[1])
        im.rect(cx + 3, top + 14, 5, 5, LT[2])
        im.hline(cx + 3, top + 14, 5, LT[3]); im.put(cx + 5, top + 16, LT[1])
        # arms
        im.rect(cx - 7, top + 10, 2, 6, CT[2]); im.rect(cx + 5, top + 10, 2, 6, CT[0])
        im.rect(cx - 7, top + 16, 2, 2, SK[1]); im.rect(cx + 5, top + 16, 2, 2, SK[1])
        # ---- scarf ----
        im.rect(cx - 5, top + 7, 10, 3, SC[1])
        im.hline(cx - 5, top + 7, 10, SC[2])
        if facing == "S":
            im.rect(cx + 2, top + 9, 2, 5, SC[1]); im.put(cx + 2, top + 13, SC[0])  # trailing end
        # ---- head ----
        for yy in range(top + 1, top + 8):
            for xx in range(cx - 4, cx + 4):
                im.put(xx, yy, SK[2])
        im.vline(cx - 4, top + 1, 7, SK[1]); im.vline(cx + 3, top + 1, 7, SK[1])
        if facing == "S":
            im.put(cx - 2, top + 4, INK); im.put(cx + 1, top + 4, INK)     # eyes
            im.put(cx - 2, top + 3, CREAM); im.put(cx + 1, top + 3, CREAM)
            im.put(cx, top + 6, SK[1])                                      # mouth/chin
            im.rect(cx - 4, top + 6, 2, 2, HR[1]); im.rect(cx + 2, top + 6, 2, 2, HR[1])  # sideburns
        else:
            # back of head: rounded hair mass + centre part + ear hints + tapered neck
            for yy in range(top + 1, top + 8):
                for xx in range(cx - 4, cx + 4):
                    if yy >= top + 6 and (xx == cx - 4 or xx == cx + 3):
                        continue                                            # round lower corners
                    im.put(xx, yy, HR[1])
            im.hline(cx - 3, top + 1, 6, HR[2])                            # crown sheen
            im.vline(cx - 1, top + 2, 4, HR[2]); im.put(cx, top + 3, HR[0])  # centre part
            im.put(cx - 5, top + 4, SK[1]); im.put(cx + 4, top + 4, SK[1])  # ears poke out
            im.rect(cx - 2, top + 7, 4, 2, SK[2])                          # tapered neck
            im.rect(cx - 3, top + 8, 6, 2, SC[1])                          # scarf knot at nape
        # ---- cap ----
        im.rect(cx - 5, top - 1, 10, 3, CT[1])
        im.hline(cx - 5, top - 1, 10, CT[3])
        im.rect(cx - 4, top - 3, 8, 2, CT[1]); im.hline(cx - 4, top - 3, 8, CT[2])
        im.hline(cx - 5, top + 1, 10, SC[1])                              # rust band
        if facing == "S":
            im.rect(cx - 6, top + 1, 4, 2, CT[0])                         # brim toward camera
            im.hline(cx - 6, top + 1, 4, CT[2])
    else:
        # ---- side profile (East; West = horizontal flip later) ----
        d = 1
        loff = 0 if jump else legphase
        # legs (front/back stride)
        for ph, dx in ((loff, 1), (-loff, -2)):
            ly = legy
            im.rect(cx + dx, ly, 4, 5, PT[1])
            im.vline(cx + dx, ly, 5, PT[2])
            im.rect(cx + dx + (1 if ph >= 0 else -1), ly + 5, 5, 2, BOOT[1])  # boot points forward
            im.hline(cx + dx + (1 if ph >= 0 else -1), ly + 6, 5, BOOT[0])
        # coat
        body_block(cx - 4, top + 9, 9, 9, CT)
        im.vline(cx + 4, top + 9, 9, CT[3])     # lit front
        # satchel on near hip + strap
        im.rect(cx - 6, top + 13, 4, 5, LT[2]); im.hline(cx - 6, top + 13, 4, LT[3])
        for k in range(8):
            im.put(cx - 4 + k * d, top + 9 + k, LT[1])
        # forward arm
        im.rect(cx + 2, top + 11, 2, 6, CT[2]); im.rect(cx + 2, top + 17, 2, 2, SK[2])
        # scarf trailing back
        im.rect(cx - 4, top + 7, 8, 3, SC[1]); im.hline(cx - 4, top + 7, 8, SC[2])
        im.rect(cx - 7, top + 8, 3, 2, SC[1]); im.put(cx - 7, top + 10, SC[0])
        # head (profile)
        for yy in range(top + 1, top + 8):
            for xx in range(cx - 3, cx + 5):
                im.put(xx, yy, SK[2])
        im.rect(cx - 3, top + 1, 3, 7, HR[1])           # hair at back
        im.put(cx + 4, top + 4, INK)                    # eye
        im.put(cx + 4, top + 3, CREAM)
        im.put(cx + 5, top + 5, SK[1])                  # nose
        im.put(cx + 4, top + 6, SK[1])                  # mouth
        # cap with forward brim
        im.rect(cx - 4, top - 1, 9, 3, CT[1]); im.hline(cx - 4, top - 1, 9, CT[3])
        im.rect(cx - 3, top - 3, 7, 2, CT[1]); im.hline(cx - 3, top - 3, 7, CT[2])
        im.hline(cx - 4, top + 1, 9, SC[1])             # band
        im.rect(cx + 5, top + 1, 4, 2, CT[0]); im.hline(cx + 5, top + 1, 4, CT[2])  # brim forward
    return im


def hflip(src):
    out = Img(src.w, src.h)
    for y in range(src.h):
        for x in range(src.w):
            i = src._i(x, y)
            if src.px[i + 3]:
                out.put(src.w - 1 - x, y, tuple(src.px[i:i + 4]))
    return out


# --------------------------------------------------------------------------- #
# Creature — "Emberkit": small amber fox-kit.  facing in {S,N,E}; W = flip(E).
# col in {idle, walk0, walk1}.  legphase shifts paws; bob raises the body 1px.
# --------------------------------------------------------------------------- #
def _ear(im, tipx, basey, h, lean, col):
    for i in range(h):
        w = max(1, h - i)
        x0 = tipx - w // 2 + int(round(lean * i / max(1, h)))
        im.hline(x0, basey - i, w, col)
        im.put(x0, basey - i, lerp_c(col, INK, 0.45))           # outline edge
        im.put(x0 + w - 1, basey - i, lerp_c(col, INK, 0.45))
    im.put(tipx, basey - h + 1, MEAR)                           # inner-ear blush


def _eye(im, x, y):
    im.rect(x, y, 2, 2, INK)        # round dark "button" eye
    im.put(x, y, CREAM)             # top-left catchlight (sparkle)


def draw_monster(facing, col):
    im = Img(TILE, TILE)
    b = 1 if col == "walk0" else 0                              # body bob
    lp = {"idle": 0, "walk0": 1, "walk1": -1}[col]
    cx = 16
    # soft contact shadow
    for x in range(cx - 8, cx + 9):
        for y in range(27, 30):
            if ((x - cx) / 8.0) ** 2 + ((y - 28) / 1.6) ** 2 <= 1.0:
                im.put(x, y, SHADOW)

    if facing == "S":
        blob(im, 9, 21 - b, 4, 5, MFUR[1], MFUR[0], MFUR[3])    # tail (curl, behind)
        im.put(9, 17 - b, GOLD); im.put(9, 16 - b, MBEL[2])     # tail tip
        for dx, ph in ((-4, lp), (4, -lp)):                     # back paws
            im.rect(cx + dx, 26 - b + (1 if ph > 0 else 0), 3, 3, MPAW[1])
            im.hline(cx + dx, 26 - b + (1 if ph > 0 else 0), 3, MPAW[2])
        blob(im, cx, 22 - b, 8, 6, MFUR[2], MFUR[0], MFUR[3])   # body
        blob(im, cx, 24 - b, 4, 3, MBEL[1], MBEL[0], MBEL[2], outline=False)  # belly
        blob(im, cx, 14 - b, 8, 7, MFUR[2], MFUR[0], MFUR[3])   # head
        _ear(im, cx - 6, 9 - b, 5, -1, MFUR[1])
        _ear(im, cx + 6, 9 - b, 5, 1, MFUR[1])
        im.put(cx, 8 - b, GOLD); im.put(cx, 9 - b, MBEL[2])     # forehead tuft
        _eye(im, cx - 4, 13 - b); _eye(im, cx + 2, 13 - b)
        blob(im, cx, 17 - b, 3, 2, MBEL[1], MBEL[0], MBEL[2], outline=False)  # muzzle
        im.put(cx, 16 - b, INK)                                 # nose
    elif facing == "N":
        blob(im, cx, 13 - b, 4, 5, MFUR[1], MFUR[0], MFUR[3])   # tail up the back
        im.put(cx, 8 - b, GOLD); im.put(cx, 9 - b, MBEL[2])
        for dx, ph in ((-4, lp), (4, -lp)):
            im.rect(cx + dx, 26 - b + (1 if ph > 0 else 0), 3, 3, MPAW[1])
        blob(im, cx, 22 - b, 8, 6, MFUR[2], MFUR[0], MFUR[3])   # body (back)
        im.vline(cx, 18 - b, 8, MFUR[1])                        # spine shade
        blob(im, cx, 15 - b, 8, 6, MFUR[2], MFUR[0], MFUR[3])   # head (back)
        _ear(im, cx - 6, 10 - b, 5, -1, MFUR[1])
        _ear(im, cx + 6, 10 - b, 5, 1, MFUR[1])
        im.put(cx - 6, 11 - b, INK); im.put(cx + 6, 11 - b, INK)
    else:  # E (side)
        blob(im, 8, 19 - b, 4, 5, MFUR[1], MFUR[0], MFUR[3])    # tail curling up-back
        im.put(7, 14 - b, GOLD); im.put(8, 13 - b, MBEL[2])
        for dx, ph in ((-3, lp), (6, -lp)):                     # back then front legs
            im.rect(cx + dx, 25 - b, 3, 4 + (1 if ph < 0 else 0), MPAW[1])
            im.hline(cx + dx, 25 - b, 3, MPAW[2])
        blob(im, cx, 22 - b, 9, 6, MFUR[2], MFUR[0], MFUR[3])   # body
        blob(im, cx + 2, 25 - b, 5, 2, MBEL[1], MBEL[0], MBEL[2], outline=False)  # belly
        blob(im, cx + 6, 16 - b, 6, 6, MFUR[2], MFUR[0], MFUR[3])  # head (right)
        _ear(im, cx + 4, 10 - b, 5, -1, MFUR[1])
        _eye(im, cx + 8, 15 - b)
        blob(im, cx + 10, 18 - b, 2, 2, MBEL[1], MBEL[0], MBEL[2], outline=False)  # snout
        im.put(cx + 11, 18 - b, INK)                            # nose
    return im


def build_monster():
    facings = ["down", "up", "right", "left"]
    cols = ["idle", "walk0", "walk1"]
    sheet = Img(3 * TILE, 4 * TILE)
    frames, cells = {}, []
    for r, face in enumerate(facings):
        for c, col in enumerate(cols):
            fc = {"down": "S", "up": "N", "right": "E", "left": "E"}[face]
            cell = draw_monster(fc, col)
            if face == "left":
                cell = hflip(cell)
            ox, oy = c * TILE, r * TILE
            sheet.blit(cell, ox, oy)
            frames[f"mon_{face}_{col}"] = (ox, oy)
            cells.append((f"mon_{face}_{col}", ox, oy, cell))
    write_png(os.path.join(OUT, "monster-emberkit.png"), sheet)
    write_png(os.path.join(PREVIEW, "monster@6x.png"), upscale(sheet, 6))
    animations = {}
    for face in facings:
        animations[f"walk_{face}"] = [f"mon_{face}_walk0", f"mon_{face}_walk1"]
        animations[f"idle_{face}"] = [f"mon_{face}_idle"]
    write_sheet_json(os.path.join(OUT, "monster-emberkit.json"),
                     "monster-emberkit.png", sheet.w, sheet.h, frames, animations)

    nsheet = build_normal_sheet(cells, lambda _n: "hero")  # alpha sprite: bevel + relief
    write_png(os.path.join(OUT, "monster-emberkit-normal.png"), nsheet)
    write_png(os.path.join(PREVIEW, "monster-normal@6x.png"), upscale(nsheet, 6))
    write_png(os.path.join(PREVIEW, "monster-lit@6x.png"), upscale(light_sheet(sheet, nsheet), 6))
    write_sheet_json(os.path.join(OUT, "monster-emberkit-normal.json"),
                     "monster-emberkit-normal.png", nsheet.w, nsheet.h, frames, animations)
    return sheet


# --------------------------------------------------------------------------- #
# Sheet assembly
# --------------------------------------------------------------------------- #
def build_hero():
    cols = ["idle", "stepA", "mid", "stepB", "jump"]
    facings = ["down", "up", "right", "left"]
    sheet = Img(5 * TILE, 4 * TILE)
    frames = {}
    cells = []
    for r, face in enumerate(facings):
        for c, col in enumerate(cols):
            fc = {"down": "S", "up": "N", "right": "E", "left": "E"}[face]
            phase = {"idle": 0, "stepA": 1, "mid": 0, "stepB": -1, "jump": 0}[col]
            bob = 1 if col in ("stepA", "stepB") else 0
            jump = col == "jump"
            cell = draw_hero(fc, phase, bob, jump=jump)
            if face == "left":
                cell = hflip(cell)
            ox, oy = c * TILE, r * TILE
            sheet.blit(cell, ox, oy)
            frames[f"hero_{face}_{col}"] = (ox, oy)
            cells.append((f"hero_{face}_{col}", ox, oy, cell))
    write_png(os.path.join(OUT, "hero.png"), sheet)
    write_png(os.path.join(PREVIEW, "hero@6x.png"), upscale(sheet, 6))

    def walk(face):
        return [f"hero_{face}_stepA", f"hero_{face}_idle", f"hero_{face}_stepB", f"hero_{face}_mid"]

    animations = {}
    for face in facings:
        animations[f"walk_{face}"] = walk(face)
        animations[f"idle_{face}"] = [f"hero_{face}_idle"]
    write_sheet_json(
        os.path.join(OUT, "hero.json"), "hero.png", sheet.w, sheet.h, frames, animations,
    )

    # normal map (same frame layout; meta.image -> the normal png)
    nsheet = build_normal_sheet(cells, lambda _n: "hero")
    write_png(os.path.join(OUT, "hero-normal.png"), nsheet)
    write_png(os.path.join(PREVIEW, "hero-normal@6x.png"), upscale(nsheet, 6))
    write_png(os.path.join(PREVIEW, "hero-lit@6x.png"), upscale(light_sheet(sheet, nsheet), 6))
    write_sheet_json(
        os.path.join(OUT, "hero-normal.json"), "hero-normal.png", nsheet.w, nsheet.h, frames, animations,
    )
    return sheet


def build_tileset():
    # 8 columns; catalogue order defines the grid.
    catalog = []

    def add(name, im):
        catalog.append((name, im))

    # row 0 — grass + decals
    g = Img(TILE, TILE); fill_grass(g, 0); add("grass", g)
    add("grass_tuft", tile_grass_var(1))
    add("grass_pebbles", tile_grass_var(2))
    tg = Img(TILE, TILE); fill_tallgrass(tg); add("tall_grass", tg)
    add("flowers_red", tile_flowers(RED))
    add("flowers_gold", tile_flowers(GOLD))
    add("bush", tile_bush())
    add("rock", tile_rock())

    # rows 1-2 — grass<->dirt path autotile (13: center, 4 edge, 4 outer, 4 inner)
    pc = Img(TILE, TILE); fill_dirt(pc); add("path_c", pc)
    add("path_n", make_edge(fill_dirt, "N"))
    add("path_s", make_edge(fill_dirt, "S"))
    add("path_e", make_edge(fill_dirt, "E"))
    add("path_w", make_edge(fill_dirt, "W"))
    add("path_ne", make_edge(fill_dirt, "NE"))
    add("path_nw", make_edge(fill_dirt, "NW"))
    add("path_se", make_edge(fill_dirt, "SE"))
    add("path_sw", make_edge(fill_dirt, "SW"))
    add("path_inner_ne", make_edge(fill_dirt, "", corner="NE"))
    add("path_inner_nw", make_edge(fill_dirt, "", corner="NW"))
    add("path_inner_se", make_edge(fill_dirt, "", corner="SE"))
    add("path_inner_sw", make_edge(fill_dirt, "", corner="SW"))

    # rows 2-4 — grass<->water edge (center + 4 edge + 4 outer + 2 shimmer frames)
    w0 = Img(TILE, TILE); fill_water(w0, 0); add("water_c", w0)
    w1 = Img(TILE, TILE); fill_water(w1, 2); add("water_c2", w1)  # shimmer frame 2
    add("water_n", make_edge(fill_water, "N", foam=True))
    add("water_s", make_edge(fill_water, "S", foam=True))
    add("water_e", make_edge(fill_water, "E", foam=True))
    add("water_w", make_edge(fill_water, "W", foam=True))
    add("water_ne", make_edge(fill_water, "NE", foam=True))
    add("water_nw", make_edge(fill_water, "NW", foam=True))
    add("water_se", make_edge(fill_water, "SE", foam=True))
    add("water_sw", make_edge(fill_water, "SW", foam=True))

    # town surfaces
    cb = Img(TILE, TILE); fill_cobble(cb, 0); add("cobble", cb)
    cb2 = Img(TILE, TILE); fill_cobble(cb2, 1); add("cobble_var", cb2)
    wl = Img(TILE, TILE); fill_brick(wl); add("wall_brick", wl)
    add("wall_window", tile_wall_window())
    add("wall_door", tile_wall_door())
    rl = Img(TILE, TILE); fill_roof(rl, "l"); add("roof_l", rl)
    rc = Img(TILE, TILE); fill_roof(rc, "c"); add("roof_c", rc)
    rr = Img(TILE, TILE); fill_roof(rr, "r"); add("roof_r", rr)
    rp = Img(TILE, TILE); fill_roof(rp, "peak"); add("roof_peak", rp)

    # props
    add("fence_h", tile_fence_h())
    add("fence_post", tile_fence_post())
    add("sign", tile_sign())
    add("tree_canopy", tile_tree_canopy())
    add("tree_trunk", tile_tree_trunk())
    add("stump", tile_stump())
    add("barrel", tile_barrel())

    cols = 8
    rows = (len(catalog) + cols - 1) // cols
    sheet = Img(cols * TILE, rows * TILE)
    frames = {}
    cells = []
    for idx, (name, im) in enumerate(catalog):
        ox, oy = (idx % cols) * TILE, (idx // cols) * TILE
        sheet.blit(im, ox, oy)
        frames[name] = (ox, oy)
        cells.append((name, ox, oy, im))
    write_png(os.path.join(OUT, "tileset-edge-of-town.png"), sheet)
    write_png(os.path.join(PREVIEW, "tileset@6x.png"), upscale(sheet, 6))
    animations = {"water_shimmer": ["water_c", "water_c2"]}
    write_sheet_json(
        os.path.join(OUT, "tileset-edge-of-town.json"),
        "tileset-edge-of-town.png", sheet.w, sheet.h, frames, animations,
    )

    def prof_for(name):
        if name == "tall_grass":
            return "tall"
        if name.startswith("water"):
            return "water"
        if name in ("cobble", "cobble_var", "wall_brick", "wall_window", "wall_door"):
            return "brick"
        if name.startswith("roof"):
            return "roof"
        if name in ("bush", "rock", "barrel", "fence_h", "fence_post", "sign", "tree_canopy"):
            return "prop"
        if name in ("tree_trunk", "stump"):
            return "object"
        return "terrain"  # grass*, flowers*, path*

    nsheet = build_normal_sheet(cells, prof_for)
    write_png(os.path.join(OUT, "tileset-edge-of-town-normal.png"), nsheet)
    write_png(os.path.join(PREVIEW, "tileset-normal@6x.png"), upscale(nsheet, 6))
    write_png(os.path.join(PREVIEW, "tileset-lit@6x.png"), upscale(light_sheet(sheet, nsheet), 6))
    write_sheet_json(
        os.path.join(OUT, "tileset-edge-of-town-normal.json"),
        "tileset-edge-of-town-normal.png", sheet.w, sheet.h, frames, animations,
    )
    return sheet, len(catalog)


def write_sheet_json(path, image, w, h, frames, animations):
    """PixiJS v8 spritesheet (hash) format, 2-space JSON (biome-clean)."""
    lines = ["{", '  "frames": {']
    keys = list(frames.keys())
    for i, k in enumerate(keys):
        ox, oy = frames[k]
        comma = "," if i < len(keys) - 1 else ""
        lines.append(
            f'    "{k}": {{ "frame": {{ "x": {ox}, "y": {oy}, "w": {TILE}, "h": {TILE} }}, '
            f'"sourceSize": {{ "w": {TILE}, "h": {TILE} }}, '
            f'"spriteSourceSize": {{ "x": 0, "y": 0, "w": {TILE}, "h": {TILE} }} }}{comma}'
        )
    lines.append("  },")
    lines.append('  "animations": {')
    akeys = list(animations.keys())
    for i, k in enumerate(akeys):
        arr = ", ".join(f'"{f}"' for f in animations[k])
        comma = "," if i < len(akeys) - 1 else ""
        lines.append(f'    "{k}": [{arr}]{comma}')
    lines.append("  },")
    lines.append('  "meta": {')
    lines.append(f'    "image": "{image}",')
    lines.append('    "format": "RGBA8888",')
    lines.append('    "scale": 1,')
    lines.append(f'    "size": {{ "w": {w}, "h": {h} }}')
    lines.append("  }")
    lines.append("}")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")


def build_palette():
    sw = 16
    im = Img(sw * 5 + 2, len(PALETTE_ROWS) * sw + 2)
    for r, ramp in enumerate(PALETTE_ROWS):
        for c, col in enumerate(ramp):
            im.rect(1 + c * sw, 1 + r * sw, sw, sw, col)
    write_png(os.path.join(OUT, "palette.png"), im)


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(PREVIEW, exist_ok=True)
    build_palette()
    hero = build_hero()
    tiles, n = build_tileset()
    mon = build_monster()
    print(f"hero.png  + hero-normal.png             {hero.w}x{hero.h}  (20 frames)")
    print(f"tileset.png + tileset-...-normal.png    {tiles.w}x{tiles.h}  ({n} tiles)")
    print(f"monster-emberkit.png + -normal.png      {mon.w}x{mon.h}  (12 frames)")
    print(f"-> {OUT}")
    print(f"-> previews (albedo / normal / lit) in {PREVIEW}")


if __name__ == "__main__":
    main()
