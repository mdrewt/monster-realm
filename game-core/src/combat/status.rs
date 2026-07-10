//! Status-effect pure rules — game-core layer (ADR-0003 SSOT).
//!
//! No I/O, no clock, no RNG. All variance is caller-supplied via [`StatusVariance`].
//! The faint-cascade in [`apply_post_turn_effects`] mirrors the logic in
//! `resolve_one_attack` so DoT KOs produce the same Faint/Switch/BattleEnd sequence.

use super::types::{BattleEvent, BattleOutcome, BattleState, SideId};
// StatusEffect is defined in types.rs (to avoid circular import with BattleMonster.status).
// Re-exported here so callers that import `crate::combat::status::StatusEffect` still resolve.
pub use super::types::StatusEffect;

/// Tracks the per-slot status for both sides of a battle.
///
/// Kept separate from [`BattleState`] so m14a ships as a pure game-core module
/// with no schema changes (SpacetimeType persistence wired in m14b).
pub struct BattleStatusStore {
    pub side_a: Vec<Option<StatusEffect>>,
    pub side_b: Vec<Option<StatusEffect>>,
}

impl BattleStatusStore {
    pub fn new(a_size: usize, b_size: usize) -> Self {
        BattleStatusStore {
            side_a: vec![None; a_size],
            side_b: vec![None; b_size],
        }
    }
}

/// Injected variance for status checks — caller-supplied so the resolver stays pure.
pub struct StatusVariance {
    /// 0–99: Paralysis blocks when this value is < 25 for side A.
    pub action_skip_roll_a: u8,
    /// 0–99: Paralysis blocks when this value is < 25 for side B.
    pub action_skip_roll_b: u8,
    /// 0–99: Freeze thaws when this value is >= 80 for side A.
    pub freeze_thaw_roll_a: u8,
    /// 0–99: Freeze thaws when this value is >= 80 for side B.
    pub freeze_thaw_roll_b: u8,
    /// Reserved: future probabilistic wake chance. Currently Sleep cures by
    /// turn-count in `tick_status`; field derived server-side so future wiring
    /// is deterministic (ADR-0093, parallel to `TurnVariance::from_ctx_random`).
    pub sleep_wake_roll_a: u8,
    /// See `sleep_wake_roll_a`.
    pub sleep_wake_roll_b: u8,
}

impl StatusVariance {
    /// Derive a deterministic `StatusVariance` from a single u32 seed.
    ///
    /// Uses the same splitmix64-style mixing as `TurnVariance::from_ctx_random`
    /// so a single `ctx.random()` call deterministically seeds all six rolls.
    /// All rolls map to 0..=99 via `% 100`.
    #[must_use]
    pub fn from_ctx_random(seed: u32) -> StatusVariance {
        let mut s = seed as u64;
        let mut next = || -> u32 {
            s = s.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut z = s;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            (z ^ (z >> 31)) as u32
        };

        StatusVariance {
            action_skip_roll_a: (next() % 100) as u8,
            action_skip_roll_b: (next() % 100) as u8,
            freeze_thaw_roll_a: (next() % 100) as u8,
            freeze_thaw_roll_b: (next() % 100) as u8,
            sleep_wake_roll_a: (next() % 100) as u8,
            sleep_wake_roll_b: (next() % 100) as u8,
        }
    }
}

// ---------------------------------------------------------------------------
// Pure DoT formulas (same floor convention as damage.rs: max(1, …))
// ---------------------------------------------------------------------------

fn poison_dot_amount(max_hp: u16) -> u16 {
    (max_hp / 8).max(1)
}

fn burn_dot_amount(max_hp: u16) -> u16 {
    (max_hp / 16).max(1)
}

// ---------------------------------------------------------------------------
// Pre-turn action-block check
// ---------------------------------------------------------------------------

/// Compute whether each side can act this turn and emit any [`BattleEvent::ActionBlocked`]
/// events for blocked sides.
///
/// Rules:
/// - `Poison` / `Burn`: no action block (DoT only).
/// - `Paralysis`: blocked when `action_skip_roll < 25`.
/// - `Sleep`: always blocked (no roll; cured via [`tick_status`]).
/// - `Freeze`: always blocked (thaw checked in [`tick_status`]).
///
/// Returns `(a_can_act, b_can_act, events)`.
pub fn apply_pre_turn_effects(
    status: &BattleStatusStore,
    state: &BattleState,
    variance: &StatusVariance,
) -> (bool, bool, Vec<BattleEvent>) {
    let mut events = Vec::new();

    let a_effect = status
        .side_a
        .get(state.side_a.active as usize)
        .and_then(|s| s.as_ref());
    let b_effect = status
        .side_b
        .get(state.side_b.active as usize)
        .and_then(|s| s.as_ref());

    let (a_can_act, a_ev) =
        check_action_block(a_effect, SideId::SideA, variance.action_skip_roll_a);
    let (b_can_act, b_ev) =
        check_action_block(b_effect, SideId::SideB, variance.action_skip_roll_b);

    if let Some(ev) = a_ev {
        events.push(ev);
    }
    if let Some(ev) = b_ev {
        events.push(ev);
    }

    (a_can_act, b_can_act, events)
}

fn check_action_block(
    effect: Option<&StatusEffect>,
    side: SideId,
    skip_roll: u8,
) -> (bool, Option<BattleEvent>) {
    match effect {
        None | Some(StatusEffect::Poison) | Some(StatusEffect::Burn) => (true, None),
        Some(StatusEffect::Paralysis) => {
            if skip_roll < 25 {
                (false, Some(BattleEvent::ActionBlocked { side }))
            } else {
                (true, None)
            }
        }
        Some(StatusEffect::Sleep { .. }) | Some(StatusEffect::Freeze) => {
            (false, Some(BattleEvent::ActionBlocked { side }))
        }
    }
}

