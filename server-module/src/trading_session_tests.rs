//! ts-0a seam tests: the four helpers that moved out of `trading.rs` into
//! `trading_session.rs`, reached THROUGH the destination module (`super::`).
//!
//! Behaviour-preserving move: each test pins an outcome on real rows (native
//! host) or on a pure oracle (`game_core`'s `reset_bond_on_trade`), never the
//! existence of a symbol. The native host models no transaction rollback, so
//! an `Err` case asserts only what the helper returned.

use crate::native_host_tests::{fixture, Fixture, Handle};
use crate::schema::{Inventory, Monster, MonsterPub, PlayerWallet};
use game_core::raising::rules::{reset_bond_on_trade, TrainerBond};
use game_core::{build_swap_plan, ItemStack, LiveMonsterOwner, MonsterCard, TradeItem};
use spacetimedb::Identity;

fn alice() -> Identity {
    Identity::from_byte_array([0xA1; 32])
}
fn bob() -> Identity {
    Identity::from_byte_array([0xB2; 32])
}
fn item(item_id: u32, qty: u32) -> TradeItem {
    TradeItem { item_id, qty }
}
fn live(monster_id: u64) -> LiveMonsterOwner {
    LiveMonsterOwner {
        monster_id,
        owner_matches_expected: true,
    }
}
fn bytes<T: spacetimedb::Serialize>(row: &T) -> Vec<u8> {
    spacetimedb::sats::bsatn::to_vec(row).expect("a row BSATN-encodes")
}

/// A row whose seven bond columns are nonzero and pairwise distinct, with
/// nonzero xp / essence / anchors and a level and genes that differ per id, so
/// a rebuilt row, a missed bond column and a reset that strayed are all visible.
fn bonded(monster_id: u64, owner: Identity, party_slot: u8, k: u8) -> Monster {
    let n = u32::from(k);
    let g = (monster_id % 29) as u8 + 1;
    let e = u16::from(g);
    Monster {
        monster_id,
        owner_identity: owner,
        species_id: 3,
        nickname: format!("t{monster_id}"),
        level: 20 + k,
        xp: 1_000 * n + 77,
        iv_hp: g,
        iv_attack: g + 1,
        iv_defense: g + 2,
        iv_speed: g + 3,
        iv_sp_attack: g + 4,
        iv_sp_defense: g + 5,
        nature_kind: game_core::Nature::from_index(k).kind(),
        ev_hp: e,
        ev_attack: e + 1,
        ev_defense: e + 2,
        ev_speed: e + 3,
        ev_sp_attack: e + 4,
        ev_sp_defense: e + 5,
        stat_hp: 44,
        stat_attack: 21,
        stat_defense: 22,
        stat_speed: 23,
        stat_sp_attack: 24,
        stat_sp_defense: 25,
        current_hp: 17,
        party_slot,
        last_care_at_ms: 5_000 + i64::from(k),
        essence_fire: 100 * n + 1,
        essence_water: 100 * n + 2,
        essence_plant: 100 * n + 3,
        essence_electric: 100 * n + 4,
        essence_earth: 100 * n + 5,
        essence_wind: 100 * n + 6,
        essence_light: 100 * n + 7,
        essence_dark: 100 * n + 8,
        trust_favorable_count: 40 + n,
        trust_unfavorable_count: 1 + n,
        trust_favorable_battle_day_epoch: 20_000 + n,
        quality_time_ticks_total: 60 + n,
        quality_time_accum_ms: 7_000 + n,
        quality_time_window_ms: 30_000 + n,
        quality_time_window_start_ms: 1_000_000 + i64::from(k),
        last_essence_train_at_ms: 9_000 + i64::from(k),
    }
}

