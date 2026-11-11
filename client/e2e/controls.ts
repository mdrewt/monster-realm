// controls.ts — the e2e press helpers (ctl-6a). Specs press virtual buttons and accelerators
// through here, never raw key names, so a binding change lands in one place. Imports only
// pure modules, so it loads under Playwright without Vite.
//
// ctl-12b: the helpers press what the PAGE's live table says, not the defaults: a player can remap
// any key in Options > Controls, which saves the table to `localStorage['mr.controls']` and applies
// it at once. `liveBindings` reads that string in the page and parses it here with the game's own
// total `parseBindings`; anything unreadable gives `DEFAULT_BINDINGS`.
import { expect, type Locator, type Page } from '@playwright/test';
import { CONTROLS_STORAGE_KEY, parseBindings } from '../src/input/bindingStore';
import { type Bindings, DEFAULT_BINDINGS } from '../src/input/bindings';
import type { Accel, VButton } from '../src/input/buttons';
import type { RawTileMap } from '../src/render/map';
import type { Frame, Stack } from '../src/ui/contextStack';

/** Start presses `closeAll` spends before it fails naming the stuck top frame (CTL6A.1). */
export const CLOSE_ALL_MAX_PRESSES = 5;
/** How long one Start press may take to change the stack (a dialogue close is a server round
 *  trip) before `closeAll` presses again. */
const CLOSE_ALL_SETTLE_MS = 4_000;

/**
 * The page's live binding table (ctl-12b, CTL12B.2): the raw `localStorage['mr.controls']` string,
 * read in the page, parsed here through `parseBindings(JSON.parse(text))`. ANY failure gives
 * `DEFAULT_BINDINGS`: a page whose storage throws (about:blank after `page.setContent`, as
 * controls.spec.ts runs), nothing saved (null), or a value that is not JSON.
 */
export async function liveBindings(page: Page): Promise<Bindings> {
  try {
    const text = await page.evaluate(
      (key: string) => window.localStorage.getItem(key),
      CONTROLS_STORAGE_KEY,
    );
    return text === null ? DEFAULT_BINDINGS : parseBindings(JSON.parse(text));
  } catch {
    return DEFAULT_BINDINGS;
  }
}

/** A press helper found no key for a button or accelerator in the live table (a cleared row):
 *  it fails naming it rather than pressing `undefined`. */
export class UnboundKeyError extends Error {}

/** Presses the first key bound to `button` in the page's live table (`liveBindings`). */
export async function pressButton(page: Page, button: VButton): Promise<void> {
  const code = (await liveBindings(page)).buttons[button][0];
  if (code === undefined) {
    throw new UnboundKeyError(`pressButton: the button ${button} has no key in the live table`);
  }
  await page.keyboard.press(code);
}

