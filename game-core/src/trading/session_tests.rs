//! Trade-session rules: offer eligibility (ts-1.1), edits, confirms and revisions
//! (ts-1.2), emptiness and the last-monster guard (ts-1.3), execute verdicts,
//! receiver-attributed headroom and snapshot drift (ts-1.4), arrival slots (ts-1.5),
//! and the session-open predicates and constants (ts-1.6).
//!
//! Most cases start from ONE valid two-seat trade (`baseline`). Each case of the
//! eligibility table changes exactly one fact of it, so it can only fail for its
//! named reason; the ordering tests stack several defects on purpose. The session
//! API is reached through the `crate::trading` re-exports.

use proptest::prelude::*;

use crate::currency::MAX_BALANCE;
use crate::monster::types::NatureKind;
use crate::trading::{
    apply_edit, arrival_slots, can_confirm, check_offer_eligibility, check_offer_size,
    check_session_open, is_session_stale, judge_execute, open_session_count, pair_has_open_session,
    reset_confirms, side_check, snapshot_drifted, ExecuteVerdict, ItemStack, MonsterCard,
    MonsterSnapshot, OwnedMonster, ReceiptFacts, SessionSide, SideFacts, TradeItem,
    TradeSessionError, TradeSessionOffer, TradeSessionState, MAX_ITEM_STACK,
    MAX_OPEN_TRADE_SESSIONS, MAX_TRADE_ITEMS_PER_SIDE, MAX_TRADE_MONSTERS_PER_SIDE,
    TRADE_SESSION_TTL_MS,
};
use crate::world::{PARTY_SIZE, PARTY_SLOT_NONE};

// ---------------------------------------------------------------------------
// Fixture: one seat's offer plus the live lookups its rules read
// ---------------------------------------------------------------------------

/// Owns every slice a `SideFacts` borrows, so a test mutates plain `Vec`s and
/// hands out a borrowed view.
#[derive(Clone, Debug)]
struct Side {
    monster_ids: Vec<u64>,
    items: Vec<TradeItem>,
    currency: u64,
    monster_rows: Vec<OwnedMonster>,
    known_item_ids: Vec<u32>,
    stacks: Vec<ItemStack>,
    locked_stacks: Vec<ItemStack>,
    balance: u64,
    locked_currency: u64,
}

impl Side {
    fn facts(&self) -> SideFacts<'_> {
        SideFacts {
            monster_ids: &self.monster_ids,
            items: &self.items,
            currency: self.currency,
            monster_rows: &self.monster_rows,
            known_item_ids: &self.known_item_ids,
            stacks: &self.stacks,
            locked_stacks: &self.locked_stacks,
            balance: self.balance,
            locked_currency: self.locked_currency,
        }
    }

    /// This seat's offer as the other seat receives it (a stored offer).
    fn offer(&self) -> TradeSessionOffer {
        TradeSessionOffer {
            monster_ids: self.monster_ids.clone(),
            items: self.items.clone(),
            currency: self.currency,
            cards: Vec::new(),
        }
    }

    fn row_mut(&mut self, monster_id: u64) -> &mut OwnedMonster {
        self.monster_rows
            .iter_mut()
            .find(|r| r.monster_id == monster_id)
            .expect("fixture has a row for this monster")
    }

    fn eligibility(&self) -> Result<(), TradeSessionError> {
        check_offer_eligibility(&self.facts())
    }
}

/// Both seats of one trade plus each seat's live owned-monster count.
#[derive(Clone, Debug)]
struct Trade {
    a: Side,
    a_owned: usize,
    b: Side,
    b_owned: usize,
}

impl Trade {
    /// Seat A's `side_check`, receiving seat B's offer.
    fn check_a(&self) -> Result<(), TradeSessionError> {
        check(&self.a, self.a_owned, &self.b)
    }

    /// Seat B's `side_check`, receiving seat A's offer.
    fn check_b(&self) -> Result<(), TradeSessionError> {
        check(&self.b, self.b_owned, &self.a)
    }

    /// Seat A's `can_confirm` at `current` having reviewed `reviewed`.
    fn confirm_a(&self, current: u64, reviewed: u64) -> Result<(), TradeSessionError> {
        let incoming = self.b.offer();
        can_confirm(
            current,
            reviewed,
            &self.a.facts(),
            &ReceiptFacts {
                owned_monster_count: self.a_owned,
                incoming: &incoming,
            },
        )
    }
}

fn check(own: &Side, owned_monster_count: usize, other: &Side) -> Result<(), TradeSessionError> {
    let incoming = other.offer();
    side_check(
        &own.facts(),
        &ReceiptFacts {
            owned_monster_count,
            incoming: &incoming,
        },
    )
}

fn row(monster_id: u64, party_slot: u8, current_hp: u16) -> OwnedMonster {
    OwnedMonster {
        monster_id,
        party_slot,
        current_hp,
        in_other_trade: false,
        in_battle: false,
    }
}

fn item(item_id: u32, qty: u32) -> TradeItem {
    TradeItem { item_id, qty }
}

fn stack(item_id: u32, current_count: u32) -> ItemStack {
    ItemStack {
        item_id,
        current_count,
    }
}

/// Seat A, fully valid, with several facts AT their accepting boundary:
/// monster 102 sits in the last party slot (5) with 1 HP; item 11 offers exactly
/// stack − locked (8 − 3 = 5); currency is exactly balance − locked (1000 − 400).
/// The lookups also carry rows the offer does not name — monster 103 (boxed,
/// fainted, in another trade AND in battle) listed FIRST, item 99 (known, empty
/// stack, 50 locked) — so a rule that reads an unlisted or the wrong row fails the
/// baseline.
fn seat_a() -> Side {
    Side {
        monster_ids: vec![101, 102],
        items: vec![item(11, 5), item(12, 3)],
        currency: 600,
        monster_rows: vec![
            OwnedMonster {
                monster_id: 103,
                party_slot: PARTY_SLOT_NONE,
                current_hp: 0,
                in_other_trade: true,
                in_battle: true,
            },
            row(102, 5, 1),
            row(101, 0, 30),
        ],
        known_item_ids: vec![99, 12, 11],
        stacks: vec![stack(99, 0), stack(12, 10), stack(11, 8)],
        locked_stacks: vec![stack(99, 50), stack(11, 3)],
        balance: 1000,
        locked_currency: 400,
    }
}

/// Seat B, fully valid: one monster, 4 of item 11 (its whole stack), 50 coins
/// (its whole wallet), plus an unoffered monster 202.
fn seat_b() -> Side {
    Side {
        monster_ids: vec![201],
        items: vec![item(11, 4)],
        currency: 50,
        monster_rows: vec![row(201, 2, 40), row(202, 0, 12)],
        known_item_ids: vec![11],
        stacks: vec![stack(11, 4)],
        locked_stacks: Vec::new(),
        balance: 50,
        locked_currency: 0,
    }
}

/// The valid trade: A owns 3 monsters (101, 102, 103), B owns 2 (201, 202).
fn baseline() -> Trade {
    Trade {
        a: seat_a(),
        a_owned: 3,
        b: seat_b(),
        b_owned: 2,
    }
}

/// Replace the offer's monsters with `n` valid party monsters (each with a row).
fn offer_n_valid_monsters(s: &mut Side, n: usize) {
    let ids: Vec<u64> = (1_000u64..).take(n).collect();
    s.monster_rows.extend(ids.iter().map(|&id| row(id, 3, 20)));
    s.monster_ids = ids;
}

/// Replace the offer's items with `n` valid known items (qty 1, stack 1 each).
fn offer_n_valid_items(s: &mut Side, n: usize) {
    let ids: Vec<u32> = (500u32..).take(n).collect();
    s.known_item_ids.extend(ids.iter().copied());
    s.stacks.extend(ids.iter().map(|&id| stack(id, 1)));
    s.items = ids.iter().map(|&id| item(id, 1)).collect();
}

// ---------------------------------------------------------------------------
// ts-1.1 — offer eligibility
// ---------------------------------------------------------------------------

/// A mixed side (two monsters, two items, currency, all at their accepting
/// boundaries, with unlisted defective lookup rows) is eligible. Kills an
/// eligibility rule that reads unlisted rows, any off-by-one at a boundary, and a
/// body replaced by a constant `Err`.
#[test]
fn valid_mixed_side_is_eligible_ts1_1() {
    assert_eq!(seat_a().eligibility(), Ok(()));
    assert_eq!(seat_b().eligibility(), Ok(()));
}

/// An empty offer is eligible — clearing one's side is a legal edit; emptiness is
/// `side_check`'s rule, not eligibility's. Kills an eligibility rule that rejects
/// an empty side.
#[test]
fn empty_offer_is_eligible_ts1_1() {
    let mut s = seat_a();
    s.monster_ids.clear();
    s.items.clear();
    s.currency = 0;
    assert_eq!(s.eligibility(), Ok(()));
    let bare = Side {
        monster_ids: Vec::new(),
        items: Vec::new(),
        currency: 0,
        monster_rows: Vec::new(),
        known_item_ids: Vec::new(),
        stacks: Vec::new(),
        locked_stacks: Vec::new(),
        balance: 0,
        locked_currency: 0,
    };
    assert_eq!(bare.eligibility(), Ok(()));
}

/// A side offering a single asset kind is eligible whatever the other kinds'
/// lookups hold (no rows, no stacks, a zero or over-locked wallet). Kills a
/// currency check using `>=` (0 >= 0 with an empty wallet) and a rule that
/// requires lookups the offer does not use.
#[test]
fn single_asset_kind_offer_ignores_the_other_kinds_lookups_ts1_1() {
    let mut monsters_only = seat_a();
    monsters_only.items.clear();
    monsters_only.currency = 0;
    monsters_only.known_item_ids.clear();
    monsters_only.stacks.clear();
    monsters_only.balance = 0;
    monsters_only.locked_currency = 0;
    assert_eq!(monsters_only.eligibility(), Ok(()));
    monsters_only.locked_currency = 5;
    assert_eq!(monsters_only.eligibility(), Ok(()));

    let mut items_only = seat_a();
    items_only.monster_ids.clear();
    items_only.monster_rows.clear();
    items_only.currency = 0;
    items_only.balance = 0;
    assert_eq!(items_only.eligibility(), Ok(()));

    let mut currency_only = seat_a();
    currency_only.monster_ids.clear();
    currency_only.monster_rows.clear();
    currency_only.items.clear();
    currency_only.known_item_ids.clear();
    currency_only.stacks.clear();
    currency_only.locked_stacks.clear();
    assert_eq!(currency_only.eligibility(), Ok(()));
}

