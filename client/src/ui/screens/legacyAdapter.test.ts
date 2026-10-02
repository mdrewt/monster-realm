/**
 * legacyAdapter.test.ts: the one adapter every screen uses in legacy DOM-button mode (ctl-6b,
 * CTL6B.1 / CTL6B.2 / CTL6B.3 / CTL6B.4).
 *
 * Pure, node env. `legacyAdapter.onButton(vm, nav, btn)` answers a virtual-button DOWN edge for a
 * frame whose controls are still native DOM buttons: A is `unhandled` (the focused native button
 * owns Enter, so activation stays native), B pops ONE frame, Start pops to the base, Select toggles
 * Help, and every other button is `unhandled` (D-pad, X, Y, LB, RB belong to the page or to a later
 * slice). A repeat-flagged B/Start/Select is swallowed (`consumed`): a held key must neither pop a
 * second frame nor fall through to the ladder.
 *
 * The results are interpreted through the REAL pure stack rules (`popTop`, `popToBase`), so each
 * case asserts what the stack becomes, not just which tag came back. Nothing here reads the DOM,
 * the SDK or a clock.
 */
import { describe, expect, it } from 'vitest';
import { VBUTTONS, type VButton } from '../../input/buttons';
import {
  type BaseFrame,
  type FrameId,
  popToBase,
  popTop,
  type Stack,
  type UpperFrame,
  WORLD_STACK,
} from '../contextStack';
import type { NavInput, NavState } from '../nav';
import { legacyAdapter } from './legacyAdapter';
import type { ScreenContext, ScreenResult } from './types';

/** The adapter never reads the context; a bare stand-in is enough (specs are not typechecked). */
const CTX = {
  store: {},
  identity: 'ab'.repeat(32),
  bindings: { buttons: {}, accels: {} },
  now: () => 0,
} as unknown as ScreenContext;

/** A nav state the adapter must ignore: legacy mode has no nav of its own. */
const SOME_NAV: NavState = { tab: null, item: 'monsters', perTab: {} };

const fresh = (button: VButton): NavInput => ({ button, repeat: false });
const held = (button: VButton): NavInput => ({ button, repeat: true });

/** Ask the adapter exactly as `screenButton` does: the view model first, then the button. */
const ask = (btn: NavInput, nav: NavState | undefined = undefined): ScreenResult =>
  legacyAdapter.onButton(legacyAdapter.viewModel(CTX), nav, btn);

const WORLD: BaseFrame = { kind: 'world' };
const battle = (battleId: string): BaseFrame => ({ kind: 'battle', battleId });
const screen = (id: FrameId): UpperFrame => ({ kind: 'screen', id });
const stackOf = (base: BaseFrame, ...upper: UpperFrame[]): Stack => [base, ...upper];

/** What the shell does with a result, using only the pure rules the shell itself uses. */
function interpret(stack: Stack, result: ScreenResult): Stack {
  if (typeof result === 'string') return stack;
  switch (result.kind) {
    case 'pop':
      return popTop(stack);
    case 'popToBase':
      return popToBase(stack);
    default:
      return stack;
  }
}

/** Freeze a stack and every frame in it, so an in-place write throws. */
function deepFrozen(s: Stack): Stack {
  for (const frame of s) Object.freeze(frame);
  return Object.freeze([...s]) as unknown as Stack;
}

const POP: ScreenResult = { kind: 'pop' };
const POP_TO_BASE: ScreenResult = { kind: 'popToBase' };
const TOGGLE_HELP: ScreenResult = { kind: 'toggleHelp' };

