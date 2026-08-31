# 0207 — Data-lifecycle manifest and terminal schema: M22 privacy S2 additive structure

**Status:** Accepted
**Date:** 2026-08-25
**Slice:** m22-s2 (M22 privacy compliance S2 — schema + manifest extension)
**Supersedes:** —
**Amends:** —
**Amended-by:** 0221
**Subsystems:** schema-persistence, security-authz, ci-gates
**Decision:** Data-lifecycle manifest as a Rust const in schema.rs (39 tables: policy+basis+exportable); Account.terminal_at_ms appended with #[default(None)]; private export_bundle table; reaper deferred to S3 (scheduled-ness is migration-frozen).

---

## Context and problem statement

M22 privacy compliance (specs `M22-privacy-compliance.spec.md` §2–§7) requires schema annotation for every table with its deletion policy (ERASE, ANONYMIZE, JOIN_ONLY, NOT_OWNED), a basis statement, and exportability flag. S2 is the schema-and-manifest milestone; S3 adds the deletion reducer bodies. S0 (#359) froze the eval-side contract surface (exported, deeply frozen `REKEY_MANIFEST` + `findIdentityColumns`); S1 (#360) shipped the game-core deletion constants (`DELETION_GRACE_MS_DEFAULT`, `TOMBSTONE_IDENTITY_BYTES`, `TOMBSTONE_AUTH_ISSUER`, `EXPORT_CHUNK_ROWS`, `STATE_TRANSITION_OWNERS`).

Three alternative placements for the manifest were measured:
- **JS `REKEY_MANIFEST` object entries (measured red-on-arrival):** `checkRekeyCompleteness` (`evals/guest-claim-integrity.eval.mjs`) infers REKEY policy from `typeof policy === 'string'`; any object-valued entry reds `[G6/consumed]`. Supervisor's S2 launch brief explicitly restricts touches to `accounts.rs` manifest region only and defers JS-discriminator work to backlog (residual R-m22-s0-X1, target: backlog).
- **`accounts.rs` placement (reds a live security gate):** The test `g5_no_wallet_accessor_in_accounts` (`accounts_tests.rs:2166–2173`) bans the token `player_wallet` anywhere in `accounts.rs` with content preserved; the deletion policy list contains `player_wallet`. Weakening that gate to admit a manifest is outside the verifier's scope.
- **`schema.rs` (chosen):** Every table name already legitimately occurs here; the file is in declared touches; and a new-table author sees the classification colocated with what it classifies. This is the REKEY-adjacent schema surface §2 names.

S2 **defers** `AccountDeletionReaperSchedule` despite spec §4.4. SpacetimeDB automatic-migrations doc lists "Changing whether a table is used for scheduling" under Forbidden Changes (verified in both master and versioned docs). An S2 table without `scheduled(account_deletion_reaper)` becomes a destructive republish when S3 adds the attr; shipping it WITH the attr requires declaring the reducer in S2, which the brief forbids and which hard-reds `[R/name-set]`'s exact-5 pin (residual R-m22-s1-X1). The table and its scheduled reducer must land atomically in S3 as a new table (always additive).

---

## Decision outcome

### D1: `DATA_LIFECYCLE_MANIFEST` as a Rust const in `schema.rs`

The manifest is declared in `server-module/src/schema.rs` as an exported const:

```rust
pub enum DeletionPolicy {
    Erase,
    Anonymize,
    ViaJoin(&'static str),
    NotOwned,
}

pub struct DataLifecycleEntry {
    pub table: &'static str,
    pub policy: DeletionPolicy,
    pub basis: &'static str,
    pub exportable: bool,
}

pub const DATA_LIFECYCLE_MANIFEST: &[DataLifecycleEntry] = &[
    // 39 entries: 38 live tables + export_bundle (D2)
    // NO entry for account_deletion_reaper_schedule (deferred to S3, D5)
];
```

As shipped, `DeletionPolicy` derives `Debug` only (the sibling tests pattern-match; they never compare or format the enum with `==`) and `DataLifecycleEntry` derives nothing — the YAGNI floor the plan set. The **compile-time assertion** makes every field live in the lib target without `#[allow(dead_code)]` (red-team measured that `clippy --all-targets -D warnings` hard-fails the bare const on the lib target, and the repo has a standing rule against `#[allow(dead_code)]`, `economy_tests.rs` `dead_code_allow_removed`) — a genuine tooth that catches empty basis strings at compile time:

```rust
const _: () = assert!(manifest_is_wellformed(DATA_LIFECYCLE_MANIFEST));
```

The const fn `manifest_is_wellformed` walks every entry, requires non-empty `table` and `basis` strings, reads all `policy` variants and the `exportable` field.

**Drift mitigation:** T9 cross-manifest consistency test verifies that every `REKEY_MANIFEST` key's table-half exists in `DATA_LIFECYCLE_MANIFEST`, and both manifests tie to the same live source ([G6/live] for JS, T1 for Rust), so a table rename/drop surfaces in both.

**String hygiene (red-team measured):** `battle-schema-snapshot.eval.mjs` (both live drift check and `--write` regenerator) parses RAW source with a string-unaware comment stripper. A `/*` inside one manifest basis literal silently swallows every subsequent table from the committed baseline, self-consistently. **Hard rule: no `/` character in any manifest string literal.** Enforced by T3 tooth.

### D2: `export_bundle` table (PRIVATE, new)

Appended to end of `schema.rs` under the M22 section:

```rust
#[derive(Clone)]
#[spacetimedb::table(accessor = export_bundle)]
pub struct ExportBundle {
    #[primary_key] #[auto_inc] pub chunk_id: u64,
    #[index(btree)] pub owner_identity: Identity,
    pub request_id: u64,
    pub table_name: String,
    pub chunk_index: u32,
    pub total_chunks: u32,
    pub payload_json: String,
    pub created_at_ms: i64,
}
```

The table is **private** (no `public` token). Chunk contract per spec §5 (S2↔S4↔S8 cross-slice): one row per `(owner_identity, request_id, table_name)`, sub-chunked via `chunk_index`/`total_chunks` at `game_core::EXPORT_CHUNK_ROWS`. `created_at_ms` is server-stamped at insert (injected clock, never caller-suppliable) and is what the S4 TTL reaper re-derives staleness from at fire time. Attr order: `accessor =` FIRST, derives BEFORE table attr, newline before `}` (parseTableSchemas fixture constraints, measured).

### D3: `Account.terminal_at_ms: Option<i64>` column

Appended **LAST** in the `Account` struct (`schema.rs:752–767`) with `#[default(None)]` per spec §4.1:

```rust
pub terminal_at_ms: Option<i64>,
```

Terminal predicate = `status == PendingDeletion && terminal_at_ms.is_some()`. S2 ships the column only; no reducer writes `Some` until S3. Mechanically forced companion: `new_account_row` (`accounts.rs:136–145`) is the one Account constructor using a full struct literal, gains `terminal_at_ms: None,`. The other four constructors use `..existing` (verified untouched).

**Legality extension (D7, adopted):** `account_state_is_legal` extends with one clause: `terminal_at_ms.is_some()` implies `status == PendingDeletion && deletion_requested_at_ms.is_some()`. The tripwire contract says M22 must re-derive the predicate consciously when the shape moves; S2 moves the shape. Pure predicate, two lines, tests drive it directly; S3 inherits a safe seam.

**Real automigration probe (X9):** Encoded as S2 module's republish over a persisted fork instance must succeed (the whole slice is additive per ADR-0006). The probe's negative control — the same diff with `terminal_at_ms` inserted mid-struct — must FAIL, proving the probe can red. This is the only gate that sees #[default] encoding-class publish failures; local `just ci` cannot.

### D4: `auth_issuer` doc-comment correction

`Account.auth_issuer` doc-comment (currently `schema.rs:755–757`) is updated from the stale phrase "Never updated after insert" to state the one sanctioned exception: the M22 deletion cascade overwrites it with `game_core::TOMBSTONE_AUTH_ISSUER` (§3 ANONYMIZE row; sentinel keeps the column non-nullable and type-unchanged). Comment text avoids `/\*` and double quotes (stripper soundness per D1).

### D5: `AccountDeletionReaperSchedule` DEFERRED to S3

The table declaration is **not included in S2** due to a platform restriction. SpacetimeDB automatic-migrations doc (both master and versioned branches) lists "Changing whether a table is used for scheduling" as a **Forbidden Change**. A scheduled table's `scheduled(account_deletion_reaper)` attribute requires the reducer to exist at compile time. Declaring the reducer in S2 also hard-reds `[R/name-set]`'s exact-5 reducer-name pin (residual R-m22-s1-X1).

**Resolution:** The table and its scheduled reducer must land atomically in S3 as a new table (always additive, never a migration). S3 must add the table's `DATA_LIFECYCLE_MANIFEST` entry and its `REKEY_MANIFEST` string key in the same commit, or T3/[G6/declared] red. Spec §7.2's S2 row should be amended to reflect this deferral (supervisor action).

### D6: `REKEY_MANIFEST` one-string-key addition

Mechanically forced by [G6/declared]: `export_bundle.owner_identity` must carry an entry in `REKEY_MANIFEST` in the same PR as the column (the gate's own error text mandates it). String keys are measured-safe (S0 red-team); object entries are the parked R-m22-s0-X1 trap. The entry is `EXEMPT`, and its basis was **corrected during this slice's security audit**: the first draft claimed "the M22 cascade sweeps this column", which is false in exactly the case EXEMPT creates — the cascade keys on the deleting account identity and cannot reach pre-claim chunks orphaned under the retired guest identity. The shipped basis states that limit plainly and assigns S3 the closure (delete chunks at claim time, or sweep `owner_identity == account.claimed_from` in the cascade — AUTH-21 provenance exists for exactly this), and notes a TTL is not a substitute for cascade erasure (the `playtest_event` doctrine). The bidirectional [G6/live] gate requires the key to exactly match the live column.

---

## Exportability decisions (positive bijection)

All three plan lenses converged: negative-only spot checks admit an all-false manifest that ships a dead export feature. **Set equality in both directions is required.**

`exportable == true` for exactly these **17 tables**:
- 12 spec-ERASE: `monster`, `monster_pub`, `inventory`, `player_dialogue_state`, `player_quest`, `player_conversation`, `heal_cooldown`, `player_wallet`, `playtest_event`, `trade_offer`, `battle_challenge`, `battle_action`
- 4 ANONYMIZE: `player`, `profile`, `account`, `battle`
- 1 JOIN_ONLY exception: `character` (the player's own entity state, reachable via the `player` join)

`exportable == false` for the other **22 tables**:
- `export_bundle` itself (the walk must not export its own output)
- `battle_wild` (raw RNG individuality seed — must never leak) and the 3 per-entity JOIN_ONLY schedules
- `guest_claim` (secret code) and the other 16 NOT_OWNED tables (no identity-scoped rows to export)

**Special cases:**
- `config` basis must contain the word "singleton" (future [DEL-03])
- `ViaJoin` parents pinned by value (red-team: liveness-only admits wrong parent): `character`→`player`, `battle_wild`→`battle`, `pvp_deadline_schedule`→`battle`, `battle_challenge_reaper_schedule`→`battle_challenge`, `trade_offer_reaper_schedule`→`trade_offer`

---

## Scope notes

**S2 explicitly does not:**
- Add reducer bodies (S3)
- Declare `AccountDeletionReaperSchedule` (deferred, D5)
- Add game-core changes (outside scope)
- Add JS deletion_policy fields to module_bindings
- Touch `evals/run.mjs` or shared eval logic (S1 precedent: per-slice evals are outside touches)

**Mechanically-forced regenerations (all touches-delta, all generated):**
- `evals/baselines/table-schemas.json` (`node evals/battle-schema-snapshot.eval.mjs --write`)
- `client/src/module_bindings/**` (`just gen`)
- `docs/knowledge/**` (`just knowledge` AFTER schema commit — bundle stamps gitDate(schema.rs))
- `docs/adr/DIGEST.md` (`just adr-digest` with ADR-0207)

---

## Rationale — spec deviations (all escalated for supervisor sign-off)

### Deviation 1: Manifest in Rust const, not JS REKEY_MANIFEST object entry

**Why not the JS path:** Supervisor's S2 launch brief restrains touches to `accounts.rs` manifest region only and relegates JS-discriminator work to backlog (residual R-m22-s0-X1, unpromoted). Object entries in REKEY_MANIFEST are measured red-on-arrival ([G6/consumed] fails when `typeof policy !== 'string'`).

**Why not accounts.rs:** The live security gate `g5_no_wallet_accessor_in_accounts` (`accounts_tests.rs:2166–2173`) bans the token `player_wallet` anywhere in that file with content preserved. The deletion policy list contains `player_wallet`. A manifest placed there weakens that gate exactly as the verifier's not-weakened audit forbids.

**Why schema.rs:** It colocates every table's classification with the declaration it classifies, is in the declared touches, and is the natural place for a new-table author to see the policy. Drift closure: T9 cross-manifest consistency test (every REKEY key's table-half in DATA_LIFECYCLE_MANIFEST) + both manifests tied to live source.

### Deviation 2: `AccountDeletionReaperSchedule` deferred to S3

Spec §7.2 S2 row did not account for the platform's `scheduled` automigration constraint. The table cannot ship without either a destructive republish or an out-of-scope reducer declaration. Atomically landing the table and its reducer in S3 is the safe path and complies with ADR-0006's additive-only posture. Spec amendment noted (supervisor action).

---

## Test plan (tester; all start RED)

New tests in `accounts_tests.rs` (which already owns SCHEMA_RS scans via include_str!):

- **T1 manifest totality (bidirectional):** Table-attr census over ENUMERATED file set (`schema.rs`, `accounts.rs`, `observability.rs`, `playtest.rs`, `movement.rs`, `trading.rs`, `pvp.rs`) equals manifest table key set exactly-once each. Plus lib.rs mod-census cross-check closing the new-file blind spot.
- **T2 spec-partition pin:** The four §3 name-sets verbatim (12 ERASE / 4 ANONYMIZE / 5 JOIN_ONLY / 17 NOT_OWNED) + `export_bundle` ⇒ Erase/false. ViaJoin parents pinned by exact value against real join columns.
- **T3 basis hygiene:** Non-empty prose (floor length), `config` contains `singleton`, NO `/` in any manifest string, every ViaJoin parent is live and unchained.
- **T4 export bijection (positive):** `exportable == true` equals exactly the 17 named tables; `false` for the other 22. Set equality both directions.
- **T5 Account shape:** Tripwire updated to pin `terminal_at_ms` LAST with `#[default(None)]`.
- **T6 auth_issuer comment:** RAW source no longer contains squashed stale phrase; contains exception phrase + `TOMBSTONE_AUTH_ISSUER` name.
- **T7 export_bundle shape:** Exactly 8 fields in order, `chunk_id` PK+auto_inc, btree on `owner_identity`, no `public`.
- **T8 legality predicate:** Rejects terminal-without-request and terminal-while-Active; accepts legal terminal shape (PendingDeletion + Some(requested) + Some(terminal)) and all-None.
- **T9 cross-manifest consistency:** Every REKEY_MANIFEST key's table-half exists in DATA_LIFECYCLE_MANIFEST.

Bite-proofs (orchestrator executes; tester has no Bash): mutate one entry's policy → T2 red; drop entry → T1 red; blank basis → T3 red; flip `battle_wild` exportable → T4 red; move `terminal_at_ms` mid-struct → T5 red; re-add `public` → T7 red.

---

## Acceptance gates (X1–X16 authored; X15 deferred)

Seeded 0 criteria (SPEC-SECTION-NOT-FOUND, 7th occurrence); X1–X14 + X16 are Rust sibling tests, the two persisted probe scripts (structural pins + the REAL republish probe), the full eval suite with six named blast-radius PASS lines, and a not-weakened test-count ratchet against the pinned fork SHA. X15 (`AccountDeletionReaperSchedule`) is DEFERRED → backlog with intended owner S3 (D5). X16 is the scope gate: a pinned-SHA file allowlist plus a VALUE-diff of `REKEY_MANIFEST` (fork vs HEAD imported and deep-compared — a line-diff heuristic was measured forgeable via JS duplicate-key last-write-wins) plus a ban on reducer/write tokens in the accounts.rs added lines.

---

## Related decisions & follow-ups

- **ADR-0006 (additive-only schema):** This slice honours the constraint; the reaper table deferral and the X9 republish probe are the proof.
- **M22 S1 (PR #360, `game-core/src/accounts/deletion.rs`):** provides `DELETION_GRACE_MS_DEFAULT`, `TOMBSTONE_IDENTITY_BYTES`, `TOMBSTONE_AUTH_ISSUER`, `EXPORT_CHUNK_ROWS`, `STATE_TRANSITION_OWNERS`. S2 reuses, does not redeclare.
- **ADR-0193 (append-at-end schema gate):** the baseline regeneration respects column order; `terminal_at_ms` appends last; ADR-0193:148-149 independently corroborates that a `scheduled(...)` change is engine-forbidden.
- **Game-core cascade list (spec §4.7):** wants it in game-core; game-core is outside S2's touches. The schema.rs manifest is the SSOT until a later slice lifts it. Flagged for spec amendment (supervisor).

## Security-audit outcomes recorded for S3 (found in this slice's review, out of S2's scope to fix)

1. **`cancel_account_deletion` terminal guard is S3-mandatory (PRV1-4 / spec §4.5 "Late cancel").** With `terminal_at_ms` now in the schema, `needs_cancel_write` admits a terminal account (terminal IS `PendingDeletion`) and `cancelled_deletion`'s `..existing` preserves the marker — two ordinary authenticated calls after S3's cascade would produce `Active` + `Some(terminal)`, the exact state `account_state_is_legal` now rejects, and the constructor `debug_assert!` is compiled out of release wasm (`[profile.release]` has no `debug-assertions`). S3 must reject at the reducer (distinct, user-visible error) and add a constructor-level test. Filed as a residual.
2. **Guest-orphaned export chunks (D6's HONEST LIMIT)** — S3 closes via claim-time delete or a `claimed_from` sweep.
3. **Release-profile `debug-assertions` decision** — S3, as the first writer of `terminal_at_ms`, must either enable `debug-assertions` for the module profile or promote the legality check to a real `Err` guard at its write sites.

