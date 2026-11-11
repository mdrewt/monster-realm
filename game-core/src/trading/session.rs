//! Trade-session rules: two players each edit their own offer, each confirms the
//! revision they reviewed, and the trade executes once both have.
//!
//! Pure and integer-only. The server reads live rows into the fact types here
//! ([`SideFacts`], [`ReceiptFacts`], [`MonsterSnapshot`]), calls a rule and writes
//! the result. The session's comparisons — size caps, eligibility, holdings, the
//! last-monster count, revisions, the drift mask, arrival slots, the per-pair and
//! per-opener limits — are made here; the receipt caps are the single-receiver
//! headroom checks of `rules`.
//!
//! A side is judged on its own facts plus the other side's offer, which both
//! participants can see. [`judge_execute`] takes the other side's result and
//! discards its reason.

use super::rules::{
    check_currency_headroom, check_item_headroom, ItemStack, MAX_TRADE_ITEMS_PER_SIDE,
    MAX_TRADE_MONSTERS_PER_SIDE,
};
use super::types::{MonsterCard, TradeItem};
use crate::monster::types::NatureKind;
use crate::world::{PARTY_SIZE, PARTY_SLOT_NONE};

/// Most sessions one player may have OPENED at once (inclusive). Sessions another
/// player opened with them never count, so nobody can be locked out of opening.
pub const MAX_OPEN_TRADE_SESSIONS: usize = 4;

/// Trade session time-to-live.
// 1 h — tunable liveness constant, no game-design constraint.
pub const TRADE_SESSION_TTL_MS: i64 = 3_600_000;

/// One side's offer as the session stores it.
///
/// `cards` are the server-built display snapshots of `monster_ids`, in the same
/// order; no rule reads them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TradeSessionOffer {
    pub monster_ids: Vec<u64>,
    pub items: Vec<TradeItem>,
    pub currency: u64,
    pub cards: Vec<MonsterCard>,
}

impl TradeSessionOffer {
    /// True when the offer holds no monster, no item of positive quantity and no
    /// currency.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        holds_nothing(&self.monster_ids, &self.items, self.currency)
    }
}

/// Which participant of a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionSide {
    Opener,
    Partner,
}

/// The session columns the edit and confirm rules read and write.
#[derive(Clone, Debug, PartialEq)]
pub struct TradeSessionState {
    pub opener_offer: TradeSessionOffer,
    pub partner_offer: TradeSessionOffer,
    pub opener_confirmed: bool,
    pub partner_confirmed: bool,
    pub revision: u64,
}

/// The live row of one offered monster that exists AND belongs to the offerer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OwnedMonster {
    pub monster_id: u64,
    pub party_slot: u8,
    pub current_hp: u16,
    /// Listed in ANOTHER active session (confirmed or not) or in an active legacy
    /// trade offer. The session being checked never counts.
    pub in_other_trade: bool,
    /// In an ongoing battle.
    pub in_battle: bool,
}

/// One side's offer together with the live facts its rules read.
///
/// `monster_ids`, `items` and `currency` are the amounts the swap moves: the
/// request while it is being set, the stored offer afterwards. Every other field
/// is a lookup keyed by id; entries for ids the offer does not name are ignored.
#[derive(Clone, Copy, Debug)]
pub struct SideFacts<'a> {
    pub monster_ids: &'a [u64],
    pub items: &'a [TradeItem],
    pub currency: u64,
    /// Rows of the offered monsters the side owns. An offered id with no row here
    /// is not the side's to give — whether it is missing or someone else's.
    pub monster_rows: &'a [OwnedMonster],
    /// The offered item ids that exist in the item registry.
    pub known_item_ids: &'a [u32],
    /// The side's RAW live inventory for every item it offers or is about to
    /// receive; an absent id counts 0, so the caller must supply the row of
    /// every incoming item the side already holds or its receipt cap is not
    /// checked. Never a post-debit count: the receipt rule subtracts the side's
    /// own outgoing quantity itself.
    pub stacks: &'a [ItemStack],
    /// Item quantities the side's OTHER confirmed sessions and active legacy
    /// offers lock; an absent id counts 0. The session being checked never counts.
    pub locked_stacks: &'a [ItemStack],
    /// The side's RAW live wallet.
    pub balance: u64,
    /// Currency the side's OTHER confirmed sessions and active legacy offers
    /// lock. The session being checked never counts.
    pub locked_currency: u64,
}

