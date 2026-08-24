// @vitest-environment happy-dom
// ui/battleView.test.ts — RED tests for M13.5e e-1: bait select preservation + dup testid.
//
// SOURCE OF TRUTH: M13.5 §5 e-1 (EARS criterion)
//
// RED REASON (test 1 — bait selection preserved):
//   The current #renderActions() unconditionally calls replaceChildren() on #actionsEl and
//   then calls #renderRecruit() which creates a brand-new <select> every refresh. A user
//   selection made between two refresh calls is silently lost because the element is
//   replaced, not updated. After fix: refresh() with the same baitOptions preserves the
//   currently selected value.
//
// RED REASON (test 2 — duplicate data-testid):
//   #renderRecruit() currently writes data-testid via BOTH `select.dataset.testid = 'bait-selector'`
//   AND `select.setAttribute('data-testid', 'bait-selector')`. These two mechanisms are
//   redundant and the first one (dataset.testid) sets the attribute "testid", NOT
//   "data-testid", so they set different attributes. The selector [data-testid="bait-selector"]
//   only matches the setAttribute path. The dataset.testid assignment is a dead write that
//   never surfaces via [data-testid=...] queries. After fix: only one mechanism is used.
//
// WRONG IMPL KILLED (test 1):
//   An impl that calls `this.#actionsEl.replaceChildren()` on every refresh — the bait
//   selector value jumps back to "No bait" after each server tick.
//
// WRONG IMPL KILLED (test 2):
//   An impl that sets data-testid via both `select.dataset.testid = ...` AND
//   `select.setAttribute('data-testid', ...)` — 'testid' in dataset and 'data-testid' in
//   attributes are different attribute names. The duplicate write also signals a code-smell
//   that was caught in review.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BattleViewModel } from './battleModel';
import { BattleView, type BattleViewCallbacks } from './battleView';

// ---------------------------------------------------------------------------
// m23-s4 — overlay a11y wiring for BattleView (constructed-shell, #app-mounted).
// ADDITIVE ONLY: nothing below this block (the entire pre-existing e-1 / m14.5d /
// m14.5d-1b / m16b / ux1-2 / ux4 suite) was weakened or deleted. Declared FIRST in
// the file, before any pre-existing describe (renameView.test.ts precedent), so
// these file-level sweep hooks run before any describe-level ones.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M23-accessibility.spec.md §2.2/§2.3, §6
// (A11Y-13/14/15/16/17); memory/projects/monster-realm-m23-s4-plan.md §0 F1, §1
// D1/D2/D4/D6/D7; memory/projects/gates/m23-s4.gates.md X1/X2/X3/X6/X7/X8.
//
// RED REASON: battleView.ts's show()/hide()/refresh() do not call
// openOverlayA11y/closeOverlayA11y at all today, and its <h2> title carries neither
// data-testid="battle-title" nor tabindex="-1" — every S4-battleView-* test below
// fails now; every pre-existing test below (e-1 onward) still passes.
//
// COMPOSITION NOTE (plan §8 A7): DEFER-FOCUS and CLOSE-RESTORE are NOT separate
// teeth here — DEFER-FOCUS ≡ HELPER-CALLED ∘ S1-DEFER-* (overlayA11y.test.ts already
// proves the defer mechanism for all sixteen ids, folded here into
// S4-battleView-ANCHOR-FOCUS's end-to-end focus-move oracle); CLOSE-RESTORE is
// folded into S4-battleView-CLOSE-RESTORE-UNGUARDED. Their absence as standalone
// tags is a decision, not an omission.
// ---------------------------------------------------------------------------

import { beforeEach } from 'vitest';
import { t } from './a11yCopy';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';

// The m23-s4 MECHANISM oracle. `{ spy: true }` records every call AND calls through
// to the real implementation, so the VALUE oracle (real attribute writes, real focus
// moves) still works.
vi.mock('./overlayA11y', { spy: true });

/** ONE real macrotask boundary — never vi.useFakeTimers() (plan anti-pattern #10). */
async function s4FlushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// File-level sweep (mandatory — see the file header). overlayA11y.ts holds ONE
// module-private Map and exports no reset hook, so this calls the PRODUCTION
// closeOverlayA11y(id, null) for every OverlayId and flushes one real macrotask —
// legal because close-without-open is a documented no-op. This cancels any
// deferred-focus timer / capture listener that a PRE-EXISTING `view.show()` /
// `view.refresh(vm)` call above will schedule once the wiring lands (plan residual
// A12). `vi.clearAllMocks()` runs LAST so the sweep's own calls never pollute a count.
beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await s4FlushMacrotask();
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await s4FlushMacrotask();
});

const S4_ID: OverlayId = 'battleView';
const S4_META = OVERLAY_A11Y[S4_ID];

/** A focusable OUTSIDE the overlay: the "pre-open" element a close must restore focus to. */
function s4OutsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's4-outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

/** A focusable INSIDE the overlay, as a DIRECT child of the root — nothing on the
 *  a11y-only path rebuilds it, so if it loses focus something RE-OPENED the overlay. */
function s4InsideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's4-inside-sentinel';
  root.appendChild(btn);
  return btn;
}

/**
 * OPEN-LAST capture (plan §8 A3, mechanism #1 — the ONLY admissible one here): spy on
 * root.setAttribute and record root.style.display the instant `role` is written — the
 * FIRST attribute openOverlayA11y sets (overlayA11y.ts:106) — then delegate to the real
 * bound setAttribute. A post-hoc read of `mock.calls[...][1].style.display` is PROVABLY
 * VACUOUS (red-team PoC, plan §8 A3): JS is synchronous, so by assertion time both the
 * paint and the open call have already run, in EITHER order, and a post-hoc read passes
 * the correct implementation and an open-before-paint implementation identically. NEVER
 * `vi.importActual('./overlayA11y')` — a second module instance with its own
 * OPEN_OVERLAYS map that silently breaks every close/restore assertion in this file.
 */
function s4CaptureDisplayAtOpen(root: HTMLElement): { display: () => string | undefined } {
  let captured: string | undefined;
  const real = root.setAttribute.bind(root);
  vi.spyOn(root, 'setAttribute').mockImplementation((name: string, value: string) => {
    if (name === 'role' && captured === undefined) captured = root.style.display;
    real(name, value);
  });
  return { display: () => captured };
}

function s4Mount(): { parent: HTMLElement; view: BattleView; callbacks: BattleViewCallbacks } {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const callbacks = makeCallbacks();
  const view = new BattleView(parent, callbacks);
  return { parent, view, callbacks };
}

describe('BattleView — m23-s4 overlay a11y wiring on the show()/hide()/refresh() edge', () => {
  it('S4-battleView-OPEN-ARIA BITES: the first show() from a hidden shell labels the root from OVERLAY_A11Y/t()', () => {
    const { parent, view } = s4Mount();
    const root = parent.firstElementChild as HTMLElement;
    expect(view.visible, 'the shell must start hidden, so show() IS an edge').toBe(false);

    view.show();

    // Every expected value is DERIVED from the table/catalog at assert time — never a literal.
    expect(root.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(S4_META.role);
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(
      root.getAttribute('aria-label'),
      'the constructed root carries NO static ARIA, so aria-label is the value oracle here; ' +
        'because all sixteen catalog labels are distinct this also kills a copy-pasted wrong id',
    ).toBe(t(S4_META.labelKey));
  });

  it('S4-battleView-ANCHOR-FOCUS BITES: the anchor resolves to an <h2 tabindex="-1"> with byte-unchanged text, and focus moves to it after ONE real macrotask (never synchronously)', async () => {
    const { parent, view } = s4Mount();
    const root = parent.firstElementChild as HTMLElement;
    view.show();

    const anchor = root.querySelector<HTMLElement>(S4_META.initialFocusSelector);
    expect(
      anchor,
      `the anchor selector ${S4_META.initialFocusSelector} must resolve`,
    ).not.toBeNull();
    expect(anchor!.tagName).toBe('H2');
    expect(
      anchor!.getAttribute('tabindex'),
      'must be "-1", never "0" — and `title.dataset.testid = ...` sets the attribute ' +
        '"testid", not "data-testid", which would silently no-op this whole lookup',
    ).toBe('-1');
    expect(
      anchor!.textContent,
      'byte-unchanged — client/e2e/recruit.spec.ts keys on this literal overlay title',
    ).toBe('Battle');

    // BOTH polarities (DEFER-FOCUS ≡ HELPER-CALLED ∘ S1-DEFER-*, see file header).
    expect(document.activeElement, 'not focused synchronously').not.toBe(anchor);
    await s4FlushMacrotask();
    expect(document.activeElement, 'focused by IDENTITY after one real macrotask').toBe(anchor);
  });

  it('S4-battleView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    const { parent, view } = s4Mount();
    const root = parent.firstElementChild as HTMLElement;

    view.show();
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(S4_ID, root);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S4_ID, null);
  });

  it('S4-battleView-CLOSE-RESTORE-UNGUARDED BITES: hide() strips all three attributes and restores focus to the pre-open element; hide() on a never-shown view still closes without throwing; show/hide/hide yields exactly two closes', async () => {
    const outside = s4OutsideSentinel();
    outside.focus();
    const { parent, view } = s4Mount();
    const root = parent.firstElementChild as HTMLElement;

    view.show();
    await s4FlushMacrotask();
    expect(document.activeElement, 'precondition: the open moved focus into the overlay').not.toBe(
      outside,
    );

    view.hide();
    expect(
      root.getAttribute('role'),
      'a display:none root must not keep claiming to be a dialog',
    ).toBeNull();
    expect(root.getAttribute('aria-modal')).toBeNull();
    expect(root.getAttribute('aria-label')).toBeNull();
    expect(document.activeElement, 'focus must return to the pre-open element').toBe(outside);

    // hide() on a never-shown view: still closes, does not throw (D2's self-heal).
    const fresh = s4Mount();
    expect(fresh.view.visible).toBe(false);
    expect(() => fresh.view.hide()).not.toThrow();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S4_ID, null);

    // show/hide/hide => exactly TWO close calls. Plan D2 / measured by S3's red-team:
    // guarding hide()'s close ships 62/62 green while permanently leaking a live capture
    // listener, a pending timer and a stale return target.
    vi.clearAllMocks();
    const cycle = s4Mount();
    cycle.view.show();
    cycle.view.hide();
    cycle.view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
  });

  it('S4-battleView-REPEAT-NO-REOPEN BITES: show() on an already-visible overlay neither re-opens nor yanks focus off a sentinel parked inside the root', async () => {
    const { parent, view } = s4Mount();
    const root = parent.firstElementChild as HTMLElement;
    view.show();
    await s4FlushMacrotask();

    const inside = s4InsideSentinel(root);
    inside.focus();
    expect(document.activeElement).toBe(inside);

    view.show();
    await s4FlushMacrotask();

    expect(document.activeElement, 'a repeat open must NOT re-run the deferred focus').toBe(inside);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S4-battleView-OPEN-LAST BITES: openOverlayA11y is invoked with root.style.display ALREADY painted (neither "none" nor "") — never open-before-paint', () => {
    const { parent, view } = s4Mount();
    const root = parent.firstElementChild as HTMLElement;
    const capture = s4CaptureDisplayAtOpen(root);

    view.show();

    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(
      capture.display(),
      'root.style.display AT THE INSTANT of the first setAttribute call inside openOverlayA11y',
    ).not.toBe('none');
    expect(capture.display()).not.toBe('');
  });

  it('S4-battleView-REFRESH-EDGES BITES: refresh(null) on a fresh view calls close (never open) without throwing; refresh(vm) opens exactly once; a repeat refresh(vm) does not re-open (D4: no second edge check bolted into refresh()); refresh(null) then closes', () => {
    const { view } = s4Mount();

    expect(() => view.refresh(null)).not.toThrow();
    expect(vi.mocked(openOverlayA11y)).not.toHaveBeenCalled();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S4_ID, null);

    vi.clearAllMocks();
    view.refresh(makeRecruitVM());
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);

    view.refresh(makeRecruitVM());
    expect(
      vi.mocked(openOverlayA11y),
      "D4: refresh(vm)'s `if (!this.#visible) this.show()` must delegate to the now-guarded " +
        'show() rather than adding a second, independent nullity check',
    ).toHaveBeenCalledTimes(1);

    view.refresh(null);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Minimal BattleViewModel factory for recruit / wild-battle scenario.
// canRecruit=true + baitOptions populated simulates an ongoing wild battle.
// ---------------------------------------------------------------------------
function makeRecruitVM(overrides: Partial<BattleViewModel> = {}): BattleViewModel {
  return {
    battleId: 1n,
    turnNumber: 1,
    outcome: 'Ongoing',
    playerCard: {
      speciesName: 'TestMon',
      level: 5,
      currentHp: 20,
      maxHp: 20,
      hpPercent: 100,
      affinity: 'Fire',
      status: null,
    },
    opponentCard: {
      speciesName: 'WildMon',
      level: 3,
      currentHp: 15,
      maxHp: 15,
      hpPercent: 100,
      affinity: 'Water',
      status: null,
    },
    skills: [],
    canFlee: true,
    canSwap: false,
    bench: [],
    canRecruit: true,
    baitOptions: [
      { itemId: 7, name: 'Lure Berry', recruitBonus: 150, count: 3 },
      { itemId: 9, name: 'Sweet Bait', recruitBonus: 250, count: 1 },
    ],
    weather: null,
    // m14.5d-1b: cureItems field — empty by default; cure-item tests supply a real value via makeCureItemVM.
    cureItems: [],
    ...overrides,
  };
}

