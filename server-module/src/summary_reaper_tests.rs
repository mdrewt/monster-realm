//! `summary_reaper` tests: `battle_summary` is capped by an on-demand reaper.
//!
//! Declared from `server-module/src/summary_reaper.rs` as
//! `#[cfg(test)] #[path = "summary_reaper_tests.rs"] mod summary_reaper_tests;`,
//! so `super::` is `crate::summary_reaper`.
//!
//! Three layers. The pure planners (`plan_summary_reap`, `summary_wake_ms`,
//! `summary_rearm_ms`) at a small cap. The reap shell `reap_battle_summaries` on the
//! native host at a small cap (ten rows, at most three deletes a run), where the walk,
//! the held-row rule and the re-arm show row by row. The shipped reducer and the
//! shipped insert path (`tactics_settle`) at the REAL cap with overages of a few rows:
//! the host's point find, insert and delete each decode every stored row, so a test
//! keeps to a handful of them over a 100 000-row table.
//!
//! The cap (100 000 rows) and the retry delay (300 000 ms) appear here as the spec's
//! literals, never through the module's constants, so a changed constant fails a test.

use crate::native_host_tests::{fixture, Fixture, Handle, DEFAULT_DATABASE_IDENTITY};
use crate::schema::{Battle, BattleSummary, BattleTactical, SideRow};
use game_core::tactics::tuning::BattleKind;
use spacetimedb::{Identity, ScheduleAt, Timestamp};
use std::collections::BTreeSet;

/// The spec's cap on `battle_summary` rows.
const SPEC_CAP: u64 = 100_000;
/// The spec's delay before a reaper run: five minutes.
const SPEC_RETRY_MS: i64 = 300_000;
const NOW: i64 = 1_700_000_000_000;
const MODULE: [u8; 32] = [0x7E; 32];
/// The shell tests' cap and per-run delete limit.
const SMALL_CAP: u64 = 10;
const SMALL_MAX: usize = 3;
/// Fourteen non-contiguous battle ids, ascending.
const IDS: [u64; 14] = [7, 10, 11, 40, 41, 55, 56, 60, 72, 80, 81, 90, 99, 120];
/// The id of the schedule row a run is fired with.
const FIRING: u64 = 50;
/// Battle ids above every id `seed_many` hands out.
const NEW: [u64; 3] = [900_001, 900_002, 900_003];

type Schedule<'a> = Handle<'a, super::BattleSummaryReaperSchedule, u64>;

struct World<'a> {
    summaries: Handle<'a, BattleSummary, u64>,
    battles: Handle<'a, Battle, u64>,
    tacticals: Handle<'a, BattleTactical, u64>,
    schedule: Schedule<'a>,
}

/// `battle_summary` and the reaper's schedule as the module declares them (a primary
/// key; writable and countable), `battle` and `battle_tactical` read-only through the
/// `battle_id` keys the held-row lookups use.
fn world(fx: &Fixture) -> World<'_> {
    World {
        summaries: fx
            .table_keyed::<BattleSummary, u64>("battle_summary", "battle_id", |r| r.battle_id)
            .writable()
            .scannable()
            .unique(),
        battles: fx.table_keyed::<Battle, u64>("battle", "battle_id", |r| r.battle_id),
        tacticals: fx
            .table_keyed::<BattleTactical, u64>("battle_tactical", "battle_id", |r| r.battle_id),
        schedule: fx
            .table_keyed::<super::BattleSummaryReaperSchedule, u64>(
                "battle_summary_reaper_schedule",
                "id",
                |r| r.id,
            )
            .writable()
            .scannable()
            .unique()
            .auto_inc(|r| r.id, |r, v| r.id = v),
    }
}

fn player() -> Identity {
    Identity::from_byte_array([0x51; 32])
}

fn ts(ms: i64) -> Timestamp {
    Timestamp::from_micros_since_unix_epoch(ms * 1000)
}

/// A finished wild battle's summary row.
fn summary(battle_id: u64) -> BattleSummary {
    BattleSummary {
        battle_id,
        player_identity: player(),
        opponent_identity: crate::WILD_IDENTITY,
        kind: BattleKind::Wild,
        outcome: game_core::BattleOutcome::SideAWins,
        rounds: 4,
        wall_ms: 60_000,
        idle_ms_a: 0,
        idle_ms_b: 0,
        windows_histogram: vec![],
        autopasses: 0,
        recruit_attempts: 0,
        recruit_successes: 0,
        weaken_first: false,
        items_used: 0,
        damage_dealt_a: 0,
        damage_dealt_b: 0,
        hits: 0,
        misses: 0,
        unit_turns_prequeued: 0,
        unit_turns_live: 0,
        halted_plans: 0,
        se_kos_after_r1: 0,
        kos_after_r1: 0,
        end_how: None,
    }
}