/// What a side is about to receive.
#[derive(Clone, Copy, Debug)]
pub struct ReceiptFacts<'a> {
    /// Every monster the side owns right now, party and storage alike.
    pub owned_monster_count: usize,
    /// The OTHER side's stored offer. The caller must only ever store an offer
    /// that passed [`check_offer_eligibility`], so that it names no id twice:
    /// the receipt rule checks each incoming entry on its own.
    pub incoming: &'a TradeSessionOffer,
}

/// What the confirm that completes a session does next.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExecuteVerdict {
    /// Both sides passed: run the swap.
    Execute,
    /// The caller's own side failed: refuse the call with their own reason.
    RejectCaller(TradeSessionError),
    /// Only the other side failed: clear that side's confirm, move nothing and
    /// tell the caller nothing more.
    ResetOther,
}

/// Why a session rule refused. `Display` is the string the caller receives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TradeSessionError {
    /// The monster is not the offerer's to give. One reason for a missing
    /// monster and for someone else's, so the answer reveals neither.
    MonsterNotOwned {
        monster_id: u64,
    },
    MonsterNotInParty {
        monster_id: u64,
    },
    MonsterFainted {
        monster_id: u64,
    },
    MonsterInAnotherTrade {
        monster_id: u64,
    },
    MonsterInBattle {
        monster_id: u64,
    },
    DuplicateMonster {
        monster_id: u64,
    },
    TooManyMonsters,
    DuplicateItem {
        item_id: u32,
    },
    ZeroItemQuantity {
        item_id: u32,
    },
    UnknownItem {
        item_id: u32,
    },
    TooManyItems,
    /// The offered quantity exceeds the stack net of what other trades lock.
    InsufficientItems {
        item_id: u32,
    },
    /// The offered currency exceeds the wallet net of what other trades lock.
    InsufficientCurrency,
    OwnSideEmpty,
    OtherSideEmpty,
    /// The trade would leave the side owning no monster.
    LastMonster,
    /// Receiving the item would push the side's own stack past `MAX_ITEM_STACK`.
    ItemStackCapExceeded {
        item_id: u32,
    },
    /// Receiving the currency would push the side's own wallet past `MAX_BALANCE`.
    CurrencyCapExceeded,
    /// The confirm names a revision other than the session's current one.
    StaleRevision,
    /// A confirmed side tried to edit its offer.
    SideConfirmed,
    SelfTrade,
    PairHasOpenSession,
    OpenSessionLimit,
}

impl std::fmt::Display for TradeSessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MonsterNotOwned { monster_id } => {
                write!(f, "monster {monster_id} is not yours to offer")
            }
            Self::MonsterNotInParty { monster_id } => {
                write!(f, "monster {monster_id} is not in your party")
            }
            Self::MonsterFainted { monster_id } => write!(f, "monster {monster_id} has fainted"),
            Self::MonsterInAnotherTrade { monster_id } => {
                write!(f, "monster {monster_id} is already in another trade")
            }
            Self::MonsterInBattle { monster_id } => {
                write!(f, "monster {monster_id} is in an ongoing battle")
            }
            Self::DuplicateMonster { monster_id } => {
                write!(f, "monster {monster_id} is listed more than once")
            }
            Self::TooManyMonsters => write!(
                f,
                "too many monsters in one trade side (max {MAX_TRADE_MONSTERS_PER_SIDE})"
            ),
            Self::DuplicateItem { item_id } => {
                write!(f, "item {item_id} is listed more than once")
            }
            Self::ZeroItemQuantity { item_id } => {
                write!(f, "item {item_id} has a quantity of zero")
            }
            Self::UnknownItem { item_id } => write!(f, "unknown item {item_id}"),
            Self::TooManyItems => write!(
                f,
                "too many items in one trade side (max {MAX_TRADE_ITEMS_PER_SIDE})"
            ),
            Self::InsufficientItems { item_id } => {
                write!(f, "not enough of item {item_id} to offer")
            }
            Self::InsufficientCurrency => write!(f, "not enough currency to offer"),
            Self::OwnSideEmpty => write!(f, "your offer is empty"),
            Self::OtherSideEmpty => write!(f, "the other offer is empty"),
            Self::LastMonster => write!(f, "this trade would leave you with no monsters"),
            Self::ItemStackCapExceeded { item_id } => {
                write!(f, "you cannot hold that many of item {item_id}")
            }
            Self::CurrencyCapExceeded => write!(f, "you cannot hold that much currency"),
            Self::StaleRevision => write!(f, "the trade changed since you reviewed it"),
            Self::SideConfirmed => {
                write!(f, "your offer is confirmed; cancel the trade to change it")
            }
            Self::SelfTrade => write!(f, "cannot trade with yourself"),
            Self::PairHasOpenSession => {
                write!(f, "you already have an open trade with this player")
            }
            Self::OpenSessionLimit => write!(
                f,
                "you have opened too many trades (max {MAX_OPEN_TRADE_SESSIONS})"
            ),
        }
    }
}

