//! `playtest` domain-submodule tests — pt-b2.
//!
//! Declared from `server-module/src/playtest.rs` as:
//!   `#[cfg(test)] #[path = "playtest_tests.rs"] mod playtest_tests;`
//! so `super::` resolves to `playtest.rs`.
//!
//! Pure seams (`hp_permille`, `PlaytestKind`, `plan_reap`, `plan_reaper_arm`,
//! `next_wake_ms`, `plan_wake`, `build_playtest_event`) plus native-host tests of
//! the shipped `playtest_reaper`, its scheduler-only guard and its on-demand
//! schedule (`record_recruit_event`, `ensure_playtest_reaper`,
//! `erase_playtest_events`).

use spacetimedb::Identity;

// ===========================================================================
// ── hp_permille pure-seam tests
// ===========================================================================

/// hp_permille: max==0 returns 0 (no division by zero).
///
/// Kills: impl that does `current * 1000 / max` without guarding max==0 (panic
/// or nonsense result on zero denominator).
#[test]
fn hp_permille_max_zero_returns_zero() {
    assert_eq!(
        super::hp_permille(0, 0),
        0,
        "PT-B2 hp_permille: max==0 must return 0 (guard against divide-by-zero). \
         A u16 division by zero is a panic in debug builds."
    );
    assert_eq!(
        super::hp_permille(100, 0),
        0,
        "PT-B2 hp_permille: current>0 but max==0 must return 0 (still guards max==0)."
    );
}

/// hp_permille: current==max returns exactly 1000 (full HP).
///
/// Kills: off-by-one where `current * 1000 / max` returns 999 due to integer
/// floor truncation when current==max (a correct impl returns min(1000, floor)).
#[test]
fn hp_permille_full_hp_returns_1000() {
    assert_eq!(
        super::hp_permille(100, 100),
        1000,
        "PT-B2 hp_permille: current==max must return 1000 (100% HP → 1000‰). \
         An off-by-one floor impl returns 999 here."
    );
    assert_eq!(
        super::hp_permille(1, 1),
        1000,
        "PT-B2 hp_permille: current==max==1 must return 1000."
    );
}

/// hp_permille: half HP returns approximately 500 (integer floor).
///
/// Kills: impl that rounds instead of floors, or that uses floating-point
/// division and reintroduces rounding errors.
#[test]
fn hp_permille_half_hp_returns_500_floor() {
    // 50/100 → 500 exactly.
    assert_eq!(
        super::hp_permille(50, 100),
        500,
        "PT-B2 hp_permille: 50/100 must return 500 (integer floor)."
    );
    // 1/3 → floor(333.3) = 333, NOT 334.
    assert_eq!(
        super::hp_permille(1, 3),
        333,
        "PT-B2 hp_permille: 1/3 must return 333 (floor, not round). \
         Rounding would give 333 here (same), but 2/3 would give 666 vs 667."
    );
    // 2/3 → floor(666.6) = 666.
    assert_eq!(
        super::hp_permille(2, 3),
        666,
        "PT-B2 hp_permille: 2/3 must return 666 (floor, not 667)."
    );
}

/// hp_permille: current > max is clamped to 1000.
///
/// Kills: impl that returns >1000 for an overheal scenario (e.g. a temporary HP
/// buff). The contract specifies `min(1000, current*1000/max)`.
#[test]
fn hp_permille_over_max_is_clamped_to_1000() {
    assert_eq!(
        super::hp_permille(200, 100),
        1000,
        "PT-B2 hp_permille: current > max must be clamped to 1000. \
         Without the clamp, an overheal would return 2000 (overflow for u16 if \
         current*1000 overflows, or just a wrong value)."
    );
    assert_eq!(
        super::hp_permille(u16::MAX, 1),
        1000,
        "PT-B2 hp_permille: u16::MAX / 1 must still be clamped to 1000."
    );
}

/// hp_permille: current==0 returns 0 (fainted monster).
///
/// Kills: impl that returns 1 or some non-zero floor due to a rounding bug.
#[test]
fn hp_permille_zero_current_returns_zero() {
    assert_eq!(
        super::hp_permille(0, 100),
        0,
        "PT-B2 hp_permille: current==0 must return 0 (fainted, 0‰)."
    );
    assert_eq!(
        super::hp_permille(0, 1),
        0,
        "PT-B2 hp_permille: current==0, any max must return 0."
    );
}

/// hp_permille: all outputs are ≤ 1000 (property exhaustive over
/// small values). Tests the full domain for small u16 values to prove the
/// clamp is universally applied.
///
/// Kills: any impl where the clamp only covers the specific `current > max`
/// branch but not the multiplication overflow path.
#[test]
fn hp_permille_result_always_leq_1000() {
    // Exhaustive for a grid of (current, max) pairs covering the likely
    // edge-case space. NOT a property test requiring fast-check — the pure
    // math is simple enough for a targeted exhaustive check.
    let test_cases: &[(u16, u16)] = &[
        (0, 1),
        (1, 1),
        (1, 2),
        (999, 1000),
        (1000, 1000),
        (1001, 1000),
        (u16::MAX, u16::MAX),
        (u16::MAX, 1),
        (100, 100),
        (50, 100),
        (0, 0),
    ];
    for &(current, max) in test_cases {
        let result = super::hp_permille(current, max);
        assert!(
            result <= 1000,
            "PT-B2 hp_permille: result must always be ≤ 1000 (clamp 0..=1000). \
             Got {} for current={}, max={}.",
            result,
            current,
            max
        );
    }
}

// ===========================================================================
// ── PlaytestKind::code() pinned literal test
// ===========================================================================

/// PlaytestKind::RecruitAttempt.code() must return the pinned literal 1.
///
/// Kills:
///   - impl that uses `self as u16` (would return 0 for the first variant,
///     not 1; the spec says EXPLICIT literal `RecruitAttempt => 1`).
///   - impl that accidentally maps RecruitAttempt to 2 or any other value.
///   - impl that changes the variant ordering and breaks the `as u16` shorthand.
///
/// RATIONALE: source-scan below separately checks absence of `as u16`, but this
/// executed test is the primary mutation-killing pin for the value itself.
#[test]
fn playtest_kind_recruit_attempt_code_is_1() {
    assert_eq!(
        super::PlaytestKind::RecruitAttempt.code(),
        1u16,
        "PT-B2 PlaytestKind::RecruitAttempt.code() must return exactly 1. \
         The spec pins the explicit literal: `RecruitAttempt => 1`. \
         Using `self as u16` would return 0 (first variant ordinal in Rust). \
         A mutation to code() => 2 must also fail this test."
    );
}