/// A live battle's anchor row: it holds `battle_id` in `battle`.
fn battle(battle_id: u64) -> Battle {
    let side = || game_core::BattleSide {
        active: 0,
        team: vec![],
    };
    Battle {
        battle_id,
        player_identity: player(),
        opponent_identity: crate::WILD_IDENTITY,
        state: game_core::BattleState {
            side_a: side(),
            side_b: side(),
            outcome: game_core::BattleOutcome::Ongoing,
            turn_number: 1,
            weather: None,
        },
        party_monster_ids: vec![],
        opponent_monster_ids: vec![],
        created_at_ms: NOW,
    }
}

/// A live battle's tactical row: it holds `battle_id` in `battle_tactical`.
fn tactical(battle_id: u64) -> BattleTactical {
    BattleTactical {
        battle_id,
        kind: BattleKind::Wild,
        format: 1,
        map_id: 3,
        content_version: crate::CONTENT_VERSION,
        phase: game_core::tactics::types::Phase::Active,
        round: 2,
        initiative: vec![1, 3],
        turn_idx: 0,
        turn_state: game_core::tactics::types::TurnState::Waiting(1),
        tie_priority_side: SideRow::A,
        pending_pad_ms: 0,
        attack_damage_dealt_a: 0,
        attack_damage_dealt_b: 0,
    }
}

/// A live battle: its `battle` and `battle_tactical` rows.
fn open_battle(w: &World<'_>, battle_id: u64) {
    w.battles.seed(&battle(battle_id));
    w.tacticals.seed(&tactical(battle_id));
}

fn one_shot(id: u64, at_ms: i64) -> super::BattleSummaryReaperSchedule {
    super::BattleSummaryReaperSchedule {
        id,
        scheduled_at: ScheduleAt::Time(ts(at_ms)),
    }
}

fn interval(id: u64) -> super::BattleSummaryReaperSchedule {
    super::BattleSummaryReaperSchedule {
        id,
        scheduled_at: ScheduleAt::Interval(std::time::Duration::from_secs(300).into()),
    }
}

/// Every schedule row as (id, one-shot fire ms; `None` = an interval row), by id.
fn wakes(schedule: &Schedule<'_>) -> Vec<(u64, Option<i64>)> {
    let mut v: Vec<(u64, Option<i64>)> = schedule
        .rows()
        .iter()
        .map(|s| (s.id, crate::playtest::one_shot_ms(&s.scheduled_at)))
        .collect();
    v.sort_unstable();
    v
}

/// Every summary row's `battle_id`, ascending.
fn ids(w: &World<'_>) -> Vec<u64> {
    let mut v: Vec<u64> = w.summaries.rows().iter().map(|s| s.battle_id).collect();
    v.sort_unstable();
    v
}

/// `n` summary rows with non-contiguous ids `1 000 + 7·i`, seeded HIGHEST id first
/// (store order is the reverse of key order). Returns the ids ascending.
fn seed_many(w: &World<'_>, n: u64) -> Vec<u64> {
    let seeded: Vec<u64> = (0..n).map(|i| 1_000 + 7 * i).collect();
    for &id in seeded.iter().rev() {
        w.summaries.seed(&summary(id));
    }
    seeded
}

/// The seeded ids absent from the table, ascending (`seeded` is ascending).
fn gone(w: &World<'_>, seeded: &[u64]) -> Vec<u64> {
    let left: BTreeSet<u64> = w.summaries.rows().iter().map(|s| s.battle_id).collect();
    let missing: Vec<u64> = seeded
        .iter()
        .copied()
        .filter(|id| !left.contains(id))
        .collect();
    assert!(
        missing.len() <= 16,
        "{} of {} seeded rows are gone; the first sixteen: {:?}",
        missing.len(),
        seeded.len(),
        &missing[..16]
    );
    missing
}

/// `plan_summary_reap` over `ids` with `held` as the held set: the ids it deletes, and
/// every id it asked `held` about, in call order.
fn plan_with(ids: &[u64], cap: u64, max_delete: usize, held: &[u64]) -> (Vec<u64>, Vec<u64>) {
    let mut asked = Vec::new();
    let deleted = super::plan_summary_reap(ids, cap, max_delete, |id| {
        asked.push(id);
        held.contains(&id)
    });
    (deleted, asked)
}

/// `reap_battle_summaries` at the small cap and limit, fired with `firing`.
fn reap(fx: &Fixture, firing: Option<u64>) {
    let module = Identity::from_byte_array(MODULE);
    fx.run_as_at(module, ts(NOW), |ctx| {
        super::reap_battle_summaries(ctx, SMALL_CAP, SMALL_MAX, firing);
    });
}