type SideMutation = (&'static str, fn(&mut Side), TradeSessionError);

/// One single-fact mutation of seat A per eligibility reason (13), with the exact
/// error it must produce.
fn eligibility_failure_cases() -> [SideMutation; 13] {
    [
        (
            "an offered monster with no row is not owned",
            |s| s.monster_ids[1] = 104,
            TradeSessionError::MonsterNotOwned { monster_id: 104 },
        ),
        (
            "a monster outside the party",
            |s| s.row_mut(101).party_slot = PARTY_SIZE,
            TradeSessionError::MonsterNotInParty { monster_id: 101 },
        ),
        (
            "a fainted monster",
            |s| s.row_mut(102).current_hp = 0,
            TradeSessionError::MonsterFainted { monster_id: 102 },
        ),
        (
            "a monster in another trade",
            |s| s.row_mut(101).in_other_trade = true,
            TradeSessionError::MonsterInAnotherTrade { monster_id: 101 },
        ),
        (
            "a monster in battle",
            |s| s.row_mut(102).in_battle = true,
            TradeSessionError::MonsterInBattle { monster_id: 102 },
        ),
        (
            "a repeated monster id",
            |s| s.monster_ids.push(101),
            TradeSessionError::DuplicateMonster { monster_id: 101 },
        ),
        (
            "more monsters than the per-side cap",
            |s| offer_n_valid_monsters(s, MAX_TRADE_MONSTERS_PER_SIDE + 1),
            TradeSessionError::TooManyMonsters,
        ),
        (
            "more items than the per-side cap",
            |s| offer_n_valid_items(s, MAX_TRADE_ITEMS_PER_SIDE + 1),
            TradeSessionError::TooManyItems,
        ),
        (
            "a repeated item id",
            |s| s.items.push(item(12, 1)),
            TradeSessionError::DuplicateItem { item_id: 12 },
        ),
        (
            "a zero item quantity",
            |s| s.items[1].qty = 0,
            TradeSessionError::ZeroItemQuantity { item_id: 12 },
        ),
        (
            "an unknown item id",
            |s| s.known_item_ids.retain(|&id| id != 12),
            TradeSessionError::UnknownItem { item_id: 12 },
        ),
        (
            "more of an item than stack minus locked",
            |s| s.items[0].qty = 6,
            TradeSessionError::InsufficientItems { item_id: 11 },
        ),
        (
            "more currency than balance minus locked",
            |s| s.currency = 601,
            TradeSessionError::InsufficientCurrency,
        ),
    ]
}

/// Table-driven: each of the 13 eligibility reasons, applied alone to the valid
/// seat, yields its own exact `TradeSessionError` (variant AND offending id), and
/// the 13 expected errors are pairwise distinct. Kills a deleted check, a merged
/// reason, a wrong variant, and a wrong id in the payload.
#[test]
fn each_eligibility_failure_returns_its_own_exact_error_ts1_1() {
    let cases = eligibility_failure_cases();
    for (name, mutate, expected) in &cases {
        let mut s = seat_a();
        mutate(&mut s);
        assert_eq!(s.eligibility(), Err(expected.clone()), "case: {name}");
    }
    for (i, (name_i, _, err_i)) in cases.iter().enumerate() {
        for (name_j, _, err_j) in &cases[i + 1..] {
            assert_ne!(
                err_i, err_j,
                "{name_i} and {name_j} must be distinct reasons"
            );
        }
    }
}

/// `check_offer_size` accepts exactly 64 monsters and rejects 65 (and beyond).
/// Kills `>` → `>=`, `>` → `<`, an off-by-one cap and a constant `Ok`.
#[test]
fn offer_size_accepts_64_monsters_and_rejects_65_ts1_1() {
    assert_eq!(check_offer_size(0, 0), Ok(()));
    assert_eq!(check_offer_size(1, 0), Ok(()));
    assert_eq!(check_offer_size(64, 0), Ok(()));
    assert_eq!(
        check_offer_size(65, 0),
        Err(TradeSessionError::TooManyMonsters)
    );
    assert_eq!(
        check_offer_size(usize::MAX, 0),
        Err(TradeSessionError::TooManyMonsters)
    );
}

/// `check_offer_size` accepts exactly 64 items and rejects 65; with both over,
/// the monster cap is reported. Kills an item-cap off-by-one, a swapped
/// monster/item argument, and the item check running first.
#[test]
fn offer_size_accepts_64_items_and_rejects_65_ts1_1() {
    assert_eq!(check_offer_size(0, 64), Ok(()));
    assert_eq!(check_offer_size(64, 64), Ok(()));
    assert_eq!(
        check_offer_size(0, 65),
        Err(TradeSessionError::TooManyItems)
    );
    assert_eq!(
        check_offer_size(64, 65),
        Err(TradeSessionError::TooManyItems)
    );
    assert_eq!(
        check_offer_size(0, usize::MAX),
        Err(TradeSessionError::TooManyItems)
    );
    assert_eq!(
        check_offer_size(65, 65),
        Err(TradeSessionError::TooManyMonsters)
    );
    assert_eq!(
        check_offer_size(65, 0),
        Err(TradeSessionError::TooManyMonsters),
        "a monster count over the cap is not mistaken for an item count"
    );
}

/// Through eligibility, 64 valid monsters / items are accepted and 65 rejected.
/// Kills an eligibility rule that skips `check_offer_size` or passes it the wrong
/// lengths.
#[test]
fn per_side_caps_bind_through_eligibility_at_64_and_65_ts1_1() {
    let mut s = seat_a();
    offer_n_valid_monsters(&mut s, 64);
    assert_eq!(s.eligibility(), Ok(()));
    let mut s = seat_a();
    offer_n_valid_monsters(&mut s, 65);
    assert_eq!(s.eligibility(), Err(TradeSessionError::TooManyMonsters));

    let mut s = seat_a();
    offer_n_valid_items(&mut s, 64);
    assert_eq!(s.eligibility(), Ok(()));
    let mut s = seat_a();
    offer_n_valid_items(&mut s, 65);
    assert_eq!(s.eligibility(), Err(TradeSessionError::TooManyItems));
}

/// The size cap is checked before duplicates and per-row facts: 65 unowned ids,
/// 65 copies of one id, or 65 unknown zero-quantity items report the cap. Kills a
/// size check moved after (or deleted from) the per-row loop.
#[test]
fn size_cap_is_reported_before_any_per_row_defect_ts1_1() {
    let mut s = seat_a();
    s.monster_ids = (5_000u64..5_065).collect();
    assert_eq!(s.eligibility(), Err(TradeSessionError::TooManyMonsters));

    let mut s = seat_a();
    s.monster_ids = vec![101; 65];
    assert_eq!(s.eligibility(), Err(TradeSessionError::TooManyMonsters));

    let mut s = seat_a();
    s.items = (7_000u32..7_065).map(|id| item(id, 0)).collect();
    assert_eq!(s.eligibility(), Err(TradeSessionError::TooManyItems));

    let mut s = seat_a();
    s.monster_ids = (5_000u64..5_065).collect();
    s.items = (7_000u32..7_065).map(|id| item(id, 0)).collect();
    assert_eq!(s.eligibility(), Err(TradeSessionError::TooManyMonsters));
}

/// In party means `party_slot < PARTY_SIZE`: slot 5 is accepted; 6, 7, 254 and
/// `PARTY_SLOT_NONE` (255) are rejected. Kills `<` → `<=`, a
/// `!= PARTY_SLOT_NONE` test, and the check reading the wrong monster's row.
#[test]
fn party_slot_5_is_in_party_and_6_and_255_are_not_ts1_1() {
    for slot in [0, 1, PARTY_SIZE - 1] {
        let mut s = seat_a();
        s.row_mut(102).party_slot = slot;
        assert_eq!(s.eligibility(), Ok(()), "slot {slot}");
    }
    for slot in [PARTY_SIZE, PARTY_SIZE + 1, 254, PARTY_SLOT_NONE] {
        let mut s = seat_a();
        s.row_mut(102).party_slot = slot;
        assert_eq!(
            s.eligibility(),
            Err(TradeSessionError::MonsterNotInParty { monster_id: 102 }),
            "slot {slot}"
        );
        let mut s = seat_a();
        s.row_mut(101).party_slot = slot;
        assert_eq!(
            s.eligibility(),
            Err(TradeSessionError::MonsterNotInParty { monster_id: 101 }),
            "slot {slot}"
        );
    }
}

/// `current_hp >= 1` is required: 1 HP and `u16::MAX` are accepted, 0 rejected,
/// for either offered monster. Kills `== 0` → `<= 1`, a deleted HP check, and the
/// check reading the wrong row.
#[test]
fn one_hp_is_accepted_and_zero_hp_is_fainted_ts1_1() {
    for hp in [1, 2, u16::MAX] {
        let mut s = seat_a();
        s.row_mut(102).current_hp = hp;
        assert_eq!(s.eligibility(), Ok(()), "hp {hp}");
    }
    let mut s = seat_a();
    s.row_mut(102).current_hp = 0;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::MonsterFainted { monster_id: 102 })
    );
    let mut s = seat_a();
    s.row_mut(101).current_hp = 0;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::MonsterFainted { monster_id: 101 })
    );
}

/// An item quantity equal to stack − locked is accepted, one more is rejected —
/// for a locked item (11: 8 − 3) and an unlocked one (12: 10 − 0). Kills `>` →
/// `>=`, a lock that is ignored, and a lock read from another item's row (item
/// 99 carries 50 locked).
#[test]
fn item_quantity_up_to_stack_minus_locked_is_accepted_and_one_more_is_not_ts1_1() {
    let mut s = seat_a();
    s.items[0].qty = 5;
    assert_eq!(s.eligibility(), Ok(()));
    s.items[0].qty = 6;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::InsufficientItems { item_id: 11 })
    );

    let mut s = seat_a();
    s.items[1].qty = 10;
    assert_eq!(s.eligibility(), Ok(()));
    s.items[1].qty = 11;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::InsufficientItems { item_id: 12 })
    );

    let mut s = seat_a();
    s.locked_stacks.push(stack(12, 7));
    assert_eq!(s.eligibility(), Ok(()), "10 − 7 = 3 covers qty 3");
    s.locked_stacks.retain(|l| l.item_id != 12);
    s.locked_stacks.push(stack(12, 8));
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::InsufficientItems { item_id: 12 }),
        "10 − 8 = 2 does not cover qty 3"
    );
}

