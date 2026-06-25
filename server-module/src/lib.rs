//! monster-realm server module (SpacetimeDB).
//!
//! The imperative shell: tables + reducers that validate `ctx.sender` + legality,
//! delegate the rule to `game-core` (the SSOT), and write tables — rejecting with
//! `Err`, never silently clamping. Tables/reducers are added at M2 against the
//! pinned SpacetimeDB version (the `#[table]`/`#[reducer]` macro syntax is
//! version-specific — confirm against the installed CLI 2.6.0).
//!
//! Pure rules do NOT live here; they live once in `game-core`.

/// Re-export the pure movement helper from the one rule layer, so the server
/// uses the SAME code the client predicts with.
pub use game_core::clamp_position;

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
