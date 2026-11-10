import { createHash } from 'node:crypto';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import {
  type Dir,
  DPAD_BUTTON,
  dpadWalkPath,
  dpadWalkTo,
  oppositeDir,
  pressButton,
  readWorld,
  safePath,
  safeTile,
  stepTile,
  type Tile,
} from './controls';

// world-art.spec.ts — wap-10 (M-world-art-pass): the integrated world-art whole. WAP10.1 (the kit
// terrain and the heal landmark are DRAWN in zone 0), WAP10.2 (the warp marker is drawn, and the
// warp lands in Tideglass Cove with its own water-rich terrain), WAP10.3 (the post stack is on at
// the live `day` keyframe and really filters the frame).
//
// EVIDENCE LABEL: real client + real server + real wasm + real Pixi + software GL. One player, one
// page, one flow (the three tests share the world and run in order). The player walks ONLY with
// the live-bound D-pad keys (`dpadWalkPath`); a page-side counter on `__game().step` / `jump`
// proves no test shortcut moved it. Reduced motion is on, so water, the warp pulse and the godray
// time are frozen and two frames of one still scene are comparable.
//
// WHAT THE PAGE REPORTS. `__game().art` is the renderer's account of what it DREW (DEV hook, wap-10
// contract): terrain kind, the kit frame per tile, the drawn landmarks and warp markers with their
// CSS-px rects, the passes attached to the world layer with the grading keyframe, and the terrain
// histogram. Its claims are cross-checked against independent evidence: the histogram against the
// per-class counts of `art.frames` (and the authoritative zone map), the rects against the pixels
// of a real screenshot.
//
// READING OF WAP10.3 (flagged): the LIVE game keeps the post stack OFF (docs/DECISIONS.md, the
// pixi-filters entry). The DEV hook `__game().setPostStack(toggles)` turns the full stack on right
// after join; the test never sets a keyframe, so `post.keyframe === 'day'` is the live default.
//
// PIXEL RULE. A sampled rect must differ from a same-class ground tile by a per-channel
// threshold in at least LAND_MIN of its pixels AND by clearly more than two same-class ground tiles
// differ from each other (the noise floor: the vignette and godray vary brightness by screen
// position, and the kit has three variants per class). No character may overlap either rect and
// the topmost DOM element at the rect must be the canvas.

const VIEWPORT = { width: 1280, height: 720 } as const;
const FULL_STACK = ['lightmap', 'bloom', 'godray', 'lut'] as const;
const STACK_ON = { lightmap: true, bloom: true, godray: true, lut: true } as const;
const STACK_OFF = { lightmap: false, bloom: false, godray: false, lut: false } as const;
type Toggles = Record<(typeof FULL_STACK)[number], boolean>;

/** Per-channel difference (0..255) that counts a pixel as different. */
const CHANNEL_THRESH = 24;
/** The share of a sampled rect's pixels that must differ from a ground tile. */
const LAND_MIN = 0.3;
/** The same floor for the warp marker, a decal covering less of its tile (measured 0.293). */
const WARP_MIN = 0.15;
/** How far above the same-class ground-vs-ground noise the sampled share must sit. */
const NOISE_MARGIN = 0.2;
/** The share of the whole frame that must change when the stack goes off (any value above the
 *  non-vacuity floor of a few moving NPCs; lookdev's WAP9.5 measured ~0.9 for the full stack). */
const STACK_FRAME_MIN = 0.1;
// Measured: the day keyframe is a light warm lift, so the full stack moves 0.217 of the frame
// (199708 of 921600 pixels by >= 24 per channel). An unattached stack reads ~0.
/** A tile of zone 0 and of zone 1 the flow names (Verdant Hollow, plan facts). */
const HEAL: Tile = { x: 8, y: 3 };
const WARP: Tile = { x: 1, y: 5 };

interface ScreenRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ArtDescription {
  zoneId: number;
  terrain: 'kit' | 'fallback';
  frames: readonly (string | null)[];
  width: number;
  height: number;
  landmarks: readonly { kind: 'heal'; x: number; y: number; frame: string; rect: ScreenRect }[];
  warpMarkers: readonly { x: number; y: number; frame: string; rect: ScreenRect }[];
  post: { passes: readonly string[]; keyframe: string };
  histogram: Readonly<Record<string, number>>;
}

interface ArtChar {
  entityId: string;
  tileX: number;
  tileY: number;
}

interface ArtHook {
  art: ArtDescription | null | undefined;
  characters: ArtChar[];
  ownEntityId: string | null;
  ownAuthTile: Tile | null;
  map: {
    zone_id: number;
    width: number;
    height: number;
    terrain?: readonly string[];
    warps?: readonly { from: Tile; to_zone: number; to_tile: Tile }[];
    landmarks?: readonly { kind: string; x: number; y: number }[];
  };
  identity: string;
  setPostStack: (toggles: Toggles) => void;
}

