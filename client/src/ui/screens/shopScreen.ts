// ui/screens/shopScreen.ts — the shop frame as a pure screen over the nav kit (design §5,
// CTL8A.2): tabs Buy | Sell, a quantity row, then a Yes/No confirm. No DOM, SDK, module state or
// clock; `shopView.ts` paints what `paint` hands it.
//
// The bound shop is `ctx.shopId` (the greet-then-shop pick), read live; the legacy view model
// (`buildShopViewModelForShop`) stays the one source of rows, prices and the balance. The state is
// a tabs cursor over the two lists plus a phase: `browse` (A on a row opens its quantity row at 1),
// `qty` (Left/Right change it, clamped, repeats included; A opens the confirm) and `confirm` (Buy
// defaults to Yes, Sell to No; a fresh Up/Down flips it, a repeat never does; Yes issues the
// command and returns to the list). Y describes the cursor row until the next move. Every step
// first settles the state against the rows a batch may have moved: a vanished row closes its
// prompt, a shrunken stack caps the sell quantity, a gone cursor is re-seated.
//
// The feedback line ("✓ Bought 2 Bait (−40g)") is dispatch's (CTL7D.4): this screen adds none.

import { list, type NavLayout, type NavState, navInit, navReconcile, navStep, tabs } from '../nav';
import {
  buildShopViewModel,
  buildShopViewModelForShop,
  itemDescription,
  type ShopInventoryItemViewModel,
  type ShopItemViewModel,
  type ShopScreenViewModel,
  type ShopTab,
  shopBuyKey,
  shopSellKey,
} from '../shopModel';
import type { ShopPaint, ShopView } from '../shopView';
import type { ButtonStep, ScreenAdapter, ScreenContext, ScreenResult } from './types';

/** The most of one item a single buy sends. The server still prices and refuses. */
export const SHOP_BUY_MAX = 99;

export type { ShopTab };

export interface ShopScreenVm {
  /** The bound shop's legacy view model, or the no-shop one. */
  readonly shop: ShopScreenViewModel;
  /** Each listed item's non-blank description, by item id. */
  readonly descriptions: ReadonlyMap<number, string>;
}

export type ShopPhase =
  | { readonly kind: 'browse' }
  | { readonly kind: 'qty'; readonly tab: ShopTab; readonly itemId: number; readonly qty: number }
  | {
      readonly kind: 'confirm';
      readonly tab: ShopTab;
      readonly itemId: number;
      readonly qty: number;
      readonly yes: boolean;
    };

export interface ShopScreenState {
  /** The tab and the cursor row in each list (keys from `shopBuyKey` / `shopSellKey`). */
  readonly nav: NavState;
  readonly phase: ShopPhase;
  /** Y: the cursor row's description is shown until the next move. */
  readonly info: boolean;
}

const BROWSE: ShopPhase = { kind: 'browse' };

/** A row either list can show: what the two prompts and the paint need of it. */
interface Row {
  readonly key: string;
  readonly itemId: number;
  readonly name: string;
  /** The unit price the confirm multiplies: the stock row's buy price, or the sell price. */
  readonly unitPrice: bigint;
  /** The most the quantity row offers. */
  readonly max: number;
  readonly enabled: boolean;
}

const buyRow = (item: ShopItemViewModel): Row => ({
  key: shopBuyKey(item),
  itemId: item.itemId,
  name: item.name,
  unitPrice: item.buyPrice,
  max: SHOP_BUY_MAX,
  enabled: true,
});

const sellRow = (item: ShopInventoryItemViewModel): Row => ({
  key: shopSellKey(item),
  itemId: item.itemId,
  name: item.name,
  unitPrice: item.sellPrice,
  max: item.count,
  // A stack of 0 has nothing to sell: its quantity range would be empty.
  enabled: item.canSell && item.count >= 1,
});

function rowsOf(vm: ShopScreenVm, tab: ShopTab): readonly Row[] {
  if (vm.shop.kind !== 'shop') return [];
  return tab === 'buy' ? vm.shop.forSale.map(buyRow) : vm.shop.forSaleByPlayer.map(sellRow);
}

