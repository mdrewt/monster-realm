//! `onboarding` — SCAFFOLD (eo-1 red phase): the contract's signatures over today's behaviour.

use game_core::StarterKit;
use spacetimedb::{Identity, ReducerContext};

/// What one join grants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StarterGrant {
    pub(crate) monster: bool,
    pub(crate) kit: bool,
}

pub(crate) fn starter_grant(claimed: bool, owns_monster: bool) -> StarterGrant {
    let _ = claimed;
    StarterGrant {
        monster: !owns_monster,
        kit: false,
    }
}

pub(crate) fn grant_kit(ctx: &ReducerContext, owner: Identity, kit: &StarterKit) {
    let _ = (ctx, owner, kit);
}

pub(crate) fn onboard(ctx: &ReducerContext, owner: Identity, kit: &StarterKit) -> StarterGrant {
    let _ = kit;
    starter_grant(
        crate::npc::starter_claimed(ctx, owner),
        crate::monster_mgmt::has_monsters(ctx, owner),
    )
}

#[cfg(test)]
#[path = "onboarding_tests.rs"]
mod onboarding_tests;
