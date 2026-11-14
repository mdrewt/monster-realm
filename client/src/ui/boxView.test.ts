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
// COPY B (the plan's final wording; qf-8 rewrote it, see the qf-8 block below):
//   "Only monsters in your Party can battle or be swapped in. New recruits arrive in your
//    Box — each box monster has a \"To Party\" button that moves it into an open party slot."
//   Since qf-8: "... New recruits arrive in your Box — select one there and choose \"Move\" to
//   bring it into an open party slot." (the quoted label is the Monsters sheet's `box.sheet.move`).
//   Two measured constraints shaped it:
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
//
// ctl-10a (CTL10A.4): Monsters offers no Heal Party control; healing happens only at a bound
// healer. The case is the describe titled 'BoxView ctl-10a ...' at the end of this file
// (CTL10A-4-NO-HEAL-CONTROL). NAMED INTENTIONAL CHANGES to pre-existing cases:
//   - makeBoxCallbacks no longer passes `onHealParty` (the callbacks are constructed without it).
//   - M24S4_BX_PLAIN_KEYS drops `box.heal` (a «box.heal» span is now an unexpected sentinel);
//     'Heal Party' stays in M24S4_BX_ROSTER, so it may appear nowhere.
//   - m24s4 BX-01: `box.heal` is no longer resolved by show() or a repeat show(), and no button
//     in the frame reads 'Heal Party' (was: the first button reads 'Heal Party').
//   - m24s4 BX-02: the sentinel walk no longer contains «box.heal».
//   - CTL8B-3-VIEW-ROW: its "Heal Party disabled while the typing row shows, enabled after"
//     clauses are removed with the button (the c8bHealButton helper goes too); the rest of the
//     case is unchanged.
//
// qf-3 (QF3.3, QF3.4): while a monster's care cooldown runs, the sheet's Care row is disabled with
// its reason (the Feed… / no-food precedent: aria-disabled, .is-disabled, the catalogued hint after
// the label). The cases are the describe titled 'BoxView qf-3 ...' at the end of this file
// (QF3-3-VIEW-* / QF3-4-VIEW-*). NAMED INTENTIONAL CHANGES to pre-existing cases:
//   - `c8bSheet` takes a fifth parameter, `careRemainingMs`, default 0n (Care ready), so every
//     existing sheet paint keeps an enabled Care row.
//   - M24S4_BX_PARAM_KEYS gains `box.sheet.careCooldown`.
//
// qf-8 (QF8.1, QF8.2): the cards' To Box / To Party buttons are DELETED (a mouse-only duplicate of
// the Monsters sheet's Move row, the only move path now: screens/monstersScreen.ts's `move` arm,
// pinned by monstersScreen.test.ts CTL8B-2-MOVE-COMMAND for both sentinels, -1 and the injected
// `partySlotNone`; the pointer route is reachability.test.ts [QF8-1-MOVE-POINTER]; their absence,
// document-wide and under the spy matrix, is reachability.test.ts [QF8-2-BOX-RETIRED] /
// [QF8-2-BOX-NATIVE]). NAMED INTENTIONAL CHANGES to pre-existing cases:
//   - ux4 X2: the "To Party emits -1, To Box emits 255" half is RETIRED (survivor: CTL8B-2-MOVE-
//     COMMAND); the box-vs-party render half stays. NEXT_FREE_SLOT_SENTINEL goes with it.
//   - X2b "To Box emits the INJECTED sentinel": RETIRED (survivor: CTL8B-2-MOVE-COMMAND, whose
//     Party move, to Storage, sends the view model's `partySlotNone`, the injected wasm value; a
//     Storage move sends -1).
//   - ux4 X3 / X6: the hint quotes the sheet's Move label instead of "To Party" (the `box.hint`
//     value changed, its id did not); X6's "no To Party button / real controls render" pair is now
//     "no button at all, no retired label in the copy".
//   - EG4-8 X10: the badged card keeps its name and HP line; its "slot-swap button" clause is
//     RETIRED (survivor: CTL8B-2-MOVE-COMMAND, the badge does not change the sheet).
//   - m24s4 BX-01 / BX-02: the `box.card.{toBox,toParty}` expectations leave with the ids (also from
//     M24S4_BX_PLAIN_KEYS); the frame now renders NO button.
//   - ctl-8b gap (focus rescue): the focused control inside a hidden panel is the card itself (the
//     only focusable left in a panel; happy-dom focuses a bare div), not a To Box button.
//   - CTL10A-4-NO-HEAL-CONTROL: "the frame renders its real buttons" becomes "no button at all".
//   - polish-1 P2: KEEP-NODES / KEEP-NODES-STORAGE-EMPTY keep a focused CARD (was a button);
//     CHANGED-REBUILDS-HANDLERS is RETIRED (no handler is left to rebind; the card's key follows the
//     id: POLISH1-P2-CHANGED-REBUILDS "a monster id changes at the same position"); THROW-RECOVERY
//     faults the card's name span (each card builds one, as it built one button); LOCALE reads the
//     empty slot / empty box / stats copy (the button copy is gone).
//
// qf-10 (QF10.3, QF10.4, QF10.5): the frame is named Monsters (box.title), the Box panel is
// Storage (box.section.box, box.box.empty), and the hint (box.hint) moves BELOW both panels. NAMED
// INTENTIONAL CHANGES to pre-existing cases (the key ids are unchanged; only values move):
//   - 'Party & Box' -> 'Monsters' (the title anchor, every findByTag(.., 'h2', ..) lookup);
//     the Box h3 -> 'Storage' (boxGridOf, CTL8B-1-VIEW-TABS); 'No monsters in box.' ->
//     'No monsters in storage.' (BX-01, CTL7B-1-NO-OPACITY-DIM-BOX); X3's recruits clause reads
//     'New recruits arrive in Storage'.
//   - ux4 X4 INSERTION POINT: the hint used to be pinned BETWEEN the header and the Party h3
//     (immediately before it). QF10.3 replaces that position: it is now the LAST child of #root,
//     after the Storage grid. The header-first half of the pin is unchanged.
//   - the e2e chain comments: client/e2e/recruit.spec.ts no longer resolves the root as
//     h2['Party & Box'].parentElement.parentElement; it locates `[data-testid="box-title"]` and
//     takes `.closest('.mr-frame')`, so the title text is not an e2e contract any more.
//   - M24S4_BX_ROSTER gains the three new English strings.
// New cases: QF10-4-BOX-TITLE-RENDERS, QF10-3-HINT-BELOW-PANELS, QF10-3-HINT-NOT-AT-SEAM (end of
// file).
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWasmU32Constant } from '../../test-util/wasmPkg';
import type { MonsterCardViewModel, MonsterStatsViewModel } from './boxModel';
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

import { beforeEach } from 'vitest';
import { DeployPanel, deployVM } from '../tactics/deployPanel';
import { t } from './a11yCopy';
import { EvolutionView } from './evolutionView';
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

  it('S4-boxView-ANCHOR-FOCUS BITES: the anchor resolves to an <h2 tabindex="-1"> reading "Monsters" (qf-10), and focus moves to it after ONE real macrotask (never synchronously)', async () => {
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
      'qf-10 (named intentional change): was "Party & Box"; client/e2e/recruit.spec.ts locates ' +
        'this heading by its data-testid, so the text is the catalog value `box.title`',
    ).toBe('Monsters');

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
      // bt-17 (named fixture change, BT17.1): the `battleView` overlay's root is the deploy panel's
      // (the 1v1 BattleView is purged; the deploy panel, the results panel and the tactical shell
      // share the battleView overlay id). Same pin: it owns its own root under the shared mount.
      id: 'battleView',
      make: (app) => {
        const panel = new DeployPanel(app, { onDeploy: async () => {} });
        panel.render(
          deployVM({
            mode: 'wild',
            battleId: 1n,
            party: [{ monsterId: 11n, name: 'Sproutle', level: 5, hp: 18, maxHp: 20 }],
            remembered: [],
            slotCount: 1,
            wilds: [{ speciesId: 2, name: 'Emberfang', level: 4 }],
          }),
        );
        return panel;
      },
    },
    {
      id: 'raisingView',
      // qf-9 (QF9.2): the raising screen is inventory-only, so it takes no callbacks.
      make: (app) => new RaisingView(app),
    },
    { id: 'evolutionView', make: (app) => new EvolutionView(app, { onEvolve: vi.fn() }) },
  ];
  const ORDERED_PAIRS = APP_VIEWS.flatMap((a) =>
    APP_VIEWS.filter((b) => b !== a).map((b) => [a, b] as const),
  );

  it.each(
    ORDERED_PAIRS.map(([a, b]) => [a.id, b.id, a, b] as const),
  )('S4-CROSS-VIEW-DISTINCT-ROOTS BITES: %s stays open while %s opens and closes on the same #app mount', (_aId, _bId, a, b) => {
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
  });
});

const BOX_PARTY_HINT_SELECTOR = '[data-testid="box-party-hint"]';

/** The box sentinel injected as `partySlotNone` (main.ts passes the wasm `party_slot_none()`,
 *  pinned === 255 by X2b). qf-8: the view no longer emits it (the "To Box" button is deleted);
 *  it stays the boxed `partySlot` of the fixtures below. */
const BOX_SLOT = 255;

/** The BoxViewCallbacks callbacks as spies, plus the injected box sentinel. ctl-10a (named
 *  intentional change): no `onHealParty` — the Box Heal Party control is gone (CTL10A.4). */
