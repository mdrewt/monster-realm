//! `monster_mgmt_tests` the REKEY exists-predicate
//! `monster_mgmt::has_monsters`.
//!
//! Declared from `monster_mgmt.rs` as a cfg(test)
//! `#[path = "monster_mgmt_tests.rs"] mod monster_mgmt_tests;`
//! so `super` resolves to the `monster_mgmt` module (this file uses absolute
//! `crate::` paths throughout, so nothing here depends on that resolution).
//!
//! The test below runs the shipped predicate against the in-memory host
//! (`native_host_tests`) and pins its answer to the rows that actually exist,
//! which no source scan can do. Rows are seeded and removed through the fixture
//! handle, never through a database write path; every monster write in this file
//! is a SHIPPED function's own (via the host's opt-in write path), and seeded
//! projections are built by the shipped `marshal::pub_from_monster`.

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

/// `monster_mgmt::has_monsters` must answer from the CURRENT
/// rows of the private monster table, for the ASKED owner — false with no row,
/// false while only a stranger owns one, true once the owner owns one, false
/// again once the owner's row is gone (while the stranger's row survives). The
/// paired `accounts::account_has_game_data` assertions pin the monster disjunct
/// of the six-way `||` chain that decides whether a guest holds game data —
/// the first disjunct, and the one `join_game` makes true for every player who
/// has ever pressed play.
///
/// kills:
///   - `{ let _ = <the monster read>; false }`:
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
// the hand-enumerated site roster.
//
// Every production function that writes the private `monster` table also writes
// its `monster_pub` projection. The roster below was enumerated from production
// source (whitespace-insensitive scan of every `.monster()` / `.monster_pub()`
// insert/update/delete outside *_tests.rs): 20 sites in 19 functions.
// each site is DRIVEN here — or in the suite named beside it — and
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
//   movement.rs join_game (insert), taming.rs insert_recruited (ins) -> dw_insert_sites
//     (insert_recruited is the tactical recruit's insert; the 1v1 attempt_recruit is gone, bt-17)
//   pvp.rs write_back_party_hp_pvp_side_b (via forfeit_on_disconnect) -> dw_pvp_side_b_site
//   content.rs sync_content_inner (re-derive pass)                   -> dw_sync_content_site
//
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

/// set_party_slot's occupancy set is "the caller's OTHER party monsters": a slot
/// held by a sibling is refused (nothing written), a monster may be re-seated
/// in the slot it already holds, and a boxed sibling blocks nothing.
///
/// kills: the occupancy filter reading only the moved monster or only boxed
/// monsters (the sibling's slot 1 is admitted); the filter counting the moved
/// monster itself (re-seating 11 in its own slot 0 is refused).
#[test]
fn nh_set_party_slot_occupancy_is_the_callers_other_party_monsters() {
    let fx = fixture();
    let w = dw_world(&fx);
    w.monster(11, dw_a(), 0);
    w.monster(12, dw_a(), 1);
    w.monster(13, dw_a(), crate::PARTY_SLOT_NONE);
    let call = |slot: u8| {
        fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
            crate::monster_mgmt::set_party_slot(ctx, 11, slot)
        })
    };
    let before = w.private_bytes();
    assert_eq!(
        call(1),
        Err(game_core::SlotError::Occupied.to_string()),
        "a sibling's slot is occupied"
    );
    assert_eq!(w.private_bytes(), before, "a refused move writes nothing");
    assert_eq!(call(0), Ok(()), "re-seating a monster in its own slot");
    assert_eq!(w.row(11).unwrap().party_slot, 0);
    assert_eq!(call(2), Ok(()), "a free slot beside a boxed sibling");
    assert_eq!(w.row(11).unwrap().party_slot, 2);
    w.assert_mirrored("set_party_slot occupancy");
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
                acked_seq: 0,
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

