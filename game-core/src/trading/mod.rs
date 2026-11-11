//! `trading` — pure trade rule module.
//!
//! No I/O, no SpacetimeDB types. Defines the shared `MonsterCard` / `TradeStatus` /
//! `TradeItem` types (cfg-gated `SpacetimeType` for the server), the state-machine
//! authorization guards (`authorize_respond` / `authorize_confirm`), the TTL
//! staleness rule (`is_offer_stale`), and the pure `build_swap_plan` that the server
//! applies atomically. `session` holds the trade-session rules: offer eligibility,
//! edits and confirms by revision, the per-side check, the execute verdict,
//! snapshot drift, arrival slots, and the session-open limits and TTL. The server module is the thin imperative
//! shell; this module is the SSOT rule layer.

pub mod rules;
pub mod session;
#[cfg(test)]
mod session_tests;
pub mod types;

pub use rules::{
    authorize_confirm, authorize_respond, build_swap_plan, check_currency_headroom, check_headroom,
    check_item_headroom, is_offer_stale, make_monster_card, validate_proposal, ApplyStep,
    CurrencyTransfer, ItemStack, ItemTransfer, LiveMonsterOwner, MonsterTransfer, ProposalSide,
    SwapPlan, TradeSide, MAX_ITEM_STACK, MAX_TRADE_ITEMS_PER_SIDE, MAX_TRADE_MONSTERS_PER_SIDE,
    TRADE_OFFER_TTL_MS,
};
pub use session::{
    apply_edit, arrival_slots, can_confirm, check_offer_eligibility, check_offer_size,
    check_session_open, is_session_stale, judge_execute, open_session_count, pair_has_open_session,
    reset_confirms, side_check, snapshot_drifted, ExecuteVerdict, MonsterSnapshot, OwnedMonster,
    ReceiptFacts, SessionSide, SideFacts, TradeSessionError, TradeSessionOffer, TradeSessionState,
    MAX_OPEN_TRADE_SESSIONS, TRADE_SESSION_TTL_MS,
};
pub use types::{MonsterCard, TradeError, TradeItem, TradeStatus};
