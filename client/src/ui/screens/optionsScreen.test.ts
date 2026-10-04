// ui/screens/optionsScreen.test.ts — ctl-12b (CTL12B.1): Options › Controls, the PURE screen.
//
// Node env, no DOM. `controlsScreen` is driven only through `viewModel`, `init`, `onButton` and
// `paint` (into a recording fake view); `CONTROLS_LAYOUT` and `controlsItem` are read as data; and
// `captureStep` is the glue the shell runs on a key pressed while a slot waits for one.
//
// LEGACY BEHAVIOUR REPLACED (anti-vacuity): there is no Controls screen. ctl-12 shipped the binding
// model and the saved table, but nothing in the game can change it: a remap needed a hand-edited
// `localStorage['mr.controls']` and a reload. Every case below is red on the missing module.
//
// The contract (plan §1, the interface the specialist builds):
//   layout   tabs Buttons | Shortcuts. Buttons: a 2-column grid, per VBUTTONS row `${id}_0`
//            (Primary) and `${id}_1` (Alt), then a lone `reset`. Shortcuts: a 3-column grid, per
//            ACCELS row `${id}_0`, `${id}_1`, `${id}_clear`, then a lone `reset`.
//   browse   Start pops to the base, Select toggles help, B pops; the D-pad, LB and RB move (wrap
//            fresh, clamp on a repeat); A activates: a slot starts its capture, a clear cell emits
//            `{kind:'clear', accel}`, reset opens the Yes / No confirm on No. A repeat never
//            activates. X / Y are the page's.
//   capture  only a non-repeat B ends it (cursor unmoved, no command); Start pops to the base;
//            every other button is consumed and changes nothing.
//   confirm  Up / Down move; A on Yes emits `{kind:'reset'}` and closes; A on No or B closes;
//            Start pops to the base; the rest is consumed.
//   request  a one-shot token: a NEW object per press, `null` after any other step.
import { describe, expect, it } from 'vitest';
import { type Bindings, DEFAULT_BINDINGS } from '../../input/bindings';
import { ACCELS, type Accel, VBUTTONS, type VButton } from '../../input/buttons';
import {
  type CapturedKey,
  type ControlsRow,
  captureKey,
  outcomeText,
  type Slot,
  type SlotTarget,
} from '../controlsModel';
import type { ItemLayout, NavInput, NavLayout } from '../nav';
import {
  CONTROLS_LAYOUT,
  type ControlsItem,
  type ControlsPaint,
  type ControlsScreenView,
  type ControlsState,
  captureStep,
  controlsItem,
  controlsScreen,
} from './optionsScreen';
import type { ButtonStep, ScreenContext, ScreenResult } from './types';

// --- fixtures --------------------------------------------------------------------------------

type Tab = 'buttons' | 'shortcuts';

const btnRow = (id: VButton): ControlsRow => ({ kind: 'button', id });
const accRow = (id: Accel): ControlsRow => ({ kind: 'accel', id });
const slotOf = (row: ControlsRow, slot: Slot): SlotTarget => ({ row, slot });

type Input = VButton | NavInput;
const rep = (button: VButton): NavInput => ({ button, repeat: true });
const asInput = (input: Input): NavInput =>
  typeof input === 'string' ? { button: input, repeat: false } : input;
const label = (input: Input): string =>
  typeof input === 'string' ? input : `${input.button}${input.repeat ? ' (repeat)' : ''}`;

const POP: ScreenResult = { kind: 'pop' };
const POP_TO_BASE: ScreenResult = { kind: 'popToBase' };
const TOGGLE_HELP: ScreenResult = { kind: 'toggleHelp' };

const CTX = {
  store: {},
  identity: 'ab'.repeat(32),
  bindings: DEFAULT_BINDINGS,
  now: () => 0,
  shopId: null,
  healLocationId: null,
  socialTab: null,
  reduceMotion: false,
} as unknown as ScreenContext;

const fresh = (): ControlsState => controlsScreen.init(controlsScreen.viewModel(CTX));

const press = (s: ControlsState, input: Input): ButtonStep<ControlsState> =>
  controlsScreen.onButton(null, s, asInput(input));

