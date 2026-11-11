//! Seam tests for the trade-session helpers in `trading_session.rs`
//! (`snapshot_cards`, `reset_trainer_bond`, `netted_receiver_stacks`,
//! `apply_swap`), reached through `super::`.
//!
//! Each test pins an outcome on real rows (native host) or on a pure oracle
//! (`game_core`'s `reset_bond_on_trade`). Every helper call runs as `carol()`,
//! a party that is never the receiver, expected owner, initiator or
//! counterparty passed in, so a helper that read `ctx.sender()` instead of its
//! argument reads the wrong rows. The native host models no transaction
//! rollback, so an `Err` case asserts only what the helper returned.
//!
//! The `ts2_` suite below runs the session reducers and the write-seam hook
//! through `super::` with a real sender (see the banner above `S2World`).

use crate::native_host_tests::{fixture, Fixture, Handle};
use crate::schema::{
    Account, Battle, Character, Inventory, ItemRow, Monster, MonsterPub, Player, PlayerWallet,
    TradeOffer, TradeSession, TradeSessionSnapshot,
};
use game_core::currency::MAX_BALANCE;
use game_core::raising::rules::{reset_bond_on_trade, TrainerBond};
use game_core::trading::{
    MonsterSnapshot, TradeSessionError, TradeSessionOffer, MAX_TRADE_ITEMS_PER_SIDE,
    TRADE_SESSION_TTL_MS,
};
use game_core::{
    build_swap_plan, make_monster_card, ActionState, Direction, ItemStack, LiveMonsterOwner,
    MonsterCard, TradeError, TradeItem, TradeStatus, MAX_ITEM_STACK, MAX_TRADE_MONSTERS_PER_SIDE,
    PARTY_SIZE,
};
use spacetimedb::{Identity, ScheduleAt, Timestamp};

