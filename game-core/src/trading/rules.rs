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

/// One primitive item/currency mutation in the published apply order for a trade
/// swap (17.5b-1, ADR-0123).
///
/// Debit variants carry `from_initiator` (the SENDING party); credit variants
/// carry `to_initiator` (the RECEIVING party). `ordered_steps()` performs the
/// `to_initiator = !from_initiator` inversion at emission, so a consumer reads
/// each flag directly — no inversion at any dispatch site.
#[derive(Clone, Debug, PartialEq)]
pub enum ApplyStep {
    /// Remove `qty` of `item_id` from the sending party's stack.
    ItemDebit {
        from_initiator: bool,
        item_id: u32,
        qty: u32,
    },
    /// Remove `amount` from the sending party's wallet.
    CurrencyDebit { from_initiator: bool, amount: u64 },
    /// Add `qty` of `item_id` to the receiving party's stack.
    ItemCredit {
        to_initiator: bool,
        item_id: u32,
        qty: u32,
    },
    /// Add `amount` to the receiving party's wallet.
    CurrencyCredit { to_initiator: bool, amount: u64 },
}

impl SwapPlan {
    /// Produce this plan's item/currency mutations as a debits-before-credits
    /// sequence — the first-class published ordering contract consumed by
    /// `confirm_trade` (17.5b-1, ADR-0123; same SSOT standing as `check_headroom`).
    ///
    /// ALL `ItemDebit`/`CurrencyDebit` steps strictly precede ANY `ItemCredit`/
    /// `CurrencyCredit` step. Every transfer in the plan yields exactly one debit
    /// and one credit with identical `item_id`/`qty` (or `amount`); the credit's
    /// `to_initiator` is the inverted `from_initiator` (the other party receives).
    /// Within each phase the emission order is: item steps in `item_transfers`
    /// order, then currency steps in `currency_transfers` order (mirrored in the
    /// credit phase) — also part of the contract; do not reorder silently.
    ///
    /// Why this order: crediting a stack or wallet that has not yet been debited
    /// can transiently exceed `MAX_ITEM_STACK`/`MAX_BALANCE` on a same-item (or
    /// bilateral-currency) swap, and the clamping grant primitives would silently
    /// destroy the excess. Debits-first makes the NETTED headroom check exact:
    /// `check_headroom` over post-debit effective counts/balances preserves
    /// reject-not-clamp (ADR-0113) — any plan that passes the check applies
    /// without ever touching a cap. Monster transfers are ownership flips with no
    /// cap and are NOT part of this sequence.
    ///
    /// OBLIGATION (ADR-0123 D6): every executor of these steps MUST run the
    /// NETTED `check_headroom` first — the type system does not enforce the
    /// pairing, and applying steps unchecked reintroduces silent clamp loss.
    #[must_use]
    pub fn ordered_steps(&self) -> Vec<ApplyStep> {
        let mut steps =
            Vec::with_capacity(2 * (self.item_transfers.len() + self.currency_transfers.len()));
        // Phase 1 — ALL debits (items, then currency).
        for xfer in &self.item_transfers {
            steps.push(ApplyStep::ItemDebit {
                from_initiator: xfer.from_initiator,
                item_id: xfer.item_id,
                qty: xfer.qty,
            });
        }
        for xfer in &self.currency_transfers {
            steps.push(ApplyStep::CurrencyDebit {
                from_initiator: xfer.from_initiator,
                amount: xfer.amount,
            });
        }
        // Phase 2 — ALL credits; receiver is the other party (inversion happens
        // HERE, at emission, never at a dispatch site).
        for xfer in &self.item_transfers {
            steps.push(ApplyStep::ItemCredit {
                to_initiator: !xfer.from_initiator,
                item_id: xfer.item_id,
                qty: xfer.qty,
            });
        }
        for xfer in &self.currency_transfers {
            steps.push(ApplyStep::CurrencyCredit {
                to_initiator: !xfer.from_initiator,
                amount: xfer.amount,
            });
        }
        steps
    }
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

    // ===========================================================================
    // m17.5b — debits-before-credits ordering + currency netting + conservation
    //
    // These tests reference `SwapPlan::ordered_steps()` and `ApplyStep` (with
    // variants ItemDebit / CurrencyDebit / ItemCredit / CurrencyCredit), which do
    // NOT yet exist.  They will not compile until the implementer adds them to
    // rules.rs — that is intentional (RED phase: EARS 17.5b-1 / 17.5b-2 / 17.5b-3).
    //
    // EARS criteria:
    //   17.5b-1  WHEN confirm_trade executes, ALL debits SHALL be applied before ANY
    //            credit.  `ordered_steps()` is the published game-core SSOT contract.
    //   17.5b-2  IF debits-first is adopted, currency headroom inputs SHALL be netted
    //            (`balance − outgoing`) symmetrically with item stacks.
    //   17.5b-3  Regression proof-of-teeth: bilateral same-item swap near cap →
    //            assets conserved; genuine over-cap net → Err before any walk.
    //
    // HONESTY NOTE (B-2): The "both inventories unchanged on reject" property proven
    // here rests on `check_headroom` rejecting BEFORE any walk of `ordered_steps()`.
    // Production partial-failure safety rests on SpacetimeDB reducer-Err transaction
    // rollback — a platform guarantee NOT exercised in unit tests.  This is stated
    // explicitly in ADR-0123 and the relevant test doc-comments.
    // ===========================================================================

    // ---------------------------------------------------------------------------
    // In-memory parallel model (per-party, per-item_id + wallets).
    //
    // ModelState mirrors the inventory of both parties in a single struct so tests
    // can assert per-party exact deltas after walking `ordered_steps()`.
    //
    // The credit operation MUST assert BEFORE any min/clamp so the tripwire fires
    // on a clamp-that-engages — the regression signal for credit-before-debit (F6).
    // ---------------------------------------------------------------------------

    use std::collections::HashMap;

    /// Per-party in-memory item + currency state.
    #[derive(Clone, Debug)]
    struct ModelState {
        /// Keyed by (is_initiator, item_id) → current count.
        items: HashMap<(bool, u32), u32>,
        /// Wallet balance per party: [initiator, counterparty].
        wallets: [u64; 2],
    }

    impl ModelState {
        fn new(
            initiator_items: &[(u32, u32)],
            counterparty_items: &[(u32, u32)],
            initiator_wallet: u64,
            counterparty_wallet: u64,
        ) -> Self {
            let mut items = HashMap::new();
            for &(id, qty) in initiator_items {
                items.insert((true, id), qty);
            }
            for &(id, qty) in counterparty_items {
                items.insert((false, id), qty);
            }
            ModelState {
                items,
                wallets: [initiator_wallet, counterparty_wallet],
            }
        }

