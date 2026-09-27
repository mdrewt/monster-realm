//! `monster_mgmt_tests` — rb-41 gating test for the REKEY exists-predicate
//! `monster_mgmt::has_monsters`, authored from the EARS criterion R-rb-25-X9
//! (the ADR-0222 known-limit 2 residual, closed by the ADR-0224 migration to a
//! native host).
//!
//! Declared from `monster_mgmt.rs` as a cfg(test)
//! `#[path = "monster_mgmt_tests.rs"] mod monster_mgmt_tests;` (the attribute is
//! not spelled here on purpose — see native_host_tests.rs on the
//! monster-privacy `[SCOPE]` raw-text branch)
//! so `super` resolves to the `monster_mgmt` module (this file uses absolute
//! `crate::` paths throughout, so nothing here depends on that resolution).
//!
//! WHY IT EXISTS. ADR-0222's guest-claim-integrity gate could only READ the
//! predicate's source, so a HOLLOWED body — one that still performs the table
//! read but returns a value decoupled from it — passed every check. The test
//! below runs the shipped predicate against the in-memory host
//! (`native_host_tests`, ADR-0224) and pins its answer to the rows that
//! actually exist, which no source scan can do. Rows are seeded and removed
//! through the fixture handle, never through a database write path; every
//! monster write in this file is a SHIPPED function's own (via the host's opt-in
//! write path), and seeded projections are built by the shipped
//! `marshal::pub_from_monster`. The `dw_` roster at the end is the
//! EV-monster-dual-write replacement.

use crate::native_host_tests::fixture;
use crate::schema::Monster;
use spacetimedb::Identity;

/// A complete private monster row owned by `owner`. Every column the EG1
/// schema declares is set explicitly so the seeded bytes decode exactly as the
/// generated reader expects; every non-identity scalar is ZERO on purpose, so a
/// predicate that additionally inspects a payload column (a level or a stat
/// above zero, ...) cannot pass on this row — `has_monsters` reads ownership and
/// nothing else.
fn rb41_owned_monster(owner: Identity, monster_id: u64) -> Monster {
    Monster {
        monster_id,
        owner_identity: owner,
        species_id: 0,
        nickname: String::new(),
        level: 0,
        xp: 0,
        iv_hp: 0,
        iv_attack: 0,
        iv_defense: 0,
        iv_speed: 0,
        iv_sp_attack: 0,
        iv_sp_defense: 0,
        nature_kind: game_core::NatureKind::Hardy,
        ev_hp: 0,
        ev_attack: 0,
        ev_defense: 0,
        ev_speed: 0,
        ev_sp_attack: 0,
        ev_sp_defense: 0,
        stat_hp: 0,
        stat_attack: 0,
        stat_defense: 0,
        stat_speed: 0,
        stat_sp_attack: 0,
        stat_sp_defense: 0,
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
    }
}

