//! `rb73_session_tests` — gating tests for rb-73 / ADR-0245 (residual
//! R-18r-b-DISCONNECTSELF): disconnect side effects are gated on the LAST live
//! connection.
//!
//! Declared from `lib.rs` as `#[cfg(test)] #[path = "rb73_session_tests.rs"]
//! mod rb73_session_tests;` (the `native_host_tests` / `m14_5d_1a_tests`
//! precedent at lib.rs:45-51), so `crate::` resolves to the module crate root
//! and the three subjects — `crate::has_live_session`,
//! `crate::open_player_session`'s wiring and the two lifecycle hooks — are all
//! reachable.
//!
//! THE SPLIT. ADR-0245 D5 divides the proof in two, because
//! `ReducerContext::connection_id` is a PRIVATE field and `__dummy()` yields
//! `None` (spacetimedb-2.8.1 src/lib.rs:1043-1055):
//!
//! EXECUTED, against the in-memory host in `native_host_tests.rs`. The decision
//! predicate `has_live_session` is read-only, so it runs for real against
//! seeded rows and the oracle is its RETURN VALUE (never its source text). Both
//! lifecycle hooks are ALSO executable, because under `__dummy()` the fixed
//! `on_disconnect` takes `leaving = None`, finds a seeded session row for
//! `ctx.sender()` and returns before any write, and the fixed `on_connect`
//! early-returns out of `open_player_session` on the `None` connection id and
//! then out of the anonymous branch (`AuthCtx::internal().has_jwt()` is false).
//!
//! SOURCE-SHAPE, over `include_str!` of the shipped `lib.rs` / `schema.rs`. The
//! `Some(conn)` branches of both hooks (the own-row insert and the own-row
//! delete) are structurally unexecutable here, so they are pinned by frozen
//! squashed bodies plus the mutant sweep plus ADR-0245's live two-connection
//! proof. Squashed pins are whitespace-insensitive, so a rustfmt
//! `fn_call_width` re-wrap cannot false-RED them.
//!
//! THE HOST WALL (read before trusting any green here). The in-memory host
//! models READS only; all four write syscalls are `unmodelled()` and panic
//! inside an `extern "C"` frame, which cannot unwind — so a write reached by
//! any executed test ABORTS THE WHOLE TEST PROCESS rather than failing an
//! assertion (`#[should_panic]` cannot catch it; nextest reports a signal).
//! That abort IS the intended RED for the two `rb73_exec_*` tests on an
//! unguarded `on_disconnect`, and it is also why those tests register only the
//! tables their guarded path is allowed to touch.
//!
//! SCAN HYGIENE (the `accounts_tests.rs` convention, :19-27). Cross-file eval
//! scanners concatenate every `server-module/src/**` file and do NOT strip
//! string literals, so every needle here that names a production accessor, fn
//! or table attribute is assembled at runtime with `concat!`, split mid-token.
//! This file also never spells a row-write verb contiguously after a table
//! accessor in ANY context, prose included — every such needle is split the
//! same way — because rows are seeded and removed through `Handle::seed` /
//! `Handle::remove`, which bypass the write syscalls entirely, so there is
//! never a reason for such a token to appear here at all.
//!
//! The three-stage strip pipeline below is a LOCAL copy (the per-module
//! convention — the `accounts_tests.rs` originals are private to that module
//! and must not be imported).

#![cfg(test)]

use crate::schema::{character, player, player_session, Character, Player, PlayerSession};
use game_core::{ActionState, Direction};
use spacetimedb::{ConnectionId, Identity};

// ===========================================================================
// Scan machinery (local copies — per-module convention). strings -> comments
// -> squash_ws, exactly as `accounts_tests.rs` / `ranking_tests.rs` do it.
// ===========================================================================