/** Presses the first key bound to the accelerator `accel` in the page's live table. */
export async function pressAccel(page: Page, accel: Accel): Promise<void> {
  const code = (await liveBindings(page)).accels[accel][0];
  if (code === undefined) {
    throw new UnboundKeyError(`pressAccel: the accelerator ${accel} has no key in the live table`);
  }
  await page.keyboard.press(code);
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
 *  presses at a base, so it is safe both before and after Escape becomes Start (ctl-6b). Start's
 *  key is re-read from the live table before every press (ctl-12b: a remap moves it). */
export async function closeAll(page: Page): Promise<void> {
  for (let presses = 0; ; presses++) {
    const before = await readStack(page);
    if (before.length <= 1) return;
    const start = (await liveBindings(page)).buttons.Start[0];
    if (presses === CLOSE_ALL_MAX_PRESSES) {
      const top = before[before.length - 1];
      throw new StuckStackError(
        `closeAll: stuck top frame ${frameName(top)} after ${presses} ` +
          `Start (${start ?? 'unbound'}) presses (stack length ${before.length})`,
      );
    }
    if (start === undefined) {
      throw new UnboundKeyError('closeAll: Start has no key in the live table');
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

/** The exact `#interact-prompt` text for one candidate: `[{keycap}] {verb} — {name}` (CTL10A.3).
 *  `keycap` is the A button's keycap: `Enter` by default, the new key's after a remap (ctl-12b). */
export const interactChip = (
  verb: 'Talk' | 'Shop' | 'Heal',
  name: string,
  keycap = A_KEYCAP,
): string => `[${keycap}] ${verb} ${EM_DASH} ${name}`;

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

/** The size rows of the Challenge pick (bt-15, BT15.1): `n vs n` for n = sizes[0] down to 1. */
const sizeRowText = (n: number): string => `${n} vs ${n}`;

/**
 * Starts a trade or a challenge the way a player does now (CTL10B.1): closes every open frame,
 * stands on the other player's tile (walking there only when `otherPage` is given and the two
 * stand apart), waits for the chip to read `[Enter] Choose…`, presses A, moves the picker cursor
 * to the row `<verb> — <name>` and presses A. A Trade opens a trade session with that player and its
 * editor (ts-3: or the editor on the session the two already share). A Challenge shows the party-size pick (bt-15, named intentional change: was
 * Yes / No): the rows are `N vs N`, …, `1 vs 1`, then `No`, the largest size selected; the helper
 * Downs to the `size vs size` row (default: the first, the largest) and presses A, which sends it.
 * `targetName` defaults to the one other player's name. The three pre-bt-15 callers pass no `size`
 * and fight one-monster parties, so their pick is `1 vs 1`, `No` and A sends the first row.
 */
export async function openFaceToFace(
  page: Page,
  verb: FaceVerb,
  targetName?: string,
  otherPage?: Page,
  size?: number,
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
    // The pick: `N vs N` … `1 vs 1` (descending, N = min(3, eligible)), then No, the first selected.
    let pick: SheetRow[] = [];
    await expect
      .poll(
        async () => {
          pick = await readSheetRows(page);
          const texts = pick.map((r) => r.text);
          const sizes = texts.length - 1;
          if (sizes < 1 || sizes > 3 || texts[sizes] !== 'No') return `not the pick: ${texts}`;
          const want = [...Array.from({ length: sizes }, (_, i) => sizeRowText(sizes - i)), 'No'];
          return `${texts.join('|')}#${pick.findIndex((r) => r.selected)}` === `${want.join('|')}#0`
            ? 'ok'
            : `${texts.join('|')} selected ${pick.findIndex((r) => r.selected)}`;
        },
        {
          message: `${label}: the size pick must show N vs N … 1 vs 1, No with the largest selected`,
          timeout: 5_000,
        },
      )
      .toBe('ok');
    const at = size === undefined ? 0 : pick.findIndex((r) => r.text === sizeRowText(size));
    if (at === -1) {
      throw new Error(
        `${label}: the pick offers no ${sizeRowText(size ?? 0)} row (rows: ${pick.map((r) => r.text)})`,
      );
    }
    for (let i = 0; i < at; i++) await pressButton(page, 'Down');
    await expect
      .poll(async () => (await readSheetRows(page)).findIndex((r) => r.selected), {
        message: `${label}: the pick cursor must reach row ${at}`,
        timeout: 5_000,
      })
      .toBe(at);
    await pressButton(page, 'A');
  }
}

/** How long a WANDERING NPC gets to walk into reach, per attempt. dialogue.spec and
 *  wallet-balance.spec talk to elder_oak from (4,5) facing East, which reaches him on two tiles:
 *  the faced one, (5,5) (his home), and the post itself, (4,5) (the rule's own-tile tier; an NPC
 *  and a player may share a tile). Replaying game-core `npc_decide` + `apply_move` at the server
 *  cadence (one decision a second, NPC_STEP_TICKS = 5, a 1-in-5 stay) for 2e7 ticks over the
 *  zone-0 map gives his share of time per disc tile: (4,5) 22.1%, (5,5) 21.2%, (6,5) 22.2%,
 *  (3,5) 10.1%, (7,5) 10.1%, (5,4) 5.7%, (6,4) 4.3%, (4,4) 4.3%. So he is in reach 43% of the
 *  time, a visit to the pair lasts 2.3 s on average, and the wait for him from a random moment
 *  has a mean of 1.7 s, p95 7.6 s, p99 15 s, p99.9 26 s and a max of 58 s. One 20 s poll misses
 *  him 0.33% of the time (2.8% when a loaded server halves his cadence).
 *  A post that reaches him on one corner tile is far worse: (6,3) facing South reaches (6,4)
 *  alone, a 4.3% tile he leaves after 1.3 s, so the same wait has a mean of 39 s, p95 124 s,
 *  p99 192 s and a max of 578 s, and a press that reaches the page late finds him gone. */
export const WANDER_NPC_WAIT_MS = 20_000;
/** Attempts per talk to a wanderer. An attempt is spent by a poll that times out or by a press
 *  that lost the race (he stepped out of reach between the poll and the keydown). The same
 *  replay, running `interactWithNpc`'s loop over 2e6 talks: more than 3 attempts are needed in
 *  0.003% of them when the keydown lands 0.6 s after the poll, and more than 8 in 0.002% when it
 *  lands a full second after; at 0.2 s and 0.6 s, at full or half cadence, no talk needed more
 *  than 8. */
export const WANDER_NPC_MAX_ATTEMPTS = 8;
/** After an A press, how long `opened` may take (a server round trip): the one source for the
 *  budget below, `interactWithNpc`'s default and both wanderer callers. */
export const WANDER_OPEN_WAIT_MS = 3_000;
/** One `interactWithNpc` call against a wanderer, bounded: attempts x (poll + open wait) =
 *  8 x (20 s + 3 s) = 184 s. Every caller's test timeout must cover this plus its own work. */
export const WANDER_TALK_BUDGET_MS =
  WANDER_NPC_MAX_ATTEMPTS * (WANDER_NPC_WAIT_MS + WANDER_OPEN_WAIT_MS);

interface InReachOpts {
  /** The tile the character holds. */
  readonly stand: Tile;
  /** The way it faces. */
  readonly facing: Dir;
  /** Character entity ids that are never the NPC (the players). The own id is always skipped. */
  readonly ignoreEntityIds?: readonly string[];
  /** When set, `#interact-prompt` must read exactly this in the SAME poll that sees the NPC. */
  readonly chip?: string;
  readonly timeoutMs: number;
}

/** Resolves true once, in ONE page-side poll at a bare world base, the character stands on
 *  `stand` facing `facing` and a non-player character is in A's reach: on the faced tile
 *  `stepTile(stand, facing)` or on `stand` itself (the two tiers of game-core
 *  `interact_candidates`), plus the chip check; false on timeout. `__game().characters` carries
 *  no zone, so callers pick posts whose two reach tiles no NPC of another zone can occupy (each
 *  spec's WORLD FACTS say why). */
async function waitForNpcInReach(page: Page, o: InReachOpts): Promise<boolean> {
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
      }) => {
        const g = (window as unknown as { __game: () => GameHook }).__game();
        if (g.stack.length !== 1) return false;
        const t = g.ownAuthTile;
        if (t === null || t.x !== a.sx || t.y !== a.sy) return false;
        const own = g.characters.find((c) => c.entityId === g.ownEntityId);
        if (own === undefined || own.facing !== a.facing) return false;
        const npcInReach = g.characters.some(
          (c) =>
            c.entityId !== g.ownEntityId &&
            !a.ignore.includes(c.entityId) &&
            ((c.tileX === a.fx && c.tileY === a.fy) || (c.tileX === a.sx && c.tileY === a.sy)),
        );
        if (!npcInReach) return false;
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
  /** The exact chip text expected while the NPC is in reach (see `interactChip`). */
  readonly chip?: string;
  /** A presses before giving up. 1 for a stationary NPC (no retry needed or allowed). */
  readonly maxAttempts: number;
  /** Per attempt: how long to wait for the NPC to be in reach. */
  readonly npcWaitMs?: number;
  /** Per attempt: how long `opened` may take after the press (a server round trip). */
  readonly openWaitMs?: number;
  readonly label: string;
}

/** Talks to an NPC the way a player does now: hold a post FACING a tile the NPC stands on (or
 *  wanders through), and press A while it is in reach — on that faced tile or on the post
 *  itself. Each attempt re-faces first (`faceTile`, a walk only if the character was displaced),
 *  asserts the post and the facing, waits — in one page-side poll on the live
 *  `__game().characters` — for the NPC in reach at a bare world base, presses A once, and waits
 *  for `opened`. A wandering NPC can step away between the poll and the keydown, so attempts are
 *  bounded by `maxAttempts`. Returns the attempts used. */
export async function interactWithNpc(page: Page, o: InteractOpts): Promise<number> {
  const npcWaitMs = o.npcWaitMs ?? WANDER_NPC_WAIT_MS;
  const openWaitMs = o.openWaitMs ?? WANDER_OPEN_WAIT_MS;
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
    const inReach = await waitForNpcInReach(page, {
      stand: o.stand,
      facing: o.facing,
      ignoreEntityIds: o.ignoreEntityIds,
      chip: o.chip,
      timeoutMs: npcWaitMs,
    });
    if (!inReach) continue;
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
        : ` (expected ${JSON.stringify(o.chip)} while the NPC is in reach)`),
  );
}

// ---------------------------------------------------------------------------------------------
// bt-12 (BT12.5): the tactical battle helpers. They read the DEV `__mrTactics` hook (read-only: the
// local player's tactical rows and the own monsters' HP) and the shell's DOM, and press virtual
// buttons through `pressButton`; nothing here calls a reducer.
// ---------------------------------------------------------------------------------------------

