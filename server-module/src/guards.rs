//! `guards` — server-module domain submodule.
//!
//! Validation/authorization helpers shared by the reducer modules: the reject
//! logger, the name validator, the move authorizer, the character lookup and the
//! pair range guard, and the pure battle-input validators.

use crate::marshal::char_state;
use crate::schema::{
    battle, character, move_intent, player, trade_offer, trade_session, Battle, Character,
    MoveIntent, TradeOffer, TradeSession,
};
use crate::{MAX_NAME_LEN, MAX_PARTY_SIZE, PARTY_SLOT_NONE};
use game_core::interact::within_interact_range;
use game_core::trading::TradeSessionOffer;
use spacetimedb::{Identity, ReducerContext, Table};

/// Escape a string for interpolation into a hand-built JSON log line.
/// Backslash and double quote are escaped; 0x0A / 0x0D / 0x09
/// take their short forms; every other character below 0x20 becomes a
/// four-digit lowercase backslash-u escape; everything else (0x20, 0x7F DEL,
/// non-ASCII) passes through unchanged — Rust `char` iteration cannot produce
/// a lone surrogate, so pass-through is valid JSON as UTF-8 by construction.
///
/// ONE forward pass over `s.chars()` on purpose: sequential `str::replace`
/// passes double-escape the backslashes an earlier pass inserted (attack
/// input: a backslash directly followed by a double quote).
///
/// The two structural characters are spelled as Unicode escapes in the match
/// arms, never as raw char literals: the repo's text-level source scanners
/// have no char-literal lexer, and a bare quote between apostrophes inverts
/// string/code polarity for the rest of the file.
pub(crate) fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\u{005C}' => out.push_str("\\\\"),
            '\u{0022}' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            _ => out.push(c),
        }
    }
    out
}

pub(crate) fn log_reject(reducer: &str, sender: Identity, reason: &str) {
    // BOTH parameters go through json_escape: `reason` carries
    // parser/validator text across the trust boundary, and several helpers
    // forward `reducer` as a `&str` parameter, so a name literal is an
    // unenforced convention. This is the reject path, never a hot path.
    let reducer = json_escape(reducer);
    let reason = json_escape(reason);
    // `sender` stays raw: Identity Display is fixed-width lowercase hex, structurally quote-free.
    log::warn!("{{\"evt\":\"reject\",\"reducer\":\"{reducer}\",\"sender\":\"{sender}\",\"reason\":\"{reason}\"}}");
}

/// Shared resource-ownership guard: reject when the caller (`ctx.sender()`) does not
/// own `owner`. Generalizes the repeated `owner != ctx.sender() -> log_reject ->
/// Err("not owner")` preamble that recurs across the ownership-checked reducers
/// (M8.9b de-dup). Behavior is identical to the inlined form: same
/// `"not owner"` `Err` + same `log_reject(reducer, ctx.sender(), "not owner")`.
pub(crate) fn require_owner(
    ctx: &ReducerContext,
    reducer: &str,
    owner: Identity,
) -> Result<(), String> {
    if owner != ctx.sender() {
        let e = "not owner".to_string();
        log_reject(reducer, ctx.sender(), &e);
        return Err(e);
    }
    Ok(())
}

/// ONE message for every gated shape on purpose: a
/// per-state message (mid-grace vs terminal) would require this module to
/// re-derive the state split that `accounts` owns. It names no action, because
/// the gate fronts every kind of player action and the player reads it verbatim.
pub(crate) const REJECT_DELETION_GATED: &str =
    "account deletion requested; this action is unavailable until the deletion is cancelled";

/// Pure decision seam:
/// maps an already-derived verdict to `Err(REJECT_DELETION_GATED)` or `Ok`.
/// Takes a `bool`, never a context — the account-state derivation stays with
/// its SSOT in `accounts`, and this half stays unit-testable without a
/// `ReducerContext` (the same split as the battle-input validators below).
pub(crate) fn deletion_gate(rejected: bool) -> Result<(), &'static str> {
    if rejected {
        return Err(REJECT_DELETION_GATED);
    }
    Ok(())
}