/// Blank the CONTENT (and delimiters) of `"..."` / `r"..."` / `r#"..."#` string
/// literals with spaces. Must run BEFORE `strip_rust_comments`, so that a `//`
/// inside a string literal is not mistaken for a line comment (and so that a
/// `{`/`}` inside a string literal cannot desync the brace-depth body
/// extractor below — `lib.rs` ships exactly such a literal in `init`'s
/// `log::info!` JSON).
fn strip_rust_strings(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = Vec::with_capacity(len);
    let mut i = 0;
    while i < len {
        if bytes[i] == b'r' {
            let mut hashes: usize = 0;
            let mut j = i + 1;
            while j < len && bytes[j] == b'#' && hashes < 6 {
                hashes += 1;
                j += 1;
            }
            if j < len && bytes[j] == b'"' {
                out.push(b' ');
                out.resize(out.len() + hashes, b' ');
                out.push(b' ');
                j += 1;
                loop {
                    if j >= len {
                        break;
                    }
                    if bytes[j] == b'"' {
                        let mut k = j + 1;
                        let mut closing: usize = 0;
                        while k < len && bytes[k] == b'#' && closing < hashes {
                            closing += 1;
                            k += 1;
                        }
                        if closing == hashes {
                            out.push(b' ');
                            out.resize(out.len() + hashes, b' ');
                            j = k;
                            break;
                        }
                    }
                    out.push(b' ');
                    j += 1;
                }
                i = j;
                continue;
            }
        }
        if bytes[i] == b'"' {
            out.push(b' ');
            i += 1;
            loop {
                if i >= len {
                    break;
                }
                if bytes[i] == b'\\' && i + 1 < len {
                    out.push(b' ');
                    out.push(b' ');
                    i += 2;
                } else if bytes[i] == b'"' {
                    out.push(b' ');
                    i += 1;
                    break;
                } else {
                    out.push(b' ');
                    i += 1;
                }
            }
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).expect("string-stripped source must be valid UTF-8")
}

/// Blank `/* ... */` and `// ...` comments with spaces. Run AFTER
/// `strip_rust_strings`.
fn strip_rust_comments(src: &str) -> String {
    let bytes = src.as_bytes();
    let len = bytes.len();
    let mut out = vec![b' '; len];
    let mut i = 0;
    while i < len {
        if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len {
                if bytes[i] == b'*' && bytes[i + 1] == b'/' {
                    i += 2;
                    break;
                }
                i += 1;
            }
        } else if i + 1 < len && bytes[i] == b'/' && bytes[i + 1] == b'/' {
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
        } else {
            out[i] = bytes[i];
            i += 1;
        }
    }
    String::from_utf8(out).expect("comment-stripped source must be valid UTF-8")
}

/// Remove all whitespace (rustfmt-proof needle matching).
fn squash_ws(src: &str) -> String {
    src.chars().filter(|c| !c.is_whitespace()).collect()
}

/// Full structural pipeline: strings blanked -> comments blanked -> whitespace
/// squashed. Every source-shape pin below reads this view, never raw text.
fn stripped_for_scan(src: &str) -> String {
    squash_ws(&strip_rust_comments(&strip_rust_strings(src)))
}

/// Non-overlapping occurrence count of `needle` in `hay`.
fn count_occurrences(hay: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    hay.match_indices(needle).count()
}