/// EARS R-rb-25-X9: `monster_mgmt::has_monsters` must answer from the CURRENT
/// rows of the private monster table, for the ASKED owner — false with no row,
/// false while only a stranger owns one, true once the owner owns one, false
/// again once the owner's row is gone (while the stranger's row survives). The
/// paired `accounts::account_has_game_data` assertions pin the monster disjunct
/// of the six-way `||` chain that decides whether a guest holds game data —
/// the first disjunct, and the one `join_game` makes true for every player who
/// has ever pressed play.
///
/// kills:
///   - the ADR-0222 known-limit hollow, `{ let _ = <the monster read>; false }`:
///     the owner-row assertion goes red while every source scan stays green.
///   - the inverted hollow, `{ let _ = <the monster read>; true }`: the
///     empty-table assertion goes red.
///   - a body that answers does-the-table-hold-ANY-row instead of
///     does-THIS-owner-hold-one: the stranger-only assertion goes red, and so
///     does the post-removal assertion (the stranger's row is still there).
///   - a latched or memoised answer that never returns to false once it has
///     seen a row: the post-removal assertion goes red.
///   - deleting the monster disjunct from `accounts::account_has_game_data`:
///     the paired account assertion goes red while the direct predicate
///     assertion stays green.
#[test]
fn rb41_has_monsters_tracks_real_monster_rows() {
    let fx = fixture();
    let t = fx.table::<Monster>("monster", "owner_identity", |r| r.owner_identity);
    let ctx = fx.ctx();
    let owner = Identity::from_byte_array([19u8; 32]);
    let stranger = Identity::from_byte_array([20u8; 32]);

    assert!(
        !crate::monster_mgmt::has_monsters(&ctx, owner),
        "has_monsters must be false for an owner with no monster: the table is empty here, so \
         a true answer means the return value is not derived from the table read"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be false while the owner owns no row in ANY REKEY table: \
         no row of any kind has been seeded yet"
    );

    t.seed(&rb41_owned_monster(stranger, 5_002));
    assert!(
        !crate::monster_mgmt::has_monsters(&ctx, owner),
        "has_monsters must stay false when the ONLY monster belongs to a different owner: the \
         predicate answers per-owner, never table-is-non-empty"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must stay false when the only seeded row belongs to a stranger: \
         a guest claim keys on the CALLER identity, not on global table population"
    );

    t.seed(&rb41_owned_monster(owner, 5_001));
    assert!(
        crate::monster_mgmt::has_monsters(&ctx, owner),
        "has_monsters must report true while the owner owns a monster; a body that reads the \
         table and then returns a constant false (the ADR-0222 known-limit hollow) fails \
         exactly here. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
    assert!(
        crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must be true through its monster disjunct while the owner owns \
         a monster and nothing else; a deleted disjunct fails exactly here. Indexes the \
         generated code asked the host for: {:?}",
        fx.requested_indexes()
    );

    assert_eq!(
        t.remove(owner),
        1,
        "the owner had exactly one monster row to remove: a different count means the seeded \
         state was not the state this test reasons about"
    );
    assert!(
        !crate::monster_mgmt::has_monsters(&ctx, owner),
        "has_monsters must return to false once the owner's last monster is gone: the answer \
         tracks live rows, so it can never latch on a row that no longer exists"
    );
    assert!(
        !crate::accounts::account_has_game_data(&ctx, owner),
        "account_has_game_data must return to false once the owner's last REKEY-table row is \
         gone: this is the state in which a guest claim is allowed to proceed"
    );
    assert!(
        crate::monster_mgmt::has_monsters(&ctx, stranger),
        "removing the owner's row must leave the stranger's monster untouched: without this \
         the negative above could be explained by an emptied table rather than by owner \
         scoping. Indexes the generated code asked the host for: {:?}",
        fx.requested_indexes()
    );
}

/// **ST-native_host_tests demonstration** — the ownership guard, executed from
/// BOTH sides with a real sender.
///
/// Under the dummy context every caller is the all-zero identity, so an owner
/// check could only be probed with a monster owned by `[0; 32]` — which is
/// also `WILD_IDENTITY`. `run_as` sets the caller. The same monster, in the same
/// state, is renamed first by a STRANGER (must be refused with the exact
/// reject, and neither the private row nor its projection may change) and then
/// by its OWNER (the positive control: both rows carry the new nickname, which
/// also executes the private/projection dual-write through the host's update
/// path). kills: a deleted or inverted `require_owner`, an owner check against
/// the wrong identity, and a write that lands before the guard.
#[test]
fn nh_set_nickname_refuses_a_stranger_and_admits_the_owner() {
    use crate::schema::MonsterPub;
    let fx = fixture();
    let owner = Identity::from_byte_array([31u8; 32]);
    let stranger = Identity::from_byte_array([32u8; 32]);
    let monsters = fx
        .table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id)
        .writable();
    let projections = fx
        .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
        .writable();
    let m = rb41_owned_monster(owner, 41);
    projections.seed(&crate::marshal::pub_from_monster(&m, 0));
    monsters.seed(&m);
    let nicknames = || {
        let private: Vec<String> = monsters.rows().into_iter().map(|r| r.nickname).collect();
        let public: Vec<String> = projections.rows().into_iter().map(|r| r.nickname).collect();
        (private, public)
    };

    let got = fx.run_as(stranger, |ctx| {
        crate::monster_mgmt::set_nickname(ctx, 41, "Thief".to_string())
    });
    assert_eq!(
        got,
        Err("not owner".to_string()),
        "a stranger must get the exact owner reject"
    );
    assert_eq!(
        nicknames(),
        (vec![String::new()], vec![String::new()]),
        "a refused rename must leave both the private row and its projection untouched"
    );

    let got = fx.run_as(owner, |ctx| {
        crate::monster_mgmt::set_nickname(ctx, 41, "Sparky".to_string())
    });
    assert_eq!(
        got,
        Ok(()),
        "the owner's rename must succeed: {:?}",
        fx.requested_indexes()
    );
    assert_eq!(
        nicknames(),
        (vec!["Sparky".to_string()], vec!["Sparky".to_string()]),
        "the owner's rename must land on the private row AND its projection, in place"
    );
}

