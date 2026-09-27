//! `movement` server-module tests: the process-static encounter-failure
//! `RateLimiter`, and a native-host suite (`mod nh`)
//! driving the shipped `enqueue_move` / `set_move` / `clear_queue` /
//! `movement_tick` reducers for the ADR-0168 intake and drain battle locks and
//! the TR-6 trade-escrow growth skip.

// ===========================================================================
// rate-limited, JSON-escaped wild-encounter failure logs
//
// EARS criteria covered below:
//
//   M-1  A fresh `RateLimiter`'s first `check` SHALL emit, reporting zero
//        suppressed events.
//   M-2  WHILE inside the window a `check` SHALL suppress (return `None`) and
//        count; the next emit SHALL report the EXACT suppressed count and then
//        reset it to zero.
//   M-3  The window boundary SHALL be INCLUSIVE: `elapsed == window` emits,
//        `elapsed == window - 1` suppresses.
//   M-4  WHEN the injected clock goes BACKWARDS the limiter SHALL emit and
//        re-anchor to the new (earlier) instant rather than suppress forever.
//   M-5  For extreme operands (`i64::MIN`, `i64::MAX`) `check` SHALL NOT panic.
//        This workspace ships `overflow-checks = true`, so a bare subtraction
//        would PANIC the zone tick in production — the exact failure this
//        feature exists to surface.
//   M-6  `movement_tick` SHALL pass every interpolated error reason through
//        `json_escape`, including the two pre-existing `movement_tick_error`
//        sites.
//   M-7  The two swallow sites in the grass-encounter block SHALL become logged
//        no-ops, each gated by its OWN process-static limiter — a spammy
//        bad-content zone must not mask `begin_encounter` failures (one of
//        `begin_encounter`'s Err paths, "party has no conscious monster", is
//        ROUTINE gameplay and can burst).
//
// Same source-scan doctrine as the sections above (no reducer-executing
// harness, ADR-0156 P7), with one addition: the two new `evt` names live inside
// STRING literals, which `squashed_movement()` deliberately blanks. Those two
// needles therefore run against a comments-only view
// ([`squashed_movement_keeping_strings`]) while every needle with teeth — the
// limiter statics, their `.check(` calls, `json_escape(`, and the two negative
// needles — runs against the string-blanked view where only executable code
// survives.
// ===========================================================================

use super::RateLimiter;

/// The window every `RateLimiter` unit test below uses. Production picks 5000 ms;
/// the tests pass it explicitly so they pin the SEMANTICS of the
/// parameter rather than a constant that a later tuning slice may legitimately
/// change.
const TEST_WINDOW_MS: i64 = 5_000;

/// **M-1** — a fresh limiter's FIRST `check` emits, reporting zero suppressed.
///
/// kills: an impl that stores `last_emit_ms` as a plain `i64` initialised to 0
/// (or any magic sentinel) instead of `Option<i64>`. With a 0 sentinel and the
/// tick's injected clock at, say, 1_000 ms, the first `elapsed` is 1_000 — inside
/// the window — so the very first content fault is SILENTLY DROPPED, which is
/// precisely the swallowing this feature exists to end. Also kills an impl whose
/// first emit reports a non-zero suppressed count (a fabricated backlog in the
/// first log line an operator ever sees).
#[test]
fn rate_limiter_first_check_emits_zero_suppressed() {
    let limiter = RateLimiter::new();
    let first = limiter.check(1_000, TEST_WINDOW_MS);
    assert_eq!(
        first,
        Some(0),
        "TEETH (11r-g M-1, ADR-0170 D4): a fresh RateLimiter's first check must be \
         Some(0) — EMIT, with zero suppressed — but it returned {first:?}. \
         `last_emit_ms` is `Option<i64>` exactly so that never-emitted is \
         unrepresentable as a magic value: with a 0 sentinel the first check at a \
         non-zero clock reads as `elapsed = 1000 < window` and the FIRST content \
         fault is dropped, which is the swallowing ADR-0170 D4 exists to end."
    );
}

