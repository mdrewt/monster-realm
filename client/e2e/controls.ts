// controls.ts — the e2e press helpers (ctl-6a). Specs press virtual buttons and accelerators
// through here, never raw key names, so a binding change lands in one place. Imports only
// pure modules, so it loads under Playwright without Vite.
import { expect, type Locator, type Page } from '@playwright/test';
import { DEFAULT_BINDINGS } from '../src/input/bindings';
import type { Accel, VButton } from '../src/input/buttons';
import type { RawTileMap } from '../src/render/map';
import type { Frame, Stack } from '../src/ui/contextStack';

/** Start presses `closeAll` spends before it fails naming the stuck top frame (CTL6A.1). */
export const CLOSE_ALL_MAX_PRESSES = 5;
/** How long one Start press may take to change the stack (a dialogue close is a server round
 *  trip) before `closeAll` presses again. */
const CLOSE_ALL_SETTLE_MS = 4_000;

/** Presses the first key bound to `button` in `DEFAULT_BINDINGS`. */
export async function pressButton(page: Page, button: VButton): Promise<void> {
  await page.keyboard.press(DEFAULT_BINDINGS.buttons[button][0]);
}

/** Presses the first key bound to the accelerator `accel` in `DEFAULT_BINDINGS`. */
export async function pressAccel(page: Page, accel: Accel): Promise<void> {
  await page.keyboard.press(DEFAULT_BINDINGS.accels[accel][0]);
}

/** `closeAll` gave up: Start did not bring the stack back to its base (CTL6A.1). */
export class StuckStackError extends Error {}

const readStack = (page: Page): Promise<Stack> =>
  page.evaluate(() => {
    const game = (window as unknown as { __game?: () => { stack: Stack } }).__game;
    if (game === undefined) throw new Error('closeAll: window.__game is missing (DEV build only)');
    return game().stack;
  });

const frameName = (f: Frame): string => {
  switch (f.kind) {
    case 'world':
      return 'world';
    case 'battle':
      return `battle:${f.battleId}`;
    case 'screen':
    case 'prompt':
      return `${f.kind}:${f.id}`;
    case 'textEntry':
      return `textEntry:${f.owner}`;
  }
};

/** Presses Start only while `__game().stack` is above its base; returns once it is at the base.
 *  Fails naming the stuck top frame after `CLOSE_ALL_MAX_PRESSES` presses (CTL6A.1). Never
 *  presses at a base, so it is safe both before and after Escape becomes Start (ctl-6b). */
export async function closeAll(page: Page): Promise<void> {
  const start = DEFAULT_BINDINGS.buttons.Start[0];
  for (let presses = 0; ; presses++) {
    const before = await readStack(page);
    if (before.length <= 1) return;
    if (presses === CLOSE_ALL_MAX_PRESSES) {
      const top = before[before.length - 1];
      throw new StuckStackError(
        `closeAll: stuck top frame ${frameName(top)} after ${presses} Start (${start}) presses ` +
          `(stack length ${before.length})`,
      );
    }
    await page.keyboard.press(start);
    const was = JSON.stringify(before);
    await expect
      .poll(async () => JSON.stringify(await readStack(page)), { timeout: CLOSE_ALL_SETTLE_MS })
      .not.toBe(was)
      .catch(() => undefined); // unchanged: press again, up to the bound
  }
}

// ---------------------------------------------------------------------------------------------
// ctl-10a: T retired. World A acts on what the character FACES — the entities on the tile in
// front, else on its own tile (game-core `interact_candidates`, wasm `interact_candidates_coded`).
// The helpers below walk to a post, face a target, and press A there. They read only the DEV
// `__game()` snapshot (tiles, facing, the stack, the zone map), never store state the test is
// about, and they import nothing but types, so they load under Playwright without Vite.
//
// FACING FACTS (game-core/src/world.rs `apply_move`): a Step always turns the character to the
// step's direction, and moves it when the target tile is walkable (a bump into a wall turns it in
// place). Characters never block movement (`is_walkable` reads the tile kind only), so a step
// toward an NPC walks ONTO its tile. To face tile T from its neighbour N, these helpers therefore
// arrive at N by a step in T's direction from the tile beyond N (`faceTile`). They never rely on
// a bump turn: every post used by the specs has a walkable approach tile.
// ---------------------------------------------------------------------------------------------

