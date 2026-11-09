import AxeBuilder from '@axe-core/playwright';
import {
  type Browser,
  type BrowserContext,
  chromium,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { t } from '../src/ui/i18n/resolver';
import { closeAll, pressAccel, pressButton } from './controls';
import { parseRgb, sampleStyle } from './uiKit';

// ui-profile.spec.ts — uif-16b (M-ui-foundation): Profile is ONE screen, measured in Chromium.
// The main menu's Profile entry is a LEAF that opens one dialog (#profile-overlay) holding three
// always-shown sections — Name (#rename-overlay), Account (#claim-overlay), Privacy
// (#privacy-overlay) — then the frame's Close row (#profile-close-btn). The D-pad walks one column
// of rows across all three; B pops the frame back to the menu; N and C open it on their section.
//
// ORACLE RULE. Every state is read off the page: the stack through `__game().stack`, the menu cursor
// through `__game().navActive`, focus through `document.activeElement`, layout through bounding
// boxes and computed style. Expected ids are literals from the shipped markup; expected copy goes
// through the catalog's own `t()`. Nothing is read back from the module under test. Keys are pressed
// through `controls.ts` (the page's live table), except the arrow / Tab / Escape keys a text field
// owns natively, which are pressed by name because the test is ABOUT the field keeping them.
//
// HYGIENE. ONE browser context, ONE player, closed in afterAll (a second context would add a presence
// row; golden.spec.ts asserts an exact count). Each test opens what it needs from a closed base and
// ends with `closeAll`, so the tests do not depend on each other's order. No encounter, no battle,
// no RNG. Every wait polls a bounded predicate; the one fixed wait (a clamp proof: "nothing moved")
// says why where it is used. Nothing here confirms a decline or a deletion: arms are disarmed by
// the close path under test or by No / Keep.
//
// RED AT THE BASE (619f060d): Profile is a group, so A on it enters a Profile sub-list
// (`menuProfile-root-*`) instead of opening a frame, and the three sections are separate dialogs.

interface Frame {
  kind: string;
  id?: string;
  owner?: string;
}

interface GameSnap {
  identity: string;
  ownAuthTile: { x: number; y: number } | null;
  ownMonsters: Array<{ monsterId: string }>;
  stack: Frame[];
  navActive: string | null;
}

// WCAG 2.2 Level AA: the same tag set as a11y.spec.ts (spec §5.6) — nothing wider.
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** The root menu's keys in display order (menuModel.ts MENU_ENTRIES), for walking the cursor. */
const MENU_KEYS = ['monsters', 'bag', 'journal', 'social', 'profile', 'options', 'close'];

async function ready(p: Page): Promise<void> {
  await p.waitForFunction(
    () => {
      const w = window as unknown as { __game?: () => GameSnap };
      if (!w.__game) return false;
      const g = w.__game();
      return g.identity !== '' && g.ownAuthTile !== null && g.ownMonsters.length > 0;
    },
    null,
    { timeout: 30_000 },
  );
}

/** The stack as names: a screen or prompt by its id, a typing frame as `textEntry:<owner>`, else
 *  the frame kind (`world`, `battle`). */
const stackNames = (p: Page): Promise<string[]> =>
  p.evaluate(() => {
    const g = (window as unknown as { __game: () => { stack: Frame[] } }).__game();
    return g.stack.map((f) =>
      f.kind === 'screen' || f.kind === 'prompt'
        ? (f.id ?? f.kind)
        : f.kind === 'textEntry'
          ? `textEntry:${f.owner ?? ''}`
          : f.kind,
    );
  });

/** The stack without its typing frame (typing in the name field may push one). */
const frameNames = async (p: Page): Promise<string[]> =>
  (await stackNames(p)).filter((n) => !n.startsWith('textEntry:'));

const navActive = (p: Page): Promise<string | null> =>
  p.evaluate(() => (window as unknown as { __game: () => GameSnap }).__game().navActive);

/** What holds focus: its id, tag, top edge, which Profile section holds it (`close` for the Close
 *  row), whether it is inside the Profile root, rendered (a layout box, not visibility:hidden) and
 *  enabled. Null while focus is on the page. */
interface Focused {
  readonly id: string;
  readonly tag: string;
  readonly top: number;
  readonly section: 'name' | 'account' | 'privacy' | 'close' | null;
  readonly inProfile: boolean;
  readonly shown: boolean;
  readonly enabled: boolean;
}

const focused = (p: Page): Promise<Focused | null> =>
  p.evaluate((): Focused | null => {
    const el = document.activeElement;
    if (!(el instanceof HTMLElement) || el === document.body) return null;
    const section: Focused['section'] = el.closest('#rename-overlay')
      ? 'name'
      : el.closest('#claim-overlay')
        ? 'account'
        : el.closest('#privacy-overlay')
          ? 'privacy'
          : el.id === 'profile-close-btn'
            ? 'close'
            : null;
    // The top edge in the frame's CONTENT coordinates (its box top plus its scroll offset), so a
    // focus that scrolls a tall frame does not reorder rows that are in order on the page.
    const root = document.getElementById('profile-overlay');
    const inProfile = root?.contains(el) === true;
    const top =
      root !== null && inProfile
        ? el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop
        : el.getBoundingClientRect().top;
    return {
      id: el.id,
      tag: el.tagName,
      top,
      section,
      inProfile,
      shown: el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
      enabled: !(el as HTMLButtonElement).disabled,
    };
  });

const focusedId = async (p: Page): Promise<string> => (await focused(p))?.id ?? '(page)';

/** Blur to <body>, re-blurring each poll: a closing frame's deferred focus return can land after
 *  a single blur (a11y.spec.ts's precedent). */
async function blurToBody(p: Page): Promise<void> {
  await expect
    .poll(() =>
      p.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        return document.activeElement?.tagName;
      }),
    )
    .toBe('BODY');
}