fn alice() -> Identity {
    Identity::from_byte_array([0xA1; 32])
}
fn bob() -> Identity {
    Identity::from_byte_array([0xB2; 32])
}
fn carol() -> Identity {
    Identity::from_byte_array([0xC3; 32])
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

type Swapped = (Result<(), String>, Monster, Monster, MonsterPub, MonsterPub);

/// One monster per side (11 alice's, 21 bob's), seeded with distinct bonds,
/// tiers and slots; swap them under `dest_slot` and read the rows back.
fn swap_one_each(dest_slot: impl Fn(u64) -> u8) -> Swapped {
    let fx = fixture();
    let w = world(&fx);
    w.monster(&bonded(11, alice(), 0, 1), 2);
    w.monster(&bonded(21, bob(), 2, 2), 1);
    let plan = build_swap_plan(&[live(11)], &[live(21)], &[], &[], 0, 0).expect("plan builds");
    let got = fx.run_as(carol(), |ctx| {
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
/// `Err` (fail loud, never skip) carrying the exact message.
/// kills: `if let Some` skip-on-missing, `unwrap_or` of a default projection.
#[test]
fn ts0a_apply_swap_missing_monster_or_projection_row_is_err() {
    for (label, seed_private, want) in [
        ("no private row", false, "monster 11 gone during apply"),
        (
            "no projection row",
            true,
            "monster_pub 11 gone during apply",
        ),
    ] {
        let fx = fixture();
        let w = world(&fx);
        if seed_private {
            w.monsters.seed(&bonded(11, alice(), 0, 1));
        }
        let plan = build_swap_plan(&[live(11)], &[], &[], &[], 0, 0).expect("plan builds");
        let got = fx.run_as(carol(), |ctx| {
            super::apply_swap(ctx, &plan, alice(), bob(), |_| crate::PARTY_SLOT_NONE)
        });
        assert_eq!(got, Err(want.to_string()), "{label}");
    }
}

/// Debits land before credits: a same-item bilateral swap where alice sits 9 under
/// the stack cap, gives 15 and receives 20 only comes out exact (cap - 4) because
/// her debit precedes her credit; credit-first would clamp cap - 9 + 20 to the cap
/// and then end at cap - 15, losing 11. Bob's side nets to 15; both stacks come
/// out single-row.
/// kills: credits-before-debits, swapped initiator / counterparty on the item
/// legs, `initiator` replaced by `ctx.sender()`.
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
    let got = fx.run_as(carol(), |ctx| {
        super::apply_swap(ctx, &plan, alice(), bob(), |_| crate::PARTY_SLOT_NONE)
    });
    assert_eq!(got, Ok(()));
    assert_eq!(
        w.count(alice(), 5),
        cap - 9 - 15 + 20,
        "exact netted credit"
    );
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
        let got = fx.run_as(carol(), |ctx| {
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
    let got = fx.run_as(carol(), |ctx| {
        super::apply_swap(ctx, &plan, alice(), bob(), |_| crate::PARTY_SLOT_NONE)
    });
    assert!(got.is_err(), "a broke sender must be refused, got {got:?}");
}

/// The receiver's post-debit effective stacks, one per RECEIVING item in
/// `receiving` order: held count (0 with no row, only the RECEIVER's rows) minus
/// the same item's quantity in `sending`, saturating at 0.
/// kills: wrong owner lookup (including `ctx.sender()` for `receiver`), no netting, plain `-` instead of saturating, output
/// reordered, iterating `sending` instead of `receiving`.
#[test]
fn ts0a_netted_receiver_stacks_nets_saturates_and_follows_receiving_order() {
    let fx = fixture();
    let w = world(&fx);
    w.stack(alice(), 5, 10);
    w.stack(alice(), 6, 3);
    w.stack(bob(), 8, 77); // decoy: alice has no item 8
    let got = fx.run_as(carol(), |ctx| {
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
/// with `monster {id} not found` / `monster {id} not owned by caller`.
/// kills: sorting the ids, stale or default card fields, dropping the owner check,
/// `expected_owner` replaced by `ctx.sender()`, changed error text.
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
    let (ok, missing, foreign) = fx.run_as(carol(), |ctx| {
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
/// kills: a dropped copy-back line (a bond column left at its seeded value), a
/// reset that also touches level / xp / genes / essence. The rule zeroes every
/// column, so copy-in omissions and same-type copy-back swaps are equivalent
/// mutants this test cannot see.
#[test]
fn ts0a_reset_trainer_bond_resets_exactly_the_seven_bond_columns() {
    let mut m = bonded(11, alice(), 3, 5);
    let before = bytes(&bonded(11, alice(), 3, 5));
    super::reset_trainer_bond(&mut m);
    let want = bonded_after_trade(11, alice(), 3, 5);
    assert_ne!(bytes(&want), before, "the reset must change the row");
    assert_eq!(bytes(&m), bytes(&want));
}

// ===========================================================================
// The session reducers (`open_trade_session`, `set_trade_offer`,
// `confirm_trade_session`, `cancel_trade_session`, `trade_session_reaper`) and
// the write-seam hook, executed through `super::` with a real sender.
//
// `S2World` opens every table a session reducer writes (the three session
// tables, and the four asset tables an execute writes) and registers every
// index one reads. The host has no rollback, so a refusal is asserted as: the
// exact `Err`, zero write syscalls on every session and asset table, and every
// one of those rows byte-identical afterwards (`s2_refused`).
//
// Standard world (`s2_std`): alice and bob joined on the same tile; alice owns
// monsters 11 (slot 0) and 12 (slot 1), 10 of item 5 and 500 coins; bob owns
// 21 (slot 0) and 22 (slot 1), 10 of item 6 and 300 coins; items 5, 6 and 7
// are registered. Every call runs at `T0` unless it says otherwise.
// ===========================================================================

const T0: i64 = 1_750_000_000_000;
const SESSION_TABLES: [&str; 3] = [
    "trade_session",
    "trade_session_snapshot",
    "trade_session_reaper_schedule",
];
const ASSET_TABLES: [&str; 4] = ["monster", "monster_pub", "inventory", "player_wallet"];

fn dave() -> Identity {
    Identity::from_byte_array([0xD4; 32])
}
/// A numbered extra player (first bytes 0x51 and up).
fn pn(n: u8) -> Identity {
    Identity::from_byte_array([0x50 + n; 32])
}
/// The module identity the reaper tests install.
fn scheduler() -> Identity {
    Identity::from_byte_array([0x5C; 32])
}
fn at(ms: i64) -> Timestamp {
    Timestamp::from_micros_since_unix_epoch(ms * 1000)
}
/// Every player's character id is the first byte of its identity.
fn entity_of(who: Identity) -> u64 {
    u64::from(who.to_byte_array()[0])
}
fn tier_of(monster_id: u64) -> u8 {
    (monster_id % 3) as u8
}
fn s2_mon(monster_id: u64, owner: Identity, party_slot: u8) -> Monster {
    bonded(monster_id, owner, party_slot, (monster_id % 5) as u8 + 1)
}
fn card(m: &Monster) -> MonsterCard {
    make_monster_card(
        m.monster_id,
        m.species_id,
        m.nickname.clone(),
        m.level,
        m.current_hp,
        m.stat_hp,
    )
}
/// A stored offer as a seeded session holds it (no cards).
fn s2_offer(monster_ids: &[u64], items: &[TradeItem], currency: u64) -> TradeSessionOffer {
    TradeSessionOffer {
        monster_ids: monster_ids.to_vec(),
        items: items.to_vec(),
        currency,
        cards: vec![],
    }
}
fn s2_item_row(id: u32) -> ItemRow {
    ItemRow {
        id,
        name: format!("item{id}"),
        description: String::new(),
        recruit_bonus: 0,
        train_stat: None,
        train_amount: 0,
        sell_price: 0,
        cure_status: None,
    }
}
/// An account mid-grace: deletion requested at `requested_at_ms`.
fn s2_deleting(who: Identity, requested_at_ms: i64) -> Account {
    crate::accounts::requested_deletion(
        crate::accounts::new_account_row(who, "s2-issuer".to_string(), 1),
        requested_at_ms,
    )
}
/// An empty Pending legacy offer; fill the asset columns with struct update.
fn s2_legacy(trade_id: u64, initiator: Identity, counterparty: Identity) -> TradeOffer {
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
/// A battle row with no listed monsters; fill the id lists with struct update.
fn s2_battle(player: Identity, opponent: Identity, outcome: game_core::BattleOutcome) -> Battle {
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
    Battle {
        battle_id: 900,
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
fn ongoing(player: Identity, opponent: Identity) -> Battle {
    s2_battle(player, opponent, game_core::BattleOutcome::Ongoing)
}
/// Order-independent byte image of a row set.
fn sorted_bytes<T: spacetimedb::Serialize>(rows: &[T]) -> Vec<Vec<u8>> {
    let mut out: Vec<Vec<u8>> = rows.iter().map(bytes).collect();
    out.sort();
    out
}

/// Every `monster` column but the owner — the oracle's own copy, independent of
/// the server's conversion.
fn s2_snapshot(m: Monster) -> MonsterSnapshot {
    MonsterSnapshot {
        monster_id: m.monster_id,
        species_id: m.species_id,
        nickname: m.nickname,
        level: m.level,
        xp: m.xp,
        iv_hp: m.iv_hp,
        iv_attack: m.iv_attack,
        iv_defense: m.iv_defense,
        iv_speed: m.iv_speed,
        iv_sp_attack: m.iv_sp_attack,
        iv_sp_defense: m.iv_sp_defense,
        nature_kind: m.nature_kind,
        ev_hp: m.ev_hp,
        ev_attack: m.ev_attack,
        ev_defense: m.ev_defense,
        ev_speed: m.ev_speed,
        ev_sp_attack: m.ev_sp_attack,
        ev_sp_defense: m.ev_sp_defense,
        stat_hp: m.stat_hp,
        stat_attack: m.stat_attack,
        stat_defense: m.stat_defense,
        stat_speed: m.stat_speed,
        stat_sp_attack: m.stat_sp_attack,
        stat_sp_defense: m.stat_sp_defense,
        current_hp: m.current_hp,
        party_slot: m.party_slot,
        last_care_at_ms: m.last_care_at_ms,
        essence_fire: m.essence_fire,
        essence_water: m.essence_water,
        essence_plant: m.essence_plant,
        essence_electric: m.essence_electric,
        essence_earth: m.essence_earth,
        essence_wind: m.essence_wind,
        essence_light: m.essence_light,
        essence_dark: m.essence_dark,
        trust_favorable_count: m.trust_favorable_count,
        trust_unfavorable_count: m.trust_unfavorable_count,
        trust_favorable_battle_day_epoch: m.trust_favorable_battle_day_epoch,
        quality_time_ticks_total: m.quality_time_ticks_total,
        quality_time_accum_ms: m.quality_time_accum_ms,
        quality_time_window_ms: m.quality_time_window_ms,
        quality_time_window_start_ms: m.quality_time_window_start_ms,
        last_essence_train_at_ms: m.last_essence_train_at_ms,
    }
}

/// The snapshot row the server stores for `m` in `session_id`: masked by the
/// game-core rule, `snapshot_id` 0 (compared with the stored id zeroed).
fn s2_snap_row(session_id: u64, m: &Monster) -> TradeSessionSnapshot {
    let s = s2_snapshot(m.clone()).masked();
    TradeSessionSnapshot {
        snapshot_id: 0,
        session_id,
        monster_id: s.monster_id,
        species_id: s.species_id,
        nickname: s.nickname,
        level: s.level,
        xp: s.xp,
        iv_hp: s.iv_hp,
        iv_attack: s.iv_attack,
        iv_defense: s.iv_defense,
        iv_speed: s.iv_speed,
        iv_sp_attack: s.iv_sp_attack,
        iv_sp_defense: s.iv_sp_defense,
        nature_kind: s.nature_kind,
        ev_hp: s.ev_hp,
        ev_attack: s.ev_attack,
        ev_defense: s.ev_defense,
        ev_speed: s.ev_speed,
        ev_sp_attack: s.ev_sp_attack,
        ev_sp_defense: s.ev_sp_defense,
        stat_hp: s.stat_hp,
        stat_attack: s.stat_attack,
        stat_defense: s.stat_defense,
        stat_speed: s.stat_speed,
        stat_sp_attack: s.stat_sp_attack,
        stat_sp_defense: s.stat_sp_defense,
        current_hp: s.current_hp,
        party_slot: s.party_slot,
        last_care_at_ms: s.last_care_at_ms,
        essence_fire: s.essence_fire,
        essence_water: s.essence_water,
        essence_plant: s.essence_plant,
        essence_electric: s.essence_electric,
        essence_earth: s.essence_earth,
        essence_wind: s.essence_wind,
        essence_light: s.essence_light,
        essence_dark: s.essence_dark,
        trust_favorable_count: s.trust_favorable_count,
        trust_unfavorable_count: s.trust_unfavorable_count,
        trust_favorable_battle_day_epoch: s.trust_favorable_battle_day_epoch,
        quality_time_ticks_total: s.quality_time_ticks_total,
        quality_time_accum_ms: s.quality_time_accum_ms,
        quality_time_window_ms: s.quality_time_window_ms,
        quality_time_window_start_ms: s.quality_time_window_start_ms,
        last_essence_train_at_ms: s.last_essence_train_at_ms,
    }
}

/// The expected snapshot rows of `session_id`, one per monster, keyed and
/// sorted by monster id (the shape `S2World::snaps` returns).
fn s2_want_snaps(session_id: u64, ms: &[&Monster]) -> Vec<(u64, Vec<u8>)> {
    let mut out: Vec<(u64, Vec<u8>)> = ms
        .iter()
        .map(|m| (m.monster_id, bytes(&s2_snap_row(session_id, m))))
        .collect();
    out.sort();
    out
}

/// One side's request to `set_trade_offer`.
struct Off {
    mons: Vec<u64>,
    items: Vec<TradeItem>,
    cur: u64,
}
fn off(mons: &[u64], items: &[TradeItem], cur: u64) -> Off {
    Off {
        mons: mons.to_vec(),
        items: items.to_vec(),
        cur,
    }
}

/// Every table the session reducers touch, registered under each index they read.
struct S2World<'a> {
    players: Handle<'a, Player>,
    chars: Handle<'a, Character, u64>,
    accounts: Handle<'a, Account>,
    items: Handle<'a, ItemRow, u32>,
    offers: Handle<'a, TradeOffer>,
    battles: Handle<'a, Battle>,
    sessions: Handle<'a, TradeSession, u64>,
    snaps: Handle<'a, TradeSessionSnapshot, u64>,
    snaps_by_monster: Handle<'a, TradeSessionSnapshot, u64>,
    scheds: Handle<'a, super::TradeSessionReaperSchedule, u64>,
    monsters: Handle<'a, Monster, u64>,
    pubs: Handle<'a, MonsterPub, u64>,
    stacks: Handle<'a, Inventory>,
    stacks_by_id: Handle<'a, Inventory, u64>,
    wallets: Handle<'a, PlayerWallet>,
}

/// The registrations plus items 5, 6 and 7; no player, monster or asset.
fn s2_base(fx: &Fixture) -> S2World<'_> {
    let sessions = fx
        .table_keyed::<TradeSession, u64>("trade_session", "session_id", |r| r.session_id)
        .writable()
        .unique()
        .auto_inc(|r| r.session_id, |r, id| r.session_id = id);
    let _ = fx.table::<TradeSession>("trade_session", "opener", |r| r.opener);
    let _ = fx.table::<TradeSession>("trade_session", "partner", |r| r.partner);
    let snaps = fx
        .table_keyed::<TradeSessionSnapshot, u64>("trade_session_snapshot", "snapshot_id", |r| {
            r.snapshot_id
        })
        .writable()
        .unique()
        .auto_inc(|r| r.snapshot_id, |r, id| r.snapshot_id = id);
    let _ =
        fx.table_keyed::<TradeSessionSnapshot, u64>("trade_session_snapshot", "session_id", |r| {
            r.session_id
        });
    let snaps_by_monster =
        fx.table_keyed::<TradeSessionSnapshot, u64>("trade_session_snapshot", "monster_id", |r| {
            r.monster_id
        });
    let scheds = fx
        .table_keyed::<super::TradeSessionReaperSchedule, u64>(
            "trade_session_reaper_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        )
        .writable()
        .unique()
        .auto_inc(|r| r.scheduled_id, |r, id| r.scheduled_id = id);
    let _ = fx.table_keyed::<super::TradeSessionReaperSchedule, u64>(
        "trade_session_reaper_schedule",
        "session_id",
        |r| r.session_id,
    );
    let monsters = fx
        .table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id)
        .writable()
        .unique();
    let _ = fx.table::<Monster>("monster", "owner_identity", |r| r.owner_identity);
    let pubs = fx
        .table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id)
        .writable()
        .unique();
    let stacks = fx
        .table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity)
        .writable()
        .auto_inc(|r| r.inv_id, |r, id| r.inv_id = id);
    let stacks_by_id = fx
        .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
        .unique();
    let wallets = fx
        .table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity)
        .writable()
        .unique();
    let battles = fx.table::<Battle>("battle", "player_identity", |r| r.player_identity);
    let _ = fx.table::<Battle>("battle", "opponent_identity", |r| r.opponent_identity);
    let offers = fx.table::<TradeOffer>("trade_offer", "initiator", |r| r.initiator);
    let _ = fx.table::<TradeOffer>("trade_offer", "counterparty", |r| r.counterparty);
    let w = S2World {
        players: fx.table::<Player>("player", "identity", |r| r.identity),
        chars: fx.table_keyed::<Character, u64>("character", "entity_id", |r| r.entity_id),
        accounts: fx.table::<Account>("account", "identity", |r| r.identity),
        items: fx.table_keyed::<ItemRow, u32>("item_row", "id", |r| r.id),
        offers,
        battles,
        sessions,
        snaps,
        snaps_by_monster,
        scheds,
        monsters,
        pubs,
        stacks,
        stacks_by_id,
        wallets,
    };
    for id in [5, 6, 7] {
        w.items.seed(&s2_item_row(id));
    }
    w
}

/// The standard world described in the banner.
fn s2_std(fx: &Fixture) -> S2World<'_> {
    let w = s2_base(fx);
    w.join(alice());
    w.join(bob());
    w.mon(11, alice(), 0);
    w.mon(12, alice(), 1);
    w.mon(21, bob(), 0);
    w.mon(22, bob(), 1);
    w.set_stack(alice(), 5, 10);
    w.set_stack(bob(), 6, 10);
    w.set_wallet(alice(), 500);
    w.set_wallet(bob(), 300);
    w
}

impl S2World<'_> {
    fn player_only(&self, who: Identity) {
        self.players.seed(&Player {
            identity: who,
            entity_id: entity_of(who),
            name: String::new(),
            online: true,
            last_input_seq: 0,
        });
    }
    fn place(&self, who: Identity, zone_id: u32, tile_x: i32, tile_y: i32) {
        self.chars.seed(&Character {
            entity_id: entity_of(who),
            zone_id,
            tile_x,
            tile_y,
            facing: Direction::South,
            action: ActionState::Idle,
            move_started_at_ms: 0,
            sprite_id: 0,
            move_queue: vec![],
        });
    }
    fn move_to(&self, who: Identity, zone_id: u32, tile_x: i32, tile_y: i32) {
        assert_eq!(
            self.chars.remove(entity_of(who)),
            1,
            "move_to: no character"
        );
        self.place(who, zone_id, tile_x, tile_y);
    }
    fn join_at(&self, who: Identity, zone_id: u32, tile_x: i32, tile_y: i32) {
        self.player_only(who);
        self.place(who, zone_id, tile_x, tile_y);
    }
    /// Joined, on the shared tile (zone 1, 10, 10).
    fn join(&self, who: Identity) {
        self.join_at(who, 1, 10, 10);
    }
    /// Seed `m` and its `monster_pub` projection.
    fn put(&self, m: &Monster) {
        self.monsters.seed(m);
        self.pubs
            .seed(&crate::marshal::pub_from_monster(m, tier_of(m.monster_id)));
    }
    fn mon(&self, monster_id: u64, owner: Identity, party_slot: u8) {
        self.put(&s2_mon(monster_id, owner, party_slot));
    }
    /// Overwrite the private row of an existing monster directly (no write
    /// syscall, so no hook runs): the "live row changed under the session" shape.
    fn replace(&self, m: &Monster) {
        let id = m.monster_id;
        assert_eq!(
            self.monsters.remove(id),
            1,
            "replace: monster {id} had no row"
        );
        self.monsters.seed(m);
    }
    fn monster(&self, id: u64) -> Monster {
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
    /// Set `owner`'s stack of `item_id` to `count` (0 = no row). Seeded stack
    /// ids start at 1000 so the modelled auto-inc never collides.
    fn set_stack(&self, owner: Identity, item_id: u32, count: u32) {
        let inv_id = 1000 + u64::from(owner.to_byte_array()[0]) * 100 + u64::from(item_id);
        self.stacks_by_id.remove(inv_id);
        if count > 0 {
            self.stacks.seed(&Inventory {
                inv_id,
                owner_identity: owner,
                item_id,
                count,
            });
        }
    }
    fn set_wallet(&self, owner: Identity, balance: u64) {
        self.wallets.remove(owner);
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
    /// Seed a session row directly (ids from 700 up, clear of the modelled
    /// auto-inc), revision 3, opened at `T0`; no snapshot or schedule row.
    fn seed_session(
        &self,
        session_id: u64,
        opener: Identity,
        partner: Identity,
        opener_offer: TradeSessionOffer,
        partner_offer: TradeSessionOffer,
        confirmed: (bool, bool),
    ) {
        self.sessions.seed(&TradeSession {
            session_id,
            opener,
            partner,
            opener_offer,
            partner_offer,
            opener_confirmed: confirmed.0,
            partner_confirmed: confirmed.1,
            revision: 3,
            created_at_ms: T0,
        });
    }
    fn sid(&self, opener: Identity, partner: Identity) -> u64 {
        self.sessions
            .rows()
            .into_iter()
            .find(|s| s.opener == opener && s.partner == partner)
            .map(|s| s.session_id)
            .unwrap_or_else(|| panic!("no session {opener} -> {partner}"))
    }
    fn session_opt(&self, sid: u64) -> Option<TradeSession> {
        self.sessions
            .rows()
            .into_iter()
            .find(|s| s.session_id == sid)
    }
    fn session(&self, sid: u64) -> TradeSession {
        self.session_opt(sid)
            .unwrap_or_else(|| panic!("session {sid}: no row"))
    }
    /// The session rows `who` takes part in (either role), by session id —
    /// what `my_trade_session` serves to `who`.
    fn rows_of(&self, who: Identity) -> Vec<TradeSession> {
        let mut rows: Vec<TradeSession> = self
            .sessions
            .rows()
            .into_iter()
            .filter(|s| s.opener == who || s.partner == who)
            .collect();
        rows.sort_by_key(|s| s.session_id);
        rows
    }
    /// The snapshot rows of `sid` with `snapshot_id` zeroed, by monster id.
    fn snaps(&self, sid: u64) -> Vec<(u64, Vec<u8>)> {
        let mut out: Vec<(u64, Vec<u8>)> = self
            .snaps
            .rows()
            .into_iter()
            .filter(|s| s.session_id == sid)
            .map(|mut s| {
                s.snapshot_id = 0;
                (s.monster_id, bytes(&s))
            })
            .collect();
        out.sort();
        out
    }
    /// The snapshot rows of `sid` exactly as stored (ids included).
    fn raw_snaps(&self, sid: u64) -> Vec<Vec<u8>> {
        let rows: Vec<TradeSessionSnapshot> = self
            .snaps
            .rows()
            .into_iter()
            .filter(|s| s.session_id == sid)
            .collect();
        sorted_bytes(&rows)
    }
    fn raw_snap(&self, sid: u64, monster_id: u64) -> Vec<u8> {
        let row = self
            .snaps
            .rows()
            .into_iter()
            .find(|s| s.session_id == sid && s.monster_id == monster_id)
            .unwrap_or_else(|| panic!("session {sid}: no snapshot row for monster {monster_id}"));
        bytes(&row)
    }
    fn scheds_of(&self, sid: u64) -> Vec<Vec<u8>> {
        let rows: Vec<super::TradeSessionReaperSchedule> = self
            .scheds
            .rows()
            .into_iter()
            .filter(|s| s.session_id == sid)
            .collect();
        sorted_bytes(&rows)
    }
    /// The schedule row armed for `sid` (the row the scheduler would fire).
    fn fired(&self, sid: u64) -> super::TradeSessionReaperSchedule {
        self.scheds
            .rows()
            .into_iter()
            .find(|s| s.session_id == sid)
            .unwrap_or_else(|| panic!("session {sid}: no schedule row"))
    }
    /// Session row, snapshot rows and schedule rows of `sid`, as stored.
    fn footprint(&self, sid: u64) -> Vec<Vec<u8>> {
        let mut out: Vec<Vec<u8>> = self.session_opt(sid).iter().map(bytes).collect();
        out.extend(self.raw_snaps(sid));
        out.extend(self.scheds_of(sid));
        out
    }
    fn session_tables(&self) -> Vec<Vec<Vec<u8>>> {
        vec![
            sorted_bytes(&self.sessions.rows()),
            sorted_bytes(&self.snaps.rows()),
            sorted_bytes(&self.scheds.rows()),
        ]
    }
    fn assets(&self) -> Vec<Vec<Vec<u8>>> {
        vec![
            sorted_bytes(&self.monsters.rows()),
            sorted_bytes(&self.pubs.rows()),
            sorted_bytes(&self.stacks.rows()),
            sorted_bytes(&self.wallets.rows()),
        ]
    }
}

fn s2_open(fx: &Fixture, who: Identity, partner: Identity) -> Result<(), String> {
    fx.run_as_at(who, at(T0), |ctx| super::open_trade_session(ctx, partner))
}
fn s2_set(
    fx: &Fixture,
    who: Identity,
    sid: u64,
    mons: &[u64],
    items: &[TradeItem],
    cur: u64,
) -> Result<(), String> {
    let (mons, items) = (mons.to_vec(), items.to_vec());
    fx.run_as_at(who, at(T0), move |ctx| {
        super::set_trade_offer(ctx, sid, mons, items, cur)
    })
}
fn s2_set_off(fx: &Fixture, who: Identity, sid: u64, o: &Off) -> Result<(), String> {
    s2_set(fx, who, sid, &o.mons, &o.items, o.cur)
}
fn s2_confirm(fx: &Fixture, who: Identity, sid: u64, revision: u64) -> Result<(), String> {
    fx.run_as_at(who, at(T0), |ctx| {
        super::confirm_trade_session(ctx, sid, revision)
    })
}
/// Confirm the revision the session holds right now.
fn s2_confirm_now(fx: &Fixture, w: &S2World<'_>, who: Identity, sid: u64) -> Result<(), String> {
    let revision = w.session(sid).revision;
    s2_confirm(fx, who, sid, revision)
}
fn s2_cancel(fx: &Fixture, who: Identity, sid: u64) -> Result<(), String> {
    fx.run_as_at(who, at(T0), |ctx| super::cancel_trade_session(ctx, sid))
}
fn s2_reap(
    fx: &Fixture,
    who: Identity,
    now_ms: i64,
    args: super::TradeSessionReaperSchedule,
) -> Result<(), String> {
    fx.run_as_at(who, at(now_ms), move |ctx| {
        super::trade_session_reaper(ctx, args)
    })
}

/// Open `opener -> partner` through the reducer, then set the partner's offer
/// and the opener's offer (in that order); returns the session id.
fn s2_session(
    fx: &Fixture,
    w: &S2World<'_>,
    opener: Identity,
    partner: Identity,
    opener_offer: &Off,
    partner_offer: &Off,
) -> u64 {
    assert_eq!(
        s2_open(fx, opener, partner),
        Ok(()),
        "setup: open {opener} -> {partner} (indexes asked: {:?})",
        fx.requested_indexes()
    );
    let sid = w.sid(opener, partner);
    assert_eq!(
        s2_set_off(fx, partner, sid, partner_offer),
        Ok(()),
        "setup: {partner} sets its offer"
    );
    assert_eq!(
        s2_set_off(fx, opener, sid, opener_offer),
        Ok(()),
        "setup: {opener} sets its offer"
    );
    sid
}

/// The tables among `tables` that saw a write syscall since the last reset.
fn s2_writes(fx: &Fixture, tables: &[&'static str]) -> Vec<(&'static str, u32)> {
    tables
        .iter()
        .map(|t| (*t, fx.writes_to(t)))
        .filter(|(_, n)| *n > 0)
        .collect()
}

/// `call` returns exactly `Err(want)` and writes nothing: no write syscall on a
/// session or asset table and every such row byte-identical afterwards.
fn s2_refused(
    fx: &Fixture,
    w: &S2World<'_>,
    label: &str,
    want: &str,
    call: impl FnOnce() -> Result<(), String>,
) {
    let before = (w.session_tables(), w.assets());
    fx.reset_writes();
    let got = call();
    assert_eq!(got, Err(want.to_string()), "{label}");
    let mut tables = SESSION_TABLES.to_vec();
    tables.extend(ASSET_TABLES);
    let wrote = s2_writes(fx, &tables);
    assert!(wrote.is_empty(), "{label}: a refused call wrote {wrote:?}");
    assert!(
        (w.session_tables(), w.assets()) == before,
        "{label}: a refused call changed rows"
    );
}

/// The completing confirm `call` (made by the PARTNER while only the OPENER had
/// confirmed) hit a failure on the opener's side: it returns `Ok(())`, the
/// opener's flag is cleared and the partner's set, every other column of the
/// session row is unchanged (revision, offers, cards), its snapshot and
/// schedule rows are untouched and no asset row is written.
fn s2_assert_reset_other(
    fx: &Fixture,
    w: &S2World<'_>,
    label: &str,
    sid: u64,
    call: impl FnOnce() -> Result<(), String>,
) {
    let before = w.session(sid);
    assert_eq!(
        (before.opener_confirmed, before.partner_confirmed),
        (true, false),
        "{label}: setup: only the opener has confirmed"
    );
    let (assets, snaps, scheds) = (w.assets(), w.raw_snaps(sid), w.scheds_of(sid));
    fx.reset_writes();
    let got = call();
    assert_eq!(got, Ok(()), "{label}: the other side's failure answers Ok");
    let want = TradeSession {
        opener_confirmed: false,
        partner_confirmed: true,
        ..before
    };
    assert_eq!(
        w.session_opt(sid).map(|s| bytes(&s)),
        Some(bytes(&want)),
        "{label}: the other side's flag is cleared, the caller's set, revision and offers unchanged"
    );
    assert!(w.assets() == assets, "{label}: nothing moved");
    let wrote = s2_writes(fx, &ASSET_TABLES);
    assert!(wrote.is_empty(), "{label}: asset tables written: {wrote:?}");
    assert!(
        w.raw_snaps(sid) == snaps && w.scheds_of(sid) == scheds,
        "{label}: snapshot and schedule rows untouched"
    );
}

// ---------------------------------------------------------------------------
// ts-2.1 — open_trade_session
// ---------------------------------------------------------------------------

/// An accepted open inserts exactly one blank row — both offers empty, both
/// flags false, revision 0, `created_at_ms` the call's clock floored to the ms —
/// and arms exactly one reaper row for it at that stamp + `TRADE_SESSION_TTL_MS`;
/// no snapshot row and no asset row is written.
#[test]
fn ts2_open_inserts_a_blank_session_and_arms_one_reaper() {
    let fx = fixture();
    let w = s2_std(&fx);
    let assets = w.assets();
    let stamp = Timestamp::from_micros_since_unix_epoch(T0 * 1000 + 999);
    fx.reset_writes();
    let got = fx.run_as_at(alice(), stamp, |ctx| super::open_trade_session(ctx, bob()));
    assert_eq!(got, Ok(()), "indexes asked: {:?}", fx.requested_indexes());

    let rows = w.sessions.rows();
    assert_eq!(rows.len(), 1, "exactly one session row");
    let s = &rows[0];
    let want = TradeSession {
        session_id: s.session_id,
        opener: alice(),
        partner: bob(),
        opener_offer: TradeSessionOffer::default(),
        partner_offer: TradeSessionOffer::default(),
        opener_confirmed: false,
        partner_confirmed: false,
        revision: 0,
        created_at_ms: T0,
    };
    assert_eq!(
        bytes(s),
        bytes(&want),
        "a blank row stamped with the ms-floored clock"
    );
    let scheds = w.scheds.rows();
    assert_eq!(scheds.len(), 1, "exactly one reaper row");
    assert_eq!(scheds[0].session_id, s.session_id, "armed for this session");
    assert_eq!(
        scheds[0].scheduled_at,
        ScheduleAt::Time(at(T0 + TRADE_SESSION_TTL_MS)),
        "the reaper fires at the ms-floored stamp + TTL"
    );
    assert!(w.snaps.rows().is_empty(), "a blank session has no snapshot");
    assert!(w.assets() == assets, "opening moves no asset");
    let wrote = s2_writes(&fx, &ASSET_TABLES);
    assert!(wrote.is_empty(), "asset tables written: {wrote:?}");

    // A clock that is not a whole second: the stamp keeps its exact ms.
    w.join(carol());
    let odd_ms = T0 + 7;
    let odd = Timestamp::from_micros_since_unix_epoch(odd_ms * 1000 + 500);
    let got = fx.run_as_at(alice(), odd, |ctx| super::open_trade_session(ctx, carol()));
    assert_eq!(got, Ok(()), "the second open");
    let second = w.session(w.sid(alice(), carol()));
    assert_eq!(
        second.created_at_ms, odd_ms,
        "created_at_ms is the call's exact ms, not a rounded second"
    );
    let armed: Vec<ScheduleAt> = w
        .scheds
        .rows()
        .into_iter()
        .filter(|r| r.session_id == second.session_id)
        .map(|r| r.scheduled_at)
        .collect();
    assert_eq!(
        armed,
        vec![ScheduleAt::Time(at(odd_ms + TRADE_SESSION_TTL_MS))],
        "one reaper row at that exact ms + TTL"
    );
}

/// A caller with no `player` row gets "not joined" — before the deletion gate
/// (an unjoined caller with a deletion request) and before any partner read.
#[test]
fn ts2_open_refuses_an_unjoined_caller_first() {
    let fx = fixture();
    let w = s2_std(&fx);
    w.accounts.seed(&s2_deleting(carol(), T0 - 1));
    s2_refused(&fx, &w, "unjoined caller", "not joined", || {
        s2_open(&fx, carol(), bob())
    });
    s2_refused(
        &fx,
        &w,
        "unjoined caller, unjoined partner",
        super::ERR_NOT_JOINED,
        || s2_open(&fx, carol(), dave()),
    );
    assert_eq!(super::ERR_NOT_JOINED, "not joined");
}

/// A deletion-gated caller is refused with the gate text before the partner is
/// read: a far partner, an unjoined partner and the caller itself all get the
/// gate text; with the request gone the far partner gets the range text (the
/// gate decided above). A deleting PARTNER never gates the caller.
#[test]
fn ts2_open_refuses_a_deletion_gated_caller_before_reading_the_partner() {
    let fx = fixture();
    let w = s2_base(&fx);
    w.join(alice());
    w.join_at(bob(), 2, 10, 10);
    w.accounts.seed(&s2_deleting(alice(), T0 - 1));
    let gated = crate::guards::REJECT_DELETION_GATED;
    s2_refused(&fx, &w, "gated caller, far partner", gated, || {
        s2_open(&fx, alice(), bob())
    });
    s2_refused(&fx, &w, "gated caller, unjoined partner", gated, || {
        s2_open(&fx, alice(), dave())
    });
    s2_refused(&fx, &w, "gated caller, self", gated, || {
        s2_open(&fx, alice(), alice())
    });

    assert_eq!(w.accounts.remove(alice()), 1);
    s2_refused(
        &fx,
        &w,
        "ungated caller, far partner",
        super::ERR_OUT_OF_RANGE,
        || s2_open(&fx, alice(), bob()),
    );

    w.accounts.seed(&s2_deleting(bob(), T0 - 1));
    w.move_to(bob(), 1, 10, 10);
    assert_eq!(
        s2_open(&fx, alice(), bob()),
        Ok(()),
        "the partner's deletion state is never read"
    );
}

/// A partner with no `player` row gets "that player is not a joined player",
/// whether it has a stray character row or nothing at all.
#[test]
fn ts2_open_refuses_an_unjoined_partner_before_the_range_check() {
    let fx = fixture();
    let w = s2_base(&fx);
    w.join(alice());
    w.place(dave(), 9, 500, 500);
    s2_refused(
        &fx,
        &w,
        "partner with a character but no player row",
        "that player is not a joined player",
        || s2_open(&fx, alice(), dave()),
    );
    s2_refused(
        &fx,
        &w,
        "partner with no rows at all",
        super::ERR_PARTNER_NOT_JOINED,
        || s2_open(&fx, alice(), carol()),
    );
    assert_eq!(
        super::ERR_PARTNER_NOT_JOINED,
        "that player is not a joined player"
    );
}

/// Both players joined; each character placed where given (`None` = no
/// character row). Returns the open's result; an accepted open inserted one
/// session, a refused one wrote nothing.
fn s2_open_at(
    alice_at: Option<(u32, i32, i32)>,
    bob_at: Option<(u32, i32, i32)>,
) -> Result<(), String> {
    let fx = fixture();
    let w = s2_base(&fx);
    for (who, place) in [(alice(), alice_at), (bob(), bob_at)] {
        w.player_only(who);
        if let Some((zone_id, x, y)) = place {
            w.place(who, zone_id, x, y);
        }
    }
    fx.reset_writes();
    let got = s2_open(&fx, alice(), bob());
    let sessions = w.sessions.rows().len();
    if got.is_ok() {
        assert_eq!(sessions, 1, "an accepted open inserts one session");
    } else {
        assert_eq!(sessions, 0, "a refused open inserts nothing");
        let wrote = s2_writes(&fx, &SESSION_TABLES);
        assert!(wrote.is_empty(), "a refused open wrote {wrote:?}");
    }
    got
}

/// ONE string for every range failure: another zone, Manhattan distance 3 in
/// three shapes, the partner's character missing, the caller's character
/// missing. Distance 2 (straight and diagonal) and the same tile are accepted.
#[test]
fn ts2_open_out_of_range_is_one_string_for_zone_distance_and_missing_characters() {
    let out = Err("that player is not close enough to trade".to_string());
    let here = Some((1, 10, 10));
    for (label, bob_at) in [
        ("another zone, same coordinates", Some((2, 10, 10))),
        ("3 east", Some((1, 13, 10))),
        ("2 east 1 south", Some((1, 12, 11))),
        ("3 north", Some((1, 10, 7))),
        ("partner has no character", None),
    ] {
        assert_eq!(s2_open_at(here, bob_at), out, "{label}");
    }
    assert_eq!(s2_open_at(None, here), out, "caller has no character");
    for (label, bob_at) in [
        ("2 east", (1, 12, 10)),
        ("1 east 1 south", (1, 11, 11)),
        ("2 north", (1, 10, 8)),
        ("same tile", (1, 10, 10)),
    ] {
        assert_eq!(s2_open_at(here, Some(bob_at)), Ok(()), "{label}: in reach");
    }
    assert_eq!(
        super::ERR_OUT_OF_RANGE,
        "that player is not close enough to trade"
    );
}

/// Opening with oneself is `SelfTrade`.
#[test]
fn ts2_open_refuses_self_trade() {
    let fx = fixture();
    let w = s2_std(&fx);
    s2_refused(
        &fx,
        &w,
        "self trade",
        &TradeSessionError::SelfTrade.to_string(),
        || s2_open(&fx, alice(), alice()),
    );
    assert_eq!(
        s2_open(&fx, alice(), bob()),
        Ok(()),
        "control: another player"
    );
}

/// One session per pair: a second open by the opener and a reverse open by the
/// partner are both `PairHasOpenSession`.
#[test]
fn ts2_open_refuses_a_second_session_for_the_pair_in_either_orientation() {
    let fx = fixture();
    let w = s2_std(&fx);
    assert_eq!(s2_open(&fx, alice(), bob()), Ok(()), "the first open");
    let pair = TradeSessionError::PairHasOpenSession.to_string();
    s2_refused(&fx, &w, "same orientation", &pair, || {
        s2_open(&fx, alice(), bob())
    });
    s2_refused(&fx, &w, "reverse orientation", &pair, || {
        s2_open(&fx, bob(), alice())
    });
}

/// The opener limit counts only sessions the caller OPENED: with four sessions
/// others opened with alice, she still opens four, and the fifth is
/// `OpenSessionLimit`.
#[test]
fn ts2_open_limit_counts_only_sessions_the_caller_opened() {
    let fx = fixture();
    let w = s2_base(&fx);
    w.join(alice());
    for n in 1..=9 {
        w.join(pn(n));
    }
    for (session_id, n) in [(701, 1), (702, 2), (703, 3), (704, 4)] {
        w.seed_session(
            session_id,
            pn(n),
            alice(),
            TradeSessionOffer::default(),
            TradeSessionOffer::default(),
            (false, false),
        );
    }
    for n in 5..=8 {
        assert_eq!(
            s2_open(&fx, alice(), pn(n)),
            Ok(()),
            "open {n}: sessions others opened with the caller never count"
        );
    }
    s2_refused(
        &fx,
        &w,
        "a fifth opened session",
        &TradeSessionError::OpenSessionLimit.to_string(),
        || s2_open(&fx, alice(), pn(9)),
    );
}

/// The range check runs before the pair and limit rules: an existing pair with
/// a far partner (both orientations) and a caller at the limit with a far
/// partner all get the range text; moved into reach, the limit is reported.
#[test]
fn ts2_open_range_is_checked_before_the_pair_and_limit_rules() {
    let fx = fixture();
    let w = s2_base(&fx);
    w.join(alice());
    w.join_at(bob(), 2, 10, 10);
    w.join_at(pn(5), 3, 0, 0);
    let empty = TradeSessionOffer::default;
    w.seed_session(700, alice(), bob(), empty(), empty(), (false, false));
    for (session_id, n) in [(701, 1), (702, 2), (703, 3)] {
        w.seed_session(session_id, alice(), pn(n), empty(), empty(), (false, false));
    }
    let out = super::ERR_OUT_OF_RANGE;
    s2_refused(&fx, &w, "pair exists, partner far", out, || {
        s2_open(&fx, alice(), bob())
    });
    s2_refused(&fx, &w, "pair exists (reverse), partner far", out, || {
        s2_open(&fx, bob(), alice())
    });
    s2_refused(&fx, &w, "at the limit, partner far", out, || {
        s2_open(&fx, alice(), pn(5))
    });
    w.move_to(pn(5), 1, 10, 10);
    s2_refused(
        &fx,
        &w,
        "at the limit, partner in reach",
        &TradeSessionError::OpenSessionLimit.to_string(),
        || s2_open(&fx, alice(), pn(5)),
    );
}

// ---------------------------------------------------------------------------
// ts-2.2 — no oracle on the partner's private state
// ---------------------------------------------------------------------------

/// One value of bob's private state. Every variant keeps bob's offered side
/// (monster 21) valid; they differ in nothing else.
#[derive(Clone, Copy, Debug)]
enum PartnerPrivate {
    Baseline,
    WalletZero,
    WalletAtCap,
    NoWalletRow,
    StacksAtCap,
    NoStacks,
    ExtraMonsters,
    DeletionRequested,
    OtherCommitments,
}

const PARTNER_PRIVATES: [PartnerPrivate; 9] = [
    PartnerPrivate::Baseline,
    PartnerPrivate::WalletZero,
    PartnerPrivate::WalletAtCap,
    PartnerPrivate::NoWalletRow,
    PartnerPrivate::StacksAtCap,
    PartnerPrivate::NoStacks,
    PartnerPrivate::ExtraMonsters,
    PartnerPrivate::DeletionRequested,
    PartnerPrivate::OtherCommitments,
];

/// Write `p` into bob's rows of a standard world.
fn s2_apply_private(w: &S2World<'_>, p: PartnerPrivate) {
    let b = bob();
    match p {
        PartnerPrivate::Baseline => {}
        PartnerPrivate::WalletZero => w.set_wallet(b, 0),
        PartnerPrivate::WalletAtCap => w.set_wallet(b, MAX_BALANCE),
        PartnerPrivate::NoWalletRow => {
            assert_eq!(w.wallets.remove(b), 1, "bob had a wallet row");
        }
        PartnerPrivate::StacksAtCap => {
            w.set_stack(b, 5, MAX_ITEM_STACK);
            w.set_stack(b, 6, MAX_ITEM_STACK);
            w.set_stack(b, 7, 3);
        }
        PartnerPrivate::NoStacks => {
            assert_eq!(w.stacks.remove(b), 1, "bob had one stack");
        }
        PartnerPrivate::ExtraMonsters => {
            w.mon(23, b, 2);
            w.put(&Monster {
                current_hp: 0,
                ..s2_mon(24, b, 3)
            });
            w.mon(25, b, crate::PARTY_SLOT_NONE);
            w.put(&Monster {
                current_hp: 0,
                ..s2_mon(26, b, crate::PARTY_SLOT_NONE)
            });
        }
        PartnerPrivate::DeletionRequested => w.accounts.seed(&s2_deleting(b, T0 - 1)),
        PartnerPrivate::OtherCommitments => {
            // bob opened four sessions, is the partner of a fifth whose bob side
            // is confirmed and locks all his coins and item 6, holds a legacy
            // offer, and fights an ongoing battle with his un-offered monster.
            let empty = TradeSessionOffer::default;
            for (session_id, n) in [(701, 1), (702, 2), (703, 3), (704, 4)] {
                w.seed_session(session_id, b, pn(n), empty(), empty(), (false, false));
            }
            w.seed_session(
                705,
                carol(),
                b,
                empty(),
                s2_offer(&[], &[item(6, 10)], 300),
                (false, true),
            );
            w.offers.seed(&TradeOffer {
                initiator_monster_ids: vec![22],
                initiator_currency: 5,
                ..s2_legacy(801, b, dave())
            });
            w.battles.seed(&Battle {
                party_monster_ids: vec![22],
                ..ongoing(b, crate::WILD_IDENTITY)
            });
        }
    }
}

/// Which reducer alice drives against bob.
#[derive(Clone, Copy, Debug)]
enum Probe {
    Open,
    Set,
    Confirm,
    Cancel,
}

/// alice's results (an accepted and a refused call per reducer) and the session
/// rows she can read afterwards.
type Outcome = (Vec<Result<(), String>>, Vec<TradeSession>);

/// Build the standard world, run the probe's setup with bob's baseline state,
/// write bob's private state `p`, then make alice's calls.
fn s2_probe(probe: Probe, p: PartnerPrivate) -> Outcome {
    let fx = fixture();
    let w = s2_std(&fx);
    w.join(carol());
    w.join(dave());
    let label = format!("{probe:?} under {p:?}");
    let opened = |alice_offers: bool| -> u64 {
        assert_eq!(s2_open(&fx, alice(), bob()), Ok(()), "{label}: setup open");
        let sid = w.sid(alice(), bob());
        assert_eq!(
            s2_set(&fx, bob(), sid, &[21], &[], 0),
            Ok(()),
            "{label}: setup: bob offers 21"
        );
        if alice_offers {
            assert_eq!(
                s2_set(&fx, alice(), sid, &[11], &[item(5, 3)], 50),
                Ok(()),
                "{label}: setup: alice offers"
            );
        }
        sid
    };
    let results = match probe {
        Probe::Open => {
            s2_apply_private(&w, p);
            vec![s2_open(&fx, alice(), bob()), s2_open(&fx, alice(), bob())]
        }
        Probe::Set => {
            let sid = opened(false);
            s2_apply_private(&w, p);
            vec![
                s2_set(&fx, alice(), sid, &[11], &[item(5, 3)], 50),
                s2_set(&fx, alice(), sid, &[21], &[], 0),
            ]
        }
        Probe::Confirm => {
            let sid = opened(true);
            s2_apply_private(&w, p);
            let revision = w.session(sid).revision;
            vec![
                s2_confirm(&fx, alice(), sid, revision + 1),
                s2_confirm(&fx, alice(), sid, revision),
            ]
        }
        Probe::Cancel => {
            let sid = opened(true);
            s2_apply_private(&w, p);
            vec![s2_cancel(&fx, alice(), 999), s2_cancel(&fx, alice(), sid)]
        }
    };
    (results, w.rows_of(alice()))
}

/// For each of open / set / confirm (one that does not complete the set) /
/// cancel, alice's results and every session row she can read are identical
/// across bob's wallet (zero, at the cap, no row), inventory (at the cap, none),
/// un-offered monsters (healthy, fainted, boxed), deletion request and other
/// commitments (four opened sessions, a confirmed side elsewhere, a legacy
/// offer, an ongoing battle). The baseline itself is the expected content, so
/// equality cannot hold vacuously.
#[test]
fn ts2_no_oracle_outcome_independent_of_partner_private_state() {
    for probe in [Probe::Open, Probe::Set, Probe::Confirm, Probe::Cancel] {
        let (results, rows) = s2_probe(probe, PartnerPrivate::Baseline);
        match probe {
            Probe::Open => {
                assert_eq!(
                    results,
                    vec![
                        Ok(()),
                        Err(TradeSessionError::PairHasOpenSession.to_string())
                    ],
                    "open baseline"
                );
                assert_eq!(rows.len(), 1, "open baseline: one session");
                let s = &rows[0];
                assert_eq!(
                    (s.opener, s.partner, s.revision, s.created_at_ms),
                    (alice(), bob(), 0, T0),
                    "open baseline: the blank row"
                );
                assert_eq!(
                    (s.opener_offer.clone(), s.partner_offer.clone()),
                    (TradeSessionOffer::default(), TradeSessionOffer::default()),
                    "open baseline: both offers blank"
                );
            }
            Probe::Set => {
                assert_eq!(
                    results,
                    vec![
                        Ok(()),
                        Err(TradeSessionError::MonsterNotOwned { monster_id: 21 }.to_string())
                    ],
                    "set baseline"
                );
                assert_eq!(rows.len(), 1, "set baseline: one session");
                assert_eq!(
                    rows[0].opener_offer,
                    TradeSessionOffer {
                        monster_ids: vec![11],
                        items: vec![item(5, 3)],
                        currency: 50,
                        cards: vec![card(&s2_mon(11, alice(), 0))],
                    },
                    "set baseline: alice's side"
                );
                assert_eq!(rows[0].partner_offer.monster_ids, vec![21]);
            }
            Probe::Confirm => {
                assert_eq!(
                    results,
                    vec![Err(TradeSessionError::StaleRevision.to_string()), Ok(())],
                    "confirm baseline"
                );
                assert_eq!(rows.len(), 1, "confirm baseline: one session");
                assert_eq!(
                    (rows[0].opener_confirmed, rows[0].partner_confirmed),
                    (true, false),
                    "confirm baseline: only alice's flag"
                );
            }
            Probe::Cancel => {
                assert_eq!(
                    results,
                    vec![Err(super::ERR_SESSION_NOT_FOUND.to_string()), Ok(())],
                    "cancel baseline"
                );
                assert!(rows.is_empty(), "cancel baseline: the session is gone");
            }
        }
        for p in PARTNER_PRIVATES {
            let (got, got_rows) = s2_probe(probe, p);
            assert_eq!(
                got, results,
                "{probe:?}: alice's results vary with bob's {p:?}"
            );
            assert_eq!(
                bytes(&got_rows),
                bytes(&rows),
                "{probe:?}: alice's session rows vary with bob's {p:?}"
            );
        }
    }
}

/// `set_trade_offer` naming id 77 answers byte-identically whether 77 is the
/// partner's party monster, the partner's boxed monster, a stranger's monster
/// or does not exist — and writes nothing in each case.
#[test]
fn ts2_foreign_and_missing_monster_same_error() {
    let probe = |label: &str, owner: Option<(Identity, u8)>| -> (Result<(), String>, Vec<u8>) {
        let fx = fixture();
        let w = s2_std(&fx);
        w.join(carol());
        if let Some((who, slot)) = owner {
            w.mon(77, who, slot);
        }
        let sid = s2_session(
            &fx,
            &w,
            alice(),
            bob(),
            &off(&[], &[], 0),
            &off(&[21], &[], 0),
        );
        let before = (w.session_tables(), w.assets());
        fx.reset_writes();
        let got = s2_set(&fx, alice(), sid, &[11, 77], &[], 0);
        let mut tables = SESSION_TABLES.to_vec();
        tables.extend(ASSET_TABLES);
        let wrote = s2_writes(&fx, &tables);
        assert!(wrote.is_empty(), "{label}: wrote {wrote:?}");
        assert!(
            (w.session_tables(), w.assets()) == before,
            "{label}: rows changed"
        );
        (got, bytes(&w.rows_of(alice())))
    };
    let missing = probe("no such monster", None);
    assert_eq!(
        missing.0,
        Err(TradeSessionError::MonsterNotOwned { monster_id: 77 }.to_string()),
        "a missing monster is not the caller's to offer"
    );
    for (label, owner) in [
        ("the partner's party monster", (bob(), 2)),
        (
            "the partner's boxed monster",
            (bob(), crate::PARTY_SLOT_NONE),
        ),
        ("a stranger's monster", (carol(), 0)),
    ] {
        let got = probe(label, Some(owner));
        assert_eq!(
            got.0, missing.0,
            "{label}: answer differs from a missing id"
        );
        assert_eq!(got.1, missing.1, "{label}: rows differ from a missing id");
    }
}

/// A session the caller is not party to and a session id that does not exist
/// get the same "trade session not found" from set, confirm and cancel, and
/// nothing is written.
#[test]
fn ts2_non_participant_same_as_missing() {
    let fx = fixture();
    let w = s2_std(&fx);
    w.join(carol());
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[11], &[], 0),
        &off(&[21], &[], 0),
    );
    assert_eq!(s2_confirm_now(&fx, &w, alice(), sid), Ok(()), "setup");
    let revision = w.session(sid).revision;
    let not_found = "trade session not found";
    for (who, id) in [(carol(), sid), (carol(), 999), (alice(), 999), (bob(), 999)] {
        let label = format!("{who} on session {id}");
        s2_refused(&fx, &w, &format!("set: {label}"), not_found, || {
            s2_set(&fx, who, id, &[], &[], 0)
        });
        s2_refused(&fx, &w, &format!("confirm: {label}"), not_found, || {
            s2_confirm(&fx, who, id, revision)
        });
        s2_refused(&fx, &w, &format!("cancel: {label}"), not_found, || {
            s2_cancel(&fx, who, id)
        });
    }
    assert_eq!(super::ERR_SESSION_NOT_FOUND, not_found);
}

// ---------------------------------------------------------------------------
// ts-2.3 — set_trade_offer
// ---------------------------------------------------------------------------

/// An accepted edit replaces only the caller's side: monster ids, items and
/// currency as sent, cards rebuilt from the live rows in OFFER order, the
/// caller's snapshot rows replaced by one masked row per offered monster, the
/// other side's offer and snapshot row untouched (same stored bytes); the
/// revision advances by one per accepted edit — an identical resubmission
/// included — and an empty edit is legal. No asset row changes.
#[test]
fn ts2_edit_replaces_only_the_callers_side_with_cards_and_masked_snapshots() {
    let fx = fixture();
    let w = s2_std(&fx);
    let assets = w.assets();
    assert_eq!(s2_open(&fx, alice(), bob()), Ok(()), "setup open");
    let sid = w.sid(alice(), bob());
    let (m11, m12, m21) = (w.monster(11), w.monster(12), w.monster(21));

    assert_eq!(s2_set(&fx, bob(), sid, &[21], &[item(6, 2)], 7), Ok(()));
    let after_bob = w.session(sid);
    assert_eq!(
        after_bob.revision, 1,
        "an accepted edit advances the revision"
    );
    assert_eq!(
        after_bob.partner_offer,
        TradeSessionOffer {
            monster_ids: vec![21],
            items: vec![item(6, 2)],
            currency: 7,
            cards: vec![card(&m21)],
        },
        "bob's side as sent, with its card"
    );
    assert_eq!(
        after_bob.opener_offer,
        TradeSessionOffer::default(),
        "alice's side untouched"
    );
    assert_eq!(
        w.snaps(sid),
        s2_want_snaps(sid, &[&m21]),
        "bob's masked snapshot"
    );
    let bob_snap = w.raw_snap(sid, 21);

    assert_eq!(
        s2_set(&fx, alice(), sid, &[12, 11], &[item(5, 3)], 40),
        Ok(())
    );
    let s = w.session(sid);
    assert_eq!(s.revision, 2);
    assert_eq!(
        s.opener_offer,
        TradeSessionOffer {
            monster_ids: vec![12, 11],
            items: vec![item(5, 3)],
            currency: 40,
            cards: vec![card(&m12), card(&m11)],
        },
        "cards follow the offer order, not the id order"
    );
    assert_eq!(
        s.partner_offer, after_bob.partner_offer,
        "bob's side untouched"
    );
    assert_eq!(
        w.snaps(sid),
        s2_want_snaps(sid, &[&m11, &m12, &m21]),
        "one masked row per offered monster"
    );
    assert_eq!(
        w.raw_snap(sid, 21),
        bob_snap,
        "bob's snapshot row is not rewritten"
    );

    assert_eq!(s2_set(&fx, alice(), sid, &[11], &[], 0), Ok(()));
    assert_eq!(w.session(sid).revision, 3);
    assert_eq!(
        w.snaps(sid),
        s2_want_snaps(sid, &[&m11, &m21]),
        "the dropped monster's snapshot row is gone"
    );
    assert_eq!(w.raw_snap(sid, 21), bob_snap);

    let offer_before = w.session(sid).opener_offer;
    assert_eq!(
        s2_set(&fx, alice(), sid, &[11], &[], 0),
        Ok(()),
        "a resubmission"
    );
    let s = w.session(sid);
    assert_eq!(s.revision, 4, "an identical resubmission still advances");
    assert_eq!(s.opener_offer, offer_before);

    assert_eq!(
        s2_set(&fx, alice(), sid, &[], &[], 0),
        Ok(()),
        "an empty edit"
    );
    let s = w.session(sid);
    assert_eq!(s.revision, 5);
    assert_eq!(
        s.opener_offer,
        TradeSessionOffer::default(),
        "alice's side cleared"
    );
    assert_eq!(s.partner_offer, after_bob.partner_offer);
    assert_eq!(
        w.snaps(sid),
        s2_want_snaps(sid, &[&m21]),
        "only bob's row is left"
    );
    assert!(w.assets() == assets, "editing moves no asset");
}

/// An accepted edit clears BOTH flags even though only the other side was
/// confirmed; a confirmed side's own edit is `SideConfirmed` and writes nothing.
#[test]
fn ts2_edit_clears_both_confirms_and_refuses_a_confirmed_caller() {
    let fx = fixture();
    let w = s2_std(&fx);
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[11], &[], 0),
        &off(&[21], &[], 0),
    );
    let side_confirmed = TradeSessionError::SideConfirmed.to_string();

    assert_eq!(
        s2_confirm_now(&fx, &w, alice(), sid),
        Ok(()),
        "alice confirms"
    );
    s2_refused(&fx, &w, "confirmed opener edits", &side_confirmed, || {
        s2_set(&fx, alice(), sid, &[12], &[], 0)
    });
    let revision = w.session(sid).revision;
    assert_eq!(s2_set(&fx, bob(), sid, &[22], &[], 0), Ok(()), "bob edits");
    let s = w.session(sid);
    assert_eq!(
        (s.opener_confirmed, s.partner_confirmed, s.revision),
        (false, false, revision + 1),
        "bob's edit clears alice's confirm"
    );

    assert_eq!(s2_confirm_now(&fx, &w, bob(), sid), Ok(()), "bob confirms");
    s2_refused(&fx, &w, "confirmed partner edits", &side_confirmed, || {
        s2_set(&fx, bob(), sid, &[21], &[], 0)
    });
    let revision = w.session(sid).revision;
    assert_eq!(
        s2_set(&fx, alice(), sid, &[12], &[], 0),
        Ok(()),
        "alice edits"
    );
    let s = w.session(sid);
    assert_eq!(
        (s.opener_confirmed, s.partner_confirmed, s.revision),
        (false, false, revision + 1),
        "alice's edit clears bob's confirm"
    );
}

/// A deletion-gated caller cannot edit — the gate fires before the size cap
/// and before the session lookup; a deleting partner never gates the caller.
#[test]
fn ts2_edit_refuses_a_deletion_gated_caller() {
    let fx = fixture();
    let w = s2_std(&fx);
    assert_eq!(s2_open(&fx, bob(), alice()), Ok(()), "bob opens with alice");
    let sid = w.sid(bob(), alice());
    w.accounts.seed(&s2_deleting(alice(), T0 - 1));
    let gated = crate::guards::REJECT_DELETION_GATED;
    let too_many: Vec<u64> = (1000..).take(MAX_TRADE_MONSTERS_PER_SIDE + 1).collect();
    s2_refused(&fx, &w, "gated caller edits", gated, || {
        s2_set(&fx, alice(), sid, &[11], &[], 0)
    });
    s2_refused(&fx, &w, "the gate precedes the size cap", gated, || {
        s2_set(&fx, alice(), sid, &too_many, &[], 0)
    });
    s2_refused(
        &fx,
        &w,
        "the gate precedes the session lookup",
        gated,
        || s2_set(&fx, alice(), 999, &[11], &[], 0),
    );
    assert_eq!(
        s2_set(&fx, bob(), sid, &[21], &[], 0),
        Ok(()),
        "a deleting partner never gates the caller"
    );
}

/// The seed of a case whose rows are the standard world's.
fn s2_no_seed(_: &S2World<'_>) {}

/// Standard world, alice -> bob session with bob offering 21; `seed` writes the
/// case's rows; alice's edit is refused with exactly `want` and writes nothing.
fn s2_edit_case(
    label: &str,
    seed: impl FnOnce(&S2World<'_>),
    mons: &[u64],
    items: &[TradeItem],
    cur: u64,
    want: &TradeSessionError,
) {
    let fx = fixture();
    let w = s2_std(&fx);
    assert_eq!(s2_open(&fx, alice(), bob()), Ok(()), "{label}: setup open");
    let sid = w.sid(alice(), bob());
    assert_eq!(
        s2_set(&fx, bob(), sid, &[21], &[], 0),
        Ok(()),
        "{label}: setup: bob offers"
    );
    seed(&w);
    s2_refused(&fx, &w, label, &want.to_string(), || {
        s2_set(&fx, alice(), sid, mons, items, cur)
    });
}

/// One refused edit per eligibility reason reachable from rows, each with its
/// own exact reason and no write: ownership (partner's, missing), party, HP,
/// exclusivity (another session in either role, a legacy offer in either role),
/// battle (player and opponent index), duplicates, zero quantity, unknown item,
/// both size caps (and their inclusive bound), holdings, and holdings net of
/// another CONFIRMED session or a legacy offer.
#[test]
fn ts2_edit_refuses_each_ineligible_offer() {
    use TradeSessionError as E;
    let none = s2_no_seed;
    let empty = TradeSessionOffer::default;
    s2_edit_case(
        "partner's monster",
        none,
        &[21],
        &[],
        0,
        &E::MonsterNotOwned { monster_id: 21 },
    );
    s2_edit_case(
        "missing monster",
        none,
        &[99],
        &[],
        0,
        &E::MonsterNotOwned { monster_id: 99 },
    );
    s2_edit_case(
        "boxed monster",
        |w| w.mon(13, alice(), crate::PARTY_SLOT_NONE),
        &[13],
        &[],
        0,
        &E::MonsterNotInParty { monster_id: 13 },
    );
    s2_edit_case(
        "fainted monster",
        |w| {
            w.put(&Monster {
                current_hp: 0,
                ..s2_mon(14, alice(), 2)
            })
        },
        &[14],
        &[],
        0,
        &E::MonsterFainted { monster_id: 14 },
    );
    s2_edit_case(
        "listed in another unconfirmed session as opener",
        |w| {
            w.seed_session(
                700,
                alice(),
                dave(),
                s2_offer(&[11], &[], 0),
                empty(),
                (false, false),
            )
        },
        &[11],
        &[],
        0,
        &E::MonsterInAnotherTrade { monster_id: 11 },
    );
    s2_edit_case(
        "listed in another unconfirmed session as partner",
        |w| {
            w.seed_session(
                700,
                dave(),
                alice(),
                empty(),
                s2_offer(&[11], &[], 0),
                (false, false),
            )
        },
        &[11],
        &[],
        0,
        &E::MonsterInAnotherTrade { monster_id: 11 },
    );
    s2_edit_case(
        "listed in a legacy offer as initiator",
        |w| {
            w.offers.seed(&TradeOffer {
                initiator_monster_ids: vec![11],
                ..s2_legacy(800, alice(), dave())
            })
        },
        &[11],
        &[],
        0,
        &E::MonsterInAnotherTrade { monster_id: 11 },
    );
    s2_edit_case(
        "listed in a legacy offer as counterparty",
        |w| {
            w.offers.seed(&TradeOffer {
                counterparty_monster_ids: vec![11],
                ..s2_legacy(800, dave(), alice())
            })
        },
        &[11],
        &[],
        0,
        &E::MonsterInAnotherTrade { monster_id: 11 },
    );
    s2_edit_case(
        "in an ongoing battle as player",
        |w| {
            w.battles.seed(&Battle {
                party_monster_ids: vec![11],
                ..ongoing(alice(), crate::WILD_IDENTITY)
            })
        },
        &[11],
        &[],
        0,
        &E::MonsterInBattle { monster_id: 11 },
    );
    s2_edit_case(
        "in an ongoing battle as opponent",
        |w| {
            w.battles.seed(&Battle {
                opponent_monster_ids: vec![11],
                ..ongoing(dave(), alice())
            })
        },
        &[11],
        &[],
        0,
        &E::MonsterInBattle { monster_id: 11 },
    );
    s2_edit_case(
        "duplicate monster",
        none,
        &[11, 11],
        &[],
        0,
        &E::DuplicateMonster { monster_id: 11 },
    );
    s2_edit_case(
        "duplicate item",
        none,
        &[],
        &[item(5, 1), item(5, 2)],
        0,
        &E::DuplicateItem { item_id: 5 },
    );
    s2_edit_case(
        "zero quantity",
        none,
        &[],
        &[item(5, 0)],
        0,
        &E::ZeroItemQuantity { item_id: 5 },
    );
    s2_edit_case(
        "unknown item",
        none,
        &[],
        &[item(42, 1)],
        0,
        &E::UnknownItem { item_id: 42 },
    );

    let ids_over: Vec<u64> = (1000..).take(MAX_TRADE_MONSTERS_PER_SIDE + 1).collect();
    let ids_at: Vec<u64> = (1000..).take(MAX_TRADE_MONSTERS_PER_SIDE).collect();
    let items_over: Vec<TradeItem> = (100..)
        .take(MAX_TRADE_ITEMS_PER_SIDE + 1)
        .map(|id| item(id, 1))
        .collect();
    let items_at: Vec<TradeItem> = (100..)
        .take(MAX_TRADE_ITEMS_PER_SIDE)
        .map(|id| item(id, 1))
        .collect();
    s2_edit_case(
        "one monster over the cap",
        none,
        &ids_over,
        &[],
        0,
        &E::TooManyMonsters,
    );
    s2_edit_case(
        "exactly at the monster cap",
        none,
        &ids_at,
        &[],
        0,
        &E::MonsterNotOwned { monster_id: 1000 },
    );
    s2_edit_case(
        "one item over the cap",
        none,
        &[],
        &items_over,
        0,
        &E::TooManyItems,
    );
    s2_edit_case(
        "exactly at the item cap",
        none,
        &[],
        &items_at,
        0,
        &E::UnknownItem { item_id: 100 },
    );

    s2_edit_case(
        "more items than held",
        none,
        &[],
        &[item(5, 11)],
        0,
        &E::InsufficientItems { item_id: 5 },
    );
    s2_edit_case(
        "an item never held",
        none,
        &[],
        &[item(7, 1)],
        0,
        &E::InsufficientItems { item_id: 7 },
    );
    s2_edit_case(
        "more coins than held",
        none,
        &[],
        &[],
        501,
        &E::InsufficientCurrency,
    );
    s2_edit_case(
        "items locked by another confirmed session (opener side)",
        |w| {
            w.seed_session(
                700,
                alice(),
                dave(),
                s2_offer(&[], &[item(5, 4)], 0),
                empty(),
                (true, false),
            )
        },
        &[],
        &[item(5, 7)],
        0,
        &E::InsufficientItems { item_id: 5 },
    );
    s2_edit_case(
        "items locked by another confirmed session (partner side)",
        |w| {
            w.seed_session(
                700,
                dave(),
                alice(),
                empty(),
                s2_offer(&[], &[item(5, 4)], 0),
                (false, true),
            )
        },
        &[],
        &[item(5, 7)],
        0,
        &E::InsufficientItems { item_id: 5 },
    );
    s2_edit_case(
        "coins locked by another confirmed session",
        |w| {
            w.seed_session(
                700,
                alice(),
                dave(),
                s2_offer(&[], &[], 200),
                empty(),
                (true, false),
            )
        },
        &[],
        &[],
        301,
        &E::InsufficientCurrency,
    );
    s2_edit_case(
        "items locked by a legacy offer",
        |w| {
            w.offers.seed(&TradeOffer {
                initiator_items: vec![item(5, 4)],
                ..s2_legacy(800, alice(), dave())
            })
        },
        &[],
        &[item(5, 7)],
        0,
        &E::InsufficientItems { item_id: 5 },
    );
    s2_edit_case(
        "coins locked by a legacy offer",
        |w| {
            w.offers.seed(&TradeOffer {
                initiator_currency: 200,
                ..s2_legacy(800, alice(), dave())
            })
        },
        &[],
        &[],
        301,
        &E::InsufficientCurrency,
    );
}

/// alice -> bob session; `seed` writes the case's rows; alice's edit of monster
/// 11 with `items` and `currency` is accepted and stored, revision + 1.
fn s2_edit_accepted(
    label: &str,
    seed: impl FnOnce(&S2World<'_>),
    items: &[TradeItem],
    currency: u64,
) {
    let fx = fixture();
    let w = s2_std(&fx);
    assert_eq!(s2_open(&fx, alice(), bob()), Ok(()), "{label}: setup open");
    let sid = w.sid(alice(), bob());
    seed(&w);
    let revision = w.session(sid).revision;
    assert_eq!(
        s2_set(&fx, alice(), sid, &[11], items, currency),
        Ok(()),
        "{label}"
    );
    let s = w.session(sid);
    assert_eq!(
        (s.opener_offer.items, s.opener_offer.currency, s.revision),
        (items.to_vec(), currency, revision + 1),
        "{label}: stored as sent"
    );
}

/// Holdings are netted only against the caller's OWN side of OTHER confirmed
/// sessions and legacy offers, exactly: an unconfirmed side locks nothing, the
/// other participant's confirmed side locks nothing of the caller's, a
/// confirmed side locks exactly its amounts (offering the rest is accepted),
/// and this session's own previous offer never counts against itself.
#[test]
fn ts2_edit_holdings_net_only_other_confirmed_commitments() {
    let empty = TradeSessionOffer::default;
    s2_edit_accepted(
        "an unconfirmed other session locks nothing",
        |w| {
            w.seed_session(
                700,
                alice(),
                dave(),
                s2_offer(&[], &[item(5, 4)], 200),
                empty(),
                (false, false),
            )
        },
        &[item(5, 10)],
        500,
    );
    s2_edit_accepted(
        "the other participant's confirmed side is not the caller's lock",
        |w| {
            w.seed_session(
                700,
                alice(),
                dave(),
                empty(),
                s2_offer(&[], &[item(5, 4)], 200),
                (false, true),
            )
        },
        &[item(5, 10)],
        500,
    );
    s2_edit_accepted(
        "a confirmed side (opener) locks exactly its amounts",
        |w| {
            w.seed_session(
                700,
                alice(),
                dave(),
                s2_offer(&[], &[item(5, 4)], 200),
                empty(),
                (true, false),
            )
        },
        &[item(5, 6)],
        300,
    );
    s2_edit_accepted(
        "a confirmed side (partner) locks exactly its amounts",
        |w| {
            w.seed_session(
                700,
                dave(),
                alice(),
                empty(),
                s2_offer(&[], &[item(5, 4)], 200),
                (false, true),
            )
        },
        &[item(5, 6)],
        300,
    );
    s2_edit_accepted(
        "a legacy offer as counterparty locks exactly its amounts",
        |w| {
            w.offers.seed(&TradeOffer {
                counterparty_items: vec![item(5, 4)],
                counterparty_currency: 200,
                ..s2_legacy(800, dave(), alice())
            })
        },
        &[item(5, 6)],
        300,
    );

    let fx = fixture();
    let w = s2_std(&fx);
    assert_eq!(s2_open(&fx, alice(), bob()), Ok(()), "setup open");
    let sid = w.sid(alice(), bob());
    for n in 1..=2 {
        assert_eq!(
            s2_set(&fx, alice(), sid, &[11], &[item(5, 10)], 500),
            Ok(()),
            "edit {n}: everything held; the stored offer never locks against itself"
        );
    }
}

// ---------------------------------------------------------------------------
// ts-2.4 — confirm_trade_session (a confirm that does not complete the set)
// ---------------------------------------------------------------------------

/// The first confirm, from either seat, sets only the caller's flag; offers,
/// cards, revision, snapshots and assets are untouched.
#[test]
fn ts2_confirm_first_confirm_sets_only_the_callers_flag() {
    for (first, opener_flag) in [(alice(), true), (bob(), false)] {
        let fx = fixture();
        let w = s2_std(&fx);
        let sid = s2_session(
            &fx,
            &w,
            alice(),
            bob(),
            &off(&[11], &[item(5, 2)], 0),
            &off(&[21], &[item(6, 1)], 0),
        );
        let before = w.session(sid);
        let (assets, snaps) = (w.assets(), w.raw_snaps(sid));
        fx.reset_writes();
        assert_eq!(
            s2_confirm_now(&fx, &w, first, sid),
            Ok(()),
            "{first} confirms first"
        );
        let want = TradeSession {
            opener_confirmed: opener_flag,
            partner_confirmed: !opener_flag,
            ..before
        };
        assert_eq!(
            bytes(&w.session(sid)),
            bytes(&want),
            "{first}: only the caller's flag changes"
        );
        assert!(
            w.assets() == assets,
            "{first}: a first confirm moves nothing"
        );
        let wrote = s2_writes(&fx, &ASSET_TABLES);
        assert!(wrote.is_empty(), "{first}: asset tables written: {wrote:?}");
        assert!(
            w.raw_snaps(sid) == snaps,
            "{first}: snapshot rows untouched"
        );
    }
}

/// A confirm naming any revision but the current one is `StaleRevision`.
#[test]
fn ts2_confirm_refuses_a_stale_revision() {
    let fx = fixture();
    let w = s2_std(&fx);
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[11], &[], 0),
        &off(&[21], &[], 0),
    );
    let revision = w.session(sid).revision;
    let stale = TradeSessionError::StaleRevision.to_string();
    for reviewed in [revision + 1, revision - 1, 0, u64::MAX] {
        s2_refused(&fx, &w, &format!("revision {reviewed}"), &stale, || {
            s2_confirm(&fx, alice(), sid, reviewed)
        });
    }
}

/// Standard world; `before_open` and `after_set` write the case's rows around
/// an alice -> bob session; alice's confirm of the current revision is refused
/// with exactly `want` and writes nothing.
fn s2_confirm_case(
    label: &str,
    before_open: impl FnOnce(&S2World<'_>),
    alice_offer: &Off,
    bob_offer: &Off,
    after_set: impl FnOnce(&S2World<'_>),
    want: &TradeSessionError,
) {
    let fx = fixture();
    let w = s2_std(&fx);
    w.join(dave());
    before_open(&w);
    let sid = s2_session(&fx, &w, alice(), bob(), alice_offer, bob_offer);
    after_set(&w);
    let revision = w.session(sid).revision;
    s2_refused(&fx, &w, label, &want.to_string(), || {
        s2_confirm(&fx, alice(), sid, revision)
    });
}

/// The caller's own `side_check` reasons refuse the confirm with that reason:
/// own side empty, other side empty, the last monster, a receipt that would
/// overflow the caller's own stack or wallet, and live eligibility (in battle,
/// re-owned, stack spent since the edit).
#[test]
fn ts2_confirm_refuses_the_callers_own_side_reasons() {
    use TradeSessionError as E;
    let none = s2_no_seed;
    s2_confirm_case(
        "own side empty",
        none,
        &off(&[], &[], 0),
        &off(&[21], &[], 0),
        none,
        &E::OwnSideEmpty,
    );
    s2_confirm_case(
        "other side empty",
        none,
        &off(&[11], &[], 0),
        &off(&[], &[], 0),
        none,
        &E::OtherSideEmpty,
    );
    s2_confirm_case(
        "the caller's last monster",
        |w| {
            assert_eq!(w.monsters.remove(12), 1);
            assert_eq!(w.pubs.remove(12), 1);
        },
        &off(&[11], &[], 0),
        &off(&[], &[item(6, 2)], 0),
        none,
        &E::LastMonster,
    );
    s2_confirm_case(
        "receipt overflows the caller's stack",
        |w| w.set_stack(alice(), 6, MAX_ITEM_STACK - 1),
        &off(&[11], &[], 0),
        &off(&[21], &[item(6, 2)], 0),
        none,
        &E::ItemStackCapExceeded { item_id: 6 },
    );
    s2_confirm_case(
        "receipt overflows the caller's wallet",
        |w| w.set_wallet(alice(), MAX_BALANCE - 1),
        &off(&[11], &[], 0),
        &off(&[21], &[], 2),
        none,
        &E::CurrencyCapExceeded,
    );
    s2_confirm_case(
        "offered monster entered a battle after the edit",
        none,
        &off(&[11], &[], 0),
        &off(&[21], &[], 0),
        |w| {
            w.battles.seed(&Battle {
                party_monster_ids: vec![11],
                ..ongoing(alice(), crate::WILD_IDENTITY)
            })
        },
        &E::MonsterInBattle { monster_id: 11 },
    );
    s2_confirm_case(
        "offered monster re-owned after the edit",
        none,
        &off(&[11], &[], 0),
        &off(&[21], &[], 0),
        |w| {
            w.replace(&Monster {
                owner_identity: dave(),
                ..w.monster(11)
            })
        },
        &E::MonsterNotOwned { monster_id: 11 },
    );
    s2_confirm_case(
        "offered stack spent after the edit",
        none,
        &off(&[11], &[item(5, 3)], 0),
        &off(&[21], &[], 0),
        |w| w.set_stack(alice(), 5, 1),
        &E::InsufficientItems { item_id: 5 },
    );
}

/// E3, driven by an EV-only change: alice has confirmed; bob's offered monster
/// gains one attack EV in its live row; bob's confirm — which would complete
/// the set — returns `Ok(())` WITHOUT recording a confirm or moving anything:
/// both flags false, revision + 1, that monster's snapshot row now the masked
/// live row, its card rebuilt from the live row, alice's side untouched. A
/// confirm pair on the new revision then executes.
#[test]
fn ts2_confirm_drift_resets() {
    let fx = fixture();
    let w = s2_std(&fx);
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[11], &[], 0),
        &off(&[21], &[], 0),
    );
    assert_eq!(
        s2_confirm_now(&fx, &w, alice(), sid),
        Ok(()),
        "setup: alice confirms"
    );
    let before = w.session(sid);
    let live = w.monster(21);
    let drifted = Monster {
        ev_attack: live.ev_attack + 1,
        ..live
    };
    w.replace(&drifted);
    let m11 = w.monster(11);
    let assets = w.assets();

    assert_eq!(
        s2_confirm(&fx, bob(), sid, before.revision),
        Ok(()),
        "a drifted confirm answers Ok"
    );
    let after = w.session(sid);
    assert_eq!(
        (after.opener_confirmed, after.partner_confirmed),
        (false, false),
        "drift clears alice's confirm and does not record bob's"
    );
    assert_eq!(
        after.revision,
        before.revision + 1,
        "drift advances the revision"
    );
    assert_eq!(
        after.opener_offer, before.opener_offer,
        "alice's side untouched"
    );
    assert_eq!(
        after.partner_offer,
        TradeSessionOffer {
            cards: vec![card(&drifted)],
            ..before.partner_offer.clone()
        },
        "bob's offer unchanged but for the rebuilt card"
    );
    assert_eq!(
        w.snaps(sid),
        s2_want_snaps(sid, &[&m11, &drifted]),
        "the drifted monster's snapshot row is the masked live row"
    );
    assert!(
        w.assets() == assets,
        "nothing executes on an unreviewed monster"
    );

    assert_eq!(
        s2_confirm_now(&fx, &w, alice(), sid),
        Ok(()),
        "alice re-confirms"
    );
    assert_eq!(
        s2_confirm_now(&fx, &w, bob(), sid),
        Ok(()),
        "bob re-confirms"
    );
    assert!(
        w.session_opt(sid).is_none(),
        "at the refreshed revision the trade executes"
    );
    assert_eq!(w.monster(21).owner_identity, alice());
}

/// Drift in a column the card shows rebuilds exactly that card, whoever
/// confirms: caller ∈ {opener alice, partner bob} × drifted monster on
/// {the caller's own side, the other side}, by a rename or a level change at
/// either offer index. alice offers [11, 12], bob offers [21, 22]. Each confirm
/// answers Ok, clears both flags, advances the revision, puts the live row's
/// card at the drifted monster's index, leaves every other card (and every
/// other offer column) as it was, and stores the masked live row as its
/// snapshot.
#[test]
fn ts2_confirm_drift_refreshes_the_card_on_either_side() {
    type Drift = fn(Monster) -> Monster;
    let rename: Drift = |m| Monster {
        nickname: "Renamed".to_string(),
        ..m
    };
    let level_up: Drift = |m| Monster {
        level: m.level + 1,
        ..m
    };
    for (label, caller, drifted_id, drift) in [
        ("opener confirms, own monster renamed", alice(), 11, rename),
        (
            "opener confirms, other side levelled",
            alice(),
            22,
            level_up,
        ),
        (
            "partner confirms, own monster levelled",
            bob(),
            21,
            level_up,
        ),
        ("partner confirms, other side renamed", bob(), 12, rename),
    ] {
        let fx = fixture();
        let w = s2_std(&fx);
        let sid = s2_session(
            &fx,
            &w,
            alice(),
            bob(),
            &off(&[11, 12], &[], 0),
            &off(&[21, 22], &[], 0),
        );
        let before = w.session(sid);
        let drifted = drift(w.monster(drifted_id));
        assert_ne!(
            card(&drifted),
            card(&w.monster(drifted_id)),
            "{label}: setup: the change is visible on the card"
        );
        w.replace(&drifted);
        assert_eq!(
            s2_confirm(&fx, caller, sid, before.revision),
            Ok(()),
            "{label}"
        );
        let after = w.session(sid);
        assert_eq!(
            (
                after.opener_confirmed,
                after.partner_confirmed,
                after.revision
            ),
            (false, false, before.revision + 1),
            "{label}: reset, confirm not recorded"
        );
        let refreshed = |offer: &TradeSessionOffer| -> TradeSessionOffer {
            let mut want = offer.clone();
            if let Some(at) = want.monster_ids.iter().position(|id| *id == drifted_id) {
                want.cards[at] = card(&drifted);
            }
            want
        };
        assert_eq!(
            after.opener_offer,
            refreshed(&before.opener_offer),
            "{label}: alice's offer and cards"
        );
        assert_eq!(
            after.partner_offer,
            refreshed(&before.partner_offer),
            "{label}: bob's offer and cards"
        );
        assert_ne!(
            (
                after.opener_offer.cards.clone(),
                after.partner_offer.cards.clone()
            ),
            (
                before.opener_offer.cards.clone(),
                before.partner_offer.cards.clone()
            ),
            "{label}: a card changed"
        );
        let live = [11, 12, 21, 22].map(|id| w.monster(id));
        let live_refs: Vec<&Monster> = live.iter().collect();
        assert_eq!(
            w.snaps(sid),
            s2_want_snaps(sid, &live_refs),
            "{label}: snapshot rows are the masked live rows"
        );
    }
}

/// Columns the mask blanks are not drift: a current-HP change, a bond-column
/// change and a party-to-party slot move on the other side's monster leave the
/// confirm recorded, the revision and the stored snapshot row as they were.
#[test]
fn ts2_confirm_hp_bond_and_slot_changes_are_not_drift() {
    type Change = fn(Monster) -> Monster;
    let changes: [(&str, Change); 3] = [
        ("current HP only", |m| Monster { current_hp: 3, ..m }),
        ("bond columns only", |m| Monster {
            trust_favorable_count: m.trust_favorable_count + 5,
            quality_time_accum_ms: m.quality_time_accum_ms + 9,
            quality_time_window_start_ms: m.quality_time_window_start_ms + 1,
            ..m
        }),
        ("party-to-party slot move", |m| Monster {
            party_slot: 4,
            ..m
        }),
    ];
    for (label, change) in changes {
        let fx = fixture();
        let w = s2_std(&fx);
        let sid = s2_session(
            &fx,
            &w,
            alice(),
            bob(),
            &off(&[11], &[], 0),
            &off(&[21], &[], 0),
        );
        let before = w.session(sid);
        w.replace(&change(w.monster(21)));
        let snaps = w.raw_snaps(sid);
        assert_eq!(
            s2_confirm(&fx, alice(), sid, before.revision),
            Ok(()),
            "{label}"
        );
        let after = w.session(sid);
        assert_eq!(
            (
                after.opener_confirmed,
                after.partner_confirmed,
                after.revision
            ),
            (true, false, before.revision),
            "{label}: the confirm is recorded"
        );
        assert!(
            w.raw_snaps(sid) == snaps,
            "{label}: snapshot rows untouched"
        );
    }
}

/// A stale revision is refused before the drift step: the live row has
/// drifted, yet nothing — snapshot, card, revision — is written.
#[test]
fn ts2_confirm_stale_revision_beats_drift() {
    let fx = fixture();
    let w = s2_std(&fx);
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[11], &[], 0),
        &off(&[21], &[], 0),
    );
    let revision = w.session(sid).revision;
    let live = w.monster(21);
    w.replace(&Monster {
        ev_speed: live.ev_speed + 1,
        ..live
    });
    s2_refused(
        &fx,
        &w,
        "stale revision over a drifted monster",
        &TradeSessionError::StaleRevision.to_string(),
        || s2_confirm(&fx, alice(), sid, revision + 1),
    );
}

/// An offered monster with NO snapshot row counts as drifted (fail closed): the
/// confirm answers Ok, records nothing, advances the revision and inserts the
/// masked live row.
#[test]
fn ts2_confirm_missing_snapshot_counts_as_drift() {
    let fx = fixture();
    let w = s2_std(&fx);
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[11], &[], 0),
        &off(&[21], &[], 0),
    );
    let before = w.session(sid);
    assert_eq!(
        w.snaps_by_monster.remove(21),
        1,
        "setup: drop 21's snapshot row"
    );
    assert_eq!(
        s2_confirm(&fx, alice(), sid, before.revision),
        Ok(()),
        "a confirm over a missing snapshot answers Ok"
    );
    let after = w.session(sid);
    assert_eq!(
        (
            after.opener_confirmed,
            after.partner_confirmed,
            after.revision
        ),
        (false, false, before.revision + 1),
        "reset, confirm not recorded"
    );
    assert_eq!(
        w.snaps(sid),
        s2_want_snaps(sid, &[&w.monster(11), &w.monster(21)]),
        "the missing row is written from the live row"
    );
}

/// The confirm gate keys on the session's stamp: a deletion request at the
/// session's own creation ms refuses the confirm (before the revision check;
/// an unknown session is still not-found first); a request 1 ms after the
/// session opened leaves it completable; a deleting partner never gates the
/// caller.
#[test]
fn ts2_confirm_deletion_gate_keys_on_the_session_stamp() {
    let gated = crate::guards::REJECT_DELETION_GATED;
    {
        let fx = fixture();
        let w = s2_std(&fx);
        let sid = s2_session(
            &fx,
            &w,
            alice(),
            bob(),
            &off(&[11], &[], 0),
            &off(&[21], &[], 0),
        );
        w.accounts.seed(&s2_deleting(alice(), T0));
        let revision = w.session(sid).revision;
        let later = |rev: u64, id: u64| {
            fx.run_as_at(alice(), at(T0 + 5), |ctx| {
                super::confirm_trade_session(ctx, id, rev)
            })
        };
        s2_refused(&fx, &w, "request at the session stamp", gated, || {
            later(revision, sid)
        });
        s2_refused(
            &fx,
            &w,
            "the gate precedes the revision check",
            gated,
            || later(revision + 1, sid),
        );
        s2_refused(
            &fx,
            &w,
            "a missing session is not-found before the gate",
            super::ERR_SESSION_NOT_FOUND,
            || later(revision, 999),
        );
    }
    {
        let fx = fixture();
        let w = s2_std(&fx);
        let sid = s2_session(
            &fx,
            &w,
            alice(),
            bob(),
            &off(&[11], &[], 0),
            &off(&[21], &[], 0),
        );
        w.accounts.seed(&s2_deleting(alice(), T0 + 1));
        let revision = w.session(sid).revision;
        assert_eq!(
            fx.run_as_at(alice(), at(T0 + 5), |ctx| {
                super::confirm_trade_session(ctx, sid, revision)
            }),
            Ok(()),
            "a session that predates the request stays completable"
        );
        assert!(w.session(sid).opener_confirmed);
    }
    {
        let fx = fixture();
        let w = s2_std(&fx);
        let sid = s2_session(
            &fx,
            &w,
            alice(),
            bob(),
            &off(&[11], &[], 0),
            &off(&[21], &[], 0),
        );
        w.accounts.seed(&s2_deleting(bob(), T0 - 1));
        assert_eq!(
            s2_confirm_now(&fx, &w, alice(), sid),
            Ok(()),
            "the partner's deletion state is never read"
        );
    }
}

// ---------------------------------------------------------------------------
// ts-2.7 / ts-2.8 / ts-2.9 — the confirm that completes the set (execute)
// ---------------------------------------------------------------------------

/// The execute re-runs `reject_if_in_battle` for BOTH sides over the player and
/// the opponent index. An Ongoing battle row is seeded directly (the battle
/// entry guard would refuse a confirmed side's monster): naming the confirmed
/// OTHER side's monster, the completing confirm answers Ok, clears that side's
/// flag and moves nothing; naming the caller's own monster, it is
/// `MonsterInBattle` and writes nothing. A finished battle blocks nothing.
#[test]
fn ts2_execute_rechecks_battle_both_sides() {
    for (label, battle) in [
        (
            "the other side's monster, player index",
            Battle {
                party_monster_ids: vec![11],
                ..ongoing(alice(), crate::WILD_IDENTITY)
            },
        ),
        (
            "the other side's monster, opponent index",
            Battle {
                opponent_monster_ids: vec![11],
                ..ongoing(dave(), alice())
            },
        ),
    ] {
        s2_after_battle_seeded(label, &battle, |fx, w, sid| {
            s2_assert_reset_other(fx, w, label, sid, || s2_confirm_now(fx, w, bob(), sid));
        });
    }
    for (label, battle) in [
        (
            "the caller's own monster, player index",
            Battle {
                party_monster_ids: vec![21],
                ..ongoing(bob(), crate::WILD_IDENTITY)
            },
        ),
        (
            "the caller's own monster, opponent index",
            Battle {
                opponent_monster_ids: vec![21],
                ..ongoing(dave(), bob())
            },
        ),
    ] {
        s2_after_battle_seeded(label, &battle, |fx, w, sid| {
            s2_refused(
                fx,
                w,
                label,
                &TradeSessionError::MonsterInBattle { monster_id: 21 }.to_string(),
                || s2_confirm_now(fx, w, bob(), sid),
            );
        });
    }
    let finished = Battle {
        party_monster_ids: vec![11],
        ..s2_battle(
            alice(),
            crate::WILD_IDENTITY,
            game_core::BattleOutcome::SideAWins,
        )
    };
    s2_after_battle_seeded("finished battle", &finished, |fx, w, sid| {
        assert_eq!(s2_confirm_now(fx, w, bob(), sid), Ok(()), "finished battle");
        assert!(
            w.session_opt(sid).is_none(),
            "a finished battle blocks nothing"
        );
        assert_eq!(w.monster(11).owner_identity, bob());
    });
}

/// Standard world, alice offers 11 and confirms, bob offers 21; `battle` is then
/// seeded directly (the battle entry guard refuses a confirmed side's monster)
/// and `check` runs with the session id.
fn s2_after_battle_seeded(
    label: &str,
    battle: &Battle,
    check: impl FnOnce(&Fixture, &S2World<'_>, u64),
) {
    let fx = fixture();
    let w = s2_std(&fx);
    w.join(dave());
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[11], &[], 0),
        &off(&[21], &[], 0),
    );
    assert_eq!(
        s2_confirm_now(&fx, &w, alice(), sid),
        Ok(()),
        "{label}: setup: alice confirms"
    );
    w.battles.seed(battle);
    check(&fx, &w, sid);
}

/// alice (opener) offers 11 + 4 of item 5 + 100 coins and confirms; bob offers
/// 21 + 2 of item 6. `break_it` then invalidates alice's confirmed side; bob's
/// completing confirm must reset alice with `Ok(())` (see
/// `s2_assert_reset_other`). Returns the session rows bob reads afterwards.
fn s2_other_side_fails(label: &str, break_it: impl FnOnce(&S2World<'_>)) -> Vec<u8> {
    let fx = fixture();
    let w = s2_std(&fx);
    w.join(dave());
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[11], &[item(5, 4)], 100),
        &off(&[21], &[item(6, 2)], 0),
    );
    assert_eq!(
        s2_confirm_now(&fx, &w, alice(), sid),
        Ok(()),
        "{label}: setup: alice confirms"
    );
    break_it(&w);
    s2_assert_reset_other(&fx, &w, label, sid, || s2_confirm_now(&fx, &w, bob(), sid));
    bytes(&w.rows_of(bob()))
}