/// movement.rs join_game and taming.rs insert_recruited (the tactical recruit's insert —
/// the 1v1 `attempt_recruit` that also reached it is deleted, bt-17): the two INSERT sites
/// create a private row and its projection together (the recruit's projection tier is the
/// species' fresh tier).
#[test]
fn dw_insert_sites() {
    use crate::schema::Character;
    // join_game: a brand-new player gets a starter pair.
    {
        let fx = fixture();
        let w = dw_world(&fx);
        let characters = fx
            .table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id)
            .writable()
            .unique()
            .auto_inc(|r| r.entity_id, |r, id| r.entity_id = id);
        let intents = fx
            .table_keyed::<crate::schema::MoveIntent, u64>("move_intent", "entity_id", |r| {
                r.entity_id
            })
            .writable()
            .unique();
        let ticks = fx
            .table_keyed::<crate::movement::MovementTickSchedule, u64>(
                "movement_tick_schedule",
                "id",
                |r| r.id,
            )
            .writable()
            .scannable()
            .unique()
            .auto_inc(|r| r.id, |r, id| r.id = id);
        // An earlier character, so the new one's auto-inc id is not the default 0 or 1.
        characters.seed(&Character {
            entity_id: 40,
            zone_id: 0,
            tile_x: 0,
            tile_y: 0,
            facing: game_core::Direction::South,
            action: game_core::ActionState::Idle,
            move_started_at_ms: 0,
            sprite_id: 0,
            move_queue: vec![],
            acked_seq: 0,
        });
        let got = fx.run_as_at(dw_c(), dw_at(DW_T0), |ctx| {
            crate::movement::join_game(ctx, "Cee".to_string())
        });
        assert_eq!(got, Ok(()), "join_game; asked {:?}", fx.requested_indexes());
        let joined: Vec<u64> = characters
            .rows()
            .into_iter()
            .map(|c| c.entity_id)
            .filter(|&id| id != 40)
            .collect();
        assert_eq!(joined.len(), 1, "one character for the joiner");
        let intent_rows: Vec<_> = intents
            .rows()
            .into_iter()
            .map(|i| (i.entity_id, i.queue, i.last_input_seq))
            .collect();
        assert_eq!(
            intent_rows,
            vec![(joined[0], vec![], 0)],
            "join_game creates the joiner's empty move_intent row, keyed by its character"
        );
        assert_eq!(
            ticks.rows().iter().map(|t| t.zone_id).collect::<Vec<_>>(),
            vec![crate::ZONE_0],
            "join_game arms the spawn zone's tick"
        );
        let rows = w.monsters.rows();
        assert_eq!(rows.len(), 1, "one starter");
        assert_eq!(rows[0].owner_identity, dw_c());
        w.assert_mirrored("join_game");
    }
    // insert_recruited: the tactical recruit's insert, called directly with a content species
    // whose tier is set to 3 (every seeded projection here carries tier 0, so a projection
    // written with a copied or default tier cannot pass).
    {
        let fx = fixture();
        let w = dw_world(&fx);
        w.monster(11, dw_a(), 0);
        let mut species = game_core::load_species()
            .expect("species content loads")
            .into_iter()
            .find(|s| s.id == 2)
            .expect("species 2 is in the content");
        species.tier = 3;
        let level = game_core::Level::new(5).expect("5 is a level");
        let inserted = fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
            crate::taming::insert_recruited(ctx, dw_a(), 77, &species, level)
        });
        let rows = w.monsters.rows();
        assert_eq!(rows.len(), 2, "monster 11 plus exactly one recruit");
        let stored = w
            .row(inserted.monster_id)
            .expect("the returned row is the stored row");
        assert_eq!(
            dw_bytes(&stored),
            dw_bytes(&inserted),
            "insert_recruited returns exactly the row it stored"
        );
        assert_eq!(
            (stored.owner_identity, stored.party_slot, stored.species_id),
            (dw_a(), crate::PARTY_SLOT_NONE, 2),
            "the owner's box, the recruited species"
        );
        w.assert_mirrored("insert_recruited");
        let new = w
            .pubs
            .rows()
            .into_iter()
            .find(|p| p.monster_id == inserted.monster_id)
            .expect("the recruit's projection");
        assert_eq!(
            new.tier, 3,
            "the recruit projection carries the species' fresh tier"
        );
    }
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

// ===========================================================================
// Trade sessions at the monster write seam.
//
// Lock-at-confirm: a monster on a CONFIRMED session side cannot be renamed; one on
// an unconfirmed side can; `set_party_slot` never rejects because of a session.
// Auto-cancel: a write through `update_monster_synced` that leaves an offered
// monster boxed, at 0 HP or owned by someone other than the side that offered it
// deletes every session listing it — the session row, ALL its snapshot rows and
// its reaper schedule row — and nothing else. Every world below runs on
// `dw_world` plus the three session tables; every session row is seeded with one
// snapshot row per offered monster (both sides) and one schedule row.
// ===========================================================================

use crate::schema::{TradeSession, TradeSessionSnapshot};
use crate::trading_session::TradeSessionReaperSchedule;

const TS2_LOCKED: &str = "monster is in an active trade";

