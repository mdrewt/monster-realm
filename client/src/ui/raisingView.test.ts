// @vitest-environment happy-dom
// ui/raisingView.test.ts — RED gating tests for feel-polish D1 care feedback.
//
// SOURCE OF TRUTH: EARS criterion "WHEN the player presses the care-button/action,
// THE UI SHALL show a visible confirmation (toast, animation, or stat-delta
// feedback)." + docs/adr/0159-feel-polish-care-feedback-npc-wander.md D1.
//
// STATUS UPDATE (post-implementation code review, round 1): RaisingView has since
// shipped `#raising-feedback` (constructor-appended inside the overlay root,
// textContent-only) and the Care button's `#pending`/disabled re-entrancy guard.
// Re-verified against the current source: C1-C5 below are GREEN against the shipped
// raisingView.ts — round 1's code review found no issues in this file; that round's
// one finding (stale feedback into a hidden overlay) is a main.ts WIRING bug (the
// injected showFeedback callback has no visibility guard), not a defect in
// RaisingView itself, and is gated separately by main.wiring.test.ts's
// W-CARE-SHOWFEEDBACK-VISIBLE-GUARD and careAction.test.ts's visibility-agnostic
// pins. C1-C5 function as regression guards proving that shipped behaviour holds.
//
// RED-TEAM ROUND 2 (code-review BUG 2, a genuine defect IN THIS FILE): the shipped
// `#pending` (raisingView.ts:34) is a SINGLE class-level boolean shared across every
// monster's Care button (raisingView.ts:158-174), not tracked per monster. Two
// demonstrated symptoms: (1) with >=2 monsters, a care call in flight for monster A
// holds the shared flag, so clicking monster B's Care button — visually enabled,
// since only A's DOM node was disabled — is a SILENT no-op (before this slice there
// was no guard at all, so B worked; this is a genuine regression this slice
// introduced); (2) a batch-triggered refresh() mid-flight rebuilds the Care button
// via `#monsterEl.replaceChildren()`; the new button is NOT disabled but the shared
// flag still swallows its click. See the new "★★ ... C6" describe block below —
// BOTH of its tests are genuinely RED against the current shipped raisingView.ts.
//
// rb-120 (R-20r-a-CARE-GEN) later replaced the per-monster `#pending` SET narrated above with
// a `Map<bigint, object>` generation-token lock (the Train shape, ported onto Care) — see the
// rb-120 describe block appended after the 20r-a Train block below.
//
// This file did not exist before this change — RaisingView had no unit test file
// (it is currently listed in vite.config.ts coverage.exclude as a "thin DOM shell";
// this suite exercises its new feedback surface directly regardless of that
// coverage-reporting exclusion, which this file does NOT touch).
//
// Pattern follows the sibling idiom EXACTLY (renameView.test.ts / shopView.test.ts /
// tradeProposeView.test.ts): happy-dom environment, DOM fixture built in
// beforeEach, vi.fn() callbacks, assertions on textContent/disabled/containment.
// RaisingView differs from those siblings in one respect: it builds its ENTIRE DOM
// tree via document.createElement in its OWN constructor (raisingView.ts:27-58) —
// there is no static index.html markup to mount, so the fixture below is just an
// empty mount-point `<div>` passed as `parent` to `new RaisingView(parent, cbs)`.
//
// WRONG-IMPL-KILLED list (one per criterion):
//   C1 (showFeedback writes the message)      -> no-op showFeedback impl
//   C2 (CONTAINMENT — the real shipped bug)    -> feedback node appended OUTSIDE the
//                                                 z-index:100 overlay root (the exact
//                                                 statusEl bug this ADR fixes)
//   C3 (no markup injection)                   -> an innerHTML regression (XSS via a
//                                                 server-supplied SenderError string)
//   C4 (re-entrancy guard)                     -> a Care button with no #pending lock
//                                                 (double-click fires two care calls,
//                                                 producing the contradictory
//                                                 "Cared!" -> "care cooldown not yet
//                                                 elapsed" flash)
//   C5 (Care still calls back with monsterId)  -> regression frame around the
//                                                 pre-existing button behaviour
//   C6 (per-monster #pending, code-review      -> a single view-wide #pending boolean
//       BUG 2)                                    shared across monsters: monster B's
//                                                 click is silently swallowed while
//                                                 A is pending, and a still-pending
//                                                 monster's rebuilt button (post-
//                                                 refresh()) loses its disabled state
//
// Do NOT edit these tests to match a buggy implementation — corrections must trace
// to ADR-0159 D1 only, never to the code under test.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RaisingViewModel } from './raisingModel';
import type { RaisingViewCallbacks } from './raisingView';
import { RaisingView } from './raisingView';

// ---------------------------------------------------------------------------
// Overlay a11y wiring for RaisingView (constructed-shell, #app-mounted).
// Declared FIRST in the file, before any pre-existing describe AND
// before the file's own root-level `beforeEach`/`afterEach` (document.body reset /
// vi.restoreAllMocks()) — so this sweep runs first among the root-level hooks.
//
// COMPOSITION NOTE (plan §8 A7): DEFER-FOCUS and CLOSE-RESTORE are folded into
// S4-raisingView-ANCHOR-FOCUS and S4-raisingView-CLOSE-RESTORE-UNGUARDED — see
// battleView.test.ts's file header for the full rationale.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test-util/stripComments';
import { t } from './a11yCopy';
import { scanSource } from './i18n/hardcodedStrings';
import { currentLocale, t as i18nT, tf as i18nTf, setLocale } from './i18n/resolver';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';

vi.mock('./overlayA11y', { spy: true });
// m24s4 MECHANISM oracle, same shape as m24s3: records every t()/tf() call AND
// calls through to the real resolver, so RV-01's DOM byte-identity assertions still work.
vi.mock('./i18n/resolver', { spy: true });

/** ONE real macrotask boundary — never vi.useFakeTimers() (plan anti-pattern #10). */
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

const S4_ID: OverlayId = 'raisingView';
const S4_META = OVERLAY_A11Y[S4_ID];

/** A focusable OUTSIDE the overlay: the "pre-open" element a close must restore focus to. */
function s4OutsideSentinel(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 's4-outside-sentinel';
  document.body.appendChild(btn);
  return btn;
}

/** A focusable INSIDE the overlay, as a DIRECT child of the root. */
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

function s4Mount(): { parent: HTMLElement; view: RaisingView } {
  const parent = mountParent();
  const view = new RaisingView(parent, makeCallbacks());
  return { parent, view };
}