/// Reducer preamble:
/// reject the CALLER when their account is mid-grace or carries the
/// terminal marker — such an account may not open a commitment or create,
/// mutate or discard its own state; open commitments stay completable.
///
/// Caller-only BY SIGNATURE: there is deliberately no identity parameter, so
/// no call site can ever point this gate at a third party (a counterparty or
/// challenge target). Delegates TRANSITIVELY — through the ctx-bound accounts
/// predicate into the pure SSOT decision — and never re-derives the
/// status-or-marker disjunction here: the fail-closed arm for the
/// illegal active-plus-marker shape lives in `accounts` alone, and a second
/// spelling would silently diverge from it. The reason is ONE static string
/// because a per-state message would require re-deriving exactly that state
/// split.
pub(crate) fn require_not_deleting(ctx: &ReducerContext, reducer: &str) -> Result<(), String> {
    deletion_gate(crate::accounts::is_pending_deletion(ctx, ctx.sender())).map_err(|e| {
        log_reject(reducer, ctx.sender(), e);
        e.to_string()
    })
}

/// The stamp-aware sibling of `require_not_deleting`, for a reducer that acts
/// inside a commitment already open — `confirm_trade_session` and the tactical
/// battle reducers (`deploy_units`, `submit_queue`, `cancel_queue`, `forfeit`):
/// refuse the CALLER only while their account is deletion-gated AND the
/// commitment was opened at or after their own deletion request (`opened_at_ms`
/// is the session's or the battle's creation stamp). Commitments that
/// predate the request stay completable, which is why this is not,
/// and must never become, a blanket gate on an already-open interaction. Same
/// shape as its sibling on purpose: caller-only by signature (no identity
/// parameter), one fused expression delegating transitively through the
/// accounts predicate into the pure SSOT decision, no account state re-derived
/// here, the same single static reason (it names no action, so it is as true
/// of a confirm or a battle move as of anything else), and `log_reject` on the
/// refuse path.
pub(crate) fn require_commitment_predates_deletion(
    ctx: &ReducerContext,
    reducer: &str,
    opened_at_ms: i64,
) -> Result<(), String> {
    deletion_gate(crate::accounts::refuses_commitment_opened_at(
        ctx,
        ctx.sender(),
        opened_at_ms,
    ))
    .map_err(|e| {
        log_reject(reducer, ctx.sender(), e);
        e.to_string()
    })
}

/// The subject-keyed member of the deletion family:
/// refuse a NAMED subject whose account is mid-grace or terminal, for an opener
/// the subject did not call — the scheduler-opened wild encounter
/// (`tactics::start_wild_tactical`, where the caller is the module itself and the
/// walker is derived server-side from the character's own row) and the
/// challenge accept (`tactics::start_pvp_tactical`, gating both participants).
///
/// The identity-PARAMETERISED wrapper in this family: the blanket wrapper's
/// structural containment (no identity parameter, so no call site can ever point
/// the gate at a third party) is deliberately NOT claimed for this one. Every
/// consumer carries its own six-state gate test in `tactics_tests.rs`.
///
/// Delegates TRANSITIVELY like both siblings — `deletion_gate` over the ctx-bound
/// accounts predicate `accounts::is_pending_deletion` — and never re-derives the
/// account-state disjunction here: the fail-closed arm for the illegal shape
/// lives in `accounts` alone, and a second spelling would silently diverge from
/// it. One static reason, as for every gated shape.
///
/// It deliberately does NOT log, and therefore takes no `reducer` tag: on this
/// path the CALLER owns observability — `tactics::start_wild_tactical` logs none of
/// its `Err` returns — and a `log_reject` call here would be an unbounded,
/// client-triggered warn stream, roughly one line per second per deleting walker
/// on grass for the whole grace window, on a refusal the scheduler treats as a
/// routine non-event.
pub(crate) fn require_subject_not_deleting(
    ctx: &ReducerContext,
    subject: Identity,
) -> Result<(), String> {
    deletion_gate(crate::accounts::is_pending_deletion(ctx, subject)).map_err(|e| e.to_string())
}

