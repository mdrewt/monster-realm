//! Rewards — design §7: one KO hook writes an in-battle ledger, paid once at battle end.
//!
//! The shell calls [`on_unit_defeated`] after the KO sweep with the attributed killer (never for a
//! recruit: a `Recruited` victim is refused, so a recruited wild earns nobody anything). The carried
//! amounts are called by value: `battle_xp_reward` (wild battles, split), `essence_battle_reward`
//! (to the killer) and `battle_currency_reward` (wild battles, to the player). Nothing is applied
//! mid-battle, so no stat block changes under a queued plan or a forecast. [`pay`] reads only the ledger and the final state — never the outcome — so win, loss,
//! Flee, auto-flee and disconnect pay by the same rule: a monster's share is paid only if it is
//! conscious at the end (fainted shares are forfeited, not redistributed; benched monsters are not
//! in the battle and earn nothing).
//!
//! Who earns (cases the design table leaves open):
//! - Practice (self vs self) pays nothing (design §6.1, "no rewards").
//! - A KO of a same-side unit pays nothing, and in a wild battle only a player-owned killer of a
//!   wild earns; a wild's kills earn nothing.
//! - Pvp: essence to the killer, both sides symmetric; no XP, no currency.
//! - A level outside `Level`'s range skips the XP only (the carried write-back rule).

use serde::{Deserialize, Serialize};

use crate::combat::xp::battle_xp_reward;
use crate::currency::{battle_currency_reward, essence_battle_reward};
use crate::monster::types::{Affinity, Level};

use super::queue::is_player_owned;
use super::resolve::{TacticalState, UnitState};
use super::tuning::BattleKind;

/// One ledger line: what `unit` earned from the KO of `victim`. `affinity` is the victim's (the
/// essence pool the credit fills). Never all-zero.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Credit {
    pub unit: u32,
    pub victim: u32,
    pub xp: u32,
    pub essence: u32,
    pub affinity: Affinity,
}

/// The in-battle ledger: credits in KO order, and the player's currency (wild battles).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Ledger {
    pub credits: Vec<Credit>,
    pub currency: u64,
}

/// Why a KO cannot be credited (checked in declaration order); the ledger is untouched.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum RewardError {
    /// The killer or the victim is not in the battle.
    UnknownUnit { id: u32 },
    /// The victim is not `Fainted` (still standing, or recruited — a recruit never pays).
    NotDefeated { id: u32 },
    /// The victim's KO is already in the ledger.
    AlreadyCredited { id: u32 },
}

/// One monster's payout: summed XP and essence per pool (ascending affinity, no zero pools).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Award {
    pub unit: u32,
    pub xp: u32,
    pub essence: Vec<(Affinity, u32)>,
}

/// What the battle-end funnel pays: per-monster awards (ascending unit) and the player's currency.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Payout {
    pub awards: Vec<Award>,
    pub currency: u64,
}

/// The KO hook: credit `victim`'s defeat by `killer` to `ledger`. `victim_bst` is the victim
/// species' base-stat total (content). "Conscious" is read from `state` as passed.
///
/// Wild (a player-owned killer, a wild victim): `total = battle_xp_reward(killer level, bst,
/// victim level)`; the others are the killer's conscious side-mates (ascending id); with `n` of
/// them each gets `total / 2 / n` and the killer the rest, else the killer takes all. The killer
/// also gets `essence_battle_reward(bst)`; the player gets `battle_currency_reward(bst)`.
/// Pvp: the killer gets the essence only. Credits are written killer first, zero credits skipped.
///
/// # Errors
/// See [`RewardError`].
pub fn on_unit_defeated(
    ledger: &mut Ledger,
    state: &TacticalState,
    killer: u32,
    victim: u32,
    victim_bst: u16,
) -> Result<(), RewardError> {
    let k = state
        .unit(killer)
        .ok_or(RewardError::UnknownUnit { id: killer })?;
    let v = state
        .unit(victim)
        .ok_or(RewardError::UnknownUnit { id: victim })?;
    if v.state != UnitState::Fainted {
        return Err(RewardError::NotDefeated { id: victim });
    }
    if ledger.credits.iter().any(|c| c.victim == victim) {
        return Err(RewardError::AlreadyCredited { id: victim });
    }
    let essence = essence_battle_reward(victim_bst);
    let credit = |unit: u32, xp: u32, essence: u32| Credit {
        unit,
        victim,
        xp,
        essence,
        affinity: v.kit.affinity,
    };
    let earns = k.side != v.side
        && match state.kind {
            BattleKind::Practice => false,
            BattleKind::Pvp => true,
            // Two sides: a killer opposite a wild is the player's.
            BattleKind::Wild => !is_player_owned(state.kind, v.side),
        };
    if !earns {
        return Ok(());
    }
    if state.kind != BattleKind::Wild {
        ledger.credits.push(credit(killer, 0, essence));
        return Ok(());
    }
    let total = match (Level::new(k.kit.level), Level::new(v.kit.level)) {
        (Ok(kl), Ok(vl)) => battle_xp_reward(kl, victim_bst, vl).value(),
        _ => 0,
    };
    let mut others: Vec<u32> = state
        .units
        .iter()
        .filter(|u| u.side == k.side && u.id != killer && u.is_conscious())
        .map(|u| u.id)
        .collect();
    others.sort_unstable();
    let (each, killer_xp) = match u32::try_from(others.len()) {
        Ok(n) if n > 0 => {
            let each = total / 2 / n;
            (each, total - each * n)
        }
        _ => (0, total),
    };
    ledger.credits.push(credit(killer, killer_xp, essence));
    if each > 0 {
        ledger
            .credits
            .extend(others.into_iter().map(|id| credit(id, each, 0)));
    }
    ledger.currency = ledger
        .currency
        .saturating_add(battle_currency_reward(victim_bst));
    Ok(())
}

/// Pay `ledger` against the final `state`: every credit whose unit is conscious there, summed per
/// unit (saturating) and per essence pool; units earning nothing are omitted. The currency is paid
/// whole. The outcome is not an input: every terminal path pays alike.
#[must_use]
pub fn pay(ledger: &Ledger, state: &TacticalState) -> Payout {
    let mut awards: Vec<Award> = Vec::new();
    for c in &ledger.credits {
        if !state.unit(c.unit).is_some_and(|u| u.is_conscious()) {
            continue;
        }
        let idx = match awards.binary_search_by_key(&c.unit, |a| a.unit) {
            Ok(i) => i,
            Err(i) => {
                awards.insert(
                    i,
                    Award {
                        unit: c.unit,
                        xp: 0,
                        essence: Vec::new(),
                    },
                );
                i
            }
        };
        let award = &mut awards[idx];
        award.xp = award.xp.saturating_add(c.xp);
        if c.essence > 0 {
            match award.essence.binary_search_by_key(&c.affinity, |e| e.0) {
                Ok(i) => award.essence[i].1 = award.essence[i].1.saturating_add(c.essence),
                Err(i) => award.essence.insert(i, (c.affinity, c.essence)),
            }
        }
    }
    awards.retain(|a| a.xp > 0 || !a.essence.is_empty());
    Payout {
        awards,
        currency: ledger.currency,
    }
}
