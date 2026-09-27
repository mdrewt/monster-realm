//! `rb73_session_tests` — disconnect side effects are gated on
//! the LAST live connection.
//!
//! Declared from `lib.rs` as `#[cfg(test)] #[path = "rb73_session_tests.rs"]
//! mod rb73_session_tests;`, so `crate::` resolves to the module crate root.
//!
//! EXECUTED against the in-memory host in `native_host_tests.rs`: the decision
//! predicate `has_live_session` runs against seeded rows (the oracle is its
//! RETURN VALUE), and both lifecycle hooks run on the connection-less
//! (`__dummy()`) context. The connection-bearing branches — `on_connect`
//! recording its session, `on_disconnect` deleting only its own row and waiting
//! for the last connection — are executed by `accounts_tests.rs` (`acct_nh`),
//! which drives real connection ids through `Fixture::run_as_conn_at`.
//! `player_session`'s privacy is the client-surface-privacy allowlist.
//!
//! THE HOST WALL: a write to a table a test did not open aborts the whole test
//! process (`native_host_tests.rs`); that abort is the intended RED for the two
//! `rb73_exec_*` tests on an unguarded hook, which is why they open only the
//! tables their guarded path may touch.

#![cfg(test)]

use crate::schema::{character, player, player_session, Character, Player, PlayerSession};
use game_core::{ActionState, Direction};
use spacetimedb::{ConnectionId, Identity};

// Connection ids for seeded session rows. `ConnectionId::from_u128` is
// `pub const` (spacetimedb-lib-2.8.1 src/connection_id.rs:60), so keys are
// constructible here even though a ctx's own `connection_id` is not settable.
// Distinct per row: `connection_id` is the table's PRIMARY KEY.
const CONN_MINE: u128 = 0x5e55_0001;
const CONN_STRANGER_A: u128 = 0x5e55_0002;
const CONN_STRANGER_B: u128 = 0x5e55_0003;
const CONN_SIBLING: u128 = 0x5e55;
const CONN_ALREADY_OPEN: u128 = 0x5e55_0004;

// ===========================================================================
// EXECUTED — the decision predicate. Oracle = the RETURN VALUE of
// `crate::has_live_session`, never its source text.
// ===========================================================================

/// One `player_session` row for identity A makes
/// `has_live_session(ctx, A)` report `true`.
///
/// This is the direction the whole fix hangs on: if the predicate cannot see a
/// live sibling session, `on_disconnect` never skips and the token-leak
/// amplifier stays open. Kills mutant M4, "always `false`" (the fix no-ops).
///
/// Structure: S0 seed, S1 a vacuity PRE-assert that the seeded row really is visible
/// through `ctx.db` on the SAME index the predicate reads (a mis-spelled
/// registration otherwise makes every assertion below vacuously about an empty
/// table), S2 the call, S3 the `Handle::remove` falsifiability control, which proves
/// the read channel is capable of reporting an absence at all.
#[test]
fn rb73_sessions_live_row_for_the_sender_is_seen() {
    let fx = crate::native_host_tests::fixture();
    let session_t = fx.table::<PlayerSession>("player_session", "identity", |r| r.identity);
    let ctx = fx.ctx();

    // A non-zero identity on purpose: this test passes the subject EXPLICITLY,
    // so it must not accidentally coincide with `ctx.sender()` (all zeros under
    // `__dummy()`, which is also `crate::WILD_IDENTITY`, lib.rs:89).
    let me = Identity::from_byte_array([7u8; 32]);

    session_t.seed(&PlayerSession {
        connection_id: ConnectionId::from_u128(CONN_MINE),
        identity: me,
    });

    assert_eq!(
        ctx.db.player_session().identity().filter(me).count(),
        1,
        "[rb73/live/pre] the seeded player_session row must be visible through the \
         `identity` btree index BEFORE the predicate runs, or the assertion below is \
         vacuous. Indexes requested so far: {:?}",
        fx.requested_indexes()
    );

    assert!(
        crate::has_live_session(&ctx, me),
        "[rb73/live/oracle] `has_live_session` returned false while exactly one \
         player_session row exists for that identity. This is ADR-0245 D3's whole \
         decision: a predicate that cannot see a live sibling connection makes \
         on_disconnect run its side effects on EVERY ephemeral HTTP call, which is the \
         defect (R-18r-b-DISCONNECTSELF) unfixed."
    );

    assert_eq!(
        session_t.remove(me),
        1,
        "[rb73/live/control-remove] exactly one seeded row must be removable, or the \
         assertions above are not falsifiable by anything"
    );
    assert_eq!(
        ctx.db.player_session().identity().filter(me).count(),
        0,
        "[rb73/live/control-absent] after removal the SAME read must report absent — \
         proving the PRE read is capable of failing, not vacuously true for any row state"
    );
    assert!(
        !crate::has_live_session(&ctx, me),
        "[rb73/live/control-oracle] after removal the predicate must flip to false. \
         Same fixture, same identity, opposite answer: this pair is what proves the \
         `true` above was READ from the row store rather than hard-coded."
    );
}