/// A lock above the stack leaves nothing to offer (saturating, never a panic) and
/// an absent stack row counts as 0. Kills an unchecked `-`, swapped
/// `saturating_sub` operands, and an absent stack treated as unlimited.
#[test]
fn locked_above_stack_and_absent_stack_leave_nothing_to_offer_ts1_1() {
    let mut s = seat_a();
    s.stacks = vec![stack(99, 0), stack(12, 10), stack(11, 2)];
    s.items[0].qty = 1;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::InsufficientItems { item_id: 11 }),
        "stack 2, locked 3"
    );

    let mut s = seat_a();
    s.stacks.retain(|st| st.item_id != 12);
    s.items[1].qty = 1;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::InsufficientItems { item_id: 12 }),
        "no stack row"
    );
}

/// Currency equal to balance − locked is accepted, one more is rejected; a lock
/// above the balance leaves nothing; with no lock the whole balance is
/// available. Kills `>` → `>=`, an ignored lock, swapped `saturating_sub`
/// operands and an unchecked `-`.
#[test]
fn currency_up_to_balance_minus_locked_is_accepted_and_one_more_is_not_ts1_1() {
    let mut s = seat_a();
    s.currency = 600;
    assert_eq!(s.eligibility(), Ok(()));
    s.currency = 601;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::InsufficientCurrency)
    );

    let mut s = seat_a();
    s.locked_currency = 0;
    s.currency = 1000;
    assert_eq!(s.eligibility(), Ok(()));
    s.currency = 1001;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::InsufficientCurrency)
    );

    let mut s = seat_a();
    s.locked_currency = 2000;
    s.currency = 1;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::InsufficientCurrency)
    );
}

/// With two defective monsters the FIRST in offer order is reported, and
/// reversing the offer order reverses the report. Kills a last-offender report
/// and a loop over the lookup rows instead of the offer.
#[test]
fn first_offending_monster_in_offer_order_is_reported_ts1_1() {
    let mut s = seat_a();
    s.row_mut(101).party_slot = PARTY_SIZE;
    s.row_mut(102).current_hp = 0;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::MonsterNotInParty { monster_id: 101 })
    );
    s.monster_ids = vec![102, 101];
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::MonsterFainted { monster_id: 102 })
    );
}

/// With two defective items the FIRST in offer order is reported, and reversing
/// the item order reverses the report. Kills a last-offender report and a loop
/// over `known_item_ids` or `stacks` instead of the offer.
#[test]
fn first_offending_item_in_offer_order_is_reported_ts1_1() {
    let mut s = seat_a();
    s.items[0].qty = 6;
    s.known_item_ids.retain(|&id| id != 12);
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::InsufficientItems { item_id: 11 })
    );
    s.items.reverse();
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::UnknownItem { item_id: 12 })
    );
}

/// Duplicates are checked before per-row facts (monsters before items), and the
/// id reported is that of the first entry, in offer order, that repeats an
/// earlier entry. Kills a duplicate check moved after the per-row loop, item
/// duplicates checked first, a report of the first id that has a LATER copy, and
/// a report of the last repeat found.
#[test]
fn duplicate_ids_are_reported_before_per_row_defects_ts1_1() {
    let mut s = seat_a();
    s.monster_ids = vec![101, 104, 101];
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::DuplicateMonster { monster_id: 101 })
    );
    s.monster_ids = vec![101, 102, 102];
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::DuplicateMonster { monster_id: 102 })
    );
    s.monster_ids = vec![101, 102, 102, 101];
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::DuplicateMonster { monster_id: 102 }),
        "entry 2 is the first to repeat an earlier id"
    );
    s.monster_ids = vec![101, 101, 102, 102];
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::DuplicateMonster { monster_id: 101 }),
        "entry 1 repeats before entry 3 does"
    );

    let mut s = seat_a();
    s.items = vec![item(11, 1), item(12, 1), item(12, 1), item(11, 1)];
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::DuplicateItem { item_id: 12 }),
        "entry 2 is the first to repeat an earlier id"
    );
    s.items = vec![item(11, 1), item(11, 1), item(12, 1), item(12, 1)];
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::DuplicateItem { item_id: 11 }),
        "entry 1 repeats before entry 3 does"
    );

    let mut s = seat_a();
    s.monster_ids = vec![104];
    s.items.push(item(11, 1));
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::DuplicateItem { item_id: 11 })
    );
    s.monster_ids = vec![101, 101];
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::DuplicateMonster { monster_id: 101 })
    );

    let mut s = seat_a();
    s.items = vec![item(12, 0), item(12, 0)];
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::DuplicateItem { item_id: 12 })
    );
}

/// Monster checks precede item checks, which precede the currency check. Kills a
/// reordered category and a deleted category (each fix exposes the next).
#[test]
fn monster_then_item_then_currency_checks_run_in_order_ts1_1() {
    let mut s = seat_a();
    s.row_mut(102).current_hp = 0;
    s.items[1].qty = 0;
    s.currency = 601;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::MonsterFainted { monster_id: 102 })
    );
    s.row_mut(102).current_hp = 1;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::ZeroItemQuantity { item_id: 12 })
    );
    s.items[1].qty = 3;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::InsufficientCurrency)
    );
    s.currency = 600;
    assert_eq!(s.eligibility(), Ok(()));
}

/// Within one row the checks run in contract order: party, HP, other trade,
/// battle for a monster; known, zero, holdings for an item. Each fix exposes the
/// next reason. Kills a reordered or `&&`-merged predicate and a deleted check.
#[test]
fn checks_within_one_row_run_in_contract_order_ts1_1() {
    let mut s = seat_a();
    {
        let r = s.row_mut(101);
        r.party_slot = PARTY_SIZE;
        r.current_hp = 0;
        r.in_other_trade = true;
        r.in_battle = true;
    }
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::MonsterNotInParty { monster_id: 101 })
    );
    s.row_mut(101).party_slot = 0;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::MonsterFainted { monster_id: 101 })
    );
    s.row_mut(101).current_hp = 30;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::MonsterInAnotherTrade { monster_id: 101 })
    );
    s.row_mut(101).in_other_trade = false;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::MonsterInBattle { monster_id: 101 })
    );
    s.row_mut(101).in_battle = false;
    assert_eq!(s.eligibility(), Ok(()));

    let mut s = seat_a();
    s.known_item_ids.retain(|&id| id != 12);
    s.items[1].qty = 0;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::UnknownItem { item_id: 12 })
    );
    s.items[1].qty = 11;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::UnknownItem { item_id: 12 })
    );
    s.known_item_ids.push(12);
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::InsufficientItems { item_id: 12 })
    );
}

/// Every lookup is keyed by the offered id: a defect on the matching row is seen
/// (reported with that id), a change to an unlisted row is not. Kills a lookup
/// that matches the wrong id, takes the first row, or uses row position.
#[test]
fn facts_are_looked_up_by_the_offered_id_ts1_1() {
    let mut s = seat_a();
    s.row_mut(103).current_hp = 50;
    s.row_mut(103).party_slot = 0;
    s.known_item_ids.retain(|&id| id != 99);
    s.stacks.retain(|st| st.item_id != 99);
    s.locked_stacks.retain(|l| l.item_id != 99);
    assert_eq!(s.eligibility(), Ok(()), "unlisted rows never matter");

    let mut s = seat_a();
    s.row_mut(101).in_battle = true;
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::MonsterInBattle { monster_id: 101 }),
        "the last row in the lookup"
    );

    let mut s = seat_a();
    s.known_item_ids.retain(|&id| id != 11);
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::UnknownItem { item_id: 11 })
    );

    let mut s = seat_a();
    s.stacks = vec![stack(99, 0), stack(12, 2), stack(11, 8)];
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::InsufficientItems { item_id: 12 })
    );

    let mut s = seat_a();
    s.stacks = vec![stack(99, 0), stack(12, 10), stack(11, 7)];
    assert_eq!(
        s.eligibility(),
        Err(TradeSessionError::InsufficientItems { item_id: 11 })
    );
}

/// Every one of the 23 variants, built with the same id, in declaration order.
fn all_session_errors() -> [TradeSessionError; 23] {
    [
        TradeSessionError::MonsterNotOwned { monster_id: 7 },
        TradeSessionError::MonsterNotInParty { monster_id: 7 },
        TradeSessionError::MonsterFainted { monster_id: 7 },
        TradeSessionError::MonsterInAnotherTrade { monster_id: 7 },
        TradeSessionError::MonsterInBattle { monster_id: 7 },
        TradeSessionError::DuplicateMonster { monster_id: 7 },
        TradeSessionError::TooManyMonsters,
        TradeSessionError::DuplicateItem { item_id: 7 },
        TradeSessionError::ZeroItemQuantity { item_id: 7 },
        TradeSessionError::UnknownItem { item_id: 7 },
        TradeSessionError::TooManyItems,
        TradeSessionError::InsufficientItems { item_id: 7 },
        TradeSessionError::InsufficientCurrency,
        TradeSessionError::OwnSideEmpty,
        TradeSessionError::OtherSideEmpty,
        TradeSessionError::LastMonster,
        TradeSessionError::ItemStackCapExceeded { item_id: 7 },
        TradeSessionError::CurrencyCapExceeded,
        TradeSessionError::StaleRevision,
        TradeSessionError::SideConfirmed,
        TradeSessionError::SelfTrade,
        TradeSessionError::PairHasOpenSession,
        TradeSessionError::OpenSessionLimit,
    ]
}

/// Exhaustive (no wildcard): a 24th variant is a compile error here, so the
/// list above cannot silently fall short.
fn variant_index(e: &TradeSessionError) -> usize {
    match e {
        TradeSessionError::MonsterNotOwned { .. } => 0,
        TradeSessionError::MonsterNotInParty { .. } => 1,
        TradeSessionError::MonsterFainted { .. } => 2,
        TradeSessionError::MonsterInAnotherTrade { .. } => 3,
        TradeSessionError::MonsterInBattle { .. } => 4,
        TradeSessionError::DuplicateMonster { .. } => 5,
        TradeSessionError::TooManyMonsters => 6,
        TradeSessionError::DuplicateItem { .. } => 7,
        TradeSessionError::ZeroItemQuantity { .. } => 8,
        TradeSessionError::UnknownItem { .. } => 9,
        TradeSessionError::TooManyItems => 10,
        TradeSessionError::InsufficientItems { .. } => 11,
        TradeSessionError::InsufficientCurrency => 12,
        TradeSessionError::OwnSideEmpty => 13,
        TradeSessionError::OtherSideEmpty => 14,
        TradeSessionError::LastMonster => 15,
        TradeSessionError::ItemStackCapExceeded { .. } => 16,
        TradeSessionError::CurrencyCapExceeded => 17,
        TradeSessionError::StaleRevision => 18,
        TradeSessionError::SideConfirmed => 19,
        TradeSessionError::SelfTrade => 20,
        TradeSessionError::PairHasOpenSession => 21,
        TradeSessionError::OpenSessionLimit => 22,
    }
}

