//! th-4 gating tests for `dev_clock.rs` (spec M-test-health §th-4, th-4.1 – th-4.5).
//!
//! `dev_expire_tactical_window` exists only under the `dev_reducers` feature, so every item of this
//! file sits in ONE `#[cfg(feature = "dev_reducers")]` module (the `taming_tests.rs` `mod nh`
//! shape): the default build compiles the file as an empty module. Run with
//! `cargo nextest run -p monster-realm-module --features dev_reducers -E 'test(/_th4_/)'`.
//!
//! Every scenario is built through the `tactics::tactics_tests` fixtures (contract C2: no `Player`
//! literal here) and drives the shipped reducers in the native host. The module owner is a THIRD
//! identity (`owner()`), neither player and not the database identity `module()`, so an owner
//! check made against `ctx.database_identity()` is refused in every test. The native host never
//! deletes a fired one-shot schedule row (the runtime does): a test that goes on after a fire
//! removes the fired row itself.
//!
//! The reject-log sink is process-wide (one `log::set_logger` per process): NEXTEST-ONLY, like
//! `tactics_tests.rs`'s `RejectLogSink`.

#[cfg(feature = "dev_reducers")]
mod nh {
    use crate::native_host_tests::{fixture, Fixture};
    use crate::schema::{BattleClock, Config, SideRow};
    use crate::tactics::tactics_tests::{
        a, advance_args, at, b, c, changed, clock_window, deadline_args, deploy, deploying_pvp,
        enc, fire_advance, fire_deadline, live_pair, live_pvp, module, none, picks_in_order,
        row_set, submit, time, world, Live, PvpLive, World, B_PAIR, PAIR, PVP_WINDOW_MS, T0,
    };
    use game_core::tactics::{EndHow, EventPayload, Phase, QueuedAction, TurnState};
    use spacetimedb::{Identity, ScheduleAt};

    /// The reducer's `side` argument: 0 names side A, 1 names side B.
    const SIDE_A: u8 = 0;
    const SIDE_B: u8 = 1;

    const NOT_OWNER: &str = "caller is not the module owner";
    const BAD_SIDE: &str = "side must be 0 or 1";
    const NO_BATTLE: &str = "no such tactical battle";
    const NOT_ACTIVE: &str = "battle is not active";
    const NO_WINDOW: &str = "no open turn window";
    const OTHER_SIDE: &str = "the other side's window is open";
    const NO_PENDING: &str = "no pending deadline for the open window";

    /// The module owner: a third identity, neither player and not the database identity.
    fn owner() -> Identity {
        Identity::from_byte_array([0x7E; 32])
    }

    /// The all-zero identity: an unregistered `config.owner_identity`.
    fn zero() -> Identity {
        Identity::from_byte_array([0; 32])
    }

    /// Replace the `config` row so its owner is `who` (`world` seeds `module()`).
    fn set_owner(w: &World<'_>, who: Identity) {
        assert_eq!(
            w.configs.remove(0),
            1,
            "fixture: the one config row is replaced"
        );
        w.configs.seed(&Config {
            id: 0,
            content_version: crate::CONTENT_VERSION,
            owner_identity: who,
        });
    }

