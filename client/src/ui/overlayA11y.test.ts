// @vitest-environment happy-dom
// ui/overlayA11y.test.ts — m23-s1 RED gating tests for openOverlayA11y/closeOverlayA11y: ARIA
// attribute writes, sole ownership of the deferred initial focus, trap wiring, and the
// return-focus map.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M23-accessibility.spec.md §2.1-§2.3, §6;
//   memory/projects/monster-realm-m23-s1-plan.md (§overlayA11y.ts, risk R1, adjudication A2/A3/A6);
//   docs/adr/0205-overlay-a11y-metadata-ssot-and-copy-catalog.md D1-D3, D7;
//   memory/projects/gates/m23-s1.gates.md X10/X11/X12.
//
// RED REASON: `client/src/ui/overlayA11y.ts` DOES NOT EXIST YET. Every test below fails with
// "Failed to resolve import './overlayA11y'" (module-not-found) until the implementer lands it.
//
// ENVIRONMENT: happy-dom — ARIA attributes, focus(), document.activeElement, and a real
// `setTimeout(...,0)` macrotask flush all need a DOM. The module's deferred-focus timer is a REAL
// timer by design (plan §Purity seams: injecting a scheduler here would add a parameter all
// sixteen S3/S4 call sites must fill for zero benefit) — flushed below with a real
// `await new Promise((r) => setTimeout(r, 0))`, never fake timers (house rule, F3).
//
// TEST-ISOLATION DEVICE (deliberate, not boilerplate): overlayA11y.ts holds ONE module-private
// `Map<OverlayId, record>`. There is no exported reset hook — a zero-consumer production export
// is banned by this module family's own rule (overlayRegistry.ts:26-30) — and `vi.resetModules()`
// would tear down the whole import graph other tests in this file share. Instead, `beforeEach`/
// `afterEach` call the PRODUCTION `closeOverlayA11y(id, null)` for every OverlayId. This is legal
// PRECISELY because close-without-open is a documented, separately-gated no-op
// (S1-CLOSE-WITHOUT-OPEN-NOOP below) — the cleanup relies on nothing this file does not itself
// pin. It also cancels any pending deferred-focus timer left over from a test that (deliberately)
// never closed its own overlay, which is why every test that opens something is safe to leave
// "dangling" — the next beforeEach/afterEach sweep tears it down before the timer can fire mid
// some later, unrelated test.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/plan only.
//
// WRONG-IMPL-KILLED index:
//   - synchronous focus (renameView.ts:101's bug, re-introduced)  -> S1-DEFER-NOT-SYNC / S1-DEFER-THEN-FOCUSED
//   - pending timer not cancelled on same-tick close             -> S1-DEFER-NO-STEAL-AFTER-CLOSE
//   - ARIA set from a literal instead of OVERLAY_A11Y             -> S1-ARIA-ALL-16
//   - a display:none node left claiming to be a dialog            -> S1-ARIA-STRIPPED-ON-CLOSE
//   - trap never installed / never uninstalled                    -> S1-TRAP-WIRED-ON-OPEN
//   - leaky/mis-keyed return-focus map                            -> S1-RETURNFOCUS-RESTORE / -DETACHED-FALLBACK / -DOUBLE-OPEN
//   - close-without-open / double-close throwing or moving focus  -> S1-CLOSE-WITHOUT-OPEN-NOOP / S1-CLOSE-DOUBLE-NOOP
//
// RED-TEAM ROUND 2 (measured hole, PARTIALLY closed below by a TRIPWIRE, UNTAGGED addition):
// `root.setAttribute('role', meta.role)` was replaced with the literal
// `root.setAttribute('role', 'dialog')` and S1-ARIA-ALL-16's full 16-way parameterisation still
// passed, because EVERY entry in OVERLAY_A11Y currently uses role: 'dialog' — the manifest has
// zero variance on that field, so no amount of looping over it can distinguish a real per-id
// table read from a hardcoded literal. `A11yMeta.role` is a two-member union
// ('dialog' | 'alertdialog') and there is no public API to inject a synthetic 'alertdialog'
// entry from a test, so this cannot be closed with a real assertion today. See the new
// "TRIPWIRE" describe block below: it pins the CURRENT all-'dialog' fact so that the day an
// overlay legitimately earns 'alertdialog', that test reds and forces a real per-id role
// assertion to be added alongside it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { a11yCopy } from './a11yCopy';
import { LIVE_REGION_ID } from './liveRegion';
import { closeOverlayA11y, openOverlayA11y } from './overlayA11y';
import { OVERLAY_A11Y, OVERLAY_IDS, type OverlayId } from './overlayRegistry';