/// Every id-bearing variant, built from an id (monster ids widened to `u64`).
fn id_bearing_errors() -> [fn(u32) -> TradeSessionError; 11] {
    [
        |id| TradeSessionError::MonsterNotOwned {
            monster_id: u64::from(id),
        },
        |id| TradeSessionError::MonsterNotInParty {
            monster_id: u64::from(id),
        },
        |id| TradeSessionError::MonsterFainted {
            monster_id: u64::from(id),
        },
        |id| TradeSessionError::MonsterInAnotherTrade {
            monster_id: u64::from(id),
        },
        |id| TradeSessionError::MonsterInBattle {
            monster_id: u64::from(id),
        },
        |id| TradeSessionError::DuplicateMonster {
            monster_id: u64::from(id),
        },
        |id| TradeSessionError::DuplicateItem { item_id: id },
        |id| TradeSessionError::ZeroItemQuantity { item_id: id },
        |id| TradeSessionError::UnknownItem { item_id: id },
        |id| TradeSessionError::InsufficientItems { item_id: id },
        |id| TradeSessionError::ItemStackCapExceeded { item_id: id },
    ]
}

/// Every variant's `Display` wire string is non-empty and differs from every
/// other variant's (same id in each payload, so the wording itself differs), and
/// every id-bearing variant's string carries its own id. Kills an empty
/// `Display`, a shared string, two variants rendered alike, and a string that
/// drops (or hard-codes) the offending id.
#[test]
fn every_error_variant_displays_a_distinct_non_empty_string_ts1_1() {
    for build in id_bearing_errors() {
        let (low, high) = (build(12345), build(67890));
        let (low_s, high_s) = (low.to_string(), high.to_string());
        assert!(low_s.contains("12345"), "{low:?} renders {low_s:?}");
        assert!(high_s.contains("67890"), "{high:?} renders {high_s:?}");
        assert_ne!(low_s, high_s, "{low:?} and {high:?} render alike");
    }

    let all = all_session_errors();
    for (i, e) in all.iter().enumerate() {
        assert_eq!(variant_index(e), i, "{e:?} listed once, in order");
    }
    let strings: Vec<String> = all.iter().map(ToString::to_string).collect();
    for (e, s) in all.iter().zip(&strings) {
        assert!(!s.trim().is_empty(), "{e:?} renders an empty string");
    }
    for (i, (s_i, e_i)) in strings.iter().zip(&all).enumerate() {
        for (s_j, e_j) in strings[i + 1..].iter().zip(&all[i + 1..]) {
            assert_ne!(s_i, s_j, "{e_i:?} and {e_j:?} render the same string");
        }
    }
}

// ---------------------------------------------------------------------------
// ts-1.2 — edits, confirms, revisions
// ---------------------------------------------------------------------------

/// A display card for `monster_id`; every field differs between the cards of
/// `offer_x`, `offer_y` and `offer_z`, so a lost, stripped or stale card list
/// changes the state.
fn card(monster_id: u64, species_id: u32, nickname: &str, level: u8) -> MonsterCard {
    MonsterCard {
        monster_id,
        species_id,
        nickname: String::from(nickname),
        level,
        current_hp: u16::from(level) * 3,
        stat_hp: u16::from(level) * 4,
    }
}

fn offer_x() -> TradeSessionOffer {
    TradeSessionOffer {
        monster_ids: vec![101],
        items: vec![item(11, 2)],
        currency: 5,
        cards: vec![card(101, 7, "Ember", 4)],
    }
}

fn offer_y() -> TradeSessionOffer {
    TradeSessionOffer {
        monster_ids: vec![201, 202],
        items: Vec::new(),
        currency: 0,
        cards: vec![card(201, 8, "Ripple", 6), card(202, 9, "Gust", 8)],
    }
}

fn offer_z() -> TradeSessionOffer {
    TradeSessionOffer {
        monster_ids: vec![102],
        items: vec![item(12, 1)],
        currency: 9,
        cards: vec![card(102, 10, "Moss", 10)],
    }
}

fn session(opener_confirmed: bool, partner_confirmed: bool, revision: u64) -> TradeSessionState {
    TradeSessionState {
        opener_offer: offer_x(),
        partner_offer: offer_y(),
        opener_confirmed,
        partner_confirmed,
        revision,
    }
}

/// An unconfirmed opener's edit replaces ONLY the opener's offer, advances the
/// revision by exactly one and clears both flags, whatever the partner's flag.
/// Kills editing the wrong side, a revision `+ 0` / `+ 2` / constant, a flag left
/// set, an edit that also rewrites the other offer, and an edit that strips the
/// new offer's cards or keeps the old ones.
#[test]
fn opener_edit_replaces_only_the_opener_offer_and_resets_ts1_2() {
    for partner_confirmed in [false, true] {
        for revision in [0, 7, 41] {
            let edited = apply_edit(
                session(false, partner_confirmed, revision),
                SessionSide::Opener,
                offer_z(),
            );
            assert_eq!(
                edited,
                Ok(TradeSessionState {
                    opener_offer: offer_z(),
                    partner_offer: offer_y(),
                    opener_confirmed: false,
                    partner_confirmed: false,
                    revision: revision + 1,
                }),
                "partner_confirmed {partner_confirmed}, revision {revision}"
            );
        }
    }
    let cleared = apply_edit(
        session(false, false, 3),
        SessionSide::Opener,
        TradeSessionOffer::default(),
    );
    assert_eq!(
        cleared,
        Ok(TradeSessionState {
            opener_offer: TradeSessionOffer::default(),
            partner_offer: offer_y(),
            opener_confirmed: false,
            partner_confirmed: false,
            revision: 4,
        }),
        "clearing one's own side is a legal edit"
    );
}

/// An unconfirmed partner's edit replaces ONLY the partner's offer, advances the
/// revision by one and clears both flags, whatever the opener's flag. Kills a
/// side mapping that always edits the opener.
#[test]
fn partner_edit_replaces_only_the_partner_offer_and_resets_ts1_2() {
    for opener_confirmed in [false, true] {
        for revision in [0, 7, 41] {
            let edited = apply_edit(
                session(opener_confirmed, false, revision),
                SessionSide::Partner,
                offer_z(),
            );
            assert_eq!(
                edited,
                Ok(TradeSessionState {
                    opener_offer: offer_x(),
                    partner_offer: offer_z(),
                    opener_confirmed: false,
                    partner_confirmed: false,
                    revision: revision + 1,
                }),
                "opener_confirmed {opener_confirmed}, revision {revision}"
            );
        }
    }
}

/// A confirmed opener cannot edit (`SideConfirmed`), whatever the partner's
/// flag. Kills a deleted guard and a guard reading the partner's flag.
#[test]
fn confirmed_opener_cannot_edit_ts1_2() {
    for partner_confirmed in [false, true] {
        assert_eq!(
            apply_edit(
                session(true, partner_confirmed, 7),
                SessionSide::Opener,
                offer_z()
            ),
            Err(TradeSessionError::SideConfirmed),
            "partner_confirmed {partner_confirmed}"
        );
    }
}

/// A confirmed partner cannot edit (`SideConfirmed`), whatever the opener's
/// flag. Kills a guard reading the opener's flag for the partner.
#[test]
fn confirmed_partner_cannot_edit_ts1_2() {
    for opener_confirmed in [false, true] {
        assert_eq!(
            apply_edit(
                session(opener_confirmed, true, 7),
                SessionSide::Partner,
                offer_z()
            ),
            Err(TradeSessionError::SideConfirmed),
            "opener_confirmed {opener_confirmed}"
        );
    }
}

/// `reset_confirms` clears both flags, advances the revision by exactly one and
/// leaves both offers untouched, from every flag combination. Kills a flag left
/// set, a revision unchanged or `+ 2`, and an offer (or its cards) cleared.
#[test]
fn reset_confirms_clears_both_flags_and_advances_the_revision_ts1_2() {
    for opener_confirmed in [false, true] {
        for partner_confirmed in [false, true] {
            for revision in [0, 7, 41] {
                assert_eq!(
                    reset_confirms(session(opener_confirmed, partner_confirmed, revision)),
                    TradeSessionState {
                        opener_offer: offer_x(),
                        partner_offer: offer_y(),
                        opener_confirmed: false,
                        partner_confirmed: false,
                        revision: revision + 1,
                    },
                    "flags ({opener_confirmed}, {partner_confirmed}), revision {revision}"
                );
            }
        }
    }
}

/// `can_confirm` rejects a reviewed revision below or above the current one with
/// `StaleRevision`, for a side that would otherwise pass. Kills `!=` → `==`, a
/// `<` / `>` one-sided comparison, and a deleted revision check.
#[test]
fn confirm_with_a_revision_other_than_the_current_one_is_stale_ts1_2() {
    let trade = baseline();
    assert_eq!(trade.check_a(), Ok(()), "fixture: the side itself passes");
    for (current, reviewed) in [(5, 4), (5, 6), (5, 0), (0, 1), (u64::MAX, 0), (0, u64::MAX)] {
        assert_eq!(
            trade.confirm_a(current, reviewed),
            Err(TradeSessionError::StaleRevision),
            "current {current}, reviewed {reviewed}"
        );
    }
}

/// A stale revision is reported before any side failure. Kills a revision check
/// placed after `side_check`.
#[test]
fn stale_revision_is_reported_before_the_side_check_ts1_2() {
    let mut empty = baseline();
    empty.a.monster_ids.clear();
    empty.a.items.clear();
    empty.a.currency = 0;
    assert_eq!(empty.confirm_a(5, 4), Err(TradeSessionError::StaleRevision));

    let mut fainted = baseline();
    fainted.a.row_mut(102).current_hp = 0;
    assert_eq!(
        fainted.confirm_a(5, 6),
        Err(TradeSessionError::StaleRevision)
    );
}

/// At the current revision `can_confirm` returns exactly what `side_check`
/// returns: `Ok` for a valid side, the side's own reason otherwise. Kills a
/// constant result and a `can_confirm` that skips `side_check`.
#[test]
fn confirm_at_the_current_revision_returns_the_side_check_result_ts1_2() {
    let trade = baseline();
    for revision in [0, 5, u64::MAX] {
        assert_eq!(trade.confirm_a(revision, revision), Ok(()));
    }

    let mut fainted = baseline();
    fainted.a.row_mut(102).current_hp = 0;
    assert_eq!(
        fainted.confirm_a(5, 5),
        Err(TradeSessionError::MonsterFainted { monster_id: 102 })
    );

    let mut empty = baseline();
    empty.a.monster_ids.clear();
    empty.a.items.clear();
    empty.a.currency = 0;
    assert_eq!(empty.confirm_a(5, 5), Err(TradeSessionError::OwnSideEmpty));

    let mut last = baseline();
    last.a_owned = 2;
    last.b.monster_ids.clear();
    assert_eq!(last.confirm_a(5, 5), Err(TradeSessionError::LastMonster));
}

