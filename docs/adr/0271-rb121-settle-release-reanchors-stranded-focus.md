# ADR-0271 — A settle-released action lock re-anchors focus that the no-batch path stranded on `<body>`, by re-asserting the dialog through `openOverlayA11y` (rb-121)

**Status:** Accepted
**Date:** 2026-09-26
**Slice:** rb-121 (residual R-20r-a-FOCUS, promoted from source slice 20r-a; M-residual-backlog.spec.md#rb-121)
**Supersedes:** —
**Amends:** —
**Extends:** 0159, 0205
**Subsystems:** client-ui
**Decision:** A view's lock release that finds focus on <body> re-calls openOverlayA11y(id, root); the idempotent re-open re-installs the trap and defers focus to the registry anchor, so no-batch paths never leave the trap inert.

---

## Context and problem statement

20r-a (and rb-120 for Care) gave every overlay action a generation-token lock: the click takes the
lock, disables the clicked control(s) synchronously, and releases in `.finally()` — on BOTH arms,
and only when the stored token is still this click's own. Five sites carry that shape:
`raisingView.ts` Care and Train, `evolutionView.ts` evolve choice, `pvpView.ts` `#dispatch`
(lifecycle: challenge / accept / decline / cancel), and `battleView.ts` `#dispatch` (PvE skill /
flee / item / swap).

Disabling the focused control, or a mid-flight `refresh()` that `replaceChildren()`s it, leaves
`document.activeElement === <body>` (the HTML focus-fixup rule; happy-dom models the detach half
but not the disable half). On a SUCCESSFUL action the settle is followed by a batch that rebuilds
the panel anyway. On the NO-BATCH paths — reducer rejection, the frozen-link short-circuit, a dead
handle, a synchronous throw — nothing ever re-renders, and focus stays on `<body>`. `focusTrap.ts`
listens on the overlay ROOT (capture phase), so a Tab pressed from `<body>` never reaches it: the
modal's trap is inert until the player clicks back into the overlay.

## Decision

Each lock-owning release, after it re-enables its controls, runs one private per-view step:

```ts
if (this.#visible && document.activeElement === document.body) {
  openOverlayA11y('<thisView>', this.#root);
}
```

1. **The focus mover is `openOverlayA11y`, not the view.** `[A11Y-15]`
   (`evals/overlay-a11y-manifest.eval.mjs`, plus the hand lists in `renameView.test.ts` and
   `menuView.test.ts`) forbids every focus-call spelling in every `client/src/ui/*View.ts`: the one
   deferred focus lives in `overlayA11y.ts` (M23 §2.2). `openOverlayA11y` is documented idempotent
   on the same id: a re-open tears the old record down (timer cleared, trap uninstalled, no
   stacked listeners), **keeps the ORIGINAL return-focus target**, re-adopts the live region
   (a no-op on the same root), re-installs the trap, and one macrotask later focuses the
   registry's `initialFocusSelector` anchor.
2. **Target = the registry anchor (the spec's sanctioned fallback), not the first live button.**
   Landing on the first re-enabled button would need a new focus-owning export in
   `overlayA11y.ts`, which is outside this slice's `touches:` set. The anchor is the dialog's
   accessible title (`tabindex="-1"`), so a screen reader re-announces the dialog after the
   failure, and a single Tab enters the ring at its first control (`nextFocusTarget`'s
   "entering the trap" branch).
3. **Condition = focus is on `<body>` only** — a deliberate narrowing of the spec's
   "body or outside the view root". Focus fixup and node removal both land on `<body>`. Focus on
   any OTHER element — inside the root (the player tabbed to a sibling control mid-flight) or
   outside it (another surface, e.g. the F8 error overlay, legitimately owns it) — is never
   stolen.
4. **The `#visible` guard is load-bearing, not redundant.** In production a lock-owning release
   implies a visible view (every `hide()` clears its lock, which makes the late settle stale). But
   calling `openOverlayA11y` on a hidden view would CREATE a record: ARIA `role="dialog"` on a
   `display:none` root and a leaked trap. The guard makes that unreachable by construction instead
   of by a cross-method invariant.
5. **Only the owning branch acts, and it is `.finally()`, never `.catch()`.** A stale settle
   (token no longer this click's) returns before the step, so a hide()/reopen race never moves
   focus. The step must sit on BOTH arms because the dominant no-batch case RESOLVES:
   `main.ts` `sendGuarded` (20r-a) always resolves — frozen link, dead handle, and a reported
   reducer rejection alike — so a `.catch()`-only re-anchor would never fire in production.
6. **Scope.** The five sites above are every client-side action lock in the four views. The PvP
   battle submit path (`battleView.ts` `onPvpAttack`/`onPvpSwap`) takes no client lock — it is
   gated by the server-derived `vm.pvpPendingSubmit` and its release IS a batch — so it is out
   of scope. `main.ts` needs no change (it owns no lock; `sendGuarded` only supplies promises).

## Consequences

- The five no-batch release paths leave focus on the dialog's anchor one macrotask after settle.
  On a success path whose batch landed first (focus already dropped by `replaceChildren`), the
  same step also re-anchors — strictly better than `<body>`.
- A repeated re-open re-runs the open choreography (ARIA attributes re-set to identical values,
  trap re-installed). The accepted A8 gap (one macrotask where focus is still outside `root`)
  applies here too, as it does at first open — including its mirror image, measured by the
  plan red-team: the deferred timer does not re-check `activeElement` at fire time, so a click
  that lands in the SAME macrotask window (between the settle's microtask and the `setTimeout(0)`)
  has its focus moved to the anchor; the click itself still dispatches. The window is a few
  milliseconds after a network settle; closing it needs a fire-time re-check inside
  `overlayA11y.ts` (outside `touches:`), recorded as a follow-up.
- Ordering vs. a success batch does not matter: whichever of the settle's `.finally()` and the
  batch's `replaceChildren()` runs first, the step re-anchors only if focus is on `<body>` at
  release time, and the anchor is a static node the batch never replaces (created in the
  constructor, or the static `index.html` shell for pvp). The timer re-queries it at fire time.
  A success batch landing AFTER the release can still drop focus to `<body>` (a pre-existing
  render-time behaviour, not a lock release); that is not this slice's defect.
- Per-view duplication: a three-line private method in four files. A shared helper would need a
  file outside `touches:`; recorded as a follow-up, not built (YAGNI until a fifth site appears).

## Alternatives considered

- **New `overlayA11y.ts` export that focuses the first live button** (planner's Plan A). Better
  landing spot by one Tab, but a hidden-dependency STOP (file outside `touches:`); kept as a
  follow-up option.
- **Focus mover injected from `main.ts`.** Splits focus ownership between `main.ts` and
  `overlayA11y.ts`, contradicting M23 §2.2's single owner, and changes four constructor
  signatures. Rejected.
- **Condition "body or outside root" (spec letter).** Would steal focus from a legitimately
  focused out-of-root surface. Rejected (decision 3).
