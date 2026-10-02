// ui/screens/shopScreen.test.ts — ctl-8a (CTL8A.2): the shop frame's pure adapter.
//
// Node env, no DOM. `shopScreen` is driven only through `viewModel(ctx)`, `init(vm)`,
// `onButton(vm, state, btn)`, `observe(vm, state, now)` and `paint(view, vm, state)` into a
// recording fake view; every claim about the cursor, the tab, the description slot and the
// quantity / confirm prompt is read off the paint (`ShopPaint`), never off the state's internals.
// The context's fake store has the five reads the view model makes (`allShops`, `allShopItems`,
// `itemDefs`, `ownInventory`, `ownWallet`, the last two for the player's own identity only);
// `ctx.shopId` is the shop the last greet-then-shop bound (0 is a shop id). Row keys come from
// shopModel's `shopBuyKey` / `shopSellKey`, the helpers the view shares.
//
// The fixture shop is 3 (shop 0 is listed first, so a "first shop" fallback is visible):
//   Buy   Bait 20g, Potion 50g, Berry 11g, item 12 (no definition loaded)
//   Sell  Bait x5 (15g), Relic x2 (sellPrice 0: unsellable), Berry x1 (10g)
//   Descriptions: Bait, Potion and Relic have one; Berry's is blank; item 12 has no row.
//
// The contract (plan §3):
//   browse    opens on Buy, first row. Up/Down move; LB/RB switch tab (fresh wraps, repeat
//             clamps), each tab keeps its row; A on an enabled row opens the quantity at 1; Y
//             describes the cursor row; B pops. A move or a tab switch clears the description.
//   qty       Left/Right -1/+1 (repeats too), clamped to 1..SHOP_BUY_MAX (Buy) or 1..owned
//             (Sell); A opens the confirm; B back to the list.
//   confirm   Buy defaults to Yes, Sell to No; a fresh Up/Down flips it, a repeat never does;
//             Yes issues buy / sell and returns to the list; No and B return with no command.
//   settle    observe answers the SAME state when nothing changed and re-seats what a batch moved.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../../input/bindings';
import type { VButton } from '../../input/buttons';
import type {
  StoreInventory,
  StoreItemRow,
  StoreShopItemRow,
  StoreShopRow,
  StoreWallet,
} from '../../net/store';
import type { NavInput } from '../nav';
import {
  buildShopViewModel,
  buildShopViewModelForShop,
  type ShopInventoryItemViewModel,
  type ShopItemViewModel,
  type ShopViewModel,
  shopBuyKey,
  shopSellKey,
} from '../shopModel';
import type { ShopPaint, ShopView } from '../shopView';
import {
  SHOP_BUY_MAX,
  type ShopScreenState,
  type ShopScreenVm,
  type ShopTab,
  shopScreen,
} from './shopScreen';
import type { ButtonStep, ScreenContext, ScreenResult } from './types';

const ME = 'ab'.repeat(32);

function def(id: number, name: string, description: string, sellPrice: bigint): StoreItemRow {
  return {
    id,
    name,
    description,
    recruitBonus: 0,
    trainStat: null,
    trainAmount: 0,
    sellPrice,
    cureStatus: null,
  };
}
const BAIT = def(7, 'Bait', 'Lures a wild monster closer.', 15n);
const BERRY = def(8, 'Berry', '   ', 10n);
const RELIC = def(9, 'Relic', 'Old, and worth nothing to a shop.', 0n);
const POTION = def(10, 'Potion', 'Restores a little HP.', 0n);

const SHOPS: readonly StoreShopRow[] = [
  { shopId: 0, name: 'Zero Mart' },
  { shopId: 3, name: 'Tideglass' },
];
const STOCK: readonly StoreShopItemRow[] = [
  { shopItemId: 31n, shopId: 3, itemId: 7, buyPrice: 20n },
  { shopItemId: 32n, shopId: 3, itemId: 10, buyPrice: 50n },
  { shopItemId: 33n, shopId: 3, itemId: 8, buyPrice: 11n },
  { shopItemId: 34n, shopId: 3, itemId: 12, buyPrice: 5n },
  { shopItemId: 1n, shopId: 0, itemId: 7, buyPrice: 35n },
];
const bag = (invId: bigint, itemId: number, count: number): StoreInventory => ({
  invId,
  ownerIdentity: ME,
  itemId,
  count,
});

/** What the fake store holds; a case edits it between view models as a batch would. */
interface ShopWorld {
  shops: readonly StoreShopRow[];
  stock: readonly StoreShopItemRow[];
  defs: readonly StoreItemRow[];
  inventory: readonly StoreInventory[];
  wallet: StoreWallet | undefined;
  shopId: number | null;
}

function world(over: Partial<ShopWorld> = {}): ShopWorld {
  return {
    shops: SHOPS,
    stock: STOCK,
    defs: [BAIT, BERRY, RELIC, POTION],
    inventory: [bag(101n, 7, 5), bag(102n, 9, 2), bag(103n, 8, 1)],
    wallet: { ownerIdentity: ME, balance: 250n },
    shopId: 3,
    ...over,
  };
}

const defsOf = (defs: readonly StoreItemRow[]): ReadonlyMap<number, StoreItemRow> =>
  new Map(defs.map((d) => [d.id, d]));

