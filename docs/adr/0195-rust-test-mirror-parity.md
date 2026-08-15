# 0195 — Rust test-mirror parity: derived scan sets, source-derived reducer enumeration, and the Account legal-state invariant

**Status:** Accepted
**Date:** 2026-08-15
**Slice:** 13r-h
**Supersedes:** —
**Amends:** ADR-0179
**Subsystems:** ci-gates, security-authz, schema-persistence
**Decision:** Close ADR-0179 §9's parity residuals: EG2-9 scans src/ per-file via read_dir, the G2 mirror ports the JS eval's full defenses, and Account gets a debug_assert'd invariant + exact shape tripwire instead of an enum fold.

## Context

ADR-0179 §9 (its ninth amendment item) handed forward three Rust test-mirror residuals,
queued as slice 13r-h of M-postgate-thirteenth-review-residuals:

1. `accounts_tests.rs`'s G2 mirror iterated a **hardcoded 5-reducer needle list**, blind to
   an ADDED reducer — the proven E1/E2 bypass shape its JS twin
   (`evals/guest-claim-integrity.eval.mjs`) was explicitly hardened against.
2. `evolution_tests.rs`'s `scheduled_scan_sources()` hardcoded **10 files**, omitting
   `accounts.rs` (`guest_claim_reaper`) and `observability.rs` (`mr_heartbeat`) — EG2-9's
   Rust mirror did not cover the two newest scheduled reducers, while the JS twin
   (`no-idle-accrual.eval.mjs`) reads the directory dynamically.
3. `schema.rs`'s `Account` permits illegal states: `status: AccountStatus` plus an
   independent `deletion_requested_at_ms: Option<i64>`, and half-settable
   `claimed_from`/`claimed_at_ms`. M22 will extend `delete_account` (grace window +
   cascade) on top of this shape.

**Honest wound classification (adversarial-review finding):** none of these is a live,
unguarded hole. `just ci`'s eval stage already defends all three properties dynamically
(`guest-claim-integrity.eval.mjs` enumerates reducers from source with an exact
sanctioned-set pin; `no-idle-accrual.eval.mjs` Check B scans the full `src/` tree). The
wound is **toolchain-boundary parity**: the Rust mirrors — the layer that runs under a bare
`cargo test`, feeds the mutation suite, and survives if an eval is ever de-scoped — were
weaker than the evals they mirror. A mirror weaker than its twin is a false assurance.

## Decision

- **D1 — No enum fold; invariant + tripwire instead.** Folding `deletion_requested_at_ms`
  into `PendingDeletion { requested_at_ms }` (and pairing the claim provenance) would
  change column TYPES on a live table — non-additive under ADR-0006/ADR-0173 D5 (live
  SpacetimeDB accepts only tail-appended `#[default(...)]` columns) — and would force
  `spacetime generate` regeneration of `client/src/module_bindings/**` plus re-baselining
  of `evals/baselines/table-schemas.json` and `spacetime-types.json`, all outside this
  slice's declared `touches:`. The fold is not a declined preference; it is a
  milestone-scoped migration. Recorded here so M22 can pick it up deliberately if it
  chooses a breaking-migration window.
- **D2 — The struct-shape gating mechanism is the Rust mirror test, not an eval.** The
  spec's words were "eval-gated struct-shape tripwire"; `evals/**` is outside the declared
  `touches:`, and the wound class here IS Rust-mirror weakness. The tripwire lives in
  `accounts_tests.rs`, pins the squashed `Account` field body and `AccountStatus` variant
  list by **exact equality** (never `.contains` — an appended field survives containment),
  and its failure message instructs M22's author to re-derive the invariant consciously.