/// With no `player_session` row at all,
/// `has_live_session(ctx, A)` reports `false`.
///
/// Kills mutant M5, "always `true`" — the AVAILABILITY mutant, under which no
/// disconnect ever cleans up: trades stay open, PvP forfeits never fire, wild
/// battles soft-lock and presence rows leak forever.
///
/// The empty state is reached by REMOVING a row that was first proven visible,
/// rather than by simply never seeding one. That ordering is deliberate: a
/// `false` over a table that was never wired up correctly is indistinguishable
/// from a `false` over a table that genuinely holds nothing, so the PRE-assert
/// and the `Handle::remove` control together establish that this fixture's read
/// channel works before the oracle asks it a question whose expected answer is
/// the empty one.
#[test]
fn rb73_sessions_no_rows_means_no_session() {
    let fx = crate::native_host_tests::fixture();
    let session_t = fx.table::<PlayerSession>("player_session", "identity", |r| r.identity);
    let ctx = fx.ctx();

    let me = Identity::from_byte_array([7u8; 32]);

    session_t.seed(&PlayerSession {
        connection_id: ConnectionId::from_u128(CONN_MINE),
        identity: me,
    });

    assert_eq!(
        ctx.db.player_session().identity().filter(me).count(),
        1,
        "[rb73/none/pre] the seeded row must be visible through the `identity` btree index \
         before it is removed, or the empty state below proves nothing about the wiring. \
         Indexes requested so far: {:?}",
        fx.requested_indexes()
    );
    assert!(
        crate::has_live_session(&ctx, me),
        "[rb73/none/pre-oracle] the predicate must see the seeded row before it is removed. \
         This half of the differential is what makes the `false` below a MEASURED change of \
         answer rather than a constant."
    );

    assert_eq!(
        session_t.remove(me),
        1,
        "[rb73/none/control-remove] exactly one seeded row must be removable, or this test \
         never actually reaches the empty state it is about"
    );
    assert_eq!(
        ctx.db.player_session().identity().filter(me).count(),
        0,
        "[rb73/none/empty] after removal the table must read empty for this identity"
    );

    assert!(
        !crate::has_live_session(&ctx, me),
        "[rb73/none/oracle] `has_live_session` returned true with NO player_session row for \
         that identity. An always-true predicate makes on_disconnect skip unconditionally: \
         no trade is ever cancelled, no PvP forfeit ever fires, no wild battle is ever \
         resolved and presence rows are never cleaned up (ADR-0245 mutant M5, the \
         availability inverse of the defect)."
    );
}