/// **M-1b** — `RateLimiter::new()` is a `const fn` and the type is `Sync`.
///
/// A COMPILE-TIME proof, not a runtime one: `static PROBE: RateLimiter =
/// RateLimiter::new();` only compiles if `new` is `const` and `RateLimiter: Sync`.
/// Both are load-bearing — ADR-0170 D4 makes the two limiters PROCESS STATICS
/// (`static X: RateLimiter = RateLimiter::new();`), and a non-const constructor
/// would force a `LazyLock`/`OnceLock` wrapper whose extra indirection is exactly
/// what the `Mutex`-inside-the-struct design avoids.
///
/// kills: an impl whose `new` is a plain `fn`, and an impl that reaches for a
/// `Cell`/`RefCell` (not `Sync`) instead of a `Mutex` — the latter would also
/// silently drop the read-decide-write-back atomicity the single lock provides.
///
/// The probe static is function-local, so it shares no state with any other test.
#[test]
fn rate_limiter_new_is_const_and_the_type_is_sync() {
    static PROBE: RateLimiter = RateLimiter::new();
    let first = PROBE.check(0, TEST_WINDOW_MS);
    assert_eq!(
        first,
        Some(0),
        "TEETH (11r-g M-1b, ADR-0170 D4): a limiter declared as a process `static` \
         must behave exactly like a locally constructed one on its first check; got \
         {first:?}. The real content of this test is that it COMPILES: \
         `static PROBE: RateLimiter = RateLimiter::new();` requires `new` to be a \
         `const fn` and `RateLimiter` to be `Sync`, which is what lets ADR-0170 D4 \
         declare the two production limiters as plain statics."
    );
}

/// **M-2** — inside the window `check` suppresses and COUNTS; the next emit
/// reports the exact count and resets it.
///
/// The sequence (window 5_000): emit at 0, three suppressed checks at 1_000 /
/// 2_000 / 3_000, an emit at 5_000 that must report exactly `Some(3)`, then one
/// suppressed check and a second emit that must report exactly `Some(1)`.
///
/// kills, in order: (a) an impl that never suppresses (every check would emit, so
/// a bad-content zone re-logs at 5 Hz per character and the rate limit does
/// nothing); (b) an impl that suppresses but does not count (the emit would
/// report `Some(0)` and the loss would be invisible — ADR-0170 D4 makes the
/// suppressed count the ONLY surviving evidence of what was dropped); (c) an impl
/// that forgets to RESET the counter on emit — the second emit would report 4
/// instead of 1, so every subsequent log line over-reports a monotonically
/// growing backlog; (d) an off-by-one in the counter (Some(2) or Some(4) at the
/// first emit).
#[test]
fn rate_limiter_suppresses_in_window_then_reports_the_exact_count() {
    let limiter = RateLimiter::new();

    let opening = limiter.check(0, TEST_WINDOW_MS);
    assert_eq!(
        opening,
        Some(0),
        "TEETH (11r-g M-2 precondition): the opening check must emit Some(0); got \
         {opening:?}. Every count below is measured relative to this anchor."
    );

    for now in [1_000i64, 2_000, 3_000] {
        let suppressed = limiter.check(now, TEST_WINDOW_MS);
        assert_eq!(
            suppressed, None,
            "TEETH (11r-g M-2, ADR-0170 D4): check({now}) is {now} ms after the emit \
             at 0 — inside the 5_000 ms window — so it must SUPPRESS (None); got \
             {suppressed:?}. An impl that emits here re-logs the same content fault \
             on every tick for every character in the zone, which is the log flood \
             the limiter exists to prevent."
        );
    }

    let after_window = limiter.check(5_000, TEST_WINDOW_MS);
    assert_eq!(
        after_window,
        Some(3),
        "TEETH (11r-g M-2, ADR-0170 D4): the emit at the window boundary must report \
         EXACTLY the three checks it suppressed — Some(3) — but it returned \
         {after_window:?}. Some(0) means the impl suppresses without counting, and \
         the suppressed count is the only surviving evidence of what was dropped (a \
         window conflates zones AND reasons, so nothing else records the loss)."
    );

    let suppressed_again = limiter.check(5_001, TEST_WINDOW_MS);
    assert_eq!(
        suppressed_again, None,
        "TEETH (11r-g M-2, ADR-0170 D4): one ms after an emit must suppress; got \
         {suppressed_again:?}. This also proves the emit at 5_000 RE-ANCHORED the \
         window rather than leaving it at 0."
    );

    let second_emit = limiter.check(10_001, TEST_WINDOW_MS);
    assert_eq!(
        second_emit,
        Some(1),
        "TEETH (11r-g M-2, ADR-0170 D4): the second emit must report exactly the ONE \
         check suppressed since the previous emit — Some(1) — but it returned \
         {second_emit:?}. Some(4) is the signature of an impl that never resets the \
         counter, which makes every later log line over-report a backlog that has \
         already been reported."
    );
}