function ctxOf(w: ShopWorld): ScreenContext {
  const store = {
    allShops: () => [...w.shops],
    allShopItems: () => [...w.stock],
    itemDefs: () => defsOf(w.defs),
    ownInventory: (identity: string) => (identity === ME ? w.inventory.map((r) => ({ ...r })) : []),
    ownWallet: (identity: string) => (identity === ME ? w.wallet : undefined),
  };
  return {
    store,
    identity: ME,
    bindings: DEFAULT_BINDINGS,
    now: () => 0,
    shopId: w.shopId,
    healLocationId: null,
    reduceMotion: false,
  } as unknown as ScreenContext;
}

const vmOf = (w: ShopWorld): ShopScreenVm => shopScreen.viewModel(ctxOf(w));

function rows(vm: ShopScreenVm): ShopViewModel {
  if (vm.shop.kind !== 'shop') throw new Error('fixture: a shop view model was expected');
  return vm.shop;
}
function buyKey(vm: ShopScreenVm, i: number): string {
  const item = rows(vm).forSale[i];
  if (item === undefined) throw new Error(`fixture: no buy row ${i}`);
  return shopBuyKey(item as ShopItemViewModel);
}
function sellKey(vm: ShopScreenVm, i: number): string {
  const item = rows(vm).forSaleByPlayer[i];
  if (item === undefined) throw new Error(`fixture: no sell row ${i}`);
  return shopSellKey(item as ShopInventoryItemViewModel);
}

type Input = VButton | NavInput;
const rep = (button: VButton): NavInput => ({ button, repeat: true });
const asInput = (input: Input): NavInput =>
  typeof input === 'string' ? { button: input, repeat: false } : input;
const label = (input: Input): string =>
  typeof input === 'string' ? input : `${input.button}${input.repeat ? ' (repeat)' : ''}`;

const press = (
  vm: ShopScreenVm,
  state: ShopScreenState,
  input: Input,
): ButtonStep<ShopScreenState> => shopScreen.onButton(vm, state, asInput(input));

/** Feed `inputs` in order, each answered 'consumed' (no command), and return the last state. */
function swallowed(vm: ShopScreenVm, state: ShopScreenState, inputs: readonly Input[]) {
  let s = state;
  for (const input of inputs) {
    const step = press(vm, s, input);
    expect(step.result, `${label(input)} is swallowed`).toBe('consumed');
    s = step.state;
  }
  return s;
}

function observe(vm: ShopScreenVm, state: ShopScreenState): ShopScreenState {
  if (shopScreen.observe === undefined) throw new Error('shopScreen must define observe');
  return shopScreen.observe(vm, state, 0);
}

/** The one paint `paint(view, vm, state)` hands the view. */
function paintOf(vm: ShopScreenVm, state: ShopScreenState): ShopPaint {
  const out: ShopPaint[] = [];
  const view = {
    paint: (p: ShopPaint) => {
      out.push(p);
    },
  } as unknown as ShopView;
  if (shopScreen.paint === undefined) throw new Error('shopScreen must define paint');
  shopScreen.paint(view, vm, state);
  expect(out, 'exactly one paint').toHaveLength(1);
  return out[0] as ShopPaint;
}

const browse = (tab: ShopTab, activeKey: string | null): ShopPaint => ({
  tab,
  activeKey,
  description: undefined,
  prompt: null,
});
const qty = (tab: ShopTab, name: string, n: number): ShopPaint['prompt'] => ({
  kind: 'qty',
  tab,
  name,
  qty: n,
});
const confirm = (
  tab: ShopTab,
  name: string,
  n: number,
  gold: bigint,
  yes: boolean,
): ShopPaint['prompt'] => ({ kind: 'confirm', tab, name, qty: n, gold, yes });

const POP: ScreenResult = { kind: 'pop' };

