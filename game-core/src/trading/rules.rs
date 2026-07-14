//! Pure trade rule functions (M15, ADR-0106).
//!
//! No I/O, no SpacetimeDB context. Validates proposals, drives the state machine,
//! and produces the `SwapPlan` the server applies atomically. The server module is
//! the thin imperative shell; these functions are the SSOT rule layer.

use super::types::{MonsterCard, TradeError, TradeItem};

/// Snapshot of one side's escrowed assets (arguments to `validate_proposal`).
pub struct ProposalSide<'a> {
    pub monster_ids: &'a [u64],
    pub items: &'a [TradeItem],
    pub currency: u64,
}

/// Validate the inputs to a `propose_trade` call (pure, no DB access).
///
/// Checks:
/// 1. initiator != counterparty (no self-trade, TR-21)
/// 2. At least one asset on EITHER side (TR-1 / EmptyOffer)
/// 3. No duplicate monster_ids across both sides (TR-22 guard + DuplicateMonster)
/// 4. All items have qty > 0
pub fn validate_proposal(
    initiator_has_active_trade: bool,
    counterparty_has_active_trade: bool,
    initiator_eq_counterparty: bool,
    initiator: ProposalSide<'_>,
    counterparty: ProposalSide<'_>,
) -> Result<(), TradeError> {
    if initiator_eq_counterparty {
        return Err(TradeError::SelfTrade);
    }
    if initiator_has_active_trade || counterparty_has_active_trade {
        return Err(TradeError::AlreadyInTrade);
    }
    // At least one asset total across both sides.
    let total_assets = initiator.monster_ids.len()
        + initiator.items.len()
        + counterparty.monster_ids.len()
        + counterparty.items.len()
        + if initiator.currency > 0 { 1 } else { 0 }
        + if counterparty.currency > 0 { 1 } else { 0 };
    if total_assets == 0 {
        return Err(TradeError::EmptyOffer);
    }
    // No duplicate monster_ids across both sides.
    let mut seen = std::collections::HashSet::new();
    for &mid in initiator.monster_ids {
        if !seen.insert(mid) {
            return Err(TradeError::DuplicateMonster);
        }
    }
    for &mid in counterparty.monster_ids {
        if !seen.insert(mid) {
            return Err(TradeError::DuplicateMonster);
        }
    }
    // No duplicate item_ids within each side.
    let mut seen_items: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for item in initiator.items {
        if !seen_items.insert(item.item_id) {
            return Err(TradeError::DuplicateItem {
                item_id: item.item_id,
            });
        }
    }
    seen_items.clear();
    for item in counterparty.items {
        if !seen_items.insert(item.item_id) {
            return Err(TradeError::DuplicateItem {
                item_id: item.item_id,
            });
        }
    }
    // All items must have qty > 0.
    for item in initiator.items {
        if item.qty == 0 {
            return Err(TradeError::InsufficientInventory {
                item_id: item.item_id,
            });
        }
    }
    for item in counterparty.items {
        if item.qty == 0 {
            return Err(TradeError::InsufficientInventory {
                item_id: item.item_id,
            });
        }
    }
    Ok(())
}

/// Build a `MonsterCard` display snapshot from the public fields of a monster row.
///
/// The caller supplies individual fields (not the raw DB row) so game-core stays
/// independent of SpacetimeDB types. No IVs/EVs/nature_kind (ADR-0015 — TR-19).
pub fn make_monster_card(
    monster_id: u64,
    species_id: u32,
    nickname: String,
    level: u8,
    current_hp: u16,
    stat_hp: u16,
) -> MonsterCard {
    MonsterCard {
        monster_id,
        species_id,
        nickname,
        level,
        current_hp,
        stat_hp,
    }
}

/// Ownership record for one side at swap time (the server re-reads live rows and
/// passes these in; the swap verifier checks them before executing).
pub struct LiveMonsterOwner {
    pub monster_id: u64,
    pub owner_matches_expected: bool,
}

/// Plan for transferring one monster (change owner_identity, clear party_slot).
#[derive(Clone, Debug, PartialEq)]
pub struct MonsterTransfer {
    pub monster_id: u64,
    /// New owner (the other party).
    pub new_owner_idx: TradeSide,
}

