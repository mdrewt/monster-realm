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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { ControlsView, savedLine } from './controlsView';
import { setLocale, t, tf } from './i18n/resolver';
import { type NavState, navFocus, navInit } from './nav';
import { closeOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y } from './overlayRegistry';
import {
  CONTROLS_LAYOUT,
  type ControlsPaint,
  type ControlsRequest,
  type ControlsState,
  controlsScreen,
} from './screens/optionsScreen';
import { createTabBar, renderTabBar } from './tabBar';

// --- the contract, spelled once ---------------------------------------------------------------

const OVERLAY_ID = 'controls-overlay';
const TITLE_ID = 'controls-title';
const TABS_ID = 'controls-tabs';
const TAB_BUTTONS_ID = 'controls-tab-buttons';
const TAB_SHORTCUTS_ID = 'controls-tab-shortcuts';
const TAB_DISPLAY_ID = 'controls-tab-display';
const ROWS_ID = 'controls-rows';
const CAPTURE_ID = 'controls-capture';
const CANCEL_ID = 'controls-cancel-btn';
// INTENTIONAL CHANGE (uif-13, UIF13.1): `#controls-question` is RETIRED. The Reset all question is the
// confirm ContextSheet's heading (`#controls-sheet-title`) and the answers are `#controls-yes` /
// `#controls-no` in the sheet. The id stays here only for the assertions that it no longer exists.
const QUESTION_ID = 'controls-question';
const SHEET_TITLE_ID = 'controls-sheet-title';
// The kit's id scheme for a tab-less list is `${frame}-root-${key}`.
const YES_ID = 'controls-root-yes';
const NO_ID = 'controls-root-no';
const FEEDBACK_ID = 'controls-feedback';
// INTENTIONAL CHANGE (uif-13, UIF13.1): QUESTION_ID leaves this roster (the node is gone). Was: it was
// listed here as an id that must exist inside the frame root from construction.
const ALL_IDS: readonly string[] = [
  OVERLAY_ID,
  TITLE_ID,
  TABS_ID,
  ROWS_ID,
  CAPTURE_ID,
  CANCEL_ID,
  FEEDBACK_ID,
];

/** U+2026 HORIZONTAL ELLIPSIS and U+2014 EM DASH, built from their code points. */
const ELLIPSIS = String.fromCodePoint(0x2026);
const EM_DASH = String.fromCodePoint(0x2014);

type Handlers = ConstructorParameters<typeof ControlsView>[0];

const btnRow = (id: VButton): ControlsRow => ({ kind: 'button', id });
const accRow = (id: Accel): ControlsRow => ({ kind: 'accel', id });
const slotOf = (row: ControlsRow, slot: Slot): SlotTarget => ({ row, slot });

/** The cursor on `tab` (its first cell, or `item`). uif-13: Display is the third tab. */
const navOn = (tab: 'buttons' | 'shortcuts' | 'display', item?: string): NavState =>
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

/** A text-size step, spelled here so this file imports nothing from the new `displayPrefs` module. */
type Step = 'normal' | 'large' | 'xlarge';

interface RigOptions {
  readonly bindings?: () => Bindings;
  readonly onClear?: (accel: Accel) => boolean;
  readonly onReset?: () => boolean;
  /** uif-13: the live text-size step the view marks current (default: normal). */
  readonly step?: () => Step;
  /** uif-13: apply + save a step; false when the save failed (default: true). */
  readonly onTextStep?: (step: Step) => boolean;
}

/** A fresh document and one view over it, every handler a spy. */
function rig(opts: RigOptions = {}) {
  closeOverlayA11y('controlsView', null);
  document.body.replaceChildren();
  const onClear = vi.fn(opts.onClear ?? ((_accel: Accel): boolean => true));
  const onReset = vi.fn(opts.onReset ?? ((): boolean => true));
  const onCancelCapture = vi.fn();
  const announce = vi.fn();
  // INTENTIONAL CHANGE (uif-4b, UIF4B.1): the handlers gain `onOutcome(text, saved)`, which carries
  // the Clear and Reset outcome lines to the seam (main routes them to the toast). Was: the view
  // wrote those lines itself through `showFeedback`.
  const onOutcome = vi.fn();
  // uif-13 (UIF13.2, UIF13.3): the handlers gain `textStep()` (the live step, read on every paint)
  // and `onTextStep(step)` (applied + saved, false when the save failed).
  const textStep = vi.fn(opts.step ?? ((): Step => 'normal'));
  const onTextStep = vi.fn(opts.onTextStep ?? ((_step: Step): boolean => true));
  const view = new ControlsView({
    bindings: opts.bindings ?? (() => DEFAULT_BINDINGS),
    onClear,
    onReset,
    onCancelCapture,
    announce,
    onOutcome,
    textStep,
    onTextStep,
  } as Handlers);
  return { view, onClear, onReset, onCancelCapture, announce, onOutcome, textStep, onTextStep };
}

/** uif-4b: the strip (`#controls-feedback`) is out of sight: `hidden` or `display:none`, on itself or
 *  an ancestor. Either spelling counts, so the test pins the behaviour, not the attribute. */
function stripHidden(): boolean {
  for (
    let node: Element | null = el(FEEDBACK_ID);
    node instanceof HTMLElement;
    node = node.parentElement
  ) {
    if (node.hidden || node.style.display === 'none') return true;
  }
  return false;
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

/** Out of sight by `display:none` OR the `hidden` attribute, on the node or any ancestor (the kit's
 *  TabBar root and ContextSheet root use `hidden`, which `hiddenAncestorOf` above does not read). A
 *  missing node counts as hidden. */
function isHidden(start: Element | null): boolean {
  for (let node: Element | null = start; node instanceof HTMLElement; node = node.parentElement) {
    if (node.hidden || node.style.display === 'none') return true;
  }
  return !(start instanceof HTMLElement);
}

/** Every context sheet in the document, shown or not. */
const allSheets = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-context-sheet]'));
/** The context sheets a player can see. */
const shownSheets = (): HTMLElement[] => allSheets().filter((sheet) => !isHidden(sheet));
/** The one shown sheet (fails the test when there is not exactly one). */
function theSheet(): HTMLElement {
  const shown = shownSheets();
  expect(shown, 'exactly one context sheet is shown').toHaveLength(1);
  return shown[0] as HTMLElement;
}
/** The nav container of the shown confirm sheet: the one holding `#controls-no`. */
const sheetRowsEl = (): HTMLElement => {
  const rows = el(NO_ID).closest<HTMLElement>('[role="listbox"]');
  expect(rows, 'the sheet answers sit in a listbox').not.toBeNull();
  return rows as HTMLElement;
};