/// The shipped `tactics_settle::find_or_insert_summary` for `battle_id` at `at_ms`:
/// the id of the summary row it returns.
fn find_or_insert(fx: &Fixture, battle_id: u64, at_ms: i64) -> Option<u64> {
    fx.run_as_at(player(), ts(at_ms), |ctx| {
        crate::tactics_settle::find_or_insert_summary(ctx, battle_id).map(|s| s.battle_id)
    })
}

// ===========================================================================
// An insert over the cap with no run scheduled schedules exactly one; at or below
// the cap, none.
// ===========================================================================

/// `summary_wake_ms`: a table over its cap is owed one run, one retry delay from now;
/// at or below the cap, none.
///
/// kills: `>=` or `==` for `>`; a run owed whatever the count; `now - retry`, or the
/// retry alone, for `now + retry`.
#[test]
fn sr7_1_wake_is_one_retry_out_exactly_when_over_the_cap() {
    let f = |count: u64| super::summary_wake_ms(count, SMALL_CAP, 5_000, 30);
    assert_eq!(f(0), None, "an empty table");
    assert_eq!(f(9), None, "below the cap");
    assert_eq!(f(10), None, "exactly at the cap");
    assert_eq!(f(11), Some(5_030), "one over the cap");
    assert_eq!(f(500), Some(5_030), "far over the cap");
}

/// Through the shipped insert path at the real cap. The insert that fills
/// `battle_summary` to exactly 100 000 rows leaves the schedule alone and does not
/// even read it: a run armed earlier, one the arm would replace if it ran, stays as
/// it was. With that row gone, the next insert takes the table to 100 001 with
/// nothing scheduled and arms exactly one one-shot run, five minutes after the insert.
///
/// kills: the arm missing from the insert path; `>=` for `>` on the cap; the schedule
/// read or rewritten by every insert at or below the cap; a run armed at once, at the
/// wrong delay, as an interval row, or twice.
#[test]
fn sr7_1_the_insert_that_takes_the_table_over_the_cap_arms_exactly_one_run() {
    let fx = fixture();
    let w = world(&fx);
    seed_many(&w, SPEC_CAP - 1);
    let [x1, x2, _] = NEW;
    open_battle(&w, x1);
    open_battle(&w, x2);
    let earlier_run = NOW + 10 * SPEC_RETRY_MS;
    w.schedule.seed(&one_shot(77, earlier_run));

    assert_eq!(find_or_insert(&fx, x1, NOW), Some(x1));
    assert_eq!(
        fx.writes_to("battle_summary"),
        1,
        "the zeroed summary row was inserted, filling the table to exactly the cap"
    );
    assert_eq!(
        wakes(&w.schedule),
        vec![(77, Some(earlier_run))],
        "at the cap the schedule is left as it was"
    );
    assert_eq!(fx.writes_to("battle_summary_reaper_schedule"), 0);
    assert_eq!(
        fx.rows_read("battle_summary_reaper_schedule"),
        0,
        "at the cap the arm returns before reading its schedule"
    );

    assert_eq!(w.schedule.remove(77), 1);
    let t2 = NOW + 1_000;
    assert_eq!(find_or_insert(&fx, x2, t2), Some(x2));
    let armed = wakes(&w.schedule);
    assert_eq!(
        armed.len(),
        1,
        "one over the cap with nothing scheduled: exactly one run: {armed:?}"
    );
    assert_eq!(
        armed[0].1,
        Some(t2 + SPEC_RETRY_MS),
        "a one-shot five minutes after the insert"
    );
}

/// A table left over the cap with no run scheduled (the reaper's transaction lost
/// after the runtime consumed its row) is picked up by the next insert: here through
/// `accumulate` (the per-step path), which arms exactly one run five minutes out. An
/// insert after that run fell due keeps it and writes no schedule row.
///
/// kills: an arm only on the exact crossing to cap + 1 (a lost run is never re-armed);
/// the arm reached from `find_or_insert_summary` but not from `accumulate`; a due run
/// replaced by a later one (a schedule write per insert, and a run that slides away for
/// as long as inserts keep coming); a schedule row per insert.
#[test]
fn sr7_1_an_insert_over_the_cap_with_nothing_scheduled_arms_one_run() {
    let fx = fixture();
    let w = world(&fx);
    seed_many(&w, SPEC_CAP + 1);
    let [x1, x2, _] = NEW;
    open_battle(&w, x1);
    open_battle(&w, x2);

    let delta = crate::tactics_settle::StepDelta::default();
    fx.run_as_at(player(), ts(NOW), |ctx| {
        crate::tactics_settle::accumulate(ctx, &battle(x1), &tactical(x1), &delta);
    });
    assert_eq!(
        fx.writes_to("battle_summary"),
        1,
        "accumulate inserted the zeroed row (a zero delta writes nothing else)"
    );
    let armed = wakes(&w.schedule);
    assert_eq!(armed.len(), 1, "exactly one run: {armed:?}");
    assert_eq!(
        armed[0].1,
        Some(NOW + SPEC_RETRY_MS),
        "a one-shot five minutes out"
    );

    fx.reset_writes();
    let due = NOW + SPEC_RETRY_MS + 5;
    assert_eq!(find_or_insert(&fx, x2, due), Some(x2));
    assert_eq!(fx.writes_to("battle_summary"), 1);
    assert_eq!(
        wakes(&w.schedule),
        armed,
        "a run already due is kept as the next run"
    );
    assert_eq!(fx.writes_to("battle_summary_reaper_schedule"), 0);
}