function makeBoxCallbacks(): BoxViewCallbacks {
  return {
    onSetNickname: vi.fn(),
    onSetPartySlot: vi.fn(),
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
 * reported defect: the tactical recruit (`taming::insert_recruited`) inserts with
 * `PARTY_SLOT_NONE` (a
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

/** uif-6 (named intentional change, UIF6.5): the "Party" / "Storage" h3 headings are deleted, so the
 *  two grids are no longer found as the heading's next sibling. They are the two children of the
 *  tab content area `#monsters-panel`, Party first and Storage second. */
function monstersPanelOf(parent: HTMLElement): HTMLElement {
  const panel = parent.querySelector<HTMLElement>('#monsters-panel');
  expect(panel, 'precondition: the tab content area #monsters-panel exists').not.toBeNull();
  // uif-7 (UIF7.1, UIF7.4) named change: the panel also holds the Summary page and the one
  // ContextSheet root, after the two grids (was: exactly the two grids). Party and Storage stay
  // children[0] and children[1].
  const kids = [...(panel as HTMLElement).children];
  expect(
    kids.length,
    'precondition: #monsters-panel holds the Party grid, the Storage grid, the Summary page and the sheet',
  ).toBe(4);
  expect(
    kids.filter((el) => el.id === 'monsters-summary'),
    'one Summary page',
  ).toHaveLength(1);
  expect(
    kids.filter((el) => el.hasAttribute('data-context-sheet')),
    'one sheet root',
  ).toHaveLength(1);
  expect(kids[0]?.hasAttribute('data-context-sheet') || kids[0]?.id === 'monsters-summary').toBe(
    false,
  );
  expect(kids[1]?.hasAttribute('data-context-sheet') || kids[1]?.id === 'monsters-summary').toBe(
    false,
  );
  return panel as HTMLElement;
}

function partyGridOf(parent: HTMLElement): HTMLElement {
  const grid = monstersPanelOf(parent).children[0] as HTMLElement;
  assertNotTheHint(grid, '#partyEl');
  return grid;
}

function boxGridOf(parent: HTMLElement): HTMLElement {
  const grid = monstersPanelOf(parent).children[1] as HTMLElement;
  assertNotTheHint(grid, '#boxEl');
  return grid;
}

/** The header row (the `Monsters` h2's parent) — anchor for the insertion-point pins. */
function headerRowOf(parent: HTMLElement): HTMLElement {
  const title = findByTag(parent, 'h2', 'Monsters');
  const header = title.parentElement;
  expect(
    header,
    'precondition: the "Monsters" h2 must have a parent (the header row holding it)',
  ).not.toBeNull();
  return header as HTMLElement;
}

/** BoxView's `#root`, resolved title -> header -> root (the shape the structural pins below use;
 *  client/e2e/recruit.spec.ts now takes `[data-testid="box-title"]`.closest('.mr-frame')). */
function e2eBoxRootOf(parent: HTMLElement): HTMLElement {
  const title = findByTag(parent, 'h2', 'Monsters');
  const header = title.parentElement;
  expect(
    header,
    'precondition: the "Monsters" h2 must have a parent (the header row)',
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

describe('BoxView ux4 X2: box vs party render (EXPECTED GREEN)', () => {
  it('BITES: a box recruit renders in the BOX grid and NOT in the party grid', () => {
    // qf-8 (NAMED REMOVAL): KILLS (1) and (2) of this case pinned the cards' "To Party" (-1) and
    //   "To Box" (255) buttons, deleted as a mouse-only duplicate of the Monsters sheet's Move.
    //   Survivor for both sentinels and the box-to-party path: monstersScreen.test.ts
    //   CTL8B-2-MOVE-COMMAND (Move on a Storage monster sends -1, on a Party one the injected
    //   `partySlotNone`); its pointer route, reachability.test.ts [QF8-1-MOVE-POINTER].
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
    const { parent, view } = mount();

    view.refresh(makePartySlots(), [makeBoxRecruitCard()]);
    view.show();

    const partyGrid = partyGridOf(parent);
    const boxGrid = boxGridOf(parent);

    expect(
      boxGrid.textContent,
      'ux4 (X2): the recruited monster must render in the BOX grid — that is where ' +
        'the tactical recruit (`taming::insert_recruited`) puts it (PARTY_SLOT_NONE, ADR-0047 §3)',
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
  });
});

describe('BoxView X2b: the box sentinel is game-core PARTY_SLOT_NONE, injected (value identity)', () => {
  it('★ BITES: the BUILT wasm party_slot_none() === 255 === BOX_SLOT — the retired BOX_SLOT literal', () => {
    // Value-identity proof: boxView.ts no longer owns a `BOX_SLOT = 255` literal — main.ts
    // injects `party_slot_none()` as `partySlotNone`. Read from the compiled client-wasm binary.
    expect(readWasmU32Constant('party_slot_none')).toBe(255);
    expect(BOX_SLOT).toBe(255);
  });

  // qf-8 (NAMED REMOVAL): 'BITES: "To Box" emits the INJECTED sentinel — kills a view that
  // re-inlines 255' clicked the deleted "To Box" button. Survivor: monstersScreen.test.ts
  // CTL8B-2-MOVE-COMMAND (Move on a Party monster sends the view model's `partySlotNone`, the value
  // the screen reads from the wasm export, never a literal).
});

describe('BoxView ux4 X3: box-party hint is present, visible, and quotes the real sheet label', () => {
  it('BITES: [data-testid="box-party-hint"] exists, is not display:none, names Party and Box, and quotes the Monsters sheet`s Move label verbatim', () => {
    // KILLS (1): no hint / a blank hint — the whole point of the slice is that the
    //   box-vs-party rule is currently stated nowhere in the UI.
    // KILLS (2): a VAGUE hint that never names the two screens ("manage your monsters
    //   here") — it would not tell the player which set can battle.
    // KILLS (3): a hint that DRIFTS from the control it points at (e.g. quoting
    //   "Move to Party" while the sheet's row reads `box.sheet.move`), or that still names the
    //   retired "To Party" button (qf-8, named intentional change: the card buttons are deleted and
    //   the hint now points at the Monsters sheet's Move row). Copy that names a control the
    //   player cannot find is the ux1 defect again.
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
        'word "Party". `toContain(\'Party\')` alone was measured passing the copy "To Party To Box"',
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
      'ux4 (X3): the hint must say where new recruits actually GO (`taming::insert_recruited` / ADR-0047 §3) — ' +
        'this is the fact whose absence produced the playtest report. The literal clause pin also ' +
        'replaces the subsumed toContain(\'Box\'), which a stray "Box" anywhere would satisfy',
    ).toContain('New recruits arrive in Storage');
    // qf-10 (named intentional change, QF10.4): was 'New recruits arrive in your Box'.
    expect(text, 'qf-10: the legacy Box wording is gone').not.toMatch(/\bBox\b/);
    // qf-8 (named intentional change, QF8.1): the quoted control is the Monsters sheet's Move row,
    // its label read from the catalog (`box.sheet.move`), quoted as the copy quotes it.
    const moveLabel = i18nT('box.sheet.move');
    expect(
      text,
      'ux4 (X3): the hint must quote the LITERAL label of the sheet row it points at ' +
        `("${moveLabel}", box.sheet.move). Copy that names a differently-worded control sends ` +
        'the player hunting for a row that does not exist (ux1, ADR-0151)',
    ).toContain(`"${moveLabel}"`);
    expect(
      text,
      'ux4 (X3): the hint must tell the player how to reach that row: select the recruit there ' +
        '(in the Box) and choose the quoted action',
    ).toContain(`select one there and choose "${moveLabel}"`);
    expect(text, 'qf-8: the hint names no retired card button').not.toContain('To Party');
    expect(text, 'qf-8: the hint names no retired card button').not.toContain('To Box');
    // pins COPY B's load-bearing HEDGE. The copy `'…that always moves it into the party.'`
    // survived every other clause here, yet the plan names "an OPEN party slot" as the hedge
    // against deferral D3: Move on a Storage monster sends the -1 sentinel, main.ts resolves it
    // to the next free slot, and with a FULL party it refuses the move and says the party is
    // full. An unhedged "always moves it into the party" is therefore a promise the client
    // cannot keep.
    expect(
      text,
      'ux4 (X3) D3 HEDGE: the copy must qualify the destination as an "open party slot". With a ' +
        'full party the -1 sentinel finds no slot and the move is refused (deferral D3), so an ' +
        'unhedged "moves it into the party" is a false promise — the ux1 failure mode (ADR-0151) ' +
        'in its subtlest form: a true-sounding claim with a state in which it does not hold',
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
    // KILLS (1): WRAPPING `header` in a new div. This case resolves the box root as
    //   h2['Monsters'].parentElement.parentElement (the e2e specs locate the title by its testid
    //   and take .closest('.mr-frame')), so a wrapper retargets that chain to the wrapper.
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
        "this case resolves the box root as h2['Monsters'].parentElement.parentElement. " +
        'Under a header-wrapping mutant the ' +
        'parent-identity clause alone still passes (the chain resolves to the wrapper, which IS ' +
        "the hint's parent) — only the two containment clauses catch that the resolved node no " +
        'longer holds #partyEl / #boxEl, the grids those helpers read HP text out of',
    ).toBe(true);

    // -----------------------------------------------------------------------
    // MANDATED INSERTION POINT. The clauses above accept the hint ANYWHERE
    // under #root; the red-team's control implementation drifted to #root's FIRST child —
    // above the title — with the entire suite green.
    // NAMED INTENTIONAL CHANGE (qf-10, QF10.3): the ux4 plan pinned the hint BETWEEN the header
    // and the `Party` h3 (immediately before it). QF10.3 explicitly replaces that position: the
    // hint is now BELOW both panels, the LAST child of #root. The two assertions pin that:
    //   • `header` stays #root's first element  ⇒ the hint is not above the title (unchanged);
    //   • the hint has no next sibling and follows the Storage grid ⇒ it is not at the seam
    //     between the tab strip and the panels, and not between a label and its grid (which
    //     would also break the anchor helpers — see assertNotTheHint).
    // -----------------------------------------------------------------------
    const header = headerRowOf(parent);
    expect(
      header.previousElementSibling,
      'ux4 (X4) INSERTION POINT: the header row (h2 "Monsters") must remain ' +
        "#root's FIRST element child. A hint inserted ABOVE the title passes every containment " +
        "clause in this case — the red-team's control impl drifted exactly there with the whole " +
        "suite green — while putting explanatory small print above the screen's own heading",
    ).toBeNull();
    expect(
      hint!.nextElementSibling,
      'ux4 (X4) INSERTION POINT (qf-10): the hint is the LAST child of #root, below both panels',
    ).toBeNull();
    expect(
      boxGrid.compareDocumentPosition(hint!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'ux4 (X4) INSERTION POINT (qf-10): the hint follows the Storage grid',
    ).not.toBe(0);

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
        'early after appending only "No monsters in storage."',
    ).not.toBe(boxGridOf(parent));
    expect(
      hint.parentElement,
      'ux4 (X5): the hint must NOT be appended to the caller-supplied parent (production ' +
        '`#app`, the PixiJS container) — that mutant passed the entire suite during ux1',
    ).not.toBe(parent);
  });
});

describe('BoxView ux4 X6: the hint stays truthful in the fresh-player state (empty box)', () => {
  it('BITES: with an empty box the hint is still present and visible, no button renders anywhere under parent, and the copy names no retired card button, only the Move action every monster`s sheet offers', () => {
    // KILLS: a hint that names a control the player cannot see, in the single most likely state a
    //   confused new player reaches (one starter, empty box) — the ux1 defect (ADR-0151: a badge
    //   shipped for an overlay that did not render). Before qf-8 that control was the cards'
    //   "To Party" button, absent in this state, so the copy had to DESCRIBE it, never command a
    //   click (the imperative-verb regex this case carried). qf-8 (named intentional change,
    //   QF8.1) deleted both card buttons: the copy now names the Monsters sheet's Move row, which
    //   every monster's sheet carries in every state, so the imperative ("select one there and
    //   choose Move") is true whenever a recruit is in the Box; the regex has no subject left and
    //   is retired with the button. What stays: the hint is static (the empty-box early return
    //   cannot suppress it), no card button survives in this state either, and the copy names no
    //   retired button.
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

    expect(
      [...parent.querySelectorAll('button')].map((b) => b.textContent),
      'CONTROL (X6): the frame renders no button at all in the fresh-player state (qf-8: the ' +
        'cards carry no To Box / To Party control; a move is the Monsters sheet`s Move row)',
    ).toEqual([]);
    expect(
      partyGridOf(parent).textContent ?? '',
      'precondition (X6): the fresh-player state still renders its starter, so the empty button ' +
        'list above is not an empty render',
    ).toContain('Sproutle');
    // uif-6 (named intentional change, UIF6.6): the empty box is an EmptyState; its reason line is
    // the old "No monsters in storage." (the grid's textContent is reason + cue + next step now).
    expect(
      boxGridOf(parent).querySelector('.mr-empty-reason')?.textContent,
      'precondition (X6): and the empty box line',
    ).toBe(i18nT('box.box.empty'));

    // THE COPY HALF: the copy names no retired control, and the one it names is the sheet's Move.
    const text = hint!.textContent ?? '';
    expect(text, 'ux4 (X6): the copy names no retired card button').not.toContain('To Party');
    expect(text, 'ux4 (X6): the copy names no retired card button').not.toContain('To Box');
    expect(
      text,
      'ux4 (X6): the action the copy names is the Monsters sheet`s Move row, quoted as it reads',
    ).toContain(`"${i18nT('box.sheet.move')}"`);
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
    //   `client/e2e/recruit.spec.ts` sites read HP text from the box root (the `.mr-frame`
    //   holding the box-title testid); this case resolves it as
    //   h2['Monsters'].parentElement.parentElement — a wrapper silently retargets that
    //   chain and the HP-scan helpers then read HP text out of the
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
        "box root as h2['Monsters'].parentElement.parentElement in this file's helpers",
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
  it('BITES: a badged card still renders its name and its HP line', () => {
    // KILLS: a `#renderCard` rewrite that returns EARLY on the pending branch (or replaces
    //   the card body with the badge): the player would lose the name and the HP of exactly
    //   the monsters that need an action taken.
    // qf-8 (NAMED REMOVAL): the "and its slot-swap button" clause clicked the badged card's
    //   "To Party" button (deleted with the card buttons). Survivor: monstersScreen.test.ts
    //   CTL8B-2-MOVE-COMMAND (the sheet's Move sends for any monster; the badge never reaches the
    //   sheet's rows).
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

    const boxGrid = boxGridOf(parent);
    const partyGrid = partyGridOf(parent);
    expect(boxGrid.textContent, 'EG4-8 (X10): the badged box card still names its monster') //
      .toContain('Emberfang');
    expect(boxGrid.textContent, 'EG4-8 (X10): ...and still renders its HP line') //
      .toContain('HP 21/21');
    expect(partyGrid.textContent, 'EG4-8 (X10): the badged party card still names its monster') //
      .toContain('Sproutle');
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
  // INTENTIONAL CHANGE (ctl-10a): `box.heal` leaves this roster with the Heal Party button.
  'box.hint',
  // INTENTIONAL CHANGE (uif-6, UIF6.5 / UIF6.6): `box.section.party` and `box.section.box` leave this
  // roster with the two h3 headings (a «box.section.party» span is now an unexpected sentinel); the
  // empty Storage's EmptyState reads `box.box.empty` (reason) plus two new ids, its cue and next step.
  'box.box.empty',
  'box.storage.emptyCue',
  'box.storage.emptyNext',
  // INTENTIONAL CHANGE (ctl-8b): `box.card.rename` leaves this roster (the per-card Rename button
  // and window.prompt are deleted); seven keys join it (the tabs, the action sheet's rows and the
  // two Move feedback lines). `box.rename.prompt` stays: it is the typing row's label now.
  // INTENTIONAL CHANGE (qf-8): `box.card.toBox` and `box.card.toParty` leave this roster with the
  // cards' buttons (a «box.card.toBox» span is now an unexpected sentinel); 'To Box' and 'To Party'
  // stay in M24S4_BX_ROSTER, so they may appear nowhere.
  'box.card.evolveBadge',
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
  // INTENTIONAL CHANGE (uif-7, UIF7.2): the sheet's Close row and the lists' Back row read the kit's
  // two ids (a «kit.sheet.close» span is an expected sentinel now).
  'kit.sheet.close',
  'kit.sheet.back',
]);

// INTENTIONAL CHANGE (ctl-8c): the food row, the Evolve confirm, the fed line, and the reused path
// heading and ready line.
// INTENTIONAL CHANGE (qf-3): the cooling Care row's remaining-cooldown hint (hours, minutes).
const M24S4_BX_PARAM_KEYS = new Set([
  'box.party.emptySlot',
  'box.card.stats',
  'box.feed.item',
  'box.evolve.confirm',
  'box.feedback.fed',
  'evolution.path.heading',
  'evolution.card.ready',
  'box.sheet.careCooldown',
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
  // qf-10: the new Monsters / Storage wording must not appear outside a sentinel either.
  'Monsters',
  'Heal Party',
  'Party',
  'Box',
  'Rename',
  'To Box',
  'To Party',
  'No monsters in box.',
  'No monsters in storage.',
  'New recruits arrive in Storage',
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
  // uif-7 (UIF7.2): the Close and Back rows' English must come from the catalog too.
  'Close',
  'Back',
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
    // INTENTIONAL CHANGE (ctl-10a): no Heal Party button, so `box.heal` is never resolved.
    expect(i18nT).not.toHaveBeenCalledWith('box.heal');
    expect(i18nT).toHaveBeenCalledWith('box.hint');
    // INTENTIONAL CHANGE (uif-6, UIF6.5 / UIF6.6): the h3 headings are gone (their ids are never
    // resolved) and the empty Storage resolves its EmptyState cue and next step as well.
    expect(i18nT).not.toHaveBeenCalledWith('box.section.party');
    expect(i18nT).not.toHaveBeenCalledWith('box.section.box');
    expect(i18nT).toHaveBeenCalledWith('box.box.empty');
    expect(i18nT).toHaveBeenCalledWith('box.storage.emptyCue');
    expect(i18nT).toHaveBeenCalledWith('box.storage.emptyNext');
    // INTENTIONAL CHANGE (qf-8): `box.card.toBox` / `box.card.toParty` left with the card buttons.
    expect(i18nT).not.toHaveBeenCalledWith('box.card.evolveBadge');
    expect(i18nTf).toHaveBeenCalledWith('box.party.emptySlot', { slot: 1 });
    expect(i18nTf).toHaveBeenCalledWith('box.card.stats', {
      species: 'Sproutle',
      level: 6,
      current: 15,
      max: 20,
      percent: 75,
    });

    // INTENTIONAL CHANGE (qf-10, QF10.4): was 'Party & Box'.
    expect(root.querySelector('[data-testid="box-title"]')?.textContent).toBe('Monsters');
    // INTENTIONAL CHANGE (ctl-10a): was "the first button reads 'Heal Party'"; no button does now.
    // INTENTIONAL CHANGE (qf-8): was "the frame renders its buttons (To Box)"; it renders none.
    const buttonTexts = [...root.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttonTexts, 'qf-8: the frame renders no button at all').toEqual([]);
    expect(buttonTexts, 'ctl-10a: no Heal Party button').not.toContain('Heal Party');
    // INTENTIONAL CHANGE (qf-8): the hint quotes the Monsters sheet's Move row (was "To Party").
    expect(root.querySelector('[data-testid="box-party-hint"]')?.textContent ?? '').toContain(
      `"${i18nT('box.sheet.move')}"`,
    );
    const partyGrid = partyGridOf(parent);
    expect(partyGrid.textContent ?? '').toContain('Slot 1: (empty)');
    const boxGrid = boxGridOf(parent);
    // INTENTIONAL CHANGE (qf-10, QF10.4): was 'No monsters in box.'.
    expect(boxGrid.textContent ?? '').toContain('No monsters in storage.');

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
    // INTENTIONAL CHANGE (qf-8): was "the party card carries To Box and nothing that renames"; the
    // card carries no button at all now (a move and a rename are both the Monsters sheet's rows).
    expect(
      [...partyGrid.querySelectorAll('button')].map((b) => b.textContent),
      'qf-8: the party card carries no button (no To Box, nothing that renames)',
    ).toEqual([]);

    // --- RT2: a repeat show() re-resolves the constructor-time keys ---
    vi.mocked(i18nT).mockClear();
    view.show();
    expect(
      i18nT,
      'm24s4 BX-01 RT2: a repeat show() on an already-open overlay must re-resolve box.title',
    ).toHaveBeenCalledWith('box.title');
    // INTENTIONAL CHANGE (ctl-10a): `box.heal` is not resolved on a repeat show() either.
    expect(i18nT).not.toHaveBeenCalledWith('box.heal');
    expect(i18nT).toHaveBeenCalledWith('box.hint');
    // INTENTIONAL CHANGE (uif-6, UIF6.5): the section headings are gone.
    expect(i18nT).not.toHaveBeenCalledWith('box.section.party');
    expect(i18nT).not.toHaveBeenCalledWith('box.section.box');
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
      // INTENTIONAL CHANGE (ctl-10a): the Heal Party button and its «box.heal» label are gone.
      expect(joined).not.toContain('«box.heal»');
      expect(joined).toContain('«box.hint»');
      // INTENTIONAL CHANGE (uif-6, UIF6.5 / UIF6.6): no section headings; the empty Storage reads
      // its three EmptyState lines.
      expect(joined).not.toContain('«box.section.party»');
      expect(joined).not.toContain('«box.section.box»');
      expect(joined).toContain('«box.box.empty»');
      expect(joined).toContain('«box.storage.emptyCue»');
      expect(joined).toContain('«box.storage.emptyNext»');
      // INTENTIONAL CHANGE (ctl-8b): no '«box.card.rename»': the per-card Rename button is gone.
      // INTENTIONAL CHANGE (qf-8): no '«box.card.toBox»' either: the card buttons are gone (the id
      // left M24S4_BX_PLAIN_KEYS, so such a span would be an unexpected sentinel).
      expect(joined).not.toContain('«box.card.toBox»');
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
      expect(joined).not.toContain('«box.card.toParty»');
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
    expect(i18nT('chrome.help.title')).toBe('How to Play');
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
      // uif-7 (UIF7.1) named change: the tab content area `#monsters-panel` may write exactly
      // `position:relative` inline: it is the containing block the one context sheet is placed in.
      // Nothing else may place itself, and no other element may write `position` at all.
      if (
        prop === 'position' &&
        el.id === 'monsters-panel' &&
        ctl7bInline(el).get('position') === 'relative'
      ) {
        continue;
      }
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

describe('BoxView ts-6b-11: the Monsters title sits in the kit title bar', () => {
  it('the Monsters frame has one title bar and no in-panel heading', () => {
    // WRONG IMPLS KILLED: the plain header div holding the h2 (no `.mr-frame-titlebar`, so the
    // kit's bar paint never applies); a title bar that is not the frame root's first element
    // child; a title without `.mr-frame-title`; a title keeping the inline `color:#fff` (the kit
    // paints it) or a non-zero inline margin (the bar owns the spacing); a second title bar; a
    // heading repeated in the panel body outside the bar and the context sheet; a title that lost
    // its testid or its `tabindex="-1"` focus anchor; a title text not resolved at show().
    const { parent, view } = mount();
    view.refresh(makePartySlots(), [makeBoxRecruitCard()]);
    view.show();
    const root = parent.firstElementChild as HTMLElement;
    expect(root.classList.contains('mr-frame'), 'the root is the kit frame').toBe(true);

    const bars = root.querySelectorAll<HTMLElement>('.mr-frame-titlebar');
    expect(bars, 'exactly one title bar in the frame').toHaveLength(1);
    const bar = bars[0] as HTMLElement;
    expect(root.firstElementChild, 'the title bar is the frame root first element child').toBe(bar);
    expect(bar.tagName, 'the title bar is a div').toBe('DIV');

    const title = root.querySelector<HTMLElement>('h2[data-testid="box-title"]');
    expect(title, 'the box-title h2 exists').not.toBeNull();
    expect(bar.contains(title), 'the title is inside the title bar').toBe(true);
    expect(title?.classList.contains('mr-frame-title'), 'the title wears .mr-frame-title').toBe(
      true,
    );
    expect(title?.getAttribute('tabindex'), 'the title stays the programmatic focus anchor').toBe(
      '-1',
    );
    expect(title?.style.color, 'the kit paints the title: no inline colour').toBe('');
    expect(['0', '0px'], 'the bar owns the spacing: the title margin is 0').toContain(
      title?.style.margin,
    );
    expect(title?.textContent, 'the title text resolves at show()').toBe(i18nT('box.title'));

    const stray = [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')].filter(
      (h) => !bar.contains(h) && h.closest('[data-context-sheet]') === null,
    );
    expect(
      stray.map((h) => `${h.tagName.toLowerCase()}:${h.textContent}`),
      'no heading outside the title bar and the context sheet',
    ).toEqual([]);
  });
});

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
      "the root is the header's parent — the title h2 -> header -> root chain (the e2e specs " +
        "locate the title by its testid and take .closest('.mr-frame'))",
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
      return own.includes('(empty)') || own.includes('No monsters in storage.');
    });
    expect(
      empties.map((el) => ctl7bOwnText(el)),
      'precondition: three empty party slots and the empty storage line are rendered',
    ).toHaveLength(4);
    // uif-6 (named intentional change, UIF6.5): the empty slots' colour is a TOKEN var
    // (`var(--mr-text-muted)`), which happy-dom cannot resolve to a literal. An empty whose inline
    // colour is a var must be EXACTLY one of the two readable text tokens (never a translucent or
    // arbitrary var); the rest keep the literal 4.5:1 check. The measured contrast of the tokens in
    // Chromium is the UIF6.5 e2e's (the cell colours) and ui-chrome's (the token table).
    const READABLE_TOKEN_VARS = ['var(--mr-text-muted)', 'var(--mr-frame-fg)'];
    const colourOf = (el: Element): string | undefined => {
      for (let n: Element | null = el; n !== null && n !== root; n = n.parentElement) {
        const colour = ctl7bInline(n).get('color');
        if (colour !== undefined) return colour;
      }
      return undefined;
    };
    const tokenised = empties.filter((el) => colourOf(el)?.startsWith('var(') === true);
    for (const el of tokenised) {
      expect(
        READABLE_TOKEN_VARS,
        `the token var ${colourOf(el)} on ${JSON.stringify(ctl7bOwnText(el))} is a readable text token`,
      ).toContain(colourOf(el));
    }
    expect(
      tokenised.length,
      'non-vacuity: the three empty slots carry a token colour',
    ).toBeGreaterThanOrEqual(3);
    ctl7bExpectReadableEmpties(
      empties.filter((el) => !tokenised.includes(el)),
      root,
    );
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

/** A sheet paint (ctl-8c): Feed… and Evolve… enabled unless a case says otherwise.
 *  qf-3 (named intentional change): and the remaining care cooldown, 0n (Care ready) unless a case
 *  says otherwise. */
const c8bSheet = (
  card: MonsterCardViewModel,
  action: SheetAction,
  canFeed = true,
  canEvolve = true,
  careRemainingMs = 0n,
): NonNullable<MonstersPaint['sheet']> => ({ card, action, canFeed, canEvolve, careRemainingMs });

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
    // uif-7 (UIF7.1) named change: the context sheet kit hides its root and heading by the `hidden`
    // attribute (closeContextSheet), never by inline display; the panels and parts of this frame
    // still hide by inline display and never set `hidden`, so counting it changes no earlier case.
    if ((n as HTMLElement).hidden === true) return true;
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
// uif-6 (named intentional change, UIF6.8): the Party draws all six slots, and an empty slot's cell
// carries `data-nav-key="slot-<i>"`. `c8bKeys` stays "the monsters' keys" (the slot cells are
// filtered out); `c8bCellKeys` is every cell, slot cells included.
const c8bKeys = (grid: Element): (string | undefined)[] =>
  c8bCards(grid)
    .map((el) => el.dataset.navKey)
    .filter((key) => key === undefined || !key.startsWith('slot-'));
const c8bCellKeys = (grid: Element): (string | undefined)[] =>
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

// ctl-10a (named intentional change): the c8bHealButton helper is removed with the Heal Party
// button it located (CTL8B-3-VIEW-ROW was its only user).

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
    // INTENTIONAL CHANGE (uif-6, UIF6.5): the two h3 section headings are deleted, so the heading
    // clauses below are gone; the tabs and the two grids carry the claim (UIF6.5 pins the h3s' absence).

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
    expect(c8bHidden(box, root), 'the Box grid is hidden by inline display:none').toBe(true);
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
    expect(c8bHidden(party, root), 'the Party grid is hidden now').toBe(true);
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
    // control: before qf-8 deleted them, the panels' To Party / To Box buttons would have won it;
    // the sheet still has to come first); a null sheet that leaves the list showing, or removes
    // the element (the focus rescue and the e2e text scans rely on hide-not-remove).
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
    // uif-7 (UIF7.2): the seventh row is Close, the kit's `kit.sheet.close`.
    expect(
      rows.map((row) => row.textContent),
      'Summary, Care, Feed, Evolve, Nickname, Move, Close: the catalog labels in order',
    ).toEqual([
      c8bT('box.sheet.summary'),
      c8bT('box.sheet.care'),
      c8bT('box.sheet.feed'),
      c8bT('box.sheet.evolve'),
      c8bT('box.sheet.nickname'),
      c8bT('box.sheet.move'),
      c8bT('kit.sheet.close'),
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
      'Close',
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
    ).toEqual(['false', 'false', 'false', 'false', 'true', 'false', 'false']);
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

    // uif-7 (UIF7.1) named change: the sheet is the ContextSheet mounted INSIDE the tab content area
    // `#monsters-panel` (beside the grids, which stay), not a part placed before the panels; the
    // clause that survives is that it is inside neither grid (a refresh rebuilds the grids).
    expect(monstersPanelOf(parent).contains(list), 'the sheet is inside #monsters-panel').toBe(
      true,
    );
    for (const [name, grid] of [
      ['Party', party],
      ['Box', box],
    ] as const) {
      expect(grid.contains(list), `the sheet is not inside the ${name} grid`).toBe(false);
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

// ---------------------------------------------------------------------------
// qf-11 (QF11.1): the Monsters tab strip is a direct child of the `.mr-frame` column root, the one
// mount where `flex: 1 1 auto` made it absorb the frame's free height. The REAL view is mounted,
// shown and painted through several states, the REAL styles.css is injected into happy-dom, and the
// LIVE strip (not a clone) is read once through getComputedStyle at the end (happy-dom caches
// computed style per element), so an inline style the view writes itself is seen by the oracle.
// ---------------------------------------------------------------------------

const QF11_STYLES_CSS = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'styles.css'),
  'utf8',
);

/** Inline properties that could stretch, stack or freeze a strip. */
const QF11_BANNED_INLINE: readonly string[] = [
  'flex',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'flex-direction',
  'flex-flow',
  'height',
  'block-size',
  'min-height',
  'max-height',
  'width',
  'min-width',
  'max-width',
];

/** The banned layout properties `el` sets inline, read from the style attribute and from the style
 *  object (so `style.flexGrow = '1'`, `style.flex = ...` and cssText are all seen). */
function qf11InlineLayout(el: Element): string[] {
  const found = new Set<string>();
  for (const part of (el.getAttribute('style') ?? '').split(';')) {
    const colon = part.indexOf(':');
    if (colon === -1) continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    if (QF11_BANNED_INLINE.includes(prop)) found.add(prop);
  }
  const style = (el as HTMLElement).style;
  for (const prop of QF11_BANNED_INLINE) {
    if (style.getPropertyValue(prop) !== '') found.add(prop);
  }
  return [...found];
}

describe('BoxView qf-11: the Monsters tab strip (QF11.1)', () => {
  let sheet: HTMLStyleElement | null = null;
  const installSheet = (): void => {
    sheet = document.createElement('style');
    sheet.textContent = QF11_STYLES_CSS;
    document.head.appendChild(sheet);
  };
  afterEach(() => {
    sheet?.remove();
    sheet = null;
  });

  it('the real Monsters strip is a direct child of the frame column carrying mr-frame-tabstrip, writes no inline layout style in any state, and computes a flex row with grow 0, no column direction, no length basis and max-width 100% [QF11-1-BOX-STRIP-COMPUTED]', () => {
    // WRONG IMPL KILLED: C9 `this.#tabStrip.style.flexGrow = '1'` (or `style.flex`, `style.height`,
    // `style.flexDirection`, or a cssText) written by boxView.ts: the stylesheet scans and the other
    // views' tests never mount a BoxView, so the growth came back for this one screen only;
    // C3 flex-direction: column; C1 a basis that fills the column; the class dropped from the strip;
    // the strip moved out of the column root; a strip that loses the class or gains an inline style
    // only after a paint, a tab switch or a batch refresh (checked after all of them).
    installSheet();
    const { view, root } = c8bOpen();
    const stripOf = (): HTMLElement => {
      const found = root.querySelector<HTMLElement>('[role="tablist"]');
      expect(found, 'the Monsters tab strip exists').not.toBeNull();
      return found as HTMLElement;
    };
    const expectClean = (when: string): void => {
      const strip = stripOf();
      expect(
        strip.classList.contains('mr-frame-tabstrip'),
        `${when}: carries the strip class`,
      ).toBe(true);
      expect(qf11InlineLayout(strip), `${when}: no inline layout style on the strip`).toEqual([]);
      for (const prop of [
        'flex',
        'flexGrow',
        'flexShrink',
        'flexBasis',
        'height',
        'flexDirection',
      ]) {
        expect(
          (strip.style as unknown as Record<string, string>)[prop],
          `${when}: style.${prop} is empty`,
        ).toBe('');
      }
    };

    view.paint(c8bPaint({ tab: 'party' }));
    expectClean('painted on Party');
    view.paint(c8bPaint({ tab: 'storage' }));
    expectClean('painted on Storage');
    view.refresh(c8bParty(), c8bBox());
    expectClean('after a batch refresh');
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'summary') }));
    expectClean('with the sheet open');
    view.hide();
    view.show();
    view.paint(c8bPaint({ tab: 'party' }));
    expectClean('after hide, show and paint');

    // ANTI-VACUITY: the strip is the painted, two-tab tablist in the column root.
    const strip = stripOf();
    // uif-6 (named intentional change, UIF6.1): the strip is built through the TabBar, so it sits in
    // the `.mr-tabbar` row (LB chip, strip, RB chip) and THAT row is the frame root's child.
    expect(strip.parentElement?.classList.contains('mr-tabbar'), 'inside the TabBar row').toBe(
      true,
    );
    expect(strip.parentElement?.parentElement, 'the row is a direct child of the frame root').toBe(
      root,
    );
    expect(root.classList.contains('mr-frame'), 'inside a .mr-frame column').toBe(true);
    expect(c8bTabs(root), 'two tabs rendered').toHaveLength(2);

    const computed = getComputedStyle(strip);
    expect(computed.display, 'a flex row').toBe('flex');
    expect(computed.flexDirection, 'not a column').not.toBe('column');
    const first = computed.flex.trim().split(/\s+/)[0] ?? '';
    let grow = Number.NaN;
    if (computed.flexGrow !== '') grow = Number(computed.flexGrow);
    else if (first === 'none') grow = 0;
    else if (first !== '') grow = Number(first);
    expect(grow, 'flex-grow (no vertical growth)').toBe(0);
    expect(computed.flexBasis, 'no length or percentage basis').not.toMatch(/[\d%]/);
    expect(computed.maxWidth, 'max-width').toBe('100%');
    for (const tab of c8bTabs(root)) {
      expect(getComputedStyle(tab).whiteSpace, `tab ${tab.id}: one line`).toBe('nowrap');
    }
  });
});

describe('BoxView ctl-8b: the nickname row (CTL8B.3)', () => {
  it('CTL8B-3-VIEW-ROW: a nickname paint shows a labelled text field prefilled with the card`s nickname (empty for a card with none) and focuses it; closing it moves focus to the title anchor and sends nothing; the field keeps keys out of the page`s hotkeys but lets Enter through', async () => {
    // WRONG IMPL KILLED: no row; a field with no label (a screen reader names it nothing); a
    // prefill of the species name for a nickname-less card (the commit would then rename the
    // monster to its species); a field never focused (the player types into the page: main.ts's
    // ladder takes B, I, E, Q and the rest); a key shield that also eats Enter (A would never
    // commit) or none at all ("b" in the field would close the box); a row left showing after it
    // closed; focus left on the hidden field (it falls to <body> and the frame loses the keyboard).
    // ctl-10a (named intentional change, CTL10A.4): the "Heal Party disabled while the row shows,
    // enabled again when it closes" clauses are removed with the Heal Party button
    // (CTL10A-4-NO-HEAL-CONTROL pins that no such button exists, row open or not).
    const { view, root, callbacks } = c8bOpen();
    await s4FlushMacrotask(); // show()'s deferred anchor focus lands before the row opens

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

    // The row closes (B, or A with the commit already painted): hidden, focus on the title
    // anchor, nothing sent.
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'nickname') }));
    expect(c8bHidden(field, root), 'the row is hidden by inline display').toBe(true);
    expect(c8bHidden(lab, root), 'and so is its label').toBe(true);
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
        // INTENTIONAL CHANGE (uif-7, UIF7.2): the sheet's seventh row, Close.
        'kit.sheet.close',
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
    // player is on), and a shown frame with no rescue (focus stays on an element of a panel the
    // paint just hid: the next key heals focus to the world, out of the frame).
    // qf-8 (named intentional change): the focused element inside the Party panel is its card
    // (the To Box button it used to be is deleted, and a card is the panel's one node a pointer
    // lands on). happy-dom focuses a bare div with no tabindex, so the rescue is exercised here as
    // before; whether a browser would focus the card is not this case's claim.
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

    // A hidden frame also leaves focus on an element INSIDE it (on a part the paint then hides).
    shown.view.paint(c8bPaint({ tab: 'party', activeKey: '100' }));
    const inside = partyGridOf(shown.parent).querySelector<HTMLElement>('[data-nav-key="100"]');
    expect(inside, 'precondition: the Party panel holds the card keyed 100').not.toBeNull();
    (inside as HTMLElement).focus();
    expect(document.activeElement, 'fixture: focus is on the Party card').toBe(inside);
    shown.view.paint(c8bPaint({ tab: 'storage', activeKey: '200' }));
    expect(document.activeElement, 'a hidden frame does not rescue focus').toBe(inside);

    // Shown: focus on a card of the Party panel, then Storage is painted.
    const open = c8bOpen();
    await s4FlushMacrotask();
    open.view.paint(c8bPaint({ tab: 'party', activeKey: '100' }));
    const card = partyGridOf(open.parent).querySelector<HTMLElement>('[data-nav-key="100"]');
    expect(card, 'precondition: the Party panel holds the card keyed 100').not.toBeNull();
    (card as HTMLElement).focus();
    expect(document.activeElement, 'fixture: the card is focused').toBe(card);
    open.view.paint(c8bPaint({ tab: 'storage', activeKey: '200' }));
    expect(
      c8bHidden(card as HTMLElement, open.root),
      'fixture: the Party panel is hidden now',
    ).toBe(true);
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

/** uif-7 (UIF7.1, UIF7.3) named replacement of `c8cBeforeHintAndPanels`: the food list, the Evolve
 *  list and the confirm are the one sheet's rows now, mounted INSIDE `#monsters-panel` (the sheet's
 *  containing block) and so no longer "before the hint and both panels". What survives of the old
 *  claim: `el` is inside neither grid (a refresh rebuilds the grids) and comes before the hint. */
function c8cInPanelNotInGridBeforeHint(
  parent: HTMLElement,
  root: HTMLElement,
  el: Element,
  name: string,
): void {
  const hint = root.querySelector<HTMLElement>(BOX_PARTY_HINT_SELECTOR) as HTMLElement;
  expect(monstersPanelOf(parent).contains(el), `${name} is inside #monsters-panel`).toBe(true);
  expect(partyGridOf(parent).contains(el), `${name} is not inside the Party grid`).toBe(false);
  expect(boxGridOf(parent).contains(el), `${name} is not inside the Storage grid`).toBe(false);
  expect(
    hint.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING,
    `${name} comes before the hint`,
  ).not.toBe(0);
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
    // uif-7 (UIF7.2): the seventh row is Close.
    const ACTIONS = ['summary', 'care', 'feed', 'evolve', 'nickname', 'move', 'close'];
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
      i18nT('kit.sheet.close'),
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
      'Close',
    ]);
    expect(
      c8cOptions(list).map((r) => r.getAttribute('aria-disabled')),
      'all enabled',
    ).toEqual([null, null, null, null, null, null, null]);
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

    // WRONG IMPL KILLED (round 2): a null sheet that only hides its list (display:none) but keeps
    // the rows and their reasons in the root: the e2e helpers read the root's textContent, hidden
    // descendants included, so "Feed…No food" / "No evolution paths." would linger in every scan
    // after the sheet closed; and the over-correction, a sheet that never comes back.
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: null }));
    const closedText = root.textContent ?? '';
    for (const gone of [
      i18nT('box.sheet.feed'),
      i18nT('box.sheet.evolve'),
      i18nT('box.sheet.feedNone'),
      i18nT('evolution.card.noPaths'),
    ]) {
      expect(closedText, `a closed sheet leaves no "${gone}" in the root`).not.toContain(gone);
    }
    expect(closedText, 'English bytes').not.toContain('No food');
    expect(closedText, 'English bytes').not.toContain('No evolution paths.');
    expect(
      root.querySelectorAll('[id^="monstersSheet-root-"]'),
      'a closed sheet holds no rows',
    ).toHaveLength(0);
    paintSheet('summary', false, false);
    expect(
      c8cOptions(c8cListOf(root, 'monstersSheet-root-summary')).map((r) => r.id),
      'a later sheet shows its six rows again',
    ).toEqual(ACTIONS.map((a) => `monstersSheet-root-${a}`));
    expectDisabled('feed', i18nT('box.sheet.feed'), i18nT('box.sheet.feedNone'), 'reopened');

    paintSheet('summary', true, true);
    expectEnabled('feed', i18nT('box.sheet.feed'), 'enabled again');
    expectEnabled('evolve', i18nT('box.sheet.evolve'), 'enabled again');

    // A batch render re-applies the kept paint.
    paintSheet('feed', false, true);
    view.refresh(c8bParty(), c8bBox());
    expectDisabled('feed', i18nT('box.sheet.feed'), i18nT('box.sheet.feedNone'), 'after refresh');
  });

  // uif-7 (UIF7.3) named changes to the food list's pins: its rows are the one ContextSheet's rows
  // (ids `monstersSheet-root-<itemId>` and `monstersSheet-root-back`, was `monstersFeed-root-*`),
  // the list REPLACES the sheet's rows (no sheet under it, was: the sheet stayed shown), it sits in
  // `#monsters-panel` (was: before the hint and both panels), it is named by the sheet heading
  // `#monsters-sheet-name` (was: labelled by the sheet's Feed row), and a null feed leaves the sheet
  // content to the paint (was: the feed list hidden by inline display and emptied).
  it('CTL8C-1-VIEW-FEED: a feed paint shows the food rows (monstersSheet-root-<itemId>, then Back) in the one sheet, reading the catalog food row for each food in order, the painted key active, no sheet action row beside them; names are text; a paint with no feed shows the other content and leaves no food row behind', () => {
    // WRONG IMPL KILLED: no list; rows keyed by index (the screen's cursor key would name no row);
    // a row text from a literal, without the count, or with the wrong food's count; the sheet's
    // action rows left under the food rows (two lists in one sheet); a list placed outside the
    // panel; a name parsed as HTML; a stale row kept after its food is gone; a closed list that
    // still holds "Bait (x3)" (the e2e text scans read hidden text).
    const { parent, view, root } = c8bOpen();
    const BAIT_ROW: FoodVm = { itemId: 7, name: 'Bait', count: 3 };
    const GLOW_ROW: FoodVm = { itemId: 40, name: 'Glowberry', count: 12 };
    const feedPaint = (foods: readonly FoodVm[], activeKey: string | null): MonstersPaint =>
      c8bPaint({
        tab: 'party',
        activeKey: '100',
        sheet: null,
        feed: { foods, activeKey },
      });

    view.paint(feedPaint([BAIT_ROW, GLOW_ROW], '40'));
    const list = c8cListOf(root, 'monstersSheet-root-7');
    expect(
      root.querySelector('#monstersSheet-root-feed'),
      'no sheet action row beside the food rows',
    ).toBeNull();
    // WRONG IMPL KILLED (round 2): an unlabelled food list (a screen reader would announce the list
    // with no name): it is named by the sheet's heading, which holds the monster's name.
    expect(list.getAttribute('aria-labelledby'), 'named by the sheet heading').toBe(
      'monsters-sheet-name',
    );
    expect(root.querySelector('#monsters-sheet-name')?.textContent, 'the heading names Kip').toBe(
      'Kip',
    );
    expect(c8cOptions(list).map((r) => r.id)).toEqual([
      'monstersSheet-root-7',
      'monstersSheet-root-40',
      'monstersSheet-root-back',
    ]);
    expect(c8cOptions(list).map((r) => r.textContent)).toEqual([
      i18nTf('box.feed.item', { name: 'Bait', count: 3 }),
      i18nTf('box.feed.item', { name: 'Glowberry', count: 12 }),
      i18nT('kit.sheet.back'),
    ]);
    expect(
      c8cOptions(list).map((r) => r.textContent),
      'English bytes',
    ).toEqual(['Bait (x3)', 'Glowberry (x12)', 'Back']);
    expect(c8cActiveIds(list), 'the painted key').toEqual(['monstersSheet-root-40']);
    expect(c8cOptions(list).map((r) => r.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    expect(c8cOptions(list).map((r) => r.getAttribute('aria-disabled'))).toEqual([
      null,
      null,
      null,
    ]);
    expect(c8bHidden(list, root), 'the list shows').toBe(false);
    expect(monstersPanelOf(parent).contains(list), 'inside #monsters-panel').toBe(true);

    // The cursor moves (onto Back too); a batch render keeps the list; a new count is repainted.
    view.paint(feedPaint([BAIT_ROW, GLOW_ROW], '7'));
    expect(c8cActiveIds(list)).toEqual(['monstersSheet-root-7']);
    view.paint(feedPaint([BAIT_ROW, GLOW_ROW], 'back'));
    expect(c8cActiveIds(list), 'the cursor can rest on Back').toEqual(['monstersSheet-root-back']);
    view.paint(feedPaint([BAIT_ROW, GLOW_ROW], '7'));
    view.refresh(c8bParty(), c8bBox());
    expect(c8cOptions(list).map((r) => r.textContent)).toEqual([
      'Bait (x3)',
      'Glowberry (x12)',
      'Back',
    ]);
    expect(c8cActiveIds(list)).toEqual(['monstersSheet-root-7']);
    view.paint(feedPaint([{ itemId: 7, name: 'Bait', count: 2 }, GLOW_ROW], '7'));
    expect(c8cById(root, 'monstersSheet-root-7').textContent).toBe('Bait (x2)');

    // A name is text, never markup; a food that is gone leaves no row.
    view.paint(feedPaint([{ itemId: 9, name: '<b>Bait</b>', count: 1 }], '9'));
    expect(list.querySelector('b'), 'no element made from a name').toBeNull();
    expect(c8cById(root, 'monstersSheet-root-9').textContent).toBe('<b>Bait</b> (x1)');
    expect(
      root.querySelectorAll('[id="monstersSheet-root-7"]'),
      'the gone food`s row',
    ).toHaveLength(0);

    // The food rows leave when another content takes the sheet: no food row, no food text.
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'feed') }));
    expect(root.querySelectorAll('[id="monstersSheet-root-9"]'), 'no food row left').toHaveLength(
      0,
    );
    expect(root.textContent ?? '', 'no food text left').not.toContain('<b>Bait</b>');
    view.paint(c8bPaint({ tab: 'party', activeKey: '100' }));
    expect(
      root.querySelectorAll('[id^="monstersSheet-root-"]'),
      'a closed sheet holds no row at all',
    ).toHaveLength(0);
  });

  // uif-7 (UIF7.3) named changes to the Evolve list and confirm pins: the path rows and the Yes / No
  // rows are the one ContextSheet's rows (ids `monstersSheet-root-<edgeId|yes|no|back>`, was
  // `monstersEvolve-root-*` / `monstersConfirm-root-*`), they REPLACE the sheet's rows (no sheet
  // under them) and each other (the confirm is the sheet's confirm variant: one shared rows list,
  // was: separate lists), the question is the sheet heading `#monsters-sheet-name` (was
  // `#monsters-evolve-question`), they sit in `#monsters-panel` (was: before the hint and panels),
  // and focus left on a closing sheet goes to the title anchor (was: left on a hidden list).
  it('CTL8C-1-VIEW-EVOLVE: an evolve paint lists every path (rows monstersSheet-root-<edgeId>, then Back) with its catalog heading and a status line (the raw unmet reason, the catalog ready line for a met path that is no choice, the catalog all-met line for a choice), only choices enabled, no evo-ready-note or evo-choice testid; a confirm paint asks the catalog question in the sheet heading (#monsters-sheet-name) over Yes / No rows named by it, the painted answer active; null closes the sheet and empties it, focus left in it goes to the title anchor, and a reopen shows neither', async () => {
    // WRONG IMPL KILLED: a list of the met paths only; rows keyed by index or by species; a status
    // line from a literal, the same line for every path, an unmet reason re-worded (it must match
    // the server's reject message), a met-but-not-choice path offered as a choice (enabled) or
    // described as "all met" (the server applies it itself); the evolution view's evo-ready-note /
    // evo-choice testids reused here (the e2e locators would hit two elements); a confirm question
    // from a literal, naming the wrong monster or species, or parsed as HTML; an unnamed Yes /
    // No list; Yes and No both or neither active; a closed sheet still holding its question text,
    // or holding the focus (the next key would leave the frame); a reopen that shows the last
    // visit's confirm.
    const { parent, view, root } = c8bOpen();
    await s4FlushMacrotask();
    const evolvePaint = (mon: EvolutionMonsterViewModel, activeKey: string | null): MonstersPaint =>
      c8bPaint({
        tab: 'party',
        activeKey: '100',
        sheet: null,
        evolve: { mon, activeKey },
      });
    const text = (edgeId: number): string =>
      c8cById(root, `monstersSheet-root-${edgeId}`).textContent ?? '';

    view.paint(evolvePaint(C8C_TWO_CHOICES, '30'));
    const list = c8cListOf(root, 'monstersSheet-root-10');
    expect(
      root.querySelector('#monstersSheet-root-evolve'),
      'no sheet action row beside the path rows',
    ).toBeNull();
    // WRONG IMPL KILLED (round 2): an unnamed Evolve list (a screen reader would announce the paths
    // with no name): it is named by the sheet heading, which holds the monster's name.
    expect(list.getAttribute('aria-labelledby'), 'named by the sheet heading').toBe(
      'monsters-sheet-name',
    );
    expect(root.querySelector('#monsters-sheet-name')?.textContent, 'the heading names Kip').toBe(
      'Kip',
    );
    expect(
      c8cOptions(list).map((r) => r.id),
      'every path, by edge id, then Back',
    ).toEqual([
      'monstersSheet-root-10',
      'monstersSheet-root-20',
      'monstersSheet-root-30',
      'monstersSheet-root-back',
    ]);
    expect(c8cById(root, 'monstersSheet-root-back').textContent, 'Back reads the catalog').toBe(
      i18nT('kit.sheet.back'),
    );
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
    // uif-7 (UIF7.2): the Back row is the one enabled row after the paths, whatever the paths say.
    expect(
      c8cOptions(list).map((r) => r.getAttribute('aria-disabled')),
      'only the choices are enabled (and Back)',
    ).toEqual(['true', null, null, null]);
    expect(c8cOptions(list).map((r) => r.classList.contains('is-disabled'))).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(c8cActiveIds(list), 'the painted key').toEqual(['monstersSheet-root-30']);
    expect(c8bHidden(list, root)).toBe(false);
    expect(monstersPanelOf(parent).contains(list), 'inside #monsters-panel').toBe(true);
    expect(list.textContent ?? '', 'no HP-shaped token for the e2e HP scans').not.toContain('HP ');

    // Exactly one met: the ready line, and it is not offered.
    view.paint(evolvePaint(C8C_ONE_READY, '10'));
    expect(c8cOptions(list).map((r) => r.id)).toEqual([
      'monstersSheet-root-10',
      'monstersSheet-root-20',
      'monstersSheet-root-back',
    ]);
    expect(text(20)).toContain(i18nTf('evolution.card.ready', { species: 'Duskling' }));
    expect(text(20), 'English bytes').toContain(
      `Ready ${C8C_EM_DASH} evolves into Duskling on your next action.`,
    );
    expect(text(20), 'the auto-applied path is not "all met"').not.toContain(
      i18nT('evolution.path.allMet'),
    );
    expect(c8cOptions(list).map((r) => r.getAttribute('aria-disabled'))).toEqual([
      'true',
      'true',
      null,
    ]);

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
        sheet: null,
        confirm: { name, species: 'Emberfang', yes },
      });
    view.paint(confirmPaint(false));
    // uif-7 (UIF7.3): the question is the sheet's heading (#monsters-sheet-name), and Yes / No are
    // the rows of the SAME list the paths used.
    const question = c8cById(root, 'monsters-sheet-name');
    expect(question.textContent).toBe(
      i18nTf('box.evolve.confirm', { name: 'Kip', species: 'Emberfang' }),
    );
    expect(question.textContent, 'English bytes').toBe('Evolve Kip into Emberfang?');
    expect(c8bHidden(question, root), 'the question shows').toBe(false);
    expect(
      root.querySelector('#monsters-evolve-question'),
      'the old question part is gone',
    ).toBeNull();
    const answers = c8cListOf(root, 'monstersSheet-root-yes');
    expect(c8cListOf(root, 'monstersSheet-root-no'), 'Yes and No are one list').toBe(answers);
    expect(answers, 'the very list the paths were in: one sheet').toBe(list);
    expect(answers.getAttribute('aria-labelledby'), 'named by the question').toBe(
      'monsters-sheet-name',
    );
    expect(
      c8cOptions(answers).map((r) => r.id),
      'Yes then No, and nothing else (no path row, no Back)',
    ).toEqual(['monstersSheet-root-yes', 'monstersSheet-root-no']);
    expect(c8cById(root, 'monstersSheet-root-yes').textContent).toBe(i18nT('prompt.yes'));
    expect(c8cById(root, 'monstersSheet-root-no').textContent).toBe(i18nT('prompt.no'));
    expect(c8cById(root, 'monstersSheet-root-yes').textContent, 'English bytes').toBe('Yes');
    expect(c8cById(root, 'monstersSheet-root-no').textContent, 'English bytes').toBe('No');
    expect(c8cActiveIds(answers), 'No is painted').toEqual(['monstersSheet-root-no']);
    // WRONG IMPL KILLED (round 2): a Yes or No row laid out disabled (`enabled: false` in the
    // confirm layout): a screen reader hears "dimmed" on an answer A does act on, and the row is
    // styled as unavailable while it is the default.
    const expectAnswersEnabled = (when: string): void => {
      for (const id of ['monstersSheet-root-yes', 'monstersSheet-root-no']) {
        expect(c8cById(root, id).getAttribute('aria-disabled'), `${when}: ${id}`).toBeNull();
        expect(c8cById(root, id).classList.contains('is-disabled'), `${when}: ${id}`).toBe(false);
      }
    };
    expectAnswersEnabled('No painted');
    expect(c8bHidden(answers, root)).toBe(false);
    expect(monstersPanelOf(parent).contains(answers), 'inside #monsters-panel').toBe(true);
    expect(
      root.querySelectorAll('[id="monstersSheet-root-10"]'),
      'no evolve paint: no path row is left',
    ).toHaveLength(0);
    view.paint(confirmPaint(true));
    expect(c8cActiveIds(answers), 'Yes is painted').toEqual(['monstersSheet-root-yes']);
    expectAnswersEnabled('Yes painted');
    expect(answers.getAttribute('aria-labelledby'), 'still named by the question').toBe(
      'monsters-sheet-name',
    );

    // A nickname is text, never markup.
    view.paint(confirmPaint(false, '<i>Kip</i>'));
    expect(question.querySelector('i'), 'no element made from a nickname').toBeNull();
    expect(question.textContent).toBe('Evolve <i>Kip</i> into Emberfang?');

    // The confirm gives way to the path list with focus on the shared list: focus stays in the
    // sheet, the heading names the monster again (uif-7: one sheet, one heading).
    answers.focus();
    expect(document.activeElement, 'fixture: focus is on the sheet`s list').toBe(answers);
    view.paint(evolvePaint(C8C_TWO_CHOICES, '30'));
    expect(question.textContent, 'the heading names the monster again').toBe('Kip');
    expect(
      root.querySelectorAll('[id="monstersSheet-root-yes"]'),
      'the Yes / No rows are gone',
    ).toHaveLength(0);
    expect(c8bHidden(list, root), 'the Evolve list shows again').toBe(false);
    expect(
      (document.activeElement as HTMLElement).closest('[data-context-sheet]'),
      'focus stays in the sheet while its content swaps',
    ).not.toBeNull();

    // The sheet closes with focus in it: it is hidden and emptied, focus goes to the title anchor.
    view.paint(c8bPaint({ tab: 'party', activeKey: '100' }));
    expect(c8bHidden(question, root), 'the heading is hidden').toBe(true);
    expect(question.textContent, 'and empty').toBe('');
    expect(c8bHidden(answers, root), 'the list is hidden').toBe(true);
    expect(answers.textContent, 'and empty').toBe('');
    expect(document.activeElement, 'focus goes to the title anchor').toBe(c8bAnchor(root));

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
      // uif-7 (UIF7.2): the sheet's seventh row is Close, from the kit's catalog id.
      for (const key of [
        'box.sheet.care',
        'box.sheet.feed',
        'box.sheet.evolve',
        'box.sheet.feedNone',
        'evolution.card.noPaths',
        'kit.sheet.close',
      ]) {
        expect(joined, `«${key}» is rendered`).toContain(`«${key}»`);
      }
      expect(c8cSpanParams(joined, 'box.feedback.fed')).toEqual([{ name: 'Kip' }]);

      // uif-7 (UIF7.3): the lists and the confirm are painted as the screen paints them, with no
      // sheet beside them (one content at a time); the lists end with the kit's Back row.
      view.paint(
        c8bPaint({
          tab: 'party',
          activeKey: '100',
          sheet: null,
          feed: { foods: [{ itemId: 7, name: 'Bait', count: 3 }], activeKey: '7' },
        }),
      );
      joined = walk('the food list');
      expect(c8cSpanParams(joined, 'box.feed.item')).toEqual([{ name: 'Bait', count: 3 }]);
      expect(joined, '«kit.sheet.back» ends the food list').toContain('«kit.sheet.back»');

      view.paint(
        c8bPaint({
          tab: 'party',
          activeKey: '100',
          sheet: null,
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
          sheet: null,
          evolve: { mon: C8C_ONE_READY, activeKey: '10' },
        }),
      );
      joined = walk('the Evolve list with one ready path');
      expect(c8cSpanParams(joined, 'evolution.card.ready')).toEqual([{ species: 'Duskling' }]);
      expect(joined, '«kit.sheet.back» ends the Evolve list').toContain('«kit.sheet.back»');

      view.paint(
        c8bPaint({
          tab: 'party',
          activeKey: '100',
          sheet: null,
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

// =============================================================================
// ctl-10a (CTL10A.4): Monsters offers no Heal Party control; healing happens only at a bound healer.
// =============================================================================

describe('BoxView ctl-10a: no Heal Party control (CTL10A.4)', () => {
  it('CTL10A-4-NO-HEAL-CONTROL: a BoxView constructed WITHOUT onHealParty and shown (both lists drawn, then a sheet with the typing row open, then reopened) renders no button reading Heal Party, no Heal Party text anywhere in its root, and never resolves box.heal', () => {
    // WRONG IMPL KILLED (B13): the Box Heal Party button kept (it heals at the store's first
    // location, never at the healer the player stands at), kept with its label from a literal,
    // kept only while the typing row is closed, kept as a disabled control, or brought back by a
    // reopen.
    vi.mocked(i18nT).mockClear();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const callbacks: BoxViewCallbacks = {
      onSetNickname: vi.fn(),
      onSetPartySlot: vi.fn(),
      partySlotNone: BOX_SLOT,
    };
    const view = new BoxView(parent, callbacks);
    view.refresh(makePartySlots(), [makeBoxRecruitCard()]);
    view.show();
    const root = s4BoxRootOf(parent);
    const buttonTexts = (): string[] =>
      [...root.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim());

    // qf-8 (named intentional change): the control was "the frame renders its real buttons" (the
    // cards' To Box / To Party, now deleted). The control is the drawn frame itself: the Box
    // recruit's species is in the root, so the absence clauses below read a painted frame.
    expect(root.textContent ?? '', 'control: the frame drew its lists').toContain('Emberfang');
    expect(buttonTexts(), 'qf-8: the frame renders no button at all').toEqual([]);
    expect(buttonTexts(), 'no Heal Party button').not.toContain('Heal Party');
    expect(root.textContent ?? '', 'no Heal Party text anywhere in the frame').not.toContain(
      'Heal Party',
    );
    expect(i18nT, 'box.heal is never resolved').not.toHaveBeenCalledWith('box.heal');

    view.paint(
      c8bPaint({
        tab: 'party',
        activeKey: '100',
        sheet: c8bSheet(makePartyCard(), 'nickname'),
        nickname: { card: makePartyCard(), edit: 1 },
      }),
    );
    expect(buttonTexts(), 'nor with the sheet and the typing row open').not.toContain('Heal Party');
    expect(root.textContent ?? '').not.toContain('Heal Party');

    view.hide();
    view.show();
    expect(buttonTexts(), 'nor after a reopen').not.toContain('Heal Party');
    expect(root.textContent ?? '').not.toContain('Heal Party');
    expect(i18nT, 'box.heal is never resolved, on any path').not.toHaveBeenCalledWith('box.heal');
  });
});

// =============================================================================
// polish-1 P2: a store batch that leaves the box view model unchanged keeps its card and button
// nodes.
//
// EARS: WHEN the box view model is unchanged across a store batch, THE CLIENT SHALL keep its card
// and button nodes.
//
// main.ts builds FRESH arrays of FRESH card objects on every batch and calls `refresh(party, box)`,
// so "unchanged" is deep equality, never reference identity: every roster below comes from the
// `p2*` factories, which return new objects on every call. RED REASON today: `refresh()` runs
// `#renderParty` / `#renderBox`, which `replaceChildren()` their grid and rebuild every card and
// button, so no node survives a second refresh and a focused button loses focus. The changed-vm
// cases and the cursor case pass today (they pin what the keep must not break).
//
// qf-8 (named intentional change): the cards build no button any more (To Box / To Party are
// deleted, QF8.1), so "card and button nodes" reads "card nodes" here: the focused node the keep
// must not drop is a card (happy-dom focuses a bare div), and the handler-rebinding case is
// retired below with its reason and survivors.
// =============================================================================

const p2Kip = (over: Partial<MonsterCardViewModel> = {}): MonsterCardViewModel =>
  makeCard({
    monsterId: 100n,
    speciesName: 'Sproutle',
    nickname: 'Kip',
    level: 5,
    currentHp: 18,
    statHp: 20,
    hpPercent: 90,
    partySlot: 0,
    evolutionChoicePending: false,
    ...over,
  });
const p2Moss = (over: Partial<MonsterCardViewModel> = {}): MonsterCardViewModel =>
  makeCard({
    monsterId: 101n,
    speciesName: 'Mossling',
    nickname: '',
    level: 4,
    currentHp: 12,
    statHp: 20,
    hpPercent: 60,
    partySlot: 1,
    evolutionChoicePending: false,
    ...over,
  });
const p2Ember = (over: Partial<MonsterCardViewModel> = {}): MonsterCardViewModel =>
  makeCard({
    monsterId: 200n,
    speciesName: 'Emberfang',
    nickname: '',
    level: 7,
    currentHp: 21,
    statHp: 21,
    hpPercent: 100,
    partySlot: BOX_SLOT,
    evolutionChoicePending: false,
    ...over,
  });
const p2Dusk = (over: Partial<MonsterCardViewModel> = {}): MonsterCardViewModel =>
  makeCard({
    monsterId: 300n,
    speciesName: 'Duskling',
    nickname: '',
    level: 3,
    currentHp: 9,
    statHp: 15,
    hpPercent: 60,
    partySlot: BOX_SLOT,
    evolutionChoicePending: false,
    ...over,
  });

interface P2Rosters {
  party: (MonsterCardViewModel | null)[];
  box: MonsterCardViewModel[];
}
/** A FRESH deep-equal roster every call: two filled party slots, four null ones, two box monsters. */
const p2Base = (): P2Rosters => ({
  party: [p2Kip(), p2Moss(), null, null, null, null],
  box: [p2Ember(), p2Dusk()],
});

/** The stats line a card shows, resolved the way the view resolves it. */
const p2Stats = (c: MonsterCardViewModel): string =>
  i18nTf('box.card.stats', {
    species: c.speciesName,
    level: c.level,
    current: c.currentHp,
    max: c.statHp,
    percent: c.hpPercent,
  });
const p2Name = (c: MonsterCardViewModel): string => c.nickname || c.speciesName;

/** Every element under `grid`, in document order: the strongest "same nodes" probe. */
const p2Elements = (grid: Element): Element[] => Array.from(grid.querySelectorAll('*'));

/** Spies (call-through) on every DOM-mutating method of `el`; the calls are read, then restored. */
function p2SpyDomWrites(el: HTMLElement): { calls: () => unknown[][]; restore: () => void } {
  const spies = (
    ['replaceChildren', 'appendChild', 'removeChild', 'insertBefore', 'append', 'prepend'] as const
  ).map((name) => vi.spyOn(el, name as 'appendChild'));
  return {
    calls: () => spies.flatMap((s) => s.mock.calls as unknown[][]),
    restore: () => {
      for (const s of spies) s.mockRestore();
    },
  };
}

/** A canonical, attribute-order-independent serialisation of a subtree (tag, sorted attributes with
 *  class tokens and style declarations sorted, children): two DOMs that look the same compare equal
 *  whichever way they were built or updated. */
function p2Serialize(node: Node): string {
  if (node.nodeType === 3) return JSON.stringify(node.textContent ?? '');
  if (node.nodeType !== 1) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const attrs = Array.from(el.attributes)
    .map((a) => {
      if (a.name === 'style') {
        const decls = a.value
          .split(';')
          .map((s) => s.trim())
          .filter((s) => s !== '')
          .sort();
        return `style=[${decls.join(';')}]`;
      }
      if (a.name === 'class') {
        const tokens = a.value.split(' ').filter((s) => s !== '');
        return `class=[${tokens.sort().join(' ')}]`;
      }
      return `${a.name}=${JSON.stringify(a.value)}`;
    })
    .sort();
  return `<${tag} ${attrs.join(' ')}>${Array.from(el.childNodes).map(p2Serialize).join('')}</${tag}>`;
}

/** Both grids of a mounted, shown view, serialised. */
function p2Snapshot(parent: HTMLElement): { party: string; box: string } {
  return {
    party: p2Serialize(partyGridOf(parent)),
    box: p2Serialize(boxGridOf(parent)),
  };
}

/** The oracle: what a brand-new view shows for `rosters`, painted on the Party tab. */
function p2FreshSnapshot(rosters: P2Rosters): { party: string; box: string } {
  const { parent, view } = c8bMount();
  view.refresh(rosters.party, rosters.box);
  view.show();
  view.paint(c8bPaint({ tab: 'party' }));
  const snapshot = p2Snapshot(parent);
  view.hide();
  return snapshot;
}

describe('BoxView polish-1 P2: an unchanged view model keeps its card nodes', () => {
  it('POLISH1-P2-KEEP-NODES: refresh() again with FRESH deep-equal rosters keeps every card, slot and element node (the null party slots included), keeps a focused card focused, and writes nothing into either grid', async () => {
    // WRONG IMPL KILLED: the current replaceChildren() + rebuild (no node survives, focus falls to
    // the title anchor); a "keep" that re-appends the same nodes (identity holds but a browser drops
    // focus on remove + insert: caught by the zero DOM-write clause); a keep keyed on the array
    // REFERENCES (main.ts hands new arrays per batch, so it never keeps); a keep for the cards
    // only that still rebuilds the null slots or a card's inner lines.
    // qf-8 (named removal): the "kept To Box / To Party buttons still work for their card's
    // monster" clauses left with the buttons. Survivor for the move commands:
    // monstersScreen.test.ts CTL8B-2-MOVE-COMMAND (Move from Storage sends -1, from the Party the
    // injected `partySlotNone`).
    const { parent, view } = c8bMount();
    view.refresh(p2Base().party, p2Base().box);
    view.show();
    view.paint(c8bPaint({ tab: 'party' }));
    await s4FlushMacrotask(); // show()'s deferred anchor focus lands before the player focuses a card

    const party = partyGridOf(parent);
    const box = boxGridOf(parent);
    const slotsBefore = [...Array.from(party.children), ...Array.from(box.children)];
    // uif-6 (named intentional change, UIF6.8): an empty Party slot now carries
    // `data-nav-key="slot-<i>"`, so "the monster cards" filter the slot cells out (they are still
    // covered, as slots and as elements, by the slot and element identity clauses below).
    const monsterCards = (): HTMLElement[] =>
      [...c8bCards(party), ...c8bCards(box)].filter(
        (el) => !(el.dataset.navKey ?? '').startsWith('slot-'),
      );
    const cardsBefore = monsterCards();
    const elementsBefore = [...p2Elements(party), ...p2Elements(box)];
    expect(slotsBefore, 'six party slots (two cards, four null) and two box cards').toHaveLength(8);
    expect(cardsBefore, 'four monster cards carry a nav key').toHaveLength(4);
    expect(
      [...party.querySelectorAll('button'), ...box.querySelectorAll('button')],
      'qf-8: no card builds a button',
    ).toEqual([]);

    const focused = cardsBefore[0] as HTMLElement;
    focused.focus();
    expect(document.activeElement, 'precondition: the first Party card holds focus').toBe(focused);

    const writes = [p2SpyDomWrites(party), p2SpyDomWrites(box)];
    try {
      for (let batch = 0; batch < 3; batch += 1) {
        const fresh = p2Base();
        view.refresh(fresh.party, fresh.box);
        await s4FlushMacrotask();
        const slots = [...Array.from(party.children), ...Array.from(box.children)];
        expect(slots, `batch ${batch}: the slot count`).toHaveLength(slotsBefore.length);
        slots.forEach((el, i) => {
          expect(el, `batch ${batch}: slot ${i} is the identical node`).toBe(slotsBefore[i]);
        });
        const cards = monsterCards();
        cards.forEach((el, i) => {
          expect(el, `batch ${batch}: card ${i} is the identical node`).toBe(cardsBefore[i]);
        });
        const elements = [...p2Elements(party), ...p2Elements(box)];
        expect(elements, `batch ${batch}: the element count`).toHaveLength(elementsBefore.length);
        elements.forEach((el, i) => {
          expect(el, `batch ${batch}: element ${i} is the identical node`).toBe(elementsBefore[i]);
        });
        expect(document.activeElement, `batch ${batch}: the focused card keeps focus`).toBe(
          focused,
        );
      }
      expect(
        writes.flatMap((w) => w.calls()),
        'an unchanged roster performs no DOM insertion or removal in either grid',
      ).toEqual([]);
    } finally {
      for (const w of writes) w.restore();
    }
  });

  it('POLISH1-P2-KEEP-NODES-STORAGE-EMPTY: on the Storage tab a focused Box card survives an equal refresh, and an EMPTY box keeps its "no monsters" node across equal refreshes', async () => {
    // WRONG IMPL KILLED: a keep that only covers the party grid; a keep that skips the box grid's
    // focused card; an empty-box branch (the early return in #renderBox) that rebuilds its line
    // on every batch because it sits outside the keep.
    // qf-8 (named intentional change): the focused node is the second Box card (it was that
    // card's To Party button, deleted with QF8.1).
    const { parent, view } = c8bMount();
    view.refresh(p2Base().party, p2Base().box);
    view.show();
    view.paint(c8bPaint({ tab: 'storage' }));
    await s4FlushMacrotask();

    const box = boxGridOf(parent);
    const cardsBefore = c8bCards(box);
    expect(cardsBefore, 'precondition: two Box cards carry a nav key').toHaveLength(2);
    const second = cardsBefore[1] as HTMLElement;
    second.focus();
    expect(document.activeElement, 'precondition: the second Box card holds focus').toBe(second);

    const fresh = p2Base();
    view.refresh(fresh.party, fresh.box);
    const cardsAfter = c8bCards(box);
    expect(cardsAfter, 'the Box card count').toHaveLength(cardsBefore.length);
    cardsAfter.forEach((el, i) => {
      expect(el, `box card ${i} is the identical node`).toBe(cardsBefore[i]);
    });
    expect(document.activeElement, 'the focused Box card keeps focus').toBe(second);

    // The empty box: one line, kept across equal refreshes.
    view.refresh(p2Base().party, []);
    // uif-6 (named intentional change, UIF6.6): the empty Storage is an EmptyState (a root plus its
    // reason, cue and next-step lines), so the reason line is read from `.mr-empty-reason` and the
    // kept nodes are all four elements (was: one line element).
    expect(
      box.querySelector('.mr-empty-reason')?.textContent,
      'precondition: the box is empty now',
    ).toBe(i18nT('box.box.empty'));
    const lineBefore = Array.from(box.querySelectorAll('*'));
    expect(lineBefore, 'precondition: the EmptyState is a root and three lines').toHaveLength(4);
    view.refresh(p2Base().party, []);
    view.refresh(p2Base().party, []);
    const lineAfter = Array.from(box.querySelectorAll('*'));
    expect(lineAfter).toHaveLength(4);
    lineAfter.forEach((el, i) => {
      expect(el, `the empty-state element ${i} is the identical node`).toBe(lineBefore[i]);
    });
  });

  interface P2Case {
    readonly name: string;
    /** True for an edit whose field may not be drawn at all (hpPercent feeds only the stats
     *  line's optional percent): the "the DOM changed" precondition is skipped for it. */
    readonly mayBeInvisible?: boolean;
    readonly from: () => P2Rosters;
    readonly to: () => P2Rosters;
    readonly check: (ctx: {
      party: HTMLElement;
      box: HTMLElement;
      from: P2Rosters;
      to: P2Rosters;
    }) => void;
  }

  /** `base` with the first party card (`where` 'party') or the first box card edited by `over`. */
  const p2Edit = (
    where: 'party' | 'box',
    over: Partial<MonsterCardViewModel>,
    base: P2Rosters,
  ): P2Rosters => {
    const next: P2Rosters = { party: [...base.party], box: [...base.box] };
    if (where === 'party') {
      next.party[0] = { ...(base.party[0] as MonsterCardViewModel), ...over };
    } else {
      next.box[0] = { ...(base.box[0] as MonsterCardViewModel), ...over };
    }
    return next;
  };
  const firstOf = (where: 'party' | 'box', r: P2Rosters): MonsterCardViewModel =>
    (where === 'party' ? r.party[0] : r.box[0]) as MonsterCardViewModel;

  const FIELD_EDITS: ReadonlyArray<readonly [string, Partial<MonsterCardViewModel>]> = [
    ['currentHp only', { currentHp: 7 }],
    ['statHp only', { statHp: 25 }],
    ['hpPercent only', { hpPercent: 35 }],
    ['level only', { level: 6 }],
    ['nickname only', { nickname: 'Rex' }],
    ['speciesName only', { speciesName: 'Thornling' }],
  ];

  const fieldCases: P2Case[] = (['party', 'box'] as const).flatMap((where) =>
    FIELD_EDITS.map(
      ([label, over]): P2Case => ({
        name: `${where} card, ${label}`,
        mayBeInvisible: label === 'hpPercent only',
        from: p2Base,
        to: () => p2Edit(where, over, p2Base()),
        check: ({ party, box, from, to }) => {
          const grid = where === 'party' ? party : box;
          const was = firstOf(where, from);
          const now = firstOf(where, to);
          expect(grid.textContent ?? '', 'the new stats line shows').toContain(p2Stats(now));
          expect(grid.textContent ?? '', 'the new name shows').toContain(p2Name(now));
          if (p2Stats(was) !== p2Stats(now)) {
            expect(grid.textContent ?? '', 'the old stats line is gone').not.toContain(
              p2Stats(was),
            );
          }
          if (was.nickname !== '' && was.nickname !== now.nickname) {
            expect(grid.textContent ?? '', 'the old nickname is gone').not.toContain(was.nickname);
          }
        },
      }),
    ),
  );

  const badgeCases: P2Case[] = (['party', 'box'] as const).flatMap((where) =>
    [true, false].map(
      (pending): P2Case => ({
        name: `${where} card, evolutionChoicePending ${String(!pending)} -> ${String(pending)} only`,
        from: () => p2Edit(where, { evolutionChoicePending: !pending }, p2Base()),
        to: () => p2Edit(where, { evolutionChoicePending: pending }, p2Base()),
        check: ({ party, box }) => {
          const grid = where === 'party' ? party : box;
          const other = where === 'party' ? box : party;
          expect(
            grid.querySelectorAll(EVO_BADGE_SELECTOR),
            pending ? 'the badge appears on the card' : 'the badge is gone from the card',
          ).toHaveLength(pending ? 1 : 0);
          expect(
            other.querySelectorAll(EVO_BADGE_SELECTOR),
            'the other grid has none',
          ).toHaveLength(0);
        },
      }),
    ),
  );

  const structuralCases: P2Case[] = [
    {
      name: 'a monster id changes at the same position',
      from: p2Base,
      to: () => p2Edit('party', { monsterId: 150n }, p2Base()),
      check: ({ party }) => {
        expect(c8bKeys(party), 'the card is keyed by its new id').toEqual(['150', '101']);
      },
    },
    {
      name: 'a monster moves from the box to a party slot',
      from: p2Base,
      to: () => ({
        party: [p2Kip(), p2Moss(), p2Ember({ partySlot: 2 }), null, null, null],
        box: [p2Dusk()],
      }),
      check: ({ party, box }) => {
        expect(c8bKeys(party)).toEqual(['100', '101', '200']);
        expect(c8bKeys(box)).toEqual(['300']);
        expect(party.textContent ?? '').toContain(p2Stats(p2Ember({ partySlot: 2 })));
        expect(box.textContent ?? '', 'no stale Emberfang in the box').not.toContain('Emberfang');
        expect(party.textContent ?? '', 'slot 2 is no longer an empty slot').not.toContain(
          i18nTf('box.party.emptySlot', { slot: 2 }),
        );
        expect(party.textContent ?? '', 'slot 3 still is').toContain(
          i18nTf('box.party.emptySlot', { slot: 3 }),
        );
      },
    },
    {
      name: 'a monster moves from the party to the box',
      from: p2Base,
      to: () => ({
        party: [p2Kip(), null, null, null, null, null],
        box: [p2Ember(), p2Dusk(), p2Moss({ partySlot: BOX_SLOT })],
      }),
      check: ({ party, box }) => {
        expect(c8bKeys(party)).toEqual(['100']);
        expect(c8bKeys(box)).toEqual(['200', '300', '101']);
        expect(party.textContent ?? '', 'no stale Mossling in the party').not.toContain('Mossling');
        expect(party.textContent ?? '', 'slot 1 is an empty slot now').toContain(
          i18nTf('box.party.emptySlot', { slot: 1 }),
        );
      },
    },
    {
      name: 'the box becomes empty',
      from: p2Base,
      to: () => ({ party: p2Base().party, box: [] }),
      check: ({ box }) => {
        expect(c8bKeys(box), 'no cards').toEqual([]);
        // uif-6 (named intentional change, UIF6.6): the empty Storage is an EmptyState (reason, cue
        // and next step), so the grid holds the reason line, not that line alone.
        expect(box.querySelector('.mr-empty-reason')?.textContent, 'the empty reason line').toBe(
          i18nT('box.box.empty'),
        );
      },
    },
    {
      name: 'the box fills from empty',
      from: () => ({ party: p2Base().party, box: [] }),
      to: () => ({ party: p2Base().party, box: [p2Ember()] }),
      check: ({ box }) => {
        expect(c8bKeys(box)).toEqual(['200']);
        expect(box.textContent ?? '', 'the empty line is gone').not.toContain(
          i18nT('box.box.empty'),
        );
      },
    },
    {
      name: 'two party monsters swap slots',
      from: p2Base,
      to: () => ({
        party: [p2Moss({ partySlot: 0 }), p2Kip({ partySlot: 1 }), null, null, null, null],
        box: [p2Ember(), p2Dusk()],
      }),
      check: ({ party }) => {
        expect(c8bKeys(party), 'the cards follow the new order').toEqual(['101', '100']);
      },
    },
    {
      name: 'a null party slot fills',
      from: p2Base,
      to: () => ({
        party: [p2Kip(), p2Moss(), null, p2Dusk({ partySlot: 3 }), null, null],
        box: [p2Ember()],
      }),
      check: ({ party, box }) => {
        expect(c8bKeys(party)).toEqual(['100', '101', '300']);
        expect(c8bKeys(box)).toEqual(['200']);
        expect(party.textContent ?? '', 'slot 3 is no longer empty').not.toContain(
          i18nTf('box.party.emptySlot', { slot: 3 }),
        );
      },
    },
  ];

  it.each(
    [...fieldCases, ...badgeCases, ...structuralCases].map((c) => [c.name, c] as const),
  )('POLISH1-P2-CHANGED-REBUILDS: %s -> the new content shows in the right grid, no stale node', (_name, c) => {
    // WRONG IMPL KILLED: a keep keyed on a subset of the card fields (omitting currentHp, statHp,
    // hpPercent, level, nickname, speciesName, evolutionChoicePending or monsterId leaves the
    // stale node showing: every one of those is edited ALONE here, in a party and a box card); a
    // keep keyed on the card COUNT or the monster ids; a keep that skips the empty-slot / empty-box
    // branches; a changed refresh that updates one grid only. The oracle compares the kept view's
    // two grids, canonically serialised, with a brand-new view painted from the same changed
    // rosters, so a stale attribute or a stray node anywhere reads as a difference.
    const from = c.from();
    const to = c.to();
    const expected = p2FreshSnapshot(c.to());

    const { parent, view } = c8bMount();
    view.refresh(from.party, from.box);
    view.show();
    view.paint(c8bPaint({ tab: 'party' }));
    const before = p2Snapshot(parent);
    if (c.mayBeInvisible !== true) {
      expect(before, 'precondition: the first roster differs from the changed one').not.toEqual(
        expected,
      );
    }

    view.refresh(to.party, to.box);
    expect(p2Snapshot(parent), 'the kept view shows exactly what a fresh view shows').toEqual(
      expected,
    );
    c.check({ party: partyGridOf(parent), box: boxGridOf(parent), from: c.from(), to: c.to() });
  });

  // qf-8 (NAMED REMOVAL): POLISH1-P2-CHANGED-REBUILDS-HANDLERS ("after a card's monster id
  // changes, its buttons act on the NEW id") is RETIRED: the card's To Box / To Party buttons and
  // their click closures are deleted (QF8.1), so no per-card handler is left to go stale. What
  // survives of its claim: the kept card is re-keyed to the new id, POLISH1-P2-CHANGED-REBUILDS
  // "a monster id changes at the same position" (above); and the Move acts on the monster the
  // sheet was opened for, monstersScreen.test.ts CTL8B-2-MOVE-COMMAND.

  it('POLISH1-P2-CURSOR-SURVIVES: the kept paint (the cursor card`s is-active, aria-current and outline) is still applied after an equal refresh, after a changed one, and for the first-card default', () => {
    // WRONG IMPL KILLED: a keep that skips #apply() after an unchanged refresh and so loses a mark
    // a rebuild would have re-applied; a keep that leaves the OLD cursor card marked as well; a
    // changed refresh whose rebuilt card is not re-marked; a null key that no longer defaults to
    // the first card of the tab.
    const { parent, view, root } = c8bMount();
    view.refresh(p2Base().party, p2Base().box);
    view.show();
    view.paint(c8bPaint({ tab: 'party', activeKey: '101' }));

    const expectCursor = (key: string, when: string): HTMLElement => {
      const marked = c8bMarked(root);
      expect(marked, `${when}: exactly one aria-current`).toHaveLength(1);
      const card = marked[0] as HTMLElement;
      expect(card.dataset.navKey, `${when}: the card of key ${key}`).toBe(key);
      expect(card.classList.contains('is-active'), `${when}: is-active`).toBe(true);
      expect(card.style.outline, `${when}: the outline (never colour alone)`).not.toBe('');
      for (const other of [...c8bCards(partyGridOf(parent)), ...c8bCards(boxGridOf(parent))]) {
        if (other !== card) {
          expect(other.classList.contains('is-active'), `${when}: ${other.dataset.navKey}`).toBe(
            false,
          );
        }
      }
      return card;
    };

    const cursorBefore = expectCursor('101', 'painted');
    view.refresh(p2Base().party, p2Base().box);
    view.refresh(p2Base().party, p2Base().box);
    const cursorAfter = expectCursor('101', 'after equal refreshes');
    expect(cursorAfter, 'and it is the very card node that was marked').toBe(cursorBefore);

    // A changed card keeps the cursor on its key.
    view.refresh(
      [p2Kip(), p2Moss({ currentHp: 3, hpPercent: 15 }), null, null, null, null],
      [p2Ember(), p2Dusk()],
    );
    const changed = expectCursor('101', 'after the cursor card changed');
    expect(changed.textContent ?? '', 'and it shows the new stats').toContain(
      p2Stats(p2Moss({ currentHp: 3, hpPercent: 15 })),
    );

    // Storage tab, a box card; then no key at all: the first card of the tab.
    view.paint(c8bPaint({ tab: 'storage', activeKey: '300' }));
    view.refresh(p2Base().party, p2Base().box);
    expectCursor('300', 'storage 300 after an equal refresh');
    view.paint(c8bPaint({ tab: 'party', activeKey: null }));
    view.refresh(p2Base().party, p2Base().box);
    expectCursor('100', 'no key: the first party card, after an equal refresh');
  });
});

// =============================================================================
// polish-1 P2, round 2: the "unchanged" key must be exact (no delimiter collisions across fields or
// cards), a build that throws must not poison the key, and the cards' copy follows the locale.
// =============================================================================

import { CATALOG_EN as P2_CATALOG_EN } from './i18n/catalog.en';
import { CATALOG_FR as P2_CATALOG_FR } from './i18n/catalog.fr';
import { setLocale as p2SetLocale } from './i18n/resolver';

describe('BoxView polish-1 P2 round 2: exact keep key, throw recovery, locale', () => {
  const rosters = (
    party0: MonsterCardViewModel,
    box: MonsterCardViewModel[] = [p2Ember(), p2Dusk()],
  ): P2Rosters => ({ party: [party0, p2Moss(), null, null, null, null], box });

  it.each([
    [
      'species "A|B" + nickname "C" vs species "A" + nickname "B|C"',
      () => rosters(p2Kip({ speciesName: 'A|B', nickname: 'C' })),
      () => rosters(p2Kip({ speciesName: 'A', nickname: 'B|C' })),
    ],
    [
      'nickname "1" + species "2,3" vs nickname "1,2" + species "3"',
      () => rosters(p2Kip({ nickname: '1', speciesName: '2,3' })),
      () => rosters(p2Kip({ nickname: '1,2', speciesName: '3' })),
    ],
    [
      'species "Sp5" + level 1 vs species "Sp" + level 51 (digits spill across fields)',
      () => rosters(p2Kip({ speciesName: 'Sp5', level: 1 })),
      () => rosters(p2Kip({ speciesName: 'Sp', level: 51 })),
    ],
    [
      'hp 1 of 120 vs hp 11 of 20 (digits spill across fields)',
      () => rosters(p2Kip({ currentHp: 1, statHp: 120 })),
      () => rosters(p2Kip({ currentHp: 11, statHp: 20 })),
    ],
    [
      'two box cards with nicknames "A|" + "B" vs "A" + "|B" (collide across cards)',
      () => rosters(p2Kip(), [p2Ember({ nickname: 'A|' }), p2Dusk({ nickname: 'B' })]),
      () => rosters(p2Kip(), [p2Ember({ nickname: 'A' }), p2Dusk({ nickname: '|B' })]),
    ],
    [
      'two box cards with ids 1 + 23 vs 12 + 3 (only the nav keys differ)',
      () => rosters(p2Kip(), [p2Ember({ monsterId: 1n }), p2Dusk({ monsterId: 23n })]),
      () => rosters(p2Kip(), [p2Ember({ monsterId: 12n }), p2Dusk({ monsterId: 3n })]),
    ],
    [
      'quote / backslash nicknames that spell a JSON split across two cards',
      () => rosters(p2Kip(), [p2Ember({ nickname: 'a","b' }), p2Dusk({ nickname: 'c' })]),
      () => rosters(p2Kip(), [p2Ember({ nickname: 'a' }), p2Dusk({ nickname: 'b","c' })]),
    ],
  ])('POLISH1-P2-KEY-COLLISION: %s -> the new text shows', (_name, from, to) => {
    // WRONG IMPL KILLED: a key built by join('|') / join(',') / concatenation of the card fields:
    // the two rosters give the same key string, the second refresh is wrongly skipped and the stale
    // card text stays. The oracle is a brand-new view painted from the second roster.
    const first = from();
    const second = to();
    const expected = p2FreshSnapshot(to());
    const { parent, view } = c8bMount();
    view.refresh(first.party, first.box);
    view.show();
    view.paint(c8bPaint({ tab: 'party' }));
    expect(p2Snapshot(parent), 'precondition: the two rosters render differently').not.toEqual(
      expected,
    );
    view.refresh(second.party, second.box);
    expect(p2Snapshot(parent), 'the kept view shows what a fresh view shows').toEqual(expected);
  });

  /** `document.createElement` made to throw on its `nth` call for a <span> (1-based), once.
   *  qf-8: was the nth <button>; each card built ONE button (To Box / To Party, deleted by QF8.1)
   *  and builds ONE <span> (its bold name), so the same nth faults the same card mid-build. If a
   *  card ever stops building a span, the "fixture: the fault fired" clause below goes red. */
  function p2ThrowOnNameSpan(nth: number): { restore: () => void; thrown: () => boolean } {
    const real = document.createElement.bind(document);
    let seen = 0;
    let thrown = false;
    const spy = vi.spyOn(document, 'createElement').mockImplementation(((
      tag: string,
      options?: ElementCreationOptions,
    ) => {
      if (tag === 'span') {
        seen += 1;
        if (seen === nth) {
          thrown = true;
          throw new Error('p2: build failed');
        }
      }
      return real(tag, options);
    }) as typeof document.createElement);
    return { restore: () => spy.mockRestore(), thrown: () => thrown };
  }

  it.each([
    ['party', 'changed', 2],
    ['party', 'previous', 2],
    ['box', 'changed', 1],
    ['box', 'previous', 1],
  ] as const)('POLISH1-P2-THROW-RECOVERY: a %s build that throws surfaces, and refreshing the %s roster again rebuilds the right content', (grid, which, nth) => {
    // WRONG IMPL KILLED: a key recorded BEFORE the build (the retry with the same roster is skipped
    // and the half-built grid stays); a key NOT cleared before the build (the previous roster's key
    // still matches, so refreshing the previous roster is skipped while the grid holds half of the
    // new one); a swallowed throw.
    const previousRosters = (): P2Rosters => p2Base();
    const changedRosters = (): P2Rosters =>
      grid === 'party'
        ? {
            party: [p2Kip({ currentHp: 7 }), p2Moss({ nickname: 'Mo' }), null, null, null, null],
            box: p2Base().box,
          }
        : { party: p2Base().party, box: [p2Ember({ currentHp: 5 }), p2Dusk({ level: 9 })] };
    const { parent, view } = c8bMount();
    const base = previousRosters();
    view.refresh(base.party, base.box);
    view.show();
    view.paint(c8bPaint({ tab: 'party' }));

    const fault = p2ThrowOnNameSpan(nth);
    const next = changedRosters();
    try {
      expect(() => view.refresh(next.party, next.box), 'the throw surfaces').toThrow(
        'p2: build failed',
      );
    } finally {
      fault.restore();
    }
    expect(fault.thrown(), 'fixture: the fault fired').toBe(true);

    const retry = which === 'changed' ? changedRosters() : previousRosters();
    const expected = p2FreshSnapshot(which === 'changed' ? changedRosters() : previousRosters());
    view.refresh(retry.party, retry.box);
    expect(p2Snapshot(parent), 'the retry shows the right content').toEqual(expected);

    // Stable again: an equal roster keeps what the recovery built.
    const built = [...p2Elements(partyGridOf(parent)), ...p2Elements(boxGridOf(parent))];
    const again = which === 'changed' ? changedRosters() : previousRosters();
    view.refresh(again.party, again.box);
    const kept = [...p2Elements(partyGridOf(parent)), ...p2Elements(boxGridOf(parent))];
    expect(kept).toHaveLength(built.length);
    kept.forEach((el, i) => {
      expect(el, `element ${i} is kept after the recovery`).toBe(built[i]);
    });
  });

  it('POLISH1-P2-LOCALE: after the locale switches, an EQUAL refresh re-renders the card copy (empty slot, empty box, stats) in the new language', () => {
    // WRONG IMPL KILLED: a key that omits the locale (the equal roster is skipped and every card
    // keeps its old-language empty-slot, empty-box and stats text).
    // qf-8 (named intentional change): the To Box / To Party button copy was this case's party and
    // box witness; the buttons are deleted (QF8.1), so the empty-slot line (party grid) and the
    // stats lines (both grids) carry the locale claim, each checked to differ between en and fr.
    const EN = P2_CATALOG_EN as unknown as Record<string, string>;
    const FR = P2_CATALOG_FR as unknown as Record<string, string>;
    const cards = (): P2Rosters => ({
      party: [p2Kip(), null, null, null, null, null],
      box: [p2Ember()],
    });
    /** The card copy this roster shows, resolved in the CURRENT locale. */
    const copy = (): { slot: string; kip: string; ember: string } => ({
      slot: i18nTf('box.party.emptySlot', { slot: 1 }),
      kip: p2Stats(p2Kip()),
      ember: p2Stats(p2Ember()),
    });
    const { parent, view } = c8bMount();
    const first = cards();
    view.refresh(first.party, first.box);
    view.show();
    view.paint(c8bPaint({ tab: 'party' }));
    const party = partyGridOf(parent);
    const box = boxGridOf(parent);
    try {
      p2SetLocale('en');
      const en = copy();
      p2SetLocale('fr');
      const fr = copy();
      p2SetLocale('en');
      for (const k of ['slot', 'kip', 'ember'] as const) {
        expect(fr[k], `fixture: the ${k} copy differs between fr and en`).not.toBe(en[k]);
      }
      expect(FR['box.box.empty'], 'fixture: box.box.empty differs').not.toBe(EN['box.box.empty']);
      expect(party.textContent ?? '', 'precondition: English empty slot').toContain(en.slot);
      expect(party.textContent ?? '', 'precondition: English stats').toContain(en.kip);
      expect(box.textContent ?? '', 'precondition: English stats').toContain(en.ember);

      p2SetLocale('fr');
      const second = cards();
      view.refresh(second.party, second.box);
      expect(party.textContent ?? '', 'the empty slot copy is French').toContain(fr.slot);
      expect(party.textContent ?? '', 'no English empty slot is left').not.toContain(en.slot);
      expect(party.textContent ?? '', 'the stats copy is French').toContain(fr.kip);
      expect(party.textContent ?? '', 'no English stats are left').not.toContain(en.kip);
      expect(box.textContent ?? '', 'the Box stats copy is French').toContain(fr.ember);
      expect(box.textContent ?? '', 'no English Box stats are left').not.toContain(en.ember);

      // The empty box line: rendered in English first, then an equal refresh under fr.
      // uif-6 (named intentional change, UIF6.6): the empty Storage is an EmptyState; its reason line
      // is the old empty-box line.
      const reasonOf = (): string | null | undefined =>
        box.querySelector('.mr-empty-reason')?.textContent;
      p2SetLocale('en');
      view.refresh(cards().party, []);
      expect(reasonOf()).toBe(EN['box.box.empty']);
      p2SetLocale('fr');
      view.refresh(cards().party, []);
      expect(reasonOf(), 'the empty-box line is French').toBe(FR['box.box.empty']);

      // And back: the switch is not one-way.
      p2SetLocale('en');
      view.refresh(cards().party, []);
      expect(reasonOf()).toBe(EN['box.box.empty']);
      expect(party.textContent ?? '', 'the empty slot copy is English again').toContain(en.slot);
      expect(party.textContent ?? '', 'no French empty slot is left').not.toContain(fr.slot);
    } finally {
      p2SetLocale('en');
    }
  });
});

// =============================================================================
// qf-2 (QF2.1-QF2.3): the Monsters frame's own OUTCOME line. A care / train answer that comes back
// to the frame that invoked it is painted on the frame's feedback line through a sink
// (`feedbackLine()`) bound to the CURRENT open. The sink is the only entry point: the screen's own
// Move / Fed line (`paint({ feedback })`) is a separate source and wins while it is showing.
// =============================================================================

const QF2_OK_TEXT = 'Cared!';
const QF2_ERR_TEXT = 'care: care cooldown not yet elapsed';

/** The `.mr-frame-feedback` lines of the frame that are showing (not hidden, not empty). */
const qf2Shown = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>('.mr-frame-feedback')].filter(
    (el) => !c8bHidden(el, root) && (el.textContent ?? '') !== '',
  );

describe('BoxView qf-2: the outcome line (QF2.1, QF2.2)', () => {
  it('QF2-1-VIEW-OUTCOME-LINE: a sink from an open view paints ONE visible .mr-frame-feedback with the exact text and data-feedback ok | error; markup in the message stays literal text', () => {
    // WRONG IMPL KILLED: no feedbackLine() / a sink that paints nothing (QF2.1: the sheet care
    // outcome is swallowed); a second feedback element beside the screen's (two lines); a kind
    // ignored (an error painted data-feedback="ok" gets the green check mark, a success painted
    // "error" is a red line); a hardcoded text; innerHTML (the server's reason text is
    // untrusted: "<img>" would become a child element); a line left display:none.
    const { view, root } = c8bOpen();
    expect(qf2Shown(root), 'no line before any outcome').toEqual([]);
    expect(
      root.querySelectorAll('.mr-frame-feedback'),
      'one feedback element in the frame',
    ).toHaveLength(1);

    const sink = view.feedbackLine();
    sink(QF2_OK_TEXT, 'ok');
    let lines = qf2Shown(root);
    expect(lines, 'exactly one visible line').toHaveLength(1);
    expect((lines[0] as HTMLElement).textContent).toBe(QF2_OK_TEXT);
    expect((lines[0] as HTMLElement).getAttribute('data-feedback')).toBe('ok');

    sink(QF2_ERR_TEXT, 'error');
    lines = qf2Shown(root);
    expect(lines, 'still one visible line').toHaveLength(1);
    expect((lines[0] as HTMLElement).textContent, 'the later message replaces the earlier').toBe(
      QF2_ERR_TEXT,
    );
    expect((lines[0] as HTMLElement).getAttribute('data-feedback')).toBe('error');
    expect(root.querySelectorAll('.mr-frame-feedback'), 'and never a second element').toHaveLength(
      1,
    );

    const markup = '<img src=x onerror=alert(1)><b>bold</b>';
    sink(markup, 'error');
    lines = qf2Shown(root);
    expect(lines).toHaveLength(1);
    expect((lines[0] as HTMLElement).textContent, 'the markup is literal text').toBe(markup);
    expect((lines[0] as HTMLElement).children.length, 'and builds no child element').toBe(0);
  });

  it('QF2-1-VIEW-HIDDEN-NOOP: a sink called before show() or after hide() paints nothing; hide() clears a painted outcome (a reopen shows none); a sink taken in a previous open no-ops after hide() + show()', () => {
    // WRONG IMPL KILLED: a sink that stores while hidden (the next show() would show a line the
    // player never asked for: the raising stale-message guard, lost); a hide() that keeps the
    // outcome (a reopened Monsters frame opens on last session's "Cared!"); a sink bound to the
    // view instead of the OPEN (a care sent before Backspace and settled after a reopen paints on
    // the new session: the stale line); a no-op guard so strong that the CURRENT open's fresh sink
    // is dead too (control at the end).
    // Before the first show.
    const cold = c8bMount();
    const coldSink = cold.view.feedbackLine();
    coldSink(QF2_OK_TEXT, 'ok');
    expect(qf2Shown(cold.root), 'hidden: nothing painted').toEqual([]);
    cold.view.refresh(c8bParty(), c8bBox());
    cold.view.show();
    expect(qf2Shown(cold.root), 'and nothing was stored for the first open').toEqual([]);

    // After hide().
    const { view, root } = c8bOpen();
    const sink = view.feedbackLine();
    view.hide();
    sink(QF2_ERR_TEXT, 'error');
    view.show();
    expect(qf2Shown(root), 'a sink called while hidden stored nothing').toEqual([]);

    // hide() clears a painted outcome.
    const second = view.feedbackLine();
    second(QF2_OK_TEXT, 'ok');
    expect(qf2Shown(root), 'precondition: the outcome shows').toHaveLength(1);
    view.hide();
    view.show();
    expect(qf2Shown(root), 'hide() cleared the outcome: the reopened frame shows no line').toEqual(
      [],
    );
    expect(
      (root.querySelector('.mr-frame-feedback') as HTMLElement).hasAttribute('data-feedback'),
      'and no data-feedback is left on the empty line',
    ).toBe(false);

    // A sink of a previous open: stale after hide() + show().
    const old = view.feedbackLine();
    view.hide();
    view.show();
    old('stale after reopen', 'error');
    expect(qf2Shown(root), 'the previous open`s sink no-ops').toEqual([]);

    // Control: this open's sink paints.
    const fresh = view.feedbackLine();
    fresh(QF2_OK_TEXT, 'ok');
    const lines = qf2Shown(root);
    expect(lines, 'the current open`s sink still paints').toHaveLength(1);
    expect((lines[0] as HTMLElement).textContent).toBe(QF2_OK_TEXT);
  });

  it('QF2-1-VIEW-KEPT-AND-CLEARED: refresh() and a paint() with no screen feedback keep the outcome; a paint carrying the screen`s own feedback shows that line instead; clearOutcome() ends the outcome (hidden, empty, no data-feedback) and neither a paint nor a refresh brings it back', () => {
    // WRONG IMPL KILLED: a paint() or refresh() that clears the outcome (care success rewrites
    // monster_pub, so the store batch / observe repaint right after the answer would erase it:
    // the very swallow this slice fixes); an outcome that overrides the screen's own Move / Fed
    // line (the player would see "Cared!" while the screen says Fed Kip); a clearOutcome() that
    // only hides the line and lets the next paint redraw the kept outcome (the next button would
    // not end the line); a clear that leaves the old text or data-feedback in the node.
    const { view, root } = c8bOpen();
    const sink = view.feedbackLine();
    sink(QF2_OK_TEXT, 'ok');

    view.refresh(c8bParty(), c8bBox());
    let lines = qf2Shown(root);
    expect(lines, 'refresh() keeps the outcome').toHaveLength(1);
    expect((lines[0] as HTMLElement).textContent).toBe(QF2_OK_TEXT);

    view.paint(c8bPaint({ tab: 'party', activeKey: '101' }));
    lines = qf2Shown(root);
    expect(lines, 'a paint with null feedback keeps the outcome').toHaveLength(1);
    expect((lines[0] as HTMLElement).textContent).toBe(QF2_OK_TEXT);
    expect((lines[0] as HTMLElement).getAttribute('data-feedback')).toBe('ok');

    view.paint(c8bPaint({ tab: 'party', activeKey: '101', feedback: { kind: 'movedToBox' } }));
    lines = qf2Shown(root);
    expect(lines, 'the screen feedback shows alone: one line').toHaveLength(1);
    expect((lines[0] as HTMLElement).textContent, 'and wins over the outcome').toBe(
      c8bT('box.feedback.movedToBox'),
    );
    expect((lines[0] as HTMLElement).getAttribute('data-feedback')).toBe('ok');

    // clearOutcome ends it, for good.
    const cleared = c8bOpen();
    const clearedSink = cleared.view.feedbackLine();
    clearedSink(QF2_ERR_TEXT, 'error');
    expect(qf2Shown(cleared.root), 'precondition: an error outcome shows').toHaveLength(1);
    cleared.view.clearOutcome();
    const line = cleared.root.querySelector('.mr-frame-feedback') as HTMLElement;
    expect(c8bHidden(line, cleared.root), 'the line is hidden').toBe(true);
    expect(line.textContent, 'its text is emptied').toBe('');
    expect(line.hasAttribute('data-feedback'), 'and so is its data-feedback').toBe(false);
    cleared.view.refresh(c8bParty(), c8bBox());
    expect(qf2Shown(cleared.root), 'a refresh does not bring it back').toEqual([]);
    cleared.view.paint(c8bPaint({ tab: 'party', activeKey: '100' }));
    expect(qf2Shown(cleared.root), 'nor does a paint').toEqual([]);
    expect(() => cleared.view.clearOutcome(), 'clearing again is harmless').not.toThrow();
  });

  it('QF2-1-VIEW-REDUNDANT-SHOW: a sink taken from an open view still paints after a redundant show() on the already-visible view (the same open)', () => {
    // WRONG IMPL KILLED: an open counter bumped at the top of show(), above the `wasVisible` early
    // return: main.ts re-shows a visible frame on routine paths (a toggle, a menu step), and every
    // such re-show would make the in-flight sink stale, so the answer of a care sent just before
    // would be swallowed again. The control is a sink taken from a real earlier open (hide + show),
    // which must still be stale.
    const { view, root } = c8bOpen();
    const sink = view.feedbackLine();
    view.show();
    view.show();
    sink(QF2_OK_TEXT, 'ok');
    const lines = qf2Shown(root);
    expect(lines, 'the sink of the same open still paints').toHaveLength(1);
    expect((lines[0] as HTMLElement).textContent).toBe(QF2_OK_TEXT);
    expect((lines[0] as HTMLElement).getAttribute('data-feedback')).toBe('ok');

    const old = view.feedbackLine();
    view.hide();
    view.show();
    old(QF2_ERR_TEXT, 'error');
    expect(qf2Shown(root), 'control: a sink of a real earlier open is stale').toEqual([]);
  });

  it('QF2-1-VIEW-SINK-RESULT: the sink returns true iff it painted: true for a live sink, false while the view is hidden and false for a sink of an earlier open', () => {
    // WRONG IMPL KILLED: a sink that returns nothing (the caller cannot tell a painted answer from
    // a dropped one, so a dropped train rejection cannot fall back to the status line); one that
    // always returns true (the fallback would never fire); one that returns true for a hidden or
    // stale call; one that returns false for a live paint.
    const { view, root } = c8bOpen();
    const sink = view.feedbackLine();
    expect(sink(QF2_OK_TEXT, 'ok'), 'a live sink painted').toBe(true);
    expect(qf2Shown(root), 'precondition: it really painted').toHaveLength(1);
    expect(sink(QF2_ERR_TEXT, 'error'), 'a live sink painted again').toBe(true);

    view.hide();
    expect(sink(QF2_OK_TEXT, 'ok'), 'a hidden view painted nothing').toBe(false);

    view.show();
    expect(sink(QF2_OK_TEXT, 'ok'), 'a sink of an earlier open painted nothing').toBe(false);
    expect(qf2Shown(root), 'and nothing shows').toEqual([]);

    const fresh = view.feedbackLine();
    expect(fresh(QF2_OK_TEXT, 'ok'), 'the current open`s sink paints').toBe(true);

    const cold = c8bMount();
    expect(cold.view.feedbackLine()(QF2_OK_TEXT, 'ok'), 'a never-shown view paints nothing').toBe(
      false,
    );
  });
});

// =============================================================================
// qf-3 (QF3.3, QF3.4): the Care cooldown on the sheet. A paint whose sheet carries a nonzero
// `careRemainingMs` disables the Care row exactly as a no-food paint disables Feed…: the row is
// aria-disabled and .is-disabled and its label is followed by the catalogued reason, here
// `box.sheet.careCooldown` with the remaining time rounded UP to the minute ({hours, minutes}).
// 0n is ready: the bare label, nothing disabled. Located by the nav kit's row ids, as above.
// =============================================================================

/** U+00EA (e circumflex), built by code point so the French hint's first word holds no pasted
 *  glyph. */
const QF3_E_CIRCUMFLEX = String.fromCharCode(0x00ea);

describe('BoxView qf-3: the Care cooldown on the sheet (QF3.3, QF3.4)', () => {
  const careRow = (root: Element): HTMLElement => c8cById(root, 'monstersSheet-root-care');
  const paintCare = (
    view: BoxView,
    careRemainingMs: bigint,
    action: SheetAction = 'care',
    canFeed = true,
    canEvolve = true,
  ): void => {
    view.paint(
      c8bPaint({
        tab: 'party',
        activeKey: '100',
        sheet: c8bSheet(C8B_KIP, action, canFeed, canEvolve, careRemainingMs),
      }),
    );
  };
  const expectCooling = (root: Element, text: string, when: string): void => {
    expect(careRow(root).getAttribute('aria-disabled'), `${when}: aria-disabled`).toBe('true');
    expect(careRow(root).classList.contains('is-disabled'), `${when}: .is-disabled`).toBe(true);
    expect(careRow(root).textContent, `${when}: the label, then the hint`).toBe(text);
  };
  const expectReady = (root: Element, when: string): void => {
    expect(careRow(root).getAttribute('aria-disabled'), `${when}: no aria-disabled`).toBeNull();
    expect(careRow(root).classList.contains('is-disabled'), `${when}: not .is-disabled`).toBe(
      false,
    );
    expect(careRow(root).textContent, `${when}: the bare label`).toBe(i18nT('box.sheet.care'));
  };

  it('a cooling Care row is aria-disabled and .is-disabled and reads its label, a space, then the catalogued hint rounded UP to the minute; the other five rows are untouched [QF3-3-VIEW-CARE-DISABLED]', () => {
    // WRONG IMPL KILLED: a Care row that ignores `careRemainingMs` (enabled while cooling: A on it
    // does nothing and nothing says why, CTL4.3); a disabled row with no reason, or a reason from
    // a literal, rounded down ("0h 0m" with a millisecond left), with minutes not taken modulo 60,
    // or glued to the label; the reason borrowed from Feed's no-food line; a cooldown that also
    // disables Feed… or Evolve… (or their reasons replacing Care's); and the hint left on
    // another row.
    const { root, view } = c8bOpen();
    const cases: ReadonlyArray<readonly [bigint, string]> = [
      [21_540_001n, 'Care Ready in 6h 0m'],
      [21_540_000n, 'Care Ready in 5h 59m'],
      [3_600_001n, 'Care Ready in 1h 1m'],
      [60_000n, 'Care Ready in 0h 1m'],
      [1n, 'Care Ready in 0h 1m'],
    ];
    for (const [ms, english] of cases) {
      paintCare(view, ms);
      expectCooling(root, english, `${ms} ms`);
    }
    // The bytes are the catalog's: the label, one space, the hint.
    paintCare(view, 21_540_001n);
    expect(careRow(root).textContent, 'the resolver`s own text').toBe(
      `${i18nT('box.sheet.care')} ${i18nTf('box.sheet.careCooldown', { hours: 6, minutes: 0 })}`,
    );
    for (const action of ['summary', 'feed', 'evolve', 'nickname', 'move']) {
      const row = c8cById(root, `monstersSheet-root-${action}`);
      expect(row.getAttribute('aria-disabled'), `${action} stays enabled`).toBeNull();
      expect(row.classList.contains('is-disabled'), `${action} stays enabled`).toBe(false);
      expect(row.textContent ?? '', `${action} carries no hint`).not.toContain('Ready in');
    }

    // With no food and no path too: each disabled row keeps its own reason.
    paintCare(view, 60_000n, 'care', false, false);
    expectCooling(root, 'Care Ready in 0h 1m', 'all three disabled');
    expect(c8cById(root, 'monstersSheet-root-feed').textContent ?? '').toMatch(/^Feed.*No food$/);
    expect(c8cById(root, 'monstersSheet-root-evolve').textContent ?? '').toMatch(
      /^Evolve.*No evolution paths\.$/,
    );
  });

  it('under fr the cooling Care row reads the French label and the French hint, with the same rounding [QF3-3-VIEW-CARE-FR]', () => {
    // WRONG IMPL KILLED: a hint written from an English literal (a French boot reads "Ready in");
    // a hint resolved once and cached across a locale switch; the French params swapped (minutes
    // read as hours).
    const FR = P2_CATALOG_FR as unknown as Record<string, unknown>;
    expect(FR['box.sheet.care'], 'fixture: the French Care label').toBe('Choyer');
    const { root, view } = c8bOpen();
    try {
      p2SetLocale('fr');
      paintCare(view, 21_540_001n);
      expectCooling(root, `Choyer Pr${QF3_E_CIRCUMFLEX}t dans 6 h 0 min`, 'fr, 6h 0m');
      paintCare(view, 21_540_000n);
      expectCooling(root, `Choyer Pr${QF3_E_CIRCUMFLEX}t dans 5 h 59 min`, 'fr, 5h 59m');
      p2SetLocale('en');
      paintCare(view, 21_540_000n);
      expectCooling(root, 'Care Ready in 5h 59m', 'back in English');
    } finally {
      p2SetLocale('en');
    }
  });

  it('a ready Care row (0n) is enabled and reads its bare label; a repaint from cooling to ready clears aria-disabled, .is-disabled and the hint, and a refresh keeps whichever was painted [QF3-4-VIEW-CARE-READY]', () => {
    // WRONG IMPL KILLED: a Care row disabled whatever the remaining time (0n read as cooling: A on
    // a ready Care looks refused); a repaint that only ever adds (the hint or the disabled marks
    // linger after the cooldown ends, so the player never sees Care come back); a batch refresh
    // that drops the kept paint's Care state.
    const { root, view } = c8bOpen();
    paintCare(view, 0n);
    expectReady(root, 'ready');
    paintCare(view, 21_540_001n);
    expectCooling(root, 'Care Ready in 6h 0m', 'cooling');
    paintCare(view, 0n);
    expectReady(root, 'ready again');
    expect(root.textContent ?? '', 'no hint is left anywhere in the frame').not.toContain(
      'Ready in',
    );

    paintCare(view, 60_000n, 'summary');
    view.refresh(c8bParty(), c8bBox());
    expectCooling(root, 'Care Ready in 0h 1m', 'cooling, after a refresh');
    paintCare(view, 0n, 'summary');
    view.refresh(c8bParty(), c8bBox());
    expectReady(root, 'ready, after a refresh');
  });

  it('a cooling Care row can be the active row: the painted action `care` marks it is-active and aria-selected while it is aria-disabled [QF3-3-VIEW-CARE-ACTIVE]', () => {
    // WRONG IMPL KILLED: a cooling Care that cannot carry the cursor (the sheet's cursor would
    // vanish or jump to Feed… on the very row the player is reading), and an active mark that
    // clears the disabled one (or the reverse).
    const { root, view } = c8bOpen();
    paintCare(view, 21_540_001n, 'care');
    const list = c8cListOf(root, 'monstersSheet-root-care');
    expect(c8cActiveIds(list), 'Care is the active row').toEqual(['monstersSheet-root-care']);
    expect(careRow(root).getAttribute('aria-selected')).toBe('true');
    expect(list.getAttribute('aria-activedescendant')).toBe('monstersSheet-root-care');
    expectCooling(root, 'Care Ready in 6h 0m', 'active and cooling');
    paintCare(view, 21_540_001n, 'feed');
    expect(c8cActiveIds(list), 'the cursor moves off it').toEqual(['monstersSheet-root-feed']);
    expectCooling(root, 'Care Ready in 6h 0m', 'inactive and cooling');
  });

  it('under «key» sentinels the cooling Care row reads «box.sheet.care» then «box.sheet.careCooldown» with its hours and minutes, and no English roster word appears outside a sentinel; a ready Care requests no hint [QF3-3-VIEW-CARE-SENTINEL]', () => {
    // WRONG IMPL KILLED: the hint written from a literal ("Ready in": it would read English in a
    // French boot; the roster scan names "Ready "); the hint under another key (Feed's no-food
    // reason); the params swapped, dropped or passed as bigints; a hint requested for a ready row.
    const { view, root } = c8bMount();
    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      vi.mocked(i18nTf).mockImplementation(
        (key: string, params: unknown) => `«${key}|${JSON.stringify(params)}»`,
      );
      view.refresh(c8bParty(), c8bBox());
      view.show();
      paintCare(view, 21_540_000n);
      let texts = m24s4BxWalkSubtree(root);
      m24s4BxAssertNoRosterWord(texts, 'a cooling Care');
      let joined = texts.join('\n');
      expect(joined).toContain('«box.sheet.care»');
      expect(c8cSpanParams(joined, 'box.sheet.careCooldown')).toEqual([{ hours: 5, minutes: 59 }]);
      const sentinelRow = careRow(root).textContent ?? '';
      expect(
        sentinelRow.startsWith('«box.sheet.care» «box.sheet.careCooldown|'),
        `the Care row: its label, one space, then the hint: ${sentinelRow}`,
      ).toBe(true);
      expect(sentinelRow.endsWith('»'), 'and nothing after the hint').toBe(true);

      paintCare(view, 0n);
      texts = m24s4BxWalkSubtree(root);
      m24s4BxAssertNoRosterWord(texts, 'a ready Care');
      joined = texts.join('\n');
      expect(c8cSpanParams(joined, 'box.sheet.careCooldown'), 'ready: no hint').toEqual([]);
    } finally {
      vi.mocked(i18nT).mockRestore();
      vi.mocked(i18nTf).mockRestore();
    }
  });
});

// =============================================================================
// qf-9 (QF9.1): the Monsters Summary pane shows the monster's FULL stats (attack, defense, speed,
// spAttack, spDefense and trust) from `my_monster_pub`, which the raising screen's cards used to
// show. `refresh(party, box, stats)` takes a third, optional map (boxModel's buildMonsterStats,
// keyed by String(monsterId)); the Summary part gains one line `#monsters-summary-stats` reading
// `tf('box.summary.stats', ...)` for the summary monster from the LATEST refresh's map. A monster
// with no stats row has the line empty and hidden (the e2e text scans read hidden text).
// =============================================================================

/** U+00B7 MIDDLE DOT (the stats line's separator) and U+00C9 E acute (the French labels), built by
 *  code point so the expected bytes hold no pasted glyph. */
const Q9_DOT = String.fromCharCode(0x00b7);
const Q9_E_ACUTE = String.fromCharCode(0x00c9);

const q9Stats = (over: Partial<MonsterStatsViewModel> = {}): MonsterStatsViewModel => ({
  trustTier: 'Devoted',
  statAttack: 31,
  statDefense: 42,
  statSpeed: 53,
  statSpAttack: 64,
  statSpDefense: 75,
  ...over,
});

/** The English line for a stats row: every number distinct, so a swapped pairing shows. */
const q9En = (s: MonsterStatsViewModel): string =>
  `Trust ${s.trustTier} ${Q9_DOT} ATK ${s.statAttack} ${Q9_DOT} DEF ${s.statDefense} ` +
  `${Q9_DOT} SPD ${s.statSpeed} ${Q9_DOT} SP.ATK ${s.statSpAttack} ${Q9_DOT} SP.DEF ${s.statSpDefense}`;

/** The French line for a stats row. */
const q9Fr = (s: MonsterStatsViewModel): string =>
  `Confiance ${s.trustTier} ${Q9_DOT} ATQ ${s.statAttack} ${Q9_DOT} D${Q9_E_ACUTE}F ${s.statDefense} ` +
  `${Q9_DOT} VIT ${s.statSpeed} ${Q9_DOT} ATQ SP${Q9_E_ACUTE} ${s.statSpAttack} ` +
  `${Q9_DOT} D${Q9_E_ACUTE}F SP${Q9_E_ACUTE} ${s.statSpDefense}`;

/** Kip (100) and Moss (101) with DIFFERENT rows: a lookup of the wrong monster reads wrong. */
const q9KipStats = (): MonsterStatsViewModel =>
  q9Stats({
    trustTier: 'Wary',
    statAttack: 11,
    statDefense: 12,
    statSpeed: 13,
    statSpAttack: 14,
    statSpDefense: 15,
  });
const q9MossStats = (): MonsterStatsViewModel => q9Stats();
const q9Map = (): ReadonlyMap<string, MonsterStatsViewModel> =>
  new Map([
    ['100', q9KipStats()],
    ['101', q9MossStats()],
  ]);

/** A shown frame whose last refresh carried `stats`. */
function q9Open(stats?: ReadonlyMap<string, MonsterStatsViewModel>): C8bMounted {
  const mounted = c8bMount();
  mounted.view.refresh(c8bParty(), c8bBox(), stats);
  mounted.view.show();
  return mounted;
}

/** The summary stats line; it must exist (it is built once, hidden or not). */
function q9Line(root: Element): HTMLElement {
  const el = root.querySelector<HTMLElement>('#monsters-summary-stats');
  expect(el, 'precondition: #monsters-summary-stats is rendered').not.toBeNull();
  return el as HTMLElement;
}

describe('BoxView qf-9: the Summary shows the full stats (QF9.1)', () => {
  it('QF9-1-VIEW-SUMMARY-STATS: a summary paint shows #monsters-summary-stats reading the en catalog line with the summary monster`s attack, defense, speed, spAttack, spDefense and trust, beside the name and the unchanged HP line, outside both panels', () => {
    // WRONG IMPL KILLED: no stats line (QF9.1: the stats left the raising screen and live nowhere);
    // a line with only some of the six; two stats swapped (every number differs); the trust
    // missing or a literal; the line drawn into a panel grid (a refresh would wipe it); a line
    // hidden while the summary shows; the summary's name or `box.card.stats` HP line dropped to
    // make room.
    const { parent, view, root } = q9Open(q9Map());
    view.paint(c8bPaint({ tab: 'party', activeKey: '101', summary: C8B_MOSS }));
    const line = q9Line(root);
    expect(line.textContent, 'the six values, en bytes').toBe(q9En(q9MossStats()));
    expect(line.textContent, 'literal check of the bytes').toBe(
      `Trust Devoted ${Q9_DOT} ATK 31 ${Q9_DOT} DEF 42 ${Q9_DOT} SPD 53 ${Q9_DOT} SP.ATK 64 ${Q9_DOT} SP.DEF 75`,
    );
    expect(c8bHidden(line, root), 'the line shows').toBe(false);
    for (const grid of [partyGridOf(parent), boxGridOf(parent)]) {
      expect(grid.contains(line), 'the line is not inside a panel grid').toBe(false);
    }
    // Same part as the name and HP line (the summary pane), not a loose frame child.
    const nameEls = c8bOutsidePanels(parent, root).filter(
      (el) => ctl7bOwnText(el) === 'Mossling' && !c8bHidden(el, root),
    );
    expect(nameEls, 'precondition: the summary name shows').toHaveLength(1);
    expect(line.parentElement, 'the line sits in the Summary part with the name').toBe(
      (nameEls[0] as HTMLElement).parentElement,
    );
    expect(c8bShownText(parent, root, p2Stats(C8B_MOSS)), 'the HP line stays').not.toEqual([]);
  });

  it('QF9-1-VIEW-SUMMARY-STATS-PER-MONSTER: the line is the SUMMARY monster`s row by id, not the first row, the cursor card`s or the sheet`s: Kip`s summary shows Kip`s numbers and Moss`s shows Moss`s', () => {
    // WRONG IMPL KILLED: a lookup of the first map entry; a key built from the party slot or the
    // list index; a line read for the CURSOR monster (activeKey) instead of the summary card; a row
    // cached from the first summary and never re-looked-up when the pane moves to another monster.
    const { parent, view, root } = q9Open(q9Map());
    const line = q9Line(root);

    view.paint(c8bPaint({ tab: 'party', activeKey: '100', summary: C8B_KIP }));
    expect(line.textContent, 'Kip`s row').toBe(q9En(q9KipStats()));
    expect(line.textContent ?? '', 'Kip`s trust is Wary').toContain('Trust Wary');

    // Cursor on Kip, summary of Moss: the line follows the summary card.
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', summary: C8B_MOSS }));
    expect(line.textContent, 'Moss`s row under Kip`s cursor').toBe(q9En(q9MossStats()));

    view.paint(c8bPaint({ tab: 'party', activeKey: '101', summary: C8B_KIP }));
    expect(line.textContent, 'Kip`s row under Moss`s cursor').toBe(q9En(q9KipStats()));
    expect(c8bHidden(line, root)).toBe(false);
    expect(partyGridOf(parent).contains(line)).toBe(false);
  });

  it('QF9-1-VIEW-SUMMARY-STATS-CALL: the line is resolved through tf(box.summary.stats) with trust, attack, defense, speed, spAttack and spDefense each from its own field', () => {
    // WRONG IMPL KILLED: a hand-assembled English string (a French boot reads English: the
    // catalog is the only source); a param read from the wrong field (statDefense passed as
    // attack); trust passed as a number or dropped; a param renamed (the typed catalog closure
    // would read undefined).
    const { view } = q9Open(q9Map());
    vi.mocked(i18nTf).mockClear();
    view.paint(c8bPaint({ tab: 'party', activeKey: '101', summary: C8B_MOSS }));
    expect(i18nTf).toHaveBeenCalledWith('box.summary.stats', {
      trust: 'Devoted',
      attack: 31,
      defense: 42,
      speed: 53,
      spAttack: 64,
      spDefense: 75,
    });
  });

  it('QF9-1-VIEW-SUMMARY-STATS-LIVE: a later refresh() with changed stats repaints the open summary with no new paint; a refresh with the same stats keeps it; a refresh carrying no stats empties and hides it', () => {
    // WRONG IMPL KILLED: a line written only when the summary opens (a batch that raises a stat
    // or trust tier leaves the old numbers on screen until another button is pressed); a line
    // that reads the paint's own card/the first refresh's map; one that survives a refresh whose
    // map no longer has the monster (stale numbers shown as current); a third parameter that
    // is required (the 2-arg refresh of every other caller would throw).
    const { view, root } = q9Open(q9Map());
    view.paint(c8bPaint({ tab: 'party', activeKey: '101', summary: C8B_MOSS }));
    const line = q9Line(root);
    expect(line.textContent, 'fixture: the first numbers').toBe(q9En(q9MossStats()));

    const raised = q9Stats({ trustTier: 'Friendly', statAttack: 32, statSpDefense: 80 });
    view.refresh(
      c8bParty(),
      c8bBox(),
      new Map([
        ['100', q9KipStats()],
        ['101', raised],
      ]),
    );
    expect(line.textContent, 'the batch`s numbers show with no repaint').toBe(q9En(raised));
    expect(line.textContent ?? '', 'the old attack is gone').not.toContain('ATK 31');
    expect(c8bHidden(line, root), 'still showing').toBe(false);

    view.refresh(
      c8bParty(),
      c8bBox(),
      new Map([
        ['100', q9KipStats()],
        ['101', raised],
      ]),
    );
    expect(line.textContent, 'an equal batch keeps the line').toBe(q9En(raised));

    // The LATEST refresh is the truth: one with no stats row for Moss empties and hides the line.
    expect(() => view.refresh(c8bParty(), c8bBox()), 'stats is optional').not.toThrow();
    expect(line.textContent, 'no row: empty').toBe('');
    expect(c8bHidden(line, root), 'no row: hidden').toBe(true);

    // And the numbers come back with the next batch that carries them.
    view.refresh(c8bParty(), c8bBox(), q9Map());
    expect(line.textContent).toBe(q9En(q9MossStats()));
    expect(c8bHidden(line, root)).toBe(false);
  });

  it('QF9-1-VIEW-SUMMARY-STATS-ZERO: a monster whose stats are 0 still shows its line: zeros print as 0 and the line is neither blank nor hidden', () => {
    // WRONG IMPL KILLED: a truthiness test on the stats row or its fields (`if (row.statSpeed)`,
    // `value || ''`, a `!stats.statAttack` hide): a stat of 0 would blank or hide the whole line
    // or print "undefined"/empty in its slot, as a missing row does.
    const zero = q9Stats({ statSpeed: 0, statAttack: 0, statSpDefense: 0 });
    const { view, root } = q9Open(
      new Map([
        ['101', zero],
        ['100', q9KipStats()],
      ]),
    );
    view.paint(c8bPaint({ tab: 'party', activeKey: '101', summary: C8B_MOSS }));
    const line = q9Line(root);
    expect(line.textContent, 'zeros are printed, not dropped').toBe(q9En(zero));
    expect(line.textContent ?? '', 'literal: a 0 in each slot').toContain('ATK 0 ');
    expect(c8bHidden(line, root), 'and the line is showing').toBe(false);
  });

  it('QF9-1-VIEW-SUMMARY-STATS-ABSENT: with no stats row for the summary monster (no map, an empty map, or a map of other monsters) the line is empty and hidden by inline display:none while the name and HP line still show', () => {
    // WRONG IMPL KILLED: a line that prints "undefined"/NaN/zeros for a missing row; one that
    // shows an empty bordered strip (visible but empty); one that borrows another monster`s row;
    // a missing-row crash that takes the whole summary pane down with it.
    const maps: ReadonlyArray<
      readonly [string, ReadonlyMap<string, MonsterStatsViewModel> | undefined]
    > = [
      ['no map', undefined],
      ['an empty map', new Map()],
      ['a map without Moss', new Map([['100', q9KipStats()]])],
    ];
    for (const [label, stats] of maps) {
      const { parent, view, root } = q9Open(stats);
      view.paint(c8bPaint({ tab: 'party', activeKey: '101', summary: C8B_MOSS }));
      const line = q9Line(root);
      expect(line.textContent, `${label}: empty`).toBe('');
      expect(line.style.display, `${label}: hidden by inline display`).toBe('none');
      expect(c8bShownText(parent, root, 'Mossling'), `${label}: the name still shows`).not.toEqual(
        [],
      );
      expect(c8bShownText(parent, root, p2Stats(C8B_MOSS)), `${label}: the HP line`).not.toEqual(
        [],
      );
    }
  });

  it('QF9-1-VIEW-SUMMARY-STATS-CLOSED: a null summary leaves the line empty (the e2e text scans read hidden text) and a reopened summary shows it again; a reopened FRAME shows none until a summary is painted', () => {
    // WRONG IMPL KILLED: a hidden summary that keeps the last monster's numbers in the root text; a
    // line that never comes back after the pane closed; a frame reopen that keeps last visit's
    // summary line.
    const { view, root } = q9Open(q9Map());
    const line = q9Line(root);
    view.paint(c8bPaint({ tab: 'party', activeKey: '101', summary: C8B_MOSS }));
    expect(line.textContent).toBe(q9En(q9MossStats()));

    view.paint(c8bPaint({ tab: 'party', activeKey: '101' }));
    expect(line.textContent, 'closed: empty').toBe('');
    expect(c8bHidden(line, root), 'closed: hidden').toBe(true);
    expect(root.textContent ?? '', 'no stat label lingers in the root').not.toContain('ATK ');

    view.paint(c8bPaint({ tab: 'party', activeKey: '101', summary: C8B_MOSS }));
    expect(line.textContent, 'reopened pane').toBe(q9En(q9MossStats()));

    view.hide();
    view.show();
    expect(line.textContent, 'a reopened frame has no summary yet').toBe('');
    expect(c8bHidden(line, root)).toBe(true);
  });

  it('QF9-1-VIEW-SUMMARY-STATS-FR: under fr the line reads the French catalog text, repaints in English after the locale returns, and the English-only roster is not used', () => {
    // WRONG IMPL KILLED: a line assembled from English literals (a French boot reads "Trust ...
    // ATK"); a line resolved once and cached across a locale switch; the French labels swapped
    // (DEF read for SP.DEF); a French string that lost its accents.
    const { view, root } = q9Open(q9Map());
    try {
      p2SetLocale('fr');
      view.paint(c8bPaint({ tab: 'party', activeKey: '101', summary: C8B_MOSS }));
      const line = q9Line(root);
      expect(line.textContent, 'French bytes').toBe(q9Fr(q9MossStats()));
      expect(line.textContent ?? '', 'no English label left').not.toContain('ATK');
      expect(line.textContent ?? '', 'no English label left').not.toContain('Trust');

      p2SetLocale('en');
      view.paint(c8bPaint({ tab: 'party', activeKey: '101', summary: C8B_MOSS }));
      expect(line.textContent, 'English again').toBe(q9En(q9MossStats()));
    } finally {
      p2SetLocale('en');
    }
  });

  it('QF9-1-VIEW-SUMMARY-STATS-SENTINEL: under «key» sentinels the stats line is the catalog span and no English label appears outside a sentinel', () => {
    // WRONG IMPL KILLED: a stats line written from a literal; the numbers or trust interpolated
    // outside the catalog call (the sentinel span would not carry them).
    const { view, root } = c8bMount();
    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      vi.mocked(i18nTf).mockImplementation(
        (key: string, params: unknown) => `«${key}|${JSON.stringify(params)}»`,
      );
      view.refresh(c8bParty(), c8bBox(), q9Map());
      view.show();
      view.paint(c8bPaint({ tab: 'party', activeKey: '101', summary: C8B_MOSS }));
      const line = q9Line(root);
      expect(line.textContent ?? '').toMatch(/^«box\.summary\.stats\|\{.*\}»$/);
      const params = c8cSpanParams(line.textContent ?? '', 'box.summary.stats');
      expect(params).toEqual([
        {
          trust: 'Devoted',
          attack: 31,
          defense: 42,
          speed: 53,
          spAttack: 64,
          spDefense: 75,
        },
      ]);
      expect(line.textContent ?? '', 'no raw English label').not.toContain('ATK');
    } finally {
      vi.mocked(i18nT).mockRestore();
      vi.mocked(i18nTf).mockRestore();
    }
  });
});