        /// Apply a single `ApplyStep` to the model.
        ///
        /// Credit ops MUST assert BEFORE any clamp (F6): if `old + qty > MAX_ITEM_STACK`
        /// the tripwire fires, proving debits-first was violated (the net headroom check
        /// should have caught this before any steps were walked).
        fn apply(&mut self, step: &ApplyStep) {
            match step {
                ApplyStep::ItemDebit {
                    from_initiator,
                    item_id,
                    qty,
                } => {
                    let party_idx = *from_initiator;
                    let entry = self.items.entry((party_idx, *item_id)).or_insert(0);
                    *entry = entry.checked_sub(*qty).expect(
                        "ItemDebit: model debit underflowed — sender has insufficient stock",
                    );
                }
                ApplyStep::CurrencyDebit {
                    from_initiator,
                    amount,
                } => {
                    let w = &mut self.wallets[if *from_initiator { 0 } else { 1 }];
                    *w = w.checked_sub(*amount).expect(
                        "CurrencyDebit: model wallet underflowed — sender has insufficient balance",
                    );
                }
                ApplyStep::ItemCredit {
                    to_initiator,
                    item_id,
                    qty,
                } => {
                    let party_idx = *to_initiator;
                    let old = *self.items.entry((party_idx, *item_id)).or_insert(0);
                    // TRIPWIRE — fires BEFORE any min/clamp (F6).
                    // A credit-before-debit scenario leaves the old count pre-debit, so
                    // `old + qty` hits the cap here.  Debits-first ensures the count is
                    // already reduced before this assertion is evaluated.
                    // saturating_add guards a hypothetical u32 overflow in the assert expression
                    // itself: it caps at u32::MAX rather than wrapping, so the comparison is safe.
                    assert!(
                        old.saturating_add(*qty) <= MAX_ITEM_STACK,
                        "tripwire: credit would exceed cap — debits-first was violated \
                         (item_id={}, party_is_initiator={}, old={}, incoming={}, cap={})",
                        item_id,
                        to_initiator,
                        old,
                        qty,
                        MAX_ITEM_STACK
                    );
                    *self.items.entry((party_idx, *item_id)).or_insert(0) += qty;
                }
                ApplyStep::CurrencyCredit {
                    to_initiator,
                    amount,
                } => {
                    let w = &mut self.wallets[if *to_initiator { 0 } else { 1 }];
                    // TRIPWIRE — mirrors item tripwire; fires BEFORE the saturating_add (debits-first
                    // must prevent this from triggering in a correct implementation).
                    // The saturating_add in the assert expression itself is guarded against a
                    // hypothetical u64 overflow: saturating_add caps at u64::MAX rather than wrapping,
                    // so the comparison is safe even at extreme values.
                    assert!(
                        w.saturating_add(*amount) <= MAX_BALANCE,
                        "tripwire: currency credit would exceed MAX_BALANCE — debits-first violated \
                         (to_initiator={}, wallet_before={}, incoming={}, cap={})",
                        to_initiator,
                        w,
                        amount,
                        MAX_BALANCE
                    );
                    *w = w.saturating_add(*amount);
                }
            }
        }
    }

    // ---------------------------------------------------------------------------
    // A1 — executed conservation: bilateral same-item swap near-cap
    //
    // EARS 17.5b-3: counterparty at 9999 and 9998 of item X, with a bilateral swap
    // that nets within headroom — ordered_steps() must walk without tripping the
    // model tripwire AND per-party deltas must be exact.
    // ---------------------------------------------------------------------------

    /// EARS 17.5b-3: bilateral same-item swap, counterparty starts at 9999 of item X.
    ///
    /// Net:  counterparty sends 20, receives 15 → post-trade = 9999 − 20 + 15 = 9994 (valid).
    /// The item-destruction bug would credit +15 at count=9999 (drop), debit −20 → 9979.
    /// Debits-first: debit −20 first → 9979, then credit +15 → 9994 (correct, tripwire silent).
    ///
    /// kills: credit-before-debit impl (tripwire fires at old=9999 + incoming=15 > 9999);
    ///        recipient-swap (initiator and counterparty deltas inverted);
    ///        clamp-swallow (tripwire-before-min: assert fires before any min() silences it).
    #[test]
    fn ordered_steps_conservation_same_item_swap_counterparty_at_9999() {
        use crate::currency::MAX_BALANCE;
        const ITEM_X: u32 = 42;

        // Initiator: has 100 of item X, sends 15, receives 20.
        // Counterparty: has 9999 of item X, sends 20, receives 15.
        // Net headroom check: counterparty receives 15, effective count = 9999 − 20 = 9979.
        // 9979 + 15 = 9994 ≤ 9999 → check_headroom Ok.
        let i_items = vec![TradeItem {
            item_id: ITEM_X,
            qty: 15,
        }];
        let c_items = vec![TradeItem {
            item_id: ITEM_X,
            qty: 20,
        }];
        let plan =
            build_swap_plan(&[], &[], &i_items, &c_items, 0, 0).expect("ownership check passes");

        // Headroom check with netted counts (initiator and counterparty both send same item).
        // Initiator receives 20 of ITEM_X; initiator's effective count = 100 − 15 = 85.
        // Counterparty receives 15 of ITEM_X; counterparty's effective count = 9999 − 20 = 9979.
        // Pre-netted stack values derive from plan quantities:
        //   i_stacks[0].current_count = initiator_start(100) − i_items[0].qty(15) = 85
        //   c_stacks[0].current_count = counterparty_start(9999) − c_items[0].qty(20) = 9979
        let i_stacks = vec![ItemStack {
            item_id: ITEM_X,
            current_count: 85, // pre-netted: 100 − i_items[0].qty(15) = 85
        }];
        let c_stacks = vec![ItemStack {
            item_id: ITEM_X,
            current_count: 9979, // pre-netted: 9999 − c_items[0].qty(20) = 9979
        }];
        check_headroom(
            &plan
                .item_transfers
                .iter()
                .filter(|t| !t.from_initiator)
                .map(|t| TradeItem {
                    item_id: t.item_id,
                    qty: t.qty,
                })
                .collect::<Vec<_>>(),
            &i_stacks,
            0,
            MAX_BALANCE,
            &plan
                .item_transfers
                .iter()
                .filter(|t| t.from_initiator)
                .map(|t| TradeItem {
                    item_id: t.item_id,
                    qty: t.qty,
                })
                .collect::<Vec<_>>(),
            &c_stacks,
            0,
            MAX_BALANCE,
        )
        .expect("check_headroom must pass for netted case: 9979+15=9994 ≤ 9999");

        // Build the model and walk ordered_steps().
        let mut model = ModelState::new(&[(ITEM_X, 100)], &[(ITEM_X, 9999)], 0, 0);
        let steps = plan.ordered_steps();
        for step in &steps {
            model.apply(step); // tripwire inside apply() catches credit-before-debit
        }

        // Per-party exact deltas (kills identity-swap / recipient-swap mutants — F2/B-1).
        let i_final = *model.items.get(&(true, ITEM_X)).unwrap_or(&0);
        let c_final = *model.items.get(&(false, ITEM_X)).unwrap_or(&0);
        assert_eq!(
            i_final, 105,
            "initiator: started 100, sent 15, received 20 → expected 105; got {i_final}",
        );
        assert_eq!(
            c_final, 9994,
            "counterparty: started 9999, sent 20, received 15 → expected 9994; got {c_final}",
        );

        // Aggregate conservation: total items in system unchanged.
        let total_before = 100u32 + 9999;
        let total_after = i_final + c_final;
        assert_eq!(
            total_after, total_before,
            "aggregate conservation violated: total before={total_before}, after={total_after}",
        );
    }

