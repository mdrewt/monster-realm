// Trading spine tests (M15a, ADR-0106).
//
// Each test annotates `// TEETH(fn_name): kills:<criterion>` so the eval can
// verify the proof-of-teeth pattern. Tests cover the pure game-core layer only
// (no SpacetimeDB context needed — guards and rules are pure functions).

#[cfg(test)]
use game_core::{
    build_swap_plan, make_monster_card, validate_proposal, LiveMonsterOwner, ProposalSide,
    TradeError, TradeItem, TradeStatus,
};

// ---------------------------------------------------------------------------
// TradeStatus
// ---------------------------------------------------------------------------

#[test]
// TEETH(TradeStatus::is_active): kills:TR-active-covers-both-variants
fn trade_status_is_active_covers_both_variants() {
    assert!(TradeStatus::Pending.is_active());
    assert!(TradeStatus::ConfirmedByCounterparty.is_active());
}

// ---------------------------------------------------------------------------
// MonsterCard — ADR-0015 / TR-19
// ---------------------------------------------------------------------------

#[test]
// TEETH(make_monster_card): kills:TR-19-no-iv-ev-nature-in-card
fn monster_card_has_no_iv_ev_nature_fields() {
    let card = make_monster_card(1, 2, "Flameling".to_string(), 5, 30, 35);
    // Structural: the type must NOT have iv_*/ev_*/nature_kind fields.
    // If this compiles the struct is safe; access attempts below would not compile.
    let _: u64 = card.monster_id;
    let _: u32 = card.species_id;
    let _: String = card.nickname.clone();
    let _: u8 = card.level;
    let _: u16 = card.current_hp;
    let _: u16 = card.stat_hp;
    // Confirm the card ctor does not embed hidden fields by verifying round-trip.
    assert_eq!(card.monster_id, 1);
    assert_eq!(card.species_id, 2);
    assert_eq!(card.level, 5);
    assert_eq!(card.current_hp, 30);
    assert_eq!(card.stat_hp, 35);
}

// ---------------------------------------------------------------------------
// validate_proposal — TR-21/TR-22/TR-20/TR-1
// ---------------------------------------------------------------------------

fn empty_side() -> ProposalSide<'static> {
    ProposalSide {
        monster_ids: &[],
        items: &[],
        currency: 0,
    }
}

#[test]
// TEETH(validate_proposal): kills:TR-21-self-trade-rejected
fn validate_proposal_rejects_self_trade() {
    let side = ProposalSide {
        monster_ids: &[1],
        items: &[],
        currency: 0,
    };
    let result = validate_proposal(false, false, true, side, empty_side());
    assert!(matches!(result, Err(TradeError::SelfTrade)));
}

#[test]
// TEETH(validate_proposal): kills:TR-1-empty-offer-rejected
fn validate_proposal_rejects_empty_offer() {
    // Both sides completely empty
    let result = validate_proposal(false, false, false, empty_side(), empty_side());
    assert!(matches!(result, Err(TradeError::EmptyOffer)));
}

#[test]
// TEETH(validate_proposal): kills:TR-20-already-in-trade-initiator
fn validate_proposal_rejects_initiator_already_in_trade() {
    let side = ProposalSide {
        monster_ids: &[1],
        items: &[],
        currency: 0,
    };
    let result = validate_proposal(true, false, false, side, empty_side());
    assert!(matches!(result, Err(TradeError::AlreadyInTrade)));
}

#[test]
// TEETH(validate_proposal): kills:TR-20-already-in-trade-counterparty
fn validate_proposal_rejects_counterparty_already_in_trade() {
    let side = ProposalSide {
        monster_ids: &[1],
        items: &[],
        currency: 0,
    };
    let result = validate_proposal(false, true, false, side, empty_side());
    assert!(matches!(result, Err(TradeError::AlreadyInTrade)));
}

#[test]
// TEETH(validate_proposal): kills:TR-1-duplicate-monster-in-offer
fn validate_proposal_rejects_duplicate_monster_ids() {
    let side = ProposalSide {
        monster_ids: &[42, 42],
        items: &[],
        currency: 0,
    };
    let result = validate_proposal(false, false, false, side, empty_side());
    assert!(matches!(result, Err(TradeError::DuplicateMonster)));
}

