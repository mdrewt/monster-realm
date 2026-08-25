// @vitest-environment happy-dom
// ui/menuView.test.ts — uxd3-a RED gating tests for the main-menu DOM shell.
//
// SOURCE OF TRUTH:
//   specs/monster-realm-v2/M-postgate-ux-design.spec.md §uxd3 — AC-11, AC-13, AC-15.
//   docs/uxd3-plan.md §4 (the #menu-overlay shell + the MenuView contract) and §6.
//   ADR-0135 XSS firewall: textContent / createTextNode / replaceChildren ONLY.
//
// RED REASON: client/src/ui/menuView.ts DOES NOT EXIST. Every test in this file fails at
// module-link time ("Failed to resolve import './menuView'") until the implementer ships it.
// Nothing below guesses at an API shape — the contract is the one the plan hands the
// specialist verbatim.
//
// PINNED CONTRACT (the specialist matches this EXACTLY):
//   export interface MenuViewCallbacks { readonly onInput: (input: MenuInput) => void }
//   export class MenuView {
//     constructor(callbacks: MenuViewCallbacks);   // arity 1 — it is INTERACTIVE, unlike
//     get visible(): boolean;                      //   helpView's zero-arg display-only shell
//     show(): void;                                // writes ONLY style.display
//     hide(): void;                                // writes ONLY style.display
//     render(vm: MenuViewModel): void;             // authoritative rebuild, replaceChildren
//   }
//
// DOM contract (plan §4), which these tests assert and index.html must supply:
//   #menu-overlay  — display:none;position:fixed;inset:0;z-index:100  (NOT a corner
//                    affordance: it is inset:0 and hidden, so W-ONE-CORNER-AFFORDANCE and
//                    indexShell.test.ts H5 are unaffected)
//     #menu-heading   — the heading text node
//     #menu-rows      — a <ul>; ONE delegated click + ONE delegated mouseover listener live
//                       here, reading data-menu-index off the <li>
//     #menu-back-hint — the back/close hint text node
//   Each <li>: dataset.menuIndex, dataset.selected='true'|'false',
//              dataset.disabled='true'|'false'; text `${keyGlyph} — ${title}` when
//              keyGlyph !== null, else the bare title.
//
// COVERAGE CONSTRAINT (plan §4, anti-pattern 13): menuView.ts must NOT be added to
// vite.config.ts coverage.exclude — `evals/dom-shell-coverage-exclusion.eval.mjs`'s
// findUnsanctionedExclusions rejects any exclusion outside its hard-coded DOM_SHELLS, and
// evals/ is outside this slice's touches. That is why this file exists: happy-dom unit
// coverage, exactly like helpView / renameView / leaderboardView.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the plan only.
//
// ---------------------------------------------------------------------------
// m23-s6 ADDITION (2026-08-24) — keyboard/AT semantics for the SIXTEENTH overlay.
// ADDITIVE ONLY: all 21 pre-existing `it(` blocks are byte-identical; nothing above was
// weakened. What changed outside them, and why each change was MEASURED to be necessary:
//   (1) `mountMenuOverlay` now mirrors client/index.html:103-117 — `role="dialog"` +
//       `aria-modal="true"` on the overlay and `tabindex="0"` on the `<ul>`. Without the
//       tabindex the focus-trap ring installed by openOverlayA11y has ZERO focusables
//       (ui/focusTrap.ts:88-94 + FOCUSABLE_SELECTOR), so every ARIA/focus tooth below is
//       silently vacuous. Without role/aria-modal, "the ARIA claim is ABSENT after hide()"
//       is not a tooth at all.
//   (2) File-level beforeEach/afterEach isolation, copied from
//       ui/leaderboardView.test.ts:88-101: the production `closeOverlayA11y(id, null)` is
//       called for EVERY OverlayId, then ONE REAL macrotask is flushed. overlayA11y.ts holds
//       one module-private Map and exports no reset hook, and close-without-open is a
//       documented no-op (ui/overlayA11y.ts:41-45), so this is the sanctioned isolation
//       device. Without it a `show()` in one test leaks a capture listener on a detached
//       node, a pending deferred-focus timer, and a stale `returnFocus` into the next test.
//   (3) `vi.mock('./overlayA11y', { spy: true })` — the MECHANISM oracle (the m23-s3
//       precedent, ui/leaderboardView.test.ts:80-82). It records the calls AND calls through
//       to the real implementation, so every VALUE assertion still exercises real attribute
//       writes, a real trap and a real deferred focus.
//
// SOURCE OF TRUTH (m23-s6): memory/projects/monster-realm-m23-s6-plan.md (its PLAN REVISION
// section overrides the first half), memory/projects/gates/m23-s6.gates.md X1-X14,
// ui/overlayRegistry.ts OVERLAY_A11Y, ADR-0205 D1/D2/D3.
//
// THE DESIGN DECISION THESE TESTS ENCODE (plan revision, "split ownership"): menuView's own
// delegated keydown owns ONLY the provably inert selection-movement inputs (up | down |
// left) and consumes them with preventDefault + stopPropagation. `enter` and `escape` are
// deliberately left to bubble to main.ts's window listener, so activation and dismissal keep
// main.ts's session-gate-first and key-repeat guards. NO tabindex is ever written on a row:
// a `tabindex="-1"` <li> is MOUSE-focusable, and a click on it followed by render()'s
// replaceChildren orphans focus to <body>, after which aria-activedescendant announces
// nothing and this slice's whole deliverable is dead (red-team MEASURED on a candidate
// build; that is why MV-A11Y-OPTION-01 asserts hasAttribute('tabindex') === false).
//
// ---------------------------------------------------------------------------
// m23-s6 FIX CYCLE 1 (2026-08-25) — one CONTRACT CHANGE and six anti-cheat teeth.
// Still ADDITIVE: the 21 pre-existing `it(` blocks remain byte-identical, and no test using a
// legacy tag was added, removed or retitled (gate X14 asserts those counts EXACTLY).
//
// THE CONTRACT CHANGE (P1 — a real defect, measured by red-team on the first candidate).
// `buildMenuViewModel` emits `index` = ARRAY POSITION at BOTH levels, so "categories, Party
// selected (0)" and "Party's leaves, Monster Box selected (0)" produced the SAME option id.
// Entering the first submenu — KeyM then Enter, the DEFAULT landing path — therefore left
// `aria-activedescendant` at an UNCHANGED string, and NVDA/JAWS key their option announcement
// on a value CHANGE: the slice's headline deliverable was SILENT on its single most common
// transition. The option id is now LEVEL-QUALIFIED — `menu-option-<vm.level>-<row.index>` —
// and aria-activedescendant is built from the identical expression. Encoded below by
// MV-A11Y-OPTIONID-01 (both levels, out-of-order indices) and by the new
// MV-A11Y-ACTIVEDESC-LEVEL-01, which is the tooth that would have caught it.
//
// THE SURVIVING CHEATS THIS CYCLE CLOSES (each of them passed the previous 37/37 suite):
//   CHEAT-39  openOverlayA11y() parked at the END of render()  -> MV-A11Y-REOPEN-EDGE-01
//   CHEAT-26  aria-activedescendant from the array position    -> MV-A11Y-ACTIVEDESC-01
//   CHEAT-19  data-menu-index from the array position          -> MV-A11Y-OPTIONID-01
//   CHEAT-21  `visible` reading a private boolean              -> MV-A11Y-VISIBLE-READS-DOM-01
//   CHEAT-14  aria-labelledby hard-coded to the id literal     -> MV-SOURCE-SSOT-01
//   CHEAT-30  an inline code->input map replacing menuKeyInput -> MV-SOURCE-SSOT-01
// Plus: the PRESENCE source pins now scan COMMENT-STRIPPED text, because a raw-text `includes`
// is forgeable by a decoy comment that outlives the code it claims to prove (three measured
// bypasses of exactly that shape in this repo). The BAN pins — MV-NO-INNERHTML and
// MV-NO-FOCUS-CALL — deliberately keep scanning RAW text: a banned API named in a comment is a
// standing invitation and must still red.
// ---------------------------------------------------------------------------
//
// Do NOT edit these tests to match a buggy implementation — correct them from the plan only.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from './a11yCopy';
import {
  MENU_INITIAL,
  MENU_TREE,
  type MenuAvailability,
  type MenuNavState,
  type MenuRowVm,
  type MenuViewModel,
  menuStep,
} from './menuModel';
import { MenuView } from './menuView';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';

// m23-s6 MECHANISM oracle. `{ spy: true }` records every call AND calls through to the real
// implementation, so a cheat that hand-writes role/aria-modal/aria-label with the correct
// copied literals — no trap, no return-focus record, no timer — still reds.
vi.mock('./overlayA11y', { spy: true });

// ---------------------------------------------------------------------------
// DOM fixture — mirrors the client/index.html block the implementer must deliver
// (plan §4). Deliberately contains NO #menu-launcher and NO #help-hint: the menu is
// the zero-DOM-front-door surface (AC-11), so it must never reach for either.
// ---------------------------------------------------------------------------

const OVERLAY_ID = 'menu-overlay';

// m23-s6: the id of the focusable sentinel the close/re-open teeth park focus on.
const OUTSIDE_SENTINEL_ID = 's6-outside-sentinel';

/** m23-s6: ONE REAL macrotask boundary. A microtask flush is NOT enough for the
 *  `setTimeout(..., 0)` deferred focus in ui/overlayA11y.ts:111-113, and fake timers are
 *  banned for this defer (the m23-s1/s3 precedent). */
async function flushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function teardown(): void {
  for (const id of [OVERLAY_ID, 'menu-launcher', 'help-hint', OUTSIDE_SENTINEL_ID]) {
    document.getElementById(id)?.remove();
  }
}

/**
 * Mount the overlay. `omit` drops exactly one child (or the overlay itself) so each
 * constructor throw-path can be driven independently.
 */
function mountMenuOverlay(omit?: 'menu-heading' | 'menu-rows' | 'menu-back-hint'): HTMLElement {
  teardown();

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.display = 'none';
  // A sentinel inline style: show()/hide() must write ONLY style.display, so this must
  // survive every toggle (the shell must not clobber the whole style attribute).
  overlay.style.zIndex = '100';
  // m23-s6 FIXTURE FIDELITY (client/index.html:105-106): the shell has shipped these two as
  // STATIC LITERALS since m23-s2. They are copied here NOT to be asserted on their own —
  // that is VACUOUS, a view that calls nothing passes (plan revision anti-pattern 9) — but
  // so that "the ARIA claim is ABSENT after hide()" is a real tooth: only closeOverlayA11y
  // removes them (ui/overlayA11y.ts:142-144).
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  if (omit !== 'menu-heading') {
    const heading = document.createElement('div');
    heading.id = 'menu-heading';
    overlay.appendChild(heading);
  }
  if (omit !== 'menu-rows') {
    const rows = document.createElement('ul');
    rows.id = 'menu-rows';
    // m23-s6 FIXTURE FIDELITY (client/index.html:117): `tabindex="0"`, NEVER "-1"
    // (ADR-0205 D2's named landmine). This is LOAD-BEARING for the tests, not decoration:
    // it is the OVERLAY_A11Y.menuView initialFocusSelector anchor, and ui/focusTrap.ts's
    // ring is built by querySelector over FOCUSABLE_SELECTOR — with no tabindex here the
    // overlay has ZERO focusables and every ARIA/focus tooth below passes vacuously.
    rows.setAttribute('tabindex', '0');
    overlay.appendChild(rows);
  }
  if (omit !== 'menu-back-hint') {
    const hint = document.createElement('div');
    hint.id = 'menu-back-hint';
    overlay.appendChild(hint);
  }

  document.body.appendChild(overlay);
  return overlay;
}