/// `bonded(..)` after a trade: re-keyed, re-slotted, and the seven bond columns
/// at the game-core baseline (computed from the rule, not hardcoded). Every
/// other column is the seeded one.
fn bonded_after_trade(monster_id: u64, owner: Identity, party_slot: u8, k: u8) -> Monster {
    let mut bond = TrainerBond {
        trust_favorable_count: 1,
        trust_unfavorable_count: 2,
        trust_favorable_battle_day_epoch: 3,
        quality_time_ticks_total: 4,
        quality_time_accum_ms: 5,
        quality_time_window_ms: 6,
        quality_time_window_start_ms: 7,
    };
    reset_bond_on_trade(&mut bond);
    Monster {
        trust_favorable_count: bond.trust_favorable_count,
        trust_unfavorable_count: bond.trust_unfavorable_count,
        trust_favorable_battle_day_epoch: bond.trust_favorable_battle_day_epoch,
        quality_time_ticks_total: bond.quality_time_ticks_total,
        quality_time_accum_ms: bond.quality_time_accum_ms,
        quality_time_window_ms: bond.quality_time_window_ms,
        quality_time_window_start_ms: bond.quality_time_window_start_ms,
        ..bonded(monster_id, owner, party_slot, k)
    }
}

/// The four tables the helpers touch, write-enabled. The `inv_id` index is the
/// one `grant_item` / `consume_one` update and delete through.
struct World<'a> {
    monsters: Handle<'a, Monster, u64>,
    pubs: Handle<'a, MonsterPub, u64>,
    stacks: Handle<'a, Inventory>,
    wallets: Handle<'a, PlayerWallet>,
}

fn world(fx: &Fixture) -> World<'_> {
    let monsters = fx
        .table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id)
        .writable()
        .unique();
    let pubs = fx
        .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
        .writable()
        .unique();
    let stacks = fx
        .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
        .writable()
        .auto_inc(|r| r.inv_id, |r, id| r.inv_id = id);
    let _ = fx
        .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
        .unique();
    let wallets = fx
        .table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity)
        .writable()
        .unique();
    World {
        monsters,
        pubs,
        stacks,
        wallets,
    }
}