/// **M-3** — the window boundary is INCLUSIVE.
///
/// Two independent, freshly constructed limiters so neither assertion can be
/// perturbed by the other's suppressed count:
///   * limiter A: emit at 0, then `window - 1` must SUPPRESS.
///   * limiter B: emit at 0, then exactly `window` must EMIT, with Some(0)
///     because nothing was suppressed in between.
///
/// kills: the `>` / `>=` mutant in `elapsed >= window`. A strict `>` makes
/// limiter B return None (the assertion fires); an `elapsed >= window - 1` or a
/// `>` flipped the other way makes limiter A emit. This is the single most
/// mutable line in the whole struct, and both directions are covered.
#[test]
fn rate_limiter_window_boundary_is_inclusive() {
    let just_inside = RateLimiter::new();
    let opened_a = just_inside.check(0, TEST_WINDOW_MS);
    assert_eq!(
        opened_a,
        Some(0),
        "TEETH (11r-g M-3 precondition): limiter A's opening check must emit Some(0); \
         got {opened_a:?}."
    );
    let one_short = just_inside.check(TEST_WINDOW_MS - 1, TEST_WINDOW_MS);
    assert_eq!(
        one_short, None,
        "TEETH (11r-g M-3, ADR-0170 D4): one ms SHORT of the window must suppress, \
         but check(window - 1) returned {one_short:?}. Together with the assertion \
         below this pins the comparison as `elapsed >= window`: an impl using \
         `elapsed >= window - 1` (or no comparison at all) emits here."
    );

    let exactly_at = RateLimiter::new();
    let opened_b = exactly_at.check(0, TEST_WINDOW_MS);
    assert_eq!(
        opened_b,
        Some(0),
        "TEETH (11r-g M-3 precondition): limiter B's opening check must emit Some(0); \
         got {opened_b:?}."
    );
    let at_boundary = exactly_at.check(TEST_WINDOW_MS, TEST_WINDOW_MS);
    assert_eq!(
        at_boundary,
        Some(0),
        "TEETH (11r-g M-3, ADR-0170 D4): EXACTLY at the window must emit with zero \
         suppressed, but check(window) returned {at_boundary:?}. This kills the \
         `elapsed > window` mutant, which would silently stretch every window by one \
         millisecond and — with a tick clock that lands on exact multiples — could \
         drop an emit entirely. A SECOND, freshly constructed limiter is used here \
         so limiter A's suppressed check cannot leak into this count."
    );
}

/// **M-4** — a clock that goes BACKWARDS emits and RE-ANCHORS.
///
/// ADR-0170 D4 accepts the trade explicitly: a persistently jittery host clock
/// forces an emit per oscillation, which is a host-reliability scenario and not
/// attacker-reachable; suppressing forever is the unacceptable alternative.
///
/// The sequence proves both halves. After an emit at 1_000 and one suppressed
/// check at 2_000, a check at 500 (backwards) must return `Some(1)` — it EMITS
/// and reports the suppressed check. The two follow-up probes then prove the
/// anchor moved to 500 rather than staying at 1_000: `500 + window - 1`
/// suppresses, and `500 + window` emits. With the anchor left at 1_000 the second
/// probe is only 4_500 ms elapsed and would return None.
///
/// kills: (a) an impl with NO backwards branch that just computes
/// `now.saturating_sub(last)` — it yields 0, suppresses, and (with a clock that
/// jumped back far enough) the limiter is stuck suppressing until the clock
/// catches up, so a real content fault is silently swallowed for as long as the
/// jump; (b) an impl that emits on backwards but does NOT re-anchor, which leaves
/// the window computed against a future instant.
#[test]
fn rate_limiter_clock_backwards_emits_and_reanchors() {
    let limiter = RateLimiter::new();

    let opening = limiter.check(1_000, TEST_WINDOW_MS);
    assert_eq!(
        opening,
        Some(0),
        "TEETH (11r-g M-4 precondition): the opening check at 1_000 must emit \
         Some(0); got {opening:?}."
    );
    let inside = limiter.check(2_000, TEST_WINDOW_MS);
    assert_eq!(
        inside, None,
        "TEETH (11r-g M-4 precondition): check(2_000) is inside the window and must \
         suppress; got {inside:?}."
    );

    let backwards = limiter.check(500, TEST_WINDOW_MS);
    assert_eq!(
        backwards,
        Some(1),
        "TEETH (11r-g M-4, ADR-0170 D4): a check whose clock reading is EARLIER than \
         the last emit must EMIT and report the one suppressed check — Some(1) — but \
         it returned {backwards:?}. None is the signature of an impl with no \
         backwards branch, which just computes `now.saturating_sub(last)` = 0: after \
         a backwards clock jump such a limiter suppresses until the clock catches up \
         again, silently swallowing every content fault in between."
    );

    let short_of_new_window = limiter.check(500 + TEST_WINDOW_MS - 1, TEST_WINDOW_MS);
    assert_eq!(
        short_of_new_window, None,
        "TEETH (11r-g M-4, ADR-0170 D4): one ms short of the window measured from the \
         NEW anchor (500) must suppress; got {short_of_new_window:?}."
    );
    let at_new_window = limiter.check(500 + TEST_WINDOW_MS, TEST_WINDOW_MS);
    assert_eq!(
        at_new_window,
        Some(1),
        "TEETH (11r-g M-4, ADR-0170 D4): exactly one window after the NEW anchor (500) \
         must emit, reporting the one check suppressed since — Some(1) — but it \
         returned {at_new_window:?}. This is the assertion that proves the backwards \
         check RE-ANCHORED: with the anchor left at 1_000 this instant is only 4_500 \
         ms elapsed, so a non-re-anchoring impl returns None here while passing every \
         assertion above it."
    );
}

