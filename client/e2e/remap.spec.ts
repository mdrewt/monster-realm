import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import { CONTROLS_STORAGE_KEY } from '../src/input/bindingStore';
import { DEFAULT_BINDINGS } from '../src/input/bindings';
import { t, tf } from '../src/ui/i18n/resolver';
import {
  closeAll,
  faceTile,
  interactChip,
  liveBindings,
  pressButton,
  readChip,
  type Tile,
} from './controls';

// remap.spec.ts — the remap flow, played with the KEYBOARD ONLY (ctl-12b, CTL12B.1, CTL12B.2;
// the milestone's one e2e for the Remap flow).
//
//   Start, Down to Options, A, Down to Controls, A   the Controls frame opens above the menu
//   Down to the Confirm (A) row's Primary slot, A     the prompt "Press a key for Confirm (A)…"
//   K                                                  the slot shows K, mr.controls holds A := K
//   B, Up, Enter, K                                    WITHOUT a reload Enter opens nothing and K
//                                                      opens How to play
//   reload, Start, Enter, K                            after the reload K opens Monsters, Enter
//                                                      does not
//   face the healer                                    the chip reads `[K] Heal — <healer>`
//
// THE RED (the legacy behaviour this replaces): there is no Controls screen (Options holds How to
// play alone, so the second Down never reaches a Controls entry), and a saved table applied only
// after a reload (the keyboard source took its table at construction).
//
// Every virtual-button press goes through controls.ts `pressButton`, which presses the first key of
// the PAGE's live table (`liveBindings`: `localStorage['mr.controls']` through `parseBindings`), so
// after the remap `pressButton(page, 'A')` presses K. Raw `page.keyboard.press` is used only for
// the captured key (K) and for the "Enter no longer confirms" probes. Every wait polls observable
// state; there is no fixed sleep. An "Enter did nothing" read is taken right after the press: the
// keydown handler runs synchronously inside the dispatched event, so whatever Enter would open is
// already on `__game().stack` when `keyboard.press` resolves.
//
// WORLD FACTS (read from game-core/content this session):
//   heal_locations/000-core.ron: location 1, zone 0, tile (8,3).
//   zone_maps/000-core.ron, zone 0, row y=3 "#...##..~#": (6,3) and (7,3) are floor, (8,3) is grass.
//   So the post is (7,3) FACING East onto the healer's tile (8,3); `faceTile` arrives there by an
//   East step from (6,3) (a step sets the facing), on a grass-free, warp-free `safePath`, and never
//   steps onto the grass. npcs/000-core.ron: elder_oak, home (5,5), wander radius 2 (Manhattan:
//   menu-flow.spec.ts WORLD FACTS); (7,3) and (8,3) are 4 and 5 away, so no NPC shares the faced
//   tile or the post, and the chip offers exactly the heal.
//
// DETERMINISM. One browser, one context, one identity (the reload keeps the context, so it keeps
// `mr.controls`). No battle: the only walk is the grass-free `faceTile`. The test ends by removing
// `mr.controls` and reloading, so the page leaves the default table behind, and afterAll closes the
// browser so the server's on_disconnect deletes the player row before golden.spec.

/** U+2026, built from its code point (never a pasted character). */
const ELLIPSIS = String.fromCharCode(0x2026);
/** The criterion's prompt, in English. */
const PROMPT_A = `Press a key for Confirm (A)${ELLIPSIS}`;
/** The healer's post: facing East onto heal location 1 at (8,3) (see WORLD FACTS). */
const HEAL_POST: Tile = { x: 7, y: 3 };

interface Frame {
  kind: string;
  id?: string;
}
interface GameSnap {
  identity: string;
  ownAuthTile: Tile | null;
  stack: Frame[];
  navActive: string | null;
}

const snap = (p: Page): Promise<GameSnap> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => GameSnap }).__game();
    return {
      identity: g.identity,
      ownAuthTile: g.ownAuthTile,
      stack: g.stack,
      navActive: g.navActive,
    };
  });

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => GameSnap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null;
    },
    null,
    { timeout: 30_000 },
  );
}

