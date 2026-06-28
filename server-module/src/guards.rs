//! `guards` — server-module domain submodule (M8.9, ADR-0056).
//!
//! SCAFFOLD (M8.9a): intentionally empty. M8.9b ("the move") relocates the
//! validation/authorization helpers out of `lib.rs` into here:
//!   log_reject, validate_name, authorize_move, check_party_size,
//!   check_monster_in_party, check_team_coupling,
//!   and a NEW `require_owner(ctx, reducer, owner) -> Result<(), String>`
//!   consolidating the repeated `owner != ctx.sender` rejection preamble
//!   (pure de-dup; identical reject + `log_reject` behavior).
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable; renaming invalidates downstream `touches:` sets.