fn ts2_d() -> Identity {
    Identity::from_byte_array([0xD4; 32])
}
fn ts2_e() -> Identity {
    Identity::from_byte_array([0xE5; 32])
}
/// The guest-claim destination identity.
fn ts2_z() -> Identity {
    Identity::from_byte_array([0x2F; 32])
}

/// One session side: the participant, its offered monster ids, whether it is confirmed.
type Ts2Side = (Identity, Vec<u64>, bool);
/// One session's footprint in the store: its row is present, the `monster_id` of each of
/// its snapshot rows (sorted), and how many schedule rows point at it.
type Ts2Footprint = (bool, Vec<u64>, usize);

struct Ts2Sessions<'a> {
    sessions: Handle<'a, TradeSession, u64>,
    snapshots: Handle<'a, TradeSessionSnapshot, u64>,
    schedules: Handle<'a, TradeSessionReaperSchedule, u64>,
}

/// Registers `trade_session` (key, opener, partner), `trade_session_snapshot` (key,
/// session id, monster id) and `trade_session_reaper_schedule` (key, session id), each
/// writable on its primary key.
fn ts2_session_tables(fx: &Fixture) -> Ts2Sessions<'_> {
    let sessions = fx
        .table_keyed::<TradeSession, u64>("trade_session", "session_id", |r| r.session_id)
        .writable()
        .unique();
    let _ = fx.table::<TradeSession>("trade_session", "opener", |r| r.opener);
    let _ = fx.table::<TradeSession>("trade_session", "partner", |r| r.partner);
    let snapshots = fx
        .table_keyed::<TradeSessionSnapshot, u64>("trade_session_snapshot", "snapshot_id", |r| {
            r.snapshot_id
        })
        .writable()
        .unique();
    let _ =
        fx.table_keyed::<TradeSessionSnapshot, u64>("trade_session_snapshot", "session_id", |r| {
            r.session_id
        });
    let _ =
        fx.table_keyed::<TradeSessionSnapshot, u64>("trade_session_snapshot", "monster_id", |r| {
            r.monster_id
        });
    let schedules = fx
        .table_keyed::<TradeSessionReaperSchedule, u64>(
            "trade_session_reaper_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        )
        .writable()
        .unique();
    let _ = fx.table_keyed::<TradeSessionReaperSchedule, u64>(
        "trade_session_reaper_schedule",
        "session_id",
        |r| r.session_id,
    );
    Ts2Sessions {
        sessions,
        snapshots,
        schedules,
    }
}

