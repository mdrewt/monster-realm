//! `ranking` — server-module domain submodule (M17, ADR-0119).
//!
//! Persistent ranked-ladder progression: the total `profile` find-or-insert
//! seam (`get_or_init_profile`) and the single rating-application entry point
//! (`apply_pvp_rating`, called ONLY from the `settle_pvp_battle` funnel in
//! pvp.rs — RL-10). The `profile` table is module-write-only (ADR-0119 D6):
//! this module declares exactly one reducer, `set_profile_name` (ADR-0132),
//! which writes only `player.name`; `profile` rating/wins/losses stay
//! module-write-only via `apply_pvp_rating` (no client-callable path writes
//! them). The rename surfaces on the leaderboard on the caller's next rated
//! game via the ADR-0125 passive mirror. Rating arithmetic lives in
//! `game_core::ranking` (the
//! functional core); this shell only reads and writes rows. Private helpers
//! `refresh_profile_name` + `live_player_name` implement the passive
//! display-name mirror (ADR-0125) and are exercised directly by
//! ranking_tests.rs via `super::`.
//!
//! This file name extends the canonical `touches:` vocabulary fixed by
//! ADR-0056 (M8.9) — keep it stable.

use crate::guards::{log_reject, validate_name};
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

/// Rename the caller's display name (ADR-0132 D1). The single client-callable
/// reducer in this module — it is **profile-untouching**: it validates the name
/// with `guards::validate_name` (the exact SSOT rules as `join_game`,
/// reject-not-clamp) and writes ONLY `player.name`, the display-name SSOT. The
/// rename surfaces on the public leaderboard on the caller's next rated game via
/// the ADR-0125 passive mirror (`live_player_name` → `apply_pvp_rating`'s update
/// spreads) — no direct `profile` write here, so the `profile`-write-only
/// invariant (ADR-0119 D6) is preserved.
///
/// Rejects `"not joined"` when the caller has no `player` row; rejects with the
/// validation error (no write) when the name is invalid. The `match` form (not a
/// `let Some(..) = ctx.db.player()` split-binding) mirrors `get_or_init_profile`
/// and keeps the RL-2 split-binding pins green.
#[spacetimedb::reducer]
pub fn set_profile_name(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let me = ctx.sender;
    let mut player = match ctx.db.player().identity().find(me) {
        Some(p) => p,
        None => {
            let e = "not joined".to_string();
            log_reject("set_profile_name", me, &e);
            return Err(e);
        }
    };
    let validated = validate_name(&name).inspect_err(|e| log_reject("set_profile_name", me, e))?;
    player.name = validated;
    ctx.db.player().identity().update(player);
    Ok(())
}

// --- M21 guest→account profile re-key (ADR-0179 D6, AUTH-23/25) ---------------

/// Tombstone name for a claimed guest's retained (never-deleted) `profile` row.
/// 15 chars ≤ `MAX_NAME_LEN` (24). Deliberately UN-TYPABLE: the parentheses are
/// not alphanumeric, so `guards::validate_name` rejects it — no player can mint a
/// name impersonating a tombstone.
pub(crate) const PROFILE_TOMBSTONE_NAME: &str = "(claimed guest)";

/// Copy `rating`/`wins`/`losses` onto `dest`, preserving its identity and name.
/// Pure seam (unit-testable without a `ReducerContext`).
pub(crate) fn profile_with_carried_stats(
    dest: Profile,
    rating: i32,
    wins: u32,
    losses: u32,
) -> Profile {
    Profile {
        rating,
        wins,
        losses,
        ..dest
    }
}

/// Zero the ranked stats and tombstone the name of a guest's own `profile` row,
/// preserving its identity. Pure seam. The zero is load-bearing, not cosmetic
/// (AUTH-25): it is what stops the same guest identity donating the same stats
/// to an unbounded number of later fresh accounts.
pub(crate) fn tombstoned_profile(guest: Profile) -> Profile {
    Profile {
        name: PROFILE_TOMBSTONE_NAME.to_string(),
        rating: 0,
        wins: 0,
        losses: 0,
        ..guest
    }
}

/// Re-key the guest's ranked profile onto `to`: copy stats forward onto the
/// destination row (created via the single `get_or_init_profile` insert seam if
/// absent — no new insert site, ADR-0119 D6 / ptc1 insert-count pin), THEN zero
/// and tombstone the guest's OWN row in place. NEVER deletes a `profile` row
/// (AUTH-23; ADR-0119 D1 structural never-deleted scan). Called only from
/// `accounts::rekey_all` (D0). Reads the guest via `match`, not a split-binding
/// (RL-2 / `=ctx.db` ban). NOT a `#[reducer]` — A1's one-reducer count is
/// unaffected. No-op when the guest never played ranked.
pub(crate) fn rekey_profile(ctx: &ReducerContext, from: Identity, to: Identity) {
    // Read the guest via `match` (not `if let`/`let Some`) so the whitespace-free
    // `=ctx.db.profile()` split-binding needle never appears (RL-2 / d1 scan).
    let guest = match ctx.db.profile().identity().find(from) {
        Some(g) => g,
        None => return,
    };
    let dest = get_or_init_profile(ctx, to);
    ctx.db.profile().identity().update(profile_with_carried_stats(
        dest,
        guest.rating,
        guest.wins,
        guest.losses,
    ));
    ctx.db
        .profile()
        .identity()
        .update(tombstoned_profile(guest));
}

/// True if `identity` has a `profile` row (for
/// `accounts::account_has_game_data`; ADR-0179 D5 guard 3). Read-only.
pub(crate) fn profile_exists(ctx: &ReducerContext, identity: Identity) -> bool {
    ctx.db.profile().identity().find(identity).is_some()
}

#[cfg(test)]
#[path = "ranking_tests.rs"]
mod ranking_tests;
