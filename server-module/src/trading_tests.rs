// Trading spine tests.
//
// Two layers: the pure game-core rules and guard functions (validate_proposal,
// build_swap_plan, the escrow guards), and — at the end of the file — the
// native-host suite that executes the shipped trading reducers against real rows.

#[cfg(test)]
use game_core::{
    build_swap_plan, make_monster_card, validate_proposal, LiveMonsterOwner, ProposalSide,
    TradeError, TradeItem, TradeStatus,
};

// ---------------------------------------------------------------------------
// TradeStatus
// ---------------------------------------------------------------------------

/// Because BOTH variants are active, the `is_active()` filter in
/// `open_offers_addressed_to` is forward-defensive against a future terminal variant, not live
/// protection — the day a third variant lands, this assertion is where that claim is re-examined.
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
// escrowed_item_qty counterparty branch — proof-of-teeth
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

/// the pure trade-side size predicate, by value.
///
/// File-local, pure, and `ReducerContext`-free so it can be tested exactly like this.
///
/// The boundary pairs `(64, 0) Ok` / `(65, 0) Err` and `(0, 64) Ok` /
/// `(0, 65) Err` pin the cap VALUES (an off-by-one in either direction fails).
/// They do **not**, on their own, pin that the two limits are checked
/// INDEPENDENTLY:
/// a single `n_monsters + n_items > 64` sum check passes all four,
/// then rejects a perfectly legal `(64, 64)` trade. `(64, 64) Ok` is the
/// assertion that actually kills it, and it is why that case is here.
///
/// The three saturation cases (`usize::MAX`, `65_536`) exist because
/// boundary-only pairs cannot see a TRUNCATING comparison: `if n_monsters as u8 >
/// MAX_TRADE_MONSTERS_PER_SIDE as u8` passes every small-value assertion while
/// `n = 256` (and `65_536`, and `usize::MAX`) wrap to values that compare as
/// under the cap and return `Ok` — leaving the DoS surface wide open at exactly
/// the magnitudes it was added to bound.
///
/// **`(0, 0)` must be `Ok`, and that case is the load-bearing one.** The nearest
/// in-repo template is `guards::check_party_size`, which
/// rejects `n == 0` — copy-pasting it here would reject EVERY legal one-sided
/// trade (offer monsters, ask currency), i.e. break a shipped feature while
/// "adding a security guard". Emptiness is not this function's concern: it is
/// `validate_proposal`'s CROSS-SIDE `EmptyOffer` rule
/// and must not be restated here.
/// Why 64 and not `MAX_PARTY_SIZE`: `propose_trade` never checks `party_slot`,
/// and `client/src/ui/tradeProposeModel.ts` offers ALL owned monsters, so
/// boxed monsters are tradeable today — a cap of 6 would reject legitimate
/// existing UI flows. These are DoS bounds, not game rules.
///
/// Kills: no cap at all (compile error → E0425); a `check_party_size` copy-paste
/// (`(0,0)` returns Err); an off-by-one on either cap (`(64,·)` or `(·,64)`
/// rejected, or `(65,·)`/`(·,65)` admitted); a monsters-only cap that leaves the
/// item vector unbounded (`(0,65)` returns Ok).
#[test]
fn e4_trade_side_size_caps_reject_oversized_and_admit_empty() {
    assert!(
        super::check_trade_side_size(64, 0).is_ok(),
        "TEETH (E4-A/D3): check_trade_side_size(64, 0) must be Ok — 64 is \
         MAX_TRADE_MONSTERS_PER_SIDE and the cap is inclusive. A cap of 6 \
         (== PARTY_SIZE) was considered and REJECTED: propose_trade never checks \
         party_slot and the client offers all owned monsters, so boxed monsters are \
         tradeable today and a 6 cap would reject legitimate existing UI flows with \
         an opaque server error (ADR-0166 D3)."
    );
    assert!(
        super::check_trade_side_size(65, 0).is_err(),
        "TEETH (E4-A/D3): check_trade_side_size(65, 0) must be Err — one over \
         MAX_TRADE_MONSTERS_PER_SIDE. Reject, never truncate: silently clamping a \
         trade list changes what the player agreed to."
    );
    assert!(
        super::check_trade_side_size(0, 64).is_ok(),
        "TEETH (E4-A/D3): check_trade_side_size(0, 64) must be Ok — 64 is \
         MAX_TRADE_ITEMS_PER_SIDE and the cap is inclusive."
    );
    assert!(
        super::check_trade_side_size(0, 65).is_err(),
        "TEETH (E4-A/D3): check_trade_side_size(0, 65) must be Err. This is the \
         assertion that kills a monsters-only cap: the per-item inventory scan at \
         trading.rs:278-329 is O(items x inventory rows), so the ITEM vector is the \
         more expensive one to leave unbounded."
    );
    assert!(
        super::check_trade_side_size(0, 0).is_ok(),
        "TEETH (E4-A/D3): check_trade_side_size(0, 0) must be Ok. This is the \
         load-bearing case. The nearest in-repo template, guards::check_party_size \
         (guards.rs:105-108), REJECTS n == 0 — copy-pasting it here would break EVERY \
         legal one-sided trade (offer monsters, ask currency). Emptiness is NOT this \
         function's concern: it is validate_proposal's cross-side EmptyOffer rule \
         (game-core/src/trading/rules.rs:53-61) and must not be restated (ADR-0166 D3)."
    );
    // H1: the two caps must be INDEPENDENT, not a sum.
    assert!(
        super::check_trade_side_size(64, 64).is_ok(),
        "TEETH (E4-A/D3): check_trade_side_size(64, 64) must be Ok — the monster cap \
         and the item cap are INDEPENDENT limits, not a shared budget. A single \
         `n_monsters + n_items > 64` check passes all four boundary pairs above and \
         is caught only here; it would reject a completely legal trade of 64 \
         monsters plus 64 items with an opaque server error."
    );
    // EV-7: boundary-only pairs cannot see a truncating comparison.
    assert!(
        super::check_trade_side_size(65_536, 0).is_err(),
        "TEETH (E4-A/D3, EV-7): check_trade_side_size(65_536, 0) must be Err. \
         Boundary pairs alone do not pin the comparison's WIDTH: \
         `if n_monsters as u8 > MAX_TRADE_MONSTERS_PER_SIDE as u8` passes (64,0) and \
         (65,0) while 256, 65_536 and usize::MAX all wrap to values that compare as \
         under the cap — the caps become inert at exactly the magnitudes they exist \
         to bound. A `u16` cast fails on this value specifically."
    );
    assert!(
        super::check_trade_side_size(usize::MAX, 0).is_err(),
        "TEETH (E4-A/D3, EV-7): check_trade_side_size(usize::MAX, 0) must be Err. \
         Any narrowing cast, wrapping arithmetic, or `n % something` comparison in \
         the monster check dies here. Note this value is not reachable through a \
         real BSATN payload — it is a pure-function probe of the comparison itself."
    );
    assert!(
        super::check_trade_side_size(0, usize::MAX).is_err(),
        "TEETH (E4-A/D3, EV-7): check_trade_side_size(0, usize::MAX) must be Err — \
         the same width probe for the ITEM check, which is the more expensive vector \
         to leave unbounded (trading.rs:278-329 scans the whole inventory once per \
         listed item)."
    );
}

/// A deliberately NON-ZERO request stamp for every rb-47 fixture.
///
/// At a request stamp of zero the `unwrap_or(0)` mis-spelling of the
/// missing-stamp arm is byte-invisible: every wrong implementation agrees with
/// the right one. A wall-clock-shaped stamp plus the negative offsets in the
/// truth table is what makes them separable.
const RB47_REQUESTED_AT_MS: i64 = 1_700_000_000_000;

/// A mid-grace account row for somebody who is NOT the caller, seeded once per
/// behavioural test and never removed.
///
/// Without it a TABLE-keyed predicate (refuse if ANYBODY is deleting) is
/// observationally identical to the caller-keyed one in every state, because the
/// fixture would only ever hold the sender's row. `remove` and `find` are
/// `Identity`-keyed, so this row never disturbs the per-state `remove(me) == 1`
/// assertions. Returns the stranger's identity so a test can also ask ABOUT it.
///
/// The issuer string and the creation stamp are DIFFERENT from every other rb-47
/// fixture on purpose. A predicate keyed on a field the fixtures never vary is
/// unobservable, and the deletion decision touches three of this row's nine
/// columns: with every row carrying an empty issuer and a zero clock, a leading
/// `if !account.auth_issuer.is_empty() { return false; }` passes the whole suite
/// (measured survivor A34) and needs no conditional compilation to hide behind.
fn rb47_seed_deleting_stranger(
    acct: &crate::native_host_tests::Handle<'_, crate::schema::Account>,
    requested_at_ms: i64,
) -> spacetimedb::Identity {
    let stranger = spacetimedb::Identity::from_byte_array([9u8; 32]);
    acct.seed(&crate::accounts::requested_deletion(
        crate::accounts::new_account_row(stranger, "rb47-stranger".to_string(), 77_000),
        requested_at_ms,
    ));
    stranger
}

/// Register the `u64`-keyed offer table for one fixture (rb-47 widened the host
/// with `table_keyed` precisely so a reducer whose first statement is a point
/// read on an auto-inc primary key can be executed at all).
fn rb47_offer_table(
    fx: &crate::native_host_tests::Fixture,
) -> crate::native_host_tests::Handle<'_, crate::schema::TradeOffer, u64> {
    fx.table_keyed("trade_offer", "trade_id", |r| r.trade_id)
}

/// One `trade_offer` row whose initiator is a third party. The struct literal is
/// unavoidable (unlike `Account`, `TradeOffer` has no pure constructor and
/// carries no legal-state invariant), and it is the same house pattern
/// `economy_tests.rs` uses for `Player`.
fn rb47_offer(
    trade_id: u64,
    counterparty: spacetimedb::Identity,
    status: TradeStatus,
    created_at_ms: i64,
) -> crate::schema::TradeOffer {
    crate::schema::TradeOffer {
        trade_id,
        initiator: spacetimedb::Identity::from_byte_array([3u8; 32]),
        counterparty,
        initiator_monster_ids: vec![],
        initiator_items: vec![],
        initiator_currency: 0,
        counterparty_monster_ids: vec![],
        counterparty_items: vec![],
        counterparty_currency: 0,
        initiator_cards: vec![],
        counterparty_cards: vec![],
        status,
        created_at_ms,
    }
}

