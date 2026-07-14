//! Trade types shared between game-core (pure rules) and server-module (persistence).
//!
//! `MonsterCard` is the display-only snapshot stored in `trade_offer`: it mirrors
//! the public-projection field set of `MonsterPub` (no IVs/EVs/nature — ADR-0015).
//! `TradeStatus`, `TradeItem`, and `TradeError` drive the offer state machine.
//!
//! `SpacetimeType` derives are cfg-gated: only `server-module` (which enables the
//! `spacetimedb` feature) serializes these for BSATN storage (same pattern as
//! `BattleState` in `combat/types.rs`).

/// Display-only monster snapshot stored inside `trade_offer`.
///
/// MUST NOT contain `iv_*`, `ev_*`, or `nature_kind` fields (ADR-0015 stakes:
/// opponent must be able to see the offered monster without receiving its hidden
/// genes). The authoritative swap re-reads the live `monster` row.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct MonsterCard {
    pub monster_id: u64,
    pub species_id: u32,
    pub nickname: String,
    pub level: u8,
    pub current_hp: u16,
    pub stat_hp: u16,
}

/// One (item_id, qty) pair escrowed in a trade offer.
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct TradeItem {
    pub item_id: u32,
    pub qty: u32,
}

/// Lifecycle state of a `trade_offer` row.
///
/// Terminal states are `Cancelled` — the row is DELETED on entry rather than
/// retained for history (mirrors battle terminal GC in M12.5e). `Confirmed` is
/// NOT a state: a confirmed swap immediately deletes the row.
///
/// State machine:
///   Pending → ConfirmedByCounterparty  (via respond_trade accept)
///   Pending → (row deleted)            (via respond_trade reject | cancel_trade | disconnect)
///   ConfirmedByCounterparty → (row deleted + swap executes)  (via confirm_trade by initiator)
///   ConfirmedByCounterparty → (row deleted)                  (via cancel_trade | disconnect)
#[derive(Clone, Debug, PartialEq)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum TradeStatus {
    Pending,
    ConfirmedByCounterparty,
}

impl TradeStatus {
    /// True for any non-terminal status (offer is active and assets are escrowed).
    pub fn is_active(&self) -> bool {
        match self {
            TradeStatus::Pending | TradeStatus::ConfirmedByCounterparty => true,
        }
    }
}

/// Reason a trade rule rejected a proposal or transition.
#[derive(Clone, Debug, PartialEq)]
pub enum TradeError {
    SelfTrade,
    EmptyOffer,
    AlreadyInTrade,
    MonsterNotOwned,
    DuplicateMonster,
    /// Two TradeItem entries in the same offer side have the same item_id.
    DuplicateItem {
        item_id: u32,
    },
    OwnershipChanged,
    NotInitiator,
    NotCounterparty,
    NotPending,
    NotConfirmedByCounterparty,
    InsufficientInventory {
        item_id: u32,
    },
    InsufficientCurrency {
        available: u64,
    },
}

impl std::fmt::Display for TradeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TradeError::SelfTrade => write!(f, "cannot trade with yourself"),
            TradeError::EmptyOffer => write!(f, "trade offer must include at least one asset"),
            TradeError::AlreadyInTrade => write!(f, "already has an active trade"),
            TradeError::MonsterNotOwned => write!(f, "monster is not owned by the trader"),
            TradeError::DuplicateMonster => write!(f, "duplicate monster_id in trade offer"),
            TradeError::DuplicateItem { item_id } => {
                write!(f, "duplicate item_id {item_id} in trade offer")
            }
            TradeError::OwnershipChanged => {
                write!(f, "asset ownership changed since offer was created")
            }
            TradeError::NotInitiator => {
                write!(f, "only the trade initiator can perform this action")
            }
            TradeError::NotCounterparty => {
                write!(f, "only the trade counterparty can perform this action")
            }
            TradeError::NotPending => write!(f, "trade offer is not in Pending state"),
            TradeError::NotConfirmedByCounterparty => {
                write!(f, "trade offer is not in ConfirmedByCounterparty state")
            }
            TradeError::InsufficientInventory { item_id } => {
                write!(f, "insufficient inventory for item {item_id}")
            }
            TradeError::InsufficientCurrency { available } => {
                write!(f, "insufficient currency (available: {available})")
            }
        }
    }
}