describe('RaisingView — m23-s4 overlay a11y wiring on the show()/hide()/toggle() edge', () => {
  it('S4-raisingView-OPEN-ARIA BITES: the first show() from a hidden shell labels the root from OVERLAY_A11Y/t()', () => {
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    expect(view.visible, 'the shell must start hidden, so show() IS an edge').toBe(false);

    view.show();

    expect(root.getAttribute('role'), 'role must come from OVERLAY_A11Y').toBe(S4_META.role);
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(root.getAttribute('aria-label')).toBe(t(S4_META.labelKey));
  });

  it('S4-raisingView-ANCHOR-FOCUS BITES: the anchor resolves to an <h2 tabindex="-1"> with byte-unchanged "Raising & Inventory" text, and focus moves to it after ONE real macrotask (never synchronously)', async () => {
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    view.show();

    const anchor = root.querySelector<HTMLElement>(S4_META.initialFocusSelector);
    expect(
      anchor,
      `the anchor selector ${S4_META.initialFocusSelector} must resolve`,
    ).not.toBeNull();
    expect(anchor!.tagName).toBe('H2');
    expect(anchor!.getAttribute('tabindex')).toBe('-1');
    expect(anchor!.textContent, 'byte-unchanged overlay title text').toBe('Raising & Inventory');

    expect(document.activeElement, 'not focused synchronously').not.toBe(anchor);
    await s4FlushMacrotask();
    expect(document.activeElement, 'focused by IDENTITY after one real macrotask').toBe(anchor);
  });

  it('S4-raisingView-HELPER-CALLED BITES: the view DELEGATES to the S1 helpers with its OWN id, its OWN root, and a literal null fallbackFocus', () => {
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);

    view.show();
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith(S4_ID, root);

    view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S4_ID, null);
  });

  it('S4-raisingView-CLOSE-RESTORE-UNGUARDED BITES: hide() strips all three attributes and restores focus to the pre-open element; hide() on a never-shown view still closes without throwing; show/hide/hide yields exactly two closes', async () => {
    const outside = s4OutsideSentinel();
    outside.focus();
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);

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

    const fresh = s4Mount();
    expect(fresh.view.visible).toBe(false);
    expect(() => fresh.view.hide()).not.toThrow();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledWith(S4_ID, null);

    vi.clearAllMocks();
    const cycle = s4Mount();
    cycle.view.show();
    cycle.view.hide();
    cycle.view.hide();
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(2);
  });

  it('S4-raisingView-REPEAT-NO-REOPEN BITES: show() on an already-visible overlay neither re-opens nor yanks focus off a sentinel parked inside the root', async () => {
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
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

  it('S4-raisingView-OPEN-LAST BITES: openOverlayA11y is invoked with root.style.display ALREADY painted (neither "none" nor "") — never open-before-paint', () => {
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    const capture = s4CaptureDisplayAtOpen(root);

    view.show();

    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(capture.display()).not.toBe('none');
    expect(capture.display()).not.toBe('');
  });

  it('S4-raisingView-TOGGLE BITES: toggle() from hidden opens exactly once; toggle() again closes exactly once', () => {
    const { view } = s4Mount();
    expect(view.visible).toBe(false);

    view.toggle();
    expect(view.visible).toBe(true);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);

    view.toggle();
    expect(view.visible).toBe(false);
    expect(vi.mocked(closeOverlayA11y)).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// DOM fixture — RaisingView builds its own tree; the fixture is just a mount point.
// happy-dom shares ONE document across the whole file; wipe the body each time so a
// failed test's leftover overlay never bleeds into the next test's lookups.
// ---------------------------------------------------------------------------

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mountParent(): HTMLElement {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return parent;
}

function makeCallbacks(overrides: Partial<RaisingViewCallbacks> = {}): RaisingViewCallbacks {
  return {
    onTrain: vi.fn(),
    onCare: vi.fn(),
    ...overrides,
  };
}

// One monster, zero items — keeps the rendered DOM to exactly ONE <button> (Care),
// so `querySelector('button')` unambiguously finds the Care button in the C4/C5
// tests regardless of how the implementer lays out the feedback node.
function oneMonsterVm(monsterId: bigint): RaisingViewModel {
  return {
    monsters: [
      {
        monsterId,
        nickname: 'Aria',
        level: 5,
        // EG4-4 (contract §E): RaisingMonsterViewModel.bond -> trustTier.
        trustTier: 'Neutral',
        currentHp: 20,
        statHp: 20,
        statAttack: 5,
        statDefense: 5,
        statSpeed: 5,
        statSpAttack: 5,
        statSpDefense: 5,
      },
    ],
    items: [],
  };
}

// Two monsters, zero items — two Care buttons in monster-array order, so
// `querySelectorAll('button')[0]` / `[1]` unambiguously map to A / B in the C6
// per-monster-pending tests below.
function twoMonsterVm(idA: bigint, idB: bigint): RaisingViewModel {
  const base = {
    level: 5,
    // EG4-4 (contract §E): RaisingMonsterViewModel.bond -> trustTier.
    trustTier: 'Neutral' as const,
    currentHp: 20,
    statHp: 20,
    statAttack: 5,
    statDefense: 5,
    statSpeed: 5,
    statSpAttack: 5,
    statSpDefense: 5,
  };
  return {
    monsters: [
      { monsterId: idA, nickname: 'Aria', ...base },
      { monsterId: idB, nickname: 'Bram', ...base },
    ],
    items: [],
  };
}

// The overlay root is the SOLE child RaisingView appends into `parent` at
// construction time (raisingView.ts:58 `parent.appendChild(this.#root)`) — grabbing
// `parent.firstElementChild` gets the real overlay root regardless of what internal
// feedback node the implementer adds (the C2 containment tooth below).
function overlayRootOf(parent: HTMLElement): HTMLElement {
  const root = parent.firstElementChild;
  if (root === null) {
    throw new Error('RaisingView did not append an overlay root into parent');
  }
  return root as HTMLElement;
}

// Drain the microtask queue for .finally()-driven pending-lock resets
// (renameView.test.ts / shopView.test.ts precedent).
async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ctl-7b (R-ci-fix-20261002T0901Z-RAISINGVIEWREBUILD): RaisingView.refresh now re-renders a list only
// when its content changed, so a refresh with a deep-equal view-model no longer rebuilds the cards.
// The tests below that NEED a rebuild (a mid-flight batch that replaces the clicked node) therefore
// refresh with a CHANGED view-model — every monster one level higher — which is also what a real
// batch that rebuilds the cards looks like. Equal view-models are covered by the CTL7B-RV-* cases.
function withBumpedLevel(vm: RaisingViewModel): RaisingViewModel {
  return { ...vm, monsters: vm.monsters.map((m) => ({ ...m, level: m.level + 1 })) };
}

// ---------------------------------------------------------------------------
// The status line swaps its Bond readout for a Trust-tier readout.
//
// WHY BOTH HALVES ARE ASSERTED: a half-swap is the realistic failure. Rendering
// `Bond ${mon.trustTier}` satisfies "the tier name appears"; rendering
// `Trust ${mon.bond}` satisfies "the word Trust appears" (and would crash to
// `undefined` once the field is gone). Only the positive AND the negative together
// close it.
// ---------------------------------------------------------------------------

describe('★ RaisingView status line (EG4-4): Trust tier replaces the Bond readout', () => {
  it('★ BITES: the rendered card shows "Trust" AND the tier name, and never the word "Bond"', () => {
    // WRONG IMPL KILLED (a): the shipped `Bond ${mon.bond}` surviving untouched.
    // WRONG IMPL KILLED (b): the LABEL swapped but the VALUE left on the retired field
    // (`Trust ${mon.bond}`) — with `bond` gone from the view-model that renders the
    // literal text "Trust undefined", which this test's tier-name assertion catches.
    // WRONG IMPL KILLED (c): the VALUE swapped but the label left (`Bond Friendly`) —
    // caught by the negative.
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks());
    const vm = oneMonsterVm(1n);
    view.refresh({
      ...vm,
      monsters: [{ ...vm.monsters[0]!, trustTier: 'Friendly' }],
    });

    const text = overlayRootOf(parent).textContent ?? '';
    expect(text, 'the raising status line must label the readout "Trust"').toContain('Trust');
    expect(
      text,
      'the raising status line must render the monster\'s OWN trust tier name ("Friendly" ' +
        'here) — not a placeholder, not "undefined", not a hard-coded tier',
    ).toContain('Friendly');
    expect(
      text.includes('Bond'),
      'the raising status line must NOT contain the word "Bond" any more — `bond` is retired ' +
        'from StoreMonsterPub and from RaisingMonsterViewModel (contract §B/§E). RED TODAY: ' +
        'raisingView.ts:150 still renders `Bond ${mon.bond}`',
    ).toBe(false);
    expect(text.includes('undefined'), 'no field may render as the literal "undefined"').toBe(
      false,
    );
  });

  it('★ BITES: the tier name is read PER MONSTER, not hard-coded (two monsters, two tiers)', () => {
    // WRONG IMPL KILLED: `Trust Neutral` written as a literal, or the tier read once
    // and reused for every card in the loop. Two monsters with DIFFERENT tiers, both
    // rendered from the same refresh(), is what separates "reads mon.trustTier" from
    // "prints something tier-shaped".
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks());
    const vm = twoMonsterVm(1n, 2n);
    view.refresh({
      ...vm,
      monsters: [
        { ...vm.monsters[0]!, trustTier: 'Hostile' },
        { ...vm.monsters[1]!, trustTier: 'Devoted' },
      ],
    });

    const text = overlayRootOf(parent).textContent ?? '';
    expect(text).toContain('Hostile');
    expect(text).toContain('Devoted');
    expect(text.includes('Bond')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C1: showFeedback writes the message into the feedback node's textContent.
// ---------------------------------------------------------------------------

describe('RaisingView showFeedback(): writes the message (C1, ADR-0159 D1)', () => {
  it('C1 BITES: showFeedback("Cared!") puts "Cared!" in #raising-feedback textContent — kills no-op impl', () => {
    // WRONG IMPL KILLED: an impl where showFeedback() is a no-op, or writes to the
    // wrong element, or is missing entirely.
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks());

    view.show(); // showFeedback is a no-op while hidden
    view.showFeedback('Cared!');

    const feedbackEl = document.getElementById('raising-feedback');
    expect(
      feedbackEl,
      'RaisingView must create a #raising-feedback node (ADR-0159 D1)',
    ).not.toBeNull();
    expect(feedbackEl!.textContent).toBe('Cared!');
  });
});

// ---------------------------------------------------------------------------
// C2: CONTAINMENT — the tooth that kills the ACTUAL shipped bug. The feedback node
// must be a descendant of the raising overlay root (ctl-7b: the class-styled .mr-frame
// .mr-shell, an absolutely positioned layer at z-index 100 — it was an inline position:fixed
// overlay when this tooth was written), never a sibling node like statusEl that the overlay
// paints over.
// ---------------------------------------------------------------------------

describe('★ RaisingView showFeedback(): CONTAINMENT — feedback node is inside the overlay root (C2, ADR-0159 D1)', () => {
  it('★ C2 BITES: the #raising-feedback node is a DESCENDANT of the overlay root — kills the exact shipped bug (a node OUTSIDE the z-index:100 overlay, invisible behind it)', () => {
    // WRONG IMPL KILLED: an impl that writes feedback to a node appended to `document.body`
    // (or reuses main.ts's `statusEl`) instead of INSIDE the RaisingView's own overlay root.
    // The raising overlay is a shell layer at z-index 100 (ctl-7b: `.mr-shell`; it was an
    // inline `position:fixed; inset:0; z-index:100` root when this tooth was written) —
    // a message written OUTSIDE it is painted over and invisible, exactly like the
    // pre-fix statusEl bug this ADR fixes. A textContent-only assertion on a node found
    // by getElementById alone would NOT catch this (the node could exist anywhere in the
    // document and still satisfy a naive "does the text appear somewhere" check) — the
    // `.contains()` assertion is what makes this bite.
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks());

    view.showFeedback('Cared!');

    const overlayRoot = overlayRootOf(parent);
    const feedbackEl = document.getElementById('raising-feedback');
    expect(feedbackEl, '#raising-feedback must exist').not.toBeNull();
    expect(
      overlayRoot.contains(feedbackEl!),
      'the feedback node must be a DESCENDANT of the raising overlay root — a node appended ' +
        'outside the overlay (e.g. a bare document.body child, or reusing main.ts statusEl) is ' +
        'painted over by the z-index:100 shell and is never visible to the player',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C3: NO MARKUP INJECTION — server-supplied SenderError text (which can carry
// player-adjacent or arbitrary strings) must render as literal text, never markup.
// ---------------------------------------------------------------------------

describe('★ RaisingView showFeedback(): NO markup injection — textContent only (C3, ADR-0159 D1)', () => {
  it('★ C3 BITES: showFeedback with an HTML-looking string leaves literal text and ZERO element children — kills an innerHTML regression (XSS)', () => {
    // WRONG IMPL KILLED: an impl that writes `el.innerHTML = message` instead of
    // `el.textContent = message`. The message can carry a server-supplied SenderError
    // reason string (reduceErrorMessage(err, 'care')) — innerHTML would let an
    // attacker-crafted or malformed server string execute as markup/script.
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks());
    const payload = '<img src=x onerror=alert(1)>';

    view.show(); // showFeedback is a no-op while hidden
    view.showFeedback(payload);

    const feedbackEl = document.getElementById('raising-feedback');
    expect(feedbackEl, '#raising-feedback must exist').not.toBeNull();
    expect(
      feedbackEl!.textContent,
      'the raw string must be preserved verbatim as literal text',
    ).toBe(payload);
    expect(
      feedbackEl!.children.length,
      'the feedback node must have ZERO element children — an innerHTML write would parse ' +
        '<img> into a real element child',
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// C4: RE-ENTRANCY GUARD — the Care button gains the #pending/disabled lock already
// shipped on shopView/renameView, so a double-click cannot fire two care calls.
// ---------------------------------------------------------------------------

describe('★ RaisingView Care button: re-entrancy guard (C4, ADR-0159 D1)', () => {
  it('★ C4 BITES: two rapid Care clicks before the first call settles invoke onCare exactly ONCE, and the button is disabled while pending — kills missing-#pending-lock impl', async () => {
    // WRONG IMPL KILLED: a Care button with no #pending lock.
    // Without the guard, a double-click fires onCare TWICE before the first
    // reducer call settles — the exact contradictory "Cared!" -> "care cooldown
    // not yet elapsed" flash ADR-0159 D1 exists to prevent.
    let resolveFlight: (() => void) | undefined;
    const flightPromise = new Promise<void>((res) => {
      resolveFlight = res;
    });
    // onCare is typed `(monsterId: bigint) => void | Promise<void>`, but (shopView/renameView
    // precedent, later ported to the Train shape by rb-120 / R-20r-a-CARE-GEN) the guard
    // implementation is expected to wrap the callback's return value via
    // `new Promise<void>((resolve) => resolve(this.#callbacks.onCare(...)))` behind a
    // generation-token `#pending: Map<bigint, object>`, so a caller that genuinely returns a
    // pending Promise keeps the lock held until it settles.
    const onCare = vi.fn().mockReturnValue(flightPromise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.refresh(oneMonsterVm(7n));

    const careBtn = overlayRootOf(parent).querySelector('button') as HTMLButtonElement;
    expect(careBtn, 'the Care button must exist after refresh()').toBeTruthy();

    careBtn.click(); // first click — initiates the in-flight call
    careBtn.click(); // second click while still in-flight — must be a no-op

    expect(
      onCare,
      'onCare must be called exactly once despite two rapid clicks (#pending re-entrancy lock)',
    ).toHaveBeenCalledOnce();
    expect(careBtn.disabled, 'the Care button must be disabled while a care call is pending').toBe(
      true,
    );

    resolveFlight?.();
    await flushPromises();

    expect(
      careBtn.disabled,
      'the Care button must be re-enabled once the pending call settles (no dead-button-forever)',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C5: regression frame — Care still calls back with the correct monsterId.
// ---------------------------------------------------------------------------

describe('RaisingView Care button: calls onCare with the correct monsterId (C5, regression)', () => {
  it('C5: clicking Care invokes onCare exactly once, with the monsterId from the rendered VM — kills a wrong-id/no-call regression', () => {
    const onCare = vi.fn();
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.refresh(oneMonsterVm(42n));

    const careBtn = overlayRootOf(parent).querySelector('button') as HTMLButtonElement;
    expect(careBtn, 'the Care button must exist after refresh()').toBeTruthy();

    careBtn.click();

    expect(onCare).toHaveBeenCalledOnce();
    expect(onCare).toHaveBeenCalledWith(42n);
  });
});

// ---------------------------------------------------------------------------
// ★★ C6: #pending must be tracked PER MONSTER, not view-wide.
//   (1) With >=2 monsters, a care call in flight for monster A holds the SHARED
//       flag, so clicking monster B's Care button — visually enabled, since only
//       A's DOM node was disabled — is a SILENT no-op.
//   (2) A batch-triggered refresh() mid-flight rebuilds the Care button via
//       `#monsterEl.replaceChildren()`; the new button is NOT disabled but the
//       shared flag still swallows its click — "looks clickable, silently does
//       nothing".
// ---------------------------------------------------------------------------

describe('★★ RaisingView Care button: #pending must be tracked PER MONSTER, not view-wide (C6, code-review BUG 2)', () => {
  it("★★ BITES: with two monsters rendered, A pending does NOT block B — B's onCare fires exactly once and B's button stays enabled, while A's button IS disabled — kills the shared view-wide #pending regression", async () => {
    // WRONG IMPL KILLED: a single class-level `#pending`
    // boolean shared across every monster row. Clicking A sets it true; clicking B
    // then hits `if (this.#pending) return;` and is silently swallowed, even though
    // B's own button was never disabled (it looks clickable).
    let resolveA: (() => void) | undefined;
    const flightA = new Promise<void>((res) => {
      resolveA = res;
    });
    const onCare = vi.fn((monsterId: bigint) => (monsterId === 1n ? flightA : undefined));
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.refresh(twoMonsterVm(1n, 2n));

    const buttons = overlayRootOf(parent).querySelectorAll('button');
    expect(buttons.length, 'two monsters, zero items -> exactly two Care buttons').toBe(2);
    const careA = buttons[0] as HTMLButtonElement;
    const careB = buttons[1] as HTMLButtonElement;

    careA.click(); // A now pending, unresolved

    expect(careA.disabled, "A's own button must be disabled while A is pending").toBe(true);
    expect(
      careB.disabled,
      "B's button must remain ENABLED while only A is pending — A's pending state must not " +
        'leak to B (pending must be tracked per monster)',
    ).toBe(false);

    careB.click();

    expect(
      onCare,
      'clicking B while A is pending must still invoke onCare for B exactly once — a shared ' +
        "view-wide #pending flag would silently swallow this click even though B's button " +
        'was never disabled',
    ).toHaveBeenCalledWith(2n);
    expect(onCare.mock.calls.filter(([id]) => id === 2n)).toHaveLength(1);

    resolveA?.();
    await flushPromises();
  });

  it("★★ BITES: after a refresh() re-render mid-flight, A's freshly-rebuilt button comes back DISABLED (pending state re-derived, not lost) while B's is enabled — kills the lost-pending-state-on-rebuild regression", async () => {
    // WRONG IMPL KILLED: `#renderMonsters` rebuilds EVERY Care button from scratch via
    // `#monsterEl.replaceChildren()` on every refresh() (e.g. a batch-triggered
    // mid-flight update). The CURRENT shipped shape creates each new button with
    // `disabled` left at its default (false) and never consults any per-monster
    // pending state when building it — so a still-pending monster's BRAND NEW button
    // renders enabled, "looks clickable, silently does nothing" (the shared #pending
    // flag still swallows the click, per the sibling test above). Correct behaviour:
    // pending state lives in a per-monster pending map (rb-120: a generation-token
    // `Map<bigint, object>`) the render function consults when building each button, so
    // a rebuilt button for a still-pending monster is re-derived as disabled, not lost.
    let resolveA: (() => void) | undefined;
    const flightA = new Promise<void>((res) => {
      resolveA = res;
    });
    const onCare = vi.fn((monsterId: bigint) => (monsterId === 1n ? flightA : undefined));
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.refresh(twoMonsterVm(1n, 2n));

    let buttons = overlayRootOf(parent).querySelectorAll('button');
    const careA = buttons[0] as HTMLButtonElement;
    careA.click(); // A pending, unresolved

    expect(careA.disabled, 'A must be disabled immediately after the click').toBe(true);

    // Simulate a batch-applied refresh() while A's care call is still in flight —
    // #renderMonsters replaces ALL monster DOM nodes via replaceChildren().
    // ctl-7b (intentional change): the batch now CHANGES the view-model (a level-up). A refresh
    // with a deep-equal view-model is skipped (no rebuild at all), so it can no longer stand in
    // for "a batch that rebuilds the cards"; the `.not.toBe(careA)` below is the precondition that
    // the rebuild really happened.
    view.refresh(withBumpedLevel(twoMonsterVm(1n, 2n)));

    buttons = overlayRootOf(parent).querySelectorAll('button');
    expect(buttons.length, 'refresh() must still render exactly two Care buttons').toBe(2);
    const careANew = buttons[0] as HTMLButtonElement;
    const careBNew = buttons[1] as HTMLButtonElement;

    expect(
      careANew,
      'refresh() rebuilds a NEW button node for A (replaceChildren) distinct from the old one',
    ).not.toBe(careA);
    expect(
      careANew.disabled,
      "A's freshly-rebuilt button must come back DISABLED — A's pending state must be " +
        're-derived from a per-monster pending map when the button is built, not lost on ' +
        'rebuild (the shared boolean #pending has no way to express this)',
    ).toBe(true);
    expect(
      careBNew.disabled,
      "B's freshly-rebuilt button must be enabled — B was never pending",
    ).toBe(false);

    resolveA?.();
    await flushPromises();
  });
});

// ---------------------------------------------------------------------------
// in-flight guard on the TRAIN buttons (plan D3/D6/D11; matrix RV-1..RV-5).
// The Train lock remains a SEPARATE map (D6) — a pending Care must never block Train on the same
// monster, and vice versa.
// Different reducers, different failure modes.
//
// THE DEFECT (measured): `trainBtn.addEventListener('click', () => this.#callbacks.onTrain(...))`
// — no lock, no disabled state, so a double-click on "Train: Protein" sends `train` twice and
// consumes two items for one intended feed.
//
// happy-dom facts, microtask budget and the hostile-re-enable rationale: see the 20r-a
// section header in battleView.test.ts — the same three facts hold here. `flushPromises`
// above (3 microtasks) is reused; `raDeferred` is this file's own copy.
//
// WRONG-IMPL-KILLED index:
//   RV-1  a shared boolean / a Care-Train cross-block            -> sibling monster + Care stay live
//   RV-1b a disabled-only impl (no pending key)                  -> hostile re-enable
//   RV-1c Train's gate also honouring Care's `#pending` (D6)      -> Train fires while Care pends
//   RV-2  lost pending on rebuild / re-enabling the detached node -> rebuilt-disabled + live re-enable
//   RV-3  a `.then`-only (resolve-only) release; `Promise.resolve(cb())` -> rejection + sync throw
//         release (`.catch(log).finally(release)` is equivalent to the shipped order, not a defect)
//   RV-4  a lock that survives hide()                            -> enabled after hide + refresh
//   RV-5  a membership-keyed release (D11)                       -> still disabled after the stale settle
// ---------------------------------------------------------------------------

interface RaDeferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (e: unknown) => void;
}

function raDeferred(): RaDeferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const RA_PROTEIN = 10;
const RA_IRON = 11;

/** Two monsters (1n Aria, 2n Bram), TWO trainable items and one junk item — so every monster
 *  card renders Care + "Train: Protein" + "Train: Iron" (three buttons, six in total), and
 *  "all Train buttons of that monster disable together" is observable. */
function raTrainVm(): RaisingViewModel {
  return {
    ...twoMonsterVm(1n, 2n),
    items: [
      {
        invId: 100n,
        itemId: RA_PROTEIN,
        name: 'Protein',
        description: 'Raises attack.',
        count: 2,
        trainStat: 'attack',
        canTrain: true,
      },
      {
        invId: 101n,
        itemId: RA_IRON,
        name: 'Iron',
        description: 'Raises defense.',
        count: 1,
        trainStat: 'defense',
        canTrain: true,
      },
      {
        invId: 102n,
        itemId: 12,
        name: 'Pebble',
        description: 'Not trainable.',
        count: 3,
        trainStat: null,
        canTrain: false,
      },
    ],
  };
}

interface RaMonsterControls {
  readonly care: HTMLButtonElement;
  readonly trains: readonly HTMLButtonElement[];
}

/** The LIVE buttons grouped per monster card, in monster-array order (A then B). Grouping is
 *  by the "Care" text that opens each card's action row, so the walk does not depend on how
 *  the implementer lays the row out — only on the render order #renderMonsters already has. */
function raMonsterControls(parent: HTMLElement): readonly [RaMonsterControls, RaMonsterControls] {
  const groups: { care: HTMLButtonElement; trains: HTMLButtonElement[] }[] = [];
  for (const btn of overlayRootOf(parent).querySelectorAll('button')) {
    if (btn.textContent === 'Care') {
      groups.push({ care: btn, trains: [] });
      continue;
    }
    const current = groups[groups.length - 1];
    expect(current, '20r-a precondition: a Train button must follow its card’s Care').toBeDefined();
    expect(
      (btn.textContent ?? '').startsWith('Train: '),
      `20r-a precondition: every non-Care button is a Train button (got ${JSON.stringify(btn.textContent)})`,
    ).toBe(true);
    current!.trains.push(btn);
  }
  expect(groups, '20r-a precondition: two monster cards').toHaveLength(2);
  for (const g of groups) {
    expect(g.trains, '20r-a precondition: two Train buttons per monster').toHaveLength(2);
  }
  return [groups[0]!, groups[1]!];
}

function raDisabled(buttons: readonly HTMLButtonElement[]): boolean[] {
  return buttons.map((b) => b.disabled);
}

describe('★ RaisingView 20r-a: in-flight guard on the Train buttons (separate from Care, D6)', () => {
  it('20r-a RV-1 BITES: two clicks on "Train: Protein" for Aria → ONE onTrain; BOTH of Aria’s Train buttons disabled; Aria’s Care stays ENABLED and fires; Bram’s Train stays enabled and fires', async () => {
    // WRONG IMPL KILLED (1): the shipped code — no lock; two clicks feed two items.
    // WRONG IMPL KILLED (2): a SHARED boolean across monsters (the C6 defect, re-made for
    //   Train) — Bram's Train click below would be swallowed while looking clickable.
    // WRONG IMPL KILLED (3): a Care/Train CROSS-BLOCK (one `#pending` set for both) — Aria's
    //   Care would be disabled / swallowed while her Train call is in flight (plan D6 says no:
    //   different reducers, different failure modes).
    // WRONG IMPL KILLED (4): a per-BUTTON lock — "Train: Iron" for Aria stays live while
    //   "Train: Protein" is in flight; both feed the SAME monster's stat write.
    const d = raDeferred();
    const onTrain = vi.fn((monsterId: bigint) => (monsterId === 1n ? d.promise : undefined));
    const onCare = vi.fn();
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onTrain, onCare }));
    view.refresh(raTrainVm());
    const [a, b] = raMonsterControls(parent);
    expect(raDisabled(a.trains), '20r-a RV-1 precondition: Aria starts enabled').toEqual([
      false,
      false,
    ]);

    a.trains[0]!.click();
    a.trains[0]!.click();
    expect(
      onTrain,
      '20r-a RV-1: two rapid clicks on the same Train button must dispatch onTrain exactly ONCE',
    ).toHaveBeenCalledTimes(1);
    expect(onTrain).toHaveBeenCalledWith(1n, RA_PROTEIN);
    expect(
      raDisabled(a.trains),
      "20r-a RV-1: ALL of Aria's Train buttons must be disabled while her train call is pending — " +
        'the lock is per MONSTER (D6), so "Train: Iron" is locked by a pending "Train: Protein"',
    ).toEqual([true, true]);
    expect(
      a.care.disabled,
      "20r-a RV-1: Aria's CARE button must stay ENABLED — Train and Care are separate locks (D6)",
    ).toBe(false);
    a.care.click();
    expect(
      onCare,
      "20r-a RV-1: Aria's Care must dispatch while her Train is pending",
    ).toHaveBeenCalledWith(1n);
    expect(
      raDisabled(b.trains),
      "20r-a RV-1: Bram's Train buttons must stay ENABLED while only Aria is pending",
    ).toEqual([false, false]);
    b.trains[1]!.click();
    expect(
      onTrain,
      "20r-a RV-1: Bram's Train must dispatch (per-monster key)",
    ).toHaveBeenCalledWith(2n, RA_IRON);
    expect(onTrain).toHaveBeenCalledTimes(2);

    await flushPromises(); // Bram's (undefined-returning) call releases; Aria's is still pending
    expect(
      raDisabled(a.trains),
      "20r-a RV-1: Aria's Train buttons are STILL disabled after the microtasks drain — a " +
        'void-returning dispatch releases here while the reducer call is in flight',
    ).toEqual([true, true]);
    expect(raDisabled(b.trains), "20r-a RV-1: Bram's released").toEqual([false, false]);

    d.resolve();
    await flushPromises();
    expect(
      raDisabled(a.trains),
      "20r-a RV-1: Aria's Train buttons must be re-enabled once her call settles",
    ).toEqual([false, false]);
    a.trains[1]!.click();
    expect(onTrain).toHaveBeenCalledTimes(3);
    expect(onTrain).toHaveBeenLastCalledWith(1n, RA_IRON);
    await flushPromises();
  });

  it('20r-a RV-1b BITES: hostile re-enable — click Train, set the LIVE button `disabled = false` by hand, click again → still ONE onTrain', async () => {
    // WRONG IMPL KILLED: a disabled-only implementation with no pending key (plan D1). happy-dom
    //   swallows a click on a disabled button, so RV-1 alone is satisfied by the attribute; the
    //   hand re-enable is the only way this tier reaches the listener, and then only the key can
    //   refuse the dispatch.
    const d = raDeferred();
    const onTrain = vi.fn().mockReturnValue(d.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onTrain }));
    view.refresh(raTrainVm());
    const [a] = raMonsterControls(parent);

    a.trains[1]!.click();
    expect(onTrain).toHaveBeenCalledTimes(1);
    expect(a.trains[1]!.disabled, '20r-a RV-1b precondition: the lock disabled the button').toBe(
      true,
    );
    a.trains[1]!.disabled = false;
    a.trains[1]!.click();
    expect(
      onTrain,
      '20r-a RV-1b: with the node re-enabled by hand the PENDING KEY must still swallow the click',
    ).toHaveBeenCalledTimes(1);
    // ...and the OTHER Train button of the same monster, re-enabled by hand, is swallowed too.
    a.trains[0]!.disabled = false;
    a.trains[0]!.click();
    expect(
      onTrain,
      '20r-a RV-1b: the per-monster key covers the sibling Train button',
    ).toHaveBeenCalledTimes(1);

    d.resolve();
    await flushPromises();
    a.trains[1]!.click();
    expect(onTrain, '20r-a RV-1b: dispatches again after the settle').toHaveBeenCalledTimes(2);
  });

  it('20r-a RV-1c BITES: a never-settling CARE call on Aria does NOT block her Train — Train buttons stay ENABLED and the Train click dispatches (D6, Care first)', async () => {
    // WRONG IMPL KILLED ★ MEASURED SURVIVOR (round 2): Train's click gate also honouring Care's
    //   `#pending` (`if (this.#pending.has(monsterId) || this.#pendingTrain.has(monsterId))
    //   return;`, or a shared set). RV-1 clicks Train FIRST and only proves Care is not blocked
    //   by Train; this row is the other direction. A Care call can stay pending for as long as
    //   the server takes (or forever after a link drop — the shipped Care lock is only cleared
    //   by hide()), and plan D6 says a pending Care must never lock the player out of feeding:
    //   different reducers, different failure modes.
    const careFlight = raDeferred(); // never settled
    const onCare = vi.fn().mockReturnValue(careFlight.promise);
    const onTrain = vi.fn();
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onTrain, onCare }));
    view.refresh(raTrainVm());
    const [a] = raMonsterControls(parent);

    a.care.click(); // Care FIRST — and it never settles
    expect(onCare).toHaveBeenCalledTimes(1);
    expect(a.care.disabled, '20r-a RV-1c precondition: the Care lock is held').toBe(true);
    expect(
      raDisabled(a.trains),
      "20r-a RV-1c: Aria's Train buttons must stay ENABLED while her Care call is pending — the " +
        'two locks are separate sets (D6)',
    ).toEqual([false, false]);

    a.trains[0]!.click();
    expect(
      onTrain,
      "20r-a RV-1c: Aria's Train click must DISPATCH while her Care is pending — a Train gate " +
        "that also reads Care's `#pending` swallows it (measured survivor)",
    ).toHaveBeenCalledTimes(1);
    expect(onTrain).toHaveBeenCalledWith(1n, RA_PROTEIN);
    expect(a.care.disabled, '20r-a RV-1c: the Care lock is untouched by the Train click').toBe(
      true,
    );

    await flushPromises(); // the (void-returning) Train call releases; Care still pending
    expect(raDisabled(a.trains), '20r-a RV-1c: Train released on its own settle').toEqual([
      false,
      false,
    ]);
    expect(a.care.disabled, '20r-a RV-1c: Care is still pending').toBe(true);
  });

  it('20r-a RV-2 BITES: a mid-flight refresh() rebuilds Aria’s Train buttons DISABLED (Care and Bram enabled), swallows a click on the new node, and the settle re-enables the LIVE nodes', async () => {
    // WRONG IMPL KILLED (1): `trainBtn.disabled` left at its default on rebuild (the C6 defect) —
    //   a batch tick mid-flight ships an enabled-looking button whose click the key swallows.
    // WRONG IMPL KILLED (2): the `.finally` re-enabling the closure-captured node — after
    //   `#monsterEl.replaceChildren()` it is detached; the LIVE buttons stay disabled forever.
    //   What makes the live list reachable from the settle is the `#trainButtons.set(monsterId,
    //   trainBtns)` write in #renderMonsters on EVERY rebuild (the `.clear()` beside
    //   `#careButtons.clear()` only drops entries for monsters that left the VM).
    const d = raDeferred();
    const onTrain = vi.fn().mockReturnValue(d.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onTrain }));
    view.refresh(raTrainVm());
    const [a0] = raMonsterControls(parent);
    a0.trains[0]!.click();
    expect(raDisabled(a0.trains), '20r-a RV-2 precondition: locked').toEqual([true, true]);

    // ctl-7b (intentional change): the batch tick CHANGES the view-model (a level-up) — a refresh
    // with a deep-equal one is skipped, so only a changed one rebuilds. The `.not.toBe` below is
    // the precondition that the rebuild really happened.
    view.refresh(withBumpedLevel(raTrainVm())); // batch tick while the call is in flight
    const [a, b] = raMonsterControls(parent);
    expect(a.trains[0], '20r-a RV-2 precondition: refresh() rebuilt the node').not.toBe(
      a0.trains[0],
    );
    expect(a0.trains[0]!.isConnected, '20r-a RV-2 precondition: the old node is detached').toBe(
      false,
    );
    expect(
      raDisabled(a.trains),
      "20r-a RV-2: Aria's REBUILT Train buttons must come back DISABLED — " +
        '`trainBtn.disabled = this.#pendingTrain.has(monsterId)` at build time, not lost on rebuild',
    ).toEqual([true, true]);
    expect(a.care.disabled, "20r-a RV-2: Aria's rebuilt Care is enabled (separate lock)").toBe(
      false,
    );
    expect(raDisabled(b.trains), "20r-a RV-2: Bram's rebuilt Train buttons are enabled").toEqual([
      false,
      false,
    ]);
    a.trains[1]!.click(); // swallowed by disabled
    a.trains[1]!.disabled = false; // hostile
    a.trains[1]!.click();
    expect(
      onTrain,
      '20r-a RV-2: a click on a rebuilt (and hand re-enabled) Train button is swallowed by the key',
    ).toHaveBeenCalledTimes(1);
    a.trains[1]!.disabled = true;

    d.resolve();
    await flushPromises();
    const [live] = raMonsterControls(parent);
    expect(live.trains[0], '20r-a RV-2: a settle does not re-render').toBe(a.trains[0]);
    expect(
      raDisabled(live.trains),
      '20r-a RV-2: the LIVE (rebuilt) Train buttons must be re-enabled on settle — re-enabling ' +
        'the detached closure node strands the real ones disabled until the next refresh',
    ).toEqual([false, false]);
    live.trains[0]!.click();
    expect(onTrain).toHaveBeenCalledTimes(2);
  });

  it('20r-a RV-3a BITES: onTrain REJECTS → still disabled before the settle, enabled after it, the next click dispatches, no unhandled rejection', async () => {
    // WRONG IMPL KILLED: a `.then`-only (resolve-only) release (release skipped on rejection →
    //   dead until hide(); `.catch(log).finally(release)` is equivalent to the shipped order and
    //   is NOT a defect); `.finally` with no trailing `.catch` (vitest fails the run on the
    //   unhandled rejection — that run-level error is the tooth). console.error is silenced,
    //   not asserted.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = raDeferred();
    const onTrain = vi.fn().mockReturnValue(d.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onTrain }));
    view.refresh(raTrainVm());
    const [a] = raMonsterControls(parent);

    a.trains[0]!.click();
    expect(raDisabled(a.trains), '20r-a RV-3a precondition: locked').toEqual([true, true]);
    await flushPromises();
    expect(raDisabled(a.trains), '20r-a RV-3a: still locked while in flight').toEqual([true, true]);

    d.reject(new Error('20r-a RV-3a: train rejected'));
    await flushPromises();
    expect(
      raDisabled(a.trains),
      '20r-a RV-3a: a REJECTED train call must release the lock (the release lives in `.finally`)',
    ).toEqual([false, false]);
    a.trains[0]!.click();
    expect(onTrain, '20r-a RV-3a: dispatches again after the rejection').toHaveBeenCalledTimes(2);
    await flushPromises();
  });

  it('20r-a RV-3b BITES: onTrain THROWS synchronously → the click does not throw, the lock was taken, and after one flush the buttons are enabled and re-clickable', async () => {
    // WRONG IMPL KILLED: `Promise.resolve(cb())` (plan D3) — the throw escapes the listener
    //   after the lock is set and before any `.finally` exists; with happy-dom's error capturing
    //   disabled it comes straight out of `.click()`. The required shape is
    //   `new Promise((resolve) => resolve(cb()))`.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onTrain = vi.fn(() => {
      throw new Error('20r-a RV-3b: synchronous throw');
    });
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onTrain }));
    view.refresh(raTrainVm());
    const [a] = raMonsterControls(parent);

    expect(
      () => a.trains[0]!.click(),
      '20r-a RV-3b: a synchronously-throwing onTrain must not throw out of the click',
    ).not.toThrow();
    expect(onTrain).toHaveBeenCalledTimes(1);
    expect(raDisabled(a.trains), '20r-a RV-3b: the lock was taken before the callback ran').toEqual(
      [true, true],
    );
    await flushPromises();
    expect(
      raDisabled(a.trains),
      '20r-a RV-3b: the sync throw must settle the chain and RELEASE — `Promise.resolve(cb())` ' +
        'leaves both buttons dead here',
    ).toEqual([false, false]);
    a.trains[1]!.click();
    expect(onTrain, '20r-a RV-3b: re-clickable after the throw').toHaveBeenCalledTimes(2);
    await flushPromises();
  });

  it('20r-a RV-4 BITES: hide() clears the Train lock (and, regression, still clears the Care lock) — after hide() + show() + refresh() both dispatch again', async () => {
    // WRONG IMPL KILLED: a Train lock released ONLY by `.finally`. The SDK never settles an
    //   in-flight reducer promise after a link drop; main.ts's onReconnect hides this view
    //   (M-3) so THIS release runs — `#pendingTrain.clear()` beside `#pending.clear()`.
    // The Care half is GREEN today (raisingView.ts hide() already clears `#pending`); it is
    //   asserted here so the two clears are proven side by side and neither can regress alone.
    const trainFlight = raDeferred(); // never settled
    const careFlight = raDeferred(); // never settled
    const onTrain = vi.fn().mockReturnValue(trainFlight.promise);
    const onCare = vi.fn().mockReturnValue(careFlight.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onTrain, onCare }));
    view.show();
    view.refresh(raTrainVm());
    const [a] = raMonsterControls(parent);
    a.trains[0]!.click();
    a.care.click();
    expect(raDisabled(a.trains), '20r-a RV-4 precondition: Train locked').toEqual([true, true]);
    expect(a.care.disabled, '20r-a RV-4 precondition: Care locked').toBe(true);

    view.hide();
    view.show();
    view.refresh(raTrainVm());
    const [after] = raMonsterControls(parent);
    expect(
      raDisabled(after.trains),
      '20r-a RV-4: after hide() the Train lock must be gone — the rebuilt buttons are ENABLED',
    ).toEqual([false, false]);
    expect(after.care.disabled, '20r-a RV-4 (regression): the Care lock is gone too').toBe(false);
    after.trains[0]!.click();
    after.care.click();
    expect(onTrain, '20r-a RV-4: Train dispatches after the hide-release').toHaveBeenCalledTimes(2);
    expect(
      onCare,
      '20r-a RV-4 (regression): Care dispatches after the hide-release',
    ).toHaveBeenCalledTimes(2);
  });

  it('20r-a RV-5 BITES: two overlapping generations — click (P1), hide(), re-show + click (P2), settle P1 → STILL disabled and a third click is swallowed; settle P2 → enabled', async () => {
    // WRONG IMPL KILLED (plan D11): a release keyed by SET MEMBERSHIP (`#pendingTrain.delete(
    //   monsterId)` unconditionally in `.finally`). hide() clears the set, the overlay re-opens,
    //   a second click adds the SAME monsterId again with P2 in flight, then the STALE P1
    //   settles and deletes it — P2's buttons come back live and a third feed is sent. Only a
    //   `Map<bigint, object>` whose `.finally` checks `get(id) === myToken` refuses it.
    const p1 = raDeferred();
    const p2 = raDeferred();
    const onTrain = vi.fn().mockReturnValueOnce(p1.promise).mockReturnValueOnce(p2.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onTrain }));
    view.show();
    view.refresh(raTrainVm());

    raMonsterControls(parent)[0].trains[0]!.click(); // generation 1
    expect(onTrain).toHaveBeenCalledTimes(1);
    expect(raDisabled(raMonsterControls(parent)[0].trains), '20r-a RV-5 precondition').toEqual([
      true,
      true,
    ]);

    view.hide(); // releases generation 1 — P1 still in flight
    view.show();
    view.refresh(raTrainVm());
    const [gen2] = raMonsterControls(parent);
    expect(raDisabled(gen2.trains), '20r-a RV-5 precondition: hide() released').toEqual([
      false,
      false,
    ]);
    gen2.trains[0]!.click(); // generation 2
    expect(onTrain).toHaveBeenCalledTimes(2);
    expect(raDisabled(gen2.trains), '20r-a RV-5 precondition: generation 2 locked').toEqual([
      true,
      true,
    ]);

    p1.resolve(); // the STALE settle
    await flushPromises();
    const [afterStale] = raMonsterControls(parent);
    expect(
      raDisabled(afterStale.trains),
      "20r-a RV-5: generation 1's settle must NOT release generation 2's lock — P2 is still in " +
        'flight. An unconditional `#pendingTrain.delete(monsterId)` clears it here',
    ).toEqual([true, true]);
    afterStale.trains[1]!.click(); // swallowed by disabled
    afterStale.trains[1]!.disabled = false; // hostile
    afterStale.trains[1]!.click();
    expect(
      onTrain,
      '20r-a RV-5: a third click while P2 is in flight must be swallowed by the pending key',
    ).toHaveBeenCalledTimes(2);
    afterStale.trains[1]!.disabled = true;

    p2.resolve();
    await flushPromises();
    expect(
      raDisabled(raMonsterControls(parent)[0].trains),
      "20r-a RV-5: generation 2's OWN settle releases",
    ).toEqual([false, false]);
    raMonsterControls(parent)[0].trains[0]!.click();
    expect(onTrain).toHaveBeenCalledTimes(3);
    await flushPromises();
  });
});