// ---------------------------------------------------------------------------
// ts-1.3 — emptiness and the last-monster guard
// ---------------------------------------------------------------------------

fn empty_out(s: &mut Side) {
    s.monster_ids.clear();
    s.items.clear();
    s.currency = 0;
}

/// When seat A's side is empty, A's check reports `OwnSideEmpty` and B's reports
/// `OtherSideEmpty`; the mirror holds for an empty seat B; and the other side's
/// emptiness is reported before the caller's own eligibility defect. Kills an
/// emptiness rule applied to one seat only, swapped own/other reasons, and
/// emptiness checked after eligibility.
#[test]
fn an_empty_side_is_rejected_from_both_seats_ts1_3() {
    let mut a_empty = baseline();
    empty_out(&mut a_empty.a);
    assert_eq!(a_empty.check_a(), Err(TradeSessionError::OwnSideEmpty));
    assert_eq!(a_empty.check_b(), Err(TradeSessionError::OtherSideEmpty));

    let mut b_empty = baseline();
    empty_out(&mut b_empty.b);
    assert_eq!(b_empty.check_b(), Err(TradeSessionError::OwnSideEmpty));
    assert_eq!(b_empty.check_a(), Err(TradeSessionError::OtherSideEmpty));

    b_empty.a.row_mut(102).current_hp = 0;
    assert_eq!(
        b_empty.check_a(),
        Err(TradeSessionError::OtherSideEmpty),
        "emptiness precedes the caller's own eligibility"
    );
}

/// With both sides empty each seat reports its OWN side first. Kills the other
/// side's emptiness checked before the caller's.
#[test]
fn both_sides_empty_reports_the_own_side_from_each_seat_ts1_3() {
    let mut both = baseline();
    empty_out(&mut both.a);
    empty_out(&mut both.b);
    assert_eq!(both.check_a(), Err(TradeSessionError::OwnSideEmpty));
    assert_eq!(both.check_b(), Err(TradeSessionError::OwnSideEmpty));
}

/// A monster alone, a positive-quantity item alone, or currency alone makes a
/// side non-empty, on the own side and on the incoming side. Kills an emptiness
/// rule requiring every asset kind (`||` → `&&`) or ignoring one kind.
#[test]
fn any_single_asset_kind_makes_a_side_non_empty_ts1_3() {
    let only_monsters: fn(&mut Side) = |s| {
        s.items.clear();
        s.currency = 0;
    };
    let only_items: fn(&mut Side) = |s| {
        s.monster_ids.clear();
        s.currency = 0;
    };
    let only_currency: fn(&mut Side) = |s| {
        s.monster_ids.clear();
        s.items.clear();
    };
    for (name, keep_one_kind) in [
        ("monsters", only_monsters),
        ("items", only_items),
        ("currency", only_currency),
    ] {
        let mut own = baseline();
        keep_one_kind(&mut own.a);
        assert!(!own.a.offer().is_empty(), "own {name}");
        assert_eq!(own.check_a(), Ok(()), "own side with only {name}");

        let mut incoming = baseline();
        keep_one_kind(&mut incoming.b);
        assert!(!incoming.b.offer().is_empty(), "incoming {name}");
        assert_eq!(incoming.check_a(), Ok(()), "incoming side with only {name}");
    }
}

/// Items of quantity 0 do not make a side non-empty (own → `OwnSideEmpty`,
/// incoming → `OtherSideEmpty`), cards never count, and one positive item among
/// zero-quantity ones does count (so eligibility then reports the zero). Kills an
/// emptiness rule that tests `items.is_empty()`, one that requires ALL items to be
/// positive, and one that counts cards.
#[test]
fn zero_quantity_items_and_cards_do_not_make_a_side_non_empty_ts1_3() {
    let mut own = baseline();
    empty_out(&mut own.a);
    own.a.items = vec![item(11, 0)];
    assert!(own.a.offer().is_empty());
    assert_eq!(own.check_a(), Err(TradeSessionError::OwnSideEmpty));

    own.a.items = vec![item(11, 0), item(12, 1)];
    assert!(!own.a.offer().is_empty());
    assert_eq!(
        own.check_a(),
        Err(TradeSessionError::ZeroItemQuantity { item_id: 11 })
    );

    let mut incoming = baseline();
    empty_out(&mut incoming.b);
    incoming.b.items = vec![item(11, 0), item(12, 0)];
    assert_eq!(incoming.check_a(), Err(TradeSessionError::OtherSideEmpty));

    assert!(TradeSessionOffer::default().is_empty());
    let cards_only = TradeSessionOffer {
        cards: vec![MonsterCard {
            monster_id: 1,
            species_id: 2,
            nickname: String::from("Pip"),
            level: 3,
            current_hp: 4,
            stat_hp: 5,
        }],
        ..TradeSessionOffer::default()
    };
    assert!(cards_only.is_empty());
}

/// The last-monster guard fires exactly when owned − outgoing + incoming is 0,
/// from either seat. Kills `<=` → `<`, `saturating_add` → `saturating_sub`, the
/// incoming count ignored, and the guard reading the other seat's counts.
#[test]
fn last_monster_guard_fires_exactly_at_a_zero_post_trade_count_ts1_3() {
    // A owns 2, gives both, receives none.
    let mut t = baseline();
    t.a_owned = 2;
    t.b.monster_ids.clear();
    assert_eq!(t.check_a(), Err(TradeSessionError::LastMonster));
    // A owns 3, gives 2, receives none: one stays.
    t.a_owned = 3;
    assert_eq!(t.check_a(), Ok(()));
    // A owns 2, gives both, receives one.
    let mut t = baseline();
    t.a_owned = 2;
    assert_eq!(t.check_a(), Ok(()));
    // A owns 1, gives it, receives none / one.
    let mut t = baseline();
    t.a.monster_ids = vec![101];
    t.a_owned = 1;
    t.b.monster_ids.clear();
    assert_eq!(t.check_a(), Err(TradeSessionError::LastMonster));
    t.b.monster_ids = vec![201];
    assert_eq!(t.check_a(), Ok(()));
    // B's seat in the same trade: B owns 1, gives it, receives none / two.
    let mut t = baseline();
    t.b_owned = 1;
    t.a.monster_ids.clear();
    assert_eq!(t.check_b(), Err(TradeSessionError::LastMonster));
    assert_eq!(t.check_a(), Ok(()), "A gives nothing and keeps 3");
    t.a.monster_ids = vec![101, 102];
    assert_eq!(t.check_b(), Ok(()));
}

/// The ruling on the gate's wording: a player who owns no monster and receives
/// none is refused (`LastMonster`) even though they give none; receiving one
/// makes the trade legal. Kills a guard keyed on "gives away the last" instead of
/// the post-trade count.
#[test]
fn a_player_with_no_monster_must_receive_one_ts1_3() {
    let mut t = baseline();
    t.a.monster_ids.clear();
    t.a_owned = 0;
    t.b.monster_ids.clear();
    assert_eq!(t.check_a(), Err(TradeSessionError::LastMonster));
    t.b.monster_ids = vec![201];
    assert_eq!(t.check_a(), Ok(()));
}

/// Eligibility precedes the last-monster guard, which precedes receipt headroom.
/// Kills a reordered `side_check` and a deleted guard or headroom check.
#[test]
fn side_check_runs_eligibility_then_last_monster_then_headroom_ts1_3() {
    let mut t = baseline();
    t.a.monster_ids = vec![101];
    t.a_owned = 1;
    t.b.monster_ids.clear();
    t.a.row_mut(101).current_hp = 0;
    assert_eq!(
        t.check_a(),
        Err(TradeSessionError::MonsterFainted { monster_id: 101 })
    );
    t.a.row_mut(101).current_hp = 30;
    t.b.items = vec![item(11, MAX_ITEM_STACK)];
    assert_eq!(t.check_a(), Err(TradeSessionError::LastMonster));
    t.a_owned = 2;
    assert_eq!(
        t.check_a(),
        Err(TradeSessionError::ItemStackCapExceeded { item_id: 11 })
    );
}

/// One seat of a generated trade: `out` offered party monsters starting at id
/// `base`, plus one coin so the side is never empty.
fn prop_seat(base: u64, out: usize) -> Side {
    let ids: Vec<u64> = (base..).take(out).collect();
    Side {
        monster_rows: ids.iter().map(|&id| row(id, 0, 10)).collect(),
        monster_ids: ids,
        items: Vec::new(),
        currency: 1,
        known_item_ids: Vec::new(),
        stacks: Vec::new(),
        locked_stacks: Vec::new(),
        balance: 1,
        locked_currency: 0,
    }
}

/// `(owned, outgoing)` for one seat: outgoing never exceeds owned.
fn seat_counts() -> impl Strategy<Value = (usize, usize)> {
    (0usize..=8).prop_flat_map(|owned| (Just(owned), 0..=owned.min(6)))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// For both seats of any generated trade: `side_check` is `Ok` whenever the
    /// seat's post-trade count (owned − outgoing + incoming) is at least 1 — zero
    /// false positives — and `LastMonster` exactly when it is 0. Kills every
    /// off-by-one in the guard and a guard that ignores incoming monsters.
    #[test]
    fn last_monster_guard_never_rejects_a_trade_leaving_both_players_a_monster_ts1_3(
        (a_owned, a_out) in seat_counts(),
        (b_owned, b_out) in seat_counts(),
    ) {
        let trade = Trade {
            a: prop_seat(1_000, a_out),
            a_owned,
            b: prop_seat(2_000, b_out),
            b_owned,
        };
        for (seat, result, owned, out, incoming) in [
            ("A", trade.check_a(), a_owned, a_out, b_out),
            ("B", trade.check_b(), b_owned, b_out, a_out),
        ] {
            let post = owned - out + incoming;
            let expected = if post == 0 {
                Err(TradeSessionError::LastMonster)
            } else {
                Ok(())
            };
            prop_assert_eq!(result, expected, "seat {} post-trade count {}", seat, post);
        }
    }
}

// ---------------------------------------------------------------------------
// ts-1.4 — execute verdicts, receiver-attributed headroom, snapshot drift
// ---------------------------------------------------------------------------

