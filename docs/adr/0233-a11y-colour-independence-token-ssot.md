# ADR-0233 — A11Y-29 colour independence: a serde-derived a11y token SSOT in `content.rs`, and a CB-safe default HP palette

**Status:** Accepted
**Date:** 2026-09-02
**Slice:** m23-s8 (M23 §2.6 — colour independence; the only §6 criterion S8 owns is A11Y-29)
**Supersedes:** —
**Amends:** —
**Subsystems:** content, client-ui
**Decision:** A11Y-29's token SSOT is a Rust const table in content.rs checked inside validate_content, not RON: a new game-core/content file forces an out-of-touches baseline edit. The hand-kept roster is proved complete against serde derive metadata.

## Context and problem statement

M23 §2.6 requires that every status/affinity badge carry a text or glyph token rather than
colour alone, and pushes the requirement into the content pipeline: "a new `StatusEffect` or
`Affinity` without an icon/text token fails content validation (A11Y-29)". Two operator
escalations (§8.1 colourblind palette, §8.2 canvas `ACTION_TINT`) blocked the slice; both are
reversible scope/content calls, so per BLOCKER discipline this slice takes the spec's own
recommended defaults (see *Escalation defaults* below) rather than parking.

Three constraints shaped the design, each measured rather than assumed.

**C1 — a new file under `game-core/content/` is out of reach.**
`evals/content-version.eval.mjs:31` `hashContentDir()` walks **every** file under
`game-core/content` (no extension filter) and compares the SHA-256 against
`evals/baselines/content-hash.json`, which is keyed to `CONTENT_VERSION`
(`server-module/src/lib.rs:75`). The baseline has no working `--update` flag. Adding
`a11y_tokens.ron` therefore forces an edit outside this slice's declared `touches:`; the
glob-registry form would additionally force `game-core/build.rs`.

**C2 — the "content is data, not code" invariant does not reach this table.**
ADR-0006 scopes that rule to designer-authored rows (species, skills, zones). The keys here are
`StatusKind` and `Affinity` *variants* — adding one is a Rust edit in
`game-core/src/combat/ability.rs` / `game-core/src/monster/types.rs`, never a content edit. A RON
file whose valid key set is a Rust enum cannot be edited without a code change, and would still
need the identical Rust validator. This is the same call `client/src/ui/helpModel.ts` already
made ("typed TS const, NOT a RON file (YAGNI)"), which M23 §2.8 cites approvingly.

**C3 — the obvious totality devices do not actually force anything.**
Red-team measurement on a faithful reconstruction: adding a 6th `StatusKind`/`StatusEffect` and a
9th `Affinity`, then applying the minimal mechanical fix (one match arm each), **compiled clean**
and the validator returned `Ok(())`. A hand-maintained `STATUS_KIND_ALL` stays at 5, so the
required key set stays at 13; an index-bijection test iterates that roster and so never visits the
new variant; and a `const _: () = assert!(A11Y_TOKENS.len() == 13)` is silent on the omission
while becoming a compile error on the *correct* fix. Worse, three proposed exhaustive `const fn`s
would have added **zero** new compile forcing: `Affinity::index()`
(`game-core/src/monster/types.rs:45`), `StatusKind::matches`
(`game-core/src/combat/ability.rs:55`) and three `StatusEffect` matches in
`game-core/src/combat/status.rs` are already exhaustive no-wildcard gates today.

## Considered alternatives

- **Option A — a `game-core/content/a11y_tokens.ron` registry + loader.** The spec's literal
  reading. Rejected on C1 (forces an out-of-touches edit) and C2 (the keys are type-space).
- **Option B — a const table with a hand-maintained roster and a bijection test.** Rejected on
  C3: measured not to fire on the exact scenario A11Y-29 names.
- **Option C — a `const fn` successor chain plus a const-eval length proof.** PoC'd and measured
  to work (`error[E0080]: STATUS_KIND_COUNT is too small`), but still defeatable by writing two
  `None` arms, and it adds a second data structure to keep honest.
- **Option D — a `strum`/proc-macro derived roster.** A new dependency for one table. YAGNI.
- **Option E (CHOSEN) — a const table whose required-key roster is derived from serde's own
  derive metadata.**

## Decision outcome

- **Chosen: Option E.** `ron::from_str::<T>("<probe>")` returns
  `ron::Error::NoSuchEnumVariant { expected: &'static [&'static str], .. }` — serde's derive
  supplies the complete variant list. Measured in this repo:
  `StatusKind = ["Poison","Burn","Paralysis","Sleep","Freeze"]`,
  `StatusEffect = [same five]`, `Affinity = ["Fire",…,"Dark"]`. `ron` 0.8.1 is already a
  `game-core` dependency (`game-core/Cargo.toml:21`). Adding a variant therefore grows the list
  **mechanically**, and the totality tests red until a token row exists. This is the same class of
  oracle ADR-0229 used (derive metadata, not a source scan) and is what ADR-0224 asks for.