/** Press each input in turn, asserting every one is swallowed with no command. */
function walk(from: ControlsState, inputs: readonly Input[]): ControlsState {
  let s = from;
  for (const input of inputs) {
    const step = press(s, input);
    expect(step.result, `${label(input)} is consumed`).toBe('consumed');
    s = step.state;
  }
  return s;
}

const repeatOf = (input: Input, n: number): Input[] => Array.from({ length: n }, () => input);

/** The tabbed layout's one tab, read off the exported layout. */
function tabLayout(tab: Tab): ItemLayout {
  const layout = CONTROLS_LAYOUT as NavLayout;
  if (layout.kind !== 'tabs') throw new Error('CONTROLS_LAYOUT must be a tabs layout');
  const found = layout.tabs.find((x) => x.key === tab);
  if (found === undefined) throw new Error(`CONTROLS_LAYOUT has no tab ${tab}`);
  return found.layout;
}

const colsOf = (layout: ItemLayout): number => (layout.kind === 'grid' ? layout.cols : 1);

/** Walk from a fresh screen onto `key` of `tab` with real presses: RB for the Shortcuts tab, then
 *  Down once per grid row and Right once per column. */
function walkTo(tab: Tab, key: string): ControlsState {
  let s = fresh();
  if (tab === 'shortcuts') s = walk(s, ['RB']);
  const layout = tabLayout(tab);
  const index = layout.items.findIndex((i) => i.key === key);
  expect(index, `fixture: ${tab} holds ${key}`).toBeGreaterThanOrEqual(0);
  const cols = colsOf(layout);
  s = walk(s, [...repeatOf('Down', Math.floor(index / cols)), ...repeatOf('Right', index % cols)]);
  expect(s.nav.tab, `walked onto the ${tab} tab`).toBe(tab);
  expect(s.nav.item, `walked onto ${key}`).toBe(key);
  return s;
}

/** The one paint `controlsScreen.paint` hands a recording view. */
function paintOf(state: ControlsState): ControlsPaint {
  const out: ControlsPaint[] = [];
  const view: ControlsScreenView = {
    paint: (p) => {
      out.push(p);
    },
  };
  if (controlsScreen.paint === undefined) throw new Error('controlsScreen must define paint');
  controlsScreen.paint(view, null, state);
  expect(out, 'exactly one paint').toHaveLength(1);
  return out[0] as ControlsPaint;
}

/** The expected decode of every item, built from the button / accelerator lists (never by parsing
 *  the key), in the layout's order. */
const BUTTON_ITEMS: ReadonlyArray<readonly [string, ControlsItem]> = [
  ...VBUTTONS.flatMap(
    (id): Array<readonly [string, ControlsItem]> => [
      [`${id}_0`, { kind: 'slot', target: slotOf(btnRow(id), 0) }],
      [`${id}_1`, { kind: 'slot', target: slotOf(btnRow(id), 1) }],
    ],
  ),
  ['reset', { kind: 'reset' }],
];
const SHORTCUT_ITEMS: ReadonlyArray<readonly [string, ControlsItem]> = [
  ...ACCELS.flatMap(
    (id): Array<readonly [string, ControlsItem]> => [
      [`${id}_0`, { kind: 'slot', target: slotOf(accRow(id), 0) }],
      [`${id}_1`, { kind: 'slot', target: slotOf(accRow(id), 1) }],
      [`${id}_clear`, { kind: 'clear', accel: id }],
    ],
  ),
  ['reset', { kind: 'reset' }],
];

const ALL_BUTTONS: readonly VButton[] = VBUTTONS;

// --- tests -----------------------------------------------------------------------------------