/** A compass direction, as `__game().step()` takes it and the character row's `facing` reads. */
export type Dir = 'North' | 'South' | 'East' | 'West';

export interface Tile {
  readonly x: number;
  readonly y: number;
}

/** Breadth-first expansion order (fixed, so a computed path is deterministic). */
const DIRS: readonly Dir[] = ['North', 'South', 'East', 'West'];

const DELTA: Readonly<Record<Dir, Tile>> = {
  North: { x: 0, y: -1 },
  South: { x: 0, y: 1 },
  East: { x: 1, y: 0 },
  West: { x: -1, y: 0 },
};

const OPPOSITE: Readonly<Record<Dir, Dir>> = {
  North: 'South',
  South: 'North',
  East: 'West',
  West: 'East',
};

/** The tile one step from `t` in `d` (game-core `TilePos::step`; North is y − 1). */
export const stepTile = (t: Tile, d: Dir): Tile => ({ x: t.x + DELTA[d].x, y: t.y + DELTA[d].y });

const sameTile = (a: Tile | null, b: Tile): boolean => a !== null && a.x === b.x && a.y === b.y;

const tileName = (t: Tile | null): string => (t === null ? '(none)' : `(${t.x},${t.y})`);

/** A tile a scripted walk may enter: in bounds, walkable, NOT tall grass (an encounter rolls
 *  only on stepping onto grass) and NOT a warp source (stepping on one changes zone). */
export function safeTile(map: RawTileMap, t: Tile): boolean {
  if (t.x < 0 || t.y < 0 || t.x >= map.width || t.y >= map.height) return false;
  const i = t.y * map.width + t.x;
  if (map.walkable[i] !== true || map.grass[i] === true) return false;
  return !(map.warps ?? []).some((w) => w.from.x === t.x && w.from.y === t.y);
}

/** The shortest walk from `from` to `to` that enters only `safeTile`s (`from` itself may be
 *  anything — a battle often leaves the character on grass). `[]` when already there, null when
 *  no safe walk exists. Pure; breadth-first in `DIRS` order. */
export function safePath(map: RawTileMap, from: Tile, to: Tile): Dir[] | null {
  if (sameTile(from, to)) return [];
  if (!safeTile(map, to)) return null;
  const key = (t: Tile): string => `${t.x},${t.y}`;
  const came = new Map<string, { prev: string; dir: Dir }>();
  const seen = new Set<string>([key(from)]);
  const queue: Tile[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head] as Tile;
    for (const d of DIRS) {
      const next = stepTile(cur, d);
      const k = key(next);
      if (seen.has(k) || !safeTile(map, next)) continue;
      seen.add(k);
      came.set(k, { prev: key(cur), dir: d });
      if (sameTile(next, to)) {
        const path: Dir[] = [];
        for (let at = k; at !== key(from); ) {
          const link = came.get(at);
          if (link === undefined) return null; // unreachable: every queued tile has a link
          path.unshift(link.dir);
          at = link.prev;
        }
        return path;
      }
      queue.push(next);
    }
  }
  return null;
}

/** The slice of `__game()` the world helpers read. `ownFacing` is the own character row's
 *  authoritative facing (null until the row exists). */
export interface WorldSnap {
  readonly ownEntityId: string | null;
  readonly ownAuthTile: Tile | null;
  readonly ownFacing: Dir | null;
  readonly stackLength: number;
  readonly battle: boolean;
  readonly map: RawTileMap;
}

interface GameHook {
  ownEntityId: string | null;
  ownAuthTile: Tile | null;
  characters: { entityId: string; tileX: number; tileY: number; facing: Dir }[];
  ongoingBattle: unknown;
  stack: Stack;
  map: RawTileMap;
  step: (d: string) => void;
}

export const readWorld = (page: Page): Promise<WorldSnap> =>
  page.evaluate(() => {
    const hook = (window as unknown as { __game?: () => GameHook }).__game;
    if (hook === undefined) throw new Error('readWorld: window.__game is missing (DEV build only)');
    const g = hook();
    const own = g.characters.find((c) => c.entityId === g.ownEntityId);
    return {
      ownEntityId: g.ownEntityId,
      ownAuthTile: g.ownAuthTile,
      ownFacing: own === undefined ? null : own.facing,
      stackLength: g.stack.length,
      battle: g.ongoingBattle !== null,
      map: g.map,
    };
  });

