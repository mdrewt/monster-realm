# 0205 — The overlay accessibility metadata SSOT and the flat copy catalog: a total `OVERLAY_A11Y` beside `OVERLAY_TIERS`, keys never literals, and a compile-time contract that text pins cannot fake

**Status:** Accepted
**Date:** 2026-08-24
**Slice:** m23-s0 (M23 accessibility S0 — the substrate; first slice, no deps)
**Supersedes:** —
**Amends:** —
**Subsystems:** client-ui, ci-gates
**Decision:** A11y metadata is one total `Record<OverlayId, A11yMeta>` in `overlayRegistry.ts`, accessible names are catalog keys resolved by a throw-on-miss `t()`, and totality plus the closed role union are gated by a negative compile, not a text pin.

---

## Context and problem statement

M23 (`specs/monster-realm-v2/M23-accessibility.spec.md`, converged 2026-08-23) makes accessibility a
gated property rather than a best-effort retrofit. Its §2.0 central decision is that every overlay's
ARIA role, accessible-name key, initial-focus target and dismiss semantics live in **one** table
beside `OVERLAY_TIERS` (`client/src/ui/overlayRegistry.ts:76`), because that table already makes
omitting an overlay id a **compile** error and already derives `OVERLAY_IDS` from itself
(`client/src/ui/overlayRegistry.ts:100`) rather than hand-maintaining a second list. Sixteen per-view
retrofits have no completeness oracle; one total table does.

S0 ships that substrate and nothing else: the `A11yMeta` type, the sixteen-entry `OVERLAY_A11Y`
table, and a flat `client/src/ui/a11yCopy.ts` catalog plus `t(key)`. Every consumer —
`overlayA11y.ts`, the focus trap, the live region, the view wiring, the hotkey focus gate — is S1+.
The decisions below are the ones S0 must make now because later slices build against them, plus one
gating decision forced by a measured attack on the obvious oracle.

## Decision

### D1 — `initialFocusSelector` targets a stable, constructor-time anchor; "natively focusable" is amended to "focusable"

Every `initialFocusSelector` is a **stable, constructor-time** `#id` or `[data-testid="…"]` selector
resolving either to a natively focusable control or to a static element that the shell-owning slice
(S2 for `client/index.html`, S4 for the constructed overlays) makes programmatically focusable with
`tabindex`.

Four registry members are display-only lists with zero event listeners — `questLogView`, `healView`,
`leaderboardView`, `helpView` (spec §1 Fact 2) — and three more (`dialogueView`, `shopView`,
`tradeView`) have no focusable control in their static shell either. Nothing natively focusable
exists to point at. The two candidate resolutions:

- **Rejected — require S2 to add a real focusable.** A `<button>Close</button>` inserted into
  `#quest-log-overlay` in S2 has no listener until S5, which owns the Escape ladder
  (`client/src/main.ts:1300`–`1409`). S2 would ship four visible, keyboard-reachable, *dead*
  controls. That is a worse defect than the one it fixes.
- **Adopted — the ARIA APG dialog fallback.** Where a dialog has no obvious initial focus, put
  `tabindex="-1"` on its heading (or first content node) and focus that.

**This amends the spec.** §2.1 says the selector "MUST resolve to a **natively** focusable element"
and A11Y-14 says the resolved element "SHALL be natively focusable". Read literally, seven of sixteen
ids cannot satisfy it without S2 shipping dead controls. The amended wording is "**focusable** —
natively, or via `tabindex`". The vacuity the original wording was defending against (a check that
passes on a decorative wrapper) is killed instead by an **identity** assertion in S10's wiring spec —
`document.activeElement === root.querySelector(selector)` — which is strictly stronger than a tag
allow-list. **This amendment is an S0 judgement call recorded here, not an operator ruling; it is
flagged for sign-off in the slice PR** (spec §8 escalation discipline). If it is rejected, S2/S4
absorb the cost, not S0 — the table's selector strings do not change.

**The obligation on S2/S4 is DERIVED, never listed.** S0 exports no "these ids need a tabindex"
array. A second hand-kept table beside a total one is precisely the drift `OVERLAY_IDS` exists to
prevent (`client/src/ui/overlayRegistry.ts:95`–`100`), and the module header already records the
"A7/A15" zero-consumer rule against speculative exports (`:26`–`:30`). Instead, S2's
`evals/a11y-static-shell.eval.mjs` and S10's `overlayA11yWiring.test.ts` resolve **every**
`OVERLAY_A11Y[id].initialFocusSelector` and require the target to be focusable. If S2 forgets a
`tabindex`, S2's own gate reds. The data S0 already ships is the mechanism.

