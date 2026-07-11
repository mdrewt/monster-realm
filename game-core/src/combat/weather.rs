//! Weather / field-state pure rules — game-core layer (M14d, ADR-0095).
//!
//! No I/O, no clock, no RNG. Weather damage is deterministic (1/16 max HP),
//! weather effectiveness modifiers are integer-only (3/2 or 1/2 scale).
//!
//! # Affinity-to-immunity mapping (ADR-0095)
//!
//! The game uses `Fire | Water | Plant | Electric | Earth | Wind | Light | Dark`.
//! Classic Sandstorm/Hail immunities (Rock/Ground/Steel, Ice) are approximated:
//! - **Sandstorm**: immune if affinity is `Earth` (closest to Rock/Ground)
//! - **Hail**: immune if affinity is `Water` (ice-resistant by lore)
//!
//! These are intentional design decisions recorded in ADR-0095; they are the
//! game's rule, not a mis-mapping of Pokémon mechanics.

use serde::{Deserialize, Serialize};

use super::types::{BattleEvent, BattleOutcome, BattleState, SideId};
use crate::monster::types::Affinity;

// ===========================================================================
// WeatherKind — payload-free discriminant for content
// ===========================================================================

/// Payload-free weather discriminant, used in `SkillDef.sets_weather` content
/// and as the result of `WeatherEffect::kind()`.
///
/// Exhaustive — a new variant forces a compile-time update at every match site
/// (OCP gate, ADR-0010). Does NOT need `SpacetimeType` (content-only; the
/// runtime type is `WeatherEffect`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WeatherKind {
    Rain,
    Sun,
    Sandstorm,
    Hail,
}

// ===========================================================================
// WeatherEffect — runtime battle-field state
// ===========================================================================

/// The active field weather — stored in `BattleState.weather`.
///
/// Each variant carries `turns_remaining: u8`. The weather expires when
/// `turns_remaining` reaches 0 after [`tick_weather`]. Default duration when
/// set by a skill is [`WEATHER_DEFAULT_TURNS`].
///
/// `SpacetimeType` is cfg-gated: `WeatherEffect` is nested inside `BattleState`
/// which is stored in the `battle` table (M14d, ADR-0095).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum WeatherEffect {
    Rain { turns_remaining: u8 },
    Sun { turns_remaining: u8 },
    Sandstorm { turns_remaining: u8 },
    Hail { turns_remaining: u8 },
}

/// Default number of turns weather lasts when set by a skill.
pub const WEATHER_DEFAULT_TURNS: u8 = 5;

impl WeatherEffect {
    /// Construct a `WeatherEffect` from a [`WeatherKind`] and a turn count.
    #[must_use]
    pub fn from_kind(kind: WeatherKind, turns: u8) -> Self {
        match kind {
            WeatherKind::Rain => WeatherEffect::Rain {
                turns_remaining: turns,
            },
            WeatherKind::Sun => WeatherEffect::Sun {
                turns_remaining: turns,
            },
            WeatherKind::Sandstorm => WeatherEffect::Sandstorm {
                turns_remaining: turns,
            },
            WeatherKind::Hail => WeatherEffect::Hail {
                turns_remaining: turns,
            },
        }
    }

    /// The payload-free kind of this weather — useful for display and content cross-checks.
    #[must_use]
    pub fn kind(&self) -> WeatherKind {
        match self {
            WeatherEffect::Rain { .. } => WeatherKind::Rain,
            WeatherEffect::Sun { .. } => WeatherKind::Sun,
            WeatherEffect::Sandstorm { .. } => WeatherKind::Sandstorm,
            WeatherEffect::Hail { .. } => WeatherKind::Hail,
        }
    }

    /// Remaining turns for this weather condition.
    #[must_use]
    pub fn turns_remaining(&self) -> u8 {
        match self {
            WeatherEffect::Rain { turns_remaining }
            | WeatherEffect::Sun { turns_remaining }
            | WeatherEffect::Sandstorm { turns_remaining }
            | WeatherEffect::Hail { turns_remaining } => *turns_remaining,
        }
    }
}

// ===========================================================================
// Weather damage modifier for attack resolution
// ===========================================================================