// ===========================================================================
// ── plan_reap pure-seam tests
// ===========================================================================

/// plan_reap (a): all-fresh rows, count ≤ cap → returns [].
///
/// Kills: impl that always deletes something regardless of TTL or cap.
#[test]
fn plan_reap_all_fresh_under_cap_returns_empty() {
    let now_ms = 10_000_i64;
    let ttl_ms = 5_000_i64;
    let cap = 10u64;
    // 3 rows, all created 1 ms ago (well within TTL), count < cap.
    let rows: Vec<(u64, i64)> = vec![(1, 9_999), (2, 9_998), (3, 9_997)];
    let result = super::plan_reap(&rows, now_ms, ttl_ms, cap, 100);
    assert!(
        result.is_empty(),
        "PT-B2 plan_reap (a): all-fresh rows under cap must return [] (nothing to delete). \
         Got: {:?}.",
        result
    );
}

/// plan_reap (b): count > cap, none expired → returns OLDEST (count-cap) ids.
///
/// This is the primary cap-eviction tooth. The spec says: from the fresh
/// (non-expired) rows, return the oldest `(fresh_count - cap)` ids. Input is
/// sorted ascending by event_id (oldest first).
///
/// Kills:
///   - impl that keeps the oldest and deletes the newest (wrong eviction direction)
///   - impl that returns just the count correct but picks wrong ids (length-only check)
///   - impl that returns cap ids instead of (count - cap) ids
#[test]
fn plan_reap_over_cap_no_expired_returns_oldest() {
    let now_ms = 100_000_i64;
    let ttl_ms = 60_000_i64; // 60s TTL
    let cap = 3u64;
    let batch = 100;
    // 5 fresh rows (created 1s ago — well within 60s TTL), ids 10..14 ascending.
    // count(5) > cap(3) → must evict 2 oldest: ids 10, 11.
    let rows: Vec<(u64, i64)> = vec![
        (10, 99_000), // oldest
        (11, 99_100),
        (12, 99_200),
        (13, 99_300),
        (14, 99_400), // newest
    ];
    let mut result = super::plan_reap(&rows, now_ms, ttl_ms, cap, batch);
    result.sort_unstable();
    assert_eq!(
        result,
        vec![10u64, 11],
        "PT-B2 plan_reap (b): over-cap with no expired rows must evict the OLDEST \
         (count-cap) ids. cap=3, count=5 → evict 2 oldest (ids 10,11). \
         Kills: impl that keeps oldest and deletes newest (would return [13,14])."
    );
}

/// plan_reap (c): some expired rows → ALL expired ids are returned.
///
/// Kills: impl that ignores TTL expiry and only applies cap eviction.
#[test]
fn plan_reap_expired_rows_all_returned() {
    let now_ms = 100_000_i64;
    let ttl_ms = 10_000_i64; // 10s TTL
    let cap = 100u64; // large cap so no cap-eviction
    let batch = 100;
    // Rows 1 and 2: expired (created 20s ago, ttl is 10s).
    // Rows 3 and 4: fresh (created 1s ago).
    let rows: Vec<(u64, i64)> = vec![
        (1, 80_000), // expired: now - created = 20000 >= ttl 10000
        (2, 85_000), // expired: 15000 >= 10000
        (3, 99_000), // fresh: 1000 < 10000
        (4, 99_500), // fresh: 500 < 10000
    ];
    let mut result = super::plan_reap(&rows, now_ms, ttl_ms, cap, batch);
    result.sort_unstable();
    assert_eq!(
        result,
        vec![1u64, 2],
        "PT-B2 plan_reap (c): expired rows (now - created >= ttl) must all be returned. \
         IDs 1 and 2 are expired; ids 3 and 4 are fresh and under cap."
    );
}

/// plan_reap (d): expired rows + over-cap fresh rows → union of both.
///
/// Kills: impl that only handles one condition (expired OR cap) but not both
/// simultaneously in the same call.
#[test]
fn plan_reap_expired_plus_over_cap_returns_union() {
    let now_ms = 100_000_i64;
    let ttl_ms = 10_000_i64; // 10s TTL
    let cap = 2u64;
    let batch = 100;
    // Rows 1,2: expired.
    // Rows 3,4,5: fresh (created 1s ago), count(3) > cap(2) → oldest 1 fresh evicted.
    let rows: Vec<(u64, i64)> = vec![
        (1, 80_000), // expired
        (2, 85_000), // expired
        (3, 99_000), // fresh, oldest
        (4, 99_100), // fresh
        (5, 99_200), // fresh, newest
    ];
    let mut result = super::plan_reap(&rows, now_ms, ttl_ms, cap, batch);
    result.sort_unstable();
    // Expired: [1, 2]. Fresh over-cap: count=3, cap=2 → evict 1 oldest fresh = id 3.
    // Union = [1, 2, 3].
    assert_eq!(
        result,
        vec![1u64, 2, 3],
        "PT-B2 plan_reap (d): expired + over-cap must return the union. \
         Expired=[1,2], fresh count=3 over cap=2 → oldest fresh evicted=[3]. \
         Union=[1,2,3]."
    );
}