type ArtWindow = {
  __game?: () => ArtHook;
  __dpadStepCalls?: number;
};

// ---------------------------------------------------------------------------------------------
// page reads
// ---------------------------------------------------------------------------------------------

const readArt = (page: Page): Promise<ArtDescription | null> =>
  page.evaluate(() => {
    const hook = (window as unknown as ArtWindow).__game;
    if (hook === undefined) throw new Error('readArt: window.__game is missing (DEV build only)');
    const art = hook().art;
    return art === undefined || art === null ? null : JSON.parse(JSON.stringify(art));
  });

/** The art description, failing (never skipping) when the hook reports none. */
async function needArt(page: Page, label: string): Promise<ArtDescription> {
  const art = await readArt(page);
  if (art === null) {
    throw new Error(`${label}: __game().art is null/undefined (the renderer reports no art)`);
  }
  return art;
}

const readChars = (page: Page): Promise<{ chars: ArtChar[]; own: string | null }> =>
  page.evaluate(() => {
    const g = (window as unknown as { __game: () => ArtHook }).__game();
    return {
      chars: g.characters.map((c) => ({ entityId: c.entityId, tileX: c.tileX, tileY: c.tileY })),
      own: g.ownEntityId,
    };
  });

const stepCalls = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as ArtWindow).__dpadStepCalls ?? -1);

/** Wraps `window.__game` so a call to the snapshot's `step` or `jump` bumps a page counter. */
async function installStepCounter(page: Page): Promise<void> {
  const wrapped = await page.evaluate(() => {
    const w = window as unknown as {
      __game: () => object;
      __dpadStepCalls?: number;
    };
    const original = w.__game;
    w.__dpadStepCalls = 0;
    w.__game = () =>
      new Proxy(original(), {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if ((prop === 'step' || prop === 'jump') && typeof value === 'function') {
            return (...args: unknown[]) => {
              w.__dpadStepCalls = (w.__dpadStepCalls ?? 0) + 1;
              return value.apply(target, args);
            };
          }
          return value;
        },
      });
    return w.__game !== original;
  });
  expect(wrapped, 'the step/jump counter must be installed on window.__game').toBe(true);
}

const expectNoStepCalls = async (page: Page, label: string): Promise<void> => {
  expect(
    await stepCalls(page),
    `${label}: the walk used __game().step/jump (the D-pad must be the only mover)`,
  ).toBe(0);
};

/** Turns a post-stack toggle set on through the DEV hook (fails clearly when it is absent). */
const setStack = (page: Page, toggles: Toggles): Promise<void> =>
  page.evaluate((t) => {
    const g = (window as unknown as { __game: () => ArtHook }).__game();
    if (typeof g.setPostStack !== 'function') {
      throw new Error('__game().setPostStack is missing (the wap-10 DEV test hook)');
    }
    g.setPostStack(t);
  }, toggles);

// ---------------------------------------------------------------------------------------------
// pixels
// ---------------------------------------------------------------------------------------------