/// True when a side lists no monster, no item of positive quantity and no currency.
fn holds_nothing(monster_ids: &[u64], items: &[TradeItem], currency: u64) -> bool {
    monster_ids.is_empty() && items.iter().all(|item| item.qty == 0) && currency == 0
}

/// The count `stacks` records for `item_id`; an id with no entry counts 0.
fn stack_count(stacks: &[ItemStack], item_id: u32) -> u32 {
    stacks
        .iter()
        .find(|stack| stack.item_id == item_id)
        .map_or(0, |stack| stack.current_count)
}

/// The id of the first entry, in list order, that repeats an earlier entry's id.
fn first_repeated_id<T, K: PartialEq>(entries: &[T], id_of: impl Fn(&T) -> K) -> Option<K> {
    entries.iter().enumerate().find_map(|(index, entry)| {
        let id = id_of(entry);
        entries[..index]
            .iter()
            .any(|earlier| id_of(earlier) == id)
            .then_some(id)
    })
}

/// Bound one side's request by count alone: `TooManyMonsters` above
/// [`MAX_TRADE_MONSTERS_PER_SIDE`], else `TooManyItems` above
/// [`MAX_TRADE_ITEMS_PER_SIDE`]. Both caps are inclusive and independent.
///
/// Needs no row, so the server calls it on the raw request before reading
/// anything per id.
pub fn check_offer_size(n_monsters: usize, n_items: usize) -> Result<(), TradeSessionError> {
    if n_monsters > MAX_TRADE_MONSTERS_PER_SIDE {
        return Err(TradeSessionError::TooManyMonsters);
    }
    if n_items > MAX_TRADE_ITEMS_PER_SIDE {
        return Err(TradeSessionError::TooManyItems);
    }
    Ok(())
}

/// Whether a side may offer what it lists. The first failure wins, in this order:
///
/// 1. [`check_offer_size`];
/// 2. a repeated monster id, then a repeated item id;
/// 3. each monster in offer order: not the side's to give, not in the party,
///    fainted, in another trade, in battle;
/// 4. each item in offer order: unknown id, zero quantity, more than the stack
///    net of what other trades lock;
/// 5. more currency than the wallet net of what other trades lock.
///
/// An empty offer is eligible — clearing one's side is a legal edit; emptiness is
/// [`side_check`]'s rule.
pub fn check_offer_eligibility(side: &SideFacts<'_>) -> Result<(), TradeSessionError> {
    check_offer_size(side.monster_ids.len(), side.items.len())?;
    if let Some(monster_id) = first_repeated_id(side.monster_ids, |&id| id) {
        return Err(TradeSessionError::DuplicateMonster { monster_id });
    }
    if let Some(item_id) = first_repeated_id(side.items, |item| item.item_id) {
        return Err(TradeSessionError::DuplicateItem { item_id });
    }
    for &monster_id in side.monster_ids {
        check_offered_monster(side.monster_rows, monster_id)?;
    }
    for item in side.items {
        check_offered_item(side, item)?;
    }
    if side.currency > side.balance.saturating_sub(side.locked_currency) {
        return Err(TradeSessionError::InsufficientCurrency);
    }
    Ok(())
}

