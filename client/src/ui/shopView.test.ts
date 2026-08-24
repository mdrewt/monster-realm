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
//
// ---------------------------------------------------------------------------
// m23-s3 ADDITION (2026-08-24) — overlay a11y wiring. ADDITIVE ONLY: nothing above was
// weakened or deleted; the mount helper gained the `role`/`aria-modal`/`tabindex` attributes
// client/index.html:29-30 has always shipped (see below), and a file-level a11y sweep was added.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M23-accessibility.spec.md §2.2, §6 (A11Y-13/14/16);
//   memory/projects/monster-realm-m23-s3-plan.md §0 F1/F2/F7, §1 D1/D2/D7/D8, §4, §7 A1/A3/A6/A7/A8;
//   memory/projects/gates/m23-s3.gates.md X1/X2/X3/X6/X8/X9; ADR-0205 D1-D4, A3.
//
// RED REASON (m23-s3): `client/src/ui/shopView.ts` DOES NOT CALL openOverlayA11y/closeOverlayA11y
// at all today — show() is a single `style.display = ''` (ui/shopView.ts:77-79). Every S3-* test
// below therefore fails now; every ux2 test above still passes.
//
// TWO ORACLES, BOTH REQUIRED (plan A3, measured by red-team):
//   * VALUE oracle  — `aria-label === t(OVERLAY_A11Y['shopView'].labelKey)`. `role`/`aria-modal`
//     are ALREADY static literals on the shell in client/index.html:29 (m23-s2), so asserting them
//     ALONE is VACUOUS: a view that calls nothing passes. They are asserted only alongside
//     aria-label, and their ABSENCE after close is the anti-vacuity partner (attack V1).
//   * MECHANISM oracle — `vi.mock('./overlayA11y', { spy: true })` records the calls AND calls
//     through to the real implementation, so a cheat that hand-writes the three attributes with the
//     correct copied literal (no trap, no return-focus record, no timer) still reds.
//
// TEST-ISOLATION DEVICE (plan A8 / V7, copied from ui/overlayA11y.test.ts:97-105): overlayA11y.ts
// holds ONE module-private Map and exports no reset hook, so the file-level beforeEach/afterEach
// call the PRODUCTION closeOverlayA11y(id, null) for every OverlayId and flush ONE REAL MACROTASK.
// That is legal because close-without-open is a documented no-op (ui/overlayA11y.ts:41-45). It also
// cancels the deferred-focus timer that every pre-existing `view.show()` above will schedule once
// the wiring lands (plan residual A12), so that timer can never fire inside a later test.
// `vi.clearAllMocks()` runs LAST in beforeEach so the sweep's own calls never pollute a count.
//
// m23-s3 WRONG-IMPL-KILLED index:
//   - never opens / attribute-only cheat                 -> S3-shopView-OPEN-ARIA + -HELPER-CALLED
//   - copy-pasted WRONG OverlayId                        -> S3-shopView-OPEN-ARIA (label) + -HELPER-CALLED (id arg)
//   - synchronous focus (no defer)                       -> S3-shopView-DEFER-FOCUS (negative polarity)
//   - focuses nothing / a wrapper, not the anchor         -> S3-shopView-DEFER-FOCUS (identity)
//   - close never strips ARIA / never restores focus      -> S3-shopView-CLOSE-RESTORE
//   - UNGUARDED show() (re-opens on every call)           -> S3-shopView-REPEAT-NO-REOPEN
//   - `this.visible` read AFTER the display write          -> S3-shopView-OPEN-ARIA + -REPEAT-NO-REOPEN
//   - GUARDED close in hide() (kills S1's A13 self-heal)  -> S3-shopView-CLOSE-UNGUARDED
//   - `fallbackFocus` passed as undefined/an element       -> S3-shopView-HELPER-CALLED (literal null)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import type { ShopScreenViewModel } from './shopModel';
import type { ShopCallbacks } from './shopView';
import { ShopView } from './shopView';

// The m23-s3 MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so the VALUE oracle (real attribute writes, real focus moves) still works.
vi.mock('./overlayA11y', { spy: true });

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
// m23-s3: the ux2 body-wipe is preserved verbatim; the overlay-a11y sweep + `vi.clearAllMocks()`
// are ADDED around it (rationale in the header). `afterEach` is new.
beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.innerHTML = '';
});