/// E4: whichever way the other participant's confirmed side (alice) has become
/// invalid — stack drained, coins spent, monster re-owned, in battle, fainted,
/// boxed, a receipt that would overflow her own stack, holdings locked by
/// another confirmed session or by a legacy offer — the caller's (bob's)
/// completing confirm returns the SAME `Ok(())`, clears her flag, sets his,
/// keeps the revision, moves nothing, and leaves his view byte-identical across
/// every cause.
#[test]
fn ts2_execute_other_side_failure_resets_not_errors() {
    let empty = TradeSessionOffer::default;
    let mut outcomes = vec![
        s2_other_side_fails("offered stack drained", |w| w.set_stack(alice(), 5, 3)),
        s2_other_side_fails("offered coins spent", |w| w.set_wallet(alice(), 50)),
        s2_other_side_fails("offered monster re-owned", |w| {
            w.replace(&Monster {
                owner_identity: dave(),
                ..w.monster(11)
            })
        }),
        s2_other_side_fails("offered monster in an ongoing battle", |w| {
            w.battles.seed(&Battle {
                party_monster_ids: vec![11],
                ..ongoing(alice(), crate::WILD_IDENTITY)
            })
        }),
        s2_other_side_fails("offered monster fainted", |w| {
            w.replace(&Monster {
                current_hp: 0,
                ..w.monster(11)
            })
        }),
        s2_other_side_fails("offered monster boxed", |w| {
            w.replace(&Monster {
                party_slot: crate::PARTY_SLOT_NONE,
                ..w.monster(11)
            })
        }),
        s2_other_side_fails("receipt overflows the other side's stack", |w| {
            w.set_stack(alice(), 6, MAX_ITEM_STACK)
        }),
        s2_other_side_fails("holdings locked by another confirmed session", |w| {
            w.seed_session(
                700,
                alice(),
                dave(),
                s2_offer(&[], &[item(5, 8)], 0),
                empty(),
                (true, false),
            )
        }),
        s2_other_side_fails("holdings locked by a legacy offer", |w| {
            w.offers.seed(&TradeOffer {
                initiator_currency: 450,
                ..s2_legacy(800, alice(), dave())
            })
        }),
    ];
    let first = outcomes.remove(0);
    for (i, got) in outcomes.into_iter().enumerate() {
        assert!(got == first, "cause {}: a different caller view", i + 1);
    }
}