/// A masked review snapshot of `monster_id` for `session_id`.
fn ts2_snapshot(snapshot_id: u64, session_id: u64, monster_id: u64) -> TradeSessionSnapshot {
    TradeSessionSnapshot {
        snapshot_id,
        session_id,
        monster_id,
        species_id: 1,
        nickname: format!("m{monster_id}"),
        level: 7,
        xp: 0,
        iv_hp: 1,
        iv_attack: 2,
        iv_defense: 3,
        iv_speed: 4,
        iv_sp_attack: 5,
        iv_sp_defense: 6,
        nature_kind: game_core::NatureKind::Hardy,
        ev_hp: 1,
        ev_attack: 2,
        ev_defense: 3,
        ev_speed: 4,
        ev_sp_attack: 5,
        ev_sp_defense: 6,
        stat_hp: 40,
        stat_attack: 20,
        stat_defense: 20,
        stat_speed: 20,
        stat_sp_attack: 20,
        stat_sp_defense: 20,
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

impl Ts2Sessions<'_> {
    /// Seeds an open session (no items, no coins), one snapshot row per offered monster on
    /// either side (snapshot id `session_id * 100 + n`) and one reaper schedule row
    /// (scheduled id `session_id + 500`).
    fn open(&self, session_id: u64, opener_side: Ts2Side, partner_side: Ts2Side) {
        let (opener, opener_ids, opener_confirmed) = opener_side;
        let (partner, partner_ids, partner_confirmed) = partner_side;
        for (n, &monster_id) in (0u64..).zip(opener_ids.iter().chain(partner_ids.iter())) {
            self.snapshots
                .seed(&ts2_snapshot(session_id * 100 + n, session_id, monster_id));
        }
        let offer = |monster_ids: Vec<u64>| game_core::trading::TradeSessionOffer {
            monster_ids,
            items: vec![],
            currency: 0,
            cards: vec![],
        };
        self.sessions.seed(&TradeSession {
            session_id,
            opener,
            partner,
            opener_offer: offer(opener_ids),
            partner_offer: offer(partner_ids),
            opener_confirmed,
            partner_confirmed,
            revision: 1,
            created_at_ms: DW_T0,
        });
        self.schedules.seed(&TradeSessionReaperSchedule {
            scheduled_id: session_id + 500,
            scheduled_at: spacetimedb::ScheduleAt::Time(dw_at(DW_T0 + 3_600_000)),
            session_id,
        });
    }

    /// The store footprint of `session_id`.
    fn footprint(&self, session_id: u64) -> Ts2Footprint {
        let present = self
            .sessions
            .rows()
            .iter()
            .any(|s| s.session_id == session_id);
        let mut snapshot_monsters: Vec<u64> = self
            .snapshots
            .rows()
            .iter()
            .filter(|s| s.session_id == session_id)
            .map(|s| s.monster_id)
            .collect();
        snapshot_monsters.sort_unstable();
        let schedules = self
            .schedules
            .rows()
            .iter()
            .filter(|s| s.session_id == session_id)
            .count();
        (present, snapshot_monsters, schedules)
    }

    /// Asserts `session_id` is fully live with snapshot rows for exactly `monsters`.
    fn assert_live(&self, session_id: u64, monsters: &[u64], label: &str) {
        let mut want = monsters.to_vec();
        want.sort_unstable();
        let got = self.footprint(session_id);
        assert_eq!(
            got,
            (true, want, 1),
            "{label}: session {session_id} must survive whole — its row, one snapshot row per \
             offered monster and its schedule row; the store holds (row present, snapshot \
             monsters, schedule rows) = {got:?}."
        );
    }

    /// Asserts `session_id` is gone with every snapshot row and its schedule row.
    fn assert_gone(&self, session_id: u64, label: &str) {
        let got = self.footprint(session_id);
        assert_eq!(
            got,
            (false, Vec::new(), 0),
            "{label}: session {session_id} must be deleted together with ALL its snapshot rows \
             and its reaper schedule row; the store still holds (row present, snapshot monsters, \
             schedule rows) = {got:?}."
        );
    }
}

/// A battle with `player` on side A and `opponent` on side B; each entry is
/// `(monster_id, hp)` in team order.
fn ts2_battle(
    battle_id: u64,
    player: Identity,
    opponent: Identity,
    side_a: &[(u64, u16)],
    side_b: &[(u64, u16)],
) -> Battle {
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
    Battle {
        battle_id,
        player_identity: player,
        opponent_identity: opponent,
        state: game_core::BattleState {
            side_a: game_core::BattleSide {
                active: 0,
                team: side_a.iter().map(|&(_, hp)| mon(hp)).collect(),
            },
            side_b: game_core::BattleSide {
                active: 0,
                team: side_b.iter().map(|&(_, hp)| mon(hp)).collect(),
            },
            outcome: game_core::BattleOutcome::Ongoing,
            turn_number: 1,
            weather: None,
        },
        party_monster_ids: side_a.iter().map(|&(id, _)| id).collect(),
        opponent_monster_ids: side_b.iter().map(|&(id, _)| id).collect(),
        created_at_ms: DW_T0,
    }
}

/// The world most auto-cancel tests share. A owns 11 (slot 0), 12 (slot 1) and 15
/// (slot 2, listed by no session). Session 1: A opens with 11, B offers 21. Session 2: C
/// opens with 31, A offers 12 as partner. Session 9: D (41) and E (51), strangers.
/// Every side is unconfirmed.
fn ts2_shared_world<'a>(fx: &'a Fixture) -> (DwWorld<'a>, Ts2Sessions<'a>) {
    let w = dw_world(fx);
    let s = ts2_session_tables(fx);
    w.monster(11, dw_a(), 0);
    w.monster(12, dw_a(), 1);
    w.monster(15, dw_a(), 2);
    w.monster(21, dw_b(), 0);
    w.monster(31, dw_c(), 0);
    s.open(1, (dw_a(), vec![11], false), (dw_b(), vec![21], false));
    s.open(2, (dw_c(), vec![31], false), (dw_a(), vec![12], false));
    s.open(9, (ts2_d(), vec![41], false), (ts2_e(), vec![51], false));
    (w, s)
}