/// A lookup of a summary that already exists is not an insert, so it arms nothing, even
/// with the table over the cap and nothing armed. This holds through both lookups: the
/// early return in `find_or_insert_summary`, and `summary_row` (reached by `accumulate`
/// with a zero step, since `summary_row` runs before the zero check). With a run armed,
/// neither lookup reads the schedule at all.
///
/// kills: an arm in `summary_row`'s existing-row arm or ahead of its match (a row count
/// and a schedule scan on every battle step, and a schedule write whenever none is
/// armed); an arm in `find_or_insert_summary`'s early return.
#[test]
fn sr7_1_a_lookup_of_an_existing_summary_arms_nothing_over_the_cap() {
    let fx = fixture();
    let w = world(&fx);
    let seeded = seed_many(&w, SPEC_CAP + 1);
    let existing = seeded[0];
    open_battle(&w, existing);
    let (anchor, live) = (battle(existing), tactical(existing));
    let delta = crate::tactics_settle::StepDelta::default();
    let step = || {
        fx.run_as_at(player(), ts(NOW), |ctx| {
            crate::tactics_settle::accumulate(ctx, &anchor, &live, &delta);
        });
    };

    assert_eq!(find_or_insert(&fx, existing, NOW), Some(existing));
    step();
    assert_eq!(
        fx.writes_to("battle_summary"),
        0,
        "the summary exists: nothing is inserted"
    );
    assert_eq!(
        wakes(&w.schedule),
        vec![],
        "over the cap with nothing armed: a lookup arms nothing"
    );

    w.schedule.seed(&one_shot(77, NOW + SPEC_RETRY_MS));
    assert_eq!(find_or_insert(&fx, existing, NOW), Some(existing));
    step();
    assert_eq!(
        fx.rows_read("battle_summary_reaper_schedule"),
        0,
        "a lookup never reads the schedule"
    );
    assert_eq!(fx.writes_to("battle_summary_reaper_schedule"), 0);
    assert_eq!(wakes(&w.schedule), vec![(77, Some(NOW + SPEC_RETRY_MS))]);
}

/// The third caller of the summary insert is the settlement. A Deploying battle with no
/// summary row yet is closed by `tactics_settle::settle` the way `tactics::finish` closes
/// it on a Deploying timeout: anchor `Fled`, tactical row `Finished`, no HP written. The
/// close inserts one zeroed row and finalises it. When that insert takes the table over
/// the cap with nothing armed, exactly one run is armed, five minutes out.
///
/// kills: the arm placed in `find_or_insert_summary` and `accumulate` instead of in the
/// shared insert, so a battle closed in Deploying never arms the reaper.
#[test]
fn sr7_1_a_deploying_close_that_takes_the_table_over_the_cap_arms_one_run() {
    let fx = fixture();
    let w = world(&fx);
    seed_many(&w, SPEC_CAP);
    let [x1, _, _] = NEW;
    let mut anchor = battle(x1);
    anchor.state.outcome = game_core::BattleOutcome::Fled;
    let mut finished = tactical(x1);
    finished.phase = game_core::tactics::types::Phase::Finished;
    finished.turn_state = game_core::tactics::types::TurnState::NotActive;
    w.battles.seed(&anchor);
    w.tacticals.seed(&finished);
    let close = crate::tactics_settle::Close::Deploying;

    fx.run_as_at(player(), ts(NOW), |ctx| {
        crate::tactics_settle::settle(ctx, &anchor, &finished, &close, false, false, NOW);
    });
    assert_eq!(
        fx.writes_to("battle_summary"),
        2,
        "the close inserted the zeroed row, then finalised it"
    );
    let armed = wakes(&w.schedule);
    assert_eq!(armed.len(), 1, "exactly one run: {armed:?}");
    assert_eq!(
        armed[0].1,
        Some(NOW + SPEC_RETRY_MS),
        "a one-shot five minutes after the close"
    );
}

