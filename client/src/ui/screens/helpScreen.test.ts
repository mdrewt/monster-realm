// ui/screens/helpScreen.test.ts — ctl-14 (CTL14.1): Help as a pure screen over the nav kit.
//
// Node env, no DOM. `helpScreen` is driven only through `viewModel`, `init`, `onButton` and `paint`
// (into a recording fake view); `HELP_LAYOUT` is read as data.
//
// THE CONTRACT (plan monster-realm-ctl-14-plan.md; the specialist builds exactly this):
//   export const HELP_LAYOUT: NavLayout       a `tabs` layout over HELP_TABS (keys 'screen',
//                                              'controls', 'goals'); each tab a `list` with ONE item,
//                                              key 'rows', enabled (the rows are display-only).
//   export const helpScreen: ScreenAdapter<VM, HelpState, HelpScreenView>   with `nav: true`
//   state                { nav: NavState }                  (nothing else: no request, no capture)
//   init                 { nav: navInit(HELP_LAYOUT) }      (opens on This screen)
//   LB / RB              switch tab (wrap when fresh, clamp on a repeat), consumed
//   B                    { kind: 'pop' };  Start { kind: 'popToBase' };  Select { kind: 'toggleHelp' }
//   A, D-pad             'consumed', the tab unchanged;  X, Y  'unhandled'
//   a repeat-flagged B / Start / Select / A is 'consumed' and acts on nothing (controlsScreen precedent)
//   paint(view, vm, state)  calls `view.paint({ layout: HELP_LAYOUT, nav: state.nav })` exactly once.
//     ONE PAINT SHAPE (the plan text said `{layout, state}`; the controls precedent spreads the
//     state, and this state is `{nav}`, so the shape is `{ layout, nav }`): the specialist follows it
//     and `helpView.paint` receives it (helpView.test.ts uses the same shape).
// The view model is whatever `viewModel(ctx)` answers (Help's content is bound at open by main.ts),
// threaded unchanged into `init`, `onButton` and `paint`.
//
// LEGACY BEHAVIOUR REPLACED (anti-vacuity): Help held the LEGACY adapter: B popped, Start popped to
// the base, Select toggled help, A / X / Y / LB / RB were `unhandled` (LB and RB scrolled the page),
// no D-pad, no tabs. Every case below is red on the missing module.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import type { VButton } from '../../input/buttons';
import type { FrameId, Stack, UpperFrame } from '../contextStack';
import { HELP_TABS } from '../helpModel';
import { type NavInput, type NavLayout, navInit } from '../nav';
import { HELP_LAYOUT, helpScreen } from './helpScreen';
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

const POP: ScreenResult = { kind: 'pop' };
const POP_TO_BASE: ScreenResult = { kind: 'popToBase' };
const TOGGLE_HELP: ScreenResult = { kind: 'toggleHelp' };