    fn expire_now(
        fx: &Fixture,
        who: Identity,
        now: i64,
        battle_id: u64,
        side: u8,
    ) -> Result<(), String> {
        fx.run_as_at(who, at(now), |ctx| {
            crate::dev_clock::dev_expire_tactical_window(ctx, battle_id, side)
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

    /// One call of the reducer under test.
    #[derive(Clone, Copy)]
    struct Call {
        who: Identity,
        now: i64,
        id: u64,
        side: u8,
    }

    /// `call` is refused with exactly `reason`, writes NO row (the whole-world snapshot is
    /// unchanged) and logs exactly one structured reject line through `guards::log_reject`.
    fn assert_refused(fx: &Fixture, w: &World<'_>, call: Call, reason: &str, label: &str) {
        install_reject_sink();
        take_rejects();
        let before = w.snapshot();
        let got = expire_now(fx, call.who, call.now, call.id, call.side);
        assert_eq!(got, Err(reason.to_string()), "{label}: the exact refusal");
        assert_eq!(
            changed(&before, &w.snapshot()),
            none(),
            "{label}: a refusal writes no row"
        );
        let who = call.who;
        let line = format!(
            "{{\"evt\":\"reject\",\"reducer\":\"dev_expire_tactical_window\",\"sender\":\"{who}\",\"reason\":\"{reason}\"}}"
        );
        assert_eq!(
            take_rejects(),
            vec![("monster_realm_module::guards".to_string(), line)],
            "{label}: exactly one structured reject line"
        );
    }

    /// Positive control: `call` is admitted — `Ok`, no reject line, and the open window's clock
    /// row now carries `deadline_ms == call.now`.
    fn assert_admitted(fx: &Fixture, w: &World<'_>, call: Call, label: &str) {
        install_reject_sink();
        take_rejects();
        let unit = waiting(w, call.id);
        assert_eq!(
            expire_now(fx, call.who, call.now, call.id, call.side),
            Ok(()),
            "{label}: admitted"
        );
        let rejects = take_rejects();
        assert!(
            rejects.is_empty(),
            "{label}: an admitted call logs no reject, got {rejects:?}"
        );
        assert_eq!(
            window_of(w, call.id, unit).deadline_ms,
            Some(call.now),
            "{label}: the open window's deadline moved to the call's time"
        );
    }

    // -----------------------------------------------------------------------
    // Battle helpers
    // -----------------------------------------------------------------------

    /// The unit holding the battle's turn window.
    fn waiting(w: &World<'_>, id: u64) -> u32 {
        match w.tactical(id).turn_state {
            TurnState::Waiting(u) => u,
            other => panic!("PRECONDITION: a unit waits, got {other:?}"),
        }
    }

    /// The clock row of `unit`'s side (a wild battle's one row is side A's).
    fn window_of(w: &World<'_>, id: u64, unit: u32) -> BattleClock {
        w.clock_of(id, w.unit(unit).side)
    }

    /// A call time one second inside the waiting unit's open window.
    fn in_window(w: &World<'_>, id: u64) -> i64 {
        let clock = window_of(w, id, waiting(w, id));
        let now = clock
            .window_open_ms
            .expect("PRECONDITION: the window is open")
            + 1_000;
        assert!(
            clock.deadline_ms.is_some_and(|d| now < d),
            "PRECONDITION: the call lands before the real deadline"
        );
        now
    }

    fn ms_of(when: ScheduleAt) -> i64 {
        let ScheduleAt::Time(ts) = when else {
            panic!("a deadline row is scheduled at a time, got {when:?}");
        };
        ts.to_micros_since_unix_epoch() / 1_000
    }

    /// Drive a PvP battle until a side-B unit waits: A ends each of its turns LIVE (inside its own
    /// window) and a round boundary runs by firing its advance row (then removed, as the runtime
    /// deletes a fired row). `now` is the test clock; returns the waiting B unit and how many A
    /// turns were ended on the way.
    fn drive_to_b_window(fx: &Fixture, w: &World<'_>, id: u64, now: &mut i64) -> (u32, usize) {
        let mut a_turns = 0;
        for _ in 0..16 {
            let t = w.tactical(id);
            assert_eq!(t.phase, Phase::Active, "PRECONDITION: the battle is Active");
            match t.turn_state {
                TurnState::Waiting(u) if w.unit(u).side == SideRow::B => return (u, a_turns),
                TurnState::Waiting(u) => {
                    let clock = window_of(w, id, u);
                    *now = (*now).max(clock.window_open_ms.expect("A's window is open")) + 1_000;
                    assert!(
                        clock.deadline_ms.is_some_and(|d| *now < d),
                        "A acts inside its window"
                    );
                    submit(fx, a(), *now, id, u, vec![QueuedAction::EndTurn])
                        .expect("A ends its turn live");
                    a_turns += 1;
                }
                TurnState::Advancing => {
                    let adv = w.advances_of(id);
                    assert_eq!(adv.len(), 1, "one advance row at the round boundary");
                    *now += 1_000;
                    fire_advance(fx, *now, advance_args(&adv[0])).expect("the next round starts");
                    assert_eq!(w.advances.remove(adv[0].scheduled_id), 1);
                }
                TurnState::NotActive => panic!("an Active battle has a turn state"),
            }
        }
        panic!("no side-B window within 16 steps");
    }

    /// The owner expires `side`'s open window at `t`, the ONE fire it armed runs at `t`, and the
    /// fired row is removed (the runtime deletes it).
    fn expire_and_fire(fx: &Fixture, w: &World<'_>, id: u64, side: u8, t: i64) {
        let before: Vec<u64> = w.deadlines_of(id).iter().map(|r| r.scheduled_id).collect();
        assert_eq!(
            expire_now(fx, owner(), t, id, side),
            Ok(()),
            "the owner expires the open window"
        );
        let mut armed: Vec<_> = w
            .deadlines_of(id)
            .into_iter()
            .filter(|r| !before.contains(&r.scheduled_id))
            .collect();
        assert_eq!(armed.len(), 1, "the expiry arms exactly one deadline fire");
        let armed = armed.remove(0);
        assert_eq!(armed.scheduled_at, time(t), "armed at the call's time");
        assert_eq!(
            fire_deadline(fx, t, deadline_args(&armed)),
            Ok(()),
            "the armed fire runs"
        );
        assert_eq!(
            w.deadlines.remove(armed.scheduled_id),
            1,
            "the fired row is removed"
        );
    }

    /// A 2v2 PvP battle (A's `PAIR` vs B's `B_PAIR`) owned by `owner()`, driven until B's faster
    /// unit waits (A ended both its turns live). Returns the battle and the test clock.
    fn pvp_b_waiting(fx: &Fixture, w: &World<'_>) -> (PvpLive, i64) {
        set_owner(w, owner());
        let live = live_pvp(fx, w, &PAIR, &B_PAIR);
        let mut now = live.revealed_at;
        let (unit, a_turns) = drive_to_b_window(fx, w, live.id, &mut now);
        assert_eq!(
            (unit, a_turns),
            (live.b[0], 2),
            "PRECONDITION: A ended both its turns live and B's faster unit waits"
        );
        (live, now)
    }

    /// A wild pack-1 battle owned by `owner()`: the player's `u1` holds the first window, damaged
    /// to 175 HP so the flee's HP persistence is visible.
    fn wild_player_waiting(fx: &Fixture, w: &World<'_>) -> Live {
        set_owner(w, owner());
        let live = live_pair(fx, w);
        w.edit_unit(live.u1, |u| u.cur_hp = 175);
        live
    }

    /// What one PvP deadline fire left behind, every instant as an offset from the fire time.
    #[derive(Debug, PartialEq)]
    struct PvpFire {
        fresh: Vec<EventPayload>,
        /// `(A's autopass_count, B's autopass_count)`.
        strikes: (u8, u8),
        turn_state: TurnState,
        outcome: game_core::BattleOutcome,
        /// `clock_window` of the struck side's clock, instants relative to the fire.
        window: (u32, Option<i64>, Option<i64>, u8, u8),
        /// `(unit, window_seq, at - fire)` of every deadline row but the fired one.
        pending: Vec<(u32, u32, i64)>,
    }

    /// The fire's outcome, `window` read off `side`'s clock row.
    fn pvp_fire_outcome(
        w: &World<'_>,
        id: u64,
        side: SideRow,
        events_before: usize,
        fired: u64,
        fire_at: i64,
    ) -> PvpFire {
        let (seq, open, deadline, windows, autopass) = clock_window(&w.clock_of(id, side));
        PvpFire {
            fresh: w
                .events_of(id)
                .into_iter()
                .skip(events_before)
                .map(|e| e.payload)
                .collect(),
            strikes: (
                w.clock_of(id, SideRow::A).autopass_count,
                w.clock_of(id, SideRow::B).autopass_count,
            ),
            turn_state: w.tactical(id).turn_state,
            outcome: w.anchor(id).expect("the anchor").state.outcome,
            window: (
                seq,
                open.map(|t| t - fire_at),
                deadline.map(|t| t - fire_at),
                windows,
                autopass,
            ),
            pending: w
                .deadlines_of(id)
                .iter()
                .filter(|r| r.scheduled_id != fired)
                .map(|r| (r.unit_id, r.window_seq, ms_of(r.scheduled_at) - fire_at))
                .collect(),
        }
    }

    /// What one wild deadline fire left behind.
    #[derive(Debug, PartialEq)]
    struct WildFire {
        fresh: Vec<EventPayload>,
        outcome: game_core::BattleOutcome,
        phase: Phase,
        turn_state: TurnState,
        /// `current_hp` of the party monsters 11 and 12 (`PAIR`).
        hp: (u16, u16),
        queues: usize,
    }

    fn wild_fire_outcome(w: &World<'_>, id: u64, events_before: usize) -> WildFire {
        let t = w.tactical(id);
        WildFire {
            fresh: w
                .events_of(id)
                .into_iter()
                .skip(events_before)
                .map(|e| e.payload)
                .collect(),
            outcome: w.anchor(id).expect("the anchor survives").state.outcome,
            phase: t.phase,
            turn_state: t.turn_state,
            hp: (w.monster(11).current_hp, w.monster(12).current_hp),
            queues: w.queues_of(id).len(),
        }
    }

    // =======================================================================
    // th-4.1 — the owner's expiry of B's window, and its fire
    // =======================================================================

    /// The owner's call during B's open window (side 1), strictly before the real deadline, is
    /// `Ok`; it changes ONLY B's clock row (`deadline_ms == now`, every other column as before) and
    /// adds ONE deadline row pinned to the waiting unit and the clock's `window_seq` at `now`,
    /// keeping the original row. Firing that row at `now` books AutoPass strike 1 on B's unit,
    /// ends its turn uncommitted without Guard, leaves A at 0 strikes and opens B's next unit's
    /// full window — the same outcome a twin world gets from the ORIGINAL row fired at the real
    /// deadline, only earlier.
    ///
    /// WRONG IMPL KILLED: an expiry run inside the reducer (events / units written by the call); a
    /// moved deadline with no fire armed, or a fire armed at the old deadline; an armed row pinned
    /// to another unit or window; the original pending row deleted or rewritten; a rewritten
    /// `window_open_ms`, `window_seq`, strike count or idle total; A's clock touched; a fire that
    /// is not the real one (a strike on A, a Guard, a second strike, a different next window).
    #[test]
    fn the_owners_expiry_moves_bs_deadline_to_now_and_its_fire_is_the_real_auto_pass_th4_1() {
        let dev = {
            let fx = fixture();
            let w = world(&fx);
            let (live, cursor) = pvp_b_waiting(&fx, &w);
            let unit = live.b[0];
            let b_before = w.clock_of(live.id, SideRow::B);
            let a_before = w.clock_of(live.id, SideRow::A);
            let open = b_before.window_open_ms.expect("B's window is open");
            let deadline = b_before.deadline_ms.expect("B's window has a deadline");
            let original = w.only_deadline(live.id);
            assert_eq!(
                (original.unit_id, original.window_seq, original.scheduled_at),
                (unit, b_before.window_seq, time(deadline)),
                "PRECONDITION: one pending fire for B's window at its real deadline"
            );
            let now = open.max(cursor) + 1_000;
            assert!(
                now < deadline,
                "PRECONDITION: the call is strictly before the deadline"
            );

            let before = w.snapshot();
            assert_eq!(
                expire_now(&fx, owner(), now, live.id, SIDE_B),
                Ok(()),
                "the owner expires B's open window"
            );
            assert_eq!(
                changed(&before, &w.snapshot()),
                vec!["battle_clock", "tactical_deadline_sched"],
                "the call writes the clock and the schedule only"
            );
            let mut want_b = b_before.clone();
            want_b.deadline_ms = Some(now);
            assert_eq!(
                enc(&w.clock_of(live.id, SideRow::B)),
                enc(&want_b),
                "B's clock row differs only in deadline_ms == now: got {:?}, want {:?}",
                clock_window(&w.clock_of(live.id, SideRow::B)),
                clock_window(&want_b)
            );
            assert_eq!(
                row_set(&w.clocks_of(live.id)),
                row_set(&[a_before, want_b]),
                "A's clock row is untouched"
            );
            let (kept, mut armed): (Vec<_>, Vec<_>) = w
                .deadlines_of(live.id)
                .into_iter()
                .partition(|r| r.scheduled_id == original.scheduled_id);
            assert_eq!(
                row_set(&kept),
                row_set(&[deadline_args(&original)]),
                "the original pending row stays, unchanged, until the fire sweeps it"
            );
            assert_eq!(armed.len(), 1, "exactly one new deadline row");
            let armed = armed.remove(0);
            assert_eq!(
                (armed.unit_id, armed.window_seq, armed.scheduled_at),
                (unit, b_before.window_seq, time(now)),
                "the new row is pinned to the waiting unit and the open window, at the call's time"
            );

            let events_before = w.events_of(live.id).len();
            assert_eq!(
                fire_deadline(&fx, now, deadline_args(&armed)),
                Ok(()),
                "the armed fire runs at the call's time"
            );
            let out = pvp_fire_outcome(
                &w,
                live.id,
                SideRow::B,
                events_before,
                armed.scheduled_id,
                now,
            );
            assert!(
                matches!(
                    out.fresh.as_slice(),
                    [
                        EventPayload::AutoPass(p),
                        EventPayload::TurnEnded(t),
                        ..
                    ] if p.unit == unit && p.strike == 1
                        && t.unit == unit && !t.guard && !t.committed
                ),
                "AutoPass{{strike 1}} then TurnEnded{{guard false, uncommitted}}, got {:?}",
                out.fresh
            );
            assert_eq!(out.strikes, (0, 1), "the strike is B's; A's count stays 0");
            assert_eq!(
                out.outcome,
                game_core::BattleOutcome::Ongoing,
                "one auto-pass ends nothing"
            );
            assert_eq!(
                out.turn_state,
                TurnState::Waiting(live.b[1]),
                "B's next unit waits"
            );
            assert_eq!(
                out.window,
                (b_before.window_seq + 1, Some(0), Some(PVP_WINDOW_MS), 1, 1),
                "B's next window opens at the fire with a full 30 s"
            );
            assert_eq!(
                out.pending,
                vec![(live.b[1], b_before.window_seq + 1, PVP_WINDOW_MS)],
                "the fire swept the original row and armed only the next window"
            );
            out
        };
        let twin = {
            let fx = fixture();
            let w = world(&fx);
            let (live, _) = pvp_b_waiting(&fx, &w);
            let original = w.only_deadline(live.id);
            let deadline = w
                .clock_of(live.id, SideRow::B)
                .deadline_ms
                .expect("B's window has a deadline");
            let events_before = w.events_of(live.id).len();
            assert_eq!(
                fire_deadline(&fx, deadline, deadline_args(&original)),
                Ok(()),
                "twin: the real deadline's fire"
            );
            pvp_fire_outcome(
                &w,
                live.id,
                SideRow::B,
                events_before,
                original.scheduled_id,
                deadline,
            )
        };
        assert_eq!(
            dev, twin,
            "the expiry's fire books exactly what the real deadline's fire books, only earlier"
        );
    }

    /// The owner's call during A's open PvP window (side 0; two clock rows, A's unit waiting),
    /// strictly before the real deadline, is `Ok`; it changes ONLY A's clock row and only in
    /// `deadline_ms == now` (B's row byte-unchanged) and adds ONE deadline row `(A's waiting unit,
    /// A's clock window_seq, time(now))`, keeping the original row. Firing it books exactly one
    /// AutoPass strike, on A's unit (A's count 1, B's 0), the battle stays Ongoing, A's next unit
    /// gets a full window — the twin world's real-deadline outcome, only earlier.
    ///
    /// WRONG IMPL KILLED (each green against th-4.1's B-window test alone): a reducer that
    /// pre-increments A's `autopass_count` (the fire then books a second strike: A's row differs
    /// in more than `deadline_ms`); a side-A expiry that moves the deadline but arms no fire; a
    /// fire armed with `window_seq + 1` (the fire would refuse it as stale and strike nobody); a
    /// side-A path that writes B's clock row.
    #[test]
    fn the_owners_expiry_of_as_pvp_window_strikes_a_once_th4_1() {
        let dev = {
            let fx = fixture();
            let w = world(&fx);
            set_owner(&w, owner());
            let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
            let unit = live.a[0];
            assert_eq!(
                waiting(&w, live.id),
                unit,
                "PRECONDITION: A's faster unit waits"
            );
            assert_eq!(
                w.clocks_of(live.id).len(),
                2,
                "PRECONDITION: a PvP battle has two clock rows"
            );
            let a_before = w.clock_of(live.id, SideRow::A);
            let b_before = w.clock_of(live.id, SideRow::B);
            let seq = a_before.window_seq;
            let deadline = a_before.deadline_ms.expect("A's window has a deadline");
            let original = w.only_deadline(live.id);
            assert_eq!(
                (original.unit_id, original.window_seq, original.scheduled_at),
                (unit, seq, time(deadline)),
                "PRECONDITION: one pending fire for A's window at its real deadline"
            );
            let now = in_window(&w, live.id);

            let before = w.snapshot();
            assert_eq!(
                expire_now(&fx, owner(), now, live.id, SIDE_A),
                Ok(()),
                "the owner expires A's open window"
            );
            assert_eq!(
                changed(&before, &w.snapshot()),
                vec!["battle_clock", "tactical_deadline_sched"],
                "the call writes the clock and the schedule only"
            );
            let mut want_a = a_before.clone();
            want_a.deadline_ms = Some(now);
            assert_eq!(
                enc(&w.clock_of(live.id, SideRow::A)),
                enc(&want_a),
                "A's clock row differs only in deadline_ms == now: got {:?}, want {:?}",
                clock_window(&w.clock_of(live.id, SideRow::A)),
                clock_window(&want_a)
            );
            assert_eq!(
                row_set(&w.clocks_of(live.id)),
                row_set(&[want_a, b_before]),
                "B's clock row is untouched"
            );
            let (kept, mut armed): (Vec<_>, Vec<_>) = w
                .deadlines_of(live.id)
                .into_iter()
                .partition(|r| r.scheduled_id == original.scheduled_id);
            assert_eq!(
                row_set(&kept),
                row_set(&[deadline_args(&original)]),
                "the original pending row stays, unchanged"
            );
            assert_eq!(armed.len(), 1, "exactly one new deadline row");
            let armed = armed.remove(0);
            assert_eq!(
                (armed.unit_id, armed.window_seq, armed.scheduled_at),
                (unit, seq, time(now)),
                "the new row pins A's waiting unit and A's open window, at the call's time"
            );

            let events_before = w.events_of(live.id).len();
            assert_eq!(
                fire_deadline(&fx, now, deadline_args(&armed)),
                Ok(()),
                "the armed fire runs at the call's time"
            );
            let out = pvp_fire_outcome(
                &w,
                live.id,
                SideRow::A,
                events_before,
                armed.scheduled_id,
                now,
            );
            let strikes: Vec<(u32, u8)> = out
                .fresh
                .iter()
                .filter_map(|p| match p {
                    EventPayload::AutoPass(x) => Some((x.unit, x.strike)),
                    _ => None,
                })
                .collect();
            assert_eq!(
                strikes,
                vec![(unit, 1)],
                "exactly one AutoPass strike, strike 1 on A's unit"
            );
            assert!(
                matches!(
                    out.fresh.as_slice(),
                    [
                        EventPayload::AutoPass(_),
                        EventPayload::TurnEnded(t),
                        ..
                    ] if t.unit == unit && !t.guard && !t.committed
                ),
                "AutoPass then TurnEnded{{guard false, uncommitted}}, got {:?}",
                out.fresh
            );
            assert_eq!(out.strikes, (1, 0), "the strike is A's; B's count stays 0");
            assert_eq!(
                out.outcome,
                game_core::BattleOutcome::Ongoing,
                "one auto-pass ends nothing"
            );
            assert_eq!(
                out.turn_state,
                TurnState::Waiting(live.a[1]),
                "A's next unit waits"
            );
            assert_eq!(
                out.window,
                (seq + 1, Some(0), Some(PVP_WINDOW_MS), 1, 1),
                "A's next window opens at the fire with a full 30 s"
            );
            assert_eq!(
                out.pending,
                vec![(live.a[1], seq + 1, PVP_WINDOW_MS)],
                "the fire swept the original row and armed only the next window"
            );
            out
        };
        let twin = {
            let fx = fixture();
            let w = world(&fx);
            set_owner(&w, owner());
            let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
            let original = w.only_deadline(live.id);
            let deadline = w
                .clock_of(live.id, SideRow::A)
                .deadline_ms
                .expect("A's window has a deadline");
            let events_before = w.events_of(live.id).len();
            assert_eq!(
                fire_deadline(&fx, deadline, deadline_args(&original)),
                Ok(()),
                "twin: the real deadline's fire"
            );
            pvp_fire_outcome(
                &w,
                live.id,
                SideRow::A,
                events_before,
                original.scheduled_id,
                deadline,
            )
        };
        assert_eq!(
            dev, twin,
            "the expiry's fire of A's window books what the real deadline's fire books"
        );
    }

    /// The clock row armed is the WAITING UNIT's side's, not the battle's first row with an open
    /// window. By a row edit (unreachable through the shipped reducers: only the waiting side's
    /// row holds a window) the other side's clock row is given a stale open window with a
    /// different `window_seq`; the owner's call naming the waiting side is `Ok`, the stale row is
    /// byte-unchanged, the waiting side's row alone takes `deadline_ms == now`, and the armed row
    /// carries the waiting side's `window_seq`. Both orientations (B waits with A's row stale; A
    /// waits with B's row stale), each with the stale row FIRST in the host's row order.
    ///
    /// WRONG IMPL KILLED: the clock lookup's side filter dropped (the first open row of the
    /// battle is taken: the stale row is rewritten, the fire armed at the stale `window_seq`, or
    /// the call refused `no pending deadline for the open window`); a lookup by the NAMED side
    /// that ignores the waiting unit.
    #[test]
    fn the_armed_clock_row_is_the_waiting_sides_not_the_first_open_one_th4_1() {
        for waiting_side in [SideRow::B, SideRow::A] {
            let fx = fixture();
            let w = world(&fx);
            let (id, side_arg, stale_side) = if waiting_side == SideRow::B {
                let (live, _) = pvp_b_waiting(&fx, &w);
                (live.id, SIDE_B, SideRow::A)
            } else {
                set_owner(&w, owner());
                let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
                (live.id, SIDE_A, SideRow::B)
            };
            let unit = waiting(&w, id);
            assert_eq!(
                w.unit(unit).side,
                waiting_side,
                "PRECONDITION: the {waiting_side:?} unit waits"
            );
            let now = in_window(&w, id);
            let live_clock = w.clock_of(id, waiting_side);
            let seq = live_clock.window_seq;
            w.edit_clock_of(id, stale_side, |c| {
                c.window_open_ms = Some(now - 2_000);
                c.deadline_ms = Some(now + 5_000);
                c.window_seq = seq + 3;
            });
            // A no-op edit re-seeds the live row LAST, so the host's row order (insertion order)
            // puts the stale row first: a first-open-row lookup takes the stale one.
            w.edit_clock_of(id, waiting_side, |_| {});
            assert_eq!(
                enc(&w.clock_of(id, waiting_side)),
                enc(&live_clock),
                "fixture: the live row is unchanged by the re-seed"
            );
            let order: Vec<SideRow> = w
                .clocks
                .rows()
                .into_iter()
                .filter(|r| r.battle_id == id)
                .map(|r| r.side)
                .collect();
            assert_eq!(
                order,
                vec![stale_side, waiting_side],
                "PRECONDITION: the stale open row precedes the live one in host order"
            );
            let stale = w.clock_of(id, stale_side);
            assert_ne!(
                stale.window_seq, seq,
                "fixture: the stale window's sequence differs"
            );
            let pending_before: Vec<u64> =
                w.deadlines_of(id).iter().map(|r| r.scheduled_id).collect();

            let before = w.snapshot();
            assert_eq!(
                expire_now(&fx, owner(), now, id, side_arg),
                Ok(()),
                "{waiting_side:?} waits: the owner naming that side is admitted"
            );
            assert_eq!(
                changed(&before, &w.snapshot()),
                vec!["battle_clock", "tactical_deadline_sched"],
                "{waiting_side:?} waits: the clock and the schedule only"
            );
            assert_eq!(
                enc(&w.clock_of(id, stale_side)),
                enc(&stale),
                "{waiting_side:?} waits: the stale {stale_side:?} row is byte-unchanged"
            );
            let mut want = live_clock.clone();
            want.deadline_ms = Some(now);
            assert_eq!(
                enc(&w.clock_of(id, waiting_side)),
                enc(&want),
                "{waiting_side:?} waits: its own row differs only in deadline_ms == now"
            );
            let armed: Vec<(u32, u32, ScheduleAt)> = w
                .deadlines_of(id)
                .into_iter()
                .filter(|r| !pending_before.contains(&r.scheduled_id))
                .map(|r| (r.unit_id, r.window_seq, r.scheduled_at))
                .collect();
            assert_eq!(
                armed,
                vec![(unit, seq, time(now))],
                "{waiting_side:?} waits: one armed row, at the waiting side's window_seq"
            );
        }
    }

    // =======================================================================
    // th-4.2 — four expiries forfeit B
    // =======================================================================

    /// Four owner expiries across B's successive windows (two per round, a round boundary between,
    /// A ending each of its turns live) book strikes 1..4 on B's units in window order; the first
    /// three leave the battle Ongoing and the fourth fire forfeits B: `BattleEnd{SideAWins,
    /// Forfeit}`, anchor `SideAWins`, phase Finished, A's count 0 and B's 4.
    ///
    /// WRONG IMPL KILLED: an expiry that books no strike, or two; an expiry that resets or
    /// rewrites the strike count (the count never climbs to the forfeit); a strike booked on A; a
    /// reducer that works only in the first window of a battle or of a round (the second and
    /// fourth calls land on B's second unit right after an expiry; the third after a round
    /// boundary).
    #[test]
    fn four_owner_expiries_across_bs_windows_forfeit_b_to_side_a_th4_2() {
        let fx = fixture();
        let w = world(&fx);
        set_owner(&w, owner());
        let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
        let mut now = live.revealed_at;
        let mut struck = Vec::new();
        let mut a_turns = Vec::new();
        for n in 1..=4u8 {
            let (unit, turns) = drive_to_b_window(&fx, &w, live.id, &mut now);
            let clock = w.clock_of(live.id, SideRow::B);
            assert_eq!(
                (
                    w.clock_of(live.id, SideRow::A).autopass_count,
                    clock.autopass_count
                ),
                (0, n - 1),
                "before expiry {n}: A has no strike, B has one per earlier expiry"
            );
            now = now.max(clock.window_open_ms.expect("B's window is open")) + 500;
            assert!(
                clock.deadline_ms.is_some_and(|d| now < d),
                "expiry {n} lands before the real deadline"
            );
            expire_and_fire(&fx, &w, live.id, SIDE_B, now);
            struck.push(unit);
            a_turns.push(turns);
            if n < 4 {
                assert_eq!(
                    w.anchor(live.id).expect("anchor").state.outcome,
                    game_core::BattleOutcome::Ongoing,
                    "{n} strikes do not forfeit"
                );
            }
        }
        assert_eq!(
            a_turns,
            vec![2, 0, 2, 0],
            "A acted live in each round before B's two windows"
        );
        assert_eq!(
            struck,
            vec![live.b[0], live.b[1], live.b[0], live.b[1]],
            "B's successive windows, two per round"
        );
        let events = w.events_of(live.id);
        let strikes: Vec<(u32, u8)> = events
            .iter()
            .filter_map(|e| match &e.payload {
                EventPayload::AutoPass(p) => Some((p.unit, p.strike)),
                _ => None,
            })
            .collect();
        assert_eq!(
            strikes,
            vec![
                (live.b[0], 1),
                (live.b[1], 2),
                (live.b[0], 3),
                (live.b[1], 4)
            ],
            "strikes 1..4, all on B's units"
        );
        let ends: Vec<(game_core::BattleOutcome, EndHow)> = events
            .iter()
            .filter_map(|e| match &e.payload {
                EventPayload::BattleEnd(x) => Some((x.outcome, x.how)),
                _ => None,
            })
            .collect();
        assert_eq!(
            ends,
            vec![(game_core::BattleOutcome::SideAWins, EndHow::Forfeit)],
            "the fourth fire forfeits B"
        );
        assert_eq!(
            w.anchor(live.id).expect("anchor").state.outcome,
            game_core::BattleOutcome::SideAWins
        );
        assert_eq!(w.tactical(live.id).phase, Phase::Finished);
        assert_eq!(
            (
                w.clock_of(live.id, SideRow::A).autopass_count,
                w.clock_of(live.id, SideRow::B).autopass_count
            ),
            (0, 4),
            "A was never struck"
        );
    }

    // =======================================================================
    // th-4.3 — a wild window: the AutoFlee
    // =======================================================================

    /// In an Active wild battle whose player window is open, the owner's call with side 0 is `Ok`
    /// and changes only the player's clock row (`deadline_ms == now`) and the schedule (one row
    /// pinned to the waiting unit at `now`); its fire ends the battle `Fled` by
    /// `BattleEnd{Fled, AutoFlee}`, Finished / NotActive, the damaged HP persisted — exactly the
    /// end a twin world's real-deadline fire gives.
    ///
    /// WRONG IMPL KILLED: a PvP-only reducer (side 0 refused on a wild battle, or the wild clock
    /// not found); an AutoPass forced on a wild battle; a flee written by the reducer itself; a
    /// fire armed at the PvE deadline (300 s later) or never armed.
    #[test]
    fn the_owners_expiry_of_a_wild_window_ends_in_the_real_deadlines_auto_flee_th4_3() {
        let dev = {
            let fx = fixture();
            let w = world(&fx);
            let live = wild_player_waiting(&fx, &w);
            let clock = w.clock_of(live.id, SideRow::A);
            let open = clock.window_open_ms.expect("the player's window is open");
            let deadline = clock
                .deadline_ms
                .expect("the player's window has a deadline");
            let original = w.only_deadline(live.id);
            assert_eq!(
                (original.unit_id, original.window_seq, original.scheduled_at),
                (live.u1, clock.window_seq, time(deadline)),
                "PRECONDITION: one pending fire for the player's window"
            );
            let now = open + 1_000;
            assert!(
                now < deadline,
                "PRECONDITION: the call is strictly before the deadline"
            );

            let before = w.snapshot();
            assert_eq!(
                expire_now(&fx, owner(), now, live.id, SIDE_A),
                Ok(()),
                "the owner expires the player's window"
            );
            assert_eq!(
                changed(&before, &w.snapshot()),
                vec!["battle_clock", "tactical_deadline_sched"],
                "the call writes the clock and the schedule only"
            );
            let mut want = clock.clone();
            want.deadline_ms = Some(now);
            assert_eq!(
                enc(&w.clock_of(live.id, SideRow::A)),
                enc(&want),
                "the player's clock row differs only in deadline_ms == now"
            );
            let (kept, mut armed): (Vec<_>, Vec<_>) = w
                .deadlines_of(live.id)
                .into_iter()
                .partition(|r| r.scheduled_id == original.scheduled_id);
            assert_eq!(
                row_set(&kept),
                row_set(&[deadline_args(&original)]),
                "the original pending row stays"
            );
            assert_eq!(armed.len(), 1, "exactly one new deadline row");
            let armed = armed.remove(0);
            assert_eq!(
                (armed.unit_id, armed.window_seq, armed.scheduled_at),
                (live.u1, clock.window_seq, time(now))
            );

            let events_before = w.events_of(live.id).len();
            assert_eq!(fire_deadline(&fx, now, deadline_args(&armed)), Ok(()));
            let out = wild_fire_outcome(&w, live.id, events_before);
            assert_eq!(
                out.outcome,
                game_core::BattleOutcome::Fled,
                "wild expiry is AutoFlee"
            );
            assert_eq!(
                (out.phase, out.turn_state),
                (Phase::Finished, TurnState::NotActive)
            );
            let ends: Vec<(game_core::BattleOutcome, EndHow)> = out
                .fresh
                .iter()
                .filter_map(|p| match p {
                    EventPayload::BattleEnd(x) => Some((x.outcome, x.how)),
                    _ => None,
                })
                .collect();
            assert_eq!(
                ends,
                vec![(game_core::BattleOutcome::Fled, EndHow::AutoFlee)]
            );
            assert_eq!(out.hp, (175, 300), "the damaged HP is persisted");
            out
        };
        let twin = {
            let fx = fixture();
            let w = world(&fx);
            let live = wild_player_waiting(&fx, &w);
            let original = w.only_deadline(live.id);
            let deadline = w
                .clock_of(live.id, SideRow::A)
                .deadline_ms
                .expect("the player's window has a deadline");
            let events_before = w.events_of(live.id).len();
            assert_eq!(
                fire_deadline(&fx, deadline, deadline_args(&original)),
                Ok(()),
                "twin: the real deadline's fire"
            );
            wild_fire_outcome(&w, live.id, events_before)
        };
        assert_eq!(
            dev, twin,
            "the expiry's fire ends the battle as the real deadline does"
        );
    }

    // =======================================================================
    // th-4.4 — refusals: an exact Err, a structured reject line, no row written
    // =======================================================================

    /// Only the REGISTERED module owner is admitted: a participant (A, B), an identity in no
    /// battle, the database identity (the owner is a third identity) are refused; while `config`
    /// names the all-zero (unregistered) owner, the all-zero caller and the former owner are
    /// refused; with no `config` row the owner is refused. Positive control: the same state, the
    /// config owner restored, admits the owner.
    ///
    /// WRONG IMPL KILLED: no owner check; a check against `ctx.database_identity()` (`module()` is
    /// admitted, the owner refused); a participant check (A or B admitted); an equality check that
    /// admits the unregistered all-zero owner; a missing config row read as "anybody".
    #[test]
    fn every_caller_but_the_registered_owner_is_refused_th4_4() {
        let fx = fixture();
        let w = world(&fx);
        set_owner(&w, owner());
        let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
        let now = in_window(&w, live.id);
        let call = |who| Call {
            who,
            now,
            id: live.id,
            side: SIDE_A,
        };
        for (who, label) in [
            (a(), "participant A"),
            (b(), "participant B"),
            (c(), "an identity in no battle"),
            (module(), "the database identity, which is not the owner"),
        ] {
            assert_refused(&fx, &w, call(who), NOT_OWNER, label);
        }
        set_owner(&w, zero());
        assert_refused(
            &fx,
            &w,
            call(zero()),
            NOT_OWNER,
            "the all-zero caller while the owner is unregistered",
        );
        assert_refused(
            &fx,
            &w,
            call(owner()),
            NOT_OWNER,
            "the former owner while the owner is unregistered",
        );
        assert_eq!(w.configs.remove(0), 1, "fixture: the config row goes");
        assert_refused(
            &fx,
            &w,
            call(owner()),
            NOT_OWNER,
            "the owner with no config row",
        );
        w.configs.seed(&Config {
            id: 0,
            content_version: crate::CONTENT_VERSION,
            owner_identity: owner(),
        });
        assert_admitted(
            &fx,
            &w,
            call(owner()),
            "positive control: the registered owner",
        );
    }

    /// The deletion gate comes first: an owner whose account is pending deletion gets
    /// `REJECT_DELETION_GATED` (one reject line, no row), even with an out-of-range side. A
    /// stranger stays pending throughout; the owner's Active account is admitted.
    ///
    /// WRONG IMPL KILLED: no deletion gate; a gate after the other checks (the side-2 call would
    /// report the side); a table-wide gate (the stranger's pending row would refuse the Active
    /// owner); a re-typed reason instead of the constant.
    #[test]
    fn a_deletion_gated_owner_is_refused_th4_4() {
        let fx = fixture();
        let w = world(&fx);
        set_owner(&w, owner());
        let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
        let now = in_window(&w, live.id);
        w.accounts.seed(&crate::accounts::requested_deletion(
            crate::accounts::new_account_row(c(), String::new(), 0),
            1,
        ));
        w.accounts.seed(&crate::accounts::requested_deletion(
            crate::accounts::new_account_row(owner(), String::new(), 0),
            1,
        ));
        for side in [SIDE_A, 2] {
            assert_refused(
                &fx,
                &w,
                Call {
                    who: owner(),
                    now,
                    id: live.id,
                    side,
                },
                crate::guards::REJECT_DELETION_GATED,
                "the owner pending deletion",
            );
        }
        assert_eq!(
            w.accounts.remove(owner()),
            1,
            "fixture: the owner's pending row goes"
        );
        w.accounts
            .seed(&crate::accounts::new_account_row(owner(), String::new(), 0));
        assert_admitted(
            &fx,
            &w,
            Call {
                who: owner(),
                now,
                id: live.id,
                side: SIDE_A,
            },
            "positive control: the owner's Active account, a stranger pending",
        );
    }

    /// `side` must be 0 or 1, checked after the owner and before the battle: side 2 and 255 are
    /// refused on an Active battle with A's window open, side 2 on an unknown battle reports the
    /// side, a non-owner with side 2 reports the owner. Positive control: side 0.
    ///
    /// WRONG IMPL KILLED: any non-zero side read as B (side 2 would report the other side's
    /// window, not the range); a missing range check; the owner / side / battle checks out of
    /// order.
    #[test]
    fn an_out_of_range_side_is_refused_th4_4() {
        let fx = fixture();
        let w = world(&fx);
        set_owner(&w, owner());
        let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
        let now = in_window(&w, live.id);
        let call = |who, id, side| Call { who, now, id, side };
        assert_refused(&fx, &w, call(owner(), live.id, 2), BAD_SIDE, "side 2");
        assert_refused(&fx, &w, call(owner(), live.id, 255), BAD_SIDE, "side 255");
        assert_refused(
            &fx,
            &w,
            call(owner(), live.id + 1_000, 2),
            BAD_SIDE,
            "side 2 on an unknown battle: the side is checked first",
        );
        assert_refused(
            &fx,
            &w,
            call(a(), live.id, 2),
            NOT_OWNER,
            "a non-owner with side 2: the owner is checked first",
        );
        assert_admitted(
            &fx,
            &w,
            call(owner(), live.id, SIDE_A),
            "positive control: side 0",
        );
    }

    /// An unknown battle id is `no such tactical battle`; a Deploying PvP battle and a Finished
    /// battle are `battle is not active` for either side. Positive controls in the same family:
    /// the battle's own id; the same PvP battle once both sides deployed; the wild battle while it
    /// was still Active (that admitted expiry's fire is what finishes it).
    ///
    /// WRONG IMPL KILLED: a missing-row lookup that panics or reads another battle; a phase check
    /// missing (a Deploying battle reaching into the deploy clock, a Finished one re-armed); a
    /// Finished battle refused for the wrong reason (`no open turn window`).
    #[test]
    fn an_unknown_a_deploying_or_a_finished_battle_is_refused_th4_4() {
        {
            let fx = fixture();
            let w = world(&fx);
            set_owner(&w, owner());
            let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
            let now = in_window(&w, live.id);
            for id in [live.id + 1_000, 0] {
                assert_refused(
                    &fx,
                    &w,
                    Call {
                        who: owner(),
                        now,
                        id,
                        side: SIDE_A,
                    },
                    NO_BATTLE,
                    "an unknown battle id",
                );
            }
            assert_admitted(
                &fx,
                &w,
                Call {
                    who: owner(),
                    now,
                    id: live.id,
                    side: SIDE_A,
                },
                "positive control: the battle's own id",
            );
        }
        {
            let fx = fixture();
            let w = world(&fx);
            set_owner(&w, owner());
            let id = deploying_pvp(&fx, &w, &PAIR, &B_PAIR, 2);
            for side in [SIDE_A, SIDE_B] {
                assert_refused(
                    &fx,
                    &w,
                    Call {
                        who: owner(),
                        now: T0 + 1_000,
                        id,
                        side,
                    },
                    NOT_ACTIVE,
                    "a Deploying PvP battle",
                );
            }
            deploy(&fx, a(), T0 + 5_000, id, picks_in_order(&PAIR)).expect("A locks");
            deploy(&fx, b(), T0 + 5_000, id, picks_in_order(&B_PAIR)).expect("B locks");
            let now = in_window(&w, id);
            assert_admitted(
                &fx,
                &w,
                Call {
                    who: owner(),
                    now,
                    id,
                    side: SIDE_A,
                },
                "positive control: the same battle once Active",
            );
        }
        {
            let fx = fixture();
            let w = world(&fx);
            let live = wild_player_waiting(&fx, &w);
            let now = in_window(&w, live.id);
            let before: Vec<u64> = w
                .deadlines_of(live.id)
                .iter()
                .map(|r| r.scheduled_id)
                .collect();
            assert_admitted(
                &fx,
                &w,
                Call {
                    who: owner(),
                    now,
                    id: live.id,
                    side: SIDE_A,
                },
                "positive control: the wild battle while Active",
            );
            let armed = w
                .deadlines_of(live.id)
                .into_iter()
                .find(|r| !before.contains(&r.scheduled_id))
                .expect("the admitted expiry armed a fire");
            assert_eq!(fire_deadline(&fx, now, deadline_args(&armed)), Ok(()));
            assert_eq!(w.deadlines.remove(armed.scheduled_id), 1);
            assert_eq!(
                w.tactical(live.id).phase,
                Phase::Finished,
                "PRECONDITION: the fire finished the battle"
            );
            for side in [SIDE_A, SIDE_B] {
                assert_refused(
                    &fx,
                    &w,
                    Call {
                        who: owner(),
                        now: now + 1_000,
                        id: live.id,
                        side,
                    },
                    NOT_ACTIVE,
                    "a Finished battle",
                );
            }
        }
    }

    /// An Active battle with no open window is `no open turn window` for either side: at a round
    /// boundary (`Advancing`, before the advance fires), and with the waiting unit's clock row
    /// holding no window. Positive controls: the same battle once the next round opens; the clock
    /// row restored.
    ///
    /// WRONG IMPL KILLED: a reducer that trusts `turn_state` alone (the cleared clock row would be
    /// given a deadline with no window); one that trusts the clock alone; one that picks "any"
    /// clock row; the window check placed after the side check (side 1 at A's cleared window would
    /// report the other side).
    #[test]
    fn a_battle_with_no_open_window_is_refused_th4_4() {
        {
            let fx = fixture();
            let w = world(&fx);
            set_owner(&w, owner());
            let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
            let mut now = live.revealed_at;
            for _ in 0..4 {
                let u = waiting(&w, live.id);
                let who = if w.unit(u).side == SideRow::A {
                    a()
                } else {
                    b()
                };
                now = now.max(window_of(&w, live.id, u).window_open_ms.expect("open")) + 1_000;
                submit(&fx, who, now, live.id, u, vec![QueuedAction::EndTurn])
                    .expect("every unit ends its turn live");
            }
            let t = w.tactical(live.id);
            assert_eq!(
                (t.phase, t.turn_state),
                (Phase::Active, TurnState::Advancing),
                "PRECONDITION: round 1 is over, the next has not started"
            );
            for side in [SIDE_A, SIDE_B] {
                assert_refused(
                    &fx,
                    &w,
                    Call {
                        who: owner(),
                        now: now + 500,
                        id: live.id,
                        side,
                    },
                    NO_WINDOW,
                    "a round boundary",
                );
            }
            let adv = w.advances_of(live.id);
            assert_eq!(adv.len(), 1, "PRECONDITION: one advance row");
            fire_advance(&fx, now + 1_000, advance_args(&adv[0])).expect("the next round starts");
            assert_eq!(
                w.unit(waiting(&w, live.id)).side,
                SideRow::A,
                "PRECONDITION: A's faster unit opens the round"
            );
            let now = in_window(&w, live.id);
            assert_admitted(
                &fx,
                &w,
                Call {
                    who: owner(),
                    now,
                    id: live.id,
                    side: SIDE_A,
                },
                "positive control: the next round's window",
            );
        }
        {
            let fx = fixture();
            let w = world(&fx);
            set_owner(&w, owner());
            let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
            let now = in_window(&w, live.id);
            let saved = w.clock_of(live.id, SideRow::A);
            w.edit_clock_of(live.id, SideRow::A, |c| {
                c.window_open_ms = None;
                c.deadline_ms = None;
            });
            for side in [SIDE_A, SIDE_B] {
                assert_refused(
                    &fx,
                    &w,
                    Call {
                        who: owner(),
                        now,
                        id: live.id,
                        side,
                    },
                    NO_WINDOW,
                    "A waits but its clock row holds no window",
                );
            }
            w.edit_clock_of(live.id, SideRow::A, |c| {
                c.window_open_ms = saved.window_open_ms;
                c.deadline_ms = saved.deadline_ms;
            });
            assert_eq!(
                enc(&w.clock_of(live.id, SideRow::A)),
                enc(&saved),
                "fixture: the clock row is restored"
            );
            assert_admitted(
                &fx,
                &w,
                Call {
                    who: owner(),
                    now,
                    id: live.id,
                    side: SIDE_A,
                },
                "positive control: the restored window",
            );
        }
    }

    /// A call naming the side whose window is NOT open is `the other side's window is open`: PvP
    /// with A waiting and side 1, PvP with B waiting and side 0, wild with the player waiting and
    /// side 1. Positive controls: the same state with the right side.
    ///
    /// WRONG IMPL KILLED: a reducer that ignores `side` (it would strike the waiting player
    /// whatever the caller named — the slow-test hazard the side exists for); one that reads the
    /// NAMED side's clock (it would report `no open turn window`); a side mapping inverted.
    #[test]
    fn the_other_sides_open_window_is_refused_th4_4() {
        {
            let fx = fixture();
            let w = world(&fx);
            set_owner(&w, owner());
            let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
            let now = in_window(&w, live.id);
            let call = |side| Call {
                who: owner(),
                now,
                id: live.id,
                side,
            };
            assert_refused(
                &fx,
                &w,
                call(SIDE_B),
                OTHER_SIDE,
                "PvP: A waits, side 1 named",
            );
            assert_admitted(&fx, &w, call(SIDE_A), "positive control: side 0");
        }
        {
            let fx = fixture();
            let w = world(&fx);
            let (live, _) = pvp_b_waiting(&fx, &w);
            let now = in_window(&w, live.id);
            let call = |side| Call {
                who: owner(),
                now,
                id: live.id,
                side,
            };
            assert_refused(
                &fx,
                &w,
                call(SIDE_A),
                OTHER_SIDE,
                "PvP: B waits, side 0 named",
            );
            assert_admitted(&fx, &w, call(SIDE_B), "positive control: side 1");
        }
        {
            let fx = fixture();
            let w = world(&fx);
            let live = wild_player_waiting(&fx, &w);
            let now = in_window(&w, live.id);
            let call = |side| Call {
                who: owner(),
                now,
                id: live.id,
                side,
            };
            assert_refused(
                &fx,
                &w,
                call(SIDE_B),
                OTHER_SIDE,
                "wild: the player waits, side 1",
            );
            assert_admitted(&fx, &w, call(SIDE_A), "positive control: side 0");
        }
    }

    /// An open window whose pending deadline row is missing is `no pending deadline for the open
    /// window` — with no row at all, with a row of the same `window_seq` pinned to another unit
    /// (B's, whose own count can carry the same number), with a row of the waiting unit at an
    /// older `window_seq`, and with a matching pin on another battle. Positive control: the
    /// original row restored.
    ///
    /// WRONG IMPL KILLED: a reducer that arms without checking the pending row; a match on
    /// `window_seq` alone (B's row), on the unit alone (the stale row), or on any battle's rows.
    #[test]
    fn an_open_window_without_its_pending_deadline_row_is_refused_th4_4() {
        let fx = fixture();
        let w = world(&fx);
        set_owner(&w, owner());
        let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
        let now = in_window(&w, live.id);
        let unit = waiting(&w, live.id);
        let seq = w.clock_of(live.id, SideRow::A).window_seq;
        assert!(
            seq >= 1,
            "PRECONDITION: the open window has a sequence number"
        );
        let original = w.only_deadline(live.id);
        assert_eq!(
            (original.unit_id, original.window_seq),
            (unit, seq),
            "PRECONDITION: the pending row pins the open window"
        );
        let call = Call {
            who: owner(),
            now,
            id: live.id,
            side: SIDE_A,
        };
        assert_eq!(w.deadlines.remove(original.scheduled_id), 1);
        assert_refused(&fx, &w, call, NO_PENDING, "no deadline row at all");
        let decoys = [
            (
                9_001,
                live.id,
                live.b[0],
                seq,
                "B's unit at the same window_seq",
            ),
            (
                9_002,
                live.id,
                unit,
                seq - 1,
                "the waiting unit at an older window_seq",
            ),
            (
                9_003,
                live.id + 1_000,
                unit,
                seq,
                "the right pin on another battle",
            ),
        ];
        for (sid, battle_id, unit_id, window_seq, label) in decoys {
            w.deadlines.seed(&crate::tactics::TacticalDeadlineSched {
                scheduled_id: sid,
                scheduled_at: original.scheduled_at,
                battle_id,
                unit_id,
                window_seq,
            });
            assert_refused(&fx, &w, call, NO_PENDING, label);
            assert_eq!(w.deadlines.remove(sid), 1, "fixture: the decoy row goes");
        }
        w.deadlines.seed(&deadline_args(&original));
        assert_admitted(&fx, &w, call, "positive control: the original row restored");
    }

    /// Every caller but the registered owner: both participants, a stranger, the database
    /// identity.
    fn non_owners() -> [(Identity, &'static str); 4] {
        [
            (a(), "participant A"),
            (b(), "participant B"),
            (c(), "an identity in no battle"),
            (module(), "the database identity"),
        ]
    }

    /// Every non-owner, with side 0, 1 and the out-of-range 2, on battle `id` at `now`, is refused
    /// with exactly `caller is not the module owner`, writes nothing, logs one reject line.
    fn refuse_every_non_owner(fx: &Fixture, w: &World<'_>, now: i64, id: u64, state: &str) {
        for (who, name) in non_owners() {
            for side in [SIDE_A, SIDE_B, 2] {
                let label = format!("{state}: {name}, side {side}");
                assert_refused(fx, w, Call { who, now, id, side }, NOT_OWNER, &label);
            }
        }
    }

    /// A 2v2 PvP battle owned by `owner()` at its first round boundary: every unit ended its turn
    /// live, the battle is Active and `Advancing`, the advance row not fired. Returns the battle id
    /// and a call time.
    fn pvp_advancing(fx: &Fixture, w: &World<'_>) -> (u64, i64) {
        set_owner(w, owner());
        let live = live_pvp(fx, w, &PAIR, &B_PAIR);
        let mut now = live.revealed_at;
        for _ in 0..4 {
            let u = waiting(w, live.id);
            let who = if w.unit(u).side == SideRow::A {
                a()
            } else {
                b()
            };
            now = now.max(window_of(w, live.id, u).window_open_ms.expect("open")) + 1_000;
            submit(fx, who, now, live.id, u, vec![QueuedAction::EndTurn])
                .expect("every unit ends its turn live");
        }
        let t = w.tactical(live.id);
        assert_eq!(
            (t.phase, t.turn_state),
            (Phase::Active, TurnState::Advancing),
            "PRECONDITION: round 1 is over, the next has not started"
        );
        (live.id, now + 500)
    }

    /// A wild battle owned by `owner()`, finished by the owner's expiry and its fire. Returns the
    /// battle id and a call time after the finish.
    fn wild_finished(fx: &Fixture, w: &World<'_>) -> (u64, i64) {
        let live = wild_player_waiting(fx, w);
        let now = in_window(w, live.id);
        expire_and_fire(fx, w, live.id, SIDE_A, now);
        assert_eq!(
            w.tactical(live.id).phase,
            Phase::Finished,
            "PRECONDITION: the fire finished the battle"
        );
        (live.id, now + 1_000)
    }

    /// No non-owner is admitted, whichever `side` it names and whichever side's window is open:
    /// participant A, participant B, a stranger and the database identity, with side 0, 1 (and 2),
    /// in a PvP battle with A's unit waiting and in one with B's unit waiting, are each refused
    /// `caller is not the module owner` with no row written (so no fire is armed) and one reject
    /// line. Positive control in each state: the owner naming the waiting side is admitted.
    ///
    /// WRONG IMPL KILLED: the owner check skipped for one `side` value (`if !is_owner && side !=
    /// 1`, or `!= 0`): the skipped side reaches its own window in one of the two states and is
    /// admitted; an owner check that admits a participant only for its own side's window.
    #[test]
    fn no_non_owner_is_admitted_for_either_side_in_either_window_th4_4() {
        {
            let fx = fixture();
            let w = world(&fx);
            set_owner(&w, owner());
            let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
            assert_eq!(
                w.unit(waiting(&w, live.id)).side,
                SideRow::A,
                "PRECONDITION: A's unit waits"
            );
            let now = in_window(&w, live.id);
            refuse_every_non_owner(&fx, &w, now, live.id, "A's window open");
            assert_admitted(
                &fx,
                &w,
                Call {
                    who: owner(),
                    now,
                    id: live.id,
                    side: SIDE_A,
                },
                "positive control: the owner, A's window, side 0",
            );
        }
        {
            let fx = fixture();
            let w = world(&fx);
            let (live, _) = pvp_b_waiting(&fx, &w);
            let now = in_window(&w, live.id);
            refuse_every_non_owner(&fx, &w, now, live.id, "B's window open");
            assert_admitted(
                &fx,
                &w,
                Call {
                    who: owner(),
                    now,
                    id: live.id,
                    side: SIDE_B,
                },
                "positive control: the owner, B's window, side 1",
            );
        }
    }

    /// A non-owner learns no battle state: with (a) an unknown battle id, (b) a Deploying PvP
    /// battle, (c) a Finished battle, (d) an Active battle at a round boundary (`Advancing`, no
    /// open window), and with an open window, every non-owner with side 0, 1 and 2 gets exactly
    /// `caller is not the module owner` and writes nothing. Positive controls: the owner, in the
    /// same states, gets each state's own reason (`no such tactical battle`, `battle is not
    /// active`, `no open turn window`, `side must be 0 or 1`) — the reasons a leaky check would
    /// hand the non-owner.
    ///
    /// WRONG IMPL KILLED: the owner check applied only once the battle is found (an unknown id
    /// reports `no such tactical battle`), only for an Active battle (`battle is not active`),
    /// only when some clock row holds an open window (`no open turn window` at a boundary, on a
    /// Finished battle), or after the side range check (`side must be 0 or 1`).
    #[test]
    fn a_non_owner_learns_no_battle_state_from_the_refusal_th4_4() {
        {
            let fx = fixture();
            let w = world(&fx);
            set_owner(&w, owner());
            let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
            let now = in_window(&w, live.id);
            let unknown = live.id + 1_000;
            refuse_every_non_owner(&fx, &w, now, unknown, "an unknown battle id");
            refuse_every_non_owner(&fx, &w, now, live.id, "an open window");
            let owner_call = |id, side| Call {
                who: owner(),
                now,
                id,
                side,
            };
            assert_refused(
                &fx,
                &w,
                owner_call(unknown, SIDE_A),
                NO_BATTLE,
                "control: the owner on the unknown id",
            );
            assert_refused(
                &fx,
                &w,
                owner_call(live.id, 2),
                BAD_SIDE,
                "control: the owner with side 2 on the open window",
            );
        }
        {
            let fx = fixture();
            let w = world(&fx);
            set_owner(&w, owner());
            let id = deploying_pvp(&fx, &w, &PAIR, &B_PAIR, 2);
            let now = T0 + 1_000;
            refuse_every_non_owner(&fx, &w, now, id, "a Deploying PvP battle");
            assert_refused(
                &fx,
                &w,
                Call {
                    who: owner(),
                    now,
                    id,
                    side: SIDE_A,
                },
                NOT_ACTIVE,
                "control: the owner on the Deploying battle",
            );
        }
        {
            let fx = fixture();
            let w = world(&fx);
            let (id, now) = wild_finished(&fx, &w);
            refuse_every_non_owner(&fx, &w, now, id, "a Finished battle");
            assert_refused(
                &fx,
                &w,
                Call {
                    who: owner(),
                    now,
                    id,
                    side: SIDE_A,
                },
                NOT_ACTIVE,
                "control: the owner on the Finished battle",
            );
        }
        {
            let fx = fixture();
            let w = world(&fx);
            let (id, now) = pvp_advancing(&fx, &w);
            refuse_every_non_owner(&fx, &w, now, id, "a round boundary");
            assert_refused(
                &fx,
                &w,
                Call {
                    who: owner(),
                    now,
                    id,
                    side: SIDE_A,
                },
                NO_WINDOW,
                "control: the owner at the round boundary",
            );
        }
    }

    /// A waiting unit whose `battle_unit` row is missing has no open turn window: the owner's call
    /// naming either side is `no open turn window` with no row written. The state is a row edit,
    /// unreachable through the shipped reducers (a waiting unit always has its row), like the
    /// cleared clock row above. Positive control: the unit row restored admits the call.
    ///
    /// WRONG IMPL KILLED: the missing-unit refusal given another reason (`no such tactical
    /// battle`, `the other side's window is open`, ...); a missing unit row read as "any side" (a
    /// fire armed for a unit the battle no longer has); a lookup that panics.
    #[test]
    fn a_waiting_unit_without_its_battle_unit_row_has_no_open_window_th4_4() {
        let fx = fixture();
        let w = world(&fx);
        set_owner(&w, owner());
        let live = live_pvp(&fx, &w, &PAIR, &B_PAIR);
        let now = in_window(&w, live.id);
        let unit = waiting(&w, live.id);
        let saved = w.unit(unit);
        assert_eq!(
            w.units.remove(unit),
            1,
            "fixture: the waiting unit's battle_unit row goes"
        );
        for side in [SIDE_A, SIDE_B] {
            assert_refused(
                &fx,
                &w,
                Call {
                    who: owner(),
                    now,
                    id: live.id,
                    side,
                },
                NO_WINDOW,
                "the waiting unit has no battle_unit row",
            );
        }
        w.units.seed(&saved);
        assert_admitted(
            &fx,
            &w,
            Call {
                who: owner(),
                now,
                id: live.id,
                side: SIDE_A,
            },
            "positive control: the unit row restored",
        );
    }

    // =======================================================================
    // th-4.5 — the original pin is stale after the expiry
    // =======================================================================

    /// After an owner expiry and its fire, a fire carrying the ORIGINAL row's `(unit_id,
    /// window_seq)` changes nothing (whole-world snapshot) and returns `Ok`: in a 2v2 battle at the
    /// original real deadline (B's next unit waits), and in the strongest form, a 1v1 battle driven
    /// until the SAME B unit holds its NEXT window (`window_seq` one higher) — the stale fire names
    /// the waiting unit and still changes nothing, at the original deadline and at the new
    /// window's own deadline.
    ///
    /// WRONG IMPL KILLED: an expiry that rewinds or keeps `window_seq` (the stale pin would match
    /// the next window and strike B a second time); an expiry that re-points the original row at
    /// the new window instead of arming a fresh one; a fire that the original row still re-arms.
    #[test]
    fn a_fire_carrying_the_expired_windows_original_pin_changes_nothing_th4_5() {
        {
            let fx = fixture();
            let w = world(&fx);
            let (live, cursor) = pvp_b_waiting(&fx, &w);
            let original = w.only_deadline(live.id);
            let clock = w.clock_of(live.id, SideRow::B);
            let deadline = clock.deadline_ms.expect("B's window has a deadline");
            let now = clock
                .window_open_ms
                .expect("B's window is open")
                .max(cursor)
                + 1_000;
            expire_and_fire(&fx, &w, live.id, SIDE_B, now);
            assert_eq!(
                waiting(&w, live.id),
                live.b[1],
                "PRECONDITION: B's next unit waits"
            );
            let before = w.snapshot();
            assert_eq!(
                fire_deadline(&fx, deadline, deadline_args(&original)),
                Ok(()),
                "2v2: the stale fire is Ok"
            );
            assert_eq!(
                changed(&before, &w.snapshot()),
                none(),
                "2v2: the stale fire at the original deadline changes nothing"
            );
        }
        {
            let fx = fixture();
            let w = world(&fx);
            set_owner(&w, owner());
            let live = live_pvp(&fx, &w, &PAIR[..1], &B_PAIR[..1]);
            let mut now = live.revealed_at;
            let (unit, _) = drive_to_b_window(&fx, &w, live.id, &mut now);
            assert_eq!(unit, live.b[0], "PRECONDITION: B's one unit waits");
            let first = w.clock_of(live.id, SideRow::B);
            let original = w.only_deadline(live.id);
            assert_eq!(
                (original.unit_id, original.window_seq),
                (unit, first.window_seq),
                "PRECONDITION: the pending row pins B's window"
            );
            let deadline = first.deadline_ms.expect("B's window has a deadline");
            now = now.max(first.window_open_ms.expect("B's window is open")) + 1_000;
            expire_and_fire(&fx, &w, live.id, SIDE_B, now);
            let (again, _) = drive_to_b_window(&fx, &w, live.id, &mut now);
            let next = w.clock_of(live.id, SideRow::B);
            assert_eq!(
                (again, next.window_seq),
                (unit, original.window_seq + 1),
                "PRECONDITION: the SAME B unit holds its NEXT window"
            );
            let next_deadline = next.deadline_ms.expect("B's next window has a deadline");
            assert!(
                now < deadline,
                "PRECONDITION: B's next window is open at the original deadline"
            );
            for at_ms in [deadline, next_deadline] {
                let before = w.snapshot();
                assert_eq!(
                    fire_deadline(&fx, at_ms, deadline_args(&original)),
                    Ok(()),
                    "1v1: the stale fire at {at_ms} is Ok"
                );
                assert_eq!(
                    changed(&before, &w.snapshot()),
                    none(),
                    "1v1: the stale fire at {at_ms} names the waiting unit and changes nothing"
                );
            }
        }
    }
}
