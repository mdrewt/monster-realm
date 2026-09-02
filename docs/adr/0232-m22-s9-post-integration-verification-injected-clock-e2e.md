# ADR-0232 — M22 S9 post-integration verification: patched-constant injected clock in the e2e's module copy, WS-only driver, manifest-derived cascade truth

**Status:** Accepted
**Date:** 2026-09-02
**Slice:** m22-s9 (M22 §7.3 — post-integration verification, the milestone's real DoD)
**Supersedes:** —
**Amends:** —
**Subsystems:** security-authz, ci-gates
**Decision:** The S9 e2e patches the grace and chunk constants in its tmpdir module copy so the real reaper fires in CI; compile-level m22s9 contract pins land in accounts_tests.rs; HTTP reducer calls are banned in the rig.

## Context and problem statement

S0–S8 merged in isolation (PR #398–#411). Nothing had ever *executed* the §4.4 deletion
cascade, the terminal-cancel path, or the chunked export against a live host: the module's
`ReducerContext` is not constructible natively (ADR-0225 D5), so every shipped M22 test is a
pure-function test or a source-text pin, and `account-e2e.eval.mjs`'s live phase covered only
the G22 guest-claim flow. The spec's S9 (§7.3) demands a loaded-account → delete → grace →
reaper → manifest-wide truth → terminal-cancel → multi-chunk export run, with the cross-slice
contracts named and tested. The blocker: `DELETION_GRACE_MS_DEFAULT` is 7 real days, and the
module has no runtime clock override (deliberately — §4.3 derives due-ness only from the row's
own request stamp plus the injected reducer clock).

## Decision outcome

### D1 — the injected clock is a patched constant in the e2e's module copy, never a runtime override

The live phase already builds a patched workspace copy (the fail-closed issuer/audience
placeholders are swapped for the stub issuer — the N4 idiom). S9 extends the same idiom:
`patchDeletionGrace` rewrites the one-SSOT declaration
(`game-core/src/accounts/deletion.rs:40`) from `604_800_000` to `15_000`, and
`patchExportChunkRows` rewrites `EXPORT_CHUNK_ROWS` from `500` to `2`, both in the tmpdir copy
only. Every patcher THROWS on a missing needle and on a non-unique needle (a silent no-op
patch would wait 7 days and read as a hang; a double match could patch a comment). Verified
live (2026-09-02 spike): the patched module's `delete_account` armed the one-shot at
+15 000 ms and the real scheduler fired the real reaper at +15 002 ms — the whole
arm/recheck/cascade/terminal path runs unmodified. The shipped tree keeps the bare literal
(`deletion-grace-wasm-ssot.eval.mjs` and G24 read the real declaration; both stay untouched).
`EXPORT_CHUNK_ROWS = 2` (not 1) is deliberate: with 3+ owner rows in one table it yields a
`[2, 1]` chunk split, which distinguishes an honored boundary value from a degenerate
one-chunk-per-row implementation — and it makes multi-chunk assembly provable without a
500-row bulk seed. The `m22s9_e2e_patch_needles_are_live` test pins both needles sole-occurrence
in the shipped source so the patch cannot silently rot.

### D2 — HTTP reducer calls are banned in this rig; the driver is WS-only

Rejected mechanism, recorded so it is not re-proposed: calling reducers over
`POST /v1/database/<db>/call/<reducer>`. Each HTTP call is an ephemeral connection whose close
fires `client_disconnected` → `resolve_all_live_interactions` → cancels the caller's live
trades/challenges, resolves their battles, and deletes their `player`/`character` presence rows
— destroying exactly the seed state S9 exists to build (live-verified for this repo at
`sim-harness/src/bin/mr_load_driver.rs:76-89`). `dev_reducers` + HTTP was rejected for the same
reason; `spacetime call` executes as the CLI owner identity, not the subject. Every
player-identity interaction therefore goes over the driver's persistent WebSocket connections
using the committed bindings; `spacetime sql` (owner) is the only out-of-band channel, used for
bulk fixture seeding and for reading server truth.

### D3 — seed shape: one live battle per subject; the anonymize target is a terminal PvP battle

Escrow/battle-lock guards allow at most one live battle per identity, and a resolved wild
battle is GC'd (no surviving row), so the `battle` ANONYMIZE assertion needs a battle that
*persists*: a PvP battle driven terminal via the forfeit-on-disconnect path (D disconnects
mid-battle, then reconnects and re-joins). The wild battle — required live at cascade time so
step 6a's `resolve_wild_battle_on_disconnect` leg executes — is entered LAST via a
fixed-pattern grass shuttle (spawn (1,1) → Down → alternate Right/Left over the two adjacent
zone-0 grass tiles; encounter rate 200‰/step, 80-step budget ⇒ ~1e-8 failure odds; the zone-0
art is already drift-gated against its RON twin, and budget exhaustion fails loud with the step
count). Bulk rows (>500 `playtest_event`, dialogue/quest fixtures) are seeded via owner SQL
multi-row INSERT — verified live: `0x<hex>` Identity literals and the auto_inc 0 sentinel work.

### D4 — manifest transcription honesty is owned by the Rust side

The eval carries the 40-entry lifecycle classification as ONE delimiter-joined string constant
(biome reflows quotes, never string contents), each Erase/Anonymize entry carrying its
identity-COLUMN list. `m22s9_e2e_manifest_transcription_matches_manifest` derives the expected
string from `DATA_LIFECYCLE_MANIFEST` plus the S6 typespace walk's per-row-type identity-column
names — never a second literal — and compares byte-for-byte with the census pinned at 40 and
parse ambiguity fatal. Deriving columns from `REKEY_MANIFEST` was red-teamed and REJECTED: 6 of
the 17 Erase/Anonymize tables carry only `BLOCKED`-policy rekey keys (trade_offer,
battle_challenge, battle, player, player_conversation, battle_action), so a policy-filtered
read silently yields zero columns for exactly the counterparty-side tables — and an
unattempted table is invisible to the vacuity list, which only sees zero COUNTS. The truth
pass therefore hard-errors on an Erase/Anonymize entry with an empty column list (spike-verified
necessity either way: `player_wallet`'s owner column is not named `identity`, so a guessed
column is a 400 error and a wrong-but-existing one is a silently-empty pre-count).

### D5 — the non-vacuity contract

The pre-cascade snapshot records the subject-scoped row count per classified table; any
zero-count table joins a printed `vacuous[]` list asserted against a declared
allowlist-with-reasons, so a run that seeded nothing FAILS rather than passing 22 empty
assertions. Two controls make over-erasure equally loud: D (bystander) must survive the cascade
with counts unchanged and account Active, and NotOwned world content (species/zones/config)
must still exist. The post-cascade pass runs while A is STILL CONNECTED — her `player` row is
presence state that `on_disconnect` deletes, so an after-disconnect check of the display-name
tombstone would be vacuously green on an absent row (spike-measured).

### D6 — new SQL reads use `--format json`; `parseSqlOutput` is not widened

S9's truth pass reads TEXT columns (names, issuers, payloads), which the existing text-table
parser's own doc comment declares out of contract. A separate `parseSqlJson` (teeth-tested,
`decodeSqlJson` precedent in `scripts/playtest-report.mjs`) serves the new queries; the G22
queries keep the old parser byte-for-byte.

### D7 — timeout budget

Driver killer 150 s → 420 s; eval watchdog 240 s → 480 s. The ceilings only bound a hang; every
internal wait (terminal poll, handshake, shuttle budget) carries its own named deadline and
dumps the schedule rows + host-log tail on expiry, so the longer ceiling does not weaken the
gate — the milestone stream localizes any hang to a named step.

### D8 — what S9 does NOT re-prove

The Rust `m22s9_*` additions are type-system pins (fn-pointer signature coercions for
`resolve_all_live_interactions` and `should_reject_for_deletion`, an exhaustive no-`..`
`ExportBundle` destructure, bindings-surface parity) plus the e2e-integrity ties above. The
shipped textual coverage — cascade body order (`m22s3b_*`), derive-metadata completeness
(`m22s6_*`), the S5 delegation census (`guards_tests.rs`) — is deliberately not duplicated.
Four new `#[no_mangle]` host-syscall abort stubs (insert/update/delete-by-eq/delete-by-index)
join `privacy_tests.rs`'s six to satisfy the linker for the ctx-bound fn-pointer
materialization; they abort if ever actually called.

### F1 — measured integration finding: the cascade's wild-resolve GCs the deleting player's terminal battles (and the seed direction must respect it)

Building this e2e surfaced a real cross-slice interaction, reproduced deterministically and
then bisected (2026-09-02): when the deleting account holds a LIVE WILD battle at cascade
time, step 6a's `resolve_wild_battle_on_disconnect` runs `write_back_battle_results` for the
wild row, whose ADR-0077 keep-latest GC **deletes every prior terminal `battle` row on the
player axis of the wild battle** — including a terminal PvP battle the manifest classifies
Anonymize ("terminal rows persist") — and its unfired `pvp_deadline_schedule` row is left
orphaned (`anonymize_battles` later finds no battle row to disarm through). Adjudication:
NOT a module bug. "Terminal rows persist" was always scoped by ADR-0077's keep-latest
retention (the surviving opponent's own next battle GCs the row in ordinary play too); the
cascade path erases rather than anonymizes, which is the *stronger* privacy outcome; and the
orphaned deadline row is transient by construction — it self-consumes at its fire time (the
reaper no-ops on a missing battle and the runtime deletes the fired one-shot). The e2e
therefore seeds the terminal battle with the SUBJECT ON THE OPPONENT AXIS (D challenges, A
accepts): the wild write-back's player-axis GC cannot reach it and the opponent-axis GC
skips WILD battles by construction, so the battle legitimately survives for the Anonymize
assert — which now also exercises the opponent-side tombstone swap and the cascade's
deadline disarm. The `export_bundle` pre-count is sampled at the post-export census (the
export runs after the main pre-snapshot; the cascade fires 15 s after the redelete), keeping
its non-vacuity honest.

## Consequences

- M22's DoD (§7.3) is executable in CI: the full cascade, terminal-cancel (PRV1-4),
  disarm-holds (PRV1-3), export assembly (PRV1-11/12/13) and the five cross-slice contracts run
  against a live host on every `just ci`.
- The live phase's wall clock grows (patched build reuses the shared cargo target cache; the
  reaper wait is 15 s; the whole added flow is bounded by named deadlines).
- The grace/chunk patch idiom is now the sanctioned way to compress time-scale constants in
  this rig; any future constant compressed this way must follow the needle-throw +
  sole-occurrence + shipped-tree-pin triple.
- Accepted residuals: `battle_action` rows may be forfeit-GC'd before the cascade (its
  non-vacuity is then carried by a SQL fixture or a declared vacuity-allowlist entry with
  reason); the >500-row `playtest_event` volume leg measures single-transaction cascade size at
  modest scale only — spec §8.3's full-volume question stays open (operator escalation).
