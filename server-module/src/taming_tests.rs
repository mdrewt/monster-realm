//! `taming` domain-submodule tests (M8.9c — test relocation).
//!
//! Extracted verbatim from the former inline `#[cfg(test)] mod tests` in
//! `taming.rs`; every assertion, fixture, and helper is unchanged. Declared
//! from `taming.rs` as `#[path = "taming_tests.rs"] mod taming_tests;`, so
//! `super` still resolves to `taming` exactly as the inline module did.

// =========================================================================
// the para-4.7 deletion gate on `grant_bait`.
//
// E1 names "the taming recruit grant_item path". MEASURED FINDING:
// that path is a MISATTRIBUTION — no recruit path calls `grant_item`. The ONE
// `grant_item(` call in `taming.rs` is inside `grant_bait`, a
// `cfg(feature = "dev_reducers")` DEV reducer that credits the CALLER's own
// `inventory` (an ERASE-policy table) with up to 99 items per call. It is gated
// here on the `battle::start_wild_battle` precedent (ADR-0236 D2/D3: a dev-only
// reducer that ships in the CI-built dev wasm gets the same gate as a
// client-callable one).
//
// `attempt_recruit` was CLASSIFY-OPEN here. rb-128
// withdrew that classification on ADR-0258 D6's basis: on success
// it inserts a NEW `monster` and `monster_pub` for the caller — it creates the
// caller's assets, which is what separates class (iv) from the in-battle class
// (i) — so it is now gated as its first statement. PRV1-10 still holds: the
// already-open wild battle stays finishable through the ungated `submit_attack`,
// `swap_active`, `flee` and `use_battle_item`; only the recruit is refused. The
// behavioural recruit suite is the `nh` module at the end of this file; the executed matrix lives in `guards_tests.rs`.
//
// HONEST LIMITS. The executed matrix
// (the test below, the crate's first `cfg(feature = "dev_reducers")`
// test) reads behaviour but stops at the first guard PAST the gate: `item_row`
// is `u32`-keyed, the fixture keys rows by the indexed column, an unregistered
// index yields no rows in this host, and every write syscall ABORTS the process
// (uncatchable, so `#[should_panic]` is unavailable). It proves a deletion-gated
// caller is REFUSED exactly where an admitted one is let through — not that an
// item stack changed.
// =========================================================================