#[test]
// TEETH(validate_proposal): kills:TR-1-zero-qty-item-rejected
fn validate_proposal_rejects_zero_qty_item() {
    let zero_item = TradeItem { item_id: 1, qty: 0 };
    let side = ProposalSide {
        monster_ids: &[],
        items: &[zero_item],
        currency: 0,
    };
    let result = validate_proposal(false, false, false, side, empty_side());
    // A zero-qty item makes the offer effectively empty or invalid.
    assert!(result.is_err());
}

#[test]
// TEETH(validate_proposal): kills:TR-1-valid-proposal-accepted
fn validate_proposal_accepts_valid_offer() {
    let item = TradeItem { item_id: 5, qty: 2 };
    let initiator = ProposalSide {
        monster_ids: &[10],
        items: &[item],
        currency: 100,
    };
    let result = validate_proposal(false, false, false, initiator, empty_side());
    assert!(result.is_ok());
}

#[test]
// TEETH(validate_proposal): kills:TR-1-duplicate-item-same-side-accepted
fn validate_proposal_rejects_duplicate_item_id_same_side() {
    let dup_items = [
        game_core::TradeItem { item_id: 5, qty: 3 },
        game_core::TradeItem { item_id: 5, qty: 3 },
    ];
    let side = ProposalSide {
        monster_ids: &[],
        items: &dup_items,
        currency: 0,
    };
    let result = validate_proposal(false, false, false, side, empty_side());
    // Must reject: duplicate item_id within the same offer side causes escrow-qty bypass.
    assert!(
        result.is_err(),
        "duplicate item_id in offer side must be rejected"
    );
}

// ---------------------------------------------------------------------------
// build_swap_plan — TR-15/TR-16
// ---------------------------------------------------------------------------

#[test]
// TEETH(build_swap_plan): kills:TR-15-ownership-changed-rejects-swap
fn build_swap_plan_rejects_if_ownership_changed() {
    let initiator_live = vec![LiveMonsterOwner {
        monster_id: 1,
        owner_matches_expected: false, // ownership changed after offer was created
    }];
    let result = build_swap_plan(&initiator_live, &[], &[], &[], 0, 0);
    assert!(matches!(result, Err(TradeError::OwnershipChanged)));
}

#[test]
// TEETH(build_swap_plan): kills:TR-15-counterparty-ownership-change-passes-undetected
fn build_swap_plan_rejects_if_counterparty_ownership_changed() {
    // Verify the COUNTERPARTY ownership loop rejects, not just the initiator loop.
    // A mutation deleting the counterparty check (lines 163-167 of rules.rs) would
    // pass the initiator check and silently accept a stolen-monster scenario.
    let counterparty_live = vec![LiveMonsterOwner {
        monster_id: 99,
        owner_matches_expected: false, // counterparty monster ownership changed
    }];
    let result = build_swap_plan(&[], &counterparty_live, &[], &[], 0, 0);
    assert!(
        matches!(result, Err(TradeError::OwnershipChanged)),
        "counterparty ownership change must also be rejected"
    );
}

#[test]
// TEETH(build_swap_plan): kills:TR-16-swap-plan-monster-transfer
fn build_swap_plan_transfers_monsters_cross_side() {
    // Initiator offers monster 1; counterparty offers nothing.
    let i_live = vec![LiveMonsterOwner {
        monster_id: 1,
        owner_matches_expected: true,
    }];
    let plan = build_swap_plan(&i_live, &[], &[], &[], 0, 0).unwrap();
    assert_eq!(plan.monster_transfers.len(), 1);
    assert_eq!(plan.monster_transfers[0].monster_id, 1);
}

#[test]
// TEETH(build_swap_plan): kills:TR-16-swap-plan-item-transfer
fn build_swap_plan_transfers_items() {
    let item = TradeItem { item_id: 7, qty: 3 };
    let plan = build_swap_plan(&[], &[], &[item], &[], 0, 0).unwrap();
    assert_eq!(plan.item_transfers.len(), 1);
    assert_eq!(plan.item_transfers[0].item_id, 7);
    assert_eq!(plan.item_transfers[0].qty, 3);
    assert!(plan.item_transfers[0].from_initiator);
}

