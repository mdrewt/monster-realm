//! `battle` — server-module domain submodule (M8.9, ADR-0056).
//!
//! The PvE/wild battle cluster: start/wild-start, the per-turn action reducers
//! (submit_attack, swap_active, flee), heal, and the encounter + write-back
//! helpers. Reducers are thin: validate the trust boundary, delegate the rule to
//! `game-core` (the SSOT), write tables; reject with `Err`, never clamp.
//!
//! This file name is part of the canonical `touches:` vocabulary fixed by
//! ADR-0056 — keep it stable; it could only be wired once the `battle` table
//! relocated to `schema.rs` (the M8.9a table-name collision constraint).

use crate::guards::{
    check_monster_in_party, check_party_size, check_team_coupling, log_reject, require_owner,
};
use crate::marshal::{
    battle_monster_from_row, loser_base_stat_total, now_ms, pub_from_monster, skill_defs_from_rows,
    type_chart_from_rows, wild_battle_monster, write_back_hp,
};
use crate::schema::{
    battle, battle_wild, monster, monster_pub, skill_row, species_row, type_relation_row, Battle,
    BattleWild, Monster, SkillRow,
};
use crate::{PARTY_SLOT_NONE, WILD_IDENTITY};
use game_core::combat::xp::level_up_healed_hp;
use game_core::{
    apply_xp_gain, battle_xp_reward, load_evolutions, resolve_turn, BattleOutcome, BattleSide,
    BattleState, Level, StatBlock, TurnChoice, TurnVariance,
};
use spacetimedb::{Identity, ReducerContext, Table};

// `start_wild_battle` (dev-only, ADR-0054) is the sole battle-module user of these
// — gate the imports so the default (non-dev) build stays warning-clean.
#[cfg(feature = "dev_reducers")]
use crate::marshal::table_from_encounter_row;
#[cfg(feature = "dev_reducers")]
use crate::schema::{character, encounter, player};
#[cfg(feature = "dev_reducers")]
use game_core::resolve_encounter;