describe('shopScreen — browse (ctl-8a, CTL8A.2)', () => {
  it('CTL8A-2-OPENS-ON-BUY: the frame opens on the Buy tab on its first row with nothing described or prompted; LB/RB switch tabs (a fresh press wraps, a repeat clamps) and each tab keeps its own row; the list wraps on a fresh Up; Left and Right do nothing; the view model is the bound shop`s', () => {
    // WRONG IMPL KILLED: a shop that opens on Sell, on no row or on the last row; a tab switch
    // that resets the other tab's row (the player loses their place) or carries the row index
    // across; tab keys that wrap on a repeat (a held PageDown flickers between tabs); Left/Right
    // read as tab keys; a view model built from the first shop (shop 0 sorts first here) instead
    // of the bound one, or from another identity's bag and wallet; and a missing nav mark.
    expect(shopScreen.nav, 'the frame takes the D-pad').toBe(true);
    const w = world();
    const vm = vmOf(w);
    expect(vm.shop, 'the bound shop`s legacy view model').toEqual(
      buildShopViewModelForShop(3, SHOPS, STOCK, defsOf(w.defs), [...w.inventory], w.wallet),
    );

    const opened = shopScreen.init(vm);
    expect(paintOf(vm, opened), 'Buy, its first row').toEqual(browse('buy', buyKey(vm, 0)));

    let s = swallowed(vm, opened, ['Down']);
    expect(paintOf(vm, s)).toEqual(browse('buy', buyKey(vm, 1)));
    s = swallowed(vm, s, ['RB']);
    expect(paintOf(vm, s), 'RB: Sell, its first row').toEqual(browse('sell', sellKey(vm, 0)));
    s = swallowed(vm, s, ['Down']);
    expect(paintOf(vm, s)).toEqual(browse('sell', sellKey(vm, 1)));
    s = swallowed(vm, s, ['LB']);
    expect(paintOf(vm, s), 'LB: Buy kept its row').toEqual(browse('buy', buyKey(vm, 1)));
    s = swallowed(vm, s, ['RB']);
    expect(paintOf(vm, s), 'RB: Sell kept its row').toEqual(browse('sell', sellKey(vm, 1)));

    expect(paintOf(vm, swallowed(vm, opened, ['LB'])).tab, 'a fresh LB on Buy wraps').toBe('sell');
    const onSell = swallowed(vm, opened, ['RB']);
    expect(paintOf(vm, swallowed(vm, onSell, ['RB'])).tab, 'a fresh RB on Sell wraps').toBe('buy');
    expect(paintOf(vm, swallowed(vm, opened, [rep('LB')])).tab, 'a repeat LB on Buy stays').toBe(
      'buy',
    );
    expect(paintOf(vm, swallowed(vm, opened, [rep('RB')])).tab, 'a repeat RB moves').toBe('sell');
    expect(paintOf(vm, swallowed(vm, onSell, [rep('RB')])).tab, 'a repeat RB on Sell stays').toBe(
      'sell',
    );

    expect(paintOf(vm, swallowed(vm, opened, ['Up'])), 'a fresh Up wraps to the last row').toEqual(
      browse('buy', buyKey(vm, 3)),
    );
    expect(paintOf(vm, swallowed(vm, opened, [rep('Up')])), 'a repeat Up stays').toEqual(
      browse('buy', buyKey(vm, 0)),
    );
    for (const input of ['Left', 'Right', rep('Left'), rep('Right')] as const) {
      expect(paintOf(vm, swallowed(vm, opened, [input])), `${label(input)} does nothing`).toEqual(
        browse('buy', buyKey(vm, 0)),
      );
    }
  });

  it('CTL8A-2-DESCRIPTION: nothing is described before Y; Y shows the cursor item`s description, and null (the "none" mark) when its description is blank or its definition is missing; a cursor move or a tab switch clears it; it works on the Sell tab', () => {
    // WRONG IMPL KILLED: a description shown before Y; one that survives a move or a tab switch
    // (stale text under another item); a blank description painted as '   ' or '' instead of the
    // none mark (the view writes "—" for null); a missing definition painted as undefined (Y
    // would look like it did nothing); another row's description; and Y on Sell describing the
    // Buy tab's cursor row.
    const vm = vmOf(world());
    const opened = shopScreen.init(vm);
    expect(paintOf(vm, opened).description, 'nothing before Y').toBeUndefined();

    const y = press(vm, opened, 'Y');
    expect(y.result).toBe('consumed');
    expect(paintOf(vm, y.state), 'Y describes Bait, nothing else changes').toEqual({
      ...browse('buy', buyKey(vm, 0)),
      description: BAIT.description,
    });
    const potion = swallowed(vm, y.state, ['Down']);
    expect(paintOf(vm, potion).description, 'a move clears it').toBeUndefined();
    expect(paintOf(vm, swallowed(vm, potion, ['Y'])).description).toBe(POTION.description);
    const berry = swallowed(vm, potion, ['Down', 'Y']);
    expect(paintOf(vm, berry).description, 'a blank description: the none mark').toBeNull();
    const unknown = swallowed(vm, potion, ['Down', 'Down', 'Y']);
    expect(paintOf(vm, unknown).activeKey, 'fixture: item 12').toBe(buyKey(vm, 3));
    expect(paintOf(vm, unknown).description, 'no definition: the none mark').toBeNull();

    const switched = swallowed(vm, y.state, ['RB']);
    expect(paintOf(vm, switched).description, 'a tab switch clears it').toBeUndefined();
    const relic = swallowed(vm, switched, ['Down', 'Y']);
    expect(paintOf(vm, relic), 'Y on Sell describes the Sell row').toEqual({
      ...browse('sell', sellKey(vm, 1)),
      description: RELIC.description,
    });
  });

  it('CTL8A-2-UNSELLABLE: on the Sell tab A on an item the shop will not buy, or on a stack of 0, opens nothing and issues nothing, while the cursor still reaches and passes it; a sellable row opens the quantity row', () => {
    // WRONG IMPL KILLED: a quantity row opened for an unsellable item (its confirm would send a
    // sale the server refuses), a stack of 0 treated as sellable (its quantity range 1..0 is
    // empty), and an unsellable row dropped from the list (the player could not see why it
    // cannot be sold) or made a wall the cursor cannot pass.
    const vm = vmOf(world({ inventory: [bag(101n, 7, 5), bag(102n, 9, 2), bag(103n, 8, 0)] }));
    const relic = swallowed(vm, shopScreen.init(vm), ['RB', 'Down']);
    expect(paintOf(vm, relic).activeKey, 'fixture: on the Relic').toBe(sellKey(vm, 1));
    const a = press(vm, relic, 'A');
    expect(a.result, 'A on an unsellable item').toBe('consumed');
    expect(paintOf(vm, a.state), 'no prompt').toEqual(browse('sell', sellKey(vm, 1)));

    const empty = swallowed(vm, relic, ['Down']);
    expect(paintOf(vm, empty).activeKey, 'fixture: on the empty Berry stack').toBe(sellKey(vm, 2));
    const b = press(vm, empty, 'A');
    expect(b.result, 'A on a stack of 0').toBe('consumed');
    expect(paintOf(vm, b.state)).toEqual(browse('sell', sellKey(vm, 2)));

    const bait = swallowed(vm, empty, ['Down', 'A']);
    expect(paintOf(vm, bait).prompt, 'control: Bait wraps round and sells').toEqual(
      qty('sell', 'Bait', 1),
    );
  });
});

