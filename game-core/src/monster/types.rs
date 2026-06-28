//! Monster value types — the cross-boundary contract for individual monster
//! state. All types are pure data; no I/O, no clock, no RNG (ADR-0003).
//!
//! Ranges are enforced at construction (parse-don't-validate): `IVs` caps at 31,
//! `EVs` at 252/510, `Level` at [1,100]. Serde round-trips must preserve these
//! invariants — the property tests prove it.

use serde::{Deserialize, Serialize};

/// Elemental affinity (type) for monsters and skills.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum Affinity {
    Fire,
    Water,
    Plant,
    Electric,
    Earth,
    Wind,
    Light,
    Dark,
}

/// Which stat a modifier targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum StatKind {
    Hp,
    Attack,
    Defense,
    Speed,
    SpAttack,
    SpDefense,
}

/// The six combat stats, stored as plain u16 fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct StatBlock {
    pub hp: u16,
    pub attack: u16,
    pub defense: u16,
    pub speed: u16,
    pub sp_attack: u16,
    pub sp_defense: u16,
}

impl StatBlock {
    /// Read a single stat by kind.
    #[must_use]
    pub fn get(&self, kind: StatKind) -> u16 {
        match kind {
            StatKind::Hp => self.hp,
            StatKind::Attack => self.attack,
            StatKind::Defense => self.defense,
            StatKind::Speed => self.speed,
            StatKind::SpAttack => self.sp_attack,
            StatKind::SpDefense => self.sp_defense,
        }
    }

    /// Write a single stat by kind.
    pub fn set(&mut self, kind: StatKind, val: u16) {
        match kind {
            StatKind::Hp => self.hp = val,
            StatKind::Attack => self.attack = val,
            StatKind::Defense => self.defense = val,
            StatKind::Speed => self.speed = val,
            StatKind::SpAttack => self.sp_attack = val,
            StatKind::SpDefense => self.sp_defense = val,
        }
    }
}

const IV_MAX: u8 = 31;

/// Individual Values — genetic variance per stat, range [0, 31].
/// Fields are private; access via `get`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct IVs {
    hp: u8,
    attack: u8,
    defense: u8,
    speed: u8,
    sp_attack: u8,
    sp_defense: u8,
}

impl IVs {
    /// Construct IVs, rejecting any value above 31.
    ///
    /// # Errors
    /// Returns `Err` if any stat exceeds 31.
    pub fn new(
        hp: u8,
        attack: u8,
        defense: u8,
        speed: u8,
        sp_attack: u8,
        sp_defense: u8,
    ) -> Result<IVs, String> {
        let vals = [hp, attack, defense, speed, sp_attack, sp_defense];
        let names = [
            "hp",
            "attack",
            "defense",
            "speed",
            "sp_attack",
            "sp_defense",
        ];
        for (val, name) in vals.iter().zip(names.iter()) {
            if *val > IV_MAX {
                return Err(format!("IV {name} = {val} exceeds max {IV_MAX}"));
            }
        }
        Ok(IVs {
            hp,
            attack,
            defense,
            speed,
            sp_attack,
            sp_defense,
        })
    }

    /// Read a single IV by kind.
    #[must_use]
    pub fn get(&self, kind: StatKind) -> u8 {
        match kind {
            StatKind::Hp => self.hp,
            StatKind::Attack => self.attack,
            StatKind::Defense => self.defense,
            StatKind::Speed => self.speed,
            StatKind::SpAttack => self.sp_attack,
            StatKind::SpDefense => self.sp_defense,
        }
    }
}

impl<'de> Deserialize<'de> for IVs {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            hp: u8,
            attack: u8,
            defense: u8,
            speed: u8,
            sp_attack: u8,
            sp_defense: u8,
        }
        let raw = Raw::deserialize(deserializer)?;
        IVs::new(
            raw.hp,
            raw.attack,
            raw.defense,
            raw.speed,
            raw.sp_attack,
            raw.sp_defense,
        )
        .map_err(serde::de::Error::custom)
    }
}