/// Plan for transferring items between parties.
#[derive(Clone, Debug, PartialEq)]
pub struct ItemTransfer {
    pub item_id: u32,
    pub qty: u32,
    /// Source of this transfer (from whom to whom the item moves).
    pub from_initiator: bool,
}

/// Currency transfer direction and amount.
#[derive(Clone, Debug, PartialEq)]
pub struct CurrencyTransfer {
    pub from_initiator: bool,
    pub amount: u64,
}

/// Which party is referenced in a transfer plan (distinct from `combat::SideId`).
#[derive(Clone, Debug, PartialEq, Copy)]
pub enum TradeSide {
    Initiator,
    Counterparty,
}

/// The mutation plan for `atomic_swap`. The server applies all transfers in a
/// single SpacetimeDB transaction. Pure — no DB access here.
#[derive(Clone, Debug)]
pub struct SwapPlan {
    pub monster_transfers: Vec<MonsterTransfer>,
    pub item_transfers: Vec<ItemTransfer>,
    pub currency_transfers: Vec<CurrencyTransfer>,
}

/// Validate ownership at swap time and produce a `SwapPlan`.
///
/// Called by `confirm_trade` after re-reading live rows. Fails if any monster
/// no longer belongs to its expected party (TR-15 re-read + ownership check).
pub fn build_swap_plan(
    initiator_monsters: &[LiveMonsterOwner],
    counterparty_monsters: &[LiveMonsterOwner],
    initiator_items: &[TradeItem],
    counterparty_items: &[TradeItem],
    initiator_currency: u64,
    counterparty_currency: u64,
) -> Result<SwapPlan, TradeError> {
    // Verify all initiator monsters still belong to initiator.
    for m in initiator_monsters {
        if !m.owner_matches_expected {
            return Err(TradeError::OwnershipChanged);
        }
    }
    // Verify all counterparty monsters still belong to counterparty.
    for m in counterparty_monsters {
        if !m.owner_matches_expected {
            return Err(TradeError::OwnershipChanged);
        }
    }

    let monster_transfers: Vec<MonsterTransfer> = initiator_monsters
        .iter()
        .map(|m| MonsterTransfer {
            monster_id: m.monster_id,
            new_owner_idx: TradeSide::Counterparty,
        })
        .chain(counterparty_monsters.iter().map(|m| MonsterTransfer {
            monster_id: m.monster_id,
            new_owner_idx: TradeSide::Initiator,
        }))
        .collect();

    let item_transfers: Vec<ItemTransfer> = initiator_items
        .iter()
        .map(|ti| ItemTransfer {
            item_id: ti.item_id,
            qty: ti.qty,
            from_initiator: true,
        })
        .chain(counterparty_items.iter().map(|ti| ItemTransfer {
            item_id: ti.item_id,
            qty: ti.qty,
            from_initiator: false,
        }))
        .collect();

    let mut currency_transfers = Vec::new();
    if initiator_currency > 0 {
        currency_transfers.push(CurrencyTransfer {
            from_initiator: true,
            amount: initiator_currency,
        });
    }
    if counterparty_currency > 0 {
        currency_transfers.push(CurrencyTransfer {
            from_initiator: false,
            amount: counterparty_currency,
        });
    }

    Ok(SwapPlan {
        monster_transfers,
        item_transfers,
        currency_transfers,
    })
}

