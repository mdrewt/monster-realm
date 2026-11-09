// ui/screens/helpScreen.test.ts — uif-14 (UIF14.1, UIF14.4, UIF14.5): Help as a pure screen over the
// nav kit, with a detail PHASE.
//
// Node env, no DOM. `helpScreen` is driven only through `viewModel`, `init`, `onButton` and `paint`
// (into a recording fake view); `HELP_LAYOUT` and `DETAIL_LAYOUT` are read as data.
//
// THE CONTRACT (plan monster-realm-uif-14-plan.md; the specialist builds exactly this):
//   state                { nav: NavState; detail: EntryKey | null }
//   HELP_LAYOUT          tabs: 'intro' -> a list of ONE enabled item; 'encyclopedia' -> a list of the
//                        sixteen ENTRY_KEYS (keys = the entry keys, in order, all enabled)
//   DETAIL_LAYOUT        a list of ONE enabled item, key 'back'
//   HelpPaint            { layout: HELP_LAYOUT, nav: state.nav, detail: state.detail }
//   LB / RB              switch tab (no detail open); the nav kit remembers each tab's cursor
//   Up / Down            move on the Encyclopedia (wrap when fresh); inert on Introduction
//   A on an entry        detail = that entry, 'consumed'
//   detail open          B (fresh) or A on the Back row -> detail = null, nav UNCHANGED, 'consumed';
//                        LB / RB / Up / Down are 'consumed' and change nothing
//   repeat A / B         never open, never close, never pop ('consumed', state kept)
//   B, no detail         { kind: 'pop' };  Start { kind: 'popToBase' };  Select { kind: 'toggleHelp' }
//                        (Start and Select also while a detail is open)
//   X / Y                'unhandled'
//
// INTENTIONAL CHANGE (uif-14): the ctl-14 pins (tabs screen/controls/goals, "A and the D-pad act on
// nothing, one row per tab") are RETIRED with the tabs; the state is no longer `{ nav }` alone.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import type { VButton } from '../../input/buttons';
import type { FrameId, Stack, UpperFrame } from '../contextStack';
import { ENTRY_KEYS, HELP_TABS } from '../helpModel';
import { type NavInput, type NavLayout, navInit } from '../nav';
import { DETAIL_LAYOUT, HELP_LAYOUT, helpScreen } from './helpScreen';
import { SCREEN_ADAPTERS, ScreenHost } from './index';
import type { ButtonStep, ScreenContext, ScreenResult } from './types';

// --- fixtures --------------------------------------------------------------------------------

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

const VM = helpScreen.viewModel(CTX);
type State = ReturnType<typeof helpScreen.init>;

const fresh = (): State => helpScreen.init(VM);
const press = (s: State, button: VButton, repeat = false): ButtonStep<State> =>
  helpScreen.onButton(VM, s, { button, repeat } satisfies NavInput);

/** Press each button in turn (fresh presses), asserting each is swallowed. */
function walk(from: State, buttons: readonly VButton[]): State {
  let s = from;
  for (const button of buttons) {
    const step = press(s, button);
    expect(step.result, `${button} is consumed`).toBe('consumed');
    s = step.state;
  }
  return s;
}

const tabOf = (s: State): string | null => s.nav.tab;
const itemOf = (s: State): string | null => s.nav.item;

/** Encyclopedia, the cursor on the entry at `index` of ENTRY_KEYS (RB, then Down `index` times). */
const onEntry = (index: number): State =>
  walk(fresh(), ['RB', ...Array<VButton>(index).fill('Down')]);

const POP: ScreenResult = { kind: 'pop' };
const POP_TO_BASE: ScreenResult = { kind: 'popToBase' };
const TOGGLE_HELP: ScreenResult = { kind: 'toggleHelp' };

