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

import { describe, expect, it, vi } from 'vitest';
import type { BattleViewModel } from './battleModel';
import { BattleView, type BattleViewCallbacks } from './battleView';

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