/** A closed base with focus on the page: the start of every test. */
async function fromBase(p: Page): Promise<void> {
  await closeAll(p);
  await expect
    .poll(() => stackNames(p), { message: 'the base is the bare world' })
    .toEqual(['world']);
  await blurToBody(p);
}

/** Moves the open menu's cursor to `key` with Up / Down presses (each polled), from wherever it
 *  is remembered. */
async function menuCursorTo(p: Page, key: string): Promise<void> {
  const want = MENU_KEYS.indexOf(key);
  for (let i = 0; i < MENU_KEYS.length && (await navActive(p)) !== key; i += 1) {
    const before = await navActive(p);
    const at = MENU_KEYS.indexOf(before ?? '');
    await pressButton(p, at > want ? 'Up' : 'Down');
    await expect
      .poll(() => navActive(p), { message: `the menu cursor moves off ${before}` })
      .not.toBe(before);
  }
  expect(await navActive(p), `the menu cursor is on ${key}`).toBe(key);
}

/** Start -> the cursor to Profile -> A. `beforeA` runs with the menu open on Profile. */
async function openProfileFromMenu(p: Page, beforeA?: () => Promise<void>): Promise<void> {
  await fromBase(p);
  await pressButton(p, 'Start');
  await expect
    .poll(() => stackNames(p), { message: 'Start opens the menu' })
    .toEqual(['world', 'menuView']);
  await menuCursorTo(p, 'profile');
  if (beforeA !== undefined) await beforeA();
  await pressButton(p, 'A');
  await expect
    .poll(() => frameNames(p), { message: 'A on Profile opens the Profile frame over the menu' })
    .toEqual(['world', 'menuView', 'profileView']);
  await expect(p.locator('#profile-overlay')).toBeVisible();
}

/** Presses `button` once and waits for focus to move; returns where it landed. */
async function stepFocus(p: Page, button: 'Up' | 'Down'): Promise<Focused> {
  const before = await focusedId(p);
  await pressButton(p, button);
  await expect
    .poll(() => focusedId(p), { message: `${button} moves focus off #${before}`, timeout: 3_000 })
    .not.toBe(before);
  const now = await focused(p);
  if (now === null) throw new Error(`${button} from #${before} dropped focus to the page`);
  return now;
}

/** Whether `sel`'s box (non-empty) lies inside the Profile frame's scrolling body `#profile-body`
 *  (0.5 px slack): the row is scrolled into view, not clipped below the fold. */