/// Extract the brace-bounded body that follows `needle` in an ALREADY-squashed
/// source: find `needle`, then the first `{` at or after it, then match braces
/// by depth. Works for a fn signature needle and equally for a
/// `pubstructName{` needle, which is why it is not called `..._fn_body`.
fn extract_squashed_braced_body<'a>(squashed: &'a str, needle: &str) -> Option<&'a str> {
    let start = squashed.find(needle)?;
    let after = &squashed[start..];
    let brace_rel = after.find('{')?;
    let body_start = start + brace_rel + 1;
    let bytes = squashed.as_bytes();
    let mut depth: usize = 1;
    let mut i = body_start;
    while i < bytes.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&squashed[body_start..i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// First-occurrence byte index of `needle` in `hay`, or panic with context.
fn idx(hay: &str, needle: &str) -> usize {
    hay.find(needle)
        .unwrap_or_else(|| panic!("scan needle not found (expected present): {needle:?}"))
}

// Sources under test (the SHIPPED production files).
const LIB_RS: &str = include_str!("lib.rs");
const SCHEMA_RS: &str = include_str!("schema.rs");

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
// `crate::has_live_session`, never its source text (ADR-0245 D5).
// ===========================================================================

/// ADR-0245 D5: one `player_session` row for identity A makes
/// `has_live_session(ctx, A)` report `true`.
///
/// This is the direction the whole fix hangs on: if the predicate cannot see a
/// live sibling session, `on_disconnect` never skips and the token-leak
/// amplifier stays open. Kills mutant M4, "always `false`" (the fix no-ops).
///
/// Structure, mirroring the rb-72 precedent (accounts_tests.rs:20127): S0 seed,
/// S1 a vacuity PRE-assert that the seeded row really is visible through
/// `ctx.db` on the SAME index the predicate reads (a mis-spelled registration
/// otherwise makes every assertion below vacuously about an empty table), S2
/// the call, S3 the `Handle::remove` falsifiability control, which proves the
/// read channel is capable of reporting an absence at all.
///
/// RED on the current tree: a compile error — neither `crate::schema::PlayerSession`
/// nor `crate::has_live_session` exists yet.
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

/// ADR-0245 D5: with no `player_session` row at all,
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
///
/// RED on the current tree: a compile error — neither `crate::schema::PlayerSession`
/// nor `crate::has_live_session` exists yet.
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

/// ADR-0245 D5: rows belonging to a DIFFERENT identity are not mine.
///
/// Kills mutant M6, a predicate that reads the wrong index or scans the whole
/// table — "is anyone at all connected" instead of "am I". Under M6 one
/// unrelated player's open socket would suppress every other player's
/// disconnect cleanup. (A literal `.iter()` mutant additionally walks into the
/// unmodelled `datastore_table_scan_bsatn` wall, native_host_tests.rs:351-354,
/// and aborts the process — a different failure mode, equally red.)
///
/// The assertion pair is DISCRIMINATING and taken in ONE state: asking for the
/// stranger returns `true` while asking for me returns `false`. A single
/// `false` here would also be satisfied by an always-false predicate (already
/// killed above, but a test that only passes because a sibling test fails is
/// not a tooth); the pair cannot be satisfied by any constant.
///
/// RED on the current tree: a compile error — neither `crate::schema::PlayerSession`
/// nor `crate::has_live_session` exists yet.
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
/// (lib.rs:89) — normally a value to avoid in a fixture. Here it is mandatory
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
/// THE RED, IN TWO STAGES. On the current tree the whole file fails to compile
/// (`crate::schema::PlayerSession` and `crate::has_live_session` do not exist).
/// Once the table and the helper exist but the guard does not — which is
/// exactly mutant M1, "guard deleted", and the shape of the shipped code today
/// — the reducer walks on to the `player_conversation` owner-keyed removal at
/// lib.rs:274, a unique-column delete that bottoms out in
/// `datastore_delete_by_index_scan_point_bsatn`.
/// That syscall is `unmodelled()`: it panics inside an `extern "C"` frame,
/// which cannot unwind, so the whole test PROCESS aborts and nextest reports a
/// signal rather than a failed assertion. The kill is real; the mechanism is
/// the abort, not a red POST assertion — saying so plainly is the rb-72 lesson
/// (accounts_tests.rs:20060-20090), whose first draft got this exact sentence
/// wrong.
///
/// HONEST LIMIT (ADR-0245 D5, red-team F6). This test cannot tell "skipped
/// because a sibling session is live" from "always skips": a body that is a
/// bare `return;` passes it. The fires-when-it-should direction is carried by
/// `rb73_wiring_on_disconnect_guard_precedes_and_body_is_frozen` below (whose
/// finale is exact body equality, so a bare `return;` reds it) and by the
/// mutant sweep's M12, which is precisely that body. Neither this test nor that
/// pin proves the live end-to-end two-connection behaviour; that is ADR-0245's
/// manual live proof.
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
///
/// RED on the current tree: a compile error — `crate::schema::PlayerSession`
/// does not exist (and `on_connect` has no `open_player_session` call).
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
// SOURCE-SHAPE — the wiring the native host structurally cannot execute.
// ===========================================================================

/// ADR-0245 D2: `on_connect`'s body is EXACTLY the four-statement hoisted-JWT
/// shape, and nothing else.
///
/// Kills mutant M7 (the `open_player_session` call deleted — no session is ever
/// recorded, so `has_live_session` is always false and the fix silently
/// no-ops) and mutant M8 (the call moved inside the JWT branch — anonymous
/// connections then get no session row, so every anonymous client keeps the old
/// force-resolve behaviour while the test suite's JWT-shaped reasoning stays
/// green).
///
/// Clause order is deliberate (red-team F7, ADR-0245 D5). DECLARATION
/// UNIQUENESS comes FIRST: `include_str!` embeds the raw text of BOTH halves of
/// a `#[cfg(test)]`/`#[cfg(not(test))]` twin while the compiler takes one, so a
/// harmless twin placed first would satisfy the first-occurrence body
/// extraction below while the published wasm runs the other. The extraction is
/// then FAIL-LOUD rather than vacuous, the body may contain no `#[cfg` token of
/// its own (the same bypass class one level down, as a statement attribute),
/// and the finale is exact equality — because every weaker clause reasons about
/// presence or position and is therefore blind to reachability.
#[test]
fn rb73_wiring_on_connect_body_is_frozen() {
    let squashed = stripped_for_scan(LIB_RS);
    let decl = concat!("fnon_con", "nect(");

    let decls = count_occurrences(&squashed, decl);
    assert_eq!(
        decls, 1,
        "[rb73/on-connect-decl-sole] `on_connect` is declared {decls} time(s) in lib.rs \
         (needle `{decl}`); exactly one is required. A cfg-gated declaration twin lets the \
         body extraction below read the harmless half while the published module compiles \
         the other one — measured CI-clean on earlier slices before this clause existed."
    );

    let body = extract_squashed_braced_body(&squashed, decl).unwrap_or_else(|| {
        panic!(
            "[rb73/on-connect-scope] the `on_connect` lifecycle reducer was not found in \
             lib.rs via the needle `{decl}`. Fail LOUD rather than pass vacuously: a renamed \
             or relocated hook must be re-derived here from ADR-0245 D2, never silently \
             skipped."
        )
    });

    let cfgs = count_occurrences(body, "#[cfg");
    assert_eq!(
        cfgs, 0,
        "[rb73/on-connect-no-cfg] `on_connect`'s body carries {cfgs} `#[cfg` attribute(s). A \
         cfg-gated statement inside the body is text the equality below happily accepts while \
         the shipped wasm and the test binary execute different code — the same twin bypass \
         as the declaration clause, one level down."
    );

    // Transcribed from ADR-0245 D2, split at points that differ from any needle
    // above so a silent edit to one artefact cannot drag the other with it.
    let expected = [
        "letjwt=ctx.sender_auth().has_jwt();",
        concat!("open_player", "_session(ctx);"),
        "if!jwt{returnOk(());}",
        concat!("accou", "nts::provision_or_touch_account(ctx)"),
    ]
    .concat();

    assert_eq!(
        body, expected,
        "[rb73/on-connect-body-exact] `on_connect`'s squashed body is not EXACTLY ADR-0245 \
         D2's four statements. The order is the requirement, not decoration: the JWT bool is \
         hoisted BEFORE the session write so that `has_jwt(` still precedes \
         `provision_or_touch_account(` and the body still holds no `Err(` (AUTH-1 / \
         `auth1_on_connect_has_jwt_gate_is_first_and_no_err_before`, and the eval's \
         [I/anon-first] / [I/anon-no-err] clauses); the session write sits ABOVE the \
         anonymous early return so anonymous connections get a row too — that is the \
         feature, and moving it below the return is mutant M8. Deleting it is M7. If the \
         sanctioned body legitimately changes, re-derive this literal FROM ADR-0245 D2 in \
         the same change."
    );
}

/// ADR-0245 D2: `open_player_session` is a SINGLE-PURPOSE helper — it guards on
/// the connection id first, and it touches nothing but the `player_session`
/// table.
///
/// This pin is the compensating control ADR-0245 D2 promises for a deliberate
/// widening: `on_connect` now reaches the database BEFORE the anonymous
/// `has_jwt` early return. The red-team challenge is "a helper launders
/// `ctx.db.` past the anon guard", and the answer has to be structural, because
/// AUTH-1's own scans see only `on_connect`'s body, where the call is a bare
/// identifier. So: the helper is declared exactly once, its body OPENS with the
/// `None` guard (nothing can run before it — including a write), it contains no
/// failure vocabulary at all (it is infallible by construction, so a future
/// `unwrap`/`expect`/`panic!`/`Err(` cannot turn a connect into a client
/// disconnect), it never names the `accounts` module, and EVERY `ctx.db.`
/// accessor call in it is `player_session()`.
///
/// The body is deliberately NOT pinned by exact equality: ADR-0245 §A3 leaves
/// the implementer a genuine choice between delete-before-insert and a
/// `try_insert`, and both are safe. The clauses here bound the space instead of
/// picking a winner — which is also why the accessor clause is a universally
/// quantified walk over every `ctx.db.` site rather than a needle count that a
/// second, unrelated write could slip past.
#[test]
fn rb73_wiring_open_session_body_is_frozen_and_single_purpose() {
    let squashed = stripped_for_scan(LIB_RS);
    let decl = concat!("fnopen_player", "_session(");

    let decls = count_occurrences(&squashed, decl);
    assert_eq!(
        decls, 1,
        "[rb73/open-session-decl-sole] `open_player_session` is declared {decls} time(s) in \
         lib.rs (needle `{decl}`); exactly one is required. A cfg-gated twin lets this scan \
         read the harmless half while the published module compiles the other."
    );

    let body = extract_squashed_braced_body(&squashed, decl).unwrap_or_else(|| {
        panic!(
            "[rb73/open-session-scope] `open_player_session` was not found in lib.rs via the \
             needle `{decl}`. ADR-0245 D2 puts this helper in lib.rs beside \
             `erase_character_rows`, NOT in accounts.rs (which would force widening \
             `allowed_write_tables` and its JS twin). Fail LOUD rather than pass vacuously."
        )
    });

    let cfgs = count_occurrences(body, "#[cfg");
    assert_eq!(
        cfgs, 0,
        "[rb73/open-session-no-cfg] `open_player_session`'s body carries {cfgs} `#[cfg` \
         attribute(s), so the text scanned here is not necessarily the text that ships"
    );

    let guard = concat!("letSome(conn)=ctx.connection", "_id()else{return;};");
    assert!(
        body.starts_with(guard),
        "[rb73/open-session-guard-first] `open_player_session`'s body does not OPEN with the \
         `None` connection-id guard `{guard}`. Anything above that guard runs on a context \
         with no connection — including, in the obvious wrong implementation, a row write \
         keyed on an id that does not exist. The guard being FIRST is also what makes \
         `rb73_exec_on_connect_none_branch_writes_nothing` executable at all: every write \
         syscall on the native host aborts the process."
    );

    for needle in [
        concat!("E", "rr("),
        concat!("accou", "nts::"),
        concat!("unwr", "ap("),
        concat!("expe", "ct("),
        concat!("pan", "ic!("),
        concat!("ctx.db.play", "er()"),
    ] {
        let hits = count_occurrences(body, needle);
        assert_eq!(
            hits, 0,
            "[rb73/open-session-single-purpose] `open_player_session`'s body contains \
             `{needle}` {hits} time(s). This helper is the compensating control for running \
             `ctx.db.` ahead of `on_connect`'s anonymous early return (ADR-0245 D2), so it \
             must stay infallible and single-purpose: failure vocabulary here turns a \
             connect into a forced client disconnect, and any second concern smuggled in \
             here is logic that AUTH-1's on_connect scans structurally cannot see."
        );
    }

    let accessor = concat!("player_ses", "sion()");
    let sites = count_occurrences(body, "ctx.db.");
    assert!(
        sites > 0,
        "[rb73/open-session-writes-something] `open_player_session`'s body never touches \
         `ctx.db.` at all, so no session is ever recorded and `has_live_session` can only \
         ever answer false — the whole fix would no-op (mutant M7). This clause also keeps \
         the universal quantification below from passing vacuously over zero sites."
    );
    for tail in body.split("ctx.db.").skip(1) {
        assert!(
            tail.starts_with(accessor),
            "[rb73/open-session-sole-accessor] `open_player_session` reaches a table accessor \
             other than `{accessor}`. Every `ctx.db.` site in this helper must be the session \
             table: this helper runs for ANONYMOUS connections, above `on_connect`'s \
             `has_jwt` early return, so a second accessor here is precisely the \
             'a helper launders ctx.db. past the anon guard' bypass ADR-0245 D2 names."
        );
    }
}

/// ADR-0245 D3: `on_disconnect` deletes its OWN row, then asks the guard, then
/// — and only then — runs the legacy side effects; and the whole body is
/// frozen.
///
/// Counts and ordering come first so a failure names WHICH part moved, then
/// exact equality is the finale, mirroring `m22s3b_resolver_body_order`
/// (accounts_tests.rs:9742-9877). Kills mutant M1 (guard deleted), M2 (guard
/// inverted / negated), M3 (guard moved below the resolver, so every side
/// effect still fires and only the tail is skipped), M9 (the own-row delete
/// dropped, which leaks a row per ephemeral HTTP call and wedges that
/// identity's cleanup until the next module launch replays its dangling
/// `client_disconnected`) and M12 (the body replaced by a bare `return;`, which
/// every executed test in this file would happily accept — see the honest limit
/// on `rb73_exec_on_disconnect_skips_while_another_session_is_live`).
///
/// The ordering triple is the security argument in three offsets: the own row
/// must be gone BEFORE the predicate runs (otherwise the leaving connection
/// counts itself live and nothing is ever cleaned up — which is why ADR-0245
/// §A3 could drop the `excluding` parameter at all), and the predicate must run
/// BEFORE the resolver (otherwise the guard protects nothing that matters).
#[test]
fn rb73_wiring_on_disconnect_guard_precedes_and_body_is_frozen() {
    let squashed = stripped_for_scan(LIB_RS);
    let decl = concat!("fnon_dis", "connect(");

    let decls = count_occurrences(&squashed, decl);
    assert_eq!(
        decls, 1,
        "[rb73/on-disconnect-decl-sole] `on_disconnect` is declared {decls} time(s) in \
         lib.rs (needle `{decl}`); exactly one is required, or the body extraction below can \
         be pointed at a harmless cfg-gated twin."
    );

    let helper_decl = concat!("fnhas_live", "_session(");
    let helper_decls = count_occurrences(&squashed, helper_decl);
    assert_eq!(
        helper_decls, 1,
        "[rb73/guard-decl-sole] `has_live_session` is declared {helper_decls} time(s) in \
         lib.rs (needle `{helper_decl}`); exactly one is required. A `#[cfg(test)]` twin of \
         the PREDICATE would make every executed test in this file green against a helper \
         the published wasm never runs — the twin bypass aimed at the oracle instead of at \
         the scan."
    );

    let body = extract_squashed_braced_body(&squashed, decl).unwrap_or_else(|| {
        panic!(
            "[rb73/on-disconnect-scope] the `on_disconnect` lifecycle reducer was not found \
             in lib.rs via the needle `{decl}`. Fail LOUD rather than pass vacuously."
        )
    });

    let cfgs = count_occurrences(body, "#[cfg");
    assert_eq!(
        cfgs, 0,
        "[rb73/on-disconnect-no-cfg] `on_disconnect`'s body carries {cfgs} `#[cfg` \
         attribute(s), so the text pinned below is not necessarily the text that ships"
    );

    let own_delete = concat!("player_session().connection", "_id()", ".del", "ete(");
    let guard = concat!("has_live", "_session(");
    let resolver = concat!("resolve_all_live", "_interactions(");

    let delete_hits = count_occurrences(body, own_delete);
    assert_eq!(
        delete_hits, 1,
        "[rb73/on-disconnect-own-delete] the leaving connection's own session row is deleted \
         {delete_hits} time(s) (needle `{own_delete}`); exactly one is required. ZERO is \
         mutant M9: every ephemeral HTTP /call leaks a row, and from the first leak onwards \
         that identity's real disconnects all see a phantom live session and skip cleanup \
         forever. MORE THAN ONE means a second, unguarded delete outside the \
         `if let Some(conn)` branch."
    );
    let guard_hits = count_occurrences(body, guard);
    assert_eq!(
        guard_hits, 1,
        "[rb73/on-disconnect-guard] the last-live-connection guard is called {guard_hits} \
         time(s) (needle `{guard}`); exactly one is required. ZERO is mutant M1 — the \
         defect unfixed."
    );
    let resolver_hits = count_occurrences(body, resolver);
    assert_eq!(
        resolver_hits, 1,
        "[rb73/on-disconnect-resolver] `resolve_all_live_interactions` is called \
         {resolver_hits} time(s) (needle `{resolver}`); exactly one is required. This is the \
         count `m22s3b_resolver_extraction_chain` (trading_tests.rs:3144-3154) also pins — \
         gating the hook must not drop the dispatch."
    );

    let at_delete = idx(body, own_delete);
    let at_guard = idx(body, guard);
    let at_resolver = idx(body, resolver);
    assert!(
        at_delete < at_guard,
        "[rb73/on-disconnect-delete-precedes-guard] the leaving connection's own session row \
         is deleted at offset {at_delete}, AFTER the guard at offset {at_guard}. The order is \
         the reason ADR-0245 §A3 could drop the `excluding` parameter: with the own row still \
         present the predicate counts the departing connection as live, so a LONE client's \
         disconnect skips every side effect and nothing is ever cleaned up."
    );
    assert!(
        at_guard < at_resolver,
        "[rb73/on-disconnect-guard-precedes-resolver] the guard is at offset {at_guard}, at \
         or after `resolve_all_live_interactions` at offset {at_resolver}. A guard below the \
         resolver is mutant M3: trades still cancel, PvP still forfeits and the wild battle \
         still auto-flees on every ephemeral HTTP connection — the amplifier this slice \
         exists to close — while only the presence-row tail is protected."
    );

    // The tail is the CURRENT shipped body verbatim (lib.rs:267-278), re-derived
    // here under the same strip pipeline; the head is ADR-0245 D3's prefix.
    // Transcribed independently of the needles above and split at different
    // points, so a silent edit to one artefact cannot move the other with it.
    let expected = [
        "letme=ctx.sender();",
        concat!("letleaving=ctx.connection", "_id();"),
        concat!(
            "ifletSome(conn)=leaving{ctx.db.player_session().connection",
            "_id()",
            ".del",
            "ete(conn);}"
        ),
        concat!("ifhas_live", "_session(ctx,me){return;}"),
        concat!("resolve_all_live", "_interactions(ctx,me);"),
        concat!(
            "ctx.db.player_conversation().owner_identity()",
            ".del",
            "ete(me);"
        ),
        concat!(
            "ifletSome(p)=ctx.db.player().identity().find(me){ctx.db.character().entity_id()",
            ".del",
            "ete(p.entity_id);ctx.db.player().identity()",
            ".del",
            "ete(me);}"
        ),
    ]
    .concat();

    for needle in [own_delete, guard, resolver] {
        assert!(
            expected.contains(needle),
            "[rb73/on-disconnect-literal-independence] the clause needle `{needle}` is not a \
             substring of the frozen body literal. The two are transcribed separately and \
             split at different points on purpose, so a mismatch means one artefact was \
             edited alone and the equality below is now asserting something other than the \
             clauses above."
        );
    }

    assert_eq!(
        body, expected,
        "[rb73/on-disconnect-body-exact] `on_disconnect`'s squashed body is not EXACTLY \
         ADR-0245 D3's guard prefix followed by the four pre-existing statements verbatim. \
         Every other clause in this test reasons about COUNT or POSITION and is therefore \
         blind to REACHABILITY: an `if false {{ .. }}` wrapper, an inverted guard, a `return;` \
         opening the body (mutant M12 — which every executed test in this file accepts, by \
         construction), or a rebinding of `me` above the calls keeps every needle present, \
         every count at 1 and every offset comparison true. The tail must be the CURRENT four \
         statements unchanged, because gating the hook is the only sanctioned change here — \
         `resolve_all_live_interactions`'s own frozen body \
         (`m22s3b_resolver_body_order`) and the presence-row order are other tests' \
         criteria. If the sanctioned body legitimately changes, re-derive this literal FROM \
         ADR-0245 D3 plus the shipped tail in the same change."
    );
}

/// ADR-0245 D1: the `player_session` table is PRIVATE and its key shape is
/// exactly PK-on-`connection_id` + btree-on-`identity`.
///
/// Both halves are one-way doors. Visibility: the row carries a host-minted
/// `ConnectionId` alongside an `Identity`, and ADR-0015 forbids connection ids
/// ever reaching a client — a `public` argument in the table attribute would
/// publish the whole join. Key shape: ADR-0006 / ADR-0173 D5 (transcribed at
/// evals/battle-schema-snapshot.eval.mjs:281-289) make a unique or primary key
/// un-addable and un-broadenable after first ship, so it has to be right in the
/// first commit; only defaulted TAIL columns stay addable later.
///
/// Shape of the pin: the table attribute occurs exactly once and is IMMEDIATELY
/// followed by the struct in the squashed view (so a decoy declaration, or an
/// attribute that has drifted onto some other struct, cannot satisfy it), the
/// struct itself is declared exactly once, and the struct body is pinned by
/// EXACT equality — column order, attributes and types included. A `public`
/// flip reds the attribute clause, because the needle ends at `)]`; a key-shape
/// drift reds the body equality.
#[test]
fn rb73_schema_session_table_is_private_and_keyed() {
    let squashed = stripped_for_scan(SCHEMA_RS);
    let attr = concat!("#[spacetimedb::ta", "ble(accessor=player_ses", "sion)]");
    let strukt = concat!("pubstructPlayer", "Session{");

    let attrs = count_occurrences(&squashed, attr);
    assert_eq!(
        attrs, 1,
        "[rb73/schema-attr-sole] the session table's attribute occurs {attrs} time(s) in \
         schema.rs; exactly one is required (needle `{attr}`). ZERO most often means the \
         table was declared `public`: the needle closes at `)]`, so any extra argument — \
         `public` above all — no longer matches, and ADR-0015 forbids publishing a row that \
         pairs a ConnectionId with an Identity. It also catches `name =` instead of \
         `accessor =`, and a table declared outside schema.rs (which `m22s6_table_row_types` \
         requires to live at `crate::schema::*`)."
    );

    let structs = count_occurrences(&squashed, strukt);
    assert_eq!(
        structs, 1,
        "[rb73/schema-struct-sole] `PlayerSession` is declared {structs} time(s) in \
         schema.rs; exactly one is required (needle `{strukt}`)"
    );

    let at = idx(&squashed, attr);
    let after = &squashed[at + attr.len()..];
    assert!(
        after.starts_with(strukt),
        "[rb73/schema-attr-adjacent] the session table attribute is not immediately followed \
         by `{strukt}` in the squashed view. Doc comments and ordinary comments are stripped \
         before this check and a `#[derive(Clone)]` placed ABOVE the table attribute is fine \
         (the `ExportBundle`/`Account` precedent, schema.rs:930-932) — but an attribute that \
         has drifted onto a different struct, or a derive wedged BETWEEN the two, means the \
         body pinned below is not the body the attribute decorates."
    );

    let body = extract_squashed_braced_body(&squashed, strukt).unwrap_or_else(|| {
        panic!(
            "[rb73/schema-struct-scope] the `PlayerSession` row struct was not found in \
             schema.rs via the needle `{strukt}`. Fail LOUD rather than pass vacuously."
        )
    });

    let expected = concat!(
        "#[primary_key]pubconnection",
        "_id:ConnectionId,",
        "#[index(btree)]pubidentity:Identity,"
    );
    assert_eq!(
        body, expected,
        "[rb73/schema-key-shape] `PlayerSession`'s squashed column list is not ADR-0245 D1's \
         key shape. It must be `#[primary_key] pub connection_id: ConnectionId` followed by \
         `#[index(btree)] pub identity: Identity`, in that order, with the type spelled \
         UNQUALIFIED (import `ConnectionId` into schema.rs's `use spacetimedb::{{..}}` list \
         beside `Identity`; an inline `spacetimedb::ConnectionId` path reds this pin). The \
         trailing comma is rustfmt's own output for a braced struct and is part of the \
         literal. A missing primary key, a key moved onto `identity`, or a `#[unique]` in \
         place of the btree index is unfixable after first ship: ADR-0006 / ADR-0173 D5 make \
         key changes automigration-FORBIDDEN, and only defaulted tail columns stay addable."
    );
}
