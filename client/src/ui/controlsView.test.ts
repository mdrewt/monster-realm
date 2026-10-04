// @vitest-environment happy-dom
//
// ui/controlsView.test.ts — ctl-12b (CTL12B.1): the Options › Controls DOM shell.
//
// The view is constructed (no index.html markup), NOT coverage-excluded, and decides nothing: rows,
// labels, prompts and outcomes come from `ui/controlsModel.ts`; the cursor, the capture target, the
// confirm and the one-shot request come from the screen's paint (`ControlsPaint`,
// ui/screens/optionsScreen.ts). Paints are built here from the exported `CONTROLS_LAYOUT` and the nav
// kit, so this file exercises the shell alone.
//
// LEGACY BEHAVIOUR REPLACED (anti-vacuity): there is no Controls screen. ctl-12 shipped the binding
// model and the saved table, but nothing in the game shows or changes it; a remap only applied after
// a hand-edited `localStorage` and a reload. Every case below is red on the missing module.
//
// REACHABILITY IS VISIBILITY: `ensureElement` creates every node `display:none` (the privacyView /
// claimView trap), so every control asserted on screen is checked by walking its ancestor chain, and
// every cell text is read through `textContent` with the AT-invisible cheats ruled out (no
// `aria-label` / `aria-labelledby` override, no `aria-hidden` content).
//
// No regex literal, no `innerHTML`: DOM reads are `textContent`, attributes and selectors only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Bindings, DEFAULT_BINDINGS } from '../input/bindings';
import { ACCELS, type Accel, VBUTTONS, type VButton } from '../input/buttons';
import { glyph, resetLearnedKeys } from '../input/glyphs';
import { t as a11yT } from './a11yCopy';
import { confirmLayout } from './actionSheetModel';
import {
  type ControlsRow,
  capturePrompt,
  clearAccel,
  rowLabel,
  type Slot,
  type SlotTarget,
  slots,
} from './controlsModel';
import { ControlsView } from './controlsView';
import { setLocale, t, tf } from './i18n/resolver';
import { type NavState, navFocus, navInit } from './nav';
import { closeOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y } from './overlayRegistry';
import { CONTROLS_LAYOUT, type ControlsPaint, type ControlsRequest } from './screens/optionsScreen';

// --- the contract, spelled once ---------------------------------------------------------------

const OVERLAY_ID = 'controls-overlay';
const TITLE_ID = 'controls-title';
const TABS_ID = 'controls-tabs';
const TAB_BUTTONS_ID = 'controls-tab-buttons';
const TAB_SHORTCUTS_ID = 'controls-tab-shortcuts';
const ROWS_ID = 'controls-rows';
const CAPTURE_ID = 'controls-capture';
const CANCEL_ID = 'controls-cancel-btn';
const QUESTION_ID = 'controls-question';
const FEEDBACK_ID = 'controls-feedback';
const ALL_IDS: readonly string[] = [
  OVERLAY_ID,
  TITLE_ID,
  TABS_ID,
  ROWS_ID,
  CAPTURE_ID,
  CANCEL_ID,
  QUESTION_ID,
  FEEDBACK_ID,
];

/** U+2026 HORIZONTAL ELLIPSIS and U+2014 EM DASH, built from their code points. */
const ELLIPSIS = String.fromCodePoint(0x2026);
const EM_DASH = String.fromCodePoint(0x2014);

type Handlers = ConstructorParameters<typeof ControlsView>[0];

const btnRow = (id: VButton): ControlsRow => ({ kind: 'button', id });
const accRow = (id: Accel): ControlsRow => ({ kind: 'accel', id });
const slotOf = (row: ControlsRow, slot: Slot): SlotTarget => ({ row, slot });

/** The cursor on `tab` (its first cell, or `item`). */
const navOn = (tab: 'buttons' | 'shortcuts', item?: string): NavState =>
  navFocus(CONTROLS_LAYOUT, navInit(CONTROLS_LAYOUT), item === undefined ? { tab } : { tab, item });
/** The Reset all confirm's cursor over `confirmLayout` (Yes / No). */
const confirmOn = (item: 'yes' | 'no'): NavState =>
  navFocus(confirmLayout, navInit(confirmLayout), { item });

/** A fresh paint object: the Buttons tab, nothing capturing, no confirm, no request. */
function paintOf(over: Partial<ControlsPaint> = {}): ControlsPaint {
  return {
    layout: CONTROLS_LAYOUT,
    nav: navInit(CONTROLS_LAYOUT),
    capturing: null,
    confirm: null,
    request: null,
    ...over,
  };
}

/** A table: the defaults with some button lists replaced. */
const withButtons = (buttons: Partial<Record<VButton, readonly string[]>>): Bindings => ({
  buttons: { ...DEFAULT_BINDINGS.buttons, ...buttons },
  accels: DEFAULT_BINDINGS.accels,
});

interface RigOptions {
  readonly bindings?: () => Bindings;
  readonly onClear?: (accel: Accel) => boolean;
  readonly onReset?: () => boolean;
}

