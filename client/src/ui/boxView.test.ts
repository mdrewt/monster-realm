// @vitest-environment happy-dom
// ui/boxView.test.ts — ux4: box-vs-party explainer hint + the client-side
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
// shipped a badge for an overlay that rendered below the fold precisely because a
// happy-dom suite cannot see that. boxView's `#root` already carries `overflow-y:auto` in its
// own constructor cssText and its content is ~425px against a 720px viewport, so the ux1 defect
// is not expected to apply here — but this file is not what establishes that.

// ---------------------------------------------------------------------------
// ctl-8b (CTL8B.1-.4): the box frame becomes the Monsters frame (tabs, a cursor, an action sheet, an
// in-frame typing row, a Move feedback line), painted by `BoxView.paint(MonstersPaint)`; the
// per-card Rename button and its window.prompt are DELETED. The ctl-8b cases are the describes
// titled 'BoxView ctl-8b ...' at the end of this file (CTL8B-*). NAMED INTENTIONAL CHANGES to
// pre-existing cases:
//   - m24s4 BX-01 ("every migrated sink ..."): the `box.card.rename` t() expectation and the whole
//     "Rename prompt" block (a click on the Rename button reaching a stubbed prompt()) are removed;
//     in their place the party card's buttons are pinned to exactly ['To Box'] (no Rename button).
//     The title lost its "prompt() receives the resolved copy" clause.
//   - m24s4 BX-02 ("under «key» sentinels ..."): the `«box.card.rename»` expectation and the
//     sentinel-wrapped prompt() block are removed (the typing row's sentinel label is pinned by the
//     CTL8B i18n case instead); the title lost its prompt() clause.
//   - M24S4_BX_PLAIN_KEYS (the id roster): -`box.card.rename`, +`box.tab.party`, `box.tab.storage`,
//     `box.sheet.summary`, `box.sheet.nickname`, `box.sheet.move`, `box.feedback.movedToParty`,
//     `box.feedback.movedToBox`. M24S4_BX_ROSTER (English words that must not appear outside a
//     sentinel) gains 'Storage', 'Summary', 'Nickname', 'Moved to party', 'Moved to storage'.
// Every other pre-existing case is unchanged.
//
// ctl-8c (CTL8C.1): the sheet gains Care, Feed… and Evolve… (design §5 order), the frame gains a
// food list, an Evolve list and its Yes / No confirm, and the "Fed {name}" line. The cases are the
// describes titled 'BoxView ctl-8c ...' at the end of this file (CTL8C-1-VIEW-*). NAMED INTENTIONAL
// CHANGES to pre-existing cases:
//   - C8B_OPENING gains `feed: null, evolve: null, confirm: null`; every sheet paint is built by
//     `c8bSheet` (Feed… and Evolve… enabled unless a case says otherwise); the Move feedback
//     fixtures are `{ kind }`.
//   - CTL8B-2-VIEW-SHEET pins the six-row roster and order.
//   - M24S4_BX_PLAIN_KEYS gains `box.sheet.{care,feed,evolve,feedNone}` and the reused
//     `evolution.card.noPaths`, `evolution.path.allMet`, `prompt.yes`, `prompt.no`;
//     M24S4_BX_PARAM_KEYS gains `box.feed.item`, `box.evolve.confirm`, `box.feedback.fed` and the
//     reused `evolution.path.heading`, `evolution.card.ready`; M24S4_BX_ROSTER gains the new
//     English; the ctl-8b «key» case also expects the three new sheet rows.
// ---------------------------------------------------------------------------
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWasmU32Constant } from '../../test-util/wasmPkg';
import type { MonsterCardViewModel } from './boxModel';
import { BoxView, type BoxViewCallbacks } from './boxView';
import type { EvolutionMonsterViewModel, EvolutionPathViewModel } from './evolutionModel';
import type { FoodVm, SheetAction } from './monstersModel';
import type { MonstersPaint, NicknameCommit } from './screens/monstersScreen';

// ---------------------------------------------------------------------------
// Overlay a11y wiring for BoxView (constructed-shell, #app-mounted) PLUS
// the cross-view four-distinct-roots pin (plan §8 A4/A9's X9).
// Declared FIRST in the file, before any pre-existing describe.
//
// COMPOSITION NOTE (plan §8 A7): DEFER-FOCUS and CLOSE-RESTORE are folded into
// S4-boxView-ANCHOR-FOCUS and S4-boxView-CLOSE-RESTORE-UNGUARDED respectively — see
// battleView.test.ts's file header for the full rationale (repeated per-file so the
// absence of standalone tags reads as a decision here too).
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach } from 'vitest';
import { stripComments } from '../../test-util/stripComments';
import { t } from './a11yCopy';
import { BattleView } from './battleView';
import { EvolutionView } from './evolutionView';
import { scanSource } from './i18n/hardcodedStrings';
import { t as i18nT, tf as i18nTf } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';
import { RaisingView } from './raisingView';

vi.mock('./overlayA11y', { spy: true });
// m24s4 MECHANISM oracle, same shape as m24s3: records every t()/tf() call AND
// calls through to the real resolver, so BX-01's DOM byte-identity assertions still work.
vi.mock('./i18n/resolver', { spy: true });

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
    const root = s4BoxRootOf(parent);
    expect(view.visible, 'the shell must start hidden, so show() IS an edge').toBe(false);

    view.show();

    expect(root.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(S4_META.role);
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(root.getAttribute('aria-label')).toBe(t(S4_META.labelKey));
  });

  it('S4-boxView-ANCHOR-FOCUS BITES: the anchor resolves to an <h2 tabindex="-1"> with byte-unchanged "Party & Box" text, and focus moves to it after ONE real macrotask (never synchronously)', async () => {
    const { parent, view } = mount();
    const root = s4BoxRootOf(parent);
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
    const root = s4BoxRootOf(parent);

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
    const root = s4BoxRootOf(parent);

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
    const root = s4BoxRootOf(parent);
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
    const root = s4BoxRootOf(parent);
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

  // The four `#app`-mounted views each own a root under the shared mount, so
  // opening or closing one never touches another: no close-before-open.
  const APP_VIEWS: readonly {
    id: OverlayId;
    make: (app: HTMLElement) => { show(): void; hide(): void };
  }[] = [
    { id: 'boxView', make: (app) => new BoxView(app, makeBoxCallbacks()) },
    {
      id: 'battleView',
      make: (app) =>
        new BattleView(app, {
          onAttack: vi.fn(),
          onFlee: vi.fn(),
          onSwap: vi.fn(),
          onRecruit: vi.fn(),
          onUseItem: vi.fn(),
          onPvpAttack: vi.fn(),
          onPvpSwap: vi.fn(),
        }),
    },
    {
      id: 'raisingView',
      make: (app) => new RaisingView(app, { onTrain: vi.fn(), onCare: vi.fn() }),
    },
    { id: 'evolutionView', make: (app) => new EvolutionView(app, { onEvolve: vi.fn() }) },
  ];
  const ORDERED_PAIRS = APP_VIEWS.flatMap((a) =>
    APP_VIEWS.filter((b) => b !== a).map((b) => [a, b] as const),
  );

  it.each(ORDERED_PAIRS.map(([a, b]) => [a.id, b.id, a, b] as const))(
    'S4-CROSS-VIEW-DISTINCT-ROOTS BITES: %s stays open while %s opens and closes on the same #app mount',
    (_aId, _bId, a, b) => {
      const app = document.createElement('div');
      document.body.appendChild(app);
      const viewA = a.make(app);
      const rootA = app.lastElementChild as HTMLElement;
      const viewB = b.make(app);
      expect(app.lastElementChild, 'each view mounts its OWN root').not.toBe(rootA);

      const expectAOpen = (when: string): void => {
        expect(rootA.getAttribute('role'), `${a.id} role ${when}`).toBe(OVERLAY_A11Y[a.id].role);
        expect(rootA.getAttribute('aria-modal'), `${a.id} aria-modal ${when}`).toBe('true');
        expect(rootA.getAttribute('aria-label'), `${a.id} aria-label ${when}`).toBe(
          t(OVERLAY_A11Y[a.id].labelKey),
        );
      };

      viewA.show();
      expectAOpen('after it opens');
      viewB.show();
      expectAOpen(`after ${b.id} opens`);
      viewB.hide();
      expectAOpen(`after ${b.id} closes`);

      viewA.hide();
      document.body.removeChild(app);
    },
  );
});

const BOX_PARTY_HINT_SELECTOR = '[data-testid="box-party-hint"]';

/** The box sentinel injected as `partySlotNone` (main.ts passes the wasm `party_slot_none()`,
 *  pinned === 255 by X2b) and emitted by `#renderCard`'s "To Box" button. */
const BOX_SLOT = 255;
/**
 * The "next free slot, please" sentinel `#renderCard`'s "To Party" button emits.
 * `main.ts:1741-1749` resolves it via `nextFreePartySlot(...) ?? PARTY_SLOT_NONE`.
 * `nextFreePartySlot` itself is already covered (`boxModel.test.ts:199-232`); what is
 * ungated today — and what X2 pins — is boxView's EMISSION of the sentinel.
 */
const NEXT_FREE_SLOT_SENTINEL = -1;