    /// EARS 17.5b-3: bilateral same-item swap, counterparty starts at 9998 of item X.
    ///
    /// counterparty sends 20, receives 15 → post-trade = 9998 − 20 + 15 = 9993 (valid).
    /// Verifies the regression at 9998 (not just 9999 boundary).
    ///
    /// kills: same as 9999 case — credit-before-debit (old=9998+15=10013 > cap, tripwire fires).
    #[test]
    fn ordered_steps_conservation_same_item_swap_counterparty_at_9998() {
        use crate::currency::MAX_BALANCE;
        const ITEM_X: u32 = 42;

        let i_items = vec![TradeItem {
            item_id: ITEM_X,
            qty: 15,
        }];
        let c_items = vec![TradeItem {
            item_id: ITEM_X,
            qty: 20,
        }];
        let plan =
            build_swap_plan(&[], &[], &i_items, &c_items, 0, 0).expect("ownership check passes");

        // Pre-netted stack values derive from plan quantities:
        //   i_current_count = initiator_start(100) − i_items[0].qty(15) = 85
        //   c_current_count = counterparty_start(9998) − c_items[0].qty(20) = 9978
        check_headroom(
            &[TradeItem {
                item_id: ITEM_X,
                qty: 20, // counterparty sends c_items[0].qty = 20; initiator receives this
            }],
            &[ItemStack {
                item_id: ITEM_X,
                current_count: 85, // pre-netted: 100 − i_items[0].qty(15) = 85
            }],
            0,
            MAX_BALANCE,
            &[TradeItem {
                item_id: ITEM_X,
                qty: 15, // initiator sends i_items[0].qty = 15; counterparty receives this
            }],
            &[ItemStack {
                item_id: ITEM_X,
                current_count: 9978, // pre-netted: 9998 − c_items[0].qty(20) = 9978
            }],
            0,
            MAX_BALANCE,
        )
        .expect("check_headroom: 9978+15=9993 ≤ 9999");

        let mut model = ModelState::new(&[(ITEM_X, 100)], &[(ITEM_X, 9998)], 0, 0);
        for step in &plan.ordered_steps() {
            model.apply(step);
        }

        let i_final = *model.items.get(&(true, ITEM_X)).unwrap_or(&0);
        let c_final = *model.items.get(&(false, ITEM_X)).unwrap_or(&0);
        assert_eq!(
            i_final, 105,
            "initiator: 100 − 15 + 20 = 105; got {i_final}",
        );
        assert_eq!(
            c_final, 9993,
            "counterparty: 9998 − 20 + 15 = 9993; got {c_final}",
        );
        assert_eq!(
            i_final + c_final,
            100 + 9998,
            "aggregate conservation failed",
        );
    }

    /// EARS 17.5b-3: genuine over-cap net → check_headroom Err BEFORE any walk.
    ///
    /// counterparty at 9999, receives 20 net (sends 0) — effective count 9999 + 20 > cap.
    /// `check_headroom` must Err; the model is never walked (honesty: no model assertion
    /// needed — the Err is the precondition; production rollback is SpacetimeDB atomicity).
    ///
    /// kills: netting removed from check_headroom → false-accept on genuine over-cap.
    #[test]
    fn ordered_steps_genuine_over_cap_rejected_before_walk() {
        use crate::currency::MAX_BALANCE;
        const ITEM_X: u32 = 7;

        // Initiator sends 20 of ITEM_X; counterparty has 9999, sends 0.
        // Counterparty receives 20: 9999 + 20 = 10019 > MAX_ITEM_STACK → must Err.
        let result = check_headroom(
            &[], // initiator receives nothing
            &[],
            0,
            MAX_BALANCE,
            &[TradeItem {
                item_id: ITEM_X,
                qty: 20,
            }], // counterparty receives 20
            &[ItemStack {
                item_id: ITEM_X,
                current_count: 9999,
            }],
            0,
            MAX_BALANCE,
        );
        assert!(
            result.is_err(),
            "genuine over-cap (9999 + 20 = 10019 > MAX_ITEM_STACK): \
             check_headroom must return Err before any walk; got Ok"
        );
        assert_eq!(
            result.unwrap_err(),
            TradeError::ItemStackCapExceeded { item_id: ITEM_X },
            "expected ItemStackCapExceeded for item {ITEM_X}",
        );
        // Model intentionally NOT walked — Err precondition guarantees no mutation.
        // (Production safety = SpacetimeDB reducer-Err transaction rollback, ADR-0123.)
    }

    // ---------------------------------------------------------------------------
    // A2 — proptest: constructive near-cap generation, never-trip + conservation
    //
    // EARS 17.5b-1/2/3 (all): property that for ANY constructively-generated
    // bilateral swap (qty bounded by remaining netted headroom), walking
    // ordered_steps() never trips the model tripwire and per-party + aggregate
    // totals are conserved exactly.
    //
    // Constructive generation (N-2/F10): qty bounded so netted headroom passes —
    // NOT prop_assume! rejection sampling, which would filter out the near-cap region.
    // The near-cap region is exactly the regression territory.
    //
    // House trap: no inline format captures in prop_assert! messages (prior slice
    // M17a hit a clippy/build issue).  Use positional args like `{}` + separate vals.
    // ---------------------------------------------------------------------------

    use proptest::prelude::*;