fn check_offered_monster(rows: &[OwnedMonster], monster_id: u64) -> Result<(), TradeSessionError> {
    let Some(row) = rows.iter().find(|row| row.monster_id == monster_id) else {
        return Err(TradeSessionError::MonsterNotOwned { monster_id });
    };
    if row.party_slot >= PARTY_SIZE {
        return Err(TradeSessionError::MonsterNotInParty { monster_id });
    }
    if row.current_hp == 0 {
        return Err(TradeSessionError::MonsterFainted { monster_id });
    }
    if row.in_other_trade {
        return Err(TradeSessionError::MonsterInAnotherTrade { monster_id });
    }
    if row.in_battle {
        return Err(TradeSessionError::MonsterInBattle { monster_id });
    }
    Ok(())
}

fn check_offered_item(side: &SideFacts<'_>, item: &TradeItem) -> Result<(), TradeSessionError> {
    let item_id = item.item_id;
    if !side.known_item_ids.contains(&item_id) {
        return Err(TradeSessionError::UnknownItem { item_id });
    }
    if item.qty == 0 {
        return Err(TradeSessionError::ZeroItemQuantity { item_id });
    }
    let unlocked =
        stack_count(side.stacks, item_id).saturating_sub(stack_count(side.locked_stacks, item_id));
    if item.qty > unlocked {
        return Err(TradeSessionError::InsufficientItems { item_id });
    }
    Ok(())
}

/// The full check of one side: run for the confirming side at confirm and for
/// BOTH sides at execute. The first failure wins, in this order:
///
/// 1. the side's own offer is empty, then the other side's offer is empty — a
///    one-sided trade is refused from both seats;
/// 2. [`check_offer_eligibility`] on the live facts;
/// 3. the last-monster guard: the side's post-trade monster count (owned −
///    outgoing + incoming) is zero. The count alone decides, so a side that owns
///    no monster passes only when the trade brings it one, and a trade that
///    leaves the side at least one monster is never refused here;
/// 4. receipt headroom with this side as the RECEIVER: each incoming item against
///    the side's stack, then the incoming currency against its wallet. Debits
///    land before credits, so what the side itself gives of the same item or in
///    currency is subtracted first.
///
/// A receipt that would overflow is therefore reported by the side that would
/// overflow, never by the giver.
pub fn side_check(
    own: &SideFacts<'_>,
    receipt: &ReceiptFacts<'_>,
) -> Result<(), TradeSessionError> {
    let incoming = receipt.incoming;
    if holds_nothing(own.monster_ids, own.items, own.currency) {
        return Err(TradeSessionError::OwnSideEmpty);
    }
    if incoming.is_empty() {
        return Err(TradeSessionError::OtherSideEmpty);
    }
    check_offer_eligibility(own)?;

    let owned_plus_incoming = receipt
        .owned_monster_count
        .saturating_add(incoming.monster_ids.len());
    if owned_plus_incoming <= own.monster_ids.len() {
        return Err(TradeSessionError::LastMonster);
    }

    for received in &incoming.items {
        let item_id = received.item_id;
        let outgoing_qty = own
            .items
            .iter()
            .find(|offered| offered.item_id == item_id)
            .map_or(0, |offered| offered.qty);
        let post_debit = stack_count(own.stacks, item_id).saturating_sub(outgoing_qty);
        check_item_headroom(post_debit, received.qty, item_id)
            .map_err(|_| TradeSessionError::ItemStackCapExceeded { item_id })?;
    }
    check_currency_headroom(own.balance.saturating_sub(own.currency), incoming.currency)
        .map_err(|_| TradeSessionError::CurrencyCapExceeded)
}

/// Whether a side may confirm: `StaleRevision` when the revision it reviewed is
/// not the session's current one — before anything else — and otherwise
/// [`side_check`].
pub fn can_confirm(
    current_revision: u64,
    reviewed_revision: u64,
    own: &SideFacts<'_>,
    receipt: &ReceiptFacts<'_>,
) -> Result<(), TradeSessionError> {
    if reviewed_revision != current_revision {
        return Err(TradeSessionError::StaleRevision);
    }
    side_check(own, receipt)
}

