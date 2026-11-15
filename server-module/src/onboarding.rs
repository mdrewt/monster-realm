//! `onboarding` — what a join grants: the starter monster and the starter kit, once per
//! identity, and the identity's handle (its minted discriminator), which this module owns.
//!
//! "New player" is never inferred from what an identity owns. The grant is recorded by a
//! persistent marker (`npc::STARTER_CLAIMED_FLAG`) set in the same transaction as the kit,
//! and an identity whose marker is set is granted nothing, whatever it owns.

use crate::economy::grant_currency;
use crate::inventory::grant_item;
use crate::npc::{check_reward_headroom, RewardCredits};
use crate::schema::{player_handle, PlayerHandle};
use game_core::StarterKit;
use spacetimedb::{Identity, ReducerContext, Table};

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

/// `owner`'s discriminator: the one its handle row holds, or a freshly minted one when it
/// has no row. The mint inserts 0, which makes the column's sequence assign the value. A
/// mint the datastore refuses (the sequence is exhausted, or the value it drew is taken) is
/// an `Err` with one static reason, never a panic and never a value of 0.
pub(crate) fn ensure_handle(ctx: &ReducerContext, owner: Identity) -> Result<u32, String> {
    if let Some(handle) = ctx.db.player_handle().owner_identity().find(owner) {
        return Ok(handle.discriminator);
    }
    ctx.db
        .player_handle()
        .try_insert(PlayerHandle {
            owner_identity: owner,
            discriminator: 0,
        })
        .map(|handle| handle.discriminator)
        .map_err(|_| "handle unavailable".to_string())
}

/// Move `from`'s handle onto `to` with its discriminator unchanged (the guest claim). The
/// claim refuses a destination that holds a handle, so the two rows never coexist. The
/// explicit non-zero insert draws nothing from the sequence.
pub(crate) fn rekey_handle(ctx: &ReducerContext, from: Identity, to: Identity) {
    let Some(handle) = ctx.db.player_handle().owner_identity().find(from) else {
        return;
    };
    ctx.db.player_handle().owner_identity().delete(from);
    ctx.db.player_handle().insert(PlayerHandle {
        owner_identity: to,
        ..handle
    });
}

/// Delete `owner`'s handle (the deletion cascade). Its discriminator is never minted again.
pub(crate) fn erase_handle(ctx: &ReducerContext, owner: Identity) {
    ctx.db.player_handle().owner_identity().delete(owner);
}

/// True if `owner` holds a handle (a re-keyed table, so it counts as game data for
/// `accounts::account_has_game_data`).
pub(crate) fn has_handle(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db
        .player_handle()
        .owner_identity()
        .find(owner)
        .is_some()
}

#[cfg(test)]
#[path = "onboarding_tests.rs"]
mod onboarding_tests;