/// `set_nickname` refuses, with the legacy message, a monster on its owner's CONFIRMED
/// session side (as opener and as partner) and writes nothing; it renames a monster on an
/// UNCONFIRMED side (as opener and as partner, each beside a confirmed other side), and
/// the rename deletes no session.
///
/// kills: sessions absent from the rename guard (11 or 12 renamed) · one role only · the
/// confirmed flag ignored or read from the other side (13 or 14 refused).
#[test]
fn ts2_lock_at_confirm_set_nickname_refuses_a_confirmed_side_and_admits_an_unconfirmed_one() {
    let fx = fixture();
    let w = dw_world(&fx);
    let s = ts2_session_tables(&fx);
    for (id, slot) in [(11u64, 0u8), (12, 1), (13, 2), (14, 3)] {
        w.monster(id, dw_a(), slot);
    }
    s.open(1, (dw_a(), vec![11], true), (dw_b(), vec![21], false));
    s.open(2, (dw_c(), vec![31], false), (dw_a(), vec![12], true));
    s.open(3, (dw_a(), vec![13], false), (ts2_d(), vec![41], true));
    s.open(4, (ts2_e(), vec![51], true), (dw_a(), vec![14], false));
    let rename = |id: u64| {
        fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
            crate::monster_mgmt::set_nickname(ctx, id, "Sparky".to_string())
        })
    };

    for (id, role) in [(11u64, "opener"), (12, "partner")] {
        let got = rename(id);
        assert_eq!(
            got,
            Err(TS2_LOCKED.to_string()),
            "monster {id} is on its owner's CONFIRMED {role} side, so a rename must be refused \
             with exactly the legacy trade-lock message; it returned {got:?}."
        );
        assert_eq!(
            w.row(id).map(|m| m.nickname),
            Some(format!("m{id}")),
            "a refused rename of monster {id} must leave its nickname unchanged."
        );
    }

    for (id, role) in [(13u64, "opener"), (14, "partner")] {
        let got = rename(id);
        assert_eq!(
            got,
            Ok(()),
            "monster {id} is on its owner's UNCONFIRMED {role} side (the other side is \
             confirmed), which locks nothing, so the rename must succeed; it returned {got:?}."
        );
        assert_eq!(
            w.row(id).map(|m| m.nickname),
            Some("Sparky".to_string()),
            "the admitted rename of monster {id} must land on its row."
        );
    }

    s.assert_live(1, &[11, 21], "after the renames");
    s.assert_live(2, &[31, 12], "after the renames");
    s.assert_live(3, &[13, 41], "after the renames");
    s.assert_live(4, &[51, 14], "after the renames");
    w.assert_mirrored("set_nickname beside sessions");
}

/// `set_party_slot` never rejects because of a session: a monster on a CONFIRMED side (as
/// opener and as partner) moves party-to-party with its session intact, and moves to
/// Storage, which deletes its session.
///
/// kills: `set_party_slot` routed through the session-aware lock (both moves refused) ·
/// the box write not reaching the auto-cancel hook (the sessions survive).
#[test]
fn ts2_lock_at_confirm_set_party_slot_never_rejects_for_a_session() {
    let fx = fixture();
    let w = dw_world(&fx);
    let s = ts2_session_tables(&fx);
    w.monster(11, dw_a(), 0);
    w.monster(12, dw_a(), 1);
    s.open(1, (dw_a(), vec![11], true), (dw_b(), vec![21], true));
    s.open(2, (dw_c(), vec![31], true), (dw_a(), vec![12], true));
    let move_to = |id: u64, slot: u8| {
        fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
            crate::monster_mgmt::set_party_slot(ctx, id, slot)
        })
    };

    assert_eq!(
        move_to(11, 3),
        Ok(()),
        "a confirmed opener-side monster must move between party slots"
    );
    assert_eq!(
        move_to(12, 4),
        Ok(()),
        "a confirmed partner-side monster must move between party slots"
    );
    assert_eq!(w.row(11).map(|m| m.party_slot), Some(3));
    assert_eq!(w.row(12).map(|m| m.party_slot), Some(4));
    s.assert_live(1, &[11, 21], "after a party-to-party move");
    s.assert_live(2, &[31, 12], "after a party-to-party move");

    assert_eq!(
        move_to(11, crate::PARTY_SLOT_NONE),
        Ok(()),
        "boxing a confirmed opener-side monster must be accepted, not rejected"
    );
    assert_eq!(
        w.row(11).map(|m| m.party_slot),
        Some(crate::PARTY_SLOT_NONE)
    );
    s.assert_gone(1, "after boxing the opener's offered monster");
    s.assert_live(
        2,
        &[31, 12],
        "after boxing a monster session 2 does not list",
    );

    assert_eq!(
        move_to(12, crate::PARTY_SLOT_NONE),
        Ok(()),
        "boxing a confirmed partner-side monster must be accepted, not rejected"
    );
    s.assert_gone(2, "after boxing the partner's offered monster");
    w.assert_mirrored("set_party_slot beside sessions");
}

