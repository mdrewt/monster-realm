// @vitest-environment happy-dom
// ui/focusTrap.test.ts — m23-s1 RED gating tests for the Tab-only focus trap.
//
// SOURCE OF TRUTH: specs/monster-realm-v2/M23-accessibility.spec.md §2.2, §6 A11Y-6/A11Y-7;
//   memory/projects/monster-realm-m23-s1-plan.md (findings F1/F2, adjudication A5);
//   memory/projects/gates/m23-s1.gates.md X1/X2/X3.
//
// RED REASON: `client/src/ui/focusTrap.ts` DOES NOT EXIST YET. Every test below fails with
// "Failed to resolve import './focusTrap'" (module-not-found) until the implementer lands it.
//
// ENVIRONMENT: happy-dom — this file exercises real DOM focus/keydown dispatch (document.activeElement,
// capture-phase listeners, event propagation to `window`), which needs a DOM.
//
// Do NOT edit these tests to match a buggy implementation — correct them from the spec/plan only.
//
// WRONG-IMPL-KILLED index (see inline notes on the named tests for the full story):
//   - modular-arithmetic nextFocusTarget cheat            -> A11Y-6-ENTER-BACKWARD
//   - preventDefault-everything trap                       -> A11Y-7-NON-TAB-NOT-PREVENTED
//   - stopPropagation-everything trap                       -> A11Y-7-NON-TAB-REACHES-APP
//   - preventDefault-only, no focus move (root.contains bug avoided by IDENTITY assertions)
//   - bubble-phase trap (dead in renameView/tradeProposeView) -> S1-TRAP-CAPTURE
//   - cached focusable list (dead every battleView server tick) -> S1-TRAP-LIVE-QUERY
//   - no hidden-ancestor filter                             -> S1-TRAP-HIDDEN-FILTER
//   - no-op uninstall handle                                -> S1-TRAP-UNINSTALL
//
// RED-TEAM ROUND 2 (measured holes, closed below, all UNTAGGED additions):
//   - FOCUSABLE_SELECTOR narrowed to 'button:not([disabled])' — every fixture above used only
//     <button> elements, so this cheat kept all 42 tests green. See the new describe block
//     "installTrap — full focusable-type coverage" for the real-shape ring (button/input/
//     textarea/a/div[tabindex=0]) that a button-only selector cannot pass.
//   - '[tabindex]:not([tabindex="-1"])' widened to plain '[tabindex]' — no existing fixture ever
//     put a tabindex="-1" element inside a trapped root. See the new tabindex="-1"-exclusion test.
//   - installTrap's `e.key !== 'Tab'` guard does not exempt Ctrl/Alt/Meta+Tab (browser/OS chrome
//     shortcuts). See the new modified-Tab test — this one is a REAL fix and starts RED.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installTrap, nextFocusTarget } from './focusTrap';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function makeButtons(n: number): HTMLButtonElement[] {
  const out: HTMLButtonElement[] = [];
  for (let i = 0; i < n; i++) {
    const b = document.createElement('button');
    b.id = `btn-${i}`;
    b.textContent = `btn-${i}`;
    out.push(b);
  }
  return out;
}

function tabKeydown(shift = false): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    code: 'Tab',
    key: 'Tab',
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
}

function nonTabKeydown(): KeyboardEvent {
  return new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true, cancelable: true });
}

// ---------------------------------------------------------------------------
// nextFocusTarget — pure list arithmetic (A11Y-6)
// ---------------------------------------------------------------------------

