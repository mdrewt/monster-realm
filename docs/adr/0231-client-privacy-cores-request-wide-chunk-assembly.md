# ADR-0231 — S8 client privacy cores: request-wide export assembly + a terminal-first deletion lattice

**Status:** Accepted
**Date:** 2026-09-02
**Slice:** m22-s8 (M22 §7.2 S8 — the client half of PRV1-1/3/4/11/12/13)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0226, ADR-0225, ADR-0212, ADR-0182, ADR-0154, ADR-0014
**Subsystems:** client-ui, security-authz
**Decision:** Ship S8 as two pure cores + the terminal_at_ms data path; defer the overlay and the export transport to m22-s8b. Chunk fields are read request-wide, verbatim from the producer; exportable filtering stays server-side.

## Context and problem statement

M22 §7.2's S8 row is "Client: deletion/cancel UX with grace countdown, export download + chunk
assembly", `touches: client/**`. Its criteria are the client-observable halves of PRV1-1
(request deletion with a confirmation and a grace countdown), PRV1-3 (cancel while the grace
window is live), PRV1-4 (a distinct, permanently-rejected state once `terminal_at_ms` is `Some`)
and PRV1-11/12/13 (request an export, read `my_export_bundle` back, assemble multi-chunk payloads
sharing one `request_id`/`total_chunks`, surface only `exportable: true` data).

Three things about the surrounding code decided the shape of this slice.

**1. The overlay half is a ~17-file mechanical fan-out.** `OR-MANIFEST-COMPLETE`
(`client/src/ui/overlayRegistry.test.ts:184`) pins `OVERLAY_IDS` to the EXACT set of
`client/src/ui/*View.ts` files minus two by-name exemptions. One new `*View.ts` therefore forces
edits to `overlayRegistry.ts`, `menuModel.ts`, `menuView.ts`, `a11yCopy.ts`,
`overlayA11yWiring.test.ts`, `index.html`, ~20 sites in `main.ts` and ~30 in `main.wiring.test.ts`.

**2. The export transport needs an edit outside `touches: client/**`.**
`evals/monster-privacy.eval.mjs:1292-1319` holds `EXPECTED_SUBSCRIPTIONS`, an exact-set allowlist
over `connection.ts`'s single `.subscribe([...])` array (check `[S/set]`). Adding
`'SELECT * FROM my_export_bundle'` reds `just eval` unless that allowlist gains the literal too.
The eval invites exactly that edit by name — "a genuinely new subscription is a deliberate edit to
`EXPECTED_SUBSCRIPTIONS` in the PR that privacy-reviews it" — so it is a designed companion, not a
surprise. It is nonetheless outside this slice's declared path-set.

**3. The producer's chunk semantics diverge from the spec's prose.** PRV1-13 says a large table
"split[s] **that table's** payload across multiple chunks"; §5 says "one row per
`(owner_identity, request_id, table_name)`". The shipped producer does neither:
`plan_export_chunks` (`server-module/src/privacy.rs:1092-1152`) numbers `chunk_index` **globally
contiguous 0..N-1 across the whole request** and writes `total_chunks = plan.len()` — the request's
whole chunk count — to every row (`:1519-1531`); one table legitimately spans several rows when
sub-chunked at `EXPORT_CHUNK_ROWS`. §7.3 names `export_bundle`'s chunk fields as a cross-slice
contract to build against **verbatim, with no re-derivation**, so the producer wins.

## Decision

**Ship the smallest coherent mergeable increment: the `terminal_at_ms` data path plus the two pure
decision cores. Defer the DOM overlay AND the export transport to m22-s8b.**

