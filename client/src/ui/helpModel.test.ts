// ui/helpModel.test.ts — ctl-14 (CTL14.1): the GENERATED Help view model.
//
// Node env, no DOM. `buildHelpViewModel(screen, bindings)` is pure over a hint-bar chip list (the
// context table's answer for the screen BENEATH Help: `hintBar(...)`) and the live binding table.
//
// THE CONTRACT (plan monster-realm-ctl-14-plan.md; the specialist builds exactly this):
//   export const HELP_TABS = ['screen', 'controls', 'goals'] as const;
//   export type HelpTab = (typeof HELP_TABS)[number];
//   export interface HelpRow { readonly keys: readonly string[]; readonly action: string }
//   export interface HelpViewModel {
//     readonly tabs: readonly { readonly tab: HelpTab; readonly title: string;
//                               readonly rows: readonly HelpRow[] }[];
//     readonly note: string;
//   }
//   export function buildHelpViewModel(screen: readonly HintChip[], bindings: Bindings): HelpViewModel
//   - tabs: exactly three, in HELP_TABS order; title = catalog `help.tab.screen|controls|goals`.
//   - screen rows: one per chip, in chip order; keys = [chip.keycap] ([] when keycap is ''),
//     action = chip.verb.
//   - controls rows: controlsRows('buttons') then controlsRows('shortcuts'); keys = the row's
//     bound codes (primary then alt, an unbound slot omitted) through glyph(); action = rowLabel(row).
//   - goals rows: the catalog goals `help.goal.recruit|battle|trade`, keys [].
//   - note = catalog `help.note.keysVsButtons` (the "key names vs button names" note).
//   - `CONTROLS`, `GOALS` and every English literal are DELETED from the module.
// Catalog ids are compared through `t(...)` under the active locale: no wording is asserted here.
//
// LEGACY BEHAVIOUR REPLACED (anti-vacuity): `buildHelpViewModel()` took no arguments and returned a
// hard-coded English `{ controls: [{key, action}], goals: string[] }`; under `fr` Help still showed
// English CONTROLS rows. Every case below is red on the missing `HELP_TABS` / the two-argument form.
//
// NAMED SURVIVORS (the spec's mapping of the retired pins). The old CONTROLS pins are RETIRED
// because the const they pinned is deleted; each is replaced by a generated-help assertion:
//   - 'BITES: controls is a non-empty array' / 'BITES: goals is a non-empty array' / 'every control
//     entry has a non-empty key AND action' / 'every goal is a non-empty string'
//       -> CTL14-1-MODEL-TABS (non-empty titles, three goals) and the controls-row assertions of
//          CTL14-1-MODEL-LIVE-BINDINGS (every row has an action; keys come from the live table).
//   - 'the SSOT covers the load-bearing keys' (? Escape WASD Space F9, B I E Q U P L N) and
//     '★ M21b-2 ... the C key with its EXACT action string'
//       -> CTL14-1-MODEL-LIVE-BINDINGS (every VButton and every Accel is a row, keyed by its live
//          glyph) and CTL14-1-MODEL-F8-F9-NOTE (F9 and F8, which the old SSOT lacked F8 for).
//   - '★ uxd2 NO controls row has key G or H', 'CTL10A-3-HELP-NO-T', 'CTL10B-2-HELP-NO-O'
//       -> structural now: rows are the closed VBUTTONS / ACCELS lists, which hold no G, H, T or O
//          accelerator, so a retired key cannot be documented (CTL14-1-MODEL-LIVE-BINDINGS pins the
//          exact row count and order).
//   - 'two calls return deeply-equal content' / 'cannot be reordered by a prior mutation'
//       -> 'PURE: a fresh object per call' below.
//   - 'the VM exposes ONLY { controls, goals }' (display-only structural guard)
//       -> 'DISPLAY-ONLY: no function-valued field' below, over the new shape.
// The documents that quoted the old const (docs/PLAYTEST.md's controls table and the menu's
// shortcut glyph source) are other files' gates, outside this test.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Bindings, DEFAULT_BINDINGS } from '../input/bindings';
import { ACCELS, VBUTTONS, type VButton } from '../input/buttons';
import { glyph, resetLearnedKeys } from '../input/glyphs';
import { type ControlsRow, controlsRows, rowLabel } from './controlsModel';
import * as helpModule from './helpModel';
import {
  buildHelpViewModel,
  HELP_TABS,
  type HelpRow,
  type HelpTab,
  type HelpViewModel,
} from './helpModel';
import type { HintChip } from './hintBarModel';
import { t } from './i18n/resolver';