/// Returns an integer `(numerator, denominator)` scale factor for an attack
/// under the current weather.
///
/// Applied to damage AFTER the type-effectiveness and variance steps:
/// `final_dmg = base_dmg * numer / denom`.
///
/// Rules (ADR-0095):
/// - Rain: Water attacks × 3/2, Fire attacks × 1/2, others × 1
/// - Sun:  Fire attacks × 3/2, Water attacks × 1/2, others × 1
/// - Sandstorm, Hail, None: no attack modifier (× 1)
///
/// Integer-only: using `u16` to avoid u16-overflow in `(dmg * 3 / 2)` since
/// dmg ≤ u16::MAX and `(u16::MAX * 3) > u64::MAX` is NOT an issue because
/// callers upcast to `u64` before calling this.
#[must_use]
pub fn weather_attack_modifier(
    weather: Option<&WeatherEffect>,
    skill_affinity: Affinity,
) -> (u64, u64) {
    match weather {
        Some(WeatherEffect::Rain { .. }) => match skill_affinity {
            Affinity::Water => (3, 2),
            Affinity::Fire => (1, 2),
            _ => (1, 1),
        },
        Some(WeatherEffect::Sun { .. }) => match skill_affinity {
            Affinity::Fire => (3, 2),
            Affinity::Water => (1, 2),
            _ => (1, 1),
        },
        Some(WeatherEffect::Sandstorm { .. }) | Some(WeatherEffect::Hail { .. }) | None => (1, 1),
    }
}

// ===========================================================================
// Weather chip damage (end-of-turn)
// ===========================================================================

/// Returns `true` if the given affinity is immune to Sandstorm chip damage.
///
/// Earth types (approximating Rock/Ground/Steel) are immune (ADR-0095).
#[must_use]
pub fn sandstorm_immune(affinity: Affinity) -> bool {
    matches!(affinity, Affinity::Earth)
}

/// Returns `true` if the given affinity is immune to Hail chip damage.
///
/// Water types (approximating Ice resistance) are immune (ADR-0095).
#[must_use]
pub fn hail_immune(affinity: Affinity) -> bool {
    matches!(affinity, Affinity::Water)
}

fn weather_chip_amount(max_hp: u16) -> u16 {
    (max_hp / 16).max(1)
}

/// Apply per-turn weather chip damage (Sandstorm/Hail end-of-turn DoT) for
/// both active monsters. Called by `resolve_full_turn` after the post-turn
/// status DoT phase.
///
/// Only `Sandstorm` and `Hail` deal chip damage. `Rain` and `Sun` have no
/// end-of-turn damage (their effect is on attack modifiers via
/// `weather_attack_modifier`).
///
/// Mirrors the faint-cascade logic from `apply_post_turn_effects` in status.rs:
/// if chip damage KOs the active monster, it emits `Faint`, auto-switches if
/// possible, or ends the battle.
pub fn apply_weather_damage(state: &mut BattleState, events: &mut Vec<BattleEvent>) {
    let weather = match &state.weather {
        Some(w) => w.kind(),
        None => return,
    };

    for side_id in [SideId::SideA, SideId::SideB] {
        if state.outcome != BattleOutcome::Ongoing {
            break;
        }

        let active_affinity = match side_id {
            SideId::SideA => state.side_a.active_monster().affinity,
            SideId::SideB => state.side_b.active_monster().affinity,
        };

        let immune = match weather {
            WeatherKind::Sandstorm => sandstorm_immune(active_affinity),
            WeatherKind::Hail => hail_immune(active_affinity),
            WeatherKind::Rain | WeatherKind::Sun => true, // no chip damage
        };

        if immune {
            continue;
        }

        let max_hp = match side_id {
            SideId::SideA => state.side_a.active_monster().max_hp,
            SideId::SideB => state.side_b.active_monster().max_hp,
        };
        let amount = weather_chip_amount(max_hp);

        {
            let target = match side_id {
                SideId::SideA => state.side_a.active_monster_mut(),
                SideId::SideB => state.side_b.active_monster_mut(),
            };
            target.current_hp = target.current_hp.saturating_sub(amount);
        }
        events.push(BattleEvent::WeatherDamage {
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
                debug_assert!(set.is_ok(), "auto-switch from weather faint must be valid");
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
                use super::types::BattleOutcome;
                state.outcome = match winner {
                    SideId::SideA => BattleOutcome::SideAWins,
                    SideId::SideB => BattleOutcome::SideBWins,
                };
                events.push(BattleEvent::BattleEnd { winner });
            }
        }
    }
}

// ===========================================================================
// Weather tick (end-of-turn)
// ===========================================================================

/// Advance the weather by one turn, emitting [`BattleEvent::WeatherExpired`]
/// if the weather expires this turn.
///
/// Called at the end of `resolve_full_turn`, after status tick. No-op when
/// `state.weather` is `None`.
pub fn tick_weather(state: &mut BattleState, events: &mut Vec<BattleEvent>) {
    let remaining = match &mut state.weather {
        None => return,
        Some(w) => match w {
            WeatherEffect::Rain { turns_remaining }
            | WeatherEffect::Sun { turns_remaining }
            | WeatherEffect::Sandstorm { turns_remaining }
            | WeatherEffect::Hail { turns_remaining } => turns_remaining,
        },
    };

    if *remaining <= 1 {
        state.weather = None;
        events.push(BattleEvent::WeatherExpired);
    } else {
        *remaining -= 1;
    }
}
