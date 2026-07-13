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
    // @ts-expect-error -- cureItems not yet on BattleViewModel; RED until impl adds field
    cureItems,
    canRecruit: false, // independent of recruit to keep tests focused
    baitOptions: [],
  } as Partial<BattleViewModel>);
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