// ===========================================================================
// EV-monster-dual-write — the hand-enumerated site roster (debloat Phase 2).
//
// Every production function that writes the private `monster` table also writes
// its `monster_pub` projection. The roster below was enumerated from production
// source (whitespace-insensitive scan of every `.monster()` / `.monster_pub()`
// insert/update/delete outside *_tests.rs): 20 sites in 19 functions. Per the
// trade-escrow precedent (47a75b0, Phase 2 ruling: hand-enumerated rosters, not a
// text census) each site is DRIVEN here — or in the suite named beside it — and
// the store is checked with one oracle: the projection id set equals the private
// id set, and each projection is exactly `pub_from_monster(private, its tier)`.
// Each test also proves the site actually wrote (a no-op keeps any mirror green).
//
//   battle.rs  write_back_party_hp, write_back_battle_results (x2)  -> battle_tests bn_*
//   trading.rs confirm_trade                                        -> trading_tests nh_trade_confirm_*
//   monster_mgmt.rs set_nickname                                    -> nh_set_nickname_* above
//   monster_mgmt.rs set_party_slot, rekey_monsters, erase_monsters  -> dw_monster_mgmt_sites
//   raising.rs care, train, heal_party, essence_train,
//              consume_crystalized_essence, accrue_quality_time     -> dw_raising_sites
//   evolution.rs apply_evolution                                    -> dw_apply_evolution_site
//   movement.rs join_game (insert), taming.rs attempt_recruit (ins) -> dw_insert_sites
//   pvp.rs write_back_party_hp_pvp_side_b (via forfeit_on_disconnect) -> dw_pvp_side_b_site
//   content.rs sync_content_inner (re-derive pass)                   -> dw_sync_content_site
//
// FUTURE mutators are not covered by a list; the Phase 3 simplification pass is
// to evaluate a production single-writer helper (the fn-hunt condition).
// ===========================================================================

use crate::native_host_tests::{Fixture, Handle};
use crate::schema::{Battle, Inventory, MonsterPub, SpeciesRow};

const DW_T0: i64 = 1_750_000_000_000;

fn dw_a() -> Identity {
    Identity::from_byte_array([0xA1; 32])
}
fn dw_b() -> Identity {
    Identity::from_byte_array([0xB2; 32])
}
fn dw_c() -> Identity {
    Identity::from_byte_array([0xC3; 32])
}
fn dw_at(ms: i64) -> spacetimedb::Timestamp {
    spacetimedb::Timestamp::from_micros_since_unix_epoch(ms * 1000)
}
fn dw_bytes<T: spacetimedb::Serialize>(row: &T) -> Vec<u8> {
    spacetimedb::sats::bsatn::to_vec(row).expect("rows encode")
}

/// A legal level-7 species-1 monster with distinct genes and a damaged HP.
fn dw_monster(monster_id: u64, owner: Identity, party_slot: u8) -> Monster {
    let g = (monster_id % 20) as u8 + 1;
    let e = u16::from(g);
    Monster {
        monster_id,
        owner_identity: owner,
        species_id: 1,
        nickname: format!("m{monster_id}"),
        level: 7,
        xp: 0,
        iv_hp: g,
        iv_attack: g + 1,
        iv_defense: g + 2,
        iv_speed: g + 3,
        iv_sp_attack: g + 4,
        iv_sp_defense: g + 5,
        nature_kind: game_core::NatureKind::Hardy,
        ev_hp: e,
        ev_attack: e + 1,
        ev_defense: e + 2,
        ev_speed: e + 3,
        ev_sp_attack: e + 4,
        ev_sp_defense: e + 5,
        stat_hp: 40,
        stat_attack: 20,
        stat_defense: 20,
        stat_speed: 20,
        stat_sp_attack: 20,
        stat_sp_defense: 20,
        current_hp: 11,
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
        quality_time_ticks_total: 0,
        quality_time_accum_ms: 0,
        quality_time_window_ms: 0,
        quality_time_window_start_ms: 0,
        last_essence_train_at_ms: 0,
    }
}

struct DwWorld<'a> {
    monsters: Handle<'a, Monster, u64>,
    pubs: Handle<'a, MonsterPub, u64>,
    stacks: Handle<'a, Inventory>,
}

