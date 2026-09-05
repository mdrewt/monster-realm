// ui/focusTrap.ts — the Tab-only focus trap for the 16 mutual-exclusion overlays (m23-s1, M23 §2.2).
//
// Two halves on purpose: `nextFocusTarget` is the PURE list arithmetic (no DOM reads, no events,
// node-testable) and `installTrap` is the thin DOM shell around it. `FOCUSABLE_SELECTOR` and the
// hidden-ancestor filter stay module-PRIVATE — this module family bans an export with zero
// consumers (the A7/A15 rule, ui/overlayRegistry.ts:24-30).
//
// WHY THE CAPTURE PHASE, AND IT IS LOAD-BEARING, NOT STYLE. `ui/renameView.ts:62` and
// `ui/renameView.ts:81` call `e.stopPropagation()` on the keydown of `#rename-input` and
// `#rename-submit` (the D3 input-hygiene contract), and `ui/tradeProposeView.ts` does the same for
// every one of its focusables. A listener registered on `root` with `capture:false` runs in the
// BUBBLE phase, i.e. strictly after the target's own listeners — so in exactly the two overlays
// that own real text input, a bubble-phase trap is 100% dead. A capture-phase listener runs during
// the capturing walk DOWN to the target, before the target's own handler exists as far as the event
// is concerned, so nothing the target later does to the event can shadow it.
//
// WHY THE FOCUSABLE SET IS RE-QUERIED ON EVERY KEYDOWN. `ui/battleView.ts:241` and
// `ui/battleView.ts:270` call `replaceChildren()` on the skills and actions containers on every
// server tick. A list computed once at `installTrap()` time would be pointing at DETACHED nodes
// within one frame and would keep trying to focus them forever. The re-query is O(children) once
// per Tab press — a keystroke, not a frame — so it is free.
//
// WHY WE NEVER `stopPropagation()`, EVEN ON THE TAB WE HANDLE. `client/src/main.ts:1052` installs
// the app's window keydown ladder (the session gate, the Escape ladder, F8/F9). Swallowing the
// event at the overlay root would silently kill all of it while any overlay is open. We
// `preventDefault()` on Tab / Shift+Tab and ONLY when focus actually moved; the event still reaches
// `window`.
//
// WHAT THE KEY FILTER HANDLES, AND WHAT IT DELIBERATELY DOES NOT. Exactly two presses are trapped:
// plain Tab and plain Shift+Tab. A Tab carrying Ctrl, Alt or Meta is browser/OS chrome — Ctrl+Tab
// switches browser tab, Meta+Tab is the OS app switcher — and is passed through untouched, neither
// `preventDefault`-ed nor focus-moved, so a keyboard user is never stranded inside the overlay with
// no way to leave the page. Shift is the trap's OWN modifier and is therefore NOT exempt. Every
// non-Tab key is ignored outright: not prevented, not stopped, not inspected further. Arrow-key
// roving, Home/End and type-ahead are NOT implemented — no overlay here is a composite widget, and
// a behaviour with no consumer is the A7/A15 rule's dead surface in event-handler form.
//
// TAB IS DETECTED VIA `e.key`, NOT `e.code`, AND THAT DIVERGES FROM THE HOUSE CONVENTION ON PURPOSE.
// `client/src/main.ts`'s hotkey ladder reads `e.code` almost everywhere, correctly: a movement or
// letter binding means a POSITIONAL key ("wherever QWERTY puts W"), which must survive a layout
// change. Tab is the opposite case — it is not a printable character, so `e.key === 'Tab'` is
// layout- and remap-stable, and it is the standard idiom for a focus trap. Do not "fix" this to
// `e.code`.
//
// WHAT THE VISIBILITY FILTER DELIBERATELY DOES NOT DO. Only an inline `display:none` or a `[hidden]`
// ancestor (walked up to and INCLUDING `root`) is filtered — this codebase hides overlays and their
// sub-sections with inline `style.display = 'none'` (ui/renameView.ts:106), so that is the real
// shape. `visibility`, `opacity`, `offsetParent`, `getClientRects()` and `inert` are NOT consulted:
// happy-dom has no layout engine, so every one of them would be unverifiable dead code sitting
// inside a 96%-line-coverage denominator.
//
// THE `tabindex="-1"` ANCHORS ARE OUTSIDE THE RING ON PURPOSE. The `initialFocusSelector` of ten of
// the seventeen overlays (ui/overlayRegistry.ts OVERLAY_A11Y) is a heading, list or status line that
// S2/S4 give `tabindex="-1"`. `[tabindex]:not([tabindex="-1"])` excludes them from the tab ring
// while `ui/overlayA11y.ts` still focuses them programmatically on open — the ARIA APG dialog
// pattern: the dialog's name is announced on open, but Tab never lands back on the heading.
//
// CROSS-SLICE CONTRACT S1 CANNOT ENFORCE (plan adjudication A12): `battleView`, `boxView`,
// `raisingView` and `evolutionView` all mount into the SAME `#app` node. `ui/overlayA11y.ts` keys
// its record by `OverlayId`, not by root, so an S4 wiring that opens the next id BEFORE closing the
// previous one installs TWO capture listeners on ONE node and Tab moves twice per press. S4 must
// close-before-open.

