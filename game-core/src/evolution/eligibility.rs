//! Evolution AND fusion eligibility rules — the pure predicate layer for the
//! evolution subsystem.
//!
//! `resolve_evolution` is the canonical evolution primitive: it takes the
//! evolution branch list plus the three eligibility dimensions (level, bond,
//! applied item) and returns the first matching target species id (FIRST-wins,
//! declaration order).
//!
//! `evolves_to` is the passive convenience wrapper: it reads level+bond from a
//! `MonsterInstance` and passes `None` for the item slot (passive check, no item
//! applied). It delegates to `resolve_evolution` — ONE implementation path (SSOT).
//!
//! `fusion_eligible` is the fusion gate (ADR-0147): self-fusion and
//! under-invested parents (below `MIN_FUSION_LEVEL`/`MIN_FUSION_BOND`, raw
//! pre-tax values) are rejected. Both the real `fuse` reducer and the
//! `fuse_seam` test double delegate here — ONE guard SSOT, never hand-copied.
//!
//! No wildcard `_` arms on `EvolutionTrigger`: a new variant MUST compiler-flag
//! every match here (exhaustiveness guard, ADR-0061 §non_exhaustive note).

use crate::content::{EvolutionCondition, EvolutionTrigger};
use crate::monster::types::{Bond, Level, MonsterInstance};

/// Minimum level BOTH parents need before they may be fused (ADR-0147).
pub const MIN_FUSION_LEVEL: u8 = 10;

/// Minimum raw (pre-tax) bond BOTH parents need before they may be fused
/// (ADR-0147). Paired with the `FUSION_EFFICIENCY` output tax in `transform.rs`
/// (`120 × 75% = 90 < 120`): a minimum-bond pair's offspring is NOT immediately
/// re-fusable — bond must be regrown through cooldown-gated care first.
pub const MIN_FUSION_BOND: u8 = 120;

/// Why a fusion pair is ineligible (ADR-0147). Unit variants, no payload — the
/// server boundary owns the player-facing message mapping (CareError precedent).
/// Deliberately NOT `#[non_exhaustive]`: a new variant must compiler-flag every
/// consumer match (ADR-0061 exhaustiveness discipline).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FusionError {
    /// The two ids name the same monster.
    SelfFusion,
    /// Either parent is below `MIN_FUSION_LEVEL`.
    BelowMinLevel,
    /// Either parent's raw pre-tax bond is below `MIN_FUSION_BOND`.
    BelowMinBond,
}

/// Pure fusion eligibility gate (ADR-0147): rejects self-fusion, then either
/// parent below `MIN_FUSION_LEVEL`, then either parent below `MIN_FUSION_BOND`
/// (checked on raw pre-tax values). Check order is part of the contract — the
/// eligibility-parity tests pin it.
///
/// `MonsterInstance` carries no identity, so the caller passes the two monster
/// ids as opaque handles compared only for equality (the recorded deviation
/// from the spec's two-argument signature — ADR-0147).
///
/// # Errors
/// Returns the first failing `FusionError` in the order above.
pub fn fusion_eligible(
    a_id: u64,
    b_id: u64,
    a: &MonsterInstance,
    b: &MonsterInstance,
) -> Result<(), FusionError> {
    if a_id == b_id {
        return Err(FusionError::SelfFusion);
    }
    if a.level.as_u8() < MIN_FUSION_LEVEL || b.level.as_u8() < MIN_FUSION_LEVEL {
        return Err(FusionError::BelowMinLevel);
    }
    if a.bond.value() < MIN_FUSION_BOND || b.bond.value() < MIN_FUSION_BOND {
        return Err(FusionError::BelowMinBond);
    }
    Ok(())
}