/// the stamp-aware refusal is the terminal marker OR
/// (the para-4.7 gate AND an offer that does not predate the request).
///
/// Five account shapes crossed with six stamps, including two NEGATIVE ones and
/// both `i64` extremes. The request stamp is deliberately non-zero (see
/// [`RB47_REQUESTED_AT_MS`]).
///
/// WHAT EACH ROW OWNS:
///
///   * Active, every stamp: false. Kills the inverted polarity (a total
///     trade-accept outage that every source pin in this slice reports as
///     correctly gated) and the dropped `should_reject_for_deletion` conjunct
///     (with it gone, the missing-stamp arm answers true for every Active row).
///   * PendingDeletion at the request stamp minus one: false. This is PRV1-10 —
///     a PREDATING commitment stays completable, and it is the single row that
///     separates this slice from the blanket gate the brief forbids.
///   * PendingDeletion at exactly the request stamp: true. The boundary is
///     INCLUSIVE: both stamps come from the same ms-floored
///     transaction clock, so `propose immediately after requesting` is
///     reachable, and an equal stamp does not predate. This row alone kills the
///     strict-greater-than flip.
///   * The legal terminal row at EVERY stamp, including stamps older than its
///     own request: true. That is D1's LEADING clause, and dropping it leaves an
///     already-erased account able to accept old offers.
///   * Both ILLEGAL shapes (Active plus marker, PendingDeletion with no stamp)
///     at every stamp: true. `account_state_is_legal` is only debug_asserted, so
///     the shipped wasm can hold them, and every marker call site in
///     `accounts.rs` is fail-closed on them deliberately. The negative stamps
///     are what kill `unwrap_or(0)` on the second shape.
#[test]
fn rb47_opened_commitment_is_refused_truth_table() {
    let req = RB47_REQUESTED_AT_MS;
    let me = spacetimedb::Identity::from_byte_array([1u8; 32]);

    // Legal shapes: shipped constructors only, so this test can never assemble a
    // state the module itself cannot produce. The issuer and the creation stamp
    // are NON-DEFAULT, and differ from the stranger's and the caller's rows in
    // the behavioural tests: a decision keyed on a column every fixture leaves at
    // its default is invisible to execution, and the two illegal shapes below
    // inherit these values through their struct updates.
    let active = crate::accounts::new_account_row(me, "rb47-issuer".to_string(), 42_000);
    let pending = crate::accounts::requested_deletion(active.clone(), req);
    let terminal = crate::accounts::terminal_account(pending.clone(), req + 1_000);

    // Illegal shapes: unreachable through the constructors BY CONSTRUCTION, so a
    // struct-update literal is the only way to observe the fail-closed arms.
    let illegal_marker = crate::schema::Account {
        terminal_at_ms: Some(5),
        ..active.clone()
    };
    let illegal_no_stamp = crate::schema::Account {
        status: crate::schema::AccountStatus::PendingDeletion,
        ..active.clone()
    };

    for opened in [req - 1, req, req + 1, i64::MIN, -1, i64::MAX] {
        let got = crate::accounts::opened_commitment_is_refused(&active, opened);
        assert!(
            !got,
            "rb-47 E1 FAIL (pure decision, Active row, offer opened at {opened}): the \
             stamp-aware decision REFUSED an offer opened by an account that never requested \
             deletion. An `Active` account is outside the para-4.7 gate at every stamp, so a \
             true here is a TOTAL trade-accept outage for every honest player. It is exactly \
             what an INVERTED polarity produces and exactly what dropping the \
             `should_reject_for_deletion` conjunct produces (the missing-stamp arm then \
             answers true for every Active row). No source pin in this slice can see either: \
             the call text is byte-identical whichever way the decision runs."
        );

        let want = opened >= req;
        let got = crate::accounts::opened_commitment_is_refused(&pending, opened);
        assert_eq!(
            got, want,
            "rb-47 E1 FAIL (pure decision, PendingDeletion requested at {req}, offer opened \
             at {opened}): wanted {want}, got {got}. The boundary is INCLUSIVE (ADR-0237 D1): \
             an offer created IN the request millisecond does not PREDATE the request and is \
             refused; an offer created one millisecond earlier is the predating commitment \
             PRV1-10 protects and must stay completable. This row owns three mutants at once \
             — the strict-greater-than flip (visible only at the equal stamp), the polarity \
             inversion, and a BLANKET gate that ignores the stamp entirely (visible only at \
             the earlier stamp). A blanket gate here IS the PRV1-10 break this whole slice \
             exists to avoid."
        );

        let got = crate::accounts::opened_commitment_is_refused(&terminal, opened);
        assert!(
            got,
            "rb-47 E1 FAIL (pure decision, terminal row, offer opened at {opened}): a row \
             carrying the M22 terminal marker must be refused at EVERY stamp, including \
             stamps that predate its own request. That is D1's LEADING clause — the marker \
             test sits OUTSIDE the stamp comparison, not inside it. The cascade has already \
             erased this account's monsters, items and currency, and `accounts.rs` states the \
             contract as: an already-erased account must never be allowed new commitments. \
             Drop the leading clause and this row is ADMITTED for every offer older than its \
             own request stamp — invisible to every source pin and to the mid-grace rows."
        );

        let got = crate::accounts::opened_commitment_is_refused(&illegal_marker, opened);
        assert!(
            got,
            "rb-47 E1 FAIL (pure decision, ILLEGAL Active-plus-marker row, offer opened at \
             {opened}): the resurrected-tombstone shape must be refused at every stamp. \
             `account_state_is_legal` forbids it, but only under a `debug_assert`, so the \
             shipped wasm can hold it — which is why every marker call site in `accounts.rs` \
             is fail-closed on it deliberately. Admitting it lets an already-erased account \
             accept a fresh trade."
        );

        let got = crate::accounts::opened_commitment_is_refused(&illegal_no_stamp, opened);
        assert!(
            got,
            "rb-47 E1 FAIL (pure decision, ILLEGAL PendingDeletion-with-no-stamp row, offer \
             opened at {opened}): a gated account whose request stamp is missing must be \
             refused at EVERY stamp. `None` is the fail-closed arm, and D1 spells it as an \
             explicit match arm for exactly that reason. `None => false` admits every offer \
             for such a row; `unwrap_or(0)` admits exactly the NEGATIVE stamps, which is why \
             this table runs over `i64::MIN` and minus one as well as the request boundary. \
             Both mis-spellings are byte-invisible to every source pin, and both are \
             invisible to a truth table whose request stamp is zero."
        );
    }
}

/// the stamp-aware predicate answers from the row of the identity it was PASSED,
/// live, at every offset.
///
/// The shipped predicate runs through five caller
/// states crossed with three offsets around the request stamp, with a mid-grace
/// STRANGER row present throughout. The stranger is what makes the admitted
/// states mean anything: without it, a TABLE-keyed answer (refuse if anybody is
/// deleting) is observationally identical to the caller-keyed one.
///
/// The last two calls pass the STRANGER's identity while the caller has NO row —
/// the only place the identity PARAMETER is observable at all. An implementation
/// that ignores its parameter and reads `ctx.sender()` answers false for both,
/// and every other assertion in this test stays green.
///
/// kills: a table-keyed or any-row-pending answer (the admitted states go red,
/// or a full-table scan aborts the process on the unmodelled syscall — louder
/// still); a row-EXISTS-keyed answer (the Active state); a memoised or latched
/// answer (the removed-row state); a `ctx.sender()`-keyed answer (the stranger
/// calls); the polarity inversion; the boundary flip (the equal-stamp offset).
#[test]
fn rb47_ctx_predicate_answers_from_the_callers_row() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();
    let req = RB47_REQUESTED_AT_MS;
    let stranger_req = req + 7_000;
    let stranger = rb47_seed_deleting_stranger(&acct, stranger_req);

    let active = crate::accounts::new_account_row(me, "rb47-caller".to_string(), 42_000);
    let pending = crate::accounts::requested_deletion(active.clone(), req);
    let terminal = crate::accounts::terminal_account(pending.clone(), req + 1_000);

    let offsets: [(i64, &str); 3] = [
        (req - 1, "one millisecond BEFORE the request (predating)"),
        (req, "the EXACT request millisecond (inclusive boundary)"),
        (req + 1, "one millisecond AFTER the request (the attack)"),
    ];

    // --- State 1: no account row for the caller (a guest) -------------------
    for (opened, when) in offsets {
        let got = crate::accounts::refuses_commitment_opened_at(&ctx, me, opened);
        assert!(
            !got,
            "rb-47 E1 FAIL (admitted, no account row; offer opened {when}): the predicate \
             refused a caller with NO account row while a STRANGER's row is mid-grace. A \
             caller who never authenticated holds no deletion state at all, exactly as \
             `is_pending_deletion` decides it. A refusal here means the answer comes from the \
             TABLE rather than from the named identity's own row. Indexes the generated code \
             asked this host about: {:?}",
            fx.requested_indexes()
        );
    }

    // --- State 2: an Active account row --------------------------------------
    acct.seed(&active);
    for (opened, when) in offsets {
        let got = crate::accounts::refuses_commitment_opened_at(&ctx, me, opened);
        assert!(
            !got,
            "rb-47 E1 FAIL (admitted, Active row; offer opened {when}): the predicate refused \
             a caller whose account row is `Active`. This is the ordinary player, and \
             refusing them is a total trade-accept outage that every source pin in this slice \
             reports as correctly gated. It is also precisely what a row-EXISTS-keyed fake, \
             an any-row-pending table answer, and an inverted branch all produce."
        );
    }

    // --- State 3: mid-grace (PendingDeletion at the request stamp) -----------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-47 fixture: exactly one `Active` row was seeded for the CALLER and must be \
         removed before the next state is pushed — `seed` appends rather than upserting, so a \
         miscount leaves two rows under one identity and the unique-index lookup asserts \
         instead of answering. `remove` is Identity-keyed: the stranger's row is deliberately \
         untouched and must never be counted here."
    );
    acct.seed(&pending);
    for (opened, when) in offsets {
        let want = opened >= req;
        let got = crate::accounts::refuses_commitment_opened_at(&ctx, me, opened);
        assert_eq!(
            got, want,
            "rb-47 E1 FAIL (mid-grace row; offer opened {when}): wanted {want}, got {got}. \
             THIS IS THE WHOLE CRITERION, executed: an offer created at or after the deletion \
             request is refused, and an offer created before it stays admitted. The earlier \
             offset is PRV1-10 (a blanket gate reds it); the equal offset is ADR-0237 D1's \
             inclusive boundary (the strict-greater-than flip reds it)."
        );
    }

    // --- State 4: terminal (PendingDeletion plus the marker) -----------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-47 fixture: exactly one mid-grace row was seeded for the CALLER and must be \
         removed before the terminal row is pushed (`seed` appends, never upserts; the \
         stranger's row is Identity-keyed and stays put)."
    );
    acct.seed(&terminal);
    for (opened, when) in offsets {
        let got = crate::accounts::refuses_commitment_opened_at(&ctx, me, opened);
        assert!(
            got,
            "rb-47 E1 FAIL (terminal row; offer opened {when}): a caller carrying the M22 \
             terminal marker must be refused at EVERY offset, including the one that predates \
             their own request. The cascade already erased this account's monsters, items and \
             currency, so accepting even an old offer would recreate rows the deletion just \
             removed. Dropping D1's leading marker clause reds exactly this offset and \
             nothing else."
        );
    }

    // --- State 5: the caller's row is gone again -----------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-47 fixture: exactly one terminal row was seeded for the CALLER and must be \
         removable; the stranger's mid-grace row stays."
    );
    for (opened, when) in offsets {
        let got = crate::accounts::refuses_commitment_opened_at(&ctx, me, opened);
        assert!(
            !got,
            "rb-47 E1 FAIL (admitted, row removed; offer opened {when}): the verdict must \
             track LIVE rows for the identity it was passed. An answer that latches on a row \
             it has already seen — a memoised predicate, a cached decision, a process-wide \
             flag — keeps refusing this identity forever, and an any-row-pending answer \
             refuses it because of somebody else. No state above can distinguish either of \
             those from a correct predicate on its own."
        );
    }

    // --- The identity PARAMETER, observed (the caller still has no row) ------
    let got = crate::accounts::refuses_commitment_opened_at(&ctx, stranger, stranger_req - 1);
    assert!(
        !got,
        "rb-47 E1 FAIL (parameter honoured, predating): asked about the STRANGER's identity \
         with an offer opened one millisecond before THE STRANGER's request, the predicate \
         refused. PRV1-10 holds for every identity, not just for the sender. This call and \
         the next are the only place the identity PARAMETER is observable: the caller has no \
         row at all here, so an implementation that ignores its parameter and reads \
         `ctx.sender()` answers false for BOTH — and only this pair notices."
    );
    let got = crate::accounts::refuses_commitment_opened_at(&ctx, stranger, stranger_req);
    assert!(
        got,
        "rb-47 E1 FAIL (parameter honoured, at the request): asked about the STRANGER's \
         identity with an offer opened AT the stranger's own request millisecond, the \
         predicate admitted. A `ctx.sender()`-keyed implementation answers exactly this way \
         (the sender has no row here), and so does one that reads the FIRST row of the table. \
         The named identity's own row is the only correct source. Indexes the generated code \
         asked this host about: {:?}",
        fx.requested_indexes()
    );
}

