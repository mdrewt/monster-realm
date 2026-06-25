//! monster-realm server module (SpacetimeDB).
//! Pure game logic lives in plain functions (unit-testable off-instance); tables
//! and reducers are added against your installed SpacetimeDB version.
//!
//! NOTE: the `#[table]` / `#[reducer]` macro syntax is VERSION-SPECIFIC (e.g. the
//! `name` form and table accessors differ across 2.x releases). Use the reference
//! sketch below as a starting point and confirm the exact spelling against your
//! installed version's Rust-module docs (see README). Keep rules pure so they can
//! be unit-tested without a running instance.

/// Pure movement rule — unit-testable without a running instance.
#[must_use]
pub fn clamp_position(v: i32, max: i32) -> i32 {
    v.clamp(-max, max)
}

// --- Reference sketch: uncomment and adjust to your SpacetimeDB version --------
// use spacetimedb::{reducer, table, Identity, ReducerContext, Table};
//
// #[table(name = player, public)]
// pub struct Player {
//     #[primary_key]
//     pub owner: Identity, // server identity (ctx.sender()), NEVER client-supplied
//     pub x: i32,
//     pub y: i32,
// }
//
// #[reducer]
// pub fn move_player(ctx: &ReducerContext, dx: i32, dy: i32) {
//     // SECURITY: act only on the caller's OWN player; client sends intent only.
//     let me = ctx.sender();
//     if let Some(p) = ctx.db.player().owner().find(me) {
//         ctx.db.player().owner().update(Player {
//             x: clamp_position(p.x + dx, 1000),
//             y: clamp_position(p.y + dy, 1000),
//             ..p
//         });
//     }
// }
// ------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::clamp_position;
    #[test]
    fn clamps_within_bounds() {
        assert_eq!(clamp_position(1500, 1000), 1000);
        assert_eq!(clamp_position(-1500, 1000), -1000);
        assert_eq!(clamp_position(42, 1000), 42);
    }
}