/// plan_reap (e): result truncated to `batch` when delete-set > batch.
///
/// Kills: impl that ignores the batch limit (returns all matching ids regardless
/// of how many that is, making a single tick unboundedly expensive).
#[test]
fn plan_reap_truncated_to_batch() {
    let now_ms = 100_000_i64;
    let ttl_ms = 1_000_i64; // 1s TTL — all rows will be expired
    let cap = 0u64; // also all are over-cap for good measure
    let batch = 3;
    // 6 rows all expired (created 90s ago), ids 1..6 ascending.
    let rows: Vec<(u64, i64)> = vec![
        (1, 9_000),
        (2, 9_100),
        (3, 9_200),
        (4, 9_300),
        (5, 9_400),
        (6, 9_500),
    ];
    let result = super::plan_reap(&rows, now_ms, ttl_ms, cap, batch);
    assert_eq!(
        result.len(),
        3,
        "PT-B2 plan_reap (e): result must be truncated to `batch`=3. \
         Without truncation, all 6 expired rows would be returned, making the \
         tick O(unbounded). Got: {:?}.",
        result
    );
    // The spec says oldest are deleted first when truncating.
    let mut result = result;
    result.sort_unstable();
    assert_eq!(
        result,
        vec![1u64, 2, 3],
        "PT-B2 plan_reap (e): when truncating to batch, must return the OLDEST \
         ids (front of sorted input), not arbitrary ids. Got: {:?}.",
        result
    );
}

/// plan_reap (f): TTL boundary exactness.
///
/// - A row at `created = now - ttl` IS deleted (>= means "at least TTL old").
/// - A row at `created = now - ttl + 1` is NOT deleted (one ms newer than cutoff).
///
/// Kills: impl that uses `>` instead of `>=` (off-by-one, rows exactly at the
/// TTL boundary are never deleted — a subtle leak).
#[test]
fn plan_reap_ttl_boundary_exactness() {
    let now_ms = 10_000_i64;
    let ttl_ms = 5_000_i64;
    let cap = 100u64; // large cap, no cap eviction
    let batch = 100;

    // Row at EXACTLY the boundary: now - created = ttl → MUST be deleted.
    let at_boundary: Vec<(u64, i64)> = vec![(1, 5_000)]; // now(10000) - created(5000) = 5000 == ttl(5000)
    let result = super::plan_reap(&at_boundary, now_ms, ttl_ms, cap, batch);
    assert_eq!(
        result,
        vec![1u64],
        "PT-B2 plan_reap (f) AT-boundary: row with created_at = now - ttl ({}) must be \
         deleted (>= comparison). \
         Kills: impl using > instead of >=.",
        at_boundary[0].1
    );

    // Row one ms fresher than boundary: now - created = ttl - 1 → MUST NOT be deleted.
    let just_fresh: Vec<(u64, i64)> = vec![(2, 5_001)]; // now - created = 4999 < 5000
    let result = super::plan_reap(&just_fresh, now_ms, ttl_ms, cap, batch);
    assert!(
        result.is_empty(),
        "PT-B2 plan_reap (f) JUST-FRESH: row with created_at = now - ttl + 1 ({}) must NOT \
         be deleted (4999 < 5000). \
         Kills: impl using > that turns into wrong boundary when rearranged.",
        just_fresh[0].1
    );
}

// ===========================================================================
// ── plan_reaper_arm pure-seam tests
// ===========================================================================

/// plan_reaper_arm: empty existing_ids → insert one, delete nothing.
///
/// Kills: impl that does nothing on empty (singleton invariant not enforced on
/// arm — the reaper would never be scheduled).
#[test]
fn plan_reaper_arm_empty_inserts_one() {
    let plan = super::plan_reaper_arm(&[]);
    assert!(
        plan.insert_one,
        "PT-B2 plan_reaper_arm: empty existing_ids must set insert_one=true \
         (no reaper scheduled yet → must insert the singleton row)."
    );
    assert!(
        plan.delete_ids.is_empty(),
        "PT-B2 plan_reaper_arm: empty existing_ids must have no delete_ids. \
         Got: {:?}.",
        plan.delete_ids
    );
}

/// plan_reaper_arm: single existing id → no insert, no delete.
///
/// Kills: impl that always inserts (would create duplicates) or always deletes
/// (would remove the only singleton, breaking the schedule entirely).
#[test]
fn plan_reaper_arm_single_existing_no_change() {
    let plan = super::plan_reaper_arm(&[7u64]);
    assert!(
        !plan.insert_one,
        "PT-B2 plan_reaper_arm: one existing row must set insert_one=false \
         (singleton already present — do not create a duplicate)."
    );
    assert!(
        plan.delete_ids.is_empty(),
        "PT-B2 plan_reaper_arm: one existing row must have empty delete_ids \
         (the single row IS the singleton — keep it). Got: {:?}.",
        plan.delete_ids
    );
}

/// plan_reaper_arm: multiple existing ids → no insert, delete all but first.
///
/// Kills: impl that keeps the last instead of the first (wrong dedup direction),
/// or that deletes all (would destroy the singleton), or that does nothing (would
/// leave duplicates that fire the reaper multiple times).
#[test]
fn plan_reaper_arm_multiple_keeps_first_deletes_rest() {
    let plan = super::plan_reaper_arm(&[7u64, 9, 11]);
    assert!(
        !plan.insert_one,
        "PT-B2 plan_reaper_arm: multiple existing rows must set insert_one=false \
         (at least one row present already)."
    );
    let mut got = plan.delete_ids.clone();
    got.sort_unstable();
    assert_eq!(
        got,
        vec![9u64, 11],
        "PT-B2 plan_reaper_arm: must keep the FIRST id (7) and delete the rest (9, 11). \
         Kills: impl that keeps last and deletes rest (would return [7, 9]); \
         impl that deletes all (would return [7, 9, 11])."
    );
}

// ===========================================================================
// ── build_playtest_event pure-seam tests
// ===========================================================================

/// build_playtest_event: bait_item_id=None maps to 0 in the row.
///
/// Kills: impl that stores None as Some(0) or that leaves the field undefined.
#[test]
fn build_playtest_event_none_bait_maps_to_zero() {
    let id = Identity::from_byte_array([1u8; 32]);
    let row = super::build_playtest_event(id, 1, 12345, 42, 99, 500, None, true);
    assert_eq!(
        row.bait_item_id, 0,
        "PT-B2 build_playtest_event: bait_item_id=None must store 0 (sentinel 'no bait'). \
         Got: {}.",
        row.bait_item_id
    );
}