describe('controlsScreen — the layout (ctl-12b, CTL12B.1)', () => {
  it('CTL12B-1-SCREEN-LAYOUT: two tabs, Buttons then Shortcuts; Buttons holds exactly the twelve button rows, each a Primary and an Alt slot and no Clear, then Reset all; every shortcut row holds Primary, Alt and Clear, then Reset all; controlsItem decodes every item and answers undefined for anything else; LB and RB switch the tabs', () => {
    // LEGACY BEHAVIOUR REPLACED: no Controls screen exists (a remap needed a hand-edited saved
    // table and a reload).
    // WRONG IMPL KILLED: a Shortcuts tab first (the screen would open on the shortcuts); a button
    // row missing or out of VBUTTONS order; a Clear cell on a button row (a protected button
    // could be emptied: CTL12.7 forbids it); a shortcut row without its Clear; a grid whose column
    // count does not match its rows (Down would cross from a Primary into the next row's Alt); a
    // Reset all that is missing from one tab; an item disabled for no reason; a decode that
    // swaps Primary and Alt, reads the button namespace for an accelerator that shares its name
    // (`B_0` is the B button on Buttons and the Storage shortcut on Shortcuts), decodes a Clear on
    // the Buttons tab, parses a prototype name, or accepts a key that is not in the layout; and an
    // LB / RB that does not switch tabs.
    const layout = CONTROLS_LAYOUT as NavLayout;
    expect(layout.kind, 'a tabbed layout').toBe('tabs');
    if (layout.kind !== 'tabs') return;
    expect(
      layout.tabs.map((x) => x.key),
      'Buttons, then Shortcuts',
    ).toEqual(['buttons', 'shortcuts']);

    const buttons = tabLayout('buttons');
    expect(buttons, 'Buttons: a two-column grid, Primary then Alt per button').toEqual({
      kind: 'grid',
      cols: 2,
      items: BUTTON_ITEMS.map(([key]) => ({ key, enabled: true })),
    });
    expect(
      buttons.items.filter((i) => i.key.endsWith('_0')),
      'ANTI-VACUITY: twelve button rows',
    ).toHaveLength(12);
    expect(
      buttons.items.filter((i) => i.key.endsWith('_clear')),
      'no Clear on a button row',
    ).toEqual([]);

    const shortcuts = tabLayout('shortcuts');
    expect(shortcuts, 'Shortcuts: a three-column grid, Primary, Alt and Clear').toEqual({
      kind: 'grid',
      cols: 3,
      items: SHORTCUT_ITEMS.map(([key]) => ({ key, enabled: true })),
    });
    expect(
      shortcuts.items.filter((i) => i.key.endsWith('_clear')),
      'ANTI-VACUITY: one Clear per shortcut',
    ).toHaveLength(ACCELS.length);

    // Every item of the layout decodes, tab by tab.
    let decoded = 0;
    for (const [tab, items] of [
      ['buttons', BUTTON_ITEMS],
      ['shortcuts', SHORTCUT_ITEMS],
    ] as const) {
      for (const [key, expected] of items) {
        expect(controlsItem(tab, key), `${tab} / ${key}`).toEqual(expected);
        decoded += 1;
      }
    }
    expect(decoded, 'ANTI-VACUITY: 25 + 34 items').toBe(59);

    // Anything else is undefined.
    const unknown: ReadonlyArray<readonly [string | null, string]> = [
      ['buttons', 'B_clear'],
      ['buttons', 'A_clear'],
      ['buttons', 'A_2'],
      ['buttons', 'A_00'],
      ['buttons', 'A'],
      ['buttons', 'a_0'],
      ['buttons', 'Nope_0'],
      ['buttons', 'F9_0'],
      ['buttons', 'toString_0'],
      ['buttons', '__proto___0'],
      ['buttons', ''],
      ['buttons', 'resetx'],
      ['shortcuts', 'A_0'],
      ['shortcuts', 'Up_1'],
      ['shortcuts', 'B_2'],
      ['shortcuts', 'constructor_clear'],
      ['shortcuts', 'clear'],
      ['nope', 'A_0'],
      ['nope', 'reset'],
      [null, 'A_0'],
    ];
    for (const [tab, key] of unknown) {
      expect(controlsItem(tab, key), `${String(tab)} / ${JSON.stringify(key)}`).toBeUndefined();
    }

    // LB and RB switch the tabs (fresh wraps, a repeat clamps), each remembering its own cursor.
    const start = fresh();
    expect(start.nav.tab).toBe('buttons');
    const right = press(start, 'RB');
    expect(right.result, 'RB is consumed').toBe('consumed');
    expect(right.state.nav.tab, 'RB: the Shortcuts tab').toBe('shortcuts');
    expect(right.state.nav.item, 'on its first cell').toBe('B_0');
    expect(press(start, 'LB').state.nav.tab, 'a fresh LB from the first tab wraps').toBe(
      'shortcuts',
    );
    expect(press(right.state, 'RB').state.nav.tab, 'a fresh RB from the last tab wraps').toBe(
      'buttons',
    );
    expect(press(right.state, rep('RB')).state.nav.tab, 'a repeat RB clamps').toBe('shortcuts');
    expect(press(right.state, 'LB').state.nav.tab, 'LB: back on Buttons').toBe('buttons');
    const onAAlt = walkTo('buttons', 'A_1');
    const back = walk(onAAlt, ['RB', 'LB']);
    expect(back.nav.item, 'the Buttons cursor is remembered across a tab switch').toBe('A_1');
  });

  it('init opens on the Buttons tab, first cell, nothing capturing, no confirm, no request; the view model is null and the screen is nav-capable', () => {
    // WRONG IMPL KILLED: a screen that opens on Shortcuts or on Reset all, one that opens already
    // capturing (the first key pressed would be bound) or with the confirm up, a stale request
    // (a Clear or a Reset applied by the opening paint), and a screen without its nav mark (the
    // router would keep the D-pad for walking under the open frame).
    expect(controlsScreen.nav, 'nav-capable').toBe(true);
    expect(controlsScreen.viewModel(CTX), 'no view model: the view reads the live table').toBe(
      null,
    );
    const s = fresh();
    expect(s.nav.tab).toBe('buttons');
    expect(s.nav.item, 'Up, Primary').toBe('Up_0');
    expect(s.capturing).toBeNull();
    expect(s.confirm).toBeNull();
    expect(s.request).toBeNull();
  });

  it('Reset all is reachable by real presses from every cell of both tabs: Left to the first column, then Down', () => {
    // WRONG IMPL KILLED: Reset all placed in a column other than the first, or sharing a row with
    // a slot (the D-pad could reach it only from some cells), one tab missing it, and a grid whose
    // last row is not reachable by Down from the first column.
    let walked = 0;
    for (const tab of ['buttons', 'shortcuts'] as const) {
      const layout = tabLayout(tab);
      const cols = colsOf(layout);
      const rows = Math.ceil(layout.items.length / cols);
      for (const [index, item] of layout.items.entries()) {
        let s = walkTo(tab, item.key);
        s = walk(s, repeatOf('Left', index % cols));
        for (let i = 0; i <= rows && s.nav.item !== 'reset'; i += 1) s = walk(s, ['Down']);
        expect(s.nav.item, `${tab} / ${item.key}: Reset all reached`).toBe('reset');
        expect(s.nav.tab, `${tab} / ${item.key}: on the same tab`).toBe(tab);
        walked += 1;
      }
    }
    expect(walked, 'ANTI-VACUITY: every cell of both tabs').toBe(59);
    // From the first cell, a fresh Up wraps straight onto it.
    expect(walk(fresh(), ['Up']).nav.item, 'Up from the first cell wraps to Reset all').toBe(
      'reset',
    );
  });

  it('browse: Start pops to the base, Select toggles help and B pops, from both tabs; X and Y are the page`s', () => {
    // WRONG IMPL KILLED: a B that does nothing (the frame could not be left with Back), a Start
    // that only pops one frame, a Select that is lost, and an X or Y swallowed (they are not this
    // screen's).
    for (const s of [fresh(), walkTo('shortcuts', 'J_clear')]) {
      const where = s.nav.tab ?? 'none';
      expect(press(s, 'Start').result, `${where}: Start`).toEqual(POP_TO_BASE);
      expect(press(s, 'Select').result, `${where}: Select`).toEqual(TOGGLE_HELP);
      expect(press(s, 'B').result, `${where}: B`).toEqual(POP);
      for (const button of ['X', 'Y'] as const) {
        const step = press(s, button);
        expect(step.result, `${where}: ${button}`).toBe('unhandled');
        expect(step.state.nav, `${where}: ${button} moves nothing`).toEqual(s.nav);
        expect(step.state.capturing).toBeNull();
        expect(step.state.confirm).toBeNull();
      }
    }
  });

  it('paint hands the view exactly { layout, nav, capturing, confirm, request } of the state, the request token by identity', () => {
    // WRONG IMPL KILLED: a paint that never reaches the view, paints twice, drops the capture or
    // the confirm, or hands a COPY of the request token (the view applies a token once by
    // identity: a copy would clear or reset again on every repaint).
    const s = fresh();
    expect(paintOf(s)).toEqual({
      layout: CONTROLS_LAYOUT,
      nav: s.nav,
      capturing: null,
      confirm: null,
      request: null,
    });

    const capturing = press(walkTo('buttons', 'A_0'), 'A').state;
    const p1 = paintOf(capturing);
    expect(p1.capturing, 'the capture target').toEqual(slotOf(btnRow('A'), 0));
    expect(p1.nav).toBe(capturing.nav);

    const confirming = press(walkTo('buttons', 'reset'), 'A').state;
    const p2 = paintOf(confirming);
    expect(p2.confirm, 'the confirm cursor').toBe(confirming.confirm);
    expect(p2.confirm?.item).toBe('no');

    const cleared = press(walkTo('shortcuts', 'I_clear'), 'A').state;
    const p3 = paintOf(cleared);
    expect(p3.request, 'the very token object').toBe(cleared.request);
    expect(p3).toEqual({
      layout: CONTROLS_LAYOUT,
      nav: cleared.nav,
      capturing: null,
      confirm: null,
      request: { kind: 'clear', accel: 'I' },
    });
  });
});