/** The stack as base-first names: the base kind, then each upper frame's id. */
const stackNames = async (p: Page): Promise<string[]> =>
  (await snap(p)).stack.map(
    (f) => (f.kind === 'screen' || f.kind === 'prompt' ? f.id : f.kind) ?? f.kind,
  );

const navActive = async (p: Page): Promise<string | null> => (await snap(p)).navActive;

/** The Controls cursor: the `data-nav-key` of the `aria-selected` cell in `#controls-rows`. */
const controlsActive = (p: Page): Promise<string | null> =>
  p.evaluate(
    () =>
      document
        .querySelector('#controls-rows [aria-selected="true"]')
        ?.getAttribute('data-nav-key') ?? null,
  );

/** One Controls grid cell, by its `data-nav-key`. */
const cell = (p: Page, key: string): Locator => p.locator(`#controls-rows [data-nav-key="${key}"]`);

/** Down presses (each followed by a poll that the cursor moved) until `read` names `key`. */
async function downTo(
  p: Page,
  read: (p: Page) => Promise<string | null>,
  key: string,
  maxPresses: number,
  what: string,
): Promise<void> {
  for (let i = 0; i < maxPresses && (await read(p)) !== key; i += 1) {
    const before = await read(p);
    await pressButton(p, 'Down');
    await expect
      .poll(() => read(p), { message: `${what}: Down moves the cursor off ${before}` })
      .not.toBe(before);
  }
  expect(await read(p), `${what}: the cursor is on ${key}`).toBe(key);
}