// --- fixtures --------------------------------------------------------------------------------

const chip = (button: VButton, keycap: string, verb: string, badge = false): HintChip => ({
  button,
  keycap,
  verb,
  badge,
});

/** A context's chips: three keyed chips and one whose button is unbound (keycap ''). */
const WORLD_CHIPS: readonly HintChip[] = [
  chip('A', 'Enter', 'Talk'),
  chip('Start', 'Esc', 'Menu', true),
  chip('Select', 'R', 'Help'),
  chip('Y', '', 'View'),
];
/** A different context: a screen frame's four chips, none of them in WORLD_CHIPS' order. */
const SCREEN_CHIPS: readonly HintChip[] = [
  chip('A', 'Enter', 'OK'),
  chip('B', 'Backspace', 'Back'),
  chip('Start', 'Esc', 'Close'),
  chip('Select', 'R', 'Help'),
];

const ROWS: readonly ControlsRow[] = [...controlsRows('buttons'), ...controlsRows('shortcuts')];

const tabOf = (vm: HelpViewModel, tab: HelpTab): HelpViewModel['tabs'][number] => {
  const found = vm.tabs.find((x) => x.tab === tab);
  if (found === undefined) throw new Error(`the view model has no ${tab} tab`);
  return found;
};

/** The default table with `change` applied (never mutates DEFAULT_BINDINGS). */
const remapped = (change: {
  readonly buttons?: Partial<Record<VButton, readonly string[]>>;
  readonly accels?: Partial<Record<(typeof ACCELS)[number], readonly string[]>>;
}): Bindings => ({
  buttons: { ...DEFAULT_BINDINGS.buttons, ...change.buttons },
  accels: { ...DEFAULT_BINDINGS.accels, ...change.accels },
});

/** What a row of the All controls tab must read for `bindings`, built from the bindings table and
 *  the existing glyph / label helpers (never from the module under test). */
const expectedRow = (row: ControlsRow, bindings: Bindings): HelpRow => {
  const codes = row.kind === 'button' ? bindings.buttons[row.id] : bindings.accels[row.id];
  return { keys: codes.map((c) => glyph(c)), action: rowLabel(row) };
};

beforeEach(() => {
  resetLearnedKeys();
});
afterEach(() => {
  resetLearnedKeys();
});