// m23-s6 TEST-ISOLATION HOOKS (ui/leaderboardView.test.ts:90-102). File-level, so they cover
// the pre-existing blocks too — several of those call show(), which schedules a deferred
// focus and installs a capture listener the moment the wiring lands. These run BEFORE each
// describe's own `mountMenuOverlay` hook, so every pre-existing test still gets the DOM it
// always got.
beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
  document.body.replaceChildren();
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await flushMacrotask();
});

const rowsEl = (): HTMLUListElement => document.getElementById('menu-rows') as HTMLUListElement;
const liList = (): HTMLElement[] => Array.from(rowsEl().querySelectorAll('li'));

// ---------------------------------------------------------------------------
// ViewModel factories (pure data — the shell must not import menuModel's builder).
// ---------------------------------------------------------------------------

function row(
  index: number,
  title: string,
  keyGlyph: string | null = null,
  selected = false,
  disabled = false,
): MenuRowVm {
  return { index, title, keyGlyph, selected, disabled };
}

function vmOf(
  rows: readonly MenuRowVm[],
  heading = 'Menu',
  backHint = 'Escape — close',
  level: 'categories' | 'leaves' = 'categories',
): MenuViewModel {
  return { level, heading, rows, backHint };
}

const CATEGORY_VM = vmOf([
  row(0, 'Party', null, true),
  row(1, 'World'),
  row(2, 'Trade'),
  row(3, 'Compete'),
  row(4, 'System'),
]);

const PARTY_VM = vmOf(
  [
    row(0, 'Monster Box', 'B', true),
    row(1, 'Backpack & Raising', 'I'),
    row(2, 'Evolve & Fuse', 'E'),
  ],
  'Party',
  'Escape / ← — back',
  'leaves',
);

function newView(): { view: MenuView; onInput: ReturnType<typeof vi.fn> } {
  const onInput = vi.fn();
  return { view: new MenuView({ onInput }), onInput };
}

// ===========================================================================
// BLOCK A — construction.
// ===========================================================================

describe('MenuView — construction', () => {
  afterEach(() => {
    teardown();
  });

  it('MV-CTOR-01 BITES: throws when #menu-overlay is absent — kills the silent-null shell', () => {
    // WRONG IMPL KILLED: an impl that stores `document.getElementById(...)` without a guard.
    // main.ts constructs the views behind a dynamic import at boot; a null overlay would fail
    // later, from inside the KeyM handler, as an unhandled TypeError in a window listener —
    // i.e. the menu would be silently dead for the whole session instead of failing at boot.
    teardown();
    expect(() => new MenuView({ onInput: vi.fn() })).toThrow();
  });

  it('MV-CTOR-02 BITES: throws when #menu-heading is absent — kills the partial-DOM shell', () => {
    // WRONG IMPL KILLED: an impl that guards only the overlay (helpView guards all three of
    // its elements; renameView guards all five). A missing heading would leave render()
    // writing to null.
    mountMenuOverlay('menu-heading');
    expect(() => new MenuView({ onInput: vi.fn() })).toThrow();
  });

  it('MV-CTOR-03 BITES: throws when #menu-rows is absent — kills the partial-DOM shell', () => {
    // WRONG IMPL KILLED: the same, for the <ul> that hosts BOTH delegated listeners. Without
    // a throw here the menu would paint a heading and no rows, with no clue why.
    mountMenuOverlay('menu-rows');
    expect(() => new MenuView({ onInput: vi.fn() })).toThrow();
  });

  it('MV-CTOR-04 BITES: throws when #menu-back-hint is absent — kills the partial-DOM shell', () => {
    // WRONG IMPL KILLED: the same, for the hint element. The hint is the only thing telling
    // the player Escape pops vs closes (AC-14), so silently dropping it is a real UX loss.
    mountMenuOverlay('menu-back-hint');
    expect(() => new MenuView({ onInput: vi.fn() })).toThrow();
  });

  it('MV-CTOR-05 BITES: MenuView takes exactly one (callbacks) parameter', () => {
    // WRONG IMPL KILLED: a zero-arg helpView-style shell that wires its own store/main.ts
    // imports for input handling. The menu is INTERACTIVE, and ADR-0014's one-way flow
    // requires the DOM shell to emit inputs outward through a callback, never to decide
    // anything itself (all nav decisions live in the pure menuModel core).
    expect(MenuView.length).toBe(1);
  });
});

// ===========================================================================
// BLOCK B — visibility.
// ===========================================================================