/** The `__mrTactics.battle()` snapshot (bigints as decimal strings), or null without a battle. */
export interface TacticsSnap {
  battleId: string;
  phase: string;
  round: number;
  turnIdx: number;
  initiative: number[];
  activeUnitId: number | null;
  turnState: string;
  owner: 'legacy' | 'deploy' | 'tactical' | 'results' | null;
  events: number;
  deadlineMs: string | null;
  /** bt-15 (API freeze): the tactical row's kind and format, and each side's AutoPass strikes (the
   *  clock rows' `autopassCount`). */
  kind: 'Wild' | 'Pvp' | 'Practice';
  format: number;
  strikes: { A: number; B: number };
  units: {
    unitId: number;
    side: 'A' | 'B';
    mine: boolean;
    x: number;
    y: number;
    curHp: number;
    maxHp: number;
    state: string;
  }[];
}
export interface OwnMonsterHp {
  monsterId: string;
  currentHp: number;
  maxHp: number;
  partySlot: number;
}
type TacticsWindow = Window & {
  __mrTactics?: { battle(): TacticsSnap | null; ownMonsters(): OwnMonsterHp[] };
};

export const readTactics = (page: Page): Promise<TacticsSnap | null> =>
  page.evaluate(() => {
    const hook = (window as unknown as TacticsWindow).__mrTactics;
    if (hook === undefined)
      throw new Error('readTactics: window.__mrTactics is missing (DEV only)');
    return hook.battle();
  });

export const readOwnMonsters = (page: Page): Promise<OwnMonsterHp[]> =>
  page.evaluate(() => {
    const hook = (window as unknown as TacticsWindow).__mrTactics;
    if (hook === undefined) throw new Error('readOwnMonsters: window.__mrTactics is missing');
    return hook.ownMonsters();
  });

/** The shell's DOM, by class (the tactical views are constructed roots under #app). */
export const TACTICS = {
  shell: '.tactics-battle',
  deploy: '.tactics-deploy',
  results: '.tactics-results',
  menuRow: (key: string): string => `.tactics-menu-row[data-row="${key}"]`,
  cursorTile: '.tactics-tile--cursor',
  bandTile: '.tactics-tile--reach1, .tactics-tile--reach2',
  forecast: '.tactics-forecast',
  ghost: '.tactics-ghost',
  wildRow: '.tactics-deploy-wild',
} as const;

/** The tile under the shell's cursor, read from the painted board. */
export async function readCursorTile(page: Page): Promise<Tile> {
  const tile = page.locator(TACTICS.cursorTile).first();
  const x = Number(await tile.getAttribute('data-x'));
  const y = Number(await tile.getAttribute('data-y'));
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    throw new Error('readCursorTile: the board paints no cursor tile');
  }
  return { x, y };
}

/** The painted band (Move aim) tiles, in DOM order. */
export async function readBandTiles(page: Page): Promise<Tile[]> {
  const tiles = await page.locator(TACTICS.bandTile).all();
  const out: Tile[] = [];
  for (const t of tiles) {
    out.push({
      x: Number(await t.getAttribute('data-x')),
      y: Number(await t.getAttribute('data-y')),
    });
  }
  return out;
}

/** Walk the shell's cursor to `to` one D-pad press at a time, re-reading the painted cursor after
 *  every press (never a blind count). Bounded by `maxPresses` (a 7x5 board needs at most 10). */
