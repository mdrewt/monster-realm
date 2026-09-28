//! `playtest` domain-submodule tests — pt-b2.
//!
//! Declared from `server-module/src/playtest.rs` as:
//!   `#[cfg(test)] #[path = "playtest_tests.rs"] mod playtest_tests;`
//! so `super::` resolves to `playtest.rs`.
//!
//! Pure seams (`hp_permille`, `PlaytestKind`, `plan_reap`, `plan_reaper_arm`,
//! `build_playtest_event`) plus a native-host test of the shipped
//! `playtest_reaper`'s scheduler-only guard.

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

/// `ensure_playtest_reaper` arms exactly one interval row at the reap cadence,
/// stays at one on a repeat call, and collapses duplicates back to one.
///
/// kills: the arm replaced by a no-op.
#[test]
fn nh_ensure_playtest_reaper_arms_one_interval_singleton() {
    use crate::native_host_tests::fixture;
    use spacetimedb::ScheduleAt;

    let fx = fixture();
    let rows = fx
        .table_keyed::<super::PlaytestReaperSchedule, u64>("playtest_reaper_schedule", "id", |r| {
            r.id
        })
        .writable()
        .scannable()
        .unique()
        .auto_inc(|r| r.id, |r, v| r.id = v);
    let ctx = fx.ctx();
    super::ensure_playtest_reaper(&ctx);
    let armed = rows.rows();
    assert_eq!(armed.len(), 1, "one reaper row armed");
    assert_eq!(
        armed[0].scheduled_at,
        ScheduleAt::Interval(std::time::Duration::from_secs(300).into()),
        "every five minutes"
    );
    super::ensure_playtest_reaper(&ctx);
    assert_eq!(rows.rows().len(), 1, "a repeat call keeps one row");
    rows.seed(&super::PlaytestReaperSchedule {
        id: 99,
        scheduled_at: ScheduleAt::Interval(std::time::Duration::from_secs(300).into()),
    });
    super::ensure_playtest_reaper(&ctx);
    assert_eq!(rows.rows().len(), 1, "duplicates collapse to one");
}
