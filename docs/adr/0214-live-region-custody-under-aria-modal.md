# 0214 — The live region follows the open modal: custody is a closure owned by `ui/liveRegion.ts`

**Status:** Accepted
**Date:** 2026-08-29
**Slice:** rb-11 (residual R-m23-s2-X5)
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, ci-gates
**Decision:** While an overlay is open, re-parent the single `#a11y-live` node into that overlay's root and restore it to `<body>` on close, via an `adoptLiveRegion(root): () => void` closure that lives in `ui/liveRegion.ts` — the module that already sole-owns the node's id — and is called from `ui/overlayA11y.ts`.

---

## Context and problem statement

Two M23 decisions were made in different spec sections and never reconciled.

- **A11Y-10 / §2.4** places the one live region as a **direct `<body>` child**, outside `#app` and
  outside every view root, so that no view's authoritative-rebuild `replaceChildren()` can destroy
  the announcement binding (`client/index.html:145-154`).
- **A11Y-13** sets **`aria-modal="true"`** on every overlay shell root while it is visible — in
  markup for the eleven static shells, and at runtime for all sixteen ids
  (`client/src/ui/overlayA11y.ts:107`).

Per the ARIA specification, while a modal dialog is open assistive technology is instructed to treat
everything **outside** the dialog as inert. The live region `ui/liveRegion.ts` announces through is
a DOM *sibling* of the dialog, not a descendant — so it is inside the inert region. NVDA and JAWS
usually still speak it; VoiceOver/Safari frequently do not. The failure is **silent and
AT-dependent**: nothing in the DOM, and nothing in `just ci`, looks wrong.

Three properties of this repo shape every decision below.

- **Chromium does not implement `aria-modal` inertness in its accessibility tree.** MEASURED for
  this slice with playwright 1.38 + CDP `Accessibility.getFullAXTree`: with focus inside a
  `role="dialog" aria-modal="true"` element, a sibling live region stays `ignored: false` with an
  empty `ignoredReasons`, both with and without focus in the dialog. So the payoff of this change
  **cannot be observed directly** in the only browser engine installed here. WebKit — the engine
  VoiceOver rides, and one that does prune — is not installed.
- **happy-dom models no inertness either**, so every CI-time assertion this slice can make is
  structural by construction. Anything shaped like an inertness oracle would be measuring the fake
  DOM, and is banned in the new test headers.
- **`evals/a11y-static-shell.eval.mjs` `[A11Y-05b]` mechanically forbids any non-test `client/src`
  module other than `ui/liveRegion.ts` from naming the node** (`:70`, `:74`, `:225-233`, `:686-693`;
  both spellings, `a11y-live` and `LIVE_REGION_ID`, comment-stripped). That single fact decides D1.

## Considered alternatives