/// Start a PvE battle: build BattleMonsters from the player's party and the
/// opponent's party (owned by opponent_identity), create a BattleState, insert
/// the Battle row. Both parties must have at least one conscious party member.
///
/// Opponent provenance (ADR-0048): only a self/sandbox opponent
/// (`opponent_identity == ctx.sender`) or the server/NPC sentinel
/// (`WILD_IDENTITY`) is accepted. A client may NOT name another player as the
/// opponent — that would conscript their monsters into the public `battle` row.
#[spacetimedb::reducer]
pub fn start_battle(
    ctx: &ReducerContext,
    opponent_identity: Identity,
    party_monster_ids: Vec<u64>,
    opponent_monster_ids: Vec<u64>,
) -> Result<(), String> {
    let me = ctx.sender;

    // Bound BOTH parties to 1..=MAX_PARTY_SIZE (reject empty AND oversized —
    // never truncate; an unbounded list is N species lookups + N skill scans +
    // N row writes, and would yield a side with team.len() > MAX_PARTY_SIZE).
    // These pure O(1) checks run BEFORE the O(N) dedup scan and any DB read so a
    // huge list can't exhaust memory pre-rejection. M8.5a.
    if let Err(e) = check_party_size(party_monster_ids.len()) {
        log_reject("start_battle", me, &e);
        return Err(e);
    }
    if let Err(e) = check_party_size(opponent_monster_ids.len()) {
        let e = format!("opponent {e}");
        log_reject("start_battle", me, &e);
        return Err(e);
    }

    // Opponent-provenance authorization (ADR-0048): accept ONLY self/sandbox
    // (opponent_identity == ctx.sender) or the server/NPC sentinel
    // (WILD_IDENTITY). Naming another player would conscript their monsters into
    // the public `battle` row (info-leak / grief / XP farm). Reject before the
    // dedup scan and any side-B DB read so a foreign roster never reaches the
    // row. reject-not-clamp.
    if opponent_identity != me && opponent_identity != WILD_IDENTITY {
        let e = "opponent must be self or server-authored (PvP unsupported; ADR-0048)".to_string();
        log_reject("start_battle", me, &e);
        return Err(e);
    }

    // Reject duplicate monster IDs across both sides (prevents double XP
    // write-back / a monster fighting itself). Both lists are now bounded by
    // MAX_PARTY_SIZE, so this scan is O(1)-bounded.
    {
        let mut seen = std::collections::HashSet::new();
        for &mid in &party_monster_ids {
            if !seen.insert(mid) {
                let e = format!("duplicate monster_id {mid} in party_monster_ids");
                log_reject("start_battle", me, &e);
                return Err(e);
            }
        }
        for &mid in &opponent_monster_ids {
            if !seen.insert(mid) {
                let e = format!("duplicate monster_id {mid} in opponent_monster_ids");
                log_reject("start_battle", me, &e);
                return Err(e);
            }
        }
    }

    // Check caller is not already in an ongoing battle.
    let already_in_battle = ctx
        .db
        .battle()
        .player_identity()
        .filter(me)
        .any(|b| b.state.outcome == BattleOutcome::Ongoing);
    if already_in_battle {
        let e = "already in an ongoing battle".to_string();
        log_reject("start_battle", me, &e);
        return Err(e);
    }

    // Build side A (player) team.
    let mut team_a = Vec::new();
    for &mid in &party_monster_ids {
        let m = ctx
            .db
            .monster()
            .monster_id()
            .find(mid)
            .ok_or_else(|| format!("party monster {mid} not found"))?;
        if m.owner_identity != me {
            let e = format!("monster {mid} not owned by caller");
            log_reject("start_battle", me, &e);
            return Err(e);
        }
        // Reject boxed monsters — only party-slotted monsters may battle (M8.5a).
        if let Err(e) = check_monster_in_party(m.party_slot) {
            let e = format!("monster {mid} {e}");
            log_reject("start_battle", me, &e);
            return Err(e);
        }
        let sp = ctx
            .db
            .species_row()
            .id()
            .find(m.species_id)
            .ok_or_else(|| format!("species {} not found", m.species_id))?;
        let skills: Vec<SkillRow> = ctx
            .db
            .skill_row()
            .iter()
            .filter(|s| sp.learnable_skill_ids.contains(&s.id))
            .collect();
        team_a.push(battle_monster_from_row(&m, &sp, &skills)?);
    }

    // Build side B (opponent) team.
    let mut team_b = Vec::new();
    for &mid in &opponent_monster_ids {
        let m = ctx
            .db
            .monster()
            .monster_id()
            .find(mid)
            .ok_or_else(|| format!("opponent monster {mid} not found"))?;
        if m.owner_identity != opponent_identity {
            let e = format!("monster {mid} not owned by opponent");
            log_reject("start_battle", me, &e);
            return Err(e);
        }
        // Reject boxed monsters on side-B too — a boxed monster's derived stats
        // must not be embedded into the public `battle` row (M8.5a).
        if let Err(e) = check_monster_in_party(m.party_slot) {
            let e = format!("opponent monster {mid} {e}");
            log_reject("start_battle", me, &e);
            return Err(e);
        }
        let sp = ctx
            .db
            .species_row()
            .id()
            .find(m.species_id)
            .ok_or_else(|| format!("species {} not found", m.species_id))?;
        let skills: Vec<SkillRow> = ctx
            .db
            .skill_row()
            .iter()
            .filter(|s| sp.learnable_skill_ids.contains(&s.id))
            .collect();
        team_b.push(battle_monster_from_row(&m, &sp, &skills)?);
    }

    // At least one conscious monster per side.
    if !team_a.iter().any(|m| !m.is_fainted()) {
        let e = "party has no conscious monster".to_string();
        log_reject("start_battle", me, &e);
        return Err(e);
    }
    if !team_b.iter().any(|m| !m.is_fainted()) {
        let e = "opponent has no conscious monster".to_string();
        log_reject("start_battle", me, &e);
        return Err(e);
    }

    let state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: team_a,
        },
        side_b: BattleSide {
            active: 0,
            team: team_b,
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
    };

    let battle = ctx.db.battle().insert(Battle {
        battle_id: 0,
        player_identity: me,
        opponent_identity,
        state,
        party_monster_ids,
        opponent_monster_ids,
        created_at_ms: now_ms(ctx),
    });

    log::info!(
        "{{\"evt\":\"battle_start\",\"battle_id\":{},\"sender\":\"{me}\"}}",
        battle.battle_id
    );
    Ok(())
}