/// Boxing an offered monster through `set_party_slot` deletes the session listing it —
/// opener side, then partner side — with every snapshot row (both sides' monsters) and its
/// schedule row; the stranger session is untouched each time.
#[test]
fn ts2_auto_cancel_on_box() {
    let fx = fixture();
    let w = dw_world(&fx);
    let s = ts2_session_tables(&fx);
    w.monster(11, dw_a(), 0);
    w.monster(12, dw_a(), 1);
    w.monster(13, dw_a(), 2);
    s.open(1, (dw_a(), vec![11, 12], false), (dw_b(), vec![21], false));
    s.open(2, (dw_c(), vec![31], false), (dw_a(), vec![13], false));
    s.open(9, (ts2_d(), vec![41], false), (ts2_e(), vec![51], false));
    let to_box = |id: u64| {
        fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
            crate::monster_mgmt::set_party_slot(ctx, id, crate::PARTY_SLOT_NONE)
        })
    };

    assert_eq!(to_box(11), Ok(()), "boxing an offered monster is accepted");
    s.assert_gone(1, "boxing 11, offered on the opener side");
    s.assert_live(2, &[31, 13], "boxing 11, which session 2 does not list");
    s.assert_live(9, &[41, 51], "boxing 11, a stranger session");

    assert_eq!(to_box(13), Ok(()), "boxing an offered monster is accepted");
    s.assert_gone(2, "boxing 13, offered on the partner side");
    s.assert_live(9, &[41, 51], "boxing 13, a stranger session");
    w.assert_mirrored("auto-cancel on box");
}

/// A battle HP write-back of 0 into an offered monster deletes the session listing it;
/// a write-back of a positive HP in the same call keeps the session listing that one.
#[test]
fn ts2_auto_cancel_on_faint_writeback() {
    let fx = fixture();
    let (w, s) = ts2_shared_world(&fx);
    let write_back = |battle: Battle| {
        fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
            crate::battle::write_back_party_hp(ctx, &battle)
        })
    };

    let got = write_back(ts2_battle(
        800,
        dw_a(),
        crate::WILD_IDENTITY,
        &[(11, 0), (12, 25)],
        &[],
    ));
    assert_eq!(got, Ok(()), "the write-back runs to completion");
    assert_eq!(
        (
            w.row(11).map(|m| m.current_hp),
            w.row(12).map(|m| m.current_hp)
        ),
        (Some(0), Some(25)),
        "fixture: the write-back must land 0 HP on 11 and 25 HP on 12"
    );
    s.assert_gone(1, "0 HP written into 11, offered on the opener side");
    s.assert_live(
        2,
        &[31, 12],
        "25 HP written into 12, offered on the partner side",
    );
    s.assert_live(9, &[41, 51], "a stranger session");

    let got = write_back(ts2_battle(
        801,
        dw_a(),
        crate::WILD_IDENTITY,
        &[(12, 0)],
        &[],
    ));
    assert_eq!(got, Ok(()), "the write-back runs to completion");
    s.assert_gone(2, "0 HP written into 12, offered on the partner side");
    s.assert_live(9, &[41, 51], "a stranger session");
    w.assert_mirrored("auto-cancel on faint write-back");
}

/// The PvP side-B write-back of the player who did NOT disconnect, reached through the
/// disconnect forfeit and the settle funnel, writes 0 HP into two of that player's offered
/// monsters — one on an opener side, one on a partner side — and both sessions are deleted;
/// the stranger session is untouched.
///
/// Opens, beyond `dw_world` and the session tables, exactly what the settle path writes:
/// `profile` (the rating), `battle_action` (the sweep) and `pvp_deadline_schedule`.
#[test]
fn ts2_auto_cancel_on_pvp_settle_writeback() {
    use crate::schema::{BattleAction, Profile};
    let fx = fixture();
    let w = dw_world(&fx);
    let s = ts2_session_tables(&fx);
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
    w.monster(11, dw_a(), 0);
    w.monster(21, dw_b(), 0);
    w.monster(22, dw_b(), 1);
    s.open(1, (dw_b(), vec![21], false), (dw_c(), vec![31], false));
    s.open(2, (ts2_d(), vec![41], false), (dw_b(), vec![22], false));
    s.open(9, (ts2_e(), vec![51], false), (ts2_z(), vec![61], false));
    fx.table_keyed::<Battle, u64>("battle", "battle_id", |r| r.battle_id)
        .seed(&ts2_battle(
            900,
            dw_a(),
            dw_b(),
            &[(11, 30)],
            &[(21, 0), (22, 0)],
        ));

    let ctx = fx.ctx_at(dw_at(DW_T0));
    crate::pvp::forfeit_on_disconnect(&ctx, dw_a());

    assert_eq!(
        (
            w.row(21).map(|m| m.current_hp),
            w.row(22).map(|m| m.current_hp)
        ),
        (Some(0), Some(0)),
        "fixture: the side-B write-back must land 0 HP on B's monsters 21 and 22"
    );
    s.assert_gone(1, "0 HP written into 21, offered on B's opener side");
    s.assert_gone(2, "0 HP written into 22, offered on B's partner side");
    s.assert_live(9, &[51, 61], "a stranger session");
    w.assert_mirrored("auto-cancel on PvP side-B write-back");
}

