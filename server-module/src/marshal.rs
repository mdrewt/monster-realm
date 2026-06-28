//! `marshal` — server-module domain submodule (M8.9, ADR-0056).
//!
//! SCAFFOLD (M8.9a): intentionally empty. M8.9b ("the move") relocates the
//! row <-> `game-core` domain marshaling helpers out of `lib.rs` into here:
//!   char_state, apply_state, monster_from_instance, pub_from_monster,
//!   battle_monster_from_row, write_back_hp, encounter_rows_from_table,
//!   table_from_encounter_row, skill_defs_from_rows, type_chart_from_rows,
//!   loser_base_stat_total, wild_battle_monster.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable; renaming invalidates downstream `touches:` sets.
