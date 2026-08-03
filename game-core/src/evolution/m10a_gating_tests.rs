//! EG1 gating tests — the essence-graph eligibility contract (proof-of-teeth).
//!
//! Spec: `M-evolution-essence-graph.spec.md` EG1-6 / EG1-7 / EG2-2, ADR-0174
//! D2 (essence zeroed on evolve), D3 (nutrition), D4 (Trust smoothing, `K=10`,
//! bands `[30,45,60,80]`), D6 (Quality-Time bands `[10,50,150,400]`).
//!
//! Covered here:
//!   - `path_satisfied`   — the five AND-combined gates, their inclusive
//!     boundaries, affinity-indexed (never positional) essence lookup,
//!     permissive-when-absent semantics, and a monotonicity property.
//!   - `trust_tier_of`    — anti-saturation teeth, all four exact-tie band
//!     boundaries, reachability at both ends, overflow totality, monotonicity.
//!   - `quality_time_tier_of` / `nutrition_pct_of` — band and range boundaries.
//!   - `eligible_evolution_paths` — the FULL eligible set (EG2-2), the
//!     `from_species` filter, input-slice index addressing, and an oracle
//!     property against `path_satisfied`.
//!   - `evolve` — zeroes all 8 essence pools, carries Trust/Quality-Time verbatim.
//!
//! Band CONSTANTS are deliberately NOT pinned by equality assertions: the
//! exact-tie boundary fixtures below ARE the pin (a retune must move them).
//!
//! Run: cargo test -p game-core m10a_gating

use crate::content::{EssenceRequirement, EvolutionPath, Species, TrustTier};
use crate::evolution::{
    eligible_evolution_paths, evolve, nutrition_pct_from_ev_total, nutrition_pct_of,
    path_satisfied, quality_time_tier_of, trust_tier_of,
};
use crate::monster::rules::{derive_stats, xp_for_level};
use crate::monster::types::{
    Affinity, EVs, IVs, Level, MonsterInstance, Nature, NatureKind, StatBlock,
};

use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

/// `TrustTier` in ascending `Ord` order — the same order the enum declares.
const ALL_TRUST_TIERS: [TrustTier; 5] = [
    TrustTier::Hostile,
    TrustTier::Wary,
    TrustTier::Neutral,
    TrustTier::Friendly,
    TrustTier::Devoted,
];

fn lv(n: u8) -> Level {
    Level::new(n).expect("fixture level must be in [1, 100]")
}

fn species(id: u32, hp: u16, other: u16) -> Species {
    Species {
        id,
        name: format!("Species{id}"),
        base_stats: StatBlock {
            hp,
            attack: other,
            defense: other,
            speed: other,
            sp_attack: other,
            sp_defense: other,
        },
        affinity: Affinity::Fire,
        learnable_skill_ids: vec![],
        ability: None,
        tier: 0,
    }
}

fn default_base() -> StatBlock {
    StatBlock {
        hp: 45,
        attack: 49,
        defense: 49,
        speed: 65,
        sp_attack: 65,
        sp_defense: 45,
    }
}

/// A monster with every gate-relevant field explicitly set. `derived_stats`,
/// `xp` and `current_hp` are kept mutually consistent so the fixture is a
/// monster the real marshal layer would accept.
fn monster(
    species_id: u32,
    level: u8,
    essence: [u32; 8],
    trust_favorable_count: u32,
    trust_unfavorable_count: u32,
    quality_time_ticks_total: u32,
    evs: EVs,
) -> MonsterInstance {
    let ivs = IVs::new(15, 15, 15, 15, 15, 15).expect("15 is a valid IV");
    let nature = Nature::new(NatureKind::Hardy);
    let level = lv(level);
    let derived_stats = derive_stats(&default_base(), &ivs, &evs, &nature, level);
    MonsterInstance {
        species_id,
        nickname: None,
        level,
        xp: xp_for_level(level),
        ivs,
        nature,
        evs,
        essence,
        trust_favorable_count,
        trust_unfavorable_count,
        quality_time_ticks_total,
        current_hp: derived_stats.hp,
        derived_stats,
        party_slot: None,
    }
}

/// A monster of species 1 at `level` with NO essence and NO history at all.
fn plain_monster(level: u8) -> MonsterInstance {
    monster(1, level, [0; 8], 0, 0, 0, EVs::zero())
}