export async function dpadCursorTo(page: Page, to: Tile, maxPresses = 24): Promise<void> {
  for (let presses = 0; presses <= maxPresses; presses += 1) {
    const at = await readCursorTile(page);
    if (at.x === to.x && at.y === to.y) return;
    if (presses === maxPresses) {
      throw new Error(`dpadCursorTo: cursor stuck at (${at.x},${at.y}) short of (${to.x},${to.y})`);
    }
    const button: VButton =
      at.x < to.x ? 'Right' : at.x > to.x ? 'Left' : at.y < to.y ? 'Down' : 'Up';
    await pressButton(page, button);
    await expect
      .poll(
        async () => {
          const now = await readCursorTile(page);
          return `${now.x},${now.y}`;
        },
        { timeout: 2_000 },
      )
      .not.toBe(`${at.x},${at.y}`)
      .catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// bt-15 (BT15.1, BT15.4): read-only PvP secrecy probes over the DEV `__mrTactics` hook, and the
// deploy confirm pressed by buttons. Nothing here calls a reducer (`armRowProbe` only starts the
// page's own callback counter).
// ---------------------------------------------------------------------------------------------

/** `__mrTactics.secrecy()`: the raw own-scoped deploy / queue rows the SDK cache holds. */
export interface Secrecy {
  me: string;
  deploys: { owner: string; locked: boolean; picks: number }[];
  queues: { owner: string; unitId: number }[];
  present: Record<string, boolean>;
}
/** One transcript entry of the shown battle: the payload tag, its unit (or null) and, for the
 *  BattleEnd entry, the `how` tag. */
export interface EventTag {
  tag: string;
  unit: number | null;
  how: string | null;
}
type PvpProbeWindow = Window & {
  __mrTactics?: {
    secrecy(): Secrecy;
    armRowProbe(): void;
    rowProbe(): { deploy: number; queue: number };
    eventTags(): EventTag[];
  };
};

const tacticsHook = <T>(page: Page, what: string, read: string): Promise<T> =>
  page.evaluate(
    ({ what: w, read: r }) => {
      const hook = (window as unknown as PvpProbeWindow).__mrTactics as
        | Record<string, () => unknown>
        | undefined;
      const fn = hook?.[r];
      if (typeof fn !== 'function') throw new Error(`${w}: __mrTactics.${r} is missing (DEV only)`);
      return fn.call(hook) as never;
    },
    { what, read },
  );

export const readSecrecy = (page: Page): Promise<Secrecy> =>
  tacticsHook<Secrecy>(page, 'readSecrecy', 'secrecy');
export const armRowProbe = (page: Page): Promise<void> =>
  tacticsHook<void>(page, 'armRowProbe', 'armRowProbe');
export const readRowProbe = (page: Page): Promise<{ deploy: number; queue: number }> =>
  tacticsHook<{ deploy: number; queue: number }>(page, 'readRowProbe', 'rowProbe');
export const readEventTags = (page: Page): Promise<EventTag[]> =>
  tacticsHook<EventTag[]>(page, 'readEventTags', 'eventTags');

/** Presses the deploy confirm screen's Deploy by buttons: Up until the `deploy` row is selected
 *  (bounded by the two rows), then A. Fails when the row is refused (`aria-disabled`). */
export async function deployByButtons(page: Page, label: string): Promise<void> {
  const row = page.locator(`${TACTICS.deploy} [data-row="deploy"]`);
  await expect(row, `${label}: the Deploy row is painted`).toHaveCount(1, { timeout: 20_000 });
  if ((await row.getAttribute('aria-disabled')) === 'true') {
    throw new Error(`${label}: the Deploy row is refused (aria-disabled)`);
  }
  for (let presses = 0; presses < 3; presses += 1) {
    if ((await row.getAttribute('aria-selected')) === 'true') break;
    await pressButton(page, 'Up');
  }
  await expect(row, `${label}: the cursor is on Deploy`).toHaveAttribute('aria-selected', 'true', {
    timeout: 2_000,
  });
  await pressButton(page, 'A');
}

/** Walk the open tactical menu's cursor to the row `key` with Down presses, bounded by the row
 *  count; fails naming the row when it is absent or greyed (`aria-disabled`). */
export async function menuCursorTo(page: Page, key: string): Promise<void> {
  const row = page.locator(TACTICS.menuRow(key));
  await expect(row, `the menu offers the ${key} row`).toHaveCount(1, { timeout: 5_000 });
  if ((await row.getAttribute('aria-disabled')) === 'true') {
    throw new Error(`menuCursorTo: the ${key} row is greyed`);
  }
  const rows = await page.locator('.tactics-menu-row').count();
  for (let presses = 0; presses <= rows; presses += 1) {
    if ((await row.getAttribute('aria-selected')) === 'true') return;
    if (presses === rows) throw new Error(`menuCursorTo: Down never reached the ${key} row`);
    await pressButton(page, 'Down');
  }
}

// ---------------------------------------------------------------------------------------------
// bt-16 (BT16.2): the shared tactical-battle drivers. The cutover made every live battle tactical
// (a grass step opens a tactical WILD battle; accepting a challenge opens a tactical PVP battle in
// Deploying), so every migrated spec drives its battle through these. Lifted from
// tactics-wild.spec.ts (bt-12) and pvp-side-b.spec.ts's accept path, generalised: the enemy is any
// unit on the OTHER side (a PvP accepter is side B), and every wait has a numeric bound and a
// failure message naming it. They read only `__mrTactics` / `__game` / the DOM and press virtual
// buttons; NOTHING here calls a reducer.
// ---------------------------------------------------------------------------------------------

/** How long a started battle's tactical row may take to reach the page. */
export const TACTICAL_START_MS = 20_000;
/** How long Deploying may take to become Active once this page pressed Deploy: the other side's
 *  lock (PvP) plus a batch; strictly under the 45 s PvP auto-fill, so a lock the buttons never
 *  sent fails here rather than being completed by the auto-fill. */
export const TACTICAL_ACTIVE_MS = 40_000;
/** The default bound on one wait for the next own live turn in a WILD battle (the AI's turns plus
 *  the presentation pad; measured ~1 s in bt-12). PvP callers pass their own (a 30 s window). */
export const OWN_TURN_WAIT_MS = 15_000;
/** How long an executed live commit may take to land in the store (the event count grows). */
export const EXECUTE_WAIT_MS = 15_000;
/** How long the results panel may take to show, and then to auto-advance to the world base. */
export const RESULTS_SHOW_MS = 20_000;
export const RESULTS_ADVANCE_MS = 20_000;
/** The bait list's no-bait row (tacticsBattle.ts `bait:none`); a held bait is `bait:<itemId>`. */
export const NO_BAIT_ROW = 'bait:none';
/** bt-16: the challenge accept path's waits (the banner, the Social cursor). */
const ACCEPT_UI_MS = 15_000;

type TacticalUnitSnap = TacticsSnap['units'][number];

const manhattanTiles = (a: Tile, b: Tile): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** The turn identity of a snapshot: battle, round and initiative index. */
export const turnKey = (t: TacticsSnap): string => `${t.battleId}:${t.round}:${t.turnIdx}`;

/** The CURRENT battle's tactical snapshot: `__mrTactics.battle()` unless the page's ongoing anchor
 *  names a different battle (the previous, finished battle is still the latest row for one batch),
 *  in which case null. */
const readCurrentTactics = (page: Page): Promise<TacticsSnap | null> =>
  page.evaluate(() => {
    const w = window as unknown as {
      __mrTactics?: { battle(): TacticsSnap | null };
      __game?: () => { ongoingBattle: { battleId: string } | null };
    };
    if (w.__mrTactics === undefined) throw new Error('readTactics: __mrTactics is missing (DEV)');
    const t = w.__mrTactics.battle();
    const ongoing = w.__game?.().ongoingBattle ?? null;
    if (t === null) return null;
    if (ongoing !== null && ongoing.battleId !== t.battleId) return null;
    return t;
  });

/**
 * Waits (≤ TACTICAL_START_MS) for the current battle's tactical row; when it is `Deploying`,
 * presses Deploy by buttons (`deployByButtons`) unless this side's Deploy row is already refused
 * (locked: an earlier call deployed it); then waits (≤ TACTICAL_ACTIVE_MS) for `Active`. Returns
 * the Active snapshot, or a `Finished` one when the battle ended first. Idempotent on an Active
 * battle. Callers that need BOTH PvP sides Active run it on both pages CONCURRENTLY (each presses
 * its own Deploy; the second lock flips the phase).
 */
export async function awaitTacticalActive(page: Page, label: string): Promise<TacticsSnap> {
  let seen: TacticsSnap | null = null;
  await expect
    .poll(
      async () => {
        seen = await readCurrentTactics(page);
        return seen !== null;
      },
      {
        message: `${label}: the battle's tactical row reaches the page within ${TACTICAL_START_MS} ms`,
        timeout: TACTICAL_START_MS,
      },
    )
    .toBe(true);
  // `seen` is written inside the poll closure, which control-flow analysis does not follow.
  const first = seen as TacticsSnap | null;
  if (first === null) throw new Error(`${label}: no tactical battle`);
  if (first.phase === 'Active' || first.phase === 'Finished') return first;
  if (first.phase === 'Deploying') {
    const row = page.locator(`${TACTICS.deploy} [data-row="deploy"]`);
    await expect(row, `${label}: the deploy panel paints its Deploy row`).toHaveCount(1, {
      timeout: TACTICAL_START_MS,
    });
    if ((await row.getAttribute('aria-disabled')) !== 'true') {
      await deployByButtons(page, label);
    }
  }
  let last: TacticsSnap | null = null;
  await expect
    .poll(
      async () => {
        last = await readCurrentTactics(page);
        return last === null ? 'none' : last.phase;
      },
      {
        message: `${label}: battle ${first.battleId} reaches Active within ${TACTICAL_ACTIVE_MS} ms of the Deploy press`,
        timeout: TACTICAL_ACTIVE_MS,
      },
    )
    .toMatch(/^(Active|Finished)$/);
  const done = last as TacticsSnap | null;
  if (done === null) throw new Error(`${label}: the battle vanished while deploying`);
  return done;
}

/** Waits (≤ `timeoutMs`) for the next OWN live turn of the current battle — `Waiting` on one of
 *  this page's units with a turn key other than `afterKey` — or for `Finished`; returns that
 *  snapshot. Fails naming the bound. */
export async function waitOwnTurnOrEnd(
  page: Page,
  afterKey: string | null,
  timeoutMs: number,
): Promise<TacticsSnap> {
  await page
    .waitForFunction(
      (prev: string | null) => {
        const w = window as unknown as {
          __mrTactics?: { battle(): TacticsSnap | null };
          __game?: () => { ongoingBattle: { battleId: string } | null };
        };
        const t = w.__mrTactics?.battle() ?? null;
        if (t === null) return false;
        const ongoing = w.__game?.().ongoingBattle ?? null;
        if (ongoing !== null && ongoing.battleId !== t.battleId) return false;
        if (t.phase === 'Finished') return true;
        if (t.phase !== 'Active' || t.turnState !== 'Waiting') return false;
        const unit = t.units.find((u) => u.unitId === t.activeUnitId);
        if (unit === undefined || !unit.mine) return false;
        return `${t.battleId}:${t.round}:${t.turnIdx}` !== prev;
      },
      afterKey,
      { timeout: timeoutMs },
    )
    .catch((err: unknown) => {
      throw new Error(
        `waitOwnTurnOrEnd: no own live turn (after ${afterKey ?? 'none'}) and no finish within ` +
          `${timeoutMs} ms: ${(err as Error).message}`,
      );
    });
  const t = await readTactics(page);
  if (t === null) throw new Error('waitOwnTurnOrEnd: the battle vanished');
  return t;
}

/** The active OWN unit of `t` and the nearest conscious ENEMY (any unit on the other side). */
export function sides(t: TacticsSnap): { me: TacticalUnitSnap; enemy: TacticalUnitSnap } {
  const me = t.units.find((u) => u.unitId === t.activeUnitId);
  if (me === undefined || !me.mine) throw new Error('sides: no active own unit');
  const enemies = t.units.filter((u) => u.side !== me.side && u.state === 'Active');
  enemies.sort((a, b) => manhattanTiles(a, me) - manhattanTiles(b, me));
  const enemy = enemies[0];
  if (enemy === undefined) throw new Error('sides: no conscious enemy unit');
  return { me, enemy };
}

/** The Manhattan distance between two tiles (the board's adjacency is distance 1). */
export const tileDistance = manhattanTiles;

/** Lets a playing beat sequence drain (B is the skip key while one plays; idle with no draft it is
 *  a no-op), so the next press is an input and not a skip. */
export async function settle(page: Page): Promise<void> {
  const playing = page.locator(`${TACTICS.shell}.tactics-battle--playing`);
  if ((await playing.count()) > 0) {
    await pressButton(page, 'B');
    await expect(playing, 'settle: B drained the playback').toHaveCount(0, { timeout: 5_000 });
  }
}

/** Opens the own unit's command menu: the cursor on `tile` (its unit), then A. */
export async function openMenu(page: Page, tile: Tile): Promise<void> {
  await settle(page);
  await dpadCursorTo(page, tile);
  await pressButton(page, 'A');
  await expect(
    page.locator('.tactics-menu'),
    'openMenu: A on the own unit opens its menu',
  ).toHaveCount(1, { timeout: 5_000 });
}

/** From the OPEN ROOT menu: Move → A opens the Move aim (the menu gone, the band painted) and
 *  returns the band's tiles in DOM order. Null, with the menu still at its root, when the Move row is
 *  absent or greyed (boxed in). */
async function openMoveAim(page: Page): Promise<Tile[] | null> {
  const moveRow = page.locator(TACTICS.menuRow('move'));
  if ((await moveRow.count()) !== 1 || (await moveRow.getAttribute('aria-disabled')) === 'true') {
    return null;
  }
  await menuCursorTo(page, 'move');
  await pressButton(page, 'A');
  await expect(
    page.locator('.tactics-menu'),
    'openMoveAim: the Move aim replaces the menu',
  ).toHaveCount(0, { timeout: 5_000 });
  await expect(
    page.locator(TACTICS.bandTile).first(),
    'openMoveAim: the Move aim paints a band',
  ).toBeVisible({ timeout: 5_000 });
  return readBandTiles(page);
}

/** The band's tiles nearest `target` first (Manhattan; ties in DOM order), the target's own tile
 *  excluded — the ONE ordering every Move helper here steps by. */
const nearestFirst = (band: Tile[], target: Tile): Tile[] => {
  const open = band.filter((tile) => !(tile.x === target.x && tile.y === target.y));
  open.sort((a, b) => manhattanTiles(a, target) - manhattanTiles(b, target));
  return open;
};

/** From the OPEN Move aim: the cursor to `dest`, A — the drafted, reversible Move (its ghost
 *  appears; the shell is idle with the cursor on `dest`). */
async function confirmMoveTo(page: Page, dest: Tile): Promise<void> {
  await dpadCursorTo(page, dest);
  await pressButton(page, 'A');
  await expect(
    page.locator(TACTICS.ghost),
    'confirmMoveTo: A drafts the Move (its ghost)',
  ).toHaveCount(1, { timeout: 5_000 });
}

/** Move (from the OPEN ROOT menu): the band tile nearest `target`, confirmed with A (a drafted,
 *  reversible Move — its ghost appears). False, with the menu back at its root, when the Move row is
 *  greyed (boxed in) or the band offers no tile. */
export async function draftMoveToward(page: Page, target: Tile): Promise<boolean> {
  const band = await openMoveAim(page);
  if (band === null) return false;
  const dest = nearestFirst(band, target)[0];
  if (dest === undefined) {
    await pressButton(page, 'B'); // leave the aim: back to the root menu
    return false;
  }
  await confirmMoveTo(page, dest);
  return true;
}

/** Undoes a drafted Move from the OPEN ROOT menu: B closes the menu (idle), B pops the last chip.
 *  The menu must be GONE before the pop press (while a beat plays, B is the skip key, not the pop)
 *  and the ghost gone after it, so a race shows up here by name instead of as a doubled draft. */
async function undoDraft(page: Page): Promise<void> {
  await pressButton(page, 'B');
  await expect(page.locator('.tactics-menu'), 'undoDraft: B closes the root menu').toHaveCount(0, {
    timeout: 5_000,
  });
  await settle(page);
  await pressButton(page, 'B');
  await expect(
    page.locator(TACTICS.ghost),
    'undoDraft: B pops the drafted Move (its ghost)',
  ).toHaveCount(0, { timeout: 5_000 });
}

/** The most band tiles `moveThenAttackByButtons` drafts before it gives up on firing this turn: the
 *  ring adjacent to the enemy (≤ 4 tiles) plus the distance-2 ring (≤ 8) — where a melee or a
 *  range-2 skill fires from — not the whole band, which runs to ~40 tiles for a 6-point stride on
 *  an 8x8 board. A turn that can fire from nowhere then costs ≤ ~12 s (measured ≤ 1 s per try), so
 *  sixteen such turns still reach `fightToOutcome`'s NAMED throw inside its callers' test budgets
 *  (battle-dpad 240 s, E2 420 s) instead of a trace-less Playwright timeout. */
const MAX_MOVE_TRIES = 12;

/**
 * Move then Skill in ONE turn, by buttons — the game's answer to a foe out of reach (and to a
 * kiting wild). From the OPEN ROOT menu of the own live turn with NO draft: the band tiles nearest
 * `enemy` first (`nearestFirst`, the `draftMoveToward` order), and per tile Move → the aim → A on the
 * tile (the drafted Move's ghost) → the menu re-opened on `me`'s LIVE tile → `attackByButtons` from
 * the ghost: the Skills row and its rows read the ghost tile and the budget left after the Move
 * (tactics/commandModel.ts), so no range or AP arithmetic lives here. The first tile a skill fires
 * from wins — `hit: 'attacked'`, `dest` that tile — and the commit `[Move, Skill]` executes on the
 * live turn, which stays live for the caller's `waitExecuted` + `endTurn`. A tile that fires nothing
 * (`none`, or `kills` under `allowKo: false`) is undone (`undoDraft`) and the next is tried, at most
 * MAX_MOVE_TRIES. When none fires, the nearest tile is re-drafted through `draftMoveToward` (the
 * step-toward of old, the shell idle on the draft) and `hit` is the last result. `dest: null`, the
 * menu at its root, when the Move row is greyed or the band is empty.
 */
export async function moveThenAttackByButtons(
  page: Page,
  me: Tile,
  enemy: Tile,
  opts: { allowKo: boolean; enemyHp: number },
): Promise<{ hit: 'attacked' | 'kills' | 'none'; dest: Tile | null; tries: number }> {
  const band = await openMoveAim(page);
  if (band === null) return { hit: 'none', dest: null, tries: 0 };
  const candidates = nearestFirst(band, enemy);
  if (candidates.length === 0) {
    await pressButton(page, 'B'); // leave the aim: back to the root menu
    return { hit: 'none', dest: null, tries: 0 };
  }
  // The aim stays open for the first try; every later try re-opens it from the root menu.
  let hit: 'attacked' | 'kills' | 'none' = 'none';
  let tries = 0;
  for (const dest of candidates.slice(0, MAX_MOVE_TRIES)) {
    if (tries > 0 && (await openMoveAim(page)) === null) break;
    tries += 1;
    await confirmMoveTo(page, dest);
    await openMenu(page, me);
    hit = await attackByButtons(page, opts);
    if (hit === 'attacked') return { hit, dest, tries };
    await undoDraft(page);
    await openMenu(page, me);
  }
  // Nothing fires from anywhere in reach: step toward the foe as before (idle on the draft).
  const drafted = await draftMoveToward(page, enemy);
  return { hit, dest: drafted ? (candidates[0] ?? null) : null, tries };
}

/** Ends the own live turn: Start (End Turn — the live draft plus EndTurn) once playback drained. */
export async function endTurn(page: Page): Promise<void> {
  await settle(page);
  await pressButton(page, 'Start');
}

/** After a live commit landed on `turn`: Start (End Turn) ONLY while that turn is still ours. A
 *  commit that spends the whole budget — Move 2 strides + Light, Move 1 stride + Heavy: 6 AP — ends
 *  the turn server-side (`queue.rs`: `ap < min_action_cost` → EndTurn), and in that same transaction
 *  the wild acts and the NEXT own turn may already be Waiting, so a blind Start would end THAT turn
 *  (measured: the shell then refused the next commit as a duplicate send for the turn, and a later
 *  Start landed on the results panel and dismissed it). */
export async function endTurnIfLive(page: Page, turn: TacticsSnap): Promise<void> {
  const now = await readTactics(page);
  if (now === null || now.phase !== 'Active' || now.turnState !== 'Waiting') return;
  // A different key: the commit spent the turn, and the next one is not ours to end.
  if (turnKey(now) !== turnKey(turn)) return;
  await endTurn(page);
}

/** From the OPEN ROOT menu: Skills → the first offered skill → the forecast panel (hit %, min–max
 *  damage) → A commits the draft plus the hit on the live turn. With `allowKo: false` a forecast
 *  whose MAX damage reaches `enemyHp` is backed out (`kills`, nothing sent); with `allowKo: true`
 *  it is committed. `none`: no skill offered or no target in range (backed out to the root menu). */
export async function attackByButtons(
  page: Page,
  opts: { allowKo: boolean; enemyHp: number },
): Promise<'attacked' | 'kills' | 'none'> {
  // A greyed Skills row (no skill reaches any target: `outOfRange`) offers nothing to press.
  const skillsRow = page.locator(TACTICS.menuRow('skills'));
  await expect(skillsRow, 'attackByButtons: the root menu offers the Skills row').toHaveCount(1, {
    timeout: 5_000,
  });
  if ((await skillsRow.getAttribute('aria-disabled')) === 'true') return 'none';
  await menuCursorTo(page, 'skills');
  await pressButton(page, 'A');
  const skill = page
    .locator('.tactics-menu-row[data-row^="skill:"]:not([aria-disabled="true"])')
    .first();
  const offered = await skill
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!offered) {
    await pressButton(page, 'B'); // the skills list → the root menu
    return 'none';
  }
  const key = await skill.getAttribute('data-row');
  if (key === null) throw new Error('attackByButtons: a skill row without a key');
  await menuCursorTo(page, key);
  await pressButton(page, 'A');
  const forecast = page.locator(TACTICS.forecast);
  const aimed = await forecast
    .waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true)
    .catch(() => false);
  if (!aimed) {
    await pressButton(page, 'B'); // no target in range: the list stays → the root menu
    return 'none';
  }
  const text = (await forecast.textContent()) ?? '';
  expect(text, 'attackByButtons: the forecast carries a hit percentage').toMatch(/\d+ ?%/);
  const damage = /(\d+)[–-](\d+) damage/.exec(text);
  const max = damage === null ? null : Number(damage[2]);
  if (!opts.allowKo && (max === null || max >= opts.enemyHp)) {
    await pressButton(page, 'B'); // the aim → the skills list
    await pressButton(page, 'B'); // → the root menu
    return 'kills';
  }
  await pressButton(page, 'A'); // commits [draft…, Skill] on the live turn
  return 'attacked';
}