// --- Wild encounter (M8c, ADR-0045) -------------------------------------------

/// The player's lead party monster (lowest `party_slot`) ids + level. Returns
/// `(party_ids, lead_level)` over ALL party monsters (slot != 255), ordered by
/// slot. `None` if the player has no party monster (callers treat that as a no-op
/// / `Err`, and `begin_encounter`'s empty-party guard is the backstop).
pub(crate) fn lead_party(ctx: &ReducerContext, owner: Identity) -> Option<(Vec<u64>, Level)> {
    let mut party: Vec<Monster> = ctx
        .db
        .monster()
        .owner_identity()
        .filter(owner)
        .filter(|m| m.party_slot != PARTY_SLOT_NONE)
        .collect();
    party.sort_by_key(|m| m.party_slot);
    let lead = party.first()?;
    let lead_level = Level::new(lead.level).ok()?;
    let ids = party.iter().map(|m| m.monster_id).collect();
    Some((ids, lead_level))
}

/// Begin a wild battle: build side A from the player's owned party and side B from
/// a single freshly-rolled wild (no owned `monster` row). Builds the `Battle` row
/// DIRECTLY (NOT via `start_battle`, so `start_battle`'s owned-opponent guards stay
/// intact) and inserts the private `battle_wild` row (1:1). Returns the new
/// `battle_id`. Carries ALL of `start_battle`'s guards (R-D). EVERY rejection is an
/// `Err`, never a panic.
pub(crate) fn begin_encounter(
    ctx: &ReducerContext,
    player_identity: Identity,
    party_monster_ids: Vec<u64>,
    wild_species_id: u32,
    wild_level: u8,
    individuality_seed: u32,
) -> Result<u64, String> {
    if party_monster_ids.is_empty() {
        return Err("party_monster_ids must not be empty".to_string());
    }
    // Reject duplicate party ids (double-XP guard, like start_battle).
    {
        let mut seen = std::collections::HashSet::new();
        for &mid in &party_monster_ids {
            if !seen.insert(mid) {
                return Err(format!("duplicate monster_id {mid} in party_monster_ids"));
            }
        }
    }
    // Reject if the player is already in an ongoing battle.
    let already_in_battle = ctx
        .db
        .battle()
        .player_identity()
        .filter(player_identity)
        .any(|b| b.state.outcome == BattleOutcome::Ongoing);
    if already_in_battle {
        return Err("already in an ongoing battle".to_string());
    }

    // Build side A (player) from the owned party.
    let mut team_a = Vec::new();
    for &mid in &party_monster_ids {
        let m = ctx
            .db
            .monster()
            .monster_id()
            .find(mid)
            .ok_or_else(|| format!("party monster {mid} not found"))?;
        if m.owner_identity != player_identity {
            return Err(format!("monster {mid} not owned by player"));
        }
        let sp = ctx
            .db
            .species_row()
            .id()
            .find(m.species_id)
            .ok_or_else(|| format!("species {} not found", m.species_id))?;
        let skills: Vec<SkillRow> = ctx
            .db
            .skill_row()
            .iter()
            .filter(|s| sp.learnable_skill_ids.contains(&s.id))
            .collect();
        team_a.push(battle_monster_from_row(&m, &sp, &skills)?);
    }
    if !team_a.iter().any(|m| !m.is_fainted()) {
        return Err("party has no conscious monster".to_string());
    }

    // Build side B: exactly ONE wild monster (no owned monster row). The species
    // must exist at creation (R-G): a battle created after `sync_content` cannot
    // miss it on the M8d win-path lookup.
    let sp = ctx
        .db
        .species_row()
        .id()
        .find(wild_species_id)
        .ok_or_else(|| format!("wild species {wild_species_id} not found"))?;
    let skill_ids: Vec<u32> = ctx
        .db
        .skill_row()
        .iter()
        .filter(|s| sp.learnable_skill_ids.contains(&s.id))
        .map(|s| s.id)
        .collect();
    let wild = wild_battle_monster(&sp, &skill_ids, wild_level, individuality_seed)?;

    let state = BattleState {
        side_a: BattleSide {
            active: 0,
            team: team_a,
        },
        // ASYMMETRY (documented for M8d): `side_b.team.len() == 1` (the wild, so
        // `side_b.active_monster()` never indexes an empty team), but
        // `opponent_monster_ids.len() == 0` (the wild is UNOWNED — no monster row).
        // Do NOT zip these two: side_b has a BattleMonster but no backing id.
        side_b: BattleSide {
            active: 0,
            team: vec![wild],
        },
        outcome: BattleOutcome::Ongoing,
        turn_number: 0,
    };

    let battle = ctx.db.battle().insert(Battle {
        battle_id: 0,
        player_identity,
        opponent_identity: WILD_IDENTITY,
        state,
        party_monster_ids,
        opponent_monster_ids: vec![],
        created_at_ms: now_ms(ctx),
    });

    ctx.db.battle_wild().insert(BattleWild {
        battle_id: battle.battle_id,
        wild_species_id,
        wild_level,
        individuality_seed,
    });

    // Log ONLY the public coordinates — NEVER the seed / IVs / nature (side-channel).
    log::info!(
        "{{\"evt\":\"wild_encounter\",\"battle_id\":{},\"wild_species_id\":{wild_species_id},\"wild_level\":{wild_level}}}",
        battle.battle_id
    );
    Ok(battle.battle_id)
}