describe('controlsScreen — capture (ctl-12b, CTL12B.1)', () => {
  it('CTL12B-1-SCREEN-CAPTURE: A on a slot starts the capture of exactly that row and slot, on both tabs; while capturing every button but B and Start is consumed and changes nothing; a non-repeat B ends it with the cursor unmoved and no command; Start pops to the base; a repeat A never starts a capture', () => {
    // LEGACY BEHAVIOUR REPLACED: no Controls screen exists, so no key could be captured in-game.
    // WRONG IMPL KILLED: a capture of the wrong slot (Primary for Alt) or of the row under a
    // neighbouring cursor; a button row read as the accelerator of the same name (`B_0` on
    // Buttons is the B button, on Shortcuts the Storage shortcut); a capture that also emits a
    // request or opens the confirm; a capture the D-pad, A, LB, RB, Select, X or Y can move,
    // re-target or end (a stray arrow would rebind another slot); a B that pops the frame (the
    // player loses the screen instead of the capture), a repeat B that ends it (a held Backspace
    // captured as a key would end the capture it just made), a B that moves the cursor; a Start
    // that is swallowed (no way out); and a held Enter that starts a capture.
    const cases: ReadonlyArray<readonly [Tab, string, SlotTarget]> = [
      ['buttons', 'Up_0', slotOf(btnRow('Up'), 0)],
      ['buttons', 'A_0', slotOf(btnRow('A'), 0)],
      ['buttons', 'A_1', slotOf(btnRow('A'), 1)],
      ['buttons', 'B_0', slotOf(btnRow('B'), 0)],
      ['buttons', 'Start_1', slotOf(btnRow('Start'), 1)],
      ['buttons', 'Select_1', slotOf(btnRow('Select'), 1)],
      ['shortcuts', 'B_0', slotOf(accRow('B'), 0)],
      ['shortcuts', 'J_1', slotOf(accRow('J'), 1)],
      ['shortcuts', 'F8_0', slotOf(accRow('F8'), 0)],
      ['shortcuts', 'F8_1', slotOf(accRow('F8'), 1)],
    ];
    for (const [tab, key, target] of cases) {
      const at = walkTo(tab, key);
      const started = press(at, 'A');
      expect(started.result, `${tab} / ${key}: A is consumed`).toBe('consumed');
      expect(started.state.capturing, `${tab} / ${key}: captures that slot`).toEqual(target);
      expect(started.state.nav, `${tab} / ${key}: the cursor stays`).toEqual(at.nav);
      expect(started.state.confirm).toBeNull();
      expect(started.state.request).toBeNull();

      // While capturing: nothing but B and Start acts, fresh or held.
      for (const button of ALL_BUTTONS) {
        if (button === 'B' || button === 'Start') continue;
        for (const input of [button, rep(button)] as const) {
          const step = press(started.state, input);
          const what = `${tab} / ${key} capturing: ${label(input)}`;
          expect(step.result, `${what} is consumed`).toBe('consumed');
          expect(step.state.capturing, `${what} keeps the capture`).toEqual(target);
          expect(step.state.nav, `${what} moves nothing`).toEqual(at.nav);
          expect(step.state.confirm, `${what} opens nothing`).toBeNull();
          expect(step.state.request, `${what} requests nothing`).toBeNull();
        }
      }
      const heldB = press(started.state, rep('B'));
      expect(heldB.result, `${tab} / ${key}: a repeat B is consumed`).toBe('consumed');
      expect(heldB.state.capturing, 'and does not end the capture').toEqual(target);

      const ended = press(started.state, 'B');
      expect(ended.result, `${tab} / ${key}: B ends the capture, no command`).toBe('consumed');
      expect(ended.state.capturing, 'nothing captures').toBeNull();
      expect(ended.state.nav, 'the cursor is unmoved').toEqual(at.nav);
      expect(ended.state.confirm).toBeNull();
      expect(ended.state.request).toBeNull();
      // Browsing again: B now pops the frame.
      expect(press(ended.state, 'B').result, 'after the capture, B pops').toEqual(POP);

      expect(press(started.state, 'Start').result, `${tab} / ${key}: Start`).toEqual(POP_TO_BASE);

      const held = press(at, rep('A'));
      expect(held.state.capturing, `${tab} / ${key}: a repeat A captures nothing`).toBeNull();
      expect(held.state.confirm).toBeNull();
      expect(held.state.request).toBeNull();
    }
  });

  it('captureStep is captureKey + outcomeText: bound and swapped carry the new table and are done; a cancel is done with no table; a reserved refusal keeps waiting and is NOT prevented; a protected refusal keeps waiting and is prevented', () => {
    // WRONG IMPL KILLED: a capture that ends on a refusal (a Tab press would end the capture with
    // nothing bound, so the player can never reach the Cancel chip by keyboard), one that
    // preventDefaults a reserved key (Tab, F5 and browser chords must stay the browser's), one that
    // lets a protected refusal through to the page (Backspace would navigate back), a cancel that
    // hands back a table (a needless save), a bound or swapped step that hands back no table (the
    // remap would be lost) or the OLD one, and a feedback line that is not the model's.
    const keyOf = (code: string, extra: Partial<CapturedKey> = {}): CapturedKey => ({
      code,
      key: 'x',
      ...extra,
    });
    interface Case {
      readonly name: string;
      readonly b: Bindings;
      readonly target: SlotTarget;
      readonly key: CapturedKey;
      readonly kind: 'bound' | 'swapped' | 'cancelled' | 'reserved' | 'protected';
    }
    const cases: readonly Case[] = [
      {
        name: 'a free key',
        b: DEFAULT_BINDINGS,
        target: slotOf(btnRow('X'), 1),
        key: keyOf('KeyK'),
        kind: 'bound',
      },
      {
        name: 'Y takes X`s key',
        b: DEFAULT_BINDINGS,
        target: slotOf(btnRow('X'), 0),
        key: keyOf('KeyF'),
        kind: 'swapped',
      },
      {
        name: 'Escape on a shortcut',
        b: DEFAULT_BINDINGS,
        target: slotOf(accRow('I'), 0),
        key: keyOf('Escape'),
        kind: 'swapped',
      },
      {
        name: 'the key the slot holds',
        b: DEFAULT_BINDINGS,
        target: slotOf(btnRow('A'), 0),
        key: keyOf('Enter'),
        kind: 'cancelled',
      },
      {
        name: 'Tab',
        b: DEFAULT_BINDINGS,
        target: slotOf(btnRow('A'), 0),
        key: keyOf('Tab'),
        kind: 'reserved',
      },
      {
        name: 'F5',
        b: DEFAULT_BINDINGS,
        target: slotOf(accRow('J'), 1),
        key: keyOf('F5'),
        kind: 'reserved',
      },
      {
        name: 'a Ctrl chord',
        b: DEFAULT_BINDINGS,
        target: slotOf(btnRow('Y'), 0),
        key: keyOf('KeyK', { ctrlKey: true }),
        kind: 'reserved',
      },
      {
        name: 'a composing key',
        b: DEFAULT_BINDINGS,
        target: slotOf(btnRow('Y'), 0),
        key: keyOf('KeyK', { isComposing: true }),
        kind: 'reserved',
      },
      {
        name: 'B`s only key from an empty slot',
        b: DEFAULT_BINDINGS,
        target: slotOf(accRow('B'), 1),
        key: keyOf('Backspace'),
        kind: 'protected',
      },
    ];
    const seen = new Set<string>();
    for (const c of cases) {
      const outcome = captureKey(c.b, c.target, c.key);
      // Fixture: the model really answers the outcome this case is about.
      const modelKind =
        outcome.kind === 'refused' ? outcome.reason : (outcome.kind as Case['kind']);
      expect(modelKind, `fixture: ${c.name}`).toBe(c.kind);
      seen.add(c.kind);

      const step = captureStep(c.b, c.target, c.key);
      expect(step.text, `${c.name}: the model's own feedback line`).toBe(outcomeText(outcome));
      expect(step.text.length, `${c.name}: a non-empty line`).toBeGreaterThan(0);
      if (outcome.kind === 'bound' || outcome.kind === 'swapped') {
        expect(step.done, `${c.name}: done`).toBe(true);
        expect(step.bindings, `${c.name}: the new table`).toEqual(outcome.bindings);
        expect(step.bindings, `${c.name}: not the old table`).not.toEqual(c.b);
        expect(step.prevent, `${c.name}: prevented`).toBe(true);
      } else if (outcome.kind === 'cancelled') {
        expect(step.done, `${c.name}: a cancel ends the capture`).toBe(true);
        expect(step.bindings, `${c.name}: and changes no table`).toBeUndefined();
        expect(step.prevent, `${c.name}: prevented`).toBe(true);
      } else if (outcome.reason === 'reserved') {
        expect(step.done, `${c.name}: keeps waiting`).toBe(false);
        expect(step.bindings).toBeUndefined();
        expect(step.prevent, `${c.name}: left to the browser`).toBe(false);
      } else {
        expect(step.done, `${c.name}: keeps waiting`).toBe(false);
        expect(step.bindings).toBeUndefined();
        expect(step.prevent, `${c.name}: prevented (Backspace must not navigate back)`).toBe(true);
      }
    }
    expect([...seen].sort(), 'ANTI-VACUITY: every outcome was met').toEqual([
      'bound',
      'cancelled',
      'protected',
      'reserved',
      'swapped',
    ]);
  });
});

