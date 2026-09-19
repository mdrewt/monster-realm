//! `evolution` — server-module domain submodule (EG1 rewrite ADR-0174; EG2
//! reducers ADR-0175).
//!
//! TWO reducers: `evolve(ctx, monster_id, to_species)` — the player-invoked
//! write path of the essence-graph evolution model — and
//! `ack_evolution_notices(ctx, count)`, the owner-keyed dismissal of the
//! post-evolve reveal queue (20r-d, ADR-0254 D5). Plus the two EG2 internal
//! helpers: `apply_evolution` (the ONE transform-and-write path, shared by the
//! reducer and the auto-evolution driver) and `check_and_evolve` (the bounded
//! auto-evolution cascade called as a tail from the intent reducers), the pure
//! prefix-drain core `ack_prefix`, and the three `pending_evolution_notice`
//! lifecycle helpers accounts.rs delegates to (`erase_evolution_notices`,
//! `rekey_evolution_notices`, `has_evolution_notices`). This file
//! is a ctx/DB shell only: the gate DECISION is `game_core::path_satisfied` /
//! `game_core::eligible_evolution_paths` and the requirement NAMING is
//! `game_core::unmet_requirement`; nothing in this file reads a gate field
//! (EG1-11 source scan, whole production region). Fusion is deleted as a
//! feature (EG1-9); Migration B (EG5-6/ADR-0177 D2) then removed the `Fusion`
//! table struct from schema.rs as well.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable.

use crate::guards::{reject_if_in_battle, reject_if_monster_in_trade, require_owner};
use crate::marshal::{
    evolution_path_from_row, monster_to_instance, now_ms, pub_from_monster, species_from_row,
};
use crate::schema::{
    battle, evolution_path, monster, monster_pub, pending_evolution_notice, species_row,
    trade_offer, EvolutionPathRow, EvolutionRevealRow, PendingEvolutionNotice,
};
use game_core::Affinity;
use spacetimedb::{Identity, ReducerContext, Table};

/// Hard cap on the auto-evolution chain cascade (EG2-13, ADR-0175 D3): R11's
/// tier cap 5 plus 2 — generous on purpose and structurally unreachable for
/// R5-valid content (strict tier +1 per edge). Hitting it mid-chain means an
/// R5/R11 invariant violation shipped in content.
pub(crate) const MAX_EVOLUTION_CHAIN_STEPS: u32 = 7;