- **D3 — All five Account-returning pure constructors carry the postcondition** (the spec
  said "four"; `accounts.rs` has five: `new_account_row`, `touch_login`,
  `requested_deletion`, `cancelled_deletion`, `claimed_account`). A uniform postcondition
  leaves no "which one was exempt?" question at M22. The invariant is ONE pure predicate:
  `Active ⇒ deletion_requested_at_ms.is_none()`, `PendingDeletion ⇒ .is_some()`,
  `claimed_from.is_some() == claimed_at_ms.is_some()` — `debug_assert!`'d at each
  constructor return (compiles out of release wasm; ADR-0049 policy, `observability.rs`
  precedent), with a direct table-driven unit test as the profile-independent teeth.
- **D4 — Derived scan sets over hardcoded lists, with named basename anchors, never count
  floors** — the pattern ADR-0179 amendment 1 ratified for `pvp_tests.rs`
  (`collect_scan_sources`: recursive `read_dir` of `CARGO_MANIFEST_DIR/src`, `*.rs` minus
  `*_tests.rs`, every I/O error a loud panic), now applied to EG2-9. The scheduled-reducer
  anchor set extends from five to seven (`guest_claim_reaper`, `mr_heartbeat` added).
- **D5 — EG2-9 processes sources PER-FILE, never as a joined blob.** Name discovery, the
  L1 wrapper enumeration, and body lookup each run per file with file attribution in every
  failure. Rationale (adversarial finding): in a concatenated blob, a phantom-open `'{'`
  char literal near one file's end would make a brace-walk consume the next file — masking
  real violations across a file boundary. A per-file net-brace-balance assert was REJECTED
  because `observability.rs`'s `line.push('}')` makes that file legitimately net-imbalanced
  today (char literals are deliberately preserved by `strip_comments_and_strings`). The
  residual hazard — a phantom brace truncating its OWN fn's body — is covered for the two
  new reducers by positive body anchors (`guest_claim_reaper` body must contain
  `delete_claim(`; `mr_heartbeat` body must contain `mr_log(`) and named below for the
  rest.
- **D6 — The G2 Rust mirror ports the JS eval's FULL defense set, not just enumeration.**
  Source-derived reducer enumeration (attr scan accepting only `#[spacetimedb::reducer]` /
  `#[spacetimedb::reducer(`, tolerant walk-forward to the next `fn` token — stacked
  `#[allow]`/`#[cfg]` attributes are legal and precedented in `trading.rs`), fail-loud on
  an empty set, an EXACT sorted name-set pin, and:
  - a **positive wire-safe-scalar param allowlist** (String/bool/u{8..128}/i{8..128}/f32/
    f64, recursing through `Option<`/`Vec<`) rather than any "type text contains
    `Identity`" substring ban — the substring shape misses the JS twin's two documented
    account-takeover PoCs (E1: struct-wrapped Identity; type aliases) by construction;
  - the **scheduled-struct carve-out**: a param typed as the struct mapped from
    `scheduled(<reducer>)` in the same file is exempt only while the reducer's squashed
    body contains the pinned rejecting scheduler guard (`if ctx.sender != ctx.identity()
    { return … }` in squashed form);
  - the **Identity-constructor ban**: `Identity::from_hex` / `from_byte_array` /
    `from_be_byte_array` / `from_str` may not appear anywhere in `accounts.rs` (E2: a
    wire-safe `String` param + `from_hex` in the body is a code-less identity transfer).
  Param scope is the parameter list only (return types are not client input — JS parity).
- **D7 — Fail-loud everywhere; scan-hazard discipline.** Empty derived sets, unfindable
  bodies, I/O errors, and unbalanced parens all panic with attribution. Every structural
  marker in test-file string literals is fragment-assembled (`concat!`) because several
  evals concatenate ALL of `server-module/src/*.rs` (tests included) and comment-strip
  before strings; no unpaired `/*`, no quote/brace char literals in new test code.

## Gates

- `g2_*` (accounts_tests.rs): dynamic enumeration + exact name-set pin + wire-safe param
  allowlist + scheduler-guard pin + Identity-ctor ban, each with machinery self-teeth on
  synthetic fragment-assembled fixtures (added-reducer, E1-struct, E2-ctor, neutered-guard,
  trailing-comma, return-type-Identity, empty-set).