/** All three BoxViewCallbacks callbacks as spies, plus the injected box sentinel. */
function makeBoxCallbacks(): BoxViewCallbacks {
  return {
    onSetNickname: vi.fn(),
    onSetPartySlot: vi.fn(),
    onHealParty: vi.fn(),
    partySlotNone: BOX_SLOT,
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
 * occupied party slot"), and `lead_party` builds side A only from
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
 * ANCHOR HARDENING. These resolve the grid as the label's
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

/**
 * BoxView's `#root`, resolved STRUCTURALLY (`parent.firstElementChild`) rather than by the
 * title's TEXT (`e2eBoxRootOf`). Six m23-s4 call sites resolve the root BEFORE the first
 * `show()`; once `box.title` moves into `show()`, the `<h2>` carries no
 * text yet at those sites and `e2eBoxRootOf`'s `findByTag` precondition throws. Every POST-show
 * site keeps `e2eBoxRootOf` — the text anchor is the stronger oracle once the title has
 * actually resolved.
 */
function s4BoxRootOf(parent: HTMLElement): HTMLElement {
  const root = parent.firstElementChild;
  if (root === null) {
    throw new Error('m24s4 s4BoxRootOf: BoxView did not append an overlay root into parent');
  }
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
    //   `party_slot != PARTY_SLOT_NONE`. Nothing on the battle screen
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

describe('BoxView X2b: the box sentinel is game-core PARTY_SLOT_NONE, injected (value identity)', () => {
  it('★ BITES: the BUILT wasm party_slot_none() === 255 === BOX_SLOT — the retired BOX_SLOT literal', () => {
    // Value-identity proof: boxView.ts no longer owns a `BOX_SLOT = 255` literal — main.ts
    // injects `party_slot_none()` as `partySlotNone`. Read from the compiled client-wasm binary.
    expect(readWasmU32Constant('party_slot_none')).toBe(255);
    expect(BOX_SLOT).toBe(255);
  });

  it('BITES: "To Box" emits the INJECTED sentinel — kills a view that re-inlines 255', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const callbacks = { ...makeBoxCallbacks(), partySlotNone: 77 };
    const view = new BoxView(parent, callbacks);
    view.refresh(makePartySlots(), []);
    view.show();
    const toBox = [...partyGridOf(parent).querySelectorAll('button')].find(
      (b) => b.textContent === 'To Box',
    );
    expect(toBox, 'precondition: the party row carries a "To Box" button').toBeDefined();
    toBox!.click();
    expect(callbacks.onSetPartySlot).toHaveBeenCalledWith(100n, 77);
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
    // asserted as a literal REGEX rather than `toContain('each box monster has a "To Party"
    // button')` so that either straight (") or typographic (“ ”) quotes satisfy it. The
    // codebase does use typographic punctuation in UI copy (e.g. `#renderPvpStatus` sets
    // 'Waiting for opponent’s action…'), so a straight-quote-only `toContain` would red a
    // substantively-correct implementation over a glyph. The bite is unchanged: the full
    // clause must be present, in order, naming the label — the RT-3 imperative and the "To
    // Party To Box" salad both still die here.
    // The `toContain` is kept anyway (not deleted): it is the assertion that survives if this
    // clause regex is ever relaxed, and it fails with a far clearer message.
    expect(
      text,
      'ux4 (X3): the affordance must be DESCRIBED (state-neutral), quoting the label — see X6 for ' +
        'why an imperative would be a lie in the empty-box state',
    ).toMatch(/each box monster has a ["“]To Party["”] button/);
    // pins COPY B's load-bearing HEDGE. The copy `'…that always moves it into the party.'`
    // survived every other clause here, yet the plan names "an OPEN party slot" as the hedge
    // against deferral D3: `#renderCard`'s "To Party" emits the -1 sentinel, main.ts resolves it
    // via `nextFreePartySlot(...) ?? PARTY_SLOT_NONE`, and with a FULL party that resolves to 255
    // — the move silently no-ops. An unhedged "always moves it into the party" is therefore a
    // promise the client cannot keep.
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
    // MANDATED INSERTION POINT. The clauses above accept the hint ANYWHERE
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
    // THE COPY HALF. Until now X6 asserted only about the DOM, so its own
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
    // the verb list was `click|press|tap|hit|use`, which let the measured imperative `'Select
    // "To Party" now.'` straight through — the same lie in a different mood. Widened with
    // select|choose|move|find|open. COPY B still passes:
    // the only listed verb it contains at all is "open", and that occurs in "an open party
    // slot" — AFTER the label, so no listed verb precedes `"To Party` within the 40-char window
    // (the nearest preceding words are "each box monster has a"). "moves" is not matched by
    // `\bmove\b` and is downstream of the label regardless.
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
// The evolution-choice badge (X7–X10)
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
    //   and has no TS mutation harness, so this case is its only
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
    // KILLS (2): HP-shaped badge copy. `healViaBox` uses
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

// =============================================================================
// i18n migration batch B: boxView.ts routes its migrated
// sinks through t()/tf() (ADR-0256/0257/0259/0260 resolver) instead of raw
// English literals, and its hoisted `prompt('New nickname:', ...)` argument
// through `t('box.rename.prompt')`.
//
// =============================================================================

const M24S4_BX_PLAIN_KEYS = new Set([
  'box.title',
  'box.heal',
  'box.hint',
  'box.section.party',
  'box.section.box',
  'box.box.empty',
  // INTENTIONAL CHANGE (ctl-8b): `box.card.rename` leaves this roster (the per-card Rename button
  // and window.prompt are deleted); seven keys join it (the tabs, the action sheet's rows and the
  // two Move feedback lines). `box.rename.prompt` stays: it is the typing row's label now.
  'box.card.evolveBadge',
  'box.card.toBox',
  'box.card.toParty',
  'box.rename.prompt',
  'box.tab.party',
  'box.tab.storage',
  'box.sheet.summary',
  'box.sheet.nickname',
  'box.sheet.move',
  'box.feedback.movedToParty',
  'box.feedback.movedToBox',
  // INTENTIONAL CHANGE (ctl-8c): the Care / Feed… / Evolve… rows and the no-food reason, plus the
  // evolution and prompt ids the Evolve list and its confirm reuse.
  'box.sheet.care',
  'box.sheet.feed',
  'box.sheet.evolve',
  'box.sheet.feedNone',
  'evolution.card.noPaths',
  'evolution.path.allMet',
  'prompt.yes',
  'prompt.no',
]);

// INTENTIONAL CHANGE (ctl-8c): the food row, the Evolve confirm, the fed line, and the reused path
// heading and ready line.
const M24S4_BX_PARAM_KEYS = new Set([
  'box.party.emptySlot',
  'box.card.stats',
  'box.feed.item',
  'box.evolve.confirm',
  'box.feedback.fed',
  'evolution.path.heading',
  'evolution.card.ready',
]);

/** True iff `content` (the text strictly between one `«`/`»` pair) is EXACTLY an
 *  expected sentinel: a bare roster key, or `key|<json>` where `key` is a roster
 *  PARAM key and the tail after the FIRST `|` parses to a plain (non-array,
 *  non-null) object. */
function m24s4BxIsExpectedSentinelSpan(content: string): boolean {
  const bar = content.indexOf('|');
  if (bar === -1) {
    return M24S4_BX_PLAIN_KEYS.has(content) || M24S4_BX_PARAM_KEYS.has(content);
  }
  const key = content.slice(0, bar);
  if (!M24S4_BX_PARAM_KEYS.has(key)) return false;
  const tail = content.slice(bar + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(tail);
  } catch {
    return false;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
}

/** Elides only the bracket spans that are EXACTLY an expected sentinel (manual
 *  indexOf loop — no RegExp) and reports every OTHER `«...»` span
 *  verbatim in `unexpectedSpans`, un-elided, so it stays in `stripped` for the
 *  roster-word scan too — see battleView.test.ts's m24s3SplitSentinels header. */
function m24s4BxSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
  let out = '';
  const unexpectedSpans: string[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('«', i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const close = text.indexOf('»', open + 1);
    if (close === -1) {
      // Unterminated bracket: never a legitimate sentinel — leave it in place.
      out += text.slice(open);
      break;
    }
    const span = text.slice(open, close + 1);
    const content = text.slice(open + 1, close);
    if (m24s4BxIsExpectedSentinelSpan(content)) {
      // Elide — this is a real, correctly-formed sentinel.
    } else {
      out += span;
      unexpectedSpans.push(span);
    }
    i = close + 1;
  }
  return { stripped: out, unexpectedSpans };
}

/** Whole-subtree walk (plan R5): every descendant's own text-node children, every
 *  element's `title` attribute, and every `<option>`'s text — never a per-element
 *  spot check. */
function m24s4BxWalkSubtree(root: HTMLElement): string[] {
  const texts: string[] = [];
  const stack: Element[] = [root];
  while (stack.length > 0) {
    const el = stack.pop()!;
    const titleAttr = el.getAttribute('title');
    if (titleAttr) texts.push(titleAttr);
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === 3) texts.push(node.textContent ?? ''); // TEXT_NODE
    }
    for (const child of Array.from(el.children)) stack.push(child);
  }
  return texts;
}

const M24S4_BX_ROSTER = [
  'Party & Box',
  'Heal Party',
  'Party',
  'Box',
  'Rename',
  'To Box',
  'To Party',
  'No monsters in box.',
  '★ Ready to evolve',
  'Slot ',
  '(empty)',
  'New nickname:',
  'Only monsters in your Party can battle',
  'New recruits arrive in your Box',
  // ctl-8b: the Monsters frame's own English (tab labels, sheet rows, Move feedback lines).
  'Storage',
  'Summary',
  'Nickname',
  'Moved to party',
  'Moved to storage',
  // ctl-8c: the new sheet rows and reason, the food row shape, the Evolve list's lines, the
  // confirm's question and options, and the fed line.
  'Care',
  'Feed',
  'Evolve',
  'No food',
  '(x',
  'No evolution paths',
  'All requirements met',
  'Ready ',
  String.fromCharCode(0x2192), // the path heading's arrow
  'Yes',
  'Fed ',
];

function m24s4BxAssertNoRosterWord(texts: readonly string[], label: string): void {
  const { stripped, unexpectedSpans } = m24s4BxSplitSentinels(texts.join('\n'));
  // A FORGED bracket span (raw English wrapped in `«...»` by something other than the
  // resolver) is never elided — it must not exist at all under a correct implementation.
  expect(
    unexpectedSpans,
    `${label}: found «...» span(s) that are not an EXACT expected sentinel (a forged ` +
      `bracket span around raw content is not exempted from the roster scan)`,
  ).toEqual([]);
  for (const word of M24S4_BX_ROSTER) {
    expect(
      stripped.includes(word),
      `${label}: must not contain English roster word "${word}" outside a «sentinel»`,
    ).toBe(false);
  }
}

describe('m24s4 (ADR-0260): boxView.ts routes its migrated sinks through t()/tf()', () => {
  it('m24s4 BX-01: every migrated sink calls t()/tf() with the exact key and params, show() re-resolves constructor-time keys on a repeat open, and every DOM string stays byte-identical', () => {
    vi.mocked(i18nT).mockClear();
    vi.mocked(i18nTf).mockClear();
    const { parent, view } = mount();
    const root = s4BoxRootOf(parent);

    // --- pre-show: constructor-time keys must NOT have been requested yet (plan D3/D4) ---
    expect(
      i18nT,
      'm24s4 BX-01: box.title must resolve in show(), not the constructor',
    ).not.toHaveBeenCalledWith('box.title');
    expect(i18nT).not.toHaveBeenCalledWith('box.heal');
    expect(i18nT).not.toHaveBeenCalledWith('box.hint');
    expect(i18nT).not.toHaveBeenCalledWith('box.section.party');
    expect(i18nT).not.toHaveBeenCalledWith('box.section.box');

    // --- one party card + one empty slot; box empty ---
    const partyCard = makeCard({
      monsterId: 100n,
      speciesName: 'Sproutle',
      nickname: 'Kip',
      level: 6,
      currentHp: 15,
      statHp: 20,
      hpPercent: 75,
    });
    view.refresh([partyCard, null], []);
    view.show();

    expect(i18nT).toHaveBeenCalledWith('box.title');
    expect(i18nT).toHaveBeenCalledWith('box.heal');
    expect(i18nT).toHaveBeenCalledWith('box.hint');
    expect(i18nT).toHaveBeenCalledWith('box.section.party');
    expect(i18nT).toHaveBeenCalledWith('box.section.box');
    expect(i18nT).toHaveBeenCalledWith('box.box.empty');
    expect(i18nT).toHaveBeenCalledWith('box.card.toBox');
    expect(i18nT).not.toHaveBeenCalledWith('box.card.toParty');
    expect(i18nT).not.toHaveBeenCalledWith('box.card.evolveBadge');
    expect(i18nTf).toHaveBeenCalledWith('box.party.emptySlot', { slot: 1 });
    expect(i18nTf).toHaveBeenCalledWith('box.card.stats', {
      species: 'Sproutle',
      level: 6,
      current: 15,
      max: 20,
      percent: 75,
    });

    expect(root.querySelector('[data-testid="box-title"]')?.textContent).toBe('Party & Box');
    expect(root.querySelector('button')?.textContent).toBe('Heal Party');
    expect(root.querySelector('[data-testid="box-party-hint"]')?.textContent ?? '').toContain(
      'To Party',
    );
    const partyGrid = partyGridOf(parent);
    expect(partyGrid.textContent ?? '').toContain('Slot 1: (empty)');
    const boxGrid = boxGridOf(parent);
    expect(boxGrid.textContent ?? '').toContain('No monsters in box.');

    // --- box now holds a card pending an evolution choice ---
    vi.mocked(i18nT).mockClear();
    vi.mocked(i18nTf).mockClear();
    const boxCard = makeCard({
      monsterId: 200n,
      speciesName: 'Emberfang',
      nickname: '',
      level: 9,
      currentHp: 21,
      statHp: 21,
      hpPercent: 100,
      evolutionChoicePending: true,
    });
    view.refresh([partyCard, null], [boxCard]);

    expect(i18nT).not.toHaveBeenCalledWith('box.box.empty');
    expect(i18nT).toHaveBeenCalledWith('box.card.evolveBadge');
    expect(i18nT).toHaveBeenCalledWith('box.card.toParty');
    expect(i18nTf).toHaveBeenCalledWith('box.card.stats', {
      species: 'Emberfang',
      level: 9,
      current: 21,
      max: 21,
      percent: 100,
    });
    const boxCardEl = boxGridOf(parent);
    expect(boxCardEl.textContent ?? '').toContain('★ Ready to evolve — choose a path');
    // recruit.spec.ts HP-shape survival (brief): the `HP ${current}/${max}` bytes must
    // survive the migration verbatim.
    expect(boxCardEl.textContent ?? '').toContain('HP 21/21');

    // INTENTIONAL CHANGE (ctl-8b): the "Rename prompt" block is DELETED with the per-card Rename
    // button and the window.prompt it opened. `box.rename.prompt` is now the typing row's label
    // (CTL8B-3-VIEW-ROW and the sentinel case below pin it); no card carries a Rename button.
    expect(
      [...partyGrid.querySelectorAll('button')].map((b) => b.textContent),
      'ctl-8b: the party card carries To Box and nothing that renames',
    ).toEqual(['To Box']);

    // --- RT2: a repeat show() re-resolves the constructor-time keys ---
    vi.mocked(i18nT).mockClear();
    view.show();
    expect(
      i18nT,
      'm24s4 BX-01 RT2: a repeat show() on an already-open overlay must re-resolve box.title',
    ).toHaveBeenCalledWith('box.title');
    expect(i18nT).toHaveBeenCalledWith('box.heal');
    expect(i18nT).toHaveBeenCalledWith('box.hint');
    expect(i18nT).toHaveBeenCalledWith('box.section.party');
    expect(i18nT).toHaveBeenCalledWith('box.section.box');
  });

  it('m24s4 BX-02: under «key» sentinels, every rendered surface shows resolver output and never an English roster word outside a sentinel', () => {
    const { parent, view } = mount();
    const root = s4BoxRootOf(parent);

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      vi.mocked(i18nTf).mockImplementation(
        (key: string, params: unknown) => `«${key}|${JSON.stringify(params)}»`,
      );

      const partyCard = makeCard({
        monsterId: 100n,
        speciesName: 'Sproutle',
        nickname: 'Kip',
        level: 6,
        currentHp: 15,
        statHp: 20,
        hpPercent: 75,
      });
      view.refresh([partyCard, null], []);
      view.show();
      let texts = m24s4BxWalkSubtree(root);
      m24s4BxAssertNoRosterWord(texts, 'one party card, empty box');
      let joined = texts.join('\n');
      expect(joined).toContain('«box.title»');
      expect(joined).toContain('«box.heal»');
      expect(joined).toContain('«box.hint»');
      expect(joined).toContain('«box.section.party»');
      expect(joined).toContain('«box.section.box»');
      expect(joined).toContain('«box.box.empty»');
      // INTENTIONAL CHANGE (ctl-8b): no '«box.card.rename»': the per-card Rename button is gone.
      expect(joined).toContain('«box.card.toBox»');
      expect(joined).toContain(`«box.party.emptySlot|${JSON.stringify({ slot: 1 })}»`);
      expect(joined).toContain(
        `«box.card.stats|${JSON.stringify({
          species: 'Sproutle',
          level: 6,
          current: 15,
          max: 20,
          percent: 75,
        })}»`,
      );
      expect(joined, 'nickname renders raw, never a key').toContain('Kip');

      const boxCard = makeCard({
        monsterId: 200n,
        speciesName: 'Emberfang',
        nickname: '',
        level: 9,
        currentHp: 21,
        statHp: 21,
        hpPercent: 100,
        evolutionChoicePending: true,
      });
      view.refresh([partyCard, null], [boxCard]);
      texts = m24s4BxWalkSubtree(root);
      m24s4BxAssertNoRosterWord(texts, 'box card pending evolution');
      joined = texts.join('\n');
      expect(joined).toContain('«box.card.evolveBadge»');
      expect(joined).toContain('«box.card.toParty»');
      expect(joined).toContain(
        `«box.card.stats|${JSON.stringify({
          species: 'Emberfang',
          level: 9,
          current: 21,
          max: 21,
          percent: 100,
        })}»`,
      );

      // INTENTIONAL CHANGE (ctl-8b): the sentinel-wrapped prompt() block is DELETED (no prompt, no
      // Rename button). The sentinel-wrapped typing-row label is pinned by the ctl-8b i18n case
      // below instead.
    } finally {
      vi.mocked(i18nT).mockRestore();
      vi.mocked(i18nTf).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key — the new box.* keys do not exist
    // in the catalog until the specialist ships them).
    expect(i18nT('chrome.help.title')).toBe('Controls & Goals');
  });
});

describe('m24s4 (ADR-0260): boxView.ts scan — zero failing sinks', () => {
  it('m24s4 BX-03: scanSource(stripComments(boxView.ts)) has zero failing sinks, a >=15 sink floor, and no truncation/masking tripwires', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'boxView.ts'),
      'utf8',
    );
    const result = scanSource(stripComments(src));

    expect(
      result.failing.map((s) => `${s.kind}@L${s.line}: ${s.failingSegments.join(' | ')}`),
      'every sink must route through t()/tf() — any surviving English segment is listed above',
    ).toEqual([]);
    expect(
      result.sinks.length,
      'SINK_FLOOR idiom (plan measured census): a floor, never an exact count',
    ).toBeGreaterThanOrEqual(15);
    expect(
      result.unterminated,
      'the literal mask must not end inside an unterminated literal',
    ).toBe(false);
    expect(result.maskedSinkTokens, 'no parity-flip mask desync').toBe(0);
    for (const sink of result.sinks) {
      expect(sink.truncated, `${sink.kind}@L${sink.line} must not be truncated`).toBe(false);
    }
  });
});

// =============================================================================
// ctl-7b (CTL7B.1): the box is a class-styled `.mr-frame` shell inside `#game-screen`, not an
// inline position:fixed overlay with a translucent backdrop.
//
// WHAT THESE CASES CAN AND CANNOT PROVE: happy-dom does no cascade, no layout and no paint, so
// they prove the INLINE half of the contract only: which classes the root carries and which inline
// declarations it (and everything under it) still writes. Where the box lands and how its text
// paints against the real stylesheet is proved in real Chromium by client/e2e/a11y.spec.ts
// (CTL7B-E2E-ROOTS / CTL7B-E2E-BOX).
//
// The inline declarations are read from the style ATTRIBUTE and split by hand, never through
// happy-dom's CSSStyleDeclaration: that object expands shorthands (`inset`, `padding`, `background`)
// into longhands, so a name-set read through it depends on the happy-dom version.
// =============================================================================

/** The inline declarations of `el` (lower-cased property name -> raw value), from its style attribute. */
function ctl7bInline(el: Element): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (el.getAttribute('style') ?? '').split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    if (prop !== '') out.set(prop, part.slice(colon + 1).trim());
  }
  return out;
}

/** Inline properties that place, layer, dim, hide or recolour an element outside the stylesheet. */
const CTL7B_BANNED_ON_DESCENDANTS: ReadonlySet<string> = new Set([
  'position',
  'inset',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'opacity',
  'filter',
  'transform',
  'visibility',
  'mix-blend-mode',
  '-webkit-text-fill-color',
]);

/** Fails naming every inline property on `root` that is not in `allowed` (an ALLOW-LIST). */
function ctl7bExpectOnlyInline(root: HTMLElement, allowed: readonly string[], when: string): void {
  const stray = [...ctl7bInline(root).keys()].filter((name) => !allowed.includes(name));
  expect(
    stray,
    `CTL7B ${when}: the root may write only ${JSON.stringify(allowed)} inline. The shell class ` +
      'places it inside the screen and the frame class paints it, so any other inline property ' +
      '(position, inset, z-index, background, color, padding, overflow, font ...) is the old ' +
      'overlay still being drawn by hand',
  ).toEqual([]);
}

/** Fails naming every descendant of `root` with a banned inline property; returns how many were walked. */
function ctl7bExpectCleanDescendants(root: HTMLElement, when: string): number {
  const all = [...root.querySelectorAll('*')];
  const offenders: string[] = [];
  for (const el of all) {
    for (const prop of ctl7bInline(el).keys()) {
      if (CTL7B_BANNED_ON_DESCENDANTS.has(prop)) {
        offenders.push(`<${el.tagName.toLowerCase()}> ${prop}`);
      }
    }
  }
  expect(
    offenders,
    `CTL7B ${when}: no element under the root may place, layer, dim, hide or recolour itself ` +
      'inline — each is a way to leave the frame or to lower its text contrast that the class ' +
      'rules cannot override',
  ).toEqual([]);
  return all.length;
}