/// Rows belonging to a DIFFERENT identity are not mine.
///
/// Kills mutant M6, a predicate that reads the wrong index or scans the whole
/// table — "is anyone at all connected" instead of "am I". Under M6 one
/// unrelated player's open socket would suppress every other player's
/// disconnect cleanup. (A literal `.iter()` mutant additionally walks into the
/// unmodelled `datastore_table_scan_bsatn` wall,
/// and aborts the process — a different failure mode, equally red.)
///
/// The assertion pair is DISCRIMINATING and taken in ONE state: asking for the
/// stranger returns `true` while asking for me returns `false`. A single
/// `false` here would also be satisfied by an always-false predicate (already
/// killed above, but a test that only passes because a sibling test fails is
/// not a tooth); the pair cannot be satisfied by any constant.
#[test]
fn rb73_sessions_stranger_rows_are_not_mine() {
    let fx = crate::native_host_tests::fixture();
    let session_t = fx.table::<PlayerSession>("player_session", "identity", |r| r.identity);
    let ctx = fx.ctx();

    let me = Identity::from_byte_array([7u8; 32]);
    let stranger = Identity::from_byte_array([9u8; 32]);

    // TWO rows for the stranger: a per-identity predicate must be indifferent
    // to how many sockets the OTHER player holds open.
    session_t.seed(&PlayerSession {
        connection_id: ConnectionId::from_u128(CONN_STRANGER_A),
        identity: stranger,
    });
    session_t.seed(&PlayerSession {
        connection_id: ConnectionId::from_u128(CONN_STRANGER_B),
        identity: stranger,
    });

    assert_eq!(
        ctx.db.player_session().identity().filter(stranger).count(),
        2,
        "[rb73/stranger/pre] both seeded stranger rows must be visible through the \
         `identity` btree index, or the negative assertion below is vacuous — it would be \
         reading an empty table rather than a table full of somebody else's rows. Indexes \
         requested so far: {:?}",
        fx.requested_indexes()
    );
    assert_eq!(
        ctx.db.player_session().identity().filter(me).count(),
        0,
        "[rb73/stranger/pre-mine-empty] the subject identity must own NO row in the state \
         this test asks about"
    );

    assert!(
        !crate::has_live_session(&ctx, me),
        "[rb73/stranger/oracle] `has_live_session` returned true for an identity that owns \
         no player_session row, while another identity owns two. The predicate is reading \
         the wrong index or the whole table: under that mutant one stranger's open socket \
         suppresses every other player's disconnect cleanup (ADR-0245 mutant M6)."
    );
    assert!(
        crate::has_live_session(&ctx, stranger),
        "[rb73/stranger/discriminates] the SAME predicate, in the SAME state, must answer \
         true for the identity that does own rows. Without this half the negative above is \
         satisfiable by a constant `false`."
    );

    assert_eq!(
        session_t.remove(stranger),
        2,
        "[rb73/stranger/control-remove] both seeded stranger rows must be removable, or the \
         reads above are not falsifiable by anything"
    );
    assert_eq!(
        ctx.db.player_session().identity().filter(stranger).count(),
        0,
        "[rb73/stranger/control-absent] after removal the SAME read must report absent"
    );
    assert!(
        !crate::has_live_session(&ctx, stranger),
        "[rb73/stranger/control-oracle] after removal the predicate must flip to false for \
         the stranger too"
    );
}

// ===========================================================================
// EXECUTED — the two lifecycle reducers, on the branches `__dummy()` reaches.
// ===========================================================================