describe('MenuView — visibility', () => {
  beforeEach(() => {
    mountMenuOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('MV-VIS-01 BITES: visible is false at construction — kills a shell that shows itself', () => {
    // WRONG IMPL KILLED: an impl that calls show() (or sets display:block) in the constructor.
    // The views are constructed at boot, so a self-showing menu would occlude the world from
    // the first frame — and it would be visible before the player has even joined.
    const { view } = newView();
    expect(view.visible).toBe(false);
  });

  it('MV-VIS-02 BITES: show() then hide() flips `visible` and writes ONLY style.display', () => {
    // WRONG IMPL KILLED (1): a no-op show()/hide(), or a `visible` getter reading a private
    //   boolean instead of the DOM — main.ts's 15 guard lists all read `menuView?.visible`, so
    //   a getter that can disagree with the painted DOM desynchronises every one of them.
    // WRONG IMPL KILLED (2): an impl that writes the whole `style` attribute (or toggles a
    //   class that sets `position`), which would drop the inset:0/z-index:100 the plan requires
    //   — the overlay would paint below the viewport-tall canvas (ux1 / ADR-0151 D1).
    const { view } = newView();
    const overlay = document.getElementById(OVERLAY_ID) as HTMLElement;

    view.show();
    expect(view.visible).toBe(true);
    expect(overlay.style.display).not.toBe('none');
    expect(overlay.style.zIndex, 'show() must not clobber the other inline styles').toBe('100');

    view.hide();
    expect(view.visible).toBe(false);
    expect(overlay.style.display).toBe('none');
    expect(overlay.style.zIndex, 'hide() must not clobber the other inline styles').toBe('100');
  });

  it('MV-VIS-03 BITES: hide() keeps the three child elements — kills a "clear the overlay" hide', () => {
    // WRONG IMPL KILLED: a hide() that empties the overlay (replaceChildren on #menu-overlay
    // rather than on #menu-rows). The element references were resolved once in the constructor,
    // so a later render() would write into detached nodes and paint nothing, forever.
    const { view } = newView();
    view.show();
    view.render(CATEGORY_VM);
    view.hide();

    expect(document.getElementById('menu-heading')).not.toBeNull();
    expect(document.getElementById('menu-rows')).not.toBeNull();
    expect(document.getElementById('menu-back-hint')).not.toBeNull();
  });
});

// ===========================================================================
// BLOCK C — render (AC-13 / AC-15).
// ===========================================================================

describe('MenuView — render', () => {
  beforeEach(() => {
    mountMenuOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('MV-RENDER-01 BITES: paints the heading and the back hint verbatim from the VM', () => {
    // WRONG IMPL KILLED: a shell that hard-codes 'Menu' / 'Escape — close' instead of reading
    // the VM. The heading IS the breadcrumb (there is no other one), so a hard-coded heading
    // leaves the player unable to tell which category they entered, and a hard-coded hint tells
    // them Escape closes when at the leaf level it pops back (AC-14).
    const { view } = newView();
    view.render(PARTY_VM);

    expect(document.getElementById('menu-heading')?.textContent).toBe('Party');
    expect(document.getElementById('menu-back-hint')?.textContent).toBe('Escape / ← — back');

    view.render(CATEGORY_VM);
    expect(document.getElementById('menu-heading')?.textContent).toBe('Menu');
    expect(document.getElementById('menu-back-hint')?.textContent).toBe('Escape — close');
  });

  it('MV-RENDER-02 BITES: one <li> per VM row, in VM order, carrying data-menu-index / -selected / -disabled', () => {
    // WRONG IMPL KILLED (1): a shell that filters or re-sorts rows — a disabled leaf MUST still
    //   be painted (AC-15, grey-not-hide), and the VM order is the nav order menuStep indexes.
    // WRONG IMPL KILLED (2): writing data-menu-index from the ARRAY POSITION rather than from
    //   `row.index`. They coincide today, but the index is what the delegated listeners feed
    //   back into menuStep, so it must be the VM's own field.
    // WRONG IMPL KILLED (3): omitting data-selected/data-disabled when false (the leaderboard
    //   precedent leaves dataset.own unset for non-own rows). Here the plan requires the
    //   explicit 'true'|'false' strings on EVERY row, so CSS can style both states.
    const { view } = newView();
    view.render(
      vmOf([row(0, 'Interact', 'T', true, true), row(1, 'Journal (Quests)', 'Q', false, false)]),
    );

    const items = liList();
    expect(items.length, 'ANTI-VACUITY: the render must have produced 2 <li> rows').toBe(2);
    expect(items.map((li) => li.dataset.menuIndex)).toEqual(['0', '1']);
    expect(items.map((li) => li.dataset.selected)).toEqual(['true', 'false']);
    expect(items.map((li) => li.dataset.disabled)).toEqual(['true', 'false']);
  });

  it('MV-RENDER-03 BITES: row text is `${keyGlyph} — ${title}` when a glyph exists, and the bare title when it is null', () => {
    // WRONG IMPL KILLED (1): rendering `${keyGlyph} — ${title}` unconditionally — category rows
    //   carry keyGlyph === null, so the top-level list would read "null — Party" / " — Party".
    // WRONG IMPL KILLED (2): dropping the glyph entirely, which deletes the whole point of
    //   AC-18 (the menu teaches the quick-hotkeys while the player uses it).
    const { view } = newView();
    view.render(vmOf([row(0, 'Party'), row(1, 'Controls & Help', '?')]));

    const items = liList();
    expect(items.length, 'ANTI-VACUITY: both rows must exist').toBe(2);
    expect(items[0]!.textContent).toBe('Party');
    expect(items[1]!.textContent).toBe('? — Controls & Help');
  });

  it('MV-RENDER-04 BITES: a re-render REPLACES the rows — kills an append-instead-of-replace shell', () => {
    // WRONG IMPL KILLED: `rowsEl.appendChild(...)` per row without clearing first. Every arrow
    // keypress re-renders, so the list would grow without bound within seconds of navigating,
    // and the stale rows would carry stale data-menu-index values that the delegated click
    // listener would happily feed back into menuStep.
    const { view } = newView();
    view.render(CATEGORY_VM);
    expect(liList().length, 'ANTI-VACUITY: the first render must paint 5 rows').toBe(5);

    view.render(vmOf([row(0, 'World')]));
    const items = liList();
    expect(items.length).toBe(1);
    expect(items[0]!.textContent).toBe('World');
    expect(rowsEl().children.length, 'no non-<li> stale node may survive either').toBe(1);
  });

  it('MV-RENDER-05 BITES: an empty row list paints nothing rather than throwing', () => {
    // WRONG IMPL KILLED: a `rows[0]` read (e.g. to compute a "selected" scroll target) with no
    // empty guard. render() runs from the KeyM open path; a throw there leaves the overlay shown
    // with whatever the previous render painted.
    const { view } = newView();
    view.render(CATEGORY_VM);
    expect(liList().length).toBe(5);
    expect(() => {
      view.render(vmOf([]));
    }).not.toThrow();
    expect(liList().length).toBe(0);
  });

  it('MV-RENDER-06 BITES: a title containing markup renders as LITERAL TEXT — no injected elements (ADR-0135)', () => {
    // WRONG IMPL KILLED: `li.innerHTML = ...` or any template-string DOM. Menu titles are
    // static consts TODAY, but the XSS firewall is structural, not situational: the day a leaf
    // title interpolates a player-controlled name (an incoming trade partner, a challenger),
    // an innerHTML shell becomes a live injection point. Pairs with the source scan below,
    // which catches the case where a future edit adds innerHTML on a path no fixture reaches.
    const malicious = '<img src=x onerror=alert(1)><script>bad()</script>';
    const { view } = newView();
    view.render(vmOf([row(0, malicious, 'B')]));

    const overlay = document.getElementById(OVERLAY_ID) as HTMLElement;
    expect(overlay.querySelector('script')).toBeNull();
    expect(overlay.querySelector('img')).toBeNull();

    const items = liList();
    expect(items.length, 'ANTI-VACUITY: the row must have been painted at all').toBe(1);
    expect(items[0]!.textContent).toBe(`B — ${malicious}`);
  });
});

// ===========================================================================
// BLOCK D — delegated input (AC-13's hover/click half).
// ===========================================================================

describe('MenuView — delegated click / hover', () => {
  beforeEach(() => {
    mountMenuOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('MV-INPUT-01 BITES: a click on a row emits {kind:"click", index} for THAT row', () => {
    // WRONG IMPL KILLED (1): emitting the SELECTED index instead of the clicked one — a tap on
    //   an unselected row would open the wrong category (a synthetic click, and a real touch
    //   tap, fire no mouseover first, so nothing moves the selection beforehand).
    // WRONG IMPL KILLED (2): emitting the index as a STRING ('3'). menuStep's range check would
    //   see a non-number and, per its totality contract, no-op — every click would silently do
    //   nothing while keyboard nav worked fine.
    const { view, onInput } = newView();
    view.render(CATEGORY_VM);

    liList()[3]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith({ kind: 'click', index: 3 });
  });

  it('MV-INPUT-02 BITES: a mouseover on a row emits {kind:"hover", index} — never a click', () => {
    // WRONG IMPL KILLED: wiring mouseover to the same 'click' input kind (or activating on
    // hover). Sweeping the mouse down the menu on the way to the row you want would fire every
    // overlay it passed over.
    const { view, onInput } = newView();
    view.render(PARTY_VM);

    liList()[2]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith({ kind: 'hover', index: 2 });
  });

  it('MV-INPUT-03 BITES: delegation SURVIVES a re-render and is bound exactly once (no per-render listener leak)', () => {
    // THE DELEGATION TOOTH. WRONG IMPL KILLED (1): per-<li> listeners attached inside render().
    //   They are discarded by replaceChildren, so they would appear to work — until you notice
    //   every render allocates N more closures; and any impl that instead re-attaches to the
    //   <ul> on each render fires onInput N TIMES for one click, so one click on a category
    //   would open it, then immediately re-enter it, then... (the toHaveBeenCalledTimes(1)
    //   assertion below is what kills that).
    // WRONG IMPL KILLED (2): listeners bound in the constructor to the <li> nodes (there are
    //   none yet at construction) rather than to the persistent <ul>.
    const { view, onInput } = newView();
    view.render(CATEGORY_VM);
    view.render(PARTY_VM); // full replaceChildren of the row list
    view.render(CATEGORY_VM);

    liList()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onInput, 'exactly ONE emission per click after three renders').toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith({ kind: 'click', index: 1 });
  });

  it('MV-INPUT-04 BITES: a click on the <ul> itself (no data-menu-index) emits NOTHING', () => {
    // WRONG IMPL KILLED: a handler that reads `(e.target as HTMLElement).dataset.menuIndex` and
    // forwards `Number(undefined)` — that is NaN, and it would reach menuStep on every click in
    // the padding around the rows. (menuStep is total and would no-op, but the shell must not
    // manufacture bogus inputs in the first place: it is the only place the index is known.)
    const { view, onInput } = newView();
    view.render(CATEGORY_VM);

    rowsEl().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    rowsEl().dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));

    expect(onInput).not.toHaveBeenCalled();
  });

  it('MV-INPUT-05 BITES: a DISABLED row still emits its input — greying is a MODEL decision, not a shell one', () => {
    // WRONG IMPL KILLED: a shell that swallows clicks on data-disabled="true" rows. The
    // grey-not-hide rule (AC-15) is enforced by menuStep, which returns {kind:'none'} for an
    // unavailable leaf; duplicating that gate in the shell puts a second, untested copy of the
    // availability decision in a DOM file and breaks the ADR-0014 seam. It would also swallow
    // the HOVER, so the selection could never move onto a greyed row.
    const { view, onInput } = newView();
    view.render(vmOf([row(0, 'Interact', 'T', false, true)]));

    liList()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(onInput).toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith({ kind: 'click', index: 0 });
  });
});

// ===========================================================================
// BLOCK E — AC-11: the menu never depends on a launcher element.
// ===========================================================================

describe('MenuView — zero-DOM front door (AC-11)', () => {
  afterEach(() => {
    teardown();
  });

  it('MV-OPENS-WITH-NO-LAUNCHER-IN-DOM BITES: show() + render() paint with NO #menu-launcher and NO #help-hint in the document', () => {
    // WRONG IMPL KILLED: a shell that resolves (or worse, requires) a launcher/badge element —
    // e.g. `document.getElementById('menu-launcher')!.classList.add('active')` in show(), or a
    // constructor that throws when the badge is absent. `#menu-launcher` is uxd3-b's; there is
    // NO way to ship it in uxd3-a (the #help-hint needs pointer-events:auto, which fails
    // indexShell.test.ts H4, and a second corner element violates the one-affordance rule,
    // AC-12). KeyM is the self-owned, zero-DOM front door — the menu must work with nothing in
    // the DOM but its own overlay.
    mountMenuOverlay();

    // ANTI-VACUITY for the negative premise: if a fixture ever grew these elements, the test
    // would still pass while proving nothing. Assert their absence explicitly, first.
    expect(document.getElementById('menu-launcher'), 'fixture must have NO launcher').toBeNull();
    expect(document.getElementById('help-hint'), 'fixture must have NO help hint').toBeNull();
    expect(document.getElementById(OVERLAY_ID), 'fixture must have the overlay').not.toBeNull();

    const { view } = newView();
    view.show();
    view.render(CATEGORY_VM);

    expect(view.visible).toBe(true);
    const items = liList();
    expect(items.length, 'the top-level category list must paint all 5 rows').toBe(5);
    expect(items.map((li) => li.textContent)).toEqual([
      'Party',
      'World',
      'Trade',
      'Compete',
      'System',
    ]);
    expect(document.getElementById('menu-heading')?.textContent).toBe('Menu');
  });
});

// ===========================================================================
// BLOCK F — structural: the XSS firewall, asserted against the source text.
// ===========================================================================

describe('MenuView — source-level XSS firewall (ADR-0135)', () => {
  it('MV-NO-INNERHTML BITES: menuView.ts contains no innerHTML / outerHTML / insertAdjacentHTML / document.write', () => {
    // WRONG IMPL KILLED: an innerHTML (or template-string DOM) path that no fixture happens to
    // reach — e.g. an `innerHTML = ''` "clear" before appending rows, which is the single most
    // common way this firewall is breached, and which MV-RENDER-06 alone would NOT catch
    // because that path injects nothing itself. Anti-pattern 12: textContent /
    // createTextNode / replaceChildren ONLY.
    // Uses .includes() — no dynamic RegExp (the repo's ReDoS ban).
    const viewPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'menuView.ts');
    let src: string;
    try {
      src = readFileSync(viewPath, 'utf8');
    } catch (err) {
      // A `catch { return; }` here would be a vacuous-pass hole (the m16.5a
      // vacuous-revival-gate precedent). Post-impl the file MUST exist, so throw.
      throw new Error(
        'client/src/ui/menuView.ts could not be read — post-impl the file must exist: ' +
          String(err),
      );
    }

    // ANTI-VACUITY: an empty or truncated read would pass every `.includes(...) === false`
    // check below. Pin that the file is real and is the shell we think it is.
    expect(src.length, 'ANTI-VACUITY: menuView.ts must be non-trivial').toBeGreaterThan(200);
    expect(
      src.includes('replaceChildren'),
      'ANTI-VACUITY: menuView.ts must rebuild the row list with replaceChildren',
    ).toBe(true);
    expect(
      src.includes('textContent'),
      'ANTI-VACUITY: menuView.ts must paint text with textContent',
    ).toBe(true);

    for (const needle of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
      expect(
        src.includes(needle),
        `menuView.ts must not contain "${needle}" — textContent/createTextNode/` +
          'replaceChildren only (ADR-0135 XSS firewall)',
      ).toBe(false);
    }
  });
});

// ===========================================================================
// m23-s6 BLOCK G — the ARIA listbox, its options, and aria-activedescendant.
// (gates X1-X5; M23 §4 row S6, A11Y-24)
// ===========================================================================

// Every expectation below is DERIVED from the registry at assert time, never a literal —
// the m23-s3 V5 rule (ui/leaderboardView.test.ts:538).
const S6_ID: OverlayId = 'menuView';
const S6_META = OVERLAY_A11Y[S6_ID];

describe('MenuView — listbox and option semantics (m23-s6)', () => {
  beforeEach(() => {
    mountMenuOverlay();
  });

  afterEach(() => {
    teardown();
  });

  it('MV-A11Y-LISTBOX-01 BITES: the CONSTRUCTOR alone gives #menu-rows role="listbox" and an aria-labelledby that RESOLVES to the #menu-heading element', () => {
    // WRONG IMPL KILLED (1): setting the role inside render(). replaceChildren rebuilds the
    //   CHILDREN, not the <ul>, so that would look fine — until the very first frame between
    //   construction and the first render(), and until any future edit moves the rebuild up a
    //   level. The registry anchor is a CONSTRUCTOR-TIME contract (ADR-0205 D1/D2), and this
    //   test asserts BEFORE any render() has ever run, so a render-time role reds.
    // WRONG IMPL KILLED (2): a hard-coded `aria-labelledby="menu-heading"` string that does not
    //   come from the already-resolved heading element (plan anti-pattern 12 — a second
    //   getElementById). Asserting `=== headingEl.id` AND `getElementById(value) === headingEl`
    //   kills both a typo'd literal and a dangling IDREF. It does NOT kill a hard-coded literal
    //   that happens to be CORRECT (CHEAT-14) — nothing behavioural can, since the fixture's
    //   heading really is #menu-heading — so that one is pinned on the source in
    //   MV-SOURCE-SSOT-01.
    // WRONG IMPL KILLED (3): `aria-label="Menu"` instead of `aria-labelledby` — the heading IS
    //   the breadcrumb and it CHANGES per level, so a frozen literal name would announce "Menu"
    //   while the player is inside the Party submenu.
    const heading = document.getElementById('menu-heading') as HTMLElement;
    const rows = rowsEl();
    expect(
      rows.getAttribute('role'),
      'precondition: the fixture ships NO role on the <ul> — only a real constructor can add it',
    ).toBeNull();

    newView(); // construct ONLY — no show(), no render()

    expect(rows.getAttribute('role')).toBe('listbox');
    const labelledBy = rows.getAttribute('aria-labelledby');
    expect(labelledBy, 'the listbox must be NAMED, and named by IDREF').not.toBeNull();
    expect(labelledBy).toBe(heading.id);
    expect(
      document.getElementById(labelledBy ?? ''),
      'the IDREF must resolve to the live #menu-heading element, not to nothing',
    ).toBe(heading);
  });

  it('MV-A11Y-OPTION-01 BITES: every <li> is role="option" with an explicit aria-selected, aria-disabled ONLY when disabled, and NEVER a tabindex', () => {
    // WRONG IMPL KILLED (1): rows left as bare <li> inside a role="listbox" — a listbox whose
    //   children are not options exposes NO options at all to an AT, which is strictly worse
    //   than the pre-slice bare list.
    // WRONG IMPL KILLED (2): omitting aria-selected on unselected rows (the dataset.own
    //   precedent). ARIA requires EVERY option in a single-select listbox to carry an explicit
    //   aria-selected, so an absent 'false' makes the selection ambiguous.
    // WRONG IMPL KILLED (3): `aria-disabled="false"` on enabled rows — identical in meaning to
    //   absent, so it is noise, and it is the shape a blind `String(row.disabled)` produces.
    // WRONG IMPL KILLED (4) — THE BLOCKER TOOTH: `tabindex="-1"` on a row. Spec §5.4:488-491
    //   asks for it and it is WRONG (plan revision, MEASURED by red-team): a negative tabindex
    //   makes an <li> MOUSE-focusable, so one click focuses that row, the click emits
    //   {kind:'click'} -> menuStep 'none' -> renderMenu() -> replaceChildren DESTROYS the
    //   focused node -> focus falls to <body>. From then on aria-activedescendant announces
    //   nothing (it only speaks while the listbox itself holds focus) and menuView's own
    //   keydown never fires again. The APG activedescendant pattern puts tabindex on the
    //   CONTAINER only, which index.html:117 already ships.
    // WRONG IMPL KILLED (5): a PER-ROW keydown listener instead of one delegated listener on
    //   the <ul> ([A11Y-T3]; it also leaks N closures per render). The non-bubbling dispatch at
    //   the end can ONLY be observed by a listener on the <li> itself.
    const { view, onInput } = newView();
    // Shown FIRST, so the per-row-listener probe cannot be excused by a `!this.visible` guard.
    view.show();
    view.render(
      vmOf([row(0, 'Interact', 'T', true, true), row(1, 'Journal (Quests)', 'Q', false, false)]),
    );

    const items = liList();
    expect(items.length, 'ANTI-VACUITY: the render must have produced 2 <li> rows').toBe(2);
    for (const li of items) {
      expect(li.getAttribute('role'), 'every row must be an option').toBe('option');
      expect(
        li.hasAttribute('tabindex'),
        'NO tabindex on a row, ever — a mouse-focusable <li> is destroyed by the next ' +
          'replaceChildren and orphans focus to <body>',
      ).toBe(false);
    }
    expect(items[0]!.getAttribute('aria-selected')).toBe('true');
    expect(items[1]!.getAttribute('aria-selected')).toBe('false');
    expect(items[0]!.getAttribute('aria-disabled')).toBe('true');
    expect(
      items[1]!.hasAttribute('aria-disabled'),
      'aria-disabled="false" is identical to absent — an enabled row must carry NEITHER',
    ).toBe(false);

    // A NON-bubbling keydown reaches listeners on the <li> and nothing else.
    items[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'ArrowDown', bubbles: false, cancelable: true }),
    );
    expect(
      onInput,
      'a non-bubbling keydown on a ROW must reach NOTHING — the keydown listener belongs on the ' +
        '<ul>, in the default BUBBLE phase, exactly like the click and mouseover ones',
    ).not.toHaveBeenCalled();
  });

  it('MV-A11Y-OPTIONID-01 BITES: each option id is LEVEL-QUALIFIED and built from row.index — never the array position — is document-unique, and cannot collide with an index.html id', () => {
    // THE ID CONTRACT: `menu-option-<vm.level>-<row.index>`.
    // WRONG IMPL KILLED (1): `menu-option-${arrayPosition}`. On every REAL view-model produced
    //   by buildMenuViewModel the two coincide, so no realistic fixture can tell them apart —
    //   which is why this one hands render() indices 7 then 3, OUT of array order.
    // WRONG IMPL KILLED (2) — THE P1 DEFECT (measured by red-team on the first candidate): an
    //   id built from `row.index` ALONE, with no level qualifier. buildMenuViewModel emits
    //   index = array position at BOTH levels, so "categories, Party selected (0)" and "Party's
    //   leaves, Monster Box selected (0)" produce the SAME id — and the SAME
    //   aria-activedescendant across the menu's most common transition. See
    //   MV-A11Y-ACTIVEDESC-LEVEL-01 for the announcement half; this test pins the id half by
    //   rendering the SAME two row.index values at BOTH levels and requiring different ids.
    // WRONG IMPL KILLED (3): a constant id on every row (or ids that repeat within one render),
    //   which makes aria-activedescendant point at whichever duplicate the browser finds first.
    // WRONG IMPL KILLED (4) — CHEAT-19: `data-menu-index` written from the array position while
    //   the id is correct. This is the ONLY fixture in the file where position !== row.index, so
    //   it is the only place that mismatch is observable — and it is not cosmetic: the delegated
    //   click reads that dataset value back and feeds it to menuStep, so a positional write
    //   opens the WRONG row on every re-indexed list. Pinned by a dataset census AND, end to
    //   end, by a real click emission.
    // WRONG IMPL KILLED (5): an id namespace that collides with the static shell — a duplicate
    //   id in the document silently breaks getElementById for the shell element too. Proved by
    //   reading client/index.html from disk: `menu-option` must not appear there at all.
    const { view, onInput } = newView();
    view.render(vmOf([row(7, 'Seven', 'A', true), row(3, 'Three', 'B')]));

    const items = liList();
    expect(items.length, 'ANTI-VACUITY: both rows must have been painted').toBe(2);
    expect(items.map((li) => li.id)).toEqual([
      'menu-option-categories-7',
      'menu-option-categories-3',
    ]);
    expect(
      items.map((li) => li.dataset.menuIndex),
      'CHEAT-19: data-menu-index is what the delegated click feeds back into menuStep — it must ' +
        'be row.index, never the array position',
    ).toEqual(['7', '3']);
    for (const li of items) {
      expect(
        document.querySelectorAll(`#${li.id}`).length,
        `the id ${li.id} must be document-UNIQUE`,
      ).toBe(1);
      expect(document.getElementById(li.id)).toBe(li);
    }

    // The SAME two row.index values at the OTHER level must produce DIFFERENT ids. That is the
    // whole point of the level qualifier, and it is precisely what the P1 defect got wrong.
    view.render(
      vmOf([row(7, 'Seven', 'A', true), row(3, 'Three', 'B')], 'Party', 'Escape / ← — back', 'leaves'),
    );
    const leafItems = liList();
    expect(leafItems.map((li) => li.id)).toEqual([
      'menu-option-leaves-7',
      'menu-option-leaves-3',
    ]);

    // CHEAT-19, end to end: a click on the FIRST row must emit index 7, not 0.
    leafItems[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onInput, 'the click must carry the ROW index').toHaveBeenCalledTimes(1);
    expect(onInput).toHaveBeenCalledWith({ kind: 'click', index: 7 });

    // The collision half, read from the real shell. String.includes only — the repo bans a
    // dynamic RegExp (ReDoS / detect-non-literal-regexp).
    const htmlPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'index.html',
    );
    let html: string;
    try {
      html = readFileSync(htmlPath, 'utf8');
    } catch (err) {
      // Never a silent return — that is the vacuous-pass hole the m16.5a precedent names.
      throw new Error('client/index.html could not be read — it must exist: ' + String(err));
    }
    expect(html.length, 'ANTI-VACUITY: index.html must be the real shell').toBeGreaterThan(2000);
    expect(
      html.includes('menu-rows'),
      'ANTI-VACUITY: index.html must be the shell that owns #menu-rows',
    ).toBe(true);
    expect(
      html.includes('menu-option'),
      'the runtime option-id namespace must not collide with any id shipped in index.html',
    ).toBe(false);
  });

  it('MV-A11Y-ACTIVEDESC-01 BITES: aria-activedescendant tracks the SELECTED ROW.INDEX across renders and resolves to a live option inside #menu-rows', () => {
    // WRONG IMPL KILLED (1): a set-once impl (written in the constructor, or only on the first
    //   render). Two DIFFERENT selections are rendered and the attribute value must CHANGE —
    //   this is the entire deliverable: every ArrowUp/ArrowDown re-renders, and if the pointer
    //   does not move, a screen reader announces the same row forever while the highlight moves.
    // WRONG IMPL KILLED (2) — CHEAT-26: the pointer computed from the selected row's ARRAY
    //   POSITION while the id is built from `row.index`. The two coincide on every view-model
    //   buildMenuViewModel actually emits, so ONLY an out-of-order fixture can separate them —
    //   hence indices 5 / 2 / 9 below and an EXACT expected string, not merely "it changed".
    //   Mismatched, the IDREF dangles and the listbox announces nothing at all.
    // WRONG IMPL KILLED (3): pointing at the row's data-menu-index, its text, or an id that was
    //   never written to the DOM — also a dangling IDREF. Resolving the value with
    //   getElementById and asserting the found node is an <li> INSIDE #menu-rows whose
    //   aria-selected is 'true' kills every one of those.
    // WRONG IMPL KILLED (4): writing the attribute BEFORE replaceChildren (so it names a node
    //   from the PREVIOUS render, which is detached by the time an AT reads it) — the resolved
    //   node must be the live one, and `rows.contains(...)` is what proves it.
    const { view } = newView();
    const rows = rowsEl();

    view.render(vmOf([row(5, 'Party', null, true), row(2, 'World'), row(9, 'Trade')]));
    const first = rows.getAttribute('aria-activedescendant');
    expect(
      first,
      'CHEAT-26: the pointer must be built from the SELECTED row.index (5), not from its array ' +
        'position (0) — the two coincide on every real view-model, so only an out-of-order ' +
        'fixture can tell them apart',
    ).toBe('menu-option-categories-5');
    const firstEl = document.getElementById(first ?? '');
    expect(firstEl, 'the IDREF must resolve to a live element').not.toBeNull();
    expect(firstEl?.tagName).toBe('LI');
    expect(rows.contains(firstEl), 'the active descendant must live INSIDE the listbox').toBe(true);
    expect(firstEl?.getAttribute('aria-selected')).toBe('true');
    expect(firstEl?.textContent).toBe('Party');

    // A second, DIFFERENT selection — exactly what one ArrowDown produces. Its row.index (9) is
    // again nothing like its array position (2).
    view.render(vmOf([row(5, 'Party'), row(2, 'World'), row(9, 'Trade', null, true)]));
    const second = rows.getAttribute('aria-activedescendant');
    expect(second, 'the pointer must follow the selection to row.index 9').toBe(
      'menu-option-categories-9',
    );
    expect(second, 'a set-once impl leaves the pointer on the old row').not.toBe(first);
    const secondEl = document.getElementById(second ?? '');
    expect(secondEl, 'the IDREF must resolve to a live element after the re-render').not.toBeNull();
    expect(secondEl?.tagName).toBe('LI');
    expect(rows.contains(secondEl), 'the active descendant must live INSIDE the listbox').toBe(
      true,
    );
    expect(secondEl?.getAttribute('aria-selected')).toBe('true');
    expect(secondEl?.textContent).toBe('Trade');
  });

  it('MV-A11Y-ACTIVEDESC-02 BITES: aria-activedescendant is REMOVED (not set to "") when the list is empty or nothing is selected, and is set again afterwards', () => {
    // WRONG IMPL KILLED (1): `setAttribute('aria-activedescendant', '')` as the "clear" — the
    //   empty string is a DANGLING IDREF, not an absence: the listbox keeps claiming it has an
    //   active descendant that does not exist. hasAttribute(...) === false is the only
    //   assertion that separates the two; getAttribute(...) === '' would pass on both.
    // WRONG IMPL KILLED (2): a set-once-never-clear impl that leaves the previous render's id
    //   in place after an empty render — which is a pointer at a node replaceChildren deleted.
    // WRONG IMPL KILLED (3): a clear that never re-arms (an early `return` in the empty branch
    //   that skips the later write), caught by the final re-render assertion.
    const { view } = newView();
    const rows = rowsEl();

    view.render(CATEGORY_VM);
    expect(
      rows.hasAttribute('aria-activedescendant'),
      'ANTI-VACUITY: a selected render must SET it, or the removals below prove nothing',
    ).toBe(true);

    view.render(vmOf([]));
    expect(
      rows.hasAttribute('aria-activedescendant'),
      'an empty list has no active descendant — REMOVE the attribute, never set it to ""',
    ).toBe(false);
    expect(rows.getAttribute('aria-activedescendant')).toBeNull();

    // A hand-built view-model where EVERY row is selected:false. buildMenuViewModel never
    // produces one today, but render() is total and must not invent a pointer.
    view.render(vmOf([row(0, 'Party'), row(1, 'World')]));
    expect(
      rows.hasAttribute('aria-activedescendant'),
      'no row selected means no active descendant',
    ).toBe(false);

    view.render(CATEGORY_VM);
    expect(
      rows.getAttribute('aria-activedescendant'),
      'the pointer must come BACK once a row is selected again',
    ).not.toBeNull();
  });

  it('MV-A11Y-ACTIVEDESC-LEVEL-01 BITES: the pointer VALUE changes when the menu descends a level, even though BOTH levels select row.index 0', () => {
    // THE P1 TOOTH — the one that was missing, and the reason the defect shipped past a green
    // 37/37 suite. WRONG IMPL KILLED: `aria-activedescendant = menu-option-${row.index}`, with
    //   no level qualifier. `buildMenuViewModel` (ui/menuModel.ts:320-349) emits `index` = the
    //   ARRAY POSITION at BOTH levels, so the categories list with Party selected and Party's
    //   leaf list with Monster Box selected BOTH produce index 0 — and therefore, pre-fix, the
    //   IDENTICAL string. NVDA, JAWS and VoiceOver key their option announcement on a CHANGE of
    //   the aria-activedescendant VALUE, so an unchanged string is SILENCE: the menu descends a
    //   level, the whole list is replaced, the heading changes, and a screen-reader user is told
    //   nothing at all. And this is not an edge case — KeyM then Enter, landing in the first
    //   submenu, is the DEFAULT path into the menu.
    // Every OTHER activedescendant test in this file re-renders WITHIN one level, which is
    //   exactly why they all passed the broken impl.
    const { view } = newView();
    const rows = rowsEl();

    view.render(vmOf([row(0, 'Party', null, true), row(1, 'World')]));
    const atCategories = rows.getAttribute('aria-activedescendant');
    expect(
      atCategories,
      'precondition: the categories level must point at its selected row (index 0)',
    ).not.toBeNull();

    // Descend: same row.index 0, different LEVEL. This is KeyM-then-Enter.
    view.render(
      vmOf(
        [row(0, 'Monster Box', 'B', true), row(1, 'Backpack & Raising', 'I')],
        'Party',
        'Escape / ← — back',
        'leaves',
      ),
    );
    const atLeaves = rows.getAttribute('aria-activedescendant');
    expect(atLeaves, 'the leaf level must point at its selected row too').not.toBeNull();

    expect(
      atLeaves,
      'THE P1 BITE: descending a level MUST change the aria-activedescendant value — an ' +
        'unchanged string is announced as nothing at all',
    ).not.toBe(atCategories);

    // ...and it must still be a real, live, selected option — a "change" produced by pointing
    // at a node that does not exist would be worse than the silence it replaces.
    const el = document.getElementById(atLeaves ?? '');
    expect(el, 'the new IDREF must resolve to a live element').not.toBeNull();
    expect(el?.tagName).toBe('LI');
    expect(rows.contains(el), 'the active descendant must live INSIDE the listbox').toBe(true);
    expect(el?.getAttribute('aria-selected')).toBe('true');
    expect(el?.textContent).toBe('B — Monster Box');

    // Back UP a level (Escape / ArrowLeft): the value must change again, and it must be
    // DETERMINISTIC per level rather than a counter that merely differs from last time.
    view.render(vmOf([row(0, 'Party', null, true), row(1, 'World')]));
    const backAtCategories = rows.getAttribute('aria-activedescendant');
    expect(backAtCategories, 'popping back must move the pointer off the leaf row').not.toBe(
      atLeaves,
    );
    expect(
      backAtCategories,
      'the pointer is a pure function of (level, row.index) — the same state gives the same id',
    ).toBe(atCategories);
  });
});