// ---------------------------------------------------------------------------
// The Care lock carries the Train generation-token shape (residual
// R-20r-a-CARE-GEN; docs/specs/20r-a-plan.md D3/D11).
//
// WRONG-IMPL-KILLED index:
//   rb120-CARE-GEN               -> membership-keyed release (D11): a stale generation's
//                                    settle releases a LIVE generation's lock
//   rb120-CARE-STALE-REJECT      -> the same defect via the REJECT arm — kills a release
//                                    guarded on the resolve arm only, or a `.then(ok, release)`
//                                    shape that never token-checks on rejection
//   rb120-CARE-THROW             -> `Promise.resolve(cb())` (D3): a synchronous throw escapes
//                                    the listener before any `.finally` exists
//   rb120-CARE-LIVE              -> CLOSURE_REENABLE: the `.finally` re-enabling the
//                                    click-closure's captured `careBtn` instead of
//                                    `#careButtons.get(monsterId)` — regression guard
//   rb120-CARE-TRAIN-INDEPENDENT -> a Care/Train shared pending map, or a release keyed on
//                                    anything but the Care lock's OWN token (D6 + D11 together)
// ---------------------------------------------------------------------------

describe('★ RaisingView rb-120: the Care lock carries the Train generation-token shape (R-20r-a-CARE-GEN)', () => {
  it('rb120-CARE-GEN BITES: two overlapping Care generations on the same monster — a stale settle must not release the live lock', async () => {
    const p1 = raDeferred();
    const p2 = raDeferred();
    const onCare = vi.fn().mockReturnValueOnce(p1.promise).mockReturnValueOnce(p2.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.show();
    view.refresh(twoMonsterVm(1n, 2n));

    let buttons = overlayRootOf(parent).querySelectorAll('button');
    const careA0 = buttons[0] as HTMLButtonElement;
    const careB = buttons[1] as HTMLButtonElement;
    expect(careB.disabled, 'rb120-CARE-GEN precondition: B starts enabled').toBe(false);

    careA0.click(); // generation 1
    expect(onCare, 'rb120-CARE-GEN precondition: generation 1 dispatched').toHaveBeenCalledTimes(1);
    expect(careA0.disabled, 'rb120-CARE-GEN precondition: A locked').toBe(true);
    expect(careB.disabled, "rb120-CARE-GEN: B must never be touched by A's lock").toBe(false);

    view.hide(); // releases generation 1's lock — P1 is still in flight
    view.show();
    view.refresh(twoMonsterVm(1n, 2n));
    buttons = overlayRootOf(parent).querySelectorAll('button');
    const careA1 = buttons[0] as HTMLButtonElement;
    const careB1 = buttons[1] as HTMLButtonElement;
    expect(careA1, 'rb120-CARE-GEN precondition: refresh() rebuilt a new Care node for A').not.toBe(
      careA0,
    );
    expect(
      careA1.disabled,
      'rb120-CARE-GEN precondition: hide() released — rebuilt A is enabled',
    ).toBe(false);

    careA1.click(); // generation 2 — same monsterId, NEW token
    expect(onCare, 'rb120-CARE-GEN precondition: generation 2 dispatched').toHaveBeenCalledTimes(2);
    expect(careA1.disabled, 'rb120-CARE-GEN precondition: generation 2 locked').toBe(true);
    expect(careB1.disabled, 'rb120-CARE-GEN: B stays enabled through generation 2').toBe(false);

    p1.resolve(); // the STALE settle
    await flushPromises();
    expect(
      careA1.disabled,
      'rb120-CARE-GEN BITES: generation 1 settling must NOT release generation 2 — the LIVE ' +
        'Care button must still be disabled while P2 is in flight',
    ).toBe(true);
    expect(careB1.disabled, 'rb120-CARE-GEN: B is still untouched by either generation').toBe(
      false,
    );

    careA1.disabled = false; // hostile re-enable
    careA1.click();
    expect(
      onCare,
      'rb120-CARE-GEN: a third click while generation 2 is in flight must be swallowed by the ' +
        'pending key',
    ).toHaveBeenCalledTimes(2);
    careA1.disabled = true;

    p2.resolve();
    await flushPromises();
    expect(careA1.disabled, "rb120-CARE-GEN: generation 2's own settle releases").toBe(false);
    careA1.click();
    expect(onCare).toHaveBeenCalledTimes(3);
    await flushPromises();
  });

  it('rb120-CARE-STALE-REJECT BITES: a STALE generation REJECTS — the release must still be token-gated on the reject arm, not just resolve', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const p1 = raDeferred();
    const p2 = raDeferred();
    const onCare = vi.fn().mockReturnValueOnce(p1.promise).mockReturnValueOnce(p2.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.show();
    view.refresh(oneMonsterVm(7n));

    const careBtn0 = overlayRootOf(parent).querySelector('button') as HTMLButtonElement;
    careBtn0.click(); // generation 1
    expect(onCare).toHaveBeenCalledTimes(1);

    view.hide();
    view.show();
    view.refresh(oneMonsterVm(7n));
    const careLive = overlayRootOf(parent).querySelector('button') as HTMLButtonElement;
    expect(careLive, 'precondition: refresh() rebuilt a new Care node').not.toBe(careBtn0);
    expect(careLive.disabled, 'precondition: hide() released — rebuilt enabled').toBe(false);

    careLive.click(); // generation 2
    expect(onCare).toHaveBeenCalledTimes(2);
    expect(careLive.disabled, 'precondition: generation 2 locked').toBe(true);

    p1.reject(new Error('rb120-CARE-STALE-REJECT: stale generation rejected'));
    await flushPromises();
    expect(
      careLive.disabled,
      'rb120-CARE-STALE-REJECT BITES: a REJECTED stale generation must not release a LIVE ' +
        'pending generation — the live Care button must stay disabled',
    ).toBe(true);

    careLive.disabled = false; // hostile
    careLive.click();
    expect(
      onCare,
      'rb120-CARE-STALE-REJECT: a hostile click while generation 2 is pending must be swallowed',
    ).toHaveBeenCalledTimes(2);
    careLive.disabled = true;

    p2.resolve();
    await flushPromises();
    expect(careLive.disabled, "generation 2's own settle releases").toBe(false);
    careLive.click();
    expect(onCare).toHaveBeenCalledTimes(3);
    await flushPromises();
  });

  it('rb120-CARE-THROW BITES: onCare THROWS synchronously — the click must not throw, the lock is taken immediately, and one flush later the button is re-clickable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onCare = vi.fn(() => {
      throw new Error('rb120-CARE-THROW: synchronous throw');
    });
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.refresh(oneMonsterVm(9n));
    const careBtn = overlayRootOf(parent).querySelector('button') as HTMLButtonElement;

    expect(
      () => careBtn.click(),
      'rb120-CARE-THROW: a synchronously-throwing onCare must not throw out of the click',
    ).not.toThrow();
    expect(onCare).toHaveBeenCalledTimes(1);
    expect(
      careBtn.disabled,
      'rb120-CARE-THROW: the lock must be taken before the callback ran',
    ).toBe(true);

    await flushPromises();
    expect(
      careBtn.disabled,
      'rb120-CARE-THROW BITES: the sync throw must settle the chain and RELEASE — ' +
        '`Promise.resolve(cb())` leaves the button dead here',
    ).toBe(false);
    careBtn.click();
    expect(onCare, 're-clickable after the throw').toHaveBeenCalledTimes(2);
    await flushPromises();
  });

  it('rb120-CARE-LIVE BITES: a mid-flight refresh() detaches the clicked Care node — the settle must re-enable the LIVE (rebuilt) node, not the closure-captured stale one [CLOSURE_REENABLE]', async () => {
    // CLOSURE_REENABLE: an impl whose `.finally()` re-enables the
    // click-closure's captured `careBtn` variable instead of consulting
    // `this.#careButtons.get(monsterId)` passes rb120-CARE-GEN and rb120-CARE-THROW (neither
    // rebuilds the node mid-flight) but DIES here: after `refresh()` rebuilds the node,
    // `careBtn !== ` the live node, so `careBtn.disabled = false` writes to the DETACHED node
    // and the re-queried live node stays disabled forever.
    const d = raDeferred();
    const onCare = vi.fn((monsterId: bigint) => (monsterId === 1n ? d.promise : undefined));
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.refresh(twoMonsterVm(1n, 2n));

    let buttons = overlayRootOf(parent).querySelectorAll('button');
    const careA0 = buttons[0] as HTMLButtonElement;
    careA0.click();
    expect(careA0.disabled, 'precondition: A locked').toBe(true);

    // ctl-7b (intentional change): the batch tick CHANGES the view-model (a level-up) — a refresh
    // with a deep-equal one is skipped, so only a changed one rebuilds. The `.not.toBe` below is
    // the precondition that the rebuild really happened.
    view.refresh(withBumpedLevel(twoMonsterVm(1n, 2n))); // batch tick while A's call is in flight
    buttons = overlayRootOf(parent).querySelectorAll('button');
    const careA1 = buttons[0] as HTMLButtonElement;
    const careB1 = buttons[1] as HTMLButtonElement;
    expect(careA1, "refresh() rebuilt A's node").not.toBe(careA0);
    expect(careA0.isConnected, 'the old (clicked) node is detached').toBe(false);
    expect(careA1.disabled, "A's REBUILT node comes back disabled").toBe(true);
    expect(careB1.disabled, "B's rebuilt node is enabled").toBe(false);

    careA1.click(); // swallowed by disabled
    careA1.disabled = false; // hostile
    careA1.click();
    expect(
      onCare,
      'a click on a rebuilt (and hand re-enabled) Care button is swallowed by the pending key',
    ).toHaveBeenCalledTimes(1);
    careA1.disabled = true;

    d.resolve();
    await flushPromises();
    buttons = overlayRootOf(parent).querySelectorAll('button');
    const careLive = buttons[0] as HTMLButtonElement;
    expect(careLive, 'a settle does not re-render').toBe(careA1);
    expect(
      careLive.disabled,
      'rb120-CARE-LIVE BITES [CLOSURE_REENABLE]: the LIVE (rebuilt) Care button must be ' +
        're-enabled on settle',
    ).toBe(false);
    careLive.click();
    expect(onCare).toHaveBeenCalledTimes(2);
    await flushPromises();
  });

  it("rb120-CARE-TRAIN-INDEPENDENT BITES: the Care generation-token lock is a SEPARATE map from Train's — a stale settle on either side must not cross-release the other", async () => {
    // (A wrong impl that shares ONE map between Care and Train instead fails earlier, at the
    // `onTrain).toHaveBeenCalledTimes(1)` check right after the Train click, because the shared
    // key is already held by Care.)
    const pc = raDeferred();
    const pt = raDeferred();
    const pc2 = raDeferred();
    const onCare = vi.fn().mockReturnValueOnce(pc.promise).mockReturnValueOnce(pc2.promise);
    const onTrain = vi.fn().mockReturnValue(pt.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare, onTrain }));
    view.show();
    view.refresh(raTrainVm());
    const [a0] = raMonsterControls(parent);

    a0.care.click(); // Pc — generation 1 of Care
    expect(onCare).toHaveBeenCalledTimes(1);
    a0.trains[0]!.click(); // Pt — Train, an INDEPENDENT lock
    expect(onTrain).toHaveBeenCalledTimes(1);
    expect(a0.care.disabled, 'precondition: Care locked').toBe(true);
    expect(raDisabled(a0.trains), 'precondition: Train locked').toEqual([true, true]);

    view.hide(); // releases Care AND Train generation 1 — Pc, Pt both still in flight
    view.show();
    view.refresh(raTrainVm());
    const [gen2] = raMonsterControls(parent);
    expect(gen2.care.disabled, 'precondition: hide() released Care').toBe(false);
    expect(raDisabled(gen2.trains), 'precondition: hide() released Train').toEqual([false, false]);

    gen2.care.click(); // Pc2 — Care generation 2, same monsterId
    expect(onCare).toHaveBeenCalledTimes(2);
    expect(gen2.care.disabled, 'precondition: Care generation 2 locked').toBe(true);

    pc.resolve(); // the STALE Care settle
    await flushPromises();
    const [afterPc] = raMonsterControls(parent);
    expect(
      afterPc.care.disabled,
      'rb120-CARE-TRAIN-INDEPENDENT BITES: the stale Care generation settling must NOT release ' +
        "Care generation 2 — Aria's live Care button must still be disabled",
    ).toBe(true);
    expect(
      raDisabled(afterPc.trains),
      "Aria's Train buttons stay enabled — hide() already released Train and nothing re-locked it",
    ).toEqual([false, false]);

    pt.resolve(); // the stale TRAIN settle
    await flushPromises();
    expect(
      afterPc.care.disabled,
      'rb120-CARE-TRAIN-INDEPENDENT: a stale TRAIN settle must not touch the Care lock either',
    ).toBe(true);

    pc2.resolve();
    await flushPromises();
    expect(afterPc.care.disabled, "Care generation 2's own settle releases").toBe(false);
    afterPc.care.click();
    expect(onCare).toHaveBeenCalledTimes(3);
    await flushPromises();
  });
});