/** From the OPEN ROOT menu: Recruit → the bait row `baitKey` (`bait:<itemId>` or `NO_BAIT_ROW`) →
 *  the aim (the forecast with the odds) → A. False, nothing pressed, when the Recruit row is absent
 *  or greyed (not adjacent, or the budget is not full). Throws, naming the bag, when the opened
 *  bait list offers no `baitKey` row (every live Recruit debits one bait, success or not). */
export async function recruitByButtons(page: Page, baitKey: string): Promise<boolean> {
  const row = page.locator(TACTICS.menuRow('recruit'));
  if ((await row.count()) !== 1 || (await row.getAttribute('aria-disabled')) === 'true') {
    return false;
  }
  await menuCursorTo(page, 'recruit');
  await pressButton(page, 'A');
  await expect(
    page.locator(TACTICS.menuRow(NO_BAIT_ROW)),
    'recruitByButtons: Recruit opens the bait list',
  ).toHaveCount(1, { timeout: 5_000 });
  if (baitKey !== NO_BAIT_ROW && (await page.locator(TACTICS.menuRow(baitKey)).count()) === 0) {
    throw new Error(
      `recruitByButtons: the bait list offers no ${baitKey} row — the bag holds none of that item (a live Recruit debits one bait, success or not)`,
    );
  }
  await menuCursorTo(page, baitKey);
  await pressButton(page, 'A');
  await expect(
    page.locator(TACTICS.forecast),
    'recruitByButtons: the recruit aim shows its odds',
  ).toHaveCount(1, { timeout: 5_000 });
  await pressButton(page, 'A');
  return true;
}