// ===========================================================================
// The reaper deletes the lowest unheld ids down to the cap, at most its limit per
// run, and schedules one more run only while it may have more to do.
// ===========================================================================

/// `plan_summary_reap` deletes the lowest ids, as many as the table is over the cap
/// and never more than the per-run limit. At or below the cap it deletes nothing and
/// looks up no id.
///
/// kills: `>=` for `>` at the cap (ten rows lose one); the highest ids taken instead
/// of the lowest; ids assumed to run 1..=N ("delete every id up to len - cap" deletes
/// nothing here); the limit ignored (fourteen rows lose four); the limit used as the
/// count (eleven rows lose three); a held lookup made when nothing is owed; `len - cap`
/// underflowing below the cap.
#[test]
fn sr7_2_plan_deletes_the_lowest_ids_down_to_the_cap_within_the_limit() {
    let plan = |n: usize| plan_with(&IDS[..n], SMALL_CAP, SMALL_MAX, &[]);
    assert_eq!(plan(9), (vec![], vec![]), "below the cap");
    assert_eq!(plan(10), (vec![], vec![]), "exactly at the cap");
    assert_eq!(plan(11), (vec![7], vec![7]), "one over: the lowest id");
    assert_eq!(plan(12), (vec![7, 10], vec![7, 10]), "two over");
    assert_eq!(
        plan(13),
        (vec![7, 10, 11], vec![7, 10, 11]),
        "over by exactly the limit"
    );
    assert_eq!(
        plan(14),
        (vec![7, 10, 11], vec![7, 10, 11]),
        "over by the limit + 1: the limit holds"
    );
    assert_eq!(
        plan_with(&IDS[..11], SMALL_CAP, SMALL_MAX, &[7]),
        (vec![10], vec![7, 10]),
        "one over with the lowest id held: the lowest UNHELD id"
    );
}

/// Held ids are skipped wherever they sit (at the bottom, inside the walk, at the top)
/// and the walk still collects its full count from the unheld ids above them, then
/// stops: no id past the last one deleted is looked up.
///
/// kills: the limit applied before the held filter (`take(3)` then skip held: one
/// delete, not three); a held id deleted to make up the count; the held lookups run over
/// every id before the limit (fourteen lookups); held rows taken off the overage
/// (`unheld - cap` is 0 here); the walk stopped at the first held id.
#[test]
fn sr7_2_plan_skips_held_ids_and_stops_once_it_has_its_count() {
    let held = [7, 11, 41, 120];
    assert_eq!(
        plan_with(&IDS, SMALL_CAP, SMALL_MAX, &held),
        (vec![10, 40, 55], vec![7, 10, 11, 40, 41, 55]),
        "four over, limit three: three unheld ids; six lookups, three deleted + three skipped"
    );
    assert_eq!(
        plan_with(&IDS, SMALL_CAP, 8, &held),
        (vec![10, 40, 55, 56], vec![7, 10, 11, 40, 41, 55, 56]),
        "four over, limit eight: the overage decides, and the held top id is never asked"
    );
}

/// With fewer unheld ids than the table is over the cap, every one of them is deleted
/// and the walk asks about every id.
///
/// kills: the walk stopped at the first held id (nothing deleted); held ids taken to
/// make up the count; a walk that never reaches the top of the table.
#[test]
fn sr7_2_plan_deletes_fewer_when_only_held_ids_are_left() {
    let table = &IDS[..13];
    let held: Vec<u64> = table
        .iter()
        .copied()
        .filter(|&id| id != 90 && id != 99)
        .collect();
    assert_eq!(
        plan_with(table, SMALL_CAP, SMALL_MAX, &held),
        (vec![90, 99], table.to_vec()),
        "three over, two unheld ids: both, after a walk over all thirteen"
    );
}

/// One run deletes at most the spec's 8 192 rows, stated as a literal. At the shipped cap
/// and limit, a table 8 193 rows over the cap loses exactly its 8 192 lowest ids in one
/// run.
///
/// kills: the per-run limit constant changed (9 000 lets this run delete 8 193 rows).
#[test]
fn sr7_2_a_run_deletes_at_most_8192_rows() {
    assert_eq!(super::BATTLE_SUMMARY_REAP_MAX_DELETE_PER_RUN, 8_192);
    let table: Vec<u64> = (1..=SPEC_CAP + 8_193).collect();
    let deleted = super::plan_summary_reap(
        &table,
        super::BATTLE_SUMMARY_CAP,
        super::BATTLE_SUMMARY_REAP_MAX_DELETE_PER_RUN,
        |_| false,
    );
    assert_eq!(deleted.len(), 8_192, "one run's limit");
    assert_eq!(
        (deleted.first(), deleted.last()),
        (Some(&1), Some(&8_192)),
        "the lowest ids"
    );
}

