# 0206 — The world-focus hotkey gate, the frame-loop announcer, and the native `#help-hint` button: three main.ts seams M23 needs and the one thing none of them may "simplify"

**Status:** Accepted
**Date:** 2026-08-24
**Slice:** m23-s5 (M23 accessibility S5 — the sole `client/src/main.ts` touch; after S3, S4)
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, ci-gates
**Decision:** A `worldHasFocus()` conjunct gates the twelve `canOpen`-derived hotkey branches only, spelled out twelve times rather than behind one helper; announcements and focus return ride ONE rAF-loop edge; `#help-hint` becomes a native button.

---

## Context and problem statement

M23 §1 Fact 2 records a real collision: a screen-reader user's quick-nav keys are single letters, and
this client binds twelve single letters to overlay hotkeys on a window-level `keydown` listener
(`client/src/main.ts:1052`). Pressing `B` to jump to the next button while the Box overlay is open
also toggles the Box. Spec §2.3 arbitrates the fix and rejects the obvious one on three citations,
because a blanket gate on `document.activeElement === canvasRoot` breaks F8/F9 (`main.ts:1063`), the
menu intercept (`:1084`, whose rows have no `tabindex`), and the fourteen-branch Escape ladder
(`:1300`–`:1409`), all of which must fire while focus is inside an overlay.

S5 is also the slice that has to make three things S1–S4 deliberately could not:

1. **The live region is silent.** `client/src/ui/liveRegion.ts` is a trailing-edge coalescer whose
   `flush(nowMs)` must be pumped by someone. S1 shipped the machine and stated the cliff in its
   handoff: nothing in S1–S4 reds if the pump is never wired, and the region then never speaks.
2. **Focus never returns to the world.** `closeOverlayA11y(id, fallbackFocus)`
   (`client/src/ui/overlayA11y.ts:135`) takes a required fallback precisely so the obligation is
   visible at each call site — and S3/S4 views have no canvas handle, so all sixteen pass `null`.
3. **`#help-hint` is a `<div>`.** A11Y-23 requires the sole always-on menu affordance to be reachable
   by Tab and activatable by Enter *and* Space.

## Considered alternatives

- **A blanket gate at the top of the keydown listener.** Rejected by spec §2.3 on three citations
  (above). Not re-decided here.
- **A shared `canOpenAndFocused(id)` helper replacing the twelve `.kind === 'allow'` reads.**
  Rejected. `client/src/main.ts:378-380` already states the rule this would violate, in the repo's own
  words: *"each call site spells `.kind === 'allow'` itself, deliberately, so no single `!` can invert
  eleven gates at once."* A helper re-creates exactly that single point of inversion, for twelve
  gates. It would also hide the gate from `W-UXD3C-OPENGUARDS-ROUTE-THROUGH-CANOPEN`, whose thirteen
  exact-equality pins would stop describing what they claim to describe.
- **Announcing from inside each of the fourteen Escape branches.** Rejected. It is fourteen edits
  where one suffices, it double-counts against the frame-loop snapshot, and — decisively — it is
  *blind to three real close paths*: the store-driven `dialogueView.render(null)` close, the hotkey
  toggle-close (`KeyB` while the Box is open), and `refreshBattle`'s force-hide sweep
  (`main.ts:1496`). An announcer that only hears Escape is wrong for half the closes that happen.
- **Extending `announcementsFor` to emit on `topOverlay → null`.** Rejected as an *out-of-touches*
  edit (`client/src/ui/announcements.ts` belongs to S1) and, more importantly, as a latent
  double-announce: this ADR's frame-loop branch already covers that transition, so folding the rule
  into the reducer would produce two utterances unless the branch is deleted in the same change.
  Pinned by a tripwire test so a later slice cannot do one without the other.
- **A `get canvas()` accessor on `WorldRenderer`.** Rejected: `client/src/render/world.ts` is outside
  this slice's `touches:` set. `mount.querySelector('canvas')` after `renderer.init(mount, …)` is the
  in-touches route and is exact — `render/world.ts:72` appends `app.canvas` to that same `mount`.
- **`document.querySelector('[role="application"]')` to find the world region.** Rejected as more
  fragile than the tag query: it couples `main.ts` to an ARIA contract that S6/S9 may extend, where
  the `<canvas>` child of `#app` is structural and already load-bearing.
- **A `.hint-badge` class in `client/src/styles.css` to neutralise UA button chrome.** Rejected:
  `styles.css` is outside `touches:`, A11Y-12 bans `#id` selectors there, and a class rule would
  silently defeat the "the inline `style` attribute IS the complete styling contract" premise that
  `client/src/indexShell.test.ts` rests on.

## Decision outcome

**D1 — `worldHasFocus()` is written verbatim as spec §2.3 states it, at module scope beside the
listener, and the `=== document.body` disjunct is load-bearing.**

```ts
let worldCanvasEl: HTMLElement | null = null;   // set once in main(), after renderer.init
const worldHasFocus = (): boolean => {
  const a = document.activeElement;
  return a === null || a === document.body || a === worldCanvasEl;
};
```