/** m23-s3: one REAL macrotask boundary — a microtask flush is NOT enough for setTimeout(...,0),
 *  and fake timers are banned for this defer (plan anti-pattern #10). */
async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function mountShopOverlay(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.id = 'shop-overlay';
  overlay.style.display = 'none';
  // m23-s3 FIXTURE FIDELITY (index.html:29): the shell has shipped these two as STATIC LITERALS
  // since m23-s2. They are copied here NOT to be asserted on their own — that is vacuous, a view
  // calling nothing passes — but so that "all three attributes ABSENT after close" is a real
  // tooth: only closeOverlayA11y can remove them (ui/overlayA11y.ts:142-144).
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  const title = document.createElement('div');
  title.id = 'shop-title';
  // m23-s3 (index.html:30): the OVERLAY_A11Y initialFocusSelector anchor. Copied for fidelity
  // only — happy-dom focuses a bare <div> with no tabindex at all, so this buys ZERO test power
  // (plan A7) and a passing A11Y-14 here is NOT proof a real browser would honour the focus.
  title.setAttribute('tabindex', '-1');
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

// ---------------------------------------------------------------------------
// m23-s3 — overlay a11y wiring on the show()/hide() edge (ADDITIVE; see the file header)
// ---------------------------------------------------------------------------

const S3_ID: OverlayId = 'shopView';
const S3_META = OVERLAY_A11Y[S3_ID];

/** A focusable OUTSIDE the overlay: the "pre-overlay" element a close must restore focus to. */
function s3OutsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

/** A focusable INSIDE the overlay, as a DIRECT child of the root — no render path rebuilds it, so
 *  if it loses focus it is because something RE-OPENED the overlay and re-ran the deferred focus. */
function s3InsideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's3-inside-sentinel';
  root.appendChild(btn);
  return btn;
}

