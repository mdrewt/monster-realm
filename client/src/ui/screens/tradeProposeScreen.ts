// ui/screens/tradeProposeScreen.ts — the trade-propose wizard as a pure screen (design §5,
// CTL8E.1-.2; defect B5). No DOM, SDK, module state or clock; `tradeProposeView.ts` paints what
// `paint` hands it.
//
// The steps are Target (only when no target was supplied; the face-to-face open supplies one, so
// in the product it never shows), Offer, Coins, Ask and Review. LB/RB page between them (clamped), B steps back and closes at the first step, Start
// abandons the draft. Target is the native select (it owns the D-pad while focused): A moves on.
// Offer moves a cursor over the own monsters, by id, and A toggles ✓ on it. Coins and Ask are
// typing rows (CTL6B.5): the field owns the keys, Enter reaches here as A and moves on. Review
// opens on Yes; A on Yes sends and moves the cursor to No, so a second A never sends twice.
//
// The draft is the view's DOM, never this state: what the player sees is what is sent, and the
// mouse and the D-pad edit the same draft. A toggle and a send are one-shot TOKENS (a new object
// each press, compared by identity) that the view applies to that draft once (the nickname-commit
// precedent, monstersScreen.ts).
import { list, type NavLayout, navFocus, navInit, navStep } from '../nav';
import {
  buildProposeLists,
  type ProposeStep,
  proposeSteps,
  type TradeProposeLists,
} from '../tradeProposeModel';
import type { TradeProposeView } from '../tradeProposeView';
import type { ButtonStep, ScreenAdapter, ScreenContext, ScreenResult } from './types';

export interface TradeProposeScreenVm {
  readonly lists: TradeProposeLists;
  /** Whether the open path supplied the counterparty (no Target step): `ctx.proposeTarget`. */
  readonly targetSupplied: boolean;
}

/** Toggle ✓ on `monsterId` once. */
export interface ProposeToggle {
  readonly monsterId: bigint;
}

/** Send the on-screen draft once. */
export interface ProposeCommit {
  readonly kind: 'commit';
}

export interface TradeProposeScreenState {
  readonly steps: readonly ProposeStep[];
  readonly step: ProposeStep;
  /** The Offer cursor: a monster id as a decimal string; null with nothing to offer. */
  readonly offer: string | null;
  /** The Review cursor: Yes (true) or No. */
  readonly yes: boolean;
  readonly toggle: ProposeToggle | null;
  readonly commit: ProposeCommit | null;
}

const monsterKeys = (vm: TradeProposeScreenVm): string[] =>
  vm.lists.offerableMonsters.map((m) => m.monsterId.toString());

const offerLayout = (keys: readonly string[]): NavLayout =>
  list(keys.map((key) => ({ key, enabled: true })));

/** The cursor re-seated on the live list: kept while still offered, else the first monster. */
function seatOffer(keys: readonly string[], offer: string | null): string | null {
  if (offer !== null && keys.includes(offer)) return offer;
  return keys[0] ?? null;
}

/** `state` on `step`; every arrival at Review lands on Yes. */
function goTo(state: TradeProposeScreenState, step: ProposeStep): TradeProposeScreenState {
  if (step === state.step) return state;
  return { ...state, step, yes: step === 'review' ? true : state.yes };
}

export const tradeProposeScreen: ScreenAdapter<
  TradeProposeScreenVm,
  TradeProposeScreenState,
  TradeProposeView
> = {
  nav: true,

  viewModel(ctx: ScreenContext): TradeProposeScreenVm {
    return {
      lists: buildProposeLists(
        ctx.store.allPlayers(),
        ctx.store.ownMonsters(ctx.identity),
        ctx.store.speciesMap(),
        ctx.identity,
      ),
      targetSupplied: ctx.proposeTarget != null,
    };
  },

  init(vm): TradeProposeScreenState {
    const steps = proposeSteps(vm.targetSupplied);
    return {
      steps,
      step: steps[0] as ProposeStep,
      offer: seatOffer(monsterKeys(vm), null),
      yes: true,
      toggle: null,
      commit: null,
    };
  },

  onButton(vm, state, btn): ButtonStep<TradeProposeScreenState> {
    const done = (result: ScreenResult): ButtonStep<TradeProposeScreenState> => ({
      state,
      result,
    });
    const to = (next: TradeProposeScreenState): ButtonStep<TradeProposeScreenState> => ({
      state: next,
      result: 'consumed',
    });
    const at = state.steps.indexOf(state.step);
    const prev = state.steps[at - 1];
    const next = state.steps[at + 1];

    switch (btn.button) {
      case 'Start':
        return done(btn.repeat ? 'consumed' : { kind: 'popToBase' });
      case 'Select':
        return done(btn.repeat ? 'consumed' : { kind: 'toggleHelp' });
      case 'B':
        if (btn.repeat) return done('consumed');
        return prev === undefined ? done({ kind: 'pop' }) : to(goTo(state, prev));
      case 'LB':
        return btn.repeat || prev === undefined ? done('consumed') : to(goTo(state, prev));
      case 'RB':
        return btn.repeat || next === undefined ? done('consumed') : to(goTo(state, next));
      case 'Up':
      case 'Down':
      case 'Left':
      case 'Right':
        return dpad(vm, state, btn.button, btn.repeat);
      case 'A': {
        if (btn.repeat) return done('consumed');
        switch (state.step) {
          case 'offer': {
            const offer = seatOffer(monsterKeys(vm), state.offer);
            if (offer === null) return done('consumed');
            return to({ ...state, offer, toggle: { monsterId: BigInt(offer) } });
          }
          case 'review':
            if (!state.yes) return prev === undefined ? done('consumed') : to(goTo(state, prev));
            return to({ ...state, yes: false, commit: { kind: 'commit' } });
          default:
            return next === undefined ? done('consumed') : to(goTo(state, next));
        }
      }
      default:
        return done('unhandled');
    }
  },

  paint(view, vm, state): void {
    view.paint({
      steps: state.steps,
      step: state.step,
      lists: vm.lists,
      offerCursor: state.offer,
      yes: state.yes,
      toggle: state.toggle,
      commit: state.commit,
    });
  },
};

/** The D-pad: the Offer cursor (a repeat moves it too) and the Review Yes/No flip (fresh presses
 *  only). Everywhere else it is swallowed: the select and the typing rows own it natively. */
function dpad(
  vm: TradeProposeScreenVm,
  state: TradeProposeScreenState,
  button: 'Up' | 'Down' | 'Left' | 'Right',
  repeat: boolean,
): ButtonStep<TradeProposeScreenState> {
  if (state.step === 'review') {
    if (repeat) return { state, result: 'consumed' };
    return { state: { ...state, yes: !state.yes }, result: 'consumed' };
  }
  if (state.step !== 'offer' || button === 'Left' || button === 'Right') {
    return { state, result: 'consumed' };
  }
  const keys = monsterKeys(vm);
  const layout = offerLayout(keys);
  const seated = seatOffer(keys, state.offer);
  const from =
    seated === null ? navInit(layout) : navFocus(layout, navInit(layout), { item: seated });
  const moved = navStep(layout, from, { button, repeat }).state.item;
  return moved === state.offer
    ? { state, result: 'consumed' }
    : { state: { ...state, offer: moved }, result: 'consumed' };
}