    proptest! {
        /// EARS 17.5b-1/2/3 (property): constructive near-cap swap never trips the model
        /// tripwire and conserves exactly per-party and aggregate item quantities.
        ///
        /// Generation: initiator and counterparty each start with a count in [0, MAX_ITEM_STACK].
        /// Send qty bounded by current count (can't send more than held).
        /// Receive qty bounded by (MAX_ITEM_STACK − effective_count_after_send) to stay within cap.
        /// This ensures check_headroom passes AND exercises the near-cap region.
        ///
        /// kills: reversed iteration order in ordered_steps(); netting reversed;
        ///        any permutation that puts a credit before its corresponding debit.
        #[test]
        fn prop_ordered_steps_conservation_no_tripwire(
            i_start in 0u32..=MAX_ITEM_STACK,
            c_start in 0u32..=MAX_ITEM_STACK,
            // Initiator sends at most what it holds.
            i_send in 0u32..=MAX_ITEM_STACK,
            // Counterparty sends at most what it holds.
            c_send in 0u32..=MAX_ITEM_STACK,
        ) {
            use crate::currency::MAX_BALANCE;
            const ITEM_ID: u32 = 1;

            // AMENDMENT 1 (BLOCKER): build plan quantities constructively so that
            // check_headroom, the model walk, and the expected-delta assertions are
            // all consistent with each other.  No prop_assume!
            //
            // Variables (all u32, no wrap risk):
            //   i_offer  = how many items initiator sends TO counterparty (≤ i_start)
            //   c_offer  = how many items counterparty sends TO initiator (≤ c_start)
            //   After applying the plan:
            //     initiator  = i_start − i_offer + c_offer
            //     counterparty = c_start − c_offer + i_offer
            //
            // Constructive bound for c_offer (how many counterparty sends to initiator):
            //   initiator's effective stack after its own debit = i_start − i_offer.
            //   Headroom available for incoming items = MAX_ITEM_STACK − (i_start − i_offer).
            //   c_offer ≤ min(c_start, i_headroom)  →  check_headroom guaranteed to pass.
            //
            // Clamp to available stock first.
            let i_offer = i_send.min(i_start); // initiator sends i_offer items to counterparty
            let c_offer_raw = c_send.min(c_start); // counterparty intends to send c_offer_raw items

            // Initiator's effective post-debit stack, and remaining headroom for incoming items.
            let i_eff = i_start - i_offer; // safe: i_offer ≤ i_start
            let i_headroom = MAX_ITEM_STACK.saturating_sub(i_eff); // space for counterparty's items

            // Counterparty's effective post-debit stack, and remaining headroom.
            let c_offer = c_offer_raw.min(i_headroom); // bound c_offer to initiator's headroom
            let c_eff = c_start - c_offer; // safe: c_offer ≤ c_offer_raw ≤ c_start
            let c_headroom = MAX_ITEM_STACK.saturating_sub(c_eff); // space for initiator's items
            // Also bound i_offer to counterparty's headroom (they receive i_offer items).
            let i_offer = i_offer.min(c_headroom);
            // Recompute i_eff after the second clamp (may be tighter now).
            let i_eff = i_start - i_offer;

            // For a bilateral same-item swap the plan's item_transfers has one entry per side.
            // We only add transfers when qty > 0 (mirrors build_swap_plan's >0 filter).
            let mut i_items_vec: Vec<TradeItem> = Vec::new(); // initiator offers i_offer to counterparty
            let mut c_items_vec: Vec<TradeItem> = Vec::new(); // counterparty offers c_offer to initiator
            if i_offer > 0 {
                i_items_vec.push(TradeItem { item_id: ITEM_ID, qty: i_offer });
            }
            if c_offer > 0 {
                c_items_vec.push(TradeItem { item_id: ITEM_ID, qty: c_offer });
            }

            // Skip vacuous cases — no transfers means no steps to test.
            if i_items_vec.is_empty() && c_items_vec.is_empty() {
                return Ok(());
            }

            let plan = build_swap_plan(&[], &[], &i_items_vec, &c_items_vec, 0, 0)
                .expect("ownership always valid in constructive test");

            // Verify check_headroom passes with effective stacks and plan quantities.
            // initiator receives c_offer items; effective stack = i_eff (after sending i_offer).
            // counterparty receives i_offer items; effective stack = c_eff (after sending c_offer).
            // Guarantee: i_eff + c_offer ≤ MAX_ITEM_STACK (c_offer ≤ i_headroom = MAX−i_eff).
            //            c_eff + i_offer ≤ MAX_ITEM_STACK (i_offer ≤ c_headroom = MAX−c_eff).
            let mut i_recv_items: Vec<TradeItem> = Vec::new();
            let mut c_recv_items: Vec<TradeItem> = Vec::new();
            let mut i_recv_stacks: Vec<ItemStack> = Vec::new();
            let mut c_recv_stacks: Vec<ItemStack> = Vec::new();

            if c_offer > 0 {
                // initiator receives c_offer items
                i_recv_items.push(TradeItem { item_id: ITEM_ID, qty: c_offer });
                i_recv_stacks.push(ItemStack { item_id: ITEM_ID, current_count: i_eff });
            }
            if i_offer > 0 {
                // counterparty receives i_offer items
                c_recv_items.push(TradeItem { item_id: ITEM_ID, qty: i_offer });
                c_recv_stacks.push(ItemStack { item_id: ITEM_ID, current_count: c_eff });
            }

            let hr = check_headroom(
                &i_recv_items,
                &i_recv_stacks,
                0,
                MAX_BALANCE,
                &c_recv_items,
                &c_recv_stacks,
                0,
                MAX_BALANCE,
            );
            prop_assert!(
                hr.is_ok(),
                "constructive headroom check failed: i_start={} i_offer={} c_start={} c_offer={}",
                i_start, i_offer, c_start, c_offer
            );

            let mut model = ModelState::new(
                &[(ITEM_ID, i_start)],
                &[(ITEM_ID, c_start)],
                0,
                0,
            );

            for step in &plan.ordered_steps() {
                // apply() contains the tripwire assert — panics if credit-before-debit.
                model.apply(step);
            }

            let i_final = *model.items.get(&(true, ITEM_ID)).unwrap_or(&0);
            let c_final = *model.items.get(&(false, ITEM_ID)).unwrap_or(&0);
            // Expected: initiator loses i_offer, gains c_offer (counterparty's send).
            // counterparty loses c_offer, gains i_offer.
            let expected_i = i_start - i_offer + c_offer;
            let expected_c = c_start - c_offer + i_offer;

            prop_assert_eq!(
                i_final, expected_i,
                "initiator final={} expected={}: start={} offers={} receives={}",
                i_final, expected_i, i_start, i_offer, c_offer
            );
            prop_assert_eq!(
                c_final, expected_c,
                "counterparty final={} expected={}: start={} offers={} receives={}",
                c_final, expected_c, c_start, c_offer, i_offer
            );

            // Aggregate conservation: total items in system = i_start + c_start (transfers cancel).
            prop_assert_eq!(
                i_final + c_final,
                i_start + c_start,
                "aggregate conservation violated: i_final={} c_final={} i_start={} c_start={}",
                i_final, c_final, i_start, c_start
            );
        }
    }

    // ---------------------------------------------------------------------------
    // A3 — contract teeth: partition, step-content parity, zero-currency, netting
    // sensitivity, and broke-sender boundary.
    // ---------------------------------------------------------------------------

