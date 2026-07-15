//! `trading` — pure trade rule module (M15, ADR-0106).
//!
//! No I/O, no SpacetimeDB types. Defines the shared `MonsterCard` / `TradeStatus` /
//! `TradeItem` types (cfg-gated `SpacetimeType` for the server), the state-machine
//! authorization guards (`authorize_respond` / `authorize_confirm`), the TTL
//! staleness rule (`is_offer_stale`), and the pure `build_swap_plan` that the server
//! applies atomically. The server module is the thin imperative shell; this module
//! is the SSOT rule layer (ADR-0003).

pub mod rules;
pub mod types;

pub use rules::{
    authorize_confirm, authorize_respond, build_swap_plan, check_headroom, is_offer_stale,
    make_monster_card, validate_proposal, CurrencyTransfer, ItemStack, ItemTransfer,
    LiveMonsterOwner, MonsterTransfer, ProposalSide, SwapPlan, TradeSide, MAX_ITEM_STACK,
    TRADE_OFFER_TTL_MS,
};
pub use types::{MonsterCard, TradeError, TradeItem, TradeStatus};