function ctl7bClasses(el: Element): string[] {
  return el.className
    .split(/\s+/)
    .filter((c) => c !== '')
    .sort();
}

/** The element's OWN text nodes, concatenated. */
function ctl7bOwnText(el: Element): string {
  return [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent ?? '')
    .join('');
}

/** `[r, g, b, a]` from a bare #rgb / #rrggbb / rgb() / rgba() literal; THROWS on anything else. */
function ctl7bRgba(raw: string): readonly [number, number, number, number] {
  const value = raw.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (hex !== null) {
    const body = hex[1] as string;
    const wide = body.length === 6;
    const channel = (i: number): number =>
      Number.parseInt(wide ? body.slice(i * 2, i * 2 + 2) : (body[i] as string).repeat(2), 16);
    return [channel(0), channel(1), channel(2), 1];
  }
  const fn =
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/.exec(value);
  if (fn !== null) {
    return [
      Number.parseInt(fn[1] as string, 10),
      Number.parseInt(fn[2] as string, 10),
      Number.parseInt(fn[3] as string, 10),
      fn[4] === undefined ? 1 : Number.parseFloat(fn[4]),
    ];
  }
  throw new Error(
    `CTL7B colour refused: ${JSON.stringify(raw)} is not a bare #rgb / #rrggbb / rgb() / rgba() ` +
      'literal. This reader never defaults an unreadable colour (a default would let the gate ' +
      'pass by deleting the declaration)',
  );
}

function ctl7bContrast(a: readonly number[], b: readonly number[]): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const lum = (c: readonly number[]): number =>
    0.2126 * lin(c[0] as number) + 0.7152 * lin(c[1] as number) + 0.0722 * lin(c[2] as number);
  return (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
}

/** `.mr-frame`'s `--mr-frame-fg` default: what text paints in when no inline colour is set. */
const CTL7B_FRAME_FG = '#e0e0e0';
/** The two surfaces an empty-state line sits on: the frame (`--mr-frame-bg`) and a card. */
const CTL7B_SURFACES = ['#1e1e2e', '#1a1a2e'] as const;

/** The inline colour in force for `el`: its own or the nearest ancestor's below `root`, else the frame fg. */
function ctl7bEffectiveColour(el: HTMLElement, root: HTMLElement): string {
  for (let n: HTMLElement | null = el; n !== null && n !== root; n = n.parentElement) {
    const colour = ctl7bInline(n).get('color');
    if (colour !== undefined) return colour;
  }
  return CTL7B_FRAME_FG;
}

/** Every empty-state element must be opaque and readable on both surfaces. */
function ctl7bExpectReadableEmpties(emptyEls: readonly Element[], root: HTMLElement): void {
  for (const el of emptyEls) {
    const raw = ctl7bEffectiveColour(el as HTMLElement, root);
    const rgba = ctl7bRgba(raw);
    const label = JSON.stringify(ctl7bOwnText(el));
    expect(
      rgba[3],
      `CTL7B ${label}: the empty-state colour ${raw} must be fully opaque (alpha 1) — a ` +
        'translucent colour is opacity by another name',
    ).toBe(1);
    for (const surface of CTL7B_SURFACES) {
      const ratio = ctl7bContrast(rgba, ctl7bRgba(surface));
      expect(
        ratio,
        `CTL7B ${label}: ${raw} on ${surface} measures ${ratio.toFixed(2)}:1, under the 4.5:1 AA ` +
          'minimum for small text',
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
}

describe('BoxView ctl-7b: the box root is a class-styled frame, inline only for visibility', () => {
  it('CTL7B-1-BOX-FRAME BITES: the box root is the one child of its parent, carries exactly .mr-frame and .mr-shell, writes only display and align-items inline in every state, and toggles display flex/none', async () => {
    // WRONG IMPLS KILLED:
    //  (1) the shipped root: `position:fixed;inset:0;z-index:100;background:rgba(...)` ... in its
    //      cssText (every state reds on the allow-list);
    //  (2) a root with the classes AND the old inline overlay still on it (the inline declaration
    //      beats the class rule at every specificity, so the shell would never apply);
    //  (3) `.mr-shell--top` borrowed for the box (z 120 would sit above the battle overlay);
    //  (4) the frame class on a WRAPPER around the root (identity is pinned through the title);
    //  (5) a fixed-position / dim / hide declaration smuggled onto a DESCENDANT after the root is
    //      clean (the subtree walk is run in every state, empty ones included);
    //  (6) a show() that no longer writes display:flex, or a hide() that no longer writes none
    //      (visibility is the one inline contract left; e2e/pvp.spec.ts and trade.spec.ts read
    //      `#app > div` style.display === 'flex' to detect the open box).
    const { parent, view } = mount();
    expect(parent.children, 'the view appends exactly ONE root into its parent').toHaveLength(1);
    const root = parent.firstElementChild as HTMLElement;
    const title = parent.querySelector('[data-testid="box-title"]');
    expect(title, 'precondition: the title anchor exists').not.toBeNull();
    expect(
      title?.parentElement?.parentElement,
      'the root is the header\'s parent — the "Party & Box" h2 -> header -> root chain that ' +
        'client/e2e/recruit.spec.ts resolves it by',
    ).toBe(root);
    expect(
      ctl7bClasses(root),
      'the root carries exactly the frame and the shell class — and not .mr-shell--top, which ' +
        'is the menu / help layer',
    ).toEqual(['mr-frame', 'mr-shell']);

    const allowed = ['display', 'align-items'];
    const sample = (when: string): number => {
      ctl7bExpectOnlyInline(root, allowed, when);
      return ctl7bExpectCleanDescendants(root, when);
    };

    sample('constructed');
    expect(root.style.display, 'hidden at construction').toBe('none');

    view.show();
    sample('shown');
    expect(root.style.display, 'show() writes display:flex').toBe('flex');
    expect(ctl7bInline(root).get('display')).toBe('flex');

    view.refresh(makePartySlots(), [makeBoxRecruitCard()]);
    const walked = sample('populated refresh');
    expect(
      walked,
      'non-vacuity: a populated box renders well over a dozen elements',
    ).toBeGreaterThan(15);
    expect(root.style.display, 'a refresh does not touch visibility').toBe('flex');
    // A deferred write (a setTimeout that re-adds an inline position after show()) lands here.
    await s4FlushMacrotask();
    sample('populated refresh, one macrotask later');
    expect(root.style.display).toBe('flex');

    // Cards carrying the evolution-choice badge: a different descendant shape, same ban.
    view.refresh(partySlotsWithBadge(true), [
      makeCard({
        monsterId: 200n,
        speciesName: 'Emberfang',
        partySlot: 255,
        evolutionChoicePending: true,
      }),
    ]);
    expect(
      parent.querySelectorAll('[data-testid="evo-choice-badge"]').length,
      'non-vacuity: the badge renders in the party card and in the box card',
    ).toBe(2);
    sample('badged refresh');

    view.refresh([null, null, null, null, null, null], []);
    sample('empty refresh');

    view.hide();
    sample('hidden');
    expect(root.style.display, 'hide() writes display:none').toBe('none');
    expect(ctl7bInline(root).get('display')).toBe('none');
  });

  it('CTL7B-1-NO-OPACITY-DIM-BOX BITES: the empty party slots and the empty storage line carry no inline opacity or filter and paint an opaque colour at 4.5:1 on both the frame and the card surface', () => {
    // WRONG IMPLS KILLED: the shipped empties (`el.style.opacity = '0.4'`): opacity composites
    // the text below 4.5:1, and it is invisible to any check that reads only a colour; the same
    // dimming spelled as `filter`; a replacement colour that is translucent (alpha < 1) or too
    // dim (#666 on #1a1a2e is 2.9:1); an unreadable colour literal (named, hsl, 8-digit hex).
    const { parent, view } = mount();
    view.refresh([null, null, null], []);
    view.show();
    const root = parent.firstElementChild as HTMLElement;

    const dimmers: string[] = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const prop of ['opacity', 'filter']) {
        if (ctl7bInline(el).has(prop)) dimmers.push(`<${el.tagName.toLowerCase()}> ${prop}`);
      }
    }
    expect(dimmers, 'no element in the empty box may dim itself inline').toEqual([]);

    const empties = [...root.querySelectorAll('*')].filter((el) => {
      const own = ctl7bOwnText(el);
      return own.includes('(empty)') || own.includes('No monsters in box.');
    });
    expect(
      empties.map((el) => ctl7bOwnText(el)),
      'precondition: three empty party slots and the empty storage line are rendered',
    ).toHaveLength(4);
    ctl7bExpectReadableEmpties(empties, root);
  });
});

// =============================================================================
// ctl-8b (CTL8B.1-.4): the Monsters frame painted by `BoxView.paint(MonstersPaint)`.
//
// The screen (screens/monstersScreen.ts) decides everything; this view only draws one
// `MonstersPaint`: the active tab, the cursor card, the action sheet, the summary, the nickname row,
// the commit token and the Move feedback line. These cases hand it paints directly.
//
// WHAT THESE CASES CAN AND CANNOT PROVE: happy-dom does no layout, no cascade and no paint, and
// `.focus()` on a display:none node is not refused here as a browser refuses it. "Hidden" is
// therefore read the one way the production code reads it (`focusInsideHiddenSubtree` looks only at
// INLINE `display`): an element, or an ancestor below the frame root, carrying `display:none`
// inline. The `hidden` attribute does not count: the panels carry inline `display:grid`, which beats
// `[hidden]`, so a view that hides with the attribute alone shows both panels. Whether the real
// Chromium cascade shows the right thing is proved by client/e2e (not here).
//
// Cards, tabs, the sheet and the row are located by structure the plan fixes, not by index:
//   - tabs: `[role="tablist"] [role="tab"]`, label = t('box.tab.party'|'box.tab.storage');
//   - the two panels: the grids that follow the "Party" / "Box" h3 (partyGridOf / boxGridOf);
//   - a card wrapper: the element carrying `data-nav-key` (the monster id in decimal) in a grid;
//   - the sheet: the one `[role="listbox"]` (the nav kit's list), its `[role="option"]` rows;
//   - the typing row: the `input[type="text"]` and its `label`;
//   - the feedback line: `.mr-frame-feedback`.
// =============================================================================

/** Tabs, the sheet's rows and the Move lines carry ids the typed catalog does not have until the
 *  catalog ships; the resolver is the real one (spy, call-through), reached through a plain-string
 *  signature. */
const c8bT = i18nT as unknown as (key: string) => string;

const CHECK_MARK = String.fromCharCode(0x2713);
/** ctl-8c: U+2026 HORIZONTAL ELLIPSIS ('Feed…', 'Evolve…'), built by code point. */
const C8C_ELLIPSIS = String.fromCharCode(0x2026);

const C8B_KIP = makeCard({
  monsterId: 100n,
  speciesName: 'Sproutle',
  nickname: 'Kip',
  partySlot: 0,
});
const C8B_MOSS = makeCard({
  monsterId: 101n,
  speciesName: 'Mossling',
  nickname: '',
  partySlot: 1,
  currentHp: 12,
  hpPercent: 60,
});
const C8B_EMBER = makeCard({
  monsterId: 200n,
  speciesName: 'Emberfang',
  nickname: '',
  partySlot: BOX_SLOT,
});
const C8B_DUSK = makeCard({
  monsterId: 300n,
  speciesName: 'Duskling',
  nickname: '',
  partySlot: BOX_SLOT,
});
const C8B_TIDE = makeCard({
  monsterId: 400n,
  speciesName: 'Tidepup',
  nickname: '',
  partySlot: BOX_SLOT,
});

const c8bParty = (): (MonsterCardViewModel | null)[] => [C8B_KIP, C8B_MOSS, null, null, null, null];
const c8bBox = (): MonsterCardViewModel[] => [C8B_EMBER, C8B_DUSK, C8B_TIDE];

// INTENTIONAL CHANGE (ctl-8c): the opening also paints no food list, no Evolve list, no confirm.
const C8B_OPENING: MonstersPaint = {
  tab: 'storage',
  activeKey: null,
  sheet: null,
  feed: null,
  evolve: null,
  confirm: null,
  summary: null,
  nickname: null,
  commit: null,
  feedback: null,
};
const c8bPaint = (over: Partial<MonstersPaint> = {}): MonstersPaint => ({
  ...C8B_OPENING,
  ...over,
});

/** A sheet paint (ctl-8c): Feed… and Evolve… enabled unless a case says otherwise. */
const c8bSheet = (
  card: MonsterCardViewModel,
  action: SheetAction,
  canFeed = true,
  canEvolve = true,
): NonNullable<MonstersPaint['sheet']> => ({ card, action, canFeed, canEvolve });

interface C8bMounted {
  parent: HTMLElement;
  view: BoxView;
  root: HTMLElement;
  callbacks: BoxViewCallbacks;
}

/** A mounted, hidden view with nothing drawn. */
function c8bMount(callbacks: Partial<BoxViewCallbacks> = {}): C8bMounted {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const all: BoxViewCallbacks = { ...makeBoxCallbacks(), ...callbacks };
  const view = new BoxView(parent, all);
  return { parent, view, root: parent.firstElementChild as HTMLElement, callbacks: all };
}

/** A mounted view with both lists drawn and the frame shown. */
function c8bOpen(callbacks: Partial<BoxViewCallbacks> = {}): C8bMounted {
  const mounted = c8bMount(callbacks);
  mounted.view.refresh(c8bParty(), c8bBox());
  mounted.view.show();
  return mounted;
}

/** Whether `el` or an ancestor below `root` has inline `display:none` (the root itself is the
 *  frame's own show / hide and is not part of "this element is hidden"). */
function c8bHidden(el: Element, root: Element): boolean {
  expect(root.contains(el), 'the element is inside the frame root').toBe(true);
  for (let n: Element | null = el; n !== null && n !== root; n = n.parentElement) {
    if ((n as HTMLElement).style.display === 'none') return true;
  }
  return false;
}

const c8bTabs = (root: Element): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('[role="tablist"] [role="tab"]'),
];
const c8bSelected = (root: Element): (string | null)[] =>
  c8bTabs(root).map((tab) => tab.getAttribute('aria-selected'));
const c8bCards = (grid: Element): HTMLElement[] => [
  ...grid.querySelectorAll<HTMLElement>('[data-nav-key]'),
];
const c8bKeys = (grid: Element): (string | undefined)[] =>
  c8bCards(grid).map((el) => el.dataset.navKey);
const c8bMarked = (root: Element): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('[aria-current="true"]'),
];

/** The elements of the frame that are not inside either panel's grid. */
function c8bOutsidePanels(parent: HTMLElement, root: HTMLElement): HTMLElement[] {
  const grids = [partyGridOf(parent), boxGridOf(parent)];
  return [...root.querySelectorAll<HTMLElement>('*')].filter(
    (el) => !grids.some((grid) => grid.contains(el)),
  );
}

/** The shown elements outside the panels whose own text includes `text`. */
const c8bShownText = (parent: HTMLElement, root: HTMLElement, text: string): HTMLElement[] =>
  c8bOutsidePanels(parent, root).filter(
    (el) => ctl7bOwnText(el).includes(text) && !c8bHidden(el, root),
  );

const c8bAnchor = (root: Element): HTMLElement =>
  root.querySelector('[data-testid="box-title"]') as HTMLElement;

function c8bHealButton(root: Element): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find(
    (b) => b.textContent === i18nT('box.heal'),
  );
  expect(found, 'precondition: the header carries the Heal Party button').toBeDefined();
  return found as HTMLButtonElement;
}

const c8bInput = (root: Element): HTMLInputElement | null =>
  root.querySelector<HTMLInputElement>('input[type="text"]');

