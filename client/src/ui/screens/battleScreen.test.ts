/**
 * battleScreen.test.ts: the battle's D-pad adapter (ctl-8i, CTL8I.1).
 *
 * Pure, node env. `battleScreen` (ui/screens/battleScreen.ts) is the adapter the host steps at a
 * BARE battle base. It keeps NO cursor of its own: the battle view owns the cursor (which list,
 * which row), so an adapter only turns a button into a ONE-SHOT op token (`{kind:'move', dir}` /
 * `{kind:'activate'}` / `{kind:'back'}`, a fresh object per press) that its paint hands to the
 * view (`view.applyBattleOp(op)`). Start, Select and B-at-the-base are the usual base answers:
 * main.ts's battleButton answers Start first in production, so the adapter only swallows it.
 *
 * One case (its tag is the title's first word): the whole key table, fresh and repeat, from a fresh
 * state and from a state still carrying a stale token (a step's op is the NEW token or null, never
 * the previous one); fresh token identity; paint applies a token once and a null token never.
 */
import { describe, expect, it } from 'vitest';
import { VBUTTONS, type VButton } from '../../input/buttons';
import type { NavInput } from '../nav';
import {
  type BattleOp,
  type BattleOpsView,
  type BattleScreenState,
  battleScreen,
} from './battleScreen';
import type { ScreenAdapter, ScreenContext, ScreenResult } from './types';

type BattleAdapter = ScreenAdapter<null, BattleScreenState, BattleOpsView>;
const adapter: BattleAdapter = battleScreen;

/** A context that fails the run if anything reads it: this adapter ignores the context. */
const NO_CTX = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`the battle adapter must not read ctx.${String(prop)}`);
    },
  },
) as unknown as ScreenContext;

const nav = (button: VButton, repeat = false): NavInput => ({ button, repeat });

interface Expected {
  readonly result: ScreenResult;
  readonly op: BattleOp | null;
}
const move = (dir: 'Up' | 'Down' | 'Left' | 'Right'): Expected => ({
  result: 'consumed',
  op: { kind: 'move', dir },
});
const SWALLOWED: Expected = { result: 'consumed', op: null };
const UNHANDLED: Expected = { result: 'unhandled', op: null };

/** A fresh press, per button. */
const FRESH: Readonly<Record<VButton, Expected>> = {
  Up: move('Up'),
  Down: move('Down'),
  Left: move('Left'),
  Right: move('Right'),
  A: { result: 'consumed', op: { kind: 'activate' } },
  B: { result: 'consumed', op: { kind: 'back' } },
  X: UNHANDLED,
  Y: UNHANDLED,
  LB: UNHANDLED,
  RB: UNHANDLED,
  Start: SWALLOWED,
  Select: { result: { kind: 'toggleHelp' }, op: null },
};

/** A synthesized auto-repeat, per button: a held arrow still walks the cursor, and every button
 *  that acts on a press is swallowed on a repeat. */
const REPEAT: Readonly<Record<VButton, Expected>> = {
  ...FRESH,
  A: SWALLOWED,
  B: SWALLOWED,
  Start: SWALLOWED,
  Select: SWALLOWED,
};

