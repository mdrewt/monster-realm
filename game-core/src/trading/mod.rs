//! `trading` — pure trade rule module (M15, ADR-0106).
//!
//! No I/O, no SpacetimeDB types. Defines the shared `MonsterCard` / `TradeStatus` /
//! `TradeItem` types (cfg-gated `SpacetimeType` for the server), the state-machine
//! transition functions, and the pure `build_swap_plan` that the server applies
//! atomically. The server module is the thin imperative shell; this module is the
//! SSOT rule layer (ADR-0003).

pub mod rules;
pub mod types;

pub use rules::{
    build_swap_plan, make_monster_card, validate_proposal, CurrencyTransfer, ItemTransfer,
    LiveMonsterOwner, MonsterTransfer, ProposalSide, SwapPlan, TradeSide,
};
pub use types::{MonsterCard, TradeError, TradeItem, TradeStatus};