describe('controlsScreen — Reset all (ctl-12b, CTL12B.1)', () => {
  it('CTL12B-1-SCREEN-RESET: A on Reset all opens the Yes / No confirm with the cursor on No; A on No or B closes it with no request; Up or Down then A on Yes emits {kind:"reset"} once and closes it; the next step`s request is null; the rest is consumed and Start pops to the base', () => {
    // LEGACY BEHAVIOUR REPLACED: no Controls screen exists, so the table could not be reset in-game.
    // WRONG IMPL KILLED: a Reset all that resets at once (one stray A wipes every binding); a
    // confirm that opens on Yes (navInit alone lands there: A twice resets); a No or B that
    // resets anyway, or a B that pops the frame instead of the confirm; a Yes that never asks for
    // the reset, asks twice, or leaves the confirm up; a request token that outlives its step (the
    // shell would reset again on the next paint); a held Enter that confirms; a confirm the
    // Left / Right / LB / RB / X / Y / Select keys can move or leave; a Start swallowed by it; and
    // a confirm that moves the grid cursor under it.
    for (const tab of ['buttons', 'shortcuts'] as const) {
      const onReset = walkTo(tab, 'reset');
      const opened = press(onReset, 'A');
      expect(opened.result, `${tab}: A is consumed`).toBe('consumed');
      expect(opened.state.confirm, `${tab}: the confirm is up`).not.toBeNull();
      expect(opened.state.confirm?.item, `${tab}: on No (the default)`).toBe('no');
      expect(opened.state.request, `${tab}: nothing is reset yet`).toBeNull();
      expect(opened.state.capturing).toBeNull();
      expect(opened.state.nav, `${tab}: the grid cursor stays on Reset all`).toEqual(onReset.nav);

      // A on No closes, nothing requested.
      const no = press(opened.state, 'A');
      expect(no.result).toBe('consumed');
      expect(no.state.confirm, `${tab}: A on No closes`).toBeNull();
      expect(no.state.request, `${tab}: and resets nothing`).toBeNull();
      expect(no.state.nav).toEqual(onReset.nav);

      // B closes, nothing requested, the frame stays.
      const back = press(opened.state, 'B');
      expect(back.result, `${tab}: B closes the confirm, it does not pop`).toBe('consumed');
      expect(back.state.confirm).toBeNull();
      expect(back.state.request).toBeNull();

      // The other buttons are consumed and change nothing.
      for (const button of ['Left', 'Right', 'LB', 'RB', 'X', 'Y', 'Select'] as const) {
        for (const input of [button, rep(button)] as const) {
          const step = press(opened.state, input);
          expect(step.result, `${tab} confirm: ${label(input)}`).toBe('consumed');
          expect(step.state.confirm, `${tab} confirm: ${label(input)} keeps it`).toEqual(
            opened.state.confirm,
          );
          expect(step.state.nav).toEqual(onReset.nav);
          expect(step.state.request).toBeNull();
        }
      }
      expect(press(opened.state, 'Start').result, `${tab}: Start`).toEqual(POP_TO_BASE);
      const heldA = press(opened.state, rep('A'));
      expect(heldA.state.confirm?.item, `${tab}: a repeat A confirms nothing`).toBe('no');
      expect(heldA.state.request).toBeNull();

      // Up (or Down: two rows wrap) reaches Yes; A there asks for the reset, once, and closes.
      for (const move of ['Up', 'Down'] as const) {
        const onYes = press(opened.state, move);
        expect(onYes.result).toBe('consumed');
        expect(onYes.state.confirm?.item, `${tab}: ${move} reaches Yes`).toBe('yes');
        expect(onYes.state.request).toBeNull();
        const yes = press(onYes.state, 'A');
        expect(yes.result, `${tab}: A on Yes is consumed (the request is the effect)`).toBe(
          'consumed',
        );
        expect(yes.state.request, `${tab}: the reset request`).toEqual({ kind: 'reset' });
        expect(yes.state.confirm, `${tab}: the confirm closes`).toBeNull();
        expect(yes.state.nav).toEqual(onReset.nav);
        const after = press(yes.state, 'Down');
        expect(after.state.request, `${tab}: the next step drops the token`).toBeNull();
        // A second Reset all is a NEW token.
        const again = press(press(press(yes.state, 'A').state, 'Up').state, 'A');
        expect(again.state.request).toEqual({ kind: 'reset' });
        expect(again.state.request, `${tab}: a new object per press`).not.toBe(yes.state.request);
      }

      // A repeat A on Reset all never opens the confirm.
      const held = press(onReset, rep('A'));
      expect(held.state.confirm, `${tab}: a held Enter opens nothing`).toBeNull();
      expect(held.state.request).toBeNull();
    }
  });
});