/** How long one step may take to show on the authoritative tile (200 ms drain + network). */
const STEP_SETTLE_MS = 8_000;

/** Walks `dirs` one step at a time, waiting for the AUTHORITATIVE tile to become the expected
 *  one before the next step. Returns 'battle' (and stops) the moment an encounter starts;
 *  throws, naming the step, when a step lands anywhere else or never lands. */
export async function walkPath(
  page: Page,
  dirs: readonly Dir[],
  label: string,
): Promise<'arrived' | 'battle'> {
  for (const dir of dirs) {
    const before = await readWorld(page);
    if (before.battle) return 'battle';
    const from = before.ownAuthTile;
    if (from === null) throw new Error(`${label}: no authoritative own tile before ${dir}`);
    const want = stepTile(from, dir);
    await page.evaluate((d) => {
      (window as unknown as { __game: () => GameHook }).__game().step(d);
    }, dir);
    const outcome = await page
      .waitForFunction(
        (a: { fx: number; fy: number }) => {
          const g = (window as unknown as { __game: () => GameHook }).__game();
          if (g.ongoingBattle !== null) return 'battle';
          const t = g.ownAuthTile;
          return t !== null && (t.x !== a.fx || t.y !== a.fy) ? 'moved' : false;
        },
        { fx: from.x, fy: from.y },
        { timeout: STEP_SETTLE_MS },
      )
      .then((h) => h.jsonValue() as Promise<'battle' | 'moved'>)
      .catch(() => {
        throw new Error(
          `${label}: stepping ${dir} from ${tileName(from)} did not land within ${STEP_SETTLE_MS} ms`,
        );
      });
    if (outcome === 'battle') return 'battle';
    const after = await readWorld(page);
    if (!sameTile(after.ownAuthTile, want)) {
      throw new Error(
        `${label}: stepping ${dir} from ${tileName(from)} landed on ${tileName(after.ownAuthTile)}, ` +
          `not ${tileName(want)} — re-derive the walk from the zone map`,
      );
    }
  }
  return 'arrived';
}

/** Walks a `safePath` (grass-free, warp-free) to `target` on the current zone map. */
export async function walkTo(
  page: Page,
  target: Tile,
  label: string,
): Promise<'arrived' | 'battle'> {
  const w = await readWorld(page);
  if (w.ownAuthTile === null) throw new Error(`${label}: no authoritative own tile`);
  const path = safePath(w.map, w.ownAuthTile, target);
  if (path === null) {
    throw new Error(
      `${label}: no grass-free, warp-free walk from ${tileName(w.ownAuthTile)} to ${tileName(target)} ` +
        `on zone ${w.map.zone_id}`,
    );
  }
  return walkPath(page, path, label);
}

/** Puts the character on `stand` FACING `facing`: walks a safe path to the tile behind `stand`
 *  (the approach), then steps `facing` onto `stand` — the arriving step sets the facing (see
 *  FACING FACTS). A no-op when it already stands there facing that way. Asserts the resulting
 *  authoritative tile and facing. */
export async function faceTile(
  page: Page,
  stand: Tile,
  facing: Dir,
  label: string,
): Promise<'arrived' | 'battle'> {
  const w = await readWorld(page);
  if (!(sameTile(w.ownAuthTile, stand) && w.ownFacing === facing)) {
    const approach = stepTile(stand, OPPOSITE[facing]);
    if (!safeTile(w.map, approach) || !safeTile(w.map, stand)) {
      throw new Error(
        `${label}: cannot face ${facing} on ${tileName(stand)} — its approach ${tileName(approach)} ` +
          'or the post itself is not a safe tile',
      );
    }
    if ((await walkTo(page, approach, label)) === 'battle') return 'battle';
    if ((await walkPath(page, [facing], label)) === 'battle') return 'battle';
  }
  await expectPosted(page, stand, facing, label);
  return 'arrived';
}

/** Asserts (polling briefly, for the row that carries the last step) that the character stands
 *  on `stand` facing `facing`, by the authoritative own character row. */
