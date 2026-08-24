// @vitest-environment happy-dom
// ui/boxView.test.ts — ux4 (ADR-0155): box-vs-party explainer hint + the client-side
// repro of the roster that yields no swap option.
//
// SOURCE OF TRUTH: the reconciled ux4 plan (three lenses), sections B / PROOF-OF-TEETH.
//
// WHY THIS FILE EXISTS AT ALL
//   `src/ui/boxView.ts` is in `client/vite.config.ts:103` `coverage.exclude` (an exact
//   set guarded by `evals/dom-shell-coverage-exclusion.eval.mjs:40-41`) and there is no
//   TS mutation harness (cargo-mutants is Rust-only). So this shell is neither
//   coverage-measured nor mutation-measured: these cases are its ONLY automated defense,
//   and VACUITY is the primary risk. Every positive case therefore ships a control or a
//   named anchor.
//
// CONTRACT UNDER TEST (the implementer's side of the handoff)
//   ANCHORS IN THIS FILE ARE SYMBOLIC, NOT NUMERIC (reviewer W3 / simplify F1). Line numbers
//   in `boxView.ts` were cited against the pre-implementation tree and every one of them had
//   already drifted by the time the hint landed; the trap bit twice in one slice. Cite the
//   METHOD (`#renderParty`, `#renderBox`, `#renderCard`) or the LITERAL (`Party & Box`,
//   `To Party`) instead — those survive an implementer's next edit.
//   - the constructor creates ONE `<div data-testid="box-party-hint">` and appends it to
//     BoxView's own `#root` in a block BETWEEN the constructor's `header` block (the
//     `Party & Box` h2 + the `Heal Party` button) and its `partyLabel` (`Party` h3) block —
//     a direct `#root` child and a SIBLING of `header`, never WRAPPING it (see the e2e chain
//     note below), never inside `#partyEl`/`#boxEl`, and never appended to the
//     caller-supplied `parent`;
//   - `textContent` is set ONCE in the constructor to COPY B. NO toggle, NO predicate, NO
//     render coupling. The asymmetry vs the battle hint is deliberate: COPY A asserts a
//     CONDITIONAL fact that becomes false the moment the player fixes their party (so it
//     must be toggled and reset), while COPY B asserts a model INVARIANT — party monsters
//     battle, the box stores — which is true whenever this overlay is open. Static is
//     correct here and strictly safer: `#renderParty`/`#renderBox` only touch
//     `#partyEl`/`#boxEl` (each opens with a `replaceChildren()` on its own container), so a
//     direct `#root` child cannot be wiped.
//
// COPY B (the plan's final wording):
//   "Only monsters in your Party can battle or be swapped in. New recruits arrive in your
//    Box — each box monster has a \"To Party\" button that moves it into an open party slot."
//   Two measured constraints shape it:
//     (1) STATE-NEUTRAL phrasing. `#renderBox`'s empty-box branch short-circuits to
//         "No monsters in box." and RETURNS, so in the fresh-player state (one starter, empty
//         box) there is NO "To Party" button on screen at all (measured buttons:
//         Heal Party, Rename, To Box). An imperative "click To Party" would name a control
//         that does not exist in the single most likely state a confused new player reaches
//         — repeating the ux1 defect (ADR-0151: never advertise an action that cannot be
//         taken) one slice later. X6 is that pin.
//     (2) NO `HP <n>/<n>`-shaped substring and no `HP 0/`. Three e2e call sites HP-regex-scan
//         the box root's textContent: `client/e2e/recruit.spec.ts:326-340` (`healViaBox` uses
//         `!root.textContent.includes('HP 0/')` as its healed signal) and `:386-405`,
//         `:424-445` (`restoreHpBeforeEncounter` runs `matchAll(/HP (\d+)\/(\d+)/g)` and
//         requires every pair >= 80%). A hint with HP-shaped copy breaks all three as a
//         HELPER TIMEOUT, never as an assertion failure. X4 is that pin.
//
// THE e2e ROOT-RESOLUTION CHAIN (why "sibling, not wrapper" is load-bearing)
//   All three sites above resolve the box root as
//     h2[textContent === 'Party & Box'].parentElement.parentElement
//   i.e. title -> header -> #root. Wrapping `header` in a new div silently retargets that
//   chain to the wrapper. X4 pins it.
//
// `afterEach(() => document.body.replaceChildren())` IS REQUIRED, not hygiene theatre: a
// document-global `querySelectorAll('h2')` was measured resolving to a STALE overlay left
// behind by an earlier case (spuriously red, or — worse — vacuously green). Every query
// below is additionally scoped to the case's own `parent`.
//
// X2 is the executable repro of the roster that yields no swap option (the box/party render
// and the `-1`/`255` slot emission were already correct), plus a forward fence on the two
// sentinels. X3/X4/X5/X6 are permanent gating cases on the hint.
//
// WHAT THESE CASES CAN AND CANNOT PROVE (disclosure, deferral D2): happy-dom does no layout,
// so every assertion in this file proves "the element is PRESENT and is not display:none" —
// never that it is actually VISIBLE in a viewport. The real visibility proof is the parked
// real-Chromium `toBeInViewport()` spec (`client/e2e/swap-hint.spec.ts`, deferral D2). ux1
// (ADR-0151) shipped a badge for an overlay that rendered below the fold precisely because a
// happy-dom suite cannot see that. boxView's `#root` already carries `overflow-y:auto` in its
// own constructor cssText and its content is ~425px against a 720px viewport, so the ux1 defect
// is not expected to apply here — but this file is not what establishes that.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MonsterCardViewModel } from './boxModel';
import { BoxView, type BoxViewCallbacks } from './boxView';

// ---------------------------------------------------------------------------
// m23-s4 — overlay a11y wiring for BoxView (constructed-shell, #app-mounted) PLUS
// the cross-view four-distinct-roots pin (plan §8 A4/A9's X9). ADDITIVE ONLY:
// nothing below this block (the entire pre-existing ux4/EG4-8 suite) was weakened
// or deleted. Declared FIRST in the file, before any pre-existing describe.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M23-accessibility.spec.md §2.2/§2.3, §6
// (A11Y-13/14/15/16/17); memory/projects/monster-realm-m23-s4-plan.md §0 F1, §1
// D1/D2/D6/D7; memory/projects/gates/m23-s4.gates.md X1/X2/X3/X6/X7/X8/X9.
//
// RED REASON: boxView.ts's show()/hide()/toggle() do not call
// openOverlayA11y/closeOverlayA11y today, and its <h2> title carries neither
// data-testid="box-title" nor tabindex="-1" — every S4-boxView-* test and
// S4-CROSS-VIEW-DISTINCT-ROOTS fail now; every pre-existing test still passes.
//
// COMPOSITION NOTE (plan §8 A7): DEFER-FOCUS and CLOSE-RESTORE are folded into
// S4-boxView-ANCHOR-FOCUS and S4-boxView-CLOSE-RESTORE-UNGUARDED respectively — see
// battleView.test.ts's file header for the full rationale (repeated per-file so the
// absence of standalone tags reads as a decision here too).
// ---------------------------------------------------------------------------

import { beforeEach } from 'vitest';
import { t } from './a11yCopy';
import { BattleView, type BattleViewCallbacks } from './battleView';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';

vi.mock('./overlayA11y', { spy: true });

async function s4FlushMacrotask(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await s4FlushMacrotask();
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  await s4FlushMacrotask();
});

const S4_ID: OverlayId = 'boxView';
const S4_META = OVERLAY_A11Y[S4_ID];

function s4OutsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's4-outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

function s4InsideSentinel(root: HTMLElement): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's4-inside-sentinel';
  root.appendChild(btn);
  return btn;
}

/** See battleView.test.ts's file header for the full OPEN-LAST mechanism rationale
 *  (plan §8 A3): a post-hoc read of mock.calls[...][1].style.display is PROVABLY
 *  VACUOUS. This spies on the FIRST attribute write (`role`) and delegates to the
 *  real setAttribute. NEVER vi.importActual('./overlayA11y'). */