/// Replace `side`'s offer with `offer`, leave the other side's offer untouched
/// and [`reset_confirms`]. A confirmed side cannot edit: `SideConfirmed`
/// (cancelling the session is its way out).
pub fn apply_edit(
    mut state: TradeSessionState,
    side: SessionSide,
    offer: TradeSessionOffer,
) -> Result<TradeSessionState, TradeSessionError> {
    let (confirmed, own_offer) = match side {
        SessionSide::Opener => (state.opener_confirmed, &mut state.opener_offer),
        SessionSide::Partner => (state.partner_confirmed, &mut state.partner_offer),
    };
    if confirmed {
        return Err(TradeSessionError::SideConfirmed);
    }
    *own_offer = offer;
    Ok(reset_confirms(state))
}

/// The transition for every change to what the sides reviewed — an edit, or an
/// offered monster drifting from its snapshot: the revision advances by one and
/// both confirms clear. Offers are untouched.
///
/// The revision wraps at `u64::MAX`: all a revision must do is differ from the
/// one a pending confirm reviewed.
#[must_use]
pub fn reset_confirms(state: TradeSessionState) -> TradeSessionState {
    TradeSessionState {
        opener_confirmed: false,
        partner_confirmed: false,
        revision: state.revision.wrapping_add(1),
        ..state
    }
}

/// Decide the execute from the two [`side_check`] results, the caller's first.
///
/// The caller's own failure is theirs to hear. A failure on the other side alone
/// yields `ResetOther` and its reason is dropped here: returning it would tell
/// the caller about the other player's private state.
#[must_use]
pub fn judge_execute(
    own: Result<(), TradeSessionError>,
    other: Result<(), TradeSessionError>,
) -> ExecuteVerdict {
    match (own, other) {
        (Err(reason), _) => ExecuteVerdict::RejectCaller(reason),
        (Ok(()), Err(_)) => ExecuteVerdict::ResetOther,
        (Ok(()), Ok(())) => ExecuteVerdict::Execute,
    }
}

/// Every column of a `monster` row except its owner, in table order.
///
/// The server copies a row into this without choosing columns; which of them a
/// trade partner reviews is [`snapshot_drifted`]'s rule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MonsterSnapshot {
    pub monster_id: u64,
    pub species_id: u32,
    pub nickname: String,
    pub level: u8,
    pub xp: u32,
    pub iv_hp: u8,
    pub iv_attack: u8,
    pub iv_defense: u8,
    pub iv_speed: u8,
    pub iv_sp_attack: u8,
    pub iv_sp_defense: u8,
    pub nature_kind: NatureKind,
    pub ev_hp: u16,
    pub ev_attack: u16,
    pub ev_defense: u16,
    pub ev_speed: u16,
    pub ev_sp_attack: u16,
    pub ev_sp_defense: u16,
    pub stat_hp: u16,
    pub stat_attack: u16,
    pub stat_defense: u16,
    pub stat_speed: u16,
    pub stat_sp_attack: u16,
    pub stat_sp_defense: u16,
    pub current_hp: u16,
    pub party_slot: u8,
    pub last_care_at_ms: i64,
    pub essence_fire: u32,
    pub essence_water: u32,
    pub essence_plant: u32,
    pub essence_electric: u32,
    pub essence_earth: u32,
    pub essence_wind: u32,
    pub essence_light: u32,
    pub essence_dark: u32,
    pub trust_favorable_count: u32,
    pub trust_unfavorable_count: u32,
    pub trust_favorable_battle_day_epoch: u32,
    pub quality_time_ticks_total: u32,
    pub quality_time_accum_ms: u32,
    pub quality_time_window_ms: u32,
    pub quality_time_window_start_ms: i64,
    pub last_essence_train_at_ms: i64,
}