1. `client/src/net/rowConvert.ts` + `client/src/net/store.ts` carry `terminal_at_ms` through to
   `StoreAccount` as `bigint | undefined`, normalising a `null` SDK Option to `undefined` (the
   `claimedFrom` guard's precedent) and never fabricating `0n`.
2. `client/src/ui/privacyModel.ts` — a pure deletion/cancel decision core:
   `deriveDeletionCountdown` (the phase lattice, the countdown and the four permissions) and
   `privacyStep` (the confirmation/effect reducer). No DOM, no SDK, no store, no clock: `nowMs` and
   `graceMs` are injected `bigint`s.
3. `client/src/ui/exportAssembly.ts` — a pure `assembleExportBundle` reading the chunk fields
   **request-wide**, verbatim.
4. `exportable` filtering stays **entirely server-side**. `request_data_export` filters
   `DATA_LIFECYCLE_MANIFEST` on `entry.exportable` before any row is written
   (`privacy.rs:1496-1499`), so a non-exportable table can never appear as a chunk. The client core
   applies **no allowlist, filter or redaction of its own** — one would be a second SSOT for
   PRV1-12 and could only ever *hide* data the player is entitled to.
5. The artifact is built by **string splicing the verbatim `payload_json` values**, never
   `JSON.parse`. The server hand-rolls its JSON with every 64-bit integer as a quoted decimal
   string (`json_u64_into`/`json_i64_into`, `privacy.rs:113-127`) precisely so the client never
   re-encodes them; parsing would re-open the 2^53 hole and can throw `SyntaxError` on a torn chunk
   inside an SDK callback that has no per-listener isolation (ADR-0085 A6).

### The terminal marker is checked FIRST, and `0n` is a marker

`deriveDeletionCountdown` tests `terminalAtMs !== undefined && terminalAtMs !== null` **before it
looks at `status`**, mirroring `cancel_account_deletion`'s guard-first order
(`server-module/src/accounts.rs:812-818`): on the illegal `Active` + marker shape the status check
would otherwise launder an already-erased account back into a cancellable one. `0n` is a valid i64
and therefore a real marker — a truthiness test (`if (terminalAtMs)`) inverts PRV1-4 on it, which
was measured during the plan-phase red-team.

### `'due'` is still cancel-permitted

`cancelPermitted` is true for both `'grace'` and `'due'`. The server's only cancel refusal is the
terminal marker (`accounts.rs:812-822`); the grace deadline is not a cancel precondition anywhere,
and `needs_cancel_write(PendingDeletion)` stays true however much time has elapsed
(`accounts.rs:233-235`). A client that pre-rejected a past-deadline cancel would invent a second
SSOT and cost the player their real window. For the same reason a `PendingDeletion` row with an
absent `deletion_requested_at_ms` yields a DARK countdown (`deadlineAtMs`/`remainingMs` undefined)
but keeps the cancel affordance: a missing timestamp may make the deadline unknown, never the
permission.

### The phase never depends on the clock

`deriveDeletionCountdown` derives the PHASE from the terminal marker and `status` alone; `nowMs`
and `graceMs` affect only `deadlineAtMs`/`remainingMs`, which are `undefined` whenever any of the
three bigint inputs is missing or not a bigint. The first draft degraded a hostile clock to
`'unknown'` with every permission false, and the plan-phase tester caught that this silently
re-introduced the blocker above: `nowMs` is `BigInt(Date.now())` at s8b's call site, so a wiring
slip passing a raw `number` would have put EVERY `PendingDeletion` account into a state that
refuses a cancel the server accepts. Degrading the *number* is safe; degrading the *permission* is
not. A `PendingDeletion` row with a dark countdown resolves to `'grace'`, never `'due'` — both are
cancel-permitted, and `'grace'` is the non-alarming one.

The `'grace'`/`'due'` boundary is `remainingMs > 0n`, which puts `'due'` at exactly the deadline —
identical to `is_deletion_due`'s `>=` (`game-core/src/accounts/deletion.rs:63-67`) and never more
permissive than the server.

### Mirroring a server PRECONDITION is not re-derivation

`exportPermitted` is false for pending-or-terminal accounts, which is bit-for-bit
`should_reject_for_deletion` (`accounts.rs:424-430`, called at `privacy.rs:1481-1483`). That is a
disabled control, not an authority: the server still rejects. The distinction that matters is
between mirroring a precondition (legitimate — "a button that silently does nothing teaches the
player the client is broken", `claimModel.ts:157-161`) and re-deriving a DECISION the server owns
(banned — the `'due'` cancel case above).

### The model emits notice CODES, not copy

`privacyStep` sets a `PrivacyNotice` code (`'none' | 'disconnected' | 'permanently-deleted' |
'request-rejected'`) plus the verbatim server `rejectMessage`. All player-facing copy ships with
the view in m22-s8b. This keeps spec §9 residual-risk-1's requirement — the exact
language *"Direct name/display fields are severed on deletion. The `Identity` key and its
associated timestamps/behavioral history are not purged from multi-user or historical rows; this
is a documented, accepted pseudonymization limitation, not erasure."*, to be used verbatim in the
ADR, commit messages and **any UI copy**, with the word "erasure" never used for it — attached to
the slice that actually renders text, where it can be gated, rather than shipping ungated copy in
an inert module. The sentence is recorded here, verbatim, as §9 requires of the ADR.

**s8b constraint frozen here:** the wiring must hand `privacyStep` the RAW reducer `err.message`,
or a `` `${where}: ${message}` `` composition of it, never a classified/normalised string. The
terminal route matches with `endsWith`, because `statusModel.ts`'s `reduceErrorMessage`
(`client/src/ui/statusModel.ts:38-58`) prefixes every reducer rejection — an `===` match would be
dead at the real call site. That route is deliberately the SECOND, redundant path to the terminal
state; the row's own `terminalAtMs` is the primary one, so a drift in the duplicated message
constant degrades a backup, never the only signal.

## Consequences

- **`terminalAtMs` was write-only until rb-51** (2026-09-05 — see Amendment A1; this bullet
  originally said "until m22-s8b"). At the time of writing it was converted, stored and covered by
  tests with no production reader: `main.ts`'s `onClaimResult` callback, in its AUTH-51 / D15
  claim-rejected branch, was the file's sole non-comment `store.ownAccount(identity)` read, and it
  took only `?.claimedFrom` (the callback is the anchor, the number a dated hint per rb-36's
  citation doctrine). Both graphs agreed the blast radius was census tests, not call sites. rb-51
  added the second reader — the rAF frame's countdown block — and it DOES read `terminalAtMs`,
  through `deriveDeletionCountdown`. Stating this plainly is more useful than an "end-to-end"
  claim the code does not support.
- **Both pure cores have no production caller in this slice.** (rb-51 gave `privacyModel.ts` one;
  `exportAssembly.ts` still has none — Amendment A1.) That is the cost of the split. It is
  bounded: they are the frozen seam s8b builds against, and landing the assembly core before the
  transport is what gets it adversarial fixtures (mixed-owner chunks, `NaN` indices, a
  lexically-smaller-but-numerically-newer `request_id`) before it ever sees a live row.
- **No half-reachable deletion state ships.** `client/src` contains zero occurrences of
  `deleteAccount`/`cancelAccountDeletion`/`requestDataExport` outside `module_bindings`, so there is
  no state in which a player can start an irreversible deletion but not cancel it.
- **Clock skew is a display-only residual.** `nowMs` is the client wall clock while
  `deletion_requested_at_ms` and the reaper's due test are server time, so a lagging client can show
  remaining time after the reaper has fired. It cannot cost a player a cancel: `cancelPermitted`
  covers both `'grace'` and `'due'`. Recorded rather than silently inherited.
- **`request_id` is a wall-clock millisecond** (`privacy.rs`, `now as u64`), not a monotonic
  counter, so `max(requestId)` is only as ordered as the host clock. Live rows are purged before a
  new export is written, so this is unreachable today; it becomes an s8b constraint the moment a
  store holds chunks across a view re-snapshot.
- **m22-s8b's `touches:` must include `evals/monster-privacy.eval.mjs`** for the
  `EXPECTED_SUBSCRIPTIONS` entry, alongside `client/**`.

## Alternatives considered

- **Ship the whole S8 row in one PR.** Rejected on the ~17-file overlay fan-out plus the
  out-of-touches eval edit: one PR would mix a rules change, a census fan-out and a shared-eval
  edit, which is the least reviewable combination available.
- **Move `exportAssembly.ts` to m22-s8b too**, so the export feature lands as one thing (the
  plan-phase reviewer's proposal). Rejected because §7.3 freezes `export_bundle`'s chunk fields as
  the cross-slice contract, so the seam is derived rather than guessed, and because PRV1-13 is the
  most defect-dense rule in the client half — the plan-phase red-team broke three of its five
  originally-planned teeth. Its input field types are pinned from
  `client/src/module_bindings/my_export_bundle_table.ts` to close the "guessed seam" objection.
- **A per-table completeness check** (following PRV1-13's and §5's prose). Rejected: it passes on
  real data by accident and would silently accept an incomplete export. The producer is the
  contract.
- **A client-side `exportable` allowlist** as defence in depth. Rejected: a second SSOT that can
  only hide data the player is entitled to, against a server that already filters before writing.

## Amendment A1 — 2026-09-05 (rb-51): the grace countdown ships as a HUD banner

Self-amendment; no new ADR number was minted (the ADR-0104 precedent). rb-51 discharged residual
`R-m22-s8-X9` — PRV1-1's "ticking countdown in a rendered surface" — and made four decisions this
ADR's deferral did not anticipate. They are recorded here so rb-52 does not re-litigate them.

**Where "s8b" went.** This ADR's deferral target `m22-s8b` was never built as one slice: its three
criteria were promoted into residuals `R-m22-s8-X9/X10/X11` and queued as **rb-51 / rb-52 / rb-53**.
Read every "s8b" above as that trio. rb-51 is X9 only.

- **A1-D1 — the countdown is a passively-visible HUD banner, not a registry overlay.** The criterion
  rb-51 answers is the promoted residual `R-m22-s8-X9`
  (`specs/monster-realm-v2/M-residual-backlog.spec.md`, section rb-51), whose EARS reads "WHEN the
  deletion grace window is live THE PLAYER SHALL see a ticking countdown to the reaper fire in a
  rendered surface" — NOT M22 §7.4's PRV1-1, which is the server-side `delete_account` transition.
  A modal only satisfies "shall see" after the player opens something, whereas the sibling residual
  `R-m22-s8-X10` (rb-52) is explicitly "WHEN the player *opens* the privacy surface". So the banner
  is the right shape for X9 and the modal is the right shape for X10. Mechanically it also keeps the slice
  inside its declared `client/**` touches: a new `client/src/ui/*View.ts` is pinned by
  `overlayRegistry.test.ts`'s readdir-derived OR-MANIFEST-COMPLETE and by
  `evals/overlay-a11y-manifest.eval.mjs`'s frozen `KNOWN_VIEW_FILES` roster, and the latter is
  outside those touches. **This DEFERS the ~17-file overlay fan-out to rb-52; it does not abolish
  it.** The banner is created at runtime beside the `#status` / `#interact-prompt` precedent
  (ADR-0161 D6), so it also stays clear of `W-ONE-CORNER-AFFORDANCE`, which parses static markup.
- **A1-D2 — the change-detection memo is keyed on the RENDERED LABEL.** This is a DOM-write economy
  choice, not a correctness one: the derived remaining time changes every frame, the label once a
  second. (A `remainingMs` key would render the same text — the plan-phase red-team measured that
  it is strictly finer — so the only claim made here is about DOM writes, not behaviour. The write
  count itself is not pinned by a test.) The memo's hide arm IS load-bearing: without it a
  cancelled deletion leaves a frozen notice on screen for the rest of the page's life.
- **A1-D3 — the wasm grace is read ONCE, at module scope**, as `DELETION_GRACE_MS_DEFAULT`
  (deliberately NOT the spelling `DELETION_GRACE_MS`, which ADR-0230 declares a phantom). A
  per-frame read would cross the wasm boundary ~60x/s for a build constant. The dependency is
  proven behaviourally — two different mocked windows produce two different labels — never by a
  call-site text pin alone.
- **A1-D5 — the frame's session gate CLEARS the banner rather than freezing it.** `frame` returns
  early while the session terminal is up (`sessionGateBlocks()`), which would otherwise leave a
  `position: fixed` deletion deadline on screen after the session expired — at exactly the moment
  the store has stopped being a live view of that account and a different person may be at the
  keyboard. The early-return path therefore renders `null` first. (`#interact-prompt`, which
  freezes a transient hint under the same gate, is left as it is: a stale hint is not a stale legal
  deadline.)
- **A1-D4 — the banner is deliberately not a live region**, and carries no implicit-live role: a
  surface that changes every second would interrupt an assistive-technology user continuously, and
  `ui/liveRegion.ts` stays the sole owner of `#a11y-live`. **DEFERRED, named:** a ONE-SHOT
  announcement on the `active -> grace` edge is gate-legal and would close the remaining gap for a
  screen-reader user. It is left to rb-52, which owns the player-facing privacy copy and therefore
  the catalog entry it needs.

**Accepted cost.** rb-51 ships a NOTIFICATION of a state the player can neither enter nor cancel
from the client — the deletion reducers are still unreachable from `client/src` (the "no
half-reachable deletion state" consequence above still holds for the *controls*). This mirrors the
"no production caller" cost this ADR already accepted, and it is bounded: the banner is proven
against injected store rows, and rb-52 lands the controls.


## Amendment A2 — 2026-09-05 (rb-52): the delete/cancel/export controls ship as the 17th overlay

Self-amendment; no new ADR number was minted (the ADR-0104 precedent, and the route Amendment A1
took). rb-52 discharges residual `R-m22-s8-X10` — PRV1-3/PRV1-4's UI surface: "WHEN the player
opens the privacy surface THE CLIENT SHALL expose reachable delete/cancel controls wired to
`conn.reducers` and render the distinct terminal notice once `terminal_at_ms` is `Some`". It gives
`privacyStep` its first production caller and **supersedes the "no half-reachable deletion state"
consequence at `:152-154`**: `client/src` now contains all three reducer call sites, and it contains
them together, so a player who can start a deletion can always cancel it.

- **A2-D1 — the privacy surface IS a registry overlay, where the countdown was not.** A1-D1 shipped
  a HUD banner because that EARS was ambient ("SHALL *see*"). This one is an explicit open action
  ("WHEN the player *opens*"), and `privacyModel.ts` already models a two-step
  `confirm: 'delete-armed'` gate for an irreversible action — which wants a focus trap, Escape
  dismissal and a dialog role, i.e. exactly what `openOverlayA11y` gives a registry member. So
  `ui/privacyView.ts` joins `OverlayId` as a seventeenth `GUARD_ONLY` member and pays the
  OR-MANIFEST-COMPLETE fan-out this ADR's deferral priced.
  REJECTED — the registry-EXTERNAL `sessionView` exemption: `sessionView` is exempt because a
  second `EXCLUSIVE_TOP` member makes `decide()` behave backwards (ADR-0182 D17). A `GUARD_ONLY`
  modal has no such problem, so taking that exemption would be claiming a reason that does not
  hold in order to avoid a census.

- **A2-D2 — the shell is CONSTRUCTED at runtime, not static `index.html` markup.** This reverses
  the plan's first instinct, and the reason is mechanical rather than aesthetic: a static overlay
  shell must carry `role="dialog" aria-modal="true"` (`indexShell.test.ts` A3 asserts it over every
  id whose `initialFocusSelector` resolves), and `evals/overlay-live-region-custody.eval.mjs`
  pins `EXPECTED_ARIA_MODAL_SHELLS = 11` as an EXACT count over `client/index.html`. A twelfth
  reds an eval **outside this slice's `touches:`**. The constructed route (`claimView`/`sessionView`
  precedent) touches `client/index.html` not at all and costs one entry in `indexShell.test.ts`'s
  `CONSTRUCTED_SHELL_IDS`, which is in scope. It is also the cheaper route on every other axis.

- **A2-D3 — `initialFocusSelector` is a NATIVE `<button>`, and the view declares its button fields
  as `HTMLButtonElement`.** `evals/keyboard-operable-rows.eval.mjs` classifies a `this.#field`
  click receiver as a sanctioned *native* site only when the field's declared type is one of
  `HTMLButtonElement`/`HTMLAnchorElement`; anything else lands in the frozen
  `SANCTIONED_DELEGATIONS` ratchet and hard-fails — in an eval outside `touches:`. The same eval
  hard-fails any `tabindex` write from a file not in its frozen `FROZEN_TABINDEX_WRITES`, so the
  anchor must be natively focusable rather than a `tabindex`-ed heading. `renameView.ts`'s
  `readonly #submitBtn: HTMLButtonElement` exists for exactly this reason and is the precedent.

- **A2-D4 — `privacyView` IS in `BATTLE_FORCE_HIDE`, and `hide()` disarms the confirmation.**
  The first draft of this amendment excluded it, reasoning that a force-hide would strand an armed
  delete confirmation. **That reasoning was wrong and is recorded here as corrected rather than
  quietly dropped:** `refreshBattle` deliberately does not consult `canOpen` (`main.ts`'s own
  comment: "a battle auto-show is server truth and must fire even over a GUARD_ONLY overlay that
  would deny it"), so excluding the id does not deny anything — it leaves the privacy modal painted
  underneath the battle, with two `aria-modal` roots and two installed focus traps. Both memberships
  therefore had a real hazard, and neither is fixed by the membership choice alone. What fixes it is
  making the close itself disarm: `PrivacyView` takes an `onDismissed` handler and calls it from
  `hide()`, so `main.ts`'s handle entry stays the byte-identical `privacyView?.hide()` that
  `W-UXD3C-HANDLE-TABLE` pins while the model still receives `confirm-cancelled`. With the close
  made safe, membership is the better answer: one modal at a time.

- **A2-D5 — the open path is a button in the Account & Sign-in overlay, not a new menu leaf or
  hotkey.** `MenuLeafDef.keyGlyph` is a required `string` that must equal a key in `helpModel.ts`'s
  `CONTROLS` SSOT (`menuModel.test.ts` MM-KEYGLYPH-FROM-HELP-SSOT), and `CONTROLS` is
  bidirectionally set-equality-gated against **`docs/PLAYTEST.md`** §3 by
  `ui/playtestControlsDoc.test.ts`. `docs/PLAYTEST.md` is outside rb-52's declared `touches:`, so a
  leaf or a documented hotkey is a hidden-dependency STOP; the slice is designed around it rather
  than widened into it. A second, independent argument points the same way: an undocumented hotkey
  would move `main.wiring.test.ts`'s pinned `worldHasFocus()` censuses (12/12/13), each labelled in
  source as "a DELIBERATE ACT — do not just raise the numbers".
  The placement is right on its own merits too: deletion and data export ARE account management,
  "Account & Sign-in" already owns that domain and already has both a System menu leaf and a `KeyC`
  front door, and a second top-level entry for one domain is the menu bloat `menuModel.test.ts`'s
  anti-pattern 10 names. REJECTED — reusing an existing glyph for a new leaf: that ships a menu row
  advertising a key that opens something else, precisely the defect MM-KEYGLYPH-FROM-HELP-SSOT
  exists to kill. **DEFERRED, named:** promoting the surface to a top-level leaf + a documented
  hotkey, which needs `helpModel.ts` and `docs/PLAYTEST.md` together.
  **Ordering is load-bearing:** `openPrivacy()` hides the claim overlay BEFORE showing the privacy
  one. `openOverlayA11y` captures `document.activeElement` as its return target, and
  `closeOverlayA11y` restores it whenever the node is still `isConnected` — which a `display:none`
  node is. Showing first would capture the claim button, and closing the privacy overlay would then
  park focus inside a hidden subtree, where `worldHasFocus()` is false and every overlay hotkey is
  dead until the player clicks the canvas.

- **A2-D6 — the terminal notice is derived from the ROW, not from `state.notice` alone.**
  `privacyStep`'s `account-changed` arm writes `countdown`, `confirm` and `inFlight` — it does NOT
  write `notice`. So `notice: 'permanently-deleted'` is only ever reached by a CLICK
  (`cancel-deletion-requested` on an already-terminal row, or a `request-failed` whose message ends
  in `SERVER_ALREADY_DELETED_MESSAGE`). E1 says "once `terminal_at_ms` is `Some`", i.e. on OPEN,
  with no interaction. The view model therefore keys the terminal notice on
  `countdown.phase === 'terminal'` **OR** `notice === 'permanently-deleted'`, and both routes are
  gated independently. A VM keyed on `state.notice` alone renders nothing at all when the player
  opens the surface on an already-erased account — which is the criterion failing while every
  click-driven test passes.

- **A2-D7 — the player-facing copy is pure, and spec §9's pseudonymization sentence is pinned
  against a SECOND SOURCE.** `privacyModel.ts`'s header reserved this copy to the slice that renders
  the delete/cancel surface, "where it can be gated". It lives in `ui/privacyBanner.ts` — already
  this surface's pure copy module, whose header is rescoped by this slice from "the deletion-grace
  countdown" to the privacy surface's copy layer. M22 §9 residual 1's sentence is asserted equal to
  `PIN_PSEUDONYMIZATION`, already exported by `evals/account-e2e.eval.mjs`, rather than to a second
  hand-typed literal: one bad transcription copied into both the pin and the implementation is the
  failure mode a hand-typed pin cannot see. The sentence ships with its backticks around
  `Identity` INTACT rather than tidied for display — "verbatim" is the spec's own word, mandated
  compliance language is the wrong place to edit lightly, and keeping them makes the gate a plain
  equality against that second source with no transform in the middle. Note for future editors — the mandated sentence itself
  ENDS in "not erasure", so a blanket "the word erasure must not appear" scan is the WRONG gate and
  would fail correct code; the gate is that the word occurs exactly once and inside that sentence.

- **A2-D8 — non-delivery must be observable.** `sendGuarded` reports a disconnected link but does
  NOT observe `conn.live()` returning `undefined`: `undefined?.catch(...)` is a silent no-op, so no
  `request-succeeded` and no `request-failed` ever arrives, `inFlight` stays set forever, and every
  later click returns `begin`'s silent no-op. The player clicks Cancel during a live grace window
  and nothing happens, ever, with no message. The shell therefore computes
  `hasLiveConnection` as `conn?.live() !== undefined && !conn.linkFrozen()`, so an absent live
  handle takes the model's `disconnected` path instead of the delivered one.

- **A2-D9 — `account-changed` is dispatched on CHANGE, never per frame.** The arm writes
  `inFlight: 'none'` unconditionally, and `begin`'s only double-submit guard is
  `inFlight !== 'none'`. Pumped from the rAF tick the guard would have a ~16 ms lifetime and a
  double-click would issue two `delete_account` calls. The dispatch is therefore gated on an
  observed change in the derived `DeletionCountdown` (the A1-D2 memo idiom), and
  `deriveDeletionCountdown` stays at ONE call site — `main.wiring.test.ts` pins that count — with
  the result reused by both the banner and the model.

**Accepted costs and residuals.**
- No `.focus()` may appear in `ui/privacyView.ts`: `evals/overlay-a11y-manifest.eval.mjs` bans every
  focus spelling in `client/src/ui/**/*View.ts`, so focus placement stays `overlayA11y`'s job. And
  the notice is NOT a live region — `evals/a11y-static-shell.eval.mjs` pins exactly one, and
  `ui/liveRegion.ts` owns it (the A1-D4 call, restated here for the notice).
- `privacyView.test.ts` cannot join the nightly a11y tier: `evals/ci-gate-wiring.eval.mjs` holds a
  byte-frozen copy of the `a11y-e2e` justfile recipe including its file list, and both that eval and
  the `justfile` are outside `touches:`. Named, not hidden.
- The claim → privacy hand-off rides `claimView`'s documented `S4-claimView-REOPEN-AFTER-HIDE`
  residual: `ClaimPhase` cannot represent "dismissed", so a later `renderClaim()` arrives with
  `vm.visible === true`. rb-52 creates the first state where that re-open can land on top of another
  modal, so it is mitigated here rather than merely inherited: `renderClaim()` is suppressed while
  the privacy overlay is visible. The underlying model defect still needs `claimModel.ts` and is
  out of scope.
- A1-D4's named follow-up — a ONE-SHOT announcement on the `active -> grace` edge — is not part of
  this criterion and is DEFERred as a residual rather than absorbed.
- rb-53 (`R-m22-s8-X11`) is untouched. This slice wires `requestDataExport` because `privacyStep`
  already emits `call-request-data-export` and an unreachable effect variant is dead code; it does
  NOT subscribe to `my_export_bundle`, assemble a bundle, or offer a download. Note that
  `exportPermitted` is `true` pre-join (no account row ⇒ the non-pending branch), so the Export
  control is offered in a state the server will reject — server-authoritative by design, and
  recorded rather than clamped client-side.

## Amendment A3 — 2026-09-05 (rb-53): the live export transport and the download offer

Self-amendment; no new ADR number was minted (the A1/A2 route, ADR-0104 precedent). rb-53
discharges residual `R-m22-s8-X11` — PRV1-11/12/13: "WHEN `request_data_export` completes THE
CLIENT SHALL read `my_export_bundle` from a live subscription, assemble it via
`assembleExportBundle`, and offer the artifact as a downloadable file". It gives
`assembleExportBundle` — shipped by m22-s8 with no production caller — its first one, and it
**closes the dead end this ADR recorded at `:147-151`**: `requestDataExport` had a call site from
rb-52 but nothing ever read the rows it produced.

- **A3-D1 — `my_export_bundle` is wired as a `Vec`-VIEW, not as an `Option`-view: `onInsert` +
  `onDelete` that only `batcher.schedule()`, and a whole-set reconcile in the shared flush
  closure.** The repo has two structurally identical precedents — `my_monster_pub` (ADR-0194 D4,
  `connection.ts:353-359`) and `my_battle` (ADR-0198 D4, `connection.ts:379-381`) — both PK-less
  views returning `Vec<T>`, both rebuilt from the post-burst SDK cache by
  `store.reconcile*FromView`. `my_export_bundle` is the same shape (`privacy.rs:1565-1567` returns
  `Vec<ExportBundle>`; the view strips the primary key, `schema.rs:920`), so it takes the same
  route: `store.reconcileExportChunksFromView`.
  REJECTED — the `my_account`/`my_wallet` per-row `upsert` idiom. Those are single-row
  `Option`-shaped slots whose "no `onDelete`" rule exists because a view UPDATE arrives as an
  unordered insert+delete pair. Copying them here would have meant re-litigating that rule for a
  table that is never updated at all (`privacy.rs` has exactly three writers: insert `:1544`,
  cascade delete `:87`, TTL-reaper delete `:1645`) — and a reviewer reading the new block beside
  `connection.ts:341` would rightly read it as copied from the wrong neighbour. The reconcile also
  makes a client-side chunk cap unnecessary: the set is whatever the owner-scoped view currently
  holds, bounded by the server's 7-day TTL reaper.

- **A3-D2 — the assembly is computed ON BATCH (`store.onBatchApplied`), never per frame and never
  only on click.** Exactly ONE `assembleExportBundle(` call site in `main.ts`. Per-frame is a full
  re-scan and, at `complete`, a full re-concatenation 60×/s. On-click-only would leave the surface
  unable to say whether an export is ready, making the button a coin flip. `onBatchApplied` fires
  once per coalesced transaction burst — precisely the arrival edge. (Measured during review: the
  splice is ~0.003–0.006 ms even at 32 MB, because V8 never flattens the rope until `new Blob`
  consumes it. The per-batch recompute is not a netcode cost, so no revision counter is warranted.)

- **A3-D3 — the artifact is offered behind a BUTTON; it is never auto-downloaded.** Chunks
  re-arrive on every applied snapshot, so an auto-download would re-fire on each reconnect and spam
  duplicate files; browsers also block non-gesture downloads, which would leave the criterion
  silently unfulfilled with no error surface.

- **A3-D4 — the download control is ALWAYS painted and only `disabled`; it is never
  `display:none`.** This is the dominant precedent in `privacyView.ts` (the delete/cancel/export
  trio at `:172-174`), and here it is load-bearing rather than cosmetic. Unlike every other control
  in this file, the download control's enablement is driven by INCOMING SERVER DATA, so it can flip
  while the player has it focused. `overlayRegistry.ts:275-279` already records the consequence:
  focus falls to `<body>`, which is not a descendant of the overlay root, so `focusTrap`'s capture
  listener never fires and Tab walks the page behind an `aria-modal` dialog Chromium does not make
  AT-inert. A control that vanishes under focus is that defect through a new door.
  (The export-status `<p>` beside it DOES hide when there is nothing to say — it is not focusable,
  and it mirrors `#privacy-notice`.)

- **A3-D5 — one status sentence per `ExportAssemblyStatus`, `inconsistent` prints NO total, and
  `incomplete` does not promise arrival.** The core deliberately returns `totalChunks: undefined`
  on `inconsistent` (`exportAssembly.ts:59-62`), so printing a number there would leak a fabricated
  total. `incomplete` is reached by two causes that the client cannot tell apart — still streaming,
  and a server-side partial removal (the TTL reaper deletes at most
  `EXPORT_REAP_MAX_DELETE_PER_TICK` rows per tick, oldest `chunk_id` first, so it can cut across one
  owner's request) — so the copy says what is true (some chunks are missing) rather than telling the
  player to wait for chunks that may never arrive.

- **A3-D6 — the export state does NOT enter `privacyModel.ts`; it is an OPTIONAL second argument to
  `buildPrivacyViewModel`.** `privacyStep`'s only double-submit guard is `inFlight`, and an
  `export-chunks-changed` event would create a second per-burst pump into the reducer that A2-D9
  exists to prevent. The parameter is optional rather than required because `client/tsconfig.json`
  excludes `**/*.test.ts`: a required parameter would be enforced on the two `main.ts` sites and on
  none of the ~29 spec call sites, buying a large mechanical spec churn for a guarantee the
  typechecker cannot give. The forgotten-call-site risk is closed behaviourally instead — the
  runtime tooth in `main.exportTransport.test.ts` reds if `renderPrivacy` drops the argument.

- **A3-D7 — the CSP/sandbox fallback logs a STATIC string, deliberately unlike the F9 bug-bundle
  precedent it is otherwise modelled on.** `downloadBugBundle` (`main.ts:2405-2409`) logs its whole
  payload on failure, which is safe only because `KeyStoreSnapshot` is a no-PII allowlist by
  construction (`bugBundle.ts:24-33`). The export artifact is the opposite: every exportable table,
  including player-authored names and behavioural history. Logging it would retain the player's
  complete personal-data dump in the devtools buffer for the page's life, and — if routed through
  `reportError` — put it on screen and into the `errorRing` that `buildBugBundle` embeds in the file
  players are asked to attach to bug reports. No existing gate would catch that
  (`evals/client-no-pii-logs.eval.mjs`'s ban list is credential-shaped), so it is recorded here and
  gated by a tooth asserting no log sink receives the artifact bytes.

- **A3-D8 — `a.remove()` and `URL.revokeObjectURL(url)` move to a `finally`.** In the F9 precedent
  both sit inside the `try`, after `a.click()`; a throw there pins the object URL — and therefore
  the whole Blob — for the page's lifetime and leaves a stray `<a href>` in the document. At
  bug-bundle scale that is kilobytes; at export scale it is the entire dump.

- **A3-D9 — `onReconnect(identity)` drops the cached assembly.** A rebuild can mint a NEW identity
  (`connection.ts:745`, `main.ts:2939`), and the cached artifact is `main.ts` state, not store
  state, so `store.reset()` does not reach it. ACCEPTED and recorded: between a link drop and the
  next applied batch the button still offers the last artifact. That artifact is this player's own
  data, delivered to this client for this identity, so the staleness is a freshness question rather
  than a leak; the identity rotation — the only case that is a leak — is what this clear covers.

- **A3-D10 — the surface is repainted only while visible; the assembly is recomputed
  unconditionally.** `openPrivacy()` already renders from current state, so a burst arriving while
  the overlay is closed is picked up on open. Putting the recompute inside the visibility guard is
  the bug this decision forecloses. Note also that the rAF repaint gate (`main.ts:3100`) is keyed on
  `statusLabel` alone, which export state does not move — so the batch listener is the SOLE repaint
  owner for this part of the surface.

- **A3-D11 — the download filename lives in `ui/privacyBanner.ts`, the surface's copy layer, not in
  the frozen `ui/exportAssembly.ts` core.** It is composed from the `requestId` (a `bigint`) and a
  caller-supplied `capturedAtMs`, so it stays clock-free, and it is run through
  `bugBundleFilename`'s character-class strip anyway: `rowConvert` is a documented pure pass-through
  with no validation (`rowConvert.ts:543-566`), so a drifted binding could deliver a `requestId`
  whose `String()` carries a path separator.

### Deferred by rb-53 (named, not hidden)

- **A one-shot live-region announcement on the `incomplete → complete` edge.** Already outstanding
  from A1-D4 as `R-rb-52-GRACEANNOUNCE`'s sibling; it needs a `ui/a11yCopy.ts` catalog entry and the
  live-region custody surface, both outside this slice's `touches:`. Not required by the criterion.
- **A browser/e2e proof that the LIVE subscription is correct.** `connection.ts` is
  coverage-excluded and unimportable under vitest, so every subscription EARS in this repo is
  discharged by a source scan (the `W-UX2B-SUBSCRIBE` precedent). rb-53 adds one control the
  precedent lacks — a tooth cross-checking each subscribed name against the generated
  `tablesSchema` roster in `client/src/module_bindings/index.ts`, which is the only check in the
  slice that is independent of the pinned string. A wrong literal is still ultimately caught by the
  cloud `just e2e` job (`client/e2e/golden.spec.ts` waits on a non-empty identity), never by
  `just ci`. `evals/account-e2e.eval.mjs` is NOT a mitigation: it opens its own subscription with
  its own literal and never reads `client/src/net/connection.ts`.
- **A retry/refresh affordance for `inconsistent`, and any per-table or streaming download.** YAGNI
  — the existing Export control already re-requests.