/// the wrapper refuses ONLY offers created at or
/// after the caller's own deletion request.
///
/// The behavioural centrepiece. Five caller states crossed with three offsets
/// under the native host, with a mid-grace STRANGER row present throughout, and
/// the refusal compared against the CONSTANT `guards::REJECT_DELETION_GATED` —
/// never a re-typed literal, so a reworded reason cannot drift into text no
/// client ever receives.
///
/// kills: the inverted polarity (which every source pin in this slice reports as
/// correctly gated); a hollow wrapper or a trailing `.or(Ok(()))` (all five
/// refused cells go green while the fused-call text stays intact); a blanket gate
/// (the predating offsets red — the PRV1-10 break the brief forbids); the
/// boundary flip (the equal offset); a dropped terminal clause (the terminal
/// state's earliest offset); a table-keyed answer (the admitted states, while the
/// stranger is mid-grace); a latched answer (the removed-row state).
#[test]
fn rb47_guards_wrapper_refuses_only_offers_created_after_the_request() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let ctx = fx.ctx();
    let me = ctx.sender();
    let req = RB47_REQUESTED_AT_MS;
    rb47_seed_deleting_stranger(&acct, req + 7_000);

    let reducer = ["respond_", "trade"].concat();
    let gated: Result<(), String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());
    let admitted: Result<(), String> = Ok(());

    let active = crate::accounts::new_account_row(me, "rb47-caller".to_string(), 42_000);
    let pending = crate::accounts::requested_deletion(active.clone(), req);
    let terminal = crate::accounts::terminal_account(pending.clone(), req + 1_000);

    let offsets: [(i64, &str); 3] = [
        (req - 1, "one millisecond BEFORE the request (predating)"),
        (req, "the EXACT request millisecond (inclusive boundary)"),
        (req + 1, "one millisecond AFTER the request (the attack)"),
    ];

    // --- State 1: no account row for the caller (a guest) -------------------
    for (opened, when) in offsets {
        let got = crate::guards::require_commitment_predates_deletion(&ctx, &reducer, opened);
        assert_eq!(
            got,
            admitted,
            "rb-47 E1 FAIL (admitted, no account row; offer opened {when}): the wrapper \
             returned {got:?} for a caller with NO account row, while a STRANGER's row is \
             mid-grace. A guest holds no deletion state and must pass straight through. \
             Indexes the generated code asked this host about: {:?}",
            fx.requested_indexes()
        );
    }

    // --- State 2: an Active account row --------------------------------------
    acct.seed(&active);
    for (opened, when) in offsets {
        let got = crate::guards::require_commitment_predates_deletion(&ctx, &reducer, opened);
        assert_eq!(
            got, admitted,
            "rb-47 E1 FAIL (admitted, Active row; offer opened {when}): the wrapper returned \
             {got:?} for an ordinary player. Refusing here is a total trade-accept outage, \
             and it is what an inverted polarity, a row-EXISTS-keyed answer and an \
             any-row-pending table answer all produce — none of them visible to a source pin."
        );
    }

    // --- State 3: mid-grace (PendingDeletion at the request stamp) -----------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-47 fixture: exactly one `Active` row was seeded for the CALLER and must be \
         removed before the next state is pushed (`seed` appends, never upserts; the \
         stranger's row is Identity-keyed and stays put)."
    );
    acct.seed(&pending);
    for (opened, when) in offsets {
        let want = if opened >= req {
            gated.clone()
        } else {
            admitted.clone()
        };
        let got = crate::guards::require_commitment_predates_deletion(&ctx, &reducer, opened);
        assert_eq!(
            got, want,
            "rb-47 E1 FAIL (mid-grace; offer opened {when}): the wrapper returned {got:?}, \
             wanted {want:?}. THIS IS THE CRITERION, executed end to end through the shipped \
             wrapper: an offer created at or after the deletion request is refused with the \
             module's single static deletion reject; an offer created before it is ADMITTED, \
             because PRV1-10 keeps predating commitments completable. A blanket gate reds the \
             first offset, the boundary flip reds the second, and a hollow wrapper reds both \
             of the last two."
        );
    }

    // --- State 4: terminal (PendingDeletion plus the marker) -----------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-47 fixture: exactly one mid-grace row was seeded for the CALLER and must be \
         removed before the terminal row is pushed."
    );
    acct.seed(&terminal);
    for (opened, when) in offsets {
        let got = crate::guards::require_commitment_predates_deletion(&ctx, &reducer, opened);
        assert_eq!(
            got, gated,
            "rb-47 E1 FAIL (terminal; offer opened {when}): the wrapper returned {got:?} for \
             a caller carrying the M22 terminal marker; it must refuse at EVERY offset, \
             including the one predating that account's own request. The cascade already \
             erased this account's assets, so accepting an old offer would recreate rows the \
             deletion just removed. Dropping D1's leading marker clause reds exactly this \
             cell."
        );
    }

    // --- State 5: the caller's row is gone again -----------------------------
    assert_eq!(
        acct.remove(me),
        1,
        "rb-47 fixture: exactly one terminal row was seeded for the CALLER and must be \
         removable; the stranger's mid-grace row stays."
    );
    for (opened, when) in offsets {
        let got = crate::guards::require_commitment_predates_deletion(&ctx, &reducer, opened);
        assert_eq!(
            got, admitted,
            "rb-47 E1 FAIL (admitted, row removed; offer opened {when}): the wrapper returned \
             {got:?} once the caller's row was gone again (the stranger's mid-grace row is \
             still there). The verdict must track LIVE rows for the CALLER: a memoised or \
             latched answer keeps refusing this identity forever, and an any-row-pending \
             answer refuses it because of somebody else."
        );
    }
}

/// the shipped `respond_trade` refuses an accepting response to an offer created
/// at or after the caller's deletion request.
///
/// The shipped reducer is EXECUTED over a `u64`-keyed `trade_offer` table.
///
/// ONE-SIDED BY CONSTRUCTION, and this is the honest limit: every write syscall
/// ABORTS the process uncatchably, so the ADMITTED direction — the predating
/// offer that must stay completable — cannot be asserted here at all. It reaches
/// the status update and takes the process down. That half of the criterion is
/// owned by `rb47_guards_wrapper_refuses_only_offers_created_after_the_request`
/// (which executes the same verdict one call below the reducer).
/// For the same reason there is no declining case here: a decline deletes a row.
///
/// THE THREE CONTROLS ARE NOT DECORATION. The caller is mid-grace in every one
/// of them, so each proves the gate did NOT run: an ordinary status error, an
/// ordinary role error and an ordinary not-found error would all be replaced by
/// the deletion reject if the gate were hoisted above the authorization. They
/// also prove the `u64`-keyed fixture actually resolves rows, without which the
/// tooth below would pass vacuously on a not-found error.
///
/// RED AT HEAD BY PROCESS ABORT: with no gate, case (d) advances the offer and
/// the unmodelled update syscall aborts (nextest reports a signal, not a failed
/// assertion, and a should-panic attribute cannot catch it). Case (d) is
/// therefore LAST — every control has already reported by then.
#[test]
fn rb47_respond_trade_refuses_a_post_request_accept() {
    let fx = crate::native_host_tests::fixture();
    let acct = fx.table::<crate::schema::Account>("account", "identity", |r| r.identity);
    let offers = rb47_offer_table(&fx);
    let ctx = fx.ctx();
    let me = ctx.sender();
    let req = RB47_REQUESTED_AT_MS;
    let stranger = rb47_seed_deleting_stranger(&acct, req + 7_000);

    // The caller is mid-grace for the WHOLE test: the controls below are what
    // prove the gate does not fire before the authorization it must follow. The
    // issuer and creation stamp are non-default and differ from the stranger's,
    // so a decision keyed on either column is observable here.
    acct.seed(&crate::accounts::requested_deletion(
        crate::accounts::new_account_row(me, "rb47-caller".to_string(), 42_000),
        req,
    ));

    offers.seed(&rb47_offer(
        1,
        me,
        TradeStatus::ConfirmedByCounterparty,
        req,
    ));
    offers.seed(&rb47_offer(2, stranger, TradeStatus::Pending, req));
    offers.seed(&rb47_offer(3, me, TradeStatus::Pending, req));
    offers.seed(&rb47_offer(4, me, TradeStatus::Pending, req + 1));

    // --- Control (a): the row is found, but its status is not Pending -------
    let want: Result<(), String> = Err("trade offer is not in Pending state".to_string());
    let got = crate::trading::respond_trade(&ctx, 1, true);
    assert_eq!(
        got,
        want,
        "rb-47 E1 FAIL (control, wrong status): the reducer returned {got:?} for a mid-grace \
         caller responding to an offer that is no longer Pending; the pure authorization owns \
         that answer, and the offer-age gate must run BELOW it (ADR-0117, role and status \
         first). The deletion reject here means the gate was hoisted above the authorization, \
         which leaks account-lifecycle state into a message that should be about the offer. \
         This case also proves the u64-keyed fixture RESOLVES rows — without that, the tooth \
         below would pass on a not-found error and prove nothing. Indexes the generated code \
         asked this host about: {:?}",
        fx.requested_indexes()
    );

    // --- Control (b): the caller is not this offer's counterparty -----------
    let want: Result<(), String> =
        Err("only the trade counterparty can perform this action".to_string());
    let got = crate::trading::respond_trade(&ctx, 2, true);
    assert_eq!(
        got, want,
        "rb-47 E1 FAIL (control, wrong role): the reducer returned {got:?} for a mid-grace \
         caller responding to somebody else's offer. Role is checked FIRST and no status or \
         lifecycle state may leak to a non-party (ADR-0117). The deletion reject here means \
         the gate runs above the role check — and it would then tell any caller, about any \
         offer, that THEY are mid-grace before establishing they are a party at all."
    );

    // --- Control (c): no such offer -----------------------------------------
    let want: Result<(), String> = Err("trade offer not found".to_string());
    let got = crate::trading::respond_trade(&ctx, 99, true);
    assert_eq!(
        got, want,
        "rb-47 E1 FAIL (control, unknown offer): the reducer returned {got:?} for an offer id \
         that was never seeded. The lookup owns this answer; the gate needs an OFFER's \
         creation stamp and therefore cannot run before the offer is in hand. A deletion \
         reject here means the gate was hoisted to the top of the reducer, where it has no \
         stamp to judge and must be reading something else."
    );

    // --- (d) THE TOOTH: a Pending offer created AT or AFTER the request -----
    // Runs LAST: at HEAD these two calls reach the status write and the native
    // host aborts the process on the unmodelled write syscall. That abort IS the
    // red state for this test.
    let gated: Result<(), String> = Err(crate::guards::REJECT_DELETION_GATED.to_string());
    let got = crate::trading::respond_trade(&ctx, 3, true);
    assert_eq!(
        got, gated,
        "rb-47 E1 FAIL (the criterion, equal stamp): the reducer returned {got:?} for a \
         mid-grace caller ACCEPTING an offer stamped in the very millisecond of their own \
         deletion request. ADR-0237 D1's boundary is inclusive: an offer created in that \
         millisecond does not PREDATE the request, and the attack this closes is `request \
         deletion, then have a confederate propose immediately`. The expected reason is \
         compared against the CONSTANT, never a re-typed literal, so a reworded reason cannot \
         drift into text no client ever receives. \
         RED AT HEAD BY ABORT, not by assertion: with no gate this call reaches the status \
         write and the native host takes the process down on the unmodelled write syscall."
    );
    let got = crate::trading::respond_trade(&ctx, 4, true);
    assert_eq!(
        got, gated,
        "rb-47 E1 FAIL (the criterion, later stamp): the reducer returned {got:?} for a \
         mid-grace caller accepting an offer created one millisecond AFTER their deletion \
         request. This is the literal EARS shape — an offer created AFTER the request — and \
         an implementation that reds only the equal-stamp case above while passing this one \
         is not reachable without inverting the comparison, which the pure truth table also \
         owns. Admitting it lets a deleting account escrow a counterparty into a swap the \
         cascade is about to unwind."
    );
}

