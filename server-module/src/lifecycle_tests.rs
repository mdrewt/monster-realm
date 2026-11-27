//! Connection lifecycle: disconnect side effects are gated on the LAST live
//! connection.
//!
//! Declared from `lib.rs` as `#[cfg(test)] #[path = "lifecycle_tests.rs"]
//! mod lifecycle_tests;`, so `crate::` resolves to the module crate root.
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

use crate::schema::{
    character, move_intent, player, player_session, Character, MoveIntent, Player, PlayerSession,
};
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
/// `on_disconnect` performs NO side effect — the `player`, `character` and
/// `move_intent` presence rows survive the call.
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
/// before ANY write. Only `player`, `character`, `move_intent` and
/// `player_session` are registered: `player_conversation` deliberately is not.
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
    let intent_t = fx.table_keyed::<MoveIntent, u64>("move_intent", "entity_id", |r| r.entity_id);
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
        discriminator: 0,
        lead_level: 0,
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
        acked_seq: 0,
    });
    intent_t.seed(&MoveIntent {
        entity_id: ENTITY_ID,
        queue: vec![game_core::MoveInput::Jump],
        last_input_seq: 3,
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
    assert!(
        ctx.db.move_intent().entity_id().find(ENTITY_ID).is_some(),
        "[rb73/skip/pre-intent] the seeded move_intent row must be visible through ctx.db \
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
    assert!(
        ctx.db
            .move_intent()
            .entity_id()
            .find(ENTITY_ID)
            .is_some_and(|i| i.queue == [game_core::MoveInput::Jump] && i.last_input_seq == 3),
        "[rb73/skip/post-intent] on_disconnect deleted or rewrote the move_intent row while \
         another live connection exists: the surviving session would lose its queued input \
         and its seq guard"
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
        intent_t.remove(ENTITY_ID),
        1,
        "[rb73/skip/control-remove-intent] exactly one seeded move_intent row must be removable"
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
    assert!(
        ctx.db.move_intent().entity_id().find(ENTITY_ID).is_none(),
        "[rb73/skip/control-absent-intent] same falsifiability proof for the move_intent read"
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

// ===========================================================================
// EXECUTED — trade sessions are cancelled with the disconnecting player.
// ===========================================================================

/// `resolve_all_live_interactions` (the bundle `on_disconnect` and the deletion cascade
/// run) deletes every trade session the player is in — the one they opened and the one
/// they were opened with — together with all of each session's snapshot rows and its
/// reaper schedule row, and leaves a session between two strangers whole.
///
/// Opens only the three session tables (each writable on its primary key and read through
/// every index the session code uses); the other resolvers in the bundle read tables this
/// fixture never registers and find nothing.
///
/// kills: the session sweep missing from the bundle · the opener index only (session 2
/// survives) · the partner index only (session 1 survives) · the session row deleted
/// without its snapshot or schedule rows · a sweep keyed on anything wider than the
/// player (session 3 deleted).
#[test]
fn ts2_disconnect_cancels_sessions() {
    use crate::schema::{TradeSession, TradeSessionSnapshot};
    use crate::trading_session::TradeSessionReaperSchedule;

    let fx = crate::native_host_tests::fixture();
    let sessions = fx
        .table_keyed::<TradeSession, u64>("trade_session", "session_id", |r| r.session_id)
        .writable()
        .unique();
    let _ = fx.table::<TradeSession>("trade_session", "opener", |r| r.opener);
    let _ = fx.table::<TradeSession>("trade_session", "partner", |r| r.partner);
    let snapshots = fx
        .table_keyed::<TradeSessionSnapshot, u64>("trade_session_snapshot", "snapshot_id", |r| {
            r.snapshot_id
        })
        .writable()
        .unique();
    let _ =
        fx.table_keyed::<TradeSessionSnapshot, u64>("trade_session_snapshot", "session_id", |r| {
            r.session_id
        });
    let _ =
        fx.table_keyed::<TradeSessionSnapshot, u64>("trade_session_snapshot", "monster_id", |r| {
            r.monster_id
        });
    let schedules = fx
        .table_keyed::<TradeSessionReaperSchedule, u64>(
            "trade_session_reaper_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        )
        .writable()
        .unique();
    let _ = fx.table_keyed::<TradeSessionReaperSchedule, u64>(
        "trade_session_reaper_schedule",
        "session_id",
        |r| r.session_id,
    );

    let player = Identity::from_byte_array([0x51; 32]);
    let partner_of_player = Identity::from_byte_array([0x52; 32]);
    let opener_with_player = Identity::from_byte_array([0x53; 32]);
    let stranger_x = Identity::from_byte_array([0x54; 32]);
    let stranger_y = Identity::from_byte_array([0x55; 32]);

    let offer = |monster_ids: Vec<u64>| game_core::trading::TradeSessionOffer {
        monster_ids,
        items: vec![],
        currency: 0,
        cards: vec![],
    };
    let snapshot = |snapshot_id: u64, session_id: u64, monster_id: u64| TradeSessionSnapshot {
        snapshot_id,
        session_id,
        monster_id,
        species_id: 1,
        nickname: String::new(),
        level: 7,
        xp: 0,
        iv_hp: 1,
        iv_attack: 1,
        iv_defense: 1,
        iv_speed: 1,
        iv_sp_attack: 1,
        iv_sp_defense: 1,
        nature_kind: game_core::NatureKind::Hardy,
        ev_hp: 0,
        ev_attack: 0,
        ev_defense: 0,
        ev_speed: 0,
        ev_sp_attack: 0,
        ev_sp_defense: 0,
        stat_hp: 40,
        stat_attack: 20,
        stat_defense: 20,
        stat_speed: 20,
        stat_sp_attack: 20,
        stat_sp_defense: 20,
        current_hp: 0,
        party_slot: 0,
        last_care_at_ms: 0,
        essence_fire: 0,
        essence_water: 0,
        essence_plant: 0,
        essence_electric: 0,
        essence_earth: 0,
        essence_wind: 0,
        essence_light: 0,
        essence_dark: 0,
        trust_favorable_count: 0,
        trust_unfavorable_count: 0,
        trust_favorable_battle_day_epoch: 0,
        quality_time_ticks_total: 0,
        quality_time_accum_ms: 0,
        quality_time_window_ms: 0,
        quality_time_window_start_ms: 0,
        last_essence_train_at_ms: 0,
    };
    // (session id, opener, opener's monsters, partner, partner's monsters)
    type SessionSeed = (u64, Identity, Vec<u64>, Identity, Vec<u64>);
    let rows: [SessionSeed; 3] = [
        (1, player, vec![11, 12], partner_of_player, vec![21]),
        (2, opener_with_player, vec![31], player, vec![13]),
        (3, stranger_x, vec![41], stranger_y, vec![51, 52]),
    ];
    for (session_id, opener, opener_ids, partner, partner_ids) in rows {
        for (n, &monster_id) in (0u64..).zip(opener_ids.iter().chain(partner_ids.iter())) {
            snapshots.seed(&snapshot(session_id * 100 + n, session_id, monster_id));
        }
        sessions.seed(&TradeSession {
            session_id,
            opener,
            partner,
            opener_offer: offer(opener_ids),
            partner_offer: offer(partner_ids),
            opener_confirmed: session_id == 1,
            partner_confirmed: session_id == 2,
            revision: 1,
            created_at_ms: 0,
        });
        schedules.seed(&TradeSessionReaperSchedule {
            scheduled_id: session_id + 500,
            scheduled_at: spacetimedb::ScheduleAt::Time(
                spacetimedb::Timestamp::from_micros_since_unix_epoch(3_600_000_000),
            ),
            session_id,
        });
    }

    let footprint = || {
        let mut live: Vec<u64> = sessions.rows().iter().map(|s| s.session_id).collect();
        live.sort_unstable();
        let mut snaps: Vec<(u64, u64)> = snapshots
            .rows()
            .iter()
            .map(|s| (s.session_id, s.monster_id))
            .collect();
        snaps.sort_unstable();
        let mut armed: Vec<u64> = schedules.rows().iter().map(|s| s.session_id).collect();
        armed.sort_unstable();
        (live, snaps, armed)
    };
    assert_eq!(
        footprint(),
        (
            vec![1, 2, 3],
            vec![
                (1, 11),
                (1, 12),
                (1, 21),
                (2, 13),
                (2, 31),
                (3, 41),
                (3, 51),
                (3, 52)
            ],
            vec![1, 2, 3],
        ),
        "[ts2/disconnect/pre] every seeded session, snapshot and schedule row must be in the \
         store before the bundle runs"
    );

    crate::resolve_all_live_interactions(&fx.ctx(), player);

    assert_eq!(
        footprint(),
        (vec![3], vec![(3, 41), (3, 51), (3, 52)], vec![3]),
        "[ts2/disconnect/post] the disconnecting player's sessions — 1 (opener) and 2 \
         (partner) — must be gone with every snapshot row and their schedule rows, and the \
         strangers' session 3 must be whole. Indexes the code asked the host for: {:?}",
        fx.requested_indexes()
    );
}

/// Both presence deletes that key on `player.entity_id` — the `character` row
/// and its `move_intent` row — are issued inside `on_disconnect`'s
/// player-found block BEFORE the `player` row itself is deleted, and
/// `erase_character_rows` deletes both through the same join. The native host
/// cannot observe statement order, so this reads the source: comment lines are
/// dropped, then each needle must appear exactly once per function, in order.
///
/// kills: the `move_intent` delete dropped from either function (an orphan row
/// a later character could never collide with but nothing would ever sweep) /
/// moved after the `player` delete / duplicated outside the player-found block.
#[test]
fn presence_deletes_take_the_intent_row_with_the_character_before_the_player() {
    let src = include_str!("lib.rs");
    let body = |header: &str| -> String {
        let from = src.find(header).unwrap_or_else(|| panic!("`{header}`"));
        let rest = &src[from..];
        let to = rest.find("\n}\n").expect("the function's closing brace");
        rest[..to]
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let once = |code: &str, needle: &str| -> usize {
        assert_eq!(code.matches(needle).count(), 1, "exactly one `{needle}`");
        code.find(needle).unwrap()
    };
    const CHARACTER: &str = "ctx.db.character().entity_id().delete(p.entity_id);";
    const INTENT: &str = "ctx.db.move_intent().entity_id().delete(p.entity_id);";

    let disconnect = body("pub fn on_disconnect(ctx: &ReducerContext) {");
    let found = once(
        &disconnect,
        "if let Some(p) = ctx.db.player().identity().find(me) {",
    );
    let character = once(&disconnect, CHARACTER);
    let intent = once(&disconnect, INTENT);
    let player = once(&disconnect, "ctx.db.player().identity().delete(me);");
    assert!(
        found < character && character < intent && intent < player,
        "on_disconnect: player lookup ({found}), character ({character}), move_intent \
         ({intent}), then the player row last ({player})"
    );

    let erase = body("pub(crate) fn erase_character_rows(ctx: &ReducerContext, owner: Identity) {");
    let found = once(
        &erase,
        "if let Some(p) = ctx.db.player().identity().find(owner) {",
    );
    assert!(found < once(&erase, CHARACTER) && found < once(&erase, INTENT));
    assert!(
        !erase.contains("player().identity().delete"),
        "erase_character_rows never deletes the player anchor"
    );
}

// ===========================================================================
// EXECUTED — a connection arms one re-check of the identity's checked account.
// The build's own profile names an account service (the `test` and `world`
// builds); `official` and `conflict` name none, and `account_checks_tests.rs`
// runs the arming under those profiles.
// ===========================================================================

#[cfg(not(feature = "official"))]
mod recheck_arming {
    use crate::account_checks::{RecheckSchedule, WorldAccount};
    use crate::native_host_tests::{fixture, Fixture, Handle};
    use crate::schema::PlayerSession;
    use spacetimedb::{ConnectionId, Identity, ScheduleAt, Timestamp};

    const NOW: i64 = 1_800_000_000_000;

    fn at(ms: i64) -> Timestamp {
        Timestamp::from_micros_since_unix_epoch(ms * 1000)
    }

    fn alice() -> Identity {
        Identity::from_byte_array([0x11; 32])
    }

    fn bob() -> Identity {
        Identity::from_byte_array([0x22; 32])
    }

    struct T<'a> {
        accounts: Handle<'a, WorldAccount>,
        rechecks: Handle<'a, RecheckSchedule>,
    }

    /// What `on_connect` reads and writes on an `Open` world: the session table, the
    /// account rows (read, and stamped when a re-check is armed) and the re-check table
    /// (written, its key drawn from a sequence).
    fn tables(fx: &Fixture) -> T<'_> {
        let _ = fx
            .table_keyed::<PlayerSession, ConnectionId>("player_session", "connection_id", |r| {
                r.connection_id
            })
            .unique()
            .writable();
        let _ = fx
            .table::<PlayerSession>("player_session", "identity", |r| r.identity)
            .writable();
        let _ = fx
            .table_keyed::<WorldAccount, String>("world_account", "handle", |r| r.handle.clone())
            .unique()
            .writable();
        let _ = fx
            .table_keyed::<RecheckSchedule, u64>("recheck_schedule", "scheduled_id", |r| {
                r.scheduled_id
            })
            .unique();
        T {
            accounts: fx
                .table::<WorldAccount>("world_account", "identity", |r| r.identity)
                .unique()
                .writable(),
            rechecks: fx
                .table::<RecheckSchedule>("recheck_schedule", "identity", |r| r.identity)
                .unique()
                .writable()
                .auto_inc(|r| r.scheduled_id, |r, v| r.scheduled_id = v),
        }
    }

    fn checked(t: &T<'_>, who: Identity, handle: &str, checked_at_ms: i64) {
        t.accounts.seed(&WorldAccount {
            handle: handle.to_string(),
            identity: who,
            entitled: true,
            checked_at_ms,
            is_host: false,
        });
    }

    /// `who` connects over connection `conn` at `ms`.
    fn connect(fx: &Fixture, who: Identity, conn: u128, ms: i64) {
        assert_eq!(
            fx.run_as_conn_at(who, conn, None, at(ms), crate::on_connect),
            Ok(()),
            "the connection is accepted"
        );
    }

    /// The armed re-checks, as `(identity bytes, fire time in ms)`, sorted.
    fn armed(tables: &T<'_>) -> Vec<([u8; 32], i64)> {
        let mut out: Vec<([u8; 32], i64)> = tables
            .rechecks
            .rows()
            .into_iter()
            .map(|r| {
                let fire = match r.scheduled_at {
                    ScheduleAt::Time(stamp) => stamp.to_micros_since_unix_epoch() / 1000,
                    ScheduleAt::Interval(_) => panic!("a re-check is a one-shot row"),
                };
                (r.identity.to_byte_array(), fire)
            })
            .collect();
        out.sort();
        out
    }

    /// `who`'s `world_account` row as `(handle, identity bytes, entitled, checked_at_ms,
    /// is_host)`, if it holds one.
    fn account_of(t: &T<'_>, who: Identity) -> Option<(String, [u8; 32], bool, i64, bool)> {
        t.accounts
            .rows()
            .into_iter()
            .find(|r| r.identity == who)
            .map(|r| {
                (
                    r.handle,
                    r.identity.to_byte_array(),
                    r.entitled,
                    r.checked_at_ms,
                    r.is_host,
                )
            })
    }

    /// A row checked exactly ten minutes (600 000 ms) before the connection arms one
    /// re-check, firing at once, for the connecting identity, and stamps that row's
    /// `checked_at_ms` with the connection time, every other field as it is; a neighbour
    /// whose row is as old but who does not connect gets no re-check and keeps its row.
    ///
    /// kills: no arming at connect; a strict `>` on the age; a re-check armed for every
    /// stale row; a fire time other than the connection's; arming with no stamp; a stamp
    /// other than the connection time; a stamp that rewrites another field or another
    /// identity's row.
    #[test]
    fn a_connection_arms_one_recheck_for_a_row_checked_ten_minutes_ago_lpw23_5() {
        let fx = fixture();
        let t = tables(&fx);
        checked(&t, alice(), "k1.AbCdEf0123456789-_", NOW - 600_000);
        checked(&t, bob(), "k1.ZyXwVu9876543210_-", NOW - 600_000);
        let bob_before = account_of(&t, bob());
        connect(&fx, alice(), 0xC0_0001, NOW);
        assert_eq!(armed(&t), vec![(alice().to_byte_array(), NOW)]);
        assert_eq!(
            account_of(&t, alice()),
            Some((
                "k1.AbCdEf0123456789-_".to_string(),
                alice().to_byte_array(),
                true,
                NOW,
                false
            )),
            "the connecting identity's row is stamped with the connection time"
        );
        assert_eq!(
            account_of(&t, bob()),
            bob_before,
            "the neighbour's row is untouched"
        );
        assert_eq!(t.accounts.rows().len(), 2, "no row added or removed");
    }

    /// A row checked ten minutes ago is armed and stamped by a first connection. The host
    /// then spends the armed row and the run stores nothing. A connection 1 ms after the
    /// first, and one 9 minutes 59 seconds after it, arm nothing and write nothing; a
    /// connection exactly ten minutes after the first arms again, firing at that time.
    ///
    /// kills: arming with no stamp (a client reconnecting in a loop would have the world
    /// send a request at each connection); the age measured from the row's earlier check
    /// rather than the stamp; a bound other than ten minutes from the stamp.
    #[test]
    fn a_spent_recheck_with_no_answer_arms_nothing_for_ten_minutes_after_the_stamp_lpw23_5() {
        let fx = fixture();
        let t = tables(&fx);
        checked(&t, alice(), "k1.AbCdEf0123456789-_", NOW - 600_000);
        connect(&fx, alice(), 0xC0_0001, NOW);
        assert_eq!(
            armed(&t),
            vec![(alice().to_byte_array(), NOW)],
            "the first arms"
        );
        assert_eq!(
            t.rechecks.remove(alice()),
            1,
            "the host spends the armed row"
        );
        let stamped = account_of(&t, alice());
        assert_eq!(
            stamped.as_ref().map(|r| r.3),
            Some(NOW),
            "fixture: the first connection stamps the row"
        );
        for (conn, later) in [(0xC0_0002_u128, 1_i64), (0xC0_0003, 599_000)] {
            fx.reset_writes();
            connect(&fx, alice(), conn, NOW + later);
            assert_eq!(
                armed(&t),
                Vec::new(),
                "{later} ms after the first: nothing armed"
            );
            assert_eq!(
                fx.writes_to("recheck_schedule"),
                0,
                "{later} ms after the first: no write on the re-checks"
            );
            assert_eq!(
                fx.writes_to("world_account"),
                0,
                "{later} ms after the first: no write on the accounts"
            );
            assert_eq!(
                account_of(&t, alice()),
                stamped,
                "{later} ms: the row stays"
            );
        }
        connect(&fx, alice(), 0xC0_0004, NOW + 600_000);
        assert_eq!(
            armed(&t),
            vec![(alice().to_byte_array(), NOW + 600_000)],
            "ten minutes after the first: armed again"
        );
        assert_eq!(
            account_of(&t, alice()).map(|r| r.3),
            Some(NOW + 600_000),
            "and stamped again"
        );
    }

    /// An identity whose account is pending deletion, holding a row checked an hour ago,
    /// arms nothing and writes nothing on connect; a neighbour whose account is active and
    /// whose row is as old is armed on its own connection.
    ///
    /// kills: arming without reading the account's deletion state; a world request made
    /// about an identity that is being erased.
    #[test]
    fn a_connection_whose_account_is_pending_deletion_arms_nothing_lpw23_5() {
        let fx = fixture();
        let t = tables(&fx);
        let accounts = fx
            .table::<crate::schema::Account>("account", "identity", |r| r.identity)
            .unique();
        accounts.seed(&crate::accounts::requested_deletion(
            crate::accounts::new_account_row(alice(), String::new(), 0),
            1,
        ));
        accounts.seed(&crate::accounts::new_account_row(bob(), String::new(), 0));
        checked(&t, alice(), "k1.AbCdEf0123456789-_", NOW - 3_600_000);
        checked(&t, bob(), "k1.ZyXwVu9876543210_-", NOW - 3_600_000);
        let alice_before = account_of(&t, alice());
        fx.reset_writes();
        connect(&fx, alice(), 0xC0_0001, NOW);
        assert_eq!(armed(&t), Vec::new(), "nothing armed");
        assert_eq!(
            fx.writes_to("recheck_schedule"),
            0,
            "no write on the re-checks"
        );
        assert_eq!(fx.writes_to("world_account"), 0, "no write on the accounts");
        assert_eq!(account_of(&t, alice()), alice_before, "the row stays");
        connect(&fx, bob(), 0xC0_0002, NOW);
        assert_eq!(
            armed(&t),
            vec![(bob().to_byte_array(), NOW)],
            "control: the active neighbour is armed"
        );
    }

    /// A row checked 9 minutes 59 seconds (599 000 ms) before the connection arms nothing.
    ///
    /// kills: a bound below ten minutes; arming whatever the age.
    #[test]
    fn a_row_checked_nine_minutes_59_seconds_ago_arms_nothing_lpw23_5() {
        let fx = fixture();
        let t = tables(&fx);
        checked(&t, alice(), "k1.AbCdEf0123456789-_", NOW - 599_000);
        connect(&fx, alice(), 0xC0_0001, NOW);
        assert_eq!(armed(&t), Vec::new());
        assert_eq!(fx.writes_to("recheck_schedule"), 0, "no write on the table");
    }

    /// A second connection while the first's re-check is armed arms no second one.
    ///
    /// kills: arming without looking for an armed row.
    #[test]
    fn a_second_connection_arms_no_second_recheck_lpw23_5() {
        let fx = fixture();
        let t = tables(&fx);
        checked(&t, alice(), "k1.AbCdEf0123456789-_", NOW - 3_600_000);
        connect(&fx, alice(), 0xC0_0001, NOW);
        connect(&fx, alice(), 0xC0_0002, NOW + 1_000);
        assert_eq!(armed(&t), vec![(alice().to_byte_array(), NOW)]);
    }

    /// An identity with no `world_account` row arms nothing.
    ///
    /// kills: arming for every connection.
    #[test]
    fn an_identity_with_no_account_row_arms_nothing_lpw23_5() {
        let fx = fixture();
        let t = tables(&fx);
        checked(&t, bob(), "k1.ZyXwVu9876543210_-", NOW - 3_600_000);
        connect(&fx, alice(), 0xC0_0001, NOW);
        assert_eq!(armed(&t), Vec::new());
    }
}

// ===========================================================================
// EXECUTED — a source whose character was moved to another identity
// disconnects and writes nothing of that character.
// ===========================================================================

mod moved_source_disconnect {
    use crate::native_host_tests::{fixture, Fixture, Handle};
    use crate::schema::{
        Character, LastPosition, MoveIntent, Player, PlayerConversation, PlayerSession,
    };
    use game_core::{ActionState, Direction};
    use spacetimedb::sats::bsatn::to_vec;
    use spacetimedb::{ConnectionId, Identity, Serialize, Timestamp};

    const T0: i64 = 1_760_000_000_000;
    const CONN_SOURCE: u128 = 0x5e55_0042;
    const CONN_BYSTANDER: u128 = 0x5e55_0043;
    const SOURCE_ENTITY: u64 = 42;
    const BYSTANDER_ENTITY: u64 = 43;

    fn at(ms: i64) -> Timestamp {
        Timestamp::from_micros_since_unix_epoch(ms * 1000)
    }

    fn source() -> Identity {
        Identity::from_byte_array([0x42; 32])
    }

    fn dest() -> Identity {
        Identity::from_byte_array([0x24; 32])
    }

    fn bystander() -> Identity {
        Identity::from_byte_array([0x43; 32])
    }

    struct T<'a> {
        sessions: Handle<'a, PlayerSession>,
        players: Handle<'a, Player>,
        chars: Handle<'a, Character, u64>,
        intents: Handle<'a, MoveIntent, u64>,
        saved: Handle<'a, LastPosition>,
        conversations: Handle<'a, PlayerConversation>,
    }

    /// What `on_disconnect` and `move_position` read and write: the session rows (the
    /// leaving connection's own deleted by its key), the presence rows, the saved positions
    /// and the conversation rows. The interaction resolvers read tables this fixture never
    /// registers and find nothing.
    fn tables(fx: &Fixture) -> T<'_> {
        let _ = fx
            .table_keyed::<PlayerSession, ConnectionId>("player_session", "connection_id", |r| {
                r.connection_id
            })
            .unique()
            .writable();
        let _ = fx.table_keyed::<Player, u64>("player", "entity_id", |r| r.entity_id);
        let _ = fx.table_keyed::<Character, u32>("character", "zone_id", |r| r.zone_id);
        T {
            sessions: fx
                .table::<PlayerSession>("player_session", "identity", |r| r.identity)
                .writable(),
            players: fx
                .table::<Player>("player", "identity", |r| r.identity)
                .writable()
                .unique(),
            chars: fx
                .table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
                .writable()
                .unique(),
            intents: fx
                .table_keyed::<MoveIntent, u64>("move_intent", "entity_id", |r| r.entity_id)
                .writable()
                .unique(),
            saved: fx
                .table::<LastPosition>("last_position", "owner_identity", |r| r.owner_identity)
                .writable()
                .unique(),
            conversations: fx
                .table::<PlayerConversation>("player_conversation", "owner_identity", |r| {
                    r.owner_identity
                })
                .writable()
                .unique(),
        }
    }

    /// `who` connected over `conn` and in the game, its character in zone 1 on `(x, y)`.
    fn in_game(
        t: &T<'_>,
        who: Identity,
        conn: u128,
        entity_id: u64,
        x: i32,
        y: i32,
        facing: Direction,
    ) {
        t.sessions.seed(&PlayerSession {
            connection_id: ConnectionId::from_u128(conn),
            identity: who,
        });
        t.players.seed(&Player {
            identity: who,
            entity_id,
            name: "p".to_string(),
            online: true,
            discriminator: 7,
            lead_level: 0,
        });
        t.chars.seed(&Character {
            entity_id,
            zone_id: 1,
            tile_x: x,
            tile_y: y,
            facing,
            action: ActionState::Idle,
            move_started_at_ms: 0,
            sprite_id: 0,
            move_queue: Vec::new(),
            acked_seq: 5,
        });
        t.intents.seed(&MoveIntent {
            entity_id,
            queue: Vec::new(),
            last_input_seq: 5,
        });
    }

    /// The source in the game on (6, 3) facing East, and a bystander in the game with a
    /// conversation open.
    fn seed_world(t: &T<'_>) {
        in_game(
            t,
            source(),
            CONN_SOURCE,
            SOURCE_ENTITY,
            6,
            3,
            Direction::East,
        );
        in_game(
            t,
            bystander(),
            CONN_BYSTANDER,
            BYSTANDER_ENTITY,
            2,
            2,
            Direction::South,
        );
        t.conversations.seed(&PlayerConversation {
            owner_identity: bystander(),
            npc_entity_id: 9,
            current_node_id: "n".to_string(),
        });
    }

    fn enc<R: Serialize>(rows: Vec<R>) -> Vec<Vec<u8>> {
        let mut out: Vec<Vec<u8>> = rows
            .iter()
            .map(|r| to_vec(r).expect("a row always BSATN-encodes"))
            .collect();
        out.sort();
        out
    }

    /// `who`'s `last_position` rows, encoded.
    fn saved_of(t: &T<'_>, who: Identity) -> Vec<Vec<u8>> {
        enc(t
            .saved
            .rows()
            .into_iter()
            .filter(|r| r.owner_identity == who)
            .collect())
    }

    fn position(owner: Identity, x: i32, y: i32, facing: Direction) -> LastPosition {
        LastPosition {
            owner_identity: owner,
            zone_id: 1,
            tile_x: x,
            tile_y: y,
            facing,
        }
    }

    /// The bystander's session, presence and conversation rows.
    fn bystander_rows(t: &T<'_>) -> Vec<Vec<Vec<u8>>> {
        vec![
            enc(t
                .sessions
                .rows()
                .into_iter()
                .filter(|r| r.identity == bystander())
                .collect()),
            enc(t
                .players
                .rows()
                .into_iter()
                .filter(|r| r.identity == bystander())
                .collect()),
            enc(t
                .chars
                .rows()
                .into_iter()
                .filter(|r| r.entity_id == BYSTANDER_ENTITY)
                .collect()),
            enc(t
                .intents
                .rows()
                .into_iter()
                .filter(|r| r.entity_id == BYSTANDER_ENTITY)
                .collect()),
            enc(t.conversations.rows()),
        ]
    }

    /// The source's last connection closes after its character was moved: its own session
    /// row goes, the disconnect writes nothing to `last_position`, `player`, `character`,
    /// `move_intent` or `monster`, the destination's saved position is byte-equal before and
    /// after, the source holds no saved position, and the bystander is untouched.
    ///
    /// kills: a move that leaves the source's `player` row (its disconnect then saves a
    /// position for the source and deletes the presence rows); a live position not carried.
    #[test]
    fn a_moved_sources_disconnect_writes_nothing_of_the_character_lpw42_4() {
        let fx = fixture();
        let t = tables(&fx);
        seed_world(&t);

        fx.run_as_at(dest(), at(T0), |ctx| {
            crate::movement::move_position(ctx, source(), dest())
        });
        let dest_after_move = saved_of(&t, dest());
        assert_eq!(
            dest_after_move,
            enc(vec![position(dest(), 6, 3, Direction::East)]),
            "precondition: the move carried the live position to the destination"
        );
        let bystander_before = bystander_rows(&t);
        fx.reset_writes();

        fx.run_as_conn_at(
            source(),
            CONN_SOURCE,
            None,
            at(T0 + 1),
            crate::on_disconnect,
        );

        assert!(
            t.sessions.rows().iter().all(|r| r.identity != source()),
            "the leaving connection's own session row is deleted"
        );
        for table in [
            "last_position",
            "player",
            "character",
            "move_intent",
            "monster",
        ] {
            assert_eq!(
                fx.writes_to(table),
                0,
                "the disconnect wrote {table} for a moved character"
            );
        }
        assert_eq!(
            saved_of(&t, dest()),
            dest_after_move,
            "the destination's saved position is untouched"
        );
        assert!(
            saved_of(&t, source()).is_empty(),
            "the source holds no saved position"
        );
        assert_eq!(
            bystander_rows(&t),
            bystander_before,
            "the bystander's rows are untouched"
        );
    }

    /// The control for the test above: the same disconnect with no move saves the source's
    /// position and deletes its presence rows, so a move that leaves the source in the game
    /// fails the test above.
    ///
    /// kills: a fixture under which the disconnect never reaches the presence branch.
    #[test]
    fn an_unmoved_sources_disconnect_saves_its_position_lpw42_4() {
        let fx = fixture();
        let t = tables(&fx);
        seed_world(&t);

        fx.run_as_conn_at(
            source(),
            CONN_SOURCE,
            None,
            at(T0 + 1),
            crate::on_disconnect,
        );

        assert_eq!(
            saved_of(&t, source()),
            enc(vec![position(source(), 6, 3, Direction::East)]),
            "the disconnect saved where the source's character stood"
        );
        assert!(
            t.players.rows().iter().all(|r| r.identity != source()),
            "the disconnect deleted the source's player row"
        );
    }
}