/// build_playtest_event: bait_item_id=Some(3) maps to 3 in the row.
///
/// Kills: impl that ignores the Some value and always stores 0 or a wrong id.
#[test]
fn build_playtest_event_some_bait_maps_to_value() {
    let id = Identity::from_byte_array([2u8; 32]);
    let row = super::build_playtest_event(id, 1, 0, 0, 0, 0, Some(3u32), false);
    assert_eq!(
        row.bait_item_id, 3,
        "PT-B2 build_playtest_event: bait_item_id=Some(3) must store 3. \
         Got: {}.",
        row.bait_item_id
    );
}

/// build_playtest_event: event_id must be 0 (auto_inc placeholder).
///
/// Kills: impl that sets event_id to a non-zero value (the auto_inc column
/// must be 0 on insert so SpacetimeDB fills it in).
#[test]
fn build_playtest_event_id_is_zero_placeholder() {
    let id = Identity::from_byte_array([3u8; 32]);
    let row = super::build_playtest_event(id, 1, 0, 0, 0, 0, None, false);
    assert_eq!(
        row.event_id, 0,
        "PT-B2 build_playtest_event: event_id must be 0 (auto_inc placeholder). \
         SpacetimeDB fills in the real id on insert. Got: {}.",
        row.event_id
    );
}

/// build_playtest_event: all other fields pass through unchanged.
///
/// Kills:
///   - impl that swaps kind and hp_permille
///   - impl that ignores the success flag
///   - impl that truncates species_id or battle_id
///   - impl that stores a wrong identity
#[test]
fn build_playtest_event_passthrough_fields() {
    let id = Identity::from_byte_array([42u8; 32]);
    let kind: u16 = 7;
    let now_ms: i64 = 99_999;
    let battle_id: u64 = 12345;
    let species_id: u32 = 678;
    let hp_pm: u16 = 333;
    let success = true;

    let row = super::build_playtest_event(
        id, kind, now_ms, battle_id, species_id, hp_pm, None, success,
    );

    assert_eq!(row.identity, id, "identity passthrough");
    assert_eq!(row.kind, kind, "kind passthrough");
    assert_eq!(row.created_at_ms, now_ms, "created_at_ms passthrough");
    assert_eq!(row.battle_id, battle_id, "battle_id passthrough");
    assert_eq!(row.species_id, species_id, "species_id passthrough");
    assert_eq!(row.hp_permille, hp_pm, "hp_permille passthrough");
    assert_eq!(row.success, success, "success passthrough");
}

// ===========================================================================
// Native-host behaviour (debloat Phase 2: ST-playtest_tests#reaper-scheduler-guard).
// Replaces the scheduler-guard text pin: the SHIPPED reducer runs with a chosen
// sender through `Fixture::run_as_at`, against the fixture's module identity.
// ===========================================================================

/// `playtest_reaper` is scheduler-only: every non-module caller (a player, the
/// all-zero wild/dummy identity, and the identity that WAS the module before it
/// changed) is refused before a single row is deleted; the module identity reaps
/// exactly the expired rows (TTL boundary inclusive) and keeps the fresh one.
///
/// kills: the guard deleted / placed after the deletes / inverted / compared
/// against a hard-coded identity instead of `ctx.database_identity()`.
#[test]
fn nh_playtest_reaper_is_scheduler_only_and_refuses_before_any_delete() {
    use crate::native_host_tests::{fixture, DEFAULT_DATABASE_IDENTITY};
    use spacetimedb::{ScheduleAt, Timestamp};

    let fx = fixture();
    let events = fx
        .table_keyed::<super::PlaytestEvent, u64>("playtest_event", "event_id", |r| r.event_id)
        .writable()
        .scannable()
        .unique();
    let _schedule = schedule_table(&fx);
    let player = Identity::from_byte_array([0x11; 32]);
    let now = super::PLAYTEST_EVENT_TTL_MS * 3;
    let ev = |event_id: u64, created_at_ms: i64| super::PlaytestEvent {
        event_id,
        identity: player,
        kind: 1,
        created_at_ms,
        battle_id: 0,
        species_id: 1,
        hp_permille: 500,
        bait_item_id: 0,
        success: false,
    };
    events.seed(&ev(1, 0));
    events.seed(&ev(2, now - super::PLAYTEST_EVENT_TTL_MS));
    events.seed(&ev(3, now - 1));
    let ids = || {
        let mut v: Vec<u64> = events.rows().iter().map(|e| e.event_id).collect();
        v.sort_unstable();
        v
    };
    let sched = || super::PlaytestReaperSchedule {
        id: 1,
        scheduled_at: ScheduleAt::Time(Timestamp::from_micros_since_unix_epoch(0)),
    };
    let at = Timestamp::from_micros_since_unix_epoch(now * 1000);
    let reap = |who: Identity| fx.run_as_at(who, at, |ctx| super::playtest_reaper(ctx, sched()));

    let old_module = Identity::from_byte_array(DEFAULT_DATABASE_IDENTITY);
    let module = Identity::from_byte_array([0x7E; 32]);
    fx.set_database_identity(module);
    for (label, caller) in [
        ("a player", player),
        ("the all-zero identity", Identity::from_byte_array([0; 32])),
        ("a stale module identity", old_module),
    ] {
        assert_eq!(
            reap(caller),
            Err("playtest_reaper is scheduler-only".to_string()),
            "{label} must be refused"
        );
        assert_eq!(ids(), vec![1, 2, 3], "{label}: refused before any delete");
    }
    assert_eq!(reap(module), Ok(()), "the module identity is admitted");
    assert_eq!(ids(), vec![3], "the module reaps exactly the expired rows");
}