    /// EARS 17.5b-1: strict partition — ALL ItemDebit/CurrencyDebit strictly before
    /// ANY ItemCredit/CurrencyCredit in ordered_steps().
    ///
    /// kills: phase-swap (credits emitted first); interleave (debit between credits).
    /// NOTE: "dropped arm" (a debit or credit variant missing entirely) is NOT killed
    /// by this partition test — a debits-only or credits-only sequence passes it.
    /// The dropped-arm kill is covered by ordered_steps_step_content_parity below.
    #[test]
    fn ordered_steps_partition_debits_strictly_before_credits() {
        let i_items = vec![TradeItem { item_id: 1, qty: 5 }];
        let c_items = vec![TradeItem { item_id: 2, qty: 3 }];
        let plan = build_swap_plan(&[], &[], &i_items, &c_items, 100, 200).expect("valid plan");
        let steps = plan.ordered_steps();

        // Verify the list is non-empty (we have both items and currency on both sides).
        assert!(
            !steps.is_empty(),
            "ordered_steps() must return at least one step for a plan with transfers"
        );

        // Walk the list: find the first credit, then verify no debit follows it.
        let mut seen_credit = false;
        for (idx, step) in steps.iter().enumerate() {
            let is_debit = matches!(
                step,
                ApplyStep::ItemDebit { .. } | ApplyStep::CurrencyDebit { .. }
            );
            let is_credit = matches!(
                step,
                ApplyStep::ItemCredit { .. } | ApplyStep::CurrencyCredit { .. }
            );
            if is_credit {
                seen_credit = true;
            }
            if is_debit && seen_credit {
                panic!(
                    "partition violated: debit step at index {} appears AFTER a credit step; \
                     ALL debits must precede ALL credits — kills phase-swap and interleave mutants",
                    idx
                );
            }
        }
    }

    /// EARS 17.5b-1: step-content parity (F1) — for every ItemTransfer in the plan,
    /// ordered_steps() emits exactly ONE ItemDebit and ONE ItemCredit with:
    ///   - ItemDebit:  (from_initiator, item_id, qty) matches the transfer exactly.
    ///   - ItemCredit: (to_initiator == !from_initiator, item_id, SAME qty).
    ///
    /// Also covers CurrencyTransfer parity identically.
    ///
    /// kills: qty-divergence value-printing mutant (debit 5 but credit 4);
    ///        emission-side identity-swap (debit from wrong party, credit to wrong party);
    ///        dropped arm (ItemDebit emitted but no corresponding ItemCredit, or vice versa —
    ///        the exact-count assertions catch both a debits-only and a credits-only impl).
    #[test]
    fn ordered_steps_step_content_parity() {
        let i_items = vec![TradeItem {
            item_id: 10,
            qty: 7,
        }];
        let c_items = vec![TradeItem {
            item_id: 20,
            qty: 3,
        }];
        let plan = build_swap_plan(&[], &[], &i_items, &c_items, 100, 250).expect("valid plan");
        let steps = plan.ordered_steps();

        // Gross-count guard: total steps must equal 2 × (item_transfers + currency_transfers).
        // Each transfer produces exactly one debit and one credit step.
        // Fails an impl that emits extra phantom steps or collapses debit+credit into one step.
        assert_eq!(
            steps.len(),
            2 * (plan.item_transfers.len() + plan.currency_transfers.len()),
            "gross step count wrong: expected 2 × ({} items + {} currencies) = {}; got {}",
            plan.item_transfers.len(),
            plan.currency_transfers.len(),
            2 * (plan.item_transfers.len() + plan.currency_transfers.len()),
            steps.len()
        );

        // --- item parity for initiator's transfer (item_id=10, qty=7, from_initiator=true) ---
        let item10_debits: Vec<_> = steps
            .iter()
            .filter_map(|s| match s {
                ApplyStep::ItemDebit {
                    from_initiator,
                    item_id,
                    qty,
                } if *item_id == 10 => Some((*from_initiator, *qty)),
                _ => None,
            })
            .collect();
        assert_eq!(
            item10_debits.len(),
            1,
            "expected exactly 1 ItemDebit for item_id=10; got {}",
            item10_debits.len()
        );
        assert_eq!(
            item10_debits[0],
            (true, 7),
            "ItemDebit for item_id=10: expected (from_initiator=true, qty=7); got {:?}",
            item10_debits[0]
        );

        let item10_credits: Vec<_> = steps
            .iter()
            .filter_map(|s| match s {
                ApplyStep::ItemCredit {
                    to_initiator,
                    item_id,
                    qty,
                } if *item_id == 10 => Some((*to_initiator, *qty)),
                _ => None,
            })
            .collect();
        assert_eq!(
            item10_credits.len(),
            1,
            "expected exactly 1 ItemCredit for item_id=10; got {}",
            item10_credits.len()
        );
        assert_eq!(
            item10_credits[0],
            (false, 7), // to_initiator = !from_initiator = false (counterparty receives)
            "ItemCredit for item_id=10: expected (to_initiator=false, qty=7); got {:?}",
            item10_credits[0]
        );

        // --- item parity for counterparty's transfer (item_id=20, qty=3, from_initiator=false) ---
        let item20_debits: Vec<_> = steps
            .iter()
            .filter_map(|s| match s {
                ApplyStep::ItemDebit {
                    from_initiator,
                    item_id,
                    qty,
                } if *item_id == 20 => Some((*from_initiator, *qty)),
                _ => None,
            })
            .collect();
        assert_eq!(
            item20_debits.len(),
            1,
            "expected exactly 1 ItemDebit for item_id=20; got {}",
            item20_debits.len()
        );
        assert_eq!(
            item20_debits[0],
            (false, 3),
            "ItemDebit for item_id=20: expected (from_initiator=false, qty=3); got {:?}",
            item20_debits[0]
        );

        let item20_credits: Vec<_> = steps
            .iter()
            .filter_map(|s| match s {
                ApplyStep::ItemCredit {
                    to_initiator,
                    item_id,
                    qty,
                } if *item_id == 20 => Some((*to_initiator, *qty)),
                _ => None,
            })
            .collect();
        assert_eq!(
            item20_credits.len(),
            1,
            "expected exactly 1 ItemCredit for item_id=20; got {}",
            item20_credits.len()
        );
        assert_eq!(
            item20_credits[0],
            (true, 3), // to_initiator = !from_initiator = true (initiator receives)
            "ItemCredit for item_id=20: expected (to_initiator=true, qty=3); got {:?}",
            item20_credits[0]
        );

        // --- currency parity: initiator sends 100, counterparty sends 250 ---
        let currency_debits: Vec<_> = steps
            .iter()
            .filter_map(|s| match s {
                ApplyStep::CurrencyDebit {
                    from_initiator,
                    amount,
                } => Some((*from_initiator, *amount)),
                _ => None,
            })
            .collect();
        assert_eq!(
            currency_debits.len(),
            2,
            "expected 2 CurrencyDebits (one per party); got {}",
            currency_debits.len()
        );

        let currency_credits: Vec<_> = steps
            .iter()
            .filter_map(|s| match s {
                ApplyStep::CurrencyCredit {
                    to_initiator,
                    amount,
                } => Some((*to_initiator, *amount)),
                _ => None,
            })
            .collect();
        assert_eq!(
            currency_credits.len(),
            2,
            "expected 2 CurrencyCredits (one per party); got {}",
            currency_credits.len()
        );

        // Initiator's CurrencyDebit (amount=100, from_initiator=true) → CurrencyCredit to counterparty (to_initiator=false).
        let i_debit = currency_debits.iter().find(|&&(fi, _)| fi).copied();
        assert!(i_debit.is_some(), "no initiator CurrencyDebit found");
        assert_eq!(
            i_debit.unwrap().1,
            100,
            "initiator CurrencyDebit amount must be 100; got {}",
            i_debit.unwrap().1
        );
        let i_to_cp = currency_credits.iter().find(|&&(ti, _)| !ti).copied();
        assert!(i_to_cp.is_some(), "no CurrencyCredit to counterparty found");
        assert_eq!(
            i_to_cp.unwrap().1,
            100,
            "CurrencyCredit to counterparty must be 100 (same as initiator debit); got {}",
            i_to_cp.unwrap().1
        );

        // Counterparty's CurrencyDebit (amount=250, from_initiator=false) → CurrencyCredit to initiator (to_initiator=true).
        let c_debit = currency_debits.iter().find(|&&(fi, _)| !fi).copied();
        assert!(c_debit.is_some(), "no counterparty CurrencyDebit found");
        assert_eq!(
            c_debit.unwrap().1,
            250,
            "counterparty CurrencyDebit amount must be 250; got {}",
            c_debit.unwrap().1
        );
        let c_to_i = currency_credits.iter().find(|&&(ti, _)| ti).copied();
        assert!(c_to_i.is_some(), "no CurrencyCredit to initiator found");
        assert_eq!(
            c_to_i.unwrap().1,
            250,
            "CurrencyCredit to initiator must be 250 (same as counterparty debit); got {}",
            c_to_i.unwrap().1
        );
    }