/// Validate + canonicalize a player-visible name (#27c Unicode hardening).
///
/// Order matters: trim -> NFC-normalize -> length -> charset, so length and
/// charset are judged on the CANONICAL form (composed/decomposed spellings of
/// the same glyphs collapse to one stored representation).
///
/// Charset is an ALLOWLIST (letters/numbers/spaces via the Unicode-aware
/// `char::is_alphanumeric`), not a blocklist: this rejects control chars (the
/// pre-#27c check), zero-width characters (U+200B/ZWJ/ZWNJ), and the bidi
/// overrides/isolates (U+202A–202E, U+2066–2069) used for display-order name
/// spoofing — none of which are alphanumeric.
pub(crate) fn validate_name(name: &str) -> Result<String, String> {
    use unicode_normalization::UnicodeNormalization;
    let name: String = name.trim().nfc().collect();
    if name.is_empty() {
        return Err("name must not be empty".to_string());
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(format!("name must be at most {MAX_NAME_LEN} characters"));
    }
    if !name.chars().all(|c| c.is_alphanumeric() || c == ' ') {
        return Err("name contains invalid characters".to_string());
    }
    Ok(name)
}

/// Shared ownership + monotonic-seq guard for the move reducers. Returns the
/// caller's `move_intent` row with `last_input_seq` already advanced to `seq`,
/// NOT yet written: the caller edits the queue and does the one
/// `move_intent` update, so the queue and the seq are a single row write and a
/// later `Err("queue full")` returns before any write of an existing row.
///
/// A joined caller with no intent row is a session that pre-dates the table:
/// the row is created from the published character row (`seed_intent`), which
/// keeps its queued steps and its seq guard. An `Err` after that insert rolls
/// it back with the rest of the transaction.
pub(crate) fn authorize_move(
    ctx: &ReducerContext,
    reducer: &str,
    seq: u64,
) -> Result<MoveIntent, String> {
    let me = ctx.sender();
    let Some(player) = ctx.db.player().identity().find(me) else {
        let e = "not joined".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    };
    let mut intent = match ctx.db.move_intent().entity_id().find(player.entity_id) {
        Some(intent) => intent,
        None => {
            let Some(ch) = ctx.db.character().entity_id().find(player.entity_id) else {
                let e = "no character".to_string();
                log_reject(reducer, me, &e);
                return Err(e);
            };
            ctx.db
                .move_intent()
                .insert(crate::movement::seed_intent(&ch, Some(&player)))
        }
    };
    if seq <= intent.last_input_seq {
        let e = "stale seq".to_string();
        log_reject(reducer, me, &e);
        return Err(e);
    }
    intent.last_input_seq = seq;
    Ok(intent)
}

// --- Where a player stands ----------------------------------

/// The character of player `who`, found through its `player` row's `entity_id`.
/// `None` when either row is missing.
pub(crate) fn character_of(ctx: &ReducerContext, who: Identity) -> Option<Character> {
    let player = ctx.db.player().identity().find(who)?;
    ctx.db.character().entity_id().find(player.entity_id)
}

/// True when the characters of players `a` and `b` are within interact range of each
/// other. A player with no `player` row or no character row is out of range.
pub(crate) fn characters_in_interact_range(ctx: &ReducerContext, a: Identity, b: Identity) -> bool {
    let (Some(a), Some(b)) = (character_of(ctx, a), character_of(ctx, b)) else {
        return false;
    };
    within_interact_range(a.zone_id, char_state(&a).pos, b.zone_id, char_state(&b).pos)
}