describe('nextFocusTarget — pure list arithmetic (A11Y-6, spec §2.2)', () => {
  it('A11Y-6-WRAP-FORWARD BITES: from the last focusable with shift=false, returns the first', () => {
    const [a, b, c] = makeButtons(3);
    const list = [a, b, c];
    expect(nextFocusTarget(list, c, false)).toBe(a);
  });

  it('A11Y-6-WRAP-BACKWARD BITES: from the first focusable with shift=true, returns the last', () => {
    const [a, b, c] = makeButtons(3);
    const list = [a, b, c];
    expect(nextFocusTarget(list, a, true)).toBe(c);
  });

  it('A11Y-6-ENTER-FORWARD BITES: current not in the list, shift=false, returns the first (entering the trap)', () => {
    const [a, b, c] = makeButtons(3);
    const list = [a, b, c];
    const outsider = document.createElement('button'); // never part of `list`
    expect(nextFocusTarget(list, outsider, false)).toBe(a);
  });

  it('A11Y-6-ENTER-BACKWARD BITES: current not in the list, shift=true, returns the LAST — kills the modular-arithmetic cheat', () => {
    // WRONG IMPL KILLED: `focusables[((i-1)%len+len)%len]` with i=-1 (indexOf miss) computes
    // `((-1-1)%3+3)%3 === 1`, i.e. it returns `focusables[1]` (`b`) instead of the correct
    // `last` (`c`). That cheat ALSO passes A11Y-6-WRAP-FORWARD, A11Y-6-WRAP-BACKWARD and
    // A11Y-6-ENTER-FORWARD — this is the ONLY assertion that reds it (red-team Finding 7,
    // MEASURED, plan adjudication A5). A list of exactly 2 elements would make `b` and `c`
    // coincide by accident; 3 elements make index 1 (`b`) provably distinct from index 2 (`c`,
    // the true last).
    const [a, b, c] = makeButtons(3);
    const list = [a, b, c];
    const outsider = document.createElement('button');
    const result = nextFocusTarget(list, outsider, true);
    expect(result).toBe(c);
    expect(result).not.toBe(b); // the modular-arithmetic cheat's actual (wrong) answer
  });

  it('A11Y-6-EMPTY-LIST BITES: an empty focusables array returns null rather than throwing', () => {
    // noUncheckedIndexedAccess is OFF (client/tsconfig.json), so `focusables[0]` types as
    // HTMLElement while being runtime-undefined on an empty list — a naive impl throws or
    // returns `undefined` mistyped as HTMLElement. Both shift polarities must be null-safe.
    expect(nextFocusTarget([], null, false)).toBeNull();
    expect(nextFocusTarget([], null, true)).toBeNull();
    const outsider = document.createElement('button');
    expect(nextFocusTarget([], outsider, false)).toBeNull();
  });

  it('untagged: current in the middle of the list advances by one (forward) without wrapping', () => {
    const [a, b, c] = makeButtons(3);
    const list = [a, b, c];
    expect(nextFocusTarget(list, a, false)).toBe(b);
  });

  it('untagged: current in the middle of the list steps back by one (backward) without wrapping', () => {
    const [a, b, c] = makeButtons(3);
    const list = [a, b, c];
    expect(nextFocusTarget(list, c, true)).toBe(b);
  });

  it('untagged: a null current behaves the same as a not-in-list current (both polarities)', () => {
    const [a, b, c] = makeButtons(3);
    const list = [a, b, c];
    expect(nextFocusTarget(list, null, false)).toBe(a);
    expect(nextFocusTarget(list, null, true)).toBe(c);
  });
});

// ---------------------------------------------------------------------------
// installTrap — Tab-only key handling; must never swallow/hijack other keys (A11Y-7)
// ---------------------------------------------------------------------------

describe('installTrap — Tab-only handling, non-Tab keys pass through untouched (A11Y-7, spec §2.2)', () => {
  it('A11Y-7-NON-TAB-NOT-PREVENTED BITES: a non-Tab key dispatched into the trapped root is NOT preventDefault-ed', () => {
    // WRONG IMPL KILLED: a trap that calls e.preventDefault() unconditionally on every keydown
    // (not just Tab) would swallow every other key's native behaviour.
    document.body.innerHTML = '<div id="root"><button id="a">a</button></div>';
    const root = document.getElementById('root') as HTMLElement;
    const a = document.getElementById('a') as HTMLButtonElement;
    const uninstall = installTrap(root);

    const evt = nonTabKeydown();
    a.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(false);
    uninstall();
  });

  it('A11Y-7-NON-TAB-REACHES-APP BITES: a non-Tab key dispatched into the trapped root still reaches an app-level window listener', () => {
    // WRONG IMPL KILLED: a trap that calls e.stopPropagation() on every keydown (not just Tab)
    // would silently kill main.ts's window-level keydown handler (main.ts:1052) for every key
    // typed while an overlay is open — including the Escape ladder (main.ts:1300-1409).
    document.body.innerHTML = '<div id="root"><button id="a">a</button></div>';
    const root = document.getElementById('root') as HTMLElement;
    const a = document.getElementById('a') as HTMLButtonElement;
    const uninstall = installTrap(root);

    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    a.dispatchEvent(nonTabKeydown());
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', spy);
    uninstall();
  });

  it('A11Y-7-NO-STOP-PROPAGATION BITES: even a Tab keydown the trap DOES act on still reaches the window listener — the trap may preventDefault but must never stopPropagation', () => {
    // WRONG IMPL KILLED: a trap that stopPropagation()s the Tab keys it handles (passing the
    // NON-TAB-REACHES-APP test above, which only dispatches a non-Tab key) would still break
    // the window keydown handler for every Tab press. Both assertions are required together:
    // defaultPrevented alone would not catch a stopPropagation-only implementation, and the
    // spy alone would not catch a preventDefault-everything one (covered separately above).
    document.body.innerHTML =
      '<div id="root"><button id="a">a</button><button id="b">b</button></div>';
    const root = document.getElementById('root') as HTMLElement;
    const a = document.getElementById('a') as HTMLButtonElement;
    const uninstall = installTrap(root);

    const spy = vi.fn();
    window.addEventListener('keydown', spy);
    a.focus();
    const evt = tabKeydown(false);
    a.dispatchEvent(evt);
    expect(spy).toHaveBeenCalledTimes(1);
    // Sanity: this WAS a real trap move (Tab was handled), not a no-op — the trap legitimately
    // preventDefault-ed the native tab-order default, it just must not have stopped the event.
    expect(evt.defaultPrevented).toBe(true);
    window.removeEventListener('keydown', spy);
    uninstall();
  });
});