- **D1 — where the custody code lives.** `ui/overlayA11y.ts` (the module that owns the modal
  choreography) · `ui/liveRegion.ts` (the module that owns the node's id) · a `[data-live-region]`
  synonym hook that reaches the node without naming it.
- **D2 — the mechanism.** DOM re-parent · `aria-owns` on the root · a mirror region inside the root.
- **D3 — the seam's shape.** `adopt(root) -> node` plus `release(node, from)` · one
  `adopt(root) -> release` closure.
- **D4 — insertion position.** `appendChild` (last child) · `prepend` (first child).
- **D5 — the restore predicate.** Unconditional `document.body.appendChild` · ownership-scoped.
- **D6 — the behavioural oracle.** A CDP "is the node ignored" inertness oracle · a CDP AX-**ancestry**
  oracle · DOM assertions only.
- **D7 — the criterion id.** Mint a new `A11Y-N` · reuse the residual's own id.

## Decision outcome

### D1 — the custody seam lives in `ui/liveRegion.ts`, not in `ui/overlayA11y.ts`

**Chosen: `ui/liveRegion.ts` exports `adoptLiveRegion(root)`; `ui/overlayA11y.ts` calls it and holds
the returned closure opaquely, never naming the node.**

- `ui/overlayA11y.ts` — **rejected, and it was the obvious choice.** It is where the modal
  choreography lives, so the move belongs there on responsibility grounds. But `[A11Y-05b]` flags
  any non-owner module that names `a11y-live`/`LIVE_REGION_ID`, so this is a certain `just ci` RED.
  The only way to ship it is to widen the owner set from one member to two — i.e. to weaken the
  exact ownership gate that protects the node this slice is making more mobile.
- **`[data-live-region]` synonym hook — rejected, and it would have been CI-green.** Neither
  `findLiveRegionIntruders` (id/constant spellings) nor `findLiveRegionDestroyers` (`[aria-live`,
  `[role="status"`) sees a `data-` attribute. It passes. It is also a dishonest bypass of the rule
  the slice is touching, and it creates a *second* way to reach the node. Refused; recorded as the
  known-unclosed bypass R5 rather than papered over.
- **`ui/liveRegion.ts` — chosen.** The node's id stays single-sourced, `[A11Y-05b]` is untouched and
  **not weakened**, no blacklist grows, and the custody function sits in the module that is already
  the node's sole owner. The cost — `liveRegion.ts` is outside this slice's declared `touches:` — is
  declared as a touches-delta rather than hidden.

### D2 — a real DOM re-parent, not `aria-owns` and not a mirror

**Chosen: move the one node.**

- `aria-owns` on the overlay root — **rejected.** It needs no DOM movement, and Chromium's AX tree
  even reflects the re-parent, so it would score *better* on this slice's own probe. That is exactly
  the trap: `aria-owns` is one of the worst-supported ARIA features, and **VoiceOver — the AT that
  actually honours `aria-modal`, i.e. the one this slice exists for — has the weakest support of
  all.** It would fix the measurable case and miss the real one.
- A mirror region inside the root — **rejected.** AT that ignores `aria-modal` (NVDA, JAWS) would
  then speak every announcement **twice**, regressing the majority to fix the minority. It also puts
  a second `[aria-live]` node in the document, which the runtime teeth now forbid.
- A DOM re-parent — **chosen.** One node, one region, correct on every AT, and transparent to
  `liveRegion.ts`, whose `#maybeEmit` resolves the node by `getElementById` on **every** write and
  caches neither a null nor a non-null result (`liveRegion.ts:44-48, :101-103`).

### D3 — one `adopt(root) -> release` closure, mirroring `installTrap`

**Chosen: `adoptLiveRegion(root: HTMLElement): () => void`.**

The rejected first draft was a pair — `adopt(root) -> node` plus `release(node, from)` — which
forced `closeOverlayA11y` to hand `record.root` back in at close, storing the same fact twice
(`record.root` and the `from` argument) kept in sync by convention rather than by construction.
`ui/focusTrap.ts:136`'s `installTrap(root): () => void` already solves the identical
"open captures state, close needs it back" problem in this exact file, and `OpenRecord` already
carries its handle as `uninstall`. The custody handle sits beside it as `releaseLive`, same shape,
same lifecycle. When no live region exists in the document, `adoptLiveRegion` returns a **no-op**
closure rather than `null`, so the caller has no null branch at all.

### D4 — `appendChild` (last child), not `prepend`

**Chosen: last child.** Neither position interacts with anything mechanical — verified, not assumed:

- `#a11y-live` (a `div.sr-only`, no `tabindex`, no `href`, not a form control) matches **none** of
  the seven clauses of `FOCUSABLE_SELECTOR` (`focusTrap.ts:65-73`), and the trap re-queries its ring
  on **every** keydown (`focusTrap.ts:88-94`), so there is no install-time snapshot to poison.
- All sixteen `initialFocusSelector`s (`overlayRegistry.ts:164-261`) are four `[data-testid="…"]`
  and twelve `#…` ids, none of them `#a11y-live` — so a prepended node could not shadow an anchor
  via `root.querySelector`'s document-order first match either.

The deciding reason is therefore **reading order**: a live region prepended as the dialog's first
child is the first thing a browse-mode user lands on inside the dialog. The APG dialog pattern wants
the dialog's own content first.

### D5 — the restore is ownership-scoped, not unconditional

**Chosen: restore to `<body>` iff `root.contains(node)` OR `!node.isConnected`; otherwise no-op.**

An unconditional `document.body.appendChild` is the natural one-liner and it is wrong: with two ids
somehow open at once, closing the first would yank the region out of the second's root and back into
the inert position, silently restoring the very defect. The predicate makes the closure inert unless
the root it captured still holds the node.

`!node.isConnected` is a **FORWARD-LOOKING** disjunct and is commented as such in code, in the style
of `overlayA11y.ts:126-128`. No view rebuilds its own root today — every `replaceChildren()`/
`innerHTML` in `client/src/ui/*View.ts` targets an inner container, and the four `#app`-mounted
roots are built once in their constructors (`battleView.ts:81`, `boxView.ts:60`, `raisingView.ts:78`,
`evolutionView.ts:68`). If one ever did, the closure still holds the node, so the cost is one lost
announcement rather than permanent silence.

### D6 — the browser oracle asserts AX **ancestry**, and says so out loud

**Chosen: a CDP `Accessibility.getFullAXTree` ancestry oracle, with the inertness control printed.**

An inertness oracle ("is `#a11y-live` `ignored` while the modal is open?") is the assertion everyone
reaches for first, and it is **measurably useless here**: Chromium never marks it ignored, before or
after the fix, so the check is green in both states. The probe instead asserts that the browser's
computed `live="polite"` node is a **descendant** of the browser's computed `modal=true` node while
open, and not after close — the structural predicate the AT inertness rule keys off. It proves both
nodes were **found** before asserting anything (a "non-descendant" verdict passes trivially on an
empty tree), and it **prints** `ignored=false` in both states so a reader can see for himself that
this is not an inertness oracle. Honest limit, stated rather than overclaimed.

### D7 — reuse the residual's own id

**Chosen: `R-m23-s2-X5`, eval tag `[A11Y-LRC]`.** `A11Y-1..36` is fully allocated in
`specs/monster-realm-v2/M23-accessibility.spec.md`, and `specs/` is outside this slice's `touches:`.
Same call as rb-10/ADR-0213 D7.

## Constraints discovered

- **The slice is impossible inside its declared `touches:` set.** `[A11Y-05b]` makes
  `client/src/ui/liveRegion.ts` a hard prerequisite for any honest fix (D1). The ledger's own
  `Touches: (inherit from source slice — REVIEW)` line marks that set as an unresolved placeholder;
  the delta is declared in `memory/projects/gates/rb-11.gates.md` and in the PR body.
- **`liveRegion.ts`'s header contained three claims this change falsifies** — "textContent-only
  sink" (`:1`), "a one-line DOM sink bolted on" (`:9`), and "`node.textContent = msg` IS THE ONLY
  DOM WRITE THIS MODULE EVER MAKES" (`:50`). They are amended by **naming the exception**, never by
  softening: the coalescing reducer's only DOM write is still `textContent`; custody is a separate,
  stateless pair of functions that move the node's **parent** and never its content or attributes.
  The XSS argument the original claim carried (`innerHTML` is never a sink for player-influenced
  strings) is preserved verbatim, because it is about content and is untouched.
- **`battleView.test.ts:2747-2753` asserts the battle root holds exactly 10 children**, and stays
  green only because `a11y-live` appears in **no** `*View.test.ts` fixture — `getElementById`
  returns `null`, custody is a no-op, and nothing is appended. That is precisely what the
  "open with no region present" tooth exists to lock in; without it, a later fixture that adds the
  region to a view test would red a file this slice does not own, for a reason nobody would find.

## Residuals

- **R-rb-11-VO** — the payoff is never measured on an engine that implements `aria-modal` pruning.
  Chromium does not (measured); WebKit is not installed. The probe measures the ancestry that rule
  keys off. A real VoiceOver/Safari pass belongs in `docs/a11y-manual-protocol.md`, which `just ci`
  never runs.
- **R-rb-11-REREGISTER** — a re-parent is a spec-defined *remove then insert*, i.e. a **fresh AT
  registration**, and the standing guidance is that a live region must exist in the tree before the
  text change. Mitigated **by a property this slice does not own**: `COALESCE_WINDOW_MS = 500`
  (`liveRegion.ts:63`) plus the rAF pump (`main.ts:2784`) put the earliest possible write ≥500 ms
  after the move. **Cross-module invariant: shrinking that window toward zero, or introducing a
  leading-edge emit, re-opens this hole.** Worst case today is one lost announcement per overlay
  open on the most conservative AT; the status quo is all of them.
- **R-rb-11-A13** — the cross-slice contract at `overlayA11y.ts:55-59` gets sharper teeth. A root
  hidden **without** routing through `closeOverlayA11y` previously leaked a listener and a timer;
  it now also strands the live region inside a `display:none` subtree, i.e. total silence until the
  next open/close. Not reachable today: every force-hide routes through the view's `hide()`
  (`main.ts:361-376`, byte-identical `<id>: () => <id>?.hide()` per id).
- **R-rb-11-SAMEROOT** — two ids open on the **same** root would let the first close yank custody
  from the second. Not reachable (the four `#app` overlays each build their own root) and it
  self-heals on the next open. A defensive "is any other record holding this node" scan was
  rejected: speculative generality against an unreachable state, and this module's house rule bans
  defensive checks that hide a contract breach (`overlayA11y.ts:47-49`).
- **R-rb-11-VIEWFIXTURE** — CI-time vitest drives a generic `<div>` root, never a real
  `battleView`/`boxView` constructor, so the interaction between the parked live-region node and
  those views' inner-container `replaceChildren()` calls (`battleView.ts:241,287,316`) is covered by
  reasoning and the ledger-time probe only, never by `just ci`.
- **R-rb-11-BLACKLIST** — `[A11Y-05b]` is a known-spelling substring scan, so "ownership was not
  widened" is a **bounded** claim: the scan finds zero intruders. A `[data-live-region]` synonym hook
  would still pass it. Text-ownership scans are unclosable blacklists; recorded, not closed.
- **R-rb-11-PARTIAL** — if something between `adoptLiveRegion` and `OPEN_OVERLAYS.set` threw,
  custody would have moved with no record to release it. Consistent with this module's existing
  no-`try`/`catch` risk tolerance (`overlayA11y.ts:47-49`): a focus that throws is a bug we want
  loud. Acknowledged, not defended against.
- **R-rb-11-ORDER** — after one open/close cycle the node sits **after** `<script type="module">` in
  the live DOM rather than before it. Nothing reads that ordering at runtime; an `insertBefore` on
  the script tag was rejected as a second brittle coupling for zero behavioural gain.