// =============================================================================
// i18n migration batch B: raisingView.ts routes its migrated
// sinks through t()/tf() (ADR-0256/0257/0259/0260 resolver) instead of raw
// English literals.
//
// =============================================================================

const M24S4_RV_PLAIN_KEYS = new Set([
  'raising.title',
  'raising.monsters.heading',
  'raising.inventory.heading',
  'raising.monsters.empty',
  'raising.inventory.empty',
  'raising.card.care',
]);

const M24S4_RV_PARAM_KEYS = new Set([
  'raising.card.status',
  'raising.card.stats',
  'raising.card.train',
  'raising.inventory.item',
]);

/** True iff `content` (the text strictly between one `«`/`»` pair) is EXACTLY an
 *  expected sentinel: a bare roster key, or `key|<json>` where `key` is a roster
 *  PARAM key and the tail after the FIRST `|` parses to a plain (non-array,
 *  non-null) object. */
function m24s4RvIsExpectedSentinelSpan(content: string): boolean {
  const bar = content.indexOf('|');
  if (bar === -1) {
    return M24S4_RV_PLAIN_KEYS.has(content) || M24S4_RV_PARAM_KEYS.has(content);
  }
  const key = content.slice(0, bar);
  if (!M24S4_RV_PARAM_KEYS.has(key)) return false;
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
function m24s4RvSplitSentinels(text: string): { stripped: string; unexpectedSpans: string[] } {
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
    if (m24s4RvIsExpectedSentinelSpan(content)) {
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
function m24s4RvWalkSubtree(root: HTMLElement): string[] {
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

const M24S4_RV_ROSTER = [
  'Raising & Inventory',
  'Monsters',
  'Inventory',
  'No monsters.',
  'No items.',
  'Care',
  'Trust ',
  'HP ',
  'ATK ',
  'DEF ',
  'SPD ',
  'SP.ATK ',
  'SP.DEF ',
  'Train: ',
];

function m24s4RvAssertNoRosterWord(texts: readonly string[], label: string): void {
  const { stripped, unexpectedSpans } = m24s4RvSplitSentinels(texts.join('\n'));
  // A FORGED bracket span (raw English wrapped in `«...»` by something other than the
  // resolver) is never elided — it must not exist at all under a correct implementation.
  expect(
    unexpectedSpans,
    `${label}: found «...» span(s) that are not an EXACT expected sentinel (a forged ` +
      `bracket span around raw content is not exempted from the roster scan)`,
  ).toEqual([]);
  for (const word of M24S4_RV_ROSTER) {
    expect(
      stripped.includes(word),
      `${label}: must not contain English roster word "${word}" outside a «sentinel»`,
    ).toBe(false);
  }
}

describe('m24s4 (ADR-0260): raisingView.ts routes its migrated sinks through t()/tf()', () => {
  it('m24s4 RV-01: every migrated sink calls t()/tf() with the exact key and params, exactly one Train request per trainable item-with-stock, show() re-resolves on a repeat open, and every DOM string stays byte-identical', () => {
    vi.mocked(i18nT).mockClear();
    vi.mocked(i18nTf).mockClear();
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks());
    const root = overlayRootOf(parent);

    // --- pre-show: constructor-time keys must NOT have been requested yet (plan D3) ---
    expect(
      i18nT,
      'm24s4 RV-01: raising.title must resolve in show(), not the constructor',
    ).not.toHaveBeenCalledWith('raising.title');
    expect(i18nT).not.toHaveBeenCalledWith('raising.monsters.heading');
    expect(i18nT).not.toHaveBeenCalledWith('raising.inventory.heading');

    // --- empty monsters + empty inventory ---
    view.refresh({ monsters: [], items: [] });
    view.show();
    expect(i18nT).toHaveBeenCalledWith('raising.title');
    expect(i18nT).toHaveBeenCalledWith('raising.monsters.heading');
    expect(i18nT).toHaveBeenCalledWith('raising.inventory.heading');
    expect(i18nT).toHaveBeenCalledWith('raising.monsters.empty');
    expect(i18nT).toHaveBeenCalledWith('raising.inventory.empty');
    expect(root.querySelector('[data-testid="raising-title"]')?.textContent).toBe(
      'Raising & Inventory',
    );
    expect(root.textContent ?? '').toContain('No monsters.');
    expect(root.textContent ?? '').toContain('No items.');

    // --- one monster, three items (one trainable-with-stock, one zero-count, one non-trainable) ---
    vi.mocked(i18nT).mockClear();
    vi.mocked(i18nTf).mockClear();
    const items = [
      {
        invId: 200n,
        itemId: 40,
        name: 'Meadowgrain',
        description: 'A field-grown ration.',
        count: 3,
        trainStat: 'speed',
        canTrain: true,
      },
      {
        invId: 201n,
        itemId: 41,
        name: 'Duskroot',
        description: 'An out-of-stock ration.',
        count: 0,
        trainStat: 'attack',
        canTrain: true,
      },
      {
        invId: 202n,
        itemId: 42,
        name: 'Glimmerpebble',
        description: 'Not a training item.',
        count: 5,
        trainStat: null,
        canTrain: false,
      },
    ];
    const monster = {
      monsterId: 55n,
      nickname: 'Kiri',
      level: 12,
      trustTier: 'Wary' as const,
      currentHp: 30,
      statHp: 50,
      statAttack: 22,
      statDefense: 18,
      statSpeed: 27,
      statSpAttack: 15,
      statSpDefense: 19,
    };
    view.refresh({ monsters: [monster], items });

    expect(i18nT).not.toHaveBeenCalledWith('raising.monsters.empty');
    expect(i18nT).not.toHaveBeenCalledWith('raising.inventory.empty');
    expect(i18nT).toHaveBeenCalledWith('raising.card.care');
    expect(i18nTf).toHaveBeenCalledWith('raising.card.status', {
      level: 12,
      trust: 'Wary',
      current: 30,
      max: 50,
    });
    expect(i18nTf).toHaveBeenCalledWith('raising.card.stats', {
      attack: 22,
      defense: 18,
      speed: 27,
      spAttack: 15,
      spDefense: 19,
    });
    expect(
      vi.mocked(i18nTf).mock.calls.filter(([key]) => key === 'raising.card.train'),
      'RV-01: exactly ONE raising.card.train request — only Meadowgrain qualifies (count > 0 ' +
        'AND canTrain); Duskroot is out of stock and Glimmerpebble is not trainable',
    ).toHaveLength(1);
    expect(i18nTf).toHaveBeenCalledWith('raising.card.train', { name: 'Meadowgrain', count: 3 });
    expect(i18nTf).not.toHaveBeenCalledWith('raising.card.train', { name: 'Duskroot', count: 0 });
    expect(i18nTf).toHaveBeenCalledWith('raising.inventory.item', {
      name: 'Meadowgrain',
      count: 3,
    });
    expect(i18nTf).toHaveBeenCalledWith('raising.inventory.item', { name: 'Duskroot', count: 0 });
    expect(i18nTf).toHaveBeenCalledWith('raising.inventory.item', {
      name: 'Glimmerpebble',
      count: 5,
    });

    // model-supplied strings must render RAW, never a key
    expect(root.textContent ?? '').toContain('Kiri');
    expect(root.textContent ?? '').toContain('A field-grown ration.');
    expect(root.textContent ?? '').toContain('An out-of-stock ration.');
    expect(root.textContent ?? '').toContain('Not a training item.');
    const buttons = [...root.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttons).toContain('Train: Meadowgrain (x3)');

    // --- RT2: a repeat show() re-resolves the constructor-time keys ---
    vi.mocked(i18nT).mockClear();
    view.show();
    expect(
      i18nT,
      'm24s4 RV-01 RT2: a repeat show() on an already-open overlay must re-resolve raising.title',
    ).toHaveBeenCalledWith('raising.title');
    expect(i18nT).toHaveBeenCalledWith('raising.monsters.heading');
    expect(i18nT).toHaveBeenCalledWith('raising.inventory.heading');
  });

  it('m24s4 RV-02: under «key» sentinels, every rendered surface shows resolver output and never an English roster word outside a sentinel, and showFeedback() text stays raw', () => {
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks());
    const root = overlayRootOf(parent);

    try {
      vi.mocked(i18nT).mockImplementation((key: string) => `«${key}»`);
      vi.mocked(i18nTf).mockImplementation(
        (key: string, params: unknown) => `«${key}|${JSON.stringify(params)}»`,
      );

      view.refresh({ monsters: [], items: [] });
      view.show();
      let texts = m24s4RvWalkSubtree(root);
      m24s4RvAssertNoRosterWord(texts, 'monsters+items empty');
      let joined = texts.join('\n');
      expect(joined).toContain('«raising.title»');
      expect(joined).toContain('«raising.monsters.heading»');
      expect(joined).toContain('«raising.inventory.heading»');
      expect(joined).toContain('«raising.monsters.empty»');
      expect(joined).toContain('«raising.inventory.empty»');

      const items = [
        {
          invId: 200n,
          itemId: 40,
          name: 'Meadowgrain',
          description: 'A field-grown ration.',
          count: 3,
          trainStat: 'speed',
          canTrain: true,
        },
        {
          invId: 201n,
          itemId: 41,
          name: 'Duskroot',
          description: 'An out-of-stock ration.',
          count: 0,
          trainStat: 'attack',
          canTrain: true,
        },
        {
          invId: 202n,
          itemId: 42,
          name: 'Glimmerpebble',
          description: 'Not a training item.',
          count: 5,
          trainStat: null,
          canTrain: false,
        },
      ];
      const monster = {
        monsterId: 55n,
        nickname: 'Kiri',
        level: 12,
        trustTier: 'Wary' as const,
        currentHp: 30,
        statHp: 50,
        statAttack: 22,
        statDefense: 18,
        statSpeed: 27,
        statSpAttack: 15,
        statSpDefense: 19,
      };
      view.refresh({ monsters: [monster], items });
      texts = m24s4RvWalkSubtree(root);
      m24s4RvAssertNoRosterWord(texts, 'one monster, three items');
      joined = texts.join('\n');
      expect(joined).toContain('«raising.card.care»');
      expect(joined).toContain(
        `«raising.card.status|${JSON.stringify({ level: 12, trust: 'Wary', current: 30, max: 50 })}»`,
      );
      expect(joined).toContain(
        `«raising.card.stats|${JSON.stringify({
          attack: 22,
          defense: 18,
          speed: 27,
          spAttack: 15,
          spDefense: 19,
        })}»`,
      );
      expect(joined).toContain(
        `«raising.card.train|${JSON.stringify({ name: 'Meadowgrain', count: 3 })}»`,
      );
      expect(joined).toContain(
        `«raising.inventory.item|${JSON.stringify({ name: 'Meadowgrain', count: 3 })}»`,
      );
      expect(joined).toContain(
        `«raising.inventory.item|${JSON.stringify({ name: 'Duskroot', count: 0 })}»`,
      );
      expect(joined).toContain(
        `«raising.inventory.item|${JSON.stringify({ name: 'Glimmerpebble', count: 5 })}»`,
      );
      // model-supplied strings must render RAW, never a sentinel
      expect(joined).toContain('Kiri');
      expect(joined).toContain('A field-grown ration.');

      view.showFeedback('Tended Kiri!');
      texts = m24s4RvWalkSubtree(root);
      m24s4RvAssertNoRosterWord(texts, 'after showFeedback');
      expect(
        texts.join('\n'),
        'showFeedback() text must render raw, never through the resolver',
      ).toContain('Tended Kiri!');
    } finally {
      vi.mocked(i18nT).mockRestore();
      vi.mocked(i18nTf).mockRestore();
    }

    // Post-restore call-through control (an existing S1 key — the new raising.* keys do not
    // exist in the catalog until the specialist ships them).
    expect(i18nT('chrome.help.title')).toBe('Controls & Goals');
  });
});

describe('m24s4 (ADR-0260): raisingView.ts scan — zero failing sinks', () => {
  it('m24s4 RV-03: scanSource(stripComments(raisingView.ts)) has zero failing sinks, a >=16 sink floor, and no truncation/masking tripwires', () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'raisingView.ts'),
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
    ).toBeGreaterThanOrEqual(16);
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

// ---------------------------------------------------------------------------
// rb-121 (residual R-20r-a-FOCUS) — a settle-released Care/Train lock
// re-anchors focus that the no-batch path stranded on <body>, by re-calling
// openOverlayA11y('raisingView', root) when the release finds
// `this.#visible && document.activeElement === document.body`.
//
// WRONG-IMPL-KILLED index (one per tooth, traced to the exact failing assertion):
//   *-REJECT / *-RESOLVE / *-THROW
//       -> a `.catch`-only re-anchor (never fires on the dominant RESOLVE path,
//          since `main.ts`'s sendGuarded ALWAYS resolves) — reds -RESOLVE/-REJECT/
//          -THROW alike, since all three route through `.finally()`.
//       -> acting only on `.catch` while skipping the resolve arm — reds -RESOLVE.
//       -> `Promise.resolve(cb())` instead of `new Promise((resolve) => resolve(cb()))`
//          for THROW — would strand the lock and never even reach `.finally()`;
//          caught by the `not.toThrow()` / disabled-before-callback preconditions.
//   *-DETACH
//       -> re-anchoring only when the CLOSURE-captured (now-detached) button is
//          re-queried, instead of reading the LIVE `this.#root`/`this.#visible` at
//          release time — the anchor is a static node the rebuild never replaces,
//          so this control also catches a release that forgets to re-derive the
//          live button set at all.
//   *-KEEP-INROOT / *-KEEP-OUTROOT
//       -> a condition broader than "focus === document.body" (e.g. "focus is not
//          inside root", or "focus is not on an overlay control") — both would
//          wrongly steal focus from the live in-root sentinel / the out-of-root
//          sentinel these two teeth park it on.
//   *-STALE
//       -> acting in the STALE generation's `.finally()` (no token check gating the
//          re-anchor step, or the re-anchor step placed ahead of the token check).
//   *-HIDDEN
//       -> a missing `#visible` guard — would create an ARIA dialog record (and move
//          focus) on a display:none root.
//   (cross-cutting) porting the re-anchor step onto Care's `.finally()` but not
//       Train's, or vice versa — the CARE and TRAIN tooth pairs below are fully
//       independent fixtures/assertions and both halves must pass.
// ---------------------------------------------------------------------------

describe('rb-121 RaisingView: a settle-released Care/Train lock re-anchors focus the no-batch path stranded on <body> (ADR-0271)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- CARE -----------------------------------------------------------------

  it('rb121-RAISING-CARE-REJECT BITES: onCare REJECTS with no refresh() -> one macrotask after the settle, focus lands on the raisingView anchor (RED on master: activeElement stays <body>)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = raDeferred();
    const onCare = vi.fn().mockReturnValue(d.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.show();
    await s4FlushMacrotask(); // flush the initial open's own deferred focus
    view.refresh(oneMonsterVm(101n));
    const root = overlayRootOf(parent);
    const careBtn = root.querySelector('button') as HTMLButtonElement;

    careBtn.focus();
    careBtn.click();
    expect(onCare, 'precondition: the click dispatched onCare').toHaveBeenCalledTimes(1);
    expect(careBtn.disabled, 'precondition: the click took the lock').toBe(true);
    vi.mocked(openOverlayA11y).mockClear();
    // happy-dom's blur() is a no-op on a DISABLED element, so model Chromium's focus fixup directly.
    document.body.focus();
    expect(
      document.activeElement,
      'precondition: happy-dom does not blur a disabled focused button -- body.focus() models ' +
        "Chromium's real focus-fixup rule",
    ).toBe(document.body);

    d.reject(new Error('rb121-RAISING-CARE-REJECT: onCare rejected'));
    await flushPromises();
    await s4FlushMacrotask();

    const anchor = root.querySelector(S4_META.initialFocusSelector);
    expect(anchor, 'anti-vacuity: the anchor selector must resolve to a real node').not.toBeNull();
    expect(
      document.activeElement,
      'rb121-RAISING-CARE-REJECT: a rejected settle with no refresh() must re-anchor focus via ' +
        'openOverlayA11y',
    ).toBe(anchor);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith('raisingView', root);
  });

  it('rb121-RAISING-CARE-RESOLVE BITES: onCare RESOLVES with no refresh() (the dominant sendGuarded no-batch path) -> one macrotask after the settle, focus lands on the anchor (RED on master)', async () => {
    const d = raDeferred();
    const onCare = vi.fn().mockReturnValue(d.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.show();
    await s4FlushMacrotask();
    view.refresh(oneMonsterVm(102n));
    const root = overlayRootOf(parent);
    const careBtn = root.querySelector('button') as HTMLButtonElement;

    careBtn.focus();
    careBtn.click();
    expect(onCare).toHaveBeenCalledTimes(1);
    expect(careBtn.disabled).toBe(true);
    vi.mocked(openOverlayA11y).mockClear();
    // happy-dom's blur() is a no-op on a DISABLED element, so model Chromium's focus fixup directly.
    document.body.focus();
    expect(document.activeElement).toBe(document.body);

    d.resolve();
    await flushPromises();
    await s4FlushMacrotask();

    const anchor = root.querySelector(S4_META.initialFocusSelector);
    expect(anchor).not.toBeNull();
    expect(
      document.activeElement,
      'rb121-RAISING-CARE-RESOLVE: a resolved settle with no refresh() must re-anchor focus -- ' +
        "this is the DOMINANT production path (main.ts's sendGuarded always resolves)",
    ).toBe(anchor);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith('raisingView', root);
  });

  it('rb121-RAISING-CARE-THROW BITES: onCare THROWS synchronously -> the auto-converted rejection still re-anchors focus after one macrotask (RED on master)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onCare = vi.fn(() => {
      throw new Error('rb121-RAISING-CARE-THROW: synchronous throw');
    });
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.show();
    await s4FlushMacrotask();
    view.refresh(oneMonsterVm(103n));
    const root = overlayRootOf(parent);
    const careBtn = root.querySelector('button') as HTMLButtonElement;

    careBtn.focus();
    expect(
      () => careBtn.click(),
      'a synchronously-throwing onCare must not throw out of the click',
    ).not.toThrow();
    expect(onCare).toHaveBeenCalledTimes(1);
    expect(careBtn.disabled, 'precondition: the lock was taken before the throw').toBe(true);
    vi.mocked(openOverlayA11y).mockClear();
    // happy-dom's blur() is a no-op on a DISABLED element, so model Chromium's focus fixup directly.
    document.body.focus();
    expect(document.activeElement).toBe(document.body);

    await flushPromises();
    await s4FlushMacrotask();

    const anchor = root.querySelector(S4_META.initialFocusSelector);
    expect(anchor).not.toBeNull();
    expect(
      document.activeElement,
      'rb121-RAISING-CARE-THROW: the auto-converted rejection must re-anchor focus',
    ).toBe(anchor);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('rb121-RAISING-CARE-DETACH BITES: a mid-flight refresh() detaches the focused Care node -> the (resolved) settle still re-anchors focus after one macrotask (RED on master)', async () => {
    const d = raDeferred();
    const onCare = vi.fn().mockReturnValue(d.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.show();
    await s4FlushMacrotask();
    view.refresh(oneMonsterVm(104n));
    const root = overlayRootOf(parent);
    const careBtn = root.querySelector('button') as HTMLButtonElement;

    careBtn.focus();
    careBtn.click();
    expect(onCare).toHaveBeenCalledTimes(1);
    expect(careBtn.disabled).toBe(true);

    // ctl-7b (intentional change): a CHANGED view-model (a level-up) — a deep-equal one is skipped
    // and would not detach the focused node; the isConnected check is the rebuild precondition.
    view.refresh(withBumpedLevel(oneMonsterVm(104n))); // mid-flight rebuild detaches the focused node
    expect(careBtn.isConnected, 'precondition: the clicked node is now detached').toBe(false);
    expect(
      document.activeElement,
      'precondition: happy-dom drops activeElement to <body> when the focused node is detached',
    ).toBe(document.body);

    vi.mocked(openOverlayA11y).mockClear();
    d.resolve();
    await flushPromises();
    await s4FlushMacrotask();

    const anchor = root.querySelector(S4_META.initialFocusSelector);
    expect(anchor).not.toBeNull();
    expect(
      document.activeElement,
      'rb121-RAISING-CARE-DETACH: the settle must re-anchor focus even after a mid-flight detach',
    ).toBe(anchor);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  // --- TRAIN ------------------------------------------------------------------

  it('rb121-RAISING-TRAIN-REJECT BITES: onTrain REJECTS with no refresh() -> one macrotask after the settle, focus lands on the anchor (RED on master)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const d = raDeferred();
    const onTrain = vi.fn().mockReturnValue(d.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onTrain }));
    view.show();
    await s4FlushMacrotask();
    view.refresh(raTrainVm());
    const root = overlayRootOf(parent);
    const [a] = raMonsterControls(parent);

    a.trains[0]!.focus();
    a.trains[0]!.click();
    expect(onTrain).toHaveBeenCalledTimes(1);
    expect(a.trains[0]!.disabled).toBe(true);
    vi.mocked(openOverlayA11y).mockClear();
    // happy-dom's blur() is a no-op on a DISABLED element, so model Chromium's focus fixup directly.
    document.body.focus();
    expect(document.activeElement).toBe(document.body);

    d.reject(new Error('rb121-RAISING-TRAIN-REJECT: onTrain rejected'));
    await flushPromises();
    await s4FlushMacrotask();

    const anchor = root.querySelector(S4_META.initialFocusSelector);
    expect(anchor).not.toBeNull();
    expect(
      document.activeElement,
      'rb121-RAISING-TRAIN-REJECT: a rejected settle with no refresh() must re-anchor focus',
    ).toBe(anchor);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith('raisingView', root);
  });

  it('rb121-RAISING-TRAIN-RESOLVE BITES: onTrain RESOLVES with no refresh() (the dominant sendGuarded no-batch path) -> focus lands on the anchor after one macrotask (RED on master)', async () => {
    const d = raDeferred();
    const onTrain = vi.fn().mockReturnValue(d.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onTrain }));
    view.show();
    await s4FlushMacrotask();
    view.refresh(raTrainVm());
    const root = overlayRootOf(parent);
    const [a] = raMonsterControls(parent);

    a.trains[0]!.focus();
    a.trains[0]!.click();
    expect(onTrain).toHaveBeenCalledTimes(1);
    expect(a.trains[0]!.disabled).toBe(true);
    vi.mocked(openOverlayA11y).mockClear();
    // happy-dom's blur() is a no-op on a DISABLED element, so model Chromium's focus fixup directly.
    document.body.focus();
    expect(document.activeElement).toBe(document.body);

    d.resolve();
    await flushPromises();
    await s4FlushMacrotask();

    const anchor = root.querySelector(S4_META.initialFocusSelector);
    expect(anchor).not.toBeNull();
    expect(document.activeElement, 'rb121-RAISING-TRAIN-RESOLVE: must re-anchor focus').toBe(
      anchor,
    );
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledWith('raisingView', root);
  });

  it('rb121-RAISING-TRAIN-THROW BITES: onTrain THROWS synchronously -> the auto-converted rejection still re-anchors focus after one macrotask (RED on master)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const onTrain = vi.fn(() => {
      throw new Error('rb121-RAISING-TRAIN-THROW: synchronous throw');
    });
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onTrain }));
    view.show();
    await s4FlushMacrotask();
    view.refresh(raTrainVm());
    const root = overlayRootOf(parent);
    const [a] = raMonsterControls(parent);

    a.trains[0]!.focus();
    expect(
      () => a.trains[0]!.click(),
      'a synchronously-throwing onTrain must not throw out of the click',
    ).not.toThrow();
    expect(onTrain).toHaveBeenCalledTimes(1);
    expect(a.trains[0]!.disabled, 'precondition: the lock was taken before the throw').toBe(true);
    vi.mocked(openOverlayA11y).mockClear();
    // happy-dom's blur() is a no-op on a DISABLED element, so model Chromium's focus fixup directly.
    document.body.focus();
    expect(document.activeElement).toBe(document.body);

    await flushPromises();
    await s4FlushMacrotask();

    const anchor = root.querySelector(S4_META.initialFocusSelector);
    expect(anchor).not.toBeNull();
    expect(document.activeElement, 'rb121-RAISING-TRAIN-THROW: must re-anchor focus').toBe(anchor);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('rb121-RAISING-TRAIN-DETACH BITES: a mid-flight refresh() detaches the focused Train node -> the (resolved) settle still re-anchors focus after one macrotask (RED on master)', async () => {
    const d = raDeferred();
    const onTrain = vi.fn().mockReturnValue(d.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onTrain }));
    view.show();
    await s4FlushMacrotask();
    view.refresh(raTrainVm());
    const root = overlayRootOf(parent);
    const [aBefore] = raMonsterControls(parent);

    aBefore.trains[0]!.focus();
    aBefore.trains[0]!.click();
    expect(onTrain).toHaveBeenCalledTimes(1);
    expect(aBefore.trains[0]!.disabled).toBe(true);

    // ctl-7b (intentional change): a CHANGED view-model (a level-up) — a deep-equal one is skipped
    // and would not detach the focused node; the isConnected check is the rebuild precondition.
    view.refresh(withBumpedLevel(raTrainVm())); // mid-flight rebuild detaches the focused node
    expect(aBefore.trains[0]!.isConnected, 'precondition: the clicked node is now detached').toBe(
      false,
    );
    expect(
      document.activeElement,
      'precondition: happy-dom drops activeElement to <body> when the focused node is detached',
    ).toBe(document.body);

    vi.mocked(openOverlayA11y).mockClear();
    d.resolve();
    await flushPromises();
    await s4FlushMacrotask();

    const anchor = root.querySelector(S4_META.initialFocusSelector);
    expect(anchor).not.toBeNull();
    expect(
      document.activeElement,
      'rb121-RAISING-TRAIN-DETACH: the settle must re-anchor focus even after a mid-flight detach',
    ).toBe(anchor);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  // --- KEEP / STALE / HIDDEN (view-wide, exercised via Care) -----------------

  it('rb121-RAISING-KEEP-INROOT BITES: focus already on a live in-root sentinel survives a settle untouched, and openOverlayA11y is never re-invoked -- kills a guard broader than "focus === document.body"', async () => {
    const d = raDeferred();
    const onCare = vi.fn().mockReturnValue(d.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.show();
    await s4FlushMacrotask();
    view.refresh(oneMonsterVm(105n));
    const root = overlayRootOf(parent);
    const careBtn = root.querySelector('button') as HTMLButtonElement;

    careBtn.click();
    expect(onCare).toHaveBeenCalledTimes(1);

    const sentinel = s4InsideSentinel(root);
    sentinel.focus();
    expect(document.activeElement).toBe(sentinel);
    vi.mocked(openOverlayA11y).mockClear();

    d.resolve();
    await flushPromises();
    await s4FlushMacrotask();

    expect(
      document.activeElement,
      'rb121-RAISING-KEEP-INROOT: a settle must NEVER steal focus from a live in-root control',
    ).toBe(sentinel);
    expect(vi.mocked(openOverlayA11y)).not.toHaveBeenCalled();
  });

  it('rb121-RAISING-KEEP-OUTROOT BITES: focus on an element outside the overlay root survives a settle untouched, and openOverlayA11y is never re-invoked -- kills the spec-letter "body or outside root" condition', async () => {
    const d = raDeferred();
    const onCare = vi.fn().mockReturnValue(d.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.show();
    await s4FlushMacrotask();
    view.refresh(oneMonsterVm(106n));
    const careBtn = overlayRootOf(parent).querySelector('button') as HTMLButtonElement;

    careBtn.click();
    expect(onCare).toHaveBeenCalledTimes(1);

    const outside = document.createElement('button');
    outside.id = 'rb121-raising-outside-sentinel';
    document.body.appendChild(outside);
    outside.focus();
    expect(document.activeElement, 'precondition: focus parked outside the overlay root').toBe(
      outside,
    );
    vi.mocked(openOverlayA11y).mockClear();

    d.resolve();
    await flushPromises();
    await s4FlushMacrotask();

    expect(
      document.activeElement,
      'rb121-RAISING-KEEP-OUTROOT: an out-of-root surface (e.g. the F8 error overlay) legitimately ' +
        'owns focus and a settle must never steal it back',
    ).toBe(outside);
    expect(vi.mocked(openOverlayA11y)).not.toHaveBeenCalled();
  });

  it("rb121-RAISING-STALE BITES: a stale generation's settle must not touch focus; the LIVE generation's own settle re-anchors it (RED on master via the positive half)", async () => {
    const p1 = raDeferred();
    const p2 = raDeferred();
    const onCare = vi.fn().mockReturnValueOnce(p1.promise).mockReturnValueOnce(p2.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.show();
    await s4FlushMacrotask();
    view.refresh(oneMonsterVm(107n));
    const root = overlayRootOf(parent);
    let careBtn = root.querySelector('button') as HTMLButtonElement;
    careBtn.focus();
    careBtn.click(); // generation 1
    expect(onCare).toHaveBeenCalledTimes(1);

    view.hide(); // releases generation 1's lock -- P1 is still in flight
    view.show();
    await s4FlushMacrotask(); // flush the reopen's own deferred focus
    view.refresh(oneMonsterVm(107n));
    vi.mocked(openOverlayA11y).mockClear();

    careBtn = root.querySelector('button') as HTMLButtonElement;
    careBtn.focus();
    careBtn.click(); // generation 2 -- a NEW token for the same monster
    expect(onCare).toHaveBeenCalledTimes(2);
    expect(careBtn.disabled).toBe(true);
    // happy-dom's blur() is a no-op on a DISABLED element, so model Chromium's focus fixup directly.
    document.body.focus();
    expect(
      document.activeElement,
      "precondition: generation 2's click stranded focus on <body>",
    ).toBe(document.body);

    p1.resolve(); // the STALE settle
    await flushPromises();
    await s4FlushMacrotask();
    expect(
      document.activeElement,
      "rb121-RAISING-STALE: a stale generation's settle must NOT move focus while generation 2 " +
        'is still in flight',
    ).toBe(document.body);
    expect(vi.mocked(openOverlayA11y)).not.toHaveBeenCalled();

    p2.resolve(); // the LIVE generation's own settle
    await flushPromises();
    await s4FlushMacrotask();
    const anchor = root.querySelector(S4_META.initialFocusSelector);
    expect(anchor, 'anti-vacuity: proves this tooth is not vacuously green').not.toBeNull();
    expect(
      document.activeElement,
      "rb121-RAISING-STALE: the LIVE generation's OWN settle must re-anchor focus (RED on master)",
    ).toBe(anchor);
    expect(vi.mocked(openOverlayA11y)).toHaveBeenCalledTimes(1);
  });

  it('rb121-RAISING-HIDDEN BITES: a lock owned while the view is NOT visible never re-opens the overlay, and the root gains no role="dialog" -- kills a missing #visible guard', async () => {
    const d = raDeferred();
    const onCare = vi.fn().mockReturnValue(d.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    // Deliberately never call view.show() -- #visible stays false; refresh() alone renders
    // buttons regardless of visibility (raisingView.ts's refresh() has no #visible guard).
    view.refresh(oneMonsterVm(108n));
    const root = overlayRootOf(parent);
    expect(view.visible, 'precondition: the view never became visible').toBe(false);
    const careBtn = root.querySelector('button') as HTMLButtonElement;

    careBtn.click();
    expect(onCare).toHaveBeenCalledTimes(1);
    expect(careBtn.disabled).toBe(true);
    vi.mocked(openOverlayA11y).mockClear();

    d.resolve();
    await flushPromises();
    await s4FlushMacrotask();

    expect(
      vi.mocked(openOverlayA11y),
      'rb121-RAISING-HIDDEN: the #visible guard must suppress the re-anchor step entirely -- ' +
        'calling openOverlayA11y here would create an ARIA dialog record on a display:none root',
    ).not.toHaveBeenCalled();
    expect(
      root.getAttribute('role'),
      'rb121-RAISING-HIDDEN: a hidden root must never gain role="dialog"',
    ).toBeNull();
  });
});

// =============================================================================
// ctl-7b (CTL7B.1): the raising screen is a class-styled `.mr-frame` shell inside `#game-screen`
// instead of an inline `position:fixed;inset:0;z-index:100;background:rgba(...)` overlay.
//
// WHAT THESE CASES CAN AND CANNOT PROVE: happy-dom does no cascade, no layout and no paint, so the
// frame cases prove the INLINE half of the contract (which classes the root carries and which
// declarations it and its subtree still write); where the screen lands and how its text paints is
// proved in real Chromium by client/e2e/a11y.spec.ts (CTL7B-E2E-ROOTS / CTL7B-E2E-RAISING).
//
// The inline declarations are read from the style ATTRIBUTE and split by hand: happy-dom's
// CSSStyleDeclaration expands shorthands into longhands, so a name-set read through it would pin
// the happy-dom version, not the contract.
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

/** The element's OWN text nodes, concatenated. */
function ctl7bOwnText(el: Element): string {
  return [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent ?? '')
    .join('');
}

/** The one element under `root` whose own text is exactly `text`. */
function ctl7bByOwnText(root: HTMLElement, text: string): HTMLElement {
  const hits = [...root.querySelectorAll('*')].filter((el) => ctl7bOwnText(el) === text);
  expect(
    hits,
    `precondition: exactly one element under the root has the own text "${text}"`,
  ).toHaveLength(1);
  return hits[0] as HTMLElement;
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

describe('RaisingView ctl-7b: the raising root is a class-styled frame, inline only for visibility', () => {
  it('CTL7B-1-RAISING-FRAME BITES: the raising root is the one child of its parent, carries exactly .mr-frame and .mr-shell, writes only display and align-items inline in every state, and toggles display flex/none', async () => {
    // WRONG IMPLS KILLED:
    //  (1) the shipped root: `position:fixed;inset:0;z-index:100;background:rgba(...)` ... in its
    //      cssText (every state reds on the allow-list);
    //  (2) a root with the classes AND the old inline overlay still on it (the inline declaration
    //      beats the class rule at every specificity, so the shell would never apply);
    //  (3) `.mr-shell--top` borrowed for the raising screen (z 120 would sit above the battle);
    //  (4) the frame class on a WRAPPER around the root (identity is pinned through the title);
    //  (5) a fixed-position / dim / hide declaration smuggled onto a DESCENDANT after the root is
    //      clean (the subtree walk is run in every state, empty ones included);
    //  (6) a show() that no longer writes display:flex, or a hide() that no longer writes none.
    const { parent, view } = s4Mount();
    expect(parent.children, 'the view appends exactly ONE root into its parent').toHaveLength(1);
    const root = overlayRootOf(parent);
    const title = parent.querySelector('[data-testid="raising-title"]');
    expect(title, 'precondition: the title anchor exists').not.toBeNull();
    expect(title?.parentElement, "the classed node is the title's parent").toBe(root);
    expect(
      root.className
        .split(/\s+/)
        .filter((c) => c !== '')
        .sort(),
      'the root carries exactly the frame and the shell class — and not .mr-shell--top, which ' +
        'is the menu / help layer',
    ).toEqual(['mr-frame', 'mr-shell']);

    const allowed = ['display', 'align-items'];
    const sample = (when: string): number => {
      expect(
        [...ctl7bInline(root).keys()].filter((name) => !allowed.includes(name)),
        `CTL7B ${when}: the root may write only ${JSON.stringify(allowed)} inline. The shell ` +
          'class places it inside the screen and the frame class paints it, so any other inline ' +
          'property is the old overlay still being drawn by hand',
      ).toEqual([]);
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
        `CTL7B ${when}: no element under the root may place, layer, dim, hide or recolour itself inline`,
      ).toEqual([]);
      return all.length;
    };

    sample('constructed');
    expect(root.style.display, 'hidden at construction').toBe('none');

    view.show();
    sample('shown');
    expect(root.style.display, 'show() writes display:flex').toBe('flex');
    expect(ctl7bInline(root).get('display')).toBe('flex');

    view.refresh(raTrainVm());
    expect(
      sample('populated refresh'),
      'non-vacuity: two monsters, three items and their buttons render well over 25 elements',
    ).toBeGreaterThan(25);
    expect(root.style.display, 'a refresh does not touch visibility').toBe('flex');
    // A deferred write (a setTimeout that re-adds an inline position after show()) lands here.
    await s4FlushMacrotask();
    sample('populated refresh, one macrotask later');
    expect(root.style.display).toBe('flex');

    view.refresh({ monsters: [], items: [] });
    sample('empty refresh');

    view.hide();
    sample('hidden');
    expect(root.style.display, 'hide() writes display:none').toBe('none');
    expect(ctl7bInline(root).get('display')).toBe('none');
  });

  it('CTL7B-1-NO-OPACITY-DIM-RAISING BITES: the empty monster and inventory lines carry no inline opacity or filter and paint an opaque colour at 4.5:1 on both the frame and the card surface', () => {
    // WRONG IMPLS KILLED: the shipped empties (`empty.style.opacity = '0.4'`): opacity composites
    // the text below 4.5:1 and is invisible to any check that reads only a colour; the same
    // dimming spelled as `filter`; a replacement colour that is translucent (alpha < 1) or too
    // dim (#666 on #1a1a2e is 2.9:1); an unreadable colour literal (named, hsl, 8-digit hex).
    const { parent, view } = s4Mount();
    view.refresh({ monsters: [], items: [] });
    view.show();
    const root = overlayRootOf(parent);

    const dimmers: string[] = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const prop of ['opacity', 'filter']) {
        if (ctl7bInline(el).has(prop)) dimmers.push(`<${el.tagName.toLowerCase()}> ${prop}`);
      }
    }
    expect(dimmers, 'no element in the empty raising screen may dim itself inline').toEqual([]);

    const empties = [ctl7bByOwnText(root, 'No monsters.'), ctl7bByOwnText(root, 'No items.')];
    ctl7bExpectReadableEmpties(empties, root);
  });
});