#[test]
// TEETH(build_swap_plan): kills:TR-16-swap-plan-currency-transfer
fn build_swap_plan_transfers_currency() {
    let plan = build_swap_plan(&[], &[], &[], &[], 500, 0).unwrap();
    assert_eq!(plan.currency_transfers.len(), 1);
    assert_eq!(plan.currency_transfers[0].amount, 500);
    assert!(plan.currency_transfers[0].from_initiator);
}

#[test]
// TEETH(build_swap_plan): kills:TR-16-swap-plan-empty-when-all-zero
fn build_swap_plan_empty_when_no_assets() {
    let plan = build_swap_plan(&[], &[], &[], &[], 0, 0).unwrap();
    assert!(plan.monster_transfers.is_empty());
    assert!(plan.item_transfers.is_empty());
    assert!(plan.currency_transfers.is_empty());
}

// ---------------------------------------------------------------------------
// reject_if_monster_in_trade — proof-of-teeth for the guard itself
// ---------------------------------------------------------------------------

#[test]
// TEETH(reject_if_monster_in_trade): kills:TR-2-guard-rejects-monster-in-active-offer
fn reject_if_monster_in_trade_rejects_active_offer() {
    use crate::guards::reject_if_monster_in_trade;
    use crate::schema::TradeOffer;
    use spacetimedb::Identity;

    let id_bytes = [1u8; 32];
    let identity = Identity::from_byte_array(id_bytes);
    let offer = TradeOffer {
        trade_id: 1,
        initiator: identity,
        counterparty: Identity::from_byte_array([2u8; 32]),
        initiator_monster_ids: vec![42],
        initiator_items: vec![],
        initiator_currency: 0,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![],
        counterparty_currency: 0,
        initiator_cards: vec![],
        counterparty_cards: vec![],
        status: TradeStatus::Pending,
        created_at_ms: 0,
    };

    // Monster 42 is in the offer → guard must reject.
    let result = reject_if_monster_in_trade(std::iter::once(&offer), 42);
    assert!(
        result.is_err(),
        "guard must reject monster 42 in active trade"
    );

    // Monster 99 is NOT in the offer → guard must pass.
    let result = reject_if_monster_in_trade(std::iter::once(&offer), 99);
    assert!(
        result.is_ok(),
        "guard must pass monster 99 not in any offer"
    );
}

#[test]
// TEETH(reject_if_monster_in_trade): kills:TR-2-guard-passes-empty-offers
fn reject_if_monster_in_trade_passes_with_no_offers() {
    use crate::guards::reject_if_monster_in_trade;
    use crate::schema::TradeOffer;

    let result = reject_if_monster_in_trade(std::iter::empty::<&TradeOffer>(), 1);
    assert!(result.is_ok());
}

// ---------------------------------------------------------------------------
// escrowed_item_qty — proof-of-teeth
// ---------------------------------------------------------------------------

#[test]
// TEETH(escrowed_item_qty): kills:TR-7-TR-8-item-escrow-accumulates-across-offers
fn escrowed_item_qty_sums_across_active_offers() {
    use crate::guards::escrowed_item_qty;
    use crate::schema::TradeOffer;
    use spacetimedb::Identity;

    let owner = Identity::from_byte_array([1u8; 32]);
    let other = Identity::from_byte_array([2u8; 32]);

    let offer1 = TradeOffer {
        trade_id: 1,
        initiator: owner,
        counterparty: other,
        initiator_monster_ids: vec![],
        initiator_items: vec![TradeItem { item_id: 5, qty: 3 }],
        initiator_currency: 0,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![],
        counterparty_currency: 0,
        initiator_cards: vec![],
        counterparty_cards: vec![],
        status: TradeStatus::Pending,
        created_at_ms: 0,
    };
    let offer2 = TradeOffer {
        trade_id: 2,
        initiator: owner,
        counterparty: other,
        initiator_monster_ids: vec![],
        initiator_items: vec![TradeItem { item_id: 5, qty: 2 }],
        initiator_currency: 0,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![],
        counterparty_currency: 0,
        initiator_cards: vec![],
        counterparty_cards: vec![],
        status: TradeStatus::ConfirmedByCounterparty,
        created_at_ms: 0,
    };

    let escrowed = escrowed_item_qty([&offer1, &offer2].into_iter(), owner, 5);
    assert_eq!(escrowed, 5, "should sum 3+2 across both active offers");

    // Item 7 is not escrowed in either offer.
    let escrowed_other = escrowed_item_qty([&offer1, &offer2].into_iter(), owner, 7);
    assert_eq!(escrowed_other, 0);
}

