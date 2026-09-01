# 0226 — S4 export ships in privacy.rs as hand-rolled per-field JSON with request-wide chunking; the TTL reaper defers to S4b behind the new-table ritual

**Status:** Accepted
**Date:** 2026-09-01
**Slice:** m22-s4
**Supersedes:** —
**Amends:** —
**Subsystems:** security-authz, schema-persistence, ci-gates
**Decision:** request_data_export + my_export_bundle ship in privacy.rs with hand-rolled per-field JSON, request-wide chunk numbering, subject/deletion/cooldown guards and purge-before-write; PRV1-14's reaper defers to S4b (scheduled table = out-of-touches ritual).

---

## Context and problem statement

M22 §5 prescribes the export mechanism (manifest-driven walk over `exportable: true` tables into
chunked `export_bundle` rows plus an owner-scoped view); §7.2 assigns S4's machinery to
`server-module/src/privacy.rs` with that file as the slice's whole declared touch set. Planning
surfaced five mechanical constraints the M22 ceremony never reconciled, plus two red-team-measured
attack shapes; this ADR records how each was resolved and why.

Constraints (all verified against live gates):

1. `rb22p_no_bare_quote_in_privacy` (privacy_tests.rs:783-813) bans every `"` byte in privacy.rs
   beyond the one `#[path]` literal — no `format!`, no string literals at all.
2. `rb22_purge_naming_budget` (accounts_tests.rs:4906-5036) caps the bare token
   `purge_export_bundles` at 1 occurrence in privacy.rs — the S4 reducer's call site is #2.
3. `hasWalletAccessorBypass` (evals/currency-integrity.eval.mjs:217-242) and ranking-security A2
   (evals/ranking-security.eval.mjs:252-305) confine `player_wallet(` / `ctx.db.profile()` to
   named files; privacy.rs must be allowlisted to read them.
4. `EXPECTED_VIEWS` is a sorted index-wise pin in both monster-privacy and account-privacy evals;
   `my_export_bundle` must be inserted (sort index 3) in both.
5. A `scheduled(...)` table is automigration-frozen (ADR-0221): PRV1-14's reaper cannot ship
   table-first, and the table forces the full new-table ritual — a `DATA_LIFECYCLE_MANIFEST`
   entry (schema.rs), `evals/baselines/table-schemas.json`, and battle-schema-snapshot
   T-VIS-ANCHORS — all outside the declared touches.

No serde_json exists in server-module (Cargo.toml), and adding the dependency plus 17 Serialize
derives would touch Cargo.toml and schema.rs.

## Decision

1. **Hand-rolled per-field JSON in privacy.rs** — a micro-builder (escaper + typed emitters) with
   the quote spelled `'\u{0022}'` and every constant string from `stringify!`. Explicit per-table
   serializer fns over exhaustive struct literals are the *chosen privacy posture*, not merely the
   forced one: a future secret column on an exportable table cannot silently auto-export (the
   serializer names every field; the test suite constructs every row with a no-spread struct
   literal, so a new column is a compile error in the tests, forcing a deliberate export/omit
   decision per column). A SATS-generic serializer over `spacetimedb_lib::ser::Serialize` was
   considered and rejected: from-scratch trait machinery, and its auto-inclusion property is the
   exact inverse of the posture above.
