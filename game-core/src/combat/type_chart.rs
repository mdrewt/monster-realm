//! Type effectiveness lookup table — wraps the RON-loaded `TypeRelation` data.
//!
//! `TypeChart::effectiveness` returns the raw multiplier (0, 5, 10, or 20)
//! for an (attacker, defender) affinity pair. Unlisted pairs default to 10
//! (neutral). `TypeChart::classify` maps a raw value to the `Effectiveness`
//! discriminant used by the battle event log.

use crate::content::TypeRelation;
use crate::monster::types::Affinity;

use super::types::Effectiveness;

/// Lookup table for type effectiveness.
///
/// Wraps the parsed RON data; unlisted (attacker, defender) pairs are neutral (10).
pub struct TypeChart {
    relations: Vec<TypeRelation>,
}

impl TypeChart {
    /// Build a `TypeChart` from a slice of `TypeRelation` values.
    pub fn new(relations: &[TypeRelation]) -> Self {
        Self {
            relations: relations.to_vec(),
        }
    }

    /// Return the raw effectiveness value (0, 5, 10, or 20) for the given
    /// attacker→defender affinity pair. Returns 10 (neutral) for any pair
    /// not explicitly listed in the chart.
    pub fn effectiveness(&self, attacker: Affinity, defender: Affinity) -> u8 {
        self.relations
            .iter()
            .find(|r| r.attacker == attacker && r.defender == defender)
            .map(|r| r.effectiveness)
            .unwrap_or(10)
    }

    /// Map a raw effectiveness value to the `Effectiveness` enum used by events.
    ///
    /// | raw value | discriminant       |
    /// |-----------|-------------------|
    /// | 0         | `Immune`          |
    /// | 5         | `NotVeryEffective`|
    /// | 10        | `Neutral`         |
    /// | 20        | `SuperEffective`  |
    pub fn classify(value: u8) -> Effectiveness {
        match value {
            0 => Effectiveness::Immune,
            5 => Effectiveness::NotVeryEffective,
            20 => Effectiveness::SuperEffective,
            _ => Effectiveness::Neutral,
        }
    }
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Fixture builder: constructs a TypeChart from the embedded RON content.
    // -----------------------------------------------------------------------

    /// Builds the standard TypeChart from the hard-coded RON entries.
    ///
    /// Kills: any impl that ignores the `relations` slice passed to `new`.
    pub fn make_type_chart() -> TypeChart {
        let relations =
            crate::content::load_type_chart().expect("embedded type_chart.ron must parse");
        TypeChart::new(&relations)
    }

    // -----------------------------------------------------------------------
    // Known-answer: Fire vs Plant = 20 (super-effective)
    // -----------------------------------------------------------------------

    /// Kills: an impl that returns neutral or NVE for Fire→Plant.
    /// Starts red because `TypeChart::new` and `effectiveness` are `todo!()`.
    #[test]

    fn fire_vs_plant_is_super_effective() {
        let chart = make_type_chart();
        assert_eq!(
            chart.effectiveness(Affinity::Fire, Affinity::Plant),
            20,
            "Fire vs Plant must be 20 (super-effective)"
        );
    }

    // -----------------------------------------------------------------------
    // Known-answer: Fire vs Water = 5 (not very effective)
    // -----------------------------------------------------------------------

    /// Kills: an impl that returns neutral or super-effective for Fire→Water.
    /// Starts red because the stubs are `todo!()`.
    #[test]

    fn fire_vs_water_is_not_very_effective() {
        let chart = make_type_chart();
        assert_eq!(
            chart.effectiveness(Affinity::Fire, Affinity::Water),
            5,
            "Fire vs Water must be 5 (not very effective)"
        );
    }

    // -----------------------------------------------------------------------
    // Known-answer: Fire vs Fire = 5 (same-type)
    // -----------------------------------------------------------------------

    /// Kills: an impl that returns 10 (neutral) for same-type pairs.
    /// Starts red because the stubs are `todo!()`.
    #[test]

    fn fire_vs_fire_is_not_very_effective() {
        let chart = make_type_chart();
        assert_eq!(
            chart.effectiveness(Affinity::Fire, Affinity::Fire),
            5,
            "Fire vs Fire must be 5 (same-type resistance)"
        );
    }

    // -----------------------------------------------------------------------
    // Known-answer: Fire vs Earth = 5 (Earth resists Fire)
    // -----------------------------------------------------------------------

    /// Kills: an impl that forgets Earth resists Fire (only models Fire>Earth).
    /// Starts red because the stubs are `todo!()`.
    #[test]

    fn fire_vs_earth_is_not_very_effective() {
        let chart = make_type_chart();
        assert_eq!(
            chart.effectiveness(Affinity::Fire, Affinity::Earth),
            5,
            "Fire vs Earth must be 5"
        );
    }

    // -----------------------------------------------------------------------
    // Unlisted pair returns 10 (neutral)
    // -----------------------------------------------------------------------