// =============================================================================
// qf-10 (QF10.3, QF10.4): the frame is named Monsters, its Box panel is Storage, and the
// explainer hint sits BELOW both panels (the last child of the frame root). Real DOM, the real
// BoxView, the real catalog: nothing here reimplements view logic.
// =============================================================================

describe('BoxView qf-10: the Monsters title and the Storage wording (QF10.4)', () => {
  it('the title anchor reads Monsters in English and Monstres after a French show(); the Storage empty line reads its qf-10 copy in both languages [QF10-4-BOX-TITLE-RENDERS]', () => {
    // WRONG IMPL KILLED: the shipped 'Party & Box' / 'Equipe et boite' titles (values not
    // changed); a title resolved once in the constructor (a locale switch leaves the old name); the
    // empty line left on 'No monsters in box.' / 'Aucun monstre dans la boite.'.
    const { parent, view } = mount();
    view.refresh(makePartySlots(), []);
    view.show();
    const title = parent.querySelector('[data-testid="box-title"]') as HTMLElement | null;
    expect(title, 'precondition: the title anchor exists').not.toBeNull();
    const grid = boxGridOf(parent);
    try {
      p2SetLocale('en');
      view.show();
      expect(title!.textContent, 'English title').toBe('Monsters');
      // uif-6 (named intentional change, UIF6.6): the empty line is the EmptyState's reason line.
      const reasonOf = (): string | null | undefined =>
        grid.querySelector('.mr-empty-reason')?.textContent;
      expect(reasonOf(), 'English empty Storage line').toBe('No monsters in storage.');

      p2SetLocale('fr');
      view.show();
      view.refresh(makePartySlots(), []);
      expect(title!.textContent, 'French title').toBe('Monstres');
      expect(reasonOf(), 'French empty Storage line').toBe('Aucun monstre dans le stockage.');
    } finally {
      p2SetLocale('en');
    }
  });
});

