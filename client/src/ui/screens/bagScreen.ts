// ui/screens/bagScreen.ts — the Bag frame as a pure screen over the nav kit (design §5 row 2,
// CTL8F.1, CTL8F.2). No DOM, SDK, module state or clock; `raisingView.ts` paints what `paint`
// hands it. The frame is the raising root: it keeps its overlay id, so the legacy KeyI and the
// menu's Bag entry open it.
//
// Pocket tabs (bagModel: derived from the item definitions) each hold a list of the owned items;
// LB/RB switch pockets and each pocket keeps its cursor. A on an item opens its sheet: Feed (food;
// disabled with no monster), Use (battle items: always refused here, the reason says where they are
// used) and Info. Feed opens the monster picker; A on a monster sends `train` at once (no confirm),
// closes the picker and leaves the cursor on the item. The "Fed {name}" line shows only once a
// batch shows that item's count below what it was at the press (a vanished item counts 0), and the
// next button ends it with any feed still pending, so a refused feed never claims success. B backs
// out one level; B at the list pops the frame.
//
// The kit cannot seat this frame at its open (only main.ts can), so `init` leaves `shown` null:
// the first batch's `observe` then always answers a new state and the host paints the pockets.
import { party_size, party_slot_none } from '../../../../client-wasm/pkg/client_wasm.js';
import {
  actionLayout,
  type BagAction,
  type BagItemVm,
  type BagVm,
  bagLayout,
  bagMonsters,
  buildBagVm,
  findItem,
  pickerLayout,
} from '../bagModel';
import {
  type ItemLayout,
  type NavLayout,
  type NavState,
  navInit,
  navReconcile,
  navStep,
} from '../nav';
import type { RaisingView } from '../raisingView';
import type { ButtonStep, ScreenAdapter, ScreenResult } from './types';

export type BagPhase =
  | { readonly kind: 'list' }
  | { readonly kind: 'sheet'; readonly itemId: number; readonly action: BagAction }
  | { readonly kind: 'info'; readonly itemId: number }
  /** The Feed picker; `monster` is the cursor monster's key (null only while there is none). */
  | { readonly kind: 'picker'; readonly itemId: number; readonly monster: string | null };

/** The frame's one status line: a refused action's reason, or a feed seen landing. */
export type BagStatus =
  | { readonly kind: 'battleOnly' }
  | { readonly kind: 'noMonsters' }
  | { readonly kind: 'fed'; readonly name: string }
  | null;

/** A feed sent and not yet seen landing: resolved once `itemId`'s live count drops below `count`.
 *  `name` is the monster's name at the press. */
interface PendingFeed {
  readonly itemId: number;
  readonly count: number;
  readonly name: string;
}

export interface BagScreenState {
  readonly nav: NavState;
  readonly phase: BagPhase;
  readonly status: BagStatus;
  readonly pendingFeed: PendingFeed | null;
  /** The pocket layout the cursor was last settled against, and its signature. */
  readonly layout: NavLayout;
  readonly layoutKey: string;
  /** The signature of the view model last painted; null until the first paint (see the header). */
  readonly shown: string | null;
}

/** What the view paints. */
export interface BagPaint {
  readonly vm: BagVm;
  readonly nav: NavState;
  readonly phase: BagPhase;
  readonly status: BagStatus;
}

const LIST: BagPhase = { kind: 'list' };

const signature = (value: unknown): string =>
  JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? `${v}` : v));

/** A list cursor as a nav state, for stepping the sheet and the picker with the kit. */
const listNav = (item: string | null): NavState => ({ tab: null, item, perTab: {} });

const firstKey = (layout: ItemLayout): string | null => layout.items[0]?.key ?? null;

const actionsOf = (vm: BagVm, item: BagItemVm): ItemLayout =>
  actionLayout(item, vm.monsters.length > 0);

/** The state with its `shown` brought up to `vm`: the SAME object when it already is. */
function withShown(vm: BagVm, state: BagScreenState): BagScreenState {
  const shown = signature(vm);
  return shown === state.shown ? state : { ...state, shown };
}

/** Bring the state up to the view model: the cursor re-seated by key, a phase whose item is gone
 *  closed, a sheet or picker cursor re-seated (an empty picker closed to the sheet), a pending feed
 *  resolved once it shows. The SAME state when nothing changed. */
function settle(vm: BagVm, state: BagScreenState): BagScreenState {
  let next = state;
  const layout = bagLayout(vm);
  const layoutKey = signature(layout);
  if (layoutKey !== state.layoutKey) {
    next = { ...next, layout, layoutKey, nav: navReconcile(state.layout, layout, state.nav) };
  }

  const phase = next.phase;
  const item = phase.kind === 'list' ? undefined : findItem(vm, phase.itemId);
  if (phase.kind !== 'list' && item === undefined) {
    next = { ...next, phase: LIST };
  } else if (phase.kind === 'sheet' && item !== undefined) {
    const actions = actionsOf(vm, item);
    if (!actions.items.some((a) => a.key === phase.action)) {
      next = { ...next, phase: { ...phase, action: firstKey(actions) as BagAction } };
    }
  } else if (phase.kind === 'picker') {
    const first = vm.monsters[0];
    if (first === undefined) {
      next = { ...next, phase: { kind: 'sheet', itemId: phase.itemId, action: 'feed' } };
    } else if (phase.monster === null || !vm.monsters.some((m) => m.key === phase.monster)) {
      next = { ...next, phase: { ...phase, monster: first.key } };
    }
  }

  const feed = next.pendingFeed;
  if (feed !== null && (findItem(vm, feed.itemId)?.count ?? 0) < feed.count) {
    next = { ...next, pendingFeed: null, status: { kind: 'fed', name: feed.name } };
  }
  return withShown(vm, next);
}

