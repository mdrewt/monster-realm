//! `ranking` — server-module domain submodule (M17, ADR-0119).
//!
//! Persistent ranked-ladder progression: the total `profile` find-or-insert
//! seam (`get_or_init_profile`) and the single rating-application entry point
//! (`apply_pvp_rating`, called ONLY from the `settle_pvp_battle` funnel in
//! pvp.rs — RL-10). The `profile` table is module-write-only (ADR-0119 D6):
//! this module declares NO reducers, so no client-callable path can write
//! rating/wins/losses. Rating arithmetic lives in `game_core::ranking` (the
//! functional core); this shell only reads and writes rows.
//!
//! This file name extends the canonical `touches:` vocabulary fixed by
//! ADR-0056 (M8.9) — keep it stable.

use crate::schema::{player, profile, Battle, Profile};
use game_core::BattleOutcome;
use spacetimedb::{Identity, ReducerContext, Table};

/// Find-or-insert the `profile` row for `identity` — the total seam that
/// makes the rating path infallible (ADR-0119 D1, RL-1).
///
/// Existing rows get a passive display-name refresh (ADR-0125): the `Some`
/// arm composes `refresh_profile_name` over `live_player_name`, so the
/// returned value carries the live `player.name` whenever the presence row
/// still exists. The refresh is in-memory ONLY — this seam performs no
/// write for existing rows; persistence rides `apply_pvp_rating`'s two
/// `..winner`/`..loser` update spreads, so a rename surfaces on the next
/// rated game. When the player row is absent (disconnect race), the profile
/// keeps its last-known name.
///
/// New rows seed `rating` from `game_core::INITIAL_RATING` (the SSOT, never
/// the bare literal), zero W/L, and the display name from the same
/// `live_player_name` helper (`unwrap_or_default()` → empty string is a
/// defensive fallback only: all three decisive paths run before
/// `on_disconnect` deletes the player row, so the name seeds correctly even
/// on disconnect-forfeit).
pub(crate) fn get_or_init_profile(ctx: &ReducerContext, identity: Identity) -> Profile {
    match ctx.db.profile().identity().find(identity) {
        Some(existing) => refresh_profile_name(existing, live_player_name(ctx, identity)),
        None => {
            let name = live_player_name(ctx, identity).unwrap_or_default();
            ctx.db.profile().insert(Profile {
                identity,
                name,
                rating: game_core::INITIAL_RATING,
                wins: 0,
                losses: 0,
            })
        }
    }
}

/// Pure core of the passive name mirror (ADR-0125 D1): return `profile` with
/// `name` replaced when a live name is present, unchanged otherwise.
///
/// `None` → keep the last-known name (disconnect race: the counterparty's
/// `player` row can already be deleted by the time a rating settles). Never
/// clobbers with a default on `None`. In-memory only — no caller writes the
/// result here (no-eager-write rule); persistence rides `apply_pvp_rating`'s
/// existing update spreads.
fn refresh_profile_name(profile: Profile, live_name: Option<String>) -> Profile {
    match live_name {
        Some(n) => Profile { name: n, ..profile },
        None => profile,
    }
}

/// Live display name from the `player` presence row, if it still exists
/// (ADR-0125 D3). The single inline `.map` chain is deliberately None-safe
/// for the disconnect race — never `.unwrap()` here — and stays a chained
/// expression with no split-binding, per the RL-2 style convention.
fn live_player_name(ctx: &ReducerContext, identity: Identity) -> Option<String> {
    ctx.db.player().identity().find(identity).map(|p| p.name)
}

/// Apply the ranked-ladder rating for a decided PvP battle (ADR-0119 D6, RL-5).
///
/// Infallible by construction (returns `()`): `get_or_init_profile` is total,
/// and both new ratings come from ONE `compute_rating_update` call BEFORE
/// either row write, so a partial (zero-sum-breaking) write is
/// unrepresentable. No-op (early return) unless the battle is ranked PvP
/// (`guards::is_ranked_pvp` — wild and practice self-battles never rate,
/// RL-6) AND the outcome is decisive. Profile rows are updated in place,
/// NEVER deleted (RL-2).
pub(crate) fn apply_pvp_rating(ctx: &ReducerContext, battle: &Battle) {
    if !crate::guards::is_ranked_pvp(battle) {
        return;
    }
    // Exhaustive on purpose: a future BattleOutcome variant must decide here
    // whether it rates (compile error, not a silent skip).
    let (winner_id, loser_id) = match battle.state.outcome {
        BattleOutcome::SideAWins => (battle.player_identity, battle.opponent_identity),
        BattleOutcome::SideBWins => (battle.opponent_identity, battle.player_identity),
        // Ongoing is unreachable via settle_pvp_battle (called only after a
        // decisive outcome commits) but safe to no-op; Fled is a legitimate
        // non-decisive terminal that never rates (RL-8).
        BattleOutcome::Ongoing | BattleOutcome::Fled => return,
    };
    let winner = get_or_init_profile(ctx, winner_id);
    let loser = get_or_init_profile(ctx, loser_id);
    // ONE compute for both rows, before any write (compute-before-write, D6).
    let (new_winner_rating, new_loser_rating) =
        game_core::compute_rating_update(winner.rating, loser.rating);
    // Saturating counters: the cap is unreachable (u32::MAX games) but keeps
    // the increment panic-free, mirroring the rating field's saturating policy.
    ctx.db.profile().identity().update(Profile {
        rating: new_winner_rating,
        wins: winner.wins.saturating_add(1),
        ..winner
    });
    ctx.db.profile().identity().update(Profile {
        rating: new_loser_rating,
        losses: loser.losses.saturating_add(1),
        ..loser
    });
}

#[cfg(test)]
#[path = "ranking_tests.rs"]
mod ranking_tests;