export async function expectPosted(
  page: Page,
  stand: Tile,
  facing: Dir,
  label: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const w = await readWorld(page);
        return `${tileName(w.ownAuthTile)} facing ${w.ownFacing ?? '(none)'}`;
      },
      {
        message: `${label}: the character must stand on its post facing the target`,
        timeout: 5_000,
      },
    )
    .toBe(`${tileName(stand)} facing ${facing}`);
}

/** The interact chip's keycap for the default A binding (`DEFAULT_BINDINGS.buttons.A[0]` is
 *  `Enter`, whose catalog name `key.enter` reads "Enter" in `en`). */
const A_KEYCAP = 'Enter';
/** U+2014, built from its code point (never a pasted character). */
export const EM_DASH = String.fromCharCode(0x2014);

/** The exact `#interact-prompt` text for one candidate: `[Enter] {verb} — {name}` (CTL10A.3). */
export const interactChip = (verb: 'Talk' | 'Shop' | 'Heal', name: string): string =>
  `[${A_KEYCAP}] ${verb} ${EM_DASH} ${name}`;

/** Reads `#interact-prompt`: null while it is not rendered (no layout box), else its text with
 *  whitespace collapsed (as Playwright's `toHaveText` compares). */
export const readChip = (page: Page): Promise<string | null> =>
  page.evaluate(() => {
    const el = document.getElementById('interact-prompt');
    if (el === null || el.getClientRects().length === 0) return null;
    return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  });

// ---------------------------------------------------------------------------------------------
// ctl-10b: face to face. O is retired: a trade or a challenge starts only from the world's A on
// the OTHER PLAYER, offered as a picker row `Trade — <name>` / `Challenge — <name>` (a challenge
// then asks Yes / No). Two players join at the zone spawn, so unless one has moved they share a
// tile; with the front tile empty the other player is then an OWN-TILE candidate. When the other
// page is given and the players stand apart, the helper walks onto the other player's tile first.
// ---------------------------------------------------------------------------------------------

/** U+2026, built from its code point (never a pasted character). */
const ELLIPSIS = String.fromCharCode(0x2026);
/** The chip while A would open a picker (two or more actions): `[Enter] Choose…`. */
export const CHOOSE_CHIP = `[${A_KEYCAP}] Choose${ELLIPSIS}`;

export type FaceVerb = 'Trade' | 'Challenge';

interface SheetRow {
  readonly text: string;
  readonly selected: boolean;
}

/** The picker / action-sheet / confirm rows inside `#interact-prompt`, in order, with whitespace
 *  collapsed and which one carries `aria-selected="true"`. */
const readSheetRows = (page: Page): Promise<SheetRow[]> =>
  page.evaluate(() => {
    const el = document.getElementById('interact-prompt');
    if (el === null) return [];
    return [...el.querySelectorAll('[role="option"]')].map((row) => ({
      text: (row.textContent ?? '').replace(/\s+/g, ' ').trim(),
      selected: row.getAttribute('aria-selected') === 'true',
    }));
  });

/** The one other player's name, as `__mrTrade.allPlayers()` lists it. Without `named`, throws
 *  unless exactly one other player exists. With `named`, throws unless exactly one other player
 *  bears that name (the picker row `<verb> — <name>` must then name one player, not several). */
const otherPlayerName = (page: Page, named?: string): Promise<string> =>
  page.evaluate((want: string | null) => {
    const w = window as unknown as {
      __game: () => { identity: string };
      __mrTrade: { allPlayers(): Array<{ identity: string; name: string }> };
    };
    const me = w.__game().identity;
    const others = w.__mrTrade.allPlayers().filter((p) => p.identity !== me);
    const pool = want === null ? others : others.filter((p) => p.name === want);
    const only = pool[0];
    if (pool.length !== 1 || only === undefined) {
      throw new Error(
        `openFaceToFace: expected exactly 1 other player${want === null ? '' : ` named ${want}`}, ` +
          `found ${pool.length}`,
      );
    }
    return only.name;
  }, named ?? null);

