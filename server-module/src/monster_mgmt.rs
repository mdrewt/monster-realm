//! `monster_mgmt` — server-module domain submodule.
//!
//! Monster-management reducers: rename and party-slot assignment. Both are
//! ownership-checked and dual-write the private `monster` row and its public
//! `monster_pub` projection.

use crate::guards::{log_reject, reject_if_monster_in_trade, require_owner, validate_name};
use crate::marshal::pub_from_monster;
use crate::schema::{monster, monster_pub, trade_offer};
use crate::PARTY_SLOT_NONE;
use spacetimedb::{Identity, ReducerContext};

// --- Monster management reducers (M6b) ----------------------------------------

/// Set or clear a monster's nickname. Empty string clears the nickname.
/// Ownership-checked: only the monster's owner may rename it.
#[spacetimedb::reducer]
pub fn set_nickname(ctx: &ReducerContext, monster_id: u64, nickname: String) -> Result<(), String> {
    // Deletion gate: the FIRST statement, before every read and write.
    crate::guards::require_not_deleting(ctx, "set_nickname")?;
    let me = ctx.sender();
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        let e = "monster not found".to_string();
        log_reject("set_nickname", me, &e);
        return Err(e);
    };
    require_owner(ctx, "set_nickname", m.owner_identity)?;
    // Trade escrow guard.
    reject_if_monster_in_trade(
        ctx.db
            .trade_offer()
            .initiator()
            .filter(m.owner_identity)
            .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
        monster_id,
    )?;
    let validated = if nickname.trim().is_empty() {
        String::new() // clear nickname
    } else {
        validate_name(&nickname).inspect_err(|e| log_reject("set_nickname", me, e))?
    };
    m.nickname = validated;
    // Copy-forward tier: a missing monster_pub row is a broken
    // dual-write invariant — fail loud, never fabricate a tier.
    let Some(existing_pub) = ctx.db.monster_pub().monster_id().find(monster_id) else {
        return Err(format!("monster_pub row missing for monster {monster_id}"));
    };
    let pub_row = pub_from_monster(&m, existing_pub.tier);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    Ok(())
}

/// Set or clear a monster's party slot. `slot = 255` moves to box; `slot < 6`
/// assigns a party position. Ownership-checked; delegates slot legality to the
/// pure game-core check (`game_core::check_party_slot`).
#[spacetimedb::reducer]
pub fn set_party_slot(ctx: &ReducerContext, monster_id: u64, slot: u8) -> Result<(), String> {
    // Deletion gate: the FIRST statement, before every read and write.
    crate::guards::require_not_deleting(ctx, "set_party_slot")?;
    let me = ctx.sender();
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        let e = "monster not found".to_string();
        log_reject("set_party_slot", me, &e);
        return Err(e);
    };
    require_owner(ctx, "set_party_slot", m.owner_identity)?;
    // Trade escrow guard.
    reject_if_monster_in_trade(
        ctx.db
            .trade_offer()
            .initiator()
            .filter(m.owner_identity)
            .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
        monster_id,
    )?;
    // Collect PARTY slots of the caller's OTHER monsters (excluding the one being moved
    // and excluding boxed monsters whose party_slot == PARTY_SLOT_NONE = 255).
    let occupied: Vec<u8> = ctx
        .db
        .monster()
        .owner_identity()
        .filter(me)
        .filter(|other| other.monster_id != monster_id && other.party_slot != PARTY_SLOT_NONE)
        .map(|other| other.party_slot)
        .collect();
    if let Err(err) = game_core::check_party_slot(slot, &occupied) {
        let e = err.to_string();
        log_reject("set_party_slot", me, &e);
        return Err(e);
    }
    m.party_slot = slot;
    // Copy-forward tier: fail loud on a missing monster_pub row.
    let Some(existing_pub) = ctx.db.monster_pub().monster_id().find(monster_id) else {
        return Err(format!("monster_pub row missing for monster {monster_id}"));
    };
    let pub_row = pub_from_monster(&m, existing_pub.tier);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    Ok(())
}

// --- M21 guest→account re-key (AUTH-22) --------------------------

/// Re-key every `monster` row (and its `monster_pub` twin) owned by `from` onto
/// `to`, in ONE function body. Called only from `accounts::rekey_all`;
/// `accounts.rs` must NOT touch `monster` directly. `owner_identity` is a non-PK
/// indexed column on both tables → update in place (no PK collision; the
/// destination owns zero monster rows, guaranteed by `complete_guest_claim`'s
/// destination-collision guard). Collect ids before mutating. Fallible — a
/// missing `monster_pub` twin is a broken dual-write invariant, fail loud and
/// roll the whole claim back, never fabricate a tier.
pub(crate) fn rekey_monsters(
    ctx: &ReducerContext,
    from: Identity,
    to: Identity,
) -> Result<(), String> {
    let ids: Vec<u64> = ctx
        .db
        .monster()
        .owner_identity()
        .filter(from)
        .map(|m| m.monster_id)
        .collect();
    for id in ids {
        let Some(mut m) = ctx.db.monster().monster_id().find(id) else {
            continue;
        };
        let Some(existing_pub) = ctx.db.monster_pub().monster_id().find(id) else {
            return Err(format!("monster_pub row missing for monster {id}"));
        };
        m.owner_identity = to;
        let pub_row = pub_from_monster(&m, existing_pub.tier);
        ctx.db.monster().monster_id().update(m);
        ctx.db.monster_pub().monster_id().update(pub_row);
    }
    Ok(())
}

/// delete every `monster` row owned by `owner`, PUBLIC TWIN INCLUDED, in ONE
/// function body — the dual-write invariant rides the same fn as the
/// `monster` delete, exactly like `rekey_monsters` above. Called only from
/// `accounts::account_deletion_reaper`. Collect ids via the owner index
/// before mutating; never an unbounded table iteration. Infallible: a
/// missing `monster_pub` twin is a PK no-op delete, and an erase has no tier
/// to fabricate.
pub(crate) fn erase_monsters(ctx: &ReducerContext, owner: Identity) {
    let ids: Vec<u64> = ctx
        .db
        .monster()
        .owner_identity()
        .filter(owner)
        .map(|m| m.monster_id)
        .collect();
    for id in ids {
        ctx.db.monster().monster_id().delete(id);
        ctx.db.monster_pub().monster_id().delete(id);
    }
}

/// True if `owner` owns at least one `monster` row (existence check for
/// `accounts::account_has_game_data`). Read-only.
pub(crate) fn has_monsters(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db
        .monster()
        .owner_identity()
        .filter(owner)
        .next()
        .is_some()
}

#[cfg(test)]
#[path = "monster_mgmt_tests.rs"]
mod monster_mgmt_tests;