impl World<'_> {
    /// Seed `m` and the `monster_pub` projection the server holds for it at `tier`.
    fn monster(&self, m: &Monster, tier: u8) {
        self.monsters.seed(m);
        self.pubs.seed(&crate::marshal::pub_from_monster(m, tier));
    }
    /// Seeded stack ids start at 1000 so the modelled auto-inc never collides.
    fn stack(&self, owner: Identity, item_id: u32, count: u32) {
        let inv_id = 1000 + u64::from(owner.to_byte_array()[0]) * 100 + u64::from(item_id);
        self.stacks.seed(&Inventory {
            inv_id,
            owner_identity: owner,
            item_id,
            count,
        });
    }
    fn wallet(&self, owner: Identity, balance: u64) {
        self.wallets.seed(&PlayerWallet {
            owner_identity: owner,
            balance,
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
    fn balance(&self, owner: Identity) -> u64 {
        self.wallets
            .rows()
            .iter()
            .filter(|r| r.owner_identity == owner)
            .map(|r| r.balance)
            .sum()
    }
    fn monster_row(&self, id: u64) -> Monster {
        self.monsters
            .rows()
            .into_iter()
            .find(|m| m.monster_id == id)
            .unwrap_or_else(|| panic!("monster {id}: no private row"))
    }
    fn pub_row(&self, id: u64) -> MonsterPub {
        self.pubs
            .rows()
            .into_iter()
            .find(|p| p.monster_id == id)
            .unwrap_or_else(|| panic!("monster {id}: no monster_pub row"))
    }
}

/// One monster per side (11 alice's, 21 bob's), seeded with distinct bonds,
/// tiers and slots; swap them under `dest_slot` and read the rows back.
type Swapped = (Result<(), String>, Monster, Monster, MonsterPub, MonsterPub);

fn swap_one_each(dest_slot: impl Fn(u64) -> u8) -> Swapped {
    let fx = fixture();
    let w = world(&fx);
    w.monster(&bonded(11, alice(), 0, 1), 2);
    w.monster(&bonded(21, bob(), 2, 2), 1);
    let plan = build_swap_plan(&[live(11)], &[live(21)], &[], &[], 0, 0).expect("plan builds");
    let got = fx.run_as(alice(), |ctx| {
        super::apply_swap(ctx, &plan, alice(), bob(), dest_slot)
    });
    (
        got,
        w.monster_row(11),
        w.monster_row(21),
        w.pub_row(11),
        w.pub_row(21),
    )
}

/// `apply_swap` writes `dest_slot(monster_id)` — not a constant — onto BOTH the
/// private row and the projection, re-keys each monster to the OTHER party,
/// resets the bond, leaves every other column alone, and copies the tier forward.
/// kills: ignoring `dest_slot` (hardcoding NONE), writing the slot to only one of
/// the two rows, swapping the two owners, skipping the bond reset, rebuilding the
/// tier.
#[test]
fn ts0a_apply_swap_writes_dest_slot_owner_and_bond_reset_to_both_rows() {
    let slot_of = |id: u64| u8::try_from(id % 7).expect("small") + 1; // 11 -> 5, 21 -> 1
    assert_ne!(slot_of(11), crate::PARTY_SLOT_NONE);
    assert_ne!(slot_of(21), crate::PARTY_SLOT_NONE);
    assert_ne!(slot_of(11), slot_of(21));

    let (got, m11, m21, p11, p21) = swap_one_each(slot_of);
    assert_eq!(got, Ok(()));

    let want11 = bonded_after_trade(11, bob(), slot_of(11), 1);
    let want21 = bonded_after_trade(21, alice(), slot_of(21), 2);
    assert_ne!(
        bytes(&want11),
        bytes(&bonded(11, bob(), slot_of(11), 1)),
        "the oracle must differ from the unreset row, or the bond check is vacuous"
    );
    assert_eq!(bytes(&m11), bytes(&want11), "monster 11 private row");
    assert_eq!(bytes(&m21), bytes(&want21), "monster 21 private row");
    assert_eq!(
        bytes(&p11),
        bytes(&crate::marshal::pub_from_monster(&want11, 2)),
        "monster 11 projection: new owner, dest slot, tier 2 carried forward"
    );
    assert_eq!(
        bytes(&p21),
        bytes(&crate::marshal::pub_from_monster(&want21, 1)),
        "monster 21 projection: new owner, dest slot, tier 1 carried forward"
    );
    assert_eq!((p11.party_slot, p21.party_slot), (5, 1));
    assert_eq!((p11.owner_identity, p21.owner_identity), (bob(), alice()));
}

/// The `confirm_trade` call shape: `|_| PARTY_SLOT_NONE` lands every transferred
/// monster in Storage, on both rows, with the same owner flip and bond reset.
/// kills: a dest_slot-ignoring impl that hardcodes a slot, an impl that forgets
/// to unslot the projection.
#[test]
fn ts0a_apply_swap_with_none_dest_slot_unslots_both_rows() {
    let (got, m11, m21, p11, p21) = swap_one_each(|_| crate::PARTY_SLOT_NONE);
    assert_eq!(got, Ok(()));
    assert_eq!(
        bytes(&m11),
        bytes(&bonded_after_trade(11, bob(), crate::PARTY_SLOT_NONE, 1))
    );
    assert_eq!(
        bytes(&m21),
        bytes(&bonded_after_trade(21, alice(), crate::PARTY_SLOT_NONE, 2))
    );
    assert_eq!(p11.party_slot, crate::PARTY_SLOT_NONE);
    assert_eq!(p21.party_slot, crate::PARTY_SLOT_NONE);
    assert_eq!((p11.owner_identity, p21.owner_identity), (bob(), alice()));
}

/// A plan naming a monster with no private row, or with no projection row, is an
/// `Err` (fail loud, never skip). Today's messages are pinned.
/// kills: `if let Some` skip-on-missing, `unwrap_or` of a default projection.
#[test]
fn ts0a_apply_swap_missing_monster_or_projection_row_is_err() {
    for (label, seed_private, seed_pub, want) in [
        ("no private row", false, false, "monster 11 gone during apply"),
        (
            "no projection row",
            true,
            false,
            "monster_pub 11 gone during apply",
        ),
    ] {
        let fx = fixture();
        let w = world(&fx);
        let m = bonded(11, alice(), 0, 1);
        if seed_private {
            w.monsters.seed(&m);
        }
        if seed_pub {
            w.pubs.seed(&crate::marshal::pub_from_monster(&m, 0));
        }
        let plan = build_swap_plan(&[live(11)], &[], &[], &[], 0, 0).expect("plan builds");
        let got = fx.run_as(alice(), |ctx| {
            super::apply_swap(ctx, &plan, alice(), bob(), |_| crate::PARTY_SLOT_NONE)
        });
        assert_eq!(got, Err(want.to_string()), "{label}");
    }
}

/// Debits land before credits: a same-item bilateral swap where alice sits 9 under
/// the stack cap, gives 15 and receives 20 only comes out exact (cap - 4) because
/// her debit precedes her credit; credit-first would clamp at the cap and lose 5.
/// Bob's side nets to 15; both stacks come out single-row.
/// kills: credits-before-debits, per-transfer interleaving, swapped initiator /
/// counterparty on the item legs.
#[test]
fn ts0a_apply_swap_item_debits_land_before_credits() {
    let cap = game_core::MAX_ITEM_STACK;
    let fx = fixture();
    let w = world(&fx);
    w.stack(alice(), 5, cap - 9);
    w.stack(alice(), 9, 1);
    w.stack(bob(), 5, 20);
    let plan = build_swap_plan(&[], &[], &[item(5, 15), item(9, 1)], &[item(5, 20)], 0, 0)
        .expect("plan builds");
    let got = fx.run_as(alice(), |ctx| {
        super::apply_swap(ctx, &plan, alice(), bob(), |_| crate::PARTY_SLOT_NONE)
    });
    assert_eq!(got, Ok(()));
    assert_eq!(w.count(alice(), 5), cap - 9 - 15 + 20, "exact netted credit");
    assert_eq!(w.count(alice(), 9), 0, "fully given stack is gone");
    assert_eq!(w.count(bob(), 5), 15, "bob nets 20 - 20 + 15");
    assert_eq!(w.count(bob(), 9), 1, "bob receives the item he lacked");
    let rows = w.stacks.rows();
    let mut pairs: Vec<(Identity, u32)> =
        rows.iter().map(|s| (s.owner_identity, s.item_id)).collect();
    let total = pairs.len();
    pairs.sort_unstable();
    pairs.dedup();
    assert_eq!(pairs.len(), total, "one stack row per (owner, item)");
}

/// Currency legs move each side's amount to the OTHER wallet; a sender who cannot
/// cover their leg makes the whole call `Err`.
/// kills: credit direction inverted, currency leg dropped, spend error swallowed.
#[test]
fn ts0a_apply_swap_currency_moves_both_ways_and_broke_sender_is_err() {
    {
        let fx = fixture();
        let w = world(&fx);
        w.wallet(alice(), 100);
        w.wallet(bob(), 10);
        let plan = build_swap_plan(&[], &[], &[], &[], 40, 5).expect("plan builds");
        let got = fx.run_as(alice(), |ctx| {
            super::apply_swap(ctx, &plan, alice(), bob(), |_| crate::PARTY_SLOT_NONE)
        });
        assert_eq!(got, Ok(()));
        assert_eq!(
            (w.balance(alice()), w.balance(bob())),
            (100 - 40 + 5, 10 - 5 + 40)
        );
    }
    let fx = fixture();
    let w = world(&fx);
    w.wallet(alice(), 30);
    w.wallet(bob(), 10);
    let plan = build_swap_plan(&[], &[], &[], &[], 40, 0).expect("plan builds");
    let got = fx.run_as(alice(), |ctx| {
        super::apply_swap(ctx, &plan, alice(), bob(), |_| crate::PARTY_SLOT_NONE)
    });
    assert!(got.is_err(), "a broke sender must be refused, got {got:?}");
}

/// The receiver's post-debit effective stacks, one per RECEIVING item in
/// `receiving` order: held count (0 with no row, only the RECEIVER's rows) minus
/// the same item's quantity in `sending`, saturating at 0.
/// kills: wrong owner lookup, no netting, plain `-` instead of saturating, output
/// reordered, iterating `sending` instead of `receiving`.
#[test]
fn ts0a_netted_receiver_stacks_nets_saturates_and_follows_receiving_order() {
    let fx = fixture();
    let w = world(&fx);
    w.stack(alice(), 5, 10);
    w.stack(alice(), 6, 3);
    w.stack(bob(), 8, 77); // decoy: alice has no item 8
    let got = fx.run_as(alice(), |ctx| {
        super::netted_receiver_stacks(
            ctx,
            alice(),
            &[item(5, 2), item(8, 4), item(6, 1)],
            &[item(5, 4), item(6, 9), item(7, 1)],
        )
    });
    assert_eq!(
        got,
        vec![
            ItemStack {
                item_id: 5,
                current_count: 6
            },
            ItemStack {
                item_id: 8,
                current_count: 0
            },
            ItemStack {
                item_id: 6,
                current_count: 0
            },
        ]
    );
}

/// `snapshot_cards` returns one card per id in the CALLER-GIVEN order with the
/// live level / hp / nickname; an unknown id and a foreign-owned id each refuse
/// with today's messages.
/// kills: sorting the ids, stale or default card fields, dropping the owner check,
/// changed error text.
#[test]
fn ts0a_snapshot_cards_returns_live_cards_and_refuses_missing_or_foreign() {
    let fx = fixture();
    let w = world(&fx);
    w.monsters.seed(&Monster {
        nickname: "Ember".to_string(),
        level: 12,
        current_hp: 9,
        stat_hp: 51,
        species_id: 4,
        ..bonded(21, alice(), 0, 1)
    });
    w.monsters.seed(&bonded(11, alice(), 1, 2));
    w.monsters.seed(&bonded(31, bob(), 0, 3));
    let (ok, missing, foreign) = fx.run_as(alice(), |ctx| {
        (
            super::snapshot_cards(ctx, &[21, 11], alice(), "propose_trade"),
            super::snapshot_cards(ctx, &[11, 99], alice(), "propose_trade"),
            super::snapshot_cards(ctx, &[11, 31], alice(), "propose_trade"),
        )
    });
    let seeded11 = bonded(11, alice(), 1, 2);
    assert_eq!(
        ok,
        Ok(vec![
            MonsterCard {
                monster_id: 21,
                species_id: 4,
                nickname: "Ember".to_string(),
                level: 12,
                current_hp: 9,
                stat_hp: 51,
            },
            MonsterCard {
                monster_id: 11,
                species_id: seeded11.species_id,
                nickname: seeded11.nickname.clone(),
                level: seeded11.level,
                current_hp: seeded11.current_hp,
                stat_hp: seeded11.stat_hp,
            },
        ])
    );
    assert_eq!(missing, Err("monster 99 not found".to_string()));
    assert_eq!(foreign, Err("monster 31 not owned by caller".to_string()));
}

/// All seven bond columns return to the game-core baseline (the oracle is the
/// rule itself, applied to a `TrainerBond`); every other column is byte-identical.
/// kills: a column left out of the copy-in or copy-back, a column swapped with a
/// neighbour, a reset that also touches level / xp / genes / essence.
#[test]
fn ts0a_reset_trainer_bond_resets_exactly_the_seven_bond_columns() {
    let mut m = bonded(11, alice(), 3, 5);
    let before = bytes(&bonded(11, alice(), 3, 5));
    super::reset_trainer_bond(&mut m);
    let want = bonded_after_trade(11, alice(), 3, 5);
    assert_ne!(bytes(&want), before, "the reset must change the row");
    assert_eq!(bytes(&m), bytes(&want));
}