/// The shipped reaper's retention window is SEVEN DAYS, stated here as a
/// literal millisecond count rather than through the constant: a row exactly
/// 604 800 000 ms old is reaped, one a millisecond younger is kept.
///
/// kills: any arithmetic slip in the TTL constant's `7 * 24 * 60 * 60 * 1000`
/// (the relative-TTL tests above stay green for every value).
#[test]
fn nh_playtest_reaper_retains_exactly_seven_days() {
    use crate::native_host_tests::fixture;
    use spacetimedb::{ScheduleAt, Timestamp};

    const SEVEN_DAYS_MS: i64 = 604_800_000;
    let fx = fixture();
    let events = fx
        .table_keyed::<super::PlaytestEvent, u64>("playtest_event", "event_id", |r| r.event_id)
        .writable()
        .scannable()
        .unique();
    let _schedule = schedule_table(&fx);
    let player = Identity::from_byte_array([0x12; 32]);
    let now = 10 * SEVEN_DAYS_MS;
    for (event_id, created_at_ms) in [(1, now - SEVEN_DAYS_MS), (2, now - SEVEN_DAYS_MS + 1)] {
        events.seed(&super::PlaytestEvent {
            event_id,
            identity: player,
            kind: 1,
            created_at_ms,
            battle_id: 0,
            species_id: 1,
            hp_permille: 500,
            bait_item_id: 0,
            success: false,
        });
    }
    let module = Identity::from_byte_array([0x7E; 32]);
    fx.set_database_identity(module);
    let sched = super::PlaytestReaperSchedule {
        id: 1,
        scheduled_at: ScheduleAt::Time(Timestamp::from_micros_since_unix_epoch(0)),
    };
    let at = Timestamp::from_micros_since_unix_epoch(now * 1000);
    assert_eq!(
        fx.run_as_at(module, at, |ctx| super::playtest_reaper(ctx, sched)),
        Ok(())
    );
    let left: Vec<u64> = events.rows().iter().map(|e| e.event_id).collect();
    assert_eq!(left, vec![2], "exactly the seven-day-old row is reaped");
}

// ===========================================================================
// On-demand schedule: the reaper runs only when something is owed. One one-shot
// row at the oldest event's expiry (or `PLAYTEST_REAP_RETRY_MS` out when work is
// owed now), no row for an empty table.
// ===========================================================================

type ScheduleHandle<'a> = crate::native_host_tests::Handle<'a, super::PlaytestReaperSchedule, u64>;
type EventHandle<'a> = crate::native_host_tests::Handle<'a, super::PlaytestEvent, u64>;

fn schedule_table(fx: &crate::native_host_tests::Fixture) -> ScheduleHandle<'_> {
    fx.table_keyed::<super::PlaytestReaperSchedule, u64>("playtest_reaper_schedule", "id", |r| r.id)
        .writable()
        .scannable()
        .unique()
        .auto_inc(|r| r.id, |r, v| r.id = v)
}

fn event_table(fx: &crate::native_host_tests::Fixture) -> EventHandle<'_> {
    fx.table_keyed::<super::PlaytestEvent, u64>("playtest_event", "event_id", |r| r.event_id)
        .writable()
        .scannable()
        .unique()
        .auto_inc(|r| r.event_id, |r, v| r.event_id = v)
}

fn event_row(event_id: u64, identity: Identity, created_at_ms: i64) -> super::PlaytestEvent {
    super::PlaytestEvent {
        event_id,
        identity,
        kind: 1,
        created_at_ms,
        battle_id: 0,
        species_id: 1,
        hp_permille: 500,
        bait_item_id: 0,
        success: false,
    }
}

fn ts(ms: i64) -> spacetimedb::Timestamp {
    spacetimedb::Timestamp::from_micros_since_unix_epoch(ms * 1000)
}

fn one_shot(id: u64, at_ms: i64) -> super::PlaytestReaperSchedule {
    super::PlaytestReaperSchedule {
        id,
        scheduled_at: spacetimedb::ScheduleAt::Time(ts(at_ms)),
    }
}

fn interval(id: u64) -> super::PlaytestReaperSchedule {
    super::PlaytestReaperSchedule {
        id,
        scheduled_at: spacetimedb::ScheduleAt::Interval(std::time::Duration::from_secs(300).into()),
    }
}

/// Every schedule row as (id, one-shot fire ms; `None` = an interval row), by id.
fn wakes(schedule: &ScheduleHandle<'_>) -> Vec<(u64, Option<i64>)> {
    let mut v: Vec<(u64, Option<i64>)> = schedule
        .rows()
        .iter()
        .map(|s| (s.id, super::one_shot_ms(&s.scheduled_at)))
        .collect();
    v.sort_unstable();
    v
}

const MODULE: [u8; 32] = [0x7E; 32];
const TTL: i64 = 604_800_000;
const RETRY: i64 = 300_000;
const NOW: i64 = 10 * TTL;

/// The retry delay is five minutes, as a literal: it is the bound on how long
/// the table may sit over its cap and on how long a batch-limited backlog waits.
#[test]
fn playtest_reap_retry_is_five_minutes() {
    assert_eq!(super::PLAYTEST_REAP_RETRY_MS, 300_000);
    assert_eq!(super::PLAYTEST_EVENT_TTL_MS, TTL);
}

/// `next_wake_ms`: nothing left means no run; a fresh oldest row runs at its
/// expiry; a row at or past its expiry, or a table over its cap, runs one retry
/// delay from now and never at once.
///
/// kills: `>=` to `>` / `<` at the expiry boundary, `||` to `&&`, either arm's
/// arithmetic, a constant return.
#[test]
fn next_wake_is_the_oldest_expiry_or_a_retry_when_work_is_owed_now() {
    let f = |oldest, over_cap, now| super::next_wake_ms(oldest, over_cap, now, 1_000, 30);
    assert_eq!(f(None, false, 5_000), None, "an empty table owes nothing");
    assert_eq!(
        f(None, true, 5_000),
        None,
        "no row, no run, whatever the cap says"
    );
    assert_eq!(
        f(Some(4_500), false, 5_000),
        Some(5_500),
        "at the oldest row's expiry"
    );
    assert_eq!(
        f(Some(4_001), false, 5_000),
        Some(5_001),
        "one ms before expiry"
    );
    assert_eq!(
        f(Some(4_000), false, 5_000),
        Some(5_030),
        "exactly expired: retry"
    );
    assert_eq!(
        f(Some(100), false, 5_000),
        Some(5_030),
        "long expired: retry"
    );
    assert_eq!(
        f(Some(4_500), true, 5_000),
        Some(5_030),
        "over the cap: retry"
    );
    assert_eq!(f(Some(100), true, 5_000), Some(5_030));
    assert_eq!(
        super::next_wake_ms(Some(i64::MAX - 1), false, 0, 1_000, 30),
        Some(i64::MAX),
        "saturates instead of overflowing"
    );
}