/// carol (exactly two monsters, 31 and 32) opens one session with alice giving
/// 31 for an item and one with bob giving 32 for an item; nobody has confirmed.
fn s2_two_sessions(fx: &Fixture, w: &S2World<'_>) -> (u64, u64) {
    w.join(carol());
    w.mon(31, carol(), 0);
    w.mon(32, carol(), 1);
    let first = s2_session(
        fx,
        w,
        carol(),
        alice(),
        &off(&[31], &[], 0),
        &off(&[], &[item(5, 1)], 0),
    );
    let second = s2_session(
        fx,
        w,
        carol(),
        bob(),
        &off(&[32], &[], 0),
        &off(&[], &[item(6, 1)], 0),
    );
    (first, second)
}

/// A player with exactly two monsters gives one away in each of two sessions.
/// After the first executes, the second completing confirm must not leave them
/// with none: as the OTHER side they are reset (`Ok`, their flag cleared,
/// nothing moved); as the CALLER they get `LastMonster` and nothing is written.
#[test]
fn ts2_execute_two_sessions_last_monster() {
    // carol is the other side of the second completing confirm
    {
        let fx = fixture();
        let w = s2_std(&fx);
        let (first, second) = s2_two_sessions(&fx, &w);
        assert_eq!(s2_confirm_now(&fx, &w, carol(), first), Ok(()));
        assert_eq!(s2_confirm_now(&fx, &w, carol(), second), Ok(()));
        assert_eq!(
            s2_confirm_now(&fx, &w, alice(), first),
            Ok(()),
            "the first session executes"
        );
        assert!(w.session_opt(first).is_none());
        assert_eq!(w.monster(31).owner_identity, alice());
        s2_assert_reset_other(&fx, &w, "carol as the other side", second, || {
            s2_confirm_now(&fx, &w, bob(), second)
        });
        assert_eq!(
            w.monster(32).owner_identity,
            carol(),
            "carol keeps her last monster"
        );
    }

    // carol is the caller of the second completing confirm
    {
        let fx = fixture();
        let w = s2_std(&fx);
        let (first, second) = s2_two_sessions(&fx, &w);
        assert_eq!(s2_confirm_now(&fx, &w, alice(), first), Ok(()));
        assert_eq!(s2_confirm_now(&fx, &w, bob(), second), Ok(()));
        assert_eq!(
            s2_confirm_now(&fx, &w, carol(), first),
            Ok(()),
            "the first session executes"
        );
        assert_eq!(w.monster(31).owner_identity, alice());
        s2_refused(
            &fx,
            &w,
            "carol as the caller",
            &TradeSessionError::LastMonster.to_string(),
            || s2_confirm_now(&fx, &w, carol(), second),
        );
        assert_eq!(
            w.monster(32).owner_identity,
            carol(),
            "carol keeps her last monster"
        );
    }
}