/**
 * Starts a trade or a challenge the way a player does now (CTL10B.1): closes every open frame,
 * stands on the other player's tile (walking there only when `otherPage` is given and the two
 * stand apart), waits for the chip to read `[Enter] Choose…`, presses A, moves the picker cursor
 * to the row `<verb> — <name>` and presses A. A Trade opens the trade wizard on Offer with the
 * player pre-selected. A Challenge shows the Yes / No confirm; Yes is asserted selected, then A
 * on Yes sends it. `targetName` defaults to the one other player's name.
 */
export async function openFaceToFace(
  page: Page,
  verb: FaceVerb,
  targetName?: string,
  otherPage?: Page,
): Promise<void> {
  const label = `openFaceToFace(${verb})`;
  await closeAll(page);
  // B's player row may lag behind its join: poll until exactly one matching player is visible.
  let name = '';
  await expect
    .poll(
      async () => {
        name = await otherPlayerName(page, targetName).catch(() => '');
        return name !== '';
      },
      {
        message: `${label}: exactly one other player${targetName === undefined ? '' : ` named ${targetName}`} must be visible`,
        timeout: 15_000,
      },
    )
    .toBe(true);

  if (otherPage !== undefined) {
    const there = (await readWorld(otherPage)).ownAuthTile;
    if (there === null) throw new Error(`${label}: the other player has no authoritative tile`);
    const here = (await readWorld(page)).ownAuthTile;
    if (!sameTile(here, there) && (await walkTo(page, there, label)) === 'battle') {
      throw new Error(`${label}: a battle started while walking onto the other player's tile`);
    }
  }

  await expect
    .poll(() => readChip(page), {
      message: `${label}: the chip must offer a choice (the other player on the faced or own tile)`,
      timeout: 15_000,
    })
    .toBe(CHOOSE_CHIP);
  await pressButton(page, 'A');

  const want = `${verb} ${EM_DASH} ${name}`;
  await expect
    .poll(async () => (await readSheetRows(page)).map((r) => r.text), {
      message: `${label}: the picker must list "${want}"`,
      timeout: 5_000,
    })
    .toContain(want);
  const rows = await readSheetRows(page);
  const target = rows.findIndex((r) => r.text === want);
  const from = rows.findIndex((r) => r.selected);
  for (let at = from; at < target; at++) await pressButton(page, 'Down');
  await expect
    .poll(async () => (await readSheetRows(page)).findIndex((r) => r.selected), {
      message: `${label}: the picker cursor must reach "${want}"`,
      timeout: 5_000,
    })
    .toBe(target);
  await pressButton(page, 'A');

  if (verb === 'Challenge') {
    await expect
      .poll(async () => (await readSheetRows(page)).map((r) => `${r.text}:${r.selected}`), {
        message: `${label}: the confirm must show Yes (selected) and No`,
        timeout: 5_000,
      })
      .toEqual(['Yes:true', 'No:false']);
    await pressButton(page, 'A');
  }
}

export interface InFrontOpts {
  /** The tile the character holds. */
  readonly stand: Tile;
  /** The way it faces; the NPC is waited for on `stepTile(stand, facing)`. */
  readonly facing: Dir;
  /** Character entity ids that are never the NPC (the players). The own id is always skipped. */
  readonly ignoreEntityIds?: readonly string[];
  /** When set, `#interact-prompt` must read exactly this in the SAME poll that sees the NPC. */
  readonly chip?: string;
  /** Also require a bare world base (stack length 1) — true before an A press at the world. */
  readonly worldBase: boolean;
  readonly timeoutMs: number;
}

/** Resolves true once, in ONE page-side poll, the character stands on `stand` facing `facing`
 *  and a non-player character stands on the tile in front (plus the chip / world-base checks);
 *  false on timeout. `__game().characters` carries no zone, so callers pick posts whose front
 *  tile no NPC of another zone can occupy (each spec's WORLD FACTS say why). */
