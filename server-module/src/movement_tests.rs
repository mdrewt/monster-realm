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

    /// The M8c grass trigger: with an always-firing encounter table (rate 1000
    /// per-mille) a drained step ONTO grass opens exactly one wild battle for
    /// the walker, while the same walker's step onto plain floor opens none.
    /// Tiles are found in the shipped zone map (a walkable non-grass, non-warp
    /// start one step from a grass tile, and one from a plain floor tile).
    ///
    /// kills: the grass predicate negated (floor steps roll encounters and
    /// grass steps never do).
    #[test]
    fn nh_movement_tick_rolls_encounters_on_grass_steps_only() {
        use crate::schema::{BattleWild, EncounterEntryRow, EncounterRow, SkillRow};
        use game_core::TilePos;
        let zone = 0u32;
        let zone_maps = crate::content_cache::cached_zone_maps().expect("shipped zone maps");
        let map = game_core::map_for(zone, zone_maps).expect("zone 0 map");
        let plain = |p: TilePos| map.is_walkable(p) && !map.is_grass(p) && map.warp_at(p).is_none();
        let dirs = [
            Direction::North,
            Direction::South,
            Direction::East,
            Direction::West,
        ];
        let find = |want_grass: bool| -> (TilePos, Direction) {
            (0..map.height)
                .flat_map(|y| (0..map.width).map(move |x| TilePos { x, y }))
                .filter(|&p| plain(p))
                .find_map(|p| {
                    dirs.iter().find_map(|&d| {
                        let n = p.step(d);
                        let ok = if want_grass {
                            map.is_walkable(n) && map.is_grass(n) && map.warp_at(n).is_none()
                        } else {
                            plain(n)
                        };
                        ok.then_some((p, d))
                    })
                })
                .expect("zone 0 has the approach tile")
        };
        let module = Identity::from_byte_array(DEFAULT_DATABASE_IDENTITY);
        let sched = || MovementTickSchedule {
            id: 1,
            zone_id: zone,
            scheduled_at: ScheduleAt::Time(at(T0)),
        };
        for (label, grass, want_battles) in [("grass", true, 1usize), ("floor", false, 0)] {
            let fx = fixture();
            let w = world(&fx);
            let battles = fx
                .table_keyed::<Battle, u64>("battle", "battle_id", |r| r.battle_id)
                .writable()
                .unique()
                .auto_inc(|r| r.battle_id, |r, v| r.battle_id = v);
            let wilds = fx
                .table_keyed::<BattleWild, u64>("battle_wild", "battle_id", |r| r.battle_id)
                .writable()
                .unique();
            fx.table_keyed::<SkillRow, u32>("skill_row", "id", |r| r.id)
                .scannable()
                .seed(&SkillRow {
                    id: 1,
                    name: "s".to_string(),
                    affinity: Affinity::Fire,
                    power: 40,
                    accuracy: 100,
                    pp: 25,
                });
            fx.table_keyed::<EncounterRow, u32>("encounter", "zone_id", |r| r.zone_id)
                .seed(&EncounterRow {
                    zone_id: zone,
                    encounter_rate: 1000,
                    entries: vec![EncounterEntryRow {
                        species_id: 1,
                        weight: 1,
                        min_level: 1,
                        max_level: 100,
                    }],
                });
            let (start, dir) = find(grass);
            let ch = Character {
                zone_id: zone,
                tile_x: start.x,
                tile_y: start.y,
                ..character(1, vec![MoveInput::Step(dir)], ActionState::Idle)
            };
            w.join(a(), 1, ch);
            w.seed_monster(&monster(11, a(), 0));
            assert_eq!(
                fx.run_as_at(module, at(T0), |ctx| movement_tick(ctx, sched())),
                Ok(()),
                "{label}"
            );
            let moved = w.character(1);
            assert_eq!(
                (moved.tile_x, moved.tile_y),
                (start.step(dir).x, start.step(dir).y),
                "{label}: the step was applied"
            );
            let opened = battles.rows();
            assert_eq!(opened.len(), want_battles, "{label}: wild battles opened");
            assert_eq!(
                wilds.rows().len(),
                want_battles,
                "{label}: battle_wild rows"
            );
            if let Some(b) = opened.first() {
                assert_eq!(
                    (b.player_identity, b.opponent_identity),
                    (a(), crate::WILD_IDENTITY),
                    "{label}: the walker fights a wild"
                );
            }
        }
    }

    /// NPC wander runs on the SERVER tick counter `now / STEP_MS`, gated by the
    /// game-core cadence (QF5.2): for a run of tick times, a wandering NPC at home
    /// ends each tick exactly where `npc_step_due(NPC, tick)`, `game_core::npc_decide`
    /// (fed that counter) and `apply_move` put it — it moves iff the tick is due AND
    /// `npc_decide` answers `Some`. The sample is self-checked to contain times where
    /// `now % STEP_MS` and `now * STEP_MS` would decide differently, a due tick that
    /// moves, and a NOT-due tick where `npc_decide` alone would have moved.
    ///
    /// kills: the tick-counter division replaced by `%` or `*`; the cadence being
    /// ignored (the NPC steps on every tick `npc_decide` allows); a cadence phase
    /// that ignores the npc_id (`tick % NPC_STEP_TICKS`; NPC 901 has a non-zero
    /// residue, so the id-less phase picks different ticks).
    #[test]
    fn nh_movement_tick_npc_wander_uses_the_step_tick_counter() {
        use game_core::npc::rules::npc_step_due;
        use game_core::{Millis, STEP_MS};
        let zone = QF5_ZONE;
        let zone_maps = crate::content_cache::cached_zone_maps().expect("shipped zone maps");
        let map = game_core::map_for(zone, zone_maps).expect("zone 0 map");
        // The first zone-0 tile with four open neighbours (the shared qf5 helper).
        let (home, _) = qf5_homes();
        // 901 % NPC_STEP_TICKS == 1 (non-zero): an id-less phase picks other ticks.
        const NPC: u64 = 901;
        const RADIUS: u8 = QF5_RADIUS;
        let start = || Character {
            zone_id: zone,
            tile_x: home.x,
            tile_y: home.y,
            ..character(NPC, vec![], ActionState::Idle)
        };
        let decide =
            |tick: u64| game_core::npc_decide(home, home, RADIUS, start().facing, NPC, tick, &map);
        let step = STEP_MS.unsigned_abs();
        let nows: Vec<i64> = (0..40).map(|k| T0 + k * 200 + 37).collect();
        let tick = |now: i64| now.unsigned_abs() / step;
        // What the cadence-gated tick decides: only a due tick consults `npc_decide`.
        let gated = |t: u64| {
            if npc_step_due(NPC, t) {
                decide(t)
            } else {
                None
            }
        };
        assert!(
            nows.iter()
                .any(|&n| gated(tick(n)) != gated(n.unsigned_abs() % step)),
            "the sample must discriminate `/` from `%`"
        );
        assert!(
            nows.iter()
                .any(|&n| gated(tick(n)) != gated(n.unsigned_abs().wrapping_mul(step))),
            "the sample must discriminate `/` from `*`"
        );
        assert!(
            nows.iter()
                .any(|&n| npc_step_due(NPC, tick(n)) && decide(tick(n)).is_some()),
            "the sample must contain a DUE tick where the NPC moves"
        );
        assert!(
            nows.iter()
                .any(|&n| !npc_step_due(NPC, tick(n)) && decide(tick(n)).is_some()),
            "the sample must contain a NOT-due tick where npc_decide alone would move (the cadence has teeth)"
        );
        let module = Identity::from_byte_array(DEFAULT_DATABASE_IDENTITY);
        let sched = || MovementTickSchedule {
            id: 1,
            zone_id: zone,
            scheduled_at: ScheduleAt::Time(at(T0)),
        };
        for now in nows {
            let fx = fixture();
            // `qf5_world` registers `npc` (both indexes) and a scannable
            // `player_conversation` (QF5.1); no conversation rows are seeded here.
            let q = qf5_world(&fx);
            q.npcs.seed(&qf5_npc_row(NPC, home));
            q.w.chars.seed(&start());
            assert_eq!(
                fx.run_as_at(module, at(now), |ctx| movement_tick(ctx, sched())),
                Ok(())
            );
            let mut want = start();
            if let Some(d) = gated(tick(now)) {
                let next = game_core::apply_move(
                    &crate::marshal::char_state(&start()),
                    MoveInput::Step(d),
                    &map,
                    Millis(now),
                );
                crate::marshal::apply_state(&mut want, &next);
            }
            let got = q.w.character(NPC);
            assert_eq!(
                (got.tile_x, got.tile_y, got.facing),
                (want.tile_x, want.tile_y, want.facing),
                "NPC position after the tick at {now}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // qf-5 (QF5.1 conversation pin, QF5.2 wander cadence, QF5.3 multi-tick walk)
    //
    // EARS criteria covered below:
    //   QF5.1  WHILE a `player_conversation` row references an NPC's entity id AND
    //          its owner is a joined player (a `player` row with a `character`) in
    //          the NPC's zone within `TALK_RANGE` (Manhattan 2) of the NPC,
    //          `movement_tick` SHALL NOT move that NPC (position AND facing kept);
    //          a row whose owner left (out of range, another zone, no player row, no
    //          character) does not pin; an NPC no active row references still wanders.
    //   QF5.2  `movement_tick` SHALL step an NPC only on the ticks where the
    //          game-core rule `npc_step_due(entity_id, now / STEP_MS)` holds, and
    //          SHALL consume that rule rather than re-derive it.
    //   QF5.3  Over many consecutive ticks an NPC SHALL stay in its home zone,
    //          within its wander radius, moving at most one tile per tick.
    // -----------------------------------------------------------------------

    const QF5_ZONE: u32 = 0;
    const QF5_RADIUS: u8 = 2;

    /// The `npc` role row for NPC `entity_id` wandering around `home` in zone 0.
    fn qf5_npc_row(entity_id: u64, home: game_core::TilePos) -> crate::schema::Npc {
        crate::schema::Npc {
            entity_id,
            npc_id: format!("qf5-{entity_id}"),
            zone_id: QF5_ZONE,
            home_x: home.x,
            home_y: home.y,
            wander_radius: QF5_RADIUS,
            dialogue_tree_id: String::new(),
            interaction: game_core::NpcInteraction::Dialogue,
        }
    }

    /// A live dialogue: `owner_byte` identifies the talking player.
    fn qf5_conversation(owner_byte: u8, npc_entity_id: u64) -> crate::schema::PlayerConversation {
        crate::schema::PlayerConversation {
            owner_identity: Identity::from_byte_array([owner_byte; 32]),
            npc_entity_id,
            current_node_id: "greeting".to_string(),
        }
    }

    /// The NPC's `character` row, idle at `p` facing South (the `character()` default).
    fn qf5_char(entity_id: u64, p: game_core::TilePos) -> Character {
        Character {
            zone_id: QF5_ZONE,
            tile_x: p.x,
            tile_y: p.y,
            ..character(entity_id, vec![], ActionState::Idle)
        }
    }

    fn qf5_pos(c: &Character) -> (i32, i32, Direction) {
        (c.tile_x, c.tile_y, c.facing)
    }

    /// Every table the NPC wander block reads: the movement world plus `npc` (both
    /// indexes) and a SCANNABLE `player_conversation` (the pin's full-table scan).
    struct Qf5<'a> {
        w: World<'a>,
        npcs: Handle<'a, crate::schema::Npc, u64>,
        conv: Handle<'a, crate::schema::PlayerConversation>,
    }

    fn qf5_world(fx: &Fixture) -> Qf5<'_> {
        let w = world(fx);
        let npcs = fx.table_keyed::<crate::schema::Npc, u64>("npc", "entity_id", |r| r.entity_id);
        let _ = fx.table_keyed::<crate::schema::Npc, u32>("npc", "zone_id", |r| r.zone_id);
        let conv = fx
            .table::<crate::schema::PlayerConversation>(
                "player_conversation",
                "owner_identity",
                |r| r.owner_identity,
            )
            .scannable();
        Qf5 { w, npcs, conv }
    }

    /// Two distinct shipped zone-0 homes: the first has four open neighbours, the
    /// second is the farthest other tile with at least three.
    fn qf5_homes() -> (game_core::TilePos, game_core::TilePos) {
        let zone_maps = crate::content_cache::cached_zone_maps().expect("shipped zone maps");
        let map = game_core::map_for(QF5_ZONE, zone_maps).expect("zone 0 map");
        let dirs = [
            Direction::North,
            Direction::South,
            Direction::East,
            Direction::West,
        ];
        let open = |p: game_core::TilePos| map.is_walkable(p) && map.warp_at(p).is_none();
        let open_neighbours =
            |p: game_core::TilePos| dirs.iter().filter(|&&d| open(p.step(d))).count();
        let tiles: Vec<game_core::TilePos> = (0..map.height)
            .flat_map(|y| (0..map.width).map(move |x| game_core::TilePos { x, y }))
            .collect();
        let first = tiles
            .iter()
            .copied()
            .find(|&p| open(p) && open_neighbours(p) == 4)
            .expect("zone 0 has an open tile with four open neighbours");
        let second = tiles
            .iter()
            .copied()
            .filter(|&p| p != first && open(p) && open_neighbours(p) >= 3)
            .max_by_key(|&p| {
                (i64::from(p.x) - i64::from(first.x)).abs()
                    + (i64::from(p.y) - i64::from(first.y)).abs()
            })
            .expect("zone 0 has a second open tile with three open neighbours");
        (first, second)
    }

    /// The server's tick counter for a scheduler timestamp.
    fn qf5_tick_of(now: i64) -> u64 {
        now.unsigned_abs() / game_core::STEP_MS.unsigned_abs()
    }

    /// The game-core cadence rule, fed the server's tick counter.
    fn qf5_due(npc: u64, now: i64) -> bool {
        game_core::npc::rules::npc_step_due(npc, qf5_tick_of(now))
    }

    /// `npc_decide` alone (no cadence), fed the server's tick counter.
    fn qf5_decision(
        from: game_core::TilePos,
        facing: Direction,
        npc: u64,
        home: game_core::TilePos,
        now: i64,
    ) -> Option<Direction> {
        let zone_maps = crate::content_cache::cached_zone_maps().expect("shipped zone maps");
        let map = game_core::map_for(QF5_ZONE, zone_maps).expect("zone 0 map");
        game_core::npc_decide(from, home, QF5_RADIUS, facing, npc, qf5_tick_of(now), &map)
    }

    /// Where the cadence-gated rule leaves an idle NPC standing at `from` facing
    /// `facing`: unchanged unless the tick is due AND `npc_decide` answers `Some`.
    fn qf5_expected(
        from: game_core::TilePos,
        facing: Direction,
        npc: u64,
        home: game_core::TilePos,
        now: i64,
    ) -> (i32, i32, Direction) {
        let mut want = Character {
            facing,
            ..qf5_char(npc, from)
        };
        if qf5_due(npc, now) {
            if let Some(d) = qf5_decision(from, facing, npc, home, now) {
                let zone_maps =
                    crate::content_cache::cached_zone_maps().expect("shipped zone maps");
                let map = game_core::map_for(QF5_ZONE, zone_maps).expect("zone 0 map");
                let next = game_core::apply_move(
                    &crate::marshal::char_state(&want),
                    MoveInput::Step(d),
                    &map,
                    game_core::Millis(now),
                );
                crate::marshal::apply_state(&mut want, &next);
            }
        }
        qf5_pos(&want)
    }

    /// One shipped `movement_tick` for zone 0 at `now`, as the scheduler module.
    fn qf5_tick(fx: &Fixture, now: i64) {
        let module = Identity::from_byte_array(DEFAULT_DATABASE_IDENTITY);
        let sched = MovementTickSchedule {
            id: 1,
            zone_id: QF5_ZONE,
            scheduled_at: ScheduleAt::Time(at(T0)),
        };
        assert_eq!(
            fx.run_as_at(module, at(now), |ctx| movement_tick(ctx, sched)),
            Ok(())
        );
    }

    /// How the owner of a `player_conversation` row stands in the world. An owner
    /// that is simply ABSENT from a fixture's owner list has no `player` row at all.
    #[derive(Clone, Copy)]
    enum Qf5Owner {
        /// A joined player (`player` + `character` rows, empty move queue) standing
        /// in `zone_id` on the tile.
        Joined(u32, game_core::TilePos),
        /// A `player` row whose `entity_id` has NO `character` row.
        PlayerWithoutCharacter,
    }

    /// One arm of the owner-left test: (label, the owners seeded as `(owner byte,
    /// standing)`, whether the NPC is expected to stay pinned).
    type Qf5Arm = (&'static str, Vec<(u8, Qf5Owner)>, bool);

    /// The character entity id of the player whose identity is `[owner_byte; 32]`.
    fn qf5_owner_entity(owner_byte: u8) -> u64 {
        5_000 + u64::from(owner_byte)
    }

    /// The first shipped zone-0 tile (row-major) that is walkable, carries no warp
    /// and sits at Manhattan distance EXACTLY `dist` from `home`.
    fn qf5_tile_near(home: game_core::TilePos, dist: i64) -> game_core::TilePos {
        let zone_maps = crate::content_cache::cached_zone_maps().expect("shipped zone maps");
        let map = game_core::map_for(QF5_ZONE, zone_maps).expect("zone 0 map");
        (0..map.height)
            .flat_map(|y| (0..map.width).map(move |x| game_core::TilePos { x, y }))
            .find(|&p| {
                map.is_walkable(p)
                    && map.warp_at(p).is_none()
                    && (i64::from(p.x) - i64::from(home.x)).abs()
                        + (i64::from(p.y) - i64::from(home.y)).abs()
                        == dist
            })
            .expect("zone 0 has an open, warp-free tile at that distance from home")
    }

    /// A fresh fixture holding NPCs (id, home) at home facing South, the
    /// conversation rows (owner byte, npc entity id, seeded in the given order) and
    /// the owners' world state (owner byte, standing); runs ONE tick at `now` and
    /// returns each NPC's (tile_x, tile_y, facing) afterwards, in input order.
    /// Owner characters have an empty queue, so they never move or roll encounters.
    fn qf5_one_tick(
        npcs: &[(u64, game_core::TilePos)],
        convs: &[(u8, u64)],
        owners: &[(u8, Qf5Owner)],
        now: i64,
    ) -> Vec<(i32, i32, Direction)> {
        let fx = fixture();
        let q = qf5_world(&fx);
        for &(id, home) in npcs {
            q.npcs.seed(&qf5_npc_row(id, home));
            q.w.chars.seed(&qf5_char(id, home));
        }
        for &(owner_byte, standing) in owners {
            let who = Identity::from_byte_array([owner_byte; 32]);
            let entity_id = qf5_owner_entity(owner_byte);
            match standing {
                Qf5Owner::Joined(zone_id, at_tile) => q.w.join(
                    who,
                    entity_id,
                    Character {
                        zone_id,
                        tile_x: at_tile.x,
                        tile_y: at_tile.y,
                        ..character(entity_id, vec![], ActionState::Idle)
                    },
                ),
                Qf5Owner::PlayerWithoutCharacter => q.w.players.seed(&Player {
                    identity: who,
                    entity_id,
                    name: String::new(),
                    online: true,
                    last_input_seq: 0,
                }),
            }
        }
        for &(owner, npc) in convs {
            q.conv.seed(&qf5_conversation(owner, npc));
        }
        qf5_tick(&fx, now);
        let out: Vec<(i32, i32, Direction)> = npcs
            .iter()
            .map(|&(id, _)| qf5_pos(&q.w.character(id)))
            .collect();
        out
    }

    /// **QF5.1** — an NPC a live conversation references never moves (position
    /// AND facing), on due ticks where it would otherwise step, while the
    /// conversation's owner is a joined player in the NPC's zone within talk
    /// range (here one tile away). Control: the identical fixture (owner present)
    /// WITHOUT the conversation row steps exactly where the cadence-gated rule says.
    ///
    /// kills: the pin deleted; the pin keyed on the wrong column (owner / node id /
    /// a different NPC id); `||` -> `&&` in the skip predicate (pin only on
    /// non-due ticks); the scan filtering the wrong table or reading `.next()` of
    /// an unrelated row; a pin that also freezes unreferenced NPCs (control arm
    /// still moves); an active-owner check so strict it drops an in-range owner (a
    /// wrong-column player lookup, a wrong-entity character lookup, a zone or range
    /// comparison that rejects the owner standing one tile from the NPC). The sample
    /// is self-checked to hold a due tick with `npc_decide` = Some, so none of those
    /// can hide behind a no-op tick.
    #[test]
    fn nh_qf5_1_npc_in_conversation_never_moves() {
        // 901 % NPC_STEP_TICKS == 1: non-zero residue. The id is reused by sibling
        // tests, but every fixture here is fresh (`fixture()` wipes the store).
        const NPC: u64 = 901;
        const OWNER: u8 = 0xC3;
        let (home, _) = qf5_homes();
        let owners = [(OWNER, Qf5Owner::Joined(QF5_ZONE, qf5_tile_near(home, 1)))];
        let start = qf5_char(NPC, home);
        let start_pos = qf5_pos(&start);
        let nows: Vec<i64> = (0..40).map(|k| T0 + k * 200 + 37).collect();
        assert!(
            nows.iter()
                .any(|&n| qf5_due(NPC, n)
                    && qf5_decision(home, start.facing, NPC, home, n).is_some()),
            "the sample must contain a DUE tick where npc_decide moves the NPC"
        );
        let mut control_moves = 0usize;
        for &now in &nows {
            let pinned = qf5_one_tick(&[(NPC, home)], &[(OWNER, NPC)], &owners, now);
            assert_eq!(
                pinned[0], start_pos,
                "NPC {NPC} is in a conversation: position and facing must not change (tick at {now})"
            );
            let control = qf5_one_tick(&[(NPC, home)], &[], &owners, now);
            assert_eq!(
                control[0],
                qf5_expected(home, start.facing, NPC, home, now),
                "control (no conversation row): the NPC wanders per the cadence rule (tick at {now})"
            );
            if control[0] != start_pos {
                control_moves += 1;
            }
        }
        assert!(
            control_moves > 0,
            "the control arm must actually move on some due tick, else the pin proves nothing"
        );
    }

    /// **QF5.1** — the pin is per-NPC and survives ANY row position: four
    /// conversation rows (owner bytes order the primary key, and the seeds go in
    /// that order) reference, in scan order, pinned NPC 901, the non-NPC id 777, the
    /// non-NPC id 778, and pinned NPC 903 LAST. Both pinned NPCs (owners joined in
    /// range, same zone) never move on a due tick where they would otherwise
    /// step, while the unreferenced NPC 902 still ends every tick exactly where
    /// `npc_step_due` + `npc_decide` + `apply_move` put it.
    ///
    /// kills: a pin that freezes every NPC in the zone whenever any conversation
    /// row exists (`!is_empty()`); a pin keyed on the owner / node instead of
    /// `npc_entity_id`; a scan that looks at only a prefix of the rows
    /// (`.take(1)` / `.take(2)` / `.take(3)` never sees the LAST row's NPC 903),
    /// that drops the first row (`.skip(1)` leaves NPC 901 unpinned) or that keeps
    /// only the last (`.last()` leaves NPC 901 unpinned); a pin keyed on only the
    /// FIRST row (`.next()`); a skip that `break`s the loop instead of
    /// `continue`ing past a pinned NPC (the NPCs after it would go unvisited).
    #[test]
    fn nh_qf5_1_conversation_pins_only_the_referenced_npc() {
        const PINNED_FIRST: u64 = 901; // 901 % 5 == 1
        const FREE: u64 = 902; // 902 % 5 == 2
        const PINNED_LAST: u64 = 903; // 903 % 5 == 3
        const OWNER_FIRST: u8 = 0x01;
        const OWNER_LAST: u8 = 0xFE;
        let (home_first, home_last) = qf5_homes();
        assert_ne!(home_first, home_last, "the pinned NPCs need distinct homes");
        let nows: Vec<i64> = (0..40).map(|k| T0 + k * 200 + 37).collect();
        for (npc, home) in [(PINNED_FIRST, home_first), (PINNED_LAST, home_last)] {
            assert!(
                nows.iter().any(|&n| qf5_due(npc, n)
                    && qf5_decision(home, Direction::South, npc, home, n).is_some()),
                "the sample must contain a due tick where pinned NPC {npc} would otherwise move"
            );
        }
        assert!(
            nows.iter().any(|&n| qf5_due(FREE, n)
                && qf5_decision(home_first, Direction::South, FREE, home_first, n).is_some()),
            "the sample must contain a due tick where the unpinned NPC moves"
        );
        let owners = [
            (
                OWNER_FIRST,
                Qf5Owner::Joined(QF5_ZONE, qf5_tile_near(home_first, 1)),
            ),
            (
                OWNER_LAST,
                Qf5Owner::Joined(QF5_ZONE, qf5_tile_near(home_last, 1)),
            ),
        ];
        // Ascending owner-byte order: first and last row are the two real pins.
        let convs = [
            (OWNER_FIRST, PINNED_FIRST),
            (0x02, 777),
            (0x03, 778),
            (OWNER_LAST, PINNED_LAST),
        ];
        let first_start = qf5_pos(&qf5_char(PINNED_FIRST, home_first));
        let last_start = qf5_pos(&qf5_char(PINNED_LAST, home_last));
        let free_start = qf5_pos(&qf5_char(FREE, home_first));
        let mut free_moves = 0usize;
        for &now in &nows {
            let got = qf5_one_tick(
                &[
                    (PINNED_FIRST, home_first),
                    (FREE, home_first),
                    (PINNED_LAST, home_last),
                ],
                &convs,
                &owners,
                now,
            );
            assert_eq!(
                got[0], first_start,
                "NPC {PINNED_FIRST} is referenced by the FIRST row and must not move (tick at {now})"
            );
            assert_eq!(
                got[2], last_start,
                "NPC {PINNED_LAST} is referenced by the LAST row and must not move (tick at {now})"
            );
            assert_eq!(
                got[1],
                qf5_expected(home_first, free_start.2, FREE, home_first, now),
                "NPC {FREE} is unreferenced and must wander per the cadence rule (tick at {now})"
            );
            if got[1] != free_start {
                free_moves += 1;
            }
        }
        assert!(
            free_moves > 0,
            "the unpinned NPC must actually move on some tick"
        );
    }

    /// **QF5.1** — a conversation row pins its NPC only while its owner is still
    /// there (a joined player in the NPC's zone within `TALK_RANGE` = Manhattan 2):
    /// an idle client that talks then walks away, changes zone, or never had a
    /// player row cannot freeze an NPC for everyone. Five arms, each in a fresh
    /// fixture per tick of a sample that is self-checked to contain a due tick where
    /// `npc_decide` answers `Some`: (a) owner joined in the same zone at Manhattan 3,
    /// (b) owner joined at Manhattan 1 by tiles but in a DIFFERENT `zone_id`, (c) no
    /// `player` row at all, (d) a `player` row whose character row is missing: in all
    /// four the NPC wanders exactly per the cadence-gated rule (and does move on some
    /// tick); (e) control: owner at Manhattan exactly 2 (the inclusive boundary) is
    /// still pinned.
    ///
    /// kills: a scan that pins on any row regardless of its owner (a, b, c, d all
    /// freeze the NPC); one that checks only that a `player` row exists (a, b, d);
    /// one that ignores the zone (b); one that checks range but not that the
    /// character exists (d); a range of 1 or an exclusive `< 2` boundary (e fails);
    /// a range of 3 or more (a fails).
    #[test]
    fn nh_qf5_1_conversation_whose_owner_left_does_not_pin() {
        const NPC: u64 = 901;
        const OWNER: u8 = 0xC3;
        let (home, _) = qf5_homes();
        let start = qf5_char(NPC, home);
        let start_pos = qf5_pos(&start);
        let nows: Vec<i64> = (0..40).map(|k| T0 + k * 200 + 37).collect();
        assert!(
            nows.iter()
                .any(|&n| qf5_due(NPC, n)
                    && qf5_decision(home, start.facing, NPC, home, n).is_some()),
            "the sample must contain a DUE tick where npc_decide moves the NPC"
        );
        let arms: [Qf5Arm; 5] = [
            (
                "owner 3 tiles away in the same zone",
                vec![(OWNER, Qf5Owner::Joined(QF5_ZONE, qf5_tile_near(home, 3)))],
                false,
            ),
            (
                "owner in range by tiles but in another zone",
                vec![(
                    OWNER,
                    Qf5Owner::Joined(QF5_ZONE + 1, qf5_tile_near(home, 1)),
                )],
                false,
            ),
            ("owner has no player row", vec![], false),
            (
                "owner has a player row but no character row",
                vec![(OWNER, Qf5Owner::PlayerWithoutCharacter)],
                false,
            ),
            (
                "control: owner exactly 2 tiles away (the inclusive boundary)",
                vec![(OWNER, Qf5Owner::Joined(QF5_ZONE, qf5_tile_near(home, 2)))],
                true,
            ),
        ];
        for (label, owners, pinned) in &arms {
            let mut moves = 0usize;
            for &now in &nows {
                let got = qf5_one_tick(&[(NPC, home)], &[(OWNER, NPC)], owners, now);
                let want = if *pinned {
                    start_pos
                } else {
                    qf5_expected(home, start.facing, NPC, home, now)
                };
                assert_eq!(
                    got[0], want,
                    "{label}: NPC {NPC} after the tick at {now} (pinned = {pinned})"
                );
                if got[0] != start_pos {
                    moves += 1;
                }
            }
            if *pinned {
                assert_eq!(moves, 0, "{label}: a pinned NPC never moves");
            } else {
                assert!(
                    moves > 0,
                    "{label}: the NPC must actually wander on some tick, else the arm proves nothing"
                );
            }
        }
    }

    /// **QF5.3** — a single NPC on the shipped zone-0 map over many CONSECUTIVE
    /// ticks in ONE fixture (state carried tick to tick, as the live scheduler
    /// does): its `zone_id` never changes, it moves at most one tile per tick,
    /// stays within its wander radius, moves only on due ticks, matches the
    /// cadence-gated rule tick by tick, and does move.
    ///
    /// kills: an NPC leaving its home zone; a multi-tile step; a radius escape; a
    /// move on a non-due tick (cadence not consumed); a pin that freezes an
    /// un-referenced NPC for good (moves == 0); a drifting fixture state (the
    /// per-tick comparison starts from the STORED row, not a replayed model).
    #[test]
    fn nh_qf5_3_npc_multi_tick_walk_stays_home_zone_within_radius() {
        const NPC: u64 = 902; // 902 % 5 == 2
        let (home, _) = qf5_homes();
        let fx = fixture();
        let q = qf5_world(&fx);
        q.npcs.seed(&qf5_npc_row(NPC, home));
        q.w.chars.seed(&qf5_char(NPC, home));
        let manhattan = |ax: i32, ay: i32, bx: i32, by: i32| {
            (i64::from(ax) - i64::from(bx)).abs() + (i64::from(ay) - i64::from(by)).abs()
        };
        let mut moves = 0usize;
        let mut due_ticks = 0usize;
        for k in 0..90i64 {
            let now = T0 + k * 200 + 37;
            let before = q.w.character(NPC);
            qf5_tick(&fx, now);
            let after = q.w.character(NPC);
            assert_eq!(
                after.zone_id, QF5_ZONE,
                "tick {k}: an NPC stays in its home zone"
            );
            assert!(
                manhattan(before.tile_x, before.tile_y, after.tile_x, after.tile_y) <= 1,
                "tick {k}: moved {:?} -> {:?}, at most one tile per tick",
                (before.tile_x, before.tile_y),
                (after.tile_x, after.tile_y)
            );
            assert!(
                manhattan(after.tile_x, after.tile_y, home.x, home.y) <= i64::from(QF5_RADIUS),
                "tick {k}: {:?} left wander radius {QF5_RADIUS} around {home:?}",
                (after.tile_x, after.tile_y)
            );
            let due = qf5_due(NPC, now);
            if due {
                due_ticks += 1;
            }
            let moved = (before.tile_x, before.tile_y) != (after.tile_x, after.tile_y);
            if moved {
                moves += 1;
                assert!(due, "tick {k}: the NPC moved on a NOT-due tick");
            }
            if !due {
                assert_eq!(
                    qf5_pos(&after),
                    qf5_pos(&before),
                    "tick {k}: a not-due tick leaves position and facing untouched"
                );
            }
            assert_eq!(
                qf5_pos(&after),
                qf5_expected(
                    game_core::TilePos {
                        x: before.tile_x,
                        y: before.tile_y
                    },
                    before.facing,
                    NPC,
                    home,
                    now
                ),
                "tick {k}: the stored row follows the cadence-gated rule"
            );
        }
        assert_eq!(
            due_ticks, 18,
            "90 consecutive ticks hold exactly 18 due ticks"
        );
        assert!(
            moves >= 5,
            "the NPC must actually wander over 18 due ticks (lower bound); moved {moves} times"
        );
    }

    /// Code-only view of a Rust source: comments (line, nested block) and the
    /// CONTENT of string / raw-string / char literals are removed and all
    /// whitespace is squashed, so a needle matches only executable tokens and a
    /// decoy in a comment or a string cannot forge or hide one.
    fn qf5_code_view(src: &str) -> String {
        let b: Vec<char> = src.chars().collect();
        let n = b.len();
        let mut out = String::new();
        let mut i = 0usize;
        while i < n {
            let c = b[i];
            let next = b.get(i + 1).copied();
            if c == '/' && next == Some('/') {
                while i < n && b[i] != '\n' {
                    i += 1;
                }
            } else if c == '/' && next == Some('*') {
                let mut depth = 1usize;
                i += 2;
                while i < n && depth > 0 {
                    if b[i] == '/' && b.get(i + 1) == Some(&'*') {
                        depth += 1;
                        i += 2;
                    } else if b[i] == '*' && b.get(i + 1) == Some(&'/') {
                        depth -= 1;
                        i += 2;
                    } else {
                        i += 1;
                    }
                }
            } else if c == 'r' && (i == 0 || !(b[i - 1].is_alphanumeric() || b[i - 1] == '_')) && {
                let mut j = i + 1;
                while j < n && b[j] == '#' {
                    j += 1;
                }
                j < n && b[j] == '"'
            } {
                let mut hashes = 0usize;
                let mut j = i + 1;
                while b[j] == '#' {
                    hashes += 1;
                    j += 1;
                }
                j += 1; // opening quote
                loop {
                    if j >= n {
                        break;
                    }
                    if b[j] == '"' && (0..hashes).all(|h| b.get(j + 1 + h) == Some(&'#')) {
                        j += 1 + hashes;
                        break;
                    }
                    j += 1;
                }
                out.push_str("\"\"");
                i = j;
            } else if c == '"' {
                i += 1;
                while i < n && b[i] != '"' {
                    if b[i] == '\\' {
                        i += 1;
                    }
                    i += 1;
                }
                i += 1;
                out.push_str("\"\"");
            } else if c == '\'' {
                if next == Some('\\') {
                    let mut j = i + 3;
                    while j < n && b[j] != '\'' {
                        j += 1;
                    }
                    i = j + 1;
                    out.push_str("''");
                } else if b.get(i + 2) == Some(&'\'') {
                    i += 3;
                    out.push_str("''");
                } else {
                    out.push(c); // a lifetime tick
                    i += 1;
                }
            } else {
                if !c.is_whitespace() {
                    out.push(c);
                }
                i += 1;
            }
        }
        out
    }

    /// **QF5.2** — `movement.rs` CONSUMES the game-core cadence rule: exactly one
    /// `npc_step_due(` call, positioned inside the NPC wander loop (after its
    /// `for entity_id in npc_entity_ids` header) and BEFORE the `npc_decide(` call
    /// it gates; and the server does not re-derive the rule (no `NPC_STEP_TICKS`
    /// token, no `% 5`, no `is_multiple_of(5` / `rem_euclid(5`). The behavioural
    /// tests above prove the effect; this pins that the rule has ONE home.
    ///
    /// kills: a server-side copy of the modulus (`tick % 5`), a second cadence
    /// call site, the gate placed after `npc_decide` (decide runs on non-due
    /// ticks), the gate placed outside / above the loop, and the constant being
    /// re-imported to build a local rule; a server-side re-derivation of the talk
    /// range (a `TALK_RANGE` token, or no / a second `in_talk_range(` call site).
    /// Comments and string literals are
    /// stripped first so a decoy there neither satisfies nor trips a needle.
    #[test]
    fn nh_qf5_2_movement_rs_consumes_the_game_core_cadence_rule() {
        let code = qf5_code_view(include_str!("movement.rs"));
        assert_eq!(
            code.matches("npc_step_due(").count(),
            1,
            "movement.rs must call game_core's npc_step_due exactly once"
        );
        let loop_at = code
            .find("forentity_idinnpc_entity_ids")
            .expect("the NPC wander loop header `for entity_id in npc_entity_ids`");
        let due_at = code.find("npc_step_due(").expect("the cadence call");
        let decide_at = code.find("npc_decide(").expect("the npc_decide call");
        assert!(
            loop_at < due_at,
            "npc_step_due( ({due_at}) must appear after the wander loop header ({loop_at})"
        );
        assert!(
            due_at < decide_at,
            "npc_step_due( ({due_at}) must gate, i.e. appear BEFORE, npc_decide( ({decide_at})"
        );
        assert!(
            !code.contains("NPC_STEP_TICKS"),
            "movement.rs must not name NPC_STEP_TICKS: the cadence lives in game-core"
        );
        assert!(
            !code.contains("is_multiple_of(5") && !code.contains("rem_euclid(5"),
            "movement.rs must not re-derive the cadence modulus"
        );
        assert!(
            !code.contains("TALK_RANGE"),
            "movement.rs must not name TALK_RANGE: the range rule lives in game-core's in_talk_range"
        );
        assert_eq!(
            code.matches("in_talk_range(").count(),
            1,
            "movement.rs must call game_core's in_talk_range exactly once"
        );
        let bytes = code.as_bytes();
        for (idx, _) in code.match_indices("%5") {
            let continues_number = bytes
                .get(idx + 2)
                .is_some_and(|&d| d.is_ascii_digit() || d == b'_');
            assert!(
                continues_number,
                "movement.rs must not contain a `% 5` cadence modulus (at squashed offset {idx})"
            );
        }
    }
}