pub(crate) const EV_PER_STAT_CAP: u16 = 252;
pub(crate) const EV_TOTAL_CAP: u16 = 510;

/// Effort Values — training gains per stat.
/// Per-stat cap: 252. Total cap: 510.
///
/// Uses a custom `Deserialize` so that deserialization enforces the same
/// invariants as `new()` — a bad serde payload cannot create an invalid `EVs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct EVs {
    hp: u16,
    attack: u16,
    defense: u16,
    speed: u16,
    sp_attack: u16,
    sp_defense: u16,
}

impl EVs {
    /// Construct EVs, rejecting per-stat > 252 or total > 510.
    ///
    /// # Errors
    /// Returns `Err` if any stat exceeds 252 or the total exceeds 510.
    pub fn new(
        hp: u16,
        attack: u16,
        defense: u16,
        speed: u16,
        sp_attack: u16,
        sp_defense: u16,
    ) -> Result<EVs, String> {
        let vals = [hp, attack, defense, speed, sp_attack, sp_defense];
        let names = [
            "hp",
            "attack",
            "defense",
            "speed",
            "sp_attack",
            "sp_defense",
        ];
        for (val, name) in vals.iter().zip(names.iter()) {
            if *val > EV_PER_STAT_CAP {
                return Err(format!(
                    "EV {name} = {val} exceeds per-stat cap {EV_PER_STAT_CAP}"
                ));
            }
        }
        let total: u16 = vals.iter().sum();
        if total > EV_TOTAL_CAP {
            return Err(format!("EV total {total} exceeds cap {EV_TOTAL_CAP}"));
        }
        Ok(EVs {
            hp,
            attack,
            defense,
            speed,
            sp_attack,
            sp_defense,
        })
    }

    /// All zeros — a fresh monster with no training.
    #[must_use]
    pub fn zero() -> EVs {
        EVs {
            hp: 0,
            attack: 0,
            defense: 0,
            speed: 0,
            sp_attack: 0,
            sp_defense: 0,
        }
    }

    /// Read a single EV by kind.
    #[must_use]
    pub fn get(&self, kind: StatKind) -> u16 {
        match kind {
            StatKind::Hp => self.hp,
            StatKind::Attack => self.attack,
            StatKind::Defense => self.defense,
            StatKind::Speed => self.speed,
            StatKind::SpAttack => self.sp_attack,
            StatKind::SpDefense => self.sp_defense,
        }
    }

    /// Sum of all six EVs.
    #[must_use]
    pub fn total(&self) -> u16 {
        self.hp + self.attack + self.defense + self.speed + self.sp_attack + self.sp_defense
    }
}

// Custom Deserialize for EVs — validates the per-stat and total caps so that
// a deserialized value can never violate the invariant (proof-of-teeth: test #27).
impl<'de> Deserialize<'de> for EVs {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        struct Raw {
            hp: u16,
            attack: u16,
            defense: u16,
            speed: u16,
            sp_attack: u16,
            sp_defense: u16,
        }
        let raw = Raw::deserialize(deserializer)?;
        EVs::new(
            raw.hp,
            raw.attack,
            raw.defense,
            raw.speed,
            raw.sp_attack,
            raw.sp_defense,
        )
        .map_err(serde::de::Error::custom)
    }
}

/// The 25 nature variants. Five are neutral (Hardy, Docile, Serious, Bashful,
/// Quirky); the other 20 each raise one stat and lower another (never HP).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum NatureKind {
    Hardy,
    Lonely,
    Brave,
    Adamant,
    Naughty,
    Bold,
    Docile,
    Relaxed,
    Impish,
    Lax,
    Timid,
    Hasty,
    Serious,
    Jolly,
    Naive,
    Modest,
    Mild,
    Quiet,
    Bashful,
    Rash,
    Calm,
    Gentle,
    Sassy,
    Careful,
    Quirky,
}