/// Netting at execute: a symmetric same-item swap near the cap — alice holds
/// 9990, gives 15, receives 20; bob holds 9999, gives 20, receives 15 — executes
/// (unnetted, each receipt would overflow) and lands exactly.
#[test]
fn ts2_execute_netted_headroom_same_item_near_cap() {
    let fx = fixture();
    let w = s2_std(&fx);
    w.set_stack(alice(), 5, MAX_ITEM_STACK - 9);
    w.set_stack(bob(), 5, MAX_ITEM_STACK);
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[], &[item(5, 15)], 0),
        &off(&[], &[item(5, 20)], 0),
    );
    assert_eq!(
        s2_confirm_now(&fx, &w, alice(), sid),
        Ok(()),
        "alice confirms"
    );
    assert_eq!(
        s2_confirm_now(&fx, &w, bob(), sid),
        Ok(()),
        "bob's completing confirm executes"
    );
    assert!(w.session_opt(sid).is_none(), "the session is gone");
    assert_eq!(
        (w.count(alice(), 5), w.count(bob(), 5)),
        (MAX_ITEM_STACK - 9 - 15 + 20, MAX_ITEM_STACK - 20 + 15),
        "each side nets its own debit before its credit"
    );
}

/// A receipt that would overflow is refused, never clamped: on the caller's
/// own stack it is `ItemStackCapExceeded` with nothing written; on the
/// confirmed other side's stack or wallet the other side is reset and nothing
/// moves. Every overflowing stack and wallet keeps its seeded value.
#[test]
fn ts2_execute_headroom_overflow_moves_nothing() {
    {
        let fx = fixture();
        let w = s2_std(&fx);
        w.set_stack(alice(), 5, 30);
        let sid = s2_session(
            &fx,
            &w,
            alice(),
            bob(),
            &off(&[11], &[item(5, 20)], 0),
            &off(&[21], &[], 0),
        );
        assert_eq!(
            s2_confirm_now(&fx, &w, alice(), sid),
            Ok(()),
            "alice confirms"
        );
        w.set_stack(bob(), 5, MAX_ITEM_STACK - 10);
        s2_refused(
            &fx,
            &w,
            "the caller's own stack would overflow",
            &TradeSessionError::ItemStackCapExceeded { item_id: 5 }.to_string(),
            || s2_confirm_now(&fx, &w, bob(), sid),
        );
        assert_eq!(w.count(bob(), 5), MAX_ITEM_STACK - 10, "not clamped");
    }
    for (label, stack, wallet) in [
        (
            "the other side's stack would overflow",
            MAX_ITEM_STACK - 4,
            500,
        ),
        ("the other side's wallet would overflow", 0, MAX_BALANCE - 9),
    ] {
        let fx = fixture();
        let w = s2_std(&fx);
        let sid = s2_session(
            &fx,
            &w,
            alice(),
            bob(),
            &off(&[11], &[item(5, 2)], 0),
            &off(&[21], &[item(6, 5)], 10),
        );
        assert_eq!(
            s2_confirm_now(&fx, &w, alice(), sid),
            Ok(()),
            "{label}: alice confirms"
        );
        w.set_stack(alice(), 6, stack);
        w.set_wallet(alice(), wallet);
        s2_assert_reset_other(&fx, &w, label, sid, || s2_confirm_now(&fx, &w, bob(), sid));
        assert_eq!(
            (w.count(alice(), 6), w.balance(alice())),
            (stack, wallet),
            "{label}: not clamped"
        );
    }
}