/// **M-5** — extreme clock operands never panic.
///
/// This workspace sets `overflow-checks = true` (and `cargo test` builds with
/// them on by default), so a bare `now - last` on these operands ABORTS. In
/// production that abort is a panicking zone tick — the exact catastrophic
/// failure a LOGGING feature must never introduce, and it would fire on the very
/// path that exists to make faults visible.
///
/// kills: any non-saturating arithmetic in `check`. The decisive row is the
/// fresh limiter anchored at `i64::MIN` and then checked at `i64::MAX`:
/// `i64::MAX - i64::MIN` overflows, while `i64::MAX.saturating_sub(i64::MIN)`
/// saturates to `i64::MAX`, which is past any window and therefore emits. The
/// other rows cover the backwards branch at the extremes and the `MIN + window`
/// boundary, all of which a mutant that "fixes" only one subtraction would still
/// blow up on.
#[test]
fn rate_limiter_extreme_clock_operands_never_panic() {
    // Row 1 — an emit at 0, then the clock jumps to i64::MIN (backwards).
    let jumped_back = RateLimiter::new();
    let anchor = jumped_back.check(0, TEST_WINDOW_MS);
    assert_eq!(
        anchor,
        Some(0),
        "TEETH (11r-g M-5 precondition): the opening check at 0 must emit Some(0); \
         got {anchor:?}."
    );
    let at_min = jumped_back.check(i64::MIN, TEST_WINDOW_MS);
    assert_eq!(
        at_min,
        Some(0),
        "TEETH (11r-g M-5, ADR-0170 D4): check(i64::MIN) after an emit at 0 is the \
         backwards case at the extreme — it must emit Some(0) and re-anchor, not \
         panic; got {at_min:?}."
    );
    let min_plus_window = jumped_back.check(i64::MIN + TEST_WINDOW_MS, TEST_WINDOW_MS);
    assert_eq!(
        min_plus_window,
        Some(0),
        "TEETH (11r-g M-5, ADR-0170 D4): exactly one window after an anchor at \
         i64::MIN must emit Some(0); got {min_plus_window:?}."
    );

    // Row 2 — the decisive overflow row: anchored at i64::MIN, checked at i64::MAX.
    let full_span = RateLimiter::new();
    let anchored_at_min = full_span.check(i64::MIN, TEST_WINDOW_MS);
    assert_eq!(
        anchored_at_min,
        Some(0),
        "TEETH (11r-g M-5 precondition): a fresh limiter's first check must emit \
         Some(0) whatever the clock reads; got {anchored_at_min:?}."
    );
    let at_max = full_span.check(i64::MAX, TEST_WINDOW_MS);
    assert_eq!(
        at_max,
        Some(0),
        "TEETH (11r-g M-5, ADR-0170 D4): with the anchor at i64::MIN, a check at \
         i64::MAX must emit Some(0); got {at_max:?}. THIS IS THE OVERFLOW ROW: a bare \
         `now - last` computes `i64::MAX - i64::MIN`, which PANICS under this \
         workspace's `overflow-checks = true` — in production that is a panicking \
         zone tick raised by the very code path added to make faults visible. \
         `now.saturating_sub(last)` saturates to i64::MAX, which is past any window, \
         so the correct answer is an emit."
    );
    let immediately_again = full_span.check(i64::MAX, TEST_WINDOW_MS);
    assert_eq!(
        immediately_again, None,
        "TEETH (11r-g M-5, ADR-0170 D4): a second check at the same extreme instant \
         is zero ms elapsed and must suppress; got {immediately_again:?}. This proves \
         the saturating subtraction did not simply make every comparison true."
    );
}

