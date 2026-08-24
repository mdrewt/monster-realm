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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { a11yCopy } from './a11yCopy';
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