/// Assets drained under a confirmed side never produce a partial transfer: a
/// drained stack or emptied wallet on the confirmed OTHER side resets it with
/// nothing moved; on the caller's own side it is refused with the caller's
/// reason and nothing written. A failure after the execute verdict (here the
/// transferred monster's projection row is missing, so the apply fails at its
/// first read) answers the fixed `ERR_EXECUTE_FAILED` — never the apply's own
/// message — with no monster, stack or wallet changed.
#[test]
fn ts2_execute_apply_failure_rolls_back() {
    for (label, stack, wallet) in [
        ("the other side's stack drained", 0, 500),
        ("the other side's wallet emptied", 10, 0),
    ] {
        let fx = fixture();
        let w = s2_std(&fx);
        let sid = s2_session(
            &fx,
            &w,
            alice(),
            bob(),
            &off(&[11], &[item(5, 10)], 500),
            &off(&[21], &[item(6, 2)], 0),
        );
        assert_eq!(
            s2_confirm_now(&fx, &w, alice(), sid),
            Ok(()),
            "{label}: alice confirms"
        );
        w.set_stack(alice(), 5, stack);
        w.set_wallet(alice(), wallet);
        s2_assert_reset_other(&fx, &w, label, sid, || s2_confirm_now(&fx, &w, bob(), sid));
    }
    for (label, stack, wallet, want) in [
        (
            "the caller's own stack drained",
            0,
            500,
            TradeSessionError::InsufficientItems { item_id: 5 },
        ),
        (
            "the caller's own wallet emptied",
            10,
            0,
            TradeSessionError::InsufficientCurrency,
        ),
    ] {
        let fx = fixture();
        let w = s2_std(&fx);
        let sid = s2_session(
            &fx,
            &w,
            alice(),
            bob(),
            &off(&[11], &[item(5, 10)], 500),
            &off(&[21], &[item(6, 2)], 0),
        );
        assert_eq!(
            s2_confirm_now(&fx, &w, bob(), sid),
            Ok(()),
            "{label}: bob confirms"
        );
        w.set_stack(alice(), 5, stack);
        w.set_wallet(alice(), wallet);
        s2_refused(&fx, &w, label, &want.to_string(), || {
            s2_confirm_now(&fx, &w, alice(), sid)
        });
    }

    let fx = fixture();
    let w = s2_std(&fx);
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[11], &[], 0),
        &off(&[], &[item(6, 2)], 0),
    );
    assert_eq!(
        s2_confirm_now(&fx, &w, alice(), sid),
        Ok(()),
        "alice confirms"
    );
    assert_eq!(w.pubs.remove(11), 1, "setup: drop 11's projection row");
    let assets = w.assets();
    assert_eq!(
        s2_confirm_now(&fx, &w, bob(), sid),
        Err("trade could not be completed".to_string()),
        "a post-verdict failure answers the fixed string"
    );
    assert_eq!(super::ERR_EXECUTE_FAILED, "trade could not be completed");
    assert!(w.assets() == assets, "no monster, stack or wallet changed");
}

