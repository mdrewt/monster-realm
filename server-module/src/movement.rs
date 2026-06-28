//! `movement` — server-module domain submodule (M8.9, ADR-0056).
//!
//! SCAFFOLD (M8.9a): intentionally empty. M8.9b ("the move") relocates the
//! movement reducers out of `lib.rs` into here:
//!   join_game, enqueue_move, set_move, clear_queue, movement_tick.
//!
//! ADR-0056 / spec §6 macro hygiene: the `movement_tick_schedule` scheduled
//! `#[table]` also lives HERE (not in `schema.rs`) so the
//! `scheduled(movement_tick)` attribute reference resolves within the module.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable; renaming invalidates downstream `touches:` sets.