function makeCallbacks(): BattleViewCallbacks {
  return {
    onAttack: vi.fn(),
    onFlee: vi.fn(),
    onSwap: vi.fn(),
    onRecruit: vi.fn(),
    onUseItem: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// e-1 test 1: bait selection survives a re-render with the same VM
//
// BITES: an impl that unconditionally replaceChildren() the actionsEl will
// destroy the user's selected option and reset the select to its first option.
// ---------------------------------------------------------------------------
describe('BattleView e-1: bait selection preserved across re-renders (same VM)', () => {
  it('BITES: user-selected bait value is still set after calling refresh() again with the same vm', () => {
    // RED REASON: #renderActions() calls replaceChildren() every refresh, which
    // destroys the <select> element and creates a new one at "No bait" value.
    // After fix: the existing <select> is reused (or at least its value restored)
    // when baitOptions haven't changed.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    const vm = makeRecruitVM();

    // First render: creates the bait selector
    view.refresh(vm);
    view.show();

    const selectAfterFirst = parent.querySelector<HTMLSelectElement>(
      '[data-testid="bait-selector"]',
    );
    expect(selectAfterFirst).not.toBeNull();
    // Simulate the user selecting bait item 7 ("Lure Berry")
    selectAfterFirst!.value = '7';
    expect(selectAfterFirst!.value).toBe('7'); // precondition: selection was applied

    // Second refresh with the SAME vm (same baitOptions — no server change)
    view.refresh(vm);

    const selectAfterSecond = parent.querySelector<HTMLSelectElement>(
      '[data-testid="bait-selector"]',
    );
    expect(selectAfterSecond).not.toBeNull();

    // BITES: current impl replaces the element → value resets to '' (No bait).
    // After fix: value must still be '7' (the user's prior selection is preserved).
    expect(selectAfterSecond!.value).toBe('7');

    // Cleanup
    document.body.removeChild(parent);
  });

  it('BITES: bait value survives three consecutive re-renders with an identical vm', () => {
    // Proves the fix is not a one-off: even repeated re-renders must not destroy the selection.
    // WRONG IMPL KILLED: replaceChildren() on every refresh always resets to first option.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    const vm = makeRecruitVM();

    view.refresh(vm);
    view.show();

    // User selects the second bait option (itemId=9)
    const sel = parent.querySelector<HTMLSelectElement>('[data-testid="bait-selector"]')!;
    sel.value = '9';

    // Three more refreshes — same vm
    view.refresh(vm);
    view.refresh(vm);
    view.refresh(vm);

    const selFinal = parent.querySelector<HTMLSelectElement>('[data-testid="bait-selector"]')!;
    // After fix: still '9'. Current impl: reset to '' on each refresh.
    expect(selFinal.value).toBe('9');

    document.body.removeChild(parent);
  });
});

// ---------------------------------------------------------------------------
// e-1 test 2: data-testid duplicate mechanism bug
//
// The current code does BOTH:
//   select.dataset.testid = 'bait-selector';     // sets attribute "testid" (NOT "data-testid")
//   select.setAttribute('data-testid', 'bait-selector'); // sets attribute "data-testid"
//
// These set TWO DIFFERENT attributes. The dataset.testid line is a bug (a typo for
// dataset['testid'] which maps to the attribute 'testid'). After fix: only
// setAttribute('data-testid', ...) remains (or only dataset['testid'] is removed).
//
// BITES test: after fix there must be EXACTLY ONE attribute named 'data-testid'
// (not zero, not two distinct 'data-testid' writes), and the spurious 'testid'
// attribute (from dataset.testid) must NOT exist.
// ---------------------------------------------------------------------------
describe('BattleView e-1: bait-selector data-testid set exactly ONCE via one mechanism', () => {
  it('BITES: select has no spurious "testid" attribute (dataset.testid typo is removed)', () => {
    // RED REASON: current code sets `select.dataset.testid = 'bait-selector'` which
    // creates the attribute "testid" (lowercase, no "data-" prefix). The
    // setAttribute line separately sets "data-testid". After fix: the dataset.testid
    // line is removed, so only "data-testid" exists — no spurious "testid" attribute.
    // WRONG IMPL KILLED: any impl that writes to select.dataset.testid.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    view.refresh(makeRecruitVM());
    view.show();

    const sel = parent.querySelector<HTMLSelectElement>('[data-testid="bait-selector"]');
    expect(sel).not.toBeNull();

    // After fix: spurious 'testid' attribute must NOT be present.
    // Current impl sets `select.dataset.testid = ...` which creates the 'testid' attribute.
    expect(sel!.hasAttribute('testid')).toBe(false);

    document.body.removeChild(parent);
  });

  it('BITES: data-testid=bait-selector appears exactly ONCE on the select element', () => {
    // Verify the query finds exactly one element — the two-mechanism write creates
    // only one element but that one element has both "testid" and "data-testid",
    // which is the issue this test encodes. After fix: the element exists and
    // carries only "data-testid", not both.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    view.refresh(makeRecruitVM());
    view.show();

    const selectors = parent.querySelectorAll('[data-testid="bait-selector"]');
    // Must be exactly ONE select element with data-testid=bait-selector.
    expect(selectors).toHaveLength(1);
    // That element must be a SELECT (not some other element)
    expect(selectors[0]!.tagName).toBe('SELECT');

    document.body.removeChild(parent);
  });

  it('BITES: recruit action button still present after bait selector fix', () => {
    // Regression guard: the fix for the bait selector must not remove the Recruit button.
    // WRONG IMPL KILLED: an over-zealous fix that removes the recruit render entirely.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    view.refresh(makeRecruitVM());
    view.show();

    const btn = parent.querySelector('[data-testid="recruit-action"]');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Recruit');

    document.body.removeChild(parent);
  });
});

// =============================================================================
// m14.5d — weather banner DOM tests (14.5d-2)
// SOURCE OF TRUTH: specs/monster-realm-v2/M14.5-eighth-review-residuals.spec.md §14.5d-2
//
// RED REASON: BattleView does not yet render a weather banner element.
// `data-testid="weather-banner"` does not exist in the current DOM output.
//
// Contract (plan Design Decision C):
//   - `vm.weather` non-null → element [data-testid="weather-banner"] visible,
//     textContent contains the label AND the turnsRemaining number.
//   - `vm.weather` null → element absent or hidden.
// =============================================================================

/** Minimal VM with weather set — extends makeRecruitVM for all required fields. */
function makeVMWithWeather(label: string, turnsRemaining: number): BattleViewModel {
  return makeRecruitVM({
    // weather field is new in m14.5d; absent in old factory, present via overrides.
    weather: { label, turnsRemaining },
  } as Partial<BattleViewModel>);
}

function makeVMNoWeather(): BattleViewModel {
  return makeRecruitVM({
    weather: null,
  } as Partial<BattleViewModel>);
}

describe('BattleView m14.5d: weather banner DOM rendering', () => {
  it('BITES: vm.weather non-null → [data-testid="weather-banner"] present and text contains label and turnsRemaining', () => {
    // Kills: an impl that adds weatherBanner to the model but forgets to render
    // the DOM element, or that renders it without the turnsRemaining number.
    // RED: data-testid="weather-banner" does not exist in current battleView.ts.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    const vm = makeVMWithWeather('Rain', 2);
    view.refresh(vm);
    view.show();

    const banner = parent.querySelector('[data-testid="weather-banner"]');
    expect(banner).not.toBeNull();
    // Text must contain the label (e.g. "Rain") and the turn count (2).
    expect(banner!.textContent).toContain('Rain');
    expect(banner!.textContent).toContain('2');

    document.body.removeChild(parent);
  });

  it('BITES: vm.weather null → [data-testid="weather-banner"] absent or hidden', () => {
    // Kills: an impl that always renders the banner regardless of vm.weather.
    // The banner must not appear when there is no active weather.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    const vm = makeVMNoWeather();
    view.refresh(vm);
    view.show();

    const banner = parent.querySelector('[data-testid="weather-banner"]');
    // Either the element must be absent entirely, or it must have display:none.
    if (banner !== null) {
      const style = (banner as HTMLElement).style.display;
      expect(style).toBe('none');
    }
    // If absent: that also satisfies the contract (passes through the if branch).

    document.body.removeChild(parent);
  });

  it('BITES: weather banner disappears when vm transitions from weather→no-weather', () => {
    // Kills: an impl that only hides the banner on initial render but forgets
    // to update it on subsequent refreshes.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());

    // First render: weather present
    view.refresh(makeVMWithWeather('Sun', 5));
    view.show();
    const bannerAfterWeather = parent.querySelector('[data-testid="weather-banner"]');
    expect(bannerAfterWeather).not.toBeNull();

    // Second render: no weather
    view.refresh(makeVMNoWeather());
    const bannerAfterClear = parent.querySelector('[data-testid="weather-banner"]');
    if (bannerAfterClear !== null) {
      expect((bannerAfterClear as HTMLElement).style.display).toBe('none');
    }

    document.body.removeChild(parent);
  });
});

// =============================================================================
// m14.5d — outcome text DOM parity (14.5d-3)
// SOURCE OF TRUTH: specs/monster-realm-v2/M14.5-eighth-review-residuals.spec.md §14.5d-3
//
// RED REASON: the existing `#renderOutcome` default arm currently renders a
// generic fallback text for unknown outcomes (e.g. 'Battle ended: Draw').
// After m14.5d: buildBattleViewModel returns null for unknown outcomes, so the
// view never receives an unknown outcome VM. The never-check (review refinement 5)
// replaces the default arm. These tests verify the DOM parity:
//   - Each of SideAWins/SideBWins/Fled renders a non-empty outcome text.
//   - 'Ongoing' renders NO outcome banner (display:none or element absent).
//
// The outcome type narrowing (BattleOutcomeTag) makes the switch exhaustive.
// =============================================================================

/** Build a minimal VM with a given terminal outcome. */
function makeTerminalVM(outcome: 'SideAWins' | 'SideBWins' | 'Fled'): BattleViewModel {
  return makeRecruitVM({
    outcome,
    canFlee: false,
    canRecruit: false,
    canSwap: false,
    weather: null,
  } as Partial<BattleViewModel>);
}

describe('BattleView m14.5d: outcome DOM parity — all BattleOutcomeTag variants', () => {
  it('BITES: outcome="SideAWins" → [data-testid="outcome-text"] visible with non-empty text', () => {
    // Kills: an impl where the SideAWins case produces empty text or hides the element.
    // Precision upgrade: query by data-testid instead of scanning all divs for inline CSS.
    // The specialist adds data-testid="outcome-text" to the outcome element in battleView.ts.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    view.refresh(makeTerminalVM('SideAWins'));
    view.show();

    const outcomeEl = parent.querySelector('[data-testid="outcome-text"]') as HTMLElement | null;
    // Element must be present (specialist adds the testid).
    expect(outcomeEl).not.toBeNull();
    // Must be visible (not display:none) and carry non-empty text.
    expect(outcomeEl!.style.display).not.toBe('none');
    expect(outcomeEl!.textContent!.trim().length).toBeGreaterThan(0);

    document.body.removeChild(parent);
  });

  it('BITES: outcome="SideBWins" → [data-testid="outcome-text"] visible with non-empty text', () => {
    // Kills: an impl missing the SideBWins case in #renderOutcome.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    view.refresh(makeTerminalVM('SideBWins'));
    view.show();

    const outcomeEl = parent.querySelector('[data-testid="outcome-text"]') as HTMLElement | null;
    expect(outcomeEl).not.toBeNull();
    expect(outcomeEl!.style.display).not.toBe('none');
    expect(outcomeEl!.textContent!.trim().length).toBeGreaterThan(0);

    document.body.removeChild(parent);
  });

  it('BITES: outcome="Fled" → [data-testid="outcome-text"] visible with non-empty text', () => {
    // Kills: an impl missing the Fled case in #renderOutcome.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    view.refresh(makeTerminalVM('Fled'));
    view.show();

    const outcomeEl = parent.querySelector('[data-testid="outcome-text"]') as HTMLElement | null;
    expect(outcomeEl).not.toBeNull();
    expect(outcomeEl!.style.display).not.toBe('none');
    expect(outcomeEl!.textContent!.trim().length).toBeGreaterThan(0);

    document.body.removeChild(parent);
  });

  it('BITES: outcome="Ongoing" → [data-testid="outcome-text"] hidden (display:none or empty text)', () => {
    // Kills: an impl that shows the outcome banner during an ongoing battle.
    // The outcome banner must be hidden while the battle is in progress.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    // Use the existing VM with outcome:'Ongoing'
    view.refresh(makeRecruitVM({ weather: null } as Partial<BattleViewModel>));
    view.show();

    const outcomeEl = parent.querySelector('[data-testid="outcome-text"]') as HTMLElement | null;
    // The element must be absent or hidden for 'Ongoing'.
    if (outcomeEl !== null) {
      // If present, it must be hidden (display:none) OR carry empty text.
      const isHidden = outcomeEl.style.display === 'none';
      const isEmpty = outcomeEl.textContent!.trim().length === 0;
      expect(isHidden || isEmpty).toBe(true);
    }
    // If absent entirely: that also satisfies the "no outcome shown" contract.

    document.body.removeChild(parent);
  });
});

// =============================================================================
// m14.5d-1b — cure-item selector DOM tests
// SOURCE OF TRUTH: specs/monster-realm-v2/M14.5-eighth-review-residuals.spec.md §14.5d-1
//
// RED REASON:
//   - BattleViewModel.cureItems does not yet exist.
//   - BattleViewCallbacks.onUseItem does not yet exist.
//   - BattleView does not yet render a [data-testid="cure-item-selector"] element.
//   - BattleView does not yet render a [data-testid="use-item-action"] button.
//
// Contract (classify-by-data, mirroring bait-selector pattern):
//   - `vm.cureItems` non-empty + outcome=Ongoing → cure-item selector rendered
//   - Selector has one <option> per cure item (value=itemId, text includes name)
//   - [data-testid="use-item-action"] button present when cure items available
//   - Clicking button calls onUseItem(battleId, selectedItemId)
//   - `vm.cureItems` empty → selector absent
//   - Selection preserved across re-renders with the same VM (same class of bug as
//     bait-selector fix — replaceChildren() destroys user selection on every tick)
// =============================================================================

/** CureItem shape (as it will exist after the feature is implemented). */
interface CureItemVM {
  itemId: number;
  name: string;
  cureStatus: string;
  count: number;
}

/** Build a VM with a populated cureItems list for cure-item DOM tests. */
function makeCureItemVM(cureItems: CureItemVM[]): BattleViewModel {
  return makeRecruitVM({
    cureItems,
    canRecruit: false, // independent of recruit to keep tests focused
    baitOptions: [],
  });
}

describe('BattleView m14.5d-1b: cure-item selector rendered when cureItems non-empty (ongoing)', () => {
  it('BITES: [data-testid="cure-item-selector"] present when vm.cureItems has entries', () => {
    // Kills: an impl that adds cureItems to the model but forgets to render the selector.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    const vm = makeCureItemVM([{ itemId: 5, name: 'Antidote', cureStatus: 'Poison', count: 2 }]);
    view.refresh(vm);
    view.show();

    const selector = parent.querySelector('[data-testid="cure-item-selector"]');
    expect(selector).not.toBeNull();
    // Kills: an impl that doesn't render the selector at all

    document.body.removeChild(parent);
  });

  it('BITES: cure-item selector has an option with value "5" and text including "Antidote"', () => {
    // Kills: an impl that renders the selector but populates it with wrong values
    // (e.g., uses index instead of itemId as option value).
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    const vm = makeCureItemVM([{ itemId: 5, name: 'Antidote', cureStatus: 'Poison', count: 2 }]);
    view.refresh(vm);
    view.show();

    const selector = parent.querySelector('[data-testid="cure-item-selector"]');
    expect(selector).not.toBeNull();
    const option = selector!.querySelector('option[value="5"]');
    expect(option).not.toBeNull();
    expect(option!.textContent).toContain('Antidote');
    // Kills: an impl that uses index as option value, or forgets the item name

    document.body.removeChild(parent);
  });

  it('BITES: cure-item option carries data-cure-status attribute (ADR-0047 classify-by-data contract surface)', () => {
    // ADR-0047: classify-by-data requires the contract surface to be present on the DOM
    // so that future tools/evals can verify the classification without parsing option text.
    // Kills: an impl that omits setAttribute('data-cure-status', ...) from the option.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    const vm = makeCureItemVM([{ itemId: 5, name: 'Antidote', cureStatus: 'Poison', count: 2 }]);
    view.refresh(vm);
    view.show();

    const selector = parent.querySelector('[data-testid="cure-item-selector"]');
    expect(selector).not.toBeNull();
    const option = selector!.querySelector('option[value="5"]') as HTMLOptionElement | null;
    expect(option).not.toBeNull();
    expect(option!.getAttribute('data-cure-status')).toBe('Poison');

    document.body.removeChild(parent);
  });
});

describe('BattleView m14.5d-1b: use-item-action button present when cureItems non-empty', () => {
  it('BITES: [data-testid="use-item-action"] present when vm.cureItems has entries', () => {
    // Kills: an impl that renders the selector but omits the action button.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    const vm = makeCureItemVM([{ itemId: 5, name: 'Antidote', cureStatus: 'Poison', count: 2 }]);
    view.refresh(vm);
    view.show();

    const btn = parent.querySelector('[data-testid="use-item-action"]');
    expect(btn).not.toBeNull();
    // Kills: an impl that renders the selector but forgets the button

    document.body.removeChild(parent);
  });
});

describe('BattleView m14.5d-1b: onUseItem called with correct (battleId, itemId) on button click', () => {
  it('BITES: clicking "Use Item" calls onUseItem(1n, 5) — battleId=1n, itemId=5 (not index)', () => {
    // Kills: an impl that wires the wrong field (passes the array index instead of itemId)
    // or that doesn't call the onUseItem callback at all.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const callbacks = makeCallbacks();
    const view = new BattleView(parent, callbacks);
    const vm = makeCureItemVM([{ itemId: 5, name: 'Antidote', cureStatus: 'Poison', count: 2 }]);
    view.refresh(vm);
    view.show();

    // Select item 5 in the cure-item selector
    const selector = parent.querySelector<HTMLSelectElement>('[data-testid="cure-item-selector"]');
    expect(selector).not.toBeNull();
    selector!.value = '5';

    // Click the Use Item button
    const btn = parent.querySelector('[data-testid="use-item-action"]') as HTMLElement | null;
    expect(btn).not.toBeNull();
    btn!.click();

    expect(callbacks.onUseItem).toHaveBeenCalledTimes(1);
    expect(callbacks.onUseItem).toHaveBeenCalledWith(1n, 5);
    // Kills: an impl that passes index (0) instead of itemId (5), or skips the callback

    document.body.removeChild(parent);
  });
});

describe('BattleView m14.5d-1b: cure-item selector hidden when cureItems is empty', () => {
  it('BITES: [data-testid="cure-item-selector"] absent when vm.cureItems is empty', () => {
    // Kills: an impl that always renders the cure section regardless of cureItems.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    // cureItems: [] (no cure items owned)
    const vm = makeCureItemVM([]);
    view.refresh(vm);
    view.show();

    const selector = parent.querySelector('[data-testid="cure-item-selector"]');
    expect(selector).toBeNull();
    // Kills: an impl that always renders the section even when no cure items are owned

    document.body.removeChild(parent);
  });
});

describe('BattleView m14.5d-1b: cure-item selection preserved across re-renders (same VM)', () => {
  it('BITES: user-selected cure item value is still set after calling refresh() again with same vm', () => {
    // Same class of bug as bait-selector fix (e-1): replaceChildren() on every refresh
    // destroys the <select> element and resets the user's selection.
    // After fix: the existing <select> is reused (or selection restored) when cureItems
    // haven't changed between refreshes.
    // Kills: an impl that unconditionally replaceChildren() the actions area,
    // destroying the cure-item selector value on each server tick.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    const vm = makeCureItemVM([
      { itemId: 5, name: 'Antidote', cureStatus: 'Poison', count: 2 },
      { itemId: 6, name: 'Paralyze Heal', cureStatus: 'Paralysis', count: 1 },
    ]);

    // First render
    view.refresh(vm);
    view.show();

    const selAfterFirst = parent.querySelector<HTMLSelectElement>(
      '[data-testid="cure-item-selector"]',
    );
    expect(selAfterFirst).not.toBeNull();

    // User selects item 6 (the second option)
    selAfterFirst!.value = '6';
    expect(selAfterFirst!.value).toBe('6'); // precondition: selection was applied

    // Second refresh with the SAME vm (same cureItems — no server change)
    view.refresh(vm);

    const selAfterSecond = parent.querySelector<HTMLSelectElement>(
      '[data-testid="cure-item-selector"]',
    );
    expect(selAfterSecond).not.toBeNull();

    // BITES: a replaceChildren() impl would reset the value to '5' (first option).
    // After fix: value must still be '6' (the user's prior selection is preserved).
    expect(selAfterSecond!.value).toBe('6');
    // Kills: an impl that replaceChildren() without restoring the selection
    // (same class of bug as the bait-selector fix in e-1)

    document.body.removeChild(parent);
  });
});