/** A real session: the view painted by the real `controlsScreen` as buttons are pressed on it. */
function pilot(view: ControlsView) {
  let state: ControlsState = controlsScreen.init(null);
  const paint = (): void => controlsScreen.paint?.(view, null, state);
  paint();
  return {
    press(...buttons: readonly VButton[]): void {
      for (const button of buttons) {
        state = controlsScreen.onButton(null, state, { button, repeat: false }).state;
        paint();
      }
    },
    get state(): ControlsState {
      return state;
    },
  };
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
  it('CTL12B-1-VIEW-ROWS: painted on the Buttons tab the view shows the three tabs (uif-13 added Display) and the twelve button rows, each one Primary and one Alt cell naming the row and its live keycap (an empty slot reads the none mark), no Clear cell, then Reset all; the Shortcuts tab shows Primary, Alt and Clear per row', () => {
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
    // INTENTIONAL CHANGE (uif-13, UIF13.2): the strip gains the Display tab after Shortcuts (its
    // label and rows are pinned by the UIF13.2 cases at the end of this file). Was: exactly the two
    // tabs `[TAB_BUTTONS_ID, TAB_SHORTCUTS_ID]`.
    expect(
      Array.from(strip.querySelectorAll('[role="tab"]')).map((x) => x.id),
      'three tabs, Buttons, Shortcuts then Display',
    ).toEqual([TAB_BUTTONS_ID, TAB_SHORTCUTS_ID, TAB_DISPLAY_ID]);
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

  it('UIF4B.1 a request token is applied exactly once however often it is painted; a new token applies again: clear calls onClear(accel) then onOutcome(cleared line, true), reset calls onReset() then onOutcome(done line, true), and the view writes no line of its own', () => {
    // INTENTIONAL CHANGE (uif-4b, UIF4B.1): the Clear and Reset outcome lines are handed to
    // `handlers.onOutcome(text, saved)` (main routes them through the one seam, to the toast); the
    // view no longer writes `#controls-feedback` for them. Was: the view wrote the line itself.
    // WRONG IMPL KILLED: a token applied on every paint (each repaint clears or resets again, and
    // the host repaints after every step), one compared by shape (the second, distinct Clear press
    // of the same row would do nothing), a clear routed to onReset or with the wrong accelerator,
    // an outcome line missing or not the catalog's, a reset that does not say so, and a view that
    // still paints its own strip (a second channel for the same message).
    const { view, onClear, onReset, onOutcome, announce } = rig();
    view.show();
    const nav = navOn('shortcuts', 'J_clear');
    const clearJ: ControlsRequest = { kind: 'clear', accel: 'J' };
    const p = paintOf({ nav, request: clearJ });
    view.paint(p);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledWith('J');
    expect(onReset).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenLastCalledWith(
      tf('controls.cleared', { label: rowLabel(accRow('J')) }),
      true,
    );
    expect(el(FEEDBACK_ID).textContent, 'the view paints no strip line of its own').toBe('');
    expect(stripHidden(), 'and the strip stays hidden').toBe(true);
    expect(announce, 'and does not announce it (the toast does)').not.toHaveBeenCalledWith(
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
    expect(onOutcome, 'one outcome per applied token so far').toHaveBeenCalledTimes(4);
    expect(onOutcome).toHaveBeenLastCalledWith(t('controls.reset.done'), true);
    view.paint(r);
    view.paint({ ...r });
    expect(onReset, 'once per token').toHaveBeenCalledTimes(1);
    view.paint(paintOf({ nav: navOn('buttons', 'reset'), request: { kind: 'reset' } }));
    expect(onReset).toHaveBeenCalledTimes(2);
  });

  it('UIF4B.1 when the handler answers false (the save failed) onOutcome gets saved=false with the plain outcome text; when it answers true it gets saved=true', () => {
    // INTENTIONAL CHANGE (uif-4b, UIF4B.1): the save-failed suffix is composed by the pure
    // `savedLine` helper at the seam, so the view hands over the PLAIN text plus the flag. Was: the
    // view appended `controls.saveFailed` to its own strip line.
    // WRONG IMPL KILLED: a failed save reported as a plain success (saved=true: the remap lasts only
    // until a reload and the player is never told), the result of onClear / onReset ignored, a
    // saved=false on every outcome, and the suffix pre-appended to the text (it would be doubled by
    // the seam's savedLine).
    const failing = rig({ onClear: () => false, onReset: () => false });
    failing.view.show();
    failing.view.paint(
      paintOf({ nav: navOn('shortcuts', 'I_clear'), request: { kind: 'clear', accel: 'I' } }),
    );
    const cleared = tf('controls.cleared', { label: rowLabel(accRow('I')) });
    expect(failing.onOutcome).toHaveBeenLastCalledWith(cleared, false);
    failing.view.paint(paintOf({ nav: navOn('buttons', 'reset'), request: { kind: 'reset' } }));
    expect(failing.onOutcome).toHaveBeenLastCalledWith(t('controls.reset.done'), false);
    expect(failing.onOutcome).toHaveBeenCalledTimes(2);

    const saving = rig();
    saving.view.show();
    saving.view.paint(
      paintOf({ nav: navOn('shortcuts', 'I_clear'), request: { kind: 'clear', accel: 'I' } }),
    );
    expect(saving.onOutcome).toHaveBeenCalledTimes(1);
    expect(saving.onOutcome).toHaveBeenLastCalledWith(cleared, true);
  });

  it('UIF4B.1 savedLine(text, saved) is the text when saved and `${text} ${controls.saveFailed}` when not, in the active locale', () => {
    // WRONG IMPL KILLED: a helper that always appends, never appends, drops the space, or reads the
    // suffix at import time (frozen in en under fr).
    expect(savedLine('Saved.', true)).toBe('Saved.');
    expect(savedLine('Saved.', false)).toBe(`Saved. ${t('controls.saveFailed')}`);
    expect(t('controls.saveFailed').length, 'fixture: a real suffix').toBeGreaterThan(0);
    setLocale('fr');
    expect(savedLine('Saved.', false)).toBe(`Saved. ${t('controls.saveFailed')}`);
    expect(savedLine('Saved.', false)).not.toBe('Saved. ');
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

  it('UIF4B.1 hide() clears and hides the strip, the capture prompt and the confirm: a re-shown frame shows none of them', () => {
    // INTENTIONAL CHANGE (uif-4b, UIF4B.1): the strip is written by `showHint` (was `showFeedback`)
    // and hide() also HIDES it (it is hidden while empty).
    // WRONG IMPL KILLED: a hide() that only writes display (a reopened Controls screen would show
    // the last session's refused hint, a stale "Press a key…" prompt, or the Reset all question
    // with nothing behind it), and a hide() that empties the strip but leaves its box showing.
    const { view } = rig();
    view.show();
    view.paint(paintOf({ capturing: slotOf(btnRow('A'), 0) }));
    view.showHint(t('controls.refused.reserved'));
    expect(el(FEEDBACK_ID).textContent, 'precondition: a hint on the strip').toBe(
      t('controls.refused.reserved'),
    );
    expect(stripHidden(), 'precondition: the strip is up').toBe(false);
    expect(hiddenAncestorOf(el(CAPTURE_ID)), 'precondition: the prompt is up').toBeNull();
    view.hide();
    expect(view.visible).toBe(false);
    expect(el(FEEDBACK_ID).textContent, 'the strip is cleared').toBe('');
    expect(el(FEEDBACK_ID).hidden || el(FEEDBACK_ID).style.display === 'none', 'and hidden').toBe(
      true,
    );
    view.show();
    expect(view.visible).toBe(true);
    expect(el(FEEDBACK_ID).textContent, 'nothing on reopen').toBe('');
    expect(stripHidden(), 'the strip is hidden on reopen').toBe(true);
    expect(hiddenAncestorOf(el(CAPTURE_ID)), 'no prompt on reopen').not.toBeNull();
    expect(hiddenAncestorOf(el(CANCEL_ID)), 'no Cancel chip on reopen').not.toBeNull();

    // INTENTIONAL CHANGE (uif-13, UIF13.1): the question is the confirm sheet's heading, not
    // `#controls-question` (retired). Was: `hiddenAncestorOf(el(QUESTION_ID))` before and after the
    // hide / show. The intent is kept: no Reset all question stands on a re-shown frame.
    view.paint(paintOf({ nav: navOn('buttons', 'reset'), confirm: confirmOn('no') }));
    expect(shownSheets(), 'precondition: the question is up (one confirm sheet)').toHaveLength(1);
    expect(isHidden(el(SHEET_TITLE_ID)), 'precondition: its heading shows').toBe(false);
    view.hide();
    view.show();
    expect(shownSheets(), 'no question on reopen').toHaveLength(0);
    expect(document.getElementById(QUESTION_ID), 'and #controls-question is retired').toBeNull();
  });

  it('the confirm renders the Yes / No listbox in the confirm sheet, labelled by the shown sheet heading, aria-selected on the cursor row; its open edge announces the question once; closing it hides the sheet', () => {
    // INTENTIONAL CHANGE (uif-13, UIF13.1): the Yes / No listbox moves from `#controls-rows` (which
    // swapped to it, labelled by `#controls-question`) into the confirm ContextSheet, labelled by
    // the sheet heading `#controls-sheet-title`; `#controls-rows` stays the GRID throughout (pinned
    // by the UIF13.1 grid case below). Was: `rows.getAttribute('role') === 'listbox'` on
    // `#controls-rows`, `aria-labelledby === QUESTION_ID`, cells read from `#controls-rows`, and
    // "the grid is back" after the close. Every old WRONG-IMPL-KILLED intent is kept below.
    // WRONG IMPL KILLED: a confirm drawn somewhere a keyboard user cannot reach (aria-activedescendant
    // would name nothing), a question left hidden, a cursor that is not marked (the default No reads
    // like Yes), a question announced on every repaint, and a sheet that never closes.
    const { view, announce } = rig();
    view.show();
    view.paint(paintOf({ nav: navOn('buttons', 'reset') }));
    announce.mockClear();

    view.paint(paintOf({ nav: navOn('buttons', 'reset'), confirm: confirmOn('no') }));
    const sheet = theSheet();
    const rows = sheetRowsEl();
    expect(sheet.contains(rows), 'the listbox is in the sheet').toBe(true);
    expect(rows.getAttribute('aria-labelledby'), 'named by the question').toBe(SHEET_TITLE_ID);
    const options = Array.from(rows.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(
      options.map((o) => o.id),
      'Yes then No',
    ).toEqual([YES_ID, NO_ID]);
    expect(rows.querySelectorAll('[role="gridcell"]'), 'no grid cell in it').toHaveLength(0);
    expect(el(NO_ID).getAttribute('aria-selected'), 'the cursor on No').toBe('true');
    expect(el(YES_ID).getAttribute('aria-selected')).toBe('false');
    const yesText = readable(el(YES_ID), 'Yes');
    const noText = readable(el(NO_ID), 'No');
    expect(yesText).toBe('Yes');
    expect(noText).toBe('No');
    expect(readable(el(SHEET_TITLE_ID), 'the question')).toBe(t('controls.reset.question'));
    expect(announce, 'the open edge announces the question').toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(t('controls.reset.question'));

    view.paint(paintOf({ nav: navOn('buttons', 'reset'), confirm: confirmOn('yes') }));
    expect(el(YES_ID).getAttribute('aria-selected'), 'the cursor moved to Yes').toBe('true');
    expect(el(NO_ID).getAttribute('aria-selected')).toBe('false');
    expect(
      announce,
      'a cursor move inside the confirm announces nothing more',
    ).toHaveBeenCalledTimes(1);

    view.paint(paintOf({ nav: navOn('buttons', 'reset') }));
    expect(shownSheets(), 'the sheet goes').toHaveLength(0);
    expect(el(ROWS_ID).getAttribute('role'), 'the grid is as it was').toBe('grid');
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

  it('UIF4B.1 a capture start clears and hides the old strip hint and announces the prompt, once per capture; showHint writes the strip, un-hides it and announces its text once per call', () => {
    // INTENTIONAL CHANGE (uif-4b, UIF4B.1): `showHint(text)` replaces `showFeedback(text, saved)`:
    // the strip carries ONLY a hint (a refused key), the saved/failed outcomes go to the toast.
    // Was: showFeedback also composed the save-failed suffix and carried outcome lines.
    // WRONG IMPL KILLED: a stale hint left under a new prompt, a prompt never announced (a
    // screen-reader user hears nothing after pressing A), one announced on every repaint of the same
    // capture, a hint written silently or announced with different text than it shows, one that
    // writes the text but leaves the strip hidden (the player sees nothing), and a hint announced
    // twice for one show.
    const { view, announce } = rig();
    view.show();
    view.paint(paintOf());
    expect(stripHidden(), 'the strip starts hidden while empty').toBe(true);
    view.showHint(t('controls.refused.reserved'));
    expect(readable(el(FEEDBACK_ID), 'the strip')).toBe(t('controls.refused.reserved'));
    expect(stripHidden(), 'showHint un-hides the strip').toBe(false);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith(t('controls.refused.reserved'));

    announce.mockClear();
    const aPrimary = slotOf(btnRow('A'), 0);
    view.paint(paintOf({ capturing: aPrimary }));
    expect(el(FEEDBACK_ID).textContent, 'the capture start clears the old hint').toBe('');
    expect(stripHidden(), 'and hides the strip').toBe(true);
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
    view.showHint(t('controls.refused.protected'));
    expect(readable(el(FEEDBACK_ID), 'the strip')).toBe(t('controls.refused.protected'));
    expect(announce, 'announced as shown, once').toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(t('controls.refused.protected'));
  });

  it('UIF4B.1 the strip is #controls-feedback with the shared mr-frame-feedback class from construction, hidden while empty, and the view offers no showFeedback', () => {
    // WRONG IMPL KILLED: a strip without the shared class (it would reflow the frame body: the
    // class is the zero-layout-height sticky strip), one visible while empty (a blank box), a new
    // selector instead of the reused class, and a surviving `showFeedback` (a second way for a
    // caller to choose the channel).
    const { view } = rig();
    const strip = el(FEEDBACK_ID);
    expect(strip.classList.contains('mr-frame-feedback'), 'the shared strip class').toBe(true);
    expect(strip.textContent, 'empty at construction').toBe('');
    expect(stripHidden(), 'hidden at construction').toBe(true);
    view.show();
    expect(stripHidden(), 'hidden while empty after show').toBe(true);
    expect('showFeedback' in view, 'no showFeedback on the view').toBe(false);
    expect(typeof view.showHint, 'showHint is the one writer').toBe('function');
  });

  it('UIF4B.1 a hint survives a repaint of the same capture and is cleared and hidden by the capture ENDING (a paint with nothing capturing)', () => {
    // WRONG IMPL KILLED: a paint that clears the strip on every repaint (the host repaints after the
    // refused step itself, so the hint would vanish at once), and a capture end that leaves the last
    // hint standing under a browsing grid.
    const { view } = rig();
    view.show();
    const aPrimary = slotOf(btnRow('A'), 0);
    view.paint(paintOf({ capturing: aPrimary }));
    view.showHint(t('controls.refused.reserved'));
    view.paint(paintOf({ capturing: aPrimary }));
    expect(el(FEEDBACK_ID).textContent, 'the repaint of the same capture keeps it').toBe(
      t('controls.refused.reserved'),
    );
    expect(stripHidden(), 'still shown').toBe(false);
    view.paint(paintOf());
    expect(el(FEEDBACK_ID).textContent, 'the capture ended: cleared').toBe('');
    expect(stripHidden(), 'and hidden').toBe(true);
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

describe('ControlsView ts-6b-11: the Controls title sits in the kit title bar', () => {
  it('the Controls frame has one title bar and no in-panel heading', () => {
    // WRONG IMPLS KILLED: the bare h2 appended straight into the overlay (no `.mr-frame-titlebar`);
    // a title bar that is not the overlay's first element child; a title without
    // `.mr-frame-title`; a title that is not an h2; a title bar created unconditionally, so a
    // second view duplicates it (parts are located before they are created); a heading left in
    // the panel body outside the bar and the context sheet.
    const { view, onCancelCapture } = rig();
    view.show();
    view.paint(paintOf());
    const overlay = el(OVERLAY_ID);

    const bars = overlay.querySelectorAll<HTMLElement>('.mr-frame-titlebar');
    expect(bars, 'exactly one title bar in the frame').toHaveLength(1);
    const bar = bars[0] as HTMLElement;
    expect(overlay.firstElementChild, 'the title bar is the overlay first element child').toBe(bar);
    expect(bar.tagName, 'the title bar is a div').toBe('DIV');

    const title = el(TITLE_ID);
    expect(title.tagName, 'the title stays an h2').toBe('H2');
    expect(bar.contains(title), 'the title is inside the title bar').toBe(true);
    expect(title.classList.contains('mr-frame-title'), 'the title wears .mr-frame-title').toBe(
      true,
    );
    expect(title.style.color, 'the kit paints the title: no inline colour').toBe('');
    expect(['0', '0px'], 'the bar owns the spacing: the title margin is 0').toContain(
      title.style.margin,
    );
    expect(isHidden(title), 'the title is on screen').toBe(false);
    expect(isHidden(bar), 'the title bar is on screen').toBe(false);

    const stray = [...overlay.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].filter(
      (h) => !bar.contains(h) && h.closest('[data-context-sheet]') === null,
    );
    expect(
      stray.map((h) => `${h.tagName.toLowerCase()}:${h.id}`),
      'no heading outside the title bar and the context sheet',
    ).toEqual([]);

    // A second view over the same document finds the bar and creates none.
    new ControlsView({
      bindings: () => DEFAULT_BINDINGS,
      onClear: () => true,
      onReset: () => true,
      onCancelCapture,
      announce: vi.fn(),
      onOutcome: vi.fn(),
      textStep: () => 'normal',
      onTextStep: () => true,
    } as Handlers);
    expect(
      overlay.querySelectorAll('.mr-frame-titlebar'),
      'a second view duplicates no title bar',
    ).toHaveLength(1);
    expect(document.querySelectorAll(`#${TITLE_ID}`), 'nor the title').toHaveLength(1);
    expect(overlay.firstElementChild, 'the bar is still first').toBe(bar);
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
    // INTENTIONAL CHANGE (uif-13, UIF13.1): the question, Yes and No are the confirm sheet's heading
    // and rows (the sheet and its heading use `hidden`, so `isHidden` reads both spellings). Was:
    // `#controls-question` and the Yes / No cells of `#controls-rows`.
    view.paint(paintOf({ nav: navOn('buttons', 'reset'), confirm: confirmOn('no') }));
    expect(isHidden(el(SHEET_TITLE_ID)), 'the question while confirming').toBe(false);
    expect(isHidden(el(YES_ID)), 'Yes').toBe(false);
    expect(isHidden(el(NO_ID)), 'No').toBe(false);
    // INTENTIONAL CHANGE (uif-4b): the strip shows through `showHint` (was `showFeedback`) and is
    // hidden until then.
    view.showHint(t('controls.refused.reserved'));
    expect(hiddenAncestorOf(el(FEEDBACK_ID)), 'the strip once a hint is written').toBeNull();
    expect(stripHidden(), 'and not hidden by the hidden attribute either').toBe(false);
  });
});

// --- qf-11 (QF11.2, QF11.3): the Controls tabs adopt the shared horizontal tab-strip class --------
//
// EARS: THE controls (`#controls-tabs`) tab container SHALL adopt the shared horizontal tab-strip
// class, so its tab labels lay out horizontally; WHEN qf-11 lands THE tab semantics SHALL be
// unchanged (LB/RB switching, the active-tab indicator and the nav-tab roles stay as shipped).
//
// ORACLE. The REAL styles.css is injected into happy-dom and the strip is read through
// getComputedStyle. happy-dom caches computed style per element, so each read is a fresh shallow
// clone (same classes, same parent) taken after the state change under test; the sanity probe drops
// the class from a clone and must not be a flex row, so the class (not a default) is the cause.
// Before this slice `#controls-tabs` was a bare `ensureElement` div (computed display `block`).

const QF11_STYLES_CSS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'),
  'utf8',
);
const QF11_STRIP_CLASS = 'mr-frame-tabstrip';

interface Qf11Snapshot {
  readonly display: string;
  readonly flexDirection: string;
  readonly flexBasis: string;
  readonly maxWidth: string;
  /** flex-grow as a number; NaN (never 0) when happy-dom exposes neither the longhand nor the
   *  first token of the shorthand. */
  readonly grow: number;
}

/** Inline properties that could stretch, stack or freeze a strip. */
const QF11_BANNED_INLINE: readonly string[] = [
  'flex',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'flex-direction',
  'flex-flow',
  'height',
  'block-size',
  'min-height',
  'max-height',
  'width',
  'min-width',
  'max-width',
];

/** The banned layout properties `el` sets inline, read from the style attribute and from the style
 *  object (so `style.flexGrow = '1'`, `style.flex = ...` and cssText are all seen). */
function qf11InlineLayout(el: Element): string[] {
  const found = new Set<string>();
  for (const part of (el.getAttribute('style') ?? '').split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    if (QF11_BANNED_INLINE.includes(prop)) found.add(prop);
  }
  const style = (el as HTMLElement).style;
  for (const prop of QF11_BANNED_INLINE) {
    if (style.getPropertyValue(prop) !== '') found.add(prop);
  }
  return [...found];
}

/** The computed layout of a fresh shallow clone of `node` (optionally without the strip class). The
 *  clone KEEPS the id, so an id-keyed rule (C4) would still match it. */
function qf11Probe(node: HTMLElement, dropClass = false): Qf11Snapshot {
  const probe = node.cloneNode(false) as HTMLElement;
  if (dropClass) probe.classList.remove(QF11_STRIP_CLASS);
  (node.parentElement ?? document.body).appendChild(probe);
  const style = getComputedStyle(probe);
  const first = style.flex.trim().split(/\s+/)[0] ?? '';
  let grow = Number.NaN;
  if (style.flexGrow !== '') grow = Number(style.flexGrow);
  else if (first === 'none') grow = 0;
  else if (first !== '') grow = Number(first);
  const snapshot = {
    display: style.display,
    flexDirection: style.flexDirection,
    flexBasis: style.flexBasis,
    maxWidth: style.maxWidth,
    grow,
  };
  probe.remove();
  return snapshot;
}

describe('ControlsView qf-11: the Controls tab strip (QF11.2, QF11.3)', () => {
  let sheet: HTMLStyleElement | null = null;
  beforeEach(() => {
    sheet = document.createElement('style');
    sheet.textContent = QF11_STYLES_CSS;
    document.head.appendChild(sheet);
  });
  afterEach(() => {
    sheet?.remove();
    sheet = null;
  });

  it('#controls-tabs carries mr-frame-tabstrip from construction on and through every show, paint, tab switch, capture, confirm, hide and re-show, and it is the only strip in the frame [QF11-2-CONTROLS-CLASS]', () => {
    // WRONG IMPL KILLED: the shipped bare `ensureElement` div (no class); the class added only in
    // show() or the first paint (missing at construction, or lost on the next state); a
    // renderTabs-style className assignment that wipes the class on a paint; a hide() that resets
    // it; the class put on the root or on the rows container (the grid would lay out as a row)
    // instead of on the tab container alone.
    const { view } = rig();
    const strip = el(TABS_ID);
    const root = el(OVERLAY_ID);
    const expectAdopted = (when: string): void => {
      expect(el(TABS_ID), `${when}: still the same node`).toBe(strip);
      expect(strip.classList.contains(QF11_STRIP_CLASS), `${when}: carries the strip class`).toBe(
        true,
      );
      expect(
        Array.from(document.querySelectorAll(`.${QF11_STRIP_CLASS}`)).map((e) => e.id),
        `${when}: #controls-tabs is the only tab strip in the document`,
      ).toEqual([TABS_ID]);
      expect(root.classList.contains(QF11_STRIP_CLASS), `${when}: not the root`).toBe(false);
    };

    expectAdopted('constructed');
    view.show();
    expectAdopted('shown');
    view.paint(paintOf());
    // INTENTIONAL CHANGE (uif-13, UIF13.2): three tabs now (Display added). Was: `.toBe(2)`.
    expect(strip.children.length, 'precondition: all three tabs rendered').toBe(3);
    expectAdopted('painted');
    view.paint(paintOf({ nav: navOn('shortcuts') }));
    expectAdopted('on Shortcuts');
    view.paint(paintOf({ capturing: slotOf(btnRow('B'), 1) }));
    expectAdopted('while capturing');
    view.paint(paintOf({ nav: navOn('buttons', 'reset'), confirm: confirmOn('no') }));
    expectAdopted('while confirming');
    view.hide();
    expectAdopted('hidden');
    view.show();
    view.paint(paintOf());
    expectAdopted('re-shown and painted');
  });

  it('#controls-tabs computes as a horizontal flex row that does not grow in the frame column after every state change, and loses that without the class [QF11-2-CONTROLS-HORIZONTAL]', () => {
    // WRONG IMPL KILLED: the shipped bare div (computed display block: Buttons and Shortcuts stack
    // on two lines); a class on the element but a sheet that gives it no flex layout; a
    // flex-direction: column strip; a strip that still grows vertically in the `.mr-frame` column
    // (grow 1); a layout that holds only on the first paint (probed again after a tab switch and
    // after a hide / show / paint); a harness whose sheet install is a no-op (the class-less probe
    // must differ).
    const { view } = rig();
    view.show();
    view.paint(paintOf());
    const strip = el(TABS_ID);
    // INTENTIONAL CHANGE (uif-13, UIF13.2): three tabs now (Display added). Was: `.toBe(2)`.
    expect(strip.children.length, 'ANTI-VACUITY: all three tabs rendered').toBe(3);
    expect(hiddenAncestorOf(strip), 'ANTI-VACUITY: the strip is on screen').toBeNull();
    expect(el(OVERLAY_ID).classList.contains('mr-frame'), 'inside a .mr-frame column').toBe(true);

    const expectRow = (when: string): void => {
      const now = qf11Probe(strip);
      expect(now.display, `${when}: a flex container`).toBe('flex');
      expect(now.flexDirection, `${when}: not a column`).not.toBe('column');
      expect(now.grow, `${when}: flex-grow`).toBe(0);
      // WRONG IMPL KILLED: C1 `flex: 0 1 100%` (the probe keeps the id, so an id-keyed rule, C4,
      // would also be seen); C9 an inline flex-grow / flex / height / flex-direction written by the
      // view (the probe is a clone, so the live strip is checked too); a max-width that is not
      // 100% (the strip must scroll inside the frame instead of overflowing it).
      expect(now.flexBasis, `${when}: no length or percentage basis`).not.toMatch(/[\d%]/);
      expect(now.maxWidth, `${when}: max-width`).toBe('100%');
      expect(qf11InlineLayout(strip), `${when}: no inline layout style on the strip`).toEqual([]);
      expect(strip.style.flexGrow, `${when}: no inline flex-grow`).toBe('');
    };
    expectRow('painted');
    view.paint(paintOf({ nav: navOn('shortcuts') }));
    expectRow('after switching tab');
    view.hide();
    view.show();
    view.paint(paintOf());
    expectRow('after hide, show and paint');

    expect(
      qf11Probe(strip, true).display,
      'SANITY: without the class it is not a flex row',
    ).not.toBe('flex');
  });

  it('with the strip class adopted, the Controls tab semantics are as shipped: tablist, three role=tab children with the nav ids (uif-13 added Display), exactly one aria-selected tab that is also the is-selected one (uif-13: was is-active), following the nav state [QF11-3-CONTROLS-SEMANTICS]', () => {
    // WRONG IMPL KILLED: a new tab component or wrapper (the strip would hold something other than
    // the two tabs, or lose the tablist role); the roles or `aria-selected` dropped while
    // reshaping; an active mark that is colour-only (`is-active` without aria-selected, or the
    // reverse); two selected tabs; the selection not following the nav state (LB / RB); tabs turned
    // into tab stops (the rows container stays the only one); and the class absent (the QF11.2 half
    // this block ties the semantics to).
    const { view } = rig();
    view.show();
    // INTENTIONAL CHANGE (uif-13, UIF13.1/UIF13.2): the walk gains the Display tab, the strip holds
    // three tabs, and the selected tab is marked `is-selected` (the kit TabBar clears `is-active` so
    // "which tab" and "which row" can both be true). Was: two tabs and `is-active` as the selected
    // mark. The intent is kept: exactly one selected tab, it follows the nav state, and the mark is
    // never colour-only (aria-selected agrees).
    const walk: ReadonlyArray<readonly [string, string, NavState]> = [
      ['buttons', TAB_BUTTONS_ID, navOn('buttons')],
      ['shortcuts', TAB_SHORTCUTS_ID, navOn('shortcuts')],
      ['display', TAB_DISPLAY_ID, navOn('display')],
      ['buttons', TAB_BUTTONS_ID, navOn('buttons')],
      ['buttons', TAB_BUTTONS_ID, navOn('buttons', 'reset')],
    ];
    for (const [expected, expectedId, nav] of walk) {
      const when = `${expected} (${nav.item ?? 'no cursor'})`;
      view.paint(paintOf({ nav }));
      const strip = el(TABS_ID);
      const tabs = Array.from(strip.querySelectorAll<HTMLElement>('.mr-nav-tab'));
      expect(strip.classList.contains(QF11_STRIP_CLASS), `${when}: strip class`).toBe(true);
      expect(strip.getAttribute('role'), `${when}: tablist`).toBe('tablist');
      expect(Array.from(strip.children), `${when}: the strip holds only the tabs`).toEqual(tabs);
      expect(
        tabs.map((tab) => [tab.getAttribute('role'), tab.id, tab.hasAttribute('tabindex')]),
        `${when}: role=tab, nav ids, never a tab stop`,
      ).toEqual([
        ['tab', TAB_BUTTONS_ID, false],
        ['tab', TAB_SHORTCUTS_ID, false],
        ['tab', TAB_DISPLAY_ID, false],
      ]);
      expect(
        tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').map((x) => x.id),
        `${when}: exactly one aria-selected tab`,
      ).toEqual([expectedId]);
      expect(
        tabs.filter((tab) => tab.classList.contains('is-selected')).map((x) => x.id),
        `${when}: the is-selected tab is the selected one`,
      ).toEqual([expectedId]);
      expect(
        tabs.filter((tab) => tab.classList.contains('is-active')).map((x) => x.id),
        `${when}: no tab carries the row cursor's is-active`,
      ).toEqual([]);
    }
  });
});

// --- uif-13: Controls on the kit, and the Display tab ---------------------------------------------
//
// UIF13.1: the strip is the kit's TabBar and the Reset all confirm is the frame's ONE confirm
// ContextSheet, over a grid that never swaps out. UIF13.2: the Display rows. UIF13.3: a request token
// for a step is applied once, through `handlers.onTextStep`. Literals only: every expected string and
// id is typed here. The sheet and the tab row use the `hidden` attribute, so these cases read
// visibility through `isHidden` (display:none OR `hidden`, on the node or an ancestor).

/** U+00A0 and U+00E8, built by code point (never a pasted invisible character). */
const NBSP = String.fromCharCode(0x00a0);
const E_GRAVE = String.fromCharCode(0x00e8);

/** The en tab labels, by the kit tab key: the scratch bar reads them, never the view. */
const EN_TAB_LABELS: Readonly<Record<string, string>> = {
  buttons: 'Buttons',
  shortcuts: 'Shortcuts',
  display: 'Display',
};

/** What the kit alone paints for `nav` over the Controls layout: a scratch bar that was never near the
 *  view, so a hand-rolled copy of the markup cannot equal it. */
function scratchBarHtml(nav: NavState): string {
  const bar = createTabBar(document, { id: TABS_ID });
  renderTabBar(bar, CONTROLS_LAYOUT, nav, {
    frame: 'controls',
    label: (tab) => EN_TAB_LABELS[tab.key] ?? '',
  });
  return bar.root.outerHTML;
}

/** A text-size request token the screen would emit (typed loosely: the new request shape is the
 *  implementation's to add). */
const textStepRequest = (step: Step): ControlsRequest =>
  ({ kind: 'textStep', step }) as unknown as ControlsRequest;

/** The keys of every row marked current, in document order. */
const currentKeys = (): string[] =>
  Array.from(el(ROWS_ID).querySelectorAll<HTMLElement>('[data-current]')).map(
    (node) => node.dataset.navKey ?? '',
  );

/** `Taille du texte : {suffix}` in the two spellings the catalog tables accept before the colon. */
const frText = (suffix: string): string[] => [
  `Taille du texte${NBSP}: ${suffix}`,
  `Taille du texte : ${suffix}`,
];

describe('ControlsView uif-13: the kit TabBar and the confirm ContextSheet (UIF13.1)', () => {
  it('UIF13.1 #controls-tabs is the kit TabBar strip: a tablist inside a .mr-tabbar row between the title and the rows, flanked by exactly two aria-hidden chips LB then RB, the selected tab is-selected and never is-active, and the row is byte-identical to a scratch createTabBar + renderTabBar in every state', () => {
    // WRONG IMPL KILLED: the shipped bare `renderTabs` strip (no chips, no `.mr-tabbar` row); a
    // hand-rolled copy of the kit's markup (the scratch compare reads every attribute and class); chips
    // that are not hidden from assistive technology or are in the wrong order; the selected tab marked
    // with the row cursor's `is-active`; the bar parked after the rows (Tab order) or before the title;
    // a bar that is painted on the first paint only (the compare runs after every state); a label
    // thunk missing for the third tab (an empty tab).
    const { view } = rig();
    view.show();
    view.paint(paintOf());
    const strip = el(TABS_ID);
    expect(strip.getAttribute('role'), 'a tablist').toBe('tablist');
    const bar = strip.parentElement as HTMLElement;
    expect(bar.classList.contains('mr-tabbar'), 'the kit row').toBe(true);
    expect(isHidden(bar), 'the row is shown').toBe(false);
    const parts = Array.from(bar.children) as HTMLElement[];
    expect(parts, 'chip, strip, chip').toHaveLength(3);
    expect(parts[1], 'the strip is the middle part').toBe(strip);
    expect(
      parts.filter((part) => part.hasAttribute('data-button')).map((part) => part.dataset.button),
      'exactly two chips, LB then RB',
    ).toEqual(['LB', 'RB']);
    expect(bar.querySelectorAll('[data-button]'), 'and no other chip').toHaveLength(2);
    for (const chip of [parts[0], parts[2]]) {
      expect(chip?.getAttribute('aria-hidden'), 'a chip is hidden from assistive tech').toBe(
        'true',
      );
    }
    const order = Array.from(el(OVERLAY_ID).querySelectorAll('*'));
    expect(order.indexOf(el(TITLE_ID)), 'the title comes first').toBeLessThan(order.indexOf(bar));
    expect(order.indexOf(bar), 'then the tab row').toBeLessThan(order.indexOf(el(ROWS_ID)));

    const states: ReadonlyArray<readonly [string, ControlsPaint]> = [
      ['browsing', paintOf()],
      ['on Shortcuts', paintOf({ nav: navOn('shortcuts') })],
      ['on Display', paintOf({ nav: navOn('display') })],
      ['capturing', paintOf({ nav: navOn('buttons', 'A_0'), capturing: slotOf(btnRow('A'), 0) })],
      ['confirming', paintOf({ nav: navOn('buttons', 'reset'), confirm: confirmOn('no') })],
      ['back on Buttons', paintOf()],
    ];
    for (const [when, p] of states) {
      view.paint(p);
      expect(el(TABS_ID), `${when}: the same strip`).toBe(strip);
      expect(
        (el(TABS_ID).parentElement as HTMLElement).outerHTML,
        `${when}: the kit's markup`,
      ).toBe(scratchBarHtml(p.nav));
      const tabs = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]'));
      expect(
        tabs.filter((tab) => tab.classList.contains('is-selected')).map((tab) => tab.id),
        `${when}: one selected tab`,
      ).toEqual(
        tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').map((x) => x.id),
      );
      expect(
        tabs.filter((tab) => tab.classList.contains('is-active')),
        `${when}: never is-active`,
      ).toHaveLength(0);
    }
    expect(
      scratchBarHtml(navOn('buttons')).includes('data-button="LB"'),
      'ANTI-VACUITY: the scratch bar really is the kit row',
    ).toBe(true);
  });

  it('UIF13.1 a second view over the same document duplicates nothing: one #controls-tabs, one tab row with two chips, and one context sheet even after a confirm is painted', () => {
    // WRONG IMPL KILLED: a constructor that creates the tab row or the sheet without locating the
    // existing one (a second view, or a re-created view after a hot path, leaves two strips with the
    // same id and two sheets, so `getElementById` and every selector read the wrong one).
    const { view } = rig();
    view.show();
    view.paint(paintOf());
    const second = new ControlsView({
      bindings: () => DEFAULT_BINDINGS,
      onClear: () => true,
      onReset: () => true,
      onCancelCapture: () => {},
      announce: () => {},
      textStep: () => 'normal',
      onTextStep: () => true,
    } as Handlers);
    second.paint(paintOf({ nav: navOn('buttons', 'reset'), confirm: confirmOn('no') }));
    expect(document.querySelectorAll(`#${TABS_ID}`), 'one strip').toHaveLength(1);
    expect(document.querySelectorAll('.mr-tabbar'), 'one tab row').toHaveLength(1);
    expect(document.querySelectorAll('.mr-tabbar [data-button]'), 'two chips').toHaveLength(2);
    expect(allSheets(), 'one context sheet').toHaveLength(1);
    expect(document.querySelectorAll(`#${SHEET_TITLE_ID}`), 'one sheet heading').toHaveLength(1);
  });

  it('UIF13.1 Reset all asks in ONE confirm sheet: exactly one [data-context-sheet] shown, variant confirm, heading #controls-sheet-title is the question, rows #controls-root-yes then #controls-root-no with only No selected, no #controls-question, and the open edge announces the question once', () => {
    // WRONG IMPL KILLED: the shipped swap of `#controls-rows` to a Yes/No list under a
    // `#controls-question` paragraph; two sheets (a list sheet and a confirm sheet at once); the list
    // variant (no heading, no question); a question that is not the heading (the sheet would be an
    // unlabelled listbox); a cursor on Yes (one stray A resets every binding) or on both; the answers
    // outside the sheet; a question announced on every repaint or never.
    const { view, announce } = rig();
    view.show();
    const session = pilot(view);
    session.press('Up');
    announce.mockClear();
    expect(shownSheets(), 'no sheet while browsing').toHaveLength(0);
    session.press('A');
    expect(session.state.confirm?.item, 'precondition: the screen opened the confirm on No').toBe(
      'no',
    );
    const sheet = theSheet();
    expect(allSheets(), 'one sheet in the document').toHaveLength(1);
    expect(sheet.dataset.sheetVariant, 'the confirm variant').toBe('confirm');
    expect(el(OVERLAY_ID).contains(sheet), 'inside the frame').toBe(true);
    const heading = el(SHEET_TITLE_ID);
    expect(sheet.contains(heading), 'the heading is the sheet`s').toBe(true);
    expect(isHidden(heading), 'and shows').toBe(false);
    expect(heading.textContent, 'the question').toBe('Reset every control to its default?');
    expect(document.getElementById(QUESTION_ID), '#controls-question is retired').toBeNull();
    expect(
      Array.from(sheet.querySelectorAll('[role="option"]')).map((o) => o.id),
      'Yes then No',
    ).toEqual([YES_ID, NO_ID]);
    expect(
      Array.from(sheet.querySelectorAll('[aria-selected="true"]')).map((o) => o.id),
      'only No is selected in the sheet',
    ).toEqual([NO_ID]);
    expect(el(YES_ID).getAttribute('aria-selected'), 'Yes is not').toBe('false');
    expect(readable(el(YES_ID), 'Yes')).toBe('Yes');
    expect(readable(el(NO_ID), 'No')).toBe('No');
    expect(document.querySelectorAll(`#${YES_ID}`), 'one Yes row in the document').toHaveLength(1);
    expect(announce, 'the open edge announces the question once').toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Reset every control to its default?');
    session.press('Up');
    expect(el(YES_ID).getAttribute('aria-selected'), 'Up reaches Yes').toBe('true');
    expect(el(NO_ID).getAttribute('aria-selected')).toBe('false');
    expect(announce, 'moving inside it announces nothing more').toHaveBeenCalledTimes(1);
  });

  it('UIF13.1 #controls-rows stays the grid while the confirm shows, on both tabs: the same grid role, every row, the Reset all cell still holding the cursor, no Yes/No option in it, and the sheet is not inside it', () => {
    // WRONG IMPL KILLED: the shipped swap that replaced the grid with a Yes/No list (the sheet would
    // float over an empty body, and the cursor row the sheet anchors away from would be gone); a
    // grid that loses its cursor while asking; the answers rendered into the grid container too; a
    // sheet nested in the grid (it would be re-rendered away by the next grid render).
    for (const tab of ['buttons', 'shortcuts'] as const) {
      const { view } = rig();
      view.show();
      const session = pilot(view);
      if (tab === 'shortcuts') session.press('RB');
      session.press('Up', 'A');
      const sheet = theSheet();
      const rows = el(ROWS_ID);
      expect(rows.getAttribute('role'), `${tab}: still a grid`).toBe('grid');
      expect(
        rows.querySelectorAll('[role="option"]'),
        `${tab}: no answers in the grid`,
      ).toHaveLength(0);
      expect(rows.contains(sheet), `${tab}: the sheet is not in the grid`).toBe(false);
      expect(sheet.contains(rows), `${tab}: nor the grid in the sheet`).toBe(false);
      const expectedRows = tab === 'buttons' ? 13 : ACCELS.length + 1;
      expect(rows.querySelectorAll('[role="row"]'), `${tab}: every grid row is there`).toHaveLength(
        expectedRows,
      );
      const reset = cell('reset');
      expect(readCell('reset'), `${tab}: Reset all`).toBe('Reset all');
      expect(reset.getAttribute('aria-selected'), `${tab}: the grid cursor is on Reset all`).toBe(
        'true',
      );
      expect(
        rows.querySelectorAll('[aria-selected="true"]'),
        `${tab}: and only there`,
      ).toHaveLength(1);
      expect(rows.getAttribute('aria-activedescendant'), `${tab}: the grid names its cursor`).toBe(
        reset.id,
      );
    }
  });

  it('UIF13.1 focus follows the sheet: with focus in the frame, opening the confirm focuses the sheet`s rows and closing it returns focus to #controls-rows', async () => {
    // WRONG IMPL KILLED: a sheet that opens with focus left on the grid (the next Enter or arrow
    // is read by the wrong container: aria-activedescendant names the grid's cell, not the answer
    // under the cursor); a close that leaves focus on the now-hidden sheet rows (it falls to <body>,
    // outside the dialog, and the focus trap goes inert); a focus move on every repaint.
    const { view } = rig();
    view.show();
    await flushMacrotask();
    const session = pilot(view);
    session.press('Up');
    const rows = el(ROWS_ID);
    rows.focus();
    expect(document.activeElement, 'precondition: the grid holds focus').toBe(rows);

    session.press('A');
    const sheet = theSheet();
    const focused = document.activeElement as HTMLElement;
    expect(focused, 'focus left the grid').not.toBe(rows);
    expect(sheet.contains(focused), 'focus is inside the sheet').toBe(true);
    expect(focused.contains(el(NO_ID)), 'on the container holding the answers').toBe(true);
    session.press('Up');
    expect(document.activeElement, 'a move inside the sheet keeps focus there').toBe(focused);

    session.press('B');
    expect(shownSheets(), 'the sheet closed').toHaveLength(0);
    expect(document.activeElement, 'focus is back on #controls-rows').toBe(el(ROWS_ID));

    session.press('A');
    expect(sheet.contains(document.activeElement), 'reopened: focus in the sheet again').toBe(true);
    session.press('A');
    expect(shownSheets(), 'A on No closed it').toHaveLength(0);
    expect(document.activeElement, 'and focus is back on #controls-rows').toBe(el(ROWS_ID));
  });

  it('UIF13.1 focus outside the frame is left alone: opening and closing the confirm never pulls focus off a control the player chose', () => {
    // WRONG IMPL KILLED: a sheet that always focuses itself (it would steal focus from a field or
    // button elsewhere on the page, e.g. the hint bar's chip the player just tabbed to).
    const { view } = rig();
    view.show();
    const session = pilot(view);
    session.press('Up');
    const outside = document.createElement('button');
    outside.id = 'controls-test-outside';
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement, 'precondition: focus is outside').toBe(outside);
    session.press('A');
    expect(shownSheets(), 'precondition: the sheet is up').toHaveLength(1);
    expect(document.activeElement, 'opening leaves it').toBe(outside);
    session.press('B');
    expect(shownSheets(), 'precondition: the sheet closed').toHaveLength(0);
    expect(document.activeElement, 'closing leaves it').toBe(outside);
  });

  it('UIF13.1 every way out of the confirm closes it for good: after A on No or B the sheet is hidden and empty, no #controls-root-yes remains in the document, the bindings and every handler are untouched, and reopening lands on No again; A on Yes resets once and closes it too', () => {
    // WRONG IMPL KILLED: a close that only hides the sheet but leaves its rows in the document (a
    // stale `#controls-yes` that `getElementById` and e2e would find); a No or B that resets anyway;
    // a sheet re-created on every open (the document grows one sheet per visit); a reopen that
    // remembers Yes (one stray A resets every binding); a Yes that resets twice (the token is
    // repainted on every later step) or leaves the sheet up; a heading left holding the old question.
    const frozenTable = withButtons({ A: ['KeyK', 'NumpadEnter'] });
    const snapshot = JSON.stringify(frozenTable);
    for (const [name, closer] of [
      ['A on No', ['A']],
      ['B', ['B']],
    ] as const) {
      const { view, onReset, onClear, onOutcome, onTextStep } = rig({
        bindings: () => frozenTable,
      });
      view.show();
      const session = pilot(view);
      session.press('Up', 'A');
      const sheet = theSheet();
      session.press(...closer);
      expect(shownSheets(), `${name}: the sheet is hidden`).toHaveLength(0);
      expect(document.querySelectorAll(`#${YES_ID}`), `${name}: no Yes left`).toHaveLength(0);
      expect(document.querySelectorAll(`#${NO_ID}`), `${name}: no No left`).toHaveLength(0);
      expect(el(SHEET_TITLE_ID).textContent, `${name}: the question is gone`).toBe('');
      expect(el(ROWS_ID).getAttribute('role'), `${name}: the grid`).toBe('grid');
      expect(cell('reset').getAttribute('aria-selected'), `${name}: cursor on Reset all`).toBe(
        'true',
      );
      expect(JSON.stringify(frozenTable), `${name}: the bindings are byte-identical`).toBe(
        snapshot,
      );
      expect(onReset, `${name}: nothing reset`).not.toHaveBeenCalled();
      expect(onClear, `${name}: nothing cleared`).not.toHaveBeenCalled();
      expect(onTextStep, `${name}: no text size changed`).not.toHaveBeenCalled();
      expect(onOutcome, `${name}: no outcome line`).not.toHaveBeenCalled();

      // The grid cursor is still on Reset all, so A alone reopens the confirm.
      session.press('A');
      expect(session.state.confirm?.item, `${name}: reopened on No`).toBe('no');
      expect(theSheet(), `${name}: the same sheet is reused`).toBe(sheet);
      expect(allSheets(), `${name}: still one sheet`).toHaveLength(1);
      expect(el(NO_ID).getAttribute('aria-selected'), `${name}: No is selected`).toBe('true');
      expect(el(YES_ID).getAttribute('aria-selected')).toBe('false');
    }

    const { view, onReset, onOutcome } = rig();
    view.show();
    const session = pilot(view);
    session.press('Up', 'A', 'Up');
    expect(el(YES_ID).getAttribute('aria-selected'), 'precondition: the cursor is on Yes').toBe(
      'true',
    );
    session.press('A');
    expect(onReset, 'A on Yes resets once').toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenLastCalledWith('All controls are back to their defaults.', true);
    expect(shownSheets(), 'and closes the sheet').toHaveLength(0);
    expect(document.querySelectorAll(`#${YES_ID}`), 'no Yes left').toHaveLength(0);
    session.press('Down');
    session.press('Up');
    expect(onReset, 'later steps do not reset again').toHaveBeenCalledTimes(1);
  });

  it('UIF13.1 hide() while the confirm is up leaves no shown sheet and no #controls-root-yes, and a re-shown frame shows none', () => {
    // WRONG IMPL KILLED: a hide() that only hides the frame root (the sheet and its rows stay in the
    // document, so a reopened frame shows the question over a grid that is no longer asking, and
    // `#controls-yes` is findable while Controls is closed); a sheet closed by hide() but re-shown by
    // the next show().
    const { view } = rig();
    view.show();
    const session = pilot(view);
    session.press('Up', 'A');
    expect(shownSheets(), 'precondition: the confirm is up').toHaveLength(1);
    view.hide();
    expect(shownSheets(), 'closed with the frame').toHaveLength(0);
    expect(document.querySelectorAll(`#${YES_ID}`), 'no #controls-root-yes remains').toHaveLength(
      0,
    );
    expect(document.querySelectorAll(`#${NO_ID}`), 'no #controls-root-no remains').toHaveLength(0);
    expect(
      allSheets().every((sheet) => sheet.hidden),
      'every sheet root is itself hidden (not just under a hidden frame)',
    ).toBe(true);
    view.show();
    expect(shownSheets(), 'a re-shown frame shows no sheet').toHaveLength(0);
    expect(document.querySelectorAll(`#${YES_ID}`)).toHaveLength(0);
  });
});

describe('ControlsView uif-13: the Display tab rows (UIF13.2)', () => {
  it('UIF13.2 painted on the Display tab the view shows the Display tab selected and three rows reading exactly "Text size: Normal (current)", "Text size: Large" and "Text size: Extra large" in English, no Reset all, no raw id and no {label}', () => {
    // WRONG IMPL KILLED: a strip with no third tab or an empty label; rows still holding binding
    // cells (the Buttons grid under a Display tab); a row text that is the bare step label, the raw
    // catalog id (`controls.text.row`) or an unreplaced `{label}`; the live row not read as current;
    // a Reset all cell on Display; text hidden from a screen reader (an aria-label override,
    // aria-hidden content) or a row left display:none.
    const { view } = rig({ step: () => 'normal' });
    view.show();
    view.paint(paintOf({ nav: navOn('display') }));
    expect(
      Array.from(el(TABS_ID).querySelectorAll('[role="tab"]')).map((x) => x.id),
      'the three tabs',
    ).toEqual([TAB_BUTTONS_ID, TAB_SHORTCUTS_ID, TAB_DISPLAY_ID]);
    expect(readable(el(TAB_DISPLAY_ID), 'the Display tab'), 'the Display label').toBe('Display');
    expect(el(TAB_DISPLAY_ID).getAttribute('aria-selected')).toBe('true');
    expect(el(TAB_BUTTONS_ID).getAttribute('aria-selected')).toBe('false');

    const rows = el(ROWS_ID);
    expect(
      Array.from(rows.querySelectorAll('[data-nav-key]')).map(
        (n) => (n as HTMLElement).dataset.navKey,
      ),
      'exactly the three steps, in order',
    ).toEqual(['normal', 'large', 'xlarge']);
    expect(rows.querySelector('[data-nav-key="reset"]'), 'no Reset all on Display').toBeNull();
    expect(rows.querySelectorAll('[data-slot]'), 'no binding cell').toHaveLength(0);
    expect(readCell('normal')).toBe('Text size: Normal (current)');
    expect(readCell('large')).toBe('Text size: Large');
    expect(readCell('xlarge')).toBe('Text size: Extra large');
    for (const key of ['normal', 'large', 'xlarge']) {
      const text = readCell(key);
      expect(text.includes('controls.'), `${key}: no raw catalog id`).toBe(false);
      expect(text.includes('{'), `${key}: no unreplaced placeholder`).toBe(false);
      expect(text.includes('undefined'), `${key}: no undefined`).toBe(false);
    }
    expect(cell('normal').getAttribute('aria-selected'), 'the cursor on Normal').toBe('true');
    expect(rows.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);
  });

  it('UIF13.2 in French the Display tab reads Affichage and the rows read "Taille du texte : Normale (actuelle)", "... Grande" and "... Très grande", resolved at paint time, with the colon before a no-break or plain space', () => {
    // WRONG IMPL KILLED: labels resolved once at construction (an English frame under a French
    // locale after a language change), a French row left in English, a row that drops the
    // `(actuelle)` mark on the live step, a decomposed or missing grave accent in "Tres grande", and
    // a frame that reads the English catalog for the step labels but French for the row template.
    const { view } = rig({ step: () => 'normal' });
    view.show();
    view.paint(paintOf({ nav: navOn('display') }));
    expect(readCell('large'), 'precondition: English before the switch').toBe('Text size: Large');
    setLocale('fr');
    view.paint(paintOf({ nav: navOn('display') }));
    expect(readable(el(TAB_DISPLAY_ID), 'the Display tab')).toBe('Affichage');
    expect(frText('Normale (actuelle)'), `normal: ${JSON.stringify(readCell('normal'))}`).toContain(
      readCell('normal'),
    );
    expect(frText('Grande'), `large: ${JSON.stringify(readCell('large'))}`).toContain(
      readCell('large'),
    );
    expect(
      frText(`Tr${E_GRAVE}s grande`),
      `xlarge: ${JSON.stringify(readCell('xlarge'))}`,
    ).toContain(readCell('xlarge'));
    for (const key of ['normal', 'large', 'xlarge']) {
      expect(readCell(key).includes('Text size'), `${key}: no English left`).toBe(false);
    }
  });

  it('UIF13.2 exactly one row is marked data-current="true" and it follows handlers.textStep() on every repaint and on a new view, independent of the cursor row', () => {
    // WRONG IMPL KILLED: a current mark read once at construction (a chosen size would never show
    // as current until reload); the mark on the CURSOR row instead of the live step (it would walk
    // with Down); two rows marked, or none; a stale mark left on the old row after a repaint; an
    // attribute written as "false" on the others (the attribute is present only on the current row).
    let live: Step = 'normal';
    const { view, textStep } = rig({ step: () => live });
    view.show();
    view.paint(paintOf({ nav: navOn('display', 'xlarge') }));
    expect(currentKeys(), 'the live step is Normal').toEqual(['normal']);
    expect(cell('normal').dataset.current, 'marked "true"').toBe('true');
    expect(cell('xlarge').getAttribute('aria-selected'), 'the cursor is elsewhere').toBe('true');
    expect(cell('xlarge').hasAttribute('data-current'), 'and carries no mark').toBe(false);
    expect(readCell('normal')).toBe('Text size: Normal (current)');
    const readsBefore = textStep.mock.calls.length;

    live = 'large';
    view.paint(paintOf({ nav: navOn('display', 'normal') }));
    expect(textStep.mock.calls.length, 'the step is read again on a paint').toBeGreaterThan(
      readsBefore,
    );
    expect(currentKeys(), 'the mark follows the live step').toEqual(['large']);
    expect(readCell('large')).toBe('Text size: Large (current)');
    expect(readCell('normal'), 'the old row reads plain again').toBe('Text size: Normal');
    expect(cell('normal').hasAttribute('data-current'), 'and lost the attribute').toBe(false);
    expect(cell('normal').getAttribute('aria-selected'), 'the cursor moved to Normal').toBe('true');

    live = 'xlarge';
    view.paint(paintOf({ nav: navOn('display', 'normal') }));
    expect(currentKeys()).toEqual(['xlarge']);
    expect(readCell('xlarge')).toBe('Text size: Extra large (current)');

    // A new view over a fresh document reads the live step too, from its first paint.
    const later = rig({ step: () => 'large' });
    later.view.show();
    later.view.paint(paintOf({ nav: navOn('display') }));
    expect(currentKeys(), 'a new view marks its own live step').toEqual(['large']);
  });
});

describe('ControlsView uif-13: choosing a text size (UIF13.3)', () => {
  it('UIF13.3 a textStep request token calls onTextStep(step) exactly once however often it is painted and onOutcome gets "Text size: <label>." with saved=true; a new token applies again; the view writes no line of its own', () => {
    // WRONG IMPL KILLED: a token applied on every paint (each repaint saves again: the host repaints
    // after every step); one compared by shape (a second, distinct Large press would apply nothing,
    // so a failed save could never be retried); the wrong step handed to the handler (the cursor
    // neighbour, or always Large); an outcome line missing, not the catalog's, or missing its label;
    // a textStep routed to onClear or onReset; and a view that paints its own strip line (a second
    // channel for the same message).
    const { view, onTextStep, onOutcome, onClear, onReset, announce } = rig();
    view.show();
    const nav = navOn('display', 'large');
    const token = textStepRequest('large');
    const p = paintOf({ nav, request: token });
    view.paint(p);
    expect(onTextStep).toHaveBeenCalledTimes(1);
    expect(onTextStep).toHaveBeenCalledWith('large');
    expect(onOutcome).toHaveBeenCalledTimes(1);
    expect(onOutcome).toHaveBeenLastCalledWith('Text size: Large.', true);
    expect(el(FEEDBACK_ID).textContent, 'no strip line of its own').toBe('');
    expect(stripHidden(), 'and the strip stays hidden').toBe(true);
    expect(announce, 'and no announcement of it (the toast speaks)').not.toHaveBeenCalledWith(
      'Text size: Large.',
    );

    view.paint(p);
    view.paint({ ...p });
    view.paint(paintOf({ nav, request: token }));
    expect(onTextStep, 'the same token, painted again, is not applied again').toHaveBeenCalledTimes(
      1,
    );
    view.paint(paintOf({ nav }));
    expect(onTextStep, 'a paint with no request applies nothing').toHaveBeenCalledTimes(1);
    view.paint(paintOf({ nav, request: textStepRequest('large') }));
    expect(onTextStep, 'a NEW token with the same shape applies again').toHaveBeenCalledTimes(2);
    view.paint(paintOf({ nav: navOn('display', 'xlarge'), request: textStepRequest('xlarge') }));
    expect(onTextStep).toHaveBeenCalledTimes(3);
    expect(onTextStep).toHaveBeenLastCalledWith('xlarge');
    expect(onOutcome).toHaveBeenLastCalledWith('Text size: Extra large.', true);
    view.paint(paintOf({ nav: navOn('display', 'normal'), request: textStepRequest('normal') }));
    expect(onTextStep).toHaveBeenLastCalledWith('normal');
    expect(onOutcome).toHaveBeenLastCalledWith('Text size: Normal.', true);
    expect(onOutcome, 'one outcome per applied token').toHaveBeenCalledTimes(4);
    expect(onClear, 'a step is not a clear').not.toHaveBeenCalled();
    expect(onReset, 'nor a reset').not.toHaveBeenCalled();
  });

  it('UIF13.3 when onTextStep answers false (the save failed) onOutcome gets saved=false with the plain line, so the seam composes the save-failed toast; in French the line is the French outcome', () => {
    // WRONG IMPL KILLED: a failed save reported as a plain success (the size lasts only until a
    // reload and the player is never told), the handler's result ignored, saved=false on every
    // outcome, the save-failed suffix pre-appended (the seam's savedLine would double it), and an
    // outcome line left in English under a French locale.
    const failing = rig({ onTextStep: () => false });
    failing.view.show();
    failing.view.paint(
      paintOf({ nav: navOn('display', 'large'), request: textStepRequest('large') }),
    );
    expect(failing.onTextStep).toHaveBeenCalledTimes(1);
    expect(failing.onOutcome).toHaveBeenCalledTimes(1);
    expect(failing.onOutcome).toHaveBeenLastCalledWith('Text size: Large.', false);
    expect(savedLine('Text size: Large.', false), 'the seam`s composed line').toBe(
      `Text size: Large. ${t('controls.saveFailed')}`,
    );

    setLocale('fr');
    const french = rig();
    french.view.show();
    french.view.paint(
      paintOf({ nav: navOn('display', 'large'), request: textStepRequest('large') }),
    );
    expect(french.onOutcome).toHaveBeenCalledTimes(1);
    const [text, saved] = french.onOutcome.mock.calls[0] as [string, boolean];
    expect(frText('Grande.'), `the French line: ${JSON.stringify(text)}`).toContain(text);
    expect(saved, 'a saved write').toBe(true);
  });

  it('UIF13.3 the token is applied BEFORE the rows render: the same paint already marks the chosen step current', () => {
    // WRONG IMPL KILLED: a paint that renders first and applies the request after (the screen shows
    // the old size as current right after the player chose the new one, until some later step
    // repaints), and a current mark read before the handler ran.
    let live: Step = 'normal';
    const { view } = rig({
      step: () => live,
      onTextStep: (step) => {
        live = step;
        return true;
      },
    });
    view.show();
    const nav = navOn('display', 'large');
    view.paint(paintOf({ nav }));
    expect(currentKeys(), 'before: Normal is current').toEqual(['normal']);
    view.paint(paintOf({ nav, request: textStepRequest('large') }));
    expect(currentKeys(), 'the same paint marks Large').toEqual(['large']);
    expect(readCell('large')).toBe('Text size: Large (current)');
    expect(readCell('normal')).toBe('Text size: Normal');
  });
});

describe('ControlsView uif-13: sheet placement and the optional text-size handlers', () => {
  it('UIF13.1 the confirm sheet is placed away from the cursor row when it opens and re-placed when the frame resizes, and nothing is placed while the frame has no area', () => {
    // WRONG IMPL KILLED: a view that renders the confirm sheet but never calls `placeContextSheet`
    // (the sheet would sit at the CSS origin, on top of the cursor row it must clear); one that
    // places once and never again (a resize leaves it where the old frame size put it, possibly
    // outside the new one); a placement written while the frame is hidden or collapsed to zero
    // width (the writes are NaN or stale and survive into the next open). happy-dom rects are all
    // zero, so the frame, the sheet and the slot are given real boxes here, and a fake
    // ResizeObserver is installed BEFORE the view is constructed so its callback can be fired.
    const callbacks: ResizeObserverCallback[] = [];
    class FakeResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        callbacks.push(cb);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    const host = globalThis as unknown as { ResizeObserver?: unknown };
    const hadObserver = Object.hasOwn(host, 'ResizeObserver');
    const previousObserver = host.ResizeObserver;
    host.ResizeObserver = FakeResizeObserver;

    let overlayWidth = 0;
    const box = (x: number, y: number, w: number, h: number): DOMRect =>
      ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h }) as DOMRect;
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement): DOMRect {
        if (this.id === OVERLAY_ID) return box(0, 0, overlayWidth, overlayWidth === 0 ? 0 : 600);
        if (this.hasAttribute('data-context-sheet')) return box(0, 0, 200, 100);
        return box(0, 0, 50, 20);
      });
    // The rem the placement reads: happy-dom cannot compute the root font size.
    const realComputed = globalThis.getComputedStyle;
    const computedSpy = vi
      .spyOn(globalThis, 'getComputedStyle')
      .mockImplementation(
        (el: Element, pseudo?: string | null): CSSStyleDeclaration =>
          el === document.documentElement
            ? ({ fontSize: '16px' } as CSSStyleDeclaration)
            : realComputed(el, pseudo),
      );
    try {
      const written = (sheet: HTMLElement): string[] => [sheet.style.left, sheet.style.top];

      // The hidden-frame guard: a frame with no width places nothing.
      overlayWidth = 0;
      const guarded = rig();
      guarded.view.show();
      const guardedSession = pilot(guarded.view);
      guardedSession.press('Up', 'A');
      const guardedSheet = theSheet();
      expect(written(guardedSheet), 'no placement while the frame has no width').toEqual(['', '']);
      for (const cb of callbacks) cb([], {} as ResizeObserver);
      expect(written(guardedSheet), 'nor on a resize while it has none').toEqual(['', '']);

      // A real frame: the sheet is placed when it opens.
      callbacks.length = 0;
      overlayWidth = 800;
      const { view } = rig();
      expect(
        callbacks.length,
        'the view observes resizes (a ResizeObserver was made)',
      ).toBeGreaterThan(0);
      view.show();
      const session = pilot(view);
      session.press('Up');
      session.press('A');
      const sheet = theSheet();
      const [left, top] = written(sheet);
      expect(left, 'left is written in px').toMatch(/^-?\d+(\.\d+)?px$/);
      expect(top, 'top is written in px').toMatch(/^-?\d+(\.\d+)?px$/);
      expect(`${left}${top}`.includes('NaN'), 'no NaN placement').toBe(false);

      // A resize re-places it.
      sheet.style.left = '';
      sheet.style.top = '';
      sheet.style.height = '';
      expect(written(sheet), 'precondition: the placement was cleared').toEqual(['', '']);
      for (const cb of callbacks) cb([], {} as ResizeObserver);
      const [left2, top2] = written(sheet);
      expect(left2, 'a resize writes left again').toMatch(/^-?\d+(\.\d+)?px$/);
      expect(top2, 'a resize writes top again').toMatch(/^-?\d+(\.\d+)?px$/);
    } finally {
      rectSpy.mockRestore();
      computedSpy.mockRestore();
      if (hadObserver) host.ResizeObserver = previousObserver;
      else delete host.ResizeObserver;
    }
  });

  it('UIF13.3 a textStep request painted into a view built WITHOUT onTextStep and textStep does nothing: no onOutcome, no throw, and the Display rows still render with Normal current', () => {
    // WRONG IMPL KILLED: a view that calls `handlers.onTextStep(...)` unguarded (a TypeError out of
    // paint in every shell rig that never wires the setting), one that reports an outcome line for a
    // step nothing applied (a toast "Text size: Large." with the size unchanged), and one that reads
    // `handlers.textStep()` unguarded (the rows would not render without it: an absent reader reads
    // as Normal).
    closeOverlayA11y('controlsView', null);
    document.body.replaceChildren();
    const onOutcome = vi.fn();
    const view = new ControlsView({
      bindings: () => DEFAULT_BINDINGS,
      onClear: () => true,
      onReset: () => true,
      onCancelCapture: () => {},
      announce: () => {},
      onOutcome,
    } as Handlers);
    view.show();
    const token = textStepRequest('large');
    const p = paintOf({ nav: navOn('display', 'large'), request: token });
    expect(() => view.paint(p), 'the paint does not throw').not.toThrow();
    expect(() => view.paint(p), 'nor does a repaint of the same token').not.toThrow();
    expect(() =>
      view.paint(paintOf({ nav: navOn('display', 'large'), request: textStepRequest('xlarge') })),
    ).not.toThrow();
    expect(onOutcome, 'no outcome line for a step nothing applied').not.toHaveBeenCalled();
    expect(
      Array.from(el(ROWS_ID).querySelectorAll('[data-nav-key]')).map(
        (n) => (n as HTMLElement).dataset.navKey,
      ),
      'the three Display rows render',
    ).toEqual(['normal', 'large', 'xlarge']);
    expect(currentKeys(), 'an absent reader reads as Normal').toEqual(['normal']);
    expect(readCell('normal')).toBe('Text size: Normal (current)');
    expect(readCell('large')).toBe('Text size: Large');
  });
});
