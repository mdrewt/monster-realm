//! `onboarding` — what a join grants: the starter monster and the starter kit, once per
//! identity.
//!
//! "New player" is never inferred from what an identity owns. The grant is recorded by a
//! persistent marker (`npc::STARTER_CLAIMED_FLAG`) set in the same transaction as the kit,
//! and an identity whose marker is set is granted nothing, whatever it owns.

use crate::economy::grant_currency;
use crate::inventory::grant_item;
use crate::npc::{check_reward_headroom, RewardCredits};
use game_core::StarterKit;
use spacetimedb::{Identity, ReducerContext};

/// What one join grants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StarterGrant {
    /// Insert the starter monster.
    pub(crate) monster: bool,
    /// Grant the starter kit and set the marker.
    pub(crate) kit: bool,
}

/// The grant rule. `claimed`: the identity's starter marker is set. `owns_monster`: it owns
/// at least one monster. A claimed identity gets nothing. An unclaimed one gets the kit,
/// and the monster too unless it already owns one.
pub(crate) fn starter_grant(claimed: bool, owns_monster: bool) -> StarterGrant {
    StarterGrant {
        monster: !claimed && !owns_monster,
        kit: !claimed,
    }
}

/// Grant `owner` the whole kit and set its marker, or grant nothing: the kit is checked
/// against the stack and balance caps before any write, and one that does not fit is
/// skipped with a `starter_kit_skipped` line naming the cap. A skipped kit leaves the
/// marker unset, so the next join tries again.
fn grant_kit(ctx: &ReducerContext, owner: Identity, kit: &StarterKit) {
    let mut credits = RewardCredits::default();
    for item in &kit.items {
        credits.add_item(item.item_id, item.qty);
    }
    credits.add_currency(kit.currency);
    if let Err(reason) = check_reward_headroom(ctx, owner, &credits) {
        let reason = crate::guards::json_escape(&reason);
        crate::observability::mr_log(
            "starter_kit_skipped",
            &format!("\"sender\":\"{owner}\",\"reason\":\"{reason}\""),
        );
        return;
    }
    grant_currency(ctx, owner, kit.currency);
    for item in &kit.items {
        grant_item(ctx, owner, item.item_id, item.qty);
    }
    crate::npc::mark_starter_claimed(ctx, owner);
}

/// Decide what `owner`'s join grants and grant the kit part. The caller inserts the
/// starter monster when the returned decision says so.
pub(crate) fn onboard(ctx: &ReducerContext, owner: Identity, kit: &StarterKit) -> StarterGrant {
    let grant = starter_grant(
        crate::npc::starter_claimed(ctx, owner),
        crate::monster_mgmt::has_monsters(ctx, owner),
    );
    if grant.kit {
        grant_kit(ctx, owner, kit);
    }
    grant
}

#[cfg(test)]
#[path = "onboarding_tests.rs"]
mod onboarding_tests;