const layoutOf = (vm: ShopScreenVm): NavLayout =>
  tabs([
    { key: 'buy', layout: list(rowsOf(vm, 'buy').map(({ key, enabled }) => ({ key, enabled }))) },
    { key: 'sell', layout: list(rowsOf(vm, 'sell').map(({ key, enabled }) => ({ key, enabled }))) },
  ]);

const tabOf = (nav: NavState): ShopTab => (nav.tab === 'sell' ? 'sell' : 'buy');

const rowAt = (vm: ShopScreenVm, tab: ShopTab, key: string | null): Row | undefined =>
  key === null ? undefined : rowsOf(vm, tab).find((r) => r.key === key);

const rowFor = (vm: ShopScreenVm, tab: ShopTab, itemId: number): Row | undefined =>
  rowsOf(vm, tab).find((r) => r.itemId === itemId && r.enabled);

const CONFIRM_LAYOUT = list([
  { key: 'yes', enabled: true },
  { key: 'no', enabled: true },
]);

/** The quantity `n` clamped into the row's `1..max`: the row never wraps, never leaves the range
 *  the reducer accepts (a sell above the owned count is refused). */
const clampQty = (n: number, row: Row): number => Math.min(Math.max(1, n), row.max);

/** `state` settled against the view model's rows: the SAME object when nothing changed. A gone or
 *  null cursor is re-seated (on the first row); a prompt whose row is gone or disabled closes; a
 *  sell quantity above the stack drops to it. */
function settle(vm: ShopScreenVm, state: ShopScreenState): ShopScreenState {
  const layout = layoutOf(vm);
  const nav = navReconcile(layout, layout, state.nav);
  let phase = state.phase;
  if (phase.kind !== 'browse') {
    const row = rowFor(vm, phase.tab, phase.itemId);
    if (row === undefined) phase = BROWSE;
    else if (phase.qty > row.max) phase = { ...phase, qty: row.max };
  }
  if (nav === state.nav && phase === state.phase) return state;
  return { nav, phase, info: state.info };
}

/** A step that only moves the cursor: the description is cleared with it. */
const moved = (state: ShopScreenState, nav: NavState): ShopScreenState =>
  nav === state.nav ? state : { nav, phase: state.phase, info: false };

