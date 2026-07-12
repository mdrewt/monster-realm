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
/// Integer-only: the multiplier is applied by callers on a `u64` intermediate
/// (already upcast from u16), so `variance_mod * 3` cannot overflow u64 in
/// practice — max game damage values are far below `u64::MAX / 3`.
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

// ---------------------------------------------------------------------------
// Tests: WeatherEffect::turns_remaining exact accessor
// ---------------------------------------------------------------------------
//
// AC-M7: these tests kill the following 2 cargo-mutants survivors:
//
//   // kills: game-core/src/combat/weather.rs:97:9 replace WeatherEffect::turns_remaining -> u8 with 0
//   // kills: game-core/src/combat/weather.rs:97:9 replace WeatherEffect::turns_remaining -> u8 with 1
//
// Strategy: test ALL four variants with a stored value of 5 (≠ 0 and ≠ 1).
// The constant-0 mutant returns 0 when we expect 5 → assertion fails.
// The constant-1 mutant returns 1 when we expect 5 → assertion fails.
// We also test values 0 and 1 explicitly to prove the boundaries work on
// the correct implementation (these won't be needed to kill the mutants,
// but they confirm the function works across the full u8 range).
//
// The proptest sweeps all u8 values × all 4 variants, which guarantees both
// constant mutants fail for the vast majority of the seed space.

#[cfg(test)]
mod weather_turns_remaining_tests {
    use super::WeatherEffect;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Rain variant
    // -----------------------------------------------------------------------

    /// Kills: "replace turns_remaining → 0" and "replace turns_remaining → 1".
    /// Value 5 (≠ 0 and ≠ 1) fails both constant mutants.
    /// Values 0 and 1 confirm boundary correctness on the real impl.
    #[test]
    fn rain_turns_remaining_is_stored_value() {
        // Non-constant values (kills both constant mutants).
        assert_eq!(
            WeatherEffect::Rain { turns_remaining: 5 }.turns_remaining(),
            5,
            "TEETH: Rain(5).turns_remaining() must return 5; \
             a constant-0 mutant returns 0, a constant-1 mutant returns 1 — both fail here"
        );
        assert_eq!(
            WeatherEffect::Rain { turns_remaining: 2 }.turns_remaining(),
            2,
            "TEETH: Rain(2).turns_remaining() must return 2; constant-0/1 mutants fail"
        );
        assert_eq!(
            WeatherEffect::Rain {
                turns_remaining: 255
            }
            .turns_remaining(),
            255,
            "TEETH: Rain(255).turns_remaining() must return 255"
        );
        // Boundary values (confirm the real impl handles 0 and 1 correctly).
        assert_eq!(
            WeatherEffect::Rain { turns_remaining: 0 }.turns_remaining(),
            0,
            "Rain(0).turns_remaining() must return 0 (correct impl, boundary check)"
        );
        assert_eq!(
            WeatherEffect::Rain { turns_remaining: 1 }.turns_remaining(),
            1,
            "Rain(1).turns_remaining() must return 1 (correct impl, boundary check)"
        );
    }

    // -----------------------------------------------------------------------
    // Sun variant
    // -----------------------------------------------------------------------

    /// Kills: both constant mutants for the Sun variant arm.
    #[test]
    fn sun_turns_remaining_is_stored_value() {
        assert_eq!(
            WeatherEffect::Sun { turns_remaining: 5 }.turns_remaining(),
            5,
            "TEETH: Sun(5).turns_remaining() must return 5; \
             constant-0 mutant returns 0, constant-1 mutant returns 1 — both fail here"
        );
        assert_eq!(
            WeatherEffect::Sun { turns_remaining: 2 }.turns_remaining(),
            2,
            "TEETH: Sun(2).turns_remaining() must return 2"
        );
        assert_eq!(
            WeatherEffect::Sun {
                turns_remaining: 255
            }
            .turns_remaining(),
            255,
            "TEETH: Sun(255).turns_remaining() must return 255"
        );
        assert_eq!(
            WeatherEffect::Sun { turns_remaining: 0 }.turns_remaining(),
            0,
            "Sun(0).turns_remaining() boundary check"
        );
        assert_eq!(
            WeatherEffect::Sun { turns_remaining: 1 }.turns_remaining(),
            1,
            "Sun(1).turns_remaining() boundary check"
        );
    }

    // -----------------------------------------------------------------------
    // Sandstorm variant
    // -----------------------------------------------------------------------

