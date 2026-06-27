//! Taming value types — encounter tables and entries.
//! All types are pure data; no I/O, no clock, no RNG (ADR-0003).

use serde::Deserialize;

use crate::monster::types::Level;

/// A single entry in an encounter table — one spawnable species with weight
/// and level range.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EncounterEntry {
    pub species_id: u32,
    pub weight: u16,
    pub min_level: Level,
    pub max_level: Level,
}

/// A per-zone encounter table. `encounter_rate` is per-mille [0, 1000];
/// `entries` are the weighted species pool for that zone.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct EncounterTable {
    pub zone_id: u32,
    /// Per-mille encounter rate [0, 1000].
    pub encounter_rate: u16,
    pub entries: Vec<EncounterEntry>,
}

/// The deterministic result of resolving a grass step into a wild spawn. The
/// `individuality_seed` is a stable sub-roll of the INPUT seed (M8d rebuilds the
/// exact wild via `roll_individuality(individuality_seed)`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WildSpawn {
    pub species_id: u32,
    pub level: Level,
    pub individuality_seed: u32,
}