describe('shopScreen — quantity and confirm (ctl-8a, CTL8A.2)', () => {
  it('CTL8A-2-QTY-ROW: A on a row opens the quantity row at 1; Left/Right change it by one, repeats included, clamped to 1..SHOP_BUY_MAX on Buy and 1..the owned count on Sell; Up, Down, LB, RB and Y leave it as it is; a repeat A opens nothing; B goes back to the list with no command', () => {
    // WRONG IMPL KILLED: a quantity that starts at 0 or at the last quantity used; a step of more
    // than one; a quantity that wraps (Left at 1 jumping to 99 would buy 99 Bait in one press) or
    // runs past 99 or past what the player owns (the server refuses the sale); repeats ignored
    // (holding Right must count up); Up/Down moving the list or LB/RB switching tab under the open
    // row; a repeat A that opens it; and a B that closes the shop or issues a command.
    expect(SHOP_BUY_MAX, 'the Buy cap').toBe(99);
    const vm = vmOf(world());
    const opened = shopScreen.init(vm);
    const repeatA = press(vm, opened, rep('A'));
    expect(repeatA.result).toBe('consumed');
    expect(paintOf(vm, repeatA.state).prompt, 'a repeat A opens nothing').toBeNull();

    let s = swallowed(vm, opened, ['A']);
    expect(paintOf(vm, s), 'the quantity row at 1, on the cursor row').toEqual({
      ...browse('buy', buyKey(vm, 0)),
      prompt: qty('buy', 'Bait', 1),
    });
    s = swallowed(vm, s, ['Right']);
    expect(paintOf(vm, s).prompt).toEqual(qty('buy', 'Bait', 2));
    s = swallowed(vm, s, [rep('Right')]);
    expect(paintOf(vm, s).prompt, 'a repeat counts').toEqual(qty('buy', 'Bait', 3));
    s = swallowed(vm, s, ['Left', rep('Left')]);
    expect(paintOf(vm, s).prompt).toEqual(qty('buy', 'Bait', 1));
    s = swallowed(vm, s, ['Left', rep('Left')]);
    expect(paintOf(vm, s).prompt, 'clamped at 1, never wrapped').toEqual(qty('buy', 'Bait', 1));

    const held: Input[] = Array.from(
      { length: SHOP_BUY_MAX + 2 },
      (_, i): Input => (i === 0 ? 'Right' : rep('Right')),
    );
    const top = swallowed(vm, s, held);
    expect(paintOf(vm, top).prompt, 'clamped at SHOP_BUY_MAX').toEqual(qty('buy', 'Bait', 99));
    expect(paintOf(vm, swallowed(vm, top, ['Right'])).prompt).toEqual(qty('buy', 'Bait', 99));

    const inert = paintOf(vm, top);
    for (const input of ['Up', 'Down', rep('Down'), 'LB', 'RB', 'Y'] as const) {
      expect(paintOf(vm, swallowed(vm, top, [input])), `${label(input)} changes nothing`).toEqual(
        inert,
      );
    }

    const back = press(vm, top, 'B');
    expect(back.result, 'B issues nothing').toBe('consumed');
    expect(paintOf(vm, back.state), 'back on the list, same row').toEqual(
      browse('buy', buyKey(vm, 0)),
    );

    // Sell: the player owns 5 Bait.
    let t = swallowed(vm, opened, ['RB', 'A']);
    expect(paintOf(vm, t).prompt).toEqual(qty('sell', 'Bait', 1));
    t = swallowed(vm, t, ['Left']);
    expect(paintOf(vm, t).prompt, 'Sell is clamped at 1 too').toEqual(qty('sell', 'Bait', 1));
    t = swallowed(vm, t, [
      'Right',
      rep('Right'),
      rep('Right'),
      rep('Right'),
      rep('Right'),
      'Right',
    ]);
    expect(paintOf(vm, t).prompt, 'clamped at the 5 owned').toEqual(qty('sell', 'Bait', 5));
  });

  it('CTL8A-2-CONFIRM-DEFAULTS: A on the quantity row opens the Yes/No confirm for that item and quantity with the total price: Buy defaults to Yes, Sell to No; a fresh Up or Down flips the answer', () => {
    // WRONG IMPL KILLED: one default for both (a Sell confirm on Yes sells on a double-tap of A),
    // the defaults swapped, a confirm that forgets the chosen quantity or names another row, a
    // price shown per unit instead of the total, and Up/Down that cannot change the answer.
    const vm = vmOf(world());
    const buy = swallowed(vm, shopScreen.init(vm), ['A', 'Right', 'Right', 'A']);
    expect(paintOf(vm, buy), 'Buy 3 Bait at 20 each: Yes').toEqual({
      ...browse('buy', buyKey(vm, 0)),
      prompt: confirm('buy', 'Bait', 3, 60n, true),
    });
    const flipped = swallowed(vm, buy, ['Down']);
    expect(paintOf(vm, flipped).prompt).toEqual(confirm('buy', 'Bait', 3, 60n, false));
    expect(paintOf(vm, swallowed(vm, flipped, ['Up'])).prompt).toEqual(
      confirm('buy', 'Bait', 3, 60n, true),
    );
    expect(paintOf(vm, swallowed(vm, buy, ['Down', 'Down'])).prompt).toEqual(
      confirm('buy', 'Bait', 3, 60n, true),
    );

    const potion = swallowed(vm, shopScreen.init(vm), ['Down', 'A', 'A']);
    expect(paintOf(vm, potion).prompt, 'another row, its own price').toEqual(
      confirm('buy', 'Potion', 1, 50n, true),
    );

    const sell = swallowed(vm, shopScreen.init(vm), ['RB', 'A', 'Right', 'A']);
    expect(paintOf(vm, sell), 'Sell 2 Bait at 15 each: No').toEqual({
      ...browse('sell', sellKey(vm, 0)),
      prompt: confirm('sell', 'Bait', 2, 30n, false),
    });
    expect(paintOf(vm, swallowed(vm, sell, ['Up'])).prompt).toEqual(
      confirm('sell', 'Bait', 2, 30n, true),
    );
  });

  it('CTL8A-2-CONFIRM-COMMAND: Yes issues buy { shopId, itemId, qty } (shop 0 included) or sell { itemId, qty } with the chosen quantity and returns to the list on the same row; No and B issue nothing and return to the list; B on the list pops the frame; Start and Select keep their meaning', () => {
    // WRONG IMPL KILLED: a buy that sends qty 1 whatever was chosen, the row's shopItemId as the
    // itemId, or a default shop id (shop 0 is falsy); a sell carrying a shop id or the stack's
    // invId; a confirm left open after Yes (the next A would buy again); a No that buys or sells;
    // a B at the confirm that closes the shop; and a B on the list that is swallowed (no way out).
    const vm = vmOf(world());
    const buyPotion = swallowed(vm, shopScreen.init(vm), ['Down', 'A', 'Right', 'Right', 'A']);
    const bought = press(vm, buyPotion, 'A');
    expect(bought.result).toEqual({ kind: 'buy', shopId: 3, itemId: 10, qty: 3 });
    expect(paintOf(vm, bought.state), 'back on the list, on Potion').toEqual(
      browse('buy', buyKey(vm, 1)),
    );

    const zero = vmOf(world({ shopId: 0 }));
    expect(rows(zero).shopId, 'fixture: shop 0 is bound').toBe(0);
    const atZero = swallowed(zero, shopScreen.init(zero), ['A', 'A']);
    expect(press(zero, atZero, 'A').result).toEqual({ kind: 'buy', shopId: 0, itemId: 7, qty: 1 });

    const sellBait = swallowed(vm, shopScreen.init(vm), ['RB', 'A', 'Right', 'A', 'Down']);
    expect(paintOf(vm, sellBait).prompt, 'fixture: Yes chosen').toEqual(
      confirm('sell', 'Bait', 2, 30n, true),
    );
    const sold = press(vm, sellBait, 'A');
    expect(sold.result).toEqual({ kind: 'sell', itemId: 7, qty: 2 });
    expect(paintOf(vm, sold.state), 'back on the list, on Bait').toEqual(
      browse('sell', sellKey(vm, 0)),
    );

    const no = swallowed(vm, shopScreen.init(vm), ['A', 'A', 'Down']);
    const declined = press(vm, no, 'A');
    expect(declined.result, 'A on No issues nothing').toBe('consumed');
    expect(paintOf(vm, declined.state)).toEqual(browse('buy', buyKey(vm, 0)));
    const sellNo = swallowed(vm, shopScreen.init(vm), ['RB', 'A', 'A']);
    expect(press(vm, sellNo, 'A').result, 'A on Sell`s default No issues nothing').toBe('consumed');

    const atConfirm = swallowed(vm, shopScreen.init(vm), ['A', 'A']);
    const backed = press(vm, atConfirm, 'B');
    expect(backed.result, 'B at the confirm issues nothing').toBe('consumed');
    expect(paintOf(vm, backed.state)).toEqual(browse('buy', buyKey(vm, 0)));
    expect(press(vm, backed.state, 'B').result, 'B on the list pops').toEqual(POP);
    expect(press(vm, atConfirm, 'Start').result).toEqual({ kind: 'popToBase' });
    expect(press(vm, atConfirm, 'Select').result).toEqual({ kind: 'toggleHelp' });
  });

  it('CTL8A-2-CONFIRM-NO-REPEAT-FLIP: at the confirm a repeat Up or Down is swallowed and never flips the answer (Buy stays Yes and A buys; Sell stays No and A sells nothing); Left, Right, LB, RB and Y change nothing', () => {
    // WRONG IMPL KILLED: a confirm that toggles on the auto-repeat of an arrow still held from the
    // quantity row (the held key flips the default, so a Sell's safe No becomes Yes and the next A
    // sells), and a confirm that reads Left/Right as Yes/No or lets LB/RB switch tab under it.
    const vm = vmOf(world());
    const buy = swallowed(vm, shopScreen.init(vm), ['A', 'A']);
    const held = swallowed(vm, buy, [rep('Down'), rep('Up'), rep('Down'), rep('Down')]);
    expect(paintOf(vm, held).prompt, 'Buy still on Yes').toEqual(
      confirm('buy', 'Bait', 1, 20n, true),
    );
    expect(press(vm, held, 'A').result).toEqual({ kind: 'buy', shopId: 3, itemId: 7, qty: 1 });

    const sell = swallowed(vm, shopScreen.init(vm), ['RB', 'A', 'A']);
    const heldSell = swallowed(vm, sell, [rep('Up'), rep('Down'), rep('Up')]);
    expect(paintOf(vm, heldSell).prompt, 'Sell still on No').toEqual(
      confirm('sell', 'Bait', 1, 15n, false),
    );
    expect(press(vm, heldSell, 'A').result, 'and A sells nothing').toBe('consumed');

    const inert = paintOf(vm, buy);
    for (const input of ['Left', 'Right', rep('Right'), 'LB', 'RB', 'Y'] as const) {
      expect(paintOf(vm, swallowed(vm, buy, [input])), `${label(input)} changes nothing`).toEqual(
        inert,
      );
    }
  });
});

