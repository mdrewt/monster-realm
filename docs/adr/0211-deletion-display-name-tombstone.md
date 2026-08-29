# 0211 — Deletion display-name tombstone: a constant single-sourced to game-core, narrowing server-module reach

**Status:** Accepted
**Date:** 2026-08-29
**Slice:** rb-7 (residual R-m22-s1-X2)
**Supersedes:** —
**Amends:** —
**Subsystems:** security-authz, ci-gates
**Decision:** `game_core::TOMBSTONE_DISPLAY_NAME` is the one deletion display-name tombstone; `PROFILE_TOMBSTONE_NAME` and the only other symbol that writes it both go module-private, so the compiler refuses the two reuse paths S3 must not take.

---

## Context and problem statement

M22 §3 requires `player.name` and `profile.name` to be overwritten with a tombstone on account deletion. §7.2's S1 row lists six symbols and omits a name tombstone, so S1 shipped none. The only existing constant is `server-module/src/ranking.rs`'s `pub(crate) const PROFILE_TOMBSTONE_NAME = "(claimed guest)"`, the M21 guest-claim sentinel whose `tombstoned_profile()` also zeroes rating/wins/losses. Reusing it for a genuinely deleted account makes the row read as an unclaimed guest — conflating two distinct lifecycle states. Single-source the deletion tombstone name so S3 cannot silently reuse it.

## Considered alternatives

- **A — reuse `PROFILE_TOMBSTONE_NAME` as-is.** Rejected: it belongs to guest-claim, a different lifecycle; using it for deletion conflates two unrelated states and violates data-integrity semantics.
- **B — declare the new constant in `server-module/src/ranking.rs` beside `PROFILE_TOMBSTONE_NAME`.** Rejected: `ranking_tests.rs` already mirrors deletion tests from `deletion_tests.rs`, so the test surface would be fragmented across two crates; the constant is an M22 game rule, not an M21 server detail.
- **C — declare in `game-core/src/accounts/deletion.rs` beside `TOMBSTONE_IDENTITY_BYTES`/`TOMBSTONE_AUTH_ISSUER`, and re-export flat (chosen).** Game-core owns the M22 deletion sentinel family as a unit. Flat re-export is required: `game-core/tests/m22_s1_deletion_surface.rs:1-17` exists precisely to guarantee `use game_core::TOMBSTONE_*;` for S2/S3/S4, so making the deletion name the single deep-path outlier is how an S3 author ends up reaching for `PROFILE_TOMBSTONE_NAME` — the exact failure this slice exists to prevent.
- **D — lift `PROFILE_TOMBSTONE_NAME` into game-core too.** Rejected as YAGNI: it is an M21 server-module detail with no game-core rule behind it; a guest-claim table lives only in the server.

## Decision outcome

**Chosen: C.** `pub const TOMBSTONE_DISPLAY_NAME: &str = "(deleted account)"` is declared in `game-core/src/accounts/deletion.rs` alongside `TOMBSTONE_IDENTITY_BYTES` and `TOMBSTONE_AUTH_ISSUER`, and re-exported flat at the crate root by appending it to the two pre-existing `pub use` lists in `game-core/src/accounts/mod.rs` and `game-core/src/lib.rs` — the same lists that already carry all six S1 symbols.

The value `"(deleted account)"` was selected per D2 below. A doc comment records the ownership boundary: game-core owns the value; server-module owns the charset and length rules (`guards::validate_name`, `MAX_NAME_LEN`), which game-core deliberately never restates.

`PROFILE_TOMBSTONE_NAME` and its accessor `tombstoned_profile` in `server-module/src/ranking.rs` are narrowed from `pub(crate) const` and `pub(crate) fn` to plain `const` and plain `fn`, making them unreachable outside the module. Compiler-enforced unreachability beats a convention or a text ban: illegal states become unrepresentable, so S3 cannot accidentally reuse them. No eval pins visibility, and there is no dead-code or clippy consequence: `tombstoned_profile` keeps the const live, `unreachable_pub` is allow-by-default and `clippy::redundant_pub_crate` is nursery.