export const shopScreen: ScreenAdapter<ShopScreenVm, ShopScreenState, ShopView> = {
  nav: true,

  viewModel(ctx: ScreenContext): ShopScreenVm {
    const itemDefs = ctx.store.itemDefs();
    const wallet = ctx.store.ownWallet(ctx.identity);
    const shop =
      ctx.shopId === null
        ? buildShopViewModel([], [], itemDefs, [], wallet)
        : buildShopViewModelForShop(
            ctx.shopId,
            ctx.store.allShops(),
            ctx.store.allShopItems(),
            itemDefs,
            ctx.store.ownInventory(ctx.identity),
            wallet,
          );
    const descriptions = new Map<number, string>();
    if (shop.kind === 'shop') {
      for (const { itemId } of [...shop.forSale, ...shop.forSaleByPlayer]) {
        const text = itemDescription(itemId, itemDefs);
        if (text !== null) descriptions.set(itemId, text);
      }
    }
    return { shop, descriptions };
  },

  /** The Buy tab on its first row. */
  init(vm): ShopScreenState {
    return { nav: navInit(layoutOf(vm)), phase: BROWSE, info: false };
  },

  onButton(vm, kept, btn): ButtonStep<ShopScreenState> {
    const state = settle(vm, kept);
    const done = (result: ScreenResult): ButtonStep<ShopScreenState> => ({ state, result });
    const to = (next: ShopScreenState): ButtonStep<ShopScreenState> => ({
      state: next,
      result: 'consumed',
    });
    switch (btn.button) {
      case 'Start':
        return done(btn.repeat ? 'consumed' : { kind: 'popToBase' });
      case 'Select':
        return done(btn.repeat ? 'consumed' : { kind: 'toggleHelp' });
      default:
        break;
    }
    const { phase } = state;
    const tab = tabOf(state.nav);
    switch (phase.kind) {
      case 'browse':
        switch (btn.button) {
          case 'Up':
          case 'Down':
          case 'LB':
          case 'RB':
            return to(moved(state, navStep(layoutOf(vm), state.nav, btn).state));
          case 'Left':
          case 'Right':
            return done('consumed');
          case 'A': {
            if (btn.repeat) return done('consumed');
            const row = rowAt(vm, tab, state.nav.item);
            if (row === undefined || !row.enabled) return done('consumed');
            return to({ ...state, phase: { kind: 'qty', tab, itemId: row.itemId, qty: 1 } });
          }
          case 'Y':
            if (btn.repeat || rowAt(vm, tab, state.nav.item) === undefined) return done('consumed');
            return to(state.info ? state : { ...state, info: true });
          case 'B':
            return done(btn.repeat ? 'consumed' : { kind: 'pop' });
          default:
            return done('unhandled');
        }
      case 'qty': {
        const row = rowFor(vm, phase.tab, phase.itemId);
        if (row === undefined) return to({ ...state, phase: BROWSE }); // settled away meanwhile
        switch (btn.button) {
          case 'Left':
          case 'Right': {
            const qty = clampQty(phase.qty + (btn.button === 'Left' ? -1 : 1), row);
            return qty === phase.qty
              ? done('consumed')
              : to({ ...state, phase: { ...phase, qty } });
          }
          case 'A':
            if (btn.repeat) return done('consumed');
            return to({
              ...state,
              phase: {
                kind: 'confirm',
                tab: phase.tab,
                itemId: phase.itemId,
                qty: phase.qty,
                yes: phase.tab === 'buy',
              },
            });
          case 'B':
            return btn.repeat ? done('consumed') : to({ ...state, phase: BROWSE });
          case 'Up':
          case 'Down':
          case 'LB':
          case 'RB':
          case 'Y':
            return done('consumed');
          default:
            return done('unhandled');
        }
      }
      case 'confirm':
        switch (btn.button) {
          case 'Up':
          case 'Down': {
            // A Yes/No cursor moves on a fresh press only: a held arrow must not flip the answer.
            if (btn.repeat) return done('consumed');
            const yes =
              navStep(
                CONFIRM_LAYOUT,
                { tab: null, item: phase.yes ? 'yes' : 'no', perTab: {} },
                btn,
              ).state.item === 'yes';
            return yes === phase.yes
              ? done('consumed')
              : to({ ...state, phase: { ...phase, yes } });
          }
          case 'A': {
            if (btn.repeat) return done('consumed');
            const back = { ...state, phase: BROWSE };
            if (!phase.yes || vm.shop.kind !== 'shop') return to(back);
            const { itemId, qty } = phase;
            return {
              state: back,
              result:
                phase.tab === 'buy'
                  ? { kind: 'buy', shopId: vm.shop.shopId, itemId, qty }
                  : { kind: 'sell', itemId, qty },
            };
          }
          case 'B':
            return btn.repeat ? done('consumed') : to({ ...state, phase: BROWSE });
          case 'Left':
          case 'Right':
          case 'LB':
          case 'RB':
          case 'Y':
            return done('consumed');
          default:
            return done('unhandled');
        }
    }
  },

  observe: (vm, state) => settle(vm, state),

  paint(view, vm, state): void {
    const tab = tabOf(state.nav);
    const cursor = rowAt(vm, tab, state.nav.item);
    let prompt: ShopPaint['prompt'] = null;
    const { phase } = state;
    if (phase.kind !== 'browse') {
      const row = rowFor(vm, phase.tab, phase.itemId);
      if (row !== undefined) {
        prompt =
          phase.kind === 'qty'
            ? { kind: 'qty', tab: phase.tab, name: row.name, qty: phase.qty }
            : {
                kind: 'confirm',
                tab: phase.tab,
                name: row.name,
                qty: phase.qty,
                gold: row.unitPrice * BigInt(phase.qty),
                yes: phase.yes,
              };
      }
    }
    view.paint({
      tab,
      activeKey: cursor?.key ?? null,
      description:
        state.info && cursor !== undefined
          ? (vm.descriptions.get(cursor.itemId) ?? null)
          : undefined,
      prompt,
    });
  },
};
