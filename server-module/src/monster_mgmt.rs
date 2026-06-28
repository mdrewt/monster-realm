//! `monster_mgmt` — server-module domain submodule (M8.9, ADR-0056).
//!
//! Monster-management reducers: rename and party-slot assignment. Both are
//! ownership-checked and dual-write the private `monster` row and its public
//! `monster_pub` projection.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::guards::{log_reject, require_owner, validate_name};
use crate::marshal::pub_from_monster;
use crate::schema::{monster, monster_pub};
use crate::{MAX_PARTY_SIZE, PARTY_SLOT_NONE};
use spacetimedb::ReducerContext;

// --- Monster management reducers (M6b) ----------------------------------------

/// Set or clear a monster's nickname. Empty string clears the nickname.
/// Ownership-checked: only the monster's owner may rename it.
#[spacetimedb::reducer]
pub fn set_nickname(ctx: &ReducerContext, monster_id: u64, nickname: String) -> Result<(), String> {
    let me = ctx.sender;
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        let e = "monster not found".to_string();
        log_reject("set_nickname", me, &e);
        return Err(e);
    };
    require_owner(ctx, "set_nickname", m.owner_identity)?;
    let validated = if nickname.trim().is_empty() {
        String::new() // clear nickname
    } else {
        validate_name(&nickname).inspect_err(|e| log_reject("set_nickname", me, e))?
    };
    m.nickname = validated;
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    Ok(())
}

/// Set or clear a monster's party slot. `slot = 255` moves to box; `slot < 6`
/// assigns a party position. Ownership-checked; rejects out-of-range slots and
/// occupied-slot conflicts (caller must clear the existing occupant first).
#[spacetimedb::reducer]
pub fn set_party_slot(ctx: &ReducerContext, monster_id: u64, slot: u8) -> Result<(), String> {
    let me = ctx.sender;
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        let e = "monster not found".to_string();
        log_reject("set_party_slot", me, &e);
        return Err(e);
    };
    require_owner(ctx, "set_party_slot", m.owner_identity)?;
    if slot != PARTY_SLOT_NONE && slot >= MAX_PARTY_SIZE {
        let e =
            format!("slot {slot} out of range (0..{MAX_PARTY_SIZE} or {PARTY_SLOT_NONE} for box)");
        log_reject("set_party_slot", me, &e);
        return Err(e);
    }
    // If assigning to a party slot, check it's not already occupied.
    if slot != PARTY_SLOT_NONE {
        let occupied = ctx
            .db
            .monster()
            .owner_identity()
            .filter(me)
            .any(|other| other.monster_id != monster_id && other.party_slot == slot);
        if occupied {
            let e = format!("party slot {slot} already occupied");
            log_reject("set_party_slot", me, &e);
            return Err(e);
        }
    }
    m.party_slot = slot;
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    Ok(())
}