Two independent reasons the `document.body` disjunct may never be "cleaned up", the second decisive:
*compatibility* — a sighted player who never Tabs has `activeElement === <body>`, so every hotkey
stays byte-identical to the fork; and *safety for store-driven closes* — when a focused element is
made `display:none` (exactly what `client/src/ui/dialogueView.ts`'s `render(null)` does to a focused
choice `<button>`) the browser blurs it to `<body>`, and without the disjunct `worldHasFocus()` would
return false **forever**, killing every hotkey after any dialogue ends. A11Y-35 pins it.

**Pre-initialisation is safe by construction, and that is a property, not an accident.** Before
`main()` runs, `worldCanvasEl` is `null` and `document.activeElement` is `<body>`, so
`worldHasFocus()` is `true` and all twelve gates behave exactly as they did at the fork. There is no
window in which the hotkeys are dead.

**D2 — The conjunct is appended LAST at exactly the twelve `overlayVerdict(...)` hotkey sites, and
nowhere else.** Not KeyT (`main.ts:1235-1238` states it is deliberately not a `canOpen()` site), not
the thirteenth `overlayVerdict('menuView')` at the delegated `[data-menu-launcher]` **click**
(`main.ts:1835`). The click exclusion is not an oversight: on a click `document.activeElement` is the
badge itself, so a gated front door would refuse the very interaction A11Y-23 exists to enable.
"Last" is also mechanical — `W-KEYM-HANDLER` pins the contiguous substring
`overlayVerdict('menuView').kind === 'allow' && identity !== ''`.

**Accepted behaviour change (spec §8.4):** `B` no longer toggles the Box *closed* while focus is
inside the Box. `Escape` still does, and the frame-loop focus return (D4) puts focus back on the
world region, so the loop closes.

**D3 — One announcement edge, at the TOP of the rAF frame body, using S1's pure reducer.** It sits
immediately after the `sessionGateBlocks()` early return and the frame's existing
`const now = performance.now()` — reusing that single read, because `liveRegion.ts` demands a
monotonic clock and bans `Date.now()` — and **before** `predictor.drain`. The position is deliberate
and was moved there by the plan's red-team pass: the frame body's `predictor.drain` /
`resolver.resolve` / `renderer.render` / `nearestInteractable` calls are unguarded, so a fault that
recurs every frame would, with the block at the tail, silence the live region indefinitely *and*
freeze `lastA11ySnapshot`, collapsing several transitions on the recovering frame. Reading the
visible-id set at the top of the frame is equivalent — nothing inside a frame changes overlay
visibility — and strictly more robust.

```ts
const top = <the frontmost visible overlay, or null>;
for (const m of announcementsFor(lastA11ySnapshot, { topOverlay: top, message: '' })) …
if (lastA11ySnapshot.topOverlay !== null && top === null) { announce world region; return focus; }
```

This single edge delivers spec §2.4 transition (1) *and* (2), for every close path, with **zero**
edits to the Escape ladder and zero edits to any view. Double-announcing is impossible by
construction: `announcementsFor` emits only when `next.topOverlay !== null`
(`client/src/ui/announcements.ts:57`) and this branch fires only when `top === null` — disjoint
predicates. §2.4 transitions (3) battle turn outcome and (4) NPC prompt / zone change have no
producer in S5's EARS set; `message` stays `''` as a stable seam so the slice that grows those
producers needs no API change.

Placing the pump *after* the session gate is deliberate: session-blocked frames produce no
transitions, so the only consequence is that a message still pending when the session died is
dropped rather than spoken over a session-terminal screen — the better behaviour. The named residual
is that a pre-expiry announcement inside its 500 ms window is lost.

**D3a — Both new blocks are pinned by EXACT EQUALITY, not containment, and the canvas assignment is
pinned at all.** Two attacks measured against the plan justify this. (i) An implementation that keeps
`worldHasFocus`'s body and all twelve conjuncts byte-exact but never assigns `worldCanvasEl` — the
line deleted, or shadowed by a second `let worldCanvasEl` inside `main()` — degrades the gate to
"body-or-nothing", so every hotkey dies the first time a keyboard user Tabs to the canvas: the exact
user this milestone serves, on the path A11Y-23 adds. The assignment therefore lives in its own
marked region pinned by exact equality, and the census asserts `worldCanvasEl` is *declared* exactly
once in the file. (ii) `liveRegion.flush(0)` — any constant argument — makes
`now - windowOpenedAt` identically zero, so the region never paints again: behaviourally identical to
never wiring the pump, which is precisely the cliff S1 escalated. A containment scan for
`liveRegion.flush(` passes it; exact equality on the whole block does not.