/// `summary_rearm_ms`: a run arms the next one only when it stopped at its delete limit
/// with the table still over the cap. Back at the cap, or over it with only held rows
/// left (fewer deletes than the limit), it arms none; the next insert over the cap does.
///
/// kills: `||` for `&&`; `>=` for `>` on the cap; the limit test dropped (a run that
/// left only held rows re-arms every five minutes for as long as those battles live);
/// the cap test dropped; `now - retry`, or the retry alone, for `now + retry`.
#[test]
fn sr7_2_rearm_only_when_the_run_hit_its_limit_still_over_the_cap() {
    let g = |rows_left: u64, deleted: usize| {
        super::summary_rearm_ms(rows_left, deleted, SMALL_CAP, SMALL_MAX, 5_000, 30)
    };
    assert_eq!(g(11, 3), Some(5_030), "over the cap, stopped at the limit");
    assert_eq!(g(500, 3), Some(5_030), "far over the cap, at the limit");
    assert_eq!(g(10, 3), None, "at the limit, but back at the cap");
    assert_eq!(g(9, 3), None, "below the cap");
    assert_eq!(g(11, 2), None, "over the cap with only held rows left");
    assert_eq!(g(11, 0), None, "over the cap, every row held");
    assert_eq!(g(10, 0), None, "at the cap, nothing deleted");
}

/// The walk goes in `battle_id` order whatever order the rows are stored in, and a row
/// is held by EITHER battle table: id 7 has only a `battle` row, id 11 only a
/// `battle_tactical` row, and both survive. Twelve rows, cap ten: the run deletes the
/// two lowest unheld ids (10 and 40), ends at the cap and leaves no next run; the
/// interval row it finds is removed and the row it was fired with is left alone.
///
/// kills: rows walked in store order (an unsorted `iter()`); the held check reading
/// `battle` only (11 goes) or `battle_tactical` only (7 goes); held rows ignored; the
/// highest ids reaped; an interval row kept; the firing row deleted.
#[test]
fn sr7_2_a_run_walks_ids_in_key_order_and_skips_ids_either_battle_table_holds() {
    let fx = fixture();
    let w = world(&fx);
    for id in [56, 90, 11, 72, 7, 81, 40, 60, 10, 55, 80, 41] {
        w.summaries.seed(&summary(id));
    }
    w.battles.seed(&battle(7));
    w.tacticals.seed(&tactical(11));
    w.schedule.seed(&one_shot(FIRING, NOW));
    w.schedule.seed(&interval(60));
    reap(&fx, Some(FIRING));
    assert_eq!(
        ids(&w),
        vec![7, 11, 41, 55, 56, 60, 72, 80, 81, 90],
        "10 and 40 are reaped; held 7 and 11 survive"
    );
    assert_eq!(
        wakes(&w.schedule),
        vec![(FIRING, Some(NOW))],
        "at the cap: no next run; the interval row is gone, the firing row is the runtime's"
    );
}

/// A run that stops at its delete limit with the table still over the cap arms exactly
/// one more run, a one-shot five minutes out, as a NEW row beside the one-shot it was
/// fired with (the runtime deletes that one once the run returns, so counting it as the
/// next run would leave none). Fourteen rows, cap ten, limit three, ids 7, 11, 41 and
/// 120 held: the run deletes 10, 40 and 55.
///
/// kills: the re-arm missing; the firing row counted as the next run (it is early
/// enough for the one-row rule to keep); the firing row deleted; the limit applied
/// before the held filter (only 10 goes); a held row deleted to reach the limit; the
/// next run armed at once or at the wrong delay.
#[test]
fn sr7_2_a_run_stopped_at_its_limit_over_the_cap_arms_one_new_run() {
    let fx = fixture();
    let w = world(&fx);
    for &id in IDS.iter().rev() {
        w.summaries.seed(&summary(id));
    }
    w.battles.seed(&battle(7));
    w.tacticals.seed(&tactical(11));
    w.battles.seed(&battle(41));
    open_battle(&w, 120);
    w.schedule.seed(&one_shot(FIRING, NOW));
    reap(&fx, Some(FIRING));
    assert_eq!(
        ids(&w),
        vec![7, 11, 41, 56, 60, 72, 80, 81, 90, 99, 120],
        "the three lowest unheld ids are reaped"
    );
    let after = wakes(&w.schedule);
    assert_eq!(after.len(), 2, "the firing row and one new run: {after:?}");
    assert!(
        after.contains(&(FIRING, Some(NOW))),
        "the firing row is left to the runtime: {after:?}"
    );
    let next: Vec<(u64, Option<i64>)> = after.into_iter().filter(|r| r.0 != FIRING).collect();
    assert_eq!(next.len(), 1, "exactly one new run: {next:?}");
    assert_eq!(
        next[0].1,
        Some(NOW + SPEC_RETRY_MS),
        "a one-shot five minutes out"
    );
}

