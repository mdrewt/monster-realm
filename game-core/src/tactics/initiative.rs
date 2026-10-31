//! Initiative — design §2.2 "Round start": the total order every round is sorted by, and the
//! tie-priority coin.
//!
//! The comparator is `(eff_speed desc, base_speed desc, tie_rank asc, slot asc)` where
//! `tie_rank = 0` for the side holding tie priority this round. Priority alternates each round;
//! round 1 goes to the player side (A) in a wild battle and to `splitmix64(seed ^ TIE_SALT) & 1`
//! under the PvP ruleset. The list is frozen for the round: `resolve`/`outcome` only ever REMOVE
//! ids (KO, recruit); speed or status changes apply at the next rebuild.
//!
//! `eff_speed` is the carried `StatBlock.speed` after status modifiers; carried M14 has no
//! speed-modifying status, so `TacticalState::contenders` passes `stats.speed` — a future
//! modifier lands there, once. No HashMap, no floats: the sort key is a tuple of integers and the
//! order is total on `(side, slot)`-unique contenders (ids break any remaining tie, ascending).

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};

use super::geometry::Side;
use super::resolve::splitmix64;
use super::tuning::BattleKind;

/// The salt XOR'd into the battle seed for the round-1 PvP tie coin (design §2.2).
pub const TIE_SALT: u64 = 0x5EED;

/// What the comparator reads from a unit (built by `TacticalState::contenders`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Contender {
    pub id: u32,
    pub side: Side,
    pub slot: u8,
    pub eff_speed: u16,
    pub base_speed: u16,
}

/// The side holding tie priority in round 1: the player side (A) in a wild battle; under the
/// PvP ruleset `splitmix64(seed ^ TIE_SALT) & 1` — 0 → A, 1 → B.
#[must_use]
pub fn round1_priority(kind: BattleKind, seed: u64) -> Side {
    if !kind.uses_pvp_rules() {
        return Side::A;
    }
    if splitmix64(seed ^ TIE_SALT) & 1 == 0 {
        Side::A
    } else {
        Side::B
    }
}

fn other(side: Side) -> Side {
    match side {
        Side::A => Side::B,
        Side::B => Side::A,
    }
}

/// Priority alternates each round: round 1 → `round1`, round 2 → the other side, and so on.
/// Round 0 is treated as round 1.
#[must_use]
pub fn priority_for_round(round1: Side, round: u16) -> Side {
    if (round.max(1) - 1).is_multiple_of(2) {
        round1
    } else {
        other(round1)
    }
}

/// The design comparator: `eff_speed` desc, `base_speed` desc, tie_rank asc (0 = `priority`
/// side), `slot` asc, then `id` asc.
#[must_use]
pub fn compare(a: &Contender, b: &Contender, priority: Side) -> Ordering {
    let tie_rank = |c: &Contender| u8::from(c.side != priority);
    b.eff_speed
        .cmp(&a.eff_speed)
        .then(b.base_speed.cmp(&a.base_speed))
        .then(tie_rank(a).cmp(&tie_rank(b)))
        .then(a.slot.cmp(&b.slot))
        .then(a.id.cmp(&b.id))
}

/// The round's initiative list: every contender's id sorted by [`compare`].
#[must_use]
pub fn order(contenders: &[Contender], priority: Side) -> Vec<u32> {
    let mut sorted = contenders.to_vec();
    sorted.sort_by(|a, b| compare(a, b, priority));
    sorted.iter().map(|c| c.id).collect()
}