/// An edge with ONLY a level gate: no essence, all three history gates `None`.
fn level_path(edge_id: u32, from_species: u32, to_species: u32, min_level: u8) -> EvolutionPath {
    EvolutionPath {
        edge_id,
        from_species,
        to_species,
        min_level: lv(min_level),
        essence: vec![],
        min_trust_tier: None,
        min_quality_time_tier: None,
        min_nutrition_pct: None,
    }
}

fn req(affinity: Affinity, amount: u32) -> EssenceRequirement {
    EssenceRequirement { affinity, amount }
}

/// Essence array with a single affinity funded.
fn essence_of(affinity: Affinity, amount: u32) -> [u32; 8] {
    let mut out = [0u32; 8];
    out[affinity.index()] = amount;
    out
}

/// EVs whose total is exactly `total` (spread over hp/attack/defense, each
/// bounded by the 252 per-stat cap; `total` must be <= the 510 budget).
fn evs_totalling(total: u16) -> EVs {
    let hp = total.min(252);
    let attack = (total - hp).min(252);
    let defense = total - hp - attack;
    EVs::new(hp, attack, defense, 0, 0, 0).expect("fixture EV total must be within the caps")
}

// ===========================================================================
// path_satisfied — level gate
// ===========================================================================

/// EG1-6: the level threshold is INCLUSIVE.
/// kills: a `>` (strict) comparison — level == min_level would read as unmet.
#[test]
fn path_satisfied_level_threshold_is_inclusive() {
    let path = level_path(1, 1, 2, 16);
    assert!(
        !path_satisfied(&plain_monster(15), &path),
        "level 15 is BELOW min_level 16 — the gate must not open"
    );
    assert!(
        path_satisfied(&plain_monster(16), &path),
        "level 16 EQUALS min_level 16 — the gate is inclusive (kills a strict `>`)"
    );
    assert!(
        path_satisfied(&plain_monster(17), &path),
        "level 17 is above min_level 16 — the gate must open"
    );
}

// ===========================================================================
// path_satisfied — essence gate
// ===========================================================================

/// EG1-6: EVERY essence entry must be met (AND, never "any of").
/// kills: an impl that returns true as soon as one requirement is satisfied.
#[test]
fn path_satisfied_requires_every_essence_entry() {
    let mut path = level_path(1, 1, 2, 1);
    path.essence = vec![req(Affinity::Fire, 100), req(Affinity::Water, 50)];

    let mut short = [0u32; 8];
    short[Affinity::Fire.index()] = 100;
    short[Affinity::Water.index()] = 49; // one short on the SECOND entry
    assert!(
        !path_satisfied(&monster(1, 50, short, 0, 0, 0, EVs::zero()), &path),
        "Water 49 < 50 must fail even though Fire is fully funded — the list is AND, not OR"
    );

    let mut first_short = [0u32; 8];
    first_short[Affinity::Fire.index()] = 99; // one short on the FIRST entry
    first_short[Affinity::Water.index()] = 50;
    assert!(
        !path_satisfied(&monster(1, 50, first_short, 0, 0, 0, EVs::zero()), &path),
        "Fire 99 < 100 must fail even though Water is fully funded"
    );

    let mut both = [0u32; 8];
    both[Affinity::Fire.index()] = 100;
    both[Affinity::Water.index()] = 50;
    assert!(
        path_satisfied(&monster(1, 50, both, 0, 0, 0, EVs::zero()), &path),
        "both entries met exactly at their thresholds must open the gate (inclusive)"
    );
}

/// EG1-6 TRANSPOSITION KILL: essence is looked up by `Affinity`, never by the
/// requirement's POSITION in the list.
///
/// kills: `instance.essence[i]` for the i-th requirement. The path asks for
/// Dark (index 7) while the monster's whole balance sits in Fire (index 0) — a
/// positional impl reads Fire's 999 and wrongly opens the gate.
#[test]
fn path_satisfied_indexes_essence_by_affinity_not_position() {
    let mut path = level_path(1, 1, 2, 1);
    path.essence = vec![req(Affinity::Dark, 100)];

    let banked_in_fire = essence_of(Affinity::Fire, 999);
    assert!(
        !path_satisfied(&monster(1, 50, banked_in_fire, 0, 0, 0, EVs::zero()), &path),
        "999 Fire essence must NOT satisfy a Dark requirement — a positional lookup \
         (essence[0] for requirement 0) would wrongly pass this"
    );

    let banked_in_dark = essence_of(Affinity::Dark, 100);
    assert!(
        path_satisfied(&monster(1, 50, banked_in_dark, 0, 0, 0, EVs::zero()), &path),
        "100 Dark essence must satisfy the Dark requirement (non-vacuity for the kill above)"
    );
}