/** The tabbable set. `[tabindex="-1"]` is excluded on purpose — see the module header. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/** True if `el` or any ancestor up to and including `root` is `[hidden]` or inline `display:none`. */
function isHidden(el: HTMLElement, root: HTMLElement): boolean {
  let node: HTMLElement | null = el;
  while (node !== null) {
    if (node.hasAttribute('hidden')) return true;
    if (node.style.display === 'none') return true;
    if (node === root) return false;
    node = node.parentElement;
  }
  return false;
}

/** The LIVE tab ring inside `root`, in document order. Recomputed on every keydown (header). */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
    if (!isHidden(el, root)) out.push(el);
  }
  return out;
}

/**
 * Where Tab (`shift=false`) or Shift+Tab (`shift=true`) should send focus next, wrapping at both
 * ends (A11Y-6). Returns `null` ONLY for an empty ring.
 *
 * `noUncheckedIndexedAccess` is OFF (client/tsconfig.json), so `focusables[0]` types as
 * `HTMLElement` while being runtime-`undefined` on an empty list — hence the explicit length guard
 * rather than trusting the types.
 *
 * A `current` that is not in the ring (`null`, `<body>`, or a node outside `root`) means we are
 * ENTERING the trap, and it branches EXPLICITLY to `shift ? last : first`. The tempting single
 * formula `focusables[((i - 1) % len + len) % len]` is WRONG here: with `i === -1` it computes
 * index 1, i.e. the SECOND element instead of the last (plan adjudication A5, measured).
 */
export function nextFocusTarget(
  focusables: readonly HTMLElement[],
  current: Element | null,
  shift: boolean,
): HTMLElement | null {
  const len = focusables.length;
  if (len === 0) return null;
  const first = focusables[0];
  const last = focusables[len - 1];
  // Widened to `readonly Element[]` (sound — a readonly array is covariant) purely so a
  // `current` typed as `Element | null` can be searched by IDENTITY without a cast.
  const i = current === null ? -1 : (focusables as readonly Element[]).indexOf(current);
  if (i === -1) return shift ? last : first;
  if (shift) return i === 0 ? last : focusables[i - 1];
  return i === len - 1 ? first : focusables[i + 1];
}

/**
 * Confine Tab / Shift+Tab to the focusables inside `root` for as long as the returned uninstall
 * handle has not been called. Registered in the CAPTURE phase (header). Handles plain Tab and plain
 * Shift+Tab and nothing else: any other key — and any Tab carrying Ctrl/Alt/Meta, which is browser
 * or OS chrome — is untouched, not prevented, not stopped, not inspected further.
 *
 * The "current" element is read from `document.activeElement`, not from `e.target`: the focused
 * element is what a Tab actually moves FROM, and a synthetic event can be dispatched at a node that
 * does not hold focus.
 */
export function installTrap(root: HTMLElement): () => void {
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== 'Tab') return;
    // A MODIFIED Tab belongs to the browser or the OS, never to the dialog: Ctrl+Tab switches
    // browser tab and Meta+Tab is the app switcher. Trapping either would leave a keyboard user
    // with no way out of the page. Shift is the trap's own modifier, so it is deliberately absent.
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const target = nextFocusTarget(focusablesIn(root), document.activeElement, e.shiftKey);
    if (target === null) return;
    // Only once focus really moves — a preventDefault on an empty ring would swallow the native
    // Tab for nothing. NEVER stopPropagation: main.ts:1052's ladder must keep seeing this key.
    e.preventDefault();
    target.focus();
  };
  root.addEventListener('keydown', onKeydown, true);
  return () => {
    root.removeEventListener('keydown', onKeydown, true);
  };
}
