// @vitest-environment happy-dom
// ui/errorOverlayView.test.ts — RED gating tests for pt-b1 EARS U-4 (XSS), S-3, M-2 (total render).
//
// Slice: pt-b1 · Source-of-truth: M-playtest-b error overlay DOM shell.
//
// This view is NOT coverage-excluded (like leaderboardView), so these tests must reach
// every branch: self-mount, show/hide/dismiss/toggle, both render paths, the total-render
// try/catch, and the non-blocking pointer-events contract.
//
// RED REASON: errorOverlayView.ts does not exist yet. Every test fails with
//   "Failed to resolve import './errorOverlayView'" (module-not-found).
//
// WRONG-IMPL-KILLED list:
//   - "ctor depends on a pre-existing element (getElementById)"  → T-VIEW-1 catches it
//   - "visible=true at construction / no-op show/hide/toggle"    → T-VIEW-2 catches it
//   - "innerHTML=message (XSS hole)"                             → T-VIEW-3 catches it
//   - "render appends instead of replaceChildren"                → T-VIEW-4 catches it
//   - "root blocks pointer events (no pointer-events:none)"      → T-VIEW-5 catches it
//   - "render throws on a malformed VM"                          → T-VIEW-TOTAL catches it
//
// Do NOT edit tests to match a buggy impl — correct from the spec only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErrorOverlayViewModel } from './errorOverlayModel';
import { ErrorOverlayView } from './errorOverlayView';

const ROOT_ID = 'mr-error-overlay';

function resetDom(): void {
  // Full teardown between tests: the view self-mounts a unique-id root, so we clear body.
  document.body.replaceChildren();
}

function vm(
  rows: Array<{ message: string; tMs: number; source: string }>,
  hiddenCount = 0,
): ErrorOverlayViewModel {
  return { rows, hiddenCount, isEmpty: rows.length === 0, total: rows.length + hiddenCount };
}

beforeEach(() => {
  resetDom();
});