### Why the value is unpinned by spec

M22 §3:106,108 says *"the tombstone constant"* and *"tombstone"* with no literal. §8.2 (line 558–563) decided the tombstone SHAPE (one shared sentinel, not per-account) and explicitly did NOT escalate it to an operator decision; the value is absent from all five §8 operator escalations. Tests assert PROPERTIES — non-blank, distinct from `TOMBSTONE_AUTH_ISSUER`, trim-stable, printable-ASCII-only, in-cap and rejected by the real `validate_name` — never the literal string, so retuning the constant is a one-literal edit. This record must not imply the spec chose the string, and deliberately never applies the word the §9.1 sentence below rules out to the name write.

### Required language from M22 §9.1

Direct name/display fields are severed on deletion. The `Identity` key and its associated timestamps/behavioral history are not purged from multi-user or historical rows; this is a documented, accepted pseudonymization limitation, not erasure.

### Compiler proof and proof of teeth (ADR-0010)

Full reference enumeration (grep + CodeGraph + codebase-memory, all three agree): the declaration, its single use inside `tombstoned_profile`, and the `super::`-qualified reads in `ranking_tests.rs` — which still resolve, because `ranking_tests` is declared inside `ranking.rs` and is therefore a descendant module. Everything else that names the constant is prose: a comment in `evals/ranking-security.eval.mjs` and a row in ADR-0179. Deliberately NO numeric line citations here: this slice's own doc comment shifted every one of them, and seven stale `ADR-0180:<line>` cites are already on the corpus record.

**B3 clause set — visibility pin over stripped source** (measured against red-team bypasses, all keeping the const private and all leaving B3 GREEN while genuinely restoring cross-module reach to the guest-claim tombstone):

1. **B3a — declaration shape.** The identifier `constPROFILE_TOMBSTONE_NAME` occurs EXACTLY ONCE in `stripped_for_scan(RANKING_RS)` and the char immediately preceding it is neither `b` nor `)`. Every visibility form squashes to one of those two (`pubconst` / `pub(crate)const` / `pub(super)const` / `pub(self)const` / `pub(in crate::ranking)const`), and nothing else can — an attribute squashes to `]` and an ordinary item boundary to `}` or `;`. Fixes the measured false-RED on a perfectly compliant `#[allow(dead_code)]`-annotated private const (attributes squash to `]`).
2. **B3b — identifier-leak pin.** The identifier `PROFILE_TOMBSTONE_NAME` occurs EXACTLY TWICE in the stripped view — the declaration plus its single use in `tombstoned_profile`. Any third occurrence REDs. This closes two measured bypasses the declaration-shape check alone could not see: a `pub(crate) use self::PROFILE_TOMBSTONE_NAME;` elsewhere in the file, and a `pub(crate) fn` accessor returning the constant.
3. **B3c — value-leak pin, over the RAW (unstripped) file.** The guest-claim VALUE `"(claimed guest)"` occurs exactly once in `RANKING_RS` verbatim. This clause is deliberately RAW: the lens's finding that `stripped_for_scan` blanks string CONTENT means a stripped scan for a string VALUE is structurally vacuous — a raw one is not. Kills the two measured bypasses that carry the value out under a new identifier or none at all: a same-valued alias const, and a `macro_rules!` yielding the literal.

4. **B3d — writer pin.** `tombstoned_profile`, the only other symbol that writes the sentinel, is module-private too. B3b cannot see this one: a call from `accounts.rs` leaves *this* file's identifier count at two, and reached that way the helper is doubly wrong — the row renders as an unclaimed guest AND its ladder stats are wiped by a zeroing that ADR-0179 D6 scopes to guest-claim alone. Found by the reducer-security audit, not by the plan.

**Additional property checks in the test suite:**