async function flushMacrotask(): Promise<void> {
  // A microtask flush is NOT enough — the deferred focus is scheduled via setTimeout(...,0),
  // which only fires on a real macrotask boundary.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Builds a minimal element that MATCHES the given real `initialFocusSelector` shape.
 *  Every OVERLAY_A11Y selector is either `[data-testid="..."]` (the four constructed overlays) or
 *  `#id` (the twelve static-shell overlays). A bare `<div>` with no `tabindex` is used in BOTH
 *  cases — DELIBERATELY, not for convenience: red-team MEASURED that happy-dom focuses a bare
 *  `<div>` with no tabindex, which a real browser would NOT (A6 in the plan adjudication). Using a
 *  `<button>` here would dodge that real shape entirely (ten of the sixteen real selectors are
 *  headings/lists/status lines, never natively focusable elements). This proves the focus CALL
 *  targeted the right element — NOT that a browser would honour it; that property belongs to
 *  S2/S4/S10 and the nightly axe/E2E run (plan risk R1). */
function elementForSelector(selector: string): HTMLElement {
  const el = document.createElement('div');
  if (selector.startsWith('[data-testid="')) {
    const testid = selector.slice('[data-testid="'.length, -2);
    el.setAttribute('data-testid', testid);
  } else if (selector.startsWith('#')) {
    el.id = selector.slice(1);
  } else {
    throw new Error(`test fixture cannot build a selector of this shape: ${selector}`);
  }
  return el;
}

function mountRootFor(id: OverlayId): { root: HTMLElement; target: HTMLElement } {
  const root = document.createElement('div');
  root.id = `overlay-root-${id}`;
  const target = elementForSelector(OVERLAY_A11Y[id].initialFocusSelector);
  root.appendChild(target);
  document.body.appendChild(root);
  return { root, target };
}

/** Builds the shipped-shape live-region fixture: `#a11y-live`, `aria-live="polite"`,
 *  `aria-atomic="true"`, a direct `<body>` child — the exact shape `client/index.html:154` ships. */
function mountLiveNode(): HTMLElement {
  const node = document.createElement('div');
  node.id = LIVE_REGION_ID;
  node.setAttribute('aria-live', 'polite');
  node.setAttribute('aria-atomic', 'true');
  node.className = 'sr-only';
  document.body.appendChild(node);
  return node;
}

beforeEach(() => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  document.body.innerHTML = '';
});