describe('the battle adapter (ctl-8i)', () => {
  it('CTL8I-1-ADAPTER-KEYS: the adapter is nav-capable, ignores the context and starts with no token; every button answers the table, fresh and repeat, from a fresh state and from a stale one; every step returns a NEW state holding the new token or null; and paint applies a token once and a null token never', () => {
    // WRONG IMPL KILLED: an adapter not marked nav (the router would keep the D-pad for the page,
    // and the battle would stay Tab and mouse only); one that reads the store or the context; an A
    // or B that acts on a repeat (a held Enter would press twice, a held Backspace would back out
    // twice); an arrow that is ignored on a repeat (a held arrow could not walk the grid) or that
    // acts; a Left or Right that is unhandled (the arrows would scroll the page); an X, Y, LB or
    // RB that is swallowed (the page and the legacy ladder own them); a Start that opens or pops
    // (main.ts's battleButton opens the menu; the adapter must not double it); a Select that is
    // not help; a state that keeps the previous token (the host paints after EVERY step, so a
    // later button would re-apply an old op); one token object reused for every press (the view
    // dedupes by identity, so the second Down would be dropped); and a state object reused across
    // steps (the host compares nothing, but the contract is a new state per step).
    expect([...Object.keys(FRESH)].sort(), 'the table covers every button').toEqual(
      [...VBUTTONS].sort(),
    );
    expect(adapter.nav, 'nav-capable').toBe(true);
    const vm = adapter.viewModel(NO_CTX);
    expect(vm, 'the view model is null: the view owns the cursor').toBeNull();
    const fresh = adapter.init(vm);
    expect(fresh, 'init starts with no token').toEqual({ op: null });
    const stale: BattleScreenState = { op: { kind: 'move', dir: 'Down' } };

    let steps = 0;
    for (const repeat of [false, true]) {
      const table = repeat ? REPEAT : FRESH;
      for (const button of VBUTTONS) {
        const want = table[button];
        for (const [from, start] of [
          ['a fresh state', fresh],
          ['a state holding a stale token', stale],
        ] as const) {
          const label = `${button}${repeat ? ' (repeat)' : ''} from ${from}`;
          const step = adapter.onButton(vm, start, nav(button, repeat));
          expect(step.result, `${label}: result`).toEqual(want.result);
          expect(step.state.op, `${label}: the token`).toEqual(want.op);
          expect(step.state, `${label}: a new state object`).not.toBe(start);
          if (want.op === null) {
            expect(step.state.op, `${label}: no token left over`).toBeNull();
          } else {
            expect(step.state.op, `${label}: not the previous token`).not.toBe(start.op);
          }
          steps += 1;
        }
      }
    }
    expect(steps, 'ANTI-VACUITY: 12 buttons x 2 (repeat) x 2 (state)').toBe(48);

    // Two presses of the same button are two different token objects.
    const first = adapter.onButton(vm, fresh, nav('Down'));
    const second = adapter.onButton(vm, first.state, nav('Down'));
    expect(second.state.op, 'the second Down').toEqual({ kind: 'move', dir: 'Down' });
    expect(second.state.op, 'a new object, not the first press').not.toBe(first.state.op);
    const act1 = adapter.onButton(vm, fresh, nav('A'));
    const act2 = adapter.onButton(vm, act1.state, nav('A'));
    expect(act2.state.op, 'the second A').toEqual({ kind: 'activate' });
    expect(act2.state.op, 'a new activate object').not.toBe(act1.state.op);
    const back1 = adapter.onButton(vm, fresh, nav('B'));
    const back2 = adapter.onButton(vm, back1.state, nav('B'));
    expect(back2.state.op, 'a new back object').not.toBe(back1.state.op);

    // paint hands the token to the view, as the very object, once; no token, no call.
    expect(typeof adapter.paint, 'the adapter paints').toBe('function');
    const seen: BattleOp[] = [];
    const view: BattleOpsView = {
      applyBattleOp(op) {
        seen.push(op);
      },
    };
    adapter.paint?.(view, vm, { op: null });
    expect(seen, 'a null token paints nothing').toEqual([]);
    adapter.paint?.(view, vm, act1.state);
    expect(seen, 'the token reaches the view once').toHaveLength(1);
    expect(seen[0], 'the very token object').toBe(act1.state.op);

    // The host paints after every step: after an A the next step (an unhandled LB) holds no token,
    // so painting it applies nothing, and the old A is not applied again.
    const afterA = adapter.onButton(vm, fresh, nav('A'));
    const afterLb = adapter.onButton(vm, afterA.state, nav('LB'));
    const painted: BattleOp[] = [];
    const recorder: BattleOpsView = {
      applyBattleOp(op) {
        painted.push(op);
      },
    };
    adapter.paint?.(recorder, vm, afterA.state);
    adapter.paint?.(recorder, vm, afterLb.state);
    expect(painted, 'only the A was applied, once').toEqual([{ kind: 'activate' }]);
  });
});