// =============================================================================
// m16b — RT-PVP-DS-01: double-submit suppression invariant
//
// INVARIANT: when pvpPendingSubmit=true, NEITHER skill-attack buttons NOR
// swap buttons are present in the DOM. Both paths must be gated or the player
// can submit two actions in the same PvP turn before the server resolves it.
//
// Protects: the pvpPendingSubmit guard in #renderSkills (vm.pvpPendingSubmit
// early-return) and in #renderSwapButtons (vm.isPvp && vm.pvpPendingSubmit
// early-return). A regression on either path breaks this test.
// =============================================================================

function makePvpPendingVM(): BattleViewModel {
  const bench = {
    teamIndex: 1,
    speciesName: 'BenchMon',
    currentHp: 15,
    maxHp: 20,
  };
  return {
    battleId: 42n,
    turnNumber: 3,
    outcome: 'Ongoing',
    playerCard: {
      speciesName: 'MyMon',
      level: 10,
      currentHp: 30,
      maxHp: 40,
      hpPercent: 75,
      affinity: 'Fire',
      status: null,
    },
    opponentCard: {
      speciesName: 'TheirMon',
      level: 10,
      currentHp: 25,
      maxHp: 40,
      hpPercent: 62,
      affinity: 'Water',
      status: null,
    },
    skills: [
      { id: 1, name: 'Ember', affinity: 'Fire', power: 40, accuracy: 100 },
      { id: 2, name: 'Tackle', affinity: 'Normal', power: 35, accuracy: 95 },
    ],
    canFlee: false,
    canSwap: true,
    bench: [bench],
    canRecruit: false,
    baitOptions: [],
    cureItems: [],
    weather: null,
    isPvp: true,
    pvpPendingSubmit: true,
    pvpOpponentName: 'Opponent',
  };
}

describe('BattleView m16b RT-PVP-DS-01: double-submit suppression — no buttons when pvpPendingSubmit=true', () => {
  it('BITES: skill-attack buttons absent when pvpPendingSubmit=true (no double-send path)', () => {
    // Kills: an impl that renders skill buttons even when pvpPendingSubmit=true.
    // The player could click a skill button, setting pvpPendingTurnNumber, then
    // click again on the stale DOM before the re-render clears it — double submit.
    // Correct impl: #renderSkills returns early when vm.pvpPendingSubmit is true.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const callbacks: BattleViewCallbacks = {
      onAttack: vi.fn(),
      onFlee: vi.fn(),
      onSwap: vi.fn(),
      onRecruit: vi.fn(),
      onUseItem: vi.fn(),
      onPvpAttack: vi.fn(),
      onPvpSwap: vi.fn(),
    };
    const view = new BattleView(parent, callbacks);
    view.refresh(makePvpPendingVM());
    view.show();

    // No skill buttons should be present in the DOM.
    // Skill buttons are rendered inside #skillsEl — they have no unique testid,
    // but they are buttons with textContent starting "Submit:".
    const buttons = [...parent.querySelectorAll('button')].filter((b) =>
      b.textContent?.startsWith('Submit:'),
    );
    expect(buttons).toHaveLength(0);

    document.body.removeChild(parent);
  });

  it('BITES: swap buttons absent when isPvp=true and pvpPendingSubmit=true (no double-send path)', () => {
    // Kills: an impl where #renderSwapButtons only checks isPvp but not pvpPendingSubmit,
    // or only checks pvpPendingSubmit but not isPvp, leaving swap open as a double-submit vector.
    // Correct impl: #renderSwapButtons returns early when vm.isPvp && vm.pvpPendingSubmit.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const callbacks: BattleViewCallbacks = {
      onAttack: vi.fn(),
      onFlee: vi.fn(),
      onSwap: vi.fn(),
      onRecruit: vi.fn(),
      onUseItem: vi.fn(),
      onPvpAttack: vi.fn(),
      onPvpSwap: vi.fn(),
    };
    const view = new BattleView(parent, callbacks);
    view.refresh(makePvpPendingVM());
    view.show();

    // No swap buttons should be present ("Submit Swap: ...").
    const swapButtons = [...parent.querySelectorAll('button')].filter((b) =>
      b.textContent?.startsWith('Submit Swap:'),
    );
    expect(swapButtons).toHaveLength(0);

    document.body.removeChild(parent);
  });

  it('BITES: pvp-status banner visible when pvpPendingSubmit=true (player can see they already submitted)', () => {
    // Kills: an impl that suppresses buttons but forgets to show the status banner,
    // leaving the player staring at a blank screen with no feedback.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const callbacks: BattleViewCallbacks = {
      onAttack: vi.fn(),
      onFlee: vi.fn(),
      onSwap: vi.fn(),
      onRecruit: vi.fn(),
      onUseItem: vi.fn(),
      onPvpAttack: vi.fn(),
      onPvpSwap: vi.fn(),
    };
    const view = new BattleView(parent, callbacks);
    view.refresh(makePvpPendingVM());
    view.show();

    const statusBanner = parent.querySelector('[data-testid="pvp-status"]') as HTMLElement | null;
    expect(statusBanner).not.toBeNull();
    expect(statusBanner!.style.display).not.toBe('none');
    expect(statusBanner!.textContent!.trim().length).toBeGreaterThan(0);

    document.body.removeChild(parent);
  });

  it('BITES: skill buttons re-appear when pvpPendingSubmit transitions false→true→false', () => {
    // Regression guard: after the server resolves the turn (pvpPendingSubmit=false),
    // skill buttons must come back. Kills: an impl that permanently suppresses buttons
    // once pvpPendingSubmit is ever true (one-way latch bug).
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const callbacks: BattleViewCallbacks = {
      onAttack: vi.fn(),
      onFlee: vi.fn(),
      onSwap: vi.fn(),
      onRecruit: vi.fn(),
      onUseItem: vi.fn(),
      onPvpAttack: vi.fn(),
      onPvpSwap: vi.fn(),
    };
    const view = new BattleView(parent, callbacks);

    // Phase 1: pending=false → buttons shown
    const vmNotPending: BattleViewModel = { ...makePvpPendingVM(), pvpPendingSubmit: false };
    view.refresh(vmNotPending);
    view.show();
    const buttonsBeforePending = [...parent.querySelectorAll('button')].filter((b) =>
      b.textContent?.startsWith('Submit:'),
    );
    expect(buttonsBeforePending.length).toBeGreaterThan(0);

    // Phase 2: pending=true → buttons suppressed
    view.refresh(makePvpPendingVM());
    const buttonsDuringPending = [...parent.querySelectorAll('button')].filter((b) =>
      b.textContent?.startsWith('Submit:'),
    );
    expect(buttonsDuringPending).toHaveLength(0);

    // Phase 3: pending=false again (server resolved turn) → buttons back
    view.refresh(vmNotPending);
    const buttonsAfterResolution = [...parent.querySelectorAll('button')].filter((b) =>
      b.textContent?.startsWith('Submit:'),
    );
    expect(buttonsAfterResolution.length).toBeGreaterThan(0);

    document.body.removeChild(parent);
  });
});

// =============================================================================
// ux1 (ADR-0151) — EARS ux1-2: persistent "Press Esc to continue" hint on
// battle-RESULT overlays.
//
// SOURCE OF TRUTH (EARS ux1-2): "Battle-result states specifically (victory /
// flee / defeat) SHALL show a persistent 'Press Esc to continue' (or equivalent)
// hint for as long as that overlay is showing."
//
// CONTRACT UNDER TEST (the implementer's side of the handoff):
//   - constructor creates a `<div data-testid="battle-continue-hint">`, appended
//     to #root immediately AFTER #outcomeEl, textContent set ONCE in the
//     constructor to `Press Esc to continue`, style.display = 'none' initially;
//   - `#renderOutcome(vm)` toggles it: hidden on outcome==='Ongoing' (the branch
//     that already early-returns with #outcomeEl display:none), shown on EVERY
//     terminal outcome (the branch that already sets display:'block');
//   - the `refresh(null)` branch resets it to display:'none', alongside the
//     existing #weatherEl / #pvpStatusEl resets.
//
// RED REASON AT AUTHORING TIME (pre-implementation): battleView.ts created no
// element carrying data-testid="battle-continue-hint", so B1/B2/B3/B5/B6 all
// failed on the first `expect(el).not.toBeNull()`. These are now GREEN on the
// shipped tree and stay in place as PERMANENT gating cases.
//
// SECOND-PASS HARDENING (review battery: reviewer + red-team + /simplify) —
// three edits, each a STRENGTHENING, none a retarget of an expected value:
//   (1) B7 ADDED — a surviving mutant. Deleting the Ongoing-branch reset
//       (`#continueHintEl.style.display = 'none'` at battleView.ts:401) passed
//       the ENTIRE gate (53 files / 1393 tests). B4 is order-blind to it: B4
//       builds a FRESH view, so the constructor's display:none already satisfies
//       the assertion with the reset deleted. B6 cannot see it either — B6 drives
//       refresh(null), while the production dismiss path (main.ts:964-971) is a
//       BARE battleView.hide(). B7 replays that real sequence.
//   (2) CONTAINMENT ADDED to the B1 row — a second surviving mutant. Changing
//       `this.#root.appendChild(this.#continueHintEl)` to `parent.appendChild(…)`
//       passed all 1393 tests, because every case queries `parent.querySelector`,
//       which matches a direct child of `parent` as happily as a descendant of
//       #root. In production `parent` is `#app` (main.ts:1747), the PixiJS canvas
//       container, so the hint would render as an unpositioned in-flow div AFTER a
//       viewport-tall canvas (below the fold — the exact defect this slice fixes
//       for #help-overlay), would survive battleView.hide(), and would re-lengthen
//       the document (the ADR-0146 scroll mechanism).
//   (3) B4's `if (el !== null)` conditional REMOVED. Absence satisfying "hidden"
//       was correct only while the element did not exist; now that it ships, the
//       conditional would let B4 pass vacuously if someone DELETED the element —
//       and B4 is the case this header calls out as what makes B1/B2/B3
//       non-vacuous. It is now unconditional: present AND display:none.
// =============================================================================

const CONTINUE_HINT_SELECTOR = '[data-testid="battle-continue-hint"]';