const insideBody = (p: Page, sel: string): Promise<boolean> =>
  p.evaluate((s) => {
    const el = document.querySelector(s);
    const body = document.getElementById('profile-body');
    if (el === null || body === null) return false;
    const i = el.getBoundingClientRect();
    const o = body.getBoundingClientRect();
    const k = 0.5;
    return (
      i.width > 0 &&
      i.height > 0 &&
      i.left >= o.left - k &&
      i.top >= o.top - k &&
      i.right <= o.right + k &&
      i.bottom <= o.bottom + k
    );
  }, sel);

const idsWithPrefix = (p: Page, prefix: string): Promise<string[]> =>
  p.evaluate((pre) => [...document.querySelectorAll(`[id^="${pre}"]`)].map((el) => el.id), prefix);

/** The visible, un-hidden modal dialogs: role="dialog" aria-modal="true", rendered (a layout box,
 *  not visibility:hidden) and with no inert or aria-hidden="true" ancestor-or-self. */
const liveModalDialogs = (p: Page): Promise<string[]> =>
  p.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      .filter(
        (el) =>
          el.getClientRects().length > 0 &&
          getComputedStyle(el).visibility !== 'hidden' &&
          el.closest('[inert]') === null &&
          el.closest('[aria-hidden="true"]') === null,
      )
      .map((el) => el.id || el.tagName),
  );