describe('BoxView qf-10: the hint sits below the panels (QF10.3)', () => {
  it('the hint is a direct child of the frame root, follows both h3 headings and both grids, and is the root`s last element child, on the Party tab and on the Storage tab [QF10-3-HINT-BELOW-PANELS]', () => {
    // WRONG IMPL KILLED: the hint left between the tab strip / sheet parts and the panels (the
    // shipped position); a hint moved above only ONE panel (after the Party grid but before
    // Storage); a hint appended to the caller's parent or inside a grid (a refresh wipes it); a
    // hint followed by another child (the feedback line or a part appended after it); and a
    // position that is only right for the opening tab.
    const { parent, view } = mount();
    view.refresh(makePartySlots(), [makeBoxRecruitCard()]);
    view.show();
    const root = s4BoxRootOf(parent);

    for (const tab of ['party', 'storage'] as const) {
      view.paint(c8bPaint({ tab }));
      const hint = root.querySelector(BOX_PARTY_HINT_SELECTOR) as HTMLElement | null;
      expect(hint, `${tab}: the hint exists`).not.toBeNull();
      expect(hint!.parentElement, `${tab}: a direct child of the frame root`).toBe(root);
      expect(hint!.textContent, `${tab}: it reads box.hint`).toBe(i18nT('box.hint'));

      const partyGrid = partyGridOf(parent);
      const boxGrid = boxGridOf(parent);
      // uif-6 (named intentional change, UIF6.5): the h3 headings are gone; the panel replaces them
      // in this ordering claim.
      const panel = monstersPanelOf(parent);
      for (const [name, el] of [
        ['the panel', panel],
        ['the Party grid', partyGrid],
        ['the Storage grid', boxGrid],
      ] as const) {
        expect(
          el.compareDocumentPosition(hint!) & Node.DOCUMENT_POSITION_FOLLOWING,
          `${tab}: the hint comes after ${name}`,
        ).not.toBe(0);
        expect(el.contains(hint!), `${tab}: the hint is not inside ${name}`).toBe(false);
      }
      expect(root.lastElementChild, `${tab}: the hint is the root's last element child`).toBe(hint);
    }
  });

  it('no element between the tab strip and the first panel heading is the hint, and the hint comes after that heading [QF10-3-HINT-NOT-AT-SEAM]', () => {
    // WRONG IMPL KILLED: the shipped position, where the hint sits between the tab strip /
    // sheet parts and the Party h3 (the seam a player reads first, which pushed the cards below
    // the fold). Controls: the strip, the first h3 and the hint are all found, in the order
    // strip < first h3 < hint, so an empty slice cannot pass for the right reason.
    const { parent, view } = mount();
    view.refresh(makePartySlots(), [makeBoxRecruitCard()]);
    view.show();
    const root = s4BoxRootOf(parent);

    const strip = root.querySelector('.mr-frame-tabstrip') as HTMLElement | null;
    // uif-6 (named intentional change, UIF6.1/UIF6.5): the strip is in the TabBar row (the row is the
    // root child) and the first panel heading is gone; the tab content area `#monsters-panel` is
    // the first thing the hint must come after.
    const firstHeading = root.querySelector('#monsters-panel') as HTMLElement | null;
    const hint = root.querySelector(BOX_PARTY_HINT_SELECTOR) as HTMLElement | null;
    expect(strip, 'precondition: the tab strip exists').not.toBeNull();
    expect(firstHeading, 'precondition: the tab content area exists').not.toBeNull();
    expect(hint, 'precondition: the hint exists').not.toBeNull();

    const kids = [...root.children];
    const at = (el: Element | null): number =>
      kids.indexOf(el === strip ? (strip?.parentElement as Element) : (el as Element));
    expect(at(strip), 'the strip`s row is a root child').toBeGreaterThanOrEqual(0);
    expect(at(firstHeading), 'the first h3 is a root child after the strip').toBeGreaterThan(
      at(strip),
    );
    const between = kids.slice(at(strip) + 1, at(firstHeading));
    expect(
      between.map((el) => el.getAttribute('data-testid')),
      'nothing between the tab strip and the first panel heading is the hint',
    ).not.toContain('box-party-hint');
    expect(at(hint), 'the hint comes after the first panel heading').toBeGreaterThan(
      at(firstHeading),
    );
  });
});