/// Resolve which species `evolutions` says the monster evolves into, given its
/// current `level`, `bond`, and an optionally `applied_item` id.
///
/// Returns the `to_species` id of the FIRST matching branch in declaration order,
/// or `None` if no branch matches. Item branches NEVER fire on a passive `None`
/// check (the item must have been explicitly applied).
///
/// Trigger semantics (INCLUSIVE on both sides):
/// - `Level(l)` fires when `level >= l`
/// - `Bond(b)` fires when `bond >= b`
/// - `Item(id)` fires when `applied_item == Some(id)` (exact id match, never on `None`)
#[must_use]
pub fn resolve_evolution(
    evolutions: &[EvolutionCondition],
    level: Level,
    bond: Bond,
    applied_item: Option<u32>,
) -> Option<u32> {
    // FIRST-wins, declaration order. The `match` is EXHAUSTIVE with NO wildcard
    // arm so a future `EvolutionTrigger` variant compiler-flags here (ADR-0061).
    evolutions.iter().find_map(|cond| {
        let fires = match cond.trigger {
            EvolutionTrigger::Level(l) => level >= l,
            EvolutionTrigger::Bond(b) => bond >= b,
            EvolutionTrigger::Item(id) => applied_item == Some(id),
        };
        fires.then_some(cond.to_species)
    })
}

/// Passive convenience wrapper: checks whether `monster` is eligible to evolve
/// without any item being applied (i.e. `applied_item = None`).
///
/// Equivalent to `resolve_evolution(&evolutions, monster.level, monster.bond, None)`.
/// Delegates to `resolve_evolution` (single implementation path — SSOT).
#[must_use]
pub fn evolves_to(evolutions: &[EvolutionCondition], monster: &MonsterInstance) -> Option<u32> {
    resolve_evolution(evolutions, monster.level, monster.bond, None)
}