### D2 — the sixteen anchors, and why a dynamically-built control is wrong rather than merely fragile

The four `#app`-mounted overlays build their focusables at render time
(`client/src/ui/battleView.ts:247`, `client/src/ui/boxView.ts:44`,
`client/src/ui/raisingView.ts:164`, `client/src/ui/evolutionView.ts:192`). Pointing
`initialFocusSelector` at one of those is **incorrect**, not just brittle: `battleView` calls
`replaceChildren()` on its skills container (`client/src/ui/battleView.ts:241`) and its action row
(`:270`) on every server tick, so a focused skill button is destroyed and the browser blurs focus to
`<body>` — the exact store-driven-blur hazard spec §2.3 documents for `dialogueView`. Constructor-time
anchors survive every rebuild.

| id | tier | `initialFocusSelector` | anchor | focusable by |
|---|---|---|---|---|
| `battleView` | EXCLUSIVE_TOP | `[data-testid="battle-title"]` | `client/src/ui/battleView.ts:59` | S4 |
| `boxView` | HIDE_SWITCH | `[data-testid="box-title"]` | `client/src/ui/boxView.ts:40` | S4 |
| `raisingView` | HIDE_SWITCH | `[data-testid="raising-title"]` | `client/src/ui/raisingView.ts:55` | S4 |
| `evolutionView` | HIDE_SWITCH | `[data-testid="evolution-title"]` | `client/src/ui/evolutionView.ts:46` | S4 |
| `dialogueView` | GUARD_ONLY | `#dialogue-npc-name` | `client/index.html:12` | S2 |
| `questLogView` | GUARD_ONLY | `#quest-log-list` | `client/index.html:17` | S2 |
| `healView` | GUARD_ONLY | `#heal-list` | `client/index.html:20` | S2 |
| `shopView` | GUARD_ONLY | `#shop-title` | `client/index.html:24` | S2 |
| `tradeView` | GUARD_ONLY | `#trade-status` | `client/index.html:31` | S2 |
| `pvpView` | GUARD_ONLY | `#pvp-challenge-status` | `client/index.html:39` | S2 |
| `leaderboardView` | GUARD_ONLY | `#leaderboard-title` | `client/index.html:47` | S2 |
| `renameView` | GUARD_ONLY | `#rename-input` | `client/index.html:53` | native |
| `tradeProposeView` | GUARD_ONLY | `#tradepropose-target` | `client/index.html:59` | native |
| `helpView` | GUARD_ONLY | `#help-title` | `client/index.html:86` | S2 |
| `menuView` | GUARD_ONLY | `#menu-rows` | `client/index.html:100` | S2, `tabindex="0"` |
| `claimView` | GUARD_ONLY | `#claim-signin-btn` | `client/src/ui/claimView.ts:44` | native |

`renameView` and `tradeProposeView` keep today's focus target byte-for-byte:
`client/src/ui/renameView.ts:102` focuses `#rename-input` (bound at `:45`) and
`client/src/ui/tradeProposeView.ts:124` focuses `#tradepropose-target` (bound at `:59`). S3 deletes
those two view-local deferred calls; the shared deferred call in `overlayA11y.ts` must land on the
same elements or the UX regresses.

**Landmine for S2 and S6 — `#menu-rows` takes `tabindex="0"`, never `-1`.** S6 puts
`role="listbox"` + `aria-activedescendant` on `#menu-rows`, and `aria-activedescendant` requires the
listbox itself to hold DOM focus, so `#menu-heading` is the wrong anchor. But `#menu-rows` carries a
delegated `click` listener (`client/src/ui/menuView.ts:51`), and S10's `[A11Y-T3]`
`NEGATIVE_TABINDEX_INTERACTIVE` fails `tabindex="-1"` on a listener-bearing element (spec §5.4).
`tabindex="0"` satisfies both; `[A11Y-T5]` bans only values `> 0`.

### D3 — `role` is `'dialog'` for all sixteen; the union keeps both members anyway