function c8bRow(card: MonsterCardViewModel, edit: number, tab: 'party' | 'storage' = 'party') {
  return c8bPaint({
    tab,
    activeKey: String(card.monsterId),
    sheet: c8bSheet(card, 'nickname'),
    nickname: { card, edit },
  });
}

describe('BoxView ctl-8b: the tabs and the cursor (CTL8B.1)', () => {
  it('CTL8B-1-VIEW-TABS: paint draws a tablist with a Party tab and a Storage tab labelled from the catalog, the painted one aria-selected; the inactive panel and its heading are hidden by inline display:none (never only the hidden attribute, never removed) while their text stays in the root', () => {
    // WRONG IMPL KILLED: no tab strip; tabs labelled with literals or in the other order; both
    // tabs (or neither) selected; the inactive panel hidden by the `hidden` attribute alone (the
    // panels carry inline display:grid, which beats it: both panels would show); an inactive
    // panel REMOVED (the recruit / evolution e2e helpers scan the root's text for every monster's
    // `HP cur/max`, Party and Box alike); the inactive heading left showing; a switch that hides
    // both panels; and a repaint that does not follow the tab.
    const { parent, view, root } = c8bOpen();
    const party = partyGridOf(parent);
    const box = boxGridOf(parent);
    const partyHeading = findByTag(parent, 'h3', 'Party');
    const boxHeading = findByTag(parent, 'h3', 'Box');

    view.paint(c8bPaint({ tab: 'party' }));
    const tabs = c8bTabs(root);
    expect(
      tabs.map((tab) => tab.textContent),
      'the two tabs, Party first, labelled by t()',
    ).toEqual([c8bT('box.tab.party'), c8bT('box.tab.storage')]);
    expect(
      tabs.map((tab) => tab.textContent),
      'English bytes',
    ).toEqual(['Party', 'Storage']);
    expect(c8bSelected(root), 'Party painted: the first tab selected').toEqual(['true', 'false']);
    expect(c8bHidden(party, root), 'the Party grid shows').toBe(false);
    expect(c8bHidden(partyHeading, root), 'the Party heading shows').toBe(false);
    expect(c8bHidden(box, root), 'the Box grid is hidden by inline display:none').toBe(true);
    expect(c8bHidden(boxHeading, root), 'and so is its heading').toBe(true);
    expect(root.textContent ?? '', 'the hidden panel`s text stays in the root').toContain(
      'Emberfang',
    );
    expect(box.textContent ?? '').toContain('Duskling');

    view.paint(c8bPaint({ tab: 'storage' }));
    expect(c8bSelected(root), 'Storage painted: the second tab selected').toEqual([
      'false',
      'true',
    ]);
    expect(c8bHidden(box, root)).toBe(false);
    expect(c8bHidden(boxHeading, root)).toBe(false);
    expect(c8bHidden(party, root), 'the Party grid is hidden now').toBe(true);
    expect(c8bHidden(partyHeading, root)).toBe(true);
    expect(root.textContent ?? '', 'the hidden Party panel`s text stays').toContain('Sproutle');
    expect(party.textContent ?? '').toContain('Mossling');

    // Back to Party: the strip and the panels follow; nothing was removed along the way.
    view.paint(c8bPaint({ tab: 'party' }));
    expect(c8bSelected(root)).toEqual(['true', 'false']);
    expect(c8bHidden(party, root)).toBe(false);
    expect(c8bHidden(box, root)).toBe(true);
    expect(c8bTabs(root), 'still exactly two tabs').toHaveLength(2);
    expect(root.querySelectorAll('[role="tablist"]'), 'one tablist').toHaveLength(1);
  });

  it('CTL8B-1-VIEW-CURSOR: after a paint exactly one card wrapper carries aria-current="true" and class is-active, it is the card whose data-nav-key is the painted key in the painted tab, and it is not styled .mr-nav-item; no key means the first card of the tab; a later paint moves the mark; a later refresh() keeps it', () => {
    // WRONG IMPL KILLED: no cursor mark; a mark on every card or on none; a mark that is only a
    // class (a screen reader hears nothing: aria-current is the non-colour half); a card styled
    // `.mr-nav-item` (its `.is-active` rule paints dark text on a dark card, or light on #ccc); a
    // mark on a card of the INACTIVE tab; a null key that marks nothing (a Storage opened by KeyB
    // would show no cursor before the first step); a stale mark after a repaint (two cards marked);
    // a key matched by index instead of by id; and a mark lost when a batch re-renders the lists
    // (refresh() rebuilds every card, and the screen paints nothing after a batch that changed
    // nothing).
    const { parent, view, root } = c8bOpen();
    const party = partyGridOf(parent);
    const box = boxGridOf(parent);
    expect(c8bKeys(party), 'cards are keyed by monster id, in order').toEqual(['100', '101']);
    expect(c8bKeys(box)).toEqual(['200', '300', '400']);

    const expectMark = (grid: Element, key: string, when: string): void => {
      const marked = c8bMarked(root);
      expect(marked, `${when}: exactly one aria-current`).toHaveLength(1);
      const [card] = marked as [HTMLElement];
      expect(card.dataset.navKey, `${when}: the card of key ${key}`).toBe(key);
      expect(grid.contains(card), `${when}: in the painted tab's grid`).toBe(true);
      expect(card.classList.contains('is-active'), `${when}: class is-active`).toBe(true);
      expect(card.classList.contains('mr-nav-item'), `${when}: not styled as a nav row`).toBe(
        false,
      );
      for (const other of [...c8bCards(party), ...c8bCards(box)]) {
        expect(other.classList.contains('mr-nav-item'), `${when}: no card is a nav row`).toBe(
          false,
        );
        if (other === card) continue;
        expect(other.classList.contains('is-active'), `${when}: ${other.dataset.navKey}`).toBe(
          false,
        );
      }
    };

    view.paint(c8bPaint({ tab: 'storage', activeKey: '300' }));
    expectMark(box, '300', 'storage 300');
    view.paint(c8bPaint({ tab: 'storage', activeKey: '400' }));
    expectMark(box, '400', 'storage 400 (the mark moved)');
    view.paint(c8bPaint({ tab: 'party', activeKey: '101' }));
    expectMark(party, '101', 'party 101 (no mark left in Storage)');

    // No key: the first card of the active tab.
    view.paint(c8bPaint({ tab: 'party', activeKey: null }));
    expectMark(party, '100', 'party, no key');
    view.paint(c8bPaint({ tab: 'storage', activeKey: null }));
    expectMark(box, '200', 'storage, no key');

    // A batch re-renders the lists: the kept paint is re-applied to the new cards.
    view.paint(c8bPaint({ tab: 'storage', activeKey: '400' }));
    view.refresh(c8bParty(), c8bBox());
    expectMark(box, '400', 'after refresh()');
    view.refresh(c8bParty(), c8bBox());
    expectMark(box, '400', 'after a second refresh()');
    view.paint(c8bPaint({ tab: 'party', activeKey: '101' }));
    view.refresh(c8bParty(), c8bBox());
    expectMark(party, '101', 'party after refresh()');
  });
});

describe('BoxView ctl-8b: the action sheet, the summary and the Move line (CTL8B.2)', () => {
  it('CTL8B-2-VIEW-SHEET: a sheet paint shows a list of Summary, Care, Feed, Evolve, Nickname and Move (catalog labels, in that order) with the painted action as the active row, names the card, and sits in the DOM before both panels; a null sheet hides it by inline display:none and a later sheet shows again', () => {
    // WRONG IMPL KILLED: no sheet; labels from literals or in another order; no active row, or the
    // active row ignoring the painted action; a sheet that does not name its monster (the player
    // cannot tell which one A opened), or one that keeps the PREVIOUS monster's name; a sheet
    // placed after the panels (Escape-then-Enter in the typing row focuses the first non-text
    // control: the To Party / To Box buttons of the panels would win it and a card's Move would
    // run); a null sheet that leaves the list showing, or removes the element (the focus rescue
    // and the e2e text scans rely on hide-not-remove).
    const { parent, view, root } = c8bOpen();
    const party = partyGridOf(parent);
    const box = boxGridOf(parent);

    view.paint(
      c8bPaint({
        tab: 'party',
        activeKey: '100',
        sheet: c8bSheet(C8B_KIP, 'nickname'),
      }),
    );
    const sheet = root.querySelector<HTMLElement>('[role="listbox"]');
    expect(sheet, 'the sheet is the nav list').not.toBeNull();
    const list = sheet as HTMLElement;
    const rows = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    // INTENTIONAL CHANGE (ctl-8c): the design §5 six-row order.
    expect(
      rows.map((row) => row.textContent),
      'Summary, Care, Feed, Evolve, Nickname, Move: the catalog labels in order',
    ).toEqual([
      c8bT('box.sheet.summary'),
      c8bT('box.sheet.care'),
      c8bT('box.sheet.feed'),
      c8bT('box.sheet.evolve'),
      c8bT('box.sheet.nickname'),
      c8bT('box.sheet.move'),
    ]);
    expect(
      rows.map((row) => row.textContent),
      'English bytes',
    ).toEqual([
      'Summary',
      'Care',
      `Feed${C8C_ELLIPSIS}`,
      `Evolve${C8C_ELLIPSIS}`,
      'Nickname',
      'Move',
    ]);
    const activeRows = (): (string | null)[] =>
      [...list.querySelectorAll<HTMLElement>('[role="option"].is-active')].map(
        (row) => row.textContent,
      );
    expect(activeRows(), 'the painted action is the active row').toEqual([
      c8bT('box.sheet.nickname'),
    ]);
    expect(
      rows.map((row) => row.getAttribute('aria-selected')),
      'and the only selected one',
    ).toEqual(['false', 'false', 'false', 'false', 'true', 'false']);
    expect(c8bHidden(list, root), 'the sheet shows').toBe(false);
    expect(
      c8bShownText(parent, root, 'Kip'),
      'the card`s name is shown, outside the panels',
    ).not.toEqual([]);

    // The painted action moves the active row.
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'move') }));
    expect(activeRows()).toEqual([c8bT('box.sheet.move')]);
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'summary') }));
    expect(activeRows()).toEqual([c8bT('box.sheet.summary')]);

    // DOM order: the sheet precedes both panels and is inside neither.
    for (const [name, grid] of [
      ['Party', party],
      ['Box', box],
    ] as const) {
      expect(
        grid.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_PRECEDING,
        `the sheet comes before the ${name} panel`,
      ).not.toBe(0);
      expect(grid.contains(list), `the sheet is not inside the ${name} panel`).toBe(false);
    }

    // Another monster, another tab: its own name replaces the first one (a nickname-less card
    // shows its species), and the sheet is still the same list.
    view.paint(
      c8bPaint({
        tab: 'storage',
        activeKey: '200',
        sheet: c8bSheet(C8B_EMBER, 'summary'),
      }),
    );
    expect(c8bShownText(parent, root, 'Emberfang'), 'the new name').not.toEqual([]);
    expect(c8bShownText(parent, root, 'Kip'), 'the old name is not left showing').toEqual([]);
    expect(c8bHidden(list, root)).toBe(false);

    // A null sheet hides it by inline display, keeping the node.
    view.paint(c8bPaint({ tab: 'storage', activeKey: '200' }));
    expect(root.contains(list), 'the sheet node is kept').toBe(true);
    expect(c8bHidden(list, root), 'and hidden by inline display:none').toBe(true);
    expect(c8bShownText(parent, root, 'Emberfang'), 'no name left showing').toEqual([]);

    // And a later sheet shows it again.
    view.paint(
      c8bPaint({ tab: 'storage', activeKey: '300', sheet: c8bSheet(C8B_DUSK, 'summary') }),
    );
    expect(c8bHidden(list, root)).toBe(false);
    expect(c8bShownText(parent, root, 'Duskling')).not.toEqual([]);
  });

  it('CTL8B-2-VIEW-FEEDBACK: a feedback paint shows one .mr-frame-feedback[data-feedback="ok"] line reading the catalog text of the Move (no check mark in the text: it is a CSS glyph); a null paint leaves no line showing', () => {
    // WRONG IMPL KILLED: no line; text from a literal or the wrong direction's text; a "✓" typed
    // into the text (the CSS ::before would draw a second one); a line without the class or the
    // data-feedback="ok" the stylesheet keys on (it would be unstyled, and the check mark would
    // never draw); two lines; and a line that survives a null paint (a stale "Moved to party"
    // under the next action).
    const { root, view } = c8bOpen();
    const shownLines = (): HTMLElement[] =>
      [...root.querySelectorAll<HTMLElement>('.mr-frame-feedback')].filter(
        (el) => !c8bHidden(el, root) && (el.textContent ?? '') !== '',
      );
    expect(shownLines(), 'no line before any feedback').toEqual([]);

    // INTENTIONAL CHANGE (ctl-8c): the feedback is a tagged `{ kind }`.
    view.paint(c8bPaint({ feedback: { kind: 'movedToParty' } }));
    let lines = shownLines();
    expect(lines, 'exactly one line').toHaveLength(1);
    expect((lines[0] as HTMLElement).getAttribute('data-feedback')).toBe('ok');
    expect((lines[0] as HTMLElement).textContent).toBe(c8bT('box.feedback.movedToParty'));
    expect((lines[0] as HTMLElement).textContent).toBe('Moved to party');
    expect((lines[0] as HTMLElement).textContent ?? '', 'no glyph in the text').not.toContain(
      CHECK_MARK,
    );

    view.paint(c8bPaint({ feedback: { kind: 'movedToBox' } }));
    lines = shownLines();
    expect(lines, 'still one line').toHaveLength(1);
    expect((lines[0] as HTMLElement).getAttribute('data-feedback')).toBe('ok');
    expect((lines[0] as HTMLElement).textContent).toBe(c8bT('box.feedback.movedToBox'));
    expect((lines[0] as HTMLElement).textContent).toBe('Moved to storage');

    view.paint(c8bPaint({ feedback: null }));
    expect(shownLines(), 'a null paint clears the line').toEqual([]);
    view.paint(c8bPaint({ feedback: { kind: 'movedToParty' } }));
    expect(shownLines(), 'and a later one shows it again').toHaveLength(1);
  });

  it('the summary pane names the monster outside the panels while painted and leaves nothing showing when the summary is null', () => {
    // WRONG IMPL KILLED: a summary paint that draws nothing (A on Summary would look dead), one
    // that draws into a panel's grid (a refresh() would wipe it), and a pane that stays after the
    // screen returned to the sheet.
    const { parent, view, root } = c8bOpen();
    view.paint(c8bPaint({ tab: 'party', activeKey: '101' }));
    expect(c8bShownText(parent, root, 'Mossling'), 'no summary yet').toEqual([]);
    view.paint(c8bPaint({ tab: 'party', activeKey: '101', summary: C8B_MOSS }));
    expect(c8bShownText(parent, root, 'Mossling'), 'the summary names its monster').not.toEqual([]);
    view.refresh(c8bParty(), c8bBox());
    expect(c8bShownText(parent, root, 'Mossling'), 'a batch render keeps it').not.toEqual([]);
    view.paint(c8bPaint({ tab: 'party', activeKey: '101' }));
    expect(c8bShownText(parent, root, 'Mossling'), 'a null summary hides it').toEqual([]);
  });
});