// ===========================================================================
// path_satisfied — permissive-when-absent
// ===========================================================================

/// EG1-6: a path with no essence and all three history gates `None` is
/// satisfied by a level-1 monster with zero everything.
///
/// kills: treating `None` as "requires the LOWEST tier and therefore some
/// history", or treating an empty essence list as "requires all eight".
#[test]
fn path_satisfied_absent_gates_are_permissive() {
    let path = level_path(1, 1, 2, 1);
    let newborn = plain_monster(1);
    assert!(
        path_satisfied(&newborn, &path),
        "min_level 1 + empty essence + three None gates must be satisfied by a fresh monster \
         with zero essence, zero Trust history, zero Quality Time and zero EVs"
    );
}

// ===========================================================================
// path_satisfied — Trust gate uses Ord >=
// ===========================================================================

/// EG1-6: `min_trust_tier` is an `Ord` `>=` comparison over the ascending
/// tier enum — an EQUAL tier passes and a HIGHER tier passes.
///
/// kills: `==` (only the exact tier passes, so Devoted would be locked out)
/// and a reversed comparison.
#[test]
fn path_satisfied_trust_gate_is_ord_at_least() {
    let mut path = level_path(1, 1, 2, 1);
    path.min_trust_tier = Some(TrustTier::Friendly);

    // (0, 0) smooths to exactly 50% -> Neutral (one band BELOW Friendly)
    assert!(
        !path_satisfied(&monster(1, 50, [0; 8], 0, 0, 0, EVs::zero()), &path),
        "Neutral < Friendly must fail the gate"
    );
    // (5, 0) smooths to exactly 60% -> Friendly (the exact tie)
    assert!(
        path_satisfied(&monster(1, 50, [0; 8], 5, 0, 0, EVs::zero()), &path),
        "Friendly == Friendly must PASS (kills a strict `>` on the tier)"
    );
    // (30, 0) smooths to exactly 80% -> Devoted (above the requirement)
    assert!(
        path_satisfied(&monster(1, 50, [0; 8], 30, 0, 0, EVs::zero()), &path),
        "Devoted > Friendly must PASS (kills an `==` tier match)"
    );
}

// ===========================================================================
// path_satisfied — AND-combination across all five gates
// ===========================================================================

/// A path gating on ALL FIVE dimensions at once.
///
/// Thresholds: level 20, Fire essence 100, Trust >= Friendly, Quality-Time
/// tier >= 2, Nutrition >= 50%.
fn five_gate_path() -> EvolutionPath {
    EvolutionPath {
        edge_id: 1,
        from_species: 1,
        to_species: 2,
        min_level: lv(20),
        essence: vec![req(Affinity::Fire, 100)],
        min_trust_tier: Some(TrustTier::Friendly),
        min_quality_time_tier: Some(2),
        min_nutrition_pct: Some(50),
    }
}

/// A monster sitting EXACTLY on all five thresholds:
/// level 20, Fire 100, Trust (5, 0) = 60% = Friendly, 50 ticks = QT tier 2,
/// EV total 255 = 50% Nutrition.
fn five_gate_monster() -> MonsterInstance {
    monster(
        1,
        20,
        essence_of(Affinity::Fire, 100),
        5,
        0,
        50,
        evs_totalling(255),
    )
}

/// EG1-6: all five gates met exactly at their thresholds -> satisfied.
/// kills: any gate implemented with a strict `>` instead of `>=`.
#[test]
fn path_satisfied_all_five_gates_at_their_exact_thresholds() {
    assert!(
        path_satisfied(&five_gate_monster(), &five_gate_path()),
        "a monster sitting exactly on all five thresholds must satisfy the path — \
         any single gate written with a strict `>` fails here"
    );
}

