// ui/overlayA11y.ts — open/close ARIA + focus choreography for the registry overlays
// (M23 §2.1-§2.3).
//
// The composition shell of this slice: it is the only module here that writes attributes, schedules
// a timer, moves focus or holds state. `ui/overlayRegistry.ts` supplies the metadata (role,
// labelKey, initialFocusSelector), `ui/a11yCopy.ts` resolves the name, `ui/focusTrap.ts` supplies
// the trap. Nothing is decided here that a data table could decide.
//
// WHY THE INITIAL FOCUS IS DEFERRED ONE MACROTASK, AND IT IS LOAD-BEARING. `ui/renameView.ts:102`
// (its rationale comment at `:101`) already fixes the bug: an overlay opened by a letter hotkey
// (`KeyN`) is opened DURING that keydown, so focusing the input synchronously lands the `n` in the
// field the player just
// opened. `setTimeout(..., 0)` lets the opening key event fully complete first. This module is the
// SOLE owner of that defer — S3 deletes the per-view copies at `ui/renameView.ts:102` and
// `ui/tradeProposeView.ts:124` and the behaviour must be identical.
//
// The scheduler stays a REAL `setTimeout` rather than an injected one: injecting it would add a
// parameter all seventeen S3/S4 call sites must fill, for a seam only the tests want. The defer is
// pinned by both polarities instead — synchronously after `openOverlayA11y` the target is NOT
// focused; after a real macrotask boundary it IS.
//
// KNOWN AND ACCEPTED, NOT DESIGNED AWAY (plan adjudication A8): in the window between
// `openOverlayA11y` returning and the deferred focus firing, `document.activeElement` is still
// OUTSIDE `root`, so the capture listener on `root` correctly never fires and a Tab pressed in that
// one macrotask is not trapped. It self-heals on the next tick, and the defer is worth more than
// the gap.
//
// ONE RECORD PER ID, HOLDING `root` ITSELF (plan adjudication A2). `closeOverlayA11y` takes NO
// `root` parameter: a caller passing a DIFFERENT node at close would strip ARIA off the wrong
// element while the original trap leaked, and nothing could catch it. Storing the node the overlay
// was opened WITH deletes that whole bug class. Everything a close needs — root, return target,
// pending timer, uninstall handle — lives in ONE record, so there is no half-open state to reason
// about, and `Map.delete` is the single teardown.
//
// THE RECORDS ARE A STACK (ctl-5, CTL5.6). Map insertion order is the open order and the last record
// is the top frame. Opening over an open overlay suspends the one beneath (focus leaves it, then
// `inert` + `aria-hidden`, trap removed, pending focus cleared); closing the top resumes the next
// one down (attributes first, then trap, live region and focus on its nav anchor). Closing a covered
// record moves no focus and hands its return target up, so a base-first multi-level pop restores
// focus once. Re-opening a covered id is a no-op.
//
// A RE-OPEN PRESERVES THE ORIGINAL RETURN TARGET. By the second `openOverlayA11y(id, root)`, focus
// is typically already INSIDE the overlay; re-recording `document.activeElement` would make the
// eventual close restore focus to an element inside the thing it just closed. So a re-open of the top
// record tears the old record down fully (timer cleared, trap uninstalled — no stacked listeners) but carries
// the first `returnFocus` forward.
//
// CLOSE-WITHOUT-OPEN AND DOUBLE-CLOSE ARE DOCUMENTED NO-OPS. With no record there is no root, so we
// never set the attributes and there is nothing to strip, no trap to remove and no focus to move.
// This is A11Y-34's idempotency edge, and it is what makes calling the PRODUCTION close a legal
// test-isolation device (no reset hook is exported — a zero-consumer export is banned by this
// family's A7/A15 rule, ui/overlayRegistry.ts:24-30).
//
// NO try/catch AROUND THE FOCUS/RESTORE PATHS — the `anyVisible` precedent at
// ui/overlayRegistry.ts:358-362: swallowing makes a breach look like working code. A focus that
// throws is a bug we want loud.
//
// THREE CROSS-SLICE CONTRACTS S1 CANNOT ENFORCE — (a) is settled; S4 pinned the box/battle half:
//   (a) A12 — RETRACTED: the four `#app`-mounted views do NOT "share ONE root". Each creates its
//       OWN root under the shared mount, so FOUR `OverlayId`s key FOUR records that never collide;
//       S4 must NOT close-before-open (`S4-CROSS-VIEW-DISTINCT-ROOTS`, boxView.test.ts).
//   (b) A13 — if S5's `refreshBattle` force-hide path sets `style.display = 'none'` directly
//       instead of routing through the view's `hide()` (and thus this close), the record survives
//       with a live listener, a pending timer and a return target that expires — a much later close
//       then restores focus to a long-dead element. Recommend §4.1 add force-hide ↔ close to its
//       cross-slice contract list. Since live-region custody moved here, that bypass
//       now ALSO strands `#a11y-live` inside the `display:none` subtree, because custody is handed
//       back by `releaseLive` and nothing else — so the consequence is no longer a stale listener
//       but TOTAL SILENCE for every announcement until that overlay is opened and closed properly.
//       Not reachable today (`main.ts`'s `overlayHandles` table routes every force-hide through
//       `hide()`), and this comment is the record of why it must stay that way.
//   (c) The "no focus call at all" branch of `closeOverlayA11y` leaves focus wherever the browser's
//       natural blur put it, i.e. `<body>`. M23 §2.3 PROPOSES a `worldHasFocus()` predicate to read
//       that state as "the world has focus" — it is S5's to write and does NOT exist in this
//       codebase today (grep-verified at S1). Named here so the forward reference is not mistaken
//       for a claim about existing code.