/// The four-row truth table: both `Ok` → `Execute`; own `Err` → `RejectCaller`
/// with the caller's own reason, whether or not the other side also fails; only
/// the other side failing → `ResetOther`. Kills swapped arguments, a constant
/// verdict, and the other side's reason winning when both fail.
#[test]
fn judge_execute_truth_table_ts1_4() {
    assert_eq!(judge_execute(Ok(()), Ok(())), ExecuteVerdict::Execute);
    assert_eq!(
        judge_execute(Err(TradeSessionError::LastMonster), Ok(())),
        ExecuteVerdict::RejectCaller(TradeSessionError::LastMonster)
    );
    assert_eq!(
        judge_execute(Ok(()), Err(TradeSessionError::InsufficientCurrency)),
        ExecuteVerdict::ResetOther
    );
    assert_eq!(
        judge_execute(
            Err(TradeSessionError::MonsterFainted { monster_id: 5 }),
            Err(TradeSessionError::CurrencyCapExceeded)
        ),
        ExecuteVerdict::RejectCaller(TradeSessionError::MonsterFainted { monster_id: 5 })
    );
}

/// Whatever the other side's reason, it never reaches the verdict: `ResetOther`
/// alone, or the caller's own reason. Kills a verdict that forwards the other
/// side's error.
#[test]
fn the_other_sides_reason_never_surfaces_ts1_4() {
    let own = TradeSessionError::InsufficientItems { item_id: 3 };
    for other in all_session_errors() {
        assert_eq!(
            judge_execute(Ok(()), Err(other.clone())),
            ExecuteVerdict::ResetOther,
            "other {other:?}"
        );
        assert_eq!(
            judge_execute(Err(own.clone()), Err(other.clone())),
            ExecuteVerdict::RejectCaller(own.clone()),
            "other {other:?}"
        );
    }
}

/// Seat B receives A's items (11 × 5, 12 × 3) while holding `s11` / `s12` of
/// them, and offers only one unit of item 13 (so nothing nets).
fn b_receiving_items_holding(s11: u32, s12: u32) -> Trade {
    let mut t = baseline();
    t.b.items = vec![item(13, 1)];
    t.b.known_item_ids = vec![13];
    t.b.stacks = vec![stack(13, 1), stack(11, s11), stack(12, s12)];
    t
}

/// Seat B receives A's 600 coins holding `balance`, offering no currency itself.
fn b_receiving_currency_holding(balance: u64) -> Trade {
    let mut t = baseline();
    t.b.currency = 0;
    t.b.balance = balance;
    t
}

/// An item overflow is reported by the RECEIVER's `side_check` and never by the
/// giver's. Kills headroom checked against the giver's own outgoing items or
/// the giver's stacks.
#[test]
fn item_receipt_overflow_is_reported_by_the_receiver_not_the_giver_ts1_4() {
    let t = b_receiving_items_holding(MAX_ITEM_STACK - 4, 0);
    assert_eq!(
        t.check_b(),
        Err(TradeSessionError::ItemStackCapExceeded { item_id: 11 })
    );
    assert_eq!(
        t.check_a(),
        Ok(()),
        "the giver never reports the receiver's cap"
    );
}

/// An exact fill to `MAX_ITEM_STACK` is accepted and one more is rejected, for
/// the first and the second incoming item; with both overflowing the first is
/// reported; a lock on the receiver's stack does not create headroom. Kills a
/// headroom check on the first item only, a last-offender report, and netting
/// the receiver's locks.
#[test]
fn item_receipt_accepts_an_exact_fill_and_rejects_one_more_ts1_4() {
    assert_eq!(
        b_receiving_items_holding(MAX_ITEM_STACK - 5, 0).check_b(),
        Ok(())
    );
    assert_eq!(
        b_receiving_items_holding(0, MAX_ITEM_STACK - 3).check_b(),
        Ok(())
    );
    assert_eq!(
        b_receiving_items_holding(0, MAX_ITEM_STACK - 2).check_b(),
        Err(TradeSessionError::ItemStackCapExceeded { item_id: 12 })
    );
    assert_eq!(
        b_receiving_items_holding(MAX_ITEM_STACK - 4, MAX_ITEM_STACK - 2).check_b(),
        Err(TradeSessionError::ItemStackCapExceeded { item_id: 11 })
    );
    let mut locked = b_receiving_items_holding(MAX_ITEM_STACK - 4, 0);
    locked.b.locked_stacks = vec![stack(11, 100)];
    assert_eq!(
        locked.check_b(),
        Err(TradeSessionError::ItemStackCapExceeded { item_id: 11 })
    );
}

/// Same-item netting: holding 9990, giving 15 and receiving 20 of the same item
/// fits (9995); giving 11 is an exact fill (9999), giving 10 overflows; the same
/// receipt without the give, or with a give of a DIFFERENT item, overflows.
/// Kills netting removed, `saturating_sub` operands swapped, and netting across
/// item ids.
#[test]
fn same_item_netting_counts_the_receivers_own_outgoing_qty_ts1_4() {
    let mut t = baseline();
    t.a.items = vec![item(11, 20)];
    t.a.stacks = vec![stack(11, 30)];
    t.b.items = vec![item(11, 15)];
    t.b.known_item_ids = vec![11, 13];
    t.b.stacks = vec![stack(11, 9990), stack(13, 15)];
    assert_eq!(
        MAX_ITEM_STACK, 9999,
        "fixture arithmetic assumes the 9999 cap"
    );
    assert_eq!(t.check_b(), Ok(()), "9990 − 15 + 20 = 9995");
    assert_eq!(t.check_a(), Ok(()));

    t.b.items = vec![item(11, 11)];
    assert_eq!(t.check_b(), Ok(()), "9990 − 11 + 20 = 9999");
    t.b.items = vec![item(11, 10)];
    assert_eq!(
        t.check_b(),
        Err(TradeSessionError::ItemStackCapExceeded { item_id: 11 }),
        "9990 − 10 + 20 = 10000"
    );

    t.b.items = vec![item(13, 15)];
    assert_eq!(
        t.check_b(),
        Err(TradeSessionError::ItemStackCapExceeded { item_id: 11 }),
        "giving another item does not net item 11"
    );
}

/// A currency overflow is reported by the RECEIVER and not the giver; an exact
/// fill to `MAX_BALANCE` is accepted, one more rejected; a lock on the
/// receiver's wallet does not create headroom. Kills an off-by-one at the cap,
/// headroom checked on the giver, and netting the receiver's locked currency.
#[test]
fn currency_receipt_overflow_is_reported_by_the_receiver_not_the_giver_ts1_4() {
    let over = b_receiving_currency_holding(MAX_BALANCE - 599);
    assert_eq!(over.check_b(), Err(TradeSessionError::CurrencyCapExceeded));
    assert_eq!(over.check_a(), Ok(()));

    assert_eq!(
        b_receiving_currency_holding(MAX_BALANCE - 600).check_b(),
        Ok(())
    );

    let mut locked = b_receiving_currency_holding(MAX_BALANCE - 599);
    locked.b.locked_currency = 1000;
    assert_eq!(
        locked.check_b(),
        Err(TradeSessionError::CurrencyCapExceeded)
    );
}

/// Bilateral currency netting: at `MAX_BALANCE`, giving 600 and receiving 600
/// fits exactly; receiving 601 overflows; giving nothing and receiving 1
/// overflows. Kills netting removed and `saturating_sub` operands swapped.
#[test]
fn bilateral_currency_netting_counts_the_receivers_own_outgoing_coins_ts1_4() {
    let mut t = baseline();
    t.b.balance = MAX_BALANCE;
    t.b.currency = 600;
    assert_eq!(t.check_b(), Ok(()), "MAX − 600 + 600 = MAX");
    assert_eq!(t.check_a(), Ok(()));

    t.a.locked_currency = 0;
    t.a.currency = 601;
    assert_eq!(t.check_a(), Ok(()), "601 of A's unlocked 1000 is eligible");
    assert_eq!(t.check_b(), Err(TradeSessionError::CurrencyCapExceeded));

    t.a.currency = 1;
    t.b.currency = 0;
    assert_eq!(t.check_b(), Err(TradeSessionError::CurrencyCapExceeded));
}

/// From each seat, through `judge_execute(own, other)`: the receiver that would
/// overflow gets `RejectCaller` with its cap error, the giver gets `ResetOther`
/// (for items and for currency), and a valid trade executes from both seats.
/// Kills a headroom failure attributed to the giver end to end.
#[test]
fn headroom_failure_rejects_the_receiver_and_resets_from_the_givers_seat_ts1_4() {
    let ok = baseline();
    assert_eq!(
        judge_execute(ok.check_a(), ok.check_b()),
        ExecuteVerdict::Execute
    );
    assert_eq!(
        judge_execute(ok.check_b(), ok.check_a()),
        ExecuteVerdict::Execute
    );

    let items = b_receiving_items_holding(MAX_ITEM_STACK - 4, 0);
    assert_eq!(
        judge_execute(items.check_b(), items.check_a()),
        ExecuteVerdict::RejectCaller(TradeSessionError::ItemStackCapExceeded { item_id: 11 })
    );
    assert_eq!(
        judge_execute(items.check_a(), items.check_b()),
        ExecuteVerdict::ResetOther
    );

    let coins = b_receiving_currency_holding(MAX_BALANCE - 599);
    assert_eq!(
        judge_execute(coins.check_b(), coins.check_a()),
        ExecuteVerdict::RejectCaller(TradeSessionError::CurrencyCapExceeded)
    );
    assert_eq!(
        judge_execute(coins.check_a(), coins.check_b()),
        ExecuteVerdict::ResetOther
    );
}

/// Every field set to a distinct non-zero value.
fn base_snapshot() -> MonsterSnapshot {
    MonsterSnapshot {
        monster_id: 1,
        species_id: 2,
        nickname: String::from("Sparky"),
        level: 3,
        xp: 4,
        iv_hp: 5,
        iv_attack: 6,
        iv_defense: 7,
        iv_speed: 8,
        iv_sp_attack: 9,
        iv_sp_defense: 10,
        nature_kind: NatureKind::Brave,
        ev_hp: 11,
        ev_attack: 12,
        ev_defense: 13,
        ev_speed: 14,
        ev_sp_attack: 15,
        ev_sp_defense: 16,
        stat_hp: 17,
        stat_attack: 18,
        stat_defense: 19,
        stat_speed: 20,
        stat_sp_attack: 21,
        stat_sp_defense: 22,
        current_hp: 23,
        party_slot: 24,
        last_care_at_ms: 25,
        essence_fire: 26,
        essence_water: 27,
        essence_plant: 28,
        essence_electric: 29,
        essence_earth: 30,
        essence_wind: 31,
        essence_light: 32,
        essence_dark: 33,
        trust_favorable_count: 34,
        trust_unfavorable_count: 35,
        trust_favorable_battle_day_epoch: 36,
        quality_time_ticks_total: 37,
        quality_time_accum_ms: 38,
        quality_time_window_ms: 39,
        quality_time_window_start_ms: 40,
        last_essence_train_at_ms: 41,
    }
}