/// EG1-6 AND-COMBINATION: five variants, each failing EXACTLY ONE gate, all
/// must be rejected.
///
/// kills: a gate dropped from the conjunction (that gate's variant would pass),
/// and kills an `||` combination (every variant would pass on the other four).
#[test]
fn path_satisfied_rejects_when_any_single_gate_fails() {
    let path = five_gate_path();

    let mut low_level = five_gate_monster();
    low_level.level = lv(19);

    let mut low_essence = five_gate_monster();
    low_essence.essence = essence_of(Affinity::Fire, 99);

    let mut low_trust = five_gate_monster();
    low_trust.trust_favorable_count = 0; // (0, 0) = 50% = Neutral

    let mut low_quality_time = five_gate_monster();
    low_quality_time.quality_time_ticks_total = 49; // one tick below tier 2

    let low_nutrition = monster(
        1,
        20,
        essence_of(Affinity::Fire, 100),
        5,
        0,
        50,
        evs_totalling(254), // 49% — one point below the gate
    );

    for (label, m) in [
        ("level", low_level),
        ("essence", low_essence),
        ("trust", low_trust),
        ("quality_time", low_quality_time),
        ("nutrition", low_nutrition),
    ] {
        assert!(
            !path_satisfied(&m, &path),
            "the {label} gate alone is unmet — the five gates are AND-combined, so the path \
             must NOT be satisfied (a dropped gate or an || combination passes here)"
        );
    }
}

// ===========================================================================
// trust_tier_of — teeth
// ===========================================================================

/// EG1-6 ANTI-SATURATION TEETH: one favorable event is `Neutral`, not `Devoted`.
///
/// The un-smoothed ratio `1/1 = 100%` would saturate to the top band; the
/// `K = 10` smoothing puts `11/21 = 52.4%` squarely in the middle band.
/// kills: a raw `fav / (fav + unfav)` ratio, and any `K != 10`.
#[test]
fn trust_tier_of_one_favorable_event_is_neutral() {
    assert_eq!(
        trust_tier_of(1, 0),
        TrustTier::Neutral,
        "a single favorable sample must read Neutral (11/21 = 52.4%) — the un-smoothed ratio \
         of 1.0 would wrongly saturate to Devoted, and it must never read Hostile either"
    );
}

/// EG1-2/EG1-6: zero history smooths to exactly 50% -> `Neutral`.
/// kills: defaulting to the lowest variant (`Hostile`), which is also the
/// schema default this pins (`MonsterPub.trust_tier` defaults to Neutral).
#[test]
fn trust_tier_of_zero_history_is_neutral() {
    assert_eq!(
        trust_tier_of(0, 0),
        TrustTier::Neutral,
        "(0, 0) smooths to (0+10)/(0+0+20) = exactly 50% — the midpoint band"
    );
}

/// Reachability at the TOP: `Devoted` is attainable at 30 net favorable, and
/// NOT one event earlier.
/// kills: an unreachable top band (bands set so high nothing can climb there).
#[test]
fn trust_tier_of_devoted_is_reachable_at_thirty_favorable() {
    assert_eq!(
        trust_tier_of(30, 0),
        TrustTier::Devoted,
        "30 favorable events smooth to 40/50 = exactly 80% — Devoted must be reachable"
    );
    assert_eq!(
        trust_tier_of(29, 0),
        TrustTier::Friendly,
        "29 favorable events smooth to 39/49 = 79.6% — still Friendly (non-vacuity: the \
         boundary is real, not a band that opens early)"
    );
}

/// Reachability at the BOTTOM: `Hostile` is attainable at 14 unfavorable, and
/// NOT one event earlier.
/// kills: an unreachable bottom band.
#[test]
fn trust_tier_of_hostile_is_reachable_at_fourteen_unfavorable() {
    assert_eq!(
        trust_tier_of(0, 14),
        TrustTier::Hostile,
        "14 unfavorable events smooth to 10/34 = 29.4% — below the 30% floor, so Hostile"
    );
    assert_eq!(
        trust_tier_of(0, 13),
        TrustTier::Wary,
        "13 unfavorable events smooth to 10/33 = 30.3% — still Wary (the boundary is real)"
    );
}