/// Evolve a monster along one authored evolution-graph edge (EG2-1 shape).
///
/// Steps:
/// 1. Look up the Monster row (loud reject if not found)
/// 2. require_owner -> both-role battle guard (ADR-0122) -> trade escrow guard
/// 3. ONE targeted `evolution_path` lookup keyed on BOTH endpoints (btree on
///    from_species, then compare to_species) — a client-supplied `to_species`
///    can never cross-apply a foreign edge
/// 4. Marshal to the pure instance + path, gate via the SHARED predicate
/// 5. Delegate the transform-and-write to `apply_evolution` (EG2-11: an
///    evolution is NEVER applied through two different code paths)
/// 6. Tail-call `check_and_evolve` (EG2-13: chain evolution applies to the
///    player-invoked path too — the new form may already satisfy an
///    unambiguous next edge on its surviving level/Trust/Quality-Time)
#[spacetimedb::reducer]
pub fn evolve(ctx: &ReducerContext, monster_id: u64, to_species: u32) -> Result<(), String> {
    let Some(m) = ctx.db.monster().monster_id().find(monster_id) else {
        return Err("monster not found".to_string());
    };

    require_owner(ctx, "evolve", m.owner_identity)?;
    // Both-role battle guard (ADR-0122): chain the opponent_identity iterator so
    // a monster whose owner sits on side B of an ongoing PvP battle is caught —
    // mirrors the m16.5a trading.rs chain shape (ADR-0112 D1/D2).
    reject_if_in_battle(
        ctx.db
            .battle()
            .player_identity()
            .filter(m.owner_identity)
            .chain(ctx.db.battle().opponent_identity().filter(m.owner_identity)),
        monster_id,
    )?;
    // Trade escrow guard (TR-2, ADR-0106): monster in an active offer cannot be evolved.
    reject_if_monster_in_trade(
        ctx.db
            .trade_offer()
            .initiator()
            .filter(m.owner_identity)
            .chain(ctx.db.trade_offer().counterparty().filter(m.owner_identity)),
        monster_id,
    )?;

    // EG2-1: the ONE targeted row, keyed on BOTH endpoints. R1 guarantees at
    // most one (from, to) edge; an empty table (the pre-EG3 state) or a foreign
    // edge both land here as a clean rejection.
    let Some(path_row) = ctx
        .db
        .evolution_path()
        .from_species()
        .filter(m.species_id)
        .find(|p| p.to_species == to_species)
    else {
        return Err(format!(
            "no such evolution: species {} has no path to species {to_species}",
            m.species_id
        ));
    };
    let path = evolution_path_from_row(&path_row)?;
    let instance = monster_to_instance(&m)?;

    // The SHARED gate predicate decides (EG1-11); the game-core describer only
    // turns a failure into a player-facing sentence.
    if !game_core::path_satisfied(&instance, &path) {
        return Err(game_core::unmet_requirement(&instance, &path)
            .unwrap_or_else(|| "evolution requirements not met".to_string()));
    }

    // EG2-11: the transform-and-write is DELEGATED — the player-invoked path
    // and the auto-evolution path apply an evolution through exactly one helper.
    apply_evolution(ctx, monster_id, &path_row)?;

    // EG2-13: cascade — the new form may already satisfy an unambiguous next
    // edge (level/Trust/Quality-Time survive the transform).
    check_and_evolve(ctx, monster_id);

    Ok(())
}

