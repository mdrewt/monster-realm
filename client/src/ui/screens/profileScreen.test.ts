/**
 * profileScreen.test.ts: the three Profile row-adapters (ctl-8h, CTL8H.2 / CTL8H.3 / CTL8H.4).
 *
 * Pure, node env. `nameScreen`, `accountScreen` and `privacyScreen` (ui/screens/profileScreen.ts)
 * are the adapters of the rename, claim and privacy frames. They keep NO cursor of their own: the
 * rows are the views' real controls and the cursor is DOM focus, so an adapter only turns a button
 * into a ONE-SHOT row token (`{kind:'move', delta}` / `{kind:'activate'}`, a fresh object per
 * press) that its paint hands to the view (`view.applyRowOp(op)`). Start, Select and B are the
 * usual stack commands.
 *
 * - CTL8H-2-ADAPTER-KEYS: the whole key table, for all three adapters, fresh and repeat, from a
 *   fresh state and from a state that still carries a stale token (a step's op is the NEW token
 *   or null, never the previous one).
 * - CTL8H-2-TOKEN-ONE-SHOT: through the REAL ScreenHost over the SHIPPED table (a spy view lent
 *   for the frame): an A paints `applyRowOp(activate)` once, and no later step (LB, Y, X, Left,
 *   Start, Select, a repeat A) paints it again. Up then Down paint two distinct objects.
 */
import { describe, expect, it } from 'vitest';
import { VBUTTONS, type VButton } from '../../input/buttons';
import type { FrameId, Stack } from '../contextStack';
import type { NavInput } from '../nav';
import { SCREEN_ADAPTERS, ScreenHost } from './index';
import {
  accountScreen,
  nameScreen,
  privacyScreen,
  type RowOp,
  type RowsView,
} from './profileScreen';
import type { ScreenAdapter, ScreenContext, ScreenResult } from './types';

interface ProfileState {
  readonly op: RowOp | null;
}
type ProfileAdapter = ScreenAdapter<unknown, ProfileState, RowsView>;

/** The three adapters with the frame each one answers. */
const PROFILE: ReadonlyArray<readonly [string, FrameId, ProfileAdapter]> = [
  ['nameScreen', 'renameView', nameScreen as unknown as ProfileAdapter],
  ['accountScreen', 'claimView', accountScreen as unknown as ProfileAdapter],
  ['privacyScreen', 'privacyView', privacyScreen as unknown as ProfileAdapter],
];

/** A context that fails the run if anything reads it: these adapters ignore the context. */
const NO_CTX = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`the Profile adapters must not read ctx.${String(prop)}`);
    },
  },
) as unknown as ScreenContext;

const nav = (button: VButton, repeat = false): NavInput => ({ button, repeat });
const stackOf = (id: FrameId): Stack => [{ kind: 'world' }, { kind: 'screen', id }];

interface Expected {
  readonly result: ScreenResult;
  readonly op: RowOp | null;
}
const UP: Expected = { result: 'consumed', op: { kind: 'move', delta: -1 } };
const DOWN: Expected = { result: 'consumed', op: { kind: 'move', delta: 1 } };
const SWALLOWED: Expected = { result: 'consumed', op: null };
const UNHANDLED: Expected = { result: 'unhandled', op: null };

/** A fresh press, per button. */
const FRESH: Readonly<Record<VButton, Expected>> = {
  Up: UP,
  Down: DOWN,
  Left: SWALLOWED,
  Right: SWALLOWED,
  A: { result: 'consumed', op: { kind: 'activate' } },
  B: { result: { kind: 'pop' }, op: null },
  X: UNHANDLED,
  Y: UNHANDLED,
  LB: UNHANDLED,
  RB: UNHANDLED,
  Start: { result: { kind: 'popToBase' }, op: null },
  Select: { result: { kind: 'toggleHelp' }, op: null },
};

/** A synthesized auto-repeat, per button: the D-pad rows still move (a held arrow walks the
 *  list), and every other button that acts on a press is swallowed on a repeat. */
