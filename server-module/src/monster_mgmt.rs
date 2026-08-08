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
use spacetimedb::{Identity, ReducerContext};

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
    // Copy-forward tier (ADR-0174 D7/A3): a missing monster_pub row is a broken
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
    // Copy-forward tier (ADR-0174 D7/A3): fail loud on a missing monster_pub row.
    let Some(existing_pub) = ctx.db.monster_pub().monster_id().find(monster_id) else {
        return Err(format!("monster_pub row missing for monster {monster_id}"));
    };
    let pub_row = pub_from_monster(&m, existing_pub.tier);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);
    Ok(())
}

// --- M21 guest→account re-key (ADR-0179 D6, AUTH-22) --------------------------

/// Re-key every `monster` row (and its `monster_pub` twin) owned by `from` onto
/// `to`, in ONE function body (AUTH-22 / `monster-dual-write.eval.mjs`). Called
/// only from `accounts::rekey_all`; `accounts.rs` must NOT touch `monster`
/// directly (D0 write-isolation). `owner_identity` is a non-PK indexed column on
/// both tables → update in place (no PK collision; the destination owns zero
/// monster rows, guaranteed by `complete_guest_claim`'s destination-collision
/// guard). Collect ids before mutating (ADR-0126 convention). Fallible — a
/// missing `monster_pub` twin is a broken dual-write invariant, fail loud and
/// roll the whole claim back, never fabricate a tier (ADR-0174 D7/A3).
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

/// True if `owner` owns at least one `monster` row (existence check for
/// `accounts::account_has_game_data`; ADR-0179 D5 guard 3). Read-only.
pub(crate) fn has_monsters(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db
        .monster()
        .owner_identity()
        .filter(owner)
        .next()
        .is_some()
}