// ===========================================================================
// m23-s6 BLOCK H — overlayA11y wiring on the show()/hide() edge.
// (gates X6-X8; A11Y-13 / A11Y-14 / A11Y-16)
// ===========================================================================

describe('MenuView — overlay a11y wiring on the show/hide edge (m23-s6)', () => {
  beforeEach(() => {
    mountMenuOverlay();
  });

  afterEach(() => {
    teardown();
  });

  /** A focusable OUTSIDE the overlay: the "pre-overlay" element a close must restore to. */
  function outsideSentinel(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.id = OUTSIDE_SENTINEL_ID;
    btn.textContent = 'outside';
    document.body.appendChild(btn);
    return btn;
  }

  it('MV-A11Y-OPEN-ARIA-01 BITES: the first show() from a display:none shell labels the root from OVERLAY_A11Y / t(), and DELEGATES to openOverlayA11y', () => {
    // WRONG IMPL KILLED (1): a show() that stays a bare `style.display = ''` — menuView is the
    //   SIXTEENTH overlay and the only one of OVERLAY_IDS whose view never called the S1
    //   helpers. Without this the listbox never receives focus and aria-activedescendant is
    //   inert, i.e. the rest of this slice announces nothing.
    // WRONG IMPL KILLED (2): a copy-pasted WRONG OverlayId — all 16 catalog values are
    //   distinct, so the aria-label assertion catches it, and so does the id argument.
    // WRONG IMPL KILLED (3): an attribute-only cheat that hand-writes the three attributes with
    //   the right copied literals but ships NO trap, NO return-focus record and NO timer — the
    //   spy call assertion is the mechanism oracle that kills it.
    // NOT ASSERTED AS A LITERAL 'dialog' (plan revision anti-pattern 9): index.html:105 ships
    // role="dialog" STATICALLY and the fixture mirrors it, so a literal role assertion passes a
    // view that calls nothing. aria-label is on NO shell, so its ABSENCE-then-PRESENCE is the
    // non-vacuous half.
    const overlay = document.getElementById(OVERLAY_ID) as HTMLElement;
    expect(
      overlay.hasAttribute('aria-label'),
      'precondition: no shell ships an aria-label, so only a real open can produce one',
    ).toBe(false);

    const { view } = newView();
    expect(
      overlay.hasAttribute('aria-label'),
      'the CONSTRUCTOR must not open anything — the label appears on the show() edge only',
    ).toBe(false);
    expect(view.visible, 'the shell must start hidden, so the first show() IS an edge').toBe(false);

    view.show();

    expect(overlay.getAttribute('role'), 'role must come from OVERLAY_A11Y, not a literal').toBe(
      S6_META.role,
    );
    expect(overlay.getAttribute('aria-modal')).toBe('true');
    const label = overlay.getAttribute('aria-label');
    expect(label, 'the accessible NAME must come from the a11yCopy catalog').toBe(
      t(S6_META.labelKey),
    );
    expect((label ?? '').length, 'an empty name is an UNLABELLED dialog').toBeGreaterThan(0);

    // MECHANISM oracle: its OWN id and its OWN root.
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(S6_ID, overlay);
  });

  it('MV-A11Y-OPEN-FOCUS-01 BITES: both polarities — focus is NOT moved synchronously by show(), and IS on the registry anchor one real macrotask later', async () => {
    // WRONG IMPL KILLED (1): a synchronous focus. The menu opens DURING the KeyM keydown, so a
    //   synchronous focus move lands the very key that opened it inside the newly focused
    //   element (the ui/renameView.ts:101 bug the S1 defer exists to fix). The NEGATIVE polarity
    //   is the only assertion that can see the difference.
    // WRONG IMPL KILLED (2): focusing the overlay, the heading, or the first <li> instead of the
    //   registry anchor. The target is RESOLVED from OVERLAY_A11Y.menuView.initialFocusSelector
    //   at assert time, and identity (`toBe`) is asserted — never `root.contains(active)`, which
    //   passes on any decorative wrapper.
    // WRONG IMPL KILLED (3): a view that focuses anything itself (A11Y-15) — pairs with
    //   MV-NO-FOCUS-CALL, which bans the literal call from this file's source entirely.
    const target = document.querySelector<HTMLElement>(S6_META.initialFocusSelector);
    expect(
      target,
      `ANTI-VACUITY: the fixture must contain the registry anchor ${S6_META.initialFocusSelector}`,
    ).not.toBeNull();

    const { view } = newView();
    view.show();

    expect(document.activeElement, 'the initial focus must NOT land synchronously').not.toBe(
      target,
    );

    await flushMacrotask();

    expect(document.activeElement, 'one real macrotask later it MUST be the anchor').toBe(target);
  });

  it('MV-A11Y-CLOSE-FOCUS-01 BITES: hide() strips the ARIA modal claim and hands focus back to the pre-overlay element', async () => {
    // WRONG IMPL KILLED (1): a hide() that stays a bare `style.display = 'none'` — the overlay
    //   keeps announcing itself as a dialog while invisible, the trap keeps eating Tab, and the
    //   player's focus is stranded on a display:none <ul> (i.e. on <body> in practice), which is
    //   exactly the "all twelve hotkeys are dead" state.
    // WRONG IMPL KILLED (2): closing with a re-supplied root, or with the wrong id — both leave
    //   the real record live. The spy assertion pins the literal `null` fallbackFocus that
    //   ADR-0205 A3 requires of every non-S5 caller.
    // The static role/aria-modal from index.html:105-106 can only be ABSENT if closeOverlayA11y
    // really ran — that is the vacuity-proof half (the m23-s3 V1 attack).
    const overlay = document.getElementById(OVERLAY_ID) as HTMLElement;
    const outside = outsideSentinel();
    outside.focus();
    expect(document.activeElement, 'precondition: focus starts OUTSIDE the overlay').toBe(outside);

    const { view } = newView();
    view.show();
    await flushMacrotask();
    expect(
      document.activeElement,
      'precondition: the open moved focus INTO the overlay, so the restore below is a real move',
    ).toBe(rowsEl());

    view.hide();

    expect(document.activeElement, 'focus must return to the pre-overlay element').toBe(outside);
    expect(
      overlay.hasAttribute('aria-modal'),
      'a display:none node must not keep claiming to be a modal dialog',
    ).toBe(false);
    expect(overlay.hasAttribute('role')).toBe(false);
    expect(overlay.hasAttribute('aria-label')).toBe(false);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S6_ID, null);
  });

  it('MV-A11Y-CLOSE-UNGUARDED-01 BITES: hide() calls the close UNCONDITIONALLY — on a never-shown view, on a repeat hide, and after a real open/close cycle', () => {
    // WRONG IMPL KILLED: `if (wasVisible) closeOverlayA11y('menuView', null)` inside hide()
    //   (plan anti-pattern 8) — i.e. copying show()'s edge guard onto hide(). The asymmetry is
    //   deliberate and it is what helpView.ts:52-58 encodes: show() is EDGE-guarded because a
    //   re-open clears and RE-SCHEDULES the deferred-focus timer, but hide() must close every
    //   single time. A guarded hide() reads `visible === false` and SKIPS the close for exactly
    //   the case that needs it most — a record that has desynchronised from the DOM (S1's named
    //   A13 leak, ui/overlayA11y.ts:55-59). menuView IS a member of BATTLE_FORCE_HIDE
    //   (ui/overlayRegistry.ts:274-283), so main.ts's battle force-hide path really does drive
    //   this close, and if any writer ever sets style.display directly the record survives with
    //   a LIVE capture trap eating every Tab, a pending deferred-focus timer that will steal
    //   focus later, and a return target that expires — permanently, for the rest of the
    //   session. Unguarded, the next hide() HEALS all three, and a close with no record is a
    //   documented pure no-op (ui/overlayA11y.ts:41-45, :136-137), so nothing is risked.
    // ALSO KILLED: a hide() that closes only ONCE per open (a private `#closed` latch), which
    //   the third phase below catches; and a hide() that passes `undefined`, the overlay
    //   element, or the anchor as fallbackFocus — ADR-0205 A3 makes the literal `null` the
    //   obligation of every caller that is not S5.
    const { view } = newView();
    expect(view.visible, 'precondition: this view was NEVER shown').toBe(false);

    // ANTI-VACUITY (1): if `vi.mock('./overlayA11y', { spy: true })` were ever dropped from the
    // top of this file, `closeOverlayA11y` would be the plain production function and every
    // count oracle below would be measuring nothing. Pin that the spy is really installed.
    expect(
      vi.isMockFunction(closeOverlayA11y),
      'ANTI-VACUITY: the overlayA11y module must be spied for the counts below to mean anything',
    ).toBe(true);
    // ANTI-VACUITY (2): the file-level beforeEach sweeps all 16 ids and THEN clears the mocks,
    // so the counts asserted below are attributable to THIS test's hide() calls alone.
    expect(
      vi.mocked(closeOverlayA11y),
      'precondition: the per-test sweep must have left a clean call count',
    ).toHaveBeenCalledTimes(0);

    // PHASE 1 — never shown. A guarded hide() calls the close ZERO times here.
    view.hide();
    expect(
      vi.mocked(closeOverlayA11y),
      'hide() on a NEVER-shown view MUST still close — a guarded hide calls it zero times',
    ).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenLastCalledWith(S6_ID, null);

    // PHASE 2 — repeat hide of an already-hidden overlay. This is the self-heal call.
    view.hide();
    expect(
      vi.mocked(closeOverlayA11y),
      'EVERY hide() closes — the repeat is precisely the call that heals a desynced record',
    ).toHaveBeenCalledTimes(2);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenLastCalledWith(S6_ID, null);

    // PHASE 3 — a real open/close cycle, then one more hide. Kills a close-once latch.
    view.show();
    view.hide();
    view.hide();
    expect(
      vi.mocked(closeOverlayA11y),
      'four hide() calls, four closes — nothing may latch the close off after the first one',
    ).toHaveBeenCalledTimes(4);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenLastCalledWith(S6_ID, null);
  });

  it('MV-A11Y-VISIBLE-READS-DOM-01 BITES: `visible` reads the LIVE DOM, not a private boolean — a direct style write flips it in both directions', () => {
    // WRONG IMPL KILLED — CHEAT-21: `get visible() { return this.#visible; }`, backed by a
    //   private flag that show()/hide() assign. It passes every test that only ever drives the
    //   view through its own API, which — before this test — was every test in this file.
    //   main.ts has ~15 guard lists reading `menuView?.visible` (mutual exclusion via
    //   overlayRegistry probes, the Escape ladder, the movement-input gate), so a getter that
    //   can DISAGREE with the painted DOM desynchronises every one of them at once. This slice
    //   makes it worse, not better: show()'s new edge guard is itself `const wasVisible =
    //   this.visible`, so a stale flag degrades the guard into either "never open again" or
    //   "re-open on every call" — and the second one re-schedules the deferred focus forever.
    //   The desync is not hypothetical: ui/overlayA11y.ts:55-59 names the force-hide path that
    //   writes style.display DIRECTLY, which is exactly what the two writes below simulate.
    const overlay = document.getElementById(OVERLAY_ID) as HTMLElement;
    const { view } = newView();

    view.show();
    expect(view.visible, 'ANTI-VACUITY: the open must have registered at all').toBe(true);

    // The desync: something OTHER than hide() hides the node.
    overlay.style.display = 'none';
    expect(
      view.visible,
      'CHEAT-21: a private-boolean getter still reports TRUE here — the DOM says false, and the ' +
        'DOM is what the player sees and what main.ts must agree with',
    ).toBe(false);

    // ...and back, so the getter is proved to TRACK the node rather than to have latched.
    overlay.style.display = '';
    expect(view.visible, 'the getter must follow the node in both directions').toBe(true);
  });

  it('MV-A11Y-REOPEN-EDGE-01 BITES: show() on an ALREADY-visible overlay does not re-open, and neither does render() — no re-opened record, no yanked focus', async () => {
    // WRONG IMPL KILLED: an UNGUARDED show() — one that calls openOverlayA11y every time
    //   instead of only on the hidden->visible EDGE (`const wasVisible = this.visible` read
    //   BEFORE the display write; the helpView.ts:42-50 shape). A re-open clears and
    //   RE-SCHEDULES the deferred-focus timer (ui/overlayA11y.ts:100-113), so focus is yanked
    //   back into the listbox out of nowhere. It is invisible to every attribute assertion,
    //   which is why it is proved by the sentinel still holding focus AND by the call count.
    // ALSO KILLED: reading `this.visible` AFTER writing style.display — that reads a constant
    //   true and never opens at all, which the call-count assertion catches from the other side.
    // ALSO KILLED — CHEAT-39, red-team's worst survivor: `openOverlayA11y('menuView',
    //   this.#overlay)` parked at the END of render(). It passed every other test in this file,
    //   because every other test either never re-renders after an open or never looks at where
    //   focus went afterwards. In production renderMenu() runs on EVERY arrow key and EVERY
    //   mouse hover, so the record would be torn down and rebuilt continuously — trap
    //   uninstalled and reinstalled, and a fresh deferred-focus timer that drags the player back
    //   to the listbox from wherever they just moved. render() must NEVER open.
    const outside = outsideSentinel();
    const { view } = newView();

    view.show();
    await flushMacrotask();
    expect(document.activeElement, 'precondition: the first open focused the listbox').toBe(
      rowsEl(),
    );
    expect(vi.mocked(openOverlayA11y), 'precondition: exactly one real open').toHaveBeenCalledTimes(
      1,
    );

    outside.focus();
    expect(document.activeElement, 'precondition: focus parked outside the overlay').toBe(outside);

    view.show();
    await flushMacrotask();

    expect(document.activeElement, 'a repeat show() must NOT re-run the deferred focus').toBe(
      outside,
    );
    expect(
      vi.mocked(openOverlayA11y),
      'a repeat show() is NOT an edge — openOverlayA11y must not be called a second time',
    ).toHaveBeenCalledTimes(1);

    // CHEAT-39: two renders while visible — one arrow keypress and one mouse hover, in
    // production terms — must change nothing about the open record or the focus.
    view.render(CATEGORY_VM);
    view.render(PARTY_VM);
    await flushMacrotask();

    expect(
      vi.mocked(openOverlayA11y),
      'CHEAT-39: render() must NEVER open — only the hidden->visible edge of show() may',
    ).toHaveBeenCalledTimes(1);
    expect(
      document.activeElement,
      'CHEAT-39: a re-render must not yank focus back into the listbox',
    ).toBe(outside);
  });
});

