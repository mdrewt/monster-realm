// @vitest-environment happy-dom
// ui/hintBar.test.ts — ctl-13 RED gating tests: the hint-bar view (CTL13.1).
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M-postgate-console-controls.spec.md §ctl-13;
//   memory/projects/monster-realm-ctl-13-plan.md (REV 2 item 1: chip markup).
//
// RED REASON: client/src/ui/hintBar.ts does not exist yet (module-not-found).
//
// CONTRACT (the imperative shell over `hintBar`'s chips):
//   new HintBarView(root /* #hint-bar */); render(chips, banner: string | null)
//   - A keyed reconcile on `data-button`: the shipped `#chip-start` / `#chip-select` buttons are
//     REUSED (same nodes, ids and launcher attributes kept); every other chip is a
//     `<span class="mr-chip" data-button=X style="pointer-events:none">` (no click until ctl-15).
//   - Each chip holds `.mr-chip-key` (the keycap), `.mr-chip-verb` (the verb) and, only while
//     `badge`, `.mr-chip-badge` (the catalog's `chrome.badge.request`), all through textContent.
//   - The chips sit in the DOM in the model's order; a chip the model no longer lists is removed.
//   - One `#notice-banner` child, created once, textContent = the banner, `hidden` while null.
//     It has no role, aria-live, aria-modal or tabindex; nothing in the bar is ever focused.
//   - An identical re-render touches the DOM not at all.
//
// The shell is the REAL client/index.html hint bar, so the test and the page cannot drift.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VButton } from '../input/buttons';
import { HintBarView } from './hintBar';
import type { HintChip } from './hintBarModel';
import { t } from './i18n/resolver';

/** Mount the real `#hint-bar` markup into the live document and return it. */
function mountHintBar(): HTMLElement {
  const htmlPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'index.html',
  );
  const parsed = new DOMParser().parseFromString(readFileSync(htmlPath, 'utf8'), 'text/html');
  const bar = parsed.getElementById('hint-bar');
  if (bar === null) throw new Error('client/index.html must ship #hint-bar');
  document.body.replaceChildren(document.adoptNode(bar));
  return bar;
}