interface Px {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Share {
  count: number;
  total: number;
  frac: number;
}

/** Decodes a PNG in the page and, for each pair, counts the pixels of A whose counterpart in B
 *  (same offset) differs by CHANNEL_THRESH in some channel; positions outside the frame are skipped. */
async function diffRects(
  page: Page,
  png: Buffer,
  pairs: ReadonlyArray<readonly [Px, Px]>,
): Promise<{ w: number; h: number; shares: Share[] }> {
  const out = await page.evaluate(
    async (a: { b64: string; pairs: ReadonlyArray<readonly [Px, Px]>; thresh: number }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${a.b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      if (g === null) throw new Error('no 2d context');
      g.drawImage(img, 0, 0);
      const W = c.width;
      const H = c.height;
      const d = g.getImageData(0, 0, W, H).data;
      const shares = a.pairs.map(([p, q]) => {
        let count = 0;
        let total = 0;
        for (let j = 0; j < p.h; j += 1) {
          for (let i = 0; i < p.w; i += 1) {
            const ax = p.x + i;
            const ay = p.y + j;
            const bx = q.x + i;
            const by = q.y + j;
            if (ax < 0 || ay < 0 || ax >= W || ay >= H) continue;
            if (bx < 0 || by < 0 || bx >= W || by >= H) continue;
            const ia = (ay * W + ax) * 4;
            const ib = (by * W + bx) * 4;
            const m = Math.max(
              Math.abs((d[ia] ?? 0) - (d[ib] ?? 0)),
              Math.abs((d[ia + 1] ?? 0) - (d[ib + 1] ?? 0)),
              Math.abs((d[ia + 2] ?? 0) - (d[ib + 2] ?? 0)),
            );
            total += 1;
            if (m >= a.thresh) count += 1;
          }
        }
        return { count, total };
      });
      return { w: W, h: H, shares };
    },
    { b64: png.toString('base64'), pairs, thresh: CHANNEL_THRESH },
  );
  return {
    w: out.w,
    h: out.h,
    shares: out.shares.map((s) => ({ ...s, frac: s.total === 0 ? 0 : s.count / s.total })),
  };
}

/** An integer pixel rect shrunk 2 px each side (edge anti-aliasing, sub-pixel seams). */
const toPx = (r: ScreenRect): Px => ({
  x: Math.round(r.x) + 2,
  y: Math.round(r.y) + 2,
  w: Math.max(1, Math.round(r.w) - 4),
  h: Math.max(1, Math.round(r.h) - 4),
});

const overlaps = (a: ScreenRect, b: ScreenRect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** The share of `r`'s area that lies inside the viewport. */
function visibleShare(r: ScreenRect): number {
  const w = Math.min(r.x + r.w, VIEWPORT.width) - Math.max(r.x, 0);
  const h = Math.min(r.y + r.h, VIEWPORT.height) - Math.max(r.y, 0);
  return w <= 0 || h <= 0 ? 0 : (w * h) / (r.w * r.h);
}

/** True per point when the topmost DOM element there is the canvas (no overlay covers it). */
const canvasOnTop = (page: Page, r: ScreenRect): Promise<boolean> =>
  page.evaluate((rr: ScreenRect) => {
    const x0 = Math.max(rr.x, 0);
    const y0 = Math.max(rr.y, 0);
    const x1 = Math.min(rr.x + rr.w, window.innerWidth - 1);
    const y1 = Math.min(rr.y + rr.h, window.innerHeight - 1);
    const pts = [
      [(x0 + x1) / 2, (y0 + y1) / 2],
      [x0 + 3, y0 + 3],
      [x1 - 3, y0 + 3],
      [x0 + 3, y1 - 3],
      [x1 - 3, y1 - 3],
    ];
    return pts.every(([px, py]) => {
      const el = document.elementFromPoint(px ?? 0, py ?? 0);
      return el !== null && el.tagName === 'CANVAS';
    });
  }, r);

const shot = (page: Page): Promise<Buffer> => page.screenshot({ type: 'png' });

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Waits until the camera has stopped: the drawn rects (or, when none are drawn, the screenshot)
 *  are identical on two reads ~200 ms apart. */
async function settleCamera(page: Page, label: string): Promise<void> {
  let prev = '';
  for (let i = 0; i < 50; i += 1) {
    const art = await needArt(page, label);
    const rects = JSON.stringify([
      art.landmarks.map((l) => l.rect),
      art.warpMarkers.map((m) => m.rect),
    ]);
    const sig = rects === '[[],[]]' ? sha(await shot(page)) : rects;
    if (i > 0 && sig === prev) return;
    prev = sig;
    await page.waitForTimeout(200);
  }
  throw new Error(`${label}: the camera did not settle within 10 s`);
}

// ---------------------------------------------------------------------------------------------
// the pixel proof: a sampled rect vs same-class ground tiles
// ---------------------------------------------------------------------------------------------

interface ProofCase {
  label: string;
  /** The art rect of the sampled tile region (for the heal: the lower, (8,3) tile). */
  readSample: (art: ArtDescription) => ScreenRect | undefined;
  /** The tile the sample sits on. */
  tile: Tile;
  /** The CSS px of one tile at the stage scale. */
  pitch: number;
  /** Ground classes the references are drawn from, in preference order. */
  kinds: readonly string[];
  /** The absolute floor on the share of sample pixels that differ from ground. */
  min: number;
}

interface ProofResult {
  min: number;
  landFrac: number;
  noiseFrac: number;
  detail: string;
}

/** Locates a tile's rect from the sample's rect and the tile pitch. */
const tileRectFrom = (sample: ScreenRect, at: Tile, pitch: number, t: Tile): ScreenRect => ({
  x: sample.x + (t.x - at.x) * pitch,
  y: sample.y + (t.y - at.y) * pitch,
  w: sample.w,
  h: sample.h,
});

const waitPassCount = (page: Page, n: number): Promise<unknown> =>
  page.waitForFunction(
    (want: number) => {
      const a = (window as unknown as { __game: () => ArtHook }).__game().art;
      return a !== null && a !== undefined && a.post.passes.length === want;
    },
    n,
    { timeout: 20_000 },
  );

/** The decor proofs (heal landmark, warp marker) run with the post stack OFF: the vignette and
 *  the godray vary strongly with screen position, so with the stack on even two tiles of the SAME
 *  kit frame differ on most pixels and a per-pixel compare means nothing. Stack off, nearest
 *  sampling makes same-key tiles near pixel-identical, so the noise floor is meaningful. The
 *  stack's own effect on the frame is proven separately in WAP10.3. The full stack is restored
 *  on every path, including a throw. */
async function pixelProof(page: Page, c: ProofCase): Promise<ProofResult> {
  await setStack(page, STACK_OFF);
  try {
    await waitPassCount(page, 0);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    return await pixelProofStackOff(page, c);
  } finally {
    await setStack(page, STACK_ON);
    await waitPassCount(page, 4).catch(() => undefined);
  }
}

async function pixelProofStackOff(page: Page, c: ProofCase): Promise<ProofResult> {
  let last = `${c.label}: no attempt ran`;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    await settleCamera(page, c.label);
    const art1 = await needArt(page, c.label);
    const sample = c.readSample(art1);
    if (sample === undefined) throw new Error(`${c.label}: the art reports no rect to sample`);
    const world = await readWorld(page);
    const terrain = world.map.terrain ?? [];
    const warps = world.map.warps ?? [];
    const lms = (world.map.landmarks ?? []) as readonly Tile[];
    const { chars: chars1, own } = await readChars(page);
    const footprints = (chars: readonly ArtChar[]): ScreenRect[] =>
      chars.map((ch) => {
        const m = ch.entityId === own ? 0 : c.pitch / 2;
        const t = tileRectFrom(sample, c.tile, c.pitch, { x: ch.tileX, y: ch.tileY });
        return { x: t.x - m, y: t.y - c.pitch - m, w: c.pitch + 2 * m, h: 2 * c.pitch + 2 * m };
      });
    const clear = (r: ScreenRect, chars: readonly ArtChar[]): boolean =>
      !footprints(chars).some((f) => overlaps(f, r));
    // Candidate ground tiles of one class, nearest (in distance from the screen centre) first.
    const centreDist = (r: ScreenRect): number =>
      Math.hypot(r.x + r.w / 2 - VIEWPORT.width / 2, r.y + r.h / 2 - VIEWPORT.height / 2);
    const want = centreDist(sample);
    const keyAt = (x: number, y: number): string | null => art1.frames[y * art1.width + x] ?? null;
    const sampleKey = keyAt(c.tile.x, c.tile.y);
    const poolFor = async (match: (x: number, y: number) => boolean): Promise<Tile[]> => {
      const pool: Array<{ t: Tile; d: number }> = [];
      for (let y = 0; y < world.map.height; y += 1) {
        for (let x = 0; x < world.map.width; x += 1) {
          if (!match(x, y)) continue;
          const near = [...warps.map((w) => w.from), ...lms].some(
            (m) => Math.abs(m.x - x) <= 1 && Math.abs(m.y - y) <= 2,
          );
          if (near || (x === c.tile.x && y === c.tile.y)) continue;
          const r = tileRectFrom(sample, c.tile, c.pitch, { x, y });
          if (visibleShare(r) < 0.99) continue;
          if (!clear(r, chars1)) continue;
          if (!(await canvasOnTop(page, r))) continue;
          pool.push({ t: { x, y }, d: Math.abs(centreDist(r) - want) });
        }
      }
      return pool.sort((a, b) => a.d - b.d).map((p) => p.t);
    };
    let refs: Tile[] = [];
    let kindUsed = '';
    // Same texture first: a tile whose kit frame key EQUALS the sample tile's, so the only
    // difference left is the post stack's position-dependent lighting. Then the same class with
    // any key (the noise margin still applies).
    if (sampleKey !== null) {
      refs = await poolFor((x, y) => keyAt(x, y) === sampleKey);
      kindUsed = `key ${sampleKey}`;
    }
    for (const kind of c.kinds) {
      if (refs.length >= 2) break;
      refs = await poolFor((x, y) => terrain[y * world.map.width + x] === kind);
      kindUsed = `class ${kind}`;
    }
    const [r1, r2] = refs;
    if (r1 === undefined || r2 === undefined) {
      last = `${c.label}: fewer than two clear same-class ground tiles on screen (${kindUsed}: ${refs.length})`;
      await page.waitForTimeout(500);
      continue;
    }
    const ground1 = tileRectFrom(sample, c.tile, c.pitch, r1);
    const ground2 = tileRectFrom(sample, c.tile, c.pitch, r2);
    if (
      visibleShare(sample) < 0.5 ||
      !clear(sample, chars1) ||
      !(await canvasOnTop(page, sample))
    ) {
      last = `${c.label}: the sample rect ${JSON.stringify(sample)} is covered (character, overlay or off-screen)`;
      await page.waitForTimeout(500);
      continue;
    }
    const png = await shot(page);
    // The frame must not have moved while it was captured.
    const art2 = await needArt(page, c.label);
    const again = c.readSample(art2);
    const { chars: chars2 } = await readChars(page);
    if (
      again === undefined ||
      JSON.stringify(again) !== JSON.stringify(sample) ||
      !clear(sample, chars2) ||
      !clear(ground1, chars2) ||
      !clear(ground2, chars2)
    ) {
      last = `${c.label}: the scene moved while it was captured (sample ${JSON.stringify(sample)})`;
      await page.waitForTimeout(500);
      continue;
    }
    const px = await diffRects(page, png, [
      [toPx(sample), toPx(ground1)],
      [toPx(ground1), toPx(ground2)],
    ]);
    expect(
      { w: px.w, h: px.h },
      `${c.label}: the screenshot is the viewport at device ratio 1`,
    ).toEqual({
      w: VIEWPORT.width,
      h: VIEWPORT.height,
    });
    const land = px.shares[0] as Share;
    const noise = px.shares[1] as Share;
    return {
      min: c.min,
      landFrac: land.frac,
      noiseFrac: noise.frac,
      detail:
        `${c.label}: sample ${JSON.stringify(sample)} vs ${kindUsed} (${r1.x},${r1.y}) differs ` +
        `${land.count}/${land.total} = ${land.frac.toFixed(3)}; ground (${r1.x},${r1.y}) vs ` +
        `(${r2.x},${r2.y}) noise ${noise.count}/${noise.total} = ${noise.frac.toFixed(3)}; ` +
        `thresh ${CHANNEL_THRESH}, need >= ${c.min} and >= noise + ${NOISE_MARGIN}`,
    };
  }
  throw new Error(`${c.label}: no clean frame to sample after 6 attempts (${last})`);
}

function expectProof(p: ProofResult): void {
  expect(p.landFrac, p.detail).toBeGreaterThanOrEqual(p.min);
  expect(p.landFrac, p.detail).toBeGreaterThanOrEqual(p.noiseFrac + NOISE_MARGIN);
}

// ---------------------------------------------------------------------------------------------
// frame keys and the histogram
// ---------------------------------------------------------------------------------------------

/** The terrain class a kit frame key belongs to (client/src/render/art/packs/terrain.ts: the
 *  `variants(prefix)` / `waterFrames(prefix)` keys and the `shore_*` band, which only a
 *  ShallowWater tile draws). Unambiguous: no key matches two rows. */
const FAMILIES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^ground_\d+$/, 'Floor'],
  [/^tall_grass_\d+$/, 'TallGrass'],
  [/^path_\d+$/, 'Path'],
  [/^sand_\d+$/, 'Sand'],
  [/^shallow_water_(\d+|f\d+)$/, 'ShallowWater'],
  [/^shore_[a-z_]+$/, 'ShallowWater'],
  [/^deep_water_(\d+|f\d+)$/, 'DeepWater'],
  [/^rock_\d+$/, 'Rock'],
  [/^tree_\d+$/, 'Tree'],
  [/^bush_\d+$/, 'Bush'],
  [/^wall_\d+$/, 'Wall'],
];