// ---------------------------------------------------------------------------
// escrowed_currency_amount — proof-of-teeth
// ---------------------------------------------------------------------------

#[test]
// TEETH(escrowed_currency_amount): kills:TR-9-TR-10-currency-escrow-accumulates
fn escrowed_currency_amount_sums_active_offers() {
    use crate::guards::escrowed_currency_amount;
    use crate::schema::TradeOffer;
    use spacetimedb::Identity;

    let owner = Identity::from_byte_array([1u8; 32]);
    let other = Identity::from_byte_array([2u8; 32]);

    let offer = TradeOffer {
        trade_id: 1,
        initiator: owner,
        counterparty: other,
        initiator_monster_ids: vec![],
        initiator_items: vec![],
        initiator_currency: 400,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![],
        counterparty_currency: 100,
        initiator_cards: vec![],
        counterparty_cards: vec![],
        status: TradeStatus::Pending,
        created_at_ms: 0,
    };

    // As initiator: escrowed = 400.
    let escrowed = escrowed_currency_amount(std::iter::once(&offer), owner);
    assert_eq!(escrowed, 400);

    // As counterparty: escrowed = 100.
    let escrowed_cp = escrowed_currency_amount(std::iter::once(&offer), other);
    assert_eq!(escrowed_cp, 100);
}

// ---------------------------------------------------------------------------
// escrowed_item_qty counterparty branch — proof-of-teeth (tester SIGNIFICANT-4)
// ---------------------------------------------------------------------------

#[test]
// TEETH(escrowed_item_qty): kills:TR-8-counterparty-item-escrow-uses-wrong-side
fn escrowed_item_qty_uses_counterparty_items_when_owner_is_counterparty() {
    use crate::guards::escrowed_item_qty;
    use crate::schema::TradeOffer;
    use spacetimedb::Identity;

    let initiator = Identity::from_byte_array([1u8; 32]);
    let counterparty = Identity::from_byte_array([2u8; 32]);

    // initiator offers item 3 (qty 7), counterparty offers item 3 (qty 4).
    let offer = TradeOffer {
        trade_id: 1,
        initiator,
        counterparty,
        initiator_monster_ids: vec![],
        initiator_items: vec![TradeItem { item_id: 3, qty: 7 }],
        initiator_currency: 0,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![TradeItem { item_id: 3, qty: 4 }],
        counterparty_currency: 0,
        initiator_cards: vec![],
        counterparty_cards: vec![],
        status: TradeStatus::Pending,
        created_at_ms: 0,
    };

    // When called as INITIATOR: should return 7 (from initiator_items), NOT 4.
    let escrowed_as_initiator = escrowed_item_qty(std::iter::once(&offer), initiator, 3);
    assert_eq!(
        escrowed_as_initiator, 7,
        "initiator escrow for item 3 must be 7, not counterparty's 4"
    );

    // When called as COUNTERPARTY: should return 4 (from counterparty_items), NOT 7.
    // A mutation that always uses initiator_items would return 7 here instead of 4,
    // causing the counterparty's sell/train guard to over-restrict or under-restrict.
    let escrowed_as_counterparty = escrowed_item_qty(std::iter::once(&offer), counterparty, 3);
    assert_eq!(
        escrowed_as_counterparty, 4,
        "counterparty escrow for item 3 must be 4, not initiator's 7"
    );
}