describe('BattleView ux1-2: "Press Esc to continue" hint on battle-result overlays', () => {
  // -------------------------------------------------------------------------
  // B1 / B2 / B3 / B5 — one row per battle-RESULT overlay state.
  //
  // Table-driven so the rows cannot drift apart, but each row is still its OWN
  // `it` with its own failure label, so nothing is lost versus four hand-written
  // cases: a toggle placed inside a single `case 'SideAWins':` arm reds exactly
  // the rows it misses (reviewer-confirmed — B1/B2/B3 are NOT redundant), and a
  // future `if (!vm.isPvp)` guard reds only the PvP row.
  //
  // WRONG IMPLS KILLED (shared by every row):
  //   (a) an early `return` before the toggle in #renderOutcome (e.g. the toggle
  //       tucked under the switch's unreachable `default:` arm) — the element
  //       exists but stays at its constructor display:none;
  //   (b) blank/blanked hint text — the overlay promises nothing while a mere
  //       presence check still passes;
  //   (c) a toggle wired to a SUBSET of the terminal outcomes — see per-row labels.
  //
  // PvP ROW (B5) — stronger than a pure decision-pin, per /simplify: side A (the
  // CHALLENGER, who IS `player_identity`) does receive this overlay through the
  // production path, so an `if (!vm.isPvp)` guard would strip the exit affordance
  // from a production-reachable overlay. It also pins ADR-0151 D3's deliberate
  // no-isPvp-branch call. CAVEAT RETAINED: this is NOT evidence that "Press Esc to
  // continue" is truthful for the CHALLENGED player — a PvP battle is one row keyed
  // to the challenger, so side B never receives the overlay through the production
  // path at all; that half of the story is out of this view's reach entirely.
  // -------------------------------------------------------------------------
  const RESULT_ROWS = [
    {
      id: 'B1',
      outcome: 'SideAWins',
      label: 'victory (PvE)',
      isPvp: false,
      // Only B1 pins WHERE the element lives — see the containment block below.
      pinsContainment: true,
      kills:
        'an impl whose toggle never runs on the victory path (early return, or a toggle ' +
        'placed inside a single switch arm other than SideAWins)',
    },
    {
      id: 'B2',
      outcome: 'SideBWins',
      label: 'defeat',
      isPvp: false,
      pinsContainment: false,
      kills:
        "a toggle placed inside the `case 'SideAWins':` arm — the DEFEAT overlay, the one a " +
        'frustrated player is most likely to be stuck on, would then show no way out',
    },
    {
      id: 'B3',
      outcome: 'Fled',
      label: 'flee',
      isPvp: false,
      pinsContainment: false,
      kills:
        "a won-or-lost-only gate (`vm.outcome === 'SideAWins' || vm.outcome === 'SideBWins'`) — " +
        'EARS ux1-2 enumerates victory / flee / defeat, so the Fled overlay must carry it too',
    },
    {
      id: 'B5',
      outcome: 'SideAWins',
      label: 'PvP victory (isPvp=true)',
      isPvp: true,
      pinsContainment: false,
      kills:
        'a future `if (!vm.isPvp)` (or `vm.isPvp ? … : …`) guard around the toggle — ADR-0151 D3 ' +
        'calls the toggle with NO isPvp branch, and side A (the challenger) reaches this overlay ' +
        'in production, so such a guard would strip a live exit affordance while B1/B2/B3 stayed green',
    },
  ] as const;

  for (const row of RESULT_ROWS) {
    it(`BITES: ${row.id} outcome="${row.outcome}" — ${row.label} → continue hint present, visible, text contains "Esc"`, () => {
      const parent = document.createElement('div');
      document.body.appendChild(parent);

      const view = new BattleView(parent, makeCallbacks());
      const vm: BattleViewModel = row.isPvp
        ? { ...makeTerminalVM(row.outcome), isPvp: true }
        : makeTerminalVM(row.outcome);
      view.refresh(vm);
      view.show();

      const el = parent.querySelector(CONTINUE_HINT_SELECTOR) as HTMLElement | null;
      expect(
        el,
        `ux1-2 (${row.id}): a [data-testid="battle-continue-hint"] element must exist on the ` +
          `${row.label} overlay — killed impl: ${row.kills}`,
      ).not.toBeNull();
      expect(
        el!.style.display,
        `ux1-2 (${row.id}): the continue hint must be VISIBLE on the ${row.label} result — ` +
          `killed impl: ${row.kills}`,
      ).not.toBe('none');
      expect(
        el!.textContent,
        `ux1-2 (${row.id}): the ${row.label} hint text must name the Esc key — a blank or generic ` +
          'hint does not tell the player how to dismiss the result overlay',
      ).toContain('Esc');

      if (row.pinsContainment) {
        // CONTAINMENT (second-pass mutant kill): the hint must be a child of BattleView's own
        // #root wrapper, NOT of the caller-supplied `parent`.
        //
        // TESTER NOTE — this is a STRENGTHENED form of the reviewed suggestion. Anchoring on
        // `parent.firstElementChild` would NOT bite: the mutant appends the hint to `parent`
        // BEFORE the constructor appends #root, so firstElementChild would BE the hint and
        // `hint.contains(hint)` is trivially true. Anchoring on the outcome banner's parent
        // instead identifies the real #root regardless of insertion order, and the extra
        // `root !== parent` assertion also kills the degenerate variant where BOTH elements are
        // appended to `parent`.
        const outcomeEl = parent.querySelector('[data-testid="outcome-text"]');
        expect(
          outcomeEl,
          'precondition: the outcome banner must exist — it anchors the containment check',
        ).not.toBeNull();
        const root = outcomeEl!.parentElement;
        expect(
          root,
          "precondition: the outcome banner must have a parent element (BattleView's #root)",
        ).not.toBeNull();
        expect(
          root,
          "BattleView must wrap its children in its own #root — if the banner's parent IS the " +
            'caller-supplied parent, this containment check degenerates and cannot bite',
        ).not.toBe(parent);
        expect(
          el!.parentElement,
          "ux1-2: the continue hint must be appended to BattleView's #root (sibling of the " +
            'outcome banner), NOT to the caller-supplied `parent`. In production `parent` is ' +
            '`#app` (main.ts:1747) — the PixiJS canvas container — so a hint appended there ' +
            'becomes an unpositioned in-flow div AFTER a viewport-tall canvas (below the fold: ' +
            'the exact defect this slice fixes for #help-overlay), is no longer hidden by ' +
            'battleView.hide(), and re-lengthens the document (the ADR-0146 scroll mechanism)',
        ).toBe(root);
      }

      document.body.removeChild(parent);
    });
  }

  it('BITES: B4 outcome="Ongoing" → continue hint EXISTS and is display:none', () => {
    // THIS CASE IS WHAT MAKES B1/B2/B3 NON-VACUOUS. Without it, the cheapest way to turn
    // B1-B3 green is to create the element in the constructor with display:block (or with no
    // display at all) and never toggle it — mere EXISTENCE would satisfy all three. This case
    // rejects that impl: during an ongoing battle the result hint is a lie (there is no result
    // to continue past, and Esc during an ongoing battle is a bare hide, not the "continue"
    // affordance ux1-2 describes), so it must be hidden.
    //
    // WRONG IMPL KILLED (1): the always-visible hint — element created display:block in the
    // constructor and never toggled on the Ongoing path.
    // WRONG IMPL KILLED (2, SECOND-PASS STRENGTHENING): outright DELETION of the element.
    // This case previously wrapped its assertion in `if (el !== null)`, which was correct only
    // while the element did not yet exist (absence then satisfied "hidden"). Now that it ships,
    // that conditional would let the guard-of-guards pass vacuously against a deleted element.
    // The not-null assertion below is unconditional for exactly that reason.
    //
    // SCOPE LIMIT (why B7 below is also required): this case builds a FRESH view, so the
    // constructor's own display:none satisfies it even if the Ongoing-branch RESET in
    // #renderOutcome is deleted. B4 is order-blind; B7 replays the ordered production sequence.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    // makeRecruitVM() is outcome:'Ongoing' by default.
    view.refresh(makeRecruitVM());
    view.show();

    const el = parent.querySelector(CONTINUE_HINT_SELECTOR) as HTMLElement | null;
    expect(
      el,
      'ux1-2: the continue hint element must EXIST even during an ongoing battle (it is created ' +
        'once in the constructor and only toggled thereafter) — an impl that deletes it, or that ' +
        'creates it lazily on the terminal path only, fails here, and without this assertion the ' +
        'guard that makes B1/B2/B3 non-vacuous would itself pass vacuously',
    ).not.toBeNull();
    expect(
      el!.style.display,
      'ux1-2: during an ONGOING battle the "Press Esc to continue" hint must be hidden — an ' +
        'element created display:block in the constructor and never toggled by the Ongoing ' +
        'early-return branch of #renderOutcome fails here (and that impl is exactly what ' +
        'would otherwise make B1/B2/B3 pass without any toggle logic at all)',
    ).toBe('none');

    document.body.removeChild(parent);
  });

  it('BITES: B7 terminal result → hide() (Escape) → NEXT battle arrives Ongoing → hint is display:none (no stale-hint leak)', () => {
    // SURVIVING MUTANT THIS CASE KILLS: deleting the Ongoing-branch reset in #renderOutcome
    // (`this.#continueHintEl.style.display = 'none';`, battleView.ts:401). With that line gone
    // the ENTIRE gate stayed green (53 files / 1393 tests) while the shipped behaviour diverged:
    //
    //     ===== MUTANT =====                      ===== SHIPPED =====
    //     after victory      : hint=block         after NEW Ongoing : hint=none
    //     after Escape hide(): hint=block
    //     after NEW Ongoing  : hint=block   ← "Press Esc to continue" over an ONGOING battle
    //
    // WHY THE OTHER CASES CANNOT SEE IT:
    //   - B4 builds a FRESH BattleView and refreshes Ongoing, so the CONSTRUCTOR's display:none
    //     already satisfies its assertion. B4 is order-blind — it never observes a hint that was
    //     turned on by a previous render.
    //   - B6 drives `refresh(null)`, which has its OWN reset. The production dismiss path does
    //     not go through it.
    //
    // WHY THE SEQUENCE IS REAL, NOT CONTRIVED: main.ts:964-971 dismisses a terminal result with
    // `dismissedBattleId = latest.battleId; battleView.hide(); lastBattleVM = null;` — a BARE
    // hide(); refresh(null) is never called, so no reset runs on that path. `dismissedBattleId`
    // suppresses only THAT battle id, so the NEXT battle re-enters normally via
    // `refreshBattle → battleView.refresh(vm)`, and refresh() self-show()s when not visible. A
    // leaked hint is then displayed over a live battle AND is lying: Esc during an Ongoing battle
    // is a bare hide, and the overlay auto-re-pops on the next batch.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());

    // 1. Battle ends in victory — refresh() self-shows and the hint appears.
    view.refresh(makeTerminalVM('SideAWins'));
    const el = parent.querySelector(CONTINUE_HINT_SELECTOR) as HTMLElement | null;
    expect(el, 'precondition: the continue hint element must exist').not.toBeNull();
    expect(
      el!.style.display,
      'precondition: the hint must be visible on the victory result (else the reset assertion ' +
        'below would pass for the wrong reason — an always-hidden hint)',
    ).not.toBe('none');

    // 2. The player presses Escape: main.ts:964-971 calls a BARE hide(). No refresh(null).
    view.hide();

    // 3. The next battle arrives Ongoing. refresh() self-show()s the overlay.
    view.refresh(makeRecruitVM());
    expect(
      view.visible,
      'precondition: refresh(vm) must self-show the overlay — if it did not, the leaked hint ' +
        'would not be on screen and this case would not be testing the reported defect',
    ).toBe(true);

    const elAfter = parent.querySelector(CONTINUE_HINT_SELECTOR) as HTMLElement | null;
    expect(
      elAfter,
      'the hint element must not be removed from the DOM by a re-render',
    ).not.toBeNull();
    expect(
      elAfter!.style.display,
      "ux1-2 stale-hint leak: #renderOutcome's Ongoing branch must RESET the continue hint to " +
        "display:none, not merely skip it. Deleting that reset leaves the previous battle's " +
        'hint latched at display:block across the bare hide() dismiss (main.ts:964-971), so the ' +
        'NEXT battle renders "Press Esc to continue" over an ongoing fight — a hint that is both ' +
        'stale and untrue (Esc mid-battle is a bare hide; the overlay re-pops on the next batch)',
    ).toBe('none');

    document.body.removeChild(parent);
  });

  it('BITES: B6 refresh(null) resets the continue hint to display:none (no state leak across battles)', () => {
    // WRONG IMPL KILLED: an impl that toggles the hint ONLY inside #renderOutcome and omits
    // the reset in the `refresh(null)` branch. Measured against the contract: after a terminal
    // result the element holds display:block; refresh(null) then calls hide() on #root and
    // returns WITHOUT touching the hint, so the element retains display:block underneath — and
    // a later hide()/show() pair re-exposes a stale "Press Esc to continue" over a screen that
    // has no result to continue past.
    //
    // SCOPE, VS B7: this covers the refresh(null) branch ONLY. B7 covers the OTHER teardown
    // route — the bare hide() at main.ts:964-971 — which never reaches this branch. Both are
    // required; neither subsumes the other.
    //
    // Binding independently of B7 because the refresh(null) branch ALREADY resets #weatherEl and
    // #pvpStatusEl for exactly this reason — omitting the hint would break that branch's own
    // stated invariant ("null VM ⇒ every banner is reset"), and that invariant is what protects
    // the next caller that reaches show() by a different route.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeCallbacks());
    view.refresh(makeTerminalVM('Fled'));
    view.show();

    const elAfterResult = parent.querySelector(CONTINUE_HINT_SELECTOR) as HTMLElement | null;
    // (No separate not-null precondition: the display precondition below dereferences the same
    // element, so a missing element fails here just as loudly — and that one is load-bearing.)
    expect(
      elAfterResult!.style.display,
      'precondition: the continue hint must be visible after the Fled result (else the reset ' +
        'assertion below would pass for the wrong reason)',
    ).not.toBe('none');

    // Battle ends / the VM goes away.
    view.refresh(null);

    const elAfterNull = parent.querySelector(CONTINUE_HINT_SELECTOR) as HTMLElement | null;
    expect(
      elAfterNull,
      'the hint element must not be removed from the DOM by refresh(null)',
    ).not.toBeNull();
    expect(
      elAfterNull!.style.display,
      'ux1-2 state-leak guard: the refresh(null) branch must reset the continue hint to ' +
        'display:none alongside the existing #weatherEl / #pvpStatusEl resets — an impl that ' +
        'toggles the hint only inside #renderOutcome leaves display:block latched across the ' +
        'null refresh, breaking that branch\'s "every banner is reset" invariant',
    ).toBe('none');

    document.body.removeChild(parent);
  });
});