/// `open_offers_addressed_to` reads the COUNTERPARTY column of `trade_offer` and
/// nothing else, and projects exactly `(trade_id, created_at_ms)`.
///
/// THE FIXTURE IS THE ARGUMENT. Four rows are seeded and only two may come back:
///
///   * id 21 names a STRANGER as counterparty. It is what makes the answer
///     row-keyed rather than table-keyed: a helper that returns every active
///     offer in the table (or that filters on the wrong value) returns it too.
///   * id 5 names the CALLER as INITIATOR and the stranger as counterparty. This
///     is the whole of ADR-0252 D4 executed: `propose_trade` is blanket-gated for
///     a deletion-gated caller, so every initiator-side offer of theirs PREDATES
///     the request and is exactly the in-flight commitment PRV1-10 protects.
///     Sweeping that column would be a real spec break, and a
///     `.initiator()`-keyed or both-column helper (M7) returns this row.
///   * ids 3 and 7 name the CALLER as counterparty, with DIFFERENT ids, DIFFERENT
///     stamps and DIFFERENT statuses (one `ConfirmedByCounterparty`, one
///     `Pending`). Two rows, not one, is what kills a `.find(..)`-shaped helper
///     that returns the first match; the differing stamps are what prove the
///     projection carries the OFFER's own `created_at_ms` rather than a constant,
///     a clock read or the id again.
///
/// THE COMPARISON IS AS A SET, deliberately. The order this host returns matching
/// rows in is its own seeding order, which is a property of the in-memory shim
/// and not of the shipped btree index, so pinning it would pin the fixture rather
/// than the criterion. Order where it IS behaviour — the order the planner hands
/// ids to `decline_offers` — is owned by `[rb83/table-order]` in
/// `accounts_tests.rs` and by the frozen bodies in the test below.
///
/// THE INDEX NAME IS ASSERTED because a mis-spelled column in the helper resolves
/// to an index this host has no rows behind, which yields an EMPTY result that
/// reads exactly like `no offers addressed to this caller`. The failure message
/// prints every index name the generated code actually asked for, so a wrong
/// column is diagnosed rather than guessed at.
///
/// `[rb83/decline-empty]` then runs the writer with an EMPTY slice. Every write
/// syscall in this host aborts the PROCESS uncatchably, so this is the one
/// direction of `decline_offers` that can be executed at all — and it is not a
/// smoke test: a writer that ignores its argument and sweeps the caller's column
/// itself (M14) takes the process down here, and the re-read afterwards proves
/// execution continued AND that nothing was deleted.
#[test]
fn rb83_open_offers_addressed_to_reads_only_the_counterparty_column() {
    let fx = crate::native_host_tests::fixture();
    let offers = fx.table_keyed::<crate::schema::TradeOffer, spacetimedb::Identity>(
        "trade_offer",
        "counterparty",
        |r| r.counterparty,
    );
    let ctx = fx.ctx();
    let me = ctx.sender();
    let stranger = spacetimedb::Identity::from_byte_array([9u8; 32]);
    let req = RB47_REQUESTED_AT_MS;

    // Addressed to somebody else entirely.
    offers.seed(&rb47_offer(21, stranger, TradeStatus::Pending, req));
    // The caller is the INITIATOR here, never the counterparty.
    offers.seed(&crate::schema::TradeOffer {
        initiator: me,
        ..rb47_offer(5, stranger, TradeStatus::Pending, req + 2)
    });
    // The two rows that must come back: different ids, stamps and statuses.
    offers.seed(&rb47_offer(
        3,
        me,
        TradeStatus::ConfirmedByCounterparty,
        req - 1,
    ));
    offers.seed(&rb47_offer(7, me, TradeStatus::Pending, req + 1));

    let mut got = crate::trading::open_offers_addressed_to(&ctx, me);
    got.sort();
    let mut want: Vec<(u64, i64)> = vec![(3, req - 1), (7, req + 1)];
    want.sort();
    assert_eq!(
        got,
        want,
        "[rb83/read-counterparty-only] `open_offers_addressed_to` returned {got:?}; it must \
         return exactly {want:?} (compared as a SET — the order this in-memory host hands back \
         matching rows is its own seeding order, not a property of the shipped btree index, so \
         pinning it would pin the fixture). \
         Offer 21 is addressed to a STRANGER: returning it means the answer comes from the \
         TABLE rather than from the named identity's own column, and the cancel sweep would \
         then delete offers belonging to players who never cancelled anything. \
         Offer 5 names the caller as INITIATOR: returning it is the PRV1-10 break ADR-0252 D4 \
         argues through in full — `propose_trade` is blanket-gated for a deletion-gated \
         caller, so every initiator-side offer of theirs PREDATES the request and is precisely \
         the in-flight commitment the spec protects. A `.initiator()`-keyed helper, or one \
         that chains BOTH columns the way `erase_trade_offers` correctly does, returns it. \
         A single pair means the helper stops at the first match; a pair whose second element \
         is not the offer's own `created_at_ms` means the projection reads a constant, a clock \
         or the id again — and the planner would then judge every offer against the same \
         stamp. Indexes the generated code asked this host about: {:?}",
        fx.requested_indexes()
    );

    let index = "trade_offer_counterparty_idx_btree";
    let asked = fx.requested_indexes();
    assert!(
        asked.iter().any(|name| name.as_str() == index),
        "[rb83/read-counterparty-index] the generated code never asked this host for the \
         `{index}` index; it asked for {asked:?}. The helper must read through the \
         COUNTERPARTY btree index (schema.rs declares one on that column and \
         `erase_trade_offers` already uses it), which is an O(offers-for-this-player) point \
         scan. A different index name means a different column — and a column this fixture \
         registered no rows behind yields an EMPTY result that reads exactly like `no offers \
         are addressed to this caller`, which is the quietest possible way for the whole sweep \
         to become a no-op. A full-table scan would not appear here at all: it is unmodelled \
         and would have aborted the process."
    );

    // --- [rb83/decline-empty]: the one executable direction of the writer ----
    crate::trading::decline_offers(&ctx, &[]);
    let after = crate::trading::open_offers_addressed_to(&ctx, me);
    assert_eq!(
        after.len(),
        2,
        "[rb83/decline-empty] after `decline_offers(&ctx, &[])` the caller still has \
         {after:?}; both counterparty-side offers must survive an EMPTY id list. Every write \
         syscall in the rb-41 native host aborts the PROCESS uncatchably (nextest reports a \
         signal, not a failed assertion), so this is the only direction of the writer that can \
         be executed here — and it is not decoration: a writer that IGNORES its `trade_ids` \
         argument and sweeps the caller's column itself, or one that deletes unconditionally \
         before consulting the list, takes the process down on this line. Reaching the re-read \
         at all proves execution continued past the call; the count proves nothing was \
         deleted. The populated direction is executed by \
         `nh_trade_every_offer_deletion_site_disarms_its_reaper`."
    );
}

// ===========================================================================
// Native-host behavioural suite (debloat Phase 2: EV-trade-conservation,
// EV-trade-escrow-guards, EV-trade-reducer-security, ST-trading_tests#conservation).
//
// Every reducer here runs through `Fixture::run_as(_at)` with a real sender,
// against the tables it reads through their real indexes. HOST LIMIT: there is
// no transaction rollback, so every rejection is asserted as refusal BEFORE any
// write (the whole store byte-identical); a mid-apply failure (a broke sender at
// `spend_currency`) relies on rollback and stays with the two-identity trade e2e.
// ===========================================================================

use crate::native_host_tests::{fixture, Fixture, Handle};
use crate::schema::{
    Account, Battle, Inventory, ItemRow, Monster, MonsterPub, Player, PlayerWallet, TradeOffer,
};
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Timestamp};
use std::collections::BTreeMap;

const NH_T0: i64 = 1_750_000_000_000;
const NH_ESCROW_MONSTER: &str = "monster is in an active trade";

fn nh_a() -> Identity {
    Identity::from_byte_array([0xA1; 32])
}
fn nh_b() -> Identity {
    Identity::from_byte_array([0xB2; 32])
}
fn nh_c() -> Identity {
    Identity::from_byte_array([0xC3; 32])
}
fn nh_at(ms: i64) -> Timestamp {
    Timestamp::from_micros_since_unix_epoch(ms * 1000)
}
fn nh_item(item_id: u32, qty: u32) -> TradeItem {
    TradeItem { item_id, qty }
}

/// A private monster row whose GENES are distinct per id, so a swap that
/// rebuilt the row instead of re-keying it is visible.
fn nh_monster(monster_id: u64, owner: Identity, party_slot: u8) -> Monster {
    let g = (monster_id % 29) as u8 + 1;
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
        current_hp: 33,
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

fn nh_offer(
    trade_id: u64,
    initiator: Identity,
    counterparty: Identity,
    status: TradeStatus,
) -> TradeOffer {
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
        status,
        created_at_ms: NH_T0,
    }
}

fn nh_battle(player: Identity, opponent: Identity, outcome: game_core::BattleOutcome) -> Battle {
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

/// Every table the trade reducers touch, registered under each index they read.
struct NhWorld<'a> {
    players: Handle<'a, Player>,
    accounts: Handle<'a, Account>,
    offers: Handle<'a, TradeOffer, u64>,
    reapers: Handle<'a, super::TradeOfferReaperSchedule, u64>,
    monsters: Handle<'a, Monster, u64>,
    pubs: Handle<'a, MonsterPub, u64>,
    stacks: Handle<'a, Inventory>,
    wallets: Handle<'a, PlayerWallet>,
    battles: Handle<'a, Battle>,
}

/// `writable = false` leaves every table write-walled: a write reached before a
/// guard then PANICS the reducer instead of passing silently.
fn nh_world(fx: &Fixture, writable: bool) -> NhWorld<'_> {
    let offers = fx.table_keyed::<TradeOffer, u64>("trade_offer", "trade_id", |r| r.trade_id);
    let reapers = fx.table_keyed::<super::TradeOfferReaperSchedule, u64>(
        "trade_offer_reaper_schedule",
        "scheduled_id",
        |r| r.scheduled_id,
    );
    let monsters = fx.table_keyed::<Monster, u64>("monster", "monster_id", |r| r.monster_id);
    let pubs = fx.table_keyed::<MonsterPub, u64>("monster_pub", "monster_id", |r| r.monster_id);
    let stacks = fx.table::<Inventory>("inventory", "owner_identity", |r| r.owner_identity);
    let wallets = fx.table::<PlayerWallet>("player_wallet", "owner_identity", |r| r.owner_identity);
    let (offers, reapers, monsters, pubs, stacks, wallets) = if writable {
        (
            offers
                .writable()
                .unique()
                .auto_inc(|r| r.trade_id, |r, id| r.trade_id = id),
            reapers
                .writable()
                .unique()
                .auto_inc(|r| r.scheduled_id, |r, id| r.scheduled_id = id),
            monsters.writable().unique(),
            pubs.writable().unique(),
            stacks
                .writable()
                .auto_inc(|r| r.inv_id, |r, id| r.inv_id = id),
            wallets.writable().unique(),
        )
    } else {
        (offers, reapers, monsters, pubs, stacks, wallets)
    };
    let _ = fx.table::<TradeOffer>("trade_offer", "initiator", |r| r.initiator);
    let _ = fx.table::<TradeOffer>("trade_offer", "counterparty", |r| r.counterparty);
    let _ = fx.table_keyed::<super::TradeOfferReaperSchedule, u64>(
        "trade_offer_reaper_schedule",
        "trade_id",
        |r| r.trade_id,
    );
    let _ = fx
        .table_keyed::<Inventory, u64>("inventory", "inv_id", |r| r.inv_id)
        .unique();
    let battles = fx.table::<Battle>("battle", "player_identity", |r| r.player_identity);
    let _ = fx.table::<Battle>("battle", "opponent_identity", |r| r.opponent_identity);
    NhWorld {
        players: fx.table::<Player>("player", "identity", |r| r.identity),
        accounts: fx.table::<Account>("account", "identity", |r| r.identity),
        offers,
        reapers,
        monsters,
        pubs,
        stacks,
        wallets,
        battles,
    }
}

impl NhWorld<'_> {
    fn join(&self, who: Identity, online: bool) {
        self.players.seed(&Player {
            identity: who,
            entity_id: u64::from(who.to_byte_array()[0]),
            name: String::new(),
            online,
            last_input_seq: 0,
        });
    }
    fn monster(&self, id: u64, owner: Identity, party_slot: u8) {
        let m = nh_monster(id, owner, party_slot);
        self.pubs
            .seed(&crate::marshal::pub_from_monster(&m, (id % 3) as u8));
        self.monsters.seed(&m);
    }
    /// Seeded stack ids start at 1000 so the modelled auto-inc (1, 2, ...) never collides.
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
    fn reaper(&self, scheduled_id: u64, trade_id: u64) {
        self.reapers.seed(&super::TradeOfferReaperSchedule {
            scheduled_id,
            scheduled_at: ScheduleAt::Time(nh_at(NH_T0 + TRADE_OFFER_TTL)),
            trade_id,
        });
    }
    /// The whole trade-relevant store as bytes: a rejection must leave it identical.
    fn snapshot(&self) -> Vec<Vec<u8>> {
        use spacetimedb::sats::bsatn::to_vec;
        vec![
            to_vec(&self.offers.rows()).unwrap(),
            to_vec(&self.reapers.rows()).unwrap(),
            to_vec(&self.monsters.rows()).unwrap(),
            to_vec(&self.pubs.rows()).unwrap(),
            to_vec(&self.stacks.rows()).unwrap(),
            to_vec(&self.wallets.rows()).unwrap(),
        ]
    }
    fn offer_ids(&self) -> Vec<u64> {
        let mut ids: Vec<u64> = self.offers.rows().iter().map(|o| o.trade_id).collect();
        ids.sort_unstable();
        ids
    }
    fn reaper_trade_ids(&self) -> Vec<u64> {
        let mut ids: Vec<u64> = self.reapers.rows().iter().map(|r| r.trade_id).collect();
        ids.sort_unstable();
        ids
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
    fn owner_of(&self, monster_id: u64) -> (Identity, Identity) {
        let m = self
            .monsters
            .rows()
            .into_iter()
            .find(|m| m.monster_id == monster_id);
        let p = self
            .pubs
            .rows()
            .into_iter()
            .find(|m| m.monster_id == monster_id);
        (
            m.expect("monster row").owner_identity,
            p.expect("monster_pub row").owner_identity,
        )
    }
    /// (per-item totals, currency total, monster ids) summed over `parties`.
    fn totals(&self, parties: &[Identity]) -> (BTreeMap<u32, u64>, u64, Vec<u64>) {
        let mut items = BTreeMap::new();
        for s in self.stacks.rows() {
            if parties.contains(&s.owner_identity) {
                *items.entry(s.item_id).or_insert(0) += u64::from(s.count);
            }
        }
        let currency = parties.iter().map(|p| self.balance(*p)).sum();
        let mut mons: Vec<u64> = self
            .monsters
            .rows()
            .iter()
            .filter(|m| parties.contains(&m.owner_identity))
            .map(|m| m.monster_id)
            .collect();
        mons.sort_unstable();
        (items, currency, mons)
    }
}