/// A run still over the cap that deleted fewer rows than its limit has left nothing but
/// held rows: it arms no next run, so a long battle does not run the reaper every five
/// minutes for nothing (the next insert over the cap arms one). Thirteen rows, cap ten,
/// every id but 90 and 99 held: the run walks the whole table, deletes those two, and
/// removes every schedule row but the one it was fired with.
///
/// kills: a re-arm whenever the table is still over the cap; another row left armed;
/// the walk stopped at the first held id (nothing deleted).
#[test]
fn sr7_2_a_run_that_left_only_held_rows_over_the_cap_arms_no_run() {
    let fx = fixture();
    let w = world(&fx);
    let table = &IDS[..13];
    for &id in table.iter().rev() {
        w.summaries.seed(&summary(id));
    }
    let held = table.iter().copied().filter(|&id| id != 90 && id != 99);
    for (i, id) in held.enumerate() {
        if i % 2 == 0 {
            w.battles.seed(&battle(id));
        } else {
            w.tacticals.seed(&tactical(id));
        }
    }
    w.schedule.seed(&one_shot(FIRING, NOW));
    w.schedule.seed(&one_shot(70, NOW + 1_000));
    reap(&fx, Some(FIRING));
    assert_eq!(
        ids(&w),
        vec![7, 10, 11, 40, 41, 55, 56, 60, 72, 80, 81],
        "only the two unheld ids are reaped"
    );
    assert_eq!(
        wakes(&w.schedule),
        vec![(FIRING, Some(NOW))],
        "no next run: only the firing row is left"
    );
}

/// A run over the cap by exactly its limit deletes that many and ends AT the cap: no
/// next run, although it deleted its limit. Thirteen rows, cap ten, nothing held.
///
/// kills: the rows left counted before the deletes (thirteen, so a re-arm); a re-arm
/// whenever a run deletes its limit.
#[test]
fn sr7_2_a_run_that_reaches_the_cap_at_its_limit_arms_no_run() {
    let fx = fixture();
    let w = world(&fx);
    for &id in IDS[..13].iter().rev() {
        w.summaries.seed(&summary(id));
    }
    w.schedule.seed(&one_shot(FIRING, NOW));
    reap(&fx, Some(FIRING));
    assert_eq!(
        ids(&w),
        vec![40, 41, 55, 56, 60, 72, 80, 81, 90, 99],
        "the three lowest ids are reaped"
    );
    assert_eq!(
        wakes(&w.schedule),
        vec![(FIRING, Some(NOW))],
        "back at the cap: no next run"
    );
}

/// The shipped reducer at the real cap: a table of exactly 100 000 rows loses none,
/// and a run fired by an interval row (which the runtime keeps) removes that row,
/// leaving no run behind.
///
/// kills: the reducer passing a cap below 100 000 (or the constant set below it); an
/// interval firing row treated as the runtime's to delete (the reaper then runs every
/// five minutes for ever).
#[test]
fn sr7_2_the_reducer_leaves_a_table_at_exactly_the_cap_alone() {
    let fx = fixture();
    let w = world(&fx);
    seed_many(&w, SPEC_CAP);
    w.schedule.seed(&interval(FIRING));
    let module = Identity::from_byte_array(MODULE);
    fx.set_database_identity(module);
    let got = fx.run_as_at(module, ts(NOW), |ctx| {
        super::battle_summary_reaper(ctx, interval(FIRING))
    });
    assert_eq!(got, Ok(()));
    assert_eq!(
        fx.writes_to("battle_summary"),
        0,
        "100 000 rows: nothing to reap"
    );
    assert_eq!(
        wakes(&w.schedule),
        vec![],
        "no next run, and the interval row it was fired with is gone"
    );
}