/** A fresh document and one view over it, every handler a spy. */
function rig(opts: RigOptions = {}) {
  closeOverlayA11y('controlsView', null);
  document.body.replaceChildren();
  const onClear = vi.fn(opts.onClear ?? ((_accel: Accel): boolean => true));
  const onReset = vi.fn(opts.onReset ?? ((): boolean => true));
  const onCancelCapture = vi.fn();
  const announce = vi.fn();
  const view = new ControlsView({
    bindings: opts.bindings ?? (() => DEFAULT_BINDINGS),
    onClear,
    onReset,
    onCancelCapture,
    announce,
  } as Handlers);
  return { view, onClear, onReset, onCancelCapture, announce };
}

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  expect(found, `#${id} must exist: the shell constructs it`).not.toBeNull();
  return found as HTMLElement;
}

/** The nearest ancestor (the node included) that is `display:none`, or null when the node is on
 *  screen all the way up (main.ts's `focusInsideHiddenSubtree` idiom; happy-dom has no
 *  `checkVisibility`). */
function hiddenAncestorOf(start: Element | null): string | null {
  for (let node: Element | null = start; node instanceof HTMLElement; node = node.parentElement) {
    if (node.style.display === 'none') return node.id === '' ? node.tagName : `#${node.id}`;
  }
  return null;
}

function cell(key: string): HTMLElement {
  const found = el(ROWS_ID).querySelector<HTMLElement>(`[data-nav-key="${key}"]`);
  expect(found, `the cell ${key} is rendered`).not.toBeNull();
  return found as HTMLElement;
}

/** A painted element's text as a screen reader gets it: on screen, no label override, no hidden
 *  content. */
function readable(node: HTMLElement, what: string): string {
  expect(hiddenAncestorOf(node), `${what} is on screen`).toBeNull();
  expect(node.getAttribute('aria-label'), `${what}: no aria-label override`).toBeNull();
  expect(node.getAttribute('aria-labelledby'), `${what}: no aria-labelledby override`).toBeNull();
  expect(node.getAttribute('aria-hidden'), `${what}: not aria-hidden`).toBeNull();
  expect(node.querySelector('[aria-hidden]'), `${what}: no aria-hidden content`).toBeNull();
  return node.textContent ?? '';
}

const readCell = (key: string): string => readable(cell(key), `cell ${key}`);

const keycap = (code: string | undefined): string =>
  code === undefined ? t('controls.slot.none') : glyph(code);

/** What a slot cell reads, from the model and the table (`tf` / `glyph`, never a literal). */
function slotText(b: Bindings, row: ControlsRow, slot: Slot): string {
  const key = keycap(slots(b, row)[slot]);
  const labelText = rowLabel(row);
  return slot === 0
    ? tf('controls.slot.primary', { label: labelText, key })
    : tf('controls.slot.alt', { label: labelText, key });
}

const rowsOf = (): HTMLElement[] =>
  Array.from(el(ROWS_ID).querySelectorAll<HTMLElement>('[role="row"]'));

async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  // The PRODUCTION close is the isolation device (a close with no record is a documented no-op).
  closeOverlayA11y('controlsView', null);
  document.body.replaceChildren();
  setLocale('en');
  resetLearnedKeys();
});

// --- tests -----------------------------------------------------------------------------------