describe('controlsScreen — Clear (ctl-12b, CTL12B.1, CTL12.7)', () => {
  it('CTL12B-1-SCREEN-CLEAR: A on a shortcut row`s Clear cell emits {kind:"clear", accel} for that shortcut; two presses give two distinct token objects; any other step drops the token; a repeat A clears nothing', () => {
    // LEGACY BEHAVIOUR REPLACED: no Controls screen exists, so a shortcut could not be cleared.
    // WRONG IMPL KILLED: a Clear that names the wrong accelerator (the row under a neighbouring
    // cursor, or the button of the same name); one that starts a capture or opens a confirm; a
    // token reused across presses (the view applies a token once by identity, so the second
    // press would clear nothing); a token that outlives its step (the next paint clears again);
    // and a held Enter that clears.
    for (const accel of ['B', 'J', 'F9', 'F8'] as const) {
      const at = walkTo('shortcuts', `${accel}_clear`);
      const first = press(at, 'A');
      expect(first.result, `${accel}: A is consumed`).toBe('consumed');
      expect(first.state.request, `${accel}: clear that shortcut`).toEqual({
        kind: 'clear',
        accel,
      });
      expect(first.state.capturing, `${accel}: no capture`).toBeNull();
      expect(first.state.confirm, `${accel}: no confirm`).toBeNull();
      expect(first.state.nav, `${accel}: the cursor stays`).toEqual(at.nav);

      const second = press(first.state, 'A');
      expect(second.state.request).toEqual({ kind: 'clear', accel });
      expect(second.state.request, `${accel}: a NEW token per press`).not.toBe(first.state.request);

      // Every other step drops the token.
      for (const button of ALL_BUTTONS) {
        if (button === 'A') continue;
        const step = press(first.state, button);
        expect(step.state.request, `${accel}: ${button} after a Clear`).toBeNull();
      }
      const held = press(at, rep('A'));
      expect(held.state.request, `${accel}: a repeat A clears nothing`).toBeNull();
    }
  });
});