/// `grant_bait` refuses a deletion-gated caller, ADMITS
/// everybody else, and answers from the CALLER's own row.
///
/// THE CRATE'S FIRST `cfg(feature = "dev_reducers")` TEST, because the
/// reducer it calls only exists under that feature: `cargo nextest run
/// --workspace` does not compile it, `just lint` (clippy `--all-features`) does,
/// and CI builds the dev wasm for the e2e suite. Its seed helpers are INLINED
/// rather than shared with the other tests here so the DEFAULT build carries no
/// `dead_code` under `-D warnings`. Run it with
/// `cargo nextest run -p monster-realm-module --features dev_reducers`.
///
/// Five account states with a mid-grace STRANGER row present throughout; the
/// three admitted states are the positive control and they are what make the two
/// refused states mean anything. WHY THE ADMITTED STATES ERR: `item_row` is
/// `u32`-keyed and the fixture keys rows by the indexed column, so that index is
/// never registered, an unregistered index yields no rows in this host, and the
/// reducer stops at the item lookup — ONE guard past the gate and before the
/// bait-classification check and the credit. Every write syscall ABORTS the
/// process (uncatchable), which is why this test asserts refusals and admissions
/// and nothing deeper. The ordinary error is pinned EXACTLY rather than as
/// any-error: otherwise a regression that turned the item lookup into a different
/// rejection would masquerade as a pass in all three admitted states.
///
/// kills: M4 (the dropped gate) · M5 (a discarded verdict) · M8 (an unreachable
/// placement) · M11 (a constant reject in `guards` — the three admitted states) ·
/// M12 (inverted polarity, invisible to every source pin in this slice — the
/// `Active` and no-row states would return the deletion reject, which breaks
/// `client/e2e/recruit.spec.ts`, whose caller holds an Active account) · a
/// row-EXISTS-keyed fake (the `Active` state) · a TABLE-WIDE or any-row-pending
/// fake (the three admitted states, while the stranger is mid-grace) · a latched
/// or memoised answer (the removed-row state).
#[cfg(feature = "dev_reducers")]
#[test]
fn rb80_grant_bait_is_refused_only_while_the_caller_is_deletion_gated() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();

    let call = || crate::taming::grant_bait(&ctx, 1, 1);

    let ordinary: Result<(), String> = Err("item not found".to_string());
    let gated: Result<(), String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());

    let active = crate::accounts::new_account_row(me, String::new(), 0);
    let pending = crate::accounts::requested_deletion(active.clone(), 1);
    let terminal = crate::accounts::terminal_account(pending.clone(), 2);

    // Inlined mid-grace STRANGER row: present in every one of the five states and
    // never removed, so the account table is never empty of deleting rows.
    // Without it a TABLE-keyed gate — refuse if ANYBODY is deleting — is
    // observationally identical to the caller-keyed one everywhere below.
    // `remove` and `find` are Identity-keyed, so this row never disturbs the
    // per-state `remove(me) == 1` assertions. Inlined rather than shared because
    // the default build compiles neither this test nor a helper it alone uses.
    let stranger = spacetimedb::Identity::from_byte_array([9u8; 32]);
    acct.seed(&crate::accounts::requested_deletion(
        crate::accounts::new_account_row(stranger, String::new(), 0),
        1,
    ));

    // --- State 1: no account row for the caller (a guest) -------------------
    let got = call();
    assert_eq!(
        got,
        ordinary,
        "rb-80 E1 FAIL (admitted state, no account row): `grant_bait` returned {got:?} for a \
         caller with NO account row, while a STRANGER's row is mid-grace. A caller who never \
         authenticated is not inside the deletion gate and must be admitted into the ordinary \
         guard chain; the expected error is the item lookup's. A deletion reject here means the \
         gate answers from the TABLE rather than from the caller's own row. Indexes the generated \
         code asked the host for: {:?}",
        fx.requested_indexes()
    );

    // --- State 2: an Active account row --------------------------------------
    acct.seed(&active);
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-80 E1 FAIL (admitted state, Active account): `grant_bait` returned {got:?} for a \
         caller whose account row is `Active` (a stranger's row is mid-grace). This is the \
         ordinary dev/e2e caller — `client/e2e/recruit.spec.ts` grants bait with an Active \
         account — and refusing them breaks the recruit e2e while every source pin in this slice \
         reports the gate as correctly wired: the call text is byte-identical whichever way the \
         decision runs. It is also exactly what a row-EXISTS-keyed fake produces, what an \
         any-row-pending TABLE scan produces, and what an inverted branch produces."
    );

    // --- State 3: mid-grace (PendingDeletion) --------------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-80 fixture: exactly one `Active` account row was seeded for the CALLER and must be \
         removed before the next state is pushed — `seed` appends rather than upserting, so a \
         miscount would leave two rows for one identity and the unique-index lookup would assert \
         instead of answering. `remove` is Identity-keyed, so the stranger's row is deliberately \
         untouched and must never be counted here."
    );
    acct.seed(&pending);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-80 E1 FAIL (refused state, mid-grace): `grant_bait` returned {got:?} for a caller \
         whose account is `PendingDeletion`; it must return the module's single static deletion \
         reject. THIS IS THE RED STATE AT HEAD — at HEAD `grant_bait` carries no deletion gate, so \
         a mid-grace account can still mint itself 99 items per call into an `inventory` the \
         cascade is about to erase. The expected value is compared against the CONSTANT, never a \
         re-typed literal, so a reworded reason cannot drift silently into text no client ever \
         receives."
    );

    // --- State 4: terminal (PendingDeletion + the marker) -------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-80 fixture: exactly one `PendingDeletion` account row was seeded for the CALLER and \
         must be removed before the terminal row is pushed (`seed` appends, it never upserts; the \
         stranger's row is Identity-keyed and stays put)."
    );
    acct.seed(&terminal);
    let got = call();
    assert_eq!(
        got, gated,
        "rb-80 E1 FAIL (refused state, terminal): `grant_bait` returned {got:?} for a caller \
         whose account carries the M22 terminal marker. An already-erased account has no \
         inventory left — the cascade deleted it — so a grant here would recreate rows the \
         deletion just removed. The pure decision is an explicit disjunction \
         (`accounts::should_reject_for_deletion`) precisely so this state is fail-closed even on \
         the illegal `Active`-plus-marker shape."
    );

    // --- State 5: the caller's row is gone again -----------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-80 fixture: exactly one terminal account row was seeded for the CALLER and must be \
         removable; the stranger's mid-grace row stays."
    );
    let got = call();
    assert_eq!(
        got, ordinary,
        "rb-80 E1 FAIL (admitted state, row removed): `grant_bait` returned {got:?} once the \
         caller's account row was gone again (the stranger's mid-grace row is still there). The \
         verdict must track LIVE rows FOR THE CALLER: an answer that latches on a row it has \
         already seen — a memoised predicate, a cached decision, a process-wide flag — would keep \
         refusing this identity forever, and an any-row-pending answer would refuse it because of \
         somebody else. No state above can distinguish either of those from a correct gate on its \
         own."
    );
}

