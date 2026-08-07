// @vitest-environment happy-dom
// ui/raisingView.test.ts — RED gating tests for feel-polish D1 care feedback (ADR-0159).
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

// ---------------------------------------------------------------------------
// EG4-4 — the status line swaps its Bond readout for a Trust-tier readout.
//
// SOURCE OF TRUTH: spec EARS EG4-4 ("raisingModel.ts/raisingView.ts SHALL swap
// their `Bond ${mon.bond}` status-line readout for a trust_tier readout") +
// contract §E ("raisingView.ts:150 `Bond ${mon.bond}` -> `Trust ${mon.trustTier}`").
//
// RED REASON (verified against client/src/ui/raisingView.ts:150 this session):
//   info.textContent = `Lv${mon.level} · Bond ${mon.bond} · HP …`
// The word "Bond" is still there and `mon.trustTier` is read nowhere in the file.
//
// WHY BOTH HALVES ARE ASSERTED: a half-swap is the realistic failure. Rendering
// `Bond ${mon.trustTier}` satisfies "the tier name appears"; rendering
// `Trust ${mon.bond}` satisfies "the word Trust appears" (and would crash to
// `undefined` once the field is gone). Only the positive AND the negative together
// close it.
// ---------------------------------------------------------------------------

describe('★ RaisingView status line (EG4-4): Trust tier replaces the Bond readout', () => {
  it('★ BITES: the rendered card shows "Trust" AND the tier name, and never the word "Bond"', () => {
    // WRONG IMPL KILLED (a): the shipped `Bond ${mon.bond}` surviving untouched
    // (today's state — RED).
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
    // wrong element, or is missing entirely (TypeError — the RED reason today).
    const parent = mountParent();
    const view = new RaisingView(parent, makeCallbacks());

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
// must be a descendant of the raising overlay root (position:fixed; inset:0;
// z-index:100), never a sibling node like statusEl that the overlay paints over.
// ---------------------------------------------------------------------------

describe('★ RaisingView showFeedback(): CONTAINMENT — feedback node is inside the overlay root (C2, ADR-0159 D1)', () => {
  it('★ C2 BITES: the #raising-feedback node is a DESCENDANT of the overlay root — kills the exact shipped bug (a node OUTSIDE the z-index:100 overlay, invisible behind it)', () => {
    // WRONG IMPL KILLED: an impl that writes feedback to a node appended to `document.body`
    // (or reuses main.ts's `statusEl`) instead of INSIDE the RaisingView's own overlay root.
    // The raising overlay is `position:fixed; inset:0; z-index:100` (raisingView.ts:28-31) —
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
        'painted over by the fixed/z-index:100 overlay and is never visible to the player',
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
    // WRONG IMPL KILLED: a Care button with no #pending lock (the CURRENT shipped
    // shape — raisingView.ts:120-124 calls `this.#callbacks.onCare(mon.monsterId)`
    // directly on every click, unconditionally). Without the guard, a double-click
    // fires onCare TWICE before the first reducer call settles — the exact
    // contradictory "Cared!" -> "care cooldown not yet elapsed" flash ADR-0159 D1
    // exists to prevent.
    let resolveFlight: (() => void) | undefined;
    const flightPromise = new Promise<void>((res) => {
      resolveFlight = res;
    });
    // onCare is typed `(monsterId: bigint) => void | Promise<void>`, but (shopView/renameView
    // precedent) the guard implementation is expected to wrap the callback's return
    // value via `Promise.resolve(this.#cbs.onCare(...)).finally(...)` so a caller that
    // genuinely returns a pending Promise keeps the lock held until it settles.
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
// ★★ C6 (code-review BUG 2, MINOR-but-a-regression): #pending must be tracked
// PER MONSTER, not view-wide. The shipped raisingView.ts uses a single class-level
// `#pending` flag (raisingView.ts:34) shared across every monster's Care button
// (raisingView.ts:158-174). Two demonstrated symptoms:
//   (1) With >=2 monsters, a care call in flight for monster A holds the SHARED
//       flag, so clicking monster B's Care button — visually enabled, since only
//       A's DOM node was disabled — is a SILENT no-op. Before this slice there was
//       no guard at all, so B worked; this is a genuine regression.
//   (2) A batch-triggered refresh() mid-flight rebuilds the Care button via
//       `#monsterEl.replaceChildren()`; the new button is NOT disabled but the
//       shared flag still swallows its click — "looks clickable, silently does
//       nothing".
// ---------------------------------------------------------------------------

describe('★★ RaisingView Care button: #pending must be tracked PER MONSTER, not view-wide (C6, code-review BUG 2)', () => {
  it("★★ BITES: with two monsters rendered, A pending does NOT block B — B's onCare fires exactly once and B's button stays enabled, while A's button IS disabled — kills the shared view-wide #pending regression", async () => {
    // WRONG IMPL KILLED: the CURRENT shipped shape — a single class-level `#pending`
    // boolean shared across every monster row. Clicking A sets it true; clicking B
    // then hits `if (this.#pending) return;` and is silently swallowed, even though
    // B's own button was never disabled (it looks clickable). Before this slice there
    // was no guard at all, so B worked — this is a genuine regression this slice
    // introduced.
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
    // pending state lives in a per-monster SET the render function consults when
    // building each button, so a rebuilt button for a still-pending monster is
    // re-derived as disabled, not lost.
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
    view.refresh(twoMonsterVm(1n, 2n));

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
        're-derived from a per-monster pending SET when the button is built, not lost on ' +
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