- **A1** (`deletion_tests.rs`) — non-blank, trim-stable, printable-ASCII-only (no control/format chars that render blank or corrupt a leaderboard).
- **A2** (`deletion_tests.rs`) — `assert_ne!` against the live `TOMBSTONE_AUTH_ISSUER`. It deliberately does NOT hand-type `"(claimed guest)"`: an un-synced copy of a server-module-private string in game-core would be the very SSOT hazard this slice removes.
- **B1** (`ranking_tests.rs`) — the EXECUTABLE twin, all three together load-bearing: `!trim().is_empty()`, `chars().count() <= crate::MAX_NAME_LEN`, `crate::guards::validate_name(..).is_err()`.
- **B2** (`ranking_tests.rs`) — `assert_ne!` between the two LIVE symbols via the FLAT cross-crate path `game_core::TOMBSTONE_DISPLAY_NAME`, which doubles as the S1-style flat-reachability proof. A second assertion requires the two to stay distinct after case-folding and whitespace-squashing: `"(Claimed guest)"` and `"(claimed  guest)"` both pass a bare `assert_ne!` while reproducing exactly the confusion this criterion names.
- **B5** (`ranking_tests.rs`) — machinery teeth for B3: the battery size is pinned by assertion, and a fixture recording the char-literal quote desync interaction documents why the scan desynced (preventing a future maintainer from suspecting symbol removal).

**Proof-of-teeth mechanics.** `rb7_scan_machinery_teeth` runs 17 fixtures (3 pass, 11 bite, 3 fail-loud), battery size pinned by assertion. The load-bearing measurement is that B3a SEMANTIC-REDs against the unmodified pre-fix `ranking.rs` — preceding squashed char `)` — rather than merely failing to compile for want of a symbol. Each mutant was then applied to the REAL file, not just to a fixture: a re-widened `pub(crate) const` REDs B3a; the `pub use self::…` re-export family is closed by rustc E0364 (not by a tooth — an honest statement in the ADR); a `pub(crate) fn` accessor REDs B3b; a same-valued alias const and a `macro_rules!` carrying the literal RED B3c; a re-widened `pub(crate) fn tombstoned_profile` REDs B3d; `#[allow(dead_code)]` above the compliant const correctly PASSES (a regression pin against a false-RED).

A `slash-star` glob spelled in a comment opened a block comment for the naive string-stripper several evals use, blanking 31 tables and reddening 5 unrelated evals — a full-CI-only false RED. Fixed by rewording to avoid that two-character sequence.

SpacetimeDB's code generator textually rejects print macros anywhere in a module, including `#[cfg(test)]` code, which is why the teeth marker is written through `io::Write` instead of a macro.

## Residuals

**B3c is a RAW substring scan over `ranking.rs` and is therefore blind to:**

- A value spelled `concat!("(claimed ", "guest)")` or `"\u{28}claimed guest)"` — both MEASURED green by red-team against the shipped gate — and blind to a literal hand-typed in `accounts.rs`, which is outside this slice's touches.

**Hand this to M22 S3/S6 in promotable form:** `evals/deletion-completeness.eval.mjs` (S6, spec §7.1) should assert POSITIVELY that the cascade's `player.name`/`profile.name` writes reference `game_core::TOMBSTONE_DISPLAY_NAME` by symbol, using a RAW (unstripped) scan for any literal check — a scan over stripped source is structurally vacuous for a string VALUE because the stripper blanks string content.

**Two smaller accepted limits:**

- B3b's exact-2 identifier count will false-RED (safely) if a legitimate second use of the constant lands in `ranking.rs`.
- The `RB7-TEETH-OK` marker is only visible under `--no-capture`, so it is a gate-CHECK affordance rather than a CI-visible signal — the battery-size `assert_eq!` is what actually prevents decay.

**Flat-reachability proof:** `game-core/tests/m22_s1_deletion_surface.rs` was deliberately NOT extended (outside touches). Flat crate-root reachability is instead proven cross-crate by `server-module/src/ranking_tests.rs`'s `rb7_deletion_tombstone_is_distinct_from_guest_claim`, which resolves the constant via the flat path and asserts it is distinct from the guest-claim value.