/// Apply ONE evolution edge to a monster: the shared transform-and-write path
/// (EG2-11, ADR-0175 D3), factored out of `evolve()` so the reducer and
/// `check_and_evolve` cannot drift.
///
/// Deliberately guard-free (EG2-12 Guard warning): this is an internal helper,
/// never wire-reachable, and at the `write_back_battle_results` call site the
/// battle row is still `Ongoing` — the standard guard would self-reject every
/// auto-evolution there. It also re-reads the monster row itself, so a caller
/// can never hand it a stale in-memory copy (what makes the chain safe to run
/// step after step).
pub(crate) fn apply_evolution(
    ctx: &ReducerContext,
    monster_id: u64,
    path: &EvolutionPathRow,
) -> Result<(), String> {
    let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) else {
        return Err("monster not found".to_string());
    };
    // 20r-d (ADR-0254 D4): capture the owner BEFORE the write-back below moves
    // `m`. It is the MONSTER's owner and never the caller: this helper is
    // reachable from pvp_deadline_reaper -> apply_pvp_forfeit ->
    // settle_pvp_battle -> write_back_battle_results, where the caller is the
    // SCHEDULER identity, which owns no monsters and could never ack the queue.
    let owner = m.owner_identity;
    let instance = monster_to_instance(&m)?;

    // FRESH target-species lookup — the MonsterPub.tier source (EG1-8) and the
    // transform's base stats both come from it.
    let Some(to_species_row) = ctx.db.species_row().id().find(path.to_species) else {
        return Err(format!("target species {} not found", path.to_species));
    };
    let target = species_from_row(&to_species_row)?;

    // Pure transform: carries individuality, re-derives stats from the TARGET
    // base stats, clamps current_hp, zeroes all 8 essence pools (ADR-0174 D2).
    let transformed = game_core::evolve(&instance, &target);

    m.species_id = transformed.species_id;
    m.level = transformed.level.as_u8();
    m.xp = transformed.xp.value();
    m.stat_hp = transformed.derived_stats.hp;
    m.stat_attack = transformed.derived_stats.attack;
    m.stat_defense = transformed.derived_stats.defense;
    m.stat_speed = transformed.derived_stats.speed;
    m.stat_sp_attack = transformed.derived_stats.sp_attack;
    m.stat_sp_defense = transformed.derived_stats.sp_defense;
    m.current_hp = transformed.current_hp;
    m.essence_fire = transformed.essence[Affinity::Fire.index()];
    m.essence_water = transformed.essence[Affinity::Water.index()];
    m.essence_plant = transformed.essence[Affinity::Plant.index()];
    m.essence_electric = transformed.essence[Affinity::Electric.index()];
    m.essence_earth = transformed.essence[Affinity::Earth.index()];
    m.essence_wind = transformed.essence[Affinity::Wind.index()];
    m.essence_light = transformed.essence[Affinity::Light.index()];
    m.essence_dark = transformed.essence[Affinity::Dark.index()];
    // Trust and Quality-Time are lifetime history — untouched on purpose, as
    // are the server-only bookkeeping columns.

    // Dual-write, with the tier read fresh from the TARGET species row.
    let pub_row = pub_from_monster(&m, to_species_row.tier);
    ctx.db.monster().monster_id().update(m);
    ctx.db.monster_pub().monster_id().update(pub_row);

    // 20r-d (ADR-0254 D4): ONE reveal entry per applied edge, appended AFTER
    // both rows are written and inside this same helper, so it rides the
    // caller's transaction by construction. The species come from the IMMUTABLE
    // `path` argument: the monster row above has ALREADY been transformed, so a
    // row-derived `from_species` would record the POST species and the banner
    // would read "evolved from X into X". The stamp is the transaction clock —
    // every entry of one chain shares it (display metadata, never an ordering
    // or dedupe key).
    //
    // THIS TAIL IS INFALLIBLE ON PURPOSE: `check_and_evolve` swallows an `Err`
    // from this helper and its callers commit regardless, so a `?` here would
    // persist the evolution and lose the notice. The upsert is a find-then-
    // push-or-insert: a bare `.insert` on an existing primary key PANICS, which
    // in SpacetimeDB is a wasm trap that aborts the HOST reducer — a player's
    // second evolution would roll back the movement or battle write that
    // triggered it.
    let entry = EvolutionRevealRow {
        monster_id,
        from_species: path.from_species,
        to_species: path.to_species,
        evolved_at_ms: now_ms(ctx),
    };
    match ctx
        .db
        .pending_evolution_notice()
        .owner_identity()
        .find(owner)
    {
        Some(mut notice) => {
            notice.entries.push(entry);
            ctx.db
                .pending_evolution_notice()
                .owner_identity()
                .update(notice);
        }
        None => {
            ctx.db
                .pending_evolution_notice()
                .insert(PendingEvolutionNotice {
                    owner_identity: owner,
                    entries: vec![entry],
                });
        }
    }

    Ok(())
}