// ===========================================================================
// Native-host behavioural suite (debloat Phase 2: EV-recruit-reducer-security,
// ST-taming_tests).
//
// The SHIPPED `attempt_recruit` runs through `Fixture::run_as_at` with a real
// sender. DETERMINISM: the bait's `recruit_bonus` is 1000, so
// `recruit_chance` clamps to 1000 per-mille and the recruit succeeds whatever
// `ctx.random()` draws. HOST LIMIT: no rollback, so every rejection is refusal
// BEFORE any write — including before the roll (no playtest_event row). The
// failed-roll branch (resolve_recruit_failure) is covered by game-core.
// ===========================================================================
mod nh {
    use crate::marshal::pub_from_monster;
    use crate::native_host_tests::{fixture, Fixture, Handle};
    use crate::playtest::PlaytestEvent;
    use crate::schema::{
        Battle, BattleWild, Inventory, ItemRow, Monster, MonsterPub, SpeciesRow, TradeOffer,
    };
    use crate::taming::attempt_recruit;
    use crate::PARTY_SLOT_NONE;
    use game_core::{Affinity, BattleOutcome, TradeItem, TradeStatus};
    use spacetimedb::sats::bsatn::to_vec;
    use spacetimedb::{Identity, Timestamp};

    const T0: i64 = 1_750_000_000_000;
    const BATTLE: u64 = 7;
    const BAIT: u32 = 9;
    const NOT_BAIT: u32 = 8;
    const WILD_SPECIES: u32 = 5;

    fn a() -> Identity {
        Identity::from_byte_array([0xA1; 32])
    }
    fn b() -> Identity {
        Identity::from_byte_array([0xB2; 32])
    }
    fn at(ms: i64) -> Timestamp {
        Timestamp::from_micros_since_unix_epoch(ms * 1000)
    }

    fn item(id: u32, recruit_bonus: u16) -> ItemRow {
        ItemRow {
            id,
            name: format!("i{id}"),
            description: String::new(),
            recruit_bonus,
            train_stat: None,
            train_amount: 0,
            sell_price: 0,
            cure_status: None,
        }
    }

    fn party_monster(owner: Identity) -> Monster {
        Monster {
            monster_id: 11,
            owner_identity: owner,
            species_id: 1,
            nickname: "m11".to_string(),
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
            current_hp: 33,
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
        }
    }

    fn bm(species_id: u32, current_hp: u16) -> game_core::BattleMonster {
        game_core::BattleMonster {
            species_id,
            affinity: Affinity::Fire,
            level: 7,
            current_hp,
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
        }
    }

