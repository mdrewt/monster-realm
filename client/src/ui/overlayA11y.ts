// ui/overlayA11y.ts — open/close ARIA + focus choreography for the 16 mutual-exclusion overlays
// (m23-s1, M23 §2.1-§2.3; ADR-0205 D1-D3, D7).
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
// parameter all sixteen S3/S4 call sites must fill, for a seam only the tests want. The defer is
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
// A RE-OPEN PRESERVES THE ORIGINAL RETURN TARGET. By the second `openOverlayA11y(id, root)`, focus
// is typically already INSIDE the overlay; re-recording `document.activeElement` would make the
// eventual close restore focus to an element inside the thing it just closed. So a re-open tears
// the old record down fully (timer cleared, trap uninstalled — no stacked listeners) but carries
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
// THREE CROSS-SLICE CONTRACTS S1 CANNOT ENFORCE:
//   (a) A12 — `battleView`, `boxView`, `raisingView` and `evolutionView` share ONE `#app`-mounted
//       root. The map is keyed by `OverlayId`, not by root, so S4 must CLOSE-BEFORE-OPEN; opening
//       the next id first stacks two capture traps on the same node and Tab moves twice per press.
//   (b) A13 — if S5's `refreshBattle` force-hide path sets `style.display = 'none'` directly
//       instead of routing through the view's `hide()` (and thus this close), the record survives
//       with a live listener, a pending timer and a return target that expires — a much later close
//       then restores focus to a long-dead element. Recommend §4.1 add force-hide ↔ close to its
//       cross-slice contract list.
//   (c) The "no focus call at all" branch of `closeOverlayA11y` leaves focus wherever the browser's
//       natural blur put it, i.e. `<body>`. M23 §2.3 PROPOSES a `worldHasFocus()` predicate to read
//       that state as "the world has focus" — it is S5's to write and does NOT exist in this
//       codebase today (grep-verified at S1). Named here so the forward reference is not mistaken
//       for a claim about existing code.

import { t } from './a11yCopy';
import { installTrap } from './focusTrap';
import { OVERLAY_A11Y, type OverlayId } from './overlayRegistry';

/** Everything a close needs, captured at open time. One per open overlay; see the module header. */
interface OpenRecord {
  /** The node the overlay was opened WITH — never re-supplied by the caller at close (A2). */
  readonly root: HTMLElement;
  /** Where focus was immediately BEFORE the first open of this id; preserved across a re-open. */
  readonly returnFocus: HTMLElement | null;
  /** The pending deferred-focus macrotask, cleared on close so it cannot steal focus afterwards. */
  readonly timer: ReturnType<typeof setTimeout>;
  /** The focus trap's uninstall handle (ui/focusTrap.ts). */
  readonly uninstall: () => void;
}

const OPEN_OVERLAYS = new Map<OverlayId, OpenRecord>();

/**
 * Make `root` an accessible modal dialog for `id`: label it from the registry, trap Tab inside it,
 * and move focus to its `initialFocusSelector` anchor one macrotask later (header).
 *
 * Idempotent on the same id: a second call tears the previous record down completely — no stacked
 * traps, no orphan timer — while keeping the ORIGINAL return-focus target.
 */
export function openOverlayA11y(id: OverlayId, root: HTMLElement): void {
  const previous = OPEN_OVERLAYS.get(id);
  // No initializer: both branches below assign unconditionally, and TS's control-flow analysis
  // proves definite assignment — a `= null` here would be a value no read can ever observe.
  let returnFocus: HTMLElement | null;
  if (previous === undefined) {
    const active = document.activeElement;
    returnFocus = active instanceof HTMLElement ? active : null;
  } else {
    clearTimeout(previous.timer);
    previous.uninstall();
    returnFocus = previous.returnFocus;
  }

  const meta = OVERLAY_A11Y[id];
  root.setAttribute('role', meta.role);
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', t(meta.labelKey));

  const uninstall = installTrap(root);
  const timer = setTimeout(() => {
    root.querySelector<HTMLElement>(meta.initialFocusSelector)?.focus();
  }, 0);

  OPEN_OVERLAYS.set(id, { root, returnFocus, timer, uninstall });
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
  OPEN_OVERLAYS.delete(id);

  clearTimeout(record.timer);
  record.uninstall();
  record.root.removeAttribute('role');
  record.root.removeAttribute('aria-modal');
  record.root.removeAttribute('aria-label');

  let restore: HTMLElement | null = null;
  if (record.returnFocus?.isConnected) restore = record.returnFocus;
  else if (fallbackFocus?.isConnected) restore = fallbackFocus;
  if (restore !== null) restore.focus();
}