/** Flee by buttons, ONLY in `Active` (Deploying has no menu: deploy first). With no menu open it
 *  first waits (≤ OWN_TURN_WAIT_MS) for the next own live turn and opens the active unit's menu;
 *  then the root menu's `flee` row → A. Fails naming a Deploying or Finished battle. */
export async function fleeByButtons(page: Page): Promise<void> {
  const now = await readTactics(page);
  if (now === null) throw new Error('fleeByButtons: no tactical battle');
  if (now.phase === 'Deploying') throw new Error('fleeByButtons: Deploying — deploy first');
  if ((await page.locator('.tactics-menu').count()) === 0) {
    const t = await waitOwnTurnOrEnd(page, null, OWN_TURN_WAIT_MS);
    if (t.phase !== 'Active') throw new Error(`fleeByButtons: the battle is ${t.phase}`);
    const me = t.units.find((u) => u.unitId === t.activeUnitId);
    if (me === undefined) throw new Error('fleeByButtons: no active own unit');
    await openMenu(page, me);
  }
  await menuCursorTo(page, 'flee');
  await pressButton(page, 'A');
}

/** Waits for the battle's event count to grow past `events` (a live commit executed and landed) or
 *  for `Finished`, bounded by EXECUTE_WAIT_MS. */
export async function waitExecuted(page: Page, events: number): Promise<void> {
  await page
    .waitForFunction(
      (n: number) => {
        const hook = (window as unknown as { __mrTactics?: { battle(): TacticsSnap | null } })
          .__mrTactics;
        const t = hook?.battle() ?? null;
        return t !== null && (t.events > n || t.phase === 'Finished');
      },
      events,
      { timeout: EXECUTE_WAIT_MS },
    )
    .catch((err: unknown) => {
      throw new Error(
        `waitExecuted: the commit did not land (events stayed at ${events}) within ` +
          `${EXECUTE_WAIT_MS} ms: ${(err as Error).message}`,
      );
    });
}