/// The ordered list of all 25 nature kinds, matching the 5×5 grid layout:
/// rows = raised stat (Attack, Defense, Speed, SpAttack, SpDefense),
/// columns = lowered stat (same order). Diagonal entries are neutral.
const ALL_NATURES: [NatureKind; 25] = [
    NatureKind::Hardy,
    NatureKind::Lonely,
    NatureKind::Brave,
    NatureKind::Adamant,
    NatureKind::Naughty,
    NatureKind::Bold,
    NatureKind::Docile,
    NatureKind::Relaxed,
    NatureKind::Impish,
    NatureKind::Lax,
    NatureKind::Timid,
    NatureKind::Hasty,
    NatureKind::Serious,
    NatureKind::Jolly,
    NatureKind::Naive,
    NatureKind::Modest,
    NatureKind::Mild,
    NatureKind::Quiet,
    NatureKind::Bashful,
    NatureKind::Rash,
    NatureKind::Calm,
    NatureKind::Gentle,
    NatureKind::Sassy,
    NatureKind::Careful,
    NatureKind::Quirky,
];

/// The five non-HP stats in nature-grid order (row = raised, col = lowered).
const NATURE_STATS: [StatKind; 5] = [
    StatKind::Attack,
    StatKind::Defense,
    StatKind::Speed,
    StatKind::SpAttack,
    StatKind::SpDefense,
];

/// A nature wrapper — provides modifier lookups for stat derivation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Nature {
    kind: NatureKind,
}

impl Nature {
    #[must_use]
    pub fn new(kind: NatureKind) -> Nature {
        Nature { kind }
    }

    #[must_use]
    pub fn kind(&self) -> NatureKind {
        self.kind
    }

    /// Index of this nature in the 5×5 grid (0..25).
    fn grid_index(&self) -> usize {
        ALL_NATURES
            .iter()
            .position(|n| *n == self.kind)
            .expect("NatureKind must be in ALL_NATURES")
    }

    /// Which stat this nature raises, or `None` for neutral natures.
    #[must_use]
    pub fn raised_stat(&self) -> Option<StatKind> {
        let idx = self.grid_index();
        let row = idx / 5;
        let col = idx % 5;
        if row == col {
            None // neutral
        } else {
            Some(NATURE_STATS[row])
        }
    }

    /// Which stat this nature lowers, or `None` for neutral natures.
    #[must_use]
    pub fn lowered_stat(&self) -> Option<StatKind> {
        let idx = self.grid_index();
        let row = idx / 5;
        let col = idx % 5;
        if row == col {
            None // neutral
        } else {
            Some(NATURE_STATS[col])
        }
    }

    /// `(numerator, denominator)` modifier for `stat`:
    /// - (11, 10) if raised
    /// - (9, 10) if lowered
    /// - (10, 10) otherwise (neutral nature or unaffected stat)
    #[must_use]
    pub fn stat_modifier(&self, stat: StatKind) -> (u16, u16) {
        if self.raised_stat() == Some(stat) {
            (11, 10)
        } else if self.lowered_stat() == Some(stat) {
            (9, 10)
        } else {
            (10, 10)
        }
    }

    /// Map an index to a `NatureKind` (wraps at 25).
    #[must_use]
    pub fn from_index(idx: u8) -> Nature {
        Nature {
            kind: ALL_NATURES[(idx % 25) as usize],
        }
    }
}

/// Bond — friendship/affection, full u8 range [0, 255].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Bond(u8);

impl Bond {
    #[must_use]
    pub fn new(val: u8) -> Bond {
        Bond(val)
    }

    /// The default starting bond for a newly obtained monster.
    #[must_use]
    pub fn default_bond() -> Bond {
        Bond(70)
    }

    #[must_use]
    pub fn value(&self) -> u8 {
        self.0
    }
}

/// Level — [1, 100].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
pub struct Level(u8);

