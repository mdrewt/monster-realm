//! sr-9b.2 gating tests for `load_dev.rs` (spec M-scale-readiness §sr-9b).
//!
//! `dev_place_in_load_zone` exists only under the `load_test_zones` feature, so every item of
//! this file sits in ONE `#[cfg(feature = "load_test_zones")]` module (the `dev_clock_tests.rs`
//! shape): the default build compiles the file as an empty module. Run with
//! `cargo nextest run -p monster-realm-module --features load_test_zones -E 'test(/sr9b_2/)'`.
//!
//! The SHIPPED reducer runs in the native host (`Fixture::run_as_at`: a real sender and an
//! injected clock). The host has no rollback, so a refusal is proved by a whole-world snapshot
//! (player, character, move_intent, movement_tick_schedule) AND zero write calls on those
//! tables, plus exactly one structured reject line. The reject-log sink is process-wide (one
//! `log::set_logger` per process): NEXTEST-ONLY, like `dev_clock_tests.rs`'s.
//!
//! Every joined player is seeded mid-walk on purpose — a non-empty private queue, a stale
//! published queue, `acked_seq != last_input_seq`, a non-default facing and `Walking` — so a
//! placement that forgets any one of its writes leaves a visible difference.

#[cfg(feature = "load_test_zones")]
mod nh {
    use crate::guards::REJECT_DELETION_GATED;
    use crate::movement::{enqueue_move, movement_tick, MovementTickSchedule};
    use crate::native_host_tests::{fixture, Fixture, Handle, DEFAULT_DATABASE_IDENTITY};
    use crate::schema::{Account, Battle, Character, MoveIntent, Player};
    use game_core::{ActionState, Affinity, BattleOutcome, Direction, MoveInput, STEP_MS};
    use spacetimedb::sats::bsatn::to_vec;
    use spacetimedb::{Identity, ScheduleAt, Timestamp};

    const NOT_A_LOAD_ZONE: &str = "zone is not a load zone";
    const NO_CHARACTER: &str = "caller has no character";
    const IN_BATTLE: &str = "cannot move during an ongoing battle";

    const T0: i64 = 1_750_000_000_000;
    /// The time of the call under test: never a value any seeded row carries.
    const T1: i64 = T0 + 4_321;

    const A_ENTITY: u64 = 1;
    const B_ENTITY: u64 = 2;

    fn a() -> Identity {
        Identity::from_byte_array([0xA1; 32])
    }
    fn b() -> Identity {
        Identity::from_byte_array([0xB2; 32])
    }
    /// An identity with no `player` row.
    fn c() -> Identity {
        Identity::from_byte_array([0xC3; 32])
    }
    fn at(ms: i64) -> Timestamp {
        Timestamp::from_micros_since_unix_epoch(ms * 1000)
    }

    // -----------------------------------------------------------------------
    // Rows
    // -----------------------------------------------------------------------

    /// A's character: zone 0 at (5, 3), facing East, walking, a stale published queue.
    fn a_character() -> Character {
        Character {
            entity_id: A_ENTITY,
            zone_id: 0,
            tile_x: 5,
            tile_y: 3,
            facing: Direction::East,
            action: ActionState::Walking,
            move_started_at_ms: 123,
            sprite_id: 7,
            move_queue: vec![MoveInput::Step(Direction::North)],
            acked_seq: 5,
        }
    }

    /// A's private intent: three queued inputs, seq guard 9 (ahead of the published 5).
    fn a_intent() -> MoveIntent {
        MoveIntent {
            entity_id: A_ENTITY,
            queue: vec![
                MoveInput::Step(Direction::East),
                MoveInput::Jump,
                MoveInput::Face(Direction::West),
            ],
            last_input_seq: 9,
        }
    }

    /// B's character: zone 0 at (7, 4), facing West, jumping, a stale published queue.
    fn b_character() -> Character {
        Character {
            entity_id: B_ENTITY,
            zone_id: 0,
            tile_x: 7,
            tile_y: 4,
            facing: Direction::West,
            action: ActionState::Jumping,
            move_started_at_ms: 456,
            sprite_id: 3,
            move_queue: vec![MoveInput::Jump],
            acked_seq: 2,
        }
    }

    /// B's private intent: two queued steps, seq guard 4.
    fn b_intent() -> MoveIntent {
        MoveIntent {
            entity_id: B_ENTITY,
            queue: vec![
                MoveInput::Step(Direction::South),
                MoveInput::Step(Direction::South),
            ],
            last_input_seq: 4,
        }
    }