export const bagScreen: ScreenAdapter<BagVm, BagScreenState, RaisingView> = {
  nav: true,

  viewModel: (ctx) =>
    buildBagVm(
      ctx.store.ownInventory(ctx.identity),
      ctx.store.itemDefs(),
      bagMonsters(
        ctx.store.ownMonsters(ctx.identity),
        ctx.store.speciesMap(),
        party_size(),
        party_slot_none(),
      ),
    ),

  init: (vm) => {
    const layout = bagLayout(vm);
    return {
      nav: navInit(layout),
      phase: LIST,
      status: null,
      pendingFeed: null,
      layout,
      layoutKey: signature(layout),
      shown: null,
    };
  },

  onButton(vm, state, btn): ButtonStep<BagScreenState> {
    // Every button ends the last line and a feed still pending.
    const settled = settle(vm, state);
    const base: BagScreenState =
      settled.status === null && settled.pendingFeed === null
        ? settled
        : { ...settled, status: null, pendingFeed: null };
    const finish = (next: BagScreenState, result: ScreenResult) => ({
      state: withShown(vm, next),
      result,
    });
    const done = (result: ScreenResult, next: BagScreenState = base) => finish(next, result);
    const to = (phase: BagPhase, extra: Partial<BagScreenState> = {}) =>
      finish({ ...base, ...extra, phase }, 'consumed');
    if (btn.button === 'Start') return done({ kind: 'popToBase' });
    if (btn.button === 'Select') return done({ kind: 'toggleHelp' });
    // A phase the settle just changed under the player's A only paints: the press was aimed at
    // what was on screen, which is gone.
    if (btn.button === 'A' && settled.phase !== state.phase) return done('consumed');
    const { phase } = base;

    switch (phase.kind) {
      case 'list': {
        if (btn.button === 'B') return done({ kind: 'pop' });
        const step = navStep(base.layout, base.nav, btn);
        switch (step.outcome.kind) {
          case 'ignored':
            return done('unhandled');
          case 'activate': {
            const item = findItem(vm, Number(step.outcome.key));
            if (item === undefined) return done('consumed');
            const action = firstKey(actionsOf(vm, item)) as BagAction;
            return to({ kind: 'sheet', itemId: item.itemId, action });
          }
          default:
            return done('consumed', { ...base, nav: step.state });
        }
      }
      case 'sheet': {
        if (btn.button === 'B') return to(LIST);
        const item = findItem(vm, phase.itemId);
        if (item === undefined) return done('consumed');
        const step = navStep(actionsOf(vm, item), listNav(phase.action), btn);
        const outcome = step.outcome;
        if (outcome.kind === 'disabled') {
          const status: BagStatus =
            outcome.reason === 'noMonsters' ? { kind: 'noMonsters' } : { kind: 'battleOnly' };
          return done('consumed', { ...base, status });
        }
        if (outcome.kind === 'activate') {
          if (outcome.key === 'info') return to({ kind: 'info', itemId: item.itemId });
          return to({ kind: 'picker', itemId: item.itemId, monster: vm.monsters[0]?.key ?? null });
        }
        const action = (step.state.item ?? phase.action) as BagAction;
        return action === phase.action ? done('consumed') : to({ ...phase, action });
      }
      case 'info':
        if (btn.button === 'A' || btn.button === 'B') {
          if (btn.repeat) return done('consumed');
          return to({ kind: 'sheet', itemId: phase.itemId, action: 'info' });
        }
        return done('consumed');
      case 'picker': {
        if (btn.button === 'B') return to({ kind: 'sheet', itemId: phase.itemId, action: 'feed' });
        const step = navStep(pickerLayout(vm), listNav(phase.monster), btn);
        if (step.outcome.kind === 'activate') {
          const key = step.outcome.key;
          const monster = vm.monsters.find((m) => m.key === key);
          const item = findItem(vm, phase.itemId);
          if (monster === undefined || item === undefined) return done('consumed');
          return finish(
            {
              ...base,
              phase: LIST,
              pendingFeed: { itemId: item.itemId, count: item.count, name: monster.name },
            },
            { kind: 'train', monsterId: monster.monsterId, foodItemId: item.itemId },
          );
        }
        const monster = step.state.item;
        return monster === phase.monster ? done('consumed') : to({ ...phase, monster });
      }
    }
  },

  observe: (vm, state) => settle(vm, state),

  paint(view, vm, state): void {
    view.paint({ vm, nav: state.nav, phase: state.phase, status: state.status });
  },
};