// ---------------------------------------------------------------------------
// Post-turn DoT + faint cascade
// ---------------------------------------------------------------------------

/// Apply per-turn DoT (Poison = max_hp/8, Burn = max_hp/16, min 1) and resolve
/// any resulting faint/switch/battle-end, emitting the ordered event sequence.
///
/// Stops processing the second side if the battle already ended from the first
/// side's DoT.
pub fn apply_post_turn_effects(
    state: &mut BattleState,
    status: &BattleStatusStore,
) -> Vec<BattleEvent> {
    let mut events = Vec::new();

    for side_id in [SideId::SideA, SideId::SideB] {
        if state.outcome != BattleOutcome::Ongoing {
            break;
        }

        let active_idx = match side_id {
            SideId::SideA => state.side_a.active as usize,
            SideId::SideB => state.side_b.active as usize,
        };
        let side_status = match side_id {
            SideId::SideA => &status.side_a,
            SideId::SideB => &status.side_b,
        };

        let effect = side_status.get(active_idx).and_then(|s| s.as_ref());

        let max_hp = match side_id {
            SideId::SideA => state.side_a.active_monster().max_hp,
            SideId::SideB => state.side_b.active_monster().max_hp,
        };

        let dot_amount = match effect {
            Some(StatusEffect::Poison) => Some(poison_dot_amount(max_hp)),
            Some(StatusEffect::Burn) => Some(burn_dot_amount(max_hp)),
            None
            | Some(StatusEffect::Paralysis)
            | Some(StatusEffect::Sleep { .. })
            | Some(StatusEffect::Freeze) => None,
        };

        if let Some(amount) = dot_amount {
            {
                let target = match side_id {
                    SideId::SideA => state.side_a.active_monster_mut(),
                    SideId::SideB => state.side_b.active_monster_mut(),
                };
                target.current_hp = target.current_hp.saturating_sub(amount);
            }
            events.push(BattleEvent::StatusDamage {
                side: side_id,
                amount,
            });

            let fainted = match side_id {
                SideId::SideA => state.side_a.active_monster().is_fainted(),
                SideId::SideB => state.side_b.active_monster().is_fainted(),
            };

            if fainted {
                events.push(BattleEvent::Faint { side: side_id });

                let next = match side_id {
                    SideId::SideA => state.side_a.next_conscious_index(),
                    SideId::SideB => state.side_b.next_conscious_index(),
                };

                if let Some(idx) = next {
                    let set = match side_id {
                        SideId::SideA => state.side_a.set_active(idx),
                        SideId::SideB => state.side_b.set_active(idx),
                    };
                    debug_assert!(
                        set.is_ok(),
                        "auto-switch from next_conscious_index must be valid"
                    );
                    let _ = set;
                    events.push(BattleEvent::Switch {
                        side: side_id,
                        new_active: idx,
                    });
                } else {
                    let winner = match side_id {
                        SideId::SideA => SideId::SideB,
                        SideId::SideB => SideId::SideA,
                    };
                    state.outcome = match winner {
                        SideId::SideA => BattleOutcome::SideAWins,
                        SideId::SideB => BattleOutcome::SideBWins,
                    };
                    events.push(BattleEvent::BattleEnd { winner });
                }
            }
        }
    }

    events
}

// ---------------------------------------------------------------------------
// Status tick (end-of-turn)
// ---------------------------------------------------------------------------

/// Advance time-based statuses by one turn and emit [`BattleEvent::StatusCured`]
/// for any that expire.
///
/// - `Sleep`: decrements `turns_remaining`; cures when it reaches 0.
/// - `Freeze`: thaws when `freeze_thaw_roll >= 80`.
/// - Other statuses: no tick action.
pub fn tick_status(status: &mut BattleStatusStore, variance: &StatusVariance) -> Vec<BattleEvent> {
    let mut events = Vec::new();

    for (slot_idx, slot) in status.side_a.iter_mut().enumerate() {
        if let Some(ev) = tick_one_slot(
            slot,
            SideId::SideA,
            slot_idx as u32,
            variance.freeze_thaw_roll_a,
        ) {
            events.push(ev);
        }
    }
    for (slot_idx, slot) in status.side_b.iter_mut().enumerate() {
        if let Some(ev) = tick_one_slot(
            slot,
            SideId::SideB,
            slot_idx as u32,
            variance.freeze_thaw_roll_b,
        ) {
            events.push(ev);
        }
    }

    events
}

fn tick_one_slot(
    slot: &mut Option<StatusEffect>,
    side: SideId,
    slot_idx: u32,
    freeze_thaw_roll: u8,
) -> Option<BattleEvent> {
    match slot {
        Some(StatusEffect::Sleep { turns_remaining }) => {
            if *turns_remaining <= 1 {
                *slot = None;
                Some(BattleEvent::StatusCured {
                    side,
                    slot: slot_idx,
                })
            } else {
                *turns_remaining -= 1;
                None
            }
        }
        Some(StatusEffect::Freeze) => {
            if freeze_thaw_roll >= 80 {
                *slot = None;
                Some(BattleEvent::StatusCured {
                    side,
                    slot: slot_idx,
                })
            } else {
                None
            }
        }
        None
        | Some(StatusEffect::Poison)
        | Some(StatusEffect::Burn)
        | Some(StatusEffect::Paralysis) => None,
    }
}