// =============================================================================
// uif-6 (UIF6.1, UIF6.5, UIF6.6, UIF6.8): the Monsters frame's layout. happy-dom proves structure
// only (no layout, no cascade): the geometry, the growth, the colours and the pseudo-scroll are
// proved in Chromium by client/e2e/ui-monsters.spec.ts.
// =============================================================================

/** A party of six slots with monsters in slots 0 and 3 (a gap of two between them). */
const uif6Gapped = (): (MonsterCardViewModel | null)[] => [
  C8B_KIP,
  null,
  null,
  makeCard({ monsterId: 101n, speciesName: 'Mossling', partySlot: 3 }),
  null,
  null,
];

describe('BoxView uif-6: the tabs are the TabBar (UIF6.1)', () => {
  it('UIF6.1 the Monsters tabs are one .mr-tabbar row (LB chip, the role=tablist strip #monsters-tabs, RB chip) placed right after the title header and before the sheet parts and the panel, the tabs keep their ids and the selected one wears is-selected and never is-active', () => {
    // WRONG IMPL KILLED: today's bare `.mr-frame-tabstrip` div (no chips, no row: the LB and RB
    // chips are the kit's cue that Q and E switch tabs); chips present but in another order or
    // outside the row; a strip without the id `monsters-tabs` (e2e and the kit key on strip ids);
    // the row appended after the sheet parts or the panel (the tabs would sit under the sheet);
    // tab ids renamed (`#monsters-tab-party` / `#monsters-tab-storage` are pointer and e2e
    // anchors); a selected tab marked `is-active` (the row cursor's class: 'which tab' and 'which
    // row' must both be expressible, UIF3.2) or marked by aria-selected alone (the visual cue is
    // the class); both tabs selected; a row left `hidden`; the row rebuilt out of place by a
    // batch refresh.
    const { parent, view, root } = c8bOpen();
    const expectBar = (when: string, selected: 'party' | 'storage'): void => {
      const rows = root.querySelectorAll<HTMLElement>('.mr-tabbar');
      expect(rows, `${when}: exactly one tab bar row`).toHaveLength(1);
      const row = rows[0] as HTMLElement;
      expect(row.hidden, `${when}: the row is shown`).toBe(false);
      expect(row.parentElement, `${when}: a direct child of the frame root`).toBe(root);
      expect(
        [...row.children].map((el) => el.getAttribute('data-button') ?? el.getAttribute('role')),
        `${when}: LB chip, tablist strip, RB chip, in one row`,
      ).toEqual(['LB', 'tablist', 'RB']);
      const [lb, strip, rb] = [...row.children] as HTMLElement[];
      expect(strip?.id, `${when}: the strip id`).toBe('monsters-tabs');
      for (const chip of [lb, rb]) {
        expect(chip?.getAttribute('aria-hidden'), `${when}: a chip is hidden from AT`).toBe('true');
      }
      expect(
        headerRowOf(parent).nextElementSibling,
        `${when}: the row follows the title header directly`,
      ).toBe(row);
      for (const [name, later] of [
        ['the sheet part', root.querySelector('#monsters-sheet-name')],
        ['the tab content area', monstersPanelOf(parent)],
        ['the hint', root.querySelector(BOX_PARTY_HINT_SELECTOR)],
      ] as const) {
        expect(later, `${when}: ${name} exists`).not.toBeNull();
        expect(
          row.compareDocumentPosition(later as Element) & Node.DOCUMENT_POSITION_FOLLOWING,
          `${when}: the row comes before ${name}`,
        ).not.toBe(0);
      }

      const party = root.querySelector<HTMLElement>('#monsters-tab-party');
      const storage = root.querySelector<HTMLElement>('#monsters-tab-storage');
      expect(party?.getAttribute('role'), `${when}: #monsters-tab-party is a tab`).toBe('tab');
      expect(storage?.getAttribute('role'), `${when}: #monsters-tab-storage is a tab`).toBe('tab');
      expect(party?.parentElement, `${when}: the tabs are the strip's children`).toBe(strip);
      expect(storage?.parentElement).toBe(strip);
      for (const [name, tab] of [
        ['party', party],
        ['storage', storage],
      ] as const) {
        const on = name === selected;
        expect(tab?.classList.contains('is-selected'), `${when}: ${name} is-selected`).toBe(on);
        expect(tab?.getAttribute('aria-selected'), `${when}: ${name} aria-selected`).toBe(
          on ? 'true' : 'false',
        );
        expect(
          tab?.classList.contains('is-active'),
          `${when}: ${name} never wears the row cursor's is-active`,
        ).toBe(false);
      }
    };

    view.paint(c8bPaint({ tab: 'party' }));
    expectBar('Party painted', 'party');
    view.paint(c8bPaint({ tab: 'storage' }));
    expectBar('Storage painted', 'storage');
    view.refresh(c8bParty(), c8bBox());
    expectBar('after a batch refresh', 'storage');
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'summary') }));
    expectBar('with the sheet open', 'party');
    view.hide();
    view.show();
    expectBar('after hide and show (the opening)', 'storage');
  });
});