/// DEV/TEST entrypoint (gate or remove at M9+): a faithful double of the grass
/// path, since `movement_tick` is scheduler-only. Validates the sender joined +
/// has a party + is not already in a battle, draws the encounter seed SERVER-side
/// (`ctx.random()`, NO client-supplied seed → no IV-grind cheat surface), rolls
/// species/level from the zone's PRIVATE `encounter` table exactly like the grass
/// path, and calls `begin_encounter`. A missing encounter row or a no-trigger roll
/// is a no-op `Err` (never a panic).
#[cfg(feature = "dev_reducers")]
#[spacetimedb::reducer]
pub fn start_wild_battle(ctx: &ReducerContext, zone_id: u32) -> Result<(), String> {
    let me = ctx.sender;
    // Must be joined (has a player + character).
    let Some(player) = ctx.db.player().identity().find(me) else {
        let e = "not joined".to_string();
        log_reject("start_wild_battle", me, &e);
        return Err(e);
    };
    let Some(character) = ctx.db.character().entity_id().find(player.entity_id) else {
        let e = "no character".to_string();
        log_reject("start_wild_battle", me, &e);
        return Err(e);
    };
    // Reject a spoofed zone BEFORE any party DB work: the encounter is rolled from
    // the caller's OWN zone, never a client-named arbitrary zone (reject-not-clamp).
    if zone_id != character.zone_id {
        let e = format!(
            "zone mismatch: arg {zone_id} != character zone {}",
            character.zone_id
        );
        log_reject("start_wild_battle", me, &e);
        return Err(e);
    }
    // Must have a party.
    let Some((party_ids, player_level)) = lead_party(ctx, me) else {
        let e = "no party monster".to_string();
        log_reject("start_wild_battle", me, &e);
        return Err(e);
    };
    // Not already in a battle (begin_encounter re-checks; this gives a clear error).
    let already = ctx
        .db
        .battle()
        .player_identity()
        .filter(me)
        .any(|b| b.state.outcome == BattleOutcome::Ongoing);
    if already {
        let e = "already in an ongoing battle".to_string();
        log_reject("start_wild_battle", me, &e);
        return Err(e);
    }
    // The zone's PRIVATE encounter table, keyed by the SERVER-authoritative
    // character.zone_id (not the raw client arg) — defense-in-depth so the lookup
    // never trusts the client even if the reject check above is later reordered
    // (MED-1, ADR-0054 §3). (partial-sync: missing row → Err no-op.)
    let Some(row) = ctx.db.encounter().zone_id().find(character.zone_id) else {
        let e = format!("no encounter table for zone {}", character.zone_id);
        log_reject("start_wild_battle", me, &e);
        return Err(e);
    };
    let table = table_from_encounter_row(&row)?;
    let seed: u32 = ctx.random();
    let Some(w) = resolve_encounter(&table, seed, player_level) else {
        let e = "no encounter triggered".to_string();
        log_reject("start_wild_battle", me, &e);
        return Err(e);
    };
    begin_encounter(
        ctx,
        me,
        party_ids,
        w.species_id,
        w.level.as_u8(),
        w.individuality_seed,
    )?;
    Ok(())
}