afterEach(() => {
  resetDom();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// T-VIEW-1: self-mount — creates its own root without a pre-existing element.
// ---------------------------------------------------------------------------

describe('errorOverlayView T-VIEW-1: self-mount', () => {
  it('T-VIEW-1 BITES: ctor creates #mr-error-overlay WITHOUT any pre-existing element', () => {
    // WRONG IMPL KILLED: a leaderboardView-style ctor that calls document.getElementById and
    // throws when the element is absent. Here the DOM is EMPTY — the view must CREATE + append
    // its own root. Proves self-mount, not getElementById-dependency.
    expect(document.getElementById(ROOT_ID)).toBeNull(); // nothing pre-mounted
    const view = new ErrorOverlayView();
    expect(view.rootId).toBe(ROOT_ID);
    const root = document.getElementById(ROOT_ID);
    expect(root).not.toBeNull();
    // Root is appended into document.body by default.
    expect(document.body.contains(root)).toBe(true);
  });

  it('T-VIEW-1-MOUNT-ARG: a provided mount element receives the root', () => {
    // WRONG IMPL KILLED: a ctor that ignores its mount arg and always uses document.body.
    const host = document.createElement('div');
    host.id = 'custom-host';
    document.body.appendChild(host);
    const view = new ErrorOverlayView(host);
    const root = document.getElementById(view.rootId)!;
    expect(host.contains(root)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-VIEW-2: visibility lifecycle. dismiss === hide.
// ---------------------------------------------------------------------------

describe('errorOverlayView T-VIEW-2: show/hide/dismiss/toggle flip visible', () => {
  it('T-VIEW-2 BITES: starts hidden; show/hide/dismiss/toggle flip visible correctly', () => {
    // WRONG IMPL KILLED: visible=true at construction; a no-op show/hide; a toggle that only
    // ever shows or only ever hides; a dismiss that is not hide.
    const view = new ErrorOverlayView();
    expect(view.visible).toBe(false); // starts hidden

    view.show();
    expect(view.visible).toBe(true);

    view.hide();
    expect(view.visible).toBe(false);

    view.toggle(); // false -> true
    expect(view.visible).toBe(true);
    view.toggle(); // true -> false
    expect(view.visible).toBe(false);

    view.show();
    view.dismiss(); // dismiss === hide
    expect(view.visible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-VIEW-3 (U-4 XSS): message rendered as literal text, never as elements.
// ---------------------------------------------------------------------------

describe('errorOverlayView T-VIEW-3 (U-4): XSS tooth', () => {
  it('T-VIEW-3 BITES: <img onerror>/<script> in a message inject NO elements; literal text present', () => {
    // WRONG IMPL KILLED: an impl that uses el.innerHTML = row.message. Error messages can echo
    // server/user strings; they must be textContent-only. Mirrors leaderboardView XSS tooth.
    const malicious = '<img src=x onerror=alert(1)><script>bad()</script>';
    const view = new ErrorOverlayView();
    view.render(vm([{ message: malicious, tMs: 100, source: 'reducer' }]));

    const root = document.getElementById(ROOT_ID)!;
    // No injected elements anywhere under the root.
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    // The raw string appears as literal text (textContent, not parsed markup).
    expect(root.textContent).toContain(malicious);
  });
});

// ---------------------------------------------------------------------------
// T-VIEW-4: render replaces (replaceChildren), does not append.
// ---------------------------------------------------------------------------

describe('errorOverlayView T-VIEW-4: render replaces, not appends', () => {
  it('T-VIEW-4 BITES: 2-row render then 1-row re-render -> latest rows only (replace, not append)', () => {
    // WRONG IMPL KILLED: a render() that appends each call — after two renders (2 then 1) an
    // append impl leaves BOTH the old rows and the new one. replaceChildren keeps exactly the
    // latest render's rows. We bite via (a) message text presence/absence and (b) the total
    // descendant element count NOT growing — robust to whatever tag the impl uses per row
    // (no fragile per-row attribute contract).
    const view = new ErrorOverlayView();
    view.render(
      vm([
        { message: 'first', tMs: 10, source: 'uncaught' },
        { message: 'second', tMs: 20, source: 'reducer' },
      ]),
    );
    const root = document.getElementById(ROOT_ID)!;
    expect(root.textContent).toContain('first');
    expect(root.textContent).toContain('second');
    const elementsAfterTwo = root.querySelectorAll('*').length;

    view.render(vm([{ message: 'third', tMs: 30, source: 'reducer' }]));
    expect(root.textContent).toContain('third');
    // The prior render's rows are GONE (replaced, not appended) — the load-bearing bite.
    expect(root.textContent).not.toContain('first');
    expect(root.textContent).not.toContain('second');
    // And the DOM did not accumulate: fewer rows -> not more descendant elements than before.
    const elementsAfterOne = root.querySelectorAll('*').length;
    expect(elementsAfterOne).toBeLessThanOrEqual(elementsAfterTwo);
  });
});

// ---------------------------------------------------------------------------
// T-VIEW-5: non-blocking — root sets pointer-events:none.
// ---------------------------------------------------------------------------

describe('errorOverlayView T-VIEW-5: non-blocking overlay', () => {
  it('T-VIEW-5 BITES: root has pointer-events:none (documented non-blocking contract)', () => {
    // WRONG IMPL KILLED: a root that captures pointer events over the game canvas — the
    // diagnostic overlay must never block gameplay input. Assert the inline style.
    new ErrorOverlayView();
    const root = document.getElementById(ROOT_ID)!;
    expect(root.style.pointerEvents).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// T-VIEW-TOTAL (red-team M-2): render is total — swallows a malformed VM.
// ---------------------------------------------------------------------------

describe('errorOverlayView T-VIEW-TOTAL (M-2): render never throws to caller', () => {
  it('T-VIEW-TOTAL BITES: a VM whose rows getter throws does NOT throw out of render (console.error)', () => {
    // WRONG IMPL KILLED: a render() without an internal try/catch — a hostile/malformed VM
    // (rows getter throws) would propagate and crash the animation frame that calls render.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const view = new ErrorOverlayView();

    const hostile = {} as ErrorOverlayViewModel;
    Object.defineProperty(hostile, 'rows', {
      get() {
        throw new Error('boom rows getter');
      },
    });

    expect(() => view.render(hostile)).not.toThrow();
    // The swallow routes to console.error (observability), not a silent no-op only.
    expect(errorSpy).toHaveBeenCalled();
  });
});
