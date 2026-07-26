// @vitest-environment happy-dom
// ui/shopView.test.ts — ux2 (ADR-0154) RED tests for the shop gold readout.
//
// SOURCE OF TRUTH: ux2 build plan v3 §T6 ("shopView") + "Client unit tests".
// Tests are INTENTIONALLY RED until shopView.ts creates and writes #shop-balance.
// Do NOT edit them to match a buggy implementation — correct from the plan only.
//
// CONTRACT UNDER TEST (§T6)
//   - The CONSTRUCTOR creates `<p id="shop-balance">` UNCONDITIONALLY and appends it
//     into `#shop-overlay` AFTER `#shop-title`. (index.html is FORBIDDEN in this
//     slice, so the node must be JS-created — precedent ADR-0085 `#status`.)
//   - `render(vm)`, BEFORE the `no-shop` early return (shopView.ts:73):
//       known = vm.balance.kind === 'known'
//       textContent = known ? vm.balance.label : ''
//       hidden      = !known
//       dataset.balanceState = vm.balance.kind
//   - No formatting/arithmetic in the shell — the label comes from the view model.
//
// WHY THIS FILE IS THE REAL GATE (§T6): the eval check V (a source scan for
// `balance.amount`) alone passes THREE broken shells —
//   (1) the write placed AFTER the `no-shop` early return,
//   (2) a dead read (`const _ = vm.balance.label;`) with no DOM write,
//   (3) an orphaned node that is created but never appended to the overlay.
// Each assertion below is aimed at one of those.
//
// Pattern follows tradeView.test.ts: @vitest-environment happy-dom, DOM built
// before construction, vi.fn() callbacks, no SDK / wasm / network.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShopScreenViewModel } from './shopModel';
import type { ShopCallbacks } from './shopView';
import { ShopView } from './shopView';

// ---------------------------------------------------------------------------
// DOM fixture — mirrors client/index.html:23-28 EXACTLY as it exists today.
// Deliberately does NOT contain #shop-balance: the constructor must create it
// (index.html is outside this slice's touch-set, so a fixture that pre-seeds the
// node would make the "constructor creates it" requirement vacuous).
// ---------------------------------------------------------------------------
// happy-dom shares ONE document across the whole file, and every test here is RED
// by construction — a failed test would otherwise leave its overlay attached and the
// NEXT constructor's getElementById('shop-overlay') would bind to that stale node,
// producing cascading failures that hide the real reason. Wipe the body each time.
beforeEach(() => {
  document.body.innerHTML = '';
});

function mountShopOverlay(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.id = 'shop-overlay';
  overlay.style.display = 'none';

  const title = document.createElement('div');
  title.id = 'shop-title';
  overlay.appendChild(title);

  const forSale = document.createElement('ul');
  forSale.id = 'shop-for-sale';
  overlay.appendChild(forSale);

  const inventory = document.createElement('ul');
  inventory.id = 'shop-inventory';
  overlay.appendChild(inventory);

  const feedback = document.createElement('div');
  feedback.id = 'shop-feedback';
  overlay.appendChild(feedback);

  document.body.appendChild(overlay);
  return overlay;
}

function removeOverlay(overlay: HTMLElement): void {
  if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
}

function makeCallbacks(): ShopCallbacks {
  return { onBuy: vi.fn(), onSell: vi.fn() };
}

// ---------------------------------------------------------------------------
// View-model factories. `balance` is present on BOTH variants (§T5).
// ---------------------------------------------------------------------------

function knownBalance(amount: bigint): ShopScreenViewModel['balance'] {
  return { kind: 'known', amount, label: `Gold: ${amount}` };
}

function shopVm(balance: ShopScreenViewModel['balance']): ShopScreenViewModel {
  return {
    kind: 'shop',
    shopId: 1,
    shopName: 'General Store',
    forSale: [],
    forSaleByPlayer: [],
    balance,
  };
}

