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

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MenuRowVm, MenuViewModel } from './menuModel';
import { MenuView } from './menuView';

// ---------------------------------------------------------------------------
// DOM fixture — mirrors the client/index.html block the implementer must deliver
// (plan §4). Deliberately contains NO #menu-launcher and NO #help-hint: the menu is
// the zero-DOM-front-door surface (AC-11), so it must never reach for either.
// ---------------------------------------------------------------------------

const OVERLAY_ID = 'menu-overlay';

function teardown(): void {
  for (const id of [OVERLAY_ID, 'menu-launcher', 'help-hint']) {
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

  if (omit !== 'menu-heading') {
    const heading = document.createElement('div');
    heading.id = 'menu-heading';
    overlay.appendChild(heading);
  }
  if (omit !== 'menu-rows') {
    const rows = document.createElement('ul');
    rows.id = 'menu-rows';
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
