/**
 * battleScreen.test.ts: the battle's D-pad adapter (ctl-8i, CTL8I.1).
 *
 * Pure, node env. `battleScreen` (ui/screens/battleScreen.ts) is the adapter the host steps at a
 * BARE battle base. It keeps NO cursor of its own: the battle view owns the cursor (which list,
 * which row), so an adapter only turns a button into a ONE-SHOT op token (`{kind:'move', dir}` /
 * `{kind:'activate'}` / `{kind:'back'}`, a fresh object per press) that its paint hands to the
 * view (`view.applyBattleOp(op)`). Select and B-at-the-base are the usual base answers.
 *
 * bt-11 (named intentional change, BT11.6 / plan REV 4 §R4.9): the tactical controller map adds
 * three tokens — X is the danger toggle (`{kind:'danger'}`), LB / RB cycle own units
 * (`{kind:'cycle', dir:-1|1}`) and Start is End Turn / Guard / Submit (`{kind:'start'}`; main.ts's
 * `battleButton(..., tactical)` leaves Start to the adapter when the tactical shell owns the frame).
 * A held X / LB / RB / Start is swallowed with no token. Were: X, LB, RB
 * unhandled and Start swallowed with no token.
 *
 * Named intentional change (the Hold Y gesture): Y is the adapter's too. A fresh Y — the tap the
 * input router hands over at the release while Clear plan is holdable, else at the press — is a
 * `{kind:'holdHint'}` token; the router's hold input `{button:'Y', repeat:false, hold:true}` is a
 * `{kind:'clearPlan'}` token; a repeat Y is swallowed with no token. Were: Y unhandled at every
 * step (the page's). `battleHoldButtons(stack, holdable)` names the bare battle base's
 * hold-capable buttons: exactly Y while the shell can clear a plan, else none.
 *
 * One case (its tag is the title's first word): the whole key table, fresh and repeat, from a fresh
 * state and from a state still carrying a stale token (a step's op is the NEW token or null, never
 * the previous one); fresh token identity; paint applies a token once and a null token never.
 */