test.describe
  .serial('UIF16B — Profile is one screen with three sections, measured in Chromium', () => {
    let browser: Browser;
    let ctx: BrowserContext;
    let page: Page;

    test.beforeAll(async () => {
      test.setTimeout(60_000);
      browser = await chromium.launch();
      // `newContext()`, not `newPage()`: @axe-core/playwright refuses a page made on the browser.
      ctx = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      });
      page = await ctx.newPage();
      await page.goto('/');
      await ready(page);
    });

    test.afterAll(async () => {
      await browser.close();
    });

    test('UIF16B.1 A on the Profile menu entry opens ONE frame: the stack ends menuView, profileView; the Name, Account and Privacy headers show top to bottom with a rendered separator above Account, Privacy and Close; no Profile sub-list exists', async () => {
      // WRONG IMPL KILLED: Profile still a group (A enters a sub-list; the stack stays
      // [world, menuView]); a frame showing one section at a time (a header hidden); sections out
      // of order; a separator that never renders (zero width, style none or a transparent colour);
      // a leftover menuProfile-* sub-list row.
      test.setTimeout(60_000);
      await openProfileFromMenu(page, async () => {
        expect(
          await idsWithPrefix(page, 'menuProfile-'),
          'the menu is open on Profile and holds no Profile sub-list ids',
        ).toEqual([]);
      });
      expect(await frameNames(page)).toEqual(['world', 'menuView', 'profileView']);

      // One frame, titled Profile, holding the three sections in column order.
      await expect(page.locator('#profile-title')).toHaveText(t('menu.profile.title'));
      const headers: ReadonlyArray<readonly [string, string]> = [
        ['#rename-title', t('menu.profile.name.title')],
        ['#claim-frame-title', t('menu.profile.account.title')],
        ['#privacy-title', t('privacy.title')],
      ];
      for (const [sel, text] of headers) {
        await expect(page.locator(sel), `${sel} is shown`).toBeVisible();
        await expect(page.locator(sel), `${sel} reads its catalog header`).toHaveText(text);
        expect(text.trim(), `${sel}: the catalog header is non-empty`).not.toBe('');
      }
      for (const sel of ['#rename-overlay', '#claim-overlay', '#privacy-overlay']) {
        await expect(
          page.locator(`#profile-overlay ${sel}`),
          `${sel} is inside the frame`,
        ).toHaveCount(1);
        await expect(page.locator(sel), `${sel} is shown`).toBeVisible();
      }

      const tops: number[] = [];
      for (const sel of [
        '#profile-title',
        '#rename-title',
        '#claim-frame-title',
        '#privacy-title',
        '#profile-close-btn',
      ]) {
        const box = await page.locator(sel).boundingBox();
        expect(box, `${sel} has a layout box`).not.toBeNull();
        tops.push(box?.y ?? Number.NaN);
      }
      for (let i = 1; i < tops.length; i += 1) {
        expect(
          tops[i] as number,
          `top-to-bottom order: element ${i} (${tops.join(', ')})`,
        ).toBeGreaterThan(tops[i - 1] as number);
      }

      // A separator above the 2nd and 3rd sections and above the Close row, as Chromium renders it.
      for (const sel of ['#claim-overlay', '#privacy-overlay', '#profile-close-row']) {
        await expect(page.locator(sel), `${sel} is shown`).toBeVisible();
        const s = await sampleStyle(page, sel, [
          'border-top-width',
          'border-top-style',
          'border-top-color',
        ]);
        expect(
          Number.parseFloat(s['border-top-width'] ?? ''),
          `${sel}: a rendered top border (${JSON.stringify(s)})`,
        ).toBeGreaterThan(0);
        expect(s['border-top-style'], `${sel}: the separator is drawn`).not.toBe('none');
        expect(
          parseRgb(s['border-top-color'] ?? '').a,
          `${sel}: the separator colour is not transparent (${JSON.stringify(s)})`,
        ).toBeGreaterThan(0);
      }

      expect(await idsWithPrefix(page, 'menuProfile-'), 'no Profile sub-list ids').toEqual([]);
      await closeAll(page);
    });

    test('UIF16B.2 the D-pad walks one column across Name, Account, Privacy in visual order with Close the last row, and B pops the frame back to the menu on Profile', async () => {
      // WRONG IMPL KILLED: a walk that stays inside one section; a column out of visual order
      // (a later row drawn above an earlier one); Close not last, or a Down on Close that wraps;
      // Up and Down disagreeing on the column; a B that closes the whole menu or forgets the cursor.
      test.setTimeout(90_000);
      await openProfileFromMenu(page);
      await expect(page.locator('#rename-input')).toBeFocused();

      // In the field the arrows are the caret's (typing mode): Escape stops typing first.
      await page.keyboard.press('Escape');
      await expect
        .poll(() => focusedId(page), { message: 'Escape moves focus out of the name field' })
        .not.toBe('rename-input');
      await expect
        .poll(() => stackNames(page), { message: 'typing stopped; Profile is still open' })
        .toEqual(['world', 'menuView', 'profileView']);
      const start = await focused(page);
      expect(start, 'after Escape a row holds focus').not.toBeNull();
      if (start === null) return;
      expect(start.inProfile, `#${start.id} is inside the Profile frame`).toBe(true);
      expect(start.id, 'every row carries an id').not.toBe('');

      // Down to Close.
      const down: Focused[] = [start];
      for (let i = 0; i < 24 && down[down.length - 1]?.id !== 'profile-close-btn'; i += 1) {
        down.push(await stepFocus(page, 'Down'));
      }
      expect(down[down.length - 1]?.id, 'Down reaches Close').toBe('profile-close-btn');
      for (let i = 1; i < down.length; i += 1) {
        const prev = down[i - 1] as Focused;
        const next = down[i] as Focused;
        expect(next.top, `Down #${prev.id} -> #${next.id} moves down the screen`).toBeGreaterThan(
          prev.top,
        );
        expect(next.inProfile && next.shown && next.enabled, `#${next.id} is a live row`).toBe(
          true,
        );
      }

      // The body scrolls under the fixed title: the focused Close row is scrolled into view.
      await expect
        .poll(() => insideBody(page, '#profile-close-btn'), {
          message: 'Close lies inside #profile-body (scrolled into view)',
        })
        .toBe(true);

      // Close is the last row: a Down on it stays. (A fixed wait, because the proof is that
      // nothing moves; 300 ms is far past one keydown's handling.)
      await pressButton(page, 'Down');
      await page.waitForTimeout(300);
      expect(await focusedId(page), 'Down on Close stays on Close').toBe('profile-close-btn');

      // Up from Close to the name field, the top of the column.
      const up: Focused[] = [down[down.length - 1] as Focused];
      for (let i = 0; i < 24 && up[up.length - 1]?.id !== 'rename-input'; i += 1) {
        up.push(await stepFocus(page, 'Up'));
      }
      expect(up[up.length - 1]?.id, 'Up from Close reaches the name field').toBe('rename-input');
      for (let i = 1; i < up.length; i += 1) {
        const prev = up[i - 1] as Focused;
        const next = up[i] as Focused;
        expect(next.top, `Up #${prev.id} -> #${next.id} moves up the screen`).toBeLessThan(
          prev.top,
        );
        expect(next.inProfile && next.shown && next.enabled, `#${next.id} is a live row`).toBe(
          true,
        );
      }

      // One column: top-down, the sections come in order Name, Account, Privacy, Close, every
      // row once, and the Down walk from the first non-field row is exactly the column's tail.
      const column = [...up].reverse();
      const ids = column.map((f) => f.id);
      expect(new Set(ids).size, `each row once: ${ids.join(', ')}`).toBe(ids.length);
      expect(ids[0]).toBe('rename-input');
      expect(ids[ids.length - 1]).toBe('profile-close-btn');
      const order = { name: 0, account: 1, privacy: 2, close: 3 } as const;
      const ranks = column.map((f) => (f.section === null ? -1 : order[f.section]));
      expect(
        ranks.every((r) => r >= 0),
        `every row is in a section: ${ids.join(', ')}`,
      ).toBe(true);
      expect(ranks, `sections in visual order along the column: ${ids.join(', ')}`).toEqual(
        [...ranks].sort((a, b) => a - b),
      );
      expect(
        column.filter((f) => f.section === 'account').length,
        `the Account section contributes rows: ${ids.join(', ')}`,
      ).toBeGreaterThan(0);
      const from = ids.indexOf(start.id);
      expect(
        from,
        `the post-Escape row #${start.id} is a column row below the field`,
      ).toBeGreaterThan(0);
      expect(
        down.map((f) => f.id),
        'Down and Up walk the same column',
      ).toEqual(ids.slice(from));

      // Back at the top with the field focused, the body has scrolled it back into view too.
      await expect(page.locator('#rename-input')).toBeFocused();
      await expect
        .poll(() => insideBody(page, '#rename-input'), {
          message: 'the name field lies inside #profile-body (scrolled back into view)',
        })
        .toBe(true);

      // B pops the frame back to the menu with the cursor on Profile (from a button: in the field
      // Backspace is the caret's).
      await page.keyboard.press('Escape');
      await expect
        .poll(() => focusedId(page), { message: 'Escape leaves the field again' })
        .not.toBe('rename-input');
      await pressButton(page, 'B');
      await expect
        .poll(() => stackNames(page), { message: 'B pops only the Profile frame' })
        .toEqual(['world', 'menuView']);
      await expect(page.locator('#profile-overlay')).toBeHidden();
      await expect(page.locator('#menu-overlay')).toBeVisible();
      await expect
        .poll(() => navActive(page), { message: 'the cursor is on Profile' })
        .toBe('profile');
      await closeAll(page);
    });

    test('UIF16B.3 Profile is exactly one live modal dialog named Profile, Tab from Close stays inside it, and axe reports no violations in it', async () => {
      // WRONG IMPL KILLED: a section that is still its own dialog (two live modal dialogs, or a
      // section carrying role / aria-modal); an unnamed or misnamed dialog; a trap that lets Tab
      // leave the frame; a WCAG A/AA violation inside the frame.
      test.setTimeout(60_000);
      await fromBase(page);
      await pressAccel(page, 'N');
      await expect(page.locator('#profile-overlay')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('#rename-input')).toBeFocused();

      await expect
        .poll(() => liveModalDialogs(page), { message: 'exactly one live modal dialog' })
        .toEqual(['profile-overlay']);
      await expect(page.locator('#profile-overlay')).toHaveAttribute('role', 'dialog');
      await expect(page.locator('#profile-overlay')).toHaveAttribute('aria-modal', 'true');
      for (const sel of ['#rename-overlay', '#claim-overlay', '#privacy-overlay']) {
        const attrs = await page
          .locator(sel)
          .evaluate((el) => [el.getAttribute('role'), el.getAttribute('aria-modal')]);
        expect(attrs, `${sel} is a section, not a dialog`).toEqual([null, null]);
      }
      await expect(page.getByRole('dialog', { name: 'Profile', exact: true })).toHaveAttribute(
        'id',
        'profile-overlay',
      );

      // The one focus trap: Tab past the last control and Shift+Tab back both stay inside.
      await page.keyboard.press('Escape'); // stop typing
      await expect.poll(() => focusedId(page)).not.toBe('rename-input');
      await page.locator('#profile-close-btn').focus();
      await expect(page.locator('#profile-close-btn')).toBeFocused();
      await page.keyboard.press('Tab');
      await expect
        .poll(async () => (await focused(page))?.inProfile ?? false, {
          message: 'Tab from Close stays inside #profile-overlay',
        })
        .toBe(true);
      expect(await focusedId(page), 'Tab moved focus').not.toBe('profile-close-btn');
      await page.keyboard.press('Shift+Tab');
      await expect
        .poll(async () => (await focused(page))?.inProfile ?? false, {
          message: 'Shift+Tab stays inside #profile-overlay',
        })
        .toBe(true);

      const results = await new AxeBuilder({ page })
        .withTags(AXE_TAGS)
        .include('#profile-overlay')
        .exclude('canvas')
        .analyze();
      expect(results.testEngine.name).toBe('axe-core');
      expect(
        results.violations.map(
          (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
        ),
        'axe: no WCAG 2.x A/AA violations inside the Profile dialog',
      ).toEqual([]);
      // NON-VACUITY: the scan evaluated the frame's own controls.
      expect(
        results.passes.map((r) => r.id),
        'axe evaluated the dialog buttons',
      ).toContain('button-name');
      await closeAll(page);
    });

    test('UIF16B.4 the name field types n, c, b and the arrows without opening or closing anything, Escape stops typing inside the frame, and closing disarms an armed decline', async () => {
      // WRONG IMPL KILLED: an accelerator taken while typing (N / C moves focus, B opens Storage);
      // an arrow walking rows from the field; an Escape that closes the frame or drops focus to the
      // page or onto a hidden / disabled control; a decline left armed behind a closed frame.
      test.setTimeout(60_000);
      await fromBase(page);
      await pressAccel(page, 'N');
      const input = page.locator('[data-testid="rename-input"]');
      await expect(input).toBeFocused({ timeout: 10_000 });
      const before = await stackNames(page);
      expect(before.filter((n) => !n.startsWith('textEntry:'))).toEqual([
        'world',
        'menuView',
        'profileView',
      ]);

      await pressAccel(page, 'N');
      await pressAccel(page, 'C');
      await pressAccel(page, 'B');
      await expect(input, 'the three accelerator keys are typed').toHaveValue('ncb');
      await page.keyboard.press('ArrowLeft');
      await expect
        .poll(() => input.evaluate((el) => (el as HTMLInputElement).selectionStart))
        .toBe(2);
      await page.keyboard.press('ArrowDown');
      await expect(input, 'ArrowDown in the field moves no row').toBeFocused();
      expect(await stackNames(page), 'typing opened or closed nothing').toEqual(before);
      await expect(page.locator('#profile-overlay')).toBeVisible();

      await page.keyboard.press('Escape');
      await expect
        .poll(() => focusedId(page), { message: 'Escape stops typing' })
        .not.toBe('rename-input');
      const after = await focused(page);
      expect(after, 'focus stays on a control').not.toBeNull();
      expect(
        after === null
          ? null
          : { inProfile: after.inProfile, shown: after.shown, enabled: after.enabled },
        `Escape lands on a visible, enabled control inside Profile (#${after?.id})`,
      ).toEqual({ inProfile: true, shown: true, enabled: true });
      await expect(input, 'Escape keeps the typed text').toHaveValue('ncb');
      await expect(page.locator('#profile-overlay')).toBeVisible();
      expect(await frameNames(page)).toEqual(['world', 'menuView', 'profileView']);

      // Arm the decline, close with B, reopen: no Yes / No row (every close disarms).
      await expect(page.locator('#claim-decline-btn')).toBeVisible();
      await page.locator('#claim-decline-btn').click();
      await expect(page.locator('#claim-decline-confirm-btn')).toBeVisible();
      await expect(page.locator('#claim-decline-cancel-btn')).toBeFocused();
      await pressButton(page, 'B');
      await expect
        .poll(() => stackNames(page), { message: 'B closes Profile' })
        .toEqual(['world', 'menuView']);
      await expect(page.locator('#profile-overlay')).toBeHidden();
      await expect.poll(() => navActive(page)).toBe('profile');
      await pressButton(page, 'A');
      await expect(page.locator('#profile-overlay')).toBeVisible({ timeout: 10_000 });
      await expect(
        page.locator('#claim-decline-confirm-btn'),
        'no Yes after a reopen',
      ).toBeHidden();
      await expect(page.locator('#claim-decline-cancel-btn'), 'no No after a reopen').toBeHidden();
      await expect(page.locator('#claim-confirm'), 'no confirm prompt after a reopen').toBeHidden();
      await expect(page.locator('#claim-decline-btn'), 'Decline is offered again').toBeVisible();
      await expect(input, 'a close drops the draft').toHaveValue('');

      // The same for an armed account deletion, when this account state offers it.
      const del = page.locator('#privacy-delete-btn');
      if ((await del.isVisible()) && (await del.isEnabled())) {
        await del.click();
        await expect(page.locator('#privacy-confirm-cancel-btn')).toBeFocused();
        await pressButton(page, 'B');
        await expect
          .poll(() => stackNames(page), { message: 'B closes Profile' })
          .toEqual(['world', 'menuView']);
        await pressButton(page, 'A');
        await expect(page.locator('#profile-overlay')).toBeVisible({ timeout: 10_000 });
        await expect(page.locator('#privacy-confirm-btn'), 'no Delete confirm').toBeHidden();
        await expect(page.locator('#privacy-confirm-cancel-btn'), 'no Keep').toBeHidden();
        await expect(page.locator('#privacy-confirm'), 'no deletion prompt').toBeHidden();
      } else {
        test.info().annotations.push({
          type: 'uif-16b',
          description:
            'deletion is refused in this account state: only the decline disarm is driven',
        });
      }
      await closeAll(page);
    });

    test('UIF16B.5 N from the world opens Profile on an EMPTY name field, C opens it in the Account section, and N with Profile open on Account moves to the name field without closing', async () => {
      // WRONG IMPL KILLED: N typed into the field it opens; C landing on Name; an N over an open
      // Profile that closes it (acts as Start) or reopens it through the menu (a new stack).
      test.setTimeout(60_000);
      const input = page.locator('[data-testid="rename-input"]');

      await fromBase(page);
      await pressAccel(page, 'N');
      await expect(input).toBeFocused({ timeout: 10_000 });
      await expect(input, 'the opening n is not typed').toHaveValue('');
      expect(await frameNames(page)).toEqual(['world', 'menuView', 'profileView']);

      await fromBase(page);
      await pressAccel(page, 'C');
      await expect(page.locator('#profile-overlay')).toBeVisible({ timeout: 10_000 });
      await expect
        .poll(async () => (await focused(page))?.section ?? null, {
          message: 'C puts focus in the Account section',
        })
        .toBe('account');
      const onAccount = await focused(page);
      expect(
        onAccount === null
          ? null
          : { tag: onAccount.tag, shown: onAccount.shown, enabled: onAccount.enabled },
        `C focuses a visible, enabled Account button (#${onAccount?.id})`,
      ).toEqual({ tag: 'BUTTON', shown: true, enabled: true });
      const stackOnAccount = await stackNames(page);
      expect(stackOnAccount).toEqual(['world', 'menuView', 'profileView']);

      await pressAccel(page, 'N');
      await expect(input, 'N moves the cursor to the name field').toBeFocused();
      await expect(input, 'the n is not typed').toHaveValue('');
      await expect(page.locator('#profile-overlay'), 'the frame stays open').toBeVisible();
      expect(await frameNames(page), 'the same frame, not a reopen').toEqual([
        'world',
        'menuView',
        'profileView',
      ]);
      await closeAll(page);
    });
  });