const TRADE_OFFER_TTL: i64 = game_core::TRADE_OFFER_TTL_MS;

#[allow(clippy::too_many_arguments)]
fn nh_propose(
    ctx: &ReducerContext,
    to: Identity,
    my_mons: Vec<u64>,
    my_items: Vec<TradeItem>,
    my_cur: u64,
    their_mons: Vec<u64>,
    their_items: Vec<TradeItem>,
    their_cur: u64,
) -> Result<(), String> {
    super::propose_trade(
        ctx,
        to,
        my_mons,
        my_items,
        my_cur,
        their_mons,
        their_items,
        their_cur,
    )
}

/// Opens every table a guarded reducer WRITES (or scans) just past its escrow guard, so a
/// control call (asset not escrowed) can run to completion instead of hitting the
/// host's uncatchable write wall (a write syscall panic cannot unwind out of the
/// `extern "C"` boundary — it aborts the process).
fn nh_open_writes(fx: &Fixture) {
    use crate::pvp::BattleChallengeReaperSchedule;
    use crate::schema::BattleChallenge;
    let _ = fx
        .table_keyed::<Battle, u64>("battle", "battle_id", |r| r.battle_id)
        .writable()
        .unique()
        .auto_inc(|r| r.battle_id, |r, id| r.battle_id = id);
    let _ = fx
        .table_keyed::<BattleChallenge, u64>("battle_challenge", "challenge_id", |r| r.challenge_id)
        .writable()
        .unique()
        .auto_inc(|r| r.challenge_id, |r, id| r.challenge_id = id);
    let _ = fx
        .table_keyed::<BattleChallengeReaperSchedule, u64>(
            "battle_challenge_reaper_schedule",
            "scheduled_id",
            |r| r.scheduled_id,
        )
        .writable()
        .unique()
        .auto_inc(|r| r.scheduled_id, |r, id| r.scheduled_id = id);
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
}

/// A control call's result must be anything but the escrow refusal `refusal`.
fn nh_past_guard(label: &str, refusal: &str, got: Result<(), String>) -> Result<(), String> {
    assert_ne!(
        got,
        Err(refusal.to_string()),
        "{label}: the control (asset NOT escrowed) was refused as escrowed — the guard is \
         not keyed on the escrowed asset"
    );
    got
}

/// a valid proposal inserts exactly one Pending offer stamped with the transaction clock,
/// carrying display cards built from the LIVE rows (no genes — `MonsterCard` has no such
/// fields), arms exactly one reaper at created + TTL, and moves no asset (escrow is
/// guard-in-place).
/// kills: propose_trade -> Ok(()), schedule_trade_reaper -> (), build_cards -> Ok(vec![]).
#[test]
fn nh_trade_propose_inserts_offer_with_live_cards_and_arms_reaper() {
    let fx = fixture();
    let w = nh_world(&fx, true);
    w.join(nh_a(), true);
    w.join(nh_b(), true);
    w.monster(11, nh_a(), 0);
    w.monster(21, nh_b(), 1);
    w.stack(nh_a(), 5, 10);
    w.stack(nh_b(), 6, 4);
    w.wallet(nh_a(), 500);
    w.wallet(nh_b(), 300);
    let assets_before = w.snapshot()[2..].to_vec();

    let got = fx.run_as_at(nh_a(), nh_at(NH_T0), |ctx| {
        nh_propose(
            ctx,
            nh_b(),
            vec![11],
            vec![nh_item(5, 3)],
            100,
            vec![21],
            vec![nh_item(6, 2)],
            50,
        )
    });
    assert_eq!(got, Ok(()), "indexes asked: {:?}", fx.requested_indexes());

    let offers = w.offers.rows();
    assert_eq!(offers.len(), 1, "exactly one offer row");
    let o = &offers[0];
    let card = |id: u64| make_monster_card(id, 1, format!("m{id}"), 7, 33, 40);
    assert_eq!(
        (
            o.initiator,
            o.counterparty,
            o.status.clone(),
            o.created_at_ms
        ),
        (nh_a(), nh_b(), TradeStatus::Pending, NH_T0)
    );
    assert_eq!(
        (
            o.initiator_monster_ids.clone(),
            o.counterparty_monster_ids.clone()
        ),
        (vec![11], vec![21])
    );
    assert_eq!(
        (o.initiator_items.clone(), o.counterparty_items.clone()),
        (vec![nh_item(5, 3)], vec![nh_item(6, 2)])
    );
    assert_eq!((o.initiator_currency, o.counterparty_currency), (100, 50));
    assert_eq!(
        (o.initiator_cards.clone(), o.counterparty_cards.clone()),
        (vec![card(11)], vec![card(21)]),
        "cards are built from each side's live monster rows"
    );
    let reapers = w.reapers.rows();
    assert_eq!(reapers.len(), 1, "exactly one reaper row armed");
    assert_eq!(reapers[0].trade_id, o.trade_id);
    assert_eq!(
        reapers[0].scheduled_at,
        ScheduleAt::Time(nh_at(NH_T0 + TRADE_OFFER_TTL)),
        "the reaper fires at created_at + TTL"
    );
    assert_eq!(
        w.snapshot()[2..].to_vec(),
        assets_before,
        "proposing moves no asset"
    );
}

/// Counterparty validation + self-trade + foreign monsters: each refused with no row.
/// kills: == -> != on the self-trade flag (with the success test above), build_cards != -> ==.
#[test]
fn nh_trade_propose_refuses_unjoined_phantom_self_and_foreign_monsters() {
    let fx = fixture();
    let w = nh_world(&fx, true);
    w.join(nh_a(), true);
    w.join(nh_b(), true);
    w.monster(11, nh_a(), 0);
    w.monster(21, nh_b(), 0);
    let before = w.snapshot();
    type Case = (
        &'static str,
        Identity,
        Identity,
        Vec<u64>,
        Vec<u64>,
        &'static str,
    );
    let cases: Vec<Case> = vec![
        (
            "unjoined caller",
            nh_c(),
            nh_a(),
            vec![],
            vec![11],
            "not joined",
        ),
        (
            "phantom counterparty",
            nh_a(),
            nh_c(),
            vec![11],
            vec![],
            "counterparty is not a joined player",
        ),
        (
            "self trade",
            nh_a(),
            nh_a(),
            vec![11],
            vec![],
            "cannot trade with yourself",
        ),
        (
            "offers counterparty's monster",
            nh_a(),
            nh_b(),
            vec![21],
            vec![],
            "monster 21 not owned by caller",
        ),
        (
            "asks for its own monster",
            nh_a(),
            nh_b(),
            vec![],
            vec![11],
            "monster 11 not owned by caller",
        ),
        (
            "missing monster",
            nh_a(),
            nh_b(),
            vec![77],
            vec![],
            "monster 77 not found",
        ),
    ];
    for (label, caller, to, mine, theirs, want) in cases {
        let got = fx.run_as(caller, |ctx| {
            nh_propose(ctx, to, mine, vec![], 0, theirs, vec![], 0)
        });
        assert_eq!(got, Err(want.to_string()), "{label}");
        assert_eq!(
            w.snapshot(),
            before,
            "{label}: a refused proposal writes nothing"
        );
    }
}

/// Escrow headroom at propose: listed currency/items are bounded by holdings on BOTH
/// sides — one over refuses, exactly-at succeeds; an item the party does not hold at
/// all refuses even when it holds a different stack.
/// kills: every > -> ==/</>= at the four balance/inventory comparisons, the > 0 -> ==/<
/// currency pre-checks, and == -> != in both inventory lookups.
#[test]
fn nh_trade_propose_bounds_listed_assets_by_holdings() {
    let fx = fixture();
    let w = nh_world(&fx, true);
    w.join(nh_a(), true);
    w.join(nh_b(), true);
    w.wallet(nh_a(), 100);
    w.wallet(nh_b(), 60);
    w.stack(nh_a(), 5, 10);
    w.stack(nh_b(), 6, 4);
    let before = w.snapshot();
    type Case = (
        &'static str,
        Vec<TradeItem>,
        u64,
        Vec<TradeItem>,
        u64,
        String,
    );
    let cases: Vec<Case> = vec![
        (
            "initiator currency +1",
            vec![],
            101,
            vec![],
            0,
            "insufficient currency for trade offer".into(),
        ),
        (
            "counterparty currency +1",
            vec![],
            0,
            vec![],
            61,
            "counterparty has insufficient currency for this trade".into(),
        ),
        (
            "initiator item +1",
            vec![nh_item(5, 11)],
            0,
            vec![],
            0,
            "insufficient inventory for item 5".into(),
        ),
        (
            "counterparty item +1",
            vec![],
            0,
            vec![nh_item(6, 5)],
            0,
            "counterparty has insufficient inventory for item 6".into(),
        ),
        (
            "initiator item never held",
            vec![nh_item(7, 1)],
            0,
            vec![],
            0,
            "insufficient inventory for item 7".into(),
        ),
        (
            "counterparty item never held",
            vec![],
            0,
            vec![nh_item(8, 1)],
            0,
            "counterparty has insufficient inventory for item 8".into(),
        ),
    ];
    for (label, mine, my_cur, theirs, their_cur, want) in cases {
        let got = fx.run_as(nh_a(), |ctx| {
            nh_propose(ctx, nh_b(), vec![], mine, my_cur, vec![], theirs, their_cur)
        });
        assert_eq!(got, Err(want), "{label}");
        assert_eq!(w.snapshot(), before, "{label}: nothing written");
    }
    let got = fx.run_as(nh_a(), |ctx| {
        nh_propose(
            ctx,
            nh_b(),
            vec![],
            vec![nh_item(5, 10)],
            100,
            vec![],
            vec![nh_item(6, 4)],
            60,
        )
    });
    assert_eq!(
        got,
        Ok(()),
        "listing exactly everything both sides hold is legal"
    );
    assert_eq!(w.offer_ids().len(), 1);
}

/// ST-trading_tests#conservation: a monster in an ONGOING battle cannot be offered,
/// found through either battle index (PvE/PvP side A as player, PvP side B as
/// opponent) and on either side of the trade; a FINISHED battle does not block.
#[test]
fn nh_trade_propose_refuses_monsters_in_an_ongoing_battle() {
    use game_core::BattleOutcome::{Ongoing, SideAWins};
    let cases: Vec<(&str, Battle)> = vec![
        (
            "initiator as player",
            Battle {
                party_monster_ids: vec![11],
                ..nh_battle(nh_a(), crate::WILD_IDENTITY, Ongoing)
            },
        ),
        (
            "initiator as PvP side B",
            Battle {
                opponent_monster_ids: vec![11],
                ..nh_battle(nh_c(), nh_a(), Ongoing)
            },
        ),
        (
            "counterparty as player",
            Battle {
                party_monster_ids: vec![21],
                ..nh_battle(nh_b(), crate::WILD_IDENTITY, Ongoing)
            },
        ),
        (
            "counterparty as PvP side B",
            Battle {
                opponent_monster_ids: vec![21],
                ..nh_battle(nh_c(), nh_b(), Ongoing)
            },
        ),
    ];
    for (label, battle) in cases {
        let fx = fixture();
        let w = nh_world(&fx, true);
        w.join(nh_a(), true);
        w.join(nh_b(), true);
        w.monster(11, nh_a(), 0);
        w.monster(21, nh_b(), 0);
        w.battles.seed(&battle);
        let before = w.snapshot();
        let got = fx.run_as(nh_a(), |ctx| {
            nh_propose(ctx, nh_b(), vec![11], vec![], 0, vec![21], vec![], 0)
        });
        assert_eq!(
            got,
            Err("monster is in an ongoing battle".to_string()),
            "{label}"
        );
        assert_eq!(w.snapshot(), before, "{label}: nothing written");
    }
    let fx = fixture();
    let w = nh_world(&fx, true);
    w.join(nh_a(), true);
    w.join(nh_b(), true);
    w.monster(11, nh_a(), 0);
    w.monster(21, nh_b(), 0);
    w.battles.seed(&Battle {
        party_monster_ids: vec![11],
        ..nh_battle(nh_a(), crate::WILD_IDENTITY, SideAWins)
    });
    let got = fx.run_as(nh_a(), |ctx| {
        nh_propose(ctx, nh_b(), vec![11], vec![], 0, vec![21], vec![], 0)
    });
    assert_eq!(got, Ok(()), "a finished battle does not block the trade");
}