    /// EARS 17.5b-1 (N-1): zero-currency plan emits NO currency steps.
    ///
    /// `build_swap_plan` already filters >0 currency into `currency_transfers`;
    /// `ordered_steps()` must mirror that filter — no phantom CurrencyDebit/Credit
    /// steps when no currency is involved.
    ///
    /// kills: impl that unconditionally emits CurrencyDebit/CurrencyCredit for
    ///        both parties regardless of transfer amounts.
    #[test]
    fn ordered_steps_zero_currency_emits_no_currency_steps() {
        let i_items = vec![TradeItem { item_id: 5, qty: 2 }];
        let c_items = vec![TradeItem { item_id: 6, qty: 1 }];
        let plan = build_swap_plan(&[], &[], &i_items, &c_items, 0, 0).expect("valid plan");
        let steps = plan.ordered_steps();

        let has_currency_step = steps.iter().any(|s| {
            matches!(
                s,
                ApplyStep::CurrencyDebit { .. } | ApplyStep::CurrencyCredit { .. }
            )
        });
        assert!(
            !has_currency_step,
            "zero-currency plan must emit no CurrencyDebit or CurrencyCredit steps; \
             got {} currency steps",
            steps
                .iter()
                .filter(|s| matches!(
                    s,
                    ApplyStep::CurrencyDebit { .. } | ApplyStep::CurrencyCredit { .. }
                ))
                .count()
        );
    }

    /// EARS 17.5b-2: currency netting asymmetric sensitivity (F7).
    ///
    /// Chosen scenario (correct→Err, swapped→Ok flip):
    ///   initiator_balance = MAX_BALANCE − 50; initiator sends 200; receives 100.
    ///   counterparty_balance = MAX_BALANCE − 50; counterparty sends 100; receives 200.
    ///
    ///   Correct netting:
    ///     i_effective = (MAX_BALANCE−50) sat_sub 200 = MAX_BALANCE−250; +100 = MAX_BALANCE−150 → Ok.
    ///     c_effective = (MAX_BALANCE−50) sat_sub 100 = MAX_BALANCE−150; +200 = MAX_BALANCE+50 → Err.
    ///   → correct result: Err.
    ///
    ///   Swapped netting (counterparty's outgoing used for initiator and vice versa):
    ///     i_eff_swapped = (MAX_BALANCE−50) sat_sub 100 = MAX_BALANCE−150; +100 = MAX_BALANCE−50 → Ok.
    ///     c_eff_swapped = (MAX_BALANCE−50) sat_sub 200 = MAX_BALANCE−250; +200 = MAX_BALANCE−50 → Ok.
    ///   → swapped result: Ok.
    ///   FLIP: correct=Err, swapped=Ok — the two subtrahends are NOT interchangeable.
    ///
    /// kills: impl that swaps initiator_outgoing / counterparty_outgoing subtrahends (F7).
    #[test]
    fn check_headroom_currency_netting_asymmetric_sensitivity() {
        use crate::currency::MAX_BALANCE;

        // Balances and transfer amounts chosen so the result FLIPS if subtrahends are swapped.
        // initiator_balance = MAX_BALANCE − 50; initiator_sends = 200; initiator_receives = 100.
        // counterparty_balance = MAX_BALANCE − 50; counterparty_sends = 100; counterparty_receives = 200.
        let i_balance = MAX_BALANCE - 50;
        let c_balance = MAX_BALANCE - 50;
        let i_sends = 200u64;
        let c_sends = 100u64;

        // Correct netting: i_effective = i_balance sat_sub i_sends; c_effective = c_balance sat_sub c_sends.
        let i_effective = i_balance.saturating_sub(i_sends); // MAX_BALANCE − 250
        let c_effective = c_balance.saturating_sub(c_sends); // MAX_BALANCE − 150

        // initiator receives counterparty_sends=100; counterparty receives initiator_sends=200.
        let correct_result = check_headroom(
            &[], // items empty — currency only
            &[],
            c_sends, // initiator receives c_sends=100
            i_effective,
            &[],
            &[],
            i_sends, // counterparty receives i_sends=200
            c_effective,
        );

        // c_effective + i_sends = (MAX_BALANCE − 150) + 200 = MAX_BALANCE + 50 > MAX_BALANCE → Err.
        assert!(
            correct_result.is_err(),
            "correct netting: c_effective + i_sends = {} + {} = {} should exceed MAX_BALANCE={}; \
             expected Err but got Ok",
            c_effective,
            i_sends,
            c_effective + i_sends,
            MAX_BALANCE
        );

        // Swapped netting: i_effective_swapped = i_balance sat_sub c_sends; c_effective_swapped = c_balance sat_sub i_sends.
        let i_effective_swapped = i_balance.saturating_sub(c_sends); // MAX_BALANCE − 150
        let c_effective_swapped = c_balance.saturating_sub(i_sends); // MAX_BALANCE − 250

        let swapped_result = check_headroom(
            &[],
            &[],
            c_sends,
            i_effective_swapped,
            &[],
            &[],
            i_sends,
            c_effective_swapped,
        );

        // With swapped netting: c_effective_swapped + i_sends = (MAX_BALANCE − 250) + 200 = MAX_BALANCE − 50 → Ok.
        assert!(
            swapped_result.is_ok(),
            "swapped netting produces Ok — this sensitivity case proves \
             the two subtrahends are NOT interchangeable; a swapped impl would \
             return Ok here when the correct netting returns Err; got {:?}",
            swapped_result
        );
        // The flip: correct=Err, swapped=Ok proves field-swap is detectable (F7/17.5b-2).
    }