/// `one_shot_ms` / `ms_to_schedule` / `firing_one_shot`: a one-shot row's fire
/// time in whole ms and its id; an interval row has neither.
///
/// kills: the micros-to-ms division, the ms-to-micros factor, a constant return.
#[test]
fn schedule_row_time_conversions_round_trip() {
    use spacetimedb::{ScheduleAt, Timestamp};
    let t = ScheduleAt::Time(Timestamp::from_micros_since_unix_epoch(5_000_999));
    let i = ScheduleAt::Interval(std::time::Duration::from_secs(300).into());
    assert_eq!(super::one_shot_ms(&t), Some(5_000));
    assert_eq!(super::one_shot_ms(&i), None);
    assert_eq!(
        super::ms_to_schedule(7_654),
        ScheduleAt::Time(Timestamp::from_micros_since_unix_epoch(7_654_000))
    );
    assert_eq!(
        super::one_shot_ms(&super::ms_to_schedule(NOW + TTL)),
        Some(NOW + TTL)
    );
    assert_eq!(super::firing_one_shot(42, &t), Some(42));
    assert_eq!(super::firing_one_shot(42, &i), None);
}

/// `plan_wake`: nothing owed removes every row; something owed leaves exactly
/// one one-shot no later than wanted — the earliest early-enough one is kept
/// and nothing is inserted, otherwise every row goes and one is inserted.
/// Interval rows always go.
///
/// kills: `<=` to `<` / `>` / `==`, keeping the latest or the first-listed row,
/// keeping an interval row, inserting beside a kept row, deleting the kept row.
#[test]
fn plan_wake_keeps_at_most_one_early_enough_one_shot() {
    let p = |existing: &[(u64, Option<i64>)], wanted| {
        let plan = super::plan_wake(existing, wanted);
        (plan.delete_ids, plan.insert_at_ms)
    };
    assert_eq!(p(&[], None), (vec![], None));
    assert_eq!(p(&[], Some(10)), (vec![], Some(10)));
    assert_eq!(p(&[(1, None)], Some(10)), (vec![1], Some(10)));
    assert_eq!(p(&[(1, None), (2, Some(5))], None), (vec![1, 2], None));
    assert_eq!(p(&[(1, Some(5))], Some(10)), (vec![], None));
    assert_eq!(p(&[(1, Some(10))], Some(10)), (vec![], None));
    assert_eq!(p(&[(1, Some(11))], Some(10)), (vec![1], Some(10)));
    assert_eq!(
        p(
            &[(1, Some(8)), (2, Some(3)), (3, Some(20)), (4, None)],
            Some(10)
        ),
        (vec![1, 3, 4], None),
        "the earliest early-enough row is the one kept"
    );
    assert_eq!(
        p(&[(7, Some(5)), (3, Some(5))], Some(10)),
        (vec![7], None),
        "equal times: the lower id is kept"
    );
    assert_eq!(
        p(&[(1, Some(30)), (2, Some(20)), (3, None)], Some(10)),
        (vec![1, 2, 3], Some(10)),
        "no row is early enough: all go, one is inserted"
    );
}

/// `playtest_wake_ms`: the oldest CREATION time decides (not the lowest id), and
/// one row over the cap is work owed now.
///
/// kills: `>` to `>=` / `==` / `<` on the cap test, min replaced by first or max,
/// the wrong TTL or retry constant.
#[test]
fn playtest_wake_reads_the_oldest_creation_time_and_the_cap() {
    assert_eq!(super::playtest_wake_ms(&[], NOW), None);
    assert_eq!(
        super::playtest_wake_ms(&[(1, NOW - 5), (2, NOW - 900), (3, NOW - 1)], NOW),
        Some(NOW - 900 + TTL)
    );
    assert_eq!(
        super::playtest_wake_ms(&[(1, NOW - TTL), (2, NOW)], NOW),
        Some(NOW + RETRY),
        "an expired row left behind is retried"
    );
    // A reap that hit its batch limit: what `plan_reap` leaves of a table of
    // expired rows is retried, not left to a TTL that has already passed.
    let batch = super::PLAYTEST_REAP_MAX_DELETE_PER_TICK;
    let mut backlog: Vec<(u64, i64)> = (1..=batch as u64 + 2).map(|i| (i, NOW - TTL)).collect();
    let gone = super::plan_reap(&backlog, NOW, TTL, super::PLAYTEST_EVENT_CAP, batch);
    backlog.retain(|(id, _)| gone.binary_search(id).is_err());
    assert_eq!(backlog.len(), 2);
    assert_eq!(super::playtest_wake_ms(&backlog, NOW), Some(NOW + RETRY));
    let cap = super::PLAYTEST_EVENT_CAP;
    let at_cap: Vec<(u64, i64)> = (1..=cap).map(|i| (i, NOW - 10)).collect();
    assert_eq!(super::playtest_wake_ms(&at_cap, NOW), Some(NOW - 10 + TTL));
    let over: Vec<(u64, i64)> = (1..=cap + 1).map(|i| (i, NOW - 10)).collect();
    assert_eq!(super::playtest_wake_ms(&over, NOW), Some(NOW + RETRY));
}

/// The first recorded event arms exactly one one-shot at that event's expiry;
/// later events leave it alone and write no schedule row.
///
/// kills: the arm dropped from `record_recruit_event`, armed at the wrong time,
/// a row per event, an interval row.
#[test]
fn nh_first_event_arms_one_run_at_its_expiry_and_later_events_write_nothing() {
    use crate::native_host_tests::fixture;
    let fx = fixture();
    let events = event_table(&fx);
    let schedule = schedule_table(&fx);
    let player = Identity::from_byte_array([0x21; 32]);
    assert_eq!(
        wakes(&schedule),
        vec![],
        "an empty table has no schedule row"
    );
    let record = |ms: i64| {
        fx.run_as_at(player, ts(ms), |ctx| {
            super::record_recruit_event(ctx, player, 9, 3, 400, None, false)
        })
    };
    record(NOW);
    assert_eq!(events.rows().len(), 1);
    let armed = wakes(&schedule);
    assert_eq!(armed.len(), 1, "exactly one schedule row");
    assert_eq!(armed[0].1, Some(NOW + TTL), "at the event's expiry");
    fx.reset_writes();
    record(NOW + 60_000);
    record(NOW + 120_000);
    assert_eq!(events.rows().len(), 3);
    assert_eq!(wakes(&schedule), armed, "the same row, untouched");
    assert_eq!(fx.writes_to("playtest_reaper_schedule"), 0);
}

