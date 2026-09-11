# ADR-0245 — Disconnect side effects are gated on the LAST live connection

**Status:** Accepted
**Date:** 2026-09-11
**Slice:** rb-73 (residual R-18r-b-DISCONNECTSELF, `M-residual-backlog.spec.md#rb-73`)
**Supersedes:** —
**Amends:** —
**Subsystems:** security-authz, schema-persistence
**Decision:** A private `player_session` table keyed by `ConnectionId` records every live connection; `on_disconnect` runs its side effects only when the identity's LAST live connection ends.

## Context and problem statement

SpacetimeDB 2.8.1 `POST /v1/database/<db>/call/<reducer>` (crates/client-api/src/routes/database.rs `with_connection` v2.8.1) generates a random `ConnectionId`, calls `client_connected`, runs the reducer, then ALWAYS calls `client_disconnected` for that connection. Every HTTP reducer call is therefore an ephemeral connection whose close fires `on_disconnect` for the caller's identity (verified live at sim-harness/src/bin/mr_load_driver.rs:76-89).

This mechanism creates two defects:

**Token-leak amplifier / unreliable disconnect signal.** Any holder of an identity token — the player themself, or anyone who copied the token even briefly — can fire the full disconnect side-effect set on demand, repeatedly, with one bare HTTP reducer call, while the identity's real WebSocket stays connected: manufacturing a PvP forfeit or a wild-battle auto-flee at a chosen moment, cancelling live trades, and deleting the presence rows underneath the live session. It is strictly self-directed (never privilege escalation), but a leaked token becomes a remote force-resolve, and "disconnect" stops being evidence of a real disconnection.

**Reconnect overlap wipe.** The app-level reconnect (ADR-0085) opens a new WS while the host may not yet have detected the old socket's close (up to the 30 s idle timeout below). When the old session's `on_disconnect` finally fires it deletes the presence rows underneath the new session; `client/src/net/connection.ts:665-669` deliberately treats the resulting `'already joined'` as benign, so the wipe stays invisible.

