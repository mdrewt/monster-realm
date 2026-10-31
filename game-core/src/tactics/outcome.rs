//! Outcome — design §6.4 adjudication, §2.2 battle-end check and the KO sweep (the one site for
//! every KO cause), plus the standing r2 double-KO ruling for wild battles.
//!
//! `check_battle_end` runs after every resolved entry (`resolve_attack`) and in upkeep step 4.
//! When both sides empty in the same step, the PvP ruleset adjudicates by the exact tuple (higher
//! Σ cur_hp×100/max_hp at step start, more conscious units at step start, more cumulative attack
//! damage dealt, `splitmix64(seed ^ round) & 1`); a wild battle follows ADR-0156 R5 as carried —
//! fixed `[A, B]` evaluation, the first side found empty loses — so the player side (A) loses a
//! wild mutual wipe. `BattleOutcome` gains NO variant: outcomes stay `SideAWins | SideBWins | Fled`.

use serde::{Deserialize, Serialize};

use crate::combat::types::BattleOutcome;

use super::geometry::Side;
use super::resolve::{TacticalEvent, TacticalState};

/// The adjudication inputs frozen at the START of a resolution or upkeep step.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StepSnapshot {
    /// Per side (A = 0, B = 1): Σ over deployed (state Active) units of floor(cur_hp × 100 / max_hp).
    pub hp_pct: [u32; 2],
    /// Per side: conscious units.
    pub conscious: [u8; 2],
}

impl StepSnapshot {
    /// Capture the tuple inputs from `state` as it stands now.
    #[must_use]
    pub fn capture(state: &TacticalState) -> Self {
        let _ = state;
        todo!("bt-2 outcome: StepSnapshot::capture")
    }
}

/// Which element of the adjudication tuple decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Adjudication {
    HpPercent,
    Conscious,
    DamageDealt,
    Coin,
}

/// How a battle ended (carried in `TacticalEvent::BattleEnd`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum BattleEndHow {
    /// Exactly one side is empty.
    SideEmpty,
    /// Both sides emptied in one step under the PvP ruleset.
    Adjudicated(Adjudication),
    /// Both sides emptied in one step in a wild battle: the r2 fixed-order ruling.
    FixedOrder,
    /// The wild round cap auto-fled the battle.
    RoundCap,
}

/// Design §6.4: the exact tuple. Never returns anything but a side.
#[must_use]
pub fn adjudicate(state: &TacticalState, snap: &StepSnapshot) -> (Side, Adjudication) {
    let _ = (state, snap);
    todo!("bt-2 outcome: adjudicate")
}

/// The KO sweep, once for every cause: each unit with `state == Active` and `cur_hp == 0` (in
/// `units` order) becomes `Fainted`, leaves the initiative (and the queued ids), and emits
/// `Ko` then `QueueVoided` iff it held a READY plan.
pub fn sweep_kos(state: &mut TacticalState) -> Vec<TacticalEvent> {
    let _ = state;
    todo!("bt-2 outcome: sweep_kos")
}

/// The battle-end check. `None` while both sides have a conscious unit; one side empty → the
/// other wins (`SideEmpty`); both empty → PvP ruleset: `adjudicate` (`Adjudicated`), wild: the
/// r2 ruling (`SideBWins`, `FixedOrder`). Pure.
#[must_use]
pub fn check_battle_end(
    state: &TacticalState,
    snap: &StepSnapshot,
) -> Option<(BattleOutcome, BattleEndHow)> {
    let _ = (state, snap);
    todo!("bt-2 outcome: check_battle_end")
}

/// Record a decided outcome (a decided battle is never overwritten) and return the event.
pub fn end_battle(
    state: &mut TacticalState,
    outcome: BattleOutcome,
    how: BattleEndHow,
) -> TacticalEvent {
    let _ = (state, outcome, how);
    todo!("bt-2 outcome: end_battle")
}

/// `Side::A → SideAWins`, `Side::B → SideBWins`.
#[must_use]
pub fn winner_outcome(side: Side) -> BattleOutcome {
    let _ = side;
    todo!("bt-2 outcome: winner_outcome")
}