import { t } from './a11yCopy';
import { installTrap } from './focusTrap';
import { adoptLiveRegion } from './liveRegion';
import { OVERLAY_A11Y, type OverlayId } from './overlayRegistry';

/** Everything a close needs, captured at open time. One per open overlay; see the module header.
 *  The three mutable fields change while the record sits under another frame (ctl-5 stacking). */
interface OpenRecord {
  /** The node the overlay was opened WITH — never re-supplied by the caller at close (A2). */
  readonly root: HTMLElement;
  /** Where focus was immediately BEFORE the first open of this id; preserved across a re-open, and
   *  replaced by a closed lower frame's own target when it pointed into that frame. */
  returnFocus: HTMLElement | null;
  /** The pending deferred-focus macrotask, cleared on close so it cannot steal focus afterwards. */
  readonly timer: ReturnType<typeof setTimeout>;
  /** The focus trap's uninstall handle (ui/focusTrap.ts); null while suspended under another. */
  uninstall: (() => void) | null;
  /** The live region's custody handle (ui/liveRegion.ts) — same shape and lifecycle as
   *  `uninstall`. Never `null`: with no live region in the document `adoptLiveRegion` returns a
   *  no-op, so there is no branch here. */
  releaseLive: () => void;
}

// Insertion order is the stack order (ctl-5): the last record is the top frame, every other one
// is suspended beneath it — `inert`, `aria-hidden`, no trap, no pending focus. A re-open of the
// top id keeps its place; a re-open of a covered id is a no-op.
const OPEN_OVERLAYS = new Map<OverlayId, OpenRecord>();

const topRecord = (): OpenRecord | undefined => [...OPEN_OVERLAYS.values()].at(-1);

/** `el` is a connected element inside `root` (`root` included). */
const connectedInside = (root: HTMLElement, el: Element | null): el is HTMLElement =>
  el instanceof HTMLElement && el.isConnected && root.contains(el);

/** Push: the frame beneath the new top stops being one. Focus leaves it BEFORE it is hidden, so
 *  no focused node ever sits in an `aria-hidden` subtree. */
function suspend(record: OpenRecord): void {
  clearTimeout(record.timer);
  record.uninstall?.();
  record.uninstall = null;
  if (connectedInside(record.root, document.activeElement)) document.activeElement.blur();
  record.root.setAttribute('inert', '');
  record.root.setAttribute('aria-hidden', 'true');
}

/** Pop: the frame beneath is the top again. Its attributes go BEFORE any focus move. */
function resume(record: OpenRecord): void {
  record.root.removeAttribute('inert');
  record.root.removeAttribute('aria-hidden');
  record.uninstall = installTrap(record.root);
  record.releaseLive = adoptLiveRegion(record.root);
}

/**
 * Make `root` an accessible modal dialog for `id`: label it from the registry, trap Tab inside it,
 * and move focus to its `initialFocusSelector` anchor one macrotask later (header).
 *
 * Idempotent on the same id: a second call tears the previous record down completely — no stacked
 * traps, no orphan timer — while keeping the ORIGINAL return-focus target. Opened over another
 * open overlay, it suspends that one (ctl-5); re-opening an id that is covered changes nothing.
 */