test.describe
  .serial('CTL12B.2 — the remap flow, keyboard only', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      browser = await chromium.launch();
      ctx = await browser.newContext();
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('CTL12B-2-REMAP-FLOW: Options > Controls through the menu, the Confirm (A) Primary slot, A shows "Press a key for Confirm (A)...", K binds it; without a reload K confirms and Enter does not; after a reload K confirms and Enter does not; facing the healer, the chip shows the K keycap', async () => {
      test.setTimeout(120_000);

      // ---- precondition: a fresh context plays the default table --------------------------------
      expect(await liveBindings(page), 'precondition: nothing is saved yet').toEqual(
        DEFAULT_BINDINGS,
      );
      await closeAll(page);
      expect(await stackNames(page), 'precondition: the bare world').toEqual(['world']);

      // ---- 1. Start, Options, A, Controls, A: the Controls frame above the menu -----------------
      await pressButton(page, 'Start');
      await expect
        .poll(() => stackNames(page), { message: 'Start opens the menu' })
        .toEqual(['world', 'menuView']);
      await downTo(page, navActive, 'options', 8, 'the main menu');
      await pressButton(page, 'A');
      await expect
        .poll(() => navActive(page), { message: 'A enters Options on How to play' })
        .toBe('help');
      await pressButton(page, 'Down');
      await expect
        .poll(() => navActive(page), { message: 'Down moves onto Options > Controls' })
        .toBe('controls');
      await pressButton(page, 'A');
      await expect
        .poll(() => stackNames(page), { message: 'A on Controls opens it above the menu' })
        .toEqual(['world', 'menuView', 'controlsView']);
      await expect(page.locator('#controls-overlay'), 'the Controls frame is shown').toBeVisible();
      await expect(page.locator('#controls-tab-buttons'), 'on the Buttons tab').toHaveAttribute(
        'aria-selected',
        'true',
      );

      // ---- 2. to the Confirm (A) row's Primary slot; A: the prompt ------------------------------
      await downTo(page, controlsActive, 'A_0', 13, 'the Controls grid');
      await expect(cell(page, 'A_0'), 'the slot shows its key, Enter').toHaveText(
        tf('controls.slot.primary', { label: t('controls.button.a'), key: t('key.enter') }),
      );
      await pressButton(page, 'A');
      await expect(page.locator('#controls-capture'), 'A on the slot starts capture').toBeVisible();
      await expect(page.locator('#controls-capture'), 'the criterion`s prompt').toHaveText(
        PROMPT_A,
      );

      // ---- 3. K: bound, shown, saved ------------------------------------------------------------
      await page.keyboard.press('KeyK');
      await expect(cell(page, 'A_0'), 'the slot shows K').toHaveText(
        tf('controls.slot.primary', { label: t('controls.button.a'), key: 'K' }),
      );
      await expect(page.locator('#controls-capture'), 'the capture ended').toBeHidden();
      await expect(page.locator('#controls-feedback'), 'the bound line').toHaveText(
        t('controls.bound'),
      );
      await expect
        .poll(async () => (await liveBindings(page)).buttons.A, {
          message: 'mr.controls holds A := K, Numpad Enter kept as its Alt',
        })
        .toEqual(['KeyK', 'NumpadEnter']);

      // ---- 4. WITHOUT a reload: Enter does not confirm, K does ----------------------------------
      await pressButton(page, 'B');
      await expect
        .poll(() => stackNames(page), { message: 'B pops Controls back to the menu' })
        .toEqual(['world', 'menuView']);
      expect(await navActive(page), 'the Options list, on Controls').toBe('controls');
      await pressButton(page, 'Up');
      await expect.poll(() => navActive(page), { message: 'Up onto How to play' }).toBe('help');
      await page.keyboard.press('Enter');
      expect(await stackNames(page), 'Enter no longer confirms: How to play did not open').toEqual([
        'world',
        'menuView',
      ]);
      expect(await navActive(page), 'and the cursor did not move').toBe('help');
      await pressButton(page, 'A'); // the live table's A: K
      await expect
        .poll(() => stackNames(page), { message: 'K confirms: How to play opens, no reload' })
        .toEqual(['world', 'menuView', 'helpView']);
      await expect(page.locator('#help-overlay'), 'How to play is shown').toBeVisible();
      await closeAll(page);
      expect(await stackNames(page)).toEqual(['world']);

      // ---- 5. reload: K confirms, Enter does not ------------------------------------------------
      await page.reload();
      await ready(page);
      expect((await liveBindings(page)).buttons.A, 'the saved table survived the reload').toEqual([
        'KeyK',
        'NumpadEnter',
      ]);
      await closeAll(page);
      await pressButton(page, 'Start');
      await expect
        .poll(() => stackNames(page), { message: 'after the reload Start opens the menu' })
        .toEqual(['world', 'menuView']);
      expect(await navActive(page), 'a reloaded page opens the menu on Monsters').toBe('monsters');
      await page.keyboard.press('Enter');
      expect(await stackNames(page), 'after the reload Enter does not confirm').toEqual([
        'world',
        'menuView',
      ]);
      await pressButton(page, 'A'); // K
      await expect
        .poll(() => stackNames(page), { message: 'after the reload K confirms: Monsters opens' })
        .toEqual(['world', 'menuView', 'boxView']);
      await closeAll(page);
      expect(await stackNames(page)).toEqual(['world']);

      // ---- 6. the hint shows the new keycap -----------------------------------------------------
      expect(
        await faceTile(page, HEAL_POST, 'East', 'remap: face the healer'),
        'the walk to the healer`s post meets no battle',
      ).toBe('arrived');
      await expect
        .poll(() => readChip(page), {
          message: 'the chip in front of the healer shows the K keycap',
          timeout: 15_000,
        })
        .toBe(interactChip('Heal', t('interact.healer'), 'K'));

      // ---- 7. restore the default table: the context leaves nothing behind ----------------------
      await page.evaluate(
        (key: string) => window.localStorage.removeItem(key),
        CONTROLS_STORAGE_KEY,
      );
      await page.reload();
      await ready(page);
      expect(await liveBindings(page), 'the default table is back').toEqual(DEFAULT_BINDINGS);
    });
  });