- **The validator takes the table as a parameter and derives its required key set from the
  enums, never from `A11Y_TOKENS`.** Red-team built **eight** forged validators that passed every
  originally-planned test, and **five** of them also survived the operator's demanded data mutant
  (deleting a row from the shipped table), because they re-derived their oracle *from the table*.
  Taking a parameter is necessary but not sufficient; deriving from the enums is what makes a data
  mutant bite.
- **Tokens are validated by charset, not by `trim()`.** The honest validator still accepted
  U+200B ZERO WIDTH SPACE: it is category `Cf`, so `char::is_whitespace` is false and
  `token.trim().is_empty()` is false — an *invisible* "text token". Tokens must be
  `is_ascii_graphic()`, length-banded, and unique under case folding.
- **Reachability:** one line, `validate_a11y_tokens(A11Y_TOKENS)?;`, at the end of
  `validate_content` — no signature change, so all existing call sites including the publish-time
  VALIDATE phase (`server-module/src/content.rs:61`) exercise it. **Stated honestly:** this is a
  *constant-argument* call, so it is genuine wiring but adds no runtime information over a
  `#[test]`. The repo idiom would be a sibling validator called from `server-module/src/content.rs`;
  that file is outside this slice's `touches:`, and the host choice is touch-set-driven.
- **What the runtime call does and does NOT catch.** It catches a hand-edited bad row in the shipped
  table. It does **not** catch a new enum variant: adding a 6th `StatusKind` forces one compile
  error (the arm in `status_token_key`), but `STATUS_KIND_ALL`'s `[StatusKind; 5]` literal still
  typechecks, so the required set stays at 13 and `validate_content` returns `Ok`. That case is
  caught in CI by `m23s8_totality_*` and by nothing at content-sync time. Said plainly so a reader
  does not over-read "fails content validation".
- **Oracle-tier substitution.** M23 section 6 tags A11Y-29 `[SCAN]`, i.e. an eval under `evals/`.
  That directory is outside this slice's `touches:` and ADR-0224 retired scanner-script gates
  outright. The substitute — serde's derive-generated variant list plus in-crate `#[test]`s — is
  strictly stronger than a text scan for the totality property, which is the criterion's content.
- **Two narrow source-scan teeth are used deliberately.** `validate_a11y_tokens`'s body must not
  name `A11Y_TOKENS`, `cfg!`, `debug_assert` or `#[cfg(`, and the wiring call must sit at brace
  depth 1 in statement position. Both exist because the behavioural alternatives were MEASURED to
  be forgeable: a fast path trusting `A11Y_TOKENS` (no fixture reaches it; the one production
  caller always does) and a `cfg!(debug_assertions)` early return (green in the debug builds CI
  runs, dead in the release builds that ship) each passed the entire behavioural suite; and a bare
  substring check on the wiring was defeated four ways — `if false`, a never-true runtime guard, a
  string-literal decoy with no call at all, and a discarded `let _ = ...`. A purely behavioural
  oracle is impossible here because the call takes a compile-time constant.
- **The eight `Affinity` rows are deliberately unconsumed.** `client/src/ui/battleView.ts:283`
  already renders the affinity *name* as text, so a new `Affinity` ships with a text cue for free.
  The rows exist because A11Y-29 names `Affinity` literally. Recorded here rather than left for a
  future reader to discover and delete.
- **Tokens are literals, not `a11yCopy.ts` keys.** M23 §2.8's copy-key rule is scoped to
  accessible *names*; §2.6 routes this requirement through the *content* pipeline. M24 localises
  these via the content path, not the a11y catalog.

### The client half

`statusBadge`'s default arm returned `''` (`client/src/ui/battleModel.ts:71-82`), which combines
with `... || null` (`:227`) and `if (card.status)` (`client/src/ui/battleView.ts:286`) to remove
the badge from the DOM entirely — a status becomes *invisible*, which is strictly worse than
colour-only. It is unreachable in a same-checkout build (`battleModel.test.ts:962-970` pins the
generated variant count) and live only under deployed-server / stale-client-bundle skew. The
default arm now returns a visible derived token.

**This change hollows a shipped tooth if done naively, and that is the load-bearing part.**
`client/src/ui/battleModel.test.ts:972` asserts `statusBadge(v.name).length > 0` over the
generated `StatusEffect` variants. Measured: with the old `''` default, deleting `case 'Poison'`
reds 2 tests; with a visible fallback, the same mutation is 118/118 **green**. The fallback is
therefore exported as a named derivation `unknownStatusToken(tag)` — never a shared constant,
which a dedicated test kills — and the m14.5d loop additionally asserts
`badge !== FALLBACK` and zero `console.warn` calls, restoring the bite.

### The palette (escalation §8.1, default (a))

The HP severity trio (`client/src/ui/battleView.ts:276`) was `#4a4 / #aa4 / #a44` — a red/green
pair. Measured greyscale contrast between *healthy* and *wounded*: **1.21:1** (L 0.3039 vs
0.3770), i.e. indistinguishable without hue. Replaced with `#4a90d9 / #f0aa44 / #ffe680` — a
blue → amber → pale-yellow axis all three dichromacies preserve.

