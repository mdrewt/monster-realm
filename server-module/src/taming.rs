//! `taming` — server-module domain submodule.
//!
//! Recruiting wild monsters: the tactical recruit's insert (`insert_recruited`, called
//! from `tactics.rs`'s recruit hook once game-core's roll succeeds) and the dev-only
//! `grant_bait`. The 1v1 `attempt_recruit` reducer is deleted (bt-17). The inventory
//! helper `grant_item` lives in `inventory.rs` (the single item-mutation surface).

// `log_reject`, `grant_item` and `item_row` are dev-gated: their only caller `grant_bait` is
// too — an ungated import would be an unused-import warning in the non-dev build.
#[cfg(feature = "dev_reducers")]
use crate::guards::log_reject;
#[cfg(feature = "dev_reducers")]
use crate::inventory::grant_item;
use crate::marshal::{monster_from_instance, pub_from_monster};
#[cfg(feature = "dev_reducers")]
use crate::schema::item_row;
use crate::schema::{monster, monster_pub, Monster};
use crate::PARTY_SLOT_NONE;
use game_core::Level;
use spacetimedb::{Identity, ReducerContext, Table};

/// The recruit grant primitive (M8d; shared with the tactical recruit glue — bt-9): the EXACT
/// wild rebuilt from its individuality `seed` at `level` through the carried `build_monster`
/// (same IVs and nature, full HP, the level's base XP, no essence), dropped in the box
/// (`PARTY_SLOT_NONE`) with its `monster_pub` projection (FRESH tier = the species' tier).
/// Returns the inserted row. Never logs the seed.
pub(crate) fn insert_recruited(
    ctx: &ReducerContext,
    owner: Identity,
    seed: u32,
    species: &game_core::Species,
    level: Level,
) -> Monster {
    let inst = game_core::tactics::rebuild_recruited(seed, species, level);
    let row = monster_from_instance(owner, &inst, PARTY_SLOT_NONE);
    let inserted = ctx.db.monster().insert(row);
    let pub_row = pub_from_monster(&inserted, species.tier);
    ctx.db.monster_pub().insert(pub_row);
    inserted
}

/// DEV/TEST: grant bait to the CALLER only (self-scoped to `ctx.sender()`; no
/// arbitrary-recipient parameter). Rejects non-bait items. Superseded by the M9
/// shop. Capped at 99 per call.
#[cfg(feature = "dev_reducers")]
#[spacetimedb::reducer]
pub fn grant_bait(ctx: &ReducerContext, item_id: u32, qty: u32) -> Result<(), String> {
    let me = ctx.sender();
    // Deletion gate: the first check, before the item read; no joined check exists.
    crate::guards::require_not_deleting(ctx, "grant_bait")?;
    let Some(item) = ctx.db.item_row().id().find(item_id) else {
        let e = "item not found".to_string();
        log_reject("grant_bait", me, &e);
        return Err(e);
    };
    if item.recruit_bonus == 0 {
        let e = "not a bait item".to_string();
        log_reject("grant_bait", me, &e);
        return Err(e);
    }
    let capped = qty.min(99);
    grant_item(ctx, ctx.sender(), item_id, capped);
    Ok(())
}

#[cfg(test)]
#[path = "taming_tests.rs"]
mod taming_tests;