// =============================================================================
// ux4 (ADR-0155) — swap discoverability. TWO describes are appended below; no
// existing case, factory or assertion above this line is touched.
//
// ANCHORS BELOW THIS LINE ARE SYMBOLIC, NOT NUMERIC (reviewer W3 / simplify F1). The
// original citations were correct against base 4368a07 and were silently invalidated
// by this file's own insertions plus the implementer's edits to battleView.ts — the
// trap bit TWICE in one slice, and stale citations read as present-tense claims. So:
// cite the METHOD (`#renderActions`, `#renderSwapButtons`, `#renderRecruit`,
// `#renderPvpStatus`) or the LITERAL (`Party & Box`, `Swap: `) instead. Citations into
// OTHER, untouched files (main.ts, battleModel.ts, recruit.spec.ts, the Rust server,
// and this file's own pre-ux4 region above) keep their line numbers.
//
//   • ux4-1 (S1, S2) — the EXECUTABLE REPRO/REFUTATION of the playtest report
//     ("no method of switching monsters seemed to exist"). These are EXPECTED
//     GREEN on the untouched tree, and that green IS the discharge of ux4-1: the
//     PvE swap UI is correct, so the absence the player saw was `canSwap === false`
//     — recruits land in the BOX (`server-module/src/taming.rs:163`, a DECIDED
//     semantic per `docs/adr/0047-recruit-resolution-semantics.md:53-57` §3) and
//     `lead_party` (`server-module/src/battle.rs:283-294`) only draws side A from
//     monsters with `party_slot != PARTY_SLOT_NONE`.
//     They are load-bearing rather than redundant because the pre-existing
//     coverage at `battleView.test.ts:772-775` pins ONLY the PvP `Submit Swap:`
//     label; there is no PvE `Swap:` assertion anywhere in `client/src/**` or
//     `client/e2e/**`, and there is no TS mutation harness — so deleting the PvE
//     arm of `#renderSwapButtons`' label ternary is a GREEN mutant today.
//
//   • ux4-2 (H1..H8) — the NEW empty-swap explainer. Permanent gating cases.
//
// WHAT THESE CASES CAN AND CANNOT PROVE (disclosure, deferral D2): happy-dom does no
// layout, so every assertion here proves "the element is PRESENT and is not
// display:none" — never that it is actually VISIBLE in a viewport. The real
// visibility proof is the parked real-Chromium `toBeInViewport()` spec
// (`client/e2e/swap-hint.spec.ts`, deferral D2), mirroring ux1's parked
// `help-hint.spec.ts`. ux1 (ADR-0151) shipped a badge for an overlay that rendered
// below the fold precisely because a happy-dom suite cannot see that.
//
// CONTRACT UNDER TEST (the implementer's side of the handoff):
//   - the constructor creates ONE `<div data-testid="battle-swap-hint">`, appended
//     to BattleView's own `#root` in a block between the `#actionsEl` block and the
//     `#pvpStatusEl` block — a SIBLING of `#actionsEl`, never its child
//     (`#renderActions` opens with `this.#actionsEl.replaceChildren()`) and
//     never appended to the caller-supplied `parent`;
//   - `textContent` is set ONCE in the constructor to COPY A; `display:none` initially;
//   - `#renderActions(vm)` toggles it INLINE, immediately after the
//     `if (vm.canSwap) { this.#renderSwapButtons(vm); }` branch:
//         display = vm.outcome === 'Ongoing' && !vm.canSwap ? 'block' : 'none'
//     (keyed on `!vm.canSwap`, NOT `bench.length === 0` — the buttons render under
//     `vm.canSwap`, so keying the hint off the SAME flag makes "hint shown ⟺ no swap
//     buttons rendered" structural rather than derived);
//   - the `refresh(null)` branch resets it to `display:'none'`, beside the existing
//     `#weatherEl` / `#pvpStatusEl` / `#continueHintEl` resets.
//
// COPY A (the shipped, honesty-constrained wording — 109 chars):
//   "No healthy party monster in this battle to swap in. When this battle ends, press
//    Esc, then B for Party & Box."
// Every clause is a measured constraint, not a preference:
//   - `B` is DEAD while the battle overlay is open (`main.ts:551-577` gates KeyB on
//     `shouldToggleBox(battleView?.visible ?? false)`; `inputGuards.ts:6-8` is
//     `return !battleVisible`), and a terminal battle row is not GC'd on resolution
//     (`battle.rs:1013-1022` deletes only PRIOR terminals) while `decideBattleOverlay`
//     keeps returning `show` for a non-dismissed terminal (`battleModel.ts:379-386`)
//     ⇒ the overlay STAYS UP after victory/defeat/flee and B stays dead until Esc.
//     So the copy must name BOTH the timing AND the Esc step, in that order.
//   - it must NOT advertise healing: `heal_party` is zone-gated
//     (`raising.rs:302-304`; the only heal location is `zone_id: 0`) and zone 1 has
//     its own encounter table.
//   - it names `Party & Box` because that is the literal `h2` the player will see
//     (boxView's constructor sets that title on the header `h2`).
//
// *** WHY THE REASON CLAUSE IS SCOPED "in this battle" — THE HONESTY PROPERTY ***
// (CORRECTION driven by the spec's honesty spine, red-team lens; a future copy edit
// MUST preserve this scoping, and H1f's literal pin is what forces it.)
// The unscoped first sentence ("No healthy party monster to swap in.") is FALSIFIABLE
// MID-BATTLE BY A PLAYER FOLLOWING THE COPY'S OWN INSTRUCTIONS:
//   Esc on an ONGOING battle is a bare `battleView.hide()` (main.ts, the dismiss
//   branch) ⇒ `shouldToggleBox` now returns true ⇒ KeyB opens the box ⇒
//   `set_party_slot` has NO in-battle guard (server-module/src/monster_mgmt.rs) so
//   `To Party` is ACCEPTED ⇒ that row-write is the very batch that re-shows the battle
//   overlay ⇒ but `sideA.team` is a BATTLE-ROW SNAPSHOT, so `canSwap` stays false and
//   the hint re-renders still claiming there is no healthy party monster — which the
//   player has just disproved. Scoping the claim to "in this battle" makes it TRUE in
//   that state: the newly-added monster genuinely is not on this battle's side A.
// Second driver: `movement.rs` grants a fresh player exactly ONE monster and an EMPTY
// box, so on every new player's FIRST wild battle the old trailing "to add one"
// pointed at a screen with nothing to add. That clause is gone.
//
// WHY THESE CASES ARE THE ONLY DEFENSE: `src/ui/battleView.ts` is in
// `client/vite.config.ts:102` `coverage.exclude` (exact-set-guarded by
// `evals/dom-shell-coverage-exclusion.eval.mjs:40-41`) and there is no TS mutation
// gate (cargo-mutants is Rust-only) ⇒ hint logic is neither coverage-measured nor
// mutation-measured. Every positive case below therefore ships a rejecting control.
//
// LOCAL FIXTURE FACTORIES (deliberate — do NOT reuse the factories above):
//   `makeCallbacks()` (:78-86) omits `onPvpAttack`/`onPvpSwap`, so S2's
//   `expect(callbacks.onPvpSwap).not.toHaveBeenCalled()` would be
//   `expect(undefined).not.toHaveBeenCalled()` — a HARD ERROR, not a pass — and
//   `makeRecruitVM()` (:39-76) omits `isPvp`/`pvpPendingSubmit`/`pvpOpponentName`.
//   `client/tsconfig.json` excludes `**/*.test.ts`, so nothing type-checks either
//   omission. `isPvp` is set EXPLICITLY on every VM below (never relying on
//   `undefined` being falsy in cases whose whole purpose is pinning the PvE arm).
// =============================================================================

const UX4_SWAP_HINT_SELECTOR = '[data-testid="battle-swap-hint"]';

/** All SEVEN BattleViewCallbacks keys as spies — see the LOCAL FIXTURE note above. */
function makeUx4Callbacks(): BattleViewCallbacks {
  return {
    onAttack: vi.fn(),
    onFlee: vi.fn(),
    onSwap: vi.fn(),
    onRecruit: vi.fn(),
    onUseItem: vi.fn(),
    onPvpAttack: vi.fn(),
    onPvpSwap: vi.fn(),
  };
}

/** Every BattleViewModel field supplied explicitly, including the three PvP fields. */
function makeUx4VM(overrides: Partial<BattleViewModel> = {}): BattleViewModel {
  return {
    battleId: 77n,
    turnNumber: 2,
    outcome: 'Ongoing',
    playerCard: {
      speciesName: 'Sproutle',
      level: 6,
      currentHp: 16,
      maxHp: 22,
      hpPercent: 72,
      affinity: 'Grass',
      status: null,
    },
    opponentCard: {
      speciesName: 'WildMon',
      level: 5,
      currentHp: 14,
      maxHp: 19,
      hpPercent: 73,
      affinity: 'Water',
      status: null,
    },
    skills: [{ id: 1, name: 'Vine Whip', affinity: 'Grass', power: 40, accuracy: 100 }],
    canFlee: true,
    canSwap: false,
    bench: [],
    canRecruit: false,
    baitOptions: [],
    cureItems: [],
    weather: null,
    isPvp: false,
    pvpPendingSubmit: false,
    pvpOpponentName: null,
    ...overrides,
  };
}

/**
 * Two bench members whose `teamIndex` (1, 2) deliberately DIFFERS from their array
 * index (0, 1) — that offset is what lets S2 distinguish `member.teamIndex` from a
 * loop counter. Distinct names and distinct HP pairs so no assertion can pass by
 * matching the wrong row.
 */
const UX4_BENCH = [
  { teamIndex: 1, speciesName: 'Mossling', currentHp: 12, maxHp: 18 },
  { teamIndex: 2, speciesName: 'Emberfang', currentHp: 7, maxHp: 21 },
] as const;

/** The VM S1/S2/H2 share: an ongoing PvE battle with a swappable bench. */
function makeUx4SwappableVM(overrides: Partial<BattleViewModel> = {}): BattleViewModel {
  return makeUx4VM({ isPvp: false, canSwap: true, bench: [...UX4_BENCH], ...overrides });
}

/** The VM H1/H4/H5 share: an ongoing PvE battle with NO swap available. */
function makeUx4EmptySwapVM(overrides: Partial<BattleViewModel> = {}): BattleViewModel {
  return makeUx4VM({ isPvp: false, canSwap: false, bench: [], ...overrides });
}

// -----------------------------------------------------------------------------
// FIXTURE-CONSTANT HYGIENE (red-team F2 continuation).
//
// If every H fixture carries the SAME value for an incidental field, the toggle
// predicate can silently read that field and no case notices. Measured survivors
// against the first draft: `&& vm.turnNumber === 2`, `&& !vm.canRecruit`, and
// `&& vm.skills.length === 1` all passed the whole suite. So the H fixtures below
// deliberately DISAGREE on `turnNumber`, `canRecruit`, `baitOptions` and
// `skills.length`, and H1 runs the `canRecruit: true` wild-battle shape — the state
// where this hint actually fires most often (a wild encounter with a single party
// monster, where the Recruit control is rendered into the SAME #actionsEl by
// `#renderRecruit`; COPY A deliberately does not mention Recruit — plan RT-8).
//
// *** THREE MORE FIELDS, ADDED AFTER MEASUREMENT (review item 2, red-team F5). ***
// The paragraph above USED TO CLAIM this whole class was closed. It was not: `weather`,
// `playerCard.status` and `cureItems` were CONSTANT (null / null / []) across all EIGHT
// H fixtures, and all 47 tests were measured GREEN with each of these conjuncts bolted
// onto the toggle:
//     && vm.weather === null            (suppresses the hint in ANY weather — M14d)
//     && vm.playerCard.status === null  (suppresses it whenever poisoned/burned — M14a)
//     && vm.cureItems.length === 0      (suppresses it whenever a cure item is held — M14e)
// Each is a plausible copy-paste accident off the neighbouring `#renderWeather` /
// `#renderCureItems` conditions, and each silently deletes the explanation in exactly
// the states a mid-battle player is MOST likely to be in. H1 now carries a non-null
// `weather`, a non-null `playerCard.status` and one `cureItems` entry, so all three die
// there. HONEST STATEMENT OF WHAT IS VARIED: turnNumber, canRecruit, baitOptions,
// skills.length, weather, playerCard.status, cureItems — H1 is the odd-one-out for the
// last three (they are null/null/[] on H2..H8), which is sufficient: a conjunct that
// reads any of them flips H1's expected-VISIBLE hint to hidden.
//
// DISCLOSED RESIDUAL: `pvpPendingSubmit` is false on every case here. It is a
// PvP-only field, and the only VM that could vary it while staying a shape the model
// actually produces is a PvP battle mid-submit; the plan discloses that interaction
// as a non-lie (with `pvpPendingSubmit` true and a NON-empty bench the swap buttons
// are suppressed by `#renderSwapButtons`' early return while the hint correctly stays
// hidden, because `canSwap` is true, and the pvp-status banner explains the wait). A
// `&& !vm.pvpPendingSubmit` conjunct would therefore survive this suite; it would
// only suppress the explanation for one transient PvP turn. Recorded, not fixed
// here — fabricating a `isPvp:false, pvpPendingSubmit:true` VM would pin a shape
// buildBattleViewModel never emits.
//
// SECOND DISCLOSED RESIDUAL (stated, not hidden): `opponentCard.status` is still
// constant (null), so `&& vm.opponentCard.status === null` would survive this suite.
// Not varied, deliberately: `#renderActions` has no opponent-side condition to
// copy-paste from, so that conjunct has no plausible provenance, whereas the three
// closed above each mirror a real neighbouring condition in the same file.
// -----------------------------------------------------------------------------

/** Two skills — H1's wild-battle fixture, so `skills.length` is not constant across H. */
const UX4_TWO_SKILLS = [
  { id: 1, name: 'Vine Whip', affinity: 'Grass', power: 40, accuracy: 100 },
  { id: 2, name: 'Tackle', affinity: 'Normal', power: 35, accuracy: 95 },
];

describe('BattleView ux4-1: PvE swap buttons — executable repro/refutation (EXPECTED GREEN)', () => {
  // The per-case `document.body.removeChild(parent)` at the end of each case is SKIPPED
  // when an assertion throws, leaking the overlay into the next case. Scoped to this
  // describe so the pre-existing cases above keep their own teardown untouched.
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('BITES: S1 ongoing PvE, canSwap=true, 2 bench members → exactly 2 "Swap: " buttons, each naming its species and hp/max', () => {
    // KILLS (1): the hypothesized defect itself — "no method of switching monsters
    //   seemed to exist". If this case is RED on the untouched tree, the swap UI IS
    //   the bug and the ux4-2 hint is the wrong remedy.
    // KILLS (2): deleting the PvE arm of `#renderSwapButtons`' label ternary
    //   (`vm.isPvp ? 'Submit Swap: …' : 'Swap: … (hp/max)'`). That mutant is GREEN
    //   today: battleView.test.ts:772-775 pins ONLY the `Submit Swap:` prefix, and
    //   there is no PvE `Swap:` assertion anywhere in client/src or client/e2e.
    // KILLS (3): a `bench[0]`-only render (or any early `break`) — the count is
    //   pinned at EXACTLY 2, so rendering one button, or three, fails.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeUx4Callbacks());
    view.refresh(makeUx4SwappableVM());
    view.show();

    // `startsWith('Swap: ')` cannot match the PvP label `Submit Swap: …`, so this
    // filter pins the PvE arm specifically.
    const swapButtons = [...parent.querySelectorAll('button')].filter((b) =>
      b.textContent?.startsWith('Swap: '),
    );
    expect(
      swapButtons.map((b) => b.textContent),
      'ux4-1 (S1): an ongoing PvE battle with canSwap=true and a 2-member bench must render ' +
        'EXACTLY one "Swap: <name> (hp/max)" button per bench member. Zero buttons ⇒ the swap ' +
        'UI is the reported defect (ux4-3 would apply, not ux4-2). One button ⇒ a bench[0]-only ' +
        'render. Non-"Swap: " labels ⇒ the PvE arm of `#renderSwapButtons`\' label ternary was ' +
        'deleted — a mutant that is green against the pre-existing suite',
    ).toHaveLength(2);

    for (const member of UX4_BENCH) {
      const btn = swapButtons.find((b) => b.textContent?.includes(member.speciesName));
      expect(
        btn,
        `ux4-1 (S1): the bench member "${member.speciesName}" (teamIndex ${member.teamIndex}) must ` +
          'have its OWN swap button naming it — a player cannot choose between unlabelled buttons',
      ).toBeDefined();
      expect(
        btn!.textContent,
        `ux4-1 (S1): the "${member.speciesName}" swap button must show that member's own ` +
          `currentHp/maxHp (${member.currentHp}/${member.maxHp}) so the player can tell a healthy ` +
          'bench monster from a nearly-fainted one before committing the turn',
      ).toContain(`${member.currentHp}/${member.maxHp}`);
    }

    document.body.removeChild(parent);
  });

  it('BITES: S2 clicking the button for teamIndex=2 calls onSwap(77n, 2) exactly once and never onPvpSwap', () => {
    // KILLS (1): passing the ARRAY INDEX instead of `member.teamIndex` —
    //   `onSwap(vm.battleId, i)`. "Emberfang" is bench array index 1 but teamIndex 2,
    //   so an index-passing impl sends 1 and the server swaps in the WRONG monster.
    //   That presents to a player EXACTLY like the reported defect (the click appears
    //   to do nothing useful / swaps in someone else), which is why it is pinned here.
    // KILLS (2): a PvE→PvP misroute — wiring the PvE arm to `onPvpSwap`, which in
    //   production would send `submit_pvp_action` for a wild battle and be rejected.
    //   This assertion is only possible because the LOCAL factory supplies onPvpSwap
    //   as a vi.fn(); with the file's makeCallbacks() it would be a hard TypeError.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const callbacks = makeUx4Callbacks();
    const view = new BattleView(parent, callbacks);
    view.refresh(makeUx4SwappableVM());
    view.show();

    const target = [...parent.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Swap: Emberfang'),
    );
    expect(
      target,
      'precondition (S2): the "Swap: Emberfang" button must exist — S1 pins its label; without ' +
        'the button this case cannot observe the teamIndex the click dispatches',
    ).toBeDefined();
    target!.click();

    expect(
      callbacks.onSwap,
      'ux4-1 (S2): one click must dispatch exactly one swap intent — a duplicate listener would ' +
        'send swap_active twice for the same turn',
    ).toHaveBeenCalledTimes(1);
    expect(
      callbacks.onSwap,
      "ux4-1 (S2): the click must pass the bench member's own `teamIndex` (2), NOT its array " +
        'index (1). An index-passing impl swaps in the wrong monster, which is indistinguishable ' +
        'to the player from "swapping does not work" — the reported defect',
    ).toHaveBeenCalledWith(77n, 2);
    expect(
      callbacks.onPvpSwap,
      'ux4-1 (S2): a PvE swap must never route through onPvpSwap (submit_pvp_action) — isPvp is ' +
        'explicitly false on this VM',
    ).not.toHaveBeenCalled();

    document.body.removeChild(parent);
  });
});