// ============================================================================
// Eligibility unit and boundary tests (M10a-rules, criteria 1–7 + #19 note)
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::content::{EvolutionCondition, EvolutionTrigger};
    use crate::monster::rules::derive_stats;
    use crate::monster::types::{
        Bond, EVs, IVs, Level, MonsterInstance, Nature, NatureKind, StatBlock, Xp,
    };
    // A0 T-reach: `apply_care` is the ONLY bond writer in the game, so the fusion
    // bond minimum's real cost is measured in care actions (ADR-0140 moved these
    // constants into `game-core::raising`).
    use crate::raising::CARE_BOND_AMOUNT;

    // -----------------------------------------------------------------------
    // Fixture helpers
    // -----------------------------------------------------------------------

    fn lv(n: u8) -> Level {
        Level::new(n).unwrap()
    }

    fn bond(n: u8) -> Bond {
        Bond::new(n)
    }

    fn cond_level(threshold: u8, to_species: u32) -> EvolutionCondition {
        EvolutionCondition {
            trigger: EvolutionTrigger::Level(lv(threshold)),
            to_species,
        }
    }

    fn cond_bond(threshold: u8, to_species: u32) -> EvolutionCondition {
        EvolutionCondition {
            trigger: EvolutionTrigger::Bond(bond(threshold)),
            to_species,
        }
    }

    fn cond_item(item_id: u32, to_species: u32) -> EvolutionCondition {
        EvolutionCondition {
            trigger: EvolutionTrigger::Item(item_id),
            to_species,
        }
    }

    /// Build a minimal `MonsterInstance` for passive `evolves_to` tests.
    fn fixture_monster(level: u8, bond_val: u8) -> MonsterInstance {
        let base = StatBlock {
            hp: 45,
            attack: 49,
            defense: 49,
            speed: 65,
            sp_attack: 65,
            sp_defense: 45,
        };
        let ivs = IVs::new(15, 15, 15, 15, 15, 15).unwrap();
        let evs = EVs::zero();
        let nature = Nature::new(NatureKind::Hardy);
        let lv = Level::new(level).unwrap();
        let derived_stats = derive_stats(&base, &ivs, &evs, &nature, lv);
        MonsterInstance {
            species_id: 1,
            nickname: None,
            level: lv,
            xp: Xp::new(level as u32 * level as u32 * level as u32),
            ivs,
            nature,
            evs,
            bond: Bond::new(bond_val),
            current_hp: derived_stats.hp,
            derived_stats,
            party_slot: None,
        }
    }

    // -----------------------------------------------------------------------
    // Criterion 1 — Level boundary INCLUSIVE
    // kills: a `>` (strict) impl instead of `>=` (inclusive)
    // -----------------------------------------------------------------------

    /// Criterion 1a: level 15 is BELOW threshold 16 → None.
    /// Discriminator: proves the boundary is at 16, not 15.
    #[test]
    fn level_trigger_below_threshold_yields_none() {
        // kills: an impl that uses level > 15 (accepting 15 as matching)
        let evolutions = vec![cond_level(16, 4)];
        assert_eq!(
            resolve_evolution(&evolutions, lv(15), bond(0), None),
            None,
            "level 15 is below threshold 16 — must not match"
        );
    }

    /// Criterion 1b: level 16 equals threshold exactly → Some(4).
    /// THIS is the discriminator that kills `>` instead of `>=`.
    #[test]
    fn level_trigger_at_threshold_is_inclusive() {
        // kills: `level > threshold` (strict) — level==threshold would return None
        let evolutions = vec![cond_level(16, 4)];
        assert_eq!(
            resolve_evolution(&evolutions, lv(16), bond(0), None),
            Some(4),
            "level == threshold (16) must match INCLUSIVELY"
        );
    }

    /// Criterion 1c: level 17 exceeds threshold 16 → Some(4).
    #[test]
    fn level_trigger_above_threshold_matches() {
        let evolutions = vec![cond_level(16, 4)];
        assert_eq!(
            resolve_evolution(&evolutions, lv(17), bond(0), None),
            Some(4),
            "level 17 > threshold 16 — must match"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 2 — Bond boundary INCLUSIVE
    // kills: `>` (strict) instead of `>=` (inclusive)
    // -----------------------------------------------------------------------

    /// Criterion 2a: bond 199 below threshold 200 → None.
    #[test]
    fn bond_trigger_below_threshold_yields_none() {
        // kills: treating bond==200 as "not yet reached"
        let evolutions = vec![cond_bond(200, 5)];
        assert_eq!(
            resolve_evolution(&evolutions, lv(1), bond(199), None),
            None,
            "bond 199 < threshold 200 — must not match"
        );
    }

    /// Criterion 2b: bond 200 equals threshold exactly → Some(5).
    /// THIS is the discriminator that kills `>` instead of `>=`.
    #[test]
    fn bond_trigger_at_threshold_is_inclusive() {
        // kills: `bond > threshold` — bond==threshold would return None
        let evolutions = vec![cond_bond(200, 5)];
        assert_eq!(
            resolve_evolution(&evolutions, lv(1), bond(200), None),
            Some(5),
            "bond == threshold (200) must match INCLUSIVELY"
        );
    }

    /// Criterion 2c: bond 201 above threshold 200 → Some(5).
    #[test]
    fn bond_trigger_above_threshold_matches() {
        let evolutions = vec![cond_bond(200, 5)];
        assert_eq!(
            resolve_evolution(&evolutions, lv(1), bond(201), None),
            Some(5),
            "bond 201 > threshold 200 — must match"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 3 — FIRST-wins when multiple branches match
    // kills: last-wins, collect-all, nondeterministic iteration
    // -----------------------------------------------------------------------

    /// Criterion 3: both Level(16) and Bond(200) match simultaneously → first branch wins.
    /// Species has [Level(16)->4, Bond(200)->5]; at level=16 AND bond=200 both fire.
    /// FIRST-wins = Level branch = Some(4), not Some(5).
    #[test]
    fn first_wins_when_multiple_branches_match() {
        // kills: last-wins (would return Some(5)) / collect-all / nondeterministic order
        let evolutions = vec![cond_level(16, 4), cond_bond(200, 5)];
        assert_eq!(
            resolve_evolution(&evolutions, lv(16), bond(200), None),
            Some(4),
            "FIRST-wins: Level branch (idx 0) must win over Bond branch (idx 1)"
        );
    }

    /// Criterion 3 (swapped order): Bond first in list → Bond branch wins.
    /// Confirms it is truly declaration order, not trigger type priority.
    #[test]
    fn first_wins_respects_declaration_order() {
        // kills: a type-based priority (e.g. Level always beats Bond)
        let evolutions = vec![cond_bond(200, 5), cond_level(16, 4)];
        assert_eq!(
            resolve_evolution(&evolutions, lv(16), bond(200), None),
            Some(5),
            "Bond is first in list — must win (declaration order, not type priority)"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 4 — Item NEVER fires on a passive None check
    // kills: treating Item like passive state / unwrapping None
    // -----------------------------------------------------------------------

    /// Criterion 4: Item trigger with applied_item=None → None (never passive).
    /// Max level and max bond — the item branch must still not fire.
    #[test]
    fn item_trigger_never_fires_passively() {
        // kills: `applied_item.is_some()` / treating None as "any item" / unwrap
        let evolutions = vec![cond_item(42, 99)];
        assert_eq!(
            resolve_evolution(&evolutions, lv(100), bond(255), None),
            None,
            "Item(42) with applied_item=None must NEVER match (even at max level/bond)"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 5 — Item exact id match
    // kills: `is_some()` instead of `== Some(id)`
    // -----------------------------------------------------------------------

    /// Criterion 5a: applied_item=Some(42) matches Item(42) → Some(99).
    #[test]
    fn item_trigger_matches_exact_id() {
        // kills: any impl that does not check the item id (e.g. `applied_item.is_some()`)
        let evolutions = vec![cond_item(42, 99)];
        assert_eq!(
            resolve_evolution(&evolutions, lv(1), bond(0), Some(42)),
            Some(99),
            "Item(42) with applied_item=Some(42) must match and return 99"
        );
    }

    /// Criterion 5b: applied_item=Some(99) does NOT match Item(42) → None.
    /// Kills: `is_some()` which would incorrectly match any item id.
    #[test]
    fn item_trigger_rejects_wrong_id() {
        // kills: `applied_item.is_some()` — would return Some(99) for item 99 too
        let evolutions = vec![cond_item(42, 99)];
        assert_eq!(
            resolve_evolution(&evolutions, lv(1), bond(0), Some(99)),
            None,
            "Item(42) with applied_item=Some(99) must NOT match (wrong item id)"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 6 — Empty/non-matching branch list → None (no panic)
    // -----------------------------------------------------------------------

    /// Criterion 6a: empty evolutions list → None (no panic).
    #[test]
    fn empty_evolutions_yields_none_no_panic() {
        // kills: an impl that panics on empty slice (e.g. [0] index)
        let result = resolve_evolution(&[], lv(100), bond(255), Some(42));
        assert_eq!(
            result, None,
            "empty branch list must return None, not panic"
        );
    }

    /// Criterion 6b: non-matching conditions → None.
    #[test]
    fn non_matching_conditions_yield_none() {
        // Level too low, bond too low, no item applied
        let evolutions = vec![cond_level(50, 4), cond_bond(200, 5), cond_item(99, 7)];
        assert_eq!(
            resolve_evolution(&evolutions, lv(10), bond(100), None),
            None,
            "no conditions match — must return None"
        );
    }

    // -----------------------------------------------------------------------
    // Criterion 7 — evolves_to is the passive seam over resolve_evolution
    // kills: a separate implementation that diverges from resolve_evolution
    // -----------------------------------------------------------------------

    /// Criterion 7: evolves_to(evolutions, monster) == resolve_evolution(evolutions, monster.level, monster.bond, None).
    #[test]
    fn evolves_to_matches_resolve_evolution_with_none_item() {
        // kills: a parallel impl that may diverge (e.g. off-by-one on level/bond)
        let evolutions = vec![cond_level(16, 4), cond_bond(200, 5)];

        // Test multiple (level, bond) combinations
        for (lv_val, bond_val) in [(15u8, 199u8), (16, 100), (1, 200), (16, 200)] {
            let monster = fixture_monster(lv_val, bond_val);
            let direct = resolve_evolution(&evolutions, lv(lv_val), bond(bond_val), None);
            let via_wrapper = evolves_to(&evolutions, &monster);
            assert_eq!(
                direct, via_wrapper,
                "evolves_to must equal resolve_evolution(..., None) for level={lv_val} bond={bond_val}"
            );
        }
    }

    // =======================================================================
    // A0-7 (ADR-0147) — `fusion_eligible` gate: T17–T23 + T-reach
    //
    // Check order under test (D4): self -> level (EITHER parent) -> bond (EITHER
    // parent). `FusionError` variants are payload-free, so only the CATEGORY order
    // is observable — that is exactly what T22 pins.
    //
    // Every fixture below sits STRICTLY above the minimum it is not testing, so a
    // `<` -> `!=` mutation cannot hide behind an exact-boundary-only fixture.
    // =======================================================================

    /// T17: the EXACT minimums (level 10, bond 120 on BOTH parents) → `Ok(())`.
    #[test]
    fn fusion_eligible_accepts_the_exact_minimums() {
        // kills: `>` / `<=` boundary bugs — a strict impl rejects level==10 or bond==120
        assert_eq!(
            fusion_eligible(1, 2, &fixture_monster(10, 120), &fixture_monster(10, 120)),
            Ok(()),
            "level 10 / bond 120 is the INCLUSIVE minimum on both parents — must be Ok"
        );
    }

    /// T17b: strictly ABOVE both minimums → `Ok(())`.
    #[test]
    fn fusion_eligible_accepts_strictly_above_the_minimums() {
        // kills: `<` -> `!=` mutants, which survive an exact-boundary-only Ok fixture
        assert_eq!(
            fusion_eligible(1, 2, &fixture_monster(50, 200), &fixture_monster(50, 200)),
            Ok(()),
            "levels 50 / bonds 200 are strictly above both minimums — must be Ok"
        );
    }

    /// T18: the same monster id on both sides is `SelfFusion`, whatever its stats.
    #[test]
    fn fusion_eligible_rejects_self_fusion() {
        // kills: dropping the id comparison entirely; comparing the INSTANCES
        // (identical stats would then read as "different monsters")
        assert_eq!(
            fusion_eligible(7, 7, &fixture_monster(50, 200), &fixture_monster(50, 200)),
            Err(FusionError::SelfFusion),
            "the same monster id on both sides must be SelfFusion even with perfect stats"
        );
    }

    /// T19: identity is checked BEFORE the stat gates.
    #[test]
    fn fusion_eligible_reports_self_fusion_before_stat_failures() {
        // kills: level/bond checked first — a level-1 bond-0 self-fuse would then
        // report BelowMinLevel and the reducer's self-fusion message would drift
        assert_eq!(
            fusion_eligible(7, 7, &fixture_monster(1, 0), &fixture_monster(1, 0)),
            Err(FusionError::SelfFusion),
            "a level-1 / bond-0 self-fuse must report SelfFusion, not BelowMinLevel"
        );
    }

    /// T20: level below the minimum on EITHER parent → `BelowMinLevel`.
    /// Both fixtures carry bond 200 (strictly above 120) so bond can never fire.
    #[test]
    fn fusion_eligible_rejects_level_below_minimum_on_either_parent() {
        // kills: `&&` instead of `||` (only both-below rejects), a-only, b-only
        assert_eq!(
            fusion_eligible(1, 2, &fixture_monster(9, 200), &fixture_monster(50, 200)),
            Err(FusionError::BelowMinLevel),
            "parent a at level 9 must be rejected (kills b-only and && forms)"
        );
        assert_eq!(
            fusion_eligible(1, 2, &fixture_monster(50, 200), &fixture_monster(9, 200)),
            Err(FusionError::BelowMinLevel),
            "parent b at level 9 must be rejected (kills a-only and && forms)"
        );
    }

    /// T21: bond below the minimum on EITHER parent → `BelowMinBond`.
    /// Both fixtures carry level 50 (strictly above 10) so level can never fire.
    #[test]
    fn fusion_eligible_rejects_bond_below_minimum_on_either_parent() {
        // kills: `&&` instead of `||`, a-only, b-only, and a POST-TAX bond check
        // (the gate reads the raw stored bond, not 119 * 75 / 100)
        assert_eq!(
            fusion_eligible(1, 2, &fixture_monster(50, 119), &fixture_monster(50, 200)),
            Err(FusionError::BelowMinBond),
            "parent a at bond 119 must be rejected (kills b-only and && forms)"
        );
        assert_eq!(
            fusion_eligible(1, 2, &fixture_monster(50, 200), &fixture_monster(50, 119)),
            Err(FusionError::BelowMinBond),
            "parent b at bond 119 must be rejected (kills a-only and && forms)"
        );
    }

    /// T22: level is the COARSER gate and is reported before bond.
    #[test]
    fn fusion_eligible_reports_level_before_bond() {
        // kills: bond-checked-first (would report BelowMinBond and drift the
        // server-side message mapping away from the parity matrix)
        assert_eq!(
            fusion_eligible(1, 2, &fixture_monster(9, 200), &fixture_monster(50, 119)),
            Err(FusionError::BelowMinLevel),
            "a level failure on a and a bond failure on b must report BelowMinLevel"
        );
    }

    /// T23: the two published minimums are pinned to their spec values.
    #[test]
    fn fusion_minimum_constants_are_pinned() {
        // kills: a silent retune of either constant (every other test in this file
        // hardcodes its expectations, so a retune must land HERE first)
        assert_eq!(
            MIN_FUSION_LEVEL, 10u8,
            "MIN_FUSION_LEVEL must be exactly 10 (spec A0-7)"
        );
        assert_eq!(
            MIN_FUSION_BOND, 120u8,
            "MIN_FUSION_BOND must be exactly 120 (spec A0-7)"
        );
    }

    /// T-reach: `MIN_FUSION_BOND` must stay REACHABLE by real play. `apply_care`
    /// (+`CARE_BOND_AMOUNT` per action, 6h cooldown) is the only bond writer, so a
    /// default-bond monster needs exactly 10 care actions to become fusable.
    /// The 10 is hardcoded: any retune of `MIN_FUSION_BOND`, `CARE_BOND_AMOUNT`, or
    /// `Bond::default_bond()` must surface here as a wall-clock grind change.
    #[test]
    fn fusion_bond_minimum_is_ten_care_actions_above_default_bond() {
        // kills: a silent MIN_FUSION_BOND / CARE_BOND_AMOUNT / default_bond retune
        // that quietly changes the fusion grind without any other test going red
        let gap = u32::from(MIN_FUSION_BOND) - u32::from(Bond::default_bond().value());
        assert_eq!(
            gap, 50,
            "the fusion bond gap above default bond must be 50 (120 - 70)"
        );
        assert_eq!(
            gap / u32::from(CARE_BOND_AMOUNT),
            10,
            "MIN_FUSION_BOND must be exactly 10 apply_care actions above Bond::default_bond()"
        );
        // Exactness (not just the floor of the division): 10 whole care actions land
        // EXACTLY on the minimum — no truncated 11th partial action hiding in the gap.
        assert_eq!(
            10 * u32::from(CARE_BOND_AMOUNT),
            gap,
            "10 care actions must land exactly on MIN_FUSION_BOND, not merely past it"
        );
    }

    // -----------------------------------------------------------------------
    // #19 exhaustiveness guard (comment, not a runtime test)
    //
    // NO wildcard `_` arm is used in the match on `EvolutionTrigger` inside
    // `resolve_evolution`. Adding a new `EvolutionTrigger` variant to `content.rs`
    // MUST produce a compile error in `eligibility.rs`, forcing the implementer to
    // handle the new trigger explicitly (exhaustiveness as a compiler gate).
    //
    // The spec forbids `#[non_exhaustive]` on `EvolutionTrigger` for exactly this reason.
    // -----------------------------------------------------------------------
}