// ===========================================================================
// Native-host behavioural suite (debloat Phase 2: ST-movement_tests#intake-guards).
//
// The SHIPPED reducers run through `Fixture::run_as(_at)` with a real sender and
// clock. HOST LIMIT: no transaction rollback, so every rejection is asserted as a
// refusal BEFORE any write (the store byte-identical). Growth under scheduler
// time-skip is owned by raising_tests (`nh_movement_tick_time_skip_never_grows_monsters`).
// ===========================================================================
mod nh {
    use crate::marshal::pub_from_monster;
    use crate::movement::{
        clear_queue, enqueue_move, movement_tick, set_move, MovementTickSchedule,
    };
    use crate::native_host_tests::{fixture, Fixture, Handle, DEFAULT_DATABASE_IDENTITY};
    use crate::raising::QT_TICK_MS;
    use crate::schema::{Battle, Character, Monster, MonsterPub, Player, SpeciesRow, TradeOffer};
    use game_core::{ActionState, Affinity, BattleOutcome, Direction, MoveInput, TradeStatus};
    use spacetimedb::sats::bsatn::to_vec;
    use spacetimedb::{Identity, ScheduleAt, Timestamp};

    const T0: i64 = 1_750_000_000_000;
    const REJECT_IN_BATTLE: &str = "cannot move during an ongoing battle";

    fn a() -> Identity {
        Identity::from_byte_array([0xA1; 32])
    }
    fn b() -> Identity {
        Identity::from_byte_array([0xB2; 32])
    }
    fn at(ms: i64) -> Timestamp {
        Timestamp::from_micros_since_unix_epoch(ms * 1000)
    }

    fn battle(
        battle_id: u64,
        player: Identity,
        opponent: Identity,
        outcome: BattleOutcome,
    ) -> Battle {
        let lead = game_core::BattleMonster {
            species_id: 1,
            affinity: Affinity::Fire,
            level: 7,
            current_hp: 30,
            max_hp: 30,
            stats: game_core::StatBlock {
                hp: 30,
                attack: 20,
                defense: 20,
                speed: 20,
                sp_attack: 20,
                sp_defense: 20,
            },
            known_skill_ids: vec![1],
            status: None,
        };
        Battle {
            battle_id,
            player_identity: player,
            opponent_identity: opponent,
            state: game_core::BattleState {
                side_a: game_core::BattleSide {
                    active: 0,
                    team: vec![lead.clone()],
                },
                side_b: game_core::BattleSide {
                    active: 0,
                    team: vec![lead],
                },
                outcome,
                turn_number: 1,
                weather: None,
            },
            party_monster_ids: vec![],
            opponent_monster_ids: vec![],
            created_at_ms: 0,
        }
    }

    fn monster(monster_id: u64, owner: Identity, party_slot: u8) -> Monster {
        Monster {
            monster_id,
            owner_identity: owner,
            species_id: 1,
            nickname: format!("m{monster_id}"),
            level: 7,
            xp: 120,
            iv_hp: 10,
            iv_attack: 11,
            iv_defense: 12,
            iv_speed: 13,
            iv_sp_attack: 14,
            iv_sp_defense: 15,
            nature_kind: game_core::NatureKind::Hardy,
            ev_hp: 4,
            ev_attack: 5,
            ev_defense: 6,
            ev_speed: 7,
            ev_sp_attack: 8,
            ev_sp_defense: 9,
            stat_hp: 40,
            stat_attack: 20,
            stat_defense: 20,
            stat_speed: 20,
            stat_sp_attack: 20,
            stat_sp_defense: 20,
            current_hp: 40,
            party_slot,
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
            quality_time_ticks_total: 10,
            quality_time_accum_ms: 0,
            quality_time_window_ms: 0,
            quality_time_window_start_ms: T0,
            last_essence_train_at_ms: 0,
        }
    }

    fn species1() -> SpeciesRow {
        SpeciesRow {
            id: 1,
            name: "s1".to_string(),
            base_hp: 30,
            base_attack: 31,
            base_defense: 32,
            base_speed: 33,
            base_sp_attack: 34,
            base_sp_defense: 35,
            affinity: Affinity::Fire,
            learnable_skill_ids: vec![1],
            ability: None,
            tier: 0,
        }
    }

    fn offer(trade_id: u64, initiator: Identity, counterparty: Identity) -> TradeOffer {
        TradeOffer {
            trade_id,
            initiator,
            counterparty,
            initiator_monster_ids: vec![],
            initiator_items: vec![],
            initiator_currency: 0,
            counterparty_monster_ids: vec![],
            counterparty_items: vec![],
            counterparty_currency: 0,
            initiator_cards: vec![],
            counterparty_cards: vec![],
            status: TradeStatus::Pending,
            created_at_ms: T0,
        }
    }