describe('ControlsView — rows and prompt (ctl-12b, CTL12B.1)', () => {
  it('CTL12B-1-VIEW-ROWS: painted on the Buttons tab the view shows the two tabs and the twelve button rows, each one Primary and one Alt cell naming the row and its live keycap (an empty slot reads the none mark), no Clear cell, then Reset all; the Shortcuts tab shows Primary, Alt and Clear per row', () => {
    // LEGACY BEHAVIOUR REPLACED: no Controls screen exists; the bindings are shown nowhere.
    // WRONG IMPL KILLED: a missing or extra row; Primary and Alt swapped; a cell that names the key
    // but not the row (the grid is read one cell at a time through aria-activedescendant); a raw
    // code (`KeyW`) instead of the keycap; an empty slot left blank or reading "undefined"; a Clear
    // cell on a button row; a Shortcuts tab with no Clear; a Reset all missing or sharing a row;
    // labels that are hard-coded instead of the catalog's; text hidden from a screen reader (an
    // aria-label override, aria-hidden content) or a cell left display:none by the ensureElement
    // trap; and the cursor not marked.
    const { view } = rig();
    view.show();
    view.paint(paintOf());

    // The tab strip.
    const strip = el(TABS_ID);
    expect(strip.getAttribute('role'), 'a tablist').toBe('tablist');
    expect(
      Array.from(strip.querySelectorAll('[role="tab"]')).map((x) => x.id),
      'two tabs, Buttons then Shortcuts',
    ).toEqual([TAB_BUTTONS_ID, TAB_SHORTCUTS_ID]);
    expect(readable(el(TAB_BUTTONS_ID), 'the Buttons tab')).toBe(t('controls.tab.buttons'));
    expect(readable(el(TAB_SHORTCUTS_ID), 'the Shortcuts tab')).toBe(t('controls.tab.shortcuts'));
    expect(el(TAB_BUTTONS_ID).getAttribute('aria-selected')).toBe('true');
    expect(el(TAB_SHORTCUTS_ID).getAttribute('aria-selected')).toBe('false');

    // The Buttons grid: twelve rows of two, then Reset all alone.
    expect(el(ROWS_ID).getAttribute('role'), 'the rows are a grid').toBe('grid');
    const rows = rowsOf();
    expect(rows, '12 button rows + the Reset all row').toHaveLength(13);
    for (const [i, id] of VBUTTONS.entries()) {
      const cells = Array.from(rows[i]?.children ?? []) as HTMLElement[];
      expect(
        cells.map((c) => c.dataset.navKey),
        `row ${i}: ${id} Primary then Alt`,
      ).toEqual([`${id}_0`, `${id}_1`]);
      expect(
        cells.map((c) => c.dataset.slot),
        `row ${i}: the slots`,
      ).toEqual(['primary', 'alt']);
      const row = btnRow(id);
      expect(readCell(`${id}_0`), `${id} Primary`).toBe(slotText(DEFAULT_BINDINGS, row, 0));
      expect(readCell(`${id}_1`), `${id} Alt`).toBe(slotText(DEFAULT_BINDINGS, row, 1));
      expect(readCell(`${id}_0`), `${id} Primary names its row`).toContain(rowLabel(row));
    }
    expect(
      Array.from(rows[12]?.children ?? []).map((c) => (c as HTMLElement).dataset.navKey),
      'the last row is Reset all alone',
    ).toEqual(['reset']);
    expect(readCell('reset')).toBe(t('controls.resetAll'));
    expect(el(ROWS_ID).querySelectorAll('[data-slot="primary"]')).toHaveLength(12);
    expect(el(ROWS_ID).querySelectorAll('[data-slot="alt"]')).toHaveLength(12);
    expect(
      el(ROWS_ID).querySelectorAll('[data-slot="clear"]'),
      'no Clear on a button',
    ).toHaveLength(0);
    // Concretely: A's keycap is the Enter key's name, and X's empty Alt reads the none mark.
    expect(readCell('A_0'), 'the live keycap').toContain(glyph('Enter'));
    expect(readCell('Up_0'), 'never the raw code').not.toContain('KeyW');
    expect(readCell('Up_0')).toContain(glyph('KeyW'));
    expect(t('controls.slot.none'), 'fixture: the none mark is U+2014').toBe(EM_DASH);
    expect(readCell('X_1')).toBe(
      tf('controls.slot.alt', { label: rowLabel(btnRow('X')), key: EM_DASH }),
    );
    expect(cell('Up_0').getAttribute('aria-selected'), 'the cursor cell').toBe('true');
    expect(cell('Up_1').getAttribute('aria-selected')).toBe('false');

    // The Shortcuts grid: Primary, Alt and Clear per shortcut, then Reset all alone.
    view.paint(paintOf({ nav: navOn('shortcuts') }));
    expect(el(TAB_BUTTONS_ID).getAttribute('aria-selected')).toBe('false');
    expect(el(TAB_SHORTCUTS_ID).getAttribute('aria-selected')).toBe('true');
    const shortcutRows = rowsOf();
    expect(shortcutRows, '11 shortcut rows + the Reset all row').toHaveLength(ACCELS.length + 1);
    for (const [i, id] of ACCELS.entries()) {
      const cells = Array.from(shortcutRows[i]?.children ?? []) as HTMLElement[];
      expect(
        cells.map((c) => c.dataset.navKey),
        `row ${i}: ${id}`,
      ).toEqual([`${id}_0`, `${id}_1`, `${id}_clear`]);
      expect(
        cells.map((c) => c.dataset.slot),
        `row ${i}: the slots`,
      ).toEqual(['primary', 'alt', 'clear']);
      const row = accRow(id);
      expect(readCell(`${id}_0`)).toBe(slotText(DEFAULT_BINDINGS, row, 0));
      expect(readCell(`${id}_1`)).toBe(slotText(DEFAULT_BINDINGS, row, 1));
      expect(readCell(`${id}_clear`), `${id} Clear names its row`).toBe(
        tf('controls.clear', { label: rowLabel(row) }),
      );
    }
    expect(el(ROWS_ID).querySelectorAll('[data-slot="clear"]')).toHaveLength(ACCELS.length);
    expect(readCell('reset')).toBe(t('controls.resetAll'));
    // The Storage shortcut (accelerator B) is not the B button.
    expect(readCell('B_0')).toBe(slotText(DEFAULT_BINDINGS, accRow('B'), 0));
    expect(readCell('B_0')).toContain(glyph('KeyB'));
  });

  it('CTL12B-1-VIEW-PROMPT: painting a capture shows #controls-capture with exactly capturePrompt(row) ("Press a key for Confirm (A)…" for the A row in en) and the Cancel chip; with nothing capturing both are hidden', () => {
    // LEGACY BEHAVIOUR REPLACED: no Controls screen exists, so no capture prompt is ever shown.
    // WRONG IMPL KILLED: a prompt that names the wrong row (the cursor's neighbour) or none; one
    // with three dots or no ellipsis; a hard-coded English prompt (French reads English); a prompt
    // or Cancel chip left display:none by the ensureElement trap (a capture the player cannot see
    // or cancel by pointer); a Cancel that is not a native button (unreachable by keyboard); and a
    // prompt or chip that stays up once the capture ends.
    const { view } = rig();
    view.show();
    view.paint(paintOf());
    expect(hiddenAncestorOf(el(CAPTURE_ID)), 'no capture: the prompt is hidden').not.toBeNull();
    expect(hiddenAncestorOf(el(CANCEL_ID)), 'no capture: the chip is hidden').not.toBeNull();

    view.paint(paintOf({ nav: navOn('buttons', 'A_0'), capturing: slotOf(btnRow('A'), 0) }));
    const prompt = el(CAPTURE_ID);
    expect(readable(prompt, 'the prompt')).toBe(capturePrompt(btnRow('A')));
    expect(prompt.textContent, 'the criterion`s own text').toBe(
      `Press a key for Confirm (A)${ELLIPSIS}`,
    );
    const cancel = el(CANCEL_ID);
    expect(cancel.tagName, 'a native button').toBe('BUTTON');
    expect(readable(cancel, 'the Cancel chip')).toBe(t('controls.cancel'));
    expect((cancel as HTMLButtonElement).disabled).toBe(false);

    // An Alt slot of a shortcut row.
    view.paint(paintOf({ nav: navOn('shortcuts', 'J_1'), capturing: slotOf(accRow('J'), 1) }));
    expect(readable(prompt, 'the prompt')).toBe(capturePrompt(accRow('J')));

    // The capture ends: both go.
    view.paint(paintOf({ nav: navOn('shortcuts', 'J_1') }));
    expect(hiddenAncestorOf(el(CAPTURE_ID)), 'the prompt is hidden again').not.toBeNull();
    expect(hiddenAncestorOf(el(CANCEL_ID)), 'the chip is hidden again').not.toBeNull();

    // Resolved at paint time: under fr the French prompt and chip.
    setLocale('fr');
    view.paint(paintOf({ nav: navOn('buttons', 'A_0'), capturing: slotOf(btnRow('A'), 0) }));
    expect(readable(el(CAPTURE_ID), 'the fr prompt')).toBe(capturePrompt(btnRow('A')));
    expect(el(CAPTURE_ID).textContent).not.toBe(`Press a key for Confirm (A)${ELLIPSIS}`);
  });
});