    /// EARS 17.5b-2: broke-sender boundary (M-2/F3).
    ///
    /// Scenario: initiator's outgoing > live balance (broke sender), netted
    /// effective = saturating_sub → 0, incoming 100 → 0 + 100 = 100 ≤ MAX_BALANCE.
    /// check_headroom PASSES (cap-wise); the real rejection site is `spend_currency`
    /// inside the step loop → whole-reducer transaction rollback (SpacetimeDB atomicity,
    /// ADR-0123). This division of labor is explicit and documented.
    ///
    /// kills: impl that adds a broke-sender check in check_headroom (which would
    ///        move the rejection responsibility and change the API contract).
    #[test]
    fn check_headroom_broke_sender_passes_cap_check() {
        use crate::currency::MAX_BALANCE;

        // initiator has balance=50, sends 200 (outgoing > balance → broke).
        // Receives 100 from counterparty.
        // Correct netting: i_effective = 50 sat_sub 200 = 0; 0 + 100 = 100 ≤ MAX_BALANCE → Ok.
        // check_headroom is cap-only; spend_currency is the broke-sender rejection site.
        let i_balance: u64 = 50;
        let i_sends: u64 = 200; // broke: outgoing > balance
        let i_receives: u64 = 100;

        let i_effective = i_balance.saturating_sub(i_sends); // = 0
        assert_eq!(
            i_effective, 0,
            "saturating_sub(50, 200) must be 0 for the broke-sender netting"
        );

        let result = check_headroom(
            &[],
            &[],
            i_receives,  // initiator receives 100
            i_effective, // effective balance = 0 (broke sender, sat_sub to 0)
            &[],
            &[],
            0, // counterparty receives nothing
            MAX_BALANCE,
        );

        assert!(
            result.is_ok(),
            "broke-sender boundary: check_headroom must PASS (cap-wise); \
             the real rejection is spend_currency inside the step loop \
             (SpacetimeDB reducer-Err transaction rollback, ADR-0123). \
             Got: {:?}",
            result
        );
        // Doc-comment: the division of labor is intentional and unchanged by this slice.
        // spend_currency Err causes whole-reducer rollback → both inventories unchanged.
    }

    // ===========================================================================
    // m17.5c — check_item_headroom / check_currency_headroom boundary tests
    //
    // These tests reference `check_item_headroom` and `check_currency_headroom`,
    // which do NOT yet exist in rules.rs.  They will not compile until the
    // implementer adds them — that is intentional (RED phase, EARS 17.5c-1/-2).
    //
    // EARS criteria:
    //   17.5c-1  buy SHALL return Err and refund (reject-not-destroy) if granting
    //            qty items would exceed MAX_ITEM_STACK for the buyer.
    //   17.5c-2  sell SHALL return Err (reject-not-destroy) if granting the
    //            currency proceeds would exceed MAX_BALANCE for the seller.
    //
    // Primitive contracts (plan §Design, gate ownership B-1/F11):
    //   check_item_headroom(current_count, incoming_qty, item_id) → Result<(), TradeError>
    //     Err(ItemStackCapExceeded { item_id }) iff
    //       current_count.saturating_add(incoming_qty) > MAX_ITEM_STACK.
    //     Exact-fill to cap is Ok.
    //
    //   check_currency_headroom(balance, incoming) → Result<(), TradeError>
    //     The `incoming > 0` gate is the FIRST line.
    //     Err(CurrencyCapExceeded) iff
    //       incoming > 0 && balance.saturating_add(incoming) > MAX_BALANCE.
    //     Exact-fill to cap is Ok.
    //     incoming == 0 is ALWAYS Ok, even when balance > MAX_BALANCE (absolute-balance
    //     policing is NOT the contract of this primitive — the caller passes balance
    //     through exactly, no .min(MAX_BALANCE) normalization).
    // ===========================================================================

    // ---------------------------------------------------------------------------
    // check_item_headroom — item stack receiver-cap
    // ---------------------------------------------------------------------------

    /// 17.5c-1 REJECT: 9980 + 50 = 10030 > MAX_ITEM_STACK (9999) → Err.
    /// Asserts both the exact variant AND the item_id payload (not just is_err()).
    ///
    /// kills: impl that clamps via grant_item instead of rejecting — a clamp would
    ///        return Ok here, allowing the buyer to pay for 50 items but receive only
    ///        19 (silent value destruction).
    #[test]
    fn check_item_headroom_rejects_over_cap() {
        let result = check_item_headroom(9980, 50, 1);
        assert_eq!(
            result.unwrap_err(),
            TradeError::ItemStackCapExceeded { item_id: 1 },
            "9980 + 50 = 10030 > MAX_ITEM_STACK (9999): must return \
             Err(ItemStackCapExceeded {{ item_id: 1 }})"
        );
    }

    /// 17.5c-1 REJECT AT CAP: current_count = MAX_ITEM_STACK, incoming = 1 → Err.
    /// The item_id payload must be 7 (the passed argument).
    ///
    /// kills: impl using >= for the cap comparison (would accept this and reject
    ///        the exact-fill case check_item_headroom_accepts_exact_fill instead).
    #[test]
    fn check_item_headroom_rejects_at_cap_plus_one() {
        let result = check_item_headroom(MAX_ITEM_STACK, 1, 7);
        assert_eq!(
            result.unwrap_err(),
            TradeError::ItemStackCapExceeded { item_id: 7 },
            "current=MAX_ITEM_STACK, incoming=1: sum > MAX_ITEM_STACK, must return \
             Err(ItemStackCapExceeded {{ item_id: 7 }})"
        );
    }

    /// 17.5c-1 ACCEPT EXACT-FILL: 9980 + 19 = 9999 = MAX_ITEM_STACK → Ok.
    ///
    /// kills: impl using >= for the cap comparison (would incorrectly reject a trade
    ///        that exactly fills the receiver's stack to the cap).
    #[test]
    fn check_item_headroom_accepts_exact_fill() {
        let result = check_item_headroom(9980, 19, 2);
        assert!(
            result.is_ok(),
            "9980 + 19 = 9999 = MAX_ITEM_STACK: exact-fill must be Ok (not rejected)"
        );
    }