impl Level {
    /// Construct a level, rejecting 0 or > 100.
    ///
    /// # Errors
    /// Returns `Err` if `val` is 0 or exceeds 100.
    pub fn new(val: u8) -> Result<Level, String> {
        if val == 0 {
            Err("level must be >= 1".to_string())
        } else if val > 100 {
            Err(format!("level {val} exceeds max 100"))
        } else {
            Ok(Level(val))
        }
    }

    #[must_use]
    pub fn as_u8(&self) -> u8 {
        self.0
    }
}

impl<'de> Deserialize<'de> for Level {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let val = u8::deserialize(deserializer)?;
        Level::new(val).map_err(serde::de::Error::custom)
    }
}

/// Experience points (absolute, not relative to current level).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Xp(u32);

impl Xp {
    #[must_use]
    pub fn new(val: u32) -> Xp {
        Xp(val)
    }

    #[must_use]
    pub fn value(&self) -> u32 {
        self.0
    }
}

/// An individual monster instance — the full state of a single creature owned
/// by a player.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonsterInstance {
    pub species_id: u32,
    pub nickname: Option<String>,
    pub level: Level,
    pub xp: Xp,
    pub ivs: IVs,
    pub nature: Nature,
    pub evs: EVs,
    pub bond: Bond,
    pub current_hp: u16,
    pub derived_stats: StatBlock,
    pub party_slot: Option<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // -----------------------------------------------------------------------
    // Helper: list of all six stat kinds for iteration
    // -----------------------------------------------------------------------
    const ALL_STATS: [StatKind; 6] = [
        StatKind::Hp,
        StatKind::Attack,
        StatKind::Defense,
        StatKind::Speed,
        StatKind::SpAttack,
        StatKind::SpDefense,
    ];

    // =======================================================================
    // Example-based tests
    // =======================================================================

    // --- IVs ---------------------------------------------------------------

    /// #1: IVs::new rejects any stat above 31.
    /// Kills: an impl that silently clamps or wraps instead of rejecting.
    #[test]
    fn iv_rejects_above_31() {
        assert!(IVs::new(32, 0, 0, 0, 0, 0).is_err());
        assert!(IVs::new(0, 0, 0, 0, 0, 32).is_err());
        assert!(IVs::new(0, 0, 0, 0, 32, 0).is_err());
    }

    /// #2: IVs::new accepts boundary values (0 and 31 are both valid).
    /// Kills: an impl that uses < 31 instead of <= 31.
    #[test]
    fn iv_accepts_boundary_values() {
        assert!(IVs::new(0, 31, 15, 0, 31, 0).is_ok());
    }

    /// #3: IVs::get returns the correct value for each stat kind.
    /// Kills: an impl that maps stat kinds to the wrong field.
    #[test]
    fn iv_get_returns_correct_stat() {
        let ivs = IVs::new(1, 2, 3, 4, 5, 6).unwrap();
        assert_eq!(ivs.get(StatKind::Hp), 1);
        assert_eq!(ivs.get(StatKind::Attack), 2);
        assert_eq!(ivs.get(StatKind::Defense), 3);
        assert_eq!(ivs.get(StatKind::Speed), 4);
        assert_eq!(ivs.get(StatKind::SpAttack), 5);
        assert_eq!(ivs.get(StatKind::SpDefense), 6);
    }

    // --- EVs ---------------------------------------------------------------

    /// #4: EVs::new rejects per-stat values above 252.
    /// Kills: an impl that only checks the total but not per-stat.
    #[test]
    fn ev_rejects_per_stat_above_252() {
        assert!(EVs::new(253, 0, 0, 0, 0, 0).is_err());
        assert!(EVs::new(0, 253, 0, 0, 0, 0).is_err());
    }

    /// #5: EVs::new rejects total above 510.
    /// Kills: an impl that only checks per-stat but not the sum.
    #[test]
    fn ev_rejects_total_above_510() {
        // 252 + 252 + 100 = 604 > 510
        assert!(EVs::new(252, 252, 100, 0, 0, 0).is_err());
    }

    /// #6: EVs::new accepts the exact boundary (total = 510, each <= 252).
    /// Kills: an impl that uses < 510 instead of <= 510.
    #[test]
    fn ev_accepts_boundary() {
        let evs = EVs::new(252, 252, 6, 0, 0, 0);
        assert!(evs.is_ok());
        assert_eq!(evs.unwrap().total(), 510);
    }

    /// #7: EVs::zero() yields total == 0.
    /// Kills: an impl that initializes with non-zero defaults.
    #[test]
    fn ev_zero_is_all_zeros() {
        let evs = EVs::zero();
        assert_eq!(evs.total(), 0);
        for kind in ALL_STATS {
            assert_eq!(evs.get(kind), 0);
        }
    }

    // --- Level -------------------------------------------------------------

    /// #8: Level::new rejects 0.
    /// Kills: an impl that allows level 0.
    #[test]
    fn level_rejects_zero() {
        assert!(Level::new(0).is_err());
    }

    /// #9: Level::new rejects 101+.
    /// Kills: an impl that allows levels above 100.
    #[test]
    fn level_rejects_above_100() {
        assert!(Level::new(101).is_err());
        assert!(Level::new(255).is_err());
    }

    /// #10: Level::new accepts the boundaries 1 and 100.
    /// Kills: an impl with off-by-one on the range.
    #[test]
    fn level_accepts_boundaries() {
        let l1 = Level::new(1);
        assert!(l1.is_ok());
        assert_eq!(l1.unwrap().as_u8(), 1);

        let l100 = Level::new(100);
        assert!(l100.is_ok());
        assert_eq!(l100.unwrap().as_u8(), 100);
    }

    // --- Nature ------------------------------------------------------------

    /// #11: Neutral natures return None for raised/lowered.
    /// Kills: an impl that returns Some for neutral natures.
    #[test]
    fn nature_neutral_returns_none_for_raised_lowered() {
        let neutral_kinds = [
            NatureKind::Hardy,
            NatureKind::Docile,
            NatureKind::Serious,
            NatureKind::Bashful,
            NatureKind::Quirky,
        ];
        for kind in neutral_kinds {
            let n = Nature::new(kind);
            assert_eq!(n.raised_stat(), None, "{kind:?} should be neutral (raised)");
            assert_eq!(
                n.lowered_stat(),
                None,
                "{kind:?} should be neutral (lowered)"
            );
        }
    }

    /// #12: Adamant raises Attack and lowers SpAttack.
    /// Kills: an impl that maps the nature table incorrectly.
    #[test]
    fn nature_non_neutral_returns_correct_pair() {
        let adamant = Nature::new(NatureKind::Adamant);
        assert_eq!(adamant.raised_stat(), Some(StatKind::Attack));
        assert_eq!(adamant.lowered_stat(), Some(StatKind::SpAttack));

        // Also check a few more for coverage
        let bold = Nature::new(NatureKind::Bold);
        assert_eq!(bold.raised_stat(), Some(StatKind::Defense));
        assert_eq!(bold.lowered_stat(), Some(StatKind::Attack));

        let timid = Nature::new(NatureKind::Timid);
        assert_eq!(timid.raised_stat(), Some(StatKind::Speed));
        assert_eq!(timid.lowered_stat(), Some(StatKind::Attack));

        let modest = Nature::new(NatureKind::Modest);
        assert_eq!(modest.raised_stat(), Some(StatKind::SpAttack));
        assert_eq!(modest.lowered_stat(), Some(StatKind::Attack));

        let calm = Nature::new(NatureKind::Calm);
        assert_eq!(calm.raised_stat(), Some(StatKind::SpDefense));
        assert_eq!(calm.lowered_stat(), Some(StatKind::Attack));
    }

    /// #13: Neutral nature returns (10, 10) for any stat.
    /// Kills: an impl that returns wrong modifier fractions for neutral.
    #[test]
    fn nature_stat_modifier_neutral() {
        let hardy = Nature::new(NatureKind::Hardy);
        for kind in ALL_STATS {
            assert_eq!(
                hardy.stat_modifier(kind),
                (10, 10),
                "Hardy should be (10,10) for {kind:?}"
            );
        }
    }

    /// #14: Adamant returns (11, 10) for Attack.
    /// Kills: an impl that returns the wrong raised modifier.
    #[test]
    fn nature_stat_modifier_raised() {
        let adamant = Nature::new(NatureKind::Adamant);
        assert_eq!(adamant.stat_modifier(StatKind::Attack), (11, 10));
    }

    /// #15: Adamant returns (9, 10) for SpAttack.
    /// Kills: an impl that returns the wrong lowered modifier.
    #[test]
    fn nature_stat_modifier_lowered() {
        let adamant = Nature::new(NatureKind::Adamant);
        assert_eq!(adamant.stat_modifier(StatKind::SpAttack), (9, 10));
    }

    /// #16: Adamant returns (10, 10) for Hp (unaffected stat).
    /// Kills: an impl that applies nature modifier to HP.
    #[test]
    fn nature_stat_modifier_unaffected() {
        let adamant = Nature::new(NatureKind::Adamant);
        assert_eq!(adamant.stat_modifier(StatKind::Hp), (10, 10));
        assert_eq!(adamant.stat_modifier(StatKind::Defense), (10, 10));
        assert_eq!(adamant.stat_modifier(StatKind::Speed), (10, 10));
        assert_eq!(adamant.stat_modifier(StatKind::SpDefense), (10, 10));
    }

    /// #17: from_index at boundaries (0, 24) produces valid natures.
    /// Kills: an impl with off-by-one on the index mapping.
    #[test]
    fn nature_from_index_boundary() {
        let n0 = Nature::from_index(0);
        let n24 = Nature::from_index(24);
        // They should be different natures (first and last)
        assert_ne!(n0.kind(), n24.kind());
    }

    /// #18: from_index wraps at 25 (idx 25 == idx 0).
    /// Kills: an impl that panics or returns different results past 24.
    #[test]
    fn nature_from_index_wraps_at_25() {
        assert_eq!(Nature::from_index(25).kind(), Nature::from_index(0).kind());
        assert_eq!(Nature::from_index(50).kind(), Nature::from_index(0).kind());
        assert_eq!(Nature::from_index(26).kind(), Nature::from_index(1).kind());
    }

    // --- Bond --------------------------------------------------------------

    /// #19: default_bond is 70.
    /// Kills: an impl with a wrong default bond value.
    #[test]
    fn bond_default_is_70() {
        assert_eq!(Bond::default_bond().value(), 70);
    }

    // --- StatBlock ---------------------------------------------------------

    /// #20: get/set round-trip for each stat kind.
    /// Kills: an impl where get and set target different fields.
    #[test]
    fn statblock_get_set_roundtrip() {
        let mut sb = StatBlock {
            hp: 0,
            attack: 0,
            defense: 0,
            speed: 0,
            sp_attack: 0,
            sp_defense: 0,
        };
        let values = [100u16, 200, 300, 400, 500, 600];
        for (kind, &val) in ALL_STATS.iter().zip(values.iter()) {
            sb.set(*kind, val);
            assert_eq!(sb.get(*kind), val, "set then get for {kind:?} should match");
        }
        // Verify all are still correct (no overwrites)
        assert_eq!(sb.get(StatKind::Hp), 100);
        assert_eq!(sb.get(StatKind::Attack), 200);
        assert_eq!(sb.get(StatKind::Defense), 300);
        assert_eq!(sb.get(StatKind::Speed), 400);
        assert_eq!(sb.get(StatKind::SpAttack), 500);
        assert_eq!(sb.get(StatKind::SpDefense), 600);
    }

    // =======================================================================
    // Property-based tests
    // =======================================================================

    // Proptest strategy for valid IVs (each in [0, 31])
    fn arb_ivs() -> impl Strategy<Value = IVs> {
        (0u8..=31, 0u8..=31, 0u8..=31, 0u8..=31, 0u8..=31, 0u8..=31).prop_map(
            |(hp, atk, def, spd, spa, spd2)| IVs::new(hp, atk, def, spd, spa, spd2).unwrap(),
        )
    }

    // Proptest strategy for valid EVs (each <= 252, total <= 510)
    fn arb_evs() -> impl Strategy<Value = EVs> {
        // Generate six values in [0, 252], then reject if total > 510
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
            .prop_map(|(hp, atk, def, spd, spa, spd2)| {
                EVs::new(hp, atk, def, spd, spa, spd2).unwrap()
            })
    }

    fn arb_statblock() -> impl Strategy<Value = StatBlock> {
        (
            any::<u16>(),
            any::<u16>(),
            any::<u16>(),
            any::<u16>(),
            any::<u16>(),
            any::<u16>(),
        )
            .prop_map(|(hp, atk, def, spd, spa, spd2)| StatBlock {
                hp,
                attack: atk,
                defense: def,
                speed: spd,
                sp_attack: spa,
                sp_defense: spd2,
            })
    }

    fn arb_nature() -> impl Strategy<Value = Nature> {
        (0u8..25).prop_map(Nature::from_index)
    }

    proptest! {
        /// #21: IVs serde round-trip (RON).
        /// Kills: a serde impl that loses data or changes field order.
        #[test]
        fn ivs_serde_round_trip(ivs in arb_ivs()) {
            let s = ron::to_string(&ivs).unwrap();
            let back: IVs = ron::from_str(&s).unwrap();
            prop_assert_eq!(ivs, back);
        }

        /// #22: EVs serde round-trip (RON).
        /// Kills: a serde impl that loses data or changes field order.
        #[test]
        fn evs_serde_round_trip(evs in arb_evs()) {
            let s = ron::to_string(&evs).unwrap();
            let back: EVs = ron::from_str(&s).unwrap();
            prop_assert_eq!(evs, back);
        }

        /// #23: StatBlock serde round-trip (RON).
        #[test]
        fn statblock_serde_round_trip(sb in arb_statblock()) {
            let s = ron::to_string(&sb).unwrap();
            let back: StatBlock = ron::from_str(&s).unwrap();
            prop_assert_eq!(sb, back);
        }

        /// #24: Nature serde round-trip (RON).
        #[test]
        fn nature_serde_round_trip(n in arb_nature()) {
            let s = ron::to_string(&n).unwrap();
            let back: Nature = ron::from_str(&s).unwrap();
            prop_assert_eq!(n, back);
        }

        /// #25: For all valid IVs, every stat is in [0, 31].
        /// Kills: an impl that lets construction succeed with out-of-range values.
        #[test]
        fn ivs_invariant(ivs in arb_ivs()) {
            for kind in ALL_STATS {
                prop_assert!(ivs.get(kind) <= 31, "IV for {kind:?} exceeds 31");
            }
        }

        /// #26: For all valid EVs, every stat <= 252 and total <= 510.
        /// Kills: an impl that lets construction succeed with invalid EVs.
        #[test]
        fn evs_invariant(evs in arb_evs()) {
            let mut total = 0u16;
            for kind in ALL_STATS {
                let v = evs.get(kind);
                prop_assert!(v <= 252, "EV for {kind:?} exceeds 252");
                total += v;
            }
            prop_assert!(total <= 510, "EV total {total} exceeds 510");
        }
    }

    /// #27: Proof-of-teeth — deserializing EVs with total > 510 should fail.
    /// If EVs uses naive derive(Deserialize) without validation, this catches it.
    /// A correct impl uses a custom Deserialize that validates the caps.
    #[test]
    fn evs_deserialize_rejects_invalid() {
        // 252 * 6 = 1512, which violates the 510 total cap
        let bad_ron =
            "(hp: 252, attack: 252, defense: 252, speed: 252, sp_attack: 252, sp_defense: 252)";
        let result = ron::from_str::<EVs>(bad_ron);
        assert!(
            result.is_err(),
            "deserializing EVs with total 1512 should fail, but got {result:?}"
        );
    }
}