describe('BoxView ctl-8b: the nickname row (CTL8B.3)', () => {
  it('CTL8B-3-VIEW-ROW: a nickname paint shows a labelled text field prefilled with the card`s nickname (empty for a card with none) and focuses it; the Heal Party button is disabled while it is shown and enabled again when it closes; closing it moves focus to the title anchor and sends nothing; the field keeps keys out of the page`s hotkeys but lets Enter through', async () => {
    // WRONG IMPL KILLED: no row; a field with no label (a screen reader names it nothing); a
    // prefill of the species name for a nickname-less card (the commit would then rename the
    // monster to its species); a field never focused (the player types into the page: main.ts's
    // ladder takes B, I, E, Q and the rest); a key shield that also eats Enter (A would never
    // commit) or none at all ("b" in the field would close the box); a Heal Party button left
    // enabled (Escape then Enter focuses the first enabled non-text control and would HEAL); a
    // row left showing after it closed; focus left on the hidden field (it falls to <body> and
    // the frame loses the keyboard).
    const { view, root, callbacks } = c8bOpen();
    await s4FlushMacrotask(); // show()'s deferred anchor focus lands before the row opens
    const heal = c8bHealButton(root);
    expect(heal.disabled, 'Heal Party starts enabled').toBe(false);

    view.paint(c8bRow(C8B_KIP, 1));
    const input = c8bInput(root);
    expect(input, 'the row`s text field').not.toBeNull();
    const field = input as HTMLInputElement;
    expect(c8bHidden(field, root), 'the field shows').toBe(false);
    expect(field.value, 'prefilled with the nickname').toBe('Kip');
    expect(document.activeElement, 'and focused').toBe(field);
    const labels = [...root.querySelectorAll('label')].filter(
      (l) => l.textContent === i18nT('box.rename.prompt'),
    );
    expect(labels, 'one label reading the catalog text').toHaveLength(1);
    const lab = labels[0] as HTMLLabelElement;
    expect(
      (lab.htmlFor !== '' && lab.htmlFor === field.id) || lab.contains(field),
      'the label belongs to the field',
    ).toBe(true);
    expect(c8bHidden(lab, root), 'and shows').toBe(false);
    expect(heal.disabled, 'Heal Party is disabled while the row is shown').toBe(true);

    // The key shield: the page's hotkey ladder listens on window and must not see typed letters.
    const seen: string[] = [];
    const spy = (e: Event): void => {
      seen.push((e as KeyboardEvent).code);
    };
    window.addEventListener('keydown', spy);
    try {
      const press = (el: Element, code: string): void => {
        el.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
      };
      press(document.body, 'KeyB');
      expect(seen, 'CONTROL: a keydown on a plain element reaches window').toEqual(['KeyB']);
      seen.length = 0;
      for (const code of [
        'KeyB',
        'KeyI',
        'KeyN',
        'KeyQ',
        'KeyE',
        'KeyF',
        'Space',
        'Backspace',
        'ArrowLeft',
        'ArrowDown',
      ]) {
        press(field, code);
      }
      expect(seen, 'typed keys never reach the window ladder').toEqual([]);
      press(field, 'Enter');
      press(field, 'NumpadEnter');
      expect(seen, 'Enter and NumpadEnter DO bubble: the router takes them as A').toEqual([
        'Enter',
        'NumpadEnter',
      ]);
    } finally {
      window.removeEventListener('keydown', spy);
    }

    // The row closes (B, or A with the commit already painted): enabled again, hidden, focus on
    // the title anchor, nothing sent.
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'nickname') }));
    expect(c8bHidden(field, root), 'the row is hidden by inline display').toBe(true);
    expect(c8bHidden(lab, root), 'and so is its label').toBe(true);
    expect(heal.disabled, 'Heal Party is enabled again').toBe(false);
    expect(document.activeElement, 'focus moves to the title anchor, not <body>').toBe(
      c8bAnchor(root),
    );
    expect(
      callbacks.onSetNickname,
      'closing without a commit sends nothing',
    ).not.toHaveBeenCalled();

    // A card with no nickname: the field is empty (never the species name), and focused.
    view.paint(c8bRow(C8B_MOSS, 2));
    const second = c8bInput(root) as HTMLInputElement;
    expect(c8bHidden(second, root)).toBe(false);
    expect(second.value, 'no nickname: empty, not "Mossling"').toBe('');
    expect(document.activeElement).toBe(second);
    expect(heal.disabled).toBe(true);
  });

  it('CTL8B-3-VIEW-COMMIT-ONCE: a NEW commit token sends onSetNickname(monsterId, the field`s text) exactly once, even when onSetNickname repaints; the same token again, a repaint or a refresh() never sends again; a text equal to the token`s current nickname sends nothing; each new open re-prefills the field; after the row closes focus is on the title anchor', async () => {
    // WRONG IMPL KILLED: a commit that never reaches the callback; one sent with the card's
    // nickname instead of the typed text, or with another monster's id; one replayed by every
    // repaint (a batch's refresh() re-applies the kept paint: the monster would be renamed on every
    // batch); a token compared by VALUE instead of identity (the second rename to the same text
    // would be dropped); the token recorded AFTER the callback (a repaint inside it sends twice);
    // a skip that is missing (the legacy prompt skipped an unchanged name), or that compares the
    // text to the wrong value; a field that keeps the last open's text; and focus left on the
    // hidden field.
    const { view, root, callbacks } = c8bOpen();
    await s4FlushMacrotask();
    const type = (text: string): void => {
      const field = c8bInput(root) as HTMLInputElement;
      field.value = text;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const closed = (commit: NicknameCommit | null): MonstersPaint =>
      c8bPaint({
        tab: 'party',
        activeKey: '100',
        sheet: c8bSheet(C8B_KIP, 'nickname'),
        commit,
      });
    const sent = callbacks.onSetNickname;

    // Round 1: type a new name and commit.
    view.paint(c8bRow(C8B_KIP, 1));
    type('Zed');
    const token1: NicknameCommit = { monsterId: 100n, current: 'Kip' };
    const commitPaint = closed(token1);
    view.paint(commitPaint);
    expect(sent, 'one call').toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith(100n, 'Zed');
    expect(document.activeElement, 'focus on the title anchor').toBe(c8bAnchor(root));
    expect(root.contains(document.activeElement), 'inside the frame').toBe(true);

    // Replays: the same paint, an equal paint carrying the same token, a batch render.
    view.paint(commitPaint);
    view.paint(closed(token1));
    view.refresh(c8bParty(), c8bBox());
    view.refresh(c8bParty(), c8bBox());
    view.paint(c8bPaint({ tab: 'party', activeKey: '101' }));
    view.paint(closed(token1));
    expect(sent, 'the same token never sends twice').toHaveBeenCalledTimes(1);

    // Round 2: the row opens again with a new edit: re-prefilled; an unchanged text sends nothing.
    view.paint(c8bRow(C8B_KIP, 2));
    expect((c8bInput(root) as HTMLInputElement).value, 'prefilled again, not "Zed"').toBe('Kip');
    expect(document.activeElement, 'and focused again').toBe(c8bInput(root));
    view.paint(closed({ monsterId: 100n, current: 'Kip' }));
    expect(sent, 'text equal to the current nickname: nothing sent').toHaveBeenCalledTimes(1);

    // Round 3: another name; the token's `current` is what the text is compared with.
    view.paint(c8bRow(C8B_KIP, 3));
    type('Pip');
    view.paint(closed({ monsterId: 100n, current: 'Pip' }));
    expect(
      sent,
      'the text equals the live nickname (a batch renamed it): nothing sent',
    ).toHaveBeenCalledTimes(1);
    view.paint(c8bRow(C8B_KIP, 4));
    type('Pip');
    view.paint(closed({ monsterId: 100n, current: 'Kip' }));
    expect(sent, 'a new token with a different current: sent').toHaveBeenCalledTimes(2);
    expect(sent).toHaveBeenLastCalledWith(100n, 'Pip');

    // A commit for another monster names THAT monster.
    view.paint(c8bRow(C8B_MOSS, 5));
    type('Mo');
    view.paint(
      c8bPaint({
        tab: 'party',
        activeKey: '101',
        sheet: c8bSheet(C8B_MOSS, 'nickname'),
        commit: { monsterId: 101n, current: '' },
      }),
    );
    expect(sent).toHaveBeenCalledTimes(3);
    expect(sent).toHaveBeenLastCalledWith(101n, 'Mo');

    // Re-entrancy: a callback that repaints with the very same token must not send again.
    let repaint: (() => void) | undefined;
    const reentrant = c8bOpen({
      onSetNickname: vi.fn(() => {
        repaint?.();
      }),
    });
    await s4FlushMacrotask();
    const again: NicknameCommit = { monsterId: 100n, current: 'Kip' };
    const againPaint = c8bPaint({
      tab: 'party',
      activeKey: '100',
      sheet: c8bSheet(C8B_KIP, 'nickname'),
      commit: again,
    });
    repaint = () => reentrant.view.paint(againPaint);
    reentrant.view.paint(c8bRow(C8B_KIP, 1));
    (c8bInput(reentrant.root) as HTMLInputElement).value = 'Zed';
    reentrant.view.paint(againPaint);
    expect(
      reentrant.callbacks.onSetNickname,
      'the token is recorded before the callback runs: a repaint inside it sends nothing more',
    ).toHaveBeenCalledTimes(1);
  });

  it('CTL8B-3-NO-WINDOW-PROMPT: driving the whole nickname flow through paint, then clicking every control the frame has, never calls window.prompt; the typed name reaches onSetNickname through the field alone', async () => {
    // WRONG IMPL KILLED: a Rename button (or any control) that still opens the native prompt (the
    // legacy path this slice deletes: a modal the D-pad and the typing-mode rule cannot reach), a
    // nickname flow that reaches the callback through prompt() instead of the field, and a field
    // flow that does not work at all (the callback is asserted, so "no prompt" cannot pass by
    // doing nothing).
    const promptSpy = vi.fn(() => null);
    vi.stubGlobal('prompt', promptSpy);
    try {
      const { view, root, callbacks } = c8bOpen();
      await s4FlushMacrotask();
      view.paint(c8bRow(C8B_KIP, 1));
      const field = c8bInput(root) as HTMLInputElement;
      expect(field, 'the typing row exists').not.toBeNull();
      field.value = 'Zed';
      view.paint(
        c8bPaint({
          tab: 'party',
          activeKey: '100',
          sheet: c8bSheet(C8B_KIP, 'nickname'),
          commit: { monsterId: 100n, current: 'Kip' },
        }),
      );
      expect(callbacks.onSetNickname, 'the field`s text arrives').toHaveBeenCalledWith(100n, 'Zed');

      for (const button of [...root.querySelectorAll('button')]) button.click();
      for (const tab of c8bTabs(root)) tab.click();
      for (const card of [...c8bCards(partyGridOf(root)), ...c8bCards(boxGridOf(root))]) {
        card.click();
      }
      expect(promptSpy, 'no click opened the native prompt').not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('CTL8B-3-ESCAPE-KEEPS-TEXT: with the row open and text typed, a blur (Escape stops typing) followed by a repaint of the SAME edit, or by a batch refresh(), keeps the typed text and does not refocus the field; a NEW edit prefills and focuses it again', async () => {
    // WRONG IMPL KILLED: a paint that refocuses the field every time (Escape would be undone by
    // the next batch: the player could never leave the field to press Enter as A), one that
    // re-prefills on every paint (the half-typed name is wiped by an unrelated batch), one that
    // rebuilds the field on refresh() (the text and the caret are lost), and the over-correction:
    // a view that never refocuses, even for a NEW open of the row.
    const { view, root } = c8bOpen();
    await s4FlushMacrotask();
    view.paint(c8bRow(C8B_KIP, 1));
    const field = c8bInput(root) as HTMLInputElement;
    expect(document.activeElement, 'precondition: the open focuses the field').toBe(field);
    field.value = 'Zed';
    field.blur();
    expect(document.activeElement, 'precondition: the blur took focus off the field').not.toBe(
      c8bInput(root),
    );

    // An observe-driven repaint of the same edit (a new paint object, the same edit number).
    view.paint(c8bRow(C8B_KIP, 1));
    expect((c8bInput(root) as HTMLInputElement).value, 'the typed text is kept').toBe('Zed');
    expect(document.activeElement, 'and focus is not taken back').not.toBe(c8bInput(root));
    expect(c8bHidden(c8bInput(root) as HTMLInputElement, root), 'the row is still open').toBe(
      false,
    );

    // A batch render re-applies the kept paint.
    view.refresh(c8bParty(), c8bBox());
    expect((c8bInput(root) as HTMLInputElement).value, 'kept across refresh()').toBe('Zed');
    expect(document.activeElement, 'not refocused by refresh()').not.toBe(c8bInput(root));

    // A NEW edit prefills and focuses again.
    view.paint(c8bRow(C8B_KIP, 2));
    expect((c8bInput(root) as HTMLInputElement).value, 'a new edit re-prefills').toBe('Kip');
    expect(document.activeElement, 'and refocuses').toBe(c8bInput(root));
  });
});

describe('BoxView ctl-8b: opening on Storage and the catalog (CTL8B.4)', () => {
  it('CTL8B-4-VIEW-OPENS-ON-STORAGE: a view shown with no paint (lists drawn before or after the show) has the Storage tab selected, the Party panel hidden and the first Storage card marked; hide() then show() returns to that even after a Party paint with a sheet open; a repeat show() on a visible frame keeps what was painted', () => {
    // WRONG IMPL KILLED: a frame that opens on Party (KeyB would show the party first, against
    // CTL8B.4: the first paint only comes with the first button press); an opening that needs a
    // paint to happen first; a reopen that keeps the last visit's tab, cursor or open sheet (the
    // frame would reopen over a sheet the screen state has already forgotten); and the opposite
    // over-correction, a show() that resets the paint every time it is called (main.ts calls
    // show() on an already-open frame from several paths, and each call would throw the player's
    // tab away).
    const expectStorage = (m: { parent: HTMLElement; root: HTMLElement }, when: string): void => {
      expect(c8bSelected(m.root), `${when}: the Storage tab is selected`).toEqual([
        'false',
        'true',
      ]);
      expect(c8bHidden(partyGridOf(m.parent), m.root), `${when}: the Party panel is hidden`).toBe(
        true,
      );
      expect(c8bHidden(boxGridOf(m.parent), m.root), `${when}: the Storage panel shows`).toBe(
        false,
      );
      const marked = c8bMarked(m.root);
      expect(marked, `${when}: one card marked`).toHaveLength(1);
      expect((marked[0] as HTMLElement).dataset.navKey, `${when}: the first storage card`).toBe(
        '200',
      );
    };

    // Lists drawn, then shown: no paint at all.
    const a = c8bMount();
    a.view.refresh(c8bParty(), c8bBox());
    a.view.show();
    expectStorage(a, 'refresh then show');

    // Shown, then the lists arrive.
    const b = c8bMount();
    b.view.show();
    b.view.refresh(c8bParty(), c8bBox());
    expectStorage(b, 'show then refresh');

    // A Party paint with the sheet open, then hide and show again.
    const c = c8bOpen();
    c.view.paint(
      c8bPaint({
        tab: 'party',
        activeKey: '101',
        sheet: c8bSheet(C8B_MOSS, 'move'),
      }),
    );
    expect(c8bSelected(c.root), 'fixture: Party was painted').toEqual(['true', 'false']);
    const list = c.root.querySelector<HTMLElement>('[role="listbox"]') as HTMLElement;
    expect(c8bHidden(list, c.root), 'fixture: the sheet was showing').toBe(false);
    c.view.hide();
    c.view.show();
    expectStorage(c, 'hide then show');
    expect(c8bHidden(list, c.root), 'the old sheet is not showing after a reopen').toBe(true);
    expect(c8bShownText(c.parent, c.root, 'Mossling'), 'nor is its name').toEqual([]);

    // A repeat show() on a visible frame keeps the paint.
    const d = c8bOpen();
    d.view.paint(c8bPaint({ tab: 'party', activeKey: '101' }));
    d.view.show();
    expect(c8bSelected(d.root), 'a repeat show() keeps the painted tab').toEqual(['true', 'false']);
    expect((c8bMarked(d.root)[0] as HTMLElement).dataset.navKey, 'and the cursor').toBe('101');
  });

  it('every string the Monsters paint writes is resolver output: under «key» sentinels the tabs, the sheet rows, the typing row`s label and the Move lines read their catalog keys and no English roster word appears outside a sentinel', () => {
    // WRONG IMPL KILLED: a tab, sheet row, label or feedback line written from a literal (it would
    // read English in a French boot; the roster scan names the word), a label under the wrong
    // key, and a forged «...» span. The roster and the id set are the m24s4 BX ones, extended by
    // ctl-8b's seven ids. Mounted, hidden and empty: every string below is written under the mocks.
    const { view, root } = c8bMount();
    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      vi.mocked(i18nTf).mockImplementation(
        (key: string, params: unknown) => `«${key}|${JSON.stringify(params)}»`,
      );
      view.refresh(c8bParty(), c8bBox());
      view.show();
      view.paint(
        c8bPaint({
          tab: 'party',
          activeKey: '100',
          sheet: c8bSheet(C8B_KIP, 'nickname'),
          nickname: { card: C8B_KIP, edit: 1 },
          feedback: { kind: 'movedToParty' },
        }),
      );
      const first = m24s4BxWalkSubtree(root);
      m24s4BxAssertNoRosterWord(first, 'tabs, sheet, typing row and a Move line');
      const joined = first.join('\n');
      for (const key of [
        'box.tab.party',
        'box.tab.storage',
        'box.sheet.summary',
        // INTENTIONAL CHANGE (ctl-8c): the sheet's three new rows.
        'box.sheet.care',
        'box.sheet.feed',
        'box.sheet.evolve',
        'box.sheet.nickname',
        'box.sheet.move',
        'box.rename.prompt',
        'box.feedback.movedToParty',
      ]) {
        expect(joined, `«${key}» is rendered`).toContain(`«${key}»`);
      }

      view.paint(c8bPaint({ tab: 'storage', activeKey: '200', feedback: { kind: 'movedToBox' } }));
      const second = m24s4BxWalkSubtree(root);
      m24s4BxAssertNoRosterWord(second, 'the other Move line');
      expect(second.join('\n')).toContain('«box.feedback.movedToBox»');

      view.paint(c8bPaint({ tab: 'storage', activeKey: '200', summary: C8B_EMBER }));
      m24s4BxAssertNoRosterWord(m24s4BxWalkSubtree(root), 'the summary pane');
    } finally {
      vi.mocked(i18nT).mockRestore();
      vi.mocked(i18nTf).mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// ctl-8b round 2: gaps a red-team found in the cases above. These cases carry no CTL8B-n tag
// (each tag stays in exactly one case); every title starts 'ctl-8b gap:'.
// ---------------------------------------------------------------------------
describe('BoxView ctl-8b gap: commit, reopen, live cards and the cursor outline', () => {
  const c8bClosed = (commit: NicknameCommit | null): MonstersPaint =>
    c8bPaint({
      tab: 'party',
      activeKey: '100',
      sheet: c8bSheet(C8B_KIP, 'nickname'),
      commit,
    });
  const c8bType = (root: Element, text: string): void => {
    const field = c8bInput(root) as HTMLInputElement;
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const c8bStats = (card: MonsterCardViewModel): string =>
    i18nTf('box.card.stats', {
      species: card.speciesName,
      level: card.level,
      current: card.currentHp,
      max: card.statHp,
      percent: card.hpPercent,
    });

  it('ctl-8b gap: a field left exactly as the open prefilled it sends nothing even when the token`s current differs (a batch renamed the monster while the row was open); a text that differs from both the prefill and the current is sent once', async () => {
    // WRONG IMPL KILLED: a skip that compares the field only with the token's `current` (the
    // untouched field 'Kip' differs from the batch's 'Max', so the commit renames the monster
    // back to the name it had when the row opened, reverting the batch's rename), a skip that
    // never sends, and a skip that drops everything once the field is untouched OR different
    // (the typed 'Zed' must still go). The empty prefill (a card with no nickname) is covered
    // too: an untouched empty field is "unchanged", never a rename to ''.
    const { view, root, callbacks } = c8bOpen();
    await s4FlushMacrotask();
    const sent = callbacks.onSetNickname;

    // Untouched: prefilled 'Kip', the token says a batch made it 'Max'.
    view.paint(c8bRow(C8B_KIP, 1));
    expect((c8bInput(root) as HTMLInputElement).value, 'fixture: prefilled').toBe('Kip');
    view.paint(c8bClosed({ monsterId: 100n, current: 'Max' }));
    expect(
      sent,
      'an untouched field is never sent, whatever the live nickname',
    ).not.toHaveBeenCalled();

    // The existing rule still holds: typed text equal to the live nickname is not sent.
    view.paint(c8bRow(C8B_KIP, 2));
    c8bType(root, 'Pip');
    view.paint(c8bClosed({ monsterId: 100n, current: 'Pip' }));
    expect(sent, 'text equal to current: not sent').not.toHaveBeenCalled();

    // A card with no nickname, the field untouched (empty), a batch named it 'Zap'.
    view.paint(c8bRow(C8B_MOSS, 3));
    expect((c8bInput(root) as HTMLInputElement).value, 'fixture: empty prefill').toBe('');
    view.paint(
      c8bPaint({
        tab: 'party',
        activeKey: '101',
        sheet: c8bSheet(C8B_MOSS, 'nickname'),
        commit: { monsterId: 101n, current: 'Zap' },
      }),
    );
    expect(sent, 'an untouched empty field is not sent either').not.toHaveBeenCalled();

    // Typed text that differs from the prefill and from the live nickname is sent, once.
    view.paint(c8bRow(C8B_KIP, 4));
    c8bType(root, 'Zed');
    const token: NicknameCommit = { monsterId: 100n, current: 'Max' };
    view.paint(c8bClosed(token));
    expect(sent, 'the typed text goes').toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith(100n, 'Zed');
    view.paint(c8bClosed(token));
    view.refresh(c8bParty(), c8bBox());
    expect(sent, 'and only once').toHaveBeenCalledTimes(1);
  });

  it('ctl-8b gap: a reopened frame re-prefills and refocuses the field for an edit number the last visit already used (the host restarts numbering at 1)', async () => {
    // WRONG IMPL KILLED: a show() that leaves the last-seen edit number alone: the next visit's
    // first row (edit 1 again) reads as "the same open", keeps the last visit's typed text and
    // never takes focus. Focus is read synchronously: show()'s deferred anchor focus has not run.
    const { view, root } = c8bOpen();
    await s4FlushMacrotask();
    view.paint(c8bRow(C8B_KIP, 1));
    const field = c8bInput(root) as HTMLInputElement;
    expect(document.activeElement, 'fixture: the first open focused the field').toBe(field);
    field.value = 'Zed';
    field.blur();
    expect(document.activeElement, 'fixture: blurred').not.toBe(field);

    view.hide();
    view.show();
    view.refresh(c8bParty(), c8bBox());
    view.paint(c8bRow(C8B_KIP, 1));
    expect((c8bInput(root) as HTMLInputElement).value, 'prefilled again, not "Zed"').toBe('Kip');
    expect(document.activeElement, 'and focused').toBe(c8bInput(root));
  });

  it('ctl-8b gap: a summary and a sheet show the monster as the last refresh() has it, not as the kept paint names it: a batch that heals or renames it changes the card with no new paint', () => {
    // WRONG IMPL KILLED: a view that draws the paint's own (stale) card: the summary would keep
    // the old HP and the sheet the old name until the player pressed another button.
    const healedMoss = makeCard({ ...C8B_MOSS, currentHp: 20, hpPercent: 100 });
    const oldStats = c8bStats(C8B_MOSS);
    const newStats = c8bStats(healedMoss);
    expect(newStats, 'fixture: the heal changes the stats text').not.toBe(oldStats);

    const a = c8bOpen();
    a.view.paint(c8bPaint({ tab: 'party', activeKey: '101', summary: C8B_MOSS }));
    expect(c8bShownText(a.parent, a.root, oldStats), 'fixture: the old stats show').not.toEqual([]);
    a.view.refresh([C8B_KIP, healedMoss, null, null, null, null], c8bBox());
    expect(c8bShownText(a.parent, a.root, newStats), 'the summary shows the healed HP').not.toEqual(
      [],
    );
    expect(c8bShownText(a.parent, a.root, oldStats), 'and not the old one').toEqual([]);
    expect(c8bShownText(a.parent, a.root, 'Mossling'), 'still the same monster').not.toEqual([]);

    const zip = makeCard({ ...C8B_KIP, nickname: 'Zip' });
    const b = c8bOpen();
    b.view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'summary') }));
    expect(c8bShownText(b.parent, b.root, 'Kip'), 'fixture: the sheet names Kip').not.toEqual([]);
    b.view.refresh([zip, C8B_MOSS, null, null, null, null], c8bBox());
    expect(c8bShownText(b.parent, b.root, 'Zip'), 'the sheet shows the new name').not.toEqual([]);
    expect(c8bShownText(b.parent, b.root, 'Kip'), 'and not the old one').toEqual([]);
  });

  it('ctl-8b gap: the cursor outline moves with the cursor: it is cleared from the card the cursor left and from every card of a tab that is no longer painted', () => {
    // WRONG IMPL KILLED: an outline that is only ever set (every card the cursor has visited keeps
    // its white frame: the player sees several "selected" cards, and a card of the other tab keeps
    // one), and one that is never set (the cursor would be told by colour alone).
    const { parent, view } = c8bOpen();
    const party = partyGridOf(parent);
    const box = boxGridOf(parent);
    const cardIn = (grid: Element, key: string): HTMLElement => {
      const found = c8bCards(grid).find((el) => el.dataset.navKey === key);
      expect(found, `precondition: a card keyed ${key}`).toBeDefined();
      return found as HTMLElement;
    };

    view.paint(c8bPaint({ tab: 'storage', activeKey: '300' }));
    expect(cardIn(box, '300').style.outline, 'the cursor card is outlined').not.toBe('');
    view.paint(c8bPaint({ tab: 'storage', activeKey: '400' }));
    expect(cardIn(box, '300').style.outline, 'the card the cursor left is cleared').toBe('');
    expect(cardIn(box, '400').style.outline, 'the new cursor card is outlined').not.toBe('');

    view.paint(c8bPaint({ tab: 'party', activeKey: '100' }));
    expect(cardIn(party, '100').style.outline, 'the Party cursor card is outlined').not.toBe('');
    for (const el of c8bCards(box)) {
      expect(el.style.outline, `storage card ${el.dataset.navKey} has no outline`).toBe('');
    }
    expect(cardIn(party, '101').style.outline, 'a Party card off the cursor has none').toBe('');
  });
});

describe('BoxView ctl-8b gap: view guards (repaint inside a callback, focus, scrolling)', () => {
  it('ctl-8b gap: when onSetNickname repaints with a DIFFERENT paint, the frame shows that nested paint after the outer paint returns', async () => {
    // WRONG IMPL KILLED: an #apply that carries on with its own paint after the commit callback
    // (the outer paint is drawn over the nested one: the DOM shows Party and an open sheet while
    // the kept paint, and the screen's state, say Storage and no sheet).
    let repaint: (() => void) | undefined;
    const { view, root, callbacks } = c8bOpen({
      onSetNickname: vi.fn(() => {
        repaint?.();
      }),
    });
    await s4FlushMacrotask();
    view.paint(c8bRow(C8B_KIP, 1));
    (c8bInput(root) as HTMLInputElement).value = 'Zed';
    repaint = () => view.paint(c8bPaint({ tab: 'storage', activeKey: '400' }));

    view.paint(
      c8bPaint({
        tab: 'party',
        activeKey: '100',
        sheet: c8bSheet(C8B_KIP, 'nickname'),
        commit: { monsterId: 100n, current: 'Kip' },
      }),
    );
    expect(callbacks.onSetNickname, 'fixture: the callback ran, once').toHaveBeenCalledTimes(1);
    expect(c8bSelected(root), 'the nested paint`s tab: Storage').toEqual(['false', 'true']);
    const marked = c8bMarked(root);
    expect(marked, 'one card marked').toHaveLength(1);
    expect((marked[0] as HTMLElement).dataset.navKey, 'the nested paint`s cursor').toBe('400');
    expect(
      c8bHidden(root.querySelector('[role="listbox"]') as HTMLElement, root),
      'the nested paint has no sheet',
    ).toBe(true);
    expect(c8bShownText(root, root, 'Kip'), 'and no sheet name is left showing').toEqual([]);
  });

  it('ctl-8b gap: a hidden frame never takes focus from an element outside it, and a shown frame hands focus stranded in a hidden panel to the title anchor', async () => {
    // WRONG IMPL KILLED: a paint or refresh that focuses the title anchor unconditionally (a
    // batch arriving while the frame is closed would pull focus out of the world), one that
    // rescues focus without the frame being visible (a closed frame grabs focus from a button the
    // player is on), and a shown frame with no rescue (focus stays on a To Box button of a panel
    // the paint just hid: the next key heals focus to the world, out of the frame).
    const outside = s4OutsideSentinel();

    // Mounted, never shown.
    const never = c8bMount();
    outside.focus();
    expect(document.activeElement, 'fixture: focus is outside').toBe(outside);
    never.view.refresh(c8bParty(), c8bBox());
    never.view.paint(c8bPaint({ tab: 'party', activeKey: '100' }));
    never.view.paint(
      c8bPaint({ tab: 'storage', activeKey: '300', sheet: c8bSheet(C8B_DUSK, 'summary') }),
    );
    never.view.refresh(c8bParty(), c8bBox());
    expect(document.activeElement, 'a never-shown frame leaves focus alone').toBe(outside);

    // Shown, then hidden.
    const shown = c8bOpen();
    await s4FlushMacrotask();
    shown.view.hide();
    await s4FlushMacrotask();
    outside.focus();
    expect(document.activeElement, 'fixture: focus is outside again').toBe(outside);
    shown.view.paint(c8bPaint({ tab: 'party', activeKey: '101' }));
    shown.view.refresh(c8bParty(), c8bBox());
    shown.view.paint(c8bPaint({ tab: 'storage', activeKey: '200' }));
    shown.view.refresh(c8bParty(), c8bBox());
    expect(document.activeElement, 'a hidden frame leaves focus alone').toBe(outside);

    // A hidden frame also leaves focus on a control INSIDE it (on a part the paint then hides).
    shown.view.paint(c8bPaint({ tab: 'party', activeKey: '100' }));
    const inside = [...partyGridOf(shown.parent).querySelectorAll('button')].find(
      (b) => b.textContent === i18nT('box.card.toBox'),
    ) as HTMLButtonElement;
    expect(inside, 'precondition: a To Box button in the Party panel').toBeDefined();
    inside.focus();
    expect(document.activeElement, 'fixture: focus is on the To Box button').toBe(inside);
    shown.view.paint(c8bPaint({ tab: 'storage', activeKey: '200' }));
    expect(document.activeElement, 'a hidden frame does not rescue focus').toBe(inside);

    // Shown: focus on a To Box button of the Party panel, then Storage is painted.
    const open = c8bOpen();
    await s4FlushMacrotask();
    open.view.paint(c8bPaint({ tab: 'party', activeKey: '100' }));
    const toBox = [...partyGridOf(open.parent).querySelectorAll('button')].find(
      (b) => b.textContent === i18nT('box.card.toBox'),
    ) as HTMLButtonElement;
    expect(toBox, 'precondition: a To Box button in the Party panel').toBeDefined();
    toBox.focus();
    expect(document.activeElement, 'fixture: the button is focused').toBe(toBox);
    open.view.paint(c8bPaint({ tab: 'storage', activeKey: '200' }));
    expect(c8bHidden(toBox, open.root), 'fixture: the Party panel is hidden now').toBe(true);
    expect(document.activeElement, 'focus moves to the title anchor').toBe(c8bAnchor(open.root));
  });

  it('ctl-8b gap: the cursor card is scrolled into view once per cursor move, not on a repeat paint or a refresh(), and again when the frame is reopened on the same card', () => {
    // WRONG IMPL KILLED: a scroll on every paint or every refresh() (the list would jump back to
    // the cursor under a player who is scrolling it, at batch rate), no scroll at all, a scroll
    // keyed on the key alone (a new tab with the same key would not scroll), and a scrolled-key
    // memory that survives a reopen (the frame reopens on the card it was last scrolled to: the
    // opening card is already "seen", the box shows its top while the cursor sits off screen).
    const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    const scrolled: string[] = [];
    const spy = vi.fn(function (this: HTMLElement) {
      scrolled.push(this.dataset.navKey ?? '');
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      writable: true,
      value: spy,
    });
    try {
      const { view } = c8bOpen();
      spy.mockClear();
      scrolled.length = 0;

      view.paint(c8bPaint({ tab: 'storage', activeKey: '300' }));
      expect(scrolled, 'a new key scrolls once').toEqual(['300']);
      view.paint(c8bPaint({ tab: 'storage', activeKey: '300' }));
      view.paint(c8bPaint({ tab: 'storage', activeKey: '300', feedback: { kind: 'movedToBox' } }));
      view.refresh(c8bParty(), c8bBox());
      view.refresh(c8bParty(), c8bBox());
      expect(scrolled, 'the same key, a repaint and a refresh() never scroll again').toEqual([
        '300',
      ]);

      view.paint(c8bPaint({ tab: 'storage', activeKey: '400' }));
      expect(scrolled, 'a new key scrolls once more').toEqual(['300', '400']);
      view.paint(c8bPaint({ tab: 'party', activeKey: '100' }));
      expect(scrolled, 'a new tab scrolls to its cursor').toEqual(['300', '400', '100']);

      // The cursor ends on the card the frame opens on (the first Storage card), then a reopen.
      view.paint(c8bPaint({ tab: 'storage', activeKey: '200' }));
      expect(
        scrolled[scrolled.length - 1],
        'fixture: the opening card was the last one scrolled to',
      ).toBe('200');
      spy.mockClear();
      scrolled.length = 0;
      view.hide();
      view.show();
      expect(scrolled, 'the reopened frame scrolls its opening card again').toEqual(['200']);
      view.refresh(c8bParty(), c8bBox());
      expect(scrolled, 'and a refresh() after that does not').toEqual(['200']);
    } finally {
      if (own === undefined) {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView;
      } else {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', own);
      }
    }
  });
});

// =============================================================================
// ctl-8c (CTL8C.1): Care, Feed… and Evolve… on the sheet, the food list, the Evolve list and its
// Yes / No confirm, and the "Fed {name}" line, painted by `BoxView.paint(MonstersPaint)`.
//
// Located by the ids the nav kit writes (`{frame}-root-{key}`: frames monstersSheet, monstersFeed,
// monstersEvolve, monstersConfirm) and by `#monsters-evolve-question`, never by index. "Hidden" is
// read as above (inline display:none on the element or an ancestor below the root); a hidden part
// must also be EMPTY of text, because the e2e helpers read the root's textContent, hidden
// descendants included.
// =============================================================================

/** U+2014 EM DASH (the ready line) and U+2192 RIGHTWARDS ARROW (the path heading), by code point. */
const C8C_EM_DASH = String.fromCharCode(0x2014);
const C8C_ARROW = String.fromCharCode(0x2192);

/** One path row of the Evolve list's view model (the list paints no gate rows). */
function c8cPath(
  edgeId: number,
  toSpecies: number,
  toSpeciesName: string,
  unmetReason: string | null,
): EvolutionPathViewModel {
  return { edgeId, toSpecies, toSpeciesName, met: unmetReason === null, unmetReason, gates: [] };
}

const C8C_P10 = c8cPath(10, 4, 'Tidepup', 'requires level 50');
const C8C_P20 = c8cPath(20, 3, 'Duskling', null);
const C8C_P30 = c8cPath(30, 2, 'Emberfang', null);

/** Kip with two met paths (20 and 30: the choices) and an unmet one (10). */
const C8C_TWO_CHOICES: EvolutionMonsterViewModel = {
  monsterId: 100n,
  speciesName: 'Sproutle',
  nickname: 'Kip',
  level: 5,
  tier: 0,
  trustTier: 'Neutral',
  qualityTimeTier: 0,
  nutritionPct: 0,
  paths: [C8C_P10, C8C_P20, C8C_P30],
  eligibleCount: 2,
  choices: [C8C_P20, C8C_P30],
  readyPathName: null,
};

/** Kip with exactly one met path (20: the server applies it, so it is no choice) and an unmet one. */
const C8C_ONE_READY: EvolutionMonsterViewModel = {
  ...C8C_TWO_CHOICES,
  paths: [C8C_P10, C8C_P20],
  eligibleCount: 1,
  choices: [],
  readyPathName: 'Duskling',
};

/** The element of id `id` under `root`; it must exist. */
function c8cById(root: Element, id: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[id="${id}"]`);
  expect(el, `precondition: #${id} is rendered`).not.toBeNull();
  return el as HTMLElement;
}

/** The listbox holding the row of id `rowId`. */
function c8cListOf(root: Element, rowId: string): HTMLElement {
  const list = c8cById(root, rowId).closest<HTMLElement>('[role="listbox"]');
  expect(list, `#${rowId} sits in a listbox`).not.toBeNull();
  return list as HTMLElement;
}

const c8cOptions = (list: Element): HTMLElement[] => [
  ...list.querySelectorAll<HTMLElement>('[role="option"]'),
];
const c8cActiveIds = (list: Element): string[] =>
  c8cOptions(list)
    .filter((row) => row.classList.contains('is-active'))
    .map((row) => row.id);

/** `el` comes before the hint and both panels in the DOM and is inside none of them (typing
 *  mode's Escape focuses the frame's first enabled non-text control: never a card's button). */
function c8cBeforeHintAndPanels(
  parent: HTMLElement,
  root: HTMLElement,
  el: Element,
  name: string,
): void {
  const hint = root.querySelector<HTMLElement>(BOX_PARTY_HINT_SELECTOR) as HTMLElement;
  const anchors: ReadonlyArray<readonly [string, HTMLElement]> = [
    ['the hint', hint],
    ['the Party panel', partyGridOf(parent)],
    ['the Box panel', boxGridOf(parent)],
  ];
  for (const [label, anchor] of anchors) {
    expect(
      anchor.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING,
      `${name} comes before ${label}`,
    ).not.toBe(0);
    expect(anchor.contains(el), `${name} is not inside ${label}`).toBe(false);
  }
}

/** Every `«key|<json>»` span's parsed params, in text order. */
function c8cSpanParams(joined: string, key: string): unknown[] {
  const head = `«${key}|`;
  const out: unknown[] = [];
  let from = 0;
  for (;;) {
    const open = joined.indexOf(head, from);
    if (open === -1) return out;
    const close = joined.indexOf('»', open);
    out.push(JSON.parse(joined.slice(open + head.length, close)));
    from = close + 1;
  }
}

describe('BoxView ctl-8c: Care, Feed and Evolve on the sheet (CTL8C.1)', () => {
  it('CTL8C-1-VIEW-SHEET-ROWS: a sheet paint lists Summary, Care, Feed, Evolve, Nickname, Move (catalog labels, rows monstersSheet-root-<action>); canFeed false marks the Feed row aria-disabled and .is-disabled and follows its label with the catalog no-food reason, canEvolve false does the same for Evolve with the no-paths reason; a disabled row can be the active row; enabling clears the marks and the reasons; a refresh keeps them', () => {
    // WRONG IMPL KILLED: the new rows missing, labelled from literals, or in the ctl-8b order plus
    // three; a disabled row dropped (the player cannot see why) or marked by colour alone (no
    // aria-disabled: a screen reader hears an action that does nothing); a reason from a literal,
    // the wrong reason on the wrong row, or a reason that stays after the row is enabled again (a
    // repaint that only ever adds); a disabled row that cannot carry the cursor; flags read from
    // the wrong field (canFeed disabling Evolve).
    const { view, root } = c8bOpen();
    const ACTIONS = ['summary', 'care', 'feed', 'evolve', 'nickname', 'move'];
    const row = (action: string): HTMLElement => c8cById(root, `monstersSheet-root-${action}`);
    const paintSheet = (action: SheetAction, canFeed: boolean, canEvolve: boolean): void => {
      view.paint(
        c8bPaint({
          tab: 'party',
          activeKey: '100',
          sheet: c8bSheet(C8B_KIP, action, canFeed, canEvolve),
        }),
      );
    };
    const expectEnabled = (action: string, label: string, when: string): void => {
      expect(row(action).getAttribute('aria-disabled'), `${when}: ${action} enabled`).toBeNull();
      expect(row(action).classList.contains('is-disabled'), `${when}: ${action} enabled`).toBe(
        false,
      );
      expect(row(action).textContent, `${when}: ${action} reads its bare label`).toBe(label);
    };
    const expectDisabled = (action: string, label: string, reason: string, when: string): void => {
      expect(row(action).getAttribute('aria-disabled'), `${when}: ${action} aria-disabled`).toBe(
        'true',
      );
      expect(row(action).classList.contains('is-disabled'), `${when}: ${action} is-disabled`).toBe(
        true,
      );
      const text = row(action).textContent ?? '';
      expect(text.startsWith(label), `${when}: ${action} reads its label first: ${text}`).toBe(
        true,
      );
      expect(text.endsWith(reason), `${when}: ${action} then its reason: ${text}`).toBe(true);
      expect(
        text.length - label.length - reason.length,
        `${when}: ${action} carries nothing else`,
      ).toBeLessThanOrEqual(3);
    };

    paintSheet('care', true, true);
    const list = c8cListOf(root, 'monstersSheet-root-care');
    expect(
      c8cOptions(list).map((r) => r.id),
      'six rows, keyed by action',
    ).toEqual(ACTIONS.map((a) => `monstersSheet-root-${a}`));
    expect(
      c8cOptions(list).map((r) => r.textContent),
      'the catalog labels',
    ).toEqual([
      i18nT('box.sheet.summary'),
      i18nT('box.sheet.care'),
      i18nT('box.sheet.feed'),
      i18nT('box.sheet.evolve'),
      i18nT('box.sheet.nickname'),
      i18nT('box.sheet.move'),
    ]);
    expect(
      c8cOptions(list).map((r) => r.textContent),
      'English bytes',
    ).toEqual([
      'Summary',
      'Care',
      `Feed${C8C_ELLIPSIS}`,
      `Evolve${C8C_ELLIPSIS}`,
      'Nickname',
      'Move',
    ]);
    expect(
      c8cOptions(list).map((r) => r.getAttribute('aria-disabled')),
      'all enabled',
    ).toEqual([null, null, null, null, null, null]);
    expect(c8cActiveIds(list), 'Care is the active row').toEqual(['monstersSheet-root-care']);

    // No food.
    paintSheet('feed', false, true);
    expectDisabled('feed', i18nT('box.sheet.feed'), i18nT('box.sheet.feedNone'), 'no food');
    expect(row('feed').textContent ?? '', 'English bytes').toMatch(/^Feed.*No food$/);
    expectEnabled('evolve', i18nT('box.sheet.evolve'), 'no food');
    for (const action of ['summary', 'care', 'nickname', 'move']) {
      expect(row(action).getAttribute('aria-disabled'), `no food: ${action}`).toBeNull();
    }
    expect(c8cActiveIds(list), 'a disabled row can be the active row').toEqual([
      'monstersSheet-root-feed',
    ]);

    // No evolution path.
    paintSheet('evolve', true, false);
    expectDisabled('evolve', i18nT('box.sheet.evolve'), i18nT('evolution.card.noPaths'), 'no path');
    expect(row('evolve').textContent ?? '', 'English bytes').toMatch(
      /^Evolve.*No evolution paths\.$/,
    );
    expectEnabled('feed', i18nT('box.sheet.feed'), 'no path: the no-food reason is gone');

    // Both, then both enabled again.
    paintSheet('summary', false, false);
    expectDisabled('feed', i18nT('box.sheet.feed'), i18nT('box.sheet.feedNone'), 'both');
    expectDisabled('evolve', i18nT('box.sheet.evolve'), i18nT('evolution.card.noPaths'), 'both');
    paintSheet('summary', true, true);
    expectEnabled('feed', i18nT('box.sheet.feed'), 'enabled again');
    expectEnabled('evolve', i18nT('box.sheet.evolve'), 'enabled again');

    // A batch render re-applies the kept paint.
    paintSheet('feed', false, true);
    view.refresh(c8bParty(), c8bBox());
    expectDisabled('feed', i18nT('box.sheet.feed'), i18nT('box.sheet.feedNone'), 'after refresh');
  });

  it('CTL8C-1-VIEW-FEED: a feed paint shows a food list (rows monstersFeed-root-<itemId>) reading the catalog food row for each food in order, the painted key active, the sheet still shown, before the hint and both panels; names are text; a null feed hides the list by inline display:none and empties it', () => {
    // WRONG IMPL KILLED: no list; rows keyed by index (the screen's cursor key would name no row);
    // a row text from a literal, without the count, or with the wrong food's count; the sheet
    // hidden under the list (its active row, Feed…, is the context); a list placed after the panels
    // (typing mode's Escape would land on a card's button); a name parsed as HTML; a stale row kept
    // after its food is gone; a null feed that leaves the list showing, or hidden but still holding
    // "Bait (x3)" (the e2e text scans read hidden text).
    const { parent, view, root } = c8bOpen();
    const BAIT_ROW: FoodVm = { itemId: 7, name: 'Bait', count: 3 };
    const GLOW_ROW: FoodVm = { itemId: 40, name: 'Glowberry', count: 12 };
    const feedPaint = (foods: readonly FoodVm[], activeKey: string | null): MonstersPaint =>
      c8bPaint({
        tab: 'party',
        activeKey: '100',
        sheet: c8bSheet(C8B_KIP, 'feed'),
        feed: { foods, activeKey },
      });

    view.paint(feedPaint([BAIT_ROW, GLOW_ROW], '40'));
    const list = c8cListOf(root, 'monstersFeed-root-7');
    const sheetList = c8cListOf(root, 'monstersSheet-root-feed');
    expect(list, 'the food list is its own list, not the sheet').not.toBe(sheetList);
    expect(c8cOptions(list).map((r) => r.id)).toEqual([
      'monstersFeed-root-7',
      'monstersFeed-root-40',
    ]);
    expect(c8cOptions(list).map((r) => r.textContent)).toEqual([
      i18nTf('box.feed.item', { name: 'Bait', count: 3 }),
      i18nTf('box.feed.item', { name: 'Glowberry', count: 12 }),
    ]);
    expect(
      c8cOptions(list).map((r) => r.textContent),
      'English bytes',
    ).toEqual(['Bait (x3)', 'Glowberry (x12)']);
    expect(c8cActiveIds(list), 'the painted key').toEqual(['monstersFeed-root-40']);
    expect(c8cOptions(list).map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    expect(c8cOptions(list).map((r) => r.getAttribute('aria-disabled'))).toEqual([null, null]);
    expect(c8bHidden(list, root), 'the list shows').toBe(false);
    expect(c8bHidden(sheetList, root), 'the sheet stays shown under it').toBe(false);
    c8cBeforeHintAndPanels(parent, root, list, 'the food list');

    // The cursor moves; a batch render keeps the list; a new count is repainted.
    view.paint(feedPaint([BAIT_ROW, GLOW_ROW], '7'));
    expect(c8cActiveIds(list)).toEqual(['monstersFeed-root-7']);
    view.refresh(c8bParty(), c8bBox());
    expect(c8cOptions(list).map((r) => r.textContent)).toEqual(['Bait (x3)', 'Glowberry (x12)']);
    expect(c8cActiveIds(list)).toEqual(['monstersFeed-root-7']);
    view.paint(feedPaint([{ itemId: 7, name: 'Bait', count: 2 }, GLOW_ROW], '7'));
    expect(c8cById(root, 'monstersFeed-root-7').textContent).toBe('Bait (x2)');

    // A name is text, never markup; a food that is gone leaves no row.
    view.paint(feedPaint([{ itemId: 9, name: '<b>Bait</b>', count: 1 }], '9'));
    expect(list.querySelector('b'), 'no element made from a name').toBeNull();
    expect(c8cById(root, 'monstersFeed-root-9').textContent).toBe('<b>Bait</b> (x1)');
    expect(root.querySelectorAll('[id="monstersFeed-root-7"]'), 'the gone food`s row').toHaveLength(
      0,
    );

    // A null feed: hidden by inline display and emptied, the node kept.
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'feed') }));
    expect(root.contains(list), 'the list node is kept').toBe(true);
    expect(c8bHidden(list, root), 'hidden by inline display:none').toBe(true);
    expect(list.textContent, 'and empty of text').toBe('');
    expect(root.querySelectorAll('[id^="monstersFeed-root-"]'), 'no food row left').toHaveLength(0);
  });

  it('CTL8C-1-VIEW-EVOLVE: an evolve paint lists every path (rows monstersEvolve-root-<edgeId>) with its catalog heading and a status line (the raw unmet reason, the catalog ready line for a met path that is no choice, the catalog all-met line for a choice), only choices enabled, no evo-ready-note or evo-choice testid; a confirm paint asks the catalog question in #monsters-evolve-question over a Yes / No listbox labelled by it, the painted answer active; both sit before the hint and panels; null hides and empties them, focus left in them goes to the title anchor, and a reopen shows neither', async () => {
    // WRONG IMPL KILLED: a list of the met paths only; rows keyed by index or by species; a status
    // line from a literal, the same line for every path, an unmet reason re-worded (it must match
    // the server's reject message), a met-but-not-choice path offered as a choice (enabled) or
    // described as "all met" (the server applies it itself); the evolution view's evo-ready-note /
    // evo-choice testids reused here (the e2e locators would hit two elements); a confirm question
    // from a literal, naming the wrong monster or species, or parsed as HTML; an unlabelled Yes /
    // No list; Yes and No both or neither active; parts placed after the panels; a hidden confirm
    // still holding its question text, or holding the focus (the next key would leave the frame);
    // a reopen that shows the last visit's confirm.
    const { parent, view, root } = c8bOpen();
    await s4FlushMacrotask();
    const evolvePaint = (mon: EvolutionMonsterViewModel, activeKey: string | null): MonstersPaint =>
      c8bPaint({
        tab: 'party',
        activeKey: '100',
        sheet: c8bSheet(C8B_KIP, 'evolve'),
        evolve: { mon, activeKey },
      });
    const text = (edgeId: number): string =>
      c8cById(root, `monstersEvolve-root-${edgeId}`).textContent ?? '';

    view.paint(evolvePaint(C8C_TWO_CHOICES, '30'));
    const list = c8cListOf(root, 'monstersEvolve-root-10');
    expect(list, 'its own list, not the sheet').not.toBe(
      c8cListOf(root, 'monstersSheet-root-evolve'),
    );
    expect(
      c8cOptions(list).map((r) => r.id),
      'every path, by edge id',
    ).toEqual(['monstersEvolve-root-10', 'monstersEvolve-root-20', 'monstersEvolve-root-30']);
    expect(text(10)).toContain(i18nTf('evolution.path.heading', { species: 'Tidepup' }));
    expect(text(10), 'an unmet path: its first unmet requirement, raw').toContain(
      'requires level 50',
    );
    expect(text(10), 'an unmet path is not all met').not.toContain(i18nT('evolution.path.allMet'));
    expect(text(20)).toContain(i18nTf('evolution.path.heading', { species: 'Duskling' }));
    expect(text(20), 'a choice: all met').toContain(i18nT('evolution.path.allMet'));
    expect(text(30)).toContain(i18nTf('evolution.path.heading', { species: 'Emberfang' }));
    expect(text(30)).toContain(i18nT('evolution.path.allMet'));
    expect(text(20), 'English bytes').toContain(`${C8C_ARROW} Duskling`);
    expect(text(20), 'English bytes').toContain('All requirements met.');
    expect(
      c8cOptions(list).map((r) => r.getAttribute('aria-disabled')),
      'only the choices are enabled',
    ).toEqual(['true', null, null]);
    expect(c8cOptions(list).map((r) => r.classList.contains('is-disabled'))).toEqual([
      true,
      false,
      false,
    ]);
    expect(c8cActiveIds(list), 'the painted key').toEqual(['monstersEvolve-root-30']);
    expect(c8bHidden(list, root)).toBe(false);
    expect(c8bHidden(c8cListOf(root, 'monstersSheet-root-evolve'), root), 'the sheet shows').toBe(
      false,
    );
    c8cBeforeHintAndPanels(parent, root, list, 'the Evolve list');
    expect(list.textContent ?? '', 'no HP-shaped token for the e2e HP scans').not.toContain('HP ');

    // Exactly one met: the ready line, and it is not offered.
    view.paint(evolvePaint(C8C_ONE_READY, '10'));
    expect(c8cOptions(list).map((r) => r.id)).toEqual([
      'monstersEvolve-root-10',
      'monstersEvolve-root-20',
    ]);
    expect(text(20)).toContain(i18nTf('evolution.card.ready', { species: 'Duskling' }));
    expect(text(20), 'English bytes').toContain(
      `Ready ${C8C_EM_DASH} evolves into Duskling on your next action.`,
    );
    expect(text(20), 'the auto-applied path is not "all met"').not.toContain(
      i18nT('evolution.path.allMet'),
    );
    expect(c8cOptions(list).map((r) => r.getAttribute('aria-disabled'))).toEqual(['true', 'true']);

    for (const [mon, key] of [
      [C8C_TWO_CHOICES, '20'],
      [C8C_ONE_READY, '20'],
    ] as const) {
      view.paint(evolvePaint(mon, key));
      expect(
        root.querySelectorAll('[data-testid="evo-ready-note"], [data-testid="evo-choice"]'),
        'the evolution view`s testids are not reused in the box root',
      ).toHaveLength(0);
    }

    // The confirm.
    const confirmPaint = (yes: boolean, name = 'Kip'): MonstersPaint =>
      c8bPaint({
        tab: 'party',
        activeKey: '100',
        sheet: c8bSheet(C8B_KIP, 'evolve'),
        confirm: { name, species: 'Emberfang', yes },
      });
    view.paint(confirmPaint(false));
    const question = c8cById(root, 'monsters-evolve-question');
    expect(question.textContent).toBe(
      i18nTf('box.evolve.confirm', { name: 'Kip', species: 'Emberfang' }),
    );
    expect(question.textContent, 'English bytes').toBe('Evolve Kip into Emberfang?');
    expect(c8bHidden(question, root), 'the question shows').toBe(false);
    const answers = c8cListOf(root, 'monstersConfirm-root-yes');
    expect(c8cListOf(root, 'monstersConfirm-root-no'), 'Yes and No are one list').toBe(answers);
    expect(answers.getAttribute('aria-labelledby'), 'labelled by the question').toBe(
      'monsters-evolve-question',
    );
    expect(
      c8cOptions(answers)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['monstersConfirm-root-no', 'monstersConfirm-root-yes']);
    expect(c8cById(root, 'monstersConfirm-root-yes').textContent).toBe(i18nT('prompt.yes'));
    expect(c8cById(root, 'monstersConfirm-root-no').textContent).toBe(i18nT('prompt.no'));
    expect(c8cById(root, 'monstersConfirm-root-yes').textContent, 'English bytes').toBe('Yes');
    expect(c8cById(root, 'monstersConfirm-root-no').textContent, 'English bytes').toBe('No');
    expect(c8cActiveIds(answers), 'No is painted').toEqual(['monstersConfirm-root-no']);
    expect(c8bHidden(answers, root)).toBe(false);
    c8cBeforeHintAndPanels(parent, root, question, 'the confirm question');
    c8cBeforeHintAndPanels(parent, root, answers, 'the Yes / No list');
    expect(c8bHidden(list, root), 'no evolve paint: the Evolve list is hidden').toBe(true);
    expect(list.textContent, 'and empty').toBe('');
    view.paint(confirmPaint(true));
    expect(c8cActiveIds(answers), 'Yes is painted').toEqual(['monstersConfirm-root-yes']);

    // A nickname is text, never markup.
    view.paint(confirmPaint(false, '<i>Kip</i>'));
    expect(question.querySelector('i'), 'no element made from a nickname').toBeNull();
    expect(question.textContent).toBe('Evolve <i>Kip</i> into Emberfang?');

    // The confirm closes with focus on its list: hidden, emptied, focus on the title anchor.
    answers.focus();
    expect(document.activeElement, 'fixture: focus is on the Yes / No list').toBe(answers);
    view.paint(evolvePaint(C8C_TWO_CHOICES, '30'));
    expect(c8bHidden(question, root), 'the question is hidden').toBe(true);
    expect(question.textContent, 'and empty').toBe('');
    expect(c8bHidden(answers, root), 'the Yes / No list is hidden').toBe(true);
    expect(answers.textContent, 'and empty').toBe('');
    expect(document.activeElement, 'focus goes to the title anchor').toBe(c8bAnchor(root));
    expect(c8bHidden(list, root), 'the Evolve list shows again').toBe(false);

    // A reopened frame shows neither the confirm nor the list.
    view.paint(confirmPaint(false));
    view.hide();
    view.show();
    expect(c8bHidden(question, root), 'reopened: no confirm').toBe(true);
    expect(question.textContent).toBe('');
    expect(c8bHidden(list, root), 'reopened: no Evolve list').toBe(true);
  });

  it('CTL8C-1-VIEW-FED-LINE: a fed paint shows one .mr-frame-feedback[data-feedback="ok"] line reading the catalog fed line for the name the paint carries (not the sheet`s card), with no check mark in the text; the Move lines still read theirs; a null paint clears it', () => {
    // WRONG IMPL KILLED: a fed line from a literal or showing a Move text; one naming the sheet's
    // card or the cursor's monster instead of the fed one; a "✓" typed into the text (the CSS
    // ::before draws it); a line without data-feedback="ok" (unstyled, no check mark); two lines;
    // a name parsed as HTML; a feedback switch that lost the Move lines; a line that survives a
    // null paint.
    const { root, view } = c8bOpen();
    const shownLines = (): HTMLElement[] =>
      [...root.querySelectorAll<HTMLElement>('.mr-frame-feedback')].filter(
        (el) => !c8bHidden(el, root) && (el.textContent ?? '') !== '',
      );
    const onlyLine = (when: string): HTMLElement => {
      const lines = shownLines();
      expect(lines, `${when}: exactly one line`).toHaveLength(1);
      const line = lines[0] as HTMLElement;
      expect(line.getAttribute('data-feedback'), `${when}: an ok line`).toBe('ok');
      return line;
    };

    view.paint(
      c8bPaint({
        tab: 'party',
        activeKey: '101',
        sheet: c8bSheet(C8B_MOSS, 'feed'),
        feedback: { kind: 'fed', name: 'Kip' },
      }),
    );
    let line = onlyLine('fed Kip under Mossling`s sheet');
    expect(line.textContent).toBe(i18nTf('box.feedback.fed', { name: 'Kip' }));
    expect(line.textContent, 'English bytes').toBe('Fed Kip');
    expect(line.textContent ?? '', 'no glyph in the text').not.toContain(CHECK_MARK);

    view.paint(c8bPaint({ feedback: { kind: 'fed', name: 'Mossling' } }));
    expect(onlyLine('fed Mossling').textContent).toBe('Fed Mossling');

    view.paint(c8bPaint({ feedback: { kind: 'movedToParty' } }));
    expect(onlyLine('a Move line').textContent).toBe('Moved to party');

    view.paint(c8bPaint({ feedback: { kind: 'fed', name: '<b>Kip</b>' } }));
    line = onlyLine('a name with markup');
    expect(line.querySelector('b'), 'no element made from a name').toBeNull();
    expect(line.textContent).toBe('Fed <b>Kip</b>');

    view.paint(c8bPaint({ feedback: null }));
    expect(shownLines(), 'a null paint clears the line').toEqual([]);
  });

  it('ctl-8c: under «key» sentinels the new sheet rows and reasons, the food rows, the Evolve list`s heading and status lines, the confirm`s question and options and the fed line read their catalog keys and params, and no English roster word appears outside a sentinel', () => {
    // WRONG IMPL KILLED: any of the new strings written from a literal (it would read English in a
    // French boot: the roster scan names the word), a reason or line under the wrong key, a param
    // dropped or swapped (the food's count, the confirm's monster or species, the fed name), and
    // a forged «...» span. Mounted, hidden and empty: every string below is written under the mocks.
    const { view, root } = c8bMount();
    const walk = (label: string): string => {
      const texts = m24s4BxWalkSubtree(root);
      m24s4BxAssertNoRosterWord(texts, label);
      return texts.join('\n');
    };
    const byJson = (values: unknown[]): string[] => values.map((v) => JSON.stringify(v)).sort();
    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      vi.mocked(i18nTf).mockImplementation(
        (key: string, params: unknown) => `«${key}|${JSON.stringify(params)}»`,
      );
      view.refresh(c8bParty(), c8bBox());
      view.show();

      view.paint(
        c8bPaint({
          tab: 'party',
          activeKey: '100',
          sheet: c8bSheet(C8B_KIP, 'feed', false, false),
          feedback: { kind: 'fed', name: 'Kip' },
        }),
      );
      let joined = walk('the sheet with both reasons, and the fed line');
      for (const key of [
        'box.sheet.care',
        'box.sheet.feed',
        'box.sheet.evolve',
        'box.sheet.feedNone',
        'evolution.card.noPaths',
      ]) {
        expect(joined, `«${key}» is rendered`).toContain(`«${key}»`);
      }
      expect(c8cSpanParams(joined, 'box.feedback.fed')).toEqual([{ name: 'Kip' }]);

      view.paint(
        c8bPaint({
          tab: 'party',
          activeKey: '100',
          sheet: c8bSheet(C8B_KIP, 'feed'),
          feed: { foods: [{ itemId: 7, name: 'Bait', count: 3 }], activeKey: '7' },
        }),
      );
      joined = walk('the food list');
      expect(c8cSpanParams(joined, 'box.feed.item')).toEqual([{ name: 'Bait', count: 3 }]);

      view.paint(
        c8bPaint({
          tab: 'party',
          activeKey: '100',
          sheet: c8bSheet(C8B_KIP, 'evolve'),
          evolve: { mon: C8C_TWO_CHOICES, activeKey: '20' },
        }),
      );
      joined = walk('the Evolve list with two choices');
      expect(byJson(c8cSpanParams(joined, 'evolution.path.heading'))).toEqual(
        byJson([{ species: 'Tidepup' }, { species: 'Duskling' }, { species: 'Emberfang' }]),
      );
      expect(joined).toContain('«evolution.path.allMet»');
      expect(joined, 'the unmet reason is data, shown raw').toContain('requires level 50');

      view.paint(
        c8bPaint({
          tab: 'party',
          activeKey: '100',
          sheet: c8bSheet(C8B_KIP, 'evolve'),
          evolve: { mon: C8C_ONE_READY, activeKey: '10' },
        }),
      );
      joined = walk('the Evolve list with one ready path');
      expect(c8cSpanParams(joined, 'evolution.card.ready')).toEqual([{ species: 'Duskling' }]);

      view.paint(
        c8bPaint({
          tab: 'party',
          activeKey: '100',
          sheet: c8bSheet(C8B_KIP, 'evolve'),
          confirm: { name: 'Kip', species: 'Emberfang', yes: false },
        }),
      );
      joined = walk('the confirm');
      expect(c8cSpanParams(joined, 'box.evolve.confirm')).toEqual([
        { name: 'Kip', species: 'Emberfang' },
      ]);
      expect(joined).toContain('«prompt.yes»');
      expect(joined).toContain('«prompt.no»');
    } finally {
      vi.mocked(i18nT).mockRestore();
      vi.mocked(i18nTf).mockRestore();
    }
  });
});