/// The guest-claim re-key moves an offered monster to a new owner, so the side that offered
/// it is not its owner afterwards: the sessions listing A's monsters (A as opener, A as partner) are
/// deleted and the stranger session is untouched.
#[test]
fn ts2_auto_cancel_on_rekey() {
    let fx = fixture();
    let (w, s) = ts2_shared_world(&fx);

    let got = fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
        crate::monster_mgmt::rekey_monsters(ctx, dw_a(), ts2_z())
    });
    assert_eq!(got, Ok(()), "the re-key runs to completion");
    assert_eq!(
        (
            w.row(11).map(|m| m.owner_identity),
            w.row(12).map(|m| m.owner_identity)
        ),
        (Some(ts2_z()), Some(ts2_z())),
        "fixture: the re-key must move 11 and 12 to the claim destination"
    );
    s.assert_gone(
        1,
        "11, offered by A on the opener side, re-keyed away from A",
    );
    s.assert_gone(
        2,
        "12, offered by A on the partner side, re-keyed away from A",
    );
    s.assert_live(9, &[41, 51], "a stranger session");
    w.assert_mirrored("auto-cancel on re-key");
}

/// A rename of an offered monster on an unconfirmed side (opener and partner) keeps every
/// session; boxing one afterwards still cancels its session (the hook is live).
#[test]
fn ts2_auto_cancel_not_on_rename() {
    let fx = fixture();
    let (w, s) = ts2_shared_world(&fx);
    for id in [11u64, 12] {
        let got = fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
            crate::monster_mgmt::set_nickname(ctx, id, "Ember".to_string())
        });
        assert_eq!(
            got,
            Ok(()),
            "renaming unconfirmed-side monster {id} is accepted"
        );
    }
    s.assert_live(
        1,
        &[11, 21],
        "a rename of 11 (same owner, in party, HP above 0)",
    );
    s.assert_live(
        2,
        &[31, 12],
        "a rename of 12 (same owner, in party, HP above 0)",
    );
    s.assert_live(9, &[41, 51], "a stranger session");

    let got = fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
        crate::monster_mgmt::set_party_slot(ctx, 11, crate::PARTY_SLOT_NONE)
    });
    assert_eq!(got, Ok(()), "positive control: boxing 11 is accepted");
    s.assert_gone(1, "positive control: boxing 11 after the renames");
    w.assert_mirrored("rename beside sessions");
}

/// A party-to-party slot move of an offered monster (opener and partner side) keeps every
/// session; boxing one afterwards still cancels its session.
#[test]
fn ts2_auto_cancel_not_on_party_move() {
    let fx = fixture();
    let (w, s) = ts2_shared_world(&fx);
    for (id, slot) in [(11u64, 3u8), (12, 4)] {
        let got = fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
            crate::monster_mgmt::set_party_slot(ctx, id, slot)
        });
        assert_eq!(got, Ok(()), "moving {id} to party slot {slot} is accepted");
        assert_eq!(w.row(id).map(|m| m.party_slot), Some(slot));
    }
    s.assert_live(1, &[11, 21], "a party-to-party move of 11");
    s.assert_live(2, &[31, 12], "a party-to-party move of 12");
    s.assert_live(9, &[41, 51], "a stranger session");

    let got = fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
        crate::monster_mgmt::set_party_slot(ctx, 12, crate::PARTY_SLOT_NONE)
    });
    assert_eq!(got, Ok(()), "positive control: boxing 12 is accepted");
    s.assert_gone(2, "positive control: boxing 12 after the moves");
    s.assert_live(1, &[11, 21], "boxing 12, which session 1 does not list");
    w.assert_mirrored("party move beside sessions");
}