describe('ShopView — overlay a11y wiring on the show/hide edge (m23-s3)', () => {
  it('S3-shopView-OPEN-ARIA BITES: the first show() from a display:none shell labels the root from OVERLAY_A11Y/t()', () => {
    const overlay = mountShopOverlay();
    const view = new ShopView(makeCallbacks());

    // VACUITY ATTACK V4, closed here: a fixture missing `style="display:none"` makes the FIRST
    // show() a NO-EDGE (wasVisible already true), so every open assertion below would be silently
    // vacuous. This also pins WIK-3 — an impl that reads `this.visible` AFTER writing
    // `style.display` sees a constant `true` and never opens on the first show().
    expect(view.visible, 'V4: the shell must start hidden, so the first show() IS an edge').toBe(
      false,
    );

    view.show();

    // Every expectation is DERIVED from the table at assert time — never a literal (V5).
    expect(overlay.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(S3_META.role);
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    expect(
      overlay.getAttribute('aria-label'),
      'THE tooth: role/aria-modal are static literals in index.html:29 and pass a view that calls ' +
        'nothing; aria-label is absent from every shell, so only a real open can produce it — and ' +
        'because all 16 catalog values are distinct, this also kills the wrong-OverlayId impl',
    ).toBe(t(S3_META.labelKey));
  });

  it('S3-shopView-DEFER-FOCUS BITES: both polarities — NOT focused synchronously, focused after ONE real macrotask, and the defer is owned by openOverlayA11y', async () => {
    const overlay = mountShopOverlay();
    const target = overlay.querySelector<HTMLElement>(S3_META.initialFocusSelector);
    expect(target, `the fixture must contain ${S3_META.initialFocusSelector}`).not.toBeNull();
    const view = new ShopView(makeCallbacks());

    view.show();

    // NEGATIVE polarity — a synchronous focus reintroduces the bug the defer exists to avoid
    // (ui/overlayA11y.ts:9-15): the letter that OPENED the overlay lands in what it just opened.
    expect(document.activeElement, 'the initial focus must NOT have landed synchronously').not.toBe(
      target,
    );
    expect(
      vi.mocked(openOverlayA11y),
      'the deferred focus must be scheduled by openOverlayA11y, not by the view (A11Y-15)',
    ).toHaveBeenCalledTimes(1);

    await flushMacrotask();

    // POSITIVE polarity, by IDENTITY — never `root.contains(activeElement)`, which passes on any
    // decorative wrapper.
    expect(document.activeElement).toBe(target);
  });

  it('S3-shopView-CLOSE-RESTORE BITES: hide() strips role, aria-modal AND aria-label from the root and hands focus back to the pre-overlay element', async () => {
    const overlay = mountShopOverlay();
    const outside = s3OutsideSentinel();
    outside.focus();
    expect(document.activeElement, 'precondition: focus starts OUTSIDE the overlay').toBe(outside);

    const view = new ShopView(makeCallbacks());
    view.show();
    await flushMacrotask();
    expect(
      document.activeElement,
      'precondition: the open moved focus INTO the overlay, so the restore below is a real move',
    ).not.toBe(outside);

    view.hide();

    // VACUITY ATTACK V1, closed here: the two static literals can only be ABSENT if
    // closeOverlayA11y really ran (ui/overlayA11y.ts:142-144).
    expect(
      overlay.getAttribute('role'),
      'a display:none node must not keep claiming to be a dialog',
    ).toBeNull();
    expect(overlay.getAttribute('aria-modal')).toBeNull();
    expect(overlay.getAttribute('aria-label')).toBeNull();

    expect(document.activeElement, 'focus must return to the pre-overlay element').toBe(outside);
  });

  it('S3-shopView-REPEAT-NO-REOPEN BITES: show() on an ALREADY-visible overlay neither re-opens nor yanks focus back', async () => {
    // A re-open clears and re-schedules the deferred-focus timer (ui/overlayA11y.ts:100-113), so an
    // unguarded delegation drags focus off whatever the player Tabbed to. INVISIBLE to every
    // attribute assertion — a re-open rewrites byte-identical values — so it is proven twice: by a
    // call COUNT and by the sentinel still holding focus.
    const overlay = mountShopOverlay();
    const view = new ShopView(makeCallbacks());

    view.show();
    await flushMacrotask();

    const inside = s3InsideSentinel(overlay);
    inside.focus();
    expect(document.activeElement, 'precondition: focus is parked INSIDE the overlay').toBe(inside);

    view.show();
    await flushMacrotask();

    expect(document.activeElement, 'a repeat show() must NOT re-run the deferred focus').toBe(
      inside,
    );
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S3-shopView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    // THE MECHANISM ORACLE (plan A3). Measured by red-team: a view that hand-writes
    // role/aria-modal/aria-label with the correct copied literal passes every VALUE assertion in
    // this file while shipping NO focus trap, NO return-focus record and NO deferred-focus timer.
    // The literal `null` pins ADR-0205 A3 / plan D8 (S3 views hold no canvas handle).
    const overlay = mountShopOverlay();
    const view = new ShopView(makeCallbacks());

    view.show();
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(S3_ID, overlay);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S3_ID, null);
  });

  it('S3-shopView-CLOSE-UNGUARDED BITES: hide() calls the close UNCONDITIONALLY — on a never-opened view, and again on every repeat', () => {
    // Plan D2's deliberate asymmetry, on the show()/hide() side. A GUARDED hide() would read
    // `visible === false` and skip the close whenever a record ever desynchronised from the DOM
    // (S1's named A13 leak, ui/overlayA11y.ts:55-59) — making a live capture listener, a pending
    // timer and a stale return target PERMANENT. Unguarded, hide() HEALS it, and a close with no
    // record is a documented pure no-op (ui/overlayA11y.ts:136-137), so nothing is risked.
    mountShopOverlay();
    const view = new ShopView(makeCallbacks());
    expect(view.visible, 'precondition: never opened').toBe(false);

    expect(() => view.hide()).not.toThrow();
    expect(
      vi.mocked(closeOverlayA11y),
      'hide() on a never-opened view MUST still call the close — a guarded hide calls it zero times',
    ).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S3_ID, null);

    view.hide();
    expect(
      vi.mocked(closeOverlayA11y),
      'unguarded means unguarded: every hide() calls the close',
    ).toHaveBeenCalledTimes(2);

    // And the same holds after a real open/close cycle: the second hide() still calls it.
    vi.clearAllMocks();
    view.show();
    view.hide();
    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
  });
});