    /// 17.5c-1 ACCEPT NEW RECEIVER: 0 + MAX_ITEM_STACK → Ok.
    ///
    /// kills: impl that treats a missing inventory row as an error, or that defaults
    ///        current_count to something other than 0 (full stack from empty is valid).
    #[test]
    fn check_item_headroom_accepts_new_receiver_full_stack() {
        let result = check_item_headroom(0, MAX_ITEM_STACK, 5);
        assert!(
            result.is_ok(),
            "0 + MAX_ITEM_STACK = MAX_ITEM_STACK: exact cap from zero must be Ok"
        );
    }

    /// 17.5c-1 REJECT NEW RECEIVER OVER CAP: 0 + 10_000 > MAX_ITEM_STACK → Err.
    ///
    /// kills: unwrap_or-style bypass where an impl skips the check when
    ///        current_count == 0 (zero-default early-return), or where the comparison
    ///        uses the current_count as the left operand rather than the sum.
    #[test]
    fn check_item_headroom_rejects_new_receiver_over_cap() {
        let result = check_item_headroom(0, 10_000, 3);
        assert_eq!(
            result.unwrap_err(),
            TradeError::ItemStackCapExceeded { item_id: 3 },
            "0 + 10000 = 10000 > MAX_ITEM_STACK (9999): even a zero-count receiver \
             must be rejected when incoming_qty exceeds cap"
        );
    }

    // ---------------------------------------------------------------------------
    // check_currency_headroom — currency balance receiver-cap
    // ---------------------------------------------------------------------------

    /// 17.5c-2 REJECT: (MAX_BALANCE - 49) + 50 = MAX_BALANCE + 1 > MAX_BALANCE → Err.
    ///
    /// kills: impl that clamps via grant_currency's saturating add instead of
    ///        rejecting — a clamp would return Ok, silently destroying 1 unit of
    ///        currency that the player sold items to earn.
    #[test]
    fn check_currency_headroom_rejects_over_cap() {
        use crate::currency::MAX_BALANCE;
        let result = check_currency_headroom(MAX_BALANCE - 49, 50);
        assert_eq!(
            result.unwrap_err(),
            TradeError::CurrencyCapExceeded,
            "(MAX_BALANCE - 49) + 50 = MAX_BALANCE + 1 > MAX_BALANCE: must return \
             Err(CurrencyCapExceeded)"
        );
    }

    /// 17.5c-2 REJECT AT CAP: balance = MAX_BALANCE, incoming = 1 → Err.
    ///
    /// kills: impl using >= for the cap comparison (would accept this and reject
    ///        the exact-fill case instead).
    #[test]
    fn check_currency_headroom_rejects_at_max_balance_plus_one() {
        use crate::currency::MAX_BALANCE;
        let result = check_currency_headroom(MAX_BALANCE, 1);
        assert_eq!(
            result.unwrap_err(),
            TradeError::CurrencyCapExceeded,
            "balance=MAX_BALANCE, incoming=1: sum > MAX_BALANCE, must return \
             Err(CurrencyCapExceeded)"
        );
    }

    /// 17.5c-2 ACCEPT EXACT-FILL: (MAX_BALANCE - 49) + 49 = MAX_BALANCE → Ok.
    ///
    /// kills: impl using >= for the cap comparison (would incorrectly reject a sell
    ///        that exactly fills the seller's wallet to the cap).
    #[test]
    fn check_currency_headroom_accepts_exact_fill() {
        use crate::currency::MAX_BALANCE;
        let result = check_currency_headroom(MAX_BALANCE - 49, 49);
        assert!(
            result.is_ok(),
            "(MAX_BALANCE - 49) + 49 = MAX_BALANCE: exact-fill must be Ok (not rejected)"
        );
    }

    /// 17.5c-2 GATE: incoming = 0 → Ok unconditionally (skip-guard).
    /// The `incoming > 0` gate is the FIRST line of check_currency_headroom.
    ///
    /// kills: impl that deletes the `incoming > 0` guard — without the gate, a
    ///        zero-incoming call with balance > MAX_BALANCE would incorrectly return
    ///        Err (balance.saturating_add(0) = balance > MAX_BALANCE → Err).
    #[test]
    fn check_currency_headroom_zero_incoming_is_ok() {
        use crate::currency::MAX_BALANCE;
        let result = check_currency_headroom(MAX_BALANCE, 0);
        assert!(
            result.is_ok(),
            "incoming=0: check_currency_headroom must return Ok unconditionally \
             (gate kills the GATE-DELETION mutant on the `incoming > 0` guard)"
        );
    }

    /// 17.5c-2 GATE PIN (B-1/F11, anti-normalization): incoming = 0, balance = MAX_BALANCE + 1
    /// (deliberately over-cap balance) → Ok.
    ///
    /// The input balance DELIBERATELY exceeds MAX_BALANCE — production cannot produce
    /// this value (economy.rs enforces the invariant).  The test pins the CONTRACT of
    /// the `incoming > 0` skip-guard: check_currency_headroom polices the shop's
    /// incoming credit delta, NOT pre-existing wallet state.  A delegating caller must
    /// pass the balance through EXACTLY — no `.min(MAX_BALANCE)` normalization — so
    /// that the skip-guard of an already-over-cap wallet receiving zero still returns Ok.
    /// Do NOT "fix" this test by policing absolute balance; if the contract ever
    /// changes to do that, revise ADR-0124 first.
    ///
    /// kills: an impl that normalizes the balance argument with `.min(MAX_BALANCE)` before
    ///        delegating — such normalization is invisible when balance ≤ MAX_BALANCE but
    ///        changes the observable contract when balance > MAX_BALANCE, incoming = 0.
    #[test]
    fn check_currency_headroom_zero_incoming_skips_over_cap_balance() {
        use crate::currency::MAX_BALANCE;
        // MAX_BALANCE + 1 violates the wallet invariant deliberately — see doc above.
        // Do NOT "fix" by policing absolute balance; that changes the API contract.
        let result = check_currency_headroom(MAX_BALANCE + 1, 0);
        assert!(
            result.is_ok(),
            "incoming=0, balance=MAX_BALANCE+1 (deliberately over-cap): \
             check_currency_headroom must return Ok — the `incoming > 0` skip-guard \
             must fire BEFORE any balance check, passing balance through unchanged. \
             A normalizing delegation would break this contract (B-1/F11, ADR-0124)."
        );
    }

    /// 17.5c-2 EXTREME: u64::MAX balance, incoming = 1 → Err (saturating_add must not wrap).
    ///
    /// kills: impl that uses wrapping_add instead of saturating_add — wrapping gives
    ///        0, which is ≤ MAX_BALANCE, incorrectly returning Ok.
    #[test]
    fn check_currency_headroom_u64_max_balance_rejects() {
        let result = check_currency_headroom(u64::MAX, 1);
        assert_eq!(
            result.unwrap_err(),
            TradeError::CurrencyCapExceeded,
            "balance=u64::MAX, incoming=1: saturating_add must not wrap; \
             u64::MAX + 1 saturates to u64::MAX > MAX_BALANCE → Err(CurrencyCapExceeded)"
        );
    }
}