// -----------------------------------------------------------------------------
// R-ci-fix-20261002T0901Z-RAISINGVIEWREBUILD: RaisingView.refresh rebuilt every Care / Train button
// on every store batch, so a click landing between a batch's replaceChildren() and Playwright's
// next action hit a detached node (e2e/evolution.spec.ts:195, "element was detached"). The fix is a
// value-keyed render per container, like pvpView.ts #renderIfChanged: a refresh with a view-model
// that serialises to the same key leaves the container's DOM untouched.
//
// The key is the JSON of [currentLocale(), monsters, items] for the monster list and
// [currentLocale(), items] for the inventory, with bigint written as its decimal string (never
// Number: 2^53 and 2^53 + 1 are the SAME Number). It is deleted before a render and set after it
// (a render that throws leaves no key); hide() forgets both keys (the reopen's refresh rebuilds);
// a fresh view has no key (an empty first view-model still renders its empty text).
// -----------------------------------------------------------------------------

type Ctl7bMonster = RaisingViewModel['monsters'][number];
type Ctl7bItem = RaisingViewModel['items'][number];

function ctl7bMon(
  vm: RaisingViewModel,
  index: number,
  patch: Partial<Ctl7bMonster>,
): RaisingViewModel {
  return { ...vm, monsters: vm.monsters.map((m, i) => (i === index ? { ...m, ...patch } : m)) };
}