/// TR-20 one-active-offer rule (an active offer in EITHER column blocks EITHER party)
/// and the ADR-0227 deletion gate on OPENING a trade, keyed on the caller only.
/// kills: has_active_trade -> false, || -> && in has_active_trade.
#[test]
fn nh_trade_propose_refuses_busy_parties_and_a_deletion_gated_caller() {
    let busy: Vec<(&str, TradeOffer)> = vec![
        (
            "caller already initiates",
            nh_offer(100, nh_a(), nh_c(), TradeStatus::Pending),
        ),
        (
            "caller already addressed",
            nh_offer(100, nh_c(), nh_a(), TradeStatus::ConfirmedByCounterparty),
        ),
        (
            "counterparty already initiates",
            nh_offer(100, nh_b(), nh_c(), TradeStatus::Pending),
        ),
        (
            "counterparty already addressed",
            nh_offer(100, nh_c(), nh_b(), TradeStatus::Pending),
        ),
    ];
    for (label, offer) in busy {
        let fx = fixture();
        let w = nh_world(&fx, true);
        w.join(nh_a(), true);
        w.join(nh_b(), true);
        w.wallet(nh_a(), 10);
        w.offers.seed(&offer);
        let before = w.snapshot();
        let got = fx.run_as(nh_a(), |ctx| {
            nh_propose(ctx, nh_b(), vec![], vec![], 5, vec![], vec![], 0)
        });
        assert_eq!(got, Err(TradeError::AlreadyInTrade.to_string()), "{label}");
        assert_eq!(w.snapshot(), before, "{label}: nothing written");
    }

    let fx = fixture();
    let w = nh_world(&fx, true);
    w.join(nh_a(), true);
    w.join(nh_b(), true);
    w.wallet(nh_a(), 10);
    // A deleting STRANGER must not gate the caller (caller-keyed, not table-keyed).
    rb47_seed_deleting_stranger(&w.accounts, RB47_REQUESTED_AT_MS);
    w.accounts.seed(&crate::accounts::requested_deletion(
        crate::accounts::new_account_row(nh_a(), "nh-issuer".to_string(), 1),
        NH_T0 - 1,
    ));
    let before = w.snapshot();
    let got = fx.run_as_at(nh_a(), nh_at(NH_T0), |ctx| {
        nh_propose(ctx, nh_b(), vec![], vec![], 5, vec![], vec![], 0)
    });
    assert_eq!(got, Err(crate::guards::REJECT_DELETION_GATED.to_string()));
    assert_eq!(
        w.snapshot(),
        before,
        "a deletion-gated caller opens nothing"
    );
    assert_eq!(w.accounts.remove(nh_a()), 1);
    let got = fx.run_as_at(nh_a(), nh_at(NH_T0), |ctx| {
        nh_propose(ctx, nh_b(), vec![], vec![], 5, vec![], vec![], 0)
    });
    assert_eq!(got, Ok(()), "only the stranger is deleting now");
}

/// respond_trade: only the counterparty may answer, only a Pending offer; a decline
/// deletes THAT offer and disarms THAT reaper; an accept advances the status in place.
/// kills: respond_trade -> Ok(()), == -> != on the role check, delete ! on `accepted`.
#[test]
fn nh_trade_respond_is_counterparty_only_decline_deletes_accept_advances() {
    let fx = fixture();
    let w = nh_world(&fx, true);
    w.offers
        .seed(&nh_offer(100, nh_a(), nh_b(), TradeStatus::Pending));
    w.offers
        .seed(&nh_offer(101, nh_a(), nh_b(), TradeStatus::Pending));
    w.reaper(500, 100);
    w.reaper(501, 101);
    let before = w.snapshot();
    for (label, who) in [("stranger", nh_c()), ("initiator", nh_a())] {
        for accepted in [true, false] {
            let got = fx.run_as(who, |ctx| super::respond_trade(ctx, 100, accepted));
            assert!(
                got.is_err(),
                "{label} (accepted={accepted}) must be refused"
            );
            assert_eq!(w.snapshot(), before, "{label}: nothing written");
        }
    }
    assert_eq!(
        fx.run_as(nh_b(), |ctx| super::respond_trade(ctx, 999, true)),
        Err("trade offer not found".to_string())
    );

    assert_eq!(
        fx.run_as(nh_b(), |ctx| super::respond_trade(ctx, 100, true)),
        Ok(())
    );
    let status_of = |id: u64| {
        w.offers
            .rows()
            .into_iter()
            .find(|o| o.trade_id == id)
            .map(|o| o.status)
    };
    assert_eq!(status_of(100), Some(TradeStatus::ConfirmedByCounterparty));
    assert_eq!(
        w.reaper_trade_ids(),
        vec![100, 101],
        "an accept keeps the reaper armed"
    );
    let again = fx.run_as(nh_b(), |ctx| super::respond_trade(ctx, 100, true));
    assert!(
        again.is_err(),
        "a non-Pending offer cannot be answered again"
    );

    assert_eq!(
        fx.run_as(nh_b(), |ctx| super::respond_trade(ctx, 101, false)),
        Ok(())
    );
    assert_eq!(
        w.offer_ids(),
        vec![100],
        "the decline deletes exactly offer 101"
    );
    assert_eq!(
        w.reaper_trade_ids(),
        vec![100],
        "and disarms exactly its reaper"
    );
}

/// confirm_trade authorization: only the initiator, only after the counterparty
/// accepted. kills: == -> != on the initiator role check.
#[test]
fn nh_trade_confirm_is_initiator_only_after_acceptance() {
    let fx = fixture();
    let w = nh_world(&fx, true);
    w.monster(11, nh_a(), 0);
    w.offers.seed(&TradeOffer {
        initiator_monster_ids: vec![11],
        ..nh_offer(100, nh_a(), nh_b(), TradeStatus::ConfirmedByCounterparty)
    });
    w.offers.seed(&TradeOffer {
        initiator_monster_ids: vec![11],
        ..nh_offer(101, nh_a(), nh_c(), TradeStatus::Pending)
    });
    let before = w.snapshot();
    for (label, who, id) in [
        ("stranger", nh_c(), 100),
        ("counterparty", nh_b(), 100),
        ("initiator on Pending", nh_a(), 101),
    ] {
        let got = fx.run_as(who, |ctx| super::confirm_trade(ctx, id));
        assert!(got.is_err(), "{label} must be refused");
        assert_eq!(w.snapshot(), before, "{label}: nothing written");
    }
    assert_eq!(
        fx.run_as(nh_a(), |ctx| super::confirm_trade(ctx, 100)),
        Ok(())
    );
    assert_eq!(w.owner_of(11), (nh_b(), nh_b()));
}

/// EV-trade-conservation: the SUCCESS path is a conserving swap. Across both parties
/// the multiset of monsters, the per-item totals and the currency total are identical
/// before and after; each asset lands on the other side; monster and monster_pub agree
/// on the new owner and are unslotted; genes and tier are untouched; a fully-traded
/// stack disappears; the offer and ONLY its reaper row are gone; a bystander is untouched.
/// kills: confirm_trade -> Ok(()), == -> != on either live-owner check or on the
/// transfer direction, disarm_trade_reaper -> ().
#[test]
fn nh_trade_confirm_swaps_every_asset_and_conserves_every_total() {
    let fx = fixture();
    let w = nh_world(&fx, true);
    w.monster(11, nh_a(), 0);
    w.monster(12, nh_a(), 2);
    w.monster(21, nh_b(), 1);
    w.monster(31, nh_c(), 0);
    w.stack(nh_a(), 5, 10);
    w.stack(nh_a(), 6, 3);
    w.stack(nh_b(), 5, 7);
    w.stack(nh_b(), 8, 2);
    w.stack(nh_c(), 5, 1);
    w.wallet(nh_a(), 500);
    w.wallet(nh_b(), 300);
    w.wallet(nh_c(), 1000);
    w.offers.seed(&TradeOffer {
        initiator_monster_ids: vec![11, 12],
        initiator_items: vec![nh_item(5, 4), nh_item(6, 3)],
        initiator_currency: 120,
        counterparty_monster_ids: vec![21],
        counterparty_items: vec![nh_item(5, 2), nh_item(8, 2)],
        counterparty_currency: 45,
        ..nh_offer(100, nh_a(), nh_b(), TradeStatus::ConfirmedByCounterparty)
    });
    w.offers
        .seed(&nh_offer(101, nh_c(), nh_c(), TradeStatus::Pending));
    w.reaper(500, 100);
    w.reaper(501, 101);
    let totals_before = w.totals(&[nh_a(), nh_b()]);
    let genes_before: Vec<Monster> = w.monsters.rows();
    let tiers_before: Vec<(u64, u8)> = w
        .pubs
        .rows()
        .iter()
        .map(|p| (p.monster_id, p.tier))
        .collect();

    let got = fx.run_as(nh_a(), |ctx| super::confirm_trade(ctx, 100));
    assert_eq!(got, Ok(()), "indexes asked: {:?}", fx.requested_indexes());

    assert_eq!(
        w.totals(&[nh_a(), nh_b()]),
        totals_before,
        "nothing created or destroyed"
    );
    for (id, owner) in [(11, nh_b()), (12, nh_b()), (21, nh_a()), (31, nh_c())] {
        assert_eq!(
            w.owner_of(id),
            (owner, owner),
            "monster {id}: private row and projection agree"
        );
    }
    for m in w.monsters.rows() {
        let old = genes_before
            .iter()
            .find(|o| o.monster_id == m.monster_id)
            .unwrap();
        let moved = m.monster_id != 31;
        let expect = Monster {
            owner_identity: m.owner_identity,
            party_slot: if moved {
                crate::PARTY_SLOT_NONE
            } else {
                old.party_slot
            },
            ..nh_monster(m.monster_id, old.owner_identity, old.party_slot)
        };
        assert_eq!(
            spacetimedb::sats::bsatn::to_vec(&m).unwrap(),
            spacetimedb::sats::bsatn::to_vec(&expect).unwrap(),
            "monster {}: only owner + slot may change",
            m.monster_id
        );
    }
    for p in w.pubs.rows() {
        let moved = p.monster_id != 31;
        if moved {
            assert_eq!(
                p.party_slot,
                crate::PARTY_SLOT_NONE,
                "pub {} unslotted",
                p.monster_id
            );
        }
        assert!(
            tiers_before.contains(&(p.monster_id, p.tier)),
            "pub {} keeps its tier",
            p.monster_id
        );
    }
    assert_eq!(
        [
            (5, w.count(nh_a(), 5)),
            (6, w.count(nh_a(), 6)),
            (8, w.count(nh_a(), 8))
        ],
        [(5, 8), (6, 0), (8, 2)],
        "initiator: 10-4+2 of item 5, all of 6 given, 2 of 8 received"
    );
    assert_eq!(
        [
            (5, w.count(nh_b(), 5)),
            (6, w.count(nh_b(), 6)),
            (8, w.count(nh_b(), 8))
        ],
        [(5, 9), (6, 3), (8, 0)]
    );
    assert!(
        !w.stacks.rows().iter().any(|s| s.count == 0),
        "a fully traded stack is deleted, not left at zero"
    );
    // EV-inventory-single-stack: B's received item 5 merges into B's existing stack
    // and A's received item 8 opens one — never a second row for the same pair.
    let mut pairs: Vec<_> = w
        .stacks
        .rows()
        .iter()
        .map(|s| (s.owner_identity, s.item_id))
        .collect();
    let total = pairs.len();
    pairs.sort_unstable();
    pairs.dedup();
    assert_eq!(
        pairs.len(),
        total,
        "one inventory row per (owner, item) after the swap"
    );
    assert_eq!((w.balance(nh_a()), w.balance(nh_b())), (425, 375));
    assert_eq!(
        (w.count(nh_c(), 5), w.balance(nh_c())),
        (1, 1000),
        "bystander untouched"
    );
    assert_eq!(w.offer_ids(), vec![101], "the confirmed offer is deleted");
    assert_eq!(
        w.reaper_trade_ids(),
        vec![101],
        "and exactly its reaper is disarmed"
    );
}

