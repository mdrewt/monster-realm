//! `content` — server-module domain submodule (M8.9, ADR-0056).
//!
//! SCAFFOLD (M8.9a): intentionally empty. M8.9b ("the move") relocates the
//! content-sync logic out of `lib.rs` into here:
//!   sync_content_inner + its per-registry seeding helpers.
//! `lib.rs` keeps the thin `sync_content` lifecycle reducer wrapper.
//!
//! Independent of workstream B (M8.9e, `game-core` content glob loading): this
//! `content.rs` is the SERVER seed-from-game-core path, not the game-core RON
//! loader.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable; renaming invalidates downstream `touches:` sets.