    fn player(who: Identity, entity_id: u64) -> Player {
        Player {
            identity: who,
            entity_id,
            name: format!("p{entity_id}"),
            online: true,
            last_input_seq: 0,
            discriminator: 0,
            lead_level: 0,
        }
    }

    /// A schedule row as `arm_zone_tick` writes it, with a chosen id.
    fn tick_row(id: u64, zone_id: u32) -> MovementTickSchedule {
        MovementTickSchedule {
            id,
            zone_id,
            scheduled_at: interval(),
        }
    }

    /// The `STEP_MS` interval every armed zone ticks at.
    fn interval() -> ScheduleAt {
        ScheduleAt::Interval(std::time::Duration::from_millis(STEP_MS.unsigned_abs()).into())
    }

    /// A one-monster-per-side battle with `outcome` (the `movement_tests` fixture).
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

    /// Every column of a character row, comparable with a readable diff.
    type Cols = (
        u64,
        u32,
        i32,
        i32,
        Direction,
        ActionState,
        i64,
        u32,
        Vec<MoveInput>,
        u64,
    );

    fn cols(c: &Character) -> Cols {
        (
            c.entity_id,
            c.zone_id,
            c.tile_x,
            c.tile_y,
            c.facing,
            c.action,
            c.move_started_at_ms,
            c.sprite_id,
            c.move_queue.clone(),
            c.acked_seq,
        )
    }

    /// `before` placed in `zone_id` at `now`: the spawn tile (1, 1), Idle, the facing and sprite
    /// kept, nothing published as queued, `acked_seq` = the intent's `seq`.
    fn placed(before: &Character, zone_id: u32, now: i64, seq: u64) -> Cols {
        (
            before.entity_id,
            zone_id,
            1,
            1,
            before.facing,
            ActionState::Idle,
            now,
            before.sprite_id,
            vec![],
            seq,
        )
    }

    // -----------------------------------------------------------------------
    // The world
    // -----------------------------------------------------------------------