/// ADR-0245 D3, executed: with a live `player_session` row for `ctx.sender()`,
/// `on_disconnect` performs NO side effect — the `player` and `character`
/// presence rows survive the call.
///
/// THE SUBJECT MUST BE `ctx.sender()`. Under `ReducerContext::__dummy()` that is
/// `Identity::from_byte_array([0u8; 32])`, which is also `crate::WILD_IDENTITY`
/// — normally a value to avoid in a fixture. Here it is mandatory
/// and not a smell: both hooks read `ctx.sender()` themselves, that field is
/// private and not settable, so any other identity would seed rows the reducer
/// under test never looks at and the test would pass for the wrong reason. No
/// wild-battle table is registered with this fixture, so the collision with
/// `WILD_IDENTITY` reaches nothing.
///
/// WHY THIS EXECUTES AT ALL. `__dummy()`'s `connection_id()` is `None`, so the
/// fixed body takes `leaving = None`, skips the own-row delete entirely, finds
/// the seeded session row through `has_live_session(ctx, me)` and returns
/// before ANY write. Only `player`, `character` and `player_session` are
/// registered: `player_conversation` deliberately is not.
///
/// Once the table and the helper exist but the guard does not — which is
/// exactly mutant M1, "guard deleted" — the reducer walks on to the
/// `player_conversation` owner-keyed removal, a unique-column delete that
/// bottoms out in `datastore_delete_by_index_scan_point_bsatn`.
/// That syscall is `unmodelled()`: it panics inside an `extern "C"` frame,
/// which cannot unwind, so the whole test PROCESS aborts and nextest reports a
/// signal rather than a failed assertion. The kill is real; the mechanism is
/// the abort, not a red POST assertion.
///
/// LIMIT: this test cannot tell "skipped because a sibling session is live"
/// from "always skips" (a bare `return;` passes it). The fires-when-it-should
/// direction is executed by `accounts_tests.rs`
/// `acct_nh::acct_on_disconnect_closes_its_own_session_and_waits_for_the_last`.
#[test]
fn rb73_exec_on_disconnect_skips_while_another_session_is_live() {
    let fx = crate::native_host_tests::fixture();
    let player_t = fx.table::<Player>("player", "identity", |r| r.identity);
    let character_t = fx.table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id);
    let session_t = fx.table::<PlayerSession>("player_session", "identity", |r| r.identity);
    let ctx = fx.ctx();

    let me = ctx.sender();
    // NEVER 0: that is the `#[auto_inc]` sentinel. Moot for `Handle::seed`
    // (it bypasses the real insert path), but a live tripwire for a future edit.
    const ENTITY_ID: u64 = 73;

    // --- S0: one live sibling session + the subject's presence rows ----------
    session_t.seed(&PlayerSession {
        connection_id: ConnectionId::from_u128(CONN_SIBLING),
        identity: me,
    });
    player_t.seed(&Player {
        identity: me,
        entity_id: ENTITY_ID,
        name: "rb73-subject".to_string(),
        online: true,
        last_input_seq: 0,
    });
    character_t.seed(&Character {
        entity_id: ENTITY_ID,
        zone_id: 0,
        tile_x: 0,
        tile_y: 0,
        facing: Direction::South,
        action: ActionState::Idle,
        move_started_at_ms: 0,
        sprite_id: 0,
        move_queue: Vec::new(),
    });

    // --- S1 PRE: every row this test reasons about is visible ----------------
    assert_eq!(
        ctx.db.player_session().identity().filter(me).count(),
        1,
        "[rb73/skip/pre-session] the sibling session row must be visible through the \
         `identity` btree index BEFORE the hook runs, or the hook has nothing to skip on and \
         every POST assertion below is vacuous. Indexes requested so far: {:?}",
        fx.requested_indexes()
    );
    assert!(
        ctx.db.player().identity().find(me).is_some(),
        "[rb73/skip/pre-player] the seeded player row must be visible through ctx.db BEFORE \
         on_disconnect runs, or the POST assertion is vacuous"
    );
    assert!(
        ctx.db.character().entity_id().find(ENTITY_ID).is_some(),
        "[rb73/skip/pre-character] the seeded character row must be visible through ctx.db \
         BEFORE on_disconnect runs, or the POST assertion is vacuous"
    );

    // --- S2: execute the shipped lifecycle hook ------------------------------
    crate::on_disconnect(&ctx);

    // --- S3 POST: the guard fired, so nothing was touched --------------------
    assert!(
        ctx.db.player().identity().find(me).is_some(),
        "[rb73/skip/post-player] on_disconnect deleted the player presence row while another \
         live connection exists for the same identity. That is the R-18r-b-DISCONNECTSELF \
         defect: every ephemeral HTTP /call connection fires client_disconnected, so this \
         path lets any token holder wipe a live session's presence rows on demand \
         (ADR-0245 context)."
    );
    assert!(
        ctx.db.character().entity_id().find(ENTITY_ID).is_some(),
        "[rb73/skip/post-character] on_disconnect deleted the character presence row while \
         another live connection exists — same ADR-0245 D3 criterion as the player row above"
    );
    assert_eq!(
        ctx.db.player_session().identity().filter(me).count(),
        1,
        "[rb73/skip/post-session] the sibling session row must survive a disconnect whose \
         own `connection_id()` is None. D3 deletes ONLY the leaving connection's own row, \
         inside `if let Some(conn) = leaving`; a delete hoisted out of that branch would \
         drop somebody else's live session here."
    );

    // --- S4 CONTROL: the read channel CAN observe an absence ------------------
    assert_eq!(
        player_t.remove(me),
        1,
        "[rb73/skip/control-remove-player] exactly one seeded player row must be removable, \
         or the S1/S3 presence assertions are not falsifiable by anything"
    );
    assert_eq!(
        character_t.remove(ENTITY_ID),
        1,
        "[rb73/skip/control-remove-character] exactly one seeded character row must be \
         removable, or the S1/S3 presence assertions are not falsifiable by anything"
    );
    assert_eq!(
        session_t.remove(me),
        1,
        "[rb73/skip/control-remove-session] exactly one seeded session row must be removable"
    );
    assert!(
        ctx.db.player().identity().find(me).is_none(),
        "[rb73/skip/control-absent-player] after removal the SAME read must report absent — \
         proving the `is_some()` reads above can fail, rather than being true for any state"
    );
    assert!(
        ctx.db.character().entity_id().find(ENTITY_ID).is_none(),
        "[rb73/skip/control-absent-character] same falsifiability proof for the character read"
    );
    assert_eq!(
        ctx.db.player_session().identity().filter(me).count(),
        0,
        "[rb73/skip/control-absent-session] same falsifiability proof for the session read"
    );
}