describe('helpScreen (ctl-14, CTL14.1)', () => {
  it('CTL14-1-SCREEN-TABS: Help opens on This screen; RB and LB walk This screen | All controls | Goals and wrap at both ends; B pops, Start pops to the base and Select toggles Help; A and the D-pad are swallowed on the same tab and X and Y are the page`s; a repeat acts on nothing; and the shipped table holds this nav-capable screen for the help frame', () => {
    // WRONG IMPL KILLED: the legacy adapter left in the table (RB would be `unhandled` and scroll
    // the page, nothing would paint); a screen without its nav mark (the router keeps the D-pad);
    // an opening on another tab; tabs in another order or without the wrap (RB from Goals sticks);
    // RB and LB swapped; a B that is not a pop (the menu under Help would close with it) or a
    // Start that pops one frame instead of all; a Select that does nothing (it is the Help key: the
    // second press must close Help); an A or D-pad press that changes the tab or answers a
    // command; an X / Y that is swallowed (Space and F belong to the page); and a repeat B / Start /
    // Select that acts again (a held Backspace would close Help and the screen under it).
    expect(SCREEN_ADAPTERS.helpView, 'the help frame holds the ctl-14 screen').toBe(helpScreen);
    expect(helpScreen.nav, 'and it is nav-capable').toBe(true);

    const start = fresh();
    expect(start.nav, 'it opens on the first tab').toEqual(navInit(HELP_LAYOUT));
    expect(tabOf(start), 'This screen').toBe('screen');
    expect(Object.keys(start), 'the state is the nav state and nothing else').toEqual(['nav']);

    // RB: screen -> controls -> goals -> (wrap) screen.
    const seenRb: Array<string | null> = [];
    let s = start;
    for (let i = 0; i < 4; i += 1) {
      const step = press(s, 'RB');
      expect(step.result, `RB ${i + 1} is swallowed`).toBe('consumed');
      s = step.state;
      seenRb.push(tabOf(s));
    }
    expect(seenRb, 'RB walks right and wraps').toEqual(['controls', 'goals', 'screen', 'controls']);

    // LB: screen -> (wrap) goals -> controls -> screen.
    const seenLb: Array<string | null> = [];
    s = start;
    for (let i = 0; i < 3; i += 1) {
      const step = press(s, 'LB');
      expect(step.result, `LB ${i + 1} is swallowed`).toBe('consumed');
      s = step.state;
      seenLb.push(tabOf(s));
    }
    expect(seenLb, 'LB walks left and wraps').toEqual(['goals', 'controls', 'screen']);

    // A repeat clamps at the ends (a held bumper never spins through the tabs).
    const atGoals = walk(start, ['RB', 'RB']);
    expect(tabOf(atGoals)).toBe('goals');
    const heldRb = press(atGoals, 'RB', true);
    expect(heldRb.result).toBe('consumed');
    expect(tabOf(heldRb.state), 'a repeat RB does not wrap').toBe('goals');
    const heldLb = press(start, 'LB', true);
    expect(heldLb.result).toBe('consumed');
    expect(tabOf(heldLb.state), 'a repeat LB does not wrap').toBe('screen');

    // The commands, from every tab.
    for (const tab of HELP_TABS) {
      const at = walk(start, Array<VButton>(HELP_TABS.indexOf(tab)).fill('RB'));
      expect(tabOf(at), `fixture: on ${tab}`).toBe(tab);
      expect(press(at, 'B').result, `${tab}: B`).toEqual(POP);
      expect(press(at, 'Start').result, `${tab}: Start`).toEqual(POP_TO_BASE);
      expect(press(at, 'Select').result, `${tab}: Select`).toEqual(TOGGLE_HELP);
      for (const button of ['A', 'Up', 'Down', 'Left', 'Right'] as const) {
        const step = press(at, button);
        expect(step.result, `${tab}: ${button} is swallowed`).toBe('consumed');
        expect(tabOf(step.state), `${tab}: ${button} stays on the tab`).toBe(tab);
        expect(step.state.nav.item, `${tab}: ${button} keeps the one row`).toBe('rows');
      }
      for (const button of ['X', 'Y'] as const) {
        const step = press(at, button);
        expect(step.result, `${tab}: ${button} is the page's`).toBe('unhandled');
        expect(step.state, `${tab}: ${button} changes nothing`).toEqual(at);
      }
      // A repeat acts on nothing: swallowed, state kept.
      for (const button of ['B', 'Start', 'Select', 'A'] as const) {
        const step = press(at, button, true);
        expect(step.result, `${tab}: a repeat ${button} is swallowed`).toBe('consumed');
        expect(step.state, `${tab}: a repeat ${button} changes nothing`).toEqual(at);
      }
    }
  });

  it('HELP_LAYOUT: a tabs layout over This screen, All controls and Goals, each a list of one enabled row key', () => {
    // WRONG IMPL KILLED: a layout with another tab order or key set (the view and the adapter key
    // their panels on the tab key); a tab with no item (navStep finds nothing and the A press
    // cannot be answered), several items (the cursor would have somewhere to wander) or a disabled
    // one; a grid; and a non-tabs layout (LB / RB would do nothing).
    const layout: NavLayout = HELP_LAYOUT;
    expect(layout.kind, 'tabs').toBe('tabs');
    if (layout.kind !== 'tabs') throw new Error('HELP_LAYOUT must be a tabs layout');
    expect(
      layout.tabs.map((x) => x.key),
      'the tab keys are the HELP_TABS roster, in order',
    ).toEqual([...HELP_TABS]);
    for (const tab of layout.tabs) {
      expect(tab.layout.kind, `${tab.key}: a list`).toBe('list');
      expect(tab.layout.items, `${tab.key}: one enabled row`).toEqual([
        { key: 'rows', enabled: true },
      ]);
    }
  });

  it('paint: hands the lent view exactly one { layout: HELP_LAYOUT, nav } with the nav state it was given, whichever tab', () => {
    // WRONG IMPL KILLED: an adapter with no paint (the tab strip never moves); a paint that hands
    // the view a state object of another shape (the view reads `nav`); one that hands another
    // layout or builds a fresh one per paint; a paint that fires twice; and one that paints the
    // initial state instead of the one it was given.
    const painted: unknown[] = [];
    const view = {
      paint: (p: unknown) => {
        painted.push(p);
      },
    };
    if (helpScreen.paint === undefined) throw new Error('helpScreen must define paint');
    const onGoals = walk(fresh(), ['LB']);
    expect(tabOf(onGoals), 'fixture: LB from the first tab wraps to Goals').toBe('goals');
    helpScreen.paint(view, VM, onGoals);
    expect(painted, 'exactly one paint').toHaveLength(1);
    const p = painted[0] as { layout: unknown; nav: unknown };
    expect(Object.keys(p).sort(), 'the paint is { layout, nav }').toEqual(['layout', 'nav']);
    expect(p.layout, 'the one layout').toBe(HELP_LAYOUT);
    expect(p.nav, 'the nav state it was given').toBe(onGoals.nav);
    expect((p.nav as { tab: string }).tab).toBe('goals');
  });

  it('host: over the shipped table the help frame takes the D-pad, RB paints the lent view onto All controls, B pops and Start pops to the base', () => {
    // WRONG IMPL KILLED: a table entry that is not the screen (nothing paints, RB is `unhandled`);
    // a screen the host cannot drive from the real context fields; a step that paints another
    // frame's view; and a Start that is not the base pop.
    const painted: unknown[] = [];
    const lent = (id: FrameId): unknown =>
      id === 'helpView'
        ? {
            paint: (p: unknown) => {
              painted.push(p);
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
    expect(painted, 'one step, one paint').toHaveLength(1);
    expect((painted[0] as { nav: { tab: string } }).nav.tab, 'on All controls').toBe('controls');
    expect(host.button(stack, nav('B'), CTX)).toEqual(POP);
    expect(host.button(stack, nav('Start'), CTX)).toEqual(POP_TO_BASE);
    expect(painted, 'B and Start each painted once more').toHaveLength(3);
    // Select while Help is the top frame closes it through the toggle command.
    expect(host.button(stack, nav('Select'), CTX)).toEqual(TOGGLE_HELP);
  });
});