describe('ControlsView — the live table and the one-shot request (ctl-12b)', () => {
  it('keycaps come from the LIVE table at each paint: change what bindings() returns, paint again, the cell follows', () => {
    // WRONG IMPL KILLED: a table read once at construction (a remap would show the old keycap until
    // a reload, the very defect CTL12B.2 names), and a re-render skipped because the cursor did not
    // move.
    let table = DEFAULT_BINDINGS;
    const { view } = rig({ bindings: () => table });
    view.show();
    view.paint(paintOf());
    expect(readCell('A_0')).toBe(slotText(DEFAULT_BINDINGS, btnRow('A'), 0));

    table = withButtons({ A: ['KeyK', 'NumpadEnter'] });
    view.paint(paintOf());
    expect(readCell('A_0'), 'the new keycap').toBe(
      tf('controls.slot.primary', { label: rowLabel(btnRow('A')), key: glyph('KeyK') }),
    );
    expect(readCell('A_0'), 'not the old one').not.toContain(glyph('Enter'));
    expect(readCell('A_1'), 'the Alt is untouched').toBe(slotText(table, btnRow('A'), 1));
  });

  it('a request token is applied exactly once however often it is painted; a new token applies again: clear calls onClear(accel) then writes the cleared line, reset calls onReset() then writes the done line', () => {
    // WRONG IMPL KILLED: a token applied on every paint (each repaint clears or resets again, and
    // the host repaints after every step), one compared by shape (the second, distinct Clear press
    // of the same row would do nothing), a clear routed to onReset or with the wrong accelerator,
    // a feedback line missing or not the catalog's, and a reset that does not say so.
    const { view, onClear, onReset } = rig();
    view.show();
    const nav = navOn('shortcuts', 'J_clear');
    const clearJ: ControlsRequest = { kind: 'clear', accel: 'J' };
    const p = paintOf({ nav, request: clearJ });
    view.paint(p);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledWith('J');
    expect(onReset).not.toHaveBeenCalled();
    expect(readable(el(FEEDBACK_ID), 'the feedback line')).toBe(
      tf('controls.cleared', { label: rowLabel(accRow('J')) }),
    );

    view.paint(p);
    view.paint({ ...p });
    view.paint(paintOf({ nav, request: clearJ }));
    expect(
      onClear,
      'the same token object, painted again, is not applied again',
    ).toHaveBeenCalledTimes(1);
    view.paint(paintOf({ nav }));
    expect(onClear, 'a paint with no request applies nothing').toHaveBeenCalledTimes(1);
    view.paint(paintOf({ nav, request: { kind: 'clear', accel: 'J' } }));
    expect(onClear, 'a NEW token with the same shape applies again').toHaveBeenCalledTimes(2);
    view.paint(
      paintOf({ nav: navOn('shortcuts', 'F9_clear'), request: { kind: 'clear', accel: 'F9' } }),
    );
    expect(onClear).toHaveBeenCalledTimes(3);
    expect(onClear).toHaveBeenLastCalledWith('F9');

    const reset: ControlsRequest = { kind: 'reset' };
    const r = paintOf({ nav: navOn('buttons', 'reset'), request: reset });
    view.paint(r);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onClear, 'a reset is not a clear').toHaveBeenCalledTimes(3);
    expect(readable(el(FEEDBACK_ID), 'the feedback line')).toBe(t('controls.reset.done'));
    view.paint(r);
    view.paint({ ...r });
    expect(onReset, 'once per token').toHaveBeenCalledTimes(1);
    view.paint(paintOf({ nav: navOn('buttons', 'reset'), request: { kind: 'reset' } }));
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it('when the handler answers false (the save failed) the feedback line also carries the save-failed text; when it answers true it does not', () => {
    // WRONG IMPL KILLED: a failed save reported as a plain success (the remap lasts only until a
    // reload and the player is never told), the result of onClear / onReset ignored, and a
    // save-failed line shown on every outcome.
    const failing = rig({ onClear: () => false, onReset: () => false });
    failing.view.show();
    failing.view.paint(
      paintOf({ nav: navOn('shortcuts', 'I_clear'), request: { kind: 'clear', accel: 'I' } }),
    );
    const cleared = tf('controls.cleared', { label: rowLabel(accRow('I')) });
    const failed = t('controls.saveFailed');
    let line = readable(el(FEEDBACK_ID), 'the feedback line');
    expect(line.startsWith(cleared), `starts with the outcome: ${line}`).toBe(true);
    expect(line.endsWith(failed), `ends with the save-failed text: ${line}`).toBe(true);
    failing.view.paint(paintOf({ nav: navOn('buttons', 'reset'), request: { kind: 'reset' } }));
    line = readable(el(FEEDBACK_ID), 'the feedback line');
    expect(line.startsWith(t('controls.reset.done')), line).toBe(true);
    expect(line.endsWith(failed), line).toBe(true);

    const saving = rig();
    saving.view.show();
    saving.view.paint(
      paintOf({ nav: navOn('shortcuts', 'I_clear'), request: { kind: 'clear', accel: 'I' } }),
    );
    expect(el(FEEDBACK_ID).textContent, 'a saved clear: the outcome alone').toBe(cleared);
    expect((el(FEEDBACK_ID).textContent ?? '').includes(failed)).toBe(false);
  });

  it('the token is applied BEFORE the rows render: a Clear or a Reset that changes the live table shows the new keycaps in the same paint', () => {
    // WRONG IMPL KILLED: a paint that renders first and applies the request after (the cleared
    // shortcut keeps showing its old key until some later step repaints, so the screen lies about
    // the table right after the player acted).
    let table: Bindings = withButtons({ A: ['KeyK', 'NumpadEnter'] });
    const { view } = rig({
      bindings: () => table,
      onClear: (accel) => {
        table = clearAccel(table, accel);
        return true;
      },
      onReset: () => {
        table = DEFAULT_BINDINGS;
        return true;
      },
    });
    view.show();
    const nav = navOn('shortcuts', 'J_clear');
    view.paint(paintOf({ nav }));
    expect(readCell('J_0'), 'before: J holds its key').toContain(glyph('KeyJ'));

    view.paint(paintOf({ nav, request: { kind: 'clear', accel: 'J' } }));
    expect(readCell('J_0'), 'the same paint shows it empty').toBe(
      tf('controls.slot.primary', { label: rowLabel(accRow('J')), key: EM_DASH }),
    );
    expect(readCell('J_1')).toBe(
      tf('controls.slot.alt', { label: rowLabel(accRow('J')), key: EM_DASH }),
    );

    view.paint(paintOf());
    expect(readCell('A_0'), 'before the reset: A is K').toContain(glyph('KeyK'));
    view.paint(paintOf({ nav: navOn('buttons', 'reset'), request: { kind: 'reset' } }));
    expect(readCell('A_0'), 'the same paint shows the default again').toBe(
      slotText(DEFAULT_BINDINGS, btnRow('A'), 0),
    );
  });
});

describe('ControlsView — capture state, focus and announcements (ctl-12b)', () => {
  it('`capturing` mirrors the last paint, is set even when a later step of that paint throws, and is null before any paint and after hide()', () => {
    // WRONG IMPL KILLED: a capture flag written at the END of paint (a throwing save or render
    // would leave the shell remapping keys for a capture the screen already left, or not
    // remapping for one it started), a flag that only ever turns on, and a hide() that leaves it
    // set (the next keydown after a battle force-hide would be captured into a slot).
    const aPrimary = slotOf(btnRow('A'), 0);
    const jAlt = slotOf(accRow('J'), 1);

    const plain = rig();
    expect(plain.view.capturing, 'nothing before the first paint').toBeNull();
    plain.view.show();
    plain.view.paint(paintOf({ capturing: aPrimary }));
    expect(plain.view.capturing).toEqual(aPrimary);
    plain.view.paint(paintOf({ nav: navOn('shortcuts', 'J_1'), capturing: jAlt }));
    expect(plain.view.capturing).toEqual(jAlt);
    plain.view.paint(paintOf());
    expect(plain.view.capturing, 'the capture ended').toBeNull();
    plain.view.paint(paintOf({ capturing: aPrimary }));
    plain.view.hide();
    expect(plain.view.capturing, 'hide() ends any capture').toBeNull();

    // A request whose handler throws.
    const throwingSave = rig({
      onClear: () => {
        throw new Error('storage exploded');
      },
    });
    throwingSave.view.show();
    try {
      throwingSave.view.paint(
        paintOf({ capturing: aPrimary, request: { kind: 'clear', accel: 'I' } }),
      );
    } catch {
      // Whether paint rethrows is not this test's business.
    }
    expect(throwingSave.view.capturing, 'set before the request step threw').toEqual(aPrimary);

    // A render whose table read throws.
    let explode = false;
    const throwingRender = rig({
      bindings: () => {
        if (explode) throw new Error('table unreadable');
        return DEFAULT_BINDINGS;
      },
    });
    throwingRender.view.show();
    throwingRender.view.paint(paintOf());
    explode = true;
    try {
      throwingRender.view.paint(paintOf({ nav: navOn('shortcuts', 'J_1'), capturing: jAlt }));
    } catch {
      // As above.
    }
    expect(throwingRender.view.capturing, 'set before the render threw').toEqual(jAlt);
  });

  it('hide() clears the feedback line, the capture prompt and the confirm: a re-shown frame shows none of them', () => {
    // WRONG IMPL KILLED: a hide() that only writes display (a reopened Controls screen would show
    // the last session's "Saved." line, a stale "Press a key…" prompt, or the Reset all question
    // with nothing behind it).
    const { view } = rig();
    view.show();
    view.paint(paintOf({ capturing: slotOf(btnRow('A'), 0) }));
    view.showFeedback(t('controls.bound'));
    expect(el(FEEDBACK_ID).textContent, 'precondition: a feedback line').toBe(t('controls.bound'));
    expect(hiddenAncestorOf(el(CAPTURE_ID)), 'precondition: the prompt is up').toBeNull();
    view.hide();
    expect(view.visible).toBe(false);
    expect(el(FEEDBACK_ID).textContent, 'the feedback line is cleared').toBe('');
    view.show();
    expect(view.visible).toBe(true);
    expect(el(FEEDBACK_ID).textContent, 'nothing on reopen').toBe('');
    expect(hiddenAncestorOf(el(CAPTURE_ID)), 'no prompt on reopen').not.toBeNull();
    expect(hiddenAncestorOf(el(CANCEL_ID)), 'no Cancel chip on reopen').not.toBeNull();

    view.paint(paintOf({ nav: navOn('buttons', 'reset'), confirm: confirmOn('no') }));
    expect(hiddenAncestorOf(el(QUESTION_ID)), 'precondition: the question is up').toBeNull();
    view.hide();
    view.show();
    expect(hiddenAncestorOf(el(QUESTION_ID)), 'no question on reopen').not.toBeNull();
  });

  it('the confirm renders the Yes / No listbox in #controls-rows, labelled by the shown #controls-question, aria-selected on the cursor row; its open edge announces the question once; closing it brings the grid back', () => {
    // WRONG IMPL KILLED: a confirm drawn somewhere a keyboard user cannot reach (outside the one
    // focusable container: aria-activedescendant would name nothing), a question left hidden, a
    // cursor that is not marked (the default No reads like Yes), the grid cells left under the
    // listbox, a question announced on every repaint, and a grid that never comes back.
    const { view, announce } = rig();
    view.show();
    view.paint(paintOf({ nav: navOn('buttons', 'reset') }));
    announce.mockClear();

    view.paint(paintOf({ nav: navOn('buttons', 'reset'), confirm: confirmOn('no') }));
    const rows = el(ROWS_ID);
    expect(rows.getAttribute('role'), 'a listbox').toBe('listbox');
    expect(rows.getAttribute('aria-labelledby'), 'named by the question').toBe(QUESTION_ID);
    const options = Array.from(rows.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(
      options.map((o) => o.dataset.navKey),
      'Yes then No',
    ).toEqual(['yes', 'no']);
    expect(rows.querySelectorAll('[role="gridcell"]'), 'no grid cell under it').toHaveLength(0);
    expect(cell('no').getAttribute('aria-selected'), 'the cursor on No').toBe('true');
    expect(cell('yes').getAttribute('aria-selected')).toBe('false');
    const yesText = readCell('yes');
    const noText = readCell('no');
    expect(yesText.length).toBeGreaterThan(0);
    expect(noText.length).toBeGreaterThan(0);
    expect(yesText, 'Yes and No read differently').not.toBe(noText);
    expect(readable(el(QUESTION_ID), 'the question')).toBe(t('controls.reset.question'));
    expect(announce, 'the open edge announces the question').toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(t('controls.reset.question'));

    view.paint(paintOf({ nav: navOn('buttons', 'reset'), confirm: confirmOn('yes') }));
    expect(cell('yes').getAttribute('aria-selected'), 'the cursor moved to Yes').toBe('true');
    expect(cell('no').getAttribute('aria-selected')).toBe('false');
    expect(
      announce,
      'a cursor move inside the confirm announces nothing more',
    ).toHaveBeenCalledTimes(1);

    view.paint(paintOf({ nav: navOn('buttons', 'reset') }));
    expect(hiddenAncestorOf(el(QUESTION_ID)), 'the question goes').not.toBeNull();
    expect(el(ROWS_ID).getAttribute('role'), 'the grid is back').toBe('grid');
    expect(readCell('reset')).toBe(t('controls.resetAll'));
  });

  it('the Cancel chip click calls onCancelCapture once and nothing else', () => {
    // WRONG IMPL KILLED: a chip wired to nothing (the pointer cancel is dead), to onClear or
    // onReset (a cancel that wipes a shortcut), and a listener bound twice.
    const { view, onCancelCapture, onClear, onReset } = rig();
    view.show();
    view.paint(paintOf({ capturing: slotOf(btnRow('A'), 0) }));
    (el(CANCEL_ID) as HTMLButtonElement).click();
    expect(onCancelCapture).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });

  it('isCancelChip is true for the #controls-cancel-btn element and false for #controls-rows, another button, null and the window', () => {
    // WRONG IMPL KILLED: an isCancelChip true for any native button (the shell would exempt a hint
    // chip's Enter from a capture and swallow it), true for any node of the frame (the rows' own
    // keys would never be captured), and one that dereferences its target (a keydown dispatched
    // at the window, or with no target, would throw out of the shell's key listener mid-capture).
    const { view } = rig();
    view.show();
    view.paint(paintOf({ capturing: slotOf(btnRow('A'), 0) }));
    const otherButton = document.createElement('button');
    otherButton.type = 'button';
    document.body.appendChild(otherButton);
    expect(view.isCancelChip(el(CANCEL_ID)), 'the chip itself').toBe(true);
    expect(view.isCancelChip(el(ROWS_ID)), 'the rows').toBe(false);
    expect(view.isCancelChip(otherButton), 'another button').toBe(false);
    expect(view.isCancelChip(null), 'no target').toBe(false);
    expect(view.isCancelChip(window), 'the window').toBe(false);
  });

  it('a capture start clears the old feedback line and announces the prompt, once per capture; showFeedback writes and announces its line, with the save-failed text when saved is false', () => {
    // WRONG IMPL KILLED: a stale outcome line left under a new prompt (the player reads "Saved."
    // while the slot still waits), a prompt never announced (a screen-reader user hears nothing
    // after pressing A), one announced on every repaint of the same capture, and a feedback line
    // written silently or announced with different text than it shows.
    const { view, announce } = rig();
    view.show();
    view.paint(paintOf());
    view.showFeedback(t('controls.cancelled'));
    expect(readable(el(FEEDBACK_ID), 'the feedback line')).toBe(t('controls.cancelled'));
    expect(announce).toHaveBeenLastCalledWith(t('controls.cancelled'));

    announce.mockClear();
    const aPrimary = slotOf(btnRow('A'), 0);
    view.paint(paintOf({ capturing: aPrimary }));
    expect(el(FEEDBACK_ID).textContent, 'the capture start clears the old line').toBe('');
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(capturePrompt(btnRow('A')));
    view.paint(paintOf({ capturing: aPrimary }));
    expect(announce, 'the same capture repainted announces nothing more').toHaveBeenCalledTimes(1);

    view.paint(paintOf());
    announce.mockClear();
    view.paint(paintOf({ nav: navOn('shortcuts', 'J_1'), capturing: slotOf(accRow('J'), 1) }));
    expect(announce, 'the next capture announces its own prompt').toHaveBeenCalledWith(
      capturePrompt(accRow('J')),
    );

    announce.mockClear();
    const failed = t('controls.saveFailed');
    view.showFeedback(t('controls.bound'), false);
    const line = readable(el(FEEDBACK_ID), 'the feedback line');
    expect(line.startsWith(t('controls.bound')), line).toBe(true);
    expect(line.endsWith(failed), line).toBe(true);
    expect(announce, 'announced as shown').toHaveBeenCalledWith(line);
  });

  it('when a capture ends while the Cancel chip holds focus, focus moves to #controls-rows; focus elsewhere is left alone', () => {
    // WRONG IMPL KILLED: a capture end that hides the focused chip and leaves focus on a hidden
    // node (it falls to <body>, outside the dialog: the focus trap goes inert and Tab walks the
    // page behind it), and one that yanks focus off a control the player chose.
    const { view } = rig();
    view.show();
    const aPrimary = slotOf(btnRow('A'), 0);
    view.paint(paintOf({ capturing: aPrimary }));
    const chip = el(CANCEL_ID);
    chip.focus();
    expect(document.activeElement, 'precondition: the chip holds focus').toBe(chip);
    view.paint(paintOf());
    expect(document.activeElement, 'focus back on the rows').toBe(el(ROWS_ID));

    const outside = document.createElement('button');
    outside.id = 'controls-test-outside';
    document.body.appendChild(outside);
    view.paint(paintOf({ capturing: aPrimary }));
    outside.focus();
    view.paint(paintOf());
    expect(document.activeElement, 'focus elsewhere stays').toBe(outside);
  });
});

describe('ControlsView — the frame (ctl-12b)', () => {
  it('#controls-rows is the focus anchor with tabindex 0 right after construction, before any paint', () => {
    // WRONG IMPL KILLED: a tabindex set only at the first paint (overlayA11y's deferred focus on
    // open lands before the first paint on some paths: an unfocusable anchor leaves focus outside
    // the dialog).
    rig();
    expect(el(ROWS_ID).getAttribute('tabindex')).toBe('0');
  });

  it('show() and hide() drive the dialog: role dialog, aria-modal and the catalog name on show, the deferred focus on #controls-rows, all three removed on hide', async () => {
    // WRONG IMPL KILLED: a show that never opens the a11y record (an unnamed, untrapped frame), one
    // opened under another overlay's id (the wrong name), a hide that leaves the dialog claim on a
    // display:none node, and a `visible` that disagrees with the paint.
    const { view } = rig();
    const root = el(OVERLAY_ID);
    expect(view.visible, 'constructed hidden').toBe(false);
    expect(root.style.display).toBe('none');
    expect(root.classList.contains('mr-frame'), 'class mr-frame').toBe(true);
    expect(root.classList.contains('mr-shell'), 'class mr-shell').toBe(true);

    view.show();
    expect(view.visible).toBe(true);
    expect(root.style.display).toBe('block');
    expect(root.getAttribute('role')).toBe('dialog');
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(root.getAttribute('aria-label'), 'named from the copy catalog').toBe(
      a11yT('a11y.overlay.controlsView.title'),
    );
    expect(
      root.querySelector(OVERLAY_A11Y.controlsView.initialFocusSelector),
      'the registry anchor is the rows container, inside the root',
    ).toBe(el(ROWS_ID));
    await flushMacrotask();
    expect(document.activeElement, 'the deferred focus lands on the rows').toBe(el(ROWS_ID));

    view.hide();
    expect(view.visible).toBe(false);
    expect(root.style.display).toBe('none');
    expect(root.getAttribute('role')).toBeNull();
    expect(root.getAttribute('aria-modal')).toBeNull();
    expect(root.getAttribute('aria-label')).toBeNull();
  });

  it('the root is created inside #frame-layer when present, else under <body>, and every id lives inside it', () => {
    // WRONG IMPL KILLED: a frame appended to <body> whatever the page has (painted over the canvas
    // instead of in the game screen, B3), and a node parked outside the root (hide() would leave it
    // on screen).
    const gameScreen = document.createElement('div');
    gameScreen.id = 'game-screen';
    const frameLayer = document.createElement('div');
    frameLayer.id = 'frame-layer';
    gameScreen.appendChild(frameLayer);
    document.body.replaceChildren(gameScreen);
    new ControlsView({
      bindings: () => DEFAULT_BINDINGS,
      onClear: () => true,
      onReset: () => true,
      onCancelCapture: () => {},
      announce: () => {},
    } as Handlers);
    const root = el(OVERLAY_ID);
    expect(frameLayer.contains(root), 'under #frame-layer').toBe(true);
    for (const id of ALL_IDS) {
      if (id === OVERLAY_ID) continue;
      expect(root.contains(el(id)), `#${id} is inside the root`).toBe(true);
    }

    const app = document.createElement('div');
    app.id = 'app';
    document.body.replaceChildren(app);
    new ControlsView({
      bindings: () => DEFAULT_BINDINGS,
      onClear: () => true,
      onReset: () => true,
      onCancelCapture: () => {},
      announce: () => {},
    } as Handlers);
    expect(el(OVERLAY_ID).parentElement, 'else directly under <body>').toBe(document.body);
  });

  it('every shown control is reachable by the ancestor walk (nothing left display:none by the ensureElement trap), and the walk reports a real hidden ancestor before show()', () => {
    // WRONG IMPL KILLED: the claimView shape: nodes created display:none by ensureElement and never
    // un-hidden, so the title, the tabs, the rows or the feedback line exist (and a click still
    // fires) while a sighted player sees an empty box.
    const { view } = rig();
    expect(
      hiddenAncestorOf(el(ROWS_ID)),
      'ANTI-VACUITY: before show() the rows are inside a hidden root',
    ).not.toBeNull();
    view.show();
    view.paint(paintOf());
    expect(el(TITLE_ID).tagName, 'the title is a heading').toBe('H2');
    expect(readable(el(TITLE_ID), 'the title')).toBe(t('controls.title'));
    for (const id of [TABS_ID, TAB_BUTTONS_ID, TAB_SHORTCUTS_ID, ROWS_ID]) {
      expect(hiddenAncestorOf(el(id)), `#${id} is on screen`).toBeNull();
    }
    for (const node of Array.from(el(ROWS_ID).querySelectorAll('[data-nav-key]'))) {
      expect(hiddenAncestorOf(node), `cell ${(node as HTMLElement).dataset.navKey}`).toBeNull();
    }
    view.paint(paintOf({ capturing: slotOf(btnRow('B'), 1) }));
    expect(hiddenAncestorOf(el(CAPTURE_ID)), 'the prompt while capturing').toBeNull();
    expect(hiddenAncestorOf(el(CANCEL_ID)), 'the Cancel chip while capturing').toBeNull();
    view.paint(paintOf({ nav: navOn('buttons', 'reset'), confirm: confirmOn('no') }));
    expect(hiddenAncestorOf(el(QUESTION_ID)), 'the question while confirming').toBeNull();
    expect(hiddenAncestorOf(cell('yes')), 'Yes').toBeNull();
    expect(hiddenAncestorOf(cell('no')), 'No').toBeNull();
    view.showFeedback(t('controls.bound'));
    expect(hiddenAncestorOf(el(FEEDBACK_ID)), 'the feedback line once written').toBeNull();
  });
});