function noShopVm(balance: ShopScreenViewModel['balance']): ShopScreenViewModel {
  return { kind: 'no-shop', balance };
}

// ---------------------------------------------------------------------------
// [ux2-V-a] The node exists, is a DESCENDANT of #shop-overlay, and shows the label
// ---------------------------------------------------------------------------

describe('ShopView [ux2-V-a]: #shop-balance is created inside #shop-overlay and shows the label', () => {
  it('[ux2-V-a] BITES: after render(shopVm), #shop-balance is a descendant of #shop-overlay with the vm label and hidden=false', () => {
    // Kills THREE broken shells:
    //   (1) ORPHANED NODE — `document.createElement('p')` with no appendChild. The
    //       element then has textContent set correctly but `overlay.contains(el)` is
    //       false and `getElementById` returns null, so the player never sees it.
    //       A textContent-only assertion on a held reference would pass such a shell;
    //       the `.contains()` assertion is what makes this bite.
    //   (2) DEAD READ — `const _ = vm.balance.label;` with no DOM write: textContent
    //       stays '' and the label assertion fails.
    //   (3) SHELL FORMATTING — a shell that recomputes the string from
    //       `vm.balance.amount` can drift from the model's label; the equality is
    //       against `vm.balance.label`, the single source of truth.
    const overlay = mountShopOverlay();
    const view = new ShopView(makeCallbacks());

    // §T6: the constructor creates the node UNCONDITIONALLY, before any render.
    const beforeRender = document.getElementById('shop-balance');
    expect(beforeRender).not.toBeNull();
    expect(overlay.contains(beforeRender)).toBe(true);

    view.show();
    const vm = shopVm(knownBalance(123n));
    view.render(vm);

    const el = document.getElementById('shop-balance');
    expect(el).not.toBeNull();
    // Descendant of the overlay it belongs to — not floating loose in <body>, not orphaned.
    expect(overlay.contains(el)).toBe(true);
    expect(el!.textContent).toBe(
      (vm.balance as { readonly label: string }).label, // 'Gold: 123'
    );
    expect((el as HTMLElement).hidden).toBe(false);
    expect((el as HTMLElement).dataset.balanceState).toBe('known');

    removeOverlay(overlay);
  });

  it('[ux2-V-a] BITES: #shop-balance is placed AFTER #shop-title in document order (§T6 placement)', () => {
    // §T6 pins the insertion point. Kills a shell that prepends the node (pushing the
    // gold readout above the shop's own heading) or appends it after #shop-feedback,
    // where it reads as part of the reducer feedback line.
    const overlay = mountShopOverlay();
    const view = new ShopView(makeCallbacks());
    view.render(shopVm(knownBalance(1n)));

    const title = document.getElementById('shop-title');
    const balance = document.getElementById('shop-balance');
    expect(title).not.toBeNull();
    expect(balance).not.toBeNull();

    const kids = [...overlay.children];
    expect(kids.indexOf(balance as Element)).toBeGreaterThan(kids.indexOf(title as Element));

    removeOverlay(overlay);
  });
});

// ---------------------------------------------------------------------------
// [ux2-V-b] THE LOAD-BEARING ONE — the balance is written BEFORE the no-shop
// early return (shopView.ts:73)
// ---------------------------------------------------------------------------