function s4CaptureDisplayAtOpen(root: HTMLElement): { display: () => string | undefined } {
  let captured: string | undefined;
  const real = root.setAttribute.bind(root);
  vi.spyOn(root, 'setAttribute').mockImplementation((name: string, value: string) => {
    if (name === 'role' && captured === undefined) captured = root.style.display;
    real(name, value);
  });
  return { display: () => captured };
}

describe('BoxView — m23-s4 overlay a11y wiring on the show()/hide()/toggle() edge', () => {
  it('S4-boxView-OPEN-ARIA BITES: the first show() from a hidden shell labels the root from OVERLAY_A11Y/t()', () => {
    const { parent, view } = mount();
    const root = e2eBoxRootOf(parent);
    expect(view.visible, 'the shell must start hidden, so show() IS an edge').toBe(false);

    view.show();

    expect(root.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(S4_META.role);
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(root.getAttribute('aria-label')).toBe(t(S4_META.labelKey));
  });

  it('S4-boxView-ANCHOR-FOCUS BITES: the anchor resolves to an <h2 tabindex="-1"> with byte-unchanged "Party & Box" text, and focus moves to it after ONE real macrotask (never synchronously)', async () => {
    const { parent, view } = mount();
    const root = e2eBoxRootOf(parent);
    view.show();

    const anchor = root.querySelector<HTMLElement>(S4_META.initialFocusSelector);
    expect(
      anchor,
      `the anchor selector ${S4_META.initialFocusSelector} must resolve`,
    ).not.toBeNull();
    expect(anchor!.tagName).toBe('H2');
    expect(
      anchor!.getAttribute('tabindex'),
      'must be "-1", never "0": a heading with no tabindex is not programmatically focusable, ' +
        'so the deferred querySelector(...)?.focus() silently no-ops; "0" would pass ' +
        '[A11Y-T5] while adding a permanent extra tab stop. See battleView.test.ts for the ' +
        'dataset.testId-vs-dataset.testid note',
    ).toBe('-1');
    expect(
      anchor!.textContent,
      'byte-unchanged — client/e2e/recruit.spec.ts resolves the box root off this exact text',
    ).toBe('Party & Box');

    expect(document.activeElement, 'not focused synchronously').not.toBe(anchor);
    await s4FlushMacrotask();
    expect(document.activeElement, 'focused by IDENTITY after one real macrotask').toBe(anchor);
  });

  it('S4-boxView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    const { parent, view } = mount();
    const root = e2eBoxRootOf(parent);

    view.show();
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(S4_ID, root);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S4_ID, null);
  });

  it('S4-boxView-CLOSE-RESTORE-UNGUARDED BITES: hide() strips all three attributes and restores focus to the pre-open element; hide() on a never-shown view still closes without throwing; show/hide/hide yields exactly two closes', async () => {
    const outside = s4OutsideSentinel();
    outside.focus();
    const { parent, view } = mount();
    const root = e2eBoxRootOf(parent);

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

    const fresh = mount();
    expect(fresh.view.visible).toBe(false);
    expect(() => fresh.view.hide()).not.toThrow();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S4_ID, null);

    vi.clearAllMocks();
    const cycle = mount();
    cycle.view.show();
    cycle.view.hide();
    cycle.view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
  });

  it('S4-boxView-REPEAT-NO-REOPEN BITES: show() on an already-visible overlay neither re-opens nor yanks focus off a sentinel parked inside the root', async () => {
    const { parent, view } = mount();
    const root = e2eBoxRootOf(parent);
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

  it('S4-boxView-OPEN-LAST BITES: openOverlayA11y is invoked with root.style.display ALREADY painted (neither "none" nor "") — never open-before-paint', () => {
    const { parent, view } = mount();
    const root = e2eBoxRootOf(parent);
    const capture = s4CaptureDisplayAtOpen(root);

    view.show();

    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(capture.display()).not.toBe('none');
    expect(capture.display()).not.toBe('');
  });

  it('S4-boxView-TOGGLE BITES: toggle() from hidden opens exactly once; toggle() again closes exactly once', () => {
    const { view } = mount();
    expect(view.visible).toBe(false);

    view.toggle();
    expect(view.visible).toBe(true);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);

    view.toggle();
    expect(view.visible).toBe(false);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('S4-CROSS-VIEW-DISTINCT-ROOTS BITES: opening BattleView on the SAME #app mount leaves BoxView\'s ARIA claim intact, both before AND after closing BattleView — S4 must NOT implement close-before-open (plan §0 F1: the overlayA11y.ts header\'s "share ONE root" claim is a misstatement of the code)', () => {
    const app = document.createElement('div');
    document.body.appendChild(app);

    const boxCallbacks = makeBoxCallbacks();
    const boxView = new BoxView(app, boxCallbacks);
    boxView.show();
    const boxRoot = e2eBoxRootOf(app);
    expect(boxRoot.getAttribute('role'), 'precondition: boxView is open').toBe(
      OVERLAY_A11Y.boxView.role,
    );
    expect(boxRoot.getAttribute('aria-modal')).toBe('true');
    expect(boxRoot.getAttribute('aria-label')).toBe(t(OVERLAY_A11Y.boxView.labelKey));

    const battleCallbacks: BattleViewCallbacks = {
      onAttack: vi.fn(),
      onFlee: vi.fn(),
      onSwap: vi.fn(),
      onRecruit: vi.fn(),
      onUseItem: vi.fn(),
      onPvpAttack: vi.fn(),
      onPvpSwap: vi.fn(),
    };
    const battleView = new BattleView(app, battleCallbacks);
    battleView.show();

    expect(
      boxRoot.getAttribute('role'),
      'boxView must STILL carry role after battleView opens on the same #app mount — four ' +
        'distinct roots, four distinct OverlayIds, four distinct OPEN_OVERLAYS records',
    ).toBe(OVERLAY_A11Y.boxView.role);
    expect(boxRoot.getAttribute('aria-modal')).toBe('true');
    expect(boxRoot.getAttribute('aria-label')).toBe(t(OVERLAY_A11Y.boxView.labelKey));

    battleView.hide();

    expect(
      boxRoot.getAttribute('role'),
      'closing battleView must leave boxView entirely intact — a close-before-open ' +
        'implementation would close an overlay the player still has open',
    ).toBe(OVERLAY_A11Y.boxView.role);
    expect(boxRoot.getAttribute('aria-modal')).toBe('true');
    expect(boxRoot.getAttribute('aria-label')).toBe(t(OVERLAY_A11Y.boxView.labelKey));

    document.body.removeChild(app);
  });
});

const BOX_PARTY_HINT_SELECTOR = '[data-testid="box-party-hint"]';

/** The box sentinel `#renderCard`'s "To Box" button emits. Pinned literally by X2. */
const BOX_SLOT = 255;
/**
 * The "next free slot, please" sentinel `#renderCard`'s "To Party" button emits.
 * `main.ts:1741-1749` resolves it via `nextFreePartySlot(...) ?? PARTY_SLOT_NONE`.
 * `nextFreePartySlot` itself is already covered (`boxModel.test.ts:199-232`); what is
 * ungated today — and what X2 pins — is boxView's EMISSION of the sentinel.
 */
const NEXT_FREE_SLOT_SENTINEL = -1;

/** All THREE BoxViewCallbacks keys as spies. */
function makeBoxCallbacks(): BoxViewCallbacks {
  return {
    onSetNickname: vi.fn(),
    onSetPartySlot: vi.fn(),
    onHealParty: vi.fn(),
  };
}

/**
 * Every MonsterCardViewModel field supplied explicitly — including EG4-8's new
 * `evolutionChoicePending`. Explicit, not spread-defaulted: the field is what X7–X10
 * below toggle, so a silent default would make every one of those cases vacuous.
 */
function makeCard(overrides: Partial<MonsterCardViewModel> = {}): MonsterCardViewModel {
  return {
    monsterId: 100n,
    speciesName: 'Sproutle',
    nickname: '',
    level: 5,
    currentHp: 18,
    statHp: 20,
    hpPercent: 90,
    partySlot: 0,
    evolutionChoicePending: false,
    ...overrides,
  };
}

/** The lone starter occupying party slot 0 (the fresh-player roster). */
function makePartyCard(): MonsterCardViewModel {
  return makeCard({ monsterId: 100n, speciesName: 'Sproutle', partySlot: 0 });
}

/**
 * A freshly recruited monster sitting in the BOX. This is the client-side face of the
 * reported defect: `attempt_recruit` inserts with `PARTY_SLOT_NONE` (taming.rs:163 — a
 * DECIDED semantic, ADR-0047 §3 "box (PARTY_SLOT_NONE), full HP … avoids clobbering an
 * occupied party slot"), and `lead_party` (battle.rs:283-294) builds side A only from
 * `party_slot != PARTY_SLOT_NONE` — so a box recruit can never appear on the battle bench.
 */
function makeBoxRecruitCard(): MonsterCardViewModel {
  return makeCard({
    monsterId: 200n,
    speciesName: 'Emberfang',
    partySlot: 255,
    currentHp: 21,
    statHp: 21,
    hpPercent: 100,
  });
}

/** Six party slots with only slot 0 filled — `buildPartyViewModel`'s real shape. */
function makePartySlots(): (MonsterCardViewModel | null)[] {
  return [makePartyCard(), null, null, null, null, null];
}

/**
 * Named anchors. The two grids are resolved via their own `h3` labels rather than by
 * child index, so inserting the hint between `header` and `partyLabel` cannot silently
 * retarget them (an index-based lookup would, and would then assert about the wrong node).
 */
function findByTag(parent: HTMLElement, tag: string, text: string): HTMLElement {
  const found = [...parent.querySelectorAll(tag)].find((el) => el.textContent === text);
  expect(found, `precondition: a <${tag}> with textContent "${text}" must exist`).toBeDefined();
  return found as HTMLElement;
}

/**
 * ANCHOR HARDENING (reviewer nit 8a). These resolve the grid as the label's
 * `nextElementSibling`, so a hint inserted between the `Party` h3 and `#partyEl` would make
 * this helper silently return THE HINT — and X2's `expect(partyGrid.textContent)
 * .not.toContain('Emberfang')` would then pass vacuously against the hint's own text. The
 * testid guard below rejects that: a misplaced hint fails here loudly instead.
 */
function assertNotTheHint(el: Element, label: string): void {
  expect(
    el.getAttribute('data-testid'),
    `precondition: the element resolved as ${label} must NOT be the box-party hint. If the hint ` +
      `is inserted between the label and its grid, this helper returns the HINT and every ` +
      `textContent assertion made through it becomes vacuous`,
  ).not.toBe('box-party-hint');
}

function partyGridOf(parent: HTMLElement): HTMLElement {
  const label = findByTag(parent, 'h3', 'Party');
  const grid = label.nextElementSibling;
  expect(
    grid,
    'precondition: the "Party" h3 must be immediately followed by #partyEl',
  ).not.toBeNull();
  assertNotTheHint(grid as Element, '#partyEl');
  return grid as HTMLElement;
}

function boxGridOf(parent: HTMLElement): HTMLElement {
  const label = findByTag(parent, 'h3', 'Box');
  const grid = label.nextElementSibling;
  expect(grid, 'precondition: the "Box" h3 must be immediately followed by #boxEl').not.toBeNull();
  assertNotTheHint(grid as Element, '#boxEl');
  return grid as HTMLElement;
}

/** The header row (the `Party & Box` h2's parent) — anchor for the insertion-point pins. */
function headerRowOf(parent: HTMLElement): HTMLElement {
  const title = findByTag(parent, 'h2', 'Party & Box');
  const header = title.parentElement;
  expect(
    header,
    'precondition: the "Party & Box" h2 must have a parent (the header row holding it and the ' +
      '"Heal Party" button)',
  ).not.toBeNull();
  return header as HTMLElement;
}

/** BoxView's `#root`, resolved exactly the way the e2e specs resolve it. */
function e2eBoxRootOf(parent: HTMLElement): HTMLElement {
  const title = findByTag(parent, 'h2', 'Party & Box');
  const header = title.parentElement;
  expect(
    header,
    'precondition: the "Party & Box" h2 must have a parent (the header row)',
  ).not.toBeNull();
  const root = header!.parentElement;
  expect(root, "precondition: the header row must have a parent (BoxView's #root)").not.toBeNull();
  return root as HTMLElement;
}

function mount(): { parent: HTMLElement; view: BoxView; callbacks: BoxViewCallbacks } {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const callbacks = makeBoxCallbacks();
  const view = new BoxView(parent, callbacks);
  return { parent, view, callbacks };
}

// REQUIRED — a document-global h2 lookup was measured resolving to a STALE overlay from
// an earlier case. This also prevents a leaked overlay from making a later case vacuous.
afterEach(() => {
  document.body.replaceChildren();
});

describe('BoxView ux4 X2: box vs party render + slot-sentinel emission (EXPECTED GREEN)', () => {
  it('BITES: a box recruit renders in the BOX grid and NOT in the party grid; "To Party" emits -1 and "To Box" emits 255', () => {
    // KILLS (1): swapped or constant slot arguments — e.g. "To Party" sending 255 (which
    //   would leave the monster in the box, the exact dead-end the player reported) or
    //   "To Box" sending -1 (which would silently RE-ADD it to the party).
    // KILLS (2): a dropped "To Party" control on box rows — with no such button the box
    //   becomes a one-way trap and there is genuinely no way to switch monsters.
    // KILLS (3): a SWAPPED-ARGUMENT / swapped-render-call mutant — `#renderParty(box)` +
    //   `#renderBox(party)`, or a `refresh()` that forwards its two arguments the wrong way
    //   round. The box monster would then appear under "Party", telling the player they have
    //   a swappable second monster when the server builds side A only from
    //   `party_slot != PARTY_SLOT_NONE`. (Deliberately NOT claimed: "a render that leaks box
    //   monsters into the party grid" — the two sets arrive as SEPARATE arguments, so no
    //   filtering happens in this shell at all; partitioning them is boxModel's job and is
    //   owned by boxModel.test.ts. Overclaiming that here would be a false teeth claim.)
    // THIS IS ALSO THE CLIENT-SIDE REPRO: "Emberfang" is present in the UI (in the Box)
    //   yet cannot appear on the battle bench, because side A is built only from
    //   `party_slot != PARTY_SLOT_NONE` (battle.rs:283-294). Nothing on the battle screen
    //   explains that today — which is what ux4-2's two hints exist to fix.
    // SCOPE (do not overclaim): this pins boxView's EMISSION of the sentinels only.
    //   `nextFreePartySlot`, which main.ts:1741-1749 uses to resolve -1, is covered by
    //   boxModel.test.ts:199-232; the party-full case where -1 resolves to
    //   PARTY_SLOT_NONE and the move silently no-ops is deferral D3.
    const { parent, view, callbacks } = mount();

    view.refresh(makePartySlots(), [makeBoxRecruitCard()]);
    view.show();

    const partyGrid = partyGridOf(parent);
    const boxGrid = boxGridOf(parent);

    expect(
      boxGrid.textContent,
      'ux4 (X2): the recruited monster must render in the BOX grid — that is where ' +
        'attempt_recruit puts it (PARTY_SLOT_NONE, taming.rs:163 / ADR-0047 §3)',
    ).toContain('Emberfang');
    expect(
      partyGrid.textContent,
      'ux4 (X2): the box recruit must NOT appear in the PARTY grid. A render that leaks it ' +
        'there would tell the player they have a swappable second monster when the server ' +
        'builds side A only from `party_slot != PARTY_SLOT_NONE` (battle.rs:283-294)',
    ).not.toContain('Emberfang');
    expect(
      partyGrid.textContent,
      'precondition (X2): the lone starter must render in the party grid — otherwise the ' +
        'not-contains assertion above would pass for the wrong reason (an empty grid)',
    ).toContain('Sproutle');

    // "To Party" on the BOX row.
    const toParty = [...boxGrid.querySelectorAll('button')].find(
      (b) => b.textContent === 'To Party',
    );
    expect(
      toParty,
      'ux4 (X2): every box row must carry a "To Party" button (`#renderCard`, the !inParty ' +
        'arm) — it is the ONLY path from box to party, and COPY B quotes this exact label',
    ).toBeDefined();
    toParty!.click();
    expect(
      callbacks.onSetPartySlot,
      'ux4 (X2): one click on "To Party" must dispatch exactly one intent',
    ).toHaveBeenCalledTimes(1);
    expect(
      callbacks.onSetPartySlot,
      'ux4 (X2): "To Party" must emit the box monster\'s id with the -1 "next free slot" ' +
        'sentinel that main.ts:1741-1749 resolves via nextFreePartySlot(...). Emitting 255 ' +
        'instead would leave the monster in the box — the reported dead-end, with a button ' +
        'that looks like it worked',
    ).toHaveBeenCalledWith(200n, NEXT_FREE_SLOT_SENTINEL);

    // "To Box" on the PARTY row.
    const toBox = [...partyGrid.querySelectorAll('button')].find((b) => b.textContent === 'To Box');
    expect(
      toBox,
      'ux4 (X2): every party row must carry a "To Box" button (`#renderCard`, the inParty arm)',
    ).toBeDefined();
    toBox!.click();
    expect(
      callbacks.onSetPartySlot,
      'ux4 (X2): the party row\'s "To Box" must emit the PARTY monster\'s id with 255 ' +
        '(PARTY_SLOT_NONE). A swapped pair of handlers reads identically in the DOM and is ' +
        'invisible to a presence-only check',
    ).toHaveBeenNthCalledWith(2, 100n, BOX_SLOT);
  });
});

describe('BoxView ux4 X3: box-party hint is present, visible, and quotes the real button label', () => {
  it('BITES: [data-testid="box-party-hint"] exists, is not display:none, and names Party, Box and the literal "To Party"', () => {
    // KILLS (1): no hint / a blank hint — the whole point of the slice is that the
    //   box-vs-party rule is currently stated nowhere in the UI.
    // KILLS (2): a VAGUE hint that never names the two screens ("manage your monsters
    //   here") — it would not tell the player which set can battle.
    // KILLS (3): a hint that DRIFTS from the control it points at (e.g. quoting
    //   "Add to Party" or "Move to Party" while `#renderCard` renders "To Party").
    //   Copy that names a button the player cannot find is the ux1 defect again.
    // DISCLOSED (plan §B): X3 has NO rejecting control available, because there is no
    //   state in which this hint should hide — COPY B states a model invariant, not a
    //   conditional fact. X3 is therefore presence-plus-content only, and X5 is a
    //   FORWARD FENCE for containment/idempotence rather than X3's non-vacuity partner.
    //   X6 is the closest thing to a control: it pins the copy staying TRUTHFUL in the
    //   state where the quoted button is not rendered.
    const { parent, view } = mount();

    view.refresh(makePartySlots(), [makeBoxRecruitCard()]);
    view.show();

    const hint = parent.querySelector(BOX_PARTY_HINT_SELECTOR) as HTMLElement | null;
    expect(
      hint,
      'ux4 (X3): a [data-testid="box-party-hint"] element must exist. This lookup is ' +
        'deliberately unconditional — absence must FAIL, never pass through an `if (el)` guard',
    ).not.toBeNull();
    expect(
      hint!.style.display,
      'ux4 (X3): the hint must be visible whenever the overlay is open — it is set once in the ' +
        'constructor and never toggled (COPY B is an invariant, not a conditional fact)',
    ).not.toBe('none');

    const text = hint!.textContent ?? '';

    // -----------------------------------------------------------------------
    // SUBSUMPTION FIX (red-team F4/F5). The first draft asserted only
    // `toContain('Party')` + `toContain('Box')` + `toContain('To Party')`. Both of the
    // first two are STRICTLY SUBSUMED by the third ('To Party' contains 'Party';
    // 'To Box' contains 'Box'), so the copy `'To Party To Box'` was measured PASSING
    // X3, and the RT-3 imperative `'Click the "To Party" button under each Box monster
    // now.'` was measured passing X3 + X4 + X5 + X6 together. The two subsumed
    // assertions are REPLACED — not merely supplemented — by the strictly stronger
    // clauses below, which imply both of them ("…your Party can battle…" contains
    // 'Party'; "…arrive in your Box…" contains 'Box'), so nothing is lost.
    // -----------------------------------------------------------------------
    expect(
      text,
      'ux4 (X3): the hint must state WHAT the party is FOR — the semantic content, not just the ' +
        'word "Party". `toContain(\'Party\')` is subsumed by the "To Party" pin below and was ' +
        'measured passing the copy "To Party To Box"',
    ).toMatch(/can battle/i);
    expect(
      text,
      'ux4 (X3): the hint must state the SWAP consequence — that only party monsters can be ' +
        'swapped in. This is the rule the playtest report ran into and it is stated nowhere in the ' +
        'UI today',
    ).toMatch(/swapped in/i);
    expect(
      text,
      'ux4 (X3): the invariant must read as ONE readable clause, not a token salad',
    ).toContain('Only monsters in your Party can battle or be swapped in.');
    expect(
      text,
      'ux4 (X3): the hint must say where new recruits actually GO (taming.rs:163 / ADR-0047 §3) — ' +
        'this is the fact whose absence produced the playtest report. The literal clause pin also ' +
        'replaces the subsumed toContain(\'Box\'), which the substring inside "To Box" satisfied',
    ).toContain('New recruits arrive in your Box');
    expect(
      text,
      'ux4 (X3): the hint must quote the LITERAL button label "To Party" (`#renderCard`\'s ' +
        '!inParty arm — the inParty arm renders "To Box"). Copy that names a differently-worded ' +
        'control sends the player hunting for a button that does not exist (ux1, ADR-0151)',
    ).toContain('To Party');
    // TESTER NOTE (judgement call, logged): asserted as a literal REGEX rather than
    // `toContain('each box monster has a "To Party" button')` so that either straight (")
    // or typographic (“ ”) quotes satisfy it. The codebase does use typographic punctuation
    // in UI copy (e.g. `#renderPvpStatus` sets 'Waiting for opponent’s action…'), so a
    // straight-quote-only `toContain` would red a substantively-correct implementation over a
    // glyph. The bite is unchanged: the full clause must be present, in order, naming the
    // label — the RT-3 imperative and the "To Party To Box" salad both still die here.
    // CORRECTED (review item 5): an earlier version of this note claimed the separate
    // `toContain('To Party')` pin above "still requires the straight-quoted label text to
    // appear somewhere". That was FALSE AS WRITTEN — every string satisfying the regex below
    // already contains a literal `To Party`, so the `toContain` adds nothing on top of it.
    // The `toContain` is kept anyway (not deleted): it is the assertion that survives if this
    // clause regex is ever relaxed, and it fails with a far clearer message.
    expect(
      text,
      'ux4 (X3): the affordance must be DESCRIBED (state-neutral), quoting the label — see X6 for ' +
        'why an imperative would be a lie in the empty-box state',
    ).toMatch(/each box monster has a ["“]To Party["”] button/);
    // STRENGTHENING (review item 3, red-team F6): pins COPY B's load-bearing HEDGE. The copy
    // `'…that always moves it into the party.'` survived every other clause here, yet the plan
    // names "an OPEN party slot" as the hedge against deferral D3: `#renderCard`'s "To Party"
    // emits the -1 sentinel, main.ts resolves it via `nextFreePartySlot(...) ?? PARTY_SLOT_NONE`,
    // and with a FULL party that resolves to 255 — the move silently no-ops. An unhedged
    // "always moves it into the party" is therefore a promise the client cannot keep.
    expect(
      text,
      'ux4 (X3) D3 HEDGE: the copy must qualify the destination as an "open party slot". With a ' +
        'full party the -1 sentinel resolves to PARTY_SLOT_NONE (255) and the move silently ' +
        'no-ops (deferral D3), so an unhedged "moves it into the party" is a false promise — the ' +
        'ux1 failure mode (ADR-0151) in its subtlest form: a true-sounding claim with a state in ' +
        'which it does not hold',
    ).toContain('open party slot');
    expect(
      text.length,
      `ux4 (X3) LENGTH CAP: the hint copy is ${text.length} chars. COPY B is ~170. The cap bounds ` +
        'ADDITIVE dishonesty — extra sentences are how a hint acquires claims nothing gates (the ' +
        'battle-side analogue, H1f, killed a 150-char copy that appended a false heal promise) — ' +
        "and keeps the hint inside the grids' 600px column",
    ).toBeLessThanOrEqual(200);
  });
});

describe('BoxView ux4 X4: e2e compatibility — sibling of header, no HP-shaped copy', () => {
  it('BITES: the e2e box-root chain still resolves to the hint\'s parent AND contains both grids, and the copy carries no "HP n/n"', () => {
    // KILLS (1): WRAPPING `header` in a new div. All three e2e sites resolve the box root
    //   as h2[textContent==='Party & Box'].parentElement.parentElement, so a wrapper
    //   retargets that chain to the wrapper.
    //   *** THE "contains both grids" CLAUSE IS THE LOAD-BEARING ONE. *** Under the
    //   header-wrapping mutant the parent-identity clause ALONE PASSES: the chain resolves
    //   to the wrapper, and the wrapper IS the hint's parent. Only the containment clauses
    //   see that the resolved node no longer holds `#partyEl`/`#boxEl` — which is precisely
    //   what `healViaBox` and `restoreHpBeforeEncounter` read HP text out of.
    // KILLS (2): HP-shaped copy. `recruit.spec.ts:326-340` uses
    //   `!root.textContent.includes('HP 0/')` as its HEALED signal, and :386-405 / :424-445
    //   run `matchAll(/HP (\d+)\/(\d+)/g)` requiring every pair >= 80%. Injecting e.g.
    //   "HP 0/20" into the hint makes healViaBox never see a healed party and
    //   restoreHpBeforeEncounter never see a restored one — surfacing as a HELPER TIMEOUT,
    //   not as an assertion failure, i.e. the most expensive possible failure mode.
    // NOTE: `new RegExp()` is banned (ReDoS lint) — both probes below are literal.
    const { parent, view } = mount();

    view.refresh(makePartySlots(), [makeBoxRecruitCard()]);
    view.show();

    const hint = parent.querySelector(BOX_PARTY_HINT_SELECTOR) as HTMLElement | null;
    expect(hint, 'ux4 (X4): the hint element must exist').not.toBeNull();

    const e2eRoot = e2eBoxRootOf(parent);
    const partyGrid = partyGridOf(parent);
    const boxGrid = boxGridOf(parent);

    const hintParentIsE2eRoot = e2eRoot === hint!.parentElement;
    const containsPartyGrid = e2eRoot.contains(partyGrid);
    const containsBoxGrid = e2eRoot.contains(boxGrid);
    const chainIntact = hintParentIsE2eRoot && containsPartyGrid && containsBoxGrid;
    expect(
      chainIntact,
      'ux4 (X4) ONE CONJUNCTION — ' +
        `hintParentIsE2eRoot=${String(hintParentIsE2eRoot)} ` +
        `containsPartyGrid=${String(containsPartyGrid)} ` +
        `containsBoxGrid=${String(containsBoxGrid)}. ` +
        'The hint must be a SIBLING of `header` inside #root, never a wrapper around it: ' +
        "client/e2e/recruit.spec.ts resolves the box root as h2['Party & Box']" +
        '.parentElement.parentElement at three sites. Under a header-wrapping mutant the ' +
        'parent-identity clause alone still passes (the chain resolves to the wrapper, which IS ' +
        "the hint's parent) — only the two containment clauses catch that the resolved node no " +
        'longer holds #partyEl / #boxEl, the grids those helpers read HP text out of',
    ).toBe(true);

    // -----------------------------------------------------------------------
    // MANDATED INSERTION POINT (reviewer #4). The clauses above accept the hint ANYWHERE
    // under #root; the red-team's control implementation drifted to #root's FIRST child —
    // above the "Party & Box" title — with the entire suite green. The plan requires the
    // hint BETWEEN the constructor's `header` block (the `Party & Box` h2 + `Heal Party`
    // button) and its `partyLabel` (`Party` h3), which these two assertions pin exactly:
    //   • `header` stays #root's first element  ⇒ the hint is not above the title;
    //   • the hint is immediately followed by the `Party` h3 ⇒ it is not below the grids
    //     and not between a label and its grid (which would also break the anchor
    //     helpers — see assertNotTheHint).
    // The `Party` h3 is resolved by textContent, never by index.
    // -----------------------------------------------------------------------
    const header = headerRowOf(parent);
    expect(
      header.previousElementSibling,
      'ux4 (X4) INSERTION POINT: the header row (h2 "Party & Box" + "Heal Party") must remain ' +
        "#root's FIRST element child. A hint inserted ABOVE the title passes every containment " +
        "clause in this case — the red-team's control impl drifted exactly there with the whole " +
        "suite green — while putting explanatory small print above the screen's own heading",
    ).toBeNull();
    expect(
      hint!.nextElementSibling,
      'ux4 (X4) INSERTION POINT: the hint must sit immediately BEFORE the "Party" h3 — i.e. ' +
        'between the header block and the party label, exactly where the plan puts it. Anywhere ' +
        'else either buries the rule below the grids the player is already confused by, or (if ' +
        'placed between a label and its grid) silently retargets the nextElementSibling anchors ' +
        'this file resolves the grids through',
    ).toBe(findByTag(parent, 'h3', 'Party'));

    const text = hint!.textContent ?? '';
    expect(
      text,
      'ux4 (X4): the hint copy must contain NO "HP <n>/<n>"-shaped substring. ' +
        'restoreHpBeforeEncounter (recruit.spec.ts:386-405, :424-445) matchAll()s that shape ' +
        'over the box root and requires EVERY pair >= 80%, so one HP-shaped clause in a static ' +
        'hint hangs the helper on every run',
    ).not.toMatch(/HP\s*\d+\s*\/\s*\d+/);
    expect(
      text,
      'ux4 (X4): the hint copy must not contain "HP 0/" — healViaBox (recruit.spec.ts:326-340) ' +
        "uses `!root.textContent.includes('HP 0/')` as its HEALED signal, so that substring in a " +
        'permanent hint means the party never reads as healed',
    ).not.toContain('HP 0/');
  });
});

describe('BoxView ux4 X5: containment + idempotence forward fence', () => {
  it('BITES: after 3 refreshes there is exactly ONE hint, still visible, parented to #root — not #partyEl, not #boxEl, not the caller parent', () => {
    // FORWARD FENCE for anti-patterns 2, 3 and 7:
    // KILLS (2): moving the hint inside `#boxEl` or `#partyEl`. Both are cleared by
    //   `replaceChildren()` on EVERY refresh (`#renderParty` / `#renderBox` each open with
    //   one), so the hint would vanish on the second render — invisible to a first-render
    //   presence check.
    // KILLS (3): appending the hint to the caller-supplied `parent` instead of `#root`.
    //   The identical mutant passed the ENTIRE suite during ux1, because every case queries
    //   `parent.querySelector`, which matches a direct child of `parent` just as happily as
    //   a descendant of `#root`. In production `parent` is `#app` (the PixiJS canvas
    //   container), so the hint becomes an unpositioned in-flow div after a viewport-tall
    //   canvas — below the fold, surviving `hide()`, re-lengthening the document (the
    //   ADR-0146 scroll mechanism).
    // KILLS (7): a per-render `appendChild` — N duplicate hints after N server batches.
    // ANCHORS ARE NAMED: `#root` via the "Party & Box" h2's header parent; the grids via
    // their own h3 labels. A wrong anchor makes every clause here silently vacuous.
    const { parent, view } = mount();

    view.refresh(makePartySlots(), [makeBoxRecruitCard()]);
    view.show();
    view.refresh(makePartySlots(), [makeBoxRecruitCard()]);
    view.refresh(makePartySlots(), []);

    const all = parent.querySelectorAll(BOX_PARTY_HINT_SELECTOR);
    expect(
      all,
      'ux4 (X5): the hint must be created ONCE in the constructor and never re-appended — a ' +
        'per-render appendChild yields N duplicate hints after N batch refreshes, which a ' +
        'presence-only assertion cannot see',
    ).toHaveLength(1);

    const hint = all[0] as HTMLElement;
    expect(
      hint.style.display,
      'ux4 (X5): the surviving hint must still be visible after repeated refreshes',
    ).not.toBe('none');

    const root = e2eBoxRootOf(parent);
    expect(
      root,
      'precondition (X5): #root must NOT be the caller-supplied parent, or every containment ' +
        'clause below degenerates and cannot bite',
    ).not.toBe(parent);
    expect(
      hint.parentElement,
      "ux4 (X5): the hint must be a direct child of BoxView's own #root",
    ).toBe(root);
    expect(
      hint.parentElement,
      'ux4 (X5): the hint must NOT live inside #partyEl — `#renderParty` opens by clearing that ' +
        'container with replaceChildren() on every refresh',
    ).not.toBe(partyGridOf(parent));
    expect(
      hint.parentElement,
      'ux4 (X5): the hint must NOT live inside #boxEl — `#renderBox` opens by clearing that ' +
        'container with replaceChildren() on every refresh, and its empty-box branch returns ' +
        'early after appending only "No monsters in box."',
    ).not.toBe(boxGridOf(parent));
    expect(
      hint.parentElement,
      'ux4 (X5): the hint must NOT be appended to the caller-supplied parent (production ' +
        '`#app`, the PixiJS container) — that mutant passed the entire suite during ux1',
    ).not.toBe(parent);
  });
});

describe('BoxView ux4 X6: the hint stays truthful in the fresh-player state (empty box)', () => {
  it('BITES: with an empty box the hint is still present and visible, while NO "To Party" button exists anywhere under parent', () => {
    // KILLS: a STATE-DEPENDENT imperative copy. `#renderBox`'s empty-box branch short-circuits
    //   to "No monsters in box." and RETURNS, so in the fresh-player state (one
    //   starter, empty box) the rendered buttons are exactly Heal Party / Rename / To Box —
    //   there is NO "To Party" control. A hint phrased as "click To Party to move a monster
    //   into your party" therefore names a control the player cannot see, in the single most
    //   likely state a confused new player reaches. That is precisely the ux1 defect
    //   (ADR-0151: a badge shipped for an overlay that did not render) and repeating it one
    //   slice later would be the worst available outcome.
    // The control half of this case is the second assertion: it PROVES the "To Party" button
    //   is genuinely absent here, so the descriptive phrasing requirement is not hypothetical.
    //   COPY B satisfies both by DESCRIBING the affordance ("each box monster has a
    //   \"To Party\" button …") rather than commanding a click on it.
    const { parent, view } = mount();

    view.refresh(makePartySlots(), []);
    view.show();

    const hint = parent.querySelector(BOX_PARTY_HINT_SELECTOR) as HTMLElement | null;
    expect(
      hint,
      'ux4 (X6): the hint must be present in the empty-box state too — it is static, with no ' +
        "predicate and no render coupling, so `#renderBox`'s empty-box early return must not be " +
        'able to suppress it',
    ).not.toBeNull();
    expect(
      hint!.style.display,
      'ux4 (X6): the hint must be VISIBLE in the fresh-player state — that is the state where a ' +
        'player who cannot find any way to switch monsters most needs the rule stated',
    ).not.toBe('none');

    const toPartyButtons = [...parent.querySelectorAll('button')].filter(
      (b) => b.textContent === 'To Party',
    );
    expect(
      toPartyButtons,
      'CONTROL (X6): with an empty box there must be NO "To Party" button anywhere ' +
        '(`#renderBox`\'s empty-box branch renders only "No monsters in box." and returns). This ' +
        'assertion is what makes the state-neutral phrasing requirement REAL, not stylistic: copy ' +
        'that commands the player to click "To Party" is, right here, advertising a control that ' +
        'does not exist',
    ).toHaveLength(0);
    expect(
      [...parent.querySelectorAll('button')].map((b) => b.textContent),
      'precondition (X6): the fresh-player state must still render its real controls, so the ' +
        'zero-length assertion above cannot pass because nothing rendered at all',
    ).toContain('To Box');

    // -----------------------------------------------------------------------
    // THE COPY HALF (red-team F5). Until now X6 asserted only about the DOM, so its own
    // docstring's claim — "the copy must be state-neutral" — was backed by NOTHING: the
    // RT-3 imperative `'Click the "To Party" button under each Box monster now.'` was
    // measured passing X3 + X4 + X5 + X6. The assertion below is the missing half, made
    // HERE because this is the state in which such copy is provably false: the control
    // assertion above has just established that no "To Party" button exists.
    // The regex requires an imperative verb within 40 non-sentence-ending characters of
    // the label, so it catches "Click the \"To Party\" button", "press To Party", "use the
    // To Party button" — while COPY B's descriptive form ("each box monster has a
    // \"To Party\" button that moves it…") has no such verb before the label and passes.
    //
    // STRENGTHENED (review item 3, red-team F6): the verb list was `click|press|tap|hit|use`,
    // which let the measured imperative `'Select "To Party" now.'` straight through — the same
    // lie in a different mood. Widened with select|choose|move|find|open. COPY B still passes:
    // the only listed verb it contains at all is "open", and that occurs in "an open party
    // slot" — AFTER the label, so no listed verb precedes `"To Party` within the 40-char window
    // (the nearest preceding words are "each box monster has a"). "moves" is not matched by
    // `\bmove\b` and is downstream of the label regardless. This is a strict superset of the
    // old alternation: nothing that used to die now survives.
    // -----------------------------------------------------------------------
    const text = hint!.textContent ?? '';
    expect(
      text,
      `ux4 (X6) STATE-NEUTRAL PHRASING: the copy was ${JSON.stringify(text)}. It must DESCRIBE ` +
        'the "To Party" affordance, never COMMAND a click on it. The control assertion above has ' +
        'just proved that in this state — one starter, empty box, the single most likely state a ' +
        'confused new player reaches — `#renderBox`\'s empty-box branch short-circuits to "No ' +
        'monsters in box." and returns, so the rendered buttons are exactly Heal Party / Rename / ' +
        'To Box and there is NO "To Party" control. An imperative copy therefore instructs the ' +
        "player to act on a button that is not on screen: ux1's defect (ADR-0151 — a badge " +
        'shipped for an overlay that did not render) repeated in the very next slice',
    ).not.toMatch(
      /\b(click|press|tap|hit|use|select|choose|move|find|open)\b[^.]{0,40}"?To Party/i,
    );
  });
});

// ===========================================================================
// EG4-8 — the evolution-choice badge (X7–X10)
//
// SOURCE OF TRUTH: memory/projects/monster-realm-EG4-contract.md §D + §G, and spec
// §2 EG4-8 ("the party roster view SHALL show a badge/indicator on any monster with 2+
// currently-eligible evolution paths").
//
// CONTRACT UNDER TEST — SYMBOLIC ANCHORS ONLY (same discipline as X2–X6 above):
//   • `#renderCard` renders ONE `<... data-testid="evo-choice-badge">` INSIDE the card it
//     is building, iff `card.evolutionChoicePending` is true — nothing else in this shell
//     may read the flag, and no badge may exist when it is false;
//   • the badge lives inside the monster card, so it is per-monster and is naturally
//     cleared by `#renderParty` / `#renderBox`'s `replaceChildren()` — it must NOT be a
//     direct `#root` child and must NOT wrap the `header` row;
//   • its text carries NO `HP `-shaped substring (the e2e HP-scan constraint, verified
//     probe fact §A of the contract / recruit.spec.ts:314,330-334,357-359,390-392,428-430).
//
// The whole eligibility decision is boxModel's (`evolutionChoicePending`, owned by
// boxModel.test.ts). These cases pin ONLY the shell's rendering of that boolean — the
// same scope discipline X2 states for the slot sentinels.
// ===========================================================================

const EVO_BADGE_SELECTOR = '[data-testid="evo-choice-badge"]';

/** A party-slot-0 roster whose lone starter carries the given badge flag. */
function partySlotsWithBadge(pending: boolean): (MonsterCardViewModel | null)[] {
  return [
    makeCard({
      monsterId: 100n,
      speciesName: 'Sproutle',
      partySlot: 0,
      evolutionChoicePending: pending,
    }),
    null,
    null,
    null,
    null,
    null,
  ];
}

/** Resolve the rendered card element (a grid child) that shows `name`. */
function cardElementFor(grid: HTMLElement, name: string): HTMLElement {
  const found = [...grid.children].find((c) => (c.textContent ?? '').includes(name));
  expect(
    found,
    `precondition (EG4-8): a rendered card containing "${name}" must exist in this grid — ` +
      'otherwise the containment assertions made through it are vacuous',
  ).toBeDefined();
  return found as HTMLElement;
}

describe('BoxView EG4-8 X7: the badge renders in the PARTY grid iff evolutionChoicePending', () => {
  it('BITES: pending=true renders exactly one badge in the party card; pending=false renders none anywhere', () => {
    // KILLS (1): a shell that never renders the badge at all — EG4-8's entire deliverable
    //   is the "active notification" on the roster, and `boxView.ts` is coverage-excluded
    //   (vite.config.ts:103) and has no TS mutation harness, so this case is its only
    //   automated defense.
    // KILLS (2): a badge rendered UNCONDITIONALLY (ignoring the flag). The false half is
    //   the control: a constant badge would tell every player that every monster has an
    //   ambiguous evolution waiting, which is the exact ux1 failure mode (ADR-0151 —
    //   advertising a state that does not hold).
    // KILLS (3): a badge appended to a container that `#renderParty`'s `replaceChildren()`
    //   does not clear — the second refresh below would then still show it.
    const { parent, view } = mount();

    view.refresh(partySlotsWithBadge(true), []);
    view.show();

    const partyGrid = partyGridOf(parent);
    expect(
      partyGrid.querySelectorAll(EVO_BADGE_SELECTOR),
      'EG4-8 (X7): a monster with 2+ eligible evolution paths must carry exactly ONE ' +
        '[data-testid="evo-choice-badge"] inside its party card',
    ).toHaveLength(1);

    const badge = partyGrid.querySelector(EVO_BADGE_SELECTOR) as HTMLElement;
    expect(
      badge.style.display,
      'EG4-8 (X7): the badge must be visible when it is rendered — a display:none badge is ' +
        'the ux1 defect in its purest form',
    ).not.toBe('none');
    expect(
      (badge.textContent ?? '').trim().length,
      'EG4-8 (X7): the badge must carry copy. An empty element satisfies a presence-only ' +
        'query while telling the player nothing',
    ).toBeGreaterThan(0);
    expect(
      badge.textContent ?? '',
      'EG4-8 (X7): the badge copy must name what is pending. EG4-8 calls it the ' +
        '"evolution-ready badge"; copy that never says "evolve"/"evolution" leaves the ' +
        'player with an unexplained marker',
    ).toMatch(/evolv/i);

    // CONTROL — the same roster with the flag cleared.
    view.refresh(partySlotsWithBadge(false), []);
    expect(
      parent.querySelectorAll(EVO_BADGE_SELECTOR),
      'EG4-8 (X7) CONTROL: with evolutionChoicePending=false there must be NO badge anywhere ' +
        'under the overlay. This is what makes the positive half non-vacuous, and it also ' +
        'kills a badge parked outside the per-render containers, which would survive here',
    ).toHaveLength(0);
  });
});

describe('BoxView EG4-8 X8: the badge is per-card and renders in the BOX grid too', () => {
  it('BITES: with one pending and one non-pending box monster, the badge sits inside the PENDING card only', () => {
    // KILLS (1): a badge stamped on every card in the list (a per-render flag instead of a
    //   per-card one) — the second card's absence assertion catches it.
    // KILLS (2): a badge attached to the WRONG card. A per-list `if (anyPending)` renderer
    //   would badge whichever card happened to be first, pointing the player at a monster
    //   with no choice to make.
    // KILLS (3): a party-only badge. Boxed monsters genuinely reach 2+ eligible (care /
    //   train / essence_train have no party check — contract A16), and `#renderCard` is
    //   shared, so the box arm must render it too.
    const { parent, view } = mount();

    view.refresh(makePartySlots(), [
      makeCard({
        monsterId: 200n,
        speciesName: 'Emberfang',
        partySlot: 255,
        currentHp: 21,
        statHp: 21,
        hpPercent: 100,
        evolutionChoicePending: true,
      }),
      makeCard({
        monsterId: 300n,
        speciesName: 'Mossling',
        partySlot: 255,
        currentHp: 19,
        statHp: 20,
        hpPercent: 95,
        evolutionChoicePending: false,
      }),
    ]);
    view.show();

    const boxGrid = boxGridOf(parent);
    expect(
      boxGrid.querySelectorAll(EVO_BADGE_SELECTOR),
      'EG4-8 (X8): exactly one of the two box monsters is pending, so exactly one badge ' +
        'must render in the box grid',
    ).toHaveLength(1);

    const badge = boxGrid.querySelector(EVO_BADGE_SELECTOR) as HTMLElement;
    const pendingCard = cardElementFor(boxGrid, 'Emberfang');
    const plainCard = cardElementFor(boxGrid, 'Mossling');
    expect(
      pendingCard.contains(badge),
      "EG4-8 (X8): the badge must render INSIDE the pending monster's own card. A badge " +
        'hoisted to the grid (or to #root) is not attributable to a monster, which is the ' +
        'whole point of a per-monster roster notification',
    ).toBe(true);
    expect(
      plainCard.contains(badge),
      "EG4-8 (X8): the non-pending monster's card must not contain the badge",
    ).toBe(false);
    expect(
      plainCard.querySelectorAll(EVO_BADGE_SELECTOR),
      'EG4-8 (X8): ...and must not contain a badge of its own',
    ).toHaveLength(0);
    expect(
      parent.querySelectorAll(EVO_BADGE_SELECTOR),
      'EG4-8 (X8): no stray badge may exist outside the box grid in this roster (the party ' +
        'starter is not pending)',
    ).toHaveLength(1);
  });

  it('BITES: two pending monsters render TWO badges (one each), stable across repeated refreshes', () => {
    // KILLS (1): a singleton badge created once and moved/reused — with two ambiguous
    //   monsters the player would only ever see one of them flagged.
    // KILLS (2): a per-render `appendChild` to a container that is NOT cleared: N refreshes
    //   would accumulate N badges per card. `#renderParty`/`#renderBox` each open with a
    //   `replaceChildren()`, so a badge built inside `#renderCard` is idempotent by
    //   construction — this pins that it actually is.
    const { parent, view } = mount();

    const boxCards = [
      makeCard({
        monsterId: 200n,
        speciesName: 'Emberfang',
        partySlot: 255,
        currentHp: 21,
        statHp: 21,
        hpPercent: 100,
        evolutionChoicePending: true,
      }),
      makeCard({
        monsterId: 300n,
        speciesName: 'Mossling',
        partySlot: 255,
        currentHp: 19,
        statHp: 20,
        hpPercent: 95,
        evolutionChoicePending: true,
      }),
    ];

    view.refresh(partySlotsWithBadge(true), boxCards);
    view.show();
    view.refresh(partySlotsWithBadge(true), boxCards);
    view.refresh(partySlotsWithBadge(true), boxCards);

    expect(
      boxGridOf(parent).querySelectorAll(EVO_BADGE_SELECTOR),
      'EG4-8 (X8): two pending box monsters, three refreshes — exactly two badges',
    ).toHaveLength(2);
    expect(
      partyGridOf(parent).querySelectorAll(EVO_BADGE_SELECTOR),
      'EG4-8 (X8): one pending party monster, three refreshes — exactly one badge',
    ).toHaveLength(1);
    expect(
      parent.querySelectorAll(EVO_BADGE_SELECTOR),
      'EG4-8 (X8): three badges total, no duplicates accumulated across refreshes',
    ).toHaveLength(3);
  });
});

describe('BoxView EG4-8 X9: e2e compatibility — inside the card, no header wrapper, no HP-shaped copy', () => {
  it("BITES: the badge does not wrap the header, is not a direct #root child, and the box root's HP scan still reads clean", () => {
    // KILLS (1): a badge (or a badge wrapper) placed around `header`. All five
    //   `client/e2e/recruit.spec.ts` sites resolve the box root as
    //   h2['Party & Box'].parentElement.parentElement — a wrapper silently retargets that
    //   chain and `healViaBox` / `restoreHpBeforeEncounter` then read HP text out of the
    //   wrong node. As in X4, the CONTAINMENT clauses are the load-bearing ones: under the
    //   wrapping mutant an identity-only check still passes.
    // KILLS (2): HP-shaped badge copy. `healViaBox` (recruit.spec.ts:326-340) uses
    //   `!root.textContent.includes('HP 0/')` as its HEALED signal and
    //   `restoreHpBeforeEncounter` (:386-405, :424-445) `matchAll`s /HP (\d+)\/(\d+)/g over
    //   the same root requiring EVERY pair >= 80%. A badge reading e.g. "Evolution HP 0/2"
    //   hangs all three helpers as a TIMEOUT, never as an assertion failure — the most
    //   expensive possible failure mode.
    // NOTE: `new RegExp()` is banned (ReDoS lint) — both probes below are literal.
    const { parent, view } = mount();

    view.refresh(partySlotsWithBadge(true), [
      makeCard({
        monsterId: 200n,
        speciesName: 'Emberfang',
        partySlot: 255,
        currentHp: 21,
        statHp: 21,
        hpPercent: 100,
        evolutionChoicePending: true,
      }),
    ]);
    view.show();

    const badge = parent.querySelector(EVO_BADGE_SELECTOR) as HTMLElement | null;
    expect(badge, 'precondition (X9): a badge must exist for a pending monster').not.toBeNull();

    const e2eRoot = e2eBoxRootOf(parent);
    const header = headerRowOf(parent);
    const partyGrid = partyGridOf(parent);
    const boxGrid = boxGridOf(parent);

    expect(
      header.previousElementSibling,
      "EG4-8 (X9): the header row must remain #root's FIRST element child — a badge (or a " +
        'badge wrapper) inserted above the title both breaks the e2e chain and puts a ' +
        "notification above the screen's own heading",
    ).toBeNull();
    expect(
      badge!.contains(header),
      'EG4-8 (X9): the badge must never WRAP the header row — recruit.spec.ts resolves the ' +
        "box root as h2['Party & Box'].parentElement.parentElement at five sites",
    ).toBe(false);
    expect(
      header.querySelectorAll(EVO_BADGE_SELECTOR),
      'EG4-8 (X9): no badge may render inside the header row either — the badge is ' +
        'per-monster, and the header belongs to the screen',
    ).toHaveLength(0);
    expect(
      badge!.parentElement,
      'EG4-8 (X9): the badge must NOT be a direct child of #root. A #root-level badge is not ' +
        "attributable to a monster and survives `#renderCard`'s per-refresh rebuild",
    ).not.toBe(e2eRoot);
    expect(
      e2eRoot.contains(partyGrid) && e2eRoot.contains(boxGrid),
      'EG4-8 (X9): the resolved e2e box root must still contain BOTH grids — this is the ' +
        'clause that catches a header-wrapping mutant, which an identity check alone misses',
    ).toBe(true);

    const badgeText = badge!.textContent ?? '';
    expect(
      badgeText,
      'EG4-8 (X9): the badge copy must contain NO "HP <n>/<n>"-shaped substring — ' +
        'restoreHpBeforeEncounter matchAll()s that shape over the box root and requires ' +
        'every pair >= 80%',
    ).not.toMatch(/HP\s*\d+\s*\/\s*\d+/);
    expect(
      badgeText,
      'EG4-8 (X9): the badge copy must not contain "HP 0/" — healViaBox uses ' +
        "`!root.textContent.includes('HP 0/')` as its HEALED signal",
    ).not.toContain('HP 0/');
    expect(
      badgeText,
      'EG4-8 (X9): the badge copy must not contain the bare token "HP " at all — the safest ' +
        'form of the two constraints above, and the one an implementer can honour by ' +
        'inspection',
    ).not.toContain('HP ');

    // The e2e helpers' own reads, executed here against the real rendered root.
    const rootText = e2eBoxRootOf(parent).textContent ?? '';
    expect(
      rootText,
      "EG4-8 (X9): with a full-HP roster the box root must not read as fainted — healViaBox's " +
        'healed signal is the ABSENCE of this substring',
    ).not.toContain('HP 0/');
    const pairs = [...rootText.matchAll(/HP (\d+)\/(\d+)/g)];
    expect(
      pairs.length,
      'precondition (X9): the HP scan must find one pair per rendered card (1 party + 1 box) ' +
        '— a zero-length result would make the ratio loop below vacuous, and would itself ' +
        'mean restoreHpBeforeEncounter can no longer see the roster at all',
    ).toBe(2);
    for (const [, current, max] of pairs) {
      expect(
        Number(current) / Number(max),
        `EG4-8 (X9): restoreHpBeforeEncounter requires every HP pair in the box root to be ` +
          `>= 80%; it read ${current}/${max}. A badge that injects an HP-shaped pair (e.g. ` +
          '"2/5 paths") drops below that and hangs the helper on every e2e run',
      ).toBeGreaterThanOrEqual(0.8);
    }
  });
});

describe("BoxView EG4-8 X10: the badge does not displace the card's existing content", () => {
  it('BITES: a badged card still renders its name, its HP line, and its slot-swap button', () => {
    // KILLS: a `#renderCard` rewrite that returns EARLY on the pending branch (or replaces
    //   the card body with the badge). The player would lose the Rename / To Box / To Party
    //   controls on exactly the monsters that need an action taken — a strictly worse
    //   dead-end than the one X2 repros.
    const { parent, view, callbacks } = mount();

    view.refresh(partySlotsWithBadge(true), [
      makeCard({
        monsterId: 200n,
        speciesName: 'Emberfang',
        partySlot: 255,
        currentHp: 21,
        statHp: 21,
        hpPercent: 100,
        evolutionChoicePending: true,
      }),
    ]);
    view.show();

    const boxGrid = boxGridOf(parent);
    const partyGrid = partyGridOf(parent);
    expect(boxGrid.textContent, 'EG4-8 (X10): the badged box card still names its monster') //
      .toContain('Emberfang');
    expect(boxGrid.textContent, 'EG4-8 (X10): ...and still renders its HP line') //
      .toContain('HP 21/21');
    expect(partyGrid.textContent, 'EG4-8 (X10): the badged party card still names its monster') //
      .toContain('Sproutle');

    const toParty = [...boxGrid.querySelectorAll('button')].find(
      (b) => b.textContent === 'To Party',
    );
    expect(
      toParty,
      'EG4-8 (X10): a badged box card must keep its "To Party" control — the badge is a ' +
        'notification, never a replacement for the row',
    ).toBeDefined();
    toParty!.click();
    expect(
      callbacks.onSetPartySlot,
      'EG4-8 (X10): the surviving control must still emit the same intent it does without ' +
        'the badge (id + the -1 next-free-slot sentinel)',
    ).toHaveBeenCalledWith(200n, NEXT_FREE_SLOT_SENTINEL);
  });
});