Single-row solutions fall short: "first connection owns the presence" closes the amplifier but not the reconnect-overlap wipe (the owner's late `client_disconnected` still deletes the presence rows underneath the live new session). A counter row cannot self-heal (`datastore_update_bsatn` is the least testable syscall); reading `st_client` is barred (no system-table access in 2.8.1, spacetimedb-2.8.1/src/lib.rs:1092-1099); storing `ConnectionId` on `player`/`character` breaks ADR-0015 (connection ids must never leak, both tables are `public` and pinned at evals/battle-schema-snapshot.eval.mjs:2570-2589). The canonical solution — a private `sessions` table keyed by `connection_id` with an `identity` column — is the vendor's own `client_disconnected` example in the lifecycle documentation.

## Decision outcome

### D1 — Table shape

Declare `PlayerSession` in `server-module/src/schema.rs` at :930–944 (beside `ExportBundle`):

```rust
#[spacetimedb::table(accessor = player_session)]   // PRIVATE: no `public` arg; accessor FIRST
pub struct PlayerSession { #[primary_key] pub connection_id: ConnectionId, #[index(btree)] pub identity: Identity }
```

Classified `Erase` in `DATA_LIFECYCLE_MANIFEST`, not `NotOwned`+frozen-five. The row names an identity and a connection id, and (unlike `account_deletion_reaper_schedule`) is NOT guaranteed absent at cascade time — a subject deleted while connected would keep it. The `m22s6_not_owned_identity_exceptions_are_frozen` test (accounts_tests.rs:11413-11508) calls widening its frozen four "a PRIVACY-CLASSIFICATION DECISION for a human reviewer"; this slice takes that lane. Fallback if the supervisor refuses `accounts.rs`/ADR-0228 in touches: `NotOwned` + frozen-five, argued as a deliberate retention decision bounded by socket lifetime (≤30 s after a severed socket, or the next module launch replay — see Verified platform facts).

Key shape is final on first ship (ADR-0006, ADR-0173 D5, transcribed at evals/battle-schema-snapshot.eval.mjs:281-289): a unique/PK cannot be broadened later, so PK-on-`connection_id` + btree-on-`identity` must be right now.

### D2 — `on_connect` wiring shape

`on_connect` (lib.rs:222–228) becomes, in exactly this order:

```
let jwt = ctx.sender_auth().has_jwt();
open_player_session(ctx);
if !jwt { return Ok(()); }
accounts::provision_or_touch_account(ctx)
```

Squashed, `has_jwt(` still precedes `provision_or_touch_account(`, `return Ok(())`, `accounts::`; the body holds no `Err(` and no `ctx.db.` token at all — so `auth1_on_connect_has_jwt_gate_is_first_and_no_err_before` (accounts_tests.rs:1262-1297) and `[I/anon-first]`/`[I/anon-no-err]` (guest-claim-integrity.eval.mjs:936, 974-1007; absent tokens are *skipped*) all hold. The session write deliberately runs for anonymous connections too — that is the feature; the compensating pin is the frozen single-purpose helper body (ledger gate X4), so it can never grow a second write.

### D3 — `on_disconnect` wiring and guard

`on_disconnect` (lib.rs:265–279) becomes:

```
let me = ctx.sender();
let leaving = ctx.connection_id();
if let Some(conn) = leaving { ctx.db.player_session().connection_id().delete(conn); }
if has_live_session(ctx, me) { return; }
// the existing four lines verbatim
```

Helper `has_live_session(ctx: &ReducerContext, identity: Identity) -> bool` is read-only: `ctx.db.player_session().identity().filter(identity).next().is_some()` — it executes on the native host. The `Some(conn)` delete branch is structurally unexecutable natively (ReducerContext::connection_id is private and `__dummy()` yields `None`, spacetimedb-2.8.1/src/lib.rs:1043-1055), killed by source-freeze pins + the mutant sweep + the live two-connection proof.

`resolve_all_live_interactions(` still occurs exactly once (trading_tests.rs:3144-3154), `profile(` never (pvp_tests.rs:1919-1937), and `resolve_all_live_interactions`'s own frozen body (accounts_tests.rs:9841-9876) is untouched. `connection_id() == None` (impossible in these hooks per vendor lifecycle) fails safe in both directions: with live sessions it skips, with none it runs the legacy path. Deploy transition is fail-open to legacy: pre-existing WS clients have no row in the new empty table, so their disconnect behaves exactly as today.

### D4 — Deletion cascade ordering and guest-claim policy

`erase_player_sessions(ctx, owner)` is a cascade step (Erase policy) that lives in `lib.rs` beside `erase_character_rows` (lib.rs:259–263, the precedent). In `account_deletion_reaper` (accounts.rs:1046–1058), the call goes immediately AFTER `crate::erase_character_rows(ctx, args.account_identity);` and BEFORE `anonymize_display_names`. Presence bookkeeping erases with the presence rows; the frozen reaper literal (accounts_tests.rs:7317) gains the matching entry.

In `evals/guest-claim-integrity.eval.mjs`, ONE `REKEY_MANIFEST` data row (around :1808–1952):

```javascript
'player_session.identity': {
  policy: 'EXEMPT',
  reason: 'per-connection presence bookkeeping keyed by the host-minted ConnectionId; a row belongs to the socket that opened it, not to the account, and the claimed identity opens its own row on its next connect. Honest limit: a row the guest opened survives the claim until that socket closes (≤30 s after a severed socket, or the next module launch replay), briefly referencing the retired guest identity.'
}
```

The policy is `EXEMPT` (not `BLOCKED` or `REKEY`) because a row the guest opened IS tied to the guest's own connection and dissolves when that connection closes. The honest limit names the socket-lifetime bound.

### D5 — Proof vehicle

Per ADR-0224 (ordinary `#[test]`s only; no new/extended `evals/*.eval.mjs` clauses), new file `server-module/src/rb73_session_tests.rs` declared from lib.rs (precedent `m14_5d_1a_tests` at lib.rs:45–47). EXECUTED on the in-memory host (`ConnectionId::from_u128` is public+const, spacetimedb-lib-2.8.1/src/connection_id.rs:60):

- `rb73_sessions_live_row_for_the_sender_is_seen` (one row for the sender → `true`) — kills M4 "always false" (the whole fix no-ops)
- `rb73_sessions_no_rows_means_no_session` (no rows → `false`) — kills M5 "always true" (no disconnect ever cleans up)
- `rb73_sessions_stranger_rows_are_not_mine` (rows only for identity B → `false`) — kills M6 wrong index / whole-table scan (a `.iter()` mutant additionally hits the unmodelled `datastore_table_scan_bsatn` wall)

Each asserts the helper's RETURN VALUE, opens with a vacuity pre-assert that the seeded rows are visible through `ctx.db`, and closes with the rb-72 `Handle::remove` falsifiability control (accounts_tests.rs:20201-20223).

Executed reducer tests: `rb73_exec_on_disconnect_skips_while_another_session_is_live` seeds one session row + presence rows for the all-zero sender, calls `crate::on_disconnect(&ctx)`, asserts both presence rows still readable through `ctx.db` (with the rb-72 `Handle::remove` falsifiability control). RED before the fix = process abort on the unguarded presence write (`unmodelled()` wall, nextest reports `SIGABRT`). Likewise `rb73_exec_on_connect_none_branch_writes_nothing`: seeds a row, calls the helper, asserts the row untouched and the return is `Ok(())`. HONEST LIMIT: the skip-path test cannot distinguish "skipped because a sibling session exists" from "always skips" — the fires-when-it-should direction rests on the frozen-body pin (X4) and the mutant sweep (X6, whose M12 is exactly a bare-`return` body).

SOURCE-SHAPE pins (the `Some(conn)` branches are structurally unexecutable):

- `rb73_wiring_on_connect_body_is_frozen` — declaration-uniqueness + exact equality of the squashed body. Kills M8 "session insert moved inside the JWT branch" and M7 "insert deleted".
- `rb73_wiring_open_session_body_is_frozen_and_single_purpose` — exact body equality plus zero `Err(`/`accounts::`/`unwrap(`/`expect(`/`panic!(` to compensate for the `ctx.db.` before the guard.
- `rb73_wiring_on_disconnect_guard_precedes_and_body_is_frozen` — counts/ordering first (guard index < resolver index, each exactly once), then exact body equality, mirroring `m22s3b_resolver_body_order` (accounts_tests.rs:9822–9876). Kills M1 "guard deleted", M2 "guard inverted", M3 "moved below", M9 "own-row delete dropped", M12 "bare `return` body".

Squashed pins are whitespace-insensitive, so rustfmt's `fn_call_width` re-wrap cannot false-RED them.

### D6 — Rejected alternatives

- *Single-row "first connection owns"* — stalls reconnect-overlap wipe (owner's late close deletes underneath new session; connection.ts:665-669 treats it as benign).
- *No table; read `st_client`* — barred: no system-table access 2.8.1 (spacetimedb-2.8.1/src/lib.rs:1092-1099).
- *Store ConnectionId on player/character* — breaks ADR-0015 outright (both tables public, pinned at evals/battle-schema-snapshot.eval.mjs:2570-2589).
- *Per-identity counter row* — cannot self-heal (`datastore_update_bsatn` is least testable); an `update`-based guard is not idiomatic.
- *Lib.rs-only mitigation without state* — none exists; module-static memory is non-transactional.

## Verified platform facts

- SpacetimeDB 2.8.1 `POST /v1/database/<db>/call/<reducer>` (crates/client-api/src/routes/database.rs `with_connection`, v2.8.1) generates a random `ConnectionId`, calls `client_connected`, runs the reducer, then ALWAYS calls `client_disconnected` for that connection. Every HTTP reducer call is an ephemeral connection whose close fires `on_disconnect`.
- `client_connected`/`client_disconnected`: `ctx.connection_id()` is guaranteed `Some` per vendor lifecycle docs; the vendor's canonical `client_disconnected` example is a PRIVATE `sessions` table keyed by `connection_id` with an `identity` column.
- Module launch/restart replays `call_identity_disconnected` for every dangling `(identity, connection_id)` in `st_client` (crates/core/src/host/host_controller.rs "Disconnect dangling clients"); a republish that requires client disconnect calls the NEW module's disconnect reducer for each old client. A session table drains itself after crashes/restarts.
- Rejected-connect rollback (crates/core/src/host/module_host.rs:721–798, v2.8.1): the `st_client` insert (:743-750) and the `client_connected` reducer call (:753-769) share ONE transaction committed at most once (:775-784); `ReducerOutcome::Failed` maps to `Err(ClientConnectedError::Rejected)` and the transaction is never committed, so `st_client` stays untouched. `open_player_session`'s insert rolls back together with any bad-audience `Err` from `provision_or_touch_account` — no leaked row.
- Severed-socket bound (crates/client-api/src/routes/subscribe.rs:419–483, v2.8.1): `ping_interval` 15 s, `idle_timeout` 30 s ("a connection is considered idle if no data is received nor sent, including Ping/Pong"). A WS that dies without a close frame is closed by the host within ~30 s and its `client_disconnected` fires. A stale row from a severed socket lives ≤30 s + host detection; a stale row from a crashed host lives until relaunch replay.
- `ReducerContext::__dummy()` (2.8.1 src/lib.rs:1043) has `connection_id: None` (PRIVATE field) and `sender = Identity::__dummy()` (all zeros).

## Consequences

**Behaviour changes.** HTTP calls no longer force-resolve a live session; their own row lives only while the call executes (insert → execute → delete). A reconnecting WS session keeps presence alive even if the old session's close races the new open. Multi-tab (multiple concurrent WS sessions for the same identity) keeps presence alive until the last tab closes. A lone ephemeral connection (HTTP call, no live WS) is still last-out, so `evals/smoke-republish-on-disconnect-compat.eval.mjs`'s premise survives unchanged.

**Gate blast radius.** Three independent 41-entry censuses become 42: `data_lifecycle_manifest_totality_bidirectional`'s floors (accounts_tests.rs:3847, :3866); `m22s6_table_row_registry_matches_manifest`'s registry (`m22s6_table_row_types`, :10937; census :11201; identity-bearing 21→22 at :11216; Erase/Anonymize population 17→18 at :11298); and the S9 e2e transcription — `M22S9_MANIFEST_TRANSCRIPTION` at evals/account-e2e.eval.mjs:162 plus the `n_parts == 41` literal at accounts_tests.rs:13289. Also: `m22s3b_cascade_covers_manifest`'s map + 22→23 (:9930, :10000), the `expected_erase` roster (:4019), the frozen reaper literal (:7317), `m22s6_cascade_chain` (:11574), privacy_tests.rs's `m22s4_no_exportable_false_table_is_named` floor 22→23 (:4832-4840), T-VIS private count 23→24 + `pinnedPrivateTables` (evals/battle-schema-snapshot.eval.mjs:2553, :2605-2639) with `evals/baselines/table-schemas.json` regenerated via `node evals/battle-schema-snapshot.eval.mjs --write`, and the `REKEY_MANIFEST` row (evals/guest-claim-integrity.eval.mjs:1808-1952).

**Fan-out ineligible → SERIAL.** A new table moves eight different census constants and regenerates a committed baseline; any concurrent sibling touching `schema.rs`/`accounts_tests.rs`/the baseline conflicts by construction.

## Accepted residuals

- **R-rb-73-PVP-HOLD** — a losing PvP player can hold a second live connection so their game tab's drop is not last-out and `forfeit_on_disconnect` does not fire. Bounded to one turn by the scheduled `pvp_deadline_reaper` (pvp.rs:1328–1382, `PVP_TURN_DEADLINE_MS` = 60 s at pvp.rs:50), which is connection-independent.
- **R-rb-73-WILD-HOLD** — no reaper covers wild `battle`/`battle_wild` rows (battle.rs:1451–1453); `resolve_wild_battle_on_disconnect` is the only resolver, so a held second connection stalls a wild battle. PRE-EXISTING (today: never disconnect + never move stalls it identically); the fix changes only the mechanism. A wild-battle idle reaper is a separate slice.
- **R-rb-73-TOKEN-WEDGE** — a stolen-token holder can open a LIVE WS as the victim and keep it alive (answering pings) so the victim's own disconnects never run cleanup. Trades/challenges fall to their TTL reapers, PvP to the 60 s deadline, but wild battles and the presence rows have no independent backstop while the attacker's socket lives. This is the directional inverse of the defect (suppress vs force) and is bounded by the attacker keeping a live socket open (30 s idle close). Mitigation path: `connected_at_ms` tail column + an idle-session reaper (both additive) if it ever matters in practice.
- **R-rb-73-NOEXEC** — the `Some(conn)` branches of both hooks (own-row insert/delete) execute only under a real host; killed by source-freeze pins + mutant sweep + live proof.
- **R-rb-73-HOSTWRITES** — modelling `datastore_delete_by_index_scan_point_bsatn` behind an opt-in `Handle::allow_deletes()` in `native_host_tests.rs` would make the own-row delete executed. Deferred (YAGNI here; rb-72/41/46/47 abort-wall kills must stay byte-identical).

## Finalization on resume (hidden-dependency park, 2026-09-11)

1. Set `Amends: ADR-0232` in this ADR's header and add the reciprocal `Amended-by: ADR-0245` in ADR-0232 D2's header.
2. Add step 6e "erase player_session rows" to ADR-0228 D2's cascade step list (beside 6d).
3. Correct `sim-harness/src/bin/mr_load_driver.rs` AM25 prose (:76-89): strike the claim that an HTTP call "would also destroy a concurrent WS session's join state" (now false after the fix; the rest of AM25 stays true).
4. Record the X8 live two-connection transcript (WS session + `spacetime call <db> join_game` + a second HTTP call; the `player` row survives and the WS session stays joined).
5. Verify `docs/adr/0180-observability-stack-selection.md` for any AM25 twin claim and edit only if it repeats the falsified sentence.
6. Run `just adr-digest` after all ADR edits are committed.