/// ALL FOUR band boundaries at their EXACT ties (spec §5 / ADR-0174 D4).
///
/// Each pair lands the smoothed ratio exactly on a band percentage, so the
/// `>=` (inclusive) semantics decide the answer. These fixtures ARE the pin on
/// the `[30, 45, 60, 80]` band constants — a retune must move them.
/// kills: `>` instead of `>=` at any of the four boundaries, and a band shift.
#[test]
fn trust_tier_of_exact_band_ties_resolve_upward() {
    // (5 + 10) * 100 == 30 * (5 + 25 + 20) -> exactly 30%
    assert_eq!(
        trust_tier_of(5, 25),
        TrustTier::Wary,
        "exactly 30% must be Wary, not Hostile (the band floor is INCLUSIVE)"
    );
    // (8 + 10) * 100 == 45 * (8 + 12 + 20) -> exactly 45%
    assert_eq!(
        trust_tier_of(8, 12),
        TrustTier::Neutral,
        "exactly 45% must be Neutral, not Wary"
    );
    // (5 + 10) * 100 == 60 * (5 + 0 + 20) -> exactly 60%
    assert_eq!(
        trust_tier_of(5, 0),
        TrustTier::Friendly,
        "exactly 60% must be Friendly, not Neutral"
    );
    // (30 + 10) * 100 == 80 * (30 + 0 + 20) -> exactly 80%
    assert_eq!(
        trust_tier_of(30, 0),
        TrustTier::Devoted,
        "exactly 80% must be Devoted, not Friendly"
    );
}

/// TOTALITY at the extremes: the smoothing denominator `fav + unfav + 2K`
/// OVERFLOWS a `u32` for these inputs, so the arithmetic must widen BEFORE
/// adding (the workspace builds release with overflow checks on, so a late
/// widening is a panic, not a wrap).
/// kills: `(fav + unfav + 2 * TRUST_K)` computed in `u32`, and a `u32`
/// cross-multiplication that overflows on `(fav + K) * 100`.
#[test]
fn trust_tier_of_is_total_at_the_u32_extremes() {
    assert_eq!(
        trust_tier_of(u32::MAX, 1),
        TrustTier::Devoted,
        "u32::MAX favorable against 1 unfavorable is ~100% — must resolve to Devoted, not panic"
    );
    assert_eq!(
        trust_tier_of(u32::MAX, u32::MAX),
        TrustTier::Neutral,
        "equal maxima smooth to exactly 50% — must resolve to Neutral, not panic"
    );
}

// ===========================================================================
// quality_time_tier_of
// ===========================================================================

/// ADR-0174 D6: the four Quality-Time bands `[10, 50, 150, 400]` with
/// INCLUSIVE lower bounds, probed one tick either side of each.
/// kills: a strict `>` at any band, an off-by-one band value, and a tier that
/// keeps climbing past 4.
#[test]
fn quality_time_tier_of_band_boundaries() {
    for (ticks, expected) in [
        (0u32, 0u8),
        (9, 0),
        (10, 1),
        (49, 1),
        (50, 2),
        (149, 2),
        (150, 3),
        (399, 3),
        (400, 4),
        (u32::MAX, 4),
    ] {
        assert_eq!(
            quality_time_tier_of(ticks),
            expected,
            "{ticks} lifetime ticks must map to Quality-Time tier {expected}"
        );
    }
}

// ===========================================================================
// nutrition_pct_of
// ===========================================================================

/// ADR-0174 D3: Nutrition is the EV pool as a percentage of its 510 budget.
/// kills: a per-stat percentage, a 252-denominator, and an unscaled passthrough.
#[test]
fn nutrition_pct_of_spans_zero_to_one_hundred() {
    assert_eq!(
        nutrition_pct_of(&EVs::zero()),
        0,
        "an untrained monster is 0% Nutrition"
    );
    let full = EVs::new(252, 252, 6, 0, 0, 0).expect("510 is exactly the EV budget");
    assert_eq!(full.total(), 510, "fixture sanity: the EV total is the cap");
    assert_eq!(
        nutrition_pct_of(&full),
        100,
        "the full 510-point EV budget is 100% Nutrition"
    );
    assert_eq!(
        nutrition_pct_of(&evs_totalling(255)),
        50,
        "half the budget (255) is exactly 50% — the AND-combination fixture depends on this"
    );
}