**D4 — The focus return lives on that same edge, and it is NOT redundant with `closeOverlayA11y`.**
This must be written down because it looks redundant and is not. `closeOverlayA11y`'s restore order
(`client/src/ui/overlayA11y.ts:146-149`) prefers `record.returnFocus` whenever it is still connected.
For an overlay opened by hotkey from the world, `returnFocus` was captured as `document.activeElement`
= `document.body` — an `HTMLElement`, and always connected. So `closeOverlayA11y` restores focus to
`<body>` and the `fallbackFocus` parameter is **unreachable on the common path**; handing it the
canvas would change nothing. S5 therefore performs the return itself, guarded by `worldHasFocus()` so
it never *steals*: if the player opened the menu by clicking `#help-hint`, `returnFocus` is the badge,
`worldHasFocus()` is false, and S5 leaves it alone.

**D5 — `#help-hint` becomes `<button type="button">`, and the terminal `Space` branch gains the
`targetOwnsKey` exemption it always should have had.** A native button gets Tab reachability and
Enter/Space activation for free, and the existing delegated `[data-menu-launcher]` click branch
(`main.ts:1835`) already routes its activation — so `main.ts` still never names the badge
(ADR-0151 D2 / `W-UX1-HINT-NO-JS-OWNER` survive verbatim). But `main.ts:1421-1424` unconditionally
calls `jump(); e.preventDefault();` on `Space`, which **cancels the button's native activation** and
would ship A11Y-23 half-dead — Enter-only, and invisible to every source scan. The fix reuses the
helper whose documented contract is exactly this case (`main.ts:1027-1032`, ADR-0146): the branch
body is guarded by `!targetOwnsKey(e)`, the same exemption `suppressNativeMovementDefault` already
applies on both early-return paths. **Declared consequence:** Space no longer jumps while a
`<button>`/`<a>` has focus. That is the same latent bug `main.ts:1029-1032` already documents for the
eight overlays that do not `stopPropagation`; it is outside spec §2.3's exemption list and is declared
rather than slipped in.

Three inline declarations — `background:none;border:0;padding:0` — are added to the badge's `style`
attribute and no others. Without them the badge ships as a grey OS button with `#9aa0b4` text on
`ButtonFace`, i.e. an accessibility slice shipping a contrast regression. Because `border` and
`padding` are named growth knobs in `indexShell.test.ts`'s own bounded-surface kill list, they are
allow-listed **with a value clause** (`border ∈ {0, none}`, `padding === 0`) rather than outright:
`border:50vw solid transparent` and `padding:0 50vw` still fail. The widening is strictly narrower
than a blanket allow.

## Consequences

**Positive.** The quick-nav collision is closed without touching a single exempt path. The live region
starts speaking, for every close path rather than only Escape. Focus returns to the world region, so
the Escape → reopen loop actually closes. The badge is keyboard-operable. `W-ONE-CORNER-AFFORDANCE`
(`client/src/main.wiring.test.ts:4651`) is widened from `body > div` to `body > div, body > button`,
which makes it catch a class of second corner affordance it was previously blind to.

**Negative / accepted.** Twelve near-identical conjuncts is deliberate duplication, justified above.
`main.ts` now knows the world region is a `<canvas>` child of `#app`; if `render/world.ts` ever
re-parents it, `worldCanvasEl` becomes `null` and the gate degenerates to
"body-or-nothing" — still safe (hotkeys keep working), but the canvas-focused case silently stops
being recognised. Announcements are one frame late (≤16 ms) against a `polite`, 500 ms-coalesced
region — immaterial.

**Accepted residual — `visibleIds(probes)[0]` is DECLARATION order, not z-order.**
`client/src/ui/overlayRegistry.ts:372-374` filters `OVERLAY_IDS` in `OVERLAY_TIERS` insertion order,
which is a sound proxy for "frontmost" only while at most one overlay is visible. `dialogueView`
breaks that: `client/src/main.ts:1574` renders it unconditionally on every store batch and force-hides
only `menuView` (`:1565`), so a server-pushed conversation can become visible underneath an
already-open overlay. Two consequences, both real: `topOverlay` does not transition when a dialogue
opens over a *lower*-index overlay, so that announcement is silently missed; and `visibleIds()[0]`
reports `dialogueView` as "on top" while a full-screen `z-index:100` `helpView` is what actually
covers the screen, so the announced name is wrong. **Not fixed here, deliberately:** constraining the
render-driven overlays' visibility is a view/registry change outside this slice's `touches:`, and
selecting by real DOM z-order requires changing `A11ySnapshot` — the API S1 froze and S10's tests
will assert against. A set-diff heuristic inside `main.ts` would work around a registry-ordering
defect while diverging from `announcements.ts:39-40`'s own documented contract. Recorded as a
residual targeting S6/S10, not left in prose.

**Follow-ups (not this slice).** The `message` channel needs a producer for §2.4 (3) and (4); it is
tied to the same residual row rather than an implicit "later slice". The
`returnFocus`-shadows-`fallbackFocus` finding in `overlayA11y.ts` is a real §4.1 integration note for
the M23 owner: the required parameter it advertises is unreachable on the common path. The [E2E]-tier
proofs of A11Y-19/20/22/23 — real AT key delivery under `role="application"`, native `<button>`
Space→click synthesis, and the actual Tab order from the canvas to the badge — belong to S11's
nightly `just a11y-e2e`; happy-dom does no sequential focus navigation and cannot prove them.