describe('buildHelpViewModel (ctl-14, CTL14.1)', () => {
  it('CTL14-1-MODEL-TABS: the view model has exactly the tabs This screen | All controls | Goals in that order with their catalog titles; This screen mirrors the given chips one row each in chip order (an unbound chip has no key); Goals carries the three catalog goals', () => {
    // WRONG IMPL KILLED: a model with the tabs in another order or a fourth tab; a title that is a
    // hard-coded English literal (it would not follow the catalog: compared through t()); two tabs
    // sharing one title; a This-screen tab that is a fixed list instead of the chips handed in (the
    // second chip list below would read like the first); rows re-sorted or filtered (the unbound Y
    // chip dropped); an unbound chip keyed [''] (an empty keycap box on screen) instead of []; the
    // chip's button name used for the action instead of its verb; a Goals tab with other than the
    // three catalog goals, or with keys.
    expect([...HELP_TABS], 'the tab roster').toEqual(['screen', 'controls', 'goals']);
    const vm = buildHelpViewModel(WORLD_CHIPS, DEFAULT_BINDINGS);

    expect(
      vm.tabs.map((x) => x.tab),
      'the tabs, in order',
    ).toEqual(['screen', 'controls', 'goals']);
    expect(
      vm.tabs.map((x) => x.title),
      'titles come from the catalog',
    ).toEqual([t('help.tab.screen'), t('help.tab.controls'), t('help.tab.goals')]);
    for (const tab of vm.tabs) {
      expect(tab.title.trim().length, `${tab.tab}: a real title`).toBeGreaterThan(0);
    }
    expect(new Set(vm.tabs.map((x) => x.title)).size, 'three different titles').toBe(3);

    expect(tabOf(vm, 'screen').rows, 'This screen = the chips, in order').toEqual([
      { keys: ['Enter'], action: 'Talk' },
      { keys: ['Esc'], action: 'Menu' },
      { keys: ['R'], action: 'Help' },
      { keys: [], action: 'View' },
    ]);
    // A different context gives different rows, so the tab is generated, not fixed.
    expect(tabOf(buildHelpViewModel(SCREEN_CHIPS, DEFAULT_BINDINGS), 'screen').rows).toEqual([
      { keys: ['Enter'], action: 'OK' },
      { keys: ['Backspace'], action: 'Back' },
      { keys: ['Esc'], action: 'Close' },
      { keys: ['R'], action: 'Help' },
    ]);
    // No chips (nothing to list) is an empty tab, not a throw or a leftover.
    expect(tabOf(buildHelpViewModel([], DEFAULT_BINDINGS), 'screen').rows).toEqual([]);

    // The screen rows come from the chips, never from the binding table.
    const other = remapped({ buttons: { Select: ['KeyH'], A: ['KeyZ'] } });
    expect(
      tabOf(buildHelpViewModel(WORLD_CHIPS, other), 'screen').rows,
      'a remap changes the controls tab only; the chips already carry their keycaps',
    ).toEqual(tabOf(vm, 'screen').rows);

    expect(tabOf(vm, 'goals').rows, 'the three catalog goals, no keys').toEqual([
      { keys: [], action: t('help.goal.recruit') },
      { keys: [], action: t('help.goal.battle') },
      { keys: [], action: t('help.goal.trade') },
    ]);
    expect(new Set(tabOf(vm, 'goals').rows.map((r) => r.action)).size, 'three distinct goals').toBe(
      3,
    );
  });

  it('CTL14-1-MODEL-LIVE-BINDINGS: All controls lists every button then every shortcut exactly once, each keyed by the LIVE binding table (primary then alt, an unbound slot omitted), so a remap shows and a cleared shortcut keeps its row with no key', () => {
    // WRONG IMPL KILLED: a hard-coded key list (a remap would not show: Select would still read
    // R and Slash); keys read from DEFAULT_BINDINGS instead of the table handed in; the Alt slot
    // dropped (a two-key row reads one key) or an unbound Alt rendered as '' / 'undefined' (the
    // Select row below has one key); a cleared shortcut whose row vanishes (F9 would be
    // undiscoverable) or keeps its old key; rows in another order, buttons after shortcuts, a
    // button or an accelerator missing or listed twice (23 rows exactly); an action that is a
    // literal instead of rowLabel() (it would not follow the locale); and keys that are raw
    // codes ('KeyR') instead of glyphs ('R').
    const vm = buildHelpViewModel(WORLD_CHIPS, DEFAULT_BINDINGS);
    const controls = tabOf(vm, 'controls').rows;

    expect(ROWS.length, 'fixture: 12 buttons then 11 shortcuts').toBe(
      VBUTTONS.length + ACCELS.length,
    );
    expect(controls, 'the default table, every row once, buttons then shortcuts').toEqual(
      ROWS.map((row) => expectedRow(row, DEFAULT_BINDINGS)),
    );
    // Concrete anchors, so the oracle above cannot agree with a wrong impl by sharing its bug:
    // Select is two keys (R, then the named Slash key), Start Esc then M, a lone-key button one key.
    const label = (row: ControlsRow): string => rowLabel(row);
    const select = controls.find((r) => r.action === label({ kind: 'button', id: 'Select' }));
    expect(select?.keys, 'Select: primary R, alt the slash key by its catalog name').toEqual([
      'R',
      t('key.slash'),
    ]);
    const start = controls.find((r) => r.action === label({ kind: 'button', id: 'Start' }));
    expect(start?.keys, 'Start: Esc then M').toEqual([t('key.escape'), 'M']);
    const back = controls.find((r) => r.action === label({ kind: 'button', id: 'B' }));
    expect(back?.keys, 'B: one key, no empty alt slot').toEqual([t('key.backspace')]);
    expect(controls.length, 'exactly 23 rows').toBe(23);

    // A remap shows: Select to H alone, Start to G + M, F9 cleared, accelerator B moved to Z.
    const live = remapped({
      buttons: { Select: ['KeyH'], Start: ['KeyG', 'KeyM'] },
      accels: { F9: [], B: ['KeyZ', 'KeyX'] },
    });
    const after = tabOf(buildHelpViewModel(WORLD_CHIPS, live), 'controls').rows;
    expect(after, 'every row follows the table handed in').toEqual(
      ROWS.map((row) => expectedRow(row, live)),
    );
    const selectAfter = after.find((r) => r.action === label({ kind: 'button', id: 'Select' }));
    expect(selectAfter?.keys, 'Select now reads H alone: no stale R, no empty alt').toEqual(['H']);
    const startAfter = after.find((r) => r.action === label({ kind: 'button', id: 'Start' }));
    expect(startAfter?.keys, 'Start reads its remapped primary then its alt').toEqual(['G', 'M']);
    const f9After = after.find((r) => r.action === label({ kind: 'accel', id: 'F9' }));
    expect(f9After, 'a cleared shortcut keeps its row').toBeDefined();
    expect(f9After?.keys, 'with no key').toEqual([]);
    const storageAfter = after.find((r) => r.action === label({ kind: 'accel', id: 'B' }));
    expect(storageAfter?.keys, 'a two-key shortcut reads both').toEqual(['Z', 'X']);
    expect(after.length, 'a remap adds and removes no row').toBe(23);
    expect(after, 'and the remap really changed the tab').not.toEqual(controls);
  });

  it('CTL14-1-MODEL-F8-F9-NOTE: the shortcut rows include F9 (the bug-report bundle) and F8 (dismiss the error toast) with their keys, the model carries the catalog "key names vs button names" note, and the module no longer exports CONTROLS or GOALS', () => {
    // WRONG IMPL KILLED: a generated tab built from the buttons only, or from the old hand list
    // (no F8 row: it was never in the old CONTROLS); an F9 / F8 row whose key is blank or whose
    // action is another row's label; a note that is a literal (not the catalog's), empty or
    // missing; and a model that kept the old CONTROLS / GOALS exports beside the generated ones
    // (a second controls list: two sources of truth that drift).
    const vm = buildHelpViewModel(WORLD_CHIPS, DEFAULT_BINDINGS);
    const controls = tabOf(vm, 'controls').rows;
    const f9 = controls.find((r) => r.action === rowLabel({ kind: 'accel', id: 'F9' }));
    const f8 = controls.find((r) => r.action === rowLabel({ kind: 'accel', id: 'F8' }));
    expect(f9, 'the F9 row').toEqual({ keys: ['F9'], action: t('controls.accel.bugReport') });
    expect(f8, 'the F8 row').toEqual({ keys: ['F8'], action: t('controls.accel.dismissError') });
    expect(controls.indexOf(f9 as HelpRow), 'F9 sits in the shortcuts').toBeGreaterThanOrEqual(
      VBUTTONS.length,
    );
    expect(controls.indexOf(f8 as HelpRow), 'F8 sits in the shortcuts').toBeGreaterThanOrEqual(
      VBUTTONS.length,
    );

    expect(vm.note, 'the keys-vs-buttons note is the catalog message').toBe(
      t('help.note.keysVsButtons'),
    );
    expect(vm.note.trim().length, 'and is not blank').toBeGreaterThan(0);
    expect(Object.keys(vm).sort(), 'the model is the tabs and the note, no second list').toEqual([
      'note',
      'tabs',
    ]);

    expect(Object.keys(helpModule), 'the hard-coded lists are gone').not.toContain('CONTROLS');
    expect(Object.keys(helpModule)).not.toContain('GOALS');
    expect(Object.keys(helpModule), 'the generated API is exported').toEqual(
      expect.arrayContaining(['buildHelpViewModel', 'HELP_TABS']),
    );
  });

  it('PURE: a fresh object per call — two calls are deeply equal but share nothing, a caller mutating one result cannot change the next, and the binding table is never mutated', () => {
    // WRONG IMPL KILLED: a model that returns a shared module-level object (a caller's push would
    // poison the next open); content that depends on call order or a clock; and a builder that
    // mutates the table it was handed.
    const before = JSON.stringify(DEFAULT_BINDINGS);
    const a = buildHelpViewModel(WORLD_CHIPS, DEFAULT_BINDINGS);
    const b = buildHelpViewModel(WORLD_CHIPS, DEFAULT_BINDINGS);
    expect(a, 'same inputs, same content').toEqual(b);
    expect(a, 'never the same object').not.toBe(b);
    expect(a.tabs, 'nor the same tab list').not.toBe(b.tabs);
    for (const [i, tab] of a.tabs.entries()) {
      expect(tab.rows, `${tab.tab}: its own row list`).not.toBe(b.tabs[i]?.rows);
    }
    try {
      // A frozen result throws here (fine: nothing to poison); a plain one is mutated.
      (tabOf(a, 'controls').rows as HelpRow[]).push({ keys: ['HACK'], action: 'HACK' });
      (a.tabs as unknown[]).length = 0;
    } catch {
      /* frozen result: the tampering is impossible */
    }
    const c = buildHelpViewModel(WORLD_CHIPS, DEFAULT_BINDINGS);
    expect(c, 'a later call does not see the tampering').toEqual(b);
    expect(c.tabs.length).toBe(3);
    expect(JSON.stringify(DEFAULT_BINDINGS), 'the table is untouched').toBe(before);
  });

  it('DISPLAY-ONLY: no function-valued field anywhere in the model, and a row is exactly { keys, action }', () => {
    // WRONG IMPL KILLED: a model that smuggles a callback or a submit field into a display-only
    // overlay (the retired ADR-0135 guard, over the new shape), and a row carrying extra fields
    // (a pointer target, a button id) the view would have to trust.
    const vm = buildHelpViewModel(WORLD_CHIPS, DEFAULT_BINDINGS);
    const seen: unknown[] = [vm, vm.tabs, vm.note];
    for (const tab of vm.tabs) {
      expect(Object.keys(tab).sort(), `${tab.tab}: tab keys`).toEqual(['rows', 'tab', 'title']);
      seen.push(tab, tab.rows);
      for (const row of tab.rows) {
        expect(Object.keys(row).sort(), `${tab.tab}: row keys`).toEqual(['action', 'keys']);
        seen.push(row, row.keys, row.action, ...row.keys);
      }
    }
    for (const value of seen) expect(typeof value).not.toBe('function');
    expect(seen.length, 'ANTI-VACUITY: the walk reached the rows').toBeGreaterThan(60);
  });
});