describe('ShopView [ux2-V-b]: the no-shop path still updates #shop-balance (write is BEFORE the early return)', () => {
  it('[ux2-V-b] BITES: render(noShopVm) with a DIFFERENT balance shows the NEW label', () => {
    // THE tooth §T6 calls out. `render()` returns early at shopView.ts:73 for
    // kind==='no-shop'. An implementation that appends the balance write to the BOTTOM
    // of render() (the natural place to put it) is skipped entirely on this path, so
    // the element keeps the STALE 'Gold: 123' from the previous render — the player
    // walks out of the shop, sells nothing, and the counter freezes at a wrong number.
    // Two renders with DIFFERENT amounts are required: a single no-shop render against
    // a pristine element would also pass a shell that never writes at all, since ''
    // could be mistaken for "correctly cleared".
    const overlay = mountShopOverlay();
    const view = new ShopView(makeCallbacks());
    view.show();

    // Render 1: in a shop, balance 123.
    view.render(shopVm(knownBalance(123n)));
    const el = document.getElementById('shop-balance');
    expect(el).not.toBeNull();
    expect(el!.textContent).toBe('Gold: 123'); // precondition

    // Render 2: no shop in range (KeyG pressed away from a shop, or the batch listener
    // fired before the shop rows arrived) — but the wallet is still known, at a NEW value.
    view.render(noShopVm(knownBalance(456n)));

    expect(el!.textContent).toBe('Gold: 456'); // NOT the stale 'Gold: 123'
    expect((el as HTMLElement).hidden).toBe(false);
    expect((el as HTMLElement).dataset.balanceState).toBe('known');

    removeOverlay(overlay);
  });

  it('[ux2-V-b] BITES: no-shop → known transition also flips hidden back to false', () => {
    // Same placement bug, seen through `hidden`: if the write sits after the early
    // return, an element left hidden=true by a previous `unknown` render stays hidden
    // forever on the no-shop path, and the balance is invisible even though it is known.
    const overlay = mountShopOverlay();
    const view = new ShopView(makeCallbacks());
    view.show();

    view.render(shopVm({ kind: 'unknown' }));
    const el = document.getElementById('shop-balance');
    expect(el).not.toBeNull();
    expect((el as HTMLElement).hidden).toBe(true); // precondition

    view.render(noShopVm(knownBalance(9n)));

    expect((el as HTMLElement).hidden).toBe(false);
    expect(el!.textContent).toBe('Gold: 9');

    removeOverlay(overlay);
  });
});

// ---------------------------------------------------------------------------
// [ux2-V-c] `unknown` ⇒ hidden and empty (never a misleading permanent readout)
// ---------------------------------------------------------------------------

describe('ShopView [ux2-V-c]: an unknown balance renders hidden with empty text', () => {
  it('[ux2-V-c] BITES: render with balance.kind "unknown" → hidden=true and textContent ""', () => {
    // §"Accepted residual risk" (b): until ux2b wires main.ts the 5th argument is never
    // passed, so `unknown` is the state this slice actually ships. It must render as
    // NOTHING — hidden, empty — rather than a misleading permanent 'Gold: —' or 'Gold: 0'.
    // Kills: a shell that renders a placeholder string for the unknown arm, and one that
    // only ever sets hidden=false.
    const overlay = mountShopOverlay();
    const view = new ShopView(makeCallbacks());
    view.show();

    view.render(shopVm({ kind: 'unknown' }));

    const el = document.getElementById('shop-balance');
    expect(el).not.toBeNull();
    expect((el as HTMLElement).hidden).toBe(true);
    expect(el!.textContent).toBe('');
    expect((el as HTMLElement).dataset.balanceState).toBe('unknown');

    removeOverlay(overlay);
  });

  it('[ux2-V-c] BITES: known → unknown transition CLEARS the stale text (no ghost balance)', () => {
    // On disconnect the store resets and the balance goes dark. A shell that only
    // writes on the `known` arm would leave the last-seen 'Gold: 123' on screen while
    // the client is disconnected — a stale number the player would act on.
    const overlay = mountShopOverlay();
    const view = new ShopView(makeCallbacks());
    view.show();

    view.render(shopVm(knownBalance(123n)));
    const el = document.getElementById('shop-balance');
    expect(el!.textContent).toBe('Gold: 123'); // precondition

    view.render(shopVm({ kind: 'unknown' }));

    expect(el!.textContent).toBe('');
    expect((el as HTMLElement).hidden).toBe(true);

    removeOverlay(overlay);
  });
});