/// Auto-evolution driver (EG2-11/EG2-13, ADR-0175 D3): called as a TAIL from
/// the intent reducers (care / train / essence_train / consume_crystalized_
/// essence / enqueue_move) and from the battle write-back — never DIRECTLY
/// from a scheduled reducer's own body (EG2-9 is direct-call-only). It stays
/// transitively reachable via pvp_deadline_reaper -> apply_pvp_forfeit ->
/// settle_pvp_battle -> write_back_battle_results, where the only gate value
/// that can have changed is level/XP from the pre-existing forfeit settlement
/// — harmless, and the credits at that site are wild-gated anyway.
///
/// Each iteration: FRESH monster read, the DB `evolution_path` rows for the
/// CURRENT species (the same source `evolve()` and the EG4 client read — never
/// the cfg(test)-gated RON cache), the SHARED `eligible_evolution_paths` query.
/// 0 eligible -> done; 2+ -> the player owns the choice (EG2-2); exactly 1 ->
/// apply and loop against the NEW species. Guard-free by design (EG2-12) and
/// infallible outward: this must never fail the caller's already-performed
/// write, so every abnormal condition is log-and-stop.
pub(crate) fn check_and_evolve(ctx: &ReducerContext, monster_id: u64) {
    let mut steps: u32 = 0;
    while steps < MAX_EVOLUTION_CHAIN_STEPS {
        // FRESH find every step — the row changed under us on the last one.
        let Some(m) = ctx.db.monster().monster_id().find(monster_id) else {
            log::warn!(
                "{{\"evt\":\"check_and_evolve_skip\",\"monster_id\":{monster_id},\"reason\":\"monster row missing\"}}",
            );
            return;
        };
        let instance = match monster_to_instance(&m) {
            Ok(instance) => instance,
            Err(e) => {
                // ADR-0170 D5 / ADR-0188. Every reachable producer of this reason
                // emits static ASCII or a numeric interpolation today, so no live
                // injection exists here — but ONE double quote would make the line
                // unparseable and the ingest would drop the diagnostic for exactly
                // the corrupt row that produced it. The escape is the SSOT rule, not
                // a dependency on that audit staying true.
                let reason = crate::guards::json_escape(&e);
                log::warn!(
                    "{{\"evt\":\"check_and_evolve_skip\",\"monster_id\":{monster_id},\"reason\":\"{reason}\"}}",
                );
                return;
            }
        };
        // Candidate edges out of the monster's CURRENT species, via the
        // from_species btree index (EG1-4 — this runs on the movement hot path).
        let mut candidate_rows: Vec<EvolutionPathRow> = Vec::new();
        let mut candidate_paths: Vec<game_core::EvolutionPath> = Vec::new();
        for row in ctx.db.evolution_path().from_species().filter(m.species_id) {
            match evolution_path_from_row(&row) {
                Ok(path) => {
                    candidate_rows.push(row);
                    candidate_paths.push(path);
                }
                // A corrupt row is skipped, never fatal: this is a reducer tail.
                Err(e) => {
                    // ADR-0170 D5 / ADR-0188 — see the sibling site above.
                    let reason = crate::guards::json_escape(&e);
                    log::warn!(
                        "{{\"evt\":\"check_and_evolve_skip_edge\",\"monster_id\":{monster_id},\"reason\":\"{reason}\"}}",
                    );
                }
            }
        }
        // THE decision: the SHARED full-set query (EG2-11), never a hand-rolled
        // first-match. 0 -> chain ends; 2+ -> the player picks (EG2-2).
        let eligible = game_core::eligible_evolution_paths(&instance, &candidate_paths);
        if eligible.len() != 1 {
            return;
        }
        if let Err(e) = apply_evolution(ctx, monster_id, &candidate_rows[eligible[0]]) {
            // ADR-0170 D5 / ADR-0188 — see the sibling sites above.
            let reason = crate::guards::json_escape(&e);
            log::error!(
                "{{\"evt\":\"check_and_evolve_apply_failed\",\"monster_id\":{monster_id},\"reason\":\"{reason}\"}}",
            );
            return;
        }
        steps += 1;
    }
    // Cap reached with the loop still live. This can only fire against
    // R5/R11-VIOLATING content (a cycle, or a future tier-cap raise outpacing
    // MAX_EVOLUTION_CHAIN_STEPS): with valid content the loop always exits via
    // the 0/2+-eligible branch first. Distinct signal, never a silent stop
    // (ADR-0175 D3).
    log::error!(
        "{{\"evt\":\"check_and_evolve_cap_hit\",\"monster_id\":{monster_id},\"steps\":{steps}}}",
    );
}

/// Drain the acknowledged PREFIX of an owner's reveal queue (20r-d, ADR-0254
/// D5). The ONE place the ack arithmetic lives, pure and `ctx`-free so the
/// truth table is executable without a host.
///
/// REJECT, NEVER CLAMP. A zero count is always a client defect worth
/// surfacing, and a count above the queue length means the caller is acking
/// entries it never rendered (a second tab's stale head) — clamping would
/// silently discard reveals the player never saw. Both rejections leave
/// `entries` byte-identical, so a refused ack can never lose a reveal.
///
/// The drained values are DROPPED: Vec order is display order, the entries
/// carry nothing the caller needs back, and this file confines every
/// collection to `check_and_evolve` (EG1-11).
pub(crate) fn ack_prefix(entries: &mut Vec<EvolutionRevealRow>, count: u32) -> Result<(), String> {
    if count == 0 {
        return Err("ack count must be positive".to_string());
    }
    if count as usize > entries.len() {
        return Err(format!(
            "ack count {count} exceeds {} pending evolution notices",
            entries.len()
        ));
    }
    entries.drain(..count as usize);
    Ok(())
}