// --- Battle-input validators -------------------------------
// Pure, total predicates over the trust boundary. Extracted so the rejection
// rules are unit-testable without a ReducerContext and reused by the tactical
// starts and the write-back path. Every illegal input is an `Err` — reject-not-clamp.

/// Caller party size must be in `1..=MAX_PARTY_SIZE` (empty is invalid; an
/// oversized list is rejected, never truncated). The SSOT party-size validator.
pub(crate) fn check_party_size(n: usize) -> Result<(), String> {
    if n == 0 {
        return Err("party must contain at least one monster".to_string());
    }
    if n > usize::from(MAX_PARTY_SIZE) {
        return Err(format!(
            "party size {n} exceeds MAX_PARTY_SIZE ({MAX_PARTY_SIZE})"
        ));
    }
    Ok(())
}

/// A monster offered to a battle must be party-slotted, not boxed
/// (`party_slot == PARTY_SLOT_NONE`). Boxed monsters cannot be conscripted.
pub(crate) fn check_monster_in_party(slot: u8) -> Result<(), String> {
    if slot == PARTY_SLOT_NONE {
        return Err("monster is boxed (not party-slotted)".to_string());
    }
    Ok(())
}

/// The positional coupling the write-back path relies on: `side_a.team[i]`
/// pairs with `party_monster_ids[i]`. A length mismatch is an illegal state —
/// return `Err` (the caller surfaces it) rather than panic-indexing.
pub(crate) fn check_team_coupling(team_len: usize, ids_len: usize) -> Result<(), String> {
    if team_len != ids_len {
        return Err(format!(
            "battle invariant violated: side_a.team.len() ({team_len}) != party_monster_ids.len() ({ids_len})"
        ));
    }
    Ok(())
}

// --- Trade escrow guards ------------------------------------
//
// Two sources lock a player's assets: an active legacy `trade_offer` (both of
// its sides, for as long as it exists) and a `trade_session` side its owner
// has CONFIRMED. An unconfirmed session side locks nothing.
//
// Two layers. The PURE predicates judge an iterator of rows, mirroring
// `reject_if_in_battle`: `reject_if_monster_in_trade`, `escrowed_item_qty`,
// `escrowed_currency_amount` and `escrowed_monster_ids` over `TradeOffer`
// rows; `session_locked_item_qty`, `session_locked_currency`,
// `session_locked_monster_ids` and `session_lists_monster` over `TradeSession`
// rows. The CONTEXT WRAPPERS (`reject_if_monster_locked`,
// `escrowed_item_qty_of`, `escrowed_currency_of`, `escrowed_monster_ids_of`)
// read one owner's offers and sessions in BOTH roles through `offers_of` and
// `sessions_of` and combine the two sources. A reducer calls a wrapper, so
// what counts as locked is decided in this file — unless it must judge one
// source alone or leave one trade out, in which case it reads the rows itself
// and calls the pure predicates. `monster_mgmt::set_party_slot` judges offers
// alone (a session never refuses a party move: boxing an offered monster ends
// the session), and `trading_session::read_side` leaves out the session it is
// judging, whose own confirmed side must not count against itself. An active
// offer is Pending OR ConfirmedByCounterparty.
//
// SpacetimeDB reducers are single-threaded WASM: read-check-write within one
// reducer is atomic w.r.t. all other reducers — no TOCTOU possible.

/// The one refusal for a monster a trade holds, whichever source holds it.
const REJECT_MONSTER_IN_TRADE: &str = "monster is in an active trade";

/// Every trade offer `owner` is party to: the rows of the `initiator` index,
/// then the rows of the `counterparty` index. Both index scans open when the
/// chain is built.
pub(crate) fn offers_of(ctx: &ReducerContext, owner: Identity) -> impl Iterator<Item = TradeOffer> {
    ctx.db
        .trade_offer()
        .initiator()
        .filter(owner)
        .chain(ctx.db.trade_offer().counterparty().filter(owner))
}