// ---------------------------------------------------------------------------
// installTrap — capture phase, live focusable query, hidden-ancestor filter, uninstall (S1-TRAP)
// ---------------------------------------------------------------------------

describe('installTrap — capture-phase registration, live re-query, hidden filtering, real uninstall (S1-TRAP)', () => {
  it('S1-TRAP-CAPTURE BITES: focus still moves even when the event TARGET stopPropagation()s its own bubble-phase keydown — a bubble-phase root trap is dead here', () => {
    // WRONG IMPL KILLED (F1, LOAD-BEARING): renameView.ts:61,80 and tradeProposeView.ts call
    // e.stopPropagation() on their own focusables' keydown. A trap registered on `root` with
    // capture:false (bubble phase) never sees a Tab pressed on such a child, because the
    // child's own bubble listener stops propagation before it reaches an ancestor bubble
    // listener. A CAPTURE-phase listener on `root`, by contrast, runs during the capturing
    // walk DOWN to the target — strictly before the target's own listener runs at all — so it
    // is unaffected by anything the target later does to the event.
    document.body.innerHTML =
      '<div id="root"><button id="a">a</button><button id="b">b</button></div>';
    const root = document.getElementById('root') as HTMLElement;
    const a = document.getElementById('a') as HTMLButtonElement;
    const b = document.getElementById('b') as HTMLButtonElement;
    // The child's OWN bubble-phase listener — exactly what renameView.ts's focusables do.
    b.addEventListener('keydown', (e) => {
      e.stopPropagation();
    });
    const uninstall = installTrap(root);

    a.focus();
    expect(document.activeElement).toBe(a);
    // Dispatch FROM the child that stopPropagations, not from `a`.
    b.dispatchEvent(tabKeydown(false));
    expect(document.activeElement, 'a bubble-phase trap would never see this Tab at all').toBe(b);
    uninstall();
  });

  it('S1-TRAP-LIVE-QUERY BITES: focus moves within a WHOLLY DIFFERENT focusable set swapped in after install — a cached-at-install-time list is dead here', () => {
    // WRONG IMPL KILLED: battleView.ts calls root.replaceChildren() on its skills/action
    // containers on every server tick (battleView.ts:241,:270). A trap that computed its
    // focusable list once at installTrap() time would keep trying to focus DETACHED elements
    // forever after the first replaceChildren().
    document.body.innerHTML =
      '<div id="root"><button id="a">a</button><button id="b">b</button></div>';
    const root = document.getElementById('root') as HTMLElement;
    const uninstall = installTrap(root);

    const a = document.getElementById('a') as HTMLButtonElement;
    a.focus();
    a.dispatchEvent(tabKeydown(false));
    expect(document.activeElement).toBe(document.getElementById('b'));

    // Swap in a wholly different focusable set — the elements from install-time no longer exist.
    root.replaceChildren();
    const c = document.createElement('button');
    c.id = 'c';
    const d = document.createElement('button');
    d.id = 'd';
    root.append(c, d);

    c.focus();
    expect(document.activeElement).toBe(c);
    c.dispatchEvent(tabKeydown(false));
    expect(
      document.activeElement,
      'the focusable set must be recomputed LIVE on this keydown',
    ).toBe(d);
    uninstall();
  });

  it('S1-TRAP-HIDDEN-FILTER BITES: a focusable behind a display:none ancestor and one with [hidden] are both skipped by the tab ring', () => {
    document.body.innerHTML = `
      <div id="root">
        <button id="v1">v1</button>
        <div style="display:none"><button id="hidden-ancestor">hiddenAncestor</button></div>
        <button id="hidden-attr" hidden>hiddenAttr</button>
        <button id="v2">v2</button>
      </div>
    `;
    const root = document.getElementById('root') as HTMLElement;
    const uninstall = installTrap(root);
    const v1 = document.getElementById('v1') as HTMLButtonElement;
    const v2 = document.getElementById('v2') as HTMLButtonElement;

    v1.focus();
    v1.dispatchEvent(tabKeydown(false));
    expect(
      document.activeElement,
      'WRONG IMPL KILLED: without the hidden-ancestor/attribute filter, focus would land on ' +
        'one of the hidden buttons instead of skipping straight to v2',
    ).toBe(v2);
    uninstall();
  });

  it('untagged: installTrap also handles Shift+Tab wrap-backward through the live keydown path', () => {
    document.body.innerHTML =
      '<div id="root"><button id="a">a</button><button id="b">b</button></div>';
    const root = document.getElementById('root') as HTMLElement;
    const uninstall = installTrap(root);
    const a = document.getElementById('a') as HTMLButtonElement;
    const b = document.getElementById('b') as HTMLButtonElement;

    a.focus();
    a.dispatchEvent(tabKeydown(true));
    expect(document.activeElement, 'Shift+Tab from the first focusable must wrap to the last').toBe(
      b,
    );
    uninstall();
  });

  it('S1-TRAP-UNINSTALL BITES: after uninstall(), Tab neither moves focus nor is preventDefault-ed', () => {
    // WRONG IMPL KILLED: a no-op uninstall handle — each re-open would stack another capture
    // listener on the same root (A12 in the plan, the shared-#app-root duplicate-trap risk).
    document.body.innerHTML =
      '<div id="root"><button id="a">a</button><button id="b">b</button></div>';
    const root = document.getElementById('root') as HTMLElement;
    const uninstall = installTrap(root);
    uninstall();

    const a = document.getElementById('a') as HTMLButtonElement;
    a.focus();
    expect(document.activeElement).toBe(a);

    const evt = tabKeydown(false);
    a.dispatchEvent(evt);
    expect(document.activeElement, 'focus must be unchanged after uninstall').toBe(a);
    expect(
      evt.defaultPrevented,
      'the native Tab default must not be prevented after uninstall',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// installTrap — full focusable-type coverage (RED-TEAM ROUND 2, all UNTAGGED)
//
// Every fixture above uses ONLY <button> elements. A red-team pass measured that narrowing
// FOCUSABLE_SELECTOR to the single clause 'button:not([disabled])' keeps every test in this
// file (and all 42 tests across the m23-s1 suite) green — a severe production regression,
// because ui/renameView.ts:45's #rename-input and ui/tradeProposeView.ts:67,71,176's currency
// <input>s and per-monster checkboxes are real focusables inside exactly the two overlays the
// module header calls the highest-risk case for this trap. The tests below build a ring with
// every element kind FOCUSABLE_SELECTOR's real clauses admit, plus the ones its OTHER real
// clauses ('[type="hidden"]' exclusion, ':not([disabled])') and the tabindex="-1" carve-out
// must skip.
// ---------------------------------------------------------------------------

describe('installTrap — full focusable-type coverage (FOCUSABLE_SELECTOR regression guards)', () => {
  it('untagged: a ring of button/input[text]/textarea/a[href]/div[tabindex=0]/button is visited IN ORDER and wraps, skipping a hidden input and disabled controls', () => {
    // WRONG IMPL KILLED: FOCUSABLE_SELECTOR narrowed to 'button:not([disabled])' — every
    // element below except t1/t6 would be silently invisible to the tab ring, and Tab from t1
    // would jump straight to t6 instead of walking t2..t5 first.
    document.body.innerHTML = `
      <div id="root">
        <button id="t1">t1</button>
        <input id="skip-hidden" type="hidden" />
        <input id="t2" type="text" />
        <button id="skip-disabled-btn" disabled>skip</button>
        <textarea id="t3"></textarea>
        <input id="skip-disabled-input" disabled />
        <a id="t4" href="#">link</a>
        <div id="t5" tabindex="0">div</div>
        <button id="t6">t6</button>
      </div>
    `;
    const root = document.getElementById('root') as HTMLElement;
    const uninstall = installTrap(root);
    const t1 = document.getElementById('t1') as HTMLButtonElement;
    const t2 = document.getElementById('t2') as HTMLInputElement;
    const t3 = document.getElementById('t3') as HTMLTextAreaElement;
    const t4 = document.getElementById('t4') as HTMLAnchorElement;
    const t5 = document.getElementById('t5') as HTMLDivElement;
    const t6 = document.getElementById('t6') as HTMLButtonElement;

    t1.focus();
    t1.dispatchEvent(tabKeydown(false));
    expect(document.activeElement, 'button -> input[text]').toBe(t2);

    t2.dispatchEvent(tabKeydown(false));
    expect(document.activeElement, 'input[text] -> textarea').toBe(t3);

    t3.dispatchEvent(tabKeydown(false));
    expect(document.activeElement, 'textarea -> a[href]').toBe(t4);

    t4.dispatchEvent(tabKeydown(false));
    expect(document.activeElement, 'a[href] -> div[tabindex=0]').toBe(t5);

    t5.dispatchEvent(tabKeydown(false));
    expect(document.activeElement, 'div[tabindex=0] -> button').toBe(t6);

    t6.dispatchEvent(tabKeydown(false));
    expect(document.activeElement, 'wraps from the last back to the first').toBe(t1);

    uninstall();
  });

  it('untagged: an element with tabindex="-1" is never reached by Tab, even though .focus() on it directly still works', () => {
    // WRONG IMPL KILLED: '[tabindex]:not([tabindex="-1"])' widened to plain '[tabindex]' — no
    // fixture anywhere else in this suite puts a tabindex="-1" element inside a trapped root.
    // This is the ARIA APG dialog pattern (module header, ':36-40') and ten of the sixteen
    // overlays rely on it via openOverlayA11y's initialFocusSelector: the anchor must be
    // programmatically focusable but excluded from the Tab ring.
    document.body.innerHTML =
      '<div id="root"><button id="a">a</button>' +
      '<div id="mid" tabindex="-1">mid</div>' +
      '<button id="b">b</button></div>';
    const root = document.getElementById('root') as HTMLElement;
    const uninstall = installTrap(root);
    const a = document.getElementById('a') as HTMLButtonElement;
    const mid = document.getElementById('mid') as HTMLDivElement;
    const b = document.getElementById('b') as HTMLButtonElement;

    a.focus();
    a.dispatchEvent(tabKeydown(false));
    expect(document.activeElement, 'Tab must skip the tabindex="-1" element entirely').toBe(b);

    b.dispatchEvent(tabKeydown(false));
    expect(document.activeElement, 'wraps back to a, still skipping mid').toBe(a);

    // The APG pattern: programmatic .focus() must still work even though Tab never lands here.
    mid.focus();
    expect(
      document.activeElement,
      'a tabindex="-1" element must still be focusable by a direct .focus() call',
    ).toBe(mid);

    uninstall();
  });

  it('untagged: Ctrl+Tab and Meta+Tab are never trapped (browser/OS chrome shortcuts), but Shift+Tab still is', () => {
    // REAL FIX, STARTS RED: installTrap's keydown handler currently checks only
    // `e.key !== 'Tab'` and does not exempt a modified Tab press. Ctrl+Tab (switch browser tab)
    // and Meta+Tab (OS app switcher) must reach the browser/OS untouched — preventDefault-ing
    // or moving focus on them breaks a keyboard user's ability to leave the tab entirely while
    // an overlay is open. This assertion is expected to FAIL against the current implementation.
    document.body.innerHTML =
      '<div id="root"><button id="a">a</button><button id="b">b</button></div>';
    const root = document.getElementById('root') as HTMLElement;
    const uninstall = installTrap(root);
    const a = document.getElementById('a') as HTMLButtonElement;
    const b = document.getElementById('b') as HTMLButtonElement;

    a.focus();
    const ctrlTab = new KeyboardEvent('keydown', {
      code: 'Tab',
      key: 'Tab',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    a.dispatchEvent(ctrlTab);
    expect(ctrlTab.defaultPrevented, 'Ctrl+Tab must not be preventDefault-ed').toBe(false);
    expect(document.activeElement, 'Ctrl+Tab must not move focus').toBe(a);

    const metaTab = new KeyboardEvent('keydown', {
      code: 'Tab',
      key: 'Tab',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    a.dispatchEvent(metaTab);
    expect(metaTab.defaultPrevented, 'Meta+Tab must not be preventDefault-ed').toBe(false);
    expect(document.activeElement, 'Meta+Tab must not move focus').toBe(a);

    // Shift+Tab (no modifier keys other than shift) must of course still be trapped — the fix
    // above must not be over-applied to swallow the real dialog case too.
    const shiftTab = tabKeydown(true);
    a.dispatchEvent(shiftTab);
    expect(shiftTab.defaultPrevented, 'plain Shift+Tab must still be trapped').toBe(true);
    expect(document.activeElement, 'plain Shift+Tab must still wrap focus to b').toBe(b);

    uninstall();
  });
});