/// Acknowledge the first `count` pending evolution reveals of the CALLER
/// (20r-d, ADR-0254 D5).
///
/// Owner-keyed by definition: the only row this reducer can ever touch is the
/// one filed under `ctx.sender()`, so one player can never drain another
/// player's queue. The row SURVIVES an empty drain — only the account deletion
/// cascade removes it, exactly as `player_wallet` survives a zero balance — so
/// the client's reconcile keeps seeing an authoritative empty queue rather
/// than an ambiguous absent one.
///
/// NOT deletion-gated: `require_not_deleting` guards reducers that OPEN a
/// commitment between two players; gating an ack would leave a deleting
/// player's banner undismissable.
#[spacetimedb::reducer]
pub fn ack_evolution_notices(ctx: &ReducerContext, count: u32) -> Result<(), String> {
    let Some(mut row) = ctx
        .db
        .pending_evolution_notice()
        .owner_identity()
        .find(ctx.sender())
    else {
        return Err("no pending evolution notices".to_string());
    };
    ack_prefix(&mut row.entries, count)?;
    ctx.db
        .pending_evolution_notice()
        .owner_identity()
        .update(row);
    Ok(())
}

/// Cascade step: erase `owner`'s pending reveal queue (20r-d, ADR-0254 D6).
/// Called by `accounts::account_deletion_reaper` immediately after the monster
/// erase — the queue is derived bookkeeping about monsters, so it goes with
/// them. A primary-key delete on a missing row is a no-op, so this is
/// idempotent and infallible, like every other delegated cascade step.
pub(crate) fn erase_evolution_notices(ctx: &ReducerContext, owner: Identity) {
    ctx.db
        .pending_evolution_notice()
        .owner_identity()
        .delete(owner);
}

/// Claim-flow re-key: move `from`'s pending reveal queue onto `to` (20r-d,
/// ADR-0254 D6), the `rekey_heal_cooldown` / `rekey_npc_state` PK-rekey shape.
///
/// DELETE-THEN-INSERT WITH NO MERGE, and that is deliberate: `complete_guest_
/// claim`'s guard 11 (`accounts::account_has_game_data`) runs BEFORE
/// `rekey_all`, and `has_evolution_notices` below is part of that predicate, so
/// the destination identity provably owns no row by the time this runs. A
/// merge branch here would be unreachable code guarding an invariant the guard
/// already holds.
///
/// A deliberate deviation from `economy::rekey_wallet`, which never deletes:
/// that rule is AUTH-23/24's wallet single-surface invariant and does not apply
/// to a transient delivery queue.
pub(crate) fn rekey_evolution_notices(ctx: &ReducerContext, from: Identity, to: Identity) {
    if let Some(row) = ctx
        .db
        .pending_evolution_notice()
        .owner_identity()
        .find(from)
    {
        ctx.db
            .pending_evolution_notice()
            .owner_identity()
            .delete(from);
        ctx.db
            .pending_evolution_notice()
            .insert(PendingEvolutionNotice {
                owner_identity: to,
                entries: row.entries,
            });
    }
}

/// True if `owner` holds a pending reveal ROW at all (20r-d, ADR-0254 D6) — the
/// `accounts::account_has_game_data` clause for this table.
///
/// ROW-EXISTS, never "the entry list is non-empty": an acked-empty row is still
/// a row, and it is exactly this predicate that makes the no-merge re-key above
/// sound. Weakening it to `!entries.is_empty()` would let a claim target that
/// already holds an emptied row pass guard 11 and then be overwritten.
pub(crate) fn has_evolution_notices(ctx: &ReducerContext, owner: Identity) -> bool {
    ctx.db
        .pending_evolution_notice()
        .owner_identity()
        .find(owner)
        .is_some()
}

#[cfg(test)]
#[path = "evolution_tests.rs"]
mod evolution_tests;
