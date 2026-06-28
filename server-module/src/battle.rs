//! `battle` — server-module domain submodule (M8.9, ADR-0056).
//!
//! NOT YET WIRED (M8.9a): there is deliberately no `mod battle;` in `lib.rs`.
//! The `#[table(name = battle)]` macro generates a crate-root trait `battle`,
//! and a `mod battle;` would collide with it (E0428) while that table lives in
//! `lib.rs`. M8.9b adds `mod battle;` atomically with moving the `battle` table
//! into `schema.rs` (which frees the `battle` identifier at the crate root).
//! This file exists as a scaffold so 9b has its target.
//!
//! SCAFFOLD (M8.9a): intentionally empty. M8.9b ("the move") relocates the
//! ~900-line battle cluster out of `lib.rs` into here:
//!   start_battle, start_wild_battle, submit_attack, swap_active, flee,
//!   heal_party (reducers) + begin_encounter, lead_party, write_back_party_hp,
//!   write_back_battle_results (helpers).
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable; renaming invalidates downstream `touches:` sets.