describe('legacyAdapter (ctl-6b)', () => {
  it('CTL6B-1-LEGACY-TABLE: every virtual button maps to its legacy result, fresh and repeat-flagged, with or without a nav state', () => {
    // WRONG IMPL KILLED: an A that is handled (the focused native button would never receive its
    // Enter), a D-pad / X / Y / LB / RB that is swallowed or turned into a command (the page would
    // stop scrolling and a later slice's tabs would be pre-empted), a B / Start / Select that
    // ignores the repeat flag (a held Backspace would pop every frame, a held Escape would
    // re-fire), a repeat that returns `unhandled` (the held key would fall through to the
    // ladder), a result that depends on the nav argument, and a view model that is not undefined.
    const table: Record<VButton, { readonly fresh: ScreenResult; readonly repeat: ScreenResult }> =
      {
        Up: { fresh: 'unhandled', repeat: 'unhandled' },
        Down: { fresh: 'unhandled', repeat: 'unhandled' },
        Left: { fresh: 'unhandled', repeat: 'unhandled' },
        Right: { fresh: 'unhandled', repeat: 'unhandled' },
        A: { fresh: 'unhandled', repeat: 'unhandled' },
        B: { fresh: POP, repeat: 'consumed' },
        X: { fresh: 'unhandled', repeat: 'unhandled' },
        Y: { fresh: 'unhandled', repeat: 'unhandled' },
        LB: { fresh: 'unhandled', repeat: 'unhandled' },
        RB: { fresh: 'unhandled', repeat: 'unhandled' },
        Start: { fresh: POP_TO_BASE, repeat: 'consumed' },
        Select: { fresh: TOGGLE_HELP, repeat: 'consumed' },
      };
    // ANTI-VACUITY: the table covers exactly the closed button set, so a new button cannot slip by.
    expect(Object.keys(table).sort()).toEqual([...VBUTTONS].sort());
    expect(legacyAdapter.viewModel(CTX), 'legacy mode has no view model').toBeUndefined();

    for (const button of VBUTTONS) {
      for (const nav of [undefined, SOME_NAV]) {
        const label = `${button} / ${nav === undefined ? 'no nav' : 'with nav'}`;
        expect(ask(fresh(button), nav), `${label} / fresh`).toEqual(table[button].fresh);
        expect(ask(held(button), nav), `${label} / repeat`).toEqual(table[button].repeat);
      }
    }
  });

  it('CTL6B-3-LEGACY-B-POPS-ONE: B pops exactly one frame, whatever sits under it, and a bare base is left alone', () => {
    // WRONG IMPL KILLED: a B that returns popToBase (Backspace would close the menu with its child:
    // B4), a pop that is keyed by an id and removes every frame sharing it, a result that clears
    // the base, and a pop that mutates its input.
    const result = ask(fresh('B'));
    expect(result).toEqual({ kind: 'pop' });

    const rows: ReadonlyArray<{ readonly name: string; readonly from: Stack; readonly to: Stack }> =
      [
        {
          name: 'three frames over the world',
          from: stackOf(WORLD, screen('menuView'), screen('questLogView'), screen('helpView')),
          to: stackOf(WORLD, screen('menuView'), screen('questLogView')),
        },
        {
          name: 'the menu with a child above it returns to the menu',
          from: stackOf(WORLD, screen('menuView'), screen('claimView')),
          to: stackOf(WORLD, screen('menuView')),
        },
        {
          name: 'a lone frame closes',
          from: stackOf(WORLD, screen('boxView')),
          to: WORLD_STACK,
        },
        {
          name: 'over a battle base the base survives',
          from: stackOf(battle('7'), screen('menuView'), screen('claimView')),
          to: stackOf(battle('7'), screen('menuView')),
        },
      ];
    for (const row of rows) {
      const before = JSON.stringify(row.from);
      const next = interpret(deepFrozen(row.from), result);
      expect(next, row.name).toEqual(row.to);
      expect(next.length, `${row.name}: one frame fewer`).toBe(row.from.length - 1);
      expect(JSON.stringify(row.from), `${row.name}: the input is untouched`).toBe(before);
    }

    // A bare base has nothing to pop: the very same stack comes back.
    const bare = deepFrozen(stackOf(battle('7')));
    expect(interpret(bare, result), 'a bare battle base').toBe(bare);
    expect(interpret(WORLD_STACK, result), 'a bare world').toBe(WORLD_STACK);
  });

  it('CTL6B-2-LEGACY-START-POPS-TO-BASE: Start pops every frame down to the base, keeping a battle base', () => {
    // WRONG IMPL KILLED: a Start that pops one frame (it would leave the menu up under a child), a
    // Start that is a toggle, a pop-to-base that drops the battle base, and one that returns the
    // world base for a battle.
    const result = ask(fresh('Start'));
    expect(result).toEqual({ kind: 'popToBase' });

    const rows: ReadonlyArray<{ readonly name: string; readonly from: Stack; readonly to: Stack }> =
      [
        {
          name: 'a menu with a child above it closes both',
          from: stackOf(WORLD, screen('menuView'), screen('questLogView')),
          to: WORLD_STACK,
        },
        {
          name: 'a lone frame closes',
          from: stackOf(WORLD, screen('claimView')),
          to: WORLD_STACK,
        },
        {
          name: 'four frames close',
          from: stackOf(
            WORLD,
            screen('menuView'),
            screen('tradeView'),
            { kind: 'prompt', id: 'pvpView' },
            { kind: 'textEntry', owner: 'renameView' },
          ),
          to: WORLD_STACK,
        },
        {
          name: 'over a battle base the base survives',
          from: stackOf(battle('9'), screen('menuView'), screen('claimView')),
          to: stackOf(battle('9')),
        },
      ];
    for (const row of rows) {
      const before = JSON.stringify(row.from);
      const next = interpret(deepFrozen(row.from), result);
      expect(next, row.name).toEqual(row.to);
      expect(JSON.stringify(row.from), `${row.name}: the input is untouched`).toBe(before);
    }
  });

  it('CTL6B-4-LEGACY-SELECT-HELP: Select is the help toggle and changes no stack by itself', () => {
    // WRONG IMPL KILLED: a Select that opens help only (the second press could never close it), one
    // routed through the retired `e.key === "?"` shape (it is a button now, not a glyph), and one
    // that pops frames as a side effect.
    const result = ask(fresh('Select'));
    expect(result).toEqual({ kind: 'toggleHelp' });
    const from = deepFrozen(stackOf(WORLD, screen('helpView')));
    expect(
      interpret(from, result),
      'the toggle is the shell`s job: the stack rule is a no-op',
    ).toBe(from);
    // Select, B and Start are three different answers.
    const answers = new Set(
      (['Select', 'B', 'Start'] as const).map((b) => JSON.stringify(ask(fresh(b)))),
    );
    expect(answers.size).toBe(3);
  });
});