/// ADR-0245 D2, executed: `on_connect` on the reachable native branch returns
/// `Ok(())` and writes nothing.
///
/// Under `__dummy()` the sender is anonymous (`AuthCtx::internal().has_jwt()`
/// is `false`) and `connection_id()` is `None`, so the fixed body hoists the
/// JWT bool, calls `open_player_session(ctx)` — which must early-return on the
/// `None` connection id — and then takes the anonymous `return Ok(())`.
/// `accounts::provision_or_touch_account` is never reached, which is also what
/// pins AUTH-1's anonymous-first contract from the executed side.
///
/// THE ORACLE IS THE PROCESS ITSELF, not just the assertions. Every write
/// syscall on this host is `unmodelled()` and aborts the process (module
/// header), so "wrote nothing" is proven by the test running to completion at
/// all: an `open_player_session` that inserts before checking
/// `ctx.connection_id()` — the obvious way to write it, and exactly the
/// widening ADR-0245 D2 calls out — reaches `datastore_insert_bsatn` and kills
/// the process with a signal. The row-count assertions add the narrower, more
/// legible claim that no row appeared or vanished under the identities this
/// fixture can name.
///
/// DISCLOSED LIMIT. Reads here go through the `identity` btree index, so the
/// count assertions can only speak about identities the test names. A row
/// written under some third identity would be invisible to them — but not to
/// the abort above, which is why the two clauses are complementary rather than
/// redundant.
#[test]
fn rb73_exec_on_connect_none_branch_writes_nothing() {
    let fx = crate::native_host_tests::fixture();
    let session_t = fx.table::<PlayerSession>("player_session", "identity", |r| r.identity);
    let ctx = fx.ctx();

    // Same rule as the disconnect test: the hook reads `ctx.sender()` itself,
    // so the subject must be that value (all zeros under `__dummy()`).
    let me = ctx.sender();
    let probe = Identity::from_byte_array([3u8; 32]);

    session_t.seed(&PlayerSession {
        connection_id: ConnectionId::from_u128(CONN_ALREADY_OPEN),
        identity: me,
    });

    assert_eq!(
        ctx.db.player_session().identity().filter(me).count(),
        1,
        "[rb73/connect/pre] the seeded session row must be visible through the `identity` \
         btree index BEFORE the hook runs, or the POST count below is vacuous. Indexes \
         requested so far: {:?}",
        fx.requested_indexes()
    );
    assert_eq!(
        ctx.db.player_session().identity().filter(probe).count(),
        0,
        "[rb73/connect/pre-probe] the probe identity must own no row before the hook runs"
    );

    let outcome = crate::on_connect(&ctx);

    assert_eq!(
        outcome,
        Ok(()),
        "[rb73/connect/ok] on_connect must return Ok(()) for an anonymous connection. \
         Returning Err from this hook DISCONNECTS the client (crate doc), so AUTH-1 makes \
         anonymous play first-class: the JWT bool is hoisted, the session write runs, and \
         the anonymous branch returns Ok BEFORE any account provisioning is attempted."
    );

    assert_eq!(
        ctx.db.player_session().identity().filter(me).count(),
        1,
        "[rb73/connect/post] the seeded session row count changed across on_connect. With \
         `ctx.connection_id() == None`, `open_player_session` must early-return on the \
         `let Some(conn) = .. else {{ return; }}` guard and record nothing at all \
         (ADR-0245 D2)."
    );
    assert_eq!(
        ctx.db.player_session().identity().filter(probe).count(),
        0,
        "[rb73/connect/post-probe] a session row appeared under an identity on_connect was \
         never given"
    );

    assert_eq!(
        session_t.remove(me),
        1,
        "[rb73/connect/control-remove] exactly one seeded row must be removable, or the \
         count assertions above are not falsifiable by anything"
    );
    assert_eq!(
        ctx.db.player_session().identity().filter(me).count(),
        0,
        "[rb73/connect/control-absent] after removal the SAME read must report absent — \
         proving the counts above are measured, not constant"
    );
}