/// The execute deletes the session, its snapshot rows and its schedule row;
/// each transferred monster gets its new owner, the seven bond columns at the
/// game-core baseline and every other column byte-identical; arrivals take the
/// receiver's lowest free party slots AFTER its own outgoing monsters vacate,
/// in the giver's offer order, then Storage; each `monster_pub` twin agrees
/// (owner, slot, copied tier); items and coins move exactly and are conserved.
#[test]
fn ts2_execute_bond_reset_and_arrival() {
    const _: () = assert!(PARTY_SIZE >= 4, "the fixture needs party slots 0..=3");
    let fx = fixture();
    let w = s2_base(&fx);
    w.join(alice());
    w.join(bob());
    // alice: a full party, 11 + s in slot s; she gives 12 (slot 1).
    let mut seeded: Vec<Monster> = (0..PARTY_SIZE)
        .map(|s| bonded(11 + u64::from(s), alice(), s, s + 1))
        .collect();
    // bob: 21 (slot 0), 22 (slot 3), 23 (slot 1); he gives 22 then 21.
    seeded.push(bonded(21, bob(), 0, 7));
    seeded.push(bonded(22, bob(), 3, 8));
    seeded.push(bonded(23, bob(), 1, 9));
    for m in &seeded {
        w.put(m);
    }
    w.set_stack(alice(), 5, 10);
    w.set_stack(bob(), 6, 10);
    w.set_wallet(alice(), 500);
    w.set_wallet(bob(), 300);

    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[12], &[item(5, 10)], 500),
        &off(&[22, 21], &[item(6, 3)], 40),
    );
    assert_eq!(
        s2_confirm_now(&fx, &w, alice(), sid),
        Ok(()),
        "alice confirms"
    );
    fx.reset_writes();
    assert_eq!(
        s2_confirm_now(&fx, &w, bob(), sid),
        Ok(()),
        "bob's completing confirm executes"
    );
    assert_eq!(
        fx.writes_to("trade_session"),
        1,
        "the execute writes the session table exactly once — its delete, BEFORE the apply \
         (the apply's monster-write hook then finds no snapshot row); deleting after the \
         apply lets the hook delete it first, and the later delete still counts as a \
         write syscall even though it removes nothing"
    );

    assert!(w.session_opt(sid).is_none(), "the session row is gone");
    assert!(w.raw_snaps(sid).is_empty(), "its snapshot rows are gone");
    assert!(w.scheds_of(sid).is_empty(), "its schedule row is gone");

    let none = crate::PARTY_SLOT_NONE;
    let moved = [
        bonded_after_trade(12, bob(), 0, 2),
        bonded_after_trade(22, alice(), 1, 8),
        bonded_after_trade(21, alice(), none, 7),
    ];
    for want in &moved {
        let id = want.monster_id;
        assert_eq!(
            bytes(&w.monster(id)),
            bytes(want),
            "monster {id}: new owner, arrival slot, bond reset, every other column kept"
        );
        assert_eq!(
            bytes(&w.pub_row(id)),
            bytes(&crate::marshal::pub_from_monster(want, tier_of(id))),
            "monster {id}: the projection agrees"
        );
    }
    for m in &seeded {
        let id = m.monster_id;
        if moved.iter().all(|t| t.monster_id != id) {
            assert_eq!(bytes(&w.monster(id)), bytes(m), "monster {id}: untouched");
        }
    }
    assert_eq!(
        [
            (w.count(alice(), 5), w.count(alice(), 6)),
            (w.count(bob(), 5), w.count(bob(), 6)),
        ],
        [(0, 3), (10, 7)],
        "items moved exactly"
    );
    assert_eq!(
        (w.balance(alice()), w.balance(bob())),
        (40, 300 + 500 - 40),
        "coins moved exactly: alice gave all 500 and got 40"
    );
}

/// After a swap: alice's item 5, alice's item 6, bob's item 5, bob's item 6,
/// alice's coins, bob's coins.
type SwapTotals = [u64; 6];

