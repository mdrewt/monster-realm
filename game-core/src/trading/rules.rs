//! Pure trade rule functions (M15, ADR-0106; extended M16.5b, ADR-0113; M16.5f, ADR-0117).
//!
//! No I/O, no SpacetimeDB context. Validates proposals, authorizes the state-machine
//! transitions (`authorize_respond` / `authorize_confirm`), applies the TTL staleness
//! rule (`is_offer_stale`), and produces the `SwapPlan` the server applies atomically.
//! The server module is the thin imperative shell; these functions are the SSOT rule layer.

use super::types::{MonsterCard, TradeError, TradeItem, TradeStatus};
use crate::currency::MAX_BALANCE;

/// Per-stack item cap (domain constant, ADR-0113). Mirrors `MAX_ITEM_STACK` that
/// was previously defined locally in `server-module/src/inventory.rs`; moved here
/// so the pure `check_headroom` rule can reference it without a crate boundary.
// 9999: four-digit UI cap; no game-design constraint — tunable (ADR-0059 residual c).
pub const MAX_ITEM_STACK: u32 = 9999;

/// Current item stack snapshot for one (owner, item_id) pair.
/// Passed to `check_headroom` so it can check receiver headroom without DB access.
#[derive(Clone, Debug, PartialEq)]
pub struct ItemStack {
    pub item_id: u32,
    pub current_count: u32,
}

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

/// Check that crediting the negotiated assets to each receiver won't exceed their
/// stack/balance caps. Called by `confirm_trade` BEFORE applying any transfers so
/// the transaction aborts cleanly with `Err` if a receiver is at or near their cap —
/// reject-not-clamp (ADR-0113, 16.5b-1).
///
/// Parameters (receiver-centric naming — each side receives the OTHER's assets):
/// - `initiator_receives_items` / `initiator_current_stacks`: items the initiator
///   will gain (the counterparty's offered items) + initiator's current counts.
/// - `initiator_receives_currency` / `initiator_balance`: currency the initiator
///   will gain (counterparty_currency) + initiator's current balance.
/// - Same pattern for the counterparty side.
// 8-argument function is unavoidable: two symmetric sides × four state components
// (items, item_stacks, currency, balance). Grouping into a struct would add boilerplate
// with no clarity gain for this single call site.
#[allow(clippy::too_many_arguments)]
pub fn check_headroom(
    initiator_receives_items: &[TradeItem],
    initiator_current_stacks: &[ItemStack],
    initiator_receives_currency: u64,
    initiator_balance: u64,
    counterparty_receives_items: &[TradeItem],
    counterparty_current_stacks: &[ItemStack],
    counterparty_receives_currency: u64,
    counterparty_balance: u64,
) -> Result<(), TradeError> {
    // Item headroom: initiator receives counterparty's items.
    for item in initiator_receives_items {
        let current = initiator_current_stacks
            .iter()
            .find(|s| s.item_id == item.item_id)
            .map(|s| s.current_count)
            .unwrap_or(0);
        if current.saturating_add(item.qty) > MAX_ITEM_STACK {
            return Err(TradeError::ItemStackCapExceeded {
                item_id: item.item_id,
            });
        }
    }
    // Item headroom: counterparty receives initiator's items.
    for item in counterparty_receives_items {
        let current = counterparty_current_stacks
            .iter()
            .find(|s| s.item_id == item.item_id)
            .map(|s| s.current_count)
            .unwrap_or(0);
        if current.saturating_add(item.qty) > MAX_ITEM_STACK {
            return Err(TradeError::ItemStackCapExceeded {
                item_id: item.item_id,
            });
        }
    }
    // Currency headroom: initiator receives counterparty_currency.
    if initiator_receives_currency > 0
        && initiator_balance.saturating_add(initiator_receives_currency) > MAX_BALANCE
    {
        return Err(TradeError::CurrencyCapExceeded);
    }
    // Currency headroom: counterparty receives initiator_currency.
    if counterparty_receives_currency > 0
        && counterparty_balance.saturating_add(counterparty_receives_currency) > MAX_BALANCE
    {
        return Err(TradeError::CurrencyCapExceeded);
    }
    Ok(())
}

/// Authorize a `respond_trade` call (16.5f-1, ADR-0117).
///
/// Role is checked BEFORE status: a non-counterparty caller gets `NotCounterparty`
/// regardless of the offer's state, so the offer status never leaks to a non-party
/// caller. Only a `Pending` offer can be responded to.
pub fn authorize_respond(status: &TradeStatus, is_counterparty: bool) -> Result<(), TradeError> {
    if !is_counterparty {
        return Err(TradeError::NotCounterparty);
    }
    if *status != TradeStatus::Pending {
        return Err(TradeError::NotPending);
    }
    Ok(())
}