`alertdialog` is for a dialog that interrupts to communicate an urgent message, and assistive
technologies announce its entire contents immediately on open. None of the sixteen is that. The
actual error surface, `errorOverlayView`, is deliberately **not** an `OverlayId`
(`client/src/ui/overlayRegistry.ts:32`–`34`), and `claimView` is a claim nudge, not an alert. Marking
`battleView` or `boxView` `alertdialog` would make an AT read the whole battle or party screen on
open — actively worse than `dialog`. Spec §5.1's GOOD hostile-but-correct fixture explicitly requires
the oracle to tolerate full role reuse, so uniformity is sanctioned, not a smell.

The two-member union stays (spec §2.1 non-negotiable #2). It is what makes `role="presentation"` a
**compile** error rather than a scan miss, and D6's oracle does not require a member to be *used*.
An id should become `alertdialog` only when its sole purpose is a blocking urgent message.

### D4 — `t(key)` is pure and THROWS on a miss

`export function t(key: string): string` throws an `Error` naming the missing key. Three reasons:

1. **Reject-not-clamp**, and the repo's own precedent in this exact module family — `anyVisible`'s
   "NO try/catch on purpose: swallowing a throwing probe would return `false` silently, i.e. a
   mutual-exclusion breach that looks like working code" (`client/src/ui/overlayRegistry.ts:368`).
2. Both alternatives are **silent** failures with user-visible cost. Returning the key announces
   `a11y.overlay.boxView.title` to a screen-reader user; returning `''` ships an **unlabelled
   dialog**, which is a worse WCAG failure than shipping no dialog role at all.
3. Key-on-miss makes an **unwired catalog look wired** — the precise vacuity spec §5.1 declares and
   kills.

`t` is *partial* on `string` but *total* on the domain CI guarantees: A11Y-4 makes an unresolvable
`labelKey` a CI failure, so the throw is unreachable in shipped code. It is a fail-loud backstop, in
the same spirit as `anyVisible`'s absent `try/catch`. It is pure — no IO, no module state, no
mutation of the catalog — and returns a primitive, so there is no defensive-copy concern (contrast
`buildHelpViewModel`, `client/src/ui/helpModel.ts:14`).

**Rejected: `as const` + `keyof typeof` literal-typed keys.** It would make a missing key a compile
error at literal call sites, but `A11yMeta.labelKey` is typed `string` per spec §2.1 so the benefit
never reaches the table, and a literal-union key type fights M24's resolver swap — spec §2.8 requires
that "M24 swaps the resolver; M23's keys become catalog entries with **zero renaming**".

### D5 — the orphan direction is namespace-scoped and DERIVED, with no catalog-size ceiling

A11Y-4 requires both directions: no `labelKey` without a catalog entry, and no catalog entry without
a referencing key. Written globally that is exact **today** and a **false blocker tomorrow** — S1
lands `a11y.world.region` (spec §2.3) and every announcement string the moment it starts, and a
global orphan check would force S1 to weaken an S0 gate. What S0 ships instead:

1. A **set equality** between the catalog's `a11y.overlay.`-prefixed keys and the expectation
   **derived from `OVERLAY_IDS`**: `{ 'a11y.overlay.' + id + '.title' }`. This is stronger than "each
   `labelKey` resolves and each entry is referenced": it is total, a seventeenth overlay drags it
   automatically, and a stowaway `a11y.overlay.ghostView.title` cannot survive it.
2. **Plus** the literal per-id resolution check — every `OVERLAY_A11Y[id].labelKey` equals its derived
   key and resolves to a non-empty catalog entry. (1) alone never reads `labelKey`, so a typo'd
   `…helpView.titel` would pass it; the two assertions live in the **same** test so one gate covers
   both halves of the criterion.
3. **No** "the catalog contains only `a11y.overlay.*` keys" check and **no** size ceiling.

S0's catalog contains zero non-`a11y.overlay.*` keys, so the scoped check and a global one are
identical in effect right now; the scoping buys S1 compatibility at zero present cost. That is proven
executably, not asserted: the bite-proof "add `a11y.world.region` — must stay GREEN" is part of this
slice's teeth.

**The convention that keeps the rest honest:** *a catalog namespace is orphan-checked by the slice
that owns its consumer.* `a11y.overlay.*` is S0's, via `OVERLAY_A11Y`; `a11y.world.*` and
`a11y.announce.*` are S1's, via `world.ts`/`announcements.ts`. Invariants S0 enforces on **every**
key regardless of namespace: shape regex with non-empty dot-segments, value non-empty after trim, and
no `{`/`}` in the key **or the value** — spec §2.8 bans ICU syntax in the *copy*, which is the value,
so the value-side brace ban extends A11Y-3's key-side ban by that section's general prohibition
rather than by a numbered criterion of its own.

**Key shape — a spec conflict resolved.** Spec §2.8 gives `a11y.overlay.boxView.title` (capital `V`)
but §5.1 `[A11Y-02]`'s regex `/^a11y\.[a-z0-9.]+$/` **rejects** it. S0 keeps the id **verbatim** —
`a11y.overlay.<OverlayId>.title` — and uses a case-permitting, segment-non-empty regex. Verbatim ids
make the key derivable from `OverlayId` with zero mapping table, and that derivability is the whole
anti-drift point of (1); a kebab-case mapping would reintroduce a hand-kept id↔key correspondence.
Note that the §5.1 regex also accepts garbage such as `a11y..` and `a11y.....`; the per-id equality
in (2) is what actually pins the key, and the regex is the weaker backstop for future namespaces.

**Declared residual.** A key that lands outside *every* claimed namespace — e.g. the one-character
typo `a11y.overlays.boxView.title`, which fails `startsWith('a11y.overlay.')` — is orphan-checked by
nobody. Full A11Y-4 coverage is therefore the *union* of every slice's namespace-scoped check, held
together by the convention above rather than by a mechanism. A future slice that wants a mechanism
should add a "every key belongs to some registered namespace" check with a registry the owning slices
append to; S0 does not, because with one namespace it would be a table of one.

### D6 — totality and the closed role union are gated by type-level probes in the module, NOT by a textual declaration pin

The house pattern for pinning a compile-level guarantee is an exact-shape textual pin on the
declaration line, read with `readFileSync` — `OVERLAY_HANDLES_DECL` at
`client/src/main.wiring.test.ts:6046`, which exists because red-team measured that loosening
`Readonly<Record<…>>` to `Partial<Readonly<Record<…>>>` left `tsc --noEmit` clean and the whole suite
green. S0 does **not** reuse it, because red-team measured a bypass of the pin itself.

**The measured attack.** With `OVERLAY_A11Y` declared `Readonly<Partial<Record<OverlayId, A11yMeta>>>`
and the `helpView` entry deleted, planting a *used* exported string constant elsewhere in the file —

```ts
export const OVERLAY_A11Y_DECL_DOC =
  'export const OVERLAY_A11Y: Readonly<Record<OverlayId, A11yMeta>> = {';
```

— left `tsc --noEmit` clean **and** made the pin's `countOccurrences(...) === 1` pass. This is not a
`stripLineComments` bug to patch: a plain string literal is never comment-stripped by any comment-aware
stripper, so the bypass is structural to *any* pure-text substring pin.

**Adopted instead: a real NEGATIVE COMPILE.** The gating test writes small probe modules that
`import` the real registry and spawns `tsc --noEmit` on each, then asserts the **polarity of the
compiler's own verdict** — two probes that MUST compile and two that MUST NOT:

| probe | polarity | what a violation looks like |
|---|---|---|
| `const t: { [K in OverlayId]: A11yMeta } = OVERLAY_A11Y` | MUST compile | `Partial<>` / optional-key erasure reds it |
| `const bad: keyof typeof OVERLAY_A11Y = 'settingsView'` | MUST **NOT** compile | `Record<string, A11yMeta>` widening makes it compile |
| `const bad: A11yMeta['role'] = 'presentation'` | MUST **NOT** compile | `role: string`, or a third union member, makes it compile |
| `const a: A11yMeta['role'] = 'dialog'` and `= 'alertdialog'` | MUST compile | a narrowing to one member reds it — the anti-vacuity half |

This never scans text, so decoy string constants, `satisfies`, comments and line-splitting are all
irrelevant to it; and unlike a type-level probe placed inside the production module, it keeps
`overlayRegistry.ts` a pure data module with no test scaffolding in it. Measured at 0.6 s per probe
invocation on this toolchain, so it is affordable inside `client-test`, which is where it must live:
`client/tsconfig.json:15` excludes `**/*.test.ts`, so nothing written in a test file is typechecked
by `just client-typecheck` — which is also why `@ts-expect-error` is unusable here (and it occurs
zero times in `client/src`, recorded as not this repo's house style at
`client/src/ui/overlayRegistry.test.ts:1050`).

Note the division of labour this creates and the EARS wording it satisfies. A11Y-1/A11Y-2 say the
violation "SHALL fail `just client-typecheck`". That is true *because* `OVERLAY_A11Y` is a total
`Record` in an always-typechecked production file — the negative-compile probes are what prove the
antecedent still holds, i.e. that the type has not been quietly weakened into one where the
violation would *not* fail. Running `just client-typecheck` on the tree proves the tree compiles; it
can never prove that something else would not.

**Honest limit, stated rather than overclaimed:** the probes can be *deleted*. Deletion is a visible,
reviewable diff hunk, and the runtime both-directions assertion in `overlayRegistry.test.ts`
independently catches a *missing entry* whatever the type says. What no mechanism in this slice
catches is "probe test deleted **and** type weakened **and** all sixteen entries still present" — a
tree that is currently correct but has lost its guarantee. That is the same residual
`OVERLAY_HANDLES_DECL` carries and is accepted on the same terms.

### D7 — `OVERLAY_A11Y` in `overlayRegistry.ts` does not violate the module's purity rule

Recorded as a verification, not a choice — spec §2.0 already made the placement call. The module's
rule (`client/src/ui/overlayRegistry.ts:4`–`8`) bans DOM, SDK, `main.ts` imports, view handles and
thunks; "every export here is a data table, a total pure function, or … the TYPE of the
caller-supplied probe table". A CSS selector string and an ARIA role name are **strings in a data
table** — none of the five banned things. The module still has zero `import` statements, touches no
`document`, and stays node-testable with zero mocks. `A11yMeta` is the exact analogue of
`OverlayProbes`/`OverlayHandles`: this module owns the *shape* of the a11y contract, and S1's
`overlayA11y.ts` owns the DOM writes. **Hard constraint for every later slice: the table holds no
thunks and no functions.** If a per-id behaviour is ever needed it belongs in `overlayA11y.ts`.

`dismissible` is `true` for all sixteen — Escape closes every one today
(`client/src/main.ts:1300`–`1409`). The field's value is the *constraint*, not the variation; spec
§2.1 non-negotiable #3 requires `EXCLUSIVE_TOP`/`GUARD_ONLY` ⇒ `true`, leaving `HIDE_SWITCH`
unconstrained, and the gate must read `OVERLAY_TIERS` rather than assert "all true" — measured: a
check against a hardcoded id list satisfies every naive bite-proof while silently ignoring a
retiering.

## Consequences

**Good.** One completeness oracle instead of sixteen retrofits; a seventeenth overlay is a compile
error in `OVERLAY_A11Y` exactly as it already is in `OVERLAY_TIERS`/`OverlayProbes`/`OverlayHandles`.
Accessible names are catalog keys from the first commit, so M24 (ADR-0033) swaps the resolver with
zero renaming. `overlayRegistry.ts` stays a zero-import functional core. A11Y-1 and A11Y-2 are gated
by an oracle with no measured bypass, which the house text-pin pattern does not have.

**Costs and obligations created.**
- **S2** must add `tabindex="-1"` to the ten static-shell anchors in D2's table, and `tabindex="0"`
  — not `-1` — to `#menu-rows`.
- **S4** must add four constructor-time `data-testid` attributes (`battle-title`, `box-title`,
  `raising-title`, `evolution-title`) plus `tabindex="-1"`. Attribute-only: adding a *wrapper* would
  break the three `client/e2e/recruit.spec.ts` `parentElement.parentElement` chains noted at
  `client/src/ui/boxView.ts:52`–`55`; adding an attribute does not.
- **S1** must call `t()` where a throw surfaces loudly (overlay-open time), and owns orphan-checking
  `a11y.world.*` / `a11y.announce.*`.
- **S10** must not copy spec §5.1 verbatim: its `[A11Y-02]` regex must permit uppercase (D5) and its
  `[A11Y-04]` orphan direction must stay prefix-scoped (D5), or it reds on sixteen valid keys and on
  S1's own. Its `overlayA11yWiring.test.ts` must accept `tabindex`-focusable targets (D1) with the
  identity assertion as the anti-vacuity device, not a native-tag allow-list.
- The D1 spec amendment is flagged for sign-off; if rejected, S2/S4 absorb it and the table is
  unchanged.

**Rejected alternatives** are recorded inline: a per-`*Model.ts` `A11yState` projection and per-view
ad-hoc ARIA (spec §2.0's table, both falsified there); S2-inserted dead close buttons (D1); literal
`as const` catalog keys (D4); a global orphan check (D5); the textual declaration pin (D6).
