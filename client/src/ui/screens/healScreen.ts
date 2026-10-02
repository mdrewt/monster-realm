// ui/screens/healScreen.ts — the heal frame as a pure screen: "Heal party for N?" with Yes as the
// default, at the BOUND location (design §5, CTL8A.3; defect B13). No DOM, SDK, module state or
// clock; `healView.ts` paints what `paint` hands it.
//
// The bound location is `ctx.healLocationId`, read live: the healer T last interacted with, null
// after a reconnect (the frame can stay open then). With no bound row Yes is disabled and the view
// shows the reason. A on Yes heals there and moves the cursor to No, so a second A closes the frame
// instead of paying twice; No and B close it. The frame opens from a keydown with no store batch,
// so the view draws the opening state itself from the same facts `init` uses, and `observe` only
// repaints when the cost line changes.
import {
  buildHealViewModelForLocation,
  formatHealCostLine,
  type HealLocationViewModel,
} from '../healModel';
import type { HealView } from '../healView';
import { list, type NavLayout, type NavState, navFocus, navInit, navStep } from '../nav';
import type { ButtonStep, ScreenAdapter, ScreenContext } from './types';

export interface HealScreenVm {
  /** The bound location's row; null when none is bound or no loaded row has its id. */
  readonly location: HealLocationViewModel | null;
}

export interface HealScreenState {
  /** The cursor: `yes` or `no`. */
  readonly nav: NavState;
  /** The cost line painted (`formatHealCostLine`); null: no location, Heal disabled. */
  readonly cost: string | null;
}

const YES = 'yes';
const NO = 'no';

const costOf = (vm: HealScreenVm): string | null =>
  vm.location === null ? null : formatHealCostLine(vm.location);

const layoutOf = (vm: HealScreenVm): NavLayout =>
  list([
    { key: YES, enabled: vm.location !== null },
    { key: NO, enabled: true },
  ]);

export const healScreen: ScreenAdapter<HealScreenVm, HealScreenState, HealView> = {
  nav: true,

  viewModel(ctx: ScreenContext): HealScreenVm {
    const id = ctx.healLocationId;
    if (id === null) return { location: null };
    const { locations } = buildHealViewModelForLocation(
      id,
      ctx.store.healLocations(),
      ctx.store.itemDefs(),
    );
    return { location: locations[0] ?? null };
  },

  init(vm): HealScreenState {
    return { nav: navInit(layoutOf(vm)), cost: costOf(vm) };
  },

  onButton(vm, state, btn): ButtonStep<HealScreenState> {
    const done = (result: ButtonStep<HealScreenState>['result']): ButtonStep<HealScreenState> => ({
      state,
      result,
    });
    switch (btn.button) {
      case 'Start':
        return done(btn.repeat ? 'consumed' : { kind: 'popToBase' });
      case 'Select':
        return done(btn.repeat ? 'consumed' : { kind: 'toggleHelp' });
      case 'B':
        return done(btn.repeat ? 'consumed' : { kind: 'pop' });
      case 'Up':
      case 'Down': {
        // A Yes/No cursor moves on a fresh press only: a held arrow must not flip the answer.
        if (btn.repeat) return done('consumed');
        const { state: nav } = navStep(layoutOf(vm), state.nav, btn);
        return nav === state.nav
          ? done('consumed')
          : { state: { ...state, nav }, result: 'consumed' };
      }
      case 'Left':
      case 'Right':
        return done('consumed');
      case 'A': {
        if (btn.repeat) return done('consumed');
        if (state.nav.item === NO) return done({ kind: 'pop' });
        // Yes: the LIVE view model decides, never the painted cost.
        if (vm.location === null) return done('consumed');
        return {
          state: { ...state, nav: navFocus(layoutOf(vm), state.nav, { item: NO }) },
          result: { kind: 'healParty', locationId: vm.location.locationId },
        };
      }
      default:
        return done('unhandled');
    }
  },

  observe(vm, state): HealScreenState {
    const cost = costOf(vm);
    return cost === state.cost ? state : { ...state, cost };
  },

  paint(view, _vm, state): void {
    view.paint({ active: state.nav.item === NO ? NO : YES, cost: state.cost });
  },
};