function ctl7bItem(
  vm: RaisingViewModel,
  index: number,
  patch: Partial<Ctl7bItem>,
): RaisingViewModel {
  return { ...vm, items: vm.items.map((it, i) => (i === index ? { ...it, ...patch } : it)) };
}

interface Ctl7bCard {
  readonly care: HTMLButtonElement;
  readonly trains: HTMLButtonElement[];
}

/** The Care button and Train buttons of every monster card, in render order (no count preconditions). */
function ctl7bCards(root: HTMLElement): Ctl7bCard[] {
  const cards: Ctl7bCard[] = [];
  for (const btn of root.querySelectorAll('button')) {
    if (btn.textContent === i18nT('raising.card.care')) {
      cards.push({ care: btn, trains: [] });
    } else {
      const last = cards[cards.length - 1];
      expect(last, 'a Train button follows its card’s Care button').toBeDefined();
      last?.trains.push(btn);
    }
  }
  return cards;
}

/** The slice of a vi.fn() the oracle reads. */
interface Ctl7bSpy {
  readonly mock: { readonly calls: unknown[][] };
  mockClear(): unknown;
}

function ctl7bSetup() {
  const parent = mountParent();
  const onCare = vi.fn();
  const onTrain = vi.fn();
  const view = new RaisingView(parent, makeCallbacks({ onCare, onTrain }));
  return { parent, view, onCare, onTrain, root: overlayRootOf(parent) };
}

/** The inventory half of the oracle: every item's line and description is in the DOM. */
function ctl7bExpectInventory(root: HTMLElement, vm: RaisingViewModel, why: string): void {
  const text = root.textContent ?? '';
  for (const item of vm.items) {
    expect(
      text,
      `${why}: the inventory must show "${item.name}" with its count ${item.count}`,
    ).toContain(i18nTf('raising.inventory.item', { name: item.name, count: item.count }));
    expect(text, `${why}: the inventory must show the description of "${item.name}"`).toContain(
      item.description,
    );
  }
}

/**
 * The DOM oracle: after the view renders `vm`, the screen SHOWS `vm` — every nickname, status and
 * stats line, one Train button per trainable item per card with its resolved label, the inventory
 * — and the buttons FORWARD `vm`'s ids (a Care click per card, and the first / last Train button
 * of alternate cards, so both the first and the last trainable item's id are read). A stale render
 * fails here whichever field it forgot.
 */
function ctl7bExpectRendered(
  root: HTMLElement,
  vm: RaisingViewModel,
  fns: { onCare: Ctl7bSpy; onTrain: Ctl7bSpy },
  why: string,
): void {
  const text = root.textContent ?? '';
  const trainable = vm.items.filter((i) => i.count > 0 && i.canTrain);
  for (const m of vm.monsters) {
    expect(text, `${why}: the card for "${m.nickname}"`).toContain(m.nickname);
    expect(text, `${why}: the status line of "${m.nickname}"`).toContain(
      i18nTf('raising.card.status', {
        level: m.level,
        trust: m.trustTier,
        current: m.currentHp,
        max: m.statHp,
      }),
    );
    expect(text, `${why}: the stats line of "${m.nickname}"`).toContain(
      i18nTf('raising.card.stats', {
        attack: m.statAttack,
        defense: m.statDefense,
        speed: m.statSpeed,
        spAttack: m.statSpAttack,
        spDefense: m.statSpDefense,
      }),
    );
  }
  ctl7bExpectInventory(root, vm, why);

  const cards = ctl7bCards(root);
  expect(cards, `${why}: one card per monster`).toHaveLength(vm.monsters.length);
  expect(
    cards.map((c) => c.trains.map((b) => b.textContent)),
    `${why}: every card carries one Train button per trainable item, in item order`,
  ).toEqual(
    vm.monsters.map(() =>
      trainable.map((i) => i18nTf('raising.card.train', { name: i.name, count: i.count })),
    ),
  );

  fns.onCare.mockClear();
  fns.onTrain.mockClear();
  for (const c of cards) c.care.click();
  expect(fns.onCare.mock.calls, `${why}: each Care button forwards its own monster id`).toEqual(
    vm.monsters.map((m) => [m.monsterId]),
  );
  const expectedTrain: unknown[][] = [];
  cards.forEach((c, i) => {
    if (c.trains.length === 0) return;
    const pick = i % 2 === 0 ? 0 : c.trains.length - 1;
    (c.trains[pick] as HTMLButtonElement).click();
    expectedTrain.push([vm.monsters[i]?.monsterId, trainable[pick]?.itemId]);
  });
  expect(
    fns.onTrain.mock.calls,
    `${why}: each Train button forwards its own monster id and its own item id`,
  ).toEqual(expectedTrain);
}

const CTL7B_FIELD_CASES: ReadonlyArray<
  readonly [string, (vm: RaisingViewModel) => RaisingViewModel]
> = [
  ['monster nickname', (vm) => ctl7bMon(vm, 0, { nickname: 'Ariel' })],
  ['monster level', (vm) => ctl7bMon(vm, 0, { level: 6 })],
  ['monster trustTier', (vm) => ctl7bMon(vm, 0, { trustTier: 'Friendly' })],
  ['monster currentHp', (vm) => ctl7bMon(vm, 0, { currentHp: 19 })],
  ['monster statHp', (vm) => ctl7bMon(vm, 0, { statHp: 21 })],
  ['monster statAttack', (vm) => ctl7bMon(vm, 0, { statAttack: 6 })],
  ['monster statDefense', (vm) => ctl7bMon(vm, 0, { statDefense: 6 })],
  ['monster statSpeed', (vm) => ctl7bMon(vm, 0, { statSpeed: 6 })],
  ['monster statSpAttack', (vm) => ctl7bMon(vm, 0, { statSpAttack: 6 })],
  ['monster statSpDefense', (vm) => ctl7bMon(vm, 0, { statSpDefense: 6 })],
  ['monster monsterId', (vm) => ctl7bMon(vm, 0, { monsterId: 3n })],
  ['second monster level', (vm) => ctl7bMon(vm, 1, { level: 6 })],
  ['monster order', (vm) => ({ ...vm, monsters: [...vm.monsters].reverse() })],
  ['trainable item count', (vm) => ctl7bItem(vm, 0, { count: 3 })],
  ['trainable item name', (vm) => ctl7bItem(vm, 0, { name: 'Powder' })],
  ['trainable item itemId', (vm) => ctl7bItem(vm, 0, { itemId: 13 })],
  ['second trainable item itemId', (vm) => ctl7bItem(vm, 1, { itemId: 14 })],
  ['trainable item canTrain off', (vm) => ctl7bItem(vm, 1, { canTrain: false })],
  ['trainable item count to zero', (vm) => ctl7bItem(vm, 1, { count: 0 })],
  ['item order', (vm) => ({ ...vm, items: [...vm.items].reverse() })],
];

describe('RaisingView ctl-7b: a refresh re-renders only when the view-model changed', () => {
  it('CTL7B-RV-NO-REBUILD BITES: refresh() with a fresh, deep-equal view-model keeps every Care and Train node, writes nothing to the DOM, and leaves focus on a focused Care button', async () => {
    // WRONG IMPLS KILLED: the shipped refresh(), which replaceChildren()s the monster list and
    // the inventory on EVERY store batch (every node below changes identity, the observer sees
    // the removals and focus falls to <body>) — the e2e flake R-ci-fix-20261002T0901Z-
    // RAISINGVIEWREBUILD; a skip keyed on view-model IDENTITY (the view-model below is a fresh
    // object, deep-equal to the last); a skip that still rewrites some text or a class.
    const { view, onCare, root } = ctl7bSetup();
    view.show();
    view.refresh(raTrainVm());
    await s4FlushMacrotask(); // let the open's deferred focus land before focusing a Care button
    const before = [...root.querySelectorAll('button')];
    expect(before, 'precondition: two cards with Care + two Train buttons each').toHaveLength(6);
    const care = before[0] as HTMLButtonElement;
    care.focus();
    expect(document.activeElement, 'precondition: Care holds focus').toBe(care);

    const observer = new MutationObserver(() => {});
    observer.observe(root, { childList: true, subtree: true });
    const equal = raTrainVm();
    view.refresh(equal);
    const equalAgain = raTrainVm();
    view.refresh(equalAgain);
    const written = observer.takeRecords();
    observer.disconnect();

    expect(
      written.map(
        (r) =>
          `${r.type} on <${(r.target as Element).tagName.toLowerCase()}> +${r.addedNodes.length} -${r.removedNodes.length}`,
      ),
      'a refresh with a deep-equal view-model must not add or remove a single node',
    ).toEqual([]);
    const after = [...root.querySelectorAll('button')];
    expect(after, 'the same six buttons').toHaveLength(6);
    after.forEach((btn, i) => {
      expect(btn, `button ${i} is the SAME node as before the refresh`).toBe(before[i]);
    });
    expect(document.activeElement, 'focus stays on the Care button').toBe(care);
    care.click();
    expect(onCare, 'the surviving Care node is still wired to its monster').toHaveBeenCalledWith(
      1n,
    );

    // CONTROL: the observer does see a real change, so the zero above is not an inert observer.
    const control = new MutationObserver(() => {});
    control.observe(root, { childList: true, subtree: true });
    view.refresh(ctl7bMon(raTrainVm(), 0, { level: 6 }));
    const real = control.takeRecords();
    control.disconnect();
    expect(
      real.length,
      'control: a CHANGED view-model re-renders, and the observer records it',
    ).toBeGreaterThan(0);
  });

  it.each(
    CTL7B_FIELD_CASES,
  )('CTL7B-RV-KEY-FIELD %s: a one-field change re-renders, and the cards show and forward the new value', (label, change) => {
    // WRONG IMPLS KILLED: a key that leaves one field out (a stale card / button text / forwarded
    // id after exactly that change), a key that reads only the monster ids or only their count, a
    // key over the Care / Train LABELS but not the data behind them, an items key that ignores
    // order or itemId. Every case checks the DOM against the new view-model, not just identity.
    const { view, root, onCare, onTrain } = ctl7bSetup();
    view.refresh(raTrainVm());
    const before = ctl7bCards(root);
    expect(before, 'precondition: two cards rendered').toHaveLength(2);

    const changed = change(raTrainVm());
    view.refresh(changed);
    const after = ctl7bCards(root);
    expect(
      after[0]?.care,
      `${label}: the monster list was re-rendered, so Care is a new node`,
    ).not.toBe(before[0]?.care);
    expect(before[0]?.care.isConnected, `${label}: the old Care node is gone`).toBe(false);
    ctl7bExpectRendered(root, changed, { onCare, onTrain }, label);
  });

  it('CTL7B-RV-KEY-INVENTORY BITES: a change that only the inventory shows (a description, a non-trainable item) still reaches the screen', () => {
    // WRONG IMPLS KILLED: an inventory key that ignores the description or the non-trainable
    // items (the monster list never reads them, so a key narrowed to what the cards read would
    // freeze the inventory). NOT pinned either way: whether the monster list is also re-rendered
    // by such a change — that is a choice of key, not part of the contract.
    const { view, root } = ctl7bSetup();
    view.refresh(raTrainVm());

    const described = ctl7bItem(raTrainVm(), 0, { description: 'Raises attack a great deal.' });
    view.refresh(described);
    ctl7bExpectInventory(root, described, 'description-only change');
    expect(root.textContent ?? '', 'the old description is gone').not.toContain('Raises attack.');

    const pebble = ctl7bItem(described, 2, { count: 9, name: 'Boulder' });
    view.refresh(pebble);
    ctl7bExpectInventory(root, pebble, 'non-trainable item change');
    expect(root.textContent ?? '', 'the old item line is gone').not.toContain('Pebble');
  });

  it('CTL7B-RV-KEY-LOCALE BITES: switching locale re-renders an equal view-model — empty and populated — so no list keeps the old language', () => {
    // WRONG IMPLS KILLED: a key without the locale (the Care / Train / empty / status strings are
    // resolved at render time, so an equal view-model under a new locale would keep the old
    // language until the data changed).
    const original = currentLocale();
    try {
      const { view, root } = ctl7bSetup();
      view.refresh({ monsters: [], items: [] });
      const monsterEmptyBefore = ctl7bByOwnText(root, i18nT('raising.monsters.empty'));
      const inventoryEmptyBefore = ctl7bByOwnText(root, i18nT('raising.inventory.empty'));
      setLocale('fr');
      view.refresh({ monsters: [], items: [] });
      const monsterEmptyAfter = ctl7bByOwnText(root, i18nT('raising.monsters.empty'));
      const inventoryEmptyAfter = ctl7bByOwnText(root, i18nT('raising.inventory.empty'));
      expect(monsterEmptyAfter, 'the empty monster line was re-rendered').not.toBe(
        monsterEmptyBefore,
      );
      expect(monsterEmptyBefore.isConnected).toBe(false);
      expect(inventoryEmptyAfter, 'the empty inventory line was re-rendered').not.toBe(
        inventoryEmptyBefore,
      );
      expect(inventoryEmptyBefore.isConnected).toBe(false);

      setLocale('en');
      view.refresh(raTrainVm());
      const before = ctl7bCards(root);
      // `raising.inventory.item` reads the same in en and fr, so the inventory half of this case
      // is only observable through NODE IDENTITY: capture an item line before the switch.
      const itemLine = i18nTf('raising.inventory.item', { name: 'Protein', count: 2 });
      const itemBefore = ctl7bByOwnText(root, itemLine);
      setLocale('fr');
      view.refresh(raTrainVm()); // deep-equal, but a different locale
      const after = ctl7bCards(root);
      const itemAfter = ctl7bByOwnText(root, itemLine);
      expect(itemAfter, 'the inventory was re-rendered under the new locale').not.toBe(itemBefore);
      expect(itemBefore.isConnected, 'the old inventory line is gone').toBe(false);
      expect(after[0]?.care, 'Care was re-rendered under the new locale').not.toBe(before[0]?.care);
      expect(after[0]?.care.textContent, 'Care reads the new locale').toBe(
        i18nT('raising.card.care'),
      );
      expect(after[0]?.trains[0]?.textContent, 'Train reads the new locale').toBe(
        i18nTf('raising.card.train', { name: 'Protein', count: 2 }),
      );
      expect(root.textContent ?? '', 'the inventory reads the new locale').toContain(
        i18nTf('raising.inventory.item', { name: 'Protein', count: 2 }),
      );
    } finally {
      setLocale(original);
    }
  });

  it('CTL7B-RV-KEY-MUTATION BITES: mutating the previously rendered view-model in place and refreshing the same object re-renders', () => {
    // WRONG IMPLS KILLED: a skip keyed on object identity or on a shallow compare against the
    // PREVIOUS REFERENCE (the previous view-model is the object being mutated, so it always
    // "equals" itself). The key must be a serialisation taken at render time.
    const { view, root, onCare, onTrain } = ctl7bSetup();
    const vm = raTrainVm();
    view.refresh(vm);
    const before = ctl7bCards(root);

    (vm.monsters[0] as unknown as { level: number }).level = 9;
    (vm.items[0] as unknown as { count: number }).count = 7;
    view.refresh(vm); // the SAME object, mutated in place

    const after = ctl7bCards(root);
    expect(after[0]?.care, 'the monster list re-rendered').not.toBe(before[0]?.care);
    ctl7bExpectRendered(root, vm, { onCare, onTrain }, 'in-place mutation');
  });

  it('CTL7B-RV-KEY-BIGINT BITES: monster ids that differ only past 2^53 are different keys — a swap re-renders and Care forwards the new id', () => {
    // WRONG IMPLS KILLED: a bigint replacer that goes through Number (2n**53n and 2n**53n + 1n are
    // the SAME Number, so the key would not change and Care would forward the OLD id: a care call
    // on the wrong monster); a JSON.stringify with no replacer (throws on a bigint at all).
    const low = 2n ** 53n;
    const high = 2n ** 53n + 1n;
    expect(Number(low), 'precondition: the two ids collapse to one Number').toBe(Number(high));
    const twin = (id: bigint): Ctl7bMonster => ({
      ...(oneMonsterVm(id).monsters[0] as Ctl7bMonster),
      nickname: 'Twin', // identical in every field but the id
    });

    const swapped = ctl7bSetup();
    swapped.view.refresh({ monsters: [twin(low), twin(high)], items: [] });
    swapped.view.refresh({ monsters: [twin(high), twin(low)], items: [] });
    const cards = ctl7bCards(swapped.root);
    expect(cards, 'two cards').toHaveLength(2);
    cards[0]?.care.click();
    cards[1]?.care.click();
    expect(
      swapped.onCare.mock.calls,
      'after the swap the first card forwards the HIGH id and the second the LOW id',
    ).toEqual([[high], [low]]);

    const single = ctl7bSetup();
    single.view.refresh({ monsters: [twin(low)], items: [] });
    single.view.refresh({ monsters: [twin(high)], items: [] });
    ctl7bCards(single.root)[0]?.care.click();
    expect(single.onCare, 'a one-id change past 2^53 forwards the new id').toHaveBeenCalledWith(
      high,
    );
  });

  it('CTL7B-RV-KEY-EMPTY-FIRST BITES: the first refresh of a fresh view renders the empty text even for an empty view-model, and a repeat empty refresh leaves it alone', () => {
    // WRONG IMPLS KILLED: a key that starts as the key of the EMPTY view-model (or any non-null
    // initial value that an empty view-model equals), which would skip the first render and leave
    // both containers blank; a skip that does not apply to empty view-models (the control).
    const { view, root } = ctl7bSetup();
    view.refresh({ monsters: [], items: [] });
    const monsterEmpty = ctl7bByOwnText(root, i18nT('raising.monsters.empty'));
    const inventoryEmpty = ctl7bByOwnText(root, i18nT('raising.inventory.empty'));
    expect(monsterEmpty.isConnected).toBe(true);

    view.refresh({ monsters: [], items: [] });
    expect(
      ctl7bByOwnText(root, i18nT('raising.monsters.empty')),
      'an equal empty refresh keeps the empty monster line',
    ).toBe(monsterEmpty);
    expect(
      ctl7bByOwnText(root, i18nT('raising.inventory.empty')),
      'an equal empty refresh keeps the empty inventory line',
    ).toBe(inventoryEmpty);
  });

  it('CTL7B-RV-KEY-THROW BITES: a render that throws leaves no key, so the next refresh of the same view-model renders — on a first render and after a changed one', () => {
    // WRONG IMPLS KILLED: a key written BEFORE the render runs (a throw midway leaves the key set
    // and the half-rendered list is then skipped for as long as the view-model stays the same);
    // a key never deleted before the render (the second phase: A's stale key survives B's throw).
    // The throw is injected through the resolver the render calls first (the status line).
    try {
      const { view, root, onCare, onTrain } = ctl7bSetup();
      vi.mocked(i18nTf).mockImplementationOnce(() => {
        throw new Error('ctl7b: injected render failure');
      });
      expect(() => view.refresh(raTrainVm())).toThrow('ctl7b: injected render failure');

      const again = raTrainVm(); // deep-equal to the view-model whose render threw
      view.refresh(again);
      ctl7bExpectRendered(root, again, { onCare, onTrain }, 'refresh after a throwing render');

      // CHANGED-render phase, on a fresh view (the oracle's clicks above took Care / Train locks):
      // A renders; a CHANGED view-model B throws midway (after replaceChildren() cleared the
      // list); refreshing A again must fully re-render A. A render that never deletes the stale
      // key BEFORE rendering leaves A's key in place, so the refresh of A is skipped and the
      // list stays empty.
      const second = ctl7bSetup();
      second.view.refresh(raTrainVm());
      expect(ctl7bCards(second.root), 'precondition: A rendered').toHaveLength(2);
      vi.mocked(i18nTf).mockImplementationOnce(() => {
        throw new Error('ctl7b: injected render failure');
      });
      expect(() => second.view.refresh(ctl7bMon(raTrainVm(), 0, { level: 6 }))).toThrow(
        'ctl7b: injected render failure',
      );
      const backToA = raTrainVm();
      second.view.refresh(backToA);
      ctl7bExpectRendered(
        second.root,
        backToA,
        { onCare: second.onCare, onTrain: second.onTrain },
        'refresh of A after a changed render threw',
      );
    } finally {
      vi.mocked(i18nTf).mockRestore();
    }
  });
});