/// The total-based helper never reports above 100, even for a total ABOVE the
/// budget (a defensive input the server row could in principle carry).
/// kills: an unclamped `total * 100 / 510`.
#[test]
fn nutrition_pct_from_ev_total_is_clamped_at_one_hundred() {
    assert_eq!(nutrition_pct_from_ev_total(0), 0);
    assert_eq!(nutrition_pct_from_ev_total(510), 100);
    assert_eq!(
        nutrition_pct_from_ev_total(u16::MAX),
        100,
        "an out-of-range total must clamp to 100, never exceed it or wrap"
    );
}

// ===========================================================================
// eligible_evolution_paths
// ===========================================================================

/// EG2-2 FORWARD PIN: two simultaneously-satisfied paths yield BOTH indices —
/// never a single first-match winner.
///
/// kills: `.find()`/`.position()` (returns one), and any dominance ordering.
/// This is the anti-pattern the whole player-choice UX exists to avoid.
#[test]
fn eligible_evolution_paths_returns_every_satisfied_path() {
    let paths = vec![level_path(1, 1, 2, 10), level_path(2, 1, 3, 10)];
    let m = plain_monster(20);
    assert_eq!(
        eligible_evolution_paths(&m, &paths),
        vec![0, 1],
        "both paths are satisfied — BOTH indices must be returned (a first-match winner is the \
         silent-race anti-pattern EG2-2 forbids)"
    );
}

/// EG1-6: a path whose `from_species` is a DIFFERENT species is never eligible,
/// however satisfied its gates are.
/// kills: a `path_satisfied`-only filter that forgets the species match.
#[test]
fn eligible_evolution_paths_filters_by_from_species() {
    let paths = vec![level_path(1, 99, 2, 1)];
    let m = plain_monster(100); // maximum level: every gate on this path is met
    assert!(
        eligible_evolution_paths(&m, &paths).is_empty(),
        "an edge out of species 99 must never be eligible for a species-1 monster, even at \
         level 100 with every gate satisfied"
    );
}

/// An empty candidate slice yields an empty vec (no panic, no fabricated index).
#[test]
fn eligible_evolution_paths_on_an_empty_slice_is_empty() {
    assert!(
        eligible_evolution_paths(&plain_monster(50), &[]).is_empty(),
        "an empty path slice must return an empty vec, never panic"
    );
}

/// EG1-6: the returned indices address the INPUT slice, not a filtered
/// sub-list.
///
/// Non-matching entries are interleaved at positions 0 and 2 so a
/// re-indexed-after-filter impl would return `[0, 1]` instead of `[1, 3]`.
/// kills: `filter(...).enumerate()` (enumerating AFTER the filter).
#[test]
fn eligible_evolution_paths_indices_address_the_input_slice() {
    let paths = vec![
        level_path(1, 99, 2, 1), // index 0: wrong species
        level_path(2, 1, 2, 10), // index 1: eligible
        level_path(3, 99, 3, 1), // index 2: wrong species
        level_path(4, 1, 3, 10), // index 3: eligible
    ];
    assert_eq!(
        eligible_evolution_paths(&plain_monster(20), &paths),
        vec![1, 3],
        "indices must address the INPUT slice — an impl that enumerates after filtering \
         returns [0, 1] here"
    );
}

// ===========================================================================
// evolve — essence reset + history carry (ADR-0174 D2)
// ===========================================================================

/// ADR-0174 D2 / spec §4: EVERY essence pool is zeroed by a successful evolve.
/// kills: zeroing only the pools the path consumed, only the first pool, or
/// carrying essence through verbatim (the clone-based transform's default).
#[test]
fn evolve_zeroes_every_essence_pool() {
    let source = species(1, 45, 49);
    let target = species(2, 80, 100);
    let seeded = monster(
        source.id,
        30,
        [11, 22, 33, 44, 55, 66, 77, 88],
        0,
        0,
        0,
        EVs::zero(),
    );
    assert!(
        seeded.essence.iter().all(|&e| e > 0),
        "fixture sanity: all 8 pools start non-zero, so the assertion below is non-vacuous"
    );

    let evolved = evolve(&seeded, &target);

    assert_eq!(
        evolved.essence, [0u32; 8],
        "all 8 essence pools must be zero after evolving — essence is SPENT, and a partial \
         reset would let a monster re-clear the next tier's bar for free"
    );
}