const REPEAT: Readonly<Record<VButton, Expected>> = {
  ...FRESH,
  A: SWALLOWED,
  B: SWALLOWED,
  Start: SWALLOWED,
  Select: SWALLOWED,
};

describe('the Profile row adapters (ctl-8h)', () => {
  it('CTL8H-2-ADAPTER-KEYS: all three adapters are nav-capable and ignore the context; init starts with no token; every button answers the table, fresh and repeat; and every step`s state carries the NEW token or null, never the previous one', () => {
    // WRONG IMPL KILLED: an adapter that is not marked nav (the router would keep the D-pad for
    // the page); one that reads the store/context; an A that acts on a repeat (a held Enter would
    // click twice); an Up/Down that is ignored on a repeat (a held arrow could not walk a list)
    // or that acts; a Left/Right that is unhandled (the arrows would scroll the page) or that
    // moves a row; a Start/Select/B that survives a repeat; an X/Y/LB/RB that is swallowed (the
    // page and the legacy ladder own them); a state that keeps the previous token (a later paint
    // would re-apply it); one token object reused for every press (the view dedupes by identity,
    // so the second Down would be dropped); and an op shape other than the contract's.
    expect([...Object.keys(FRESH)].sort(), 'the table covers every button').toEqual(
      [...VBUTTONS].sort(),
    );
    let steps = 0;
    for (const [name, , adapter] of PROFILE) {
      expect(adapter.nav, `${name} is nav-capable`).toBe(true);
      const vm = adapter.viewModel(NO_CTX);
      const fresh = adapter.init(vm);
      expect(fresh, `${name}: init starts with no token`).toEqual({ op: null });
      const stale: ProfileState = { op: { kind: 'move', delta: 1 } };

      for (const repeat of [false, true]) {
        const table = repeat ? REPEAT : FRESH;
        for (const button of VBUTTONS) {
          const want = table[button];
          for (const [from, start] of [
            ['a fresh state', fresh],
            ['a state holding a stale token', stale],
          ] as const) {
            const label = `${name} / ${button}${repeat ? ' (repeat)' : ''} from ${from}`;
            const step = adapter.onButton(vm, start, nav(button, repeat));
            expect(step.result, `${label}: result`).toEqual(want.result);
            expect(step.state.op, `${label}: the token`).toEqual(want.op);
            if (want.op === null) {
              expect(step.state.op, `${label}: no token left over`).toBeNull();
            } else {
              expect(step.state.op, `${label}: not the previous token`).not.toBe(start.op);
            }
            steps += 1;
          }
        }
      }

      // Two presses of the same button are two different token objects.
      const first = adapter.onButton(vm, fresh, nav('Down'));
      const second = adapter.onButton(vm, first.state, nav('Down'));
      expect(second.state.op, `${name}: the second Down`).toEqual({ kind: 'move', delta: 1 });
      expect(second.state.op, `${name}: a new object, not the first press's`).not.toBe(
        first.state.op,
      );
      const act1 = adapter.onButton(vm, fresh, nav('A'));
      const act2 = adapter.onButton(vm, act1.state, nav('A'));
      expect(act2.state.op, `${name}: the second A`).toEqual({ kind: 'activate' });
      expect(act2.state.op, `${name}: a new activate object`).not.toBe(act1.state.op);

      // paint hands the token to the view, as the very object, once; no token, no call.
      expect(typeof adapter.paint, `${name} paints`).toBe('function');
      const seen: RowOp[] = [];
      const view: RowsView = {
        applyRowOp(op) {
          seen.push(op);
        },
      };
      adapter.paint?.(view, vm, { op: null });
      expect(seen, `${name}: a null token paints nothing`).toEqual([]);
      adapter.paint?.(view, vm, act1.state);
      expect(seen, `${name}: the token reaches the view`).toHaveLength(1);
      expect(seen[0], `${name}: the very token object`).toBe(act1.state.op);
    }
    expect(steps, 'ANTI-VACUITY: 3 adapters x 12 buttons x 2 (repeat) x 2 (state)').toBe(144);
  });

  it('CTL8H-2-TOKEN-ONE-SHOT: through the real ScreenHost over the shipped table, A paints applyRowOp(activate) once and LB, Y, X, Left, Start, Select and a repeat A paint it no more; Up then Down paint two distinct move tokens; and the host answers every result', () => {
    // WRONG IMPL KILLED: a spy-only adapter test (the host is what keeps the state and paints
    // after EVERY step, so a state that keeps its token re-applies it on the next button); a
    // paint that fires for a null token; a repeat A that clicks again; a host table that does not
    // hold the adapters; and a move token that is reused (the second move would be dropped by the
    // views' identity memo).
    for (const [name, id] of PROFILE.map(([n, i]) => [n, i] as const)) {
      const seen: RowOp[] = [];
      const view: RowsView = {
        applyRowOp(op) {
          seen.push(op);
        },
      };
      const host = new ScreenHost(
        SCREEN_ADAPTERS,
        (frame) => (frame === id ? view : undefined),
        (err) => {
          throw new Error(`${name}: unexpected paint error: ${String(err)}`);
        },
      );
      const stack = stackOf(id);

      expect(host.button(stack, nav('A'), NO_CTX), `${name}: A`).toBe('consumed');
      expect(seen, `${name}: A paints activate once`).toEqual([{ kind: 'activate' }]);

      expect(host.button(stack, nav('LB'), NO_CTX), `${name}: LB`).toBe('unhandled');
      expect(host.button(stack, nav('Y'), NO_CTX), `${name}: Y`).toBe('unhandled');
      expect(host.button(stack, nav('X'), NO_CTX), `${name}: X`).toBe('unhandled');
      expect(host.button(stack, nav('Left'), NO_CTX), `${name}: Left`).toBe('consumed');
      expect(host.button(stack, nav('Start'), NO_CTX), `${name}: Start`).toEqual({
        kind: 'popToBase',
      });
      expect(host.button(stack, nav('Select'), NO_CTX), `${name}: Select`).toEqual({
        kind: 'toggleHelp',
      });
      expect(host.button(stack, nav('A', true), NO_CTX), `${name}: a repeat A`).toBe('consumed');
      expect(
        seen.filter((op) => op.kind === 'activate'),
        `${name}: activate was applied exactly once`,
      ).toHaveLength(1);
      expect(seen, `${name}: and nothing else was painted`).toHaveLength(1);

      expect(host.button(stack, nav('Up'), NO_CTX), `${name}: Up`).toBe('consumed');
      expect(host.button(stack, nav('Down'), NO_CTX), `${name}: Down`).toBe('consumed');
      expect(seen, `${name}: two more tokens`).toHaveLength(3);
      expect(seen[1], `${name}: Up`).toEqual({ kind: 'move', delta: -1 });
      expect(seen[2], `${name}: Down`).toEqual({ kind: 'move', delta: 1 });
      expect(seen[1], `${name}: two distinct objects`).not.toBe(seen[2]);

      // A held arrow: the repeat is a step of its own, with a token of its own.
      expect(host.button(stack, nav('Down', true), NO_CTX), `${name}: a repeat Down`).toBe(
        'consumed',
      );
      expect(seen, `${name}: a repeat moves`).toHaveLength(4);
      expect(seen[3], `${name}: a new object again`).not.toBe(seen[2]);

      // B pops and paints nothing (a null token), Left/Right paint nothing.
      expect(host.button(stack, nav('B'), NO_CTX), `${name}: B`).toEqual({ kind: 'pop' });
      expect(host.button(stack, nav('Right'), NO_CTX), `${name}: Right`).toBe('consumed');
      expect(seen, `${name}: B and Right paint no token`).toHaveLength(4);
    }
  });
});