/// An HP write-back of a positive value (1, the boundary, and the full 40) into offered
/// monsters keeps every session; a later 0 HP write-back still cancels.
#[test]
fn ts2_auto_cancel_not_on_positive_hp_writeback() {
    let fx = fixture();
    let (w, s) = ts2_shared_world(&fx);
    let write_back = |battle: Battle| {
        fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
            crate::battle::write_back_party_hp(ctx, &battle)
        })
    };

    let got = write_back(ts2_battle(
        800,
        dw_a(),
        crate::WILD_IDENTITY,
        &[(11, 1), (12, 40)],
        &[],
    ));
    assert_eq!(got, Ok(()), "the write-back runs to completion");
    assert_eq!(
        (
            w.row(11).map(|m| m.current_hp),
            w.row(12).map(|m| m.current_hp)
        ),
        (Some(1), Some(40)),
        "fixture: the write-back must land 1 HP on 11 and 40 HP on 12"
    );
    s.assert_live(1, &[11, 21], "1 HP written into 11");
    s.assert_live(2, &[31, 12], "40 HP written into 12");

    let got = write_back(ts2_battle(
        801,
        dw_a(),
        crate::WILD_IDENTITY,
        &[(11, 0)],
        &[],
    ));
    assert_eq!(got, Ok(()), "the write-back runs to completion");
    s.assert_gone(1, "positive control: 0 HP written into 11");
    s.assert_live(
        2,
        &[31, 12],
        "0 HP written into 11, which session 2 does not list",
    );
    w.assert_mirrored("positive HP beside sessions");
}

/// Boxing one monster and writing 0 HP into another, neither listed by any session, deletes
/// nothing; boxing an offered one afterwards still cancels its session.
#[test]
fn ts2_auto_cancel_not_on_unlisted_monster() {
    let fx = fixture();
    let (w, s) = ts2_shared_world(&fx);
    // Monster 32 belongs to C and is offered nowhere; C's offered monster is 31.
    w.monster(32, dw_c(), 1);

    let got = fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
        crate::monster_mgmt::set_party_slot(ctx, 15, crate::PARTY_SLOT_NONE)
    });
    assert_eq!(got, Ok(()), "boxing unlisted monster 15 is accepted");
    let got = fx.run_as_at(dw_c(), dw_at(DW_T0), |ctx| {
        crate::battle::write_back_party_hp(
            ctx,
            &ts2_battle(800, dw_c(), crate::WILD_IDENTITY, &[(32, 0)], &[]),
        )
    });
    assert_eq!(
        got,
        Ok(()),
        "a 0 HP write-back into unlisted monster 32 runs"
    );
    s.assert_live(1, &[11, 21], "writes to unlisted monsters 15 and 32");
    s.assert_live(2, &[31, 12], "writes to unlisted monsters 15 and 32");
    s.assert_live(9, &[41, 51], "writes to unlisted monsters 15 and 32");

    let got = fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
        crate::monster_mgmt::set_party_slot(ctx, 11, crate::PARTY_SLOT_NONE)
    });
    assert_eq!(got, Ok(()), "positive control: boxing 11 is accepted");
    s.assert_gone(1, "positive control: boxing offered monster 11");
    s.assert_live(2, &[31, 12], "boxing 11, which session 2 does not list");
    w.assert_mirrored("unlisted monster writes beside sessions");
}

/// Boxing a monster listed by one of A's sessions deletes that session only: A's other
/// session in the SAME role (opener) and a session where A is partner both survive whole.
#[test]
fn ts2_auto_cancel_not_on_a_sibling_session() {
    let fx = fixture();
    let w = dw_world(&fx);
    let s = ts2_session_tables(&fx);
    w.monster(11, dw_a(), 0);
    w.monster(12, dw_a(), 1);
    w.monster(13, dw_a(), 2);
    s.open(1, (dw_a(), vec![11], false), (dw_b(), vec![21], false));
    s.open(3, (dw_a(), vec![12], false), (dw_c(), vec![31], true));
    s.open(4, (ts2_d(), vec![41], true), (dw_a(), vec![13], false));

    let got = fx.run_as_at(dw_a(), dw_at(DW_T0), |ctx| {
        crate::monster_mgmt::set_party_slot(ctx, 11, crate::PARTY_SLOT_NONE)
    });
    assert_eq!(got, Ok(()), "boxing 11 is accepted");
    s.assert_gone(1, "boxing 11, listed by session 1");
    s.assert_live(
        3,
        &[12, 31],
        "boxing 11, listed by A's sibling opener session 1 only",
    );
    s.assert_live(
        4,
        &[41, 13],
        "boxing 11, listed by A's session 1, not A's partner session",
    );
    w.assert_mirrored("sibling sessions");
}