describe('BoxView uif-6: no in-panel headings (UIF6.5)', () => {
  it('UIF6.5 the Monsters root has no h3 and no element outside the tab strip whose own text is the Party or the Storage heading, for a full, a gapped and an empty roster on both tabs, in en and fr', () => {
    // WRONG IMPL KILLED: today's two `h3` headings (R-qf-10-QF10.2: they repeat the tabs and cost a
    // row each); the headings hidden instead of deleted (display:none h3s still read as headings to
    // AT); a heading moved into the grid or the panel as a div; a heading kept for one tab only;
    // the strip's own tab labels counted as headings (the control: the tabs ARE there and read
    // Party / Storage, so an over-broad "no Party text" check would fail on them).
    try {
      for (const locale of ['en', 'fr'] as const) {
        p2SetLocale(locale);
        const party = c8bT('box.tab.party');
        const storage = c8bT('box.tab.storage');
        const rosters: ReadonlyArray<
          readonly [string, (MonsterCardViewModel | null)[], MonsterCardViewModel[]]
        > = [
          ['full', c8bParty(), c8bBox()],
          ['gapped', uif6Gapped(), c8bBox()],
          ['empty', [null, null, null, null, null, null], []],
        ];
        for (const [name, slots, boxed] of rosters) {
          const { view, root } = c8bMount();
          view.refresh(slots, boxed);
          view.show();
          for (const tab of ['party', 'storage'] as const) {
            view.paint(c8bPaint({ tab }));
            const when = `${locale} ${name} ${tab}`;
            expect(root.querySelectorAll('h3'), `${when}: no h3 in the Monsters root`).toHaveLength(
              0,
            );
            const strip = root.querySelector('[role="tablist"]') as HTMLElement;
            expect(
              [...strip.querySelectorAll('[role="tab"]')].map((el) => el.textContent),
              `${when}: control: the tabs carry the two labels`,
            ).toEqual([party, storage]);
            const headings = [...root.querySelectorAll<HTMLElement>('*')].filter(
              (el) => !strip.contains(el) && [party, storage].includes(ctl7bOwnText(el).trim()),
            );
            expect(
              headings.map((el) => `${el.tagName}:${ctl7bOwnText(el)}`),
              `${when}: no heading text outside the strip`,
            ).toEqual([]);
          }
          document.body.replaceChildren();
        }
      }
    } finally {
      p2SetLocale('en');
    }
  });
});