describe('BattleView ux4-2: empty-swap explainer hint (battle-swap-hint)', () => {
  // See the ux4-1 note: the per-case removeChild is skipped on a thrown assertion.
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('BITES: H1 ongoing + canSwap=false + empty bench → zero swap buttons AND a visible hint naming "Party & Box", with the timing clause BEFORE the key name', () => {
    // KILLS (1): no hint at all — the element lookup below is UNCONDITIONAL (no
    //   `if (el !== null)` wrapper), so deleting the element FAILS this case rather
    //   than passing vacuously. That conditional-wrapper mistake is exactly what
    //   ux1's own retro had to correct (see the B4 note above).
    // KILLS (2): a blank hint — presence with empty text tells the player nothing.
    // KILLS (3, red-team M-C) the DISHONEST WORD-ORDER copy: "…press B for Party &
    //   Box after this battle ends". That copy passes a presence-only regex while
    //   leading with an instruction that does not work yet (B is dead while the
    //   overlay is open, and the terminal overlay persists until Esc). Assertion (d)
    //   pins the ORDER, so it reds.
    // Part (a) also carries the old S3: the absence of swap buttons here is
    //   canSwap-driven and CORRECT — together with S1 that is the on-record
    //   refutation of "the swap UI is broken".
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeUx4Callbacks());
    // The WILD-BATTLE shape (canRecruit: true, a bait option, 2 skills, turnNumber 5).
    // This is the state where the hint actually fires most often — a wild encounter with
    // a single party monster — and nothing else in the suite exercises it. It also breaks
    // the fixture constants that let `&& vm.turnNumber === 2` / `&& !vm.canRecruit` /
    // `&& vm.skills.length === 1` predicates survive (red-team F2).
    //
    // STRENGTHENING (review item 2, red-team F5): the next three fields are set NON-DEFAULT
    // here for one reason only — to kill three MEASURED surviving predicate conjuncts. All
    // 47 tests were green with each of `&& vm.weather === null`,
    // `&& vm.playerCard.status === null` and `&& vm.cureItems.length === 0` added to the
    // toggle, because those fields were null/null/[] on every H fixture. H1 is the natural
    // home: it is the hint-VISIBLE case, so a conjunct that reads any of them flips this
    // case's expected `display !== 'none'` to 'none' and reds HERE. No new case needed.
    // The shapes are real ones buildBattleViewModel emits: `weather.label` is a
    // weatherBanner() output ('Rain'), `playerCard.status` is a statusBadge() output ('PSN'),
    // and the cure item satisfies the classify-by-data rule (cureStatus !== null, count > 0).
    view.refresh(
      makeUx4EmptySwapVM({
        turnNumber: 5,
        canRecruit: true,
        baitOptions: [{ itemId: 7, name: 'Lure Berry', recruitBonus: 150, count: 2 }],
        skills: UX4_TWO_SKILLS,
        // Kills `&& vm.weather === null` (M14d weather/field-state).
        weather: { label: 'Rain', turnsRemaining: 3 },
        // Kills `&& vm.playerCard.status === null` (M14a status effects).
        playerCard: { ...makeUx4VM().playerCard, status: 'PSN' },
        // Kills `&& vm.cureItems.length === 0` (M14e status-curing items).
        cureItems: [{ itemId: 12, name: 'Antidote', cureStatus: 'Poison', count: 1 }],
      }),
    );
    view.show();

    // (a0) FIXTURE-VARIATION GUARD (review item 2). The three non-default fields above are
    // only teeth while they REACH the render. If a future edit to makeUx4VM /
    // makeUx4EmptySwapVM ever hard-codes them back to null/null/[] after the override spread,
    // the three conjuncts below become survivors again — silently, because H1's display
    // assertion would still be green. These three DOM probes make that regression loud.
    // They are proof-of-variation, NOT a claim about the hint.
    // Named `...El` so it cannot be confused with battleModel's `weatherBanner()` mapper.
    const weatherBannerEl = parent.querySelector(
      '[data-testid="weather-banner"]',
    ) as HTMLElement | null;
    expect(
      weatherBannerEl?.style.display,
      'precondition (H1a0): vm.weather must be non-null and reach #renderWeather — that is what ' +
        'kills the measured `&& vm.weather === null` conjunct. If this fails, the fixture ' +
        'variation has been undone and that mutant is a survivor again',
    ).toBe('block');
    expect(
      parent.querySelector('[data-testid="cure-item-selector"]'),
      'precondition (H1a0): vm.cureItems must be non-empty and reach #renderCureItems — that is ' +
        'what kills the measured `&& vm.cureItems.length === 0` conjunct',
    ).not.toBeNull();
    expect(
      parent.textContent,
      'precondition (H1a0): vm.playerCard.status must be non-null and reach #renderMonsterCard ' +
        "(the 'PSN' badge) — that is what kills the measured `&& vm.playerCard.status === null` " +
        'conjunct',
    ).toContain('PSN');

    // (a) no swap control of EITHER label form is rendered.
    const anySwapButtons = [...parent.querySelectorAll('button')].filter((b) => {
      const t = b.textContent ?? '';
      return t.startsWith('Swap: ') || t.startsWith('Submit Swap: ');
    });
    expect(
      anySwapButtons.map((b) => b.textContent),
      'ux4-2 (H1a): with canSwap=false and an empty bench there must be NO swap control of ' +
        'either label form. This is the silent dead-end the hint exists to explain — and, with ' +
        'S1, the record that the absence is canSwap-driven rather than a rendering bug',
    ).toHaveLength(0);

    // (b) the hint exists and is visible. UNCONDITIONAL — deletion must fail here.
    const el = parent.querySelector(UX4_SWAP_HINT_SELECTOR) as HTMLElement | null;
    expect(
      el,
      'ux4-2 (H1b): a [data-testid="battle-swap-hint"] element must exist. This lookup is ' +
        'deliberately NOT wrapped in `if (el !== null)`: absence must FAIL, because H1 is the ' +
        'case the rest of this describe is measured against',
    ).not.toBeNull();
    expect(
      el!.style.display,
      'ux4-2 (H1b): the hint must be VISIBLE in the empty-swap state — an element created but ' +
        'never toggled on is the same silent dead-end as having no element',
    ).not.toBe('none');

    const text = el!.textContent ?? '';

    // (c) names the literal h2 the player will actually see (boxView's constructor title).
    expect(
      text,
      'ux4-2 (H1c): the hint must name the literal "Party & Box" screen (the title h2 boxView\'s ' +
        'constructor puts in its header row) — a vague "your team" sends the player looking for a ' +
        'screen that does not exist under that name',
    ).toContain('Party & Box');

    // (d) ORDER, not presence. A timing qualifier must come FIRST, then the key name.
    //
    // TESTER NOTE (judgement call, logged): the plan writes the key-name probe as
    // /press\s+B\b/i, but that regex does not match the plan's own COPY A — which
    // reads "press Esc, then B for Party & Box", so the token after "press" is "Esc".
    // Taking the regex literally would red a verbatim-correct implementation. The
    // probe is therefore the standalone-B key token /\bB\b/ (case-sensitive: the key
    // the player presses is uppercase B; "Box"/"battle" cannot match because \b
    // requires a non-word char after the B). This PRESERVES the bite — under the
    // word-order-swapped mutant the standalone B appears BEFORE the timing clause,
    // so the strict inequality still fails — and it strengthens (c)/(d) jointly by
    // no longer depending on one particular verb.
    //
    // RECOMPUTED for the revised COPY A (review item 1). The reason clause now itself
    // contains the words "in this battle", so it is worth stating explicitly why the two
    // probes still land where they must:
    //   • `timingIndex` = 52 — the timing alternation needs the literal "when this battle
    //     ends"; the reason clause's "in this battle" does NOT match either alternative, so
    //     the probe cannot be pulled backwards into sentence one.
    //   • `keyIndex`    = 91 — `/\bB\b/` is case-sensitive, so the four lowercase "battle"
    //     tokens are not candidates, and "Box" fails the trailing \b. The only standalone
    //     uppercase B is the key name.
    //   ⇒ 52 < 91, and the word-order-swapped mutant still inverts them. Bite preserved.
    const timingIndex = text.search(/when this battle ends|after (?:this|the) battle/i);
    const keyIndex = text.search(/\bB\b/);
    expect(
      timingIndex,
      'ux4-2 (H1d): the hint MUST carry a timing qualifier ("When this battle ends" / "after ' +
        'this battle"). Without it the copy promises an action that cannot be taken yet: KeyB is ' +
        'gated on `shouldToggleBox(battleView?.visible ?? false)` (main.ts:551-577) and ' +
        'inputGuards.ts:6-8 is `return !battleVisible`, so B is dead for the WHOLE battle',
    ).toBeGreaterThanOrEqual(0);
    expect(
      keyIndex,
      'ux4-2 (H1d): the hint MUST name the B key — omitting it is honest but leaves the player ' +
        'exactly where the playtest report left them (unable to find any way to switch monsters)',
    ).toBeGreaterThanOrEqual(0);
    expect(
      keyIndex,
      `ux4-2 (H1d) CLAUSE ORDER: the timing qualifier (index ${timingIndex}) must come STRICTLY ` +
        `BEFORE the B key name (index ${keyIndex}). Copy text was: ${JSON.stringify(text)}. ` +
        'The word-order-swapped variant ("press B for Party & Box after this battle ends") ' +
        'contains every required token and passes a presence-only check, yet it leads with an ' +
        'instruction that does not work at the moment it is read — the ux1 failure mode ' +
        '(ADR-0151: never advertise an action that cannot be taken) repeated one slice later',
    ).toBeGreaterThan(timingIndex);

    // (e) the Esc step. Required, not decorative: a terminal battle row is not GC'd on
    // resolution (battle.rs:1013-1022 deletes only PRIOR terminals) and
    // decideBattleOverlay keeps returning `show` for a non-dismissed terminal
    // (battleModel.ts:379-386), so the overlay STAYS UP after victory/defeat/flee and
    // B stays dead until Escape. "When this battle ends, press B" alone is factually
    // incomplete — the player presses B and nothing happens.
    expect(
      text,
      'ux4-2 (H1e): the hint must name the Esc step. The battle overlay persists after the ' +
        'result (no GC of the terminal row; decideBattleOverlay still returns `show`), and ' +
        'Escape on an ongoing battle is a bare hide that the NEXT batch re-shows ' +
        '(main.ts:981-990, :1200,:1206-1207) — so B is unreachable until the player dismisses ' +
        'the result. A copy without Esc is a lie by omission',
    ).toMatch(/\bEsc/i);

    // -----------------------------------------------------------------------
    // (f) COPY TEETH (red-team F3/F6). The token/order assertions above are
    // necessary but NOT sufficient: two measured copies passed all of (a)-(e).
    //   • a NEEDLE SALAD — "after this battle Esc B Party & Box" — every token
    //     present, in the right order, and completely unreadable;
    //   • a FLUENT LIE — COPY A plus "…or just press B and heal your party right
    //     now, it works anywhere" — which is false twice over (B is dead while the
    //     overlay is open, and heal_party is zone-gated).
    // The literal clause pins below make the copy readable prose; the index-ordering
    // assertions above remain as the DOCUMENTATION of why the order matters (they
    // explain the constraint that the literal pin merely enforces).
    // -----------------------------------------------------------------------
    // CORRECTED PIN (review item 1) — NOT a weakening. Was
    // `.toContain('No healthy party monster to swap in.')`. The unscoped claim is
    // FALSIFIABLE MID-BATTLE by a player following this very copy: Esc on an ongoing
    // battle is a bare `battleView.hide()`, which un-gates KeyB; `set_party_slot` has no
    // in-battle guard (server-module/src/monster_mgmt.rs), so `To Party` is ACCEPTED; that
    // row-write is the batch that re-shows the overlay; and because `sideA.team` is a
    // battle-row SNAPSHOT, `canSwap` stays false and the banner re-asserts a claim the
    // player has just disproved. Adding "in this battle" makes the sentence TRUE in that
    // state. RATIONALE FOR THE NEW EXPECTED VALUE, tied to the spec: the spec's honesty
    // spine (ADR-0151 — never state something the player can falsify) requires the claim
    // be scoped to what the view can actually see, and the view only ever sees this
    // battle's side A. The pin is STRICTLY STRONGER: the old literal is a substring of
    // nothing in the new copy, so every impl the old pin rejected is still rejected, AND
    // the unscoped-copy impl (which the old pin ACCEPTED) now reds too.
    // -----------------------------------------------------------------------
    expect(
      text,
      'ux4-2 (H1f): the hint must open by stating the REASON as a readable clause, SCOPED to this ' +
        'battle. A copy that merely contains the right tokens ("healthy … swap … Party & Box") in ' +
        'the right order can still be an unreadable needle salad — measured passing every ' +
        'token/order assertion above. And the UNSCOPED "No healthy party monster to swap in." is ' +
        'falsifiable mid-battle by a player who follows the copy: Esc un-gates KeyB, set_party_slot ' +
        'has no in-battle guard, and the resulting row-write re-shows the overlay with canSwap ' +
        'still false (sideA.team is a battle-row snapshot) — so the banner would repeat a claim the ' +
        'player just disproved. "in this battle" is the honesty fix and must be preserved',
    ).toContain('No healthy party monster in this battle to swap in.');
    expect(
      text,
      'ux4-2 (H1f): the hint must carry the remedy as ONE readable clause in the mandated order — ' +
        'timing, then Esc, then B, then the screen name. This is the literal form of the ordering ' +
        'constraint asserted by index above',
    ).toContain('When this battle ends, press Esc, then B for Party & Box');

    // -----------------------------------------------------------------------
    // (g) REASON BEFORE REMEDY — a SECOND, INDEPENDENT ordering property.
    //
    // MEASURED SURVIVOR (42 passed) that this closes — the WHOLE-SENTENCE swap:
    //   'When this battle ends, press Esc, then B for Party & Box. No healthy party
    //    monster in this battle to swap in.'
    // Same words, same two clauses, sentences reordered. Nothing above could see it:
    //   • H1f's two `toContain` pins are order-INDEPENDENT (each clause is intact and
    //     present, just relocated);
    //   • H1d still PASSES, because in that arrangement the timing clause ("When this
    //     battle ends") STILL precedes the standalone `B` — H1d's inequality is
    //     satisfied inside the remedy sentence, wherever that sentence happens to sit.
    //
    // WHY THIS IS A DIFFERENT PROPERTY FROM H1d (do not merge them):
    //   • H1d gates ordering WITHIN the remedy — timing qualifier before the key name —
    //     so the copy never tells the player to press a key that is dead right now.
    //   • (g) gates ordering BETWEEN the two clauses — the explanation before the
    //     instruction — so the banner never opens with a keystroke and buries the reason
    //     the player is stuck. A hint whose first words are "When this battle ends, press
    //     Esc, then B…" reads as an unprompted command: the player does not yet know WHY
    //     they are being told to leave the battle, which is the ux1 failure shape
    //     (ADR-0151) in miniature — an affordance advertised ahead of its justification.
    //     This hint exists to answer a question ("where did my swap option go?"); the
    //     answer must come before the directions.
    //
    // Both index lookups are safe: the two `toContain` assertions immediately above have
    // already proved each literal is present, so neither indexOf can be -1 here without
    // this case having failed first. `String.indexOf` — no `new RegExp` (ReDoS lint).
    // -----------------------------------------------------------------------
    const reasonIndex = text.indexOf('No healthy');
    const remedyIndex = text.indexOf('When this battle ends');
    expect(
      reasonIndex,
      `ux4-2 (H1g) REASON BEFORE REMEDY: the reason clause (index ${reasonIndex}) must come ` +
        `STRICTLY BEFORE the remedy clause (index ${remedyIndex}). Copy text was: ` +
        `${JSON.stringify(text)}. THE MUTANT THIS KILLS is the whole-sentence swap — the same ` +
        'two clauses with the sentences reordered ("When this battle ends, press Esc, then B for ' +
        'Party & Box. No healthy party monster in this battle to swap in."), measured SURVIVING ' +
        'the whole suite: both `toContain` pins above are order-independent, and H1d still passes ' +
        'because the timing clause still precedes the standalone B inside the relocated remedy ' +
        'sentence. This assertion gates a DIFFERENT property from H1d: H1d orders timing before ' +
        'key WITHIN the remedy; this orders explanation before instruction BETWEEN the clauses. A ' +
        'banner that opens with a keystroke and buries the reason is the ADR-0151 shape in ' +
        'miniature — an affordance advertised ahead of its justification, on a hint whose whole ' +
        'job is to answer "where did my swap option go?" before giving directions',
    ).toBeLessThan(remedyIndex);

    expect(
      text,
      'ux4-2 (H1f) NO HEAL ADVICE: `heal_party` is ZONE-GATED (raising.rs:302-304; the only heal ' +
        'location in content is zone_id 0, healModel.ts:31-35 always picks locations[0], and ' +
        'main.ts:1756-1759 skips the send entirely when no heal location is in the store), while ' +
        'zone 1 exists with its own encounter table. "or heal your monsters" is therefore FALSE ' +
        'outside zone 0 — and nothing in the tree gated that until this assertion. NOTE the word ' +
        'boundary: a naive /heal/i would false-fail on the copy\'s own word "healthy"',
    ).not.toMatch(/\bheal(s|ing)?\b/i);
    expect(
      text,
      "ux4-2 (H1f) NO HP-SHAPED COPY: mirrors X4's fence in boxView.test.ts. A measured mutant " +
        'put "HP 3/3 · " into COPY A and moved the element to be #root\'s FIRST child, which ' +
        'inverts the positional `allHpTexts[0]/[1]` opponent-affinity assumption documented at ' +
        'client/e2e/recruit.spec.ts:650-655,:688-697',
    ).not.toMatch(/HP\s*\d+\s*\/\s*\d+/);
    // ---------------------------------------------------------------------
    // NEW FENCE (review item 3, red-team F6) — NO OTHER KEY, NO HELP AFFORDANCE.
    // MEASURED SURVIVOR: COPY A + ' Or press ? for help.' (124 chars, under the old 140
    // cap) passed every single H assertion. That addition is the literal ux1 lie, ungated:
    // `?` is DEAD while the battle overlay is open — main.ts's help handler leads with
    // `!battleView?.visible`, so the key the copy tells the player to press does nothing
    // at the moment they read it. This is the same defect class as the word-order mutant
    // (d) kills, arriving as an EXTRA sentence rather than a reordered one, so the order
    // assertions cannot see it. Two literal probes (no `new RegExp` — ReDoS lint).
    // ---------------------------------------------------------------------
    expect(
      text,
      'ux4-2 (H1f) NO SECOND KEY: the copy must not name `?`. The measured additive mutant ' +
        "(COPY A + ' Or press ? for help.') slipped past every other assertion here, yet `?` is " +
        "DEAD while this overlay is open — main.ts's help handler leads with `!battleView?.visible` " +
        '— so it advertises an action that cannot be taken: exactly the ADR-0151 defect this slice ' +
        'exists to avoid repeating. Esc and B are the ONLY keys this copy may name, and both are ' +
        'gated on the timing clause (d) pins',
    ).not.toMatch(/\?/);
    expect(
      text,
      'ux4-2 (H1f) NO HELP AFFORDANCE: the copy must not point at the help overlay in any wording ' +
        '("for help", "see help"). ux1 (ADR-0151) shipped the help hint; this hint must not ' +
        're-advertise it from a screen where the key is inert',
    ).not.toMatch(/\bhelp\b/i);
    expect(
      text.length,
      `ux4-2 (H1f) LENGTH CAP: the hint copy is ${text.length} chars. The shipped COPY A is 109. ` +
        'The cap structurally bounds ADDITIVE dishonesty — the fluent-lie mutant above (COPY A ' +
        'plus a false sentence about pressing B and healing right now) measures ~150 chars and ' +
        'dies here even if it slips past every keyword fence. TIGHTENED 140 → 120 (review item 3): ' +
        'at 140 there were 31 chars of free additive room, and the measured ' +
        "' Or press ? for help.' mutant (124 chars bolted onto the pre-revision copy, 130 onto the " +
        'shipped one) fitted inside it either way. 120 leaves 11 chars of headroom over the shipped ' +
        'copy — enough for ordinary punctuation edits, not enough for a second claim. It also keeps ' +
        'the banner inside its 320px column',
    ).toBeLessThanOrEqual(120);
    expect(
      text,
      'ux4-2 (H1f): the copy must say WHY, not just which key — "healthy" is the load-bearing ' +
        'word: the empty-swap state is reachable both with one party monster AND with 2+ where ' +
        'every non-active one has fainted (battleModel.ts:262 filters on currentHp > 0)',
    ).toMatch(/healthy/i);
    expect(
      text,
      'ux4-2 (H1f): the copy must name the action it is explaining the absence of (swap)',
    ).toMatch(/swap/i);

    document.body.removeChild(parent);
  });

  it('BITES: H2 ongoing + canSwap=true + non-empty bench → hint EXISTS and is display:none', () => {
    // THIS IS WHAT MAKES H1 NON-VACUOUS. The cheapest way to green H1 with zero logic
    // is to create the element in the constructor with display:block (or no display at
    // all) and never toggle it. That impl fails here: while real swap buttons are on
    // screen, "No healthy party monster in this battle to swap in" is false, and it would
    // sit directly beside the very buttons it denies.
    // KILLS: the always-visible hint (constructor display:block, never toggled).
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeUx4Callbacks());
    // turnNumber 9 (H1 uses 5, H3 uses 12) so no predicate can silently read it — F2.
    view.refresh(makeUx4SwappableVM({ turnNumber: 9 }));
    view.show();

    const el = parent.querySelector(UX4_SWAP_HINT_SELECTOR) as HTMLElement | null;
    expect(
      el,
      'ux4-2 (H2): the hint element must EXIST even when swapping IS available — it is created ' +
        'once in the constructor and only toggled thereafter. Without this unconditional ' +
        'not-null assertion, the case that makes H1 non-vacuous could itself pass vacuously ' +
        'against a deleted element',
    ).not.toBeNull();
    expect(
      el!.style.display,
      'ux4-2 (H2): the hint must be HIDDEN whenever swap buttons are rendered. An element created ' +
        'display:block and never toggled greens H1 with no logic at all — and ships a banner ' +
        'reading "No healthy party monster in this battle to swap in" immediately above two live ' +
        '"Swap: …" buttons',
    ).toBe('none');

    document.body.removeChild(parent);
  });

  it.each([
    { outcome: 'SideAWins' as const },
    { outcome: 'SideBWins' as const },
    { outcome: 'Fled' as const },
  ])('BITES: H3 terminal outcome $outcome (canSwap=false, empty bench) → swap hint hidden while the ux1 continue hint stays visible', ({
    outcome,
  }) => {
    // KILLS: the MOST LIKELY wrong implementation — a predicate missing the
    //   `vm.outcome === 'Ongoing' &&` conjunct, i.e. keyed on `!vm.canSwap` alone.
    //   `canSwap` is false and `bench` is empty on EVERY terminal outcome
    //   (battleModel.ts:258 gates the bench loop on `ongoing`), so a bench-or-canSwap-only
    //   predicate parks "No healthy party monster in this battle to swap in. When this
    //   battle ends…" right next to "Victory!" and ux1's "Press Esc to continue" — advice
    //   about a battle that has already ended, on the very overlay ux1 just made honest.
    // ALSO GATES ux1: the continue-hint clause in the same assertion means a regression
    //   that hides the ux1 exit affordance while wiring the ux4 one cannot pass here.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeUx4Callbacks());
    // turnNumber 12 and skills:[] — distinct from H1 (5, two skills) and H2 (9, one
    // skill) so an incidental-field predicate cannot hide behind a shared constant (F2).
    view.refresh(
      makeUx4VM({
        outcome,
        isPvp: false,
        canSwap: false,
        bench: [],
        canFlee: false,
        turnNumber: 12,
        skills: [],
      }),
    );
    view.show();

    const swapHint = parent.querySelector(UX4_SWAP_HINT_SELECTOR) as HTMLElement | null;
    expect(
      swapHint,
      `ux4-2 (H3/${outcome}): the swap hint element must exist on the result overlay too ` +
        '(created once in the constructor, only toggled thereafter)',
    ).not.toBeNull();
    const continueHint = parent.querySelector(CONTINUE_HINT_SELECTOR) as HTMLElement | null;
    expect(
      continueHint,
      `precondition (H3/${outcome}): ux1's continue hint must exist — it is the second half of ` +
        "this case's single conjunction",
    ).not.toBeNull();

    const swapHidden = swapHint!.style.display === 'none';
    const continueVisible = continueHint!.style.display !== 'none';
    expect(
      swapHidden && continueVisible,
      `ux4-2 (H3/${outcome}) ONE CONJUNCTION — swapHintHidden=${String(swapHidden)} ` +
        `(display=${JSON.stringify(swapHint!.style.display)}), ` +
        `continueHintVisible=${String(continueVisible)} ` +
        `(display=${JSON.stringify(continueHint!.style.display)}). The toggle predicate MUST ` +
        "include the `vm.outcome === 'Ongoing' &&` conjunct: canSwap is false and bench is " +
        'empty on every terminal outcome, so a `!vm.canSwap`-only predicate shows swap advice ' +
        'on the result screen. And ux1-2 must keep its exit affordance on that same screen',
    ).toBe(true);

    document.body.removeChild(parent);
  });

  it('BITES: H4 the hint is a #root sibling of #outcomeEl — NOT inside #actionsEl, NOT on the caller-supplied parent — and 3 refreshes leave exactly one', () => {
    // KILLS (anti-pattern 3): appending the hint to the caller-supplied `parent`
    //   instead of `#root`. The IDENTICAL mutant passed the ENTIRE suite during ux1,
    //   because every case queries `parent.querySelector`, which matches a direct child
    //   of `parent` as happily as a descendant of `#root`. In production `parent` is
    //   `#app` — the PixiJS canvas container — so the hint becomes an unpositioned
    //   in-flow div AFTER a viewport-tall canvas (below the fold: ux1's own defect),
    //   survives `hide()`, and re-lengthens the document (the ADR-0146 scroll mechanism).
    // KILLS (anti-pattern 2): making the hint a CHILD of #actionsEl. `#renderActions`
    //   opens with `this.#actionsEl.replaceChildren()`, so the hint would be detached on
    //   the very next refresh.
    // KILLS (anti-pattern 7): a per-render `appendChild` — N duplicate hints after N
    //   batches, which a presence-only check cannot see.
    //
    // ANCHORS ARE NAMED EXPLICITLY, because a wrong anchor makes this silently vacuous
    // (cf. the tester note at battleView.test.ts:1007-1013): `#root` is resolved as the
    // outcome banner's parentElement, and `#actionsEl` as the Flee button's parentElement.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeUx4Callbacks());
    view.refresh(makeUx4EmptySwapVM());
    view.show();

    const outcomeEl = parent.querySelector('[data-testid="outcome-text"]');
    expect(
      outcomeEl,
      'precondition (H4): the outcome banner must exist — it is the anchor that identifies ' +
        "BattleView's #root regardless of child insertion order",
    ).not.toBeNull();
    const root = outcomeEl!.parentElement;
    expect(
      root,
      "precondition (H4): the outcome banner must have a parent element (BattleView's #root)",
    ).not.toBeNull();
    expect(
      root,
      'precondition (H4): #root must NOT be the caller-supplied parent — if it were, the ' +
        'containment assertions below would degenerate and could not bite',
    ).not.toBe(parent);

    // #actionsEl, named via the Flee button (canFlee is true on this VM).
    const fleeBtn = [...parent.querySelectorAll('button')].find((b) => b.textContent === 'Flee');
    expect(
      fleeBtn,
      'precondition (H4): the Flee button must exist (canFlee=true) — it is the anchor that ' +
        'identifies #actionsEl, the replaceChildren() container the hint must NOT live inside',
    ).toBeDefined();
    const actionsEl = fleeBtn!.parentElement;
    expect(
      actionsEl,
      'precondition (H4): the Flee button must have a parent element (#actionsEl)',
    ).not.toBeNull();

    const el = parent.querySelector(UX4_SWAP_HINT_SELECTOR) as HTMLElement | null;
    expect(el, 'ux4-2 (H4): the hint element must exist').not.toBeNull();
    expect(
      el!.parentElement,
      "ux4-2 (H4): the hint must be appended to BattleView's own #root (a SIBLING of the outcome " +
        'banner and of #actionsEl). Appending it to the caller-supplied `parent` passed the whole ' +
        'suite during ux1: in production `parent` is `#app` (the PixiJS canvas container), so the ' +
        'hint renders below the fold, survives hide(), and re-lengthens the document',
    ).toBe(root);
    expect(
      el!.parentElement,
      'ux4-2 (H4): the hint must NOT be a child of #actionsEl — #renderActions begins with ' +
        '`this.#actionsEl.replaceChildren()`, which would detach the hint on the next refresh',
    ).not.toBe(actionsEl);
    expect(
      el!.parentElement,
      'ux4-2 (H4): the hint must NOT be a direct child of the caller-supplied parent',
    ).not.toBe(parent);

    // -----------------------------------------------------------------------
    // SIBLING ORDER (red-team F6). Parentage alone is not enough: a measured mutant
    // kept the hint inside #root but made it #root's FIRST child, above both monster
    // cards. `client/e2e/recruit.spec.ts:650-655` + `:688-697` locate the opponent's
    // affinity with `text=/HP \d+\/\d+ · /` and then index POSITIONALLY
    // (`allHpTexts[0]` = opponent, `[1]` = player), an assumption that holds only
    // because the opponent card precedes the player card and nothing HP-shaped
    // precedes either. Pinning the hint AFTER both cards makes that documented
    // assumption structural instead of incidental — so a future HP-shaped edit to the
    // copy (which H1f also fences) cannot silently invert the e2e indices.
    // Anchors are resolved by CONTENT, not by index: the cards are the #root children
    // whose text carries the "Opponent: …" / "You: …" labels from #renderMonsterCard.
    // -----------------------------------------------------------------------
    const rootChildren = [...root!.children];
    const opponentCardIndex = rootChildren.findIndex((c) =>
      c.textContent?.includes('Opponent: WildMon'),
    );
    const playerCardIndex = rootChildren.findIndex((c) => c.textContent?.includes('You: Sproutle'));
    const hintIndex = rootChildren.indexOf(el!);
    expect(
      opponentCardIndex,
      'precondition (H4): the opponent card must be a direct #root child carrying ' +
        '"Opponent: WildMon" — it is the positional anchor recruit.spec.ts relies on',
    ).toBeGreaterThanOrEqual(0);
    expect(
      playerCardIndex,
      'precondition (H4): the player card must be a direct #root child carrying "You: Sproutle"',
    ).toBeGreaterThanOrEqual(0);
    expect(
      hintIndex,
      `ux4-2 (H4) SIBLING ORDER: the hint (index ${hintIndex}) must come AFTER both monster cards ` +
        `(opponent ${opponentCardIndex}, player ${playerCardIndex}) in #root's child order. A ` +
        "mutant that keeps correct parentage but makes the hint #root's FIRST child passes every " +
        'other clause in this case, and it inverts the positional HP-text indexing documented at ' +
        'client/e2e/recruit.spec.ts:650-655,:688-697 the moment the copy ever carries HP-shaped text',
    ).toBeGreaterThan(Math.max(opponentCardIndex, playerCardIndex));

    // Idempotence: three more refreshes with the SAME VM.
    const sameVM = makeUx4EmptySwapVM();
    view.refresh(sameVM);
    view.refresh(sameVM);
    view.refresh(sameVM);

    const all = parent.querySelectorAll(UX4_SWAP_HINT_SELECTOR);
    expect(
      all,
      'ux4-2 (H4): the hint must be created ONCE in the constructor and only toggled thereafter. ' +
        'A per-render appendChild yields N duplicate hints after N server batches — a defect a ' +
        'presence-only assertion cannot see',
    ).toHaveLength(1);
    expect(
      (all[0] as HTMLElement).style.display,
      'ux4-2 (H4): the surviving hint must still be visible after repeated refreshes with an ' +
        'unchanged empty-swap VM',
    ).not.toBe('none');

    document.body.removeChild(parent);
  });

  it('BITES: H5 the hint is turned OFF again — (a) refresh(null) resets it, (b) after a bare hide() a canSwap=true VM hides it', () => {
    // KILLS (anti-pattern 5): a SHOW-ONLY toggle with no else-arm
    //   (`if (!vm.canSwap) hint.display = 'block';`). The player then fixes their party,
    //   swap buttons appear — and "No healthy party monster in this battle to swap in"
    //   stays latched directly above them, which is worse than no hint at all.
    // ORDER-SENSITIVITY IS THE POINT (the ADR-0151 B7 analogue, and REQUIRED for the
    //   same reason): H2 builds a FRESH view, so the constructor's own display:none
    //   satisfies it even with the else-arm deleted. Only a sequence that first turns
    //   the hint ON and then re-renders can observe the missing else-arm.
    // Arm (b) uses a BARE `view.hide()` because that is the real production teardown:
    //   main.ts:981-990 dismisses with `battleView.hide()` and main.ts:1209-1211 hides
    //   directly when the battle row is gone. `refresh(null)` is reachable in production
    //   ONLY on the corrupt-VM path, so arm (a)'s reset line is symmetry/defense while
    //   arm (b) is the LIVE defense.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeUx4Callbacks());

    // ---- (a) refresh(null) resets the hint -----------------------------------
    view.refresh(makeUx4EmptySwapVM());
    const el = parent.querySelector(UX4_SWAP_HINT_SELECTOR) as HTMLElement | null;
    expect(el, 'precondition (H5a): the hint element must exist').not.toBeNull();
    expect(
      el!.style.display,
      'precondition (H5a): the hint must be VISIBLE in the empty-swap state, else the reset ' +
        'assertion below would pass for the wrong reason (an always-hidden hint)',
    ).not.toBe('none');

    view.refresh(null);
    expect(
      (parent.querySelector(UX4_SWAP_HINT_SELECTOR) as HTMLElement | null)!.style.display,
      'ux4-2 (H5a): the refresh(null) branch must reset the swap hint to display:none alongside ' +
        "the existing #weatherEl / #pvpStatusEl / #continueHintEl resets — that branch's stated " +
        'invariant is "null VM ⇒ every banner is reset"',
    ).toBe('none');

    // ---- (b) the live path: bare hide(), then a VM where swapping IS possible --
    view.refresh(makeUx4EmptySwapVM());
    expect(
      view.visible,
      'precondition (H5b): refresh(vm) must self-show the overlay — otherwise a latched hint ' +
        'would not be on screen and this case would not be testing the defect',
    ).toBe(true);
    expect(
      (parent.querySelector(UX4_SWAP_HINT_SELECTOR) as HTMLElement | null)!.style.display,
      'precondition (H5b): the hint must be visible again before the bare hide()',
    ).not.toBe('none');

    // The real production dismiss: a bare hide(), NOT refresh(null).
    view.hide();

    // The player has since moved a healthy monster into their party: canSwap=true.
    view.refresh(makeUx4SwappableVM());

    const elAfter = parent.querySelector(UX4_SWAP_HINT_SELECTOR) as HTMLElement | null;
    expect(
      elAfter,
      'ux4-2 (H5b): the hint element must not be removed from the DOM by a re-render',
    ).not.toBeNull();
    expect(
      elAfter!.style.display,
      'ux4-2 (H5b) NO STALE LIE: the toggle needs a real ELSE-ARM ' +
        "(`= cond ? 'block' : 'none'`), not a show-only `if`. With no else-arm the hint stays " +
        'latched at display:block across the bare hide() dismiss (main.ts:981-990 / :1209-1211, ' +
        'neither of which calls refresh(null)), so once the player fixes their party the banner ' +
        '"No healthy party monster in this battle to swap in" renders directly above two live ' +
        '"Swap: …" buttons. H2 cannot see this: it builds a FRESH view whose constructor ' +
        'display:none already satisfies it',
    ).toBe('none');

    document.body.removeChild(parent);
  });

  it('BITES: H6 PvP (isPvp=true, pvpPendingSubmit=false) ongoing + canSwap=false → hint is VISIBLE (no isPvp branch)', () => {
    // KILLS: an `&& !vm.isPvp` (or `vm.isPvp ? 'none' : …`) conjunct added to the
    //   predicate. Red-team measured that mutant surviving EVERY other H-case, because
    //   H1/H4/H5 are all PvE. This case pins the plan's own explicit decision — no
    //   isPvp branch, following the ADR-0151 D3 precedent.
    // WHY THE HINT IS TRUTHFUL HERE: the PvP swap control is suppressed only while
    //   `pvpPendingSubmit` is true (`#renderSwapButtons`' early return), and this VM sets
    //   it false — so `canSwap=false` really does mean "no healthy party monster in this
    //   battle to swap in".
    // DISCLOSED SCOPE LIMIT (deferral D6): in PvP only side A (the challenger, who IS
    //   `player_identity`) receives a battle overlay at all — `latestPlayerBattle`
    //   (main.ts:1138 / net/store.ts:718-726) skips rows where the identity is the
    //   `opponent_identity` (pvp.rs:291). So this hint is side-A-only in PvP, and
    //   "B is dead while the battle overlay is open" is a side-A statement.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeUx4Callbacks());
    view.refresh(
      makeUx4VM({
        isPvp: true,
        pvpPendingSubmit: false,
        pvpOpponentName: 'Rival',
        canSwap: false,
        bench: [],
        canFlee: false,
        turnNumber: 4,
      }),
    );
    view.show();

    const el = parent.querySelector(UX4_SWAP_HINT_SELECTOR) as HTMLElement | null;
    expect(el, 'ux4-2 (H6): the hint element must exist in a PvP battle too').not.toBeNull();
    expect(
      el!.style.display,
      'ux4-2 (H6): the empty-swap hint must be VISIBLE in PvP as well. An `&& !vm.isPvp` conjunct ' +
        'survives every other H-case (all PvE) while stripping the explanation from the PvP ' +
        'dead-end — the plan deliberately specifies NO isPvp branch (ADR-0151 D3 precedent), and ' +
        "this case is that decision's pin",
    ).not.toBe('none');

    document.body.removeChild(parent);
  });

  it('BITES: H7 LIVE-VIEW TRANSITIONS — no hide(), no refresh(null): (a) ongoing→victory hides the hint, (b) ongoing→canSwap:true hides it', () => {
    // *** THE CRITICAL GAP (red-team F1). *** Every other H-case builds a FRESH view and
    // refreshes at most once with a non-null VM, so NONE of them observes a TRANSITION.
    // MEASURED SURVIVOR: a show-only toggle
    //     if (vm.outcome === 'Ongoing' && !vm.canSwap) this.#swapHintEl.style.display = 'block';
    // with no else-arm, the reset MOVED into hide(), and the refresh(null) reset DELETED.
    // That impl passes H5a (because refresh(null) itself calls this.hide(), which now
    // resets) and H5b (whose dismiss IS view.hide()), yet it was measured parking the
    // hint next to "Victory!" (outcomeDisplay=block hintDisplay=block) and next to a live
    // "Swap: " button. H5's two arms are both hide()-mediated; this case is deliberately
    // NOT — there is no hide() and no refresh(null) anywhere in it, so the ONLY thing that
    // can turn the hint off is the else-arm of the predicate inside #renderActions.
    //
    // Each arm is a single conjunction pairing "hint off" with POSITIVE evidence that the
    // new state really arrived (the outcome text / a live swap button), so neither arm can
    // pass because the second refresh silently did nothing.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    // ---- (a) ongoing (no swap) → terminal victory, on ONE live view ----------
    const viewA = new BattleView(parent, makeUx4Callbacks());
    viewA.refresh(makeUx4EmptySwapVM({ turnNumber: 3 }));
    const hintA = parent.querySelector(UX4_SWAP_HINT_SELECTOR) as HTMLElement | null;
    expect(hintA, 'precondition (H7a): the hint element must exist').not.toBeNull();
    expect(
      hintA!.style.display,
      'precondition (H7a): the hint must be VISIBLE on the ongoing empty-swap VM, or the ' +
        'transition assertion below would pass for the wrong reason (an always-hidden hint)',
    ).not.toBe('none');

    // The battle resolves. NO hide(), NO refresh(null) — exactly what main.ts does on the
    // batch that carries the terminal row (refreshBattle → battleView.refresh(vm)).
    viewA.refresh(makeUx4VM({ outcome: 'SideAWins', canSwap: false, bench: [], canFlee: false }));

    const outcomeA = parent.querySelector('[data-testid="outcome-text"]') as HTMLElement | null;
    expect(outcomeA, 'precondition (H7a): the outcome banner must exist').not.toBeNull();
    const hintHiddenA = hintA!.style.display === 'none';
    const victoryArrived = outcomeA!.textContent === 'Victory!';
    expect(
      hintHiddenA && victoryArrived,
      `ux4-2 (H7a) ONE CONJUNCTION — hintHidden=${String(hintHiddenA)} ` +
        `(display=${JSON.stringify(hintA!.style.display)}), outcomeText=` +
        `${JSON.stringify(outcomeA!.textContent)} (expected "Victory!"). On a LIVE view, with no ` +
        'hide() and no refresh(null) between the two refreshes, the swap hint must be turned OFF ' +
        'by the else-arm of its own predicate. A show-only toggle whose reset lives in hide() ' +
        'passes BOTH H5 arms (refresh(null) calls hide(); H5b dismisses with hide()) and still ' +
        'parks "No healthy party monster in this battle to swap in. When this battle ends…" ' +
        'directly beside "Victory!" — advice about a battle that has already ended, on the very ' +
        'overlay ux1 just made honest. The Victory! clause proves the new state actually arrived',
    ).toBe(true);

    // ---- (b) ongoing (no swap) → ongoing WITH a swappable bench, one view ----
    const parentB = document.createElement('div');
    document.body.appendChild(parentB);
    const viewB = new BattleView(parentB, makeUx4Callbacks());
    viewB.refresh(makeUx4EmptySwapVM({ turnNumber: 6 }));
    const hintB = parentB.querySelector(UX4_SWAP_HINT_SELECTOR) as HTMLElement | null;
    expect(hintB, 'precondition (H7b): the hint element must exist').not.toBeNull();
    expect(
      hintB!.style.display,
      'precondition (H7b): the hint must be VISIBLE before the swap becomes available',
    ).not.toBe('none');

    // The player's fainted bench monster is revived / a monster is added: canSwap flips
    // true mid-battle. Again NO hide(), NO refresh(null) — this is an ordinary batch tick.
    viewB.refresh(makeUx4SwappableVM({ turnNumber: 7 }));

    const liveSwapButtons = [...parentB.querySelectorAll('button')].filter((b) =>
      b.textContent?.startsWith('Swap: '),
    );
    const hintHiddenB = hintB!.style.display === 'none';
    const swapButtonsArrived = liveSwapButtons.length > 0;
    expect(
      hintHiddenB && swapButtonsArrived,
      `ux4-2 (H7b) ONE CONJUNCTION — hintHidden=${String(hintHiddenB)} ` +
        `(display=${JSON.stringify(hintB!.style.display)}), liveSwapButtons=` +
        `${String(liveSwapButtons.length)} (must be > 0). The moment swapping becomes possible ` +
        'the explanation of its absence must disappear, on the SAME live view, with no hide() and ' +
        'no refresh(null) to launder the state. Otherwise the player sees "No healthy party ' +
        'monster in this battle to swap in" directly above the "Swap: …" buttons that prove it ' +
        'false — strictly worse than shipping no hint at all',
    ).toBe(true);

    document.body.removeChild(parent);
    document.body.removeChild(parentB);
  });

  it('BITES: H8 canSwap=false with a NON-EMPTY bench → hint VISIBLE and zero "Swap: " buttons (pins !vm.canSwap, not bench.length)', () => {
    // *** PINS THE PREDICATE ITSELF (red-team F2). *** The plan REJECTED
    // `vm.bench.length === 0` in favour of `!vm.canSwap`, but that rejected predicate
    // passed all twelve of the other cases — nothing separated them.
    //
    // CORRECTION TO THE PLAN'S STATED JUSTIFICATION (measured, and the ADR carries the
    // same correction): the plan claims the differentiator is an inconsistent
    // `canSwap:true, bench:[]` VM, under which "a bench-based predicate renders NEITHER
    // buttons NOR hint". That was measured WRONG — under BOTH predicates that VM renders
    // neither buttons nor hint (the buttons are gated by `#renderActions`' `if (vm.canSwap)`
    // and the loop body iterates an empty `bench`; the hint is hidden because canSwap is
    // true), so it cannot tell the two predicates apart.
    //
    // THE ONLY VM SHAPE THAT SEPARATES THEM is the complementary one used here:
    //     outcome:'Ongoing', canSwap:false, bench:[one member]
    //   • `!vm.canSwap`        → hint SHOWN  (correct: no buttons are rendered, because
    //                            `#renderActions`' `if (vm.canSwap)` never calls
    //                            #renderSwapButtons at all)
    //   • `bench.length === 0` → hint HIDDEN (WRONG: zero buttons AND no explanation —
    //                            precisely the silent dead-end this slice exists to remove)
    // Keying the hint off the SAME flag the buttons are gated on is what makes
    // "hint shown ⟺ no swap buttons rendered" STRUCTURAL rather than derived through the
    // model's `canSwap = bench.length > 0` identity (battleModel.ts:316) — an identity the
    // view has no way to enforce and must not assume.
    const parent = document.createElement('div');
    document.body.appendChild(parent);

    const view = new BattleView(parent, makeUx4Callbacks());
    view.refresh(
      makeUx4VM({
        outcome: 'Ongoing',
        isPvp: false,
        canSwap: false,
        bench: [UX4_BENCH[0]],
        turnNumber: 8,
        canRecruit: false,
      }),
    );
    view.show();

    const swapButtons = [...parent.querySelectorAll('button')].filter((b) => {
      const t = b.textContent ?? '';
      return t.startsWith('Swap: ') || t.startsWith('Submit Swap: ');
    });
    expect(
      swapButtons.map((b) => b.textContent),
      'precondition (H8): with canSwap=false NO swap button may be rendered, regardless of what ' +
        "`bench` contains — `#renderActions`' `if (vm.canSwap)` gates #renderSwapButtons on that " +
        'flag alone. This is what makes the hint the ONLY thing standing between the player and a ' +
        'silent dead-end in this state',
    ).toHaveLength(0);

    const el = parent.querySelector(UX4_SWAP_HINT_SELECTOR) as HTMLElement | null;
    expect(el, 'ux4-2 (H8): the hint element must exist').not.toBeNull();
    expect(
      el!.style.display,
      'ux4-2 (H8) PREDICATE PIN: the toggle must read `!vm.canSwap`, NOT `vm.bench.length === 0`. ' +
        'This VM (canSwap=false, bench=[1 member], Ongoing) is the ONLY shape that separates the ' +
        "two — the plan's own suggested discriminator (canSwap:true, bench:[]) was measured to " +
        'behave identically under both. Under the bench-based predicate this state renders zero ' +
        'swap buttons AND no explanation, which is the exact silent dead-end ux4 exists to remove',
    ).not.toBe('none');

    document.body.removeChild(parent);
  });
});