import { describe, expect, it } from 'vitest';
import { VBUTTONS, type VButton } from '../../input/buttons';
import type { Stack } from '../contextStack';
import type { NavInput } from '../nav';
import {
  type BattleOp,
  type BattleOpsView,
  type BattleScreenState,
  battleHoldButtons,
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

/** A fresh press, per button. */
const FRESH: Readonly<Record<VButton, Expected>> = {
  Up: move('Up'),
  Down: move('Down'),
  Left: move('Left'),
  Right: move('Right'),
  A: { result: 'consumed', op: { kind: 'activate' } },
  B: { result: 'consumed', op: { kind: 'back' } },
  // bt-11 (BT11.6): X toggles the danger overlay, LB / RB cycle own units, Start is the tactical
  // End Turn / Guard / Submit.
  X: { result: 'consumed', op: { kind: 'danger' } },
  // Named intentional change: a fresh Y is the Clear plan hint token. Were: unhandled.
  Y: { result: 'consumed', op: { kind: 'holdHint' } },
  LB: { result: 'consumed', op: { kind: 'cycle', dir: -1 } },
  RB: { result: 'consumed', op: { kind: 'cycle', dir: 1 } },
  Start: { result: 'consumed', op: { kind: 'start' } },
  Select: { result: { kind: 'toggleHelp' }, op: null },
};

/** A synthesized auto-repeat, per button: a held arrow still walks the cursor, and every button
 *  that acts on a press is swallowed on a repeat (a held X / LB / RB / Start acts once). */
const REPEAT: Readonly<Record<VButton, Expected>> = {
  ...FRESH,
  A: SWALLOWED,
  B: SWALLOWED,
  X: SWALLOWED,
  // Named intentional change: a held Y hints once, at its fresh press. Were: unhandled (FRESH's).
  Y: SWALLOWED,
  LB: SWALLOWED,
  RB: SWALLOWED,
  Start: SWALLOWED,
  Select: SWALLOWED,
};

describe('the battle adapter (ctl-8i)', () => {
  it('CTL8I-1-ADAPTER-KEYS: the adapter is nav-capable, ignores the context and starts with no token; every button answers the table (X danger, LB / RB cycle, Start start, Y the hold hint), fresh and repeat, from a fresh state and from a stale one; every step returns a NEW state holding the new token or null; and paint applies a token once and a null token never', () => {
    // WRONG IMPL KILLED: an adapter not marked nav (the router would keep the D-pad for the page,
    // and the battle would stay Tab and mouse only); one that reads the store or the context; an A
    // or B that acts on a repeat (a held Enter would press twice, a held Backspace would back out
    // twice); an arrow that is ignored on a repeat (a held arrow could not walk the grid) or that
    // acts; a Left or Right that is unhandled (the arrows would scroll the page); bt-11: an X, LB,
    // RB or Start left unhandled or swallowed with no token (the danger toggle, unit cycling and
    // End Turn would be pointer-only, BT11.6), LB and RB swapped (dir -1 is the PREVIOUS unit), a
    // held X / LB / RB / Start that acts again (a held Q would spin through the units), and a Y
    // left to the page or hinting again while held; a Select that is not help; a state keeping the
    // previous token (the host paints after EVERY step, so a later button would re-apply an old
    // op); one token object reused for every press (the view dedupes by identity, so the second
    // Down would be dropped); and a state object reused across steps (the host compares nothing,
    // but the contract is a new state per step).
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
    const rb1 = adapter.onButton(vm, fresh, nav('RB'));
    const rb2 = adapter.onButton(vm, rb1.state, nav('RB'));
    expect(rb2.state.op, 'the second RB').toEqual({ kind: 'cycle', dir: 1 });
    expect(rb2.state.op, 'a new cycle object').not.toBe(rb1.state.op);
    const start1 = adapter.onButton(vm, fresh, nav('Start'));
    const start2 = adapter.onButton(vm, start1.state, nav('Start'));
    expect(start2.state.op, 'a new start object').not.toBe(start1.state.op);

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

    // The host paints after every step: after an A the next step (a held Y, swallowed with no
    // token) holds no token, so painting it applies nothing, and the earlier A is not applied again.
    // Named intentional change: the no-token step is a held Y. Were: a fresh Y, unhandled.
    const afterA = adapter.onButton(vm, fresh, nav('A'));
    const afterY = adapter.onButton(vm, afterA.state, nav('Y', true));
    const painted: BattleOp[] = [];
    const recorder: BattleOpsView = {
      applyBattleOp(op) {
        painted.push(op);
      },
    };
    adapter.paint?.(recorder, vm, afterA.state);
    adapter.paint?.(recorder, vm, afterY.state);
    expect(painted, 'only the A was applied, once').toEqual([{ kind: 'activate' }]);
  });
});

// ==========================================================================================
// Hold Y: the adapter's two Y tokens, and the battle base's hold-capable buttons
// ==========================================================================================

/** The input router's hold input of `button` (a listed button held HOLD_MS). */
const held = (button: VButton): NavInput => ({ button, repeat: false, hold: true });

/** A view that records every op painted into it. */
function recordingView(): { readonly applied: BattleOp[]; readonly view: BattleOpsView } {
  const applied: BattleOp[] = [];
  return {
    applied,
    view: {
      applyBattleOp(op) {
        applied.push(op);
      },
    },
  };
}

const BARE_BATTLE: Stack = [{ kind: 'battle', battleId: '7' }];

describe('the battle adapter: Y and the hold-capable buttons', () => {
  it('a fresh Y (the tap the router hands over) is consumed with a NEW holdHint token from a fresh or a stale state, a held Y is swallowed with no token, and paint hands the hint to the view once as the very token [gp-6.6]', () => {
    // WRONG IMPL KILLED: Y left unhandled (the tap reaches no view: no hint line); a hint token
    // reused across presses (the view dedupes by identity, so the second tap would be dropped); a
    // repeat Y that hints again; a tap read as the clear (a quick press would clear the plan); the
    // stale token kept in the state (a later paint re-applies an old op).
    const vm = adapter.viewModel(NO_CTX);
    const fresh = adapter.init(vm);
    const stale: BattleScreenState = { op: { kind: 'activate' } };
    for (const [from, start] of [
      ['a fresh state', fresh],
      ['a stale state', stale],
    ] as const) {
      const step = adapter.onButton(vm, start, nav('Y'));
      expect(step.result, `${from}: consumed`).toBe('consumed');
      expect(step.state.op, `${from}: the hint token`).toEqual({ kind: 'holdHint' });
      expect(step.state, `${from}: a new state`).not.toBe(start);
      expect(step.state.op, `${from}: not the previous token`).not.toBe(start.op);
    }
    const first = adapter.onButton(vm, fresh, nav('Y'));
    const second = adapter.onButton(vm, first.state, nav('Y'));
    expect(second.state.op, 'the second tap hints again').toEqual({ kind: 'holdHint' });
    expect(second.state.op, 'as a new token object').not.toBe(first.state.op);
    const repeat = adapter.onButton(vm, first.state, nav('Y', true));
    expect(repeat.result, 'a held Y').toBe('consumed');
    expect(repeat.state.op, 'carries no token').toBeNull();

    const { applied, view } = recordingView();
    adapter.paint?.(view, vm, first.state);
    adapter.paint?.(view, vm, repeat.state);
    expect(applied, 'one hint painted').toEqual([{ kind: 'holdHint' }]);
    expect(applied[0], 'the very token').toBe(first.state.op);
  });

  it('the hold input of Y is consumed with a NEW clearPlan token per hold, from a fresh or a stale state, painted to the view once; a hold flag on any other button answers exactly as its plain press [gp-6.7]', () => {
    // WRONG IMPL KILLED: the hold read as a tap (a hint instead of the clear: Hold Y would never
    // clear); a hold left unhandled or swallowed with no token; one clearPlan object reused (the
    // second hold would be dropped by the view); a hold flag read on A, B or Start (a stray flag
    // would change what they do).
    const vm = adapter.viewModel(NO_CTX);
    const fresh = adapter.init(vm);
    const stale: BattleScreenState = { op: { kind: 'holdHint' } };
    for (const [from, start] of [
      ['a fresh state', fresh],
      ['a state holding a hint token', stale],
    ] as const) {
      const step = adapter.onButton(vm, start, held('Y'));
      expect(step.result, `${from}: consumed`).toBe('consumed');
      expect(step.state.op, `${from}: the clear token`).toEqual({ kind: 'clearPlan' });
      expect(step.state, `${from}: a new state`).not.toBe(start);
    }
    const first = adapter.onButton(vm, fresh, held('Y'));
    const second = adapter.onButton(vm, first.state, held('Y'));
    expect(second.state.op, 'a second hold clears again').toEqual({ kind: 'clearPlan' });
    expect(second.state.op, 'as a new token object').not.toBe(first.state.op);

    const { applied, view } = recordingView();
    adapter.paint?.(view, vm, first.state);
    expect(applied, 'one clear painted').toEqual([{ kind: 'clearPlan' }]);
    expect(applied[0], 'the very token').toBe(first.state.op);

    let others = 0;
    for (const button of VBUTTONS) {
      if (button === 'Y') continue;
      const flagged = adapter.onButton(vm, fresh, held(button));
      const plain = adapter.onButton(vm, fresh, nav(button));
      expect(flagged.result, `${button} with a hold flag: result`).toEqual(plain.result);
      expect(flagged.state.op, `${button} with a hold flag: token`).toEqual(plain.state.op);
      others += 1;
    }
    expect(others, 'ANTI-VACUITY: the eleven other buttons').toBe(11);
  });

  it('battleHoldButtons lists exactly Y at the bare battle base while Clear plan is holdable, as the SAME set object on every call and for any battle [gp-6.7]', () => {
    // WRONG IMPL KILLED: no list at the bare base (the router never arms Y: Hold Y does nothing);
    // a list with more than Y (B would wait for its release: the press-time skip is lost); a new
    // set per call (read every frame: an allocation per frame).
    const set = battleHoldButtons(BARE_BATTLE, true);
    expect(set, 'a list at the bare battle base').toBeDefined();
    expect([...(set ?? [])], 'exactly Y').toEqual(['Y']);
    for (const button of VBUTTONS) {
      expect(set?.has(button), `${button}`).toBe(button === 'Y');
    }
    expect(battleHoldButtons(BARE_BATTLE, true), 'the same object on the next call').toBe(set);
    expect(
      battleHoldButtons([{ kind: 'battle', battleId: '9007199254740993' }], true),
      'and for another battle',
    ).toBe(set);
  });

  it('battleHoldButtons lists nothing while any frame is over the battle base — the main menu, a screen, a dialogue, help, a prompt, a text entry — even while Clear plan is holdable [gp-6.8]', () => {
    // WRONG IMPL KILLED: a list read from the base alone (Y held under the main menu would clear
    // the plan behind it, and the menu's own Y would wait for its release).
    const battle = { kind: 'battle', battleId: '7' } as const;
    const over: ReadonlyArray<readonly [string, Stack]> = [
      ['the main menu', [battle, { kind: 'screen', id: 'menuView' }]],
      [
        'a screen opened over the battle',
        [battle, { kind: 'screen', id: 'boxView', overBattle: '7' }],
      ],
      ['a dialogue', [battle, { kind: 'screen', id: 'dialogueView' }]],
      ['help', [battle, { kind: 'screen', id: 'helpView' }]],
      ['a prompt', [battle, { kind: 'prompt', id: 'controlsView' }]],
      [
        'a text entry',
        [
          battle,
          { kind: 'screen', id: 'profileView' },
          { kind: 'textEntry', owner: 'profileView' },
        ],
      ],
      [
        'a screen over the main menu',
        [battle, { kind: 'screen', id: 'menuView' }, { kind: 'screen', id: 'questLogView' }],
      ],
    ];
    for (const [label, stack] of over) {
      expect(battleHoldButtons(stack, true), `${label}, holdable`).toBeUndefined();
      expect(battleHoldButtons(stack, false), `${label}, not holdable`).toBeUndefined();
    }
    expect(battleHoldButtons(BARE_BATTLE, true), 'control: the bare base lists Y').toBeDefined();
  });

  it('battleHoldButtons lists nothing at the bare battle base while Clear plan is not holdable, and nothing at the world base either way [gp-6.10]', () => {
    // WRONG IMPL KILLED: a list that ignores the holdable flag (every Y tap on the battle base would
    // wait for its release with nothing to clear); a list at the world (Y there opens the action
    // sheet at its press).
    expect(battleHoldButtons(BARE_BATTLE, false), 'not holdable').toBeUndefined();
    expect(battleHoldButtons([{ kind: 'world' }], true), 'the world, holdable').toBeUndefined();
    expect(battleHoldButtons([{ kind: 'world' }], false), 'the world').toBeUndefined();
    expect(
      battleHoldButtons([{ kind: 'world' }, { kind: 'screen', id: 'battleView' }], true),
      'the outcome frame (the world base with the battle screen)',
    ).toBeUndefined();
    expect(battleHoldButtons(BARE_BATTLE, true), 'control: holdable lists Y').toBeDefined();
  });
});