/// TR-15 live re-read: confirm refuses, before any write, when an offered monster
/// changed hands or vanished after acceptance, or entered an ongoing battle (either
/// index). kills: == -> != on either live-owner check (as the refusal half).
#[test]
fn nh_trade_confirm_refuses_stale_ownership_and_battles_before_writing() {
    use game_core::BattleOutcome::Ongoing;
    type Tweak = fn(&NhWorld<'_>);
    let cases: Vec<(&str, Tweak, &str)> = vec![
        (
            "initiator's monster moved",
            |w| {
                w.monsters.remove(11);
                w.monsters.seed(&nh_monster(11, nh_c(), 0));
            },
            "ownership",
        ),
        (
            "counterparty's monster moved",
            |w| {
                w.monsters.remove(21);
                w.monsters.seed(&nh_monster(21, nh_c(), 0));
            },
            "ownership",
        ),
        (
            "initiator's monster gone",
            |w| {
                w.monsters.remove(11);
            },
            "monster 11 not found during swap",
        ),
        (
            "counterparty's monster in battle as side B",
            |w| {
                w.battles.seed(&Battle {
                    opponent_monster_ids: vec![21],
                    ..nh_battle(nh_c(), nh_b(), Ongoing)
                })
            },
            "monster is in an ongoing battle",
        ),
        (
            "initiator's monster in battle",
            |w| {
                w.battles.seed(&Battle {
                    party_monster_ids: vec![11],
                    ..nh_battle(nh_a(), crate::WILD_IDENTITY, Ongoing)
                })
            },
            "monster is in an ongoing battle",
        ),
    ];
    for (label, tweak, want) in cases {
        let fx = fixture();
        let w = nh_world(&fx, true);
        w.monster(11, nh_a(), 0);
        w.monster(21, nh_b(), 0);
        w.offers.seed(&TradeOffer {
            initiator_monster_ids: vec![11],
            counterparty_monster_ids: vec![21],
            ..nh_offer(100, nh_a(), nh_b(), TradeStatus::ConfirmedByCounterparty)
        });
        tweak(&w);
        let before = w.snapshot();
        let got = fx.run_as(nh_a(), |ctx| super::confirm_trade(ctx, 100));
        let err = got.expect_err(label);
        if want == "ownership" {
            assert_eq!(err, TradeError::OwnershipChanged.to_string(), "{label}");
        } else {
            assert_eq!(err, want, "{label}");
        }
        assert_eq!(w.snapshot(), before, "{label}: refused before any write");
    }
}

/// ADR-0113 reject-not-clamp headroom, netted per ADR-0123: a credit that would push a
/// receiver's stack past MAX_ITEM_STACK (or balance past MAX_BALANCE) refuses with the
/// store untouched, on BOTH sides; a same-item swap whose NET lands under the cap
/// succeeds exactly. The decoy stack of item 9 is what makes a wrong-row lookup visible.
/// kills: == -> != in all four headroom lookups (raw count + sending qty, both sides).
#[test]
fn nh_trade_confirm_headroom_rejects_overflow_and_admits_a_netted_swap() {
    use game_core::currency::MAX_BALANCE;
    use game_core::MAX_ITEM_STACK;
    struct Case {
        label: &'static str,
        a: Vec<(u32, u32)>,
        b: Vec<(u32, u32)>,
        wallets: (u64, u64),
        a_gives: (Vec<TradeItem>, u64),
        b_gives: (Vec<TradeItem>, u64),
        want: Result<(), String>,
    }
    let cap = MAX_ITEM_STACK;
    let cases = vec![
        Case {
            label: "initiator receives past the cap",
            a: vec![(5, cap - 4), (9, 1)],
            b: vec![(5, 5)],
            wallets: (0, 0),
            a_gives: (vec![], 0),
            b_gives: (vec![nh_item(5, 5)], 0),
            want: Err(TradeError::ItemStackCapExceeded { item_id: 5 }.to_string()),
        },
        Case {
            label: "counterparty receives past the cap",
            a: vec![(5, 5)],
            b: vec![(5, cap - 4), (9, 1)],
            wallets: (0, 0),
            a_gives: (vec![nh_item(5, 5)], 0),
            b_gives: (vec![], 0),
            want: Err(TradeError::ItemStackCapExceeded { item_id: 5 }.to_string()),
        },
        Case {
            label: "counterparty balance past MAX_BALANCE",
            a: vec![],
            b: vec![],
            wallets: (11, MAX_BALANCE - 10),
            a_gives: (vec![], 11),
            b_gives: (vec![], 0),
            want: Err(TradeError::CurrencyCapExceeded.to_string()),
        },
        Case {
            label: "initiator netted swap",
            a: vec![(5, cap - 9), (9, 1)],
            b: vec![(5, 20)],
            wallets: (0, 0),
            a_gives: (vec![nh_item(5, 15), nh_item(9, 1)], 0),
            b_gives: (vec![nh_item(5, 20)], 0),
            want: Ok(()),
        },
        Case {
            label: "counterparty netted swap",
            a: vec![(5, 20)],
            b: vec![(5, cap - 9), (9, 1)],
            wallets: (0, 0),
            a_gives: (vec![nh_item(5, 20)], 0),
            b_gives: (vec![nh_item(5, 15), nh_item(9, 1)], 0),
            want: Ok(()),
        },
    ];
    for c in cases {
        let fx = fixture();
        let w = nh_world(&fx, true);
        for (item, n) in &c.a {
            w.stack(nh_a(), *item, *n);
        }
        for (item, n) in &c.b {
            w.stack(nh_b(), *item, *n);
        }
        w.wallet(nh_a(), c.wallets.0);
        w.wallet(nh_b(), c.wallets.1);
        w.offers.seed(&TradeOffer {
            initiator_items: c.a_gives.0.clone(),
            initiator_currency: c.a_gives.1,
            counterparty_items: c.b_gives.0.clone(),
            counterparty_currency: c.b_gives.1,
            ..nh_offer(100, nh_a(), nh_b(), TradeStatus::ConfirmedByCounterparty)
        });
        let before = w.snapshot();
        let got = fx.run_as(nh_a(), |ctx| super::confirm_trade(ctx, 100));
        assert_eq!(got, c.want, "{}", c.label);
        if got.is_err() {
            assert_eq!(
                w.snapshot(),
                before,
                "{}: refused before any write",
                c.label
            );
        } else {
            let (near_cap, other) = if c.label.starts_with("initiator") {
                (nh_a(), nh_b())
            } else {
                (nh_b(), nh_a())
            };
            assert_eq!(
                w.count(near_cap, 5),
                cap - 9 - 15 + 20,
                "{}: exact netted credit",
                c.label
            );
            assert_eq!(w.count(other, 5), 15, "{}", c.label);
        }
    }
}

/// cancel_trade: either party may cancel an active offer (deleting it and disarming
/// its reaper); a stranger may not. kills: cancel_trade -> Ok(()), && -> || and both
/// != -> == in the party check, delete ! on the liveness check.
#[test]
fn nh_trade_cancel_is_either_party_only_and_disarms() {
    let fx = fixture();
    let w = nh_world(&fx, true);
    w.offers
        .seed(&nh_offer(100, nh_a(), nh_b(), TradeStatus::Pending));
    w.offers.seed(&nh_offer(
        101,
        nh_a(),
        nh_b(),
        TradeStatus::ConfirmedByCounterparty,
    ));
    w.reaper(500, 100);
    w.reaper(501, 101);
    let before = w.snapshot();
    for id in [100, 101] {
        let got = fx.run_as(nh_c(), |ctx| super::cancel_trade(ctx, id));
        assert_eq!(got, Err("not a party to this trade".to_string()));
        assert_eq!(w.snapshot(), before, "a stranger cancels nothing");
    }
    assert_eq!(
        fx.run_as(nh_a(), |ctx| super::cancel_trade(ctx, 100)),
        Ok(()),
        "the initiator cancels"
    );
    assert_eq!(
        (w.offer_ids(), w.reaper_trade_ids()),
        (vec![101], vec![101])
    );
    assert_eq!(
        fx.run_as(nh_b(), |ctx| super::cancel_trade(ctx, 101)),
        Ok(()),
        "the counterparty cancels"
    );
    assert_eq!((w.offer_ids(), w.reaper_trade_ids()), (vec![], vec![]));
    assert_eq!(
        fx.run_as(nh_a(), |ctx| super::cancel_trade(ctx, 100)),
        Err("trade offer not found".to_string())
    );
}

/// The TTL reaper is scheduler-only (sender must be the module identity) and reaps an
/// offer only once it is stale (created + TTL, inclusive); a missing offer is a no-op.
/// kills: trade_offer_reaper -> Ok(()), != -> == on the scheduler guard, delete ! on
/// the staleness check.
#[test]
fn nh_trade_offer_reaper_is_scheduler_only_and_reaps_only_stale_offers() {
    let fx = fixture();
    let w = nh_world(&fx, true);
    let module = Identity::from_byte_array([0xDD; 32]);
    fx.set_database_identity(module);
    w.offers
        .seed(&nh_offer(100, nh_a(), nh_b(), TradeStatus::Pending));
    let args = |trade_id: u64| super::TradeOfferReaperSchedule {
        scheduled_id: 1,
        scheduled_at: ScheduleAt::Time(nh_at(NH_T0 + TRADE_OFFER_TTL)),
        trade_id,
    };
    let stale = nh_at(NH_T0 + TRADE_OFFER_TTL);
    for player in [nh_a(), nh_b(), nh_c()] {
        let got = fx.run_as_at(player, stale, |ctx| {
            super::trade_offer_reaper(ctx, args(100))
        });
        assert_eq!(got, Err("trade_offer_reaper is scheduler-only".to_string()));
        assert_eq!(
            w.offer_ids(),
            vec![100],
            "a client-sent reaper call deletes nothing"
        );
    }
    let fresh = nh_at(NH_T0 + TRADE_OFFER_TTL - 1);
    assert_eq!(
        fx.run_as_at(module, fresh, |ctx| super::trade_offer_reaper(
            ctx,
            args(100)
        )),
        Ok(())
    );
    assert_eq!(
        w.offer_ids(),
        vec![100],
        "an early fire never reaps a fresh offer"
    );
    assert_eq!(
        fx.run_as_at(module, stale, |ctx| super::trade_offer_reaper(
            ctx,
            args(100)
        )),
        Ok(())
    );
    assert_eq!(
        w.offer_ids(),
        Vec::<u64>::new(),
        "a stale offer is reaped at exactly created + TTL"
    );
    assert_eq!(
        fx.run_as_at(module, stale, |ctx| super::trade_offer_reaper(
            ctx,
            args(100)
        )),
        Ok(()),
        "already gone: no-op"
    );
}

/// EA-REAPER-02 as behaviour: every non-reducer offer-deletion site deletes exactly its
/// offers AND their reaper rows, leaving everyone else's. `erase_trade_offers` sweeps
/// BOTH columns with no liveness filter; `cancel_trades_on_disconnect` sweeps both
/// columns of active offers; `decline_offers` removes exactly the ids named.
/// kills: decline_offers -> (), erase_trade_offers -> (), cancel_trades_on_disconnect -> ().
#[test]
fn nh_trade_every_offer_deletion_site_disarms_its_reaper() {
    type Site = fn(&ReducerContext);
    let sites: Vec<(&str, Site, Vec<u64>)> = vec![
        (
            "decline_offers",
            |ctx| super::decline_offers(ctx, &[100, 102]),
            vec![101, 103],
        ),
        (
            "erase_trade_offers",
            |ctx| super::erase_trade_offers(ctx, nh_a()),
            vec![103],
        ),
        (
            "cancel_trades_on_disconnect",
            |ctx| super::cancel_trades_on_disconnect(ctx, nh_a()),
            vec![103],
        ),
    ];
    for (label, site, survivors) in sites {
        let fx = fixture();
        let w = nh_world(&fx, true);
        w.offers
            .seed(&nh_offer(100, nh_a(), nh_b(), TradeStatus::Pending));
        w.offers.seed(&nh_offer(
            101,
            nh_c(),
            nh_a(),
            TradeStatus::ConfirmedByCounterparty,
        ));
        w.offers
            .seed(&nh_offer(102, nh_b(), nh_a(), TradeStatus::Pending));
        w.offers
            .seed(&nh_offer(103, nh_b(), nh_c(), TradeStatus::Pending));
        for (sid, tid) in [(500, 100), (501, 101), (502, 102), (503, 103)] {
            w.reaper(sid, tid);
        }
        site(&fx.ctx());
        assert_eq!(w.offer_ids(), survivors, "{label}: offers left");
        assert_eq!(
            w.reaper_trade_ids(),
            survivors,
            "{label}: every deleted offer's reaper is disarmed, no other"
        );
    }
}

/// Content rows the guarded reducers read on their way to (and just past) the escrow
/// guards: two players with accounts, subject monster 11 (A, slot 0), a free partner 12
/// (A, slot 1) and 21 (B, slot 0), a species with one learnable skill, and item rows.
fn nh_escrow_seed(fx: &Fixture, w: &NhWorld<'_>) {
    use crate::schema::{SkillRow, SpeciesRow};
    for who in [nh_a(), nh_b()] {
        w.join(who, true);
        w.accounts.seed(&crate::accounts::new_account_row(
            who,
            "nh-issuer".to_string(),
            1,
        ));
    }
    w.monster(11, nh_a(), 0);
    w.monster(12, nh_a(), 1);
    w.monster(21, nh_b(), 0);
    let species = fx.table_keyed::<SpeciesRow, u32>("species_row", "id", |r| r.id);
    species.seed(&SpeciesRow {
        id: 1,
        name: "Nh".to_string(),
        base_hp: 40,
        base_attack: 20,
        base_defense: 20,
        base_speed: 20,
        base_sp_attack: 20,
        base_sp_defense: 20,
        affinity: game_core::Affinity::Fire,
        learnable_skill_ids: vec![1],
        ability: None,
        tier: 0,
    });
    let skills = fx
        .table_keyed::<SkillRow, u32>("skill_row", "id", |r| r.id)
        .scannable();
    skills.seed(&SkillRow {
        id: 1,
        name: "Nh".to_string(),
        affinity: game_core::Affinity::Fire,
        power: 40,
        accuracy: 100,
        pp: 10,
    });
    let items = fx.table_keyed::<ItemRow, u32>("item_row", "id", |r| r.id);
    for (id, recruit_bonus, train) in [(1, 150, false), (2, 0, true), (3, 0, false), (5, 0, false)]
    {
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
}

/// hand-enumerated: every call site of `reject_if_monster_in_trade` — 11 functions, 12
/// sites. For each, the subject monster escrowed in an active offer (on the initiator
/// side, then on the counterparty side, exercising both index chains) is refused with
/// the exact escrow error on a WRITE-WALLED store (a write before the guard would panic,
/// so this is refusal-before-write). Control: the same offer escrowing a DIFFERENT
/// monster lets the call run to completion (Ok) on a writable store — `evolve` alone
/// stops at the evolution-edge lookup just past its guard (no graph seeded).
/// Completeness against FUTURE reducers is the syn census in privacy_enforcement_tests,
/// not this list.
#[test]
fn nh_escrowed_monster_is_refused_by_every_guarded_reducer() {
    type Call = fn(&ReducerContext) -> Result<(), String>;
    let sites: Vec<(&str, Call)> = vec![
        ("set_nickname", |ctx| {
            crate::monster_mgmt::set_nickname(ctx, 11, "Nick".to_string())
        }),
        ("set_party_slot", |ctx| {
            crate::monster_mgmt::set_party_slot(ctx, 11, 3)
        }),
        ("care", |ctx| crate::raising::care(ctx, 11)),
        ("train", |ctx| crate::raising::train(ctx, 11, 2)),
        ("evolve", |ctx| crate::evolution::evolve(ctx, 11, 2)),
        ("essence_train", |ctx| {
            crate::raising::essence_train(ctx, 11, game_core::Affinity::Fire)
        }),
        ("consume_crystalized_essence", |ctx| {
            crate::raising::consume_crystalized_essence(ctx, 11, 5)
        }),
        ("start_battle party side", |ctx| {
            crate::battle::start_battle(ctx, ctx.sender(), vec![11], vec![12])
        }),
        ("start_battle opponent side", |ctx| {
            crate::battle::start_battle(ctx, ctx.sender(), vec![12], vec![11])
        }),
        ("challenge_pvp", |ctx| {
            crate::pvp::challenge_pvp(ctx, nh_b(), vec![11])
        }),
        ("start_pvp_battle (accept path)", |ctx| {
            crate::pvp::start_pvp_battle(ctx, ctx.sender(), vec![11], nh_b(), vec![21]).map(|_| ())
        }),
        ("begin_encounter (encounter path)", |ctx| {
            crate::battle::begin_encounter(ctx, ctx.sender(), vec![11], 1, 3, 7).map(|_| ())
        }),
    ];
    type Shape = (&'static str, fn(u64) -> TradeOffer);
    let shapes: [Shape; 3] = [
        ("initiator side", |m| TradeOffer {
            initiator_monster_ids: vec![m],
            ..nh_offer(100, nh_a(), nh_c(), TradeStatus::Pending)
        }),
        ("counterparty side", |m| TradeOffer {
            counterparty_monster_ids: vec![m],
            ..nh_offer(100, nh_c(), nh_a(), TradeStatus::ConfirmedByCounterparty)
        }),
        ("control", |_| TradeOffer {
            initiator_monster_ids: vec![99],
            ..nh_offer(100, nh_a(), nh_c(), TradeStatus::Pending)
        }),
    ];
    for (label, call) in &sites {
        for (shape, offer) in &shapes {
            let control = *shape == "control";
            let fx = fixture();
            let w = nh_world(&fx, control);
            nh_escrow_seed(&fx, &w);
            if control {
                nh_open_writes(&fx);
            }
            w.stack(nh_a(), 2, 3);
            w.stack(nh_a(), 5, 3);
            w.offers.seed(&offer(11));
            let before = w.snapshot();
            let tag = format!("{label} / {shape}");
            if control {
                let got = nh_past_guard(
                    &tag,
                    NH_ESCROW_MONSTER,
                    fx.run_as_at(nh_a(), nh_at(NH_T0), call),
                );
                // evolve's control stops at the evolution-edge lookup just past the guard
                // (fallback: no evolution graph seeded); every other site runs to Ok.
                let want = if *label == "evolve" {
                    Err("no such evolution: species 1 has no path to species 2".to_string())
                } else {
                    Ok(())
                };
                assert_eq!(
                    got, want,
                    "{tag}: the unescrowed control runs past the guard"
                );
            } else {
                let got = fx.run_as(nh_a(), call);
                assert_eq!(
                    got,
                    Err(NH_ESCROW_MONSTER.to_string()),
                    "{tag}; indexes asked: {:?}",
                    fx.requested_indexes()
                );
                assert_eq!(w.snapshot(), before, "{tag}: refused before any write");
            }
        }
    }
}

/// EV-trade-escrow-guards (item/currency half): escrowed quantities shrink what the
/// owner may spend. Each row escrows exactly the holding (refused, store untouched) and
/// then one less, which runs to Ok on a writable store. `heal_party`'s currency-escrow branch is unreachable with shipped
/// content (no heal location charges currency), so its guard rides on the
/// `escrowed_currency_amount_*` unit tests above.
#[test]
fn nh_escrowed_items_and_currency_shrink_the_spendable_headroom() {
    use game_core::BattleOutcome::Ongoing;
    const ITEM_REFUSAL: &str = "item is in an active trade";
    const CURRENCY_REFUSAL: &str = "currency is in an active trade";
    let item_offer = |item: u32, qty: u32, as_counterparty: bool| {
        if as_counterparty {
            TradeOffer {
                counterparty_items: vec![nh_item(item, qty)],
                ..nh_offer(100, nh_c(), nh_a(), TradeStatus::Pending)
            }
        } else {
            TradeOffer {
                initiator_items: vec![nh_item(item, qty)],
                ..nh_offer(100, nh_a(), nh_c(), TradeStatus::Pending)
            }
        }
    };
    let seed_battle = |fx: &Fixture, w: &NhWorld<'_>| {
        let mut b = nh_battle(nh_a(), crate::WILD_IDENTITY, Ongoing);
        b.state.side_a.team[0].status = Some(game_core::StatusEffect::Poison);
        b.party_monster_ids = vec![11];
        w.battles.seed(&b);
        let _ = fx.table_keyed::<Battle, u64>("battle", "battle_id", |r| r.battle_id);
        fx.table_keyed::<crate::schema::BattleWild, u64>("battle_wild", "battle_id", |r| {
            r.battle_id
        })
        .seed(&crate::schema::BattleWild {
            battle_id: 900,
            wild_species_id: 1,
            wild_level: 3,
            individuality_seed: 7,
        });
    };

    // sell: 5 held, 3 escrowed (A as counterparty) -> selling 3 refused, 2 sold.
    {
        let fx = fixture();
        let w = nh_world(&fx, true);
        nh_escrow_seed(&fx, &w);
        w.stack(nh_a(), 5, 5);
        w.wallet(nh_a(), 0);
        w.offers.seed(&item_offer(5, 3, true));
        let before = w.snapshot();
        assert_eq!(
            fx.run_as(nh_a(), |ctx| crate::economy::sell(ctx, 5, 3)),
            Err(ITEM_REFUSAL.to_string())
        );
        assert_eq!(w.snapshot(), before, "sell: refused before any write");
        assert_eq!(
            fx.run_as(nh_a(), |ctx| crate::economy::sell(ctx, 5, 2)),
            Ok(())
        );
        assert_eq!(
            (w.count(nh_a(), 5), w.balance(nh_a())),
            (3, 20),
            "sell: 2 sold at 10"
        );
    }
    // buy: 100 held, 80 escrowed -> a 30 purchase refused, a 20 purchase made.
    {
        let fx = fixture();
        let w = nh_world(&fx, true);
        nh_escrow_seed(&fx, &w);
        w.wallet(nh_a(), 100);
        fx.table_keyed::<crate::schema::ShopItemRow, u32>("shop_item_row", "shop_id", |r| {
            r.shop_id
        })
        .seed(&crate::schema::ShopItemRow {
            shop_item_id: 1,
            shop_id: 3,
            item_id: 5,
            buy_price: 10,
        });
        w.offers.seed(&TradeOffer {
            initiator_currency: 80,
            ..nh_offer(100, nh_a(), nh_c(), TradeStatus::Pending)
        });
        let before = w.snapshot();
        assert_eq!(
            fx.run_as(nh_a(), |ctx| crate::economy::buy(ctx, 3, 5, 3)),
            Err(CURRENCY_REFUSAL.to_string())
        );
        assert_eq!(w.snapshot(), before, "buy: refused before any write");
        assert_eq!(
            fx.run_as(nh_a(), |ctx| crate::economy::buy(ctx, 3, 5, 2)),
            Ok(())
        );
        assert_eq!(
            (w.count(nh_a(), 5), w.balance(nh_a())),
            (2, 80),
            "buy: 2 bought at 10"
        );
    }
    // Past-guard rows on a write-walled store.
    type Call = fn(&ReducerContext) -> Result<(), String>;
    let rows: Vec<(&str, u32, u32, bool, bool, Call)> = vec![
        ("train (food)", 2, 3, true, false, |ctx| {
            crate::raising::train(ctx, 11, 2)
        }),
        ("consume_crystalized_essence", 5, 3, false, false, |ctx| {
            crate::raising::consume_crystalized_essence(ctx, 11, 5)
        }),
        ("use_battle_item", 3, 2, true, true, |ctx| {
            crate::battle::use_battle_item(ctx, 900, 3)
        }),
        ("attempt_recruit (bait)", 1, 2, false, true, |ctx| {
            crate::taming::attempt_recruit(ctx, 900, Some(1))
        }),
    ];
    for (label, item, held, as_cp, battle, call) in rows {
        for escrowed in [held, held - 1] {
            let control = escrowed != held;
            let fx = fixture();
            let w = nh_world(&fx, control);
            nh_escrow_seed(&fx, &w);
            if control {
                nh_open_writes(&fx);
            }
            if battle {
                seed_battle(&fx, &w);
            }
            w.stack(nh_a(), item, held);
            w.offers.seed(&item_offer(item, escrowed, as_cp));
            let tag = format!("{label} / {escrowed} of {held} escrowed");
            if !control {
                let before = w.snapshot();
                let got = fx.run_as(nh_a(), call);
                assert_eq!(
                    got,
                    Err(ITEM_REFUSAL.to_string()),
                    "{tag}; indexes asked: {:?}",
                    fx.requested_indexes()
                );
                assert_eq!(w.snapshot(), before, "{tag}: refused before any write");
            } else {
                let got =
                    nh_past_guard(&tag, ITEM_REFUSAL, fx.run_as_at(nh_a(), nh_at(NH_T0), call));
                assert_eq!(got, Ok(()), "{tag}: one spare unit is enough to proceed");
            }
        }
    }
}