/// Submit an attack: resolve one turn where the player attacks with `skill_id`
/// and the opponent uses AI. Ownership + outcome guards enforced.
#[spacetimedb::reducer]
pub fn submit_attack(ctx: &ReducerContext, battle_id: u64, skill_id: u32) -> Result<(), String> {
    let me = ctx.sender;
    let mut battle = ctx
        .db
        .battle()
        .battle_id()
        .find(battle_id)
        .ok_or_else(|| "battle not found".to_string())?;
    require_owner(ctx, "submit_attack", battle.player_identity)?;
    if battle.state.outcome != BattleOutcome::Ongoing {
        let e = "battle is not ongoing".to_string();
        log_reject("submit_attack", me, &e);
        return Err(e);
    }

    // Validate skill_id is in the active monster's moveset.
    let active_skills = &battle.state.side_a.active_monster().known_skill_ids;
    if !active_skills.contains(&skill_id) {
        let e = format!("skill {skill_id} not in active monster's moveset");
        log_reject("submit_attack", me, &e);
        return Err(e);
    }

    // Load skills and type chart for the resolver.
    let skill_rows: Vec<SkillRow> = ctx.db.skill_row().iter().collect();
    let skill_defs = skill_defs_from_rows(&skill_rows);
    let type_chart = type_chart_from_rows(ctx.db.type_relation_row().iter());
    let variance = TurnVariance::from_ctx_random(ctx.random());

    // AI picks a skill for side B.
    let enemy_skill_id = game_core::pick_best_skill(
        battle.state.side_b.active_monster(),
        battle.state.side_a.active_monster(),
        &skill_defs,
        &type_chart,
    );

    let _events = resolve_turn(
        &mut battle.state,
        TurnChoice::Attack { skill_id },
        TurnChoice::Attack {
            skill_id: enemy_skill_id,
        },
        &skill_defs,
        &type_chart,
        &variance,
    );

    // Write back HP + XP if battle ended.
    if battle.state.outcome != BattleOutcome::Ongoing {
        write_back_battle_results(ctx, &battle)?;
    }

    ctx.db.battle().battle_id().update(battle);
    Ok(())
}