    /// Kills: an impl that returns 0 or panics for unlisted pairs (e.g. Fire→Wind).
    /// Starts red because the stubs are `todo!()`.
    #[test]

    fn unlisted_pair_returns_neutral() {
        let chart = make_type_chart();
        // Fire vs Wind is not listed in the chart, so must default to 10
        assert_eq!(
            chart.effectiveness(Affinity::Fire, Affinity::Wind),
            10,
            "Unlisted pair must default to 10 (neutral)"
        );
    }

    // -----------------------------------------------------------------------
    // Classify: raw values → Effectiveness discriminant
    // -----------------------------------------------------------------------

    /// Kills: an impl that returns Immune for any non-zero value.
    /// Starts red because `classify` is `todo!()`.
    #[test]

    fn classify_zero_is_immune() {
        assert_eq!(TypeChart::classify(0), Effectiveness::Immune);
    }

    /// Kills: an impl that maps 5 to Neutral instead of NVE.
    /// Starts red because `classify` is `todo!()`.
    #[test]

    fn classify_five_is_not_very_effective() {
        assert_eq!(TypeChart::classify(5), Effectiveness::NotVeryEffective);
    }

    /// Kills: an impl that maps 10 to something other than Neutral.
    /// Starts red because `classify` is `todo!()`.
    #[test]

    fn classify_ten_is_neutral() {
        assert_eq!(TypeChart::classify(10), Effectiveness::Neutral);
    }

    /// Kills: an impl that maps 20 to Neutral or NVE.
    /// Starts red because `classify` is `todo!()`.
    #[test]

    fn classify_twenty_is_super_effective() {
        assert_eq!(TypeChart::classify(20), Effectiveness::SuperEffective);
    }

    // -----------------------------------------------------------------------
    // Light vs Dark / Dark vs Light — mutual super-effective
    // -----------------------------------------------------------------------

    /// Kills: an impl that makes Light/Dark one-way or neutral.
    /// Starts red because the stubs are `todo!()`.
    #[test]

    fn light_vs_dark_is_super_effective() {
        let chart = make_type_chart();
        assert_eq!(
            chart.effectiveness(Affinity::Light, Affinity::Dark),
            20,
            "Light vs Dark must be 20"
        );
    }

    /// Kills: an impl where only Light beats Dark but not the reverse.
    /// Starts red because the stubs are `todo!()`.
    #[test]

    fn dark_vs_light_is_super_effective() {
        let chart = make_type_chart();
        assert_eq!(
            chart.effectiveness(Affinity::Dark, Affinity::Light),
            20,
            "Dark vs Light must also be 20 (mutual)"
        );
    }

    // -----------------------------------------------------------------------
    // Property: effectiveness is total (never panics for any affinity pair)
    // -----------------------------------------------------------------------

    fn arb_affinity() -> impl Strategy<Value = Affinity> {
        prop_oneof![
            Just(Affinity::Fire),
            Just(Affinity::Water),
            Just(Affinity::Plant),
            Just(Affinity::Electric),
            Just(Affinity::Earth),
            Just(Affinity::Wind),
            Just(Affinity::Light),
            Just(Affinity::Dark),
        ]
    }

    /// Kills: an impl that panics on any Affinity combination.
    /// This test drives the property in a loop so we can use #[should_panic]
    /// on the whole test function (the proptest macro doesn't compose with
    /// #[should_panic] — see game-core-testing.md gotchas).
    /// Starts red because `effectiveness` is `todo!()`.
    #[test]

    fn effectiveness_is_total_known_pairs() {
        // Exercise all 64 (8×8) affinity pairs using the same chart fixture.
        // A correct implementation must never panic for any of them and must
        // return only values from {0, 5, 10, 20}.
        let chart = make_type_chart();
        let all = [
            Affinity::Fire,
            Affinity::Water,
            Affinity::Plant,
            Affinity::Electric,
            Affinity::Earth,
            Affinity::Wind,
            Affinity::Light,
            Affinity::Dark,
        ];
        for &att in &all {
            for &def in &all {
                let v = chart.effectiveness(att, def);
                assert!(
                    v == 0 || v == 5 || v == 10 || v == 20,
                    "effectiveness({att:?}, {def:?}) = {v} — not a valid value"
                );
            }
        }
    }

    /// Property: `effectiveness` is total for arbitrary pairs — proptest edition.
    /// Uses block-body form (vitest-fast-check guideline equivalent for proptest).
    /// Starts red because `effectiveness` is `todo!()`.
    proptest! {
        #[test]
        fn prop_effectiveness_is_total(
            attacker in arb_affinity(),
            defender in arb_affinity(),
        ) {
            let chart = make_type_chart();
            let v = chart.effectiveness(attacker, defender);
            prop_assert!(
                v == 0 || v == 5 || v == 10 || v == 20,
                "effectiveness value {v} is not one of {{0, 5, 10, 20}}"
            );
        }
    }
}