    struct World<'a> {
        players: Handle<'a, Player>,
        chars: Handle<'a, Character, u64>,
        intents: Handle<'a, MoveIntent, u64>,
        battles: Handle<'a, Battle>,
        ticks: Handle<'a, MovementTickSchedule, u64>,
        accounts: Handle<'a, Account>,
    }

    /// Every table the placement and the movement tick read or write: `player` (by identity and
    /// by entity), `character` (by entity and by zone), `move_intent`, both battle-role indexes,
    /// the zone schedule and `account` (the deletion gate).
    fn world(fx: &Fixture) -> World<'_> {
        let _ = fx.table_keyed::<Player, u64>("player", "entity_id", |r| r.entity_id);
        let _ = fx.table_keyed::<Character, u32>("character", "zone_id", |r| r.zone_id);
        let _ = fx.table::<Battle>("battle", "opponent_identity", |r| r.opponent_identity);
        World {
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
            battles: fx.table::<Battle>("battle", "player_identity", |r| r.player_identity),
            ticks: fx
                .table_keyed::<MovementTickSchedule, u64>("movement_tick_schedule", "id", |r| r.id)
                .writable()
                .scannable()
                .unique()
                .auto_inc(|r| r.id, |r, v| r.id = v),
            accounts: fx.table::<Account>("account", "identity", |r| r.identity),
        }
    }

    impl World<'_> {
        /// A joined player: its `player`, `move_intent` and `character` rows.
        fn join(&self, who: Identity, ch: &Character, intent: &MoveIntent) {
            self.players.seed(&player(who, ch.entity_id));
            self.intents.seed(intent);
            self.chars.seed(ch);
        }
        fn character(&self, entity_id: u64) -> Character {
            self.chars
                .rows()
                .into_iter()
                .find(|c| c.entity_id == entity_id)
                .expect("character row")
        }
        /// `(entity_id, queue, last_input_seq)` of the private intent row.
        fn intent(&self, entity_id: u64) -> (u64, Vec<MoveInput>, u64) {
            let row = self
                .intents
                .rows()
                .into_iter()
                .find(|i| i.entity_id == entity_id)
                .expect("move_intent row");
            (row.entity_id, row.queue, row.last_input_seq)
        }
        /// The armed zones as `(zone_id, schedule row id)`, ascending.
        fn armed(&self) -> Vec<(u32, u64)> {
            let mut v: Vec<(u32, u64)> = self
                .ticks
                .rows()
                .iter()
                .map(|t| (t.zone_id, t.id))
                .collect();
            v.sort_unstable();
            v
        }
        fn armed_zones(&self) -> Vec<u32> {
            self.armed().iter().map(|&(z, _)| z).collect()
        }
        /// BSATN of every row of the four tables a placement may touch.
        fn snapshot(&self) -> Vec<Vec<u8>> {
            vec![
                to_vec(&self.players.rows()).expect("encodes"),
                to_vec(&self.chars.rows()).expect("encodes"),
                to_vec(&self.intents.rows()).expect("encodes"),
                to_vec(&self.ticks.rows()).expect("encodes"),
            ]
        }
        /// BSATN of one entity's character and intent rows.
        fn rows_of(&self, entity_id: u64) -> (Vec<u8>, Vec<u8>) {
            let ch = self.character(entity_id);
            let intent = self
                .intents
                .rows()
                .into_iter()
                .find(|i| i.entity_id == entity_id)
                .expect("move_intent row");
            (
                to_vec(&ch).expect("encodes"),
                to_vec(&intent).expect("encodes"),
            )
        }
        fn pending_deletion(&self, who: Identity) {
            self.accounts.seed(&crate::accounts::requested_deletion(
                crate::accounts::new_account_row(who, String::new(), 0),
                1,
            ));
        }
        fn active_account(&self, who: Identity) {
            self.accounts.remove(who);
            self.accounts
                .seed(&crate::accounts::new_account_row(who, String::new(), 0));
        }
    }

    /// Write calls on `[player, character, move_intent, movement_tick_schedule]` since the last
    /// `reset_writes`.
    fn writes(fx: &Fixture) -> [u32; 4] {
        [
            fx.writes_to("player"),
            fx.writes_to("character"),
            fx.writes_to("move_intent"),
            fx.writes_to("movement_tick_schedule"),
        ]
    }

    fn place(fx: &Fixture, who: Identity, now: i64, zone_id: u32) -> Result<(), String> {
        fx.run_as_at(who, at(now), |ctx| {
            crate::load_dev::dev_place_in_load_zone(ctx, zone_id)
        })
    }

    // -----------------------------------------------------------------------
    // The reject-log sink
    // -----------------------------------------------------------------------

    /// Every `log` record of this test process as `(target, line)`.
    struct RejectSink(std::sync::Mutex<Vec<(String, String)>>);

    impl log::Log for RejectSink {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }
        fn log(&self, record: &log::Record<'_>) {
            self.0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .push((record.target().to_string(), record.args().to_string()));
        }
        fn flush(&self) {}
    }

    static REJECTS: RejectSink = RejectSink(std::sync::Mutex::new(Vec::new()));
    static INSTALL: std::sync::Once = std::sync::Once::new();

    fn install_reject_sink() {
        INSTALL.call_once(|| {
            log::set_logger(&REJECTS).expect("no other logger in this test process (nextest)");
            log::set_max_level(log::LevelFilter::Info);
        });
    }

    /// Drain the sink; return the structured reject lines it held.
    fn take_rejects() -> Vec<(String, String)> {
        let mut logs = REJECTS.0.lock().unwrap_or_else(|e| e.into_inner());
        logs.drain(..)
            .filter(|(_, line)| line.contains("\"evt\":\"reject\""))
            .collect()
    }

    /// `who`'s call for `zone_id` is refused with exactly `reason`, makes no write call and
    /// changes no row of the four tables, and logs exactly one structured reject line.
    fn assert_refused(fx: &Fixture, w: &World<'_>, who: Identity, zone_id: u32, reason: &str) {
        install_reject_sink();
        take_rejects();
        let before = w.snapshot();
        fx.reset_writes();
        let got = place(fx, who, T1, zone_id);
        let label = format!("caller {who}, zone {zone_id}");
        assert_eq!(got, Err(reason.to_string()), "{label}: the exact refusal");
        assert_eq!(writes(fx), [0; 4], "{label}: a refusal makes no write");
        assert!(w.snapshot() == before, "{label}: a refusal changes no row");
        let line = format!(
            "{{\"evt\":\"reject\",\"reducer\":\"dev_place_in_load_zone\",\"sender\":\"{who}\",\"reason\":\"{reason}\"}}"
        );
        assert_eq!(
            take_rejects(),
            vec![("monster_realm_module::guards".to_string(), line)],
            "{label}: exactly one structured reject line"
        );
    }

    /// `who`'s call for `zone_id` at `T1` is `Ok`, logs no reject line, and leaves the caller's
    /// character on the zone's spawn tile.
    fn assert_admitted(fx: &Fixture, w: &World<'_>, who: Identity, entity_id: u64, zone_id: u32) {
        install_reject_sink();
        take_rejects();
        assert_eq!(place(fx, who, T1, zone_id), Ok(()), "zone {zone_id}");
        let rejects = take_rejects();
        assert!(
            rejects.is_empty(),
            "an admitted call logs no reject: {rejects:?}"
        );
        let ch = w.character(entity_id);
        assert_eq!(
            (ch.zone_id, ch.tile_x, ch.tile_y),
            (zone_id, 1, 1),
            "admitted: the caller stands on the zone's spawn"
        );
    }

    // =======================================================================
    // Admitted placements
    // =======================================================================

    /// B (seeded SECOND, mid-walk) places itself in zone 10042: B's character is on (1, 1) of
    /// 10042, Idle, facing and sprite kept, `move_started_at_ms` = the call's time, nothing
    /// published as queued and `acked_seq` = its intent's seq; B's intent queue is empty with
    /// the seq kept; zone 10042 gains exactly one `STEP_MS` schedule row and zone 0's row (A
    /// still stands there) is untouched; A's character and intent rows and every `player` row
    /// are byte-identical, and no `player` row is written.
    ///
    /// WRONG IMPL KILLED: the sender ignored (the first player, A, is moved); the queue not
    /// cleared (private or published); `acked_seq` left stale or the seq guard reset; the facing
    /// reset; the action left Walking/Jumping; another spawn tile; another zone (10000, or the
    /// id minus the band base); `move_started_at` not stamped, or stamped in micros; the tick
    /// not armed, armed at another interval, or zone 0's row removed; a `player` write.
    #[test]
    fn placing_moves_only_the_callers_character_to_the_spawn_and_arms_the_zone_sr9b_2() {
        let fx = fixture();
        let w = world(&fx);
        w.join(a(), &a_character(), &a_intent());
        w.join(b(), &b_character(), &b_intent());
        w.ticks.seed(&tick_row(5, 0));
        install_reject_sink();
        take_rejects();
        let a_before = w.rows_of(A_ENTITY);
        let players_before = to_vec(&w.players.rows()).expect("encodes");

        fx.reset_writes();
        assert_eq!(place(&fx, b(), T1, 10_042), Ok(()), "B places itself");
        let rejects = take_rejects();
        assert!(rejects.is_empty(), "no reject line: {rejects:?}");

        assert_eq!(
            cols(&w.character(B_ENTITY)),
            placed(&b_character(), 10_042, T1, 4),
            "B's character: on the spawn of 10042, Idle, re-stamped, queue published empty"
        );
        assert_eq!(
            w.intent(B_ENTITY),
            (B_ENTITY, vec![], 4),
            "B's queued moves are cleared and its seq guard kept"
        );
        assert_eq!(w.rows_of(A_ENTITY), a_before, "A's rows are untouched");
        assert!(
            to_vec(&w.players.rows()).expect("encodes") == players_before,
            "every player row is unchanged"
        );
        assert_eq!(fx.writes_to("player"), 0, "no player row is written");
        let armed = w.armed();
        assert_eq!(
            armed.iter().map(|&(z, _)| z).collect::<Vec<_>>(),
            vec![0, 10_042],
            "zone 10042 is armed and zone 0 stays armed"
        );
        assert_eq!(armed[0], (0, 5), "zone 0 keeps its row");
        let rows = w.ticks.rows();
        let new_row = rows.iter().find(|t| t.zone_id == 10_042);
        assert_eq!(
            new_row.map(|t| &t.scheduled_at),
            Some(&interval()),
            "zone 10042 ticks every STEP_MS"
        );
    }

    /// Arming is idempotent and the clock is re-read on every call: a zone already armed keeps
    /// its one row (no second row, same id); a second placement into the same zone adds no row;
    /// another player's placement into an armed zone adds no row; each placement stamps
    /// `move_started_at_ms` with its own call time.
    ///
    /// WRONG IMPL KILLED: an unconditional insert (a second row per call); an already-armed
    /// check on another column; the first call's time cached or a constant stamp.
    #[test]
    fn arming_keeps_one_row_per_zone_and_each_call_stamps_its_own_time_sr9b_2() {
        let fx = fixture();
        let w = world(&fx);
        w.join(a(), &a_character(), &a_intent());
        w.join(b(), &b_character(), &b_intent());
        w.ticks.seed(&tick_row(77, 10_007));
        let t2 = T1 + 1_000;
        let t3 = T1 + 2_500;
        let t4 = T1 + 3_700;

        assert_eq!(place(&fx, a(), T1, 10_007), Ok(()));
        assert_eq!(w.armed(), vec![(10_007, 77)], "pre-armed: one row");
        assert_eq!(w.character(A_ENTITY).zone_id, 10_007);

        assert_eq!(place(&fx, a(), t2, 10_050), Ok(()));
        let after_t2 = w.armed();
        assert_eq!(after_t2.len(), 2, "one new row, for 10050: {after_t2:?}");
        assert_eq!(after_t2[0], (10_007, 77), "10007 keeps its row");
        assert_eq!(after_t2[1].0, 10_050, "the new row is 10050's");
        assert_eq!(w.character(A_ENTITY).move_started_at_ms, t2);

        assert_eq!(place(&fx, a(), t3, 10_050), Ok(()));
        assert_eq!(w.armed(), after_t2, "placing again adds no row");
        assert_eq!(
            cols(&w.character(A_ENTITY)),
            placed(&a_character(), 10_050, t3, 9),
            "the second placement re-stamps the call's time"
        );

        assert_eq!(place(&fx, b(), t4, 10_050), Ok(()));
        assert_eq!(w.armed(), after_t2, "B's placement adds no row");
        assert_eq!(
            cols(&w.character(B_ENTITY)),
            placed(&b_character(), 10_050, t4, 4)
        );
    }

    /// Every id of the band is accepted, each with its own zone: A placed into 10000, 10001, …,
    /// 10099 in turn stands on (1, 1) of exactly that zone each time, and the armed zones grow
    /// one per call to all 100.
    ///
    /// WRONG IMPL KILLED: a band edge refused (`<` / `<=` slips at 10000 or 10099); a placement
    /// into a fixed zone or an offset id; a tick armed for another zone.
    #[test]
    fn every_band_id_from_10000_to_10099_is_accepted_with_its_own_zone_sr9b_2() {
        let fx = fixture();
        let w = world(&fx);
        w.join(a(), &a_character(), &a_intent());
        for zone_id in 10_000..10_100u32 {
            assert_admitted(&fx, &w, a(), A_ENTITY, zone_id);
            let want: Vec<u32> = (10_000..=zone_id).collect();
            assert_eq!(w.armed_zones(), want, "zone {zone_id}: armed once each");
        }
    }

    /// Through the zone's own tick: after A is placed in 10000, a step North queued by the
    /// shipped `enqueue_move` (seq 10, one above the kept guard 9) is drained by the shipped
    /// `movement_tick` fired through 10000's armed row, onto (1, 0) — a border tile only an
    /// all-walkable load map has.
    ///
    /// WRONG IMPL KILLED: the seq guard reset or advanced by the placement (seq 10 refused or
    /// mis-acked); a placement into a zone the server's map cache has no map for (the tick is a
    /// logged no-op and A never moves); a walled load map.
    #[test]
    fn a_placed_character_walks_when_its_load_zones_tick_fires_sr9b_2() {
        let fx = fixture();
        let w = world(&fx);
        w.join(a(), &a_character(), &a_intent());
        assert_eq!(place(&fx, a(), T1, 10_000), Ok(()));
        let armed = w.armed();
        assert_eq!(armed.len(), 1, "PRECONDITION: one armed zone: {armed:?}");
        let (zone, id) = armed[0];
        assert_eq!(zone, 10_000, "PRECONDITION: 10000 is armed");

        let step = MoveInput::Step(Direction::North);
        assert_eq!(
            fx.run_as_at(a(), at(T1 + 10), |ctx| enqueue_move(ctx, step, 10)),
            Ok(()),
            "the next seq after the kept guard is admitted"
        );
        let module = Identity::from_byte_array(DEFAULT_DATABASE_IDENTITY);
        let t2 = T1 + 200;
        let sched = MovementTickSchedule {
            id,
            zone_id: 10_000,
            scheduled_at: ScheduleAt::Time(at(t2)),
        };
        assert_eq!(
            fx.run_as_at(module, at(t2), |ctx| movement_tick(ctx, sched)),
            Ok(())
        );
        let ch = w.character(A_ENTITY);
        assert_eq!(
            (ch.zone_id, ch.tile_x, ch.tile_y, ch.facing),
            (10_000, 1, 0, Direction::North),
            "the step North drained on 10000's map"
        );
        assert_eq!(ch.move_queue, vec![], "the drained queue is published");
        assert_eq!(ch.acked_seq, 10, "the accepted seq is published");
        assert_eq!(w.intent(A_ENTITY), (A_ENTITY, vec![], 10));
    }

    // =======================================================================
    // Refusals: an exact Err, one structured reject line, no row written
    // =======================================================================

    /// Every id outside 10000..=10099 is refused for a joined, idle-able caller: the shipped
    /// zones 0 and 1, the band's neighbours 9999 and 10100, and far ids. Positive control: the
    /// same caller and state, id 10099.
    ///
    /// WRONG IMPL KILLED: no band check (a general teleport, into a shipped zone too); an
    /// inclusive upper bound (10100 admitted); a lower bound at 9999; a check that only bounds
    /// one side; a refusal that clears the queue or arms a tick before it errs.
    #[test]
    fn ids_outside_the_load_band_are_refused_sr9b_2() {
        let fx = fixture();
        let w = world(&fx);
        w.join(a(), &a_character(), &a_intent());
        w.join(b(), &b_character(), &b_intent());
        for zone_id in [0, 1, 2, 9_999, 10_100, 10_101, 20_000, u32::MAX] {
            assert_refused(&fx, &w, a(), zone_id, NOT_A_LOAD_ZONE);
        }
        assert_admitted(&fx, &w, a(), A_ENTITY, 10_099);
    }

    /// A caller with no `player` row is refused even though other players (and their
    /// characters) exist. Positive control: a joined caller, same id.
    ///
    /// WRONG IMPL KILLED: a lookup that falls back to some other player's character; a refusal
    /// reached only after a write.
    #[test]
    fn a_caller_with_no_player_row_is_refused_sr9b_2() {
        let fx = fixture();
        let w = world(&fx);
        w.join(a(), &a_character(), &a_intent());
        w.join(b(), &b_character(), &b_intent());
        assert_refused(&fx, &w, c(), 10_000, NO_CHARACTER);
        assert_admitted(&fx, &w, a(), A_ENTITY, 10_000);
    }

    /// A caller whose `player` row stands but whose `character` row, or `move_intent` row, is
    /// missing is refused with no row changed: no intent cleared, no character moved, no tick
    /// armed. Positive control: the missing row restored.
    ///
    /// WRONG IMPL KILLED: a placement that clears the intent and then finds no character (or
    /// moves the character and then finds no intent); a tick armed before the rows are checked;
    /// a panic on a missing row.
    #[test]
    fn a_caller_missing_its_character_or_intent_row_is_refused_sr9b_2() {
        {
            let fx = fixture();
            let w = world(&fx);
            w.join(a(), &a_character(), &a_intent());
            assert_eq!(w.chars.remove(A_ENTITY), 1, "fixture: A's character goes");
            assert_refused(&fx, &w, a(), 10_000, NO_CHARACTER);
            w.chars.seed(&a_character());
            assert_admitted(&fx, &w, a(), A_ENTITY, 10_000);
        }
        {
            let fx = fixture();
            let w = world(&fx);
            w.join(a(), &a_character(), &a_intent());
            assert_eq!(w.intents.remove(A_ENTITY), 1, "fixture: A's intent goes");
            assert_refused(&fx, &w, a(), 10_000, NO_CHARACTER);
            w.intents.seed(&a_intent());
            assert_admitted(&fx, &w, a(), A_ENTITY, 10_000);
        }
    }

    /// A caller in an Ongoing battle in EITHER role — side A against a wild, side A against a
    /// player, the PvP side-B opponent — is refused. Positive controls: the same battle once
    /// decided admits the same call; an Ongoing battle between two OTHER identities does not
    /// block the caller.
    ///
    /// WRONG IMPL KILLED: no battle check; a side-A-only check (the opponent arm); a check keyed
    /// on another identity; a table-wide "any ongoing battle" check; a decided battle that still
    /// blocks.
    #[test]
    fn a_caller_in_an_ongoing_battle_in_either_role_is_refused_sr9b_2() {
        let arms: [(&str, Identity, Identity); 3] = [
            ("side A vs wild", a(), crate::WILD_IDENTITY),
            ("side A vs player", a(), b()),
            ("side B (PvP opponent)", b(), a()),
        ];
        for (label, side_a, side_b) in arms {
            let fx = fixture();
            let w = world(&fx);
            w.join(a(), &a_character(), &a_intent());
            w.join(b(), &b_character(), &b_intent());
            w.battles
                .seed(&battle(1, side_a, side_b, BattleOutcome::Ongoing));
            assert_refused(&fx, &w, a(), 10_000, IN_BATTLE);
            assert_eq!(w.battles.remove(side_a), 1, "{label}: fixture");
            w.battles
                .seed(&battle(1, side_a, side_b, BattleOutcome::SideAWins));
            assert_admitted(&fx, &w, a(), A_ENTITY, 10_000);
        }
        let fx = fixture();
        let w = world(&fx);
        w.join(a(), &a_character(), &a_intent());
        w.join(b(), &b_character(), &b_intent());
        w.battles.seed(&battle(1, b(), c(), BattleOutcome::Ongoing));
        assert_admitted(&fx, &w, a(), A_ENTITY, 10_000);
    }

    /// The deletion gate comes FIRST: a caller whose account is pending deletion gets
    /// `REJECT_DELETION_GATED` (one reject line, no row) for an in-band id, an out-of-band id,
    /// while in an ongoing battle, and with no `player` row at all. A stranger pending deletion
    /// does not gate an Active caller. Positive control: the caller's account made Active again.
    ///
    /// WRONG IMPL KILLED: no deletion gate; the gate placed after the band / player / battle
    /// checks (those calls would report the band, the missing player or the battle); a
    /// table-wide gate; a re-typed reason instead of the constant.
    #[test]
    fn a_deletion_gated_caller_is_refused_before_any_other_check_sr9b_2() {
        let fx = fixture();
        let w = world(&fx);
        w.join(a(), &a_character(), &a_intent());
        w.join(b(), &b_character(), &b_intent());
        w.pending_deletion(a());
        w.pending_deletion(c());
        w.active_account(b());
        assert_refused(&fx, &w, a(), 10_000, REJECT_DELETION_GATED);
        assert_refused(&fx, &w, a(), 0, REJECT_DELETION_GATED);
        assert_refused(&fx, &w, c(), 10_000, REJECT_DELETION_GATED);
        w.battles.seed(&battle(
            1,
            a(),
            crate::WILD_IDENTITY,
            BattleOutcome::Ongoing,
        ));
        assert_refused(&fx, &w, a(), 10_000, REJECT_DELETION_GATED);
        assert_eq!(w.battles.remove(a()), 1, "fixture: the battle goes");

        assert_admitted(&fx, &w, b(), B_ENTITY, 10_000);
        w.active_account(a());
        assert_admitted(&fx, &w, a(), A_ENTITY, 10_001);
    }

    /// After the deletion gate the checks run band → player row → battle → character/intent
    /// rows, each pair told apart by a caller failing both: no player row AND an out-of-band id
    /// reports the band; an ongoing battle AND an out-of-band id reports the band; no player row
    /// AND an ongoing battle reports the missing character; an ongoing battle AND a missing
    /// character row reports the battle.
    ///
    /// WRONG IMPL KILLED: the checks out of order (each swap flips one of the four reasons).
    #[test]
    fn the_checks_run_band_then_player_then_battle_then_rows_sr9b_2() {
        let fx = fixture();
        let w = world(&fx);
        w.join(a(), &a_character(), &a_intent());
        assert_refused(&fx, &w, c(), 0, NOT_A_LOAD_ZONE);
        w.battles.seed(&battle(
            1,
            a(),
            crate::WILD_IDENTITY,
            BattleOutcome::Ongoing,
        ));
        w.battles.seed(&battle(
            2,
            c(),
            crate::WILD_IDENTITY,
            BattleOutcome::Ongoing,
        ));
        assert_refused(&fx, &w, a(), 10_100, NOT_A_LOAD_ZONE);
        assert_refused(&fx, &w, c(), 10_000, NO_CHARACTER);
        assert_eq!(w.chars.remove(A_ENTITY), 1, "fixture: A's character goes");
        assert_refused(&fx, &w, a(), 10_000, IN_BATTLE);
    }
}