/// Cap under burst. The event that fills the table to exactly the cap leaves the
/// run at the oldest expiry; the next one, which takes it over, pulls the run in
/// to one retry delay from now; further events in the burst keep that one row.
/// The run then trims the table back to the cap and re-arms at the new oldest
/// expiry.
///
/// kills: `>` to `>=` / `==` / `<` on the insert-side cap test, a run armed at
/// once (a scan per insert) or left at the TTL (the cap unenforced for days), a
/// second schedule row, a reaper that does not re-arm.
#[test]
fn nh_burst_over_the_cap_pulls_the_run_in_and_the_run_trims_to_the_cap() {
    use crate::native_host_tests::fixture;
    let fx = fixture();
    let events = event_table(&fx);
    let schedule = schedule_table(&fx);
    let player = Identity::from_byte_array([0x22; 32]);
    let cap = super::PLAYTEST_EVENT_CAP;
    let oldest = NOW - 1_000;
    // Seeded ids start above the ones the fixture's sequence hands the recorded
    // events (1, 2, ...), so no id is used twice.
    for i in 1..cap {
        events.seed(&event_row(100 + i, player, oldest + i as i64 / 100));
    }
    schedule.seed(&one_shot(900, oldest + TTL));
    let record = |ms: i64| {
        fx.run_as_at(player, ts(ms), |ctx| {
            super::record_recruit_event(ctx, player, 9, 3, 400, None, false)
        })
    };
    record(NOW);
    assert_eq!(events.rows().len() as u64, cap);
    assert_eq!(
        wakes(&schedule),
        vec![(900, Some(oldest + TTL))],
        "at the cap: unchanged"
    );
    record(NOW + 1);
    assert_eq!(events.rows().len() as u64, cap + 1);
    let pulled = wakes(&schedule);
    assert_eq!(pulled.len(), 1, "still one row");
    assert_eq!(
        pulled[0].1,
        Some(NOW + 1 + RETRY),
        "one retry delay from the crossing"
    );
    record(NOW + 2);
    record(NOW + 3);
    assert_eq!(
        wakes(&schedule),
        pulled,
        "the rest of the burst keeps that row"
    );
    assert_eq!(events.rows().len() as u64, cap + 3);

    let module = Identity::from_byte_array(MODULE);
    fx.set_database_identity(module);
    let firing = schedule.rows().remove(0);
    let firing_id = firing.id;
    let run_at = NOW + 1 + RETRY;
    assert_eq!(
        fx.run_as_at(module, ts(run_at), |ctx| super::playtest_reaper(
            ctx, firing
        )),
        Ok(())
    );
    let left = events.rows();
    assert_eq!(left.len() as u64, cap, "trimmed back to the cap");
    let mut ids: Vec<u64> = left.iter().map(|e| e.event_id).collect();
    ids.sort_unstable();
    assert_eq!(ids[0], 4, "the three lowest ids went");
    let new_oldest = left.iter().map(|e| e.created_at_ms).min().unwrap();
    let next: Vec<(u64, Option<i64>)> = wakes(&schedule)
        .into_iter()
        .filter(|&(id, _)| id != firing_id)
        .collect();
    assert_eq!(next.len(), 1, "one new row besides the one that fired");
    assert_eq!(next[0].1, Some(new_oldest + TTL));
}

/// A run arms its own next run from what it left, never counting the row it
/// was fired with (the runtime deletes a one-shot once its reducer returns):
/// rows left means one NEW one-shot at the oldest remaining expiry; an emptied
/// table means none.
///
/// kills: the re-arm dropped, the firing row counted as the next run, a re-arm
/// computed from the rows as they were before the reap, a row left for an empty
/// table.
#[test]
fn nh_reaper_rearms_iff_rows_remain_and_ignores_the_row_that_fired() {
    use crate::native_host_tests::fixture;
    let fx = fixture();
    let events = event_table(&fx);
    let schedule = schedule_table(&fx);
    let player = Identity::from_byte_array([0x23; 32]);
    let module = Identity::from_byte_array(MODULE);
    fx.set_database_identity(module);
    events.seed(&event_row(1, player, NOW - TTL));
    events.seed(&event_row(2, player, NOW - 500));
    events.seed(&event_row(3, player, NOW - 700));
    schedule.seed(&one_shot(5, NOW));
    let run = |id: u64, ms: i64| {
        fx.run_as_at(module, ts(ms), |ctx| {
            super::playtest_reaper(ctx, one_shot(id, ms))
        })
    };
    assert_eq!(run(5, NOW), Ok(()));
    let mut ids: Vec<u64> = events.rows().iter().map(|e| e.event_id).collect();
    ids.sort_unstable();
    assert_eq!(ids, vec![2, 3], "the expired row is gone");
    let after = wakes(&schedule);
    assert_eq!(after.len(), 2, "the fired row and one new row: {after:?}");
    assert!(
        after.contains(&(5, Some(NOW))),
        "the fired row is left to the runtime"
    );
    let next: Vec<&(u64, Option<i64>)> = after.iter().filter(|w| w.0 != 5).collect();
    assert_eq!(
        next[0].1,
        Some(NOW - 700 + TTL),
        "at the oldest remaining expiry"
    );
    let next_id = next[0].0;

    // The runtime removes the fired row; the next run is the row armed above.
    assert_eq!(schedule.remove(5), 1);
    let last = NOW - 500 + TTL;
    assert_eq!(run(next_id, last), Ok(()));
    assert_eq!(events.rows().len(), 0, "both remaining rows had expired");
    assert_eq!(
        wakes(&schedule),
        vec![(next_id, Some(NOW - 700 + TTL))],
        "an empty table is left no row but the one that fired"
    );
}