    /// A's wild battle: A's monster 11 on side A at 12 HP vs a full-HP wild.
    fn wild_battle(outcome: BattleOutcome) -> Battle {
        Battle {
            battle_id: BATTLE,
            player_identity: a(),
            opponent_identity: crate::WILD_IDENTITY,
            state: game_core::BattleState {
                side_a: game_core::BattleSide {
                    active: 0,
                    team: vec![bm(1, 12)],
                },
                side_b: game_core::BattleSide {
                    active: 0,
                    team: vec![bm(WILD_SPECIES, 30)],
                },
                outcome,
                turn_number: 1,
                weather: None,
            },
            party_monster_ids: vec![11],
            opponent_monster_ids: vec![],
            created_at_ms: 0,
        }
    }

    struct World<'a> {
        battles: Handle<'a, Battle, u64>,
        wilds: Handle<'a, BattleWild, u64>,
        monsters: Handle<'a, Monster, u64>,
        pubs: Handle<'a, MonsterPub, u64>,
        stacks: Handle<'a, Inventory>,
        offers: Handle<'a, TradeOffer>,
        events: Handle<'a, PlaytestEvent, u64>,
    }

    /// A ready-to-succeed recruit: battle + battle_wild + bait stack of 2.
    fn world(fx: &Fixture) -> World<'_> {
        let items = fx.table_keyed::<ItemRow, u32>("item_row", "id", |r| r.id);
        items.seed(&item(BAIT, 1000));
        items.seed(&item(NOT_BAIT, 0));
        let species = fx.table_keyed::<SpeciesRow, u32>("species_row", "id", |r| r.id);
        species.seed(&SpeciesRow {
            id: WILD_SPECIES,
            name: "wild".to_string(),
            base_hp: 40,
            base_attack: 41,
            base_defense: 42,
            base_speed: 43,
            base_sp_attack: 44,
            base_sp_defense: 45,
            affinity: Affinity::Water,
            learnable_skill_ids: vec![1],
            ability: None,
            tier: 2,
        });
        let _ = fx
            .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
            .writable()
            .unique()
            .auto_inc(|r| r.inv_id, |r, id| r.inv_id = id);
        let _ = fx.table::<TradeOffer>("trade_offer", "counterparty", |r| r.counterparty);
        let w = World {
            battles: fx
                .table_keyed::<Battle, u64>("battle", "battle_id", |r| r.battle_id)
                .writable()
                .unique(),
            wilds: fx
                .table_keyed::<BattleWild, u64>("battle_wild", "battle_id", |r| r.battle_id)
                .writable()
                .unique(),
            monsters: fx
                .table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id)
                .writable()
                .unique()
                .auto_inc(|r| r.monster_id, |r, id| r.monster_id = id),
            pubs: fx
                .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
                .writable()
                .unique(),
            stacks: fx.table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity),
            offers: fx.table::<TradeOffer>("trade_offer", "initiator", |r| r.initiator),
            events: fx
                .table_keyed::<PlaytestEvent, u64>("playtest_event", "event_id", |r| r.event_id)
                .writable()
                .unique()
                .auto_inc(|r| r.event_id, |r, id| r.event_id = id),
        };
        w.battles.seed(&wild_battle(BattleOutcome::Ongoing));
        w.wilds.seed(&BattleWild {
            battle_id: BATTLE,
            wild_species_id: WILD_SPECIES,
            wild_level: 4,
            individuality_seed: 0xBEEF,
        });
        let m = party_monster(a());
        w.pubs.seed(&pub_from_monster(&m, 0));
        w.monsters.seed(&m);
        w.stack(a(), BAIT, 2);
        w
    }

    impl World<'_> {
        fn stack(&self, owner: Identity, item_id: u32, count: u32) {
            self.stacks.seed(&Inventory {
                inv_id: 1000 + u64::from(owner.to_byte_array()[0]) * 100 + u64::from(item_id),
                owner_identity: owner,
                item_id,
                count,
            });
        }
        fn count(&self, owner: Identity, item_id: u32) -> u32 {
            self.stacks
                .rows()
                .iter()
                .filter(|r| r.owner_identity == owner && r.item_id == item_id)
                .map(|r| r.count)
                .sum()
        }
        fn snapshot(&self) -> Vec<Vec<u8>> {
            vec![
                to_vec(&self.battles.rows()).unwrap(),
                to_vec(&self.wilds.rows()).unwrap(),
                to_vec(&self.monsters.rows()).unwrap(),
                to_vec(&self.pubs.rows()).unwrap(),
                to_vec(&self.stacks.rows()).unwrap(),
                to_vec(&self.events.rows()).unwrap(),
            ]
        }
    }

    /// Success: the bait is spent, the roll is recorded once, the recruit lands
    /// in A's BOX with a fresh-tier public row, the battle ends SideAWins with its
    /// battle_wild row GC'd, the party HP is written back, and NO XP is granted.
    #[test]
    fn nh_recruit_success_spends_bait_boxes_the_wild_and_grants_no_xp() {
        let fx = fixture();
        let w = world(&fx);
        let got = fx.run_as_at(a(), at(T0), |ctx| attempt_recruit(ctx, BATTLE, Some(BAIT)));
        assert_eq!(got, Ok(()), "indexes asked: {:?}", fx.requested_indexes());

        assert_eq!(w.count(a(), BAIT), 1, "exactly one bait spent");
        let events = w.events.rows();
        assert_eq!(events.len(), 1, "the attempt is recorded exactly once");
        assert_eq!(
            (
                events[0].identity,
                events[0].bait_item_id,
                events[0].success
            ),
            (a(), BAIT, true)
        );

        let recruits: Vec<Monster> = w
            .monsters
            .rows()
            .into_iter()
            .filter(|m| m.monster_id != 11)
            .collect();
        assert_eq!(recruits.len(), 1, "exactly one monster created");
        let r = &recruits[0];
        assert_eq!(
            (r.owner_identity, r.species_id, r.level, r.party_slot),
            (a(), WILD_SPECIES, 4, PARTY_SLOT_NONE),
            "the caller owns the recruit, at the wild's level, in the box"
        );
        let p = w
            .pubs
            .rows()
            .into_iter()
            .find(|p| p.monster_id == r.monster_id)
            .expect("monster_pub row for the recruit");
        assert_eq!(
            to_vec(&p).unwrap(),
            to_vec(&pub_from_monster(r, 2)).unwrap()
        );

        assert!(w.wilds.rows().is_empty(), "battle_wild GC'd");
        assert_eq!(w.battles.rows()[0].state.outcome, BattleOutcome::SideAWins);
        let lead = w
            .monsters
            .rows()
            .into_iter()
            .find(|m| m.monster_id == 11)
            .unwrap();
        assert_eq!(lead.current_hp, 12, "party HP written back from the battle");
        assert_eq!((lead.xp, lead.level), (120, 7), "no XP on recruit");
    }

    /// Refusals before the roll: non-owner, finished battle, non-wild battle,
    /// unknown item, non-bait item, no bait owned, bait fully escrowed — each
    /// leaves the store (including the playtest log) byte-identical.
    #[test]
    fn nh_recruit_refusals_happen_before_the_roll() {
        type Setup = fn(&World<'_>);
        let cases: [(&str, Identity, Option<u32>, Setup, &str); 7] = [
            ("non-owner", b(), Some(BAIT), |_| {}, "not owner"),
            (
                "battle finished",
                a(),
                Some(BAIT),
                |w| {
                    w.battles.remove(BATTLE);
                    w.battles.seed(&wild_battle(BattleOutcome::SideBWins));
                },
                "battle is not ongoing",
            ),
            (
                "not a wild battle",
                a(),
                None,
                |w| {
                    w.wilds.remove(BATTLE);
                },
                "not a wild battle",
            ),
            ("unknown item", a(), Some(77), |_| {}, "unknown item"),
            (
                "not bait",
                a(),
                Some(NOT_BAIT),
                |w| w.stack(a(), NOT_BAIT, 3),
                "item is not bait",
            ),
            (
                "no bait owned",
                a(),
                Some(BAIT),
                |w| {
                    w.stacks.remove(a());
                    w.stack(b(), BAIT, 5);
                },
                "item is in an active trade",
            ),
            (
                "bait escrowed",
                a(),
                Some(BAIT),
                |w| {
                    let mut o = TradeOffer {
                        trade_id: 1,
                        initiator: a(),
                        counterparty: b(),
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
                    };
                    o.initiator_items = vec![TradeItem {
                        item_id: BAIT,
                        qty: 2,
                    }];
                    w.offers.seed(&o);
                },
                "item is in an active trade",
            ),
        ];
        for (label, caller, bait, setup, want) in cases {
            let fx = fixture();
            let w = world(&fx);
            setup(&w);
            let before = w.snapshot();
            let got = fx.run_as_at(caller, at(T0), |ctx| attempt_recruit(ctx, BATTLE, bait));
            assert_eq!(got, Err(want.to_string()), "{label}");
            assert_eq!(
                w.snapshot(),
                before,
                "{label}: nothing written, no roll recorded"
            );
        }
    }

    /// A FAILED roll on an ongoing battle (no bait, full-HP wild: an 8% chance,
    /// so a run of fixed clocks — each deterministic — yields failures; at least
    /// one is required). Against a skill-less wild the turn still advances and
    /// the post-turn status tick runs: the lead's Sleep(2) is written back as
    /// Sleep(1) on the battle row, the battle stays Ongoing with its battle_wild
    /// row, and the party's monster row is untouched (no terminal write-back).
    ///
    /// kills: the ongoing-only status write-back inverted (Sleep(2) survives);
    /// the terminal-only write-back inverted (battle_wild GC'd and HP written
    /// on an ongoing battle).
    #[test]
    fn nh_recruit_failure_on_an_ongoing_battle_persists_status_and_keeps_the_wild() {
        use crate::schema::TypeRelationRow;
        use game_core::StatusEffect;
        let mut failures = 0;
        for k in 0..16i64 {
            let fx = fixture();
            let w = world(&fx);
            let _ = fx
                .table_keyed::<TypeRelationRow, u64>("type_relation_row", "id", |r| r.id)
                .scannable();
            let mut bt = wild_battle(BattleOutcome::Ongoing);
            bt.state.side_a.team[0].status = Some(StatusEffect::Sleep { turns_remaining: 2 });
            bt.state.side_b.team[0].known_skill_ids.clear();
            w.battles.remove(BATTLE);
            w.battles.seed(&bt);
            let monsters_before = to_vec(&w.monsters.rows()).unwrap();
            let got = fx.run_as_at(a(), at(T0 + k * 7_919), |ctx| {
                attempt_recruit(ctx, BATTLE, None)
            });
            assert_eq!(got, Ok(()), "clock {k}");
            let after = &w.battles.rows()[0];
            if after.state.outcome == BattleOutcome::SideAWins {
                continue; // this clock's roll succeeded
            }
            failures += 1;
            assert_eq!(after.state.outcome, BattleOutcome::Ongoing, "clock {k}");
            assert_eq!(
                after.state.side_a.team[0].status,
                Some(StatusEffect::Sleep { turns_remaining: 1 }),
                "clock {k}: the ticked status is written back"
            );
            assert_eq!(w.wilds.rows().len(), 1, "clock {k}: battle_wild kept");
            assert_eq!(
                to_vec(&w.monsters.rows()).unwrap(),
                monsters_before,
                "clock {k}: no terminal write-back on an ongoing battle"
            );
        }
        assert!(failures > 0, "at least one clock must roll a failure");
    }

    /// grant_bait (DEV) credits ONLY the caller, capped at 99 per call, and
    /// refuses a non-bait item.
    #[cfg(feature = "dev_reducers")]
    #[test]
    fn nh_grant_bait_is_self_scoped_and_capped() {
        let fx = fixture();
        let w = world(&fx);
        w.stack(b(), BAIT, 1);
        assert_eq!(
            fx.run_as(a(), |ctx| crate::taming::grant_bait(ctx, BAIT, 150)),
            Ok(())
        );
        assert_eq!((w.count(a(), BAIT), w.count(b(), BAIT)), (2 + 99, 1));
        let before = w.snapshot();
        assert_eq!(
            fx.run_as(a(), |ctx| crate::taming::grant_bait(ctx, NOT_BAIT, 1)),
            Err("not a bait item".to_string())
        );
        assert_eq!(w.snapshot(), before);
    }
}