The contract is **computed from the rendered DOM**, never compared against pinned hex literals:
**P1** each fill ≥ 3:1 against the rendered bar track; **P2** WCAG relative luminances strictly
monotone with severity, every pair ≥ 1.5:1. The **track at `:255` is deliberately NOT edited**:
darkening it from `#333` to `#111` alone would satisfy P1 with the red/green pair untouched
(measured: 2.18 → 3.25), and `#333` is already only 1.20:1 against the player card background.
P2 is what forecloses that route.

Measured margins: P1 3.78 / 6.34 / 10.16 against the 3.0 floor; P2 adjacent 1.68 and **1.60**
against the 1.5 floor. The wounded-to-critical leg is the thin one — a future colour tweak can erode
it unnoticed, so retune that pair only against a re-run of the P2 case.

**Honest limits, so a later reader does not over-read the gate:** P2's 1.5:1 floor is a *project*
threshold, half of WCAG's 3:1 non-text minimum; a brute-force search found **68** palettes passing
P1+P2 that keep red/green hue coding, so P2 forces a real improvement but does not force hue
coding away. There is no Brettel/Viénot dichromacy simulation (declared non-goal, not a silent
skip). And the three colours are never co-present — one shows at a time — so the load-bearing
colour independence remains the numeric HP text at `:283` and the bar width; the palette is
honest belt-and-braces, not the fix.

### Escalation defaults taken (spec §8, BLOCKER discipline)

- **§8.1 → (a)** redesign the *default* palette to be CB-safe for everyone. Option (b), an opt-in
  theme, requires the settings store §2.9 explicitly cuts, dragging M25 scope into M23.
- **§8.2 → (a)** `ACTION_TINT` (`client/src/render/placeholderAssets.ts:15`) is accepted as **out
  of scope** for M23 under the spec's own §3.1 partial-conformance declaration (WCAG 1.4.11
  Non-text Contrast: sprite art contrast is an art-direction property). Zero edits under
  `client/src/render/`. Tracked as residual **R-m23-s8-TINT**, not silently dropped.

## Consequences

- **Positive:** adding a `StatusKind`/`StatusEffect`/`Affinity` variant now mechanically fails
  until it has a token, with no hand-maintained roster anywhere in the chain. The eight measured
  validator forgeries and the three invisible-token shapes are closed. The default palette is
  colourblind-safe rather than opt-in.
- **Negative / accepted:** the token table sits outside `content-hash` and `append-only-ids`
  coverage, so a key rename is invisible to those gates — mitigated by a test pinning the exact
  shipped `(key, token)` pairs, making a rename a deliberate reviewed diff. Folding an a11y
  concern into `validate_content` is a mild cohesion cost, taken because the idiomatic host is out
  of `touches:`; `validate_content`'s doc comment is updated so it does not become a lie.
- **Residuals:** **R-m23-s8-TSDUP** (backlog) — `client/src/ui/battleModel.ts:58` `statusBadge`
  remains a hand-kept TS mirror of `A11Y_TOKENS`; token *values* are byte-identical and the
  m14.5d tooth covers variant drift, but nothing correlates the two tables. A mechanical link
  would be a text scan (retired by ADR-0224) or client-wasm codegen (out of `touches:`).
  **R-m23-s8-TINT** (art ticket) — above. **R-m23-s8-TITLE** (S9/backlog) —
  `client/src/ui/battleView.ts:308` exposes skill affinity only through `btn.title`, a
  name/availability gap rather than a colour-independence one; named, not fixed here.
  **R-m23-s8-BORDER** (S9/backlog) — the battle card borders still use the same red/green pair this
  ADR calls colourblind-hostile: `#844` on the opponent card (`client/src/ui/battleView.ts:109`) vs
  `#484` on the player card (`:116`), and `#844` Flee vs `#6a6` swap/recruit (`:330`, `:399`). All
  carry text labels, so none is an A11Y-29 violation, but they are the same defect class one
  screenful away and this slice did NOT survey them.
  **R-m23-s8-RUNTIME** (backlog) — the runtime-vs-CI split named above: a NEW enum variant fails
  `m23s8_totality_*` in CI but not `validate_content` at content-sync time. The idiomatic fix is a
  sibling validator called from `server-module/src/content.rs`, which is outside this slice's
  `touches:`. Given an ID so the concession is queued rather than only prose.
  **R-m23-s8-FALLBACK-COLLIDE** (backlog) — the client fallback carries two characters of entropy
  after its `?`, so two unknown server statuses can share a badge (`Confusion` and `Corrosion` both
  render `?CO`). Accepted: the badge's job is to prove a status EXISTS during deployed-server /
  stale-bundle skew, and three characters is the badge's pinned layout budget.
- **Note for slice S9:** do not re-home these hex values into `:root` custom properties in
  `client/src/styles.css` — `styles.css:87-89` bans custom properties on the fill and
  `evals/reduced-motion-hp-bar.eval.mjs` gates it.