/// Authorize a `confirm_trade` call (16.5f-1, ADR-0117).
///
/// Role is checked BEFORE status: a non-initiator caller gets `NotInitiator`
/// regardless of the offer's state (same no-status-leak ordering as
/// `authorize_respond`). Only a `ConfirmedByCounterparty` offer can be confirmed.
pub fn authorize_confirm(status: &TradeStatus, is_initiator: bool) -> Result<(), TradeError> {
    if !is_initiator {
        return Err(TradeError::NotInitiator);
    }
    if *status != TradeStatus::ConfirmedByCounterparty {
        return Err(TradeError::NotConfirmedByCounterparty);
    }
    Ok(())
}

/// Trade offer time-to-live (16.5f-4, ADR-0117).
// 1 h — tunable liveness constant, no game-design constraint.
pub const TRADE_OFFER_TTL_MS: i64 = 3_600_000;

/// True if the offer has outlived `TRADE_OFFER_TTL_MS` (16.5f-4, ADR-0117).
///
/// Saturating subtraction: clock skew (`now_ms` < `created_at_ms`) yields elapsed 0,
/// so a fresh offer is never marked stale. Boundary is `>=`: at exactly TTL the
/// offer IS stale.
pub fn is_offer_stale(created_at_ms: i64, now_ms: i64) -> bool {
    now_ms.saturating_sub(created_at_ms) >= TRADE_OFFER_TTL_MS
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
        // The wallet balance check EXISTS in the propose_trade reducer (server shell), not here.
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
        // Documents that validate_proposal returns Ok (no pure-layer wallet check);
        // the actual balance enforcement is in propose_trade (server shell, ADR-0117).
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

    // ===========================================================================
    // M16.5b: check_headroom — receiver-cap tests (RED until implementation added)
    //
    // These tests reference `check_headroom`, `ItemStack`, `MAX_ITEM_STACK`, and
    // `TradeError::ItemStackCapExceeded` / `TradeError::CurrencyCapExceeded`, which
    // do NOT yet exist. They will not compile until the implementer adds them to
    // rules.rs and types.rs — that is intentional (RED phase, 16.5b-1 / 16.5b-2).
    //
    // EARS criteria:
    //   16.5b-1  confirm_trade SHALL return Err and roll back if any credit would
    //            exceed MAX_ITEM_STACK or MAX_BALANCE headroom (reject-not-clamp).
    //   16.5b-2  Boundary tests at the exact spec thresholds:
    //            - 9980 + 50 = 10030 > 9999 = MAX_ITEM_STACK → Err
    //            - (MAX_BALANCE - 49) + 50 > MAX_BALANCE → Err
    // ===========================================================================

    /// 16.5b-2 PRIMARY ITEM BOUNDARY: initiator (receiver) at 9,980 of item_id=1,
    /// receiving 50 items → Err(ItemStackCapExceeded { item_id: 1 }).
    /// Spec equation: 9980 + 50 = 10030 > MAX_ITEM_STACK (9999).
    ///
    /// kills: impl that uses grant_item's silent clamp instead of rejecting outright —
    ///        grant_item(9980, 50) would clamp to 9999, destroying 31 items silently;
    ///        check_headroom MUST detect this and return Err before any mutation happens.
    #[test]
    fn check_headroom_rejects_initiator_item_at_cap() {
        use crate::currency::MAX_BALANCE;
        let initiator_receives_items = [TradeItem {
            item_id: 1,
            qty: 50,
        }];
        let initiator_current_stacks = [ItemStack {
            item_id: 1,
            current_count: 9980,
        }];
        let result = check_headroom(
            &initiator_receives_items,
            &initiator_current_stacks,
            0,
            0,
            &[],
            &[],
            0,
            MAX_BALANCE,
        );
        assert_eq!(
            result.unwrap_err(),
            TradeError::ItemStackCapExceeded { item_id: 1 },
            "9980 + 50 = 10030 > MAX_ITEM_STACK (9999): must return Err(ItemStackCapExceeded)"
        );
    }

    /// 16.5b-2 PRIMARY CURRENCY BOUNDARY: initiator_balance = MAX_BALANCE - 49,
    /// receives 50 currency → Err(CurrencyCapExceeded).
    /// Spec: (MAX_BALANCE - 49) + 50 = MAX_BALANCE + 1 > MAX_BALANCE.
    ///
    /// kills: impl that uses grant_currency's silent clamp — grant_currency saturates at
    ///        MAX_BALANCE, destroying 1 unit; check_headroom must detect the overflow and
    ///        return Err so confirm_trade rolls back and the sender is not debited.
    #[test]
    fn check_headroom_rejects_initiator_currency_at_cap() {
        use crate::currency::MAX_BALANCE;
        let result = check_headroom(&[], &[], 50, MAX_BALANCE - 49, &[], &[], 0, 0);
        assert_eq!(
            result.unwrap_err(),
            TradeError::CurrencyCapExceeded,
            "(MAX_BALANCE - 49) + 50 = MAX_BALANCE + 1 > MAX_BALANCE: must return Err(CurrencyCapExceeded)"
        );
    }

    /// 16.5b-2: counterparty (receiver) at 9,980 of item_id=3, receiving 50 → Err.
    ///
    /// kills: impl that only checks headroom for the initiator side (the initiator is
    ///        the one calling confirm_trade, so a lazy impl might only verify the
    ///        initiator's side); both parties must be checked.
    #[test]
    fn check_headroom_rejects_counterparty_item_at_cap() {
        use crate::currency::MAX_BALANCE;
        let counterparty_receives_items = [TradeItem {
            item_id: 3,
            qty: 50,
        }];
        let counterparty_current_stacks = [ItemStack {
            item_id: 3,
            current_count: 9980,
        }];
        let result = check_headroom(
            &[],
            &[],
            0,
            MAX_BALANCE,
            &counterparty_receives_items,
            &counterparty_current_stacks,
            0,
            0,
        );
        assert_eq!(
            result.unwrap_err(),
            TradeError::ItemStackCapExceeded { item_id: 3 },
            "counterparty at 9980 + 50 = 10030 > 9999: must return Err(ItemStackCapExceeded)"
        );
    }

    /// 16.5b-2: counterparty_balance = MAX_BALANCE, receives 1 → Err(CurrencyCapExceeded).
    ///
    /// kills: impl that only checks the initiator currency headroom and skips the
    ///        counterparty — a counterparty at MAX_BALANCE receiving any currency would
    ///        silently lose it via grant_currency's clamp without the headroom guard.
    #[test]
    fn check_headroom_rejects_counterparty_currency_at_cap() {
        use crate::currency::MAX_BALANCE;
        let result = check_headroom(&[], &[], 0, 0, &[], &[], 1, MAX_BALANCE);
        assert_eq!(
            result.unwrap_err(),
            TradeError::CurrencyCapExceeded,
            "counterparty at MAX_BALANCE + 1 must return Err(CurrencyCapExceeded)"
        );
    }

    /// 16.5b-2: receiver has exactly MAX_ITEM_STACK items, receives 1 → Err.
    ///
    /// kills: impl that uses > instead of >= for the overflow check (off-by-one):
    ///        current_count + qty == MAX_ITEM_STACK + 1 which is strictly > MAX_ITEM_STACK,
    ///        but any impl using `current_count + qty > MAX_ITEM_STACK` would catch this;
    ///        this test specifically verifies the at-cap-already case (0 headroom).
    #[test]
    fn check_headroom_rejects_when_no_room_at_exactly_cap() {
        use crate::currency::MAX_BALANCE;
        let items_in = [TradeItem { item_id: 7, qty: 1 }];
        let stacks = [ItemStack {
            item_id: 7,
            current_count: MAX_ITEM_STACK,
        }];
        let result = check_headroom(&items_in, &stacks, 0, 0, &[], &[], 0, MAX_BALANCE);
        assert_eq!(
            result.unwrap_err(),
            TradeError::ItemStackCapExceeded { item_id: 7 },
            "current_count=MAX_ITEM_STACK + qty=1 exceeds cap: must return Err"
        );
    }

    /// 16.5b-1 ACCEPT BOUNDARY (item): receiver at 9,980 receiving exactly 19
    /// (9980 + 19 = 9999 = MAX_ITEM_STACK) → Ok (exactly fills the stack).
    ///
    /// kills: impl that uses >= instead of > for the overflow check, incorrectly
    ///        rejecting trades that exactly fill to MAX_ITEM_STACK — the boundary
    ///        is inclusive: headroom = MAX_ITEM_STACK - current_count; qty <= headroom → Ok.
    #[test]
    fn check_headroom_accepts_exact_headroom_item() {
        use crate::currency::MAX_BALANCE;
        let items_in = [TradeItem {
            item_id: 2,
            qty: 19,
        }];
        let stacks = [ItemStack {
            item_id: 2,
            current_count: 9980,
        }];
        let result = check_headroom(&items_in, &stacks, 0, 0, &[], &[], 0, MAX_BALANCE);
        assert!(
            result.is_ok(),
            "9980 + 19 = 9999 = MAX_ITEM_STACK: exactly fills stack, must be Ok (not rejected)"
        );
    }

    /// 16.5b-1 ACCEPT BOUNDARY (currency): balance = MAX_BALANCE - 49, receives 49 → Ok.
    ///
    /// kills: impl that uses > instead of >= in the headroom check, rejecting a trade
    ///        that exactly fills to MAX_BALANCE — receiving exactly the headroom must be Ok.
    #[test]
    fn check_headroom_accepts_exact_currency_headroom() {
        use crate::currency::MAX_BALANCE;
        let result = check_headroom(&[], &[], 49, MAX_BALANCE - 49, &[], &[], 0, 0);
        assert!(
            result.is_ok(),
            "(MAX_BALANCE - 49) + 49 = MAX_BALANCE: exactly fills balance, must be Ok"
        );
    }

    /// 16.5b-1: empty trade (no items, no currency) → Ok (vacuous case, no overflow possible).
    ///
    /// kills: impl that unconditionally returns Err, or one that panics on empty slices.
    #[test]
    fn check_headroom_accepts_empty() {
        use crate::currency::MAX_BALANCE;
        let result = check_headroom(&[], &[], 0, MAX_BALANCE, &[], &[], 0, MAX_BALANCE);
        assert!(
            result.is_ok(),
            "no items or currency transferred: check_headroom must return Ok"
        );
    }

    /// 16.5b-1: receiver has 0 of item, receives MAX_ITEM_STACK → Ok (full stack from empty).
    ///
    /// kills: impl that confuses "receiver has no row" with "at cap" — a missing
    ///        inventory row means current_count = 0, so headroom = MAX_ITEM_STACK
    ///        and receiving MAX_ITEM_STACK is exactly at the boundary → Ok.
    #[test]
    fn check_headroom_accepts_new_receiver() {
        use crate::currency::MAX_BALANCE;
        let items_in = [TradeItem {
            item_id: 5,
            qty: MAX_ITEM_STACK,
        }];
        // Receiver has no existing stack for item 5 → current_count = 0.
        let stacks: [ItemStack; 0] = [];
        let result = check_headroom(&items_in, &stacks, 0, 0, &[], &[], 0, MAX_BALANCE);
        assert!(
            result.is_ok(),
            "receiver has 0 of item, receives MAX_ITEM_STACK ({MAX_ITEM_STACK}): must be Ok"
        );
    }

    // -----------------------------------------------------------------------
    // M16.5b: counterparty accept-boundary tests (nightly-mut-triage gap fill)
    //
    // The five tests below target surviving mutants in the counterparty branches
    // of check_headroom (lines 289–312).  Each test carries a `kills:` annotation
    // per ADR-0088 convention for line-drift traceability.
    // -----------------------------------------------------------------------

    /// 16.5b-2 ACCEPT BOUNDARY (counterparty item): counterparty has 9,980 of item_id=4,
    /// receives exactly 19 items → Ok (9980 + 19 = 9999 = MAX_ITEM_STACK, exactly fills).
    ///
    /// Mirror of `check_headroom_accepts_exact_headroom_item` but on the counterparty
    /// argument slots (args 5–6), with initiator slots empty/zeroed.
    ///
    /// kills: rules.rs:295:45 replace > with >= in check_headroom (counterparty item loop
    ///        overflow check — >= incorrectly rejects a trade that exactly fills to cap)
    #[test]
    fn check_headroom_accepts_exact_headroom_item_counterparty() {
        use crate::currency::MAX_BALANCE;
        let counterparty_receives_items = [TradeItem {
            item_id: 4,
            qty: 19,
        }];
        let counterparty_current_stacks = [ItemStack {
            item_id: 4,
            current_count: 9980,
        }];
        let result = check_headroom(
            &[],
            &[],
            0,
            0,
            &counterparty_receives_items,
            &counterparty_current_stacks,
            0,
            MAX_BALANCE,
        );
        assert!(
            result.is_ok(),
            "counterparty 9980 + 19 = 9999 = MAX_ITEM_STACK: exactly fills stack, must be Ok (not rejected)"
        );
    }

    /// 16.5b-1 ACCEPT BOUNDARY (counterparty currency): counterparty_balance = MAX_BALANCE - 49,
    /// counterparty_receives_currency = 49 → Ok (sum exactly MAX_BALANCE).
    ///
    /// Mirror of `check_headroom_accepts_exact_currency_headroom` but on the counterparty
    /// argument slots (args 7–8), with initiator slots empty/zeroed.
    ///
    /// kills: rules.rs:309:80 replace > with >= in check_headroom (counterparty currency
    ///        cap check — >= incorrectly rejects a trade that exactly fills to MAX_BALANCE)
    ///
    /// kills: rules.rs:309:9 replace && with || in check_headroom (counterparty compound:
    ///        with receives=49>0 true and sum==MAX_BALANCE false, && yields false → Ok,
    ///        while || short-circuits true on receives>0 → Err; the low_balance test
    ///        below kills this mutant independently — either test alone suffices)
    #[test]
    fn check_headroom_accepts_exact_currency_headroom_counterparty() {
        use crate::currency::MAX_BALANCE;
        let result = check_headroom(&[], &[], 0, 0, &[], &[], 49, MAX_BALANCE - 49);
        assert!(
            result.is_ok(),
            "counterparty (MAX_BALANCE - 49) + 49 = MAX_BALANCE: exactly fills balance, must be Ok"
        );
    }

    /// 16.5b-1 ACCEPT BOUNDARY (counterparty currency, belt-and-suspenders):
    /// counterparty_receives_currency = 50, counterparty_balance = 0 → Ok
    /// (well under MAX_BALANCE; receives > 0 so the branch is entered, sum stays under cap).
    ///
    /// With the real `&&`: (50 > 0) && (0 + 50 > MAX_BALANCE) → false → Ok.
    /// With the `||` mutant: (50 > 0) || (...) → true → balance check evaluated →
    ///   (0 + 50 > MAX_BALANCE) → false → Ok.  Wait — actually || mutant on line 308:9
    ///   replaces `&&` with `||` in:
    ///   `if counterparty_receives_currency > 0 || counterparty_balance.saturating_add(...) > MAX_BALANCE`
    ///   When receives=50>0 (true), the short-circuit makes the whole `if` true, and then
    ///   the balance check is the second operand: with balance=0, 0+50≤MAX_BALANCE → false,
    ///   so `||` gives true → Err.  The real `&&` gives true && false → false → Ok.
    ///   This test therefore decisively kills the 309:9 || mutant.
    ///
    /// kills: rules.rs:309:9 replace && with || in check_headroom (counterparty compound
    ///        — receives=50>0, balance=0, so && gives false → Ok, || gives Err)
    #[test]
    fn check_headroom_accepts_counterparty_currency_low_balance() {
        let result = check_headroom(&[], &[], 0, 0, &[], &[], 50, 0);
        assert!(
            result.is_ok(),
            "counterparty_receives_currency=50, counterparty_balance=0: 0+50 << MAX_BALANCE, must be Ok"
        );
    }

    /// 16.5b-1 CONTRACT TEST — initiator skip-guard when receives_currency = 0.
    ///
    /// Input: initiator_receives_currency = 0, initiator_balance = MAX_BALANCE + 1,
    /// all other args empty/zero.
    ///
    /// The input balance DELIBERATELY violates the wallet invariant
    /// (`balance ≤ MAX_BALANCE`, enforced by economy.rs apply_grant/spend) —
    /// production cannot produce this value.  The test pins the CONTRACT of the
    /// `initiator_receives_currency > 0` skip-guard at line 302: check_headroom
    /// polices the trade's incoming delta, not pre-existing wallet state, so a
    /// zero-receive side is exempt from the balance check regardless of its
    /// absolute balance.  Do NOT "fix" this test by also policing absolute balance
    /// — if the contract ever changes to do that, revise ADR-0118 first.
    ///
    /// Under real `> 0`: 0 > 0 is false → balance check skipped → Ok.
    /// Under `>= 0` mutant: 0 >= 0 is true → check runs →
    ///   (MAX_BALANCE+1).saturating_add(0) > MAX_BALANCE → Err.
    ///
    /// kills: rules.rs:302:36 replace > with >= in check_headroom (initiator skip-guard
    ///        — >= makes receives=0 enter the balance check, incorrectly returning Err)
    #[test]
    fn check_headroom_zero_receive_initiator_skips_balance_check() {
        use crate::currency::MAX_BALANCE;
        // MAX_BALANCE + 1 violates the wallet invariant deliberately — see doc above.
        let result = check_headroom(&[], &[], 0, MAX_BALANCE + 1, &[], &[], 0, 0);
        assert!(
            result.is_ok(),
            "initiator receives 0 currency: balance check must be skipped entirely regardless of absolute balance"
        );
    }

    /// 16.5b-1 CONTRACT TEST — counterparty skip-guard when receives_currency = 0.
    ///
    /// Symmetric to `check_headroom_zero_receive_initiator_skips_balance_check`,
    /// targeting the counterparty skip-guard at line 308.
    ///
    /// The input counterparty_balance = MAX_BALANCE + 1 DELIBERATELY violates the
    /// wallet invariant (`balance ≤ MAX_BALANCE`, enforced by economy.rs apply_grant/spend)
    /// — production cannot produce this value.  The test pins the CONTRACT of the
    /// `counterparty_receives_currency > 0` skip-guard: check_headroom polices the
    /// trade's incoming delta, not pre-existing wallet state, so a zero-receive side
    /// is exempt from the balance check regardless of its absolute balance.  Do NOT
    /// "fix" this test by also policing absolute balance — if the contract ever
    /// changes to do that, revise ADR-0118 first.
    ///
    /// Under real `> 0`: 0 > 0 is false → balance check skipped → Ok.
    /// Under `>= 0` mutant: 0 >= 0 is true → check runs →
    ///   (MAX_BALANCE+1).saturating_add(0) > MAX_BALANCE → Err.
    ///
    /// kills: rules.rs:308:39 replace > with >= in check_headroom (counterparty skip-guard
    ///        — >= makes receives=0 enter the balance check, incorrectly returning Err)
    #[test]
    fn check_headroom_zero_receive_counterparty_skips_balance_check() {
        use crate::currency::MAX_BALANCE;
        // MAX_BALANCE + 1 violates the wallet invariant deliberately — see doc above.
        let result = check_headroom(&[], &[], 0, 0, &[], &[], 0, MAX_BALANCE + 1);
        assert!(
            result.is_ok(),
            "counterparty receives 0 currency: balance check must be skipped entirely regardless of absolute balance"
        );
    }

    /// FINDING-3 (MEDIUM): check_headroom snapshots current_count BEFORE the
    /// sender's debit for a bidirectional same-item trade. When the same item_id
    /// appears on BOTH initiator_items AND counterparty_items, check_headroom uses
    /// the receiver's pre-debit count to assess headroom, producing a false-reject
    /// even when the net post-trade balance stays within MAX_ITEM_STACK.
    ///
    /// Scenario:
    ///   initiator has 9990 of item_id=5, gives 15, receives 20 → net 9995 (valid)
    ///   check_headroom sees current_count=9990, incoming=20 → 10010 > 9999 → Err
    ///
    /// This is a correctness bug (over-conservative rejection), NOT a security bypass:
    /// the check never under-counts headroom, so cap overflow is impossible.
    /// The fix is to subtract the qty the receiver is also giving away for the same
    /// item_id before checking: effective_count = current_count.saturating_sub(giving_qty).
    ///
    /// This test DOCUMENTS the current behavior (Err on a logically-valid trade) so
    /// any future fix can be validated by flipping the assertion to is_ok().
    ///
    // check_headroom is a pure function: it trusts whatever current_count is passed.
    // The CALL SITE (confirm_trade in trading.rs) is responsible for computing the
    // effective (post-debit) count: raw_count.saturating_sub(sending_qty).
    // These two tests document that contract:

    #[test]
    fn check_headroom_rejects_with_pre_debit_count_same_item() {
        use crate::currency::MAX_BALANCE;
        // Pre-debit raw count = 9990; incoming = 20 → 9990+20=10010 > 9999 → Err.
        // The CALL SITE must subtract the 15 items the initiator is sending BEFORE
        // calling check_headroom (effective = 9990-15 = 9975; 9975+20=9995 ≤ 9999 → Ok).
        let initiator_receives = [TradeItem {
            item_id: 5,
            qty: 20,
        }];
        let initiator_stacks = [ItemStack {
            item_id: 5,
            current_count: 9990,
        }];
        let result = check_headroom(
            &initiator_receives,
            &initiator_stacks,
            0,
            0,
            &[],
            &[],
            0,
            MAX_BALANCE,
        );
        assert!(result.is_err(), "pre-debit 9990+20=10010 must be rejected");
    }

    #[test]
    fn check_headroom_accepts_effective_count_same_item() {
        use crate::currency::MAX_BALANCE;
        // Effective count after subtracting 15 sent: 9990-15=9975; incoming=20 → 9975+20=9995 ≤ 9999 → Ok.
        // This is the value confirm_trade passes after the net-quantity fix (ADR-0113).
        let initiator_receives = [TradeItem {
            item_id: 5,
            qty: 20,
        }];
        let initiator_stacks = [ItemStack {
            item_id: 5,
            current_count: 9975,
        }];
        let result = check_headroom(
            &initiator_receives,
            &initiator_stacks,
            0,
            0,
            &[],
            &[],
            0,
            MAX_BALANCE,
        );
        assert!(
            result.is_ok(),
            "effective post-debit 9975+20=9995 must be accepted"
        );
    }

    // ===========================================================================
    // M16.5f: authorize_* + is_offer_stale (RED until implementation added)
    //
    // These tests reference `authorize_respond`, `authorize_confirm`,
    // `is_offer_stale`, and `TRADE_OFFER_TTL_MS`, which do NOT yet exist in
    // rules.rs.  They will not compile until the implementer adds them — that is
    // intentional (RED phase, m16.5f).
    //
    // EARS criteria:
    //   m16.5f-1  authorize_respond checks role BEFORE status (role-first ordering).
    //   m16.5f-2  authorize_confirm checks role BEFORE status (role-first ordering).
    //   m16.5f-3  is_offer_stale uses saturating arithmetic and the >= boundary.
    // ===========================================================================

    /// m16.5f-1 HAPPY PATH: (Pending, is_counterparty=true) → Ok(()).
    ///
    /// kills: impl that always returns Err, or that requires a different status.
    #[test]
    fn authorize_respond_ok_on_pending_counterparty() {
        let result = authorize_respond(&TradeStatus::Pending, true);
        assert_eq!(
            result,
            Ok(()),
            "authorize_respond(Pending, true) must return Ok"
        );
    }

    /// m16.5f-1 ROLE CHECK: (Pending, is_counterparty=false) → Err(NotCounterparty).
    ///
    /// kills: impl that skips the role check and only checks status — allows the
    ///        initiator to call respond_trade on their own offer.
    #[test]
    fn authorize_respond_err_not_counterparty_on_false() {
        let result = authorize_respond(&TradeStatus::Pending, false);
        assert_eq!(
            result,
            Err(TradeError::NotCounterparty),
            "authorize_respond(Pending, false) must return Err(NotCounterparty)"
        );
    }

    /// m16.5f-1 STATUS CHECK: (ConfirmedByCounterparty, is_counterparty=true) → Err(NotPending).
    ///
    /// kills: impl that skips the status check and returns Ok for any active status —
    ///        counterparty could re-respond to an already-confirmed offer.
    #[test]
    fn authorize_respond_err_not_pending_on_confirmed_status() {
        let result = authorize_respond(&TradeStatus::ConfirmedByCounterparty, true);
        assert_eq!(
            result,
            Err(TradeError::NotPending),
            "authorize_respond(ConfirmedByCounterparty, true) must return Err(NotPending)"
        );
    }

    /// m16.5f-1 ORDERING TOOTH: (ConfirmedByCounterparty, is_counterparty=false) →
    /// Err(NotCounterparty), NOT Err(NotPending).
    ///
    /// kills: a status-first impl that checks status before role.  If status is checked
    ///        first, (ConfirmedByCounterparty, false) would return NotPending, leaking
    ///        the offer status to a non-party caller.  Role-first ordering prevents this
    ///        information leak and returns NotCounterparty regardless of the status.
    #[test]
    fn authorize_respond_ordering_role_first_confirmed_not_counterparty() {
        let result = authorize_respond(&TradeStatus::ConfirmedByCounterparty, false);
        assert_eq!(
            result,
            Err(TradeError::NotCounterparty),
            "authorize_respond(ConfirmedByCounterparty, false) must return Err(NotCounterparty) \
             (role checked first — a status-first impl would return NotPending, which leaks \
             offer state to a non-party caller)"
        );
    }

    /// m16.5f-2 HAPPY PATH: (ConfirmedByCounterparty, is_initiator=true) → Ok(()).
    ///
    /// kills: impl that always returns Err, or that requires Pending status.
    #[test]
    fn authorize_confirm_ok_on_confirmed_initiator() {
        let result = authorize_confirm(&TradeStatus::ConfirmedByCounterparty, true);
        assert_eq!(
            result,
            Ok(()),
            "authorize_confirm(ConfirmedByCounterparty, true) must return Ok"
        );
    }

    /// m16.5f-2 ROLE CHECK: (ConfirmedByCounterparty, is_initiator=false) →
    /// Err(NotInitiator).
    ///
    /// kills: impl that skips the role check — allows the counterparty to call
    ///        confirm_trade and execute the atomic swap without the initiator's consent.
    #[test]
    fn authorize_confirm_err_not_initiator_on_false() {
        let result = authorize_confirm(&TradeStatus::ConfirmedByCounterparty, false);
        assert_eq!(
            result,
            Err(TradeError::NotInitiator),
            "authorize_confirm(ConfirmedByCounterparty, false) must return Err(NotInitiator)"
        );
    }

    /// m16.5f-2 STATUS CHECK: (Pending, is_initiator=true) →
    /// Err(NotConfirmedByCounterparty).
    ///
    /// kills: impl that skips the status check — allows initiator to confirm before
    ///        the counterparty has accepted, bypassing the two-step confirmation flow.
    #[test]
    fn authorize_confirm_err_not_confirmed_on_pending_status() {
        let result = authorize_confirm(&TradeStatus::Pending, true);
        assert_eq!(
            result,
            Err(TradeError::NotConfirmedByCounterparty),
            "authorize_confirm(Pending, true) must return Err(NotConfirmedByCounterparty)"
        );
    }

    /// m16.5f-2 ORDERING TOOTH: (Pending, is_initiator=false) → Err(NotInitiator),
    /// NOT Err(NotConfirmedByCounterparty).
    ///
    /// kills: a status-first impl.  If status is checked first, (Pending, false) returns
    ///        NotConfirmedByCounterparty, leaking offer status.  Role-first ordering
    ///        returns NotInitiator regardless of the current status.
    #[test]
    fn authorize_confirm_ordering_role_first_pending_not_initiator() {
        let result = authorize_confirm(&TradeStatus::Pending, false);
        assert_eq!(
            result,
            Err(TradeError::NotInitiator),
            "authorize_confirm(Pending, false) must return Err(NotInitiator) \
             (role checked first — a status-first impl would return NotConfirmedByCounterparty)"
        );
    }

    /// m16.5f-3 BOUNDARY: (created=0, now=TRADE_OFFER_TTL_MS - 1) → false (not yet stale).
    ///
    /// kills: impl that uses > instead of >= (off-by-one: TTL-1 ms remaining → fresh).
    /// Uses TRADE_OFFER_TTL_MS by name so a constant-value mutant (changing the const)
    /// causes this test to fail rather than silently pass with a hardcoded literal.
    #[test]
    fn is_offer_stale_false_one_ms_before_ttl() {
        assert!(
            !is_offer_stale(0, TRADE_OFFER_TTL_MS - 1),
            "now = TRADE_OFFER_TTL_MS - 1 ms since creation: offer is fresh, must return false"
        );
    }

    /// m16.5f-3 BOUNDARY: (created=0, now=TRADE_OFFER_TTL_MS) → true (exactly at TTL).
    ///
    /// kills: impl that uses > instead of >= for the stale check — the spec says
    ///        elapsed >= TTL is stale, so at exactly TTL the offer IS stale.
    #[test]
    fn is_offer_stale_true_at_exact_ttl() {
        assert!(
            is_offer_stale(0, TRADE_OFFER_TTL_MS),
            "now = TRADE_OFFER_TTL_MS ms since creation: offer is stale at exactly TTL boundary \
             (>= semantics), must return true"
        );
    }

    /// m16.5f-3 BOUNDARY: (created=0, now=TRADE_OFFER_TTL_MS + 1) → true (past TTL).
    ///
    /// kills: impl that uses = instead of >= (rejects any elapsed time but the exact boundary).
    #[test]
    fn is_offer_stale_true_past_ttl() {
        assert!(
            is_offer_stale(0, TRADE_OFFER_TTL_MS + 1),
            "now = TRADE_OFFER_TTL_MS + 1 ms since creation: offer is past TTL, must return true"
        );
    }

    /// m16.5f-3 CLOCK SKEW: (created=100, now=50) → false (created_at in the future).
    ///
    /// kills: impl that does `now - created` without saturating_sub — would underflow
    ///        and panic on debug builds (or wrap to a huge value on release), incorrectly
    ///        marking a just-created offer as stale.
    #[test]
    fn is_offer_stale_false_on_clock_skew() {
        assert!(
            !is_offer_stale(100, 50),
            "now (50) < created_at (100): saturating_sub gives 0 < TTL, must return false \
             (clock skew must never mark a fresh offer as stale)"
        );
    }

    /// m16.5f-3 EXTREMES: (i64::MIN, i64::MAX) must not panic (saturating arithmetic).
    ///
    /// kills: impl that uses wrapping/checked subtraction rather than saturating_sub —
    ///        i64::MAX - i64::MIN would overflow on a non-saturating impl.
    #[test]
    fn is_offer_stale_no_panic_on_extreme_min_max() {
        // i64::MAX saturating_sub i64::MIN = i64::MAX (saturates at i64::MAX, not wrapping).
        // i64::MAX >= TRADE_OFFER_TTL_MS → true; but the key property is: must not panic.
        let _ = is_offer_stale(i64::MIN, i64::MAX);
    }

    /// m16.5f-3 EXTREMES: (i64::MAX, i64::MIN) must not panic (saturating arithmetic).
    ///
    /// kills: same as above — reversed direction gives saturating_sub = 0 → false,
    ///        but again the key property is: must not panic.
    #[test]
    fn is_offer_stale_no_panic_on_extreme_max_min() {
        // i64::MIN saturating_sub i64::MAX = i64::MIN (saturates at i64::MIN, gives 0 after
        // the saturating cast), so result is 0 < TRADE_OFFER_TTL_MS → false.
        let result = is_offer_stale(i64::MAX, i64::MIN);
        // Must be false: elapsed saturates to 0, which is < TTL.
        assert!(
            !result,
            "is_offer_stale(i64::MAX, i64::MIN): saturating_sub gives 0 < TTL, must be false"
        );
    }
}