- `eg2_9_*` (evolution_tests.rs): derived per-file scan, seven scheduled-reducer anchors,
  basename coverage anchors, per-new-reducer body anchors.
- `auth_account_state_invariant_*` + `schema_account_struct_shape_tripwire`
  (accounts_tests.rs): predicate table test (mutation-cap defense), constructor legality,
  exact-equality shape pin.

## Consequences

- Adding a reducer to `accounts.rs` now requires a conscious one-line pin update, and any
  non-scalar param must either be the guarded scheduled struct or the gate goes RED —
  the intended tax; M22 adds no reducer, so the near-term cost is ~zero.
- EG2-9's scan covers the whole `src/` tree (~21 files instead of 10); verified at landing
  that no newly scanned file calls a growth helper, so L1 is unchanged and the widening
  adds discovery without false positives.
- The `debug_assert` half of the Account invariant exists only in debug profiles; the
  table-driven predicate test and the shape tripwire are the profile-independent teeth.
  The invariant's contract is deliberately the field-PAIRING shape (status↔timestamp,
  claim-from↔claim-at), NOT value-level provenance: a self-referential claim
  (`claimed_from == Some(identity)`) is domain-illegal but passes this predicate — it is
  enforced separately at `complete_guest_claim` Guard 8 (AUTH-17) and tested there, and
  intentionally left out of the storage-shape invariant.
- Benign-but-shape-changing edits (e.g. a future `#[index]` on an Account field, or a
  field reorder) trip the tripwire deliberately — BSATN layout is order-sensitive, so a
  reorder SHOULD red until consciously re-pinned.
- Stripper soundness for the G2 Rust mirror is deliberately an eval-only clause: the JS
  twin runs `assertStripperSound` (`rust-scan.mjs`) over all scanned files including the
  test files as part of `just ci`'s eval stage, so a stripper desync is caught at CI; the
  Rust mirror does not re-implement that self-check (porting it is the shared-Rust-scanner
  follow-up below). Not exploitable today — `accounts.rs` contains no char literal or
  odd-quote comment that would desync the strip.
- Named residuals still open (unchanged or newly surfaced by this slice's review — all
  need a follow-up slice that may touch `evals/**` and the shared strippers, both outside
  13r-h's `touches:`): G12 identifier-list parity; `write_target_accessors`' unbounded
  `rfind`; the `//`-before-strings stripper ordering in
  wallet-privacy/ranking-security/currency-integrity; a shared Rust-side scanner library
  (would also carry `assertStripperSound` into the Rust mirrors); the **char-literal
  brace-walk truncation class** — a `'{'`/`'}'` char literal inside a scheduled reducer's
  own body truncates the EG2-9 body extraction (and the twin `no-idle-accrual.eval.mjs`
  `extractReducerBody`, which has no mitigation at all) short of a hidden growth call;
  benign today (no scheduled reducer body contains such a literal — verified at landing),
  partially guarded for `guest_claim_reaper`/`mr_heartbeat` by positive body anchors, but
  the five pre-existing scheduled reducers remain anchor-free and the real fix (blank
  char-literal interiors in the shared stripper, or a walk that skips them) touches shared
  machinery; the **identity-constructor ban list gap** — both the G2 Rust mirror and its
  JS twin ban only `from_hex`/`from_byte_array`/`from_be_byte_array`/`from_str`, missing
  `Identity::from_claims(` / `from_u256(` (arbitrary-victim construction) — a SHARED gap,
  latent (no such call in `accounts.rs` today), whose true-parity fix must extend both the
  Rust needle list and `guest-claim-integrity.eval.mjs` in lockstep; the phantom-brace
  local-truncation of `build_log_line`'s own stripped body (`observability.rs`'s `'}'`,
  benign, subsumed by the truncation class above); the tombstone rating re-anchor
  (issue #307 / OQ2, explicitly excluded).
- Knowledge-bundle line pins over `schema.rs`/`accounts.rs` and the ADR digest are
  regenerated with this slice.