/// ADR-0174 D2 / EG2-1: Trust and Quality-Time are LIFETIME history and are
/// carried through an evolution verbatim.
/// kills: an over-eager reset that zeroes the history stats alongside essence.
#[test]
fn evolve_carries_trust_and_quality_time_verbatim() {
    let source = species(1, 45, 49);
    let target = species(2, 80, 100);
    let seeded = monster(source.id, 30, [5; 8], 17, 3, 240, EVs::zero());

    let evolved = evolve(&seeded, &target);

    assert_eq!(
        evolved.trust_favorable_count, 17,
        "trust_favorable_count is lifetime history and must survive an evolution"
    );
    assert_eq!(
        evolved.trust_unfavorable_count, 3,
        "trust_unfavorable_count is lifetime history and must survive an evolution"
    );
    assert_eq!(
        evolved.quality_time_ticks_total, 240,
        "quality_time_ticks_total is lifetime history and must survive an evolution"
    );
}

/// Determinism (ADR-0003): evolve twice on identical input is byte-identical.
/// kills: any hidden RNG, wall-clock read, or global counter inside evolve.
#[test]
fn evolve_is_deterministic() {
    let source = species(1, 45, 49);
    let target = species(2, 80, 100);
    let m = monster(
        source.id,
        30,
        [1, 2, 3, 4, 5, 6, 7, 8],
        9,
        4,
        77,
        EVs::zero(),
    );
    assert_eq!(
        evolve(&m, &target),
        evolve(&m, &target),
        "evolve must be byte-identical on repeated calls with the same input"
    );
}

// ===========================================================================
// Property-based tests
// ===========================================================================

fn arb_evs() -> impl Strategy<Value = EVs> {
    (
        0u16..=252,
        0u16..=252,
        0u16..=252,
        0u16..=252,
        0u16..=252,
        0u16..=252,
    )
        .prop_filter("total must be <= 510", |(a, b, c, d, e, f)| {
            a + b + c + d + e + f <= 510
        })
        .prop_map(|(hp, atk, def, spd, spa, spd2)| EVs::new(hp, atk, def, spd, spa, spd2).unwrap())
}

/// An arbitrary edge out of species 1 into species 2, with any mixture of the
/// five gates present or absent.
fn arb_path() -> impl Strategy<Value = EvolutionPath> {
    (
        1u8..=60u8,
        prop::collection::vec((0usize..8usize, 0u32..300u32), 0..=3),
        prop::option::of(0usize..5usize),
        prop::option::of(0u8..=4u8),
        prop::option::of(0u8..=100u8),
    )
        .prop_map(
            |(min_level, essence, trust_idx, quality_time, nutrition)| EvolutionPath {
                edge_id: 1,
                from_species: 1,
                to_species: 2,
                min_level: Level::new(min_level).unwrap(),
                essence: essence
                    .into_iter()
                    .map(|(idx, amount)| EssenceRequirement {
                        affinity: Affinity::ALL[idx],
                        amount,
                    })
                    .collect(),
                min_trust_tier: trust_idx.map(|i| ALL_TRUST_TIERS[i]),
                min_quality_time_tier: quality_time,
                min_nutrition_pct: nutrition,
            },
        )
}