/// Every trade session `owner` is party to, each once: the rows of the
/// `opener` index, then the rows of the `partner` index that `owner` did not
/// also open.
pub(crate) fn sessions_of(
    ctx: &ReducerContext,
    owner: Identity,
) -> impl Iterator<Item = TradeSession> {
    ctx.db.trade_session().opener().filter(owner).chain(
        ctx.db
            .trade_session()
            .partner()
            .filter(owner)
            .filter(move |s| s.opener != owner),
    )
}

/// Reject if `monster_id` is locked by one of `owner`'s trades: an active
/// offer in either role, or a session side `owner` has confirmed. Does not
/// log: a caller that logs its rejects keeps doing so.
pub(crate) fn reject_if_monster_locked(
    ctx: &ReducerContext,
    owner: Identity,
    monster_id: u64,
) -> Result<(), String> {
    reject_if_monster_in_trade(offers_of(ctx, owner), monster_id)?;
    if session_locked_monster_ids(sessions_of(ctx, owner), owner).contains(&monster_id) {
        return Err(REJECT_MONSTER_IN_TRADE.to_string());
    }
    Ok(())
}

/// The quantity of `item_id` that `owner`'s trades lock: their active offers
/// in either role plus their confirmed session sides.
///
/// Usage at call site: `available = inventory_count - escrowed_item_qty_of(ctx, owner, item_id)`.
/// Reject if `requested_qty > available`.
pub(crate) fn escrowed_item_qty_of(ctx: &ReducerContext, owner: Identity, item_id: u32) -> u32 {
    escrowed_item_qty(offers_of(ctx, owner), owner, item_id).saturating_add(
        session_locked_item_qty(sessions_of(ctx, owner), owner, item_id),
    )
}

/// The currency `owner`'s trades lock: their active offers in either role
/// plus their confirmed session sides.
///
/// Usage at call site: `available = balance - escrowed_currency_of(ctx, owner)`.
/// Reject if `requested_spend > available`.
pub(crate) fn escrowed_currency_of(ctx: &ReducerContext, owner: Identity) -> u64 {
    escrowed_currency_amount(offers_of(ctx, owner), owner)
        .saturating_add(session_locked_currency(sessions_of(ctx, owner), owner))
}

/// Every monster id `owner`'s trades hold: both sides of each active offer,
/// in either role, then the ids of `owner`'s confirmed session sides.
pub(crate) fn escrowed_monster_ids_of(ctx: &ReducerContext, owner: Identity) -> Vec<u64> {
    let mut ids = escrowed_monster_ids(offers_of(ctx, owner));
    ids.extend(session_locked_monster_ids(sessions_of(ctx, owner), owner));
    ids
}

/// The offer `owner` has locked in `session`: their own side, once they have
/// confirmed it. The other participant's side is never `owner`'s lock.
fn locked_offer(session: &TradeSession, owner: Identity) -> Option<&TradeSessionOffer> {
    if session.opener == owner && session.opener_confirmed {
        Some(&session.opener_offer)
    } else if session.partner == owner && session.partner_confirmed {
        Some(&session.partner_offer)
    } else {
        None
    }
}

/// The quantity of `item_id` on `owner`'s confirmed sides of `sessions`.
/// Saturating, like the offer predicate.
pub(crate) fn session_locked_item_qty(
    sessions: impl Iterator<Item = impl std::borrow::Borrow<TradeSession>>,
    owner: Identity,
    item_id: u32,
) -> u32 {
    sessions
        .map(|s| {
            locked_offer(s.borrow(), owner).map_or(0, |offer| {
                offer
                    .items
                    .iter()
                    .filter(|i| i.item_id == item_id)
                    .fold(0u32, |acc, i| acc.saturating_add(i.qty))
            })
        })
        .fold(0u32, |acc, q| acc.saturating_add(q))
}