    fn character(entity_id: u64, queue: Vec<MoveInput>, action: ActionState) -> Character {
        Character {
            entity_id,
            zone_id: 0,
            tile_x: 1,
            tile_y: 1,
            facing: Direction::South,
            action,
            move_started_at_ms: 0,
            sprite_id: 0,
            move_queue: queue,
        }
    }

    struct World<'a> {
        players: Handle<'a, Player>,
        chars: Handle<'a, Character, u64>,
        battles: Handle<'a, Battle>,
        monsters: Handle<'a, Monster, u64>,
        pubs: Handle<'a, MonsterPub, u64>,
        offers: Handle<'a, TradeOffer>,
    }

    /// Every table the movement reducers read or write: `player` (seq ack),
    /// `character` (queue), both battle-role indexes (the ADR-0122 SSOT), and
    /// the growth tail's monster / monster_pub / trade_offer / species rows.
    fn world(fx: &Fixture) -> World<'_> {
        let _ = fx.table_keyed::<Player, u64>("player", "entity_id", |r| r.entity_id);
        let _ = fx.table_keyed::<Character, u32>("character", "zone_id", |r| r.zone_id);
        let _ = fx.table::<Battle>("battle", "opponent_identity", |r| r.opponent_identity);
        let _ = fx.table::<TradeOffer>("trade_offer", "counterparty", |r| r.counterparty);
        let _ = fx.table::<Monster>("monster", "owner_identity", |r| r.owner_identity);
        fx.table_keyed::<SpeciesRow, u32>("species_row", "id", |r| r.id)
            .seed(&species1());
        World {
            players: fx
                .table::<Player>("player", "identity", |r| r.identity)
                .writable()
                .unique(),
            chars: fx
                .table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
                .writable()
                .unique(),
            battles: fx.table::<Battle>("battle", "player_identity", |r| r.player_identity),
            monsters: fx
                .table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id)
                .writable()
                .unique(),
            pubs: fx
                .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
                .writable()
                .unique(),
            offers: fx.table::<TradeOffer>("trade_offer", "initiator", |r| r.initiator),
        }
    }

    impl World<'_> {
        fn join(&self, who: Identity, entity_id: u64, ch: Character) {
            self.players.seed(&Player {
                identity: who,
                entity_id,
                name: String::new(),
                online: true,
                last_input_seq: 0,
            });
            self.chars.seed(&ch);
        }
        fn seed_monster(&self, m: &Monster) {
            self.pubs.seed(&pub_from_monster(m, 1));
            self.monsters.seed(m);
        }
        fn ticks(&self, id: u64) -> u32 {
            self.monsters
                .rows()
                .into_iter()
                .find(|m| m.monster_id == id)
                .expect("monster row")
                .quality_time_ticks_total
        }
        fn character(&self, entity_id: u64) -> Character {
            self.chars
                .rows()
                .into_iter()
                .find(|c| c.entity_id == entity_id)
                .expect("character row")
        }
        fn snapshot(&self) -> Vec<Vec<u8>> {
            vec![
                to_vec(&self.players.rows()).unwrap(),
                to_vec(&self.chars.rows()).unwrap(),
                to_vec(&self.monsters.rows()).unwrap(),
            ]
        }
    }

    /// ADR-0168 D2 intake lock, both roles: while the caller is in an Ongoing
    /// battle as side A (PvE or PvP) OR as the PvP side-B opponent,
    /// `enqueue_move` and `set_move` refuse before any write (no seq ack, no
    /// queued intent). `clear_queue` is deliberately NOT guarded
    /// and still cancels. Positive control: once the battle is decided the very
    /// same call is admitted and queues the intent.
    ///
    /// kills: the lock deleted / moved below `authorize_move` (the seq ack is
    /// written) / side-A-only predicate (the side-B arm) / keyed on the wrong
    /// identity / clear_queue gaining the lock.
    #[test]
    fn nh_intake_refuses_movement_during_an_ongoing_battle_in_either_role() {
        let arms: [(&str, Identity, Identity); 3] = [
            ("side A vs wild", a(), crate::WILD_IDENTITY),
            ("side A vs player", a(), b()),
            ("side B (PvP opponent)", b(), a()),
        ];
        for (label, player, opponent) in arms {
            let fx = fixture();
            let w = world(&fx);
            w.join(a(), 1, character(1, vec![], ActionState::Idle));
            w.battles
                .seed(&battle(1, player, opponent, BattleOutcome::Ongoing));
            let before = w.snapshot();
            assert_eq!(
                fx.run_as_at(a(), at(T0), |ctx| enqueue_move(ctx, MoveInput::Jump, 1)),
                Err(REJECT_IN_BATTLE.to_string()),
                "{label}: enqueue_move"
            );
            assert_eq!(
                fx.run_as_at(a(), at(T0), |ctx| set_move(
                    ctx,
                    MoveInput::Step(Direction::North),
                    2
                )),
                Err(REJECT_IN_BATTLE.to_string()),
                "{label}: set_move"
            );
            assert_eq!(w.snapshot(), before, "{label}: refused before any write");

            w.chars.remove(1);
            w.chars
                .seed(&character(1, vec![MoveInput::Jump], ActionState::Idle));
            assert_eq!(
                fx.run_as_at(a(), at(T0), |ctx| clear_queue(ctx, 3)),
                Ok(()),
                "{label}: clear_queue is pure cancellation and stays open in battle"
            );
            assert!(w.character(1).move_queue.is_empty(), "{label}: cancelled");

            assert_eq!(w.battles.remove(player), 1);
            w.battles
                .seed(&battle(1, player, opponent, BattleOutcome::SideAWins));
            assert_eq!(
                fx.run_as_at(a(), at(T0), |ctx| enqueue_move(ctx, MoveInput::Jump, 4)),
                Ok(()),
                "{label}: a decided battle no longer locks intake"
            );
            assert_eq!(w.character(1).move_queue, vec![MoveInput::Jump], "{label}");

            // authorize_move's replay guard (guards.rs `seq <= last_input_seq`):
            // re-sending the ACKED seq is stale and queues nothing; the next seq
            // is admitted. Kills the `<=` -> `<` boundary mutant.
            assert_eq!(
                fx.run_as_at(a(), at(T0), |ctx| enqueue_move(ctx, MoveInput::Jump, 4)),
                Err("stale seq".to_string()),
                "{label}: the acked seq replayed"
            );
            assert_eq!(
                w.character(1).move_queue.len(),
                1,
                "{label}: nothing queued"
            );
            assert_eq!(
                fx.run_as_at(a(), at(T0), |ctx| enqueue_move(ctx, MoveInput::Jump, 5)),
                Ok(()),
                "{label}: the next seq"
            );
            assert_eq!(w.character(1).move_queue.len(), 2, "{label}");
        }
    }

    /// ADR-0168 D1 drain lock, both roles: the scheduled `movement_tick`
    /// (running as the module) SKIPS an in-battle character with its queue
    /// INTACT and its position unchanged, normalising `action` to Idle; the
    /// lock is keyed on the CHARACTER's player identity, never the module
    /// sender. Positive control: after the battle is decided the next tick
    /// drains the queued move.
    ///
    /// kills: the drain lock deleted / keyed on `ctx.sender()` (always the
    /// module, never in battle) / side-A-only / clearing the queue instead of
    /// keeping it.
    #[test]
    fn nh_movement_tick_freezes_an_in_battle_character_with_its_queue_intact() {
        let sched = || MovementTickSchedule {
            id: 1,
            zone_id: 0,
            scheduled_at: ScheduleAt::Time(at(T0)),
        };
        let module = Identity::from_byte_array(DEFAULT_DATABASE_IDENTITY);
        let queued = vec![MoveInput::Step(Direction::East), MoveInput::Jump];
        for (label, player, opponent) in
            [("side A", a(), crate::WILD_IDENTITY), ("side B", b(), a())]
        {
            let fx = fixture();
            let w = world(&fx);
            w.join(a(), 1, character(1, queued.clone(), ActionState::Walking));
            w.battles
                .seed(&battle(1, player, opponent, BattleOutcome::Ongoing));
            assert_eq!(
                fx.run_as_at(module, at(T0 + 500), |ctx| movement_tick(ctx, sched())),
                Ok(()),
                "{label}"
            );
            let frozen = w.character(1);
            assert_eq!(frozen.move_queue, queued, "{label}: queue kept intact");
            assert_eq!(
                (frozen.zone_id, frozen.tile_x, frozen.tile_y),
                (0, 1, 1),
                "{label}: no move applied"
            );
            assert_eq!(
                frozen.action,
                ActionState::Idle,
                "{label}: normalised to Idle"
            );

            assert_eq!(w.battles.remove(player), 1);
            w.battles
                .seed(&battle(1, player, opponent, BattleOutcome::SideBWins));
            assert_eq!(
                fx.run_as_at(module, at(T0 + 1000), |ctx| movement_tick(ctx, sched())),
                Ok(()),
                "{label}"
            );
            assert!(
                w.character(1).move_queue.len() < queued.len(),
                "{label}: once the battle is decided the tick drains again"
            );
        }
    }

    /// The `enqueue_move` growth tail credits Quality Time to
    /// every party monster EXCEPT one escrowed in an active trade offer, in
    /// either trade role, and never rejects the move. Positive control: the
    /// identical non-escrowed party member ticks in the same call.
    ///
    /// kills: the escrow skip deleted / initiator-role-only / counterparty-
    /// role-only / the move rejected instead of the monster skipped.
    #[test]
    fn nh_enqueue_move_growth_tail_skips_trade_escrowed_party_monsters() {
        for (label, as_initiator) in [("initiator", true), ("counterparty", false)] {
            let fx = fixture();
            let w = world(&fx);
            w.join(a(), 1, character(1, vec![], ActionState::Idle));
            w.seed_monster(&monster(11, a(), 0));
            w.seed_monster(&monster(12, a(), 1));
            let mut t = if as_initiator {
                offer(1, a(), b())
            } else {
                offer(1, b(), a())
            };
            if as_initiator {
                t.initiator_monster_ids = vec![12];
            } else {
                t.counterparty_monster_ids = vec![12];
            }
            w.offers.seed(&t);
            assert_eq!(
                fx.run_as_at(a(), at(T0 + QT_TICK_MS), |ctx| enqueue_move(
                    ctx,
                    MoveInput::Jump,
                    1
                )),
                Ok(()),
                "{label}: a pending offer never freezes the player"
            );
            assert_eq!(w.ticks(11), 11, "{label}: the free party member ticks");
            assert_eq!(w.ticks(12), 10, "{label}: the escrowed monster does not");
        }
    }

    /// ADR-0020/0066 server-authoritative warp: a PLAYER whose drained step
    /// lands on a shipped warp tile arrives Idle on the destination zone and
    /// tile with its queue cleared; an NPC (a character with no `player` row,
    /// ADR-0070 `unwrap_or(true)`) taking the same step stays on the warp tile
    /// in its home zone. The warp only fires on an actual move (a bump never
    /// warps). Uses the first shipped warp whose approach tile is walkable.
    ///
    /// kills: the warp branch deleted / `skip_warp` inverted / the moved-guard
    /// inverted (warp on bump only) / the NPC default flipped.
    #[test]
    fn nh_movement_tick_warps_a_player_but_never_an_npc() {
        let zone_maps = crate::content_cache::cached_zone_maps().expect("shipped zone maps");
        let dirs = [
            (Direction::North, Direction::South),
            (Direction::South, Direction::North),
            (Direction::East, Direction::West),
            (Direction::West, Direction::East),
        ];
        let (zone, warp, start, dir) = zone_maps
            .iter()
            .flat_map(|def| def.warps.iter().map(move |w| (def.zone_id, w.clone())))
            .find_map(|(zone, w)| {
                let map = game_core::map_for(zone, zone_maps).ok()?;
                dirs.iter().find_map(|&(dir, back)| {
                    let start = w.from.step(back);
                    (map.is_walkable(start) && map.warp_at(start).is_none()).then_some((
                        zone,
                        w.clone(),
                        start,
                        dir,
                    ))
                })
            })
            .expect("shipped content has a warp with a walkable, non-warp approach tile");
        let module = Identity::from_byte_array(DEFAULT_DATABASE_IDENTITY);
        let sched = || MovementTickSchedule {
            id: 1,
            zone_id: zone,
            scheduled_at: ScheduleAt::Time(at(T0)),
        };
        let at_start = |entity_id: u64| Character {
            zone_id: zone,
            tile_x: start.x,
            tile_y: start.y,
            ..character(
                entity_id,
                vec![MoveInput::Step(dir), MoveInput::Jump],
                ActionState::Idle,
            )
        };

        let fx = fixture();
        let w = world(&fx);
        w.join(a(), 1, at_start(1));
        w.chars.seed(&at_start(2)); // an NPC: no player row
        assert_eq!(
            fx.run_as_at(module, at(T0), |ctx| movement_tick(ctx, sched())),
            Ok(())
        );
        let player = w.character(1);
        assert_eq!(
            (player.zone_id, player.tile_x, player.tile_y),
            (warp.to_zone, warp.to_tile.x, warp.to_tile.y),
            "the player arrives on the warp's destination"
        );
        assert!(
            player.move_queue.is_empty(),
            "queued moves are cleared across the zone boundary"
        );
        assert_eq!(player.action, ActionState::Idle, "and it arrives Idle");
        let npc = w.character(2);
        assert_eq!(
            (npc.zone_id, npc.tile_x, npc.tile_y),
            (zone, warp.from.x, warp.from.y),
            "an NPC walks onto the warp tile but never leaves its home zone"
        );
    }
}