describe('shopScreen — settle and no shop (ctl-8a, CTL8A.2)', () => {
  it('CTL8A-2-SETTLE: observe answers the SAME state when nothing changed; a row that vanishes under the quantity row or the confirm returns to the list with the cursor on the first row; a sell quantity above a shrunken stack drops to it; a stack emptied under the quantity row returns to the list; a cursor with no row is seated on the first row once rows arrive', () => {
    // WRONG IMPL KILLED: an observe that answers a new object every batch (the view repaints at
    // batch rate); one that never re-seats (the cursor on a sold-out row, an A that buys stock that
    // is gone); a confirm left open over a vanished row (Yes would send a buy for it); a sell
    // quantity left above what the player owns (the server refuses); a quantity row left open on
    // an emptied stack; and a shop opened before its rows arrived that never gets a cursor.
    const w = world();
    const vm = vmOf(w);
    const opened = shopScreen.init(vm);
    expect(observe(vmOf(w), opened), 'nothing changed: the same object').toBe(opened);
    const onSell = swallowed(vm, opened, ['RB', 'Down']);
    expect(observe(vmOf(w), onSell), 'a moved cursor, nothing changed').toBe(onSell);
    const inQty = swallowed(vm, opened, ['A', 'Right']);
    expect(observe(vmOf(w), inQty), 'an open quantity row, nothing changed').toBe(inQty);
    const inConfirm = swallowed(vm, inQty, ['A']);
    expect(observe(vmOf(w), inConfirm), 'an open confirm, nothing changed').toBe(inConfirm);

    // Potion sells out while its quantity row is open.
    const potionQty = swallowed(vm, opened, ['Down', 'A']);
    const soldOut = vmOf({ ...w, stock: STOCK.filter((r) => r.shopItemId !== 32n) });
    const afterSoldOut = observe(soldOut, potionQty);
    expect(afterSoldOut).not.toBe(potionQty);
    expect(paintOf(soldOut, afterSoldOut), 'back on the list, first row').toEqual(
      browse('buy', buyKey(soldOut, 0)),
    );

    // The Bait stack vanishes under the Sell confirm.
    const sellConfirm = swallowed(vm, opened, ['RB', 'A', 'A']);
    const noBait = vmOf({ ...w, inventory: [bag(102n, 9, 2), bag(103n, 8, 1)] });
    const afterNoBait = observe(noBait, sellConfirm);
    expect(afterNoBait).not.toBe(sellConfirm);
    expect(paintOf(noBait, afterNoBait), 'back on the Sell list, first row').toEqual(
      browse('sell', sellKey(noBait, 0)),
    );

    // The Bait stack shrinks from 5 to 2 under a sell quantity of 4.
    const sellFour = swallowed(vm, opened, ['RB', 'A', 'Right', 'Right', 'Right']);
    expect(paintOf(vm, sellFour).prompt, 'fixture: 4 chosen').toEqual(qty('sell', 'Bait', 4));
    const shrunk = vmOf({ ...w, inventory: [bag(101n, 7, 2), bag(102n, 9, 2), bag(103n, 8, 1)] });
    const afterShrink = observe(shrunk, sellFour);
    expect(afterShrink).not.toBe(sellFour);
    expect(paintOf(shrunk, afterShrink).prompt, 'dropped to the 2 owned').toEqual(
      qty('sell', 'Bait', 2),
    );

    // The Berry stack empties (count 0) under its quantity row.
    const berryQty = swallowed(vm, opened, ['RB', 'Down', 'Down', 'A']);
    expect(paintOf(vm, berryQty).prompt, 'fixture: selling Berry').toEqual(qty('sell', 'Berry', 1));
    const emptied = vmOf({ ...w, inventory: [bag(101n, 7, 5), bag(102n, 9, 2), bag(103n, 8, 0)] });
    const afterEmpty = observe(emptied, berryQty);
    expect(afterEmpty).not.toBe(berryQty);
    expect(paintOf(emptied, afterEmpty), 'back on the list, still on Berry').toEqual(
      browse('sell', sellKey(emptied, 2)),
    );

    // Opened before the shop rows arrived: no row under the cursor, seated once they come.
    const early = world({ shops: [] });
    const before = vmOf(early);
    expect(before.shop.kind, 'fixture: the bound shop is not loaded yet').toBe('no-shop');
    const blind = shopScreen.init(before);
    expect(paintOf(before, blind)).toEqual(browse('buy', null));
    early.shops = SHOPS;
    const arrived = vmOf(early);
    const seated = observe(arrived, blind);
    expect(seated).not.toBe(blind);
    expect(paintOf(arrived, seated), 'seated on the first row').toEqual(
      browse('buy', buyKey(arrived, 0)),
    );
    expect(observe(vmOf(early), seated), 'and the same object after that').toBe(seated);
  });

  it('CTL8A-2-NO-SHOP: with no bound shop (ctx.shopId null) the view model is the no-shop one with the wallet balance, nothing is under the cursor, A and Y are swallowed and describe nothing, B pops and Start / Select keep their meaning; a bound id that is not loaded behaves the same', () => {
    // WRONG IMPL KILLED: a no-shop frame that falls back to the first shop (a buy at a shop the
    // player never opened), shop 0 picked for a null id (the falsy-0 trap in reverse), an A that
    // throws or opens a quantity row with no item, a Y that paints the none mark with no row, a B
    // that is swallowed, and a no-shop view model without the balance the shell reads.
    const w = world({ shopId: null });
    const vm = vmOf(w);
    expect(vm.shop, 'the no-shop view model, balance included').toEqual(
      buildShopViewModel([], [], defsOf(w.defs), [], w.wallet),
    );
    expect(vm.shop.balance.kind, 'fixture: the wallet is known').toBe('known');
    const opened = shopScreen.init(vm);
    expect(paintOf(vm, opened)).toEqual(browse('buy', null));
    for (const input of ['A', 'Y', 'Up', 'Down', 'Left', 'Right'] as const) {
      const step = press(vm, opened, input);
      expect(step.result, `${input} with no shop`).toBe('consumed');
      expect(paintOf(vm, step.state), `${input} opens and describes nothing`).toEqual(
        browse('buy', null),
      );
    }
    expect(press(vm, opened, 'B').result, 'B pops').toEqual(POP);
    expect(press(vm, opened, 'Start').result).toEqual({ kind: 'popToBase' });
    expect(press(vm, opened, 'Select').result).toEqual({ kind: 'toggleHelp' });

    const unknown = vmOf(world({ shopId: 42 }));
    expect(unknown.shop.kind, 'an id that is not loaded: no shop').toBe('no-shop');
    const blank = shopScreen.init(unknown);
    expect(press(unknown, blank, 'A').result).toBe('consumed');
    expect(press(unknown, blank, 'B').result).toEqual(POP);
  });
});