/// Swap the player's active monster. Ownership + outcome guards enforced.
#[spacetimedb::reducer]
pub fn swap_active(ctx: &ReducerContext, battle_id: u64, team_index: u32) -> Result<(), String> {
    let me = ctx.sender;
    let mut battle = ctx
        .db
        .battle()
        .battle_id()
        .find(battle_id)
        .ok_or_else(|| "battle not found".to_string())?;
    require_owner(ctx, "swap_active", battle.player_identity)?;
    if battle.state.outcome != BattleOutcome::Ongoing {
        let e = "battle is not ongoing".to_string();
        log_reject("swap_active", me, &e);
        return Err(e);
    }
    let idx = team_index as usize;
    if idx >= battle.state.side_a.team.len() {
        let e = format!("team_index {team_index} out of bounds");
        log_reject("swap_active", me, &e);
        return Err(e);
    }
    if battle.state.side_a.team[idx].is_fainted() {
        let e = format!("monster at index {team_index} is fainted");
        log_reject("swap_active", me, &e);
        return Err(e);
    }
    if battle.state.side_a.active == team_index {
        let e = "already the active monster".to_string();
        log_reject("swap_active", me, &e);
        return Err(e);
    }

    // Swap then enemy attacks the new active.
    let skill_rows: Vec<SkillRow> = ctx.db.skill_row().iter().collect();
    let skill_defs = skill_defs_from_rows(&skill_rows);
    let type_chart = type_chart_from_rows(ctx.db.type_relation_row().iter());
    let variance = TurnVariance::from_ctx_random(ctx.random());

    let _events = game_core::resolve_player_swap(
        &mut battle.state,
        game_core::SideId::SideA,
        team_index,
        &skill_defs,
        &type_chart,
        &variance,
    );

    if battle.state.outcome != BattleOutcome::Ongoing {
        write_back_battle_results(ctx, &battle)?;
    }

    ctx.db.battle().battle_id().update(battle);
    Ok(())
}

/// Flee from a battle. Sets outcome to `Fled`; no XP awarded.
#[spacetimedb::reducer]
pub fn flee(ctx: &ReducerContext, battle_id: u64) -> Result<(), String> {
    let me = ctx.sender;
    let mut battle = ctx
        .db
        .battle()
        .battle_id()
        .find(battle_id)
        .ok_or_else(|| "battle not found".to_string())?;
    require_owner(ctx, "flee", battle.player_identity)?;
    if battle.state.outcome != BattleOutcome::Ongoing {
        let e = "battle is not ongoing".to_string();
        log_reject("flee", me, &e);
        return Err(e);
    }
    battle.state.outcome = BattleOutcome::Fled;

    // Write back HP via the shared path (no XP on flee — outcome != SideAWins).
    write_back_battle_results(ctx, &battle)?;

    ctx.db.battle().battle_id().update(battle);
    log::info!("{{\"evt\":\"battle_flee\",\"battle_id\":{battle_id},\"sender\":\"{me}\"}}");
    Ok(())
}

/// Write post-battle HP back to every party monster (HP only — NO XP). Shared by
/// `write_back_battle_results` (the win/loss/flee path) and the M8d recruit
/// success arm (which grants no XP). Dual-writes the private `monster` row and
/// its public projection. Returns `Err` on a `side_a.team` / `party_monster_ids`
/// length mismatch (checked indexing, never panic — M8.5a).
pub(crate) fn write_back_party_hp(ctx: &ReducerContext, battle: &Battle) -> Result<(), String> {
    check_team_coupling(
        battle.state.side_a.team.len(),
        battle.party_monster_ids.len(),
    )?;
    for (i, bm) in battle.state.side_a.team.iter().enumerate() {
        let &mid = battle.party_monster_ids.get(i).ok_or_else(|| {
            format!("write_back_party_hp: party_monster_ids index {i} out of range")
        })?;
        if let Some(mut m) = ctx.db.monster().monster_id().find(mid) {
            write_back_hp(&mut m, bm);
            let pub_row = pub_from_monster(&m);
            ctx.db.monster().monster_id().update(m);
            ctx.db.monster_pub().monster_id().update(pub_row);
        }
    }
    Ok(())
}