/// Standard world plus `seed`; a session 700 (alice opener, bob partner, both
/// confirmed) with one schedule row is seeded directly; each side's live facts
/// come from `read_side`, and `execute_swap` runs DIRECTLY — no `side_check`
/// in front of it. `Err(e)`: exactly that error, no write syscall and every
/// session, snapshot, schedule and asset row unchanged. `Ok(totals)`: the swap
/// lands with exactly those stacks and balances and the session is deleted.
fn s2_swap_case(
    label: &str,
    seed: impl FnOnce(&S2World<'_>),
    opener_offer: TradeSessionOffer,
    partner_offer: TradeSessionOffer,
    want: Result<SwapTotals, String>,
) {
    let fx = fixture();
    let w = s2_std(&fx);
    seed(&w);
    w.seed_session(
        700,
        alice(),
        bob(),
        opener_offer,
        partner_offer,
        (true, true),
    );
    w.scheds.seed(&super::TradeSessionReaperSchedule {
        scheduled_id: 800,
        scheduled_at: ScheduleAt::Time(at(T0 + TRADE_SESSION_TTL_MS)),
        session_id: 700,
    });
    let session = w.session(700);
    let before = (w.session_tables(), w.assets());
    fx.reset_writes();
    let got = fx.run_as(carol(), |ctx| {
        let opener_live = super::read_side(
            ctx,
            session.opener,
            session.session_id,
            &session.opener_offer,
        );
        let partner_live = super::read_side(
            ctx,
            session.partner,
            session.session_id,
            &session.partner_offer,
        );
        super::execute_swap(ctx, &session, &opener_live, &partner_live)
    });
    match want {
        Err(e) => {
            assert_eq!(got, Err(e), "{label}");
            let mut tables = SESSION_TABLES.to_vec();
            tables.extend(ASSET_TABLES);
            let wrote = s2_writes(&fx, &tables);
            assert!(wrote.is_empty(), "{label}: a refused swap wrote {wrote:?}");
            assert!(
                (w.session_tables(), w.assets()) == before,
                "{label}: the headroom check runs before the delete and the apply"
            );
        }
        Ok(totals) => {
            assert_eq!(got, Ok(()), "{label}");
            let now: SwapTotals = [
                u64::from(w.count(alice(), 5)),
                u64::from(w.count(alice(), 6)),
                u64::from(w.count(bob(), 5)),
                u64::from(w.count(bob(), 6)),
                w.balance(alice()),
                w.balance(bob()),
            ];
            assert_eq!(now, totals, "{label}: exact stacks and balances");
            assert!(
                w.session_opt(700).is_none() && w.scheds_of(700).is_empty(),
                "{label}: the executed session is deleted"
            );
        }
    }
}

/// The combined `check_headroom` inside `execute_swap`, reached without the
/// `side_check` that normally shadows it. Each receiver is guarded on its own
/// axis — an item overflow and a currency overflow on the opener's side and,
/// mirrored, on the partner's — and each receiver's own outgoing item and coins
/// are netted first, so a near-cap swap that fits only after netting lands
/// exactly, on either side and on either axis. Every case uses different item
/// ids, quantities and coin amounts per side, so feeding one side's receiving
/// items, stacks, coins or balance into the other side's check changes an
/// outcome.
#[test]
fn ts2_swap_headroom_guards_each_receiver() {
    let stack = u64::from(MAX_ITEM_STACK);
    let o = |items: &[TradeItem], cur: u64| s2_offer(&[], items, cur);

    s2_swap_case(
        "the opener's received stack would overflow",
        |w| w.set_stack(alice(), 6, MAX_ITEM_STACK - 2),
        o(&[item(5, 4)], 7),
        o(&[item(6, 3)], 13),
        Err(TradeError::ItemStackCapExceeded { item_id: 6 }.to_string()),
    );
    s2_swap_case(
        "the partner's received stack would overflow",
        |w| w.set_stack(bob(), 5, MAX_ITEM_STACK - 3),
        o(&[item(5, 4)], 7),
        o(&[item(6, 3)], 13),
        Err(TradeError::ItemStackCapExceeded { item_id: 5 }.to_string()),
    );
    s2_swap_case(
        "the opener's wallet would overflow after netting its own 7",
        |w| w.set_wallet(alice(), MAX_BALANCE - 5),
        o(&[item(5, 4)], 7),
        o(&[item(6, 3)], 13),
        Err(TradeError::CurrencyCapExceeded.to_string()),
    );
    s2_swap_case(
        "the partner's wallet would overflow after netting its own 9",
        |w| w.set_wallet(bob(), MAX_BALANCE - 4),
        o(&[item(5, 4)], 14),
        o(&[item(6, 3)], 9),
        Err(TradeError::CurrencyCapExceeded.to_string()),
    );

    s2_swap_case(
        "the opener's same-item receipt fits only after its own 6 leave",
        |w| {
            w.set_stack(alice(), 5, MAX_ITEM_STACK - 2);
            w.set_stack(bob(), 5, 20);
        },
        o(&[item(5, 6)], 3),
        o(&[item(5, 7)], 4),
        Ok([stack - 1, 0, 19, 10, 501, 299]),
    );
    s2_swap_case(
        "the partner's same-item receipt fits only after its own 4 leave",
        |w| {
            w.set_stack(alice(), 6, 30);
            w.set_stack(bob(), 6, MAX_ITEM_STACK - 1);
        },
        o(&[item(6, 5)], 2),
        o(&[item(6, 4)], 5),
        Ok([10, 29, 0, stack, 503, 297]),
    );
    s2_swap_case(
        "the opener's coin receipt fits only after its own 10 leave",
        |w| w.set_wallet(alice(), MAX_BALANCE - 3),
        o(&[item(5, 1)], 10),
        o(&[item(6, 2)], 12),
        Ok([9, 2, 1, 8, MAX_BALANCE - 1, 298]),
    );
    s2_swap_case(
        "the partner's coin receipt fits only after its own 8 leave",
        |w| w.set_wallet(bob(), MAX_BALANCE - 2),
        o(&[item(5, 2)], 9),
        o(&[item(6, 1)], 8),
        Ok([8, 1, 2, 9, 499, MAX_BALANCE - 1]),
    );
}

// ---------------------------------------------------------------------------
// ts-2.10 (reaper half) — trade_session_reaper
// ---------------------------------------------------------------------------

/// A caller other than the module identity is refused with the scheduler-only
/// text and nothing is deleted — participants and strangers alike, even for a
/// stale session.
#[test]
fn ts2_reaper_refuses_a_non_scheduler_caller() {
    let fx = fixture();
    let w = s2_std(&fx);
    w.join(carol());
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[11], &[], 0),
        &off(&[21], &[], 0),
    );
    fx.set_database_identity(scheduler());
    for who in [alice(), bob(), carol()] {
        s2_refused(
            &fx,
            &w,
            &format!("{who} fires the reaper"),
            "trade_session_reaper is scheduler-only",
            || s2_reap(&fx, who, T0 + TRADE_SESSION_TTL_MS, w.fired(sid)),
        );
    }
}

/// Fired by the scheduler 1 ms before the TTL, the reaper answers Ok, leaves
/// the session and its snapshot rows alone, and re-arms exactly one new
/// schedule row for that session at its own deadline (`created_at_ms` +
/// `TRADE_SESSION_TTL_MS`): the runtime consumes the fired one-shot row, so
/// without the re-arm a session whose reaper fired early is never reaped. The
/// host does not delete the fired row itself, so it is still present beside
/// the new one. Another session's rows are untouched.
#[test]
fn ts2_reaper_spares_a_fresh_session() {
    let fx = fixture();
    let w = s2_std(&fx);
    w.join(carol());
    w.join(dave());
    w.mon(31, carol(), 0);
    w.mon(41, dave(), 0);
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[11], &[], 0),
        &off(&[21], &[], 0),
    );
    let other = s2_session(
        &fx,
        &w,
        carol(),
        dave(),
        &off(&[31], &[], 0),
        &off(&[41], &[], 0),
    );
    fx.set_database_identity(scheduler());
    let session_before = w.session_opt(sid).map(|s| bytes(&s));
    let snaps_before = w.raw_snaps(sid);
    let kept = w.footprint(other);
    let assets = w.assets();
    let fired = w.fired(sid);
    let (fired_id, fired_bytes) = (fired.scheduled_id, bytes(&fired));
    let created_at_ms = w.session(sid).created_at_ms;
    fx.reset_writes();
    assert_eq!(
        s2_reap(&fx, scheduler(), T0 + TRADE_SESSION_TTL_MS - 1, fired),
        Ok(()),
        "a fresh session's fire answers Ok"
    );
    let wrote = s2_writes(&fx, &SESSION_TABLES[..2]);
    assert!(wrote.is_empty(), "a fresh fire wrote {wrote:?}");
    assert_eq!(
        fx.writes_to("trade_session_reaper_schedule"),
        1,
        "one schedule write: the re-arm insert"
    );
    assert_eq!(
        w.session_opt(sid).map(|s| bytes(&s)),
        session_before,
        "the session survives unchanged"
    );
    assert!(
        w.raw_snaps(sid) == snaps_before,
        "its snapshot rows survive"
    );

    let rows: Vec<super::TradeSessionReaperSchedule> = w
        .scheds
        .rows()
        .into_iter()
        .filter(|r| r.session_id == sid)
        .collect();
    assert_eq!(rows.len(), 2, "the fired row plus exactly one new row");
    assert!(
        rows.iter().any(|r| bytes(r) == fired_bytes),
        "the fired row is left for the runtime"
    );
    let rearmed: Vec<&super::TradeSessionReaperSchedule> =
        rows.iter().filter(|r| r.scheduled_id != fired_id).collect();
    assert_eq!(rearmed.len(), 1, "exactly one re-armed row");
    assert_eq!(
        rearmed[0].scheduled_at,
        ScheduleAt::Time(at(created_at_ms + TRADE_SESSION_TTL_MS)),
        "re-armed at the session's own deadline"
    );
    assert!(w.footprint(other) == kept, "another session is untouched");
    assert!(w.assets() == assets, "the reaper moves no asset");
}

/// At exactly the TTL the fired session and its snapshot rows are deleted; the
/// FIRED schedule row is left for the runtime; another (equally stale) session
/// keeps its row, snapshots and schedule row.
#[test]
fn ts2_reaper_deletes_a_stale_session_and_its_snapshots_but_not_the_fired_row() {
    let fx = fixture();
    let w = s2_std(&fx);
    w.join(carol());
    w.join(dave());
    w.mon(31, carol(), 0);
    w.mon(41, dave(), 0);
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[11], &[], 0),
        &off(&[21], &[], 0),
    );
    let other = s2_session(
        &fx,
        &w,
        carol(),
        dave(),
        &off(&[31], &[], 0),
        &off(&[41], &[], 0),
    );
    assert!(
        !w.raw_snaps(sid).is_empty(),
        "setup: the reaped session has snapshots"
    );
    let kept = w.footprint(other);
    let fired = w.fired(sid);
    let fired_bytes = bytes(&fired);
    let assets = w.assets();
    fx.set_database_identity(scheduler());
    assert_eq!(
        s2_reap(&fx, scheduler(), T0 + TRADE_SESSION_TTL_MS, fired),
        Ok(()),
        "a stale fire answers Ok"
    );
    assert!(w.session_opt(sid).is_none(), "the stale session is deleted");
    assert!(w.raw_snaps(sid).is_empty(), "with its snapshot rows");
    assert_eq!(
        w.scheds_of(sid),
        vec![fired_bytes],
        "the fired schedule row is left for the runtime to delete"
    );
    assert!(w.footprint(other) == kept, "another session is untouched");
    assert!(w.assets() == assets, "the reaper moves no asset");
}

/// A fire whose session no longer exists answers Ok and writes nothing.
#[test]
fn ts2_reaper_missing_session_is_ok() {
    let fx = fixture();
    let w = s2_std(&fx);
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[11], &[], 0),
        &off(&[21], &[], 0),
    );
    fx.set_database_identity(scheduler());
    let before = (w.session_tables(), w.assets());
    fx.reset_writes();
    let orphan = super::TradeSessionReaperSchedule {
        scheduled_id: 4242,
        scheduled_at: ScheduleAt::Time(at(T0 + TRADE_SESSION_TTL_MS)),
        session_id: sid + 999,
    };
    assert_eq!(
        s2_reap(&fx, scheduler(), T0 + TRADE_SESSION_TTL_MS, orphan),
        Ok(()),
        "a missing session is Ok"
    );
    let wrote = s2_writes(&fx, &SESSION_TABLES);
    assert!(wrote.is_empty(), "an orphan fire wrote {wrote:?}");
    assert!(
        (w.session_tables(), w.assets()) == before,
        "nothing deleted"
    );
}

// ---------------------------------------------------------------------------
// cancel_trade_session
// ---------------------------------------------------------------------------

/// Either participant — confirmed or not, deletion-gated or not — cancels: the
/// session row, its snapshot rows and its schedule row are deleted; another
/// session and every asset are untouched.
#[test]
fn ts2_cancel_by_either_participant_deletes_row_snapshots_and_schedule() {
    for canceller in [alice(), bob()] {
        let fx = fixture();
        let w = s2_std(&fx);
        w.join(carol());
        w.join(dave());
        w.mon(31, carol(), 0);
        w.mon(41, dave(), 0);
        let sid = s2_session(
            &fx,
            &w,
            alice(),
            bob(),
            &off(&[11], &[], 0),
            &off(&[21], &[], 0),
        );
        let other = s2_session(
            &fx,
            &w,
            carol(),
            dave(),
            &off(&[31], &[], 0),
            &off(&[41], &[], 0),
        );
        assert_eq!(
            s2_confirm_now(&fx, &w, alice(), sid),
            Ok(()),
            "setup: alice confirms"
        );
        w.accounts.seed(&s2_deleting(canceller, T0 - 1));
        assert!(
            !w.raw_snaps(sid).is_empty() && !w.scheds_of(sid).is_empty(),
            "setup: snapshot and schedule rows exist"
        );
        let (kept, assets) = (w.footprint(other), w.assets());
        assert_eq!(
            s2_cancel(&fx, canceller, sid),
            Ok(()),
            "{canceller} cancels (never deletion-gated)"
        );
        assert!(
            w.session_opt(sid).is_none(),
            "{canceller}: the row is deleted"
        );
        assert!(
            w.raw_snaps(sid).is_empty(),
            "{canceller}: its snapshot rows too"
        );
        assert!(
            w.scheds_of(sid).is_empty(),
            "{canceller}: and its schedule row"
        );
        assert!(
            w.footprint(other) == kept,
            "{canceller}: another session untouched"
        );
        assert!(
            w.assets() == assets,
            "{canceller}: cancelling moves no asset"
        );
    }
}

/// A stranger cancelling a live session and a participant cancelling a
/// missing id both get "trade session not found", and nothing is written.
#[test]
fn ts2_cancel_refuses_a_stranger_and_a_missing_id() {
    let fx = fixture();
    let w = s2_std(&fx);
    w.join(carol());
    let sid = s2_session(
        &fx,
        &w,
        alice(),
        bob(),
        &off(&[11], &[], 0),
        &off(&[21], &[], 0),
    );
    let not_found = super::ERR_SESSION_NOT_FOUND;
    s2_refused(&fx, &w, "stranger", not_found, || {
        s2_cancel(&fx, carol(), sid)
    });
    s2_refused(&fx, &w, "missing id", not_found, || {
        s2_cancel(&fx, alice(), sid + 999)
    });
}

// ---------------------------------------------------------------------------
// The write-seam hook through apply_swap
// ---------------------------------------------------------------------------

/// A legacy `apply_swap` that moves a session-listed monster to a new owner
/// deletes that session with its snapshot and schedule rows; a session listing
/// another of the same owner's monsters survives. A session execute's own apply
/// deletes no OTHER session (one listing the giver's other monster, one listing
/// the receiver's other monster).
#[test]
fn ts2_auto_cancel_on_legacy_swap() {
    {
        let fx = fixture();
        let w = s2_std(&fx);
        w.join(carol());
        w.join(dave());
        let listed = s2_session(
            &fx,
            &w,
            alice(),
            bob(),
            &off(&[11], &[], 0),
            &off(&[21], &[], 0),
        );
        let bystander = s2_session(
            &fx,
            &w,
            alice(),
            dave(),
            &off(&[12], &[], 0),
            &off(&[], &[], 0),
        );
        let kept = w.footprint(bystander);
        let plan = build_swap_plan(&[live(11)], &[], &[], &[], 0, 0).expect("plan builds");
        let got = fx.run_as(carol(), |ctx| {
            super::apply_swap(ctx, &plan, alice(), carol(), |_| crate::PARTY_SLOT_NONE)
        });
        assert_eq!(got, Ok(()), "the legacy apply succeeds");
        assert_eq!(w.monster(11).owner_identity, carol());
        assert!(
            w.session_opt(listed).is_none(),
            "the session listing the moved monster is deleted"
        );
        assert!(w.raw_snaps(listed).is_empty(), "with its snapshot rows");
        assert!(w.scheds_of(listed).is_empty(), "and its schedule row");
        assert!(
            w.footprint(bystander) == kept,
            "a session listing 12 survives"
        );
    }
    {
        let fx = fixture();
        let w = s2_std(&fx);
        w.join(dave());
        let traded = s2_session(
            &fx,
            &w,
            alice(),
            bob(),
            &off(&[11], &[], 0),
            &off(&[21], &[], 0),
        );
        let alices_other = s2_session(
            &fx,
            &w,
            alice(),
            dave(),
            &off(&[12], &[], 0),
            &off(&[], &[], 0),
        );
        let bobs_other = s2_session(
            &fx,
            &w,
            dave(),
            bob(),
            &off(&[], &[], 0),
            &off(&[22], &[], 0),
        );
        let kept = (w.footprint(alices_other), w.footprint(bobs_other));
        assert_eq!(s2_confirm_now(&fx, &w, alice(), traded), Ok(()));
        assert_eq!(
            s2_confirm_now(&fx, &w, bob(), traded),
            Ok(()),
            "the session executes"
        );
        assert!(
            w.session_opt(traded).is_none(),
            "the executed session is gone"
        );
        assert!(
            (w.footprint(alices_other), w.footprint(bobs_other)) == kept,
            "the execute's own apply deletes no other session"
        );
    }
}
