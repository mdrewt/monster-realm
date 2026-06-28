//! `schema` — server-module domain submodule (M8.9, ADR-0056).
//!
//! SCAFFOLD (M8.9a): intentionally empty. M8.9b ("the move") relocates the
//! data `#[spacetimedb::table]` structs + their row types out of `lib.rs` into
//! here, behavior-preserving (byte-identical bindings + schema snapshot):
//!   character, player, config, zone_def, species_row, skill_row,
//!   type_relation_row, item_row, EncounterEntryRow, encounter, monster,
//!   monster_pub, battle, battle_wild, inventory.
//!
//! Exception (ADR-0056 / spec §6 macro hygiene): the `movement_tick_schedule`
//! scheduled table stays with its `movement_tick` reducer in `movement.rs` so
//! the `scheduled(movement_tick)` reference resolves.
//!
//! The M8.9a spike PROVED a `#[table]`/`#[reducer]` registers from a (private)
//! submodule with byte-identical bindings (see docs/validation-findings.md).
//! Cross-module `ctx.db.<table>()` callers must import the generated snake_case
//! accessor trait (e.g. `use crate::schema::config;`).
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable; renaming invalidates downstream `touches:` sets.