/// The monster pair plus every table the rostered functions read or write.
fn dw_world(fx: &Fixture) -> DwWorld<'_> {
    use crate::schema::{ItemRow, Player, PlayerWallet, SkillRow};
    let monsters = fx
        .table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id)
        .writable()
        .scannable()
        .unique()
        .auto_inc(|r| r.monster_id, |r, id| r.monster_id = id);
    let _ = fx.table::<Monster>("monster", "owner_identity", |r| r.owner_identity);
    let pubs = fx
        .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
        .writable()
        .unique();
    let _ = fx.table::<MonsterPub>("monster_pub", "owner_identity", |r| r.owner_identity);
    let stacks = fx
        .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
        .writable()
        .auto_inc(|r| r.inv_id, |r, id| r.inv_id = id);
    let _ = fx
        .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
        .unique();
    let _ = fx
        .table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity)
        .writable()
        .unique();
    let _ = fx
        .table::<Player>("player", "identity", |r| r.identity)
        .writable()
        .unique();
    let _ = fx
        .table_keyed::<Battle, u64>("battle", "battle_id", |r| r.battle_id)
        .writable()
        .unique()
        .auto_inc(|r| r.battle_id, |r, id| r.battle_id = id);
    let _ = fx.table::<Battle>("battle", "player_identity", |r| r.player_identity);
    let _ = fx.table::<Battle>("battle", "opponent_identity", |r| r.opponent_identity);
    let _ = fx
        .table_keyed::<crate::schema::BattleWild, u64>("battle_wild", "battle_id", |r| r.battle_id)
        .writable()
        .unique();
    let _ = fx
        .table_keyed::<crate::playtest::PlaytestEvent, u64>("playtest_event", "event_id", |r| {
            r.event_id
        })
        .writable()
        .unique()
        .auto_inc(|r| r.event_id, |r, id| r.event_id = id);
    let _ = fx
        .table_keyed::<crate::schema::TypeRelationRow, u64>("type_relation_row", "id", |r| r.id)
        .scannable();
    let species = fx.table_keyed::<SpeciesRow, u32>("species_row", "id", |r| r.id);
    for (id, affinity, tier) in [
        (1, game_core::Affinity::Fire, 0),
        (2, game_core::Affinity::Water, 3),
    ] {
        species.seed(&SpeciesRow {
            id,
            name: format!("sp{id}"),
            base_hp: 50,
            base_attack: 50,
            base_defense: 50,
            base_speed: 50,
            base_sp_attack: 50,
            base_sp_defense: 50,
            affinity,
            learnable_skill_ids: vec![1],
            ability: None,
            tier,
        });
    }
    fx.table_keyed::<SkillRow, u32>("skill_row", "id", |r| r.id)
        .scannable()
        .seed(&SkillRow {
            id: 1,
            name: "Ember".to_string(),
            affinity: game_core::Affinity::Fire,
            power: 40,
            accuracy: 100,
            pp: 25,
        });
    let items = fx.table_keyed::<ItemRow, u32>("item_row", "id", |r| r.id);
    for (id, recruit_bonus, train) in [(1, 150, false), (2, 0, true), (5, 0, false)] {
        items.seed(&ItemRow {
            id,
            name: format!("item{id}"),
            description: String::new(),
            recruit_bonus,
            train_stat: train.then_some(game_core::StatKind::Attack),
            train_amount: if train { 10 } else { 0 },
            sell_price: 10,
            cure_status: None,
        });
    }
    DwWorld {
        monsters,
        pubs,
        stacks,
    }
}