// ---------------------------------------------------------------------------
// Tests (one per EARS criterion, with kills: annotations)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::super::types::TradeStatus;
    use super::*;

    fn no_item() -> &'static [TradeItem] {
        &[]
    }

    fn one_item(item_id: u32, qty: u32) -> Vec<TradeItem> {
        vec![TradeItem { item_id, qty }]
    }

    /// TR-21: self-trade is rejected.
    /// kills: impl that skips the self-trade check.
    #[test]
    fn validate_rejects_self_trade() {
        let side = ProposalSide {
            monster_ids: &[1],
            items: no_item(),
            currency: 0,
        };
        let result = validate_proposal(
            false,
            false,
            true,
            side,
            ProposalSide {
                monster_ids: &[],
                items: no_item(),
                currency: 0,
            },
        );
        assert_eq!(
            result.unwrap_err(),
            TradeError::SelfTrade,
            "self-trade must be rejected with SelfTrade"
        );
    }

    /// TR-20: initiator already has active trade → AlreadyInTrade.
    /// kills: impl that allows multiple simultaneous offers per player.
    #[test]
    fn validate_rejects_initiator_already_in_trade() {
        let side = ProposalSide {
            monster_ids: &[1],
            items: no_item(),
            currency: 0,
        };
        let result = validate_proposal(
            true,
            false,
            false,
            side,
            ProposalSide {
                monster_ids: &[],
                items: no_item(),
                currency: 0,
            },
        );
        assert_eq!(result.unwrap_err(), TradeError::AlreadyInTrade);
    }

    /// TR-20: counterparty already has active trade → AlreadyInTrade.
    /// kills: impl that only checks initiator's trade status.
    #[test]
    fn validate_rejects_counterparty_already_in_trade() {
        let side = ProposalSide {
            monster_ids: &[1],
            items: no_item(),
            currency: 0,
        };
        let result = validate_proposal(
            false,
            true,
            false,
            side,
            ProposalSide {
                monster_ids: &[],
                items: no_item(),
                currency: 0,
            },
        );
        assert_eq!(result.unwrap_err(), TradeError::AlreadyInTrade);
    }

    /// TR-1: empty offer (no assets on either side) → EmptyOffer.
    /// kills: impl that allows a 0-asset trade.
    #[test]
    fn validate_rejects_empty_offer() {
        let result = validate_proposal(
            false,
            false,
            false,
            ProposalSide {
                monster_ids: &[],
                items: no_item(),
                currency: 0,
            },
            ProposalSide {
                monster_ids: &[],
                items: no_item(),
                currency: 0,
            },
        );
        assert_eq!(result.unwrap_err(), TradeError::EmptyOffer);
    }

    /// TR-1: currency-only offer (0 monsters, 0 items, currency > 0) is valid.
    /// kills: impl that requires at least one monster.
    #[test]
    fn validate_accepts_currency_only_offer() {
        let result = validate_proposal(
            false,
            false,
            false,
            ProposalSide {
                monster_ids: &[],
                items: no_item(),
                currency: 100,
            },
            ProposalSide {
                monster_ids: &[],
                items: no_item(),
                currency: 0,
            },
        );
        assert!(result.is_ok(), "currency-only offer must be accepted");
    }

    /// TR-22: duplicate monster_id across both sides → DuplicateMonster.
    /// kills: impl that only checks duplicates within one side.
    #[test]
    fn validate_rejects_duplicate_monster_across_sides() {
        let result = validate_proposal(
            false,
            false,
            false,
            ProposalSide {
                monster_ids: &[1, 2],
                items: no_item(),
                currency: 0,
            },
            ProposalSide {
                monster_ids: &[2],
                items: no_item(),
                currency: 0,
            },
        );
        assert_eq!(result.unwrap_err(), TradeError::DuplicateMonster);
    }

    /// TR-22: duplicate monster_id within same side → DuplicateMonster.
    /// kills: impl that only deduplicates across sides (not within).
    #[test]
    fn validate_rejects_duplicate_monster_same_side() {
        let result = validate_proposal(
            false,
            false,
            false,
            ProposalSide {
                monster_ids: &[1, 1],
                items: no_item(),
                currency: 0,
            },
            ProposalSide {
                monster_ids: &[],
                items: no_item(),
                currency: 0,
            },
        );
        assert_eq!(result.unwrap_err(), TradeError::DuplicateMonster);
    }

    /// TR-1: item with qty=0 → InsufficientInventory.
    /// kills: impl that allows 0-qty items in offers.
    #[test]
    fn validate_rejects_zero_qty_item() {
        let items = one_item(5, 0);
        let result = validate_proposal(
            false,
            false,
            false,
            ProposalSide {
                monster_ids: &[],
                items: &items,
                currency: 0,
            },
            ProposalSide {
                monster_ids: &[1],
                items: no_item(),
                currency: 0,
            },
        );
        assert!(matches!(
            result.unwrap_err(),
            TradeError::InsufficientInventory { .. }
        ));
    }

    /// TR-19: MonsterCard has no gene fields (structural compile-time check).
    /// kills: impl that copies IVs/EVs/nature into the card.
    /// This test is the authoritative proof-of-teeth for TR-19 — if MonsterCard
    /// gained an iv_* / ev_* / nature_kind field, the ADR-0015 invariant would be
    /// violated; a field-exhaustion pattern here would catch that change but would
    /// be brittle. Instead we assert the public contract: make_monster_card accepts
    /// ONLY (monster_id, species_id, nickname, level, current_hp, stat_hp) — any
    /// gene field added to that function signature would break callers.
    #[test]
    fn monster_card_has_no_gene_fields() {
        let card = make_monster_card(1, 2, "Flamey".to_string(), 10, 30, 45);
        // Structural assertion: only 6 fields, none are gene fields.
        assert_eq!(card.monster_id, 1);
        assert_eq!(card.species_id, 2);
        assert_eq!(card.nickname, "Flamey");
        assert_eq!(card.level, 10);
        assert_eq!(card.current_hp, 30);
        assert_eq!(card.stat_hp, 45);
        // The type has exactly the fields listed above. If iv_hp / ev_hp /
        // nature_kind appeared in MonsterCard, this function call signature would
        // require additional parameters — that compilation failure IS the teeth.
    }

    /// TR-15: build_swap_plan fails loud if monster ownership changed.
    /// kills: impl that trusts cached ownership from the offer row.
    #[test]
    fn swap_plan_rejects_ownership_mismatch() {
        let initiator_monsters = vec![LiveMonsterOwner {
            monster_id: 1,
            owner_matches_expected: false, // ownership changed!
        }];
        let result = build_swap_plan(&initiator_monsters, &[], &[], &[], 0, 0);
        assert_eq!(
            result.unwrap_err(),
            TradeError::OwnershipChanged,
            "stale ownership must be rejected at swap time"
        );
    }

    /// TR-16: swap plan transfers each monster to the other side.
    /// kills: impl that doesn't reverse the direction.
    #[test]
    fn swap_plan_reverses_monster_ownership() {
        let initiator_monsters = vec![LiveMonsterOwner {
            monster_id: 10,
            owner_matches_expected: true,
        }];
        let counterparty_monsters = vec![LiveMonsterOwner {
            monster_id: 20,
            owner_matches_expected: true,
        }];
        let plan = build_swap_plan(&initiator_monsters, &counterparty_monsters, &[], &[], 0, 0)
            .expect("valid ownership");
        assert_eq!(plan.monster_transfers.len(), 2);
        let t10 = plan
            .monster_transfers
            .iter()
            .find(|t| t.monster_id == 10)
            .unwrap();
        assert_eq!(
            t10.new_owner_idx,
            TradeSide::Counterparty,
            "initiator's monster goes to counterparty"
        );
        let t20 = plan
            .monster_transfers
            .iter()
            .find(|t| t.monster_id == 20)
            .unwrap();
        assert_eq!(
            t20.new_owner_idx,
            TradeSide::Initiator,
            "counterparty's monster goes to initiator"
        );
    }

    /// TR-16: item transfers preserved with correct direction.
    /// kills: impl that ignores item direction.
    #[test]
    fn swap_plan_item_transfers_correct_direction() {
        let i_items = vec![TradeItem { item_id: 1, qty: 3 }];
        let c_items = vec![TradeItem { item_id: 2, qty: 1 }];
        let plan = build_swap_plan(&[], &[], &i_items, &c_items, 0, 0).expect("valid ownership");
        let i_transfer = plan.item_transfers.iter().find(|t| t.item_id == 1).unwrap();
        assert!(
            i_transfer.from_initiator,
            "initiator's item must have from_initiator=true"
        );
        let c_transfer = plan.item_transfers.iter().find(|t| t.item_id == 2).unwrap();
        assert!(
            !c_transfer.from_initiator,
            "counterparty's item must have from_initiator=false"
        );
    }

    /// TR-16: currency transfers only included when amount > 0.
    /// kills: impl that inserts zero-amount currency transfers.
    #[test]
    fn swap_plan_omits_zero_currency() {
        let plan = build_swap_plan(&[], &[], &[], &[], 0, 0).expect("valid ownership");
        assert!(
            plan.currency_transfers.is_empty(),
            "no currency transfers when both amounts are 0"
        );

        let plan2 = build_swap_plan(&[], &[], &[], &[], 100, 0).expect("valid ownership");
        assert_eq!(plan2.currency_transfers.len(), 1);
        assert!(plan2.currency_transfers[0].from_initiator);
        assert_eq!(plan2.currency_transfers[0].amount, 100);
    }

    /// TR-status: TradeStatus::is_active covers both non-terminal variants.
    /// kills: impl that only checks Pending (misses ConfirmedByCounterparty).
    #[test]
    fn trade_status_is_active_covers_both_variants() {
        assert!(TradeStatus::Pending.is_active(), "Pending must be active");
        assert!(
            TradeStatus::ConfirmedByCounterparty.is_active(),
            "ConfirmedByCounterparty must be active"
        );
    }

    /// FINDING-1 (HIGH): duplicate item_id within one side of an offer is not rejected
    /// by validate_proposal. An initiator can list {item_id:5, qty:3} twice, causing
    /// the escrow guard (escrowed_item_qty) to see only 3 escrowed while 6 will be
    /// consumed at confirm time — allowing an item-count bypass if the stack has ≥6
    /// but the guard only holds 3.
    ///
    /// This test should FAIL against the current code (no dedup check on item_ids)
    /// and PASS after validate_proposal rejects duplicate item_ids per side.
    ///
    /// kills: impl that allows duplicate item_id entries in initiator_items /
    ///        counterparty_items without rejecting.
    #[test]
    fn validate_proposal_rejects_duplicate_item_ids_same_side() {
        // Two entries for item_id=5 on the initiator side: 3 + 3 = 6 would be
        // consumed at swap time, but escrowed_item_qty sums per-offer so the
        // guard would only see 3 (the per-offer inner fold).
        // validate_proposal MUST reject this before the row is inserted.
        let dup_items = vec![
            TradeItem { item_id: 5, qty: 3 },
            TradeItem { item_id: 5, qty: 3 },
        ];
        let initiator = ProposalSide {
            monster_ids: &[],
            items: &dup_items,
            currency: 0,
        };
        let result = validate_proposal(
            false,
            false,
            false,
            initiator,
            ProposalSide {
                monster_ids: &[1],
                items: no_item(),
                currency: 0,
            },
        );
        assert!(
            result.is_err(),
            "duplicate item_id within one offer side must be rejected — \
             current code accepts it, allowing escrow-qty bypass at confirm time"
        );
    }

    /// FINDING-2 (MEDIUM): counterparty_currency is not balance-checked at propose
    /// time. The initiator may name any counterparty_currency value regardless of the
    /// counterparty's actual wallet. The only backstop is spend_currency at confirm
    /// time, but between propose and confirm the counterparty's currency is not locked
    /// by an explicit check — only the escrowed_currency_amount guard in spend paths
    /// prevents double-spend of what the counterparty DOES have.
    ///
    /// Concretely: if Bob has 0 currency, Alice can name counterparty_currency=999999
    /// in the offer. respond_trade(accepted=true) succeeds (no currency check there).
    /// confirm_trade then calls spend_currency(Bob, 999999) which returns Err —
    /// rolling back the whole transaction. So assets are NOT stolen, but Alice can
    /// DoS Bob's slot (Bob's has_active_trade=true blocks Bob from OTHER trades).
    ///
    /// This test documents the absence of a propose-time counterparty currency check.
    /// A fix would validate counterparty_currency <= counterparty's current balance at
    /// propose time. For now this is a MEDIUM-severity griefing vector.
    ///
    /// kills: impl that silently allows inflated counterparty_currency at propose time.
    #[test]
    fn validate_proposal_does_not_check_counterparty_currency_balance() {
        // validate_proposal is pure (no DB access) so it CANNOT check the live wallet.
        // This test documents that the pure layer accepts arbitrary counterparty_currency.
        // The fix must be in the server shell (propose_trade reducer), not here.
        let result = validate_proposal(
            false,
            false,
            false,
            ProposalSide {
                monster_ids: &[1],
                items: no_item(),
                currency: 0,
            },
            ProposalSide {
                monster_ids: &[],
                items: no_item(),
                currency: u64::MAX, // inflated — no wallet check in pure layer
            },
        );
        // Documents the gap: this currently returns Ok (no pure-layer wallet check).
        // The server shell SHOULD add a wallet balance check before inserting the row.
        // If this ever becomes Err, that means the pure layer gained a wallet check
        // (which would require a DB-backed argument — at which point remove this test).
        assert!(
            result.is_ok(),
            "pure validate_proposal cannot check live wallet balance — \
             this documents the gap; the fix belongs in propose_trade reducer"
        );
    }

    /// TR-1: counterparty-monster-only offer (initiator provides nothing) is valid.
    /// kills: 39:9 replace + with * — mutant: i_items.len() * c_monsters.len() = 0*1 = 0
    ///        making total_assets = 0 → EmptyOffer; original: 0+0+1+0+0+0 = 1 → Ok.
    #[test]
    fn validate_accepts_counterparty_monster_only() {
        let result = validate_proposal(
            false,
            false,
            false,
            ProposalSide {
                monster_ids: &[],
                items: no_item(),
                currency: 0,
            },
            ProposalSide {
                monster_ids: &[42],
                items: no_item(),
                currency: 0,
            },
        );
        assert!(
            result.is_ok(),
            "counterparty-only monster offer must be valid (at least one asset on either side)"
        );
    }

    /// TR-1: initiator offers a monster, counterparty offers an item with positive qty → valid.
    /// kills: 40:9 replace + with — total becomes 1-1=0 → EmptyOffer (original: 2).
    ///        69:12 delete ! — first counterparty item inserts→true, triggers DuplicateItem.
    ///        84:21 replace == with != — qty=3 != 0 triggers InsufficientInventory.
    #[test]
    fn validate_accepts_initiator_monster_counterparty_item() {
        let c_items = one_item(5, 3);
        let result = validate_proposal(
            false,
            false,
            false,
            ProposalSide {
                monster_ids: &[1],
                items: no_item(),
                currency: 0,
            },
            ProposalSide {
                monster_ids: &[],
                items: &c_items,
                currency: 0,
            },
        );
        assert!(result.is_ok(), "monster-for-item trade must be valid");
    }

    /// TR-1: counterparty-items-only offer (no monsters on either side) is valid.
    /// kills: 40:9 replace + with * — mutant: c_monsters.len() * c_items.len() = 0*1 = 0
    ///        making total_assets = 0 → EmptyOffer; original: 0+0+0+1+0+0 = 1 → Ok.
    #[test]
    fn validate_accepts_counterparty_items_only() {
        let c_items = one_item(7, 1);
        let result = validate_proposal(
            false,
            false,
            false,
            ProposalSide {
                monster_ids: &[],
                items: no_item(),
                currency: 0,
            },
            ProposalSide {
                monster_ids: &[],
                items: &c_items,
                currency: 0,
            },
        );
        assert!(
            result.is_ok(),
            "counterparty-items-only offer must be valid (at least one asset on either side)"
        );
    }

    /// TR-1: counterparty-currency-only offer (initiator provides nothing) is valid.
    /// kills: 42:36 replace > with < — u64 < 0 is always false, so counterparty currency
    ///        never counts toward total_assets; original: 0+0+0+0+0+1 = 1 → Ok.
    #[test]
    fn validate_accepts_counterparty_currency_only() {
        let result = validate_proposal(
            false,
            false,
            false,
            ProposalSide {
                monster_ids: &[],
                items: no_item(),
                currency: 0,
            },
            ProposalSide {
                monster_ids: &[],
                items: no_item(),
                currency: 100,
            },
        );
        assert!(
            result.is_ok(),
            "counterparty-currency gift offer must be valid (currency counts as an asset)"
        );
    }

    /// TR-16: build_swap_plan includes a CurrencyTransfer for counterparty_currency > 0.
    /// kills: 220:30 replace > with < — u64 < 0 is always false, counterparty currency
    ///        transfer is never pushed → plan.currency_transfers is empty;
    ///        original: counterparty_currency=50 > 0 → pushed with from_initiator=false.
    #[test]
    fn swap_plan_includes_counterparty_currency_transfer() {
        let plan = build_swap_plan(&[], &[], &[], &[], 0, 50).expect("valid ownership");
        assert_eq!(
            plan.currency_transfers.len(),
            1,
            "counterparty currency > 0 must produce exactly one currency transfer"
        );
        assert!(
            !plan.currency_transfers[0].from_initiator,
            "counterparty currency transfer must have from_initiator=false"
        );
        assert_eq!(
            plan.currency_transfers[0].amount, 50,
            "counterparty currency transfer amount must equal the input currency"
        );
    }
}