describe('helpScreen (uif-14)', () => {
  it('UIF14.1 Help opens on Introduction with no detail; RB reaches the Encyclopedia and wraps back, LB wraps the other way; the shipped table holds this nav-capable screen for the help frame', () => {
    // WRONG IMPL KILLED: the legacy adapter left in the table (RB would be `unhandled`); a screen
    // without its nav mark (the router keeps the D-pad); an opening on the Encyclopedia or with a
    // detail already open; a tab roster that kept All controls or Goals (RB RB would not wrap); RB
    // and LB swapped; a state that grew fields beyond `{ nav, detail }`.
    expect(SCREEN_ADAPTERS.helpView, 'the help frame holds this screen').toBe(helpScreen);
    expect(helpScreen.nav, 'and it is nav-capable').toBe(true);

    const start = fresh();
    expect(start.nav, 'it opens on the first tab').toEqual(navInit(HELP_LAYOUT));
    expect(tabOf(start), 'Introduction').toBe('intro');
    expect(start.detail, 'no detail open').toBeNull();
    expect(Object.keys(start).sort(), 'the state is { nav, detail }').toEqual(['detail', 'nav']);

    const seenRb: Array<string | null> = [];
    let s = start;
    for (let i = 0; i < 3; i += 1) {
      const step = press(s, 'RB');
      expect(step.result, `RB ${i + 1} is swallowed`).toBe('consumed');
      s = step.state;
      seenRb.push(tabOf(s));
    }
    expect(seenRb, 'RB walks right and wraps over two tabs').toEqual([
      'encyclopedia',
      'intro',
      'encyclopedia',
    ]);
    const seenLb: Array<string | null> = [];
    s = start;
    for (let i = 0; i < 3; i += 1) {
      s = press(s, 'LB').state;
      seenLb.push(tabOf(s));
    }
    expect(seenLb, 'LB walks left and wraps').toEqual(['encyclopedia', 'intro', 'encyclopedia']);

    // A repeat bumper clamps: held RB on the last tab does not wrap, held LB on the first neither.
    const atEnc = walk(start, ['RB']);
    expect(tabOf(press(atEnc, 'RB', true).state), 'a repeat RB does not wrap').toBe('encyclopedia');
    expect(press(atEnc, 'RB', true).result).toBe('consumed');
    expect(tabOf(press(start, 'LB', true).state), 'a repeat LB does not wrap').toBe('intro');
  });

  it('UIF14.1 HELP_LAYOUT is a tabs layout over exactly Introduction and the Encyclopedia: intro one enabled item, encyclopedia the sixteen ENTRY_KEYS in order, all enabled; DETAIL_LAYOUT is a list holding one enabled `back` item', () => {
    // WRONG IMPL KILLED: a layout with another tab order or key set (the view keys its panels on the
    // tab key); an Encyclopedia list missing or re-ordering an entry (the cursor and the detail would
    // name another mechanic); a disabled entry (A would report a reason instead of opening); a grid;
    // a detail layout with more than the Back row, or a Back key the view does not know.
    const layout: NavLayout = HELP_LAYOUT;
    expect(layout.kind, 'tabs').toBe('tabs');
    if (layout.kind !== 'tabs') throw new Error('HELP_LAYOUT must be a tabs layout');
    expect(
      layout.tabs.map((x) => x.key),
      'the tab keys are the HELP_TABS roster',
    ).toEqual([...HELP_TABS]);
    const [intro, encyclopedia] = layout.tabs;
    expect(intro?.layout.kind, 'intro: a list').toBe('list');
    expect(intro?.layout.items.length, 'intro: one item').toBe(1);
    expect(intro?.layout.items[0]?.enabled, 'intro: enabled').toBe(true);
    expect(encyclopedia?.layout.kind, 'encyclopedia: a list').toBe('list');
    expect(
      encyclopedia?.layout.items.map((i) => i.key),
      'encyclopedia: the entry keys in order',
    ).toEqual([...ENTRY_KEYS]);
    expect(
      encyclopedia?.layout.items.every((i) => i.enabled),
      'encyclopedia: every entry enabled',
    ).toBe(true);

    const detail: NavLayout = DETAIL_LAYOUT;
    expect(detail.kind, 'the detail is a list').toBe('list');
    expect(detail.kind === 'list' ? detail.items.map((i) => i.key) : null, 'one Back row').toEqual([
      'back',
    ]);
    expect(detail.kind === 'list' ? detail.items[0]?.enabled : null).toBe(true);
  });

  it('UIF14.4 on the Encyclopedia Down and Up walk the entries (wrapping when fresh, clamping when held); on Introduction the D-pad is swallowed and changes nothing', () => {
    // WRONG IMPL KILLED: a D-pad that does nothing on the Encyclopedia (the list could not be
    // walked); Down and Up swapped; no wrap (Up from the first entry sticks); a held D-pad that
    // wraps; a D-pad on Introduction that opens or moves anything.
    const enc = walk(fresh(), ['RB']);
    expect(itemOf(enc), 'the cursor opens on the first entry').toBe('party');
    const down = press(enc, 'Down');
    expect(down.result).toBe('consumed');
    expect(itemOf(down.state), 'Down moves to the second entry').toBe('storage');
    expect(itemOf(press(down.state, 'Up').state), 'Up moves back').toBe('party');
    expect(itemOf(press(enc, 'Up').state), 'Up from the first entry wraps to the last').toBe(
      'ranked',
    );
    expect(itemOf(press(onEntry(15), 'Down').state), 'Down from the last wraps').toBe('party');
    expect(itemOf(press(onEntry(15), 'Down', true).state), 'a held Down clamps').toBe('ranked');
    expect(itemOf(press(enc, 'Up', true).state), 'a held Up clamps').toBe('party');
    for (const button of ['Up', 'Down', 'Left', 'Right'] as const) {
      const step = press(fresh(), button);
      expect(step.result, `Introduction: ${button} is swallowed`).toBe('consumed');
      expect(step.state, `Introduction: ${button} changes nothing`).toEqual(fresh());
    }
  });

  it('UIF14.4 the cursor is remembered per tab: Down three times on the Encyclopedia, LB to Introduction, RB back lands on the fourth entry again', () => {
    // WRONG IMPL KILLED: a tab switch that resets the Encyclopedia cursor to the first entry (the
    // nav kit's perTab memory not used, or the state rebuilt from navInit on every bumper); a
    // memory shared across tabs.
    const at = onEntry(3);
    expect(itemOf(at), 'fixture: the fourth entry').toBe('bait');
    const away = walk(at, ['LB']);
    expect(tabOf(away), 'LB: Introduction').toBe('intro');
    const back = walk(away, ['RB']);
    expect(tabOf(back), 'RB: the Encyclopedia').toBe('encyclopedia');
    expect(itemOf(back), 'still the fourth entry').toBe('bait');
    // The memory survives a second round trip and a detail open/close.
    const again = walk(back, ['LB', 'RB']);
    expect(itemOf(again), 'and a second round trip').toBe('bait');
  });

  it('UIF14.5 A on an entry opens its detail, B closes it back to the same entry with the nav state unchanged, and A on the Back row closes it too; all consumed', () => {
    // WRONG IMPL KILLED: an A that opens another entry (detail = the first); a close that resets
    // the cursor to the first entry (the spec's "B closes it back to the same entry", feedback 114);
    // a close that drops the tab memory; a B that pops Help instead of closing the detail; an A on
    // the Back row that does nothing (the row would be decorative); a detail that is not null after
    // close; a nav object rebuilt on open (the paint would flicker the cursor).
    for (const index of [0, 3, 15]) {
      const at = onEntry(index);
      const key = ENTRY_KEYS[index] as (typeof ENTRY_KEYS)[number];
      const open = press(at, 'A');
      expect(open.result, `A on ${key}`).toBe('consumed');
      expect(open.state.detail, `A on ${key} opens ${key}`).toBe(key);
      expect(open.state.nav, `opening ${key} leaves the nav alone`).toEqual(at.nav);

      const closed = press(open.state, 'B');
      expect(closed.result, `B closes ${key}, it does not pop`).toBe('consumed');
      expect(closed.state.detail, `${key}: detail is null again`).toBeNull();
      expect(closed.state.nav, `${key}: the nav is unchanged by the close`).toEqual(at.nav);
      expect(itemOf(closed.state), `${key}: the same entry is active`).toBe(key);

      const viaBack = press(open.state, 'A');
      expect(viaBack.result, `A on the Back row of ${key}`).toBe('consumed');
      expect(viaBack.state.detail, `A on Back closes ${key}`).toBeNull();
      expect(viaBack.state.nav, `${key}: Back leaves the nav alone`).toEqual(at.nav);
    }
    // A reopen after a close opens the same entry again (the cursor is where it was).
    const at = onEntry(5);
    const reopened = walk(at, ['A', 'B', 'A']);
    expect(reopened.detail, 'reopened').toBe('essence');
  });

  it('UIF14.5 while a detail is open LB, RB, Up and Down are swallowed and change nothing, Start pops to the base and Select toggles Help, and the detail stays open under all of them', () => {
    // WRONG IMPL KILLED: a tab switch while the detail is open (the panel behind the sheet would
    // change under the modal); a cursor move behind the modal (the closed state would then show
    // another entry); LB/RB `unhandled` (the page scrolls); Start / Select swallowed (the player
    // could not leave Help or toggle it from a detail).
    const at = onEntry(2);
    const open = press(at, 'A').state;
    expect(open.detail, 'fixture: recruit is open').toBe('recruit');
    for (const button of ['LB', 'RB', 'Up', 'Down', 'Left', 'Right'] as const) {
      const step = press(open, button);
      expect(step.result, `${button} is swallowed`).toBe('consumed');
      expect(step.state, `${button} changes nothing`).toEqual(open);
    }
    expect(press(open, 'Start').result, 'Start leaves').toEqual(POP_TO_BASE);
    expect(press(open, 'Select').result, 'Select toggles Help').toEqual(TOGGLE_HELP);
  });

  it('UIF14.5 a held button never acts: repeat A does not open an entry, repeat B neither closes a detail nor pops Help, repeat Start and Select are swallowed, all state kept', () => {
    // WRONG IMPL KILLED: a held A that re-opens (a held Enter would re-open the detail the moment B
    // closed it); a held B that closes the detail and then pops Help in the same hold; a held
    // Start / Select that acts again (a held key would close Help and the screen under it).
    const at = onEntry(1);
    const heldA = press(at, 'A', true);
    expect(heldA.result, 'repeat A is swallowed').toBe('consumed');
    expect(heldA.state.detail, 'repeat A opens nothing').toBeNull();
    expect(heldA.state, 'repeat A changes nothing').toEqual(at);

    const open = press(at, 'A').state;
    const heldB = press(open, 'B', true);
    expect(heldB.result, 'repeat B on a detail is swallowed, not a pop').toBe('consumed');
    expect(heldB.state.detail, 'repeat B does not close the detail').toBe('storage');
    const heldA2 = press(open, 'A', true);
    expect(heldA2.result, 'repeat A on the Back row is swallowed').toBe('consumed');
    expect(heldA2.state.detail, 'repeat A does not close the detail').toBe('storage');
    expect(press(at, 'B', true).result, 'repeat B with no detail does not pop').toBe('consumed');
    for (const state of [at, open, fresh()]) {
      for (const button of ['Start', 'Select'] as const) {
        const step = press(state, button, true);
        expect(step.result, `a repeat ${button} is swallowed`).toBe('consumed');
        expect(step.state, `a repeat ${button} changes nothing`).toEqual(state);
      }
    }
  });

  it('UIF14.1 with no detail B pops, Start pops to the base and Select toggles Help from every tab, X and Y are the page`s, and A on Introduction`s one item is swallowed with no state change', () => {
    // WRONG IMPL KILLED: a B that is not a pop (Help would stick open); a Start that pops one frame
    // instead of all; a Select that does nothing (it is the Help key: the second press must
    // close Help); an X / Y that is swallowed (Space and F belong to the page); an A on Introduction
    // that opens a detail or changes the tab.
    for (const tab of HELP_TABS) {
      const at = walk(fresh(), Array<VButton>(HELP_TABS.indexOf(tab)).fill('RB'));
      expect(tabOf(at), `fixture: on ${tab}`).toBe(tab);
      expect(press(at, 'B').result, `${tab}: B`).toEqual(POP);
      expect(press(at, 'Start').result, `${tab}: Start`).toEqual(POP_TO_BASE);
      expect(press(at, 'Select').result, `${tab}: Select`).toEqual(TOGGLE_HELP);
      for (const button of ['X', 'Y'] as const) {
        const step = press(at, button);
        expect(step.result, `${tab}: ${button} is the page's`).toBe('unhandled');
        expect(step.state, `${tab}: ${button} changes nothing`).toEqual(at);
      }
    }
    const a = press(fresh(), 'A');
    expect(a.result, 'A on Introduction is swallowed').toBe('consumed');
    expect(a.state, 'and changes nothing').toEqual(fresh());
  });

  it('paint: hands the lent view exactly one { layout: HELP_LAYOUT, nav, detail } with the state it was given, whichever tab or phase', () => {
    // WRONG IMPL KILLED: an adapter with no paint (the strip never moves); a paint that omits the
    // detail (the sheet never opens) or hands the wrong one; a paint of another shape; one that builds
    // a fresh layout per paint; one that fires twice; one that paints the initial state instead of
    // the one it was given.
    const painted: unknown[] = [];
    const view = {
      paint: (p: unknown) => {
        painted.push(p);
      },
    };
    if (helpScreen.paint === undefined) throw new Error('helpScreen must define paint');
    const closed = onEntry(2);
    helpScreen.paint(view, VM, closed);
    expect(painted, 'exactly one paint').toHaveLength(1);
    const p = painted[0] as { layout: unknown; nav: unknown; detail: unknown };
    expect(Object.keys(p).sort(), 'the paint is { detail, layout, nav }').toEqual([
      'detail',
      'layout',
      'nav',
    ]);
    expect(p.layout, 'the one layout').toBe(HELP_LAYOUT);
    expect(p.nav, 'the nav state it was given').toBe(closed.nav);
    expect(p.detail, 'no detail').toBeNull();

    const open = press(closed, 'A').state;
    helpScreen.paint(view, VM, open);
    expect(painted).toHaveLength(2);
    expect((painted[1] as { detail: unknown }).detail, 'the open detail').toBe('recruit');
    expect((painted[1] as { nav: unknown }).nav, 'the same nav behind the detail').toBe(open.nav);
  });

  it('init: every open starts on Introduction with no detail — an init after a stepped state (even handed it as memory) is not that state, and Help does not opt in to cross-open memory', () => {
    // WRONG IMPL KILLED: a screen that keeps its tab or detail in module state (the second init would
    // open on the Encyclopedia, or on a stale detail); one that opts in to memory and honours
    // `remembered` (a reopened Help would resume where it was).
    const stepped = press(onEntry(6), 'A').state;
    expect(tabOf(stepped), 'fixture: stepped onto the Encyclopedia').toBe('encyclopedia');
    expect(stepped.detail, 'fixture: a detail is open').toBe('affinity');
    const second = helpScreen.init(VM);
    expect(second.nav, 'a second init opens on Introduction').toEqual(navInit(HELP_LAYOUT));
    expect(second.detail, 'with no detail').toBeNull();
    const handed = helpScreen.init(VM, stepped);
    expect(tabOf(handed), 'handed the stepped state as memory it still opens on Introduction').toBe(
      'intro',
    );
    expect(handed.detail, 'and without its detail').toBeNull();
    expect(helpScreen.remember, 'Help does not opt in to cross-open memory').toBeUndefined();
  });

  it('host: over the shipped table the help frame takes the D-pad, RB then A paints the lent view with the Encyclopedia and the first entry`s detail, B closes only the detail (Help stays), the next B pops, Start pops to the base', () => {
    // WRONG IMPL KILLED: a table entry that is not this screen (nothing paints, RB is `unhandled`);
    // a B that pops while a detail is open (the host would close Help with the sheet); a step that
    // paints another frame's view; a Start that is not the base pop.
    const painted: Array<{ nav: { tab: string; item: string }; detail: string | null }> = [];
    const lent = (id: FrameId): unknown =>
      id === 'helpView'
        ? {
            paint: (p: unknown) => {
              painted.push(p as (typeof painted)[number]);
            },
          }
        : undefined;
    const host = new ScreenHost(SCREEN_ADAPTERS, lent, (err) => {
      throw new Error(`unexpected paint error: ${String(err)}`);
    });
    const help: UpperFrame = { kind: 'screen', id: 'helpView' };
    const stack: Stack = [{ kind: 'world' }, help];
    const nav = (button: VButton): NavInput => ({ button, repeat: false });
    host.opened(help);
    expect(host.takesNav(stack), 'the help frame takes the D-pad').toBe(true);
    expect(host.button(stack, nav('RB'), CTX)).toBe('consumed');
    expect(painted[0]?.nav.tab, 'on the Encyclopedia').toBe('encyclopedia');
    expect(host.button(stack, nav('A'), CTX)).toBe('consumed');
    expect(painted[1]?.detail, 'A opened the first entry').toBe('party');
    expect(host.button(stack, nav('B'), CTX), 'B closes the detail, it does not pop').toBe(
      'consumed',
    );
    expect(painted[2]?.detail, 'the detail is closed').toBeNull();
    expect(painted[2]?.nav.item, 'on the same entry').toBe('party');
    expect(host.button(stack, nav('B'), CTX), 'the next B pops').toEqual(POP);
    expect(host.button(stack, nav('Start'), CTX)).toEqual(POP_TO_BASE);
    expect(host.button(stack, nav('Select'), CTX)).toEqual(TOGGLE_HELP);
  });
});