impl MonsterSnapshot {
    /// This snapshot with the columns a trade partner does not review set to 0:
    /// current HP (it heals for free), the party slot, and the seven bond columns
    /// (the bond resets when the monster changes hands).
    #[must_use]
    pub fn masked(self) -> Self {
        Self {
            current_hp: 0,
            party_slot: 0,
            trust_favorable_count: 0,
            trust_unfavorable_count: 0,
            trust_favorable_battle_day_epoch: 0,
            quality_time_ticks_total: 0,
            quality_time_accum_ms: 0,
            quality_time_window_ms: 0,
            quality_time_window_start_ms: 0,
            ..self
        }
    }
}

/// True when an offered monster's live row differs from the snapshot taken when
/// it was offered, in any column [`MonsterSnapshot::masked`] does not blank.
///
/// Every column is compared unless the mask names it. The owner is not a column
/// of the snapshot at all.
#[must_use]
pub fn snapshot_drifted(stored: &MonsterSnapshot, live: &MonsterSnapshot) -> bool {
    stored.clone().masked() != live.clone().masked()
}

/// The party slot of each of `incoming` arriving monsters, in offer order: the
/// receiver's free party slots from the lowest up, then `PARTY_SLOT_NONE`
/// (Storage) for every monster the party has no room for.
///
/// `occupied_after_outgoing` holds the slots of the receiver's monsters that
/// STAY; the monsters it gives away have vacated theirs. Entries that are not a
/// party slot (a boxed monster's `PARTY_SLOT_NONE`) and repeated entries are
/// ignored. The caller passes an offer's monster count as `incoming`, at most
/// [`MAX_TRADE_MONSTERS_PER_SIDE`]; the result has exactly that many entries.
#[must_use]
pub fn arrival_slots(occupied_after_outgoing: &[u8], incoming: usize) -> Vec<u8> {
    (0..PARTY_SIZE)
        .filter(|slot| !occupied_after_outgoing.contains(slot))
        .chain(std::iter::repeat(PARTY_SLOT_NONE))
        .take(incoming)
        .collect()
}

/// True when `sessions` — `(opener, partner)` rows — holds one between `a` and
/// `b`, whichever of them opened it.
#[must_use]
pub fn pair_has_open_session<I: PartialEq>(sessions: &[(I, I)], a: &I, b: &I) -> bool {
    sessions
        .iter()
        .any(|(opener, partner)| (opener == a && partner == b) || (opener == b && partner == a))
}

/// How many of the `(opener, partner)` rows `opener` opened. Rows in which they
/// are the partner do not count.
#[must_use]
pub fn open_session_count<I: PartialEq>(sessions: &[(I, I)], opener: &I) -> usize {
    sessions
        .iter()
        .filter(|(row_opener, _)| row_opener == opener)
        .count()
}

/// Whether `opener` may open a session with `partner`, given the `(opener,
/// partner)` rows of the sessions `opener` is in. In order: `SelfTrade` for
/// oneself, `PairHasOpenSession` when the two already share a session in either
/// orientation, `OpenSessionLimit` when `opener` has already opened
/// [`MAX_OPEN_TRADE_SESSIONS`].
pub fn check_session_open<I: PartialEq>(
    sessions: &[(I, I)],
    opener: &I,
    partner: &I,
) -> Result<(), TradeSessionError> {
    if opener == partner {
        return Err(TradeSessionError::SelfTrade);
    }
    if pair_has_open_session(sessions, opener, partner) {
        return Err(TradeSessionError::PairHasOpenSession);
    }
    if open_session_count(sessions, opener) >= MAX_OPEN_TRADE_SESSIONS {
        return Err(TradeSessionError::OpenSessionLimit);
    }
    Ok(())
}

/// True if the session has outlived [`TRADE_SESSION_TTL_MS`].
///
/// Under clock skew (`now_ms` < `created_at_ms`) the elapsed time is negative, so
/// a fresh session is never marked stale; the subtraction saturates instead of
/// overflowing. Boundary is `>=`: at exactly the TTL the session IS stale.
#[must_use]
pub fn is_session_stale(created_at_ms: i64, now_ms: i64) -> bool {
    now_ms.saturating_sub(created_at_ms) >= TRADE_SESSION_TTL_MS
}