const classOfFrame = (key: string | null): string | null => {
  if (key === null) return null;
  const hits = FAMILIES.filter(([re]) => re.test(key));
  return hits.length === 1 ? (hits[0]?.[1] ?? null) : null;
};

/** The frame-key family: the key without its trailing variant / animation index. */
const familyOf = (key: string): string => key.replace(/_(f?\d+)$/, '');

function countBy(values: readonly (string | null | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) {
    if (v === null || v === undefined) continue;
    out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}

const nonZero = (h: Readonly<Record<string, number>>): Record<string, number> =>
  Object.fromEntries(Object.entries(h).filter(([, n]) => n > 0));

// ---------------------------------------------------------------------------------------------
// the flow
// ---------------------------------------------------------------------------------------------

interface PostSample {
  label: string;
  post: { passes: readonly string[]; keyframe: string } | null;
}

test.describe
  .serial('wap-10 — the integrated world art (real client + server, one player, D-pad only)', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;
    const samples: PostSample[] = [];
    let zone0Histogram: Record<string, number> | null = null;
    let pitch = 0;

    const sample = async (label: string): Promise<void> => {
      const art = await readArt(page);
      samples.push({ label, post: art === null ? null : art.post });
    };

    /** Waits (without asserting) for the full stack to show on the art; WAP10.3 judges it. */
    const waitStackOn = async (): Promise<void> => {
      await page
        .waitForFunction(
          () => {
            const a = (window as unknown as { __game: () => ArtHook }).__game().art;
            return a !== null && a !== undefined && a.post.passes.length === 4;
          },
          null,
          { timeout: 20_000 },
        )
        .catch(() => undefined);
    };

    test.beforeAll(async () => {
      test.setTimeout(120_000);
      browser = await chromium.launch();
      ctx = await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        reducedMotion: 'reduce',
      });
      page = await ctx.newPage();
      await page.goto('/');
      await page.waitForFunction(
        () => {
          const w = window as unknown as ArtWindow;
          if (!w.__game) return false;
          const g = w.__game();
          return g.identity !== '' && g.ownAuthTile !== null;
        },
        null,
        { timeout: 30_000 },
      );
      await installStepCounter(page);
    });

    test.afterAll(async () => {
      await ctx?.close();
      await browser?.close();
    });

    test('WAP10.1 the kit terrain and the heal landmark are drawn in zone 0, reached by D-pad', async () => {
      // WRONG IMPL KILLED: no art hook / a null art (needArt throws); a renderer still on the flat
      // fallback (terrain !== 'kit'); frames not one per tile, or one family only (a flat fill);
      // a heal landmark reported at the wrong tile, twice, or with a rect that is not 1x2 tiles or
      // not on screen; a landmark REPORTED but never drawn (the pixels in its rect equal bare
      // ground: landFrac < LAND_MIN); a sprite no brighter than the vignette noise (the noise
      // margin); a test that walked with __game().step (the step counter).
      test.setTimeout(240_000);
      await setStack(page, STACK_ON);
      await waitStackOn();
      await settleCamera(page, 'WAP10.1 spawn');
      await sample('spawn');

      const spawn = await readWorld(page);
      expect(spawn.map.zone_id, 'the player spawns in zone 0').toBe(0);
      expect(await dpadWalkTo(page, HEAL, 'WAP10.1 to the heal post'), 'a grass-free walk').toBe(
        'arrived',
      );
      await expectNoStepCalls(page, 'WAP10.1 to the heal post');
      // Step back off the post (two tiles when both are safe) so the player stands clear of it.
      const back: Dir[] = [];
      let at: Tile = HEAL;
      for (let i = 0; i < 2; i += 1) {
        const next = stepTile(at, 'West');
        if (!safeTile(spawn.map, next)) break;
        back.push('West');
        at = next;
      }
      expect(back.length, 'the heal post has a safe tile to its west').toBeGreaterThan(0);
      expect(await dpadWalkPath(page, back, 'WAP10.1 off the post')).toBe('arrived');
      await expectNoStepCalls(page, 'WAP10.1 off the post');
      await settleCamera(page, 'WAP10.1 heal post');
      await sample('heal post');

      const art = await needArt(page, 'WAP10.1');
      expect(art.zoneId, 'the art describes zone 0').toBe(0);
      expect(art.terrain, 'the kit terrain is what was drawn').toBe('kit');
      expect(art.frames.length, 'one frame key per tile').toBe(art.width * art.height);
      expect([art.width, art.height], 'the art size is the zone map size').toEqual([
        spawn.map.width,
        spawn.map.height,
      ]);
      const families = new Set(
        art.frames.filter((f): f is string => typeof f === 'string').map(familyOf),
      );
      expect(
        families.size,
        `at least two frame-key families are drawn (saw ${[...families].join(', ')})`,
      ).toBeGreaterThanOrEqual(2);

      const heals = art.landmarks.filter((l) => l.kind === 'heal');
      expect(
        heals.map((l) => [l.x, l.y]),
        'exactly one heal landmark, at (8,3)',
      ).toEqual([[HEAL.x, HEAL.y]]);
      const heal = heals[0];
      if (heal === undefined) throw new Error('unreachable: one heal landmark asserted');
      const r = heal.rect;
      expect(r.w, `the landmark is 1 tile wide on screen: ${JSON.stringify(r)}`).toBeGreaterThan(8);
      expect(
        Math.abs(r.h - 2 * r.w),
        `the landmark is 2 tiles tall: ${JSON.stringify(r)}`,
      ).toBeLessThan(2);
      expect(
        r.x >= 0 && r.y >= 0 && r.x + r.w <= VIEWPORT.width && r.y + r.h <= VIEWPORT.height,
        `the landmark rect lies inside the 1280x720 viewport: ${JSON.stringify(r)}`,
      ).toBe(true);
      pitch = r.w;

      // Only the lower, (8,3), tile: the upper half covers (8,2), tall grass.
      const proof = await pixelProof(page, {
        label: 'WAP10.1 heal landmark',
        readSample: (a) => {
          const h = a.landmarks.find((l) => l.kind === 'heal');
          return h === undefined
            ? undefined
            : { x: h.rect.x, y: h.rect.y + h.rect.h / 2, w: h.rect.w, h: h.rect.h / 2 };
        },
        tile: HEAL,
        pitch,
        kinds: ['Path', 'Floor'],
        min: LAND_MIN,
      });
      expectProof(proof);
      await expectNoStepCalls(page, 'WAP10.1 after the pixel proof');
      zone0Histogram = { ...(await needArt(page, 'WAP10.1 histogram')).histogram };
    });

    test('WAP10.2 the warp marker is drawn, and the D-pad warp lands in Tideglass Cove, a kit zone rich in water', async () => {
      // WRONG IMPL KILLED: a warp marker missing from the art or off screen; a marker reported but
      // never drawn (its pixels equal ground); a warp that stays on zone 0 or never moves the
      // player; a zone 1 still drawn with the flat fallback; a histogram echoing zone 0, or one
      // that is not the drawn frames' per-class counts (a map echo of a different layer); a cove
      // under 10% water; a walk done with __game().step.
      test.setTimeout(240_000);
      expect(zone0Histogram, 'WAP10.1 ran first and recorded the zone-0 histogram').not.toBeNull();
      expect(pitch, 'WAP10.1 measured the tile size').toBeGreaterThan(0);
      const w0 = await readWorld(page);
      const warp = (w0.map.warps ?? []).find((w) => w.from.x === WARP.x && w.from.y === WARP.y);
      expect(warp, 'zone 0 holds the warp at (1,5)').toBeDefined();
      const own = w0.ownAuthTile;
      if (own === null) throw new Error('no authoritative own tile');
      // A safe neighbour of the warp reachable on a safe walk; step onto the warp FROM it.
      let approach: { tile: Tile; path: Dir[]; final: Dir } | null = null;
      for (const d of ['North', 'East', 'West', 'South'] as const) {
        const tile = stepTile(WARP, d);
        const path = safeTile(w0.map, tile) ? safePath(w0.map, own, tile) : null;
        if (path !== null) {
          approach = { tile, path, final: oppositeDir(d) };
          break;
        }
      }
      if (approach === null) throw new Error('no safe approach tile next to the warp (1,5)');
      expect(await dpadWalkPath(page, approach.path, 'WAP10.2 to the warp'), 'no battle').toBe(
        'arrived',
      );
      await expectNoStepCalls(page, 'WAP10.2 to the warp');

      await settleCamera(page, 'WAP10.2 before the warp');
      await sample('before warp');
      const before = await needArt(page, 'WAP10.2 before the warp');
      const marker = before.warpMarkers.find((m) => m.x === WARP.x && m.y === WARP.y);
      expect(
        marker,
        `art.warpMarkers contains (1,5): ${JSON.stringify(before.warpMarkers)}`,
      ).toBeDefined();
      if (marker === undefined) throw new Error('unreachable: marker asserted');
      expect(
        visibleShare(marker.rect),
        `the marker overlaps the viewport by at least half: ${JSON.stringify(marker.rect)}`,
      ).toBeGreaterThanOrEqual(0.5);
      const warpKind = (w0.map.terrain ?? [])[WARP.y * w0.map.width + WARP.x] ?? 'Path';
      const proof = await pixelProof(page, {
        label: 'WAP10.2 warp marker',
        // The warp frames are 2 tiles tall, bottom-anchored (like the heal): sample the lower
        // (1,5) tile only; the upper half covers (1,4).
        readSample: (a) => {
          const m = a.warpMarkers.find((mk) => mk.x === WARP.x && mk.y === WARP.y);
          return m === undefined
            ? undefined
            : { x: m.rect.x, y: m.rect.y + m.rect.h / 2, w: m.rect.w, h: m.rect.h / 2 };
        },
        tile: WARP,
        pitch,
        kinds: [warpKind],
        // The marker is a ground DECAL (a pulse ring over the tile), not a sprite: measured, its
        // drawn footprint differs on 0.293 of the lower tile's pixels (1056/3600) against a
        // same-key reference, with a stack-off noise floor of 0.000. An undrawn marker reads ~0.
        min: WARP_MIN,
      });
      expectProof(proof);

      // The step onto the warp: the D-pad, then the zone changes.
      await pressButton(page, DPAD_BUTTON[approach.final]);
      await page.waitForFunction(
        () => {
          const a = (window as unknown as { __game: () => ArtHook }).__game().art;
          return a !== null && a !== undefined && a.zoneId === 1;
        },
        null,
        { timeout: 15_000 },
      );
      const dest = warp?.to_tile;
      await expect
        .poll(
          async () => {
            const w = await readWorld(page);
            return JSON.stringify([w.map.zone_id, w.ownAuthTile]);
          },
          { message: 'the own authoritative tile lands in zone 1', timeout: 15_000 },
        )
        .toBe(JSON.stringify([1, dest]));
      await expectNoStepCalls(page, 'WAP10.2 the warp step');
      await settleCamera(page, 'WAP10.2 after the warp');
      await sample('after warp');

      const w1 = await readWorld(page);
      const cove = await needArt(page, 'WAP10.2 zone 1');
      expect(cove.zoneId, 'the art describes zone 1').toBe(1);
      expect(cove.terrain, 'zone 1 is drawn from the kit').toBe('kit');
      expect([cove.width, cove.height], 'the art size is the zone-1 map size').toEqual([
        w1.map.width,
        w1.map.height,
      ]);
      expect(cove.frames.length, 'one frame key per zone-1 tile').toBe(cove.width * cove.height);
      expect(cove.histogram, 'the zone-1 histogram is not the zone-0 histogram').not.toEqual(
        zone0Histogram,
      );

      // Not a map echo: the counts must be what the DRAWN frames say, class by class.
      const unmapped = cove.frames.filter((f) => classOfFrame(f) === null);
      expect(unmapped, 'every drawn frame key belongs to exactly one terrain class').toEqual([]);
      const fromFrames = countBy(cove.frames.map(classOfFrame));
      expect(
        nonZero(cove.histogram),
        `the histogram equals the per-class counts of the drawn frames ${JSON.stringify(fromFrames)}`,
      ).toEqual(fromFrames);
      expect(fromFrames, 'the drawn frames agree with the authoritative zone map').toEqual(
        countBy(w1.map.terrain ?? []),
      );
      const water = (cove.histogram.ShallowWater ?? 0) + (cove.histogram.DeepWater ?? 0);
      expect(
        water / (cove.width * cove.height),
        `Tideglass Cove is at least 10% water (${water} of ${cove.width * cove.height})`,
      ).toBeGreaterThanOrEqual(0.1);
    });

    test('WAP10.3 the post stack is on at the day keyframe on every sample, and its filters really change the frame', async () => {
      // WRONG IMPL KILLED: a stack that is never turned on (passes []); passes in the wrong order
      // or a missing pass; a keyframe other than the live 'day' (or one the test had to set);
      // passes REPORTED but no filter attached to the world layer (the stack-on and stack-off
      // frames are equal: frameFrac < STACK_FRAME_MIN); an off switch that leaves passes attached
      // (passes must read [] with the keyframe still 'day'); a switch back on that attaches
      // nothing or reorders; a missed sample (all four labels must exist).
      test.setTimeout(240_000);
      expect(
        samples.map((s) => s.label),
        'WAP10.1 and WAP10.2 recorded the spawn, heal post, before-warp and after-warp samples',
      ).toEqual(['spawn', 'heal post', 'before warp', 'after warp']);
      await sample('now');
      for (const s of samples) {
        expect(s.post, `${s.label}: __game().art.post is reported`).not.toBeNull();
        expect(s.post?.keyframe, `${s.label}: the live keyframe`).toBe('day');
        expect(s.post?.passes, `${s.label}: the full ordered post stack`).toEqual([...FULL_STACK]);
      }

      await settleCamera(page, 'WAP10.3 stack on');
      const onPng = await shot(page);
      await setStack(page, STACK_OFF);
      await page.waitForFunction(
        () => {
          const a = (window as unknown as { __game: () => ArtHook }).__game().art;
          return a !== null && a !== undefined && a.post.passes.length === 0;
        },
        null,
        { timeout: 20_000 },
      );
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await settleCamera(page, 'WAP10.3 stack off');
      const offPng = await shot(page);
      const off = await needArt(page, 'WAP10.3 off');
      expect(off.post, 'every pass is detached, the keyframe is still day').toEqual({
        passes: [],
        keyframe: 'day',
      });

      // Compare the two screenshots through the page: A = the on frame, B = the off frame.
      const frameDiff = (onShot: Buffer, offShot: Buffer) =>
        page.evaluate(
          async (a: { on: string; off: string; thresh: number }) => {
            const read = async (b64: string): Promise<Uint8ClampedArray> => {
              const img = new Image();
              img.src = `data:image/png;base64,${b64}`;
              await img.decode();
              const c = document.createElement('canvas');
              c.width = img.width;
              c.height = img.height;
              const g = c.getContext('2d', { willReadFrequently: true });
              if (g === null) throw new Error('no 2d context');
              g.drawImage(img, 0, 0);
              return g.getImageData(0, 0, c.width, c.height).data;
            };
            const A = await read(a.on);
            const B = await read(a.off);
            let count = 0;
            for (let i = 0; i < A.length; i += 4) {
              const m = Math.max(
                Math.abs((A[i] ?? 0) - (B[i] ?? 0)),
                Math.abs((A[i + 1] ?? 0) - (B[i + 1] ?? 0)),
                Math.abs((A[i + 2] ?? 0) - (B[i + 2] ?? 0)),
              );
              if (m >= a.thresh) count += 1;
            }
            return { count, total: A.length / 4 };
          },
          {
            on: onShot.toString('base64'),
            off: offShot.toString('base64'),
            thresh: CHANNEL_THRESH,
          },
        );
      const both = await frameDiff(onPng, offPng);
      expect(
        both.count / both.total,
        `stack-on vs stack-off frames: ${both.count} of ${both.total} pixels differ by >= ${CHANNEL_THRESH}`,
      ).toBeGreaterThanOrEqual(STACK_FRAME_MIN);
      // Control: two stack-off frames one animation frame apart. The on/off difference above is
      // the stack, not frame-to-frame motion, only if this reads (near) zero.
      await page.evaluate(
        () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
      );
      const offAgain = await frameDiff(offPng, await shot(page));
      expect(
        offAgain.count / offAgain.total,
        `stack-off vs stack-off control: ${offAgain.count} of ${offAgain.total} pixels differ`,
      ).toBeLessThan(0.01);

      await setStack(page, STACK_ON);
      await waitStackOn();
      const back = await needArt(page, 'WAP10.3 back on');
      expect(back.post, 'the full ordered stack is back on at day').toEqual({
        passes: [...FULL_STACK],
        keyframe: 'day',
      });
      await expectNoStepCalls(page, 'WAP10.3');
    });
  });