// ===========================================================================
// m23-s6 BLOCK I — the delegated keydown and its split ownership.
// (gates X9-X11; A11Y-25 behaviour, A11Y-21 preservation)
// ===========================================================================

describe('MenuView — delegated keydown, split ownership (m23-s6)', () => {
  beforeEach(() => {
    mountMenuOverlay();
  });

  afterEach(() => {
    teardown();
  });

  // The physical codes menuView's own listener OWNS, and the input each must produce.
  // Sourced from menuKeyInput (ui/menuModel.ts:276-296): the WASD aliases are NOT optional.
  const MOVEMENT_CASES: readonly (readonly [string, 'up' | 'down' | 'left'])[] = [
    ['ArrowUp', 'up'],
    ['ArrowDown', 'down'],
    ['ArrowLeft', 'left'],
    ['KeyW', 'up'],
    ['KeyS', 'down'],
    ['KeyA', 'left'],
  ];

  function keydownAt(target: HTMLElement, code: string, repeat = false): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { code, repeat, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e;
  }

  it('MV-KEYNAV-OWNS-01 BITES: each selection-movement key at #menu-rows emits exactly once, is preventDefault-ed, never reaches window — and a SIBLING listener on #menu-rows still runs', () => {
    // WRONG IMPL KILLED (1): no stopPropagation — the same keydown then also reaches main.ts's
    //   window listener (main.ts:1097, menu intercept at :1131) and handleMenuInput runs TWICE
    //   per press, so one ArrowDown moves the selection two rows. An onInput CALL COUNT cannot
    //   see this (the second step happens in main.ts, not here); only the window spy can.
    // WRONG IMPL KILLED (2): stopImmediatePropagation instead of stopPropagation. The two are
    //   behaviourally IDENTICAL for every window-level assertion (red-team: 13/13 attacks
    //   indistinguishable). The ONLY thing that separates them is a second listener registered
    //   on #menu-rows ITSELF after construction — stopImmediatePropagation silences it. That
    //   matters because ui/focusTrap.ts:150 installs on #menu-overlay in the CAPTURE phase and
    //   a future sibling listener on the <ul> is exactly the kind of thing this file must not
    //   silently break.
    // WRONG IMPL KILLED (3): no preventDefault — ArrowUp/ArrowDown scroll the overlay under the
    //   selection, and Space/arrow default actions fight the listbox.
    // WRONG IMPL KILLED (4): handling only the Arrow codes and forgetting the WASD aliases (or
    //   re-implementing the code->input mapping inline instead of forwarding menuKeyInput).
    const { view, onInput } = newView();
    const rows = rowsEl();
    const sibling = vi.fn();
    const winSpy = vi.fn();
    rows.addEventListener('keydown', sibling);
    window.addEventListener('keydown', winSpy);
    try {
      view.render(CATEGORY_VM);
      view.show();

      for (const [code, kind] of MOVEMENT_CASES) {
        onInput.mockClear();
        sibling.mockClear();
        winSpy.mockClear();

        const e = keydownAt(rows, code);

        expect(onInput, `${code} must emit exactly one input`).toHaveBeenCalledTimes(1);
        expect(onInput, `${code} must map through menuKeyInput`).toHaveBeenCalledWith({ kind });
        expect(e.defaultPrevented, `${code} must be preventDefault-ed`).toBe(true);
        expect(
          winSpy,
          `${code} must NOT reach a window listener — main.ts would step the menu a second time`,
        ).not.toHaveBeenCalled();
        expect(
          sibling,
          `${code}: a SIBLING listener on #menu-rows must still run — stopPropagation, ` +
            'NEVER stopImmediatePropagation',
        ).toHaveBeenCalledTimes(1);
      }
    } finally {
      rows.removeEventListener('keydown', sibling);
      window.removeEventListener('keydown', winSpy);
    }
  });

  it('MV-KEYNAV-BUBBLES-01 BITES: Enter, ArrowRight, Escape, an unrecognised code and an OS key-repeat are NOT consumed — no emission, not prevented, and they still reach window', () => {
    // WRONG IMPL KILLED (1) — THE OVER-BROAD STOP: consuming all five menuKeyInput kinds.
    //   `enter` and `escape` are the ONLY two inputs that can close the menu or activate a leaf,
    //   and they are deliberately left to bubble so main.ts keeps ownership of them behind
    //   sessionGateBlocks()-first (main.ts:1102, W-M21B2-SESSION-GATE-FIRST / ADR-0182 D17 G20)
    //   and the Escape ladder. A menuView that swallows them routes a guarded action around the
    //   session gate. This cheat passes 21/21 of the pre-existing tests (measured).
    // WRONG IMPL KILLED (2) — A STOP PLACED ABOVE THE `undefined` CHECK: KeyM is the case that
    //   catches it, and the reason it is in this list. It is the only code here that
    //   `menuKeyInput` does not recognise AT ALL, so it is precisely what an impl that stops the
    //   event before the `input === undefined` check would swallow — and it is the menu's own
    //   toggle key, so swallowing it takes away one of the only two ways to dismiss the menu
    //   while the listbox holds focus (Escape, asserted just above, is the other).
    // WRONG IMPL KILLED (3) — THE REPEAT LEAK: a missing `e.repeat` guard. It does not cause
    //   scrolling (main.ts:1103-1106 suppresses that first) — it causes SELECTION key-repeat,
    //   which main.ts:1129-1130 explicitly forbids. Asserted as "no emission", not as
    //   defaultPrevented.
    // ArrowRight is here because menuKeyInput maps it to `enter` (ui/menuModel.ts:284-287), so
    // an impl that filters on the CODE instead of on the resolved input kind reds.
    const { view, onInput } = newView();
    const rows = rowsEl();
    const winSpy = vi.fn();
    window.addEventListener('keydown', winSpy);
    try {
      view.render(CATEGORY_VM);
      view.show();

      const cases: readonly (readonly [string, boolean])[] = [
        ['Enter', false],
        ['ArrowRight', false],
        ['Escape', false],
        ['KeyM', false],
        ['ArrowDown', true],
      ];

      for (const [code, repeat] of cases) {
        onInput.mockClear();
        winSpy.mockClear();

        const e = keydownAt(rows, code, repeat);
        const label = repeat ? `${code} (repeat)` : code;

        expect(onInput, `${label} must NOT be consumed by the view`).not.toHaveBeenCalled();
        expect(e.defaultPrevented, `${label} must NOT be preventDefault-ed`).toBe(false);
        expect(
          winSpy,
          `${label} must still reach the window listener that owns it`,
        ).toHaveBeenCalledTimes(1);
      }

      // ANTI-VACUITY CONTROL. Every assertion above also passes on a view with NO keydown
      // listener at all. This last dispatch proves the listener EXISTS and is selective, so the
      // five negatives above are a real filter rather than a missing feature.
      onInput.mockClear();
      winSpy.mockClear();
      const control = keydownAt(rows, 'ArrowDown');
      expect(
        onInput,
        'ANTI-VACUITY: a non-repeat ArrowDown IS owned by the view',
      ).toHaveBeenCalledTimes(1);
      expect(onInput).toHaveBeenCalledWith({ kind: 'down' });
      expect(control.defaultPrevented).toBe(true);
      expect(winSpy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', winSpy);
    }
  });

  it('MV-KEYNAV-HIDDEN-01 BITES: with the overlay hidden a selection key is not consumed — no emission, not prevented, and it still reaches window', () => {
    // WRONG IMPL KILLED: a keydown handler with no `!this.visible` guard. #menu-rows is a real
    //   element in the document whether or not the overlay is displayed, and it stays FOCUSABLE
    //   (index.html:117 ships tabindex="0"), so a key pressed while it holds focus after a close
    //   would step a menu the player cannot see AND swallow that key from every other handler —
    //   the movement keys are also the world-movement keys (WASD).
    // The positive control at the end is what stops this test passing vacuously on an impl that
    // has no keydown listener at all.
    const { view, onInput } = newView();
    const rows = rowsEl();
    const winSpy = vi.fn();
    window.addEventListener('keydown', winSpy);
    try {
      view.render(CATEGORY_VM);
      view.hide();
      expect(view.visible, 'precondition: the overlay is hidden').toBe(false);

      const e = keydownAt(rows, 'ArrowDown');

      expect(onInput, 'a hidden menu must emit nothing').not.toHaveBeenCalled();
      expect(e.defaultPrevented, 'a hidden menu must leave the event completely untouched').toBe(
        false,
      );
      expect(winSpy, 'the key must reach the world/window handlers').toHaveBeenCalledTimes(1);

      // ANTI-VACUITY CONTROL: the very same key, with the overlay SHOWN, IS consumed.
      onInput.mockClear();
      winSpy.mockClear();
      view.show();
      const shown = keydownAt(rows, 'ArrowDown');
      expect(
        onInput,
        'ANTI-VACUITY: the listener must exist and fire when visible',
      ).toHaveBeenCalledTimes(1);
      expect(shown.defaultPrevented).toBe(true);
    } finally {
      window.removeEventListener('keydown', winSpy);
    }
  });

  it('MV-KEYNAV-EFFECT-INERT-01 BITES: every input menuView consumes is provably INERT — menuStep(up|down|left) can only ever produce effect {kind:"none"}', () => {
    // THE SPLIT-OWNERSHIP SAFETY PROOF, MECHANISED. menuView consuming a key is only safe
    // because the three inputs it owns can never close the menu, activate a leaf, or reach a
    // reducer: handleMenuInput (main.ts:650-661) maps 'none' to renderMenu() alone. That is a
    // property of menuModel, not of menuView.
    // WRONG IMPL KILLED: a FUTURE menuModel edit — ui/menuModel.ts:245-248 explicitly
    //   contemplates the one that would break it ("closing here would let a stray ArrowLeft
    //   dismiss the menu"). The day `left` at the categories level starts returning
    //   {kind:'close'}, menuView's stopPropagation would route a dismissal around main.ts's
    //   session gate and its key-repeat guard, silently. This test reds THIS slice's suite then,
    //   which is the only place the coupling is visible.
    const availabilities: readonly MenuAvailability[] = [
      { hasInteractTarget: false, hasTradeTargets: false, hasPvpTargets: false },
      { hasInteractTarget: true, hasTradeTargets: true, hasPvpTargets: true },
      { hasInteractTarget: true, hasTradeTargets: false, hasPvpTargets: true },
    ];
    const inputs = [{ kind: 'up' }, { kind: 'down' }, { kind: 'left' }] as const;

    // Every representable nav state: both levels, every category, every leaf.
    const states: MenuNavState[] = [];
    for (let c = 0; c < MENU_TREE.length; c++) {
      states.push({ level: 'categories', categoryIndex: c });
      const leaves = MENU_TREE[c]!.leaves;
      for (let l = 0; l < leaves.length; l++) {
        states.push({ level: 'leaves', categoryIndex: c, leafIndex: l });
      }
    }

    let cases = 0;
    for (const state of states) {
      for (const availability of availabilities) {
        for (const input of inputs) {
          const step = menuStep(state, input, availability);
          expect(
            step.effect.kind,
            `${input.kind} at ${state.level}/${JSON.stringify(state)} must be INERT`,
          ).toBe('none');
          cases++;
        }
      }
    }

    // ANTI-VACUITY: an empty (or trivially small) cross-product would pass the loop above
    // without proving anything. 5 categories + 12 leaves = 17 states x 3 availabilities x 3
    // inputs = 153.
    expect(
      states.length,
      'ANTI-VACUITY: both levels of the whole tree must be enumerated',
    ).toBeGreaterThanOrEqual(15);
    expect(cases, 'ANTI-VACUITY: the cross-product must be non-trivial').toBeGreaterThanOrEqual(
      100,
    );

    // POSITIVE CONTROL: 'none' is NOT what menuStep returns for everything, so the assertion
    // above is a real property of the three consumed inputs and not a tautology.
    const control = menuStep(MENU_INITIAL, { kind: 'escape' }, availabilities[0]!);
    expect(
      control.effect.kind,
      'CONTROL: escape at the top level DOES produce a non-inert effect — which is exactly why ' +
        'menuView must leave it to bubble',
    ).not.toBe('none');
    expect(control.effect.kind).toBe('close');
  });
});

// ===========================================================================
// m23-s6 BLOCK J — source pins (gates X12, X13, plus the fix-cycle-1 SSOT pins).
// ===========================================================================

describe('MenuView — m23-s6 source pins (A11Y-15, A11Y-25 shape)', () => {
  // Comment delimiters, COMPOSED rather than written out (the client/src/render/world.test.ts
  // :32-39 precedent), so this file contains no raw block-comment opener outside a real
  // comment — a measured false-RED class in the repo's source-concatenating scanners.
  const SLASH = '/';
  const STAR = '*';
  const LINE_OPEN = SLASH + SLASH;
  const BLOCK_OPEN = SLASH + STAR;
  const BLOCK_CLOSE = STAR + SLASH;

  /** Strip line and block comments (the render/world.test.ts:41-60 stripper, COPIED rather than
   *  imported — that file exports nothing). String-literal-BLIND on purpose: the needles under
   *  test ARE string literals, so a string-aware pass would eat them. */
  function stripComments(src: string): string {
    let out = '';
    let i = 0;
    while (i < src.length) {
      const two = src.slice(i, i + 2);
      if (two === LINE_OPEN) {
        while (i < src.length && src.charAt(i) !== '\n') i++;
      } else if (two === BLOCK_OPEN) {
        i += 2;
        while (i < src.length && src.slice(i, i + 2) !== BLOCK_CLOSE) i++;
        i += 2;
      } else {
        out += src.charAt(i);
        i++;
      }
    }
    return out;
  }

  /** CONTROL for the stripper itself, called by every test that depends on it. A stripper that
   *  silently returned its input would restore the decoy-comment bypass these PRESENCE pins
   *  exist to close, and nothing else in the file would notice. */
  function assertStripperHasTeeth(): void {
    const decoyLine =
      'const a = 1;' + LINE_OPEN + " el.addEventListener('keydown', f)\nconst b = 2;\n";
    const decoyBlock =
      'const a = 1;' +
      BLOCK_OPEN +
      " el.addEventListener('keydown', f) " +
      BLOCK_CLOSE +
      ' const b = 2;\n';
    const realCall = "el.addEventListener('keydown', (e) => {});\n";
    expect(
      stripComments(decoyLine).includes("addEventListener('keydown'"),
      'CONTROL: a decoy hidden in a line comment must be STRIPPED',
    ).toBe(false);
    expect(
      stripComments(decoyBlock).includes("addEventListener('keydown'"),
      'CONTROL: a decoy hidden in a block comment must be STRIPPED',
    ).toBe(false);
    expect(
      stripComments(realCall).includes("addEventListener('keydown'"),
      'CONTROL: a REAL call outside any comment must SURVIVE stripping',
    ).toBe(true);
    expect(
      stripComments(decoyLine).includes('const b = 2;'),
      'CONTROL: the stripper must not eat the code AFTER a line comment',
    ).toBe(true);
  }

  // Read menuView.ts's raw text. Same pattern as MV-NO-INNERHTML above; String.includes only —
  // the repo bans a dynamic RegExp (ReDoS / detect-non-literal-regexp).
  function readMenuViewSource(): string {
    const viewPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'menuView.ts');
    try {
      return readFileSync(viewPath, 'utf8');
    } catch (err) {
      // Never a silent return — that is the m16.5a vacuous-pass hole.
      throw new Error(
        'client/src/ui/menuView.ts could not be read — post-impl the file must exist: ' +
          String(err),
      );
    }
  }

  function pinAntiVacuity(src: string): void {
    expect(src.length, 'ANTI-VACUITY: menuView.ts must be non-trivial').toBeGreaterThan(200);
    expect(
      src.includes('replaceChildren'),
      'ANTI-VACUITY: menuView.ts must rebuild the row list with replaceChildren',
    ).toBe(true);
    expect(
      src.includes('textContent'),
      'ANTI-VACUITY: menuView.ts must paint text with textContent',
    ).toBe(true);
  }

  it('MV-KEYDOWN-PAIRED-SOURCE BITES: #menu-rows carries BOTH a delegated click and a delegated keydown, and both bodies reference the SAME callback identifier', () => {
    // WRONG IMPL KILLED (1): a click-only row list. This is the SHAPE spec §5.4's GOOD fixture
    //   describes and the shape evals/keyboard-operable-rows.eval.mjs (S10's file, deferred)
    //   will scan for: a click listener with no paired keydown and no native button/anchor
    //   child is a mouse-only control. S6 ships the subject that eval will read, so the shape is
    //   pinned HERE, in the slice that owns the file.
    // WRONG IMPL KILLED (2): a keydown that calls something OTHER than the click's callback —
    //   e.g. a private method that decides navigation locally, which is the ADR-0014 breach the
    //   whole shell exists to avoid. Both bodies must reach `callbacks.onInput`, so it must
    //   occur at least TWICE (once in the click body, once in the keydown body).
    // WRONG IMPL KILLED (3): a keydown bound to `window`/`document` rather than delegated on
    //   the <ul> — that reintroduces the double-step this slice's split ownership prevents.
    // WRONG IMPL KILLED (4) — THE DECOY COMMENT (fix cycle 1): deleting the real listener while
    //   leaving a comment that MENTIONS it. A raw-text `includes` cannot tell the two apart, and
    //   this repo has three measured bypasses of exactly that shape, so every PRESENCE pin below
    //   runs against COMMENT-STRIPPED source. (The BAN pin in MV-NO-FOCUS-CALL deliberately does
    //   the opposite — see its own comment.)
    assertStripperHasTeeth();
    const raw = readMenuViewSource();
    const src = stripComments(raw);
    pinAntiVacuity(src);
    expect(
      src.includes('menu-rows'),
      'ANTI-VACUITY: menuView.ts must be the shell that owns #menu-rows',
    ).toBe(true);

    expect(
      src.includes("addEventListener('click'"),
      'menuView.ts must keep its delegated click listener (in CODE, not in a comment)',
    ).toBe(true);
    expect(
      src.includes("addEventListener('keydown'"),
      'menuView.ts must PAIR the click listener with a delegated keydown listener (in CODE)',
    ).toBe(true);

    const onInputRefs = src.split('callbacks.onInput').length - 1;
    expect(
      onInputRefs,
      'both the click body and the keydown body must reach the SAME callback identifier — at ' +
        'least two references to callbacks.onInput, outside any comment',
    ).toBeGreaterThanOrEqual(2);
  });

  it('MV-SOURCE-SSOT-01 BITES: the listbox name is READ OFF the resolved heading element and the key mapping is DELEGATED to menuKeyInput — neither is re-hard-coded in the DOM shell', () => {
    // Two cheats that are BEHAVIOURALLY UNKILLABLE in happy-dom, which is exactly why they are
    // pinned on comment-stripped source rather than on the DOM.
    // WRONG IMPL KILLED (1) — CHEAT-14: `setAttribute('aria-labelledby', 'menu-heading')`, a
    //   hard-coded IDREF literal in place of `this.#headingEl.id`. Every runtime assertion
    //   agrees with it, because the fixture's heading really does carry that id — so
    //   MV-A11Y-LISTBOX-01 cannot see it. It is plan anti-pattern 12 all the same: a SECOND
    //   source of truth for the identity of an element the constructor already resolved and
    //   already owns a handle to. The view must name the node it actually paints the breadcrumb
    //   into, so the IDREF cannot drift from that node — e.g. when a later shell mounts the
    //   heading itself (the four #app-mounted overlays of S4 already do exactly that for their
    //   own anchors), the resolved-handle form follows and the literal dangles silently.
    // WRONG IMPL KILLED (2) — CHEAT-30: an inline `Record<string, kind>` (or a switch) mapping
    //   codes to inputs, instead of calling `menuKeyInput(e.code)`. It behaves identically
    //   TODAY, and it is the precise ADR-0014 breach the split-ownership design was argued
    //   around: the plan admits importing menuKeyInput into a DOM file ONLY because the
    //   alternative is a second copy of the physical-key mapping living in the shell, where the
    //   next keyboard-layout or alias change silently diverges from menuModel's SSOT.
    assertStripperHasTeeth();
    const raw = readMenuViewSource();
    const src = stripComments(raw);
    pinAntiVacuity(src);

    // CHEAT-14, the positive pin.
    expect(
      src.includes('this.#headingEl.id'),
      'the aria-labelledby IDREF must be READ OFF the heading element the constructor resolved',
    ).toBe(true);
    // CHEAT-14, the negative pin. Exactly ONE occurrence of the quoted id literal is legitimate:
    // the constructor's own getElementById lookup. A hard-coded aria-labelledby adds a SECOND.
    // (The throw message reads `menu-heading missing`, which this needle — which includes the
    // CLOSING quote — deliberately does not match.) The count is also an anti-vacuity clause: a
    // truncated read scores 0 and reds just as loudly as a forgery scores 2.
    const headingIdLiterals = src.split("'menu-heading'").length - 1;
    expect(
      headingIdLiterals,
      'the quoted heading id may appear EXACTLY once (the constructor lookup) — a second ' +
        'occurrence is a hard-coded IDREF, i.e. a second source of truth for that identity',
    ).toBe(1);

    // CHEAT-30: menuKeyInput is the SSOT for code -> input, and it must be CALLED, not merely
    // imported (the import statement carries no parenthesis, so this needle cannot match it).
    expect(
      src.includes('menuKeyInput('),
      'the keydown body must CALL menuKeyInput — an inline code->kind map is a second copy of ' +
        "the physical-key mapping inside a DOM file, which is menuModel's job alone",
    ).toBe(true);
  });

  it('MV-NO-FOCUS-CALL BITES: menuView.ts contains no literal focus call — the single deferred focus lives ONLY in overlayA11y.ts (A11Y-15)', () => {
    // WRONG IMPL KILLED: a view that focuses the listbox itself, in show() or in render().
    //   Two distinct harms, both real: (a) a SYNCHRONOUS focus in show() lands the KeyM that
    //   opened the menu inside the newly focused element (ui/overlayA11y.ts:9-20 — the
    //   renameView.ts:101 bug S1 centralised away); (b) a focus in render() re-focuses the
    //   listbox on EVERY arrow keypress, which cancels nothing but does defeat the whole point
    //   of routing through openOverlayA11y's single owned timer. This slice is the one that
    //   makes menuView a focus-RECEIVING overlay, so the ban has to be pinned in this file.
    // This scan is the ONLY oracle for a focus call on a path no fixture reaches.
    // DELIBERATELY NOT COMMENT-STRIPPED, unlike the PRESENCE pins above (fix cycle 1). The
    // stripping exists because a comment can FORGE evidence that code exists; it must never be
    // used to EXCUSE a banned API, because a comment naming one is a standing invitation to
    // uncomment it, and the A11Y-15 ban is deliberately absolute.
    const src = readMenuViewSource();
    pinAntiVacuity(src);
    expect(
      src.includes('.focus('),
      'menuView.ts must not contain a literal focus call — openOverlayA11y is the sole owner ' +
        'of the deferred focus (A11Y-15, ui/overlayA11y.ts:111-113)',
    ).toBe(false);
  });
});