/** Waits (≤ RESULTS_SHOW_MS) for the results panel and its title, reads its text, lets it advance
 *  (≤ RESULTS_ADVANCE_MS: main.ts auto-continues it) and expects the world base back. Returns the
 *  panel's text (the outcome title and the reward lines). */
export async function throughResults(page: Page, label: string): Promise<string> {
  await expect(page.locator(TACTICS.results), `${label}: the results panel shows`).toBeVisible({
    timeout: RESULTS_SHOW_MS,
  });
  await expect(page.locator(`${TACTICS.results} [data-testid="battle-title"]`)).toBeVisible();
  const text = (await page.locator(TACTICS.results).textContent()) ?? '';
  await expect
    .poll(async () => (await readWorld(page)).stackLength, {
      message: `${label}: the results panel advances to the world base within ${RESULTS_ADVANCE_MS} ms`,
      timeout: RESULTS_ADVANCE_MS,
    })
    .toBe(1);
  await expect(page.locator(TACTICS.results), `${label}: the results panel closed`).toBeHidden();
  return text;
}

/**
 * Fights the current Active battle to its end by buttons: on each own live turn the menu opens; an
 * enemy within a skill's reach is attacked (`attackByButtons({ allowKo: true })`) and the turn
 * ended; else the unit Moves then fires from the ghost tile in the same turn
 * (`moveThenAttackByButtons` — the answer to a kiting wild, which steps out of reach whenever we end
 * adjacent) and ends the turn; when no band tile fires either, it has stepped toward the nearest
 * enemy and the turn is ended. Stops at `Finished` (never pressing Start into the results panel)
 * and returns that snapshot. Throws naming `maxOwnTurns` when the bound is spent; the throw also
 * carries the per-turn trace — per own turn the round:turnIdx, both units' tiles and HP, their
 * distance, the start-tile hit result (`attacked` / `none`), the Move (`move:(x,y)+attacked tries:N`
 * when a skill fired from the ghost, `move:drafted(x,y) tries:N` when only the step toward was left,
 * `move:none` when boxed in) and the turn's wall time — so a dead-button stall (a leftover draft,
 * cursor or lock: nothing commits) is distinguishable from a changed AI in the CI log. Each wait for
 * an own turn is bounded by `turnWaitMs` (default OWN_TURN_WAIT_MS).
 */
export async function fightToOutcome(
  page: Page,
  opts: { maxOwnTurns: number; label: string; turnWaitMs?: number },
): Promise<TacticsSnap> {
  let last: string | null = null;
  const trace: string[] = [];
  for (let turn = 0; turn < opts.maxOwnTurns; turn += 1) {
    const t = await waitOwnTurnOrEnd(page, last, opts.turnWaitMs ?? OWN_TURN_WAIT_MS);
    if (t.phase === 'Finished') return t;
    // Test-side wall clock for the trace only (not a product clock).
    const turnStartedMs = Date.now();
    last = turnKey(t);
    const { me, enemy } = sides(t);
    const traceLine = (hit: string, moveNote: string): string =>
      `r${t.round}:${t.turnIdx} me(${me.x},${me.y})hp${me.curHp} ` +
      `enemy(${enemy.x},${enemy.y})hp${enemy.curHp}/${enemy.maxHp} d${tileDistance(me, enemy)} ` +
      `${hit}${moveNote} ${Date.now() - turnStartedMs}ms`;
    await openMenu(page, me);
    const hit = await attackByButtons(page, { allowKo: true, enemyHp: enemy.curHp });
    let fired = hit === 'attacked';
    let moveNote = '';
    if (!fired) {
      // Nothing reaches from the start tile: Move then Skill from a ghost tile (the kiter's answer).
      const moved = await moveThenAttackByButtons(page, me, enemy, {
        allowKo: true,
        enemyHp: enemy.curHp,
      });
      const at = moved.dest === null ? '' : `(${moved.dest.x},${moved.dest.y})`;
      fired = moved.hit === 'attacked';
      moveNote = fired
        ? ` move:${at}+attacked tries:${moved.tries}`
        : moved.dest === null
          ? ' move:none'
          : ` move:drafted${at} tries:${moved.tries}`;
    }
    if (fired) {
      // A live commit — [Skill] or [Move, Skill] — executes in ONE transaction (the wild's reply and
      // the next own turn included when it spent the budget), so the first new event is the step.
      await waitExecuted(page, t.events);
      const after = await readTactics(page);
      trace.push(traceLine(hit, moveNote));
      if (after === null || after.phase === 'Finished') return after ?? t;
      await endTurnIfLive(page, t);
      continue;
    }
    await endTurn(page); // the step-toward draft (if any) plus EndTurn
    trace.push(traceLine(hit, moveNote));
  }
  const end = await readTactics(page);
  if (end !== null && end.phase === 'Finished') return end;
  throw new Error(
    `${opts.label}: the battle did not finish within maxOwnTurns=${opts.maxOwnTurns} own turns` +
      ` — trace: ${trace.join(' | ')}`,
  );
}