describe('shopScreen — review-lens settle cases (ctl-8a, CTL8A.2)', () => {
  // The quantity row and the confirm carry the row's name and unit price as last painted. A
  // batch that changes the live row's buyPrice (Buy) or sellPrice / name (Sell) makes observe
  // answer a NEW state that paints the new facts; with nothing changed it is the SAME object. A
  // press that arrives before any observe has seen the change only paints it ('consumed'); the
  // next A acts.

  it('CTL8A-2-SETTLE-PRICE: a price or name that changes under an open quantity row or confirm is repainted by observe, and the A that first sees the change only paints (Yes never sends at a price the player has not seen)', () => {
    // WRONG IMPL KILLED: a confirm that keeps the first price (or name) forever, so the player
    // confirms "Buy 1 Bait for 20 gold?" and is charged 2000; an A that sends at once at a price
    // the player has not seen (the batch changed the row between the last paint and the press);
    // and an observe that answers a new object every batch (the frame repaints at batch rate).
    const w = world();
    const vm = vmOf(w);
    const confirmAt20 = swallowed(vm, shopScreen.init(vm), ['A', 'A']);
    expect(paintOf(vm, confirmAt20).prompt, 'fixture: Buy 1 Bait at 20').toEqual(
      confirm('buy', 'Bait', 1, 20n, true),
    );
    expect(observe(vmOf(w), confirmAt20), 'nothing changed: the same object').toBe(confirmAt20);

    const dearer: ShopWorld = {
      ...w,
      stock: STOCK.map((row) => (row.shopItemId === 31n ? { ...row, buyPrice: 2000n } : row)),
    };
    const vm2000 = vmOf(dearer);

    // (a) The batch's observe repaints the confirm; the player then sees 2000 and A buys.
    const observed = observe(vm2000, confirmAt20);
    expect(observed, 'the price changed: a new state').not.toBe(confirmAt20);
    expect(paintOf(vm2000, observed).prompt, 'the new total is painted').toEqual(
      confirm('buy', 'Bait', 1, 2000n, true),
    );
    expect(observe(vmOf(dearer), observed), 'unchanged since: the same object').toBe(observed);
    expect(press(vm2000, observed, 'A').result, 'A after the repaint buys').toEqual({
      kind: 'buy',
      shopId: 3,
      itemId: 7,
      qty: 1,
    });

    // (b) No observe between the change and the press: that A only paints, the next one buys.
    const first = press(vm2000, confirmAt20, 'A');
    expect(first.result, 'the A that first sees 2000 sends nothing').toBe('consumed');
    expect(paintOf(vm2000, first.state).prompt, 'and paints the new total').toEqual(
      confirm('buy', 'Bait', 1, 2000n, true),
    );
    expect(press(vm2000, first.state, 'A').result, 'the next A buys').toEqual({
      kind: 'buy',
      shopId: 3,
      itemId: 7,
      qty: 1,
    });

    // Under an open quantity row: observe answers a new state, and the confirm it opens shows
    // the new price.
    const qtyOfTwo = swallowed(vm, shopScreen.init(vm), ['A', 'Right']);
    expect(observe(vmOf(w), qtyOfTwo), 'nothing changed: the same object').toBe(qtyOfTwo);
    const qtyObserved = observe(vm2000, qtyOfTwo);
    expect(qtyObserved, 'the price changed under the quantity row: a new state').not.toBe(qtyOfTwo);
    expect(paintOf(vm2000, qtyObserved).prompt).toEqual(qty('buy', 'Bait', 2));
    expect(paintOf(vm2000, swallowed(vm2000, qtyObserved, ['A'])).prompt).toEqual(
      confirm('buy', 'Bait', 2, 4000n, true),
    );

    // Sell: the item is renamed under an open confirm on Yes.
    const sellYes = swallowed(vm, shopScreen.init(vm), ['RB', 'A', 'A', 'Down']);
    expect(paintOf(vm, sellYes).prompt, 'fixture: Sell 1 Bait, Yes').toEqual(
      confirm('sell', 'Bait', 1, 15n, true),
    );
    expect(observe(vmOf(w), sellYes), 'nothing changed: the same object').toBe(sellYes);
    const renamed = vmOf({
      ...w,
      defs: [def(7, 'Golden Bait', BAIT.description, 15n), BERRY, RELIC, POTION],
    });
    const renamedObserved = observe(renamed, sellYes);
    expect(renamedObserved, 'the name changed: a new state').not.toBe(sellYes);
    expect(paintOf(renamed, renamedObserved).prompt, 'the new name is painted').toEqual(
      confirm('sell', 'Golden Bait', 1, 15n, true),
    );
    const firstSell = press(renamed, sellYes, 'A');
    expect(firstSell.result, 'the A that first sees the new name sends nothing').toBe('consumed');
    expect(paintOf(renamed, firstSell.state).prompt).toEqual(
      confirm('sell', 'Golden Bait', 1, 15n, true),
    );
    expect(press(renamed, firstSell.state, 'A').result, 'the next A sells').toEqual({
      kind: 'sell',
      itemId: 7,
      qty: 1,
    });

    // Sell: the sell price changes under the confirm.
    const pricier = vmOf({
      ...w,
      defs: [def(7, 'Bait', BAIT.description, 40n), BERRY, RELIC, POTION],
    });
    const pricierObserved = observe(pricier, sellYes);
    expect(pricierObserved, 'the sell price changed: a new state').not.toBe(sellYes);
    expect(paintOf(pricier, pricierObserved).prompt).toEqual(confirm('sell', 'Bait', 1, 40n, true));
  });

  it('CTL8A-2-SETTLE-INFO: a cursor re-seated by observe (its row gone) drops the Y description; an unchanged cursor keeps it', () => {
    // WRONG IMPL KILLED: a description that survives the re-seat (the slot would describe Potion
    // while the cursor sits on Bait), and the reverse, a description dropped by a batch that left
    // the cursor's row in place.
    const w = world();
    const vm = vmOf(w);
    const onPotion = swallowed(vm, shopScreen.init(vm), ['Down', 'Y']);
    expect(paintOf(vm, onPotion), 'fixture: Potion described').toEqual({
      ...browse('buy', buyKey(vm, 1)),
      description: POTION.description,
    });

    const soldOut = vmOf({ ...w, stock: STOCK.filter((row) => row.shopItemId !== 32n) });
    const reseated = observe(soldOut, onPotion);
    expect(reseated, 'the cursor`s row is gone: a new state').not.toBe(onPotion);
    expect(paintOf(soldOut, reseated), 'on the first row, nothing described').toEqual(
      browse('buy', buyKey(soldOut, 0)),
    );

    expect(observe(vmOf(w), onPotion), 'a batch that changes nothing: the same object').toBe(
      onPotion,
    );
    expect(paintOf(vm, onPotion).description, 'and the description stays').toBe(POTION.description);

    // Another row going away leaves the cursor's row, and its description, in place.
    const onBait = swallowed(vm, shopScreen.init(vm), ['Y']);
    const keptBait = observe(soldOut, onBait);
    expect(keptBait, 'the cursor did not move: the same object').toBe(onBait);
    expect(paintOf(soldOut, keptBait), 'Bait still described').toEqual({
      ...browse('buy', buyKey(soldOut, 0)),
      description: BAIT.description,
    });
  });
});
