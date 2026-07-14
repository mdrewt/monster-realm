//! `monster_mgmt` — server-module domain submodule (M8.9, ADR-0056).
//!
//! Monster-management reducers: rename and party-slot assignment. Both are
//! ownership-checked and dual-write the private `monster` row and its public
//! `monster_pub` projection.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::guards::{log_reject, reject_if_monster_in_trade, require_owner, validate_name};
use crate::marshal::pub_from_monster;
use crate::schema::{monster, monster_pub, trade_offer};
use crate::PARTY_SLOT_NONE;
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
    // Trade escrow guard (TR-4, ADR-0106).
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
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    Ok(())
}

/// Set or clear a monster's party slot. `slot = 255` moves to box; `slot < 6`
/// assigns a party position. Ownership-checked; delegates slot legality to the
/// pure game-core check (`game_core::check_party_slot`, ADR-0053 SlotError pattern).
#[spacetimedb::reducer]
pub fn set_party_slot(ctx: &ReducerContext, monster_id: u64, slot: u8) -> Result<(), String> {
    let me = ctx.sender;
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        let e = "monster not found".to_string();
        log_reject("set_party_slot", me, &e);
        return Err(e);
    };
    require_owner(ctx, "set_party_slot", m.owner_identity)?;
    // Trade escrow guard (TR-5, ADR-0106).
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
    let pub_row = pub_from_monster(&m);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    Ok(())
}