/// Exhaustive destructure (no `..`): a 44th `MonsterSnapshot` field is a compile
/// error here, forcing the two mutator tables below to be revisited.
fn snapshot_field_count(s: &MonsterSnapshot) -> usize {
    let MonsterSnapshot {
        monster_id: _,
        species_id: _,
        nickname: _,
        level: _,
        xp: _,
        iv_hp: _,
        iv_attack: _,
        iv_defense: _,
        iv_speed: _,
        iv_sp_attack: _,
        iv_sp_defense: _,
        nature_kind: _,
        ev_hp: _,
        ev_attack: _,
        ev_defense: _,
        ev_speed: _,
        ev_sp_attack: _,
        ev_sp_defense: _,
        stat_hp: _,
        stat_attack: _,
        stat_defense: _,
        stat_speed: _,
        stat_sp_attack: _,
        stat_sp_defense: _,
        current_hp: _,
        party_slot: _,
        last_care_at_ms: _,
        essence_fire: _,
        essence_water: _,
        essence_plant: _,
        essence_electric: _,
        essence_earth: _,
        essence_wind: _,
        essence_light: _,
        essence_dark: _,
        trust_favorable_count: _,
        trust_unfavorable_count: _,
        trust_favorable_battle_day_epoch: _,
        quality_time_ticks_total: _,
        quality_time_accum_ms: _,
        quality_time_window_ms: _,
        quality_time_window_start_ms: _,
        last_essence_train_at_ms: _,
    } = s;
    43
}