describe('BoxView uif-6: the empty Storage is an EmptyState (UIF6.6)', () => {
  it('UIF6.6 with no boxed monster the Storage panel shows .mr-empty with a reason (box.box.empty), a cue (box.storage.emptyCue) and a next step (box.storage.emptyNext), each non-empty and different in en and fr, the frame title and both tabs kept, no card, and a boxed monster removes it', () => {
    // WRONG IMPL KILLED: today's bare "No monsters in storage." div (no cue, no next step: the
    // player is told what is missing but not where monsters come from or what to do); the kit's
    // EmptyState rebuilt by hand with other class names (the stylesheet keys `.mr-empty-*`); a cue
    // or next step written as an English literal (the en and fr texts must differ); one key used
    // for two lines (the three texts must differ from each other); the EmptyState replacing the
    // frame (title or tabs lost with it); a stale EmptyState left after the box fills; an
    // EmptyState that carries a nav key (the cursor would land on it and A would act on nothing).
    const texts: Record<'en' | 'fr', { reason: string; cue: string; next: string }> = {
      en: { reason: '', cue: '', next: '' },
      fr: { reason: '', cue: '', next: '' },
    };
    try {
      for (const locale of ['en', 'fr'] as const) {
        p2SetLocale(locale);
        const { parent, view, root } = c8bMount();
        view.refresh(c8bParty(), []);
        view.show();
        view.paint(c8bPaint({ tab: 'storage' }));
        const box = boxGridOf(parent);
        const empties = box.querySelectorAll('.mr-empty');
        expect(empties, `${locale}: one EmptyState in the Storage grid`).toHaveLength(1);
        expect(c8bHidden(empties[0] as Element, root), `${locale}: and it shows`).toBe(false);
        const part = (cls: string): string =>
          (empties[0] as Element).querySelector(cls)?.textContent ?? '';
        const got = {
          reason: part('.mr-empty-reason'),
          cue: part('.mr-empty-cue'),
          next: part('.mr-empty-next'),
        };
        expect(got.reason, `${locale}: the reason line`).toBe(c8bT('box.box.empty'));
        expect(got.cue, `${locale}: the cue line`).toBe(c8bT('box.storage.emptyCue'));
        expect(got.next, `${locale}: the next-step line`).toBe(c8bT('box.storage.emptyNext'));
        for (const [line, text] of Object.entries(got)) {
          expect(text.trim(), `${locale}: the ${line} line is not empty`).not.toBe('');
        }
        expect(
          new Set(Object.values(got)).size,
          `${locale}: the three lines are three different texts`,
        ).toBe(3);
        texts[locale] = got;

        expect(c8bCards(box), `${locale}: no card in an empty Storage`).toHaveLength(0);
        expect(
          (empties[0] as Element).querySelector('[data-nav-key]'),
          `${locale}: the EmptyState holds no cursor target`,
        ).toBeNull();
        expect(c8bAnchor(root).textContent, `${locale}: the frame title is kept`).toBe(
          c8bT('box.title'),
        );
        expect(c8bTabs(root), `${locale}: both tabs are kept`).toHaveLength(2);
        expect(
          partyGridOf(parent).querySelector('.mr-empty'),
          `${locale}: the Party grid has no EmptyState`,
        ).toBeNull();

        // A boxed monster takes it away.
        view.refresh(c8bParty(), c8bBox());
        expect(
          box.querySelectorAll('.mr-empty'),
          `${locale}: no EmptyState with monsters`,
        ).toHaveLength(0);
        expect(c8bKeys(box)).toEqual(['200', '300', '400']);
        document.body.replaceChildren();
      }
    } finally {
      p2SetLocale('en');
    }
    for (const line of ['reason', 'cue', 'next'] as const) {
      expect(texts.fr[line], `fr differs from en: ${line}`).not.toBe(texts.en[line]);
    }
  });
});

describe('BoxView uif-6: the Party draws six cells (UIF6.8)', () => {
  it('UIF6.8 the Party grid holds one cell per slot in slot order, every cell keyed (monsters by id, empty slots slot-<i>) and the cursor can rest on an empty slot', () => {
    // WRONG IMPL KILLED: today's Party, whose empty slots carry no `data-nav-key` (the pointer and
    // the cursor mark cannot reach them, and the D-pad would point at a cell the view cannot
    // mark); cells drawn for the occupied monsters only (a monster in slot 3 would sit in the
    // second cell); the monster cells in list order instead of slot order; an empty cell keyed by a
    // bare index (could collide with a monster id); an empty cell that loses its "Slot i: (empty)"
    // copy; a cursor mark that cannot land on an empty slot (is-active / aria-current only for
    // monsters) or that marks two cells.
    const { parent, view, root } = c8bMount();
    view.refresh(uif6Gapped(), c8bBox());
    view.show();
    view.paint(c8bPaint({ tab: 'party', activeKey: '100' }));
    const party = partyGridOf(parent);
    expect(party.style.display, 'the Party grid shows as a grid').toBe('grid');
    expect(c8bCards(party), 'six cells, one per slot').toHaveLength(6);
    expect(c8bCellKeys(party), 'in slot order').toEqual([
      '100',
      'slot-1',
      'slot-2',
      '101',
      'slot-4',
      'slot-5',
    ]);
    const cells = c8bCards(party);
    for (const slot of [1, 2, 4, 5]) {
      expect(cells[slot]?.textContent, `slot ${slot}: its empty copy`).toBe(
        i18nTf('box.party.emptySlot', { slot }),
      );
    }
    expect(cells[3]?.textContent ?? '', 'slot 3 holds Mossling').toContain('Mossling');
    // WRONG IMPL KILLED: empty cells that are not marked disabled (AT reads an empty slot as an
    // actionable item, unlike the nav kit's disabled rows), or a monster cell wrongly disabled.
    for (const cell of cells) {
      const empty = (cell.dataset.navKey ?? '').startsWith('slot-');
      expect(
        cell.getAttribute('aria-disabled'),
        `${cell.dataset.navKey}: ${empty ? 'an empty slot is aria-disabled' : 'a monster cell is not'}`,
      ).toBe(empty ? 'true' : null);
    }
    expect(
      c8bMarked(root).map((el) => el.dataset.navKey),
      'the cursor on monster 100',
    ).toEqual(['100']);

    view.paint(c8bPaint({ tab: 'party', activeKey: 'slot-2' }));
    const marked = c8bMarked(root);
    expect(marked, 'exactly one cell marked').toHaveLength(1);
    expect(marked[0]?.dataset.navKey, 'the cursor rests on the empty slot 2').toBe('slot-2');
    expect(marked[0]?.classList.contains('is-active'), 'with the cursor class').toBe(true);
    expect(marked[0]?.style.outline, 'and the non-colour outline').not.toBe('');
    expect(cells[0]?.classList.contains('is-active'), 'monster 100 is no longer marked').toBe(
      false,
    );

    // A batch re-render keeps the empty-slot cursor on the same cell.
    view.refresh(uif6Gapped(), c8bBox());
    expect(
      c8bMarked(root).map((el) => el.dataset.navKey),
      'after a refresh',
    ).toEqual(['slot-2']);
  });
});

// =============================================================================
// uif-7 (UIF7.1 to UIF7.4): the Monsters sheet is the frame's one ContextSheet (placed by the kit,
// never covering the cursor slot: proved in Chromium by client/e2e/ui-monsters.spec.ts), its Close
// and Back rows, one content at a time, and the Summary as a page. happy-dom proves structure only.
// =============================================================================

/** Every sheet root in the frame, shown or not. */
const uif7Sheets = (root: Element): HTMLElement[] => [
  ...root.querySelectorAll<HTMLElement>('[data-context-sheet]'),
];
/** The sheet roots a player can see (the kit hides by the `hidden` attribute). */
const uif7Shown = (root: HTMLElement): HTMLElement[] =>
  uif7Sheets(root).filter((el) => !c8bHidden(el, root));
/** `actual` is exactly `expected`, element for element by IDENTITY (toEqual on DOM nodes compares
 *  structure, so two look-alike roots would pass it). */
function uif7ExpectSame(
  actual: readonly HTMLElement[],
  expected: readonly HTMLElement[],
  message: string,
): void {
  expect(actual.length, `${message}: how many`).toBe(expected.length);
  expected.forEach((el, i) => {
    expect(actual[i], `${message}: element ${i} is the very node`).toBe(el);
  });
}
/** The sheet actions' row ids: none may exist while another content owns the sheet. */
const UIF7_ACTION_IDS = ['summary', 'care', 'feed', 'evolve', 'nickname', 'move', 'close'].map(
  (key) => `monstersSheet-root-${key}`,
);
const uif7RowIds = (root: Element): string[] =>
  [...root.querySelectorAll<HTMLElement>('[id^="monstersSheet-root-"]')].map((el) => el.id);