export function openOverlayA11y(id: OverlayId, root: HTMLElement): void {
  const previous = OPEN_OVERLAYS.get(id);
  const below = topRecord();
  if (previous !== undefined && previous !== below) return; // covered: it stays suspended
  // No initializer: both branches below assign unconditionally, and TS's control-flow analysis
  // proves definite assignment — a `= null` here would be a value no read can ever observe.
  let returnFocus: HTMLElement | null;
  if (previous === undefined) {
    // Read BEFORE the frame beneath is suspended (which blurs it): a frame opened from the menu
    // returns to the menu's nav container.
    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement ? active : null;
    if (below !== undefined) suspend(below);
  } else {
    clearTimeout(previous.timer);
    previous.uninstall?.();
    returnFocus = previous.returnFocus;
  }

  const meta = OVERLAY_A11Y[id];
  root.setAttribute('role', meta.role);
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', t(meta.labelKey));

  // `aria-modal="true"` above tells assistive technology to ignore everything outside
  // `root` — including the live region, which A11Y-10 places as a direct `<body>` child. Move it
  // inside. Three things about this call site are load-bearing:
  //   * it is on the COMMON path, below the fresh/re-open merge, so a re-open with a DIFFERENT root
  //     re-homes the node (a re-open on the same root is a no-op inside `adoptLiveRegion`);
  //   * it is SYNCHRONOUS, never inside the deferred-focus timer below — a same-tick close clears
  //     that timer, so a deferred move would silently never happen while the record claimed custody;
  //   * it runs before `OPEN_OVERLAYS.set`, because its release closure is a field of that record.
  // The previous record's release closure is deliberately NOT called on a re-open: the adopt above
  // has already re-homed the node, so calling it would bounce the region through `<body>` for one
  // statement — and its own `root.contains` guard makes it inert anyway.
  const releaseLive = adoptLiveRegion(root);

  const uninstall = installTrap(root);
  const timer = setTimeout(() => {
    // R-rb-121 (CTL5.7): a click inside the frame in the same macrotask already put focus where
    // the player wants it; pulling it to the anchor would undo that.
    if (connectedInside(root, document.activeElement)) return;
    root.querySelector<HTMLElement>(meta.initialFocusSelector)?.focus();
  }, 0);

  OPEN_OVERLAYS.set(id, { root, returnFocus, timer, uninstall, releaseLive });
}

/**
 * Undo `openOverlayA11y` for `id`: strip the ARIA claim (a `display:none` node must not keep
 * announcing itself as a dialog), cancel any pending deferred focus, uninstall the trap, and hand
 * focus back.
 *
 * Restore order: the recorded pre-overlay element if it is still connected, else `fallbackFocus` if
 * it is non-null and connected, else NO focus call at all — forcing focus onto some arbitrary node
 * is worse than letting the browser's natural blur to `<body>` stand. FORWARD REFERENCE, NOT
 * EXISTING CODE: M23 §2.3 proposes a `worldHasFocus()` predicate that would read that `<body>`
 * state as "the world has focus"; it is S5's to write and does NOT exist in this codebase today
 * (verified by grep at S1). If S5 implements it differently, this branch is the caller it must
 * agree with. `fallbackFocus` is a REQUIRED parameter (adjudication
 * A3): S3/S4 views have no canvas handle and pass `null`; only S5 has a real value, and a required
 * parameter makes that obligation visible at each call site instead of hiding it in a module global.
 *
 * A no-op when `id` was never opened, or was already closed.
 */
export function closeOverlayA11y(id: OverlayId, fallbackFocus: HTMLElement | null): void {
  const record = OPEN_OVERLAYS.get(id);
  if (record === undefined) return;
  const wasTop = record === topRecord();
  OPEN_OVERLAYS.delete(id);

  clearTimeout(record.timer);
  record.uninstall?.();
  record.root.removeAttribute('role');
  record.root.removeAttribute('aria-modal');
  record.root.removeAttribute('aria-label');
  record.root.removeAttribute('inert');
  record.root.removeAttribute('aria-hidden');

  if (!wasTop) {
    // A covered frame closed beneath another (a multi-level pop, base first): no focus move. A
    // frame whose return target pointed into this one inherits this one's, so the last close of
    // the pop restores focus once, to where it was before the whole stack opened.
    for (const other of OPEN_OVERLAYS.values()) {
      if (other.returnFocus !== null && record.root.contains(other.returnFocus)) {
        other.returnFocus = record.returnFocus;
      }
    }
    record.releaseLive(); // inert: the top frame holds the live region
    return;
  }

  const [nextId, next] = [...OPEN_OVERLAYS].at(-1) ?? [];
  if (nextId !== undefined && next !== undefined) {
    // A single pop: the frame beneath resumes and takes focus back on its nav container (or on
    // the element inside it that opened this one), and the live region with it.
    resume(next);
    const anchor = next.root.querySelector<HTMLElement>(OVERLAY_A11Y[nextId].initialFocusSelector);
    const back = connectedInside(next.root, record.returnFocus) ? record.returnFocus : anchor;
    back?.focus();
    return;
  }

  // Hand the live region back to `<body>`. Inert if a later overlay has since adopted it.
  record.releaseLive();

  let restore: HTMLElement | null = null;
  if (record.returnFocus?.isConnected) restore = record.returnFocus;
  else if (fallbackFocus?.isConnected) restore = fallbackFocus;
  if (restore !== null) restore.focus();
}