export async function waitForNpcInFront(page: Page, o: InFrontOpts): Promise<boolean> {
  const front = stepTile(o.stand, o.facing);
  return page
    .waitForFunction(
      (a: {
        sx: number;
        sy: number;
        fx: number;
        fy: number;
        facing: string;
        ignore: readonly string[];
        chip: string | null;
        worldBase: boolean;
      }) => {
        const g = (window as unknown as { __game: () => GameHook }).__game();
        if (a.worldBase && g.stack.length !== 1) return false;
        const t = g.ownAuthTile;
        if (t === null || t.x !== a.sx || t.y !== a.sy) return false;
        const own = g.characters.find((c) => c.entityId === g.ownEntityId);
        if (own === undefined || own.facing !== a.facing) return false;
        const npcInFront = g.characters.some(
          (c) =>
            c.entityId !== g.ownEntityId &&
            !a.ignore.includes(c.entityId) &&
            c.tileX === a.fx &&
            c.tileY === a.fy,
        );
        if (!npcInFront) return false;
        if (a.chip === null) return true;
        const el = document.getElementById('interact-prompt');
        if (el === null || el.getClientRects().length === 0) return false;
        return (el.textContent ?? '').replace(/\s+/g, ' ').trim() === a.chip;
      },
      {
        sx: o.stand.x,
        sy: o.stand.y,
        fx: front.x,
        fy: front.y,
        facing: o.facing,
        ignore: o.ignoreEntityIds ?? [],
        chip: o.chip ?? null,
        worldBase: o.worldBase,
      },
      { timeout: o.timeoutMs },
    )
    .then(() => true)
    .catch(() => false);
}

export interface InteractOpts {
  readonly stand: Tile;
  readonly facing: Dir;
  /** Visible once the interaction took (e.g. `#dialogue-overlay`). */
  readonly opened: Locator;
  readonly ignoreEntityIds?: readonly string[];
  /** The exact chip text expected while the NPC is in front (see `interactChip`). */
  readonly chip?: string;
  /** A presses before giving up. 1 for a stationary NPC (no retry needed or allowed). */
  readonly maxAttempts: number;
  /** Per attempt: how long to wait for the NPC to stand in front. */
  readonly npcWaitMs?: number;
  /** Per attempt: how long `opened` may take after the press (a server round trip). */
  readonly openWaitMs?: number;
  readonly label: string;
}

/** Talks to an NPC the way a player does now: hold a post FACING the tile the NPC stands on (or
 *  wanders through), and press A while it is there. Each attempt re-faces first (`faceTile`, a
 *  walk only if the character was displaced), asserts the post and the facing, waits — in one
 *  page-side poll on the live `__game().characters` — for the NPC on the faced tile at a bare
 *  world base, presses A once, and waits for `opened`. A wandering NPC can step away between the
 *  poll and the keydown, so attempts are bounded by `maxAttempts`. Returns the attempts used. */
export async function interactWithNpc(page: Page, o: InteractOpts): Promise<number> {
  const npcWaitMs = o.npcWaitMs ?? 20_000;
  const openWaitMs = o.openWaitMs ?? 3_000;
  for (let attempt = 1; attempt <= o.maxAttempts; attempt++) {
    // A slow open from the previous attempt may have landed: never press A into it.
    if (await o.opened.isVisible()) return attempt - 1;
    if ((await readWorld(page)).stackLength > 1) await closeAll(page);
    if ((await faceTile(page, o.stand, o.facing, o.label)) === 'battle') {
      throw new Error(
        `${o.label}: a battle started while re-facing the post — the walk is not grass-free`,
      );
    }
    await expectPosted(page, o.stand, o.facing, o.label);
    const inFront = await waitForNpcInFront(page, {
      stand: o.stand,
      facing: o.facing,
      ignoreEntityIds: o.ignoreEntityIds,
      chip: o.chip,
      worldBase: true,
      timeoutMs: npcWaitMs,
    });
    if (!inFront) continue;
    await pressButton(page, 'A');
    const opened = await o.opened
      .waitFor({ state: 'visible', timeout: openWaitMs })
      .then(() => true)
      .catch(() => false);
    if (opened) return attempt;
  }
  const w = await readWorld(page);
  const chip = await readChip(page);
  throw new Error(
    `${o.label}: A facing ${o.facing} from ${tileName(o.stand)} opened nothing after ` +
      `${o.maxAttempts} attempt(s). Now: ${tileName(w.ownAuthTile)} facing ${w.ownFacing ?? '(none)'}, ` +
      `stack length ${w.stackLength}, chip ${JSON.stringify(chip)}` +
      (o.chip === undefined
        ? ''
        : ` (expected ${JSON.stringify(o.chip)} while the NPC is in front)`),
  );
}