afterEach(() => {
  for (const id of OVERLAY_IDS) closeOverlayA11y(id, null);
  document.body.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Deferred initial focus (S1-DEFER)
// ---------------------------------------------------------------------------

describe('openOverlayA11y — deferred initial focus, ONE macrotask, no synchronous focus (S1-DEFER)', () => {
  it('S1-DEFER-NOT-SYNC BITES: immediately after openOverlayA11y() returns, the initial-focus target is NOT yet focused', () => {
    // WRONG IMPL KILLED: focusing synchronously reintroduces the exact bug renameView.ts:101's
    // defer avoids — the `n` of a `KeyN` hotkey typed to OPEN the overlay lands in the freshly
    // focused field instead of being consumed as the open-hotkey. This half IS the tooth: without
    // it, a synchronous-focus implementation passes every other assertion in this file.
    const { root, target } = mountRootFor('boxView');
    openOverlayA11y('boxView', root);
    expect(document.activeElement).not.toBe(target);
  });

  it('S1-DEFER-THEN-FOCUSED BITES: after a real macrotask flush, the initial-focus target IS focused', async () => {
    // The companion positive half — without it, an implementation that NEVER focuses anything
    // would also pass S1-DEFER-NOT-SYNC vacuously.
    const { root, target } = mountRootFor('boxView');
    openOverlayA11y('boxView', root);
    await flushMacrotask();
    expect(document.activeElement).toBe(target);
  });

  it('S1-DEFER-NO-STEAL-AFTER-CLOSE BITES: closing in the SAME tick as opening cancels the pending focus — it never lands after the macrotask', async () => {
    // WRONG IMPL KILLED: a pending setTimeout not cleared on close would steal focus back onto a
    // target belonging to an overlay that is no longer open by the time the macrotask fires.
    const { root, target } = mountRootFor('boxView');
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    openOverlayA11y('boxView', root);
    closeOverlayA11y('boxView', null);
    await flushMacrotask();

    expect(document.activeElement).not.toBe(target);
  });
});

// ---------------------------------------------------------------------------
// ARIA attribute writes + trap wiring (S1-ARIA / S1-TRAP-WIRED)
// ---------------------------------------------------------------------------

describe('openOverlayA11y/closeOverlayA11y — ARIA attribute writes and focus-trap wiring (S1-ARIA)', () => {
  it('S1-ARIA-ALL-16 BITES: opening each of the 16 overlays sets role/aria-modal/aria-label from OVERLAY_A11Y, id-DERIVED, never a literal', () => {
    // WRONG IMPL KILLED: a literal (e.g. always role="dialog" aria-label="Overlay") would pass
    // for one id and fail the other fifteen once parameterised over the full manifest.
    //
    // PARTIAL TOOTH NOTICE (red-team round 2, MEASURED, honestly recorded — title/assertions
    // unchanged): the `role` assertion below is currently a PARTIAL tooth. Every OVERLAY_A11Y
    // entry today has role: 'dialog', so this loop cannot distinguish
    // `root.setAttribute('role', meta.role)` from the hardcoded `root.setAttribute('role',
    // 'dialog')` — both produce byte-identical output for all sixteen ids. See the
    // "TRIPWIRE" describe block below in this file for the deliberate trap that reds the day
    // that stops being true, and forces a real per-id role assertion to be added then.
    expect(OVERLAY_IDS.length, 'ANTI-VACUITY').toBe(16);
    let checked = 0;
    for (const id of OVERLAY_IDS) {
      const { root } = mountRootFor(id);
      const meta = OVERLAY_A11Y[id];
      const expectedLabel = (a11yCopy as Record<string, string>)[`a11y.overlay.${id}.title`];
      expect(typeof expectedLabel, `a11yCopy must resolve a title for ${id}`).toBe('string');

      openOverlayA11y(id, root);
      expect(root.getAttribute('role'), `role for ${id}`).toBe(meta.role);
      expect(root.getAttribute('aria-modal'), `aria-modal for ${id}`).toBe('true');
      expect(root.getAttribute('aria-label'), `aria-label for ${id}`).toBe(expectedLabel);

      closeOverlayA11y(id, null);
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: all 16 ids must have been exercised').toBe(16);
  });

  it('S1-ARIA-STRIPPED-ON-CLOSE BITES: role, aria-modal and aria-label are all removed on close — a display:none node must not keep claiming to be a dialog', () => {
    const { root } = mountRootFor('shopView');
    openOverlayA11y('shopView', root);
    expect(root.getAttribute('role'), 'sanity: role was set on open').not.toBeNull();

    closeOverlayA11y('shopView', null);
    expect(root.getAttribute('role'), 'role must be removed on close').toBeNull();
    expect(root.getAttribute('aria-modal'), 'aria-modal must be removed on close').toBeNull();
    expect(root.getAttribute('aria-label'), 'aria-label must be removed on close').toBeNull();
  });

  it('S1-TRAP-WIRED-ON-OPEN BITES: Tab wraps within the root while the overlay is open, and stops wrapping once it is closed', () => {
    // WRONG IMPL KILLED: openOverlayA11y that never calls installTrap(root) (Tab would never
    // wrap); or closeOverlayA11y that never calls the returned uninstall handle (Tab would keep
    // wrapping after close, trapping focus inside a display:none node forever).
    const { root } = mountRootFor('healView');
    const a = document.createElement('button');
    a.id = 'heal-a';
    const b = document.createElement('button');
    b.id = 'heal-b';
    root.append(a, b);

    openOverlayA11y('healView', root);
    b.focus();
    b.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(document.activeElement, 'the trap must be installed on open').toBe(a);

    closeOverlayA11y('healView', null);
    a.focus();
    a.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Tab', key: 'Tab', bubbles: true, cancelable: true }),
    );
    expect(
      document.activeElement,
      'after close the trap must be gone — a still-wired trap would move focus from a to b here',
    ).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// Return-focus map + idempotency (S1-RETURNFOCUS / S1-CLOSE)
// ---------------------------------------------------------------------------

describe('closeOverlayA11y — return-focus map, detached-target fallback, and no-op idempotency (S1-RETURNFOCUS / S1-CLOSE)', () => {
  it('S1-RETURNFOCUS-RESTORE BITES: closing restores focus to the element focused immediately before the overlay opened', () => {
    const opener = document.createElement('button');
    opener.id = 'world-opener';
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const { root } = mountRootFor('leaderboardView');
    openOverlayA11y('leaderboardView', root);
    closeOverlayA11y('leaderboardView', null);

    expect(
      document.activeElement,
      'WRONG IMPL KILLED: a leaky/mis-keyed return-focus map would restore the wrong element or none at all',
    ).toBe(opener);
  });

  it('S1-RETURNFOCUS-DETACHED-FALLBACK BITES: a detached returnFocus target falls back to the caller-supplied fallbackFocus, and with fallbackFocus=null there is no focus call at all', () => {
    // Half 1: returnFocus target is detached before close -> fallbackFocus is used.
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { root } = mountRootFor('pvpView');
    openOverlayA11y('pvpView', root);
    opener.remove(); // .isConnected === false by the time we close

    const fallback = document.createElement('button');
    document.body.appendChild(fallback);
    closeOverlayA11y('pvpView', fallback);
    expect(
      document.activeElement,
      'fallbackFocus must be used when the returnFocus target is detached',
    ).toBe(fallback);

    // Half 2: returnFocus ALSO detached, and fallbackFocus is null -> no focus call, no throw.
    // Red-team MEASURED that happy-dom blurs a removed focused element to <body>, exactly as a
    // real browser does, so this branch tests something real.
    const opener2 = document.createElement('button');
    document.body.appendChild(opener2);
    opener2.focus();

    const { root: root2 } = mountRootFor('claimView');
    openOverlayA11y('claimView', root2);
    opener2.remove();

    expect(() => closeOverlayA11y('claimView', null)).not.toThrow();
    expect(
      document.activeElement,
      'with no fallback and a detached returnFocus target there must be NO focus call at all — ' +
        'the natural browser blur to <body> is what worldHasFocus() already treats as world-focused',
    ).toBe(document.body);
  });

  it('S1-RETURNFOCUS-DOUBLE-OPEN BITES: re-opening the SAME id while focus is already inside it preserves the ORIGINAL pre-overlay return target', () => {
    // WRONG IMPL KILLED: a re-open that unconditionally re-records document.activeElement would
    // capture a focus target that is already INSIDE the overlay, and closing would then restore
    // focus to that inside-overlay element instead of the true pre-overlay one.
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { root, target } = mountRootFor('menuView');
    openOverlayA11y('menuView', root);
    target.focus(); // focus moves to something INSIDE the overlay
    expect(document.activeElement).toBe(target);

    openOverlayA11y('menuView', root); // re-open the SAME id
    closeOverlayA11y('menuView', null);

    expect(document.activeElement).toBe(opener);
  });

  it('S1-CLOSE-WITHOUT-OPEN-NOOP BITES: closing an id that was never opened neither throws nor moves focus', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    expect(() => closeOverlayA11y('helpView', null)).not.toThrow();
    expect(document.activeElement, 'a close-without-open must be a pure no-op').toBe(opener);
  });

  it('S1-CLOSE-DOUBLE-NOOP BITES: closing the same id twice in a row is a no-op the SECOND time — neither throws nor moves focus again', () => {
    // WRONG IMPL KILLED: a map entry not deleted on close would let a second close() re-run the
    // whole teardown (including a second focus restoration) against stale state.
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();

    const { root } = mountRootFor('tradeView');
    openOverlayA11y('tradeView', root);
    closeOverlayA11y('tradeView', null);
    expect(document.activeElement).toBe(opener);

    const decoy = document.createElement('button');
    document.body.appendChild(decoy);
    decoy.focus();

    expect(() => closeOverlayA11y('tradeView', null)).not.toThrow();
    expect(
      document.activeElement,
      'the second close must not move focus again — the record was already deleted by the first close',
    ).toBe(decoy);
  });
});

// ---------------------------------------------------------------------------
// TRIPWIRE — OVERLAY_A11Y role variance (RED-TEAM ROUND 2, UNTAGGED)
// ---------------------------------------------------------------------------

describe('OVERLAY_A11Y — role tripwire (deliberate trap door, not a regression guard)', () => {
  it('untagged: TRIPWIRE — every OVERLAY_A11Y role is currently "dialog"; this MUST red the day that stops being true', () => {
    // This is a DELIBERATE TRIPWIRE, not a real regression guard: it pins the current fact that
    // all sixteen OVERLAY_A11Y entries use role: 'dialog'. Because the manifest has zero variance
    // on this field today, S1-ARIA-ALL-16's 16-way parameterised role assertion cannot distinguish
    // `root.setAttribute('role', meta.role)` from a hardcoded `root.setAttribute('role',
    // 'dialog')` (red-team round 2, MEASURED — both keep S1-ARIA-ALL-16 green). There is no public
    // API to inject a synthetic role into OVERLAY_A11Y from a test, so this cannot be turned into
    // a real per-id assertion today.
    //
    // The day some overlay legitimately earns role: 'alertdialog' (per the A11yMeta doc comment,
    // "an id earns it only when its sole purpose is a blocking urgent message"), THIS test will
    // red — ON PURPOSE. Whoever lands that change must, in the SAME change, add a real per-id
    // assertion here (e.g. asserting the new alertdialog id's root gets role="alertdialog" while
    // a sibling dialog id's root does not) before updating or removing this tripwire. Until that
    // day, S1-ARIA-ALL-16's role check above stays a PARTIAL tooth for exactly this reason.
    const roles = new Set(OVERLAY_IDS.map((id) => OVERLAY_A11Y[id].role));
    expect(
      Array.from(roles).sort(),
      'TRIPWIRE: if this reds, an overlay now has a non-"dialog" role — add a real per-id role ' +
        'assertion above before touching this test',
    ).toEqual(['dialog']);
  });
});

// ---------------------------------------------------------------------------
// Live-region custody — adoption at open time (LRC-ADOPT, X1; rb-11, residual R-m23-s2-X5)
// ---------------------------------------------------------------------------
//
// SOURCE OF TRUTH FOR THIS BLOCK AND THE TWO BELOW: memory/projects/monster-realm-rb-11-plan.md
// (reviewer-lens amendments — the seam is `adoptLiveRegion(root): () => void`, a release CLOSURE
// mirroring `focusTrap.ts:136`'s `installTrap(root): () => void`, NOT an adopt/release pair);
// memory/projects/gates/rb-11.gates.md X1/X2/X3.
//
// RED REASON: `ui/overlayA11y.ts` does not yet call `adoptLiveRegion`/hold a `releaseLive` handle,
// and `ui/liveRegion.ts` does not yet export `adoptLiveRegion` at all. Every test below fails
// against the CURRENT tree — either the live region never moves at all (the `parentElement`/
// `lastElementChild` assertions fail outright), or, once a first cut of `adoptLiveRegion` lands,
// by whatever that cut gets wrong; see the "KILLS" note on each assertion for the specific wrong
// implementation (W1..W11, per the plan/ledger) it is aimed at.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the plan only.

describe('openOverlayA11y — live-region custody: adoption into the open root (LRC-ADOPT, X1)', () => {
  it('LRC-ADOPT BITES: opening each of the 16 overlays makes the SAME live-region node a direct LAST child of root, before the call returns — never a clone, never a second region', () => {
    expect(OVERLAY_IDS.length, 'ANTI-VACUITY').toBe(16);
    let checked = 0;
    for (const id of OVERLAY_IDS) {
      const node = mountLiveNode();
      expect(
        node,
        'sanity: the live-region fixture must exist before we assert on it',
      ).not.toBeNull();
      const { root } = mountRootFor(id);

      openOverlayA11y(id, root);

      expect(
        document.querySelectorAll(`#${LIVE_REGION_ID}`).length,
        `exactly one live-region node in the document for ${id} — KILLS W7 (a CLONE) and W8 (a ` +
          'MIRROR region)',
      ).toBe(1);
      expect(
        node.parentElement,
        `the node's parent must be THIS root for ${id} — KILLS W1 (no move) and W9 (aria-owns ` +
          'instead of a move)',
      ).toBe(root);
      expect(
        root.lastElementChild,
        `the node must be the LAST child of root for ${id} — KILLS W6 (prepend instead of ` +
          'appendChild; mountRootFor already appended a target child before open)',
      ).toBe(node);
      expect(
        document.getElementById(LIVE_REGION_ID),
        `getElementById must still resolve to the SAME node object for ${id} — KILLS W7 (a clone ` +
          'would be a distinct object even if it shared the id)',
      ).toBe(node);

      closeOverlayA11y(id, null);
      checked += 1;
    }
    expect(checked, 'ANTI-VACUITY: all 16 ids must have been exercised').toBe(16);
  });

  it('LRC-ADOPT-REOPEN-REHOMES BITES: re-opening the SAME id on a DIFFERENT root re-homes the live region into the new root — a re-open is not exempt from custody', () => {
    const node = mountLiveNode();
    const { root: rootA } = mountRootFor('boxView');
    const { root: rootB } = mountRootFor('boxView');

    openOverlayA11y('boxView', rootA);
    expect(node.parentElement, 'sanity: adopted into the first root').toBe(rootA);

    openOverlayA11y('boxView', rootB);

    expect(
      node.parentElement,
      'KILLS W5 (the adopt call placed inside the `previous === undefined` branch only): a ' +
        're-open on a DIFFERENT root must still re-home the live region — it must not stay ' +
        'stranded in the OLD root',
    ).toBe(rootB);

    closeOverlayA11y('boxView', null);
  });
});

// ---------------------------------------------------------------------------
// Live-region custody — ownership-scoped release at close time (LRC-RELEASE, X2)
// ---------------------------------------------------------------------------

describe('closeOverlayA11y — live-region custody: ownership-scoped release (LRC-RELEASE, X2)', () => {
  it('LRC-RELEASE-BODY BITES: closing an overlay whose root still holds the adopted live region restores it to document.body', () => {
    const node = mountLiveNode();
    const { root } = mountRootFor('boxView');
    openOverlayA11y('boxView', root);
    expect(node.parentElement, 'sanity: adopted into root at open').toBe(root);

    closeOverlayA11y('boxView', null);

    expect(
      node.parentElement,
      'KILLS W2 (move-never-restore): the node must be back under document.body once the ' +
        'overlay that holds it closes',
    ).toBe(document.body);
  });

  it("LRC-RELEASE-SCOPED BITES: closing overlay A after overlay B has since adopted the SAME live region leaves the node in B's root — an unconditional restore at close would yank it away", () => {
    const node = mountLiveNode();
    const { root: rootA } = mountRootFor('boxView');
    const { root: rootB } = mountRootFor('raisingView');

    openOverlayA11y('boxView', rootA);
    expect(node.parentElement, 'sanity: A has custody').toBe(rootA);

    openOverlayA11y('raisingView', rootB);
    expect(node.parentElement, 'sanity: B has since taken custody').toBe(rootB);

    closeOverlayA11y('boxView', null);

    expect(
      node.parentElement,
      "KILLS W3 (UNCONDITIONAL restore at close): A's close must NOT yank the node away from B, " +
        'which has since adopted it',
    ).toBe(rootB);

    closeOverlayA11y('raisingView', null);
    expect(node.parentElement, "B's own close restores it normally").toBe(document.body);
  });

  it('LRC-RELEASE-DETACHED-REATTACH BITES: if the live-region node is fully detached from the document before close, release reattaches the CAPTURED node reference to document.body — proving custody is held by closure, not re-resolved by id', () => {
    const node = mountLiveNode();
    const { root } = mountRootFor('healView');
    openOverlayA11y('healView', root);
    expect(node.parentElement, 'sanity: adopted into root').toBe(root);

    node.remove();
    expect(node.isConnected, 'sanity: fully detached from the document').toBe(false);

    closeOverlayA11y('healView', null);

    expect(
      document.body.contains(node),
      'KILLS W4 (restore re-resolved BY ID instead of the captured closure): once the node is ' +
        'detached, document.getElementById(LIVE_REGION_ID) returns null, so a by-id re-resolution ' +
        'at close would find nothing and silently no-op, leaving the node lost forever',
    ).toBe(true);
    expect(node.parentElement).toBe(document.body);
  });
});

// ---------------------------------------------------------------------------
// Live-region custody — no-op edges and no needless churn (LRC-EDGE, X3)
// ---------------------------------------------------------------------------

describe('openOverlayA11y/closeOverlayA11y — live-region custody: no-op edges and no churn (LRC-EDGE, X3)', () => {
  it('LRC-EDGE-CLOSE-WITHOUT-OPEN-NOOP BITES: closing an id that was never opened makes no DOM mutation to the live region at all', () => {
    const node = mountLiveNode();
    expect(node.parentElement, 'sanity: the region starts under document.body').toBe(document.body);

    closeOverlayA11y('shopView', null);

    expect(
      node.parentElement,
      'a close-without-open must not touch the live region — there is no record to release',
    ).toBe(document.body);
    expect(document.querySelectorAll(`#${LIVE_REGION_ID}`).length).toBe(1);
  });

  it('LRC-EDGE-DOUBLE-CLOSE-NOOP BITES: closing the same id a second time does not run releaseLive again — the record was already deleted by the first close', () => {
    const node = mountLiveNode();
    const { root } = mountRootFor('tradeView');
    openOverlayA11y('tradeView', root);
    closeOverlayA11y('tradeView', null);
    expect(node.parentElement, 'sanity: first close restored it').toBe(document.body);

    const decoyHost = document.createElement('div');
    document.body.appendChild(decoyHost);
    decoyHost.appendChild(node);

    closeOverlayA11y('tradeView', null);

    expect(
      node.parentElement,
      'the SECOND close must be a pure no-op for the live region too — a still-live releaseLive ' +
        'closure firing again would yank the node back to document.body a second time',
    ).toBe(decoyHost);
  });

  it('LRC-EDGE-NO-REGION-IN-DOCUMENT BITES: opening an overlay completes normally when no live-region node exists in the document at all', () => {
    const { root } = mountRootFor('menuView');

    expect(() => openOverlayA11y('menuView', root)).not.toThrow();
    expect(root.getAttribute('aria-modal'), 'the rest of openOverlayA11y must still run').toBe(
      'true',
    );
    expect(
      document.querySelectorAll(`#${LIVE_REGION_ID}`).length,
      'no region was conjured up',
    ).toBe(0);
    expect(() => closeOverlayA11y('menuView', null)).not.toThrow();
  });

  it('LRC-EDGE-NO-CHURN-SAME-ROOT BITES: re-opening the SAME id on the SAME root does not remove+re-insert the live region (sentinel-order proxy, R8)', () => {
    const node = mountLiveNode();
    const { root } = mountRootFor('claimView');

    openOverlayA11y('claimView', root);
    expect(root.lastElementChild, 'sanity: adopted as the last child').toBe(node);

    const sentinel = document.createElement('div');
    sentinel.id = 'churn-sentinel';
    root.appendChild(sentinel);

    openOverlayA11y('claimView', root);

    expect(
      root.lastElementChild,
      'KILLS W10 (the `parentElement !== root` churn guard dropped): a needless remove+re-append ' +
        'would move the live region past the sentinel — the region must stay exactly where it ' +
        'already was',
    ).toBe(sentinel);
    expect(node.parentElement, 'the region is still inside root, just no longer last').toBe(root);

    closeOverlayA11y('claimView', null);
  });
});