describe('RaisingView ctl-7b: the in-flight locks survive a skipped refresh and a hide / show', () => {
  it('CTL7B-RV-LOCK-HIDE-CARE BITES: a Care call pending at hide() does not leave the reopened view with a dead Care button', () => {
    // WRONG IMPLS KILLED: a hide() that forgets the lock but not the render key. The reopen's
    // refresh then SKIPS (deep-equal view-model), so the OLD Care node — disabled by the click
    // that hide() has since released — stays on screen: a button that looks dead and, once
    // hide() cleared the lock, is not even guarding anything.
    const flight = raDeferred(); // never settles (a link drop)
    const onCare = vi.fn().mockReturnValue(flight.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.show();
    view.refresh(raTrainVm());
    const [a0] = raMonsterControls(parent);
    a0.care.click();
    expect(a0.care.disabled, 'precondition: the click took the lock').toBe(true);

    view.hide();
    view.show();
    view.refresh(raTrainVm()); // deep-equal to the pre-hide view-model
    const [a1] = raMonsterControls(parent);
    expect(a1.care, 'hide() forgets what was rendered, so the reopen rebuilds').not.toBe(a0.care);
    expect(a1.care.disabled, 'the reopened Care button is enabled').toBe(false);
    a1.care.click();
    expect(onCare, 'and it dispatches').toHaveBeenCalledTimes(2);
  });

  it('CTL7B-RV-LOCK-HIDE-TRAIN BITES: a Train call pending at hide() does not leave the reopened view with dead Train buttons', () => {
    // WRONG IMPLS KILLED: as the Care case, for the Train buttons (a separate map, a separate
    // `clear()` in hide(), and a separate list of nodes the settle would re-enable).
    const flight = raDeferred(); // never settles
    const onTrain = vi.fn().mockReturnValue(flight.promise);
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onTrain }));
    view.show();
    view.refresh(raTrainVm());
    const [a0] = raMonsterControls(parent);
    a0.trains[0]?.click();
    expect(raDisabled(a0.trains), 'precondition: both Train buttons locked').toEqual([true, true]);

    view.hide();
    view.show();
    view.refresh(raTrainVm());
    const [a1] = raMonsterControls(parent);
    expect(a1.trains[0], 'the reopen rebuilds the Train buttons').not.toBe(a0.trains[0]);
    expect(raDisabled(a1.trains), 'the reopened Train buttons are enabled').toEqual([false, false]);
    a1.trains[0]?.click();
    expect(onTrain, 'and dispatch').toHaveBeenCalledTimes(2);
  });

  it('CTL7B-RV-LOCK-LIVE-CARE BITES: click Care, a changed refresh, then an EQUAL refresh, then the settle — the LIVE Care node is re-enabled', async () => {
    // WRONG IMPLS KILLED: a skipped refresh that still clears the live-node registry
    // (`#careButtons.clear()` before the key check): the settle then re-enables the CLOSURE's
    // detached node and the live one stays disabled forever; an equal refresh that rebuilds (the
    // shipped behaviour: the `toBe(a1.care)` below reds).
    const d = raDeferred();
    const onCare = vi.fn((monsterId: bigint) => (monsterId === 1n ? d.promise : undefined));
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onCare }));
    view.refresh(raTrainVm());
    const [a0] = raMonsterControls(parent);
    a0.care.click();
    expect(a0.care.disabled, 'precondition: Care locked').toBe(true);

    view.refresh(withBumpedLevel(raTrainVm())); // a changed batch: rebuilds
    const [a1] = raMonsterControls(parent);
    expect(a1.care, 'precondition: the changed refresh rebuilt Care').not.toBe(a0.care);
    expect(a1.care.disabled, 'the rebuilt Care comes back disabled (lock re-derived)').toBe(true);

    view.refresh(withBumpedLevel(raTrainVm())); // deep-equal to the last one: skipped
    const [a2] = raMonsterControls(parent);
    expect(a2.care, 'the equal refresh skipped, so Care is the same node').toBe(a1.care);
    expect(a2.care.disabled, 'and it is still locked').toBe(true);

    d.resolve();
    await flushPromises();
    expect(a2.care.disabled, 'the settle re-enables the LIVE Care node').toBe(false);
    a2.care.click();
    expect(onCare, 'and it dispatches again').toHaveBeenCalledTimes(2);
    await flushPromises();
  });

  it('CTL7B-RV-LOCK-LIVE-TRAIN BITES: click Train, a changed refresh, then an EQUAL refresh, then the settle — the LIVE Train nodes are re-enabled', async () => {
    // WRONG IMPLS KILLED: as the Care case, for `#trainButtons` (a skipped refresh that clears the
    // registry leaves the settle re-enabling the closure's detached list).
    const d = raDeferred();
    const onTrain = vi.fn((monsterId: bigint) => (monsterId === 1n ? d.promise : undefined));
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks({ onTrain }));
    view.refresh(raTrainVm());
    const [a0] = raMonsterControls(parent);
    a0.trains[0]?.click();
    expect(raDisabled(a0.trains), 'precondition: Train locked').toEqual([true, true]);

    view.refresh(withBumpedLevel(raTrainVm()));
    const [a1] = raMonsterControls(parent);
    expect(a1.trains[0], 'precondition: the changed refresh rebuilt Train').not.toBe(a0.trains[0]);
    expect(raDisabled(a1.trains), 'the rebuilt Train buttons come back disabled').toEqual([
      true,
      true,
    ]);

    view.refresh(withBumpedLevel(raTrainVm())); // deep-equal to the last one: skipped
    const [a2] = raMonsterControls(parent);
    expect(a2.trains[0], 'the equal refresh skipped, so Train is the same node').toBe(a1.trains[0]);
    expect(raDisabled(a2.trains), 'and it is still locked').toEqual([true, true]);

    d.resolve();
    await flushPromises();
    expect(raDisabled(a2.trains), 'the settle re-enables the LIVE Train nodes').toEqual([
      false,
      false,
    ]);
    a2.trains[1]?.click();
    expect(onTrain, 'and they dispatch again').toHaveBeenCalledTimes(2);
    await flushPromises();
  });
});

// =============================================================================
// ctl-8f (CTL8F.1, CTL8F.2): the Bag panel inside the raising root.
//
// `RaisingView.paint(p)` takes `{ vm, nav, phase, status }` (the adapter's paint) and renders, inside
// the raising root, the pocket tab strip (#bag-tabs), the active pocket's items (#bag-list), the item
// sheet (#bag-sheet), the description (#bag-info), the monster picker (#bag-picker with
// #bag-picker-title) and the status line (#bag-status). The legacy monster section, Care and Train
// buttons, #raising-feedback and refresh() are untouched; the legacy inventory grid (id
// `raising-inventory`) is hidden while a paint is kept and comes back at the next show().
//
// "Shown" / "hidden" is the part's own inline `style.display` (hidden = 'none'). The paints here are
// hand-built (no adapter), and the nav states come from the real nav kit over a layout written out
// in this file, so these cases pin the view against the CONTRACT's shapes alone; the WIRED case at
// the end drives the real adapter into the real view.
//
// The new modules are imported dynamically inside the WIRED case only, so a missing module reds
// that case alone and never the pre-existing cases of this file.
// =============================================================================

import type { VButton } from '../input/buttons';
import type { BagItemVm, BagVm } from './bagModel';
import { list as ctl8fList, tabs as ctl8fTabs, type NavState, navInit, navStep } from './nav';

type Ctl8fPaint = Parameters<RaisingView['paint']>[0];

function ctl8fItem(
  itemId: number,
  name: string,
  description: string,
  count: number,
  over: Partial<BagItemVm> = {},
): BagItemVm {
  return {
    key: String(itemId),
    itemId,
    name,
    description,
    count,
    canFeed: false,
    battleUse: false,
    ...over,
  };
}

/** bait [3]; food [9, 5] (inventory order); medicine [12] (or [] with `bareMedicine`); other [20]. */
function ctl8fVm(opts: { bareMedicine?: boolean; monsters?: boolean } = {}): BagVm {
  return {
    pockets: [
      {
        pocket: 'bait',
        items: [ctl8fItem(3, 'Lure Berry', 'Lures a wild monster.', 4, { battleUse: true })],
      },
      {
        pocket: 'food',
        items: [
          ctl8fItem(9, 'Glow Berry', 'Raises speed.', 2, { canFeed: true }),
          ctl8fItem(5, 'Power Root', 'Raises attack.', 3, { canFeed: true }),
        ],
      },
      {
        pocket: 'medicine',
        items:
          opts.bareMedicine === true
            ? []
            : [ctl8fItem(12, 'Antidote', 'Cures poison.', 1, { battleUse: true })],
      },
      { pocket: 'other', items: [ctl8fItem(20, 'Moon Shard', '', 6)] },
    ],
    monsters:
      opts.monsters === false
        ? []
        : [
            { key: '11', monsterId: 11n, name: 'Kip' },
            { key: '12', monsterId: 12n, name: 'Emberfang' },
            { key: '21', monsterId: 21n, name: 'Sproutle' },
          ],
  };
}

function ctl8fLayout(vm: BagVm) {
  return ctl8fTabs(
    vm.pockets.map((p) => ({
      key: p.pocket,
      layout: ctl8fList(p.items.map((i) => ({ key: i.key, enabled: true }))),
    })),
  );
}

/** The nav state after `steps` fresh presses from the opening. */
function ctl8fNav(vm: BagVm, steps: readonly VButton[] = []): NavState {
  const layout = ctl8fLayout(vm);
  let state = navInit(layout);
  for (const button of steps) state = navStep(layout, state, { button, repeat: false }).state;
  return state;
}

function ctl8fPaint(vm: BagVm, over: Partial<Ctl8fPaint> = {}): Ctl8fPaint {
  return { vm, nav: ctl8fNav(vm), phase: { kind: 'list' }, status: null, ...over };
}

const CTL8F_PARTS = ['bag-tabs', 'bag-list', 'bag-sheet', 'bag-info', 'bag-picker'] as const;

function ctl8fPart(id: string): HTMLElement {
  const el = document.getElementById(id);
  expect(el, `#${id} must exist in the raising root`).not.toBeNull();
  return el as HTMLElement;
}
/** Shown = the part's own inline display is not 'none'. */
const ctl8fShown = (id: string): boolean => ctl8fPart(id).style.display !== 'none';
const ctl8fRows = (id: string): HTMLElement[] => [
  ...ctl8fPart(id).querySelectorAll<HTMLElement>('.mr-nav-item'),
];
const ctl8fKeys = (id: string): Array<string | undefined> =>
  ctl8fRows(id).map((r) => r.dataset.navKey);
const ctl8fTabEls = (): HTMLElement[] => [
  ...ctl8fPart('bag-tabs').querySelectorAll<HTMLElement>('.mr-nav-tab'),
];
/** The cursor rows of a nav container: those marked is-active (and aria-selected). */
const ctl8fActive = (id: string): Array<string | undefined> =>
  ctl8fRows(id)
    .filter((r) => r.classList.contains('is-active'))
    .map((r) => r.dataset.navKey);
/** Own-text lines `text` under the root outside the legacy inventory grid. */
function ctl8fLinesOutsideGrid(root: HTMLElement, text: string): HTMLElement[] {
  const grid = document.getElementById('raising-inventory');
  return [...root.querySelectorAll<HTMLElement>('*')].filter(
    (el) => ctl7bOwnText(el) === text && (grid === null || !grid.contains(el)),
  );
}