impl DwWorld<'_> {
    fn monster(&self, id: u64, owner: Identity, party_slot: u8) {
        let m = dw_monster(id, owner, party_slot);
        self.pubs.seed(&crate::marshal::pub_from_monster(&m, 0));
        self.monsters.seed(&m);
    }
    fn stack(&self, owner: Identity, item_id: u32, count: u32) {
        self.stacks.seed(&Inventory {
            inv_id: 1000 + u64::from(item_id),
            owner_identity: owner,
            item_id,
            count,
        });
    }
    fn row(&self, id: u64) -> Option<Monster> {
        self.monsters
            .rows()
            .into_iter()
            .find(|m| m.monster_id == id)
    }
    fn private_bytes(&self) -> Vec<u8> {
        dw_bytes(&self.monsters.rows())
    }
    /// The dual-write oracle (see the banner).
    fn assert_mirrored(&self, label: &str) {
        let monsters = self.monsters.rows();
        let pubs = self.pubs.rows();
        let mut ids: Vec<u64> = monsters.iter().map(|m| m.monster_id).collect();
        let mut pub_ids: Vec<u64> = pubs.iter().map(|p| p.monster_id).collect();
        ids.sort_unstable();
        pub_ids.sort_unstable();
        assert_eq!(
            ids, pub_ids,
            "{label}: monster / monster_pub id sets differ"
        );
        for m in &monsters {
            let p = pubs
                .iter()
                .find(|p| p.monster_id == m.monster_id)
                .expect("paired projection");
            assert_eq!(
                dw_bytes(p),
                dw_bytes(&crate::marshal::pub_from_monster(m, p.tier)),
                "{label}: monster_pub {} diverged from its private row",
                m.monster_id
            );
        }
    }
}

type DwCall = fn(&spacetimedb::ReducerContext) -> Result<(), String>;

/// monster_mgmt.rs: set_party_slot, rekey_monsters, erase_monsters. rekey and erase
/// touch ONLY the named owner's monsters (a bystander pair stays byte-identical).
#[test]
fn dw_monster_mgmt_sites() {
    let sites: Vec<(&str, DwCall)> = vec![
        ("set_party_slot", |ctx| {
            crate::monster_mgmt::set_party_slot(ctx, 11, 3)
        }),
        ("rekey_monsters", |ctx| {
            crate::monster_mgmt::rekey_monsters(ctx, dw_a(), dw_b())
        }),
        ("erase_monsters", |ctx| {
            crate::monster_mgmt::erase_monsters(ctx, dw_a());
            Ok(())
        }),
    ];
    for (label, call) in sites {
        let fx = fixture();
        let w = dw_world(&fx);
        w.monster(11, dw_a(), 0);
        w.monster(12, dw_a(), 1);
        w.monster(31, dw_c(), 0);
        let bystander = (dw_bytes(&w.row(31)), w.private_bytes());
        assert_eq!(fx.run_as_at(dw_a(), dw_at(DW_T0), call), Ok(()), "{label}");
        assert_ne!(w.private_bytes(), bystander.1, "{label}: wrote nothing");
        assert_eq!(
            dw_bytes(&w.row(31)),
            bystander.0,
            "{label}: bystander touched"
        );
        match label {
            "set_party_slot" => assert_eq!(w.row(11).unwrap().party_slot, 3),
            "rekey_monsters" => {
                assert_eq!(w.row(11).unwrap().owner_identity, dw_b());
                assert_eq!(w.row(12).unwrap().owner_identity, dw_b());
            }
            _ => assert!(w.row(11).is_none() && w.row(12).is_none()),
        }
        w.assert_mirrored(label);
    }
}

/// raising.rs: care, train, heal_party, essence_train, consume_crystalized_essence,
/// accrue_quality_time — each run to Ok on monster 11 and mirrored.
#[test]
fn dw_raising_sites() {
    use crate::schema::{Character, HealCooldown, HealLocationRow, Player};
    let sites: Vec<(&str, DwCall)> = vec![
        ("care", |ctx| crate::raising::care(ctx, 11)),
        ("train", |ctx| crate::raising::train(ctx, 11, 2)),
        ("heal_party", |ctx| crate::raising::heal_party(ctx, 999)),
        ("essence_train", |ctx| {
            crate::raising::essence_train(ctx, 11, game_core::Affinity::Fire)
        }),
        ("consume_crystalized_essence", |ctx| {
            crate::raising::consume_crystalized_essence(ctx, 11, 5)
        }),
        ("accrue_quality_time", |ctx| {
            if crate::raising::accrue_quality_time(ctx, 11) {
                Ok(())
            } else {
                Err("no credit".to_string())
            }
        }),
    ];
    for (label, call) in sites {
        let fx = fixture();
        let w = dw_world(&fx);
        let mut m = dw_monster(11, dw_a(), 0);
        // One minute into a QT window: a credit (inside the 2-minute idle gap).
        m.quality_time_window_start_ms = DW_T0 - 60_000;
        w.pubs.seed(&crate::marshal::pub_from_monster(&m, 0));
        w.monsters.seed(&m);
        w.monster(12, dw_a(), 1);
        w.stack(dw_a(), 2, 3);
        w.stack(dw_a(), 5, 3);
        fx.table::<Player>("player", "identity", |r| r.identity)
            .seed(&Player {
                identity: dw_a(),
                entity_id: 5,
                name: String::new(),
                online: true,
                last_input_seq: 0,
            });
        fx.table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
            .seed(&Character {
                entity_id: 5,
                zone_id: 0,
                tile_x: 0,
                tile_y: 0,
                facing: game_core::Direction::South,
                action: game_core::ActionState::Idle,
                move_started_at_ms: 0,
                sprite_id: 0,
                move_queue: vec![],
            });
        fx.table_keyed::<HealLocationRow, u32>("heal_location_row", "location_id", |r| {
            r.location_id
        })
        .seed(&HealLocationRow {
            location_id: 999,
            zone_id: 0,
            tile_x: 0,
            tile_y: 0,
            cost_item_id: None,
            cost_qty: 0,
            cooldown_ms: 0,
            cost_currency: 0,
        });
        let _ = fx
            .table::<HealCooldown>("heal_cooldown", "owner_identity", |r| r.owner_identity)
            .writable()
            .unique();
        let before = dw_bytes(&w.row(11));
        let got = fx.run_as_at(dw_a(), dw_at(DW_T0), call);
        assert_eq!(got, Ok(()), "{label}; asked {:?}", fx.requested_indexes());
        assert_ne!(
            dw_bytes(&w.row(11)),
            before,
            "{label}: monster 11 not written"
        );
        w.assert_mirrored(label);
    }
}