proptest! {
    /// EG1-6 MONOTONICITY: raising any single gate-relevant stat can never
    /// close a gate that was already open.
    ///
    /// kills: an inverted comparison on any gate (a `<=` where `>=` belongs
    /// would make the gate close as the monster grows), and a subtraction that
    /// wraps.
    #[test]
    fn path_satisfied_is_monotone_in_every_growth_stat(
        level in 1u8..=99u8,
        e0 in 0u32..300u32,
        e1 in 0u32..300u32,
        e2 in 0u32..300u32,
        e3 in 0u32..300u32,
        e4 in 0u32..300u32,
        e5 in 0u32..300u32,
        e6 in 0u32..300u32,
        e7 in 0u32..300u32,
        favorable in 0u32..60u32,
        unfavorable in 0u32..60u32,
        ticks in 0u32..600u32,
        ev_total in 0u16..=509u16,
        path in arb_path(),
    ) {
        let essence = [e0, e1, e2, e3, e4, e5, e6, e7];
        let base = monster(
            1,
            level,
            essence,
            favorable,
            unfavorable,
            ticks,
            evs_totalling(ev_total),
        );

        if path_satisfied(&base, &path) {
            let mut raised: Vec<(&str, MonsterInstance)> = Vec::new();

            let mut higher_level = base.clone();
            higher_level.level = Level::new(level + 1).unwrap();
            raised.push(("level", higher_level));

            for idx in 0..8 {
                let mut more_essence = base.clone();
                more_essence.essence[idx] += 1;
                raised.push(("essence", more_essence));
            }

            let mut more_trust = base.clone();
            more_trust.trust_favorable_count += 1;
            raised.push(("trust_favorable_count", more_trust));

            let mut more_ticks = base.clone();
            more_ticks.quality_time_ticks_total += 1;
            raised.push(("quality_time_ticks_total", more_ticks));

            let mut more_nutrition = base.clone();
            more_nutrition.evs = evs_totalling(ev_total + 1);
            raised.push(("nutrition", more_nutrition));

            for (label, m) in raised {
                prop_assert!(
                    path_satisfied(&m, &path),
                    "raising {} must never close an already-open gate",
                    label
                );
            }
        }
    }

    /// `trust_tier_of` is monotone NON-DECREASING in favorable events.
    /// kills: an inverted band lookup.
    #[test]
    fn trust_tier_of_is_non_decreasing_in_favorable(
        favorable in 0u32..500u32,
        unfavorable in 0u32..500u32,
        bump in 1u32..50u32,
    ) {
        prop_assert!(
            trust_tier_of(favorable + bump, unfavorable) >= trust_tier_of(favorable, unfavorable),
            "more favorable events must never LOWER the Trust tier"
        );
    }

    /// `trust_tier_of` is monotone NON-INCREASING in unfavorable events.
    #[test]
    fn trust_tier_of_is_non_increasing_in_unfavorable(
        favorable in 0u32..500u32,
        unfavorable in 0u32..500u32,
        bump in 1u32..50u32,
    ) {
        prop_assert!(
            trust_tier_of(favorable, unfavorable + bump) <= trust_tier_of(favorable, unfavorable),
            "more unfavorable events must never RAISE the Trust tier"
        );
    }

    /// Nutrition never exceeds 100 over the whole valid EV space, and the
    /// instance-based helper AGREES with the total-based one (ADR-0174 D3's
    /// one-formula requirement — the server computes the row-side value with
    /// the total-based helper).
    #[test]
    fn nutrition_pct_of_agrees_with_the_total_based_helper(evs in arb_evs()) {
        let pct = nutrition_pct_of(&evs);
        prop_assert!(pct <= 100, "Nutrition must never exceed 100 (got {})", pct);
        prop_assert_eq!(
            pct,
            nutrition_pct_from_ev_total(evs.total()),
            "nutrition_pct_of must delegate to nutrition_pct_from_ev_total — two formulas \
             would drift between the client panel and the server row"
        );
    }

    /// ORACLE: `eligible_evolution_paths` returns exactly the indices where
    /// `from_species` matches AND `path_satisfied` holds — nothing more,
    /// nothing less, in ascending index order.
    ///
    /// kills: a divergent second copy of the gate logic in the read path (the
    /// exact drift EG1-6's "one shared predicate" requirement forbids).
    #[test]
    fn eligible_evolution_paths_agrees_with_path_satisfied(
        level in 1u8..=100u8,
        favorable in 0u32..60u32,
        ticks in 0u32..600u32,
        ev_total in 0u16..=510u16,
        p0 in arb_path(),
        p1 in arb_path(),
        p2 in arb_path(),
        foreign_species in 2u32..50u32,
    ) {
        let m = monster(1, level, [50; 8], favorable, 0, ticks, evs_totalling(ev_total));
        // p1 is re-homed onto another species so the from_species filter has work to do.
        let mut p1 = p1;
        p1.from_species = foreign_species;
        let paths = vec![p0, p1, p2];

        let expected: Vec<usize> = paths
            .iter()
            .enumerate()
            .filter(|(_, p)| p.from_species == m.species_id && path_satisfied(&m, p))
            .map(|(i, _)| i)
            .collect();

        prop_assert_eq!(
            eligible_evolution_paths(&m, &paths),
            expected,
            "eligible_evolution_paths must equal the from_species-filtered path_satisfied set"
        );
    }
}