2. **Escaping contract:** `"` and `\` escaped; every byte < 0x20 as `\u00XX` uniformly; `/` and
   0x7F unescaped; non-ASCII passes through as UTF-8. **64-bit integers (u64/i64) are emitted as
   quoted decimal strings** — `JSON.parse` in the S8 client silently loses precision above 2^53
   (wallet balances, ids, seqs are u64). ≤32-bit and bool are bare. Identity = its `Display`
   fixed-width lowercase hex via `to_string()`.
3. **Chunking is request-wide:** `total_chunks` = the request's whole chunk count, identical on
   every row; `chunk_index` = 0..N-1 globally contiguous. PRV1-13's "stable total_chunks" is
   two-way-readable (per-table vs per-request), but §5's own client rule — "waits for
   `chunks.length === total_chunks`" — is incoherent under per-table scope, so the request-wide
   reading is the one that makes the spec self-consistent. Per-table reassembly still works
   (group by `table_name`, order by `chunk_index`). This is a frozen S4↔S8 contract.
4. **Empty tables emit one chunk with an empty rows array, unconditionally** — PRV1-11's letter
   ("one chunk per exportable:true table"), it makes the written table_name set testably equal to
   the manifest's exportable set, and a compliance export that says "we hold nothing here" is
   meaningful. `slice::chunks()` yields zero chunks on an empty slice, so the planner
   special-cases empty (its own named test).
5. **Guard order in `request_data_export`** (each reject a distinct static reason built from
   `stringify!` tokens): (a) **subject-existence guard** — caller must hold an `account` row OR a
   `player` row. Red-team-measured attack: anonymous connections receive working identities
   (lib.rs on_connect accepts `!has_jwt()`), so without this guard a zero-state identity farms 17
   empty chunks per call with no reachable cleanup while PRV1-14 is deferred. (b) **deletion
   gate** — `accounts::is_pending_deletion(ctx, me)` rejects: `export_bundle` is a
   manifest-classified (Erase) table, so PRV1-7's rule applies to this reducer; calling the
   canonical predicate satisfies it with zero out-of-touches edits (`STATE_TRANSITION_OWNERS` is
   game-core AND semantically wrong — export owns no state transition). GDPR tension recorded: the
   right of access during the grace window is exercisable via cancel-then-export; if the operator
   wants in-grace export instead, the guard drops and [DEL-06]'s future mechanism needs an
   exemption entry. (c) **cooldown** — `EXPORT_REQUEST_COOLDOWN_MS` (60s DoS knob, not a legal
   figure) computed from `max(created_at_ms)` over the caller's existing chunks: **zero new
   state**, because purge-before-write makes that maximum the last request time. Polarity note:
   `None` (no prior export) → **allow** — the opposite of `is_deletion_due`'s `None`, pinned by
   its own test. (d) **purge-before-write** via the frozen `purge_export_bundles` helper — bounds
   per-owner storage at one live request and discharges ADR-0220 residual 4(b). Purge-then-abort
   safety rests on reducer transaction atomicity (ADR-0106 D8), accepted on precedent — an `Err`
   after the purge rolls the purge back; not integration-testable off-instance.
6. **`request_id` = `now_ms(ctx) as u64`**, bound once with `created_at_ms` from the same binding
   (the rb-24 shadowed-`now` cheat applies verbatim). Injected clock, no RNG, unique-enough under
   purge-before-write (one live request per owner).
7. **Redaction:** `battle` only. Counterparty identity and monster-id list are nulled per side;
   practice battles (player == opponent) are emitted once, unredacted; a row the requester owns on
   neither side is a loud `Err`. `battle_action`'s "redaction" is vacuous by construction (the
   own-rows filter admits no counterparty row) and is documented as such. **`battle.state` is
   omitted entirely.** The honest rationale (corrected in review): `BattleState` holds *no*
   hidden fields and `my_battle` already returns full state to both participants — omission is
   NOT protecting secrets from the requester; it is (i) honoring §5's mandate to redact the
   counterparty's half in a durable, shareable artifact, and (ii) declining a deep nested
   serializer whose field-level redaction is more code and more leak risk than omission. Named
   residual: the requester's own transient in-battle state is absent from the export (recoverable
   live via `my_battle`; flagged for operator review).
8. **The view ships now, in privacy.rs** — `my_export_bundle(ctx) -> Vec<ExportBundle>` with the
   body `ctx.db.export_bundle().owner_identity().filter(ctx.sender()).collect()` pinned by
   equality (ADR-0154 D2: the body is the entire security boundary; the reducer's one-parameter
   signature is pinned with the same severity — an extra `Option<Identity>` parameter is a
   measured caller-chosen-owner bypass). ADR-0225's one-caller-seam parity argument (defer the
   view to S8) was weighed and declined: 5 lines of proven idiom, §7.3 names the bindings an
   S4↔S8 contract, one bindings regen instead of two, and no gate goes semantically red.
   Placement deviates from the views-live-in-schema.rs convention (not gate-enforced); §7.2
   assigns S4 machinery to privacy.rs.
9. **PRV1-14 defers to S4b** (ledger DEFER, target backlog): constraint 5 above. Mitigations while
   deferred: purge-before-write bounds per-owner storage; the subject-existence guard closes
   zero-state farming; the table is private and owner-scoped. Residual: a guest who joins once can
   park one request's chunks forever — **S4b must land before ANY public exposure (including
   guest play)**, a stronger sequencing constraint than ADR-0225's first-real-account line.
   Rejected alternative: opportunistic expiry inside `request_data_export` is not a reaper (never
   fires unless someone exports) and would need a whole-table walk that
   `rb22p_owner_scoped_filter_never_iter` bans.

## Touches-delta (declared, gate-invited — not hidden dependencies)

Per the rb-24 precedent (PR #398) and spec §7.2's WARN doctrine for shared-eval edits; no
concurrent sibling owns these files (S5 touches trading/pvp/guards only, mr-disjoint SAFE):

| File | Edit | Compensating control |
|---|---|---|
| `server-module/src/accounts_tests.rs` | `rb22_purge_naming_budget` privacy.rs 1 → 2 | new in-touches pin `m22s4_purge_named_twice_declaration_and_call` (declaration + the one sanctioned call site) — without it the widening is a net loosening |
| `evals/currency-integrity.eval.mjs` | `ACCESSOR_BYPASS_ALLOWLIST` += privacy.rs | write direction already closed by whole-file `rb22p_writes_only_export_bundle`; no dedicated pin needed |
| `evals/ranking-security.eval.mjs` | A2 allowed-home → named allowlist {ranking.rs, privacy.rs} | same as above |
| `evals/monster-privacy.eval.mjs` | `EXPECTED_VIEWS` += my_export_bundle (sorted, index 3) | genuine set equality — no loosening (verified) |
| `evals/account-privacy.eval.mjs` | same | same |
| `client/src/module_bindings/**` | `spacetime generate` (mechanical ritual) | bindings-drift eval |
| `docs/knowledge/**` | okf regen (mechanical ritual) | knowledge-check gate |

## Known limits (measured / accepted)

- Two unindexed full scans: `battle_action.player_identity` and `playtest_event.identity` carry no
  index; both tables are bounded (2 rows/turn, deleted on resolve; global 20k cap). An index add
  is a separate schema decision — not taken here. The 20k worst case is covered by a planner-scale
  test; the transaction-size risk at cap remains spec §8.4's escalation.
- The export contains no game rule; `EXPORT_CHUNK_ROWS` is imported from game-core.
  `EXPORT_REQUEST_COOLDOWN_MS` is a server-module operational knob (ADR-0221 R5's sibling —
  consolidate if a game-core slice ever owns retention arithmetic).
- privacy.rs will land well above the ~520-line healthy-file guidance (M8.9). Residual: split
  into a privacy/ module directory in a future slice that may create files.