/// After a battle ends (win/loss), write HP back to all party monsters and
/// grant XP to the winner's team.
pub(crate) fn write_back_battle_results(
    ctx: &ReducerContext,
    battle: &Battle,
) -> Result<(), String> {
    // Positional coupling invariant: side_a.team[i] pairs with
    // party_monster_ids[i]. Assert it up front (Err, never panic) so the XP loop
    // below can index by position safely — the §3 criterion requires this
    // assertion in write_back_battle_results specifically (M8.5a). The same
    // assertion also lives in write_back_party_hp, which guards the recruit-success
    // path that calls that helper WITHOUT going through this function.
    check_team_coupling(
        battle.state.side_a.team.len(),
        battle.party_monster_ids.len(),
    )?;

    // Write back HP for player's team (HP-only; the XP block below is separate).
    write_back_party_hp(ctx, battle)?;

    // GC the private wild-individuality row on ANY terminal outcome (no-op for
    // PvP battles with no `battle_wild` row; cleans wild battles that end via
    // loss/flee/win without a recruit attempt).
    ctx.db.battle_wild().battle_id().delete(battle.battle_id);

    // GC prior terminal battles for this player (12.5e-1, ADR-0077).
    // Ordering invariant: the current battle's DB row is still Ongoing at this
    // call site — all callers (submit_attack, swap_active, flee) call update()
    // AFTER write_back_battle_results returns. So filtering outcome != Ongoing
    // only targets prior terminals, never the in-flight battle. After the
    // caller's update(), exactly one terminal battle remains per player,
    // preserving the client's M8.7e outcome frame (keep-latest-per-player).
    let player = battle.player_identity;
    let old_terminal_ids: Vec<u64> = ctx
        .db
        .battle()
        .player_identity()
        .filter(player)
        .filter(|b| b.state.outcome != BattleOutcome::Ongoing)
        .map(|b| b.battle_id)
        .collect();
    for id in old_terminal_ids {
        ctx.db.battle().battle_id().delete(id);
    }

    // Grant XP if the player won (12.5e-3: log-and-continue on parse failures —
    // one corrupt row must not make a battle unwinnable; mirrors movement_tick
    // per-character philosophy, ADR-0077).
    if battle.state.outcome == BattleOutcome::SideAWins {
        // Find the loser's species base stat total for the XP formula.
        // On missing species: log and skip the entire XP section — without the
        // BST no per-monster XP can be computed. The battle still resolves.
        let loser_active = battle.state.side_b.active_monster();
        let Some(loser_species) = ctx.db.species_row().id().find(loser_active.species_id) else {
            log::error!(
                "{{\"evt\":\"xp_skip_loser_species\",\"battle_id\":{},\"species_id\":{}}}",
                battle.battle_id,
                loser_active.species_id
            );
            return Ok(());
        };
        let bst = loser_base_stat_total(&loser_species);
        // loser_lvl is loop-invariant — parse once here so a corrupt loser level
        // skips the entire XP section (not N×log once per winner monster).
        let loser_lvl = match game_core::Level::new(loser_active.level) {
            Ok(l) => l,
            Err(e) => {
                log::error!(
                    "{{\"evt\":\"xp_skip_loser_level\",\"battle_id\":{},\"loser_species_id\":{},\"reason\":\"{e}\"}}",
                    battle.battle_id,
                    loser_active.species_id
                );
                return Ok(());
            }
        };

        // Loop-invariant: practice flag is the same for every monster in this battle.
        let is_practice = battle.opponent_identity != WILD_IDENTITY;

        // Award XP to each conscious member of the winning team.
        for (i, bm) in battle.state.side_a.team.iter().enumerate() {
            if bm.is_fainted() {
                continue;
            }
            // Can't fail: check_team_coupling asserted same lengths above.
            let &mid = battle.party_monster_ids.get(i).ok_or_else(|| {
                format!("write_back_battle_results: party_monster_ids index {i} out of range")
            })?;
            let Some(mut m) = ctx.db.monster().monster_id().find(mid) else {
                continue;
            };

            // Parse winner level — log-and-continue on corrupt data.
            let winner_lvl = match game_core::Level::new(bm.level) {
                Ok(l) => l,
                Err(e) => {
                    log::error!(
                        "{{\"evt\":\"xp_skip_level\",\"monster_id\":{mid},\"reason\":\"{e}\"}}",
                    );
                    continue;
                }
            };
            let base_xp = battle_xp_reward(winner_lvl, bst, loser_lvl);
            let xp_gained = game_core::practice_xp_reward(base_xp, is_practice);
            let current_xp = game_core::Xp::new(m.xp);
            let (new_xp, new_level, leveled_up) = apply_xp_gain(current_xp, xp_gained);
            m.xp = new_xp.value();
            m.level = new_level.as_u8();

            if leveled_up {
                // Recompute derived stats on level-up. Stat-recompute failures are
                // logged and skipped (XP/level already written above); `level_up_healed_hp`
                // and `compute_evolves_to` remain the SSOT (ADR-0003, ADR-0073).
                if let Some(species) = ctx.db.species_row().id().find(m.species_id) {
                    let base = StatBlock {
                        hp: species.base_hp,
                        attack: species.base_attack,
                        defense: species.base_defense,
                        speed: species.base_speed,
                        sp_attack: species.base_sp_attack,
                        sp_defense: species.base_sp_defense,
                    };
                    'stat_recompute: {
                        let ivs = match game_core::IVs::new(
                            m.iv_hp,
                            m.iv_attack,
                            m.iv_defense,
                            m.iv_speed,
                            m.iv_sp_attack,
                            m.iv_sp_defense,
                        ) {
                            Ok(v) => v,
                            Err(e) => {
                                log::error!(
                                    "{{\"evt\":\"level_up_stat_skip\",\"monster_id\":{mid},\"reason\":\"ivs: {e}\"}}",
                                );
                                break 'stat_recompute;
                            }
                        };
                        let evs = match game_core::EVs::new(
                            m.ev_hp,
                            m.ev_attack,
                            m.ev_defense,
                            m.ev_speed,
                            m.ev_sp_attack,
                            m.ev_sp_defense,
                        ) {
                            Ok(v) => v,
                            Err(e) => {
                                log::error!(
                                    "{{\"evt\":\"level_up_stat_skip\",\"monster_id\":{mid},\"reason\":\"evs: {e}\"}}",
                                );
                                break 'stat_recompute;
                            }
                        };
                        let nature = game_core::Nature::new(m.nature_kind);
                        let lvl = match game_core::Level::new(m.level) {
                            Ok(l) => l,
                            Err(e) => {
                                log::error!(
                                    "{{\"evt\":\"level_up_stat_skip\",\"monster_id\":{mid},\"reason\":\"level: {e}\"}}",
                                );
                                break 'stat_recompute;
                            }
                        };
                        let derived = game_core::derive_stats(&base, &ivs, &evs, &nature, lvl);
                        m.stat_hp = derived.hp;
                        m.stat_attack = derived.attack;
                        m.stat_defense = derived.defense;
                        m.stat_speed = derived.speed;
                        m.stat_sp_attack = derived.sp_attack;
                        m.stat_sp_defense = derived.sp_defense;
                        // Heal the HP gained from the max-HP growth on level-up
                        // (SSOT: game_core owns the heal rule, ADR-0003).
                        m.current_hp = level_up_healed_hp(m.current_hp, bm.max_hp, derived.hp);
                        // Recompute evolves_to after level-up (12.5b-4, ADR-0073).
                        // Scoped inside `if leveled_up { if let Some(species) }` because:
                        // only a level change can unlock a new level-based evolution branch.
                        let all_evolutions = match load_evolutions() {
                            Ok(v) => v,
                            Err(e) => {
                                log::error!(
                                    "{{\"evt\":\"level_up_stat_skip\",\"monster_id\":{mid},\"reason\":\"load_evolutions: {e}\"}}",
                                );
                                break 'stat_recompute;
                            }
                        };
                        let monster_evolutions = all_evolutions
                            .iter()
                            .find(|se| se.species_id == m.species_id)
                            .map(|se| &se.evolutions[..])
                            .unwrap_or(&[]);
                        m.evolves_to = crate::evolution::compute_evolves_to(monster_evolutions, &m);
                    }
                }
            }
            let pub_row = pub_from_monster(&m);
            ctx.db.monster().monster_id().update(m);
            ctx.db.monster_pub().monster_id().update(pub_row);
        }
    }

    Ok(())
}

// `battle.rs` is a file-module (declared `mod battle;` in `lib.rs`), so a plain
// `mod battle_tests;` would resolve under `src/battle/`; `#[path]` keeps the test
// file a sibling in `src/` (the game-core `*_tests.rs` convention, ADR-0056 map).
#[cfg(test)]
#[path = "battle_tests.rs"]
mod battle_tests;