/// A world upgraded from the interval schedule converges on the interval row's
/// own next firing, with no publish step: the run removes the interval row it
/// was fired with (the runtime keeps interval rows) and leaves a one-shot only
/// when rows remain.
///
/// kills: an interval row treated like a one-shot and left in place, so the
/// reaper keeps running every five minutes for ever.
#[test]
fn nh_reaper_fired_by_a_legacy_interval_row_removes_it() {
    use crate::native_host_tests::fixture;
    let fx = fixture();
    let events = event_table(&fx);
    let schedule = schedule_table(&fx);
    let player = Identity::from_byte_array([0x25; 32]);
    let module = Identity::from_byte_array(MODULE);
    fx.set_database_identity(module);
    schedule.seed(&interval(1));
    assert_eq!(
        fx.run_as_at(module, ts(NOW), |ctx| super::playtest_reaper(
            ctx,
            interval(1)
        )),
        Ok(())
    );
    assert_eq!(
        wakes(&schedule),
        vec![],
        "empty table: the interval row goes, nothing replaces it"
    );

    schedule.seed(&interval(1));
    events.seed(&event_row(1, player, NOW - 40));
    assert_eq!(
        fx.run_as_at(module, ts(NOW), |ctx| super::playtest_reaper(
            ctx,
            interval(1)
        )),
        Ok(())
    );
    let after = wakes(&schedule);
    assert_eq!(after.len(), 1, "exactly one row: {after:?}");
    assert_eq!(
        after[0].1,
        Some(NOW - 40 + TTL),
        "a one-shot at the pending row's expiry"
    );
}

/// `ensure_playtest_reaper` (init / sync_content) brings the schedule in line
/// with the table whatever it finds: legacy interval rows and duplicates go; an
/// empty table ends with no row; pending rows end with exactly one one-shot at
/// the oldest expiry (one retry delay out when a row has already expired); a
/// repeat call writes nothing.
///
/// kills: the arm replaced by a no-op, an interval row re-created or kept, a
/// row armed for an empty table, a second row on a repeat call.
#[test]
fn nh_ensure_playtest_reaper_converges_any_schedule_on_the_table() {
    use crate::native_host_tests::fixture;
    let fx = fixture();
    let events = event_table(&fx);
    let schedule = schedule_table(&fx);
    let player = Identity::from_byte_array([0x26; 32]);
    let ensure = |ms: i64| fx.run_as_at(player, ts(ms), super::ensure_playtest_reaper);

    ensure(NOW);
    assert_eq!(wakes(&schedule), vec![], "a new world arms nothing");
    assert_eq!(fx.writes_to("playtest_reaper_schedule"), 0);

    schedule.seed(&interval(1));
    schedule.seed(&interval(99));
    ensure(NOW);
    assert_eq!(
        wakes(&schedule),
        vec![],
        "legacy interval rows go; empty table, no row"
    );

    schedule.seed(&interval(1));
    events.seed(&event_row(1, player, NOW - 300));
    events.seed(&event_row(2, player, NOW - 800));
    ensure(NOW);
    let armed = wakes(&schedule);
    assert_eq!(armed.len(), 1, "pending rows: exactly one row: {armed:?}");
    assert_eq!(
        armed[0].1,
        Some(NOW - 800 + TTL),
        "a one-shot at the oldest expiry"
    );
    fx.reset_writes();
    ensure(NOW + 5);
    assert_eq!(wakes(&schedule), armed, "a repeat call keeps the row");
    assert_eq!(fx.writes_to("playtest_reaper_schedule"), 0);

    schedule.seed(&one_shot(500, NOW + 2 * TTL));
    ensure(NOW + 6);
    assert_eq!(
        wakes(&schedule),
        armed,
        "a later duplicate goes, the early row stays"
    );

    events.seed(&event_row(3, player, NOW - TTL));
    for id in schedule.rows().iter().map(|s| s.id) {
        schedule.remove(id);
    }
    ensure(NOW);
    assert_eq!(wakes(&schedule).len(), 1);
    assert_eq!(
        wakes(&schedule)[0].1,
        Some(NOW + RETRY),
        "already expired: one retry delay out"
    );
}

/// Erasing an identity's events removes the schedule row when that empties the
/// table and leaves it when another identity's rows remain.
///
/// kills: the disarm dropped or inverted, an erase that deletes other
/// identities' rows.
#[test]
fn nh_erase_that_empties_the_table_removes_the_schedule_row() {
    use crate::native_host_tests::fixture;
    let fx = fixture();
    let events = event_table(&fx);
    let schedule = schedule_table(&fx);
    let a = Identity::from_byte_array([0x27; 32]);
    let b = Identity::from_byte_array([0x28; 32]);
    events.seed(&event_row(1, a, NOW));
    events.seed(&event_row(2, b, NOW + 1));
    events.seed(&event_row(3, a, NOW + 2));
    schedule.seed(&one_shot(1, NOW + TTL));
    fx.run_as(a, |ctx| super::erase_playtest_events(ctx, a));
    let left: Vec<u64> = events.rows().iter().map(|e| e.event_id).collect();
    assert_eq!(left, vec![2], "only the erased identity's rows go");
    assert_eq!(
        wakes(&schedule),
        vec![(1, Some(NOW + TTL))],
        "rows remain: the row stays"
    );
    fx.run_as(b, |ctx| super::erase_playtest_events(ctx, b));
    assert_eq!(events.rows().len(), 0);
    assert_eq!(
        wakes(&schedule),
        vec![],
        "the table is empty: no schedule row"
    );
}

/// Tripwire for the `PlaytestKind::code -> 1` entry in `.cargo/mutants.toml`: that mutant is
/// equivalent ONLY while the enum has a single variant. This exhaustive match (no wildcard) stops
/// compiling when a second variant is added, so whoever adds it must read the entry, delete the
/// exclusion and give the new variant a code the tests pin.
#[test]
fn playtest_kind_has_exactly_one_variant() {
    use crate::playtest::PlaytestKind;
    match PlaytestKind::RecruitAttempt {
        PlaytestKind::RecruitAttempt => {}
    }
    assert_eq!(PlaytestKind::RecruitAttempt.code(), 1);
}