    /// Kills: both constant mutants for the Sandstorm variant arm.
    #[test]
    fn sandstorm_turns_remaining_is_stored_value() {
        assert_eq!(
            WeatherEffect::Sandstorm { turns_remaining: 5 }.turns_remaining(),
            5,
            "TEETH: Sandstorm(5).turns_remaining() must return 5; \
             constant-0 mutant returns 0, constant-1 mutant returns 1 — both fail here"
        );
        assert_eq!(
            WeatherEffect::Sandstorm { turns_remaining: 2 }.turns_remaining(),
            2,
            "TEETH: Sandstorm(2).turns_remaining() must return 2"
        );
        assert_eq!(
            WeatherEffect::Sandstorm {
                turns_remaining: 255
            }
            .turns_remaining(),
            255,
            "TEETH: Sandstorm(255).turns_remaining() must return 255"
        );
        assert_eq!(
            WeatherEffect::Sandstorm { turns_remaining: 0 }.turns_remaining(),
            0,
            "Sandstorm(0).turns_remaining() boundary check"
        );
        assert_eq!(
            WeatherEffect::Sandstorm { turns_remaining: 1 }.turns_remaining(),
            1,
            "Sandstorm(1).turns_remaining() boundary check"
        );
    }

    // -----------------------------------------------------------------------
    // Hail variant
    // -----------------------------------------------------------------------

    /// Kills: both constant mutants for the Hail variant arm.
    #[test]
    fn hail_turns_remaining_is_stored_value() {
        assert_eq!(
            WeatherEffect::Hail { turns_remaining: 5 }.turns_remaining(),
            5,
            "TEETH: Hail(5).turns_remaining() must return 5; \
             constant-0 mutant returns 0, constant-1 mutant returns 1 — both fail here"
        );
        assert_eq!(
            WeatherEffect::Hail { turns_remaining: 2 }.turns_remaining(),
            2,
            "TEETH: Hail(2).turns_remaining() must return 2"
        );
        assert_eq!(
            WeatherEffect::Hail {
                turns_remaining: 255
            }
            .turns_remaining(),
            255,
            "TEETH: Hail(255).turns_remaining() must return 255"
        );
        assert_eq!(
            WeatherEffect::Hail { turns_remaining: 0 }.turns_remaining(),
            0,
            "Hail(0).turns_remaining() boundary check"
        );
        assert_eq!(
            WeatherEffect::Hail { turns_remaining: 1 }.turns_remaining(),
            1,
            "Hail(1).turns_remaining() boundary check"
        );
    }

    // -----------------------------------------------------------------------
    // Property test: turns_remaining identity across all variants and u8 values
    //
    // Sweeps the full u8 range × 4 variants. Both constant mutants fail for
    // every seed except 0 (for the constant-0 mutant) or 1 (for the constant-1
    // mutant). Since the proptest framework explores hundreds of values, it will
    // find a counterexample within the first few trials.
    // -----------------------------------------------------------------------

    proptest! {
        /// Kills: "replace turns_remaining → 0" and "replace turns_remaining → 1".
        ///
        /// For any turns value ≠ 0, the constant-0 mutant returns 0 ≠ turns → fails.
        /// For any turns value ≠ 1, the constant-1 mutant returns 1 ≠ turns → fails.
        /// The proptest will quickly find a turns value that is neither 0 nor 1.
        #[test]
        fn turns_remaining_identity(turns in any::<u8>()) {
            prop_assert_eq!(
                WeatherEffect::Rain { turns_remaining: turns }.turns_remaining(),
                turns,
                "TEETH: Rain({}).turns_remaining() must return {}; \
                 constant-0 mutant fails for turns≠0, constant-1 mutant fails for turns≠1",
                turns, turns
            );
            prop_assert_eq!(
                WeatherEffect::Sun { turns_remaining: turns }.turns_remaining(),
                turns,
                "TEETH: Sun({}).turns_remaining() must return {}",
                turns, turns
            );
            prop_assert_eq!(
                WeatherEffect::Sandstorm { turns_remaining: turns }.turns_remaining(),
                turns,
                "TEETH: Sandstorm({}).turns_remaining() must return {}",
                turns, turns
            );
            prop_assert_eq!(
                WeatherEffect::Hail { turns_remaining: turns }.turns_remaining(),
                turns,
                "TEETH: Hail({}).turns_remaining() must return {}",
                turns, turns
            );
        }
    }
}