/// evolution.rs apply_evolution: the evolved row and its projection agree, and the
/// projection's tier is the TARGET species' fresh tier (3), not the copied-forward 0.
#[test]
fn dw_apply_evolution_site() {
    use crate::schema::{EvolutionPathRow, PendingEvolutionNotice};
    let fx = fixture();
    let w = dw_world(&fx);
    w.monster(11, dw_a(), 0);
    let _ = fx
        .table::<PendingEvolutionNotice>("pending_evolution_notice", "owner_identity", |r| {
            r.owner_identity
        })
        .writable()
        .unique();
    let path = EvolutionPathRow {
        path_id: 1,
        edge_id: 1,
        from_species: 1,
        to_species: 2,
        min_level: 1,
        essence: vec![],
        min_trust_tier: None,
        min_quality_time_tier: None,
        min_nutrition_pct: None,
    };
    let ctx = fx.ctx_at(dw_at(DW_T0));
    assert_eq!(crate::evolution::apply_evolution(&ctx, 11, &path), Ok(()));
    assert_eq!(w.row(11).unwrap().species_id, 2);
    let tier = w
        .pubs
        .rows()
        .into_iter()
        .find(|p| p.monster_id == 11)
        .unwrap()
        .tier;
    assert_eq!(tier, 3, "fresh target tier");
    w.assert_mirrored("apply_evolution");
}