beforeEach(() => {
  document.body.replaceChildren();
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const chip = (button: VButton, keycap: string, verb: string, badge = false): HintChip => ({
  button,
  keycap,
  verb,
  badge,
});

const START = chip('Start', 'Esc', 'Menu');
const SELECT = chip('Select', 'R', 'Help');
/** U+232B ERASE TO THE LEFT, the Backspace keycap, by code point. */
const BACKSPACE_GLYPH = String.fromCharCode(0x232b);

/** The chips in DOM order, by data-button. */
const order = (bar: HTMLElement): string[] =>
  [...bar.querySelectorAll('[data-button]')].map((el) => el.getAttribute('data-button') ?? '');
const chipOf = (bar: HTMLElement, button: string): HTMLElement => {
  const el = bar.querySelector(`[data-button="${button}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`no chip ${button}`);
  return el;
};
const part = (el: HTMLElement, cls: string): string | null =>
  el.querySelector(`.${cls}`)?.textContent ?? null;

/** Wait for happy-dom to deliver pending MutationObserver records (one zero-delay macrotask). */
const flush = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('HintBarView (ctl-13, CTL13.1)', () => {
  it('CTL13-1-VIEW-RENDER: the bar reconciles by data-button: Start and Select stay the same nodes (ids and launchers kept), new chips are non-clickable spans with keycap, verb and badge parts in model order, a chip the model drops is removed, the banner is one hidden-when-null node with no ARIA role, live region or tabindex, an identical render writes nothing, nothing is focused, and every string is text', async () => {
    // WRONG IMPL KILLED: a bar rebuilt with replaceChildren on every render (Start / Select lose
    // their ids and click launchers, and a focused chip would lose focus); new chips as <button>s
    // (a click target with no handler, and a tab stop) or without pointer-events:none; chip text
    // in one lump instead of the key / verb / badge parts; a badge part left behind after the
    // badge clears or shown when it is not asked for; a stale chip left in the DOM; chips in
    // insertion order instead of model order; a banner created per render (two banners), never
    // hidden, hidden by an empty string only, or given aria-live / role / tabindex (ui/liveRegion
    // is the sole announcement owner); a render that rewrites unchanged chips (every frame would
    // mutate the DOM); a render that focuses; and innerHTML (an XSS hole through a player name).
    const bar = mountHintBar();
    const startNode = document.getElementById('chip-start') as HTMLElement;
    const selectNode = document.getElementById('chip-select') as HTMLElement;
    expect(startNode, 'precondition: the shipped Start chip').not.toBeNull();
    expect(selectNode, 'precondition: the shipped Select chip').not.toBeNull();
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    const outside = document.createElement('input');
    document.body.appendChild(outside);
    outside.focus();
    focusSpy.mockClear();

    const view = new HintBarView(bar);

    // --- a first render: Start and Select, no banner text ------------------------------------
    view.render([START, SELECT], null);
    expect(order(bar)).toEqual(['Start', 'Select']);
    expect(chipOf(bar, 'Start'), 'the shipped Start button is reused').toBe(startNode);
    expect(chipOf(bar, 'Select'), 'the shipped Select button is reused').toBe(selectNode);
    expect(startNode.id).toBe('chip-start');
    expect(startNode.hasAttribute('data-menu-launcher'), 'the menu launcher is kept').toBe(true);
    expect(selectNode.hasAttribute('data-help-launcher'), 'the help launcher is kept').toBe(true);
    expect(part(startNode, 'mr-chip-key')).toBe('Esc');
    expect(part(startNode, 'mr-chip-verb')).toBe('Menu');
    expect(startNode.querySelector('.mr-chip-badge'), 'no badge asked for').toBeNull();
    expect(part(selectNode, 'mr-chip-key')).toBe('R');
    expect(part(selectNode, 'mr-chip-verb')).toBe('Help');

    // --- the banner: one node, hidden while null ----------------------------------------------
    const bannerWhileNull = bar.querySelector('#notice-banner');
    if (bannerWhileNull !== null) {
      expect((bannerWhileNull as HTMLElement).hidden, 'a null banner is hidden').toBe(true);
    }
    view.render([START, SELECT], 'Bob wants to trade');
    const banners = bar.querySelectorAll('#notice-banner');
    expect(banners, 'exactly one banner').toHaveLength(1);
    const banner = banners[0] as HTMLElement;
    expect(banner.textContent).toBe('Bob wants to trade');
    expect(banner.hidden, 'shown while it has text').toBe(false);
    for (const name of ['role', 'aria-live', 'aria-modal', 'aria-atomic', 'tabindex']) {
      expect(banner.hasAttribute(name), `the banner has no ${name}`).toBe(false);
    }
    view.render([START, SELECT], 'Dana challenges you to a battle');
    expect(bar.querySelectorAll('#notice-banner'), 'still one banner').toHaveLength(1);
    expect(bar.querySelector('#notice-banner'), 'the same banner node').toBe(banner);
    expect(banner.textContent).toBe('Dana challenges you to a battle');
    view.render([START, SELECT], null);
    expect(bar.querySelector('#notice-banner'), 'the same banner node after a null').toBe(banner);
    expect(banner.hidden, 'a null banner hides it').toBe(true);
    view.render([START, SELECT], 'Bob wants to trade');
    expect(banner.hidden, 'and it shows again').toBe(false);

    // --- new chips: spans, in model order, with parts and a badge on Start --------------------
    const A = chip('A', 'Enter', 'Talk');
    const Y = chip('Y', 'F', 'View');
    const B = chip('B', BACKSPACE_GLYPH, 'Dismiss');
    view.render([A, Y, B, chip('Start', 'Esc', 'Menu', true), SELECT], null);
    expect(order(bar), 'model order').toEqual(['A', 'Y', 'B', 'Start', 'Select']);
    const aNode = chipOf(bar, 'A');
    for (const [name, node] of [
      ['A', aNode],
      ['Y', chipOf(bar, 'Y')],
      ['B', chipOf(bar, 'B')],
    ] as const) {
      expect(node.tagName, `${name} is a span, not a button`).toBe('SPAN');
      expect(node.classList.contains('mr-chip'), `${name} has the chip class`).toBe(true);
      expect(node.style.pointerEvents, `${name} takes no pointer events`).toBe('none');
      expect(node.hasAttribute('tabindex'), `${name} is not a tab stop`).toBe(false);
      expect(node.hasAttribute('role'), `${name} has no role`).toBe(false);
    }
    expect(part(aNode, 'mr-chip-key')).toBe('Enter');
    expect(part(aNode, 'mr-chip-verb')).toBe('Talk');
    expect(part(chipOf(bar, 'Y'), 'mr-chip-verb')).toBe('View');
    expect(chipOf(bar, 'Start'), 'Start is still the shipped node').toBe(startNode);
    expect(chipOf(bar, 'Select'), 'and so is Select').toBe(selectNode);
    const badgeText = t('chrome.badge.request' as never);
    expect(badgeText, 'fixture: the badge text is real').not.toBe('');
    expect(part(startNode, 'mr-chip-badge'), 'the badge part carries the catalog badge text').toBe(
      badgeText,
    );
    expect(bar.querySelectorAll('.mr-chip-badge'), 'only Start is badged').toHaveLength(1);

    // --- a reconcile keeps surviving nodes and updates their text -----------------------------
    view.render([chip('A', 'Enter', 'Shop'), chip('Start', 'Esc', 'Menu'), SELECT], null);
    expect(order(bar), 'Y and B were dropped').toEqual(['A', 'Start', 'Select']);
    expect(chipOf(bar, 'A'), 'the surviving A chip keeps its node').toBe(aNode);
    expect(part(aNode, 'mr-chip-verb'), 'with the new verb').toBe('Shop');
    expect(
      startNode.querySelector('.mr-chip-badge'),
      'the badge part goes with the badge',
    ).toBeNull();
    expect(bar.querySelector('[data-button="Y"]'), 'a dropped chip is gone').toBeNull();
    expect(bar.querySelector('[data-button="B"]')).toBeNull();

    // A reorder follows the model, keeping the nodes.
    view.render([SELECT, chip('A', 'Enter', 'Shop'), START], null);
    expect(order(bar), 'model order again').toEqual(['Select', 'A', 'Start']);
    expect(chipOf(bar, 'A')).toBe(aNode);
    expect(chipOf(bar, 'Start')).toBe(startNode);

    // The model drops Select (a text entry on top), and brings it back: the SAME shipped node.
    view.render([chip('A', 'Enter', 'OK'), chip('Start', 'Esc', 'Done')], null);
    expect(order(bar)).toEqual(['A', 'Start']);
    expect(
      bar.querySelector('#chip-select'),
      'Select is out of the bar while the model omits it',
    ).toBeNull();
    view.render([chip('A', 'Enter', 'OK'), chip('Start', 'Esc', 'Menu'), SELECT], null);
    expect(document.getElementById('chip-select'), 'and returns as the same node').toBe(selectNode);
    expect(selectNode.hasAttribute('data-help-launcher')).toBe(true);

    // --- an identical render writes nothing ---------------------------------------------------
    const steady = [chip('A', 'Enter', 'OK'), chip('Start', 'Esc', 'Menu', true), SELECT];
    view.render(steady, 'Bob wants to trade');
    await flush();
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((batch) => records.push(...batch));
    observer.observe(bar, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    view.render(
      steady.map((c) => ({ ...c })),
      'Bob wants to trade',
    );
    view.render([...steady], 'Bob wants to trade');
    await flush();
    expect(records.length, 'two identical renders mutate nothing').toBe(0);
    // Control: a changed render does mutate (the observer is live).
    view.render(steady, 'Bob challenges you to a battle');
    await flush();
    expect(records.length, 'control: a changed banner is observed').toBeGreaterThan(0);
    const afterBanner = records.length;
    view.render(
      [chip('A', 'Enter', 'OK'), chip('Start', 'Esc', 'Menu'), SELECT],
      'Bob challenges you to a battle',
    );
    await flush();
    expect(records.length, 'control: a cleared badge is observed too').toBeGreaterThan(afterBanner);
    observer.disconnect();

    // --- no focus, no live region -------------------------------------------------------------
    expect(focusSpy, 'no render ever focuses anything').not.toHaveBeenCalled();
    expect(document.activeElement, 'focus stayed where it was').toBe(outside);
    expect(bar.querySelector('[aria-live]'), 'no live region in the bar').toBeNull();
    expect(bar.hasAttribute('aria-live')).toBe(false);
    expect(bar.querySelector('[role="dialog"], [aria-modal]'), 'no dialog').toBeNull();

    // --- every string is text, never markup ---------------------------------------------------
    const hostile = '<img src=x onerror=alert(1)><script>boom()</script>';
    view.render(
      [chip('A', '<b>k</b>', hostile), chip('Start', hostile, hostile, true), SELECT],
      hostile,
    );
    expect(bar.querySelector('img'), 'no injected <img>').toBeNull();
    expect(bar.querySelector('script'), 'no injected <script>').toBeNull();
    expect(bar.querySelector('b'), 'no injected <b>').toBeNull();
    expect(part(chipOf(bar, 'A'), 'mr-chip-verb')).toBe(hostile);
    expect(part(chipOf(bar, 'A'), 'mr-chip-key')).toBe('<b>k</b>');
    expect((bar.querySelector('#notice-banner') as HTMLElement).textContent).toBe(hostile);
  });
});