/// The shipped reducer at the real cap: three rows over it, the lowest id held by its
/// `battle_tactical` row only and the next by its `battle` row only. The run deletes
/// exactly the three lowest UNHELD ids, arms no next run (it deleted fewer rows than its
/// limit and is back at the cap) and leaves the one-shot it was fired with to the
/// runtime.
///
/// kills: the reducer passing a cap other than 100 000 (or the constant changed); the
/// reducer's held check reading one table, or none; the highest ids reaped; a next run
/// armed at the cap; the firing row deleted.
#[test]
fn sr7_2_the_reducer_three_over_the_cap_reaps_the_three_lowest_unheld_ids() {
    let fx = fixture();
    let w = world(&fx);
    let seeded = seed_many(&w, SPEC_CAP + 3);
    w.tacticals.seed(&tactical(seeded[0]));
    w.battles.seed(&battle(seeded[1]));
    w.schedule.seed(&one_shot(FIRING, NOW));
    let module = Identity::from_byte_array(MODULE);
    fx.set_database_identity(module);
    let got = fx.run_as_at(module, ts(NOW), |ctx| {
        super::battle_summary_reaper(ctx, one_shot(FIRING, NOW))
    });
    assert_eq!(got, Ok(()));
    assert_eq!(
        gone(&w, &seeded),
        vec![seeded[2], seeded[3], seeded[4]],
        "the three lowest unheld ids, and nothing else"
    );
    assert_eq!(
        wakes(&w.schedule),
        vec![(FIRING, Some(NOW))],
        "back at the cap: no next run; the firing row is the runtime's"
    );
}

// ===========================================================================
// A client call to the reaper is refused and changes no row.
// ===========================================================================

/// `battle_summary_reaper` is scheduler-only. A player calling it over a table at
/// exactly the real cap is refused, and the schedule (the firing one-shot and an
/// interval row) is left as it was. Then, three rows past the cap, a player, the
/// all-zero identity and the identity that WAS the module before it changed are each
/// refused with the scheduler-only error before a single row is read or written:
/// neither `battle_summary` nor the schedule is read, written or changed. The module
/// identity is then admitted, reaps the three lowest ids, and with the table back at
/// the cap removes the interval row.
///
/// kills: the guard missing, inverted, or compared with a fixed identity instead of
/// `ctx.database_identity()`; the guard after the scan (rows read) or after the deletes
/// (three rows gone); an "at or below the cap" early return placed before the guard
/// (it answers the at-cap client with `Ok`, or clears the schedule); a guard that
/// refuses the module too.
#[test]
fn sr7_3_a_client_call_is_refused_before_any_row_is_read_or_written() {
    let fx = fixture();
    let w = world(&fx);
    let seeded = seed_many(&w, SPEC_CAP);
    w.schedule.seed(&one_shot(FIRING, NOW));
    w.schedule.seed(&interval(60));
    let before = wakes(&w.schedule);
    let module = Identity::from_byte_array(MODULE);
    fx.set_database_identity(module);
    let call = |who: Identity| {
        fx.run_as_at(who, ts(NOW), |ctx| {
            super::battle_summary_reaper(ctx, one_shot(FIRING, NOW))
        })
    };

    assert_eq!(
        call(player()),
        Err("battle_summary_reaper is scheduler-only".to_string()),
        "a player is refused at exactly the cap"
    );
    assert_eq!(
        wakes(&w.schedule),
        before,
        "at the cap: the refused call leaves the schedule as it was"
    );
    assert_eq!(fx.writes_to("battle_summary_reaper_schedule"), 0);

    for id in NEW {
        w.summaries.seed(&summary(id));
    }
    let stale_module = Identity::from_byte_array(DEFAULT_DATABASE_IDENTITY);
    for (label, caller) in [
        ("a player", player()),
        ("the all-zero identity", Identity::from_byte_array([0; 32])),
        ("a stale module identity", stale_module),
    ] {
        assert_eq!(
            call(caller),
            Err("battle_summary_reaper is scheduler-only".to_string()),
            "{label} must be refused"
        );
        assert_eq!(
            fx.rows_read("battle_summary"),
            0,
            "{label}: not one summary row is read"
        );
        assert_eq!(
            fx.rows_read("battle_summary_reaper_schedule"),
            0,
            "{label}: not one schedule row is read"
        );
        assert_eq!(
            fx.writes_to("battle_summary"),
            0,
            "{label}: no summary row is written"
        );
        assert_eq!(
            fx.writes_to("battle_summary_reaper_schedule"),
            0,
            "{label}: no schedule row is written"
        );
        assert_eq!(
            wakes(&w.schedule),
            before,
            "{label}: the schedule is unchanged"
        );
    }
    assert_eq!(call(module), Ok(()), "the module identity is admitted");
    assert_eq!(
        gone(&w, &seeded),
        seeded[..3].to_vec(),
        "the module reaps the three lowest ids"
    );
    assert_eq!(
        wakes(&w.schedule),
        vec![(FIRING, Some(NOW))],
        "back at the cap: no next run, the interval row is gone"
    );
}