/**
 * The challenged player's production accept path (pvp-side-b.spec.ts, qf-8 QF8.3): the incoming
 * challenge's `#notice-banner` shows, P opens Social on Challenges with the cursor on the request
 * (`aria-current`), A opens its sheet on Accept, A accepts. Returns after the press (the caller
 * waits for the battle). Every wait ≤ ACCEPT_UI_MS.
 */
export async function acceptChallengeByButtons(pageB: Page): Promise<void> {
  await expect(
    pageB.locator('#notice-banner'),
    'accept: the incoming challenge banner shows',
  ).toBeVisible({ timeout: ACCEPT_UI_MS });
  await pressAccel(pageB, 'P');
  await expect(
    pageB.locator('#pvp-challenge-incoming[aria-current="true"]'),
    'accept: Social opens on the incoming request',
  ).toBeVisible({ timeout: ACCEPT_UI_MS });
  await pressButton(pageB, 'A');
  await expect(
    pageB.locator('#social-sheet [aria-selected="true"]'),
    'accept: the request sheet opens on Accept',
  ).toHaveText('Accept', { timeout: ACCEPT_UI_MS });
  await pressButton(pageB, 'A');
}

/** Face to face, A challenges B (`openFaceToFace`: the size pick's first row) and B accepts by
 *  buttons; returns once both pages show the PvP battle's tactical row in `Deploying` (each bounded
 *  by TACTICAL_START_MS). Neither side deploys (tactics-pvp's secrecy oracles run in Deploying). */
export async function challengeAndAcceptByButtons(
  pageA: Page,
  pageB: Page,
  nameB: string | undefined,
  label: string,
): Promise<string> {
  await closeAll(pageA);
  await closeAll(pageB);
  await openFaceToFace(pageA, 'Challenge', nameB, pageB);
  await acceptChallengeByButtons(pageB);
  let ids: string[] = [];
  for (const [who, p] of [
    ['A', pageA],
    ['B', pageB],
  ] as const) {
    let seen: TacticsSnap | null = null;
    await expect
      .poll(
        async () => {
          seen = await readCurrentTactics(p);
          return seen === null ? 'none' : `${seen.kind}:${seen.phase}`;
        },
        {
          message: `${label}: ${who}'s page holds the PvP battle in Deploying within ${TACTICAL_START_MS} ms of the accept`,
          timeout: TACTICAL_START_MS,
        },
      )
      .toMatch(/^Pvp:(Deploying|Active)$/);
    const s = seen as TacticsSnap | null;
    if (s === null) throw new Error(`${label}: ${who} has no battle`);
    ids = [...ids, s.battleId];
  }
  expect(ids[0], `${label}: both pages hold the SAME battle`).toBe(ids[1]);
  return ids[0] ?? '';
}

/** A challenges B face to face, B accepts by buttons, then BOTH pages deploy by buttons
 *  concurrently (`awaitTacticalActive`; the second lock flips the phase) and reach `Active`.
 *  Returns the battleId. */
export async function startPvpByButtons(
  pageA: Page,
  pageB: Page,
  nameB: string | undefined,
  label: string,
): Promise<string> {
  const battleId = await challengeAndAcceptByButtons(pageA, pageB, nameB, label);
  const [ta, tb] = await Promise.all([
    awaitTacticalActive(pageA, `${label} A`),
    awaitTacticalActive(pageB, `${label} B`),
  ]);
  expect(
    [ta.battleId, ta.phase, tb.battleId, tb.phase],
    `${label}: both pages reach Active on battle ${battleId}`,
  ).toEqual([battleId, 'Active', battleId, 'Active']);
  return battleId;
}

// ---------------------------------------------------------------------------------------------
// wap-10 (WAP10.1-WAP10.3): the D-pad walk. A player walks the world with the live-bound D-pad
// keys, not with `__game().step` (which sends the Step intent directly and skips the input path
// the art flow must also exercise). Nothing here calls `__game().step` or `jump`.
// ---------------------------------------------------------------------------------------------

/** The D-pad button a compass direction is pressed with (`stepTile`'s North is y - 1). */
export const DPAD_BUTTON: Readonly<Record<Dir, VButton>> = {
  North: 'Up',
  South: 'Down',
  East: 'Right',
  West: 'Left',
};

/** The direction facing back the way `d` came. */
export const oppositeDir = (d: Dir): Dir => OPPOSITE[d];

/** Walks `dirs` with the live-bound D-pad keys, one press per step, waiting for the
 *  AUTHORITATIVE own tile to land on `stepTile(from, dir)` before the next press (the `walkPath`
 *  outcome rules: 'battle' stops the walk; a step that lands elsewhere or never lands throws,
 *  naming the step; each step waits `STEP_SETTLE_MS` once and is never re-pressed). The world must
 *  be at its base: any open frame is closed first. */
export async function dpadWalkPath(
  page: Page,
  dirs: readonly Dir[],
  label: string,
): Promise<'arrived' | 'battle'> {
  for (const dir of dirs) {
    if ((await readWorld(page)).stackLength > 1) await closeAll(page);
    // No text field or button may hold the keyboard focus: the press must reach the world.
    await page.evaluate(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active !== document.body) active.blur();
    });
    const before = await readWorld(page);
    if (before.battle) return 'battle';
    const from = before.ownAuthTile;
    if (from === null) throw new Error(`${label}: no authoritative own tile before ${dir}`);
    const want = stepTile(from, dir);
    // ONE press per step: a Step always turns AND moves onto a walkable tile (FACING FACTS), so a
    // second press on a slow server would send a second step and the walk would drift.
    await pressButton(page, DPAD_BUTTON[dir]);
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
      .catch(() => null);
    if (outcome === null) {
      throw new Error(
        `${label}: D-pad ${DPAD_BUTTON[dir]} (${dir}) from ${tileName(from)} did not land within ` +
          `${STEP_SETTLE_MS} ms`,
      );
    }
    if (outcome === 'battle') return 'battle';
    const after = await readWorld(page);
    if (!sameTile(after.ownAuthTile, want)) {
      throw new Error(
        `${label}: D-pad ${dir} from ${tileName(from)} landed on ${tileName(after.ownAuthTile)}, ` +
          `not ${tileName(want)} — re-derive the walk from the zone map`,
      );
    }
  }
  return 'arrived';
}

/** `safePath` (grass-free, warp-free) on the live zone map, then `dpadWalkPath`. */
export async function dpadWalkTo(
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
  return dpadWalkPath(page, path, label);
}