/// The currency on `owner`'s confirmed sides of `sessions`. Saturating.
pub(crate) fn session_locked_currency(
    sessions: impl Iterator<Item = impl std::borrow::Borrow<TradeSession>>,
    owner: Identity,
) -> u64 {
    sessions
        .map(|s| locked_offer(s.borrow(), owner).map_or(0, |offer| offer.currency))
        .fold(0u64, |acc, c| acc.saturating_add(c))
}

/// The monster ids on `owner`'s confirmed sides of `sessions`, in iteration
/// order.
pub(crate) fn session_locked_monster_ids(
    sessions: impl Iterator<Item = impl std::borrow::Borrow<TradeSession>>,
    owner: Identity,
) -> Vec<u64> {
    let mut ids = Vec::new();
    for s in sessions {
        if let Some(offer) = locked_offer(s.borrow(), owner) {
            ids.extend_from_slice(&offer.monster_ids);
        }
    }
    ids
}

/// True when either side of any of `sessions` lists `monster_id`, confirmed
/// or not: a monster sits in at most one session at a time.
pub(crate) fn session_lists_monster(
    mut sessions: impl Iterator<Item = impl std::borrow::Borrow<TradeSession>>,
    monster_id: u64,
) -> bool {
    sessions.any(|s| {
        let s = s.borrow();
        s.opener_offer.monster_ids.contains(&monster_id)
            || s.partner_offer.monster_ids.contains(&monster_id)
    })
}

/// Reject if the monster is in any active trade offer.
/// Pure predicate; mirrors `reject_if_in_battle`.
pub(crate) fn reject_if_monster_in_trade(
    mut trades: impl Iterator<Item = impl std::borrow::Borrow<crate::schema::TradeOffer>>,
    monster_id: u64,
) -> Result<(), String> {
    let in_trade = trades.any(|t| {
        let t = t.borrow();
        t.status.is_active()
            && (t.initiator_monster_ids.contains(&monster_id)
                || t.counterparty_monster_ids.contains(&monster_id))
    });
    if in_trade {
        return Err(REJECT_MONSTER_IN_TRADE.to_string());
    }
    Ok(())
}

/// Returns the total quantity of `item_id` escrowed in active trade offers for this
/// player (either as initiator or counterparty — the caller passes an already-filtered
/// iterator covering both roles). Saturating add prevents overflow on pathological inputs
/// (MI-2).
pub(crate) fn escrowed_item_qty(
    trades: impl Iterator<Item = impl std::borrow::Borrow<crate::schema::TradeOffer>>,
    owner: spacetimedb::Identity,
    item_id: u32,
) -> u32 {
    trades
        .filter(|t| t.borrow().status.is_active())
        .map(|t| {
            let t = t.borrow();
            let items = if t.initiator == owner {
                &t.initiator_items
            } else {
                &t.counterparty_items
            };
            items
                .iter()
                .filter(|i| i.item_id == item_id)
                .map(|i| i.qty)
                .fold(0u32, |acc, q| acc.saturating_add(q))
        })
        .fold(0u32, |acc, q| acc.saturating_add(q))
}

/// Returns the total currency escrowed by `owner` in active trade offers.
pub(crate) fn escrowed_currency_amount(
    trades: impl Iterator<Item = impl std::borrow::Borrow<crate::schema::TradeOffer>>,
    owner: spacetimedb::Identity,
) -> u64 {
    trades
        .filter(|t| t.borrow().status.is_active())
        .map(|t| {
            let t = t.borrow();
            if t.initiator == owner {
                t.initiator_currency
            } else {
                t.counterparty_currency
            }
        })
        .fold(0u64, |acc, c| acc.saturating_add(c))
}