describe('BoxView uif-7: the sheet is the ContextSheet inside the panel (UIF7.1)', () => {
  it('UIF7.1 opening the sheet paints ONE shown .mr-sheet [data-context-sheet] inside #monsters-panel (inside neither grid), the tab bar and the active grid stay displayed, no dim or backdrop element appears, and #monsters-sheet-name is the sheet`s heading, holds the monster`s name and names the rows', () => {
    // WRONG IMPL KILLED: today's loose `div` parts above the panel (no [data-context-sheet] at all,
    // so the pointer source cannot close it and the kit cannot place it); a second sheet root; a
    // sheet mounted in the frame root or in a grid (a refresh would rebuild a grid and wipe it, or
    // the panel's containing block would not hold it); a sheet that hides the grid or the tabs
    // behind it (wf-1: the context stays visible); a dim layer or backdrop (wf-1: nothing is
    // dimmed); a heading id other than the pinned `monsters-sheet-name` (main.partyFull, reachability,
    // pointer.spec and menu-flow.spec read it) or a heading that is not the sheet's own; rows
    // that are not named by the heading.
    const { parent, view, root } = c8bOpen();
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'summary') }));

    const sheets = uif7Sheets(root);
    expect(sheets, 'exactly one sheet root in the frame').toHaveLength(1);
    expect(
      document.querySelectorAll('[data-context-sheet]'),
      'and exactly one in the document',
    ).toHaveLength(1);
    const sheet = sheets[0] as HTMLElement;
    expect(sheet.classList.contains('mr-sheet'), 'the kit`s class').toBe(true);
    expect(sheet.hidden, 'not hidden').toBe(false);
    expect(c8bHidden(sheet, root), 'shown').toBe(false);
    expect(sheet.dataset.sheetVariant, 'the list variant').toBe('list');
    expect(monstersPanelOf(parent).contains(sheet), 'inside #monsters-panel').toBe(true);
    expect(partyGridOf(parent).contains(sheet), 'not inside the Party grid').toBe(false);
    expect(boxGridOf(parent).contains(sheet), 'not inside the Storage grid').toBe(false);

    // The context stays: the tab bar, and the active grid with its cursor card.
    const bar = root.querySelector<HTMLElement>('.mr-tabbar');
    expect(bar, 'precondition: the tab bar exists').not.toBeNull();
    expect(c8bHidden(bar as HTMLElement, root), 'the tab bar stays displayed').toBe(false);
    expect(c8bSelected(root), 'the Party tab is the selected one').toEqual(['true', 'false']);
    expect(partyGridOf(parent).style.display, 'the active grid is still a grid').toBe('grid');
    expect(c8bHidden(partyGridOf(parent), root), 'and shown').toBe(false);
    expect(
      c8bMarked(root).map((el) => el.dataset.navKey),
      'the cursor card is still marked',
    ).toEqual(['100']);

    // Nothing is dimmed: no backdrop-like element, no inline fade or translucent fill anywhere.
    for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
      expect(
        ctl7bClasses(el).filter((c) => /backdrop|scrim|dim|overlay/i.test(c)),
        `no dim or backdrop class on <${el.tagName.toLowerCase()}>`,
      ).toEqual([]);
      const inline = ctl7bInline(el);
      for (const prop of ['opacity', 'filter', 'backdrop-filter']) {
        expect(inline.has(prop), `no inline ${prop} on <${el.tagName.toLowerCase()}>`).toBe(false);
      }
      for (const prop of ['background', 'background-color']) {
        expect(
          (inline.get(prop) ?? '').includes('rgba('),
          `no translucent inline ${prop} on <${el.tagName.toLowerCase()}>`,
        ).toBe(false);
      }
    }

    // The heading: one element, the sheet's own, holding the monster's name and naming the rows.
    const headings = document.querySelectorAll('#monsters-sheet-name');
    expect(headings, 'one #monsters-sheet-name in the document').toHaveLength(1);
    const heading = headings[0] as HTMLElement;
    expect(sheet.contains(heading), 'it is the sheet`s heading').toBe(true);
    expect(heading.hidden, 'shown').toBe(false);
    expect(heading.textContent, 'holding the monster`s name').toBe('Kip');
    expect(
      c8cListOf(root, 'monstersSheet-root-summary').getAttribute('aria-labelledby'),
      'the rows are named by it',
    ).toBe('monsters-sheet-name');
    expect(sheet.contains(c8cListOf(root, 'monstersSheet-root-summary')), 'rows in the sheet').toBe(
      true,
    );

    // Another monster, another tab: the same sheet root, the new name.
    view.paint(
      c8bPaint({ tab: 'storage', activeKey: '200', sheet: c8bSheet(C8B_EMBER, 'summary') }),
    );
    uif7ExpectSame(uif7Sheets(root), [sheet], 'still one root');
    expect(heading.textContent, 'the new name (a nickname-less card shows its species)').toBe(
      'Emberfang',
    );
    expect(c8bHidden(boxGridOf(parent), root), 'the Storage grid is the shown one').toBe(false);

    // The Feed… and Evolve… lists carry no card: their title is the CURSOR monster's name (activeKey),
    // not the first card's. The cursor is on the SECOND party card, then on a Storage card.
    for (const [tab, key, name] of [
      ['party', '101', 'Mossling'],
      ['storage', '300', 'Duskling'],
      ['party', '100', 'Kip'],
    ] as const) {
      view.paint(
        c8bPaint({
          tab,
          activeKey: key,
          feed: { foods: [{ itemId: 7, name: 'Bait', count: 3 }], activeKey: '7' },
        }),
      );
      expect(heading.textContent, `the food list on ${key} is titled ${name}`).toBe(name);
      view.paint(
        c8bPaint({ tab, activeKey: key, evolve: { mon: C8C_TWO_CHOICES, activeKey: '20' } }),
      );
      expect(heading.textContent, `the Evolve list on ${key} is titled ${name}`).toBe(name);
    }
  });

  it('UIF7.1 closing the sheet hides the root and leaves it with no row, no heading text and no monster name; a later open shows it again and a reopened frame starts closed', () => {
    // WRONG IMPL KILLED: a close that only hides (the rows and the name stay in the document: the e2e
    // text scans read hidden text, and a stale name would announce the previous monster); a sheet
    // that never comes back; a reopen that keeps the last visit's sheet.
    const { view, root } = c8bOpen();
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'care') }));
    const sheet = uif7Sheets(root)[0] as HTMLElement;
    uif7ExpectSame(uif7Shown(root), [sheet], 'fixture: shown');

    view.paint(c8bPaint({ tab: 'party', activeKey: '100' }));
    expect(sheet.hidden, 'the root is hidden').toBe(true);
    expect(uif7Shown(root), 'no sheet shows').toEqual([]);
    expect(sheet.querySelectorAll('[data-nav-key]'), 'no row is left in it').toHaveLength(0);
    expect((sheet.textContent ?? '').trim(), 'and no text at all').toBe('');
    expect(sheet.textContent ?? '', 'no monster name').not.toContain('Kip');
    expect(root.querySelector('#monsters-sheet-name')?.textContent ?? '', 'no heading text').toBe(
      '',
    );
    expect(uif7RowIds(root), 'no sheet row id anywhere in the frame').toEqual([]);

    view.paint(c8bPaint({ tab: 'party', activeKey: '101', sheet: c8bSheet(C8B_MOSS, 'move') }));
    uif7ExpectSame(uif7Shown(root), [sheet], 'it shows again');
    expect(root.querySelector('#monsters-sheet-name')?.textContent, 'with the new name').toBe(
      'Mossling',
    );
    expect(uif7RowIds(root)).toEqual(UIF7_ACTION_IDS);

    view.hide();
    view.show();
    expect(uif7Shown(root), 'a reopened frame starts with no sheet').toEqual([]);
    expect(uif7RowIds(root), 'and no row').toEqual([]);
  });

  it('UIF7.1 focus on a sheet row or its list when the sheet closes stays inside the frame (never <body>), and a content swap keeps focus in the sheet', async () => {
    // WRONG IMPL KILLED: a close that empties the rows under the focused element (focus falls to
    // <body> and the next key heals to the world, out of the frame: the kit's closeContextSheet
    // removes the rows, so the view must move focus itself); a heal that tests only inline
    // display:none (the kit hides by the `hidden` attribute); a content swap that drops focus.
    const { view, root } = c8bOpen();
    await s4FlushMacrotask();
    const open = (): void =>
      view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'summary') }));
    const close = (): void => view.paint(c8bPaint({ tab: 'party', activeKey: '100' }));
    const expectInFrame = (when: string): void => {
      expect(document.activeElement, `${when}: focus is not on <body>`).not.toBe(document.body);
      expect(root.contains(document.activeElement), `${when}: focus is inside the frame root`).toBe(
        true,
      );
      // With no sheet left to hold it, focus is the title anchor (tightened: a heal to the rows of
      // a hidden sheet would also be "in the frame").
      expect(document.activeElement, `${when}: focus is the title anchor`).toBe(c8bAnchor(root));
    };

    open();
    const list = c8cListOf(root, 'monstersSheet-root-summary');
    list.focus();
    expect(document.activeElement, 'fixture: focus is on the sheet`s list').toBe(list);
    close();
    expectInFrame('closed with focus on the list');

    open();
    const row = c8cById(root, 'monstersSheet-root-care');
    row.focus();
    expect(document.activeElement, 'fixture: focus is on a row').toBe(row);
    close();
    expectInFrame('closed with focus on a row');

    // A swap to the food list keeps focus in the one sheet.
    // Focus on a ROW that the swap removes (the Feed row): the heal must hand focus to the sheet's
    // rows list (the sheet is still shown), never to the title anchor.
    open();
    const swapList = c8cListOf(root, 'monstersSheet-root-summary');
    const feedRow = c8cById(root, 'monstersSheet-root-feed');
    feedRow.focus();
    expect(document.activeElement, 'fixture: focus is on the Feed row').toBe(feedRow);
    view.paint(
      c8bPaint({
        tab: 'party',
        activeKey: '100',
        sheet: null,
        feed: { foods: [{ itemId: 7, name: 'Bait', count: 3 }], activeKey: '7' },
      }),
    );
    expect(root.contains(feedRow), 'fixture: the swap removed the focused row').toBe(false);
    const after = document.activeElement as HTMLElement;
    expect(after.closest('[data-context-sheet]'), 'focus is still in the sheet').not.toBeNull();
    expect(after, 'it is the sheet`s rows list').toBe(swapList);
    expect(after, 'not the title anchor').not.toBe(c8bAnchor(root));
  });
});

describe('BoxView uif-7: Close and Back rows, one content at a time (UIF7.2, UIF7.3)', () => {
  const NO_PATH: EvolutionMonsterViewModel = {
    ...C8C_TWO_CHOICES,
    paths: [],
    eligibleCount: 0,
    choices: [],
    readyPathName: null,
  };
  const paintFeed = (view: BoxView, foods: readonly FoodVm[], activeKey: string | null): void =>
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', feed: { foods, activeKey } }));
  const paintEvolve = (
    view: BoxView,
    mon: EvolutionMonsterViewModel,
    activeKey: string | null,
  ): void => view.paint(c8bPaint({ tab: 'party', activeKey: '100', evolve: { mon, activeKey } }));
  const lastRow = (list: HTMLElement): HTMLElement => list.lastElementChild as HTMLElement;

  it('UIF7.2 the sheet`s rows end with Close (monstersSheet-root-close reading kit.sheet.close, enabled, last in DOM order, directly after Move) and Close can be the active row', () => {
    // WRONG IMPL KILLED: a Close row missing, first, or before Move; a label from a literal; a
    // Close row drawn disabled (aria-disabled, .is-disabled) or with a reason; one that cannot carry
    // the cursor (the screen's Up from Summary lands on it).
    const { view, root } = c8bOpen();
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'close') }));
    const list = c8cListOf(root, 'monstersSheet-root-close');
    const close = lastRow(list);
    expect(close.id, 'Close is the last row').toBe('monstersSheet-root-close');
    expect(close.textContent, 'it reads the catalog').toBe(i18nT('kit.sheet.close'));
    expect(close.textContent, 'English bytes').toBe('Close');
    expect(close.children.length, 'a bare label: no reason, no extra element').toBe(0);
    expect(close.getAttribute('aria-disabled'), 'enabled').toBeNull();
    expect(close.classList.contains('is-disabled')).toBe(false);
    expect(close.previousElementSibling?.id, 'directly after Move').toBe('monstersSheet-root-move');
    expect(c8cActiveIds(list), 'the painted action Close is the active row').toEqual([
      'monstersSheet-root-close',
    ]);
    expect(close.getAttribute('aria-selected')).toBe('true');
    // Cooling Care, no food, no path: Close stays an ordinary enabled row.
    view.paint(
      c8bPaint({
        tab: 'party',
        activeKey: '100',
        sheet: c8bSheet(C8B_KIP, 'summary', false, false, 3_600_000n),
      }),
    );
    expect(lastRow(list).id).toBe('monstersSheet-root-close');
    expect(lastRow(list).getAttribute('aria-disabled'), 'enabled whatever the flags').toBeNull();
    expect(lastRow(list).getAttribute('aria-selected')).toBe('false');
  });

  it('UIF7.2 the food list, the Evolve list and the empty lists end with Back (monstersSheet-root-back reading kit.sheet.back, enabled, last in DOM order, a bare label) and Back can be the active row', () => {
    // WRONG IMPL KILLED: a Back row only in the lists that have rows (an emptied list would have no
    // way back); Back filled with a path heading or a food line; a Back row disabled with the
    // unmet paths around it; Back not last; a Back that cannot carry the cursor.
    const { view, root } = c8bOpen();
    const expectBack = (when: string, list: HTMLElement, active: boolean): void => {
      const back = lastRow(list);
      expect(back.id, `${when}: Back is the last row`).toBe('monstersSheet-root-back');
      expect(back.textContent, `${when}: it reads the catalog`).toBe(i18nT('kit.sheet.back'));
      expect(back.textContent, `${when}: English bytes`).toBe('Back');
      expect(back.children.length, `${when}: a bare label`).toBe(0);
      expect(back.getAttribute('aria-disabled'), `${when}: enabled`).toBeNull();
      expect(back.classList.contains('is-disabled'), `${when}: not dimmed`).toBe(false);
      expect(back.getAttribute('aria-selected'), `${when}: active iff painted`).toBe(
        active ? 'true' : 'false',
      );
      expect(
        [...list.querySelectorAll('[id$="-back"]')].length,
        `${when}: exactly one Back row`,
      ).toBe(1);
    };

    const BAIT: FoodVm = { itemId: 7, name: 'Bait', count: 3 };
    paintFeed(view, [BAIT], '7');
    const list = c8cListOf(root, 'monstersSheet-root-7');
    expectBack('food list, on a food', list, false);
    paintFeed(view, [BAIT], 'back');
    expectBack('food list, on Back', list, true);
    paintFeed(view, [], 'back');
    expect(
      c8cOptions(list).map((r) => r.id),
      'no food: Back alone',
    ).toEqual(['monstersSheet-root-back']);
    expectBack('empty food list', list, true);

    paintEvolve(view, C8C_TWO_CHOICES, '20');
    expectBack('Evolve list with choices, on a path', list, false);
    paintEvolve(view, C8C_ONE_READY, 'back');
    expectBack('Evolve list with one ready path, on Back', list, true);
    expect(
      c8cOptions(list).map((r) => r.getAttribute('aria-disabled')),
      'the unmet and the auto-applied paths are dimmed, Back is not',
    ).toEqual(['true', 'true', null]);
    paintEvolve(view, NO_PATH, 'back');
    expect(
      c8cOptions(list).map((r) => r.id),
      'no path: Back alone',
    ).toEqual(['monstersSheet-root-back']);
    expectBack('Evolve list with no path', list, true);
  });

  it('UIF7.2 under fr the Close and Back rows read Fermer and Retour, and English again after the locale returns', () => {
    // WRONG IMPL KILLED: labels resolved once at construction and cached across a locale switch;
    // an English literal (a French boot reads Close).
    const { view, root } = c8bOpen();
    try {
      p2SetLocale('fr');
      view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'close') }));
      const list = c8cListOf(root, 'monstersSheet-root-close');
      expect(lastRow(list).textContent, 'fr Close').toBe('Fermer');
      paintFeed(view, [{ itemId: 7, name: 'Bait', count: 3 }], 'back');
      expect(lastRow(list).textContent, 'fr Back').toBe('Retour');
      p2SetLocale('en');
      paintFeed(view, [{ itemId: 7, name: 'Bait', count: 3 }], 'back');
      expect(lastRow(list).textContent, 'en Back again').toBe('Back');
    } finally {
      p2SetLocale('en');
    }
  });

  it('UIF7.3 while the food list, the Evolve list and the confirm paint, the frame holds exactly ONE [data-context-sheet], the same root throughout, shown, with exactly that content`s rows (every id monstersSheet-root-<key>) and no sheet action row, and only one list is visible', () => {
    // WRONG IMPL KILLED: today's separate food, Evolve and confirm lists painted under the sheet
    // (several listboxes shown, the sheet's action rows left on screen); a second sheet root per
    // content (stacking: the kit's one root is reused so a sub-list replaces rows); rows under
    // another frame id (`monstersFeed-*`, `monstersEvolve-*`, `monstersConfirm-*`: the pointer
    // source, e2e and the nav ids all read one frame id); an old row left behind after a swap.
    const { parent, view, root } = c8bOpen();
    view.paint(c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'feed') }));
    const sheet = uif7Sheets(root)[0] as HTMLElement;
    expect(uif7RowIds(root), 'fixture: the sheet`s rows').toEqual(UIF7_ACTION_IDS);

    const contents: ReadonlyArray<readonly [string, () => void, readonly string[], string]> = [
      [
        'the food list',
        () =>
          paintFeed(
            view,
            [
              { itemId: 7, name: 'Bait', count: 3 },
              { itemId: 40, name: 'Glowberry', count: 12 },
            ],
            '7',
          ),
        ['monstersSheet-root-7', 'monstersSheet-root-40', 'monstersSheet-root-back'],
        'list',
      ],
      [
        'the Evolve list',
        () => paintEvolve(view, C8C_TWO_CHOICES, '20'),
        [
          'monstersSheet-root-10',
          'monstersSheet-root-20',
          'monstersSheet-root-30',
          'monstersSheet-root-back',
        ],
        'list',
      ],
      [
        'the confirm',
        () =>
          view.paint(
            c8bPaint({
              tab: 'party',
              activeKey: '100',
              confirm: { name: 'Kip', species: 'Emberfang', yes: false },
            }),
          ),
        ['monstersSheet-root-yes', 'monstersSheet-root-no'],
        'confirm',
      ],
      [
        'the sheet again',
        () =>
          view.paint(
            c8bPaint({ tab: 'party', activeKey: '100', sheet: c8bSheet(C8B_KIP, 'summary') }),
          ),
        UIF7_ACTION_IDS,
        'list',
      ],
    ];
    for (const [name, paint, ids, variant] of contents) {
      paint();
      uif7ExpectSame(uif7Sheets(root), [sheet], `${name}: still the one root`);
      uif7ExpectSame(uif7Shown(root), [sheet], `${name}: and it shows`);
      expect(uif7RowIds(root), `${name}: exactly its rows, in order`).toEqual(ids);
      expect(sheet.dataset.sheetVariant, `${name}: the variant`).toBe(variant);
      if (name !== 'the sheet again') {
        for (const id of UIF7_ACTION_IDS) {
          expect(
            root.querySelector(`[id="${id}"]`),
            `${name}: no sheet action row ${id}`,
          ).toBeNull();
        }
      }
      const visibleLists = [...root.querySelectorAll<HTMLElement>('[role="listbox"]')].filter(
        (el) => !c8bHidden(el, root),
      );
      expect(visibleLists, `${name}: one list is visible`).toHaveLength(1);
      c8cInPanelNotInGridBeforeHint(parent, root, sheet, `${name}: the sheet`);
    }
  });

  it('UIF7.3 the confirm renders as the confirm variant: data-sheet-variant="confirm", its heading holds the box.evolve.confirm text, Yes and No are the rows named by it, and No is the selected row by default; the list variant returns with the next list', () => {
    // WRONG IMPL KILLED: a confirm rendered as a list (no data-sheet-variant="confirm": the kit's
    // confirm styling and the pointer proof key on it); the question left in a separate part (the
    // heading would hold the monster's name); a Yes default (a double tap would evolve); both or
    // neither answer selected; the question from a literal or not carrying the monster and species.
    const { view, root } = c8bOpen();
    const confirm = (yes: boolean): void =>
      view.paint(
        c8bPaint({
          tab: 'party',
          activeKey: '100',
          confirm: { name: 'Kip', species: 'Emberfang', yes },
        }),
      );
    confirm(false);
    const sheet = uif7Shown(root)[0] as HTMLElement;
    expect(sheet.dataset.sheetVariant, 'the confirm variant').toBe('confirm');
    const heading = root.querySelector('#monsters-sheet-name') as HTMLElement;
    expect(sheet.contains(heading)).toBe(true);
    expect(heading.textContent, 'the heading holds the question').toBe(
      i18nTf('box.evolve.confirm', { name: 'Kip', species: 'Emberfang' }),
    );
    expect(heading.hidden, 'shown').toBe(false);
    const yes = c8cById(root, 'monstersSheet-root-yes');
    const no = c8cById(root, 'monstersSheet-root-no');
    expect(no.getAttribute('aria-selected'), 'No is selected by default').toBe('true');
    expect(yes.getAttribute('aria-selected'), 'Yes is not').toBe('false');
    expect(c8cListOf(root, 'monstersSheet-root-no').getAttribute('aria-labelledby')).toBe(
      'monsters-sheet-name',
    );
    confirm(true);
    expect(yes.getAttribute('aria-selected'), 'Yes when painted').toBe('true');
    expect(no.getAttribute('aria-selected')).toBe('false');
    paintEvolve(view, C8C_TWO_CHOICES, '20');
    expect(sheet.dataset.sheetVariant, 'the list variant returns').toBe('list');
    expect(heading.textContent, 'with the monster`s name as the heading').toBe('Kip');
  });
});

describe('BoxView uif-7: the Summary is a page (UIF7.4)', () => {
  const grids = (parent: HTMLElement): readonly HTMLElement[] => [
    partyGridOf(parent),
    boxGridOf(parent),
  ];

  it('UIF7.4 the summary paints a page inside #monsters-panel in place of both grids (each display:none), with no sheet shown and the tab bar still displayed, its text holding the card line and every stat value, on both tabs, and #monsters-summary-stats is kept', () => {
    // WRONG IMPL KILLED: today's pane under the sheet (the sheet and a grid still showing); a page
    // that hides only the active grid (the other tab's cells stay in the a11y tree); a page drawn
    // outside the panel or inside a grid (a refresh rebuilds the grid); the tab bar hidden with the
    // grids (a tab click would have nothing to land on); a page missing a stat (level, HP,
    // trust, attack, defense, speed, spAttack, spDefense: the game's only stats display); the id
    // `monsters-summary-stats` renamed (qf-9 and the e2e text scans read it).
    const { parent, view, root } = q9Open(q9Map());
    const stats = q9MossStats();
    for (const tab of ['party', 'storage'] as const) {
      view.paint(c8bPaint({ tab, activeKey: tab === 'party' ? '101' : '200', summary: C8B_MOSS }));
      const where = `${tab} tab`;
      for (const grid of grids(parent)) {
        expect(grid.style.display, `${where}: a grid is display:none`).toBe('none');
        expect(c8bHidden(grid, root), `${where}: read as hidden`).toBe(true);
      }
      expect(uif7Shown(root), `${where}: no sheet shows`).toEqual([]);
      const bar = root.querySelector<HTMLElement>('.mr-tabbar') as HTMLElement;
      expect(c8bHidden(bar, root), `${where}: the tab bar stays displayed`).toBe(false);
      expect(c8bSelected(root), `${where}: the selected tab follows the paint`).toEqual(
        tab === 'party' ? ['true', 'false'] : ['false', 'true'],
      );

      const line = q9Line(root);
      expect(c8bHidden(line, root), `${where}: the stats line shows`).toBe(false);
      const panel = monstersPanelOf(parent);
      let page: HTMLElement = line;
      while (page.parentElement !== null && page.parentElement !== panel) page = page.parentElement;
      expect(page.parentElement, `${where}: the page is a child of #monsters-panel`).toBe(panel);
      expect(
        grids(parent).some((g) => g.contains(page)),
        `${where}: not in a grid`,
      ).toBe(false);
      expect(c8bHidden(page, root), `${where}: the page shows`).toBe(false);
      const text = page.textContent ?? '';
      expect(text, `${where}: the card line (level, HP)`).toContain(p2Stats(C8B_MOSS));
      expect(text, `${where}: the stats line`).toContain(q9En(stats));
      for (const value of [
        String(C8B_MOSS.level),
        String(C8B_MOSS.currentHp),
        String(C8B_MOSS.statHp),
        stats.trustTier,
        String(stats.statAttack),
        String(stats.statDefense),
        String(stats.statSpeed),
        String(stats.statSpAttack),
        String(stats.statSpDefense),
      ]) {
        expect(text, `${where}: the page holds ${value}`).toContain(value);
      }
      expect(text, `${where}: the monster's name heads the page`).toContain('Mossling');
    }
  });

  it('UIF7.4 a paint with no summary restores the active grid, hides and empties the page, and the sheet and the page replace each other', () => {
    // WRONG IMPL KILLED: a page that stays after the summary closes (a grid never comes back); a
    // grid restored to the wrong display or the inactive grid shown too; stat text left in the
    // hidden page (the e2e scans read hidden text); a sheet left open under the page.
    const { parent, view, root } = q9Open(q9Map());
    view.paint(c8bPaint({ tab: 'party', activeKey: '101', sheet: c8bSheet(C8B_MOSS, 'summary') }));
    expect(uif7Shown(root), 'fixture: the sheet shows').toHaveLength(1);
    expect(partyGridOf(parent).style.display, 'fixture: the Party grid shows').toBe('grid');

    view.paint(c8bPaint({ tab: 'party', activeKey: '101', summary: C8B_MOSS }));
    expect(uif7Shown(root), 'the page replaces the sheet').toEqual([]);
    expect(uif7RowIds(root), 'and no sheet row is left').toEqual([]);
    expect(q9Line(root).textContent, 'the page holds the stats').toBe(q9En(q9MossStats()));

    view.paint(c8bPaint({ tab: 'party', activeKey: '101', sheet: c8bSheet(C8B_MOSS, 'summary') }));
    expect(partyGridOf(parent).style.display, 'the Party grid is back').toBe('grid');
    expect(boxGridOf(parent).style.display, 'the Storage grid stays hidden').toBe('none');
    expect(uif7Shown(root), 'the sheet is back').toHaveLength(1);
    expect(c8bHidden(q9Line(root), root), 'the page is hidden').toBe(true);
    expect(root.textContent ?? '', 'and holds no stat text').not.toContain('ATK ');

    view.paint(c8bPaint({ tab: 'storage', activeKey: '200' }));
    expect(boxGridOf(parent).style.display, 'Storage: its grid shows').toBe('grid');
    expect(partyGridOf(parent).style.display, 'and the Party grid is hidden').toBe('none');
  });
});
