//! Multi-wild encounter generation — design §3.4: the pack-size roll, the clamp, the per-wild seed
//! derivation, the map pick and the `spawn_b` placement.
//!
//! Everything here is a pure function of the ONE encounter seed the server already draws
//! (`ctx.random()`, a u32 — widened to u64 by the shell) plus content parameters that bt-6 joins
//! (`pack_weights`, `battle_map_pool`). Species and levels per slot stay with the carried pool
//! rules (`taming::rules`); this module exposes no species or level API. Reject, never clamp — except
//! the design's own clamp `effective = min(rolled, 3, conscious_party_count)`, which is the rule.
//! Every modulus is taken in u64 and narrowed afterwards: the server runs on wasm32.

use serde::{Deserialize, Serialize};

use super::geometry::Cell;
use super::map::BattleMapDef;
use super::resolve::splitmix64;

/// The most wilds an encounter fields (design §3.4 `min(rolled, 3, …)`; every validated map has
/// three `spawn_b` slots).
pub const MAX_PACK: u8 = 3;

/// The per-mille scale the weights are expressed in (the carried `roll % 1000 < threshold` idiom).
const PER_MILLE: u32 = 1000;

/// Per-mille pack-size weights (the zone's `pack_weights`, bt-6). Must sum to 1000.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackWeights {
    pub one: u16,
    pub two: u16,
    pub three: u16,
}

impl PackWeights {
    /// The design default: 1 → 600 ‰, 2 → 300 ‰, 3 → 100 ‰.
    pub const DEFAULT: PackWeights = PackWeights {
        one: 600,
        two: 300,
        three: 100,
    };

    /// The weights must sum to exactly 1000 (u32 sum — a u16 sum could wrap to 1000).
    ///
    /// # Errors
    /// [`EncounterError::BadWeights`] with the actual sum.
    pub fn validate(&self) -> Result<(), EncounterError> {
        let sum = u32::from(self.one) + u32::from(self.two) + u32::from(self.three);
        if sum == PER_MILLE {
            Ok(())
        } else {
            Err(EncounterError::BadWeights { sum })
        }
    }
}

/// Why an encounter cannot be generated. Checked in declaration order by [`generate_encounter`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EncounterError {
    /// `pack_weights` do not sum to 1000.
    BadWeights { sum: u32 },
    /// `battle_map_pool` is empty.
    EmptyMapPool,
    /// No conscious party member: there is nobody to field.
    NoConsciousParty,
    /// A rolled pack of zero is not a pack.
    BadPackSize { rolled: u8 },
    /// The map has fewer `spawn_b` slots than the pack.
    SpawnSlots { got: usize, want: u8 },
}

/// Roll the pack size from the encounter seed: `r = encounter_seed % 1000` against the cumulative
/// per-mille thresholds — `r < one` → 1, `r < one + two` → 2, else 3 (the carried `roll % 1000 <
/// threshold` idiom).
///
/// # Errors
/// [`PackWeights::validate`]'s.
pub fn roll_pack_size(weights: &PackWeights, encounter_seed: u64) -> Result<u8, EncounterError> {
    weights.validate()?;
    let r = encounter_seed % u64::from(PER_MILLE);
    if r < u64::from(weights.one) {
        Ok(1)
    } else if r < u64::from(weights.one) + u64::from(weights.two) {
        Ok(2)
    } else {
        Ok(3)
    }
}

/// Design §3.4: `min(rolled, MAX_PACK, conscious_party_count)`.
///
/// # Errors
/// `conscious_party_count == 0` → [`EncounterError::NoConsciousParty`]; then `rolled == 0` →
/// [`EncounterError::BadPackSize`].
pub fn effective_pack(rolled: u8, conscious_party_count: u8) -> Result<u8, EncounterError> {
    if conscious_party_count == 0 {
        return Err(EncounterError::NoConsciousParty);
    }
    if rolled == 0 {
        return Err(EncounterError::BadPackSize { rolled });
    }
    Ok(rolled.min(MAX_PACK).min(conscious_party_count))
}

/// Wild `index`'s individuality seed: `splitmix64(encounter_seed ^ index) as u32` (truncating) —
/// what `roll_individuality` rebuilds that exact wild from at recruit.
#[must_use]
pub fn wild_seed(encounter_seed: u64, index: u8) -> u32 {
    // The truncating cast IS the rule (design §3.4): the low 32 bits.
    (splitmix64(encounter_seed ^ u64::from(index)) & 0xFFFF_FFFF) as u32
}

/// The pool index of the battle map: `encounter_seed % pool_len`, computed in u64 and narrowed
/// afterwards (the server runs on wasm32).
///
/// # Errors
/// `pool_len == 0` → [`EncounterError::EmptyMapPool`].
pub fn pick_map_index(pool_len: usize, encounter_seed: u64) -> Result<usize, EncounterError> {
    // Neither conversion can fail on a supported target (`usize` is at most 64 bits, and
    // `encounter_seed % len < len`); both are mapped onto the pool's one error rather than a panic.
    let len = u64::try_from(pool_len).map_err(|_| EncounterError::EmptyMapPool)?;
    if len == 0 {
        return Err(EncounterError::EmptyMapPool);
    }
    usize::try_from(encounter_seed % len).map_err(|_| EncounterError::EmptyMapPool)
}

/// The wilds' tiles: `map.spawn_b[..pack]` in slot order (wild `i` deploys on side-B slot `i`).
///
/// # Errors
/// Fewer `spawn_b` slots than `pack` → [`EncounterError::SpawnSlots`].
pub fn spawn_tiles(map: &BattleMapDef, pack: u8) -> Result<Vec<Cell>, EncounterError> {
    let want = usize::from(pack);
    if map.spawn_b.len() < want {
        return Err(EncounterError::SpawnSlots {
            got: map.spawn_b.len(),
            want: pack,
        });
    }
    Ok(map.spawn_b[..want].to_vec())
}

/// A generated encounter: the picked map and one individuality seed per wild. `seeds.len()` is the
/// effective pack; `seeds[i]` and `spawn_tiles(map, pack)[i]` belong to side-B deploy slot `i`
/// (whose planner `spawn` is `spawn_b[i]`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Encounter {
    pub map_index: usize,
    pub seeds: Vec<u32>,
}

/// The whole generation, first failure wins in [`EncounterError`] order: validate the weights →
/// pick the map → roll the pack → clamp → derive the seeds for `0..pack`.
///
/// # Errors
/// See [`EncounterError`].
pub fn generate_encounter(
    weights: &PackWeights,
    pool_len: usize,
    encounter_seed: u64,
    conscious_party_count: u8,
) -> Result<Encounter, EncounterError> {
    // Validated here first so `BadWeights` precedes `EmptyMapPool` (declaration order); the roll
    // validates again, harmlessly.
    weights.validate()?;
    let map_index = pick_map_index(pool_len, encounter_seed)?;
    let rolled = roll_pack_size(weights, encounter_seed)?;
    let pack = effective_pack(rolled, conscious_party_count)?;
    let seeds = (0..pack).map(|i| wild_seed(encounter_seed, i)).collect();
    Ok(Encounter { map_index, seeds })
}