/// Returns every monster id in the active trade offers: for each offer in
/// iteration order, the initiator's ids, then the counterparty's. Both sides
/// are listed and an id present in two offers is listed twice.
pub(crate) fn escrowed_monster_ids(
    trades: impl Iterator<Item = impl std::borrow::Borrow<crate::schema::TradeOffer>>,
) -> Vec<u64> {
    let mut ids = Vec::new();
    for t in trades {
        let t = t.borrow();
        if t.status.is_active() {
            ids.extend_from_slice(&t.initiator_monster_ids);
            ids.extend_from_slice(&t.counterparty_monster_ids);
        }
    }
    ids
}

/// Reject if the monster is in an ongoing battle (escrowed).
/// Pure predicate: checks if any battle row has the monster_id in either party
/// AND has outcome == Ongoing. Used by evolve/fuse reducers (M10b).
pub(crate) fn reject_if_in_battle(
    mut battles: impl Iterator<Item = impl std::borrow::Borrow<crate::schema::Battle>>,
    monster_id: u64,
) -> Result<(), String> {
    use game_core::BattleOutcome;

    let in_battle = battles.any(|b| {
        let b = b.borrow();
        b.state.outcome == BattleOutcome::Ongoing
            && (b.party_monster_ids.contains(&monster_id)
                || b.opponent_monster_ids.contains(&monster_id))
    });

    if in_battle {
        return Err("monster is in an ongoing battle".to_string());
    }
    Ok(())
}

/// Pure core: is `identity` in an `Ongoing` battle in EITHER role?
/// The opponent arm counts a row only when `opponent_identity != WILD_IDENTITY`
/// (hoisted verbatim from the former pvp.rs copy): a wild battle's sentinel
/// opponent must never match, while that battle's real side-A owner is still
/// caught by the player arm. Pure iterators mirror `reject_if_in_battle`.
pub(crate) fn is_in_ongoing_battle_either_role(
    mut as_player: impl Iterator<Item = impl std::borrow::Borrow<crate::schema::Battle>>,
    mut as_opponent: impl Iterator<Item = impl std::borrow::Borrow<crate::schema::Battle>>,
) -> bool {
    use game_core::BattleOutcome;

    as_player.any(|b| b.borrow().state.outcome == BattleOutcome::Ongoing)
        || as_opponent.any(|b| {
            let b = b.borrow();
            b.state.outcome == BattleOutcome::Ongoing && b.opponent_identity != crate::WILD_IDENTITY
        })
}

/// Thin context wrapper: the single SSOT ongoing-battle predicate
/// for every reducer, PvE and PvP alike (replaces the former pvp.rs private
/// copy). Arg order is semantically significant: as_player, then as_opponent.
pub(crate) fn is_in_ongoing_battle(ctx: &ReducerContext, identity: Identity) -> bool {
    is_in_ongoing_battle_either_role(
        ctx.db.battle().player_identity().filter(identity),
        ctx.db.battle().opponent_identity().filter(identity),
    )
}

/// Saturating subtraction helpers — used by economy.rs.
pub(crate) fn saturating_sub_u64(a: u64, b: u64) -> u64 {
    a.saturating_sub(b)
}

pub(crate) fn saturating_sub_u32(a: u32, b: u32) -> u32 {
    a.saturating_sub(b)
}

/// Battle-kind classifier: a battle is RANKED PvP iff its
/// two sides are distinct real players. `player_identity != opponent_identity`
/// rules out practice self-battles (M12.5e2) and `opponent_identity !=
/// WILD_IDENTITY` rules out wild encounters. Wild and practice
/// self-battles are the "friendly" class: they never touch `profile`, even
/// when routed through the forfeit paths (RL-6). The single classifying
/// predicate — rating is gated by battle classification, never by call path.
pub(crate) fn is_ranked_pvp(battle: &Battle) -> bool {
    battle.player_identity != battle.opponent_identity
        && battle.opponent_identity != crate::WILD_IDENTITY
}

#[cfg(test)]
#[path = "guards_tests.rs"]
mod guards_tests;