describe('RaisingView ctl-8f: the Bag panel (CTL8F.1, CTL8F.2)', () => {
  it('CTL8F-1-VIEW-PAINT: before any paint the five bag parts exist and are hidden and the legacy grid shows; a paint shows the pocket tabs (the active one selected), the active pocket`s items as "name (xN)" rows with the cursor row marked, hides the legacy grid for as long as the paint is kept (a refresh keeps it hidden), shows the empty line for an empty pocket, and after hide() then show() the grid is back and the bag parts are hidden until the next paint', () => {
    // WRONG IMPL KILLED: parts created lazily or visible before the first paint (the player would
    // see an empty bag frame beside the legacy grid); a tab strip with the wrong labels, order or
    // selected tab; a list that shows every pocket or the wrong one; row text that is not the
    // resolver's "name (xN)"; a cursor row marked by colour alone (no is-active / aria-selected); a
    // list of <button>s (the raising screen's button census would change); a legacy grid that stays
    // visible under the bag, that a refresh() brings back, or that never comes back after a close
    // (the kept paint must be dropped by hide()); a close that leaves the bag parts showing the
    // dropped paint; an empty pocket that shows nothing; and markup injected from an item name.
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    view.show();
    view.refresh(raTrainVm());
    const buttonsBefore = root.querySelectorAll('button').length;
    expect(buttonsBefore, 'precondition: the legacy cards render buttons').toBeGreaterThan(0);
    const grid = ctl8fPart('raising-inventory');
    expect(grid.style.display, 'the legacy grid shows before any paint').not.toBe('none');
    for (const id of CTL8F_PARTS) {
      expect(ctl8fPart(id).style.display, `#${id} is hidden before any paint`).toBe('none');
      expect(root.contains(ctl8fPart(id)), `#${id} is inside the raising root`).toBe(true);
    }
    expect(ctl8fPart('bag-status').textContent, 'the status line starts empty').toBe('');

    const vm = ctl8fVm();
    view.paint(ctl8fPaint(vm));
    expect(ctl8fShown('bag-tabs')).toBe(true);
    expect(ctl8fShown('bag-list')).toBe(true);
    expect(
      ctl8fTabEls().map((t) => [t.dataset.navTab, t.textContent, t.getAttribute('aria-selected')]),
      'the four pockets in order, Bait selected',
    ).toEqual([
      ['bait', 'Bait', 'true'],
      ['food', 'Food', 'false'],
      ['medicine', 'Medicine', 'false'],
      ['other', 'Other', 'false'],
    ]);
    expect(ctl8fKeys('bag-list'), 'only the active pocket`s items').toEqual(['3']);
    expect(ctl8fRows('bag-list').map((r) => r.textContent)).toEqual(['Lure Berry (x4)']);
    expect(ctl8fActive('bag-list')).toEqual(['3']);
    expect(ctl8fRows('bag-list')[0]?.getAttribute('aria-selected')).toBe('true');
    expect(grid.style.display, 'the legacy grid is hidden under a kept paint').toBe('none');
    expect(
      ctl8fLinesOutsideGrid(root, 'No items.'),
      'a pocket with items shows no empty line',
    ).toEqual([]);
    expect(root.querySelectorAll('button').length, 'no bag row is a button').toBe(buttonsBefore);

    // The food pocket, the cursor on its second item.
    view.paint(ctl8fPaint(vm, { nav: ctl8fNav(vm, ['RB', 'Down']) }));
    expect(
      ctl8fTabEls().map((t) => t.getAttribute('aria-selected')),
      'only Food is selected now',
    ).toEqual(['false', 'true', 'false', 'false']);
    expect(ctl8fKeys('bag-list'), 'Food in inventory order').toEqual(['9', '5']);
    expect(ctl8fRows('bag-list').map((r) => r.textContent)).toEqual([
      'Glow Berry (x2)',
      'Power Root (x3)',
    ]);
    expect(
      ctl8fRows('bag-list').map((r) => r.textContent),
      'the rows are the resolver`s raising.inventory.item',
    ).toEqual([
      i18nTf('raising.inventory.item', { name: 'Glow Berry', count: 2 }),
      i18nTf('raising.inventory.item', { name: 'Power Root', count: 3 }),
    ]);
    expect(ctl8fActive('bag-list'), 'the cursor row only').toEqual(['5']);
    expect(ctl8fRows('bag-list').map((r) => r.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
    ]);

    // A refresh() under a kept paint does not bring the legacy grid back.
    view.refresh(ctl7bItem(raTrainVm(), 0, { count: 5 }));
    expect(grid.style.display, 'a refresh keeps the legacy grid hidden').toBe('none');
    expect(grid.textContent ?? '', 'and still rebuilds its content').toContain('Protein (x5)');

    // An empty pocket: no rows, the empty line somewhere in the bag panel.
    const bare = ctl8fVm({ bareMedicine: true });
    view.paint(ctl8fPaint(bare, { nav: ctl8fNav(bare, ['RB', 'RB']) }));
    expect(ctl8fKeys('bag-list'), 'no rows').toEqual([]);
    expect(
      ctl8fLinesOutsideGrid(root, i18nT('raising.inventory.empty')).length,
      'the empty line is inside the bag panel, not the legacy grid',
    ).toBeGreaterThan(0);
    expect(ctl8fTabEls().map((t) => t.dataset.navTab)).toEqual([
      'bait',
      'food',
      'medicine',
      'other',
    ]);

    // hide() then show(): the grid is back, the dropped paint is not shown.
    view.hide();
    view.show();
    expect(grid.style.display, 'the legacy grid is visible again after a reopen').not.toBe('none');
    expect(ctl8fShown('bag-tabs'), 'the bag tabs are hidden again').toBe(false);
    expect(ctl8fShown('bag-list'), 'the bag list is hidden again').toBe(false);
    view.paint(ctl8fPaint(vm));
    expect(grid.style.display, 'the next paint hides the grid again').toBe('none');
    expect(ctl8fShown('bag-tabs')).toBe(true);
    expect(ctl8fKeys('bag-list')).toEqual(['3']);

    // Item names are text, never markup.
    const hostile = ctl8fVm();
    const first = hostile.pockets[0]?.items[0];
    if (first === undefined) throw new Error('fixture: no first item');
    const injected: BagVm = {
      ...hostile,
      pockets: [
        { pocket: 'bait', items: [{ ...first, name: '<b>bold</b>' }] },
        ...hostile.pockets.slice(1),
      ],
    };
    view.paint(ctl8fPaint(injected));
    expect(ctl8fRows('bag-list').map((r) => r.textContent)).toEqual(['<b>bold</b> (x4)']);
    expect(ctl8fPart('bag-list').querySelector('b'), 'no element was created').toBeNull();
  });

  it('CTL8F-2-VIEW-SHEET: the sheet, description and picker show only in their own phase (the title with the picker), the sheet lists Feed / Use / Info with the cursor on the phase`s action and disabled rows marked aria-disabled, the description shows the item`s description (the none-line when empty), the picker lists the monsters by name with the cursor on the phase`s monster, and the status line carries the three messages (data-feedback only for Fed) and clears', () => {
    // WRONG IMPL KILLED: a sheet / description / picker / title visible in the wrong phase or in
    // every phase; a sheet that never marks the phase's action; a disabled Use or Feed that is not
    // aria-disabled (or an enabled row that is); labels that are not the catalog's; a description
    // that is stale after the item changes or blank for an item with none; a picker cursor that
    // ignores the phase, rows that are not the monsters' names in order; a status line that never
    // clears, keeps data-feedback after Fed, sets it for the refusals, or builds markup from the
    // monster's name; and a status line that is not the frame's feedback line.
    const { parent, view } = s4Mount();
    const root = overlayRootOf(parent);
    view.show();
    const vm = ctl8fVm();
    const food = ctl8fNav(vm, ['RB']);
    const root5 = ctl8fNav(vm, ['RB', 'Down']);
    const lure = ctl8fNav(vm);
    const shard = ctl8fNav(vm, ['RB', 'RB', 'RB']);

    const matrix: ReadonlyArray<
      readonly [string, Ctl8fPaint, { sheet: boolean; info: boolean; picker: boolean }]
    > = [
      ['list', ctl8fPaint(vm), { sheet: false, info: false, picker: false }],
      [
        'sheet',
        ctl8fPaint(vm, { nav: food, phase: { kind: 'sheet', itemId: 9, action: 'feed' } }),
        { sheet: true, info: false, picker: false },
      ],
      [
        'info',
        ctl8fPaint(vm, { nav: food, phase: { kind: 'info', itemId: 9 } }),
        { sheet: false, info: true, picker: false },
      ],
      [
        'picker',
        ctl8fPaint(vm, { nav: food, phase: { kind: 'picker', itemId: 9, monster: '11' } }),
        { sheet: false, info: false, picker: true },
      ],
      ['list again', ctl8fPaint(vm, { nav: food }), { sheet: false, info: false, picker: false }],
    ];
    for (const [name, p, want] of matrix) {
      view.paint(p);
      expect(ctl8fShown('bag-sheet'), `${name}: #bag-sheet`).toBe(want.sheet);
      expect(ctl8fShown('bag-info'), `${name}: #bag-info`).toBe(want.info);
      expect(ctl8fShown('bag-picker'), `${name}: #bag-picker`).toBe(want.picker);
      expect(ctl8fShown('bag-picker-title'), `${name}: #bag-picker-title`).toBe(want.picker);
    }

    // The sheet.
    const sheetOf = (nav: NavState, itemId: number, action: 'feed' | 'use' | 'info', v = vm) => {
      view.paint(ctl8fPaint(v, { nav, phase: { kind: 'sheet', itemId, action } }));
      return ctl8fRows('bag-sheet');
    };
    let rows = sheetOf(food, 9, 'feed');
    expect(rows.map((r) => [r.dataset.navKey, r.textContent])).toEqual([
      ['feed', 'Feed'],
      ['info', 'Info'],
    ]);
    expect(ctl8fActive('bag-sheet'), 'the cursor on Feed').toEqual(['feed']);
    expect(
      rows.map((r) => r.getAttribute('aria-disabled')),
      'with monsters Feed is enabled',
    ).toEqual([null, null]);
    rows = sheetOf(food, 9, 'info');
    expect(ctl8fActive('bag-sheet'), 'the cursor follows the action').toEqual(['info']);
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true']);

    rows = sheetOf(lure, 3, 'use');
    expect(rows.map((r) => [r.dataset.navKey, r.textContent])).toEqual([
      ['use', 'Use'],
      ['info', 'Info'],
    ]);
    expect(
      rows.map((r) => r.getAttribute('aria-disabled')),
      'Use is aria-disabled, Info is not',
    ).toEqual(['true', null]);
    expect(ctl8fActive('bag-sheet')).toEqual(['use']);
    rows = sheetOf(shard, 20, 'info');
    expect(
      rows.map((r) => r.dataset.navKey),
      'a shard offers Info alone',
    ).toEqual(['info']);

    const lonely = ctl8fVm({ monsters: false });
    rows = sheetOf(food, 9, 'feed', lonely);
    expect(
      rows.map((r) => [r.dataset.navKey, r.getAttribute('aria-disabled')]),
      'with no monster Feed is disabled',
    ).toEqual([
      ['feed', 'true'],
      ['info', null],
    ]);

    // The description: the item's own, the none-line when empty, never stale.
    view.paint(ctl8fPaint(vm, { nav: food, phase: { kind: 'info', itemId: 9 } }));
    expect(ctl8fPart('bag-info').textContent ?? '').toContain('Raises speed.');
    view.paint(ctl8fPaint(vm, { nav: root5, phase: { kind: 'info', itemId: 5 } }));
    expect(ctl8fPart('bag-info').textContent ?? '').toContain('Raises attack.');
    expect(ctl8fPart('bag-info').textContent ?? '', 'not the previous item`s').not.toContain(
      'Raises speed.',
    );
    view.paint(ctl8fPaint(vm, { nav: shard, phase: { kind: 'info', itemId: 20 } }));
    const none = i18nT('shop.description.none');
    expect(none, 'precondition: the none-line is not blank').not.toBe('');
    expect(ctl8fPart('bag-info').textContent ?? '', 'an empty description').toContain(none);
    expect(ctl8fPart('bag-info').textContent ?? '').not.toContain('Raises');

    // The picker.
    view.paint(ctl8fPaint(vm, { nav: food, phase: { kind: 'picker', itemId: 9, monster: '12' } }));
    expect(ctl8fPart('bag-picker-title').textContent, 'the picker title').toBe(
      'Feed which monster?',
    );
    expect(ctl8fRows('bag-picker').map((r) => [r.dataset.navKey, r.textContent])).toEqual([
      ['11', 'Kip'],
      ['12', 'Emberfang'],
      ['21', 'Sproutle'],
    ]);
    expect(ctl8fActive('bag-picker'), 'the cursor on the phase`s monster').toEqual(['12']);
    expect(ctl8fRows('bag-picker').map((r) => r.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ]);
    view.paint(ctl8fPaint(vm, { nav: food, phase: { kind: 'picker', itemId: 9, monster: '21' } }));
    expect(ctl8fActive('bag-picker')).toEqual(['21']);
    expect(() =>
      view.paint(
        ctl8fPaint(lonely, { nav: food, phase: { kind: 'picker', itemId: 9, monster: null } }),
      ),
    ).not.toThrow();
    expect(ctl8fRows('bag-picker'), 'an empty roster lists nobody').toEqual([]);

    // The status line.
    view.paint(ctl8fPaint(vm));
    const status = ctl8fPart('bag-status');
    expect(status.classList.contains('mr-frame-feedback'), 'the frame`s feedback line').toBe(true);
    expect(status.textContent, 'empty with no status').toBe('');
    expect(status.hasAttribute('data-feedback')).toBe(false);
    const withStatus = (s: Ctl8fPaint['status']) => view.paint(ctl8fPaint(vm, { status: s }));
    withStatus({ kind: 'battleOnly' });
    expect(status.textContent).toBe('Use items from the battle Bag command');
    expect(status.hasAttribute('data-feedback'), 'a refusal is not "ok"').toBe(false);
    withStatus({ kind: 'noMonsters' });
    expect(status.textContent).toBe('No monsters to feed');
    expect(status.hasAttribute('data-feedback')).toBe(false);
    withStatus({ kind: 'fed', name: 'Kip' });
    expect(status.textContent, 'Fed, resolved with the name').toBe(
      i18nTf('box.feedback.fed', { name: 'Kip' }),
    );
    expect(status.textContent ?? '').toContain('Kip');
    expect(status.getAttribute('data-feedback'), 'only Fed is ok').toBe('ok');
    withStatus({ kind: 'fed', name: '<i>x</i>' });
    expect(status.textContent).toBe(i18nTf('box.feedback.fed', { name: '<i>x</i>' }));
    expect(status.querySelector('i'), 'a name is text, never markup').toBeNull();
    withStatus(null);
    expect(status.textContent, 'cleared').toBe('');
    expect(status.hasAttribute('data-feedback'), 'and its mark is cleared with it').toBe(false);
    withStatus({ kind: 'fed', name: 'Kip' });
    withStatus({ kind: 'battleOnly' });
    expect(status.hasAttribute('data-feedback'), 'a refusal after Fed drops the ok mark').toBe(
      false,
    );
    expect(root.contains(status), 'inside the raising root').toBe(true);
  });

  it('CTL8F-1-VIEW-WIRED: the real adapter driving the real view: opening shows Bait; RB shows Food with its rows and cursor; A, Down, A reach the description and B returns; Feed, Down opens the picker on the second monster and A sends the train command and closes it; Use on a cure shows the battleOnly line', async () => {
    // WRONG IMPL KILLED: a view whose paint shape is not the adapter's (the hand-built cases above
    // would pass while the pair is unwired); a paint that the adapter never makes after a step; a
    // list that does not follow the adapter's pocket; a sheet / description / picker that is not
    // shown for the adapter's phase; a train command that does not carry the picker's monster; and
    // a status line the adapter's refusal never reaches.
    const { buildBagVm } = await import('./bagModel');
    const { bagScreen } = await import('./screens/bagScreen');
    const defs = new Map(
      [
        {
          id: 3,
          name: 'Lure Berry',
          description: 'Lures a wild monster.',
          recruitBonus: 10,
          trainStat: null,
          cureStatus: null,
        },
        {
          id: 5,
          name: 'Power Root',
          description: 'Raises attack.',
          recruitBonus: 0,
          trainStat: 'attack',
          cureStatus: null,
        },
        {
          id: 9,
          name: 'Glow Berry',
          description: 'Raises speed.',
          recruitBonus: 0,
          trainStat: 'speed',
          cureStatus: null,
        },
        {
          id: 12,
          name: 'Antidote',
          description: 'Cures poison.',
          recruitBonus: 0,
          trainStat: null,
          cureStatus: 'Poison',
        },
        // A shard-like definition with no effect fields: the `other` pocket the data holds.
        {
          id: 20,
          name: 'Moon Shard',
          description: '',
          recruitBonus: 0,
          trainStat: null,
          cureStatus: null,
        },
      ].map(
        (d) => [d.id, { ...d, trainAmount: d.trainStat === null ? 0 : 1, sellPrice: 0n }] as const,
      ),
    );
    const owner = 'ab'.repeat(32);
    const inventory = [
      { invId: 1n, ownerIdentity: owner, itemId: 9, count: 2 },
      { invId: 2n, ownerIdentity: owner, itemId: 3, count: 4 },
      { invId: 3n, ownerIdentity: owner, itemId: 5, count: 3 },
      { invId: 4n, ownerIdentity: owner, itemId: 12, count: 1 },
      { invId: 5n, ownerIdentity: owner, itemId: 20, count: 6 },
    ];
    const vm = buildBagVm(inventory, defs, [
      { key: '11', monsterId: 11n, name: 'Kip' },
      { key: '12', monsterId: 12n, name: 'Emberfang' },
    ]);

    const { parent, view } = s4Mount();
    view.show();
    let state = bagScreen.init(vm);
    const step = (button: VButton) => {
      const out = bagScreen.onButton(vm, state, { button, repeat: false });
      state = out.state;
      bagScreen.paint?.(view, vm, state);
      return out.result;
    };
    bagScreen.paint?.(view, vm, state);

    expect(ctl8fTabEls().map((t) => t.dataset.navTab)).toEqual([
      'bait',
      'food',
      'medicine',
      'other',
    ]);
    expect(ctl8fTabEls().map((t) => t.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    expect(ctl8fRows('bag-list').map((r) => r.textContent)).toEqual(['Lure Berry (x4)']);

    expect(step('RB')).toBe('consumed');
    expect(ctl8fTabEls().map((t) => t.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
    expect(ctl8fRows('bag-list').map((r) => r.textContent)).toEqual([
      'Glow Berry (x2)',
      'Power Root (x3)',
    ]);
    expect(ctl8fActive('bag-list')).toEqual(['9']);

    expect(step('A')).toBe('consumed');
    expect(ctl8fShown('bag-sheet')).toBe(true);
    expect(ctl8fRows('bag-sheet').map((r) => r.textContent)).toEqual(['Feed', 'Info']);
    expect(ctl8fActive('bag-sheet')).toEqual(['feed']);

    expect(step('Down')).toBe('consumed');
    expect(ctl8fActive('bag-sheet')).toEqual(['info']);
    expect(step('A')).toBe('consumed');
    expect(ctl8fShown('bag-info')).toBe(true);
    expect(ctl8fShown('bag-sheet')).toBe(false);
    expect(ctl8fPart('bag-info').textContent ?? '').toContain('Raises speed.');
    expect(step('B')).toBe('consumed');
    expect(ctl8fShown('bag-info')).toBe(false);
    expect(ctl8fActive('bag-sheet'), 'back on the sheet, on Info').toEqual(['info']);

    expect(step('Up')).toBe('consumed');
    expect(step('A')).toBe('consumed');
    expect(ctl8fShown('bag-picker')).toBe(true);
    expect(ctl8fPart('bag-picker-title').textContent).toBe('Feed which monster?');
    expect(ctl8fActive('bag-picker')).toEqual(['11']);
    expect(step('Down')).toBe('consumed');
    expect(ctl8fActive('bag-picker')).toEqual(['12']);
    expect(step('A')).toEqual({ kind: 'train', monsterId: 12n, foodItemId: 9 });
    expect(ctl8fShown('bag-picker'), 'the picker closes on the send').toBe(false);
    expect(ctl8fShown('bag-sheet')).toBe(false);
    expect(ctl8fActive('bag-list'), 'the cursor is on the fed item').toEqual(['9']);

    // Use on a cure: the battleOnly line.
    expect(step('RB')).toBe('consumed');
    expect(ctl8fKeys('bag-list')).toEqual(['12']);
    expect(step('A')).toBe('consumed');
    expect(ctl8fActive('bag-sheet')).toEqual(['use']);
    expect(step('A')).toBe('consumed');
    expect(ctl8fPart('bag-status').textContent).toBe('Use items from the battle Bag command');
    expect(ctl8fShown('bag-sheet'), 'the sheet stays open').toBe(true);
    expect(parent.contains(ctl8fPart('bag-status'))).toBe(true);
    expect(step('B')).toBe('consumed');
    expect(ctl8fPart('bag-status').textContent, 'the next button clears the line').toBe('');
  });
});

// ---------------------------------------------------------------------------
// ctl-8f red-team teeth for the Bag panel: what a reopen, a stale phase, the empty line, the
// always-shown tab strip and list, the ARIA wiring and the focus guard must do. Untagged cases.
// ---------------------------------------------------------------------------
describe('RaisingView ctl-8f: the Bag panel teeth', () => {
  const root5 = (vm: BagVm) => ctl8fNav(vm, ['RB', 'Down']);

  it('a status painted before hide() is gone after show(): the line is empty and carries no data-feedback', () => {
    // WRONG IMPL KILLED: a hide() that forgets the status line (the next open greets the player
    // with the last visit's "Fed Kip" and its ok mark until the first paint).
    const { view } = s4Mount();
    view.show();
    const vm = ctl8fVm();
    view.paint(ctl8fPaint(vm, { status: { kind: 'fed', name: 'Kip' } }));
    expect(ctl8fPart('bag-status').textContent, 'precondition').not.toBe('');
    expect(ctl8fPart('bag-status').getAttribute('data-feedback'), 'precondition').toBe('ok');
    view.hide();
    view.show();
    expect(ctl8fPart('bag-status').textContent, 'cleared by the close').toBe('');
    expect(ctl8fPart('bag-status').hasAttribute('data-feedback')).toBe(false);
  });

  it('a sheet, description or picker phase for an item the view model does not list shows none of the three', () => {
    // WRONG IMPL KILLED: a view that shows the sheet / description / picker for the phase kind
    // alone, so a paint that outlives its item (an adapter one batch late) draws an empty sheet
    // or a picker for nothing.
    const { view } = s4Mount();
    view.show();
    const vm = ctl8fVm();
    const food = ctl8fNav(vm, ['RB']);
    const phases: ReadonlyArray<readonly [string, Ctl8fPaint['phase']]> = [
      ['sheet', { kind: 'sheet', itemId: 999, action: 'feed' }],
      ['info', { kind: 'info', itemId: 999 }],
      ['picker', { kind: 'picker', itemId: 999, monster: '11' }],
    ];
    for (const [name, phase] of phases) {
      view.paint(ctl8fPaint(vm, { nav: food, phase }));
      for (const id of ['bag-sheet', 'bag-info', 'bag-picker']) {
        expect(ctl8fShown(id), `${name} phase for an unlisted item: #${id}`).toBe(false);
      }
    }
    // Control: the same phases for a listed item do show their part.
    view.paint(ctl8fPaint(vm, { nav: food, phase: { kind: 'sheet', itemId: 9, action: 'feed' } }));
    expect(ctl8fShown('bag-sheet'), 'control: a listed item shows its sheet').toBe(true);
  });

  it('#bag-empty shows for an empty pocket and with no pockets at all, and is hidden for a pocket that has items', () => {
    // WRONG IMPL KILLED: an empty line that is created once and never toggled (it shows over a
    // full pocket, or never shows), one keyed on the active pocket only (a bag with no definitions
    // at all would show a blank frame), and an empty line with no text.
    const { view } = s4Mount();
    view.show();
    const vm = ctl8fVm();
    view.paint(ctl8fPaint(vm));
    expect(ctl8fShown('bag-empty'), 'a pocket with items: hidden').toBe(false);
    const bare = ctl8fVm({ bareMedicine: true });
    view.paint(ctl8fPaint(bare, { nav: ctl8fNav(bare, ['RB', 'RB']) }));
    expect(ctl8fShown('bag-empty'), 'an empty pocket: shown').toBe(true);
    expect(ctl8fPart('bag-empty').textContent ?? '').toContain(i18nT('raising.inventory.empty'));
    view.paint(ctl8fPaint(vm, { nav: ctl8fNav(vm, ['RB']) }));
    expect(ctl8fShown('bag-empty'), 'back on a full pocket: hidden again').toBe(false);
    const none: BagVm = { pockets: [], monsters: [] };
    view.paint(ctl8fPaint(none, { nav: ctl8fNav(none) }));
    expect(ctl8fShown('bag-empty'), 'no pockets at all: shown').toBe(true);
    expect(ctl8fPart('bag-empty').textContent ?? '').toContain(i18nT('raising.inventory.empty'));
  });

  it('the tab strip and the item list stay shown in the sheet, description and picker phases', () => {
    // WRONG IMPL KILLED: a paint that hides the pockets and the list while a sheet, a description
    // or a picker is up (the player loses the item they are acting on).
    const { view } = s4Mount();
    view.show();
    const vm = ctl8fVm();
    const food = ctl8fNav(vm, ['RB']);
    const phases: ReadonlyArray<readonly [string, Ctl8fPaint['phase']]> = [
      ['list', { kind: 'list' }],
      ['sheet', { kind: 'sheet', itemId: 9, action: 'feed' }],
      ['info', { kind: 'info', itemId: 9 }],
      ['picker', { kind: 'picker', itemId: 9, monster: '11' }],
    ];
    for (const [name, phase] of phases) {
      view.paint(ctl8fPaint(vm, { nav: food, phase }));
      expect(ctl8fShown('bag-tabs'), `${name}: #bag-tabs`).toBe(true);
      expect(ctl8fShown('bag-list'), `${name}: #bag-list`).toBe(true);
      expect(ctl8fKeys('bag-list'), `${name}: the pocket's rows`).toEqual(['9', '5']);
    }
  });

  it('the picker is labelled by its title and the sheet by the list row of its item', () => {
    // WRONG IMPL KILLED: a picker or sheet listbox with no accessible name; a picker named by the
    // wrong element; a sheet named by a fixed element or by another item's row; a name that points
    // at an id that does not exist.
    const { view } = s4Mount();
    view.show();
    const vm = ctl8fVm();
    view.paint(
      ctl8fPaint(vm, {
        nav: ctl8fNav(vm, ['RB']),
        phase: { kind: 'picker', itemId: 9, monster: '11' },
      }),
    );
    expect(ctl8fPart('bag-picker').getAttribute('aria-labelledby')).toBe('bag-picker-title');
    expect(ctl8fPart('bag-picker-title'), 'the title it names exists').toBeTruthy();

    const cases: ReadonlyArray<readonly [string, NavState, number]> = [
      ['the first food', ctl8fNav(vm, ['RB']), 9],
      ['the second food', root5(vm), 5],
      ['the bait', ctl8fNav(vm), 3],
    ];
    for (const [name, nav, itemId] of cases) {
      view.paint(ctl8fPaint(vm, { nav, phase: { kind: 'sheet', itemId, action: 'info' } }));
      const id = ctl8fPart('bag-sheet').getAttribute('aria-labelledby');
      expect(id, `${name}: the sheet names something`).toBeTruthy();
      const named = document.getElementById(id ?? '');
      expect(named, `${name}: the named element exists`).not.toBeNull();
      expect(named?.dataset.navKey, `${name}: it is that item's row`).toBe(String(itemId));
      expect(ctl8fPart('bag-list').contains(named), `${name}: inside #bag-list`).toBe(true);
    }
  });

  it('closing the sheet or the picker while it holds focus moves focus to the raising title, never to the body', () => {
    // WRONG IMPL KILLED: a paint that hides the focused sheet / picker container and leaves focus
    // stranded on <body> (the keyboard and the screen reader lose their place in the dialog).
    const { view } = s4Mount();
    view.show();
    const vm = ctl8fVm();
    const food = ctl8fNav(vm, ['RB']);
    const title = document.querySelector<HTMLElement>('[data-testid="raising-title"]');
    expect(title, 'precondition: the raising title').not.toBeNull();
    const phases: ReadonlyArray<readonly [string, Ctl8fPaint['phase'], string]> = [
      ['sheet', { kind: 'sheet', itemId: 9, action: 'feed' }, 'bag-sheet'],
      ['picker', { kind: 'picker', itemId: 9, monster: '11' }, 'bag-picker'],
    ];
    for (const [name, phase, id] of phases) {
      view.paint(ctl8fPaint(vm, { nav: food, phase }));
      ctl8fPart(id).focus();
      expect(document.activeElement, `${name}: precondition, the part holds focus`).toBe(
        ctl8fPart(id),
      );
      view.paint(ctl8fPaint(vm, { nav: food }));
      expect(document.activeElement, `${name} closed: focus is on the title`).toBe(title);
      expect(document.activeElement).not.toBe(document.body);
    }
  });

  it('a paint that arrives while the view is hidden is dropped at the next show(): the legacy grid is visible and the bag parts hidden', () => {
    // WRONG IMPL KILLED: a hide() that drops the kept paint but a paint() that re-keeps one while
    // hidden (the reopen shows a stale bag over the legacy grid, or hides the grid with the bag
    // parts hidden: the player sees no inventory at all).
    const { view } = s4Mount();
    view.show();
    view.refresh(raTrainVm());
    const vm = ctl8fVm();
    view.paint(ctl8fPaint(vm));
    view.hide();
    view.paint(ctl8fPaint(vm, { nav: ctl8fNav(vm, ['RB']) })); // a batch lands while hidden
    view.show();
    expect(ctl8fPart('raising-inventory').style.display, 'the legacy grid shows').not.toBe('none');
    for (const id of ['bag-tabs', 'bag-list', 'bag-sheet', 'bag-info', 'bag-picker']) {
      expect(ctl8fShown(id), `#${id} is hidden after the reopen`).toBe(false);
    }
  });
});
