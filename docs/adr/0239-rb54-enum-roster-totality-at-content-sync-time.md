# 0239 — Enum-roster totality is proved at content-sync time from the SpacetimeType derive, above the version gate

**Status:** Accepted
**Date:** 2026-09-05
**Slice:** rb-54 (residual R-m23-s8-postmerge, M-residual-backlog.spec.md#rb-54)
**Supersedes:** —
**Amends:** —
**Extends:** ADR-0233 (adds a sync-time enforcement point to its A11Y-29 token contract), ADR-0229 (lifts its derive-metadata pattern from tests into production), ADR-0055 (release fail-loud)
**Subsystems:** content, ci-gates
**Decision:** content.rs proves the StatusKind/Affinity rosters are complete by reflecting the SpacetimeType derive, called above sync_content_inner's version gate, so a new enum variant fails the publish rather than only a CI test.

---

## Context and problem statement

`game_core::validate_a11y_tokens` (`game-core/src/content.rs:1768`) builds the set of a11y token
keys it REQUIRES from two **hand-maintained rosters**:

- `pub const STATUS_KIND_ALL: [StatusKind; 5]` — `game-core/src/content.rs:1641`
- `Affinity::ALL: [Affinity; 8]` — `game-core/src/monster/types.rs:28`

mapped through the exhaustive `status_token_key` / `affinity_token_key`.

Adding a sixth `StatusKind` variant **is** a compile error in `status_token_key` — it has no
wildcard arm. Measured, it is a compile error in four places: `status_token_key`
(`game-core/src/content.rs:1658`), the `applies_status` cross-check (`:820`), `StatusKind::matches`
(`game-core/src/combat/ability.rs:57`) and the status-application match
(`game-core/src/combat/resolve.rs:177`). The author fills four arms and the workspace compiles
again. (The upstream note at `game-core/src/content.rs:7490` says "the one match arm"; that is
stale, and this ADR repeated it before it was re-measured.) None of those four sites is the roster:
the fixed-size `STATUS_KIND_ALL` does not grow. The new key therefore never enters `required`, `A11Y_TOKENS` is
never asked for a row, and **`validate_content` returns `Ok(())`**. ADR-0233 records this as
measured, and `game-core/src/content.rs:7488-7494` states it in the source — adding a sixth variant
plus the arms it forces "was MEASURED to compile clean with the validator still returning `Ok(())`"
(that note says "the one match arm"; only the arm count is stale, the conclusion is exactly right).

This slice re-measured the whole scenario end to end rather than trusting the note: with
`StatusKind::Frostbite` added, all four arms filled and `STATUS_KIND_ALL` left at five entries, the
workspace compiles and `content::tests::content_parses_and_validates` — which calls
`validate_content` — still **passes**.

The only thing that catches it is `m23s8_totality_status_kind_variants_have_tokens`
(`game-core/src/content.rs:7845`), a `#[cfg(test)]` test. That is the residual m23-s8 filed as
`R-m23-s8-postmerge` and the criterion this slice closes:

> content-pipeline validation runs at CI time, not content-sync time — a new enum variant fails CI
> rather than `validate_content`.

The concrete cost of CI-only enforcement: a status a monster can actually carry ships with a colour
cue and no text token — the exact A11Y-29 failure ADR-0233 exists to prevent — and the content
pipeline reports success while doing it.

## Decision

### D1 — The `SpacetimeType` derive is the oracle, in production code, with zero new dependencies

`StatusKind` (`game-core/src/combat/ability.rs:38`) and `Affinity`
(`game-core/src/monster/types.rs:12`) both carry
`#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]`, and `server-module`
enables that feature. `<T as SpacetimeType>::make_type(&mut ts)` against a never-interning
`TypespaceBuilder` therefore yields the **derive-generated** variant-name list — the same class of
oracle that game-core's tests get from serde through `ron`'s `NoSuchEnumVariant`, but reachable
from production server-module code.

This matters because the alternative was unreachable: `ron` and `serde` are **not** `server-module`
dependencies, and `server-module/Cargo.toml` is outside this slice's declared touch set. ADR-0229
already sanctioned the inline never-interning `TypespaceBuilder`, but only inside a test module
(`server-module/src/accounts_tests.rs:10791-10801`); this ADR lifts the pattern into production.

Verified before the design was accepted: reflection returns
`["Poison","Burn","Paralysis","Sleep","Freeze"]` and the eight `Affinity` names, and
`cargo build -p monster-realm-module --target wasm32-unknown-unknown` succeeds.

### D2 — The check runs ABOVE the version gate

`validate_enum_rosters()?;` is the first statement of `sync_content_inner`, above the
`content_version == CONTENT_VERSION` early return.

The reason is not merely "type space is not content". It is that the predicate is
**data-independent**: it is evaluated entirely from compiled constants, so for a fixed wasm
artifact it is always-`Ok` or always-`Err`. It cannot be flaky, cannot depend on database
contents, and cannot begin failing on a database that was previously fine. Running it above the
gate therefore costs **zero** operational risk.

Below the gate it would be unreachable in its own primary threat model. Adding an enum variant does
not change any file under `game-core/content/`, so it does not move `CONTENT_VERSION`; a republished
module would short-circuit at the version gate and never validate anything. A below-the-gate
placement is a no-op validator for the exact scenario it exists to catch.

**This is why the call site carries a comment stating the reason.** Moving it down into the VALIDATE
phase — which is where a future tidy-up would naturally put it, since that is where every other
validator lives — is a silent, total no-op. The source pin and the comment both exist to prevent
that.

Accepted cost: the previously-free "already current, return `Ok`" fast path now performs two
`make_type` reflections and two small `Vec<String>` allocations on every `sync_content` call, and can
newly fail on a path that was previously infallible.

### D3 — Totality by cardinality and distinctness, not by name convention

`check_roster_is_total::<T>(enum_name, roster)` reflects `T` internally and asserts:

1. the reflected list is a named-variant sum with at least one variant;
2. `roster.len() == reflected.len()`;
3. the roster's entries are pairwise distinct.

For a fieldless enum with a derived `PartialEq`, (2) + (3) + type-safety imply the roster **is** the
complete variant set. That is the whole theorem, and it is convention-free.

Two shapes were considered and rejected:

- **Comparing key strings to lowercased variant names**, as game-core's own test does
  (`game-core/src/content.rs:7852-7860`). Rejected: it would hard-code a game-core spelling
  convention into server-module, so a future `StatusKind::SuperBurn` keyed `"status.super_burn"`
  would false-RED the *server* over a *game-core* naming choice that nothing declares.
- **Re-deriving the reflected list from the table it is meant to check** in any form. That is the
  forgery family game-core records eight measured instances of
  (`game-core/src/content.rs:1753-1757` and `:7968-7974` — there the eight forged validators
  re-derived their oracle from `A11Y_TOKENS` itself). The analogous forgeries here are prevented by
  a combination of type binding and body pins — see D4.

### D4 — The oracle is bound to the roster's element type in the signature

`check_roster_is_total<T: SpacetimeType + PartialEq + Debug>(enum_name: &str, roster: &[T])` takes
**no `reflected` parameter**. An earlier design passed the reflected list in, to make the check
injectable for tests. The plan-phase red-team measured two CI-clean forgeries that seam enabled:

- `reflected.into_iter().zip(ROSTER.iter()).map(|(n, _)| n)` — `zip` silently truncates the
  reflected list to the roster's length, reads like "pair each variant with its row", and is a
  permanent no-op;
- reflecting `StatusEffect` while labelling it `"StatusKind"` — undetectable today, because both
  reflect to the byte-identical list `["Poison","Burn","Paralysis","Sleep","Freeze"]`, and the two
  types are near-synonyms that `game-core/src/combat/ability.rs:34-36` documents as a coupled pair.
  A plain typo would produce a permanently silent validator.

Binding `T` to the roster's element type eliminates both forgeries **at `check_roster_is_total`'s
call boundary**. The negative test fixture gets stronger as a result, not weaker: a test passes a
deliberately short slice of the **real** shipped roster (`&STATUS_KIND_ALL[..4]`), which is a truer
negative than a synthetic list.

**That binding is not by itself sufficient, and an earlier draft of this ADR wrongly claimed it
was.** The artifact red-team measured the same substitution planted one and two frames further
down — inside `reflected_variant_names` (branching on the `enum_name` label) and inside
`EnumRosterTypespace::add` (keyed on `TypeId`) — passing all ten original teeth *with a real
unrostered sixth variant present*. Both frames are now pinned: `add`'s body must equal
`make_ty(self)`, the oracle's body may not name a concrete `game_core::` type, and a behavioural
tooth reflects `Affinity` under the label `"StatusKind"` so a label-keyed oracle diverges. The
honest summary is that the type binding removes the forgery from the call boundary and explicit
pins remove it from the two frames below; it is not eliminated by typing alone.

**Contract:** `T` must be a fieldless enum with a derived `PartialEq`. For a payload-carrying enum,
distinct *values* are not distinct *variants* — `[…, Sleep { turns_remaining: 1 }, Sleep {
turns_remaining: 2 }]` is length-5 and pairwise distinct with `Freeze` missing. This is documented
on the function and is the reason `StatusEffect` is not passed to this helper (see Residuals).

### D5 — Fail-loud is correct here, and bounded

`init` does `sync_content_inner(ctx).expect("content seeding failed on init")`
(`server-module/src/lib.rs:170`), so an `Err` panics module init; `sync_content`
(`lib.rs:206`) returns `Err` behind its owner check. Both are deliberate.

This adds a member to an existing failure class rather than creating a new one — every `validate_*`
call in the VALIDATE phase already panics `init` today. `init` runs only at database creation
(`lib.rs:191-193`), so a running database cannot be taken down by this; the blast radius is "an
internally inconsistent artifact fails to publish", which is the desired outcome. The error string
carries only public enum variant names, so there is no information-disclosure surface. Consistent
with ADR-0055 and ADR-0049 §5.

Because the remedy is a **source** edit, the error message says so explicitly — re-publishing the
same artifact cannot clear it.

### D6 — What this does and does not claim

This slice does **not** make `game_core::validate_content` fail on a new variant. It adds a
*sibling* server-side gate; `validate_content` stays blind to the variant exactly as ADR-0233
describes. The accurate claim is: **a new enum variant now fails the server module's publish-time
validate phase**, not "fails content validation". The practical gap is small — `validate_content`
has exactly one non-test caller in the tree, `server-module/src/content.rs:67` — but the distinction
is recorded so no future reader over-reads the guarantee. Note the phase name precisely: the call
sits ABOVE the `LOAD`/`VALIDATE`/`WRITE` phase markers entirely (D2), so "fails at content-sync
time" is right and "fails in the VALIDATE phase" would not be.

Equally, this is **defence in depth behind** the game-core CI tests, not a replacement for them. A
developer adding a sixth variant still sees `m23s8_totality_status_kind_variants_have_tokens` go red
first — and, measured, `evals/spacetime-type-snapshot.eval.mjs` reds too, on the variant-order
baseline. So a new variant already had two CI detectors before this slice; the honest value added is
a third detector that lives in the module itself and a sync-time failure with an actionable message,
not a previously-undetectable defect becoming detectable.

Worth stating plainly, because it bounds the claim: since the predicate is data-independent and the
host test suite evaluates the same function, **any artifact whose CI is green necessarily has
`validate_enum_rosters() == Ok(())` in the shipped wasm.** The reducer wiring therefore cannot fire
in a CI-green build; its value is for a build that skipped or subverted CI, and for making the
failure legible at the point content is loaded rather than in an unrelated test. The cost is two
reflections and two small allocations on every `sync_content`, including the previously-free
already-current fast path.

## Consequences

- A new `StatusKind` or `Affinity` variant whose roster entry is missing fails `init` on a fresh
  database and fails any explicit owner-only `sync_content` call. It does NOT block the wasm build
  and does NOT block `just publish` onto an EXISTING database — `init` runs only at database
  creation (D5), so a drifted module publishes fine over a live DB and the `Err` surfaces on the
  next sync. An earlier draft said "unpublishable", which overstated it and contradicted D5.
- `server-module` gains runtime type reflection in production. The never-interning builder has no
  depth cap, so a self-referential type would recurse until the stack is exhausted and the process
  aborts — safe for the two fieldless leaf enums actually reflected. The test-only precedent
  (`accounts_tests.rs`) documents this hazard AND carries an explicit depth cap in its consumer;
  this slice lifts the builder without the cap, so the contract is carried by a doc comment on
  `EnumRosterTypespace` instead. That comment was claimed by an earlier draft of this ADR before it
  was actually written; it is now shipped.
- Known residual hole, stated rather than papered over: collapsing `status_token_key`'s arms **and**
  deleting the resulting orphan `A11Y_TOKENS` rows passes both this check and
  `validate_a11y_tokens`'s orphan-key branch. That combination is still red in CI at
  `game-core/src/content.rs:7861`. Key injectivity was deliberately not re-proved here — a
  collapsed key fn is not "a new enum variant", and every single-step form of it already errors at
  content-sync time through the orphan-key branch at `game-core/src/content.rs:1786-1791`.
- A variant renamed without updating its token key (e.g. `Freeze` → `Frozen`, key left
  `"status.freeze"`) is cosmetic key staleness, not a missing token; it remains a CI-only concern.

## Residuals

- `R-rb-54-STATUSEFFECT-PAIR` → backlog. The `StatusKind`/`StatusEffect` variant sets must be
  identical, and today that is asserted only by `m23s8_totality_status_kind_matches_status_effect`
  (`game-core/src/content.rs:7947`) — the same CI-only weakness this ADR fixes for the rosters. It
  is deliberately **not** folded in here: it is a different invariant needing a different kernel
  (set-equality between two reflected name lists, no roster walk), the `PartialEq` roster contract
  in D4 does not hold for `StatusEffect`, and `validate_a11y_tokens`'s required-key set never
  mentions `StatusEffect`, so closing `StatusKind` + `Affinity` fully closes the a11y-roster hole
  this criterion is about. Sketch for the successor slice: reflect both enums, assert both lists
  non-empty and duplicate-free, then compare as sets.