/// movement.rs join_game and taming.rs attempt_recruit: the two INSERT sites create
/// a private row and its projection together (tier from the species row).
#[test]
fn dw_insert_sites() {
    use crate::schema::Character;
    // join_game: a brand-new player gets a starter pair.
    {
        let fx = fixture();
        let w = dw_world(&fx);
        let _ = fx
            .table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
            .writable()
            .unique()
            .auto_inc(|r| r.entity_id, |r, id| r.entity_id = id);
        let got = fx.run_as_at(dw_c(), dw_at(DW_T0), |ctx| {
            crate::movement::join_game(ctx, "Cee".to_string())
        });
        assert_eq!(got, Ok(()), "join_game; asked {:?}", fx.requested_indexes());
        let rows = w.monsters.rows();
        assert_eq!(rows.len(), 1, "one starter");
        assert_eq!(rows[0].owner_identity, dw_c());
        w.assert_mirrored("join_game");
    }
    // attempt_recruit: retried over clock values (the roll is ctx.random()) until a
    // recruit lands; a failed roll inserts nothing.
    let mut recruited = false;
    for k in 0..64 {
        let fx = fixture();
        let w = dw_world(&fx);
        w.monster(11, dw_a(), 0);
        w.stack(dw_a(), 1, 3);
        let lead = game_core::BattleMonster {
            species_id: 1,
            affinity: game_core::Affinity::Fire,
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
        let wild = game_core::BattleMonster {
            species_id: 2,
            current_hp: 1,
            max_hp: 200,
            ..lead.clone()
        };
        fx.table_keyed::<Battle, u64>("battle", "battle_id", |r| r.battle_id)
            .seed(&Battle {
                battle_id: 900,
                player_identity: dw_a(),
                opponent_identity: crate::WILD_IDENTITY,
                state: game_core::BattleState {
                    side_a: game_core::BattleSide {
                        active: 0,
                        team: vec![lead],
                    },
                    side_b: game_core::BattleSide {
                        active: 0,
                        team: vec![wild],
                    },
                    outcome: game_core::BattleOutcome::Ongoing,
                    turn_number: 1,
                    weather: None,
                },
                party_monster_ids: vec![11],
                opponent_monster_ids: vec![],
                created_at_ms: 0,
            });
        fx.table_keyed::<crate::schema::BattleWild, u64>("battle_wild", "battle_id", |r| {
            r.battle_id
        })
        .seed(&crate::schema::BattleWild {
            battle_id: 900,
            wild_species_id: 2,
            wild_level: 5,
            individuality_seed: 77,
        });
        let got = fx.run_as_at(dw_a(), dw_at(DW_T0 + k * 1000), |ctx| {
            crate::taming::attempt_recruit(ctx, 900, Some(1))
        });
        assert_eq!(
            got,
            Ok(()),
            "attempt_recruit; asked {:?}",
            fx.requested_indexes()
        );
        w.assert_mirrored("attempt_recruit");
        let mine = w.monsters.rows().len();
        if mine == 2 {
            let pubs = w.pubs.rows();
            let new = pubs.iter().find(|p| p.monster_id != 11).unwrap();
            assert_eq!(new.tier, 3, "recruit projection carries the species tier");
            recruited = true;
            break;
        }
        assert_eq!(mine, 1, "a failed roll inserts nothing");
    }
    assert!(
        recruited,
        "no recruit landed in 64 rolls at 1/200 HP with bait"
    );
}

/// pvp.rs write_back_party_hp_pvp_side_b (private; reached through the shipped
/// forfeit_on_disconnect -> settle_pvp_battle path): side B's HP lands on B's private
/// row AND its projection.
#[test]
fn dw_pvp_side_b_site() {
    use crate::schema::{BattleAction, Profile};
    let fx = fixture();
    let w = dw_world(&fx);
    w.monster(11, dw_a(), 0);
    w.monster(21, dw_b(), 0);
    let _ = fx
        .table::<Profile>("profile", "identity", |r| r.identity)
        .writable()
        .unique();
    let _ = fx
        .table_keyed::<BattleAction, u64>("battle_action", "battle_id", |r| r.battle_id)
        .writable();
    let _ = fx
        .table_keyed::<crate::pvp::PvpDeadlineSchedule, u64>(
            "pvp_deadline_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        )
        .writable()
        .scannable();
    let mon = |hp: u16| game_core::BattleMonster {
        species_id: 1,
        affinity: game_core::Affinity::Fire,
        level: 7,
        current_hp: hp,
        max_hp: 40,
        stats: game_core::StatBlock {
            hp: 40,
            attack: 20,
            defense: 20,
            speed: 20,
            sp_attack: 20,
            sp_defense: 20,
        },
        known_skill_ids: vec![1],
        status: None,
    };
    fx.table_keyed::<Battle, u64>("battle", "battle_id", |r| r.battle_id)
        .seed(&Battle {
            battle_id: 900,
            player_identity: dw_a(),
            opponent_identity: dw_b(),
            state: game_core::BattleState {
                side_a: game_core::BattleSide {
                    active: 0,
                    team: vec![mon(30)],
                },
                side_b: game_core::BattleSide {
                    active: 0,
                    team: vec![mon(7)],
                },
                outcome: game_core::BattleOutcome::Ongoing,
                turn_number: 1,
                weather: None,
            },
            party_monster_ids: vec![11],
            opponent_monster_ids: vec![21],
            created_at_ms: 0,
        });
    let ctx = fx.ctx_at(dw_at(DW_T0));
    crate::pvp::forfeit_on_disconnect(&ctx, dw_a());
    assert_eq!(w.row(21).unwrap().current_hp, 7, "side B HP written back");
    assert_eq!(w.row(11).unwrap().current_hp, 30, "side A HP written back");
    w.assert_mirrored("pvp side B");
}

/// content.rs sync_content_inner's re-derive pass: after a full content sync over an
/// empty content store, every existing monster is re-derived from the SHIPPED species
/// row and its projection carries that species' fresh tier.
#[test]
fn dw_sync_content_site() {
    use crate::schema::{
        Character, Config, EncounterRow, EvolutionPathRow, HealLocationRow, ItemRow, Npc,
        ShopItemRow, ShopRow, SkillRow, TypeRelationRow, ZoneDefRow,
    };
    let fx = fixture();
    let monsters = fx
        .table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id)
        .writable()
        .scannable()
        .unique();
    let pubs = fx
        .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
        .writable()
        .unique();
    fx.table_keyed::<Config, u32>("config", "id", |r| r.id)
        .writable()
        .unique()
        .seed(&Config {
            id: 0,
            content_version: 0,
            owner_identity: dw_c(),
        });
    let _ = fx
        .table_keyed::<ZoneDefRow, u32>("zone_def", "zone_id", |r| r.zone_id)
        .writable()
        .scannable()
        .unique();
    let _ = fx
        .table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
        .writable()
        .unique()
        .auto_inc(|r| r.entity_id, |r, id| r.entity_id = id);
    let _ = fx.table_keyed::<Character, u32>("character", "zone_id", |r| r.zone_id);
    let _ = fx
        .table_keyed::<SpeciesRow, u32>("species_row", "id", |r| r.id)
        .writable()
        .scannable()
        .unique();
    let _ = fx
        .table_keyed::<SkillRow, u32>("skill_row", "id", |r| r.id)
        .writable()
        .scannable()
        .unique();
    let _ = fx
        .table_keyed::<TypeRelationRow, u64>("type_relation_row", "id", |r| r.id)
        .writable()
        .scannable()
        .unique()
        .auto_inc(|r| r.id, |r, id| r.id = id);
    let _ = fx
        .table_keyed::<ItemRow, u32>("item_row", "id", |r| r.id)
        .writable()
        .scannable()
        .unique();
    let _ = fx
        .table_keyed::<ShopItemRow, u64>("shop_item_row", "shop_item_id", |r| r.shop_item_id)
        .writable()
        .scannable()
        .unique()
        .auto_inc(|r| r.shop_item_id, |r, id| r.shop_item_id = id);
    let _ = fx.table_keyed::<ShopItemRow, u32>("shop_item_row", "shop_id", |r| r.shop_id);
    let _ = fx
        .table_keyed::<ShopRow, u32>("shop_row", "shop_id", |r| r.shop_id)
        .writable()
        .scannable()
        .unique();
    let _ = fx
        .table_keyed::<EncounterRow, u32>("encounter", "zone_id", |r| r.zone_id)
        .writable()
        .scannable()
        .unique();
    let _ = fx
        .table_keyed::<EvolutionPathRow, u64>("evolution_path", "path_id", |r| r.path_id)
        .writable()
        .scannable()
        .unique()
        .auto_inc(|r| r.path_id, |r, id| r.path_id = id);
    let _ = fx
        .table_keyed::<EvolutionPathRow, u32>("evolution_path", "from_species", |r| r.from_species);
    let _ = fx
        .table_keyed::<Npc, u64>("npc", "entity_id", |r| r.entity_id)
        .writable()
        .scannable()
        .unique();
    let _ = fx.table_keyed::<Npc, u32>("npc", "zone_id", |r| r.zone_id);
    let _ = fx
        .table_keyed::<HealLocationRow, u32>("heal_location_row", "location_id", |r| r.location_id)
        .writable()
        .scannable()
        .unique();
    let _ = fx.table_keyed::<HealLocationRow, u32>("heal_location_row", "zone_id", |r| r.zone_id);
    // A stale projection: tier 0 and a stat_hp the private row does not carry.
    let m = dw_monster(11, dw_a(), 0);
    let mut stale = crate::marshal::pub_from_monster(&m, 0);
    stale.stat_hp = 1;
    pubs.seed(&stale);
    monsters.seed(&m);
    let before = dw_bytes(&monsters.rows());
    let ctx = fx.ctx_at(dw_at(DW_T0));
    let got = crate::content::sync_content_inner(&ctx);
    assert_eq!(
        got,
        Ok(()),
        "sync_content_inner; asked {:?}",
        fx.requested_indexes()
    );
    assert_ne!(
        dw_bytes(&monsters.rows()),
        before,
        "the re-derive pass wrote nothing"
    );
    let w = DwWorld {
        monsters,
        pubs,
        stacks: fx.table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity),
    };
    w.assert_mirrored("sync_content_inner");
}