type SnapshotMutation = (&'static str, fn(&mut MonsterSnapshot));

/// The 9 columns drift ignores: current HP, party slot, the seven bond columns.
fn masked_mutations() -> [SnapshotMutation; 9] {
    [
        ("current_hp", |s| s.current_hp += 1),
        ("party_slot", |s| s.party_slot += 1),
        ("trust_favorable_count", |s| s.trust_favorable_count += 1),
        ("trust_unfavorable_count", |s| {
            s.trust_unfavorable_count += 1
        }),
        ("trust_favorable_battle_day_epoch", |s| {
            s.trust_favorable_battle_day_epoch += 1;
        }),
        ("quality_time_ticks_total", |s| {
            s.quality_time_ticks_total += 1
        }),
        ("quality_time_accum_ms", |s| s.quality_time_accum_ms += 1),
        ("quality_time_window_ms", |s| s.quality_time_window_ms += 1),
        ("quality_time_window_start_ms", |s| {
            s.quality_time_window_start_ms += 1;
        }),
    ]
}

/// The 34 columns drift reviews: every other column.
fn reviewed_mutations() -> [SnapshotMutation; 34] {
    [
        ("monster_id", |s| s.monster_id += 1),
        ("species_id", |s| s.species_id += 1),
        ("nickname", |s| s.nickname.push('!')),
        ("level", |s| s.level += 1),
        ("xp", |s| s.xp += 1),
        ("iv_hp", |s| s.iv_hp += 1),
        ("iv_attack", |s| s.iv_attack += 1),
        ("iv_defense", |s| s.iv_defense += 1),
        ("iv_speed", |s| s.iv_speed += 1),
        ("iv_sp_attack", |s| s.iv_sp_attack += 1),
        ("iv_sp_defense", |s| s.iv_sp_defense += 1),
        ("nature_kind", |s| s.nature_kind = NatureKind::Timid),
        ("ev_hp", |s| s.ev_hp += 1),
        ("ev_attack", |s| s.ev_attack += 1),
        ("ev_defense", |s| s.ev_defense += 1),
        ("ev_speed", |s| s.ev_speed += 1),
        ("ev_sp_attack", |s| s.ev_sp_attack += 1),
        ("ev_sp_defense", |s| s.ev_sp_defense += 1),
        ("stat_hp", |s| s.stat_hp += 1),
        ("stat_attack", |s| s.stat_attack += 1),
        ("stat_defense", |s| s.stat_defense += 1),
        ("stat_speed", |s| s.stat_speed += 1),
        ("stat_sp_attack", |s| s.stat_sp_attack += 1),
        ("stat_sp_defense", |s| s.stat_sp_defense += 1),
        ("last_care_at_ms", |s| s.last_care_at_ms += 1),
        ("essence_fire", |s| s.essence_fire += 1),
        ("essence_water", |s| s.essence_water += 1),
        ("essence_plant", |s| s.essence_plant += 1),
        ("essence_electric", |s| s.essence_electric += 1),
        ("essence_earth", |s| s.essence_earth += 1),
        ("essence_wind", |s| s.essence_wind += 1),
        ("essence_light", |s| s.essence_light += 1),
        ("essence_dark", |s| s.essence_dark += 1),
        ("last_essence_train_at_ms", |s| {
            s.last_essence_train_at_ms += 1
        }),
    ]
}

/// Identical snapshots do not drift; `masked()` zeroes exactly the 9 masked
/// columns and leaves the 34 others; a masked copy never drifts from its
/// original. Kills a constant `true`, `masked()` returning `self` or
/// `Default::default()`, and a mask over the wrong column.
#[test]
fn identical_and_masked_copies_do_not_drift_ts1_4() {
    let base = base_snapshot();
    assert!(!snapshot_drifted(&base, &base_snapshot()));
    assert_eq!(
        base.clone().masked(),
        MonsterSnapshot {
            current_hp: 0,
            party_slot: 0,
            trust_favorable_count: 0,
            trust_unfavorable_count: 0,
            trust_favorable_battle_day_epoch: 0,
            quality_time_ticks_total: 0,
            quality_time_accum_ms: 0,
            quality_time_window_ms: 0,
            quality_time_window_start_ms: 0,
            ..base_snapshot()
        }
    );
    assert!(!snapshot_drifted(&base.clone().masked(), &base));
    assert!(!snapshot_drifted(&base, &base.clone().masked()));
}

/// A change in any one of the 9 masked columns (current HP, party slot, the
/// seven bond columns), or in all of them at once, is not drift, in either
/// argument order. The two tables plus the exhaustive destructure cover all 43
/// columns. Kills a drift comparison over the raw rows.
#[test]
fn a_change_in_a_masked_column_is_not_drift_ts1_4() {
    let masked = masked_mutations();
    let reviewed = reviewed_mutations();
    assert_eq!(masked.len(), 9);
    assert_eq!(reviewed.len(), 34);
    assert_eq!(
        masked.len() + reviewed.len(),
        snapshot_field_count(&base_snapshot())
    );
    let base = base_snapshot();
    let mut all_masked_changed = base_snapshot();
    for (name, mutate) in masked {
        let mut live = base_snapshot();
        mutate(&mut live);
        assert_ne!(live, base, "fixture: {name} actually changes");
        assert!(!snapshot_drifted(&base, &live), "{name} is masked");
        assert!(
            !snapshot_drifted(&live, &base),
            "{name} is masked (reversed)"
        );
        mutate(&mut all_masked_changed);
    }
    assert!(!snapshot_drifted(&base, &all_masked_changed));
}

/// A change in any one of the 34 reviewed columns is drift, in either argument
/// order. Kills a constant `false`, a drift comparison over a subset of
/// columns, and a mask that zeroes a reviewed column.
#[test]
fn a_change_in_any_reviewed_column_is_drift_ts1_4() {
    let base = base_snapshot();
    for (name, mutate) in reviewed_mutations() {
        let mut live = base_snapshot();
        mutate(&mut live);
        assert_ne!(live, base, "fixture: {name} actually changes");
        assert!(snapshot_drifted(&base, &live), "{name} is reviewed");
        assert!(
            snapshot_drifted(&live, &base),
            "{name} is reviewed (reversed)"
        );
    }
}

/// A reviewed change is still drift when every masked column changed too. Kills
/// a drift rule that short-circuits to "no drift" once a masked column differs.
#[test]
fn a_reviewed_change_is_drift_even_alongside_masked_changes_ts1_4() {
    let base = base_snapshot();
    for (name, mutate) in reviewed_mutations() {
        let mut live = base_snapshot();
        for (_, mask_change) in masked_mutations() {
            mask_change(&mut live);
        }
        mutate(&mut live);
        assert!(snapshot_drifted(&base, &live), "{name} with masked noise");
    }
}

// ---------------------------------------------------------------------------
// ts-1.5 — arrival slots
// ---------------------------------------------------------------------------

/// Incoming monsters fill the gaps lowest first, in ascending order, then go to
/// Storage; input order does not matter. Kills highest-first, input-order
/// assignment, an occupied slot reused, and Storage before a free slot.
#[test]
fn arrivals_fill_the_lowest_free_slots_then_storage_ts1_5() {
    assert_eq!(arrival_slots(&[0, 2, 5], 4), vec![1, 3, 4, PARTY_SLOT_NONE]);
    assert_eq!(arrival_slots(&[5, 0, 2], 2), vec![1, 3]);
    assert_eq!(arrival_slots(&[1, 2, 3, 4, 5], 2), vec![0, PARTY_SLOT_NONE]);
    assert_eq!(arrival_slots(&[0, 1, 2, 3, 4], 1), vec![5]);
}

/// A full party sends every arrival to Storage. Kills a slot past
/// `PARTY_SIZE − 1` being handed out.
#[test]
fn a_full_party_sends_every_arrival_to_storage_ts1_5() {
    assert_eq!(
        arrival_slots(&[0, 1, 2, 3, 4, 5], 3),
        vec![PARTY_SLOT_NONE; 3]
    );
    assert_eq!(arrival_slots(&[5, 3, 1, 0, 2, 4], 1), vec![PARTY_SLOT_NONE]);
}

/// An empty party fills from slot 0 up to `PARTY_SIZE − 1`, then Storage. Kills
/// `0..PARTY_SIZE` off by one at either end.
#[test]
fn an_empty_party_fills_from_slot_zero_ts1_5() {
    assert_eq!(arrival_slots(&[], 1), vec![0]);
    assert_eq!(arrival_slots(&[], 6), vec![0, 1, 2, 3, 4, 5]);
    assert_eq!(
        arrival_slots(&[], 8),
        vec![0, 1, 2, 3, 4, 5, PARTY_SLOT_NONE, PARTY_SLOT_NONE]
    );
}

/// No incoming monster yields no entry, whatever the occupancy. Kills a result
/// padded to the free-slot count or to `PARTY_SIZE`.
#[test]
fn no_arrivals_yield_no_slots_ts1_5() {
    assert_eq!(arrival_slots(&[], 0), Vec::<u8>::new());
    assert_eq!(arrival_slots(&[1, 3], 0), Vec::<u8>::new());
    assert_eq!(arrival_slots(&[0, 1, 2, 3, 4, 5], 0), Vec::<u8>::new());
}

/// Out-of-range entries (boxed monsters at 255, junk 6 and 7) and duplicates in
/// the occupancy are harmless. Kills a free-slot count computed as
/// `PARTY_SIZE − occupied.len()` and an out-of-range entry treated as a slot.
#[test]
fn out_of_range_and_duplicate_occupancy_entries_are_ignored_ts1_5() {
    assert_eq!(
        arrival_slots(&[PARTY_SLOT_NONE, 6, 7, 1, 1], 3),
        vec![0, 2, 3]
    );
    assert_eq!(
        arrival_slots(&[PARTY_SLOT_NONE, 0, 0], 7),
        vec![1, 2, 3, 4, 5, PARTY_SLOT_NONE, PARTY_SLOT_NONE]
    );
    assert_eq!(arrival_slots(&[PARTY_SLOT_NONE; 6], 2), vec![0, 1]);
}

/// Occupancy: party slots mixed with out-of-range entries, duplicates allowed.
fn occupancy() -> impl Strategy<Value = Vec<u8>> {
    prop::collection::vec(
        prop_oneof![6 => 0u8..PARTY_SIZE, 1 => PARTY_SIZE..=u8::MAX],
        0..10,
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// For any occupancy and 0..=10 arrivals: one entry per arrival; the party
    /// entries are exactly the lowest `min(incoming, free)` free slots, ascending,
    /// disjoint from the occupied ones; every remaining entry is Storage and comes
    /// after them; occupied ∪ assigned never exceeds `PARTY_SIZE`. The expected
    /// vector is built independently.
    #[test]
    fn arrival_slots_match_the_lowest_free_slots_reference_ts1_5(
        occupied in occupancy(),
        incoming in 0usize..=10,
    ) {
        let got = arrival_slots(&occupied, incoming);
        let free: Vec<u8> = (0..PARTY_SIZE).filter(|slot| !occupied.contains(slot)).collect();
        let expected: Vec<u8> = (0..incoming)
            .map(|i| free.get(i).copied().unwrap_or(PARTY_SLOT_NONE))
            .collect();
        prop_assert_eq!(got.len(), incoming);
        let placed = incoming.min(free.len());
        prop_assert!(got[..placed]
            .iter()
            .all(|slot| *slot < PARTY_SIZE && !occupied.contains(slot)));
        prop_assert!(got[..placed].windows(2).all(|w| w[0] < w[1]));
        prop_assert!(got[placed..].iter().all(|&slot| slot == PARTY_SLOT_NONE));
        let mut held: Vec<u8> = occupied.iter().copied().filter(|&s| s < PARTY_SIZE).collect();
        held.sort_unstable();
        held.dedup();
        let mut union: Vec<u8> = held
            .iter()
            .copied()
            .chain(got.iter().copied().filter(|&s| s < PARTY_SIZE))
            .collect();
        union.sort_unstable();
        union.dedup();
        prop_assert_eq!(union.len(), held.len() + placed);
        prop_assert!(union.len() <= usize::from(PARTY_SIZE));
        prop_assert_eq!(got, expected);
    }
}

// ---------------------------------------------------------------------------
// ts-1.6 — session-open predicates and constants
// ---------------------------------------------------------------------------

/// A pair matches a row in either orientation, for numeric and string ids.
/// Kills `||` → `&&` across orientations and a single-orientation match.
#[test]
fn a_pair_matches_its_row_in_either_orientation_ts1_6() {
    let rows = [(1u8, 2u8)];
    assert!(pair_has_open_session(&rows, &1, &2));
    assert!(pair_has_open_session(&rows, &2, &1));
    let named = [("ana", "bo")];
    assert!(pair_has_open_session(&named, &"ana", &"bo"));
    assert!(pair_has_open_session(&named, &"bo", &"ana"));
}

/// A row sharing only ONE member with the queried pair never matches. Kills
/// `&&` → `||` inside an orientation and a member-only test.
#[test]
fn a_row_sharing_one_member_never_matches_ts1_6() {
    let rows = [(1u8, 3u8), (3u8, 2u8)];
    assert!(!pair_has_open_session(&rows, &1, &2));
    assert!(!pair_has_open_session(&rows, &2, &1));
    let single = [(1u8, 2u8)];
    assert!(!pair_has_open_session(&single, &1, &3));
    assert!(!pair_has_open_session(&single, &3, &2));
    assert!(!pair_has_open_session(&single, &1, &1));
    let named = [("ana", "cy"), ("cy", "bo")];
    assert!(!pair_has_open_session(&named, &"ana", &"bo"));
}

/// No rows → no match; a matching row anywhere in the slice is found. Kills a
/// constant `true` and a search of the first (or last) row only.
#[test]
fn an_open_pair_is_found_anywhere_and_never_in_no_rows_ts1_6() {
    let none: [(u8, u8); 0] = [];
    assert!(!pair_has_open_session(&none, &1, &2));
    let rows = [(5u8, 6u8), (2u8, 1u8), (7u8, 8u8)];
    assert!(pair_has_open_session(&rows, &1, &2));
    assert!(pair_has_open_session(&rows, &2, &1));
    let tail = [(5u8, 6u8), (7u8, 8u8), (1u8, 2u8)];
    assert!(pair_has_open_session(&tail, &2, &1));
}

/// `open_session_count` counts only rows the player OPENED. Kills counting
/// partner rows, counting every row, and a constant count.
#[test]
fn open_session_count_counts_only_rows_the_player_opened_ts1_6() {
    let rows = [(1u8, 2u8), (3, 1), (1, 3), (2, 4), (1, 4), (4, 1), (2, 3)];
    assert_eq!(open_session_count(&rows, &1), 3);
    assert_eq!(open_session_count(&rows, &2), 2);
    assert_eq!(open_session_count(&rows, &3), 1);
    assert_eq!(open_session_count(&rows, &4), 1);
    assert_eq!(open_session_count(&rows, &9), 0);
    let none: [(u8, u8); 0] = [];
    assert_eq!(open_session_count(&none, &1), 0);
    let named = [("ana", "bo"), ("bo", "ana"), ("ana", "cy")];
    assert_eq!(open_session_count(&named, &"ana"), 2);
    assert_eq!(open_session_count(&named, &"cy"), 0);
}

/// `check_session_open` refuses a self-trade first, then an existing pair in
/// either orientation, and accepts a fresh pair. Kills a reordered check, a
/// single-orientation pair test, and a constant `Ok`.
#[test]
fn opening_refuses_self_trade_then_an_existing_pair_ts1_6() {
    let none: [(u8, u8); 0] = [];
    assert_eq!(
        check_session_open(&none, &1, &1),
        Err(TradeSessionError::SelfTrade)
    );
    let full = [(1u8, 1u8), (1, 2), (1, 3), (1, 4), (1, 5)];
    assert_eq!(
        check_session_open(&full, &1, &1),
        Err(TradeSessionError::SelfTrade),
        "self-trade precedes the pair and limit checks"
    );
    let rows = [(1u8, 2u8)];
    assert_eq!(
        check_session_open(&rows, &1, &2),
        Err(TradeSessionError::PairHasOpenSession)
    );
    assert_eq!(
        check_session_open(&rows, &2, &1),
        Err(TradeSessionError::PairHasOpenSession)
    );
    assert_eq!(check_session_open(&rows, &1, &3), Ok(()));
    let at_limit = [(1u8, 2u8), (1, 3), (1, 4), (1, 6)];
    assert_eq!(
        check_session_open(&at_limit, &1, &2),
        Err(TradeSessionError::PairHasOpenSession),
        "the pair check precedes the opener limit"
    );
}

/// An opener with 3 open sessions may open a 4th; with 4 (or more) they may
/// not. Sessions where they are only the partner, and the partner's own count,
/// never count. Kills `>=` → `>`, counting partner rows, and consulting the
/// partner's count.
#[test]
fn opening_is_refused_at_the_opener_session_limit_only_ts1_6() {
    let three = [(1u8, 2u8), (1, 3), (1, 4)];
    assert_eq!(check_session_open(&three, &1, &5), Ok(()));
    let four = [(1u8, 2u8), (1, 3), (1, 4), (1, 6)];
    assert_eq!(
        check_session_open(&four, &1, &5),
        Err(TradeSessionError::OpenSessionLimit)
    );
    let five = [(1u8, 2u8), (1, 3), (1, 4), (1, 6), (1, 7)];
    assert_eq!(
        check_session_open(&five, &1, &5),
        Err(TradeSessionError::OpenSessionLimit)
    );
    let partner_only = [(2u8, 1u8), (3, 1), (4, 1), (6, 1)];
    assert_eq!(check_session_open(&partner_only, &1, &5), Ok(()));
    let mixed = [(1u8, 2u8), (1, 3), (1, 4), (6, 1), (7, 1)];
    assert_eq!(check_session_open(&mixed, &1, &5), Ok(()));
    let busy_partner = [(5u8, 2u8), (5, 3), (5, 4), (5, 6)];
    assert_eq!(check_session_open(&busy_partner, &1, &5), Ok(()));
}

/// A session is stale from exactly `TRADE_SESSION_TTL_MS` after creation; one
/// millisecond earlier it is fresh; clock skew (`now_ms` < `created_at_ms`) is fresh;
/// the extremes saturate instead of panicking. Kills `>=` → `>`, swapped
/// subtraction operands, and an unchecked `-`.
#[test]
fn a_session_is_stale_from_exactly_the_ttl_ts1_6() {
    let created = 1_000;
    assert!(!is_session_stale(created, created));
    assert!(!is_session_stale(
        created,
        created + TRADE_SESSION_TTL_MS - 1
    ));
    assert!(is_session_stale(created, created + TRADE_SESSION_TTL_MS));
    assert!(is_session_stale(
        created,
        created + TRADE_SESSION_TTL_MS + 1
    ));
    assert!(
        !is_session_stale(created, created - 500),
        "clock skew is fresh"
    );
    assert!(!is_session_stale(0, TRADE_SESSION_TTL_MS - 1));
    assert!(is_session_stale(0, TRADE_SESSION_TTL_MS));
    assert!(!is_session_stale(i64::MAX, i64::MIN));
    assert!(is_session_stale(i64::MIN, i64::MAX));
}

/// The session constants hold their contract values: 4 sessions per opener
/// (E5), a 1 h TTL, 64 items per side. Kills a changed cap or TTL.
#[test]
fn session_constants_hold_their_contract_values_ts1_6() {
    assert_eq!(MAX_OPEN_TRADE_SESSIONS, 4);
    assert_eq!(TRADE_SESSION_TTL_MS, 3_600_000);
    assert_eq!(MAX_TRADE_ITEMS_PER_SIDE, 64);
}
